import { describe, expect, it } from "vitest";
import {
  createSegmentClickGuard,
  planPointerRelease,
  type PointerReleaseInput,
} from "./timelinePointerRelease";

const press = { segmentId: "a", edge: "out" as const };

function input(overrides: Partial<PointerReleaseInput> = {}): PointerReleaseInput {
  return {
    pointerId: 1,
    mode: "trim",
    isGestureActive: true,
    isDragging: false,
    trimPress: press,
    trimPointerId: 1,
    ...overrides,
  };
}

describe("planPointerRelease", () => {
  it("does the click of the edge for a trim-mode press with no drag", () => {
    expect(planPointerRelease(input())).toEqual({
      kind: "edgeClick",
      edgeClick: press,
      endsTrimPointer: true,
    });
  });

  it("lets the final sample commit a trim-mode drag, and ignores the click after it", () => {
    expect(planPointerRelease(input({ isDragging: true }))).toEqual({
      kind: "trimRelease",
      edgeClick: null,
      endsTrimPointer: true,
    });
  });

  it("leaves a scrub to the gesture, with no click rule", () => {
    expect(
      planPointerRelease(
        input({ mode: "scrub", trimPress: null, trimPointerId: null }),
      ),
    ).toEqual({ kind: "scrubRelease", edgeClick: null, endsTrimPointer: false });
  });

  it("does nothing more after Escape ended the trim, but still ignores the click", () => {
    // The gesture is no longer active, and the pointer comes up later.
    expect(
      planPointerRelease(input({ isGestureActive: false, mode: "scrub" })),
    ).toEqual({
      kind: "none",
      edgeClick: null,
      endsTrimPointer: true,
    });
  });

  it("ends no trim-mode press for another pointer", () => {
    expect(planPointerRelease(input({ pointerId: 2 }))).toEqual({
      kind: "none",
      edgeClick: null,
      endsTrimPointer: false,
    });
  });

  it("does no click when the press stopped naming an edge", () => {
    expect(planPointerRelease(input({ trimPress: null }))).toEqual({
      kind: "none",
      edgeClick: null,
      endsTrimPointer: true,
    });
  });
});

describe("createSegmentClickGuard", () => {
  it("ignores the next pointer click after the release, once", () => {
    const guard = createSegmentClickGuard();
    expect(guard.consume(1)).toBe(false);
    guard.arm();
    expect(guard.consume(1)).toBe(true);
    expect(guard.consume(1)).toBe(false);
  });

  it("waits for a late click, such as the click of a touch tap", () => {
    const guard = createSegmentClickGuard();
    guard.arm();
    // No timer ends the guard: the click can come long after the release.
    expect(guard.consume(1)).toBe(true);
  });

  it("ends at the next pointer down, so it never takes a later click", () => {
    const guard = createSegmentClickGuard();
    guard.arm();
    guard.clear();
    expect(guard.consume(1)).toBe(false);
  });

  it("never takes a click from the keyboard or from assistive technology", () => {
    const guard = createSegmentClickGuard();
    guard.arm();
    expect(guard.consume(0)).toBe(false);
    expect(guard.consume(1)).toBe(true);
  });
});
