/**
 * Pure rules for opening a video that the user drops on the window.
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
      /** The first dropped path with a supported video extension. */
      readonly path: string;
      /** True when the drag carries more than one path, so the others are not opened. */
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
  /** The file to open, or null. Only a `drop` event sets it. */
  readonly openPath: string | null;
}

/**
 * Chooses the file that a drop opens.
 *
 * The result is `open` with the first path that has a supported video extension, even when
 * an earlier path is not a video. The result is `unsupported` when no path has a supported
 * extension, which includes a drag with no file paths at all. An empty or blank path is
 * never a candidate.
 *
 * @param paths The dropped paths, in the order the operating system reports them.
 */
export function classifyDroppedPaths(
  paths: readonly string[],
): DroppedPathsClassification {
  const path = paths.find(
    (candidate) => candidate.trim().length > 0 && hasVideoFileExtension(candidate),
  );
  if (path === undefined) {
    return { kind: "unsupported" };
  }
  return { kind: "open", path, extraIgnored: paths.length > 1 };
}

/**
 * Resolves one drag-drop event.
 *
 * - `enter` classifies the dragged paths and shows the result.
 * - `over` shows the classification of the last `enter` again. The event carries no paths.
 *   It returns the same object, so a React state setter that receives it does not render.
 * - `leave` hides the overlay.
 * - `drop` hides the overlay and opens the chosen file. It classifies the paths of the drop
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
        openPath: null,
      };
    }
    case "over":
      return { dragged, overlay: blocked ? null : dragged, openPath: null };
    case "leave":
      return { dragged: null, overlay: null, openPath: null };
    case "drop": {
      const classification = classifyDroppedPaths(event.paths);
      return {
        dragged: null,
        overlay: null,
        openPath:
          !blocked && classification.kind === "open" ? classification.path : null,
      };
    }
  }
}
