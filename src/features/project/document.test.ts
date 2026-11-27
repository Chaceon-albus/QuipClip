import { describe, expect, it } from "vitest";
import type { AudioStreamOverride } from "@/features/media/audioStream";
import type { ImportMediaResult } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import type { SequenceLoadCheck } from "@/features/timeline/sequenceLoad";
import { createTimelineStore, type TimelineStore } from "@/features/timeline/store";
import type {
  Clip,
  FrameCount,
  Project,
  Pts,
  SequenceSegment,
  TickCount,
} from "@/types/project";
import {
  EMPTY_PROJECT_CONTENT,
  buildProjectDocument,
  checkProjectDocument,
  projectContentOf,
  sequenceSourceOfPersisted,
  toPersistedSource,
  type ProjectAudioOverrides,
} from "./document";
import { validateProjectDocument } from "./validation";

const pts = (value: string) => value as Pts;
const ticks = (value: string) => value as TickCount;

/** An import of 10 s in milliseconds, with every field of the answer of the backend. */
function imported(
  path: string,
  overrides: Partial<ImportMediaResult> = {},
): ImportMediaResult {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    size: 4096,
    mtime: 1_787_073_674,
    probe: {
      formatNames: ["mov", "mp4"],
      formatLongName: "QuickTime / MOV",
      formatStartTime: null,
      videoCodec: "h264",
      videoProfile: "High",
      pixelFormat: "yuv420p",
      bitDepth: 8,
      width: 1920,
      height: 1080,
      videoStreamIndex: 1,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: pts("0"),
      videoDurationTicks: ticks("10000"),
      approximateDurationSeconds: 10,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300" as FrameCount,
      sampleAspectRatio: null,
      rotation: 0,
      videoEndPts: pts("10000"),
      audio: null,
      audioStreams: [],
    },
    ...overrides,
  };
}

/** The sequence source of an import, as `toSequenceSource` makes it. */
function sequenceSourceOf(id: string, media: ImportMediaResult): SequenceSource {
  return {
    id,
    videoTimeBase: media.probe.videoTimeBase,
    videoStartPts: media.probe.videoStartPts,
    videoEndPts: media.probe.videoEndPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
  };
}

function segment(
  id: string,
  inClipId: string,
  inPts: string,
  outClipId: string,
  outPts: string,
  name?: string,
): SequenceSegment {
  const value: SequenceSegment = {
    id,
    inClipId,
    inPts: pts(inPts),
    outClipId,
    outPts: pts(outPts),
  };
  if (name !== undefined) {
    value.name = name;
  }
  return value;
}

const FLV = imported("/media/live.flv", {
  size: 70_000,
  fingerprint: { start: "4464", fnv1a64: "9f3c5a7714e0b2d1" },
});
const MKV = imported("/media/two.mkv");
const OTHER = imported("/media/other.mp4");

const MEDIA = { a: FLV, b: MKV, z: OTHER };
const OVERRIDES: ProjectAudioOverrides = {
  b: { index: 2, codec: "aac", sampleRate: 48000, channels: 2 },
  // A source that no clip names: it is not in the document.
  z: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
};

const CLIPS: Clip[] = [
  { id: "c1", sourceId: "b" },
  { id: "c2", sourceId: "a" },
  { id: "c3", sourceId: "b" },
];

const SEGMENTS: SequenceSegment[] = [
  segment("g1", "c2", "1000", "c2", "2000", "Second"),
  segment("g2", "c1", "9000", "c2", "500"),
  segment("g3", "c3", "0", "c3", "10000", "Last"),
];

/** A timeline store with the clips and the segments above. */
function sessionStore(): TimelineStore {
  let next = 0;
  const store = createTimelineStore({ generateId: () => `new-${++next}` });
  const result = store
    .getState()
    .loadSequence(
      CLIPS,
      [
        sequenceSourceOf("a", FLV),
        sequenceSourceOf("b", MKV),
        sequenceSourceOf("z", OTHER),
      ],
      SEGMENTS,
    );
  expect(result).toEqual({ ok: true });
  return store;
}

