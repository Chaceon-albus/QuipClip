import { describe, expect, it, vi } from "vitest";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts } from "@/types/project";
import {
  createExportQueueStore,
  exportBatchContinues,
  exportBatchEndsOf,
  exportBatchHasFailure,
  hasPendingExportWork,
  selectExportQueueRows,
} from "./queueStore";
import { isExportRunLive } from "./runState";
import { createExportStore } from "./store";
import {
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportSubmission,
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

function createRequest(outputPath: string, presetName = "Test preset"): ExportRequest {
  return {
    sourcePath: "/media/source.mp4",
    outputPath,
    segments: [
      { inPts: "0" as Pts, outPts: "1000" as Pts },
      { inPts: "2000" as Pts, outPts: "3000" as Pts },
    ],
    preset: createPresetDraft("mp4-h264", presetName),
    streams: "videoAndAudio",
    audioMode: "encode",
  };
}

/**
 * A real export store and a queue store that share one fake backend. Both stores hear every
 * event that `emit` sends. `start` answers each `start_export` with the next run id, or with
 * the result of `answer` when the test sets it.
 */
function createFixture() {
  const handlers: Array<(event: ExportProgressEvent) => void> = [];
  const subscribe = (handler: (event: ExportProgressEvent) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  };
  let nextRun = 1;
  const fixture = {
    answer: null as null | ((request: ExportRequest) => Promise<ExportSubmission>),
    queued: true,
  };
  const start = vi.fn((request: ExportRequest): Promise<ExportSubmission> => {
    if (fixture.answer) {
      return fixture.answer(request);
    }
    const runId = `run-${nextRun++}`;
    return Promise.resolve({ runId, queued: runId !== "run-1" && fixture.queued });
  });
  const cancel = vi.fn((_runId: string) => Promise.resolve(true));
  const exportStore = createExportStore({
    subscribeExportProgress: subscribe,
    startExport: start,
    cancelExport: cancel,
  });
  const queue = createExportQueueStore({
    exportStore,
    startExport: start,
    cancelExport: cancel,
    subscribeExportProgress: subscribe,
  });
  const emit = (event: ExportProgressEvent) => {
    for (const handler of handlers) handler(event);
  };
  return { fixture, start, cancel, exportStore, queue, emit };
}

/** Sends the events of a run that finished. */
function finishRun(
  emit: (event: ExportProgressEvent) => void,
  runId: string,
  path: string,
) {
  emit({ event: "finished", runId, outputPath: path, frames: 30 });
}

describe("export queue store", () => {
  it("starts a run at once through the export store when nothing runs or waits", async () => {
    const { queue, exportStore, start } = createFixture();

    const submitting = queue.getState().submit(createRequest("/out/a.mp4", "Fast"));
    // The export store shows the start at once, as before the queue.
    expect(exportStore.getState()).toMatchObject({
      status: "preparing",
      outputPath: "/out/a.mp4",
      tracking: true,
    });

    await expect(submitting).resolves.toEqual({ kind: "started", runId: "run-1" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(exportStore.getState().runId).toBe("run-1");
    expect(queue.getState()).toMatchObject({
      order: ["run-1"],
      waiting: [],
      jobs: {
        "run-1": {
          runId: "run-1",
          outputPath: "/out/a.mp4",
          presetName: "Fast",
          segmentCount: 2,
          streams: "videoAndAudio",
        },
      },
    });
  });

  it("queues runs while a run is live, in the order of submission", async () => {
    const { queue, exportStore } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));

    await expect(queue.getState().submit(createRequest("/out/b.mp4"))).resolves.toEqual(
      {
        kind: "queued",
        runId: "run-2",
      },
    );
    await expect(queue.getState().submit(createRequest("/out/c.mp4"))).resolves.toEqual(
      {
        kind: "queued",
        runId: "run-3",
      },
    );

    expect(queue.getState().order).toEqual(["run-1", "run-2", "run-3"]);
    expect(queue.getState().waiting).toEqual(["run-2", "run-3"]);
    // The export store still tracks the run that holds the slot.
    expect(exportStore.getState().runId).toBe("run-1");
  });

  it("sends the submissions to the backend one after another", async () => {
    const { queue, start, fixture } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));

    const first = createDeferred<ExportSubmission>();
    fixture.answer = () => first.promise;
    const submittingB = queue.getState().submit(createRequest("/out/b.mp4"));
    const submittingC = queue.getState().submit(createRequest("/out/c.mp4"));
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(2);
    });

    fixture.answer = () => Promise.resolve({ runId: "run-c", queued: true });
    first.resolve({ runId: "run-b", queued: true });
    await Promise.all([submittingB, submittingC]);

    expect(start).toHaveBeenCalledTimes(3);
    expect(queue.getState().waiting).toEqual(["run-b", "run-c"]);
  });

  it("sends a queued run only after the direct start in flight has its answer", async () => {
    const { queue, start, fixture, exportStore } = createFixture();
    const first = createDeferred<ExportSubmission>();
    fixture.answer = () => first.promise;
    const startingA = queue.getState().submit(createRequest("/out/a.mp4"));
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });

    fixture.answer = () => Promise.resolve({ runId: "run-b", queued: true });
    const submittingB = queue.getState().submit(createRequest("/out/b.mp4"));
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    first.resolve({ runId: "run-a", queued: false });
    await expect(startingA).resolves.toEqual({ kind: "started", runId: "run-a" });
    await expect(submittingB).resolves.toEqual({ kind: "queued", runId: "run-b" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(queue.getState().order).toEqual(["run-a", "run-b"]);
    expect(exportStore.getState().runId).toBe("run-a");
  });

  describe("an output path that another run of the batch writes", () => {
    it("is refused against the live run, without regard to letter case", async () => {
      const { queue, start } = createFixture();
      await queue.getState().submit(createRequest("/out/Clip.mp4"));

      const result = await queue.getState().submit(createRequest("/out/clip.MP4"));

      expect(result).toMatchObject({ kind: "refused" });
      expect(result.kind === "refused" && result.error.code).toBe(
        "outputAlreadyQueued",
      );
      expect(start).toHaveBeenCalledTimes(1);
      expect(queue.getState().order).toEqual(["run-1"]);
    });

    it("is refused against a waiting run", async () => {
      const { queue, start } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));

      const result = await queue.getState().submit(createRequest("/OUT/B.mp4"));

      expect(result.kind === "refused" && result.error.code).toBe(
        "outputAlreadyQueued",
      );
      expect(start).toHaveBeenCalledTimes(2);
    });

    it("is refused against a submission that has no answer yet", async () => {
      const { queue, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      const answer = createDeferred<ExportSubmission>();
      fixture.answer = () => answer.promise;

      const submitting = queue.getState().submit(createRequest("/out/b.mp4"));
      const result = await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(result.kind === "refused" && result.error.code).toBe(
        "outputAlreadyQueued",
      );
      answer.resolve({ runId: "run-b", queued: true });
      await submitting;
    });

    it("is accepted when the run that wrote it has ended", async () => {
      const { queue, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      // The export store still shows the result, so the run goes through the queue.
      await expect(
        queue.getState().submit(createRequest("/out/a.mp4")),
      ).resolves.toEqual({
        kind: "queued",
        runId: "run-2",
      });
    });
  });

  describe("the preparing event of a waiting run", () => {
    for (const end of ["finished", "failed", "canceled"] as const) {
      it(`archives a ${end} current run and adopts the waiting run`, async () => {
        const { queue, exportStore, emit } = createFixture();
        await queue.getState().submit(createRequest("/out/a.mp4"));
        await queue.getState().submit(createRequest("/out/b.mp4"));

        if (end === "finished") {
          finishRun(emit, "run-1", "/out/a.mp4");
        } else {
          emit({
            event: "failed",
            runId: "run-1",
            code: end === "canceled" ? "canceled" : "ffmpegProcessFailed",
          });
        }
        expect(exportStore.getState().status).toBe(end);
        emit({ event: "preparing", runId: "run-2" });

        expect(exportStore.getState()).toMatchObject({
          status: "preparing",
          runId: "run-2",
          outputPath: "/out/b.mp4",
          segmentCount: 2,
          tracking: true,
          error: null,
        });
        expect(queue.getState().waiting).toEqual([]);
        expect(queue.getState().ended).toHaveLength(1);
        expect(queue.getState().ended[0]).toMatchObject({
          runId: "run-1",
          status: end,
        });
        expect(queue.getState().ended[0]?.error?.code).toBe(
          end === "finished"
            ? undefined
            : end === "canceled"
              ? "canceled"
              : "ffmpegProcessFailed",
        );

        // The export store follows the adopted run.
        emit({
          event: "started",
          runId: "run-2",
          outputPath: "/out/b.mp4",
          segmentCount: 2,
          totalDurationUs: 1_000_000,
          expectedFrames: 30,
        });
        expect(exportStore.getState().status).toBe("running");
      });
    }

    it("is buffered when it comes before the answer of start_export, and applied after it", async () => {
      const { queue, exportStore, emit, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));

      // The run that held the slot ends while the submission is in flight. The slot is then
      // free, so the backend starts the run at once, and its preparing event arrives before
      // the answer.
      fixture.answer = () => {
        finishRun(emit, "run-1", "/out/a.mp4");
        emit({ event: "preparing", runId: "run-early" });
        return Promise.resolve({ runId: "run-early", queued: false });
      };
      const result = await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(result).toEqual({ kind: "queued", runId: "run-early" });
      expect(queue.getState().waiting).toEqual([]);
      expect(queue.getState().ended).toMatchObject([
        { runId: "run-1", status: "finished" },
      ]);
      expect(exportStore.getState()).toMatchObject({
        status: "preparing",
        runId: "run-early",
        outputPath: "/out/b.mp4",
      });
    });

    it("applies the buffered events of the answered run, and ignores those of other runs", async () => {
      const { queue, exportStore, emit, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      fixture.answer = () => {
        emit({ event: "preparing", runId: "run-unknown" });
        finishRun(emit, "run-1", "/out/a.mp4");
        emit({ event: "preparing", runId: "run-2" });
        return Promise.resolve({ runId: "run-2", queued: false });
      };

      await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(queue.getState().waiting).toEqual([]);
      expect(exportStore.getState()).toMatchObject({
        status: "preparing",
        runId: "run-2",
      });
    });

    it("hands the events after preparing to the export store, up to the end of the run", async () => {
      const { queue, exportStore, emit, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      // The run takes the slot, starts and fails before the answer comes.
      fixture.answer = () => {
        finishRun(emit, "run-1", "/out/a.mp4");
        emit({ event: "preparing", runId: "run-2" });
        emit({
          event: "started",
          runId: "run-2",
          outputPath: "/out/b.mp4",
          segmentCount: 2,
          totalDurationUs: 1_000_000,
          expectedFrames: 30,
        });
        emit({ event: "failed", runId: "run-2", code: "sourceRevisionMismatch" });
        return Promise.resolve({ runId: "run-2", queued: false });
      };

      await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(exportStore.getState()).toMatchObject({
        status: "failed",
        runId: "run-2",
        tracking: false,
        encodeStarted: true,
      });
      expect(exportStore.getState().error?.code).toBe("sourceRevisionMismatch");
      expect(queue.getState().waiting).toEqual([]);
      expect(queue.getState().ended).toMatchObject([
        { runId: "run-1", status: "finished" },
      ]);
    });

    it("archives a run that is still live as failed with an unknown cause", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));

      // The terminal event of run-1 never came.
      emit({ event: "preparing", runId: "run-2" });

      expect(exportStore.getState().runId).toBe("run-2");
      expect(queue.getState().ended).toHaveLength(1);
      expect(queue.getState().ended[0]).toMatchObject({
        runId: "run-1",
        status: "failed",
      });
      expect(queue.getState().ended[0]?.error?.code).toBe("unknown");
    });
  });

  describe("remove", () => {
    it("withdraws a waiting run when its canceled event follows the answer", async () => {
      const { queue, cancel, emit, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      await queue.getState().submit(createRequest("/out/c.mp4"));

      await expect(queue.getState().remove("run-2")).resolves.toBe(true);

      expect(cancel).toHaveBeenCalledWith("run-2");
      // The run waits for its deciding event.
      expect(queue.getState().waiting).toEqual(["run-2", "run-3"]);
      expect(queue.getState().removing).toEqual(["run-2"]);
      expect(
        selectExportQueueRows(queue.getState(), exportStore.getState()).find(
          (row) => row.runId === "run-2",
        ),
      ).toMatchObject({ phase: "waiting", removing: true });

      emit({ event: "failed", runId: "run-2", code: "canceled" });

      expect(queue.getState()).toMatchObject({
        waiting: ["run-3"],
        order: ["run-1", "run-3"],
        removing: [],
        ended: [],
      });
      expect(queue.getState().jobs["run-2"]).toBeUndefined();
      expect(exportStore.getState()).toMatchObject({
        status: "preparing",
        runId: "run-1",
      });
    });

    it("withdraws a waiting run when its canceled event comes before the answer", async () => {
      const { queue, cancel, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      const answer = createDeferred<boolean>();
      cancel.mockImplementationOnce(() => answer.promise);

      const removing = queue.getState().remove("run-2");
      emit({ event: "failed", runId: "run-2", code: "canceled" });
      answer.resolve(true);

      await expect(removing).resolves.toBe(true);
      expect(queue.getState()).toMatchObject({
        waiting: [],
        order: ["run-1"],
        removing: [],
      });
    });

    it("keeps a run whose preparing comes after the answer, and the export store tracks it", async () => {
      const { queue, emit, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));

      await expect(queue.getState().remove("run-2")).resolves.toBe(true);
      finishRun(emit, "run-1", "/out/a.mp4");
      emit({ event: "preparing", runId: "run-2" });

      expect(queue.getState()).toMatchObject({
        waiting: [],
        removing: [],
        order: ["run-1", "run-2"],
      });
      expect(exportStore.getState()).toMatchObject({
        status: "preparing",
        runId: "run-2",
      });
      // The backend stopped the run as the run that holds the slot.
      emit({ event: "failed", runId: "run-2", code: "canceled" });
      expect(exportStore.getState()).toMatchObject({
        status: "canceled",
        tracking: false,
      });
    });

    it("keeps the run when the backend does not withdraw it", async () => {
      const { queue, cancel } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      cancel.mockResolvedValueOnce(false);

      await expect(queue.getState().remove("run-2")).resolves.toBe(false);
      expect(queue.getState().waiting).toEqual(["run-2"]);
    });

    it("keeps a run whose preparing comes before the answer", async () => {
      const { queue, cancel, emit, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      const answer = createDeferred<boolean>();
      cancel.mockImplementationOnce(() => answer.promise);

      const removing = queue.getState().remove("run-2");
      finishRun(emit, "run-1", "/out/a.mp4");
      emit({ event: "preparing", runId: "run-2" });
      answer.resolve(true);

      await expect(removing).resolves.toBe(true);
      expect(queue.getState().order).toEqual(["run-1", "run-2"]);
      expect(exportStore.getState().runId).toBe("run-2");
    });

    it("marks the run as removing before the answer, and sends one request for two calls", async () => {
      const { queue, cancel, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      const answer = createDeferred<boolean>();
      cancel.mockImplementationOnce(() => answer.promise);

      const first = queue.getState().remove("run-2");
      expect(queue.getState().removing).toEqual(["run-2"]);
      expect(
        selectExportQueueRows(queue.getState(), exportStore.getState()).find(
          (row) => row.runId === "run-2",
        ),
      ).toMatchObject({ phase: "waiting", removing: true });

      await expect(queue.getState().remove("run-2")).resolves.toBe(false);
      answer.resolve(true);

      await expect(first).resolves.toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(queue.getState().removing).toEqual(["run-2"]);
    });

    it("takes the run out of removing when the backend does not withdraw it", async () => {
      const { queue, cancel, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      cancel.mockResolvedValueOnce(false);

      await expect(queue.getState().remove("run-2")).resolves.toBe(false);

      expect(queue.getState()).toMatchObject({ waiting: ["run-2"], removing: [] });
      expect(
        selectExportQueueRows(queue.getState(), exportStore.getState()).find(
          (row) => row.runId === "run-2",
        ),
      ).toMatchObject({ phase: "waiting", removing: false });
      // The user can remove the run again.
      await expect(queue.getState().remove("run-2")).resolves.toBe(true);
      expect(cancel).toHaveBeenCalledTimes(2);
    });

    it("takes the run out of removing when the request rejects", async () => {
      const { queue, cancel } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      cancel.mockRejectedValueOnce(new Error("ipc"));

      await expect(queue.getState().remove("run-2")).resolves.toBe(false);

      expect(queue.getState()).toMatchObject({ waiting: ["run-2"], removing: [] });
    });

    it("refuses a run that does not wait", async () => {
      const { queue, cancel } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));

      await expect(queue.getState().remove("run-1")).resolves.toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    });
  });

  describe("the failed event of a waiting run", () => {
    it("removes a run that the backend withdrew", async () => {
      const { queue, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));

      emit({ event: "failed", runId: "run-2", code: "canceled" });

      expect(queue.getState()).toMatchObject({
        waiting: [],
        order: ["run-1"],
        ended: [],
      });
      expect(queue.getState().jobs["run-2"]).toBeUndefined();
    });

    it("keeps a run that failed with another code, as an ended run", async () => {
      const { queue, emit, exportStore } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));

      emit({
        event: "failed",
        runId: "run-2",
        code: "commandExecutionFailed",
        detail: "thread refused",
      });

      expect(queue.getState().waiting).toEqual([]);
      expect(queue.getState().order).toEqual(["run-1", "run-2"]);
      expect(queue.getState().ended).toHaveLength(1);
      expect(queue.getState().ended[0]).toMatchObject({
        runId: "run-2",
        status: "failed",
      });
      expect(queue.getState().ended[0]?.error).toMatchObject({
        code: "commandExecutionFailed",
        detail: "thread refused",
      });
      // The run of the export store goes on.
      expect(exportStore.getState()).toMatchObject({
        status: "preparing",
        runId: "run-1",
      });
    });
  });

  describe("the end of a batch", () => {
    it("clears the batch when the export store goes idle and nothing waits", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      exportStore.getState().reset();

      expect(queue.getState()).toMatchObject({
        jobs: {},
        order: [],
        waiting: [],
        ended: [],
      });
    });

    it("keeps the batch when the export store goes idle while runs wait", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      exportStore.getState().reset();

      expect(queue.getState().order).toEqual(["run-1", "run-2"]);
      expect(queue.getState().waiting).toEqual(["run-2"]);
    });

    it("keeps the run that a reset dropped as an ended row while runs wait", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      exportStore.getState().reset();

      expect(queue.getState().ended).toMatchObject([
        { runId: "run-1", status: "finished" },
      ]);
      expect(
        selectExportQueueRows(queue.getState(), exportStore.getState()).map((row) => [
          row.runId,
          row.phase,
        ]),
      ).toEqual([
        ["run-1", "ended"],
        ["run-2", "waiting"],
      ]);
    });

    it("keeps the batch when the export store goes idle while a submission is in flight", async () => {
      const { queue, exportStore, emit, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      const answer = createDeferred<ExportSubmission>();
      fixture.answer = () => answer.promise;
      const submitting = queue.getState().submit(createRequest("/out/b.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      exportStore.getState().reset();
      answer.resolve({ runId: "run-2", queued: true });
      await submitting;

      expect(queue.getState().order).toEqual(["run-1", "run-2"]);
      expect(queue.getState().ended).toMatchObject([
        { runId: "run-1", status: "finished" },
      ]);
      expect(queue.getState().waiting).toEqual(["run-2"]);
    });

    it("starts a new batch when the export store is idle and nothing waits", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");
      exportStore.getState().reset();

      await expect(
        queue.getState().submit(createRequest("/out/b.mp4")),
      ).resolves.toEqual({ kind: "started", runId: "run-2" });

      expect(queue.getState().order).toEqual(["run-2"]);
    });

    for (const end of ["finished", "failed", "canceled"] as const) {
      it(`queues a run while the export store shows a ${end} result and nothing waits`, async () => {
        const { queue, exportStore, emit, start } = createFixture();
        await queue.getState().submit(createRequest("/out/a.mp4"));
        if (end === "finished") {
          finishRun(emit, "run-1", "/out/a.mp4");
        } else {
          emit({
            event: "failed",
            runId: "run-1",
            code: end === "canceled" ? "canceled" : "ffmpegProcessFailed",
          });
        }

        // The slot is free, so the backend starts the run at once. It still answers through
        // the queue, and the export store keeps the result until the adoption.
        const result = await queue.getState().submit(createRequest("/out/b.mp4"));

        expect(result).toEqual({ kind: "queued", runId: "run-2" });
        expect(start).toHaveBeenCalledTimes(2);
        expect(exportStore.getState()).toMatchObject({ status: end, runId: "run-1" });
        expect(queue.getState()).toMatchObject({
          order: ["run-1", "run-2"],
          waiting: ["run-2"],
        });

        emit({ event: "preparing", runId: "run-2" });

        // The run before keeps its row, as an ended run.
        expect(exportStore.getState()).toMatchObject({
          status: "preparing",
          runId: "run-2",
          tracking: true,
        });
        expect(queue.getState().ended).toMatchObject([{ runId: "run-1", status: end }]);
        expect(
          selectExportQueueRows(queue.getState(), exportStore.getState()).map((row) => [
            row.runId,
            row.phase,
          ]),
        ).toEqual([
          ["run-1", "ended"],
          ["run-2", "current"],
        ]);
      });
    }

    it("refuses a run that start_export rejects while the export store shows a result", async () => {
      const { queue, exportStore, emit, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");
      fixture.answer = () => Promise.reject(new ExportError({ code: "invalidPreset" }));

      const result = await queue.getState().submit(createRequest("/out/b.mp4"));

      // The caller shows the refusal. The export store keeps the result of the run before.
      expect(result.kind === "refused" && result.error.code).toBe("invalidPreset");
      expect(exportStore.getState()).toMatchObject({
        status: "finished",
        runId: "run-1",
        error: null,
      });
      expect(queue.getState().order).toEqual(["run-1"]);
    });
  });

  describe("a submission that fails", () => {
    it("records nothing when start_export rejects for a queued run", async () => {
      const { queue, fixture } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      fixture.answer = () =>
        Promise.reject(new ExportError({ code: "exportQueueClosed" }));

      const result = await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(result.kind === "refused" && result.error.code).toBe("exportQueueClosed");
      expect(queue.getState().order).toEqual(["run-1"]);
      expect(queue.getState().waiting).toEqual([]);
    });

    it("releases the chain after a rejected start_export", async () => {
      const { queue, start } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      start.mockImplementationOnce(() =>
        Promise.reject(new ExportError({ code: "commandExecutionFailed" })),
      );
      const failing = queue.getState().submit(createRequest("/out/b.mp4"));
      const next = queue.getState().submit(createRequest("/out/c.mp4"));

      expect((await failing).kind).toBe("refused");
      await expect(next).resolves.toEqual({ kind: "queued", runId: "run-2" });
      expect(start).toHaveBeenCalledTimes(3);
      expect(queue.getState().waiting).toEqual(["run-2"]);
    });

    it("refuses a queued run when the event subscription fails, and subscribes again later", async () => {
      let failSubscribe = false;
      const exportStore = createExportStore({
        subscribeExportProgress: () => Promise.resolve(() => {}),
        startExport: () => Promise.resolve({ runId: "run-1", queued: false }),
      });
      const start = vi.fn(() => Promise.resolve({ runId: "run-2", queued: true }));
      const subscribe = vi.fn(() =>
        failSubscribe
          ? Promise.reject(new Error("listen failed"))
          : Promise.resolve(() => {}),
      );
      failSubscribe = true;
      const queue = createExportQueueStore({
        exportStore,
        startExport: start,
        subscribeExportProgress: subscribe,
      });
      await queue.getState().submit(createRequest("/out/a.mp4"));

      const result = await queue.getState().submit(createRequest("/out/b.mp4"));

      expect(result.kind === "refused" && result.error.code).toBe("unknown");
      expect(start).not.toHaveBeenCalled();
      expect(queue.getState().waiting).toEqual([]);

      failSubscribe = false;
      await expect(
        queue.getState().submit(createRequest("/out/b.mp4")),
      ).resolves.toEqual({
        kind: "queued",
        runId: "run-2",
      });
    });

    it("reports superseded when a reset replaced the direct start", async () => {
      const { queue, fixture, exportStore } = createFixture();
      const answer = createDeferred<ExportSubmission>();
      fixture.answer = () => answer.promise;
      const submitting = queue.getState().submit(createRequest("/out/a.mp4"));

      exportStore.getState().reset();
      answer.resolve({ runId: "run-1", queued: false });

      await expect(submitting).resolves.toEqual({ kind: "superseded" });
      expect(queue.getState().order).toEqual([]);
    });

    it("reports failed when the export store could not start the run", async () => {
      const { queue, fixture, exportStore } = createFixture();
      fixture.answer = () => Promise.reject(new ExportError({ code: "invalidPreset" }));

      await expect(
        queue.getState().submit(createRequest("/out/a.mp4")),
      ).resolves.toEqual({
        kind: "failed",
      });
      expect(exportStore.getState().error?.code).toBe("invalidPreset");
      expect(queue.getState().order).toEqual([]);
    });
  });

  describe("selectExportQueueRows", () => {
    it("lists the runs in the order of submission with their phases", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      await queue.getState().submit(createRequest("/out/b.mp4"));
      await queue.getState().submit(createRequest("/out/c.mp4"));
      await queue.getState().submit(createRequest("/out/d.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");
      emit({ event: "preparing", runId: "run-2" });

      const rows = selectExportQueueRows(queue.getState(), exportStore.getState());

      expect(rows.map((row) => [row.runId, row.phase])).toEqual([
        ["run-1", "ended"],
        ["run-2", "current"],
        ["run-3", "waiting"],
        ["run-4", "waiting"],
      ]);
      expect(rows[0]?.ended).toMatchObject({ status: "finished" });
      expect(rows[1]?.job.outputPath).toBe("/out/b.mp4");
      expect(rows[2]?.ended).toBeNull();
    });

    it("shows the last run as current after it ended", async () => {
      const { queue, exportStore, emit } = createFixture();
      await queue.getState().submit(createRequest("/out/a.mp4"));
      finishRun(emit, "run-1", "/out/a.mp4");

      const rows = selectExportQueueRows(queue.getState(), exportStore.getState());

      expect(rows.map((row) => row.phase)).toEqual(["current"]);
    });
  });
});

