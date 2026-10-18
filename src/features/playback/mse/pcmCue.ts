/**
 * The scrub cue of a MediaSource source (ADR 046), which plays PCM through Web Audio.
 *
 * WKWebView starts the media clock of a MediaSource element 210 to 250 ms after `play()`, so the
 * element cue of ADR 019 sounded too late. This cue keeps the PCM that FFmpeg decodes for each
 * window and plays a burst with voices that start at the sample of the target. The rules of
 * ADR 019 keep their behaviour: a burst of 50 ms, the continuation of a forward request, the
 * backward request that never continues, and the lag limits of a step and of a drag. The cue
 * reads its own position: the start sample of a voice plus the time since its start on the
 * `AudioContext` clock.
 *
 * On FLV the PCM comes with the video windows. On MPEG-TS and Matroska the cue requests its own
 * PCM windows of the audio lane where it has none (`ensure`).
 */

import type { ScrubCue } from "../cue";
import {
  SCRUB_BURST_SECONDS,
  SCRUB_CONTINUATION_MAX_LAG_SECONDS,
  SCRUB_CONTINUATION_TOLERANCE_SECONDS,
  SCRUB_DRAG_MAX_LAG_SECONDS,
  SCRUB_WATCHDOG_EXTRA_SECONDS,
  type ScrubAudioRequestKind,
  type ScrubAudioTimers,
} from "../scrubAudio";
import type { WindowEnd, WindowListener, WindowSession } from "./windowClient";

/** The sample rate of the PCM, as `PCM_SAMPLE_RATE` in Rust. */
export const PCM_SAMPLE_RATE = 48000;
/** The PCM that the cue keeps, in seconds of all windows together: about 23 MB. */
export const PCM_KEEP_SECONDS = 240;
/** The PCM of each voice that continues a burst past the end of the voice before it. */
export const CHAIN_SECONDS = 1;
/** The length of a PCM window of the audio lane, as `PCM_WINDOW_SECONDS` in Rust. */
export const PCM_WINDOW_SECONDS = 20;
/**
 * The delay from the clock of the context to the start of a voice. The clock moves once per
 * render callback, and a voice that starts in the past loses its first samples.
 */
export const START_LEAD_SECONDS = 0.01;
/** A burst stops this long before its stop time for a continuation, which needs a voice. */
const STOP_MARGIN_SECONDS = 0.01;
/** The PCM that must lie after a target for `ensure` to need no window. */
const ENSURE_AHEAD_SECONDS = 1;
/** The rounding margin of the step and lag comparisons, as in ADR 019. */
const TIME_EPSILON_SECONDS = 1e-9;

/** A burst that an audio output plays. */
export interface CueVoice {
  /** Stops the voice at context time `when`, or at once without it. A later call wins. */
  readonly stop: (when?: number) => void;
}

/**
 * The audio output of the cue: an `AudioContext` whose gain node the Mute toggle sets
 * (`createWebAudioOutput`). A test passes a fake.
 */
export interface CueAudioOutput {
  /** The clock of the context, in seconds. */
  readonly currentTime: () => number;
  /** Plays mono samples at `PCM_SAMPLE_RATE` from context time `when`. */
  readonly play: (samples: Float32Array<ArrayBuffer>, when: number) => CueVoice;
  /** Lets a suspended context run. Only a user gesture can do so in WebKit. */
  readonly resume: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly close: () => void;
}

export interface PcmCueOptions {
  /** The absolute source time of `videoStartPts`, which is media time 0. */
  readonly videoStartSeconds: number;
  /** Creates the audio output, at the first gesture or the first burst. */
  readonly createOutput: (muted: boolean) => CueAudioOutput;
  readonly timers?: ScrubAudioTimers;
  /**
   * For MPEG-TS and Matroska: opens a PCM window of the audio lane at an absolute source time.
   * The window sends its PCM through `onChunk`.
   */
  readonly openPcmWindow?: (
    startSeconds: number,
    listener: WindowListener,
  ) => WindowSession;
  readonly muted?: boolean;
  /** The PCM that the cue keeps, in seconds. `PCM_KEEP_SECONDS` when absent. */
  readonly keepSeconds?: number;
}

