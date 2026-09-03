import { describe, expect, it, vi } from "vitest";
import { createFfmpegStore, ffmpegStore } from "./store";
import {
  CapabilityProbeError,
  type CapabilityProbeEvent,
  type CapabilityProbeStart,
  type CapabilityReport,
  type EncoderResult,
  type LicenseFlags,
} from "./types";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createValidLicense(): LicenseFlags {
  return {
    gpl: true,
    nonfree: false,
    version3: true,
  };
}

function createValidEncoderResult(name: string): EncoderResult {
  return {
    name,
    kind: "video",
    listed: true,
    status: "works",
  };
}

function createValidReport(): CapabilityReport {
  return {
    version: "7.1.0",
    license: createValidLicense(),
    hwaccels: ["videotoolbox"],
    encoders: [
      createValidEncoderResult("libx264"),
      createValidEncoderResult("h264_videotoolbox"),
    ],
    probedAt: 1724976000,
  };
}

describe("FFmpeg Capability Probe Store", () => {
  describe("Initial State", () => {
    it("starts with idle status and clean state", () => {
      const store = createFfmpegStore();
      const state = store.getState();

      expect(state.status).toBe("idle");
      expect(state.runId).toBeNull();
      expect(state.paths).toBeNull();
      expect(state.origin).toBeNull();
      expect(state.version).toBeNull();
      expect(state.license).toBeNull();
      expect(state.hwaccels).toEqual([]);
      expect(state.results).toEqual([]);
      expect(state.done).toBe(0);
      expect(state.total).toBe(0);
      expect(state.source).toBeNull();
      expect(state.error).toBeNull();
      expect(state.inspected).toBeNull();
    });

    it("respects optional initial state overrides", () => {
      const store = createFfmpegStore(
        {},
        {
          status: "ready",
          version: "7.1.0",
          results: [createValidEncoderResult("libx264")],
        },
      );
      const state = store.getState();

      expect(state.status).toBe("ready");
      expect(state.version).toBe("7.1.0");
      expect(state.results).toHaveLength(1);
    });
  });

  describe("Acceptance Criterion 1: Subscribe Before Invoke", () => {
    it("subscribes to backend events BEFORE invoking the start_capability_probe command", async () => {
      const sub = createDeferred<() => void>();
      const mockSubscribe = vi.fn(() => sub.promise);
      const mockStart = vi.fn().mockResolvedValue({
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      });

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
        startCapabilityProbe: mockStart,
      });

      const p = store.getState().startProbe();
      await Promise.resolve();
      expect(mockStart).not.toHaveBeenCalled();
      sub.resolve(() => {});
      await p;
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("Subscription Failure & Recovery", () => {
    it("normalizes subscription rejection, sets error state, and re-subscribes on a second startProbe", async () => {
      let shouldFail = true;
      const mockSubscribe = vi.fn().mockImplementation(() => {
        if (shouldFail) {
          return Promise.reject(new Error("Event listener failed to initialize"));
        }
        return Promise.resolve(() => {});
      });

      const mockStart = vi.fn().mockResolvedValue({
        runId: "run-recovered",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      });

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
        startCapabilityProbe: mockStart,
      });

      // First call fails during subscription
      const result1 = await store.getState().startProbe();

      expect(result1).toBeNull();
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("unknown");
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockStart).not.toHaveBeenCalled();

      // Second call succeeds because rejected promise memo was cleared
      shouldFail = false;
      const result2 = await store.getState().startProbe();

      expect(result2?.runId).toBe("run-recovered");
      expect(store.getState().status).toBe("probing");
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("Early Event Buffering", () => {
    it("buffers events emitted during startCapabilityProbe invocation and replays them once runId is known", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () => {
          // Emit cached finished event BEFORE startCapabilityProbe resolves
          eventHandler({
            event: "finished",
            runId: "run-cached-early",
            report: createValidReport(),
            source: "cache",
          });
          return Promise.resolve({
            runId: "run-cached-early",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          });
        },
      });

      const result = await store.getState().startProbe();

      expect(result?.runId).toBe("run-cached-early");
      expect(store.getState().status).toBe("ready");
      expect(store.getState().source).toBe("cache");
      expect(store.getState().version).toBe("7.1.0");
    });

    it("discards buffered early events from superseded requests", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;
      const req1 = createDeferred<CapabilityProbeStart>();
      const req2 = createDeferred<CapabilityProbeStart>();

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: (force) => (force ? req2.promise : req1.promise),
      });

      const p1 = store.getState().startProbe(false);
      const p2 = store.getState().startProbe(true);

      // Early event emitted for run-1 while both are in flight
      eventHandler({
        event: "located",
        runId: "run-1",
        ffmpeg: "/old/ffmpeg",
        ffprobe: "/old/ffprobe",
        origin: "path",
        version: "6.0.0",
        license: createValidLicense(),
      });

      // Req2 resolves first
      req2.resolve({
        runId: "run-2",
        ffmpeg: "/new/ffmpeg",
        ffprobe: "/new/ffprobe",
        origin: "configured",
      });

      await p2;
      expect(store.getState().runId).toBe("run-2");

      // Req1 resolves later
      req1.resolve({
        runId: "run-1",
        ffmpeg: "/old/ffmpeg",
        ffprobe: "/old/ffprobe",
        origin: "path",
      });

      const res1 = await p1;
      expect(res1).toBeNull();
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().paths?.ffmpeg).toBe("/new/ffmpeg");
    });

    it("preserves winning run buffering state when a superseded run cleans up", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;
      const subDeferred = createDeferred<() => void>();
      const reqB = createDeferred<CapabilityProbeStart>();

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return subDeferred.promise;
        },
        startCapabilityProbe: (force) => {
          if (force) {
            return reqB.promise;
          }
          return Promise.resolve({
            runId: "run-A",
            ffmpeg: "/old/ffmpeg",
            ffprobe: "/old/ffprobe",
            origin: "path",
          });
        },
      });

      // 1. Start run A (subscribe deferred so it stays in flight)
      const p1 = store.getState().startProbe(false);

      // 2. Start run B so it supersedes A
      const p2 = store.getState().startProbe(true);

      // 3. Let A resume and hit its supersede branch
      subDeferred.resolve(() => {});
      const resA = await p1;
      expect(resA).toBeNull();

      // 4. Emit an early event for run B BEFORE B's invoke resolves
      eventHandler({
        event: "located",
        runId: "run-B",
        ffmpeg: "/new/ffmpeg",
        ffprobe: "/new/ffprobe",
        origin: "configured",
        version: "7.1.0",
        license: createValidLicense(),
      });

      // 5. Resolve B's invoke
      reqB.resolve({
        runId: "run-B",
        ffmpeg: "/new/ffmpeg",
        ffprobe: "/new/ffprobe",
        origin: "configured",
      });

      const resB = await p2;
      expect(resB?.runId).toBe("run-B");

      // 6. Assert the event reached the store (status/version reflect run B)
      expect(store.getState().status).toBe("probing");
      expect(store.getState().version).toBe("7.1.0");
      expect(store.getState().paths?.ffmpeg).toBe("/new/ffmpeg");
    });
  });

  describe("Acceptance Criterion 2: Superseded Runs Ignored by runId", () => {
    it("ignores events from older runs when a newer run is active", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const mockSubscribe = vi
        .fn<(handler: (event: CapabilityProbeEvent) => void) => Promise<() => void>>()
        .mockImplementation((handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        });

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
        startCapabilityProbe: (force) =>
          Promise.resolve({
            runId: force ? "run-2" : "run-1",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      // Start run 1
      await store.getState().startProbe(false);
      expect(store.getState().runId).toBe("run-1");

      // Send located event for run 1
      eventHandler({
        event: "located",
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
        version: "7.0.0",
        license: createValidLicense(),
      });
      expect(store.getState().version).toBe("7.0.0");

      // Start run 2 (supersedes run 1)
      await store.getState().startProbe(true);
      expect(store.getState().runId).toBe("run-2");

      // Late finished event arrives from superseded run 1
      eventHandler({
        event: "finished",
        runId: "run-1",
        report: {
          ...createValidReport(),
          version: "7.0.0-superseded",
        },
        source: "probe",
      });

      // State MUST NOT be updated by run-1's finished event
      expect(store.getState().status).toBe("probing");
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().version).toBeNull();
      expect(store.getState().source).toBeNull();

      // Now finished event arrives for active run 2
      eventHandler({
        event: "finished",
        runId: "run-2",
        report: {
          ...createValidReport(),
          version: "7.1.0-active",
        },
        source: "probe",
      });

      expect(store.getState().status).toBe("ready");
      expect(store.getState().version).toBe("7.1.0-active");
    });
  });

  describe("ensureSubscribed Idempotence & Memoization", () => {
    it("creates exactly one subscription across multiple sequential startProbe calls", async () => {
      const mockSubscribe = vi.fn().mockResolvedValue(() => {});
      const mockStart = vi.fn().mockResolvedValue({
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      });

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
        startCapabilityProbe: mockStart,
      });

      await store.getState().startProbe();
      await store.getState().startProbe();
      await store.getState().ensureSubscribed();

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    it("memoizes in-flight subscription promise under concurrent startProbe calls", async () => {
      const mockSubscribe = vi.fn(
        () => new Promise<() => void>((r) => setTimeout(() => r(() => {}), 5)),
      );
      const mockStart = vi.fn().mockResolvedValue({
        runId: "run-1",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      });

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
        startCapabilityProbe: mockStart,
      });

      await Promise.all([store.getState().startProbe(), store.getState().startProbe()]);

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("Full Probe Lifecycle", () => {
    it("transitions through locating -> probing -> ready with results accumulator", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-full",
            ffmpeg: "/opt/homebrew/bin/ffmpeg",
            ffprobe: "/opt/homebrew/bin/ffprobe",
            origin: "configured",
          }),
      });

      const startPromise = store.getState().startProbe();

      expect(store.getState().status).toBe("locating");

      const startResult = await startPromise;
      expect(startResult?.runId).toBe("run-full");
      expect(store.getState().status).toBe("probing");
      expect(store.getState().paths).toEqual({
        ffmpeg: "/opt/homebrew/bin/ffmpeg",
        ffprobe: "/opt/homebrew/bin/ffprobe",
      });
      expect(store.getState().origin).toBe("configured");

      // Event: located
      eventHandler({
        event: "located",
        runId: "run-full",
        ffmpeg: "/opt/homebrew/bin/ffmpeg",
        ffprobe: "/opt/homebrew/bin/ffprobe",
        origin: "configured",
        version: "7.1.0",
        license: createValidLicense(),
      });

      expect(store.getState().version).toBe("7.1.0");
      expect(store.getState().license).toEqual(createValidLicense());

      // Event: result 1
      eventHandler({
        event: "result",
        runId: "run-full",
        result: createValidEncoderResult("libx264"),
        done: 1,
        total: 2,
      });

      expect(store.getState().results).toHaveLength(1);
      expect(store.getState().results[0].name).toBe("libx264");
      expect(store.getState().done).toBe(1);
      expect(store.getState().total).toBe(2);

      // Event: result 2
      eventHandler({
        event: "result",
        runId: "run-full",
        result: createValidEncoderResult("libx265"),
        done: 2,
        total: 2,
      });

      expect(store.getState().results).toHaveLength(2);
      expect(store.getState().done).toBe(2);
      expect(store.getState().total).toBe(2);

      // Event: finished
      const report = createValidReport();
      eventHandler({
        event: "finished",
        runId: "run-full",
        report,
        source: "probe",
      });

      expect(store.getState().status).toBe("ready");
      expect(store.getState().source).toBe("probe");
      expect(store.getState().hwaccels).toEqual(["videotoolbox"]);
      expect(store.getState().results).toEqual(report.encoders);
      expect(store.getState().error).toBeNull();
    });

    it("handles cached capability report completion", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-cached",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      await store.getState().startProbe(false);

      const report = createValidReport();
      eventHandler({
        event: "finished",
        runId: "run-cached",
        report,
        source: "cache",
      });

      expect(store.getState().status).toBe("ready");
      expect(store.getState().source).toBe("cache");
      expect(store.getState().version).toBe("7.1.0");
    });
  });

  describe("Discovery Failure (Promise Rejection)", () => {
    it("sets status to 'missing' when ffmpegPairMissing is rejected", async () => {
      const inspected = [
        {
          ffmpeg: "/usr/bin/ffmpeg",
          ffprobe: "/usr/bin/ffprobe",
          origin: "path" as const,
        },
      ];

      const store = createFfmpegStore({
        subscribeCapabilityProbe: () => Promise.resolve(() => {}),
        startCapabilityProbe: () =>
          Promise.reject(
            new CapabilityProbeError({
              code: "ffmpegPairMissing",
              detail: "No binaries in PATH",
              inspected,
            }),
          ),
      });

      const result = await store.getState().startProbe();

      expect(result).toBeNull();
      expect(store.getState().status).toBe("missing");
      expect(store.getState().error?.code).toBe("ffmpegPairMissing");
      expect(store.getState().error?.detail).toBe("No binaries in PATH");
      expect(store.getState().inspected).toEqual(inspected);
    });

    it("sets status to 'failed' when other error is rejected", async () => {
      const store = createFfmpegStore({
        subscribeCapabilityProbe: () => Promise.resolve(() => {}),
        startCapabilityProbe: () =>
          Promise.reject(
            new CapabilityProbeError({
              code: "commandExecutionFailed",
              detail: "Permission denied",
              exitCode: 126,
            }),
          ),
      });

      const result = await store.getState().startProbe();

      expect(result).toBeNull();
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("commandExecutionFailed");
      expect(store.getState().error?.exitCode).toBe(126);
    });
  });

  describe("Probe Worker Failure (failed Event)", () => {
    it("sets status to 'missing' on failed event with ffmpegPairMissing", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-fail",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      await store.getState().startProbe();

      eventHandler({
        event: "failed",
        runId: "run-fail",
        code: "ffmpegPairMissing",
        detail: "Binary was removed",
      });

      expect(store.getState().status).toBe("missing");
      expect(store.getState().error?.code).toBe("ffmpegPairMissing");
      expect(store.getState().error?.detail).toBe("Binary was removed");
    });

    it("sets status to 'failed' on failed event with ffmpegProcessFailed", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-fail-2",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      await store.getState().startProbe();

      eventHandler({
        event: "failed",
        runId: "run-fail-2",
        code: "ffmpegProcessFailed",
        detail: "Killed by OS",
        exitCode: 137,
      });

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("ffmpegProcessFailed");
      expect(store.getState().error?.exitCode).toBe(137);
    });

    it("treats failed event as terminal: subsequent result events on the same runId are ignored", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-fail-terminal",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      await store.getState().startProbe();
      expect(store.getState().status).toBe("probing");

      eventHandler({
        event: "failed",
        runId: "run-fail-terminal",
        code: "ffmpegProcessFailed",
        detail: "Crashed",
      });

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("ffmpegProcessFailed");

      // Late result on same runId
      eventHandler({
        event: "result",
        runId: "run-fail-terminal",
        result: createValidEncoderResult("libx264"),
        done: 1,
        total: 1,
      });

      // Must not flip status back to probing or add result
      expect(store.getState().status).toBe("failed");
      expect(store.getState().results).toEqual([]);
    });
  });

  describe("Unsubscribe Action", () => {
    it("unsubscribes and allows ensureSubscribed to re-subscribe", async () => {
      const mockUnlisten = vi.fn();
      const mockSubscribe = vi.fn().mockResolvedValue(mockUnlisten);

      const store = createFfmpegStore({
        subscribeCapabilityProbe: mockSubscribe,
      });

      await store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      store.getState().unsubscribe();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);

      await store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    });

    it("invalidates in-flight probe when unsubscribing so a later probe can recover", async () => {
      const req1 = createDeferred<CapabilityProbeStart>();
      const req2 = createDeferred<CapabilityProbeStart>();
      let subscribeCount = 0;
      let activeHandler!: (event: CapabilityProbeEvent) => void;
      const unlisten1 = vi.fn();
      const unlisten2 = vi.fn();

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          activeHandler = handler;
          subscribeCount++;
          return Promise.resolve(subscribeCount === 1 ? unlisten1 : unlisten2);
        },
        startCapabilityProbe: (force) => (force ? req2.promise : req1.promise),
      });

      // Start probe 1
      const p1 = store.getState().startProbe(false);
      await vi.waitFor(() => {
        expect(store.getState().status).toBe("locating");
      });

      // Unsubscribe while probe 1 is in-flight
      store.getState().unsubscribe();
      expect(unlisten1).toHaveBeenCalledTimes(1);

      // In-flight probe 1 resolves after unsubscribe
      req1.resolve({
        runId: "run-1",
        ffmpeg: "/path/to/old-ffmpeg",
        ffprobe: "/path/to/old-ffprobe",
        origin: "path",
      });

      const res1 = await p1;
      // In-flight probe 1 was invalidated and returned null
      expect(res1).toBeNull();
      // Store state was not flipped to probing by run-1
      expect(store.getState().runId).toBeNull();
      expect(store.getState().status).not.toBe("probing");

      // Later startProbe should recover and succeed
      const p2 = store.getState().startProbe(true);
      req2.resolve({
        runId: "run-2",
        ffmpeg: "/path/to/new-ffmpeg",
        ffprobe: "/path/to/new-ffprobe",
        origin: "configured",
      });

      const res2 = await p2;
      expect(res2?.runId).toBe("run-2");
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().status).toBe("probing");

      // Verify new events are processed properly for the recovered probe
      activeHandler({
        event: "finished",
        runId: "run-2",
        report: createValidReport(),
        source: "probe",
      });

      expect(store.getState().status).toBe("ready");
    });
  });

  describe("Reset Action", () => {
    it("resets store state to idle and clears active run", async () => {
      let eventHandler!: (event: CapabilityProbeEvent) => void;

      const store = createFfmpegStore({
        subscribeCapabilityProbe: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startCapabilityProbe: () =>
          Promise.resolve({
            runId: "run-reset",
            ffmpeg: "/usr/bin/ffmpeg",
            ffprobe: "/usr/bin/ffprobe",
            origin: "path",
          }),
      });

      await store.getState().startProbe();
      expect(store.getState().status).toBe("probing");

      store.getState().reset();

      expect(store.getState().status).toBe("idle");
      expect(store.getState().runId).toBeNull();
      expect(store.getState().paths).toBeNull();

      // Subsequent events from the old run are ignored
      eventHandler({
        event: "finished",
        runId: "run-reset",
        report: createValidReport(),
        source: "probe",
      });

      expect(store.getState().status).toBe("idle");
      expect(store.getState().version).toBeNull();
    });

    it("invalidates in-flight startProbe commands on reset", async () => {
      const deferred = createDeferred<CapabilityProbeStart>();

      const store = createFfmpegStore({
        subscribeCapabilityProbe: () => Promise.resolve(() => {}),
        startCapabilityProbe: () => deferred.promise,
      });

      const startPromise = store.getState().startProbe();
      expect(store.getState().status).toBe("locating");

      store.getState().reset();
      expect(store.getState().status).toBe("idle");

      deferred.resolve({
        runId: "late-run",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      });

      const result = await startPromise;
      expect(result).toBeNull();
      expect(store.getState().status).toBe("idle");
      expect(store.getState().runId).toBeNull();
    });
  });

  describe("Concurrent startProbe Requests (Latest-Wins)", () => {
    it("discards stale command resolutions from earlier requests", async () => {
      const req1 = createDeferred<CapabilityProbeStart>();
      const req2 = createDeferred<CapabilityProbeStart>();

      const store = createFfmpegStore({
        subscribeCapabilityProbe: () => Promise.resolve(() => {}),
        startCapabilityProbe: (force) => (force ? req2.promise : req1.promise),
      });

      const p1 = store.getState().startProbe(false);
      const p2 = store.getState().startProbe(true);

      const start2: CapabilityProbeStart = {
        runId: "run-2",
        ffmpeg: "/usr/bin/ffmpeg",
        ffprobe: "/usr/bin/ffprobe",
        origin: "path",
      };

      // Req2 (newer) finishes first
      req2.resolve(start2);
      const res2 = await p2;
      expect(res2).toEqual(start2);
      expect(store.getState().runId).toBe("run-2");

      // Req1 (older) finishes later
      req1.resolve({
        runId: "run-1",
        ffmpeg: "/opt/bin/ffmpeg",
        ffprobe: "/opt/bin/ffprobe",
        origin: "configured",
      });
      const res1 = await p1;

      expect(res1).toBeNull();
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().paths?.ffmpeg).toBe("/usr/bin/ffmpeg");
    });
  });

  describe("Default Singleton Store", () => {
    it("provides a default singleton store instance in idle state", () => {
      const state = ffmpegStore.getState();
      expect(state.status).toBe("idle");
      expect(typeof state.startProbe).toBe("function");
      expect(typeof state.reset).toBe("function");
      expect(typeof state.ensureSubscribed).toBe("function");
      expect(typeof state.unsubscribe).toBe("function");
    });
  });
});
