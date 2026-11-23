import { describe, expect, it } from "vitest";
import {
  afterGainTone,
  filledGainTenths,
  isValidGainTenths,
  loudnessLines,
  truePeakTenths,
} from "./gain";

describe("the filled gain (ADR 061)", () => {
  it("rounds the true peak up to a tenth", () => {
    expect(truePeakTenths(0.71)).toBe(8);
    expect(truePeakTenths(0.7)).toBe(7);
    expect(truePeakTenths(-1.04)).toBe(-10);
    expect(truePeakTenths(-1.0)).toBe(-10);
    expect(truePeakTenths(-0.04)).toBe(0);
    expect(Object.is(truePeakTenths(-0.04), -0)).toBe(false);
    expect(truePeakTenths(null)).toBeNull();
  });

  it("fills the gain that brings the true peak to -1.0 dBTP, and only cuts", () => {
    // TP +0.7 dBTP: P = 7, G = -17.
    expect(filledGainTenths(0.7)).toBe(-17);
    // TP +0.71 rounds up to +0.8: G = -18, and the peak after the gain is -1.0.
    expect(filledGainTenths(0.71)).toBe(-18);
    // At or below the ceiling, no cut.
    expect(filledGainTenths(-1.0)).toBe(0);
    expect(filledGainTenths(-1.04)).toBe(0);
    expect(filledGainTenths(-0.99999)).toBe(-1);
    expect(filledGainTenths(-6)).toBe(0);
    // A peak that needs more than -20.0 dB gets -20.0.
    expect(filledGainTenths(25)).toBe(-200);
    // Silence: no true peak, no gain.
    expect(filledGainTenths(null)).toBe(0);
  });

  it("leaves the After gain line in the normal tone right after the fill", () => {
    for (const dbtp of [-30, -1.0, -0.99, -0.05, 0, 0.04, 0.7, 3.33, 18.95, 19.0]) {
      const peak = truePeakTenths(dbtp);
      expect(afterGainTone(peak, filledGainTenths(dbtp)), String(dbtp)).toBe("normal");
    }
  });

  it("shows the tone of the result when the fill needed more than -20.0 dB", () => {
    // From +19.1 dBTP the fill stops at -20.0 dB, so the true peak after it is above -1.0.
    for (const [dbtp, tone] of [
      [19.1, "warning"],
      [20.0, "warning"],
      [20.1, "destructive"],
    ] as const) {
      expect(filledGainTenths(dbtp), String(dbtp)).toBe(-200);
      expect(afterGainTone(truePeakTenths(dbtp), -200), String(dbtp)).toBe(tone);
    }
  });

  it("gives the tone of the integer P + gain", () => {
    expect(afterGainTone(7, -17)).toBe("normal");
    expect(afterGainTone(7, -16)).toBe("warning");
    expect(afterGainTone(7, -7)).toBe("warning");
    expect(afterGainTone(7, -6)).toBe("destructive");
    expect(afterGainTone(null, 50)).toBe("normal");
  });

  it("gives the values of the two lines in tenths", () => {
    expect(loudnessLines({ integratedLufs: -14.56, truePeakDbtp: 0.71 }, -18)).toEqual({
      measuredLoudnessTenths: -146,
      measuredPeakTenths: 8,
      afterLoudnessTenths: -164,
      afterPeakTenths: -10,
      tone: "normal",
    });
    expect(loudnessLines({ integratedLufs: null, truePeakDbtp: null }, 0)).toEqual({
      measuredLoudnessTenths: null,
      measuredPeakTenths: null,
      afterLoudnessTenths: null,
      afterPeakTenths: null,
      tone: "normal",
    });
    // A loudness that rounds to 0 is 0, not -0.
    expect(
      Object.is(
        loudnessLines({ integratedLufs: -0.04, truePeakDbtp: null }, 0)
          .measuredLoudnessTenths,
        -0,
      ),
    ).toBe(false);
  });

  it("adds the gain in tenths before the one rounding of the loudness", () => {
    // -0.25 LUFS with +0.2 dB is -0.05 LUFS, which rounds half away from zero to -0.1.
    expect(
      loudnessLines({ integratedLufs: -0.25, truePeakDbtp: null }, 2)
        .afterLoudnessTenths,
    ).toBe(-1);
  });

  it("accepts a gain of whole tenths in the range of a preset", () => {
    expect(isValidGainTenths(-200)).toBe(true);
    expect(isValidGainTenths(200)).toBe(true);
    expect(isValidGainTenths(0)).toBe(true);
    expect(isValidGainTenths(-201)).toBe(false);
    expect(isValidGainTenths(-12.5)).toBe(false);
    expect(isValidGainTenths(Number.NaN)).toBe(false);
  });
});
