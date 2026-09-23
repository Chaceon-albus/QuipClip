import { useEffect, useRef, type RefObject } from "react";
import type { ImportMediaResult } from "@/features/media";
import { usePlaybackStore, type PlaybackStoreState } from "@/features/playback";
import {
  calculateFollowScrollLeft,
  calculatePausedFollow,
  calculatePendingNavigation,
  calculatePlayheadLayout,
  PLAYHEAD_FOLLOW_LEAD_FRACTION,
  TIMELINE_GUTTER_WIDTH_PX,
} from "@/features/timeline";
import type { TimelineScrubGesture } from "./timelineScrub";
import { useDisplayedPlaybackPosition } from "./useDisplayedPlaybackPosition";

const selectIsPlaying = (state: PlaybackStoreState) => state.isPlaying;

/**
 * Scrolls the timeline to a follow target, clamped to the scroll range, and keeps the mirror
 * of the scroll position truthful. The clamp reads the layout, but only when the view pages.
 */
function applyFollowScrollLeft(
  scrollEl: HTMLDivElement,
  scrollLeftRef: RefObject<number>,
  targetScrollLeft: number,
): void {
  const maxScrollLeftPx = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
  const nextScrollLeft = Math.min(targetScrollLeft, maxScrollLeftPx);

  if (scrollLeftRef.current !== nextScrollLeft) {
    scrollEl.scrollLeft = nextScrollLeft;
    scrollLeftRef.current = nextScrollLeft;
  }
}

export interface PlayheadFollowProps {
  media: ImportMediaResult | null;
  sourceId: string | null;
  totalDurationSeconds: number | null;
  isIndeterminate: boolean;
  canSeek: boolean;
  laneWidthPx: number;
  viewportWidthPx: number;
  /** The scroll container of the panel. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The panel's mirror of `scrollLeft`, which the per-frame path reads instead of the DOM. */
  scrollLeftRef: RefObject<number>;
  /** True while a pan by the user suspends the playback follow. */
  userScrolledRef: RefObject<boolean>;
  /** The pointer gesture of the panel, or null before the first pointer down. */
  gestureRef: RefObject<TimelineScrubGesture | null>;
  /** The seek target that the last request of the pointer gesture left in the store. */
  gestureSeekTargetRef: RefObject<number | null>;
}

/**
 * The follow of the playhead: the passive effects that scroll the timeline when the
 * displayed position leaves the visible window, during playback and while paused.
 *
 * TimelinePanel renders this component and owns every ref that it reads and writes. The
 * effects live in a child so that only this component, which renders nothing, runs again on
 * every presented frame, and not the whole panel. A store write that moves the playhead
 * renders this component in the same commit as the playhead layers, so each effect sees the
 * position that the playhead shows.
 *
 * React runs the effects of a child before the effects of its parent in one commit. Two
 * effects must run before the follow in the same commit, so they live here too, in their
 * old order: the scroll reset on a change of the source, and the cancel of a gesture when
 * seeking stops being possible. The follow then reads the reset scroll position and the
 * ended gesture, as it did when all of them were effects of the panel.
 */
