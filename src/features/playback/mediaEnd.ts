/**
 * The rule for "the element is at its end" (ADR 074).
 */

import type { PlaybackMediaElement } from "./types";

/**
 * True when the element is at the end of the media: it reports `ended`, and it reports no seek.
 *
 * A seek that runs has no settled position. WebKit reports `ended` from the target of a pending
 * seek when that target is the end, as in the scrub from the media controls of the system, which
 * also pauses the element. Such an element is not at its end until the seek ends, and its pause is
 * a pause from the system. The playback store reads this rule for the end of the media inside a
 * segment playback, and the preview reads it for an `ended` event of its element.
 */
export function isAtMediaEnd(
  element: Pick<PlaybackMediaElement, "ended" | "seeking">,
): boolean {
  return element.ended === true && element.seeking !== true;
}
