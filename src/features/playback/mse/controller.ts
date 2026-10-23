/**
 * The MediaSource of one video element of a source that the web view cannot open (ADR 046).
 *
 * The controller fills a MediaSource with the fMP4 windows of the source. It requests a window
 * where the element needs data, appends the window in order, acknowledges each append so Rust
 * reads more, removes data behind the playback, and ends the stream after the last window. It
 * keeps the start of each appended video frame, so the frame step of the store moves by real
 * frames (ADR 022).
 *
 * The decisions read the video that the fragments of the windows hold, not `buffered`: the
 * buffered ranges of a SourceBuffer with audio and video are the intersection of the two
 * tracks, so they start at the later first sample and end at the earlier last one.
 *
 * The controller never writes `currentTime`: the playback store is the only writer of the
 * position. When the element needs a move, such as over a gap before the first frame or over a
 * stretch that the windows skip, the controller asks the preview, which asks the store.
 */

import type { Rational } from "@/types/project";
import { mergeFrameStarts } from "../frameTable";
import {
  Fmp4Error,
  Fmp4Scanner,
  parseFragments,
  parseMovie,
  type Fmp4Box,
  type Fmp4Fragment,
  type Fmp4Track,
} from "./fmp4";
import { sampleMediaTime, sourceSecondsAt } from "./timeline";
import type {
  PreviewWindowError,
  WindowAudio,
  WindowContainer,
  WindowEnd,
  WindowListener,
  WindowOpened,
  WindowRequest,
  WindowSession,
  WindowStart,
} from "./windowClient";

/** The media time that a window covers, as `WINDOW_MS` in Rust. */
export const WINDOW_SECONDS = 60;
/** The next window starts when less than this lies buffered ahead of the position. */
export const PREFETCH_AHEAD_SECONDS = 30;
/** The data that stays buffered behind the position. */
export const KEEP_BEHIND_SECONDS = 20;
/** The data that stays behind the position when the SourceBuffer is full. */
export const QUOTA_KEEP_BEHIND_SECONDS = 2;
/**
 * The largest distance ahead of the data that a running window has delivered at which a seek
 * waits for that window instead of starting a new one.
 */
export const WAIT_AHEAD_SECONDS = 10;
/** The first seek margin of MPEG-TS and Matroska windows, as `SEEK_MARGIN_SECONDS` of ADR 014. */
export const SEEK_MARGIN_SECONDS = 5;
/** The largest seek margin. A window that still starts after its target then fails. */
export const MAX_SEEK_MARGIN_SECONDS = 60;
/**
 * The largest gap that the controller asks the store to seek over: from a waiting position before
 * the first keyframe of the file to the first frame, or a hole between two buffered ranges in the
 * middle of the file, where the windows skip a stretch.
 */
export const GAP_LIMIT_SECONDS = 15;
/**
 * A playing element that waits this close to the end of a buffered range stopped there. While
 * it waits, Chrome reports a position up to about 0.3 s before the end, and WebKit stops about
 * 83 ms before the end.
 */
const GAP_REACH_SECONDS = 0.5;
/**
 * The end of a buffered range before a hole where a seek in Chromium does not complete. Chromium
 * completes a seek only when about 200 ms of data follow the target, or at the end of the stream.
 * Before a hole, no more data comes, so a seek into the last 200 ms of the range shows its frame
 * but stays `seeking`, and the seeks of the store wait behind it. The 0.25 s holds a margin.
 * WebKit completes such a seek (ADR 046, measurement 28).
 */
export const CHROMIUM_SEEK_TAIL_SECONDS = 0.25;
/** `HTMLMediaElement.HAVE_CURRENT_DATA`: no data follows the frame at the position. */
const HAVE_CURRENT_DATA = 2;
/**
 * The slack of the end test of an MPEG-TS or Matroska window: a window whose video ends more
 * than this before its requested end stopped early.
 */
const SEEK_FORM_END_SLACK_SECONDS = 1;
/** An early end of an MPEG-TS or Matroska window counts as the end of the file this close to it. */
const SEEK_FORM_END_TOLERANCE_SECONDS = 5;
/** The eviction removes data only when it frees more than this, so the removes stay few. */
const EVICT_STEP_SECONDS = 5;
/** A window that goes on by time must start this much later than the one before it. */
const RESUME_PROGRESS_SECONDS = 1;
/** Without known keyframes, a full SourceBuffer drops the data this far behind the position. */
const QUOTA_FALLBACK_BEHIND_SECONDS = 30;
/**
 * The spans of two fragments join across this gap. A fragment starts at the presentation time of
 * its first sample in decode order, so with B-frames the edges of two fragments can leave a gap
 * of a few frames.
 */
const SPAN_JOIN_SECONDS = 0.25;
/**
 * A span may end this far after a buffered range, which is the intersection of the audio and the
 * video: the audio can end earlier than the video.
 */
const SPAN_BUFFERED_SLACK_SECONDS = 1;
/**
 * The windows that make no progress fail when the position is this close to where they stop it.
 * WebKit stops when the buffered data ends within about 83 ms of the position, so a smaller reach
 * could miss the stop. No more data comes, so a failure a little early costs nothing.
 */
const NO_PROGRESS_REACH_SECONDS = 0.25;
/** The time precision of the tests. */
const EPSILON_SECONDS = 1e-3;
/**
 * The video after the target of a seek that the report of its data needs: more than the 3 ms of
 * the repair of the store, with the precision of `hasVideoAt`.
 */
const SEEK_DATA_REACH_SECONDS = 0.01;

/** `TimeRanges`. */
export interface MseTimeRanges {
  readonly length: number;
  start: (index: number) => number;
  end: (index: number) => number;
}

/** The narrow surface of a SourceBuffer that the controller uses, so a test can pass a fake. */
export interface MseSourceBuffer {
  readonly updating: boolean;
  readonly buffered: MseTimeRanges;
  mode: AppendMode;
  timestampOffset: number;
  appendBuffer: (data: Uint8Array<ArrayBuffer>) => void;
  remove: (start: number, end: number) => void;
  abort: () => void;
  changeType?: (type: string) => void;
  addEventListener: (type: "updateend", listener: () => void) => void;
  removeEventListener: (type: "updateend", listener: () => void) => void;
}

/** The narrow surface of a MediaSource. */
export interface MseMediaSource {
  readonly readyState: ReadyState;
  duration: number;
  addSourceBuffer: (type: string) => MseSourceBuffer;
  endOfStream: () => void;
  addEventListener: (type: "sourceopen", listener: () => void) => void;
  removeEventListener: (type: "sourceopen", listener: () => void) => void;
}

/** The element events that the controller follows. */
export type MseElementEvent = "seeking" | "timeupdate" | "seeked" | "waiting";

/** The narrow surface of the video element. */
export interface MseVideoElement {
  src: string;
  readonly currentTime: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  readonly readyState: number;
  removeAttribute: (name: "src") => void;
  load: () => void;
  addEventListener: (type: MseElementEvent, listener: () => void) => void;
  removeEventListener: (type: MseElementEvent, listener: () => void) => void;
}

/** What the controller takes from the browser and from the window client. */
export interface MseEnvironment {
  /** A new MediaSource and its object URL. */
  readonly createMediaSource: () => { source: MseMediaSource; url: string };
  readonly revokeObjectUrl: (url: string) => void;
  readonly isTypeSupported: (type: string) => boolean;
  readonly openWindow: (
    request: WindowRequest,
    listener: WindowListener,
  ) => WindowSession;
  /**
   * The end of a buffered range before a hole where a seek of the web view does not complete:
   * `CHROMIUM_SEEK_TAIL_SECONDS` in Chromium, 0 in WebKit. A seek there counts as a seek into the
   * hole.
   */
  readonly seekTailSeconds: number;
}

