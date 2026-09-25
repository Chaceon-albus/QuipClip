import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isSourceActive } from "@/components/layout/actionConditions";
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
  calculateTimelineSecondsFromClientX,
  calculateWheelZoomFactor,
  clampScrollLeftToFollowWindow,
  getTimelineDurationSeconds,
  resolvePlayheadOrCentreAnchor,
  timelineStore,
  timelineViewportStore,
  useTimelineStore,
  useTimelineViewportStore,
  TIMELINE_GUTTER_WIDTH_PX,
  type TimelineStoreState,
  type TimelineViewportStoreState,
  type TimelineZoomAnchorPoint,
} from "@/features/timeline";
import { formatElapsedTimecode } from "@/lib/timecode";
import {
  calculateVisibleLane,
  createEdgeAutoScroll,
  type ClientRange,
  type EdgeAutoScroll,
  type EdgeAutoScrollGeometry,
} from "./edgeAutoScroll";
import { PendingInFlag, PendingInTrackMarks } from "./PendingInLayer";
import { PlayheadFollow } from "./PlayheadFollow";
import {
  RulerPlayhead,
  TimelineSeekSlider,
  TrackPlayhead,
  type ScrubSurfaceHandlers,
} from "./PlayheadLayer";
import { countRulerEdgeAnchors } from "./rulerLabel";
import { planScrubSeek, resolveSnapIndicatorRatio } from "./scrubSeekPlan";
import { createSnapBoundaryCache, type SnapBoundary } from "./scrubSnap";
import { clickSegmentEdge } from "./segmentEdgeClick";
import type { SegmentEdge } from "./segmentEdges";
import { SegmentLayer, type SegmentEdgePointerHandlers } from "./SegmentLayer";
import {
  createTrimSnapBoundaryCache,
  isTrimCurrent,
  resolveTrimGridRate,
  resolveTrimTarget,
} from "./segmentTrim";
import { SegmentTrimPreview } from "./SegmentTrimPreview";
import { segmentTrimSession } from "./segmentTrimSession";
import {
  RulerHoverLine,
  RulerSnapIndicator,
  TrackHoverLine,
  TrackSnapIndicator,
} from "./TimelineDragAids";
import {
  calculateHoverLineOffset,
  createTimelineHoverLine,
  hideHoverLine,
  hideSnapIndicator,
  resolveHoverLabelSide,
  showSnapIndicator,
  writeHoverLine,
  type HoverLineElements,
  type SnapIndicatorElements,
  type TimelineHoverLine,
} from "./timelineHover";
import { calculateRulerScale, generateRulerTicks } from "./timelineMarkers";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineZoomControls } from "./TimelineZoomControls";
import {
  createSegmentClickGuard,
  planPointerRelease,
  type TrimPress,
} from "./timelinePointerRelease";
import {
  createTimelineScrubGesture,
  type TimelineScrubGesture,
  type TimelineScrubPhase,
} from "./timelineScrub";
import { TrimNotice } from "./TrimNotice";

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

/** The empty boundary list of a sample that cannot snap. */
const NO_SNAP_BOUNDARIES: readonly SnapBoundary[] = [];

/**
 * The visible part of the lane, in client pixels (`calculateVisibleLane`). The right edge is
 * the fractional right of the rectangle and not `clientWidth`, which is rounded. The scroll
 * container below has no border, no padding and no vertical scrollbar, so its rectangle is
 * its visible area.
 */