export function PlayheadFollow({
  media,
  sourceId,
  totalDurationSeconds,
  isIndeterminate,
  canSeek,
  laneWidthPx,
  viewportWidthPx,
  scrollRef,
  scrollLeftRef,
  userScrolledRef,
  gestureRef,
  gestureSeekTargetRef,
}: PlayheadFollowProps): null {
  const isPlaying = usePlaybackStore(selectIsPlaying);
  const { elapsedSeconds: currentElapsedSeconds, seekTargetSeconds } =
    useDisplayedPlaybackPosition(
      media?.probe.videoStartPts,
      media?.probe.videoTimeBase,
    );
  const playhead = calculatePlayheadLayout(currentElapsedSeconds, totalDurationSeconds);

  // Reset scrollLeft when the active source changes. The panel resets the zoom in its own
  // effect for the same change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollLeftRef.current = 0;
    }
  }, [sourceId, scrollRef, scrollLeftRef]);

  useEffect(() => {
    if (!canSeek || isIndeterminate || !media) {
      gestureRef.current?.cancel();
    }
  }, [canSeek, isIndeterminate, media, gestureRef]);

  // Resumes follow when playback starts or resumes after a pause.
  const wasPlayingRef = useRef<boolean>(isPlaying);
  useEffect(() => {
    if (isPlaying && !wasPlayingRef.current) {
      userScrolledRef.current = false;
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying, userScrolledRef]);

  // Follow the playhead during playback when it leaves the visible window.
  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    const scrollEl = scrollRef.current;
    if (!scrollEl || viewportWidthPx <= 0) {
      return;
    }

    const targetScrollLeft = calculateFollowScrollLeft(
      playhead.percent,
      laneWidthPx,
      TIMELINE_GUTTER_WIDTH_PX,
      scrollLeftRef.current,
      viewportWidthPx,
      PLAYHEAD_FOLLOW_LEAD_FRACTION,
    );

    if (targetScrollLeft === null) {
      // Visible. Nothing to do, and the user's view has caught up with playback, so a
      // suspension from an earlier pan is over.
      userScrolledRef.current = false;
      return;
    }

    if (userScrolledRef.current) {
      // Outside the window, but the user put the view where it is. Leave it alone.
      return;
    }

    applyFollowScrollLeft(scrollEl, scrollLeftRef, targetScrollLeft);
  }, [
    isPlaying,
    laneWidthPx,
    playhead.percent,
    viewportWidthPx,
    scrollRef,
    scrollLeftRef,
    userScrolledRef,
  ]);

  // The displayed playhead position, in seconds, at the last run of the paused follow below.
  // That follow acts only when this position changes. A zoom, a resize or a change of the
  // source extent changes the geometry or the percent, and not this value, so none of them
  // moves the view.
  const lastElapsedSecondsRef = useRef<number>(currentElapsedSeconds);

  // Follow the playhead while paused, when a navigation such as a frame step moves it out of
  // the visible window. calculatePausedFollow states the conditions. A navigation is a
  // deliberate move of the playhead, so it also ends a suspension from an earlier pan. A pan
  // with no navigation changes no position, so this effect never undoes it.
  useEffect(() => {
    const previousElapsedSeconds = lastElapsedSecondsRef.current;
    lastElapsedSecondsRef.current = currentElapsedSeconds;

    const pending = calculatePendingNavigation(
      seekTargetSeconds,
      gestureSeekTargetRef.current,
    );
    gestureSeekTargetRef.current = pending.nextRecordedTarget;

    if (isPlaying) {
      // The playback follow above owns the view.
      return;
    }

    const scrollEl = scrollRef.current;
    if (!scrollEl || viewportWidthPx <= 0) {
      return;
    }

    const decision = calculatePausedFollow({
      playheadPercent: playhead.percent,
      elapsedSeconds: currentElapsedSeconds,
      previousElapsedSeconds,
      isNavigationPending: pending.isNavigationPending,
      isGestureActive: gestureRef.current?.isActive() === true,
      laneWidthPx,
      laneLeftOffsetPx: TIMELINE_GUTTER_WIDTH_PX,
      scrollLeftPx: scrollLeftRef.current,
      viewportWidthPx,
      leadFraction: PLAYHEAD_FOLLOW_LEAD_FRACTION,
    });

    if (!decision.isNavigation) {
      return;
    }

    userScrolledRef.current = false;
    if (decision.scrollLeftPx !== null) {
      applyFollowScrollLeft(scrollEl, scrollLeftRef, decision.scrollLeftPx);
    }
  }, [
    currentElapsedSeconds,
    isPlaying,
    laneWidthPx,
    playhead.percent,
    seekTargetSeconds,
    viewportWidthPx,
    scrollRef,
    scrollLeftRef,
    userScrolledRef,
    gestureRef,
    gestureSeekTargetRef,
  ]);

  return null;
}
