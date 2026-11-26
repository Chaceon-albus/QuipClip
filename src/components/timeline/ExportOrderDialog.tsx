import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { DialogActions } from "@/components/common/DialogActions";
import { isInOpenDialog, toLandingFocusTarget } from "@/components/common/focusTarget";
import { Notice } from "@/components/common/Notice";
import { getShortcutPlatform } from "@/components/layout/shortcutBindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resolveTimecodeDisplay } from "@/features/playback";
import { useSequenceMediaStore } from "@/features/sequence";
import {
  useTimecodePreference,
  type TimecodePreferenceState,
} from "@/features/settings/timecodePreference";
import {
  selectExportSegmentIds,
  timelineStore,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { cn } from "@/lib/utils";
import { exportOrderDialogStore } from "./exportOrderDialogStore";
import {
  createExportOrderDragSession,
  createExportOrderEscapeGuard,
  exportOrderAutoScrollStep,
  isExportOrderAutoScrollActive,
  previewExportOrderDrag,
  type ExportOrderDrag,
  type ExportOrderDragEndEvent,
  type ExportOrderListGeometry,
} from "./exportOrderDrag";
import {
  buildExportOrderRows,
  canMoveExportOrderFocusToRow,
  EXPORT_ORDER_TRIGGER_ATTRIBUTE,
  EXPORT_ORDER_UNKNOWN_TIME,
  exportOrderListState,
  exportSegmentStarts,
  focusIndexAfter,
  followExportOrderTimeline,
  isSameExportOrder,
  moveExportOrderRow,
  planExportOrderConfirm,
  resolveExportOrderKey,
  resolveExportOrderMoveMessage,
  resolveExportOrderRowName,
  sortExportOrderByTimelinePosition,
  type ExportOrderFocusPlace,
  type ExportOrderRow,
} from "./exportOrderModel";
import type { TranslateSegmentText } from "./segmentLabels";
import {
  returnSegmentRenameFocus,
  TIMELINE_SEEK_SURFACE_SELECTOR,
} from "./segmentRenameModel";
import { segmentTrimSession } from "./segmentTrimSession";

const handleOpenChange = (open: boolean) => {
  if (!open) {
    exportOrderDialogStore.getState().close();
  }
};

const selectSegments = (state: TimelineStoreState) => state.segments;
const selectSequenceSegments = (state: TimelineStoreState) => state.sequenceSegments;
const selectClips = (state: TimelineStoreState) => state.clips;
const selectSequenceSources = (state: TimelineStoreState) => state.sequenceSources;
const selectBrowserDurations = (state: TimelineStoreState) => state.browserDurations;
const selectTimecodeFormat = (state: TimecodePreferenceState) => state.format;

/** U+00A0. The live region adds it to a message that repeats the message before it. */
const NO_BREAK_SPACE = "\u00a0";

/** The attribute of a row that names the id of its segment. */
const ROW_ATTRIBUTE = "data-export-order-row";

/**
 * The columns of a row and of the header above the list: the grip, the number, the name, the In,
 * the Out and the duration. The three times take a fixed width, so the header and the rows line
 * up, and a millisecond timecode of 12 characters fits.
 */
const ROW_GRID_CLASS =
  "grid grid-cols-[1rem_2.5rem_minmax(0,1fr)_6rem_6rem_6rem] items-center gap-2 px-2";

/** The Export Order button of the segment summary, then the timeline, as focus fallbacks. */
function exportOrderFocusFallbacks() {
  return [
    toLandingFocusTarget(
      document.querySelector<HTMLElement>(`[${EXPORT_ORDER_TRIGGER_ATTRIBUTE}]`),
    ),
    toLandingFocusTarget(
      document.querySelector<HTMLElement>(TIMELINE_SEEK_SURFACE_SELECTOR),
    ),
  ];
}

/** The geometry of the list for the drag (`ExportOrderListGeometry`), read from the DOM now. */
function readListGeometry(list: HTMLElement): ExportOrderListGeometry | null {
  const rows = list.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`);
  const first = rows[0];
  if (first === undefined) {
    return null;
  }
  const second = rows[1];
  const rect = list.getBoundingClientRect();
  return {
    // Every row has one height, so the distance of the first two rows is the pitch.
    rowPitchPx:
      second === undefined ? first.offsetHeight : second.offsetTop - first.offsetTop,
    rowCount: rows.length,
    viewportTopPx: rect.top + list.clientTop,
    viewportHeightPx: list.clientHeight,
    scrollTopPx: list.scrollTop,
    scrollHeightPx: list.scrollHeight,
    // The list is `relative`, so it is the offset parent of its rows.
    firstRowOffsetPx: first.offsetTop,
  };
}

/** Where the focus is, for the focus rule of the dialog (`canMoveExportOrderFocusToRow`). */
function readFocusPlace(list: HTMLElement | null): ExportOrderFocusPlace {
  const active = document.activeElement;
  if (active === null || active === document.body) {
    return "lost";
  }
  if (list === null) {
    // The list is not rendered, so no row can take the focus anyway.
    return "control";
  }
  if (list.contains(active)) {
    return "list";
  }
  if (active.contains(list)) {
    return "lost";
  }
  return active.matches(":disabled") ? "disabledControl" : "control";
}

/** Releases the capture of a pointer by the list, when the list still holds it. */
function releaseListCapture(list: HTMLElement | null, pointerId: number) {
  if (list?.hasPointerCapture(pointerId) === true) {
    list.releasePointerCapture(pointerId);
  }
}

interface ExportOrderRowViewProps {
  readonly row: ExportOrderRow;
  readonly label: string;
  readonly isFocusTarget: boolean;
  readonly isDragged: boolean;
  readonly rowRef: (element: HTMLDivElement | null) => void;
}

/** One row of the list: an option of the list box, with a roving `tabIndex`. */
function ExportOrderRowView({
  row,
  label,
  isFocusTarget,
  isDragged,
  rowRef,
}: ExportOrderRowViewProps) {
  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={isFocusTarget}
      aria-label={label}
      tabIndex={isFocusTarget ? 0 : -1}
      // `ROW_ATTRIBUTE`: the list finds the row of a press by it.
      data-export-order-row={row.id}
      className={cn(
        ROW_GRID_CLASS,
        // `touch-none`: a touch on a row drags it, and does not pan the list.
        "h-9 cursor-grab touch-none rounded-md text-sm focus-ring-inset outline-none select-none",
        "hover:bg-accent/60 aria-selected:bg-accent",
        isDragged &&
          "cursor-grabbing bg-accent text-accent-foreground shadow-sm ring-1 ring-border",
      )}
    >
      {/* The visible cells repeat the accessible name, so they are hidden from assistive
          technology. */}
      <GripVertical aria-hidden="true" className="size-4 text-muted-foreground" />
      <span aria-hidden="true" className="font-semibold tabular-nums">
        #{row.number}
      </span>
      <span aria-hidden="true" className="truncate">
        {row.name ?? ""}
      </span>
      <span aria-hidden="true" className="font-mono text-xs tabular-nums">
        {row.inTime ?? EXPORT_ORDER_UNKNOWN_TIME}
      </span>
      <span aria-hidden="true" className="font-mono text-xs tabular-nums">
        {row.outTime ?? EXPORT_ORDER_UNKNOWN_TIME}
      </span>
      <span aria-hidden="true" className="font-mono text-xs tabular-nums">
        {row.duration ?? EXPORT_ORDER_UNKNOWN_TIME}
      </span>
    </div>
  );
}

interface ExportOrderContentProps {
  /** The `openCount` of the open that mounted this content. */
  readonly openCount: number;
  /** True while the dialog is open. False during the exit animation. */
  readonly isOpen: boolean;
}

/**
 * The content of one open of the dialog. The draft starts as the segments of the export at the
 * open, and lives here until the confirm.
 */
function ExportOrderContent({ openCount, isOpen }: ExportOrderContentProps) {
  const { t } = useTranslation();
  const exportIds = useTimelineStore(selectExportSegmentIds);
  const segments = useTimelineStore(selectSegments);
  const sequenceSegments = useTimelineStore(selectSequenceSegments);
  const clips = useTimelineStore(selectClips);
  const sequenceSources = useTimelineStore(selectSequenceSources);
  const browserDurations = useTimelineStore(selectBrowserDurations);
  const probe = useSequenceMediaStore((state) => state.media?.probe ?? null);
  const timecodePreference = useTimecodePreference(selectTimecodeFormat);

  const [draft, setDraft] = useState<readonly string[]>(exportIds);
  const [focusId, setFocusId] = useState<string | null>(exportIds[0] ?? null);
  // Counts the requests to give the focus to the row of `focusId` after a render.
  const [focusRequest, setFocusRequest] = useState(0);
  // The press or the drag that the list renders. The event handlers read the session instead,
  // which each event writes at once (`createExportOrderDragSession`).
  const [drag, setDrag] = useState<ExportOrderDrag | null>(null);
  const [timelineChanged, setTimelineChanged] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // The ids of the export that the draft was last compared with.
  const [comparedIds, setComparedIds] = useState(exportIds);
  // Counts the resets of the draft by a change of the timeline.
  const [timelineResets, setTimelineResets] = useState(0);
  // The rule of Escape of this open: a held Escape that ended a drag does not close the dialog.
  const [escapeGuard] = useState(createExportOrderEscapeGuard);

  const listRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(new Map<string, HTMLDivElement>());
  // The element that held the focus when the dialog opened, or null for the body.
  const openerRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const hintId = useId();
  // The press or the drag of this open. Every path that ends it releases the capture of its
  // pointer.
  const [session] = useState(() =>
    createExportOrderDragSession({
      render: setDrag,
      releaseCapture: (pointerId) =>
        releaseListCapture(document.getElementById(listId), pointerId),
    }),
  );

  // On each change of the segments of the export, compare them with the draft as sets (ADR 066).
  // This is the React pattern for state that follows a value: the setters run during the render,
  // only when the value changed.
  if (comparedIds !== exportIds) {
    setComparedIds(exportIds);
    const change = followExportOrderTimeline(draft, focusId, exportIds);
    if (change.kind === "reset") {
      setDraft(change.draft);
      // The render shows no drag at once. The layout effect below ends it in the session.
      setDrag(null);
      setTimelineResets((count) => count + 1);
      setTimelineChanged(true);
      setFocusId(change.focusId);
      setFocusRequest((count) => count + 1);
    }
  }

  // A reset ends a drag through the session, which releases the capture of its pointer, so the
  // held pointer drags nothing until it is pressed again. It runs in the commit of the reset,
  // before any later event can read the session.
  useLayoutEffect(() => {
    if (timelineResets > 0) {
      session.end({ kind: "reset" });
    }
  }, [timelineResets, session]);

  // Gives the focus to the row of `focusId` after a move, the end of a drag, a sort or a reset.
  // A move changes the place of the row in the document, and a node that moves loses the focus.
  // A control that the change disabled loses the focus too.
  useLayoutEffect(() => {
    if (focusRequest === 0 || focusId === null) {
      return;
    }
    // The focus goes to the row only from the list, from the body or the dialog when the focus
    // was lost, or from a control that is disabled now. An enabled control keeps it.
    if (!canMoveExportOrderFocusToRow(readFocusPlace(listRef.current))) {
      return;
    }
    rowsRef.current.get(focusId)?.focus();
  }, [focusRequest, focusId]);

  const display = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, probe),
    [timecodePreference, probe],
  );
  const placed = useMemo(
    () => new Map(segments.map((segment) => [segment.id, segment])),
    [segments],
  );
  const anchored = useMemo(
    () => new Map(sequenceSegments.map((segment) => [segment.id, segment])),
    [sequenceSegments],
  );
  const sources = useMemo(
    () => new Map(Object.entries(sequenceSources)),
    [sequenceSources],
  );
  const shownOrder = previewExportOrderDrag(drag, draft);
  const rows = useMemo(
    () =>
      buildExportOrderRows(shownOrder, {
        placed,
        anchored,
        clips,
        sources,
        videoStartPts: probe?.videoStartPts,
        videoTimeBase: probe?.videoTimeBase,
        display,
      }),
    [shownOrder, placed, anchored, clips, sources, probe, display],
  );
  // The accessible name of each row: its number, its name and its times.
  const rowLabels = useMemo(
    () =>
      rows.map((row) => {
        const name = resolveExportOrderRowName(row);
        return (t as TranslateSegmentText)(name.key, name.values);
      }),
    [rows, t],
  );
  const sorted = useMemo(
    () =>
      sortExportOrderByTimelinePosition(
        draft,
        exportSegmentStarts(
          { clips, sequenceSegments, sequenceSources, browserDurations },
          draft,
        ),
      ),
    [draft, clips, sequenceSegments, sequenceSources, browserDurations],
  );

  // A close ends a press or a drag, and releases the capture of its pointer: the pointer can
  // still be down when Cancel closes the dialog from the keyboard. The content stays mounted
  // after the close, so nothing else would end the drag.
  useEffect(() => {
    if (!isOpen) {
      session.end({ kind: "close" });
    }
  }, [isOpen, session]);

  // The Escape guard waits for the release of the key, or for the loss of the window focus,
  // after which the release may never arrive.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyUp = (event: KeyboardEvent) => escapeGuard.keyUp(event.key);
    const onBlur = () => escapeGuard.reset();
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [isOpen, escapeGuard]);

  // The list scrolls while the pointer of a drag is near its top or its bottom. The loop runs
  // once per animation frame while a drag runs in the open dialog, and moves the target with the
  // scroll.
  const isDragging = drag?.phase === "dragging";
  const isAutoScrolling = isExportOrderAutoScrollActive(isOpen, drag);
  useEffect(() => {
    if (!isAutoScrolling) {
      return;
    }
    let frame = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      // A frame that a teardown did not cancel in time reads no layout and asks for no frame.
      if (!isExportOrderAutoScrollActive(true, session.current())) {
        return;
      }
      const list = listRef.current;
      const geometry = list === null ? null : readListGeometry(list);
      const elapsed = last === null ? 0 : now - last;
      last = now;
      if (list !== null && geometry !== null) {
        const step = exportOrderAutoScrollStep(session.current(), geometry, elapsed);
        if (step !== 0) {
          list.scrollTop = geometry.scrollTopPx + step;
          const moved = readListGeometry(list);
          if (moved !== null) {
            session.scroll(moved);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isAutoScrolling, session]);

  const announceMove = (index: number, total: number) => {
    const message = resolveExportOrderMoveMessage(index, total);
    const text = (t as TranslateSegmentText)(message.key, message.values);
    // A no-break space after every second message, so a repeated message is a change of the
    // live region, and a screen reader reads it again.
    setAnnouncement((previous) => (previous === text ? text + NO_BREAK_SPACE : text));
  };

  /** Writes a draft that the user made, and gives the focus to the row of `id`. */
  const applyUserDraft = (next: readonly string[], id: string | null) => {
    setDraft(next);
    setTimelineChanged(false);
    if (id !== null) {
      setFocusId(id);
      setFocusRequest((count) => count + 1);
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveExportOrderKey({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    });
    if (action === null) {
      return;
    }
    // The dialog takes each key that it handles, so the key does not also scroll the list.
    event.preventDefault();
    // A pointer drag holds the order until it ends.
    if (session.current() !== null || draft.length === 0) {
      return;
    }
    const index = focusId === null ? -1 : draft.indexOf(focusId);
    if (action.kind === "focus") {
      const to = focusIndexAfter(action.target, Math.max(index, 0), draft.length);
      const id = to === null ? undefined : draft[to];
      if (id !== undefined) {
        setFocusId(id);
        setFocusRequest((count) => count + 1);
      }
      return;
    }
    if (index < 0) {
      return;
    }
    const to = index + action.delta;
    const next = moveExportOrderRow(draft, index, to);
    if (next !== draft) {
      applyUserDraft(next, focusId);
      announceMove(to, next.length);
    }
  };

  const onListPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A closing dialog takes no input.
    if (!isOpen || event.button !== 0 || session.current() !== null) {
      return;
    }
    const list = event.currentTarget;
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(`[${ROW_ATTRIBUTE}]`)
        : null;
    const id = row?.getAttribute(ROW_ATTRIBUTE) ?? null;
    const index = id === null ? -1 : draft.indexOf(id);
    const geometry = readListGeometry(list);
    if (id === null || index < 0 || geometry === null) {
      return;
    }
    if (!session.press(event.pointerId, index, event.clientY, geometry)) {
      return;
    }
    // The list takes the capture, not the row: a row moves in the document while the drag runs,
    // and an element that moves would lose the capture.
    list.setPointerCapture(event.pointerId);
    setFocusId(id);
  };

  const onListPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (session.current() === null) {
      return;
    }
    const geometry = readListGeometry(event.currentTarget);
    if (geometry !== null) {
      session.move(event.pointerId, event.clientY, geometry);
    }
  };

  /**
   * Ends the press or the drag for `event` (`planExportOrderDragEnd`): the release moves the row,
   * and every end in the open dialog gives the focus back to the dragged row.
   */
  const endDrag = (event: ExportOrderDragEndEvent) => {
    // A closing dialog takes no input. Its close ends the drag, and the lost capture that the
    // close causes must not give the focus to a row.
    if (!isOpen) {
      return;
    }
    // The session holds the state of the last event, also when its render is still pending.
    const end = session.end(event);
    if (end === null) {
      return;
    }
    if (end.drop !== null) {
      setDraft(end.drop.draft);
      setTimelineChanged(false);
      announceMove(end.drop.index, end.drop.draft.length);
    }
    const draggedId = draft[end.fromIndex];
    if (end.focusDraggedRow && draggedId !== undefined) {
      setFocusId(draggedId);
      setFocusRequest((count) => count + 1);
    }
  };

  const onListPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The release reads the list now: a scroll can have moved the rows since the last event.
    endDrag({
      kind: "release",
      pointerId: event.pointerId,
      draft,
      clientY: event.clientY,
      geometry: readListGeometry(event.currentTarget),
    });
  };

  // A pointer cancel or a lost capture ends the drag with no change.
  const onListPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    endDrag({ kind: "pointerCancel", pointerId: event.pointerId });
  };
  const onListLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    endDrag({ kind: "lostCapture", pointerId: event.pointerId });
  };

  // A scroll of the list during a drag, also by the wheel, moves the target under the pointer.
  const onListScroll = () => {
    const list = listRef.current;
    const geometry = list === null ? null : readListGeometry(list);
    if (geometry !== null) {
      session.scroll(geometry);
    }
  };

  const sortByTimelinePosition = () => {
    if (sorted !== draft) {
      // The sort button is disabled after the sort, so the focus that it held goes to the list.
      applyUserDraft(sorted, focusId ?? sorted[0] ?? null);
    }
  };

  const confirm = () => {
    // Every fact of the store is read now, never from a closure of an earlier render: the
    // confirm of a dialog that is closing does nothing (`canRunExportOrderConfirm`).
    const plan = planExportOrderConfirm({
      draft,
      exportIds: selectExportSegmentIds(timelineStore.getState()),
      dialog: exportOrderDialogStore.getState(),
      openCount,
      isTrimLocked: segmentTrimSession.isLocked(),
    });
    if (plan.kind === "ignore" || plan.kind === "refuse") {
      return;
    }
    if (plan.kind === "apply") {
      const result = timelineStore.getState().reorderExportSegments(plan.ids);
      if (result === "refused") {
        // The segments of the export changed: the dialog discards the draft (ADR 066).
        const now = selectExportSegmentIds(timelineStore.getState());
        session.end({ kind: "reset" });
        setDraft(now);
        setTimelineChanged(true);
        if (focusId === null || !now.includes(focusId)) {
          setFocusId(now[0] ?? null);
        }
        // Apply is disabled now, so the focus that it held goes to the list.
        setFocusRequest((count) => count + 1);
        return;
      }
    }
    exportOrderDialogStore.getState().close();
  };

  const isUnchanged = isSameExportOrder(draft, exportIds);
  const moveHint =
    getShortcutPlatform() === "macos"
      ? t("timeline.exportOrder.moveHintMac")
      : t("timeline.exportOrder.moveHintWindows");
  const draggedId = drag?.phase === "dragging" ? (draft[drag.fromIndex] ?? null) : null;

  return (
    <DialogContent
      showCloseButton={false}
      className="sm:max-w-xl"
      // A closing dialog takes no input, so a late click cannot apply the discarded draft.
      inert={!isOpen}
      onOpenAutoFocus={(event) => {
        // Radix dispatches this before it moves the focus, so the active element is still the
        // element that opened the dialog.
        const opener = document.activeElement;
        openerRef.current =
          opener instanceof HTMLElement && opener !== document.body ? opener : null;
        // The focus starts on the first row, the focus target of the list.
        const first = focusId === null ? undefined : rowsRef.current.get(focusId);
        if (first !== undefined) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCloseAutoFocus={(event) => {
        // A dialog that opened meanwhile keeps the focus.
        if (isInOpenDialog(document.activeElement)) {
          event.preventDefault();
          return;
        }
        // The dialog has no Radix trigger. The focus goes back to the element that held it at
        // the open, or else to the Export Order button, or else to the timeline.
        event.preventDefault();
        returnSegmentRenameFocus(
          toLandingFocusTarget(openerRef.current),
          exportOrderFocusFallbacks(),
        );
      }}
      // Escape during a press or a drag ends that drag only, and the dialog stays open. The
      // repeats of that key, and every repeated Escape, do not close it either.
      onEscapeKeyDown={(event) => {
        const outcome = escapeGuard.keyDown({
          repeat: event.repeat,
          isDragActive: session.current() !== null,
        });
        if (outcome !== "dismiss") {
          event.preventDefault();
        }
        if (outcome === "cancelDrag") {
          endDrag({ kind: "escape" });
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("timeline.exportOrder.title")}</DialogTitle>
        <DialogDescription>{t("timeline.exportOrder.description")}</DialogDescription>
      </DialogHeader>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={sorted === draft || drag !== null}
            onClick={sortByTimelinePosition}
          >
            {t("timeline.exportOrder.sort")}
          </Button>
        </div>
        {timelineChanged && (
          <Notice tone="info" role="status">
            {t("timeline.exportOrder.changed")}
          </Notice>
        )}
        {/* The header names the columns for the eye. Each row names its times in its accessible
            name, so the header is hidden from assistive technology. The stable scrollbar gutter
            of the header and the list keeps the columns in line. */}
        <div
          aria-hidden="true"
          className={cn(
            ROW_GRID_CLASS,
            "[scrollbar-gutter:stable] overflow-hidden text-xs font-medium text-muted-foreground",
          )}
        >
          <span />
          <span />
          <span />
          <span>{t("timeline.segmentTooltip.in")}</span>
          <span>{t("timeline.segmentTooltip.out")}</span>
          <span>{t("timeline.segmentTooltip.duration")}</span>
        </div>
        {/* A list box with a roving `tabIndex`: the focused row is the selected option, and Tab
            leaves the list. A press anywhere on a row starts a drag. */}
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          // A list box of a closing dialog does not block the window commands
          // (`exportOrderListState`).
          data-state={exportOrderListState(isOpen)}
          aria-label={t("timeline.exportOrder.list")}
          aria-describedby={hintId}
          onKeyDown={onListKeyDown}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onPointerUp={onListPointerUp}
          onPointerCancel={onListPointerCancel}
          onLostPointerCapture={onListLostPointerCapture}
          onScroll={onListScroll}
          className={cn(
            "relative max-h-[min(24rem,50vh)] [scrollbar-gutter:stable] overflow-y-auto rounded-md border border-border p-1",
            // The grabbing hand shows over every row while a drag runs.
            isDragging && "cursor-grabbing *:cursor-grabbing",
          )}
        >
          {rows.map((row, index) => (
            <ExportOrderRowView
              key={row.id}
              row={row}
              label={rowLabels[index] ?? ""}
              isFocusTarget={row.id === focusId}
              isDragged={row.id === draggedId}
              rowRef={(element) => {
                if (element === null) {
                  rowsRef.current.delete(row.id);
                } else {
                  rowsRef.current.set(row.id, element);
                }
              }}
            />
          ))}
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          {moveHint}
        </p>
        {/* The new place of a row that moved, for a screen reader. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
      <DialogFooter>
        <DialogActions
          cancel={
            <DialogClose asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </DialogClose>
          }
          primary={
            <Button disabled={isUnchanged || drag !== null} onClick={confirm}>
              {t("timeline.exportOrder.confirm")}
            </Button>
          }
        />
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The Export Order dialog (ADR 066). Mount it once, in the application shell.
 *
 * The action Export Order opens it (`exportOrderDialogStore`): the key, or the segment summary in
 * the gutter of the track row. The list shows the segments of the export (`exportSegmentIds`) in
 * the order of a draft. The user drags a row, moves the focused row with `Alt`+Up and `Alt`+Down,
 * or sorts the rows by their place on the timeline. Apply gives the draft to the timeline as one
 * edit (`reorderExportSegments`), and Cancel and Escape discard it. While the dialog is open, the
 * window keyboard layer and the command items of the macOS menu do nothing, because it is a
 * modal layer (ADR 021). At the close the focus goes back to the element that held it at the
 * open, or else to the Export Order button, or else to the timeline.
 */
export function ExportOrderDialog() {
  const isOpen = useStore(exportOrderDialogStore, (state) => state.isOpen);
  const openCount = useStore(exportOrderDialogStore, (state) => state.openCount);
  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {openCount > 0 && (
        // A new key at each open, so the draft starts with the order of that moment.
        <ExportOrderContent key={openCount} openCount={openCount} isOpen={isOpen} />
      )}
    </Dialog>
  );
}
