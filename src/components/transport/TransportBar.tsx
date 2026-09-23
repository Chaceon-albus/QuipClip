import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  Scissors,
  SquarePlus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import {
  hasNominalFrameRate,
  playbackStore,
  usePlaybackStore,
} from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
  findCurrentSegment,
  getCurrentSegmentTarget,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";

const selectMedia = (s: MediaStoreState) => s.media;

const selectCanUndo = (s: TimelineStoreState) => s.canUndo;
const selectCanRedo = (s: TimelineStoreState) => s.canRedo;
const selectPendingInPts = (s: TimelineStoreState) => s.pendingInPts;
const selectSegments = (s: TimelineStoreState) => s.segments;
const selectSourceId = (s: TimelineStoreState) => s.sourceId;
const selectCurrentSegmentId = (s: TimelineStoreState) => s.currentSegmentId;
const selectMarkIn = (s: TimelineStoreState) => s.markIn;
const selectMarkOut = (s: TimelineStoreState) => s.markOut;
const selectSplit = (s: TimelineStoreState) => s.split;
const selectNewSegment = (s: TimelineStoreState) => s.newSegment;
const selectDeleteSegment = (s: TimelineStoreState) => s.deleteSegment;
const selectUndo = (s: TimelineStoreState) => s.undo;
const selectRedo = (s: TimelineStoreState) => s.redo;

/**
 * Keeps a mouse click from moving the focus to a transport button.
 *
 * The browser gives a button the focus on mouse down, so a cancelled mouse down
 * leaves the focus where it was. The click still happens, because the browser sends
 * a click on mouse up and does not test whether the mouse down was cancelled.
 *
 * The window shortcut layer takes Space from a focused button. Without this rule a
 * user who pressed an edit action with the mouse and then pressed Space repeated
 * that action instead of starting playback. The Tab order does not change: a button
 * reached with the Tab key still takes the focus, and Enter still operates it.
 */
const preventFocusOnMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
  event.preventDefault();
};

