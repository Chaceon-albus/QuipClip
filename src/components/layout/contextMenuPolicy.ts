/**
 * The rule that decides where the context menu of the web view opens.
 *
 * QuipClip is a desktop application, and the menu of the web view is a browser menu: Reload,
 * Inspect Element, Back and similar items. A release build therefore opens it in one place
 * only, an editable text field, where the menu holds Cut, Copy and Paste, as the menu of a
 * native text field does. A development build opens it everywhere, so a developer can inspect
 * an element.
 *
 * A media element never opens its menu, in every build. The native menu of a player holds
 * Loop, Show Controls and Picture in Picture, and each one changes the element behind the
 * playback store, which owns every seek and every play (ADR 003).
 *
 * The rule is pure. `describeContextMenuTarget` reads the event target into the plain
 * description below, and it reads only the members of `ContextMenuElement`, so a test needs no
 * document. `useContextMenuPolicy` mounts the listener.
 */

/**
 * The input types that take typed text. Only these have Cut, Copy and Paste in the menu. A
 * check box, a slider or a button does not.
 */
export const TEXT_INPUT_TYPES: readonly string[] = [
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
];

/** The narrow view of the event target that the rule reads, so a test can pass a fake. */
export interface ContextMenuTarget {
  /** `Element.tagName`. The rule ignores the case. */
  readonly tagName: string;
  /** The `type` of an `input` element. Null for every other element. */
  readonly inputType: string | null;
  /** `HTMLElement.isContentEditable`: true inside an editable region. */
  readonly isContentEditable: boolean;
  /** True for a form control that matches `:disabled`. */
  readonly isDisabled: boolean;
  /** True for a `video` or an `audio` element, or for an element inside one. */
  readonly isInsideMedia: boolean;
}

/** The part of an `Element` that `describeContextMenuTarget` reads. A test passes a fake. */
export interface ContextMenuElement {
  readonly tagName: string;
  /** The `type` property. Only an `input` element has one that the rule reads. */
  readonly type?: unknown;
  /** Only an `HTMLElement` has it. */
  readonly isContentEditable?: unknown;
  matches(selector: string): boolean;
  closest(selector: string): unknown;
}

/** The selector of the media elements whose native menu never opens. */
export const MEDIA_ELEMENT_SELECTOR = "video, audio";

function isContextMenuElement(value: unknown): value is ContextMenuElement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ContextMenuElement>;
  return (
    typeof candidate.tagName === "string" &&
    typeof candidate.matches === "function" &&
    typeof candidate.closest === "function"
  );
}

/**
 * Reads the target of a `contextmenu` event into the description that the rule reads.
 *
 * @param target The `target` of the event. A value that is not an element, such as the
 *   document or the window, gives null.
 */
export function describeContextMenuTarget(target: unknown): ContextMenuTarget | null {
  if (!isContextMenuElement(target)) {
    return null;
  }
  const isInput = target.tagName.toUpperCase() === "INPUT";
  return {
    tagName: target.tagName,
    inputType: isInput && typeof target.type === "string" ? target.type : null,
    isContentEditable: target.isContentEditable === true,
    isDisabled: target.matches(":disabled"),
    isInsideMedia: target.closest(MEDIA_ELEMENT_SELECTOR) !== null,
  };
}

/**
 * True when the target is a field that takes typed text: a text area, a text input, or an
 * editable region. A disabled field is not one, because no item of its menu applies. A
 * read-only field is one, because Copy applies.
 */
export function isEditableTextField(target: ContextMenuTarget): boolean {
  if (target.isContentEditable) {
    return true;
  }
  if (target.isDisabled) {
    return false;
  }
  const tagName = target.tagName.toUpperCase();
  if (tagName === "TEXTAREA") {
    return true;
  }
  if (tagName === "INPUT") {
    // The default type of an input is text. The `type` property already reads "text" for a
    // missing or an unknown attribute, and the empty string covers an attribute read.
    const type = (target.inputType ?? "text").toLowerCase();
    return type === "" || TEXT_INPUT_TYPES.includes(type);
  }
  return false;
}

/**
 * Decides whether the listener cancels a `contextmenu` event, so that the web view opens no
 * menu.
 *
 * @param target The element the event names, or null when the target is not an element.
 * @param isDevBuild True in a development build (`import.meta.env.DEV`).
 */
export function shouldSuppressContextMenu(
  target: ContextMenuTarget | null,
  isDevBuild: boolean,
): boolean {
  if (target !== null && target.isInsideMedia) {
    return true;
  }
  if (isDevBuild) {
    return false;
  }
  return target === null || !isEditableTextField(target);
}
