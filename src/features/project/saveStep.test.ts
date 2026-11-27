import { describe, expect, it, vi } from "vitest";
import { createAudioOverrideStore } from "@/features/media/audioOverrideStore";
import { createMediaStore } from "@/features/media/store";
import type { ImportMediaResult } from "@/features/media/types";
import type { SequenceSource } from "@/features/timeline/sequence";
import { createTimelineStore } from "@/features/timeline/store";
import type { Project, Pts } from "@/types/project";
import { projectContentOf } from "./document";
import { flush, held, mediaAt } from "./projectTestSupport";
import { createProjectSaveStep, type ProjectSaveDependencies } from "./saveStep";
import {
  createProjectStore,
  installProjectSequenceRule,
  isProjectModified,
} from "./store";
import { ProjectCommandError, type SaveProjectResult } from "./types";

const pts = (value: string) => value as Pts;

function sequenceSourceOf(id: string, media: ImportMediaResult): SequenceSource {
  return {
    id,
    videoTimeBase: media.probe.videoTimeBase,
    videoStartPts: media.probe.videoStartPts,
    videoEndPts: media.probe.videoEndPts,
    videoDurationTicks: media.probe.videoDurationTicks,
    approximateDurationSeconds: media.probe.approximateDurationSeconds,
  };
}

const CLIP = mediaAt("/media/clip.mp4");

/** A session with one clip of `/media/clip.mp4` and one segment, and a save step over it. */
function harness(overrides: Partial<ProjectSaveDependencies> = {}) {
  let next = 0;
  const timeline = createTimelineStore({ generateId: () => `g-${++next}` });
  const media = createMediaStore(
    {},
    { sources: { a: CLIP }, media: CLIP, status: "ready" },
  );
  const audioOverrides = createAudioOverrideStore();
  const project = createProjectStore({
    sequenceHasClips: () => timeline.getState().clips.length > 0,
  });
  installProjectSequenceRule(project, timeline);
  timeline.getState().loadSequence(
    [{ id: "c1", sourceId: "a" }],
    [sequenceSourceOf("a", CLIP)],
    [
      {
        id: "s1",
        inClipId: "c1",
        inPts: pts("1000"),
        outClipId: "c1",
        outPts: pts("2000"),
      },
    ],
  );
  const showSaveDialog = vi.fn(
    (_name: string, _directory: string | null): Promise<string | null> =>
      Promise.resolve("/out/cut.qcproj"),
  );
  const saveProject = vi.fn(
    (path: string, _project: Project): Promise<SaveProjectResult> =>
      Promise.resolve({
        path: path.startsWith("/canonical") ? path : `/canonical${path}`,
      }),
  );
  const step = createProjectSaveStep({
    showSaveDialog,
    saveProject,
    timeline,
    media,
    audioOverrides,
    project,
    ...overrides,
  });
  const content = () =>
    projectContentOf(timeline.getState(), audioOverrides.getState().overrides);
  return {
    timeline,
    media,
    audioOverrides,
    project,
    showSaveDialog,
    saveProject,
    step,
    content,
  };
}

