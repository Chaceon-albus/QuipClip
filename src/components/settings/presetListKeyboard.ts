/**
 * Pure rules for the keys of the preset list.
 *
 * The list is a single-select `listbox` with a roving tab index: the whole list is one Tab
 * stop, and the selection follows the focus. The list component reads the key press, and
 * `decidePresetListKey` says what to do with it. The rules have no DOM and no React, so the
 * tests need no document.
 *
 * The window keyboard layer (ADR 021, ADR 026) does not act on these keys. It does nothing
 * while a modal dialog is open, and the list is inside the settings dialog. It also does
 * nothing for a target inside a `listbox` or an `option`.
 */

/** The fields of a key press that the rules read. `KeyboardEvent` satisfies it. */
export interface PresetListKeyPress {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  /** Legacy code. 229 marks a key that an input method took. */
  readonly keyCode?: number;
}

/** The state of the list that the rules read. */
export interface PresetListKeyState {
  /** The ids of the rows, in list order. */
  readonly presetIds: readonly string[];
  /** The row that holds the focus. The key press comes from it. */
  readonly focusedId: string;
  /** True when a delete can start now. See `canStartPresetDelete`. */
  readonly canDelete: boolean;
}

/**
 * What the list does with a key press.
 *
 * - `ignore`: the key is not a key of the list. The event continues unchanged.
 * - `consume`: the key is a key of the list, and it has nothing to do now. The list cancels the
 *   default action, so an arrow key at the end of the list does not scroll the pane, and
 *   Backspace does nothing else.
 * - `select`: select the row `id` and move the focus to it. The unsaved-draft prompt of the
 *   section still applies. The list cancels the default action.
 * - `editName`: move the focus to the name field of the editor. The list cancels the default
 *   action.
 * - `delete`: ask the user to confirm the delete of the row `id`. The list cancels the default
 *   action.
 */
export type PresetListKeyDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "consume" }
  | { readonly kind: "select"; readonly id: string }
  | { readonly kind: "editName" }
  | { readonly kind: "delete"; readonly id: string };

const IGNORE: PresetListKeyDecision = { kind: "ignore" };
const CONSUME: PresetListKeyDecision = { kind: "consume" };

/** Selects `id`, or consumes the key when `id` is the focused row or no row. */
function selectOrConsume(
  id: string | undefined,
  focusedId: string,
): PresetListKeyDecision {
  return id === undefined || id === focusedId ? CONSUME : { kind: "select", id };
}

/**
 * Decides what a key press on a row of the preset list does.
 *
 * - `ArrowDown` and `ArrowUp` move to the next and the previous row. The list does not wrap,
 *   as a macOS list does not. A held arrow key moves once for each repeat.
 * - `Home` and `End` move to the first and the last row.
 * - `Enter` and `F2` move the focus to the name field of the editor. `Enter` is the rename key
 *   of the macOS Finder and the key that opens an item on Windows. `F2` is the rename key of
 *   Windows. Both lead to the same place, and neither key has another meaning in the list.
 * - `Delete` and `Backspace` start the delete of the row, with its confirmation, when a delete
 *   can start. The Delete key of a Mac keyboard sends `Backspace`.
 * - `Space` does nothing, because the selection already follows the focus. The list consumes
 *   it, so the pane does not scroll.
 *
 * A key with `Ctrl`, `Cmd`, `Alt` or `Shift` is not a key of the list, so the system and the
 * web view keep it. A key that an input method took is not a key of the list either. A repeat
 * of `Enter`, `F2`, `Delete` or `Backspace` does nothing: the first press already moved the
 * focus or opened the confirmation.
 */
export function decidePresetListKey(
  press: PresetListKeyPress,
  state: PresetListKeyState,
): PresetListKeyDecision {
  if (press.isComposing || press.keyCode === 229) {
    return IGNORE;
  }
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) {
    return IGNORE;
  }

  const { presetIds, focusedId } = state;
  const index = presetIds.indexOf(focusedId);

  switch (press.key) {
    case "ArrowDown":
      // A focused row that is not in the list, such as a row that a write just removed,
      // moves to the first row.
      return selectOrConsume(
        index === -1 ? presetIds[0] : presetIds[index + 1],
        focusedId,
      );
    case "ArrowUp":
      return selectOrConsume(
        index === -1 ? presetIds[presetIds.length - 1] : presetIds[index - 1],
        focusedId,
      );
    case "Home":
      return selectOrConsume(presetIds[0], focusedId);
    case "End":
      return selectOrConsume(presetIds[presetIds.length - 1], focusedId);
    case "Enter":
    case "F2":
      return press.repeat ? CONSUME : { kind: "editName" };
    case "Delete":
    case "Backspace":
      if (press.repeat || !state.canDelete || index === -1) {
        return CONSUME;
      }
      return { kind: "delete", id: focusedId };
    case " ":
      return CONSUME;
    default:
      return IGNORE;
  }
}
