/**
 * The pure model of the context menu of a timeline segment: the items, their enabled states,
 * their labels and keys, and the rules that open the menu.
 *
 * A right-click on a segment, a Ctrl-click on macOS, and the Menu key or Shift+F10 on a focused
 * segment open the menu. The request selects the segment, as a click does, and never seeks
 * (ADR 007). The body and the edges of a segment open the same menu: a secondary press on an
 * edge is not a trim (ADR 030) and not a click of the edge.
 *
 * Each item names an action of the key table (ADR 026), and its condition is the plan of that
 * action for the key (`planShortcutCommand`). One predicate therefore enables the item, lets
 * the key act, and plans the command that the item runs. An item whose condition is false is
 * disabled, not hidden, so the menu keeps its shape. An item runs only the kind of command that
 * it showed when the menu opened (`SegmentMenuItem.commandKind`).
 *
 * The key of each item comes from the binding table. macOS draws the accelerator of a native
 * item in the glyphs of `formatShortcut`, so the item carries its accelerator there
 * (`formatMenuAccelerator`). Windows draws the text after a tab in the accelerator column of the
 * menu, so the item carries the label of `formatShortcut` there. A native item with an
 * accelerator on Windows would show the English key names of the menu library, such as `Del`,
 * and not the names of the catalog.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type {
  ShortcutAction,
  ShortcutPlatform,
} from "@/components/layout/shortcutBindings";
import {
  planShortcutCommand,
  type ShortcutCommand,
  type ShortcutSnapshot,
} from "@/components/layout/shortcutCommands";
import {
  formatMenuAccelerator,
  formatShortcut,
  shortcutFor,
  type ShortcutKeyNames,
} from "@/components/layout/shortcutLabels";
import type { ClientRange } from "./edgeAutoScroll";

/** The actions of the items of the menu, in the order of the menu. */
export const SEGMENT_MENU_ACTIONS = [
  "goToSegmentIn",
  "goToSegmentOut",
  "playSegment",
  "deleteSegment",
] as const satisfies readonly ShortcutAction[];

export type SegmentMenuAction = (typeof SEGMENT_MENU_ACTIONS)[number];

/** The catalog key of the label of each item. */
export const SEGMENT_MENU_LABEL_KEYS = {
  goToSegmentIn: "timeline.segmentMenu.goToIn",
  goToSegmentOut: "timeline.segmentMenu.goToOut",
  playSegment: "timeline.segmentMenu.playSegment",
  deleteSegment: "timeline.segmentMenu.deleteSegment",
} as const satisfies Record<SegmentMenuAction, string>;

/**
 * The label of Play Segment while a segment plays toward its stop. The key `/` then pauses, as
 * `Space` does (ADR 026), so the item names that action with the label of the Play button in
 * that state.
 */
export const SEGMENT_MENU_PAUSE_LABEL_KEY = "transport.action.pause";

export type SegmentMenuLabelKey =
  | (typeof SEGMENT_MENU_LABEL_KEYS)[keyof typeof SEGMENT_MENU_LABEL_KEYS]
  | typeof SEGMENT_MENU_PAUSE_LABEL_KEY;

/** One position of the menu: an item, or a separator. */
export type SegmentMenuSlot =
  | { readonly kind: "item"; readonly action: SegmentMenuAction }
  | { readonly kind: "separator" };

/**
 * The menu, from top to bottom. The two moves of the playhead come first, then Play Segment.
 * Delete Segment is the one edit, and a separator keeps it apart from them, as native menus
 * keep a destructive item apart.
 *
 * The menu holds only the actions whose operand is the segment itself. Mark In, Mark Out and
 * Split act at the playhead, which a right-click does not move (ADR 007), so they would act at a
 * place that the click does not name. Finish Segment clears the selection that the right-click
 * just made, and its key is Escape, which closes the menu.
 */
export const SEGMENT_MENU_LAYOUT: readonly SegmentMenuSlot[] = [
  { kind: "item", action: "goToSegmentIn" },
  { kind: "item", action: "goToSegmentOut" },
  { kind: "item", action: "playSegment" },
  { kind: "separator" },
  { kind: "item", action: "deleteSegment" },
];

