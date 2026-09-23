/**
 * The key names that the interface shows for a binding of the window keyboard layer (ADR 026).
 *
 * `SHORTCUT_BINDINGS` is the only source of the key names. A tooltip, a menu item and an
 * `aria-keyshortcuts` attribute read the binding of their action here and format it for the
 * platform: `⇧⌘Z` on macOS, `Ctrl+Shift+Z` on Windows. No control spells a key on its own.
 *
 * The macOS form puts the modifier symbols in the order of the Apple Human Interface
 * Guidelines (`⌃⌥⇧⌘`) and the key after them, with no separator. The Windows form joins the
 * modifier names and the key with `+`, in the order `Ctrl`, `Alt`, `Shift`.
 *
 * Only the key names that are words come from the catalog (ADR 011), through
 * `ShortcutKeyNames`. Symbols, letters and punctuation are the same in every language.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import {
  SHORTCUT_BINDINGS,
  bindingAppliesToPlatform,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutKey,
  type ShortcutNamedKey,
  type ShortcutPlatform,
} from "./shortcutBindings";

/**
 * The key names that are words. The caller reads them from the catalog, so a translator can
 * change them. The symbols and the letters are not in this set.
 */
export interface ShortcutKeyNames {
  /** The space bar. */
  readonly space: string;
  readonly home: string;
  readonly end: string;
  /** The forward delete key, as Windows labels it. macOS shows the `⌦` symbol. */
  readonly delete: string;
  /** The backward delete key, as Windows labels it. macOS shows the `⌫` symbol. */
  readonly backspace: string;
  readonly escape: string;
  /** The `Ctrl` modifier, as Windows labels it. macOS shows `⌘` for `primary`. */
  readonly ctrl: string;
  /** The `Shift` modifier, as Windows labels it. macOS shows the `⇧` symbol. */
  readonly shift: string;
}

/** The catalog key of each word in `ShortcutKeyNames`. */
export const SHORTCUT_KEY_NAME_KEYS = {
  space: "shortcut.key.space",
  home: "shortcut.key.home",
  end: "shortcut.key.end",
  delete: "shortcut.key.delete",
  backspace: "shortcut.key.backspace",
  escape: "shortcut.key.escape",
  ctrl: "shortcut.key.ctrl",
  shift: "shortcut.key.shift",
} as const satisfies Record<keyof ShortcutKeyNames, string>;

export type ShortcutKeyNameKey =
  (typeof SHORTCUT_KEY_NAME_KEYS)[keyof typeof SHORTCUT_KEY_NAME_KEYS];

/** Reads every word of `ShortcutKeyNames` through the translate function of the caller. */
export function resolveShortcutKeyNames(
  translate: (key: ShortcutKeyNameKey) => string,
): ShortcutKeyNames {
  return {
    space: translate(SHORTCUT_KEY_NAME_KEYS.space),
    home: translate(SHORTCUT_KEY_NAME_KEYS.home),
    end: translate(SHORTCUT_KEY_NAME_KEYS.end),
    delete: translate(SHORTCUT_KEY_NAME_KEYS.delete),
    backspace: translate(SHORTCUT_KEY_NAME_KEYS.backspace),
    escape: translate(SHORTCUT_KEY_NAME_KEYS.escape),
    ctrl: translate(SHORTCUT_KEY_NAME_KEYS.ctrl),
    shift: translate(SHORTCUT_KEY_NAME_KEYS.shift),
  };
}

/** The macOS symbols of the Apple Human Interface Guidelines. */
const MAC_SHIFT = "⇧";
const MAC_COMMAND = "⌘";
const MAC_FORWARD_DELETE = "⌦";
const MAC_BACKWARD_DELETE = "⌫";
const ARROW_LEFT = "←";
const ARROW_RIGHT = "→";

/** The label of a named key on the platform. */
function formatNamedKey(
  key: ShortcutNamedKey,
  platform: ShortcutPlatform,
  keyNames: ShortcutKeyNames,
): string {
  switch (key) {
    case " ":
      return keyNames.space;
    case "ArrowLeft":
      return ARROW_LEFT;
    case "ArrowRight":
      return ARROW_RIGHT;
    case "Home":
      return keyNames.home;
    case "End":
      return keyNames.end;
    case "Delete":
      return platform === "macos" ? MAC_FORWARD_DELETE : keyNames.delete;
    case "Backspace":
      return platform === "macos" ? MAC_BACKWARD_DELETE : keyNames.backspace;
    case "Escape":
      return keyNames.escape;
  }
}

function formatKey(
  key: ShortcutKey,
  platform: ShortcutPlatform,
  keyNames: ShortcutKeyNames,
): string {
  switch (key.kind) {
    case "named":
      return formatNamedKey(key.key, platform, keyNames);
    case "letter":
      return key.letter;
    case "character":
      return key.character;
  }
}

