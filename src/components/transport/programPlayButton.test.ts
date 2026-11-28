import { describe, expect, it, vi } from "vitest";
import type { ShortcutCommand } from "@/components/layout/shortcutCommands";
import {
  isPlayProgramButtonDisabled,
  presentPlayButton,
  presentProgramRunStatus,
  pressPlayButton,
  pressPlayProgramButton,
} from "./programPlayButton";

const COMMAND: ShortcutCommand = { kind: "playProgram", action: "program", parts: [] };

const noOverlay = () => false;

describe("the Play and Play Program buttons (ADR 074)", () => {
  it("says which part of which action plays, and nothing with no run", () => {
    expect(presentProgramRunStatus(null)).toBeNull();
    expect(presentProgramRunStatus({ action: "program", part: 2, count: 5 })).toEqual({
      key: "transport.state.playingProgram",
      index: 2,
      count: 5,
    });
    expect(presentProgramRunStatus({ action: "joins", part: 1, count: 3 })).toEqual({
      key: "transport.state.playingJoins",
      index: 1,
      count: 3,
    });
  });

  it("shows Pause on Play, and keeps it available, while a run exists", () => {
    expect(presentPlayButton(false, true, false)).toEqual({
      showsPause: false,
      disabled: false,
    });
    expect(presentPlayButton(true, true, false)).toEqual({
      showsPause: true,
      disabled: false,
    });
    expect(presentPlayButton(false, false, false)).toEqual({
      showsPause: false,
      disabled: true,
    });
    // Between two parts, or while a clip loads, nothing plays and the element can be unready.
    expect(presentPlayButton(false, false, true)).toEqual({
      showsPause: true,
      disabled: false,
    });
  });

  it("disables Play Program with no available action and no run, or while a pointer seeks", () => {
    expect(isPlayProgramButtonDisabled(true, false, false)).toBe(false);
    expect(isPlayProgramButtonDisabled(false, true, false)).toBe(false);
    expect(isPlayProgramButtonDisabled(false, false, false)).toBe(true);
    // A held pointer disables it also while a run exists.
    expect(isPlayProgramButtonDisabled(true, true, true)).toBe(true);
    expect(isPlayProgramButtonDisabled(true, false, true)).toBe(true);
  });

  it("ends a run with a click on Play, and leaves the playback paused", () => {
    const togglePlayback = vi.fn();
    pressPlayButton({
      isOverlayOpen: noOverlay,
      endProgramPlay: () => true,
      togglePlayback,
    });
    expect(togglePlayback).not.toHaveBeenCalled();
    pressPlayButton({
      isOverlayOpen: noOverlay,
      endProgramPlay: () => false,
      togglePlayback,
    });
    expect(togglePlayback).toHaveBeenCalledOnce();
  });

  it("does nothing with a click on Play under an open overlay, with or without a run", () => {
    const endProgramPlay = vi.fn(() => true);
    const togglePlayback = vi.fn();
    pressPlayButton({ isOverlayOpen: () => true, endProgramPlay, togglePlayback });
    expect(endProgramPlay).not.toHaveBeenCalled();
    expect(togglePlayback).not.toHaveBeenCalled();
  });

  it("ends a run with a click on Play Program, with or without Shift", () => {
    for (const shiftKey of [false, true]) {
      const plan = vi.fn(() => COMMAND);
      const run = vi.fn();
      pressPlayProgramButton(shiftKey, {
        isOverlayOpen: noOverlay,
        isPointerSeekHeld: () => false,
        endProgramPlay: () => true,
        plan,
        run,
      });
      expect(plan).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("does nothing with a click on Play Program under an open overlay", () => {
    for (const shiftKey of [false, true]) {
      const endProgramPlay = vi.fn(() => true);
      const plan = vi.fn(() => COMMAND);
      const run = vi.fn();
      pressPlayProgramButton(shiftKey, {
        isOverlayOpen: () => true,
        isPointerSeekHeld: () => false,
        endProgramPlay,
        plan,
        run,
      });
      expect(endProgramPlay).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("starts Play Program with a click, and Play Joins with Shift and a click", () => {
    const run = vi.fn();
    const plan = vi.fn((_action: "playProgram" | "playJoins") => COMMAND);
    const actions = {
      isOverlayOpen: noOverlay,
      isPointerSeekHeld: () => false,
      endProgramPlay: () => false,
      plan,
      run,
    };
    pressPlayProgramButton(false, actions);
    pressPlayProgramButton(true, actions);
    expect(plan.mock.calls).toEqual([["playProgram"], ["playJoins"]]);
    expect(run).toHaveBeenCalledTimes(2);
    // An action that plans nothing runs nothing.
    run.mockClear();
    pressPlayProgramButton(false, { ...actions, plan: () => null });
    expect(run).not.toHaveBeenCalled();
  });

  it("ends nothing and starts nothing while a pointer seeks, also during a run", () => {
    for (const shiftKey of [false, true]) {
      const endProgramPlay = vi.fn(() => true);
      const plan = vi.fn(() => COMMAND);
      const run = vi.fn();
      pressPlayProgramButton(shiftKey, {
        isOverlayOpen: noOverlay,
        isPointerSeekHeld: () => true,
        endProgramPlay,
        plan,
        run,
      });
      expect(endProgramPlay).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("tests the overlay, then the held pointer, then ends the run, then plans", () => {
    const calls: string[] = [];
    pressPlayProgramButton(false, {
      isOverlayOpen: () => {
        calls.push("overlay");
        return false;
      },
      isPointerSeekHeld: () => {
        calls.push("held");
        return false;
      },
      endProgramPlay: () => {
        calls.push("end");
        return false;
      },
      plan: () => {
        calls.push("plan");
        return COMMAND;
      },
      run: () => {
        calls.push("run");
      },
    });
    expect(calls).toEqual(["overlay", "held", "end", "plan", "run"]);
  });
});
