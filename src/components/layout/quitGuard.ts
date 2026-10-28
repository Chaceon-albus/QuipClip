/**
 * Pure rules that decide whether a quit, or Clear Timeline, loses work (ADR 027, ADR 052).
 *
 * Version 1 writes no project file, so the segments live only for the session. A quit loses
 * the segments and the pending In point of the sequence, a live export, the exports that wait
 * in the queue, and an unsaved preset draft.
 *
 * An import adds clips to the sequence and replaces nothing, so it asks nothing (ADR 052).
 * Clear Timeline removes every clip and every segment. It is one edit, so Undo brings them
 * back, but it still asks first when segments exist, as ADR 052 requires.
 *
 * The rules have no DOM, no React, no store and no Tauri runtime, so a test can run them in
 * node. They return catalog keys and values, and they do not call the i18n runtime. Each line
 * of a prompt is one complete catalog message, so no sentence is assembled from fragments
 * (ADR 011).
 */

import type { ExportQueueState, ExportStatus } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";
import { getActiveSourceSegmentEntries } from "@/features/timeline";
import type { Pts, Segment } from "@/types/project";

/** The timeline fields that the rules read. */
export interface TimelineWorkInput {
  /** The source that the timeline shows, or null when no video is open. */
  readonly sourceId: string | null;
  /** Every segment of the project, in project order. */
  readonly segments: readonly Segment[];
  /** The pending In point of the open source, or null. */
  readonly pendingInPts: Pts | null;
}

/** Everything that the quit decision and the clear decision read. */
export interface QuitGuardInput {
  readonly timeline: TimelineWorkInput;
  readonly exportStatus: ExportStatus;
  /** The `tracking` field of the export store. With the status, it decides `exportActive`. */
  readonly exportTracking: boolean;
  /**
   * The name of the preset draft with unsaved edits, or null when no draft holds one. The
   * name can be empty, for a new preset with no name yet.
   */
  readonly unsavedPresetName: string | null;
  /** The exports that a quit drops before they start (`countQueuedExports`). */
  readonly queuedExports: number;
}

/** What a quit would lose now. */
export interface QuitLoss {
  /** The number of segments of the open source. */
  readonly segments: number;
  /** True when the open source has a pending In point. */
  readonly pendingIn: boolean;
  /**
   * True while the export run is live (`isExportRunLive`): preparing, running, or publishing,
   * or failed while the store still tracks the run. A Stop request that failed gives that
   * `failed`, and the backend still encodes. A quit stops the run (ADR 017).
   */
  readonly exportActive: boolean;
  /**
   * The number of exports that wait in the queue or have no answer to their submission for
   * the queue. The exit closes the queue, and the backend drops them with no message
   * (ADR 049). A submission for the queue can also start at once when the slot is free. The
   * exit then cancels that run, which is still lost work.
   */
  readonly queuedExports: number;
  /** The name of the preset draft with unsaved edits, or null. */
  readonly unsavedPreset: string | null;
}

export interface QuitDecision {
  /** True when the quit must ask the user first. False lets the quit continue at once. */
  readonly ask: boolean;
  readonly loss: QuitLoss;
}

/** What Clear Timeline would change now. */
export interface ClearDecision {
  /** True when the clear must ask the user first. False clears at once. */
  readonly ask: boolean;
  /** The number of segments on the sequence. The clear removes them. */
  readonly segments: number;
  /** True when the sequence has a pending In point. The clear removes it. */
  readonly pendingIn: boolean;
}

/** One catalog message, with its named values. */
export interface QuitGuardMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** The text of a confirmation dialog, as catalog messages. */
export interface QuitGuardPromptView {
  readonly title: QuitGuardMessage;
  /** One complete sentence per line. The dialog shows them as a list, in this order. */
  readonly lines: readonly QuitGuardMessage[];
  readonly confirm: QuitGuardMessage;
  /** True when the confirm button discards work, so it takes the destructive style. */
  readonly destructive: boolean;
}

/**
 * The number of exports that a quit drops before they start: the runs that wait in the queue,
 * less the runs that the user removes, and the submissions for the queue that have no answer
 * yet (`enqueuing`). A run in `removing` is on its way out of the queue, because the user
 * asked for that. A submission that starts a new batch is not counted: the export store
 * shows it as the live run, and `exportActive` names it.
 */
