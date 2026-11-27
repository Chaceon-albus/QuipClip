import { describe, expect, it } from "vitest";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore, type TimelineStore } from "@/features/timeline/store";
import type { Pts, TickCount } from "@/types/project";
import {
  EMPTY_PROJECT_CONTENT,
  projectContentOf,
  type ProjectContent,
} from "./document";
import {
  createProjectStore,
  hasChangesToSave,
  installProjectSequenceRule,
  isProjectModified,
  projectStore,
  type ProjectFile,
  type ProjectStore,
} from "./store";

const pts = (value: string) => value as Pts;

const SOURCE: SequenceSource = {
  id: "a",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: pts("10000"),
  videoDurationTicks: "10000" as TickCount,
  approximateDurationSeconds: 10,
};

const FILE: ProjectFile = { path: "/projects/cut.qcproj", name: "cut.qcproj" };
const OTHER_FILE: ProjectFile = {
  path: "/projects/other.qcproj",
  name: "other.qcproj",
};

/** A test timeline store and a project store with the rule of the sequence installed on them. */
function harness(): {
  timeline: TimelineStore;
  project: ProjectStore;
  uninstall: () => void;
} {
  let next = 0;
  const timeline = createTimelineStore({ generateId: () => `g-${++next}` });
  const project = createProjectStore({
    sequenceHasClips: () => timeline.getState().clips.length > 0,
  });
  const uninstall = installProjectSequenceRule(project, timeline);
  return { timeline, project, uninstall };
}

/** Puts two clips of `a` on the sequence, with one segment. */
function addClips(timeline: TimelineStore): void {
  timeline.getState().insertClips(
    timeline.getState().clips.length,
    [
      { id: `c-${timeline.getState().clips.length + 1}`, sourceId: "a" },
      { id: `c-${timeline.getState().clips.length + 2}`, sourceId: "a" },
    ],
    [SOURCE],
  );
  const first = timeline.getState().clips[0]?.id ?? null;
  timeline.getState().setAttachedClip(first);
  timeline.getState().markIn(pts("1000"));
  timeline.getState().markOut(pts("2000"));
}

function contentOf(timeline: TimelineStore): ProjectContent {
  return projectContentOf(timeline.getState(), {});
}

/** Saves the session into `file`, as a save step does when its write succeeded. */
function save(h: ReturnType<typeof harness>, file: ProjectFile = FILE): boolean {
  return h.project.getState().completeSave({
    file,
    savedContent: contentOf(h.timeline),
    identity: h.project.getState().identity,
  });
}

