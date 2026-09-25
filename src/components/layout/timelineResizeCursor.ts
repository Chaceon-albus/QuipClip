/**
 * The resize cursor of a drag of the timeline splitter.
 *
 * While the splitter above the timeline is dragged (`TimelineArea`), the document root carries
 * `data-resizing-timeline`, and a rule in `globals.css` shows the `ns-resize` cursor on every
 * element. The cursor therefore stays the same when the pointer leaves the thin splitter during
 * the drag. This is the pattern of the scrub cursor (`scrubCursor.ts`), with its own attribute,
 * so a hold of one cursor never ends the other.
 *
 * The drag takes a hold when it starts, and it runs the release when it ends, by every path:
 * the release, a cancel, a lost capture and an unmount. Holds nest, so the attribute stays
 * until the last hold ends, and a release that already ran does nothing.
 *
 * The module has no React dependency. The root is read through a callback, so the tests need
 * no document.
 */

/** The attribute on the document root that the cursor rule in `globals.css` reads. */
export const RESIZING_TIMELINE_ATTRIBUTE = "data-resizing-timeline";

/** The part of the document root that the cursor writes. `document.documentElement` has it. */
export interface TimelineResizeCursorRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Ends one hold. A second call does nothing. */
export type ReleaseTimelineResizeCursor = () => void;

/** Shows the resize cursor until the returned release runs. */
export type HoldTimelineResizeCursor = () => ReleaseTimelineResizeCursor;

/**
 * Creates a cursor that writes the attribute to the root that `getRoot` returns.
 *
 * The root is read at each write. A null root, as in a test run in node, makes the write do
 * nothing.
 */
export function createTimelineResizeCursor(
  getRoot: () => TimelineResizeCursorRoot | null,
): HoldTimelineResizeCursor {
  let holds = 0;

  return () => {
    holds += 1;
    if (holds === 1) {
      getRoot()?.setAttribute(RESIZING_TIMELINE_ATTRIBUTE, "");
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      holds -= 1;
      if (holds === 0) {
        getRoot()?.removeAttribute(RESIZING_TIMELINE_ATTRIBUTE);
      }
    };
  };
}

function getDocumentRoot(): TimelineResizeCursorRoot | null {
  if (typeof document !== "undefined" && document.documentElement) {
    return document.documentElement;
  }
  return null;
}

/** Shows the resize cursor on the document until the returned release runs. */
export const holdTimelineResizeCursor: HoldTimelineResizeCursor =
  createTimelineResizeCursor(getDocumentRoot);
