import { describe, expect, it } from "vitest";
import { presentExportAction } from "@/components/layout/exportActionPresenter";
import { totalActiveSourceSegments } from "@/features/timeline";
import { createI18nInstance } from "@/i18n";
import {
  MILLISECONDS_TIMECODE_DISPLAY,
  timecodePlaceholder,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import { presentSegmentSummary } from "./segmentSummaryModel";

const pts = (value: string) => value as Pts;

const tb90k: Rational = { n: 1, d: 90000 };
const frames25: TimecodeDisplay = {
  format: "frames",
  rate: { n: 25, d: 1 },
  videoTimeBase: tb90k,
};
const source = { videoTimeBase: tb90k, videoStartPts: pts("0") };

const segment = (id: string, inPts: string, outPts: string, sourceId = "source-1") =>
  ({ id, sourceId, inPts: pts(inPts), outPts: pts(outPts) }) satisfies Segment;

// 2 s and 0.52 s at 25 fps, and one segment of another source that the export leaves out.
const segments = [
  segment("a", "0", "180000"),
  segment("x", "0", "900000", "source-2"),
  segment("b", "900000", "946800"),
];

describe("presentSegmentSummary", () => {
  it("shows nothing while the active source has no segment", () => {
    expect(
      presentSegmentSummary({ segmentCount: 0, segmentTotal: 0n, display: frames25 }),
    ).toBeNull();
    expect(
      presentSegmentSummary({
        segmentCount: -1,
        segmentTotal: null,
        display: frames25,
      }),
    ).toBeNull();
    expect(
      presentSegmentSummary({ segmentCount: 1.5, segmentTotal: 5n, display: frames25 }),
    ).toBeNull();
  });

  it.each([
    { display: frames25, duration: "00:00:02:13" },
    { display: MILLISECONDS_TIMECODE_DISPLAY, duration: "00:00:02.520" },
  ])(
    "shows the count and the total of the Export button in $display.format",
    ({ display, duration }) => {
      const segmentTotal = totalActiveSourceSegments(
        segments,
        "source-1",
        source,
        display,
      );
      const summary = presentSegmentSummary({ segmentCount: 2, segmentTotal, display });
      expect(summary).toStrictEqual({
        count: 2,
        duration,
        countKey: "timeline.segmentSummary.count",
        labelKey: "timeline.segmentSummary.label",
      });
      // The Export tooltip of the title bar shows the same two values.
      expect(
        presentExportAction({
          hasMedia: true,
          exportStatus: "idle",
          exportTracking: false,
          segmentCount: 2,
          segmentTotal,
          display,
        }).label,
      ).toStrictEqual({
        key: "titleBar.exportTooltip.exportSegments",
        count: 2,
        duration,
      });
    },
  );

  it("shows the placeholder of the display for a total that is not known", () => {
    expect(
      presentSegmentSummary({ segmentCount: 3, segmentTotal: null, display: frames25 })
        ?.duration,
    ).toBe(timecodePlaceholder(frames25));
  });
});

describe("the segment summary catalog entries", () => {
  it.each([
    {
      language: "en" as const,
      one: { count: "1 segment", label: "1 segment, 00:00:00:12 in total" },
      other: { count: "12 segments", label: "12 segments, 00:01:23:04 in total" },
    },
    {
      language: "zh-CN" as const,
      one: { count: "1 个片段", label: "1 个片段，总时长 00:00:00:12" },
      other: { count: "12 个片段", label: "12 个片段，总时长 00:01:23:04" },
    },
  ])(
    "writes the count and the label in $language",
    async ({ language, one, other }) => {
      const instance = await createI18nInstance({
        initialPreference: language,
        storage: null,
        systemLanguages: [],
      });
      const translate = instance.t as unknown as (
        key: string,
        options?: Record<string, string | number>,
      ) => string;
      const oneValues = { count: 1, duration: "00:00:00:12" };
      const otherValues = { count: 12, duration: "00:01:23:04" };
      expect(translate("timeline.segmentSummary.count", oneValues)).toBe(one.count);
      expect(translate("timeline.segmentSummary.label", oneValues)).toBe(one.label);
      expect(translate("timeline.segmentSummary.count", otherValues)).toBe(other.count);
      expect(translate("timeline.segmentSummary.label", otherValues)).toBe(other.label);
    },
  );
});
