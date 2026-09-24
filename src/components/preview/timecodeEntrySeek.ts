/**
 * Plans the seek of a time that the user typed in the preview timecode (ADR 022, ADR 026,
 * ADR 028). `parseTimecodeEntry` reads the text, and `planTimecodeEntrySeek` turns the entry
 * into one call of the playback store, from one snapshot of the media and playback state. The
 * module has no React, DOM or store dependency, so every rule has a test that needs no document.
 *
 * - A relative entry in the frame format, such as `+45` or `-1:00`, is exactly `seekNominal(N)`,
 *   with `N` the frames that the amount names: one request, as the ten-frame step of the keyboard
 *   is (ADR 026). The step clamps at both ends of the source.
 * - An absolute frame timecode on the frame grid is `seekToFrameIndex(J)`. The element seeks to
 *   the middle of nominal frame `J`, as a nominal step does (ADR 022), and the preview shows the
 *   typed timecode. While the calibration is open the store defers it, and it runs on the grid at
 *   the anchor.
 * - Any other absolute time goes to a PTS while a calibration holds or is still open, and to
 *   seconds on the approximate clock without one, as a click on the ruler does. The PTS is the
 *   last tick whose timecode is the typed value (`lastTickOfGridIndex`), not the nearest tick of
 *   the start of that value. A seek to it shows the frame whose timecode is the typed value
 *   whenever a frame starts inside that value, on every time base, so a displayed value typed
 *   back shows the same value. A seek to the nearest tick of a millisecond can land one tick
 *   before the frame that the millisecond display names, and show the frame before it.
 * - A relative entry in the millisecond format, such as `-2` or `+1.5`, adds its time to the
 *   millisecond that the display shows, and the result goes the way of an absolute time. It needs
 *   no frame rate.
 * - A time at or after the end of the source goes where End goes (ADR 026): the editors move the
 *   playhead to the end, and do not refuse the entry. A relative step past either end stops at
 *   that end, as a held arrow key does.
 * - A seek to the frame on screen does nothing (ADR 022, ADR 026): a seek that lands on the frame
 *   already on screen may bring no frame callback, and Mark In would then stay disabled.
 */

import { isSourceActive } from "@/components/layout/actionConditions";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  planEndSeek,
  sourceEndSeconds,
  type ShortcutProbe,
  type ShortcutSnapshot,
} from "@/components/layout/shortcutCommands";
import {
  getDisplayedElapsedSeconds,
  getNominalFrameRate,
  hasExactFrameGrid,
  type PlaybackActions,
  type SeekOptions,
} from "@/features/playback";
import { I64_MAX, I64_MIN, isPtsString } from "@/lib/time";
import {
  elapsedGridIndex,
  lastTickOfGridIndex,
  MILLISECONDS_TIMECODE_DISPLAY,
  type TimecodeDisplay,
} from "@/lib/timecode";
import {
  parseTimecodeEntry,
  type TimecodeEntry,
  type TimecodeEntryError,
} from "@/lib/timecodeEntry";
import type { Pts } from "@/types/project";

/**
 * The largest step, in frames, that a typed `+N` or `-N` requests. A larger count is limited to
 * it. It lies far past the end of any source (at 1000 fps it lasts 49 days), and it keeps the
 * frame arithmetic of `seekNominal` inside the safe integers, where a larger count would make
 * the step do nothing.
 */
export const MAX_TYPED_STEP_FRAMES = 2 ** 32;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** One read of the state that the plan needs. The store states satisfy it as they are. */
export interface TimecodeEntrySnapshot {
  /** The probe of the open media, or null while no media is open. */
  readonly probe: ShortcutProbe | null;
  readonly playback: ShortcutSnapshot["playback"];
  /** The timecode format of the source, in which the entry was parsed (ADR 028). */
  readonly display: TimecodeDisplay;
}

