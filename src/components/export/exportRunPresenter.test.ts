import { describe, expect, it } from "vitest";
import {
  EXPORT_STATUSES,
  NO_EXPORT_RUN_TIMING,
  type ExportRunTiming,
} from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  presentExportProgress,
  type ExportProgressInput,
  type ExportProgressView,
} from "./exportProgressPresenter";
import {
  ELAPSED_TICK_SLACK_MS,
  exportElapsedMs,
  msUntilNextElapsedSecond,
  phaseLabelKey,
  presentExportReadout,
  presentExportRunBar,
  readoutDetailKey,
  selectExportProgressFields,
  type ExportReadoutDetailKey,
  type ExportRunBarInput,
} from "./exportRunPresenter";

function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createInput(
  overrides: Partial<ExportProgressInput> = {},
): ExportProgressInput {
  return {
    status: "running",
    frame: 250,
    expectedFrames: 1000,
    fps: { n: 25, d: 1 },
    speed: { n: 9, d: 5 },
    cancelRequested: false,
    tracking: false,
    encodeStarted: true,
    ...overrides,
  };
}

function viewOf(overrides: Partial<ExportProgressInput> = {}): ExportProgressView {
  const view = presentExportProgress(createInput(overrides));
  if (view === null) {
    throw new Error("the input must be an active status");
  }
  return view;
}

function barInput(overrides: Partial<ExportRunBarInput> = {}): ExportRunBarInput {
  return { ...createInput(), tracking: false, ...overrides };
}

describe("selectExportProgressFields", () => {
  it("picks the fields that change with the progress events", () => {
    const state = {
      ...createInput(),
      runId: "run-1",
      outputPath: "/out.mp4",
    };
    expect(selectExportProgressFields(state)).toEqual({
      frame: 250,
      expectedFrames: 1000,
      fps: { n: 25, d: 1 },
      speed: { n: 9, d: 5 },
      encodeStarted: true,
    });
  });
});

describe("exportElapsedMs", () => {
  it("counts from the start to now while the run continues", () => {
    expect(exportElapsedMs({ startedAt: 1_000, endedAt: null }, 43_500)).toBe(42_500);
  });

  it("stays at the end after the run ended, whatever now is", () => {
    const ended: ExportRunTiming = { startedAt: 1_000, endedAt: 84_500 };
    expect(exportElapsedMs(ended, 200_000)).toBe(83_500);
    expect(exportElapsedMs(ended, null)).toBe(83_500);
  });

  it("gives null with no run, and with no clock for a run that continues", () => {
    expect(exportElapsedMs(NO_EXPORT_RUN_TIMING, 5_000)).toBeNull();
    expect(exportElapsedMs({ startedAt: 1_000, endedAt: null }, null)).toBeNull();
  });

  it("never gives a negative time", () => {
    expect(exportElapsedMs({ startedAt: 5_000, endedAt: null }, 4_000)).toBe(0);
    expect(exportElapsedMs({ startedAt: 5_000, endedAt: 4_000 }, null)).toBe(0);
  });
});

describe("msUntilNextElapsedSecond", () => {
  it("waits for the next whole second of the run, plus the slack", () => {
    expect(msUntilNextElapsedSecond(1_000, 1_000)).toBe(1_000 + ELAPSED_TICK_SLACK_MS);
    expect(msUntilNextElapsedSecond(1_000, 1_250)).toBe(750 + ELAPSED_TICK_SLACK_MS);
    expect(msUntilNextElapsedSecond(1_000, 43_999)).toBe(1 + ELAPSED_TICK_SLACK_MS);
  });

  it("keeps the ticks on the seconds of the run when each tick is late by the slack", () => {
    let now = 1_000 + ELAPSED_TICK_SLACK_MS;
    for (let tick = 0; tick < 5; tick++) {
      const delay = msUntilNextElapsedSecond(1_000, now);
      expect(delay).toBe(1_000);
      now += delay;
    }
  });

  it("counts a time before the start as the start", () => {
    expect(msUntilNextElapsedSecond(1_000, 400)).toBe(1_000 + ELAPSED_TICK_SLACK_MS);
  });

  it("gives one second for a time that is not finite", () => {
    expect(msUntilNextElapsedSecond(Number.NaN, 1_000)).toBe(1_000);
    expect(msUntilNextElapsedSecond(0, Number.POSITIVE_INFINITY)).toBe(1_000);
  });
});

