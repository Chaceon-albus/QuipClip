/**
 * Pure keyboard shortcut resolver for QuipClip.
 *
 * Implements window-level keyboard shortcut rules without React, DOM, or store dependencies,
 * allowing full deterministic testing in a node environment. ADR 021 gives the rules of the
 * layer. ADR 026 gives the key table, in `shortcutBindings.ts`, and the rule for modifiers.
 */

import {
  findShortcutBinding,
  type ShortcutAction,
  type ShortcutKeyPress,
  type ShortcutPlatform,
} from "./shortcutBindings";
import { RESIZING_TIMELINE_ATTRIBUTE } from "./timelineResizeCursor";

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

/**
 * Selector for a tooltip that is open.
 *
 * The shadcn wrapper sets `data-slot="tooltip-content"` on the Radix content element, and
 * Radix sets `data-state` on that element to `delayed-open`, `instant-open` or `closed`. Radix
 * keeps a closing tooltip mounted while its exit animation runs, and a tooltip in that state
 * is already dismissed, so `closed` does not count.
 */
export const OPEN_TOOLTIP_SELECTOR: string =
  '[data-slot="tooltip-content"]:not([data-state="closed"])';

/** Selector naming every container that owns the keyboard while focus is inside it. */
export const KEYBOARD_OWNER_SELECTOR: string =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],' +
  '[role="menuitem"],[role="listbox"],[role="combobox"],[role="option"],' +
  '[contenteditable=""],[contenteditable="true"]';

/**
 * Selector for a splitter that can take the focus, such as the one above the timeline
 * (`TimelineArea`). The splitter carries this marker. A `role="separator"` alone does not match,
 * so a decorative separator, or one that is out of the Tab order, keeps every key of the layer.
 */
export const SPLITTER_SELECTOR = "[data-splitter]";

/**
 * Selector for a drag that owns `Escape`: the drag of the timeline splitter. While it runs, the
 * document root carries the attribute of its resize cursor (`timelineResizeCursor.ts`), and every
 * key press target is inside the root, so the target test finds it.
 */
export const ESCAPE_OWNER_SELECTOR = `[${RESIZING_TIMELINE_ATTRIBUTE}]`;

/**
 * The keys that a focused splitter owns: the keys of the ARIA window splitter pattern for a
 * splitter that moves up and down (`resolveTimelineSplitterKey`).
 */
export const SPLITTER_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "Home", "End"];

/** The narrow view of the event target the rules read, so a test can pass a fake. */
export interface ShortcutEventTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  /** Answers `Element.closest(selector) !== null` for the target. */
  readonly hasAncestorMatching: (selector: string) => boolean;
}

export interface ShortcutKeyEvent extends ShortcutKeyPress {
  readonly repeat: boolean;
  readonly isComposing: boolean;
  /** Legacy code. 229 marks a key an input method took, which isComposing misses on the first key. */
  readonly keyCode?: number;
  readonly defaultPrevented: boolean;
  readonly target: ShortcutEventTarget | null;
  /** True while a modal layer is mounted anywhere in the document. */
  readonly isOverlayOpen: boolean;
  /** True while a tooltip is open anywhere in the document (`OPEN_TOOLTIP_SELECTOR`). */
  readonly isTooltipOpen: boolean;
}

export interface ShortcutContext {
  /** The platform that decides what `primary` means. */
  readonly platform: ShortcutPlatform;
  /**
   * Answers whether the action can run now. It must apply the same condition as the control
   * that performs the action (ADR 026). The resolver asks only for the action it matched.
   */
  readonly isActionAvailable: (action: ShortcutAction) => boolean;
}

export interface ShortcutResolution {
  /** True when the layer owns this key press and the default action must be suppressed. */
  readonly claimed: boolean;
  /** The action to dispatch, or null when the layer owns the key but cannot act. */
  readonly action: ShortcutAction | null;
}

const NOT_CLAIMED: ShortcutResolution = { claimed: false, action: null };
const CLAIMED_WITHOUT_ACTION: ShortcutResolution = { claimed: true, action: null };

/**
 * Determines whether the context of a keyboard event keeps it from every window-level
 * shortcut, whatever the key.
 *
 * The modifier rule is not here. ADR 026 replaced the refusal of every modifier with an exact
 * match against each binding, so the key table decides it (`matchesShortcutModifiers`).
 */