export function countQueuedExports(
  queue: Pick<ExportQueueState, "waiting" | "removing" | "enqueuing">,
): number {
  const waiting = queue.waiting.filter((runId) => !queue.removing.includes(runId));
  return waiting.length + queue.enqueuing;
}

/** The number of segments that belong to the open source. */
export function countOpenSourceSegments(timeline: TimelineWorkInput): number {
  return getActiveSourceSegmentEntries(timeline.segments, timeline.sourceId).length;
}

/**
 * True when the open source has a pending In point. The timeline clears the point when no
 * source is open, and the test on the source keeps a stale value from counting as work.
 */
function hasPendingIn(timeline: TimelineWorkInput): boolean {
  return timeline.sourceId !== null && timeline.pendingInPts !== null;
}

/**
 * Decides whether a quit asks first, and what it would lose.
 *
 * The quit asks when it would lose one or more segments or the pending In point of the open
 * source, a live export, one or more queued exports, or an unsaved preset draft. Otherwise it
 * continues at once.
 */
export function decideQuit(input: QuitGuardInput): QuitDecision {
  const loss: QuitLoss = {
    segments: countOpenSourceSegments(input.timeline),
    pendingIn: hasPendingIn(input.timeline),
    exportActive: isExportRunLive({
      status: input.exportStatus,
      tracking: input.exportTracking,
    }),
    queuedExports: input.queuedExports,
    unsavedPreset: input.unsavedPresetName,
  };
  const ask =
    loss.segments > 0 ||
    loss.pendingIn ||
    loss.exportActive ||
    loss.queuedExports > 0 ||
    loss.unsavedPreset !== null;
  return { ask, loss };
}

/**
 * Decides whether Clear Timeline asks first. It asks when the sequence has one or more segments
 * (ADR 052). A pending In point alone does not ask: it is one mark, and the user sets it again
 * with one key. When the dialog asks, it also names the pending In point.
 */
export function decideClear(input: QuitGuardInput): ClearDecision {
  const segments = countOpenSourceSegments(input.timeline);
  const pendingIn = hasPendingIn(input.timeline);
  return { ask: segments > 0, segments, pendingIn };
}

/** Presents the quit dialog. It lists only the lines that apply, in a fixed order. */
export function presentQuitPrompt(loss: QuitLoss): QuitGuardPromptView {
  const lines: QuitGuardMessage[] = [];
  if (loss.segments > 0) {
    lines.push({ key: "quitGuard.loss.segments", values: { count: loss.segments } });
  }
  if (loss.pendingIn) {
    lines.push({ key: "quitGuard.loss.pendingIn" });
  }
  if (loss.exportActive) {
    lines.push({ key: "quitGuard.loss.export" });
  }
  if (loss.queuedExports > 0) {
    lines.push({ key: "quitGuard.loss.queued", values: { count: loss.queuedExports } });
  }
  if (loss.unsavedPreset !== null) {
    // A new preset can have no name yet. Empty quotation marks would read as a fault.
    lines.push(
      loss.unsavedPreset.trim() === ""
        ? { key: "quitGuard.loss.presetUnnamed" }
        : { key: "quitGuard.loss.preset", values: { name: loss.unsavedPreset } },
    );
  }
  return {
    title: { key: "quitGuard.quit.title" },
    lines,
    confirm: { key: "quitGuard.quit.confirm" },
    destructive: true,
  };
}

/**
 * Presents the dialog that asks before Clear Timeline. The segments line says that Undo brings
 * the segments back, and the pending In line appears only when one exists.
 */
export function presentClearPrompt(
  change: Pick<ClearDecision, "segments" | "pendingIn">,
): QuitGuardPromptView {
  const lines: QuitGuardMessage[] = [
    { key: "quitGuard.clear.segments", values: { count: change.segments } },
  ];
  if (change.pendingIn) {
    lines.push({ key: "quitGuard.clear.pendingIn" });
  }
  return {
    title: { key: "quitGuard.clear.title" },
    lines,
    confirm: { key: "quitGuard.clear.confirm" },
    destructive: true,
  };
}
