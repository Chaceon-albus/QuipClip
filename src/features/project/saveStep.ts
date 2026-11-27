/**
 * The save step of Save and Save As (ADR 072, "Save", steps 1 to 5).
 *
 * The step shows nothing itself. It answers with a typed result, and the caller shows the error
 * of a failed step. One step runs at a time: a request while a step runs does nothing and answers
 * `busy`. The quit, the open of a project and Clear Timeline wait for the step that runs
 * (`whenIdle`), and then they test the project.
 */

import {
  audioOverrideStore,
  type AudioOverrideStore,
} from "@/features/media/audioOverrideStore";
import { mediaStore, type MediaStore } from "@/features/media/store";
import type { SequenceLoadProblem } from "@/features/timeline/sequenceLoad";
import { timelineStore, type TimelineStore } from "@/features/timeline/store";
import type { Project } from "@/types/project";
import { saveProject as saveProjectCommand } from "./client";
import {
  buildProjectDocument,
  checkProjectDocument,
  projectContentOf,
} from "./document";
import {
  directoryOfPath,
  fileNameOfPath,
  hasProjectExtension,
  projectFileNameFor,
} from "./paths";
import { projectStore, type ProjectStore } from "./store";
import type { ProjectCommandError, SaveProjectResult } from "./types";
import { normalizeProjectCommandError } from "./validation";

/** `save` writes the file of the project, or asks for one; `saveAs` always asks. */
export type ProjectSaveMode = "save" | "saveAs";

/** Why a save step wrote nothing. */
export type ProjectSaveError =
  /** The sequence has no clip, so no document can be written (ADR 072, Consequences). */
  | { readonly kind: "noClip" }
  /** The save dialog of the system failed. */
  | { readonly kind: "dialogFailed"; readonly error: unknown }
  /** The chosen name does not end in `.qcproj`. */
  | { readonly kind: "invalidName"; readonly path: string }
  /** A clip names a source of which the media store has no import. */
  | { readonly kind: "missingSource"; readonly sourceId: string }
  /**
   * The document fails the test of an open (Save step 2). For `clipExtentUnknown`, `fileName` is
   * the name of the file of that clip; otherwise it is null.
   */
  | {
      readonly kind: "documentRefused";
      readonly problem: SequenceLoadProblem;
      readonly fileName: string | null;
    }
  /** `save_project` failed (Save step 5). */
  | { readonly kind: "writeFailed"; readonly error: ProjectCommandError };

/** The result of a save step. */
export type ProjectSaveResult =
  /**
   * The file is written. `bound` is false when the identity of the project changed during the
   * step: the file is written, and the project did not change (Save step 4).
   */
  | { readonly status: "saved"; readonly path: string; readonly bound: boolean }
  /** The user canceled the save dialog. */
  | { readonly status: "canceled" }
  /** Another save step runs, so this request did nothing. */
  | { readonly status: "busy" }
  | { readonly status: "failed"; readonly error: ProjectSaveError };

/** The dependencies of the save step. */
export interface ProjectSaveDependencies {
  /**
   * The save dialog of the system with the filter of project files. It proposes `defaultName` in
   * `defaultDirectory`, or in a directory of the system for null, and answers the chosen path, or
   * null when the user cancels.
   */
  readonly showSaveDialog: (
    defaultName: string,
    defaultDirectory: string | null,
  ) => Promise<string | null>;
  readonly saveProject?: (path: string, project: Project) => Promise<SaveProjectResult>;
  readonly timeline?: TimelineStore;
  readonly media?: MediaStore;
  readonly audioOverrides?: AudioOverrideStore;
  readonly project?: ProjectStore;
}

/** The save step of a page. */
export interface ProjectSaveStep {
  /**
   * Runs a save step. It runs with no test of the conditions of the Save action: the caller tests
   * them, and the save prompt runs the step with no such test.
   */
  readonly save: (mode: ProjectSaveMode) => Promise<ProjectSaveResult>;
  /** True while a step runs. */
  readonly isRunning: () => boolean;
  /** Resolves when no step runs: at once when none runs. It never rejects. */
  readonly whenIdle: () => Promise<void>;
}

const failed = (error: ProjectSaveError): ProjectSaveResult => ({
  status: "failed",
  error,
});

