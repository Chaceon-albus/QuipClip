import { describe, expect, it, vi } from "vitest";
import {
  createMseController,
  mimeTypeFor,
  type MseControllerEvents,
  type MseElementEvent,
  type MseEnvironment,
  type MseMediaSource,
  type MseSource,
  type MseSourceBuffer,
  type MseTimeRanges,
  type MseVideoElement,
} from "./controller";
import { Fmp4Scanner, parseFragments, parseMovie, type Fmp4Track } from "./fmp4";
import {
  box,
  concat,
  fragment,
  fromBase64,
  WINDOW_FTYP,
  WINDOW_MOOV,
} from "./testSupport";
import {
  PreviewWindowError,
  type WindowEnd,
  type WindowListener,
  type WindowOpened,
  type WindowRequest,
  type WindowSession,
} from "./windowClient";

/** The video track of the fixture `moov` counts 16000 ticks each second, the audio 48000. */
const VIDEO_TIMESCALE = 16000;
const AUDIO_TIMESCALE = 48000;
/** One frame at 25 fps, and one AAC frame. */
const FRAME_TICKS = 640;
const AAC_TICKS = 1024;
/** The source starts at 10 s, so media time 0 is 10 s of the source. */
const START = 10;
const MIME = 'video/mp4; codecs="avc1.4d400a,mp4a.40.2"';

const SOURCE: MseSource = {
  path: "/media/live.flv",
  size: 427000000,
  mtime: 1729000000,
  container: "flv",
  formatStartTime: null,
  videoStartSeconds: START,
  durationSeconds: 240,
  audio: "copy",
  audioCodec: "aac",
  pcm: true,
  rescanConfig: false,
};

type Span = [number, number];

function ranges(list: readonly Span[]): MseTimeRanges {
  return {
    length: list.length,
    start: (index) => list[index]?.[0] ?? Number.NaN,
    end: (index) => list[index]?.[1] ?? Number.NaN,
  };
}

function addRange(list: Span[], start: number, end: number): Span[] {
  const all = [...list, [start, end] as Span].sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [];
  for (const span of all) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1] + 1e-6) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

function clip(list: readonly Span[], start: number, end: number): Span[] {
  return list.flatMap(([from, to]): Span[] =>
    to <= start || from >= end
      ? [[from, to]]
      : [
          ...(from < start ? [[from, start] as Span] : []),
          ...(to > end ? [[end, to] as Span] : []),
        ],
  );
}

function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const result: Span[] = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (start < end) {
        result.push([start, end]);
      }
    }
  }
  return result;
}

/**
 * A SourceBuffer that parses what it gets: it keeps the ranges of each track and reports their
 * intersection as `buffered`, as browsers do. A box that does not parse counts as an error.
 */
class FakeSourceBuffer implements MseSourceBuffer {
  updating = false;
  mode: AppendMode = "sequence";
  timestampOffset = 0;
  video: Span[] = [];
  audio: Span[] = [];
  appended: number[] = [];
  removed: Span[] = [];
  aborts = 0;
  errors = 0;
  types: string[] = [];
  quotaErrors = 0;
  log: string[] = [];
  private scanner = new Fmp4Scanner();
  private tracks: Fmp4Track[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly owner: FakeMediaSource) {}

  get buffered(): MseTimeRanges {
    return ranges(
      this.tracks.some((track) => track.kind === "audio")
        ? intersect(this.video, this.audio)
        : this.video,
    );
  }

  appendBuffer(data: Uint8Array<ArrayBuffer>): void {
    if (this.quotaErrors > 0) {
      this.quotaErrors--;
      throw new DOMException("The buffer is full.", "QuotaExceededError");
    }
    this.appended.push(data.byteLength);
    this.log.push(`append ${data.byteLength}`);
    this.reopen();
    try {
      for (const found of this.scanner.push(data)) {
        if (found.type === "moov" && found.bytes !== null) {
          this.tracks = parseMovie(found.bytes);
        } else if (found.type === "moof" && found.bytes !== null) {
          for (const item of parseFragments(found.bytes, this.tracks)) {
            const track = this.tracks.find(
              (candidate) => candidate.id === item.trackId,
            );
            if (track === undefined || item.duration === null) {
              this.errors++;
              continue;
            }
            const start =
              item.presentationTime / track.timescale + this.timestampOffset;
            const end = start + item.duration / track.timescale;
            if (track.kind === "video") {
              this.video = addRange(this.video, start, end);
            } else {
              this.audio = addRange(this.audio, start, end);
            }
          }
        } else if (found.type !== "ftyp" && found.type !== "mdat") {
          this.errors++;
        }
      }
    } catch {
      this.errors++;
      this.scanner = new Fmp4Scanner();
    }
    this.updating = true;
  }

  remove(start: number, end: number): void {
    this.removed.push([start, end]);
    this.log.push(`remove ${start} ${end}`);
    this.reopen();
    this.video = clip(this.video, start, end);
    this.audio = clip(this.audio, start, end);
    this.updating = true;
  }

  abort(): void {
    if (this.owner.readyState !== "open") {
      throw new DOMException("The source is not open.", "InvalidStateError");
    }
    this.aborts++;
    this.log.push("abort");
    this.scanner = new Fmp4Scanner();
  }

  changeType(type: string): void {
    this.types.push(type);
  }

  addEventListener(_type: "updateend", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "updateend", listener: () => void): void {
    this.listeners.delete(listener);
  }