/** The source as the windows need it. */
export interface MseSource {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
  readonly container: WindowContainer;
  /** The container start time of the probe, for the input seek of MPEG-TS and Matroska. */
  readonly formatStartTime: Rational | null;
  /** The absolute source time of `videoStartPts`. */
  readonly videoStartSeconds: number;
  /** The `duration` of the MediaSource. */
  readonly durationSeconds: number;
  /** What the windows do with the audio, as the preview chose it. */
  readonly audio: WindowAudio;
  readonly audioCodec: string | null;
  /** On FLV, decode the audio of each window to PCM for the scrub cue. */
  readonly pcm: boolean;
  /**
   * Scan for decoder configurations before the first window that serves a seek (ADR 046,
   * "Failures"). After a window failed to decode, the reload of ADR 039 seeks to the place of
   * the failure, and that window starts there.
   */
  readonly rescanConfig: boolean;
}

/** Why the controller stopped. */
export type MseFailure =
  /** The web view cannot play the codecs of the windows. */
  | { readonly kind: "codecRejected"; readonly type: string }
  | { readonly kind: "ffmpegMissing" }
  /** A window failed: the command refused it, or FFmpeg failed. */
  | {
      readonly kind: "windowFailed";
      readonly code: string;
      readonly detail: string | null;
    };

/** What the controller reports. */
export interface MseControllerEvents {
  /** The media time of the first frame of the first window, for the self-check of ADR 046. */
  readonly onExpectedFirstFrame: (mediaTime: number) => void;
  /** The first keyframe tag of the FLV and the first sample of the window disagree. */
  readonly onFirstFrameMismatch: (detail: string) => void;
  /**
   * Asks for a seek over a gap to `mediaTime`. The element waits at `position`, and it can still
   * be seeking there, a seek that never completes. Before the first frame of the file, no frame
   * lies at the position, and `mediaTime` is the first frame after it. In the middle of the file,
   * the playback stopped at the end of a buffered range, or a seek waits in the hole after it,
   * which no window fills. `mediaTime` then lies after the hole, or before it for a seek that
   * came from after it.
   */
  readonly onGap: (mediaTime: number, position: number) => void;
  /** The timestamps of the source decrease. */
  readonly onNonMonotonic: () => void;
  /** The windows play without sound, because the audio could not be transcoded. */
  readonly onAudioOmitted: () => void;
  readonly onFailure: (failure: MseFailure) => void;
  /**
   * A piece of the PCM of an FLV window: 16-bit little-endian mono samples at 48 kHz, whose
   * sample 0 is at `startSeconds` of the source. `key` names the window.
   */
  readonly onPcm?: (
    key: number,
    startSeconds: number,
    bytes: Uint8Array<ArrayBuffer>,
  ) => void;
  /** The PCM of an FLV window ended. A failed audio process disables the cue. */
  readonly onPcmEnd?: (end: WindowEnd) => void;
  /**
   * An append brought the video at `mediaTime`, the target of a seek that began with no video
   * there. WKWebView completes such a seek wrongly: it shows the next keyframe, or it stays
   * seeking. A new seek after the data arrived lands right (ADR 046, measurement 26).
   * `videoAfter` is false when no video follows the target, at the end of the file.
   */
  readonly onSeekDataArrived?: (mediaTime: number, videoAfter: boolean) => void;
}

export interface MseController {
  /** Stops every window and detaches the MediaSource from the element. */
  readonly destroy: () => void;
  /**
   * The media times at which the video frames of the appended data start, ascending and with no
   * duplicates, for the frame step of the store (ADR 022). The answer is valid until the next
   * append or remove.
   */
  readonly frameStarts: () => readonly number[];
}

/** One window, from its request to the processing of its end. */
interface ActiveWindow {
  readonly key: number;
  readonly request: WindowRequest;
  /** The session of the window. It is set right after the request. */
  session: WindowSession;
  /** The media time that the window serves: a seek target, or where the data goes on. */
  readonly target: number;
  /** True for a window that continues the buffered data, false for one that serves a seek. */
  readonly continues: boolean;
  /** True for the first window of the controller, whose first frame the store checks. */
  readonly first: boolean;
  readonly margin: number;
  readonly scanner: Fmp4Scanner;
  /** The tracks of the `moov` of the window. */
  tracks: readonly Fmp4Track[];
  /** The bytes before the `moov` of the window. */
  held: Uint8Array<ArrayBuffer>[];
  initDone: boolean;
  /** The media time of the first video sample, from the first `moof`. */
  firstVideoTime: number | null;
  /** The media time of the first video sample of the last `moof`. */
  lastVideoTime: number | null;
  /** The media time where the video of the fragments so far ends. */
  videoEnd: number | null;
  /** The video of the last `moof`, until its `mdat` is complete. */
  pendingFragment: VideoFragment | null;
  /** The media time where the appended video of the window ends. */
  appendedEnd: number | null;
  opened: WindowOpened | null;
  pcmHeld: Uint8Array<ArrayBuffer>[];
  ended: boolean;
  /** True once the PCM of the window ended, which can come before the end of its video. */
  pcmEnded: boolean;
}

/** A stretch of video that the windows appended since the data was last dropped. */
interface VideoSpan {
  start: number;
  end: number;
}

/** The video of one fragment, in media time. */
interface VideoFragment {
  readonly start: number;
  readonly end: number;
  readonly sync: boolean;
  /**
   * The start of each frame of the fragment, in the order of its samples, or null when the
   * fragment states no time for one of them.
   */
  readonly frames: readonly number[] | null;
}

type Operation =
  | {
      readonly kind: "append";
      readonly key: number;
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly session: WindowSession;
      /** The fragments whose data this append completes. */
      readonly fragments: readonly VideoFragment[];
    }
  /** `clears` marks the remove of all data at a seek, which `hasVideoAt` waits for. */
  | {
      readonly kind: "remove";
      readonly start: number;
      readonly end: number;
      readonly clears: boolean;
    }
  | { readonly kind: "abort" }
  | { readonly kind: "changeType"; readonly key: number; readonly type: string }
  | { readonly kind: "endOfStream" }
  | { readonly kind: "done"; readonly key: number; readonly end: WindowEnd };

/** The frame list of a controller whose frames are not all known. */
const NO_FRAMES: readonly number[] = [];

/** The session of a window record before its request returns a session. */
const NO_SESSION: WindowSession = {
  opened: new Promise<never>(() => undefined),
  ack: () => undefined,
  close: () => undefined,
  isClosed: () => true,
};

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "QuotaExceededError"
  );
}

function isPreviewWindowError(error: unknown): error is PreviewWindowError {
  return typeof error === "object" && error !== null && "code" in error;
}

/** The MIME type of a SourceBuffer for the tracks of a window. */
export function mimeTypeFor(tracks: readonly Fmp4Track[]): string | null {
  const codecs: string[] = [];
  for (const kind of ["video", "audio"] as const) {
    const track = tracks.find((item) => item.kind === kind);
    if (track === undefined) {
      continue;
    }
    if (track.codec === null) {
      return null;
    }
    codecs.push(track.codec);
  }
  if (!tracks.some((track) => track.kind === "video")) {
    return null;
  }
  return `video/mp4; codecs="${codecs.join(",")}"`;
}

/**
 * Starts the MediaSource of `element` and its first window. The element must have no `src`.
 * When the element reports an error, the preview destroys the controller with the element.
 */
