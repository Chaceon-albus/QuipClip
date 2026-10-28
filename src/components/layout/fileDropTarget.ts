/**
 * Where a file drop on the track lane inserts its clips (ADR 052).
 *
 * A drop on the track lane inserts at the junction closest to the pointer: before the clip when
 * the pointer is on the left half of a clip, and after it on the right half. During the drag, a
 * vertical line shows that junction. A drop anywhere else adds the clips at the end.
 *
 * The timeline registers the rectangle of its lane and the place of each clip, so the drop hook
 * can resolve a pointer with no React state of the timeline.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { ClipBarLayout } from "@/components/timeline/clipBarLayout";

/** The junction of a drop and its place on the lane. */
export interface FileDropTarget {
  /** The junction: 0 before the first clip, the clip count after the last one. */
  readonly junction: number;
  /** The place of the junction on the lane, in percent of the extent. */
  readonly leftPercent: number;
}

/**
 * The junction closest to a pointer at `percent` of the lane, or null when the lane has no clip.
 */
export function junctionAt(
  percent: number,
  layouts: readonly ClipBarLayout[],
): FileDropTarget | null {
  if (layouts.length === 0 || !Number.isFinite(percent)) {
    return null;
  }
  for (const layout of layouts) {
    const end = layout.leftPercent + layout.widthPercent;
    if (percent < end || layout.index === layouts.length - 1) {
      const middle = layout.leftPercent + layout.widthPercent / 2;
      return percent < middle
        ? { junction: layout.index, leftPercent: layout.leftPercent }
        : { junction: layout.index + 1, leftPercent: end };
    }
  }
  return null;
}

/** What the timeline registers for the drop hook. */
export interface TrackLaneGeometry {
  /** The rectangle of the track lane on the page, in CSS pixels. */
  readonly rect: () => DOMRect | null;
  /** The place of each clip on the lane. */
  readonly layouts: () => readonly ClipBarLayout[] | null;
}

let geometry: TrackLaneGeometry | null = null;

/** The timeline registers its lane, and unregisters it with the returned function. */
export function registerTrackLane(lane: TrackLaneGeometry): () => void {
  geometry = lane;
  return () => {
    if (geometry === lane) {
      geometry = null;
    }
  };
}

/**
 * The drop target of a pointer at a page point in CSS pixels, or null when the point is not on
 * the track lane, or no lane is registered.
 */
export function resolveDropTarget(x: number, y: number): FileDropTarget | null {
  const rect = geometry?.rect() ?? null;
  const layouts = geometry?.layouts() ?? null;
  if (rect === null || layouts === null || rect.width <= 0) {
    return null;
  }
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return null;
  }
  return junctionAt(((x - rect.left) / rect.width) * 100, layouts);
}

/** The target of the drag in progress, for the indicator line, or null. */
export const fileDropTargetStore = createStore<{
  readonly target: FileDropTarget | null;
}>()(() => ({ target: null }));

/** React hook for the drop target of the drag in progress. */
export function useFileDropTarget(): FileDropTarget | null {
  return useStore(fileDropTargetStore, (state) => state.target);
}