describe("the project store", () => {
  it("starts with no file and the content of the empty sequence", () => {
    const project = createProjectStore({ sequenceHasClips: () => false });
    expect(project.getState()).toMatchObject({
      file: null,
      savedContent: EMPTY_PROJECT_CONTENT,
      identity: 0,
      located: false,
    });
    expect(projectStore.getState().file).toBeNull();
    expect(projectStore.getState().savedContent).toBe(EMPTY_PROJECT_CONTENT);
  });

  it("binds the file of a save, and the project is then not modified", () => {
    const h = harness();
    addClips(h.timeline);
    expect(save(h)).toBe(true);
    const state = h.project.getState();
    expect(state.file).toEqual(FILE);
    expect(state.savedContent).toBe(contentOf(h.timeline));
    expect(isProjectModified(state, contentOf(h.timeline))).toBe(false);
  });

  it("is modified after an edit, and not modified after an Undo back to the saved content", () => {
    const h = harness();
    addClips(h.timeline);
    save(h);
    h.timeline
      .getState()
      .renameSegment(h.timeline.getState().sequenceSegments[0].id, "A");
    expect(isProjectModified(h.project.getState(), contentOf(h.timeline))).toBe(true);
    h.timeline.getState().undo();
    expect(isProjectModified(h.project.getState(), contentOf(h.timeline))).toBe(false);
  });

  it("does not bind a late save whose identity is old", () => {
    const h = harness();
    addClips(h.timeline);
    // The save step notes the content and the identity at its start.
    const savedContent = contentOf(h.timeline);
    const identity = h.project.getState().identity;
    // While it writes, the sequence goes empty and gets a clip again.
    h.timeline.getState().clearTimeline();
    h.timeline.getState().undo();
    expect(h.project.getState().identity).not.toBe(identity);

    const bound = h.project
      .getState()
      .completeSave({ file: FILE, savedContent, identity });

    expect(bound).toBe(false);
    expect(h.project.getState().file).toBeNull();
    expect(h.project.getState().savedContent).toBe(EMPTY_PROJECT_CONTENT);
  });

  it("does not bind a late save after an open changed the session", () => {
    const h = harness();
    addClips(h.timeline);
    const identity = h.project.getState().identity;
    const savedContent = contentOf(h.timeline);
    h.project.getState().completeOpen({
      file: OTHER_FILE,
      savedContent: contentOf(h.timeline),
      located: false,
    });
    expect(
      h.project.getState().completeSave({ file: FILE, savedContent, identity }),
    ).toBe(false);
    expect(h.project.getState().file).toEqual(OTHER_FILE);
  });

  it("keeps the project modified when the sequence changed during the write", () => {
    const h = harness();
    addClips(h.timeline);
    const savedContent = contentOf(h.timeline);
    const identity = h.project.getState().identity;
    h.timeline
      .getState()
      .renameSegment(h.timeline.getState().sequenceSegments[0].id, "B");
    expect(
      h.project.getState().completeSave({ file: FILE, savedContent, identity }),
    ).toBe(true);
    expect(isProjectModified(h.project.getState(), contentOf(h.timeline))).toBe(true);
  });

  describe("closes when the sequence has no clip", () => {
    const empties: [string, (timeline: TimelineStore) => void][] = [
      ["Clear Timeline", (timeline) => timeline.getState().clearTimeline()],
      [
        "the removal of the last clip",
        (timeline) => {
          timeline.getState().removeClip(0);
          expect(timeline.getState().clips).toHaveLength(1);
          timeline.getState().removeClip(0);
        },
      ],
      [
        "an Undo",
        (timeline) => {
          // Undo of the segment, and then of the insert of the clips.
          timeline.getState().undo();
          timeline.getState().undo();
        },
      ],
      [
        "a load with no clip",
        (timeline) => timeline.getState().loadSequence([], [], []),
      ],
    ];

    for (const [name, empty] of empties) {
      it(`by ${name}`, () => {
        const h = harness();
        addClips(h.timeline);
        save(h);
        const identity = h.project.getState().identity;
        empty(h.timeline);
        expect(h.timeline.getState().clips).toEqual([]);
        const state = h.project.getState();
        expect(state.file).toBeNull();
        expect(state.savedContent).toBe(EMPTY_PROJECT_CONTENT);
        expect(state.located).toBe(false);
        expect(state.identity).toBe(identity + 1);
      });
    }

    it("by a Redo", () => {
      const h = harness();
      addClips(h.timeline);
      h.timeline.getState().clearTimeline();
      // The Undo of Clear Timeline brings the clips back with no file, so save them again.
      h.timeline.getState().undo();
      expect(save(h)).toBe(true);
      const identity = h.project.getState().identity;
      h.timeline.getState().redo();
      expect(h.timeline.getState().clips).toEqual([]);
      const state = h.project.getState();
      expect(state.file).toBeNull();
      expect(state.savedContent).toBe(EMPTY_PROJECT_CONTENT);
      expect(state.identity).toBe(identity + 1);
    });

    it("and a clip that comes back does not give the file back", () => {
      const h = harness();
      addClips(h.timeline);
      save(h);
      h.timeline.getState().clearTimeline();
      h.timeline.getState().undo();
      expect(h.timeline.getState().clips).toHaveLength(2);
      expect(h.project.getState().file).toBeNull();
      // The content now belongs to a project with no file, which has segments to save.
      expect(
        hasChangesToSave(
          h.project.getState(),
          contentOf(h.timeline),
          h.timeline.getState().segments.length,
        ),
      ).toBe(true);
    });

    it("changes the identity only when the sequence goes from clips to no clip", () => {
      const h = harness();
      const identity = h.project.getState().identity;
      // A change that leaves an empty sequence empty.
      h.timeline.getState().setBrowserDuration("a", 3);
      expect(h.project.getState().identity).toBe(identity);
      addClips(h.timeline);
      h.timeline
        .getState()
        .renameSegment(h.timeline.getState().sequenceSegments[0].id, "C");
      expect(h.project.getState().identity).toBe(identity);
      h.timeline.getState().clearTimeline();
      expect(h.project.getState().identity).toBe(identity + 1);
    });

    it("only while the rule is installed", () => {
      const h = harness();
      addClips(h.timeline);
      save(h);
      h.uninstall();
      h.timeline.getState().clearTimeline();
      expect(h.project.getState().file).toEqual(FILE);
    });
  });

  describe("completeOpen", () => {
    it("binds the file, the saved content and the located mark, and changes the identity", () => {
      const h = harness();
      addClips(h.timeline);
      const identity = h.project.getState().identity;
      const content = contentOf(h.timeline);
      h.project
        .getState()
        .completeOpen({ file: FILE, savedContent: content, located: true });
      const state = h.project.getState();
      expect(state.file).toEqual(FILE);
      expect(state.savedContent).toBe(content);
      expect(state.located).toBe(true);
      expect(state.identity).toBe(identity + 1);
      // The located mark makes the project modified until the next save.
      expect(isProjectModified(state, content)).toBe(true);
      expect(hasChangesToSave(state, content, 1)).toBe(true);
      expect(save(h)).toBe(true);
      expect(h.project.getState().located).toBe(false);
      expect(isProjectModified(h.project.getState(), content)).toBe(false);
    });

    it("gives no file for a document with no clip, and still changes the identity", () => {
      const h = harness();
      const identity = h.project.getState().identity;
      h.project.getState().completeOpen({
        file: FILE,
        savedContent: EMPTY_PROJECT_CONTENT,
        located: true,
      });
      const state = h.project.getState();
      expect(state.file).toBeNull();
      expect(state.located).toBe(false);
      expect(state.savedContent).toBe(EMPTY_PROJECT_CONTENT);
      expect(state.identity).toBe(identity + 1);
    });
  });
});