describe("the save step", () => {
  it("asks for a file for a project with no file, and binds the written file", async () => {
    const h = harness();
    const result = await h.step.save("save");
    expect(h.showSaveDialog).toHaveBeenCalledWith("clip.qcproj", "/media");
    expect(h.saveProject).toHaveBeenCalledTimes(1);
    const [path, document] = h.saveProject.mock.calls[0];
    expect(path).toBe("/out/cut.qcproj");
    expect(document.clips).toEqual([{ id: "c1", sourceId: "a" }]);
    expect(document.sources[0]?.path).toBe("/media/clip.mp4");
    expect(result).toEqual({
      status: "saved",
      path: "/canonical/out/cut.qcproj",
      bound: true,
    });
    expect(h.project.getState().file).toEqual({
      path: "/canonical/out/cut.qcproj",
      name: "cut.qcproj",
    });
    expect(isProjectModified(h.project.getState(), h.content())).toBe(false);
  });

  it("writes the file of the project with Save, and asks with Save As", async () => {
    const h = harness();
    await h.step.save("save");
    h.showSaveDialog.mockClear();
    h.saveProject.mockClear();

    await h.step.save("save");
    expect(h.showSaveDialog).not.toHaveBeenCalled();
    expect(h.saveProject.mock.calls[0]?.[0]).toBe("/canonical/out/cut.qcproj");

    h.showSaveDialog.mockResolvedValueOnce("/other/copy.qcproj");
    const result = await h.step.save("saveAs");
    // Save As proposes the name and the directory of the file of the project.
    expect(h.showSaveDialog).toHaveBeenCalledWith("cut.qcproj", "/canonical/out");
    expect(result).toMatchObject({
      status: "saved",
      path: "/canonical/other/copy.qcproj",
    });
    expect(h.project.getState().file?.name).toBe("copy.qcproj");
  });

  it("proposes the name and the directory of the proposed path of a restored project", async () => {
    const h = harness();
    h.project.getState().completeRestore({ proposedPath: "/old/work/Stream.qcproj" });
    for (const mode of ["save", "saveAs"] as const) {
      h.showSaveDialog.mockResolvedValueOnce(null);
      await expect(h.step.save(mode)).resolves.toEqual({ status: "canceled" });
      expect(h.showSaveDialog).toHaveBeenLastCalledWith("Stream.qcproj", "/old/work");
    }
    expect(h.saveProject).not.toHaveBeenCalled();
    // The save gives the project a file, and the proposed path goes.
    await h.step.save("save");
    expect(h.project.getState().file?.path).toBe("/canonical/out/cut.qcproj");
    expect(h.project.getState().proposedPath).toBeNull();
    h.showSaveDialog.mockClear();
    await h.step.save("saveAs");
    expect(h.showSaveDialog).toHaveBeenCalledWith("cut.qcproj", "/canonical/out");
  });

  it("proposes the name of the first clip for a restored project with no proposed path", async () => {
    const h = harness();
    h.project.getState().completeRestore({ proposedPath: null });
    h.showSaveDialog.mockResolvedValueOnce(null);
    await h.step.save("save");
    expect(h.showSaveDialog).toHaveBeenCalledWith("clip.qcproj", "/media");
  });

  it("proposes a Windows proposed path with its own separator", async () => {
    const h = harness();
    h.project.getState().completeRestore({ proposedPath: "C:\\Cuts\\Stream.qcproj" });
    h.showSaveDialog.mockResolvedValueOnce(null);
    await h.step.save("saveAs");
    expect(h.showSaveDialog).toHaveBeenCalledWith("Stream.qcproj", "C:\\Cuts");
  });

  it("writes nothing for a canceled dialog and for a name that does not end in .qcproj", async () => {
    const h = harness();
    h.showSaveDialog.mockResolvedValueOnce(null);
    await expect(h.step.save("saveAs")).resolves.toEqual({ status: "canceled" });
    for (const path of ["/out/cut.mp4", "/out/cut.qcproj.txt"]) {
      h.showSaveDialog.mockResolvedValueOnce(path);
      await expect(h.step.save("saveAs")).resolves.toEqual({
        status: "failed",
        error: { kind: "invalidName", path },
      });
    }
    h.showSaveDialog.mockResolvedValueOnce("/out/CUT.QCPROJ");
    await expect(h.step.save("saveAs")).resolves.toMatchObject({ status: "saved" });
    expect(h.saveProject).toHaveBeenCalledTimes(1);
  });

  it("reports a dialog that failed", async () => {
    const h = harness();
    const failure = new Error("dialog");
    h.showSaveDialog.mockRejectedValueOnce(failure);
    await expect(h.step.save("save")).resolves.toEqual({
      status: "failed",
      error: { kind: "dialogFailed", error: failure },
    });
  });

  it("writes nothing for a document that an open would refuse, and names the file", async () => {
    const h = harness();
    const bare = mediaAt(
      "/media/bare.ts",
      {},
      {
        videoEndPts: null,
        videoDurationTicks: null,
        approximateDurationSeconds: null,
      },
    );
    h.media.setState({ sources: { a: CLIP, x: bare } });
    // The length of the web view lays the bare clip out next to another clip.
    h.timeline.getState().clearTimeline();
    h.timeline
      .getState()
      .insertClips(0, [{ id: "cx", sourceId: "x" }], [sequenceSourceOf("x", bare)]);
    h.timeline.getState().setBrowserDuration("x", 5);
    expect(
      h.timeline
        .getState()
        .insertClips(1, [{ id: "c2", sourceId: "a" }], [sequenceSourceOf("a", CLIP)]),
    ).toBe(true);

    const result = await h.step.save("save");
    expect(result).toEqual({
      status: "failed",
      error: {
        kind: "documentRefused",
        problem: { kind: "clipExtentUnknown", clipId: "cx", sourceId: "x" },
        fileName: "bare.ts",
      },
    });
    expect(h.saveProject).not.toHaveBeenCalled();
  });

  it("writes nothing with no clip", async () => {
    const h = harness();
    h.timeline.getState().clearTimeline();
    await expect(h.step.save("save")).resolves.toEqual({
      status: "failed",
      error: { kind: "noClip" },
    });
    expect(h.showSaveDialog).not.toHaveBeenCalled();
  });

  it("leaves the project as it was when the write fails", async () => {
    const h = harness();
    h.saveProject.mockRejectedValueOnce({ code: "writeFailed", detail: "disk full" });
    const result = await h.step.save("save");
    expect(result.status).toBe("failed");
    if (result.status === "failed" && result.error.kind === "writeFailed") {
      expect(result.error.error).toBeInstanceOf(ProjectCommandError);
      expect(result.error.error.code).toBe("writeFailed");
    } else {
      throw new Error("expected a write failure");
    }
    expect(h.project.getState().file).toBeNull();
  });

  it("writes the file and does not bind it when the identity changed during the write", async () => {
    const h = harness();
    const write = held<SaveProjectResult>();
    h.saveProject.mockReturnValueOnce(write.promise);
    const step = h.step.save("save");
    await flush();
    expect(h.saveProject).toHaveBeenCalled();
    // The sequence goes empty and comes back.
    h.timeline.getState().clearTimeline();
    h.timeline.getState().undo();
    write.resolve({ path: "/canonical/out/cut.qcproj" });
    await expect(step).resolves.toEqual({
      status: "saved",
      path: "/canonical/out/cut.qcproj",
      bound: false,
    });
    expect(h.project.getState().file).toBeNull();
  });

  it("binds the content that it read, so an edit during the write leaves the project modified", async () => {
    const h = harness();
    const before = h.content();
    const write = held<SaveProjectResult>();
    h.saveProject.mockReturnValueOnce(write.promise);
    const step = h.step.save("save");
    await flush();
    h.timeline.getState().renameSegment("s1", "Later");
    write.resolve({ path: "/canonical/out/cut.qcproj" });
    await step;
    // The document and the saved content are both the state from before the edit.
    const document = h.saveProject.mock.calls[0]?.[1];
    expect(document?.segments).toEqual([
      { id: "s1", inClipId: "c1", inPts: "1000", outClipId: "c1", outPts: "2000" },
    ]);
    expect(h.project.getState().file).not.toBeNull();
    expect(h.project.getState().savedContent).toBe(before);
    expect(h.content()).not.toBe(before);
    expect(isProjectModified(h.project.getState(), h.content())).toBe(true);
  });

  it("does nothing for a second request while a step runs, and lets a caller wait for it", async () => {
    const h = harness();
    const dialog = held<string | null>();
    h.showSaveDialog.mockReturnValueOnce(dialog.promise);
    const first = h.step.save("save");
    expect(h.step.isRunning()).toBe(true);
    await expect(h.step.save("save")).resolves.toEqual({ status: "busy" });
    await expect(h.step.save("saveAs")).resolves.toEqual({ status: "busy" });

    let idle = false;
    const waited = h.step.whenIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    dialog.resolve("/out/cut.qcproj");
    await first;
    await waited;
    expect(idle).toBe(true);
    expect(h.step.isRunning()).toBe(false);
    expect(h.saveProject).toHaveBeenCalledTimes(1);
    // With no step, the wait ends at once, and a new step runs.
    await h.step.whenIdle();
    await expect(h.step.save("save")).resolves.toMatchObject({ status: "saved" });
  });
});
