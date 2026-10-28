/**
 * Pure presenter for the status bar export indicator.
 *
 * Implements status bar indicator visibility and view model derivation according to ADR 025.
 * The indicator is hidden when the export dialog is open or when status is idle. It also shows
 * the queue of the batch (ADR 049).
 */

import {
  exportBatchContinues,
  exportBatchHasFailure,
  isExportRunLive,
  type ExportError,
  type ExportQueueState,
  type ExportRunLiveState,
  type ExportState,
} from "@/features/export";
import { splitFilePath } from "@/lib/fileName";
import {
  formatRemaining,
  presentExportProgress,
  type ExportProgressInput,
  type ExportProgressView,
} from "../export/exportProgressPresenter";

export type ExportResultKind = "finished" | "failed" | "canceled";

/** The facts of the batch that the indicator shows, from the export queue store. */
export interface ExportIndicatorBatchInput {
  /** The number of runs that wait in the queue, less the runs that the user removes. */
  readonly waitingCount: number;
  /**
   * True while the batch goes on after the run of the export store
   * (`exportBatchContinues`).
   */
  readonly continues: boolean;
  /** The ends of the runs of the batch that ended before the run of the export store. */
  readonly earlierEnds: readonly ExportResultKind[];
  /**
   * The output path of the last run in `earlierEnds`, or null. The result of a batch that
   * ended while the export store is idle names that file.
   */
  readonly lastEndOutputPath: string | null;
  /**
   * True when `ended` holds an end that the user did not see before a reset of the export
   * store (`ExportQueueState.seenEndedCount`). Only such an end gives the result of a batch
   * that ended while the export store is idle.
   */
  readonly hasUnseenEnd: boolean;
}

/** The input of a batch of one run, with nothing that waits. */
export const SINGLE_RUN_BATCH: ExportIndicatorBatchInput = {
  waitingCount: 0,
  continues: false,
  earlierEnds: [],
  lastEndOutputPath: null,
  hasUnseenEnd: false,
};

/** The batch facts of the indicator, from the export queue store and the export store. */
export function batchInputOf(
  queue: Pick<
    ExportQueueState,
    | "jobs"
    | "order"
    | "waiting"
    | "removing"
    | "submitting"
    | "ended"
    | "seenEndedCount"
  >,
  exportState: Pick<ExportState, "runId">,
): ExportIndicatorBatchInput {
  const earlier = queue.ended.filter((entry) => entry.runId !== exportState.runId);
  const last = earlier[earlier.length - 1];
  return {
    waitingCount: queue.waiting.filter((runId) => !queue.removing.includes(runId))
      .length,
    continues: exportBatchContinues(queue, exportState),
    earlierEnds: earlier.map((entry) => entry.status),
    lastEndOutputPath:
      last === undefined ? null : (queue.jobs[last.runId]?.outputPath ?? null),
    hasUnseenEnd: queue.ended.length > queue.seenEndedCount,
  };
}

export type ExportIndicatorInput = ExportProgressInput & {
  panelOpen: boolean;
  outputPath: string | null;
  /** The batch of the run. A batch of one run when the field is not given. */
  batch?: ExportIndicatorBatchInput;
};

/**
 * The summary of a batch of more than one run: `count` runs ended, and `finished` of them
 * finished. It fills `statusBar.export.batchSummary`.
 */
export interface ExportBatchSummary {
  readonly count: number;
  readonly finished: number;
}

/**
 * The text of an active run: one catalog key, and the values of its placeholders.
 *
 * `percentFraction` fills `{{percent}}` and `remainingSeconds` fills `{{time}}`. Each key
 * holds a complete sentence, so no sentence is assembled from fragments (ADR 011).
 */
export type ExportIndicatorLine =
  | {
      key:
        | "statusBar.export.preparing"
        | "statusBar.export.runningUnknown"
        | "statusBar.export.publishing"
        | "statusBar.export.canceling"
        | "statusBar.export.stopFailed";
    }
  | { key: "statusBar.export.running"; percentFraction: number }
  | {
      key: "statusBar.export.runningWithRemaining";
      percentFraction: number;
      remainingSeconds: number;
    };

