import { describe, expect, it } from "vitest";
import {
  classifyDroppedPaths,
  resolveFileDropEvent,
  type DroppedPathsClassification,
} from "./fileDropPresenter";

describe("classifyDroppedPaths", () => {
  it("opens one supported video", () => {
    expect(classifyDroppedPaths(["/media/clip.mp4"])).toEqual({
      kind: "open",
      path: "/media/clip.mp4",
      extraIgnored: false,
    });
  });

  it("opens a supported video in any letter case and on a Windows path", () => {
    expect(classifyDroppedPaths(["C:\\Videos\\CLIP.MOV"])).toEqual({
      kind: "open",
      path: "C:\\Videos\\CLIP.MOV",
      extraIgnored: false,
    });
  });

  it("refuses one file with an unsupported extension", () => {
    expect(classifyDroppedPaths(["/media/notes.txt"])).toEqual({ kind: "unsupported" });
  });

  it("refuses a file with no extension", () => {
    expect(classifyDroppedPaths(["/media/clip"])).toEqual({ kind: "unsupported" });
  });

  it("refuses a drag with no paths", () => {
    expect(classifyDroppedPaths([])).toEqual({ kind: "unsupported" });
  });

  it("refuses blank paths", () => {
    expect(classifyDroppedPaths(["", "   "])).toEqual({ kind: "unsupported" });
  });

  it("opens only the first of several videos and reports the others", () => {
    expect(classifyDroppedPaths(["/media/a.mp4", "/media/b.mkv"])).toEqual({
      kind: "open",
      path: "/media/a.mp4",
      extraIgnored: true,
    });
  });

  it("opens the first supported video when an earlier path is not a video", () => {
    expect(classifyDroppedPaths(["/media/notes.txt", "/media/b.webm"])).toEqual({
      kind: "open",
      path: "/media/b.webm",
      extraIgnored: true,
    });
  });

  it("refuses several paths when none is a video", () => {
    expect(classifyDroppedPaths(["/media/a.txt", "/media/b.png"])).toEqual({
      kind: "unsupported",
    });
  });
});

describe("resolveFileDropEvent", () => {
  const video: DroppedPathsClassification = {
    kind: "open",
    path: "/media/clip.mp4",
    extraIgnored: false,
  };

  describe("enter", () => {
    it("classifies the paths and shows the result", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/media/clip.mp4"] },
        null,
        false,
      );
      expect(step.dragged).toEqual(video);
      expect(step.overlay).toBe(step.dragged);
      expect(step.openPath).toBeNull();
    });

    it("shows the unsupported state for a file that is not a video", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/media/notes.txt"] },
        null,
        false,
      );
      expect(step.overlay).toEqual({ kind: "unsupported" });
      expect(step.openPath).toBeNull();
    });

    it("shows nothing while blocked, and still keeps the classification", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/media/clip.mp4"] },
        null,
        true,
      );
      expect(step.overlay).toBeNull();
      expect(step.dragged).toEqual(video);
      expect(step.openPath).toBeNull();
    });
  });

  describe("over", () => {
    it("returns the same classification object, so a state setter does not render", () => {
      const step = resolveFileDropEvent({ type: "over" }, video, false);
      expect(step.overlay).toBe(video);
      expect(step.dragged).toBe(video);
      expect(step.openPath).toBeNull();
    });

    it("shows the overlay once the block ends during the drag", () => {
      const blocked = resolveFileDropEvent(
        { type: "enter", paths: ["/media/clip.mp4"] },
        null,
        true,
      );
      const step = resolveFileDropEvent({ type: "over" }, blocked.dragged, false);
      expect(step.overlay).toEqual(video);
    });

    it("hides the overlay when a block starts during the drag", () => {
      const step = resolveFileDropEvent({ type: "over" }, video, true);
      expect(step.overlay).toBeNull();
      expect(step.dragged).toBe(video);
    });

    it("shows nothing when no enter event came first", () => {
      const step = resolveFileDropEvent({ type: "over" }, null, false);
      expect(step.overlay).toBeNull();
      expect(step.dragged).toBeNull();
    });
  });

  describe("leave", () => {
    it("hides the overlay and forgets the drag", () => {
      const step = resolveFileDropEvent({ type: "leave" }, video, false);
      expect(step).toEqual({ dragged: null, overlay: null, openPath: null });
    });
  });

  describe("drop", () => {
    it("hides the overlay and opens the video", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/clip.mp4"] },
        video,
        false,
      );
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPath: "/media/clip.mp4",
      });
    });

    it("opens only the first video of several", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/notes.txt", "/media/a.mov", "/media/b.mp4"] },
        null,
        false,
      );
      expect(step.openPath).toBe("/media/a.mov");
    });

    it("reads the paths of the drop, not the paths of the enter event", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/other.mkv"] },
        video,
        false,
      );
      expect(step.openPath).toBe("/media/other.mkv");
    });

    it("opens a video even when no enter event came first", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/clip.mp4"] },
        null,
        false,
      );
      expect(step.openPath).toBe("/media/clip.mp4");
    });

    it("opens nothing when no path is a video", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/notes.txt"] },
        { kind: "unsupported" },
        false,
      );
      expect(step).toEqual({ dragged: null, overlay: null, openPath: null });
    });

    it("opens nothing while blocked, and still hides the overlay", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/clip.mp4"] },
        video,
        true,
      );
      expect(step).toEqual({ dragged: null, overlay: null, openPath: null });
    });
  });
});
