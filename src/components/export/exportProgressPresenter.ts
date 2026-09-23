/**
 * Pure presenter for formatting export progress and time estimates.
 *
 * Implements presentation logic for the export dialog, status bar indicator,
 * and taskbar/dock progress displays according to ADR 002, ADR 014, and ADR 025.
 */

import type { ExportState } from "@/features/export";
import { rationalToNumber } from "@/lib/time";
import { isCancelOutstanding } from "./exportCancelState";

export type ExportProgressInput = Pick<
  ExportState,
  "status" | "frame" | "expectedFrames" | "fps" | "speed" | "cancelRequested"
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

/** Null when the status is not preparing, running, or publishing. */
export function presentExportProgress(
  input: ExportProgressInput,
): ExportProgressView | null {
  if (
    input.status !== "preparing" &&
    input.status !== "running" &&
    input.status !== "publishing"
  ) {
    return null;
  }

  const basePhase: "preparing" | "running" | "publishing" = input.status;
  const canceling = isCancelOutstanding({
    status: input.status,
    cancelRequested: input.cancelRequested,
  });
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
