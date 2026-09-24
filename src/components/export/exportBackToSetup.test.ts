import { describe, expect, it, vi } from "vitest";

import { runExportFlow } from "@/components/layout/exportFlowController";
import {
  cancelActiveExport as clientCancelActiveExport,
  cancelExport as clientCancelExport,
} from "@/features/export/client";
import { createExportStore } from "@/features/export/store";
import {
  EXPORT_STATUSES,
  ExportError,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportStart,
  type ExportStatus,
} from "@/features/export/types";
import type { InvokeFn } from "@/lib/ipc";
import type { MediaSourceRevisionDescriptor } from "@/features/media";
import type { Settings } from "@/features/settings/types";
import type { Pts } from "@/types/project";
import {
  canGoBackToSetup,
  createOpenStepGeneration,
  guardOpenStepEffects,
  runOpenStepAgain,
  type OpenStepEffects,
} from "./exportBackToSetup";
import { presentExportErrorRecovery } from "./exportErrorPresenter";

describe("canGoBackToSetup", () => {
  it.each(EXPORT_STATUSES)(
    "answers for status '%s' with no tracked run",
    (status: ExportStatus) => {
      expect(canGoBackToSetup({ status, tracking: false })).toBe(status === "failed");
    },
  );

  it.each(EXPORT_STATUSES)(
    "refuses status '%s' while the store tracks a run",
    (status: ExportStatus) => {
      expect(canGoBackToSetup({ status, tracking: true })).toBe(false);
    },
  );
});

const EXPORT_REQUEST: ExportRequest = {
  sourcePath: "/media/source.mp4",
  outputPath: "/media/output.mp4",
  segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
  presetId: "mp4-h264",
};

function startAnswer(runId: string): ExportStart {
  return {
    runId,
    presetId: "mp4-h264",
    outputPath: "/media/output.mp4",
    segmentCount: 1,
    totalDurationUs: 5_000_000,
    expectedFrames: 150,
  };
}

/**
 * A store with a run that the backend has started. Its `cancel_export` goes through the real
 * client with `cancelInvoke` in place of the Tauri invoke. In production the client wraps
 * every failure of that call in an `ExportError`, so the store sees here what it sees there.
 * `emit` sends an `export:progress` event to the store.
 */
async function startTrackedRun(cancelInvoke: InvokeFn) {
  let emit!: (event: ExportProgressEvent) => void;
  const store = createExportStore({
    subscribeExportProgress: (handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    },
    startExport: () => Promise.resolve(startAnswer("run-live")),
    cancelExport: (runId) => clientCancelExport(runId, { invoke: cancelInvoke }),
  });
  await store.getState().startExport(EXPORT_REQUEST);
  return { store, emit };
}

describe("Back after a stop request that the IPC layer rejected", () => {
  it.each([
    // `cancel_export` never answers with an error of its own, so a failure comes from the
    // IPC layer, as a string, or from the client check of the answer, as a TypeError.
    [
      "the IPC layer rejects with a string",
      () => vi.fn().mockRejectedValue("IPC closed"),
    ],
    ["the answer is not a boolean", () => vi.fn().mockResolvedValue("yes")],
  ])(
    "is not offered when %s, because the run still encodes",
    async (_label, createInvoke) => {
      const { store } = await startTrackedRun(createInvoke());

      await expect(store.getState().cancelExport()).resolves.toBe(false);

      const state = store.getState();
      expect(state.status).toBe("failed");
      expect(state.runId).toBe("run-live");
      expect(state.tracking).toBe(true);
      // The code alone would offer Back, which is why the rule reads `tracking`.
      expect(state.error?.code).toBe("unknown");
      expect(presentExportErrorRecovery(state.error)).toStrictEqual({
        kind: "backToSetup",
      });
      expect(canGoBackToSetup(state)).toBe(false);
    },
  );

  it("is offered once the run itself ends on a failure", async () => {
    const { store, emit } = await startTrackedRun(
      vi.fn().mockRejectedValue("IPC closed"),
    );
    await store.getState().cancelExport();

    emit({ event: "failed", runId: "run-live", code: "ffmpegProcessFailed" });

    expect(store.getState().tracking).toBe(false);
    expect(canGoBackToSetup(store.getState())).toBe(true);
  });

  it("is offered for a start that the backend refused", async () => {
    const store = createExportStore({
      subscribeExportProgress: () => Promise.resolve(() => {}),
      startExport: () => Promise.reject(new ExportError({ code: "outputReadOnly" })),
    });

    await store.getState().startExport(EXPORT_REQUEST);

    expect(canGoBackToSetup(store.getState())).toBe(true);
  });
});

