import { describe, expect, it } from "vitest";
import { formatSegmentTimes } from "@/components/timeline/segmentLabels";
import type { PresentedFrame } from "@/features/playback";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { MILLISECONDS_TIMECODE_DISPLAY, type TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Segment } from "@/types/project";
import {
  SEGMENT_DURATION_PENDING,
  formatCurrentSegmentDuration,
  presentPendingSegmentDuration,
  resolveSegmentDurationSubject,
  settleSegmentDuration,
  type SegmentDurationPlayback,
  type SegmentDurationSubject,
  type SegmentDurationTiming,
} from "./segmentDurationModel";

const pts = (value: string | number) => String(value) as Pts;

const segment = (
  id: string,
  inPts: string | number,
  outPts: string | number,
  sourceId = "s",
): Segment => ({ id, sourceId, inPts: pts(inPts), outPts: pts(outPts) });

// A Matroska-style source: 29.97 fps on a 1/1000 time base, with a first frame at PTS 80. Each
// PTS is rounded to the millisecond, so a tick length is not a whole number of frames.
const frames2997Mkv: TimecodeDisplay = {
  format: "frames",
  rate: { n: 30000, d: 1001 },
  videoTimeBase: { n: 1, d: 1000 },
};
const mkvTiming: SegmentDurationTiming = {
  videoStartPts: pts(80),
  videoTimeBase: { n: 1, d: 1000 },
  display: frames2997Mkv,
};
const mkvMsTiming: SegmentDurationTiming = {
  ...mkvTiming,
  display: MILLISECONDS_TIMECODE_DISPLAY,
};

function playbackAt(
  value: string | number | null,
  overrides: Partial<SegmentDurationPlayback> = {},
): SegmentDurationPlayback {
  const frame: PresentedFrame | null =
    value === null
      ? null
      : { mediaTime: Number(value) / 1000, inferredSourcePts: pts(value) };
  return { calibrationStatus: "ready", presentedFrame: frame, ...overrides };
}

const pendingFrom = (value: string | number): SegmentDurationSubject => ({
  kind: "pending",
  pendingInPts: pts(value),
});

describe("resolveSegmentDurationSubject", () => {
  const segments = [
    segment("old", 0, 500, "other"),
    segment("a", 1080, 2081),
    segment("b", 3000, 4000),
  ];

  it("takes the current segment, with its number among the segments of the active source", () => {
    expect(resolveSegmentDurationSubject(segments, "b", "s", null, true)).toStrictEqual(
      {
        kind: "segment",
        number: 2,
        segment: segments[2],
      },
    );
  });

  it("takes the pending In mark when no segment is current", () => {
    expect(
      resolveSegmentDurationSubject(segments, null, "s", pts(5000), true),
    ).toStrictEqual(pendingFrom(5000));
  });

  it("does not take a current segment of another source", () => {
    expect(resolveSegmentDurationSubject(segments, "old", "s", null, true)).toBeNull();
    expect(
      resolveSegmentDurationSubject(segments, "missing", "s", null, true),
    ).toBeNull();
  });

  it("has no subject without an active source, or with nothing to measure", () => {
    expect(resolveSegmentDurationSubject(segments, "a", "s", null, false)).toBeNull();
    expect(resolveSegmentDurationSubject(segments, "a", null, null, true)).toBeNull();
    expect(resolveSegmentDurationSubject(segments, null, "s", null, true)).toBeNull();
    expect(
      resolveSegmentDurationSubject(segments, null, "s", "x" as Pts, true),
    ).toBeNull();
  });
});

describe("formatCurrentSegmentDuration", () => {
  const current = segment("a", 1080, 2081);

  it("is the Duration row of the segment tooltip, character for character", () => {
    const tooltip = formatSegmentTimes(
      current,
      pts(80),
      { n: 1, d: 1000 },
      frames2997Mkv,
    );
    expect(formatCurrentSegmentDuration(current, mkvTiming)).toBe(tooltip?.duration);
    // 1001 ticks from frame 30 to frame 60 are 30 frames, `00:00:01:00` at 29.97 fps.
    expect(formatCurrentSegmentDuration(current, mkvTiming)).toBe("00:00:01:00");
  });

  it("follows the millisecond format of the source", () => {
    const tooltip = formatSegmentTimes(
      current,
      pts(80),
      { n: 1, d: 1000 },
      MILLISECONDS_TIMECODE_DISPLAY,
    );
    expect(formatCurrentSegmentDuration(current, mkvMsTiming)).toBe(tooltip?.duration);
    expect(formatCurrentSegmentDuration(current, mkvMsTiming)).toBe("00:00:01.001");
  });

  it("is null for a segment that is not a valid interval, or without source timing", () => {
    expect(
      formatCurrentSegmentDuration(segment("e", 2000, 2000), mkvTiming),
    ).toBeNull();
    expect(
      formatCurrentSegmentDuration(current, { ...mkvTiming, videoStartPts: null }),
    ).toBeNull();
  });
});

