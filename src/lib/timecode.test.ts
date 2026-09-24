import { describe, expect, it } from "vitest";
import type { Rational } from "@/types/project";
import {
  FRAME_TIMECODE_PLACEHOLDER,
  MILLISECONDS_TIMECODE_DISPLAY,
  MILLISECONDS_TIMECODE_PLACEHOLDER,
  TIMECODE_FORMATS,
  formatElapsedTimecode,
  formatFrameCountTimecode,
  formatFrameTimecode,
  formatFrameTimecodeFromTicks,
  formatMillisecondsFromTicks,
  formatMillisecondsTimecode,
  frameBoundaryMarginSeconds,
  frameIndexDigits,
  frameIndexOfTicks,
  isFrameGridExact,
  frameTimecodePlaceholder,
  timecodePlaceholder,
} from "./timecode";

const fps24: Rational = { n: 24, d: 1 };
const fps25: Rational = { n: 25, d: 1 };
const fps30: Rational = { n: 30, d: 1 };
const fps60: Rational = { n: 60, d: 1 };
const fps23976: Rational = { n: 24000, d: 1001 };
const fps2997: Rational = { n: 30000, d: 1001 };
const fps5994: Rational = { n: 60000, d: 1001 };
const fps120: Rational = { n: 120, d: 1 };

const ALL_RATES: readonly [string, Rational][] = [
  ["24", fps24],
  ["25", fps25],
  ["30", fps30],
  ["60", fps60],
  ["23.976", fps23976],
  ["29.97", fps2997],
  ["59.94", fps5994],
];