describe("Back after a slot cancel that rejects during preparing", () => {
  /**
   * A store whose start waits until the test answers it, and whose `cancel_active_export`
   * goes through the real client with an invoke that rejects. The Stop fails while the start
   * still waits for its run id.
   */
  async function failTheStopWhileTheStartWaits() {
    let emit!: (event: ExportProgressEvent) => void;
    let answerStart: (start: ExportStart) => void = () => {};
    let refuseStart: (error: ExportError) => void = () => {};
    const startFn = vi.fn(
      () =>
        new Promise<ExportStart>((resolve, reject) => {
          answerStart = resolve;
          refuseStart = reject;
        }),
    );
    const store = createExportStore({
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
      startExport: startFn,
      cancelActiveExport: () =>
        clientCancelActiveExport({ invoke: vi.fn().mockRejectedValue("IPC closed") }),
    });

    const starting = store.getState().startExport(EXPORT_REQUEST);
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });
    await expect(store.getState().cancelExport()).resolves.toBe(false);
    return {
      store,
      starting,
      emit: (event: ExportProgressEvent) => {
        emit(event);
      },
      answerStart: (start: ExportStart) => {
        answerStart(start);
      },
      refuseStart: (error: ExportError) => {
        refuseStart(error);
      },
    };
  }

  it("is not offered while the backend can still encode the start that the store keeps", async () => {
    const { store, starting, answerStart } = await failTheStopWhileTheStartWaits();

    // The store keeps the start: failed, still tracked, and Back is not offered.
    expect(store.getState().status).toBe("failed");
    expect(store.getState().tracking).toBe(true);
    expect(canGoBackToSetup(store.getState())).toBe(false);

    // The backend answers with the run that it encodes. The store takes the answer.
    answerStart(startAnswer("run-kept"));
    await expect(starting).resolves.toMatchObject({ runId: "run-kept" });

    expect(store.getState().runId).toBe("run-kept");
    expect(store.getState().tracking).toBe(true);
    expect(canGoBackToSetup(store.getState())).toBe(false);
  });

  it("is offered once the kept run ends on a failure", async () => {
    const { store, starting, answerStart, emit } =
      await failTheStopWhileTheStartWaits();
    answerStart(startAnswer("run-kept"));
    await starting;

    emit({ event: "failed", runId: "run-kept", code: "ffmpegProcessFailed" });

    expect(store.getState().tracking).toBe(false);
    expect(canGoBackToSetup(store.getState())).toBe(true);
  });

  it("is offered once the backend refuses the kept start", async () => {
    const { store, starting, refuseStart } = await failTheStopWhileTheStartWaits();

    refuseStart(new ExportError({ code: "outputReadOnly" }));
    await expect(starting).resolves.toBeNull();

    expect(store.getState().error?.code).toBe("outputReadOnly");
    expect(store.getState().tracking).toBe(false);
    expect(canGoBackToSetup(store.getState())).toBe(true);
  });
});

