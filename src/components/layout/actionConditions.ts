/**
 * The conditions of the editing actions.
 *
 * Each action has one condition. The control that performs the action and the window
 * keyboard layer both read it from here, so a key and a button for one action cannot disagree
 * about when that action is available (ADR 026).
 *
 * The conditions of Mark In, Mark Out and Split are `canMarkIn`, `canMarkOut` and
 * `canSplitCurrentSegment` in the timeline feature. They stay there, beside the PTS rules that
 * they apply, and both callers read them from there.
 *
 * Every function takes plain facts and no store, so a store selector can call it and settle on
 * a boolean, and the tests need no document.
 */

import type { CurrentSegmentRef } from "@/features/timeline";
import type { Pts } from "@/types/project";

/**
 * True while media is open and an attached element of it has loaded metadata. Every
 * transport action and every edit action needs this.
 */
export function isSourceActive(
  hasMedia: boolean,
  isAttached: boolean,
  isReady: boolean,
): boolean {
  return hasMedia && isAttached && isReady;
}

/** Play and pause need an active source, and nothing more. */
export function canTogglePlayback(hasActiveSource: boolean): boolean {
  return hasActiveSource;
}

/**
 * A nominal frame step needs an active source and a valid nominal frame rate (ADR 021). It
 * does not need a calibrated source: `seekNominal` never reads the calibration.
 */
export function canStepFrames(
  hasActiveSource: boolean,
  hasNominalRate: boolean,
): boolean {
  return hasActiveSource && hasNominalRate;
}

/** Undo needs an active source and an entry in the edit history. */
export function canUndoEdit(hasActiveSource: boolean, canUndo: boolean): boolean {
  return hasActiveSource && canUndo;
}

/** Redo needs an active source and an undone entry in the edit history. */
export function canRedoEdit(hasActiveSource: boolean, canRedo: boolean): boolean {
  return hasActiveSource && canRedo;
}

/**
 * Finishing the named segment (New Segment) needs an active source and a segment in
 * progress: a current segment, or a pending In mark. With neither, nothing is in progress.
 */
export function canFinishSegment(
  hasActiveSource: boolean,
  currentSegment: CurrentSegmentRef | null,
  pendingInPts: Pts | null,
): boolean {
  return hasActiveSource && (currentSegment !== null || pendingInPts !== null);
}

/** Delete Segment needs an active source and a current segment to name its target (ADR 007). */
export function canDeleteSegment(
  hasActiveSource: boolean,
  currentSegment: CurrentSegmentRef | null,
): boolean {
  return hasActiveSource && currentSegment !== null;
}

/**
 * The Export button of the title bar needs open media, and nothing more. The export flow
 * itself reports a missing segment in its dialog (ADR 024).
 */
export function canExportMedia(hasMedia: boolean): boolean {
  return hasMedia;
}
