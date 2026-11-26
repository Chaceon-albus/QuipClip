/**
 * The preview section as a focus target outside the preview pane.
 *
 * The section can take the focus with no Tab stop (`tabIndex={-1}`), and the pane already moves
 * the focus there when a notice that held the focus leaves (`returnFocusToPreview`). It stays in
 * the tree for the whole session, so it is the destination when a control that held the focus
 * goes during a recalibration of the preview (ADR 063): the status bar item and the badge beside
 * the timecode. The status bar is outside the pane, so it finds the section by this attribute,
 * as the window layers find the modal layer by a selector.
 */

/** The attribute that marks the preview section. The pane sets it with an empty value. */
export const PREVIEW_REGION_ATTRIBUTE = "data-preview-region";

/** The selector of the preview section. */
export const PREVIEW_REGION_SELECTOR = `[${PREVIEW_REGION_ATTRIBUTE}]`;

/** The member of a document that `findPreviewRegion` reads, so a test can pass a fake. */
export interface PreviewRegionRoot {
  querySelector: (selector: string) => Element | null;
}

/** The preview section, or null when the pane is not in the document. */
export function findPreviewRegion(
  root: PreviewRegionRoot = document,
): HTMLElement | null {
  return root.querySelector(PREVIEW_REGION_SELECTOR) as HTMLElement | null;
}
