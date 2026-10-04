import { describe, expect, it } from "vitest";
import {
  INITIAL_REPORT_INTERVAL_MS,
  MAX_REPORT_INTERVAL_MS,
  MIN_REPORT_INTERVAL_MS,
  NO_FRAME_SMOOTHING,
  SMOOTHING_WEIGHT,
  createFrameSmoother,
  frameOnSegment,
  isFrameSmoothingMoving,
  markFrameShown,
  movingAverage,
  pushFrameSample,
  smoothedFrameAt,
  type FrameSmoothing,
} from "./exportProgressSmoothing";

/** Applies the reports in order. Each report is `[frame, at]`. */
function pushAll(reports: readonly (readonly [number, number])[]): FrameSmoothing {
  return reports.reduce<FrameSmoothing>(
    (state, [frame, at]) => pushFrameSample(state, frame, at),
    NO_FRAME_SMOOTHING,
  );
}

/** The positions from `from` to `to` in steps of one animation frame, as a reader sees them. */
function sweep(state: FrameSmoothing, from: number, to: number, step = 16): number[] {
  const positions: number[] = [];
  let current = state;
  for (let now = from; now <= to; now += step) {
    const position = smoothedFrameAt(current, now);
    if (position === null) {
      throw new Error("the model has no report");
    }
    current = markFrameShown(current, position);
    positions.push(position);
  }
  return positions;
}

function expectNeverBackward(positions: readonly number[]): void {
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index]).toBeGreaterThanOrEqual(positions[index - 1]);
  }
}

// A steady encode: 50 frames every 500 ms, which is 0.1 frame per millisecond.
const STEADY = [
  [0, 0],
  [50, 500],
  [100, 1000],
] as const;

describe("movingAverage", () => {
  it("takes the first measurement as is", () => {
    expect(movingAverage(null, 0.25)).toBe(0.25);
  });

  it("moves the average toward the measurement by the weight", () => {
    expect(movingAverage(100, 200)).toBeCloseTo(100 + SMOOTHING_WEIGHT * 100);
  });
});

describe("frameOnSegment", () => {
  const segment = { fromFrame: 10, fromAt: 1000, toFrame: 30, toAt: 1500 };

  it("is linear between the ends", () => {
    expect(frameOnSegment(segment, 1250)).toBe(20);
  });

  it("holds at the start before it and at the end after it", () => {
    expect(frameOnSegment(segment, 900)).toBe(10);
    expect(frameOnSegment(segment, 2000)).toBe(30);
  });
});

