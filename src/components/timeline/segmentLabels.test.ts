import { describe, expect, it } from "vitest";
import { presentExportAction } from "@/components/layout/exportActionPresenter";
import { buildExportRequest } from "@/features/export";
import { createPresetDraft } from "@/features/settings/presetDocument";
import { exportSegmentIds, totalActiveSourceSegments } from "@/features/timeline";
import { createI18nInstance } from "@/i18n";
import {
  MILLISECONDS_TIMECODE_DISPLAY,
  formatGridCountTimecode,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  SEGMENT_DURATION_CHAR_WIDTH_PX,
  SEGMENT_FULL_LABEL_MARGIN_PX,
  SEGMENT_NAME_GAP_PX,
  SEGMENT_BAR_NAME_CLASS,
  SEGMENT_NAMED_LABEL_MARGIN_PX,
  SEGMENT_TOOLTIP_BODY_CLASS,
  SEGMENT_TOOLTIP_TITLE_CLASS,
  SEGMENT_NUMBER_DIGIT_WIDTH_PX,
  SEGMENT_NUMBER_HASH_WIDTH_PX,
  SEGMENT_NUMBER_LABEL_MARGIN_PX,
  buildSegmentTooltipRows,
  calculateSegmentWidthPx,
  calculateVisibleSegmentAnchor,
  formatSegmentTimes,
  measureSegmentLabel,
  numberSegmentsInExportOrder,
  resolveSegmentAccessibleName,
  resolveSegmentLabelTier,
  resolveSegmentTitle,
  showsSegmentName,
  type SegmentTimes,
} from "./segmentLabels";

const pts = (value: string) => value as Pts;

/** The ids of the segments of the export of one clip (`exportSegmentIds`, ADR 066). */
const exportIdsOf = (segments: readonly Segment[], sourceId: string | null) =>
  exportSegmentIds({
    clips: [],
    sequenceSegments: [],
    sequenceSources: {},
    segments: [...segments],
    sourceId,
  });

const tb90k: Rational = { n: 1, d: 90000 };
const frames25: TimecodeDisplay = {
  format: "frames",
  rate: { n: 25, d: 1 },
  videoTimeBase: tb90k,
};
const frames2997Mkv: TimecodeDisplay = {
  format: "frames",
  rate: { n: 30000, d: 1001 },
  videoTimeBase: { n: 1, d: 1000 },
};

describe("measureSegmentLabel", () => {
  it("adds the margins of each tier to the estimated text width", () => {
    expect(SEGMENT_NUMBER_LABEL_MARGIN_PX).toBe(8);
    expect(SEGMENT_FULL_LABEL_MARGIN_PX).toBe(16);
    // "#2" is 6.5 + 7 px, and "05:12" is 5 * 6 px.
    expect(measureSegmentLabel(2, "05:12")).toStrictEqual({
      numberTierPx: 8 + 13.5,
      fullTierPx: 16 + 30,
    });
  });

  it("sizes the full tier by the wider of the two lines", () => {
    // "#10000" is 6.5 + 5 * 7 = 41.5 px, wider than "05:12".
    expect(measureSegmentLabel(10000, "05:12").fullTierPx).toBe(16 + 41.5);
    // "1:01:05:12" is 10 * 6 = 60 px.
    expect(measureSegmentLabel(3, "1:01:05:12").fullTierPx).toBe(16 + 60);
  });

  it("has no full tier without a duration", () => {
    expect(measureSegmentLabel(123, null)).toStrictEqual({
      numberTierPx: 8 + 6.5 + 3 * 7,
      fullTierPx: null,
    });
  });

  it("does not underestimate the measured text of the app fonts", () => {
    // Measured in the web view: "#" is 6.08px and a tabular digit 6.87px (Geist, 11px,
    // weight 600); one character of Geist Mono at 10px is 6px.
    expect(SEGMENT_NUMBER_HASH_WIDTH_PX).toBeGreaterThanOrEqual(6.08);
    expect(SEGMENT_NUMBER_DIGIT_WIDTH_PX).toBeGreaterThanOrEqual(6.87);
    expect(SEGMENT_DURATION_CHAR_WIDTH_PX).toBeGreaterThanOrEqual(6);
  });
});

