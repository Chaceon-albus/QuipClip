/**
 * Keeps anything that the user drops on the Settings window from replacing its page.
 *
 * The Settings window has no native drop handler (`disable_drag_drop_handler` in
 * `src-tauri/src/commands/settings_window.rs`), so a drop reaches the web view, and the default
 * action of the web view opens a dropped file, a link or a web image in place of the page. That
 * would drop an unsaved preset draft with no prompt. The page takes no drop of its own, so the
 * guard refuses every drag, and shows the pointer that refuses it, with one exception: a drag
 * of text over a text field keeps its default action, so text can still be dropped into a
 * field of the preset editor, such as its name. A drag that carries files is refused there
 * too, because a field has no use for a file and the web view could open it.
 *
 * The main window is not involved: its import listens for the native drop events of its own
 * web view (`useFileDropOpen`), and the Settings window sends none.
 */

/** The part of a drag event that the guard reads and changes. `DragEvent` satisfies it. */
export interface PageDragEvent {
  readonly target: unknown;
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

/** The input types that hold free text, and so take a drop of text. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/**
 * True when `target` is an element that takes a drop of text: a text input or a text area
 * that the user can edit, or an editable element. Any other value, and a value that is not an
 * element, is false.
 */
export function isEditableDropTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) {
    return false;
  }
  const element = target as {
    readonly tagName?: unknown;
    readonly type?: unknown;
    readonly readOnly?: unknown;
    readonly disabled?: unknown;
    readonly isContentEditable?: unknown;
  };
  if (element.isContentEditable === true) {
    return true;
  }
  if (element.readOnly === true || element.disabled === true) {
    return false;
  }
  if (element.tagName === "TEXTAREA") {
    return true;
  }
  return (
    element.tagName === "INPUT" &&
    typeof element.type === "string" &&
    TEXT_INPUT_TYPES.has(element.type.toLowerCase())
  );
}

/** True when the drag carries files. */
function carriesFiles(event: PageDragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

/** True when the drag keeps its default action: text over a text field. */
function keepsDefault(event: PageDragEvent): boolean {
  return isEditableDropTarget(event.target) && !carriesFiles(event);
}

/** Refuses a drag over the page, except a drag of text over a text field. */
export function refuseDragOver(event: PageDragEvent): void {
  if (keepsDefault(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = "none";
  }
}

/**
 * Cancels the default action of a drop, which would open what was dropped in place of the
 * page, except a drop of text into a text field.
 */
export function refuseDrop(event: PageDragEvent): void {
  if (!keepsDefault(event)) {
    event.preventDefault();
  }
}

/**
 * Starts the guard on `target`, and returns the function that stops it. The listeners are in
 * the bubble phase, after the handlers of the page.
 */
export function startPageDropGuard(target: PageDropTarget): () => void {
  target.addEventListener("dragover", refuseDragOver);
  target.addEventListener("drop", refuseDrop);
  return () => {
    target.removeEventListener("dragover", refuseDragOver);
    target.removeEventListener("drop", refuseDrop);
  };
}
