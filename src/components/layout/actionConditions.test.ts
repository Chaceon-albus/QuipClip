import { describe, expect, it } from "vitest";
import type { CurrentSegmentRef } from "@/features/timeline";
import type { Pts } from "@/types/project";
import {
  canDeleteSegment,
  canExportMedia,
  canFinishSegment,
  canFitTimeline,
  canRedoEdit,
  canStepFrames,
  canTogglePlayback,
  canUndoEdit,
  canZoomTimelineIn,
  canZoomTimelineOut,
  isSourceActive,
} from "./actionConditions";

const BOOLEANS = [false, true] as const;

const current: CurrentSegmentRef = {
  index: 0,
  segment: { id: "a", sourceId: "s", inPts: "0" as Pts, outPts: "3000" as Pts },
};
const pendingIn = "1500" as Pts;

describe("actionConditions", () => {
  it("makes a source active only with open media, an attached element and metadata", () => {
    for (const hasMedia of BOOLEANS) {
      for (const isAttached of BOOLEANS) {
        for (const isReady of BOOLEANS) {
          expect(isSourceActive(hasMedia, isAttached, isReady)).toBe(
            hasMedia && isAttached && isReady,
          );
        }
      }
    }
  });

  it("lets playback toggle with an active source and no decode stall", () => {
    expect(canTogglePlayback(true, false)).toBe(true);
    expect(canTogglePlayback(false, false)).toBe(false);
    expect(canTogglePlayback(true, true)).toBe(false);
    expect(canTogglePlayback(false, true)).toBe(false);
  });

  it("lets a frame step run with an active source, a nominal rate and no decode stall", () => {
    for (const hasActiveSource of BOOLEANS) {
      for (const hasNominalRate of BOOLEANS) {
        for (const isDecodeStalled of BOOLEANS) {
          expect(canStepFrames(hasActiveSource, hasNominalRate, isDecodeStalled)).toBe(
            hasActiveSource && hasNominalRate && !isDecodeStalled,
          );
        }
      }
    }
  });

  it("lets undo and redo run with an active source and a history entry", () => {
    for (const hasActiveSource of BOOLEANS) {
      for (const hasEntry of BOOLEANS) {
        expect(canUndoEdit(hasActiveSource, hasEntry)).toBe(
          hasActiveSource && hasEntry,
        );
        expect(canRedoEdit(hasActiveSource, hasEntry)).toBe(
          hasActiveSource && hasEntry,
        );
      }
    }
  });

  it("finishes a segment only while one is in progress", () => {
    expect(canFinishSegment(true, current, null)).toBe(true);
    expect(canFinishSegment(true, null, pendingIn)).toBe(true);
    expect(canFinishSegment(true, null, null)).toBe(false);
    expect(canFinishSegment(false, current, null)).toBe(false);
    expect(canFinishSegment(false, null, pendingIn)).toBe(false);
  });

  it("deletes a segment only while one is current", () => {
    expect(canDeleteSegment(true, current)).toBe(true);
    expect(canDeleteSegment(true, null)).toBe(false);
    expect(canDeleteSegment(false, current)).toBe(false);
  });

  it("exports whenever media is open", () => {
    expect(canExportMedia(true)).toBe(true);
    expect(canExportMedia(false)).toBe(false);
  });

  it("zooms in with open media below the ceiling only", () => {
    expect(canZoomTimelineIn(true, 1, 8)).toBe(true);
    expect(canZoomTimelineIn(true, 7.99, 8)).toBe(true);
    expect(canZoomTimelineIn(true, 8, 8)).toBe(false);
    // An indeterminate extent has a ceiling of 1.
    expect(canZoomTimelineIn(true, 1, 1)).toBe(false);
    expect(canZoomTimelineIn(false, 1, 8)).toBe(false);
  });

  it("zooms out and fits with open media above zoom 1 only", () => {
    for (const condition of [canZoomTimelineOut, canFitTimeline]) {
      expect(condition(true, 1.25)).toBe(true);
      expect(condition(true, 1)).toBe(false);
      expect(condition(false, 1.25)).toBe(false);
    }
  });
});