/** One item of the menu, ready for the native menu. */
export interface SegmentMenuItem {
  readonly kind: "item";
  readonly action: SegmentMenuAction;
  /** The label from the catalog. */
  readonly label: string;
  /** The key of the action as `formatShortcut` names it, or null when it has none. */
  readonly shortcut: string | null;
  /**
   * The text of the native item: the label, with each `&` doubled so that the menu does not
   * read it as a mnemonic. On Windows the text also holds the key after a tab.
   */
  readonly text: string;
  /** The accelerator of the native item (`formatMenuAccelerator`) on macOS, or null. */
  readonly accelerator: string | null;
  /** True when the action can run now: the condition of its key (ADR 026). */
  readonly enabled: boolean;
  /**
   * The kind of the command that the key plans as the menu opens, or null when the item is
   * disabled. The item runs only a command of this kind (`planSegmentMenuCommand`). Play
   * Segment plans a pause while a segment plays, and its label then says so.
   */
  readonly commandKind: ShortcutCommand["kind"] | null;
}

export type SegmentMenuEntry = SegmentMenuItem | { readonly kind: "separator" };

/**
 * The command that an item runs now for the segment of the menu, or null when it runs nothing.
 *
 * It is the plan of the key of the same action (`planShortcutCommand`), with one more
 * condition: the segment of the menu must still be the current segment. The menu selects its
 * segment when it opens, and the key names the current segment (ADR 007), so while that holds
 * the item and the key act on the same segment. If another segment is current when the item
 * runs, the item runs nothing, because the menu named the segment under the pointer.
 *
 * With `shownKind`, the command must also be of the kind that the item showed. The state can
 * change while the menu is open: a segment that plays can reach its stop, and Play Segment then
 * plans a new playback where the item said Pause. The item then runs nothing.
 *
 * @param shownKind The `commandKind` of the item as the menu opened, or undefined for no check.
 */
export function planSegmentMenuCommand(
  action: SegmentMenuAction,
  segmentId: string,
  snapshot: ShortcutSnapshot,
  shownKind?: ShortcutCommand["kind"] | null,
): ShortcutCommand | null {
  if (snapshot.timeline.currentSegmentId !== segmentId) {
    return null;
  }
  const command = planShortcutCommand(action, snapshot);
  if (command === null || (shownKind !== undefined && command.kind !== shownKind)) {
    return null;
  }
  return command;
}

/** The facts that the items read. */
export interface SegmentMenuInput {
  /** The segment of the menu. */
  readonly segmentId: string;
  /** One read of the stores, after the selection of the segment. */
  readonly snapshot: ShortcutSnapshot;
  readonly platform: ShortcutPlatform;
  /** The key names that are words, from the catalog (`resolveShortcutKeyNames`). */
  readonly keyNames: ShortcutKeyNames;
  /** Reads a label from the catalog. */
  readonly translate: (key: SegmentMenuLabelKey) => string;
}

/**
 * Doubles each `&`, which a native menu reads as the mark of a mnemonic. The key after the tab
 * on Windows gets the same escape, because a translated key name can hold an `&` too.
 */
function escapeMnemonic(label: string): string {
  return label.replaceAll("&", "&&");
}

/**
 * Builds the entries of the menu for the segment, in the order of `SEGMENT_MENU_LAYOUT`.
 *
 * An item is enabled when its command plans (`planSegmentMenuCommand`), from the same snapshot
 * that the item would run on at that moment. While a segment plays, Play Segment takes the label
 * Pause, because its key then pauses.
 */
