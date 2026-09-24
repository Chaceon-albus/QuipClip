import { describe, expect, it } from "vitest";
import {
  formatFrameTimecode,
  formatMillisecondsTimecode,
  MILLISECONDS_TIMECODE_DISPLAY,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { Rational } from "@/types/project";
import {
  countRulerEdgeAnchors,
  rulerLabelWidthPx,
  type RulerLabelAnchor,
} from "./rulerLabel";
import {
  calculateMinorTickPeriod,
  calculateMinRulerTickSpacingPx,
  calculateRulerScale,
  generateRulerTicks,
  MAX_QUANTIZED_RULER_TICK_COUNT,
  MIN_RULER_MINOR_TICK_SPACING_PX,
  MIN_RULER_TICK_SPACING_PX,
  RULER_LABEL_GAP_PX,
  RULER_SLOW_FRAME_STEP_LADDER,
  RULER_STEP_LADDER_MILLISECONDS,
  rulerFrameStepLadder,
  type RulerStep,
  type RulerTick,
} from "./timelineMarkers";

const MS = MILLISECONDS_TIMECODE_DISPLAY;

function frames(
  n: number,
  d = 1,
  videoTimeBase: Rational | null = null,
): TimecodeDisplay {
  return { format: "frames", rate: { n, d }, videoTimeBase };
}

const FPS_0_3 = frames(3, 10);
const FPS_0_5 = frames(1, 2);
const FPS_1_5 = frames(3, 2);
const FPS_24 = frames(24);
const FPS_25 = frames(25);
const FPS_30 = frames(30);
const FPS_60 = frames(60);
const FPS_23_976 = frames(24000, 1001);
const FPS_29_97 = frames(30000, 1001);
const FPS_59_94 = frames(60000, 1001);
const FPS_120 = frames(120);

const ms = (value: number): RulerStep => ({ unit: "milliseconds", value });
const frameStep = (value: number): RulerStep => ({ unit: "frames", value });

/** The ticks of the scale that the ruler would choose. */
function ticksFor(
  duration: number,
  laneWidthPx: number,
  display: TimecodeDisplay,
): RulerTick[] {
  const scale = calculateRulerScale(duration, laneWidthPx, display);
  return generateRulerTicks(duration, display, scale?.major ?? null);
}

/** The label boxes in lane pixels, placed as TimelineRuler places them. */
function labelBoxes(ticks: readonly RulerTick[], laneWidthPx: number) {
  const anchors = countRulerEdgeAnchors(ticks, laneWidthPx);
  return ticks.map((tick, index) => {
    const anchor: RulerLabelAnchor =
      index < anchors.start
        ? "start"
        : index >= ticks.length - anchors.end
          ? "end"
          : "center";
    const px = (tick.percent / 100) * laneWidthPx;
    const width = rulerLabelWidthPx(tick.label.length);
    const left =
      anchor === "start" ? px : anchor === "end" ? px - width : px - width / 2;
    return { left, right: left + width, anchor };
  });
}

describe("Quantized Ruler Scale", () => {
  describe("Spacing constants", () => {
    it("holds one and a half label widths and the gap", () => {
      expect(RULER_LABEL_GAP_PX).toBe(8);
      // MM:SS, 30 px: ceil(45) + 8.
      expect(MIN_RULER_TICK_SPACING_PX).toBe(53);
      expect(calculateMinRulerTickSpacingPx(5)).toBe(53);
      // H:MM:SS and MM:SS.m, 42 px: ceil(63) + 8.
      expect(calculateMinRulerTickSpacingPx(7)).toBe(71);
      // MM:SS:FF and MM:SS.mm, 48 px: ceil(72) + 8.
      expect(calculateMinRulerTickSpacingPx(8)).toBe(80);
      // MM:SS:FFF at 120 fps, 54 px: ceil(81) + 8.
      expect(calculateMinRulerTickSpacingPx(9)).toBe(89);
      expect(MIN_RULER_MINOR_TICK_SPACING_PX).toBe(12);
    });

    it("keeps the millisecond ladder in ascending order", () => {
      for (let i = 1; i < RULER_STEP_LADDER_MILLISECONDS.length; i++) {
        expect(RULER_STEP_LADDER_MILLISECONDS[i]).toBeGreaterThan(
          RULER_STEP_LADDER_MILLISECONDS[i - 1],
        );
      }
    });
  });

  describe("rulerFrameStepLadder", () => {
    it("lists the divisors of the frames in one second, below one second", () => {
      expect(rulerFrameStepLadder({ n: 30, d: 1 })).toEqual([1, 2, 3, 5, 6, 10, 15]);
      expect(rulerFrameStepLadder({ n: 24, d: 1 })).toEqual([1, 2, 3, 4, 6, 8, 12]);
      expect(rulerFrameStepLadder({ n: 25, d: 1 })).toEqual([1, 5]);
      expect(rulerFrameStepLadder({ n: 50, d: 1 })).toEqual([1, 2, 5, 10, 25]);
    });

    it("uses ceil(rate) for a rate that is not a whole number", () => {
      expect(rulerFrameStepLadder({ n: 30000, d: 1001 })).toEqual([
        1, 2, 3, 5, 6, 10, 15,
      ]);
      expect(rulerFrameStepLadder({ n: 24000, d: 1001 })).toEqual([
        1, 2, 3, 4, 6, 8, 12,
      ]);
      expect(rulerFrameStepLadder({ n: 3, d: 2 })).toEqual([1]);
    });

    it("has no frame steps below two frames per second, above 1000, or for an invalid rate", () => {
      expect(rulerFrameStepLadder({ n: 1, d: 1 })).toEqual([]);
      expect(rulerFrameStepLadder({ n: 1, d: 2 })).toEqual([]);
      expect(rulerFrameStepLadder({ n: 1001, d: 1 })).toEqual([]);
      expect(rulerFrameStepLadder({ n: 0, d: 1 })).toEqual([]);
      expect(rulerFrameStepLadder({ n: 30, d: 0 })).toEqual([]);
      expect(rulerFrameStepLadder({ n: 2.5, d: 1 })).toEqual([]);
    });
  });

  describe("calculateRulerScale in the millisecond format", () => {
    it("picks expected ladder steps for a 3-hour source across lane widths", () => {
      const threeHours = 10800;
      // H:MM:SS needs 71 px. At 804 px, 900 s gives 67 px, so the step is 1800 s.
      expect(calculateRulerScale(threeHours, 804, MS)).toEqual({
        major: ms(1_800_000),
        minorSeconds: 300,
      });
      // At 1344 px, 600 s gives 74.7 px. 120 s minors give 14.9 px.
      expect(calculateRulerScale(threeHours, 1344, MS)).toEqual({
        major: ms(600_000),
        minorSeconds: 120,
      });
      // At 13440 px, 60 s gives 74.7 px.
      expect(calculateRulerScale(threeHours, 13440, MS)).toEqual({
        major: ms(60_000),
        minorSeconds: 10,
      });
      // At 99904 px, 10 s gives 92.5 px, but the 400-tick cap forces 30 s (361 ticks).
      expect(calculateRulerScale(threeHours, 99904, MS)).toEqual({
        major: ms(30_000),
        minorSeconds: 2,
      });
    });

    it("changes the step exactly at the spacing that the labels need", () => {
      // 600 s for 3 h needs 71 * 10800 / 600 = 1278 px.
      expect(calculateRulerScale(10800, 1278, MS)?.major).toEqual(ms(600_000));
      expect(calculateRulerScale(10800, 1277, MS)?.major).toEqual(ms(900_000));
    });

    it("produces equal steps for two lane widths inside the same rung", () => {
      // 300 s for 3 h needs 71 * 10800 / 300 = 2556 px, so 1344 px and 1400 px both take 600 s.
      const stepA = calculateRulerScale(10800, 1344, MS)?.major;
      const stepB = calculateRulerScale(10800, 1400, MS)?.major;
      expect(stepA).toEqual(ms(600_000));
      expect(stepB).toEqual(stepA);
    });

    it("uses the shorter MM:SS labels of a source below one hour", () => {
      // MM:SS needs 53 px. At 1344 px for 5 min, 15 s gives 67.2 px and 10 s gives 44.8 px.
      expect(calculateRulerScale(300, 1344, MS)).toEqual({
        major: ms(15_000),
        minorSeconds: 5,
      });
    });

    it("picks sub-second steps with fractional labels at a high zoom", () => {
      // 200 px/s: MM:SS.m needs 71 px, so 500 ms (100 px) and not 200 ms (40 px).
      expect(calculateRulerScale(20, 4000, MS)).toEqual({
        major: ms(500),
        minorSeconds: 0.1,
      });
    });

    it("picks steps of milliseconds for a source shorter than one second", () => {
      // 2688 px/s: MM:SS.mm needs 80 px, so 50 ms (134.4 px) and not 20 ms (53.8 px).
      expect(calculateRulerScale(0.5, 1344, MS)?.major).toEqual(ms(50));
      // 10000 px/s: 10 ms gives 100 px.
      expect(calculateRulerScale(0.1, 1000, MS)?.major).toEqual(ms(10));
    });

    it("lets the tick cap take a larger step at the maximum zoom", () => {
      // 5 min at 200 px/s: 500 ms gives 601 ticks, so the step is 1 s.
      expect(calculateRulerScale(300, 60000, MS)).toEqual({
        major: ms(1000),
        minorSeconds: 0.1,
      });
    });
  });

  describe("calculateRulerScale in the frame format", () => {
    it("picks a frame step at a high zoom", () => {
      // 30 fps at 200 px/s: MM:SS:FF needs 80 px. 10 frames give 66.7 px, 15 give 100 px.
      // 3-frame minors give 20 px; 1 frame gives 6.7 px.
      expect(calculateRulerScale(20, 4000, FPS_30)).toEqual({
        major: frameStep(15),
        minorSeconds: 0.1,
      });
    });

    it("has no frame step between 5 frames and 1 s at 25 fps", () => {
      // 5 frames give 40 px at 200 px/s, so the step is 1 s with 5-frame minors.
      expect(calculateRulerScale(20, 4000, FPS_25)).toEqual({
        major: ms(1000),
        minorSeconds: 0.2,
      });
    });

    it("measures the shorter last frame step of a second at 29.97 fps", () => {
      // 15 frames, but the shortest interval is 14 frames: 0.467 s, 93.4 px at 200 px/s.
      const scale = calculateRulerScale(40, 8000, FPS_29_97);
      expect(scale?.major).toEqual(frameStep(15));
      expect(scale?.minorSeconds).toBeCloseTo((3 * 1001) / 30000, 12);
      // 10 frames give 66.7 px, and the shortest interval, 9 frames, gives 60 px.
      expect(calculateRulerScale(40, 12000, FPS_29_97)?.major).toEqual(frameStep(10));
    });

    it("uses the whole-second steps of the millisecond format for a long source", () => {
      expect(calculateRulerScale(10800, 1344, FPS_25)?.major).toEqual(ms(600_000));
      expect(calculateRulerScale(10800, 99904, FPS_25)?.major).toEqual(ms(30_000));
    });

    it("never picks a frame step in the millisecond format", () => {
      for (const width of [804, 4000, 20000, 99904]) {
        expect(calculateRulerScale(20, width, MS)?.major.unit).toBe("milliseconds");
      }
    });

    it("never picks a sub-second millisecond step in the frame format", () => {
      for (const width of [804, 4000, 20000, 99904]) {
        const major = calculateRulerScale(20, width, FPS_25)?.major;
        expect(major?.unit === "frames" || (major?.value ?? 0) % 1000 === 0).toBe(true);
      }
    });

    it("picks whole-frame minor steps below one second", () => {
      // 1 s at 200 px/s, 30 fps: 1 frame gives 6.7 px, 2 frames give 13.3 px.
      const scale = calculateRulerScale(300, 60000, FPS_30);
      expect(scale?.major).toEqual(ms(1000));
      expect(scale?.minorSeconds).toBeCloseTo(2 / 30, 12);
    });

    it("picks whole-frame minor steps under a 1 s major step at 29.97 fps", () => {
      // 100 px/s: 15 frames give 46.7 px in their 14-frame interval, so the major step is
      // 1 s. 5 frames give 16.7 px.
      const scale = calculateRulerScale(100, 10000, FPS_29_97);
      expect(scale?.major).toEqual(ms(1000));
      expect(scale?.minorSeconds).toBeCloseTo((5 * 1001) / 30000, 12);
    });

    it("draws frame minors under a longer major step at 29.97 fps while a frame is 1 px or wider", () => {
      // 40 px/s: the major step is 2 s, and a frame is 1.33 px. 10 frames give 13.3 px.
      const at40 = calculateRulerScale(100, 4000, FPS_29_97);
      expect(at40?.major).toEqual(ms(2000));
      expect(at40?.minorSeconds).toBeCloseTo((10 * 1001) / 30000, 12);
      // 30 px/s: 10 frames give 10 px, 15 frames give 15 px. A frame is 1.0 px, so a 1 s
      // minor is not a candidate.
      const at30 = calculateRulerScale(100, 3000, FPS_29_97);
      expect(at30?.major).toEqual(ms(2000));
      expect(at30?.minorSeconds).toBeCloseTo((15 * 1001) / 30000, 12);
      // At a whole-number rate every second holds the same frames, so 10 frames stay.
      const integer = calculateRulerScale(100, 4000, FPS_30);
      expect(integer?.major).toEqual(ms(2000));
      expect(integer?.minorSeconds).toBeCloseTo(10 / 30, 12);
    });

    it("draws whole-second minors at 29.97 fps once a frame is narrower than 1 px", () => {
      // 20 px/s: the major step is 5 s, and a frame is 0.67 px. 15 frames give 10 px, and
      // 1 s minors give 20 px.
      const scale = calculateRulerScale(100, 2000, FPS_29_97);
      expect(scale?.major).toEqual(ms(5000));
      expect(scale?.minorSeconds).toBe(1);
    });

    it("draws 1-frame minors, not 1 s minors, under a 2 s major step at 1.5 fps", () => {
      // 100 px/s: 1 frame gives 66.7 px, below the 80 px of MM:SS:FF, and 1 s gives 33.3 px
      // in its shortest interval, so the major step is 2 s. The tick of second 0 lies at
      // 0 s, and a 1 s minor after it would sit at 1 s, 0.33 s before frame 2 starts
      // second 1. A 1-frame minor adds 0.67 s to a frame start and lies on frames 1 and 2.
      const scale = calculateRulerScale(100, 10000, FPS_1_5);
      expect(scale?.major).toEqual(ms(2000));
      expect(scale?.minorSeconds).toBeCloseTo(2 / 3, 12);
      // The ticks lie on the first frame of each even second.
      const ticks = generateRulerTicks(100, FPS_1_5, ms(2000));
      expect(ticks.slice(0, 3).map((tick) => [tick.label, tick.seconds])).toEqual([
        ["00:00", 0],
        ["00:02", 2],
        ["00:04", 4],
      ]);
    });

    it("puts every minor tick on a frame start while a frame is 1 px or wider", () => {
      let checked = 0;
      for (const display of [FPS_1_5, FPS_23_976, FPS_29_97, FPS_59_94]) {
        if (display.format !== "frames") continue;
        const { n, d } = display.rate;
        for (const width of [804, 1344, 2000, 3000, 4000, 8000, 20000]) {
          const scale = calculateRulerScale(100, width, display);
          const minor = scale?.minorSeconds ?? null;
          if (scale === null || minor === null || (d / n) * (width / 100) < 1) continue;
          for (const tick of generateRulerTicks(100, display, scale.major)) {
            const period = calculateMinorTickPeriod(minor, tick.intervalSeconds);
            if (period === null) continue;
            const step = (parseFloat(period) / 100) * tick.intervalSeconds;
            for (let at = step; at < tick.intervalSeconds - 1e-9; at += step) {
              const frame = ((tick.seconds + at) * n) / d;
              expect(Math.abs(frame - Math.round(frame))).toBeLessThan(1e-3);
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    });
  });

  describe("Indeterminate and Invalid Inputs", () => {
    it("returns null for invalid, non-positive, or non-finite inputs", () => {
      for (const width of [0, -10, NaN, Infinity, -Infinity]) {
        expect(calculateRulerScale(100, width, MS)).toBeNull();
      }
      for (const duration of [null, undefined, 0, -10, NaN, Infinity, -Infinity]) {
        expect(calculateRulerScale(duration, 1344, MS)).toBeNull();
      }
    });
  });
});

describe("generateRulerTicks", () => {
  describe("Millisecond steps", () => {
    it("generates whole-second ticks with MM:SS labels and their intervals", () => {
      const ticks = generateRulerTicks(10, MS, ms(2000));
      expect(ticks).toHaveLength(6);
      expect(ticks[0]).toEqual({
        label: "00:00",
        seconds: 0,
        percent: 0,
        left: "0%",
        width: "20%",
        intervalSeconds: 2,
      });
      expect(ticks[5]).toEqual({
        label: "00:10",
        seconds: 10,
        percent: 100,
        left: "100%",
        width: "0%",
        intervalSeconds: 0,
      });
      expect(ticks.map((tick) => tick.label)).toEqual([
        "00:00",
        "00:02",
        "00:04",
        "00:06",
        "00:08",
        "00:10",
      ]);
    });

    it("generates sub-second ticks with a fraction cut to the step", () => {
      const ticks = generateRulerTicks(1, MS, ms(200));
      expect(ticks.map((tick) => tick.label)).toEqual([
        "00:00.0",
        "00:00.2",
        "00:00.4",
        "00:00.6",
        "00:00.8",
        "00:01.0",
      ]);
      expect(generateRulerTicks(0.1, MS, ms(50)).map((tick) => tick.label)).toEqual([
        "00:00.00",
        "00:00.05",
        "00:00.10",
      ]);
    });

    it("shows the hours for a source of one hour or longer", () => {
      const ticks = generateRulerTicks(10800, MS, ms(1_800_000));
      expect(ticks.map((tick) => tick.label)).toEqual([
        "0:00:00",
        "0:30:00",
        "1:00:00",
        "1:30:00",
        "2:00:00",
        "2:30:00",
        "3:00:00",
      ]);
      expect(generateRulerTicks(3600, MS, ms(1_800_000))[2].label).toBe("1:00:00");
      expect(generateRulerTicks(3599, MS, ms(1_800_000))[1].label).toBe("30:00");
    });

    it("ends before the source extent when it is not a whole multiple", () => {
      const ticks = generateRulerTicks(10000, MS, ms(900_000));
      const last = ticks[ticks.length - 1];
      expect(last.seconds).toBe(9900);
      expect(last.percent).toBe(99);
      expect(last.left).toBe("99%");
      expect(last.width).toBe("1%");
      expect(last.intervalSeconds).toBe(100);
    });

    it("names the same time as the millisecond timecode", () => {
      for (const [duration, step] of [
        [70, 500],
        [70, 100],
        [3, 20],
        [0.5, 5],
        [4000, 600_000],
      ] as const) {
        for (const tick of generateRulerTicks(duration, MS, ms(step))) {
          const full = formatMillisecondsTimecode(tick.seconds);
          const shown = duration >= 3600 ? `0${tick.label}` : `00:${tick.label}`;
          expect(full.startsWith(shown)).toBe(true);
        }
      }
    });
  });

  describe("Frame steps", () => {
    it("generates frame ticks with MM:SS:FF labels at an integer rate", () => {
      const ticks = generateRulerTicks(1, FPS_30, frameStep(15));
      expect(ticks.map((tick) => [tick.label, tick.seconds])).toEqual([
        ["00:00:00", 0],
        ["00:00:15", 0.5],
        ["00:01:00", 1],
      ]);
      expect(ticks[0].width).toBe("50%");
    });

    it("starts the frame count again at the first frame of each second at 29.97 fps", () => {
      const ticks = generateRulerTicks(40, FPS_29_97, frameStep(15));
      const second33 = ticks.findIndex((tick) => tick.label === "00:33:00");
      expect(ticks.slice(second33, second33 + 3).map((tick) => tick.label)).toEqual([
        "00:33:00",
        "00:33:15",
        "00:34:00",
      ]);
      // Second 33 starts at frame ceil(33 * 29.97) = 990 and holds 29 frames, so the
      // interval from 00:33:15 to 00:34:00 is 14 frames.
      expect(ticks[second33].seconds).toBeCloseTo((990 * 1001) / 30000, 12);
      expect(ticks[second33 + 1].intervalSeconds).toBeCloseTo((14 * 1001) / 30000, 12);
      expect(ticks[second33 + 2].seconds).toBeCloseTo((1019 * 1001) / 30000, 12);
    });

    it("puts a whole-second tick on the first frame of that second", () => {
      const ticks = generateRulerTicks(40, FPS_29_97, ms(1000));
      expect(ticks[33].label).toBe("00:33");
      expect(ticks[33].seconds).toBeCloseTo((990 * 1001) / 30000, 12);
      // The first frame of second 40 starts after 40 s, so it has no tick.
      expect(ticks[ticks.length - 1].label).toBe("00:39");
      // At an integer rate, the tick is on the second itself.
      expect(generateRulerTicks(40, FPS_25, ms(1000))[33].seconds).toBe(33);
    });

    it("puts the ticks on frame starts below one frame per second", () => {
      // 0.5 fps: frame f starts at 2f s, and no frame starts in an odd second.
      const ticks = generateRulerTicks(10, FPS_0_5, frameStep(1));
      expect(ticks.map((tick) => [tick.label, tick.seconds])).toEqual([
        ["00:00", 0],
        ["00:02", 2],
        ["00:04", 4],
        ["00:06", 6],
        ["00:08", 8],
        ["00:10", 10],
      ]);
      // 0.3 fps: frame f starts at 10f/3 s, and the label shows its whole seconds.
      expect(
        generateRulerTicks(40, FPS_0_3, frameStep(2)).map((tick) => tick.label),
      ).toEqual(["00:00", "00:06", "00:13", "00:20", "00:26", "00:33", "00:40"]);
      expect(generateRulerTicks(100, FPS_0_5, frameStep(5))[1].seconds).toBe(10);
    });

    it("chooses every k-th frame below one frame per second", () => {
      // 13.4 px/s at 0.3 fps: 1 frame is 3.33 s and 44.7 px, below the 53 px of MM:SS, so
      // the step is 2 frames (89.3 px) with 1-frame minors.
      const scale = calculateRulerScale(60, 804, FPS_0_3);
      expect(scale?.major).toEqual(frameStep(2));
      expect(scale?.minorSeconds).toBeCloseTo(10 / 3, 12);
      // 200 px/s at 0.5 fps: 1 frame is 400 px.
      expect(calculateRulerScale(20, 4000, FPS_0_5)).toEqual({
        major: frameStep(1),
        minorSeconds: null,
      });
      // A 3-hour source at zoom 1: H:MM:SS needs 71 px, so 500 frames (1000 s, 74.4 px).
      expect(calculateRulerScale(10800, 804, FPS_0_5)?.major).toEqual(frameStep(500));
    });

    it("uses no millisecond step below one frame per second", () => {
      for (const width of [804, 4000, 20000, 99904]) {
        expect(calculateRulerScale(100, width, FPS_0_5)?.major.unit).toBe("frames");
      }
      expect(generateRulerTicks(10, FPS_0_5, ms(1000))).toEqual([]);
      expect(generateRulerTicks(10, FPS_0_5, ms(500))).toEqual([]);
    });

    it("keeps the frame scheme at exactly one frame per second", () => {
      const ticks = ticksFor(60, 804, frames(1));
      expect(ticks[1].label).toBe("00:05");
      expect(ticks[1].seconds).toBe(5);
      expect(formatFrameTimecode(ticks[1].seconds, { n: 1, d: 1 })).toBe("00:00:05:00");
    });

    it("writes three frame digits above 100 fps", () => {
      const ticks = generateRulerTicks(1, FPS_120, frameStep(40));
      expect(ticks.map((tick) => tick.label)).toEqual([
        "00:00:000",
        "00:00:040",
        "00:00:080",
        "00:01:000",
      ]);
    });

    it("names the frame that the preview timecode shows at each tick", () => {
      const displays = [
        FPS_0_3,
        FPS_0_5,
        frames(1),
        FPS_1_5,
        FPS_23_976,
        FPS_24,
        FPS_25,
        FPS_29_97,
        FPS_30,
        FPS_59_94,
        FPS_60,
      ];
      const timeBases: (Rational | null)[] = [
        null,
        { n: 1, d: 1000 },
        { n: 1, d: 90000 },
      ];
      for (const display of displays) {
        if (display.format !== "frames") continue;
        const slow = display.rate.n < display.rate.d;
        // Below one frame per second the steps are whole frames, each longer than one
        // second, and the preview shows every tick with FF 00.
        const steps = slow
          ? RULER_SLOW_FRAME_STEP_LADDER.slice(0, 4).map(frameStep)
          : [
              ...rulerFrameStepLadder(display.rate).map(frameStep),
              ms(1000),
              ms(2000),
              ms(10_000),
            ];
        // The steps that the ruler chooses from zoom 1 to the maximum zoom.
        for (const width of [804, 2000, 14000]) {
          const chosen = calculateRulerScale(70, width, display)?.major;
          if (chosen) steps.push(chosen);
        }
        for (const step of steps) {
          const withFF = step.unit === "frames" && !slow;
          for (const videoTimeBase of timeBases) {
            const withTimeBase: TimecodeDisplay = { ...display, videoTimeBase };
            const ticks = generateRulerTicks(70, withTimeBase, step);
            expect(ticks.length).toBeGreaterThan(1);
            for (const tick of ticks) {
              const preview = formatFrameTimecode(
                tick.seconds,
                display.rate,
                videoTimeBase,
              );
              expect(preview).toBe(withFF ? `00:${tick.label}` : `00:${tick.label}:00`);
            }
          }
        }
      }
    });

    it("names the preview frame with H:MM:SS on a source of one hour or longer", () => {
      /** The preview form of a label: the hours padded to two digits. */
      const padHours = (label: string) => {
        const [hours, ...rest] = label.split(":");
        return [hours.padStart(2, "0"), ...rest].join(":");
      };
      const cases: [TimecodeDisplay, number, RulerStep[]][] = [
        // 0.3 fps over 10 h: 10,800 frames.
        [FPS_0_3, 36_000, [100, 500, 1000, 2000].map(frameStep)],
        // 29.97 fps over 2 h.
        [FPS_29_97, 7200, [frameStep(15), ms(10_000), ms(60_000), ms(600_000)]],
      ];
      for (const [display, duration, explicitSteps] of cases) {
        if (display.format !== "frames") continue;
        const slow = display.rate.n < display.rate.d;
        const steps = [...explicitSteps];
        for (const width of [804, 13440, 99904]) {
          const chosen = calculateRulerScale(duration, width, display)?.major;
          if (chosen) steps.push(chosen);
        }
        let hoursSeen = 0;
        for (const step of steps) {
          const withFF = step.unit === "frames" && !slow;
          for (const videoTimeBase of [null, { n: 1, d: 1000 }]) {
            const ticks = generateRulerTicks(
              duration,
              { ...display, videoTimeBase },
              step,
            );
            expect(ticks.length).toBeGreaterThan(1);
            for (const tick of ticks) {
              // Every label has the H:MM:SS shape, with or without :FF.
              expect(tick.label).toMatch(
                withFF ? /^\d+:\d\d:\d\d:\d\d$/ : /^\d+:\d\d:\d\d$/,
              );
              const preview = formatFrameTimecode(
                tick.seconds,
                display.rate,
                videoTimeBase,
              );
              expect(preview).toBe(
                withFF ? padHours(tick.label) : `${padHours(tick.label)}:00`,
              );
              hoursSeen = Math.max(hoursSeen, Number(tick.label.split(":")[0]));
            }
          }
        }
        // The steps reach past the first hour.
        expect(hoursSeen).toBeGreaterThanOrEqual(1);
      }
    });

    it("returns no ticks for a frame step without a frame rate", () => {
      expect(generateRulerTicks(10, MS, frameStep(5))).toEqual([]);
      expect(generateRulerTicks(10, frames(0), frameStep(5))).toEqual([]);
    });
  });

  describe("Tick invariants", () => {
    const displays = [
      MS,
      FPS_0_3,
      FPS_0_5,
      FPS_1_5,
      FPS_24,
      FPS_25,
      FPS_29_97,
      FPS_120,
    ];
    const durations = [0.5, 3, 20, 59.9, 100, 300, 3599, 3600, 10800, 36000];

    /**
     * Lane widths from zoom 1 in a 900 px panel (804 px) to the maximum zoom: 200 px/s, at
     * most 99,904 px, and never narrower than the lane at zoom 1.
     */
    function laneWidthsFor(duration: number): number[] {
      const maxLane = Math.max(804, Math.min(200 * duration, 99904));
      return [804, 1344, 5000, 20000, maxLane].filter((width) => width <= maxLane);
    }

    it("covers every duration with at least one lane width", () => {
      for (const duration of durations) {
        expect(laneWidthsFor(duration).length).toBeGreaterThan(0);
      }
    });

    it("places the first tick at 0% with a zero label", () => {
      expect(ticksFor(10800, 1344, MS)[0]).toEqual({
        label: "0:00:00",
        seconds: 0,
        percent: 0,
        left: "0%",
        width: "5.5556%",
        intervalSeconds: 600,
      });
      expect(ticksFor(20, 4000, FPS_30)[0].label).toBe("00:00:00");
    });

    it("keeps ticks inside the source, strictly increasing, and within the cap", () => {
      for (const display of displays) {
        for (const duration of durations) {
          for (const width of laneWidthsFor(duration)) {
            const ticks = ticksFor(duration, width, display);
            expect(ticks.length).toBeGreaterThan(0);
            expect(ticks.length).toBeLessThanOrEqual(MAX_QUANTIZED_RULER_TICK_COUNT);
            for (let i = 1; i < ticks.length; i++) {
              expect(ticks[i].percent).toBeGreaterThan(ticks[i - 1].percent);
            }
            expect(ticks[ticks.length - 1].seconds).toBeLessThanOrEqual(duration);
          }
        }
      }
    });

    it("makes each interval end where the next one starts", () => {
      for (const display of displays) {
        const ticks = ticksFor(59.9, 5000, display);
        for (let i = 0; i < ticks.length; i++) {
          const end = parseFloat(ticks[i].left) + parseFloat(ticks[i].width);
          const next = i + 1 < ticks.length ? parseFloat(ticks[i + 1].left) : 100;
          expect(end).toBeCloseTo(next, 3);
        }
      }
    });

    it("keeps every label whole inside the lane with the gap between neighbours", () => {
      for (const display of displays) {
        for (const duration of durations) {
          for (const width of laneWidthsFor(duration)) {
            const boxes = labelBoxes(ticksFor(duration, width, display), width);
            for (let i = 0; i < boxes.length; i++) {
              expect(boxes[i].left).toBeGreaterThanOrEqual(0);
              expect(boxes[i].right).toBeLessThanOrEqual(width + 1e-9);
              if (i > 0) {
                expect(boxes[i].left - boxes[i - 1].right).toBeGreaterThanOrEqual(
                  RULER_LABEL_GAP_PX - 1e-9,
                );
              }
            }
          }
        }
      }
    });

    it("never exceeds MAX_QUANTIZED_RULER_TICK_COUNT across extremes", () => {
      for (const width of [10_000, 99_904, 500_000, 1_000_000, 10_000_000]) {
        expect(ticksFor(10800, width, MS).length).toBeLessThanOrEqual(
          MAX_QUANTIZED_RULER_TICK_COUNT,
        );
        expect(ticksFor(10800, width, FPS_29_97).length).toBeLessThanOrEqual(
          MAX_QUANTIZED_RULER_TICK_COUNT,
        );
      }
      for (const duration of [3600, 10800, 43200, 86400, 1_000_000, 10_000_000]) {
        expect(ticksFor(duration, 100_000, MS).length).toBeLessThanOrEqual(
          MAX_QUANTIZED_RULER_TICK_COUNT,
        );
      }
      for (const width of [10, 50, 100, 200]) {
        expect(ticksFor(10800, width, MS).length).toBeLessThanOrEqual(
          MAX_QUANTIZED_RULER_TICK_COUNT,
        );
      }
      // A frame step far below the spacing still stops at the cap.
      expect(generateRulerTicks(10800, FPS_30, frameStep(1))).toHaveLength(
        MAX_QUANTIZED_RULER_TICK_COUNT,
      );
    });
  });

  describe("Invalid inputs", () => {
    it("returns an empty array when the duration or the step is unusable", () => {
      expect(generateRulerTicks(10, MS, null)).toEqual([]);
      expect(generateRulerTicks(10, MS, ms(0))).toEqual([]);
      expect(generateRulerTicks(10, MS, ms(-5))).toEqual([]);
      expect(generateRulerTicks(10, MS, ms(NaN))).toEqual([]);
      expect(generateRulerTicks(10, MS, ms(0.5))).toEqual([]);
      for (const duration of [null, undefined, 0, -10, NaN, Infinity]) {
        expect(generateRulerTicks(duration, MS, ms(1000))).toEqual([]);
      }
    });
  });
});

describe("calculateMinorTickPeriod", () => {
  it("gives the minor step as a percent of the interval", () => {
    expect(calculateMinorTickPeriod(0.2, 1)).toBe("20%");
    expect(calculateMinorTickPeriod(0.1, 0.5)).toBe("20%");
    // Rounded up, not to the nearest: 33.33333...% becomes 33.3334%.
    expect(calculateMinorTickPeriod(5, 15)).toBe("33.3334%");
    // 3 frames inside the 14-frame last interval of a second at 29.97 fps.
    expect(calculateMinorTickPeriod(3 * (1001 / 30000), 14 * (1001 / 30000))).toBe(
      "21.4286%",
    );
  });

  it("puts the last repeat of a dividing minor step at or after the next major tick", () => {
    const frame = 1001 / 30000;
    const cases: [number, number][] = [
      [5, 15],
      [1, 3],
      [1, 7],
      [0.1, 0.3],
      [2 / 3, 2],
      [10 * frame, 60 * frame],
      [3 * frame, 30 * frame],
    ];
    for (const [minor, interval] of cases) {
      const period = calculateMinorTickPeriod(minor, interval);
      expect(period).not.toBeNull();
      const repeats = Math.round(interval / minor);
      expect(repeats * parseFloat(period ?? "")).toBeGreaterThanOrEqual(100);
      expect((repeats - 1) * parseFloat(period ?? "")).toBeLessThan(100);
    }
  });

  it("returns null when no minor tick falls inside the interval", () => {
    expect(calculateMinorTickPeriod(1, 1)).toBeNull();
    expect(calculateMinorTickPeriod(2, 1)).toBeNull();
    expect(calculateMinorTickPeriod(0.2, 0)).toBeNull();
  });

  it("returns null for no minor step or an unusable value", () => {
    expect(calculateMinorTickPeriod(null, 1)).toBeNull();
    expect(calculateMinorTickPeriod(0, 1)).toBeNull();
    expect(calculateMinorTickPeriod(NaN, 1)).toBeNull();
    expect(calculateMinorTickPeriod(0.2, Infinity)).toBeNull();
  });
});