describe("createOpenStepGeneration", () => {
  it("keeps a step current until something else begins or invalidates", () => {
    const generation = createOpenStepGeneration();

    const isCurrent = generation.begin();

    expect(isCurrent()).toBe(true);
    expect(isCurrent()).toBe(true);
  });

  it("makes a step stale when the dialog invalidates it", () => {
    const generation = createOpenStepGeneration();
    const isCurrent = generation.begin();

    generation.invalidate();

    expect(isCurrent()).toBe(false);
  });

  it("makes a step stale when a later step begins, and keeps the later one current", () => {
    const generation = createOpenStepGeneration();
    const first = generation.begin();

    const second = generation.begin();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("keeps each generation apart from the others", () => {
    const a = createOpenStepGeneration();
    const b = createOpenStepGeneration();
    const inA = a.begin();
    const inB = b.begin();

    a.invalidate();

    expect(inA()).toBe(false);
    expect(inB()).toBe(true);
  });
});

describe("guardOpenStepEffects", () => {
  it("passes each call through while the step is current", () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    const error = new Error("boom");

    const guarded = guardOpenStepEffects(() => true, { setModalOpen, reportError });
    guarded.setModalOpen(true);
    guarded.reportError(error);

    expect(setModalOpen).toHaveBeenCalledWith(true);
    expect(reportError).toHaveBeenCalledWith(error);
  });

  it("drops each call once the step is stale", () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();

    const guarded = guardOpenStepEffects(() => false, { setModalOpen, reportError });
    guarded.setModalOpen(true);
    guarded.reportError(new Error("late"));

    expect(setModalOpen).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reads the check at each call, not when it wraps", () => {
    const setModalOpen = vi.fn();
    const reportError = vi.fn();
    let current = true;

    const guarded = guardOpenStepEffects(() => current, { setModalOpen, reportError });
    current = false;
    guarded.setModalOpen(true);

    expect(setModalOpen).not.toHaveBeenCalled();
  });
});

describe("runOpenStepAgain", () => {
  /** A step that settles when the test answers it, with the effects that it received. */
  function controlledStep() {
    let settle: (opened: boolean) => void = () => {};
    let received: OpenStepEffects | null = null;
    const run = vi.fn(
      (effects: OpenStepEffects) =>
        new Promise<boolean>((resolve) => {
          received = effects;
          settle = resolve;
        }),
    );
    return {
      run,
      settle: (opened: boolean) => {
        settle(opened);
      },
      received: () => received,
    };
  }

  it("disables Export until the step answers, and resolves as the step does", async () => {
    const pending: boolean[] = [];
    const step = controlledStep();
    const running = runOpenStepAgain({
      generation: createOpenStepGeneration(),
      effects: { setModalOpen: vi.fn(), reportError: vi.fn() },
      setPending: (value) => pending.push(value),
      run: step.run,
    });
    expect(pending).toEqual([true]);
    expect(step.run).toHaveBeenCalledTimes(1);

    step.settle(true);
    await expect(running).resolves.toBe(true);
    expect(pending).toEqual([true, false]);
  });

  it("guards the effects of the step by its generation", async () => {
    const generation = createOpenStepGeneration();
    const effects = { setModalOpen: vi.fn(), reportError: vi.fn() };
    const step = controlledStep();
    const running = runOpenStepAgain({
      generation,
      effects,
      setPending: () => {},
      run: step.run,
    });

    step.received()?.setModalOpen(true);
    expect(effects.setModalOpen).toHaveBeenCalledTimes(1);

    generation.invalidate();
    step.received()?.setModalOpen(true);
    step.received()?.reportError(new Error("late"));
    expect(effects.setModalOpen).toHaveBeenCalledTimes(1);
    expect(effects.reportError).not.toHaveBeenCalled();

    step.settle(false);
    await running;
  });

  // The dialog closed, or a later step began: the flag belongs to that close or that step.
  it("leaves the flag alone when a stale step answers", async () => {
    const generation = createOpenStepGeneration();
    const pending: boolean[] = [];
    const first = controlledStep();
    const firstRun = runOpenStepAgain({
      generation,
      effects: { setModalOpen: vi.fn(), reportError: vi.fn() },
      setPending: (value) => pending.push(value),
      run: first.run,
    });
    const second = controlledStep();
    const secondRun = runOpenStepAgain({
      generation,
      effects: { setModalOpen: vi.fn(), reportError: vi.fn() },
      setPending: (value) => pending.push(value),
      run: second.run,
    });
    expect(pending).toEqual([true, true]);

    first.settle(true);
    await firstRun;
    expect(pending).toEqual([true, true]);

    second.settle(true);
    await secondRun;
    expect(pending).toEqual([true, true, false]);
  });

  it("clears the flag of a current step that rejects, and passes the rejection on", async () => {
    const pending: boolean[] = [];
    const running = runOpenStepAgain({
      generation: createOpenStepGeneration(),
      effects: { setModalOpen: vi.fn(), reportError: vi.fn() },
      setPending: (value) => pending.push(value),
      run: () => Promise.reject(new Error("load failed")),
    });

    await expect(running).rejects.toThrow("load failed");
    expect(pending).toEqual([true, false]);
  });
});

