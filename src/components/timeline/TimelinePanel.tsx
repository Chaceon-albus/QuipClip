import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getGeneratedSourceId,
  getSourceRevisionKey,
  useMediaStore,
  type MediaStoreState,
} from "@/features/media";
import {
  getDisplayedElapsedSeconds,
  playbackStore,
  resolveTimecodeDisplay,
  usePlaybackStore,
  type PlaybackStoreState,
  type SeekOptions,
} from "@/features/playback";
import {
  useTimecodePreference,
  type TimecodePreferenceState,
} from "@/features/settings/timecodePreference";
import {
  calculateAnchorRatio,
  calculateAnchoredScrollLeft,
  calculateContentWidthPx,
  calculateMaxZoom,
  calculatePlayheadLayout,
  calculatePtsFromClientX,
  calculateTimelineSecondsFromClientX,
  calculateWheelZoomFactor,
  clampScrollLeftToFollowWindow,
  getTimelineDurationSeconds,
  resolvePlayheadOrCentreAnchor,
  timelineViewportStore,
  useTimelineStore,
  useTimelineViewportStore,
  TIMELINE_GUTTER_WIDTH_PX,
  type TimelineStoreState,
  type TimelineViewportStoreState,
  type TimelineZoomAnchorPoint,
} from "@/features/timeline";
import { PendingInFlag, PendingInTrackMarks } from "./PendingInLayer";
import { PlayheadFollow } from "./PlayheadFollow";
import {
  RulerPlayhead,
  TimelineSeekSlider,
  TrackPlayhead,
  type ScrubSurfaceHandlers,
} from "./PlayheadLayer";
import { countRulerEdgeAnchors } from "./rulerLabel";
import { SegmentLayer } from "./SegmentLayer";
import { calculateRulerScale, generateRulerTicks } from "./timelineMarkers";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineZoomControls } from "./TimelineZoomControls";
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
const selectCalibrationStatus = (state: PlaybackStoreState) => state.calibrationStatus;
const selectIsAttached = (state: PlaybackStoreState) => state.isAttached;
const selectIsReady = (state: PlaybackStoreState) => state.isReady;
const selectSeekToPts = (state: PlaybackStoreState) => state.seekToPts;

const selectSetSource = (state: TimelineStoreState) => state.setSource;

const selectTimecodeFormat = (state: TimecodePreferenceState) => state.format;

const selectZoom = (state: TimelineViewportStoreState) => state.zoom;

/**
 * The timeline panel shell: the layout, the scroll container, the zoom and the viewport
 * state, the pointer gesture, and the empty and loading states.
 *
 * The zoom factor lives in the viewport store, so the zoom buttons and the window keyboard
 * layer can change it. The panel reports the ceiling of the zoom to that store, and it owns
 * the scroll position: it applies the anchor of each zoom after it commits the new width.
 *
 * The shell subscribes to no value that changes per presented frame. The layers that draw
 * the displayed position subscribe to it themselves: RulerPlayhead, TrackPlayhead, the
 * `aria-valuenow` of TimelineSeekSlider, the pending In region, and PlayheadFollow, which
 * holds the follow effects. SegmentLayer, the pending In flag and bracket, and the ruler
 * ticks do not subscribe to it. So a presented frame renders only those small layers again.
 * A layer that renders per frame takes its label as a prop, and a layer that does not
 * reads the catalog itself.
 */