export function buildSegmentMenuEntries(
  input: SegmentMenuInput,
): readonly SegmentMenuEntry[] {
  const { segmentId, snapshot, platform, keyNames, translate } = input;
  return SEGMENT_MENU_LAYOUT.map((slot): SegmentMenuEntry => {
    if (slot.kind === "separator") {
      return slot;
    }
    const command = planSegmentMenuCommand(slot.action, segmentId, snapshot);
    const label = translate(
      slot.action === "playSegment" && command?.kind === "pause"
        ? SEGMENT_MENU_PAUSE_LABEL_KEY
        : SEGMENT_MENU_LABEL_KEYS[slot.action],
    );
    const binding = shortcutFor(slot.action, platform);
    const shortcut =
      binding === null ? null : formatShortcut(binding, platform, keyNames);
    const escaped = escapeMnemonic(label);
    const isMac = platform === "macos";
    return {
      kind: "item",
      action: slot.action,
      label,
      shortcut,
      text:
        !isMac && shortcut !== null
          ? `${escaped}\t${escapeMnemonic(shortcut)}`
          : escaped,
      accelerator: isMac && binding !== null ? formatMenuAccelerator(binding) : null,
      enabled: command !== null,
      commandKind: command?.kind ?? null,
    };
  });
}

/** The facts that decide whether a request opens the menu. */
export interface SegmentMenuOpenInput {
  /** True when the segment belongs to the active source, so a click could select it. */
  readonly isSegmentOfActiveSource: boolean;
  /**
   * True while the pointer gesture of the timeline runs: a press, a scrub or a trim. That
   * gesture holds the pointer, and a menu would take the release that ends it.
   */
  readonly isPointerGestureActive: boolean;
  /** True while a drag trims a segment edge (ADR 030). */
  readonly isTrimDragging: boolean;
  /** True while a dialog, a menu or a list box of the page is open (`MODAL_LAYER_SELECTOR`). */
  readonly isOverlayOpen: boolean;
  /** True while a native context menu is open (`nativeContextMenuState`). */
  readonly isMenuOpen: boolean;
}

/**
 * True when a request opens the menu. A request that does not open it does nothing: it does not
 * select the segment either.
 */
export function canOpenSegmentMenu(input: SegmentMenuOpenInput): boolean {
  return (
    input.isSegmentOfActiveSource &&
    !input.isPointerGestureActive &&
    !input.isTrimDragging &&
    !input.isOverlayOpen &&
    !input.isMenuOpen
  );
}

/** The part of a press that `isContextMenuPress` reads. */
export interface SegmentMenuPress {
  readonly button: number;
  readonly ctrlKey: boolean;
}

/**
 * True for a press that opens a context menu: the secondary button, and on macOS the primary
 * button with Control held. Such a press does not start a trim, and on macOS the click that
 * follows a Control press does not select or seek (ADR 007, ADR 030). On Windows a Control
 * press with the primary button is a plain click.
 */
export function isContextMenuPress(
  press: SegmentMenuPress,
  platform: ShortcutPlatform,
): boolean {
  return (
    press.button === 2 || (platform === "macos" && press.button === 0 && press.ctrlKey)
  );
}

/** How the user asked for the menu. */
export type SegmentMenuSource = "pointer" | "keyboard";

/**
 * Tells a menu request from the pointer from a request from the keyboard.
 *
 * A `contextmenu` event does not say where it came from in every engine. The segment layer
 * therefore reports each press on a segment here. A request that follows a context-menu press
 * (`isContextMenuPress`) comes from the pointer. Any other request, such as one from the Menu
 * key, Shift+F10 or assistive technology, comes from the keyboard.
 *
 * Every event that can end a context-menu press without a request on a segment forgets the press
 * (`reset`): a key press or a focus on a segment, and the window events of
 * `listenForSegmentMenuSourceReset`. A press that the tracker keeps too long would open a later
 * request from the keyboard at the pointer.
 */
export interface SegmentMenuSourceTracker {
  /** A pointer pressed a segment. */
  readonly press: (isContextMenuPress: boolean) => void;
  /** Forgets a context-menu press. */
  readonly reset: () => void;
  /** Reads the source of a menu request, and forgets the press. */
  readonly take: () => SegmentMenuSource;
}

export function createSegmentMenuSourceTracker(): SegmentMenuSourceTracker {
  let isPressed = false;
  return {
    press: (isContextMenu) => {
      isPressed = isContextMenu;
    },
    reset: () => {
      isPressed = false;
    },
    take: () => {
      const source = isPressed ? "pointer" : "keyboard";
      isPressed = false;
      return source;
    },
  };
}