export function isShortcutSuppressed(event: ShortcutKeyEvent): boolean {
  // 1. This guards only against another listener registered earlier on the window in the
  // capture phase, and it is also what a test asserts. An inner handler cannot opt out by
  // cancelling the event, by design — the layer runs before every one of them.
  if (event.defaultPrevented) {
    return true;
  }

  // 2. IME input methods: Both input-method tests are needed. `isComposing` is false on the
  // very first keydown that opens a composition in several browser engines, and `keyCode === 229`
  // marks every key the input method consumed.
  if (event.isComposing || event.keyCode === 229) {
    return true;
  }

  // 3. Modal/overlay open: `isOverlayOpen` is deliberately redundant with the ancestor test.
  // It covers the case where a modal is open but focus sits on <body>, which the ancestor test
  // cannot see.
  if (event.isOverlayOpen) {
    return true;
  }

  // 4. Form inputs and focused keyboard owners:
  // - EDITABLE_TAG_NAMES: Standard text input and select form controls own every key press,
  //   including primary+Z, so a text field keeps its own undo.
  // - isContentEditable: Rich-text editable regions own text entry.
  // - KEYBOARD_OWNER_SELECTOR: Containers such as dialogs, menus, and listboxes own
  //   arrow keys, Home, End, Escape and Space for navigation and item selection.
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
 * Determines whether a focused splitter owns this key press (`SPLITTER_KEYS`), with no `Ctrl`,
 * `Cmd` or `Alt` held.
 *
 * Unlike the owners of `KEYBOARD_OWNER_SELECTOR`, a splitter owns only the keys that move it.
 * `Home` and `End` are also in the key table (ADR 026), so without this rule a press on the
 * splitter would go to the first or the last frame. Every other key keeps its meaning: `Space`
 * still plays and `ArrowLeft` still steps while the splitter has the focus.
 */
export function isSplitterKey(event: ShortcutKeyEvent): boolean {
  return (
    SPLITTER_KEYS.includes(event.key) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.target !== null &&
    event.target.hasAncestorMatching(SPLITTER_SELECTOR)
  );
}

/** The part of the document root that `isGestureEscape` reads. */
export interface GestureEscapeRoot {
  hasAttribute(name: string): boolean;
}

/** Returns `document.documentElement`, or null outside a document. */
function getDocumentRoot(): GestureEscapeRoot | null {
  if (typeof document !== "undefined" && document.documentElement) {
    return document.documentElement;
  }
  return null;
}

/**
 * Determines whether a running drag owns this `Escape` (`ESCAPE_OWNER_SELECTOR`), whatever the
 * modifiers.
 *
 * `Escape` finishes the named segment (ADR 026). During a drag of the timeline splitter it
 * cancels the drag instead, so the layer leaves it to the listener of the drag, which runs after
 * the layer on the window and cancels the key press. Every other key keeps its meaning during
 * the drag.
 *
 * The test reads the target. A key press with no element target reads the attribute on the
 * document root directly, so the drag still owns its `Escape`. This is the one rule of the
 * resolver that can read the document, and only for that case.
 *
 * @param getRoot Returns the document root. Defaults to `document.documentElement`; the tests
 *   pass a fake.
 */
export function isGestureEscape(
  event: ShortcutKeyEvent,
  getRoot: () => GestureEscapeRoot | null = getDocumentRoot,
): boolean {
  if (event.key !== "Escape") {
    return false;
  }
  if (event.target !== null) {
    return event.target.hasAncestorMatching(ESCAPE_OWNER_SELECTOR);
  }
  return getRoot()?.hasAttribute(RESIZING_TIMELINE_ATTRIBUTE) ?? false;
}

/**
 * Resolves a keyboard shortcut event to its corresponding action and claim state.
 *
 * Why `claimed` and `action` are separate:
 * A held Space, and Space with no media open, both claim without acting, so Space means one
 * thing in the main window regardless of application state — exactly like a disabled button.
 * Merging them into one nullable field would make Space activate whatever button happens to hold
 * focus when no media is open, and not when media is open, which is the state-dependent key
 * meaning this unit removes. ADR 026 applies the same rule to every binding: when the condition
 * of the action is false, the layer owns the key press and performs nothing, so the key cannot
 * go to another handler that the user cannot see.
 *
 * A key press that matches no binding of the table is not claimed. ArrowUp and ArrowDown are
 * in no binding: they belong to scroll containers and to Radix roving focus (ArrowDown opens a
 * focused dropdown).
 */
export function resolveShortcut(
  event: ShortcutKeyEvent,
  context: ShortcutContext,
): ShortcutResolution {
  if (isShortcutSuppressed(event) || isSplitterKey(event) || isGestureEscape(event)) {
    return NOT_CLAIMED;
  }

  const binding = findShortcutBinding(event, context.platform);
  if (binding === null) {
    // Every other key, and every modifier combination the table does not name, belongs to
    // other handlers, to the web view, or to the system.
    return NOT_CLAIMED;
  }

  // Radix closes an open tooltip from a keydown listener on the document in the capture phase.
  // The window listener runs before it, so a claimed Escape would never reach it and no tooltip
  // could be dismissed from the keyboard (WCAG 1.4.13). The layer lets the key pass, the
  // tooltip closes, and the next Escape finishes the segment (ADR 026).
  if (binding.yieldsToOpenTooltip === true && event.isTooltipOpen) {
    return NOT_CLAIMED;
  }

  // A "taken" key must not act thirty times a second while it is held, and must still not
  // reach the page: a held Space would otherwise scroll it. An "acts" key, such as an arrow,
  // steps on every repeat so that holding it steps continuously.
  if (event.repeat && binding.repeat === "taken") {
    return CLAIMED_WITHOUT_ACTION;
  }

  return {
    claimed: true,
    action: context.isActionAvailable(binding.action) ? binding.action : null,
  };
}