describe("pushFrameSample", () => {
  it("shows the first report at once, and does not move with no rate", () => {
    const state = pushFrameSample(NO_FRAME_SMOOTHING, 120, 1000);
    expect(smoothedFrameAt(state, 1000)).toBe(120);
    expect(smoothedFrameAt(state, 5000)).toBe(120);
    expect(state.rate).toBeNull();
    expect(isFrameSmoothingMoving(state, 1000)).toBe(false);
  });

  it("gives no position before the first report", () => {
    expect(smoothedFrameAt(NO_FRAME_SMOOTHING, 1000)).toBeNull();
    expect(isFrameSmoothingMoving(NO_FRAME_SMOOTHING, 1000)).toBe(false);
  });

  it("reaches each report of a steady encode when it arrives", () => {
    const state = pushAll(STEADY);
    expect(state.rate).toBeCloseTo(0.1);
    expect(state.interval).toBe(INITIAL_REPORT_INTERVAL_MS);
    // The next report, 150 at 1500, finds the position at its frame.
    expect(smoothedFrameAt(state, 1500)).toBeCloseTo(150);
  });

  it("moves at the rate between two reports of a steady encode", () => {
    const state = pushAll(STEADY);
    expect(smoothedFrameAt(state, 1250)).toBeCloseTo(125);
    const positions = sweep(state, 1000, 1496);
    const steps = positions
      .slice(1)
      .map((position, index) => position - positions[index]);
    // 16 ms at 0.1 frame per millisecond is 1.6 frames, at each animation frame.
    for (const step of steps) {
      expect(step).toBeCloseTo(1.6);
    }
  });

  it("catches up from the first report to the second without a step", () => {
    const first = pushFrameSample(NO_FRAME_SMOOTHING, 0, 0);
    const second = pushFrameSample(first, 50, 500);
    // The position stays at the first report when the second arrives, and then moves.
    expect(smoothedFrameAt(second, 500)).toBe(0);
    expect(smoothedFrameAt(second, 1000)).toBeCloseTo(100);
    expectNeverBackward(sweep(second, 500, 1000));
  });

  it("holds at the end of the segment when a report is late", () => {
    const state = pushAll(STEADY);
    expect(smoothedFrameAt(state, 1600)).toBeCloseTo(150);
    expect(isFrameSmoothingMoving(state, 1600)).toBe(false);

    const late = pushFrameSample(state, 160, 1600);
    // The motion continues from where it held.
    expect(smoothedFrameAt(late, 1600)).toBeCloseTo(150);
    expect(isFrameSmoothingMoving(late, 1600)).toBe(true);
    expect(smoothedFrameAt(late, 1700)).toBeGreaterThan(150);
  });

  it("continues without a step when a report is early", () => {
    const state = pushAll(STEADY);
    expect(smoothedFrameAt(state, 1400)).toBeCloseTo(140);

    const early = pushFrameSample(state, 150, 1400);
    expect(smoothedFrameAt(early, 1400)).toBeCloseTo(140);
    expectNeverBackward(sweep(early, 1400, 2400));
    expect(smoothedFrameAt(early, 2400)).toBeGreaterThan(150);
  });

  it("never moves backward when the encode slows down", () => {
    let state = pushAll(STEADY);
    let shown = smoothedFrameAt(state, 1500) ?? 0;
    state = markFrameShown(state, shown);
    // The encode now gains 10 frames per report, not 50.
    const positions: number[] = [];
    for (let report = 1; report <= 8; report++) {
      const at = 1000 + report * 500;
      state = pushFrameSample(state, 100 + report * 10, at);
      for (let now = at; now < at + 500; now += 16) {
        shown = smoothedFrameAt(state, now) ?? 0;
        state = markFrameShown(state, shown);
        positions.push(shown);
      }
    }
    expectNeverBackward(positions);
    // The position never runs far ahead of the reports: within one interval at the old rate.
    expect(positions[positions.length - 1]).toBeLessThan(180 + 50);
  });

  it("starts again when the frame falls below the last report", () => {
    const state = pushAll(STEADY);
    const shown = markFrameShown(state, smoothedFrameAt(state, 1200) ?? 0);
    const restarted = pushFrameSample(shown, 10, 3000);
    expect(smoothedFrameAt(restarted, 3000)).toBe(10);
    expect(restarted.rate).toBeNull();
    expect(restarted.shown).toBeNull();
  });

  it("ignores a report that repeats the last frame", () => {
    const state = pushAll(STEADY);
    expect(pushFrameSample(state, 100, 1200)).toBe(state);
  });

  it("ignores a frame or a time that is not finite", () => {
    const state = pushAll(STEADY);
    expect(pushFrameSample(state, Number.NaN, 1500)).toBe(state);
    expect(pushFrameSample(state, 150, Number.POSITIVE_INFINITY)).toBe(state);
  });

  it("keeps the interval between its limits", () => {
    const slow = pushAll([
      [0, 0],
      [1, 60_000],
      [2, 120_000],
      [3, 180_000],
    ]);
    expect(slow.interval).toBe(MAX_REPORT_INTERVAL_MS);

    let fast = pushFrameSample(NO_FRAME_SMOOTHING, 0, 0);
    for (let report = 1; report <= 30; report++) {
      fast = pushFrameSample(fast, report, report);
    }
    expect(fast.interval).toBe(MIN_REPORT_INTERVAL_MS);
  });
});