describe("resolveSegmentLabelTier", () => {
  const widths = measureSegmentLabel(2, "05:12"); // number 21.5 px, full 46 px

  it.each([
    [0, "none"],
    [21.4, "none"],
    [21.5, "number"],
    [45.9, "number"],
    [46, "full"],
    [1000, "full"],
  ] as const)("gives a %fpx segment the %s tier", (widthPx, tier) => {
    expect(resolveSegmentLabelTier(widthPx, widths)).toBe(tier);
  });

  it("follows the length of the text, not a fixed threshold", () => {
    const long = measureSegmentLabel(2, "1:01:05:12"); // full 76 px
    expect(resolveSegmentLabelTier(60, widths)).toBe("full");
    expect(resolveSegmentLabelTier(60, long)).toBe("number");
    const wideNumber = measureSegmentLabel(10000, null); // number 49.5 px
    expect(resolveSegmentLabelTier(40, wideNumber)).toBe("none");
  });

  it("never gives the full tier without a duration", () => {
    expect(resolveSegmentLabelTier(1000, measureSegmentLabel(2, null))).toBe("number");
  });

  it("shows no text for a width that is not finite", () => {
    expect(resolveSegmentLabelTier(Number.NaN, widths)).toBe("none");
    expect(resolveSegmentLabelTier(Number.POSITIVE_INFINITY, widths)).toBe("none");
  });
});

describe("calculateSegmentWidthPx", () => {
  it("multiplies before it divides, so a boundary width is exact", () => {
    expect(calculateSegmentWidthPx(5.6, 1000)).toBe(56);
  });

  it("grows with the lane, so a zoom can raise the tier of a segment", () => {
    const widths = measureSegmentLabel(1, "05:12");
    expect(resolveSegmentLabelTier(calculateSegmentWidthPx(5, 804), widths)).toBe(
      "number",
    );
    expect(resolveSegmentLabelTier(calculateSegmentWidthPx(5, 1608), widths)).toBe(
      "full",
    );
    expect(resolveSegmentLabelTier(calculateSegmentWidthPx(5, 0), widths)).toBe("none");
  });
});

describe("formatSegmentTimes", () => {
  it("formats In, Out and the duration as frame timecodes", () => {
    // [1 s + 10 frames, 6 s + 10 frames) at 25 fps with a 1/90000 time base.
    const inTicks = 90000 + 10 * 3600;
    const outTicks = 6 * 90000 + 10 * 3600;
    expect(
      formatSegmentTimes(
        { inPts: pts(String(inTicks + 1000)), outPts: pts(String(outTicks + 1000)) },
        pts("1000"),
        tb90k,
        frames25,
      ),
    ).toStrictEqual({
      inTime: "00:00:01:10",
      outTime: "00:00:06:10",
      duration: "00:00:05:00",
      compactDuration: "05:00",
    });
  });

  it("formats In, Out and the duration as millisecond timecodes", () => {
    expect(
      formatSegmentTimes(
        { inPts: pts("90000"), outPts: pts("591080") },
        pts("0"),
        tb90k,
        MILLISECONDS_TIMECODE_DISPLAY,
      ),
    ).toStrictEqual({
      inTime: "00:00:01.000",
      outTime: "00:00:06.568",
      duration: "00:00:05.568",
      compactDuration: "5.568",
    });
  });

  it("counts the frames of a segment as Out minus In, so the three values add up", () => {
    // Frame 10 and frame 161 at 29.97 fps, as Matroska stores them.
    expect(
      formatSegmentTimes(
        { inPts: pts("334"), outPts: pts("5372") },
        pts("0"),
        { n: 1, d: 1000 },
        frames2997Mkv,
      ),
    ).toStrictEqual({
      inTime: "00:00:00:10",
      outTime: "00:00:05:11",
      duration: "00:00:05:01",
      compactDuration: "05:01",
    });
  });

  it("keeps full precision for a PTS beyond the safe integer range", () => {
    const start = 2n ** 62n;
    expect(
      formatSegmentTimes(
        {
          inPts: pts((start + 90000n).toString()),
          outPts: pts((start + 180000n).toString()),
        },
        pts(start.toString()),
        tb90k,
        frames25,
      ),
    ).toStrictEqual({
      inTime: "00:00:01:00",
      outTime: "00:00:02:00",
      duration: "00:00:01:00",
      compactDuration: "01:00",
    });
  });

  it("returns null without valid source timing or a valid half-open interval", () => {
    const segment = { inPts: pts("0"), outPts: pts("90000") };
    expect(formatSegmentTimes(segment, null, tb90k, frames25)).toBeNull();
    expect(formatSegmentTimes(segment, pts("0"), null, frames25)).toBeNull();
    expect(formatSegmentTimes(segment, pts("x"), tb90k, frames25)).toBeNull();
    expect(formatSegmentTimes(segment, pts("0"), { n: 0, d: 1 }, frames25)).toBeNull();
    expect(
      formatSegmentTimes(
        { inPts: pts("5"), outPts: pts("5") },
        pts("0"),
        tb90k,
        frames25,
      ),
    ).toBeNull();
    expect(
      formatSegmentTimes(
        { inPts: pts("9"), outPts: pts("5") },
        pts("0"),
        tb90k,
        frames25,
      ),
    ).toBeNull();
  });
});