/** The exact expected string for frame `k` at a rate, from BigInt arithmetic alone. */
function expectedFrameStart(k: bigint, rate: Rational): string {
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  // Frame k starts at k * d / n seconds.
  const whole = (k * d) / n;
  const ff = ((k * d) % n) / d;
  const pad = (v: bigint) => v.toString().padStart(2, "0");
  const ss = whole % 60n;
  const mm = (whole / 60n) % 60n;
  const hh = whole / 3600n;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

describe("formatFrameTimecode", () => {
  describe("integer rates", () => {
    it("formats zero as 00:00:00:00", () => {
      for (const [, rate] of ALL_RATES) {
        expect(formatFrameTimecode(0, rate)).toBe("00:00:00:00");
      }
    });

    it("shows exactly 1/25 s as frame 01, not 00", () => {
      expect(formatFrameTimecode(1 / 25, fps25)).toBe("00:00:00:01");
      expect(formatFrameTimecode(0.04, fps25)).toBe("00:00:00:01");
    });

    it("shows each exact frame start at 25 fps as its own frame", () => {
      // Without the margin, the floating-point value of 1.16 floors to frame 03.
      expect(formatFrameTimecode(1.16, fps25)).toBe("00:00:01:04");
      expect(formatFrameTimecode(1.2, fps25)).toBe("00:00:01:05");
      expect(formatFrameTimecode(1.4, fps25)).toBe("00:00:01:10");
      expect(formatFrameTimecode(1.44, fps25)).toBe("00:00:01:11");
      expect(formatFrameTimecode(0.96, fps25)).toBe("00:00:00:24");
    });

    it("rounds down inside a frame at 25 fps", () => {
      expect(formatFrameTimecode(0.039, fps25)).toBe("00:00:00:00");
      expect(formatFrameTimecode(0.079, fps25)).toBe("00:00:00:01");
      expect(formatFrameTimecode(0.5, fps25)).toBe("00:00:00:12");
      expect(formatFrameTimecode(0.999, fps25)).toBe("00:00:00:24");
    });

    it("formats exact frame starts at 24, 30 and 60 fps", () => {
      expect(formatFrameTimecode(1 / 24, fps24)).toBe("00:00:00:01");
      expect(formatFrameTimecode(26 / 24, fps24)).toBe("00:00:01:02");
      expect(formatFrameTimecode(23 / 24, fps24)).toBe("00:00:00:23");
      expect(formatFrameTimecode(32 / 30, fps30)).toBe("00:00:01:02");
      expect(formatFrameTimecode(29 / 30, fps30)).toBe("00:00:00:29");
      expect(formatFrameTimecode(61 / 60, fps60)).toBe("00:00:01:01");
      expect(formatFrameTimecode(59 / 60, fps60)).toBe("00:00:00:59");
    });

    it("rolls over from the last frame of a second to the next second", () => {
      expect(formatFrameTimecode(24 / 25, fps25)).toBe("00:00:00:24");
      expect(formatFrameTimecode(25 / 25, fps25)).toBe("00:00:01:00");
      expect(formatFrameTimecode(59 / 60, fps60)).toBe("00:00:00:59");
      expect(formatFrameTimecode(60 / 60, fps60)).toBe("00:00:01:00");
    });

    it("formats 59.999 s as the last frame of second 59", () => {
      expect(formatFrameTimecode(59.999, fps25)).toBe("00:00:59:24");
      expect(formatFrameTimecode(59.999, fps24)).toBe("00:00:59:23");
      expect(formatFrameTimecode(59.999, fps30)).toBe("00:00:59:29");
      expect(formatFrameTimecode(59.999, fps60)).toBe("00:00:59:59");
      expect(formatFrameTimecode(59.999, fps2997)).toBe("00:00:59:29");
      expect(formatFrameTimecode(60, fps25)).toBe("00:01:00:00");
    });

    it("formats minutes and hours", () => {
      expect(formatFrameTimecode(3600, fps25)).toBe("01:00:00:00");
      expect(formatFrameTimecode(3661.5, fps25)).toBe("01:01:01:12");
      expect(formatFrameTimecode(3723.52, fps25)).toBe("01:02:03:13");
      expect(formatFrameTimecode(86399.96, fps25)).toBe("23:59:59:24");
      expect(formatFrameTimecode(36000, fps30)).toBe("10:00:00:00");
    });

    it("keeps counting hours past 99", () => {
      expect(formatFrameTimecode(360000, fps25)).toBe("100:00:00:00");
    });
  });

  describe("NTSC rates", () => {
    it("counts frames inside each real second at 23.976 fps", () => {
      expect(formatFrameTimecode(1001 / 24000, fps23976)).toBe("00:00:00:01");
      // Frame 3 starts at 0.125125 s. Without the margin it floors to frame 02.
      expect(formatFrameTimecode(0.125125, fps23976)).toBe("00:00:00:03");
      expect(formatFrameTimecode((23 * 1001) / 24000, fps23976)).toBe("00:00:00:23");
      // Frame 24 starts at 1.001 s, which is frame 00 of second 1.
      expect(formatFrameTimecode((24 * 1001) / 24000, fps23976)).toBe("00:00:01:00");
      expect(formatFrameTimecode((47 * 1001) / 24000, fps23976)).toBe("00:00:01:23");
      expect(formatFrameTimecode((48 * 1001) / 24000, fps23976)).toBe("00:00:02:00");
    });

    it("counts frames inside each real second at 29.97 fps", () => {
      expect(formatFrameTimecode(1001 / 30000, fps2997)).toBe("00:00:00:01");
      // Frame 15 starts at 0.5005 s. Without the margin it floors to frame 14.
      expect(formatFrameTimecode(0.5005, fps2997)).toBe("00:00:00:15");
      expect(formatFrameTimecode((29 * 1001) / 30000, fps2997)).toBe("00:00:00:29");
      expect(formatFrameTimecode((30 * 1001) / 30000, fps2997)).toBe("00:00:01:00");
      // Frame 30001 starts at 1001.0333... s.
      expect(formatFrameTimecode((30001 * 1001) / 30000, fps2997)).toBe("00:16:41:01");
    });

    it("counts frames inside each real second at 59.94 fps", () => {
      expect(formatFrameTimecode(1001 / 60000, fps5994)).toBe("00:00:00:01");
      expect(formatFrameTimecode(0.5005, fps5994)).toBe("00:00:00:30");
      expect(formatFrameTimecode((59 * 1001) / 60000, fps5994)).toBe("00:00:00:59");
      expect(formatFrameTimecode((60 * 1001) / 60000, fps5994)).toBe("00:00:01:00");
      expect(formatFrameTimecode((60004 * 1001) / 60000, fps5994)).toBe("00:16:41:04");
    });

    it("never drifts from the millisecond format at NTSC rates", () => {
      // After one hour of 29.97 fps video the whole seconds agree with the millisecond
      // format, unlike SMPTE non-drop-frame timecode.
      const seconds = 3600.5;
      expect(formatFrameTimecode(seconds, fps2997).slice(0, 8)).toBe(
        formatMillisecondsTimecode(seconds).slice(0, 8),
      );
      expect(formatFrameTimecode(seconds, fps2997)).toBe("01:00:00:14");
    });
  });

  describe("the one-microsecond margin", () => {
    it("counts a time less than one microsecond before a frame start as that frame", () => {
      expect(formatFrameTimecode(0.04 - 5e-7, fps25)).toBe("00:00:00:01");
      expect(formatFrameTimecode(1 - 5e-7, fps25)).toBe("00:00:01:00");
    });

    it("keeps a time more than one microsecond before a frame start in the frame before", () => {
      expect(formatFrameTimecode(0.04 - 2e-6, fps25)).toBe("00:00:00:00");
      expect(formatFrameTimecode(1 - 2e-6, fps25)).toBe("00:00:00:24");
    });

    it("absorbs a microsecond-rounded clock plus one nominal frame interval", () => {
      // Frame 2 at 29.97 fps starts at 0.0667333... s. A web view that rounds to the
      // microsecond reports 0.066733. One nominal step adds 1001 / 30000 s.
      const target = 0.066733 + 1001 / 30000;
      expect(formatFrameTimecode(target, fps2997)).toBe("00:00:00:03");
    });
  });

  describe("sweep of exact frame starts", () => {
    it.each(ALL_RATES)("matches the exact frame index at %s fps", (_label, rate) => {
      const ranges: [number, number][] = [
        [0, 2000],
        [29_990, 30_100],
        [215_000, 215_200],
      ];
      for (const [from, to] of ranges) {
        for (let k = from; k < to; k++) {
          const seconds = (k * rate.d) / rate.n;
          expect(formatFrameTimecode(seconds, rate)).toBe(
            expectedFrameStart(BigInt(k), rate),
          );
        }
      }
    });
  });

  describe("digit count", () => {
    it("uses two digits up to 100 fps and three above", () => {
      expect(frameIndexDigits(fps25)).toBe(2);
      expect(frameIndexDigits(fps5994)).toBe(2);
      expect(frameIndexDigits({ n: 100, d: 1 })).toBe(2);
      expect(frameIndexDigits({ n: 101, d: 1 })).toBe(3);
      expect(frameIndexDigits(fps120)).toBe(3);
      expect(frameIndexDigits({ n: 120000, d: 1001 })).toBe(3);
      expect(frameIndexDigits({ n: 1, d: 2 })).toBe(2);
    });

    it("pads the frame index to the digit count of the rate", () => {
      expect(formatFrameTimecode(0.5, fps120)).toBe("00:00:00:060");
      expect(formatFrameTimecode(1 / 120, fps120)).toBe("00:00:00:001");
      expect(formatFrameTimecode(119 / 120, fps120)).toBe("00:00:00:119");
      expect(formatFrameTimecode(0.99, { n: 100, d: 1 })).toBe("00:00:00:99");
    });

    it("names the frame that contains the time at a rate below one frame per second", () => {
      // At 0.5 fps a frame starts every 2 s, so each frame is frame 00 of its start second.
      expect(formatFrameTimecode(1.5, { n: 1, d: 2 })).toBe("00:00:00:00");
      expect(formatFrameTimecode(2.99, { n: 1, d: 2 })).toBe("00:00:02:00");
      expect(formatFrameTimecode(4, { n: 1, d: 2 })).toBe("00:00:04:00");
    });
  });

  describe("invalid input", () => {
    it("returns the placeholder for a negative or non-finite time", () => {
      expect(formatFrameTimecode(-0.04, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(-1, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(Number.NaN, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(Number.POSITIVE_INFINITY, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(Number.NEGATIVE_INFINITY, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(null as unknown as number, fps25)).toBe("--:--:--:--");
      expect(formatFrameTimecode(Number.MAX_VALUE, fps25)).toBe("--:--:--:--");
    });

    it("sizes the placeholder to the digit count of the rate", () => {
      expect(formatFrameTimecode(-1, fps120)).toBe("--:--:--:---");
    });

    it("returns the placeholder for an invalid rate", () => {
      expect(formatFrameTimecode(1, { n: 0, d: 1 })).toBe("--:--:--:--");
      expect(formatFrameTimecode(1, { n: 25, d: 0 })).toBe("--:--:--:--");
      expect(formatFrameTimecode(1, { n: -25, d: 1 })).toBe("--:--:--:--");
      expect(formatFrameTimecode(1, { n: 2.5, d: 1 })).toBe("--:--:--:--");
    });
  });
});

describe("formatFrameTimecodeFromTicks", () => {
  it("shows one tick at a 1/25 time base as frame 01", () => {
    expect(formatFrameTimecodeFromTicks(1n, { n: 1, d: 25 }, fps25)).toBe(
      "00:00:00:01",
    );
    expect(formatFrameTimecodeFromTicks(25n, { n: 1, d: 25 }, fps25)).toBe(
      "00:00:01:00",
    );
  });

  it("formats NTSC frame starts exactly", () => {
    const perFrame2997: Rational = { n: 1001, d: 30000 };
    expect(formatFrameTimecodeFromTicks(15n, perFrame2997, fps2997)).toBe(
      "00:00:00:15",
    );
    expect(formatFrameTimecodeFromTicks(29n, perFrame2997, fps2997)).toBe(
      "00:00:00:29",
    );
    expect(formatFrameTimecodeFromTicks(30n, perFrame2997, fps2997)).toBe(
      "00:00:01:00",
    );
    expect(formatFrameTimecodeFromTicks(30001n, perFrame2997, fps2997)).toBe(
      "00:16:41:01",
    );

    const tb90k: Rational = { n: 1, d: 90000 };
    expect(formatFrameTimecodeFromTicks(15n * 3003n, tb90k, fps2997)).toBe(
      "00:00:00:15",
    );
    expect(formatFrameTimecodeFromTicks(15n * 3003n - 1n, tb90k, fps2997)).toBe(
      "00:00:00:14",
    );

    const tb24k: Rational = { n: 1, d: 24000 };
    expect(formatFrameTimecodeFromTicks(3n * 1001n, tb24k, fps23976)).toBe(
      "00:00:00:03",
    );
    expect(formatFrameTimecodeFromTicks(24n * 1001n, tb24k, fps23976)).toBe(
      "00:00:01:00",
    );

    const tb60k: Rational = { n: 1, d: 60000 };
    expect(formatFrameTimecodeFromTicks(59n * 1001n, tb60k, fps5994)).toBe(
      "00:00:00:59",
    );
  });

  it("applies the same one-microsecond margin as the floating-point path", () => {
    // Frame 2 at 29.97 fps starts at 66733.33 us. A microsecond time base rounds it down
    // to 66733 us, less than one microsecond before the frame start.
    const tbMicro: Rational = { n: 1, d: 1_000_000 };
    expect(formatFrameTimecodeFromTicks(66733n, tbMicro, fps2997)).toBe("00:00:00:02");
    expect(formatFrameTimecodeFromTicks(66732n, tbMicro, fps2997)).toBe("00:00:00:01");
  });

  it("rounds down inside a frame for a millisecond time base", () => {
    const tbMilli: Rational = { n: 1, d: 1000 };
    expect(formatFrameTimecodeFromTicks(39n, tbMilli, fps25)).toBe("00:00:00:00");
    expect(formatFrameTimecodeFromTicks(40n, tbMilli, fps25)).toBe("00:00:00:01");
    expect(formatFrameTimecodeFromTicks(59_999n, tbMilli, fps25)).toBe("00:00:59:24");
    expect(formatFrameTimecodeFromTicks(3_661_500n, tbMilli, fps25)).toBe(
      "01:01:01:12",
    );
  });

  it("agrees with the floating-point path on every exact frame start", () => {
    for (const [, rate] of ALL_RATES) {
      // One tick per frame: the time base is the inverse of the rate.
      const perFrame: Rational = { n: rate.d, d: rate.n };
      for (let k = 0; k < 3000; k++) {
        const ticks = BigInt(k);
        const expected = expectedFrameStart(ticks, rate);
        expect(formatFrameTimecodeFromTicks(ticks, perFrame, rate)).toBe(expected);
        expect(formatFrameTimecode((k * rate.d) / rate.n, rate)).toBe(expected);
      }
    }
  });

  it("formats a tick count above the safe-integer range exactly", () => {
    const ticks = 2n ** 62n;
    const tb90k: Rational = { n: 1, d: 90000 };
    const seconds = ticks / 90000n;
    const hours = seconds / 3600n;
    expect(formatFrameTimecodeFromTicks(ticks, tb90k, fps25)).toMatch(
      new RegExp(`^${hours.toString()}:\\d{2}:\\d{2}:\\d{2}$`),
    );
  });

  it("returns the placeholder for invalid input", () => {
    expect(formatFrameTimecodeFromTicks(-1n, { n: 1, d: 25 }, fps25)).toBe(
      "--:--:--:--",
    );
    expect(formatFrameTimecodeFromTicks(1n, { n: 0, d: 25 }, fps25)).toBe(
      "--:--:--:--",
    );
    expect(formatFrameTimecodeFromTicks(1n, { n: 1, d: 25 }, { n: 0, d: 1 })).toBe(
      "--:--:--:--",
    );
    expect(formatFrameTimecodeFromTicks(-1n, { n: 1, d: 120 }, fps120)).toBe(
      "--:--:--:---",
    );
  });
});

/** The PTS in milliseconds of frame `k`, as Matroska stores it: rounded, half away from zero. */
function matroskaPtsMs(k: bigint, rate: Rational): bigint {
  const n = BigInt(rate.n);
  const d = BigInt(rate.d);
  // The nominal start in milliseconds is k * d * 1000 / n.
  return (2n * k * d * 1000n + n) / (2n * n);
}

/** Splits `HH:MM:SS:FF` into whole seconds and the frame index. */
function splitFrameLabel(label: string): [number, number] {
  const [hh, mm, ss, ff] = label.split(":").map(Number);
  return [(hh * 60 + mm) * 60 + ss, ff];
}

/** Every pair of neighbouring labels that is not one frame step apart. */
function stepErrors(labels: readonly string[]): string[] {
  const errors: string[] = [];
  for (let i = 1; i < labels.length; i++) {
    const [prevSecond, prevFrame] = splitFrameLabel(labels[i - 1]);
    const [second, frame] = splitFrameLabel(labels[i]);
    const isStep =
      (second === prevSecond && frame === prevFrame + 1) ||
      (second === prevSecond + 1 && frame === 0);
    if (!isStep) {
      errors.push(`${labels[i - 1]} -> ${labels[i]}`);
    }
  }
  return errors;
}

describe("the frame boundary margin (ADR 028)", () => {
  const tbMilli: Rational = { n: 1, d: 1000 };
  const tb90k: Rational = { n: 1, d: 90000 };

  /** Frame ranges: the first two minutes, and two minutes around the one-hour mark. */
  function frameRanges(rate: Rational): [number, number][] {
    const perMinute = Math.ceil((60 * rate.n) / rate.d);
    const hour = Math.floor((3600 * rate.n) / rate.d);
    return [
      [0, 2 * perMinute],
      [hour - perMinute, hour + perMinute],
    ];
  }

  it("is one tick when the frame interval is not a whole number of ticks", () => {
    // 29.97 fps at 1/1000: 33.366... ticks per frame.
    expect(frameBoundaryMarginSeconds(fps2997, tbMilli)).toBe(0.001);
    expect(frameBoundaryMarginSeconds(fps24, tbMilli)).toBe(0.001);
    expect(frameBoundaryMarginSeconds(fps5994, tbMilli)).toBe(0.001);
    // 29.97 fps at 1/15360: 512.512 ticks per frame.
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 15360 })).toBe(1 / 15360);
  });

  it("is one microsecond when the frame interval is a whole number of ticks", () => {
    // The frame starts lie exactly on the tick grid.
    expect(frameBoundaryMarginSeconds(fps25, { n: 1, d: 25 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1001, d: 30000 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps2997, tb90k)).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps25, tb90k)).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps25, tbMilli)).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps23976, { n: 1, d: 24000 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps30, { n: 1, d: 15360 })).toBe(0.000001);
  });

  it("is never below one microsecond", () => {
    // 29.97 fps at 1/2000000 and at 1/10000000: one tick is 0.5 us and 0.1 us.
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 2_000_000 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 10_000_000 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps2997, null)).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(fps2997, { n: 0, d: 1 })).toBe(0.000001);
    expect(frameBoundaryMarginSeconds(null, tbMilli)).toBe(0.000001);
    // At 300000 fps, a quarter interval (0.83 us) is below one microsecond.
    expect(frameBoundaryMarginSeconds({ n: 300_000, d: 1 }, { n: 1, d: 125_000 })).toBe(
      0.000001,
    );
  });

  it("is a quarter interval when one tick is not less than half an interval minus 1 us", () => {
    // 29.97 fps at 1/25: a tick of 40 ms is longer than the 33.37 ms interval, and it would
    // move the middle of each frame into the next frame.
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 25 })).toBe(1001 / 120000);
    // 30 fps at 1/24: 41.67 ms ticks for a 33.33 ms interval.
    expect(frameBoundaryMarginSeconds(fps30, { n: 1, d: 24 })).toBe(1 / 120);
    // 29.97 fps at 1/10 and at 1/50: 100 ms and 20 ms ticks.
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 10 })).toBe(1001 / 120000);
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 50 })).toBe(1001 / 120000);
    // 23.976 fps at 1/24 and 59.94 fps at 1/60: 1.001 ticks per frame.
    expect(frameBoundaryMarginSeconds(fps23976, { n: 1, d: 24 })).toBe(1001 / 96000);
    expect(frameBoundaryMarginSeconds(fps5994, { n: 1, d: 60 })).toBe(1001 / 240000);
  });

  it("names the time bases on which the frame grid is exact", () => {
    // One tick or one microsecond of margin.
    expect(isFrameGridExact(fps2997, tbMilli)).toBe(true);
    expect(isFrameGridExact(fps23976, tbMilli)).toBe(true);
    expect(isFrameGridExact(fps5994, tbMilli)).toBe(true);
    expect(isFrameGridExact(fps2997, tb90k)).toBe(true);
    expect(isFrameGridExact(fps2997, { n: 1, d: 15360 })).toBe(true);
    expect(isFrameGridExact(fps25, { n: 1, d: 25 })).toBe(true);
    expect(isFrameGridExact(fps2997, { n: 1001, d: 30000 })).toBe(true);
    expect(isFrameGridExact(fps2997, { n: 1, d: 60 })).toBe(true);
    expect(isFrameGridExact(fps2997, { n: 1, d: 10_000_000 })).toBe(true);
    // A quarter interval of margin: a real start can lie up to a frame from its nominal start.
    expect(isFrameGridExact(fps23976, { n: 1, d: 24 })).toBe(false);
    expect(isFrameGridExact(fps5994, { n: 1, d: 60 })).toBe(false);
    expect(isFrameGridExact(fps2997, { n: 1, d: 50 })).toBe(false);
    expect(isFrameGridExact(fps2997, { n: 1, d: 25 })).toBe(false);
    expect(isFrameGridExact(fps2997, { n: 1, d: 10 })).toBe(false);
    expect(isFrameGridExact(fps30, { n: 1, d: 24 })).toBe(false);
    // No tick grid.
    expect(isFrameGridExact(fps2997, null)).toBe(false);
    expect(isFrameGridExact(fps2997, { n: 0, d: 1 })).toBe(false);
    expect(isFrameGridExact(null, tbMilli)).toBe(false);
    expect(isFrameGridExact({ n: 1, d: 0 }, tbMilli)).toBe(false);
  });

  it("calls the frame grid exact exactly when the margin is not a quarter interval", () => {
    const timeBases: readonly Rational[] = [
      { n: 1, d: 10 },
      { n: 1, d: 24 },
      { n: 1, d: 25 },
      { n: 1, d: 30 },
      { n: 1, d: 48 },
      { n: 1, d: 50 },
      { n: 1, d: 60 },
      { n: 1, d: 120 },
      { n: 1, d: 1000 },
      { n: 1, d: 15360 },
      { n: 1, d: 90000 },
      { n: 1001, d: 30000 },
      { n: 1001, d: 24000 },
    ];
    for (const [label, rate] of [...ALL_RATES, ["120", fps120] as const]) {
      for (const timeBase of timeBases) {
        const quarter = rate.d / (4 * rate.n);
        const isQuarter = frameBoundaryMarginSeconds(rate, timeBase) === quarter;
        expect(
          isFrameGridExact(rate, timeBase),
          `${label} fps at ${timeBase.n}/${timeBase.d}`,
        ).toBe(!isQuarter);
      }
    }
  });

  it("keeps one tick just below that limit", () => {
    // 29.97 fps at 1/60: 2.002 ticks per frame. One tick is 16.667 ms, and half an interval
    // less 1 us is 16.682 ms.
    expect(frameBoundaryMarginSeconds(fps2997, { n: 1, d: 60 })).toBe(1 / 60);
    // 23.976 fps at 1/48 and 59.94 fps at 1/120: 2.002 ticks per frame.
    expect(frameBoundaryMarginSeconds(fps23976, { n: 1, d: 48 })).toBe(1 / 48);
    expect(frameBoundaryMarginSeconds(fps5994, { n: 1, d: 120 })).toBe(1 / 120);
  });

  it.each([
    ["29.97 fps, 1/1000", fps2997, tbMilli],
    ["23.976 fps, 1/1000", fps23976, tbMilli],
    ["59.94 fps, 1/1000", fps5994, tbMilli],
    ["29.97 fps, 1/15360", fps2997, { n: 1, d: 15360 }],
    ["25 fps, 1/1000", fps25, tbMilli],
    ["29.97 fps, 1/60", fps2997, { n: 1, d: 60 }],
    ["23.976 fps, 1/48", fps23976, { n: 1, d: 48 }],
    ["59.94 fps, 1/120", fps5994, { n: 1, d: 120 }],
    ["23.976 fps, 1/24", fps23976, { n: 1, d: 24 }],
    ["59.94 fps, 1/60", fps5994, { n: 1, d: 60 }],
    ["29.97 fps, 1/25", fps2997, { n: 1, d: 25 }],
    ["30 fps, 1/24", fps30, { n: 1, d: 24 }],
    ["29.97 fps, 1/10", fps2997, { n: 1, d: 10 }],
  ] as const)(
    "shows the middle of each frame as that frame, the target of a nominal step (%s)",
    (_label, rate, timeBase) => {
      for (const [from, to] of frameRanges(rate)) {
        const wrong: string[] = [];
        for (let k = from; k < to; k++) {
          const expected = expectedFrameStart(BigInt(k), rate);
          const middle = ((2 * k + 1) * rate.d) / (2 * rate.n);
          const fromSeconds = formatFrameTimecode(middle, rate, timeBase);
          // The same middle in exact ticks of 1 / (2 * rate.n) s.
          const fromTicks = formatFrameTimecodeFromTicks(
            BigInt(2 * k + 1) * BigInt(rate.d),
            { n: 1, d: 2 * rate.n },
            rate,
            timeBase,
          );
          if (fromSeconds !== expected || fromTicks !== expected) {
            wrong.push(
              `frame ${k}: ${fromSeconds} / ${fromTicks}, expected ${expected}`,
            );
          }
        }
        expect(wrong).toEqual([]);
      }
    },
  );

  it.each([
    ["29.97", fps2997],
    ["59.94", fps5994],
    ["23.976", fps23976],
    ["24", fps24],
    ["30", fps30],
    ["60", fps60],
  ] as const)(
    "steps through millisecond PTS at %s fps with no repeat and no skip",
    (_label, rate) => {
      for (const [from, to] of frameRanges(rate)) {
        const exact: string[] = [];
        const float: string[] = [];
        const wrong: string[] = [];
        for (let k = from; k < to; k++) {
          const pts = matroskaPtsMs(BigInt(k), rate);
          const fromTicks = formatFrameTimecodeFromTicks(pts, tbMilli, rate, tbMilli);
          const fromSeconds = formatFrameTimecode(Number(pts) / 1000, rate, tbMilli);
          const expected = expectedFrameStart(BigInt(k), rate);
          if (fromTicks !== expected || fromSeconds !== expected) {
            wrong.push(
              `frame ${k}: ${fromTicks} / ${fromSeconds}, expected ${expected}`,
            );
          }
          exact.push(fromTicks);
          float.push(fromSeconds);
        }
        expect(wrong).toEqual([]);
        expect(stepErrors(exact)).toEqual([]);
        expect(stepErrors(float)).toEqual([]);
      }
    },
  );

  // The first video PTS can be rounded too. The elapsed time counts from it, so measured from
  // it a later frame can start up to one tick before its nominal position.
  it.each([
    ["29.97 fps, first frame 2", fps2997, 2n],
    ["23.976 fps, first frame 1", fps23976, 1n],
    ["59.94 fps, first frame 1", fps5994, 1n],
  ] as const)(
    "steps through millisecond PTS with a rounded first PTS (%s) with no repeat and no skip",
    (_label, rate, firstFrame) => {
      for (const [from, to] of frameRanges(rate)) {
        const first = matroskaPtsMs(firstFrame, rate);
        const exact: string[] = [];
        const float: string[] = [];
        const wrong: string[] = [];
        const halfTick: string[] = [];
        for (let k = from; k < to; k++) {
          const elapsed = matroskaPtsMs(BigInt(k) + firstFrame, rate) - first;
          const fromTicks = formatFrameTimecodeFromTicks(
            elapsed,
            tbMilli,
            rate,
            tbMilli,
          );
          const fromSeconds = formatFrameTimecode(
            Number(elapsed) / 1000,
            rate,
            tbMilli,
          );
          const expected = expectedFrameStart(BigInt(k), rate);
          if (fromTicks !== expected || fromSeconds !== expected) {
            wrong.push(
              `frame ${k}: ${fromTicks} / ${fromSeconds}, expected ${expected}`,
            );
          }
          exact.push(fromTicks);
          float.push(fromSeconds);
          // The earlier half-tick margin, 0.5 ms, as the time base 1/2000 gives it.
          halfTick.push(
            formatFrameTimecodeFromTicks(elapsed, tbMilli, rate, { n: 1, d: 2000 }),
          );
        }
        expect(wrong).toEqual([]);
        expect(stepErrors(exact)).toEqual([]);
        expect(stepErrors(float)).toEqual([]);
        // Control: half a tick repeats and skips numbers on these PTS.
        expect(stepErrors(halfTick).length).toBeGreaterThan(0);
      }
    },
  );

  it("needs the tick margin: the smallest margin repeats and skips numbers on the same PTS", () => {
    for (const rate of [fps2997, fps24]) {
      const labels: string[] = [];
      for (let k = 0n; k < 300n; k++) {
        labels.push(
          formatFrameTimecodeFromTicks(matroskaPtsMs(k, rate), tbMilli, rate),
        );
      }
      expect(stepErrors(labels).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["29.97 fps, 1/1000", fps2997, tbMilli],
    ["59.94 fps, 1/1000", fps5994, tbMilli],
    ["29.97 fps, 1/90000", fps2997, tb90k],
    ["25 fps, 1/1000", fps25, tbMilli],
  ] as const)(
    "shows a seek target 0.9 frame into a frame as that frame (%s)",
    (_label, rate, timeBase) => {
      for (const [from, to] of frameRanges(rate)) {
        const wrong: string[] = [];
        for (let k = from; k < to; k++) {
          const target = ((k + 0.9) * rate.d) / rate.n;
          const shown = formatFrameTimecode(target, rate, timeBase);
          const expected = expectedFrameStart(BigInt(k), rate);
          if (shown !== expected) {
            wrong.push(`frame ${k}: ${shown}, expected ${expected}`);
          }
        }
        expect(wrong).toEqual([]);
      }
    },
  );

  it("names a frame that starts before a whole second by that frame, also after the second", () => {
    // Frame 89 at 29.97 fps starts at 2.9696 s and ends at 3.003 s. A time after 3 s inside
    // it still shows frame 29 of second 2. The millisecond format shows 3 s.
    expect(formatFrameTimecode(2.9697, fps2997, tb90k)).toBe("00:00:02:29");
    expect(formatFrameTimecode(3.0008, fps2997, tb90k)).toBe("00:00:02:29");
    expect(formatMillisecondsTimecode(3.0008)).toBe("00:00:03.001");
    // Frame 90 starts at 3.003 s and is frame 00 of second 3.
    expect(formatFrameTimecode(3.003, fps2997, tb90k)).toBe("00:00:03:00");
    expect(formatFrameTimecodeFromTicks(90n * 3003n, tb90k, fps2997, tb90k)).toBe(
      "00:00:03:00",
    );
  });

  it("puts a PTS just below a whole second into the next second when the frame starts there", () => {
    // A 100 ns time base (ASF). Frame 25 at 25 fps starts at 1 s; a PTS 0.5 us early is
    // inside the one-microsecond margin, so it shows frame 00 of second 1, not frame 24.
    const tb100ns: Rational = { n: 1, d: 10_000_000 };
    expect(formatFrameTimecodeFromTicks(9_999_995n, tb100ns, fps25, tb100ns)).toBe(
      "00:00:01:00",
    );
    expect(formatFrameTimecode(0.9999995, fps25, tb100ns)).toBe("00:00:01:00");
    // Frame 60 at 30 fps starts at 2 s. 0.4 ms and one tick early in a millisecond time base
    // are inside the one-tick margin, because 1/30 s is not a whole number of milliseconds.
    expect(formatFrameTimecode(1.9996, fps30, tbMilli)).toBe("00:00:02:00");
    expect(formatFrameTimecodeFromTicks(1_999n, tbMilli, fps30, tbMilli)).toBe(
      "00:00:02:00",
    );
    // A PTS outside the margin stays in the frame before.
    expect(formatFrameTimecodeFromTicks(9_999_980n, tb100ns, fps25, tb100ns)).toBe(
      "00:00:00:24",
    );
    expect(formatFrameTimecodeFromTicks(1_998n, tbMilli, fps30, tbMilli)).toBe(
      "00:00:01:29",
    );
    // At 25 fps a frame is 40 ms, so the frame starts lie on the millisecond grid and the
    // margin is 1 us. A time 0.4 ms before 2 s is inside frame 49.
    expect(formatFrameTimecode(1.9996, fps25, tbMilli)).toBe("00:00:01:24");
  });

  describe("a time base as coarse as one frame (AVI)", () => {
    const tb25: Rational = { n: 1, d: 25 };
    const tbNtsc: Rational = { n: 1001, d: 30000 };

    it("shows a seek target 0.6 frame into frame 5 as frame 5 at 1/25 and 25 fps", () => {
      expect(formatFrameTimecode(5.6 / 25, fps25, tb25)).toBe("00:00:00:05");
      expect(formatFrameTimecodeFromTicks(5n, tb25, fps25, tb25)).toBe("00:00:00:05");
    });

    it("shows a seek target 0.6 frame into frame 5 as frame 5 at 1001/30000 and 29.97 fps", () => {
      expect(formatFrameTimecode((5.6 * 1001) / 30000, fps2997, tbNtsc)).toBe(
        "00:00:00:05",
      );
      expect(formatFrameTimecodeFromTicks(5n, tbNtsc, fps2997, tbNtsc)).toBe(
        "00:00:00:05",
      );
    });

    it.each([
      ["25 fps, 1/25", fps25, tb25],
      ["29.97 fps, 1001/30000", fps2997, tbNtsc],
    ] as const)(
      "shows every target up to 0.99 frame into a frame as that frame (%s)",
      (_label, rate, timeBase) => {
        const wrong: string[] = [];
        for (let k = 0; k < 2000; k++) {
          for (const into of [0, 0.5, 0.6, 0.99]) {
            const target = ((k + into) * rate.d) / rate.n;
            const shown = formatFrameTimecode(target, rate, timeBase);
            const expected = expectedFrameStart(BigInt(k), rate);
            if (shown !== expected) {
              wrong.push(`frame ${k} + ${into}: ${shown}, expected ${expected}`);
            }
          }
          const fromTicks = formatFrameTimecodeFromTicks(
            BigInt(k),
            timeBase,
            rate,
            timeBase,
          );
          if (fromTicks !== expectedFrameStart(BigInt(k), rate)) {
            wrong.push(`frame ${k} from ticks: ${fromTicks}`);
          }
        }
        expect(wrong).toEqual([]);
      },
    );
  });
});

