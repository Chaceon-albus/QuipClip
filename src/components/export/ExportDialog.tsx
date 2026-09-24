import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { CircleCheck, CircleSlash, Loader2, XIcon } from "lucide-react";
import { DESTRUCTIVE_CONFIRM_CLASS } from "@/components/common/confirmDialogModel";
import { Notice } from "@/components/common/Notice";
import { ProgressBar } from "@/components/common/ProgressBar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  confirmExportFlow,
  runExportFlow,
} from "@/components/layout/exportFlowController";
import {
  exportStore,
  useExportOutputActionStore,
  useExportStore,
  type ExportOutputAction,
} from "@/features/export";
import { openMediaFileDialog } from "@/features/media";
import {
  settingsPanelStore,
  useSettingsStore,
  type SettingsSection,
} from "@/features/settings";
import { getResolvedLanguage } from "@/i18n";
import { isMacOS } from "@/lib/platform";
import { ExportErrorDetails } from "./ExportErrorDetails";
import { ExportSetup } from "./ExportSetup";
import {
  canGoBackToSetup,
  createOpenStepGeneration,
  guardOpenStepEffects,
} from "./exportBackToSetup";
import { resolveExportDismissal } from "./exportCancelState";
import { presentExportOutcome } from "./exportErrorPresenter";
import {
  elapsedAtFinish,
  outputActionErrorKey,
  presentFinishedExport,
  revealLabelKey,
} from "./exportFinishedPresenter";
import { formatRemaining, presentExportProgress } from "./exportProgressPresenter";
import { presentSetupBlocker, resolveSetupPresetId } from "./exportSetupPresenter";
import {
  decideStopClick,
  presentStopButton,
  refreshStopArmedAt,
  stopArmRemainingMs,
  trackExportStart,
} from "./exportStopPresenter";

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;

  /**
   * Resumes a refused export, past the replacement confirmation, to the setup step.
   *
   * Defaults to re-running the export flow with the replacement check skipped. Injected so
   * this panel never has to know how an export starts.
   */
  onExportAnyway?: () => void;

  /**
   * Opens the media dialog so the user can import the file again.
   *
   * Defaults to `openMediaFileDialog`, the same action the File menu uses. Injected so an
   * error panel never reaches into the media store.
   */
  onReimport?: () => void;
}

/**
 * Progress readout for an active export.
 *
 * `frame`, `fps`, and `speed` are written once per drained ffmpeg `-progress` block, so they change
 * many times per second for the whole encode. They are subscribed HERE, in a leaf, rather than in
 * `ExportDialog`, so a progress write re-renders this element alone instead of the whole
 * Radix dialog subtree. The observable output is identical.
 */
