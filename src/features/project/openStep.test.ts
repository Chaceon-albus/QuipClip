import { describe, expect, it, vi } from "vitest";
import { createAudioOverrideStore } from "@/features/media/audioOverrideStore";
import type { MediaSourceRevisionDescriptor } from "@/features/media/sourceIdentity";
import { getGeneratedSourceId } from "@/features/media/sourceIdentity";
import { createMediaStore } from "@/features/media/store";
import {
  ImportMediaError,
  type ExpectedRevision,
  type ImportMediaErrorCode,
  type ImportMediaResult,
  type ListedAudioStream,
} from "@/features/media/types";
import {
  RecoveryCommandError,
  type RecoveryReadResult,
} from "@/features/recovery/types";
import { importClips, runInImportLine } from "@/features/sequence/importClips";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type {
  Clip,
  PersistedSource,
  Project,
  Pts,
  SequenceSegment,
} from "@/types/project";
import { EMPTY_PROJECT_CONTENT, projectContentOf } from "./document";
import type { DropContentAnswer } from "./dropContent";
import {
  createProjectOpenStep,
  type OpenProjectResult,
  type RestoreProjectResult,
} from "./openStep";
import {
  entryOf,
  flush,
  held,
  mediaAt,
  mediaForEntry,
  type Held,
} from "./projectTestSupport";
import type { ProjectSaveResult } from "./saveStep";
import {
  createProjectStore,
  hasChangesToSave,
  installProjectSequenceRule,
  isProjectModified,
} from "./store";
import { ProjectCommandError, type LoadProjectResult } from "./types";

const pts = (value: string) => value as Pts;

const PROJECT_PATH = "/projects/cut.qcproj";

/** What a path of the fake disk gives: an import, an error code, or an answer the test holds. */
type DiskEntry = ImportMediaResult | ImportMediaErrorCode | Held<ImportMediaResult>;

function isHeld<T>(value: unknown): value is Held<T> {
  return typeof value === "object" && value !== null && "promise" in value;
}

const A = entryOf("e1", "/old/a.mp4");
const B = entryOf("e2", "/old/b.mp4", { size: 2000 });
const CLIPS: Clip[] = [
  { id: "d1", sourceId: "e1" },
  { id: "d2", sourceId: "e2" },
];
const SEGMENTS: SequenceSegment[] = [
  {
    id: "dg1",
    inClipId: "d1",
    inPts: pts("1000"),
    outClipId: "d2",
    outPts: pts("500"),
    name: "Cross",
  },
];

function documentOf(
  sources: PersistedSource[],
  clips: Clip[] = CLIPS,
  segments: SequenceSegment[] = SEGMENTS,
): Project {
  return { schemaVersion: 1, sources, clips, segments };
}

function loaded(project: Project, candidates?: string[][]): LoadProjectResult {
  return {
    path: PROJECT_PATH,
    project,
    candidates: candidates ?? project.sources.map((entry) => [entry.path]),
  };
}

const OLD = mediaAt("/session/old.mp4");
const OLD_SOURCE: SequenceSource = {
  id: "old",
  videoTimeBase: OLD.probe.videoTimeBase,
  videoStartPts: OLD.probe.videoStartPts,
  videoEndPts: OLD.probe.videoEndPts,
  videoDurationTicks: OLD.probe.videoDurationTicks,
  approximateDurationSeconds: OLD.probe.approximateDurationSeconds,
};

/** A stream of the probe of a file with several audio streams. */
function stream(index: number): ListedAudioStream {
  return {
    index,
    codec: "aac",
    sampleRate: 48000,
    channels: 2,
    default: index === 1,
    language: null,
    title: null,
  };
}

interface HarnessOptions {
  readonly load?: LoadProjectResult | Held<LoadProjectResult> | ProjectCommandError;
  readonly disk?: Record<string, DiskEntry>;
  /** Revision reads that fail with a code, or that the test holds, by path. */
  readonly revisions?: Record<
    string,
    | ImportMediaErrorCode
    | Held<MediaSourceRevisionDescriptor>
    | MediaSourceRevisionDescriptor
  >;
  readonly answers?: DropContentAnswer[];
  /** True, or a function that answers, when the project has changes to save. */
  readonly changes?: boolean | (() => boolean);
  /** True, or a function that answers, when another dialog of the window is open. */
  readonly otherDialog?: boolean | (() => boolean);
  /** The imports of the media store, for `importClips`. */
  readonly mediaImports?: Record<string, ImportMediaResult | Held<ImportMediaResult>>;
  readonly realLine?: boolean;
}

