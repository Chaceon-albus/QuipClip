/**
 * The click that adds a segment to the selection or removes it (ADR 045).
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { ShortcutPlatform } from "@/components/layout/shortcutBindings";

/** The part of a click or a press that `isSelectionTogglePress` reads. */
export interface SegmentSelectionPress {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * True for a click that adds a segment to the selection or removes it: the primary button with
 * the primary modifier and no other modifier. The primary modifier is `Cmd` on macOS and `Ctrl`
 * on Windows, as in the key table (ADR 026), and as in the file lists of both systems.
 *
 * On macOS a Control click opens the context menu (`isContextMenuPress`), so it never toggles.
 * The match is exact, as for the key table: `Shift` or `Alt` with the modifier is a plain click.
 * Such a press does not start a trim, because the click that follows it only toggles.
 */
export function isSelectionTogglePress(
  press: SegmentSelectionPress,
  platform: ShortcutPlatform,
): boolean {
  if (press.button !== 0 || press.altKey || press.shiftKey) {
    return false;
  }
  return platform === "macos"
    ? press.metaKey && !press.ctrlKey
    : press.ctrlKey && !press.metaKey;
}
