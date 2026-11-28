/**
 * The rules of the Play button and of the Play Program button of the transport bar while a
 * program play can run (ADR 074).
 *
 * - A run is shown on the Play Program button: it is pressed from the start of the run to its
 *   end, also between two parts and while a clip loads. Its state line says which part plays.
 * - While a run exists, the Play button is available whatever the state of the element is, and
 *   it has the label of Pause. A click on it, or on the Play Program button with or without
 *   `Shift`, ends the run, and the playback stays paused.
 *
 * The module has no React, DOM or store dependency, so the tests need no document.
 */

import type { ShortcutCommand } from "@/components/layout/shortcutCommands";
import type { ProgramRunState } from "@/features/sequence/playback";

/** The catalog key of the state line of a run. */
export type ProgramRunStateKey =
  "transport.state.playingProgram" | "transport.state.playingJoins";

/** The state line of a run: its catalog key and its values. */
export interface ProgramRunStatus {
  readonly key: ProgramRunStateKey;
  /** The number of the part that plays or loads, from 1. */
  readonly index: number;
  /** The count of the parts of the list of the run. */
  readonly count: number;
}

/** The state line of the run that exists, or null with no run. */
export function presentProgramRunStatus(
  run: ProgramRunState | null,
): ProgramRunStatus | null {
  if (run === null) {
    return null;
  }
  return {
    key:
      run.action === "program"
        ? "transport.state.playingProgram"
        : "transport.state.playingJoins",
    index: run.part,
    count: run.count,
  };
}

/** What the Play button shows. */
export interface PlayButtonView {
  /** True when the button shows the glyph and the label of Pause. */
  readonly showsPause: boolean;
  readonly disabled: boolean;
}

/**
 * The Play button: Pause while the element plays or while a run exists, and available while a
 * run exists, whatever the state of the element is.
 *
 * @param isPlaying True while the playback store reports a playback.
 * @param canTogglePlayback The condition of Play with no run (`canTogglePlayback`).
 * @param hasProgramRun True while a program play exists.
 */
export function presentPlayButton(
  isPlaying: boolean,
  canTogglePlayback: boolean,
  hasProgramRun: boolean,
): PlayButtonView {
  return {
    showsPause: isPlaying || hasProgramRun,
    disabled: !canTogglePlayback && !hasProgramRun,
  };
}

/**
 * True when the Play Program button is disabled: a pointer holds a gesture that seeks
 * (`pointerSeekHold`), also while a run exists, or neither Play Program nor Play Joins is
 * available (`isProgramPlayAvailable`) and no run exists.
 */
export function isPlayProgramButtonDisabled(
  isProgramPlayAvailable: boolean,
  hasProgramRun: boolean,
  isPointerSeekHeld: boolean,
): boolean {
  return isPointerSeekHeld || (!isProgramPlayAvailable && !hasProgramRun);
}

/** The calls of a click on the Play button. */
export interface PlayButtonActions {
  /**
   * True while an overlay of the page owns the commands (`isPageOverlayOpen`): a dialog, a menu,
   * or a native context menu, also while it is on its way.
   */
  readonly isOverlayOpen: () => boolean;
  /** Ends the run that exists, and returns true when a run ended. */
  readonly endProgramPlay: () => boolean;
  readonly togglePlayback: () => void;
}

/**
 * A click on the Play button. Under an open overlay it does nothing, also while a run exists: a
 * menu that opens does not end a run. Otherwise it ends a run and does nothing more, or else it
 * plays or pauses.
 */
export function pressPlayButton(actions: PlayButtonActions): void {
  if (actions.isOverlayOpen() || actions.endProgramPlay()) {
    return;
  }
  actions.togglePlayback();
}

/** The calls of a click on the Play Program button. */
export interface PlayProgramButtonActions {
  /** True while an overlay of the page owns the commands (`isPageOverlayOpen`). */
  readonly isOverlayOpen: () => boolean;
  /** True while a pointer holds a gesture that seeks (`pointerSeekHold`, ADR 074). */
  readonly isPointerSeekHeld: () => boolean;
  /** Ends the run that exists, and returns true when a run ended. */
  readonly endProgramPlay: () => boolean;
  /**
   * Plans the action on the state at the click (`planControlCommand`), or returns null when it
   * runs nothing.
   */
  readonly plan: (action: "playProgram" | "playJoins") => ShortcutCommand | null;
  readonly run: (command: ShortcutCommand) => void;
}

/**
 * A click on the Play Program button. Under an open overlay, and while a pointer holds a
 * gesture that seeks, it does nothing, also while a run exists. While a run exists, the click
 * ends it, with or without `Shift`, and does nothing more. Otherwise a click starts Play
 * Program, and a click with `Shift` starts Play Joins.
 */
export function pressPlayProgramButton(
  shiftKey: boolean,
  actions: PlayProgramButtonActions,
): void {
  if (
    actions.isOverlayOpen() ||
    actions.isPointerSeekHeld() ||
    actions.endProgramPlay()
  ) {
    return;
  }
  const command = actions.plan(shiftKey ? "playJoins" : "playProgram");
  if (command !== null) {
    actions.run(command);
  }
}
