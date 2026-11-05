import { describe, expect, it, vi } from "vitest";
import type { FfmpegInstallHandlers, FfmpegInstallJob } from "./client";
import { createFfmpegInstallStore } from "./store";
import { FfmpegInstallError, type FfmpegDownloadOffer } from "./types";

const OFFER: FfmpegDownloadOffer = {
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

/** Lets the promise callbacks that are queued now run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function setup(offers: (FfmpegDownloadOffer | null)[] = [OFFER, null]) {
  const loadOffer = vi.fn(() => Promise.resolve(offers.shift() ?? null));
  const startProbe = vi.fn(() => Promise.resolve(null));
  const jobs: {
    handlers: FfmpegInstallHandlers;
    started: ReturnType<typeof deferred<{ jobId: number }>>;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const startInstall = vi.fn((handlers: FfmpegInstallHandlers): FfmpegInstallJob => {
    const started = deferred<{ jobId: number }>();
    const cancel = vi.fn();
    jobs.push({ handlers, started, cancel });
    return { started: started.promise, cancel };
  });
  const store = createFfmpegInstallStore({ loadOffer, startInstall, startProbe });
  return { store, loadOffer, startProbe, startInstall, jobs };
}

describe("ffmpeg install store", () => {
  it("loads the offer, and the newest request wins", async () => {
    const first = deferred<FfmpegDownloadOffer | null>();
    const second = deferred<FfmpegDownloadOffer | null>();
    const loadOffer = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createFfmpegInstallStore({ loadOffer });
    void store.getState().loadOffer();
    expect(store.getState().offer).toEqual({ status: "loading", previous: null });
    const newer = store.getState().loadOffer();
    second.resolve(null);
    await newer;
    first.resolve(OFFER);
    await settle();
    expect(store.getState().offer).toEqual({ status: "ready", offer: null });
  });

  it("keeps the last offer while it asks again, and can start from it", async () => {
    const again = deferred<FfmpegDownloadOffer | null>();
    const loadOffer = vi
      .fn()
      .mockResolvedValueOnce(OFFER)
      .mockReturnValueOnce(again.promise)
      .mockResolvedValue(null);
    const startInstall = vi.fn((): FfmpegInstallJob => ({
      started: new Promise(() => undefined),
      cancel: vi.fn(),
    }));
    const store = createFfmpegInstallStore({ loadOffer, startInstall });
    await store.getState().loadOffer();
    void store.getState().loadOffer();
    expect(store.getState().offer).toEqual({ status: "loading", previous: OFFER });
    expect(store.getState().startInstall()).toBe(true);
    // The answer that was in flight does not replace the offer of the install.
    again.resolve(null);
    await settle();
    expect(store.getState().offer).toEqual({ status: "ready", offer: OFFER });
    expect(startInstall).toHaveBeenCalledTimes(1);
  });

  it("ends an install whose start throws as failed, so it does not stay running", async () => {
    const store = createFfmpegInstallStore({
      loadOffer: vi.fn().mockResolvedValueOnce(OFFER).mockResolvedValue(OFFER),
      startInstall: () => {
        throw new Error("no Tauri runtime");
      },
    });
    await store.getState().loadOffer();
    expect(store.getState().startInstall()).toBe(true);
    expect(store.getState().install).toEqual({
      status: "failed",
      code: "commandExecutionFailed",
      detail: "no Tauri runtime",
    });
    await settle();
    expect(store.getState().startInstall()).toBe(true);
  });

  it("keeps the error of an offer that failed", async () => {
    const loadOffer = vi
      .fn()
      .mockRejectedValue(new FfmpegInstallError("commandExecutionFailed", "join"));
    const store = createFfmpegInstallStore({ loadOffer });
    await store.getState().loadOffer();
    expect(store.getState().offer).toEqual({
      status: "failed",
      code: "commandExecutionFailed",
      detail: "join",
    });
  });

  it("starts only with an offer and only once at a time", async () => {
    const { store, startInstall } = setup();
    expect(store.getState().startInstall()).toBe(false);
    await store.getState().loadOffer();
    expect(store.getState().startInstall()).toBe(true);
    expect(store.getState().startInstall()).toBe(false);
    expect(startInstall).toHaveBeenCalledTimes(1);
    expect(store.getState().install).toEqual({
      status: "running",
      phase: null,
      received: null,
      total: null,
      cancelRequested: false,
    });
  });

  it("shows the progress, then probes and loads the offer after the install", async () => {
    const { store, jobs, startProbe, loadOffer } = setup();
    await store.getState().loadOffer();
    store.getState().startInstall();
    const job = jobs[0];
    job.handlers.onProgress({ phase: "download", received: 40, total: 100 });
    expect(store.getState().install).toMatchObject({
      status: "running",
      phase: "download",
      received: 40,
      total: 100,
    });
    job.started.resolve({ jobId: 1 });
    job.handlers.onProgress({ phase: "check", received: null, total: null });
    expect(store.getState().install).toMatchObject({ phase: "check", received: null });
    job.handlers.onEnd({ outcome: "installed" });
    expect(store.getState().install).toEqual({ status: "installed" });
    expect(startProbe).toHaveBeenCalledWith(true);
    await settle();
    expect(loadOffer).toHaveBeenCalledTimes(2);
    expect(store.getState().offer).toEqual({ status: "ready", offer: null });
  });

  it("does not load the offer while an install runs", async () => {
    const { store, loadOffer } = setup();
    await store.getState().loadOffer();
    store.getState().startInstall();
    await store.getState().loadOffer();
    expect(loadOffer).toHaveBeenCalledTimes(1);
    expect(store.getState().offer).toEqual({ status: "ready", offer: OFFER });
  });

  it("sends the cancel once and shows it until the end", async () => {
    const { store, jobs, startProbe } = setup([OFFER, OFFER]);
    await store.getState().loadOffer();
    store.getState().startInstall();
    store.getState().cancelInstall();
    store.getState().cancelInstall();
    const job = jobs[0];
    expect(job.cancel).toHaveBeenCalledTimes(1);
    expect(store.getState().install).toMatchObject({ cancelRequested: true });
    job.handlers.onEnd({ outcome: "canceled" });
    expect(store.getState().install).toEqual({ status: "canceled" });
    expect(startProbe).not.toHaveBeenCalled();
    await settle();
    // The offer stays, so the user can start again.
    expect(store.getState().startInstall()).toBe(true);
  });

  it("shows a failed install with its code and detail", async () => {
    const { store, jobs, startProbe } = setup([OFFER, OFFER]);
    await store.getState().loadOffer();
    store.getState().startInstall();
    jobs[0].handlers.onEnd({
      outcome: "failed",
      code: "networkFailed",
      detail: "connection reset",
    });
    expect(store.getState().install).toEqual({
      status: "failed",
      code: "networkFailed",
      detail: "connection reset",
    });
    expect(startProbe).not.toHaveBeenCalled();
    store.getState().dismissResult();
    expect(store.getState().install).toEqual({ status: "idle" });
  });

  it("shows a refused start, and probes when Rust found a pair", async () => {
    const { store, jobs, startProbe } = setup([OFFER, null]);
    await store.getState().loadOffer();
    store.getState().startInstall();
    jobs[0].started.reject(new FfmpegInstallError("alreadyFound"));
    await settle();
    expect(store.getState().install).toEqual({
      status: "failed",
      code: "alreadyFound",
      detail: null,
    });
    expect(startProbe).toHaveBeenCalledWith(true);
    expect(store.getState().offer).toEqual({ status: "ready", offer: null });
  });

  it("shows a start that the reload of the page refused as canceled", async () => {
    const { store, jobs } = setup([OFFER, OFFER]);
    await store.getState().loadOffer();
    store.getState().startInstall();
    jobs[0].started.reject(new FfmpegInstallError("canceled"));
    await settle();
    expect(store.getState().install).toEqual({ status: "canceled" });
  });

  it("ignores the callbacks of an install that ended", async () => {
    const { store, jobs } = setup([OFFER, OFFER, OFFER]);
    await store.getState().loadOffer();
    store.getState().startInstall();
    const first = jobs[0];
    first.handlers.onEnd({ outcome: "canceled" });
    await settle();
    store.getState().startInstall();
    first.handlers.onProgress({ phase: "download", received: 1, total: 2 });
    first.handlers.onEnd({ outcome: "installed" });
    first.started.reject(new FfmpegInstallError("busy"));
    await settle();
    expect(store.getState().install).toMatchObject({ status: "running", phase: null });
  });

  it("keeps a running install when the result is dismissed", async () => {
    const { store } = setup();
    await store.getState().loadOffer();
    store.getState().startInstall();
    store.getState().dismissResult();
    expect(store.getState().install.status).toBe("running");
  });
});
