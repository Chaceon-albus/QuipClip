import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS, type InvokeFn } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import {
  cancelWaveform,
  clearWaveformCache,
  nextWaveformSequence,
  startWaveform,
  waveformCacheUsage,
  type WaveformChannel,
  type WaveformHandlers,
} from "./client";
import { chunkBytes } from "./testSupport";
import { WaveformError, type WaveformRequest } from "./types";

const REQUEST: WaveformRequest = {
  path: "/media/live.flv",
  size: 10_000_000_000,
  mtime: 1729000000,
  audioStreamIndex: 1,
  videoStartPts: "1400" as Pts,
  videoTimeBase: { n: 1, d: 1000 },
  durationSeconds: 14400,
};

const END = {
  type: "end",
  status: "complete",
  code: null,
  detail: null,
  bucketCount: 2,
  cached: false,
  timestampsDecrease: false,
  damaged: false,
  truncated: false,
  alignmentUncertain: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const started = deferred<unknown>();
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === BACKEND_COMMANDS.START_WAVEFORM) {
      return started.promise;
    }
    return Promise.resolve(undefined);
  }) as unknown as InvokeFn;
  const channel: WaveformChannel = { onmessage: () => undefined };
  const handlers = {
    onChunk: vi.fn<WaveformHandlers["onChunk"]>(),
    onProgress: vi.fn<WaveformHandlers["onProgress"]>(),
    onEnd: vi.fn<WaveformHandlers["onEnd"]>(),
  };
  const job = startWaveform(REQUEST, handlers, {
    invoke,
    createChannel: () => channel,
    now: () => 1_000_000,
  });
  const cancels = () =>
    calls.filter((call) => call.cmd === BACKEND_COMMANDS.CANCEL_WAVEFORM);
  return { started, calls, channel, handlers, job, cancels };
}

describe("nextWaveformSequence", () => {
  it("counts microseconds and always rises", () => {
    const a = nextWaveformSequence(() => 5_000_000_000_000);
    expect(a).toBe(5_000_000_000_000_000);
    expect(nextWaveformSequence(() => 5_000_000_000_000)).toBe(a + 1);
    expect(nextWaveformSequence(() => 1)).toBe(a + 2);
  });
});

