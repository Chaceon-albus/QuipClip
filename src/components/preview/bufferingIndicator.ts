/**
 * Pure rules for the buffering spinner of the preview. The timing is the delayed indicator of
 * `@/components/common/delayedIndicator`.
 */

import type { DelayedIndicatorEvent } from "@/components/common/delayedIndicator";

/**
 * How long the video element must wait for data, with no `playing`, `canplay` or `seeked` in
 * between, before the preview shows its buffering spinner.
 */
export const PREVIEW_BUFFERING_DELAY_MS = 400;

/** The events of the video element that the buffering spinner follows. */
export const BUFFERING_ELEMENT_EVENTS = [
  "waiting",
  "playing",
  "canplay",
  "seeked",
  "pause",
  "ended",
  "emptied",
] as const;

export type BufferingElementEvent = (typeof BUFFERING_ELEMENT_EVENTS)[number];

/**
 * The input that an element event gives the buffering spinner.
 *
 * `waiting` means that playback stopped because the next frame is not available. Each other
 * event means that data arrived, that a seek completed, that playback stopped by request or
 * at the end, or that the element dropped its media (`emptied`), so the element no longer
 * waits for data.
 */
export function bufferingIndicatorEvent(
  type: BufferingElementEvent,
): DelayedIndicatorEvent {
  return type === "waiting" ? "begin" : "end";
}
