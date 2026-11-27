import { describe, expect, it } from "vitest";
import {
  canDeleteSegment,
  canExportFrame,
  canExportMedia,
  canFitTimeline,
  canOpenExportOrder,
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
  it("opens Export Order only for two or more segments of the export (ADR 066)", () => {
    expect(canOpenExportOrder(0)).toBe(false);
    expect(canOpenExportOrder(1)).toBe(false);
    expect(canOpenExportOrder(2)).toBe(true);
    expect(canOpenExportOrder(256)).toBe(true);
    expect(canOpenExportOrder(Number.NaN)).toBe(false);
    expect(canOpenExportOrder(2.5)).toBe(false);
  });

  it("exports a frame only under the condition of Mark In and no other blocker (ADR 069)", () => {
    const ready = {
      hasActiveSource: true,
      isCalibrated: true,
      hasConfirmedFrame: true,
      isDecodeStalled: false,
      isRecalibrating: false,
      isTrimDragging: false,
      isTrimArmed: false,
      isBusy: false,
    };
    expect(canExportFrame(ready)).toBe(true);
    // Each fact alone, turned the other way, refuses the action.
    for (const key of Object.keys(ready) as (keyof typeof ready)[]) {
      expect(canExportFrame({ ...ready, [key]: !ready[key] }), key).toBe(false);
    }
  });

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

  it("lets undo and redo run with a history entry, and an active source or no clip", () => {
    for (const hasActiveSource of BOOLEANS) {
      for (const isSequenceEmpty of BOOLEANS) {
        for (const hasEntry of BOOLEANS) {
          const expected = (hasActiveSource || isSequenceEmpty) && hasEntry;
          expect(canUndoEdit(hasActiveSource, isSequenceEmpty, hasEntry)).toBe(
            expected,
          );
          expect(canRedoEdit(hasActiveSource, isSequenceEmpty, hasEntry)).toBe(
            expected,
          );
        }
      }
    }
    // After Clear Timeline no video is in the preview, and Undo still runs (ADR 072).
    expect(canUndoEdit(false, true, true)).toBe(true);
    // A sequence with clips and no ready video in the preview keeps the old rule.
    expect(canUndoEdit(false, false, true)).toBe(false);
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
