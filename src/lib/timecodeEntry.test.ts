import { describe, expect, it } from "vitest";
import type { Rational } from "@/types/project";
import {
  formatFrameTimecodeFromTicks,
  formatMillisecondsTimecode,
  MILLISECONDS_TIMECODE_DISPLAY,
  type TimecodeDisplay,
} from "./timecode";
import { parseTimecodeEntry, type TimecodeEntry } from "./timecodeEntry";

function framesDisplay(rate: Rational, videoTimeBase: Rational | null = null) {
  return { format: "frames", rate, videoTimeBase } as const satisfies TimecodeDisplay;
}

const at25 = framesDisplay({ n: 25, d: 1 }, { n: 1, d: 25 });
const at2997 = framesDisplay({ n: 30000, d: 1001 }, { n: 1, d: 1000 });
const at120 = framesDisplay({ n: 120, d: 1 }, { n: 1, d: 120 });
const at240 = framesDisplay({ n: 240, d: 1 }, { n: 1, d: 240 });
const ms = MILLISECONDS_TIMECODE_DISPLAY;

function entry(text: string, display: TimecodeDisplay): TimecodeEntry {
  const parsed = parseTimecodeEntry(text, display);
  if (!parsed.ok) {
    throw new Error(`"${text}" was refused: ${parsed.error}`);
  }
  return parsed.entry;
}

function frame(index: number | bigint): TimecodeEntry {
  return { kind: "frame", frameIndex: BigInt(index) };
}

function frameStep(frames: number | bigint): TimecodeEntry {
  return { kind: "frameStep", frames: BigInt(frames) };
}

function millisecond(value: number | bigint): TimecodeEntry {
  return { kind: "millisecond", milliseconds: BigInt(value) };
}

function millisecondStep(value: number | bigint): TimecodeEntry {
  return { kind: "millisecondStep", milliseconds: BigInt(value) };
}

/** The frame timecode of frame `k`: its exact nominal start, `k * rate.d / rate.n` seconds. */
function frameLabel(rate: Rational, k: number): string {
  return formatFrameTimecodeFromTicks(
    BigInt(k) * BigInt(rate.d),
    { n: 1, d: rate.n },
    rate,
  );
}

/** Frames of `h:m:s` and `ff` frames at an integer rate. */
function at(rate: number, h: number, m: number, s: number, ff: number): number {
  return (h * 3600 + m * 60 + s) * rate + ff;
}

