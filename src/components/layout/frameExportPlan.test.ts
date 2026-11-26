import { describe, expect, it } from "vitest";
import { getSourceRevisionKey } from "@/features/media";
import type { Pts } from "@/types/project";
import {
  isFrameExportAvailable,
  planFrameExport,
  type FrameExportMedia,
  type FrameExportSnapshot,
  type FrameExportTrimState,
} from "./frameExportPlan";

const pts = (value: string): Pts => value as Pts;

const MEDIA: FrameExportMedia = {
  path: "/media/clip.mp4",
  fileName: "clip.mp4",
  size: 2048,
  mtime: 1_700_000_000,
};

/**
 * The element of `clip.mp4` is attached, ready and calibrated, with its frame at PTS 450450 on
 * screen. No other Export Frame action runs.
 */
function snapshot(
  overrides: {
    readonly playback?: Partial<FrameExportSnapshot["playback"]>;
  } & Partial<Omit<FrameExportSnapshot, "playback">> = {},
): FrameExportSnapshot {
  const { playback, ...rest } = overrides;
  return {
    playback: {
      isAttached: true,
      isReady: true,
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 5.005, inferredSourcePts: pts("450450") },
      decodeStall: null,
      isRecalibrating: false,
      attachedSourceRevisionKey: getSourceRevisionKey(MEDIA),
      ...playback,
    },
    attachedMedia: MEDIA,
    sessionSourcePaths: ["/media/clip.mp4", "/media/b.mov"],
    displayedTime: "00:01:05.005",
    isBusy: false,
    ...rest,
  };
}

/** No segment trim runs. */
const FREE: FrameExportTrimState = { isTrimDragging: false, isTrimArmed: false };

describe("planFrameExport (ADR 069)", () => {
  it("records the source, its revision, the PTS of the element, the time and the sources", () => {
    expect(planFrameExport(snapshot(), FREE)).toEqual({
      sourcePath: "/media/clip.mp4",
      sourceFileName: "clip.mp4",
      sourceRevision: { size: 2048, mtime: 1_700_000_000 },
      pts: "450450",
      displayedTime: "00:01:05.005",
      sessionSourcePaths: ["/media/clip.mp4", "/media/b.mov"],
    });
  });

  it("adds the source of the attached clip to the sources once", () => {
    expect(
      planFrameExport(snapshot({ sessionSourcePaths: ["/media/b.mov"] }), FREE)
        ?.sessionSourcePaths,
    ).toEqual(["/media/b.mov", "/media/clip.mp4"]);
    expect(
      planFrameExport(snapshot({ sessionSourcePaths: [] }), FREE)?.sessionSourcePaths,
    ).toEqual(["/media/clip.mp4"]);
  });

  it("keeps the recorded facts when the state changes later", () => {
    const paths = ["/media/clip.mp4"];
    const state = snapshot({ sessionSourcePaths: paths });
    const facts = planFrameExport(state, FREE);
    // A later import, a later frame and a later clip change the stores, not the facts.
    paths.push("/media/late.mkv");
    const later = planFrameExport(
      snapshot({
        playback: {
          presentedFrame: { mediaTime: 9, inferredSourcePts: pts("810000") },
        },
      }),
      FREE,
    );
    expect(facts?.sessionSourcePaths).toEqual(["/media/clip.mp4"]);
    expect(facts?.pts).toBe("450450");
    expect(later?.pts).toBe("810000");
  });

  it("refuses the action under every condition that ADR 069 names", () => {
    const refusals: [string, FrameExportSnapshot, FrameExportTrimState][] = [
      ["no clip is attached", snapshot({ attachedMedia: null }), FREE],
      ["no element is attached", snapshot({ playback: { isAttached: false } }), FREE],
      ["the element has no metadata", snapshot({ playback: { isReady: false } }), FREE],
      [
        "the calibration runs",
        snapshot({ playback: { calibrationStatus: "calibrating" } }),
        FREE,
      ],
      [
        "the calibration is unavailable",
        snapshot({ playback: { calibrationStatus: "unavailable" } }),
        FREE,
      ],
      ["no frame is confirmed", snapshot({ playback: { presentedFrame: null } }), FREE],
      [
        "the frame has no valid PTS",
        snapshot({
          playback: { presentedFrame: { mediaTime: 1, inferredSourcePts: pts("1.5") } },
        }),
        FREE,
      ],
      [
        "the element is stalled",
        snapshot({
          playback: {
            decodeStall: { atSeconds: 4 },
          },
        }),
        FREE,
      ],
      [
        "the element is retired",
        snapshot({ playback: { isRecalibrating: true } }),
        FREE,
      ],
      ["a trim drags", snapshot(), { isTrimDragging: true, isTrimArmed: false }],
      // The press on an edge has not crossed the drag threshold yet: a move can still start a
      // trim behind the save dialog.
      [
        "a press on a segment edge is armed",
        snapshot(),
        { isTrimDragging: false, isTrimArmed: true },
      ],
      ["another Export Frame runs", snapshot({ isBusy: true }), FREE],
      [
        "the element shows another source",
        snapshot({ playback: { attachedSourceRevisionKey: "/media/b.mov:1:2" } }),
        FREE,
      ],
      [
        "the element shows another revision of the file",
        snapshot({
          playback: {
            attachedSourceRevisionKey: getSourceRevisionKey({ ...MEDIA, size: 4096 }),
          },
        }),
        FREE,
      ],
    ];
    for (const [name, state, trim] of refusals) {
      expect(planFrameExport(state, trim), name).toBeNull();
      expect(
        isFrameExportAvailable(state.playback, state.attachedMedia, trim, state.isBusy),
        name,
      ).toBe(false);
    }
  });

  it("accepts while playback runs, as Mark In does", () => {
    // The plan does not read the playback state: a frame confirmed while the video plays is a
    // frame that Mark In would mark.
    const state = snapshot();
    expect(
      isFrameExportAvailable(state.playback, state.attachedMedia, FREE, false),
    ).toBe(true);
  });
});
