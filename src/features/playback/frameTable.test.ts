import { describe, expect, it } from "vitest";
import { mergeFrameStarts, realFrameStep } from "./frameTable";

/** Half a frame interval at 30 fps, the bound of a target in its frame. */
const HALF_30 = 1 / 60;

/** Frames of 50 ms, as in a stretch of 20 fps in a recording probed at 30 fps. */
const TWENTY_FPS = [10, 10.05, 10.1, 10.15, 10.2];

describe("realFrameStep", () => {
  it("reaches the next and the previous real frame from the frame on screen", () => {
    expect(realFrameStep(TWENTY_FPS, 10.05, 1, HALF_30)).toEqual({
      start: 10.1,
      target: 10.1 + HALF_30,
    });
    expect(realFrameStep(TWENTY_FPS, 10.1, -1, HALF_30)).toEqual({
      start: 10.05,
      target: 10.05 + HALF_30,
    });
    expect(realFrameStep(TWENTY_FPS, 10, 3, HALF_30)?.start).toBe(10.15);
  });

  it("counts from the frame that holds a time inside it, or a time a little before its start", () => {
    expect(realFrameStep(TWENTY_FPS, 10.07, 1, HALF_30)?.start).toBe(10.1);
    // A target of an earlier step lies inside its frame, so a held key goes on frame by frame.
    const first = realFrameStep(TWENTY_FPS, 10, 1, HALF_30);
    expect(realFrameStep(TWENTY_FPS, first?.target ?? 0, 1, HALF_30)?.start).toBe(10.1);
    // A frame start that a float holds a little below its value still names that frame.
    expect(realFrameStep(TWENTY_FPS, 10.1 - 5e-7, 1, HALF_30)?.start).toBe(10.15);
  });

  it("aims halfway to the next frame when that is closer than the bound", () => {
    const starts = [0, 0.02, 0.04];
    expect(realFrameStep(starts, 0, 1, HALF_30)).toEqual({ start: 0.02, target: 0.03 });
  });

  it("keeps a target in front of a hole out of the hole", () => {
    const starts = [0, 0.033, 5];
    expect(realFrameStep(starts, 0, 1, HALF_30)?.target).toBeCloseTo(
      0.033 + HALF_30,
      9,
    );
    expect(realFrameStep(starts, 0.033, 1, HALF_30)?.start).toBe(5);
  });

  it("aims the bound into a last known frame", () => {
    expect(realFrameStep(TWENTY_FPS, 10.15, 1, HALF_30)).toEqual({
      start: 10.2,
      target: 10.2 + HALF_30,
    });
  });

  it("aims half the interval in front of a last known frame when that is shorter", () => {
    // 60 fps frames in a source that the probe gives as 30 fps.
    const starts = [0, 1 / 60, 2 / 60];
    expect(realFrameStep(starts, 1 / 60, 1, HALF_30)?.target).toBeCloseTo(
      2 / 60 + 1 / 120,
      12,
    );
    expect(realFrameStep([5], 5, 0, HALF_30)).toBeNull();
  });

  it("knows no frame outside the table", () => {
    // Past the last frame, before the first frame, and past the data after the last frame.
    expect(realFrameStep(TWENTY_FPS, 10.2, 1, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, 10, -1, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, 9.99, 1, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, 10.3, -1, HALF_30)).toBeNull();
    // Within the interval in front of the last frame, the last frame still holds the time.
    expect(realFrameStep(TWENTY_FPS, 10.24, -1, HALF_30)?.start).toBe(10.15);
    expect(realFrameStep([], 10, 1, HALF_30)).toBeNull();
  });

  it("refuses a step it cannot make", () => {
    expect(realFrameStep(TWENTY_FPS, 10, 0, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, Number.NaN, 1, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, 10, 1.5, HALF_30)).toBeNull();
    expect(realFrameStep(TWENTY_FPS, 10, 1, 0)).toBeNull();
  });
});

describe("mergeFrameStarts", () => {
  it("sorts the starts and leaves out a start that repeats one", () => {
    expect(mergeFrameStarts([0.1, 0.2], [0.166, 0.133, 0.2, 0.20001])).toEqual([
      0.1, 0.133, 0.166, 0.2,
    ]);
    expect(mergeFrameStarts([], [Number.NaN, 0.5])).toEqual([0.5]);
  });
});