/**
 * The open step, as Back runs it: guarded effects, and a source check that answers only when
 * the test resolves it.
 */
function startGuardedOpenStep(revision: Partial<MediaSourceRevisionDescriptor>) {
  const generation = createOpenStepGeneration();
  const isCurrent = generation.begin();
  const setModalOpen = vi.fn();
  const reportError = vi.fn();
  const media = {
    path: "/media/source.mp4",
    fileName: "source.mp4",
    size: 4096,
    mtime: 1,
  };
  let answer: (value: MediaSourceRevisionDescriptor) => void = () => {};
  const readSourceRevision = vi.fn(
    () =>
      new Promise<MediaSourceRevisionDescriptor>((resolve) => {
        answer = resolve;
      }),
  );
  const settings: Settings = { schemaVersion: 1, revision: 1, presets: [] };

  const step = runExportFlow({
    ...guardOpenStepEffects(isCurrent, { setModalOpen, reportError }),
    filterName: "Video Files",
    getExportState: () => ({ status: "idle", tracking: false }),
    getMedia: () => media,
    readSourceRevision,
    getSourceId: () => "src-1",
    getSegments: () => [
      { id: "s1", sourceId: "src-1", inPts: "0" as Pts, outPts: "100" as Pts },
    ],
    getSettings: () => settings,
  });

  return {
    step,
    generation,
    setModalOpen,
    reportError,
    readSourceRevision,
    answer: () =>
      answer({ path: media.path, size: media.size, mtime: media.mtime, ...revision }),
  };
}

describe("the open step that Back runs", () => {
  it("opens the dialog when the source check answers while the step is current", async () => {
    const flow = startGuardedOpenStep({});
    await vi.waitFor(() => {
      expect(flow.readSourceRevision).toHaveBeenCalled();
    });

    flow.answer();

    await expect(flow.step).resolves.toBe(true);
    expect(flow.setModalOpen).toHaveBeenCalledWith(true);
    expect(flow.reportError).not.toHaveBeenCalled();
  });

  it("does not open a dialog that closed while the source check ran", async () => {
    const flow = startGuardedOpenStep({});
    await vi.waitFor(() => {
      expect(flow.readSourceRevision).toHaveBeenCalled();
    });

    flow.generation.invalidate();
    flow.answer();

    await expect(flow.step).resolves.toBe(true);
    expect(flow.setModalOpen).not.toHaveBeenCalled();
  });

  it("does not report a changed file into a store that was reset while the check ran", async () => {
    const flow = startGuardedOpenStep({ size: 8192 });
    await vi.waitFor(() => {
      expect(flow.readSourceRevision).toHaveBeenCalled();
    });

    flow.generation.invalidate();
    flow.answer();

    await expect(flow.step).resolves.toBe(false);
    expect(flow.reportError).not.toHaveBeenCalled();
    expect(flow.setModalOpen).not.toHaveBeenCalled();
  });

  it("reports a changed file while the step is current", async () => {
    const flow = startGuardedOpenStep({ size: 8192 });
    await vi.waitFor(() => {
      expect(flow.readSourceRevision).toHaveBeenCalled();
    });

    flow.answer();

    await expect(flow.step).resolves.toBe(false);
    expect(flow.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "sourceRevisionChanged" }),
    );
    expect(flow.setModalOpen).toHaveBeenCalledWith(true);
  });
});