describe("buildSegmentTooltipRows", () => {
  const times: SegmentTimes = {
    inTime: "00:00:01:10",
    outTime: "00:00:06:10",
    duration: "00:00:05:00",
    compactDuration: "05:00",
  };

  it("lists In, Out and the full duration, and marks only Out as not included", () => {
    expect(buildSegmentTooltipRows(times)).toStrictEqual([
      { labelKey: "timeline.segmentTooltip.in", value: "00:00:01:10", excluded: false },
      { labelKey: "timeline.segmentTooltip.out", value: "00:00:06:10", excluded: true },
      {
        labelKey: "timeline.segmentTooltip.duration",
        value: "00:00:05:00",
        excluded: false,
      },
    ]);
  });

  it("has no rows when the times are not known", () => {
    expect(buildSegmentTooltipRows(null)).toStrictEqual([]);
  });
});

describe("segment messages", () => {
  const values = {
    index: 2,
    inTime: "00:00:01:10",
    outTime: "00:00:06:10",
    duration: "00:00:05:00",
    order: 2,
    total: 5,
  };

  it.each([
    [
      "en",
      {
        label: "Segment 2, In 00:00:01:10, Out 00:00:06:10, duration 00:00:05:00",
        description:
          "Export order: 2 of 5. The Out point is the first frame after the segment.",
        title: "Segment 2",
        exportOrder: "Export order: 2 of 5",
        in: "In",
        out: "Out",
        notIncluded: "(not in the segment)",
        duration: "Duration",
      },
    ],
    [
      "zh-CN",
      {
        label: "片段 2，入点 00:00:01:10，出点 00:00:06:10，时长 00:00:05:00",
        description: "导出顺序：第 2 个，共 5 个。出点是片段后的第一帧。",
        title: "片段 2",
        exportOrder: "导出顺序：第 2 个，共 5 个",
        in: "入点",
        out: "出点",
        notIncluded: "（不在片段内）",
        duration: "时长",
      },
    ],
  ] as const)("renders every segment message in %s", async (language, expected) => {
    const instance = await createI18nInstance({
      initialPreference: language,
      storage: null,
      systemLanguages: [],
    });
    const translate = instance.t as unknown as (
      key: string,
      options?: Record<string, string | number>,
    ) => string;
    expect(translate("timeline.segmentLabel", values)).toBe(expected.label);
    expect(translate("timeline.segmentDescription", values)).toBe(expected.description);
    expect(translate("timeline.segment", values)).toBe(expected.title);
    expect(translate("timeline.segmentTooltip.exportOrder", values)).toBe(
      expected.exportOrder,
    );
    for (const row of buildSegmentTooltipRows({
      inTime: values.inTime,
      outTime: values.outTime,
      duration: values.duration,
      compactDuration: "05:00",
    })) {
      const name = row.labelKey.slice("timeline.segmentTooltip.".length) as
        "in" | "out" | "duration";
      expect(translate(row.labelKey)).toBe(expected[name]);
    }
    expect(translate("timeline.segmentTooltip.notIncluded")).toBe(expected.notIncluded);
  });
});

