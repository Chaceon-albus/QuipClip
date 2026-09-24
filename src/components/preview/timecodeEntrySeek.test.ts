import { describe, expect, it, vi } from "vitest";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  EXTENT_END_SEEK_OPTIONS,
  type ShortcutProbe,
} from "@/components/layout/shortcutCommands";
import { resolveTimecodeDisplay } from "@/features/playback";
import {
  lastTickOfGridIndex,
  MILLISECONDS_TIMECODE_DISPLAY,
  type TimecodeDisplay,
} from "@/lib/timecode";
import type { TimecodeEntry } from "@/lib/timecodeEntry";
import type { Pts, Rational, TickCount } from "@/types/project";
import {
  MAX_TYPED_STEP_FRAMES,
  planTimecodeEntrySeek,
  resolveTimecodeEntry,
  runTimecodeEntryCommand,
  type TimecodeEntryActions,
  type TimecodeEntrySnapshot,
} from "./timecodeEntrySeek";

const fps25: Rational = { n: 25, d: 1 };
const fps23976: Rational = { n: 24000, d: 1001 };

/** 10 s at 25 fps on 1/1000, a start PTS of 500: an exact grid. */
const gridProbe: ShortcutProbe = {
  videoStartPts: "500" as Pts,
  videoTimeBase: { n: 1, d: 1000 },
  videoDurationTicks: "10000" as TickCount,
  approximateDurationSeconds: 10,
  avgFrameRate: fps25,
  rFrameRate: fps25,
};

/** 10 s at 23.976 fps on 1/24: one tick is almost a whole frame, so the grid is not exact. */
const coarseProbe: ShortcutProbe = {
  videoStartPts: "0" as Pts,
  videoTimeBase: { n: 1, d: 24 },
  videoDurationTicks: "240" as TickCount,
  approximateDurationSeconds: 10,
  avgFrameRate: fps23976,
  rFrameRate: fps23976,
};

/** A variable frame rate: the average and the real rate differ. */
const vfrProbe: ShortcutProbe = {
  ...gridProbe,
  avgFrameRate: { n: 2997, d: 100 },
  rFrameRate: { n: 30, d: 1 },
};

/** No nominal frame rate at all. */
const noRateProbe: ShortcutProbe = {
  ...gridProbe,
  avgFrameRate: null,
  rFrameRate: null,
};

type Playback = TimecodeEntrySnapshot["playback"];

const readyPlayback: Playback = {
  isAttached: true,
  isReady: true,
  calibrationStatus: "ready",
  presentedFrame: null,
  seekTargetSeconds: null,
  runtimeBrowserDurationSeconds: 10,
  approximateBrowserTimeSeconds: 0,
  isPlaying: false,
};

function snapshot(
  probe: ShortcutProbe | null,
  playback: Partial<Playback> = {},
  display?: TimecodeDisplay,
): TimecodeEntrySnapshot {
  return {
    probe,
    playback: { ...readyPlayback, ...playback },
    display: display ?? resolveTimecodeDisplay("frames", probe),
  };
}

/** The presented frame at `ticks` after the start of the probe. */
function presentedAt(probe: ShortcutProbe, ticks: number) {
  return {
    mediaTime: 0,
    inferredSourcePts: String(
      BigInt(probe.videoStartPts ?? "0") + BigInt(ticks),
    ) as Pts,
  };
}

const frame = (index: number | bigint): TimecodeEntry => ({
  kind: "frame",
  frameIndex: BigInt(index),
});
const frameStep = (frames: number | bigint): TimecodeEntry => ({
  kind: "frameStep",
  frames: BigInt(frames),
});
const millisecond = (value: number | bigint): TimecodeEntry => ({
  kind: "millisecond",
  milliseconds: BigInt(value),
});
const millisecondStep = (value: number | bigint): TimecodeEntry => ({
  kind: "millisecondStep",
  milliseconds: BigInt(value),
});

/** Where End goes on the calibrated grid probe: the last of its 250 frames (ADR 026). */
const END_SEEK = { kind: "seekToFrameIndex", frameIndex: 249 } as const;