/** A session with one old clip, the open step over it, and fake commands. */
function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  let segmentIds = 0;
  const timeline = createTimelineStore({ generateId: () => `old-seg-${++segmentIds}` });
  const media = createMediaStore(
    {
      importMedia: (path) => {
        const entry = options.mediaImports?.[path];
        if (entry === undefined) {
          return Promise.reject(new ImportMediaError({ code: "pathNotFound" }));
        }
        return isHeld<ImportMediaResult>(entry)
          ? entry.promise
          : Promise.resolve(entry);
      },
    },
    { sources: { old: OLD }, media: OLD, status: "ready" },
  );
  const audioOverrides = createAudioOverrideStore();
  audioOverrides.getState().replaceOverrides({
    old: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
  });
  const project = createProjectStore({
    sequenceHasClips: () => timeline.getState().clips.length > 0,
  });
  installProjectSequenceRule(project, timeline);
  timeline
    .getState()
    .insertClips(0, [{ id: "old-clip", sourceId: "old" }], [OLD_SOURCE]);
  timeline.getState().setAttachedClip("old-clip");

  const disk = new Map(Object.entries(options.disk ?? {}));
  const importMedia = vi.fn((path: string, _expected: ExpectedRevision) => {
    calls.push(`import ${path}`);
    const entry = disk.get(path);
    if (entry === undefined) {
      return Promise.reject(new ImportMediaError({ code: "pathNotFound" }));
    }
    if (typeof entry === "string") {
      return Promise.reject(new ImportMediaError({ code: entry }));
    }
    return isHeld<ImportMediaResult>(entry) ? entry.promise : Promise.resolve(entry);
  });
  const revisions = new Map(Object.entries(options.revisions ?? {}));
  const readSourceRevision = vi.fn((path: string, expected: ExpectedRevision) => {
    calls.push(`revision ${path}`);
    const entry = revisions.get(path);
    if (typeof entry === "string") {
      return Promise.reject(new ImportMediaError({ code: entry }));
    }
    if (entry !== undefined) {
      return isHeld<MediaSourceRevisionDescriptor>(entry)
        ? entry.promise
        : Promise.resolve(entry);
    }
    return Promise.resolve({ path, size: expected.size, mtime: expected.mtime });
  });
  const load = options.load ?? loaded(documentOf([A, B]));
  const loadProject = vi.fn((_path: string) => {
    calls.push("load");
    if (isHeld<LoadProjectResult>(load)) {
      return load.promise;
    }
    return load instanceof ProjectCommandError
      ? Promise.reject(load)
      : Promise.resolve(load);
  });
  const whenIdle = vi.fn(() => Promise.resolve());
  const saves: ProjectSaveResult[] = [];
  const saveStep = {
    save: vi.fn(() =>
      Promise.resolve(
        saves.shift() ?? ({ status: "saved", path: "/p.qcproj", bound: true } as const),
      ),
    ),
    whenIdle,
  };
  const answers = [...(options.answers ?? [])];
  const ask = vi.fn(() => {
    calls.push("ask");
    return Promise.resolve(answers.shift() ?? "cancel");
  });
  const pickFile = vi.fn((_directory: string | null) =>
    Promise.resolve<string | null>(null),
  );
  const staleExportOpenStep = vi.fn(() => {
    calls.push("stale");
  });
  const pausePlayback = vi.fn(() => {
    calls.push(
      `pause ${timeline
        .getState()
        .clips.map((clip) => clip.id)
        .join(",")}`,
    );
  });
  const dropNavigation = vi.fn(() => {
    calls.push("dropNavigation");
  });
  const resetPlayback = vi.fn(() => {
    calls.push("resetPlayback");
  });
  // The order of the changes of step 8.
  media.subscribe((state, previous) => {
    if (state.sources !== previous.sources) {
      calls.push("media");
    }
  });
  timeline.subscribe((state, previous) => {
    if (state.generation !== previous.generation) {
      calls.push("sequence");
    }
  });
  audioOverrides.subscribe(() => {
    calls.push(`overrides at generation ${timeline.getState().generation}`);
  });
  // A line of turns of this harness, unless the test uses the line of the imports.
  let line: Promise<unknown> = Promise.resolve();
  const localLine = <T>(task: () => Promise<T>): Promise<T> => {
    const run = line.then(task);
    line = run.catch(() => undefined);
    return run;
  };
  let clipIds = 0;
  let newSegmentIds = 0;
  const step = createProjectOpenStep({
    saveStep,
    ask,
    isOtherDialogOpen: () =>
      typeof options.otherDialog === "function"
        ? options.otherDialog()
        : options.otherDialog === true,
    pickFile,
    staleExportOpenStep,
    loadProject,
    importMedia,
    readSourceRevision,
    timeline,
    media,
    audioOverrides,
    project,
    hasChangesToSave: () =>
      typeof options.changes === "function"
        ? options.changes()
        : options.changes === true,
    pausePlayback,
    dropNavigation,
    resetPlayback,
    runInImportLine: options.realLine === true ? runInImportLine : localLine,
    generateClipId: () => `new-clip-${++clipIds}`,
    generateSegmentId: () => `new-seg-${++newSegmentIds}`,
  });

  /** Each part of the session that an open must not change before step 8. */
  const snapshot = () => ({
    clips: timeline.getState().clips,
    segments: timeline.getState().sequenceSegments,
    sequenceSources: timeline.getState().sequenceSources,
    generation: timeline.getState().generation,
    attached: timeline.getState().attachedClipId,
    sources: media.getState().sources,
    media: media.getState().media,
    overrides: audioOverrides.getState().overrides,
    file: project.getState().file,
    savedContent: project.getState().savedContent,
    identity: project.getState().identity,
    located: project.getState().located,
    proposedPath: project.getState().proposedPath,
  });

  return {
    calls,
    disk,
    revisions,
    timeline,
    media,
    audioOverrides,
    project,
    importMedia,
    readSourceRevision,
    loadProject,
    whenIdle,
    saveStep,
    saves,
    ask,
    pickFile,
    staleExportOpenStep,
    pausePlayback,
    dropNavigation,
    resetPlayback,
    step,
    snapshot,
    /** Runs a task as the next turn of the line of this harness. */
    turn: localLine,
    phase: () => step.store.getState().phase,
  };
}

/** The disk where each entry is found at its `path`. */
function diskOf(...entries: PersistedSource[]): Record<string, DiskEntry> {
  return Object.fromEntries(
    entries.map((entry) => [entry.path, mediaForEntry(entry, entry.path)]),
  );
}

function rowOf(h: ReturnType<typeof harness>, entryId: string) {
  const phase = h.phase();
  if (phase.kind !== "locating") {
    throw new Error(`expected the locating phase, got ${phase.kind}`);
  }
  const row = phase.rows.find((entry) => entry.entryId === entryId);
  if (row === undefined) {
    throw new Error(`no row ${entryId}`);
  }
  return row;
}

