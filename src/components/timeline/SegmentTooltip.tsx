import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TIMELINE_GUTTER_WIDTH_PX } from "@/features/timeline";
import { cn } from "@/lib/utils";
import {
  calculateVisibleSegmentAnchor,
  type SegmentAnchor,
  type SegmentTooltipRow,
} from "./segmentLabels";
import type { SegmentTooltipController } from "./segmentTooltipController";

/** The gap between a segment and its tooltip, in pixels. The control tooltips use 6 too. */
const SEGMENT_TOOLTIP_OFFSET = 6;

/** The smallest distance between the tooltip and the window edge, in pixels. */
const SEGMENT_TOOLTIP_COLLISION_PADDING = 8;

/** What the tooltip shows for one segment. */
export interface SegmentTooltipEntry {
  readonly id: string;
  /** The position in the export order (`numberSegmentsInExportOrder`). */
  readonly number: number;
  /** The left and the width of the segment in the layer, as percentages of the lane. */
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly rows: readonly SegmentTooltipRow[];
}

export interface SegmentTooltipProps {
  readonly controller: SegmentTooltipController;
  readonly entries: readonly SegmentTooltipEntry[];
  /** The number of segments that the export joins. */
  readonly total: number;
  /** The scroll container of the timeline. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** The width of the lane in CSS pixels. A change measures the anchor again. */
  readonly laneWidthPx: number;
}

/** The anchor of one open, for the segment that it names. */
interface MeasuredAnchor extends SegmentAnchor {
  readonly id: string;
  /**
   * Goes up each time the anchor of the open changes. The content remounts at each one. Only
   * generation 0, the first anchor of an open, plays the entry animation.
   */
  readonly generation: number;
}

/**
 * Measures the visible part of a segment. The anchor span is a child of the layer, and the
 * layer spans the lane. The sticky gutter covers the left edge of the viewport, so the
 * visible part of the lane starts at the right edge of the gutter.
 */
function measureAnchor(
  entry: SegmentTooltipEntry,
  anchorElement: HTMLElement | null,
  viewport: HTMLElement | null,
): SegmentAnchor {
  const layer = anchorElement?.parentElement ?? null;
  if (layer === null || viewport === null) {
    return calculateVisibleSegmentAnchor(
      entry,
      { left: 0, width: 0 },
      { left: 0, right: 0 },
    );
  }
  const laneRect = layer.getBoundingClientRect();
  const viewportLeft = viewport.getBoundingClientRect().left;
  return calculateVisibleSegmentAnchor(
    entry,
    { left: laneRect.left, width: laneRect.width },
    {
      left: viewportLeft + TIMELINE_GUTTER_WIDTH_PX,
      right: viewportLeft + viewport.clientWidth,
    },
  );
}