function buildOrFail(store: TimelineStore, overrides = OVERRIDES): Project {
  const result = buildProjectDocument(store.getState(), MEDIA, overrides);
  if (!result.ok) {
    throw new Error(`missing source ${result.missingSourceId}`);
  }
  return result.project;
}

const PERSISTED_KEYS = [
  "id",
  "path",
  "size",
  "mtime",
  "videoStreamIndex",
  "videoTimeBase",
  "videoStartPts",
  "videoEndPts",
  "videoDurationTicks",
  "approximateDurationSeconds",
  "avgFrameRate",
  "rFrameRate",
  "reportedFrameCount",
];

describe("buildProjectDocument", () => {
  it("writes the clips in order, the live segments in order, and the named sources in first use", () => {
    const project = buildOrFail(sessionStore());
    expect(project.schemaVersion).toBe(1);
    expect(project.clips).toEqual(CLIPS);
    expect(project.segments).toEqual(SEGMENTS);
    expect(project.sources.map((source) => source.id)).toEqual(["b", "a"]);
  });

  it("makes each source entry from the import and the override, with no relPath", () => {
    const project = buildOrFail(sessionStore());
    const [mkv, flv] = project.sources;
    expect(mkv).toEqual({
      id: "b",
      path: "/media/two.mkv",
      size: 4096,
      mtime: 1_787_073_674,
      videoStreamIndex: 1,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: "0",
      videoEndPts: "10000",
      videoDurationTicks: "10000",
      approximateDurationSeconds: 10,
      avgFrameRate: { n: 30, d: 1 },
      rFrameRate: { n: 30, d: 1 },
      reportedFrameCount: "300",
      audioStreamIndex: 2,
    });
    expect(Object.keys(mkv).sort()).toEqual(
      [...PERSISTED_KEYS, "audioStreamIndex"].sort(),
    );
    expect(Object.keys(flv).sort()).toEqual([...PERSISTED_KEYS, "fingerprint"].sort());
    expect(flv?.fingerprint).toEqual(FLV.fingerprint);
    // New objects: nothing of the session is shared with the document.
    expect(flv?.fingerprint).not.toBe(FLV.fingerprint);
    expect(flv?.videoTimeBase).not.toBe(FLV.probe.videoTimeBase);
    for (const source of project.sources) {
      expect("relPath" in source).toBe(false);
      expect("fileName" in source).toBe(false);
      expect("probe" in source).toBe(false);
    }
  });

  it("round-trips through the validation of the document", () => {
    const project = buildOrFail(sessionStore());
    const read = validateProjectDocument(JSON.parse(JSON.stringify(project)));
    expect(read).toEqual(project);
    for (const source of read.sources) {
      expect("relPath" in source).toBe(false);
    }
    expect(checkProjectDocument(read)).toEqual({ ok: true });
  });

  it("leaves out the segments that are not live", () => {
    const store = sessionStore();
    store.getState().removeClip(2);
    const project = buildOrFail(store);
    // The segment of the removed clip goes, and the source of no clip is not written.
    expect(project.segments.map((entry) => entry.id)).toEqual(["g1", "g2"]);
    expect(project.clips.map((clip) => clip.id)).toEqual(["c1", "c2"]);
    expect(project.sources.map((source) => source.id)).toEqual(["b", "a"]);
  });

  it("writes an empty document for an empty sequence", () => {
    const store = createTimelineStore();
    expect(buildProjectDocument(store.getState(), MEDIA, OVERRIDES)).toEqual({
      ok: true,
      project: { schemaVersion: 1, sources: [], clips: [], segments: [] },
    });
  });

  it("names a source of which the media store has no import", () => {
    const store = sessionStore();
    expect(buildProjectDocument(store.getState(), { a: FLV }, OVERRIDES)).toEqual({
      ok: false,
      missingSourceId: "b",
    });
  });
});