describe("the open step", () => {
  it("opens a project whose sources are found at once, and changes the session in step 8", async () => {
    const h = harness({ disk: diskOf(A, B) });
    const before = h.timeline.getState();
    const identity = h.project.getState().identity;

    const result = await h.step.open(PROJECT_PATH);

    expect(result).toEqual({ status: "opened", path: PROJECT_PATH });
    const idA = getGeneratedSourceId(mediaForEntry(A, A.path))!;
    const idB = getGeneratedSourceId(mediaForEntry(B, B.path))!;
    const state = h.timeline.getState();
    expect(state.clips).toEqual([
      { id: "new-clip-1", sourceId: idA },
      { id: "new-clip-2", sourceId: idB },
    ]);
    expect(state.sequenceSegments).toEqual([
      {
        id: "new-seg-1",
        inClipId: "new-clip-1",
        inPts: "1000",
        outClipId: "new-clip-2",
        outPts: "500",
        name: "Cross",
      },
    ]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.attachedClipId).toBe("new-clip-1");
    expect(state.generation).toBe(before.generation + 1);
    expect(Object.keys(h.media.getState().sources).sort()).toEqual([idA, idB].sort());
    expect(h.media.getState().media?.path).toBe(A.path);
    expect(h.audioOverrides.getState().overrides).toEqual({});
    expect(h.project.getState().file).toEqual({
      path: PROJECT_PATH,
      name: "cut.qcproj",
    });
    expect(h.project.getState().identity).toBeGreaterThan(identity);
    const content = projectContentOf(state, h.audioOverrides.getState().overrides);
    expect(h.project.getState().savedContent).toBe(content);
    expect(isProjectModified(h.project.getState(), content)).toBe(false);
    expect(h.step.store.getState()).toEqual({
      phase: { kind: "idle" },
      projectPath: null,
      mode: "open",
    });
    expect(h.step.isOpening()).toBe(false);

    // The commands: the expected revision of each entry, and the second compare of step 7.
    expect(h.importMedia).toHaveBeenCalledWith(A.path, { size: 1000, mtime: A.mtime });
    expect(h.calls).toEqual([
      "stale",
      "stale",
      "load",
      `import ${A.path}`,
      `import ${B.path}`,
      `revision ${A.path}`,
      `revision ${B.path}`,
      // The playback stops, and nothing that waited stays, before the sequence changes.
      "pause old-clip",
      "dropNavigation",
      "resetPlayback",
      "media",
      "sequence",
      // The overrides change after the new sequence, so the preview takes them as the choice of
      // a new attachment.
      `overrides at generation ${before.generation + 1}`,
    ]);
  });

  it("shows the progress of the check of each source", async () => {
    const answer = held<ImportMediaResult>();
    const h = harness({ disk: { ...diskOf(A), [B.path]: answer } });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(h.step.store.getState()).toEqual({
      phase: {
        kind: "checking",
        stage: "sources",
        current: 2,
        total: 2,
        fileName: "b.mp4",
      },
      projectPath: PROJECT_PATH,
      mode: "open",
    });
    expect(h.step.isOpening()).toBe(true);
    answer.resolve(mediaForEntry(B, B.path));
    await expect(opening).resolves.toMatchObject({ status: "opened" });
  });

  it("tries the relPath candidate first and the path second, and does not mark the project", async () => {
    const relative = "/projects/media/a.mp4";
    const first = harness({
      load: loaded(documentOf([A, B]), [[relative, A.path], [B.path]]),
      disk: { ...diskOf(A, B), [relative]: mediaForEntry(A, relative) },
    });
    await expect(first.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    expect(first.importMedia.mock.calls.map(([path]) => path)).toEqual([
      relative,
      B.path,
    ]);
    expect(first.media.getState().media?.path).toBe(relative);
    expect(first.project.getState().located).toBe(false);

    const second = harness({
      load: loaded(documentOf([A, B]), [[relative, A.path], [B.path]]),
      disk: diskOf(A, B),
    });
    await expect(second.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    expect(second.importMedia.mock.calls.map(([path]) => path)).toEqual([
      relative,
      A.path,
      B.path,
    ]);
  });

  it("gives the reason of the first candidate that is not absent", async () => {
    const relative = "/r/a.mp4";
    const cases: [DiskEntry | undefined, DiskEntry | undefined, unknown][] = [
      [undefined, "revisionMismatch", { kind: "changed" }],
      ["pathNotFile", "invalidPath", { kind: "absent" }],
      ["revisionMismatch", "ffprobeTimedOut", { kind: "changed" }],
      [
        "ffprobeTimedOut",
        undefined,
        {
          kind: "importFailed",
          error: expect.objectContaining({ code: "ffprobeTimedOut" }) as unknown,
        },
      ],
      [
        undefined,
        mediaForEntry(A, A.path, { videoStartPts: pts("1") }),
        { kind: "readsOtherwise", fact: "videoStartPts" },
      ],
      [
        undefined,
        mediaForEntry(A, A.path, { videoStreamIndex: 1 }),
        { kind: "readsOtherwise", fact: "videoStreamIndex" },
      ],
      [
        undefined,
        mediaForEntry(A, A.path, { videoTimeBase: { n: 1, d: 90000 } }),
        { kind: "readsOtherwise", fact: "videoTimeBase" },
      ],
    ];
    for (const [atRelative, atPath, failure] of cases) {
      const disk: Record<string, DiskEntry> = diskOf(B);
      if (atRelative !== undefined) {
        disk[relative] = atRelative;
      }
      if (atPath !== undefined) {
        disk[A.path] = atPath;
      }
      const h = harness({
        load: loaded(documentOf([A, B]), [[relative, A.path], [B.path]]),
        disk,
      });
      const before = h.snapshot();
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      expect(rowOf(h, "e1")).toEqual({
        entryId: "e1",
        fileName: "a.mp4",
        documentPath: A.path,
        foundPath: null,
        failure,
      });
      // A row that was found at once is not listed.
      expect(() => rowOf(h, "e2")).toThrow("no row e2");
      const phase = h.phase();
      expect(phase.kind === "locating" && phase.canOpen).toBe(false);
      h.step.cancel();
      await expect(opening).resolves.toEqual({ status: "canceled" });
      expect(h.snapshot()).toEqual(before);
    }
  });

  it("finds a row with Locate, marks the project, and opens on confirm", async () => {
    const h = harness({
      disk: { ...diskOf(B), "/new/a.mp4": mediaForEntry(A, "/new/a.mp4") },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(h, "e1").failure).toEqual({ kind: "absent" });

    h.pickFile.mockResolvedValueOnce("/new/a.mp4");
    await h.step.locate("e1");
    expect(h.pickFile).toHaveBeenCalledWith("/old");
    expect(rowOf(h, "e1")).toMatchObject({ foundPath: "/new/a.mp4", failure: null });
    const phase = h.phase();
    expect(phase.kind === "locating" && phase.canOpen).toBe(true);
    // Each row that is found waits for the Open button.
    await flush();
    expect(h.readSourceRevision).not.toHaveBeenCalled();

    h.step.confirm();
    await expect(opening).resolves.toMatchObject({ status: "opened" });
    expect(h.project.getState().located).toBe(true);
    const content = projectContentOf(h.timeline.getState(), {});
    expect(isProjectModified(h.project.getState(), content)).toBe(true);
  });

  it("keeps the row with the result of a located file that does not hold", async () => {
    const h = harness({ disk: { ...diskOf(B), "/new/a.mp4": "revisionMismatch" } });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    await expect(h.step.locateFile("e1", "/new/a.mp4")).resolves.toBe(false);
    expect(rowOf(h, "e1")).toMatchObject({
      foundPath: null,
      failure: { kind: "changed" },
    });
    // Open does nothing while a row is not found.
    h.step.confirm();
    await flush();
    expect(h.readSourceRevision).not.toHaveBeenCalled();
    h.step.cancel();
    await expect(opening).resolves.toEqual({ status: "canceled" });
  });

  it("tries the other rows in the directory of a located file", async () => {
    const h = harness({
      disk: {
        "/new/a.mp4": mediaForEntry(A, "/new/a.mp4"),
        "/new/b.mp4": mediaForEntry(B, "/new/b.mp4"),
      },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(h, "e2").failure).toEqual({ kind: "absent" });
    await expect(h.step.locateFile("e1", "/new/a.mp4")).resolves.toBe(true);
    expect(rowOf(h, "e2")).toMatchObject({ foundPath: "/new/b.mp4", failure: null });
    h.step.confirm();
    await expect(opening).resolves.toMatchObject({ status: "opened" });
    expect(h.project.getState().located).toBe(true);
  });

  it("goes back to the list when a file changed before step 7, and opens after a new Locate", async () => {
    const h = harness({
      disk: {
        ...diskOf(B),
        "/new/a.mp4": mediaForEntry(A, "/new/a.mp4"),
        "/new2/a.mp4": mediaForEntry(A, "/new2/a.mp4"),
      },
      revisions: { "/new/a.mp4": "revisionMismatch" },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    await h.step.locateFile("e1", "/new/a.mp4");
    h.step.confirm();
    await flush();
    expect(rowOf(h, "e1")).toMatchObject({
      foundPath: null,
      failure: { kind: "changed" },
    });
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual(["old-clip"]);

    await h.step.locateFile("e1", "/new2/a.mp4");
    h.step.confirm();
    await expect(opening).resolves.toMatchObject({ status: "opened" });
    expect(h.media.getState().media?.path).toBe("/new2/a.mp4");
  });

  it("goes back to the list when a file found at once changed before step 7", async () => {
    const h = harness({
      disk: { ...diskOf(A, B), "/new/b.mp4": mediaForEntry(B, "/new/b.mp4") },
      revisions: { [B.path]: "pathNotFound" },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(h, "e2")).toMatchObject({
      foundPath: null,
      failure: { kind: "absent" },
    });
    await h.step.locateFile("e2", "/new/b.mp4");
    h.step.confirm();
    await expect(opening).resolves.toMatchObject({ status: "opened" });
  });

  it("takes another file at the same path text in step 7 as a file that changed", async () => {
    // A link that now names another file with the same size and time: the canonical path of the
    // revision read is not the path of the checked import.
    const h = harness({
      disk: { ...diskOf(A, B), "/new/b.mp4": mediaForEntry(B, "/new/b.mp4") },
      revisions: {
        [B.path]: { path: "/elsewhere/b.mp4", size: B.size, mtime: B.mtime },
      },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(h, "e2")).toMatchObject({
      foundPath: null,
      failure: { kind: "changed" },
    });
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual(["old-clip"]);
    await h.step.locateFile("e2", "/new/b.mp4");
    expect(h.step.confirm()).toBe(true);
    await expect(opening).resolves.toMatchObject({ status: "opened" });
  });

  it("finds a row in the directory of a located file by a name with a backslash", async () => {
    const tape = entryOf("e2", "/old/Tape\\B.mp4", { size: 2000 });
    const h = harness({
      load: loaded(documentOf([A, tape])),
      disk: {
        "/new/a.mp4": mediaForEntry(A, "/new/a.mp4"),
        "/new/Tape\\B.mp4": mediaForEntry(tape, "/new/Tape\\B.mp4"),
      },
    });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(h, "e2").fileName).toBe("Tape\\B.mp4");
    await expect(h.step.locateFile("e1", "/new/a.mp4")).resolves.toBe(true);
    expect(rowOf(h, "e2").foundPath).toBe("/new/Tape\\B.mp4");
    expect(h.step.confirm()).toBe(true);
    await expect(opening).resolves.toMatchObject({ status: "opened" });
  });

  describe("the hold of a locate operation", () => {
    it("refuses each other request while the file dialog shows, and releases after it", async () => {
      const h = harness({
        disk: {
          "/new/a.mp4": mediaForEntry(A, "/new/a.mp4"),
          "/new/b.mp4": mediaForEntry(B, "/new/b.mp4"),
        },
      });
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      const dialog = held<string | null>();
      h.pickFile.mockReturnValueOnce(dialog.promise);
      const first = h.step.locate("e1");
      const phase = h.phase();
      expect(phase.kind === "locating" && phase.busy).toBe(true);
      await expect(h.step.locate("e2")).resolves.toBe(false);
      await expect(h.step.locateFile("e2", "/new/b.mp4")).resolves.toBe(false);
      expect(h.step.confirm()).toBe(false);
      expect(h.pickFile).toHaveBeenCalledTimes(1);
      expect(h.importMedia).toHaveBeenCalledTimes(2);

      // The user cancels the dialog: the hold goes, and the row stays.
      dialog.resolve(null);
      await expect(first).resolves.toBe(false);
      expect(rowOf(h, "e1").failure).toEqual({ kind: "absent" });
      await expect(h.step.locateFile("e1", "/new/a.mp4")).resolves.toBe(true);
      expect(h.step.confirm()).toBe(true);
      await expect(opening).resolves.toMatchObject({ status: "opened" });
    });

    it("refuses each other request during the check of the chosen file", async () => {
      const answer = held<ImportMediaResult>();
      const h = harness({ disk: { ...diskOf(B), "/new/a.mp4": answer } });
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      h.pickFile.mockResolvedValueOnce("/new/a.mp4");
      const first = h.step.locate("e1");
      await flush();
      expect(h.importMedia).toHaveBeenLastCalledWith("/new/a.mp4", expect.anything());
      await expect(h.step.locate("e1")).resolves.toBe(false);
      await expect(h.step.locateFile("e1", "/new/a.mp4")).resolves.toBe(false);
      expect(h.step.confirm()).toBe(false);
      expect(h.pickFile).toHaveBeenCalledTimes(1);
      answer.resolve(mediaForEntry(A, "/new/a.mp4"));
      await expect(first).resolves.toBe(true);
      expect(h.step.confirm()).toBe(true);
      await expect(opening).resolves.toMatchObject({ status: "opened" });
    });

    it("releases the hold when the file dialog fails, so the user can try again", async () => {
      const h = harness({
        disk: { ...diskOf(B), "/new/a.mp4": mediaForEntry(A, "/new/a.mp4") },
      });
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      h.pickFile.mockRejectedValueOnce(new Error("dialog"));
      await expect(h.step.locate("e1")).resolves.toBe(false);
      const phase = h.phase();
      expect(phase.kind === "locating" && phase.busy).toBe(false);
      expect(rowOf(h, "e1")).toMatchObject({
        foundPath: null,
        failure: { kind: "absent" },
      });
      h.pickFile.mockResolvedValueOnce("/new/a.mp4");
      await expect(h.step.locate("e1")).resolves.toBe(true);
      h.step.confirm();
      await expect(opening).resolves.toMatchObject({ status: "opened" });
    });
  });

  it("gives two entries of one revision one source when they agree", async () => {
    const link = entryOf("e3", "/link/a.mp4");
    const h = harness({
      load: loaded(
        documentOf(
          [A, link],
          [
            { id: "d1", sourceId: "e1" },
            { id: "d3", sourceId: "e3" },
          ],
          [],
        ),
      ),
      // The link gives the same canonical file.
      disk: { ...diskOf(A), [link.path]: mediaForEntry(link, A.path) },
    });
    await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    const clips = h.timeline.getState().clips;
    expect(clips).toHaveLength(2);
    expect(clips[0]?.sourceId).toBe(clips[1]?.sourceId);
    expect(Object.keys(h.media.getState().sources)).toHaveLength(1);
  });

  it("fails when two entries of one revision differ, and changes nothing", async () => {
    const link = entryOf("e3", "/link/a.mp4", { approximateDurationSeconds: 11 });
    const h = harness({
      load: loaded(
        documentOf(
          [A, link],
          [
            { id: "d1", sourceId: "e1" },
            { id: "d3", sourceId: "e3" },
          ],
          [],
        ),
      ),
      disk: { ...diskOf(A), [link.path]: mediaForEntry(link, A.path) },
    });
    const before = h.snapshot();
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    const error = { kind: "entriesDiffer", entryIds: ["e1", "e3"] };
    expect(h.phase()).toEqual({ kind: "failed", error });
    // The step waits for the close of the error view.
    h.step.cancel();
    await expect(opening).resolves.toEqual({ status: "failed", error });
    expect(h.snapshot()).toEqual(before);
    expect(h.phase()).toEqual({ kind: "idle" });
  });

  it("takes the end of an FLV entry, also when its probe gives another end", async () => {
    const flv = entryOf("e1", "/old/live.flv", {
      videoEndPts: pts("9000"),
      fingerprint: { start: "0", fnv1a64: "0123456789abcdef" },
    });
    const h = harness({
      load: loaded(documentOf([flv, B])),
      disk: {
        ...diskOf(B),
        [flv.path]: mediaForEntry(flv, flv.path, {
          formatNames: ["flv"],
          videoEndPts: pts("9500"),
        }),
      },
    });
    await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    expect(h.importMedia).toHaveBeenCalledWith(flv.path, {
      size: 1000,
      mtime: flv.mtime,
      fingerprint: { start: "0", fnv1a64: "0123456789abcdef" },
    });
    const id = h.timeline.getState().clips[0].sourceId;
    expect(h.media.getState().sources[id]?.probe.videoEndPts).toBe("9000");
    expect(h.timeline.getState().sequenceSources[id]?.videoEndPts).toBe("9000");

    // An entry with no fingerprint must have the end of its probe.
    const plain = harness({
      disk: {
        ...diskOf(B),
        [A.path]: mediaForEntry(A, A.path, { videoEndPts: pts("9500") }),
      },
    });
    const opening = plain.step.open(PROJECT_PATH);
    await flush();
    expect(rowOf(plain, "e1").failure).toEqual({
      kind: "readsOtherwise",
      fact: "videoEndPts",
    });
    plain.step.cancel();
    await opening;
  });

  it("takes the audio choice of an entry, and refuses a file whose stream is gone", async () => {
    const chosen = entryOf("e1", "/old/two.mkv", { audioStreamIndex: 2 });
    const h = harness({
      load: loaded(documentOf([chosen, B])),
      disk: {
        ...diskOf(B),
        [chosen.path]: mediaForEntry(chosen, chosen.path, {
          audioStreams: [stream(1), stream(2)],
        }),
      },
    });
    await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    const id = h.timeline.getState().clips[0].sourceId;
    expect(h.audioOverrides.getState().overrides).toEqual({
      [id]: { index: 2, codec: "aac", sampleRate: 48000, channels: 2 },
    });

    for (const probe of [
      { audioStreams: [stream(1), stream(3)] },
      // One stream: no submenu, so no choice.
      { audioStreams: [stream(2)] },
      // An FLV takes no override.
      { formatNames: ["flv"], audioStreams: [stream(1), stream(2)] },
    ]) {
      const gone = harness({
        load: loaded(documentOf([chosen, B])),
        disk: {
          ...diskOf(B),
          [chosen.path]: mediaForEntry(chosen, chosen.path, probe),
        },
      });
      const opening = gone.step.open(PROJECT_PATH);
      await flush();
      expect(rowOf(gone, "e1").failure).toEqual({
        kind: "readsOtherwise",
        fact: "audioStream",
      });
      gone.step.cancel();
      await opening;
    }
  });

  it("opens a document with no clip as an empty sequence with no file", async () => {
    const h = harness({ load: loaded(documentOf([A], [], [])), disk: diskOf(A) });
    await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
      status: "opened",
    });
    expect(h.importMedia).not.toHaveBeenCalled();
    expect(h.timeline.getState().clips).toEqual([]);
    expect(h.media.getState().sources).toEqual({});
    expect(h.media.getState().media).toBeNull();
    expect(h.audioOverrides.getState().overrides).toEqual({});
    expect(h.project.getState().file).toBeNull();
  });

  it("fails for a project file that does not load, and for a document that the rules refuse", async () => {
    const failing = harness({
      load: new ProjectCommandError({ code: "invalidJson" }),
    });
    const opening = failing.step.open(PROJECT_PATH);
    await flush();
    const phase = failing.phase();
    expect(phase.kind === "failed" && phase.error.kind).toBe("loadFailed");
    failing.step.cancel();
    const result = await opening;
    expect(
      result.status === "failed" && result.error.kind === "loadFailed"
        ? result.error.error.code
        : null,
    ).toBe("invalidJson");

    const bare = entryOf("e1", "/old/bare.ts", {
      videoEndPts: null,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    });
    const refused = harness({ load: loaded(documentOf([bare, B], CLIPS, [])) });
    const refusing = refused.step.open(PROJECT_PATH);
    await flush();
    expect(refused.phase()).toEqual({
      kind: "failed",
      error: {
        kind: "documentRefused",
        problem: { kind: "clipExtentUnknown", clipId: "d1", sourceId: "e1" },
      },
    });
    expect(refused.importMedia).not.toHaveBeenCalled();
    refused.step.cancel();
    await refusing;
  });

  it("fails when the sequence with the facts of this session cannot be laid out", async () => {
    // The document has an extent from its ticks. The new probe gives none.
    const ticked = entryOf("e1", "/old/ticked.ts", { videoEndPts: null });
    const h = harness({
      load: loaded(documentOf([ticked, B], CLIPS, [])),
      disk: {
        ...diskOf(B),
        [ticked.path]: mediaForEntry(ticked, ticked.path, {
          videoDurationTicks: null,
          approximateDurationSeconds: null,
        }),
      },
    });
    const before = h.snapshot();
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    const id = getGeneratedSourceId(mediaForEntry(ticked, ticked.path))!;
    expect(h.phase()).toEqual({
      kind: "failed",
      error: {
        kind: "sequenceRefused",
        problem: { kind: "clipExtentUnknown", clipId: "new-clip-1", sourceId: id },
      },
    });
    h.step.cancel();
    await opening;
    expect(h.snapshot()).toEqual(before);
  });

  describe("step 2", () => {
    it("waits for a save step that runs", async () => {
      const h = harness({ disk: diskOf(A, B) });
      const running = held<void>();
      h.whenIdle.mockReturnValueOnce(running.promise);
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      expect(h.loadProject).not.toHaveBeenCalled();
      expect(h.staleExportOpenStep).not.toHaveBeenCalled();
      running.resolve();
      await expect(opening).resolves.toMatchObject({ status: "opened" });
    });

    it("changes nothing while another dialog of the window is open", async () => {
      const h = harness({ disk: diskOf(A, B), otherDialog: true });
      const before = h.snapshot();
      await expect(h.step.open(PROJECT_PATH)).resolves.toEqual({ status: "blocked" });
      expect(h.staleExportOpenStep).not.toHaveBeenCalled();
      expect(h.loadProject).not.toHaveBeenCalled();
      expect(h.ask).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
      expect(h.phase()).toEqual({ kind: "idle" });
    });

    it("changes nothing when another dialog opened during the save of the prompt", async () => {
      // The export dialog, or a trim of a segment edge, can start while the file is written.
      const saved = () => h.saveStep.save.mock.calls.length > 0;
      const h = harness({
        disk: diskOf(A, B),
        changes: () => !saved(),
        answers: ["save"],
        otherDialog: saved,
      });
      const before = h.snapshot();

      await expect(h.step.open(PROJECT_PATH)).resolves.toEqual({ status: "blocked" });

      expect(h.saveStep.save).toHaveBeenCalledTimes(1);
      expect(h.loadProject).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
      expect(h.phase()).toEqual({ kind: "idle" });
    });

    it("opens after the save of the prompt when no other dialog opened", async () => {
      const saved = () => h.saveStep.save.mock.calls.length > 0;
      const h = harness({
        disk: diskOf(A, B),
        changes: () => !saved(),
        answers: ["save"],
      });

      await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
        status: "opened",
      });
      expect(h.saveStep.save).toHaveBeenCalledTimes(1);
    });

    it("does not test again after Don't Save, which ran no save", async () => {
      // The closed save prompt can still be in the document when the step goes on.
      const asked = () => h.ask.mock.calls.length > 0;
      const h = harness({
        disk: diskOf(A, B),
        changes: true,
        answers: ["dontSave"],
        otherDialog: asked,
      });

      await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
        status: "opened",
      });
    });

    it("makes the open step of the export stale before it asks", async () => {
      const h = harness({ disk: diskOf(A, B), changes: true, answers: ["dontSave"] });
      await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
        status: "opened",
      });
      expect(h.calls.slice(0, 4)).toEqual(["stale", "ask", "stale", "load"]);
    });

    it("makes the open step of the export stale again after the save, before the project dialog shows", async () => {
      // An Export request that the user starts during the write can still wait when the write
      // ends. It must not open its dialog over the project dialog.
      const saved = () => h.saveStep.save.mock.calls.length > 0;
      const h = harness({
        disk: diskOf(A, B),
        changes: () => !saved(),
        answers: ["save"],
      });
      h.saveStep.save.mockImplementation(() => {
        h.calls.push("save");
        return Promise.resolve({ status: "saved", path: "/p.qcproj", bound: true });
      });
      h.step.store.subscribe((state, previous) => {
        if (state.phase.kind !== previous.phase.kind) {
          h.calls.push(`phase ${state.phase.kind}`);
        }
      });

      await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
        status: "opened",
      });

      expect(h.calls.slice(0, 6)).toEqual([
        "stale",
        "ask",
        "save",
        "stale",
        "phase loading",
        "load",
      ]);
    });

    it("stops after Cancel of the save prompt, and after a failed save", async () => {
      const canceled = harness({ changes: true, answers: ["cancel"] });
      await expect(canceled.step.open(PROJECT_PATH)).resolves.toEqual({
        status: "stopped",
        saveError: null,
      });
      expect(canceled.loadProject).not.toHaveBeenCalled();
      expect(canceled.phase()).toEqual({ kind: "idle" });

      const failed = harness({ changes: true, answers: ["save"] });
      failed.saves.push({ status: "failed", error: { kind: "noClip" } });
      await expect(failed.step.open(PROJECT_PATH)).resolves.toEqual({
        status: "stopped",
        saveError: { kind: "noClip" },
      });
      expect(failed.loadProject).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    /** Runs `start`, cancels at the await it reaches, then releases it. */
    async function cancelAt(
      h: ReturnType<typeof harness>,
      release: () => void,
      afterStart: () => Promise<void> = flush,
    ): Promise<OpenProjectResult> {
      const before = h.snapshot();
      const opening = h.step.open(PROJECT_PATH);
      await afterStart();
      expect(h.step.isOpening()).toBe(true);
      h.step.cancel();
      expect(h.phase()).toEqual({ kind: "idle" });
      // The step ends, and the next turn of the line starts, before the command answers.
      expect(h.step.isOpening()).toBe(false);
      const result = await opening;
      await expect(h.turn(() => Promise.resolve("next"))).resolves.toBe("next");
      release();
      await flush();
      expect(h.snapshot()).toEqual(before);
      expect(h.step.store.getState()).toEqual({
        phase: { kind: "idle" },
        projectPath: null,
        mode: "open",
      });
      expect(h.step.isOpening()).toBe(false);
      return result;
    }

    it("at the wait for a save step", async () => {
      const h = harness({ disk: diskOf(A, B) });
      const running = held<void>();
      h.whenIdle.mockReturnValueOnce(running.promise);
      await expect(cancelAt(h, () => running.resolve())).resolves.toEqual({
        status: "canceled",
      });
      expect(h.loadProject).not.toHaveBeenCalled();
    });

    it("at the save prompt", async () => {
      const h = harness({ disk: diskOf(A, B), changes: true });
      const answer = held<DropContentAnswer>();
      h.ask.mockReturnValueOnce(answer.promise);
      await expect(cancelAt(h, () => answer.resolve("dontSave"))).resolves.toEqual({
        status: "canceled",
      });
      expect(h.loadProject).not.toHaveBeenCalled();
    });

    it("at the save prompt, which then answers Save: no save starts", async () => {
      const h = harness({ disk: diskOf(A, B), changes: true });
      const answer = held<DropContentAnswer>();
      h.ask.mockReturnValueOnce(answer.promise);
      await expect(cancelAt(h, () => answer.resolve("save"))).resolves.toEqual({
        status: "canceled",
      });
      expect(h.saveStep.save).not.toHaveBeenCalled();
      expect(h.loadProject).not.toHaveBeenCalled();
    });

    it("at the load of the project file", async () => {
      const load = held<LoadProjectResult>();
      const h = harness({ load, disk: diskOf(A, B) });
      await expect(
        cancelAt(h, () => load.resolve(loaded(documentOf([A, B])))),
      ).resolves.toEqual({ status: "canceled" });
      expect(h.importMedia).not.toHaveBeenCalled();
    });

    it("at the check of a source", async () => {
      const answer = held<ImportMediaResult>();
      const h = harness({ disk: { ...diskOf(B), [A.path]: answer } });
      await expect(
        cancelAt(h, () => answer.resolve(mediaForEntry(A, A.path))),
      ).resolves.toEqual({ status: "canceled" });
      expect(h.importMedia).toHaveBeenCalledTimes(1);
    });

    it("at the list of the files to locate", async () => {
      const h = harness({ disk: diskOf(B) });
      await expect(cancelAt(h, () => undefined)).resolves.toEqual({
        status: "canceled",
      });
    });

    it("at the check of a located file", async () => {
      const answer = held<ImportMediaResult>();
      const h = harness({ disk: { ...diskOf(B), "/new/a.mp4": answer } });
      let locating: Promise<boolean> = Promise.resolve(false);
      await expect(
        cancelAt(
          h,
          () => answer.resolve(mediaForEntry(A, "/new/a.mp4")),
          async () => {
            await flush();
            locating = h.step.locateFile("e1", "/new/a.mp4");
            await flush();
          },
        ),
      ).resolves.toEqual({ status: "canceled" });
      await expect(locating).resolves.toBe(false);
    });

    it("at the second compare of step 7", async () => {
      const answer = held<MediaSourceRevisionDescriptor>();
      const h = harness({ disk: diskOf(A, B), revisions: { [B.path]: answer } });
      await expect(
        cancelAt(h, () =>
          answer.resolve({ path: B.path, size: B.size, mtime: B.mtime }),
        ),
      ).resolves.toEqual({ status: "canceled" });
    });

    it("stops a request that waits for its turn too", async () => {
      const load = held<LoadProjectResult>();
      const h = harness({ load, disk: diskOf(A, B) });
      const first = h.step.open(PROJECT_PATH);
      const second = h.step.open(PROJECT_PATH);
      await flush();
      expect(h.loadProject).toHaveBeenCalledTimes(1);
      h.step.cancel();
      expect(h.step.isOpening()).toBe(false);
      await expect(first).resolves.toEqual({ status: "canceled" });
      await expect(second).resolves.toEqual({ status: "canceled" });
      // The line is free before the load answers.
      await expect(h.turn(() => Promise.resolve("next"))).resolves.toBe("next");
      load.resolve(loaded(documentOf([A, B])));
      await flush();
      expect(h.loadProject).toHaveBeenCalledTimes(1);
      expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual(["old-clip"]);
    });

    it("ends a request that waits behind a turn that does not end", async () => {
      const h = harness({ disk: diskOf(A, B) });
      const blocker = held<void>();
      void h.turn(() => blocker.promise);
      const opening = h.step.open(PROJECT_PATH);
      await flush();
      expect(h.step.isOpening()).toBe(true);
      h.step.cancel();
      expect(h.step.isOpening()).toBe(false);
      await expect(opening).resolves.toEqual({ status: "canceled" });
      blocker.resolve();
      await flush();
      expect(h.loadProject).not.toHaveBeenCalled();
      // A new request runs after the turn ended.
      await expect(h.step.open(PROJECT_PATH)).resolves.toMatchObject({
        status: "opened",
      });
    });
  });

  it("runs a second request after the first one, in the line", async () => {
    const load = held<LoadProjectResult>();
    const h = harness({ load, disk: diskOf(A, B) });
    const first = h.step.open(PROJECT_PATH);
    const second = h.step.open(PROJECT_PATH);
    await flush();
    expect(h.loadProject).toHaveBeenCalledTimes(1);
    load.resolve(loaded(documentOf([A, B])));
    await expect(first).resolves.toMatchObject({ status: "opened" });
    await expect(second).resolves.toMatchObject({ status: "opened" });
    expect(h.loadProject).toHaveBeenCalledTimes(2);
    // The second open made new identifiers again.
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual([
      "new-clip-3",
      "new-clip-4",
    ]);
  });

  it("takes a turn in the line of the imports: an import in front, and one behind at the end", async () => {
    const front = held<ImportMediaResult>();
    const frontMedia = mediaAt("/line/front.mp4");
    const behindMedia = mediaAt("/line/behind.mp4");
    const h = harness({
      disk: diskOf(A, B),
      realLine: true,
      mediaImports: { "/line/front.mp4": front, "/line/behind.mp4": behindMedia },
    });
    let next = 0;
    const deps = {
      media: h.media,
      timeline: h.timeline,
      generateClipId: () => `import-${++next}`,
    };
    const inFront = importClips(["/line/front.mp4"], null, deps);
    const opening = h.step.open(PROJECT_PATH);
    // A drop at the first junction of the sequence before the open.
    const behind = importClips(["/line/behind.mp4"], 0, deps);
    await flush();
    expect(h.loadProject).not.toHaveBeenCalled();

    front.resolve(frontMedia);
    await expect(inFront).resolves.toHaveLength(1);
    await expect(opening).resolves.toMatchObject({ status: "opened" });
    await expect(behind).resolves.toHaveLength(1);
    expect(h.timeline.getState().clips.map((clip) => clip.id)).toEqual([
      "new-clip-1",
      "new-clip-2",
      "import-2",
    ]);
  });
});

