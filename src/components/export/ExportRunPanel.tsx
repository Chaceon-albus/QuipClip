import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { FileVideoCamera } from "lucide-react";
import { ProgressBar } from "@/components/common/ProgressBar";
import { StepFade, StepFadeScope } from "@/components/common/StepFade";
import {
  useExportStore,
  type ExportRunTiming,
  type ExportStatus,
} from "@/features/export";
import { getResolvedLanguage } from "@/i18n";
import { formatElapsed, presentOutputFile } from "./exportFinishedPresenter";
import {
  formatRemaining,
  presentExportProgress,
  type ExportProgressView,
} from "./exportProgressPresenter";
import {
  exportElapsedMs,
  msUntilNextElapsedSecond,
  phaseLabelKey,
  presentExportReadout,
  presentExportRunBar,
  readoutDetailKey,
  selectExportProgressFields,
  type ExportProgressFields,
  type ExportReadoutItem,
} from "./exportRunPresenter";

export interface ExportRunPanelProps {
  /** The step that the panel shows below the bar. */
  step: "progress" | "result";
  status: ExportStatus;
  cancelRequested: boolean;
  /** The `tracking` field of the store. A `failed` that the store tracks keeps a run bar. */
  tracking: boolean;
  outputPath: string | null;
  timing: ExportRunTiming;
  /**
   * The progress fields at the moment the dialog began to close, or null while it is open.
   * The panel then shows them in place of the store, and the elapsed time stops, so the
   * content does not change while it fades out.
   */
  held: ExportProgressFields | null;
  /** The content of the result step. */
  result?: ReactNode;
}

/**
 * The body of the dialog for a run and for its result: the bar, and below it the progress
 * readout or the result.
 *
 * The bar stays mounted from the run into its result, so its fill and its tone change with a
 * transition, not a jump (`presentExportRunBar`). The content below the bar is keyed on the
 * step, so the result fades in. The panel has its own fade scope: the dialog fades the whole
 * panel in when it mounts, and the content below the bar fades only when the step changes
 * inside the panel, so nothing fades twice.
 *
 * `frame`, `fps`, and `speed` are written once per drained ffmpeg `-progress` block, so they
 * change many times per second for the whole encode. They are subscribed HERE, in a leaf,
 * rather than in `ExportDialog`, so a progress write renders this panel alone instead of the
 * whole Radix dialog subtree.
 */
export function ExportRunPanel({
  step,
  status,
  cancelRequested,
  tracking,
  outputPath,
  timing,
  held,
  result,
}: ExportRunPanelProps) {
  const { t, i18n } = useTranslation();
  const live = useExportStore(useShallow(selectExportProgressFields));
  const input = { status, cancelRequested, tracking, ...(held ?? live) };
  const view = presentExportProgress(input);
  const bar = presentExportRunBar(input);
  const resolvedLanguage = getResolvedLanguage(i18n);

  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(resolvedLanguage, {
        style: "percent",
        maximumFractionDigits: 0,
      }),
    [resolvedLanguage],
  );

  // The value text of an active bar names the phase and the percent. A result has none,
  // because its bar is decorative.
  let barText: string | undefined;
  if (view) {
    barText =
      view.phase === "running" && view.percentFraction !== null
        ? t("export.status.runningPercent", {
            percent: percentFormatter.format(view.percentFraction),
          })
        : t(phaseLabelKey(view.phase));
  }

  // `min-w-0` lets this grid item shrink below the width of a long line, so a file name
  // truncates instead of widening the dialog.
  return (
    <div className="min-w-0 space-y-3 py-2">
      {bar && (
        <ProgressBar
          size="md"
          value={bar.value}
          tone={bar.tone}
          flowing={bar.flowing}
          aria-label={t("export.title")}
          aria-valuetext={barText}
          aria-hidden={bar.decorative || undefined}
        />
      )}
      <StepFadeScope step={step}>
        <StepFade key={step} className="min-w-0">
          {step === "progress"
            ? view && (
                <ExportProgressReadout
                  view={view}
                  outputPath={outputPath}
                  timing={timing}
                  ticking={held === null}
                  percentFormatter={percentFormatter}
                />
              )
            : result}
        </StepFade>
      </StepFadeScope>
    </div>
  );
}

interface ExportProgressReadoutProps {
  view: ExportProgressView;
  outputPath: string | null;
  timing: ExportRunTiming;
  ticking: boolean;
  percentFormatter: Intl.NumberFormat;
}

/**
 * The readout of an active run, in its order: the large percent, the remaining time, the
 * frame count and the speed, the elapsed time, and the output file. Each item shows only
 * when it is known.
 *
 * Every number uses tabular figures, so a digit that changes does not move the text after
 * it. The percent starts its line and the remaining time and the elapsed time end theirs, so
 * a change of their width moves nothing else. The frame number sits in a slot as wide as the
 * total, so the rest of its line stays still while it counts.
 */
