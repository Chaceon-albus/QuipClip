import { describe, expect, it } from "vitest";
import type { Pts, Segment } from "@/types/project";
import {
  collectEditPoints,
  findEditPoint,
  type EditPointSnapshot,
} from "./editPointJump";

const pts = (value: string): Pts => value as Pts;

const SOURCE_ID = "source-1";

function segment(
  id: string,
  inPts: string,
  outPts: string,
  sourceId = SOURCE_ID,
): Segment {
  return { id, sourceId, inPts: pts(inPts), outPts: pts(outPts) };
}

type Probe = NonNullable<EditPointSnapshot["probe"]>;

/** 30 fps on a 1/90000 time base: an exact frame grid, 3000 ticks a frame. */
const GRID_PROBE: Probe = {
  videoStartPts: pts("0"),
  videoTimeBase: { n: 1, d: 90_000 },
  avgFrameRate: { n: 30, d: 1 },
  rFrameRate: { n: 30, d: 1 },
};

interface Overrides {
  readonly probe?: Probe | null;
  readonly playback?: Partial<EditPointSnapshot["playback"]>;
  readonly timeline?: Partial<EditPointSnapshot["timeline"]>;
}

/**
 * A calibrated source with frame 60 (2 s) on screen, and two segments: [1 s, 2 s) and
 * [3 s, 4 s).
 */
function createSnapshot(overrides: Overrides = {}): EditPointSnapshot {
  return {
    probe: overrides.probe === undefined ? GRID_PROBE : overrides.probe,
    playback: {
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 2, inferredSourcePts: pts("180000") },
      seekTargetSeconds: null,
      approximateBrowserTimeSeconds: 2,
      ...overrides.playback,
    },
    timeline: {
      sourceId: SOURCE_ID,
      segments: [segment("a", "90000", "180000"), segment("b", "270000", "360000")],
      pendingInPts: null,
      ...overrides.timeline,
    },
  };
}

/** The frame at `ticks` on screen, with no seek pending. */
function onFrame(ticks: string, overrides: Overrides = {}): EditPointSnapshot {
  return createSnapshot({
    ...overrides,
    playback: {
      presentedFrame: {
        mediaTime: Number(ticks) / 90_000,
        inferredSourcePts: pts(ticks),
      },
      ...overrides.playback,
    },
  });
}

describe("collectEditPoints", () => {
  it("lists the In and Out of each segment of the active source, and the pending In, once", () => {
    expect(
      collectEditPoints({
        sourceId: SOURCE_ID,
        // Out of order, two segments that meet after a split, a segment of another source and
        // a pending In on a boundary.
        segments: [
          segment("c", "270000", "360000"),
          segment("a", "90000", "180000"),
          segment("b", "180000", "270000"),
          segment("other", "30000", "60000", "source-2"),
        ],
        pendingInPts: pts("360000"),
      }),
    ).toStrictEqual(["90000", "180000", "270000", "360000"]);
  });

  it("adds the pending In, and leaves out a segment that is not valid", () => {
    expect(
      collectEditPoints({
        sourceId: SOURCE_ID,
        segments: [segment("empty", "90000", "90000"), segment("bad", "x", "180000")],
        pendingInPts: pts("45000"),
      }),
    ).toStrictEqual(["45000"]);
  });

  it("gives nothing without an active source", () => {
    expect(
      collectEditPoints({
        sourceId: null,
        segments: [segment("a", "90000", "180000")],
        pendingInPts: pts("45000"),
      }),
    ).toStrictEqual([]);
  });
});

