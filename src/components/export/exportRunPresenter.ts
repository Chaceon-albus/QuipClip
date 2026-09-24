/**
 * Pure rules for the run panel of the export dialog: the time the run took, the progress
 * readout, and the bar that stays from the run into its result.
 *
 * The rules take every time as an argument and read no clock, so the tests need no timers.
 * The caller passes a monotonic time in milliseconds, such as `performance.now()`.
 */

import {
  isExportRunLive,
  type ExportRunTiming,
  type ExportState,
} from "@/features/export";
import {
  presentExportProgress,
  type ExportProgressInput,
  type ExportProgressPhase,
  type ExportProgressView,
} from "./exportProgressPresenter";

/**
 * The fields of the store that change on each progress event. Only the run panel subscribes
 * to them, so a progress event renders the panel and not the whole dialog.
 */
export type ExportProgressFields = Pick<
  ExportState,
  "frame" | "expectedFrames" | "fps" | "speed"
>;

/**
 * Picks the progress fields from the store state. The panel subscribes with it, and the
 * dialog takes the fields with it when it holds its frame for a close.
 */
export function selectExportProgressFields(
  state: ExportProgressFields,
): ExportProgressFields {
  return {
    frame: state.frame,
    expectedFrames: state.expectedFrames,
    fps: state.fps,
    speed: state.speed,
  };
}

/**
 * The time the run took, in milliseconds: from the start to `now` while the run continues,
 * and from the start to the end after it ended. Never negative.
 *
 * Null when no run was seen, and when the run continues and `now` is null. A caller that has
 * no clock, such as the finished panel, passes null for `now`.
 */
export function exportElapsedMs(
  timing: ExportRunTiming,
  now: number | null,
): number | null {
  if (timing.startedAt === null) {
    return null;
  }
  const end = timing.endedAt ?? now;
  if (end === null) {
    return null;
  }
  return Math.max(0, end - timing.startedAt);
}

/**
 * A timer set to the exact second can fire a little before the clock that the display reads
 * shows that second, because the browser can round both. The tick waits this much longer, so
 * each tick shows the new second.
 */
export const ELAPSED_TICK_SLACK_MS = 20;

/**
 * Milliseconds from `now` to the next whole second of the elapsed time, plus
 * `ELAPSED_TICK_SLACK_MS`. A display that ticks after this delay changes on each whole
 * second of the run, and not up to one second after it.
 *
 * A `now` before the start counts as the start. A time that is not finite gives one second,
 * so a bad value can never make a timer loop with no delay.
 */
export function msUntilNextElapsedSecond(startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt);
  if (!Number.isFinite(elapsed)) {
    return 1000;
  }
  return 1000 - (elapsed % 1000) + ELAPSED_TICK_SLACK_MS;
}

export type ExportPhaseLabelKey =
  | "export.status.preparing"
  | "export.status.running"
  | "export.status.publishing"
  | "export.status.canceling";

/** The catalog key of the word for a phase, such as "Finishing...". */
export function phaseLabelKey(phase: ExportProgressPhase): ExportPhaseLabelKey {
  switch (phase) {
    case "preparing":
      return "export.status.preparing";
    case "running":
      return "export.status.running";
    case "publishing":
      return "export.status.publishing";
    case "canceling":
      return "export.status.canceling";
  }
}

/** One item of the first line of the readout. */
export type ExportReadoutItem =
  | { kind: "percent"; fraction: number }
  | { kind: "remaining"; seconds: number }
  | { kind: "phase"; key: ExportPhaseLabelKey };

/** The frame count of the second line, or null when no frame was reported. */
export type ExportReadoutFrames =
  | { kind: "ofTotal"; frame: number; expectedFrames: number }
  | { kind: "count"; frame: number }
  | null;

export interface ExportReadoutView {
  /** The start of the first line: the large percent, or the phase when the percent is unknown. */
  lead: ExportReadoutItem;
  /**
   * The end of the first line: the remaining time, or the phase when the lead is the percent
   * and the phase is not a plain encode. Null when nothing more is known.
   */
  trail: ExportReadoutItem | null;
  frames: ExportReadoutFrames;
  /** Speed factor, or null when unknown or before the encode. */
  speed: number | null;
}

/**
 * Presents the progress readout in its order: the percent, the remaining time, the frame
 * count and the speed. Each item shows only when it is known.
 *
 * A running encode with a percent shows no phase word, because the percent says that it
 * runs. Every other phase names itself: "Preparing export...", "Finishing...", "Stopping...",
 * and "Exporting..." when the total is unknown.
 */
