import { describe, expect, it } from "vitest";
import type { Pts, Rational, TickCount } from "@/types/project";
import {
  PLAYING_ARROW_JUMP_SECONDS,
  planTimeJump,
  TIME_JUMP_SECONDS,
  TIME_JUMP_SEEK_OPTIONS,
  timeJumpFrames,
  type TimeJumpProbe,
  type TimeJumpSnapshot,
} from "./timeJump";

const pts = (value: string): Pts => value as Pts;
const ticks = (value: string): TickCount => value as TickCount;

/** 30 fps on a 1/90000 time base, 10 s of video: an exact frame grid (3000 ticks a frame). */
function createProbe(overrides: Partial<TimeJumpProbe> = {}): TimeJumpProbe {
  return {
    videoStartPts: pts("0"),
    videoTimeBase: { n: 1, d: 90_000 },
    videoDurationTicks: ticks("900000"),
    approximateDurationSeconds: 10.01,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    ...overrides,
  };
}

interface Overrides {
  readonly probe?: TimeJumpProbe | null;
  readonly playback?: Partial<TimeJumpSnapshot["playback"]>;
}

/** A calibrated, attached, ready and paused source with frame 30 (1 s) on screen. */
function createSnapshot(overrides: Overrides = {}): TimeJumpSnapshot {
  return {
    probe: overrides.probe === undefined ? createProbe() : overrides.probe,
    playback: {
      isAttached: true,
      isReady: true,
      isPlaying: false,
      calibrationStatus: "ready",
      presentedFrame: { mediaTime: 1, inferredSourcePts: pts("90000") },
      seekTargetSeconds: null,
      approximateBrowserTimeSeconds: 1,
      runtimeBrowserDurationSeconds: 10.02,
      ...overrides.playback,
    },
  };
}

const KEEP_PLAYING = { keepPlaying: true };

/**
 * A seek pending to frame `frame` at the rate `rateN / rateD`: the playback store shows the
 * nominal start of that frame, `frame × rateD / rateN`, as it does for a jump on the grid.
 */
function pendingAt(
  frame: number,
  rateN: number,
  rateD: number,
  probe: TimeJumpProbe = createProbe(),
): TimeJumpSnapshot {
  return createSnapshot({
    probe,
    playback: { presentedFrame: null, seekTargetSeconds: (frame * rateD) / rateN },
  });
}

describe("TIME_JUMP_SECONDS", () => {
  it("jumps 1 s with Shift and an arrow, 30 s with primary, and 5 s with an arrow in play", () => {
    expect(PLAYING_ARROW_JUMP_SECONDS).toBe(5);
    expect(TIME_JUMP_SECONDS).toStrictEqual({
      jumpBackOneSecond: -1,
      jumpForwardOneSecond: 1,
      jumpBackThirtySeconds: -30,
      jumpForwardThirtySeconds: 30,
    });
    expect(TIME_JUMP_SEEK_OPTIONS).toStrictEqual(KEEP_PLAYING);
  });
});

