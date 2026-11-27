/**
 * The whole-sequence load of the timeline store (ADR 072), and the rule that an insert keeps the
 * facts of a source that the store has.
 */

import { describe, expect, it } from "vitest";
import type { Clip, Pts, SequenceSegment, TickCount } from "@/types/project";
import type { SequenceSource } from "./sequence";
import { createTimelineStore, sequenceSourceIdOf, type TimelineStore } from "./store";
import type { TimelineStoreState } from "./types";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

function source(id: string, overrides: Partial<SequenceSource> = {}): SequenceSource {
  return {
    id,
    videoTimeBase: { n: 1, d: 1000 },
    videoStartPts: pts("0"),
    videoEndPts: pts("10000"),
    videoDurationTicks: ticks("10000"),
    approximateDurationSeconds: 10,
    ...overrides,
  };
}

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
): SequenceSegment {
  return { id, inClipId, inPts: pts(inPts), outClipId, outPts: pts(outPts) };
}

/** A store with two clips of `a` and `b`, two segments, a selection, a pending In and history. */
function busyStore(): TimelineStore {
  let next = 0;
  const store = createTimelineStore({ generateId: () => `id-${++next}` });
  const state = store.getState();
  state.insertClips(0, [{ id: "old-1", sourceId: "a" }], [source("a")]);
  state.insertClips(1, [{ id: "old-2", sourceId: "b" }], [source("b")]);
  store.getState().setAttachedClip("old-2");
  store.getState().setBrowserDuration("a", 10.5);
  // The second clip starts at 10 s, so these virtual PTS values lie on it.
  store.getState().markIn(pts("11000"));
  store.getState().markOut(pts("12000"));
  store.getState().markIn(pts("13000"));
  return store;
}

/** The fields of the state that a refused load must not change. */
function truthOf(state: TimelineStoreState) {
  return {
    clips: state.clips,
    sequenceSegments: state.sequenceSegments,
    sequenceSources: state.sequenceSources,
    browserDurations: state.browserDurations,
    pendingIn: state.pendingIn,
    selectedSegmentIds: state.selectedSegmentIds,
    currentSegmentId: state.currentSegmentId,
    attachedClipId: state.attachedClipId,
    generation: state.generation,
    sourceId: state.sourceId,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
  };
}

const NEW_CLIPS: Clip[] = [
  { id: "n1", sourceId: "a" },
  { id: "n2", sourceId: "c" },
];
const NEW_SOURCES = [source("a", { videoEndPts: pts("9000") }), source("c")];
const NEW_SEGMENTS = [
  { ...segment("s1", "n2", "100", "n2", "200"), name: "Second" },
  segment("s2", "n1", "8000", "n2", "50"),
];

