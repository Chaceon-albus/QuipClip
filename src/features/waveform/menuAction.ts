/**
 * The envelope item of the menu of a clip label (ADR 056, "The menu item"). The item acts on the
 * source of the clip, and its text follows the state of that source.
 */

import type { ImportMediaResult } from "@/features/media/types";
import { selectWaveformSource, type WaveformState } from "./store";

export type WaveformMenuAction = "show" | "cancel" | "hide";

export interface WaveformMenuItem {
  readonly action: WaveformMenuAction;
  readonly enabled: boolean;
}

/**
 * The item for a source:
 *
 * - A job of this source runs: Cancel, enabled.
 * - The envelope shows: Hide, enabled.
 * - No audio stream, no `videoStartPts`, or no import result: Show, disabled.
 * - A job of another source runs: Show, disabled.
 * - Else Show, enabled. A failed job also offers Show again.
 */
export function resolveWaveformAction(
  sourceId: string,
  media: ImportMediaResult | null | undefined,
  state: WaveformState,
): WaveformMenuItem {
  const phase = selectWaveformSource(state, sourceId).phase;
  if (phase === "running" || state.runningSourceId === sourceId) {
    return { action: "cancel", enabled: true };
  }
  if (phase === "ready") {
    return { action: "hide", enabled: true };
  }
  if (
    media === null ||
    media === undefined ||
    media.probe.audio === null ||
    media.probe.videoStartPts === null
  ) {
    return { action: "show", enabled: false };
  }
  return { action: "show", enabled: state.runningSourceId === null };
}