function ExportProgress() {
  const { t, i18n } = useTranslation();
  const exportData = useExportStore(
    useShallow((state) => ({
      status: state.status,
      frame: state.frame,
      expectedFrames: state.expectedFrames,
      fps: state.fps,
      speed: state.speed,
      cancelRequested: state.cancelRequested,
    })),
  );

  const view = presentExportProgress(exportData);
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

  const speedFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [resolvedLanguage],
  );

  if (!view) {
    return null;
  }

  let title = "";
  switch (view.phase) {
    case "canceling":
      title = t("export.status.canceling");
      break;
    case "preparing":
      title = t("export.status.preparing");
      break;
    case "publishing":
      title = t("export.status.publishing");
      break;
    case "running":
      title =
        view.percentFraction !== null
          ? t("export.status.runningPercent", {
              percent: percentFormatter.format(view.percentFraction),
            })
          : t("export.status.running");
      break;
  }

  const remaining =
    view.remainingSeconds !== null
      ? t("export.status.remaining", {
          time: formatRemaining(view.remainingSeconds),
        })
      : null;

  let detail: string | null = null;
  if (view.basePhase === "running") {
    const parts: string[] = [];
    if (view.frame !== null && view.expectedFrames !== null) {
      parts.push(
        t("export.status.frames", {
          frame: frameFormatter.format(view.frame),
          expectedFrames: frameFormatter.format(view.expectedFrames),
        }),
      );
    }
    if (view.speed !== null) {
      parts.push(
        t("export.status.speed", {
          speed: speedFormatter.format(view.speed),
        }),
      );
    }
    if (parts.length > 0) {
      detail = parts.join(" · ");
    }
  }

  let cancelNote: string | null = null;
  if (view.phase === "canceling") {
    if (view.basePhase === "running") {
      cancelNote = t("export.status.cancelingNote");
    } else if (view.basePhase === "publishing") {
      cancelNote = t("export.status.cancelingNotePublishing");
    }
  }

  return (
    <div className="space-y-2 py-2">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span>{title}</span>
        {remaining && (
          <span className="text-muted-foreground tabular-nums">{remaining}</span>
        )}
      </div>
      <ProgressBar
        size="md"
        value={view.barValue}
        flowing={view.phase !== "canceling"}
        aria-label={t("export.title")}
        aria-valuetext={title}
      />
      {detail && (
        <div className="text-xs text-muted-foreground tabular-nums">{detail}</div>
      )}
      {cancelNote && <p className="text-xs text-muted-foreground/80">{cancelNote}</p>}
    </div>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  onExportAnyway,
  onReimport,
}: ExportDialogProps) {
  const { t } = useTranslation();
  // Holds the preset id requested by the user during the setup step. When null, the dialog
  // falls back to the settings activePresetId or first preset (ADR 024).
  const [requestedPresetId, setRequestedPresetId] = useState<string | null>(null);
  // Guard against double clicks triggering multiple concurrent native save dialogs.
  const [choosingDestination, setChoosingDestination] = useState(false);
  // True while the open step that Back runs again has not answered. The setup step shows
  // meanwhile, and Export stays disabled, so no export starts before the checks end.
  const [backCheckPending, setBackCheckPending] = useState(false);
  // One generation for each open step that Back starts. A close invalidates it, so a step
  // that answers after the close changes nothing (`exportBackToSetup.ts`).
  const [backStep] = useState(createOpenStepGeneration);
  // Counts the clicks on Back. The Back button leaves the document with the failed panel, so
  // the effect below gives the focus to the first control of the setup step once per click.
  const [backClicks, setBackClicks] = useState(0);
  const setupFirstControlRef = useRef<HTMLButtonElement>(null);
  // The element that held the focus when the dialog opened, or null. The settings dialog
  // gives the focus back to it, because the "Open Settings..." button is gone by then.
  const openerRef = useRef<HTMLElement | null>(null);
  // The time of the click that armed Stop Export, or null when it is not armed. The time is
  // from `performance.now()`, which is monotonic, so a change of the system clock cannot
  // shorten or lengthen the window.
  const [stopArmedAt, setStopArmedAt] = useState<number | null>(null);
  // The time the current export started, on the same clock. Only the click handler reads it,
  // so it is a ref and a change does not render the dialog again. This component stays
  // mounted while the dialog is hidden (ADR 025), so it sees every status change.
  const exportStartedAtRef = useRef<number | null>(null);
  // The time the last export took, taken when its status became `finished`, or null. The
  // finished panel shows it.
  const [finishedElapsedMs, setFinishedElapsedMs] = useState<number | null>(null);
  // The primary action of the finished panel. It takes the focus when that panel shows.
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const stopNoteId = useId();
  // Done names the result and a Show or Open error as its description.
  const finishedNoticeId = useId();
  const outputErrorId = useId();

  const status = useExportStore((state) => state.status);
  const runId = useExportStore((state) => state.runId);
  const outputPath = useExportStore((state) => state.outputPath);
  const cancelRequested = useExportStore((state) => state.cancelRequested);
  const tracking = useExportStore((state) => state.tracking);
  const error = useExportStore((state) => state.error);
  const cancelExport = useExportStore((state) => state.cancelExport);
  const reset = useExportStore((state) => state.reset);

  const outputActionPending = useExportOutputActionStore((state) => state.pending);
  const outputActionFailure = useExportOutputActionStore((state) => state.failure);
  const runOutputAction = useExportOutputActionStore((state) => state.run);

  useEffect(() => {
    const now = performance.now();
    const previousStartedAt = exportStartedAtRef.current;
    const startedAt = trackExportStart(previousStartedAt, status, now);
    exportStartedAtRef.current = startedAt;
    // The change to `finished` clears the recorded start, so the time the export took is
    // taken here, from the start that this change clears. No protocol field carries it.
    setFinishedElapsedMs(elapsedAtFinish(previousStartedAt, status, now));
    // An armed state belongs to one run. When the run is no longer active, clear it, so a
    // later run can never start with the confirmation label from this one.
    if (startedAt === null) {
      setStopArmedAt(null);
    }
  }, [status]);

  // Reverts an armed Stop Export button when its window ends. A hidden or occluded window can
  // delay the timer, so the armed time is also checked against the clock when the window
  // becomes visible or takes the focus again. The label then never stays armed after its
  // window.
  useEffect(() => {
    if (stopArmedAt === null) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        setStopArmedAt(null);
      },
      stopArmRemainingMs(stopArmedAt, performance.now()),
    );
    const refresh = () => {
      setStopArmedAt((current) => refreshStopArmedAt(current, performance.now()));
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [stopArmedAt]);

  // The finished panel replaces the footer of the run, so the button that had the focus is
  // gone. Done takes the focus, as the default button of the result.
  useEffect(() => {
    if (open && status === "finished") {
      doneButtonRef.current?.focus();
    }
  }, [open, status]);

  // Runs once for each click on Back, after the commit that the click made. That commit holds
  // the reset and any failure that the open step reported before its first await, such as
  // `sourceNotFound`, so the status read here is the one on the screen. When it is idle, the
  // setup step rendered in the same commit, and its first control exists. When the open
  // step failed, the failed panel shows and the focus stays on the dialog. No flag outlives
  // the click, so a later close or reset never moves the focus. While the settings load,
  // the step has no control, and the focus stays on the dialog too.
  useEffect(() => {
    if (backClicks === 0) {
      return;
    }
    if (exportStore.getState().status === "idle") {
      setupFirstControlRef.current?.focus();
    }
  }, [backClicks]);

  const settings = useSettingsStore((state) => state.settings);
  const effectivePresetId = resolveSetupPresetId(settings, requestedPresetId);
  const selectedPreset =
    settings?.presets.find((preset) => preset.id === effectivePresetId) ?? null;
  const blocker = presentSetupBlocker(selectedPreset);
  const exportDisabled =
    effectivePresetId === null ||
    blocker !== null ||
    choosingDestination ||
    backCheckPending;

  // Dismissal hides the dialog while an export is active (preparing, running, publishing)
  // and resets the store when in an idle or terminal status (ADR 025).
  const dismissal = resolveExportDismissal(status);
  const isActive = dismissal === "hide";
  // "publishing" always disables the button: the backend already ran its last cancel test
  // before it emitted the event that puts the interface into that phase (ADR 016), so a stop
  // there cannot stop the rename. "running" with no run id disables it, and an outstanding
  // cancel disables it in any active status. `isCancelEnabled` holds these rules keyed to
  // `cancelRequested` in the store (ADR 025), and `presentStopButton` applies them.
  const stopView = presentStopButton({
    status,
    runId,
    cancelRequested,
    armed: stopArmedAt !== null,
  });
  // The close control hides the dialog while an export is active, and the export continues.
  // The label says so, because an X usually reads as "close".
  const closeLabel = isActive ? t("export.action.hide") : t("common.close");

  const hideDialog = () => {
    setStopArmedAt(null);
    onOpenChange(false);
  };

  const closeAndReset = () => {
    backStep.invalidate();
    onOpenChange(false);
    setRequestedPresetId(null);
    setChoosingDestination(false);
    setBackCheckPending(false);
    setStopArmedAt(null);
    // The reset changes the run id, and that change clears the Show and Open state
    // (`bindOutputActionsToExportRun`).
    reset();
  };

  // The state of Show and Open shows only for the run that it names.
  const outputFailure =
    outputActionFailure !== null && outputActionFailure.runId === runId
      ? outputActionFailure
      : null;
  const busyOutputAction =
    outputActionPending !== null && outputActionPending.runId === runId
      ? outputActionPending.action
      : null;
  const canActOnOutput = runId !== null && outputPath !== null;

  // The store ignores a second request for the run while one is in flight. The busy button
  // stays enabled, with `aria-busy`, so it keeps the focus.
  const handleOutputAction = (action: ExportOutputAction) => {
    if (runId === null) {
      return;
    }
    void runOutputAction(action, runId);
  };

  const dismiss = () => {
    if (isActive) {
      hideDialog();
    } else {
      closeAndReset();
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      dismiss();
      return;
    }
    onOpenChange(true);
  };

  // The replacement confirmation is not a failure the user can only close: it carries its own
  // three actions, so the standard footer is replaced while it shows.
  const isSourceRevisionConfirmation =
    status === "failed" && error?.code === "sourceRevisionChanged";

  // The notice of a run that ended without an output, and the recovery that its footer
  // offers beside Close. Null in every other status, and for the confirmation.
  const outcome =
    (status === "failed" || status === "canceled") && !isSourceRevisionConfirmation
      ? presentExportOutcome({ status, error })
      : null;
  const recovery = outcome?.recovery ?? null;
  const recoverySettingsSection =
    recovery?.kind === "openSettings" ? recovery.section : null;

  // Resumes the export the check refused. The store is reset and the modal closed first, so the
  // flow proceeds past the source revision check to the setup step with no stale confirmation behind it;
  // the flow re-opens the modal itself at the setup step.
  const handleExportAnyway = () => {
    closeAndReset();
    if (onExportAnyway) {
      onExportAnyway();
      return;
    }
    void runExportFlow({
      setModalOpen: onOpenChange,
      filterName: t("dialog.videoFilter"),
      skipSourceRevisionCheck: true,
    });
  };

  const handleReimport = () => {
    closeAndReset();
    if (onReimport) {
      onReimport();
      return;
    }
    void openMediaFileDialog({ filterName: t("dialog.videoFilter") });
  };

  // Closes this dialog before the settings dialog opens, so two modal dialogs never show
  // together. The failed panel and the setup step offer this, and neither holds an active
  // run. The status is read at the click and not at the render, so a run that became active
  // since the render is hidden and not reset, the same as a dismissal (ADR 025).
  const handleOpenSettings = (section: SettingsSection) => {
    if (resolveExportDismissal(exportStore.getState().status) === "hide") {
      hideDialog();
    } else {
      closeAndReset();
    }
    // The settings dialog gives the focus back to the element that opened this dialog. It
    // skips an opener that left the document, such as the status bar indicator, which
    // hides while this dialog shows.
    settingsPanelStore.getState().show(section, openerRef.current);
  };

  // Goes back to the setup step after a failure. The store is reset to idle, and the open
  // step of ADR 024 runs again, the same step the Export button runs. Its checks therefore
  // see the media, the segments, and the source file as they are now, and a check that
  // fails shows its own panel. The dialog stays open, so it does not close and open again,
  // and the preset that the user chose stays selected.
  //
  // Back is offered only while the store no longer tracks the run: `failed`, and not the
  // failed stop request that leaves the backend encoding (`canGoBackToSetup`). A `failed`
  // status alone does not prove that the backend has no run. The store is read at the click
  // and not at the render. Until the step answers, Export is disabled: the source check
  // reads the file, which on a share that stopped answering can take seconds, and an export
  // must not start before it ends. A close in that time makes the step stale.
  const handleBackToSetup = () => {
    if (!canGoBackToSetup(exportStore.getState())) {
      return;
    }
    const isCurrent = backStep.begin();
    setBackClicks((count) => count + 1);
    setChoosingDestination(false);
    setStopArmedAt(null);
    setBackCheckPending(true);
    reset();
    void runExportFlow({
      ...guardOpenStepEffects(isCurrent, {
        setModalOpen: onOpenChange,
        reportError: (err) => {
          exportStore.getState().reportError(err);
        },
      }),
      filterName: t("dialog.videoFilter"),
    }).finally(() => {
      if (isCurrent()) {
        setBackCheckPending(false);
      }
    });
  };

  const handleConfirmExport = async () => {
    if (!effectivePresetId || exportDisabled) {
      return;
    }
    setChoosingDestination(true);
    try {
      const started = await confirmExportFlow(
        {
          setModalOpen: onOpenChange,
          filterName: t("dialog.videoFilter"),
        },
        effectivePresetId,
      );
      if (started) {
        // Clear the user's manual selection once the export has started so that a subsequent
        // export setup step defaults to the project's active preset (ADR 024) even if this
        // run completes while the dialog is hidden (ADR 025). The started request already
        // carries the preset id.
        setRequestedPresetId(null);
      }
    } finally {
      setChoosingDestination(false);
    }
  };

  // The first click on a long export only arms the button, and the second half of a
  // double-click is ignored. See `decideStopClick`. The rule reads the clock, and the label
  // reads `stopArmedAt`, which the timer and the refresh above clear. A timer that fires late
  // can show the confirmation label for a few milliseconds after the window. A click in that
  // gap arms the button again and does not stop, which is the safe direction.
  const handleStopClick = () => {
    if (!stopView.enabled) {
      return;
    }
    const decision = decideStopClick({
      now: performance.now(),
      startedAt: exportStartedAtRef.current,
      armedAt: stopArmedAt,
    });
    if (decision.kind === "ignore") {
      return;
    }
    if (decision.kind === "arm") {
      setStopArmedAt(decision.armedAt);
      return;
    }
    setStopArmedAt(null);
    void cancelExport();
  };

  const renderContent = () => {
    switch (status) {
      case "idle":
        return open ? (
          <ExportSetup
            selectedPresetId={effectivePresetId}
            selectedPreset={selectedPreset}
            blocker={blocker}
            onSelect={setRequestedPresetId}
            onOpenSettings={handleOpenSettings}
            firstControlRef={setupFirstControlRef}
          />
        ) : null;

      case "preparing":
      case "running":
      case "publishing":
        return <ExportProgress />;

      case "finished": {
        const finished = presentFinishedExport(outputPath, finishedElapsedMs);
        let location: string | null = null;
        if (finished?.folderName) {
          location =
            finished.elapsed !== null
              ? t("export.finished.folderAndElapsed", {
                  folder: finished.folderName,
                  elapsed: finished.elapsed,
                })
              : t("export.finished.folder", { folder: finished.folderName });
        }
        // `min-w-0` lets this grid item shrink below the width of the file name, so the name
        // truncates instead of widening the dialog.
        return (
          <div className="min-w-0 space-y-2 py-2">
            <Notice
              id={finishedNoticeId}
              tone="success"
              role="status"
              icon={CircleCheck}
            >
              <p className="font-medium">{t("export.finished.title")}</p>
              {finished && (
                // The stem truncates and the extension stays visible, as in the title bar.
                <p
                  className="mt-1 flex min-w-0 text-sm font-medium text-foreground"
                  title={finished.fullPath}
                >
                  <span className="truncate">{finished.fileStem}</span>
                  <span className="shrink-0">{finished.fileExtension}</span>
                </p>
              )}
              {location && (
                <p className="truncate text-xs text-muted-foreground" title={location}>
                  {location}
                </p>
              )}
            </Notice>
            {outputFailure && (
              <div
                id={outputErrorId}
                role="alert"
                className="text-xs text-destructive-text"
              >
                <p>{t(outputActionErrorKey(outputFailure.error.code))}</p>
                {outputFailure.error.detail && (
                  <p className="mt-1 font-mono break-all select-text">
                    {outputFailure.error.detail}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      }

      case "failed":
      case "canceled": {
        // `outcome` is null here only for the confirmation.
        if (isSourceRevisionConfirmation || outcome === null) {
          return (
            <div className="py-2">
              <Notice tone="warning" role="alert">
                {t("exportError.sourceRevisionChanged")}
              </Notice>
            </div>
          );
        }

        // A stop that the user asked for is a result, not an error, so it is neutral.
        if (outcome.kind === "canceled") {
          return (
            <div className="py-2">
              <Notice tone={outcome.tone} role={outcome.role} icon={CircleSlash}>
                {t(outcome.message.key)}
              </Notice>
            </div>
          );
        }

        // `min-w-0` lets this grid item shrink below the width of a long diagnostic line.
        return (
          <div className="min-w-0 space-y-2 py-2">
            <Notice tone={outcome.tone} role={outcome.role}>
              <p>
                {(t as (k: string, opts?: Record<string, string | number>) => string)(
                  outcome.message.key,
                  outcome.message.values,
                )}
              </p>
            </Notice>
            {outcome.detail && (
              // The key starts a new diagnostic closed, with no "Copied" left from the last.
              <ExportErrorDetails key={outcome.detail} detail={outcome.detail} />
            )}
          </div>
        );
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Radix would focus the first tabbable element, which is the close button. A Radix
          // tooltip opens on every focus that no pointer press on its trigger started, so the
          // tooltip would show on each open, and the first Escape would close the tooltip and
          // not the dialog. The dialog takes the focus instead, and Tab reaches the close
          // button first. A finished run gives the focus to Done, its default button.
          // Radix dispatches this before it moves the focus, so the active element is still
          // the element that opened the dialog.
          const opener = document.activeElement;
          openerRef.current =
            opener instanceof HTMLElement && opener !== document.body ? opener : null;
          event.preventDefault();
          const target =
            status === "finished" && doneButtonRef.current
              ? doneButtonRef.current
              : event.currentTarget;
          if (target instanceof HTMLElement) {
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
        </DialogHeader>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2"
              onClick={dismiss}
            >
              <XIcon />
              <span className="sr-only">{closeLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>

        {renderContent()}

        <DialogFooter>
          {status === "idle" ? (
            open ? (
              <>
                <Button variant="outline" onClick={closeAndReset}>
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={exportDisabled}
                  aria-busy={backCheckPending || undefined}
                  onClick={() => void handleConfirmExport()}
                >
                  {backCheckPending && (
                    <Loader2
                      aria-hidden="true"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {t("export.action.chooseDestination")}
                </Button>
              </>
            ) : null
          ) : isSourceRevisionConfirmation ? (
            <>
              <Button variant="outline" onClick={closeAndReset}>
                {t("common.cancel")}
              </Button>
              <Button variant="outline" onClick={handleReimport}>
                {t("export.action.reimport")}
              </Button>
              <Button onClick={handleExportAnyway}>
                {t("export.action.exportAnyway")}
              </Button>
            </>
          ) : isActive ? (
            <>
              {stopView.noteKey && (
                <p
                  id={stopNoteId}
                  className="self-center text-xs text-muted-foreground sm:mr-auto"
                >
                  {t(stopView.noteKey)}
                </p>
              )}
              {/* Announces the armed state. A screen reader does not reliably read a name
                  change of the focused button, and a live region must exist before its
                  content changes. */}
              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {stopView.armed ? t("export.action.stopConfirm") : ""}
              </span>
              {/* One element in every state, so the focus stays on it after the first click
                  and a second Enter confirms. */}
              <Button
                variant={stopView.appearance === "outline" ? "outline" : "default"}
                className={
                  stopView.appearance === "destructive"
                    ? DESTRUCTIVE_CONFIRM_CLASS
                    : undefined
                }
                onClick={handleStopClick}
                onKeyDown={(event) => {
                  // A held Enter repeats its keydown, and each keydown clicks the button. The
                  // repeat would confirm the stop that the first keydown armed, so only a
                  // second, separate press confirms.
                  if (event.key === "Enter" && event.repeat) {
                    event.preventDefault();
                  }
                }}
                disabled={!stopView.enabled}
                aria-describedby={stopView.noteKey ? stopNoteId : undefined}
              >
                {t(stopView.labelKey)}
              </Button>
              <Button onClick={hideDialog}>{t("export.action.runInBackground")}</Button>
            </>
          ) : status === "finished" ? (
            <>
              {canActOnOutput && (
                <>
                  <Button
                    variant="outline"
                    aria-busy={busyOutputAction === "reveal" || undefined}
                    onClick={() => handleOutputAction("reveal")}
                  >
                    {busyOutputAction === "reveal" && (
                      <Loader2
                        aria-hidden="true"
                        className="animate-spin motion-reduce:animate-none"
                      />
                    )}
                    {t(revealLabelKey(isMacOS()))}
                  </Button>
                  <Button
                    variant="secondary"
                    aria-busy={busyOutputAction === "open" || undefined}
                    onClick={() => handleOutputAction("open")}
                  >
                    {busyOutputAction === "open" && (
                      <Loader2
                        aria-hidden="true"
                        className="animate-spin motion-reduce:animate-none"
                      />
                    )}
                    {t("export.action.open")}
                  </Button>
                </>
              )}
              <Button
                ref={doneButtonRef}
                aria-describedby={
                  outputFailure
                    ? `${finishedNoticeId} ${outputErrorId}`
                    : finishedNoticeId
                }
                onClick={closeAndReset}
              >
                {t("export.action.done")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={closeAndReset}>
                {t("common.close")}
              </Button>
              {/* The recovery is the primary action, so it is the rightmost button. */}
              {recoverySettingsSection !== null && (
                <Button onClick={() => handleOpenSettings(recoverySettingsSection)}>
                  {t("export.action.openSettings")}
                </Button>
              )}
              {recovery?.kind === "backToSetup" &&
                canGoBackToSetup({ status, tracking }) && (
                  <Button onClick={handleBackToSetup}>{t("export.action.back")}</Button>
                )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