describe("the name of a segment (ADR 065)", () => {
  const widths = measureSegmentLabel(3, "05:00");
  // `#3` is 13.5px, and the duration line is 30px, so the full tier needs 46px.
  const numberPx = SEGMENT_NUMBER_HASH_WIDTH_PX + SEGMENT_NUMBER_DIGIT_WIDTH_PX;
  // The line of the number keeps the margins of the number tier in every tier, so 8 px. At this
  // width no room is left for the name.
  const fullLinePx = SEGMENT_NUMBER_LABEL_MARGIN_PX + numberPx + SEGMENT_NAME_GAP_PX;

  it("shows the name on the bar when the line of the number has room for some of it", () => {
    expect(showsSegmentName("number", fullLinePx + 0.5, widths, "Intro")).toBe(true);
    expect(showsSegmentName("full", fullLinePx + 500, widths, "Intro")).toBe(true);
    expect(showsSegmentName("number", fullLinePx, widths, "Intro")).toBe(false);
    expect(showsSegmentName("none", 1000, widths, "Intro")).toBe(false);
    expect(showsSegmentName("full", 1000, widths, undefined)).toBe(false);
    expect(showsSegmentName("full", Number.NaN, widths, "Intro")).toBe(false);
    // The margin of the line does not change with the tier.
    expect(SEGMENT_NAMED_LABEL_MARGIN_PX).toBe(SEGMENT_NUMBER_LABEL_MARGIN_PX);
  });

  it("shows a short name in a narrow room, with no fixed minimum", () => {
    // `#3` named "I" on a bar of 32 px: 32 - 8 - 13.5 - 4 = 6.5 px are left for the name.
    expect(resolveSegmentLabelTier(32, widths)).toBe("number");
    expect(showsSegmentName("number", 32, widths, "I")).toBe(true);
  });

  it("shows a name that fits beside the number when the duration does not fit", () => {
    // `#3` named "I" on a bar of 40 px: the full tier needs 46 px for `05:00`, so the bar shows
    // the number tier, and its line has 40 - 8 - 13.5 - 4 = 14.5 px for the name.
    expect(widths.fullTierPx).toBe(46);
    const tier = resolveSegmentLabelTier(40, widths);
    expect(tier).toBe("number");
    expect(showsSegmentName(tier, 40, widths, "I")).toBe(true);
  });

  it("keeps the name at every width above the first width that shows it", () => {
    for (const [number, duration] of [
      [3, "05:00"],
      [3, "00:00:05:00"],
      [12, "1:05"],
      [104, null],
    ] as const) {
      const measured = measureSegmentLabel(number, duration);
      let first: number | null = null;
      for (let width = 0; width <= 400; width += 0.5) {
        const shows = showsSegmentName(
          resolveSegmentLabelTier(width, measured),
          width,
          measured,
          "I",
        );
        if (first === null && shows) {
          first = width;
        }
        if (first !== null) {
          expect(shows, `#${number} ${String(duration)} at ${width}px`).toBe(true);
        }
      }
      expect(first).not.toBeNull();
    }
    // The case of the review: the name shows at 45, 46 and 48 px.
    for (const width of [45, 46, 48]) {
      expect(
        showsSegmentName(resolveSegmentLabelTier(width, widths), width, widths, "I"),
      ).toBe(true);
    }
  });

  it("clips a long name on the bar with no ellipsis", () => {
    const classes = SEGMENT_BAR_NAME_CLASS.split(" ");
    for (const name of [
      "min-w-0",
      "overflow-hidden",
      "whitespace-nowrap",
      "text-clip",
    ]) {
      expect(classes).toContain(name);
    }
    // `truncate` adds an ellipsis, which can stand alone after a blank character.
    expect(classes).not.toContain("truncate");
    expect(classes).not.toContain("text-ellipsis");
  });

  it("lets a long name with no break wrap inside the tooltip", () => {
    // The body can shrink below the least width of the name, and the title breaks anywhere.
    expect(SEGMENT_TOOLTIP_BODY_CLASS.split(" ")).toContain("min-w-0");
    expect(SEGMENT_TOOLTIP_TITLE_CLASS.split(" ")).toContain("wrap-anywhere");
  });

  it("puts the name after the number in the tooltip title", () => {
    expect(resolveSegmentTitle(3, undefined)).toStrictEqual({
      key: "timeline.segment",
      values: { index: 3 },
    });
    expect(resolveSegmentTitle(3, "Intro")).toStrictEqual({
      key: "timeline.segmentNamed",
      values: { index: 3, name: "Intro" },
    });
  });

  it("puts the name after the number in the accessible name", () => {
    const times = { inTime: "00:01", outTime: "00:06", duration: "00:05" };
    expect(resolveSegmentAccessibleName(3, undefined, times)).toStrictEqual({
      key: "timeline.segmentLabel",
      values: { index: 3, ...times },
    });
    expect(resolveSegmentAccessibleName(3, "Intro", times)).toStrictEqual({
      key: "timeline.segmentLabelNamed",
      values: { index: 3, ...times, name: "Intro" },
    });
    expect(resolveSegmentAccessibleName(3, "Intro", null)).toStrictEqual({
      key: "timeline.segmentNamed",
      values: { index: 3, name: "Intro" },
    });
    expect(resolveSegmentAccessibleName(3, undefined, null)).toStrictEqual({
      key: "timeline.segment",
      values: { index: 3 },
    });
  });

  it.each([
    [
      "en",
      {
        title: "Segment 3: Intro",
        label: "Segment 3: Intro, In 00:01, Out 00:06, duration 00:05",
      },
    ],
    [
      "zh-CN",
      {
        title: "片段 3：Intro",
        label: "片段 3：Intro，入点 00:01，出点 00:06，时长 00:05",
      },
    ],
  ] as const)("renders the forms with a name in %s", async (language, expected) => {
    const instance = await createI18nInstance({
      initialPreference: language,
      storage: null,
      systemLanguages: [],
    });
    const translate = instance.t as unknown as (
      key: string,
      options?: Readonly<Record<string, string | number>>,
    ) => string;
    const times = { inTime: "00:01", outTime: "00:06", duration: "00:05" };
    const title = resolveSegmentTitle(3, "Intro");
    expect(translate(title.key, title.values)).toBe(expected.title);
    const label = resolveSegmentAccessibleName(3, "Intro", times);
    expect(translate(label.key, label.values)).toBe(expected.label);
    // A name with markup characters stays text: the catalogs do not escape values.
    expect(translate(title.key, { index: 1, name: "<b>&</b>" })).toContain("<b>&</b>");
  });
});

