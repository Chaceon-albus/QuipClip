/**
 * Pure rules that decide whether a quit, or Clear Timeline, loses work (ADR 027, ADR 052,
 * ADR 072), and the text of the save prompt of the open of a project (ADR 072).
 *
 * A quit loses the changes of the project that are not saved, the pending In point of the
 * sequence, a live export, the exports that wait in the queue, and an unsaved preset draft. When
 * the project has changes to save, the quit dialog is the save prompt of ADR 072: it names the
 * file of the project, or it says that the project has no file, and it has Save, Don't Save and
 * Cancel. Otherwise the quit dialog is the plain dialog of ADR 027.
 *
 * An import adds clips to the sequence and replaces nothing, so it asks nothing (ADR 052).
 * Clear Timeline removes every clip and every segment, and so it closes the project (ADR 072).
 * It is one edit: Undo brings the clips and the segments back, but not the file of the project.
 * It shows the save prompt when the project has a file and is modified. Otherwise it asks as
 * ADR 052 requires when segments exist.
 *
 * The rules have no DOM, no React, no store and no Tauri runtime, so a test can run them in
 * node. They return catalog keys and values, and they do not call the i18n runtime. Each line
 * of a prompt is one complete catalog message, so no sentence is assembled from fragments
 * (ADR 011).
 */

import type { ExportQueueState, ExportStatus } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";
import { liveSegments, type TimelineTruth } from "@/features/timeline";

/**
 * The work of the timeline that the rules read: the stored marks, not their projection on the
 * sequence (`timelineWorkOf`).
 */
export interface TimelineWorkInput {
  /** The number of the live segments of the sequence (`liveSegments`). */
  readonly segmentCount: number;
  /** True when the timeline stores a pending In mark (`pendingIn`). */
  readonly hasPendingIn: boolean;
}

/** The facts of the project that the rules read (ADR 072). */
export interface ProjectWorkInput {
  /** True when the project has changes to save (`hasChangesToSaveNow`). */
  readonly hasChangesToSave: boolean;
  /** True when the project has a file and is modified (`isProjectModified`). */
  readonly isModifiedFile: boolean;
  /** The name of the file of the project, or null for a project with no file. */
  readonly fileName: string | null;
}

