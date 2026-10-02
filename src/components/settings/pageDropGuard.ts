/**
 * Keeps a file that the user drops on the Settings window from replacing its page.
 *
 * The Settings window has no native drop handler (`disable_drag_drop_handler` in
 * `src-tauri/src/commands/settings_window.rs`), so a file drop reaches the web view, and its
 * default action opens the file in place of the page. That would drop an unsaved preset draft
 * with no prompt. The Settings window takes no files, so the guard cancels the default action
 * of every drag that carries files, and it shows the pointer that refuses the drop. A drag of
 * text, such as a path into a text field, keeps its default action.
 *
 * The main window is not involved: its import listens for the native drop events of its own
 * web view (`useFileDropOpen`), and the Settings window sends none.
 */

/** The part of a drag event that the guard reads and changes. `DragEvent` satisfies it. */
export interface PageDragEvent {
  readonly dataTransfer: {
    readonly types: ArrayLike<string>;
    dropEffect: string;
  } | null;
  preventDefault: () => void;
}

/** The part of a document that the guard listens on. `document` satisfies it. */
export interface PageDropTarget {
  addEventListener: (
    type: "dragover" | "drop",
    listener: (event: DragEvent) => void,
  ) => void;
  removeEventListener: (
    type: "dragover" | "drop",
    listener: (event: DragEvent) => void,
  ) => void;
}

/** True when the drag carries files. */
function carriesFiles(event: PageDragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

/** Refuses a drag of files over the page. */
export function refuseFileDragOver(event: PageDragEvent): void {
  if (!carriesFiles(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "none";
  }
}

/** Cancels the default action of a drop of files, which would replace the page. */
export function refuseFileDrop(event: PageDragEvent): void {
  if (carriesFiles(event)) {
    event.preventDefault();
  }
}

/**
 * Starts the guard on `target`, and returns the function that stops it. The listeners are in
 * the bubble phase, so a control that takes a drop of its own still sees it first.
 */
export function startPageDropGuard(target: PageDropTarget): () => void {
  target.addEventListener("dragover", refuseFileDragOver);
  target.addEventListener("drop", refuseFileDrop);
  return () => {
    target.removeEventListener("dragover", refuseFileDragOver);
    target.removeEventListener("drop", refuseFileDrop);
  };
}
