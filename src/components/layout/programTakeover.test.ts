import { describe, expect, it, vi } from "vitest";
import { resolveShortcut, type ShortcutKeyEvent } from "./keyboardShortcutController";
import {
  PLAYBACK_TAKEOVER_ACTIONS,
  RUN_ENDING_ONLY_ACTIONS,
  takeOverProgramPlay,
} from "./programTakeover";
import { SHORTCUT_ACTIONS, type ShortcutAction } from "./shortcutBindings";

describe("takeOverProgramPlay (ADR 074)", () => {
  it("names the transport actions and the seeks of the key table", () => {
    expect([...PLAYBACK_TAKEOVER_ACTIONS].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect([...RUN_ENDING_ONLY_ACTIONS]).toEqual(["togglePlayback"]);
  });

  it("does not end a run for the zoom, a selection, a mark, an edit or a dialog", () => {
    const endProgramPlay = vi.fn(() => true);
    const others = SHORTCUT_ACTIONS.filter(
      (action) => !PLAYBACK_TAKEOVER_ACTIONS.has(action),
    );
    expect(others).toEqual(
      expect.arrayContaining<ShortcutAction>([
        "zoomIn",
        "zoomOut",
        "zoomToFit",
        "selectAllSegments",
        "markIn",
        "markOut",
        "deleteSegment",
        "renameSegment",
        "exportOrder",
        "export",
        "openSettings",
      ]),
    );
    for (const action of others) {
      expect(takeOverProgramPlay(action, endProgramPlay)).toBe("none");
    }
    expect(endProgramPlay).not.toHaveBeenCalled();
  });

  it("plans on the state that it read when no run ended", () => {
    for (const action of PLAYBACK_TAKEOVER_ACTIONS) {
      expect(takeOverProgramPlay(action, () => false)).toBe("none");
    }
  });

  // ADR 074: the two actions do nothing while a pointer holds a gesture that seeks.
  it("locks Play Program and Play Joins before the takeover while a pointer seeks", () => {
    const endProgramPlay = vi.fn(() => true);
    expect(takeOverProgramPlay("playProgram", endProgramPlay, true)).toBe("locked");
    expect(takeOverProgramPlay("playJoins", endProgramPlay, true)).toBe("locked");
    expect(endProgramPlay).not.toHaveBeenCalled();
    // The other actions of the takeover do not read the fact: Space still ends the run.
    expect(takeOverProgramPlay("togglePlayback", endProgramPlay, true)).toBe("done");
    expect(takeOverProgramPlay("goToStart", endProgramPlay, true)).toBe("ended");
    expect(endProgramPlay).toHaveBeenCalledTimes(2);
    // An action outside the takeover list stays outside it.
    expect(takeOverProgramPlay("zoomIn", endProgramPlay, true)).toBe("none");
  });

  it("takes the key of P and Shift+P with no action while a pointer seeks, as a trim lock does", () => {
    const keyEvent = (
      key: string,
      shiftKey: boolean,
      code: string,
    ): ShortcutKeyEvent => ({
      key,
      code,
      shiftKey,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      isOverlayOpen: false,
      isTooltipOpen: false,
    });
    // The wiring of the window keyboard layer (`useKeyboardShortcuts`), with a run and a held
    // pointer.
    const endProgramPlay = vi.fn(() => true);
    const isActionAvailable = vi.fn(() => true);
    const resolve = (event: ShortcutKeyEvent) =>
      resolveShortcut(event, {
        platform: "windows",
        takeOver: (action) => {
          const takeover = takeOverProgramPlay(action, endProgramPlay, true);
          return takeover === "done" || takeover === "locked";
        },
        isActionAvailable,
      });
    expect(resolve(keyEvent("p", false, "KeyP"))).toEqual({
      claimed: true,
      action: null,
    });
    expect(resolve(keyEvent("P", true, "KeyP"))).toEqual({
      claimed: true,
      action: null,
    });
    expect(endProgramPlay).not.toHaveBeenCalled();
    expect(isActionAvailable).not.toHaveBeenCalled();
    // Space still ends the run.
    expect(resolve(keyEvent(" ", false, "Space"))).toEqual({
      claimed: true,
      action: null,
    });
    expect(endProgramPlay).toHaveBeenCalledOnce();
  });

  it("ends a run with P and Shift+P when no pointer seeks", () => {
    const endProgramPlay = vi.fn(() => true);
    expect(takeOverProgramPlay("playProgram", endProgramPlay, false)).toBe("ended");
    expect(takeOverProgramPlay("playJoins", endProgramPlay)).toBe("ended");
    expect(endProgramPlay).toHaveBeenCalledTimes(2);
  });

  it("ends a run, and Space does nothing more while a seek plans again", () => {
    const endProgramPlay = vi.fn(() => true);
    expect(takeOverProgramPlay("togglePlayback", endProgramPlay)).toBe("done");
    expect(takeOverProgramPlay("goToStart", endProgramPlay)).toBe("ended");
    expect(takeOverProgramPlay("playSegment", endProgramPlay)).toBe("ended");
    // A new request by its key starts the new run by its own rules.
    expect(takeOverProgramPlay("playJoins", endProgramPlay)).toBe("ended");
    expect(endProgramPlay).toHaveBeenCalledTimes(4);
  });
});