describe("the restore of an offer", () => {
  const OFFER = { id: "00000000000000ab", projectPath: "/old/stream.qcproj" };
  /**
   * The `projectPath` that the read gives. It is another path than the one of the list, so each
   * test shows that the proposed path is the one of the read.
   */
  const READ_PATH = "/read/stream.qcproj";

  /** The answer of `read_recovery` for `project`: one candidate path for each source. */
  function recovered(
    project: Project,
    projectPath: string | null = READ_PATH,
  ): RecoveryReadResult {
    return {
      owner: true,
      status: "done",
      offer: {
        projectPath,
        project,
        candidates: project.sources.map((entry) => [entry.path]),
      },
    };
  }

  /** The functions of one restore, which note their calls in the calls of the harness. */
  function hooksOf(
    h: ReturnType<typeof harness>,
    read: RecoveryReadResult | Held<RecoveryReadResult> | Error = recovered(
      documentOf([A, B]),
    ),
  ) {
    const readRecovery = vi.fn((id: string) => {
      h.calls.push(`read ${id}`);
      if (read instanceof Error) {
        return Promise.reject(read);
      }
      return isHeld<RecoveryReadResult>(read) ? read.promise : Promise.resolve(read);
    });
    const onRestored = vi.fn((id: string) => {
      h.calls.push(`restored ${id}`);
    });
    return { readRecovery, onRestored };
  }

  it("reads the document from the offer, and leaves the project with no file and the proposed path", async () => {
    const h = harness({ disk: diskOf(A, B) });
    const hooks = hooksOf(h);
    const identity = h.project.getState().identity;
    // What step 8 has done when it calls `onRestored`.
    let atRestored: unknown = null;
    hooks.onRestored.mockImplementation((id: string) => {
      h.calls.push(`restored ${id}`);
      atRestored = {
        clips: h.timeline.getState().clips.map((clip) => clip.id),
        file: h.project.getState().file,
        proposedPath: h.project.getState().proposedPath,
        phase: h.phase().kind,
      };
    });

    const result: RestoreProjectResult = await h.step.restore(OFFER, hooks);

    expect(result).toEqual({ status: "restored" });
    expect(h.loadProject).not.toHaveBeenCalled();
    expect(hooks.readRecovery).toHaveBeenCalledWith(OFFER.id);
    expect(hooks.onRestored).toHaveBeenCalledTimes(1);
    expect(atRestored).toEqual({
      clips: ["new-clip-1", "new-clip-2"],
      file: null,
      proposedPath: READ_PATH,
      phase: "idle",
    });
    const state = h.project.getState();
    expect(state.file).toBeNull();
    // The proposed path is the `projectPath` of the read, not the one of the list.
    expect(state.proposedPath).toBe(READ_PATH);
    expect(state.savedContent).toBe(EMPTY_PROJECT_CONTENT);
    expect(state.located).toBe(false);
    expect(state.identity).toBeGreaterThan(identity);
    // The restored work has changes to save, as each project with no file with a segment.
    const content = projectContentOf(h.timeline.getState(), {});
    expect(hasChangesToSave(state, content, 1)).toBe(true);
    expect(
      h.timeline.getState().sequenceSegments.map((segment) => segment.name),
    ).toEqual(["Cross"]);
    // Each step of an open, with the read in place of the load, and `onRestored` last.
    const generation = h.timeline.getState().generation;
    expect(h.calls).toEqual([
      "stale",
      "stale",
      `read ${OFFER.id}`,
      `import ${A.path}`,
      `import ${B.path}`,
      `revision ${A.path}`,
      `revision ${B.path}`,
      "pause old-clip",
      "dropNavigation",
      "resetPlayback",
      "media",
      "sequence",
      `overrides at generation ${generation}`,
      `restored ${OFFER.id}`,
    ]);
    expect(h.step.store.getState()).toEqual({
      phase: { kind: "idle" },
      projectPath: null,
      mode: "open",
    });
  });

  it("says in the store that the step is a restore, with the path of the list, and proposes the path of the read", async () => {
    const cases: [string | null, string | null][] = [
      [OFFER.projectPath, READ_PATH],
      [null, READ_PATH],
      [OFFER.projectPath, null],
    ];
    for (const [listed, read] of cases) {
      const h = harness({ disk: diskOf(A, B) });
      const answer = held<RecoveryReadResult>();
      const restoring = h.step.restore(
        { ...OFFER, projectPath: listed },
        hooksOf(h, answer),
      );
      await flush();
      expect(h.step.store.getState()).toEqual({
        phase: { kind: "loading" },
        projectPath: listed,
        mode: "restore",
      });
      answer.resolve(recovered(documentOf([A, B]), read));
      await expect(restoring).resolves.toEqual({ status: "restored" });
      expect(h.project.getState().proposedPath).toBe(read);
    }
  });

  it("tries the one candidate of each source, and lists a source that is absent", async () => {
    const h = harness({
      disk: { ...diskOf(B), "/new/a.mp4": mediaForEntry(A, "/new/a.mp4") },
    });
    const hooks = hooksOf(h);
    const restoring = h.step.restore(OFFER, hooks);
    await flush();
    expect(h.importMedia.mock.calls.map(([path]) => path)).toEqual([A.path, B.path]);
    expect(rowOf(h, "e1").failure).toEqual({ kind: "absent" });
    expect(hooks.onRestored).not.toHaveBeenCalled();
    await h.step.locateFile("e1", "/new/a.mp4");
    h.step.confirm();
    await expect(restoring).resolves.toEqual({ status: "restored" });
    // A located file makes no file of the project either.
    expect(h.project.getState()).toMatchObject({
      file: null,
      located: false,
      proposedPath: READ_PATH,
    });
    expect(h.media.getState().media?.path).toBe("/new/a.mp4");
  });

  it("keeps no proposed path for a document with no clip", async () => {
    const h = harness();
    const hooks = hooksOf(h, recovered(documentOf([], [], [])));
    await expect(h.step.restore(OFFER, hooks)).resolves.toEqual({ status: "restored" });
    expect(h.timeline.getState().clips).toEqual([]);
    expect(h.project.getState()).toMatchObject({ file: null, proposedPath: null });
    expect(hooks.onRestored).toHaveBeenCalledWith(OFFER.id);
  });

  it("fails with the error of a read that gave no document", async () => {
    const failure = new RecoveryCommandError({ code: "invalidRecoveryFile" });
    const cases: [RecoveryReadResult | Error, unknown][] = [
      [
        { owner: true, status: "failed", error: failure },
        { kind: "recoveryReadFailed", status: "failed", error: failure },
      ],
      [
        { owner: false, status: "notOwner" },
        { kind: "recoveryReadFailed", status: "notOwner", error: null },
      ],
      [
        { owner: false, status: "staleSession" },
        { kind: "recoveryReadFailed", status: "staleSession", error: null },
      ],
      [
        new Error("ipc"),
        {
          kind: "recoveryReadFailed",
          status: "failed",
          error: expect.objectContaining({ code: "unknown" }) as unknown,
        },
      ],
    ];
    for (const [read, error] of cases) {
      const h = harness({ disk: diskOf(A, B) });
      const before = h.snapshot();
      const hooks = hooksOf(h, read);
      const restoring = h.step.restore(OFFER, hooks);
      await flush();
      expect(h.phase()).toEqual({ kind: "failed", error });
      expect(h.step.store.getState().mode).toBe("restore");
      h.step.cancel();
      await expect(restoring).resolves.toEqual({ status: "failed", error });
      expect(h.importMedia).not.toHaveBeenCalled();
      expect(hooks.onRestored).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
    }
  });

  it("answers a quit that closes the error view as a cancel of a quit, and a close of the user as a failure", async () => {
    const failure = new RecoveryCommandError({ code: "readFailed" });
    const read: RecoveryReadResult = { owner: true, status: "failed", error: failure };
    const error = { kind: "recoveryReadFailed", status: "failed", error: failure };
    for (const [reason, expected] of [
      ["quit", { status: "canceled", by: "quit" }],
      ["user", { status: "failed", error }],
      [undefined, { status: "failed", error }],
    ] as const) {
      const h = harness({ disk: diskOf(A, B) });
      const before = h.snapshot();
      const hooks = hooksOf(h, read);
      const restoring = h.step.restore(OFFER, hooks);
      await flush();
      expect(h.phase()).toEqual({ kind: "failed", error });
      h.step.cancel(reason);
      await expect(restoring).resolves.toEqual(expected);
      expect(hooks.onRestored).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
    }
  });

  it("answers an open whose error view a quit closed with its error, as before", async () => {
    const failure = new ProjectCommandError({ code: "invalidJson" });
    const h = harness({ load: failure });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    expect(h.phase()).toMatchObject({ kind: "failed" });
    h.step.cancel("quit");
    await expect(opening).resolves.toEqual({
      status: "failed",
      error: { kind: "loadFailed", error: failure },
    });
  });

  it("fails for a document that fails the rules of the sequence", async () => {
    const h = harness({ disk: diskOf(A, B) });
    const hooks = hooksOf(
      h,
      recovered(documentOf([A, B], [...CLIPS, { id: "d1", sourceId: "e2" }])),
    );
    const restoring = h.step.restore(OFFER, hooks);
    await flush();
    expect(h.phase()).toMatchObject({
      kind: "failed",
      error: { kind: "documentRefused" },
    });
    h.step.cancel();
    await expect(restoring).resolves.toMatchObject({ status: "failed" });
    expect(hooks.onRestored).not.toHaveBeenCalled();
  });

  it("changes nothing while another dialog of the window is open", async () => {
    const h = harness({ disk: diskOf(A, B), otherDialog: true });
    const before = h.snapshot();
    const hooks = hooksOf(h);
    await expect(h.step.restore(OFFER, hooks)).resolves.toEqual({ status: "blocked" });
    expect(hooks.readRecovery).not.toHaveBeenCalled();
    expect(hooks.onRestored).not.toHaveBeenCalled();
    expect(h.snapshot()).toEqual(before);
  });

  it("tests again for another dialog after the save of the prompt", async () => {
    const saved = () => h.saveStep.save.mock.calls.length > 0;
    const h = harness({
      disk: diskOf(A, B),
      changes: () => !saved(),
      answers: ["save"],
      otherDialog: saved,
    });
    const hooks = hooksOf(h);
    await expect(h.step.restore(OFFER, hooks)).resolves.toEqual({ status: "blocked" });
    expect(h.saveStep.save).toHaveBeenCalledTimes(1);
    expect(hooks.readRecovery).not.toHaveBeenCalled();
  });

  it("makes the open step of the export stale before the prompt and before the dialog", async () => {
    const h = harness({ disk: diskOf(A, B), changes: true, answers: ["dontSave"] });
    await expect(h.step.restore(OFFER, hooksOf(h))).resolves.toEqual({
      status: "restored",
    });
    expect(h.calls.slice(0, 4)).toEqual(["stale", "ask", "stale", `read ${OFFER.id}`]);
  });

  it("stops at Cancel of the save prompt, and at a save of the prompt that failed", async () => {
    const canceled = harness({ changes: true, answers: ["cancel"] });
    const canceledHooks = hooksOf(canceled);
    await expect(canceled.step.restore(OFFER, canceledHooks)).resolves.toEqual({
      status: "stopped",
      saveError: null,
    });
    expect(canceledHooks.readRecovery).not.toHaveBeenCalled();

    const failed = harness({ changes: true, answers: ["save"] });
    failed.saves.push({ status: "failed", error: { kind: "noClip" } });
    await expect(failed.step.restore(OFFER, hooksOf(failed))).resolves.toEqual({
      status: "stopped",
      saveError: { kind: "noClip" },
    });
  });

  it("tells a cancel of the user from a cancel of a quit, and changes nothing before step 8", async () => {
    for (const reason of ["user", "quit"] as const) {
      // At the read of the offer.
      const atRead = harness({ disk: diskOf(A, B) });
      const before = atRead.snapshot();
      const read = held<RecoveryReadResult>();
      const hooks = hooksOf(atRead, read);
      const restoring = atRead.step.restore(OFFER, hooks);
      await flush();
      atRead.step.cancel(reason);
      await expect(restoring).resolves.toEqual({ status: "canceled", by: reason });
      read.resolve(recovered(documentOf([A, B])));
      await flush();
      expect(atRead.importMedia).not.toHaveBeenCalled();
      expect(hooks.onRestored).not.toHaveBeenCalled();
      expect(atRead.snapshot()).toEqual(before);

      // At the list of the files to locate.
      const atList = harness({ disk: diskOf(B) });
      const listBefore = atList.snapshot();
      const listHooks = hooksOf(atList);
      const listing = atList.step.restore(OFFER, listHooks);
      await flush();
      expect(atList.phase().kind).toBe("locating");
      atList.step.cancel(reason);
      await expect(listing).resolves.toEqual({ status: "canceled", by: reason });
      expect(listHooks.onRestored).not.toHaveBeenCalled();
      expect(atList.snapshot()).toEqual(listBefore);
    }
  });

  it("says who canceled a restore that waits for its turn", async () => {
    const h = harness({ disk: diskOf(A, B) });
    const blocker = held<void>();
    void h.turn(() => blocker.promise);
    const hooks = hooksOf(h);
    const restoring = h.step.restore(OFFER, hooks);
    await flush();
    h.step.cancel("quit");
    await expect(restoring).resolves.toEqual({ status: "canceled", by: "quit" });
    blocker.resolve();
    await flush();
    expect(hooks.readRecovery).not.toHaveBeenCalled();
  });

  it("answers an open that a quit canceled as an open canceled", async () => {
    const h = harness({ disk: diskOf(B) });
    const opening = h.step.open(PROJECT_PATH);
    await flush();
    h.step.cancel("quit");
    await expect(opening).resolves.toEqual({ status: "canceled" });
  });
});