/** The playback store call of a typed time. */
export type TimecodeEntryCommand =
  | { readonly kind: "seekNominal"; readonly frames: number }
  | { readonly kind: "seekToFrameIndex"; readonly frameIndex: number }
  | { readonly kind: "seekToPts"; readonly pts: Pts }
  | {
      readonly kind: "seekApproximate";
      readonly seconds: number;
      readonly options?: SeekOptions;
    };

/**
 * Why a typed time has no seek.
 *
 * - `tooLarge`: a time past every safe number, on a source whose end is not known.
 */
export type TimecodeEntryPlanError = "tooLarge";

/** The result of `planTimecodeEntrySeek`. A null command means that nothing is to be done. */
export type TimecodeEntryPlan =
  | { readonly ok: true; readonly command: TimecodeEntryCommand | null }
  | { readonly ok: false; readonly error: TimecodeEntryPlanError };

const NOTHING: TimecodeEntryPlan = { ok: true, command: null };

function command(value: TimecodeEntryCommand): TimecodeEntryPlan {
  return { ok: true, command: value };
}

/**
 * The ticks of the frame on screen from the start of the source, or null when no frame counts as
 * on screen for the no-op rule: the calibration must be ready, a frame must be presented, no seek
 * may be pending, and the source may not play, because during playback the frame on screen
 * changes before the seek could run (the rule of End, ADR 026). On the frame grid the store
 * applies a finer rule during playback: `seekToFrameIndex` only pauses while the element is
 * still inside the typed frame, and seeks back to it once the element has left it.
 */
function screenTicks(
  playback: TimecodeEntrySnapshot["playback"],
  probe: ShortcutProbe,
): bigint | null {
  const frame = playback.presentedFrame;
  const start = probe.videoStartPts;
  if (
    playback.calibrationStatus !== "ready" ||
    frame === null ||
    playback.seekTargetSeconds !== null ||
    playback.isPlaying ||
    !isPtsString(start) ||
    !isPtsString(frame.inferredSourcePts)
  ) {
    return null;
  }
  return BigInt(frame.inferredSourcePts) - BigInt(start);
}

/**
 * The End seek for a target at or after the end of the source, or undefined when the target lies
 * before the end or the end is not known.
 */
function planPastEnd(
  targetSeconds: number,
  snapshot: TimecodeEntrySnapshot,
  probe: ShortcutProbe,
): TimecodeEntryPlan | undefined {
  const endSeconds = sourceEndSeconds(snapshot.playback, probe);
  if (endSeconds === null || targetSeconds < endSeconds) {
    return undefined;
  }
  const end = planEndSeek(snapshot.playback, true, probe);
  // End keeps the approximate clock also when the store defers it (ADR 022, ADR 026).
  return end?.kind === "seekApproximate"
    ? command({
        kind: "seekApproximate",
        seconds: end.seconds,
        options: APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
      })
    : NOTHING;
}

/**
 * The PTS of a tick count from the start of the source, or null when the source has no valid
 * start or the result leaves the signed 64-bit range.
 */
function ptsFromStart(probe: ShortcutProbe, ticks: bigint): Pts | null {
  if (!isPtsString(probe.videoStartPts)) {
    return null;
  }
  const pts = BigInt(probe.videoStartPts) + ticks;
  return pts < I64_MIN || pts > I64_MAX ? null : (pts.toString() as Pts);
}