describe("formatMillisecondsTimecode", () => {
  it("formats 0 seconds as 00:00:00.000", () => {
    expect(formatMillisecondsTimecode(0)).toBe("00:00:00.000");
  });

  it("formats whole seconds and sub-second milliseconds accurately", () => {
    expect(formatMillisecondsTimecode(1)).toBe("00:00:01.000");
    expect(formatMillisecondsTimecode(1.234)).toBe("00:00:01.234");
    expect(formatMillisecondsTimecode(1.005)).toBe("00:00:01.005");
    expect(formatMillisecondsTimecode(59.999)).toBe("00:00:59.999");
  });

  it("formats minutes and hours rollover correctly", () => {
    expect(formatMillisecondsTimecode(60)).toBe("00:01:00.000");
    expect(formatMillisecondsTimecode(3600)).toBe("01:00:00.000");
    expect(formatMillisecondsTimecode(3661.5)).toBe("01:01:01.500");
    expect(formatMillisecondsTimecode(3723.456)).toBe("01:02:03.456");
  });

  it("handles invalid or non-finite inputs by returning 00:00:00.000", () => {
    expect(formatMillisecondsTimecode(-1)).toBe("00:00:00.000");
    expect(formatMillisecondsTimecode(NaN)).toBe("00:00:00.000");
    expect(formatMillisecondsTimecode(Infinity)).toBe("00:00:00.000");
    expect(formatMillisecondsTimecode(-Infinity)).toBe("00:00:00.000");
    expect(formatMillisecondsTimecode(null as unknown as number)).toBe("00:00:00.000");
    expect(formatMillisecondsTimecode(Number.MAX_VALUE)).toBe("00:00:00.000");
  });
});

