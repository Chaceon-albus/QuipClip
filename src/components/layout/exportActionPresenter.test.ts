import { describe, expect, it } from "vitest";
import { EXPORT_STATUSES, type ExportStatus } from "@/features/export";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  MILLISECONDS_TIMECODE_DISPLAY,
  frameIndexOfTicks,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import { canExportMedia } from "./actionConditions";
import {
  presentExportAction,
  totalActiveSourceSegments,
  type ExportActionInput,
  type SegmentTotalSource,
} from "./exportActionPresenter";

const ms: Rational = { n: 1, d: 1000 };
const fps25: Rational = { n: 25, d: 1 };
const fps2997: Rational = { n: 30000, d: 1001 };
const fps5994: Rational = { n: 60000, d: 1001 };

const framesDisplay = (rate: Rational, videoTimeBase: Rational | null = ms) =>
  ({ format: "frames", rate, videoTimeBase }) as const satisfies TimecodeDisplay;

const ACTIVE_STATUSES: readonly ExportStatus[] = ["preparing", "running", "publishing"];
const IDLE_STATUSES: readonly ExportStatus[] = EXPORT_STATUSES.filter(
  (status) => !ACTIVE_STATUSES.includes(status),
);

function segment(
  id: string,
  sourceId: string,
  inPts: string | bigint,
  outPts: string | bigint,
): Segment {
  return { id, sourceId, inPts: String(inPts) as Pts, outPts: String(outPts) as Pts };
}

function source(videoStartPts: string | null = "0"): SegmentTotalSource {
  return { videoTimeBase: ms, videoStartPts: videoStartPts as Pts | null };
}

/**
 * The PTS that a container with a 1/1000 time base stores for nominal frame `frame` at
 * `rate`: the frame start rounded to the millisecond, with a half rounded up.
 */
function storedMs(frame: number, rate: Rational): bigint {
  const num = BigInt(frame) * BigInt(rate.d) * 1000n;
  const den = BigInt(rate.n);
  return (2n * num + den) / (2n * den);
}