function ExportProgressReadout({
  view,
  outputPath,
  timing,
  ticking,
  percentFormatter,
}: ExportProgressReadoutProps) {
  const { t, i18n } = useTranslation();
  const resolvedLanguage = getResolvedLanguage(i18n);

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

  const readout = presentExportReadout(view);
  const file = presentOutputFile(outputPath);

  const renderItem = (item: ExportReadoutItem, position: "lead" | "trail") => {
    switch (item.kind) {
      case "percent":
        return (
          <span className="text-2xl leading-8 font-semibold tabular-nums">
            {percentFormatter.format(item.fraction)}
          </span>
        );
      case "remaining":
        return (
          <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
            {t("export.status.remaining", { time: formatRemaining(item.seconds) })}
          </span>
        );
      case "phase":
        // As the lead, the word takes the height of the percent line, so the line keeps its
        // height when the percent replaces it.
        return position === "lead" ? (
          <span className="text-sm leading-8 font-medium">{t(item.key)}</span>
        ) : (
          <span className="shrink-0 text-sm text-muted-foreground">{t(item.key)}</span>
        );
    }
  };

  // One sentence holds each combination of the frame count and the speed (ADR 011). The
  // frame number of a count with a total sits in a slot as wide as the total.
  const detailKey = readoutDetailKey(readout);
  const frame =
    readout.frames !== null ? frameFormatter.format(readout.frames.frame) : "";
  const total =
    readout.frames?.kind === "ofTotal"
      ? frameFormatter.format(readout.frames.expectedFrames)
      : "";
  const speed = readout.speed !== null ? speedFormatter.format(readout.speed) : "";
  const components = { num: <NumberSlot widest={total} /> };
  let detail: ReactNode = null;
  switch (detailKey) {
    case "export.progress.framesAndSpeed":
      detail = (
        <Trans
          t={t}
          i18nKey={detailKey}
          values={{ frame, expectedFrames: total, speed }}
          components={components}
        />
      );
      break;
    case "export.progress.frames":
      detail = (
        <Trans
          t={t}
          i18nKey={detailKey}
          values={{ frame, expectedFrames: total }}
          components={components}
        />
      );
      break;
    case "export.progress.frameCountAndSpeed":
      detail = t(detailKey, { frame, speed });
      break;
    case "export.progress.frameCount":
      detail = t(detailKey, { frame });
      break;
    case "export.status.speed":
      detail = t(detailKey, { speed });
      break;
    case null:
      break;
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
    <div className="space-y-1">
      <div className="flex min-h-8 items-baseline justify-between gap-4">
        {renderItem(readout.lead, "lead")}
        {readout.trail && renderItem(readout.trail, "trail")}
      </div>
      {/* The line keeps its height with no item, so the lines below do not move when the
          frame count or the elapsed time appears. */}
      <div className="flex min-h-4 items-baseline justify-between gap-4 text-xs text-muted-foreground tabular-nums">
        <span className="min-w-0">{detail}</span>
        <ExportElapsed timing={timing} ticking={ticking} />
      </div>
      {file && (
        // The stem truncates and the extension stays visible, as in the title bar.
        <p
          className="flex min-w-0 items-center gap-1.5 pt-1 text-xs text-muted-foreground"
          title={file.fullPath}
        >
          <FileVideoCamera aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="flex min-w-0">
            <span className="truncate">{file.fileStem}</span>
            <span className="shrink-0">{file.fileExtension}</span>
          </span>
        </p>
      )}
      {cancelNote && (
        <p className="pt-1 text-xs text-muted-foreground/80">{cancelNote}</p>
      )}
    </div>
  );
}

interface NumberSlotProps {
  /** The widest text that the slot holds, such as the total of a count. */
  widest: string;
  /** The number. `Trans` passes it from the placeholder that the tag wraps. */
  children?: ReactNode;
}

/**
 * A slot exactly as wide as `widest`, with the number at its end. A hidden copy of `widest`
 * sets the width in the font of the line, so a group separator counts at its own width. A
 * number wider than `widest` widens the slot and is never cut.
 */
function NumberSlot({ widest, children }: NumberSlotProps) {
  return (
    <span className="inline-grid justify-items-end">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {widest}
      </span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}

interface ExportElapsedProps {
  timing: ExportRunTiming;
  /** False while the dialog closes. The time then stays at its last value. */
  ticking: boolean;
}

/**
 * The elapsed time of an active run.
 *
 * It keeps its own clock and renders itself once a second, so the tick renders this line
 * alone. It is memoized on its props, which change only at the start and the end of a run,
 * so a progress event, which renders the readout, does not render it. Each tick waits for
 * the next whole second of the run (`msUntilNextElapsedSecond`), so the display changes on
 * the second. A hidden window can delay a timer, so the clock also reads the time when the
 * window becomes visible again.
 */
const ExportElapsed = memo(function ExportElapsed({
  timing,
  ticking,
}: ExportElapsedProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState<number | null>(null);
  const { startedAt, endedAt } = timing;
  const running = ticking && startedAt !== null && endedAt === null;

  useEffect(() => {
    if (!running || startedAt === null) {
      return;
    }
    let timer: number | undefined;
    const tick = () => {
      window.clearTimeout(timer);
      const current = performance.now();
      setNow(current);
      timer = window.setTimeout(tick, msUntilNextElapsedSecond(startedAt, current));
    };
    const refresh = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };
    tick();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [running, startedAt]);

  const elapsed = exportElapsedMs(timing, now);
  if (elapsed === null) {
    return null;
  }
  return (
    <span className="shrink-0">
      {t("export.progress.elapsed", { time: formatElapsed(elapsed) })}
    </span>
  );
});