/** The plan of an absolute frame `frameIndex` in the frame format. */
function planFrame(
  frameIndex: bigint,
  display: Extract<TimecodeDisplay, { format: "frames" }>,
  snapshot: TimecodeEntrySnapshot,
  probe: ShortcutProbe,
): TimecodeEntryPlan {
  const { rate } = display;
  // The nominal start of the frame decides the end test. A frame that starts before the end is
  // a frame of the source.
  const startSeconds =
    frameIndex > MAX_SAFE
      ? Number.POSITIVE_INFINITY
      : (Number(frameIndex) * rate.d) / rate.n;
  const pastEnd = planPastEnd(startSeconds, snapshot, probe);
  if (pastEnd !== undefined) {
    return pastEnd;
  }
  if (frameIndex > MAX_SAFE) {
    return { ok: false, error: "tooLarge" };
  }

  const tb = probe.videoTimeBase;
  const onScreen = screenTicks(snapshot.playback, probe);
  if (onScreen !== null && elapsedGridIndex(onScreen, tb, display) === frameIndex) {
    return NOTHING;
  }

  const calibration = snapshot.playback.calibrationStatus;
  if (calibration !== "unavailable" && hasExactFrameGrid(probe)) {
    return command({ kind: "seekToFrameIndex", frameIndex: Number(frameIndex) });
  }
  if (calibration !== "unavailable") {
    const ticks = lastTickOfGridIndex(frameIndex, tb, display);
    const pts = ticks === null ? null : ptsFromStart(probe, ticks);
    if (pts !== null) {
      return command({ kind: "seekToPts", pts });
    }
  }
  // The approximate clock has no ticks. The middle of the nominal frame, which a step on the
  // grid also aims at, lies half an interval from each end of the frame.
  return command({
    kind: "seekApproximate",
    seconds: ((2 * Number(frameIndex) + 1) * rate.d) / (2 * rate.n),
  });
}

/** The plan of an absolute time of `milliseconds` whole milliseconds. */
function planMillisecond(
  milliseconds: bigint,
  snapshot: TimecodeEntrySnapshot,
  probe: ShortcutProbe,
): TimecodeEntryPlan {
  const seconds =
    milliseconds > MAX_SAFE ? Number.POSITIVE_INFINITY : Number(milliseconds) / 1000;
  const pastEnd = planPastEnd(seconds, snapshot, probe);
  if (pastEnd !== undefined) {
    return pastEnd;
  }
  if (milliseconds > MAX_SAFE) {
    return { ok: false, error: "tooLarge" };
  }

  const tb = probe.videoTimeBase;
  const onScreen = screenTicks(snapshot.playback, probe);
  if (
    onScreen !== null &&
    elapsedGridIndex(onScreen, tb, MILLISECONDS_TIMECODE_DISPLAY) === milliseconds
  ) {
    return NOTHING;
  }

  if (snapshot.playback.calibrationStatus !== "unavailable") {
    const ticks = lastTickOfGridIndex(milliseconds, tb, MILLISECONDS_TIMECODE_DISPLAY);
    const pts = ticks === null ? null : ptsFromStart(probe, ticks);
    if (ticks !== null && pts !== null) {
      // On the frame grid the frames are known, so a time inside the frame on screen is also a
      // seek to the frame on screen, as a target inside the first frame is at the anchor
      // (ADR 022).
      const rate = getNominalFrameRate(probe);
      if (onScreen !== null && rate !== null && hasExactFrameGrid(probe)) {
        const grid: TimecodeDisplay = { format: "frames", rate, videoTimeBase: tb };
        if (
          elapsedGridIndex(ticks, tb, grid) === elapsedGridIndex(onScreen, tb, grid)
        ) {
          return NOTHING;
        }
      }
      return command({ kind: "seekToPts", pts });
    }
  }
  return command({ kind: "seekApproximate", seconds });
}

/**
 * The whole milliseconds that the display shows now, the base of a relative time. It is the
 * displayed position of ADR 022, rounded as the millisecond display rounds it, and never below 0.
 */
function displayedMilliseconds(
  playback: TimecodeEntrySnapshot["playback"],
  probe: ShortcutProbe,
): bigint {
  const seconds = getDisplayedElapsedSeconds(
    playback,
    probe.videoStartPts,
    probe.videoTimeBase,
  );
  const milliseconds = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  const whole = Math.round(milliseconds);
  return Number.isSafeInteger(whole) ? BigInt(whole) : 0n;
}

