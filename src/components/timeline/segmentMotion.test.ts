import { describe, expect, it } from "vitest";
import { createTimelineStore } from "@/features/timeline";
import type { Pts, Segment } from "@/types/project";
import {
  advanceSegmentMotion,
  createSegmentMotionState,
  type SegmentMotionState,
} from "./segmentMotion";

const pts = (value: string) => value as Pts;

const SOURCE = "source-1";

function createStore() {
  let nextId = 1;
  const store = createTimelineStore({ generateId: () => `segment-${nextId++}` });
  store.getState().setSource(SOURCE, "revision-1");
  return store;
}

type Store = ReturnType<typeof createStore>;

/**
 * Follows a store as the segment layer does: one motion state, advanced with the segment list
 * after each action.
 */
function follow(store: Store) {
  let state: SegmentMotionState = createSegmentMotionState(
    SOURCE,
    store.getState().segments,
  );
  return {
    /** Advances with the current list of the store and returns the new state. */
    advance(sourceId: string | null = SOURCE): SegmentMotionState {
      state = advanceSegmentMotion(state, sourceId, store.getState().segments);
      return state;
    },
    get state() {
      return state;
    },
  };
}

/** Marks one segment `[inPts, outPts)` and ends it, so the next Mark In starts a new one. */
function markSegment(store: Store, inPts: string, outPts: string) {
  store.getState().markIn(pts(inPts));
  store.getState().markOut(pts(outPts));
}

describe("advanceSegmentMotion: which segments fade in", () => {
  it("moves nothing in the baseline of a list", () => {
    const store = createStore();
    markSegment(store, "0", "100");
    store.getState().newSegment();
    markSegment(store, "200", "300");

    // The layer mounts on a list that already holds two segments, as after a source loads.
    const state = createSegmentMotionState(SOURCE, store.getState().segments);
    expect([...state.enteringIds]).toStrictEqual([]);
    expect(state.cutFlashes).toStrictEqual([]);
  });

  it("fades in the segment that Mark Out makes", () => {
    const store = createStore();
    const motion = follow(store);

    markSegment(store, "0", "100");
    expect([...motion.advance().enteringIds]).toStrictEqual(["segment-1"]);
    expect(motion.state.cutFlashes).toStrictEqual([]);

    store.getState().newSegment();
    markSegment(store, "200", "300");
    // Only the new segment fades in, and the first one stays as it is.
    expect([...motion.advance().enteringIds]).toStrictEqual(["segment-2"]);
  });

  it("fades in the right half of a split, and flashes the cut point", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    motion.advance();

    store.getState().split(pts("40"));
    const state = motion.advance();
    expect([...state.enteringIds]).toStrictEqual(["segment-2"]);
    expect(state.cutFlashes).toStrictEqual([
      { key: "segment-1|segment-2|40", pts: pts("40") },
    ]);
  });

  it("fades in a segment that an undo or a redo brings back", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    motion.advance();

    // Undo of Delete brings the deleted segment back.
    store.getState().deleteSegment();
    expect([...motion.advance().enteringIds]).toStrictEqual([]);
    store.getState().undo();
    expect([...motion.advance().enteringIds]).toStrictEqual(["segment-1"]);

    // Redo of Delete removes it again, and Undo brings it back again.
    store.getState().redo();
    expect([...motion.advance().enteringIds]).toStrictEqual([]);
    store.getState().undo();
    expect([...motion.advance().enteringIds]).toStrictEqual(["segment-1"]);
  });

  it("fades in and flashes again when a redo repeats a split", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    store.getState().split(pts("40"));
    motion.advance();

    // Undo of the split removes the right half and gives the left half its old Out.
    store.getState().undo();
    const undone = motion.advance();
    expect([...undone.enteringIds]).toStrictEqual([]);
    expect(undone.cutFlashes).toStrictEqual([]);

    store.getState().redo();
    const redone = motion.advance();
    expect([...redone.enteringIds]).toStrictEqual(["segment-2"]);
    expect(redone.cutFlashes).toStrictEqual([
      { key: "segment-1|segment-2|40", pts: pts("40") },
    ]);
  });

  it("fades in a segment that a redo of Mark Out brings back", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    motion.advance();

    store.getState().undo();
    expect([...motion.advance().enteringIds]).toStrictEqual([]);
    store.getState().redo();
    expect([...motion.advance().enteringIds]).toStrictEqual(["segment-1"]);
  });

  it("moves nothing for a trim or a Mark on the current segment", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    motion.advance();

    store.getState().trimSegmentEdge("segment-1", "out", pts("80"));
    const trimmed = motion.advance();
    expect([...trimmed.enteringIds]).toStrictEqual([]);
    expect(trimmed.cutFlashes).toStrictEqual([]);

    // Mark In and Mark Out move the boundaries of the current segment.
    store.getState().markIn(pts("10"));
    expect([...motion.advance().enteringIds]).toStrictEqual([]);
    store.getState().markOut(pts("90"));
    expect([...motion.advance().enteringIds]).toStrictEqual([]);

    // Undo of the trim restores the same identifier.
    store.getState().undo();
    expect([...motion.advance().enteringIds]).toStrictEqual([]);
  });

  it("clears the fade of an earlier change at the next change of the list", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    expect(motion.advance().enteringIds.size).toBe(1);

    store.getState().trimSegmentEdge("segment-1", "in", pts("10"));
    expect(motion.advance().enteringIds.size).toBe(0);
  });

  it("keeps the same state while the list does not change", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    const made = motion.advance();

    // A zoom, a scroll, a resize or a selection renders the layer with the same list.
    store.getState().newSegment();
    store.getState().selectSegment("segment-1");
    expect(motion.advance()).toBe(made);
    expect([...made.enteringIds]).toStrictEqual(["segment-1"]);
  });

  it("starts a new baseline when the active source changes", () => {
    const store = createStore();
    const motion = follow(store);
    markSegment(store, "0", "100");
    motion.advance();

    const other = motion.advance("source-2");
    expect([...other.enteringIds]).toStrictEqual([]);
    // Back on the first source, its segment is the baseline again and does not fade in.
    const back = motion.advance(SOURCE);
    expect([...back.enteringIds]).toStrictEqual([]);
    expect(back.cutFlashes).toStrictEqual([]);
  });

  it("starts a new baseline when a source loads after none", () => {
    const store = createStore();
    markSegment(store, "0", "100");
    const none = createSegmentMotionState(null, store.getState().segments);
    const loaded = advanceSegmentMotion(none, SOURCE, store.getState().segments);
    expect([...loaded.enteringIds]).toStrictEqual([]);
  });
});

