import { describe, expect, it } from "vitest";
import { createI18nInstance } from "@/i18n";
import {
  classifyDroppedPaths,
  presentDropOverlay,
  resolveFileDropEvent,
  type DroppedPathsClassification,
} from "./fileDropPresenter";

describe("classifyDroppedPaths", () => {
  it("opens one supported video", () => {
    expect(classifyDroppedPaths(["/media/clip.mp4"])).toEqual({
      kind: "open",
      paths: ["/media/clip.mp4"],
      extraIgnored: false,
    });
  });

  it("opens a supported video in any letter case and on a Windows path", () => {
    expect(classifyDroppedPaths(["C:\\Videos\\CLIP.MOV"])).toEqual({
      kind: "open",
      paths: ["C:\\Videos\\CLIP.MOV"],
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

  it("adds every video of several, in the order of the drop", () => {
    expect(classifyDroppedPaths(["/media/a.mp4", "/media/b.mkv"])).toEqual({
      kind: "open",
      paths: ["/media/a.mp4", "/media/b.mkv"],
      extraIgnored: false,
    });
  });

  it("adds the videos and reports a path that is not a video", () => {
    expect(classifyDroppedPaths(["/media/notes.txt", "/media/b.webm"])).toEqual({
      kind: "open",
      paths: ["/media/b.webm"],
      extraIgnored: true,
    });
  });

  it("refuses several paths when none is a video", () => {
    expect(classifyDroppedPaths(["/media/a.txt", "/media/b.png"])).toEqual({
      kind: "unsupported",
    });
  });

  it("opens one project file alone (ADR 072)", () => {
    expect(classifyDroppedPaths(["/p/cut.QCPROJ"])).toEqual({
      kind: "project",
      path: "/p/cut.QCPROJ",
      extraIgnored: false,
    });
  });

  it("opens the project and reports a file that is no video and no project file", () => {
    expect(classifyDroppedPaths(["/p/notes.txt", "/p/cut.qcproj"])).toEqual({
      kind: "project",
      path: "/p/cut.qcproj",
      extraIgnored: true,
    });
  });

  it("says that a project file opens alone for a project file with a video", () => {
    expect(classifyDroppedPaths(["/p/cut.qcproj", "/media/a.mp4"])).toEqual({
      kind: "projectNotAlone",
    });
  });

  it("says that a project file opens alone for two project files", () => {
    expect(classifyDroppedPaths(["/p/a.qcproj", "/p/b.qcproj"])).toEqual({
      kind: "projectNotAlone",
    });
  });
});

describe("resolveFileDropEvent", () => {
  const video: DroppedPathsClassification = {
    kind: "open",
    paths: ["/media/clip.mp4"],
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
      expect(step.openPaths).toBeNull();
      // A drag of videos shows the junction under the pointer (ADR 052).
      expect(step.atPointer).toBe(true);
    });

    it("shows that the drop opens a project, with no junction mark (ADR 072)", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/p/cut.qcproj"] },
        null,
        false,
      );
      expect(step.overlay).toEqual({
        kind: "project",
        path: "/p/cut.qcproj",
        extraIgnored: false,
      });
      expect(step.atPointer).toBe(false);
    });

    it("shows that a project file opens alone for a mixed drag", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/p/cut.qcproj", "/media/a.mp4"] },
        null,
        false,
      );
      expect(step.overlay).toEqual({ kind: "projectNotAlone" });
      expect(step.atPointer).toBe(false);
    });

    it("shows the unsupported state for a file that is not a video", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/media/notes.txt"] },
        null,
        false,
      );
      expect(step.overlay).toEqual({ kind: "unsupported" });
      expect(step.openPaths).toBeNull();
    });

    it("shows nothing while blocked, and still keeps the classification", () => {
      const step = resolveFileDropEvent(
        { type: "enter", paths: ["/media/clip.mp4"] },
        null,
        true,
      );
      expect(step.overlay).toBeNull();
      expect(step.dragged).toEqual(video);
      expect(step.openPaths).toBeNull();
      expect(step.atPointer).toBe(false);
    });
  });

  describe("over", () => {
    it("returns the same classification object, so a state setter does not render", () => {
      const step = resolveFileDropEvent({ type: "over" }, video, false);
      expect(step.overlay).toBe(video);
      expect(step.dragged).toBe(video);
      expect(step.openPaths).toBeNull();
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
      expect(step.atPointer).toBe(false);
    });

    it("keeps the project drag away from the junctions", () => {
      const project: DroppedPathsClassification = {
        kind: "project",
        path: "/p/cut.qcproj",
        extraIgnored: false,
      };
      const step = resolveFileDropEvent({ type: "over" }, project, false);
      expect(step.overlay).toBe(project);
      expect(step.atPointer).toBe(false);
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
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPaths: null,
        atPointer: false,
      });
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
        openPaths: ["/media/clip.mp4"],
        atPointer: true,
      });
    });

    it("adds every video of several", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/notes.txt", "/media/a.mov", "/media/b.mp4"] },
        null,
        false,
      );
      expect(step.openPaths).toEqual(["/media/a.mov", "/media/b.mp4"]);
    });

    it("reads the paths of the drop, not the paths of the enter event", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/other.mkv"] },
        video,
        false,
      );
      expect(step.openPaths).toEqual(["/media/other.mkv"]);
    });

    it("opens a video even when no enter event came first", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/clip.mp4"] },
        null,
        false,
      );
      expect(step.openPaths).toEqual(["/media/clip.mp4"]);
    });

    it("opens nothing when no path is a video", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/notes.txt"] },
        { kind: "unsupported" },
        false,
      );
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPaths: null,
        atPointer: false,
      });
    });

    it("opens the one project file with no place of the pointer (ADR 072)", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/p/notes.txt", "/p/cut.qcproj"] },
        null,
        false,
      );
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPaths: ["/p/cut.qcproj"],
        atPointer: false,
      });
    });

    it("sends a project file with a video to the request with no index, so the message shows", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/p/cut.qcproj", " ", "/media/a.mp4"] },
        { kind: "projectNotAlone" },
        false,
      );
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPaths: ["/p/cut.qcproj", "/media/a.mp4"],
        atPointer: false,
      });
    });

    it("sends no mixed set while blocked", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/p/cut.qcproj", "/media/a.mp4"] },
        null,
        true,
      );
      expect(step.openPaths).toBeNull();
    });

    it("opens no project file while blocked", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/p/cut.qcproj"] },
        null,
        true,
      );
      expect(step.openPaths).toBeNull();
    });

    it("opens nothing while blocked, and still hides the overlay", () => {
      const step = resolveFileDropEvent(
        { type: "drop", paths: ["/media/clip.mp4"] },
        video,
        true,
      );
      expect(step).toEqual({
        dragged: null,
        overlay: null,
        openPaths: null,
        atPointer: false,
      });
    });
  });
});

