import { useId, useMemo, useState } from "react";
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
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
import { useShortcutLabels } from "@/components/common/useShortcutLabels";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  canDeleteSegment,
  canFinishSegment,
  canRedoEdit,
  canStepFrames,
  canTogglePlayback,
  canUndoEdit,
  isSourceActive,
} from "@/components/layout/actionConditions";
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
import {
  presentEditDisabledReason,
  presentStepDisabledReason,
  settleDisabledReason,
  type EditDisabledReason,
  type EditReasonContext,
  type TransportDisabledReasonKey,
} from "./transportDisabledReason";

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

/**
 * Returns the reason to show for an edit control, and keeps the last one while a pending seek
 * hides the reason (`settleDisabledReason`). A frame step then leaves the reason line as it
 * was until the frame callback answers, the same window in which the dimming waits.
 *
 * The setter runs during the render only when the value changes, which is the React pattern
 * for state derived from the previous render.
 */
function useSettledReason(
  presented: EditDisabledReason,
): TransportDisabledReasonKey | null {
  const [shown, setShown] = useState<TransportDisabledReasonKey | null>(null);
  const next = settleDisabledReason(shown, presented);
  if (next !== shown) {
    setShown(next);
  }
  return next;
}

export function TransportBar() {
  const { t } = useTranslation();
  const shortcutOf = useShortcutLabels();
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
  // Every condition below is shared with the window keyboard layer (ADR 026).
  const hasActiveSource = usePlaybackStore((s) =>
    isSourceActive(hasMedia, s.isAttached, s.isReady),
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

  // The reasons read the same facts as the three conditions above. Each selector settles on a
  // key or null, so a frame that does not change the reason does not render this tree.
  const reasonContext = useMemo<EditReasonContext>(
    () => ({ hasActiveSource, pendingInPts, currentTarget }),
    [hasActiveSource, pendingInPts, currentTarget],
  );
  const markInReason = useSettledReason(
    usePlaybackStore((s) => presentEditDisabledReason("markIn", s, reasonContext)),
  );
  const markOutReason = useSettledReason(
    usePlaybackStore((s) => presentEditDisabledReason("markOut", s, reasonContext)),
  );
  const splitReason = useSettledReason(
    usePlaybackStore((s) => presentEditDisabledReason("split", s, reasonContext)),
  );
  const stepReason = presentStepDisabledReason(hasActiveSource, hasNominalRate);
  const reasonText = (key: TransportDisabledReasonKey | null) =>
    key === null ? null : t(key);
  // Each disabled-reason element is always in the document, and its button names it in
  // `aria-describedby`, so assistive technology reads the reason on the button itself. The
  // tooltip only opens on hover or focus, and a disabled button takes neither.
  const markInReasonId = useId();
  const markOutReasonId = useId();
  const splitReasonId = useId();
  const previousStepReasonId = useId();
  const nextStepReasonId = useId();

  // Every key name comes from the binding table (ADR 026).
  const undoShortcut = shortcutOf("undo");
  const redoShortcut = shortcutOf("redo");
  const markInShortcut = shortcutOf("markIn");
  const markOutShortcut = shortcutOf("markOut");
  const newSegmentShortcut = shortcutOf("finishSegment");
  const deleteSegmentShortcut = shortcutOf("deleteSegment");
  const previousStepShortcut = shortcutOf("stepBackOneFrame");
  const playShortcut = shortcutOf("togglePlayback");
  const nextStepShortcut = shortcutOf("stepForwardOneFrame");

  const isUndoDisabled = !canUndoEdit(hasActiveSource, canUndo);
  const isRedoDisabled = !canRedoEdit(hasActiveSource, canRedo);
  const isMarkInDisabled = !isMarkInEnabled;
  const isMarkOutDisabled = !isMarkOutEnabled;
  const isSplitDisabled = !isSplitEnabled;
  const isNewSegmentDisabled = !canFinishSegment(
    hasActiveSource,
    currentSegment,
    pendingInPts,
  );
  const isDeleteSegmentDisabled = !canDeleteSegment(hasActiveSource, currentSegment);
  const isStepDisabled = !canStepFrames(hasActiveSource, hasNominalRate);
  const isPlayDisabled = !canTogglePlayback(hasActiveSource);

  return (
    <section className="flex h-[72px] shrink-0 items-center justify-center border-y border-border bg-card px-4 select-none">
      <div className="flex items-center gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                disabled={isUndoDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={undo}
                className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.undo")}
                aria-keyshortcuts={undoShortcut?.aria}
              >
                <Undo2 className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.undo")}
                </span>
              </Button>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.undo")}
              keys={undoShortcut?.keys}
            />
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                disabled={isRedoDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={redo}
                className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("transport.action.redo")}
                aria-keyshortcuts={redoShortcut?.aria}
              >
                <Redo2 className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.redo")}
                </span>
              </Button>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.redo")}
              keys={redoShortcut?.keys}
            />
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 2: Mark points and cut tools (In, Out, Split) */}
        {/*
          Every seek clears presentedFrame until RVFC reports a frame (ADR 022), which
          disables these three for a few frames on each step. Only the dimming waits 150 ms:
          a delay set in the disabled state applies on the way in, and a return inside it
          cancels the fade. Reduced motion drops the fade and keeps the delay. The reason
          line keeps its last value for that window (useSettledReason), so it does not
          change on each step either.

          A disabled button takes no pointer events, so its own tooltip could never open. The
          span around it is the tooltip trigger: it takes the pointer while the button is
          disabled, and the pointer and focus events of an enabled button reach it by
          bubbling. The span has no tabIndex, so it never takes the focus and the Tab order
          does not change.
        */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
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
                  aria-describedby={markInReasonId}
                  aria-keyshortcuts={markInShortcut?.aria}
                >
                  <ArrowRightToLine className="size-4 text-muted-foreground" />
                  <span className="text-xs font-semibold">
                    {t("transport.action.markIn")}
                  </span>
                </Button>
                <span id={markInReasonId} className="sr-only">
                  {reasonText(markInReason)}
                </span>
              </span>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.markInAria")}
              keys={markInShortcut?.keys}
              reason={reasonText(markInReason)}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
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
                  aria-describedby={markOutReasonId}
                  aria-keyshortcuts={markOutShortcut?.aria}
                >
                  <ArrowLeftToLine className="size-4 text-muted-foreground" />
                  <span className="text-xs font-semibold">
                    {t("transport.action.markOut")}
                  </span>
                </Button>
                <span id={markOutReasonId} className="sr-only">
                  {reasonText(markOutReason)}
                </span>
              </span>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.markOutAria")}
              keys={markOutShortcut?.keys}
              reason={reasonText(markOutReason)}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
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
                  aria-describedby={splitReasonId}
                >
                  <Scissors className="size-4 text-muted-foreground" />
                  <span className="text-xs font-semibold">
                    {t("transport.action.split")}
                  </span>
                </Button>
                <span id={splitReasonId} className="sr-only">
                  {reasonText(splitReason)}
                </span>
              </span>
            </TooltipTrigger>
            {/* Split has no binding in the table of ADR 026, so its tooltip shows no key. */}
            <ShortcutTooltipContent
              label={t("transport.action.splitAria")}
              reason={reasonText(splitReason)}
            />
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
                aria-keyshortcuts={newSegmentShortcut?.aria}
              >
                <SquarePlus className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.newSegment")}
                </span>
              </Button>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.newSegmentAria")}
              keys={newSegmentShortcut?.keys}
            />
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
                aria-keyshortcuts={deleteSegmentShortcut?.aria}
              >
                <Trash2 className="size-4" />
                <span className="text-2xs leading-none font-medium">
                  {t("transport.action.deleteSegment")}
                </span>
              </Button>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.deleteSegmentAria")}
              keys={deleteSegmentShortcut?.keys}
            />
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 4: Playback Controls (Previous / Next nominal step, Play/Pause) */}
        {/* The two step buttons take the same trigger span as the edit buttons, so their
            tooltip can say why they are disabled. */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={isStepDisabled}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => seekNominal(-1)}
                  className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("transport.action.previousStep")}
                  aria-describedby={previousStepReasonId}
                  aria-keyshortcuts={previousStepShortcut?.aria}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span id={previousStepReasonId} className="sr-only">
                  {reasonText(stepReason)}
                </span>
              </span>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.previousStep")}
              keys={previousStepShortcut?.keys}
              reason={reasonText(stepReason)}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                disabled={isPlayDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={togglePlayback}
                className="size-11 rounded-lg bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:bg-primary-active"
                aria-label={
                  isPlaying ? t("transport.action.pause") : t("transport.action.play")
                }
                aria-keyshortcuts={playShortcut?.aria}
              >
                {isPlaying ? (
                  <Pause className="size-5 fill-current" />
                ) : (
                  <Play className="size-5 fill-current" />
                )}
              </Button>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={
                isPlaying ? t("transport.action.pause") : t("transport.action.play")
              }
              keys={playShortcut?.keys}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={isStepDisabled}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => seekNominal(1)}
                  className="size-10 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("transport.action.nextStep")}
                  aria-describedby={nextStepReasonId}
                  aria-keyshortcuts={nextStepShortcut?.aria}
                >
                  <ChevronRight className="size-4" />
                </Button>
                <span id={nextStepReasonId} className="sr-only">
                  {reasonText(stepReason)}
                </span>
              </span>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.nextStep")}
              keys={nextStepShortcut?.keys}
              reason={reasonText(stepReason)}
            />
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
