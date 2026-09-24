import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, isExportRunLive, type ExportStatus } from "@/features/export";
import { formatSegmentTotal } from "@/features/timeline";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { MILLISECONDS_TIMECODE_DISPLAY, type TimecodeDisplay } from "@/lib/timecode";
import type { Rational } from "@/types/project";
import { canExportMedia } from "./actionConditions";
import { presentExportAction, type ExportActionInput } from "./exportActionPresenter";

const ms: Rational = { n: 1, d: 1000 };
const fps25: Rational = { n: 25, d: 1 };
const fps2997: Rational = { n: 30000, d: 1001 };

const framesDisplay = (rate: Rational, videoTimeBase: Rational | null = ms) =>
  ({ format: "frames", rate, videoTimeBase }) as const satisfies TimecodeDisplay;

const ACTIVE_STATUSES: readonly ExportStatus[] = ["preparing", "running", "publishing"];
const IDLE_STATUSES: readonly ExportStatus[] = EXPORT_STATUSES.filter(
  (status) => !ACTIVE_STATUSES.includes(status),
);

function input(overrides: Partial<ExportActionInput> = {}): ExportActionInput {
  return {
    hasMedia: true,
    exportStatus: "idle",
    exportTracking: false,
    segmentCount: 2,
    // 251 frames at 25 fps.
    segmentTotal: 251n,
    display: framesDisplay(fps25),
    ...overrides,
  };
}

function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

describe("presentExportAction", () => {
  it("is disabled with no media, and says to open a video", () => {
    expect(presentExportAction(input({ hasMedia: false, segmentCount: 0 }))).toEqual({
      disabled: true,
      busy: false,
      label: { key: "titleBar.action.export" },
      reason: "titleBar.exportTooltip.openVideoFirst",
    });
  });

  it("uses canExportMedia for the disabled state, in every status", () => {
    for (const hasMedia of [true, false]) {
      for (const exportStatus of EXPORT_STATUSES) {
        for (const segmentCount of [0, 1, 3]) {
          const view = presentExportAction(
            input({ hasMedia, exportStatus, segmentCount }),
          );
          expect(view.disabled).toBe(!canExportMedia(hasMedia));
        }
      }
    }
  });

  it("gives the no-media reason before an active run", () => {
    // Media stays open once it is open, so the application does not reach this state.
    for (const exportStatus of ACTIVE_STATUSES) {
      const view = presentExportAction(input({ hasMedia: false, exportStatus }));
      expect(view.disabled).toBe(true);
      expect(view.busy).toBe(false);
      expect(view.reason).toBe("titleBar.exportTooltip.openVideoFirst");
    }
  });

  it("shows the running export while a run is active", () => {
    for (const exportStatus of ACTIVE_STATUSES) {
      for (const segmentCount of [0, 2]) {
        expect(presentExportAction(input({ exportStatus, segmentCount }))).toEqual({
          disabled: false,
          busy: true,
          label: { key: "titleBar.exportTooltip.showRunningExport" },
          reason: null,
        });
      }
    }
  });

  it("is not busy in a status without an active run", () => {
    for (const exportStatus of IDLE_STATUSES) {
      expect(presentExportAction(input({ exportStatus })).busy).toBe(false);
    }
  });

  it("shows the running export for a failure while the store still tracks the run", () => {
    // A Stop request failed, and the backend still encodes. A click opens the dialog on the
    // run (`ExportFlowController.run`), so the tooltip says that.
    expect(
      presentExportAction(input({ exportStatus: "failed", exportTracking: true })),
    ).toEqual({
      disabled: false,
      busy: true,
      label: { key: "titleBar.exportTooltip.showRunningExport" },
      reason: null,
    });
  });

  it("follows isExportRunLive for busy, in every status and tracking", () => {
    for (const exportStatus of EXPORT_STATUSES) {
      for (const exportTracking of [false, true]) {
        expect(presentExportAction(input({ exportStatus, exportTracking })).busy).toBe(
          isExportRunLive({ status: exportStatus, tracking: exportTracking }),
        );
      }
    }
  });

  it("stays available with no segment, and says to mark one", () => {
    // The dialog reports noSegments on a click (ADR 024), so the action is not disabled.
    for (const exportStatus of IDLE_STATUSES) {
      expect(
        presentExportAction(input({ exportStatus, segmentCount: 0, segmentTotal: 0n })),
      ).toEqual({
        disabled: false,
        busy: false,
        label: { key: "titleBar.action.export" },
        reason: "titleBar.exportTooltip.markSegmentFirst",
      });
    }
  });

  it("names the segment count and the frame total in the frame format", () => {
    expect(presentExportAction(input())).toEqual({
      disabled: false,
      busy: false,
      label: {
        key: "titleBar.exportTooltip.exportSegments",
        count: 2,
        duration: "00:00:10:01",
      },
      reason: null,
    });
  });

  it("formats the millisecond total in the millisecond format", () => {
    const view = presentExportAction(
      input({ segmentTotal: 10_040n, display: MILLISECONDS_TIMECODE_DISPLAY }),
    );
    expect(view.label).toEqual({
      key: "titleBar.exportTooltip.exportSegments",
      count: 2,
      duration: "00:00:10.040",
    });
  });

  it("shows the placeholder when the total is not known", () => {
    expect(presentExportAction(input({ segmentTotal: null })).label).toEqual({
      key: "titleBar.exportTooltip.exportSegments",
      count: 2,
      duration: "--:--:--:--",
    });
    expect(
      presentExportAction(
        input({ segmentTotal: null, display: MILLISECONDS_TIMECODE_DISPLAY }),
      ).label,
    ).toEqual({
      key: "titleBar.exportTooltip.exportSegments",
      count: 2,
      duration: "--:--:--.---",
    });
    expect(
      presentExportAction(
        input({
          segmentTotal: -1n,
          display: MILLISECONDS_TIMECODE_DISPLAY,
        }),
      ).label,
    ).toEqual({
      key: "titleBar.exportTooltip.exportSegments",
      count: 2,
      duration: "--:--:--.---",
    });
  });
});