export type ExportIndicatorView =
  | {
      kind: "active";
      progress: ExportProgressView;
      line: ExportIndicatorLine;
      outputName: string | null;
      /** The number of runs that wait in the queue. Zero shows no count. */
      queuedCount: number;
    }
  | {
      kind: ExportResultKind;
      outputName: string | null;
      /** The summary of a batch of more than one run, or null for a batch of one run. */
      batchSummary: ExportBatchSummary | null;
      /**
       * True when the run of the export store finished, so its file can be shown. The kind
       * of a batch with a failed run is `failed`, also when its last run finished.
       */
      lastRunFinished: boolean;
      /**
       * False while the run is live (`isExportRunLive`), because a dismissal resets the
       * store and drops the only record of the run. A live `failed` shows as `active`, so a
       * result is not live today. The field is a second guard on the dismiss control.
       */
      canDismiss: boolean;
    };

/**
 * The file name of an output path, by the rule of `splitFilePath`, which the finished export
 * panel also uses. Null for null or a path with no segment.
 */
export function outputNameOf(path: string | null): string | null {
  if (path === null) {
    return null;
  }
  return splitFilePath(path)?.name ?? null;
}

/**
 * The text of a live run.
 *
 * The time estimate needs the percent: both come from `expectedFrames`, and the progress
 * presenter gives no estimate without it. The line with the estimate therefore always holds
 * the percent too.
 *
 * `stopFailed` is true for a `failed` status that the store still tracks: a Stop request
 * failed, and the export continues. The line says that, until the user asks for the stop
 * again. An outstanding request then shows "Stopping", as in every other phase.
 */
export function presentIndicatorLine(
  progress: ExportProgressView,
  stopFailed = false,
): ExportIndicatorLine {
  if (stopFailed && progress.phase !== "canceling") {
    return { key: "statusBar.export.stopFailed" };
  }
  switch (progress.phase) {
    case "preparing":
      return { key: "statusBar.export.preparing" };
    case "publishing":
      return { key: "statusBar.export.publishing" };
    case "canceling":
      return { key: "statusBar.export.canceling" };
    case "running":
      if (progress.percentFraction === null) {
        return { key: "statusBar.export.runningUnknown" };
      }
      if (progress.remainingSeconds === null) {
        return {
          key: "statusBar.export.running",
          percentFraction: progress.percentFraction,
        };
      }
      return {
        key: "statusBar.export.runningWithRemaining",
        percentFraction: progress.percentFraction,
        remainingSeconds: progress.remainingSeconds,
      };
  }
}

/**
 * The progress between two runs of a batch: the preparation of the next run, with no value.
 */
const BETWEEN_RUNS_PROGRESS: ExportProgressView = {
  phase: "preparing",
  basePhase: "preparing",
  barValue: null,
  percentFraction: null,
  remainingSeconds: null,
  speed: null,
  frame: null,
  expectedFrames: null,
};

/**
 * The result of a batch from the ends of its runs, in order. The last end gives the kind,
 * except that a batch of more than one run with a failed run is `failed`
 * (`exportBatchHasFailure`). A batch of more than one run also gets a summary.
 */
function batchResultOf(ends: readonly ExportResultKind[]): {
  kind: ExportResultKind;
  batchSummary: ExportBatchSummary | null;
} | null {
  const last = ends[ends.length - 1];
  if (last === undefined) {
    return null;
  }
  return {
    kind: exportBatchHasFailure(ends) ? "failed" : last,
    batchSummary:
      ends.length > 1
        ? {
            count: ends.length,
            finished: ends.filter((end) => end === "finished").length,
          }
        : null,
  };
}