describe("the catalog of the rename dialog (ADR 065)", () => {
  it.each([
    [
      "en",
      {
        title: "Rename Segment",
        hint: "Leave the field empty to remove the name.",
        field: "Name",
        confirm: "Rename",
        tooLong:
          "The name has 81 characters. A name can have no more than 80 characters.",
      },
    ],
    [
      "zh-CN",
      {
        title: "重命名片段",
        hint: "留空可移除片段名称。",
        field: "名称",
        confirm: "重命名",
        tooLong: "名称有 81 个字符。名称不能超过 80 个字符。",
      },
    ],
  ] as const)("names the dialog in %s", async (language, expected) => {
    const instance = await createI18nInstance({
      initialPreference: language,
      storage: null,
      systemLanguages: [],
    });
    const translate = instance.t as unknown as (
      key: string,
      options?: Readonly<Record<string, string | number>>,
    ) => string;
    expect(translate("timeline.renameSegment.title")).toBe(expected.title);
    expect(translate("timeline.renameSegment.field")).toBe(expected.field);
    expect(translate("timeline.renameSegment.confirm")).toBe(expected.confirm);
    expect(translate("timeline.renameSegment.tooLong", { length: 81, max: 80 })).toBe(
      expected.tooLong,
    );
    expect(translate("timeline.renameSegment.hint")).toBe(expected.hint);
  });
});

