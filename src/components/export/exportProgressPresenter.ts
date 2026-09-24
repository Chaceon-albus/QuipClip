/**
 * Pure presenter for formatting export progress and time estimates.
 *
 * Implements presentation logic for the export dialog, status bar indicator,
 * and taskbar/dock progress displays according to ADR 002, ADR 014, and ADR 025.
 */

import type { ExportState } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";
import { rationalToNumber } from "@/lib/time";
import { isCancelOutstanding } from "./exportCancelState";

export type ExportProgressInput = Pick<
  ExportState,
  | "status"
  | "frame"
  | "expectedFrames"
  | "fps"
  | "speed"
  | "cancelRequested"
  | "tracking"
  | "encodeStarted"
>;

export type ExportProgressPhase = "preparing" | "running" | "publishing" | "canceling";

export interface ExportProgressView {
  phase: ExportProgressPhase;
  /** The phase without the cancel overlay: preparing, running, or publishing. */
  basePhase: "preparing" | "running" | "publishing";
  /** 0 to 100 for ProgressBar, or null for the indeterminate bar. */
  barValue: number | null;
  /** 0 to 1 for the percent label, or null when unknown. */
  percentFraction: number | null;
  /** Whole seconds, or null when no estimate is possible. */
  remainingSeconds: number | null;
  /** Speed factor, or null when unknown. */
  speed: number | null;
  frame: number | null;
  expectedFrames: number | null;
}

/**
 * The progress of a live run (`isExportRunLive`), or null when the run is not live.
 *
 * A `failed` status that the store still tracks is live: a Stop request failed, and the
 * backend still prepares or encodes. It shows the progress of that phase: `running` once the
 * store saw the encode start (`encodeStarted`), and `preparing` before. It is never the
 * publication. The `publishing` event changes the status to `publishing`, and a Stop request
 * that fails after that event keeps `publishing` (`reportStopFailure` in the store).
 */
export function presentExportProgress(
  input: ExportProgressInput,
): ExportProgressView | null {
  if (!isExportRunLive(input)) {
    return null;
  }

  let basePhase: "preparing" | "running" | "publishing";
  if (
    input.status === "preparing" ||
    input.status === "running" ||
    input.status === "publishing"
  ) {
    basePhase = input.status;
  } else {
    basePhase = input.encodeStarted ? "running" : "preparing";
  }
  const canceling = isCancelOutstanding(input);
  const phase: ExportProgressPhase = canceling ? "canceling" : basePhase;

  let barValue: number | null = null;
  let percentFraction: number | null = null;

  if (basePhase === "publishing") {
    barValue = 100;
    percentFraction = 1;
  } else if (basePhase === "running") {
    if (typeof input.expectedFrames === "number" && input.expectedFrames > 0) {
      const ratio = (input.frame ?? 0) / input.expectedFrames;
      barValue = ratio * 100;
      const wholePercent = Math.floor(
        ((input.frame ?? 0) * 100) / input.expectedFrames,
      );
      percentFraction = Math.max(0, Math.min(wholePercent, 99)) / 100;
    }
  }

  let remainingSeconds: number | null = null;
  if (
    phase === "running" &&
    typeof input.expectedFrames === "number" &&
    input.expectedFrames > 0 &&
    input.frame !== null &&
    input.fps !== null &&
    input.fps !== undefined
  ) {
    const fpsNum = rationalToNumber(input.fps);
    if (fpsNum !== null && fpsNum > 0) {
      remainingSeconds = Math.ceil(
        Math.max(0, input.expectedFrames - input.frame) / fpsNum,
      );
    }
  }

  let speed: number | null = null;
  if (input.speed !== null && input.speed !== undefined) {
    const speedNum = rationalToNumber(input.speed);
    if (speedNum !== null && speedNum > 0) {
      speed = speedNum;
    }
  }

  return {
    phase,
    basePhase,
    barValue,
    percentFraction,
    remainingSeconds,
    speed,
    frame: input.frame,
    expectedFrames: input.expectedFrames,
  };
}

/** "m:ss" below one hour, "h:mm:ss" from one hour. Non-finite or negative input gives "0:00". */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const paddedSecs = String(secs).padStart(2, "0");

  if (hours > 0) {
    const paddedMins = String(minutes).padStart(2, "0");
    return `${hours}:${paddedMins}:${paddedSecs}`;
  }

  return `${minutes}:${paddedSecs}`;
}
