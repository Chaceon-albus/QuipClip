import { describe, expect, it } from "vitest";
import {
  MILLISECONDS_TIMECODE_DISPLAY,
  frameIndexOfTicks,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  formatSegmentTotal,
  selectActiveSourceSegmentCount,
  totalActiveSourceSegments,
  type SegmentTotalSource,
} from "./segmentTotal";

const ms: Rational = { n: 1, d: 1000 };
const fps25: Rational = { n: 25, d: 1 };
const fps2997: Rational = { n: 30000, d: 1001 };
const fps5994: Rational = { n: 60000, d: 1001 };

const framesDisplay = (rate: Rational, videoTimeBase: Rational | null = ms) =>
  ({ format: "frames", rate, videoTimeBase }) as const satisfies TimecodeDisplay;

function segment(
  id: string,
  sourceId: string,
  inPts: string | bigint,
  outPts: string | bigint,
): Segment {
  return { id, sourceId, inPts: String(inPts) as Pts, outPts: String(outPts) as Pts };
}

function source(videoStartPts: string | null = "0"): SegmentTotalSource {
  return { videoTimeBase: ms, videoStartPts: videoStartPts as Pts | null };
}

/**
 * The PTS that a container with a 1/1000 time base stores for nominal frame `frame` at
 * `rate`: the frame start rounded to the millisecond, with a half rounded up.
 */
function storedMs(frame: number, rate: Rational): bigint {
  const num = BigInt(frame) * BigInt(rate.d) * 1000n;
  const den = BigInt(rate.n);
  return (2n * num + den) / (2n * den);
}

describe("totalActiveSourceSegments", () => {
  describe("in the frame format", () => {
    it("adds the frame count of each segment, not the tick lengths", () => {
      // Nine segments from frame 30 + 120k to frame 49 + 120k at 59.94 fps, with each frame
      // start stored rounded to the millisecond. Each segment is 19 frames, and the export
      // writes 171. Each stored length is 316 ms, so the sum of the lengths, 2844 ms, is
      // only 170.47 frames.
      const segments = Array.from({ length: 9 }, (_, k) =>
        segment(
          `s${k}`,
          "src",
          storedMs(30 + 120 * k, fps5994),
          storedMs(49 + 120 * k, fps5994),
        ),
      );
      expect(segments[0]).toMatchObject({ inPts: "501", outPts: "817" });
      const display = framesDisplay(fps5994);
      const total = totalActiveSourceSegments(segments, "src", source(), display);
      expect(total).toBe(171n);

      // One tick sum rounded once would be one frame short.
      const ticks = segments.reduce(
        (sum, s) => sum + BigInt(s.outPts) - BigInt(s.inPts),
        0n,
      );
      expect(ticks).toBe(2844n);
      expect((2n * ticks * 60_000n + 1_001_000n) / (2n * 1_001_000n)).toBe(170n);

      // Frame 171 at 59.94 fps is frame 51 of second 2.
      expect(formatSegmentTotal(total, display)).toBe("00:00:02:51");
    });

    it("counts J(out) - J(in) with the frame index of the playhead timecode", () => {
      const display = framesDisplay(fps2997);
      const start = 1000n;
      const segments: Segment[] = [];
      let expected = 0n;
      for (let a = 0; a < 60; a += 7) {
        const b = a + 1 + (a % 5);
        const inPts = start + storedMs(a, fps2997);
        const outPts = start + storedMs(b, fps2997);
        segments.push(segment(`s${a}`, "src", inPts, outPts));
        const j = (pts: bigint) =>
          frameIndexOfTicks(pts - start, ms, fps2997, ms) ?? -1n;
        expected += j(outPts) - j(inPts);
        // Each stored frame start names its own frame, so each segment is b - a frames.
        expect(j(outPts) - j(inPts)).toBe(BigInt(b - a));
      }
      expect(
        totalActiveSourceSegments(segments, "src", source(String(start)), display),
      ).toBe(expected);
    });

    it("counts from the start PTS of the source", () => {
      const display = framesDisplay(fps25);
      // 40 ms per frame. From a start of 20 ms, [60, 100) holds frame 1 only.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "60", "100")],
          "src",
          source("20"),
          display,
        ),
      ).toBe(1n);
      // From a start of 0, the same PTS pair is frame 1 to frame 2, also one frame.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "60", "100")],
          "src",
          source("0"),
          display,
        ),
      ).toBe(1n);
      // From a start of 0, [70, 90) crosses the start of frame 2 at 80 ms. From a start of
      // 20, it is 50 to 70 ms and lies inside frame 1.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "70", "90")],
          "src",
          source("0"),
          display,
        ),
      ).toBe(1n);
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "70", "90")],
          "src",
          source("20"),
          display,
        ),
      ).toBe(0n);
    });

    it("counts a PTS before the start with the signed index of its timecode", () => {
      // From a start of 100 ms, [0, 400) is -100 to 300 ms. Its In timecode is
      // -00:00:00:02 and its Out timecode 00:00:00:07, so the segment tooltip shows 9 frames.
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "0", "400")],
          "src",
          source("100"),
          framesDisplay(fps25),
        ),
      ).toBe(9n);
    });

    it("reads the segments of the active source only", () => {
      const segments = [
        segment("a", "s1", "0", "400"),
        segment("b", "s2", "x", "y"),
        segment("c", "s1", "1000", "1200"),
      ];
      expect(
        totalActiveSourceSegments(segments, "s1", source(), framesDisplay(fps25)),
      ).toBe(15n);
      expect(
        totalActiveSourceSegments(segments, null, source(), framesDisplay(fps25)),
      ).toBe(0n);
    });

    it("returns null when the total is not known", () => {
      const display = framesDisplay(fps25);
      const valid = [segment("a", "src", "0", "400")];
      expect(totalActiveSourceSegments(valid, "src", null, display)).toBeNull();
      expect(totalActiveSourceSegments(valid, "src", source(null), display)).toBeNull();
      expect(totalActiveSourceSegments(valid, "src", source("x"), display)).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "src", "0", "400"), segment("b", "src", "500", "500")],
          "src",
          source(),
          display,
        ),
      ).toBeNull();
    });
  });

  describe("in the millisecond format", () => {
    const display = MILLISECONDS_TIMECODE_DISPLAY;

    it("adds the milliseconds of the segments of the active source only", () => {
      const segments = [
        segment("a", "s1", "100", "400"),
        segment("b", "s2", "0", "999999"),
        segment("c", "s1", "1000", "1250"),
      ];
      expect(totalActiveSourceSegments(segments, "s1", source(), display)).toBe(550n);
      expect(totalActiveSourceSegments(segments, "s2", source(), display)).toBe(
        999_999n,
      );
    });

    it("counts from the start PTS, and needs one, as the frame format does", () => {
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "107", "407")],
          "s",
          source("7"),
          display,
        ),
      ).toBe(300n);
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "100", "400")],
          "s",
          source(null),
          display,
        ),
      ).toBeNull();
    });

    it("counts Out minus In on the millisecond grid of the playhead", () => {
      // 30 fps with a 1/600 time base: frames 1, 2 and 3 start at 20, 40 and 60 ticks, which
      // the playhead shows as 0.033, 0.067 and 0.100. Frame 1 lasts 34 ms and frame 2 33 ms,
      // although each tick length is 33.33 ms.
      const tb600: SegmentTotalSource = {
        videoTimeBase: { n: 1, d: 600 },
        videoStartPts: "0" as Pts,
      };
      expect(
        totalActiveSourceSegments([segment("a", "s", "20", "40")], "s", tb600, display),
      ).toBe(34n);
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "20", "40"), segment("b", "s", "40", "60")],
          "s",
          tb600,
          display,
        ),
      ).toBe(67n);
      expect(formatSegmentTotal(34n, display)).toBe("00:00:00.034");
    });

    it("returns zero with no segment of the active source, or no active source", () => {
      const segments = [segment("a", "s1", "0", "10")];
      expect(totalActiveSourceSegments([], "s1", source(), display)).toBe(0n);
      expect(totalActiveSourceSegments(segments, "s2", source(), display)).toBe(0n);
      expect(totalActiveSourceSegments(segments, null, source(), display)).toBe(0n);
    });

    it("returns null for an end that the millisecond timecode cannot show", () => {
      // Beyond the safe integer range, the playhead timecode cannot convert the ticks either.
      const big = "9007199254740993";
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "0", big)],
          "s",
          source(),
          display,
        ),
      ).toBeNull();
    });

    it("returns null when the total is not known", () => {
      expect(
        totalActiveSourceSegments([segment("a", "s", "0", "10")], "s", null, display),
      ).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "0", "10"), segment("b", "s", "20", "20")],
          "s",
          source(),
          display,
        ),
      ).toBeNull();
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "x", "10")],
          "s",
          source(),
          display,
        ),
      ).toBeNull();
      // A malformed segment of another source does not count.
      expect(
        totalActiveSourceSegments(
          [segment("a", "s", "0", "10"), segment("b", "t", "x", "10")],
          "s",
          source(),
          display,
        ),
      ).toBe(10n);
    });
  });
});

