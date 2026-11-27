/**
 * The project of the session (ADR 072, "The project of the session").
 *
 * The session has one project. The project has a file or no file, a saved content, an identity,
 * and a mark that an open located a file at another path. At the start it has no file, and its
 * saved content is that of the empty sequence.
 *
 * - The project is modified when the content now is not equal to the saved content, or when the
 *   located mark is set (`isProjectModified`).
 * - The project has changes to save when it has a file and is modified, or when it has no file and
 *   the sequence has one or more segments (`hasChangesToSave`).
 * - The project has a file only while the sequence has one or more clips. Each change of the
 *   timeline store that leaves the sequence with no clip closes the project
 *   (`installProjectSequenceRule`).
 * - The identity changes each time the sequence goes from one or more clips to no clip, and each
 *   time an open or a restore changes the session. A step that waits for a file or a dialog notes
 *   the identity when it starts, and it changes the project afterward only when the identity is
 *   still the same.
 * - A project with no file can have a proposed path: the path of the project file of the work
 *   that a restore gave back (ADR 073, "The restore"). Save and Save As propose its name and its
 *   directory. It is not content, so it does not make the project modified. It goes when the
 *   project closes, when a save gives the project a file, and when an open or a restore changes
 *   the session.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import { EMPTY_PROJECT_CONTENT, type ProjectContent } from "./document";

/** The file of a project: its canonical path and the name that the title shows. */
export type ProjectFile = {
  readonly path: string;
  readonly name: string;
};

/** Public state of the project store. */
export type ProjectState = {
  /** The file of the project, or null for a project with no file. */
  readonly file: ProjectFile | null;
  /**
   * The content that the last save wrote, or that the last open read. The empty content for a
   * project with no file (`EMPTY_PROJECT_CONTENT`).
   */
  readonly savedContent: ProjectContent;
  /** A counter that changes each time the project closes and each time an open changes it. */
  readonly identity: number;
  /**
   * True from an open in which the user located a file at another path until the next save. The
   * project is modified while it is set.
   */
  readonly located: boolean;
  /**
   * The proposed path of a project with no file, or null (ADR 073, "The restore"). Only a restore
   * sets it. It is null while the project has a file, and while the sequence has no clip.
   */
  readonly proposedPath: string | null;
};

/** What a save step reports when its write succeeded (ADR 072, Save step 4). */
export type ProjectSaveCompletion = {
  /** The file that the backend wrote, with its canonical path. */
  readonly file: ProjectFile;
  /** The content that the step read in its step 1. */
  readonly savedContent: ProjectContent;
  /** The identity that the step read in its step 1. */
  readonly identity: number;
};

/** What the open step reports in its step 8 (ADR 072, "What the open changes"). */
export type ProjectOpenCompletion = {
  /** The file of the document, or null for a document with no clip. */
  readonly file: ProjectFile | null;
  /** The content of the session after the open. */
  readonly savedContent: ProjectContent;
  /** True when the user located a file at another path than the `path` of its entry. */
  readonly located: boolean;
};

/** What the restore reports in its step 8 (ADR 073, "The restore"). */
export type ProjectRestoreCompletion = {
  /** The `projectPath` of the offer: the proposed path of the project, or null. */
  readonly proposedPath: string | null;
};

/** Actions of the project store. */
export type ProjectActions = {
  /**
   * Binds the file of a save whose write succeeded (ADR 072, Save step 4). When `identity` is
   * still the identity of the project and the sequence has a clip, the project gets `file` and
   * `savedContent`, the located mark and the proposed path go, and the call returns true.
   * Otherwise the project does
   * not change, and the call returns false: the sequence was empty in the meantime, or an open
   * changed the session.
   */
  completeSave: (completion: ProjectSaveCompletion) => boolean;
  /**
   * Sets the project after the open step changed the session (ADR 072, open step 8). The open step
   * calls it after `loadSequence` of the timeline store. The identity changes, and the proposed
   * path goes. While the sequence has no clip, the project gets no file, the empty content and no
   * located mark, whatever the completion holds.
   */
  completeOpen: (completion: ProjectOpenCompletion) => void;
  /**
   * Sets the project after a restore changed the session (ADR 073, "The restore", step 8). The
   * restore calls it after `loadSequence` of the timeline store. The project gets no file, the
   * empty content, no located mark and a new identity. It keeps the proposed path of the
   * completion while the sequence has a clip, and no proposed path otherwise.
   */
  completeRestore: (completion: ProjectRestoreCompletion) => void;
  /**
   * Closes the project: no file, the empty content, no located mark and no proposed path. With
   * `changeIdentity`, the identity changes too. `installProjectSequenceRule` calls it.
   */
  closeProject: (changeIdentity: boolean) => void;
};