  /** Ends the running operation, as the browser does with `updateend`. */
  finish(): void {
    this.updating = false;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** Ends every queued operation. */
  drain(): void {
    for (let count = 0; this.updating && count < 1000; count++) {
      this.finish();
    }
  }

  private reopen(): void {
    if (this.owner.readyState === "ended") {
      this.owner.readyState = "open";
    }
  }
}

class FakeMediaSource implements MseMediaSource {
  readyState: ReadyState = "closed";
  duration = Number.NaN;
  buffers: FakeSourceBuffer[] = [];
  types: string[] = [];
  ends = 0;
  private listeners = new Set<() => void>();

  addSourceBuffer(type: string): MseSourceBuffer {
    this.types.push(type);
    const buffer = new FakeSourceBuffer(this);
    this.buffers.push(buffer);
    return buffer;
  }

  endOfStream(): void {
    this.ends++;
    this.readyState = "ended";
  }

  addEventListener(_type: "sourceopen", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "sourceopen", listener: () => void): void {
    this.listeners.delete(listener);
  }

  open(): void {
    this.readyState = "open";
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeElement implements MseVideoElement {
  src = "";
  currentTime = 0;
  seeking = false;
  loads = 0;
  private listeners = new Map<MseElementEvent, Set<() => void>>();

  removeAttribute(): void {
    this.src = "";
  }

  load(): void {
    this.loads++;
  }

  addEventListener(type: MseElementEvent, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: MseElementEvent, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: MseElementEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }

  /** A seek of the store. */
  seek(time: number): void {
    this.currentTime = time;
    this.seeking = true;
    this.fire("seeking");
  }

  /** The playback moves to `time`. */
  play(time: number): void {
    this.currentTime = time;
    this.seeking = false;
    this.fire("timeupdate");
  }
}

/** One requested window, with the controls of its fake session. */
interface FakeWindow {
  readonly request: WindowRequest;
  readonly listener: WindowListener;
  readonly acks: number[];
  closed: boolean;
  open: (opened?: Partial<WindowOpened>) => Promise<void>;
  refuse: (error: unknown) => Promise<void>;
  send: (bytes: Uint8Array) => void;
  end: (end?: Partial<WindowEnd>) => void;
}

const END: WindowEnd = {
  status: "complete",
  reachedEnd: false,
  next: null,
  bytesRead: 1000,
  nonMonotonic: false,
  damaged: false,
  detail: null,
};

async function flush(): Promise<void> {
  for (let count = 0; count < 5; count++) {
    await Promise.resolve();
  }
}

function setup(options?: {
  source?: Partial<MseSource>;
  supported?: (type: string) => boolean;
}) {
  const mediaSource = new FakeMediaSource();
  const element = new FakeElement();
  const windows: FakeWindow[] = [];
  const revoked: string[] = [];
  const environment: MseEnvironment = {
    createMediaSource: () => ({ source: mediaSource, url: "blob:preview" }),
    revokeObjectUrl: (url) => revoked.push(url),
    isTypeSupported: options?.supported ?? (() => true),
    openWindow: (request, listener) => {
      let resolve: (opened: WindowOpened) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const opened = new Promise<WindowOpened>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      const record: FakeWindow = {
        request,
        listener,
        acks: [],
        closed: false,
        open: async (values) => {
          resolve({
            windowId: windows.length,
            method: "table",
            nonMonotonic: false,
            firstKeyframePtsMs: null,
            pcmStartSeconds: null,
            seekSeconds: null,
            ...values,
          });
          await flush();
        },
        refuse: async (error) => {
          reject(error);
          await flush();
        },
        send: (bytes) => {
          if (!record.closed) {
            listener.onChunk(new Uint8Array(bytes));
          }
        },
        end: (values) => {
          if (!record.closed) {
            listener.onEnd({ ...END, ...values });
          }
        },
      };
      const session: WindowSession = {
        opened,
        ack: (bytes) => {
          if (!record.closed) {
            record.acks.push(bytes);
          }
        },
        close: () => {
          record.closed = true;
        },
        isClosed: () => record.closed,
      };
      windows.push(record);
      return session;
    },
  };
  const events = {
    onExpectedFirstFrame: vi.fn<MseControllerEvents["onExpectedFirstFrame"]>(),
    onFirstFrameMismatch: vi.fn<MseControllerEvents["onFirstFrameMismatch"]>(),
    onStartGap: vi.fn<MseControllerEvents["onStartGap"]>(),
    onNonMonotonic: vi.fn<MseControllerEvents["onNonMonotonic"]>(),
    onAudioOmitted: vi.fn<MseControllerEvents["onAudioOmitted"]>(),
    onFailure: vi.fn<MseControllerEvents["onFailure"]>(),
    onPcm: vi.fn<NonNullable<MseControllerEvents["onPcm"]>>(),
    onPcmEnd: vi.fn<NonNullable<MseControllerEvents["onPcmEnd"]>>(),
  };
  const controller = createMseController(
    element,
    { ...SOURCE, ...options?.source },
    environment,
    events,
  );
  return {
    mediaSource,
    element,
    windows,
    revoked,
    events,
    controller,
    buffer: () => mediaSource.buffers[0],
    last: () => windows[windows.length - 1],
  };
}

/** The targets of the seeks over a gap, to the microsecond. */
function gapSeeks(events: { onStartGap: { mock: { calls: number[][] } } }): number[] {
  return events.onStartGap.mock.calls.map(
    ([time]) => Math.round((time ?? 0) * 1e6) / 1e6,
  );
}

/** The init segment of a window. */
function init(): Uint8Array {
  return concat(WINDOW_FTYP, fromBase64(WINDOW_MOOV));
}

/**
 * Media that starts at `from` and lasts `seconds`, in fragments of 2 s with a keyframe every
 * `gop` seconds. `audioLag` moves the audio after the video.
 */
function media(
  from: number,
  seconds: number,
  options: {
    gop?: number;
    audioLag?: number;
    audio?: boolean;
    keyframes?: boolean;
  } = {},
): Uint8Array {
  const gop = options.gop ?? 2;
  const parts: Uint8Array[] = [];
  for (let time = from; time < from + seconds - 1e-9; time += 2) {
    const length = Math.min(2, from + seconds - time);
    const frames = Math.round(length * 25);
    const phase = (time / gop) % 1;
    const sync = options.keyframes !== false && (phase < 1e-6 || phase > 1 - 1e-6);
    const audioStart = time + (options.audioLag ?? 0);
    parts.push(
      fragment(
        {
          id: 1,
          decodeTime: Math.round((time + START) * VIDEO_TIMESCALE),
          duration: FRAME_TICKS,
          count: frames,
          sync,
        },
        options.audio === false
          ? undefined
          : {
              id: 2,
              decodeTime: Math.round((audioStart + START) * AUDIO_TIMESCALE),
              duration: AAC_TICKS,
              count: Math.round((length * AUDIO_TIMESCALE) / AAC_TICKS),
            },
      ),
      box("mdat", new Uint8Array(64)),
    );
  }
  return concat(...parts);
}

/** Opens the source and delivers a first window with media from `from` for `seconds`. */
function playing(
  from = 0,
  seconds = 30,
  options?: Parameters<typeof setup>[0],
  mediaOptions?: Parameters<typeof media>[2],
) {
  const harness = setup(options);
  harness.mediaSource.open();
  harness.last().send(concat(init(), media(from, seconds, mediaOptions)));
  harness.buffer().drain();
  return harness;
}

describe("mimeTypeFor", () => {
  const track = { timescale: 1, defaultDuration: 0, defaultFlags: null };

  it("names the video and the audio codec, in that order", () => {
    expect(
      mimeTypeFor([
        { ...track, id: 2, kind: "audio", codec: "mp4a.40.2" },
        { ...track, id: 1, kind: "video", codec: "avc1.64001f" },
      ]),
    ).toBe('video/mp4; codecs="avc1.64001f,mp4a.40.2"');
  });

  it("has no type without a video track or with an unknown codec", () => {
    expect(mimeTypeFor([{ ...track, id: 1, kind: "audio", codec: "opus" }])).toBeNull();
    expect(mimeTypeFor([{ ...track, id: 1, kind: "video", codec: null }])).toBeNull();
  });
});

describe("createMseController", () => {
  describe("the first window", () => {
    it("opens the MediaSource, sets its duration, and requests the start of the file", () => {
      const { element, mediaSource, windows } = setup({
        source: { rescanConfig: true },
      });
      expect(element.src).toBe("blob:preview");
      expect(windows).toHaveLength(0);

      mediaSource.open();
      expect(mediaSource.duration).toBe(240);
      expect(windows[0]?.request).toEqual({
        path: SOURCE.path,
        size: SOURCE.size,
        mtime: SOURCE.mtime,
        lane: "video",
        container: "flv",
        start: { kind: "fileStart" },
        formatStartTime: null,
        audio: "copy",
        audioCodec: "aac",
        pcm: true,
        rescanConfig: false,
      });
    });

    it("scans for configurations before the first window that serves a seek only", () => {
      const { element, windows } = playing(0, 30, { source: { rescanConfig: true } });
      element.seek(100);
      element.seek(200);
      expect(windows.map((window) => window.request.rescanConfig)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("creates the SourceBuffer from the moov and appends what it held", () => {
      const { mediaSource, buffer, last } = setup();
      mediaSource.open();
      const bytes = init();
      last().send(bytes.subarray(0, 10));
      expect(mediaSource.buffers).toHaveLength(0);
      last().send(bytes.subarray(10));

      expect(mediaSource.types).toEqual([MIME]);
      expect(buffer().mode).toBe("segments");
      expect(buffer().timestampOffset).toBe(-START);
      // The held piece goes first, and the second waits for the end of the first.
      expect(buffer().appended).toEqual([10]);
      buffer().finish();
      expect(buffer().appended).toEqual([10, bytes.byteLength - 10]);
      buffer().finish();
      expect(last().acks).toEqual([10, bytes.byteLength - 10]);
      expect(buffer().errors).toBe(0);
    });

    it("reports the media time of the first frame before it appends the fragment", () => {
      const { mediaSource, buffer, last, events } = setup();
      mediaSource.open();
      last().send(init());
      buffer().drain();
      const appended = buffer().appended.length;
      last().send(media(0.08, 2));
      expect(events.onExpectedFirstFrame).toHaveBeenCalledTimes(1);
      expect(events.onExpectedFirstFrame.mock.calls[0]?.[0]).toBeCloseTo(0.08, 9);
      expect(buffer().appended).toHaveLength(appended + 1);
      last().send(media(2.08, 2));
      expect(events.onExpectedFirstFrame).toHaveBeenCalledTimes(1);
    });

    it("reports a first keyframe tag that the first sample does not match", async () => {
      const matching = setup();
      matching.mediaSource.open();
      matching.last().send(concat(init(), media(0.08, 2)));
      await matching.last().open({ firstKeyframePtsMs: 10080 });
      expect(matching.events.onFirstFrameMismatch).not.toHaveBeenCalled();

      const other = setup();
      other.mediaSource.open();
      await other.last().open({ firstKeyframePtsMs: 10120 });
      other.last().send(concat(init(), media(0.08, 2)));
      expect(other.events.onFirstFrameMismatch).toHaveBeenCalledTimes(1);
    });

    it("asks for a seek over a gap before the first frame", () => {
      const { events } = playing(0.08, 30);
      expect(gapSeeks(events)).toEqual([0.08]);
    });

    it("reads the gap from the video, not from the later start of the audio", () => {
      // The audio starts 0.28 s after the video, so `buffered` starts at 0.28 s.
      const { events, buffer } = playing(0, 30, undefined, { audioLag: 0.28 });
      expect(buffer().buffered.start(0)).toBeCloseTo(0.28, 6);
      expect(events.onStartGap).not.toHaveBeenCalled();

      const late = playing(0.08, 30, undefined, { audioLag: 0.28 });
      expect(gapSeeks(late.events)).toEqual([0.08]);
    });
  });

  describe("the codecs", () => {
    it("stops when the web view refuses the video", () => {
      const { mediaSource, last, events } = setup({ supported: () => false });
      mediaSource.open();
      last().send(init());
      expect(events.onFailure).toHaveBeenCalledWith({
        kind: "codecRejected",
        type: MIME,
      });
      expect(last().closed).toBe(true);
    });

    it("transcodes refused audio, and leaves it out when that is refused too", () => {
      const { mediaSource, windows, events } = setup({
        supported: (type) => !type.includes("mp4a"),
      });
      mediaSource.open();
      windows[0]?.send(init());
      expect(windows).toHaveLength(2);
      expect(windows[0]?.closed).toBe(true);
      expect(windows[1]?.request).toMatchObject({
        audio: "transcode",
        start: { kind: "fileStart" },
      });

      windows[1]?.send(init());
      expect(windows).toHaveLength(3);
      expect(windows[2]?.request).toMatchObject({ audio: "omit", pcm: false });
      expect(events.onAudioOmitted).toHaveBeenCalledTimes(1);
    });

    it("leaves the audio out when its transcode fails before any output", () => {
      const { mediaSource, windows, events } = setup({
        source: { audio: "transcode" },
      });
      mediaSource.open();
      windows[0]?.end({ status: "failed", detail: "Decoder not found" });
      expect(windows).toHaveLength(2);
      expect(windows[1]?.request.audio).toBe("omit");
      expect(events.onAudioOmitted).toHaveBeenCalledTimes(1);
      expect(events.onFailure).not.toHaveBeenCalled();
    });

    /** The init segment of a window whose video is H.264 High at level 1.0. */
    function highProfileInit(): Uint8Array {
      const moov = fromBase64(WINDOW_MOOV);
      const avcC = moov.findIndex(
        (_, index) =>
          String.fromCharCode(...moov.subarray(index, index + 4)) === "avcC",
      );
      moov[avcC + 5] = 0x64;
      return concat(WINDOW_FTYP, moov);
    }

    it("changes the type of the SourceBuffer for a window with another profile", () => {
      const { buffer, last, element } = playing();
      element.seek(100);
      last().send(highProfileInit());
      buffer().drain();
      expect(buffer().types).toEqual(['video/mp4; codecs="avc1.64400a,mp4a.40.2"']);
    });

    it("changes the type again after a seek dropped a queued change", () => {
      const { buffer, last, element } = playing();
      element.seek(100);
      // The change waits behind the remove, and the next seek drops it.
      last().send(highProfileInit());
      element.seek(200);
      last().send(highProfileInit());
      buffer().drain();
      expect(buffer().types).toEqual(['video/mp4; codecs="avc1.64400a,mp4a.40.2"']);
    });
  });

  describe("seeks", () => {
    it("does nothing for a target in the delivered video", () => {
      const { element, windows } = playing();
      element.seek(12);
      element.seek(30);
      expect(windows).toHaveLength(1);
    });

    it("waits for the running window when it delivers the target soon", () => {
      const { element, windows } = playing();
      element.seek(35);
      expect(windows).toHaveLength(1);
    });

    it("drops the data and starts a window at a target that no window delivers", () => {
      const { element, windows, buffer } = playing();
      element.seek(100);
      expect(windows).toHaveLength(2);
      expect(windows[0]?.closed).toBe(true);
      expect(windows[1]?.request.start).toEqual({ kind: "time", seconds: 110 });
      expect(buffer().log.slice(-2)).toEqual(["abort", "remove 0 Infinity"]);

      // The output of the stopped window goes nowhere, also when it bypasses the session.
      windows[0]?.listener.onChunk(new Uint8Array(media(30, 2)));
      buffer().drain();
      expect(buffer().log.slice(-1)).toEqual(["remove 0 Infinity"]);
    });

    it("does not read the old data while its remove waits", () => {
      const { element, windows, buffer, last } = playing();
      // An append runs, so the remove of the next seek waits behind it.
      last().send(media(30, 2));
      element.seek(100);
      expect(buffer().updating).toBe(true);
      element.seek(12);
      expect(windows).toHaveLength(3);
    });

    it("waits for the window of a seek when the next seek lands just after its target", () => {
      const { element, windows } = playing();
      element.seek(100);
      element.seek(104);
      expect(windows).toHaveLength(2);
      element.seek(99);
      expect(windows).toHaveLength(3);
    });

    it("asks for the gap seek at once for a target before the first keyframe of the file", () => {
      const { element, windows, events } = playing(0.08, 30);
      events.onStartGap.mockClear();
      element.play(20);
      element.seek(0);
      expect(windows).toHaveLength(1);
      expect(gapSeeks(events)).toEqual([0.08]);
    });

    it("waits over the gap when the data before the first keyframe was dropped", () => {
      const { element, windows, events, last, buffer } = playing(0.08, 30);
      events.onStartGap.mockClear();
      element.seek(150);
      element.seek(0);
      expect(windows).toHaveLength(3);
      last().send(concat(init(), media(0.08, 30)));
      buffer().drain();
      expect(gapSeeks(events)).toEqual([0.08]);
    });

    it("does not abort a source that has ended", () => {
      const { element, buffer, mediaSource } = playing();
      mediaSource.readyState = "ended";
      element.seek(100);
      buffer().drain();
      expect(buffer().aborts).toBe(0);
      expect(buffer().log.slice(-1)).toEqual(["remove 0 Infinity"]);
    });
  });

  describe("the following windows", () => {
    it("prefetches when less than 30 s of video lies ahead, also with late audio", () => {
      const { buffer, last, windows, element } = playing(0, 60, undefined, {
        audioLag: 0.02,
      });
      last().end({ next: { offset: 900000, ptsMs: 70000 } });
      buffer().drain();
      expect(windows).toHaveLength(1);
      element.play(29);
      buffer().drain();
      expect(windows).toHaveLength(1);
      element.play(31);
      expect(windows[1]?.request.start).toEqual({
        kind: "resume",
        offset: 900000,
        ptsMs: 70000,
      });
    });

    it("goes on by time when the window ended without a resume point, and never in a loop", () => {
      const { buffer, last, windows, element, events } = playing(0, 60);
      last().end({ next: null });
      buffer().drain();
      element.play(40);
      const start = windows[1]?.request.start;
      expect(start?.kind === "time" ? start.seconds : 0).toBeCloseTo(68, 6);

      // The next window delivers the same last fragment again, so the chain stops and the
      // preview hears of it.
      last().send(concat(init(), media(58, 2)));
      buffer().drain();
      last().end({ next: null });
      buffer().drain();
      element.play(50);
      expect(windows).toHaveLength(2);
      // The video up to the place where the windows end still plays.
      expect(events.onFailure).not.toHaveBeenCalled();
      element.play(60);
      expect(events.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "windowFailed", code: "noProgress" }),
      );
    });

    it("fails where the playback stops when the audio ends before the video", () => {
      // The buffered range is the intersection of the tracks, so it ends 0.5 s before the
      // video, and the element stops there.
      const lead = { audioLag: -0.5 };
      const { buffer, last, element, events } = playing(0, 60, undefined, lead);
      last().end({ next: null });
      buffer().drain();
      element.play(40);
      last().send(concat(init(), media(58, 2, lead)));
      buffer().drain();
      last().end({ next: null });
      buffer().drain();
      element.play(59.2);
      expect(events.onFailure).not.toHaveBeenCalled();
      // A remove behind the position runs, and the range can still grow while operations wait.
      element.play(59.3);
      expect(events.onFailure).not.toHaveBeenCalled();
      // The queue checks again when it is empty.
      buffer().drain();
      expect(events.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "windowFailed", code: "noProgress" }),
      );
    });

    it("ends the stream after the last window, and again after each change", () => {
      const { mediaSource, buffer, last, element, windows } = playing(0, 50);
      last().end({ reachedEnd: true });
      buffer().drain();
      expect(mediaSource.ends).toBe(1);
      expect(mediaSource.readyState).toBe("ended");

      // A remove behind the position sets the source open again.
      element.play(45);
      expect(buffer().removed[buffer().removed.length - 1]).toEqual([0, 24]);
      expect(mediaSource.readyState).toBe("open");
      buffer().finish();
      expect(mediaSource.ends).toBe(2);
      expect(windows).toHaveLength(1);
    });

    it("tries the end of the stream once per change", () => {
      const { mediaSource, buffer, last } = playing(0, 50);
      mediaSource.endOfStream = () => {
        mediaSource.ends++;
        throw new DOMException("busy", "InvalidStateError");
      };
      last().end({ reachedEnd: true });
      buffer().drain();
      expect(mediaSource.ends).toBe(1);
    });

    it("removes the data more than 20 s behind the position up to a keyframe", () => {
      const { buffer, element } = playing(0, 80, undefined, { gop: 10 });
      element.play(55);
      expect(buffer().removed).toEqual([[0, 30]]);
    });

    it("keeps the GOP that holds the position when the SourceBuffer is full", () => {
      const { buffer, last, element } = playing(0, 30, undefined, { gop: 4 });
      element.play(15);
      buffer().quotaErrors = 1;
      last().send(media(30, 2));
      // The keyframe at or before 13 s is the one at 12 s.
      expect(buffer().removed).toEqual([[0, 12]]);
      buffer().drain();
      expect(buffer().video[buffer().video.length - 1]?.[1]).toBeCloseTo(32, 6);
    });

    it("makes room when the position moves past a keyframe", () => {
      const { buffer, last, element } = playing(0, 30, undefined, { gop: 10 });
      element.play(5);
      buffer().quotaErrors = 1;
      last().send(media(30, 2, { gop: 10 }));
      expect(buffer().removed).toEqual([]);
      element.play(15);
      expect(buffer().removed).toEqual([[0, 10]]);
      buffer().drain();
      expect(buffer().video[buffer().video.length - 1]?.[1]).toBeCloseTo(32, 6);
    });

    it("makes room from the target of a seek", () => {
      const { buffer, last, element } = playing(0, 30, undefined, { gop: 10 });
      element.play(5);
      buffer().quotaErrors = 1;
      last().send(media(30, 2, { gop: 10 }));
      element.seek(25);
      expect(buffer().removed).toEqual([[0, 20]]);
    });

    it("starts a window at a seek target whose data waits for room", () => {
      const { buffer, last, element, windows } = playing(0, 30, undefined, { gop: 30 });
      element.play(10);
      buffer().quotaErrors = 1;
      last().send(media(30, 2, { gop: 30 }));
      element.seek(31);
      expect(windows).toHaveLength(2);
      expect(buffer().log).toContain("remove 0 Infinity");
    });

    it("drops the data 30 s behind the position when it knows no keyframe", () => {
      const { buffer, last, element } = playing(0, 60, undefined, { keyframes: false });
      element.play(45);
      buffer().quotaErrors = 1;
      last().send(media(60, 2, { keyframes: false }));
      expect(buffer().removed).toEqual([[0, 15]]);
    });

    it("forgets the video up to the keyframe where the browser removed it", () => {
      const { buffer, last, element, windows } = playing(0, 30);
      element.play(25);
      // The browser removed the GOPs up to the keyframe at 12 s.
      buffer().video = buffer().video.map(([, end]) => [12, end]);
      buffer().audio = buffer().audio.map(([, end]) => [12, end]);
      last().send(media(30, 2));
      buffer().drain();
      element.seek(11.5);
      expect(windows).toHaveLength(2);
    });

    it("keeps at most 1 s before a range when it knows no keyframe", () => {
      const { buffer, last, element, windows } = playing(0, 30, undefined, {
        keyframes: false,
      });
      element.play(25);
      // The browser removed the data up to a keyframe that the fragments do not mark.
      buffer().video = buffer().video.map(([, end]) => [12.3, end]);
      buffer().audio = buffer().audio.map(([, end]) => [12.3, end]);
      last().send(media(30, 2, { keyframes: false }));
      buffer().drain();
      element.seek(11);
      expect(windows).toHaveLength(2);
    });

    it("counts the span of a moof only when its mdat is appended", () => {
      const { mediaSource, buffer, last, events } = setup();
      mediaSource.open();
      const moof = fragment(
        {
          id: 1,
          decodeTime: Math.round(10.08 * VIDEO_TIMESCALE),
          duration: FRAME_TICKS,
          count: 50,
        },
        {
          id: 2,
          decodeTime: Math.round(10.08 * AUDIO_TIMESCALE),
          duration: AAC_TICKS,
          count: 94,
        },
      );
      last().send(concat(init(), moof));
      buffer().drain();
      expect(events.onStartGap).not.toHaveBeenCalled();
      last().send(box("mdat", new Uint8Array(64)));
      buffer().drain();
      expect(gapSeeks(events)).toEqual([0.08]);
    });

    it("drops the fragment of a window that a seek stopped between its moof and its mdat", () => {
      const { last, element, windows, buffer } = playing(0, 30);
      const old = last();
      old.send(
        fragment({
          id: 1,
          decodeTime: Math.round(40 * VIDEO_TIMESCALE),
          duration: FRAME_TICKS,
          count: 50,
        }),
      );
      element.seek(100);
      old.listener.onChunk(new Uint8Array(box("mdat", new Uint8Array(64))));
      buffer().drain();
      element.seek(41);
      expect(windows).toHaveLength(3);
    });

    it("forgets the data that the browser removed on its own", () => {
      const { buffer, last, element, windows } = playing(0, 30);
      element.play(25);
      // Chromium frees the data behind the position during an append.
      buffer().video = buffer().video.map(([, end]) => [12, end]);
      buffer().audio = buffer().audio.map(([, end]) => [12, end]);
      last().send(media(30, 2));
      buffer().drain();
      element.seek(5);
      expect(windows).toHaveLength(2);
      expect(windows[1]?.request.start).toEqual({ kind: "time", seconds: 15 });
    });

    it("waits for the position when no keyframe lies behind it", () => {
      // One GOP of 30 s: no remove can keep the frame on screen.
      const { buffer, last, element } = playing(0, 30, undefined, { gop: 30 });
      element.play(10);
      buffer().quotaErrors = 1;
      const count = buffer().appended.length;
      last().send(media(30, 2, { gop: 30 }));
      expect(buffer().appended).toHaveLength(count);
      expect(buffer().removed).toEqual([]);
    });
  });

  describe("MPEG-TS and Matroska", () => {
    const tsSource = {
      container: "mpegTs" as const,
      formatStartTime: { n: 9, d: 1 },
      pcm: false,
    };

    it("doubles the margin when the window starts after its target", async () => {
      const { last, windows, element } = playing(0, 30, { source: tsSource });
      element.seek(100);
      expect(windows[1]?.request).toMatchObject({
        container: "mpegTs",
        start: { kind: "time", seconds: 110 },
        formatStartTime: { n: 9, d: 1 },
        pcm: false,
      });
      expect(windows[1]?.request.marginSeconds).toBeUndefined();
      await last().open({ seekSeconds: 96 });
      last().send(concat(init(), media(100.5, 2)));
      expect(windows).toHaveLength(3);
      expect(windows[2]?.request.marginSeconds).toBe(10);
    });

    it("waits over the gap when the input seek reads from the file start", () => {
      const { windows, element, events, last, buffer } = playing(0.5, 30, {
        source: tsSource,
      });
      expect(gapSeeks(events)).toEqual([0.5]);
      element.seek(150);
      element.seek(0.3);
      last().send(concat(init(), media(0.5, 30)));
      buffer().drain();
      expect(windows).toHaveLength(3);
      expect(events.onStartGap).toHaveBeenCalledTimes(2);
    });

    it("keeps the data when the next window starts after its target, and resets the parser", () => {
      const { buffer, last, windows, element } = playing(0, 64, {
        source: { container: "matroska" },
      });
      last().end();
      buffer().drain();
      element.play(40);
      expect(windows[1]?.request.start).toEqual({ kind: "time", seconds: 74 });
      // The init and the first half of the moof arrive before the rest of the moof.
      const late = concat(init(), media(66, 2));
      last().send(late.subarray(0, init().byteLength + 40));
      buffer().drain();
      last().send(late.subarray(init().byteLength + 40));
      expect(windows).toHaveLength(3);
      expect(windows[2]?.request).toMatchObject({
        start: { kind: "time", seconds: 74 },
        marginSeconds: 10,
      });
      expect(windows[1]?.closed).toBe(true);
      expect(buffer().log.slice(-1)).toEqual(["abort"]);
      last().send(concat(init(), media(62, 4)));
      buffer().drain();
      expect(buffer().errors).toBe(0);
      expect(buffer().log).not.toContain("remove 0 Infinity");
    });

    it("widens the margin of a window without a frame, and stops at the limit", async () => {
      const { buffer, last, events, element, windows } = playing(0, 30, {
        source: { container: "matroska" },
      });
      element.seek(230);
      for (const margin of [undefined, 10, 20, 40]) {
        expect(last().request.marginSeconds).toBe(margin);
        await last().open({ seekSeconds: 220 });
        last().send(init());
        buffer().drain();
        last().end();
        buffer().drain();
      }
      expect(windows).toHaveLength(6);
      expect(last().request.marginSeconds).toBe(60);
      await last().open({ seekSeconds: 170 });
      last().end();
      expect(events.onFailure).toHaveBeenCalledWith({
        kind: "windowFailed",
        code: "noFrames",
        detail: null,
      });
    });

    it("widens the margin of a continuing window without a frame, and keeps the data", async () => {
      const { buffer, last, windows, element } = playing(0, 64, {
        source: { container: "matroska" },
      });
      last().end();
      buffer().drain();
      element.play(40);
      expect(windows).toHaveLength(2);
      await last().open({ seekSeconds: 69 });
      last().send(init());
      buffer().drain();
      last().end();
      buffer().drain();
      expect(windows).toHaveLength(3);
      expect(windows[2]?.request).toMatchObject({ marginSeconds: 10 });
      expect(buffer().log).not.toContain("remove 0 Infinity");
    });

    it("stops when the largest margin still lands after the target", () => {
      const { last, events, element } = playing(0, 30, {
        source: { container: "matroska" },
      });
      element.seek(100);
      for (const margin of [10, 20, 40, 60]) {
        last().send(concat(init(), media(101, 2)));
        expect(last().request.marginSeconds).toBe(margin);
      }
      last().send(concat(init(), media(101, 2)));
      expect(events.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "windowFailed", code: "seekMissed" }),
      );
    });

    it("ends the stream when a window ends early near the end of the file", async () => {
      const { mediaSource, buffer, last } = setup({
        source: { container: "matroska", durationSeconds: 42 },
      });
      mediaSource.open();
      await last().open({ seekSeconds: null });
      last().send(concat(init(), media(0, 42)));
      buffer().drain();
      last().end();
      buffer().drain();
      expect(mediaSource.ends).toBe(1);
    });

    it("goes on after an early end in the middle of the file", async () => {
      const { mediaSource, buffer, last, windows, element } = setup({
        source: { container: "matroska" },
      });
      mediaSource.open();
      await last().open({ seekSeconds: null });
      last().send(concat(init(), media(0, 42)));
      buffer().drain();
      last().end();
      buffer().drain();
      expect(mediaSource.ends).toBe(0);
      element.play(20);
      expect(windows[1]?.request.start).toEqual({ kind: "time", seconds: 52 });
    });
  });

