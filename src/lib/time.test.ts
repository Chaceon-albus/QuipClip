import { describe, expect, it } from "vitest";
import {
  formatSecondsForFfmpeg,
  formatTimecode,
  frameAtMediaTime,
  frameAtSeconds,
  framesPerSecondCeil,
  midpointSecondsAtFrame,
  parseFrameRate,
  parseTimecode,
  rationalsEqual,
  rationalToNumber,
  secondsAtFrame,
} from "@/lib/time";

const NTSC = { n: 30000, d: 1001 };
const FPS25 = { n: 25, d: 1 };

describe("time helpers", () => {
  describe("rationalToNumber", () => {
    it("converts NTSC 30000/1001 to a float", () => {
      const num = rationalToNumber(NTSC);
      expect(num).toBeCloseTo(29.97002997, 6);
    });

    it("converts 25/1 to exact 25", () => {
      expect(rationalToNumber(FPS25)).toBe(25);
    });
  });

  describe("parseFrameRate", () => {
    it("parses NTSC 30000/1001 correctly", () => {
      expect(parseFrameRate("30000/1001")).toEqual({ n: 30000, d: 1001 });
      expect(parseFrameRate(" 30000 / 1001 ")).toEqual({ n: 30000, d: 1001 });
    });

    it("parses bare integer 25 and reduces fractions", () => {
      expect(parseFrameRate("25")).toEqual({ n: 25, d: 1 });
      expect(parseFrameRate("25/1")).toEqual({ n: 25, d: 1 });
      expect(parseFrameRate("50/2")).toEqual({ n: 25, d: 1 });
    });

    it("returns null for 0/0 and division by zero", () => {
      expect(parseFrameRate("0/0")).toBeNull();
      expect(parseFrameRate("25/0")).toBeNull();
      expect(parseFrameRate("30000/0")).toBeNull();
    });

    it("returns null for malformed strings", () => {
      expect(parseFrameRate("")).toBeNull();
      expect(parseFrameRate("abc")).toBeNull();
      expect(parseFrameRate("29.97")).toBeNull();
      expect(parseFrameRate("30000/1001/2")).toBeNull();
      expect(parseFrameRate("30000/")).toBeNull();
      expect(parseFrameRate("/1001")).toBeNull();
    });

    it("returns null for zero numerator and negative rates", () => {
      expect(parseFrameRate("0/1")).toBeNull();
      expect(parseFrameRate("0")).toBeNull();
      expect(parseFrameRate("0/1001")).toBeNull();
      expect(parseFrameRate("-25/1")).toBeNull();
      expect(parseFrameRate("-25")).toBeNull();
      expect(parseFrameRate("25/-1")).toBeNull();
      expect(parseFrameRate("-30000/1001")).toBeNull();
      expect(parseFrameRate("30000/-1001")).toBeNull();
    });

    it("parses double negative rates as positive", () => {
      expect(parseFrameRate("-25/-1")).toEqual({ n: 25, d: 1 });
    });
  });

  describe("rationalsEqual", () => {
    it("compares equal rates reduced and unreduced at 25/1 and 30000/1001", () => {
      expect(rationalsEqual({ n: 50, d: 2 }, { n: 25, d: 1 })).toBe(true);
      expect(rationalsEqual({ n: 30000, d: 1001 }, { n: 60000, d: 2002 })).toBe(true);
      expect(rationalsEqual(NTSC, FPS25)).toBe(false);
    });

    it("handles zero denominators defensively", () => {
      expect(rationalsEqual({ n: 1, d: 0 }, { n: 1, d: 0 })).toBe(false);
      expect(rationalsEqual({ n: 25, d: 1 }, { n: 25, d: 0 })).toBe(false);
    });

    it("correctly compares rationals whose cross-product exceeds Number.MAX_SAFE_INTEGER", () => {
      const huge = { n: Number.MAX_SAFE_INTEGER, d: 2 };
      // MAX_SAFE_INTEGER * 2 exceeds Number.MAX_SAFE_INTEGER
      expect(rationalsEqual(huge, { n: Number.MAX_SAFE_INTEGER, d: 2 })).toBe(true);
      expect(rationalsEqual(huge, { n: Number.MAX_SAFE_INTEGER, d: 3 })).toBe(false);
    });
  });

  describe("secondsAtFrame", () => {
    it("calculates exact seconds for 30000/1001 fps", () => {
      // 3,600,000 frames at 30000/1001 is exactly 120,120 seconds
      expect(secondsAtFrame(3_600_000, NTSC)).toBe(120120);
      expect(secondsAtFrame(0, NTSC)).toBe(0);
      expect(secondsAtFrame(30000, NTSC)).toBe(1001);
    });

    it("calculates exact seconds for 25/1 fps", () => {
      expect(secondsAtFrame(25, FPS25)).toBe(1);
      expect(secondsAtFrame(100, FPS25)).toBe(4);
      expect(secondsAtFrame(-25, FPS25)).toBe(-1);
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => secondsAtFrame(5, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => secondsAtFrame(5, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => secondsAtFrame(5, { n: -30000, d: 1001 })).toThrow(RangeError);
      expect(() => secondsAtFrame(5, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => secondsAtFrame(5, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("midpointSecondsAtFrame", () => {
    it("is strictly between secondsAtFrame(f) and secondsAtFrame(f+1) at 30000/1001", () => {
      for (const f of [-1000, -1, 0, 1, 29, 30, 3600 * 30, 12345]) {
        const start = secondsAtFrame(f, NTSC);
        const mid = midpointSecondsAtFrame(f, NTSC);
        const next = secondsAtFrame(f + 1, NTSC);
        expect(start).toBeLessThan(mid);
        expect(mid).toBeLessThan(next);
      }
    });

    it("is strictly between secondsAtFrame(f) and secondsAtFrame(f+1) at 25/1", () => {
      for (const f of [-1000, -1, 0, 1, 24, 25, 3600 * 25, 12345]) {
        const start = secondsAtFrame(f, FPS25);
        const mid = midpointSecondsAtFrame(f, FPS25);
        const next = secondsAtFrame(f + 1, FPS25);
        expect(start).toBeLessThan(mid);
        expect(mid).toBeLessThan(next);
      }
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => midpointSecondsAtFrame(5, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => midpointSecondsAtFrame(5, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => midpointSecondsAtFrame(5, { n: -30000, d: 1001 })).toThrow(
        RangeError,
      );
      expect(() => midpointSecondsAtFrame(5, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => midpointSecondsAtFrame(5, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("frameAtSeconds", () => {
    it("round trips frameAtSeconds(secondsAtFrame(f)) === f at 30000/1001 including f = 3_600_000", () => {
      const frames = [
        -1_000_000,
        -30,
        -1,
        0,
        1,
        29,
        30,
        31,
        3600 * 30,
        3_600_000,
        7_919_999,
      ];
      for (const f of frames) {
        const sec = secondsAtFrame(f, NTSC);
        expect(frameAtSeconds(sec, NTSC)).toBe(f);
      }
    });

    it("round trips frameAtSeconds(secondsAtFrame(f)) === f at 25/1", () => {
      const frames = [-10_000, -25, -1, 0, 1, 24, 25, 26, 90_000, 3_600_000];
      for (const f of frames) {
        const sec = secondsAtFrame(f, FPS25);
        expect(frameAtSeconds(sec, FPS25)).toBe(f);
      }
    });

    it("correctly floors negative values at 25/1 and 30000/1001", () => {
      // -0.5s at 25fps is frame -13 (floor of -12.5)
      expect(frameAtSeconds(-0.5, FPS25)).toBe(-13);
      // -0.5s at 30000/1001 fps is frame -15 (floor of -14.985)
      expect(frameAtSeconds(-0.5, NTSC)).toBe(-15);
    });

    it("guards the float ULP boundary case", () => {
      // Test simulated ULP perturbation just below boundary
      const exactSec = secondsAtFrame(100, NTSC);
      const justBelow = exactSec - 1e-15;
      expect(frameAtSeconds(justBelow, NTSC)).toBe(100);

      const exactSec25 = secondsAtFrame(100, FPS25);
      const justBelow25 = exactSec25 - 1e-15;
      expect(frameAtSeconds(justBelow25, FPS25)).toBe(100);
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => frameAtSeconds(1.0, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => frameAtSeconds(1.0, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => frameAtSeconds(1.0, { n: -30000, d: 1001 })).toThrow(RangeError);
      expect(() => frameAtSeconds(1.0, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => frameAtSeconds(1.0, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("frameAtMediaTime", () => {
    it("converts media timestamp offset by startTime at 30000/1001", () => {
      const fps = NTSC;
      const startTime = 1.001; // exactly 30 frames
      const mediaTime = 2.002; // exactly 60 frames total, 30 frames offset
      expect(frameAtMediaTime(mediaTime, startTime, fps)).toBe(30);
    });

    it("converts media timestamp offset by startTime at 25/1", () => {
      const fps = FPS25;
      const startTime = 10.0;
      const mediaTime = 14.0; // 4.0s offset = 100 frames
      expect(frameAtMediaTime(mediaTime, startTime, fps)).toBe(100);
    });

    it("handles negative relative offsets correctly", () => {
      expect(frameAtMediaTime(0.5, 1.0, FPS25)).toBe(-13);
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => frameAtMediaTime(2.0, 1.0, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => frameAtMediaTime(2.0, 1.0, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => frameAtMediaTime(2.0, 1.0, { n: -30000, d: 1001 })).toThrow(
        RangeError,
      );
      expect(() => frameAtMediaTime(2.0, 1.0, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => frameAtMediaTime(2.0, 1.0, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("framesPerSecondCeil", () => {
    it("computes ceil for NTSC (30000/1001 -> 30)", () => {
      expect(framesPerSecondCeil(NTSC)).toBe(30);
    });

    it("computes ceil for 25/1 (25 -> 25)", () => {
      expect(framesPerSecondCeil(FPS25)).toBe(25);
    });

    it("computes ceil for 24000/1001 (23.976 -> 24)", () => {
      expect(framesPerSecondCeil({ n: 24000, d: 1001 })).toBe(24);
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => framesPerSecondCeil({ n: 0, d: 1 })).toThrow(RangeError);
      expect(() => framesPerSecondCeil({ n: -25, d: 1 })).toThrow(RangeError);
      expect(() => framesPerSecondCeil({ n: -30000, d: 1001 })).toThrow(RangeError);
      expect(() => framesPerSecondCeil({ n: 25, d: 0 })).toThrow(RangeError);
      expect(() => framesPerSecondCeil({ n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("formatTimecode", () => {
    it("formats 30000/1001: FF runs 00..29 and frame 30 is 00:00:01:00", () => {
      expect(formatTimecode(0, NTSC)).toBe("00:00:00:00");
      expect(formatTimecode(29, NTSC)).toBe("00:00:00:29");
      expect(formatTimecode(30, NTSC)).toBe("00:00:01:00");
      expect(formatTimecode(31, NTSC)).toBe("00:00:01:01");
    });

    it("formats 25/1: FF runs 00..24 and frame 25 is 00:00:01:00", () => {
      expect(formatTimecode(0, FPS25)).toBe("00:00:00:00");
      expect(formatTimecode(24, FPS25)).toBe("00:00:00:24");
      expect(formatTimecode(25, FPS25)).toBe("00:00:01:00");
      expect(formatTimecode(3661 * 25 + 13, FPS25)).toBe("01:01:01:13");
    });

    it("formats negative frames with a single leading minus", () => {
      expect(formatTimecode(-5, FPS25)).toBe("-00:00:00:05");
      expect(formatTimecode(-25, FPS25)).toBe("-00:00:01:00");
      expect(formatTimecode(-30, NTSC)).toBe("-00:00:01:00");
      expect(formatTimecode(-1, NTSC)).toBe("-00:00:00:01");
    });

    it("does not clamp hours to 24", () => {
      const hours100At25 = 100 * 3600 * 25;
      expect(formatTimecode(hours100At25, FPS25)).toBe("100:00:00:00");
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => formatTimecode(5, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => formatTimecode(5, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => formatTimecode(5, { n: -30000, d: 1001 })).toThrow(RangeError);
      expect(() => formatTimecode(5, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => formatTimecode(5, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("parseTimecode", () => {
    it("round trips parseTimecode(formatTimecode(f)) === f at 30000/1001", () => {
      const testFrames = [
        0,
        1,
        29,
        30,
        31,
        3600 * 30 + 15, // > 1 hour
        7200 * 30 + 900, // > 2 hours
        -1,
        -30,
        -12345,
      ];
      for (const f of testFrames) {
        const tc = formatTimecode(f, NTSC);
        expect(parseTimecode(tc, NTSC)).toBe(f);
      }
    });

    it("round trips parseTimecode(formatTimecode(f)) === f at 25/1", () => {
      const testFrames = [
        0,
        1,
        24,
        25,
        26,
        3661 * 25 + 13, // > 1 hour
        -1,
        -25,
        -3661 * 25 - 13,
      ];
      for (const f of testFrames) {
        const tc = formatTimecode(f, FPS25);
        expect(parseTimecode(tc, FPS25)).toBe(f);
      }
    });

    it("rejects FF field >= framesPerSecondCeil", () => {
      // At NTSC (fpsCeil = 30), FF must be < 30
      expect(parseTimecode("00:00:00:30", NTSC)).toBeNull();
      expect(parseTimecode("00:00:00:29", NTSC)).toBe(29);

      // At 25fps (fpsCeil = 25), FF must be < 25
      expect(parseTimecode("00:00:00:25", FPS25)).toBeNull();
      expect(parseTimecode("00:00:00:24", FPS25)).toBe(24);
    });

    it("rejects malformed strings", () => {
      expect(parseTimecode("not a timecode", FPS25)).toBeNull();
      expect(parseTimecode("00:00:00", FPS25)).toBeNull();
      expect(parseTimecode("00:00:00:00:00", FPS25)).toBeNull();
      expect(parseTimecode("00:60:00:00", FPS25)).toBeNull();
      expect(parseTimecode("00:00:60:00", FPS25)).toBeNull();
      expect(parseTimecode("00:-01:00:00", FPS25)).toBeNull();
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => parseTimecode("00:00:01:00", { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => parseTimecode("00:00:01:00", { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => parseTimecode("00:00:01:00", { n: -30000, d: 1001 })).toThrow(
        RangeError,
      );
      expect(() => parseTimecode("00:00:01:00", { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => parseTimecode("00:00:01:00", { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("formatSecondsForFfmpeg", () => {
    it("formats known values with 9 decimal places at 30000/1001", () => {
      // 1 frame at NTSC = 1001/30000 s = 0.0333666666... -> rounds to 0.033366667
      expect(formatSecondsForFfmpeg(1, NTSC)).toBe("0.033366667");
      expect(formatSecondsForFfmpeg(0, NTSC)).toBe("0.000000000");
      expect(formatSecondsForFfmpeg(30, NTSC)).toBe("1.001000000");
      expect(formatSecondsForFfmpeg(-1, NTSC)).toBe("-0.033366667");
    });

    it("formats known values with 9 decimal places at 25/1", () => {
      expect(formatSecondsForFfmpeg(0, FPS25)).toBe("0.000000000");
      expect(formatSecondsForFfmpeg(25, FPS25)).toBe("1.000000000");
      expect(formatSecondsForFfmpeg(100, FPS25)).toBe("4.000000000");
      expect(formatSecondsForFfmpeg(-25, FPS25)).toBe("-1.000000000");
    });

    it("preserves exact digits for a large frame index without precision loss", () => {
      // 3,600,000 frames at 30000/1001 is exactly 120,120 seconds
      expect(formatSecondsForFfmpeg(3_600_000, NTSC)).toBe("120120.000000000");
      expect(formatSecondsForFfmpeg(3_600_000, FPS25)).toBe("144000.000000000");
    });

    it("returns 0.000000000 for non-safe-integer frame values", () => {
      expect(formatSecondsForFfmpeg(NaN, FPS25)).toBe("0.000000000");
      expect(formatSecondsForFfmpeg(Infinity, FPS25)).toBe("0.000000000");
    });

    it("throws RangeError for zero or negative fps", () => {
      expect(() => formatSecondsForFfmpeg(5, { n: 0, d: 1 })).toThrow(RangeError);
      expect(() => formatSecondsForFfmpeg(5, { n: -25, d: 1 })).toThrow(RangeError);
      expect(() => formatSecondsForFfmpeg(5, { n: -30000, d: 1001 })).toThrow(
        RangeError,
      );
      expect(() => formatSecondsForFfmpeg(5, { n: 25, d: 0 })).toThrow(RangeError);
      expect(() => formatSecondsForFfmpeg(5, { n: 25, d: -1 })).toThrow(RangeError);
    });
  });

  describe("assertPositiveFps parameter validation across all fps-taking functions", () => {
    const invalidFpsCases: Array<[string, { n: number; d: number }]> = [
      ["non-finite fps", { n: NaN, d: 1 }],
      ["fractional fps", { n: 29.97, d: 1 }],
      ["unsafe integer fps", { n: Number.MAX_SAFE_INTEGER + 1, d: 1 }],
      ["non-finite denominator fps", { n: 25, d: NaN }],
      ["fractional denominator fps", { n: 25, d: 1.5 }],
      ["unsafe integer denominator fps", { n: 25, d: Number.MAX_SAFE_INTEGER + 1 }],
    ];

    const fpsTakingFunctions: Array<[string, (fps: { n: number; d: number }) => void]> =
      [
        ["secondsAtFrame", (fps) => secondsAtFrame(5, fps)],
        ["midpointSecondsAtFrame", (fps) => midpointSecondsAtFrame(5, fps)],
        ["frameAtSeconds", (fps) => frameAtSeconds(1.0, fps)],
        ["frameAtMediaTime", (fps) => frameAtMediaTime(2.0, 1.0, fps)],
        ["framesPerSecondCeil", (fps) => framesPerSecondCeil(fps)],
        ["formatTimecode", (fps) => formatTimecode(5, fps)],
        ["parseTimecode", (fps) => parseTimecode("00:00:01:00", fps)],
        ["formatSecondsForFfmpeg", (fps) => formatSecondsForFfmpeg(5, fps)],
      ];

    describe.each(fpsTakingFunctions)(
      "%s invalid fps validation",
      (_fnName, invoke) => {
        it.each(invalidFpsCases)(
          "throws RangeError before arithmetic for %s",
          (_label, fps) => {
            expect(() => invoke(fps)).toThrow(RangeError);
          },
        );
      },
    );
  });
});
