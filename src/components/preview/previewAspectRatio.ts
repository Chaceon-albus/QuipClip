/**
 * Pure helpers for the aspect ratio of the preview frame.
 *
 * The frame takes the width-to-height ratio of the displayed picture, so the picture fills
 * it. The pane writes the ratio to the `--preview-ar` custom property, and the
 * `preview-frame-fit` utility in `globals.css` fits the frame into the preview area. The fit
 * is CSS only, so a resize of the window runs no script.
 *
 * The ratio comes from `videoWidth` and `videoHeight` of the element. They are the size of
 * the displayed picture, with the rotation and the pixel aspect ratio of the source already
 * applied, so the pane does not read the probe for them.
 */

import type { CSSProperties } from "react";

/**
 * The ratio of a frame that shows no picture: the empty state, the loading state, the
 * import-error view, the decode-failure panel, and a source whose element has not reported a
 * picture size. It is the 16:9 of the empty-state placeholder.
 */
export const DEFAULT_PREVIEW_ASPECT_RATIO = 16 / 9;

/**
 * The narrowest and the widest frame. They keep a frame of a freak picture size from
 * collapsing to a line. A picture outside the range shows inside the nearest limit, and
 * `object-fit: contain` on the element adds the bars.
 */
export const MIN_PREVIEW_ASPECT_RATIO = 1 / 4;
export const MAX_PREVIEW_ASPECT_RATIO = 4;

/**
 * Returns the width-to-height ratio of a picture size that the element reports, or null
 * when the size is not a picture: a zero, negative or non-finite width or height. An element
 * reports 0 by 0 before its metadata loads, and a web view that decodes no picture of the
 * source reports a width of 0 (ADR 003).
 *
 * @param width `videoWidth` of the element.
 * @param height `videoHeight` of the element.
 */
export function readPictureAspectRatio(width: number, height: number): number | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const ratio = width / height;
  // Two finite positive numbers can still divide to 0 or to infinity at the limits of the
  // float range.
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * What the pane keeps for the frame ratio: the picture ratio that the video element last
 * reported, or null while it reported no picture size.
 */
export interface PreviewFrameRatioState {
  readonly pictureRatio: number | null;
}

/** The state of a pane with no source. */
export const INITIAL_PREVIEW_FRAME_RATIO_STATE: PreviewFrameRatioState = {
  pictureRatio: null,
};

/**
 * An input of the frame ratio:
 *
 * - `mediaChanged`: the media store holds a new media object, or no media. `hasMedia` is
 *   false when it holds none.
 * - `pictureSize`: the video element reported its picture size, at `loadedmetadata` or at a
 *   `resize`.
 */
export type PreviewFrameRatioEvent =
  | { readonly type: "mediaChanged"; readonly hasMedia: boolean }
  | { readonly type: "pictureSize"; readonly width: number; readonly height: number };

/**
 * Returns the frame ratio state after an event.
 *
 * With no media, the state resets, so the next source starts from the default and not from
 * the ratio of the closed one. A source that replaces another keeps the previous ratio until
 * its own element reports a size, so a change between two portrait sources does not flash a
 * 16:9 frame. A reported size that is not a picture size (`readPictureAspectRatio`) clears
 * the ratio, and the frame goes back to the default.
 *
 * The state object stays the same when the ratio does not change, so React renders again
 * only for a new ratio.
 */
export function stepPreviewFrameRatio(
  state: PreviewFrameRatioState,
  event: PreviewFrameRatioEvent,
): PreviewFrameRatioState {
  let pictureRatio: number | null;
  switch (event.type) {
    case "mediaChanged":
      pictureRatio = event.hasMedia ? state.pictureRatio : null;
      break;
    case "pictureSize":
      pictureRatio = readPictureAspectRatio(event.width, event.height);
      break;
  }
  return pictureRatio === state.pictureRatio ? state : { pictureRatio };
}

/**
 * Returns the ratio of the preview frame: the picture ratio, within the limits, while the
 * frame holds the video element, and the 16:9 default otherwise. The frame holds the element
 * while a source is open and the decode-failure panel does not replace the element.
 *
 * @param state The frame ratio state of the pane.
 * @param view `hasMedia`: a source is open. `decodeFailed`: the decode-failure panel
 *   replaces the element.
 */
export function previewFrameAspectRatio(
  state: PreviewFrameRatioState,
  view: { readonly hasMedia: boolean; readonly decodeFailed: boolean },
): number {
  const { pictureRatio } = state;
  if (
    !view.hasMedia ||
    view.decodeFailed ||
    pictureRatio === null ||
    !Number.isFinite(pictureRatio)
  ) {
    return DEFAULT_PREVIEW_ASPECT_RATIO;
  }
  return Math.min(
    MAX_PREVIEW_ASPECT_RATIO,
    Math.max(MIN_PREVIEW_ASPECT_RATIO, pictureRatio),
  );
}

/** The inline style of the preview frame. The ratio is a custom property. */
export type PreviewFrameStyle = CSSProperties & { "--preview-ar": string };

/**
 * Returns the inline style that gives the frame its ratio. The value is a plain number,
 * because the fit multiplies and divides lengths by it.
 *
 * @param aspectRatio The ratio of `previewFrameAspectRatio`.
 */
export function previewFrameStyle(aspectRatio: number): PreviewFrameStyle {
  return { "--preview-ar": String(aspectRatio) };
}