/** Where End goes without a calibration: the end of the ruler on the approximate clock. */
const APPROXIMATE_END_SEEK = {
  kind: "seekApproximate",
  seconds: 10,
  options: APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
} as const;

describe("planTimecodeEntrySeek", () => {
  describe("without an active source", () => {
    it("plans nothing with no media, no attached element or an element that is not ready", () => {
      expect(planTimecodeEntrySeek(frame(5), snapshot(null))).toEqual({
        ok: true,
        command: null,
      });
      expect(
        planTimecodeEntrySeek(frame(5), snapshot(gridProbe, { isAttached: false })),
      ).toEqual({ ok: true, command: null });
      expect(
        planTimecodeEntrySeek(frameStep(5), snapshot(gridProbe, { isReady: false })),
      ).toEqual({ ok: true, command: null });
    });
  });

  describe("a relative number of frames", () => {
    it("is exactly one seekNominal request of that many frames", () => {
      expect(planTimecodeEntrySeek(frameStep(45), snapshot(gridProbe))).toEqual({
        ok: true,
        command: { kind: "seekNominal", frames: 45 },
      });
      expect(planTimecodeEntrySeek(frameStep(-60), snapshot(gridProbe))).toEqual({
        ok: true,
        command: { kind: "seekNominal", frames: -60 },
      });
    });

    it("is the same request in every calibration state and off the grid", () => {
      for (const probe of [gridProbe, coarseProbe, vfrProbe]) {
        for (const calibrationStatus of [
          "calibrating",
          "ready",
          "unavailable",
        ] as const) {
          expect(
            planTimecodeEntrySeek(
              frameStep(3),
              snapshot(probe, { calibrationStatus }, MILLISECONDS_TIMECODE_DISPLAY),
            ),
          ).toEqual({ ok: true, command: { kind: "seekNominal", frames: 3 } });
        }
      }
    });

    it("plans nothing for zero frames", () => {
      expect(planTimecodeEntrySeek(frameStep(0), snapshot(gridProbe))).toEqual({
        ok: true,
        command: null,
      });
    });

    it("limits a count past the safe integers, so the step still stops at the end", () => {
      expect(planTimecodeEntrySeek(frameStep(10n ** 30n), snapshot(gridProbe))).toEqual(
        {
          ok: true,
          command: { kind: "seekNominal", frames: MAX_TYPED_STEP_FRAMES },
        },
      );
      expect(
        planTimecodeEntrySeek(frameStep(-(10n ** 30n)), snapshot(gridProbe)),
      ).toEqual({
        ok: true,
        command: { kind: "seekNominal", frames: -MAX_TYPED_STEP_FRAMES },
      });
    });

    it("plans nothing for a step in frames without a nominal rate, which the parser never gives", () => {
      expect(
        planTimecodeEntrySeek(
          frameStep(5),
          snapshot(noRateProbe, {}, MILLISECONDS_TIMECODE_DISPLAY),
        ),
      ).toEqual({ ok: true, command: null });
    });
  });

  describe("an absolute frame timecode", () => {
    it("goes to the frame index on the grid while the calibration is ready", () => {
      expect(planTimecodeEntrySeek(frame(137), snapshot(gridProbe))).toEqual({
        ok: true,
        command: { kind: "seekToFrameIndex", frameIndex: 137 },
      });
    });

    it("goes to the frame index while the calibration is open, for the store to defer", () => {
      expect(
        planTimecodeEntrySeek(
          frame(137),
          snapshot(gridProbe, {
            calibrationStatus: "calibrating",
            presentedFrame: null,
          }),
        ),
      ).toEqual({ ok: true, command: { kind: "seekToFrameIndex", frameIndex: 137 } });
    });

    it("goes to the last tick of the frame off the grid", () => {
      const display = resolveTimecodeDisplay("frames", coarseProbe);
      expect(display.format).toBe("frames");
      const plan = planTimecodeEntrySeek(
        frame(100),
        snapshot(coarseProbe, {}, display),
      );
      const ticks = lastTickOfGridIndex(100n, coarseProbe.videoTimeBase, display);
      expect(plan).toEqual({
        ok: true,
        command: { kind: "seekToPts", pts: String(ticks) },
      });
      // The same PTS while the calibration is open: the store defers it.
      expect(
        planTimecodeEntrySeek(
          frame(100),
          snapshot(coarseProbe, { calibrationStatus: "calibrating" }, display),
        ),
      ).toEqual(plan);
    });

    it("goes to the middle of the nominal frame on the approximate clock", () => {
      expect(
        planTimecodeEntrySeek(
          frame(137),
          snapshot(gridProbe, { calibrationStatus: "unavailable" }),
        ),
      ).toEqual({
        ok: true,
        command: { kind: "seekApproximate", seconds: 137.5 / 25 },
      });
    });

    it("goes where End goes at or after the end of the source", () => {
      // Frame 250 starts at 10 s, the end. End goes to the last frame, 249.
      expect(planTimecodeEntrySeek(frame(250), snapshot(gridProbe))).toEqual({
        ok: true,
        command: END_SEEK,
      });
      expect(planTimecodeEntrySeek(frame(10n ** 40n), snapshot(gridProbe))).toEqual({
        ok: true,
        command: END_SEEK,
      });
      // Frame 249, the last frame, is inside the source.
      expect(planTimecodeEntrySeek(frame(249), snapshot(gridProbe))).toEqual({
        ok: true,
        command: { kind: "seekToFrameIndex", frameIndex: 249 },
      });
      // While the calibration is open too, for the store to defer.
      expect(
        planTimecodeEntrySeek(
          frame(250),
          snapshot(gridProbe, { calibrationStatus: "calibrating" }),
        ),
      ).toEqual({ ok: true, command: END_SEEK });
    });

    it("goes past the end to the last tick of the extent off the grid, as End does", () => {
      const ms = MILLISECONDS_TIMECODE_DISPLAY;
      // 500 + 10000 - 1.
      expect(
        planTimecodeEntrySeek(millisecond(10_000), snapshot(vfrProbe, {}, ms)),
      ).toEqual({
        ok: true,
        command: {
          kind: "seekToPts",
          pts: "10499",
          options: EXTENT_END_SEEK_OPTIONS,
        },
      });
      expect(planTimecodeEntrySeek(frame(240), snapshot(coarseProbe))).toEqual({
        ok: true,
        command: {
          kind: "seekToPts",
          pts: "239",
          options: EXTENT_END_SEEK_OPTIONS,
        },
      });
      // The frame that starts at the last tick is already on screen.
      expect(
        planTimecodeEntrySeek(
          frame(240),
          snapshot(coarseProbe, { presentedFrame: presentedAt(coarseProbe, 239) }),
        ),
      ).toEqual({ ok: true, command: null });
    });

    it("goes to a last frame shorter than an interval, typed or past the end", () => {
      // 25 fps on 1/1000, 376 ticks: frame 9 covers 360 to 376.
      const shortProbe: ShortcutProbe = {
        ...gridProbe,
        videoDurationTicks: "376" as TickCount,
        approximateDurationSeconds: 0.376,
      };
      const frame9 = { kind: "seekToFrameIndex", frameIndex: 9 } as const;
      expect(planTimecodeEntrySeek(frame(9), snapshot(shortProbe))).toEqual({
        ok: true,
        command: frame9,
      });
      expect(planTimecodeEntrySeek(frame(10), snapshot(shortProbe))).toEqual({
        ok: true,
        command: frame9,
      });
    });

    it("goes past the end on the approximate clock without a calibration or without ticks", () => {
      expect(
        planTimecodeEntrySeek(
          frame(250),
          snapshot(gridProbe, { calibrationStatus: "unavailable" }),
        ),
      ).toEqual({ ok: true, command: APPROXIMATE_END_SEEK });
      const noTicks: ShortcutProbe = { ...gridProbe, videoDurationTicks: null };
      expect(planTimecodeEntrySeek(frame(250), snapshot(noTicks))).toEqual({
        ok: true,
        command: APPROXIMATE_END_SEEK,
      });
    });

    it("does nothing past the end when the last frame is already on screen", () => {
      // The last frame, 249, starts at 9.960 s.
      expect(
        planTimecodeEntrySeek(
          frame(300),
          snapshot(gridProbe, { presentedFrame: presentedAt(gridProbe, 9960) }),
        ),
      ).toEqual({ ok: true, command: null });
      // The frame before it is not the last frame.
      expect(
        planTimecodeEntrySeek(
          frame(300),
          snapshot(gridProbe, { presentedFrame: presentedAt(gridProbe, 9920) }),
        ),
      ).toEqual({ ok: true, command: END_SEEK });
    });

    it("refuses a frame past the safe integers when the end is not known", () => {
      const noEnd: ShortcutProbe = {
        ...gridProbe,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
      };
      expect(
        planTimecodeEntrySeek(
          frame(10n ** 20n),
          snapshot(noEnd, { runtimeBrowserDurationSeconds: null }),
        ),
      ).toEqual({ ok: false, error: "tooLarge" });
      expect(
        planTimecodeEntrySeek(
          frame(10n ** 6n),
          snapshot(noEnd, { runtimeBrowserDurationSeconds: null }),
        ),
      ).toEqual({
        ok: true,
        command: { kind: "seekToFrameIndex", frameIndex: 1_000_000 },
      });
    });

    describe("the frame on screen", () => {
      // Frame 137 starts at 5.48 s, 5480 ticks.
      const onScreen = presentedAt(gridProbe, 5480);

      it("does nothing when the timecode is the frame on screen", () => {
        expect(
          planTimecodeEntrySeek(
            frame(137),
            snapshot(gridProbe, { presentedFrame: onScreen }),
          ),
        ).toEqual({ ok: true, command: null });
        // Off the grid too.
        const display = resolveTimecodeDisplay("frames", coarseProbe);
        expect(
          planTimecodeEntrySeek(
            frame(100),
            snapshot(
              coarseProbe,
              { presentedFrame: presentedAt(coarseProbe, 100) },
              display,
            ),
          ),
        ).toEqual({ ok: true, command: null });
      });

      it("still seeks while a seek is pending or the source plays", () => {
        expect(
          planTimecodeEntrySeek(
            frame(137),
            snapshot(gridProbe, { presentedFrame: onScreen, seekTargetSeconds: 2 }),
          ),
        ).toEqual({ ok: true, command: { kind: "seekToFrameIndex", frameIndex: 137 } });
        expect(
          planTimecodeEntrySeek(
            frame(137),
            snapshot(gridProbe, { presentedFrame: onScreen, isPlaying: true }),
          ),
        ).toEqual({ ok: true, command: { kind: "seekToFrameIndex", frameIndex: 137 } });
      });

      it("seeks to another frame", () => {
        expect(
          planTimecodeEntrySeek(
            frame(138),
            snapshot(gridProbe, { presentedFrame: onScreen }),
          ),
        ).toEqual({ ok: true, command: { kind: "seekToFrameIndex", frameIndex: 138 } });
      });
    });
  });

  describe("an absolute millisecond time", () => {
    const ms = MILLISECONDS_TIMECODE_DISPLAY;

    it("goes to the last tick of the millisecond while a calibration holds or is open", () => {
      for (const calibrationStatus of ["ready", "calibrating"] as const) {
        expect(
          planTimecodeEntrySeek(
            millisecond(5012),
            snapshot(gridProbe, { calibrationStatus }, ms),
          ),
        ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "5512" } });
      }
      // 1/90000: the last tick of 5.012 s is 451124, below 5.0125 s.
      const fine: ShortcutProbe = {
        ...gridProbe,
        videoStartPts: "0" as Pts,
        videoTimeBase: { n: 1, d: 90000 },
        videoDurationTicks: "900000" as TickCount,
      };
      expect(planTimecodeEntrySeek(millisecond(5012), snapshot(fine, {}, ms))).toEqual({
        ok: true,
        command: { kind: "seekToPts", pts: "451124" },
      });
    });

    it("goes to the time on the approximate clock without a calibration", () => {
      expect(
        planTimecodeEntrySeek(
          millisecond(5012),
          snapshot(gridProbe, { calibrationStatus: "unavailable" }, ms),
        ),
      ).toEqual({ ok: true, command: { kind: "seekApproximate", seconds: 5.012 } });
    });

    it("takes the time path on a variable frame rate", () => {
      expect(
        planTimecodeEntrySeek(millisecond(2000), snapshot(vfrProbe, {}, ms)),
      ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "2500" } });
    });

    it("goes where End goes at or after the end", () => {
      expect(
        planTimecodeEntrySeek(millisecond(10_000), snapshot(gridProbe, {}, ms)),
      ).toEqual({
        ok: true,
        command: END_SEEK,
      });
    });

    it("does nothing when the time is the time of the frame on screen", () => {
      expect(
        planTimecodeEntrySeek(
          millisecond(5480),
          snapshot(gridProbe, { presentedFrame: presentedAt(gridProbe, 5480) }, ms),
        ),
      ).toEqual({ ok: true, command: null });
    });

    it("does nothing on the grid for a time inside the frame on screen", () => {
      const onScreen = presentedAt(gridProbe, 5480);
      // Frame 137 covers 5.480 s to 5.520 s.
      expect(
        planTimecodeEntrySeek(
          millisecond(5500),
          snapshot(gridProbe, { presentedFrame: onScreen }, ms),
        ),
      ).toEqual({ ok: true, command: null });
      expect(
        planTimecodeEntrySeek(
          millisecond(5520),
          snapshot(gridProbe, { presentedFrame: onScreen }, ms),
        ),
      ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "6020" } });
      // Off the grid no frame boundary is known, so the time seeks.
      expect(
        planTimecodeEntrySeek(
          millisecond(2010),
          snapshot(vfrProbe, { presentedFrame: presentedAt(vfrProbe, 2000) }, ms),
        ),
      ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "2510" } });
    });
  });

  describe("a relative millisecond time", () => {
    const ms = MILLISECONDS_TIMECODE_DISPLAY;

    it("adds to the time that the display shows", () => {
      // The presented frame shows 5.480 s.
      expect(
        planTimecodeEntrySeek(
          millisecondStep(1500),
          snapshot(gridProbe, { presentedFrame: presentedAt(gridProbe, 5480) }, ms),
        ),
      ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "7480" } });
      // A pending seek target shows first (ADR 022).
      expect(
        planTimecodeEntrySeek(
          millisecondStep(-1500),
          snapshot(gridProbe, { seekTargetSeconds: 3.2 }, ms),
        ),
      ).toEqual({ ok: true, command: { kind: "seekToPts", pts: "2200" } });
      // The approximate clock without a calibration.
      expect(
        planTimecodeEntrySeek(
          millisecondStep(250),
          snapshot(
            gridProbe,
            { calibrationStatus: "unavailable", approximateBrowserTimeSeconds: 1 },
            ms,
          ),
        ),
      ).toEqual({ ok: true, command: { kind: "seekApproximate", seconds: 1.25 } });
    });

    it("stops at the start and at the end", () => {
      expect(
        planTimecodeEntrySeek(
          millisecondStep(-60_000),
          snapshot(
            gridProbe,
            { calibrationStatus: "unavailable", approximateBrowserTimeSeconds: 1 },
            ms,
          ),
        ),
      ).toEqual({ ok: true, command: { kind: "seekApproximate", seconds: 0 } });
      expect(
        planTimecodeEntrySeek(
          millisecondStep(60_000),
          snapshot(gridProbe, { seekTargetSeconds: 3 }, ms),
        ),
      ).toEqual({ ok: true, command: END_SEEK });
    });
  });
});

