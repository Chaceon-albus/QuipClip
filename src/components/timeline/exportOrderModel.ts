/**
 * The pure model of the Export Order dialog (ADR 066): the draft and its changes, the rows, the
 * keys of the list, the sort by timeline position, and what a confirm does.
 *
 * The draft is a list of segment ids in an order. It lives in the dialog only, and the timeline
 * store does not change before the confirm.
 *
 * The functions return values and translation keys, and do not call the i18n runtime (ADR 011).
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { BigIntRational } from "@/features/timeline/math";
import { exportSegmentGridLength } from "@/features/timeline/segmentTotal";
import {
  layoutSequence,
  toSequenceTime,
  type SequenceSources,
} from "@/features/timeline/sequence";
import type { TimelineState } from "@/features/timeline/types";
import { formatGridCountTimecode, type TimecodeDisplay } from "@/lib/timecode";
import type { Clip, Pts, Rational, Segment, SequenceSegment } from "@/types/project";
import {
  formatSegmentTimes,
  resolveSegmentAccessibleName,
  resolveSegmentTitle,
  type SegmentText,
} from "./segmentLabels";

/**
 * The attribute of the Export Order button of the segment summary. The dialog finds the button
 * by it, to give it the focus when the element that opened the dialog is gone.
 */
export const EXPORT_ORDER_TRIGGER_ATTRIBUTE = "data-export-order-trigger";

/**
 * The text of a time that is not known: the In or the Out of a segment whose place on the
 * timeline is not known. It is a mark and not a word, so it is not translated.
 */
export const EXPORT_ORDER_UNKNOWN_TIME = "–";

/** True when the two lists hold the same ids in the same order. */
export function isSameExportOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** True when the two lists hold the same ids, each one time, in any order. */
export function isSameExportSegmentSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== a.length || right.size !== b.length || left.size !== right.size) {
    return false;
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * The draft after the row at `from` moves to `to`, where `to` is the index of the row in the new
 * list. The same list when the move changes nothing or an index is out of range.
 */
export function moveExportOrderRow(
  draft: readonly string[],
  from: number,
  to: number,
): readonly string[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= draft.length ||
    to >= draft.length ||
    from === to
  ) {
    return draft;
  }
  const next = [...draft];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return draft;
  }
  next.splice(to, 0, moved);
  return next;
}

/** What a draft must do after a change of the timeline (`syncExportOrderDraft`). */
export type ExportOrderDraftSync =
  /** The draft names the segments of the export: it stays. */
  | { readonly kind: "keep" }
  /**
   * The segments of the export changed: the dialog discards the draft, shows `draft`, the
   * segments of the export in their order of this moment, and says that the timeline changed.
   */
  | { readonly kind: "reset"; readonly draft: readonly string[] };

/**
 * Compares the draft with the segments of the export, as sets (ADR 066). The dialog runs it on
 * each change of the store while it is open. A change of the order alone keeps the draft: the
 * store action takes any order of the same ids.
 *
 * @param draft The ids of the draft.
 * @param exportIds The ids of the segments of the export now (`exportSegmentIds`).
 */
export function syncExportOrderDraft(
  draft: readonly string[],
  exportIds: readonly string[],
): ExportOrderDraftSync {
  return isSameExportSegmentSet(draft, exportIds)
    ? { kind: "keep" }
    : { kind: "reset", draft: exportIds };
}

/** What the dialog shows after a change of the segments of the export (`followExportOrderTimeline`). */
export type ExportOrderTimelineChange =
  /** The draft stays, and so does the focused row. */
  | { readonly kind: "keep" }
  /**
   * The dialog discards the draft and any drag, shows `draft`, says that the timeline changed,
   * and gives the focus to the row of `focusId`.
   */
  | {
      readonly kind: "reset";
      readonly draft: readonly string[];
      readonly focusId: string | null;
    };

/**
 * What the open dialog does when the segments of the export change under it, as when an import
 * that started before the open ends, or a released trim writes its boundary (ADR 066). The draft
 * stays while it names the same segments (`syncExportOrderDraft`). Else the dialog shows the
 * segments of the export in their order of this moment. The focused row keeps the focus when it
 * is still in the list, and the first row takes it otherwise.
 *
 * @param draft The ids of the draft.
 * @param focusId The id of the focused row, or null.
 * @param exportIds The ids of the segments of the export now (`exportSegmentIds`).
 */
