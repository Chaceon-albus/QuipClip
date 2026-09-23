import { useMemo } from "react";
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
} from "@/features/export";
import { getResolvedLanguage } from "@/i18n";
import { isMacOS } from "@/lib/platform";
import { presentExportIndicator } from "./exportIndicatorPresenter";

/**
 * Status bar export progress and result indicator.
 *
 * Subscribes to the export store and panel store directly as a leaf component
 * so high-frequency progress updates do not re-render the status bar.
 * Renders nothing when the export dialog is open or when status is idle (ADR 025).
 *
 * Sizing follows the status bar rule: every control is 24px tall, a standalone icon button
 * is a 24px box with a 16px glyph, and an icon inline with text is 14px. The dismiss X and
 * the show-in-folder button of a finished run get the full 24px box but keep the 14px glyph,
 * because they sit next to the result text they act on. Each vertical separator is 16px
 * tall, the height of a 16px glyph. `data-vertical:self-center` replaces the Separator's own
 * `self-stretch`, which puts an item with a fixed height at the top of the row instead of at
 * its centre.
 */
export function ExportStatusIndicator() {
  const { t, i18n } = useTranslation();
  const panelOpen = useExportPanelStore((state) => state.open);
  const show = useExportPanelStore((state) => state.show);
  const reset = useExportStore((state) => state.reset);
  const runId = useExportStore((state) => state.runId);
  const outputActionPending = useExportOutputActionStore((state) => state.pending);
  const runOutputAction = useExportOutputActionStore((state) => state.run);

  const exportData = useExportStore(
    useShallow((state) => ({
      status: state.status,
      frame: state.frame,
      expectedFrames: state.expectedFrames,
      fps: state.fps,
      speed: state.speed,
      cancelRequested: state.cancelRequested,
      outputPath: state.outputPath,
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

  if (!view) {
    return null;
  }

  if (view.kind === "active") {
    let line = "";
    switch (view.progress.phase) {
      case "preparing":
        line = t("statusBar.export.preparing");
        break;
      case "running": {
        const runningText =
          view.progress.percentFraction !== null
            ? t("statusBar.export.running", {
                percent: percentFormatter.format(view.progress.percentFraction),
              })
            : t("statusBar.export.runningUnknown");
        if (view.progress.remainingSeconds !== null) {
          const timeText = formatRemaining(view.progress.remainingSeconds);
          line = `${runningText} · ${t("statusBar.export.remaining", { time: timeText })}`;
        } else {
          line = runningText;
        }
        break;
      }
      case "publishing":
        line = t("statusBar.export.publishing");
        break;
      case "canceling":
        line = t("statusBar.export.canceling");
        break;
    }

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={show}
              aria-label={line}
              className="flex h-6 items-center gap-2 rounded-sm px-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ProgressBar
                size="xs"
                className="w-24 shrink-0"
                value={view.progress.barValue}
                flowing={view.progress.phase !== "canceling"}
                aria-hidden
              />
              <span className="whitespace-nowrap tabular-nums">{line}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
            {view.outputName && (
              <p className="break-all">
                {t("statusBar.export.output", { name: view.outputName })}
              </p>
            )}
            {view.progress.frame !== null && view.progress.expectedFrames !== null && (
              <p>
                {t("export.status.frames", {
                  frame: frameFormatter.format(view.progress.frame),
                  expectedFrames: frameFormatter.format(view.progress.expectedFrames),
                })}
              </p>
            )}
            {view.progress.remainingSeconds !== null && (
              <p>
                {t("statusBar.export.remaining", {
                  time: formatRemaining(view.progress.remainingSeconds),
                })}
              </p>
            )}
            <p>{t("statusBar.export.showHint")}</p>
          </TooltipContent>
        </Tooltip>
        <Separator
          orientation="vertical"
          className="mx-1.5 h-4 bg-border data-vertical:self-center"
        />
      </>
    );
  }

  const finalConfig = {
    finished: {
      icon: <CircleCheck className="size-3.5 text-success" />,
      labelKey: "statusBar.export.finished" as const,
    },
    failed: {
      icon: <CircleAlert className="size-3.5 text-destructive" />,
      labelKey: "statusBar.export.failed" as const,
    },
    canceled: {
      icon: <CircleSlash className="size-3.5 text-muted-foreground" />,
      labelKey: "statusBar.export.canceled" as const,
    },
  };

  const config = finalConfig[view.kind];
  const revealLabel = t(revealLabelKey(isMacOS()));
  const canReveal = view.kind === "finished" && runId !== null;
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
      show();
    }
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={show}
              className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            >
              {config.icon}
              <span className="whitespace-nowrap">{t(config.labelKey)}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md flex-col items-start gap-1 text-xs">
            {view.outputName && (
              <p className="break-all">
                {t("statusBar.export.output", { name: view.outputName })}
              </p>
            )}
            <p>{t("statusBar.export.showHint")}</p>
          </TooltipContent>
        </Tooltip>
        {canReveal && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="chrome"
              size="icon-xs"
              aria-label={t("statusBar.export.dismiss")}
              onClick={reset}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("statusBar.export.dismiss")}</TooltipContent>
        </Tooltip>
      </div>
      <Separator
        orientation="vertical"
        className="mx-1.5 h-4 bg-border data-vertical:self-center"
      />
    </>
  );
}
