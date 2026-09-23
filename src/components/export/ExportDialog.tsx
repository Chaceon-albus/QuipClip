import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { XIcon } from "lucide-react";
import { ProgressBar } from "@/components/common/ProgressBar";
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
  resolveExportDismissal,
} from "./exportCancelState";
import { presentExportError } from "./exportErrorPresenter";
import { formatRemaining, presentExportProgress } from "./exportProgressPresenter";
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

  const status = useExportStore((state) => state.status);
  const runId = useExportStore((state) => state.runId);
  const cancelRequested = useExportStore((state) => state.cancelRequested);
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

  // Dismissal hides the dialog while an export is active (preparing, running, publishing)
  // and resets the store when in an idle or terminal status (ADR 025).
  const dismissal = resolveExportDismissal(status);
  const isActive = dismissal === "hide";
  const canceling = isCancelOutstanding({ status, cancelRequested });
  const cancelEnabled = isCancelEnabled({ status, runId, cancelRequested });

  const errorView = presentExportError(error);

  const hideDialog = () => {
    onOpenChange(false);
  };

  const closeAndReset = () => {
    onOpenChange(false);
    setRequestedPresetId(null);
    setChoosingDestination(false);
    reset();
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

  const handleCancel = async () => {
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
      case "running":
      case "publishing":
        return <ExportProgress />;

      case "finished":
        return (
          <div className="py-2">
            <div
              role="status"
              className="rounded-md border border-success/20 bg-success/10 p-3 text-sm text-success"
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
      >
        <DialogHeader>
          <DialogTitle>{t("export.title")}</DialogTitle>
        </DialogHeader>

        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          onClick={dismiss}
        >
          <XIcon />
          <span className="sr-only">{t("common.close")}</span>
        </Button>

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
                  onClick={() => void handleConfirmExport()}
                >
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
              <Button
                variant="outline"
                onClick={() => void handleCancel()}
                // Among active statuses, "publishing" always disables it: the backend already
                // ran its last cancel test before it emitted the event that puts the interface
                // into that phase (ADR 016), so a cancel there cannot stop the rename, and the
                // button would report a cancel that never happened while the export still
                // writes the file. "running" with no run id disables it, and an outstanding
                // cancel disables it in any active status. `isCancelEnabled` holds these rules
                // keyed to `cancelRequested` in the store (ADR 025).
                disabled={!cancelEnabled}
              >
                {canceling ? t("export.status.canceling") : t("common.cancel")}
              </Button>
              <Button onClick={hideDialog}>{t("export.action.runInBackground")}</Button>
            </>
          ) : (
            <Button variant="outline" onClick={closeAndReset}>
              {t("common.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