describe("presentPendingSegmentDuration", () => {
  it("is the duration of the segment that Mark Out would make at the frame on screen", () => {
    // Mark Out on the frame at 2081 makes [1080, 2081), and its tooltip shows this value.
    const madeByMarkOut = formatSegmentTimes(
      segment("new", 1080, 2081),
      pts(80),
      { n: 1, d: 1000 },
      frames2997Mkv,
    );
    expect(presentPendingSegmentDuration(pts(1080), playbackAt(2081), mkvTiming)).toBe(
      madeByMarkOut?.duration,
    );
  });

  it("counts the frames on the grid of the timecode, not the rounded tick length", () => {
    // Frame 31 starts at 1114 ms after rounding, 34 ticks after frame 30 at 1080 ms. The
    // duration is one frame, as the two timecodes differ by one frame.
    expect(presentPendingSegmentDuration(pts(1080), playbackAt(1114), mkvTiming)).toBe(
      "00:00:00:01",
    );
  });

  it("is zero on the pending In mark itself", () => {
    expect(presentPendingSegmentDuration(pts(1080), playbackAt(1080), mkvTiming)).toBe(
      "00:00:00:00",
    );
    expect(
      presentPendingSegmentDuration(pts(1080), playbackAt(1080), mkvMsTiming),
    ).toBe("00:00:00.000");
  });

  it("is null before the pending In mark, where no segment can end", () => {
    expect(
      presentPendingSegmentDuration(pts(1080), playbackAt(1047), mkvTiming),
    ).toBeNull();
  });

  it("is pending while a seek hides the frame on screen", () => {
    expect(presentPendingSegmentDuration(pts(1080), playbackAt(null), mkvTiming)).toBe(
      SEGMENT_DURATION_PENDING,
    );
  });

  it("is null while the calibration is not ready, because no PTS names the frame", () => {
    for (const calibrationStatus of ["calibrating", "unavailable"] as const) {
      expect(
        presentPendingSegmentDuration(
          pts(1080),
          playbackAt(2081, { calibrationStatus }),
          mkvTiming,
        ),
      ).toBeNull();
      expect(
        presentPendingSegmentDuration(
          pts(1080),
          playbackAt(null, { calibrationStatus }),
          mkvTiming,
        ),
      ).toBeNull();
    }
  });

  it("uses exact signed i64 arithmetic", () => {
    const timing: SegmentDurationTiming = {
      videoStartPts: pts("-9223372036854775808"),
      videoTimeBase: { n: 1, d: 25 },
      display: {
        format: "frames",
        rate: { n: 25, d: 1 },
        videoTimeBase: { n: 1, d: 25 },
      },
    };
    // 26 ticks of 1/25 s are 26 frames at 25 fps: one second and one frame.
    expect(
      presentPendingSegmentDuration(
        pts("-9223372036854775800"),
        playbackAt("-9223372036854775774"),
        timing,
      ),
    ).toBe("00:00:01:01");
  });
});

describe("settleSegmentDuration", () => {
  it("keeps the shown value while the frame on screen is pending", () => {
    expect(settleSegmentDuration("00:00:01:00", SEGMENT_DURATION_PENDING)).toBe(
      "00:00:01:00",
    );
    expect(settleSegmentDuration(null, SEGMENT_DURATION_PENDING)).toBeNull();
  });

  it("takes every other value", () => {
    expect(settleSegmentDuration("00:00:01:00", "00:00:01:01")).toBe("00:00:01:01");
    expect(settleSegmentDuration("00:00:01:00", null)).toBeNull();
  });

  it("does not blank the value during a frame step", () => {
    // A step: the frame at 2081, then the seek, then the next frame at 2115.
    let shown: string | null = null;
    const trace: (string | null)[] = [];
    for (const playback of [playbackAt(2081), playbackAt(null), playbackAt(2115)]) {
      shown = settleSegmentDuration(
        shown,
        presentPendingSegmentDuration(pts(1080), playback, mkvTiming),
      );
      trace.push(shown);
    }
    expect(trace).toStrictEqual(["00:00:01:00", "00:00:01:00", "00:00:01:01"]);
  });
});

describe("the catalog text of the duration label", () => {
  it("has the number placeholder in both catalogs", () => {
    expect(en.transport.segmentDuration.segment).toContain("{{index}}");
    expect(zhCN.transport.segmentDuration.segment).toContain("{{index}}");
    expect(zhCN.transport.segmentDuration.segment).toContain("片段");
  });
});
