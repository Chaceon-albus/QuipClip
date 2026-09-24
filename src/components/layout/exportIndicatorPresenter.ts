/**
 * Pure presenter for the status bar export indicator.
 *
 * Implements status bar indicator visibility and view model derivation according to ADR 025.
 * The indicator is hidden when the export dialog is open or when status is idle.
 */

import { isExportRunLive } from "@/features/export";
import { splitFilePath } from "@/lib/fileName";
import {
  formatRemaining,
  presentExportProgress,
  type ExportProgressInput,
  type ExportProgressView,
} from "../export/exportProgressPresenter";

export type ExportIndicatorInput = ExportProgressInput & {
  panelOpen: boolean;
  outputPath: string | null;
  /** The `tracking` field of the export store: true while it tracks a run by its id. */
  tracking: boolean;
};

export type ExportResultKind = "finished" | "failed" | "canceled";

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
        | "statusBar.export.canceling";
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
    }
  | {
      kind: ExportResultKind;
      outputName: string | null;
      /**
       * False while the store reports `failed` and still tracks the run. A Stop that fails at
       * the IPC layer gives that state: the backend still encodes the run, and a dismissal
       * resets the store, which drops the only record of the live run.
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
 * The text of an active run.
 *
 * The time estimate needs the percent: both come from `expectedFrames`, and the progress
 * presenter gives no estimate without it. The line with the estimate therefore always holds
 * the percent too.
 */
export function presentIndicatorLine(
  progress: ExportProgressView,
): ExportIndicatorLine {
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

/** Null when the panel is open or the status is idle (ADR 025). */
export function presentExportIndicator(
  input: ExportIndicatorInput,
): ExportIndicatorView | null {
  if (input.panelOpen || input.status === "idle") {
    return null;
  }

  const outputName = outputNameOf(input.outputPath);

  if (
    input.status === "preparing" ||
    input.status === "running" ||
    input.status === "publishing"
  ) {
    const progress = presentExportProgress(input);
    if (!progress) {
      return null;
    }
    return {
      kind: "active",
      progress,
      line: presentIndicatorLine(progress),
      outputName,
    };
  }

  if (
    input.status === "finished" ||
    input.status === "failed" ||
    input.status === "canceled"
  ) {
    return {
      kind: input.status,
      outputName,
      canDismiss: !isExportRunLive(input),
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
 * result. An active run gives null, so no progress change is announced.
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
