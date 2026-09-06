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
import { useExportStore } from "@/features/export";
import { getResolvedLanguage } from "@/i18n";
import { isCancelEnabled, isCancelOutstanding } from "./exportCancelState";
import { presentExportError } from "./exportErrorPresenter";

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { t, i18n } = useTranslation();
  // Holds the run the user asked to cancel. Keying the flag to a run id, instead of
  // holding a plain boolean, makes the canceling state derived: a new export carries a
  // new run id, so the flag stops applying the moment the flow restarts.
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);

  const status = useExportStore((state) => state.status);
  const runId = useExportStore((state) => state.runId);
  const frame = useExportStore((state) => state.frame);
  const expectedFrames = useExportStore((state) => state.expectedFrames);
  const error = useExportStore((state) => state.error);
  const cancelExport = useExportStore((state) => state.cancelExport);
  const reset = useExportStore((state) => state.reset);

  const isRunning =
    status === "preparing" || status === "running" || status === "publishing";

  // Both derived values live in a pure module, so their rules carry their own tests.
  const canceling = isCancelOutstanding({ status, runId, cancelingRunId });
  const cancelEnabled = isCancelEnabled({ status, runId, cancelingRunId });

  const resolvedLanguage = getResolvedLanguage(i18n);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(resolvedLanguage),
    [resolvedLanguage],
  );

  const errorView = presentExportError(error);

  const handleClose = () => {
    onOpenChange(false);
    setCancelingRunId(null);
    reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (isRunning) {
        return;
      }
      setCancelingRunId(null);
      reset();
    }
    onOpenChange(nextOpen);
  };

  const handleCancel = async () => {
    setCancelingRunId(runId);
    await cancelExport();
  };

  const renderContent = () => {
    switch (status) {
      case "idle":
        return null;

      case "preparing":
        return (
          <div className="py-2 text-sm text-muted-foreground">
            {t("export.status.preparing")}
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
        return (
          <div className="space-y-3 py-2">
            <div className="text-sm text-muted-foreground">
              {frame !== null && expectedFrames !== null
                ? t("export.status.progress", {
                    frame: numberFormatter.format(frame),
                    expectedFrames: numberFormatter.format(expectedFrames),
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
          {status === "preparing" || status === "running" || status === "publishing" ? (
            <Button
              variant="outline"
              onClick={() => void handleCancel()}
              // `runId` is null from the start of "preparing" until the backend answers
              // with one, and `cancelExport` returns false without reaching the backend
              // while it is null. During "publishing" the backend already ran its last
              // cancel test (ADR 016), so a cancel there cannot stop the rename either.
              // In both phases the button would report a cancel that never happened
              // while the export still writes the file. `isCancelEnabled` holds both
              // rules.
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