export function createMseController(
  element: MseVideoElement,
  source: MseSource,
  environment: MseEnvironment,
  events: MseControllerEvents,
): MseController {
  const { source: mediaSource, url } = environment.createMediaSource();
  let sourceBuffer: MseSourceBuffer | null = null;
  /** The type of the SourceBuffer, and the type after the queued `changeType`. */
  let appliedType: string | null = null;
  let queuedType: string | null = null;
  /** The audio of the windows. It can change only before the SourceBuffer exists. */
  let audio = source.audio;
  let destroyed = false;
  let failed = false;
  let nextKey = 1;
  let active: ActiveWindow | null = null;
  /** Finished windows whose PCM can still arrive, until a seek or the destroy closes them. */
  let finishedSessions: WindowSession[] = [];
  const operations: Operation[] = [];
  let running: Operation | null = null;
  /** The appends of a full SourceBuffer wait until the position moves. */
  let quotaBlocked = false;
  /** The last window of the file is buffered, so the stream ends after each change. */
  let tailBuffered = false;
  /** The stream was ended, or the end failed, since the last change of the data. */
  let endTried = false;
  /** Where the windows go on after the last complete window, or null. */
  let resume: { readonly start: WindowStart; readonly end: number } | null = null;
  /**
   * The target of the seek that waits for the running window, or null. It goes at the next seek,
   * at `seeked`, and when the page drops its data.
   */
  let waitingTarget: number | null = null;
  /** True when the window that `waitingTarget` waits for started at that target. */
  let waitingStarted = false;
  /** True from a request for a seek over a gap in the middle of the file until the next seek. */
  let gapRequested = false;
  /** The position at the last `seeking`, `seeked`, or `timeupdate` that no seek ran at. */
  let lastPosition: number | null = null;
  /** The position before the running seek, or null. */
  let seekOrigin: number | null = null;
  /**
   * The target of the seek that began with no video at its target, until an append brings that
   * video (`onSeekDataArrived`). It goes at the next seek.
   */
  let unbufferedSeekTarget: number | null = null;
  /** The source time of the last window that went on by time, for the progress check. */
  let lastTimeResume: number | null = null;
  /**
   * The end of the appended video when the windows make no progress. The controller fails when
   * the position reaches it, so the video before it still plays.
   */
  let noProgressAt: number | null = null;
  /**
   * The position that waits for the first frame after it, or null. The element starts at 0,
   * and a file whose first keyframe comes later has no frame there.
   */
  let gapPosition: number | null = 0;
  /** The media time of the first frame of the file, from the first window. */
  let fileFirstFrame: number | null = null;
  let firstWindowStarted = false;
  let transcodeRetried = false;
  /** The scan of decoder configurations still waits for its window. */
  let rescanPending = source.rescanConfig;
  /** True from a seek that drops the data until the remove of that data ends. */
  let clearing = false;
  /** The video that the windows appended since the data was last dropped, in order. */
  let spans: VideoSpan[] = [];
  /** True once the controller reported that the timestamps decrease. It reports that once. */
  let reportedNonMonotonic = false;
  /** The media times of the keyframes that start fragments, in order. */
  let keyframes: number[] = [];
  /** The media times at which the appended video frames start, ascending. */
  let frames: number[] = [];
  /**
   * False once an appended fragment gave no frame times, or a `moof` did not parse, until a seek
   * drops the data. The list then lacks frames, and a step by it would skip them, so the
   * controller gives no frames and the step of the store keeps the grid.
   */
  let framesKnown = true;

  const reportNonMonotonic = (): void => {
    if (!reportedNonMonotonic) {
      reportedNonMonotonic = true;
      events.onNonMonotonic();
    }
  };

  const fail = (failure: MseFailure): void => {
    if (failed || destroyed) {
      return;
    }
    failed = true;
    active?.session.close();
    active = null;
    events.onFailure(failure);
  };

  const currentTime = (): number => {
    const time = element.currentTime;
    return Number.isFinite(time) ? time : 0;
  };

  const absoluteSeconds = (mediaTime: number): number =>
    sourceSecondsAt(mediaTime, source.videoStartSeconds);

  const mediaTimeOf = (ticks: number, track: Fmp4Track): number =>
    sampleMediaTime(ticks, track.timescale, source.videoStartSeconds);

  /** True when a buffered range of the SourceBuffer holds `time`, its end included. */
  const bufferedAt = (time: number): boolean => {
    if (sourceBuffer === null) {
      return false;
    }
    try {
      const ranges = sourceBuffer.buffered;
      for (let index = 0; index < ranges.length; index++) {
        if (
          ranges.start(index) - EPSILON_SECONDS <= time &&
          time <= ranges.end(index) + EPSILON_SECONDS
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  /**
   * The end of the last buffered range that starts at or before `time`, or null. The element
   * stops there when no more data comes.
   */
  const bufferedEndBefore = (time: number): number | null => {
    if (sourceBuffer === null) {
      return null;
    }
    try {
      const ranges = sourceBuffer.buffered;
      let end: number | null = null;
      for (let index = 0; index < ranges.length; index++) {
        if (ranges.start(index) - EPSILON_SECONDS <= time) {
          end = ranges.end(index);
        }
      }
      return end;
    } catch {
      return null;
    }
  };

  /** The start of the first buffered range, or null. */
  const firstBufferedStart = (): number | null => {
    if (sourceBuffer === null) {
      return null;
    }
    try {
      return sourceBuffer.buffered.length > 0 ? sourceBuffer.buffered.start(0) : null;
    } catch {
      return null;
    }
  };

  /** The buffered ranges of the SourceBuffer, in order. */
  const bufferedRanges = (): VideoSpan[] => {
    if (sourceBuffer === null) {
      return [];
    }
    const ranges: VideoSpan[] = [];
    try {
      const buffered = sourceBuffer.buffered;
      for (let index = 0; index < buffered.length; index++) {
        ranges.push({ start: buffered.start(index), end: buffered.end(index) });
      }
    } catch {
      return [];
    }
    return ranges;
  };

  /** True when the appended video holds `time`, its end included. */
  const hasVideoAt = (time: number): boolean =>
    !clearing &&
    (spans.some(
      (span) =>
        span.start - EPSILON_SECONDS <= time && time <= span.end + EPSILON_SECONDS,
    ) ||
      bufferedAt(time));

  const addSpan = (start: number, end: number): void => {
    spans.push({ start, end });
    spans.sort((a, b) => a.start - b.start);
    const joined: VideoSpan[] = [];
    for (const span of spans) {
      const last = joined[joined.length - 1];
      if (last !== undefined && span.start <= last.end + SPAN_JOIN_SECONDS) {
        last.end = Math.max(last.end, span.end);
      } else {
        joined.push({ start: span.start, end: span.end });
      }
    }
    spans = joined;
  };

  /**
   * Clips the spans to the buffered ranges. The browser removes data on its own, as Chromium does
   * on an append to a full SourceBuffer, so a span can outlive its data. A range is the
   * intersection of the audio and the video, so its start alone does not tell a remove from audio
   * that starts late. A browser removes video only up to a keyframe, so a span that starts before
   * a range loses its start up to the latest keyframe at or before the range start, and keeps it
   * when no keyframe lies there. Fragments with no sync flags give no keyframes, so then a span
   * keeps at most 1 s before the range, for audio that starts late. Its end can lie a little
   * after the range, where the audio ended.
   */
  const clipSpansToBuffered = (): void => {
    if (sourceBuffer === null || clearing) {
      return;
    }
    const ranges = bufferedRanges();
    const clipped: VideoSpan[] = [];
    for (const span of spans) {
      for (const range of ranges) {
        let start = span.start;
        if (range.start > span.start + EPSILON_SECONDS && keyframes.length === 0) {
          start = Math.max(span.start, range.start - SPAN_BUFFERED_SLACK_SECONDS);
        } else if (range.start > span.start + EPSILON_SECONDS) {
          const removedTo = keyframes
            .filter(
              (keyframe) =>
                keyframe > span.start + EPSILON_SECONDS &&
                keyframe <= range.start + EPSILON_SECONDS,
            )
            .pop();
          start = removedTo ?? span.start;
        }
        const end = Math.min(span.end, range.end + SPAN_BUFFERED_SLACK_SECONDS);
        if (start < end && range.start - SPAN_BUFFERED_SLACK_SECONDS < end) {
          clipped.push({ start, end });
        }
      }
    }
    spans = clipped;
    const inSpans = (time: number): boolean =>
      spans.some(
        (span) =>
          span.start - EPSILON_SECONDS <= time && time <= span.end + EPSILON_SECONDS,
      );
    keyframes = keyframes.filter(inSpans);
    frames = frames.filter(inSpans);
  };

  const addKeyframe = (time: number): void => {
    if (keyframes.some((keyframe) => Math.abs(keyframe - time) <= EPSILON_SECONDS)) {
      return;
    }
    keyframes.push(time);
    keyframes.sort((a, b) => a - b);
  };

  /** The latest keyframe at or before `time`, or null. */
  const keyframeAtOrBefore = (time: number): number | null => {
    let found: number | null = null;
    for (const keyframe of keyframes) {
      if (keyframe > time + EPSILON_SECONDS) {
        break;
      }
      found = keyframe;
    }
    return found;
  };

  /** Forgets the video before `time`, which a remove drops. */
  const forgetBefore = (time: number): void => {
    spans = spans
      .filter((span) => span.end > time)
      .map((span) => ({ start: Math.max(span.start, time), end: span.end }));
    keyframes = keyframes.filter((keyframe) => keyframe >= time - EPSILON_SECONDS);
    frames = frames.filter((frame) => frame >= time - EPSILON_SECONDS);
  };

  /**
   * A remove up to a keyframe, which keeps the GOP that holds the position: the MSE
   * specification extends a remove to the next random access point after it.
   */
  const removeBefore = (end: number, toFront: boolean): void => {
    const operation: Operation = { kind: "remove", start: 0, end, clears: false };
    if (toFront) {
      operations.unshift(operation);
    } else {
      operations.push(operation);
    }
    forgetBefore(end);
    pump();
  };

  // The operations run one at a time, each after the `updateend` of the one before.
  const pump = (): void => {
    if (
      destroyed ||
      sourceBuffer === null ||
      running !== null ||
      sourceBuffer.updating
    ) {
      return;
    }
    const buffer = sourceBuffer;
    while (running === null && operations.length > 0) {
      const operation = operations[0];
      switch (operation.kind) {
        case "append": {
          if (quotaBlocked) {
            return;
          }
          try {
            buffer.appendBuffer(operation.bytes);
          } catch (error) {
            if (isQuotaError(error)) {
              makeRoom();
              return;
            }
            // The SourceBuffer is gone or closed, and the element reports the error. The
            // window stops, so the credit does not hold a reader of the share.
            operations.length = 0;
            active?.session.close();
            active = null;
            failed = true;
            return;
          }
          operations.shift();
          running = operation;
          return;
        }
        case "remove": {
          operations.shift();
          if (operation.start >= operation.end || mediaSource.readyState === "closed") {
            if (operation.clears) {
              clearing = false;
            }
            continue;
          }
          try {
            buffer.remove(operation.start, operation.end);
          } catch {
            if (operation.clears) {
              clearing = false;
            }
            continue;
          }
          running = operation;
          return;
        }
        case "abort":
          operations.shift();
          // `abort` throws unless the source is open. An ended source holds whole segments only.
          if (mediaSource.readyState === "open") {
            try {
              buffer.abort();
            } catch {
              // The next init segment starts the parser again where the browser allows it.
            }
          }
          continue;
        case "changeType":
          operations.shift();
          try {
            buffer.changeType?.(operation.type);
            appliedType = operation.type;
          } catch {
            fail({ kind: "codecRejected", type: operation.type });
            return;
          }
          continue;
        case "endOfStream":
          operations.shift();
          endTried = true;
          if (
            mediaSource.readyState === "open" &&
            tailBuffered &&
            operations.length === 0
          ) {
            try {
              mediaSource.endOfStream();
            } catch {
              // The next change of the data ends the stream again.
            }
          }
          continue;
        case "done":
          operations.shift();
          finishWindow(operation.key, operation.end);
          continue;
      }
    }
    if (running === null && operations.length === 0) {
      idle();
    }
  };

  /**
   * Makes room in a full SourceBuffer: removes the data up to the last keyframe at least 2 s
   * behind the position, or waits until the position moves.
   */
  const makeRoom = (): void => {
    const keep = currentTime() - QUOTA_KEEP_BEHIND_SECONDS;
    const keyframe =
      keyframes.length > 0
        ? keyframeAtOrBefore(keep)
        : currentTime() - QUOTA_FALLBACK_BEHIND_SECONDS;
    const start = firstBufferedStart();
    if (keyframe !== null && start !== null && keyframe > start + EPSILON_SECONDS) {
      removeBefore(keyframe, true);
      return;
    }
    quotaBlocked = true;
  };

  /** Runs when the queue is empty: the end of the stream, the eviction, and the prefetch. */
  const idle = (): void => {
    // An append or a remove sets an ended source to open again, so the stream ends again after
    // each change while the last window stays buffered.
    if (tailBuffered && !endTried && mediaSource.readyState === "open") {
      operations.push({ kind: "endOfStream" });
      pump();
      return;
    }
    checkStartGap();
    checkGap();
    checkProgress();
    checkSeekData();
    serveWaitingSeek();
    evict();
    prefetch();
  };

  const onUpdateEnd = (): void => {
    const operation = running;
    running = null;
    endTried = false;
    if (operation?.kind === "append") {
      operation.session.ack(operation.bytes.byteLength);
      for (const fragment of operation.fragments) {
        addSpan(fragment.start, fragment.end);
        if (fragment.sync) {
          addKeyframe(fragment.start);
        }
        if (fragment.frames === null) {
          framesKnown = false;
        } else if (fragment.frames.length > 0) {
          frames = mergeFrameStarts(frames, fragment.frames);
        }
        if (active?.key === operation.key) {
          active.appendedEnd = Math.max(
            active.appendedEnd ?? fragment.end,
            fragment.end,
          );
        }
      }
    } else if (operation?.kind === "remove" && operation.clears) {
      clearing = false;
    }
    clipSpansToBuffered();
    checkSeekData();
    pump();
  };

  /**
   * Reports the data of the seek that began with no video at its target, once the video holds
   * the target and a little after it, or the last window of the file is buffered. The repair of
   * the store seeks 3 ms after the target (ADR 046), so that place must hold video too.
   */
  const checkSeekData = (): void => {
    const target = unbufferedSeekTarget;
    if (target === null || !hasVideoAt(target)) {
      return;
    }
    const videoAfter = hasVideoAt(target + SEEK_DATA_REACH_SECONDS);
    // At the end of the file the repair seeks before the target first, so that place must hold
    // video then.
    if (
      !videoAfter &&
      !(tailBuffered && hasVideoAt(target - SEEK_DATA_REACH_SECONDS))
    ) {
      return;
    }
    unbufferedSeekTarget = null;
    events.onSeekDataArrived?.(target, videoAfter);
  };

  /** Removes the data more than 20 s behind the position, up to a keyframe. */
  const evict = (): void => {
    if (operations.length > 0 || running !== null || clearing) {
      return;
    }
    const keyframe = keyframeAtOrBefore(currentTime() - KEEP_BEHIND_SECONDS);
    const start = firstBufferedStart();
    if (keyframe !== null && start !== null && keyframe > start + EVICT_STEP_SECONDS) {
      removeBefore(keyframe, false);
    }
  };

  /**
   * Asks for a seek over a gap before the first frame. The element can still be seeking to the
   * position, a seek that never completes, so the store replaces it with this one.
   */
  const checkStartGap = (): void => {
    const waiting = gapPosition;
    if (waiting === null || clearing) {
      return;
    }
    const position = currentTime();
    if (Math.abs(position - waiting) > EPSILON_SECONDS || hasVideoAt(position)) {
      gapPosition = null;
      return;
    }
    const next = spans.find((span) => span.start > position);
    if (next !== undefined && next.start - position <= GAP_LIMIT_SECONDS) {
      gapPosition = null;
      events.onGap(next.start, position);
    }
  };

  /**
   * Asks for a seek over a hole between two buffered ranges in the middle of the file (ADR 046).
   * The windows skip a stretch that holds no decodable video: after a reconnect whose new part
   * starts in the middle of a GOP, or after damage, the next window starts at the next keyframe.
   * The element stops at the end of the range before the hole, and a seek into the hole never
   * completes, as a seek into the end of that range in Chromium (`seekTailSeconds`).
   *
   * A hole that the running window has passed is permanent: the windows append in time order. A
   * window that starts by time rewrites the end of the data, and the browser then drops the old
   * frames up to the next old keyframe, because they depend on the frames that the window
   * replaces. That hole lies after the first frame of the window, and it goes when the window
   * appends past it, so it does not count until then.
   *
   * When the playback waits at the end of the range, the store seeks to the start of the next
   * range and plays on. A seek into the hole goes on in its direction: to the start of the next
   * range, or, for a seek of a paused element that came from that range or later, to the end of
   * the range before the hole, where a seek completes. The controller asks once until the next
   * seek. Returns true when it asked.
   */
  const checkGap = (): boolean => {
    if (gapRequested || clearing || failed || destroyed) {
      return false;
    }
    const position = currentTime();
    let before: VideoSpan | null = null;
    let next: VideoSpan | null = null;
    for (const range of bufferedRanges()) {
      if (range.start - EPSILON_SECONDS <= position) {
        before = range;
      } else {
        next = range;
        break;
      }
    }
    // With no range before the position, the gap lies before the first frame (checkStartGap).
    if (
      before === null ||
      next === null ||
      next.start - before.end > GAP_LIMIT_SECONDS
    ) {
      return false;
    }
    // The window rewrites the data from its first frame on, so a hole before that frame does
    // not come from it.
    const filling = active;
    if (
      filling !== null &&
      filling.request.start.kind === "time" &&
      (filling.firstVideoTime === null ||
        before.end > filling.firstVideoTime - EPSILON_SECONDS) &&
      (filling.appendedEnd === null ||
        filling.appendedEnd < next.start - EPSILON_SECONDS)
    ) {
      return false;
    }
    const left = before.end - position;
    const tail = environment.seekTailSeconds;
    const stopped = !element.paused && element.readyState <= HAVE_CURRENT_DATA;
    let target: number;
    if (element.seeking) {
      if (left >= tail) {
        return false;
      }
      // A seek during the playback, as the seek to the In of a segment playback, goes on after
      // the hole, so it plays no frame before its target.
      const backward =
        element.paused &&
        seekOrigin !== null &&
        seekOrigin >= next.start - EPSILON_SECONDS;
      target = backward ? before.end - tail - EPSILON_SECONDS : next.start;
    } else if (stopped && left <= GAP_REACH_SECONDS) {
      target = next.start;
    } else {
      return false;
    }
    gapRequested = true;
    events.onGap(target, position);
    return true;
  };

  const windowRequest = (
    start: WindowStart,
    margin: number,
    rescan: boolean,
  ): WindowRequest => ({
    path: source.path,
    size: source.size,
    mtime: source.mtime,
    lane: "video",
    container: source.container,
    start,
    formatStartTime: source.formatStartTime,
    ...(source.container === "flv" || margin === SEEK_MARGIN_SECONDS
      ? {}
      : { marginSeconds: margin }),
    audio,
    audioCodec: source.audioCodec,
    pcm: source.pcm && source.container === "flv" && audio !== "omit",
    rescanConfig: rescan,
  });

  /**
   * Starts a window. A running window stops first. `first` marks the first window of the
   * controller, also when it starts again with other audio.
   */
  const startWindow = (
    start: WindowStart,
    target: number,
    options: {
      readonly margin?: number;
      readonly first?: boolean;
      readonly continues?: boolean;
      readonly rescan?: boolean;
    } = {},
  ): void => {
    if (destroyed || failed) {
      return;
    }
    const margin = options.margin ?? SEEK_MARGIN_SECONDS;
    const first = options.first ?? !firstWindowStarted;
    const continues = options.continues ?? false;
    let rescan = options.rescan ?? false;
    if (
      options.rescan === undefined &&
      rescanPending &&
      start.kind === "time" &&
      !continues
    ) {
      rescanPending = false;
      rescan = true;
    }
    active?.session.close();
    firstWindowStarted = true;
    const key = nextKey++;
    const request = windowRequest(start, margin, rescan);
    const window: ActiveWindow = {
      key,
      request,
      session: NO_SESSION,
      target,
      continues,
      first,
      margin,
      scanner: new Fmp4Scanner(),
      tracks: [],
      held: [],
      initDone: false,
      firstVideoTime: null,
      lastVideoTime: null,
      videoEnd: null,
      pendingFragment: null,
      appendedEnd: null,
      opened: null,
      pcmHeld: [],
      ended: false,
      pcmEnded: false,
    };
    const session = environment.openWindow(request, {
      onChunk: (bytes) => onChunk(window, bytes),
      onEnd: (end) => {
        if (active?.key !== key) {
          return;
        }
        window.ended = true;
        if (sourceBuffer === null) {
          // Nothing of the window reached a SourceBuffer, so its end needs no wait.
          finishWindow(key, end);
          return;
        }
        operations.push({ kind: "done", key, end });
        pump();
      },
      onPcmChunk: (bytes) => onPcmChunk(window, bytes),
      onPcmEnd: (end) => {
        if (window.session.isClosed() || destroyed) {
          return;
        }
        window.pcmEnded = true;
        // A window whose video has ended is complete, and its session goes, so the list of
        // finished windows stays short. The PCM can end first, as when its process fails to
        // start: the video window then goes on (ADR 046).
        if (window.ended) {
          finishedSessions = finishedSessions.filter(
            (session) => session !== window.session,
          );
          window.session.close();
        }
        events.onPcmEnd?.(end);
      },
    });
    window.session = session;
    active = window;
    session.opened.then(
      (opened) => onOpened(window, opened),
      (error: unknown) => onRefused(window, error),
    );
  };

  /** The options that start a window again as it was. */
  const sameWindow = (window: ActiveWindow) => ({
    margin: window.margin,
    first: window.first,
    continues: window.continues,
    rescan: window.request.rescanConfig === true,
  });

  /** True when the input seek of a window at `target` with `margin` reads from the file start. */
  const readsFromFileStart = (target: number, margin: number): boolean => {
    const formatStart =
      source.formatStartTime === null
        ? 0
        : source.formatStartTime.n / source.formatStartTime.d;
    return absoluteSeconds(target) - formatStart - margin <= 0;
  };

  const onOpened = (window: ActiveWindow, opened: WindowOpened): void => {
    if (window.session.isClosed() || failed || destroyed) {
      return;
    }
    window.opened = opened;
    if (opened.nonMonotonic) {
      reportNonMonotonic();
    }
    const startSeconds = opened.pcmStartSeconds;
    if (startSeconds !== null) {
      for (const bytes of window.pcmHeld) {
        events.onPcm?.(window.key, startSeconds, bytes);
      }
    }
    window.pcmHeld = [];
    compareFirstKeyframe(window);
  };

  // A request refused as superseded or a window canceled stops here with no report: a newer
  // request of the lane took over, which only happens while this controller is being replaced.
  const onRefused = (window: ActiveWindow, error: unknown): void => {
    if (active?.key !== window.key) {
      return;
    }
    active = null;
    const code = isPreviewWindowError(error) ? error.code : "commandExecutionFailed";
    if (code === "superseded") {
      waitingTarget = null;
      return;
    }
    if (code === "ffmpegNotFound") {
      fail({ kind: "ffmpegMissing" });
      return;
    }
    fail({
      kind: "windowFailed",
      code,
      detail: isPreviewWindowError(error) ? error.detail : String(error),
    });
  };

  // The PCM of a window can arrive after the end of its fMP4, so it counts until a seek or the
  // destroy closes the session.
  const onPcmChunk = (window: ActiveWindow, bytes: Uint8Array<ArrayBuffer>): void => {
    if (window.session.isClosed() || failed || destroyed) {
      return;
    }
    const startSeconds = window.opened?.pcmStartSeconds ?? null;
    if (window.opened === null) {
      window.pcmHeld.push(bytes);
    } else if (startSeconds !== null) {
      events.onPcm?.(window.key, startSeconds, bytes);
    }
  };

  /**
   * On FLV, the first keyframe tag that Rust located and the first video sample of the window
   * must agree to the millisecond (ADR 046, "Calibration").
   */
  const compareFirstKeyframe = (window: ActiveWindow): void => {
    const tagMs = window.opened?.firstKeyframePtsMs ?? null;
    if (!window.first || tagMs === null || window.firstVideoTime === null) {
      return;
    }
    const sampleMs = absoluteSeconds(window.firstVideoTime) * 1000;
    if (Math.abs(sampleMs - tagMs) > 1) {
      events.onFirstFrameMismatch(
        `the first keyframe tag is at ${tagMs} ms, and the first sample at ${sampleMs} ms`,
      );
    }
  };

  const onChunk = (window: ActiveWindow, bytes: Uint8Array<ArrayBuffer>): void => {
    if (active?.key !== window.key || failed || destroyed) {
      return;
    }
    let boxes: Fmp4Box[];
    try {
      boxes = window.scanner.push(bytes);
    } catch (error) {
      fail({
        kind: "windowFailed",
        code: "invalidResponse",
        detail: error instanceof Fmp4Error ? error.message : String(error),
      });
      return;
    }
    const completed: VideoFragment[] = [];
    for (const box of boxes) {
      if (box.type === "mdat" && window.pendingFragment !== null) {
        completed.push(window.pendingFragment);
        window.pendingFragment = null;
        continue;
      }
      if (box.bytes === null) {
        continue;
      }
      if (box.type === "moov") {
        if (!takeMovie(window, box.bytes)) {
          return;
        }
      } else if (box.type === "moof") {
        takeFragment(window, box.bytes);
        if (active?.key !== window.key) {
          return;
        }
      }
    }
    if (!window.initDone) {
      window.held.push(bytes);
      return;
    }
    const pending = window.held;
    window.held = [];
    for (const piece of pending) {
      operations.push({
        kind: "append",
        key: window.key,
        bytes: piece,
        session: window.session,
        fragments: [],
      });
    }
    operations.push({
      kind: "append",
      key: window.key,
      bytes,
      session: window.session,
      fragments: completed,
    });
    pump();
  };

  /** Reads the `moov` of a window. Returns false when the window stops. */
  const takeMovie = (window: ActiveWindow, moov: Uint8Array): boolean => {
    let tracks: Fmp4Track[];
    try {
      tracks = parseMovie(moov);
    } catch (error) {
      fail({
        kind: "windowFailed",
        code: "invalidResponse",
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const type = mimeTypeFor(tracks);
    const video = tracks.find((track) => track.kind === "video") ?? null;
    if (type === null || video === null) {
      fail({ kind: "codecRejected", type: type ?? "video/mp4" });
      return false;
    }
    if (sourceBuffer === null) {
      if (!environment.isTypeSupported(type)) {
        const videoOnly = mimeTypeFor([video]);
        const hasAudio = tracks.some((track) => track.kind === "audio");
        if (hasAudio && videoOnly !== null && environment.isTypeSupported(videoOnly)) {
          // The web view refuses the audio, which the windows can still transcode or leave out.
          // The track count of a SourceBuffer cannot change, so this happens only now.
          retryAudio(window);
          return false;
        }
        fail({ kind: "codecRejected", type });
        return false;
      }
      try {
        const buffer = mediaSource.addSourceBuffer(type);
        buffer.mode = "segments";
        buffer.timestampOffset = -source.videoStartSeconds;
        buffer.addEventListener("updateend", onUpdateEnd);
        sourceBuffer = buffer;
        appliedType = type;
        queuedType = type;
      } catch {
        fail({ kind: "codecRejected", type });
        return false;
      }
    } else if (type !== queuedType) {
      // A reconnect can change the profile or the level. The track kinds stay.
      operations.push({ kind: "changeType", key: window.key, type });
      queuedType = type;
    }
    window.tracks = tracks;
    window.initDone = true;
    return true;
  };

  /** Starts the window again with the audio transcoded, or without audio. */
  const retryAudio = (window: ActiveWindow): void => {
    if (audio === "copy") {
      audio = "transcode";
    } else {
      audio = "omit";
      events.onAudioOmitted();
    }
    startWindow(window.request.start, window.target, sameWindow(window));
  };

  /**
   * Drops the queued operations of the window `key`, or of every window when `key` is null,
   * and the type change that they lead to.
   */
  const dropOperationsOf = (key: number | null): void => {
    for (let index = operations.length - 1; index >= 0; index--) {
      const operation = operations[index];
      const owned =
        operation.kind === "append" ||
        operation.kind === "done" ||
        operation.kind === "changeType";
      if (
        (owned && (key === null || operation.key === key)) ||
        (key === null && operation.kind === "endOfStream")
      ) {
        operations.splice(index, 1);
      }
    }
    let type = appliedType;
    for (const operation of operations) {
      if (operation.kind === "changeType") {
        type = operation.type;
      }
    }
    queuedType = type;
  };

  /**
   * Starts a window that continues the buffered data again with another margin. Its queued
   * appends go, and the parser starts again, because they can end inside a `moof`. The data
   * that earlier windows appended stays.
   */
  const retryContinuing = (window: ActiveWindow, margin: number): void => {
    window.session.close();
    active = null;
    dropOperationsOf(window.key);
    if (sourceBuffer !== null) {
      operations.push({ kind: "abort" });
    }
    startWindow(window.request.start, window.target, { ...sameWindow(window), margin });
    pump();
  };

  /** Starts the window that missed its target again with twice the margin. */
  const retryWithMargin = (window: ActiveWindow): void => {
    const margin = Math.min(window.margin * 2, MAX_SEEK_MARGIN_SECONDS);
    if (window.continues) {
      retryContinuing(window, margin);
    } else {
      restartAt(window.target, margin);
    }
  };

  /** True when a window of the input seek may start again with a larger margin. */
  const mayWidenMargin = (window: ActiveWindow): boolean =>
    source.container !== "flv" &&
    window.request.start.kind === "time" &&
    !readsFromFileStart(window.target, window.margin);

  /** Reads a `moof` of a window. */
  const takeFragment = (window: ActiveWindow, moof: Uint8Array): void => {
    const track = window.tracks.find((item) => item.kind === "video");
    if (track === undefined) {
      return;
    }
    let fragment: Fmp4Fragment | undefined;
    try {
      fragment = parseFragments(moof, window.tracks).find(
        (item) => item.trackId === track.id,
      );
    } catch {
      // The frames of this fragment stay unknown, so the frame list is no longer whole.
      framesKnown = false;
      return;
    }
    if (fragment === undefined) {
      return;
    }
    const time = mediaTimeOf(fragment.presentationTime, track);
    const end =
      fragment.duration === null
        ? time
        : mediaTimeOf(fragment.presentationTime + fragment.duration, track);
    if (window.firstVideoTime === null && !takeFirstFragment(window, time)) {
      return;
    }
    window.lastVideoTime = time;
    window.videoEnd = Math.max(window.videoEnd ?? end, end);
    // The video counts as appended once the append of its `mdat` ends.
    window.pendingFragment = {
      start: time,
      end,
      sync: fragment.sync === true,
      frames:
        fragment.presentationTimes?.map((ticks) => mediaTimeOf(ticks, track)) ?? null,
    };
  };

  /**
   * Reads the first video fragment of a window. Returns false when the window starts again
   * instead.
   */
  const takeFirstFragment = (window: ActiveWindow, time: number): boolean => {
    window.firstVideoTime = time;
    if (window.request.start.kind === "fileStart" && fileFirstFrame === null) {
      fileFirstFrame = time;
    }
    if (window.first) {
      events.onExpectedFirstFrame(time);
      compareFirstKeyframe(window);
    }
    if (
      time <= window.target + EPSILON_SECONDS ||
      window.request.start.kind !== "time"
    ) {
      return true;
    }
    // The window starts after its target. Before the first keyframe of the file no window can
    // start earlier: the position waits for the first frame, and the store seeks over the gap.
    if (!mayWidenMargin(window)) {
      if (!window.continues) {
        gapPosition = window.target;
      }
      return true;
    }
    // A window of the input seek that starts after its target covers no frame at or before
    // the target: FFmpeg seeked too late. The margin doubles, up to its limit.
    if (window.margin >= MAX_SEEK_MARGIN_SECONDS) {
      fail({
        kind: "windowFailed",
        code: "seekMissed",
        detail: `the window starts at ${time} s, after its target at ${window.target} s`,
      });
      return false;
    }
    retryWithMargin(window);
    return false;
  };

  /** Processes the end of a window, after its last append. */
  const finishWindow = (key: number, end: WindowEnd): void => {
    const window = active;
    if (window?.key !== key) {
      return;
    }
    active = null;
    if (!window.session.isClosed() && window.request.pcm === true) {
      if (window.pcmEnded) {
        window.session.close();
      } else {
        finishedSessions.push(window.session);
      }
    }
    if (end.nonMonotonic) {
      reportNonMonotonic();
    }
    if (end.status === "canceled") {
      // Another request took the lane, so no waiting seek takes it back.
      waitingTarget = null;
      return;
    }
    if (end.status === "failed") {
      if (
        !window.initDone &&
        audio === "transcode" &&
        !transcodeRetried &&
        sourceBuffer === null
      ) {
        transcodeRetried = true;
        audio = "omit";
        events.onAudioOmitted();
        startWindow(window.request.start, window.target, sameWindow(window));
        return;
      }
      fail({ kind: "windowFailed", code: "ffmpegFailed", detail: end.detail });
      return;
    }
    if (window.firstVideoTime === null) {
      // A window with no frame, such as an input seek that lands after the last keyframe. An
      // end of the stream with no data would set the duration to 0.
      if (mayWidenMargin(window) && window.margin < MAX_SEEK_MARGIN_SECONDS) {
        retryWithMargin(window);
        return;
      }
      fail({ kind: "windowFailed", code: "noFrames", detail: null });
      return;
    }
    const videoEnd = window.videoEnd ?? window.firstVideoTime;
    if (source.container === "flv") {
      if (end.reachedEnd) {
        markTail();
        return;
      }
      if (end.next !== null) {
        resume = {
          start: { kind: "resume", offset: end.next.offset, ptsMs: end.next.ptsMs },
          end: videoEnd,
        };
        return;
      }
      // The writer did not report in time, as when a read of a share stalls. The next window
      // goes on by time from the last fragment, and the file has not ended.
      goOnByTime(window.lastVideoTime ?? videoEnd, videoEnd);
      return;
    }
    // An input seek window that ends early near the end of the file reached it. An early end
    // in the middle, as at damage, goes on after it.
    const early = videoEnd < requestedEndOf(window) - SEEK_FORM_END_SLACK_SECONDS;
    if (early && videoEnd >= source.durationSeconds - SEEK_FORM_END_TOLERANCE_SECONDS) {
      markTail();
      return;
    }
    goOnByTime(videoEnd, videoEnd);
  };

  /**
   * Lets the next window go on by time from `from`. A window that would not start later than
   * the one before it stops the chain, so a window that ends at the same place each time does
   * not loop.
   */
  const goOnByTime = (from: number, end: number): void => {
    const seconds = absoluteSeconds(from);
    if (
      lastTimeResume !== null &&
      seconds <= lastTimeResume + RESUME_PROGRESS_SECONDS
    ) {
      // The playback would stop at the end of the appended video with no event, so the preview
      // hears of it when the position gets there.
      resume = null;
      noProgressAt = end;
      checkProgress();
      return;
    }
    lastTimeResume = seconds;
    resume = { start: { kind: "time", seconds }, end };
  };

  /** The media time where an MPEG-TS or Matroska window stops reading. */
  const requestedEndOf = (window: ActiveWindow): number => {
    const formatStart =
      source.formatStartTime === null
        ? 0
        : source.formatStartTime.n / source.formatStartTime.d;
    const seek = window.opened?.seekSeconds ?? 0;
    const endSeconds = formatStart + seek + WINDOW_SECONDS + window.margin;
    return endSeconds - source.videoStartSeconds;
  };

  /**
   * Fails once the position reaches the place where the windows that make no progress stop it:
   * the end of their video, or the end of the buffered range before it. That range is the
   * intersection of the audio and the video, so it can end first when the audio ends earlier,
   * and the end of the video is an estimate that lies a few frames late with B-frames. While
   * operations wait, the range can still grow, so only the end of the video counts then. The
   * queue calls this again when it is empty.
   */
  const checkProgress = (): void => {
    if (noProgressAt === null) {
      return;
    }
    const position = currentTime();
    const queueEmpty = running === null && operations.length === 0;
    const rangeEnd = queueEmpty ? bufferedEndBefore(position) : null;
    const stop = Math.min(noProgressAt, rangeEnd ?? noProgressAt);
    if (position >= stop - NO_PROGRESS_REACH_SECONDS) {
      const at = absoluteSeconds(noProgressAt);
      noProgressAt = null;
      fail({
        kind: "windowFailed",
        code: "noProgress",
        detail: `the windows end at ${at} s of the source each time`,
      });
    }
  };

  const markTail = (): void => {
    tailBuffered = true;
    resume = null;
  };

  /** Starts the next window when less than the prefetch distance lies ahead of the position. */
  const prefetch = (): void => {
    if (
      active !== null ||
      failed ||
      destroyed ||
      tailBuffered ||
      resume === null ||
      clearing
    ) {
      return;
    }
    const position = currentTime();
    if (!hasVideoAt(position) || resume.end - position > PREFETCH_AHEAD_SECONDS) {
      return;
    }
    const next = resume;
    resume = null;
    startWindow(next.start, next.end, { continues: true });
  };

  /**
   * Serves a seek that waited for the window that ended, when that window stopped before the
   * target, as at its byte limit. The next window starts at once when it starts at or before the
   * target and the target lies within WAIT_AHEAD_SECONDS of its start, and the seek keeps
   * waiting for it. Otherwise the data goes, and a window starts at the target, once for each
   * seek, so a target in a hole of the data does not start windows again and again. The
   * prefetch does not serve such a seek, because no video lies at the position.
   *
   * A window that started at the target and stopped before it skipped the target: the target
   * lies in a stretch with no decodable video, and the next window starts at the keyframe after
   * that stretch. That window starts when the target lies within GAP_LIMIT_SECONDS of the end of
   * the video, so the hole shows (checkGap). Such a seek never starts a window at its target
   * again. A requested seek over a gap replaces the seek, so nothing serves it then.
   */
  const serveWaitingSeek = (): void => {
    const target = waitingTarget;
    if (target === null) {
      return;
    }
    if (hasVideoAt(target)) {
      waitingTarget = null;
      return;
    }
    if (
      active !== null ||
      failed ||
      destroyed ||
      clearing ||
      tailBuffered ||
      gapRequested
    ) {
      return;
    }
    const reach = waitingStarted ? GAP_LIMIT_SECONDS : WAIT_AHEAD_SECONDS;
    if (
      resume !== null &&
      resume.end <= target + EPSILON_SECONDS &&
      target - resume.end <= reach
    ) {
      const next = resume;
      resume = null;
      startWindow(next.start, next.end, { continues: true });
      return;
    }
    waitingTarget = null;
    if (!waitingStarted) {
      restartAt(target);
    }
  };

  const closeSessions = (): void => {
    active?.session.close();
    active = null;
    for (const session of finishedSessions) {
      session.close();
    }
    finishedSessions = [];
  };

  /**
   * Drops the data and the windows, and starts a window at `target`, the target of a seek. The
   * seek then waits for that window.
   */
  const restartAt = (target: number, margin: number = SEEK_MARGIN_SECONDS): void => {
    waitingTarget = target;
    waitingStarted = true;
    gapRequested = false;
    closeSessions();
    // The appends of the stopped window go, and the parser of the SourceBuffer starts again.
    dropOperationsOf(null);
    quotaBlocked = false;
    tailBuffered = false;
    resume = null;
    lastTimeResume = null;
    noProgressAt = null;
    spans = [];
    keyframes = [];
    frames = [];
    framesKnown = true;
    if (sourceBuffer !== null) {
      clearing = true;
      operations.push(
        { kind: "abort" },
        { kind: "remove", start: 0, end: Infinity, clears: true },
      );
    }
    startWindow({ kind: "time", seconds: absoluteSeconds(target) }, target, { margin });
    pump();
  };

  /**
   * True when the running window delivers `target` soon: the target lies ahead of what the
   * window appended, and at most `WAIT_AHEAD_SECONDS` after what it read. A target behind the
   * appended video that has no video lost its data to a remove of the browser.
   */
  const activeWindowCovers = (target: number): boolean => {
    const window = active;
    if (window === null || window.ended) {
      return false;
    }
    const from = window.firstVideoTime ?? window.target;
    if (target < from - EPSILON_SECONDS || target >= from + WINDOW_SECONDS) {
      return false;
    }
    if (window.appendedEnd !== null && target < window.appendedEnd - EPSILON_SECONDS) {
      return false;
    }
    return target - (window.videoEnd ?? from) <= WAIT_AHEAD_SECONDS;
  };

  const onSeeking = (): void => {
    if (destroyed || failed) {
      return;
    }
    gapPosition = null;
    waitingTarget = null;
    unbufferedSeekTarget = null;
    gapRequested = false;
    const target = currentTime();
    seekOrigin = lastPosition;
    lastPosition = target;
    // A full SourceBuffer waits for the position to move, and a seek moves it with no
    // `timeupdate`. The room counts from the new position.
    if (quotaBlocked) {
      quotaBlocked = false;
      makeRoom();
      pump();
    }
    // A target in a hole of the buffered data asks for the seek over it, and the data stays.
    if (checkGap()) {
      return;
    }
    if (hasVideoAt(target)) {
      // A target near the end of the appended video needs the next window, and a paused
      // element that waits there sends no `timeupdate` that would start it. The decoder keeps
      // back the last frames for the reorder of B-frames until more data or the end of the
      // stream comes.
      prefetch();
      return;
    }
    // The running window delivers the target soon, unless its appends wait for room.
    if (!quotaBlocked && activeWindowCovers(target)) {
      waitingTarget = target;
      waitingStarted = false;
      unbufferedSeekTarget = target;
      return;
    }
    // Before the first frame of the file no frame shows. When that frame is buffered, the
    // store seeks over the gap at once, and the data stays.
    if (
      fileFirstFrame !== null &&
      target < fileFirstFrame - EPSILON_SECONDS &&
      hasVideoAt(fileFirstFrame)
    ) {
      events.onGap(fileFirstFrame, target);
      return;
    }
    unbufferedSeekTarget = target;
    restartAt(target);
  };

  const onTimeUpdate = (): void => {
    if (destroyed || failed) {
      return;
    }
    if (!element.seeking) {
      lastPosition = currentTime();
    }
    if (quotaBlocked) {
      quotaBlocked = false;
      makeRoom();
      pump();
    }
    checkProgress();
    if (running === null && operations.length === 0) {
      idle();
    } else {
      // A window needs no empty queue to start: its appends wait behind the others.
      prefetch();
    }
  };

  const onSeeked = (): void => {
    waitingTarget = null;
    seekOrigin = null;
    onTimeUpdate();
  };

  // The element stopped for data, as at the end of a buffered range before a hole.
  const onWaiting = (): void => {
    if (!destroyed && !failed) {
      checkGap();
    }
  };

  const onSourceOpen = (): void => {
    if (destroyed || firstWindowStarted) {
      return;
    }
    try {
      mediaSource.duration = source.durationSeconds;
    } catch {
      // The first append sets a duration from the data.
    }
    startWindow({ kind: "fileStart" }, 0);
  };

  mediaSource.addEventListener("sourceopen", onSourceOpen);
  element.addEventListener("seeking", onSeeking);
  element.addEventListener("timeupdate", onTimeUpdate);
  element.addEventListener("seeked", onSeeked);
  element.addEventListener("waiting", onWaiting);
  element.src = url;

  return {
    destroy: () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      closeSessions();
      operations.length = 0;
      mediaSource.removeEventListener("sourceopen", onSourceOpen);
      element.removeEventListener("seeking", onSeeking);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("waiting", onWaiting);
      sourceBuffer?.removeEventListener("updateend", onUpdateEnd);
      try {
        element.removeAttribute("src");
        element.load();
      } catch {
        // The element is already gone.
      }
      environment.revokeObjectUrl(url);
    },
    frameStarts: () => (framesKnown ? frames : NO_FRAMES),
  };
}
