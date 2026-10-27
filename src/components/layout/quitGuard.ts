/**
 * Pure rules that decide whether a quit, or a replacement of the open video, loses work
 * (ADR 027).
 *
 * Version 1 writes no project file, so the segments live only for the session. A quit loses
 * the segments and the pending In point of the open source, a live export, and an unsaved
 * preset draft.
 *
 * Opening another video keeps the segments, but it hides them: they belong to the source of
 * the open video, and the timeline shows only the segments of the active source. They come
 * back when the user opens that video again, so the replace dialog says that and does not
 * call them lost. The replacement does lose the pending In point, because a change of source
 * clears it.
 *
 * The rules have no DOM, no React, no store and no Tauri runtime, so a test can run them in
 * node. They return catalog keys and values, and they do not call the i18n runtime. Each line
 * of a prompt is one complete catalog message, so no sentence is assembled from fragments
 * (ADR 011).
 */

import type { ExportStatus } from "@/features/export";
import { isExportRunLive } from "@/features/export/runState";
import { getActiveSourceSegmentEntries } from "@/features/timeline";
import { isSameFilePath } from "@/lib/filePath";
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

/** Everything that the quit decision and the replace decision read. */
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
  /** The canonical path of the open video, as the import reported it, or null. */
  readonly openMediaPath: string | null;
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
  /** The name of the preset draft with unsaved edits, or null. */
  readonly unsavedPreset: string | null;
}

export interface QuitDecision {
  /** True when the quit must ask the user first. False lets the quit continue at once. */
  readonly ask: boolean;
  readonly loss: QuitLoss;
}

/** What opening another video would change now. */
export interface ReplaceDecision {
  /** True when the open must ask the user first. False opens the video at once. */
  readonly ask: boolean;
  /** The number of segments of the open source. The replacement hides them. */
  readonly segments: number;
  /** True when the open source has a pending In point. The replacement clears it. */
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
 * source, a live export, or an unsaved preset draft. Otherwise it continues at once.
 */
export function decideQuit(input: QuitGuardInput): QuitDecision {
  const loss: QuitLoss = {
    segments: countOpenSourceSegments(input.timeline),
    pendingIn: hasPendingIn(input.timeline),
    exportActive: isExportRunLive({
      status: input.exportStatus,
      tracking: input.exportTracking,
    }),
    unsavedPreset: input.unsavedPresetName,
  };
  const ask =
    loss.segments > 0 ||
    loss.pendingIn ||
    loss.exportActive ||
    loss.unsavedPreset !== null;
  return { ask, loss };
}

/**
 * Decides whether opening the file at `chosenPath` asks first.
 *
 * It asks when the open source has one or more segments, because they leave the timeline
 * (ADR 027). A pending In point alone does not ask: it is one mark, and the user sets it
 * again with one key. When the dialog asks, it also names the pending In point.
 *
 * Opening the file that is already open does not ask. The import then reports the same
 * revision, so the timeline keeps the same source with its segments and its pending In
 * point. When the file changed on disk, the import makes it a new source (ADR 010), and the
 * old segments no longer name its frames, so the dialog would have nothing true to say.
 */
export function decideReplace(
  input: QuitGuardInput,
  chosenPath: string,
): ReplaceDecision {
  const segments = countOpenSourceSegments(input.timeline);
  const pendingIn = hasPendingIn(input.timeline);
  const sameFile =
    input.openMediaPath !== null && isSameFilePath(input.openMediaPath, chosenPath);
  return { ask: segments > 0 && !sameFile, segments, pendingIn };
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
 * Presents the dialog that asks before another video replaces the open one.
 *
 * The segments line says where the segments stay. The pending In line appears only when the
 * open source has one, and only that line names a loss, so the confirm button is destructive
 * only then.
 */
export function presentReplacePrompt(
  change: Pick<ReplaceDecision, "segments" | "pendingIn">,
): QuitGuardPromptView {
  const lines: QuitGuardMessage[] = [
    { key: "quitGuard.replace.segments", values: { count: change.segments } },
  ];
  if (change.pendingIn) {
    lines.push({ key: "quitGuard.loss.pendingIn" });
  }
  return {
    title: { key: "quitGuard.replace.title" },
    lines,
    confirm: { key: "quitGuard.replace.confirm" },
    destructive: change.pendingIn,
  };
}