describe("presentDropOverlay", () => {
  it("says how many videos the drop adds, and notes the files that it ignores", () => {
    expect(
      presentDropOverlay({
        kind: "open",
        paths: ["/a.mp4", "/b.mp4"],
        extraIgnored: true,
      }),
    ).toEqual({
      message: { key: "fileDrop.release", values: { count: 2 } },
      note: { key: "fileDrop.othersIgnored" },
      accepted: true,
      icon: "video",
    });
  });

  it("says that the drop opens the project (ADR 072)", () => {
    expect(
      presentDropOverlay({
        kind: "project",
        path: "/p/cut.qcproj",
        extraIgnored: false,
      }),
    ).toEqual({
      message: { key: "fileDrop.openProject" },
      note: null,
      accepted: true,
      icon: "project",
    });
    expect(
      presentDropOverlay({ kind: "project", path: "/p/cut.qcproj", extraIgnored: true })
        .note,
    ).toEqual({ key: "fileDrop.projectOthersIgnored" });
  });

  it("says that a project file opens alone, as a drop that opens nothing", () => {
    expect(presentDropOverlay({ kind: "projectNotAlone" })).toEqual({
      message: { key: "fileDrop.projectNotAlone" },
      note: null,
      accepted: false,
      icon: "project",
    });
  });

  it("says that no file is a supported video", () => {
    expect(presentDropOverlay({ kind: "unsupported" })).toEqual({
      message: { key: "fileDrop.unsupported" },
      note: null,
      accepted: false,
      icon: "video",
    });
  });
});

describe("the catalog messages of the drop overlay", () => {
  it("say what a drop of a project file does, in English and in Chinese (ADR 072)", async () => {
    const english = await createI18nInstance({
      initialPreference: "en",
      storage: null,
    });
    const chinese = await createI18nInstance({
      initialPreference: "zh-CN",
      storage: null,
    });
    expect(english.t("fileDrop.openProject")).toBe("Release to open the project");
    expect(english.t("fileDrop.projectNotAlone")).toBe("A project file opens alone");
    expect(english.t("fileDrop.projectOthersIgnored")).toBe(
      "QuipClip opens the project and ignores the other files.",
    );
    expect(chinese.t("fileDrop.openProject")).toBe("松开以打开项目");
    expect(chinese.t("fileDrop.projectNotAlone")).toBe("项目文件只能单独打开");
    expect(chinese.t("fileDrop.projectOthersIgnored")).toBe(
      "只打开项目，其他文件将被忽略。",
    );
  });
});
