import { describe, expect, it, vi } from "vitest";
import type { AudioStreamOverride } from "@/features/media/audioStream";
import type { ImportMediaResult } from "@/features/media/types";
import { BACKEND_COMMANDS, type InvokeFn } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import {
  startWaveform,
  type WaveformChannel,
  type WaveformHandlers,
  type WaveformJob,
} from "./client";
import {
  buildWaveformRequest,
  createWaveformController,
  waveformProgressFraction,
} from "./controller";
import { createWaveformDataRegistry } from "./data";
import { createWaveformStore, selectWaveformSource } from "./store";
import { chunkBytes } from "./testSupport";
import {
  NO_WAVEFORM_FLAGS,
  WaveformError,
  type WaveformEnd,
  type WaveformRequest,
  type WaveformStarted,
} from "./types";

function media(overrides: Partial<ImportMediaResult["probe"]> = {}): ImportMediaResult {
  return {
    path: "/media/live.flv",
    fileName: "live.flv",
    size: 1000,
    mtime: 1729000000,
    probe: {
      formatNames: ["flv"],
      formatLongName: null,
      videoCodec: "h264",
      videoProfile: null,
      pixelFormat: null,
      bitDepth: null,
      width: 1920,
      height: 1080,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "1400" as Pts,
      videoDurationTicks: null,
      approximateDurationSeconds: 100,
      avgFrameRate: null,
      rFrameRate: null,
      reportedFrameCount: null,
      sampleAspectRatio: null,
      rotation: 0,
      videoEndPts: null,
      audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
      ...overrides,
    },
  };
}

function end(overrides: Partial<WaveformEnd> = {}): WaveformEnd {
  return {
    status: "complete",
    code: null,
    detail: null,
    bucketCount: 2,
    cached: false,
    flags: NO_WAVEFORM_FLAGS,
    ...overrides,
  };
}

interface FakeJob {
  readonly request: WaveformRequest;
  readonly handlers: WaveformHandlers;
  readonly job: WaveformJob;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  resolve: (started: WaveformStarted) => void;
  reject: (error: unknown) => void;
}

function setup(
  sources: Record<string, ImportMediaResult> = { s1: media(), s2: media() },
  overrides: Record<string, AudioStreamOverride> = {},
) {
  const jobs: FakeJob[] = [];
  const start = vi.fn((request: WaveformRequest, handlers: WaveformHandlers) => {
    let resolve!: (started: WaveformStarted) => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<WaveformStarted>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const cancel = vi.fn();
    const close = vi.fn();
    const job: WaveformJob = { started, cancel, close, isClosed: () => false };
    jobs.push({ request, handlers, job, cancel, close, resolve, reject });
    return job;
  });
  const store = createWaveformStore({ now: () => 0 });
  const data = createWaveformDataRegistry();
  const controller = createWaveformController({
    start,
    mediaStore: { getState: () => ({ sources }) },
    data,
    store,
    audioOverrides: () => overrides,
  });
  const job = (index: number): FakeJob => {
    const found = jobs[index];
    if (found === undefined) {
      throw new Error(`no job ${index}`);
    }
    return found;
  };
  return {
    controller,
    store,
    data,
    start,
    job,
    source: (id = "s1") => selectWaveformSource(store.getState(), id),
  };
}