describe("toPersistedSource", () => {
  it("writes the override index only, and no field for no override and no fingerprint", () => {
    const override: AudioStreamOverride = {
      index: 0,
      codec: "opus",
      sampleRate: 48000,
      channels: 1,
    };
    expect(toPersistedSource("s", MKV, override).audioStreamIndex).toBe(0);
    const plain = toPersistedSource("s", MKV, undefined);
    expect("audioStreamIndex" in plain).toBe(false);
    expect("fingerprint" in plain).toBe(false);
    expect(Object.keys(plain).sort()).toEqual([...PERSISTED_KEYS].sort());
  });

  it("keeps the null facts of a probe", () => {
    const bare = imported("/media/live.ts", {
      probe: {
        ...imported("/media/live.ts").probe,
        videoStartPts: null,
        videoEndPts: null,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
        avgFrameRate: null,
        rFrameRate: null,
        reportedFrameCount: null,
      },
    });
    const persisted = toPersistedSource("s", bare, undefined);
    expect(persisted.videoStartPts).toBeNull();
    expect(persisted.videoEndPts).toBeNull();
    expect(persisted.videoDurationTicks).toBeNull();
    expect(persisted.approximateDurationSeconds).toBeNull();
    expect(persisted.avgFrameRate).toBeNull();
    expect(persisted.rFrameRate).toBeNull();
    expect(persisted.reportedFrameCount).toBeNull();
  });
});