describe("loadSequence", () => {
  it("replaces the whole truth, and empties the history, the pending In and the selection", () => {
    const store = busyStore();
    // An entry for Redo too.
    store.getState().undo();
    expect(store.getState().canRedo).toBe(true);
    store.getState().redo();
    store.getState().undo();
    // A pending In, which adds no history entry, so the Redo entry stays.
    store.getState().finishSegment(null);
    store.getState().markIn(pts("14000"));
    const before = store.getState();
    expect(before.canUndo).toBe(true);
    expect(before.canRedo).toBe(true);
    expect(before.pendingIn).not.toBeNull();

    const result = store.getState().loadSequence(NEW_CLIPS, NEW_SOURCES, NEW_SEGMENTS);

    expect(result).toEqual({ ok: true });
    const state = store.getState();
    expect(state.clips).toEqual(NEW_CLIPS);
    expect(state.sequenceSegments).toEqual(NEW_SEGMENTS);
    // The sources are those given: the source `b` of the old sequence goes.
    expect(state.sequenceSources).toEqual({ a: NEW_SOURCES[0], c: NEW_SOURCES[1] });
    expect(state.browserDurations).toEqual({});
    expect(state.pendingIn).toBeNull();
    expect(state.selectedSegmentIds).toEqual([]);
    expect(state.currentSegmentId).toBeNull();
    expect(state.attachedClipId).toBe("n1");
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.segments.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(state.segments[0]?.name).toBe("Second");
    expect("name" in state.sequenceSegments[1]).toBe(false);

    // A new sequence for each reader of `generation` and `sourceId`.
    expect(state.generation).toBe(before.generation + 1);
    expect(state.sourceId).toBe(sequenceSourceIdOf(state.generation));
    expect(state.sourceId).not.toBe(before.sourceId);

    // No history entry: Undo and Redo do nothing, and the loaded sequence stays.
    store.getState().undo();
    store.getState().redo();
    expect(store.getState().clips).toEqual(NEW_CLIPS);
    expect(store.getState().sequenceSegments).toEqual(NEW_SEGMENTS);
    expect(store.getState().generation).toBe(state.generation);
  });

  it("copies the input, so a later change of the caller's objects does not reach the store", () => {
    const store = createTimelineStore();
    const clips: Clip[] = [{ id: "n1", sourceId: "a" }];
    const segments = [segment("s1", "n1", "100", "n1", "200")];
    const given = source("a");
    store.getState().loadSequence(clips, [given], segments);
    expect(store.getState().clips[0]).not.toBe(clips[0]);
    expect(store.getState().sequenceSegments[0]).not.toBe(segments[0]);
    expect(store.getState().sequenceSources.a).not.toBe(given);
    expect(store.getState().sequenceSources.a?.videoTimeBase).not.toBe(
      given.videoTimeBase,
    );

    // A change of the objects of the caller does not reach the store.
    const mutable = given as {
      videoEndPts: Pts | null;
      videoTimeBase: { n: number; d: number };
    };
    mutable.videoEndPts = pts("5");
    mutable.videoTimeBase.d = 1;
    (clips[0] as { sourceId: string }).sourceId = "b";
    (segments[0] as { outPts: Pts }).outPts = pts("9999");
    const state = store.getState();
    expect(state.sequenceSources.a).toEqual(source("a"));
    expect(state.clips[0]).toEqual({ id: "n1", sourceId: "a" });
    expect(state.sequenceSegments[0]?.outPts).toBe("200");
  });

  it("is a new sequence also when the same file and the same identifiers were there", () => {
    const store = createTimelineStore();
    const clips: Clip[] = [{ id: "n1", sourceId: "a" }];
    store.getState().loadSequence(clips, [source("a")], []);
    const first = store.getState();
    store.getState().loadSequence(clips, [source("a")], []);
    const second = store.getState();
    expect(second.generation).toBe(first.generation + 1);
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(second.sourceRevisionKey).not.toBe(first.sourceRevisionKey);
  });

  it("gives an empty sequence for a load with no clip", () => {
    const store = busyStore();
    const generation = store.getState().generation;
    expect(store.getState().loadSequence([], [], [])).toEqual({ ok: true });
    const state = store.getState();
    expect(state.clips).toEqual([]);
    expect(state.sequenceSegments).toEqual([]);
    expect(state.sequenceSources).toEqual({});
    expect(state.attachedClipId).toBeNull();
    expect(state.sourceId).toBeNull();
    expect(state.canUndo).toBe(false);
    expect(state.generation).toBe(generation + 1);
  });

  it("changes nothing and says why for input that the store refuses", () => {
    const store = busyStore();
    const before = truthOf(store.getState());
    const refusals: [Clip[], SequenceSource[], SequenceSegment[], string][] = [
      [NEW_CLIPS, [NEW_SOURCES[0]], [], "unknownSource"],
      [
        NEW_CLIPS,
        [
          NEW_SOURCES[0],
          source("c", {
            videoEndPts: null,
            videoDurationTicks: null,
            approximateDurationSeconds: null,
          }),
        ],
        [],
        "clipExtentUnknown",
      ],
      [
        NEW_CLIPS,
        NEW_SOURCES,
        [segment("s1", "n1", "9000", "n1", "9500")],
        "invalidSegment",
      ],
      [
        NEW_CLIPS,
        NEW_SOURCES,
        [segment("s1", "n1", "1", "n1", "2"), segment("s1", "n1", "3", "n1", "4")],
        "duplicateSegment",
      ],
    ];
    for (const [clips, sources, segments, kind] of refusals) {
      const result = store.getState().loadSequence(clips, sources, segments);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.problem.kind).toBe(kind);
      expect(truthOf(store.getState())).toEqual(before);
    }
    // The history stays too.
    store.getState().undo();
    expect(store.getState().pendingIn).toBeNull();
    expect(store.getState().sequenceSegments).toHaveLength(1);
  });

  it("does not take a length from the web view", () => {
    // A clip with no extent of its own next to another clip lays out only with the length of
    // the web view. A load reads none.
    const store = createTimelineStore();
    const bare = source("x", {
      videoEndPts: null,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    });
    store.getState().setBrowserDuration("x", 12);
    const result = store.getState().loadSequence(
      [
        { id: "n1", sourceId: "x" },
        { id: "n2", sourceId: "a" },
      ],
      [bare, source("a")],
      [],
    );
    expect(result).toEqual({
      ok: false,
      problem: { kind: "clipExtentUnknown", clipId: "n1", sourceId: "x" },
    });
  });
});

