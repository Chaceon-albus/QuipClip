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
import { useMediaStore } from "@/features/media";
import { usePlaybackStore } from "@/features/playback";
import { canMarkIn, canMarkOut, canSplit, useTimelineStore } from "@/features/timeline";
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

export function TransportBar() {
  const { t } = useTranslation();
  const media = useMediaStore((s) => s.media);
  const presentedFrame = usePlaybackStore((s) => s.presentedFrame);
  const calibrationStatus = usePlaybackStore((s) => s.calibrationStatus);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const isAttached = usePlaybackStore((s) => s.isAttached);
  const isReady = usePlaybackStore((s) => s.isReady);
  const togglePlayback = usePlaybackStore((s) => s.togglePlayback);
  const seekNominal = usePlaybackStore((s) => s.seekNominal);

  const canUndo = useTimelineStore((s) => s.canUndo);
  const canRedo = useTimelineStore((s) => s.canRedo);
  const pendingInPts = useTimelineStore((s) => s.pendingInPts);
  const segments = useTimelineStore((s) => s.segments);
  const markIn = useTimelineStore((s) => s.markIn);
  const markOut = useTimelineStore((s) => s.markOut);
  const split = useTimelineStore((s) => s.split);
  const undo = useTimelineStore((s) => s.undo);
  const redo = useTimelineStore((s) => s.redo);
  const sourceId = useTimelineStore((s) => s.sourceId);

  const hasActiveSource = media !== null && isAttached && isReady;
  const hasNominalRate =
    isValidNominalRate(media?.probe.avgFrameRate) ||
    isValidNominalRate(media?.probe.rFrameRate);

  const isUndoDisabled = !hasActiveSource || !canUndo;
  const isRedoDisabled = !hasActiveSource || !canRedo;
  const isMarkInDisabled = !canMarkIn(
    calibrationStatus,
    presentedFrame,
    hasActiveSource,
  );
  const isMarkOutDisabled = !canMarkOut(
    calibrationStatus,
    presentedFrame,
    pendingInPts,
    hasActiveSource,
  );
  const isSplitDisabled = !canSplit(
    segments,
    calibrationStatus,
    presentedFrame,
    hasActiveSource,
    sourceId ?? undefined,
  );

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
              if (presentedFrame) {
                markIn(presentedFrame.inferredSourcePts);
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
              if (presentedFrame) {
                markOut(presentedFrame.inferredSourcePts);
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
              if (presentedFrame) {
                split(presentedFrame.inferredSourcePts);
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