  describe("failures", () => {
    it("reports a missing FFmpeg", async () => {
      const { mediaSource, last, events } = setup();
      mediaSource.open();
      await last().refuse(new PreviewWindowError("ffmpegNotFound"));
      expect(events.onFailure).toHaveBeenCalledWith({ kind: "ffmpegMissing" });
    });

    it("ignores a request that a newer one superseded", async () => {
      const { mediaSource, last, events } = setup();
      mediaSource.open();
      await last().refuse(new PreviewWindowError("superseded"));
      expect(events.onFailure).not.toHaveBeenCalled();
    });

    it("reports a refused request and a failed window", async () => {
      const refused = setup();
      refused.mediaSource.open();
      await refused.last().refuse(new PreviewWindowError("readFailed", "timed out"));
      expect(refused.events.onFailure).toHaveBeenCalledWith({
        kind: "windowFailed",
        code: "readFailed",
        detail: "timed out",
      });

      const failed = playing();
      failed.last().end({ status: "failed", detail: "Invalid data" });
      failed.buffer().drain();
      expect(failed.events.onFailure).toHaveBeenCalledWith({
        kind: "windowFailed",
        code: "ffmpegFailed",
        detail: "Invalid data",
      });
    });

    it("reports damaged fMP4", () => {
      const { mediaSource, last, events } = setup();
      mediaSource.open();
      last().send(new Uint8Array([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x76]));
      expect(events.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "windowFailed", code: "invalidResponse" }),
      );
    });

