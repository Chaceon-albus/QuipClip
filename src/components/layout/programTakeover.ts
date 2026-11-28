/**
 * The user takes the playback from a program play (ADR 074).
 *
 * While a run of Play Program or Play Joins exists, each caller of a seek action or a transport
 * action of the user first ends the run, and only then plans its action against the state that
 * results. The end of the run pauses the playback. When the action is not available then, the
 * end of the run is all that the press does.
 *
 * - `Space`, the Play button and the Play Program button: the playback stays paused where it
 *   is. The end of the run is all that the press does.
 * - A seek, a step, a jump, Home, End, a move to an edit point, Go to In, Go to Out and Play
 *   Segment: the action then does what it does from a paused playback.
 * - A new Play Program or Play Joins by its key: the new run starts, by its own rules.
 *
 * The other actions do not end a run: a mark, an edit, the zoom, a change of the selection, a
 * dialog. An edit that changes the program ends the run by itself (`programKey`).
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { ShortcutAction } from "./shortcutBindings";
import { POINTER_SEEK_LOCKED_ACTIONS } from "./shortcutCommands";

/** The actions of the key table that take the playback from a program play. */
export const PLAYBACK_TAKEOVER_ACTIONS: ReadonlySet<ShortcutAction> =
  new Set<ShortcutAction>([
    "togglePlayback",
    "playSegment",
    "playProgram",
    "playJoins",
    "stepOrJumpBack",
    "stepOrJumpForward",
    "jumpBackOneSecond",
    "jumpForwardOneSecond",
    "jumpBackThirtySeconds",
    "jumpForwardThirtySeconds",
    "goToPreviousEditPoint",
    "goToNextEditPoint",
    "stepBackOneFrame",
    "stepForwardOneFrame",
    "stepBackTenFrames",
    "stepForwardTenFrames",
    "goToStart",
    "goToEnd",
    "goToSegmentIn",
    "goToSegmentOut",
  ]);

/** The actions whose press only ends a run: the playback then stays paused. */
export const RUN_ENDING_ONLY_ACTIONS: ReadonlySet<ShortcutAction> =
  new Set<ShortcutAction>(["togglePlayback"]);

/**
 * What a takeover did.
 *
 * - `none`: no run ended. The action plans on the state that the caller read.
 * - `ended`: a run ended. The action plans on a new read of the state.
 * - `done`: a run ended, and the press does nothing more.
 * - `locked`: the action is locked while a pointer holds a gesture that seeks
 *   (`POINTER_SEEK_LOCKED_ACTIONS`). No run ended, and the press does nothing.
 */
export type ProgramTakeover = "none" | "ended" | "done" | "locked";

/**
 * Ends a program play before the action of a key or a menu item, when the action takes the
 * playback (`PLAYBACK_TAKEOVER_ACTIONS`).
 *
 * Play Program and Play Joins do nothing while a pointer holds a gesture that seeks (ADR 074):
 * that test comes first, so their press then ends no run either. The takeover of every other
 * action does not read the fact.
 *
 * @param endProgramPlay Ends the run that exists (`SequencePlayback.endProgramPlay`), and
 *   returns true when a run ended.
 * @param isPointerSeekHeld True while a pointer holds a gesture that seeks
 *   (`pointerSeekHold`). Absent means false.
 */
export function takeOverProgramPlay(
  action: ShortcutAction,
  endProgramPlay: () => boolean,
  isPointerSeekHeld = false,
): ProgramTakeover {
  if (isPointerSeekHeld && POINTER_SEEK_LOCKED_ACTIONS.has(action)) {
    return "locked";
  }
  if (!PLAYBACK_TAKEOVER_ACTIONS.has(action) || !endProgramPlay()) {
    return "none";
  }
  return RUN_ENDING_ONLY_ACTIONS.has(action) ? "done" : "ended";
}