// The dialog opens during a run at 1000. The frame 300 is already there, and ffmpeg reported it
// up to one interval earlier. The encode runs at 30 frames per second, so the next report, 20 ms
// after the open, is 315.
describe("a report with no known arrival time", () => {
  const atOpen = () => pushFrameSample(NO_FRAME_SMOOTHING, 300, 1000, { timed: false });

  it("shows at once, like any first report", () => {
    expect(smoothedFrameAt(atOpen(), 1000)).toBe(300);
    expect(atOpen().last).toEqual({ frame: 300, at: null });
  });

  it("measures no rate from the short gap to the next report", () => {
    const next = pushFrameSample(atOpen(), 315, 1020);
    expect(next.rate).toBeNull();
    expect(next.interval).toBe(INITIAL_REPORT_INTERVAL_MS);
    // With a known time, the same 15 frames in 20 ms would give 25 times the real rate.
    const timed = pushFrameSample(
      pushFrameSample(NO_FRAME_SMOOTHING, 300, 1000),
      315,
      1020,
    );
    expect(timed.rate).toBeCloseTo(0.75);
  });

  it("never moves the position past the reported frame before the rate is measured", () => {
    const next = pushFrameSample(atOpen(), 315, 1020);
    const positions = sweep(next, 1020, 4000);
    expectNeverBackward(positions);
    expect(Math.max(...positions)).toBeLessThanOrEqual(315);
    expect(smoothedFrameAt(next, 1520)).toBe(315);
  });

  it("measures the gap after the next report normally", () => {
    const next = pushFrameSample(atOpen(), 315, 1020);
    const measured = pushFrameSample(next, 330, 1520);
    expect(measured.rate).toBeCloseTo(15 / 500);
    expect(measured.interval).toBe(INITIAL_REPORT_INTERVAL_MS);
    // From here the position predicts: it reaches the report of 2020 when that arrives.
    expect(smoothedFrameAt(measured, 2020)).toBeCloseTo(345);
  });

  it("keeps no time when it starts a new run", () => {
    const restarted = pushFrameSample(pushAll(STEADY), 10, 3000, { timed: false });
    expect(restarted.last).toEqual({ frame: 10, at: null });
    expect(pushFrameSample(restarted, 20, 3010).rate).toBeNull();
  });

  it("passes through the smoother", () => {
    const smoother = createFrameSmoother();
    smoother.push(300, 1000, { timed: false });
    smoother.push(315, 1020);
    expect(smoother.frameAt(1100, 600)).toBeLessThanOrEqual(315);
    expect(smoother.frameAt(5000, 600)).toBe(315);
  });
});

describe("smoothedFrameAt and the total", () => {
  it("never passes the total", () => {
    // The segment aims at 150, past a total of 120.
    const state = pushAll(STEADY);
    expect(smoothedFrameAt(state, 1500, 120)).toBe(120);
    expect(isFrameSmoothingMoving(state, 1300, 120)).toBe(false);
    expect(isFrameSmoothingMoving(state, 1100, 120)).toBe(true);
  });

  it("shows a reported frame that passes the total", () => {
    const state = pushFrameSample(pushAll(STEADY), 125, 1500);
    expect(smoothedFrameAt(state, 3000, 120)).toBe(125);
  });

  it("has no limit with no total", () => {
    const state = pushAll(STEADY);
    expect(smoothedFrameAt(state, 1500, null)).toBeCloseTo(150);
    expect(smoothedFrameAt(state, 1500, 0)).toBeCloseTo(150);
  });
});

describe("createFrameSmoother", () => {
  it("records each reading, so a reading at an earlier time never goes back", () => {
    const smoother = createFrameSmoother();
    for (const [frame, at] of STEADY) {
      smoother.push(frame, at);
    }
    expect(smoother.frameAt(1400, null)).toBeCloseTo(140);
    // An animation frame can carry a time a little before the last reading.
    expect(smoother.frameAt(1390, null)).toBeCloseTo(140);
    expect(smoother.isMoving(1400, null)).toBe(true);
    expect(smoother.isMoving(1500, null)).toBe(false);
  });

  it("gives null before the first report", () => {
    expect(createFrameSmoother().frameAt(0, null)).toBeNull();
  });

  it("never falls below a frame that it holds, and ignores a lower one", () => {
    const smoother = createFrameSmoother();
    for (const [frame, at] of STEADY) {
      smoother.push(frame, at);
    }
    const position = smoother.frameAt(1400, null);
    expect(position).not.toBeNull();
    // The display showed a reported frame above the position, when the smoothing turned on.
    smoother.hold((position ?? 0) + 3);
    expect(smoother.frameAt(1401, null)).toBeGreaterThanOrEqual((position ?? 0) + 3);
    // A lower frame and a value that is not finite change nothing.
    smoother.hold(0);
    smoother.hold(Number.NaN);
    expect(smoother.frameAt(1402, null)).toBeGreaterThanOrEqual((position ?? 0) + 3);
  });
});
