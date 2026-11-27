/**
 * The name of the project in the title (ADR 072, "The name in the title").
 *
 * When the project has a file, the title bar shows the name of that file, and the title of the
 * window for the system names it too. A modified project has a dot in front of the name. For a
 * project with no file, both titles are as before.
 *
 * The test "modified" compares the content of the session with the saved content. The content is
 * a string that `projectContentOf` builds from the clips, the segments and the audio overrides,
 * so a reader keeps its last result while none of those inputs and no fact of the project
 * changed. The timeline store changes for many other reasons, such as the selection, and those
 * changes build no string.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  audioOverrideStore,
  type AudioOverrideStore,
} from "@/features/media/audioOverrideStore";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import {
  projectContentOf,
  type ProjectAudioOverrides,
  type ProjectContent,
  type ProjectTimeline,
} from "./document";
import {
  isProjectModified,
  projectStore,
  type ProjectState,
  type ProjectStore,
} from "./store";

/** The title state of a project with a file. */
export interface ProjectTitle {
  /** The name of the file of the project. */
  readonly fileName: string;
  /** True when the project is modified, so the title shows a dot in front of the name. */
  readonly modified: boolean;
}

/** The facts of the project that the title reads. */
export type ProjectTitleProject = Pick<
  ProjectState,
  "file" | "savedContent" | "located"
>;

/**
 * The title state of the project: null for a project with no file, else the name of its file
 * and whether it is modified.
 *
 * @param content The content of the session now (`projectContentOf`).
 */
export function projectTitleOf(
  project: ProjectTitleProject,
  content: ProjectContent,
): ProjectTitle | null {
  if (project.file === null) {
    return null;
  }
  return {
    fileName: project.file.name,
    modified: isProjectModified(project, content),
  };
}

/** Reads the title state from the facts of the project and the inputs of the content. */
export type ProjectTitleReader = (
  project: ProjectTitleProject,
  timeline: ProjectTimeline,
  overrides: ProjectAudioOverrides,
) => ProjectTitle | null;

function sameTitle(a: ProjectTitle | null, b: ProjectTitle | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.fileName === b.fileName && a.modified === b.modified)
  );
}

/**
 * Creates a reader of the title state that keeps its last result.
 *
 * The reader returns its last result, with no new content string, while each input compares
 * equal by reference to the last call: the file, the saved content and the located mark of the
 * project, and the clips, the segments, the sources of the sequence and the audio overrides that
 * `projectContentOf` reads. A project with no file builds no content. A result equal by value to
 * the last result is the last result, so a subscriber of React renders again only when the title
 * changes.
 *
 * @param contentOf The builder of the content. A test passes a counter.
 */
export function createProjectTitleReader(
  contentOf: typeof projectContentOf = projectContentOf,
): ProjectTitleReader {
  let last: {
    readonly file: ProjectTitleProject["file"];
    readonly savedContent: ProjectContent;
    readonly located: boolean;
    readonly clips: ProjectTimeline["clips"];
    readonly segments: ProjectTimeline["sequenceSegments"];
    readonly sources: ProjectTimeline["sequenceSources"];
    readonly overrides: ProjectAudioOverrides;
    readonly result: ProjectTitle | null;
  } | null = null;

  return (project, timeline, overrides) => {
    if (
      last !== null &&
      last.file === project.file &&
      last.savedContent === project.savedContent &&
      last.located === project.located &&
      last.clips === timeline.clips &&
      last.segments === timeline.sequenceSegments &&
      last.sources === timeline.sequenceSources &&
      last.overrides === overrides
    ) {
      return last.result;
    }
    const next =
      project.file === null
        ? null
        : projectTitleOf(project, contentOf(timeline, overrides));
    const result = last !== null && sameTitle(last.result, next) ? last.result : next;
    last = {
      file: project.file,
      savedContent: project.savedContent,
      located: project.located,
      clips: timeline.clips,
      segments: timeline.sequenceSegments,
      sources: timeline.sequenceSources,
      overrides,
      result,
    };
    return result;
  };
}

/** The stores that the title follows. Each one defaults to the production store. */
export interface ProjectTitleStores {
  readonly project?: ProjectStore;
  readonly timeline?: TimelineStore;
  readonly audioOverrides?: AudioOverrideStore;
}

/** The title state of a set of stores, with one subscription to all of them. */
export interface ProjectTitleSource {
  /** The title state now. It keeps its last result while its inputs did not change. */
  readonly read: () => ProjectTitle | null;
  /** Calls `listener` after each change of one of the stores. Returns the release function. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Creates the title source of the project store, the timeline store and the audio overrides. */
export function createProjectTitleSource(
  stores: ProjectTitleStores = {},
): ProjectTitleSource {
  const project = stores.project ?? projectStore;
  const timeline = stores.timeline ?? timelineStore;
  const audioOverrides = stores.audioOverrides ?? audioOverrideStore;
  const reader = createProjectTitleReader();
  return {
    read: () =>
      reader(
        project.getState(),
        timeline.getState(),
        audioOverrides.getState().overrides,
      ),
    subscribe: (listener) => {
      const releases = [
        project.subscribe(listener),
        timeline.subscribe(listener),
        audioOverrides.subscribe(listener),
      ];
      return () => {
        for (const release of releases) {
          release();
        }
      };
    },
  };
}

/** React hook for the title state of the production project. */
export function useProjectTitle(): ProjectTitle | null {
  const [source] = useState(() => createProjectTitleSource());
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener),
    [source],
  );
  return useSyncExternalStore(subscribe, source.read);
}