describe("numberSegmentsInExportOrder", () => {
  const segment = (id: string, sourceId: string): Segment => ({
    id,
    sourceId,
    inPts: pts("0"),
    outPts: pts("90000"),
  });

  it("counts only the segments of the active source, as the export does", () => {
    // Two segments on video A, then A is replaced by video B and one segment is marked.
    // The project keeps the segments of A (ADR 027).
    const segments = [segment("a1", "A"), segment("a2", "A"), segment("b1", "B")];
    const numbering = numberSegmentsInExportOrder(segments, exportIdsOf(segments, "B"));
    expect(numbering.total).toBe(1);
    expect(numbering.entries).toStrictEqual([
      { segment: segments[2], projectIndex: 2, number: 1 },
    ]);
    // The same numbers as the segments that the export joins.
    const request = buildExportRequest({
      preset: createPresetDraft("p1", "Test preset"),
      sourcePath: "/video-b.mp4",
      outputPath: "/out.mp4",
      activeSourceId: "B",
      segments,
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    expect(request?.pieces).toHaveLength(numbering.total);
  });

  it("numbers the segments of the active source in project order, across other sources", () => {
    const segments = [
      segment("a1", "A"),
      segment("b1", "B"),
      segment("a2", "A"),
      segment("b2", "B"),
    ];
    expect(
      numberSegmentsInExportOrder(segments, exportIdsOf(segments, "A")).entries.map(
        ({ segment: seg, number }) => [seg.id, number],
      ),
    ).toStrictEqual([
      ["a1", 1],
      ["a2", 2],
    ]);
    const forB = numberSegmentsInExportOrder(segments, exportIdsOf(segments, "B"));
    expect(forB.total).toBe(2);
    expect(
      forB.entries.map(({ projectIndex, number }) => [projectIndex, number]),
    ).toStrictEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it("numbers each segment by its place among the segments of the export (ADR 066)", () => {
    const segments = [segment("a", "S"), segment("b", "S"), segment("c", "S")];
    // An export of several clips can leave out a segment that the timeline holds, or hold one
    // that the timeline cannot place. The numbers and the total follow the export.
    const numbering = numberSegmentsInExportOrder(segments, ["c", "a", "offTimeline"]);
    expect(numbering.total).toBe(3);
    expect(numbering.entries).toStrictEqual([
      { segment: segments[0], projectIndex: 0, number: 2 },
      { segment: segments[2], projectIndex: 2, number: 1 },
    ]);
  });

  it("has no segments without an active source", () => {
    expect(
      numberSegmentsInExportOrder(
        [segment("a1", "A")],
        exportIdsOf([segment("a1", "A")], null),
      ),
    ).toStrictEqual({
      entries: [],
      total: 0,
    });
  });
});

describe("calculateVisibleSegmentAnchor", () => {
  // A lane 10000px wide, scrolled so that client x 0 is lane x 3000. The viewport shows
  // client x 96 (the right edge of the gutter) to 1096.
  const lane = { left: -3000, width: 10000 };
  const visible = { left: 96, right: 1096 };

  it("keeps a segment that is fully visible", () => {
    // Lane x 3200 to 3300: client x 200 to 300.
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 32, widthPercent: 1 },
        lane,
        visible,
      ),
    ).toStrictEqual({ left: "32%", width: "1%", visible: true });
  });

  it("clamps a segment that is wider than the viewport to the visible part", () => {
    // Lane x 0 to 10000: the visible part is client x 96 to 1096, lane x 3096 to 4096.
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 0, widthPercent: 100 },
        lane,
        visible,
      ),
    ).toStrictEqual({ left: "30.96%", width: "10%", visible: true });
  });

  it("clamps a segment that the gutter or the right edge cuts", () => {
    // Lane x 2900 to 3200: client x -100 to 200, cut to 96 to 200.
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 29, widthPercent: 3 },
        lane,
        visible,
      ),
    ).toStrictEqual({ left: "30.96%", width: "1.04%", visible: true });
    // Lane x 4000 to 4500: client x 1000 to 1500, cut to 1000 to 1096.
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 40, widthPercent: 5 },
        lane,
        visible,
      ),
    ).toStrictEqual({ left: "40%", width: "0.96%", visible: true });
  });

  it("marks the whole segment hidden when no part is visible, and visible without a lane width", () => {
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 80, widthPercent: 5 },
        lane,
        visible,
      ),
    ).toStrictEqual({ left: "80%", width: "5%", visible: false });
    // Lane x 2800 to 2900: client x -200 to -100, under the gutter or left of it.
    expect(
      calculateVisibleSegmentAnchor({ leftPercent: 28, widthPercent: 1 }, lane, visible)
        .visible,
    ).toBe(false);
    expect(
      calculateVisibleSegmentAnchor(
        { leftPercent: 10, widthPercent: 5 },
        { left: 0, width: 0 },
        visible,
      ),
    ).toStrictEqual({ left: "10%", width: "5%", visible: true });
  });
});