describe("the duration of the export action", () => {
  it("is formatSegmentTotal of the total, which the setup summary also shows", () => {
    const cases: Partial<ExportActionInput>[] = [
      {},
      { segmentTotal: 0n },
      { segmentTotal: null },
      { segmentTotal: 10_040n, display: MILLISECONDS_TIMECODE_DISPLAY },
      { segmentTotal: null, display: MILLISECONDS_TIMECODE_DISPLAY },
      { segmentTotal: 1_000n, display: framesDisplay(fps2997) },
    ];
    for (const overrides of cases) {
      const view = input(overrides);
      const { label } = presentExportAction(view);
      expect(label.key).toBe("titleBar.exportTooltip.exportSegments");
      if (label.key === "titleBar.exportTooltip.exportSegments") {
        expect(formatSegmentTotal(view.segmentTotal, view.display)).toBe(
          label.duration,
        );
      }
    }
  });
});

describe("the export action keys", () => {
  const messageKeys = [
    "titleBar.action.export",
    "titleBar.exportTooltip.openVideoFirst",
    "titleBar.exportTooltip.markSegmentFirst",
    "titleBar.exportTooltip.showRunningExport",
  ];

  it("name a message in both catalogs", () => {
    for (const key of messageKeys) {
      expect(typeof lookup(en, key)).toBe("string");
      expect(typeof lookup(zhCN, key)).toBe("string");
    }
  });

  it("give the segment summary the plural forms of each language", () => {
    const base = "titleBar.exportTooltip.exportSegments";
    expect(typeof lookup(en, `${base}_one`)).toBe("string");
    expect(typeof lookup(en, `${base}_other`)).toBe("string");
    // Chinese uses the `other` category alone.
    expect(lookup(zhCN, `${base}_one`)).toBeUndefined();
    expect(typeof lookup(zhCN, `${base}_other`)).toBe("string");
    for (const catalog of [en, zhCN]) {
      const other = lookup(catalog, `${base}_other`);
      expect(other).toContain("{{count}}");
      expect(other).toContain("{{duration}}");
    }
  });

  it("drop the project items of the File menu", () => {
    for (const catalog of [en, zhCN]) {
      expect(Object.keys(catalog.titleBar.menu)).toEqual([
        "file",
        "openMedia",
        "export",
      ]);
    }
  });
});
