import { describe, expect, it } from "vitest";
import type { Pts } from "@/types/project";
import { findCurrentSegment } from "./math";
import { createTimelineStore } from "./store";

const pts = (value: string) => value as Pts;

function createStore() {
  let nextId = 1;
  return createTimelineStore({ generateId: () => `segment-${nextId++}` });
}

type Store = ReturnType<typeof createStore>;

/** Reads the segments as plain comparable records, in project array order. */
function shape(store: Store) {
  return store
    .getState()
    .segments.map(({ id, inPts, outPts }) => ({ id, inPts, outPts }));
}

/**
 * Asserts the store invariant: while a current segment resolves for the active source,
 * `pendingInPts` is null. Only one segment is ever in progress.
 */
function expectOneInProgress(store: Store) {
  const state = store.getState();
  const current = findCurrentSegment(
    state.segments,
    state.currentSegmentId,
    state.sourceId,
  );
  expect(current !== null && state.pendingInPts !== null).toBe(false);
}

describe("timeline store source ownership", () => {
  it("keeps stable source ID separate from the revision key", () => {
    const store = createStore();
    store.getState().setSource("source-1", "/clip.mov:10:20");
    expect(store.getState()).toMatchObject({
      sourceId: "source-1",
      sourceRevisionKey: "/clip.mov:10:20",
    });
  });

  it("preserves canonical edits and history when the source revision changes", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("-10"));
    store.getState().markOut(pts("20"));
    // Without this the next Mark In would adjust the completed segment instead.
    store.getState().finishSegment(null);
    store.getState().markIn(pts("30"));
    store.getState().setSource("source-1", "revision-1");
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().pendingInPts).toBe("30");

    store.getState().setSource("source-1", "revision-2");
    expect(store.getState()).toMatchObject({
      sourceId: "source-1",
      sourceRevisionKey: "revision-2",
      segments: [
        expect.objectContaining({ sourceId: "source-1", inPts: "-10", outPts: "20" }),
      ],
      pendingInPts: null,
      canUndo: true,
      canRedo: false,
    });
    store.getState().undo();
    expect(store.getState().segments).toEqual([]);
  });

  it("preserves ordered segments and history when the active source changes", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("20"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("30"));

    store.getState().setSource("source-2", "revision-2");
    expect(store.getState()).toMatchObject({
      sourceId: "source-2",
      sourceRevisionKey: "revision-2",
      pendingInPts: null,
      canUndo: true,
    });
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
    ]);

    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
      "source-2",
    ]);
    store.getState().undo();
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
    ]);
  });
});