/**
 * Null when the panel is open, or when the status is idle and no batch ended (ADR 025).
 *
 * A live run (`isExportRunLive`) shows as `active`, also a `failed` that the store still
 * tracks. A Stop request failed there, and the backend still encodes, so the item shows the
 * progress and not a result. A result would offer the dismissal and be announced as a
 * failure that has not happened. The active item also gives the number of waiting runs.
 *
 * Between two runs of a batch (`batch.continues`), the run of the export store ended and the
 * next run did not take the slot yet. The item shows the preparation, and not the result of
 * the run that ended. So the result of a run in the middle of a batch is not shown, flashed,
 * or announced. Only the end of the batch gives a result. For a batch of more than one run,
 * that result also holds a summary of the batch, and a failed run makes it a failure
 * (ADR 049).
 *
 * A batch can also end while the export store is idle: a reset while runs waited, such as the
 * Close of the dialog, and then the failure of the last waiting run before it took the slot.
 * The result then comes from the runs in the queue, and it shows only when a run ended after
 * the reset. The result that the reset dropped does not come back.
 */
export function presentExportIndicator(
  input: ExportIndicatorInput,
): ExportIndicatorView | null {
  if (input.panelOpen) {
    return null;
  }
  const batch = input.batch ?? SINGLE_RUN_BATCH;

  if (isExportRunLive(input)) {
    const progress = presentExportProgress(input);
    if (!progress) {
      return null;
    }
    return {
      kind: "active",
      progress,
      line: presentIndicatorLine(progress, input.status === "failed"),
      outputName: outputNameOf(input.outputPath),
      queuedCount: batch.waitingCount,
    };
  }

  if (batch.continues) {
    return {
      kind: "active",
      progress: BETWEEN_RUNS_PROGRESS,
      line: presentIndicatorLine(BETWEEN_RUNS_PROGRESS),
      // The run of the export store ended, so its output is not the output of this line.
      outputName: null,
      queuedCount: batch.waitingCount,
    };
  }

  if (
    input.status === "finished" ||
    input.status === "failed" ||
    input.status === "canceled"
  ) {
    const result = batchResultOf([...batch.earlierEnds, input.status]);
    if (result === null) {
      return null;
    }
    return {
      ...result,
      outputName: outputNameOf(input.outputPath),
      lastRunFinished: input.status === "finished",
      canDismiss: !isExportRunLive(input),
    };
  }

  // The result that the reset dropped was seen, so only a later end shows.
  if (input.status === "idle" && batch.hasUnseenEnd) {
    const result = batchResultOf(batch.earlierEnds);
    if (result === null) {
      return null;
    }
    return {
      ...result,
      outputName: outputNameOf(batch.lastEndOutputPath),
      lastRunFinished: false,
      canDismiss: true,
    };
  }

  return null;
}

export type ExportResultLabelKey =
  "statusBar.export.finished" | "statusBar.export.failed" | "statusBar.export.canceled";

/** The catalog key of the result item of a run that ended. */
export function resultLabelKey(kind: ExportResultKind): ExportResultLabelKey {
  switch (kind) {
    case "finished":
      return "statusBar.export.finished";
    case "failed":
      return "statusBar.export.failed";
    case "canceled":
      return "statusBar.export.canceled";
  }
}

/**
 * The catalog key of the text for the polite live region of the status bar, or null for an
 * empty region.
 *
 * Only a result is announced. A result item exists only while the dialog is hidden, so the
 * region speaks only for a run that ended behind the editor. The dialog announces its own
 * result. An active run gives null, so no progress change is announced. A failed Stop
 * request has an announcement of its own (`presentStopFailureAnnouncement`).
 */
export function announcementKeyOf(
  view: ExportIndicatorView | null,
): ExportResultLabelKey | null {
  if (view === null || view.kind === "active") {
    return null;
  }
  return resultLabelKey(view.kind);
}

/**
 * The failure of a Stop request while the run continues: the error of a `failed` status that
 * the store still tracks (`isExportRunLive`). Null in every other state. The store writes a
 * new error instance for each failure, so the instance names one failure.
 */
