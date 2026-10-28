import { describe, expect, it } from "vitest";
import type { Clip, Pts, Segment } from "@/types/project";
import { findCurrentSegment } from "./math";
import {
  createTimelineStore,
  singleClipIdOf,
  type TimelineStoreDependencies,
} from "./store";
import type { SequenceSource } from "./sequence";
import { TEST_SOURCE } from "./storeTestSupport";
import { toVirtualPts } from "./virtualTime";

const pts = (value: string) => value as Pts;

function createStore() {
  let nextId = 1;
  return createTimelineStore({ generateId: () => `segment-${nextId++}` });
}

type Store = ReturnType<typeof createStore>;

/** An initial state in the one-source shape of ADR 007, as these tests were written. */
interface LegacyInitialState {
  readonly sourceId?: string | null;
  readonly sourceRevisionKey?: string | null;
  readonly segments?: readonly Segment[];
  readonly pendingInPts?: Pts | null;
  readonly currentSegmentId?: string | null;
  readonly selectedSegmentIds?: readonly string[];
}

/**
 * A store from an initial state in the one-source shape. The active source is the one clip of
 * the sequence, and each segment lies on the clip of its own source. A segment of another source
 * is therefore not on the sequence, as a segment of an inactive source was not active.
 */
function createLegacyStore(
  dependencies: TimelineStoreDependencies,
  legacy: LegacyInitialState = {},
): ReturnType<typeof createTimelineStore> {
  const active = legacy.sourceId ?? null;
  const sourceIds = new Set<string>(
    [active, ...(legacy.segments ?? []).map((segment) => segment.sourceId)].filter(
      (id): id is string => id !== null,
    ),
  );
  const activeClipId = active === null ? null : singleClipIdOf(active);
  return createTimelineStore(dependencies, {
    clips: active === null ? [] : [{ id: singleClipIdOf(active), sourceId: active }],
    sequenceSources: Object.fromEntries(
      [...sourceIds].map((id) => [id, { ...TEST_SOURCE, id }]),
    ),
    sequenceSegments: (legacy.segments ?? []).map((segment) => ({
      id: segment.id,
      inClipId: singleClipIdOf(segment.sourceId),
      inPts: segment.inPts,
      outClipId: singleClipIdOf(segment.sourceId),
      outPts: segment.outPts,
    })),
    pendingIn:
      legacy.pendingInPts == null || activeClipId === null
        ? null
        : { clipId: activeClipId, pts: legacy.pendingInPts },
    attachedClipId: activeClipId,
    generation: active === null ? 0 : 1,
    selectedSegmentIds: legacy.selectedSegmentIds,
    currentSegmentId: legacy.currentSegmentId ?? null,
  });
}

/**
 * Makes the one clip of a source with the ID `sourceId` the sequence (ADR 052). A source of the
 * widest range keeps every PTS of these tests inside its clip. The revision key of ADR 007 is
 * part of the source ID now: a changed file is a new source (ADR 010).
 */
function show(store: Store, sourceId: string | null) {
  store
    .getState()
    .showOnlySource(sourceId === null ? null : { ...TEST_SOURCE, id: sourceId });
}

/**
 * Reads the anchored segments as plain comparable records, in project array order. A segment of
 * a source that is not on the sequence stays in this list, in its place (ADR 052).
 */
function shape(store: Store) {
  return store
    .getState()
    .sequenceSegments.map(({ id, inPts, outPts }) => ({ id, inPts, outPts }));
}

/** Reads the segments on the sequence, as the interface sees them. */
function visible(store: Store) {
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
  // The selection invariants (ADR 045): the current segment is the only selected one, and no
  // In mark is pending while a segment is selected.
  expect(state.currentSegmentId).toBe(
    state.selectedSegmentIds.length === 1 ? state.selectedSegmentIds[0] : null,
  );
  expect(state.selectedSegmentIds.length > 0 && state.pendingInPts !== null).toBe(
    false,
  );
}