describe("parseTimecodeEntry", () => {
  describe("frame format, fields with colons", () => {
    it("reads every field of HH:MM:SS:FF", () => {
      expect(entry("00:00:05:12", at25)).toEqual(frame(at(25, 0, 0, 5, 12)));
      expect(entry("01:22:14:19", at25)).toEqual(frame(at(25, 1, 22, 14, 19)));
    });

    it("takes a missing leading field as zero", () => {
      expect(entry("5:12", at25)).toEqual(frame(at(25, 0, 0, 5, 12)));
      expect(entry("1:05:12", at25)).toEqual(frame(at(25, 0, 1, 5, 12)));
      expect(entry("0:5:1", at25)).toEqual(frame(at(25, 0, 0, 5, 1)));
    });

    it("carries a field that is too large into the next field", () => {
      // FF at or above the frames of its second counts on from the first frame of that second.
      expect(entry("00:00:00:40", at25)).toEqual(frame(40));
      expect(frameLabel(at25.rate, 40)).toBe("00:00:01:15");
      expect(entry("00:00:90:00", at25)).toEqual(frame(90 * 25));
      expect(entry("1:90:00", at25)).toEqual(frame(150 * 25));
    });

    it("counts FF from the first frame that starts in the second at 29.97 fps", () => {
      // Second 1 starts with frame 30 (ceil(29.97)), as the display counts it (ADR 028).
      expect(entry("00:00:01:00", at2997)).toEqual(frame(30));
      expect(frameLabel(at2997.rate, 30)).toBe("00:00:01:00");
      // Second 33 holds frames 990 to 1018, 29 frames, so FF 29 carries into second 34.
      expect(entry("00:00:33:00", at2997)).toEqual(frame(990));
      expect(entry("00:00:33:28", at2997)).toEqual(frame(1018));
      expect(entry("00:00:33:29", at2997)).toEqual(frame(1019));
      expect(frameLabel(at2997.rate, 1019)).toBe("00:00:34:00");
    });

    it("carries FF the same way in digits only and with a period at 29.97 fps", () => {
      // "3329" is 00:00:33:29, which carries into frame 1019, 00:00:34:00.
      expect(entry("3329", at2997)).toEqual(frame(1019));
      // "+33.29" is 00:33:00:29: ceil(1980 * 29.97) = 59341, then 29 frames.
      expect(entry("+33.29", at2997)).toEqual(frameStep(59_370));
      expect(entry("33.29", at2997)).toEqual(frame(59_370));
    });

    it("refuses the drop-frame separator", () => {
      for (const text of ["00;00;05;12", "5;12", "5:12;00"]) {
        expect(parseTimecodeEntry(text, at25), text).toEqual({
          ok: false,
          error: "invalid",
        });
      }
    });

    it("refuses a shape that is not a timecode", () => {
      for (const text of [
        "5:",
        ":5",
        "5::12",
        "1:2:3:4:5",
        "5:12.5",
        "5.5:1",
        "1e3",
        "0x10",
        "5,12",
        "5 :12",
        "5+",
        "++5",
        "+-5",
        "--5",
        "abc",
        "Infinity",
        "NaN",
      ]) {
        expect(parseTimecodeEntry(text, at25), text).toEqual({
          ok: false,
          error: "invalid",
        });
      }
    });
  });

  describe("frame format, digits only", () => {
    it("right-aligns the digits into fields, as Premiere Pro does", () => {
      expect(entry("1012", at25)).toEqual(frame(at(25, 0, 0, 10, 12)));
      expect(entry("112", at25)).toEqual(frame(at(25, 0, 0, 1, 12)));
      expect(entry("12", at25)).toEqual(frame(12));
      expect(entry("1", at25)).toEqual(frame(1));
      expect(entry("0", at25)).toEqual(frame(0));
      expect(entry("01221419", at25)).toEqual(frame(at(25, 1, 22, 14, 19)));
      expect(entry("1419", at25)).toEqual(frame(at(25, 0, 0, 14, 19)));
    });

    it("gives the leftmost field every digit past eight", () => {
      // Ten digits leave "1000" for HH.
      expect(entry("1000000000", at25)).toEqual(frame(at(25, 1000, 0, 0, 0)));
    });

    it("carries right-aligned fields that are too large", () => {
      expect(entry("40", at25)).toEqual(frame(40));
      expect(entry("9000", at25)).toEqual(frame(90 * 25));
    });

    it("gives FF three digits at a rate above 100 fps", () => {
      for (const [display, rate] of [
        [at120, 120],
        [at240, 240],
      ] as const) {
        expect(entry("1012", display)).toEqual(frame(at(rate, 0, 0, 1, 12)));
        expect(entry("10012", display)).toEqual(frame(at(rate, 0, 0, 10, 12)));
        expect(entry("5:012", display)).toEqual(frame(at(rate, 0, 0, 5, 12)));
        expect(entry("5:12", display)).toEqual(frame(at(rate, 0, 0, 5, 12)));
      }
    });

    it("fills the field of a period with zeros, as Final Cut Pro and DaVinci Resolve do", () => {
      expect(entry("3.", at25)).toEqual(frame(at(25, 0, 0, 3, 0)));
      expect(entry("3..", at25)).toEqual(frame(at(25, 0, 3, 0, 0)));
      expect(entry("3...", at25)).toEqual(frame(at(25, 3, 0, 0, 0)));
      expect(entry("1.20", at25)).toEqual(frame(at(25, 0, 1, 0, 20)));
      // Final Cut Pro reads "1.2" as "1002".
      expect(entry("1.2", at25)).toEqual(frame(at(25, 0, 0, 10, 2)));
      expect(entry(".", at25)).toEqual(frame(0));
      expect(entry("5.5", at25)).toEqual(frame(at(25, 0, 0, 50, 5)));
    });

    it("gives a period in FF three zeros at a rate above 100 fps", () => {
      for (const [display, rate] of [
        [at120, 120],
        [at240, 240],
      ] as const) {
        expect(entry("3.", display)).toEqual(frame(at(rate, 0, 0, 3, 0)));
        expect(entry("3..", display)).toEqual(frame(at(rate, 0, 3, 0, 0)));
        expect(entry("3...", display)).toEqual(frame(at(rate, 3, 0, 0, 0)));
        expect(entry("1.20", display)).toEqual(frame(at(rate, 0, 1, 0, 20)));
        expect(entry("1.2", display)).toEqual(frame(at(rate, 0, 0, 10, 2)));
        expect(entry("1.120", display)).toEqual(frame(at(rate, 0, 1, 0, 120)));
      }
      expect(frameLabel(at120.rate, at(120, 0, 0, 3, 0))).toBe("00:00:03:000");
    });
  });

  describe("frame format, relative", () => {
    it("reads the amount after a sign as an entry without a sign", () => {
      // FF carries: +45 is 45 frames at any rate, as in Premiere Pro.
      expect(entry("+45", at25)).toEqual(frameStep(45));
      expect(entry("-60", at25)).toEqual(frameStep(-60));
      // Right-aligned fields, as in DaVinci Resolve, Final Cut Pro and Avid.
      expect(entry("+1012", at25)).toEqual(frameStep(at(25, 0, 0, 10, 12)));
      expect(entry("+112", at25)).toEqual(frameStep(at(25, 0, 0, 1, 12)));
      expect(entry("+1612", at25)).toEqual(frameStep(at(25, 0, 0, 16, 12)));
      expect(entry("+0", at25)).toEqual(frameStep(0));
      expect(entry("-0", at25)).toEqual(frameStep(0));
    });

    it("reads a timecode after a sign as the frames it names", () => {
      expect(entry("+1:00", at25)).toEqual(frameStep(25));
      expect(entry("+1:00", at2997)).toEqual(frameStep(30));
      expect(entry("-00:00:02:05", at25)).toEqual(frameStep(-55));
      expect(entry("+3.", at25)).toEqual(frameStep(75));
      expect(entry("+3.", at120)).toEqual(frameStep(360));
      // Final Cut Pro: "-01.20" moves one minute and 20 frames back.
      expect(entry("-01.20", at25)).toEqual(frameStep(-at(25, 0, 1, 0, 20)));
    });
  });

  describe("millisecond format", () => {
    it("reads HH:MM:SS.mmm with missing leading fields", () => {
      expect(entry("00:01:05.500", ms)).toEqual(millisecond(65_500));
      expect(entry("01:02:03.004", ms)).toEqual(millisecond(3_723_004));
      expect(entry("1:05.5", ms)).toEqual(millisecond(65_500));
      expect(entry("5.012", ms)).toEqual(millisecond(5_012));
      expect(entry("1:02:03", ms)).toEqual(millisecond(3_723_000));
    });

    it("reads digits only as seconds, the last field", () => {
      expect(entry("5", ms)).toEqual(millisecond(5_000));
      expect(entry("0", ms)).toEqual(millisecond(0));
      // A field that is too large carries.
      expect(entry("90", ms)).toEqual(millisecond(90_000));
      expect(entry("1:90", ms)).toEqual(millisecond(150_000));
    });

    it("accepts a decimal part of up to three digits, or none", () => {
      expect(entry("5.", ms)).toEqual(millisecond(5_000));
      expect(entry(".25", ms)).toEqual(millisecond(250));
      expect(entry("5.1", ms)).toEqual(millisecond(5_100));
      expect(entry("5.12", ms)).toEqual(millisecond(5_120));
      expect(entry("5.000", ms)).toEqual(millisecond(5_000));
    });

    it("refuses more than three digits after the point", () => {
      expect(parseTimecodeEntry("5.0125", ms)).toEqual({
        ok: false,
        error: "tooManyDecimals",
      });
      expect(parseTimecodeEntry("+1.0001", ms)).toEqual({
        ok: false,
        error: "tooManyDecimals",
      });
    });

    it("refuses a shape that is not a time", () => {
      for (const text of [
        ".",
        "5.5.5",
        "5.12a",
        "1:2:3:4",
        "1:2:3:4.5",
        "5:",
        ":5",
        "5:.5",
        "5;30",
        "5,5",
        "1e3",
        "abc",
        "5 .5",
      ]) {
        expect(parseTimecodeEntry(text, ms), text).toEqual({
          ok: false,
          error: "invalid",
        });
      }
    });

    it("reads the amount after a sign as an entry without a sign: seconds", () => {
      expect(entry("-2", ms)).toEqual(millisecondStep(-2_000));
      expect(entry("+10", ms)).toEqual(millisecondStep(10_000));
      expect(entry("+1.5", ms)).toEqual(millisecondStep(1_500));
      expect(entry("-1.5", ms)).toEqual(millisecondStep(-1_500));
      expect(entry("+5.", ms)).toEqual(millisecondStep(5_000));
      expect(entry("+.5", ms)).toEqual(millisecondStep(500));
      expect(entry("+1:00", ms)).toEqual(millisecondStep(60_000));
      expect(entry("-0", ms)).toEqual(millisecondStep(0));
    });
  });

  describe("both formats", () => {
    it("reports an empty entry", () => {
      for (const display of [at25, ms]) {
        for (const text of ["", "   ", "+", "-", " + ", "\u3000"]) {
          expect(parseTimecodeEntry(text, display), text).toEqual({
            ok: false,
            error: "empty",
          });
        }
      }
    });

    it("ignores spaces around the entry", () => {
      expect(entry("  5:12  ", at25)).toEqual(frame(at(25, 0, 0, 5, 12)));
      expect(entry("\t+5\n", ms)).toEqual(millisecondStep(5_000));
      expect(entry("\u30005:12\u3000", at25)).toEqual(frame(at(25, 0, 0, 5, 12)));
    });

    it("reads the full-width forms of an input method, the full stops and the minus sign", () => {
      expect(entry("００：００：０５：１２", at25)).toEqual(frame(at(25, 0, 0, 5, 12)));
      expect(entry("＋５", at25)).toEqual(frameStep(5));
      expect(entry("\uFF0D５", at25)).toEqual(frameStep(-5));
      expect(entry("\u22125", at25)).toEqual(frameStep(-5));
      expect(entry("\u2212５", ms)).toEqual(millisecondStep(-5_000));
      expect(entry("１．５", ms)).toEqual(millisecond(1_500));
      expect(entry("5\u30025", ms)).toEqual(millisecond(5_500));
      expect(entry("5\uFF615", ms)).toEqual(millisecond(5_500));
      expect(entry("3\u3002", at25)).toEqual(frame(at(25, 0, 0, 3, 0)));
    });

    it("refuses every other character that is not ASCII", () => {
      for (const display of [at25, ms]) {
        for (const text of [
          "1\u00B2",
          "\u00B2",
          "\u2460",
          "\u2474",
          "\u0661",
          "\u0967",
          "５；１２",
          "\uFE55" + "5",
          "\uFB01",
          "1\u200B2",
        ]) {
          expect(parseTimecodeEntry(text, display), text).toEqual({
            ok: false,
            error: "invalid",
          });
        }
      }
    });

    it("keeps values past the safe integers exact", () => {
      expect(entry("99999999999999999999", ms)).toEqual(
        millisecond(99_999_999_999_999_999_999_000n),
      );
      expect(entry("+9999999999999999999999", at25)).toEqual(
        frameStep((9_999_999_999_999_999n * 3600n + 99n * 60n + 99n) * 25n + 99n),
      );
    });
  });

  describe("round trip of the display", () => {
    const rates: Rational[] = [
      { n: 24, d: 1 },
      { n: 25, d: 1 },
      { n: 30, d: 1 },
      { n: 50, d: 1 },
      { n: 60, d: 1 },
      { n: 120, d: 1 },
      { n: 240, d: 1 },
      { n: 24000, d: 1001 },
      { n: 30000, d: 1001 },
      { n: 60000, d: 1001 },
      { n: 120000, d: 1001 },
      { n: 1, d: 2 },
    ];

    it.each(rates)(
      "reads the frame timecode of every frame back as that frame at $n/$d fps",
      (rate) => {
        const display = framesDisplay(rate);
        const frames: number[] = [];
        for (let k = 0; k < 4000; k++) {
          frames.push(k);
        }
        // Frames around the whole hours, where the hour field changes.
        const perHour = Math.ceil((3600 * rate.n) / rate.d);
        for (let hour = 1; hour <= 3; hour++) {
          for (let k = hour * perHour - 3; k <= hour * perHour + 3; k++) {
            frames.push(k);
          }
        }
        for (const k of frames) {
          const label = frameLabel(rate, k);
          expect(entry(label, display), label).toEqual(frame(k));
          // The digits alone of the label name the same frame.
          expect(entry(label.replaceAll(":", ""), display), label).toEqual(frame(k));
          // After a sign, the label is a length of that many frames.
          expect(entry(`+${label}`, display), label).toEqual(frameStep(k));
          expect(entry(`-${label.replaceAll(":", "")}`, display), label).toEqual(
            frameStep(-k),
          );
        }
      },
    );

    it("reads the millisecond timecode of every millisecond back as that millisecond", () => {
      for (let value = 0; value < 200_000; value += 7) {
        const label = formatMillisecondsTimecode(value / 1000);
        expect(entry(label, ms), label).toEqual(millisecond(value));
        expect(entry(`-${label}`, ms), label).toEqual(millisecondStep(-value));
      }
      const hours = 3 * 3_600_000 + 59 * 60_000 + 59_999;
      expect(entry(formatMillisecondsTimecode(hours / 1000), ms)).toEqual(
        millisecond(hours),
      );
    });
  });
});