export function liveStopFailureOf(
  state: ExportRunLiveState & { error: ExportError | null },
): ExportError | null {
  return state.status === "failed" && isExportRunLive(state) ? state.error : null;
}

export interface StopFailureAnnouncementInput {
  /** The failure of a Stop request while the run continues (`liveStopFailureOf`), or null. */
  readonly failure: ExportError | null;
  readonly panelOpen: boolean;
  /** The last failure that the open dialog showed, or null. */
  readonly shownFailure: ExportError | null;
}

export interface StopFailureAnnouncement {
  /**
   * The catalog key of the text for the polite live region, or null for no text. It is the
   * sentence of the dialog notice, not the visible status bar line: some screen readers read
   * the "·" of that line aloud.
   */
  readonly key: "export.status.stopFailed" | null;
  /** The next value of `shownFailure`. The caller keeps it for the next call. */
  readonly shownFailure: ExportError | null;
}

/**
 * Decides whether the polite live region of the status bar announces a failed Stop request.
 *
 * The region announces each failure once, while the dialog is hidden. The text stays the same
 * while the failure is current, so a progress event changes nothing and is not announced. A
 * failure that the open dialog showed is not announced again when the dialog hides, because
 * the dialog announced it with its own alert. The caller keeps `shownFailure` for that.
 */
export function presentStopFailureAnnouncement(
  input: StopFailureAnnouncementInput,
): StopFailureAnnouncement {
  if (input.failure === null) {
    return { key: null, shownFailure: input.shownFailure };
  }
  if (input.panelOpen) {
    return { key: null, shownFailure: input.failure };
  }
  return {
    key: input.failure === input.shownFailure ? null : "export.status.stopFailed",
    shownFailure: input.shownFailure,
  };
}

/**
 * The value that the caller gives for a placeholder when it formats a line with slots. One
 * character from the Unicode private use area for each slot: it holds no brace, so i18next
 * does not change it, and no catalog message holds it.
 */
export const INDICATOR_SLOT_MARKERS = {
  percent: "\uE001",
  time: "\uE002",
} as const;

export type IndicatorSlot = keyof typeof INDICATOR_SLOT_MARKERS;

/** One piece of a formatted message: plain text, or the place of one slot. */
export type IndicatorMessagePart =
  { kind: "text"; text: string } | { kind: "slot"; slot: IndicatorSlot };

/**
 * Splits a message that was formatted with `INDICATOR_SLOT_MARKERS` as the placeholder
 * values. The parts keep the order of the message, so the translator still decides where
 * each value goes. An empty text part is left out.
 */
export function splitAtSlots(message: string): IndicatorMessagePart[] {
  const slotOf = new Map<string, IndicatorSlot>(
    (Object.keys(INDICATOR_SLOT_MARKERS) as IndicatorSlot[]).map((slot) => [
      INDICATOR_SLOT_MARKERS[slot],
      slot,
    ]),
  );
  const parts: IndicatorMessagePart[] = [];
  let text = "";
  // `for...of` walks code points, and each marker is one code point.
  for (const char of message) {
    const slot = slotOf.get(char);
    if (slot === undefined) {
      text += char;
      continue;
    }
    if (text !== "") {
      parts.push({ kind: "text", text });
      text = "";
    }
    parts.push({ kind: "slot", slot });
  }
  if (text !== "") {
    parts.push({ kind: "text", text });
  }
  return parts;
}

/** Formats one catalog message with its values. The component passes its `t`. */
export type IndicatorTranslate = (
  key: ExportIndicatorLine["key"],
  values?: Readonly<Record<string, string>>,
) => string;

export interface FormattedIndicatorLine {
  /** The whole sentence with its values, for the accessible name. */
  label: string;
  /** The sentence split at its slots, for the fixed-width layout. */
  parts: IndicatorMessagePart[];
  /** The formatted value of each slot. A slot that the line does not hold is empty. */
  slotText: Readonly<Record<IndicatorSlot, string>>;
}