describe("timeline store half-open editing", () => {
  it("stores Mark Out directly as the first excluded PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-40"));
    expect(store.getState().segments).toEqual([
      {
        id: "segment-1",
        sourceId: "source-1",
        inPts: pts("-100"),
        outPts: pts("-40"),
      },
    ]);
  });

  it("rejects equal and earlier Out points while preserving pending In", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("50"));
    store.getState().markOut(pts("50"));
    store.getState().markOut(pts("49"));
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().pendingInPts).toBe("50");
  });

  it("represents one frame with the following distinct PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("9001"));
    expect(store.getState().segments[0]).toMatchObject({
      inPts: "9000",
      outPts: "9001",
    });
  });

  it("preserves insertion order instead of sorting raw PTS", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-50"));
    expect(store.getState().segments.map((segment) => segment.inPts)).toEqual([
      "100",
      "-100",
    ]);
  });

  it("adjusts the current segment when New Segment does not end it first", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    // No New Segment, so the second pair moves the boundaries of the same segment.
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-50"));
    expect(shape(store)).toEqual([{ id: "segment-1", inPts: "-100", outPts: "-50" }]);
    expect(store.getState().currentSegmentId).toBe("segment-1");
  });

  it("splits at a strict interior PTS into adjacent half-open segments", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().split(pts("18"));
    expect(
      store.getState().segments.map(({ id, inPts, outPts }) => ({ id, inPts, outPts })),
    ).toEqual([
      { id: "segment-1", inPts: pts("10"), outPts: pts("18") },
      { id: "segment-2", inPts: pts("18"), outPts: pts("30") },
    ]);
  });

  it("splits only the active source and supports undo and redo", () => {
    const store = createTimelineStore(
      { generateId: () => "new" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        currentSegmentId: "a",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
          { id: "b", sourceId: "source-2", inPts: pts("10"), outPts: pts("30") },
        ],
      },
    );
    store.getState().split(pts("20"));
    expect(store.getState().segments.map((segment) => segment.sourceId)).toEqual([
      "source-1",
      "source-1",
      "source-2",
    ]);
    store.getState().undo();
    expect(store.getState().segments).toHaveLength(2);
    store.getState().redo();
    expect(store.getState().segments).toHaveLength(3);
  });

  it("restores pending In mark on undo after markOut and clears it on redo", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("9000"));
    expect(store.getState().pendingInPts).toBe(pts("9000"));

    store.getState().markOut(pts("27000"));
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().pendingInPts).toBeNull();
    expect(store.getState().canUndo).toBe(true);

    store.getState().undo();
    expect(store.getState().segments).toHaveLength(0);
    expect(store.getState().pendingInPts).toBe(pts("9000"));
    expect(store.getState().canUndo).toBe(false);
    expect(store.getState().canRedo).toBe(true);

    store.getState().redo();
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().pendingInPts).toBeNull();
    expect(store.getState().canUndo).toBe(true);
    expect(store.getState().canRedo).toBe(false);
  });

  it("does not restore a pending In mark from another source on undo or redo", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("27000"));

    store.getState().setSource("source-2", "revision-2");
    expect(store.getState().pendingInPts).toBeNull();
    expect(store.getState().canUndo).toBe(true);

    // The undo entry carries source-1's pending mark, which is not a PTS on source-2.
    store.getState().undo();
    expect(store.getState().segments).toHaveLength(0);
    expect(store.getState().pendingInPts).toBeNull();

    // With no pending mark, Mark Out on source-2 cannot complete a segment.
    store.getState().markOut(pts("18000"));
    expect(store.getState().segments).toHaveLength(0);

    store.getState().redo();
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().pendingInPts).toBeNull();
  });

  it("does not restore a pending In mark from an earlier revision of the same source", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("27000"));

    store.getState().setSource("source-1", "revision-2");
    store.getState().undo();
    expect(store.getState().pendingInPts).toBeNull();
  });
});