/** Creates a save step over the stores and the commands of `dependencies`. */
export function createProjectSaveStep(
  dependencies: ProjectSaveDependencies,
): ProjectSaveStep {
  const timeline = dependencies.timeline ?? timelineStore;
  const media = dependencies.media ?? mediaStore;
  const audioOverrides = dependencies.audioOverrides ?? audioOverrideStore;
  const project = dependencies.project ?? projectStore;
  const saveProject =
    dependencies.saveProject ??
    ((path, document) => saveProjectCommand(path, document));

  let running: Promise<ProjectSaveResult> | null = null;

  /**
   * The name and the directory that the save dialog proposes (ADR 072, Save As): those of the file
   * of the project, or else those of its proposed path (ADR 073, "The restore"), or else the name
   * and the directory of the file of the first clip.
   */
  const proposal = ():
    { name: string; directory: string | null } | ProjectSaveError => {
    const { file, proposedPath } = project.getState();
    if (file !== null) {
      return { name: file.name, directory: directoryOfPath(file.path) };
    }
    if (proposedPath !== null) {
      return {
        name: fileNameOfPath(proposedPath),
        directory: directoryOfPath(proposedPath),
      };
    }
    const first = timeline.getState().clips[0];
    if (first === undefined) {
      return { kind: "noClip" };
    }
    const imported = media.getState().sources[first.sourceId];
    if (imported === undefined) {
      return { kind: "missingSource", sourceId: first.sourceId };
    }
    return {
      name: projectFileNameFor(imported.fileName),
      directory: directoryOfPath(imported.path),
    };
  };

  /** Steps 1 to 5 for the path of the file to write. */
  const write = async (path: string): Promise<ProjectSaveResult> => {
    // Step 1: the identity and the content, read one time.
    const identity = project.getState().identity;
    const sequence = timeline.getState();
    const overrides = audioOverrides.getState().overrides;
    const savedContent = projectContentOf(sequence, overrides);
    if (sequence.clips.length === 0) {
      return failed({ kind: "noClip" });
    }
    const built = buildProjectDocument(sequence, media.getState().sources, overrides);
    if (!built.ok) {
      return failed({ kind: "missingSource", sourceId: built.missingSourceId });
    }
    // Step 2: the tests of an open.
    const check = checkProjectDocument(built.project);
    if (!check.ok) {
      const problem = check.problem;
      const source =
        problem.kind === "clipExtentUnknown"
          ? built.project.sources.find((entry) => entry.id === problem.sourceId)
          : undefined;
      return failed({
        kind: "documentRefused",
        problem,
        fileName: source === undefined ? null : fileNameOfPath(source.path),
      });
    }
    // Step 3: the write.
    let written: SaveProjectResult;
    try {
      written = await saveProject(path, built.project);
    } catch (error) {
      return failed({
        kind: "writeFailed",
        error: normalizeProjectCommandError(error),
      });
    }
    // Step 4: the project has the file only when its identity is still that of step 1.
    const bound = project.getState().completeSave({
      file: { path: written.path, name: fileNameOfPath(written.path) },
      savedContent,
      identity,
    });
    return { status: "saved", path: written.path, bound };
  };

  const run = async (mode: ProjectSaveMode): Promise<ProjectSaveResult> => {
    const file = project.getState().file;
    if (mode === "save" && file !== null) {
      return write(file.path);
    }
    const proposed = proposal();
    if ("kind" in proposed) {
      return failed(proposed);
    }
    let chosen: string | null;
    try {
      chosen = await dependencies.showSaveDialog(proposed.name, proposed.directory);
    } catch (error) {
      return failed({ kind: "dialogFailed", error });
    }
    if (chosen === null) {
      return { status: "canceled" };
    }
    if (!hasProjectExtension(chosen)) {
      return failed({ kind: "invalidName", path: chosen });
    }
    return write(chosen);
  };

  return {
    save: (mode) => {
      if (running !== null) {
        return Promise.resolve({ status: "busy" });
      }
      const step = run(mode).finally(() => {
        running = null;
      });
      running = step;
      return step;
    },
    isRunning: () => running !== null,
    whenIdle: async () => {
      while (running !== null) {
        await running.catch(() => undefined);
      }
    },
  };
}
