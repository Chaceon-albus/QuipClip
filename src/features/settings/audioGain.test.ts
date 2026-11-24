import { describe, expect, it } from "vitest";
import { audioGainIssue } from "./limits";
import { formatAudioGainField, parseAudioGainField } from "./audioGain";

describe("parseAudioGainField", () => {
  it("stores text with at most one decimal place as integer tenths", () => {
    for (const [raw, tenths] of [
      ["-1", -10],
      ["-1.5", -15],
      ["-1.1", -11],
      ["0.3", 3],
      ["-20.0", -200],
      ["1.50", 15],
      ["1.", 10],
      [".5", 5],
      ["+3", 30],
      [" -2 ", -20],
      ["0.10", 1],
      ["100", 1000],
      ["000.50", 5],
      ["-0", -0],
      ["-0.0", -0],
    ] as const) {
      expect(parseAudioGainField(raw), raw).toBe(tenths);
    }
  });

  it("reads an exponent by the decimal places of the exact value (ADR 054)", () => {
    // A number input takes these forms. Each value here has at most one decimal place.
    for (const [raw, tenths] of [
      ["1e1", 100],
      ["1E1", 100],
      ["-1.5e1", -150],
      ["1.25e1", 125],
      ["5e-1", 5],
      ["50e-2", 5],
      ["1.e1", 100],
      ["2e+0", 20],
      ["0e-9", 0],
    ] as const) {
      expect(parseAudioGainField(raw), raw).toBe(tenths);
    }
  });

  it("stores NaN for text with more than one decimal place", () => {
    // The last ones read as a whole number of tenths in floating point, but their text has more
    // than one decimal place, so they must not pass as that number.
    for (const raw of [
      "-1.25",
      "-15.97",
      "1.000000000001",
      "1e-2",
      "-1.25e0",
      "125e-2",
      "1.0000000000000001",
      "-20.000000000000001",
      "0.30000000000000001",
      "1e-400",
    ]) {
      expect(Number.isNaN(parseAudioGainField(raw)), raw).toBe(true);
      expect(audioGainIssue(parseAudioGainField(raw))?.code, raw).toBe("oneDecimal");
    }
  });

  it("stores the largest number for a whole value too large for a number, so it is out of range", () => {
    for (const [raw, tenths] of [
      ["1e308", Number.MAX_VALUE],
      ["1e400", Number.MAX_VALUE],
      ["-1e400", -Number.MAX_VALUE],
      ["-1.5e999", -Number.MAX_VALUE],
    ] as const) {
      expect(parseAudioGainField(raw), raw).toBe(tenths);
      expect(audioGainIssue(parseAudioGainField(raw))?.code, raw).toBe("outOfRange");
    }
    // A large value that fits keeps its tenths, and is out of range too.
    expect(parseAudioGainField("1e300")).toBe(1e301);
    expect(audioGainIssue(parseAudioGainField("1e300"))?.code).toBe("outOfRange");
  });

  it("stores NaN for blank text and for text that is not decimal text", () => {
    for (const raw of [
      "",
      "  ",
      "abc",
      ".",
      "-",
      "e1",
      "0x10",
      "0b1",
      "0o7",
      "Infinity",
      "1.2.3",
      "1_0",
    ]) {
      expect(Number.isNaN(parseAudioGainField(raw)), raw).toBe(true);
    }
  });
});

describe("formatAudioGainField", () => {
  it("renders NaN as an empty string", () => {
    expect(formatAudioGainField(Number.NaN)).toBe("");
  });

  it("renders the tenths of a decibel as decimal text in decibels", () => {
    expect(formatAudioGainField(0)).toBe("0");
    expect(formatAudioGainField(-10)).toBe("-1");
    expect(formatAudioGainField(-15)).toBe("-1.5");
    expect(formatAudioGainField(-11)).toBe("-1.1");
    expect(formatAudioGainField(200)).toBe("20");
  });

  it("gives text that reads back as the same gain, for every gain in the range", () => {
    for (let tenths = -200; tenths <= 200; tenths += 1) {
      const text = formatAudioGainField(tenths);
      expect(text, String(tenths)).toMatch(/^-?\d+(\.\d)?$/);
      expect(parseAudioGainField(text), text).toBe(tenths);
    }
  });
});
