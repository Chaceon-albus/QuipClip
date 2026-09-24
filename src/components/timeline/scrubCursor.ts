/**
 * The resize cursor of a drag on the timeline.
 *
 * While a playhead scrub (ADR 022) runs, the document root carries `data-scrubbing`, and a
 * rule in `globals.css` shows the `ew-resize` cursor on every element. The cursor therefore
 * stays the same when the pointer leaves the timeline during the drag, as it does in a desktop
 * editor. Without the rule, the cursor would change to the one of each element under the
 * pointer.
 *
 * The scrub takes a hold when the pointer passes the drag threshold, so a click keeps the
 * cursor of the element under the pointer. It runs the release that the hold returns when the
 * gesture ends, by every path: the release, a cancel, a lost capture, a window blur and an
 * unmount. Holds nest, so the attribute stays until the last hold ends, and a release that
 * already ran does nothing.
 *
 * The module has no React dependency. The root is read through a callback, so the tests need
 * no document.
 */

/** The attribute on the document root that the cursor rule in `globals.css` reads. */
export const SCRUBBING_ATTRIBUTE = "data-scrubbing";

/** The part of the document root that the cursor writes. `document.documentElement` has it. */
export interface ScrubCursorRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Ends one hold. A second call does nothing. */
export type ReleaseScrubCursor = () => void;

/** Shows the scrub cursor until the returned release runs. */
export type HoldScrubCursor = () => ReleaseScrubCursor;

/**
 * Creates a cursor that writes the attribute to the root that `getRoot` returns.
 *
 * The root is read at each write. A null root, as in a test run in node, makes the write do
 * nothing.
 */
export function createScrubCursor(
  getRoot: () => ScrubCursorRoot | null,
): HoldScrubCursor {
  let holds = 0;

  return () => {
    holds += 1;
    if (holds === 1) {
      getRoot()?.setAttribute(SCRUBBING_ATTRIBUTE, "");
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      holds -= 1;
      if (holds === 0) {
        getRoot()?.removeAttribute(SCRUBBING_ATTRIBUTE);
      }
    };
  };
}

function getDocumentRoot(): ScrubCursorRoot | null {
  if (typeof document !== "undefined" && document.documentElement) {
    return document.documentElement;
  }
  return null;
}

/**
 * Shows the scrub cursor on the document until the returned release runs. The playhead scrub
 * (`timelineScrub.ts`) calls it when the pointer passes the drag threshold.
 */
export const holdScrubCursor: HoldScrubCursor = createScrubCursor(getDocumentRoot);
