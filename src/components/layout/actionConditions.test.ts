import { describe, expect, it } from "vitest";
import {
  canDeleteSegment,
  canExportMedia,
  canFitTimeline,
  canRedoEdit,
  canSelectAllSegments,
  canStepFrames,
  canTogglePlayback,
  canUndoEdit,
  canZoomTimelineIn,
  canZoomTimelineOut,
  isSourceActive,
} from "./actionConditions";

const BOOLEANS = [false, true] as const;

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

  it("deletes only while at least one segment is selected", () => {
    expect(canDeleteSegment(true, 1)).toBe(true);
    expect(canDeleteSegment(true, 3)).toBe(true);
    expect(canDeleteSegment(true, 0)).toBe(false);
    expect(canDeleteSegment(false, 1)).toBe(false);
  });

  it("selects all segments only while the active source has a segment", () => {
    expect(canSelectAllSegments(true, 1)).toBe(true);
    expect(canSelectAllSegments(true, 0)).toBe(false);
    expect(canSelectAllSegments(false, 2)).toBe(false);
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