function readVisibleLane(scrollEl: HTMLElement): ClientRange {
  return calculateVisibleLane(scrollEl.getBoundingClientRect());
}

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
 *
 * The panel also runs three aids of the playhead drag. None of them renders the panel: they
 * write to the DOM, or they seek through the store.
 *
 * - The snap (`scrubSnap.ts`): a drag sample within 6px of a segment boundary or the pending
 *   In seeks to the stored PTS of that boundary, and the snap indicator shows it.
 * - The edge auto-scroll (`edgeAutoScroll.ts`): a drag near an edge of the visible lane, or
 *   past it, scrolls the view, and the playhead stays at that edge.
 * - The hover line (`timelineHover.ts`): with no drag running, a line and an approximate
 *   timecode show the time under the pointer.
 *
 * The same pointer gesture also trims a segment edge (ADR 030). A press on an edge hit area
 * starts the gesture in the trim mode, and the ruler lane captures the pointer, as it does for
 * a scrub. Past the drag threshold the trim starts (`segmentTrimSession`), each sample seeks
 * with the snap and the auto-scroll above, and the release commits the frame that the browser
 * presents. A release before the threshold is the click of the edge (ADR 007).
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
  // A drag on a segment edge trims it only on the exact frame grid (ADR 030), where the frame of
  // the release target can be recognized when it arrives. On any other source the edge press is
  // the click of ADR 007. The press, the resize cursor of the edges and the trim start all read
  // this one condition.
  const canTrimEdges =
    canUsePreciseSeek && media !== null && resolveTrimGridRate(media.probe) !== null;

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

  // The elements of the drag aids (TimelineDragAids). The panel writes to them directly.
  const hoverRulerRef = useRef<HTMLDivElement | null>(null);
  const hoverLabelRef = useRef<HTMLSpanElement | null>(null);
  const hoverTrackRef = useRef<HTMLDivElement | null>(null);
  const snapRulerRef = useRef<HTMLDivElement | null>(null);
  const snapTrackRef = useRef<HTMLDivElement | null>(null);

  // True while Alt (Option on macOS) is held, which turns the snap off. Pointer events and
  // the key events of the modifier both write it.
  const isSnapSuppressedRef = useRef<boolean>(false);
  // The lane position of the last sample of the gesture, and the direction of the drag on
  // the time axis, for the tie rule of the snap (resolveDragDirection).
  const dragLaneXRef = useRef<number | null>(null);
  const dragDirectionRef = useRef<number>(0);
  // The snap boundaries, built again only when the segments or the time axis change.
  const [readSnapBoundaries] = useState(createSnapBoundaryCache);
  // The snap boundaries of a trim, built again also when a new trim starts.
  const [readTrimSnapBoundaries] = useState(createTrimSnapBoundaryCache);

  // The mode of the pointer gesture: a scrub of the playhead, or the trim of a segment edge
  // (ADR 030). A press on an edge sets the trim mode, and the end of the gesture sets the scrub
  // mode again. `trimPressRef` holds the edge of that press until the gesture ends.
  const gestureModeRef = useRef<"scrub" | "trim">("scrub");
  const trimPressRef = useRef<TrimPress | null>(null);
  // True during the final sample that a pointer release sends. The trim commits at a release,
  // and a cancel of the gesture by another path makes no change.
  const isPointerReleaseRef = useRef<boolean>(false);
  // The pointer of the last press in the trim mode, until its release. The click that the
  // browser sends after that release does nothing (`segmentClickGuard`): the release already
  // did the click of the edge, or it ended a drag.
  const trimPointerIdRef = useRef<number | null>(null);
  const [segmentClickGuard] = useState(createSegmentClickGuard);

  const hoverRef = useRef<TimelineHoverLine | null>(null);
  const autoScrollRef = useRef<EdgeAutoScroll | null>(null);

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
    // The lane moved under a pointer that did not move, so the time under it changed.
    hoverRef.current?.refresh();
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

  const gestureRef = useRef<TimelineScrubGesture | null>(null);

  const videoStartPts = media?.probe.videoStartPts;
  const videoTimeBase = media?.probe.videoTimeBase;

  // The element sets of the two aids. The refs are read at the time of the write, so an
  // element that mounts again is found.
  const hoverElements = (): HoverLineElements => ({
    ruler: hoverRulerRef.current,
    label: hoverLabelRef.current,
    track: hoverTrackRef.current,
  });
  const snapElements = (): SnapIndicatorElements => ({
    ruler: snapRulerRef.current,
    track: snapTrackRef.current,
  });

  /**
   * Seeks to the timeline position under a client X coordinate (ADR 022).
   *
   * The DOM and the store reads are here, and every rule is in `planScrubSeek`:
   *
   * - The coordinate is clamped to the visible lane, where an end of the lane less than a
   *   pixel outside the view counts as its edge (`calculateScrubClampRange`). A drag past an
   *   edge then seeks to the time at that edge while the edge auto-scroll moves the view, and
   *   at the end of the scroll range it reaches the exact end of the lane. A press lands on a
   *   surface that the user sees, so the clamp moves the seek of a click only by that snap, at
   *   an end of the lane.
   * - A sample of a drag, its release included, snaps to a segment boundary or to the pending
   *   In within 6px inside the visible lane, while a precise seek is possible and Alt is not
   *   held. It then seeks to the stored PTS of that boundary, and not to a PTS from the pixel.
   *   The seek at pointer down is the seek of a click, and it never snaps (scrubSnap.ts gives
   *   the reasons).
   * - The calibration gate, `canUsePreciseSeek`, applies here, in the one path that seeks from a
   *   pointer position.
   *
   * Reads the rectangle from `laneRef.current` on every call, because the ruler lane and the
   * track lane share one left edge and one width by construction.
   *
   * Passes `{ scrub: phase === "scrub" }` so playhead drag moves use fastSeek and audio bursts,
   * while pointer down, pointer release, and a cancelled drag perform exact seeks. A snapped
   * sample follows the same rule, and the store drops a scrub sample that repeats the time of
   * the last request, so a pointer that rests on a snap sends no new seek.
   *
   * The snap indicator shows while the playhead is drawn on the snapped boundary after the
   * seek (`resolveSnapIndicatorRatio`), so a refused seek hides it and a dropped repeat keeps
   * it.
   *
   * Records the seek target that each request leaves in the store, so the paused follow does
   * not treat a position that the gesture requested as a navigation. The render of the exact
   * seek at release runs after the gesture ends, so isActive() cannot filter that seek. The
   * recorded target filters it (calculatePendingNavigation).
   */
  const seekFromClientX = (clientX: number, phase: "scrub" | "final") => {
    const laneEl = laneRef.current;
    if (!laneEl) {
      hideSnapIndicator(snapElements());
      return;
    }
    const laneRect = laneEl.getBoundingClientRect();
    const scrollEl = scrollRef.current;
    const isDragSample = gestureRef.current?.isDragging() === true;
    // The boundary list comes from the store and not from a subscription, so an edit does not
    // render the panel. A sample that cannot snap does not build it.
    let boundaries = NO_SNAP_BOUNDARIES;
    if (isDragSample && canUsePreciseSeek) {
      const { segments, pendingInPts } = timelineStore.getState();
      boundaries = readSnapBoundaries({
        segments,
        sourceId,
        pendingInPts,
        videoStartPts,
        videoTimeBase,
        totalDurationSeconds,
      });
    }

    const plan = planScrubSeek({
      pointerX: clientX,
      phase,
      isDragSample,
      canSeek,
      canSeekExactly: canUsePreciseSeek,
      canSeekApproximately: onApproximateSeek !== undefined,
      lane: { left: laneRect.left, width: laneRect.width },
      container: scrollEl ? scrollEl.getBoundingClientRect() : null,
      totalDurationSeconds,
      videoStartPts,
      videoTimeBase,
      boundaries,
      isSnapSuppressed: isSnapSuppressedRef.current,
      previousLaneX: dragLaneXRef.current,
      previousDirection: dragDirectionRef.current,
    });
    dragLaneXRef.current = plan.laneX;
    dragDirectionRef.current = plan.direction;

    const request = plan.request;
    if (request === null) {
      hideSnapIndicator(snapElements());
      return;
    }
    const options: SeekOptions = { scrub: plan.scrub };
    if (request.kind === "pts") {
      seekToPts(request.pts, options);
    } else {
      onApproximateSeek?.(request.seconds, options);
    }

    const state = playbackStore.getState();
    gestureSeekTargetRef.current = state.seekTargetSeconds;
    const snapRatio = resolveSnapIndicatorRatio(
      plan.snap,
      getDisplayedElapsedSeconds(state, videoStartPts, videoTimeBase),
    );
    if (snapRatio === null) {
      hideSnapIndicator(snapElements());
    } else {
      showSnapIndicator(snapElements(), snapRatio);
    }
  };

  const seekRef = useRef(seekFromClientX);
  useLayoutEffect(() => {
    seekRef.current = seekFromClientX;
  });

  /**
   * One sample of the trim of a segment edge (ADR 030, `segmentTrim.ts`).
   *
   * The trim uses the rules of `seekFromClientX`, with three differences:
   *
   * - It seeks only with a PTS, so it needs the calibration gate. A trim whose calibration or
   *   source stops holding is dropped with no change and with the notice of TrimNotice, and the
   *   rest of the drag is a scrub of the playhead, which ends with the exact seek of ADR 022.
   * - It snaps to the boundaries of `collectTrimSnapBoundaries`: those of the scrub without the
   *   edge that it moves, plus the playhead at the start of the trim.
   * - The seek target stops at the limit of the trim (`resolveTrimTarget`), one nominal frame
   *   from the other edge.
   *
   * A scrub sample sends a scrub seek. The final sample of a release commits
   * (`segmentTrimSession.release`), and the final sample of any other end of the gesture makes
   * no change and sends the exact seek of a cancelled drag (`abandon`).
   *
   * No trim drags at the seek of pointer down, after the release, and after `Escape`. Such a
   * sample sends nothing.
   */
  const trimFromClientX = (clientX: number, phase: TimelineScrubPhase) => {
    const trim = segmentTrimSession.getDraggingTrim();
    const laneEl = laneRef.current;
    if (trim === null || !laneEl) {
      hideSnapIndicator(snapElements());
      return;
    }
    if (!canUsePreciseSeek || !isTrimCurrent(trim, playbackStore.getState())) {
      // The trim cannot commit a frame any more, so the timeline says that it was not applied.
      segmentTrimSession.fail();
      gestureModeRef.current = "scrub";
      seekFromClientX(clientX, phase);
      return;
    }

    const laneRect = laneEl.getBoundingClientRect();
    const scrollEl = scrollRef.current;
    const snaps = readTrimSnapBoundaries({
      trim,
      segments: timelineStore.getState().segments,
      totalDurationSeconds,
    });
    const plan = planScrubSeek({
      pointerX: clientX,
      phase,
      isDragSample: true,
      canSeek,
      canSeekExactly: true,
      canSeekApproximately: false,
      lane: { left: laneRect.left, width: laneRect.width },
      container: scrollEl ? scrollEl.getBoundingClientRect() : null,
      totalDurationSeconds,
      videoStartPts,
      videoTimeBase,
      boundaries: snaps.boundaries,
      isSnapSuppressed: isSnapSuppressedRef.current,
      previousLaneX: dragLaneXRef.current,
      previousDirection: dragDirectionRef.current,
    });
    dragLaneXRef.current = plan.laneX;
    dragDirectionRef.current = plan.direction;

    const target = resolveTrimTarget(trim, plan.request, plan.snap, snaps);
    if (phase === "scrub") {
      segmentTrimSession.scrub(target);
    } else if (isPointerReleaseRef.current) {
      segmentTrimSession.release(target);
    } else {
      segmentTrimSession.abandon(target);
    }

    const state = playbackStore.getState();
    gestureSeekTargetRef.current = state.seekTargetSeconds;
    const snapRatio = resolveSnapIndicatorRatio(
      target?.snap ?? null,
      getDisplayedElapsedSeconds(state, videoStartPts, videoTimeBase),
    );
    if (snapRatio === null) {
      hideSnapIndicator(snapElements());
    } else {
      showSnapIndicator(snapElements(), snapRatio);
    }
  };

  const trimRef = useRef(trimFromClientX);
  useLayoutEffect(() => {
    trimRef.current = trimFromClientX;
  });

  const getGesture = useCallback(() => {
    gestureRef.current ??= createTimelineScrubGesture({
      onSample: (clientX, phase) => {
        if (gestureModeRef.current === "trim") {
          trimRef.current(clientX, phase);
        } else {
          seekRef.current(clientX, phase);
        }
      },
      // The end of a gesture, by any path, ends its aids: the release, a cancel, a lost
      // capture, the cancel of PlayheadFollow when seeking stops being possible, and unmount.
      // It also ends the trim mode. A trim that still drags here ended with no final sample,
      // as at unmount, and it makes no change.
      onFinish: () => {
        autoScrollRef.current?.stop();
        hideSnapIndicator({ ruler: snapRulerRef.current, track: snapTrackRef.current });
        dragLaneXRef.current = null;
        dragDirectionRef.current = 0;
        if (segmentTrimSession.isDragging()) {
          segmentTrimSession.drop();
        }
        gestureModeRef.current = "scrub";
        trimPressRef.current = null;
      },
    });
    return gestureRef.current;
  }, []);

  /**
   * The edge auto-scroll of a drag. Each step writes scrollLeft and reads the kept value back
   * into the mirror, as the zoom anchor does, so handleScroll does not take the step for a pan
   * by the user. The step then samples the drag at once, so the playhead stays at the edge in
   * the same frame as the scroll.
   */
  const getAutoScroll = useCallback(() => {
    autoScrollRef.current ??= createEdgeAutoScroll({
      readGeometry: (): EdgeAutoScrollGeometry | null => {
        const scrollEl = scrollRef.current;
        if (!scrollEl) {
          return null;
        }
        const visibleLane = readVisibleLane(scrollEl);
        return {
          visibleLeftPx: visibleLane.left,
          visibleRightPx: visibleLane.right,
          scrollLeftPx: scrollLeftRef.current,
          maxScrollLeftPx: Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth),
        };
      },
      writeScrollLeft: (nextScrollLeft) => {
        const scrollEl = scrollRef.current;
        if (!scrollEl) {
          return nextScrollLeft;
        }
        scrollEl.scrollLeft = nextScrollLeft;
        scrollLeftRef.current = scrollEl.scrollLeft;
        return scrollLeftRef.current;
      },
      onScrolled: () => {
        gestureRef.current?.sampleNow();
      },
      isDragging: () => gestureRef.current?.isDragging() === true,
    });
    return autoScrollRef.current;
  }, []);

  /**
   * Draws the hover line at a client X coordinate, in the frame that the hover controller
   * schedules. Returns false when it cannot, and the controller hides the line.
   *
   * The time is a pixel position, so the label marks it as approximate and the conversion is
   * the approximate one. It is never a seek target or an edit position.
   */
  const drawHoverLine = (clientX: number): boolean => {
    const laneEl = laneRef.current;
    const scrollEl = scrollRef.current;
    if (
      !media ||
      isIndeterminate ||
      totalDurationSeconds === null ||
      !laneEl ||
      !scrollEl
    ) {
      return false;
    }
    const laneRect = laneEl.getBoundingClientRect();
    const visibleLane = readVisibleLane(scrollEl);
    if (clientX < visibleLane.left || clientX > visibleLane.right) {
      return false;
    }
    const seconds = calculateTimelineSecondsFromClientX(
      clientX,
      laneRect.left,
      laneRect.width,
      totalDurationSeconds,
    );
    if (seconds === null) {
      return false;
    }
    // The position in the window is rounded to the device pixel grid, and not the offset from a
    // lane edge that can lie between two device pixels.
    const offsetPx = calculateHoverLineOffset(
      clientX,
      laneRect.left,
      window.devicePixelRatio,
    );
    const lineX = laneRect.left + offsetPx;
    writeHoverLine(hoverElements(), {
      offsetPx,
      text: t("timeline.hoverTime", {
        time: formatElapsedTimecode(seconds, timecodeDisplay),
      }),
      resolveSide: (labelWidthPx) =>
        resolveHoverLabelSide(lineX, labelWidthPx, visibleLane.left, visibleLane.right),
    });
    return true;
  };

  const drawHoverLineRef = useRef(drawHoverLine);
  useLayoutEffect(() => {
    drawHoverLineRef.current = drawHoverLine;
  });

  const getHover = useCallback(() => {
    hoverRef.current ??= createTimelineHoverLine({
      isSuppressed: () => gestureRef.current?.isActive() === true,
      draw: (clientX) => drawHoverLineRef.current(clientX),
      hide: () =>
        hideHoverLine({
          ruler: hoverRulerRef.current,
          label: hoverLabelRef.current,
          track: hoverTrackRef.current,
        }),
    });
    return hoverRef.current;
  }, []);

  // A render of the panel can change the time under a pointer that did not move: a zoom, a
  // resize, a new extent or a new timecode format. The controller draws again only while the
  // line shows.
  useEffect(() => {
    hoverRef.current?.refresh();
  });

  useEffect(() => {
    return () => {
      gestureRef.current?.dispose();
      autoScrollRef.current?.stop();
      hoverRef.current?.dispose();
    };
  }, []);

  // The snap modifier can change while the pointer rests. A key event of Alt (Option on
  // macOS) records the new state and samples the drag again, so the snap turns off or on at
  // once. The listener only reads the event: the window keyboard layer does not own a
  // modifier, and nothing here cancels or stops it.
  useEffect(() => {
    const onModifierKey = (event: KeyboardEvent) => {
      if (event.key !== "Alt") {
        return;
      }
      const isHeld = event.type === "keydown";
      if (isSnapSuppressedRef.current === isHeld) {
        return;
      }
      isSnapSuppressedRef.current = isHeld;
      gestureRef.current?.sampleNow();
    };
    // A window blur ends the drag, as it ends the hold of a step button: the release then goes
    // to another application, and the drag would stay active with its auto-scroll running. The
    // cancel sends one exact seek at the last position (ADR 022), and onFinish stops the aids.
    // The cancel comes first, so that seek uses the snap state of the last sample that the
    // user saw. A key release in another application never arrives, so the modifier state is
    // cleared after the cancel and starts again from the next pointer event.
    const onBlur = () => {
      gestureRef.current?.cancel();
      isSnapSuppressedRef.current = false;
    };
    window.addEventListener("keydown", onModifierKey, true);
    window.addEventListener("keyup", onModifierKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onModifierKey, true);
      window.removeEventListener("keyup", onModifierKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // The snap of a sample depends on the boundaries and on the calibration gate. Either can
  // change while the pointer rests: an edit from a key, an undo, or a calibration that stops
  // holding. The drag then samples again at once, so the seek and the indicator do not stay on
  // a boundary that no longer applies. A sample that repeats the last request sends no seek.
  useEffect(() => {
    return timelineStore.subscribe((state, previous) => {
      if (
        state.segments !== previous.segments ||
        state.pendingInPts !== previous.pendingInPts
      ) {
        gestureRef.current?.sampleNow();
      }
    });
  }, []);
  // A layout effect of this component runs before its passive effects, so the sample uses the
  // seek path of this render, with the new gate.
  useEffect(() => {
    gestureRef.current?.sampleNow();
  }, [canUsePreciseSeek]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek || event.button !== 0 || !event.isPrimary) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can throw for an inactive pointer.
    }
    isSnapSuppressedRef.current = event.altKey;
    getHover().hide();
    const gesture = getGesture();
    // A press during an active gesture does not start another one, so it keeps the arming.
    if (!gesture.isActive()) {
      getAutoScroll().begin(event.clientX);
      // A trim-mode press whose release never arrived, such as one that went to another
      // application, no longer names this pointer.
      trimPointerIdRef.current = null;
    }
    gesture.begin(event.pointerId, event.clientX);
  };

  /**
   * A press on the edge hit area of a segment (ADR 030). With the condition of a trim, the
   * press starts the gesture in the trim mode, and the ruler lane captures the pointer, so every
   * later event of that pointer reaches the scrub handlers of the lane. The lane is always
   * mounted, while a zoom or an edit can remove the edge under the pointer. The seek at pointer
   * down of the gesture sends nothing in the trim mode (`trimFromClientX`), because a release
   * before the drag threshold is the click of the edge, and that click seeks to the stored
   * boundary.
   *
   * Without the condition (`canTrimEdges`: a precise seek and an exact frame grid), or when the
   * capture fails, the press is left to the segment button, and its click is the click of the
   * edge (ADR 007). A source that is not on the exact grid therefore never starts a trim.
   *
   * The trim runs on the gesture of the scrub, so it gets the scrub cursor of that gesture
   * (`scrubCursor.ts`): past the drag threshold the resize cursor shows everywhere in the window
   * until the gesture ends, by every path. A release before the threshold keeps the cursor of
   * the element under the pointer, as a click does.
   */
  const handleEdgePointerDown = (
    segmentId: string,
    edge: SegmentEdge,
    event: React.PointerEvent<HTMLElement>,
  ) => {
    const laneEl = laneRef.current;
    const gesture = getGesture();
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      !laneEl ||
      !canTrimEdges ||
      gesture.isActive()
    ) {
      return;
    }
    const hasActiveSource = isSourceActive(media !== null, isAttached, isReady);
    const probe = media?.probe ?? null;
    if (
      !segmentTrimSession.canBegin({
        segmentId,
        edge,
        hasActiveSource,
        probe,
        totalDurationSeconds,
      })
    ) {
      return;
    }
    try {
      laneEl.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    gestureModeRef.current = "trim";
    trimPressRef.current = { segmentId, edge };
    trimPointerIdRef.current = event.pointerId;
    isSnapSuppressedRef.current = event.altKey;
    getHover().hide();
    getAutoScroll().begin(event.clientX);
    gesture.begin(event.pointerId, event.clientX);
  };

  /**
   * Starts the trim when the gesture of an edge press passes the drag threshold. The session
   * records the boundaries and the playhead before the first scrub seek, and selects the
   * segment. The first sample then runs at once and not in the next frame, so the preview never
   * draws the new edge at the playhead of the time before the trim. When the condition stopped
   * holding after the press, the gesture ends with no seek, and the press did nothing (ADR 007).
   */
  const startTrimDrag = () => {
    const press = trimPressRef.current;
    const gesture = getGesture();
    const hasActiveSource = isSourceActive(media !== null, isAttached, isReady);
    if (
      press !== null &&
      canTrimEdges &&
      segmentTrimSession.begin({
        ...press,
        hasActiveSource,
        probe: media?.probe ?? null,
        totalDurationSeconds,
      })
    ) {
      gesture.sampleNow();
      return;
    }
    trimPressRef.current = null;
    gesture.cancel();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = getGesture();
    if (gesture.isActive()) {
      isSnapSuppressedRef.current = event.altKey;
    }
    const wasDragging = gesture.isDragging();
    gesture.move(event.pointerId, event.clientX);
    if (!wasDragging && gesture.isDragging() && gestureModeRef.current === "trim") {
      startTrimDrag();
    }
    if (gesture.isDragging()) {
      getAutoScroll().update(event.clientX);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release pointer capture failures.
    }
    const gesture = getGesture();
    if (gesture.isActive()) {
      isSnapSuppressedRef.current = event.altKey;
    }
    // The plan reads the gesture before its end, because the end clears the trim-mode press.
    const release = planPointerRelease({
      pointerId: event.pointerId,
      mode: gestureModeRef.current,
      isGestureActive: gesture.isActive(),
      isDragging: gesture.isDragging(),
      trimPress: trimPressRef.current,
      trimPointerId: trimPointerIdRef.current,
    });
    isPointerReleaseRef.current = true;
    try {
      gesture.end(event.pointerId, event.clientX);
    } finally {
      isPointerReleaseRef.current = false;
    }
    if (release.endsTrimPointer) {
      trimPointerIdRef.current = null;
      segmentClickGuard.arm();
    }
    if (release.edgeClick !== null) {
      clickSegmentEdge(release.edgeClick.segmentId, release.edgeClick.edge);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    getGesture().cancel(event.pointerId);
  };

  // The handlers of the segment edges. The segment layer is memoized, so the object is created
  // once, and it calls the handler of the latest render through a ref.
  const edgePointerDownRef = useRef(handleEdgePointerDown);
  useLayoutEffect(() => {
    edgePointerDownRef.current = handleEdgePointerDown;
  });
  const [segmentEdgeHandlers] = useState<SegmentEdgePointerHandlers>(() => ({
    onEdgePointerDown: (segmentId, edge, event) => {
      edgePointerDownRef.current(segmentId, edge, event);
    },
    shouldIgnoreClick: (detail) => segmentClickGuard.consume(detail),
  }));

  // Every pointer down in the window ends a click guard that no click consumed, so the guard
  // never takes the click of a later press anywhere. The listener is in the capture phase, so
  // it runs before any handler of the press, and it only reads the event: it never cancels or
  // stops it.
  useEffect(() => {
    const onPointerDown = () => {
      segmentClickGuard.clear();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [segmentClickGuard]);

  // `Escape` during a trim reaches the session from the window keyboard layer (ADR 026,
  // ADR 030). The session ends the trim first, and then this canceller ends the gesture, so the
  // final sample of the gesture finds no trim and sends no seek of its own.
  //
  // The bound of a released trim counts only visible time (ADR 030), as the wait for the
  // calibration anchor does (ADR 003), so the panel reports each change of the visibility.
  useEffect(() => {
    segmentTrimSession.setDragCanceller(() => {
      if (gestureModeRef.current === "trim") {
        gestureRef.current?.cancel();
      }
    });
    const onVisibilityChange = () => {
      segmentTrimSession.visibilityChanged(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      segmentTrimSession.setDragCanceller(null);
      segmentTrimSession.drop();
    };
  }, []);

  // The hover handlers of the two lanes. A pointer event from a scrub surface or a segment
  // in the track lane bubbles to the lane, and the controller hides the line while a drag
  // runs or a button is held.
  const handleHoverMove = (event: React.PointerEvent<HTMLDivElement>) => {
    getHover().move(event);
  };
  const handleHoverLeave = () => {
    getHover().leave();
  };

  // The ruler lane is a scrub surface and a hover surface, so its move handler does both.
  const handleRulerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    handlePointerMove(event);
    handleHoverMove(event);
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

  return (
    // The section fills the timeline area of the shell, which holds the height that the user
    // sets with the splitter (`TimelineArea`). The ruler row keeps its height, and the track
    // row takes the rest, so a taller timeline gives the segments more height.
    <section className="relative flex min-h-0 flex-1 flex-col border-t border-timeline-divider bg-timeline-background text-foreground select-none">
      {/*
       * overflow-x: scroll shows the horizontal scrollbar at every zoom factor, also when
       * nothing overflows. With `auto`, a scrollbar that takes layout height appeared at the
       * first zoom and the track row became shorter by its height. With `scroll`, the panel
       * always gives that height to the scrollbar, so the rows keep one height at every zoom
       * factor. The height depends on the platform:
       *
       * - Windows: the `::-webkit-scrollbar` rules in globals.css make it a classic
       *   scrollbar of 8px in WebView2. When nothing overflows, it has no thumb. Its track is
       *   transparent, so the strip shows the timeline background of the section.
       * - macOS: WKWebView draws the system scrollbar and follows the system setting. An
       *   overlay scrollbar takes no height and shows over the bottom of the track row while
       *   the view scrolls. A legacy scrollbar (Show scroll bars: Always) takes 15px and draws
       *   its own track, also when nothing overflows.
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
         *
         * `group/timeline` lets the hover line read the state of the segment tooltip in the
         * track row from the ruler row (see TimelineDragAids).
         */}
        <div
          className="group/timeline flex min-w-[900px] flex-1 flex-col overflow-x-clip"
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
            <div className="sticky left-0 z-40 flex w-[96px] shrink-0 items-center justify-center border-r border-b border-timeline-divider bg-chrome">
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
             *
             * The lane is also a hover surface for the hover line.
             */}
            <div
              ref={laneRef}
              {...scrubHandlers}
              onPointerMove={handleRulerPointerMove}
              onPointerLeave={handleHoverLeave}
              className="relative flex-1 touch-none border-b border-timeline-divider bg-timeline-ruler"
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

              {/* The hover line and the snap indicator in the ruler (see TimelineDragAids) */}
              {media && !isIndeterminate && (
                <>
                  <RulerHoverLine lineRef={hoverRulerRef} labelRef={hoverLabelRef} />
                  <RulerSnapIndicator indicatorRef={snapRulerRef} />
                </>
              )}
            </div>
          </div>

          {/* Single-Source Overview Track Row */}
          <div className="flex min-h-0 flex-1">
            {/* Left gutter (~96px wide) displaying Source Media lane header */}
            <div className="sticky left-0 z-40 flex w-[96px] shrink-0 items-center border-r border-timeline-divider bg-chrome px-3">
              <span className="truncate text-xs font-semibold text-chrome-foreground">
                {t("timeline.sourceLane")}
              </span>
            </div>

            {/*
             * Track lane container. It has no vertical padding, so the geometry box and the
             * track playhead span the full track height. The seek slider and the segment
             * layer carry the 8px vertical inset instead.
             *
             * It is the hover surface of the track. The pointer events of the scrub surfaces
             * and the segments in it bubble here. `data-timeline-track` names it for the rule
             * that hides the hover line while the segment tooltip is open.
             */}
            <div
              data-timeline-track=""
              onPointerMove={handleHoverMove}
              onPointerLeave={handleHoverLeave}
              className="relative flex flex-1 items-center bg-timeline-track"
            >
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
                    edgePointerHandlers={segmentEdgeHandlers}
                    canTrimEdges={canTrimEdges}
                  />

                  {/* The new extent of a segment that a trim moves (see SegmentTrimPreview) */}
                  <SegmentTrimPreview
                    videoStartPts={videoStartPts}
                    videoTimeBase={videoTimeBase}
                    totalDurationSeconds={totalDurationSeconds}
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

                  {/* The hover line and the snap indicator in the track (see TimelineDragAids) */}
                  {!isIndeterminate && (
                    <>
                      <TrackHoverLine lineRef={hoverTrackRef} />
                      <TrackSnapIndicator indicatorRef={snapTrackRef} />
                    </>
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

      {/* The notice of a trim that was not applied (see TrimNotice) */}
      <TrimNotice />
    </section>
  );
}