/**
 * Formats the line of an active run.
 *
 * A line with values is formatted twice from its one catalog key: once with the values, for
 * the accessible name, and once with the slot markers, which `splitAtSlots` turns into the
 * parts of the fixed-width layout. The catalog message stays one plain sentence with named
 * placeholders (ADR 011), so the translator sees no markup and still decides the order of the
 * values and of the words around them.
 */
export function formatIndicatorLine(
  line: ExportIndicatorLine,
  translate: IndicatorTranslate,
  formatPercent: (fraction: number) => string,
): FormattedIndicatorLine {
  switch (line.key) {
    case "statusBar.export.runningWithRemaining": {
      const slotText = {
        percent: formatPercent(line.percentFraction),
        time: formatRemaining(line.remainingSeconds),
      };
      return {
        label: translate(line.key, slotText),
        parts: splitAtSlots(translate(line.key, INDICATOR_SLOT_MARKERS)),
        slotText,
      };
    }
    case "statusBar.export.running": {
      const percent = formatPercent(line.percentFraction);
      return {
        label: translate(line.key, { percent }),
        parts: splitAtSlots(
          translate(line.key, { percent: INDICATOR_SLOT_MARKERS.percent }),
        ),
        slotText: { percent, time: "" },
      };
    }
    default: {
      const label = translate(line.key);
      return {
        label,
        parts: label === "" ? [] : [{ kind: "text", text: label }],
        slotText: { percent: "", time: "" },
      };
    }
  }
}

/** Where the focus goes, as seen from the keyed wrapper of the indicator. */
export type IndicatorFocusPlace = "inside" | "outside" | "none";

export interface IndicatorBlurInput {
  /** The next target of the blur: in the wrapper, outside it, or no element. */
  nextTarget: IndicatorFocusPlace;
  /** `document.hasFocus()` while the blur runs. */
  documentHasFocus: boolean;
}

/**
 * True when the focus is still inside the indicator after a blur inside it.
 *
 * - A next target inside the wrapper keeps the focus inside. A next target outside it takes
 *   the focus away.
 * - A blur with no next target in a window that keeps the focus moves the focus to the body,
 *   such as a click on an empty area. The focus is then outside.
 * - A blur with no next target in a window that lost the focus keeps the focus inside. The
 *   focus comes back to the same place, and a run that ends in the background must not lose
 *   it.
 */
export function focusInsideAfterBlur(input: IndicatorBlurInput): boolean {
  switch (input.nextTarget) {
    case "inside":
      return true;
    case "outside":
      return false;
    case "none":
      return !input.documentHasFocus;
  }
}

export interface IndicatorFocusRestoreInput {
  /** True when the focus was inside the wrapper before the view kind changed. */
  focusWasInside: boolean;
  /** False when the indicator shows nothing, such as while the dialog is open. */
  wrapperExists: boolean;
  /**
   * Where `document.activeElement` is after the change. `"none"` is no element or the body,
   * which is where the browser puts the focus when it removes the focused element.
   */
  activeElement: IndicatorFocusPlace;
}

export type IndicatorFocusRestore =
  { restore: true } | { restore: false; focusInside: boolean };

/**
 * Decides, after a change of the view kind, whether the first button of the new content takes
 * the focus back. When it does not, `focusInside` is the new value of the focus note.
 *
 * - The focus was not inside: nothing to restore.
 * - The indicator shows nothing: nothing to restore to. The dialog takes the focus.
 * - The focus is already on an element: it stays there. The note is true only when that
 *   element is in the new content.
 * - The focus is nowhere: the focused button went with the old content, so restore.
 */
export function decideFocusRestore(
  input: IndicatorFocusRestoreInput,
): IndicatorFocusRestore {
  if (!input.focusWasInside || !input.wrapperExists) {
    return { restore: false, focusInside: false };
  }
  switch (input.activeElement) {
    case "none":
      return { restore: true };
    case "inside":
      return { restore: false, focusInside: true };
    case "outside":
      return { restore: false, focusInside: false };
  }
}