describe("timeline store current segment", () => {
  /** Builds A = [0, 100) first in the array, then B = [20, 80) painting on top of it. */
  function createOverlapping(): Store {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("100"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("20"));
    store.getState().markOut(pts("80"));
    return store;
  }

  it("splits the segment the user selected, not the first one that contains the playhead", () => {
    const store = createOverlapping();
    expect(store.getState().currentSegmentId).toBe("segment-2");

    store.getState().selectSegment("segment-2");
    store.getState().split(pts("50"));
    expect(shape(store)).toEqual([
      { id: "segment-1", inPts: "0", outPts: "100" },
      { id: "segment-2", inPts: "20", outPts: "50" },
      { id: "segment-3", inPts: "50", outPts: "80" },
    ]);

    store.getState().undo();
    store.getState().selectSegment("segment-1");
    store.getState().split(pts("50"));
    expect(shape(store)).toEqual([
      { id: "segment-1", inPts: "0", outPts: "50" },
      { id: "segment-4", inPts: "50", outPts: "100" },
      { id: "segment-2", inPts: "20", outPts: "80" },
    ]);
  });

  it("keeps the left half current after a split", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().split(pts("18"));
    expect(store.getState().currentSegmentId).toBe("segment-1");
    expect(store.getState().segments[0]).toMatchObject({
      id: "segment-1",
      outPts: "18",
    });

    // Undo restores the same target with no special case.
    store.getState().undo();
    expect(store.getState().currentSegmentId).toBe("segment-1");
  });

  it("does nothing when Split has no current segment", () => {
    const store = createOverlapping();
    store.getState().finishSegment(null);
    store.getState().split(pts("50"));
    expect(shape(store)).toEqual([
      { id: "segment-1", inPts: "0", outPts: "100" },
      { id: "segment-2", inPts: "20", outPts: "80" },
    ]);
  });

  it("rejects a boundary move that would not leave inPts < outPts", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));

    // Mark Out at or before the stored In point (ADR 002 forbids the empty segment). Mark In
    // at or after the stored Out point finishes the segment instead, which a later test covers.
    store.getState().markOut(pts("10"));
    store.getState().markOut(pts("5"));

    expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
    expect(store.getState().currentSegmentId).toBe("segment-1");
    // No history entry: one Undo still removes the segment.
    store.getState().undo();
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().canUndo).toBe(false);
  });

  it("rejects an equal or earlier Out point while completing a pending In mark", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("50"));
    store.getState().markOut(pts("50"));
    store.getState().markOut(pts("49"));
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();
    expect(store.getState().canUndo).toBe(false);
  });

  describe("Mark In at or after the Out of the current segment", () => {
    /** Mark In at 10 and Mark Out at 30: segment-1 = [10, 30) is current. */
    function createMarked(): Store {
      const store = createStore();
      store.getState().setSource("source-1", "revision-1");
      store.getState().markIn(pts("10"));
      store.getState().markOut(pts("30"));
      return store;
    }

    it("finishes the segment and starts a pending In there, as one action", () => {
      for (const at of ["30", "45"]) {
        const store = createMarked();
        store.getState().markIn(pts(at));
        expect(store.getState()).toMatchObject({
          currentSegmentId: null,
          pendingInPts: at,
          canUndo: true,
          canRedo: false,
        });
        // The finished segment is canonical and keeps its boundaries.
        expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
        expectOneInProgress(store);
      }
    });

    it("moves the In, and does not finish, at a frame before the Out", () => {
      const store = createMarked();
      // The last frame of [10, 30) is before the exclusive Out (ADR 002).
      store.getState().markIn(pts("29"));
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "29", outPts: "30" }]);

      // A frame before the In moves it earlier.
      store.getState().markIn(pts("5"));
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "5", outPts: "30" }]);
      expect(store.getState().currentSegmentId).toBe("segment-1");
    });

    it("compares the frame with the Out exactly, beyond the safe integer range", () => {
      const store = createTimelineStore(
        { generateId: () => "unused" },
        {
          sourceId: "source-1",
          sourceRevisionKey: "revision-1",
          segments: [
            {
              id: "a",
              sourceId: "source-1",
              inPts: pts("9007199254740990"),
              outPts: pts("9007199254740993"),
            },
          ],
          currentSegmentId: "a",
        },
      );
      // 9007199254740992 and 9007199254740993 are the same number as a double.
      store.getState().markIn(pts("9007199254740992"));
      expect(store.getState().currentSegmentId).toBe("a");
      expect(store.getState().segments[0].inPts).toBe("9007199254740992");

      store.getState().markIn(pts("9007199254740993"));
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: "9007199254740993",
      });
    });

    it("undoes in two steps: the segment is current again, then it is removed", () => {
      const store = createMarked();
      store.getState().markIn(pts("30"));

      // The first Undo restores the state before the action: the segment is current, and
      // no In is pending.
      store.getState().undo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
        canUndo: true,
        canRedo: true,
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expectOneInProgress(store);

      // The second Undo undoes Mark Out, as before: the segment is gone, and its In is pending.
      store.getState().undo();
      expect(store.getState()).toMatchObject({
        segments: [],
        currentSegmentId: null,
        pendingInPts: "10",
        canUndo: false,
        canRedo: true,
      });
      expectOneInProgress(store);
    });

    it("redoes the action after an undo", () => {
      const store = createMarked();
      store.getState().markIn(pts("45"));
      store.getState().undo();
      store.getState().undo();

      store.getState().redo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
        canUndo: true,
        canRedo: true,
      });

      store.getState().redo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: "45",
        canUndo: true,
        canRedo: false,
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expectOneInProgress(store);
    });

    it("clears the redo stack, as every other edit does", () => {
      const store = createMarked();
      store.getState().markOut(pts("40"));
      store.getState().undo();
      expect(store.getState().canRedo).toBe(true);

      store.getState().markIn(pts("30"));
      expect(store.getState().canRedo).toBe(false);
      store.getState().redo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: "30",
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
    });

    it("lets Mark Out complete the next segment, and undo returns through both", () => {
      const store = createMarked();
      store.getState().markIn(pts("30"));
      store.getState().markOut(pts("50"));
      expect(shape(store)).toEqual([
        { id: "segment-1", inPts: "10", outPts: "30" },
        { id: "segment-2", inPts: "30", outPts: "50" },
      ]);
      expect(store.getState().currentSegmentId).toBe("segment-2");

      // Undo of Mark Out keeps the pending In of the action, as after any Mark In.
      store.getState().undo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: "30",
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);

      store.getState().undo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
      });
    });

    it("restores no pending In from an earlier revision, and keeps the segment", () => {
      const store = createMarked();
      store.getState().markIn(pts("30"));

      // A revision change clears the pending In. Canonical segments survive it, so Undo
      // still makes the segment current (ADR 007).
      store.getState().setSource("source-1", "revision-2");
      expect(store.getState().pendingInPts).toBeNull();
      store.getState().undo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
      });

      // The redo entry was captured after the revision change cleared the pending In, so it
      // holds none. Nothing is current after the redo either.
      store.getState().redo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: null,
      });
      expectOneInProgress(store);
    });

    it("does not redo a pending In of an earlier revision", () => {
      const store = createMarked();
      store.getState().markIn(pts("30"));

      // Undo on the same revision captures a redo entry that holds the pending In "30".
      store.getState().undo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: "segment-1",
        pendingInPts: null,
      });

      // After a revision change, that pending In belongs to the earlier revision, so the redo
      // does not bring it back, and nothing is current. The segment does not change.
      store.getState().setSource("source-1", "revision-2");
      store.getState().redo();
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: null,
      });
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expectOneInProgress(store);
    });

    it("leaves a current segment that does not parse to the boundary move", () => {
      const store = createTimelineStore(
        { generateId: () => "unused" },
        {
          sourceId: "source-1",
          sourceRevisionKey: "revision-1",
          segments: [
            { id: "bad", sourceId: "source-1", inPts: pts("10"), outPts: pts("030") },
          ],
          currentSegmentId: "bad",
        },
      );
      // The Out does not parse, so the store cannot tell whether the frame is after it, and
      // the move to a range that is not valid changes nothing.
      store.getState().markIn(pts("40"));
      expect(store.getState()).toMatchObject({
        currentSegmentId: "bad",
        pendingInPts: null,
        canUndo: false,
      });
      expect(shape(store)).toEqual([{ id: "bad", inPts: "10", outPts: "030" }]);
    });
  });

  describe("Mark Out on the Out of the current segment", () => {
    it("finishes the segment, moves no point, and adds no history entry", () => {
      const store = createStore();
      store.getState().setSource("source-1", "revision-1");
      store.getState().markIn(pts("10"));
      store.getState().markOut(pts("30"));
      expect(store.getState().currentSegmentId).toBe("segment-1");

      store.getState().markOut(pts("30"));
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: null,
      });
      expectOneInProgress(store);

      // The finish is not an edit, so the first Undo undoes the Mark Out that made the segment.
      store.getState().undo();
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInPts).toBe("10");
    });

    it("compares the frame with the Out exactly, and moves the Out elsewhere", () => {
      const store = createStore();
      store.getState().setSource("source-1", "revision-1");
      store.getState().markIn(pts("9007199254740990"));
      store.getState().markOut(pts("9007199254740993"));
      // A number would round both values to the same double. BigInt does not.
      store.getState().markOut(pts("9007199254740992"));
      expect(store.getState().currentSegmentId).toBe("segment-1");
      expect(shape(store)).toEqual([
        { id: "segment-1", inPts: "9007199254740990", outPts: "9007199254740992" },
      ]);
    });
  });

  describe("Finish Segment", () => {
    it("completes a pending In at the given Out, leaves nothing current, and undoes", () => {
      const store = createStore();
      store.getState().setSource("source-1", "revision-1");
      store.getState().markIn(pts("10"));

      store.getState().finishSegment(pts("30"));
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: null,
        canUndo: true,
        canRedo: false,
      });

      // One history entry: Undo brings the pending In back, and Redo makes the segment again.
      store.getState().undo();
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().pendingInPts).toBe("10");
      store.getState().redo();
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expect(store.getState().pendingInPts).toBeNull();
      expect(store.getState().currentSegmentId).toBeNull();
    });

    it("drops a pending In that the Out cannot complete, with no history entry", () => {
      for (const outPts of [null, pts("10"), pts("5"), pts("x")]) {
        const store = createStore();
        store.getState().setSource("source-1", "revision-1");
        store.getState().markIn(pts("10"));
        store.getState().finishSegment(outPts);
        expect(store.getState()).toMatchObject({
          segments: [],
          pendingInPts: null,
          currentSegmentId: null,
          canUndo: false,
        });
      }
    });

    it("only ends a current segment, whatever the Out", () => {
      const store = createStore();
      store.getState().setSource("source-1", "revision-1");
      store.getState().markIn(pts("10"));
      store.getState().markOut(pts("30"));
      store.getState().finishSegment(pts("50"));
      expect(shape(store)).toEqual([{ id: "segment-1", inPts: "10", outPts: "30" }]);
      expect(store.getState().currentSegmentId).toBeNull();
      // The undo stack holds the Mark Out only.
      store.getState().undo();
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().canUndo).toBe(false);
    });

    it("makes no segment while no source is active", () => {
      const store = createStore();
      store.getState().finishSegment(pts("30"));
      expect(store.getState().segments).toEqual([]);
      expect(store.getState().canUndo).toBe(false);
    });
  });

  it("records no history for a boundary equal to the stored one", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().undo();
    expect(store.getState().canUndo).toBe(false);
    store.getState().redo();

    // Scrubbing back onto a stored boundary must not fill the undo stack.
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().undo();
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().canUndo).toBe(false);
  });

  it("holds one thing in progress at a time", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    expectOneInProgress(store);

    store.getState().markIn(pts("10"));
    expect(store.getState().pendingInPts).toBe("10");
    // A pending mark alone is not a canonical edit.
    expect(store.getState().canUndo).toBe(false);
    expectOneInProgress(store);

    store.getState().markOut(pts("30"));
    expect(store.getState().currentSegmentId).toBe("segment-1");
    expect(store.getState().pendingInPts).toBeNull();
    expectOneInProgress(store);

    store.getState().markIn(pts("12"));
    expectOneInProgress(store);

    store.getState().finishSegment(null);
    expect(store.getState()).toMatchObject({
      currentSegmentId: null,
      pendingInPts: null,
    });
    // New Segment ends a segment that is already canonical, so it adds no history.
    store.getState().markIn(pts("40"));
    store.getState().markOut(pts("60"));
    expectOneInProgress(store);

    // Selection clears the pending mark of a segment that was still being built.
    store.getState().finishSegment(null);
    store.getState().markIn(pts("70"));
    store.getState().selectSegment("segment-1");
    expect(store.getState().pendingInPts).toBeNull();
    expectOneInProgress(store);

    // An adjusting Mark Out, a split and a delete each write `segments` while touching
    // neither selection field, so they are the writes where a future edit could break
    // the invariant unnoticed. The current segment here is `segment-1`, [12, 30).
    store.getState().markOut(pts("28"));
    expect(shape(store)[0]).toEqual({ id: "segment-1", inPts: "12", outPts: "28" });
    expectOneInProgress(store);

    store.getState().split(pts("20"));
    expect(shape(store).slice(0, 2)).toEqual([
      { id: "segment-1", inPts: "12", outPts: "20" },
      { id: "segment-3", inPts: "20", outPts: "28" },
    ]);
    expectOneInProgress(store);

    // The split left `segment-1` current, so Delete has a named target.
    store.getState().deleteSegment();
    expect(store.getState().currentSegmentId).toBeNull();
    expect(shape(store).map((segment) => segment.id)).toEqual([
      "segment-3",
      "segment-2",
    ]);
    expectOneInProgress(store);

    store.getState().undo();
    expectOneInProgress(store);
    store.getState().redo();
    expectOneInProgress(store);
  });

  it("refuses to select an unknown ID or a segment of another source", () => {
    const store = createTimelineStore(
      { generateId: () => "new" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
          { id: "b", sourceId: "source-2", inPts: pts("10"), outPts: pts("30") },
        ],
        pendingInPts: pts("5"),
      },
    );

    store.getState().selectSegment("missing");
    expect(store.getState().currentSegmentId).toBeNull();
    store.getState().selectSegment("b");
    expect(store.getState().currentSegmentId).toBeNull();
    // A refused selection changes nothing at all, including the pending mark.
    expect(store.getState().pendingInPts).toBe("5");

    store.getState().selectSegment("a");
    expect(store.getState().currentSegmentId).toBe("a");
    expect(store.getState().pendingInPts).toBeNull();
  });

  it("deletes the current segment, preserves export order, and selects nothing", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("10"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("20"));
    store.getState().markOut(pts("30"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("40"));
    store.getState().markOut(pts("50"));

    store.getState().selectSegment("segment-2");
    store.getState().deleteSegment();
    expect(store.getState().segments.map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-3",
    ]);
    expect(store.getState().currentSegmentId).toBeNull();

    // Nothing is current, so a further Delete or Split cannot act on an unnamed segment.
    store.getState().deleteSegment();
    store.getState().split(pts("5"));
    expect(store.getState().segments.map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-3",
    ]);

    store.getState().undo();
    expect(store.getState().segments.map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-2",
      "segment-3",
    ]);
    expect(store.getState().currentSegmentId).toBe("segment-2");
  });

  it("restores the current segment across a revision change but not across a source change", () => {
    const store = createStore();
    store.getState().setSource("source-1", "revision-1");
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    store.getState().markOut(pts("40"));
    expect(store.getState().currentSegmentId).toBe("segment-1");

    // Canonical segments survive a revision change, so the selection survives with them.
    store.getState().setSource("source-1", "revision-2");
    store.getState().undo();
    expect(store.getState().segments[0]).toMatchObject({ outPts: "30" });
    expect(store.getState().currentSegmentId).toBe("segment-1");

    // A segment of another source can never be the target on this timeline.
    store.getState().setSource("source-2", "revision-3");
    store.getState().redo();
    expect(store.getState().segments[0]).toMatchObject({ outPts: "40" });
    expect(store.getState().currentSegmentId).toBeNull();
  });

  it("does not restore a current segment ID that the restored array does not hold", () => {
    const store = createTimelineStore(
      { generateId: () => "made" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        currentSegmentId: "ghost",
      },
    );

    // An unknown ID resolves to nothing, so Mark In starts a segment instead of adjusting.
    store.getState().markIn(pts("10"));
    store.getState().markOut(pts("30"));
    expect(store.getState().currentSegmentId).toBe("made");

    // The undo entry still carries the stale ID, and its array holds no such segment.
    store.getState().undo();
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();
  });
});