/**
 * The one tooltip of the segment layer. The controller names the segment it shows.
 *
 * The Radix trigger is an anchor span inside the layer. It paints nothing and takes no pointer
 * event, so the segment buttons keep every pointer event and the controller decides when the
 * tooltip opens.
 *
 * The span covers the part of the named segment that is visible in the timeline viewport
 * (`calculateVisibleSegmentAnchor`), measured once when the tooltip opens. At a high zoom a
 * segment can be much wider than the viewport, and an anchor on the whole segment put the
 * tooltip far from it, at the window edge. The same rule serves a pointer open and a keyboard
 * open, so the tooltip always centres on what the user sees of the segment. An anchor at the
 * pointer would need a pointer position for a keyboard open, and the pointer position of a
 * delayed open is 400 ms old. The tooltip stays closed until the measurement is done, so its
 * first frame has the measured anchor.
 *
 * The anchor is measured again when the lane width changes (a zoom or a resize, also one
 * that does not scroll), and after a scroll of a tooltip that keyboard focus opened. Chromium
 * fires the focus of a segment outside the viewport first and scrolls the segment into view
 * after it, so the first measurement of a focus tooltip can come before that scroll. The
 * scroll container has a left scroll padding of the gutter width, so that scroll puts the
 * segment to the right of the sticky gutter.
 *
 * A scroll closes a tooltip that a pointer opened, and cancels a pending open
 * (`SegmentTooltipController.scroll`, which the layer calls from the scroll container).
 *
 * Radix also closes its tooltip when an ancestor of the trigger scrolls. Its scroll listener
 * is on the window in the capture phase, so its close comes first, before the scroll
 * listener of the layer. Radix reports that close through `onOpenChange` with no event that
 * names it, and it reports the close for another tooltip that opens in the same way. So this
 * component tells the causes apart itself (`SegmentTooltipController.tooltipClosed`):
 *
 * - Escape and a press outside set a flag before Radix closes: a dismissal.
 * - Otherwise, a scroll event of an ancestor of the anchor since the last measurement means
 *   the scroll close. A listener of this component records it. It is on the window in the
 *   capture phase too, and it is added before the content mounts, so it runs before the
 *   listener of Radix. The scroll rule applies at once, and the scroll listener of the layer
 *   applies it again, with no further effect.
 * - With no such scroll event, another tooltip opened: a dismissal, also for a focus
 *   tooltip, so two tooltips do not show at once.
 *
 * The record is of scroll events and not of a position. Chromium can move the viewport for
 * the focus of a segment before the tooltip measures its anchor, and dispatch the scroll
 * event after it. A position taken at the measurement then equals the position at the close,
 * and that close would count as another tooltip.
 *
 * The content has the key of the anchor generation, so it mounts again at each new anchor
 * and places itself there.
 *
 * While no part of the segment is visible, the tooltip stays open and hidden (`visible` of
 * `calculateVisibleSegmentAnchor`). A keyboard focus on a segment outside the viewport opens
 * the tooltip before the scroll that brings the segment into view, and the hidden tooltip
 * does not float over the sticky gutter in that frame.
 *
 * The tooltip is a visual copy of the accessible name and description of the segment
 * button, so it is hidden from assistive technology and a screen reader does not read the
 * values twice. It takes no pointer event, so it never covers the ruler as a seek surface.
 *
 * The content also mounts again when the tooltip moves to another segment.
 *
 * Two tooltips can show at the same time in one case, and this is accepted. Radix sends a
 * document event when it opens a tooltip itself, and each open tooltip closes on that event.
 * An open from the controlled `open` prop sends no event. So when keyboard focus holds the
 * tooltip of a control open and a pointer then rests on a segment, both tooltips show until
 * the focus moves. That needs focus on one element and the pointer on another, and the two
 * tooltips do not hide the segment. A dispatch of that event from here is not simple: the
 * event name is internal to Radix, and this tooltip also listens to it, so the dispatch would
 * close this tooltip when it moves to another segment. The reverse case works: when another
 * tooltip opens, this one closes.
 */
