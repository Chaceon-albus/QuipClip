import { describe, expect, it } from "vitest";
import { formatPreviewCurrentTime } from "@/components/preview/previewFrame";
import { MILLISECONDS_TIMECODE_DISPLAY, type TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational } from "@/types/project";
import { formatPlayheadTimecode, type PlayheadTimecodeState } from "./playheadTimecode";

const pts = (value: string) => value as Pts;

const tb90k: Rational = { n: 1, d: 90000 };
const frames25: TimecodeDisplay = {
  format: "frames",
  rate: { n: 25, d: 1 },
  videoTimeBase: tb90k,
};
const frames2997Mkv: TimecodeDisplay = {
  format: "frames",
  rate: { n: 30000, d: 1001 },
  videoTimeBase: { n: 1, d: 1000 },
};

/** A calibrated source with frame 5 s + 12 frames at 25 fps on screen, and no seek pending. */
const ready: PlayheadTimecodeState = {
  seekTargetSeconds: null,
  presentedFrame: { mediaTime: 5.48, inferredSourcePts: pts("493200") },
  calibrationStatus: "ready",
  approximateBrowserTimeSeconds: 5.47,
};

describe("formatPlayheadTimecode", () => {
  it("shows the presented frame in the frame format", () => {
    expect(formatPlayheadTimecode(ready, pts("0"), tb90k, frames25)).toBe(
      "00:00:05:12",
    );
  });

  it("shows the presented frame in the millisecond format", () => {
    expect(
      formatPlayheadTimecode(ready, pts("0"), tb90k, MILLISECONDS_TIMECODE_DISPLAY),
    ).toBe("00:00:05.480");
  });

  it("counts the presented frame from the start PTS of the source", () => {
    const state = {
      ...ready,
      presentedFrame: { mediaTime: 1, inferredSourcePts: pts("-90000") },
    };
    expect(formatPlayheadTimecode(state, pts("-180000"), tb90k, frames25)).toBe(
      "00:00:01:00",
    );
  });

  it("shows the pending seek target first", () => {
    expect(
      formatPlayheadTimecode(
        { ...ready, seekTargetSeconds: 2 },
        pts("0"),
        tb90k,
        frames25,
      ),
    ).toBe("00:00:02:00");
  });

  it("shows the approximate clock while the calibration is not ready", () => {
    for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
      expect(
        formatPlayheadTimecode(
          { ...ready, calibrationStatus },
          pts("0"),
          tb90k,
          MILLISECONDS_TIMECODE_DISPLAY,
        ),
      ).toBe("00:00:05.470");
    }
  });

  it("shows the approximate clock between a seek and its frame, with no start PTS", () => {
    expect(
      formatPlayheadTimecode(
        { ...ready, presentedFrame: null },
        pts("0"),
        tb90k,
        MILLISECONDS_TIMECODE_DISPLAY,
      ),
    ).toBe("00:00:05.470");
    expect(
      formatPlayheadTimecode(ready, null, tb90k, MILLISECONDS_TIMECODE_DISPLAY),
    ).toBe("00:00:05.470");
  });

  it("writes a negative approximate time with a minus sign, and no time as zero", () => {
    const approximate = { ...ready, calibrationStatus: "unavailable" as const };
    expect(
      formatPlayheadTimecode(
        { ...approximate, approximateBrowserTimeSeconds: -0.25 },
        null,
        null,
        MILLISECONDS_TIMECODE_DISPLAY,
      ),
    ).toBe("-00:00:00.250");
    expect(
      formatPlayheadTimecode(
        { ...approximate, approximateBrowserTimeSeconds: null },
        null,
        null,
        frames25,
      ),
    ).toBe("00:00:00:00");
  });

  // The seek slider reads this text to assistive technology, so it must be the text that the
  // preview shows for the same state.
  it.each([
    ["a presented frame at 25 fps", ready, frames25],
    [
      "a Matroska frame start at 29.97 fps",
      {
        ...ready,
        presentedFrame: { mediaTime: 1.001, inferredSourcePts: pts("1001") },
      },
      frames2997Mkv,
    ],
    ["a pending target", { ...ready, seekTargetSeconds: 3.2 }, frames25],
    [
      "the approximate clock",
      { ...ready, calibrationStatus: "unavailable" as const },
      MILLISECONDS_TIMECODE_DISPLAY,
    ],
    [
      "a negative approximate time",
      {
        ...ready,
        presentedFrame: null,
        approximateBrowserTimeSeconds: -1.5,
      },
      frames25,
    ],
  ] as const)("agrees with the preview timecode for %s", (_name, state, display) => {
    const startPts = pts("0");
    const timeBase = display === frames2997Mkv ? { n: 1, d: 1000 } : tb90k;
    expect(formatPlayheadTimecode(state, startPts, timeBase, display)).toBe(
      formatPreviewCurrentTime(
        state.presentedFrame,
        state.calibrationStatus,
        startPts,
        timeBase,
        state.approximateBrowserTimeSeconds ?? 0,
        state.seekTargetSeconds,
        display,
      ),
    );
  });
});