describe("phaseLabelKey", () => {
  it("names a key that both catalogs hold for each phase", () => {
    for (const phase of ["preparing", "running", "publishing", "canceling"] as const) {
      const key = phaseLabelKey(phase);
      expect(typeof resolveCatalogKey(en, key)).toBe("string");
      expect(typeof resolveCatalogKey(zhCN, key)).toBe("string");
    }
  });
});

describe("presentExportReadout", () => {
  it("shows the percent, the remaining time, the frames, and the speed while encoding", () => {
    expect(presentExportReadout(viewOf())).toEqual({
      lead: { kind: "percent", fraction: 0.25 },
      trail: { kind: "remaining", seconds: 30 },
      frames: { kind: "ofTotal", frame: 250, expectedFrames: 1000 },
      speed: 1.8,
    });
  });

  it("shows no phase word beside the percent before the first rate", () => {
    const readout = presentExportReadout(viewOf({ fps: null }));
    expect(readout.lead).toEqual({ kind: "percent", fraction: 0.25 });
    expect(readout.trail).toBeNull();
  });

  it("names the phase alone while preparing, with no frame and no speed", () => {
    expect(
      presentExportReadout(
        viewOf({ status: "preparing", frame: null, expectedFrames: null }),
      ),
    ).toEqual({
      lead: { kind: "phase", key: "export.status.preparing" },
      trail: null,
      frames: null,
      speed: null,
    });
  });

  it("names the phase and counts the frames when the total is unknown", () => {
    expect(presentExportReadout(viewOf({ expectedFrames: null }))).toEqual({
      lead: { kind: "phase", key: "export.status.running" },
      trail: null,
      frames: { kind: "count", frame: 250 },
      speed: 1.8,
    });
  });

  it("counts the frames for a zero total, as for no total", () => {
    expect(presentExportReadout(viewOf({ expectedFrames: 0 })).frames).toEqual({
      kind: "count",
      frame: 250,
    });
  });

  it("shows no frame count before the first progress event", () => {
    expect(presentExportReadout(viewOf({ frame: null })).frames).toBeNull();
  });

  it("puts the phase after 100 percent while the output is published", () => {
    const readout = presentExportReadout(viewOf({ status: "publishing", frame: 1000 }));
    expect(readout.lead).toEqual({ kind: "percent", fraction: 1 });
    expect(readout.trail).toEqual({ kind: "phase", key: "export.status.publishing" });
    // The last count stays, so the line does not disappear for the last step.
    expect(readout.frames).toEqual({
      kind: "ofTotal",
      frame: 1000,
      expectedFrames: 1000,
    });
  });

  it("puts Stopping after the percent while a stop is outstanding", () => {
    const readout = presentExportReadout(viewOf({ cancelRequested: true }));
    expect(readout.lead).toEqual({ kind: "percent", fraction: 0.25 });
    expect(readout.trail).toEqual({ kind: "phase", key: "export.status.canceling" });
  });

  it("names Stopping alone when a stop comes before the percent is known", () => {
    const readout = presentExportReadout(
      viewOf({ status: "preparing", frame: null, cancelRequested: true }),
    );
    expect(readout.lead).toEqual({ kind: "phase", key: "export.status.canceling" });
    expect(readout.trail).toBeNull();
  });
});

