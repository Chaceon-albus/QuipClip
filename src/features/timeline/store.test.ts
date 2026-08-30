import { describe, expect, it } from "vitest";
import { createTimelineStore } from "./store";

describe("Timeline Store", () => {
  const sourceA = "source-alpha:1000:1700000000";
  const sourceB = "source-beta:2000:1700000500";

  let idCounter = 0;
  const createTestStore = (
    initialState?: Parameters<typeof createTimelineStore>[1],
  ) => {
    idCounter = 0;
    return createTimelineStore(
      {
        generateId: () => `seg-${++idCounter}`,
      },
      initialState,
    );
  };

  describe("Initial State & Serialization", () => {
    it("initializes with default strictly serializable public state", () => {
      const store = createTestStore();
      const state = store.getState();

      expect(state.sourceId).toBeNull();
      expect(state.frameCount).toBe(0);
      expect(state.segments).toEqual([]);
      expect(state.pendingInFrame).toBeNull();
      expect(state.canUndo).toBe(false);
      expect(state.canRedo).toBe(false);

      // Verify JSON serializability of state
      const serialized = JSON.stringify({
        sourceId: state.sourceId,
        frameCount: state.frameCount,
        segments: state.segments,
        pendingInFrame: state.pendingInFrame,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      });
      expect(JSON.parse(serialized)).toEqual({
        sourceId: null,
        frameCount: 0,
        segments: [],
        pendingInFrame: null,
        canUndo: false,
        canRedo: false,
      });
    });
  });

  describe("Source Activation Lifecycle & Identity Guards", () => {
    it("activates a source and resets state on new source identity", () => {
      const store = createTestStore();

      store.getState().setSource(sourceA, 100);
      expect(store.getState().sourceId).toBe(sourceA);
      expect(store.getState().frameCount).toBe(100);
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);
      expect(store.getState().canRedo).toBe(false);
    });

    it("resets edits and history only when source identity changes", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      // Create an edit and set pending In
      store.getState().markIn(10);
      store.getState().markOut(20);
      store.getState().markIn(40);
      expect(store.getState().segments).toHaveLength(1);
      expect(store.getState().pendingInFrame).toBe(40);
      expect(store.getState().canUndo).toBe(true);

      // Switch to a new source B
      store.getState().setSource(sourceB, 200);
      expect(store.getState().sourceId).toBe(sourceB);
      expect(store.getState().frameCount).toBe(200);
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);
      expect(store.getState().canRedo).toBe(false);
    });

    it("preserves edits, pending In, and history on equivalent re-import (same identity and frameCount: 100 -> 100)", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      // Make edits on source A
      store.getState().markIn(10);
      store.getState().markOut(20);
      store.getState().markIn(30);
      store.getState().markOut(40);
      store.getState().markIn(60);

      expect(store.getState().segments).toHaveLength(2);
      expect(store.getState().pendingInFrame).toBe(60);
      expect(store.getState().canUndo).toBe(true);

      const segmentsBefore = store.getState().segments;

      // Re-import the exact same source identity and frameCount (100 -> 100)
      store.getState().setSource(sourceA, 100);

      expect(store.getState().sourceId).toBe(sourceA);
      expect(store.getState().frameCount).toBe(100);
      expect(store.getState().segments).toEqual(segmentsBefore);
      expect(store.getState().pendingInFrame).toBe(60);
      expect(store.getState().canUndo).toBe(true);

      // History still functions
      store.getState().undo();
      expect(store.getState().segments).toHaveLength(1);
      expect(store.getState().canRedo).toBe(true);
    });

    it("resets edits, pending In, and history when same source identity has changed frameCount (100 -> 50)", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      // Make edits and configure undo/redo stacks
      store.getState().markIn(10);
      store.getState().markOut(20);
      store.getState().markIn(30);
      store.getState().markOut(40);
      store.getState().undo(); // 1 in segments, 1 on redo stack
      store.getState().markIn(25); // Set active pending In

      expect(store.getState().segments).toHaveLength(1);
      expect(store.getState().pendingInFrame).toBe(25);
      expect(store.getState().canUndo).toBe(true);
      expect(store.getState().canRedo).toBe(true);

      // Re-activate same identity with changed frame count (100 -> 50)
      store.getState().setSource(sourceA, 50);

      expect(store.getState().sourceId).toBe(sourceA);
      expect(store.getState().frameCount).toBe(50);
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);
      expect(store.getState().canRedo).toBe(false);

      // Calling undo and redo cannot revive old edits
      store.getState().undo();
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().canUndo).toBe(false);

      store.getState().redo();
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().canRedo).toBe(false);
    });

    it("validates inputs and rejects invalid source activations", () => {
      const store = createTestStore();

      // Negative frame count
      store.getState().setSource(sourceA, -10);
      expect(store.getState().sourceId).toBeNull();

      // Non-integer frame count
      store.getState().setSource(sourceA, 50.5);
      expect(store.getState().sourceId).toBeNull();

      // NaN frame count
      store.getState().setSource(sourceA, NaN);
      expect(store.getState().sourceId).toBeNull();

      // Unsafe integer frame count
      store.getState().setSource(sourceA, Number.MAX_SAFE_INTEGER + 10);
      expect(store.getState().sourceId).toBeNull();

      // Invalid sourceId type
      store.getState().setSource(123 as unknown as string, 100);
      expect(store.getState().sourceId).toBeNull();
    });

    it("resets state when source is set to null or empty string", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);
      store.getState().markIn(10);
      store.getState().markOut(20);

      store.getState().setSource(null, 0);
      expect(store.getState().sourceId).toBeNull();
      expect(store.getState().frameCount).toBe(0);
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);

      store.getState().setSource(sourceA, 100);
      store.getState().setSource("", 0);
      expect(store.getState().sourceId).toBeNull();
    });

    it("allows no edits on zero-frame sources (frameCount = 0)", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 0);

      expect(store.getState().frameCount).toBe(0);

      store.getState().markIn(0);
      expect(store.getState().pendingInFrame).toBeNull();

      store.getState().markOut(0);
      expect(store.getState().segments).toEqual([]);

      store.getState().split(0);
      expect(store.getState().segments).toEqual([]);
    });
  });

  describe("Mark In & Mark Out Operations", () => {
    it("records inclusive In point and does not add to history", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(15);
      expect(store.getState().pendingInFrame).toBe(15);
      expect(store.getState().canUndo).toBe(false);

      // Overwrite pending In
      store.getState().markIn(25);
      expect(store.getState().pendingInFrame).toBe(25);
      expect(store.getState().canUndo).toBe(false);
    });

    it("ignores markIn with out-of-bounds or invalid frame indices", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(-1);
      expect(store.getState().pendingInFrame).toBeNull();

      store.getState().markIn(100); // 100 is exclusive upper bound, visible is 0..99
      expect(store.getState().pendingInFrame).toBeNull();

      store.getState().markIn(NaN);
      expect(store.getState().pendingInFrame).toBeNull();

      store.getState().markIn(10.5);
      expect(store.getState().pendingInFrame).toBeNull();
    });

    it("completes segment with exclusive boundary min(currentFrame + 1, frameCount)", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(20);

      expect(store.getState().segments).toEqual([
        {
          id: "seg-1",
          sourceId: sourceA,
          inFrame: 10,
          outFrame: 21, // 20 + 1 = 21
        },
      ]);
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(true);
    });

    it("creates valid 1-frame segment when In and Out are marked on the same visible frame", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(5);
      store.getState().markOut(5);

      expect(store.getState().segments).toEqual([
        {
          id: "seg-1",
          sourceId: sourceA,
          inFrame: 5,
          outFrame: 6, // 1 frame duration: [5, 6)
        },
      ]);
      expect(store.getState().pendingInFrame).toBeNull();
    });

    it("includes the last source frame when marked at frameCount - 1", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(99);
      store.getState().markOut(99);

      expect(store.getState().segments).toEqual([
        {
          id: "seg-1",
          sourceId: sourceA,
          inFrame: 99,
          outFrame: 100, // min(99 + 1, 100) = 100
        },
      ]);
    });

    it("supports single-frame sources (frameCount = 1)", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 1);

      store.getState().markIn(0);
      store.getState().markOut(0);

      expect(store.getState().segments).toEqual([
        {
          id: "seg-1",
          sourceId: sourceA,
          inFrame: 0,
          outFrame: 1,
        },
      ]);
    });

    it("rejects markOut when currentFrame is before pending In", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(50);
      store.getState().markOut(40);

      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInFrame).toBe(50); // Preserves pending In
      expect(store.getState().canUndo).toBe(false);
    });

    it("ignores markOut when no In mark is pending", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markOut(20);
      expect(store.getState().segments).toEqual([]);
    });

    it("maintains completed segments in source order regardless of mark order", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      // Mark middle segment [40, 51)
      store.getState().markIn(40);
      store.getState().markOut(50);

      // Mark later segment [70, 81)
      store.getState().markIn(70);
      store.getState().markOut(80);

      // Mark earlier segment [10, 21)
      store.getState().markIn(10);
      store.getState().markOut(20);

      expect(store.getState().segments).toEqual([
        { id: "seg-3", sourceId: sourceA, inFrame: 10, outFrame: 21 },
        { id: "seg-1", sourceId: sourceA, inFrame: 40, outFrame: 51 },
        { id: "seg-2", sourceId: sourceA, inFrame: 70, outFrame: 81 },
      ]);
    });
  });

  describe("Split Operations", () => {
    it("splits a segment strictly inside, retaining left ID and creating new right ID", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      // Create [10, 30) (id: "seg-1")
      store.getState().markIn(10);
      store.getState().markOut(29); // outFrame is 30

      expect(store.getState().segments).toEqual([
        { id: "seg-1", sourceId: sourceA, inFrame: 10, outFrame: 30 },
      ]);

      // Split at interior frame 18
      store.getState().split(18);

      expect(store.getState().segments).toEqual([
        { id: "seg-1", sourceId: sourceA, inFrame: 10, outFrame: 18 },
        { id: "seg-2", sourceId: sourceA, inFrame: 18, outFrame: 30 },
      ]);
      expect(store.getState().canUndo).toBe(true);
    });

    it("ignores split at start boundary, end boundary, or outside segment", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(29); // [10, 30)

      // Start boundary (10)
      store.getState().split(10);
      expect(store.getState().segments).toHaveLength(1);

      // End boundary (30)
      store.getState().split(30);
      expect(store.getState().segments).toHaveLength(1);

      // Outside segment
      store.getState().split(5);
      expect(store.getState().segments).toHaveLength(1);
      store.getState().split(50);
      expect(store.getState().segments).toHaveLength(1);
    });

    it("cannot split a 1-frame segment", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(10); // [10, 11)

      store.getState().split(10);
      expect(store.getState().segments).toHaveLength(1);
      store.getState().split(11);
      expect(store.getState().segments).toHaveLength(1);
    });
  });

  describe("Undo & Redo Stacks", () => {
    it("handles undo and redo for markOut additions", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(20); // Edit 1

      store.getState().markIn(40);
      store.getState().markOut(50); // Edit 2

      expect(store.getState().segments).toHaveLength(2);
      expect(store.getState().canUndo).toBe(true);
      expect(store.getState().canRedo).toBe(false);

      // Undo Edit 2
      store.getState().undo();
      expect(store.getState().segments).toHaveLength(1);
      expect(store.getState().segments[0].inFrame).toBe(10);
      expect(store.getState().canUndo).toBe(true);
      expect(store.getState().canRedo).toBe(true);

      // Undo Edit 1
      store.getState().undo();
      expect(store.getState().segments).toHaveLength(0);
      expect(store.getState().canUndo).toBe(false);
      expect(store.getState().canRedo).toBe(true);

      // Redo Edit 1
      store.getState().redo();
      expect(store.getState().segments).toHaveLength(1);
      expect(store.getState().canUndo).toBe(true);
      expect(store.getState().canRedo).toBe(true);

      // Redo Edit 2
      store.getState().redo();
      expect(store.getState().segments).toHaveLength(2);
      expect(store.getState().canUndo).toBe(true);
      expect(store.getState().canRedo).toBe(false);
    });

    it("handles undo and redo for split operations", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(29); // [10, 30)

      store.getState().split(20); // Split into [10, 20) and [20, 30)
      expect(store.getState().segments).toHaveLength(2);

      // Undo split
      store.getState().undo();
      expect(store.getState().segments).toEqual([
        { id: "seg-1", sourceId: sourceA, inFrame: 10, outFrame: 30 },
      ]);
      expect(store.getState().canRedo).toBe(true);

      // Redo split
      store.getState().redo();
      expect(store.getState().segments).toEqual([
        { id: "seg-1", sourceId: sourceA, inFrame: 10, outFrame: 20 },
        { id: "seg-2", sourceId: sourceA, inFrame: 20, outFrame: 30 },
      ]);
    });

    it("clears redo stack when a new edit is performed", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(20);

      store.getState().markIn(40);
      store.getState().markOut(50);

      // Undo one edit
      store.getState().undo();
      expect(store.getState().canRedo).toBe(true);

      // Perform a new markOut edit
      store.getState().markIn(70);
      store.getState().markOut(80);

      // Redo must now be cleared
      expect(store.getState().canRedo).toBe(false);
      expect(store.getState().segments).toHaveLength(2);
      expect(store.getState().segments.map((s) => s.inFrame)).toEqual([10, 70]);
    });

    it("clears redo stack when a split edit is performed after undo", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(49); // [10, 50)

      store.getState().markIn(70);
      store.getState().markOut(80);

      store.getState().undo();
      expect(store.getState().canRedo).toBe(true);

      // Split remaining segment
      store.getState().split(30);

      expect(store.getState().canRedo).toBe(false);
      expect(store.getState().segments).toHaveLength(2);
    });

    it("never crosses source replacement on undo or redo", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      store.getState().markOut(20);
      expect(store.getState().canUndo).toBe(true);

      // Switch to source B
      store.getState().setSource(sourceB, 200);
      expect(store.getState().canUndo).toBe(false);
      expect(store.getState().canRedo).toBe(false);

      // Undo/redo are no-ops
      store.getState().undo();
      expect(store.getState().segments).toEqual([]);
      store.getState().redo();
      expect(store.getState().segments).toEqual([]);
    });

    it("clears pending In on clearPendingIn and reset without creating history", () => {
      const store = createTestStore();
      store.getState().setSource(sourceA, 100);

      store.getState().markIn(10);
      expect(store.getState().pendingInFrame).toBe(10);

      store.getState().clearPendingIn();
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);

      store.getState().markIn(20);
      store.getState().reset();
      expect(store.getState().sourceId).toBeNull();
      expect(store.getState().pendingInFrame).toBeNull();
      expect(store.getState().canUndo).toBe(false);
    });
  });
});
