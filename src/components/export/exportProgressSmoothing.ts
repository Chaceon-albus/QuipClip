/**
 * A continuous frame position for the progress display of an export.
 *
 * ffmpeg writes one `-progress` block about every 500 ms, so the reported frame count changes
 * about twice a second. A bar, a percent, and a frame count that show each report move in
 * jerks. This model turns the reports into a position that moves at the measured rate between
 * them.
 *
 * Each report starts a straight segment. The segment starts at the position that shows at that
 * moment, so the motion has no step. It ends where the encode will be at the next expected
 * report: the reported frame plus the rate times the report interval. A report that comes late
 * finds the position held at the end of its segment. A stalled encode therefore stops within one
 * interval, and the position never runs away from the reports. The position never moves
 * backward.
 *
 * The rate and the interval come from the times between reports that change the frame. A report
 * with the same frame changes nothing, so the interval is the time between two changes of the
 * frame. A report with no known arrival time, such as the frame that is already there when the
 * display opens during a run, measures nothing (`FrameSampleOptions`).
 *
 * The position is for display only. The store keeps the frame count that ffmpeg reported.
 *
 * The rules read no clock. Every time is an argument in milliseconds on one monotonic clock,
 * such as `performance.now()`, so the tests need no timers.
 */

/** The weight of a new measurement in the moving averages of the rate and the interval. */
export const SMOOTHING_WEIGHT = 0.3;

/**
 * The report interval before the first measurement, in milliseconds. The report interval is the
 * time between two reports that change the frame.
 */
export const INITIAL_REPORT_INTERVAL_MS = 500;

/** The shortest report interval that the model uses, in milliseconds. */
export const MIN_REPORT_INTERVAL_MS = 100;

/**
 * The longest report interval that the model uses, in milliseconds. A slower encode then holds
 * between two reports, and the position never runs far ahead of the last report.
 */
export const MAX_REPORT_INTERVAL_MS = 2000;

/** One report: the frame count, and when it arrived. */
export interface FrameSample {
  readonly frame: number;
  /** The arrival time, or null when it is unknown. A report with no time measures nothing. */
  readonly at: number | null;
}

export interface FrameSampleOptions {
  /**
   * True when `at` is the arrival time of the report. Default true.
   *
   * False when the frame was already there when the model got it, such as when the display
   * opens during a run. The model then knows the frame, but not when ffmpeg reported it. A rate
   * from that time could be many times too high: a report 20 ms after the open would count the
   * frames of a whole interval in 20 ms. So this sample, and the next one, measure no rate and
   * no interval. The next sample has a known time, so the gap after it measures normally.
   */
  readonly timed?: boolean;
}

/** A straight motion from one frame position to another. Before and after it, the position holds. */
export interface FrameSegment {
  readonly fromFrame: number;
  readonly fromAt: number;
  readonly toFrame: number;
  readonly toAt: number;
}

export interface FrameSmoothing {
  /** The last report that changed the frame, or null before the first. */
  readonly last: FrameSample | null;
  /** The smoothed rate, in frames per millisecond. Null until two timed reports. */
  readonly rate: number | null;
  /** The smoothed time between two reports that change the frame, in milliseconds. */
  readonly interval: number;
  /** The segment that the position follows, or null before the first report. */
  readonly segment: FrameSegment | null;
  /** The last position that a reader showed, or null. The position never falls below it. */
  readonly shown: number | null;
}

/** The model before the first report. */
export const NO_FRAME_SMOOTHING: FrameSmoothing = {
  last: null,
  rate: null,
  interval: INITIAL_REPORT_INTERVAL_MS,
  segment: null,
  shown: null,
};

/**
 * Moves `average` toward `measured` by `SMOOTHING_WEIGHT`. With no average yet, the result is
 * the measurement itself.
 */
export function movingAverage(average: number | null, measured: number): number {
  if (average === null) {
    return measured;
  }
  return average + SMOOTHING_WEIGHT * (measured - average);
}

/** The position on `segment` at `now`. It is linear between the ends and holds outside them. */
export function frameOnSegment(segment: FrameSegment, now: number): number {
  if (now <= segment.fromAt) {
    return segment.fromFrame;
  }
  if (now >= segment.toAt) {
    return segment.toFrame;
  }
  const fraction = (now - segment.fromAt) / (segment.toAt - segment.fromAt);
  return segment.fromFrame + (segment.toFrame - segment.fromFrame) * fraction;
}

/**
 * The highest position that the model shows. It is the total, so a prediction never passes the
 * end of the encode. ffmpeg can count a few frames more than the total, and a reported frame
 * always shows, so the limit is never below the last report. With no total, there is no limit.
 */
