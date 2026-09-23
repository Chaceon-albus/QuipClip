import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  confirmExportFlow,
  runExportFlow,
} from "@/components/layout/exportFlowController";
import { useExportStore } from "@/features/export";
import { openMediaFileDialog } from "@/features/media";
import { useSettingsStore } from "@/features/settings";
import { getResolvedLanguage } from "@/i18n";
import { ExportSetup } from "./ExportSetup";
import {
  isCancelEnabled,
  isCancelOutstanding,
  isExportDismissalRefused,
} from "./exportCancelState";
import { presentExportError } from "./exportErrorPresenter";
import { presentSetupBlocker, resolveSetupPresetId } from "./exportSetupPresenter";

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
 * Progress readout for a running export.
 *
 * `frame` is written once per drained ffmpeg `-progress` block, so it changes many times
 * per second for the whole encode. It is subscribed HERE, in a leaf, rather than in
 * `ExportDialog`, so a progress write re-renders this element alone instead of the whole
 * Radix dialog subtree. The observable output is identical.
 */
function ExportProgress({ formatter }: { formatter: Intl.NumberFormat }) {
  const { t } = useTranslation();
  const frame = useExportStore((state) => state.frame);
  const expectedFrames = useExportStore((state) => state.expectedFrames);

  return (
    <div className="space-y-3 py-2">
      <div className="text-sm text-muted-foreground">
        {frame !== null && expectedFrames !== null
          ? t("export.status.progress", {
              frame: formatter.format(frame),
              expectedFrames: formatter.format(expectedFrames),
            })
          : t("export.status.running")}
      </div>
      {frame !== null && expectedFrames !== null && expectedFrames > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-primary transition-all duration-150"
            style={{
              width: `${Math.min(100, Math.max(0, (frame / expectedFrames) * 100))}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  onExportAnyway,
  onReimport,
}: ExportDialogProps) {
  const { t, i18n } = useTranslation();
  // Holds the run the user asked to cancel. Keying the flag to a run id, instead of
  // holding a plain boolean, makes the canceling state derived: a new export carries a
  // new run id, so the flag stops applying the moment the flow restarts.
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);
  // Holds the cancel the user asked for in the one phase that has no run id to key it to.
  // `isCancelOutstanding` is keyed to a run id and cannot see this one, so the dialog holds it
  // itself and scopes it below to the phase it can apply in.
  const [unnamedCancelPending, setUnnamedCancelPending] = useState(false);
  // Holds the preset id requested by the user during the setup step. When null, the dialog
  // falls back to the settings activePresetId or first preset (ADR 024).
  const [requestedPresetId, setRequestedPresetId] = useState<string | null>(null);
  // Guard against double clicks triggering multiple concurrent native save dialogs.
  const [choosingDestination, setChoosingDestination] = useState(false);

  const status = useExportStore((state) => state.status);
  const runId = useExportStore((state) => state.runId);
  const error = useExportStore((state) => state.error);
  const cancelExport = useExportStore((state) => state.cancelExport);
  const reset = useExportStore((state) => state.reset);

  const settings = useSettingsStore((state) => state.settings);
  const effectivePresetId = resolveSetupPresetId(settings, requestedPresetId);
  const selectedPreset =
    settings?.presets.find((preset) => preset.id === effectivePresetId) ?? null;
  const blocker = presentSetupBlocker(selectedPreset);
  const exportDisabled =
    effectivePresetId === null || blocker !== null || choosingDestination;

  // All three derived values live in a pure module, so their rules carry their own tests.
  const isRunning = isExportDismissalRefused({ status, runId });
  // The by-slot cancel names no run, so the flag above stands in for the run id. Scope it to
  // the phase it applies in, the way `isCancelOutstanding` is scoped by the run id: it stops
  // applying as soon as the store learns an id or leaves "preparing".
  const unnamedCanceling =
    unnamedCancelPending && status === "preparing" && runId === null;
  const canceling =
    isCancelOutstanding({ status, runId, cancelingRunId }) || unnamedCanceling;
  const cancelEnabled =
    isCancelEnabled({ status, runId, cancelingRunId }) && !unnamedCanceling;
  // The footer offers Cancel in every phase where a run is in progress. "preparing" with no
  // run id is one of them: it stays dismissable, but Cancel now reaches the backend there, so
  // offering Close alone would hide the control that phase most needs. An outstanding unnamed
  // cancel keeps the button in place while it is disabled, instead of swapping it for Close.
  const showCancel = isRunning || cancelEnabled || unnamedCanceling;

  const resolvedLanguage = getResolvedLanguage(i18n);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(resolvedLanguage),
    [resolvedLanguage],
  );

  const errorView = presentExportError(error);

  // Walking away during "preparing" before the backend answered used to orphan the run: the
  // store never learned the run id, so it could never name one to cancel. It no longer has to
  // name one -- the store cancels by slot in that phase -- so every dismissal path asks the
  // backend to stop before it resets. Fired and not awaited, because the dialog closes at once
  // and the store owns whatever the backend answers.
  const cancelUnnamedRun = () => {
    if (status === "preparing" && runId === null) {
      void cancelExport();
    }
  };

  const handleClose = () => {
    cancelUnnamedRun();
    onOpenChange(false);
    setCancelingRunId(null);
    setUnnamedCancelPending(false);
    setRequestedPresetId(null);
    setChoosingDestination(false);
    reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isRunning) {
        return;
      }
      cancelUnnamedRun();
      setCancelingRunId(null);
      setUnnamedCancelPending(false);
      setRequestedPresetId(null);
      setChoosingDestination(false);
      reset();
    }
    onOpenChange(nextOpen);
  };

  // The replacement confirmation is not a failure the user can only close: it carries its own
  // three actions, so the standard footer is replaced while it shows.
  const isSourceRevisionConfirmation =
    status === "failed" && error?.code === "sourceRevisionChanged";

  // Resumes the export the check refused. The store is reset and the modal closed first, so the
  // flow proceeds past the source revision check to the setup step with no stale confirmation behind it;
  // the flow re-opens the modal itself at the setup step.
  const handleExportAnyway = () => {
    handleClose();
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
    handleClose();
    if (onReimport) {
      onReimport();
      return;
    }
    void openMediaFileDialog({ filterName: t("dialog.videoFilter") });
  };

  const handleConfirmExport = async () => {
    if (!effectivePresetId || exportDisabled) {
      return;
    }
    setChoosingDestination(true);
    try {
      await confirmExportFlow(
        {
          setModalOpen: onOpenChange,
          filterName: t("dialog.videoFilter"),
        },
        effectivePresetId,
      );
    } finally {
      setChoosingDestination(false);
    }
  };

  const handleCancel = async () => {
    setCancelingRunId(runId);
    if (runId === null) {
      // The store cancels by slot here and writes no state on success, so the acknowledgement
      // has to come from the dialog. Without it the user waits out the rest of preparation --
      // up to 30 seconds for a re-probe -- with the button still reading "Cancel".
      setUnnamedCancelPending(true);
    }
    await cancelExport();
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
          />
        ) : null;

      case "preparing":
        return (
          <div className="py-2 text-sm text-muted-foreground">
            {canceling ? t("export.status.canceling") : t("export.status.preparing")}
          </div>
        );

      case "running":
        if (canceling) {
          return (
            <div className="space-y-2 py-2 text-sm text-muted-foreground">
              <div>{t("export.status.canceling")}</div>
              <p className="text-xs text-muted-foreground/80">
                {t("export.status.cancelingNote")}
              </p>
            </div>
          );
        }
        return <ExportProgress formatter={numberFormatter} />;

      case "publishing":
        if (canceling) {
          return (
            <div className="space-y-2 py-2 text-sm text-muted-foreground">
              <div>{t("export.status.canceling")}</div>
              <p className="text-xs text-muted-foreground/80">
                {t("export.status.cancelingNotePublishing")}
              </p>
            </div>
          );
        }
        return (
          <div className="py-2 text-sm text-muted-foreground">
            {t("export.status.publishing")}
          </div>
        );

      case "finished":
        return (
          <div className="py-2">
            <div
              role="status"
              className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"
            >
              {t("export.status.finished")}
            </div>
          </div>
        );

      case "failed":
      case "canceled": {
        if (isSourceRevisionConfirmation) {
          return (
            <div className="py-2">
              <div
                role="alert"
                className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
              >
                {t("exportError.sourceRevisionChanged")}
              </div>
            </div>
          );
        }

        const fallbackKey =
          status === "canceled" ? "exportError.canceled" : "exportError.unknown";
        const key = errorView?.key ?? fallbackKey;
        const values = errorView?.values;

        return (
          <div className="py-2">
            <div
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <p>
                {(t as (k: string, opts?: Record<string, string | number>) => string)(
                  key,
                  values,
                )}
              </p>
              {error?.detail && (
                <pre className="mt-2 max-h-32 overflow-y-auto font-mono text-xs whitespace-pre-wrap opacity-80 select-text">
                  {error.detail}
                </pre>
              )}
            </div>
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
        onEscapeKeyDown={(e) => {
          if (isRunning) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (isRunning) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
        </DialogHeader>

        {!isRunning && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={handleClose}
          >
            <XIcon />
            <span className="sr-only">{t("common.close")}</span>
          </Button>
        )}

        {renderContent()}

        <DialogFooter>
          {status === "idle" ? (
            open ? (
              <>
                <Button variant="outline" onClick={handleClose}>
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={exportDisabled}
                  onClick={() => void handleConfirmExport()}
                >
                  {t("export.action.chooseDestination")}
                </Button>
              </>
            ) : null
          ) : isSourceRevisionConfirmation ? (
            <>
              <Button variant="outline" onClick={handleClose}>
                {t("common.cancel")}
              </Button>
              <Button variant="outline" onClick={handleReimport}>
                {t("export.action.reimport")}
              </Button>
              <Button onClick={handleExportAnyway}>
                {t("export.action.exportAnyway")}
              </Button>
            </>
          ) : showCancel ? (
            <Button
              variant="outline"
              onClick={() => void handleCancel()}
              // Only "publishing" disables it now. The backend already ran its last cancel
              // test before it emitted the event that puts the interface into that phase
              // (ADR 016), so a cancel there cannot stop the rename, and the button would
              // report a cancel that never happened while the export still writes the file.
              // "preparing" with no run id is enabled: the store cancels by export slot when
              // it holds no id. `isCancelEnabled` holds both rules.
              disabled={!cancelEnabled}
            >
              {canceling ? t("export.status.canceling") : t("common.cancel")}
            </Button>
          ) : (
            <Button variant="outline" onClick={handleClose}>
              {t("common.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
