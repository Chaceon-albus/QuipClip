import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playbackStore, type PlaybackStoreState } from "@/features/playback";
import type { Pts } from "@/types/project";
import {
  APPROXIMATE_SHORTCUT_SEEK_OPTIONS,
  EXTENT_END_SEEK_OPTIONS,
} from "./shortcutCommands";
import { runShortcutCommand } from "./useKeyboardShortcuts";

type SeekActions = Pick<
  PlaybackStoreState,
  "seekToPts" | "seekToFrameIndex" | "seekApproximate" | "playSegment" | "pause"
>;

// The calls of the real command runner, on the production playback store. The seek actions are
// replaced for each test and put back after it, so no element is needed.
describe("runShortcutCommand", () => {
  let original: SeekActions;
  const seekToPts = vi.fn<PlaybackStoreState["seekToPts"]>();
  const seekToFrameIndex = vi.fn<PlaybackStoreState["seekToFrameIndex"]>();
  const seekApproximate = vi.fn<PlaybackStoreState["seekApproximate"]>();
  const playSegment = vi.fn<PlaybackStoreState["playSegment"]>();
  const pause = vi.fn<PlaybackStoreState["pause"]>();

  beforeEach(() => {
    const state = playbackStore.getState();
    original = {
      seekToPts: state.seekToPts,
      seekToFrameIndex: state.seekToFrameIndex,
      seekApproximate: state.seekApproximate,
      playSegment: state.playSegment,
      pause: state.pause,
    };
    seekToPts.mockReset();
    seekToFrameIndex.mockReset();
    seekApproximate.mockReset();
    playSegment.mockReset();
    pause.mockReset();
    playbackStore.setState({
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

  it("runs End on the frame grid as seekToFrameIndex", () => {
    runShortcutCommand({ kind: "seekToFrameIndex", frameIndex: 249 });
    expect(seekToFrameIndex).toHaveBeenCalledExactlyOnceWith(249);
    expect(seekToPts).not.toHaveBeenCalled();
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