describe("presentExportRunBar", () => {
  it("gives no bar at idle", () => {
    expect(presentExportRunBar(barInput({ status: "idle" }))).toBeNull();
  });

  it("gives the bar of the progress presenter while a run is active", () => {
    expect(presentExportRunBar(barInput())).toEqual({
      value: 25,
      tone: "default",
      flowing: true,
      decorative: false,
    });
    expect(presentExportRunBar(barInput({ status: "preparing", frame: null }))).toEqual(
      { value: null, tone: "default", flowing: true, decorative: false },
    );
    expect(presentExportRunBar(barInput({ status: "publishing" }))?.value).toBe(100);
  });

  it("stops the gradient while a stop is outstanding", () => {
    expect(presentExportRunBar(barInput({ cancelRequested: true }))?.flowing).toBe(
      false,
    );
  });

  it("gives a full, still, success bar when the run finished", () => {
    expect(presentExportRunBar(barInput({ status: "finished", frame: 998 }))).toEqual({
      value: 100,
      tone: "success",
      flowing: false,
      decorative: true,
    });
  });

  it("keeps the fill that a failed run reached, in the destructive tone", () => {
    expect(presentExportRunBar(barInput({ status: "failed", frame: 400 }))).toEqual({
      value: 40,
      tone: "destructive",
      flowing: false,
      decorative: true,
    });
  });

  it("keeps the fill that a stopped run reached, in the neutral tone", () => {
    expect(presentExportRunBar(barInput({ status: "canceled", frame: 600 }))).toEqual({
      value: 60,
      tone: "neutral",
      flowing: false,
      decorative: true,
    });
  });

  it("gives no bar for a result with no known fill", () => {
    for (const status of ["failed", "canceled"] as const) {
      expect(presentExportRunBar(barInput({ status, frame: null }))).toBeNull();
      expect(
        presentExportRunBar(barInput({ status, expectedFrames: null })),
      ).toBeNull();
      expect(presentExportRunBar(barInput({ status, expectedFrames: 0 }))).toBeNull();
    }
  });

  it("gives a bar for each status that shows a run", () => {
    for (const status of EXPORT_STATUSES) {
      const bar = presentExportRunBar(barInput({ status }));
      expect(bar === null).toBe(status === "idle");
    }
  });

  describe("a failure that the store still tracks", () => {
    // A Stop failed at the IPC layer, and the backend still encodes the run.
    it("keeps the default, flowing bar of a run, not a result bar", () => {
      expect(
        presentExportRunBar(barInput({ status: "failed", tracking: true, frame: 400 })),
      ).toEqual({ value: 40, tone: "default", flowing: true, decorative: false });
    });

    it("keeps filling as the frames arrive", () => {
      const values = [400, 500, 600].map(
        (frame) =>
          presentExportRunBar(barInput({ status: "failed", tracking: true, frame }))
            ?.value,
      );
      expect(values).toEqual([40, 50, 60]);
    });

    it("gives an indeterminate run bar when the fill is unknown", () => {
      expect(
        presentExportRunBar(
          barInput({ status: "failed", tracking: true, expectedFrames: null }),
        ),
      ).toEqual({ value: null, tone: "default", flowing: true, decorative: false });
    });

    it("stops the gradient while a retried stop is outstanding", () => {
      expect(
        presentExportRunBar(
          barInput({
            status: "failed",
            tracking: true,
            frame: 400,
            cancelRequested: true,
          }),
        ),
      ).toEqual({ value: 40, tone: "default", flowing: false, decorative: false });
    });

    it("turns destructive only when the store stops tracking the run", () => {
      expect(
        presentExportRunBar(barInput({ status: "failed", tracking: false, frame: 400 }))
          ?.tone,
      ).toBe("destructive");
    });
  });
});

describe("readoutDetailKey", () => {
  const ofTotal = { kind: "ofTotal", frame: 5, expectedFrames: 10 } as const;
  const count = { kind: "count", frame: 5 } as const;

  it("gives one sentence for each combination of the frame count and the speed", () => {
    expect(readoutDetailKey({ frames: ofTotal, speed: 1.5 })).toBe(
      "export.progress.framesAndSpeed",
    );
    expect(readoutDetailKey({ frames: ofTotal, speed: null })).toBe(
      "export.progress.frames",
    );
    expect(readoutDetailKey({ frames: count, speed: 1.5 })).toBe(
      "export.progress.frameCountAndSpeed",
    );
    expect(readoutDetailKey({ frames: count, speed: null })).toBe(
      "export.progress.frameCount",
    );
    expect(readoutDetailKey({ frames: null, speed: 1.5 })).toBe("export.status.speed");
  });

  it("gives null when neither is known", () => {
    expect(readoutDetailKey({ frames: null, speed: null })).toBeNull();
  });

  it("names keys that both catalogs hold, with the same placeholders", () => {
    const keys: ExportReadoutDetailKey[] = [
      "export.progress.framesAndSpeed",
      "export.progress.frames",
      "export.progress.frameCountAndSpeed",
      "export.progress.frameCount",
      "export.status.speed",
    ];
    const placeholders = (text: unknown) =>
      String(text)
        .match(/\{\{\w+\}\}|<\/?num>/g)
        ?.sort() ?? [];
    for (const key of keys) {
      const english = resolveCatalogKey(en, key);
      const chinese = resolveCatalogKey(zhCN, key);
      expect(typeof english).toBe("string");
      expect(typeof chinese).toBe("string");
      expect(placeholders(chinese)).toEqual(placeholders(english));
    }
  });
});
