import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  remainingSecondsAt,
  selectExportProgressFields,
  type ExportProgressFields,
} from "./exportRunPresenter";
import { useSmoothedFrame, type FrameSmoothingMode } from "./useSmoothedFrame";

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
 * change about twice a second for the whole encode. They are subscribed HERE, in a leaf,
 * rather than in `ExportDialog`, so a progress write renders this panel alone instead of the
 * whole Radix dialog subtree.
 *
 * Two reports a second make a bar that moves in jerks. While the encode runs, the panel
 * therefore shows a smoothed frame (`useSmoothedFrame`) in place of the reported one. The bar,
 * the percent, the value text of the bar, and the frame count all read that one frame, so they
 * agree. The smoothing runs only while the encode runs with a known total. It holds still while
 * the dialog closes, and it is off when the system asks for reduced motion.
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
  const reported = { status, cancelRequested, tracking, ...(held ?? live) };
  // The phase does not depend on the frame, so the reported fields give it. The smoothing
  // needs the total: the total stops the prediction at the end of the encode. With no total,
  // the count could pass the last frame and fall back when the encode ends.
  const smoothable =
    presentExportProgress(reported)?.basePhase === "running" &&
    reported.expectedFrames !== null &&
    reported.expectedFrames > 0;
  let smoothingMode: FrameSmoothingMode = "off";
  if (held !== null) {
    smoothingMode = "frozen";
  } else if (smoothable) {
    smoothingMode = "live";
  }
  const smoothed = useSmoothedFrame(
    reported.frame,
    reported.expectedFrames,
    smoothingMode,
  );
  const input = { ...reported, frame: smoothed.frame };
  const view = presentExportProgress(input);
  const bar = presentExportRunBar(input);
  const resolvedLanguage = getResolvedLanguage(i18n);

  // The run clock samples the remaining time from the latest reported fields and the smoothed
  // position at its tick. The fields go to a ref after each render, so the sampler stays one
  // stable function, and a progress event does not render the clock.
  const reportedRef = useRef(reported);
  useLayoutEffect(() => {
    reportedRef.current = reported;
  });
  const { positionAt } = smoothed;
  const sampleRemaining = useCallback(
    (now: number) => remainingSecondsAt(reportedRef.current, positionAt(now)),
    [positionAt],
  );

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
                  sampleRemaining={sampleRemaining}
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
  /** Stable. The remaining time at a tick of the run clock (`ExportRunTimes`). */
  sampleRemaining: (now: number) => number | null;
  percentFormatter: Intl.NumberFormat;
}

/**
 * The readout of an active run, in two lines of two columns, and the output file below them.
 *
 * | Left                                | Right                      |
 * | ----------------------------------- | -------------------------- |
 * | The remaining time, or a phase word | The large percent          |
 * | The elapsed time                    | The frame count, the speed |
 *
 * Each item shows only when it is known. The phase word, such as "Finishing…", takes the slot
 * of the remaining time, because the two never show together (`presentExportReadout`). Each
 * line keeps its height with no item, so nothing moves when an item appears.
 *
 * The two times in the left column come from one clock (`ExportRunTimes`), so they change in
 * the same render. The numbers in the right column end at the right edge and use tabular
 * figures, so a digit that changes does not move the text before it. The frame number sits in
 * a slot as wide as the total, so the rest of its line stays still while it counts.
 */
function ExportProgressReadout({
  view,
  outputPath,
  timing,
  ticking,
  sampleRemaining,
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

  // Each item names its own cell, so the run clock can fill both cells of the left column.
  // The first row is as tall as the percent, and the second row as tall as its text, with no
  // item or with one. The items of a row align on their baselines. The left column comes
  // first in the document, so a screen reader reads the times before the progress.
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(2rem,auto)_minmax(1rem,auto)] items-baseline gap-x-4 gap-y-1">
        {readout.status?.kind === "phase" && (
          <span className="col-start-1 row-start-1 min-w-0 text-sm leading-8 font-medium">
            {t(readout.status.key)}
          </span>
        )}
        <ExportRunTimes
          timing={timing}
          ticking={ticking}
          estimating={readout.status?.kind === "remaining"}
          sampleRemaining={sampleRemaining}
        />
        {readout.percent !== null && (
          <span className="col-start-2 row-start-1 justify-self-end text-2xl leading-8 font-semibold tabular-nums">
            {percentFormatter.format(readout.percent)}
          </span>
        )}
        {detail !== null && (
          <span className="col-start-2 row-start-2 justify-self-end text-xs text-muted-foreground tabular-nums">
            {detail}
          </span>
        )}
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

interface ExportRunTimesProps {
  timing: ExportRunTiming;
  /** False while the dialog closes. The times then stay at their last values. */
  ticking: boolean;
  /** True while the readout gives the left slot of the first line to the remaining time. */
  estimating: boolean;
  /** Stable. The remaining time at `now`, in whole seconds, or null with no estimate. */
  sampleRemaining: (now: number) => number | null;
}

interface RunClockSample {
  /** The time of the tick, or null before the first tick. */
  now: number | null;
  /** The remaining time at the tick, in whole seconds, or null. */
  remaining: number | null;
}

/**
 * The left column of the readout: the remaining time in the first line, and the elapsed time
 * in the second line.
 *
 * Both times come from one clock, so they change in the same render. The clock ticks on each
 * whole second of the run (`msUntilNextElapsedSecond`). At each tick it reads the time and
 * samples the remaining time (`sampleRemaining`). The sample uses the smoothed position, which
 * moves on between two ffmpeg reports, so the remaining time falls about one second at each
 * tick, in step with the elapsed time.
 *
 * The component is memoized on its props. `timing` changes only at the start and the end of a
 * run, `estimating` only when the phase changes, and `sampleRemaining` never. A progress event
 * therefore does not render it, and it cannot change the remaining time between two ticks.
 *
 * When an estimate first becomes available, the clock samples at once, so the remaining time
 * shows without a wait. When the phase leaves the encode, the remaining time disappears in the
 * same render, and the phase word takes its slot. A hidden window can delay a timer, so the
 * clock also ticks when the window becomes visible again.
 */
const ExportRunTimes = memo(function ExportRunTimes({
  timing,
  ticking,
  estimating,
  sampleRemaining,
}: ExportRunTimesProps) {
  const { t } = useTranslation();
  const [sample, setSample] = useState<RunClockSample>({ now: null, remaining: null });
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
      setSample({
        now: current,
        remaining: estimating ? sampleRemaining(current) : null,
      });
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
  }, [running, startedAt, estimating, sampleRemaining]);

  const elapsed = exportElapsedMs(timing, sample.now);
  const remaining = estimating ? sample.remaining : null;
  return (
    <>
      {remaining !== null && (
        <span className="col-start-1 row-start-1 text-sm text-muted-foreground tabular-nums">
          {t("export.status.remaining", { time: formatRemaining(remaining) })}
        </span>
      )}
      {elapsed !== null && (
        <span className="col-start-1 row-start-2 text-xs text-muted-foreground tabular-nums">
          {t("export.progress.elapsed", { time: formatElapsed(elapsed) })}
        </span>
      )}
    </>
  );
});
