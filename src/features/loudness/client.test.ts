import { describe, expect, it, vi } from "vitest";
import { createPresetDraft } from "@/features/settings/presetDocument";
import { BACKEND_COMMANDS, type InvokeFn } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import {
  INVALID_END_WAIT_MS,
  nextLoudnessSequence,
  startLoudnessMeasurement,
  type LoudnessChannel,
  type LoudnessHandlers,
} from "./client";
import { LoudnessError, type LoudnessScope } from "./types";

const SCOPE: LoudnessScope = {
  sources: [{ id: "a", path: "/media/a.mp4", expectedRevision: { size: 1, mtime: 2 } }],
  pieces: [{ sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts }],
  segmentCount: 1,
  preset: createPresetDraft("p", "P"),
  streams: "videoAndAudio",
  // Only the page reads it (ADR 070): the request below does not carry it.
  effectiveAudio: { a: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 } },
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
    if (cmd === BACKEND_COMMANDS.START_LOUDNESS_MEASUREMENT) {
      return started.promise;
    }
    return Promise.resolve(undefined);
  }) as unknown as InvokeFn;
  const channel: LoudnessChannel = { onmessage: () => undefined };
  const handlers = {
    onProgress: vi.fn<LoudnessHandlers["onProgress"]>(),
    onEnd: vi.fn<LoudnessHandlers["onEnd"]>(),
  };
  // A scope with a key that a caller can add, as a whole export request would: the request
  // must carry only the fields of the scope.
  const scope = { ...SCOPE, outputPath: "/out.mp4" } as LoudnessScope;
  const job = startLoudnessMeasurement(scope, handlers, {
    invoke,
    createChannel: () => channel,
    now: () => 2_000_000_000,
  });
  const cancels = () =>
    calls.filter((call) => call.cmd === BACKEND_COMMANDS.CANCEL_LOUDNESS_MEASUREMENT);
  return { started, calls, channel, handlers, job, cancels };
}

describe("the loudness client (ADR 061)", () => {
  it("sends the scope with a rising number and the channel", () => {
    const { calls, channel } = setup();
    expect(calls[0].cmd).toBe(BACKEND_COMMANDS.START_LOUDNESS_MEASUREMENT);
    const request = calls[0].args?.request as Record<string, unknown>;
    expect(request).toMatchObject({
      sources: SCOPE.sources,
      pieces: SCOPE.pieces,
      segmentCount: SCOPE.segmentCount,
      preset: SCOPE.preset,
      streams: SCOPE.streams,
    });
    // The five fields of the scope and the number, and no other key: Rust refuses another key.
    expect(Object.keys(request).sort()).toEqual([
      "pieces",
      "preset",
      "segmentCount",
      "sequence",
      "sources",
      "streams",
    ]);
    expect(typeof request.sequence).toBe("number");
    expect(calls[0].args?.channel).toBe(channel);
    expect(nextLoudnessSequence(() => 0)).toBeGreaterThan(request.sequence as number);
  });

  it("gives the progress, then the end once", async () => {
    const { started, channel, handlers, job } = setup();
    started.resolve({ jobId: 3 });
    await expect(job.started).resolves.toEqual({ jobId: 3 });
    channel.onmessage({ type: "progress", readUs: 1, totalUs: 2 });
    const end = {
      type: "end",
      status: "complete",
      code: null,
      detail: null,
      integratedLufs: -20,
      truePeakDbtp: -19.9,
    };
    channel.onmessage(end);
    channel.onmessage(end);
    expect(handlers.onProgress).toHaveBeenCalledWith({ readUs: 1, totalUs: 2 });
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).toHaveBeenCalledWith({
      status: "complete",
      integratedLufs: -20,
      truePeakDbtp: -19.9,
    });
  });

  it("holds a cancel until it knows the id of the job", async () => {
    const { started, job, cancels } = setup();
    job.cancel();
    expect(cancels()).toHaveLength(0);
    started.resolve({ jobId: 7 });
    await job.started;
    expect(cancels()).toEqual([
      { cmd: BACKEND_COMMANDS.CANCEL_LOUDNESS_MEASUREMENT, args: { jobId: 7 } },
    ]);
    job.cancel();
    expect(cancels()).toHaveLength(1);
  });

  it("cancels a job whose message has the wrong shape, and ends it when Rust ends it", async () => {
    const { started, channel, handlers, job, cancels } = setup();
    channel.onmessage({ type: "end", status: "weird" });
    // Rust still holds its slot, so the end waits for the end of Rust.
    expect(handlers.onEnd).not.toHaveBeenCalled();
    started.resolve({ jobId: 9 });
    await job.started;
    expect(cancels()).toHaveLength(1);
    channel.onmessage({ type: "progress", readUs: 1, totalUs: 2 });
    expect(handlers.onProgress).not.toHaveBeenCalled();
    channel.onmessage({
      type: "end",
      status: "canceled",
      code: null,
      detail: null,
      integratedLufs: null,
      truePeakDbtp: null,
    });
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).toHaveBeenCalledWith({
      status: "failed",
      code: "invalidResponse",
      detail: null,
    });
  });

  it("ends a job whose end never comes after a message of the wrong shape", () => {
    vi.useFakeTimers();
    try {
      const { channel, handlers } = setup();
      channel.onmessage("garbage");
      vi.advanceTimersByTime(INVALID_END_WAIT_MS - 1);
      expect(handlers.onEnd).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handlers.onEnd).toHaveBeenCalledTimes(1);
      expect(handlers.onEnd).toHaveBeenCalledWith({
        status: "failed",
        code: "invalidResponse",
        detail: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a refused start with its code, and calls no handler", async () => {
    const { started, handlers, job } = setup();
    started.reject({ code: "busy" });
    await expect(job.started).rejects.toEqual(new LoudnessError("busy"));
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });
});