describe("findEditPoint", () => {
  it("goes to the latest point before the frame on screen, and the earliest after it", () => {
    // Frame 75 (2.5 s): between the Out of a and the In of b.
    const between = onFrame("225000");
    expect(findEditPoint("previous", between)).toBe("180000");
    expect(findEditPoint("next", between)).toBe("270000");
  });

  it("passes over the point on screen, so a second press goes on", () => {
    // The Out of a, 2 s, is on screen.
    const atOut = createSnapshot();
    expect(findEditPoint("previous", atOut)).toBe("90000");
    expect(findEditPoint("next", atOut)).toBe("270000");
  });

  it("goes nowhere past the first and the last point", () => {
    const beforeAll = onFrame("0");
    expect(findEditPoint("previous", beforeAll)).toBeNull();
    expect(findEditPoint("next", beforeAll)).toBe("90000");
    const afterAll = onFrame("450000");
    expect(findEditPoint("previous", afterAll)).toBe("360000");
    expect(findEditPoint("next", afterAll)).toBeNull();
    // At the last point, and at the first.
    expect(findEditPoint("next", onFrame("360000"))).toBeNull();
    expect(findEditPoint("previous", onFrame("90000"))).toBeNull();
  });

  it("names a shared boundary once", () => {
    const split = onFrame("135000", {
      timeline: {
        segments: [segment("a", "90000", "180000"), segment("b", "180000", "270000")],
      },
    });
    expect(findEditPoint("next", split)).toBe("180000");
    const atShared = onFrame("180000", {
      timeline: {
        segments: [segment("a", "90000", "180000"), segment("b", "180000", "270000")],
      },
    });
    expect(findEditPoint("previous", atShared)).toBe("90000");
    expect(findEditPoint("next", atShared)).toBe("270000");
  });

  it("goes to the pending In", () => {
    const snapshot = onFrame("0", {
      timeline: { segments: [], pendingInPts: pts("150000") },
    });
    expect(findEditPoint("next", snapshot)).toBe("150000");
    expect(
      findEditPoint(
        "previous",
        onFrame("300000", { timeline: { segments: [], pendingInPts: pts("150000") } }),
      ),
    ).toBe("150000");
  });

  it("counts from the pending target, so a held key walks from point to point", () => {
    // The store shows the elapsed time of the PTS of a pending seek.
    let snapshot = onFrame("0");
    const visited: string[] = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const point = findEditPoint("next", snapshot);
      if (point === null) {
        break;
      }
      visited.push(point);
      snapshot = createSnapshot({
        playback: { presentedFrame: null, seekTargetSeconds: Number(point) / 90_000 },
      });
    }
    expect(visited).toStrictEqual(["90000", "180000", "270000", "360000"]);

    const back = createSnapshot({
      playback: { presentedFrame: null, seekTargetSeconds: 3 },
    });
    expect(findEditPoint("previous", back)).toBe("180000");
  });

  it("compares by frame index on the grid, and by ticks off it", () => {
    // 29.97 fps on a millisecond time base, as Matroska stores it. Frame 30 starts at 1001 ms
    // and its nominal start is 1000.999 ms. A point at 1000 ms is in frame 30 by the margin of
    // ADR 028, so on the grid it is the frame on screen.
    const ntsc: Probe = {
      videoStartPts: pts("0"),
      videoTimeBase: { n: 1, d: 1000 },
      avgFrameRate: { n: 30_000, d: 1001 },
      rFrameRate: { n: 30_000, d: 1001 },
    };
    const timeline = {
      segments: [segment("a", "500", "1000"), segment("b", "1001", "2000")],
    };
    const playback = {
      presentedFrame: { mediaTime: 1.001, inferredSourcePts: pts("1001") },
    };
    const onGrid = createSnapshot({ probe: ntsc, playback, timeline });
    expect(findEditPoint("previous", onGrid)).toBe("500");
    expect(findEditPoint("next", onGrid)).toBe("2000");

    // The same points at a variable rate: off the grid, 1000 lies a tick before the frame.
    const variable: Probe = { ...ntsc, rFrameRate: { n: 30, d: 1 } };
    const offGrid = createSnapshot({ probe: variable, playback, timeline });
    expect(findEditPoint("previous", offGrid)).toBe("1000");
    expect(findEditPoint("next", offGrid)).toBe("2000");
  });

  it("compares a pending target on the grid by the frame that the display names", () => {
    // A pending frame step aims at the middle of frame 66, and the store shows its nominal
    // start. The In of b at frame 90 is next, and the Out of a at frame 60 is previous.
    const pending = createSnapshot({
      playback: { presentedFrame: null, seekTargetSeconds: 66 / 30 },
    });
    expect(findEditPoint("previous", pending)).toBe("180000");
    expect(findEditPoint("next", pending)).toBe("270000");
  });

  it("reads the approximate clock while no frame is on screen", () => {
    for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
      const snapshot = createSnapshot({
        playback: {
          calibrationStatus,
          presentedFrame: null,
          approximateBrowserTimeSeconds: 2.5,
        },
      });
      expect(findEditPoint("previous", snapshot)).toBe("180000");
      expect(findEditPoint("next", snapshot)).toBe("270000");
    }
  });

  it("finds nothing without media, a start PTS or a point", () => {
    expect(findEditPoint("next", createSnapshot({ probe: null }))).toBeNull();
    expect(
      findEditPoint(
        "next",
        createSnapshot({ probe: { ...GRID_PROBE, videoStartPts: null } }),
      ),
    ).toBeNull();
    expect(
      findEditPoint("next", createSnapshot({ timeline: { segments: [] } })),
    ).toBeNull();
    expect(
      findEditPoint("previous", createSnapshot({ timeline: { sourceId: null } })),
    ).toBeNull();
  });
});