describe("the proposed path of the project", () => {
  const PROPOSED = "/old/stream.qcproj";

  /** Restores the session that `addClips` makes, as the restore does in its step 8. */
  function restore(h: ReturnType<typeof harness>): void {
    addClips(h.timeline);
    h.project.getState().completeRestore({ proposedPath: PROPOSED });
  }

  it("starts with no proposed path", () => {
    expect(
      createProjectStore({ sequenceHasClips: () => false }).getState().proposedPath,
    ).toBe(null);
  });

  it("gives a restored project no file, the empty content, a new identity and the proposed path", () => {
    const h = harness();
    addClips(h.timeline);
    save(h);
    const identity = h.project.getState().identity;
    h.project.getState().completeRestore({ proposedPath: PROPOSED });
    const state = h.project.getState();
    expect(state).toMatchObject({
      file: null,
      savedContent: EMPTY_PROJECT_CONTENT,
      located: false,
      proposedPath: PROPOSED,
      identity: identity + 1,
    });
    // A restored project with a segment has changes to save, as each project with no file.
    expect(hasChangesToSave(state, contentOf(h.timeline), 1)).toBe(true);
  });

  it("keeps no proposed path for a restore with no clip, or with no path", () => {
    const h = harness();
    h.project.getState().completeRestore({ proposedPath: PROPOSED });
    expect(h.project.getState().proposedPath).toBeNull();
    addClips(h.timeline);
    h.project.getState().completeRestore({ proposedPath: null });
    expect(h.project.getState().proposedPath).toBeNull();
  });

  it("is not content: it does not make the project modified", () => {
    const h = harness();
    addClips(h.timeline);
    const before = contentOf(h.timeline);
    h.project.getState().completeRestore({ proposedPath: PROPOSED });
    expect(contentOf(h.timeline)).toBe(before);
    const withPath = h.project.getState();
    const withoutPath = { ...withPath, proposedPath: null };
    expect(isProjectModified(withPath, before)).toBe(
      isProjectModified(withoutPath, before),
    );
  });

  it("goes when a save gives the project a file", () => {
    const h = harness();
    restore(h);
    expect(save(h)).toBe(true);
    expect(h.project.getState().proposedPath).toBeNull();
  });

  it("stays after a save that does not bind its file", () => {
    const h = harness();
    restore(h);
    const bound = h.project.getState().completeSave({
      file: FILE,
      savedContent: contentOf(h.timeline),
      identity: h.project.getState().identity - 1,
    });
    expect(bound).toBe(false);
    expect(h.project.getState().proposedPath).toBe(PROPOSED);
  });

  it("goes when an open changes the session", () => {
    const h = harness();
    restore(h);
    h.project.getState().completeOpen({
      file: OTHER_FILE,
      savedContent: contentOf(h.timeline),
      located: false,
    });
    expect(h.project.getState().proposedPath).toBeNull();
    restore(h);
    h.project.getState().completeOpen({
      file: null,
      savedContent: EMPTY_PROJECT_CONTENT,
      located: false,
    });
    expect(h.project.getState().proposedPath).toBeNull();
  });

  it("goes when the project closes, and an Undo does not give it back", () => {
    const h = harness();
    restore(h);
    const identity = h.project.getState().identity;
    h.timeline.getState().clearTimeline();
    expect(h.project.getState().proposedPath).toBeNull();
    expect(h.project.getState().identity).toBe(identity + 1);
    h.timeline.getState().undo();
    expect(h.timeline.getState().clips.length).toBeGreaterThan(0);
    expect(h.project.getState().proposedPath).toBeNull();
  });

  it("goes at a close with no change of the identity", () => {
    const h = harness();
    restore(h);
    const identity = h.project.getState().identity;
    h.project.getState().closeProject(false);
    expect(h.project.getState().proposedPath).toBeNull();
    expect(h.project.getState().identity).toBe(identity);
  });
});