function positionLimit(state: FrameSmoothing, expectedFrames: number | null): number {
  if (expectedFrames === null || !(expectedFrames > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(expectedFrames, state.last?.frame ?? 0);
}

/**
 * The position at `now`, or null before the first report.
 *
 * It follows the segment. It is never below the last shown position, and never above the
 * total when the caller gives one (`expectedFrames`). This function does not record the
 * position as shown. `markFrameShown` does that.
 */
export function smoothedFrameAt(
  state: FrameSmoothing,
  now: number,
  expectedFrames: number | null = null,
): number | null {
  if (state.segment === null) {
    return null;
  }
  const onSegment = frameOnSegment(state.segment, now);
  const position = state.shown === null ? onSegment : Math.max(onSegment, state.shown);
  return Math.min(position, positionLimit(state, expectedFrames));
}

/** Records `position` as the shown position. A later position never falls below it. */
export function markFrameShown(
  state: FrameSmoothing,
  position: number,
): FrameSmoothing {
  return state.shown === position ? state : { ...state, shown: position };
}

/**
 * Adds the report of `frame`, which the model gets at the time `at`.
 *
 * 1. A frame below the last report belongs to a new run. The model starts again.
 * 2. The first report shows at once. With no rate yet, the position does not move.
 * 3. A frame equal to the last report adds no information. The model does not change.
 * 4. A higher frame updates the moving averages of the rate and the interval. It does so only
 *    when both this report and the last one have a known time (`FrameSampleOptions`), and time
 *    passed between them. A new segment then starts at the position at `at`, so the motion has
 *    no step. It ends at the reported frame plus one interval at the rate, one interval later.
 *    With no rate yet, it ends at the reported frame. A segment end below the position holds
 *    the position, so it never moves backward.
 *
 * A frame or a time that is not finite does not change the model.
 */
export function pushFrameSample(
  state: FrameSmoothing,
  frame: number,
  at: number,
  options: FrameSampleOptions = {},
): FrameSmoothing {
  if (!Number.isFinite(frame) || !Number.isFinite(at)) {
    return state;
  }
  const arrivedAt = (options.timed ?? true) ? at : null;
  const last = state.last;
  if (last !== null && frame < last.frame) {
    return pushFrameSample(NO_FRAME_SMOOTHING, frame, at, options);
  }
  if (last === null) {
    return {
      ...NO_FRAME_SMOOTHING,
      last: { frame, at: arrivedAt },
      segment: { fromFrame: frame, fromAt: at, toFrame: frame, toAt: at },
    };
  }
  if (frame === last.frame) {
    return state;
  }

  let { rate, interval } = state;
  if (arrivedAt !== null && last.at !== null && arrivedAt > last.at) {
    const gap = arrivedAt - last.at;
    rate = movingAverage(rate, (frame - last.frame) / gap);
    interval = Math.min(
      MAX_REPORT_INTERVAL_MS,
      Math.max(MIN_REPORT_INTERVAL_MS, movingAverage(interval, gap)),
    );
  }

  const start = smoothedFrameAt(state, at) ?? frame;
  // With no rate, the segment moves to the reported frame and stops there.
  const target = rate === null ? frame : frame + rate * interval;
  const segment: FrameSegment =
    target > start
      ? { fromFrame: start, fromAt: at, toFrame: target, toAt: at + interval }
      : { fromFrame: start, fromAt: at, toFrame: start, toAt: at };
  return {
    last: { frame, at: arrivedAt },
    rate,
    interval,
    segment,
    shown: state.shown,
  };
}

/**
 * True when the position after `now` is still to change. A display can stop its animation
 * frames when this is false, and start them again at the next report.
 */
export function isFrameSmoothingMoving(
  state: FrameSmoothing,
  now: number,
  expectedFrames: number | null = null,
): boolean {
  if (state.segment === null) {
    return false;
  }
  const current = smoothedFrameAt(state, now, expectedFrames);
  const end = smoothedFrameAt(state, Math.max(now, state.segment.toAt), expectedFrames);
  return current !== null && end !== null && end > current;
}

/**
 * The model of one run, with the shown position recorded at each reading. It holds mutable
 * state, so a component keeps it in a ref and uses it only in effects and callbacks.
 */
export interface FrameSmoother {
  /** Adds a report (`pushFrameSample`). */
  push(frame: number, at: number, options?: FrameSampleOptions): void;
  /** The position at `now` (`smoothedFrameAt`). It records the position as shown. */
  frameAt(now: number, expectedFrames: number | null): number | null;
  /** Whether the position after `now` is still to change (`isFrameSmoothingMoving`). */
  isMoving(now: number, expectedFrames: number | null): boolean;
  /**
   * Records `position` as shown when it is above the position shown before, so the position
   * never falls below it. The display calls it when it shows a reported frame that the model
   * did not give, such as when the smoothing turns on again.
   */
  hold(position: number): void;
}

export function createFrameSmoother(): FrameSmoother {
  let state = NO_FRAME_SMOOTHING;
  return {
    push(frame, at, options) {
      state = pushFrameSample(state, frame, at, options);
    },
    frameAt(now, expectedFrames) {
      const position = smoothedFrameAt(state, now, expectedFrames);
      if (position !== null) {
        state = markFrameShown(state, position);
      }
      return position;
    },
    isMoving(now, expectedFrames) {
      return isFrameSmoothingMoving(state, now, expectedFrames);
    },
    hold(position) {
      if (
        Number.isFinite(position) &&
        (state.shown === null || position > state.shown)
      ) {
        state = markFrameShown(state, position);
      }
    },
  };
}
