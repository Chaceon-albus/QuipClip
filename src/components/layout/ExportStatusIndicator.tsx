import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import { ProgressBar } from "@/components/common/ProgressBar";
import { revealLabelKey } from "@/components/export/exportFinishedPresenter";
import { formatRemaining } from "@/components/export/exportProgressPresenter";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useExportOutputActionStore,
  useExportPanelStore,
  useExportStore,
  type ExportError,
} from "@/features/export";
import { getResolvedLanguage } from "@/i18n";
import { isMacOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  announcementKeyOf,
  decideFocusRestore,
  focusInsideAfterBlur,
  formatIndicatorLine,
  liveStopFailureOf,
  presentExportIndicator,
  presentStopFailureAnnouncement,
  resultLabelKey,
  type ExportIndicatorView,
  type ExportResultKind,
  type IndicatorSlot,
  type IndicatorTranslate,
} from "./exportIndicatorPresenter";
import { statusBarItem } from "./statusBarItem";

/**
 * The entry of the indicator and of each new state: a short fade and a 4px rise. Under
 * `prefers-reduced-motion`, the reduced-motion rule in globals.css removes the rise and keeps
 * the fade.
 */
const ENTRY_CLASS =
  "animate-in duration-(--motion-base) ease-enter fade-in-0 slide-in-from-bottom-1";

/**
 * The fixed-width slots of the percent and the time estimate. The digits are tabular, so a
 * slot that fits its widest value keeps the progress bar and the separators still while the
 * numbers change. The values are right-aligned, like a column of numbers.
 *
 * `1ch` is the advance of the proportional Geist "0". A tabular Geist digit is 0.91ch, a
 * colon 0.45ch, and the percent sign 1.21ch. The digits, the colon and the percent sign are
 * Latin in both catalogs, so Geist draws them in `zh-CN` too.
 *
 * - The percent stops at 99 while the status is `running` (ADR 025), so "99%" is the widest
 *   value. `Intl.NumberFormat` gives "99%" in `en` and in `zh-CN`. It is 3.02ch.
 * - The time estimate is "m:ss" below one hour (`formatRemaining`), so "59:59" is the widest
 *   value below one hour. It is 4.07ch. An estimate of one hour or more is wider and widens
 *   the slot. The line then moves once, when the estimate falls below one hour.
 *
 * Each width adds about 0.2ch to the measured value, so rounding does not decide the width.
 */
const SLOT_CLASS: Record<IndicatorSlot, string> = {
  percent: "inline-block min-w-[3.25ch] text-right",
  time: "inline-block min-w-[4.25ch] text-right",
};

/**
 * Status bar export progress and result indicator.
 *
 * Subscribes to the export store and panel store directly as a leaf component
 * so high-frequency progress updates do not re-render the status bar.
 * Renders nothing visible when the export dialog is open or when status is idle (ADR 025).
 *
 * Sizing follows the status bar rule: every control is 24px tall, a standalone icon button
 * is a 24px box with a 16px glyph, and an icon inline with text is 14px. The progress item
 * and the result item are `statusBarItem` boxes. The dismiss X and the show-in-folder button
 * of a finished run get the full 24px box but keep the 14px glyph, because they sit next to
 * the result text they act on. Each vertical separator is 16px tall, the height of a 16px
 * glyph. `data-vertical:self-center` replaces the Separator's own `self-stretch`, which puts
 * an item with a fixed height at the top of the row instead of at its centre.
 *
 * Motion: the indicator enters with a fade and a small rise. The content is keyed on the view
 * kind, so a run that ends gives its result its own entry. A finished result also flashes the
 * success tint once. Under `prefers-reduced-motion`, the entry only fades and the flash does
 * not run. When the kind changes while the focus is inside the indicator, the first button of
 * the new content takes the focus, so a keyboard user keeps the place.
 *
 * A `failed` status that the store still tracks shows as an active item, with the line "Stop
 * failed · export continues". A Stop that fails at the IPC layer gives that state, and the
 * backend still encodes. The item offers no dismiss X, because a reset would drop the only
 * record of the run. The live region announces the failure once, and no result, because the
 * run has not ended.
 *
 * The polite live region is always mounted, because a screen reader announces a change of
 * its content and not a region that appears with its content. It receives the result of a
 * run that ended while the dialog was hidden, and each failed Stop request that the dialog
 * did not show (`presentStopFailureAnnouncement`). No progress change is announced. It holds
 * text only, no control.
 */