export const SegmentTooltip = memo(function SegmentTooltip({
  controller,
  entries,
  total,
  viewportRef,
  laneWidthPx,
}: SegmentTooltipProps) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const entriesById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const entry = state.targetId === null ? undefined : entriesById.get(state.targetId);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<MeasuredAnchor | null>(null);
  // Set by Escape or by a press outside the content, just before Radix closes the tooltip.
  const explicitCloseRef = useRef(false);
  // Set by a scroll event of an ancestor of the anchor, and cleared at each measurement.
  const scrolledRef = useRef(false);

  // Records the scroll events of the ancestors of the anchor, with the test that Radix uses
  // for its scroll close. The listener is added when this component mounts, before any
  // content mounts, so on the same target and in the same phase it runs before Radix.
  useEffect(() => {
    const onScroll = (event: Event) => {
      const anchorElement = anchorRef.current;
      if (
        anchorElement !== null &&
        event.target instanceof Node &&
        event.target.contains(anchorElement)
      ) {
        scrolledRef.current = true;
      }
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // A deleted segment, or a segment of a source that is no longer active, has no button, and
  // a removed button fires no pointerleave. So the controller forgets such a segment here,
  // also when it is only suppressed or pending.
  useEffect(() => {
    controller.retain(new Set(entries.map((item) => item.id)));
  }, [entries, controller]);

  // Measures the anchor before the tooltip opens, and again when the segment, the lane width
  // or the measure counter of the controller changes. A layout effect runs before the browser
  // paints, so the tooltip never shows at an old anchor. The state update is the purpose of
  // this effect: it stores a layout measurement. The effect does not read `laneWidthPx` and
  // `measureRequest`. They are dependencies only so that a change runs the measurement again.
  const measureRequest = state.measure;
  useLayoutEffect(() => {
    if (entry === undefined) {
      setAnchor((previous) => (previous === null ? previous : null));
      return;
    }
    const measured = measureAnchor(entry, anchorRef.current, viewportRef.current);
    scrolledRef.current = false;
    setAnchor((previous) =>
      previous !== null &&
      previous.id === entry.id &&
      previous.left === measured.left &&
      previous.width === measured.width &&
      previous.visible === measured.visible
        ? previous
        : {
            id: entry.id,
            ...measured,
            generation: previous === null ? 0 : previous.generation + 1,
          },
    );
  }, [entry, viewportRef, laneWidthPx, measureRequest]);

  const isOpen = entry !== undefined && anchor !== null && anchor.id === entry.id;

  return (
    <Tooltip
      open={isOpen}
      onOpenChange={(open) => {
        if (open) {
          return;
        }
        const explicit = explicitCloseRef.current;
        explicitCloseRef.current = false;
        // Radix gives no cause. A scroll event since the last measurement means its scroll
        // close, and no scroll event means that another tooltip opened (see above).
        controller.tooltipClosed({ explicit, scrolled: scrolledRef.current });
      }}
    >
      <TooltipTrigger asChild>
        <span
          ref={anchorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1"
          style={{ left: anchor?.left ?? "0%", width: anchor?.width ?? "0%" }}
        />
      </TooltipTrigger>
      {isOpen && (
        <TooltipContent
          key={`${entry.id}:${anchor.generation}`}
          side="top"
          sideOffset={SEGMENT_TOOLTIP_OFFSET}
          collisionPadding={SEGMENT_TOOLTIP_COLLISION_PADDING}
          aria-hidden="true"
          onEscapeKeyDown={() => {
            explicitCloseRef.current = true;
          }}
          onPointerDownOutside={() => {
            explicitCloseRef.current = true;
          }}
          className={cn(
            "pointer-events-none",
            // Radix animates only a tooltip that opens after its own delay, and this tooltip
            // opens from a controlled prop. So the delayed open takes the same entry here, on
            // its first anchor only: a new anchor after a measurement or an edit of the
            // segment mounts the content again, and must not replay the entry.
            state.delayed &&
              anchor.generation === 0 &&
              "animate-in fade-in-0 zoom-in-95",
            // No part of the segment is visible: stay open, but show nothing.
            !anchor.visible && "invisible",
          )}
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">
                {t("timeline.segment", { index: entry.number })}
              </span>
              <span className="text-tooltip-foreground/70">
                {t("timeline.segmentTooltip.exportOrder", {
                  order: entry.number,
                  total,
                })}
              </span>
            </div>
            {entry.rows.length > 0 && (
              <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                {entry.rows.map((row) => (
                  <Fragment key={row.labelKey}>
                    <dt className="text-tooltip-foreground/70">{t(row.labelKey)}</dt>
                    <dd className="font-mono tabular-nums">
                      {row.value}
                      {row.excluded && (
                        <span className="ml-1 font-sans text-tooltip-foreground/70">
                          {t("timeline.segmentTooltip.notIncluded")}
                        </span>
                      )}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        </TooltipContent>
      )}
    </Tooltip>
  );
});
