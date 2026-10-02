import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playbackStore, type PlaybackStoreState } from "@/features/playback";
import type { Pts } from "@/types/project";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  EXTENT_END_SEEK_OPTIONS,
} from "./shortcutCommands";
import { TIME_JUMP_SEEK_OPTIONS } from "./timeJump";
import { runShortcutCommand } from "./useKeyboardShortcuts";

type SeekActions = Pick<
  PlaybackStoreState,
  | "seekNominal"
  | "seekToPts"
  | "seekToFrameIndex"
  | "seekApproximate"
  | "playSegment"
  | "pause"
>;

// The calls of the real command runner, on the production playback store. The seek actions are
// replaced for each test and put back after it, so no element is needed.
describe("runShortcutCommand", () => {
  let original: SeekActions;
  const seekNominal = vi.fn<PlaybackStoreState["seekNominal"]>();
  const seekToPts = vi.fn<PlaybackStoreState["seekToPts"]>();
  const seekToFrameIndex = vi.fn<PlaybackStoreState["seekToFrameIndex"]>();
  const seekApproximate = vi.fn<PlaybackStoreState["seekApproximate"]>();
  const playSegment = vi.fn<PlaybackStoreState["playSegment"]>();
  const pause = vi.fn<PlaybackStoreState["pause"]>();

  beforeEach(() => {
    const state = playbackStore.getState();
    original = {
      seekNominal: state.seekNominal,
      seekToPts: state.seekToPts,
      seekToFrameIndex: state.seekToFrameIndex,
      seekApproximate: state.seekApproximate,
      playSegment: state.playSegment,
      pause: state.pause,
    };
    seekNominal.mockReset();
    seekToPts.mockReset();
    seekToFrameIndex.mockReset();
    seekApproximate.mockReset();
    playSegment.mockReset();
    pause.mockReset();
    playbackStore.setState({
      seekNominal,
      seekToPts,
      seekToFrameIndex,
      seekApproximate,
      playSegment,
      pause,
    });
  });

  afterEach(() => {
    playbackStore.setState(original);
  });

  // ADR 019: a held backward step plays no cue, so the runner passes the key repeat through.
  it("passes held to seekNominal for a key repeat, and not held for a press", () => {
    runShortcutCommand({ kind: "seekNominal", frames: -1, held: true });
    runShortcutCommand({ kind: "seekNominal", frames: -1, held: false });
    runShortcutCommand({ kind: "seekNominal", frames: 10, held: true });
    expect(seekNominal.mock.calls).toEqual([
      [-1, { held: true }],
      [-1, { held: false }],
      [10, { held: true }],
    ]);
  });

  it("runs End on the frame grid as seekToFrameIndex, with no options", () => {
    runShortcutCommand({ kind: "seekToFrameIndex", frameIndex: 249 });
    expect(seekToFrameIndex).toHaveBeenCalledExactlyOnceWith(249, undefined);
    expect(seekToPts).not.toHaveBeenCalled();
  });

  it("passes keepPlaying of a time jump to each seek", () => {
    runShortcutCommand({
      kind: "seekToFrameIndex",
      frameIndex: 125,
      options: TIME_JUMP_SEEK_OPTIONS,
    });
    runShortcutCommand({
      kind: "seekToPts",
      pts: "450000" as Pts,
      options: TIME_JUMP_SEEK_OPTIONS,
    });
    runShortcutCommand({
      kind: "seekApproximate",
      seconds: 6,
      options: TIME_JUMP_SEEK_OPTIONS,
    });
    expect(seekToFrameIndex).toHaveBeenCalledExactlyOnceWith(125, {
      keepPlaying: true,
    });
    expect(seekToPts).toHaveBeenCalledExactlyOnceWith("450000", { keepPlaying: true });
    // A jump on the approximate clock passes its own options, not those of Home and End.
    expect(seekApproximate).toHaveBeenCalledExactlyOnceWith(6, { keepPlaying: true });
  });

  it("passes the options of End off the grid to seekToPts, and none for the other seeks", () => {
    runShortcutCommand({
      kind: "seekToPts",
      pts: "899999" as Pts,
      options: EXTENT_END_SEEK_OPTIONS,
    });
    runShortcutCommand({ kind: "seekToPts", pts: "25" as Pts });
    expect(seekToPts).toHaveBeenNthCalledWith(1, "899999", EXTENT_END_SEEK_OPTIONS);
    expect(seekToPts).toHaveBeenNthCalledWith(2, "25", undefined);
  });

  it("keeps the approximate clock for End and Home on the approximate clock", () => {
    runShortcutCommand({ kind: "seekApproximate", seconds: 10 });
    expect(seekApproximate).toHaveBeenCalledExactlyOnceWith(
      10,
      APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
    );
  });

  it("runs Play Segment with the In and the Out, and a second press as a pause", () => {
    runShortcutCommand({
      kind: "playSegment",
      inPts: "50" as Pts,
      outPts: "100" as Pts,
    });
    expect(playSegment).toHaveBeenCalledExactlyOnceWith("50", "100");
    runShortcutCommand({ kind: "pause" });
    expect(pause).toHaveBeenCalledOnce();
  });
});