describe("checkProjectDocument", () => {
  /** A document of two clips; `bare` gives the source of the second clip no extent. */
  function document(bare: boolean, segments: SequenceSegment[] = []): Project {
    const second = imported("/media/second.mp4", {
      probe: {
        ...imported("/media/second.mp4").probe,
        videoEndPts: bare ? null : pts("10000"),
        videoDurationTicks: bare ? null : ticks("10000"),
        approximateDurationSeconds: bare ? null : 10,
      },
    });
    return {
      schemaVersion: 1,
      sources: [
        toPersistedSource("s1", MKV, undefined),
        toPersistedSource("s2", second, undefined),
      ],
      clips: [
        { id: "c1", sourceId: "s1" },
        { id: "c2", sourceId: "s2" },
      ],
      segments,
    };
  }

  it("names the clip with no extent next to another clip, and its source", () => {
    expect(checkProjectDocument(document(true))).toEqual({
      ok: false,
      problem: { kind: "clipExtentUnknown", clipId: "c2", sourceId: "s2" },
    });
  });

  it("refuses exactly what the load of the timeline store refuses for the same data", () => {
    const cases: [string, Project, SequenceLoadCheck][] = [
      ["two clips", document(false), { ok: true }],
      [
        "a clip with no extent next to another",
        document(true),
        {
          ok: false,
          problem: { kind: "clipExtentUnknown", clipId: "c2", sourceId: "s2" },
        },
      ],
      [
        "a segment across the junction",
        document(false, [segment("g", "c1", "1000", "c2", "500")]),
        { ok: true },
      ],
      [
        "an In at the end of a clip",
        document(false, [segment("g", "c1", "10000", "c2", "500")]),
        { ok: false, problem: { kind: "invalidSegment", segmentId: "g" } },
      ],
      [
        "a segment with no frame",
        document(false, [segment("g", "c2", "0", "c2", "0")]),
        { ok: false, problem: { kind: "invalidSegment", segmentId: "g" } },
      ],
      [
        "a name that is not valid",
        document(false, [segment("g", "c1", "1", "c1", "2", " name")]),
        { ok: false, problem: { kind: "invalidSegmentName", segmentId: "g" } },
      ],
      [
        "a repeated segment id",
        document(false, [
          segment("g", "c1", "1", "c1", "2"),
          segment("g", "c1", "3", "c1", "4"),
        ]),
        { ok: false, problem: { kind: "duplicateSegment", segmentId: "g" } },
      ],
      [
        "a clip of an unknown source",
        { ...document(false), clips: [{ id: "c1", sourceId: "missing" }] },
        {
          ok: false,
          problem: { kind: "unknownSource", clipId: "c1", sourceId: "missing" },
        },
      ],
      [
        "an empty document",
        { schemaVersion: 1, sources: [], clips: [], segments: [] },
        { ok: true },
      ],
    ];
    for (const [name, project, expected] of cases) {
      expect(checkProjectDocument(project), name).toEqual(expected);
      const store = createTimelineStore();
      const loaded = store
        .getState()
        .loadSequence(
          project.clips,
          project.sources.map(sequenceSourceOfPersisted),
          project.segments,
        );
      expect(loaded, name).toEqual(expected);
      // The store applied the load exactly when the verdict is ok: a load always gives a new
      // generation.
      expect(store.getState().generation, name).toBe(expected.ok ? 1 : 0);
      expect(store.getState().clips, name).toEqual(expected.ok ? project.clips : []);
    }
  });

  it("answers, and never throws, for a length estimate that gives no extent", () => {
    for (const approximateDurationSeconds of [1e307, 0.0000004]) {
      const estimated = imported("/media/estimated.ts", {
        probe: {
          ...imported("/media/estimated.ts").probe,
          videoEndPts: null,
          videoDurationTicks: null,
          approximateDurationSeconds,
        },
      });
      const project: Project = {
        schemaVersion: 1,
        sources: [
          toPersistedSource("s1", MKV, undefined),
          toPersistedSource("s2", estimated, undefined),
        ],
        clips: [
          { id: "c1", sourceId: "s2" },
          { id: "c2", sourceId: "s1" },
        ],
        segments: [],
      };
      // Both validations of the document accept the value.
      expect(validateProjectDocument(JSON.parse(JSON.stringify(project)))).toEqual(
        project,
      );
      expect(checkProjectDocument(project)).toEqual({
        ok: false,
        problem: { kind: "clipExtentUnknown", clipId: "c1", sourceId: "s2" },
      });
      // Alone on the sequence, such a clip needs no extent.
      expect(
        checkProjectDocument({ ...project, clips: [{ id: "c1", sourceId: "s2" }] }),
      ).toEqual({ ok: true });
    }
  });

  it("accepts a session whose segment has no place on the virtual axis, and loads it again equal", () => {
    // A recording of 60000 s, with a segment near its end.
    const long = imported("/media/long.mp4", {
      probe: {
        ...imported("/media/long.mp4").probe,
        videoTimeBase: { n: 1, d: 90000 },
        videoStartPts: pts("0"),
        videoEndPts: pts("5400000000"),
        videoDurationTicks: ticks("5400000000"),
        approximateDurationSeconds: 60000,
      },
    });
    // A clip of one second with a very fine time base.
    const fine = imported("/media/fine.mp4", {
      probe: {
        ...imported("/media/fine.mp4").probe,
        videoTimeBase: { n: 1, d: 2147483647 },
        videoStartPts: pts("0"),
        videoEndPts: pts("2147483647"),
        videoDurationTicks: ticks("2147483647"),
        approximateDurationSeconds: 1,
      },
    });
    const media = { long, fine };
    const saved = createTimelineStore({ generateId: () => "g-new" });
    saved
      .getState()
      .insertClips(
        0,
        [{ id: "c1", sourceId: "long" }],
        [sequenceSourceOf("long", long)],
      );
    saved.getState().setAttachedClip("c1");
    saved.getState().markIn(pts("5000000000"));
    saved.getState().markOut(pts("5000003000"));
    expect(saved.getState().segments).toHaveLength(1);
    // The insert of the fine clip makes the axis finer: the segment keeps the rules of ADR 052,
    // and it has no bar.
    expect(
      saved
        .getState()
        .insertClips(
          0,
          [{ id: "c0", sourceId: "fine" }],
          [sequenceSourceOf("fine", fine)],
        ),
    ).toBe(true);
    expect(saved.getState().sequenceSegments).toHaveLength(1);
    expect(saved.getState().segments).toHaveLength(0);

    const built = buildProjectDocument(saved.getState(), media, {});
    if (!built.ok) {
      throw new Error("the document must build");
    }
    expect(built.project.segments).toHaveLength(1);
    expect(checkProjectDocument(built.project)).toEqual({ ok: true });

    const opened = createTimelineStore();
    expect(
      opened
        .getState()
        .loadSequence(
          built.project.clips,
          built.project.sources.map(sequenceSourceOfPersisted),
          built.project.segments,
        ),
    ).toEqual({ ok: true });
    const before = saved.getState();
    const after = opened.getState();
    expect(after.clips).toEqual(before.clips);
    expect(after.sequenceSegments).toEqual(before.sequenceSegments);
    expect(after.sequenceSources).toEqual(before.sequenceSources);
    expect(after.segments).toEqual([]);
    expect(projectContentOf(after, {})).toBe(projectContentOf(before, {}));
  });
});