export function followExportOrderTimeline(
  draft: readonly string[],
  focusId: string | null,
  exportIds: readonly string[],
): ExportOrderTimelineChange {
  const sync = syncExportOrderDraft(draft, exportIds);
  if (sync.kind === "keep") {
    return sync;
  }
  return {
    kind: "reset",
    draft: sync.draft,
    focusId:
      focusId !== null && sync.draft.includes(focusId)
        ? focusId
        : (sync.draft[0] ?? null),
  };
}

/**
 * The `data-state` of the list box: `closed` while the dialog is closed and its content plays
 * the exit animation. Radix marks the dialog itself, but not a list box inside it. The window
 * keyboard layer and the command items of the macOS menu do nothing while a list box of the page
 * is open (`MODAL_LAYER_SELECTOR`), and that selector skips a list box with this state, so a
 * closing dialog does not block them (ADR 021).
 */
export function exportOrderListState(isOpen: boolean): "open" | "closed" {
  return isOpen ? "open" : "closed";
}

/** Where the focus is when the dialog gives it to a row. */
export type ExportOrderFocusPlace =
  /** On a row of the list. */
  | "list"
  /**
   * Nowhere in particular: on the body, or on an element that contains the list, such as the
   * dialog itself. Radix focuses the dialog when the focused node left the document, as a row
   * does that moves in the document.
   */
  | "lost"
  /** On a control that a change of the draft or a drag disabled, such as Apply or Sort. */
  | "disabledControl"
  /** On another enabled control, such as Cancel. */
  | "control";

/**
 * True when the dialog gives the focus to a row after a move, a drop, the end of a drag, a sort
 * or a reset. An enabled control that holds the focus keeps it: the user moved the focus there,
 * also with Tab during a drag.
 */
export function canMoveExportOrderFocusToRow(place: ExportOrderFocusPlace): boolean {
  return place !== "control";
}