export function TransportBar() {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);

  const canUndo = useTimelineStore(selectCanUndo);
  const canRedo = useTimelineStore(selectCanRedo);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const currentSegmentId = useTimelineStore(selectCurrentSegmentId);
  const markIn = useTimelineStore(selectMarkIn);
  const markOut = useTimelineStore(selectMarkOut);
  const split = useTimelineStore(selectSplit);
  const newSegment = useTimelineStore(selectNewSegment);
  const deleteSegment = useTimelineStore(selectDeleteSegment);
  const undo = useTimelineStore(selectUndo);
  const redo = useTimelineStore(selectRedo);

  const hasMedia = media !== null;
  // The playback store replaces presentedFrame on every presented frame. Selecting the
  // derived booleans instead of the object keeps this tree off the frame-rate render path.
  const hasActiveSource = usePlaybackStore(
    (s) => hasMedia && s.isAttached && s.isReady,
  );
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const togglePlayback = playbackStore.getState().togglePlayback;
  const seekNominal = playbackStore.getState().seekNominal;

  const hasNominalRate = hasNominalFrameRate(media?.probe);

  // Every segment action names this target instead of guessing from the playhead.
  const currentSegment = useMemo(
    () => findCurrentSegment(segments, currentSegmentId, sourceId),
    [segments, currentSegmentId, sourceId],
  );
  // Parsed once per change of the target, so the per-frame boundary tests stay cheap.
  const currentTarget = useMemo(
    () => getCurrentSegmentTarget(currentSegment),
    [currentSegment],
  );

  const isMarkInEnabled = usePlaybackStore((s) =>
    canMarkIn(s.calibrationStatus, s.presentedFrame, hasActiveSource, currentTarget),
  );
  const isMarkOutEnabled = usePlaybackStore((s) =>
    canMarkOut(
      s.calibrationStatus,
      s.presentedFrame,
      pendingInPts,
      hasActiveSource,
      currentTarget,
    ),
  );
  const isSplitEnabled = usePlaybackStore((s) =>
    canSplitCurrentSegment(
      currentTarget,
      s.calibrationStatus,
      s.presentedFrame,
      hasActiveSource,
    ),
  );

  const isUndoDisabled = !hasActiveSource || !canUndo;
  const isRedoDisabled = !hasActiveSource || !canRedo;
  const isMarkInDisabled = !isMarkInEnabled;
  const isMarkOutDisabled = !isMarkOutEnabled;
  const isSplitDisabled = !isSplitEnabled;
  // Nothing is in progress when no segment is current and no In mark is pending.
  const isNewSegmentDisabled =
    !hasActiveSource || (currentSegment === null && pendingInPts === null);
  const isDeleteSegmentDisabled = !hasActiveSource || currentSegment === null;

  return (
    <section className="flex h-[72px] shrink-0 items-center justify-center border-y border-border bg-card px-4 select-none">
      <div className="flex items-center gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            disabled={isUndoDisabled}
            onMouseDown={preventFocusOnMouseDown}
            onClick={undo}
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.undo")}
          >
            <Undo2 className="size-4" />
            <span className="text-2xs leading-none font-medium">
              {t("transport.action.undo")}
            </span>
          </Button>
          <Button
            variant="ghost"
            disabled={isRedoDisabled}
            onMouseDown={preventFocusOnMouseDown}
            onClick={redo}
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.redo")}
          >
            <Redo2 className="size-4" />
            <span className="text-2xs leading-none font-medium">
              {t("transport.action.redo")}
            </span>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 2: Mark points and cut tools (In, Out, Split) */}
        {/*
          Every seek clears presentedFrame until RVFC reports a frame (ADR 022), which
          disables these three for a few frames on each step. Only the dimming waits 150 ms:
          a delay set in the disabled state applies on the way in, and a return inside it
          cancels the fade. Reduced motion drops the fade and keeps the delay.
        */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                disabled={isMarkInDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={() => {
                  // Read at click time: the store is the single source, and the click runs
                  // after the render that enabled the button.
                  const frame = playbackStore.getState().presentedFrame;
                  if (frame) {
                    markIn(frame.inferredSourcePts);
                  }
                }}
                className="flex h-10 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted disabled:delay-150 motion-reduce:duration-0"
                aria-label={t("transport.action.markInAria")}
              >
                <ArrowRightToLine className="size-4 text-muted-foreground" />
                <span className="text-xs font-semibold">
                  {t("transport.action.markIn")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.markInAria")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                disabled={isMarkOutDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={() => {
                  const frame = playbackStore.getState().presentedFrame;
                  if (frame) {
                    markOut(frame.inferredSourcePts);
                  }
                }}
                className="flex h-10 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted disabled:delay-150 motion-reduce:duration-0"
                aria-label={t("transport.action.markOutAria")}
              >
                <ArrowLeftToLine className="size-4 text-muted-foreground" />
                <span className="text-xs font-semibold">
                  {t("transport.action.markOut")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.markOutAria")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                disabled={isSplitDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={() => {
                  const frame = playbackStore.getState().presentedFrame;
                  if (frame) {
                    split(frame.inferredSourcePts);
                  }
                }}
                className="flex h-10 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted disabled:delay-150 motion-reduce:duration-0"
                aria-label={t("transport.action.splitAria")}
              >
                <Scissors className="size-4 text-muted-foreground" />
                <span className="text-xs font-semibold">
                  {t("transport.action.split")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.splitAria")}</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 3: Current segment (New / Delete, icon over label) */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                disabled={isNewSegmentDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={newSegment}
                className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.newSegmentAria")}
              >
                <SquarePlus className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.newSegment")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.newSegmentAria")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                disabled={isDeleteSegmentDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={deleteSegment}
                className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.deleteSegmentAria")}
              >
                <Trash2 className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.deleteSegment")}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.deleteSegmentAria")}</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 4: Playback Controls (Previous / Next nominal step, Play/Pause) */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!hasActiveSource || !hasNominalRate}
                onMouseDown={preventFocusOnMouseDown}
                onClick={() => seekNominal(-1)}
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.previousStep")}
              >
                <ChevronLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.previousStepHint")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                disabled={!hasActiveSource}
                onMouseDown={preventFocusOnMouseDown}
                onClick={togglePlayback}
                className="size-11 rounded-lg bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active"
                aria-label={
                  isPlaying ? t("transport.action.pause") : t("transport.action.play")
                }
              >
                {isPlaying ? (
                  <Pause className="size-5 fill-current" />
                ) : (
                  <Play className="size-5 fill-current" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isPlaying
                ? t("transport.action.pauseHint")
                : t("transport.action.playHint")}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!hasActiveSource || !hasNominalRate}
                onMouseDown={preventFocusOnMouseDown}
                onClick={() => seekNominal(1)}
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.nextStep")}
              >
                <ChevronRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.nextStepHint")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