/** The part of the window that `listenForSegmentMenuSourceReset` uses. A test passes a fake. */
export type SegmentMenuResetTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

/**
 * Makes the window forget a context-menu press of the tracker at each event that ends the press
 * outside a segment, and returns the function that removes the listeners.
 *
 * - `pointerdown` in the capture phase: any press starts again. The listener runs before the
 *   handler of a segment, so a new context-menu press on a segment is still recorded.
 * - `contextmenu` in the bubble phase: a request anywhere ends the press. A secondary press that
 *   the user releases off every segment sends its request to another element on Windows. The
 *   listener runs after the handler of a segment, which already took the press.
 * - `blur`: the user can release the button in another application.
 */
export function listenForSegmentMenuSourceReset(
  target: SegmentMenuResetTarget,
  tracker: Pick<SegmentMenuSourceTracker, "reset">,
): () => void {
  const reset = () => {
    tracker.reset();
  };
  target.addEventListener("pointerdown", reset, { capture: true });
  target.addEventListener("contextmenu", reset);
  target.addEventListener("blur", reset);
  return () => {
    target.removeEventListener("pointerdown", reset, { capture: true });
    target.removeEventListener("contextmenu", reset);
    target.removeEventListener("blur", reset);
  };
}

/** A position in client CSS pixels, from the top left of the web view. */
export interface SegmentMenuPosition {
  readonly x: number;
  readonly y: number;
}

/** The part of the rectangle of a segment that the position reads. */
export interface SegmentMenuRect {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The position of the menu, or null to open it at the pointer.
 *
 * A request from the pointer opens the menu at the pointer, as every native context menu does.
 * A request from the keyboard opens it at the bottom left of the visible part of the segment,
 * so the menu does not cover the segment it names. The sticky gutter and the edges of the view
 * hide a part of the lane (`calculateVisibleLane`), so the position moves to the nearest visible
 * point of the lane. The system moves a menu that does not fit on the screen.
 *
 * @param source The source of the request (`SegmentMenuSourceTracker`).
 * @param segment The client rectangle of the segment.
 * @param visibleLane The visible part of the lane, in client pixels.
 */
export function resolveSegmentMenuPosition(
  source: SegmentMenuSource,
  segment: SegmentMenuRect,
  visibleLane: ClientRange,
): SegmentMenuPosition | null {
  if (source === "pointer") {
    return null;
  }
  const values = [segment.left, segment.bottom, visibleLane.left, visibleLane.right];
  if (!values.every(Number.isFinite) || visibleLane.right < visibleLane.left) {
    return null;
  }
  return {
    x: Math.min(Math.max(segment.left, visibleLane.left), visibleLane.right),
    y: segment.bottom,
  };
}

/** The part of a `contextmenu` event on a segment that `takeSegmentContextMenuEvent` reads. */
export interface SegmentContextMenuEvent {
  preventDefault(): void;
  readonly currentTarget: { getBoundingClientRect(): SegmentMenuRect };
}

/**
 * Takes the `contextmenu` event of a segment: it cancels the event, so the web view opens no
 * menu, and it returns the position of the menu of the segment (`resolveSegmentMenuPosition`).
 *
 * The segment layer calls it from its React handler. The context menu policy of the window
 * (`useContextMenuPolicy`) listens on the window in the bubble phase, so it runs after this
 * handler and finds the event already cancelled. The web view therefore opens no menu on a
 * segment in any build, and the policy still decides for every other element.
 *
 * @param event The event, with the segment button as its current target.
 * @param source The source of the request (`SegmentMenuSourceTracker.take`).
 * @param visibleLane The visible part of the lane (`calculateVisibleLane`), or null when the
 *   timeline viewport is not mounted. The segment rectangle then stands for it.
 */
export function takeSegmentContextMenuEvent(
  event: SegmentContextMenuEvent,
  source: SegmentMenuSource,
  visibleLane: ClientRange | null,
): SegmentMenuPosition | null {
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  return resolveSegmentMenuPosition(
    source,
    rect,
    visibleLane ?? { left: rect.left, right: rect.right },
  );
}