export function presentExportReadout(view: ExportProgressView): ExportReadoutView {
  const phase: ExportReadoutItem = { kind: "phase", key: phaseLabelKey(view.phase) };
  const lead: ExportReadoutItem =
    view.percentFraction !== null
      ? { kind: "percent", fraction: view.percentFraction }
      : phase;

  let trail: ExportReadoutItem | null = null;
  if (view.remainingSeconds !== null) {
    trail = { kind: "remaining", seconds: view.remainingSeconds };
  } else if (lead.kind === "percent" && view.phase !== "running") {
    trail = phase;
  }

  // Preparation reports no frame. From the encode on, the last count stays through the
  // publication, so the line does not disappear for the last step.
  const encoding = view.basePhase !== "preparing";
  let frames: ExportReadoutFrames = null;
  if (encoding && view.frame !== null) {
    frames =
      view.expectedFrames !== null && view.expectedFrames > 0
        ? { kind: "ofTotal", frame: view.frame, expectedFrames: view.expectedFrames }
        : { kind: "count", frame: view.frame };
  }

  return { lead, trail, frames, speed: encoding ? view.speed : null };
}

export type ExportReadoutDetailKey =
  | "export.progress.framesAndSpeed"
  | "export.progress.frames"
  | "export.progress.frameCountAndSpeed"
  | "export.progress.frameCount"
  | "export.status.speed";

/**
 * The catalog key of the second line of the readout. Each combination of the frame count and
 * the speed has one sentence of its own, so no display joins two translated pieces
 * (ADR 011). Null when neither is known.
 */
export function readoutDetailKey({
  frames,
  speed,
}: Pick<ExportReadoutView, "frames" | "speed">): ExportReadoutDetailKey | null {
  const hasSpeed = speed !== null;
  switch (frames?.kind) {
    case "ofTotal":
      return hasSpeed ? "export.progress.framesAndSpeed" : "export.progress.frames";
    case "count":
      return hasSpeed
        ? "export.progress.frameCountAndSpeed"
        : "export.progress.frameCount";
    default:
      return hasSpeed ? "export.status.speed" : null;
  }
}

export type ExportRunBarTone = "default" | "success" | "destructive" | "neutral";

export interface ExportRunBarView {
  /** 0 to 100, or null for the indeterminate bar. */
  value: number | null;
  tone: ExportRunBarTone;
  /** Whether the gradient moves along the fill. */
  flowing: boolean;
  /**
   * True in a result. The notice of the result is the accessible report there, so the bar is
   * hidden from assistive technology.
   */
  decorative: boolean;
}

export interface ExportRunBarInput extends ExportProgressInput {
  /** The `tracking` field of the store: true while the store follows a run by its id. */
  tracking: boolean;
}

/** The fill of a run that reached `frame` of `expectedFrames`, or null when either is unknown. */
function reachedFill({ frame, expectedFrames }: ExportProgressInput): number | null {
  if (frame === null || expectedFrames === null || expectedFrames <= 0) {
    return null;
  }
  return (frame / expectedFrames) * 100;
}

/**
 * Presents the bar at the top of the run panel. It stays from the run into its result, and
 * its tone gives the result: success when finished, destructive when failed, and neutral when
 * the user stopped the run.
 *
 * An active run shows the bar of `presentExportProgress`. A finished run shows a full bar. A
 * failed or stopped run keeps the fill that it reached. Null when no fill is known: in
 * `idle`, and after a run that ended with no frame goal or no frame, because a moving
 * indeterminate bar does not suit a result.
 *
 * A `failed` that the store still tracks is not a result (`isExportRunLive`): a Stop failed,
 * and the backend still encodes. Its bar stays the bar of a run, in the default tone and
 * flowing, and it keeps its fill as the frames arrive. A red bar that keeps filling would
 * report a failure that has not happened.
 */
export function presentExportRunBar(input: ExportRunBarInput): ExportRunBarView | null {
  const progress = presentExportProgress(input);
  if (progress !== null) {
    return {
      value: progress.barValue,
      tone: "default",
      flowing: progress.phase !== "canceling",
      decorative: false,
    };
  }

  if (isExportRunLive(input)) {
    return {
      value: reachedFill(input),
      tone: "default",
      flowing: true,
      decorative: false,
    };
  }

  switch (input.status) {
    case "finished":
      return { value: 100, tone: "success", flowing: false, decorative: true };
    case "failed":
    case "canceled": {
      const value = reachedFill(input);
      if (value === null) {
        return null;
      }
      return {
        value,
        tone: input.status === "failed" ? "destructive" : "neutral",
        flowing: false,
        decorative: true,
      };
    }
    default:
      return null;
  }
}