describe("formatElapsedTimecode", () => {
  it("formats frames for a frame display", () => {
    expect(
      formatElapsedTimecode(1.16, {
        format: "frames",
        rate: fps25,
        videoTimeBase: null,
      }),
    ).toBe("00:00:01:04");
  });

  it("formats milliseconds for the millisecond display", () => {
    expect(formatElapsedTimecode(1.16, MILLISECONDS_TIMECODE_DISPLAY)).toBe(
      "00:00:01.160",
    );
  });
});

describe("placeholders", () => {
  it("defines one placeholder per format", () => {
    expect(FRAME_TIMECODE_PLACEHOLDER).toBe("--:--:--:--");
    expect(MILLISECONDS_TIMECODE_PLACEHOLDER).toBe("--:--:--.---");
  });

  it("sizes the frame placeholder to the rate", () => {
    expect(frameTimecodePlaceholder(fps25)).toBe("--:--:--:--");
    expect(frameTimecodePlaceholder(fps120)).toBe("--:--:--:---");
    expect(frameTimecodePlaceholder(null)).toBe("--:--:--:--");
  });

  it("returns the placeholder of a display", () => {
    expect(timecodePlaceholder(MILLISECONDS_TIMECODE_DISPLAY)).toBe("--:--:--.---");
    expect(
      timecodePlaceholder({ format: "frames", rate: fps2997, videoTimeBase: null }),
    ).toBe("--:--:--:--");
    expect(
      timecodePlaceholder({ format: "frames", rate: fps120, videoTimeBase: null }),
    ).toBe("--:--:--:---");
  });

  it("lists frames first, as the default", () => {
    expect(TIMECODE_FORMATS).toEqual(["frames", "milliseconds"]);
  });
});