describe("advanceSegmentMotion: the cut points that flash", () => {
  const segment = (id: string, inPts: string, outPts: string, sourceId = SOURCE) =>
    ({ id, sourceId, inPts: pts(inPts), outPts: pts(outPts) }) satisfies Segment;

  it("does not flash a Mark Out that starts at the Out of another segment", () => {
    const before = [segment("a", "0", "100")];
    const after = [segment("a", "0", "100"), segment("b", "100", "200")];
    const state = advanceSegmentMotion(
      createSegmentMotionState(SOURCE, before),
      SOURCE,
      after,
    );
    expect([...state.enteringIds]).toStrictEqual(["b"]);
    expect(state.cutFlashes).toStrictEqual([]);
  });

  it("flashes a split of a segment that overlaps another one", () => {
    // Overlap is legal (ADR 007). Only the segment that was cut counts as the left half.
    const before = [segment("a", "0", "100"), segment("b", "50", "150")];
    const after = [
      segment("a", "0", "100"),
      segment("b", "50", "100"),
      segment("c", "100", "150"),
    ];
    const state = advanceSegmentMotion(
      createSegmentMotionState(SOURCE, before),
      SOURCE,
      after,
    );
    expect(state.cutFlashes).toStrictEqual([{ key: "b|c|100", pts: pts("100") }]);
  });

  it("ignores the segments of another source", () => {
    const before = [segment("a", "0", "100")];
    const after = [segment("a", "0", "100"), segment("x", "0", "50", "source-2")];
    const state = advanceSegmentMotion(
      createSegmentMotionState(SOURCE, before),
      SOURCE,
      after,
    );
    expect([...state.enteringIds]).toStrictEqual([]);
  });

  it("finds each cut when one change holds two splits", () => {
    const before = [segment("a", "0", "100"), segment("b", "200", "300")];
    const after = [
      segment("a", "0", "40"),
      segment("c", "40", "100"),
      segment("b", "200", "250"),
      segment("d", "250", "300"),
    ];
    const state = advanceSegmentMotion(
      createSegmentMotionState(SOURCE, before),
      SOURCE,
      after,
    );
    expect(state.cutFlashes.map(({ key }) => key)).toStrictEqual(["a|c|40", "b|d|250"]);
  });
});
