import { describe, expect, it } from "vitest";
import {
  assertPositiveTimeBase,
  elapsedSecondsToPts,
  frameCountFromBigInt,
  frameCountToBigInt,
  formatSecondsForFfmpeg,
  gcd,
  I64_MAX,
  I64_MIN,
  isPtsString,
  isFrameCountString,
  isTickCountString,
  isValidApproximateDuration,
  isValidSegmentRange,
  isPtsInsideSegment,
  mediaTimeToPts,
  parseFrameRate,
  parseFrameCount,
  parsePts,
  parseTickCount,
  ptsDifference,
  ptsElapsedSeconds,
  ptsFromBigInt,
  ptsToBigInt,
  ptsToMediaTime,
  rationalsEqual,
  rationalToNumber,
  secondsToTicks,
  segmentDurationSeconds,
  segmentDurationTicks,
  tickCountFromBigInt,
  tickCountToBigInt,
  ticksToSeconds,
  validateApproximateDuration,
} from "@/lib/time";
import type { FrameCount, Pts, Rational, TickCount } from "@/types/project";

const NTSC: Rational = { n: 30000, d: 1001 };
const FPS25: Rational = { n: 25, d: 1 };
const TIMEBASE_90K: Rational = { n: 1, d: 90000 };

describe("time helpers and PTS arithmetic", () => {
  describe("i64 bounds and canonical PTS string validation", () => {
    it("accepts valid canonical signed i64 PTS strings across full range", () => {
      expect(isPtsString("0")).toBe(true);
      expect(isPtsString("1")).toBe(true);
      expect(isPtsString("-1")).toBe(true);
      expect(isPtsString("90000")).toBe(true);
      expect(isPtsString("-1800")).toBe(true);
      expect(isPtsString(I64_MIN.toString())).toBe(true);
      expect(isPtsString(I64_MAX.toString())).toBe(true);
      expect(isPtsString("-9223372036854775808")).toBe(true);
      expect(isPtsString("9223372036854775807")).toBe(true);
    });

    it("rejects malformed PTS strings", () => {
      expect(isPtsString("-0")).toBe(false);
      expect(isPtsString("+0")).toBe(false);
      expect(isPtsString("+100")).toBe(false);
      expect(isPtsString("01")).toBe(false);
      expect(isPtsString("-01")).toBe(false);
      expect(isPtsString("")).toBe(false);
      expect(isPtsString(" ")).toBe(false);
      expect(isPtsString(" 100")).toBe(false);
      expect(isPtsString("100 ")).toBe(false);
      expect(isPtsString("12.34")).toBe(false);
      expect(isPtsString("abc")).toBe(false);
      expect(isPtsString(null)).toBe(false);
      expect(isPtsString(undefined)).toBe(false);
      expect(isPtsString(123)).toBe(false);
      expect(isPtsString(123n)).toBe(false);
    });

    it("rejects values outside signed i64 bounds", () => {
      expect(isPtsString("9223372036854775808")).toBe(false); // I64_MAX + 1
      expect(isPtsString("-9223372036854775809")).toBe(false); // I64_MIN - 1
      expect(isPtsString("999999999999999999999999")).toBe(false);
      expect(isPtsString("-999999999999999999999999")).toBe(false);
    });

    it("parsePts returns branded string or null", () => {
      expect(parsePts("0")).toBe("0");
      expect(parsePts("-1800")).toBe("-1800");
      expect(parsePts("not-a-pts")).toBeNull();
      expect(parsePts("-0")).toBeNull();
    });

    it("ptsFromBigInt converts within bounds and throws RangeError out of bounds", () => {
      expect(ptsFromBigInt(0n)).toBe("0");
      expect(ptsFromBigInt(-1800n)).toBe("-1800");
      expect(ptsFromBigInt(I64_MIN)).toBe("-9223372036854775808");
      expect(ptsFromBigInt(I64_MAX)).toBe("9223372036854775807");

      expect(() => ptsFromBigInt(I64_MIN - 1n)).toThrow(RangeError);
      expect(() => ptsFromBigInt(I64_MAX + 1n)).toThrow(RangeError);
    });

    it("ptsToBigInt converts valid PTS string to BigInt and throws on invalid", () => {
      expect(ptsToBigInt("0" as Pts)).toBe(0n);
      expect(ptsToBigInt("-1800" as Pts)).toBe(-1800n);
      expect(ptsToBigInt("90000" as Pts)).toBe(90000n);

      expect(() => ptsToBigInt("invalid" as Pts)).toThrow(TypeError);
      expect(() => ptsToBigInt("-0" as Pts)).toThrow(TypeError);
    });
  });

  describe("canonical TickCount string validation", () => {
    it("accepts valid canonical non-negative i64 TickCount strings", () => {
      expect(isTickCountString("0")).toBe(true);
      expect(isTickCountString("1")).toBe(true);
      expect(isTickCountString("90000")).toBe(true);
      expect(isTickCountString("32370000")).toBe(true);
      expect(isTickCountString(I64_MAX.toString())).toBe(true);
      expect(isTickCountString("9223372036854775807")).toBe(true);
    });

    it("rejects negative and malformed TickCount strings", () => {
      expect(isTickCountString("-1")).toBe(false);
      expect(isTickCountString("-0")).toBe(false);
      expect(isTickCountString("+0")).toBe(false);
      expect(isTickCountString("+100")).toBe(false);
      expect(isTickCountString("01")).toBe(false);
      expect(isTickCountString("")).toBe(false);
      expect(isTickCountString(" 100")).toBe(false);
      expect(isTickCountString("100 ")).toBe(false);
      expect(isTickCountString("12.34")).toBe(false);
      expect(isTickCountString("abc")).toBe(false);
      expect(isTickCountString(null)).toBe(false);
      expect(isTickCountString(undefined)).toBe(false);
    });

    it("rejects TickCount values outside non-negative i64 bounds", () => {
      expect(isTickCountString("9223372036854775808")).toBe(false);
      expect(isTickCountString("999999999999999999999999")).toBe(false);
    });

    it("parseTickCount returns branded string or null", () => {
      expect(parseTickCount("0")).toBe("0");
      expect(parseTickCount("32370000")).toBe("32370000");
      expect(parseTickCount("-1")).toBeNull();
      expect(parseTickCount("not-a-tick")).toBeNull();
    });

    it("tickCountFromBigInt converts non-negative BigInt and throws on out of bounds", () => {
      expect(tickCountFromBigInt(0n)).toBe("0");
      expect(tickCountFromBigInt(32370000n)).toBe("32370000");
      expect(tickCountFromBigInt(I64_MAX)).toBe("9223372036854775807");

      expect(() => tickCountFromBigInt(-1n)).toThrow(RangeError);
      expect(() => tickCountFromBigInt(I64_MAX + 1n)).toThrow(RangeError);
    });

    it("tickCountToBigInt converts valid string to BigInt and throws on invalid", () => {
      expect(tickCountToBigInt("0" as TickCount)).toBe(0n);
      expect(tickCountToBigInt("32370000" as TickCount)).toBe(32370000n);

      expect(() => tickCountToBigInt("-1" as TickCount)).toThrow(TypeError);
      expect(() => tickCountToBigInt("bad" as TickCount)).toThrow(TypeError);
    });
  });

  describe("canonical FrameCount string validation", () => {
    it("returns the distinct FrameCount brand for canonical non-negative i64 strings", () => {
      expect(isFrameCountString("0")).toBe(true);
      expect(isFrameCountString(I64_MAX.toString())).toBe(true);
      expect(parseFrameCount("300")).toBe("300");
      expect(frameCountFromBigInt(300n)).toBe("300");
      expect(frameCountToBigInt("300" as FrameCount)).toBe(300n);
    });

    it("rejects malformed, negative, and out-of-range frame counts", () => {
      for (const value of ["-1", "+1", "01", " 1", "1 ", "1.0", "abc"]) {
        expect(isFrameCountString(value)).toBe(false);
      }
      expect(isFrameCountString("9223372036854775808")).toBe(false);
      expect(parseFrameCount("-1")).toBeNull();
      expect(() => frameCountFromBigInt(-1n)).toThrow(RangeError);
      expect(() => frameCountFromBigInt(I64_MAX + 1n)).toThrow(RangeError);
      expect(() => frameCountToBigInt("invalid" as FrameCount)).toThrow(TypeError);
    });
  });

  describe("approximateDurationSeconds validation", () => {
    it("accepts finite non-negative numbers", () => {
      expect(isValidApproximateDuration(0)).toBe(true);
      expect(isValidApproximateDuration(359.666667)).toBe(true);
      expect(isValidApproximateDuration(100.5)).toBe(true);
      expect(isValidApproximateDuration(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it("rejects negative, non-finite, or non-numeric values", () => {
      expect(isValidApproximateDuration(-0.001)).toBe(false);
      expect(isValidApproximateDuration(-1)).toBe(false);
      expect(isValidApproximateDuration(NaN)).toBe(false);
      expect(isValidApproximateDuration(Infinity)).toBe(false);
      expect(isValidApproximateDuration(-Infinity)).toBe(false);
      expect(isValidApproximateDuration("100")).toBe(false);
      expect(isValidApproximateDuration(null)).toBe(false);
      expect(isValidApproximateDuration(undefined)).toBe(false);
    });

    it("validateApproximateDuration normalizes invalid values to null", () => {
      expect(validateApproximateDuration(359.666667)).toBe(359.666667);
      expect(validateApproximateDuration(0)).toBe(0);
      expect(validateApproximateDuration(-1)).toBeNull();
      expect(validateApproximateDuration(NaN)).toBeNull();
      expect(validateApproximateDuration(Infinity)).toBeNull();
      expect(validateApproximateDuration(null)).toBeNull();
    });
  });

  describe("checked conversions: mediaTimeToPts and ptsToMediaTime", () => {
    it("maps mediaTime to exact PTS with start PTS and timebase", () => {
      const startPts = "0" as Pts;
      // 1.0s at 1/90000 timebase is 90,000 ticks
      expect(mediaTimeToPts(1.0, 0.0, startPts, TIMEBASE_90K)).toBe("90000");
      expect(mediaTimeToPts(0.0, 0.0, startPts, TIMEBASE_90K)).toBe("0");
      expect(mediaTimeToPts(0.5, 0.0, startPts, TIMEBASE_90K)).toBe("45000");
    });

    it("handles non-zero calibration anchor and negative start PTS", () => {
      const startPts = "-1800" as Pts;
      const calibratedMediaTime = 0.02; // anchor media time

      // At mediaTime = 0.02, PTS should be exactly startPts (-1800)
      expect(mediaTimeToPts(0.02, calibratedMediaTime, startPts, TIMEBASE_90K)).toBe(
        "-1800",
      );

      // At mediaTime = 1.02 (delta = 1.0s = 90000 ticks), PTS is -1800 + 90000 = 88200
      expect(mediaTimeToPts(1.02, calibratedMediaTime, startPts, TIMEBASE_90K)).toBe(
        "88200",
      );
    });

    it("round-trips mediaTimeToPts and ptsToMediaTime", () => {
      const startPts = "-1800" as Pts;
      const calibratedMediaTime = 0.05;
      const ptsList = ["-1800" as Pts, "0" as Pts, "90000" as Pts, "32370000" as Pts];

      for (const targetPts of ptsList) {
        const mediaTime = ptsToMediaTime(
          targetPts,
          startPts,
          calibratedMediaTime,
          TIMEBASE_90K,
        );
        expect(mediaTime).not.toBeNull();
        const inferredPts = mediaTimeToPts(
          mediaTime!,
          calibratedMediaTime,
          startPts,
          TIMEBASE_90K,
        );
        expect(inferredPts).toBe(targetPts);
      }
    });

    it("rejects non-finite, negative, or invalid parameters in mediaTimeToPts", () => {
      const startPts = "0" as Pts;
      expect(mediaTimeToPts(NaN, 0, startPts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(Infinity, 0, startPts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(-1, 0, startPts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(1.0, NaN, startPts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(1.0, -0.5, startPts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(1.0, 0, "invalid" as Pts, TIMEBASE_90K)).toBeNull();
      expect(mediaTimeToPts(1.0, 0, startPts, { n: 0, d: 1 })).toBeNull();
      expect(mediaTimeToPts(1.0, 0, startPts, { n: 1, d: 0 })).toBeNull();
    });

    it("rejects unsafe integer tick deltas in mediaTimeToPts", () => {
      const startPts = "0" as Pts;
      // Huge time delta that causes ticks to exceed Number.MAX_SAFE_INTEGER
      const hugeTime = 1e16;
      expect(mediaTimeToPts(hugeTime, 0, startPts, TIMEBASE_90K)).toBeNull();
    });

    it("rejects unsafe or invalid conversions in ptsToMediaTime", () => {
      const startPts = "0" as Pts;
      expect(ptsToMediaTime("0" as Pts, startPts, NaN, TIMEBASE_90K)).toBeNull();
      expect(ptsToMediaTime("0" as Pts, startPts, -1, TIMEBASE_90K)).toBeNull();
      expect(ptsToMediaTime("invalid" as Pts, startPts, 0, TIMEBASE_90K)).toBeNull();

      // Huge PTS difference exceeding Number.MAX_SAFE_INTEGER
      const hugePts = "9223372036854775807" as Pts;
      expect(
        ptsToMediaTime(hugePts, "-9223372036854775808" as Pts, 0, TIMEBASE_90K),
      ).toBeNull();
    });

    it("converts a small safe delta between huge absolute PTS values", () => {
      const startPts = "9223372036854775000" as Pts;
      const targetPts = "9223372036854775090" as Pts;

      expect(ptsToMediaTime(targetPts, startPts, 0.25, TIMEBASE_90K)).toBeCloseTo(
        0.251,
        12,
      );
      expect(mediaTimeToPts(0.251, 0.25, startPts, TIMEBASE_90K)).toBe(targetPts);
    });
  });

  describe("checked source elapsed conversion", () => {
    it("subtracts large absolute PTS values before converting to number", () => {
      expect(
        ptsElapsedSeconds(
          "9223372036854775090" as Pts,
          "9223372036854775000" as Pts,
          TIMEBASE_90K,
        ),
      ).toBe(0.001);
    });

    it("rejects unsafe deltas and invalid time bases", () => {
      expect(
        ptsElapsedSeconds(
          I64_MAX.toString() as Pts,
          I64_MIN.toString() as Pts,
          TIMEBASE_90K,
        ),
      ).toBeNull();
      expect(ptsElapsedSeconds("1" as Pts, "0" as Pts, { n: 0, d: 1 })).toBeNull();
    });

    it("converts checked elapsed seconds back to source PTS", () => {
      expect(
        elapsedSecondsToPts(0.001, "9223372036854775000" as Pts, TIMEBASE_90K),
      ).toBe("9223372036854775090");
      expect(elapsedSecondsToPts(Number.NaN, "0" as Pts, TIMEBASE_90K)).toBeNull();
      expect(elapsedSecondsToPts(-1, "0" as Pts, TIMEBASE_90K)).toBeNull();
      expect(elapsedSecondsToPts(1e16, "0" as Pts, TIMEBASE_90K)).toBeNull();
    });
  });

  describe("checked conversions: ticksToSeconds and secondsToTicks", () => {
    it("converts ticks to seconds and seconds to ticks accurately", () => {
      const ticks = "90000" as TickCount;
      expect(ticksToSeconds(ticks, TIMEBASE_90K)).toBe(1.0);
      expect(secondsToTicks(1.0, TIMEBASE_90K)).toBe("90000");

      const ticks0 = "0" as TickCount;
      expect(ticksToSeconds(ticks0, TIMEBASE_90K)).toBe(0);
      expect(secondsToTicks(0, TIMEBASE_90K)).toBe("0");
    });

    it("rejects unsafe BigInt-to-number tick values in ticksToSeconds", () => {
      // Tick value exceeding Number.MAX_SAFE_INTEGER
      const hugeTicks = "9007199254740992" as TickCount;
      expect(ticksToSeconds(hugeTicks, TIMEBASE_90K)).toBeNull();
    });

    it("rejects non-finite and negative seconds in secondsToTicks", () => {
      expect(secondsToTicks(-1, TIMEBASE_90K)).toBeNull();
      expect(secondsToTicks(NaN, TIMEBASE_90K)).toBeNull();
      expect(secondsToTicks(Infinity, TIMEBASE_90K)).toBeNull();
      expect(secondsToTicks(-Infinity, TIMEBASE_90K)).toBeNull();
    });
  });

  describe("segment PTS helpers", () => {
    it("isValidSegmentRange checks inPts < outPts with BigInt", () => {
      expect(isValidSegmentRange("0" as Pts, "100" as Pts)).toBe(true);
      expect(isValidSegmentRange("-1800" as Pts, "0" as Pts)).toBe(true);
      expect(isValidSegmentRange("-1800" as Pts, "-1000" as Pts)).toBe(true);
      expect(isValidSegmentRange("100" as Pts, "100" as Pts)).toBe(false);
      expect(isValidSegmentRange("200" as Pts, "100" as Pts)).toBe(false);
      expect(isValidSegmentRange("0" as Pts, "-100" as Pts)).toBe(false);
      expect(isValidSegmentRange("bad" as Pts, "100" as Pts)).toBe(false);
    });

    it("isPtsInsideSegment checks inPts < pts < outPts", () => {
      const inPts = "1000" as Pts;
      const outPts = "2000" as Pts;
      expect(isPtsInsideSegment("1500" as Pts, inPts, outPts)).toBe(true);
      expect(isPtsInsideSegment("1000" as Pts, inPts, outPts)).toBe(false); // boundary excluded
      expect(isPtsInsideSegment("2000" as Pts, inPts, outPts)).toBe(false); // boundary excluded
      expect(isPtsInsideSegment("500" as Pts, inPts, outPts)).toBe(false);
      expect(isPtsInsideSegment("2500" as Pts, inPts, outPts)).toBe(false);
    });

    it("segmentDurationTicks and segmentDurationSeconds compute exact duration", () => {
      const inPts = "9000" as Pts;
      const outPts = "27000" as Pts;
      expect(segmentDurationTicks(inPts, outPts)).toBe(18000n);
      expect(segmentDurationSeconds(inPts, outPts, TIMEBASE_90K)).toBe(0.2);

      // Inverted or equal returns null
      expect(segmentDurationTicks(outPts, inPts)).toBeNull();
      expect(segmentDurationTicks(inPts, inPts)).toBeNull();
      expect(segmentDurationSeconds(outPts, inPts, TIMEBASE_90K)).toBeNull();
    });

    it("ptsDifference calculates exact signed BigInt difference", () => {
      expect(ptsDifference("27000" as Pts, "9000" as Pts)).toBe(18000n);
      expect(ptsDifference("9000" as Pts, "27000" as Pts)).toBe(-18000n);
      expect(ptsDifference("0" as Pts, "-1800" as Pts)).toBe(1800n);
    });

    it("preserves a duration larger than TickCount across the full signed PTS range", () => {
      expect(
        segmentDurationTicks(I64_MIN.toString() as Pts, I64_MAX.toString() as Pts),
      ).toBe(I64_MAX - I64_MIN);
    });
  });

  describe("assertPositiveTimeBase validation", () => {
    it("accepts valid positive rationals with safe integer components", () => {
      expect(() => assertPositiveTimeBase({ n: 1, d: 90000 })).not.toThrow();
      expect(() => assertPositiveTimeBase({ n: 30000, d: 1001 })).not.toThrow();
      expect(() => assertPositiveTimeBase({ n: 25, d: 1 })).not.toThrow();
    });

    it("throws RangeError on non-positive or unsafe rationals", () => {
      expect(() => assertPositiveTimeBase({ n: 0, d: 1 })).toThrow(RangeError);
      expect(() => assertPositiveTimeBase({ n: -1, d: 1 })).toThrow(RangeError);
      expect(() => assertPositiveTimeBase({ n: 1, d: 0 })).toThrow(RangeError);
      expect(() => assertPositiveTimeBase({ n: 1, d: -1 })).toThrow(RangeError);
      expect(() => assertPositiveTimeBase({ n: 1.5, d: 1 })).toThrow(RangeError);
      expect(() => assertPositiveTimeBase({ n: 1, d: 1.5 })).toThrow(RangeError);
      expect(() =>
        assertPositiveTimeBase({ n: Number.MAX_SAFE_INTEGER + 1, d: 1 }),
      ).toThrow(RangeError);
    });
  });

  describe("Rational math helpers", () => {
    it("gcd calculates greatest common divisor", () => {
      expect(gcd(30000, 1001)).toBe(1);
      expect(gcd(50, 2)).toBe(2);
      expect(gcd(12, 18)).toBe(6);
    });

    it("rationalToNumber converts to float", () => {
      expect(rationalToNumber(FPS25)).toBe(25);
      expect(rationalToNumber(NTSC)).toBeCloseTo(29.97002997, 6);
    });

    it("parseFrameRate parses valid frame rates and reduces fractions", () => {
      expect(parseFrameRate("30000/1001")).toEqual({ n: 30000, d: 1001 });
      expect(parseFrameRate("25")).toEqual({ n: 25, d: 1 });
      expect(parseFrameRate("50/2")).toEqual({ n: 25, d: 1 });
      expect(parseFrameRate("0/0")).toBeNull();
      expect(parseFrameRate("25/0")).toBeNull();
      expect(parseFrameRate("-25/1")).toBeNull();
      expect(parseFrameRate("abc")).toBeNull();
    });

    it("rationalsEqual tests exact equality across cross-products", () => {
      expect(rationalsEqual({ n: 50, d: 2 }, { n: 25, d: 1 })).toBe(true);
      expect(rationalsEqual({ n: 30000, d: 1001 }, { n: 60000, d: 2002 })).toBe(true);
      expect(rationalsEqual(NTSC, FPS25)).toBe(false);
      expect(rationalsEqual({ n: 1, d: 0 }, { n: 1, d: 0 })).toBe(false);
    });
  });

  describe("legacy FFmpeg frame formatting", () => {
    it("formats seconds for ffmpeg from frames", () => {
      expect(formatSecondsForFfmpeg(0, FPS25)).toBe("0.000000000");
      expect(formatSecondsForFfmpeg(25, FPS25)).toBe("1.000000000");
    });
  });
});
