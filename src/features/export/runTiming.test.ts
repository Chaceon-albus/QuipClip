import { describe, expect, it } from "vitest";
import { createExportStore } from "./store";
import {
  NO_EXPORT_RUN_TIMING,
  bindRunTimingToExportRun,
  createExportRunTimingStore,
  trackExportRunTiming,
  type ExportRunTiming,
} from "./runTiming";
import { EXPORT_STATUSES, type ExportStatus } from "./types";

const ACTIVE: ExportStatus[] = ["preparing", "running", "publishing"];
const FINAL: ExportStatus[] = ["finished", "failed", "canceled"];

describe("trackExportRunTiming", () => {
  it("starts a run at the first active status", () => {
    for (const status of ACTIVE) {
      expect(
        trackExportRunTiming(NO_EXPORT_RUN_TIMING, { status, tracking: false }, 500),
      ).toEqual({ startedAt: 500, endedAt: null });
    }
  });

  it("keeps the start through later active statuses and the run id", () => {
    let timing = trackExportRunTiming(
      NO_EXPORT_RUN_TIMING,
      { status: "preparing", tracking: false },
      500,
    );
    const started = timing;
    timing = trackExportRunTiming(timing, { status: "preparing", tracking: true }, 900);
    timing = trackExportRunTiming(timing, { status: "running", tracking: true }, 9_000);
    timing = trackExportRunTiming(
      timing,
      { status: "publishing", tracking: true },
      60_000,
    );
    expect(timing).toBe(started);
  });

  it("ends the run at each final status", () => {
    const open: ExportRunTiming = { startedAt: 500, endedAt: null };
    for (const status of FINAL) {
      expect(trackExportRunTiming(open, { status, tracking: false }, 84_500)).toEqual({
        startedAt: 500,
        endedAt: 84_500,
      });
    }
  });

  it("keeps a failed run open while the store still tracks it", () => {
    // A cancel call that failed at the IPC layer reports `failed`, and the backend still
    // encodes. The run can still finish, so its end is the finish.
    const open: ExportRunTiming = { startedAt: 500, endedAt: null };
    const failed = trackExportRunTiming(
      open,
      { status: "failed", tracking: true },
      30_000,
    );
    expect(failed).toBe(open);
    expect(
      trackExportRunTiming(failed, { status: "finished", tracking: false }, 90_000),
    ).toEqual({ startedAt: 500, endedAt: 90_000 });
  });

  it("keeps the end through a later final status", () => {
    const ended: ExportRunTiming = { startedAt: 500, endedAt: 84_500 };
    expect(
      trackExportRunTiming(ended, { status: "failed", tracking: false }, 99_000),
    ).toBe(ended);
  });

  it("records no run for a failure of the open step", () => {
    expect(
      trackExportRunTiming(
        NO_EXPORT_RUN_TIMING,
        { status: "failed", tracking: false },
        1_000,
      ),
    ).toBe(NO_EXPORT_RUN_TIMING);
  });

  it("clears the timing at idle, and keeps the empty timing as it is", () => {
    expect(
      trackExportRunTiming(
        { startedAt: 500, endedAt: 84_500 },
        { status: "idle", tracking: false },
        99_000,
      ),
    ).toBe(NO_EXPORT_RUN_TIMING);
    const empty: ExportRunTiming = { startedAt: null, endedAt: null };
    expect(trackExportRunTiming(empty, { status: "idle", tracking: false }, 1)).toBe(
      empty,
    );
  });

  it("gives the next run its own start after a final status", () => {
    const ended: ExportRunTiming = { startedAt: 500, endedAt: 40_000 };
    expect(
      trackExportRunTiming(ended, { status: "preparing", tracking: false }, 50_000),
    ).toEqual({ startedAt: 50_000, endedAt: null });
  });

  it("covers every status in EXPORT_STATUSES", () => {
    for (const status of EXPORT_STATUSES) {
      const timing = trackExportRunTiming(
        NO_EXPORT_RUN_TIMING,
        { status, tracking: false },
        42,
      );
      expect(timing.startedAt).toBe(ACTIVE.includes(status) ? 42 : null);
      expect(timing.endedAt).toBeNull();
    }
  });
});

describe("bindRunTimingToExportRun", () => {
  function setup(initialState?: Parameters<typeof createExportStore>[1]) {
    const source = createExportStore({}, initialState);
    const timing = createExportRunTimingStore();
    let clock = 1_000;
    const unbind = bindRunTimingToExportRun(source, timing, () => clock);
    return {
      source,
      timing,
      unbind,
      setClock: (value: number) => {
        clock = value;
      },
    };
  }

  it("starts empty for an idle store", () => {
    const { timing } = setup();
    expect(timing.getState()).toEqual(NO_EXPORT_RUN_TIMING);
  });

  it("starts the timing at the binding for a store that holds a run", () => {
    const { timing } = setup({ status: "running", runId: "run-1" });
    expect(timing.getState()).toEqual({ startedAt: 1_000, endedAt: null });
  });

  it("records the start and the end of a run", () => {
    const { source, timing, setClock } = setup();
    setClock(2_000);
    source.setState({ status: "preparing" });
    setClock(5_000);
    source.setState({ status: "running" });
    setClock(84_000);
    source.setState({ status: "finished" });
    expect(timing.getState()).toEqual({ startedAt: 2_000, endedAt: 84_000 });
    source.setState({ status: "idle" });
    expect(timing.getState()).toBe(NO_EXPORT_RUN_TIMING);
  });

  it("does not notify on a progress event, which changes neither field", () => {
    const { source, timing } = setup({ status: "running", runId: "run-1" });
    let notified = 0;
    timing.subscribe(() => {
      notified += 1;
    });
    for (let frame = 1; frame <= 50; frame++) {
      source.setState({ frame });
    }
    expect(notified).toBe(0);
  });

  it("has changed the timing when the status change returns", () => {
    // React renders after the store update returns, so the render of a status change reads
    // the timing of that change: the first frame of a finished panel carries its time.
    // A listener that subscribed after the binding also sees it.
    const { source, timing, setClock } = setup();
    source.setState({ status: "running" });
    const seen: ExportRunTiming[] = [];
    source.subscribe((state, previous) => {
      if (state.status !== previous.status) {
        seen.push(timing.getState());
      }
    });
    setClock(9_000);
    source.setState({ status: "finished" });
    expect(timing.getState()).toEqual({ startedAt: 1_000, endedAt: 9_000 });
    expect(seen).toEqual([{ startedAt: 1_000, endedAt: 9_000 }]);
  });

  it("stops when it is unbound", () => {
    const { source, timing, unbind } = setup();
    unbind();
    source.setState({ status: "running" });
    expect(timing.getState()).toEqual(NO_EXPORT_RUN_TIMING);
  });
});