/** Compares two exact sequence times: negative when `a` is first, zero when equal. */
export function compareSequenceTimes(a: BigIntRational, b: BigIntRational): number {
  // `reduceBigIntRational` keeps every denominator positive, so the cross products compare.
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The draft in the order of the start of each segment on the sequence (ADR 066). The starts are
 * exact values, never formatted text. Segments with the same start keep their order among
 * themselves. Segments with no known start keep their order among themselves, after the others.
 *
 * @param draft The ids of the draft.
 * @param starts The exact start of each segment on the sequence, or null when it is not known.
 */
export function sortExportOrderByTimelinePosition(
  draft: readonly string[],
  starts: ReadonlyMap<string, BigIntRational | null>,
): readonly string[] {
  const known: { readonly id: string; readonly start: BigIntRational }[] = [];
  const unknown: string[] = [];
  for (const id of draft) {
    const start = starts.get(id) ?? null;
    if (start === null) {
      unknown.push(id);
    } else {
      known.push({ id, start });
    }
  }
  // `Array.prototype.sort` is stable, so equal starts keep the order of the draft.
  known.sort((a, b) => compareSequenceTimes(a.start, b.start));
  const sorted = [...known.map((entry) => entry.id), ...unknown];
  return isSameExportOrder(sorted, draft) ? draft : sorted;
}

/** The parts of the timeline state that the starts of the segments read. */
export type ExportOrderStartsInput = Pick<
  TimelineState,
  "clips" | "sequenceSegments" | "sequenceSources" | "browserDurations"
>;

/**
 * The exact start of each segment of `ids` on the sequence (`toSequenceTime` of its In), or null
 * when its place is not known: the layout of the sequence is not known, the segment is not in the
 * array, or its In is not on its clip.
 */
export function exportSegmentStarts(
  state: ExportOrderStartsInput,
  ids: readonly string[],
): Map<string, BigIntRational | null> {
  const sources: SequenceSources = new Map(Object.entries(state.sequenceSources));
  const layout = layoutSequence(
    state.clips,
    sources,
    new Map(Object.entries(state.browserDurations)),
  );
  const byId = new Map(state.sequenceSegments.map((segment) => [segment.id, segment]));
  const starts = new Map<string, BigIntRational | null>();
  for (const id of ids) {
    const segment = byId.get(id);
    starts.set(
      id,
      layout === null || segment === undefined
        ? null
        : toSequenceTime(layout, state.clips, sources, {
            clipId: segment.inClipId,
            pts: segment.inPts,
          }),
    );
  }
  return starts;
}

/** One row of the list. */
export interface ExportOrderRow {
  readonly id: string;
  /** The 1-based place of the row in the list, which the export takes. */
  readonly number: number;
  /** The name of the segment (ADR 065), or undefined for no name. */
  readonly name: string | undefined;
  /** The In as sequence time, or null when the place of the segment is not known. */
  readonly inTime: string | null;
  /** The Out as sequence time, or null when the place of the segment is not known. */
  readonly outTime: string | null;
  /** The duration, or null when it is not known. */
  readonly duration: string | null;
}

/** The facts that the rows read, all from the timeline and the sequence probe of this moment. */
export interface ExportOrderRowFacts {
  /** The derived segments by id: the segments that have a place on the timeline. */
  readonly placed: ReadonlyMap<string, Segment>;
  /** The anchored segments by id. */
  readonly anchored: ReadonlyMap<string, SequenceSegment>;
  readonly clips: readonly Clip[];
  readonly sources: SequenceSources;
  /** The start PTS of the virtual source, as the timeline reads it. */
  readonly videoStartPts: Pts | null | undefined;
  /** The time base of the virtual source, as the timeline reads it. */
  readonly videoTimeBase: Rational | null | undefined;
  /** The timecode format that the timeline shows (ADR 028). */
  readonly display: TimecodeDisplay;
}

/**
 * The rows of the draft, in its order, numbered from 1 (ADR 066).
 *
 * A segment with a place on the timeline shows its In, its Out and its duration in the format of
 * the timeline, by the rule of its tooltip (`formatSegmentTimes`), so a row and the tooltip show
 * the same text. A segment whose place is not known shows no times, and its duration when its
 * pieces give one. The duration is `exportSegmentGridLength`, which the total of the summary
 * adds, so the rows and the total always agree.
 */
export function buildExportOrderRows(
  draft: readonly string[],
  facts: ExportOrderRowFacts,
): ExportOrderRow[] {
  return draft.map((id, index) => {
    const placed = facts.placed.get(id);
    const anchored = facts.anchored.get(id);
    const name = anchored?.name ?? placed?.name;
    const times =
      placed === undefined
        ? null
        : formatSegmentTimes(
            placed,
            facts.videoStartPts,
            facts.videoTimeBase,
            facts.display,
          );
    // The one length that the total of the summary adds too (`exportSegmentGridLength`). With
    // times on the virtual axis, it is the length of those times, so the row and the tooltip
    // show the same duration.
    const length = exportSegmentGridLength(placed, anchored, {
      clips: facts.clips,
      sources: facts.sources,
      axis:
        facts.videoTimeBase && facts.videoStartPts
          ? { videoTimeBase: facts.videoTimeBase, videoStartPts: facts.videoStartPts }
          : null,
      display: facts.display,
    });
    return {
      id,
      number: index + 1,
      name,
      inTime: times?.inTime ?? null,
      outTime: times?.outTime ?? null,
      duration: length === null ? null : formatGridCountTimecode(length, facts.display),
    };
  });
}

/**
 * The accessible name of a row: its number, its name when it has one, and its times. A row with
 * no known place names its duration when it is known.
 */
export function resolveExportOrderRowName(
  row: ExportOrderRow,
): SegmentText<
  | "timeline.segment"
  | "timeline.segmentNamed"
  | "timeline.segmentLabel"
  | "timeline.segmentLabelNamed"
  | "timeline.exportOrder.rowDuration"
  | "timeline.exportOrder.rowDurationNamed"
> {
  if (row.inTime !== null && row.outTime !== null && row.duration !== null) {
    return resolveSegmentAccessibleName(row.number, row.name, {
      inTime: row.inTime,
      outTime: row.outTime,
      duration: row.duration,
    });
  }
  if (row.duration !== null) {
    return row.name === undefined
      ? {
          key: "timeline.exportOrder.rowDuration",
          values: { index: row.number, duration: row.duration },
        }
      : {
          key: "timeline.exportOrder.rowDurationNamed",
          values: { index: row.number, name: row.name, duration: row.duration },
        };
  }
  return resolveSegmentTitle(row.number, row.name);
}

/** The message that the live region reads after a row moved. */
export function resolveExportOrderMoveMessage(
  index: number,
  total: number,
): SegmentText<"timeline.exportOrder.moved"> {
  return {
    key: "timeline.exportOrder.moved",
    values: { position: index + 1, total },
  };
}

/** The part of a key press that `resolveExportOrderKey` reads. */
export interface ExportOrderKeyPress {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  /** Legacy code. 229 marks a key that an input method took. */
  readonly keyCode: number;
}

/** What a key press on a focused row does. */
export type ExportOrderKeyAction =
  /** The focus goes to another row, and the draft does not change. */
  | {
      readonly kind: "focus";
      readonly target: "previous" | "next" | "first" | "last";
    }
  /** The focused row moves one place, and keeps the focus. */
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | null;

/**
 * The action of a key press on a focused row (ADR 066):
 *
 * - Up and Down with no modifier move the focus to the row before or after.
 * - Up and Down with `Alt` (`Option` on macOS) and no other modifier move the focused row one
 *   place.
 * - Home and End with no modifier move the focus to the first and the last row.
 *
 * Every other key, Enter included, does nothing here: Enter does not confirm the dialog. The
 * dialog calls `preventDefault` only for a key that this returns an action for.
 */
export function resolveExportOrderKey(
  press: ExportOrderKeyPress,
): ExportOrderKeyAction {
  if (press.isComposing || press.keyCode === 229) {
    return null;
  }
  if (press.ctrlKey || press.metaKey || press.shiftKey) {
    return null;
  }
  if (press.altKey) {
    if (press.key === "ArrowUp") {
      return { kind: "move", delta: -1 };
    }
    if (press.key === "ArrowDown") {
      return { kind: "move", delta: 1 };
    }
    return null;
  }
  switch (press.key) {
    case "ArrowUp":
      return { kind: "focus", target: "previous" };
    case "ArrowDown":
      return { kind: "focus", target: "next" };
    case "Home":
      return { kind: "focus", target: "first" };
    case "End":
      return { kind: "focus", target: "last" };
    default:
      return null;
  }
}

/**
 * The index of the row that takes the focus, from the index of the focused row. The focus stops at
 * the first and the last row: it does not wrap. Null for an empty list.
 */
export function focusIndexAfter(
  target: "previous" | "next" | "first" | "last",
  index: number,
  count: number,
): number | null {
  if (count <= 0) {
    return null;
  }
  const clamp = (value: number) => Math.min(Math.max(value, 0), count - 1);
  switch (target) {
    case "previous":
      return clamp(index - 1);
    case "next":
      return clamp(index + 1);
    case "first":
      return 0;
    case "last":
      return count - 1;
  }
}

/** The open state of the dialog store that a confirm reads (`exportOrderDialogStore`). */
export interface ExportOrderDialogOpenState {
  readonly isOpen: boolean;
  readonly openCount: number;
}

/**
 * True when a confirm of the content of one open may run: the dialog store is open, and it is
 * still the open that mounted this content. Radix keeps the content of a closing dialog mounted
 * during its exit animation, so a late click must not apply a discarded draft (ADR 065, ADR 066).
 * The caller reads the store when the confirm runs, never from a closure of an earlier render.
 */
export function canRunExportOrderConfirm(
  dialog: ExportOrderDialogOpenState,
  openCount: number,
): boolean {
  return dialog.isOpen && dialog.openCount === openCount;
}

/** The facts that a confirm reads, all read when the confirm runs. */
export interface ExportOrderConfirmInput {
  /** The ids of the draft. */
  readonly draft: readonly string[];
  /** The ids of the segments of the export now, in the order of the array. */
  readonly exportIds: readonly string[];
  /** The dialog store now. */
  readonly dialog: ExportOrderDialogOpenState;
  /** The `openCount` of the open that mounted the content. */
  readonly openCount: number;
  /**
   * True while an edge press is armed or a drag trims an edge (`segmentTrimSession.isLocked`).
   * The edit does nothing then, as the other edit actions (ADR 030).
   */
  readonly isTrimLocked: boolean;
}

/** What a confirm does. */
export type ExportOrderConfirm =
  /** The dialog of this content is closed or closing: nothing happens. */
  | { readonly kind: "ignore" }
  /** A trim holds the edit lock: nothing happens, and the dialog stays open. */
  | { readonly kind: "refuse" }
  /** The draft is in the order of the array: no edit, and the dialog closes. */
  | { readonly kind: "close" }
  /**
   * The dialog gives the draft to the store action (`reorderExportSegments`). When the action
   * refuses it, the dialog discards the draft and says that the timeline changed. Else it closes.
   */
  | { readonly kind: "apply"; readonly ids: readonly string[] };

/** The confirm of the dialog (ADR 066). */
export function planExportOrderConfirm(
  input: ExportOrderConfirmInput,
): ExportOrderConfirm {
  if (!canRunExportOrderConfirm(input.dialog, input.openCount)) {
    return { kind: "ignore" };
  }
  if (input.isTrimLocked) {
    return { kind: "refuse" };
  }
  if (isSameExportOrder(input.draft, input.exportIds)) {
    return { kind: "close" };
  }
  return { kind: "apply", ids: input.draft };
}