export function ExportStatusIndicator() {
  const { t } = useTranslation();
  const panelOpen = useExportPanelStore((state) => state.open);
  const show = useExportPanelStore((state) => state.show);
  const reset = useExportStore((state) => state.reset);
  const runId = useExportStore((state) => state.runId);

  const exportData = useExportStore(
    useShallow((state) => ({
      status: state.status,
      frame: state.frame,
      expectedFrames: state.expectedFrames,
      fps: state.fps,
      speed: state.speed,
      cancelRequested: state.cancelRequested,
      outputPath: state.outputPath,
      tracking: state.tracking,
      encodeStarted: state.encodeStarted,
    })),
  );

  const view = useMemo(
    () =>
      presentExportIndicator({
        ...exportData,
        panelOpen,
      }),
    [exportData, panelOpen],
  );

  // The failure of a Stop request while the run continues. It is one error instance for one
  // failure, so a progress event does not change it.
  const stopFailure = useExportStore(liveStopFailureOf);
  // The last failure that the open dialog showed. The dialog announced it, so the region
  // does not announce it again when the dialog hides. The update during render is the React
  // pattern for state that follows other state: React renders again at once.
  const [shownFailure, setShownFailure] = useState<ExportError | null>(null);
  const stopFailureAnnouncement = presentStopFailureAnnouncement({
    failure: stopFailure,
    panelOpen,
    shownFailure,
  });
  if (stopFailureAnnouncement.shownFailure !== shownFailure) {
    setShownFailure(stopFailureAnnouncement.shownFailure);
  }

  const announcementKey = announcementKeyOf(view) ?? stopFailureAnnouncement.key;

  // The keyed wrapper remounts when the view kind changes, and the focused button goes with
  // it. The browser then puts the focus on the body, and a keyboard user loses the place.
  // These refs note whether the focus is inside the wrapper, so the first button of the new
  // content can take it back.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const focusInsideRef = useRef(false);
  const viewKind = view?.kind ?? null;

  const handleFocusCapture = () => {
    focusInsideRef.current = true;
  };

  // `focusInsideAfterBlur` holds the rule. Chromium also fires a blur when React removes the
  // focused button. That blur does not reach this handler, because React does not dispatch
  // events during its commit.
  const handleBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    focusInsideRef.current = focusInsideAfterBlur({
      nextTarget:
        next instanceof Node
          ? event.currentTarget.contains(next)
            ? "inside"
            : "outside"
          : "none",
      documentHasFocus: document.hasFocus(),
    });
  };

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const active = document.activeElement;
    const decision = decideFocusRestore({
      focusWasInside: focusInsideRef.current,
      wrapperExists: wrapper !== null,
      activeElement:
        active === null || active === document.body
          ? "none"
          : wrapper?.contains(active)
            ? "inside"
            : "outside",
    });
    if (!decision.restore) {
      focusInsideRef.current = decision.focusInside;
      return;
    }
    const target = wrapper?.querySelector<HTMLElement>("button") ?? null;
    if (target === null) {
      focusInsideRef.current = false;
      return;
    }
    target.focus();
  }, [viewKind]);

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcementKey !== null ? t(announcementKey) : ""}
      </span>
      {view !== null && (
        <>
          <div
            key={view.kind}
            ref={wrapperRef}
            className={cn("flex items-center", ENTRY_CLASS)}
            onFocusCapture={handleFocusCapture}
            onBlurCapture={handleBlurCapture}
          >
            {view.kind === "active" ? (
              <ActiveExportItem view={view} onShow={show} />
            ) : (
              <ExportResultItem
                kind={view.kind}
                outputName={view.outputName}
                canDismiss={view.canDismiss}
                runId={runId}
                onShow={show}
                onDismiss={reset}
              />
            )}
          </div>
          <Separator
            orientation="vertical"
            className={cn(
              "mx-1.5 h-4 bg-border data-vertical:self-center",
              ENTRY_CLASS,
            )}
          />
        </>
      )}
    </>
  );
}

type ActiveView = Extract<ExportIndicatorView, { kind: "active" }>;

