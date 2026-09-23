import { describe, expect, it } from "vitest";
import type { CurrentSegmentRef } from "@/features/timeline";
import type { Pts } from "@/types/project";
import {
  canDeleteSegment,
  canExportMedia,
  canFinishSegment,
  canRedoEdit,
  canStepFrames,
  canTogglePlayback,
  canUndoEdit,
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

  it("lets playback toggle with an active source only", () => {
    expect(canTogglePlayback(true)).toBe(true);
    expect(canTogglePlayback(false)).toBe(false);
  });

  it("lets a frame step run with an active source and a nominal rate", () => {
    expect(canStepFrames(true, true)).toBe(true);
    expect(canStepFrames(true, false)).toBe(false);
    expect(canStepFrames(false, true)).toBe(false);
    expect(canStepFrames(false, false)).toBe(false);
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
});
