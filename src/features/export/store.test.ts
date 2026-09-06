import { describe, expect, it, vi } from "vitest";
import type { Pts } from "@/types/project";
import { createExportStore, exportStore, useExportStore } from "./store";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportStart,
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

function createValidRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    sourcePath: "/media/source.mp4",
    outputPath: "/media/output.mp4",
    segments: [
      {
        inPts: "0" as Pts,
        outPts: "1000" as Pts,
      },
    ],
    presetId: "mp4-h264",
    ...overrides,
  };
}

function createValidStartResult(overrides: Partial<ExportStart> = {}): ExportStart {
  return {
    runId: "run-export-1",
    presetId: "mp4-h264",
    outputPath: "/media/output.mp4",
    segmentCount: 1,
    totalDurationUs: 5_000_000,
    expectedFrames: 150,
    ...overrides,
  };
}

describe("Media Export Store", () => {
  describe("Initial State", () => {
    it("starts with idle status and clean state", () => {
      const store = createExportStore();
      const state = store.getState();

      expect(state.status).toBe("idle");
      expect(state.runId).toBeNull();
      expect(state.outputPath).toBeNull();
      expect(state.segmentCount).toBe(0);
      expect(state.frame).toBeNull();
      expect(state.expectedFrames).toBeNull();
      expect(state.error).toBeNull();
    });

    it("respects optional initial state overrides", () => {
      const store = createExportStore(
        {},
        {
          status: "running",
          runId: "pre-set-run",
          outputPath: "/pre/output.mp4",
          segmentCount: 3,
          frame: 50,
          expectedFrames: 100,
        },
      );
      const state = store.getState();

      expect(state.status).toBe("running");
      expect(state.runId).toBe("pre-set-run");
      expect(state.outputPath).toBe("/pre/output.mp4");
      expect(state.segmentCount).toBe(3);
      expect(state.frame).toBe(50);
      expect(state.expectedFrames).toBe(100);
    });
  });

  describe("Acceptance Criterion: Subscribe Before Invoke", () => {
    it("subscribes to backend events BEFORE invoking the start_export command", async () => {
      const sub = createDeferred<() => void>();
      const mockSubscribe = vi.fn(() => sub.promise);
      const mockStart = vi.fn().mockResolvedValue(createValidStartResult());

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
        startExport: mockStart,
      });

      const p = store.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(mockStart).not.toHaveBeenCalled();
      sub.resolve(() => {});
      await p;
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("Subscription Failure & Recovery", () => {
    it("normalizes subscription rejection, sets error state, and re-subscribes on a second startExport", async () => {
      let shouldFail = true;
      const mockSubscribe = vi.fn().mockImplementation(() => {
        if (shouldFail) {
          return Promise.reject(new Error("Event listener failed to initialize"));
        }
        return Promise.resolve(() => {});
      });

      const mockStart = vi
        .fn()
        .mockResolvedValue(createValidStartResult({ runId: "run-recovered" }));

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
        startExport: mockStart,
      });

      // First call fails during subscription
      const result1 = await store.getState().startExport(createValidRequest());

      expect(result1).toBeNull();
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("unknown");
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockStart).not.toHaveBeenCalled();

      // Second call succeeds because rejected promise memo was cleared
      shouldFail = false;
      const result2 = await store.getState().startExport(createValidRequest());

      expect(result2?.runId).toBe("run-recovered");
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
      expect(mockStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("Early Event Buffering", () => {
    it("buffers events emitted during startExport invocation and replays them once runId is known", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () => {
          // Emit early events BEFORE startExport resolves
          eventHandler({
            event: "started",
            runId: "run-early",
            outputPath: "/media/out.mp4",
            segmentCount: 1,
            totalDurationUs: 5_000_000,
            expectedFrames: 150,
          });
          eventHandler({
            event: "progress",
            runId: "run-early",
            frame: 10,
            expectedFrames: 150,
          });
          return Promise.resolve(createValidStartResult({ runId: "run-early" }));
        },
      });

      const result = await store.getState().startExport(createValidRequest());

      expect(result?.runId).toBe("run-early");
      expect(store.getState().status).toBe("running");
      expect(store.getState().frame).toBe(10);
      expect(store.getState().expectedFrames).toBe(150);
    });

    it("discards buffered early events from superseded requests", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;
      const req1 = createDeferred<ExportStart>();
      const req2 = createDeferred<ExportStart>();

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: (req) => (req.presetId === "req2" ? req2.promise : req1.promise),
      });

      const p1 = store.getState().startExport(createValidRequest({ presetId: "req1" }));
      const p2 = store.getState().startExport(createValidRequest({ presetId: "req2" }));

      // Early event emitted for run-1 while both are in flight
      eventHandler({
        event: "started",
        runId: "run-1",
        outputPath: "/old/output.mp4",
        segmentCount: 1,
        totalDurationUs: 1_000_000,
      });

      // Req2 resolves first
      req2.resolve(
        createValidStartResult({ runId: "run-2", outputPath: "/new/output.mp4" }),
      );

      await p2;
      expect(store.getState().runId).toBe("run-2");

      // Req1 resolves later
      req1.resolve(
        createValidStartResult({ runId: "run-1", outputPath: "/old/output.mp4" }),
      );

      const res1 = await p1;
      expect(res1).toBeNull();
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().outputPath).toBe("/new/output.mp4");
    });

    it("preserves winning run buffering state when a superseded run cleans up", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;
      const subDeferred = createDeferred<() => void>();
      const reqB = createDeferred<ExportStart>();

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return subDeferred.promise;
        },
        startExport: (req) => {
          if (req.presetId === "B") {
            return reqB.promise;
          }
          return Promise.resolve(createValidStartResult({ runId: "run-A" }));
        },
      });

      // 1. Start run A (subscribe deferred so it stays in flight)
      const p1 = store.getState().startExport(createValidRequest({ presetId: "A" }));

      // 2. Start run B so it supersedes A
      const p2 = store.getState().startExport(createValidRequest({ presetId: "B" }));

      // 3. Let A resume and hit its supersede branch
      subDeferred.resolve(() => {});
      const resA = await p1;
      expect(resA).toBeNull();

      // 4. Emit an early event for run B BEFORE B's invoke resolves
      eventHandler({
        event: "started",
        runId: "run-B",
        outputPath: "/media/out-b.mp4",
        segmentCount: 2,
        totalDurationUs: 8_000_000,
        expectedFrames: 240,
      });

      // 5. Resolve B's invoke
      reqB.resolve(
        createValidStartResult({
          runId: "run-B",
          outputPath: "/media/out-b.mp4",
          segmentCount: 2,
          totalDurationUs: 8_000_000,
          expectedFrames: 240,
        }),
      );

      const resB = await p2;
      expect(resB?.runId).toBe("run-B");

      // 6. Assert the event reached the store
      expect(store.getState().status).toBe("running");
      expect(store.getState().runId).toBe("run-B");
      expect(store.getState().segmentCount).toBe(2);
      expect(store.getState().expectedFrames).toBe(240);
    });
  });

  describe("Stale runId Ignored", () => {
    it("ignores events from older runs when a newer run is active", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: (req) =>
          Promise.resolve(
            createValidStartResult({
              runId: req.presetId === "run2" ? "run-2" : "run-1",
            }),
          ),
      });

      // Start run 1
      await store.getState().startExport(createValidRequest({ presetId: "run1" }));
      expect(store.getState().runId).toBe("run-1");

      eventHandler({
        event: "started",
        runId: "run-1",
        outputPath: "/out1.mp4",
        segmentCount: 1,
        totalDurationUs: 1000,
      });
      expect(store.getState().status).toBe("running");

      // Start run 2 (supersedes run 1)
      await store.getState().startExport(createValidRequest({ presetId: "run2" }));
      expect(store.getState().runId).toBe("run-2");

      // Late publishing event arrives from superseded run 1
      eventHandler({
        event: "publishing",
        runId: "run-1",
      });

      // State MUST NOT be updated by run-1's publishing event
      expect(store.getState().status).not.toBe("publishing");
      expect(store.getState().runId).toBe("run-2");

      // Event for run 2 is applied
      eventHandler({
        event: "started",
        runId: "run-2",
        outputPath: "/out2.mp4",
        segmentCount: 2,
        totalDurationUs: 2000,
      });
      expect(store.getState().status).toBe("running");
      expect(store.getState().outputPath).toBe("/out2.mp4");
    });
  });

  describe("ensureSubscribed Idempotence & Memoization", () => {
    it("creates exactly one subscription across multiple sequential startExport calls", async () => {
      const mockSubscribe = vi.fn().mockResolvedValue(() => {});
      const mockStart = vi.fn().mockResolvedValue(createValidStartResult());

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
        startExport: mockStart,
      });

      await store.getState().startExport(createValidRequest());
      await store.getState().startExport(createValidRequest());
      await store.getState().ensureSubscribed();

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    it("memoizes in-flight subscription promise under concurrent startExport calls", async () => {
      const mockSubscribe = vi.fn(
        () => new Promise<() => void>((r) => setTimeout(() => r(() => {}), 5)),
      );
      const mockStart = vi.fn().mockResolvedValue(createValidStartResult());

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
        startExport: mockStart,
      });

      await Promise.all([
        store.getState().startExport(createValidRequest()),
        store.getState().startExport(createValidRequest()),
      ]);

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("Full Export Lifecycle", () => {
    it("transitions through idle -> preparing -> running -> publishing -> finished", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(
            createValidStartResult({
              runId: "run-full",
              outputPath: "/media/rendered.mp4",
              segmentCount: 3,
              totalDurationUs: 10_000_000,
              expectedFrames: 300,
            }),
          ),
      });

      // 1. Start export -> preparing
      const startPromise = store.getState().startExport(createValidRequest());
      expect(store.getState().status).toBe("preparing");

      const startResult = await startPromise;
      expect(startResult?.runId).toBe("run-full");
      expect(store.getState().runId).toBe("run-full");

      // 2. Event: started -> running
      eventHandler({
        event: "started",
        runId: "run-full",
        outputPath: "/media/rendered.mp4",
        segmentCount: 3,
        totalDurationUs: 10_000_000,
        expectedFrames: 300,
      });
      expect(store.getState().status).toBe("running");
      expect(store.getState().outputPath).toBe("/media/rendered.mp4");
      expect(store.getState().segmentCount).toBe(3);
      expect(store.getState().expectedFrames).toBe(300);

      // 3. Event: progress
      eventHandler({
        event: "progress",
        runId: "run-full",
        frame: 150,
        expectedFrames: 300,
        fps: { n: 60, d: 1 },
        speed: { n: 2, d: 1 },
        totalSize: 4096000,
      });
      expect(store.getState().frame).toBe(150);
      expect(store.getState().expectedFrames).toBe(300);

      // 4. Event: publishing -> publishing
      eventHandler({
        event: "publishing",
        runId: "run-full",
      });
      expect(store.getState().status).toBe("publishing");

      // 5. Event: finished -> finished
      eventHandler({
        event: "finished",
        runId: "run-full",
        outputPath: "/media/rendered.mp4",
        frames: 300,
      });
      expect(store.getState().status).toBe("finished");
      expect(store.getState().outputPath).toBe("/media/rendered.mp4");
      expect(store.getState().frame).toBe(300);
      expect(store.getState().error).toBeNull();
    });
  });

  describe("Failure and Cancellation Transitions", () => {
    it("sets status to 'failed' on backend failed event", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-fail" })),
      });

      await store.getState().startExport(createValidRequest());

      eventHandler({
        event: "failed",
        runId: "run-fail",
        code: "encoderUnavailable",
        detail: "VideoToolbox failed to initialize",
        exitCode: 1,
        encoder: "h264_videotoolbox",
      });

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error).toBeInstanceOf(ExportError);
      expect(store.getState().error?.code).toBe("encoderUnavailable");
      expect(store.getState().error?.detail).toBe("VideoToolbox failed to initialize");
      expect(store.getState().error?.exitCode).toBe(1);
      expect(store.getState().error?.encoder).toBe("h264_videotoolbox");
    });

    it("sets status to 'canceled' when failed event has code 'canceled'", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-cancel" })),
      });

      await store.getState().startExport(createValidRequest());

      eventHandler({
        event: "failed",
        runId: "run-cancel",
        code: "canceled",
      });

      expect(store.getState().status).toBe("canceled");
      expect(store.getState().error?.code).toBe("canceled");
    });

    it("treats failed event as terminal: subsequent events on the same runId are ignored", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-terminal" })),
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-terminal");

      eventHandler({
        event: "failed",
        runId: "run-terminal",
        code: "ffmpegProcessFailed",
        detail: "Signal 9",
        exitCode: 137,
      });

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("ffmpegProcessFailed");

      // Late progress event on same runId
      eventHandler({
        event: "progress",
        runId: "run-terminal",
        frame: 100,
      });

      // Status must not flip back to running or update frame
      expect(store.getState().status).toBe("failed");
      expect(store.getState().frame).toBeNull();
    });

    it("normalizes startExport promise rejection and sets status to 'failed'", async () => {
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.reject(
            new ExportError({
              code: "sourceNotFound",
              detail: "File /media/missing.mp4 does not exist",
            }),
          ),
      });

      const result = await store.getState().startExport(createValidRequest());

      expect(result).toBeNull();
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("sourceNotFound");
      expect(store.getState().error?.detail).toBe(
        "File /media/missing.mp4 does not exist",
      );
    });

    it("sets status to 'canceled' when startExport promise rejects with canceled code", async () => {
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.reject(
            new ExportError({
              code: "canceled",
            }),
          ),
      });

      const result = await store.getState().startExport(createValidRequest());

      expect(result).toBeNull();
      expect(store.getState().status).toBe("canceled");
      expect(store.getState().error?.code).toBe("canceled");
    });

    it("ignores rejection from a superseded startExport call so it does not overwrite the successor state", async () => {
      const req1 = createDeferred<ExportStart>();
      const req2 = createDeferred<ExportStart>();
      const req1Started = createDeferred<void>();

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: (req) => {
          if (req.presetId === "req1") {
            req1Started.resolve();
            return req1.promise;
          }
          return req2.promise;
        },
      });

      const p1 = store.getState().startExport(createValidRequest({ presetId: "req1" }));
      await req1Started.promise;

      const p2 = store.getState().startExport(createValidRequest({ presetId: "req2" }));

      req2.resolve(
        createValidStartResult({ runId: "run-2", outputPath: "/new/output.mp4" }),
      );
      const res2 = await p2;
      expect(res2?.runId).toBe("run-2");
      expect(store.getState().runId).toBe("run-2");

      req1.reject(
        new ExportError({
          code: "ffmpegProcessFailed",
          detail: "Stale superseded failure",
        }),
      );
      const res1 = await p1;

      expect(res1).toBeNull();
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().status).not.toBe("failed");
      expect(store.getState().error).toBeNull();
    });
  });

  describe("cancelExport Action", () => {
    it("returns false immediately when there is no active run", async () => {
      const mockCancel = vi.fn();
      const store = createExportStore({
        cancelExport: mockCancel,
      });

      const result = await store.getState().cancelExport();

      expect(result).toBe(false);
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it("invokes cancelExport with active runId and returns true", async () => {
      const mockCancel = vi.fn().mockResolvedValue(true);
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-to-cancel" })),
        cancelExport: mockCancel,
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-to-cancel");

      const result = await store.getState().cancelExport();

      expect(result).toBe(true);
      expect(mockCancel).toHaveBeenCalledWith("run-to-cancel");
    });

    it("handles cancelExport rejection by reporting error and returning false", async () => {
      const mockCancel = vi.fn().mockRejectedValue(new Error("IPC failed"));
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-cancel-fail" })),
        cancelExport: mockCancel,
      });

      await store.getState().startExport(createValidRequest());

      const result = await store.getState().cancelExport();

      expect(result).toBe(false);
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("unknown");
    });

    it("keeps tracking an active run when cancelExport rejects, allowing subsequent events and retried cancel", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;
      let cancelCallCount = 0;
      const mockCancel = vi.fn().mockImplementation(() => {
        cancelCallCount++;
        if (cancelCallCount === 1) {
          return Promise.reject(new Error("IPC failed"));
        }
        return Promise.resolve(true);
      });

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-cancel-retry" })),
        cancelExport: mockCancel,
      });

      // 1. Establish a run
      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-cancel-retry");

      // 2. Make the cancel invoke reject
      const result1 = await store.getState().cancelExport();
      expect(result1).toBe(false);
      expect(store.getState().status).toBe("failed");
      expect(store.getState().runId).toBe("run-cancel-retry");

      // 3. Second cancelExport() must still reach the injected cancel function
      const result2 = await store.getState().cancelExport();
      expect(result2).toBe(true);
      expect(mockCancel).toHaveBeenCalledTimes(2);
      expect(mockCancel).toHaveBeenNthCalledWith(1, "run-cancel-retry");
      expect(mockCancel).toHaveBeenNthCalledWith(2, "run-cancel-retry");

      // 4. Following finished event for the same runId must still be applied
      eventHandler({
        event: "finished",
        runId: "run-cancel-retry",
        outputPath: "/media/output.mp4",
        frames: 150,
      });

      expect(store.getState().status).toBe("finished");
      expect(store.getState().outputPath).toBe("/media/output.mp4");
      expect(store.getState().frame).toBe(150);
      expect(store.getState().error).toBeNull();
    });

    it("does not report error if active run changed while cancelExport was in flight", async () => {
      const cancelDeferred = createDeferred<boolean>();
      const mockCancel = vi.fn().mockReturnValue(cancelDeferred.promise);

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: (req) =>
          Promise.resolve(
            createValidStartResult({
              runId: req.presetId === "run2" ? "run-2" : "run-1",
            }),
          ),
        cancelExport: mockCancel,
      });

      await store.getState().startExport(createValidRequest({ presetId: "run1" }));
      expect(store.getState().runId).toBe("run-1");

      const cancelPromise = store.getState().cancelExport();

      await store.getState().startExport(createValidRequest({ presetId: "run2" }));
      expect(store.getState().runId).toBe("run-2");

      cancelDeferred.reject(new Error("Stale cancel failure"));
      const cancelResult = await cancelPromise;

      expect(cancelResult).toBe(false);
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().status).not.toBe("failed");
      expect(store.getState().error).toBeNull();
    });
  });

  describe("reportError Action", () => {
    it("normalizes errors and sets status failed for frontend error codes", () => {
      const store = createExportStore();

      store.getState().reportError(new ExportError({ code: "dialogFailed" }));

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("dialogFailed");
      expect(store.getState().error?.detail).toBeUndefined();
    });

    it("sets status canceled when normalized error code is canceled", () => {
      const store = createExportStore();

      store.getState().reportError({ code: "canceled" });

      expect(store.getState().status).toBe("canceled");
      expect(store.getState().error?.code).toBe("canceled");
    });

    it("invalidates in-flight startExport calls so late completions do not overwrite error", async () => {
      const startDeferred = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
      });

      const p = store.getState().startExport(createValidRequest());

      // Report error while startExport is in flight
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("dialogFailed");

      // Late resolution of startExport
      startDeferred.resolve(createValidStartResult());
      const res = await p;

      expect(res).toBeNull();
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("dialogFailed");
    });
  });

  describe("Reset Action", () => {
    it("resets store state to idle and clears active run and buffers", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-to-reset" })),
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-to-reset");

      store.getState().reset();

      const state = store.getState();
      expect(state.status).toBe("idle");
      expect(state.runId).toBeNull();
      expect(state.outputPath).toBeNull();
      expect(state.segmentCount).toBe(0);
      expect(state.frame).toBeNull();
      expect(state.expectedFrames).toBeNull();
      expect(state.error).toBeNull();

      // Subsequent events on the reset runId are ignored
      eventHandler({
        event: "progress",
        runId: "run-to-reset",
        frame: 100,
      });

      expect(store.getState().status).toBe("idle");
      expect(store.getState().frame).toBeNull();
    });

    it("invalidates in-flight startExport commands on reset", async () => {
      const deferred = createDeferred<ExportStart>();

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => deferred.promise,
      });

      const startPromise = store.getState().startExport(createValidRequest());
      expect(store.getState().status).toBe("preparing");

      store.getState().reset();
      expect(store.getState().status).toBe("idle");

      deferred.resolve(
        createValidStartResult({
          runId: "late-run",
          outputPath: "/media/late.mp4",
        }),
      );

      const result = await startPromise;
      expect(result).toBeNull();
      expect(store.getState().status).toBe("idle");
      expect(store.getState().runId).toBeNull();
    });
  });

  describe("Unsubscribe Action", () => {
    it("unsubscribes and allows ensureSubscribed to re-subscribe", async () => {
      const mockUnlisten = vi.fn();
      const mockSubscribe = vi.fn().mockResolvedValue(mockUnlisten);

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
      });

      await store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      store.getState().unsubscribe();
      expect(mockUnlisten).toHaveBeenCalledTimes(1);

      await store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    });

    it("invalidates in-flight export when unsubscribing so a later export can recover", async () => {
      const req1 = createDeferred<ExportStart>();
      const req2 = createDeferred<ExportStart>();
      let subscribeCount = 0;
      let activeHandler!: (event: ExportProgressEvent) => void;
      const unlisten1 = vi.fn();
      const unlisten2 = vi.fn();

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          activeHandler = handler;
          subscribeCount++;
          return Promise.resolve(subscribeCount === 1 ? unlisten1 : unlisten2);
        },
        startExport: (req) => (req.presetId === "two" ? req2.promise : req1.promise),
      });

      // Start export 1
      const p1 = store.getState().startExport(createValidRequest({ presetId: "one" }));
      await vi.waitFor(() => {
        expect(store.getState().status).toBe("preparing");
      });

      // Unsubscribe while export 1 is in-flight
      store.getState().unsubscribe();
      expect(unlisten1).toHaveBeenCalledTimes(1);

      // In-flight export 1 resolves after unsubscribe
      req1.resolve(createValidStartResult({ runId: "run-1" }));

      const res1 = await p1;
      expect(res1).toBeNull();
      expect(store.getState().runId).toBeNull();

      // Later startExport recovers and succeeds
      const p2 = store.getState().startExport(createValidRequest({ presetId: "two" }));
      req2.resolve(createValidStartResult({ runId: "run-2" }));

      const res2 = await p2;
      expect(res2?.runId).toBe("run-2");
      expect(store.getState().runId).toBe("run-2");

      activeHandler({
        event: "started",
        runId: "run-2",
        outputPath: "/media/out.mp4",
        segmentCount: 1,
        totalDurationUs: 1000,
      });
      expect(store.getState().status).toBe("running");
    });

    it("unsubscribes and cleans up in-flight listener when unsubscribed before subscribe resolves", async () => {
      const subDeferred = createDeferred<() => void>();
      const unlisten = vi.fn();
      const mockSubscribe = vi.fn(() => subDeferred.promise);

      const store = createExportStore({
        subscribeExportProgress: mockSubscribe,
      });

      const subscribePromise = store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);

      store.getState().unsubscribe();

      subDeferred.resolve(unlisten);
      await subscribePromise;

      expect(unlisten).toHaveBeenCalledTimes(1);

      const nextUnlisten = vi.fn();
      mockSubscribe.mockResolvedValueOnce(nextUnlisten);
      await store.getState().ensureSubscribed();
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
    });
  });

  describe("Default Singleton Store & Hook", () => {
    it("provides a default singleton store instance in idle state", () => {
      const state = exportStore.getState();
      expect(state.status).toBe("idle");
      expect(state.runId).toBeNull();
      expect(state.outputPath).toBeNull();
      expect(state.segmentCount).toBe(0);
      expect(state.frame).toBeNull();
      expect(state.expectedFrames).toBeNull();
      expect(state.error).toBeNull();
      expect(typeof state.startExport).toBe("function");
      expect(typeof state.cancelExport).toBe("function");
      expect(typeof state.reset).toBe("function");
      expect(typeof state.ensureSubscribed).toBe("function");
      expect(typeof state.unsubscribe).toBe("function");
      expect(typeof state.reportError).toBe("function");
    });

    it("exports useExportStore hook function", () => {
      expect(typeof useExportStore).toBe("function");
    });
  });
});