/** The progress bar, the percent, and the time estimate of a run behind the editor. */
function ActiveExportItem({ view, onShow }: { view: ActiveView; onShow: () => void }) {
  const { t, i18n } = useTranslation();
  const resolvedLanguage = getResolvedLanguage(i18n);

  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        style: "percent",
        maximumFractionDigits: 0,
      }),
    [resolvedLanguage],
  );

  const frameFormatter = useMemo(
    () => new Intl.NumberFormat(resolvedLanguage),
    [resolvedLanguage],
  );

  const { progress } = view;
  // The line keys take plain string values. This view of `t` accepts them without a cast
  // at each call, as in StatusBar.
  const line = formatIndicatorLine(view.line, t as IndicatorTranslate, (fraction) =>
    percentFormatter.format(fraction),
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onShow}
          aria-label={line.label}
          className={cn(statusBarItem({ interactive: true }), "gap-2")}
        >
          <ProgressBar
            size="xs"
            className="w-24 shrink-0"
            value={progress.barValue}
            flowing={progress.phase !== "canceling"}
            aria-hidden
          />
          <span className="whitespace-nowrap tabular-nums">
            {line.parts.map((part, index) =>
              part.kind === "text" ? (
                <Fragment key={index}>{part.text}</Fragment>
              ) : (
                <span key={index} className={SLOT_CLASS[part.slot]}>
                  {line.slotText[part.slot]}
                </span>
              ),
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
        {view.outputName && (
          <p className="break-all">
            {t("statusBar.export.output", { name: view.outputName })}
          </p>
        )}
        {progress.frame !== null && progress.expectedFrames !== null && (
          <p>
            {t("export.status.frames", {
              frame: frameFormatter.format(progress.frame),
              expectedFrames: frameFormatter.format(progress.expectedFrames),
            })}
          </p>
        )}
        {progress.remainingSeconds !== null && (
          <p>
            {t("statusBar.export.remaining", {
              time: formatRemaining(progress.remainingSeconds),
            })}
          </p>
        )}
        <p>{t("statusBar.export.showHint")}</p>
      </TooltipContent>
    </Tooltip>
  );
}

const RESULT_ICON: Record<ExportResultKind, ReactElement> = {
  finished: <CircleCheck aria-hidden="true" className="size-3.5 text-success" />,
  failed: <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />,
  canceled: (
    <CircleSlash
      aria-hidden="true"
      className="size-3.5 text-muted-foreground transition-colors window-inactive:text-muted-foreground-inactive"
    />
  ),
};

/**
 * The quieter colour of a chrome icon button of the result while the window does not have the
 * focus, as every other icon of the status bar takes it. An icon needs 3:1, and the inactive
 * colour keeps 3.98:1 also on the success flash.
 */
const INACTIVE_ICON_BUTTON_CLASS = "window-inactive:text-muted-foreground-inactive";

/** The result of a run that ended behind the editor, with Show and Dismiss (ADR 029). */
function ExportResultItem({
  kind,
  outputName,
  canDismiss,
  runId,
  onShow,
  onDismiss,
}: {
  kind: ExportResultKind;
  outputName: string | null;
  canDismiss: boolean;
  runId: string | null;
  onShow: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const outputActionPending = useExportOutputActionStore((state) => state.pending);
  const runOutputAction = useExportOutputActionStore((state) => state.run);

  const revealLabel = t(revealLabelKey(isMacOS()));
  const canReveal = kind === "finished" && runId !== null;
  const revealBusy =
    outputActionPending !== null &&
    outputActionPending.runId === runId &&
    outputActionPending.action === "reveal";

  // The status bar has no room for an error message. A failed request opens the dialog,
  // which shows the message inline for this run.
  const handleReveal = async () => {
    if (runId === null) {
      return;
    }
    const outcome = await runOutputAction("reveal", runId);
    if (outcome === "failed") {
      onShow();
    }
  };

  // The flash is on this group and not on the keyed wrapper around it: both are CSS
  // animations, and one element runs only one `animation` value.
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md",
        kind === "finished" && "animate-success-flash motion-reduce:animate-none",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          {/* While the window does not have the focus, a status bar label goes one step
              quieter. On the success flash the quieter colour keeps only 3.98:1, so the label
              of a finished export runs a text animation with the flash: it holds the active
              colour while the tint holds, and fades to its own colour while the tint fades
              (globals.css). After the flash the label takes the quieter colour. */}
          <button
            type="button"
            onClick={onShow}
            className={cn(
              statusBarItem({ interactive: true }),
              kind === "finished" &&
                "animate-success-flash-text motion-reduce:animate-none",
            )}
          >
            {RESULT_ICON[kind]}
            <span className="whitespace-nowrap">{t(resultLabelKey(kind))}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
          {outputName && (
            <p className="break-all">
              {t("statusBar.export.output", { name: outputName })}
            </p>
          )}
          <p>{t("statusBar.export.showHint")}</p>
        </TooltipContent>
      </Tooltip>
      {canReveal && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chrome"
              size="icon-xs"
              className={INACTIVE_ICON_BUTTON_CLASS}
              aria-label={revealLabel}
              aria-busy={revealBusy || undefined}
              onClick={() => void handleReveal()}
            >
              {revealBusy ? (
                <Loader2
                  aria-hidden="true"
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                />
              ) : (
                <FolderOpen className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{revealLabel}</TooltipContent>
        </Tooltip>
      )}
      {/* No dismissal while the run is live: the reset would drop the only record of a run
          that the backend still encodes. */}
      {canDismiss && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chrome"
              size="icon-xs"
              className={INACTIVE_ICON_BUTTON_CLASS}
              aria-label={t("statusBar.export.dismiss")}
              onClick={onDismiss}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("statusBar.export.dismiss")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