describe("segment durations and the export total", () => {
  /** The whole frames of a frame timecode or duration: `ceil(seconds * rate) + FF`. */
  function framesOf(timecode: string, rate: Rational): bigint {
    const groups = timecode.split(":").map(BigInt);
    const ff = groups.pop()!;
    const seconds = groups.reduce((total, group) => total * 60n + group, 0n);
    const n = BigInt(rate.n);
    const d = BigInt(rate.d);
    return (seconds * n + d - 1n) / d + ff;
  }

  /** The whole milliseconds of a millisecond timecode or duration. */
  function millisecondsOf(timecode: string): bigint {
    const [clock, ms] = timecode.split(".");
    const seconds = clock
      .split(":")
      .map(BigInt)
      .reduce((total, group) => total * 60n + group, 0n);
    return seconds * 1000n + BigInt(ms);
  }

  const cases: readonly [string, Rational, Rational, (frame: number) => bigint][] = [
    // 29.97 fps in Matroska: each frame start is stored rounded to the millisecond.
    [
      "29.97 fps, 1/1000",
      { n: 30000, d: 1001 },
      { n: 1, d: 1000 },
      (frame) => (2n * BigInt(frame) * 1001n + 30n) / 60n,
    ],
    // 30 fps with a 1/600 time base: each frame is 20 ticks, 33.33 ms.
    [
      "30 fps, 1/600",
      { n: 30, d: 1 },
      { n: 1, d: 600 },
      (frame) => BigInt(frame) * 20n,
    ],
  ];

  it.each(cases)(
    "adds up to the title-bar total in both formats (%s)",
    (_label, rate, timeBase, frameStart) => {
      const start = 5000n;
      const segments: Segment[] = [];
      for (let k = 0; k < 40; k++) {
        const a = 3 * k * k + k;
        const b = a + 1 + (k % 7);
        // Frame starts, and every fifth segment with ends that are not frame starts.
        const offIn = k % 5 === 0 ? 3n : 0n;
        const offOut = k % 5 === 0 ? 7n : 0n;
        segments.push({
          id: `s${k}`,
          sourceId: "src",
          inPts: pts((start + frameStart(a) + offIn).toString()),
          outPts: pts((start + frameStart(b) + offOut).toString()),
        });
      }
      // A segment of another source does not count in either place.
      segments.push({
        id: "other",
        sourceId: "old",
        inPts: pts("0"),
        outPts: pts("999"),
      });
      const source = { videoTimeBase: timeBase, videoStartPts: pts(start.toString()) };

      const displays: readonly TimecodeDisplay[] = [
        { format: "frames", rate, videoTimeBase: timeBase },
        MILLISECONDS_TIMECODE_DISPLAY,
      ];
      for (const display of displays) {
        const countOf = (timecode: string) =>
          display.format === "frames"
            ? framesOf(timecode, rate)
            : millisecondsOf(timecode);
        let sum = 0n;
        for (const { segment } of numberSegmentsInExportOrder(
          segments,
          exportIdsOf(segments, "src"),
        ).entries) {
          const times = formatSegmentTimes(
            segment,
            source.videoStartPts,
            timeBase,
            display,
          );
          expect(times).not.toBeNull();
          // Each tooltip adds up: the In time plus the duration is the Out time.
          expect(countOf(times!.outTime) - countOf(times!.inTime)).toBe(
            countOf(times!.duration),
          );
          sum += countOf(times!.duration);
        }
        const total = totalActiveSourceSegments(segments, "src", source, display);
        expect(total).toBe(sum);
        // The title bar writes that total with the same formatter.
        expect(
          presentExportAction({
            hasMedia: true,
            exportStatus: "idle",
            exportTracking: false,
            segmentCount: 40,
            segmentTotal: total,
            display,
          }).label,
        ).toMatchObject({ duration: formatGridCountTimecode(sum, display) });
      }
    },
  );

  it("shows one 30 fps frame with a 1/600 time base as 0.034 in both places", () => {
    const segment = { id: "a", sourceId: "src", inPts: pts("20"), outPts: pts("40") };
    const source = { videoTimeBase: { n: 1, d: 600 }, videoStartPts: pts("0") };
    const times = formatSegmentTimes(
      segment,
      source.videoStartPts,
      source.videoTimeBase,
      MILLISECONDS_TIMECODE_DISPLAY,
    );
    expect(times?.duration).toBe("00:00:00.034");
    const total = totalActiveSourceSegments(
      [segment],
      "src",
      source,
      MILLISECONDS_TIMECODE_DISPLAY,
    );
    expect(formatGridCountTimecode(total!, MILLISECONDS_TIMECODE_DISPLAY)).toBe(
      "00:00:00.034",
    );
  });
});
