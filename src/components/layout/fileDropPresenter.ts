/**
 * Pure rules for the files that the user drops on the window (ADR 052, ADR 072).
 *
 * A drop is one request of the Open action (ADR 072, "One Open action"): videos join the
 * sequence, one project file alone opens that project, and a project file with other videos or
 * project files opens nothing.
 *
 * The Tauri web view takes native file drops (`dragDropEnabled`), so the page receives no
 * HTML5 drop event. The hook `useFileDropOpen` forwards each Tauri drag-drop event to
 * `resolveFileDropEvent`, which decides what the overlay shows and which file to open. The
 * rules need no document, no store and no Tauri runtime, so a test can run them in node.
 */

import { hasVideoFileExtension } from "@/features/media";
import { classifyOpenPaths } from "@/features/project/openPaths";

/** What a set of dropped paths would do if the user released them now. */
export type DroppedPathsClassification =
  | {
      readonly kind: "open";
      /** Every dropped path with a supported video extension, in the order of the drop. */
      readonly paths: readonly string[];
      /** True when the drag also carries paths that are not videos, so those are not added. */
      readonly extraIgnored: boolean;
    }
  | {
      /** One project file and no video: the drop opens that project (ADR 072). */
      readonly kind: "project";
      readonly path: string;
      /** True when the drag also carries files that are no video and no project file. */
      readonly extraIgnored: boolean;
    }
  /**
   * A project file with a video or with another project file: a project file opens alone, so
   * the drop does nothing (ADR 072).
   */
  | { readonly kind: "projectNotAlone" }
  | { readonly kind: "unsupported" };

/**
 * One drag-drop event, reduced to the fields the rules read. The Tauri payload has the
 * same `type` and `paths` fields and also a position, which the rules do not use.
 */
export type FileDropEvent =
  | { readonly type: "enter"; readonly paths: readonly string[] }
  | { readonly type: "over" }
  | { readonly type: "drop"; readonly paths: readonly string[] }
  | { readonly type: "leave" };

/** The result of one drag-drop event. */
export interface FileDropStep {
  /** The classification of the drag in progress, kept for the next `over` event. */
  readonly dragged: DroppedPathsClassification | null;
  /** What the overlay shows, or null when it is hidden. */
  readonly overlay: DroppedPathsClassification | null;
  /**
   * The files to give to `requestOpen` as one request, or null. Only a `drop` event sets it. A
   * mixed set of a project file and other files goes too, so the request reports that a project
   * file opens alone.
   */
  readonly openPaths: readonly string[] | null;
  /**
   * True when the drag or the drop adds videos, so the place of the pointer names a junction of
   * the sequence (ADR 052). A project file does not use the place of the pointer (ADR 072): no
   * junction mark shows for it, and the request has no index.
   */
  readonly atPointer: boolean;
}

/**
 * Chooses what a drop opens (ADR 052, ADR 072).
 *
 * With a project file, the rules of the Open action apply (`classifyOpenPaths`): one project file
 * and no video is `project`, and each other set with a project file is `projectNotAlone`.
 * Otherwise the result is `open` with every path that has a supported video extension, in the
 * order of the drop. The result is `unsupported` when no path has a supported extension, which
 * includes a drag with no file paths at all. An empty or blank path is never a candidate.
 *
 * @param paths The dropped paths, in the order the operating system reports them.
 */
export function classifyDroppedPaths(
  paths: readonly string[],
): DroppedPathsClassification {
  const request = classifyOpenPaths(paths);
  if (request.kind === "project") {
    return { kind: "project", path: request.path, extraIgnored: request.othersIgnored };
  }
  if (request.kind === "projectNotAlone") {
    return { kind: "projectNotAlone" };
  }
  const videos = paths.filter(
    (candidate) => candidate.trim().length > 0 && hasVideoFileExtension(candidate),
  );
  if (videos.length === 0) {
    return { kind: "unsupported" };
  }
  return { kind: "open", paths: videos, extraIgnored: videos.length < paths.length };
}