export interface PcmCue extends ScrubCue {
  /** Adds PCM of window `key`, whose sample 0 is at `startSeconds` of the source. */
  readonly addPcm: (key: number, startSeconds: number, bytes: Uint8Array) => void;
  /** The PCM of a window ended. A failed audio process disables the cue. */
  readonly endPcm: (end: WindowEnd) => void;
  /** On MPEG-TS and Matroska, makes PCM at a media time arrive before a burst needs it. */
  readonly ensure: (mediaTime: number) => void;
  /**
   * Creates the audio output, or lets it run. The preview calls it in each pointer and key
   * gesture, so the context may start before the first burst, which a drag can request outside
   * a gesture.
   */
  readonly prime: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly destroy: () => void;
}

/** The PCM of one window. */
interface PcmSegment {
  readonly key: number;
  readonly start: number;
  readonly blocks: Int16Array[];
  length: number;
  /** A byte of a sample whose second byte has not arrived. */
  carry: number | null;
}

/** A voice of a burst, and the context time at which it is scheduled to stop. */
interface BurstVoice {
  readonly voice: CueVoice;
  endsAt: number;
}

/** The burst that sounds. */
interface Burst {
  /**
   * The voices of the burst that may still sound. A continuation adds voices, and a stop stops
   * all of them.
   */
  voices: BurstVoice[];
  /** The source time of sample 0 of the last voice. */
  bufferStart: number;
  /** The length of the last voice. */
  bufferSeconds: number;
  /** The context time at which sample 0 of the last voice plays. */
  contextStart: number;
  /** The last target, as a source time. */
  lastTarget: number;
  /** The source time at which the burst stops. */
  stopAt: number;
}

/** A request whose PCM has not arrived. */
interface PendingBurst {
  readonly target: number;
  readonly kind: ScrubAudioRequestKind;
  readonly handle: number;
}

/** The session of a PCM window record before its request returns. */
const CLOSED_SESSION: WindowSession = {
  opened: new Promise<never>(() => undefined),
  ack: () => undefined,
  close: () => undefined,
  isClosed: () => true,
};

