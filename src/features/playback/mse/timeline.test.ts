import { describe, expect, it } from "vitest";
import type { Pts } from "@/types/project";
import {
  mediaDurationFor,
  sampleMediaTime,
  sourceSecondsAt,
  timestampOffsetFor,
  videoStartSeconds,
} from "./timeline";

describe("the timeline of a MediaSource source", () => {
  it("puts videoStartPts at media time 0", () => {
    // A live recording on 1/1000 that starts at 1234.567 s.
    const start = videoStartSeconds("1234567" as Pts, { n: 1, d: 1000 });
    expect(start).toBe(1234.567);
    expect(timestampOffsetFor(1234.567)).toBe(-1234.567);
    // The first video sample of a window on 1/16000, 80 ms after the start.
    expect(sampleMediaTime(1234.647 * 16000, 16000, 1234.567)).toBeCloseTo(0.08, 9);
    expect(sourceSecondsAt(0.08, 1234.567)).toBeCloseTo(1234.647, 9);
  });

  it("reads a negative start and a 90 kHz time base", () => {
    expect(videoStartSeconds("-1001" as Pts, { n: 1, d: 30000 })).toBeCloseTo(
      -1001 / 30000,
      12,
    );
    expect(videoStartSeconds("111111030" as Pts, { n: 1, d: 90000 })).toBeCloseTo(
      1234.567,
      9,
    );
  });

  it("has no start without a valid PTS, time base, or safe value", () => {
    expect(videoStartSeconds(null, { n: 1, d: 1000 })).toBeNull();
    expect(videoStartSeconds("1.5" as Pts, { n: 1, d: 1000 })).toBeNull();
    expect(videoStartSeconds("10" as Pts, { n: 0, d: 1000 })).toBeNull();
    expect(videoStartSeconds("9007199254740993" as Pts, { n: 1, d: 1000 })).toBeNull();
  });

  it("gives the MediaSource the length from the first video frame", () => {
    expect(mediaDurationFor(240.04)).toBe(240.04);
    expect(mediaDurationFor(null)).toBeNull();
    expect(mediaDurationFor(0)).toBeNull();
    expect(mediaDurationFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