describe("planTimeJump", () => {
  describe("the conditions", () => {
    it("does nothing without an active source", () => {
      for (const snapshot of [
        createSnapshot({ probe: null }),
        createSnapshot({ playback: { isAttached: false } }),
        createSnapshot({ playback: { isReady: false } }),
      ]) {
        expect(planTimeJump(5, snapshot)).toBeNull();
        expect(planTimeJump(-5, snapshot)).toBeNull();
      }
    });

    it("does nothing while the extent is indeterminate", () => {
      const snapshot = createSnapshot({
        probe: createProbe({
          videoDurationTicks: null,
          approximateDurationSeconds: null,
        }),
        playback: { runtimeBrowserDurationSeconds: null },
      });
      expect(planTimeJump(5, snapshot)).toBeNull();
      expect(planTimeJump(-5, snapshot)).toBeNull();
    });
  });

  describe("on the frame grid", () => {
    it("moves a whole number of frames, and keeps the playback running", () => {
      // Frame 30 is on screen at 30 fps: 5 s is 150 frames, and 1 s is 30.
      expect(planTimeJump(5, createSnapshot())).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 180,
        options: KEEP_PLAYING,
      });
      expect(planTimeJump(1, createSnapshot())).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 60,
        options: KEEP_PLAYING,
      });
      // Frame 30 less 30 frames is the first frame, a frame of the grid and not the start plan.
      expect(planTimeJump(-1, createSnapshot())).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 0,
        options: KEEP_PLAYING,
      });
    });

    it("counts from the pending target, so a held key adds one jump for each repeat", () => {
      // The playback store shows the nominal start of the frame of a pending jump. A held key
      // reads it back at each repeat, while the element still seeks to the first target.
      let snapshot = createSnapshot();
      const indices: number[] = [];
      for (let repeat = 0; repeat < 4; repeat++) {
        const plan = planTimeJump(1, snapshot);
        expect(plan?.kind).toBe("seekToFrameIndex");
        if (plan?.kind !== "seekToFrameIndex") {
          return;
        }
        indices.push(plan.frameIndex);
        snapshot = pendingAt(plan.frameIndex, 30, 1);
      }
      expect(indices).toStrictEqual([60, 90, 120, 150]);
    });

    describe("at the NTSC rates", () => {
      // Each case: a rate, the time bases to test it on, and the frames of 1 s, 5 s and 30 s,
      // `jump × rate` rounded to the nearest frame.
      const CASES = [
        {
          name: "23.976 fps",
          rate: { n: 24_000, d: 1001 },
          timeBases: [
            { n: 1, d: 24_000 },
            { n: 1, d: 1000 },
            { n: 1, d: 90_000 },
          ],
          frames: { 1: 24, 5: 120, 30: 719 },
        },
        {
          name: "29.97 fps",
          rate: { n: 30_000, d: 1001 },
          timeBases: [
            { n: 1, d: 30_000 },
            { n: 1, d: 1000 },
            { n: 1, d: 90_000 },
          ],
          frames: { 1: 30, 5: 150, 30: 899 },
        },
        {
          name: "59.94 fps",
          rate: { n: 60_000, d: 1001 },
          timeBases: [
            { n: 1, d: 60_000 },
            { n: 1, d: 1000 },
            { n: 1, d: 90_000 },
          ],
          frames: { 1: 60, 5: 300, 30: 1798 },
        },
      ] as const;

      /** A probe of 1000 s at the rate on the time base. */
      const probeOf = (rate: Rational, timeBase: Rational): TimeJumpProbe =>
        createProbe({
          videoTimeBase: timeBase,
          videoDurationTicks: ticks(String((1000 * timeBase.d) / timeBase.n)),
          approximateDurationSeconds: 1000,
          avgFrameRate: rate,
          rFrameRate: rate,
        });

      /** The frame of the plan, or a failure. */
      const frameOf = (plan: ReturnType<typeof planTimeJump>): number => {
        if (plan?.kind !== "seekToFrameIndex") {
          throw new Error(`unexpected plan ${JSON.stringify(plan)}`);
        }
        return plan.frameIndex;
      };

      for (const { name, rate, timeBases, frames } of CASES) {
        for (const timeBase of timeBases) {
          const probe = probeOf(rate, timeBase);
          const label = `${name} on 1/${timeBase.d}`;

          it(`moves ${frames[1]}, ${frames[5]} and ${frames[30]} frames at ${label}`, () => {
            expect(timeJumpFrames(1, rate)).toBe(BigInt(frames[1]));
            expect(timeJumpFrames(-5, rate)).toBe(BigInt(-frames[5]));
            for (const seconds of [1, 5, 30] as const) {
              const from = pendingAt(2000, rate.n, rate.d, probe);
              expect(frameOf(planTimeJump(seconds, from))).toBe(2000 + frames[seconds]);
              expect(frameOf(planTimeJump(-seconds, from))).toBe(
                2000 - frames[seconds],
              );
            }
          });

          it(`returns to the start frame with a jump back and a jump forward at ${label}`, () => {
            for (const seconds of [1, 5, 30] as const) {
              const there = frameOf(
                planTimeJump(-seconds, pendingAt(2000, rate.n, rate.d, probe)),
              );
              const back = frameOf(
                planTimeJump(seconds, pendingAt(there, rate.n, rate.d, probe)),
              );
              expect(back).toBe(2000);
              const ahead = frameOf(
                planTimeJump(seconds, pendingAt(2000, rate.n, rate.d, probe)),
              );
              const again = frameOf(
                planTimeJump(-seconds, pendingAt(ahead, rate.n, rate.d, probe)),
              );
              expect(again).toBe(2000);
            }
          });

          it(`moves the same frames on each of 200 held repeats at ${label}`, () => {
            // A held Shift+→ from frame 0, then a held Shift+← back. Each repeat counts from
            // the display target that the store set for the repeat before it.
            let frame = 0;
            for (let repeat = 0; repeat < 200; repeat++) {
              const next = frameOf(
                planTimeJump(1, pendingAt(frame, rate.n, rate.d, probe)),
              );
              expect(next - frame).toBe(frames[1]);
              frame = next;
            }
            expect(frame).toBe(200 * frames[1]);
            for (let repeat = 0; repeat < 200; repeat++) {
              const next = frameOf(
                planTimeJump(-1, pendingAt(frame, rate.n, rate.d, probe)),
              );
              expect(frame - next).toBe(frames[1]);
              frame = next;
            }
            expect(frame).toBe(0);
          });
        }
      }

      it("counts from the frame on screen of a Matroska file, a tick after its start", () => {
        // Each PTS is rounded to the millisecond, so frame 30 starts at 1001 ms, a tick after
        // its nominal start of 1000.999 ms. The jump counts from frame 30.
        const probe = probeOf({ n: 30_000, d: 1001 }, { n: 1, d: 1000 });
        const snapshot = createSnapshot({
          probe,
          playback: {
            presentedFrame: { mediaTime: 1.001, inferredSourcePts: pts("1001") },
          },
        });
        expect(frameOf(planTimeJump(5, snapshot))).toBe(180);
        expect(frameOf(planTimeJump(1, snapshot))).toBe(60);
        expect(frameOf(planTimeJump(-1, snapshot))).toBe(0);
      });
    });

    it("rounds a tie away from zero", () => {
      // 0.5 fps: 1 s is half a frame, so it rounds to one frame in both directions.
      expect(timeJumpFrames(1, { n: 1, d: 2 })).toBe(1n);
      expect(timeJumpFrames(-1, { n: 1, d: 2 })).toBe(-1n);
      expect(timeJumpFrames(0, { n: 30, d: 1 })).toBe(0n);
      // A value that is not whole seconds rounds the double.
      expect(timeJumpFrames(0.5, { n: 25, d: 1 })).toBe(13n);
      expect(timeJumpFrames(-0.5, { n: 25, d: 1 })).toBe(-13n);
    });

    it("does nothing when the target frame is on screen, paused, with no seek pending", () => {
      // 0.25 fps: 1 s is a quarter of a frame, so it rounds to no frame.
      const probe = createProbe({
        videoTimeBase: { n: 1, d: 1000 },
        videoDurationTicks: ticks("20000"),
        approximateDurationSeconds: 20,
        avgFrameRate: { n: 1, d: 4 },
        rFrameRate: { n: 1, d: 4 },
      });
      const paused = createSnapshot({
        probe,
        playback: { presentedFrame: { mediaTime: 0, inferredSourcePts: pts("0") } },
      });
      expect(planTimeJump(1, paused)).toBeNull();
      // 5 s rounds to one frame, which starts 4 s later.
      expect(planTimeJump(5, paused)).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 1,
        options: KEEP_PLAYING,
      });
      // During playback the store applies its own rule, so the plan seeks.
      expect(
        planTimeJump(1, {
          ...paused,
          playback: { ...paused.playback, isPlaying: true },
        }),
      ).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 0,
        options: KEEP_PLAYING,
      });
      // A pending seek means that the element moves away from that frame.
      expect(
        planTimeJump(1, {
          ...paused,
          playback: { ...paused.playback, presentedFrame: null, seekTargetSeconds: 0 },
        }),
      ).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 0,
        options: KEEP_PLAYING,
      });
    });

    it("goes to the end for a frame after the last frame of the extent", () => {
      // 25 fps on 1/25: the margin is 1 µs, the extent ends at 10 s, and frame 249 is the last.
      const probe = createProbe({
        videoTimeBase: { n: 1, d: 25 },
        videoDurationTicks: ticks("250"),
        approximateDurationSeconds: 10,
        avgFrameRate: { n: 25, d: 1 },
        rFrameRate: { n: 25, d: 1 },
      });
      // From frame 125, 5 s is frame 250, which does not exist.
      expect(planTimeJump(5, pendingAt(125, 25, 1, probe))).toStrictEqual({
        kind: "end",
      });
      // From frame 124 it is frame 249, the last frame.
      expect(planTimeJump(5, pendingAt(124, 25, 1, probe))).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 249,
        options: KEEP_PLAYING,
      });
    });

    it("asks for the frame while the calibration is open, and the store defers it", () => {
      const snapshot = createSnapshot({
        playback: {
          calibrationStatus: "calibrating",
          presentedFrame: null,
          approximateBrowserTimeSeconds: 0,
        },
      });
      expect(planTimeJump(5, snapshot)).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 150,
        options: KEEP_PLAYING,
      });
    });
  });

  describe("the edges", () => {
    it("goes to the start for a target before the start", () => {
      expect(planTimeJump(-5, createSnapshot())).toStrictEqual({ kind: "start" });
      expect(planTimeJump(-30, createSnapshot())).toStrictEqual({ kind: "start" });
      // From the first frame too: the start plan then finds that frame on screen.
      const atStart = createSnapshot({
        playback: {
          presentedFrame: { mediaTime: 0, inferredSourcePts: pts("0") },
          approximateBrowserTimeSeconds: 0,
        },
      });
      expect(planTimeJump(-1, atStart)).toStrictEqual({ kind: "start" });
    });

    it("goes to the end for a target at or after the end", () => {
      expect(planTimeJump(30, createSnapshot())).toStrictEqual({ kind: "end" });
      // 5 s + 5 s is the end of the 10 s extent.
      const atFive = createSnapshot({
        playback: { presentedFrame: null, seekTargetSeconds: 5 },
      });
      expect(planTimeJump(5, atFive)).toStrictEqual({ kind: "end" });
      expect(planTimeJump(1, atFive)).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 180,
        options: KEEP_PLAYING,
      });
    });

    it("reads the end from the extent rule of the timeline without an extent in ticks", () => {
      // The approximate duration of 10.01 s is the end. Frame 300 starts at 10 s, before it.
      const snapshot = createSnapshot({
        probe: createProbe({ videoDurationTicks: null }),
        playback: { presentedFrame: null, seekTargetSeconds: 5 },
      });
      expect(planTimeJump(5, snapshot)).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 300,
        options: KEEP_PLAYING,
      });
      // With an end at 10 s, frame 300 starts at the end, and the jump goes to the end.
      const tenSeconds = createSnapshot({
        probe: createProbe({
          videoDurationTicks: null,
          approximateDurationSeconds: 10,
        }),
        playback: { presentedFrame: null, seekTargetSeconds: 5 },
      });
      expect(planTimeJump(5, tenSeconds)).toStrictEqual({ kind: "end" });
      expect(planTimeJump(1, tenSeconds)).toStrictEqual({
        kind: "seekToFrameIndex",
        frameIndex: 180,
        options: KEEP_PLAYING,
      });
    });
  });

  describe("off the frame grid", () => {
    // The average and the real frame rate differ: a variable frame rate (ADR 022).
    const variable = createProbe({
      avgFrameRate: { n: 30_000, d: 1001 },
      rFrameRate: { n: 30, d: 1 },
    });

    it("seeks to the tick nearest the target, and keeps the playback running", () => {
      expect(planTimeJump(5, createSnapshot({ probe: variable }))).toStrictEqual({
        kind: "seekToPts",
        pts: "540000",
        options: KEEP_PLAYING,
      });
      expect(planTimeJump(-1, createSnapshot({ probe: variable }))).toStrictEqual({
        kind: "seekToPts",
        pts: "0",
        options: KEEP_PLAYING,
      });
    });

    it("counts from the pending target", () => {
      const pending = createSnapshot({
        probe: variable,
        playback: { presentedFrame: null, seekTargetSeconds: 6 },
      });
      expect(planTimeJump(1, pending)).toStrictEqual({
        kind: "seekToPts",
        pts: "630000",
        options: KEEP_PLAYING,
      });
    });

    it("leaves the grid on a coarse time base, such as 1/24 at 23.976 fps", () => {
      const coarse = createProbe({
        videoTimeBase: { n: 1, d: 24 },
        videoDurationTicks: ticks("240"),
        approximateDurationSeconds: 10,
        avgFrameRate: { n: 24_000, d: 1001 },
        rFrameRate: { n: 24_000, d: 1001 },
      });
      const snapshot = createSnapshot({
        probe: coarse,
        playback: { presentedFrame: { mediaTime: 1, inferredSourcePts: pts("24") } },
      });
      expect(planTimeJump(5, snapshot)).toStrictEqual({
        kind: "seekToPts",
        pts: "144",
        options: KEEP_PLAYING,
      });
    });

    it("does nothing for a target at the PTS of the frame on screen, paused", () => {
      const snapshot = createSnapshot({ probe: variable });
      expect(planTimeJump(0, snapshot)).toBeNull();
      expect(
        planTimeJump(0, {
          ...snapshot,
          playback: { ...snapshot.playback, isPlaying: true },
        }),
      ).toStrictEqual({ kind: "seekToPts", pts: "90000", options: KEEP_PLAYING });
    });

    it("asks for the PTS while the calibration is open", () => {
      const snapshot = createSnapshot({
        probe: variable,
        playback: {
          calibrationStatus: "calibrating",
          presentedFrame: null,
          approximateBrowserTimeSeconds: 2,
        },
      });
      expect(planTimeJump(1, snapshot)).toStrictEqual({
        kind: "seekToPts",
        pts: "270000",
        options: KEEP_PLAYING,
      });
    });
  });

  describe("without a calibration", () => {
    const unavailable = createSnapshot({
      playback: {
        calibrationStatus: "unavailable",
        presentedFrame: null,
        approximateBrowserTimeSeconds: 2.5,
      },
    });

    it("seeks on the approximate clock from the approximate position", () => {
      expect(planTimeJump(5, unavailable)).toStrictEqual({
        kind: "seekApproximate",
        seconds: 7.5,
        options: KEEP_PLAYING,
      });
      expect(planTimeJump(-1, unavailable)).toStrictEqual({
        kind: "seekApproximate",
        seconds: 1.5,
        options: KEEP_PLAYING,
      });
    });

    it("counts from the pending target, and keeps the edges", () => {
      const pending = {
        ...unavailable,
        playback: { ...unavailable.playback, seekTargetSeconds: 4 },
      };
      expect(planTimeJump(1, pending)).toStrictEqual({
        kind: "seekApproximate",
        seconds: 5,
        options: KEEP_PLAYING,
      });
      expect(planTimeJump(-5, pending)).toStrictEqual({ kind: "start" });
      expect(planTimeJump(30, pending)).toStrictEqual({ kind: "end" });
    });

    it("seeks on the approximate clock when no PTS names the start", () => {
      const snapshot = createSnapshot({
        probe: createProbe({
          videoStartPts: null,
          avgFrameRate: null,
          rFrameRate: null,
        }),
        playback: {
          calibrationStatus: "calibrating",
          presentedFrame: null,
          approximateBrowserTimeSeconds: 1,
        },
      });
      expect(planTimeJump(5, snapshot)).toStrictEqual({
        kind: "seekApproximate",
        seconds: 6,
        options: KEEP_PLAYING,
      });
    });
  });
});