describe("formatSegmentTotal", () => {
  it("writes a frame total with the FF rule and a millisecond total in full", () => {
    expect(formatSegmentTotal(251n, framesDisplay(fps25))).toBe("00:00:10:01");
    expect(formatSegmentTotal(0n, framesDisplay(fps25))).toBe("00:00:00:00");
    expect(formatSegmentTotal(10_040n, MILLISECONDS_TIMECODE_DISPLAY)).toBe(
      "00:00:10.040",
    );
  });

  it("shows the placeholder of the format for a total that is not known", () => {
    expect(formatSegmentTotal(null, framesDisplay(fps25))).toBe("--:--:--:--");
    expect(formatSegmentTotal(null, MILLISECONDS_TIMECODE_DISPLAY)).toBe(
      "--:--:--.---",
    );
  });

  it("formats the value of totalActiveSourceSegments in the display that produced it", () => {
    const segments = [segment("a", "s", "0", "10040")];
    for (const display of [framesDisplay(fps25), MILLISECONDS_TIMECODE_DISPLAY]) {
      const total = totalActiveSourceSegments(segments, "s", source(), display);
      expect(formatSegmentTotal(total, display)).toBe(
        display.format === "frames" ? "00:00:10:01" : "00:00:10.040",
      );
    }
  });
});

describe("selectActiveSourceSegmentCount", () => {
  it("counts the segments of the active source only", () => {
    const segments = [
      segment("a", "s1", "0", "10"),
      segment("b", "s2", "0", "10"),
      segment("c", "s1", "20", "30"),
    ];
    expect(selectActiveSourceSegmentCount({ segments, sourceId: "s1" })).toBe(2);
    expect(selectActiveSourceSegmentCount({ segments, sourceId: "s2" })).toBe(1);
  });

  it("counts nothing with no active source or no segment", () => {
    expect(
      selectActiveSourceSegmentCount({
        segments: [segment("a", "s1", "0", "10")],
        sourceId: null,
      }),
    ).toBe(0);
    expect(selectActiveSourceSegmentCount({ segments: [], sourceId: "s1" })).toBe(0);
  });
});