/** Combined type of the project state and actions. */
export type ProjectStoreState = ProjectState & ProjectActions;

/** The dependencies of the project store. */
export interface ProjectStoreDependencies {
  /** True while the sequence has one or more clips. Defaults to the production timeline store. */
  sequenceHasClips?: () => boolean;
}

/** Factory function creating a vanilla Zustand store instance for the project of the session. */
export function createProjectStore(
  dependencies: ProjectStoreDependencies = {},
): StoreApi<ProjectStoreState> {
  const sequenceHasClips =
    dependencies.sequenceHasClips ?? (() => timelineStore.getState().clips.length > 0);
  return createStore<ProjectStoreState>()((set, get) => ({
    file: null,
    savedContent: EMPTY_PROJECT_CONTENT,
    identity: 0,
    located: false,
    proposedPath: null,

    completeSave: (completion) => {
      if (completion.identity !== get().identity || !sequenceHasClips()) {
        return false;
      }
      set({
        file: { path: completion.file.path, name: completion.file.name },
        savedContent: completion.savedContent,
        located: false,
        proposedPath: null,
      });
      return true;
    },

    completeOpen: (completion) => {
      const identity = get().identity + 1;
      if (completion.file === null || !sequenceHasClips()) {
        set({
          file: null,
          savedContent: EMPTY_PROJECT_CONTENT,
          located: false,
          proposedPath: null,
          identity,
        });
        return;
      }
      set({
        file: { path: completion.file.path, name: completion.file.name },
        savedContent: completion.savedContent,
        located: completion.located,
        proposedPath: null,
        identity,
      });
    },

    completeRestore: (completion) => {
      set({
        file: null,
        savedContent: EMPTY_PROJECT_CONTENT,
        located: false,
        // A restore whose document has no clip leaves an empty sequence, which keeps no path.
        proposedPath: sequenceHasClips() ? completion.proposedPath : null,
        identity: get().identity + 1,
      });
    },

    closeProject: (changeIdentity) => {
      const state = get();
      const closed =
        state.file === null &&
        state.savedContent === EMPTY_PROJECT_CONTENT &&
        !state.located &&
        state.proposedPath === null;
      if (closed && !changeIdentity) {
        return;
      }
      set({
        file: null,
        savedContent: EMPTY_PROJECT_CONTENT,
        located: false,
        proposedPath: null,
        identity: changeIdentity ? state.identity + 1 : state.identity,
      });
    },
  }));
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

/**
 * Installs the rule "the project has a file only while the sequence has one or more clips" on a
 * pair of stores (ADR 072). Each change of `timeline` that leaves the sequence with no clip closes
 * the project. The identity changes when the change took the sequence from one or more clips to
 * no clip: Clear Timeline, the removal of the last clip, an Undo, a Redo, or a load.
 *
 * @returns The function that removes the rule.
 */
export function installProjectSequenceRule(
  project: ProjectStore,
  timeline: TimelineStore,
): () => void {
  return timeline.subscribe((state, previous) => {
    if (state.clips.length === 0) {
      project.getState().closeProject(previous.clips.length > 0);
    }
  });
}

/**
 * True when the project is modified (ADR 072): `content`, the content of the session now
 * (`projectContentOf`), is not equal to the saved content, or the located mark is set.
 */
export function isProjectModified(
  project: Pick<ProjectState, "savedContent" | "located">,
  content: ProjectContent,
): boolean {
  return project.located || content !== project.savedContent;
}

/**
 * True when the project has changes to save (ADR 072): it has a file and is modified, or it has no
 * file and the sequence has one or more segments, the test of ADR 027.
 *
 * @param content The content of the session now (`projectContentOf`).
 * @param segmentCount The number of the segments on the sequence.
 */
export function hasChangesToSave(
  project: Pick<ProjectState, "file" | "savedContent" | "located">,
  content: ProjectContent,
  segmentCount: number,
): boolean {
  return project.file === null ? segmentCount > 0 : isProjectModified(project, content);
}

/** The project of this page. */
export const projectStore: ProjectStore = createProjectStore();

installProjectSequenceRule(projectStore, timelineStore);

const defaultSelector = (state: ProjectStoreState): ProjectStoreState => state;

/** React hook for consuming the production project store. */
export function useProjectStore(): ProjectStoreState;
export function useProjectStore<T>(selector: (state: ProjectStoreState) => T): T;
export function useProjectStore<T>(
  selector?: (state: ProjectStoreState) => T,
): T | ProjectStoreState {
  return useStore(
    projectStore,
    (selector ?? defaultSelector) as (state: ProjectStoreState) => T,
  );
}