describe("pending export work", () => {
  it("counts each submission until its answer, and the runs that wait", async () => {
    const { queue, fixture } = createFixture();
    const answer = createDeferred<ExportSubmission>();
    fixture.answer = () => answer.promise;

    expect(hasPendingExportWork(queue.getState())).toBe(false);
    const submitting = queue.getState().submit(createRequest("/out/a.mp4"));
    expect(queue.getState().submitting).toBe(1);
    expect(hasPendingExportWork(queue.getState())).toBe(true);

    answer.resolve({ runId: "run-1", queued: false });
    await submitting;
    expect(queue.getState().submitting).toBe(0);
    // The run holds the slot, which the export store reports. Nothing waits.
    expect(hasPendingExportWork(queue.getState())).toBe(false);

    fixture.answer = null;
    await queue.getState().submit(createRequest("/out/b.mp4"));
    expect(queue.getState().submitting).toBe(0);
    expect(hasPendingExportWork(queue.getState())).toBe(true);
  });

  it("does not count a refused submission", async () => {
    const { queue } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));

    await queue.getState().submit(createRequest("/out/a.mp4"));

    expect(queue.getState().submitting).toBe(0);
  });

  it("does not count a queued submission that start_export rejected", async () => {
    const { queue, fixture } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    fixture.answer = () =>
      Promise.reject(new ExportError({ code: "exportQueueClosed" }));

    const result = await queue.getState().submit(createRequest("/out/b.mp4"));

    expect(result.kind).toBe("refused");
    expect(queue.getState().submitting).toBe(0);
    expect(hasPendingExportWork(queue.getState())).toBe(false);
  });

  it("does not count a direct start that a reset superseded", async () => {
    const { queue, fixture, exportStore } = createFixture();
    const answer = createDeferred<ExportSubmission>();
    fixture.answer = () => answer.promise;
    const submitting = queue.getState().submit(createRequest("/out/a.mp4"));
    expect(queue.getState().submitting).toBe(1);

    exportStore.getState().reset();
    answer.resolve({ runId: "run-1", queued: false });

    await expect(submitting).resolves.toEqual({ kind: "superseded" });
    expect(queue.getState().submitting).toBe(0);
    expect(hasPendingExportWork(queue.getState())).toBe(false);
  });
});