/** Makes three finished segments, `segment-1` to `segment-3`, with nothing selected. */
function threeSegments(): Store {
  const store = createStore();
  show(store, "source-1");
  for (const [inPts, outPts] of [
    ["0", "10"],
    ["20", "30"],
    ["40", "50"],
  ] as const) {
    store.getState().markIn(pts(inPts));
    store.getState().markOut(pts(outPts));
    store.getState().finishSegment(null);
  }
  return store;
}

describe("timeline store source ownership (ADR 052)", () => {
  it("shows the one clip of a source as the virtual source of a new generation", () => {
    const store = createStore();
    show(store, "source-1");
    expect(store.getState()).toMatchObject({
      clips: [{ id: singleClipIdOf("source-1"), sourceId: "source-1" }],
      attachedClipId: singleClipIdOf("source-1"),
      sourceId: "sequence:1",
      sourceRevisionKey: "sequence:1",
    });
    // The same source again keeps its clip, its generation and its history. Only its facts
    // refresh.
    const before = store.getState();
    show(store, "source-1");
    expect(store.getState().clips).toBe(before.clips);
    expect(store.getState().sourceId).toBe(before.sourceId);
    const facts = { ...TEST_SOURCE, id: "source-1", videoEndPts: pts("90000") };
    store.getState().showOnlySource(facts);
    expect(store.getState().sequenceSources["source-1"]).toBe(facts);
    expect(store.getState().clips).toBe(before.clips);
  });

  it("keeps the segments of a replaced file and brings them back with its clip", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("-10"));
    store.getState().markOut(pts("20"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("30"));

    // Another file (or a changed file, which is a new source) replaces the open one (ADR 027).
    show(store, "source-2");
    expect(store.getState()).toMatchObject({
      sourceId: "sequence:2",
      segments: [],
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
    });
    expect(store.getState().sequenceSegments).toHaveLength(1);

    show(store, "source-1");
    expect(store.getState()).toMatchObject({
      sourceId: "sequence:3",
      segments: [
        expect.objectContaining({ sourceId: "sequence:3", inPts: "-10", outPts: "20" }),
      ],
      pendingInPts: null,
    });
  });

  it("empties the sequence with no source", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("10"));
    show(store, null);
    expect(store.getState()).toMatchObject({
      clips: [],
      sourceId: null,
      sourceRevisionKey: null,
      segments: [],
      pendingInPts: null,
    });
  });
});

describe("timeline store half-open editing", () => {
  it("stores Mark Out directly as the first excluded PTS", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("-100"));
    store.getState().markOut(pts("-40"));
    expect(store.getState().segments).toEqual([
      {
        id: "segment-1",
        sourceId: "sequence:1",
        inPts: pts("-100"),
        outPts: pts("-40"),
      },
    ]);
    expect(store.getState().sequenceSegments).toEqual([
      {
        id: "segment-1",
        inClipId: singleClipIdOf("source-1"),
        inPts: pts("-100"),
        outClipId: singleClipIdOf("source-1"),
        outPts: pts("-40"),
      },
    ]);
  });

  it("rejects equal and earlier Out points while preserving pending In", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("50"));
    store.getState().markOut(pts("50"));
    store.getState().markOut(pts("49"));
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().pendingInPts).toBe("50");
  });

  it("represents one frame with the following distinct PTS", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("9001"));
    expect(store.getState().segments[0]).toMatchObject({
      inPts: "9000",
      outPts: "9001",
    });
  });

  it("preserves insertion order instead of sorting raw PTS", () => {
    const store = createStore();
    show(store, "source-1");
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
    show(store, "source-1");
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
    show(store, "source-1");
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

  it("splits only a segment on the sequence and supports undo and redo", () => {
    const store = createLegacyStore(
      { generateId: () => "new" },
      {
        sourceId: "source-1",
        currentSegmentId: "a",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
          { id: "b", sourceId: "source-2", inPts: pts("10"), outPts: pts("30") },
        ],
      },
    );
    store.getState().split(pts("20"));
    expect(visible(store)).toEqual([
      { id: "a", inPts: "10", outPts: "20" },
      { id: "new", inPts: "20", outPts: "30" },
    ]);
    // The segment of the other source stays in the array, after the parts, in its place.
    expect(store.getState().sequenceSegments.map((segment) => segment.id)).toEqual([
      "a",
      "new",
      "b",
    ]);
    store.getState().undo();
    expect(store.getState().segments).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().segments).toHaveLength(2);
  });

  it("restores pending In mark on undo after markOut and clears it on redo", () => {
    const store = createStore();
    show(store, "source-1");
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

  it("clears the history when another file replaces the open one", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("9000"));
    store.getState().markOut(pts("27000"));
    expect(store.getState().canUndo).toBe(true);

    show(store, "source-2");
    expect(store.getState()).toMatchObject({
      pendingInPts: null,
      canUndo: false,
      canRedo: false,
    });
    store.getState().undo();
    expect(store.getState().sequenceSegments).toHaveLength(1);

    // With no pending mark, Mark Out on source-2 cannot complete a segment.
    store.getState().markOut(pts("18000"));
    expect(store.getState().segments).toHaveLength(0);
  });
});