function chunk(startBucket: number, pairs: number[]) {
  return { startBucket, count: pairs.length / 2, pairs: new Uint8Array(pairs) };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("buildWaveformRequest", () => {
  it("reads the values of the import result", () => {
    expect(buildWaveformRequest(media())).toEqual({
      path: "/media/live.flv",
      size: 1000,
      mtime: 1729000000,
      audioStreamIndex: 1,
      videoStartPts: "1400",
      videoTimeBase: { n: 1, d: 1000 },
      durationSeconds: 100,
    });
  });

  it("refuses a source with no audio or no start PTS", () => {
    expect(buildWaveformRequest(media({ audio: null }))).toBeNull();
    expect(buildWaveformRequest(media({ videoStartPts: null }))).toBeNull();
  });
});

describe("waveformProgressFraction", () => {
  it("prefers the bytes, which follow an FLV that jumps or starts again", () => {
    expect(
      waveformProgressFraction(
        { highWater: 5000, bytesRead: 1, totalBytes: 1000 },
        100,
      ),
    ).toBe(0.001);
    expect(
      waveformProgressFraction(
        { highWater: 99999, bytesRead: null, totalBytes: null },
        100,
      ),
    ).toBe(1);
  });

  it("uses the bytes without a duration, and null without either", () => {
    expect(
      waveformProgressFraction(
        { highWater: 5, bytesRead: 250, totalBytes: 1000 },
        null,
      ),
    ).toBe(0.25);
    expect(
      waveformProgressFraction({ highWater: 5, bytesRead: 250, totalBytes: 0 }, 0),
    ).toBeNull();
    expect(
      waveformProgressFraction(
        { highWater: 5, bytesRead: null, totalBytes: null },
        null,
      ),
    ).toBeNull();
  });
});

describe("createWaveformController", () => {
  it("shows an envelope: data, progress, the cache flag, and the ready end", async () => {
    const { controller, store, data, job, source } = setup();
    expect(controller.show("s1")).toBe(true);
    expect(job(0).request.audioStreamIndex).toBe(1);
    expect(source().phase).toBe("running");
    expect(store.getState().runningSourceId).toBe("s1");

    job(0).handlers.onChunk(chunk(0, [200, 100, 150, 50]));
    expect(data.get("s1")?.length).toBe(2);
    job(0).handlers.onProgress({ highWater: 2500, bytesRead: null, totalBytes: null });
    expect(source().progress).toBe(0.25);
    job(0).resolve({ jobId: 1, cached: false, bucketRate: 100 });
    await flush();
    expect(source().cached).toBe(false);

    const flags = { ...NO_WAVEFORM_FLAGS, damaged: true };
    job(0).handlers.onEnd(end({ flags }));
    expect(source()).toMatchObject({ phase: "ready", flags });
    expect(store.getState().runningSourceId).toBeNull();
    expect(data.get("s1")?.peakAt(0)).toBe(200);
  });

  it("refuses a show while another source runs, and for a source it cannot read", () => {
    const { controller, start } = setup({
      s1: media(),
      s2: media(),
      s3: media({ audio: null }),
    });
    expect(controller.show("missing")).toBe(false);
    expect(controller.show("s3")).toBe(false);
    expect(controller.show("s1")).toBe(true);
    expect(controller.show("s2")).toBe(false);
    expect(controller.show("s1")).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("refuses a show of a source that already shows", () => {
    const { controller, job, start } = setup();
    controller.show("s1");
    job(0).handlers.onEnd(end());
    expect(controller.show("s1")).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("cancels a job and drops its data at the canceled end", () => {
    const { controller, store, data, job, source } = setup();
    controller.show("s1");
    job(0).handlers.onChunk(chunk(0, [1, 1]));
    controller.cancel("s1");
    controller.cancel("s1");
    expect(job(0).cancel).toHaveBeenCalledTimes(1);
    // The job holds the slot until its end.
    expect(source().phase).toBe("running");
    job(0).handlers.onEnd(end({ status: "canceled" }));
    expect(source().phase).toBe("idle");
    expect(store.getState().sources).toEqual({});
    expect(store.getState().runningSourceId).toBeNull();
    expect(data.get("s1")).toBeUndefined();
  });

  it("drops the data of a cache hit that the user canceled", () => {
    const { controller, store, data, job, source } = setup();
    controller.show("s1");
    job(0).handlers.onChunk(chunk(0, [1, 1]));
    controller.cancel("s1");
    // A cache hit cannot stop in Rust, so it ends complete.
    job(0).handlers.onEnd(end({ status: "complete", cached: true }));
    expect(source().phase).toBe("idle");
    expect(store.getState().runningSourceId).toBeNull();
    expect(data.get("s1")).toBeUndefined();
  });

  it("drops the data and keeps the error of a failed end", () => {
    const { controller, data, job, source } = setup();
    controller.show("s1");
    job(0).handlers.onChunk(chunk(0, [1, 1]));
    job(0).handlers.onEnd(
      end({ status: "failed", code: "decodeFailed", detail: "bad" }),
    );
    expect(source()).toMatchObject({
      phase: "failed",
      errorCode: "decodeFailed",
      errorDetail: "bad",
    });
    expect(data.get("s1")).toBeUndefined();
  });

  it("fails with the code of a refused start", async () => {
    const { controller, job, source, store } = setup();
    controller.show("s1");
    job(0).reject(new WaveformError("busy"));
    await flush();
    expect(source()).toMatchObject({ phase: "failed", errorCode: "busy" });
    expect(store.getState().runningSourceId).toBeNull();
    expect(job(0).close).toHaveBeenCalled();
  });

  it("returns to idle when a cancel raced a refused start", async () => {
    const { controller, job, source } = setup();
    controller.show("s1");
    controller.cancel("s1");
    job(0).reject(new WaveformError("superseded"));
    await flush();
    expect(source().phase).toBe("idle");
  });

  it("ignores a stale end and stale data of an older job", async () => {
    const { controller, data, job, source } = setup();
    controller.show("s1");
    job(0).reject(new WaveformError("busy"));
    await flush();
    expect(controller.show("s1")).toBe(true);
    job(1).handlers.onChunk(chunk(0, [9, 9]));

    job(0).handlers.onChunk(chunk(0, [200, 200]));
    job(0).handlers.onProgress({ highWater: 9000, bytesRead: null, totalBytes: null });
    job(0).handlers.onEnd(end({ status: "failed", code: "readFailed" }));
    expect(source()).toMatchObject({ phase: "running", progress: null });
    expect(data.get("s1")?.peakAt(0)).toBe(9);

    job(1).handlers.onEnd(end({ cached: true }));
    expect(source()).toMatchObject({ phase: "ready", cached: true });
    // A second end of the same job is stale too.
    job(1).handlers.onEnd(end({ status: "failed", code: "readFailed" }));
    expect(source().phase).toBe("ready");
  });

  it("hides an envelope and shows it again", () => {
    const { controller, data, job, source, start } = setup();
    controller.show("s1");
    job(0).handlers.onChunk(chunk(0, [5, 5]));
    job(0).handlers.onEnd(end());
    controller.hide("s1");
    expect(source().phase).toBe("idle");
    expect(data.get("s1")).toBeUndefined();
    expect(controller.show("s1")).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not hide a source while its job runs", () => {
    const { controller, data, source } = setup();
    controller.show("s1");
    controller.hide("s1");
    expect(source().phase).toBe("running");
    expect(data.get("s1")).toBeDefined();
  });

  it("closes the job of an end that came during the start call", () => {
    const store = createWaveformStore();
    const close = vi.fn();
    const controller = createWaveformController({
      start: (_request, handlers) => {
        handlers.onEnd(end({ cached: true }));
        return {
          started: Promise.reject(new WaveformError("closed")),
          cancel: vi.fn(),
          close,
          isClosed: () => false,
        };
      },
      mediaStore: { getState: () => ({ sources: { s1: media() } }) },
      data: createWaveformDataRegistry(),
      store,
    });
    expect(controller.show("s1")).toBe(true);
    expect(selectWaveformSource(store.getState(), "s1").phase).toBe("ready");
    expect(close).toHaveBeenCalled();
  });

  it("dismisses the notice", () => {
    const { controller, source } = setup();
    controller.show("s1");
    controller.dismissNotice("s1");
    expect(source().noticeDismissed).toBe(true);
  });

  describe("the effective audio stream (ADR 070)", () => {
    const second: AudioStreamOverride = {
      index: 2,
      codec: "opus",
      sampleRate: 48000,
      channels: 1,
    };

    it("names the effective stream in the request", () => {
      const mkv = media({ formatNames: ["matroska", "webm"] });
      expect(buildWaveformRequest(mkv)?.audioStreamIndex).toBe(1);
      expect(buildWaveformRequest(mkv, second)?.audioStreamIndex).toBe(2);
      // A source with no audio has no override and no request.
      expect(
        buildWaveformRequest(
          media({ audio: null, formatNames: ["matroska"] }),
          undefined,
        ),
      ).toBeNull();

      const overrides: Record<string, AudioStreamOverride> = { s1: second };
      const { controller, job } = setup({ s1: mkv, s2: mkv }, overrides);
      controller.show("s1");
      expect(job(0).request.audioStreamIndex).toBe(2);
    });

    it("keeps the one audio stream of an FLV, whatever override it is given", () => {
      // The fixture is an FLV: its readers map its audio as 0:a:0 (ADR 070).
      expect(buildWaveformRequest(media(), second)?.audioStreamIndex).toBe(1);
      const { controller, job } = setup(undefined, { s1: second });
      controller.show("s1");
      expect(job(0).request.audioStreamIndex).toBe(1);
    });

    /**
     * A controller on the real client, with `start_waveform` answered by hand, so the slot of
     * Rust, the job id and the cancel command show as they do in the application.
     */
    function setupWithClient() {
      const starts: ((reply: unknown) => void)[] = [];
      const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
      const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === BACKEND_COMMANDS.START_WAVEFORM) {
          return new Promise<unknown>((resolve) => {
            starts.push(resolve);
          });
        }
        return Promise.resolve(undefined);
      }) as unknown as InvokeFn;
      const channels: WaveformChannel[] = [];
      const store = createWaveformStore({ now: () => 0 });
      const data = createWaveformDataRegistry();
      const controller = createWaveformController({
        start: (request, handlers) =>
          startWaveform(request, handlers, {
            invoke,
            createChannel: () => {
              const channel: WaveformChannel = { onmessage: () => undefined };
              channels.push(channel);
              return channel;
            },
          }),
        mediaStore: { getState: () => ({ sources: { s1: media(), s2: media() } }) },
        data,
        store,
        audioOverrides: () => ({}),
      });
      const cancels = () =>
        calls
          .filter((call) => call.cmd === BACKEND_COMMANDS.CANCEL_WAVEFORM)
          .map((call) => call.args?.jobId);
      const reply = (index: number, jobId: number) => {
        starts[index]?.({ jobId, cached: false, bucketRate: 100 });
      };
      const message = (index: number, raw: unknown) => {
        channels[index]?.onmessage(raw);
      };
      return {
        controller,
        store,
        data,
        cancels,
        reply,
        message,
        source: (id = "s1") => selectWaveformSource(store.getState(), id),
      };
    }

    const CANCELED_END = {
      type: "end",
      status: "canceled",
      code: null,
      detail: null,
      bucketCount: 0,
      cached: false,
      timestampsDecrease: false,
      damaged: false,
      truncated: false,
      alignmentUncertain: false,
    };

    it("ends a running job as a cancel does: the envelope goes at once, the slot at the end", async () => {
      const { controller, store, data, cancels, reply, message, source } =
        setupWithClient();
      controller.show("s1");
      reply(0, 7);
      await flush();
      message(0, chunkBytes(0, [1, 2]));
      expect(data.get("s1")).toBeDefined();

      controller.streamChanged("s1");
      await flush();
      // The envelope of the old stream goes, and Rust gets the cancel of the job.
      expect(data.get("s1")).toBeUndefined();
      expect(cancels()).toEqual([7]);
      // Rust still holds the slot, so no envelope can start yet, for any source.
      expect(store.getState().runningSourceId).toBe("s1");
      expect(controller.show("s2")).toBe(false);
      // The data and the progress of the old job are refused.
      message(0, chunkBytes(2, [3, 4]));
      message(0, { type: "progress", highWater: 5, bytesRead: null, totalBytes: null });
      expect(data.get("s1")).toBeUndefined();
      expect(source().progress).toBeNull();

      // The end of the job frees the slot, and the source is idle with no envelope.
      message(0, CANCELED_END);
      expect(source().phase).toBe("idle");
      expect(store.getState().runningSourceId).toBeNull();
      expect(data.get("s1")).toBeUndefined();
      expect(controller.show("s2")).toBe(true);
    });

    it("cancels a job whose start reply is still pending when the stream changes", async () => {
      const { controller, store, data, cancels, reply, message, source } =
        setupWithClient();
      controller.show("s1");
      // A cache hit can send its data before the reply of the start.
      message(0, chunkBytes(0, [1, 2]));
      controller.streamChanged("s1");
      await flush();
      expect(data.get("s1")).toBeUndefined();
      // No job id yet: the client keeps the cancel until the reply names the job.
      expect(cancels()).toEqual([]);
      expect(store.getState().runningSourceId).toBe("s1");
      expect(controller.show("s1")).toBe(false);
      message(0, chunkBytes(2, [3, 4]));
      expect(data.get("s1")).toBeUndefined();

      reply(0, 9);
      await flush();
      expect(cancels()).toEqual([9]);
      expect(store.getState().runningSourceId).toBe("s1");

      message(0, CANCELED_END);
      expect(source().phase).toBe("idle");
      expect(store.getState().runningSourceId).toBeNull();
      // The source can show its envelope again, for the new stream.
      expect(controller.show("s1")).toBe(true);
    });

    it("shows no envelope and no failure for the end of a job of the old stream", () => {
      const { controller, data, job, source } = setup();
      controller.show("s1");
      controller.streamChanged("s1");
      job(0).handlers.onChunk(chunk(0, [1, 2]));
      job(0).handlers.onEnd(end());
      expect(source().phase).toBe("idle");
      expect(data.get("s1")).toBeUndefined();

      controller.show("s2");
      controller.streamChanged("s2");
      job(1).handlers.onEnd(end({ status: "failed", code: "decodeFailed" }));
      expect(source("s2").phase).toBe("idle");
      expect(source("s2").errorCode).toBeNull();
    });

    it("removes the envelope that the timeline shows for the source", () => {
      const { controller, data, job, source } = setup();
      controller.show("s1");
      job(0).handlers.onChunk(chunk(0, [1, 2]));
      job(0).handlers.onEnd(end());
      expect(source().phase).toBe("ready");

      controller.streamChanged("s1");
      expect(source().phase).toBe("idle");
      expect(data.get("s1")).toBeUndefined();
      // A source with no envelope stays as it is.
      controller.streamChanged("s2");
      expect(source("s2").phase).toBe("idle");
    });

    it("does not touch the job of another source", () => {
      const { controller, job, source } = setup();
      controller.show("s1");
      controller.streamChanged("s2");
      expect(job(0).close).not.toHaveBeenCalled();
      expect(source().phase).toBe("running");
    });
  });
});