describe("resolveTimecodeEntry", () => {
  it("closes an empty field as Escape does", () => {
    expect(resolveTimecodeEntry("  ", snapshot(gridProbe))).toEqual({ kind: "cancel" });
  });

  it("reports a parse error", () => {
    expect(resolveTimecodeEntry("5:x", snapshot(gridProbe))).toEqual({
      kind: "error",
      error: "invalid",
    });
    expect(
      resolveTimecodeEntry(
        "1.2345",
        snapshot(gridProbe, {}, MILLISECONDS_TIMECODE_DISPLAY),
      ),
    ).toEqual({ kind: "error", error: "tooManyDecimals" });
    expect(resolveTimecodeEntry("5;12", snapshot(gridProbe))).toEqual({
      kind: "error",
      error: "invalid",
    });
  });

  it("reports a plan error", () => {
    const noEnd: ShortcutProbe = {
      ...gridProbe,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
    };
    expect(
      resolveTimecodeEntry(
        "99999999999999999999",
        snapshot(
          noEnd,
          { runtimeBrowserDurationSeconds: null },
          MILLISECONDS_TIMECODE_DISPLAY,
        ),
      ),
    ).toEqual({ kind: "error", error: "tooLarge" });
  });

  it("reads signed digits by the rule of the format", () => {
    // Frames: right-aligned fields, so +1012 is 10 seconds and 12 frames.
    expect(resolveTimecodeEntry("+1012", snapshot(gridProbe))).toEqual({
      kind: "run",
      command: { kind: "seekNominal", frames: 10 * 25 + 12 },
    });
    // Milliseconds: seconds, also on a source without a frame rate. The frame on screen shows
    // 5.480 s, and "-2" goes two seconds back.
    expect(
      resolveTimecodeEntry(
        "-2",
        snapshot(
          noRateProbe,
          { presentedFrame: presentedAt(noRateProbe, 5480) },
          MILLISECONDS_TIMECODE_DISPLAY,
        ),
      ),
    ).toEqual({ kind: "run", command: { kind: "seekToPts", pts: "3980" } });
  });

  it("runs the plan of a time", () => {
    expect(resolveTimecodeEntry("5:12", snapshot(gridProbe))).toEqual({
      kind: "run",
      command: { kind: "seekToFrameIndex", frameIndex: 137 },
    });
    expect(resolveTimecodeEntry("+10", snapshot(gridProbe))).toEqual({
      kind: "run",
      command: { kind: "seekNominal", frames: 10 },
    });
  });
});