describe("insertClips and a source that the store has", () => {
  it("keeps the facts of the known source, and records a new source", () => {
    const store = createTimelineStore();
    store
      .getState()
      .loadSequence(
        [{ id: "n1", sourceId: "a" }],
        [source("a", { videoEndPts: pts("9000") })],
        [],
      );
    const opened = store.getState().sequenceSources.a;

    const probedAgain = source("a", { videoEndPts: pts("9500") });
    expect(
      store.getState().insertClips(
        1,
        [
          { id: "n2", sourceId: "a" },
          { id: "n3", sourceId: "b" },
        ],
        [probedAgain, source("b")],
      ),
    ).toBe(true);
    const state = store.getState();
    expect(state.sequenceSources.a).toBe(opened);
    expect(state.sequenceSources.b).toEqual(source("b"));
    expect(state.clips.map((clip) => clip.id)).toEqual(["n1", "n2", "n3"]);
  });
});

describe("setBrowserDuration", () => {
  it("keeps the length that it has for a value that gives no extent", () => {
    const store = createTimelineStore({ generateId: () => "g1" });
    const bare = source("x", {
      videoEndPts: null,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    });
    // A file with no extent from the probe. The web view gives 1 s.
    store.getState().insertClips(0, [{ id: "c1", sourceId: "x" }], [bare]);
    store.getState().setAttachedClip("c1");
    store.getState().setBrowserDuration("x", 1);
    store.getState().markIn(pts("100"));
    store.getState().markOut(pts("200"));
    expect(
      store.getState().insertClips(1, [{ id: "c2", sourceId: "b" }], [source("b")]),
    ).toBe(true);
    const virtual = store.getState().virtual;
    expect(virtual).not.toBeNull();
    expect(store.getState().segments).toHaveLength(1);

    // A later `durationchange` with a length that rounds to zero, and the other values that give
    // no extent, change nothing.
    for (const seconds of [
      0.0000004,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e307,
      null,
    ]) {
      store.getState().setBrowserDuration("x", seconds);
      expect(store.getState().browserDurations).toEqual({ x: 1 });
      expect(store.getState().virtual).toBe(virtual);
      expect(store.getState().segments).toHaveLength(1);
    }

    // A usable length still replaces it.
    store.getState().setBrowserDuration("x", 2);
    expect(store.getState().browserDurations).toEqual({ x: 2 });
    expect(store.getState().virtual).not.toBeNull();
  });
});
