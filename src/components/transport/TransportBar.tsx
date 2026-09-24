import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  Scissors,
  SquarePlus,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
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
  previewMutePreferenceStore,
  usePreviewMutePreference,
} from "@/features/settings/previewMutePreference";
import {
  canMarkIn,
  canMarkOut,
  canSplitCurrentSegment,
  findCurrentSegment,
  getCurrentSegmentTarget,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { cn } from "@/lib/utils";
import { FrameStepButton } from "./FrameStepButton";
import { MarkInIcon, MarkOutIcon } from "./markPointIcons";
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

// The preference action never changes, so it is read once.
const { toggleMuted } = previewMutePreferenceStore.getState();

// A transport button does not keep the focus after a mouse click (`preventFocusOnMouseDown`).
// The window shortcut layer takes Space from a focused button. Without this rule a user who
// pressed an edit action with the mouse and then pressed Space repeated that action instead of
// starting playback. A button reached with the Tab key still takes the focus, and Enter still
// operates it.

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
  const markInPendingId = useId();
  const markOutReasonId = useId();
  const splitReasonId = useId();

  // While an In mark waits for its Out mark, Mark In shows it in the primary tint. The button is
  // not a toggle, so it takes no `aria-pressed`: a pressed state would say that a second press
  // clears the mark, and a second press moves it. The state is a description instead, which the
  // button names in `aria-describedby`, and the second line of the tooltip when no reason
  // takes that line.
  const isInPending = hasActiveSource && pendingInPts !== null;
  const markInPendingText = isInPending ? t("transport.state.inPending") : null;

  const isMuted = usePreviewMutePreference((s) => s.muted);

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

  /*
   * The bar is three columns. The play group sits in the centre column, so Play is in the
   * middle of the window at every width. The left column holds the history and the mark
   * groups, packed against the play group, and the right column holds the segment group and
   * the mute toggle, packed the same way. The two outer columns are one fraction each, so they
   * are always of equal width, which is what keeps the centre column centred. At the minimum
   * window width of 1024 px, each outer column is 410 px wide, and the left one holds 375 px
   * of controls in English and 388 px in Chinese. A column never shrinks below its content, so
   * a longer label moves the play group off the centre and does not make the controls overlap.
   *
   * Every button is 40 px high, and Play is 44 px. A button with its label under the icon
   * takes the 40 px row size, with the flex direction and the padding changed for the stack,
   * and it keeps the 48 px width of the earlier square size.
   */
  return (
    <section className="grid h-[72px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-y border-border bg-card px-4 select-none">
      <div className="flex items-center justify-end gap-4">
        {/* Group 1: History (Undo / Redo with icon over label) */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="tool-ghost"
                size="tool-row"
                className="min-w-12 flex-col gap-0.5 px-1.5"
                disabled={isUndoDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={undo}
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
                variant="tool-ghost"
                size="tool-row"
                className="min-w-12 flex-col gap-0.5 px-1.5"
                disabled={isRedoDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={redo}
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
                {/* The pending state keeps the label in the foreground colour: the primary
                    text on its own tint is below 4.5:1 in the light theme. The border, the
                    fill and the glyph carry the tint. */}
                <Button
                  variant="tool"
                  size="tool-row"
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
                  className={cn(
                    "disabled:delay-150 motion-reduce:duration-0",
                    isInPending &&
                      "border-primary bg-primary/10 hover:bg-primary/15 active:bg-primary/20",
                  )}
                  aria-label={t("transport.action.markInAria")}
                  aria-describedby={`${markInReasonId} ${markInPendingId}`}
                  aria-keyshortcuts={markInShortcut?.aria}
                >
                  <MarkInIcon
                    className={cn(
                      "size-4",
                      isInPending ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-xs font-semibold">
                    {t("transport.action.markIn")}
                  </span>
                </Button>
                <span id={markInReasonId} className="sr-only">
                  {reasonText(markInReason)}
                </span>
                <span id={markInPendingId} className="sr-only">
                  {markInPendingText}
                </span>
              </span>
            </TooltipTrigger>
            <ShortcutTooltipContent
              label={t("transport.action.markInAria")}
              keys={markInShortcut?.keys}
              reason={reasonText(markInReason) ?? markInPendingText}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="tool"
                  size="tool-row"
                  disabled={isMarkOutDisabled}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    const frame = playbackStore.getState().presentedFrame;
                    if (frame) {
                      markOut(frame.inferredSourcePts);
                    }
                  }}
                  className="disabled:delay-150 motion-reduce:duration-0"
                  aria-label={t("transport.action.markOutAria")}
                  aria-describedby={markOutReasonId}
                  aria-keyshortcuts={markOutShortcut?.aria}
                >
                  <MarkOutIcon className="size-4 text-muted-foreground" />
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
                  variant="tool"
                  size="tool-row"
                  disabled={isSplitDisabled}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    const frame = playbackStore.getState().presentedFrame;
                    if (frame) {
                      split(frame.inferredSourcePts);
                    }
                  }}
                  className="disabled:delay-150 motion-reduce:duration-0"
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
      </div>

      {/* Group 3: Playback Controls (Previous / Next nominal step, Play/Pause), in the centre
          column. The two step buttons repeat while they are held (FrameStepButton). */}
      <div className="flex items-center gap-2">
        <FrameStepButton
          delta={-1}
          disabled={isStepDisabled}
          label={t("transport.action.previousStep")}
          shortcut={previousStepShortcut}
          reason={reasonText(stepReason)}
        >
          <ChevronLeft className="size-4" />
        </FrameStepButton>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="tool-icon-lg"
              disabled={isPlayDisabled}
              onMouseDown={preventFocusOnMouseDown}
              onClick={togglePlayback}
              className="shadow-xs"
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
            label={isPlaying ? t("transport.action.pause") : t("transport.action.play")}
            keys={playShortcut?.keys}
          />
        </Tooltip>

        <FrameStepButton
          delta={1}
          disabled={isStepDisabled}
          label={t("transport.action.nextStep")}
          shortcut={nextStepShortcut}
          reason={reasonText(stepReason)}
        >
          <ChevronRight className="size-4" />
        </FrameStepButton>
      </div>

      <div className="flex items-center justify-start gap-4">
        <Separator orientation="vertical" className="h-8 bg-border" />

        {/* Group 4: Current segment (New / Delete, icon over label) */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="tool-ghost"
                size="tool-row"
                className="min-w-12 flex-col gap-0.5 px-1.5"
                disabled={isNewSegmentDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={newSegment}
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
                variant="tool-ghost"
                size="tool-row"
                className="min-w-12 flex-col gap-0.5 px-1.5"
                disabled={isDeleteSegmentDisabled}
                onMouseDown={preventFocusOnMouseDown}
                onClick={deleteSegment}
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

        {/* Group 5: Mute. A preference and not an edit action, so it needs no source and is
            never disabled. The name stays the same in both states, and aria-pressed says
            whether it is on, so a screen reader does not hear a name that changes with the
            state. The glyph and the fill show the state to the eye. While it is on, hover
            goes one step past the rest fill, and press mixes the hover fill 5% toward the
            foreground, the press of the secondary variant, so a press still shows. It has no
            key: the free conventional key of media players, M, is the marker key of the
            editors that ADR 026 follows. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="tool-ghost"
              size="tool-icon"
              onMouseDown={preventFocusOnMouseDown}
              onClick={toggleMuted}
              className="aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:hover:bg-secondary-hover aria-pressed:active:bg-[color-mix(in_oklab,var(--secondary-hover),var(--foreground)_5%)]"
              aria-label={t("transport.action.mute")}
              aria-pressed={isMuted}
            >
              {isMuted ? (
                <VolumeX className="size-4" />
              ) : (
                <Volume2 className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <ShortcutTooltipContent label={t("transport.action.mute")} />
        </Tooltip>
      </div>
    </section>
  );
}