describe("timeline store current segment", () => {
  /** Builds A = [0, 100) first in the array, then B = [20, 80) painting on top of it. */
  function createOverlapping(): Store {
    const store = createStore();
    show(store, "source-1");
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
    show(store, "source-1");
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
    show(store, "source-1");
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
    show(store, "source-1");
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
      show(store, "source-1");
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
      const store = createLegacyStore(
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

    it("does not resolve a current segment that does not parse", () => {
      const store = createLegacyStore(
        { generateId: () => "unused" },
        {
          sourceId: "source-1",
          segments: [
            { id: "bad", sourceId: "source-1", inPts: pts("10"), outPts: pts("030") },
          ],
          currentSegmentId: "bad",
        },
      );
      // A boundary that does not parse keeps the segment off the sequence (ADR 052), so it is
      // in the array but not current, and Mark In starts a pending In.
      expect(store.getState().segments).toEqual([]);
      store.getState().markIn(pts("40"));
      expect(store.getState()).toMatchObject({
        currentSegmentId: null,
        pendingInPts: "40",
        canUndo: false,
      });
      expect(store.getState().sequenceSegments.map((segment) => segment.id)).toEqual([
        "bad",
      ]);
    });
  });

  describe("Mark Out on the Out of the current segment", () => {
    it("finishes the segment, moves no point, and adds no history entry", () => {
      const store = createStore();
      show(store, "source-1");
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
      show(store, "source-1");
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
      show(store, "source-1");
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
        show(store, "source-1");
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
      show(store, "source-1");
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
    show(store, "source-1");
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
    show(store, "source-1");
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
    store.getState().deleteSelectedSegments();
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
    const store = createLegacyStore(
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
    show(store, "source-1");
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("10"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("20"));
    store.getState().markOut(pts("30"));
    store.getState().finishSegment(null);
    store.getState().markIn(pts("40"));
    store.getState().markOut(pts("50"));

    store.getState().selectSegment("segment-2");
    store.getState().deleteSelectedSegments();
    expect(store.getState().segments.map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-3",
    ]);
    expect(store.getState().currentSegmentId).toBeNull();

    // Nothing is current, so a further Delete or Split cannot act on an unnamed segment.
    store.getState().deleteSelectedSegments();
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

  it("does not restore a current segment ID that the restored array does not hold", () => {
    const store = createLegacyStore(
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

describe("timeline store selection of several segments", () => {
  it("toggles segments into the selection in project order, with no history entry", () => {
    const store = threeSegments();

    store.getState().toggleSegmentSelection("segment-3");
    expect(store.getState().selectedSegmentIds).toEqual(["segment-3"]);
    // One selected segment is current, as after a plain click.
    expect(store.getState().currentSegmentId).toBe("segment-3");

    store.getState().toggleSegmentSelection("segment-1");
    expect(store.getState().selectedSegmentIds).toEqual(["segment-1", "segment-3"]);
    expect(store.getState().currentSegmentId).toBeNull();
    expectOneInProgress(store);

    store.getState().toggleSegmentSelection("segment-3");
    expect(store.getState().selectedSegmentIds).toEqual(["segment-1"]);
    expect(store.getState().currentSegmentId).toBe("segment-1");

    store.getState().toggleSegmentSelection("segment-1");
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();

    // The toggles added no history entry, so one undo undoes the last edit: the Mark Out
    // that made `segment-3`.
    store.getState().undo();
    expect(shape(store).map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-2",
    ]);
  });

  it("refuses to toggle an unknown ID or a segment of another source", () => {
    const store = createLegacyStore(
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

    store.getState().toggleSegmentSelection("missing");
    store.getState().toggleSegmentSelection("b");
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().pendingInPts).toBe("5");

    // A toggle that selects clears the pending In mark, as a plain click does.
    store.getState().toggleSegmentSelection("a");
    expect(store.getState().selectedSegmentIds).toEqual(["a"]);
    expect(store.getState().pendingInPts).toBeNull();
  });

  it("selects every segment of the active source and clears the pending In mark", () => {
    const store = createLegacyStore(
      { generateId: () => "new" },
      {
        sourceId: "source-1",
        sourceRevisionKey: "revision-1",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
          { id: "b", sourceId: "source-2", inPts: pts("10"), outPts: pts("30") },
          { id: "c", sourceId: "source-1", inPts: pts("40"), outPts: pts("60") },
        ],
        pendingInPts: pts("5"),
      },
    );

    store.getState().selectAllSegments();
    expect(store.getState().selectedSegmentIds).toEqual(["a", "c"]);
    expect(store.getState().currentSegmentId).toBeNull();
    expect(store.getState().pendingInPts).toBeNull();
    expect(store.getState().canUndo).toBe(false);
  });

  it("makes the only segment current when Select All selects one segment", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("10"));
    store.getState().finishSegment(null);

    store.getState().selectAllSegments();
    expect(store.getState().selectedSegmentIds).toEqual(["segment-1"]);
    expect(store.getState().currentSegmentId).toBe("segment-1");
  });

  it("changes nothing on Select All when the active source has no segment", () => {
    const store = createStore();
    show(store, "source-1");
    store.getState().markIn(pts("5"));

    store.getState().selectAllSegments();
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().pendingInPts).toBe("5");
  });

  it("deletes every selected segment as one edit, and undo selects them again", () => {
    const store = threeSegments();
    store.getState().toggleSegmentSelection("segment-1");
    store.getState().toggleSegmentSelection("segment-3");

    store.getState().deleteSelectedSegments();
    expect(shape(store).map((segment) => segment.id)).toEqual(["segment-2"]);
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();
    expectOneInProgress(store);

    // One undo restores both segments, in their old places, and selects them again.
    store.getState().undo();
    expect(shape(store).map((segment) => segment.id)).toEqual([
      "segment-1",
      "segment-2",
      "segment-3",
    ]);
    expect(store.getState().selectedSegmentIds).toEqual(["segment-1", "segment-3"]);
    expect(store.getState().currentSegmentId).toBeNull();
    expectOneInProgress(store);

    store.getState().redo();
    expect(shape(store).map((segment) => segment.id)).toEqual(["segment-2"]);
    expect(store.getState().selectedSegmentIds).toEqual([]);
  });

  it("deletes every segment after Select All", () => {
    const store = threeSegments();
    store.getState().selectAllSegments();
    store.getState().deleteSelectedSegments();
    expect(store.getState().segments).toEqual([]);

    store.getState().undo();
    expect(store.getState().segments).toHaveLength(3);
    expect(store.getState().selectedSegmentIds).toEqual([
      "segment-1",
      "segment-2",
      "segment-3",
    ]);
  });

  it("selects only the clicked segment after a selection of several", () => {
    const store = threeSegments();
    store.getState().selectAllSegments();
    store.getState().selectSegment("segment-2");
    expect(store.getState().selectedSegmentIds).toEqual(["segment-2"]);
    expect(store.getState().currentSegmentId).toBe("segment-2");
  });

  it("ends a selection of several on Mark In and on Finish Segment", () => {
    const store = threeSegments();
    store.getState().selectAllSegments();

    // Nothing is current, so Mark In starts a segment, and the selection ends.
    store.getState().markIn(pts("60"));
    expect(store.getState().pendingInPts).toBe("60");
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expectOneInProgress(store);

    store.getState().selectAllSegments();
    store.getState().finishSegment(null);
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();
  });

  it("gives Split and Mark Out no target while several segments are selected", () => {
    const store = threeSegments();
    store.getState().toggleSegmentSelection("segment-1");
    store.getState().toggleSegmentSelection("segment-2");

    store.getState().split(pts("5"));
    store.getState().markOut(pts("25"));
    expect(shape(store)).toEqual([
      { id: "segment-1", inPts: "0", outPts: "10" },
      { id: "segment-2", inPts: "20", outPts: "30" },
      { id: "segment-3", inPts: "40", outPts: "50" },
    ]);
  });

  it("starts with the current segment selected when a test gives it alone", () => {
    const store = createLegacyStore(
      {},
      {
        sourceId: "source-1",
        segments: [
          { id: "a", sourceId: "source-1", inPts: pts("10"), outPts: pts("30") },
        ],
        currentSegmentId: "a",
      },
    );
    expect(store.getState().selectedSegmentIds).toEqual(["a"]);
  });

  it("clears the selection on reset", () => {
    const store = threeSegments();
    store.getState().selectAllSegments();
    store.getState().reset();
    expect(store.getState().selectedSegmentIds).toEqual([]);
    expect(store.getState().currentSegmentId).toBeNull();
  });
});

describe("timeline store trimSegmentEdge", () => {
  /** A store with two segments of source-1, and one of source-2 between them. */
  function createTrimStore() {
    return createLegacyStore(
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
    show(store, null);
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

describe("timeline store on a sequence of clips (ADR 052)", () => {
  const A: SequenceSource = {
    id: "A",
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: pts("0"),
    videoEndPts: pts("10000"),
    videoDurationTicks: null,
    approximateDurationSeconds: 10,
  };
  const B: SequenceSource = {
    id: "B",
    videoTimeBase: { n: 1, d: 90000 },
    videoStartPts: pts("9000"),
    videoEndPts: pts("459000"),
    videoDurationTicks: null,
    approximateDurationSeconds: 5,
  };
  const a1: Clip = { id: "a1", sourceId: "A" };
  const b1: Clip = { id: "b1", sourceId: "B" };

  /** A store of the clips a1 (10 s) and b1 (5 s). The virtual time base is 1/90000. */
  function twoClips() {
    let nextId = 1;
    const store = createTimelineStore({ generateId: () => `segment-${nextId++}` });
    expect(store.getState().insertClips(0, [a1, b1], [A, B])).toBe(true);
    return store;
  }

  /** The virtual PTS of a point on a clip. */
  function virtual(
    store: ReturnType<typeof twoClips>,
    clipId: string,
    value: string,
  ): Pts {
    const timeline = store.getState().virtual;
    const result = timeline && toVirtualPts(timeline, { clipId, pts: pts(value) });
    if (!result) throw new Error("virtual");
    return result;
  }

  it("lays the clips out end to end on one virtual axis", () => {
    const store = twoClips();
    expect(store.getState()).toMatchObject({
      sourceId: "sequence:1",
      clips: [a1, b1],
      canUndo: true,
    });
    expect(store.getState().virtual?.timeBase).toEqual({ n: 1, d: 90000 });
    expect(virtual(store, "a1", "10000")).toBe(virtual(store, "b1", "9000"));
  });

  it("marks a segment across the junction on the attached clips", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    store.getState().markIn(virtual(store, "a1", "8000"));
    store.getState().setAttachedClip("b1");
    store.getState().markOut(virtual(store, "b1", "99000"));
    expect(store.getState().sequenceSegments).toEqual([
      {
        id: "segment-1",
        inClipId: "a1",
        inPts: "8000",
        outClipId: "b1",
        outPts: "99000",
      },
    ]);
    expect(store.getState().segments).toEqual([
      {
        id: "segment-1",
        sourceId: "sequence:1",
        inPts: virtual(store, "a1", "8000"),
        outPts: virtual(store, "b1", "99000"),
      },
    ]);
  });

  it("writes an Out on the first frame of a clip as the end of the clip before it", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    store.getState().markIn(virtual(store, "a1", "8000"));
    store.getState().setAttachedClip("b1");
    store.getState().markOut(virtual(store, "b1", "9000"));
    expect(store.getState().sequenceSegments[0]).toMatchObject({
      outClipId: "a1",
      outPts: "10000",
    });
  });

  it("splits a crossing segment at the junction into two segments that meet there", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    store.getState().markIn(virtual(store, "a1", "8000"));
    store.getState().setAttachedClip("b1");
    store.getState().markOut(virtual(store, "b1", "99000"));
    store.getState().split(virtual(store, "b1", "9000"));
    expect(store.getState().sequenceSegments).toEqual([
      {
        id: "segment-1",
        inClipId: "a1",
        inPts: "8000",
        outClipId: "a1",
        outPts: "10000",
      },
      {
        id: "segment-2",
        inClipId: "b1",
        inPts: "9000",
        outClipId: "b1",
        outPts: "99000",
      },
    ]);
    expect(store.getState().currentSegmentId).toBe("segment-1");
  });

  it("refuses a virtual PTS that the attached clip does not hold on its grid", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    // A tick of 1/90000 between two ticks of 1/1000 is no frame of a1.
    const off = (BigInt(virtual(store, "a1", "5000")) + 1n).toString() as Pts;
    store.getState().markIn(off);
    expect(store.getState().pendingIn).toBeNull();
  });

  it("moves a clip, splits the crossing segment, and undoes both as one edit", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    store.getState().markIn(virtual(store, "a1", "8000"));
    store.getState().setAttachedClip("b1");
    store.getState().markOut(virtual(store, "b1", "99000"));
    store.getState().finishSegment(null);

    store.getState().moveClip(1, 0);
    expect(store.getState().clips).toEqual([b1, a1]);
    expect(store.getState().sequenceSegments).toEqual([
      {
        id: "segment-1",
        inClipId: "a1",
        inPts: "8000",
        outClipId: "a1",
        outPts: "10000",
      },
      {
        id: "segment-2",
        inClipId: "b1",
        inPts: "9000",
        outClipId: "b1",
        outPts: "99000",
      },
    ]);
    // A clip operation keeps the generation, so the view does not reset.
    expect(store.getState().sourceId).toBe("sequence:1");

    store.getState().undo();
    expect(store.getState().clips).toEqual([a1, b1]);
    expect(store.getState().sequenceSegments).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().clips).toEqual([b1, a1]);
  });

  it("removes a clip with its segments and its pending In", () => {
    const store = twoClips();
    store.getState().setAttachedClip("b1");
    store.getState().markIn(virtual(store, "b1", "50000"));
    store.getState().removeClip(1);
    expect(store.getState()).toMatchObject({
      clips: [a1],
      pendingIn: null,
      pendingInPts: null,
    });
    store.getState().undo();
    expect(store.getState().clips).toEqual([a1, b1]);
    // The pending In comes back with its clip.
    expect(store.getState().pendingIn).toEqual({ clipId: "b1", pts: "50000" });
  });

  it("clears the timeline as one edit, and the first clip after it starts a new generation", () => {
    const store = twoClips();
    store.getState().clearTimeline();
    expect(store.getState()).toMatchObject({ clips: [], sourceId: null, segments: [] });
    store.getState().undo();
    expect(store.getState()).toMatchObject({ clips: [a1, b1], sourceId: "sequence:2" });
  });

  it("refuses a known clip identifier and a clip with no extent next to another", () => {
    const store = twoClips();
    expect(store.getState().insertClips(2, [a1], [A])).toBe(false);
    const X: SequenceSource = {
      ...A,
      id: "X",
      videoEndPts: null,
      approximateDurationSeconds: null,
    };
    expect(store.getState().insertClips(2, [{ id: "x1", sourceId: "X" }], [X])).toBe(
      false,
    );
    expect(store.getState().clips).toEqual([a1, b1]);
  });

  it("keeps one list of segments through a selection and a pending In", () => {
    const store = twoClips();
    store.getState().setAttachedClip("a1");
    store.getState().markIn(virtual(store, "a1", "1000"));
    store.getState().markOut(virtual(store, "a1", "2000"));
    const segments = store.getState().segments;
    store.getState().finishSegment(null);
    store.getState().selectSegment("segment-1");
    store.getState().markIn(virtual(store, "a1", "500"));
    expect(store.getState().segments).not.toBe(segments);
    const moved = store.getState().segments;
    store.getState().finishSegment(null);
    store.getState().markIn(virtual(store, "a1", "3000"));
    expect(store.getState().segments).toBe(moved);
  });
});

describe("timeline store on one clip with a bounded range (ADR 052)", () => {
  // A source of 10 s that starts at -1800 in 1/90000, with a known end.
  const BOUNDED: SequenceSource = {
    id: "bounded",
    videoTimeBase: { n: 1, d: 90000 },
    videoStartPts: pts("-1800"),
    videoEndPts: pts("898200"),
    videoDurationTicks: null,
    approximateDurationSeconds: 10,
  };

  function bounded() {
    let nextId = 1;
    const store = createTimelineStore({ generateId: () => `segment-${nextId++}` });
    store.getState().showOnlySource(BOUNDED);
    return store;
  }

  it("keeps the PTS of the source as the virtual PTS", () => {
    const store = bounded();
    store.getState().markIn(pts("-1800"));
    store.getState().markOut(pts("3003"));
    expect(visible(store)).toEqual([
      { id: "segment-1", inPts: "-1800", outPts: "3003" },
    ]);
  });

  it("refuses an In before the start and an Out after the end", () => {
    const store = bounded();
    store.getState().markIn(pts("-1801"));
    expect(store.getState().pendingIn).toBeNull();
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("898201"));
    expect(store.getState().sequenceSegments).toEqual([]);
  });

  it("refuses an Out on the first frame, where no clip comes before", () => {
    const store = bounded();
    store.getState().markIn(pts("-1800"));
    store.getState().finishSegment(pts("-1800"));
    expect(store.getState().sequenceSegments).toEqual([]);
  });

  it("uses no identifier for a refused mark", () => {
    const store = bounded();
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("898201"));
    store.getState().markOut(pts("9000"));
    expect(store.getState().sequenceSegments.map((segment) => segment.id)).toEqual([
      "segment-1",
    ]);
  });

  it("trims an Out to the end of the clip", () => {
    const store = bounded();
    store.getState().markIn(pts("0"));
    store.getState().markOut(pts("9000"));
    store.getState().trimSegmentEdge("segment-1", "out", pts("898200"));
    expect(visible(store)).toEqual([{ id: "segment-1", inPts: "0", outPts: "898200" }]);
  });
});
