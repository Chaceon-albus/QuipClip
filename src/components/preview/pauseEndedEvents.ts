/**
 * The dispatch of the `pause` and `ended` events of the preview element (ADR 074). Both read the
 * one rule for an element at its end (isAtMediaEnd).
 */

import { isAtMediaEnd, type PlaybackMediaElement } from "@/features/playback";

/** The consumers of a `pause` event of the preview element. */
export interface PauseEventConsumers {
  /**
   * The sequence playback (`SequencePlayback.notePause`), with true when the element is at its
   * end.
   */
  readonly notePause: (atEnd: boolean) => void;
  /** The playback store (`syncPause`), for the element of the event. */
  readonly syncPause: () => void;
}

/**
 * Dispatches a `pause` event of the element that the preview accepts events of. The preview tests
 * that first: an element that a recalibration retired tells nobody (ADR 063).
 *
 * The sequence playback hears first whether the element paused at its end (isAtMediaEnd), before
 * the playback store syncs the pause and ends the playing state (ADR 052). An element that reports
 * `ended` during a seek, as in the scrub of the system in WebKit, did not pause at its end, so its
 * pause does not continue a play on the next clip.
 */
export function dispatchPauseEvent(
  element: Pick<PlaybackMediaElement, "ended" | "seeking">,
  consumers: PauseEventConsumers,
): void {
  consumers.notePause(isAtMediaEnd(element));
  consumers.syncPause();
}

/** The consumers of an `ended` event of the preview element. */
export interface EndedEventConsumers {
  /**
   * The sequence playback (`SequencePlayback.handleEnded`). True when playback goes on at the next
   * clip, and the end is then no end of the playback.
   */
  readonly handleEnded: () => boolean;
  /** The playback store (`syncEnded`), for the element of the event. */
  readonly syncEnded: () => void;
  /**
   * The sequence playback (`SequencePlayback.forgetPauseAtEnd`). It tells the sequence playback
   * that the preview dropped the event, so the notes of the pause before it go.
   */
  readonly dropEnded: () => void;
}

/**
 * Dispatches an `ended` event of the element that the preview accepts events of. The preview
 * tests that first: an element that a recalibration retired tells nobody (ADR 063).
 *
 * An event of an element at its end (isAtMediaEnd) goes to the sequence playback first, and to
 * the playback store only when the sequence playback does not go on at the next clip (ADR 052).
 *
 * Every other event is late, and neither of them reads it. It comes from an earlier end that a
 * later action left: a seek, or the seek back of a segment playback that the playback store made
 * at the `pause` event of that end. It can also come during a seek whose target is the end. Such
 * an event must not continue a play on the next clip of the sequence, or end the play session of
 * a playback that started after that end. The sequence playback hears that the event was dropped,
 * so that the notes of the pause before it do not serve a later `ended` event.
 */
export function dispatchEndedEvent(
  element: Pick<PlaybackMediaElement, "ended" | "seeking">,
  consumers: EndedEventConsumers,
): void {
  if (!isAtMediaEnd(element)) {
    consumers.dropEnded();
    return;
  }
  if (!consumers.handleEnded()) {
    consumers.syncEnded();
  }
}