describe("projectContentOf", () => {
  it("is the empty content for an empty sequence", () => {
    expect(projectContentOf(createTimelineStore().getState(), {})).toBe(
      EMPTY_PROJECT_CONTENT,
    );
  });

  it("gives equal values for equal content, whatever the objects are", () => {
    const first = sessionStore().getState();
    const copy = structuredClone({
      clips: first.clips,
      sequenceSegments: first.sequenceSegments,
      sequenceSources: first.sequenceSources,
    });
    expect(copy.clips).not.toBe(first.clips);
    expect(projectContentOf(copy, structuredClone(OVERRIDES))).toBe(
      projectContentOf(first, OVERRIDES),
    );
  });

  it("does not change with what is not content", () => {
    const store = sessionStore();
    const content = projectContentOf(store.getState(), OVERRIDES);
    store.getState().selectSegment("g1");
    store.getState().setAttachedClip("c3");
    store.getState().setBrowserDuration("a", 12);
    expect(projectContentOf(store.getState(), OVERRIDES)).toBe(content);
    store.getState().finishSegment(null);
    // A pending In on the first clip, whose virtual PTS values are its source PTS values.
    store.getState().setAttachedClip("c1");
    store.getState().markIn(pts("3000"));
    expect(store.getState().pendingIn).not.toBeNull();
    expect(projectContentOf(store.getState(), OVERRIDES)).toBe(content);
    // The override of a source that no clip names is not content.
    expect(projectContentOf(store.getState(), { b: OVERRIDES.b })).toBe(content);
    // An override with other facts but the same index is the same choice.
    expect(
      projectContentOf(store.getState(), {
        ...OVERRIDES,
        b: { index: 2, codec: null, sampleRate: null, channels: null },
      }),
    ).toBe(content);
  });

  it("changes with each kind of edit, and an Undo gives the value back", () => {
    const edits: [string, (store: TimelineStore) => void][] = [
      ["move a clip", (store) => store.getState().moveClip(0, 3)],
      ["remove a clip", (store) => store.getState().removeClip(1)],
      [
        "add a clip",
        (store) =>
          store
            .getState()
            .insertClips(
              3,
              [{ id: "c4", sourceId: "z" }],
              [sequenceSourceOf("z", OTHER)],
            ),
      ],
      ["clear the timeline", (store) => store.getState().clearTimeline()],
      [
        "trim an edge",
        (store) => {
          store.getState().setAttachedClip("c3");
          store.getState().trimSegmentEdge("g3", "out", pts("29000"));
        },
      ],
      ["rename a segment", (store) => store.getState().renameSegment("g1", "Renamed")],
      ["remove a name", (store) => store.getState().renameSegment("g3", null)],
      [
        "reorder the export",
        (store) => store.getState().reorderExportSegments(["g3", "g1", "g2"]),
      ],
      [
        "delete a segment",
        (store) => {
          store.getState().selectSegment("g2");
          store.getState().deleteSelectedSegments();
        },
      ],
      [
        "add a segment",
        (store) => {
          store.getState().setAttachedClip("c1");
          store.getState().markIn(pts("100"));
          store.getState().markOut(pts("200"));
        },
      ],
    ];
    for (const [name, edit] of edits) {
      const store = sessionStore();
      const before = projectContentOf(store.getState(), OVERRIDES);
      edit(store);
      expect(store.getState().canUndo, name).toBe(true);
      expect(projectContentOf(store.getState(), OVERRIDES), name).not.toBe(before);
      store.getState().undo();
      expect(projectContentOf(store.getState(), OVERRIDES), name).toBe(before);
    }
  });

  it("holds no id of a clip or of a segment", () => {
    /** Two clips, `b` then `a`, and one segment on the first clip. */
    function twoClips(): TimelineStore {
      let next = 0;
      const store = createTimelineStore({ generateId: () => `again-${++next}` });
      store.getState().loadSequence(
        [
          { id: "c1", sourceId: "b" },
          { id: "c2", sourceId: "a" },
        ],
        [sequenceSourceOf("a", FLV), sequenceSourceOf("b", MKV)],
        [segment("g1", "c1", "1000", "c1", "2000")],
      );
      return store;
    }

    // Delete a segment, and mark the same In and Out again: a new segment id.
    const marked = twoClips();
    const before = projectContentOf(marked.getState(), OVERRIDES);
    marked.getState().selectSegment("g1");
    marked.getState().deleteSelectedSegments();
    marked.getState().setAttachedClip("c1");
    marked.getState().markIn(pts("1000"));
    marked.getState().markOut(pts("2000"));
    expect(marked.getState().sequenceSegments.map((entry) => entry.id)).toEqual([
      "again-1",
    ]);
    expect(projectContentOf(marked.getState(), OVERRIDES)).toBe(before);

    // Remove a clip, and import the same file at the same place: a new clip id.
    const imported = twoClips();
    imported.getState().removeClip(1);
    expect(
      imported
        .getState()
        .insertClips(1, [{ id: "c9", sourceId: "a" }], [sequenceSourceOf("a", FLV)]),
    ).toBe(true);
    expect(imported.getState().clips.map((clip) => clip.id)).toEqual(["c1", "c9"]);
    expect(projectContentOf(imported.getState(), OVERRIDES)).toBe(before);

    // A new id for the clip that the segment names, in both of its boundaries.
    const renamed = createTimelineStore();
    expect(
      renamed.getState().loadSequence(
        [
          { id: "c1-new", sourceId: "b" },
          { id: "c2", sourceId: "a" },
        ],
        [sequenceSourceOf("a", FLV), sequenceSourceOf("b", MKV)],
        [segment("g1", "c1-new", "1000", "c1-new", "2000")],
      ),
    ).toEqual({ ok: true });
    expect(renamed.getState().segments).toHaveLength(1);
    expect(projectContentOf(renamed.getState(), OVERRIDES)).toBe(before);

    // The same In and Out on the other clip of the same source is other content.
    const moved = createTimelineStore();
    moved.getState().loadSequence(
      [
        { id: "c1", sourceId: "b" },
        { id: "c2", sourceId: "b" },
      ],
      [sequenceSourceOf("b", MKV)],
      [segment("g1", "c1", "1000", "c1", "2000")],
    );
    const first = projectContentOf(moved.getState(), {});
    moved.getState().loadSequence(
      [
        { id: "c1", sourceId: "b" },
        { id: "c2", sourceId: "b" },
      ],
      [sequenceSourceOf("b", MKV)],
      [segment("g1", "c2", "1000", "c2", "2000")],
    );
    expect(projectContentOf(moved.getState(), {})).not.toBe(first);
  });

  it("changes with the audio choice of a source that a clip names", () => {
    const state = sessionStore().getState();
    const content = projectContentOf(state, OVERRIDES);
    expect(projectContentOf(state, { z: OVERRIDES.z })).not.toBe(content);
    expect(
      projectContentOf(state, {
        ...OVERRIDES,
        b: { index: 3, codec: "aac", sampleRate: 48000, channels: 2 },
      }),
    ).not.toBe(content);
  });
});
