import { describe, expect, it, vi } from "vitest";
import type { Pts } from "@/types/project";
import {
  cancelActiveExport as clientCancelActiveExport,
  cancelExport as clientCancelExport,
} from "./client";
import { isExportRunLive } from "./runState";
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
      expect(state.fps).toBeNull();
      expect(state.speed).toBeNull();
      expect(state.cancelRequested).toBe(false);
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
          fps: { n: 30, d: 1 },
          speed: { n: 1, d: 1 },
          cancelRequested: true,
        },
      );
      const state = store.getState();

      expect(state.status).toBe("running");
      expect(state.runId).toBe("pre-set-run");
      expect(state.outputPath).toBe("/pre/output.mp4");
      expect(state.segmentCount).toBe(3);
      expect(state.frame).toBe(50);
      expect(state.expectedFrames).toBe(100);
      expect(state.fps).toEqual({ n: 30, d: 1 });
      expect(state.speed).toEqual({ n: 1, d: 1 });
      expect(state.cancelRequested).toBe(true);
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
      // The backend still encodes the run, so the store keeps it.
      expect(store.getState().tracking).toBe(true);
    });

    it("tracks a run from the start until its final event or a reset", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-tracked" })),
      });
      expect(store.getState().tracking).toBe(false);

      await store.getState().startExport(createValidRequest());
      expect(store.getState().tracking).toBe(true);

      eventHandler({
        event: "failed",
        runId: "run-tracked",
        code: "ffmpegProcessFailed",
      });
      expect(store.getState().status).toBe("failed");
      expect(store.getState().tracking).toBe(false);

      await store.getState().startExport(createValidRequest());
      expect(store.getState().tracking).toBe(true);
      eventHandler({
        event: "finished",
        runId: "run-tracked",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      expect(store.getState().tracking).toBe(false);

      await store.getState().startExport(createValidRequest());
      store.getState().reset();
      expect(store.getState().tracking).toBe(false);
    });

    it("leaves the tracking alone when a late event names an older run", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: (req) =>
          Promise.resolve(
            createValidStartResult({
              runId: req.presetId === "second" ? "run-new" : "run-old",
            }),
          ),
      });

      await store.getState().startExport(createValidRequest({ presetId: "first" }));
      await store.getState().startExport(createValidRequest({ presetId: "second" }));
      expect(store.getState().runId).toBe("run-new");
      expect(store.getState().tracking).toBe(true);

      eventHandler({ event: "failed", runId: "run-old", code: "ffmpegProcessFailed" });
      eventHandler({
        event: "finished",
        runId: "run-old",
        outputPath: "/media/old.mp4",
        frames: 10,
      });

      expect(store.getState().tracking).toBe(true);
      expect(store.getState().runId).toBe("run-new");
      expect(store.getState().status).toBe("preparing");

      store.getState().reset();
      eventHandler({ event: "failed", runId: "run-new", code: "ffmpegProcessFailed" });

      expect(store.getState().tracking).toBe(false);
      expect(store.getState().status).toBe("idle");
    });

    it("drops the old run at once when a new start begins, and tracks the new start", async () => {
      let answerSecond: (start: ExportStart) => void = () => {};
      let calls = 0;
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve(createValidStartResult({ runId: "run-first" }));
          }
          return new Promise<ExportStart>((resolve) => {
            answerSecond = resolve;
          });
        },
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().tracking).toBe(true);

      const second = store.getState().startExport(createValidRequest());
      // The store tracks the new start before it has a run id. The old run is gone.
      expect(store.getState().runId).toBeNull();
      expect(store.getState().tracking).toBe(true);

      await vi.waitFor(() => {
        expect(calls).toBe(2);
      });
      answerSecond(createValidStartResult({ runId: "run-second" }));
      await second;
      expect(store.getState().runId).toBe("run-second");
      expect(store.getState().tracking).toBe(true);
    });

    it("tracks a start that waits for its run id", async () => {
      const startDeferred = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
      });

      const starting = store.getState().startExport(createValidRequest());

      // The backend claims the export slot before it answers, so the start is already a
      // run that a reset would drop.
      expect(store.getState()).toMatchObject({
        status: "preparing",
        runId: null,
        tracking: true,
      });

      startDeferred.resolve(createValidStartResult({ runId: "run-answered" }));
      await starting;
      expect(store.getState()).toMatchObject({ runId: "run-answered", tracking: true });
    });

    it("does not track a run whose start rejected", async () => {
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => Promise.reject(new ExportError({ code: "outputReadOnly" })),
      });

      await store.getState().startExport(createValidRequest());

      expect(store.getState().status).toBe("failed");
      expect(store.getState().tracking).toBe(false);
    });

    it("derives the initial tracking from the initial run id", () => {
      expect(createExportStore({}, { runId: "run-1" }).getState().tracking).toBe(true);
      expect(createExportStore({}, { status: "failed" }).getState().tracking).toBe(
        false,
      );
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

    it("cancels by export slot while preparing has produced no run id", async () => {
      // The fault this closes: `start_export` claims the single export slot, prepares -- a
      // re-probe alone is bounded at 30 seconds -- and answers with the run id only
      // afterward. For that window the store holds no id, so `cancelExport` has nothing to
      // name and the user could not stop a run that was already holding the slot.
      const startDeferred = createDeferred<ExportStart>();
      const mockCancel = vi.fn();
      const mockCancelActive = vi.fn().mockResolvedValue(true);

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
        cancelExport: mockCancel,
        cancelActiveExport: mockCancelActive,
      });

      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().runId).toBeNull();

      const result = await store.getState().cancelExport();

      expect(result).toBe(true);
      expect(mockCancelActive).toHaveBeenCalledTimes(1);
      expect(mockCancelActive).toHaveBeenCalledWith();
      expect(mockCancel).not.toHaveBeenCalled();

      startDeferred.resolve(createValidStartResult());
      await startPromise;
    });

    it("cancels by run id as soon as preparing has one, never by slot", async () => {
      const mockCancel = vi.fn().mockResolvedValue(true);
      const mockCancelActive = vi.fn();

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-named" })),
        cancelExport: mockCancel,
        cancelActiveExport: mockCancelActive,
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-named");

      const result = await store.getState().cancelExport();

      expect(result).toBe(true);
      expect(mockCancel).toHaveBeenCalledWith("run-named");
      expect(mockCancelActive).not.toHaveBeenCalled();
    });

    it("does not cancel by slot in a status with no run to stop", async () => {
      const mockCancelActive = vi.fn();
      const store = createExportStore(
        {
          cancelExport: vi.fn(),
          cancelActiveExport: mockCancelActive,
        },
        { status: "failed" },
      );

      expect(await store.getState().cancelExport()).toBe(false);
      expect(mockCancelActive).not.toHaveBeenCalled();
    });

    it("reports a slot cancel that rejects while the start is still in flight", async () => {
      const startDeferred = createDeferred<ExportStart>();
      const mockCancelActive = vi.fn().mockRejectedValue(new Error("IPC failed"));

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
        cancelExport: vi.fn(),
        cancelActiveExport: mockCancelActive,
      });

      void store.getState().startExport(createValidRequest());
      await Promise.resolve();

      expect(await store.getState().cancelExport()).toBe(false);
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("unknown");
      // The report keeps the start: the backend did not confirm the stop.
      expect(store.getState().runId).toBeNull();
      expect(store.getState().tracking).toBe(true);
      expect(store.getState().cancelRequested).toBe(false);
    });

    it("does not report a slot cancel that rejects after the store was reset", async () => {
      // The start fails on its own while a by-slot cancel is pending, and the user closes the
      // result, which resets the store. A failure that landed afterward would put an error
      // back on a dialog the user closed.
      const cancelDeferred = createDeferred<boolean>();
      const startDeferred = createDeferred<ExportStart>();

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
        cancelExport: vi.fn(),
        cancelActiveExport: () => cancelDeferred.promise,
      });

      void store.getState().startExport(createValidRequest());
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      store.getState().reset();
      cancelDeferred.reject(new Error("IPC failed"));

      expect(await cancelPromise).toBe(false);
      expect(store.getState().status).toBe("idle");
      expect(store.getState().error).toBeNull();
    });

    it("does not report a slot cancel that rejects after a reset and a new start", async () => {
      // "preparing" with no run id is not an identity: every start passes through it. A
      // rejection matched on the status alone would land in the run that started after the
      // reset, and `reportError` would invalidate that start's request id -- leaving a live
      // run the store holds no id for and the by-slot path itself would then refuse.
      const cancelDeferred = createDeferred<boolean>();
      const secondStart = createDeferred<ExportStart>();
      const secondRequest = createValidRequest({ outputPath: "/media/output-2.mp4" });
      // Key the deferred by request, not by call order. The first start is superseded while it
      // still awaits the subscription, so it returns before it ever reaches the command: a
      // queue shifted once per call would hand the first run's deferred to the second run and
      // leave this test awaiting a promise nothing resolves.
      const mockStart = vi.fn((request: ExportRequest) => {
        if (request.outputPath !== secondRequest.outputPath) {
          return Promise.reject(new Error("the superseded start reached the command"));
        }
        return secondStart.promise;
      });
      const mockCancelActive = vi
        .fn()
        .mockImplementationOnce(() => cancelDeferred.promise)
        .mockImplementationOnce(() => Promise.resolve(true));

      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: mockStart,
        cancelExport: vi.fn(),
        cancelActiveExport: mockCancelActive,
      });

      void store.getState().startExport(createValidRequest());
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      store.getState().reset();

      const secondStartPromise = store.getState().startExport(secondRequest);
      await Promise.resolve();
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().runId).toBeNull();

      cancelDeferred.reject(new Error("IPC failed"));
      expect(await cancelPromise).toBe(false);

      // The stale rejection belongs to the run the reset discarded, not to this one.
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().error).toBeNull();

      // The new run stays cancellable by slot ...
      expect(await store.getState().cancelExport()).toBe(true);
      expect(mockCancelActive).toHaveBeenCalledTimes(2);

      // ... and still learns its run id, so it is cancellable by id afterward.
      secondStart.resolve(createValidStartResult({ runId: "run-2" }));
      await secondStartPromise;
      expect(store.getState().runId).toBe("run-2");

      // Only the surviving run reached the command.
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledWith(secondRequest);
    });
  });

  describe("a slot cancel that the IPC layer rejects while the start waits for its run id", () => {
    /**
     * A store whose start waits until the test answers it, and whose `cancel_active_export`
     * goes through the real client with an invoke that rejects, as a closed IPC channel does.
     * `emit` sends an `export:progress` event to the store.
     */
    function createStoreWithFailingSlotCancel() {
      let emit!: (event: ExportProgressEvent) => void;
      const startDeferred = createDeferred<ExportStart>();
      const startFn = vi.fn(() => startDeferred.promise);
      const cancelInvoke = vi.fn().mockRejectedValue("IPC closed");
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: startFn,
        cancelExport: vi.fn(),
        cancelActiveExport: () => clientCancelActiveExport({ invoke: cancelInvoke }),
      });
      return {
        store,
        startDeferred,
        startFn,
        cancelInvoke,
        emit: (event: ExportProgressEvent) => {
          emit(event);
        },
      };
    }

    /** Starts the export, and fails the Stop while the start waits for its run id. */
    async function startAndFailTheStop() {
      const fixture = createStoreWithFailingSlotCancel();
      const starting = fixture.store.getState().startExport(createValidRequest());
      await vi.waitFor(() => {
        expect(fixture.startFn).toHaveBeenCalled();
      });
      await expect(fixture.store.getState().cancelExport()).resolves.toBe(false);
      expect(fixture.cancelInvoke).toHaveBeenCalledTimes(1);
      return { ...fixture, starting };
    }

    it("reports a failure that keeps the start, so the run stays live", async () => {
      const { store } = await startAndFailTheStop();

      const state = store.getState();
      expect(state.status).toBe("failed");
      expect(state.error).toMatchObject({ code: "unknown", detail: "IPC closed" });
      expect(state.runId).toBeNull();
      expect(state.tracking).toBe(true);
      expect(state.cancelRequested).toBe(false);
      expect(isExportRunLive(state)).toBe(true);
    });

    it("takes the start answer, and tracks the run to its finished event", async () => {
      const { store, startDeferred, starting, emit } = await startAndFailTheStop();

      // An event that arrives before the answer waits for the run id.
      emit({
        event: "started",
        runId: "run-kept",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
        expectedFrames: 150,
      });
      expect(store.getState().status).toBe("failed");

      const start = createValidStartResult({ runId: "run-kept" });
      startDeferred.resolve(start);
      await expect(starting).resolves.toStrictEqual(start);

      // The store knows the run, and its `started` event brought it back to `running`. The
      // failure of the Stop request no longer shows, because Stop is available again.
      expect(store.getState()).toMatchObject({
        status: "running",
        runId: "run-kept",
        tracking: true,
        error: null,
      });

      emit({ event: "progress", runId: "run-kept", frame: 75 });
      expect(store.getState().frame).toBe(75);

      emit({
        event: "finished",
        runId: "run-kept",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      expect(store.getState()).toMatchObject({
        status: "finished",
        runId: "run-kept",
        tracking: false,
        error: null,
        frame: 150,
      });
    });

    it("tracks the run to its failed event", async () => {
      const { store, startDeferred, starting, emit } = await startAndFailTheStop();

      startDeferred.resolve(createValidStartResult({ runId: "run-kept" }));
      await starting;
      // The answer alone does not change the status. The run is still live.
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: "run-kept",
        tracking: true,
      });
      expect(isExportRunLive(store.getState())).toBe(true);

      emit({ event: "failed", runId: "run-kept", code: "ffmpegProcessFailed" });

      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("ffmpegProcessFailed");
      expect(store.getState().tracking).toBe(false);
      expect(isExportRunLive(store.getState())).toBe(false);
    });

    it("ends the tracking when the backend then refuses the start", async () => {
      const { store, startDeferred, starting } = await startAndFailTheStop();

      startDeferred.reject(new ExportError({ code: "outputReadOnly" }));
      await expect(starting).resolves.toBeNull();

      // The refusal is the better error, and it ends the start.
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: null,
        tracking: false,
      });
      expect(store.getState().error?.code).toBe("outputReadOnly");
      expect(isExportRunLive(store.getState())).toBe(false);
    });

    it("ends as canceled when the stop reached the backend after all", async () => {
      // The IPC layer can reject after the backend received the request. The start then
      // answers `canceled`.
      const { store, startDeferred, starting } = await startAndFailTheStop();

      startDeferred.reject(new ExportError({ code: "canceled" }));
      await expect(starting).resolves.toBeNull();

      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
    });

    it("accepts a retried slot cancel while the start still waits, and ends canceled", async () => {
      const startDeferred = createDeferred<ExportStart>();
      const startFn = vi.fn(() => startDeferred.promise);
      const cancelInvoke = vi
        .fn()
        .mockRejectedValueOnce("IPC closed")
        .mockResolvedValueOnce(true);
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: startFn,
        cancelExport: vi.fn(),
        cancelActiveExport: () => clientCancelActiveExport({ invoke: cancelInvoke }),
      });
      const starting = store.getState().startExport(createValidRequest());
      await vi.waitFor(() => {
        expect(startFn).toHaveBeenCalled();
      });
      await expect(store.getState().cancelExport()).resolves.toBe(false);
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: null,
        tracking: true,
      });

      // The start still waits for its run id, so the retry asks by slot again.
      const retry = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);
      await expect(retry).resolves.toBe(true);
      expect(cancelInvoke).toHaveBeenCalledTimes(2);
      expect(store.getState().cancelRequested).toBe(true);

      // The preparation reads the flag, and `start_export` answers `canceled`.
      startDeferred.reject(new ExportError({ code: "canceled" }));
      await expect(starting).resolves.toBeNull();
      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
      expect(isExportRunLive(store.getState())).toBe(false);
    });

    it("reports a retried slot cancel that rejects after the start answer, and keeps the run", async () => {
      const { store, startDeferred, starting, cancelInvoke } =
        await startAndFailTheStop();
      const firstFailure = store.getState().error;
      const retry = createDeferred<boolean>();
      cancelInvoke.mockReturnValueOnce(retry.promise);

      const stopping = store.getState().cancelExport();
      startDeferred.resolve(createValidStartResult({ runId: "run-kept" }));
      await starting;
      retry.reject("IPC closed again");
      await expect(stopping).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: "run-kept",
        tracking: true,
        cancelRequested: false,
      });
      // A new failure, with its own error instance.
      expect(store.getState().error).toMatchObject({ detail: "IPC closed again" });
      expect(store.getState().error).not.toBe(firstFailure);
    });

    it("writes a retried slot cancel that answers true after the start answer", async () => {
      const { store, startDeferred, starting, cancelInvoke, emit } =
        await startAndFailTheStop();
      const retry = createDeferred<boolean>();
      cancelInvoke.mockReturnValueOnce(retry.promise);

      const stopping = store.getState().cancelExport();
      startDeferred.resolve(createValidStartResult({ runId: "run-kept" }));
      await starting;
      retry.resolve(true);
      await expect(stopping).resolves.toBe(true);

      // The answer belongs to the run that the start answer named.
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: "run-kept",
        cancelRequested: true,
      });
      emit({ event: "failed", runId: "run-kept", code: "canceled" });
      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
    });

    it("keeps Stop available when a retried slot cancel answers false while the start waits", async () => {
      // `false` means that no run held the slot yet. The user can ask again.
      const { store, cancelInvoke } = await startAndFailTheStop();
      cancelInvoke.mockResolvedValueOnce(false);

      await expect(store.getState().cancelExport()).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: null,
        tracking: true,
        cancelRequested: false,
      });
      cancelInvoke.mockResolvedValueOnce(true);
      await expect(store.getState().cancelExport()).resolves.toBe(true);
      expect(cancelInvoke).toHaveBeenCalledTimes(3);
    });

    it("accepts a retried slot cancel, and the run ends canceled after its answer", async () => {
      // The flag can also reach the run after the preparation. The run then ends with a
      // `failed` event that carries `canceled`.
      const { store, startDeferred, starting, cancelInvoke, emit } =
        await startAndFailTheStop();
      cancelInvoke.mockResolvedValueOnce(true);

      await expect(store.getState().cancelExport()).resolves.toBe(true);
      startDeferred.resolve(createValidStartResult({ runId: "run-kept" }));
      await starting;
      emit({ event: "failed", runId: "run-kept", code: "canceled" });

      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
    });

    it("still drops the start on an explicit reset", async () => {
      // No control resets a live run (`isExportRunLive`). The reset itself keeps its meaning.
      const { store, startDeferred, starting } = await startAndFailTheStop();

      store.getState().reset();
      expect(store.getState()).toMatchObject({ status: "idle", tracking: false });

      startDeferred.resolve(createValidStartResult({ runId: "run-dropped" }));
      await expect(starting).resolves.toBeNull();
      expect(store.getState().runId).toBeNull();
      expect(store.getState().tracking).toBe(false);
    });
  });

  describe("encodeStarted", () => {
    function createStoreWithEvents() {
      let emit!: (event: ExportProgressEvent) => void;
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: () => Promise.resolve(createValidStartResult({ runId: "run-e" })),
      });
      return {
        store,
        emit: (event: ExportProgressEvent) => {
          emit(event);
        },
      };
    }

    it("is set by the started event, and cleared by a new start and by a reset", async () => {
      const { store, emit } = createStoreWithEvents();
      expect(store.getState().encodeStarted).toBe(false);

      await store.getState().startExport(createValidRequest());
      expect(store.getState().encodeStarted).toBe(false);
      emit({
        event: "started",
        runId: "run-e",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
      });
      expect(store.getState().encodeStarted).toBe(true);

      await store.getState().startExport(createValidRequest());
      expect(store.getState().encodeStarted).toBe(false);
      emit({
        event: "started",
        runId: "run-e",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
      });
      store.getState().reset();
      expect(store.getState().encodeStarted).toBe(false);
    });

    it("is set by a progress event that arrives with no started event", async () => {
      const { store, emit } = createStoreWithEvents();
      await store.getState().startExport(createValidRequest());

      emit({ event: "progress", runId: "run-e", frame: 1 });

      expect(store.getState()).toMatchObject({
        status: "running",
        encodeStarted: true,
      });
    });

    it("stays through a failed Stop, so a live failed can tell the encode from the preparation", async () => {
      let emit!: (event: ExportProgressEvent) => void;
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: () => Promise.resolve(createValidStartResult({ runId: "run-e" })),
        cancelExport: () => Promise.reject(new Error("IPC failed")),
      });
      await store.getState().startExport(createValidRequest());
      emit({
        event: "started",
        runId: "run-e",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
      });

      await store.getState().cancelExport();

      // No progress block arrived yet, and the backend encodes.
      expect(store.getState()).toMatchObject({
        status: "failed",
        tracking: true,
        frame: null,
        encodeStarted: true,
      });
    });
  });

  describe("a Stop by run id that the IPC layer rejects", () => {
    function createStoreWithFailingStop() {
      let emit!: (event: ExportProgressEvent) => void;
      const cancelInvoke = vi.fn().mockRejectedValueOnce("IPC closed");
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-live" })),
        cancelExport: (runId) => clientCancelExport(runId, { invoke: cancelInvoke }),
      });
      return {
        store,
        cancelInvoke,
        emit: (event: ExportProgressEvent) => {
          emit(event);
        },
      };
    }

    async function startEncodeAndFailTheStop() {
      const fixture = createStoreWithFailingStop();
      await fixture.store.getState().startExport(createValidRequest());
      fixture.emit({
        event: "started",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
        expectedFrames: 150,
      });
      fixture.emit({ event: "progress", runId: "run-live", frame: 30 });
      await expect(fixture.store.getState().cancelExport()).resolves.toBe(false);
      expect(fixture.store.getState()).toMatchObject({
        status: "failed",
        runId: "run-live",
        tracking: true,
      });
      return fixture;
    }

    it("accepts a retried stop by run id, and the run then ends canceled", async () => {
      const { store, cancelInvoke, emit } = await startEncodeAndFailTheStop();
      cancelInvoke.mockResolvedValueOnce(true);

      await expect(store.getState().cancelExport()).resolves.toBe(true);
      expect(cancelInvoke).toHaveBeenCalledTimes(2);
      expect(cancelInvoke).toHaveBeenLastCalledWith("cancel_export", {
        runId: "run-live",
      });
      expect(store.getState().cancelRequested).toBe(true);

      emit({ event: "failed", runId: "run-live", code: "canceled" });
      expect(store.getState()).toMatchObject({ status: "canceled", tracking: false });
    });

    it("keeps publishing when a Stop in flight rejects after the publishing event", async () => {
      // ADR 016: the backend ran its last cancel test before it sent `publishing`. A live
      // `failed` there would offer Stop again during the rename.
      let emit!: (event: ExportProgressEvent) => void;
      const cancelDeferred = createDeferred<boolean>();
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-live" })),
        cancelExport: (runId) =>
          clientCancelExport(runId, {
            invoke: vi.fn().mockReturnValueOnce(cancelDeferred.promise),
          }),
      });
      await store.getState().startExport(createValidRequest());
      emit({
        event: "started",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
        expectedFrames: 150,
      });
      emit({ event: "progress", runId: "run-live", frame: 140 });

      const stopping = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);
      emit({ event: "publishing", runId: "run-live" });
      cancelDeferred.reject("IPC closed");
      await expect(stopping).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        status: "publishing",
        error: null,
        cancelRequested: false,
        tracking: true,
      });

      emit({
        event: "finished",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      expect(store.getState()).toMatchObject({ status: "finished", tracking: false });
    });

    it("ignores a retried stop by run id that answers after the run finished", async () => {
      const { store, cancelInvoke, emit } = await startEncodeAndFailTheStop();
      const retry = createDeferred<boolean>();
      cancelInvoke.mockReturnValueOnce(retry.promise);

      const stopping = store.getState().cancelExport();
      emit({ event: "publishing", runId: "run-live" });
      emit({
        event: "finished",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      retry.resolve(true);
      await expect(stopping).resolves.toBe(true);

      expect(store.getState()).toMatchObject({
        status: "finished",
        tracking: false,
        error: null,
      });
      expect(isExportRunLive(store.getState())).toBe(false);
    });

    it("ignores a retried stop by run id that rejects after the run failed", async () => {
      const { store, cancelInvoke, emit } = await startEncodeAndFailTheStop();
      const retry = createDeferred<boolean>();
      cancelInvoke.mockReturnValueOnce(retry.promise);

      const stopping = store.getState().cancelExport();
      emit({ event: "failed", runId: "run-live", code: "ffmpegProcessFailed" });
      retry.reject("IPC closed");
      await expect(stopping).resolves.toBe(false);

      // The result of the run stays. The late rejection belongs to nobody.
      expect(store.getState()).toMatchObject({ status: "failed", tracking: false });
      expect(store.getState().error?.code).toBe("ffmpegProcessFailed");
    });

    it("gives each failed Stop its own error instance, also for one rejected object", async () => {
      const sameRejection = new ExportError({ code: "unknown", detail: "IPC closed" });
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-live" })),
        cancelExport: () => Promise.reject(sameRejection),
      });
      await store.getState().startExport(createValidRequest());

      await store.getState().cancelExport();
      const first = store.getState().error;
      await store.getState().cancelExport();
      const second = store.getState().error;

      expect(first).toMatchObject({ code: "unknown", detail: "IPC closed" });
      expect(second).toMatchObject({ code: "unknown", detail: "IPC closed" });
      expect(second).not.toBe(first);
      expect(first).not.toBe(sameRejection);
    });

    it("keeps the failure through the encode, and clears it at the publication", async () => {
      const { store, emit } = await startEncodeAndFailTheStop();

      emit({ event: "progress", runId: "run-live", frame: 90 });
      expect(store.getState().status).toBe("failed");
      expect(store.getState().error?.code).toBe("unknown");
      expect(store.getState().frame).toBe(90);

      emit({ event: "publishing", runId: "run-live" });
      expect(store.getState()).toMatchObject({
        status: "publishing",
        error: null,
        tracking: true,
      });
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

    it("ignores an error while a start waits for its run id, and takes the start answer", async () => {
      // The backend claims the export slot before it answers. A `failed` here would let a
      // reset drop the start, and an invalidated start would discard the answer.
      const startDeferred = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDeferred.promise,
      });

      const p = store.getState().startExport(createValidRequest());
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));

      expect(store.getState()).toMatchObject({
        status: "preparing",
        error: null,
        tracking: true,
      });

      const start = createValidStartResult({ runId: "run-kept" });
      startDeferred.resolve(start);
      await expect(p).resolves.toStrictEqual(start);
      expect(store.getState()).toMatchObject({ runId: "run-kept", tracking: true });
    });

    it("ignores an error over every live run that the store tracks", async () => {
      let emit!: (event: ExportProgressEvent) => void;
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-live" })),
        cancelExport: () => Promise.reject(new Error("IPC failed")),
      });
      await store.getState().startExport(createValidRequest());
      emit({
        event: "started",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 5_000_000,
      });

      // Running.
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));
      expect(store.getState()).toMatchObject({ status: "running", error: null });

      // A live `failed` after a failed Stop keeps the error of that request.
      await store.getState().cancelExport();
      const stopFailure = store.getState().error;
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));
      expect(store.getState()).toMatchObject({ status: "failed", tracking: true });
      expect(store.getState().error).toBe(stopFailure);

      // Publishing.
      emit({ event: "publishing", runId: "run-live" });
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));
      expect(store.getState()).toMatchObject({ status: "publishing", error: null });

      // Once the run ended, the error shows again.
      emit({
        event: "finished",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      store.getState().reportError(new ExportError({ code: "dialogFailed" }));
      expect(store.getState()).toMatchObject({ status: "failed", tracking: false });
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
      expect(store.getState().tracking).toBe(true);
      store.getState().unsubscribe();
      expect(unlisten1).toHaveBeenCalledTimes(1);
      // The invalidated start is no longer tracked.
      expect(store.getState().tracking).toBe(false);

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
      expect(state.fps).toBeNull();
      expect(state.speed).toBeNull();
      expect(state.cancelRequested).toBe(false);
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

  describe("Progress Event fps and speed", () => {
    it("records fps and speed, and a later event that omits them keeps the old values", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(
            createValidStartResult({
              runId: "run-progress-metrics",
            }),
          ),
      });

      await store.getState().startExport(createValidRequest());

      eventHandler({
        event: "progress",
        runId: "run-progress-metrics",
        frame: 50,
        fps: { n: 60, d: 1 },
        speed: { n: 3, d: 2 },
      });

      expect(store.getState().fps).toEqual({ n: 60, d: 1 });
      expect(store.getState().speed).toEqual({ n: 3, d: 2 });

      // Later progress event omits fps and speed
      eventHandler({
        event: "progress",
        runId: "run-progress-metrics",
        frame: 100,
      });

      expect(store.getState().frame).toBe(100);
      expect(store.getState().fps).toEqual({ n: 60, d: 1 });
      expect(store.getState().speed).toEqual({ n: 3, d: 2 });
    });
  });

  describe("Clearing fps, speed, and cancelRequested", () => {
    it("startExport and reset clear fps, speed, and cancelRequested", async () => {
      let eventHandler!: (event: ExportProgressEvent) => void;

      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          eventHandler = handler;
          return Promise.resolve(() => {});
        },
        startExport: () =>
          Promise.resolve(
            createValidStartResult({
              runId: "run-clear-metrics",
            }),
          ),
        cancelExport: () => Promise.resolve(true),
      });

      await store.getState().startExport(createValidRequest());

      eventHandler({
        event: "progress",
        runId: "run-clear-metrics",
        frame: 30,
        fps: { n: 30, d: 1 },
        speed: { n: 1, d: 1 },
      });

      await store.getState().cancelExport();
      expect(store.getState().fps).toEqual({ n: 30, d: 1 });
      expect(store.getState().speed).toEqual({ n: 1, d: 1 });
      expect(store.getState().cancelRequested).toBe(true);

      // reset clears all three
      store.getState().reset();
      expect(store.getState().fps).toBeNull();
      expect(store.getState().speed).toBeNull();
      expect(store.getState().cancelRequested).toBe(false);

      // Initialize a store with non-null values
      const storeWithState = createExportStore(
        {
          subscribeExportProgress: () => Promise.resolve(() => {}),
          startExport: () =>
            Promise.resolve(
              createValidStartResult({
                runId: "run-second",
              }),
            ),
        },
        {
          status: "running",
          runId: "run-initial",
          fps: { n: 24, d: 1 },
          speed: { n: 2, d: 1 },
          cancelRequested: true,
        },
      );

      expect(storeWithState.getState().fps).toEqual({ n: 24, d: 1 });
      expect(storeWithState.getState().speed).toEqual({ n: 2, d: 1 });
      expect(storeWithState.getState().cancelRequested).toBe(true);

      // startExport clears all three in its initial set
      const p = storeWithState.getState().startExport(createValidRequest());
      expect(storeWithState.getState().fps).toBeNull();
      expect(storeWithState.getState().speed).toBeNull();
      expect(storeWithState.getState().cancelRequested).toBe(false);
      await p;
      expect(storeWithState.getState().fps).toBeNull();
      expect(storeWithState.getState().speed).toBeNull();
      expect(storeWithState.getState().cancelRequested).toBe(false);
    });
  });

  describe("by-id cancel cancelRequested tracking", () => {
    it("is true while pending, equals answer when true, and equals answer when false", async () => {
      // True case
      const trueDeferred = createDeferred<boolean>();
      const storeTrue = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-by-id-true" })),
        cancelExport: () => trueDeferred.promise,
      });

      await storeTrue.getState().startExport(createValidRequest());
      expect(storeTrue.getState().cancelRequested).toBe(false);

      const cancelPromiseTrue = storeTrue.getState().cancelExport();
      expect(storeTrue.getState().cancelRequested).toBe(true);

      trueDeferred.resolve(true);
      expect(await cancelPromiseTrue).toBe(true);
      expect(storeTrue.getState().cancelRequested).toBe(true);

      // False case
      const falseDeferred = createDeferred<boolean>();
      const storeFalse = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-by-id-false" })),
        cancelExport: () => falseDeferred.promise,
      });

      await storeFalse.getState().startExport(createValidRequest());
      expect(storeFalse.getState().cancelRequested).toBe(false);

      const cancelPromiseFalse = storeFalse.getState().cancelExport();
      expect(storeFalse.getState().cancelRequested).toBe(true);

      falseDeferred.resolve(false);
      expect(await cancelPromiseFalse).toBe(false);
      expect(storeFalse.getState().cancelRequested).toBe(false);
    });

    it("is true while pending and false after a rejection", async () => {
      const rejectDeferred = createDeferred<boolean>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () =>
          Promise.resolve(createValidStartResult({ runId: "run-by-id-reject" })),
        cancelExport: () => rejectDeferred.promise,
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().cancelRequested).toBe(false);

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      rejectDeferred.reject(new Error("IPC failed"));
      expect(await cancelPromise).toBe(false);
      expect(store.getState().cancelRequested).toBe(false);
      expect(store.getState().status).toBe("failed");
    });
    it("does not write cancelRequested when by-id cancel resolves after reset and start learns run-2", async () => {
      const cancelDef = createDeferred<boolean>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: (req) =>
          Promise.resolve(
            createValidStartResult({
              runId: req.outputPath === "/media/output-2.mp4" ? "run-2" : "run-1",
            }),
          ),
        cancelExport: () => cancelDef.promise,
      });

      await store.getState().startExport(createValidRequest());
      expect(store.getState().runId).toBe("run-1");

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      store.getState().reset();
      await store
        .getState()
        .startExport(createValidRequest({ outputPath: "/media/output-2.mp4" }));
      expect(store.getState().runId).toBe("run-2");
      expect(store.getState().cancelRequested).toBe(false);

      cancelDef.resolve(true);
      expect(await cancelPromise).toBe(true);
      expect(store.getState().cancelRequested).toBe(false);
    });
  });

  describe("by-slot cancel cancelRequested tracking", () => {
    it("is true while pending, true after true, and false after false", async () => {
      // True case
      const cancelDefTrue = createDeferred<boolean>();
      const startDefTrue = createDeferred<ExportStart>();
      const storeTrue = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDefTrue.promise,
        cancelActiveExport: () => cancelDefTrue.promise,
      });

      void storeTrue.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(storeTrue.getState().status).toBe("preparing");
      expect(storeTrue.getState().cancelRequested).toBe(false);

      const pTrue = storeTrue.getState().cancelExport();
      expect(storeTrue.getState().cancelRequested).toBe(true);

      cancelDefTrue.resolve(true);
      expect(await pTrue).toBe(true);
      expect(storeTrue.getState().cancelRequested).toBe(true);

      // False case
      const cancelDefFalse = createDeferred<boolean>();
      const startDefFalse = createDeferred<ExportStart>();
      const storeFalse = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDefFalse.promise,
        cancelActiveExport: () => cancelDefFalse.promise,
      });

      void storeFalse.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(storeFalse.getState().cancelRequested).toBe(false);

      const pFalse = storeFalse.getState().cancelExport();
      expect(storeFalse.getState().cancelRequested).toBe(true);

      cancelDefFalse.resolve(false);
      expect(await pFalse).toBe(false);
      expect(storeFalse.getState().cancelRequested).toBe(false);
    });

    it("does not write cancelRequested when by-slot cancel resolves after reset", async () => {
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });

      void store.getState().startExport(createValidRequest());
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      store.getState().reset();
      expect(store.getState().cancelRequested).toBe(false);

      cancelDef.resolve(true);
      expect(await cancelPromise).toBe(true);
      expect(store.getState().cancelRequested).toBe(false);
    });

    it("does not write cancelRequested when by-slot cancel resolves after a new startExport", async () => {
      const cancelDef = createDeferred<boolean>();
      const secondStart = createDeferred<ExportStart>();
      const secondReq = createValidRequest({ outputPath: "/out2.mp4" });
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: (req) => {
          if (req.outputPath === "/out2.mp4") {
            return secondStart.promise;
          }
          return new Promise(() => {});
        },
        cancelActiveExport: () => cancelDef.promise,
      });

      void store
        .getState()
        .startExport(createValidRequest({ outputPath: "/out1.mp4" }));
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      void store.getState().startExport(secondReq);
      await Promise.resolve();
      expect(store.getState().cancelRequested).toBe(false);

      cancelDef.resolve(true);
      expect(await cancelPromise).toBe(true);
      expect(store.getState().cancelRequested).toBe(false);
    });

    it("resolves after the store learned the run id and still writes the answer", async () => {
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });

      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().runId).toBeNull();

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      startDef.resolve(createValidStartResult({ runId: "run-learned" }));
      await startPromise;
      expect(store.getState().runId).toBe("run-learned");
      expect(store.getState().cancelRequested).toBe(true);

      cancelDef.resolve(true);
      const accepted = await cancelPromise;

      expect(accepted).toBe(true);
      expect(store.getState().cancelRequested).toBe(true);
    });

    it("resolves false after the store learned the run id and clears cancelRequested", async () => {
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });

      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().runId).toBeNull();

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      startDef.resolve(createValidStartResult({ runId: "run-learned" }));
      await startPromise;
      expect(store.getState().runId).toBe("run-learned");
      expect(store.getState().cancelRequested).toBe(true);

      cancelDef.resolve(false);
      const accepted = await cancelPromise;

      expect(accepted).toBe(false);
      expect(store.getState().cancelRequested).toBe(false);
    });

    it("reports a slot cancel that rejects after the start answer and before the encode", async () => {
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });
      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      startDef.resolve(createValidStartResult({ runId: "run-answered" }));
      await startPromise;
      expect(store.getState()).toMatchObject({
        status: "preparing",
        runId: "run-answered",
      });

      cancelDef.reject(new Error("IPC failed"));
      await expect(cancelPromise).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: "run-answered",
        tracking: true,
        cancelRequested: false,
        encodeStarted: false,
      });
      expect(isExportRunLive(store.getState())).toBe(true);
    });

    it("keeps publishing when a slot cancel rejects after the publishing event", async () => {
      let progressCallback!: (event: ExportProgressEvent) => void;
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: (cb) => {
          progressCallback = cb;
          return Promise.resolve(() => {});
        },
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });
      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();

      const cancelPromise = store.getState().cancelExport();
      startDef.resolve(createValidStartResult({ runId: "run-fast" }));
      await startPromise;
      progressCallback({ event: "publishing", runId: "run-fast" });
      cancelDef.reject(new Error("IPC failed"));
      await expect(cancelPromise).resolves.toBe(false);

      expect(store.getState()).toMatchObject({
        status: "publishing",
        error: null,
        cancelRequested: false,
      });
    });

    it("reports a slot cancel that rejects after the run id is learned, and keeps the run", async () => {
      let progressCallback!: (event: ExportProgressEvent) => void;
      const cancelDef = createDeferred<boolean>();
      const startDef = createDeferred<ExportStart>();
      const store = createExportStore({
        subscribeExportProgress: (cb) => {
          progressCallback = cb;
          return Promise.resolve(() => {});
        },
        startExport: () => startDef.promise,
        cancelActiveExport: () => cancelDef.promise,
      });

      const startPromise = store.getState().startExport(createValidRequest());
      await Promise.resolve();
      expect(store.getState().status).toBe("preparing");
      expect(store.getState().runId).toBeNull();

      const cancelPromise = store.getState().cancelExport();
      expect(store.getState().cancelRequested).toBe(true);

      startDef.resolve(createValidStartResult({ runId: "run-learned" }));
      await startPromise;
      progressCallback({
        event: "started",
        runId: "run-learned",
        outputPath: "/media/output.mp4",
        segmentCount: 1,
        totalDurationUs: 1000,
      });
      expect(store.getState().runId).toBe("run-learned");
      expect(store.getState().status).toBe("running");
      expect(store.getState().cancelRequested).toBe(true);

      cancelDef.reject(new Error("IPC failed"));
      const accepted = await cancelPromise;

      // The request was for this run, and the run continues. The failure shows, the run
      // stays tracked, and Stop is available again.
      expect(accepted).toBe(false);
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: "run-learned",
        tracking: true,
        cancelRequested: false,
        encodeStarted: true,
      });
      expect(store.getState().error?.code).toBe("unknown");
      expect(isExportRunLive(store.getState())).toBe(true);
    });
  });
});
