import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Pause,
  Play,
  Redo2,
  Scissors,
  SkipBack,
  SkipForward,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaStore, type MediaStoreState } from "@/features/media";
import { playbackStore, usePlaybackStore } from "@/features/playback";
import {
  canMarkIn,
  canMarkOut,
  canSplitWithBounds,
  getSegmentBounds,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { assertPositiveTimeBase } from "@/lib/time";
import type { Rational } from "@/types/project";

function isValidNominalRate(rate: Rational | null | undefined): boolean {
  if (!rate) {
    return false;
  }
  try {
    assertPositiveTimeBase(rate);
    return true;
  } catch {
    return false;
  }
}

const selectMedia = (s: MediaStoreState) => s.media;

const selectCanUndo = (s: TimelineStoreState) => s.canUndo;
const selectCanRedo = (s: TimelineStoreState) => s.canRedo;
const selectPendingInPts = (s: TimelineStoreState) => s.pendingInPts;
const selectSegments = (s: TimelineStoreState) => s.segments;
const selectSourceId = (s: TimelineStoreState) => s.sourceId;
const selectMarkIn = (s: TimelineStoreState) => s.markIn;
const selectMarkOut = (s: TimelineStoreState) => s.markOut;
const selectSplit = (s: TimelineStoreState) => s.split;
const selectUndo = (s: TimelineStoreState) => s.undo;
const selectRedo = (s: TimelineStoreState) => s.redo;

export function TransportBar() {
  const { t } = useTranslation();
  const media = useMediaStore(selectMedia);

  const canUndo = useTimelineStore(selectCanUndo);
  const canRedo = useTimelineStore(selectCanRedo);
  const pendingInPts = useTimelineStore(selectPendingInPts);
  const segments = useTimelineStore(selectSegments);
  const sourceId = useTimelineStore(selectSourceId);
  const markIn = useTimelineStore(selectMarkIn);
  const markOut = useTimelineStore(selectMarkOut);
  const split = useTimelineStore(selectSplit);
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

  const hasNominalRate =
    isValidNominalRate(media?.probe.avgFrameRate) ||
    isValidNominalRate(media?.probe.rFrameRate);

  // Parsed once per segments change, so the per-frame split test stays cheap.
  const segmentBounds = useMemo(() => getSegmentBounds(segments), [segments]);

  const isMarkInEnabled = usePlaybackStore((s) =>
    canMarkIn(s.calibrationStatus, s.presentedFrame, hasActiveSource),
  );
  const isMarkOutEnabled = usePlaybackStore((s) =>
    canMarkOut(s.calibrationStatus, s.presentedFrame, pendingInPts, hasActiveSource),
  );
  const isSplitEnabled = usePlaybackStore((s) =>
    canSplitWithBounds(
      segmentBounds,
      s.calibrationStatus,
      s.presentedFrame,
      hasActiveSource,
      sourceId ?? undefined,
    ),
  );

  const isUndoDisabled = !hasActiveSource || !canUndo;
  const isRedoDisabled = !hasActiveSource || !canRedo;
  const isMarkInDisabled = !isMarkInEnabled;
  const isMarkOutDisabled = !isMarkOutEnabled;
  const isSplitDisabled = !isSplitEnabled;

  return (
    <section className="flex h-[72px] shrink-0 items-center justify-center border-y border-border bg-card px-4 select-none">
      <div className="flex items-center gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            disabled={isUndoDisabled}
            onClick={undo}
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.undo")}
          >
            <Undo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">
              {t("transport.action.undo")}
            </span>
          </Button>
          <Button
            variant="ghost"
            disabled={isRedoDisabled}
            onClick={redo}
            className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("transport.action.redo")}
          >
            <Redo2 className="size-4" />
            <span className="text-[10px] leading-none font-medium">
              {t("transport.action.redo")}
            </span>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 2: Mark points and cut tools (In, Out, Split) */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={isMarkInDisabled}
            onClick={() => {
              // Read at click time: the store is the single source, and the click runs
              // after the render that enabled the button.
              const frame = playbackStore.getState().presentedFrame;
              if (frame) {
                markIn(frame.inferredSourcePts);
              }
            }}
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.markInAria")}
          >
            <ArrowRightToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.markIn")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.markInDetail")}
              </span>
            </div>
          </Button>

          <Button
            variant="outline"
            disabled={isMarkOutDisabled}
            onClick={() => {
              const frame = playbackStore.getState().presentedFrame;
              if (frame) {
                markOut(frame.inferredSourcePts);
              }
            }}
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.markOutAria")}
          >
            <ArrowLeftToLine className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.markOut")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.markOutDetail")}
              </span>
            </div>
          </Button>

          <Button
            variant="outline"
            disabled={isSplitDisabled}
            onClick={() => {
              const frame = playbackStore.getState().presentedFrame;
              if (frame) {
                split(frame.inferredSourcePts);
              }
            }}
            className="flex h-11 items-center gap-2 rounded-lg border-border bg-card px-3 hover:bg-muted"
            aria-label={t("transport.action.splitAria")}
          >
            <Scissors className="size-4 text-muted-foreground" />
            <div className="flex flex-col items-start leading-tight">
              <span className="text-xs font-semibold">
                {t("transport.action.split")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t("transport.action.splitDetail")}
              </span>
            </div>
          </Button>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 3: Playback Controls (Previous / Next nominal step, Play/Pause) */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!hasActiveSource || !hasNominalRate}
                onClick={() => seekNominal(-1)}
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.previousStep")}
              >
                <SkipBack className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.previousStep")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                disabled={!hasActiveSource}
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
              {isPlaying ? t("transport.action.pause") : t("transport.action.play")}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!hasActiveSource || !hasNominalRate}
                onClick={() => seekNominal(1)}
                className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.nextStep")}
              >
                <SkipForward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("transport.action.nextStep")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