function input(overrides: Partial<ExportActionInput> = {}): ExportActionInput {
  return {
    hasMedia: true,
    exportStatus: "idle",
    segmentCount: 2,
    // 251 frames at 25 fps.
    segmentTotal: 251n,
    videoTimeBase: ms,
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

  it("formats the tick total in the millisecond format", () => {
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
          segmentTotal: 10_040n,
          videoTimeBase: null,
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

describe("totalActiveSourceSegments", () => {
  describe("in the frame format", () => {
    it("adds the frame count of each segment, not the tick lengths", () => {
      // Nine segments from frame 30 + 120k to frame 49 + 120k at 59.94 fps, with each frame
      // start stored rounded to the millisecond. Each segment is 19 frames, and the export
      // writes 171. Each stored length is 316 ms, so the sum of the lengths, 2844 ms, is
      // only 170.47 frames.
      const segments = Array.from({ length: 9 }, (_, k) =>
        segment(
          `s${k}`,
          "src",
          storedMs(30 + 120 * k, fps5994),
          storedMs(49 + 120 * k, fps5994),
        ),
      );
      expect(segments[0]).toMatchObject({ inPts: "501", outPts: "817" });
      const display = framesDisplay(fps5994);
      const total = totalActiveSourceSegments(segments, "src", source(), display);
      expect(total).toBe(171n);

      // One tick sum rounded once would be one frame short.
      const ticks = segments.reduce(
        (sum, s) => sum + BigInt(s.outPts) - BigInt(s.inPts),
        0n,
      );
      expect(ticks).toBe(2844n);
      expect((2n * ticks * 60_000n + 1_001_000n) / (2n * 1_001_000n)).toBe(170n);

      expect(
        presentExportAction(input({ segmentCount: 9, segmentTotal: total, display }))
          .label,
      ).toEqual({
        key: "titleBar.exportTooltip.exportSegments",
        count: 9,
        // Frame 171 at 59.94 fps is frame 51 of second 2.
        duration: "00:00:02:51",
      });
    });

    it("counts J(out) - J(in) with the frame index of the playhead timecode", () => {
      const display = framesDisplay(fps2997);
      const start = 1000n;
      const segments: Segment[] = [];
      let expected = 0n;
      for (let a = 0; a < 60; a += 7) {
        const b = a + 1 + (a % 5);
        const inPts = start + storedMs(a, fps2997);
        const outPts = start + storedMs(b, fps2997);
        segments.push(segment(`s${a}`, "src", inPts, outPts));
        const j = (pts: bigint) =>
          frameIndexOfTicks(pts - start, ms, fps2997, ms) ?? -1n;
        expected += j(outPts) - j(inPts);
        // Each stored frame start names its own frame, so each segment is b - a frames.
        expect(j(outPts) - j(inPts)).toBe(BigInt(b - a));
      }
      expect(
        totalActiveSourceSegments(segments, "src", source(String(start)), display),
      ).toBe(expected);
    });

    it("counts from the start PTS of the source", () => {
      const display = framesDisplay(fps25);
      // 40 ms per frame. From a start of 20 ms, [60, 100) holds frame 1 only.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "60", "100")],
          "src",
          source("20"),
          display,
        ),
      ).toBe(1n);
      // From a start of 0, the same PTS pair is frame 1 to frame 2, also one frame.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "60", "100")],
          "src",
          source("0"),
          display,
        ),
      ).toBe(1n);
      // From a start of 0, [70, 90) crosses the start of frame 2 at 80 ms. From a start of
      // 20, it is 50 to 70 ms and lies inside frame 1.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "70", "90")],
          "src",
          source("0"),
          display,
        ),
      ).toBe(1n);
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "70", "90")],
          "src",
          source("20"),
          display,
        ),
      ).toBe(0n);
    });

    it("reads the segments of the active source only", () => {
      const segments = [
        segment("a", "s1", "0", "400"),
        segment("b", "s2", "x", "y"),
        segment("c", "s1", "1000", "1200"),
      ];
      expect(
        totalActiveSourceSegments(segments, "s1", source(), framesDisplay(fps25)),
      ).toBe(15n);
      expect(
        totalActiveSourceSegments(segments, null, source(), framesDisplay(fps25)),
      ).toBe(0n);
    });

    it("returns null when the total is not known", () => {
      const display = framesDisplay(fps25);
      const valid = [segment("a", "src", "0", "400")];
      expect(totalActiveSourceSegments(valid, "src", null, display)).toBeNull();
      expect(totalActiveSourceSegments(valid, "src", source(null), display)).toBeNull();
      expect(totalActiveSourceSegments(valid, "src", source("x"), display)).toBeNull();
      // A PTS before the start names no frame.
      expect(
        totalActiveSourceSegments(valid, "src", source("100"), display),
      ).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "0", "400"), segment("b", "src", "500", "500")],
          "src",
          source(),
          display,
        ),
      ).toBeNull();
    });
  });

  describe("in the millisecond format", () => {
    const display = MILLISECONDS_TIMECODE_DISPLAY;

    it("adds the ticks of the segments of the active source only", () => {
      const segments = [
        segment("a", "s1", "100", "400"),
        segment("b", "s2", "0", "999999"),
        segment("c", "s1", "1000", "1250"),
      ];
      expect(totalActiveSourceSegments(segments, "s1", source(), display)).toBe(550n);
      expect(totalActiveSourceSegments(segments, "s2", source(), display)).toBe(
        999_999n,
      );
    });

    it("needs no start PTS", () => {
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "100", "400")],
          "s",
          source(null),
          display,
        ),
      ).toBe(300n);
    });

    it("returns zero with no segment of the active source, or no active source", () => {
      const segments = [segment("a", "s1", "0", "10")];
      expect(totalActiveSourceSegments([], "s1", source(), display)).toBe(0n);
      expect(totalActiveSourceSegments(segments, "s2", source(), display)).toBe(0n);
      expect(totalActiveSourceSegments(segments, null, source(), display)).toBe(0n);
    });

    it("keeps the sum exact beyond the safe integer range", () => {
      const big = "9007199254740993";
      const segments = [segment("a", "s", "0", big), segment("b", "s", "0", big)];
      expect(totalActiveSourceSegments(segments, "s", source(), display)).toBe(
        18_014_398_509_481_986n,
      );
    });

    it("returns null when the total is not known", () => {
      expect(
        totalActiveSourceSegments([segment("a", "s", "0", "10")], "s", null, display),
      ).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "0", "10"), segment("b", "s", "20", "20")],
          "s",
          source(),
          display,
        ),
      ).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "x", "10")],
          "s",
          source(),
          display,
        ),
      ).toBeNull();
      // A malformed segment of another source does not count.
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "0", "10"), segment("b", "t", "x", "10")],
          "s",
          source(),
          display,
        ),
      ).toBe(10n);
    });
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
