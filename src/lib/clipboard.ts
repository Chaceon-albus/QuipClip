/**
 * Copies text to the system clipboard through the web clipboard API.
 *
 * The web view can refuse the write: the API can be absent, or the call can reject when the
 * document does not have the focus or the permission. The caller then needs a second way to
 * give the user the text, so the result is an outcome and never a thrown error.
 */

/** How long a "Copied" confirmation stays on a copy button, in milliseconds. */
export const COPIED_FEEDBACK_MS = 2000;

/** The result of `copyText`. */
export type CopyOutcome = "copied" | "failed";

/** The part of the `Clipboard` interface that `copyText` uses, so a test can pass a fake. */
export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

/**
 * Returns the clipboard of the web view, or null when it has none. `navigator.clipboard` is
 * absent outside a secure context, although its type says that it is always present.
 */
function defaultClipboard(): ClipboardWriter | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as { clipboard?: ClipboardWriter }).clipboard ?? null;
}

/**
 * Writes `text` to the clipboard. Answers `"copied"` when the write succeeded, and
 * `"failed"` when no clipboard exists or the write threw or rejected.
 *
 * `clipboard` defaults to the clipboard of the web view. Null means that no clipboard
 * exists.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | null = defaultClipboard(),
): Promise<CopyOutcome> {
  if (clipboard === null || typeof clipboard.writeText !== "function") {
    return "failed";
  }
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