describe("timeline store trimSegmentEdge", () => {
  /** A store with two segments of source-1, and one of source-2 between them. */
  function createTrimStore() {
    return createTimelineStore(
      { generateId: () => "unused" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("100"), outPts: pts("200") },
          { id: "foreign", sourceId: "source-2", inPts: pts("0"), outPts: pts("50") },
          { id: "b", sourceId: "source-1", inPts: pts("300"), outPts: pts("400") },
        ],
        currentSegmentId: "b",
      },
    );
  }

  it("moves one boundary of the named segment with one history entry", () => {
    const store = createTrimStore();
    store.getState().trimSegmentEdge("a", "in", pts("120"));
    expect(shape(store)).toEqual([
      { id: "a", inPts: "120", outPts: "200" },
      { id: "foreign", inPts: "0", outPts: "50" },
      { id: "b", inPts: "300", outPts: "400" },
    ]);
    expect(store.getState().canUndo).toBe(true);

    store.getState().trimSegmentEdge("a", "out", pts("250"));
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "120", outPts: "250" });

    // Each trim is one undo step.
    store.getState().undo();
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "120", outPts: "200" });
    store.getState().undo();
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "100", outPts: "200" });
    expect(store.getState().canUndo).toBe(false);

    store.getState().redo();
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "120", outPts: "200" });
  });

  it("names its segment and not the current one, and keeps the selection", () => {
    const store = createTrimStore();
    store.getState().trimSegmentEdge("a", "out", pts("150"));
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "100", outPts: "150" });
    expect(shape(store)[2]).toEqual({ id: "b", inPts: "300", outPts: "400" });
    expect(store.getState().currentSegmentId).toBe("b");
    expect(store.getState().pendingInPts).toBeNull();
  });

  it("allows an overlap with a neighbour and keeps the array order", () => {
    const store = createTrimStore();
    // Overlap stays allowed (ADR 007, ADR 030), and the export order is the array order.
    store.getState().trimSegmentEdge("a", "out", pts("350"));
    expect(shape(store).map(({ id }) => id)).toEqual(["a", "foreign", "b"]);
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "100", outPts: "350" });
  });

  it("makes no change and no history entry for a move that breaks inPts < outPts", () => {
    const store = createTrimStore();
    const before = store.getState().segments;
    store.getState().trimSegmentEdge("a", "in", pts("200"));
    store.getState().trimSegmentEdge("a", "in", pts("250"));
    store.getState().trimSegmentEdge("a", "out", pts("100"));
    store.getState().trimSegmentEdge("a", "out", pts("50"));
    expect(store.getState().segments).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  it("makes no history entry for a boundary equal to the stored one", () => {
    const store = createTrimStore();
    const before = store.getState().segments;
    store.getState().trimSegmentEdge("a", "in", pts("100"));
    store.getState().trimSegmentEdge("a", "out", pts("200"));
    expect(store.getState().segments).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  it("refuses an unknown segment, a segment of another source, and a malformed PTS", () => {
    const store = createTrimStore();
    const before = store.getState().segments;
    store.getState().trimSegmentEdge("ghost", "in", pts("120"));
    store.getState().trimSegmentEdge("foreign", "in", pts("10"));
    store.getState().trimSegmentEdge("a", "in", pts("01"));
    store.getState().trimSegmentEdge("a", "in", pts("1.5"));
    expect(store.getState().segments).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  it("refuses every move while no source is active", () => {
    const store = createTrimStore();
    store.getState().setSource(null, null);
    const before = store.getState().segments;
    store.getState().trimSegmentEdge("a", "in", pts("120"));
    expect(store.getState().segments).toBe(before);
    expect(store.getState().canUndo).toBe(false);
  });

  it("clears the redo stack, as every other edit does", () => {
    const store = createTrimStore();
    store.getState().trimSegmentEdge("a", "in", pts("120"));
    store.getState().undo();
    expect(store.getState().canRedo).toBe(true);
    store.getState().trimSegmentEdge("a", "in", pts("130"));
    expect(store.getState().canRedo).toBe(false);
    store.getState().redo();
    expect(shape(store)[0]).toEqual({ id: "a", inPts: "130", outPts: "200" });
  });
});