describe("startWaveform", () => {
  it("sends the request with a sequence and the channel", () => {
    const { calls, channel } = setup();
    expect(calls[0]?.cmd).toBe("start_waveform");
    const args = calls[0]?.args as {
      request: Record<string, unknown>;
      channel: unknown;
    };
    expect(args.request).toMatchObject({ ...REQUEST });
    expect(typeof args.request.sequence).toBe("number");
    expect(args.channel).toBe(channel);
  });

  it("delivers messages that arrive before the start resolves", async () => {
    const { started, channel, handlers, job } = setup();
    channel.onmessage(chunkBytes(0, [1, 2]).buffer);
    channel.onmessage({
      type: "progress",
      highWater: 1,
      bytesRead: null,
      totalBytes: null,
    });
    channel.onmessage(END);
    started.resolve({ jobId: 4, cached: true, bucketRate: 100 });
    await expect(job.started).resolves.toEqual({
      jobId: 4,
      cached: true,
      bucketRate: 100,
    });
    expect(handlers.onChunk).toHaveBeenCalledTimes(1);
    expect(handlers.onChunk.mock.calls[0]?.[0].startBucket).toBe(0);
    expect(handlers.onProgress).toHaveBeenCalledWith({
      highWater: 1,
      bytesRead: null,
      totalBytes: null,
    });
    expect(handlers.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete" }),
    );
  });

  it("drops each message after the end", () => {
    const { channel, handlers } = setup();
    channel.onmessage(END);
    channel.onmessage(chunkBytes(0, [1, 2]));
    channel.onmessage(END);
    expect(handlers.onChunk).not.toHaveBeenCalled();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it("defers a cancel until the job id arrives", async () => {
    const { started, job, cancels } = setup();
    job.cancel();
    expect(cancels()).toHaveLength(0);
    started.resolve({ jobId: 9, cached: false, bucketRate: 100 });
    await job.started;
    expect(cancels()).toEqual([{ cmd: "cancel_waveform", args: { jobId: 9 } }]);
    job.cancel();
    expect(cancels()).toHaveLength(1);
  });

  it("keeps the handlers after a cancel, so the canceled end arrives", async () => {
    const { started, channel, handlers, job, cancels } = setup();
    started.resolve({ jobId: 2, cached: false, bucketRate: 100 });
    await job.started;
    job.cancel();
    expect(cancels()).toHaveLength(1);
    channel.onmessage({ ...END, status: "canceled" });
    expect(handlers.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ status: "canceled" }),
    );
  });

  it("drops late messages after close", async () => {
    const { started, channel, handlers, job, cancels } = setup();
    job.close();
    expect(job.isClosed()).toBe(true);
    channel.onmessage(chunkBytes(0, [1, 2]));
    channel.onmessage(END);
    started.resolve({ jobId: 5, cached: false, bucketRate: 100 });
    await job.started;
    expect(handlers.onChunk).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
    expect(cancels()).toEqual([{ cmd: "cancel_waveform", args: { jobId: 5 } }]);
  });

  it("sends no cancel for a job that already ended", async () => {
    const { started, channel, job, cancels } = setup();
    channel.onmessage(END);
    job.cancel();
    started.resolve({ jobId: 5, cached: true, bucketRate: 100 });
    await job.started;
    expect(cancels()).toHaveLength(0);
  });

  it("ends a job with invalidResponse at a malformed message and cancels it", async () => {
    const { started, channel, handlers, job, cancels } = setup();
    channel.onmessage({ type: "weird" });
    expect(handlers.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", code: "invalidResponse" }),
    );
    channel.onmessage(END);
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    started.resolve({ jobId: 6, cached: false, bucketRate: 100 });
    await job.started;
    expect(cancels()).toEqual([{ cmd: "cancel_waveform", args: { jobId: 6 } }]);
  });

  it("rejects with the code of the refusal", async () => {
    const { started, job } = setup();
    started.reject({ code: "busy" });
    await expect(job.started).rejects.toMatchObject({ code: "busy" });
  });

  it("rejects a reply of the wrong shape", async () => {
    const { started, job, cancels } = setup();
    started.resolve({ jobId: "x" });
    await expect(job.started).rejects.toMatchObject({ code: "invalidResponse" });
    expect(cancels()).toHaveLength(0);
  });

  it("cancels the job of a reply of the wrong shape that names one", async () => {
    const { started, job, cancels } = setup();
    started.resolve({ jobId: 4, cached: "no" });
    await expect(job.started).rejects.toMatchObject({ code: "invalidResponse" });
    expect(cancels()).toEqual([{ cmd: "cancel_waveform", args: { jobId: 4 } }]);
  });

  it("sends no cancel for a cache hit, which holds no slot", async () => {
    const { started, job, cancels } = setup();
    started.resolve({ jobId: 0, cached: true, bucketRate: 100 });
    await job.started;
    job.cancel();
    job.close();
    expect(cancels()).toHaveLength(0);
  });
});

describe("the other commands", () => {
  it("cancels a job by id", async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined)) as unknown as InvokeFn;
    await cancelWaveform(3, { invoke });
    expect(invoke).toHaveBeenCalledWith("cancel_waveform", { jobId: 3 });
  });

  it("reads and clears the cache", async () => {
    const invoke = vi.fn((cmd: string) =>
      Promise.resolve(
        cmd === "waveform_cache_usage"
          ? { bytes: 1, entries: 1, limitBytes: 2 }
          : { removedBytes: 1 },
      ),
    ) as unknown as InvokeFn;
    await expect(waveformCacheUsage({ invoke })).resolves.toEqual({
      bytes: 1,
      entries: 1,
      limitBytes: 2,
    });
    await expect(clearWaveformCache({ invoke })).resolves.toEqual({ removedBytes: 1 });
  });

  it("refuses a malformed cache reply and maps a refusal", async () => {
    const bad = vi.fn(() => Promise.resolve({})) as unknown as InvokeFn;
    await expect(waveformCacheUsage({ invoke: bad })).rejects.toBeInstanceOf(
      WaveformError,
    );
    await expect(clearWaveformCache({ invoke: bad })).rejects.toMatchObject({
      code: "invalidResponse",
    });
    const refused = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("cacheUnavailable"), { code: "cacheUnavailable" }),
      ),
    ) as unknown as InvokeFn;
    await expect(waveformCacheUsage({ invoke: refused })).rejects.toMatchObject({
      code: "cacheUnavailable",
    });
    await expect(cancelWaveform(1, { invoke: refused })).rejects.toMatchObject({
      code: "cacheUnavailable",
    });
  });
});
