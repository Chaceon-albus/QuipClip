import { describe, expect, it, vi } from "vitest";
import {
  cancelActiveExport as clientCancelActiveExport,
  cancelExport as clientCancelExport,
  createExportStore,
  EXPORT_STATUSES,
  isExportRunLive,
  type ExportProgressEvent,
  type ExportRequest,
  type ExportStart,
  type ExportStatus,
} from "@/features/export";
import type { InvokeFn } from "@/lib/ipc";
import type { Pts } from "@/types/project";
import {
  isCancelEnabled,
  isCancelOutstanding,
  isExportRunActive,
  resolveExportDismissal,
} from "./exportCancelState";

const RUN_ID = "run-abc-123";

describe("isExportRunActive", () => {
  it("is true exactly in preparing, running, and publishing", () => {
    for (const status of EXPORT_STATUSES) {
      const isProgress =
        status === "preparing" || status === "running" || status === "publishing";
      expect(isExportRunActive(status)).toBe(isProgress);
    }
  });
});

describe("resolveExportDismissal", () => {
  it("answers 'hide' for preparing, running, and publishing, with or without tracking", () => {
    const hideStatuses: ExportStatus[] = ["preparing", "running", "publishing"];
    for (const status of hideStatuses) {
      expect(resolveExportDismissal({ status, tracking: false })).toBe("hide");
      expect(resolveExportDismissal({ status, tracking: true })).toBe("hide");
    }
  });

  it("answers 'hide' for a failure while the store still tracks the run", () => {
    // A Stop request failed, and the backend still encodes. A reset would drop the run.
    expect(resolveExportDismissal({ status: "failed", tracking: true })).toBe("hide");
  });

  it("answers 'close' for idle and for every result with no tracked run", () => {
    const closeStatuses: ExportStatus[] = ["idle", "finished", "failed", "canceled"];
    for (const status of closeStatuses) {
      expect(resolveExportDismissal({ status, tracking: false })).toBe("close");
    }
  });

  it("follows isExportRunLive for every status and tracking", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        expect(resolveExportDismissal({ status, tracking })).toBe(
          isExportRunLive({ status, tracking }) ? "hide" : "close",
        );
      }
    }
  });

  describe("on the state of a real store after a failed Stop request", () => {
    // The dialog passes the store state itself, at the click, to this rule for its close
    // control, its Close button, Escape, and an outside click (`closeAndReset`).
    const REQUEST: ExportRequest = {
      sourcePath: "/media/source.mp4",
      outputPath: "/media/output.mp4",
      segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
      presetId: "mp4-h264",
    };
    const START: ExportStart = {
      runId: "run-live",
      presetId: "mp4-h264",
      outputPath: "/media/output.mp4",
      segmentCount: 1,
      totalDurationUs: 5_000_000,
      expectedFrames: 150,
    };

    /** A store whose Stop requests reach an IPC layer that rejects each call. */
    function createStore(startExport: () => Promise<ExportStart>) {
      let emit!: (event: ExportProgressEvent) => void;
      const rejectingInvoke = vi.fn().mockRejectedValue("IPC closed");
      const store = createExportStore({
        subscribeExportProgress: (handler) => {
          emit = handler;
          return Promise.resolve(() => {});
        },
        startExport,
        cancelExport: (runId) => clientCancelExport(runId, { invoke: rejectingInvoke }),
        cancelActiveExport: () => clientCancelActiveExport({ invoke: rejectingInvoke }),
      });
      return {
        store,
        emit: (event: ExportProgressEvent) => {
          emit(event);
        },
      };
    }

    it("hides while a run that the store knows by its id continues", async () => {
      const { store, emit } = createStore(() => Promise.resolve(START));
      await store.getState().startExport(REQUEST);
      await store.getState().cancelExport();
      expect(store.getState()).toMatchObject({ status: "failed", tracking: true });

      expect(resolveExportDismissal(store.getState())).toBe("hide");

      emit({ event: "failed", runId: "run-live", code: "ffmpegProcessFailed" });
      expect(resolveExportDismissal(store.getState())).toBe("close");
    });

    it("hides while a start that waits for its run id continues", async () => {
      let answer: (start: ExportStart) => void = () => {};
      const startFn = vi.fn(
        () =>
          new Promise<ExportStart>((resolve) => {
            answer = resolve;
          }),
      );
      const { store, emit } = createStore(startFn);
      const starting = store.getState().startExport(REQUEST);
      await vi.waitFor(() => {
        expect(startFn).toHaveBeenCalled();
      });
      await store.getState().cancelExport();
      expect(store.getState()).toMatchObject({
        status: "failed",
        runId: null,
        tracking: true,
      });

      expect(resolveExportDismissal(store.getState())).toBe("hide");

      answer(START);
      await starting;
      expect(resolveExportDismissal(store.getState())).toBe("hide");

      emit({
        event: "finished",
        runId: "run-live",
        outputPath: "/media/output.mp4",
        frames: 150,
      });
      expect(resolveExportDismissal(store.getState())).toBe("close");
    });
  });
});

