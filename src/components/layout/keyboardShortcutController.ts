/**
 * Pure keyboard shortcut resolver for QuipClip.
 *
 * Implements window-level keyboard shortcut rules without React, DOM, or store dependencies,
 * allowing full deterministic testing in a node environment.
 */

export type ShortcutAction =
  "togglePlayback" | "stepBackOneFrame" | "stepForwardOneFrame";

/** Tag names whose elements own every key press. Uppercase: Element.tagName is uppercase. */
export const EDITABLE_TAG_NAMES: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/**
 * Selector for a modal layer that owns the keyboard while it is mounted and open.
 *
 * Radix keeps a closed layer mounted while its exit animation runs, and a layer that is
 * animating out no longer owns the keyboard. `:not([data-state="closed"])` ensures
 * an animating-out layer is not treated as open.
 */
export const MODAL_LAYER_SELECTOR: string =
  '[role="dialog"]:not([data-state="closed"]),' +
  '[role="alertdialog"]:not([data-state="closed"]),' +
  '[role="menu"]:not([data-state="closed"]),' +
  '[role="listbox"]:not([data-state="closed"])';

/** Selector naming every container that owns the keyboard while focus is inside it. */
export const KEYBOARD_OWNER_SELECTOR: string =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],' +
  '[role="menuitem"],[role="listbox"],[role="combobox"],[role="option"],' +
  '[contenteditable=""],[contenteditable="true"]';

/** The narrow view of the event target the rules read, so a test can pass a fake. */
export interface ShortcutEventTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  /** Answers `Element.closest(selector) !== null` for the target. */
  readonly hasAncestorMatching: (selector: string) => boolean;
}

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  /** Legacy code. 229 marks a key an input method took, which isComposing misses on the first key. */
  readonly keyCode?: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: ShortcutEventTarget | null;
  /** True while a modal layer is mounted anywhere in the document. */
  readonly isOverlayOpen: boolean;
}

export interface ShortcutCapabilities {
  readonly hasActiveSource: boolean;
  readonly hasNominalRate: boolean;
}

export interface ShortcutResolution {
  /** True when the layer owns this key press and the default action must be suppressed. */
  readonly claimed: boolean;
  /** The action to dispatch, or null when the layer owns the key but cannot act. */
  readonly action: ShortcutAction | null;
}

/**
 * Determines whether a keyboard event is suppressed from triggering window-level shortcuts.
 */
export function isShortcutSuppressed(event: ShortcutKeyEvent): boolean {
  // 1. This guards only against another listener registered earlier on the window in the
  // capture phase, and it is also what a test asserts. An inner handler cannot opt out by
  // cancelling the event, by design — the layer runs before every one of them.
  if (event.defaultPrevented) {
    return true;
  }

  // 2. Modifiers: Ctrl, Meta (Cmd), and Alt represent system, browser, or app-level shortcuts.
  // Shift is refused ON PURPOSE, to reserve Shift+Arrow for a later multi-frame step and to
  // keep the modifier test one expression.
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return true;
  }

  // 3. IME input methods: Both input-method tests are needed. `isComposing` is false on the
  // very first keydown that opens a composition in several browser engines, and `keyCode === 229`
  // marks every key the input method consumed.
  if (event.isComposing || event.keyCode === 229) {
    return true;
  }

  // 4. Modal/overlay open: `isOverlayOpen` is deliberately redundant with the ancestor test.
  // It covers the case where a modal is open but focus sits on <body>, which the ancestor test
  // cannot see.
  if (event.isOverlayOpen) {
    return true;
  }

  // 5. Form inputs and focused keyboard owners:
  // - EDITABLE_TAG_NAMES: Standard text input and select form controls own every key press.
  // - isContentEditable: Rich-text editable regions own text entry.
  // - KEYBOARD_OWNER_SELECTOR: Containers such as dialogs, menus, and listboxes own
  //   arrow keys and space for navigation and item selection.
  if (event.target !== null) {
    if (
      EDITABLE_TAG_NAMES.includes(event.target.tagName) ||
      event.target.isContentEditable ||
      event.target.hasAncestorMatching(KEYBOARD_OWNER_SELECTOR)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves a keyboard shortcut event to its corresponding action and claim state.
 *
 * Why `claimed` and `action` are separate:
 * A held Space, and Space with no media open, both claim without acting, so Space means one
 * thing in the main window regardless of application state — exactly like a disabled button.
 * Merging them into one nullable field would make Space activate whatever button happens to hold
 * focus when no media is open, and not when media is open, which is the state-dependent key
 * meaning this unit removes.
 *
 * We do NOT claim ArrowUp, ArrowDown, or Home:
 * - Up and down belong to scroll containers and to Radix roving focus (ArrowDown opens a focused dropdown).
 * - Home currently calls seekToPts, which hard-requires a ready calibration and otherwise
 *   PAUSES the element and sets error: "seekFailed" — a global Home under the looser gate would
 *   raise a visible error on every uncalibrated source.
 */
export function resolveShortcut(
  event: ShortcutKeyEvent,
  capabilities: ShortcutCapabilities,
): ShortcutResolution {
  if (isShortcutSuppressed(event)) {
    return { claimed: false, action: null };
  }

  if (event.key === " ") {
    // Space is claimed to prevent page scroll and prevent accidental button triggers.
    // A held Space must not toggle thirty times a second, and must still not scroll the page.
    if (event.repeat) {
      return { claimed: true, action: null };
    }
    return {
      claimed: true,
      action: capabilities.hasActiveSource ? "togglePlayback" : null,
    };
  }

  if (event.key === "ArrowLeft") {
    // Repeats pass through unchanged so holding an arrow key steps continuously.
    return {
      claimed: true,
      action:
        capabilities.hasActiveSource && capabilities.hasNominalRate
          ? "stepBackOneFrame"
          : null,
    };
  }

  if (event.key === "ArrowRight") {
    // Repeats pass through unchanged so holding an arrow key steps continuously.
    return {
      claimed: true,
      action:
        capabilities.hasActiveSource && capabilities.hasNominalRate
          ? "stepForwardOneFrame"
          : null,
    };
  }

  // Every other key belongs to other handlers or default browser behavior.
  return { claimed: false, action: null };
}