/**
 * Resolves one drag-drop event.
 *
 * - `enter` classifies the dragged paths and shows the result.
 * - `over` shows the classification of the last `enter` again. The event carries no paths.
 *   It returns the same object, so a React state setter that receives it does not render.
 * - `leave` hides the overlay.
 * - `drop` hides the overlay and opens the chosen files: the videos, or the one project file.
 *   It classifies the paths of the drop itself, because those are the paths the user released.
 *   A project file with other files goes to the request with no index, which opens nothing and
 *   shows the message that a project file opens alone.
 *
 * While `blocked` is true, the event shows nothing and opens nothing. The caller sets it
 * while a modal layer is open and while an import is already loading.
 *
 * @param event The drag-drop event.
 * @param dragged The `dragged` field of the previous step, or null before the first one.
 * @param blocked True when a drop must not open a file now.
 */
export function resolveFileDropEvent(
  event: FileDropEvent,
  dragged: DroppedPathsClassification | null,
  blocked: boolean,
): FileDropStep {
  switch (event.type) {
    case "enter": {
      const classification = classifyDroppedPaths(event.paths);
      const overlay = blocked ? null : classification;
      return {
        dragged: classification,
        overlay,
        openPaths: null,
        atPointer: overlay?.kind === "open",
      };
    }
    case "over": {
      const overlay = blocked ? null : dragged;
      return { dragged, overlay, openPaths: null, atPointer: overlay?.kind === "open" };
    }
    case "leave":
      return { dragged: null, overlay: null, openPaths: null, atPointer: false };
    case "drop": {
      const classification = classifyDroppedPaths(event.paths);
      if (blocked) {
        return { dragged: null, overlay: null, openPaths: null, atPointer: false };
      }
      switch (classification.kind) {
        case "open":
          return {
            dragged: null,
            overlay: null,
            openPaths: classification.paths,
            atPointer: true,
          };
        case "project":
          return {
            dragged: null,
            overlay: null,
            openPaths: [classification.path],
            atPointer: false,
          };
        case "projectNotAlone":
          // The request opens nothing, and `requestOpen` shows the same message as for the
          // files of the file dialog.
          return {
            dragged: null,
            overlay: null,
            openPaths: event.paths.filter((path) => path.trim().length > 0),
            atPointer: false,
          };
        default:
          return { dragged: null, overlay: null, openPaths: null, atPointer: false };
      }
    }
  }
}

/** One catalog message, with its named values. */
export interface DropOverlayMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, number>>;
}

/** What the drop overlay shows for one classification. */
export interface DropOverlayView {
  /** The main line. */
  readonly message: DropOverlayMessage;
  /** The second line, or null. */
  readonly note: DropOverlayMessage | null;
  /** True when a drop opens something now, so the overlay takes the accent colour. */
  readonly accepted: boolean;
  /** The icon: a video file, or a project file. */
  readonly icon: "video" | "project";
}

/**
 * The text of the drop overlay (ADR 052, ADR 072). Each line is one complete catalog message
 * (ADR 011). A drop of a project file says that it opens the project. A project file with other
 * files says that a project file opens alone, in the colour of a drop that opens nothing.
 */
export function presentDropOverlay(state: DroppedPathsClassification): DropOverlayView {
  switch (state.kind) {
    case "open":
      return {
        message: { key: "fileDrop.release", values: { count: state.paths.length } },
        note: state.extraIgnored ? { key: "fileDrop.othersIgnored" } : null,
        accepted: true,
        icon: "video",
      };
    case "project":
      return {
        message: { key: "fileDrop.openProject" },
        note: state.extraIgnored ? { key: "fileDrop.projectOthersIgnored" } : null,
        accepted: true,
        icon: "project",
      };
    case "projectNotAlone":
      return {
        message: { key: "fileDrop.projectNotAlone" },
        note: null,
        accepted: false,
        icon: "project",
      };
    case "unsupported":
      return {
        message: { key: "fileDrop.unsupported" },
        note: null,
        accepted: false,
        icon: "video",
      };
  }
}
