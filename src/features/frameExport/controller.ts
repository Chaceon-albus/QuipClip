/**
 * The Export Frame action after its plan accepted it (ADR 069): the save dialog, the command,
 * and the notice of the result.
 *
 * The plan records the facts of the action at the moment it accepts it (`FrameExportFacts`). The
 * controller holds the action in progress from that moment until the user cancels the save
 * dialog or the command ends. While it is in progress, `busy` is true, and a second `start` does
 * nothing.
 *
 * The notice belongs to the action, not to a clip, so a change of the clip does not remove it.
 * It stays until the user dismisses it, or until the plan accepts the action again: `start`
 * removes it at once (ADR 069). A notice of a success also leaves by itself after 5 seconds.
 *
 * The module has no React, DOM or Tauri dependency: the effects are injected, so the tests need
 * no document.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import { splitFileName, splitFilePath } from "@/lib/fileName";
import type { Pts } from "@/types/project";
import type { FrameExportResult } from "./client";
import type {
  FrameExportErrorCode,
  FrameExportRequest,
  FrameExportSourceRevision,
} from "./types";

/** The facts that the plan records when it accepts the action (ADR 069). */
export interface FrameExportFacts {
  /** The path of the source of the attached clip. */
  readonly sourcePath: string;
  /** The file name of that source, for the offered name of the image. */
  readonly sourceFileName: string;
  /** The revision of that source that the import read. */
  readonly sourceRevision: FrameExportSourceRevision;
  /** The inferred PTS of the confirmed frame, in the time base of the source. */
  readonly pts: Pts;
  /** The time that the preview showed, for the offered name of the image. */
  readonly displayedTime: string;
  /** The paths of every source of the session. */
  readonly sessionSourcePaths: readonly string[];
}

/** The notice of the result of one action. `id` lets a dismiss name the notice it saw. */
export type FrameExportNotice =
  | { readonly id: number; readonly kind: "saved"; readonly fileName: string }
  | {
      readonly id: number;
      readonly kind: "failed";
      readonly code: FrameExportErrorCode;
      readonly detail: string | null;
    };

export interface FrameExportState {
  /** True while an action is in progress: from its plan to the end of its command. */
  readonly busy: boolean;
  /** The notice of the last action that ended with a result, or null. */
  readonly notice: FrameExportNotice | null;
}

/** The effects of the controller. Production passes the save dialog and the client. */
export interface FrameExportEffects {
  /**
   * Opens the save dialog of the system with the filter PNG and `defaultName`, and answers with
   * the chosen path, or null when the user cancels. A rejection means that the dialog failed.
   */
  readonly chooseOutputPath: (defaultName: string) => Promise<string | null>;
  /** Sends the request to `export_frame`. It never rejects. */
  readonly exportFrame: (request: FrameExportRequest) => Promise<FrameExportResult>;
}

export interface FrameExportController {
  readonly store: StoreApi<FrameExportState>;
  /**
   * Runs one action with the recorded facts. Resolves when the action ends. A call while an
   * action is in progress does nothing.
   */
  readonly start: (facts: FrameExportFacts) => Promise<void>;
  /** Removes the notice `id`, when it is still the notice. */
  readonly dismissNotice: (id: number) => void;
}

/**
 * The name that the save dialog offers (ADR 069): the name of the source file without its
 * extension, an underscore, and the recorded time with each `:` and each `.` replaced by `-`, and
 * the extension `png`. So `clip.mp4` at `00:01:23.456` gives `clip_00-01-23-456.png`.
 */
export function frameFileName(sourceFileName: string, displayedTime: string): string {
  const { stem } = splitFileName(sourceFileName);
  return `${stem}_${displayedTime.replace(/[:.]/g, "-")}.png`;
}

/** The file name of `path`, for the notice, or the path itself when it has no file name. */
function fileNameOf(path: string): string {
  return splitFilePath(path)?.name ?? path;
}

/** Creates a controller with its own store. */
export function createFrameExportController(
  effects: FrameExportEffects,
): FrameExportController {
  const store = createStore<FrameExportState>()(() => ({ busy: false, notice: null }));
  let nextNoticeId = 0;

  const publish = (notice: FrameExportNotice | null): void => {
    store.setState({ busy: false, notice });
  };

  const start = async (facts: FrameExportFacts): Promise<void> => {
    if (store.getState().busy) {
      return;
    }
    // In progress from this moment, before the first await, so a second key press, click or menu
    // item that arrives while the dialog opens finds the action busy. The plan accepted the
    // action, so the notice of the action before goes now (ADR 069). A start that finds the
    // action busy returned above and keeps the notice.
    store.setState({ busy: true, notice: null });
    let outputPath: string | null;
    try {
      outputPath = await effects.chooseOutputPath(
        frameFileName(facts.sourceFileName, facts.displayedTime),
      );
    } catch {
      nextNoticeId += 1;
      publish({ id: nextNoticeId, kind: "failed", code: "dialogFailed", detail: null });
      return;
    }
    if (outputPath === null) {
      // A cancel ends the action. The notice of the action before went when it started.
      store.setState({ busy: false });
      return;
    }
    let result: FrameExportResult;
    try {
      result = await effects.exportFrame({
        sourcePath: facts.sourcePath,
        sourceRevision: facts.sourceRevision,
        pts: facts.pts,
        sessionSourcePaths: facts.sessionSourcePaths,
        outputPath,
      });
    } catch {
      // The client does not reject. A fault there must still end the action, or the action
      // would stay busy for the rest of the session.
      result = { kind: "failed", failure: { code: "unknown", detail: null } };
    }
    nextNoticeId += 1;
    publish(
      result.kind === "done"
        ? { id: nextNoticeId, kind: "saved", fileName: fileNameOf(result.outputPath) }
        : {
            id: nextNoticeId,
            kind: "failed",
            code: result.failure.code,
            detail: result.failure.detail,
          },
    );
  };

  const dismissNotice = (id: number): void => {
    const { notice } = store.getState();
    if (notice !== null && notice.id === id) {
      store.setState({ notice: null });
    }
  };

  return { store, start, dismissNotice };
}