    it("stops its window without a report when an append fails, which the element reports", () => {
      const { buffer, last, events } = playing();
      buffer().appendBuffer = () => {
        throw new DOMException("The source buffer was removed.", "InvalidStateError");
      };
      last().send(media(30, 2));
      expect(last().closed).toBe(true);
      expect(events.onFailure).not.toHaveBeenCalled();
    });

    it("reports timestamps that decrease once", async () => {
      const { last, events, buffer } = playing();
      await last().open({ nonMonotonic: true });
      expect(events.onNonMonotonic).toHaveBeenCalledTimes(1);
      last().end({ nonMonotonic: true, next: { offset: 5, ptsMs: 1 } });
      buffer().drain();
      expect(events.onNonMonotonic).toHaveBeenCalledTimes(1);
    });
  });

  describe("the PCM of FLV windows", () => {
    it("holds the PCM until the window names its start, and keeps it after the fMP4 ends", async () => {
      const { mediaSource, last, events, buffer } = setup();
      mediaSource.open();
      const window = last();
      window.listener.onPcmChunk?.(new Uint8Array([1, 2]));
      expect(events.onPcm).not.toHaveBeenCalled();
      await window.open({ pcmStartSeconds: 10.04 });
      expect(events.onPcm).toHaveBeenCalledWith(1, 10.04, new Uint8Array([1, 2]));

      window.send(concat(init(), media(0, 30)));
      buffer().drain();
      window.end({ next: { offset: 5, ptsMs: 1 } });
      buffer().drain();
      window.listener.onPcmChunk?.(new Uint8Array([3]));
      expect(events.onPcm).toHaveBeenCalledTimes(2);
    });

    it("passes the end of the PCM on and closes the finished window", async () => {
      const harness = playing();
      await harness.last().open({ pcmStartSeconds: 10 });
      harness.last().end({ next: { offset: 5, ptsMs: 1 } });
      harness.buffer().drain();
      const end = { ...END, status: "failed" as const, detail: "Decoder not found" };
      harness.windows[0]?.listener.onPcmEnd?.(end);
      expect(harness.events.onPcmEnd).toHaveBeenCalledWith(end);
      expect(harness.windows[0]?.closed).toBe(true);
    });

    it("keeps the video window when its PCM ends first", async () => {
      const { mediaSource, last, buffer, windows, element, events } = setup();
      mediaSource.open();
      const window = last();
      await window.open({ pcmStartSeconds: 10 });
      // The PCM process failed to start, before the remux wrote anything.
      window.listener.onPcmEnd?.({ ...END, status: "failed", detail: "spawn" });
      expect(events.onPcmEnd).toHaveBeenCalledTimes(1);
      expect(window.closed).toBe(false);
      window.send(concat(init(), media(0, 60)));
      buffer().drain();
      window.end({ next: { offset: 5, ptsMs: 70000 } });
      buffer().drain();
      // The window ended with its PCM already ended, so its session closed.
      expect(window.closed).toBe(true);
      element.play(31);
      expect(windows).toHaveLength(2);
    });

    it("closes the PCM of the windows before a seek, and on destroy", async () => {
      const harness = playing();
      await harness.last().open({ pcmStartSeconds: 10 });
      harness.last().end({ next: { offset: 5, ptsMs: 1 } });
      harness.buffer().drain();
      const finished = harness.windows[0];
      harness.element.seek(100);
      expect(finished?.closed).toBe(true);
      finished?.listener.onPcmChunk?.(new Uint8Array([3]));
      expect(harness.events.onPcm).not.toHaveBeenCalled();

      const other = playing();
      other.last().end({ next: { offset: 5, ptsMs: 1 } });
      other.buffer().drain();
      other.controller.destroy();
      expect(other.windows[0]?.closed).toBe(true);
    });
  });

  it("stops its window and detaches the MediaSource when destroyed", () => {
    const { mediaSource, element, last, revoked, controller } = setup();
    mediaSource.open();
    controller.destroy();
    expect(last().closed).toBe(true);
    expect(element.src).toBe("");
    expect(element.loads).toBe(1);
    expect(element.listenerCount()).toBe(0);
    expect(revoked).toEqual(["blob:preview"]);
    controller.destroy();
    expect(revoked).toHaveLength(1);
  });
});