const defaultTimers: ScrubAudioTimers = {
  setTimer: (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds) as unknown as number,
  clearTimer: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

/** The lag limit of a request kind (ADR 019). */
function maxLagOf(kind: ScrubAudioRequestKind): number {
  return kind === "drag"
    ? SCRUB_DRAG_MAX_LAG_SECONDS
    : SCRUB_CONTINUATION_MAX_LAG_SECONDS;
}

export function createPcmCue(options: PcmCueOptions): PcmCue {
  const timers = options.timers ?? defaultTimers;
  const segments: PcmSegment[] = [];
  /** The windows whose PCM the bound dropped. Their later pieces go nowhere. */
  const droppedKeys = new Set<number>();
  let output: CueAudioOutput | null = null;
  let muted = options.muted ?? false;
  let burst: Burst | null = null;
  let watchdog: number | null = null;
  let pending: PendingBurst | null = null;
  let disabled = false;
  let destroyed = false;
  /**
   * The PCM window of the audio lane. A window that ended normally still covers its range, so
   * a target near the end of the audio opens no window again. `failed` marks one that does not.
   */
  let pcmWindow: {
    session: WindowSession;
    readonly requested: number;
    start: number | null;
    failed: boolean;
  } | null = null;
  let nextWindowKey = -1;

  const sourceTime = (mediaTime: number): number =>
    mediaTime + options.videoStartSeconds;

  const audio = (): CueAudioOutput | null => {
    if (output === null) {
      try {
        output = options.createOutput(muted);
      } catch {
        disable();
        return null;
      }
    }
    return output;
  };

  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      timers.clearTimer(watchdog);
      watchdog = null;
    }
  };

  const clearPending = (): void => {
    if (pending !== null) {
      timers.clearTimer(pending.handle);
      pending = null;
    }
  };

  const stopBurst = (): void => {
    clearWatchdog();
    const sounding = burst;
    burst = null;
    for (const entry of sounding?.voices ?? []) {
      entry.voice.stop();
    }
  };

  const stop = (): void => {
    clearPending();
    stopBurst();
  };

  /** The segment that holds `time` with at least one burst after it, or null. */
  const segmentAt = (time: number): PcmSegment | null => {
    const need = Math.round(SCRUB_BURST_SECONDS * PCM_SAMPLE_RATE);
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index];
      const offset = Math.round((time - segment.start) * PCM_SAMPLE_RATE);
      if (offset >= 0 && offset + need <= segment.length) {
        return segment;
      }
    }
    return null;
  };

  /** Up to `count` samples of `segment` from sample `offset`, as floats. */
  const read = (
    segment: PcmSegment,
    offset: number,
    count: number,
  ): Float32Array<ArrayBuffer> => {
    const length = Math.max(0, Math.min(count, segment.length - offset));
    const samples = new Float32Array(length);
    let position = 0;
    let skip = offset;
    for (const block of segment.blocks) {
      if (position >= length) {
        break;
      }
      if (skip >= block.length) {
        skip -= block.length;
        continue;
      }
      const take = Math.min(block.length - skip, length - position);
      for (let index = 0; index < take; index++) {
        samples[position + index] = (block[skip + index] ?? 0) / 32768;
      }
      position += take;
      skip = 0;
    }
    return samples;
  };

  /**
   * Starts a voice with up to `seconds` of the PCM from source time `from`, played at context
   * time `when`.
   */
  const startVoice = (
    from: number,
    when: number,
    seconds: number,
  ): { voice: CueVoice; seconds: number } | null => {
    const sink = audio();
    const segment = segmentAt(from);
    if (sink === null || segment === null) {
      return null;
    }
    const offset = Math.round((from - segment.start) * PCM_SAMPLE_RATE);
    const samples = read(segment, offset, Math.round(seconds * PCM_SAMPLE_RATE));
    return {
      voice: sink.play(samples, when),
      seconds: samples.length / PCM_SAMPLE_RATE,
    };
  };

  /**
   * Schedules the stop of the burst at its stop time. A stop past the end of the last voice goes
   * on in a new voice that starts where that voice ends, so a held key plays on without a gap.
   * When no PCM follows, or that start has passed, the burst ends with its last voice, and the
   * next request starts a new burst, which waits for the PCM and asks for it.
   */
  const scheduleStop = (sounding: Burst): void => {
    const last = sounding.voices[sounding.voices.length - 1];
    const bufferEnd = sounding.bufferStart + sounding.bufferSeconds;
    if (last === undefined) {
      return;
    }
    if (sounding.stopAt <= bufferEnd + TIME_EPSILON_SECONDS) {
      last.endsAt = sounding.contextStart + (sounding.stopAt - sounding.bufferStart);
      last.voice.stop(last.endsAt);
      return;
    }
    const chainAt = sounding.contextStart + sounding.bufferSeconds;
    last.endsAt = chainAt;
    last.voice.stop(chainAt);
    const now = output?.currentTime() ?? Number.POSITIVE_INFINITY;
    // A voice that ended keeps no buffer alive.
    sounding.voices = sounding.voices.filter((entry) => entry.endsAt > now);
    const next =
      chainAt >= now + START_LEAD_SECONDS
        ? startVoice(bufferEnd, chainAt, CHAIN_SECONDS)
        : null;
    if (next === null) {
      sounding.stopAt = bufferEnd;
      return;
    }
    sounding.voices.push({ voice: next.voice, endsAt: Number.POSITIVE_INFINITY });
    sounding.bufferStart = bufferEnd;
    sounding.bufferSeconds = next.seconds;
    sounding.contextStart = chainAt;
    scheduleStop(sounding);
  };

  /**
   * Stops the burst when the AudioContext clock does not reach its stop, as when the context
   * stays suspended: the remaining time, at least one burst, and the margin of ADR 019.
   */
  const armWatchdog = (remainingSeconds: number): void => {
    clearWatchdog();
    watchdog = timers.setTimer(
      () => {
        watchdog = null;
        stopBurst();
      },
      (Math.max(remainingSeconds, SCRUB_BURST_SECONDS) + SCRUB_WATCHDOG_EXTRA_SECONDS) *
        1000,
    );
  };

  /**
   * The source time that the burst plays now. Before the last voice starts, the voice before it
   * plays, and the PCM of the two joins, so the same line gives its position.
   */
  const positionOf = (sounding: Burst): number | null => {
    const now = output?.currentTime();
    if (now === undefined || !Number.isFinite(now)) {
      return null;
    }
    return sounding.bufferStart + (now - sounding.contextStart);
  };

  /** True when a forward request continues the burst, as in ADR 019. */
  const continues = (
    sounding: Burst,
    target: number,
    direction: 1 | -1,
    kind: ScrubAudioRequestKind,
  ): boolean => {
    const position = positionOf(sounding);
    if (
      direction !== 1 ||
      position === null ||
      position >= sounding.stopAt - STOP_MARGIN_SECONDS
    ) {
      return false;
    }
    const step = target - sounding.lastTarget;
    if (
      step < -TIME_EPSILON_SECONDS ||
      step > SCRUB_CONTINUATION_TOLERANCE_SECONDS + TIME_EPSILON_SECONDS
    ) {
      return false;
    }
    const lag = target - position;
    return (
      lag >= -SCRUB_CONTINUATION_TOLERANCE_SECONDS - TIME_EPSILON_SECONDS &&
      lag <= maxLagOf(kind) + TIME_EPSILON_SECONDS
    );
  };

  /**
   * Starts a burst at source time `target`. Its first voice holds the burst and the lag limit of
   * the request, which a continuation can use before a new voice. Returns false when no PCM
   * holds the target.
   */
  const startBurst = (target: number, kind: ScrubAudioRequestKind): boolean => {
    stopBurst();
    const sink = audio();
    if (sink === null) {
      return false;
    }
    const when = sink.currentTime() + START_LEAD_SECONDS;
    const started = startVoice(target, when, SCRUB_BURST_SECONDS + maxLagOf(kind));
    if (started === null) {
      return false;
    }
    burst = {
      voices: [{ voice: started.voice, endsAt: Number.POSITIVE_INFINITY }],
      bufferStart: target,
      bufferSeconds: started.seconds,
      contextStart: when,
      lastTarget: target,
      stopAt: target + SCRUB_BURST_SECONDS,
    };
    scheduleStop(burst);
    armWatchdog(SCRUB_BURST_SECONDS + START_LEAD_SECONDS);
    return true;
  };

  const request = (
    targetSeconds: number,
    direction: 1 | -1,
    kind: ScrubAudioRequestKind = "step",
  ): void => {
    if (disabled || destroyed) {
      return;
    }
    if (!Number.isFinite(targetSeconds) || targetSeconds < 0) {
      return;
    }
    if (direction !== 1 && direction !== -1) {
      return;
    }
    clearPending();
    const target = sourceTime(targetSeconds);
    const sounding = burst;
    if (sounding !== null && continues(sounding, target, direction, kind)) {
      sounding.lastTarget = target;
      sounding.stopAt = target + SCRUB_BURST_SECONDS;
      const position = positionOf(sounding) ?? target;
      scheduleStop(sounding);
      armWatchdog(sounding.stopAt - position);
      // A held key plays on toward the end of the PCM that the cue holds.
      ensureAt(target);
      return;
    }
    if (startBurst(target, kind)) {
      ensureAt(target);
      return;
    }
    // The PCM has not arrived. The request waits for it for the watchdog time of ADR 019.
    stopBurst();
    ensureAt(target);
    const handle = timers.setTimer(
      () => {
        if (pending?.handle === handle) {
          pending = null;
        }
      },
      (SCRUB_BURST_SECONDS + SCRUB_WATCHDOG_EXTRA_SECONDS) * 1000,
    );
    pending = { target, kind, handle };
  };

  /** Drops the oldest PCM beyond the limit, but never the segment that grows. */
  const trim = (growing: PcmSegment): void => {
    let total = segments.reduce((sum, segment) => sum + segment.length, 0);
    const limit = (options.keepSeconds ?? PCM_KEEP_SECONDS) * PCM_SAMPLE_RATE;
    while (total > limit && segments.length > 1) {
      const index = segments[0] === growing ? 1 : 0;
      const [dropped] = segments.splice(index, 1);
      if (dropped !== undefined) {
        droppedKeys.add(dropped.key);
        total -= dropped.length;
      }
    }
  };

  const addPcm = (key: number, startSeconds: number, bytes: Uint8Array): void => {
    if (
      destroyed ||
      disabled ||
      bytes.byteLength === 0 ||
      !Number.isFinite(startSeconds) ||
      droppedKeys.has(key)
    ) {
      return;
    }
    let segment = segments.find((item) => item.key === key);
    if (segment === undefined) {
      segment = { key, start: startSeconds, blocks: [], length: 0, carry: null };
      segments.push(segment);
    }
    let offset = 0;
    const lead = segment.carry;
    const total = bytes.byteLength + (lead === null ? 0 : 1);
    const count = Math.floor(total / 2);
    const block = new Int16Array(count);
    let index = 0;
    if (lead !== null && count > 0) {
      const value = lead | ((bytes[0] ?? 0) << 8);
      block[index++] = value >= 0x8000 ? value - 0x10000 : value;
      offset = 1;
    }
    for (; index < count; index++, offset += 2) {
      const value = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
      block[index] = value >= 0x8000 ? value - 0x10000 : value;
    }
    segment.carry = total % 2 === 1 ? (bytes[bytes.byteLength - 1] ?? 0) : null;
    if (count > 0) {
      segment.blocks.push(block);
      segment.length += count;
    }
    trim(segment);
    const waiting = pending;
    if (waiting !== null && segmentAt(waiting.target) !== null) {
      clearPending();
      startBurst(waiting.target, waiting.kind);
    }
  };

  /**
   * A failed audio process disables the cue. It never stops the video window. The PCM window
   * of the cue stops, and the PCM goes.
   */
  const disable = (): void => {
    disabled = true;
    stop();
    pcmWindow?.session.close();
    pcmWindow = null;
    segments.length = 0;
  };

  const endPcm = (end: WindowEnd): void => {
    if (end.status === "failed") {
      disable();
    }
  };

  /** Requests a PCM window of the audio lane at source time `time` when no PCM holds it. */
  const ensureAt = (time: number): void => {
    if (options.openPcmWindow === undefined || disabled || destroyed) {
      return;
    }
    const covered = segments.some(
      (segment) =>
        time >= segment.start &&
        time + ENSURE_AHEAD_SECONDS <= segment.start + segment.length / PCM_SAMPLE_RATE,
    );
    if (covered) {
      return;
    }
    const running = pcmWindow;
    if (running !== null && !running.failed) {
      const start = running.start ?? running.requested;
      if (
        time >= start &&
        time + ENSURE_AHEAD_SECONDS <= running.requested + PCM_WINDOW_SECONDS
      ) {
        return;
      }
    }
    running?.session.close();
    const key = nextWindowKey--;
    const held: Uint8Array[] = [];
    let unacknowledged = 0;
    const record: {
      session: WindowSession;
      readonly requested: number;
      start: number | null;
      failed: boolean;
    } = { session: CLOSED_SESSION, requested: time, start: null, failed: false };
    const session = options.openPcmWindow(time, {
      onChunk: (bytes) => {
        // The PCM window of the audio lane has its own credit, acknowledged on receipt.
        if (record.session === CLOSED_SESSION) {
          unacknowledged += bytes.byteLength;
        } else {
          record.session.ack(bytes.byteLength);
        }
        if (record.start === null) {
          held.push(bytes);
        } else {
          addPcm(key, record.start, bytes);
        }
      },
      onEnd: (end) => {
        if (end.status !== "complete") {
          record.failed = true;
        }
        endPcm(end);
      },
    });
    record.session = session;
    if (unacknowledged > 0) {
      session.ack(unacknowledged);
    }
    pcmWindow = record;
    session.opened.then(
      (opened) => {
        if (session.isClosed()) {
          return;
        }
        if (opened.pcmStartSeconds === null) {
          // A window with no start for its samples cannot place them.
          disable();
          return;
        }
        record.start = opened.pcmStartSeconds;
        for (const bytes of held.splice(0)) {
          addPcm(key, opened.pcmStartSeconds, bytes);
        }
      },
      (error: unknown) => {
        record.failed = true;
        const superseded =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "superseded";
        // A newer request of the cue replaces its window. Any other refusal is a failed
        // audio process.
        if (!superseded && !session.isClosed()) {
          disable();
        }
      },
    );
  };

  return {
    request,
    stop,
    addPcm,
    endPcm,
    ensure: (mediaTime) => {
      if (Number.isFinite(mediaTime)) {
        ensureAt(sourceTime(mediaTime));
      }
    },
    prime: () => {
      if (!disabled && !destroyed) {
        audio()?.resume();
      }
    },
    setMuted: (value) => {
      muted = value;
      output?.setMuted(muted);
    },
    destroy: () => {
      if (destroyed) {
        return;
      }
      stop();
      destroyed = true;
      pcmWindow?.session.close();
      pcmWindow = null;
      segments.length = 0;
      output?.close();
      output = null;
    },
  };
}