describe("exportBatchContinues", () => {
  it("is true while runs wait or a submission has no answer", () => {
    const none = { order: [], waiting: [], submitting: 0, ended: [] };
    expect(exportBatchContinues(none, { runId: "run-1" })).toBe(false);
    expect(exportBatchContinues({ ...none, waiting: ["run-2"] }, { runId: null })).toBe(
      true,
    );
    expect(exportBatchContinues({ ...none, submitting: 1 }, { runId: "run-1" })).toBe(
      true,
    );
  });

  it("is true when the queue archived the run of the export store", () => {
    const ended = [{ runId: "run-1", status: "finished" as const, error: null }];
    const queue = { order: ["run-1", "run-2"], waiting: [], submitting: 0, ended };
    expect(exportBatchContinues(queue, { runId: "run-1" })).toBe(true);
    expect(exportBatchContinues(queue, { runId: "run-2" })).toBe(false);
  });

  it("is true for an idle export store while a run of the batch has not ended", () => {
    const endA = { runId: "run-1", status: "finished" as const, error: null };
    const endB = { runId: "run-2", status: "failed" as const, error: null };
    const order = ["run-1", "run-2"];
    const queue = { order, waiting: [], submitting: 0 };
    expect(exportBatchContinues({ ...queue, ended: [endA] }, { runId: null })).toBe(
      true,
    );
    expect(
      exportBatchContinues({ ...queue, ended: [endA, endB] }, { runId: null }),
    ).toBe(false);
    // No run of the batch ended, so no batch is over or goes on.
    expect(exportBatchContinues({ ...queue, ended: [] }, { runId: null })).toBe(false);
    expect(
      exportBatchContinues(
        { order: [], waiting: [], submitting: 0, ended: [] },
        { runId: null },
      ),
    ).toBe(false);
  });

  it("stays true through the adoption after a reset while runs waited", async () => {
    const { queue, exportStore, emit } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    await queue.getState().submit(createRequest("/out/b.mp4"));
    finishRun(emit, "run-1", "/out/a.mp4");
    // The Close of the dialog resets the result while run-2 waits.
    exportStore.getState().reset();
    expect(queue.getState().ended.map((entry) => entry.runId)).toEqual(["run-1"]);
    const seen: boolean[] = [];
    const record = () => {
      if (!isExportRunLive(exportStore.getState())) {
        seen.push(exportBatchContinues(queue.getState(), exportStore.getState()));
      }
    };
    const stopQueue = queue.subscribe(record);
    const stopExport = exportStore.subscribe(record);
    emit({ event: "preparing", runId: "run-2" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    stopQueue();
    stopExport();
  });

  it("ends the batch when the last waiting run fails after a reset", async () => {
    const { queue, exportStore, emit } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    await queue.getState().submit(createRequest("/out/b.mp4"));
    finishRun(emit, "run-1", "/out/a.mp4");
    exportStore.getState().reset();
    expect(exportBatchContinues(queue.getState(), exportStore.getState())).toBe(true);
    // The user saw the result of run-1 before the reset.
    expect(queue.getState().seenEndedCount).toBe(1);
    emit({ event: "failed", runId: "run-2", code: "ffmpegProcessFailed" });
    expect(exportBatchContinues(queue.getState(), exportStore.getState())).toBe(false);
    // The failure of run-2 is a new end, so the batch keeps its rows for the status bar.
    expect(queue.getState().ended.length).toBeGreaterThan(
      queue.getState().seenEndedCount,
    );
    expect(exportBatchEndsOf(queue.getState(), exportStore.getState())).toEqual([
      "finished",
      "failed",
    ]);

    // The dismissal of that end drops the rows of the batch.
    queue.getState().dismissEndedBatch();
    expect(queue.getState().order).toEqual([]);
    expect(queue.getState().ended).toEqual([]);
  });

  it("drops the rows when the removal of the last waiting run ends the batch after a reset", async () => {
    const { queue, exportStore, emit } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    await queue.getState().submit(createRequest("/out/b.mp4"));
    finishRun(emit, "run-1", "/out/a.mp4");
    exportStore.getState().reset();
    expect(queue.getState().order).toEqual(["run-1", "run-2"]);

    await queue.getState().remove("run-2");
    emit({ event: "failed", runId: "run-2", code: "canceled" });

    // No end came after the reset, so nothing is left to show.
    expect(queue.getState()).toMatchObject({
      order: [],
      ended: [],
      waiting: [],
      seenEndedCount: 0,
    });
  });

  it("drops the rows when a refused submission ends the batch after a reset", async () => {
    const { queue, exportStore, emit, fixture } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    finishRun(emit, "run-1", "/out/a.mp4");
    const answer = createDeferred<ExportSubmission>();
    fixture.answer = () => answer.promise;
    // The run that ended is still in the export store, so this submission joins the queue.
    const submitting = queue.getState().submit(createRequest("/out/b.mp4"));
    exportStore.getState().reset();
    expect(queue.getState()).toMatchObject({ order: ["run-1"], seenEndedCount: 1 });

    answer.reject(new ExportError({ code: "exportQueueClosed" }));
    await expect(submitting).resolves.toMatchObject({ kind: "refused" });

    expect(queue.getState()).toMatchObject({ order: [], ended: [], seenEndedCount: 0 });
  });

  it("stays true at each change of the adoption, and is false at the end of the batch", async () => {
    const { queue, exportStore, emit } = createFixture();
    await queue.getState().submit(createRequest("/out/a.mp4"));
    await queue.getState().submit(createRequest("/out/b.mp4"));
    // The value at each change while the export store holds no live run.
    const seen: boolean[] = [];
    const record = () => {
      if (!isExportRunLive(exportStore.getState())) {
        seen.push(exportBatchContinues(queue.getState(), exportStore.getState()));
      }
    };
    const stopQueue = queue.subscribe(record);
    const stopExport = exportStore.subscribe(record);

    finishRun(emit, "run-1", "/out/a.mp4");
    emit({ event: "preparing", runId: "run-2" });
    expect(seen).toEqual([true, true, true]);

    seen.length = 0;
    finishRun(emit, "run-2", "/out/b.mp4");
    expect(seen[seen.length - 1]).toBe(false);
    stopQueue();
    stopExport();
  });
});

describe("exportBatchEndsOf and exportBatchHasFailure", () => {
  const end = (runId: string, status: "finished" | "failed" | "canceled") => ({
    runId,
    status,
    error: null,
  });

  it("adds the end of the run of the export store once", () => {
    const queue = { ended: [end("run-1", "failed"), end("run-2", "finished")] };
    expect(
      exportBatchEndsOf(queue, { runId: "run-2", status: "finished", tracking: false }),
    ).toEqual(["failed", "finished"]);
    expect(
      exportBatchEndsOf(queue, { runId: "run-3", status: "canceled", tracking: false }),
    ).toEqual(["failed", "finished", "canceled"]);
  });

  it("leaves out a live run of the export store", () => {
    const queue = { ended: [end("run-1", "finished")] };
    expect(
      exportBatchEndsOf(queue, { runId: "run-2", status: "running", tracking: true }),
    ).toEqual(["finished"]);
    expect(
      exportBatchEndsOf(queue, { runId: "run-2", status: "failed", tracking: true }),
    ).toEqual(["finished"]);
  });

  it("finds a failure only in a batch of more than one run", () => {
    expect(exportBatchHasFailure(["failed"])).toBe(false);
    expect(exportBatchHasFailure(["failed", "finished"])).toBe(true);
    expect(exportBatchHasFailure(["finished", "canceled"])).toBe(false);
  });
});
