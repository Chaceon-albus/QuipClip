import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { preventFocusOnMouseDown } from "@/components/common/preventFocusOnMouseDown";
import {
  DEFAULT_TIMELINE_HEIGHT_PX,
  useTimelineHeightPreference,
} from "@/features/settings/timelineHeightPreference";
import { nativeContextMenuState } from "./nativeContextMenuState";
import {
  clampTimelineHeight,
  resolveTimelineHeightBounds,
  resolveTimelineSplitterKey,
  type TimelineHeightBounds,
} from "./timelineHeight";
import {
  createTimelineSplitterDrag,
  type TimelineSplitterDragOutcome,
} from "./timelineSplitterDrag";

interface TimelineAreaProps {
  /**
   * The slot of the preview in the shell. The preview takes the height that the timeline
   * area leaves, so the two share one height, and the area measures both.
   */
  readonly previewRef: RefObject<HTMLElement | null>;
  /** The timeline panel. It fills the area. */
  readonly children: ReactNode;
}

/**
 * The timeline area of the shell: the timeline at the height that the user chose, and the
 * splitter on its top edge.
 *
 * The height is the timeline height preference, clamped to the window (`timelineHeight.ts`).
 * The area measures the height that it shares with the preview, and it measures it again each
 * time either one changes size, so a window that becomes shorter clamps the timeline again.
 * The clamp is not written back to the preference.
 *
 * The area can also shrink below its height in the flex layout, down to its minimum. That
 * keeps the preview at its own minimum and the status bar in the window in every frame, also
 * before a new measurement of a live resize is rendered.
 *
 * The height state is in this component, so a drag renders the area and the splitter only.
 * The timeline panel is a child element that the shell made, so it does not render again for
 * a new height. Its lanes take the new height through the flex layout.
 */
export function TimelineArea({ previewRef, children }: TimelineAreaProps) {
  const preferredPx = useTimelineHeightPreference((state) => state.heightPx);
  const setPreferredPx = useTimelineHeightPreference((state) => state.setHeight);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const areaId = useId();
  const [sharedHeightPx, setSharedHeightPx] = useState<number | null>(null);
  // The height during a drag. The preference takes the height when the drag ends, so a drag
  // writes storage once.
  const [draftPx, setDraftPx] = useState<number | null>(null);

  // The first measurement runs before the first paint, so no frame shows an unclamped height.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const preview = previewRef.current;
    if (!area || !preview) {
      return;
    }
    const measure = () => {
      setSharedHeightPx(
        area.getBoundingClientRect().height + preview.getBoundingClientRect().height,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(preview);
    return () => {
      observer.disconnect();
    };
  }, [previewRef]);

  const bounds = useMemo(
    () => resolveTimelineHeightBounds(sharedHeightPx),
    [sharedHeightPx],
  );
  const heightPx = clampTimelineHeight(draftPx ?? preferredPx, bounds);

  const commit = (nextPx: number) => {
    setDraftPx(null);
    setPreferredPx(clampTimelineHeight(nextPx, bounds));
  };

  return (
    <div
      ref={areaRef}
      id={areaId}
      className="relative flex flex-col"
      style={{ height: heightPx, minHeight: bounds.minPx }}
    >
      <TimelineSplitter
        heightPx={heightPx}
        bounds={bounds}
        controlsId={areaId}
        onDraft={setDraftPx}
        onCommit={commit}
        onCancel={() => {
          setDraftPx(null);
        }}
        onReset={() => {
          setDraftPx(null);
          setPreferredPx(DEFAULT_TIMELINE_HEIGHT_PX);
        }}
      />
      {children}
    </div>
  );
}

interface TimelineSplitterProps {
  /** The height on screen, which is already clamped. */
  readonly heightPx: number;
  readonly bounds: TimelineHeightBounds;
  /** The id of the timeline area, for `aria-controls`. */
  readonly controlsId: string;
  /** Shows a height during a drag, without storing it. */
  readonly onDraft: (heightPx: number) => void;
  /** Stores a height. */
  readonly onCommit: (heightPx: number) => void;
  /** Ends a drag with no change. */
  readonly onCancel: () => void;
  /** Stores the default height. */
  readonly onReset: () => void;
}

/**
 * The splitter between the upper area (the preview and the transport bar) and the timeline.
 *
 * It follows the ARIA window splitter pattern. The value is the timeline height, so `ArrowUp`
 * moves the splitter up and makes the timeline taller (`resolveTimelineSplitterKey`). The window
 * keyboard layer leaves those keys to a focused splitter (`isSplitterKey`, which reads the
 * `data-splitter` marker), and every other key keeps its meaning.
 *
 * A primary press starts a drag (`timelineSplitterDrag.ts`). The splitter captures the pointer,
 * so the drag goes on when the pointer leaves the thin hit area, and the document holds the
 * resize cursor until the drag ends. A release stores the height. A pointer cancel, a lost
 * capture, a window blur and Escape restore the height from before the drag. A move without
 * the primary button ends the drag at the last height it showed. A double click stores the
 * default height.
 *
 * A mouse press does not move the focus to the splitter (ADR 021): a splitter that kept the
 * focus after a drag would take `Home` and `End` from the playhead.
 *
 * The hit area is 7px tall: from 5px above the top edge of the timeline area to 2px below it.
 * It lies mostly on the padding of the transport bar, and it takes only the top pixel of the
 * ruler. At rest the splitter draws nothing, and the bottom border of the transport bar and the
 * top border of the timeline are the divider. Hover and a drag draw a 2px line in the ring
 * colour over those two borders.
 */