/** Everything that the quit decision and the clear decision read. */
export interface QuitGuardInput {
  readonly timeline: TimelineWorkInput;
  readonly project: ProjectWorkInput;
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

/** The changes of the project that a quit would lose (ADR 072). */
export interface ProjectLoss {
  /** The name of the file of the project, or null for a project with no file. */
  readonly fileName: string | null;
}

/** What a quit would lose now. */
export interface QuitLoss {
  /** The changes of the project that are not saved, or null when it has no changes to save. */
  readonly project: ProjectLoss | null;
  /** True when the timeline stores a pending In point. */
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

/** The plain form of the clear prompt (ADR 052): the sequence has segments. */
export interface PlainClearPrompt {
  readonly form: "plain";
  /** The number of segments on the sequence. The clear removes them. */
  readonly segments: number;
  /** True when the sequence has a pending In point. The clear removes it. */
  readonly pendingIn: boolean;
}

/** The save form of the clear prompt (ADR 072): the project has a file and is modified. */
export interface SaveClearPrompt {
  readonly form: "save";
  /** The name of the file of the project. */
  readonly fileName: string;
  /** True when the sequence has a pending In point. The clear removes it. */
  readonly pendingIn: boolean;
}

/** The form of the dialog that asks before Clear Timeline. */
export type ClearPrompt = PlainClearPrompt | SaveClearPrompt;

/** What Clear Timeline does now: clear at once, or ask with one form of the prompt. */
export type ClearDecision = { readonly form: "none" } | ClearPrompt;

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
  /**
   * The discard button of the save prompt, "Don't Save" (ADR 031, ADR 072), or null for a
   * dialog with no such button.
   */
  readonly discard: QuitGuardMessage | null;
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

/**
 * The work of the timeline from its stored truth: the number of the live segments, as
 * `hasChangesToSaveNow` counts them, and the stored pending In mark.
 *
 * It does not read the projected values (`segments`, `pendingInPts`, `sourceId`). A segment or a
 * pending In whose position the sequence cannot project, such as on a sequence with no virtual
 * axis, is still work that a quit or Clear Timeline loses.
 */
export function timelineWorkOf(
  timeline: Pick<
    TimelineTruth,
    "clips" | "sequenceSegments" | "sequenceSources" | "pendingIn"
  >,
): TimelineWorkInput {
  return {
    segmentCount: liveSegments(timeline).length,
    hasPendingIn: timeline.pendingIn !== null,
  };
}

/**
 * Decides whether a quit asks first, and what it would lose.
 *
 * The quit asks when the project has changes to save (ADR 072), when the timeline stores a
 * pending In point, or for a live export, one or more queued exports, or an unsaved preset
 * draft. Otherwise it continues at once.
 */
export function decideQuit(input: QuitGuardInput): QuitDecision {
  const loss: QuitLoss = {
    project: input.project.hasChangesToSave
      ? { fileName: input.project.fileName }
      : null,
    pendingIn: input.timeline.hasPendingIn,
    exportActive: isExportRunLive({
      status: input.exportStatus,
      tracking: input.exportTracking,
    }),
    queuedExports: input.queuedExports,
    unsavedPreset: input.unsavedPresetName,
  };
  const ask =
    loss.project !== null ||
    loss.pendingIn ||
    loss.exportActive ||
    loss.queuedExports > 0 ||
    loss.unsavedPreset !== null;
  return { ask, loss };
}

/**
 * True when a dialog that listed `listed` also covers each loss of `next`: a loss that the user
 * already accepted in that dialog (ADR 072). The quit reads the losses again after the user
 * confirms, and it asks again for a loss that the dialog did not list.
 *
 * - The project is covered when the dialog listed the project.
 * - The pending In point and the live export are covered when the dialog listed them.
 * - The queued exports are covered when their number is not larger than the listed number.
 * - The preset draft is covered when no draft holds edits, or the draft has the listed name.
 */
export function isLossListed(next: QuitLoss, listed: QuitLoss): boolean {
  return (
    (next.project === null || listed.project !== null) &&
    (!next.pendingIn || listed.pendingIn) &&
    (!next.exportActive || listed.exportActive) &&
    next.queuedExports <= listed.queuedExports &&
    (next.unsavedPreset === null || next.unsavedPreset === listed.unsavedPreset)
  );
}

/**
 * Decides whether Clear Timeline asks first, and with which form.
 *
 * - The project has a file and is modified: the save form (ADR 072). The clear closes the
 *   project, and Undo does not give the file back.
 * - Otherwise, the sequence has one or more segments: the plain form (ADR 052).
 * - Otherwise the clear asks nothing. A pending In point alone does not ask: it is one mark,
 *   and the user sets it again with one key. When the dialog asks, it also names the pending
 *   In point.
 */
export function decideClear(input: QuitGuardInput): ClearDecision {
  const pendingIn = input.timeline.hasPendingIn;
  if (input.project.isModifiedFile && input.project.fileName !== null) {
    return { form: "save", fileName: input.project.fileName, pendingIn };
  }
  const segments = input.timeline.segmentCount;
  return segments > 0 ? { form: "plain", segments, pendingIn } : { form: "none" };
}

/** The lines of the losses other than the project, in a fixed order. */
function otherLossLines(loss: QuitLoss): QuitGuardMessage[] {
  const lines: QuitGuardMessage[] = [];
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
  return lines;
}

/** The line that names the file of the project, or says that the project has no file. */
function projectLine(fileName: string | null): QuitGuardMessage {
  return fileName === null
    ? { key: "quitGuard.project.noFile" }
    : { key: "quitGuard.project.file", values: { name: fileName } };
}

/**
 * Presents the quit dialog. It lists only the lines that apply, in a fixed order.
 *
 * With changes of the project to save, it is the save prompt (ADR 072): the first line names the
 * file of the project or says that the project has no file, Save is the primary button, and
 * "Don't Save" is the discard button. Save keeps the work, so it has no destructive style.
 * Otherwise it is the plain dialog of ADR 027, with a destructive Quit.
 */
export function presentQuitPrompt(loss: QuitLoss): QuitGuardPromptView {
  if (loss.project === null) {
    return {
      title: { key: "quitGuard.quit.title" },
      lines: otherLossLines(loss),
      confirm: { key: "quitGuard.quit.confirm" },
      destructive: true,
      discard: null,
    };
  }
  return {
    title: { key: "quitGuard.quit.saveTitle" },
    lines: [projectLine(loss.project.fileName), ...otherLossLines(loss)],
    confirm: { key: "quitGuard.save" },
    destructive: false,
    discard: { key: "quitGuard.dontSave" },
  };
}

/**
 * Presents the save prompt of the open of a project (ADR 072, "Before the content is dropped").
 * The open asks only when the project has changes to save, so the prompt has only the save form:
 * its own title, the line that names the file of the project or says that the project has no
 * file, Save as the primary button and "Don't Save" as the discard button.
 */
export function presentOpenPrompt(project: ProjectLoss): QuitGuardPromptView {
  return {
    title: { key: "quitGuard.open.saveTitle" },
    lines: [projectLine(project.fileName)],
    confirm: { key: "quitGuard.save" },
    destructive: false,
    discard: { key: "quitGuard.dontSave" },
  };
}

/**
 * Presents the dialog that asks before Clear Timeline.
 *
 * - The plain form: the segments line says that Undo brings the segments back.
 * - The save form (ADR 072): a line names the file of the project, a line says that Clear
 *   Timeline closes the project, and a line says that Undo brings the videos and the segments
 *   back but not the file. Save is the primary button and "Don't Save" the discard button.
 *
 * The pending In line appears in both forms, only when a pending In point exists.
 */
export function presentClearPrompt(prompt: ClearPrompt): QuitGuardPromptView {
  const pendingIn: QuitGuardMessage[] = prompt.pendingIn
    ? [{ key: "quitGuard.clear.pendingIn" }]
    : [];
  if (prompt.form === "plain") {
    return {
      title: { key: "quitGuard.clear.title" },
      lines: [
        { key: "quitGuard.clear.segments", values: { count: prompt.segments } },
        ...pendingIn,
      ],
      confirm: { key: "quitGuard.clear.confirm" },
      destructive: true,
      discard: null,
    };
  }
  return {
    title: { key: "quitGuard.clear.saveTitle" },
    lines: [
      projectLine(prompt.fileName),
      { key: "quitGuard.clear.projectCloses" },
      { key: "quitGuard.clear.undoKeepsNoFile" },
      ...pendingIn,
    ],
    confirm: { key: "quitGuard.save" },
    destructive: false,
    discard: { key: "quitGuard.dontSave" },
  };
}
