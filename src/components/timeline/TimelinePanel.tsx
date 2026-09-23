import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import {
  getGeneratedSourceId,
  getSourceRevisionKey,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import {
  getDisplayedElapsedSeconds,
  isPlaybackPositionApproximate,
  usePlaybackStore,
  type PlaybackStoreState,
  type SeekOptions,
} from "@/features/playback";
import {
  calculateAnchorRatio,
  calculateAnchoredScrollLeft,
  calculateContentWidthPx,
  calculateFollowScrollLeft,
  calculateMaxZoom,
  calculatePendingInRegionLayoutFromSeconds,
  calculatePercentFromPts,
  calculatePlayheadLayout,
  calculatePtsFromClientX,
  calculateSegmentLayout,
  calculateTimelineSecondsFromClientX,
  calculateWheelZoomFactor,
  clampTimelineZoom,
  getActiveSourceSegmentEntries,
  getTimelineDurationSeconds,
  useTimelineStore,
  PLAYHEAD_FOLLOW_LEAD_FRACTION,
  TIMELINE_GUTTER_WIDTH_PX,
  type TimelineStoreState,
} from "@/features/timeline";
import {
  calculateRulerTickStepSeconds,
  generateRulerMarkersForStep,
} from "./timelineMarkers";
import { TimelineRuler } from "./TimelineRuler";
import { createTimelineScrubGesture, type TimelineScrubGesture } from "./timelineScrub";

export interface TimelinePanelProps {
  /** Stable project source ID when project state already owns one. */
  activeSourceId?: string | null;
  /** Finite HTMLMediaElement.duration supplied by preview runtime state. */
  runtimeBrowserDurationSeconds?: number | null;
  /** Browser-time seek request used when calibrated PTS seeking is unavailable (ADR 022). */
  onApproximateSeek?: (seconds: number, options?: SeekOptions) => void;
}

const selectMedia = (state: MediaStoreState) => state.media;
const selectMediaStatus = (state: MediaStoreState) => state.status;
const selectPresentedFrame = (state: PlaybackStoreState) => state.presentedFrame;
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectApproximateBrowserTimeSeconds = (state: PlaybackStoreState) =>
  state.approximateBrowserTimeSeconds;
const selectSeekTargetSeconds = (state: PlaybackStoreState) => state.seekTargetSeconds;
const selectIsAttached = (state: PlaybackStoreState) => state.isAttached;
const selectIsReady = (state: PlaybackStoreState) => state.isReady;
const selectSeekToPts = (state: PlaybackStoreState) => state.seekToPts;
const selectIsPlaying = (state: PlaybackStoreState) => state.isPlaying;

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectPendingInPts = (state: TimelineStoreState) => state.pendingInPts;
const selectSetSource = (state: TimelineStoreState) => state.setSource;
const selectCurrentSegmentId = (state: TimelineStoreState) => state.currentSegmentId;
const selectSelectSegment = (state: TimelineStoreState) => state.selectSegment;

/**
 * Places the pending In flag to the right of the In boundary, or to the left of it when the
 * flag does not fit between the boundary and the end of the lane.
 *
 * The wrapper of the flag runs from the In boundary to the end of the lane, and it is a size
 * container. So `100cqw` is the space to the right of the boundary, and `100%` in a
 * translation is the width of the flag itself. When the flag fits, the difference is zero or
 * more, and `min` gives 0. When it does not fit, the scaled difference is a large negative
 * length, and `max` gives -100%, which puts the right edge of the flag on the boundary. The
 * factor turns a shortfall of a small fraction of a pixel into the full move, so the flag has
 * no position between the two placements. The rule compares the rendered width of the flag,
 * so it holds for a label of any length and needs no layout read in JavaScript.
 */
const PENDING_IN_FLAG_PLACEMENT_STYLE: CSSProperties = {
  transform: "translateX(max(-100%, min(0px, calc((100cqw - 100%) * 100000))))",
};

export function TimelinePanel({
  activeSourceId,
  runtimeBrowserDurationSeconds = null,
  onApproximateSeek,
}: TimelinePanelProps = {}) {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);
  const mediaStatus = useMediaStore(selectMediaStatus);
  const presentedFrame = usePlaybackStore(selectPresentedFrame);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const approximateBrowserTimeSeconds = usePlaybackStore(
    selectApproximateBrowserTimeSeconds,
  );
  const seekTargetSeconds = usePlaybackStore(selectSeekTargetSeconds);
  const isAttached = usePlaybackStore(selectIsAttached);
  const isReady = usePlaybackStore(selectIsReady);
  const seekToPts = usePlaybackStore(selectSeekToPts);
  const isPlaying = usePlaybackStore(selectIsPlaying);

  const segments = useTimelineStore(selectSegments);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const setSource = useTimelineStore(selectSetSource);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const selectSegment = useTimelineStore(selectSelectSegment);

  const sourceRevisionKey = getSourceRevisionKey(media);
  // The generated ID is keyed by the revision key, not by the path, so a file that changed on
  // disk becomes a new source and its old marks stop matching the active source.
  const sourceId = media ? (activeSourceId ?? getGeneratedSourceId(media)) : null;

  // Synchronize active media source with the timeline store
  useLayoutEffect(() => {
    if (sourceId && sourceRevisionKey) {
      setSource(sourceId, sourceRevisionKey);
    } else {
      setSource(null, null);
    }
  }, [sourceId, sourceRevisionKey, setSource]);

  const totalDurationSeconds = useMemo(() => {
    if (!media) return null;
    return getTimelineDurationSeconds({
      videoDurationTicks: media.probe.videoDurationTicks,
      videoTimeBase: media.probe.videoTimeBase,
      approximateDurationSeconds: media.probe.approximateDurationSeconds,
      runtimeBrowserDuration: runtimeBrowserDurationSeconds,
    });
  }, [media, runtimeBrowserDurationSeconds]);

  const isIndeterminate = totalDurationSeconds === null || totalDurationSeconds <= 0;
  const canUsePreciseSeek =
    media !== null &&
    isAttached &&
    isReady &&
    !isIndeterminate &&
    calibrationStatus === "ready" &&
    media.probe.videoStartPts !== null;
  const canUseApproximateSeek =
    media !== null &&
    isAttached &&
    isReady &&
    !isIndeterminate &&
    onApproximateSeek !== undefined;
  const canSeek = canUsePreciseSeek || canUseApproximateSeek;

  const [zoom, setZoom] = useState<number>(1);
  const zoomRef = useRef<number>(1);
  const maxZoomRef = useRef<number>(1);
  const pendingAnchorRef = useRef<{ ratio: number; clientX: number } | null>(null);

  const [viewportWidthPx, setViewportWidthPx] = useState<number>(0);
  const lastWidthRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);

  // scrollLeft is mirrored in a ref because reading scrollRef.current.scrollLeft
  // on the per-frame effect path would force a synchronous layout on every frame.
  // The per-frame path must cause zero forced layouts.
  const scrollLeftRef = useRef<number>(0);
  const userScrolledRef = useRef<boolean>(false);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollLeft = event.currentTarget.scrollLeft;
    // A scroll this component caused has already written the mirror, so a value that
    // differs from the mirror is the user's. A flag cannot do this: `scrollLeft =` fires
    // its event asynchronously, so a flag is cleared by whichever event arrives first
    // rather than by the one that matches it, and a write that changes nothing fires no
    // event at all and would leave the flag set forever.
    if (nextScrollLeft !== scrollLeftRef.current) {
      userScrolledRef.current = true;
    }
    scrollLeftRef.current = nextScrollLeft;
  };

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const initialWidth = Math.round(container.clientWidth);
    if (initialWidth > 0 && lastWidthRef.current !== initialWidth) {
      lastWidthRef.current = initialWidth;
      setViewportWidthPx(initialWidth);
    }

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const roundedWidth = Math.round(entry.contentRect.width);
      if (lastWidthRef.current !== roundedWidth) {
        lastWidthRef.current = roundedWidth;
        setViewportWidthPx(roundedWidth);
      }
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  const maxZoom = calculateMaxZoom(totalDurationSeconds, viewportWidthPx);

  // Keeps zoomRef in sync for zoom updates outside the wheel handler (such as viewport clamp or source reset).
  // The wheel handler cannot rely on this passive effect because wheel events are not flushed synchronously,
  // so zoomRef is advanced synchronously in onWheel.
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    maxZoomRef.current = maxZoom;
  }, [maxZoom]);

  // Non-passive wheel listener allows preventDefault() on zoom gestures
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (maxZoomRef.current <= 1) return;
      if (event.shiftKey) return;
      // event.ctrlKey is deliberately NOT excluded because trackpad pinch gestures
      // arrive as wheel events with event.ctrlKey = true. Handling them here and
      // calling preventDefault() also suppresses the web view's own zoom over this panel.
      // A gesture that is meaningfully horizontal belongs to the pan, and only a
      // clearly vertical one is a zoom. Requiring clear vertical dominance prevents
      // horizontal trackpad pans from being stolen by brief vertical jitter.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.5) return;
      event.preventDefault();

      const laneEl = laneRef.current;
      if (!laneEl) return;

      const rect = laneEl.getBoundingClientRect();
      const ratio = calculateAnchorRatio(event.clientX, rect.left, rect.width);
      const factor = calculateWheelZoomFactor(event.deltaY, event.deltaMode);
      const currentZoom = zoomRef.current;
      const nextZoom = clampTimelineZoom(currentZoom * factor, maxZoomRef.current);

      if (nextZoom === currentZoom) return;

      // The wheel event runs at ContinuousEventPriority and setZoom does not flush
      // synchronously, so the passive useEffect([zoom]) cannot run in time for rapid wheel
      // events or before another wheel event arrives. The handler must advance zoomRef
      // synchronously so consecutive events do not read a stale zoom or leak an anchor.
      zoomRef.current = nextZoom;
      pendingAnchorRef.current = { ratio, clientX: event.clientX };
      setZoom(nextZoom);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Write scrollLeft after React commits the new width so browser does not clamp against old scrollWidth
  useLayoutEffect(() => {
    const pendingAnchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (!pendingAnchor) return;

    const scrollEl = scrollRef.current;
    const laneEl = laneRef.current;
    if (!scrollEl || !laneEl) return;

    const rect = laneEl.getBoundingClientRect();
    const maxScrollLeftPx = scrollEl.scrollWidth - scrollEl.clientWidth;

    const nextScrollLeft = calculateAnchoredScrollLeft(
      scrollEl.scrollLeft,
      pendingAnchor.ratio,
      pendingAnchor.clientX,
      rect.left,
      rect.width,
      maxScrollLeftPx,
    );

    scrollEl.scrollLeft = nextScrollLeft;
    scrollLeftRef.current = nextScrollLeft;
  }, [zoom]);

  // Clamp zoom when viewport width changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setZoom((prevZoom) => {
      const clamped = clampTimelineZoom(prevZoom, maxZoom);
      return clamped !== prevZoom ? clamped : prevZoom;
    });
  }, [maxZoom]);

  // Reset zoom and scrollLeft when active source changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setZoom(1);
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0;
      scrollLeftRef.current = 0;
    }
  }, [sourceId]);

  const laneWidthPx = Math.max(
    0,
    calculateContentWidthPx(zoom, viewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX,
  );

  const step = useMemo(() => {
    return calculateRulerTickStepSeconds(totalDurationSeconds, laneWidthPx);
  }, [totalDurationSeconds, laneWidthPx]);

  const markers = useMemo(() => {
    return generateRulerMarkersForStep(totalDurationSeconds, step);
  }, [totalDurationSeconds, step]);

  // True while the playhead position below comes from the browser clock. The playhead takes
  // no visual mark for it: the status bar carries the marking, and marking it twice would
  // make a working playhead look broken.
  const isPositionApproximate = isPlaybackPositionApproximate(
    calibrationStatus,
    presentedFrame,
  );

  // Current elapsed presentation seconds relative to videoStartPts, and the approximate
  // browser clock otherwise. A source that never calibrates has no inferred PTS for its whole
  // session, and a frozen 0 would leave the playhead at the left edge while the picture plays.
  // Both branches report seconds elapsed from the start of the source, the axis the whole
  // ruler uses: the store subtracts the origin of the browser media timeline from the
  // approximate clock, and `onApproximateSeek` adds it back (ADR 003).
  //
  // When a seek is pending, seekTargetSeconds takes precedence over all other positions so
  // the playhead tracks the target immediately (ADR 022).
  const currentElapsedSeconds = useMemo(() => {
    return getDisplayedElapsedSeconds(
      {
        seekTargetSeconds,
        presentedFrame,
        calibrationStatus,
        approximateBrowserTimeSeconds,
      },
      media?.probe.videoStartPts,
      media?.probe.videoTimeBase,
    );
  }, [
    seekTargetSeconds,
    presentedFrame,
    calibrationStatus,
    approximateBrowserTimeSeconds,
    media?.probe.videoStartPts,
    media?.probe.videoTimeBase,
  ]);

  /**
   * Seeks to the timeline position under a client X coordinate (ADR 022).
   *
   * Reads the rectangle from `laneRef.current` on every call, because the ruler lane and the
   * track lane share one left edge and one width by construction.
   *
   * Passes `{ scrub: phase === "scrub" }` so playhead drag moves use fastSeek and audio bursts,
   * while pointer down, pointer release, and a cancelled drag perform exact seeks.
   */
  const seekFromClientX = (clientX: number, phase: "scrub" | "final") => {
    const laneEl = laneRef.current;
    if (!laneEl || !canSeek || totalDurationSeconds === null) {
      return;
    }
    const rect = laneEl.getBoundingClientRect();
    const options: SeekOptions = { scrub: phase === "scrub" };
    if (canUsePreciseSeek && media?.probe.videoStartPts && media.probe.videoTimeBase) {
      const targetPts = calculatePtsFromClientX(
        clientX,
        rect.left,
        rect.width,
        totalDurationSeconds,
        media.probe.videoStartPts,
        media.probe.videoTimeBase,
      );
      if (targetPts !== null) {
        seekToPts(targetPts, options);
      }
      return;
    }
    const targetSeconds = calculateTimelineSecondsFromClientX(
      clientX,
      rect.left,
      rect.width,
      totalDurationSeconds,
    );
    if (targetSeconds !== null) {
      onApproximateSeek?.(targetSeconds, options);
    }
  };

  const seekRef = useRef(seekFromClientX);
  useLayoutEffect(() => {
    seekRef.current = seekFromClientX;
  });

  const gestureRef = useRef<TimelineScrubGesture | null>(null);
  const getGesture = useCallback(() => {
    gestureRef.current ??= createTimelineScrubGesture({
      onSample: (clientX, phase) => {
        seekRef.current(clientX, phase);
      },
    });
    return gestureRef.current;
  }, []);

  useEffect(() => {
    return () => {
      gestureRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!canSeek || isIndeterminate || !media) {
      gestureRef.current?.cancel();
    }
  }, [canSeek, isIndeterminate, media]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || event.button !== 0 || !event.isPrimary) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw for an inactive pointer.
    }
    getGesture().begin(event.pointerId, event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    getGesture().move(event.pointerId, event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release pointer capture failures.
    }
    getGesture().end(event.pointerId, event.clientX);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    getGesture().cancel(event.pointerId);
  };

  const playhead = calculatePlayheadLayout(currentElapsedSeconds, totalDurationSeconds);

  // Resumes follow when playback starts or resumes after a pause.
  const wasPlayingRef = useRef<boolean>(isPlaying);
  useEffect(() => {
    if (isPlaying && !wasPlayingRef.current) {
      userScrolledRef.current = false;
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying]);

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

    const maxScrollLeftPx = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    const nextScrollLeft = Math.min(targetScrollLeft, maxScrollLeftPx);

    if (scrollLeftRef.current !== nextScrollLeft) {
      scrollEl.scrollLeft = nextScrollLeft;
      scrollLeftRef.current = nextScrollLeft;
    }
  }, [isPlaying, laneWidthPx, playhead.percent, viewportWidthPx]);

  const activeSourceSegments = useMemo(
    () => getActiveSourceSegmentEntries(segments, sourceId),
    [segments, sourceId],
  );
  // None of these inputs depends on the playhead, so this must not rerun per frame. The
  // label and the number belong here for that reason: `t` is stable per language, so a
  // catalog lookup per segment costs nothing here and would cost one per presented frame
  // in the render body.
  const segmentLayouts = useMemo(
    () =>
      activeSourceSegments
        .map(({ segment, projectIndex }) => ({
          segment,
          number: projectIndex + 1,
          label: t("timeline.segment", { index: projectIndex + 1 }),
          layout: calculateSegmentLayout(
            segment,
            media?.probe.videoStartPts,
            media?.probe.videoTimeBase,
            totalDurationSeconds,
          ),
        }))
        // A zero-width overlay has no visible target. As a button it would also be a Tab
        // stop with nothing to show, which reads as a dead key press.
        .filter(({ layout }) => layout.widthPercent > 0),
    [activeSourceSegments, media, totalDurationSeconds, t],
  );
  const segmentListLabel = useMemo(() => t("timeline.segmentList"), [t]);
  const pendingInFlagLabel = useMemo(() => t("timeline.pendingInFlag"), [t]);

  // The pending In region does depend on the playhead, so it stays on the render path. Its
  // right edge is the position the playhead is drawn at, and not the presented frame. Each
  // seek clears `presentedFrame` until the next RVFC callback, so a region drawn from it would
  // disappear on every click, frame step and scrub sample (ADR 022). This is display only:
  // Mark Out and the edit predicates still read `presentedFrame`.
  const pendingRegion = calculatePendingInRegionLayoutFromSeconds(
    pendingInPts,
    currentElapsedSeconds,
    media?.probe.videoStartPts,
    media?.probe.videoTimeBase,
    totalDurationSeconds,
  );

  const pendingInPercent =
    pendingInPts !== null &&
    media?.probe.videoStartPts &&
    media?.probe.videoTimeBase &&
    totalDurationSeconds &&
    totalDurationSeconds > 0
      ? calculatePercentFromPts(
          pendingInPts,
          media.probe.videoStartPts,
          media.probe.videoTimeBase,
          totalDurationSeconds,
        )
      : null;

  return (
    <section className="flex h-[180px] shrink-0 flex-col border-t border-timeline-divider bg-timeline-background text-foreground select-none">
      {/*
       * overflow-x: scroll shows the horizontal scrollbar at every zoom factor, also when
       * nothing overflows. The `::-webkit-scrollbar` rules in globals.css make it a classic
       * scrollbar that takes layout height in WebView2 and in WKWebView. With `auto`, the
       * scrollbar appeared at the first zoom and the track row became shorter by its height.
       * With `scroll`, the panel always gives that height to the scrollbar, so the rows keep
       * one height at every zoom factor.
       *
       * When nothing overflows, the scrollbar has no thumb. Its track is transparent, so the
       * strip shows the timeline background of the section.
       *
       * scrollbar-gutter cannot do this: it reserves space only at the inline-start and
       * inline-end edges, which hold the vertical scrollbar in a horizontal writing mode.
       *
       * overscroll-behavior-x: contain stops a horizontal flick at the content edge from
       * engaging the web view's rubber-band or back gesture.
       */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col overflow-x-scroll overflow-y-hidden overscroll-x-contain"
      >
        {/*
         * Shared width ancestor for both the ruler row and track row.
         * Putting the zoomed width on this shared ancestor ensures the ruler lane and
         * the track lane span one rectangle by construction, which seekFromClientX depends on.
         *
         * overflow-x: clip cuts off content that goes past the end of the lane, such as a
         * centred tick label at 100% or the playhead at the end of the source. Without it,
         * that content adds to the scroll range, and the panel scrolls at zoom 1. `clip`
         * does not make a scroll container, but `hidden` does. So the sticky gutters keep
         * the outer scroll container as their scrollport.
         *
         * At 100%, the clip cuts off the right half of the playhead head. The tip and the
         * visible half of the line stay on the end of the lane. This is the mirror of 0%,
         * where the sticky gutter covers the left half.
         */}
        <div
          className="flex min-w-[900px] flex-1 flex-col overflow-x-clip"
          style={{
            width: `calc(${TIMELINE_GUTTER_WIDTH_PX}px + (100% - ${TIMELINE_GUTTER_WIDTH_PX}px) * ${zoom})`,
          }}
        >
          {/*
           * Ruler Row (~28px tall). The divider under the ruler is drawn by the gutter and the
           * lane, not by the row. The track playhead extends 1px up over that divider, and
           * the gutter's own border keeps that pixel under the sticky gutter when the
           * playhead scrolls behind it.
           */}
          <div className="flex h-7 shrink-0">
            {/* Gutter header pinned sticky on the left */}
            <div className="sticky left-0 z-40 w-[96px] shrink-0 border-r border-b border-timeline-divider bg-sidebar" />

            {/*
             * Ruler track with time markers and tick marks, and the pointer scrub
             * surface of the panel. A primary pointerdown starts a scrub gesture,
             * capturing the pointer so dragging past the ruler keeps scrubbing.
             * Segment buttons take the click over their own span to select the segment;
             * a press-and-drag that starts on a segment neither selects a seek nor scrubs,
             * so the track lane below is not a seek surface once segments cover the
             * source. This rectangle has the same left edge and the same width as the
             * track lane rectangle, so `seekFromClientX` maps a coordinate identically.
             *
             * Pointer only, by intent: the keyboard path is the window-level layer, which
             * answers wherever focus is. Two handlers for one behaviour would move the
             * playhead two frames for one key press, and the capture phase gives the
             * slider no way to yield — the global layer has already decided by the time
             * a React handler runs.
             *
             * The seek surface below keeps `role="slider"`. The window layer serves Left
             * and Right wherever the focus is, so a focused slider still steps and
             * `aria-valuenow` still updates; Up, Down, Home and End are deliberately
             * unbound, so the element does not implement the full ARIA slider key set.
             */}
            <div
              ref={laneRef}
              onPointerDown={canSeek ? handlePointerDown : undefined}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handlePointerCancel}
              className={`relative flex-1 touch-none border-b border-timeline-divider bg-timeline-ruler ${canSeek ? "cursor-pointer" : ""}`}
            >
              {/* Timecode labels and ticks */}
              <div className="relative h-full w-full font-mono text-[10px]">
                <TimelineRuler markers={markers} />
              </div>

              {/*
               * An open source with no extent (ADR 007, step 4) has no ticks, no playhead
               * and no click-to-seek. The note says why, in the place the ticks would be.
               * It uses the same condition that hides the playhead.
               */}
              {media && isIndeterminate && (
                <div className="pointer-events-none absolute inset-0 flex items-center px-2 text-2xs text-muted-foreground">
                  {t("timeline.durationUnknown")}
                </div>
              )}

              {/*
               * Pending In flag. One edge of the flag lies on the In boundary, the same
               * edge as the bracket in the track. The flag extends to the right of it, or
               * to the left of it when it does not fit before the end of the lane (see
               * PENDING_IN_FLAG_PLACEMENT_STYLE), so the flag stays whole and inside the
               * lane, and it does not make the scroll area wider.
               *
               * The playhead at z-30 is drawn above the flag. Its head is 12px wide and
               * centred, and its outline adds 1px, so it covers 7px on each side of the
               * playhead. Right after Mark In the playhead lies on the In boundary, so the
               * 8px padding on each side keeps the label clear of the head in both
               * placements.
               *
               * The label is words, not a time code, so it takes the smallest text step,
               * `text-2xs`, which gives Chinese its larger size. The fixed 12px line keeps
               * the flag as tall as the playhead head in both languages.
               *
               * The flag is aria-hidden. It repeats the pending In mark in the track, which is
               * also decorative, and a bare "In" read out of the ruler gives no position.
               */}
              {pendingInPercent !== null && (
                <div
                  aria-hidden="true"
                  className="@container pointer-events-none absolute top-0 right-0 z-20"
                  style={{ left: `${pendingInPercent}%` }}
                >
                  <span
                    className="absolute top-0 left-0 rounded-b-sm bg-primary px-2 text-2xs leading-3 font-semibold whitespace-nowrap text-primary-foreground"
                    style={PENDING_IN_FLAG_PLACEMENT_STYLE}
                  >
                    {pendingInFlagLabel}
                  </span>
                </div>
              )}

              {/*
               * Playhead in the ruler: the upper part of one line that the track playhead
               * continues below the divider. The line spans the full ruler height and the
               * head lies over its top, both centred on the playhead position. The head is
               * 12px wide, an even width like the 2px line, so its edges and its tip fall on
               * the same pixel boundaries as the line. It is 12px tall, so it leaves most of
               * a timecode label under the playhead visible.
               *
               * The outline is a 1px ring in the timeline background colour, so the line
               * stays visible over a fill of a similar colour, such as the selected segment.
               * It is a drop-shadow filter on this wrapper, and not a box-shadow, for two
               * reasons: clip-path removes the head's own shadow, and one filter outlines the
               * head and the line as one shape, with no gap below the tip. The ring has a
               * left, a right and a lower edge only, the same ring as the track playhead.
               */}
              {media && !isIndeterminate && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-30 -translate-x-1/2 drop-shadow-[1px_0_0,-1px_0_0,0_1px_0] drop-shadow-timeline-background"
                  style={{ left: playhead.left }}
                  aria-label={t("timeline.playhead")}
                  data-approximate={isPositionApproximate}
                >
                  <div className="h-full w-0.5 bg-timeline-playhead" />
                  <div className="absolute top-0 left-1/2 h-3 w-3 -translate-x-1/2 bg-timeline-playhead [clip-path:polygon(0_0,100%_0,100%_50%,50%_100%,0_50%)]" />
                </div>
              )}
            </div>
          </div>

          {/* Single-Source Overview Track Row */}
          <div className="flex min-h-0 flex-1">
            {/* Left gutter (~96px wide) displaying Source Media lane header */}
            <div className="sticky left-0 z-40 flex w-[96px] shrink-0 items-center border-r border-timeline-divider bg-sidebar px-3">
              <span className="truncate text-xs font-semibold text-sidebar-foreground">
                {t("timeline.sourceLane")}
              </span>
            </div>

            {/*
             * Track lane container. It has no vertical padding, so the geometry box and the
             * track playhead span the full track height. The seek slider and the segment
             * layer carry the 8px vertical inset instead.
             */}
            <div className="relative flex flex-1 items-center bg-timeline-track">
              {media ? (
                /*
                 * Shared geometry box. The seek slider and the segment layer are siblings
                 * inside it, each spanning the same rectangle (`inset-x-0 inset-y-2`), so
                 * `inset-y-1` and the left/width percentages resolve exactly as they did
                 * when the overlays were children of the slider. Segments are interactive,
                 * and interactive content cannot be nested inside a `role="slider"` element.
                 */
                <div className="relative h-full w-full">
                  {/*
                   * Canonical accessible seek surface. Its 8px vertical inset holds the
                   * source bar, the pending In overlays, the hit area and the focus ring
                   * clear of the ruler divider and of the lower panel edge.
                   */}
                  <div
                    role="slider"
                    aria-label={t("timeline.seekSlider")}
                    aria-disabled={!canSeek}
                    aria-valuemin={0}
                    aria-valuemax={isIndeterminate ? undefined : totalDurationSeconds}
                    aria-valuenow={
                      isIndeterminate || !Number.isFinite(currentElapsedSeconds)
                        ? undefined
                        : Math.max(
                            0,
                            Math.min(totalDurationSeconds, currentElapsedSeconds),
                          )
                    }
                    tabIndex={canSeek ? 0 : undefined}
                    onPointerDown={canSeek ? handlePointerDown : undefined}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onLostPointerCapture={handlePointerCancel}
                    className={`absolute inset-x-0 inset-y-2 touch-none ${canSeek ? "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden" : ""}`}
                  >
                    {/* Full-source background layer */}
                    <div className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-clip-video p-2 text-clip-foreground shadow-xs">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-preview-surface text-preview-muted">
                        <Film className="size-3.5" />
                      </div>
                      <span className="truncate text-xs font-medium">
                        {media.fileName}
                      </span>
                    </div>

                    {/* Pending In active region preview overlay */}
                    {pendingRegion && pendingRegion.isVisible && (
                      <div
                        className="pointer-events-none absolute inset-y-1 z-20 rounded-md border-2 border-dashed border-primary/80 bg-primary/15"
                        style={{
                          left: pendingRegion.left,
                          width: pendingRegion.width,
                        }}
                      />
                    )}

                    {/*
                     * Pending In mark: a "[" bracket whose left edge is the In boundary.
                     * The In PTS is the inclusive left edge of its frame (ADR 002), so the
                     * bracket opens to the right of the position and is not centred on it.
                     * The shape keeps it apart from the playhead, a centred line that the
                     * z-30 layer draws above it.
                     */}
                    {pendingInPercent !== null && (
                      <div
                        className="pointer-events-none absolute inset-y-0 z-20 w-1.5 rounded-l-[2px] border-y-2 border-l-2 border-primary"
                        style={{ left: `${pendingInPercent}%` }}
                      />
                    )}
                  </div>

                  {/*
                   * Completed segment overlays. The layer takes the clicks of its buttons
                   * only, so uncovered track stays a seek surface; over a
                   * segment, the ruler track above and the playhead hit area are the seek surfaces.
                   * The `z-10` puts this layer under the pending region and the playhead.
                   */}
                  <div
                    role="group"
                    aria-label={segmentListLabel}
                    className="pointer-events-none absolute inset-x-0 inset-y-2 z-10"
                  >
                    {segmentLayouts.map(({ segment: seg, number, label, layout }) => {
                      // A string comparison at render time, so selection never rebuilds
                      // the memoized layouts.
                      const isCurrent = seg.id === currentSegmentId;
                      return (
                        <button
                          key={seg.id}
                          type="button"
                          aria-pressed={isCurrent}
                          aria-label={label}
                          // Selecting does not seek: the playhead is the operand of Mark
                          // In, Mark Out and Split, so a selection click must not move it.
                          onClick={() => selectSegment(seg.id)}
                          // The overlay layer holding the segments is z-10, the pending-In
                          // overlays are z-20, and the playhead is z-30. Applying z-20 to
                          // the selected segment raises it above sibling segments so
                          // overlapping segments do not obscure it, without covering the playhead.
                          className={`pointer-events-auto absolute inset-y-1 flex items-center overflow-hidden rounded-md px-2 shadow-xs ${
                            isCurrent
                              ? "z-20 border-2 border-primary-active bg-primary text-primary-foreground ring-2 ring-primary-active ring-offset-2 ring-offset-clip-video"
                              : "border-2 border-primary/45 bg-primary/20 text-foreground backdrop-blur-xs hover:border-primary/70 hover:bg-primary/30"
                          }`}
                          style={{
                            left: layout.left,
                            width: layout.width,
                          }}
                        >
                          <span
                            className={`truncate font-mono text-[10px] font-semibold ${
                              isCurrent ? "text-primary-foreground" : "text-foreground"
                            }`}
                          >
                            #{number}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/*
                   * Track playhead layer. Positioned after the segment group at z-30
                   * so the 9px hit area is grabbable above segments.
                   *
                   * The layer spans the full track height, and `-top-px` pulls it up over
                   * the 1px divider, so it meets the ruler playhead and the two read as one
                   * line from the top of the ruler to the bottom of the track.
                   *
                   * The line has the same outline as the ruler playhead: a drop-shadow
                   * ring in the timeline background colour on the left, the right and the
                   * lower edge. It has no upper edge on purpose. That edge would paint over
                   * the lowest pixel of the ruler line, and the one line would show a gap.
                   */}
                  {!isIndeterminate && (
                    <div className="pointer-events-none absolute inset-x-0 -top-px bottom-0 z-30">
                      <div
                        className="pointer-events-none absolute inset-y-0 flex -translate-x-1/2 flex-col items-center"
                        style={{ left: playhead.left }}
                        data-approximate={isPositionApproximate}
                      >
                        <div
                          onPointerDown={canSeek ? handlePointerDown : undefined}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          onPointerCancel={handlePointerCancel}
                          onLostPointerCapture={handlePointerCancel}
                          className={`flex h-full w-[9px] touch-none items-center justify-center ${canSeek ? "pointer-events-auto cursor-ew-resize" : "pointer-events-none"}`}
                        >
                          <div className="h-full w-0.5 bg-timeline-playhead drop-shadow-[1px_0_0,-1px_0_0,0_1px_0] drop-shadow-timeline-background" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : mediaStatus === "loading" ? (
                /*
                 * The first import is in progress. A pulsing bar takes the rectangle of the
                 * source bar that replaces it. The preview announces the load, so the bar
                 * is hidden from assistive technology. The track hover colour stands apart
                 * from the track in both themes. The ruler colour does not: in the dark
                 * theme it is only a little darker than the track, and the bar almost
                 * disappears.
                 */
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 inset-y-2 animate-pulse rounded-lg bg-timeline-track-hover motion-reduce:animate-none"
                />
              ) : (
                /*
                 * Empty track. The dashed outline takes the rectangle of the source bar.
                 * The message is smaller than the preview's empty state, which carries the
                 * call to action, so the two do not compete.
                 */
                <div className="absolute inset-x-0 inset-y-2 flex items-center justify-center rounded-lg border border-dashed border-timeline-divider text-xs text-muted-foreground">
                  {t("timeline.emptyHint")}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