export function TimelinePanel({
  activeSourceId,
  runtimeBrowserDurationSeconds = null,
  onApproximateSeek,
}: TimelinePanelProps = {}) {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);
  const mediaStatus = useMediaStore(selectMediaStatus);
  const calibrationStatus = usePlaybackStore(selectCalibrationStatus);
  const isAttached = usePlaybackStore(selectIsAttached);
  const isReady = usePlaybackStore(selectIsReady);
  const seekToPts = usePlaybackStore(selectSeekToPts);

  const setSource = useTimelineStore(selectSetSource);

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

  const zoom = useTimelineViewportStore(selectZoom);
  // The zoom factor of the last commit. The layout effect that applies an anchor reads it as
  // the factor of the view before the zoom, because the DOM already has the new width then.
  const committedZoomRef = useRef<number>(zoom);

  const [viewportWidthPx, setViewportWidthPx] = useState<number>(0);
  const lastWidthRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);

  // scrollLeft is mirrored in a ref because reading scrollRef.current.scrollLeft
  // on the per-frame effect path (PlayheadFollow) would force a synchronous layout on every
  // frame. The per-frame path must cause zero forced layouts.
  const scrollLeftRef = useRef<number>(0);
  const userScrolledRef = useRef<boolean>(false);

  // The seek target that the last request of the pointer gesture left in the store, or null.
  // seekFromClientX records it, and the paused follow in PlayheadFollow compares and clears it
  // through calculatePendingNavigation.
  const gestureSeekTargetRef = useRef<number | null>(null);

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

  // Reports the ceiling to the viewport store, which clamps the zoom to it, as a resize or a
  // new extent requires. A layout effect, so a clamped zoom renders before the paint.
  useLayoutEffect(() => {
    timelineViewportStore.getState().setMaxZoom(maxZoom);
  }, [maxZoom]);

  // Non-passive wheel listener allows preventDefault() on zoom gestures
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const viewport = timelineViewportStore.getState();
      if (viewport.maxZoom <= 1) return;
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

      // The store changes synchronously, so a second wheel event before the next render reads
      // the advanced zoom, and its anchor replaces the first one. The lane rectangle is then
      // still the one of the last commit, and the time under the pointer is the same in both.
      viewport.zoomBy(factor, {
        kind: "point",
        point: {
          ratio,
          viewportOffsetPx: event.clientX - el.getBoundingClientRect().left,
        },
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The drawn playhead in percent of the extent, as PlayheadFollow computes it, or null when
  // none is drawn. The panel does not subscribe to the position, which changes on every
  // presented frame, so a zoom that anchors on the playhead reads it from the store. The ref
  // holds the reader of the latest render. It is updated in a layout effect that comes before
  // the zoom effect below, so both run in that order in one commit.
  const readPlayheadPercent = (): number | null => {
    if (!media || isIndeterminate) {
      return null;
    }
    const elapsedSeconds = getDisplayedElapsedSeconds(
      playbackStore.getState(),
      media.probe.videoStartPts,
      media.probe.videoTimeBase,
    );
    return calculatePlayheadLayout(elapsedSeconds, totalDurationSeconds).percent;
  };
  const readPlayheadPercentRef = useRef(readPlayheadPercent);
  useLayoutEffect(() => {
    readPlayheadPercentRef.current = readPlayheadPercent;
  });

  // Writes scrollLeft after React commits the new width, so the browser does not clamp it
  // against the old scrollWidth. The anchor of the zoom decides the value:
  //
  // - `point` (the wheel) holds the time under the pointer.
  // - `playheadOrCentre` (the keys and the buttons) resolves the playhead, or the centre of
  //   the visible lane, from the view before the zoom: the zoom of the last commit, the
  //   mirror of scrollLeft and the width of the container. The mirror still holds the value
  //   from before the zoom, because a scroll that the new width causes has not reached
  //   handleScroll yet. A held playhead then stays in the window of the follow.
  // - `start` (Fit) goes to scrollLeft 0.
  //
  // A zoom with no anchor, such as the clamp from a resize, keeps the scroll position.
  useLayoutEffect(() => {
    const previousZoom = committedZoomRef.current;
    committedZoomRef.current = zoom;
    const anchor = timelineViewportStore.getState().takeAnchor();
    if (!anchor) return;

    const scrollEl = scrollRef.current;
    const laneEl = laneRef.current;
    if (!scrollEl || !laneEl) return;

    let nextScrollLeft = 0;
    if (anchor.kind !== "start") {
      const scrollRect = scrollEl.getBoundingClientRect();
      // The point to hold comes from the fractional width of the container, which is the
      // `100%` of the lane width rule. The rounded width would place it off by up to half a
      // pixel times the zoom. The visibility test takes the rounded width that PlayheadFollow
      // reads (`lastWidthRef` holds the value of `viewportWidthPx`), so the two agree.
      let point: TimelineZoomAnchorPoint;
      let heldPlayheadPercent: number | null = null;
      if (anchor.kind === "point") {
        point = anchor.point;
      } else {
        const resolved = resolvePlayheadOrCentreAnchor({
          zoom: previousZoom,
          viewportWidthPx: scrollRect.width,
          followViewportWidthPx: lastWidthRef.current,
          scrollLeftPx: scrollLeftRef.current,
          playheadPercent: readPlayheadPercentRef.current(),
        });
        point = resolved;
        heldPlayheadPercent = resolved.heldPlayheadPercent;
      }

      const laneRect = laneEl.getBoundingClientRect();
      const maxScrollLeftPx = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      nextScrollLeft = calculateAnchoredScrollLeft(
        scrollEl.scrollLeft,
        point.ratio,
        scrollRect.left + point.viewportOffsetPx,
        laneRect.left,
        laneRect.width,
        maxScrollLeftPx,
      );

      // A held playhead stays where the follow sees it, so the playback follow does not page
      // after the zoom. The clamp can leave the scroll range, and the range wins.
      if (heldPlayheadPercent !== null) {
        const inFollowWindow = clampScrollLeftToFollowWindow({
          scrollLeftPx: nextScrollLeft,
          playheadPercent: heldPlayheadPercent,
          zoom,
          followViewportWidthPx: lastWidthRef.current,
        });
        nextScrollLeft = Math.max(0, Math.min(maxScrollLeftPx, inFollowWindow));
      }
    }

    scrollEl.scrollLeft = nextScrollLeft;
    // The browser clamps the value and snaps it to the device pixel grid. The mirror takes
    // the value it kept, so the scroll event of this write matches the mirror, and handleScroll
    // does not take the write for a pan by the user.
    scrollLeftRef.current = scrollEl.scrollLeft;
  }, [zoom]);

  // Reset zoom when the active source changes. PlayheadFollow resets scrollLeft for the same
  // change, because that write must come before its follow effects in the commit.
  useEffect(() => {
    timelineViewportStore.getState().reset();
  }, [sourceId]);

  const laneWidthPx = Math.max(
    0,
    calculateContentWidthPx(zoom, viewportWidthPx) - TIMELINE_GUTTER_WIDTH_PX,
  );

  // The ruler labels follow the timecode format of the source, as the preview does
  // (ADR 028).
  const timecodePreference = useTimecodePreference(selectTimecodeFormat);
  const probe = media?.probe;
  const timecodeDisplay = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, probe),
    [timecodePreference, probe],
  );

  const rulerScale = useMemo(
    () => calculateRulerScale(totalDurationSeconds, laneWidthPx, timecodeDisplay),
    [totalDurationSeconds, laneWidthPx, timecodeDisplay],
  );
  // The scale is a new object for every lane width. Its fields are numbers and strings, so
  // the ticks are generated again only when the step changes.
  const majorUnit = rulerScale?.major.unit ?? null;
  const majorValue = rulerScale?.major.value ?? null;
  const minorSeconds = rulerScale?.minorSeconds ?? null;

  const rulerTicks = useMemo(
    () =>
      majorUnit === null || majorValue === null
        ? []
        : generateRulerTicks(totalDurationSeconds, timecodeDisplay, {
            unit: majorUnit,
            value: majorValue,
          }),
    [totalDurationSeconds, timecodeDisplay, majorUnit, majorValue],
  );

  const rulerEdgeAnchors = useMemo(
    () => countRulerEdgeAnchors(rulerTicks, laneWidthPx),
    [rulerTicks, laneWidthPx],
  );

  /**
   * Seeks to the timeline position under a client X coordinate (ADR 022).
   *
   * Reads the rectangle from `laneRef.current` on every call, because the ruler lane and the
   * track lane share one left edge and one width by construction.
   *
   * Passes `{ scrub: phase === "scrub" }` so playhead drag moves use fastSeek and audio bursts,
   * while pointer down, pointer release, and a cancelled drag perform exact seeks.
   *
   * Records the seek target that each request leaves in the store, so the paused follow does
   * not treat a position that the gesture requested as a navigation. The render of the exact
   * seek at release runs after the gesture ends, so isActive() cannot filter that seek. The
   * recorded target filters it (calculatePendingNavigation).
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
        gestureSeekTargetRef.current = playbackStore.getState().seekTargetSeconds;
      }
      return;
    }
    const targetSeconds = calculateTimelineSecondsFromClientX(
      clientX,
      rect.left,
      rect.width,
      totalDurationSeconds,
    );
    if (targetSeconds !== null && onApproximateSeek) {
      onApproximateSeek(targetSeconds, options);
      gestureSeekTargetRef.current = playbackStore.getState().seekTargetSeconds;
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

  // The pointer handlers of the three scrub surfaces: the ruler lane, the seek slider and
  // the hit area of the track playhead.
  const scrubHandlers: ScrubSurfaceHandlers = {
    onPointerDown: canSeek ? handlePointerDown : undefined,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onLostPointerCapture: handlePointerCancel,
  };

  const videoStartPts = media?.probe.videoStartPts;
  const videoTimeBase = media?.probe.videoTimeBase;

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
       *
       * The left scroll padding is the gutter width. The gutter is sticky and covers the left
       * edge of the viewport, so a scroll that brings a focused segment into view stops to
       * the right of the gutter and not under it.
       */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col overflow-x-scroll overflow-y-hidden overscroll-x-contain"
        style={{ scrollPaddingLeft: TIMELINE_GUTTER_WIDTH_PX }}
      >
        {/*
         * Shared width ancestor for both the ruler row and track row.
         * Putting the zoomed width on this shared ancestor ensures the ruler lane and
         * the track lane span one rectangle by construction, which seekFromClientX depends on.
         *
         * overflow-x: clip cuts off content that goes past the end of the lane, such as the
         * playhead at the end of the source. A tick label near the end is anchored inside
         * the lane (see TimelineRuler), so the clip does not cut it. Without the clip,
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
            {/*
             * Gutter header pinned sticky on the left. It holds the zoom controls, so they
             * stay in view at every scroll position. It is outside the lane, so a press on a
             * button there is not a scrub.
             */}
            <div className="sticky left-0 z-40 flex w-[96px] shrink-0 items-center justify-center border-r border-b border-timeline-divider bg-sidebar">
              <TimelineZoomControls />
            </div>

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
              {...scrubHandlers}
              className={`relative flex-1 touch-none border-b border-timeline-divider bg-timeline-ruler ${canSeek ? "cursor-pointer" : ""}`}
            >
              {/* Timecode labels, major ticks and minor ticks (see TimelineRuler) */}
              <div className="relative h-full w-full font-mono text-[10px]">
                <TimelineRuler
                  ticks={rulerTicks}
                  minorSeconds={minorSeconds}
                  startAnchoredCount={rulerEdgeAnchors.start}
                  endAnchoredCount={rulerEdgeAnchors.end}
                />
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

              {/* Pending In flag (see PendingInFlag) */}
              <PendingInFlag
                videoStartPts={videoStartPts}
                videoTimeBase={videoTimeBase}
                totalDurationSeconds={totalDurationSeconds}
              />

              {/* Playhead in the ruler (see RulerPlayhead) */}
              {media && !isIndeterminate && (
                <RulerPlayhead
                  videoStartPts={videoStartPts}
                  videoTimeBase={videoTimeBase}
                  totalDurationSeconds={totalDurationSeconds}
                  ariaLabel={t("timeline.playhead")}
                />
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
                   * Canonical accessible seek surface (see TimelineSeekSlider). The panel
                   * creates its content here, so a render of the slider for a new position
                   * does not render the source bar or the pending In marks again.
                   */}
                  <TimelineSeekSlider
                    videoStartPts={videoStartPts}
                    videoTimeBase={videoTimeBase}
                    totalDurationSeconds={totalDurationSeconds}
                    ariaLabel={t("timeline.seekSlider")}
                    canSeek={canSeek}
                    scrubHandlers={scrubHandlers}
                    timecodeDisplay={timecodeDisplay}
                  >
                    {/*
                     * Full-source background layer. The export cuts away each part of the
                     * source that no segment covers, so this bar is drawn as excluded: a
                     * quiet diagonal hatch on the track colour, inside a thin outline. The
                     * segments above it are solid, so the kept parts read as footage and
                     * the cut parts do not. The file name is in the title bar.
                     *
                     * At a high zoom the bar can be more than a million pixels wide, and
                     * the playhead above it moves on every frame, so the engine repaints
                     * parts of the bar often. Two rules keep that repaint cheap:
                     *
                     * - The hatch is an 8px tile that repeats, and not one gradient across
                     *   the bar. 8px is a whole number of device pixels at 125%, 150% and
                     *   175% scaling. The tile gives 1px lines at a 5.66px period, and its
                     *   two stripes meet the stripes of the next tiles, so the hatch has no
                     *   seam.
                     * - The outline is solid. A dashed border on a bar of that length costs
                     *   more to paint, and the hatch already marks the bar as cut.
                     */}
                    <div className="pointer-events-none absolute inset-0 rounded-lg border border-timeline-divider bg-timeline-track bg-[linear-gradient(135deg,var(--timeline-divider)_0_9%,transparent_9%_50%,var(--timeline-divider)_50%_59%,transparent_59%)] bg-size-[8px_8px]" />

                    {/* Pending In region and bracket (see PendingInTrackMarks) */}
                    <PendingInTrackMarks
                      videoStartPts={videoStartPts}
                      videoTimeBase={videoTimeBase}
                      totalDurationSeconds={totalDurationSeconds}
                    />
                  </TimelineSeekSlider>

                  {/* Completed segment overlays (see SegmentLayer) */}
                  <SegmentLayer
                    sourceId={sourceId}
                    videoStartPts={videoStartPts}
                    videoTimeBase={videoTimeBase}
                    totalDurationSeconds={totalDurationSeconds}
                    laneWidthPx={laneWidthPx}
                    timecodeDisplay={timecodeDisplay}
                    viewportRef={scrollRef}
                  />

                  {/* Track playhead, after the segment group (see TrackPlayhead) */}
                  {!isIndeterminate && (
                    <TrackPlayhead
                      videoStartPts={videoStartPts}
                      videoTimeBase={videoTimeBase}
                      totalDurationSeconds={totalDurationSeconds}
                      canSeek={canSeek}
                      scrubHandlers={scrubHandlers}
                    />
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

      {/* The follow of the playhead. It renders nothing (see PlayheadFollow). */}
      <PlayheadFollow
        media={media}
        sourceId={sourceId}
        totalDurationSeconds={totalDurationSeconds}
        isIndeterminate={isIndeterminate}
        canSeek={canSeek}
        laneWidthPx={laneWidthPx}
        viewportWidthPx={viewportWidthPx}
        scrollRef={scrollRef}
        scrollLeftRef={scrollLeftRef}
        userScrolledRef={userScrolledRef}
        gestureRef={gestureRef}
        gestureSeekTargetRef={gestureSeekTargetRef}
      />
    </section>
  );
}
