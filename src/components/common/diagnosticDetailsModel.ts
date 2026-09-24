/**
 * Pure rules for `DiagnosticDetails`: the feedback that a Copy click leaves, how long it
 * stays, and the hint that names the copy shortcut of the platform (⌘C on macOS, Ctrl+C
 * elsewhere).
 *
 * The module has no React and no document, so the tests need neither.
 */

import { COPIED_FEEDBACK_MS, type CopyOutcome } from "@/lib/clipboard";

/**
 * The time from the click that empties the live region to the moment the result goes into
 * it, in milliseconds. A screen reader speaks a region only when its text changes, so a
 * result that repeats the last one needs the empty state between the two. The gap is long
 * enough for a screen reader to register the empty region, and too short for a user to
 * notice.
 */
export const ANNOUNCE_GAP_MS = 100;

/**
 * What the last Copy click left.
 *
 * - `copied`: the clipboard took the text.
 * - `selected`: the clipboard refused the write, so the text is selected instead, and the
 *   user copies it with the keyboard shortcut.
 */
export type CopyFeedback = "copied" | "selected";

/** Maps the outcome of `copyText` to the feedback that the click leaves. */
export function copyFeedbackOf(outcome: CopyOutcome): CopyFeedback {
  return outcome === "copied" ? "copied" : "selected";
}

/**
 * How long the feedback stays, in milliseconds, or null when it stays until the next click.
 *
 * "Copied" is a confirmation, so it goes after `COPIED_FEEDBACK_MS`. The hint after a
 * refused write is an instruction, so it stays while the user follows it.
 */
export function copyFeedbackDurationMs(feedback: CopyFeedback): number | null {
  return feedback === "copied" ? COPIED_FEEDBACK_MS : null;
}

/**
 * The catalog key of the hint that follows a refused write. Every platform that is not
 * macOS takes the Windows key, the same as the title bar.
 */
export function selectedHintKey(
  isMac: boolean,
): "common.diagnostic.selectedMac" | "common.diagnostic.selectedWindows" {
  return isMac ? "common.diagnostic.selectedMac" : "common.diagnostic.selectedWindows";
}
