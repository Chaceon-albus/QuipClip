/**
 * The pure model of the Rename Segment dialog (ADR 065): the text that the field holds when the
 * dialog opens, the keys of the field, and what a confirm does.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import { canTakeFocus, type LandingFocusTarget } from "@/components/common/focusTarget";
import {
  normalizeSegmentNameInput,
  removeSegmentNameForbiddenCharacters,
  SEGMENT_NAME_MAX_LENGTH,
} from "@/features/timeline/segmentName";
import type { SequenceSegment } from "@/types/project";

/**
 * The attribute of the bar of a segment that names its id (`SegmentLayer`). The dialog finds the
 * bar of its segment by it, to give the bar the focus when the element that opened the dialog is
 * gone.
 */
export const SEGMENT_ID_ATTRIBUTE = "data-segment-id";

/**
 * The seek surface of the timeline, the last place for the focus after a dialog of the timeline
 * closes. It keeps a `tabIndex` of -1 while seeking is off, so a script can always focus it.
 */
export const TIMELINE_SEEK_SURFACE_SELECTOR = '[data-timeline-track] [role="slider"]';

/** The text that the field holds when the dialog opens: the name, or empty for no name. */
export function initialSegmentRenameText(
  segments: readonly Pick<SequenceSegment, "id" | "name">[],
  segmentId: string,
): string {
  return segments.find((segment) => segment.id === segmentId)?.name ?? "";
}

/** The part of a key press that `belongsToInputMethod` reads. */
export interface SegmentRenameKeyPress {
  readonly key: string;
  readonly isComposing: boolean;
  /** Legacy code. 229 marks a key that an input method took. */
  readonly keyCode: number;
}

/**
 * True while the input method composes text: the key belongs to it, and the dialog does not act
 * on Enter or Escape (ADR 065). Both tests are needed. `isComposing` is false on the first key
 * of a composition in several engines, and WebKit sends the Enter that ends a composition with
 * `isComposing` false and `keyCode` 229. The window keyboard layer reads the same two values.
 */
export function belongsToInputMethod(
  press: Pick<SegmentRenameKeyPress, "isComposing" | "keyCode">,
): boolean {
  return press.isComposing || press.keyCode === 229;
}

/** What a key press in the field does. */
export type SegmentRenameKeyAction = "confirm" | "cancel" | null;

/**
 * The action of a key press in the field: Enter confirms and Escape cancels, except while the
 * input method composes text. Every other key edits the text.
 *
 * The Radix dialog takes Escape in its own listener before the field sees it. The dialog passes
 * that key press here too (`onEscapeKeyDown`), and keeps the dialog open when this returns null.
 */
export function resolveSegmentRenameKey(
  press: SegmentRenameKeyPress,
): SegmentRenameKeyAction {
  if (belongsToInputMethod(press)) {
    return null;
  }
  if (press.key === "Enter") {
    return "confirm";
  }
  if (press.key === "Escape") {
    return "cancel";
  }
  return null;
}

/**
 * The state of the text: a message for a text that is too long, or none.
 *
 * - `ok`: the confirm can apply the text.
 * - `tooLong`: the confirm does nothing, and the dialog shows why. `length` is the number of
 *   characters after the two steps of `normalizeSegmentNameInput`, and `max` the limit.
 */
export type SegmentRenameTextState =
  | { readonly kind: "ok" }
  | { readonly kind: "tooLong"; readonly length: number; readonly max: number };

/** The state of the text of the field (`SegmentRenameTextState`). */
export function readSegmentRenameText(text: string): SegmentRenameTextState {
  const input = normalizeSegmentNameInput(text);
  return input.kind === "tooLong"
    ? { kind: "tooLong", length: input.length, max: SEGMENT_NAME_MAX_LENGTH }
    : { kind: "ok" };
}

/** The open state of the dialog store that a confirm reads (`segmentRenameDialogStore`). */
export interface SegmentRenameDialogOpenState {
  readonly segmentId: string | null;
  readonly openCount: number;
}

/**
 * True when a confirm of the content of one open may run: the dialog store is open, and it is
 * still the open that mounted this content (`openCount`). Radix keeps the content of a closing
 * dialog mounted during its exit animation, with its field focused, so an Enter after Escape
 * reaches a content whose dialog is already closed. That confirm must not write the discarded
 * text (ADR 065). The caller reads the store when the confirm runs, never from a closure of an
 * earlier render.
 *
 * @param dialog The dialog store now.
 * @param openCount The `openCount` of the open that mounted the content.
 */
export function canRunSegmentRenameConfirm(
  dialog: SegmentRenameDialogOpenState,
  openCount: number,
): boolean {
  return dialog.segmentId !== null && dialog.openCount === openCount;
}

/** The facts that a confirm reads, all read when the confirm runs. */
export interface SegmentRenameConfirmInput {
  /** The text of the field. */
  readonly text: string;
  /** The id of the segment that the dialog names. */
  readonly segmentId: string;
  /** The ids of the segments on the timeline now. */
  readonly liveSegmentIds: ReadonlySet<string>;
  /** The dialog store now. */
  readonly dialog: SegmentRenameDialogOpenState;
  /** The `openCount` of the open that mounted the content. */
  readonly openCount: number;
  /**
   * True while an edge press is armed or a drag trims an edge (`segmentTrimSession.isLocked`).
   * Rename Segment does nothing then, as the other edit actions (ADR 030, ADR 065).
   */
  readonly isTrimLocked: boolean;
}