describe("isCancelOutstanding", () => {
  it("reports true in progress statuses when cancelRequested is true", () => {
    for (const status of EXPORT_STATUSES) {
      const isProgress =
        status === "preparing" || status === "running" || status === "publishing";
      expect(
        isCancelOutstanding({ status, cancelRequested: true, tracking: false }),
      ).toBe(isProgress);
    }
  });

  it("reports false in every status when cancelRequested is false", () => {
    for (const status of EXPORT_STATUSES) {
      expect(
        isCancelOutstanding({ status, cancelRequested: false, tracking: false }),
      ).toBe(false);
    }
  });

  it("reports a retried stop as outstanding in a failure that the store still tracks", () => {
    expect(
      isCancelOutstanding({ status: "failed", cancelRequested: true, tracking: true }),
    ).toBe(true);
    expect(
      isCancelOutstanding({ status: "failed", cancelRequested: true, tracking: false }),
    ).toBe(false);
  });

  it("follows isExportRunLive for every status and tracking", () => {
    for (const status of EXPORT_STATUSES) {
      for (const tracking of [false, true]) {
        expect(isCancelOutstanding({ status, cancelRequested: true, tracking })).toBe(
          isExportRunLive({ status, tracking }),
        );
      }
    }
  });
});

describe("isCancelEnabled", () => {
  it("enables cancel in preparing with or without a run id when no cancel is requested", () => {
    expect(
      isCancelEnabled({
        status: "preparing",
        runId: null,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(true);
    expect(
      isCancelEnabled({
        status: "preparing",
        runId: RUN_ID,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(true);
  });

  it("disables cancel in preparing when a cancel is requested", () => {
    expect(
      isCancelEnabled({
        status: "preparing",
        runId: null,
        cancelRequested: true,
        tracking: false,
      }),
    ).toBe(false);
    expect(
      isCancelEnabled({
        status: "preparing",
        runId: RUN_ID,
        cancelRequested: true,
        tracking: false,
      }),
    ).toBe(false);
  });

  it("enables cancel in running only when runId is known and no cancel is requested", () => {
    expect(
      isCancelEnabled({
        status: "running",
        runId: RUN_ID,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(true);
    expect(
      isCancelEnabled({
        status: "running",
        runId: null,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(false);
    expect(
      isCancelEnabled({
        status: "running",
        runId: RUN_ID,
        cancelRequested: true,
        tracking: false,
      }),
    ).toBe(false);
  });

  it("disables cancel in publishing regardless of runId or cancelRequested", () => {
    expect(
      isCancelEnabled({
        status: "publishing",
        runId: RUN_ID,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(false);
    expect(
      isCancelEnabled({
        status: "publishing",
        runId: null,
        cancelRequested: false,
        tracking: false,
      }),
    ).toBe(false);
    expect(
      isCancelEnabled({
        status: "publishing",
        runId: RUN_ID,
        cancelRequested: true,
        tracking: false,
      }),
    ).toBe(false);
  });

  it("disables cancel in all non-progress statuses", () => {
    for (const status of EXPORT_STATUSES) {
      if (status === "preparing" || status === "running" || status === "publishing") {
        continue;
      }
      expect(
        isCancelEnabled({
          status,
          runId: RUN_ID,
          cancelRequested: false,
          tracking: false,
        }),
      ).toBe(false);
      expect(
        isCancelEnabled({
          status,
          runId: null,
          cancelRequested: false,
          tracking: false,
        }),
      ).toBe(false);
      expect(
        isCancelEnabled({
          status,
          runId: RUN_ID,
          cancelRequested: true,
          tracking: false,
        }),
      ).toBe(false);
    }
  });

  it("enables cancel again after a failed Stop while the store still tracks the run", () => {
    // By run id, and by slot while the start still waits for its run id.
    for (const runId of [RUN_ID, null]) {
      expect(
        isCancelEnabled({
          status: "failed",
          runId,
          cancelRequested: false,
          tracking: true,
        }),
      ).toBe(true);
      expect(
        isCancelEnabled({
          status: "failed",
          runId,
          cancelRequested: true,
          tracking: true,
        }),
      ).toBe(false);
    }
  });

  it("keeps publishing, finished, and canceled disabled with a tracked run", () => {
    for (const status of ["publishing", "finished", "canceled", "idle"] as const) {
      expect(
        isCancelEnabled({
          status,
          runId: RUN_ID,
          cancelRequested: false,
          tracking: true,
        }),
      ).toBe(false);
    }
  });
});

describe("isCancelEnabled on the state of a real store", () => {
  // The dialog passes the store fields to `presentStopButton`, which applies this rule.
  const REQUEST: ExportRequest = {
    sourcePath: "/media/source.mp4",
    outputPath: "/media/output.mp4",
    segments: [{ inPts: "0" as Pts, outPts: "1000" as Pts }],
    presetId: "mp4-h264",
  };
  const START: ExportStart = {
    runId: "run-live",
    presetId: "mp4-h264",
    outputPath: "/media/output.mp4",
    segmentCount: 1,
    totalDurationUs: 5_000_000,
    expectedFrames: 150,
  };

  function createEncodingStore(invoke: InvokeFn) {
    let emit!: (event: ExportProgressEvent) => void;
    const store = createExportStore({
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
      startExport: () => Promise.resolve(START),
      cancelExport: (runId) => clientCancelExport(runId, { invoke }),
    });
    const send = (event: ExportProgressEvent) => {
      emit(event);
    };
    return { store, emit: send };
  }

  async function startEncode(invoke: InvokeFn) {
    const fixture = createEncodingStore(invoke);
    await fixture.store.getState().startExport(REQUEST);
    fixture.emit({
      event: "started",
      runId: "run-live",
      outputPath: "/media/output.mp4",
      segmentCount: 1,
      totalDurationUs: 5_000_000,
      expectedFrames: 150,
    });
    fixture.emit({ event: "progress", runId: "run-live", frame: 140 });
    return fixture;
  }

  it("stays disabled when a Stop in flight rejects after the publishing event", async () => {
    // ADR 016: the backend ran its last cancel test before it sent `publishing`, so no
    // stop can prevent the rename. A live `failed` there would enable Stop again.
    let reject!: (reason: unknown) => void;
    const invoke = vi.fn().mockReturnValueOnce(
      new Promise((_resolve, rejectCall) => {
        reject = rejectCall;
      }),
    );
    const { store, emit } = await startEncode(invoke);

    const stopping = store.getState().cancelExport();
    emit({ event: "publishing", runId: "run-live" });
    reject("IPC closed");
    await expect(stopping).resolves.toBe(false);

    const state = store.getState();
    expect(state.status).toBe("publishing");
    expect(state.error).toBeNull();
    expect(isCancelEnabled(state)).toBe(false);
  });

  it("enables the retry after a Stop by run id that failed during the encode", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce("IPC closed")
      .mockReturnValueOnce(new Promise(() => {}));
    const { store } = await startEncode(invoke);

    await store.getState().cancelExport();
    expect(store.getState().status).toBe("failed");
    expect(isCancelEnabled(store.getState())).toBe(true);

    // The retry is outstanding, so the button shows "Stopping…" and takes no click.
    void store.getState().cancelExport();
    expect(isCancelOutstanding(store.getState())).toBe(true);
    expect(isCancelEnabled(store.getState())).toBe(false);
  });

  it("enables the retry by slot while the start still waits for its run id", async () => {
    const startFn = vi.fn(() => new Promise<ExportStart>(() => {}));
    const store = createExportStore({
      subscribeExportProgress: () => Promise.resolve(() => {}),
      startExport: startFn,
      cancelActiveExport: () =>
        clientCancelActiveExport({ invoke: vi.fn().mockRejectedValue("IPC closed") }),
    });
    void store.getState().startExport(REQUEST);
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });

    await store.getState().cancelExport();

    expect(store.getState()).toMatchObject({ status: "failed", runId: null });
    expect(isCancelEnabled(store.getState())).toBe(true);
  });
});
