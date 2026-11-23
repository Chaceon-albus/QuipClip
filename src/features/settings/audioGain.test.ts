import { describe, expect, it } from "vitest";
import { parseAudioGainField } from "./audioGain";

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
    // These have two places or more, so they store no integer.
    for (const raw of ["1e-2", "-1.25e0", "125e-2"]) {
      expect(Number.isInteger(parseAudioGainField(raw)), raw).toBe(false);
    }
  });

  it("keeps a value with more decimal places as a fraction", () => {
    expect(parseAudioGainField("-1.25")).toBe(-12.5);
    expect(Number.isInteger(parseAudioGainField("1.000000000001"))).toBe(false);
  });

  it("stores no integer for text whose number lost its extra digits", () => {
    // Each of these reads as a whole number of tenths in floating point, but its text has more
    // than one decimal place, so it must not pass as that number.
    for (const raw of [
      "1.0000000000000001",
      "-20.000000000000001",
      "0.30000000000000001",
      "1e-400",
    ]) {
      expect(Number.isNaN(parseAudioGainField(raw)), raw).toBe(true);
    }
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
      "1e400",
      "1.2.3",
      "1_0",
    ]) {
      expect(Number.isNaN(parseAudioGainField(raw)), raw).toBe(true);
    }
  });
});