describe("frameIndexOfTicks", () => {
  const tb = (n: number, d: number): Rational => ({ n, d });

  // [label, rate, time base, start PTS, PTS, frame index J, frame timecode]. The caller
  // passes the elapsed ticks, PTS - start PTS. The values come from exact arithmetic by
  // hand: J = floor((elapsed + margin) * rate), with one tick of margin when the frame
  // interval is not a whole number of ticks, and one microsecond when it is.
  const cases: readonly [string, Rational, Rational, bigint, bigint, bigint, string][] =
    [
      [
        "29.97 fps, 1 ms, frame 15 stored late",
        fps2997,
        tb(1, 1000),
        1000n,
        1501n,
        15n,
        "00:00:00:15",
      ],
      [
        "29.97 fps, 1 ms, frame 15 stored early",
        fps2997,
        tb(1, 1000),
        1000n,
        1500n,
        15n,
        "00:00:00:15",
      ],
      [
        "29.97 fps, 1 ms, before frame 15",
        fps2997,
        tb(1, 1000),
        1000n,
        1499n,
        14n,
        "00:00:00:14",
      ],
      [
        "29.97 fps, 1 ms, frame 1000",
        fps2997,
        tb(1, 1000),
        1000n,
        34_367n,
        1000n,
        "00:00:33:10",
      ],
      [
        "29.97 fps, 1 ms, one hour",
        fps2997,
        tb(1, 1000),
        1000n,
        3_601_000n,
        107_892n,
        "00:59:59:29",
      ],
      [
        "29.97 fps, 1 ms, first frame of the hour",
        fps2997,
        tb(1, 1000),
        1000n,
        3_601_036n,
        107_893n,
        "01:00:00:00",
      ],
      // Frame 1 starts 3753.75 ticks after the first frame. One tick of margin counts 3753
      // ticks as frame 1, so the last tick of frame 0 is 3752.
      [
        "23.976 fps, 1/90000, before frame 1",
        fps23976,
        tb(1, 90_000),
        126_000n,
        129_752n,
        0n,
        "00:00:00:00",
      ],
      [
        "23.976 fps, 1/90000, frame 1",
        fps23976,
        tb(1, 90_000),
        126_000n,
        129_754n,
        1n,
        "00:00:00:01",
      ],
      [
        "23.976 fps, 1/90000, one minute",
        fps23976,
        tb(1, 90_000),
        126_000n,
        5_526_000n,
        1438n,
        "00:00:59:23",
      ],
      [
        "59.94 fps, 1 ms, frame 171",
        fps5994,
        tb(1, 1000),
        500n,
        3353n,
        171n,
        "00:00:02:51",
      ],
      // Frame 171 starts 2852.85 ms after the first frame. One tick of margin counts 2852 ms
      // as frame 171, so the last millisecond of frame 170 is 2851.
      [
        "59.94 fps, 1 ms, before frame 171",
        fps5994,
        tb(1, 1000),
        500n,
        3351n,
        170n,
        "00:00:02:50",
      ],
      ["25 fps, 1/25, frame 26", fps25, tb(1, 25), 10n, 36n, 26n, "00:00:01:01"],
      [
        "25 fps, 1/25, one hour",
        fps25,
        tb(1, 25),
        10n,
        90_010n,
        90_000n,
        "01:00:00:00",
      ],
      ["25 fps, 1 ms, before frame 1", fps25, tb(1, 1000), 20n, 59n, 0n, "00:00:00:00"],
      ["25 fps, 1 ms, frame 1", fps25, tb(1, 1000), 20n, 60n, 1n, "00:00:00:01"],
      ["25 fps, 1 ms, frame 29", fps25, tb(1, 1000), 20n, 1180n, 29n, "00:00:01:04"],
    ];

  it.each(cases)(
    "names the frame of the elapsed time (%s)",
    (_label, rate, timeBase, startPts, pts, frame, timecode) => {
      const elapsed = pts - startPts;
      expect(frameIndexOfTicks(elapsed, timeBase, rate, timeBase)).toBe(frame);
      expect(formatFrameCountTimecode(frame, rate)).toBe(timecode);
      expect(formatFrameTimecodeFromTicks(elapsed, timeBase, rate, timeBase)).toBe(
        timecode,
      );
    },
  );

  it("applies the frame boundary margin of the video time base", () => {
    const ms = tb(1, 1000);
    // Frame 15 at 29.97 fps starts at 500.5 ms. One tick of margin counts 500 ms as it, and
    // 499 ms stays in frame 14.
    expect(frameIndexOfTicks(501n, ms, fps2997, ms)).toBe(15n);
    expect(frameIndexOfTicks(500n, ms, fps2997, ms)).toBe(15n);
    expect(frameIndexOfTicks(499n, ms, fps2997, ms)).toBe(14n);
    // With no video time base, the margin is one microsecond.
    expect(frameIndexOfTicks(500n, ms, fps2997)).toBe(14n);
    // A whole-tick frame interval: each tick of 1/25 at 25 fps is one frame.
    expect(frameIndexOfTicks(0n, tb(1, 25), fps25, tb(1, 25))).toBe(0n);
    expect(frameIndexOfTicks(90_000n, tb(1, 25), fps25, tb(1, 25))).toBe(90_000n);
  });

  it("returns null for a value it cannot name", () => {
    expect(frameIndexOfTicks(-1n, tb(1, 1000), fps25)).toBeNull();
    expect(frameIndexOfTicks(1n, tb(0, 1), fps25)).toBeNull();
    expect(frameIndexOfTicks(1n, tb(1, 1000), tb(1, 0))).toBeNull();
  });
});

