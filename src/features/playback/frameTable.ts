/**
 * The real video frames of a source that plays through a MediaSource (ADR 046), and the frame
 * step that moves by them (ADR 022).
 *
 * The MediaSource controller reads the presentation time of each video sample that it appends,
 * so it knows where each frame of the buffered data starts. A live recording can change its frame
 * rate, and its timestamps can drift from the nominal grid. A step that aims at the middle of the
 * next nominal frame can then land in the frame on screen, and the next press of the same step
 * aims at the same place. A step by real frames reaches the next frame wherever it starts.
 */

/** What the playback store reads of the frames of the attached element. */
export interface FrameTable {
  /**
   * The media times at which the video frames of the buffered data start, ascending and with no
   * duplicates. The answer is valid until the next append or remove of the element.
   */
  readonly frameStarts: () => readonly number[];
}

/** A step of real frames. */
export interface RealFrameStep {
  /** The media time at which the frame that the step reaches starts. */
  readonly start: number;
  /** The media time that the step seeks to, inside that frame. */
  readonly target: number;
}

/**
 * The distance at which a time still names the frame that starts there. A frame callback reports
 * the start of its frame to within a microsecond (ADR 046, measurement 18), and two frames of a
 * video start far more than this apart: a millisecond even at 1000 frames per second.
 */
const FRAME_MATCH_SECONDS = 1e-4;

/** The number of frame starts at or before `time`. */
function countAtOrBefore(starts: readonly number[], time: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * The step of `delta` real frames from the frame that holds `from`, or null when `starts` does
 * not know one of the two frames. The step then keeps the nominal step.
 *
 * - The frame that holds `from` is the latest frame that starts at or before it. The last frame
 *   of `starts` holds `from` only up to twice `maxOffset` after its start, or up to the interval
 *   in front of that frame when it is longer, because the data after it can be missing.
 * - The target lies `maxOffset` after the start of the frame that the step reaches, or halfway to
 *   the next frame when that comes sooner. The middle of a frame is safe from the rounding of a
 *   time, and the bound keeps a target in front of a hole in the buffered data out of that hole.
 *   For the last known frame, half the interval in front of it stands in for the next frame, so
 *   a source whose frames come faster than the nominal rate keeps the target in that frame.
 *
 * @param starts The frame starts of a `FrameTable`.
 * @param from The media time that the step counts from: the frame on screen, or the target of a
 *   pending step.
 * @param delta The number of frames, negative for a step back.
 * @param maxOffset The farthest distance of the target from the start of its frame: half the
 *   nominal frame interval.
 */
export function realFrameStep(
  starts: readonly number[],
  from: number,
  delta: number,
  maxOffset: number,
): RealFrameStep | null {
  if (
    !Number.isFinite(from) ||
    !Number.isSafeInteger(delta) ||
    delta === 0 ||
    !(maxOffset > 0)
  ) {
    return null;
  }
  const holder = countAtOrBefore(starts, from + FRAME_MATCH_SECONDS) - 1;
  if (holder < 0) {
    return null;
  }
  if (holder === starts.length - 1) {
    const before = holder > 0 ? starts[holder] - starts[holder - 1] : 0;
    if (from - starts[holder] > Math.max(2 * maxOffset, before)) {
      return null;
    }
  }
  const index = holder + delta;
  if (index < 0 || index >= starts.length) {
    return null;
  }
  const start = starts[index];
  const interval =
    index + 1 < starts.length
      ? starts[index + 1] - start
      : index > 0
        ? start - starts[index - 1]
        : Number.POSITIVE_INFINITY;
  return { start, target: start + Math.min(interval / 2, maxOffset) };
}

/**
 * The frame starts of `starts` and `added` together, ascending, with each start that lies
 * within `FRAME_MATCH_SECONDS` of an earlier one left out.
 */
export function mergeFrameStarts(
  starts: readonly number[],
  added: readonly number[],
): number[] {
  const all = [...starts, ...added].filter((time) => Number.isFinite(time));
  all.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const time of all) {
    const last = merged[merged.length - 1];
    if (last === undefined || time - last > FRAME_MATCH_SECONDS) {
      merged.push(time);
    }
  }
  return merged;
}