describe("isProjectModified and hasChangesToSave", () => {
  const A = "content-a" as ProjectContent;
  const B = "content-b" as ProjectContent;

  it("compares the content by value, and counts the located mark", () => {
    expect(isProjectModified({ savedContent: A, located: false }, A)).toBe(false);
    expect(isProjectModified({ savedContent: A, located: false }, B)).toBe(true);
    expect(isProjectModified({ savedContent: A, located: true }, A)).toBe(true);
    // Equal values from two different strings.
    expect(
      isProjectModified(
        { savedContent: A, located: false },
        ["content", "a"].join("-") as ProjectContent,
      ),
    ).toBe(false);
  });

  it("with a file: modified; with no file: one or more segments", () => {
    const withFile = { file: FILE, savedContent: A, located: false };
    expect(hasChangesToSave(withFile, A, 5)).toBe(false);
    expect(hasChangesToSave(withFile, B, 0)).toBe(true);
    expect(hasChangesToSave({ ...withFile, located: true }, A, 0)).toBe(true);
    const noFile = { file: null, savedContent: EMPTY_PROJECT_CONTENT, located: false };
    expect(hasChangesToSave(noFile, B, 0)).toBe(false);
    expect(hasChangesToSave(noFile, B, 1)).toBe(true);
    expect(hasChangesToSave(noFile, EMPTY_PROJECT_CONTENT, 0)).toBe(false);
  });
});
