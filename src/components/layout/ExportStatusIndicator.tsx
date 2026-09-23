import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { CircleAlert, CircleCheck, CircleSlash, X } from "lucide-react";
import { ProgressBar } from "@/components/common/ProgressBar";
import { formatRemaining } from "@/components/export/exportProgressPresenter";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useExportPanelStore, useExportStore } from "@/features/export";
import { getResolvedLanguage } from "@/i18n";
import { presentExportIndicator } from "./exportIndicatorPresenter";

/**
 * Status bar export progress and result indicator.
 *
 * Subscribes to the export store and panel store directly as a leaf component
 * so high-frequency progress updates do not re-render the status bar.
 * Renders nothing when the export dialog is open or when status is idle (ADR 025).
 */
export function ExportStatusIndicator() {
  const { t, i18n } = useTranslation();
  const panelOpen = useExportPanelStore((state) => state.open);
  const show = useExportPanelStore((state) => state.show);
  const reset = useExportStore((state) => state.reset);

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
              className="flex h-5 items-center gap-2 rounded-sm px-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
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
        <Separator orientation="vertical" className="mx-2 h-3.5 bg-border" />
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

  return (
    <>
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={show}
              className="flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label={t("statusBar.export.dismiss")}
              onClick={reset}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("statusBar.export.dismiss")}</TooltipContent>
        </Tooltip>
      </div>
      <Separator orientation="vertical" className="mx-2 h-3.5 bg-border" />
    </>
  );
}
