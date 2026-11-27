import { describe, expect, it, vi } from "vitest";
import { createAudioOverrideStore } from "@/features/media/audioOverrideStore";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { Pts, TickCount } from "@/types/project";
import { EMPTY_PROJECT_CONTENT, projectContentOf } from "./document";
import {
  createProjectTitleReader,
  createProjectTitleSource,
  projectTitleOf,
} from "./projectTitle";
import { createProjectStore, installProjectSequenceRule } from "./store";

const pts = (value: string) => value as Pts;

const SOURCE: SequenceSource = {
  id: "a",
  videoTimeBase: { n: 1, d: 1000 },
  videoStartPts: pts("0"),
  videoEndPts: pts("10000"),
  videoDurationTicks: "10000" as TickCount,
  approximateDurationSeconds: 10,
};

const FILE = { path: "/p/cut.qcproj", name: "cut.qcproj" };

/** A session with one clip and one segment, saved to `cut.qcproj`. */
function harness() {
  let next = 0;
  const timeline = createTimelineStore({ generateId: () => `g-${++next}` });
  const audioOverrides = createAudioOverrideStore();
  const project = createProjectStore({
    sequenceHasClips: () => timeline.getState().clips.length > 0,
  });
  installProjectSequenceRule(project, timeline);
  timeline.getState().loadSequence(
    [{ id: "c1", sourceId: "a" }],
    [SOURCE],
    [
      {
        id: "s1",
        inClipId: "c1",
        inPts: pts("1000"),
        outClipId: "c1",
        outPts: pts("2000"),
      },
    ],
  );
  const save = () => {
    project.getState().completeSave({
      file: FILE,
      savedContent: projectContentOf(
        timeline.getState(),
        audioOverrides.getState().overrides,
      ),
      identity: project.getState().identity,
    });
  };
  return { timeline, audioOverrides, project, save };
}

describe("projectTitleOf", () => {
  it("is null for a project with no file", () => {
    expect(
      projectTitleOf(
        { file: null, savedContent: EMPTY_PROJECT_CONTENT, located: false },
        EMPTY_PROJECT_CONTENT,
      ),
    ).toBeNull();
  });

  it("names the file, and marks a content that is not the saved content", () => {
    const h = harness();
    const content = projectContentOf(h.timeline.getState(), {});
    expect(
      projectTitleOf({ file: FILE, savedContent: content, located: false }, content),
    ).toEqual({ fileName: "cut.qcproj", modified: false });
    expect(
      projectTitleOf(
        { file: FILE, savedContent: EMPTY_PROJECT_CONTENT, located: false },
        content,
      ),
    ).toEqual({ fileName: "cut.qcproj", modified: true });
    // A file located at another path makes the project modified until the next save.
    expect(
      projectTitleOf({ file: FILE, savedContent: content, located: true }, content),
    ).toEqual({ fileName: "cut.qcproj", modified: true });
  });
});

describe("createProjectTitleReader", () => {
  it("builds no content while the inputs of the content and the project did not change", () => {
    const h = harness();
    h.save();
    const contentOf = vi.fn(projectContentOf);
    const read = createProjectTitleReader(contentOf);
    const readNow = () =>
      read(
        h.project.getState(),
        h.timeline.getState(),
        h.audioOverrides.getState().overrides,
      );

    const first = readNow();
    expect(first).toEqual({ fileName: "cut.qcproj", modified: false });
    expect(contentOf).toHaveBeenCalledTimes(1);

    // A change of the selection is a change of the timeline store, not of the content.
    h.timeline.getState().selectSegment("s1");
    expect(readNow()).toBe(first);
    expect(contentOf).toHaveBeenCalledTimes(1);
  });

  it("follows an edit, an Undo and an audio override, and keeps an equal result", () => {
    const h = harness();
    h.save();
    const contentOf = vi.fn(projectContentOf);
    const read = createProjectTitleReader(contentOf);
    const readNow = () =>
      read(
        h.project.getState(),
        h.timeline.getState(),
        h.audioOverrides.getState().overrides,
      );
    const saved = readNow();

    h.timeline.getState().renameSegment("s1", "Intro");
    const modified = readNow();
    expect(modified).toEqual({ fileName: "cut.qcproj", modified: true });

    // Undo goes back to the saved content: the result is the first result again by value.
    h.timeline.getState().undo();
    expect(readNow()).toEqual(saved);

    h.audioOverrides.getState().replaceOverrides({
      a: { index: 2, codec: "aac", sampleRate: 48_000, channels: 2 },
    });
    const overridden = readNow();
    expect(overridden).toEqual({ fileName: "cut.qcproj", modified: true });

    // A new content with the same title gives the same object, so React renders nothing.
    h.timeline.getState().renameSegment("s1", "Other");
    expect(readNow()).toBe(overridden);
    expect(contentOf).toHaveBeenCalledTimes(5);
  });

  it("builds no content for a project with no file", () => {
    const h = harness();
    const contentOf = vi.fn(projectContentOf);
    const read = createProjectTitleReader(contentOf);
    expect(
      read(
        h.project.getState(),
        h.timeline.getState(),
        h.audioOverrides.getState().overrides,
      ),
    ).toBeNull();
    expect(contentOf).not.toHaveBeenCalled();
  });
});

describe("createProjectTitleSource", () => {
  it("calls the listener for each of the three stores, until the release", () => {
    const h = harness();
    const source = createProjectTitleSource({
      project: h.project,
      timeline: h.timeline,
      audioOverrides: h.audioOverrides,
    });
    const listener = vi.fn();
    const release = source.subscribe(listener);
    expect(source.read()).toBeNull();

    h.save();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.read()).toEqual({ fileName: "cut.qcproj", modified: false });

    h.timeline.getState().renameSegment("s1", "Intro");
    expect(listener).toHaveBeenCalledTimes(2);
    h.audioOverrides.getState().replaceOverrides({
      a: { index: 2, codec: "aac", sampleRate: 48_000, channels: 2 },
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(source.read()).toEqual({ fileName: "cut.qcproj", modified: true });

    // Clear Timeline closes the project, and the title names no file again.
    h.timeline.getState().clearTimeline();
    expect(source.read()).toBeNull();

    release();
    const calls = listener.mock.calls.length;
    h.timeline.getState().undo();
    expect(listener).toHaveBeenCalledTimes(calls);
  });
});
