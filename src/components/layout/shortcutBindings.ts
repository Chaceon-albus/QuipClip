/**
 * The key table of the window keyboard layer (ADR 026).
 *
 * `SHORTCUT_BINDINGS` is the only source of the key bindings. The keyboard layer matches each
 * key press against it. `shortcutLabels.ts` formats the key names of the tooltips, the menu
 * items and the `aria-keyshortcuts` attributes from this table, so no control spells a key on
 * its own. Each binding names a key, an exact set of modifiers, an action, and what a repeated
 * key press does.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import { isMacOS } from "@/lib/platform";

/**
 * The platform that decides what `primary` means: `Cmd` on macOS, `Ctrl` on Windows.
 *
 * Everything that is not macOS takes the Windows branch, as the title bar does, so Linux gets
 * the Windows keys.
 */
export type ShortcutPlatform = "macos" | "windows";

/** Reads the platform of the current environment. */
export function getShortcutPlatform(): ShortcutPlatform {
  return isMacOS() ? "macos" : "windows";
}

/** Every action that a binding of the table can name. */
export const SHORTCUT_ACTIONS = [
  "togglePlayback",
  "stepBackOneFrame",
  "stepForwardOneFrame",
  "stepBackTenFrames",
  "stepForwardTenFrames",
  "goToStart",
  "goToEnd",
  "markIn",
  "markOut",
  "goToSegmentIn",
  "goToSegmentOut",
  "deleteSegment",
  "finishSegment",
  "undo",
  "redo",
  "openMedia",
  "export",
  "openSettings",
  "zoomIn",
  "zoomOut",
  "zoomToFit",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** A key that `event.key` names with a word, and `" "` for the space bar (ADR 021). */
export type ShortcutNamedKey =
  " " | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Delete" | "Backspace" | "Escape";

export type ShortcutLetter =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";

/**
 * The identity of a key, and the rule that matches it (ADR 026).
 *
 * - `named`: matches `event.key`.
 * - `letter`: matches `event.key` when that value is one ASCII letter, compared without case.
 *   It matches `event.code` (`KeyA` to `KeyZ`) only when `event.key` is not one printable
 *   ASCII character. A printable ASCII character that is not the letter does not match, so
 *   the `.` that the physical E key types on Dvorak is not E. The first rule follows the
 *   layout the user selected, so a Dvorak user presses the key that shows the letter. The
 *   second rule covers a Cyrillic or Greek layout, a dead key, and the character that
 *   `Option` makes on macOS. `Caps Lock` does not change a match.
 * - `character`: a punctuation key. It matches `event.key` when that value is one printable
 *   ASCII character. Otherwise it matches `event.code` when the row names a position in
 *   `code`, and nothing when `code` is null. The comma of primary+`,` names its position,
 *   because a Cyrillic layout types a letter there and its users press that key. The zoom
 *   rows name none: on other layouts the US positions of `=`, `-` and `\` show other
 *   symbols, such as the German `´` and `ß` and the Spanish `ç`, and those must not zoom.
 * - `numpad`: a key of the numeric keypad. It matches `event.code` only, so the position names
 *   it on every layout and in both Num Lock states. `character` is the symbol on its key cap,
 *   which the labels show. ADR 026 names the numpad `+` and `-` this way.
 */
export type ShortcutKey =
  | { readonly kind: "named"; readonly key: ShortcutNamedKey }
  | { readonly kind: "letter"; readonly letter: ShortcutLetter }
  | {
      readonly kind: "character";
      readonly character: string;
      /** The position to match when `event.key` is not ASCII, or null for none. */
      readonly code: string | null;
    }
  | {
      readonly kind: "numpad";
      readonly character: string;
      readonly code: `Numpad${string}`;
    };

/**
 * A modifier a binding can hold. `primary` is `Cmd` on macOS and `Ctrl` on Windows.
 *
 * `Alt` is not a member: no binding uses it, so a key press with `Alt` held never matches.
 */
export type ShortcutModifier = "primary" | "shift";

/**
 * What a repeated key press of a held key does.
 *
 * - `acts`: every repeat performs the action again.
 * - `taken`: the layer owns the repeat and performs nothing, as ADR 021 does for a held
 *   `Space`.
 */
export type ShortcutRepeatPolicy = "acts" | "taken";

export interface ShortcutBinding {
  readonly key: ShortcutKey;
  /** The exact set of held modifiers. A key press with any other modifier held does not match. */
  readonly modifiers: readonly ShortcutModifier[];
  /** The platforms the binding exists on. Absent means every platform. */
  readonly platforms?: readonly ShortcutPlatform[];
  readonly action: ShortcutAction;
  readonly repeat: ShortcutRepeatPolicy;
  /**
   * True when an open tooltip takes this key first. Radix closes an open tooltip on `Escape`,
   * so while a tooltip is open the layer does not own the key press, and the innermost layer
   * closes first. The next press reaches the binding (ADR 026).
   */
  readonly yieldsToOpenTooltip?: boolean;
  /**
   * True for a second binding of a symbol that some layouts type with `Shift` and others
   * without, such as `=` on JIS or `+` on a German keyboard. The layer matches it like any
   * other binding. `aria-keyshortcuts` leaves it out, because it names a symbol that the
   * attribute already lists, and the chip never names it, because it is never the first
   * binding of its action.
   */
  readonly layoutVariant?: boolean;
}

/** The part of a key press that the table reads. */
export interface ShortcutKeyPress {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const named = (key: ShortcutNamedKey): ShortcutKey => ({ kind: "named", key });

const letter = (value: ShortcutLetter): ShortcutKey => ({
  kind: "letter",
  letter: value,
});

const character = (value: string, code: string | null): ShortcutKey => ({
  kind: "character",
  character: value,
  code,
});

const numpad = (value: string, code: `Numpad${string}`): ShortcutKey => ({
  kind: "numpad",
  character: value,
  code,
});

/**
 * The key table of ADR 026.
 *
 * The order decides two things. `findShortcutBinding` returns the first binding that matches,
 * and a label names the first binding of an action (`shortcutFor`). So `=` and `-` come before
 * the numpad keys, and the chip of Zoom In shows `=`.
 */
export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  { key: named(" "), modifiers: [], action: "togglePlayback", repeat: "taken" },
  {
    key: named("ArrowLeft"),
    modifiers: [],
    action: "stepBackOneFrame",
    repeat: "acts",
  },
  {
    key: named("ArrowRight"),
    modifiers: [],
    action: "stepForwardOneFrame",
    repeat: "acts",
  },
  {
    key: named("ArrowLeft"),
    modifiers: ["shift"],
    action: "stepBackTenFrames",
    repeat: "acts",
  },
  {
    key: named("ArrowRight"),
    modifiers: ["shift"],
    action: "stepForwardTenFrames",
    repeat: "acts",
  },
  { key: named("Home"), modifiers: [], action: "goToStart", repeat: "taken" },
  { key: named("End"), modifiers: [], action: "goToEnd", repeat: "taken" },
  { key: letter("I"), modifiers: [], action: "markIn", repeat: "taken" },
  { key: letter("O"), modifiers: [], action: "markOut", repeat: "taken" },
  { key: letter("I"), modifiers: ["shift"], action: "goToSegmentIn", repeat: "taken" },
  { key: letter("O"), modifiers: ["shift"], action: "goToSegmentOut", repeat: "taken" },
  { key: named("Delete"), modifiers: [], action: "deleteSegment", repeat: "taken" },
  { key: named("Backspace"), modifiers: [], action: "deleteSegment", repeat: "taken" },
  {
    key: named("Escape"),
    modifiers: [],
    action: "finishSegment",
    repeat: "taken",
    yieldsToOpenTooltip: true,
  },
  { key: letter("Z"), modifiers: ["primary"], action: "undo", repeat: "acts" },
  { key: letter("Z"), modifiers: ["primary", "shift"], action: "redo", repeat: "acts" },
  // ADR 026 writes this row as `Ctrl (Windows)`. On Windows `primary` is `Ctrl`, so the row is
  // `primary` limited to Windows. On macOS `Cmd+Y` stays with the system.
  {
    key: letter("Y"),
    modifiers: ["primary"],
    platforms: ["windows"],
    action: "redo",
    repeat: "acts",
  },
  { key: letter("O"), modifiers: ["primary"], action: "openMedia", repeat: "taken" },
  { key: letter("E"), modifiers: ["primary"], action: "export", repeat: "taken" },
  {
    key: character(",", "Comma"),
    modifiers: ["primary"],
    action: "openSettings",
    repeat: "taken",
  },
  // The zoom of the timeline (ADR 007). A held zoom key zooms on every repeat, as a wheel does.
  //
  // Every zoom punctuation row matches only the symbol that the layout types, and names no
  // position (`code` null). The US positions show other symbols on other layouts: Equal is the
  // German `´` dead key, Minus is the German `ß`, and Backslash is the Spanish `ç`, the
  // Italian `ù` and the Portuguese `~` dead key. A fallback to those positions would zoom from
  // keys whose caps show no zoom symbol. The numpad keys are the zoom keys that a position
  // names, and they have rows of their own.
  { key: character("=", null), modifiers: [], action: "zoomIn", repeat: "acts" },
  { key: character("-", null), modifiers: [], action: "zoomOut", repeat: "acts" },
  // The numpad keys match by position (ADR 026). The numpad plus types `+`, which the `=` row
  // does not match. The numpad minus types `-`, so the `-` row above already matches it first.
  // Its row states the numpad key of the ADR table all the same, and it does not change what a
  // key press does.
  { key: numpad("+", "NumpadAdd"), modifiers: [], action: "zoomIn", repeat: "acts" },
  {
    key: numpad("-", "NumpadSubtract"),
    modifiers: [],
    action: "zoomOut",
    repeat: "acts",
  },
  { key: character("\\", null), modifiers: [], action: "zoomToFit", repeat: "taken" },
  // The layout variants of the zoom keys. The modifier match is exact, so a layout that types
  // `=` or `+` with Shift needs a row that holds Shift:
  //
  // - `=` with Shift: JIS types it on Shift+Minus, and German on Shift+Digit0. On US,
  //   Shift+Equal types `+`, so this row never matches there, and the `+` row below takes it.
  // - `+` without Shift: German has an unshifted `+` key (BracketRight).
  // - `+` with Shift: US types it on Shift+Equal, and JIS on Shift+Semicolon.
  //
  // The numpad `+` row above comes first and still takes the numpad plus, so both rows are
  // reachable: the numpad row takes the numpad key, and the `+` row takes a main-row `+`.
  {
    key: character("=", null),
    modifiers: ["shift"],
    action: "zoomIn",
    repeat: "acts",
    layoutVariant: true,
  },
  {
    key: character("+", null),
    modifiers: [],
    action: "zoomIn",
    repeat: "acts",
    layoutVariant: true,
  },
  {
    key: character("+", null),
    modifiers: ["shift"],
    action: "zoomIn",
    repeat: "acts",
    layoutVariant: true,
  },
  // Final Cut Pro's Zoom to Fit, for a layout where `\` needs AltGr or Option, which no
  // binding holds. The modifier match is exact, so this row and primary+Z (undo) and
  // primary+Shift+Z (redo) never match the same key press.
  { key: letter("Z"), modifiers: ["shift"], action: "zoomToFit", repeat: "taken" },
];

/** True when the binding exists on the platform. */
export function bindingAppliesToPlatform(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
): boolean {
  return binding.platforms === undefined || binding.platforms.includes(platform);
}

const ASCII_LETTER = /^[A-Za-z]$/;
// The space to `~` is every printable ASCII character.
const PRINTABLE_ASCII = /^[ -~]$/;

/** True when the key press names the key, by the rule of the key's kind. */
export function matchesShortcutKey(
  key: ShortcutKey,
  press: Pick<ShortcutKeyPress, "key" | "code">,
): boolean {
  switch (key.kind) {
    case "named":
      return press.key === key.key;
    case "letter":
      // `toUpperCase` does not depend on the locale, so a Turkish locale still maps `i` to `I`.
      if (ASCII_LETTER.test(press.key)) {
        return press.key.toUpperCase() === key.letter;
      }
      // The layout typed another ASCII character on this key, so the key is not this letter,
      // whatever its position.
      if (PRINTABLE_ASCII.test(press.key)) {
        return false;
      }
      return press.code === `Key${key.letter}`;
    case "character":
      if (PRINTABLE_ASCII.test(press.key)) {
        return press.key === key.character;
      }
      // A row with no position matches the typed symbol only.
      return key.code !== null && press.code === key.code;
    case "numpad":
      return press.code === key.code;
  }
}

/**
 * True when the held modifiers equal the set exactly (ADR 026). `Shift+Ctrl+I` does not match
 * `I`, and `Alt` held never matches, because no binding holds it.
 */
export function matchesShortcutModifiers(
  modifiers: readonly ShortcutModifier[],
  press: Pick<ShortcutKeyPress, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform,
): boolean {
  const primary = modifiers.includes("primary");
  const shift = modifiers.includes("shift");
  return (
    press.metaKey === (primary && platform === "macos") &&
    press.ctrlKey === (primary && platform === "windows") &&
    !press.altKey &&
    press.shiftKey === shift
  );
}

/**
 * Returns the binding that the key press matches on the platform, or null when it matches
 * none. A key press that matches no binding is not owned, so the system and the web view keep
 * every combination that the table does not name.
 */
export function findShortcutBinding(
  press: ShortcutKeyPress,
  platform: ShortcutPlatform,
): ShortcutBinding | null {
  for (const binding of SHORTCUT_BINDINGS) {
    if (
      bindingAppliesToPlatform(binding, platform) &&
      matchesShortcutModifiers(binding.modifiers, press, platform) &&
      matchesShortcutKey(binding.key, press)
    ) {
      return binding;
    }
  }
  return null;
}