/**
 * Formats a binding for the platform: `⇧⌘Z`, `⌘O`, `⇧I`, `Space` or `←` on macOS, and
 * `Ctrl+Shift+Z`, `Ctrl+O`, `Shift+I`, `Space` or `←` on Windows.
 *
 * The result is one label for one key chip. It is never part of a translated sentence
 * (ADR 011).
 */
export function formatShortcut(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
  keyNames: ShortcutKeyNames,
): string {
  const shift = binding.modifiers.includes("shift");
  const primary = binding.modifiers.includes("primary");
  const key = formatKey(binding.key, platform, keyNames);
  if (platform === "macos") {
    // The HIG order is `⌃⌥⇧⌘`. The table holds only `shift` and `primary` (`⌘`).
    return `${shift ? MAC_SHIFT : ""}${primary ? MAC_COMMAND : ""}${key}`;
  }
  const parts: string[] = [];
  if (primary) {
    parts.push(keyNames.ctrl);
  }
  if (shift) {
    parts.push(keyNames.shift);
  }
  parts.push(key);
  return parts.join("+");
}

/**
 * The `event.key` value that WAI-ARIA names for a key. The spec writes the space bar as
 * `Space`, and every other key as its `KeyboardEvent.key` value.
 */
function ariaKeyName(key: ShortcutKey): string {
  switch (key.kind) {
    case "named":
      return key.key === " " ? "Space" : key.key;
    case "letter":
      return key.letter;
    case "character":
      return key.character;
  }
}

/**
 * Formats a binding as one WAI-ARIA `aria-keyshortcuts` token: `Meta+Shift+Z` on macOS and
 * `Control+Shift+Z` on Windows. The modifiers come first, and the key comes last.
 *
 * The token is not localized: the attribute takes the `KeyboardEvent` names.
 */
export function formatAriaKeyShortcut(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
): string {
  const parts: string[] = [];
  if (binding.modifiers.includes("primary")) {
    parts.push(platform === "macos" ? "Meta" : "Control");
  }
  if (binding.modifiers.includes("shift")) {
    parts.push("Shift");
  }
  parts.push(ariaKeyName(binding.key));
  return parts.join("+");
}

/**
 * The named key that a label shows for an action with more than one binding, when the first
 * binding of the table is not the right one for the platform.
 *
 * The key labelled `delete` on a Mac keyboard sends `Backspace`. A Mac laptop has no forward
 * delete key, so macOS shows `⌫`, the key the user sees. Windows shows `Delete`, the first
 * binding of the table.
 */
const CANONICAL_NAMED_KEY: {
  readonly [A in ShortcutAction]?: {
    readonly [P in ShortcutPlatform]?: ShortcutNamedKey;
  };
} = {
  deleteSegment: { macos: "Backspace" },
};

function isCanonical(binding: ShortcutBinding, platform: ShortcutPlatform): boolean {
  const preferred = CANONICAL_NAMED_KEY[binding.action]?.[platform];
  return (
    preferred !== undefined &&
    binding.key.kind === "named" &&
    binding.key.key === preferred
  );
}

/**
 * Every binding of the action on the platform, with the canonical binding first and the
 * others in table order. Empty when the action has no binding on the platform.
 *
 * The canonical binding is the first binding of the table, except where
 * `CANONICAL_NAMED_KEY` names another. Redo therefore shows `Ctrl+Shift+Z` on Windows and not
 * `Ctrl+Y`, and Delete Segment shows `⌫` on macOS.
 */
export function shortcutsFor(
  action: ShortcutAction,
  platform: ShortcutPlatform,
): readonly ShortcutBinding[] {
  const bindings = SHORTCUT_BINDINGS.filter(
    (binding) =>
      binding.action === action && bindingAppliesToPlatform(binding, platform),
  );
  const canonical = bindings.findIndex((binding) => isCanonical(binding, platform));
  if (canonical <= 0) {
    return bindings;
  }
  return [
    bindings[canonical],
    ...bindings.slice(0, canonical),
    ...bindings.slice(canonical + 1),
  ];
}

/**
 * The binding that a label names for the action on the platform, or null when the action
 * has no binding there.
 */
export function shortcutFor(
  action: ShortcutAction,
  platform: ShortcutPlatform,
): ShortcutBinding | null {
  return shortcutsFor(action, platform)[0] ?? null;
}

/**
 * The `aria-keyshortcuts` value of a control that performs the action: every binding of the
 * action on the platform, canonical first, separated by spaces as the attribute requires.
 * Undefined when the action has no binding, so React leaves the attribute out.
 */
export function ariaKeyShortcutsFor(
  action: ShortcutAction,
  platform: ShortcutPlatform,
): string | undefined {
  const bindings = shortcutsFor(action, platform);
  if (bindings.length === 0) {
    return undefined;
  }
  return bindings.map((binding) => formatAriaKeyShortcut(binding, platform)).join(" ");
}
