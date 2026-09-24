import { describe, expect, it } from "vitest";
import {
  countRulerEdgeAnchors,
  formatRulerLabel,
  millisecondFractionForStep,
  resolveRulerLabelAnchor,
  resolveRulerLabelScheme,
  RULER_HOURS_THRESHOLD_SECONDS,
  RULER_LABEL_CHAR_WIDTH_PX,
  rulerLabelLength,
  rulerLabelWidthPx,
  type RulerLabelScheme,
} from "./rulerLabel";

const minutes: RulerLabelScheme = {
  showHours: false,
  hourDigits: 0,
  fraction: { kind: "none" },
};
const hours: RulerLabelScheme = {
  showHours: true,
  hourDigits: 1,
  fraction: { kind: "none" },
};

function withFraction(
  base: RulerLabelScheme,
  fraction: RulerLabelScheme["fraction"],
): RulerLabelScheme {
  return { ...base, fraction };
}

describe("formatRulerLabel", () => {
  it("writes MM:SS for whole seconds of a source shorter than one hour", () => {
    expect(formatRulerLabel({ seconds: 0, fraction: 0 }, minutes)).toBe("00:00");
    expect(formatRulerLabel({ seconds: 5, fraction: 0 }, minutes)).toBe("00:05");
    expect(formatRulerLabel({ seconds: 59, fraction: 0 }, minutes)).toBe("00:59");
    expect(formatRulerLabel({ seconds: 60, fraction: 0 }, minutes)).toBe("01:00");
    expect(formatRulerLabel({ seconds: 3599, fraction: 0 }, minutes)).toBe("59:59");
  });

  it("writes H:MM:SS with unpadded hours for a source of one hour or longer", () => {
    expect(formatRulerLabel({ seconds: 0, fraction: 0 }, hours)).toBe("0:00:00");
    expect(formatRulerLabel({ seconds: 312, fraction: 0 }, hours)).toBe("0:05:12");
    expect(formatRulerLabel({ seconds: 3599, fraction: 0 }, hours)).toBe("0:59:59");
    expect(formatRulerLabel({ seconds: 3600, fraction: 0 }, hours)).toBe("1:00:00");
    expect(formatRulerLabel({ seconds: 3661, fraction: 0 }, hours)).toBe("1:01:01");
    expect(formatRulerLabel({ seconds: 36_000, fraction: 0 }, hours)).toBe("10:00:00");
  });

  it("ignores the fraction when the scheme has none", () => {
    expect(formatRulerLabel({ seconds: 5, fraction: 500 }, minutes)).toBe("00:05");
  });

  it("cuts the milliseconds to the digits of the step", () => {
    const tenths = withFraction(minutes, { kind: "milliseconds", digits: 1 });
    const hundredths = withFraction(minutes, { kind: "milliseconds", digits: 2 });
    const thousandths = withFraction(minutes, { kind: "milliseconds", digits: 3 });

    expect(formatRulerLabel({ seconds: 0, fraction: 0 }, tenths)).toBe("00:00.0");
    expect(formatRulerLabel({ seconds: 1, fraction: 500 }, tenths)).toBe("00:01.5");
    expect(formatRulerLabel({ seconds: 59, fraction: 900 }, tenths)).toBe("00:59.9");
    expect(formatRulerLabel({ seconds: 0, fraction: 50 }, hundredths)).toBe("00:00.05");
    expect(formatRulerLabel({ seconds: 0, fraction: 120 }, hundredths)).toBe(
      "00:00.12",
    );
    expect(formatRulerLabel({ seconds: 0, fraction: 5 }, thousandths)).toBe(
      "00:00.005",
    );
    expect(formatRulerLabel({ seconds: 0, fraction: 999 }, thousandths)).toBe(
      "00:00.999",
    );
  });

  it("writes the millisecond fraction after the hours", () => {
    const tenths = withFraction(hours, { kind: "milliseconds", digits: 1 });
    expect(formatRulerLabel({ seconds: 3600, fraction: 500 }, tenths)).toBe(
      "1:00:00.5",
    );
  });

  it("writes :FF with the frame digits of the rate", () => {
    const twoDigits = withFraction(minutes, { kind: "frames", digits: 2 });
    const threeDigits = withFraction(minutes, { kind: "frames", digits: 3 });

    expect(formatRulerLabel({ seconds: 0, fraction: 0 }, twoDigits)).toBe("00:00:00");
    expect(formatRulerLabel({ seconds: 312, fraction: 15 }, twoDigits)).toBe(
      "05:12:15",
    );
    expect(formatRulerLabel({ seconds: 1, fraction: 5 }, threeDigits)).toBe(
      "00:01:005",
    );
    expect(
      formatRulerLabel(
        { seconds: 3600, fraction: 12 },
        withFraction(hours, { kind: "frames", digits: 2 }),
      ),
    ).toBe("1:00:00:12");
  });

  it("returns the invalid label for a time that is not a whole non-negative second", () => {
    for (const seconds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(formatRulerLabel({ seconds, fraction: 0 }, minutes)).toBe("--:--");
    }
  });

  it("returns the invalid label for a fraction out of range", () => {
    const tenths = withFraction(minutes, { kind: "milliseconds", digits: 1 });
    const frames = withFraction(minutes, { kind: "frames", digits: 2 });
    expect(formatRulerLabel({ seconds: 0, fraction: 1000 }, tenths)).toBe("--:--");
    expect(formatRulerLabel({ seconds: 0, fraction: -1 }, tenths)).toBe("--:--");
    expect(formatRulerLabel({ seconds: 0, fraction: 0.5 }, frames)).toBe("--:--");
  });
});

