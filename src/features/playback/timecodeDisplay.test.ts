import { describe, expect, it } from "vitest";
import type { Rational } from "@/types/project";
import {
  resolveTimecodeDisplay,
  resolveTimecodeFormat,
  type TimecodeRateSource,
} from "./timecodeDisplay";

const ntsc: Rational = { n: 30000, d: 1001 };
const fps25: Rational = { n: 25, d: 1 };
const tb90k: Rational = { n: 1, d: 90000 };

function source(
  avgFrameRate: Rational | null,
  rFrameRate: Rational | null,
  videoTimeBase: Rational = tb90k,
): TimecodeRateSource {
  return { avgFrameRate, rFrameRate, videoTimeBase };
}

describe("resolveTimecodeDisplay", () => {
  it("uses milliseconds whenever the preference is milliseconds", () => {
    expect(resolveTimecodeDisplay("milliseconds", source(fps25, fps25))).toEqual({
      format: "milliseconds",
    });
    expect(resolveTimecodeDisplay("milliseconds", source(ntsc, null))).toEqual({
      format: "milliseconds",
    });
  });

  it("uses milliseconds when no source is open", () => {
    expect(resolveTimecodeDisplay("frames", null)).toEqual({ format: "milliseconds" });
    expect(resolveTimecodeDisplay("frames", undefined)).toEqual({
      format: "milliseconds",
    });
  });

  it("uses milliseconds when the source has no nominal frame rate", () => {
    expect(resolveTimecodeDisplay("frames", source(null, null))).toEqual({
      format: "milliseconds",
    });
    expect(
      resolveTimecodeDisplay("frames", source({ n: 0, d: 1 }, { n: 25, d: 0 })),
    ).toEqual({ format: "milliseconds" });
  });

  it("uses frames at the average rate when both rates agree", () => {
    const avg: Rational = { n: 30000, d: 1001 };
    const display = resolveTimecodeDisplay(
      "frames",
      source(avg, { n: 30000, d: 1001 }),
    );
    expect(display).toEqual({ format: "frames", rate: ntsc, videoTimeBase: tb90k });
    // The rate is the probe's own average rate, as the status bar reports it.
    expect(display.format === "frames" && display.rate).toBe(avg);
  });

  it("compares the two rates as rational values, not as their written form", () => {
    expect(resolveTimecodeDisplay("frames", source({ n: 50, d: 2 }, fps25))).toEqual({
      format: "frames",
      rate: { n: 50, d: 2 },
      videoTimeBase: tb90k,
    });
  });

  it("uses milliseconds when the average and real rates differ (VFR)", () => {
    expect(resolveTimecodeDisplay("frames", source({ n: 2997, d: 100 }, ntsc))).toEqual(
      { format: "milliseconds" },
    );
    expect(resolveTimecodeDisplay("frames", source({ n: 24, d: 1 }, fps25))).toEqual({
      format: "milliseconds",
    });
  });

  it("uses frames at the one rate that the source reports", () => {
    expect(resolveTimecodeDisplay("frames", source(fps25, null))).toEqual({
      format: "frames",
      rate: fps25,
      videoTimeBase: tb90k,
    });
    expect(resolveTimecodeDisplay("frames", source(null, ntsc))).toEqual({
      format: "frames",
      rate: ntsc,
      videoTimeBase: tb90k,
    });
  });

  it("ignores an invalid average rate and uses the real rate", () => {
    expect(resolveTimecodeDisplay("frames", source({ n: 0, d: 0 }, ntsc))).toEqual({
      format: "frames",
      rate: ntsc,
      videoTimeBase: tb90k,
    });
  });

  it("carries the video time base of the source, which sets the frame boundary margin", () => {
    const tbMilli: Rational = { n: 1, d: 1000 };
    const display = resolveTimecodeDisplay("frames", source(ntsc, ntsc, tbMilli));
    expect(display).toEqual({ format: "frames", rate: ntsc, videoTimeBase: tbMilli });
  });

  it("drops an invalid video time base, which leaves the smallest margin", () => {
    expect(
      resolveTimecodeDisplay("frames", source(ntsc, ntsc, { n: 0, d: 1 })),
    ).toEqual({
      format: "frames",
      rate: ntsc,
      videoTimeBase: null,
    });
  });
});

describe("resolveTimecodeFormat", () => {
  it("returns the format name alone", () => {
    expect(resolveTimecodeFormat("frames", source(fps25, fps25))).toBe("frames");
    expect(resolveTimecodeFormat("milliseconds", source(fps25, fps25))).toBe(
      "milliseconds",
    );
    expect(resolveTimecodeFormat("frames", source(null, null))).toBe("milliseconds");
    expect(resolveTimecodeFormat("frames", source(fps25, ntsc))).toBe("milliseconds");
    expect(resolveTimecodeFormat("frames", null)).toBe("milliseconds");
  });
});