describe("formatFrameCountTimecode", () => {
  it("names the frame with that index on the nominal grid", () => {
    expect(formatFrameCountTimecode(0n, fps25)).toBe("00:00:00:00");
    expect(formatFrameCountTimecode(30n, fps25)).toBe("00:00:01:05");
    expect(formatFrameCountTimecode(90_000n, fps25)).toBe("01:00:00:00");
    // 30 frames at 29.97 fps last 1.001 s: frame 30 is the first frame of second 1.
    expect(formatFrameCountTimecode(29n, fps2997)).toBe("00:00:00:29");
    expect(formatFrameCountTimecode(30n, fps2997)).toBe("00:00:01:00");
    expect(formatFrameCountTimecode(119n, fps120)).toBe("00:00:00:119");
  });

  it("returns the placeholder for a count it cannot format", () => {
    expect(formatFrameCountTimecode(-1n, fps25)).toBe("--:--:--:--");
    expect(formatFrameCountTimecode(-1n, fps120)).toBe("--:--:--:---");
    expect(formatFrameCountTimecode(1n, { n: 0, d: 1 })).toBe(
      FRAME_TIMECODE_PLACEHOLDER,
    );
  });
});

describe("formatMillisecondsFromTicks", () => {
  const tb = (n: number, d: number): Rational => ({ n, d });

  it("rounds to the nearest millisecond, with a half rounded up", () => {
    expect(formatMillisecondsFromTicks(0n, tb(1, 1000))).toBe("00:00:00.000");
    expect(formatMillisecondsFromTicks(90_090n, tb(1, 90_000))).toBe("00:00:01.001");
    // 0.5 ms rounds up, 0.4 ms rounds down.
    expect(formatMillisecondsFromTicks(1n, tb(1, 2000))).toBe("00:00:00.001");
    expect(formatMillisecondsFromTicks(2n, tb(1, 5000))).toBe("00:00:00.000");
    expect(formatMillisecondsFromTicks(3_723_456n, tb(1, 1000))).toBe("01:02:03.456");
  });

  it("returns the millisecond placeholder for a value it cannot format", () => {
    expect(formatMillisecondsFromTicks(-1n, tb(1, 1000))).toBe(
      MILLISECONDS_TIMECODE_PLACEHOLDER,
    );
    expect(formatMillisecondsFromTicks(1n, tb(0, 1))).toBe(
      MILLISECONDS_TIMECODE_PLACEHOLDER,
    );
  });
});