describe("resolveRulerLabelScheme", () => {
  it("shows the hours from exactly one hour", () => {
    const none = { kind: "none" } as const;
    expect(resolveRulerLabelScheme(3599.999, none).showHours).toBe(false);
    expect(resolveRulerLabelScheme(RULER_HOURS_THRESHOLD_SECONDS, none)).toEqual({
      showHours: true,
      hourDigits: 1,
      fraction: none,
    });
  });

  it("counts the hour digits of the longest label", () => {
    const none = { kind: "none" } as const;
    expect(resolveRulerLabelScheme(35_999, none).hourDigits).toBe(1);
    expect(resolveRulerLabelScheme(36_000, none).hourDigits).toBe(2);
    expect(resolveRulerLabelScheme(10, none).hourDigits).toBe(0);
  });

  it("shows no hours for a duration that is not finite", () => {
    const none = { kind: "none" } as const;
    expect(resolveRulerLabelScheme(NaN, none).showHours).toBe(false);
    expect(resolveRulerLabelScheme(Infinity, none).showHours).toBe(false);
  });
});

describe("millisecondFractionForStep", () => {
  it("has no fraction for whole seconds", () => {
    expect(millisecondFractionForStep(1000)).toEqual({ kind: "none" });
    expect(millisecondFractionForStep(60_000)).toEqual({ kind: "none" });
  });

  it("keeps the digits down to the last digit that the step changes", () => {
    expect(millisecondFractionForStep(500)).toEqual({
      kind: "milliseconds",
      digits: 1,
    });
    expect(millisecondFractionForStep(100)).toEqual({
      kind: "milliseconds",
      digits: 1,
    });
    expect(millisecondFractionForStep(50)).toEqual({ kind: "milliseconds", digits: 2 });
    expect(millisecondFractionForStep(10)).toEqual({ kind: "milliseconds", digits: 2 });
    expect(millisecondFractionForStep(5)).toEqual({ kind: "milliseconds", digits: 3 });
    expect(millisecondFractionForStep(1)).toEqual({ kind: "milliseconds", digits: 3 });
    expect(millisecondFractionForStep(1500)).toEqual({
      kind: "milliseconds",
      digits: 1,
    });
  });

  it("has no fraction for a step that is not a whole number of milliseconds", () => {
    expect(millisecondFractionForStep(0.5)).toEqual({ kind: "none" });
    expect(millisecondFractionForStep(NaN)).toEqual({ kind: "none" });
  });
});

describe("rulerLabelLength", () => {
  it("equals the length of the longest label of each scheme", () => {
    const cases: [RulerLabelScheme, number, number][] = [
      [minutes, 3599, 0],
      [hours, 35_999, 0],
      [{ ...hours, hourDigits: 2 }, 36_000, 0],
      [withFraction(minutes, { kind: "milliseconds", digits: 1 }), 3599, 900],
      [withFraction(minutes, { kind: "milliseconds", digits: 2 }), 3599, 990],
      [withFraction(minutes, { kind: "milliseconds", digits: 3 }), 3599, 999],
      [withFraction(minutes, { kind: "frames", digits: 2 }), 3599, 29],
      [withFraction(minutes, { kind: "frames", digits: 3 }), 3599, 119],
      [withFraction(hours, { kind: "frames", digits: 2 }), 3600, 29],
    ];
    for (const [scheme, seconds, fraction] of cases) {
      expect(rulerLabelLength(scheme)).toBe(
        formatRulerLabel({ seconds, fraction }, scheme).length,
      );
    }
  });

  it("gives the lengths of the label table", () => {
    expect(rulerLabelLength(minutes)).toBe(5);
    expect(rulerLabelLength(hours)).toBe(7);
    expect(
      rulerLabelLength(withFraction(minutes, { kind: "milliseconds", digits: 1 })),
    ).toBe(7);
    expect(rulerLabelLength(withFraction(minutes, { kind: "frames", digits: 2 }))).toBe(
      8,
    );
    expect(rulerLabelLength(withFraction(hours, { kind: "frames", digits: 2 }))).toBe(
      10,
    );
  });
});

