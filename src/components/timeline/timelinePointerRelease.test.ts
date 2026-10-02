import { describe, expect, it } from "vitest";
import {
  createPressPlaybackRecord,
  createSegmentClickGuard,
  planPointerRelease,
  shouldResumeAfterGesture,
  type GestureResumeInput,
  type PointerReleaseInput,
} from "./timelinePointerRelease";
import { createTimelineScrubGesture } from "./timelineScrub";

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

describe("shouldResumeAfterGesture", () => {
  /** The release of a drag that started during playback, whose exact seek ran. */
  function resume(overrides: Partial<GestureResumeInput> = {}): GestureResumeInput {
    return {
      release: "scrubRelease",
      endsGesture: true,
      isDragging: true,
      wasPlayingAtPress: true,
      isSeekDeferred: false,
      hasSeekFailed: false,
      ...overrides,
    };
  }

  it("resumes the playback at the release of a drag that started during playback", () => {
    expect(shouldResumeAfterGesture(resume())).toBe(true);
  });

  it("does not resume a drag that started while paused", () => {
    expect(shouldResumeAfterGesture(resume({ wasPlayingAtPress: false }))).toBe(false);
  });

  it("does not resume after a click, whose seek at pointer down kept the playback", () => {
    expect(shouldResumeAfterGesture(resume({ isDragging: false }))).toBe(false);
  });

  it("does not resume a trim, the click of a segment edge, or a release with no gesture", () => {
    for (const release of ["trimRelease", "edgeClick", "none"] as const) {
      expect(shouldResumeAfterGesture(resume({ release }))).toBe(false);
    }
  });

  it("does not resume for the pointer up of another pointer, which leaves the drag active", () => {
    expect(shouldResumeAfterGesture(resume({ endsGesture: false }))).toBe(false);
  });

  it("does not resume while the seek of the release waits for the calibration anchor", () => {
    expect(shouldResumeAfterGesture(resume({ isSeekDeferred: true }))).toBe(false);
  });

  it("does not resume after the seek of the release failed", () => {
    expect(shouldResumeAfterGesture(resume({ hasSeekFailed: true }))).toBe(false);
  });

  it("resumes after a drag that ended on the release with the full plan of planPointerRelease", () => {
    const plan = planPointerRelease(
      input({ mode: "scrub", isDragging: true, trimPress: null, trimPointerId: null }),
    );
    expect(shouldResumeAfterGesture(resume({ release: plan.kind }))).toBe(true);
    const trimPlan = planPointerRelease(input({ isDragging: true }));
    expect(shouldResumeAfterGesture(resume({ release: trimPlan.kind }))).toBe(false);
  });
});

describe("the release of a drag on the real gesture", () => {
  /** A gesture whose samples run at once, as the panel creates it, with its press record. */
  function createDrag() {
    let pending: (() => void) | null = null;
    const record = createPressPlaybackRecord();
    const gesture = createTimelineScrubGesture({
      onSample: () => {},
      onFinish: () => record.finish(),
      scheduler: {
        request: (cb) => {
          pending = cb;
          return 1;
        },
        cancel: () => {
          pending = null;
        },
      },
      holdCursor: () => () => {},
    });
    const flush = (): void => {
      const cb = pending;
      pending = null;
      cb?.();
    };
    return { gesture, record, flush };
  }

  /** The decision of the panel at a pointer up, read around `end` as handlePointerUp reads it. */
  function releaseOf(
    drag: ReturnType<typeof createDrag>,
    pointerId: number,
    mode: "scrub" | "trim",
  ): boolean {
    const { gesture, record } = drag;
    const wasGestureActive = gesture.isActive();
    const isDragging = gesture.isDragging();
    const wasPlayingAtPress = record.wasPlayingAtPress();
    const release = planPointerRelease({
      pointerId,
      mode,
      isGestureActive: wasGestureActive,
      isDragging,
      trimPress: null,
      trimPointerId: null,
    });
    gesture.end(pointerId, 400);
    return shouldResumeAfterGesture({
      release: release.kind,
      endsGesture: wasGestureActive && !gesture.isActive(),
      isDragging,
      wasPlayingAtPress,
      isSeekDeferred: false,
      hasSeekFailed: false,
    });
  }

  it("resumes at the release of its own pointer, and not at the pointer up of another one", () => {
    const drag = createDrag();
    drag.record.pressScrub(true);
    drag.gesture.begin(1, 100);
    drag.gesture.move(1, 200);
    drag.flush();

    // A pen or a mouse comes up during the touch drag: the drag goes on, and nothing resumes.
    expect(releaseOf(drag, 2, "scrub")).toBe(false);
    expect(drag.gesture.isDragging()).toBe(true);
    expect(drag.record.wasPlayingAtPress()).toBe(true);

    expect(releaseOf(drag, 1, "scrub")).toBe(true);
    expect(drag.gesture.isActive()).toBe(false);
  });

  it("does not resume a scrub that a trim-mode press became", () => {
    const drag = createDrag();
    // The trim-mode press records no playback, also while the store plays. The trim then stops,
    // and the panel turns the rest of the drag into a scrub of the playhead.
    drag.record.pressTrim();
    drag.gesture.begin(1, 100);
    drag.gesture.move(1, 200);
    drag.flush();
    expect(releaseOf(drag, 1, "scrub")).toBe(false);
  });
});

describe("createPressPlaybackRecord", () => {
  it("records the playback state of a scrub-mode press", () => {
    const record = createPressPlaybackRecord();
    expect(record.wasPlayingAtPress()).toBe(false);
    record.pressScrub(true);
    expect(record.wasPlayingAtPress()).toBe(true);
    record.pressScrub(false);
    expect(record.wasPlayingAtPress()).toBe(false);
  });

  it("records no playback for a trim-mode press, also while the store plays", () => {
    const record = createPressPlaybackRecord();
    record.pressScrub(true);
    record.pressTrim();
    expect(record.wasPlayingAtPress()).toBe(false);
  });

  it("forgets the press at the end of the gesture, by every path of the real gesture", () => {
    const record = createPressPlaybackRecord();
    const gesture = createTimelineScrubGesture({
      onSample: () => {},
      onFinish: () => record.finish(),
      scheduler: { request: () => 1, cancel: () => {} },
      holdCursor: () => () => {},
    });
    const ends: readonly ((pointerId: number) => void)[] = [
      (pointerId) => gesture.end(pointerId, 150),
      (pointerId) => gesture.cancel(pointerId),
      () => gesture.cancel(),
      () => gesture.dispose(),
    ];
    for (const end of ends) {
      record.pressScrub(true);
      gesture.begin(1, 100);
      gesture.move(1, 150);
      expect(record.wasPlayingAtPress()).toBe(true);
      end(1);
      expect(gesture.isActive()).toBe(false);
      expect(record.wasPlayingAtPress()).toBe(false);
    }
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