describe("runTimecodeEntryCommand", () => {
  function fakeActions(): TimecodeEntryActions {
    return {
      seekNominal: vi.fn(),
      seekToFrameIndex: vi.fn(),
      seekToPts: vi.fn(),
      seekApproximate: vi.fn(),
    };
  }

  it("calls the one action of each command", () => {
    const actions = fakeActions();
    runTimecodeEntryCommand({ kind: "seekNominal", frames: -3 }, actions);
    runTimecodeEntryCommand({ kind: "seekToFrameIndex", frameIndex: 7 }, actions);
    runTimecodeEntryCommand({ kind: "seekToPts", pts: "42" as Pts }, actions);
    runTimecodeEntryCommand(
      { kind: "seekToPts", pts: "43" as Pts, options: EXTENT_END_SEEK_OPTIONS },
      actions,
    );
    runTimecodeEntryCommand(APPROXIMATE_END_SEEK, actions);
    runTimecodeEntryCommand({ kind: "seekApproximate", seconds: 1.5 }, actions);
    expect(actions.seekNominal).toHaveBeenCalledExactlyOnceWith(-3);
    expect(actions.seekToFrameIndex).toHaveBeenCalledExactlyOnceWith(7);
    expect(actions.seekToPts).toHaveBeenNthCalledWith(1, "42", undefined);
    expect(actions.seekToPts).toHaveBeenNthCalledWith(2, "43", EXTENT_END_SEEK_OPTIONS);
    expect(actions.seekApproximate).toHaveBeenNthCalledWith(
      1,
      10,
      APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
    );
    expect(actions.seekApproximate).toHaveBeenNthCalledWith(2, 1.5, undefined);
  });
});