function TimelineSplitter({
  heightPx,
  bounds,
  controlsId,
  onDraft,
  onCommit,
  onCancel,
  onReset,
}: TimelineSplitterProps) {
  const { t } = useTranslation();
  const splitterRef = useRef<HTMLDivElement | null>(null);
  const [gesture] = useState(() => createTimelineSplitterDrag());
  const [dragging, setDragging] = useState(false);

  // An unmount during a drag ends the cursor hold.
  useEffect(() => () => gesture.dispose(), [gesture]);

  const apply = (outcome: TimelineSplitterDragOutcome | null) => {
    if (outcome === null) {
      return;
    }
    switch (outcome.kind) {
      case "draft":
        onDraft(outcome.heightPx);
        return;
      case "commit":
        setDragging(false);
        onCommit(outcome.heightPx);
        return;
      case "cancel":
        setDragging(false);
        onCancel();
        return;
    }
  };

  /**
   * Applies the end of a drag that no release of the pointer ended. The splitter can still hold
   * the capture, so it releases it. The lost capture that follows finds no drag and does
   * nothing.
   */
  const applyEnd = (pointerId: number, outcome: TimelineSplitterDragOutcome | null) => {
    const splitter = splitterRef.current;
    if (splitter?.hasPointerCapture(pointerId)) {
      splitter.releasePointerCapture(pointerId);
    }
    apply(outcome);
  };

  // A window blur and Escape cancel the drag. After a blur, the release goes to another
  // application. Escape is also a key of the window keyboard layer (finish the segment), and
  // the layer does not take it while the drag holds the cursor on <html> (`isGestureEscape`),
  // so this listener gets it. It cancels the key press, so no other handler acts on it.
  const cancelDrag = useEffectEvent(() => {
    const pointerId = gesture.activePointerId();
    if (pointerId !== null) {
      applyEnd(pointerId, gesture.cancel());
    }
  });
  useEffect(() => {
    if (!dragging) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    const onBlur = () => {
      cancelDrag();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [dragging]);

  // A press does not start a drag while a native context menu is open or on its way, such as
  // the menu of a timeline segment (ADR 021). The menu would take the release of the drag.
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      gesture.activePointerId() !== null ||
      nativeContextMenuState.isOpen()
    ) {
      return;
    }
    // The capture comes first: it throws for a pointer that is no longer active, and a drag
    // that began before the throw would hold the cursor with no drag to end it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    gesture.begin(event.pointerId, event.clientY, heightPx);
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const outcome = gesture.move(event.pointerId, event.clientY, event.buttons, bounds);
    if (outcome !== null && outcome.kind !== "draft") {
      // The primary button is not held, so its release went somewhere the splitter did not
      // see.
      applyEnd(event.pointerId, outcome);
    } else {
      apply(outcome);
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    apply(gesture.end(event.pointerId, event.clientY, bounds));
  };

  // A cancel, and a capture that ends before the release, restore the height from before the
  // drag. After a release, the drag has already ended, so the lost capture that follows it
  // does nothing.
  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    apply(gesture.cancel(event.pointerId));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextPx = resolveTimelineSplitterKey(event, heightPx, bounds);
    if (nextPx === null) {
      return;
    }
    event.preventDefault();
    // A step at an end of the range stores nothing, so a key press keeps a height that the
    // window clamps.
    if (nextPx !== heightPx) {
      onCommit(nextPx);
    }
  };

  return (
    <div
      ref={splitterRef}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("timeline.splitter.label")}
      aria-controls={controlsId}
      aria-valuenow={heightPx}
      aria-valuemin={bounds.minPx}
      aria-valuemax={Number.isFinite(bounds.maxPx) ? bounds.maxPx : undefined}
      aria-valuetext={t("timeline.splitter.value", { height: heightPx })}
      tabIndex={0}
      data-splitter=""
      data-dragging={dragging ? "" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onMouseDown={preventFocusOnMouseDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className="group/splitter absolute inset-x-0 -top-[5px] z-50 h-[7px] cursor-ns-resize touch-none focus-ring-inset outline-none"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1 h-0.5 transition-colors group-hover/splitter:bg-ring group-data-dragging/splitter:bg-ring"
      />
    </div>
  );
}