/**
 * Returns the store call for a typed time, or an error. See the module comment for the rules.
 *
 * @param entry The parsed entry (`parseTimecodeEntry`).
 * @param snapshot One read of the media and playback state, and the display of the source.
 */
export function planTimecodeEntrySeek(
  entry: TimecodeEntry,
  snapshot: TimecodeEntrySnapshot,
): TimecodeEntryPlan {
  const { probe, playback, display } = snapshot;
  if (probe === null || !isSourceActive(true, playback.isAttached, playback.isReady)) {
    return NOTHING;
  }

  switch (entry.kind) {
    case "frameStep": {
      // The parser gives a step in frames only in the frame format, which has a nominal rate.
      if (getNominalFrameRate(probe) === null) {
        return NOTHING;
      }
      const limit = BigInt(MAX_TYPED_STEP_FRAMES);
      const clamped =
        entry.frames > limit ? limit : entry.frames < -limit ? -limit : entry.frames;
      const frames = Number(clamped);
      return frames === 0 ? NOTHING : command({ kind: "seekNominal", frames });
    }
    case "frame":
      // The parser gives a frame only in the frame format, which carries the rate.
      return display.format === "frames"
        ? planFrame(entry.frameIndex, display, snapshot, probe)
        : NOTHING;
    case "millisecond":
      return planMillisecond(entry.milliseconds, snapshot, probe);
    case "millisecondStep": {
      const target = displayedMilliseconds(playback, probe) + entry.milliseconds;
      // A step back past the start stops at the start.
      return planMillisecond(target < 0n ? 0n : target, snapshot, probe);
    }
  }
}

/** Why a typed time stays in the field: a parse error or a plan error. */
export type TimecodeEntryErrorCode =
  Exclude<TimecodeEntryError, "empty"> | TimecodeEntryPlanError;

/** What Enter in the field does. */
export type TimecodeEntryOutcome =
  /** Close the field and keep the position, as Escape does. */
  | { readonly kind: "cancel" }
  /** Keep the field open and show the error. */
  | { readonly kind: "error"; readonly error: TimecodeEntryErrorCode }
  /** Close the field and run the command, when there is one. */
  | { readonly kind: "run"; readonly command: TimecodeEntryCommand | null };

/**
 * Reads the text of the field and plans its seek. An empty field closes as Escape does, because
 * there is no time to go to, and the editors keep the old value then.
 *
 * @param text The text of the field.
 * @param snapshot One read of the media and playback state, and the display of the source.
 */
export function resolveTimecodeEntry(
  text: string,
  snapshot: TimecodeEntrySnapshot,
): TimecodeEntryOutcome {
  const parsed = parseTimecodeEntry(text, snapshot.display);
  if (!parsed.ok) {
    return parsed.error === "empty"
      ? { kind: "cancel" }
      : { kind: "error", error: parsed.error };
  }
  const plan = planTimecodeEntrySeek(parsed.entry, snapshot);
  return plan.ok
    ? { kind: "run", command: plan.command }
    : { kind: "error", error: plan.error };
}

/** The store actions that a typed time calls. */
export type TimecodeEntryActions = Pick<
  PlaybackActions,
  "seekNominal" | "seekToFrameIndex" | "seekToPts" | "seekApproximate"
>;

/** Performs one planned store call. */
export function runTimecodeEntryCommand(
  entryCommand: TimecodeEntryCommand,
  actions: TimecodeEntryActions,
): void {
  switch (entryCommand.kind) {
    case "seekNominal":
      actions.seekNominal(entryCommand.frames);
      return;
    case "seekToFrameIndex":
      actions.seekToFrameIndex(entryCommand.frameIndex);
      return;
    case "seekToPts":
      actions.seekToPts(entryCommand.pts);
      return;
    case "seekApproximate":
      actions.seekApproximate(entryCommand.seconds, entryCommand.options);
      return;
  }
}
