import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS, type InvokeFn } from "@/lib/ipc";
import {
  cancelFfmpegInstall,
  ffmpegDownloadOffer,
  nextFfmpegInstallSequence,
  startFfmpegInstall,
  type FfmpegInstallChannel,
  type FfmpegInstallHandlers,
} from "./client";
import { FfmpegInstallError } from "./types";

const OFFER = {
  version: "9.0.2",
  source: "github.com/GyanD/codexffmpeg",
  license: { gpl: true, nonfree: false, version3: true },
  downloadSize: 100,
  directory: "C:\\bin",
  replaces: false,
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
    if (cmd === BACKEND_COMMANDS.START_FFMPEG_INSTALL) {
      return started.promise;
    }
    return Promise.resolve(undefined);
  }) as unknown as InvokeFn;
  const channel: FfmpegInstallChannel = { onmessage: () => undefined };
  const handlers = {
    onProgress: vi.fn<FfmpegInstallHandlers["onProgress"]>(),
    onEnd: vi.fn<FfmpegInstallHandlers["onEnd"]>(),
  };
  const job = startFfmpegInstall(handlers, {
    invoke,
    createChannel: () => channel,
    now: () => 1_000_000,
  });
  const cancels = () =>
    calls.filter((call) => call.cmd === BACKEND_COMMANDS.CANCEL_FFMPEG_INSTALL);
  return { started, calls, channel, handlers, job, cancels };
}

describe("nextFfmpegInstallSequence", () => {
  it("counts microseconds and always rises", () => {
    const a = nextFfmpegInstallSequence(() => 5_000_000_000_000);
    expect(a).toBe(5_000_000_000_000_000);
    expect(nextFfmpegInstallSequence(() => 5_000_000_000_000)).toBe(a + 1);
    expect(nextFfmpegInstallSequence(() => 1)).toBe(a + 2);
  });
});

describe("ffmpegDownloadOffer", () => {
  it("gives the offer, or null when Rust gives none", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(OFFER).mockResolvedValueOnce(null);
    await expect(
      ffmpegDownloadOffer({ invoke: invoke as unknown as InvokeFn }),
    ).resolves.toEqual(OFFER);
    await expect(
      ffmpegDownloadOffer({ invoke: invoke as unknown as InvokeFn }),
    ).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("ffmpeg_download_offer", undefined);
  });

  it("rejects a reply of the wrong shape and a refused command", async () => {
    const wrong = vi.fn().mockResolvedValue({ version: "9.0.2" });
    await expect(
      ffmpegDownloadOffer({ invoke: wrong as unknown as InvokeFn }),
    ).rejects.toMatchObject({ code: "invalidResponse" });
    const refused = vi.fn().mockRejectedValue({ code: "commandExecutionFailed" });
    await expect(
      ffmpegDownloadOffer({ invoke: refused as unknown as InvokeFn }),
    ).rejects.toBeInstanceOf(FfmpegInstallError);
  });
});

describe("startFfmpegInstall", () => {
  it("sends a sequence and the channel", () => {
    const { calls, channel } = setup();
    expect(calls[0]?.cmd).toBe("start_ffmpeg_install");
    const args = calls[0]?.args as { sequence: unknown; channel: unknown };
    expect(typeof args.sequence).toBe("number");
    expect(args.channel).toBe(channel);
  });

  it("delivers messages that arrive before the start resolves", async () => {
    const { started, channel, handlers, job } = setup();
    channel.onmessage({ type: "progress", phase: "download", received: 1, total: 2 });
    channel.onmessage({ type: "end", outcome: "installed" });
    started.resolve({ jobId: 4 });
    await expect(job.started).resolves.toEqual({ jobId: 4 });
    expect(handlers.onProgress).toHaveBeenCalledWith({
      phase: "download",
      received: 1,
      total: 2,
    });
    expect(handlers.onEnd).toHaveBeenCalledWith({ outcome: "installed" });
  });

  it("drops every message after the end", () => {
    const { channel, handlers } = setup();
    channel.onmessage({ type: "end", outcome: "canceled" });
    channel.onmessage({ type: "progress", phase: "extract" });
    channel.onmessage({ type: "end", outcome: "installed" });
    expect(handlers.onProgress).not.toHaveBeenCalled();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it("holds a cancel until the id is known, and sends it once", async () => {
    const { started, job, cancels } = setup();
    job.cancel();
    job.cancel();
    expect(cancels()).toHaveLength(0);
    started.resolve({ jobId: 7 });
    await job.started;
    expect(cancels()).toEqual([{ cmd: "cancel_ffmpeg_install", args: { jobId: 7 } }]);
  });

  it("sends no cancel after Rust ended the install", async () => {
    const { started, channel, job, cancels } = setup();
    started.resolve({ jobId: 7 });
    await job.started;
    channel.onmessage({ type: "end", outcome: "installed" });
    job.cancel();
    expect(cancels()).toHaveLength(0);
  });

  it("ends a message of the wrong shape as invalidResponse and cancels the install", async () => {
    const { started, channel, handlers, job, cancels } = setup();
    channel.onmessage({ type: "progress", phase: "unpack" });
    expect(handlers.onEnd).toHaveBeenCalledWith({
      outcome: "failed",
      code: "invalidResponse",
      detail: null,
    });
    started.resolve({ jobId: 2 });
    await job.started;
    expect(cancels()).toEqual([{ cmd: "cancel_ffmpeg_install", args: { jobId: 2 } }]);
  });

  it("rejects a refused start with its code", async () => {
    const { started, job } = setup();
    started.reject({ code: "busy" });
    await expect(job.started).rejects.toMatchObject({ code: "busy", detail: null });
  });

  it("reads only the job id of the start reply", async () => {
    const { started, job, cancels } = setup();
    started.resolve({ jobId: 5, extra: true });
    await expect(job.started).resolves.toEqual({ jobId: 5 });
    expect(cancels()).toHaveLength(0);
  });

  it("rejects a start reply without a job id", async () => {
    const { started, job, cancels } = setup();
    started.resolve({ jobId: 0 });
    await expect(job.started).rejects.toMatchObject({ code: "invalidResponse" });
    expect(cancels()).toHaveLength(0);
  });

  it("sends no cancel when the end came before the id", async () => {
    const { started, channel, job, cancels } = setup();
    channel.onmessage({ type: "end", outcome: "installed" });
    job.cancel();
    started.resolve({ jobId: 8 });
    await job.started;
    expect(cancels()).toHaveLength(0);
  });

  it("sends no cancel when the start that it waited for is refused", async () => {
    const { started, job, cancels } = setup();
    job.cancel();
    started.reject({ code: "busy" });
    await expect(job.started).rejects.toMatchObject({ code: "busy" });
    expect(cancels()).toHaveLength(0);
  });
});

describe("cancelFfmpegInstall", () => {
  it("names the job and maps a rejection", async () => {
    const invoke = vi.fn().mockRejectedValue("no");
    await expect(
      cancelFfmpegInstall(3, { invoke: invoke as unknown as InvokeFn }),
    ).rejects.toMatchObject({ code: "commandExecutionFailed", detail: "no" });
    expect(invoke).toHaveBeenCalledWith("cancel_ffmpeg_install", { jobId: 3 });
  });
});