/** What a confirm does. */
export type SegmentRenameConfirm =
  /** The dialog of this content is closed or closing: nothing happens. */
  | { readonly kind: "ignore" }
  /** The text is too long, or a trim holds the edit lock: nothing happens, and the dialog stays. */
  | { readonly kind: "refuse" }
  /** No segment has the id of the dialog: the dialog closes and changes nothing. */
  | { readonly kind: "close" }
  /** The dialog gives the segment the name, or removes its name for null, and closes. */
  | {
      readonly kind: "rename";
      readonly segmentId: string;
      readonly name: string | null;
    };

/**
 * The confirm of the dialog, by the button or by Enter (ADR 065).
 *
 * A confirm of a dialog that is closed or closing does nothing (`canRunSegmentRenameConfirm`).
 * The text loses each character that a name cannot have, and then the `White_Space` characters at
 * its two ends (`normalizeSegmentNameInput`). Empty text removes the name. Text that is then too
 * long refuses the confirm, and so does an armed edge press or a running trim. When no segment on
 * the timeline has the id of the dialog, the confirm changes nothing. A segment that a change of
 * the clips divided keeps its id in its first part, so the name goes to that part.
 */
export function planSegmentRenameConfirm(
  input: SegmentRenameConfirmInput,
): SegmentRenameConfirm {
  if (!canRunSegmentRenameConfirm(input.dialog, input.openCount)) {
    return { kind: "ignore" };
  }
  const name = normalizeSegmentNameInput(input.text);
  if (name.kind === "tooLong" || input.isTrimLocked) {
    return { kind: "refuse" };
  }
  if (!input.liveSegmentIds.has(input.segmentId)) {
    return { kind: "close" };
  }
  return {
    kind: "rename",
    segmentId: input.segmentId,
    name: name.kind === "name" ? name.name : null,
  };
}

/** The text and the caret after a paste into the field. */
export interface SegmentRenamePaste {
  readonly text: string;
  /** The caret after the pasted text, in UTF-16 code units, as the selection of a field counts. */
  readonly caret: number;
  /**
   * False when the paste leaves the text as it was, such as `Intro` and a line break pasted over
   * the selected `Intro`. No render follows then, so the field must place the caret at once:
   * else the old selection stays, and the next key replaces the whole text.
   */
  readonly changed: boolean;
}

/**
 * Inserts pasted text at the selection of the field (ADR 065). The pasted text first loses each
 * character that a name cannot have (`removeSegmentNameForbiddenCharacters`). The dialog reads the
 * raw text of the clipboard itself: a text field turns a line break into a space before its
 * `onChange` runs, so 40 letters, a line break and 40 letters would count 81 characters, where the
 * rule of the dialog keeps 80.
 *
 * @param text The text of the field.
 * @param selectionStart The start of the selection, in UTF-16 code units.
 * @param selectionEnd The end of the selection, in UTF-16 code units.
 * @param pasted The raw text of the clipboard.
 */
export function spliceSegmentRenamePaste(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  pasted: string,
): SegmentRenamePaste {
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), text.length) : 0;
  const start = Math.min(clamp(selectionStart), clamp(selectionEnd));
  const end = Math.max(clamp(selectionStart), clamp(selectionEnd));
  const inserted = removeSegmentNameForbiddenCharacters(pasted);
  const next = text.slice(0, start) + inserted + text.slice(end);
  return { text: next, caret: start + inserted.length, changed: next !== text };
}

/** A focus target that also tells whether the focus landed on it after `focus()`. */
export type SegmentRenameFocusTarget = LandingFocusTarget;

/**
 * Gives the focus back when the dialog closes, after a confirm or a cancel (ADR 065): it tries the
 * element that held the focus when the dialog opened, then each fallback, in order, and stops at
 * the first one on which the focus really lands. A candidate that is gone, hidden or disabled is
 * not tried (`canTakeFocus`). A candidate that is still in the document can refuse the focus all
 * the same, such as a seek surface that lost its `tabIndex` when seeking stopped, so the rule
 * reads `hasFocus` after each call. The dialog has no Radix trigger, so without this rule the
 * focus falls to the body and a keyboard user loses the place.
 *
 * @param opener The element that held the focus at the open, or null when the focus rested on the
 *   body.
 * @param fallbacks The timeline targets, in the order of preference: the bar of the segment, then
 *   the seek surface, which a script can always focus.
 * @returns The candidate that took the focus, or null when none did.
 */
export function returnSegmentRenameFocus<T extends SegmentRenameFocusTarget>(
  opener: T | null,
  fallbacks: readonly (T | null)[],
): T | null {
  for (const candidate of [opener, ...fallbacks]) {
    if (!canTakeFocus(candidate)) {
      continue;
    }
    candidate.focus();
    if (candidate.hasFocus) {
      return candidate;
    }
  }
  return null;
}
