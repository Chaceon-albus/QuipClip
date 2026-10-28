/**
 * Pure rules for adding the videos that the user drops on the window (ADR 052).
 *
 * The Tauri web view takes native file drops (`dragDropEnabled`), so the page receives no
 * HTML5 drop event. The hook `useFileDropOpen` forwards each Tauri drag-drop event to
 * `resolveFileDropEvent`, which decides what the overlay shows and which file to open. The
 * rules need no document, no store and no Tauri runtime, so a test can run them in node.
 */

import { hasVideoFileExtension } from "@/features/media";

/** What a set of dropped paths would do if the user released them now. */
export type DroppedPathsClassification =
  | {
      readonly kind: "open";
      /** Every dropped path with a supported video extension, in the order of the drop. */
      readonly paths: readonly string[];
      /** True when the drag also carries paths that are not videos, so those are not added. */
      readonly extraIgnored: boolean;
    }
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
  /** The files to add, or null. Only a `drop` event sets it. */
  readonly openPaths: readonly string[] | null;
}

/**
 * Chooses the files that a drop adds as clips (ADR 052).
 *
 * The result is `open` with every path that has a supported video extension, in the order of
 * the drop. The result is `unsupported` when no path has a supported extension, which includes a
 * drag with no file paths at all. An empty or blank path is never a candidate.
 *
 * @param paths The dropped paths, in the order the operating system reports them.
 */
export function classifyDroppedPaths(
  paths: readonly string[],
): DroppedPathsClassification {
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
 * - `drop` hides the overlay and adds the chosen files. It classifies the paths of the drop
 *   itself, because those are the paths the user released.
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
      return {
        dragged: classification,
        overlay: blocked ? null : classification,
        openPaths: null,
      };
    }
    case "over":
      return { dragged, overlay: blocked ? null : dragged, openPaths: null };
    case "leave":
      return { dragged: null, overlay: null, openPaths: null };
    case "drop": {
      const classification = classifyDroppedPaths(event.paths);
      return {
        dragged: null,
        overlay: null,
        openPaths:
          !blocked && classification.kind === "open" ? classification.paths : null,
      };
    }
  }
}
