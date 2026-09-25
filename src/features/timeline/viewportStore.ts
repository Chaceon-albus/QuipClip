/**
 * The zoom of the timeline, as a store that the panel, its zoom buttons and the window
 * keyboard layer share.
 *
 * The zoom factor is view state (ADR 007). It never enters the timeline store, the undo and
 * redo stacks, or the project file. The store holds three values:
 *
 * - `zoom`: the factor. 1 fits the whole source extent in the panel.
 * - `maxZoom`: the ceiling that the panel calculates from the source extent, the nominal frame
 *   rate of the source and its own width (`calculateMaxZoom`). The panel reports it, because
 *   only the panel knows its width. The store clamps the zoom to it, and every zoom action
 *   reads it.
 * - `anchor`: what the panel must hold in place when it commits the next zoom, or null.
 *
 * The scroll position stays in the panel. A zoom action records an anchor, and the panel takes
 * it in the layout effect that runs after it commits the new lane width. There it has the new
 * geometry to measure, and the scroll position of the view before the zoom.
 *
 * The module has no React or DOM dependency, so the tests need no document.
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  MIN_TIMELINE_ZOOM,
  settleTimelineZoom,
  stepTimelineZoom,
  type TimelineZoomAnchorPoint,
} from "./viewport";

/**
 * What the panel holds in place when it commits a zoom.
 *
 * - `point`: a point of the time axis at a position in the viewport. The wheel holds the time
 *   under the pointer (ADR 007).
 * - `playheadOrCentre`: the playhead when it is in the visible lane, and the centre of the
 *   visible lane otherwise (`resolvePlayheadOrCentreAnchor`). The panel resolves it from the
 *   view before the zoom. The zoom keys and the zoom buttons use it.
 * - `start`: scrollLeft 0. Fit uses it.
 */
export type TimelineZoomAnchor =
  | { readonly kind: "point"; readonly point: TimelineZoomAnchorPoint }
  | { readonly kind: "playheadOrCentre" }
  | { readonly kind: "start" };

const PLAYHEAD_OR_CENTRE: TimelineZoomAnchor = { kind: "playheadOrCentre" };
const START: TimelineZoomAnchor = { kind: "start" };

export interface TimelineViewportState {
  /** The zoom factor, from 1 to `maxZoom`. */
  readonly zoom: number;
  /** The largest zoom factor the panel allows now. 1 while the extent is indeterminate. */
  readonly maxZoom: number;
  /** The anchor of the zoom that the panel has not committed yet, or null. */
  readonly anchor: TimelineZoomAnchor | null;
}

export interface TimelineViewportActions {
  /**
   * Zooms in by one step (`TIMELINE_ZOOM_STEP_FACTOR`). The anchor defaults to
   * `playheadOrCentre`. At the maximum, the action changes nothing and records no anchor.
   */
  zoomIn: (anchor?: TimelineZoomAnchor) => void;
  /**
   * Zooms out by one step. The anchor defaults to `playheadOrCentre`. At zoom 1, the action
   * changes nothing and records no anchor.
   */
  zoomOut: (anchor?: TimelineZoomAnchor) => void;
  /**
   * Multiplies the zoom by a factor, for the wheel. The anchor defaults to
   * `playheadOrCentre`. A factor that leaves the zoom where it is records no anchor.
   */
  zoomBy: (factor: number, anchor?: TimelineZoomAnchor) => void;
  /** Returns to zoom 1 and scrollLeft 0. At zoom 1, the action changes nothing. */
  fit: () => void;
  /** Records the ceiling that the panel calculated, and clamps the zoom to it. */
  setMaxZoom: (maxZoom: number) => void;
  /** Returns to zoom 1 with no anchor, for a new source (ADR 007). */
  reset: () => void;
  /** Returns the pending anchor and clears it. The panel calls it once for each commit. */
  takeAnchor: () => TimelineZoomAnchor | null;
}

export type TimelineViewportStoreState = TimelineViewportState &
  TimelineViewportActions;

function sanitizeMaxZoom(maxZoom: number): number {
  return Number.isFinite(maxZoom) && maxZoom >= MIN_TIMELINE_ZOOM
    ? maxZoom
    : MIN_TIMELINE_ZOOM;
}

export function createTimelineViewportStore(
  initialState?: Partial<Pick<TimelineViewportState, "zoom" | "maxZoom">>,
): StoreApi<TimelineViewportStoreState> {
  const initialMaxZoom = sanitizeMaxZoom(initialState?.maxZoom ?? MIN_TIMELINE_ZOOM);
  return createStore<TimelineViewportStoreState>()((set, get) => {
    /** Applies a new factor with its anchor, or does nothing when the factor is unchanged. */
    const applyZoom = (nextZoom: number, anchor: TimelineZoomAnchor): void => {
      if (nextZoom === get().zoom) {
        return;
      }
      set({ zoom: nextZoom, anchor });
    };

    return {
      zoom: settleTimelineZoom(initialState?.zoom ?? MIN_TIMELINE_ZOOM, initialMaxZoom),
      maxZoom: initialMaxZoom,
      anchor: null,
      zoomIn: (anchor = PLAYHEAD_OR_CENTRE) => {
        const { zoom, maxZoom } = get();
        applyZoom(stepTimelineZoom(zoom, "in", maxZoom), anchor);
      },
      zoomOut: (anchor = PLAYHEAD_OR_CENTRE) => {
        const { zoom, maxZoom } = get();
        applyZoom(stepTimelineZoom(zoom, "out", maxZoom), anchor);
      },
      zoomBy: (factor, anchor = PLAYHEAD_OR_CENTRE) => {
        if (!Number.isFinite(factor) || factor <= 0) {
          return;
        }
        const { zoom, maxZoom } = get();
        applyZoom(settleTimelineZoom(zoom * factor, maxZoom), anchor);
      },
      fit: () => {
        applyZoom(MIN_TIMELINE_ZOOM, START);
      },
      setMaxZoom: (maxZoom) => {
        const nextMax = sanitizeMaxZoom(maxZoom);
        const state = get();
        const nextZoom = settleTimelineZoom(state.zoom, nextMax);
        if (nextMax === state.maxZoom && nextZoom === state.zoom) {
          return;
        }
        // A clamp from a smaller ceiling keeps the pending anchor. With no anchor, the panel
        // keeps the scroll position and lets the browser clamp it, as it does on a resize.
        set({ maxZoom: nextMax, zoom: nextZoom });
      },
      reset: () => {
        const state = get();
        if (state.zoom === MIN_TIMELINE_ZOOM && state.anchor === null) {
          return;
        }
        set({ zoom: MIN_TIMELINE_ZOOM, anchor: null });
      },
      takeAnchor: () => {
        const { anchor } = get();
        if (anchor !== null) {
          set({ anchor: null });
        }
        return anchor;
      },
    };
  });
}

export type TimelineViewportStore = ReturnType<typeof createTimelineViewportStore>;

/** The one viewport store of the application window. */
export const timelineViewportStore: TimelineViewportStore =
  createTimelineViewportStore();

const defaultSelector = (
  state: TimelineViewportStoreState,
): TimelineViewportStoreState => state;

export function useTimelineViewportStore(): TimelineViewportStoreState;
export function useTimelineViewportStore<T>(
  selector: (state: TimelineViewportStoreState) => T,
): T;
export function useTimelineViewportStore<T>(
  selector?: (state: TimelineViewportStoreState) => T,
): T | TimelineViewportStoreState {
  return useStore(
    timelineViewportStore,
    (selector ?? defaultSelector) as (state: TimelineViewportStoreState) => T,
  );
}