describe("rulerLabelWidthPx", () => {
  it("gives 6 px for each Geist Mono character at 10 px", () => {
    expect(RULER_LABEL_CHAR_WIDTH_PX).toBe(6);
    expect(rulerLabelWidthPx(5)).toBe(30);
    expect(rulerLabelWidthPx(8)).toBe(48);
    expect(rulerLabelWidthPx(-1)).toBe(0);
  });
});

describe("resolveRulerLabelAnchor", () => {
  const lane = 804;
  const width = 30;

  it("anchors a label at its start when a centred box would cross the lane start", () => {
    expect(resolveRulerLabelAnchor(0, width, lane)).toBe("start");
    expect(resolveRulerLabelAnchor(14.99, width, lane)).toBe("start");
  });

  it("centres a label whose centred box touches the lane start", () => {
    expect(resolveRulerLabelAnchor(15, width, lane)).toBe("center");
    expect(resolveRulerLabelAnchor(400, width, lane)).toBe("center");
  });

  it("anchors a label at its end when a centred box would cross the lane end", () => {
    expect(resolveRulerLabelAnchor(lane, width, lane)).toBe("end");
    expect(resolveRulerLabelAnchor(lane - 14.99, width, lane)).toBe("end");
  });

  it("centres a label whose centred box touches the lane end", () => {
    expect(resolveRulerLabelAnchor(lane - 15, width, lane)).toBe("center");
  });

  it("anchors at the start when the lane is narrower than the label", () => {
    expect(resolveRulerLabelAnchor(10, 40, 30)).toBe("start");
  });

  it("centres a label for input that is not usable", () => {
    expect(resolveRulerLabelAnchor(NaN, width, lane)).toBe("center");
    expect(resolveRulerLabelAnchor(0, 0, lane)).toBe("center");
    expect(resolveRulerLabelAnchor(0, width, 0)).toBe("center");
    expect(resolveRulerLabelAnchor(0, width, Infinity)).toBe("center");
  });
});

describe("countRulerEdgeAnchors", () => {
  const tick = (percent: number, label = "00:00") => ({ percent, label });

  it("anchors the first tick at the start and a tick at 100% at the end", () => {
    const ticks = [0, 20, 40, 60, 80, 100].map((percent) => tick(percent));
    expect(countRulerEdgeAnchors(ticks, 804)).toEqual({ start: 1, end: 1 });
  });

  it("anchors a last tick close to the lane end", () => {
    // 99% of 804 px is 8.04 px before the end, less than half of a 30 px label.
    expect(countRulerEdgeAnchors([tick(0), tick(50), tick(99)], 804)).toEqual({
      start: 1,
      end: 1,
    });
  });

  it("centres a last tick with room for half a label", () => {
    expect(countRulerEdgeAnchors([tick(0), tick(50), tick(90)], 804)).toEqual({
      start: 1,
      end: 0,
    });
  });

  it("measures each label by its own length", () => {
    // 1.9% of 804 px is 15.3 px: room for half of a 30 px label, not of a 42 px label.
    expect(countRulerEdgeAnchors([tick(0), tick(1.9)], 804)).toEqual({
      start: 1,
      end: 0,
    });
    expect(countRulerEdgeAnchors([tick(0), tick(1.9, "0:00:00")], 804)).toEqual({
      start: 2,
      end: 0,
    });
  });

  it("counts a tick at most once", () => {
    expect(countRulerEdgeAnchors([tick(0)], 804)).toEqual({ start: 1, end: 0 });
    // In a 20 px lane, both ticks cross the start, and the start anchor wins.
    expect(countRulerEdgeAnchors([tick(0), tick(50)], 20)).toEqual({
      start: 2,
      end: 0,
    });
  });

  it("returns zero counts for no ticks", () => {
    expect(countRulerEdgeAnchors([], 804)).toEqual({ start: 0, end: 0 });
  });
});
