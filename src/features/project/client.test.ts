import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS } from "@/lib/ipc";
import type { Project } from "@/types/project";
import { loadProject, saveProject } from "./client";
import { ProjectCommandError } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function createProject(): Project {
  return {
    schemaVersion: 1,
    sources: [],
    clips: [],
    segments: [],
  };
}

describe("project clients", () => {
  it("names the two commands as the Rust registration does", () => {
    expect(BACKEND_COMMANDS.LOAD_PROJECT).toBe("load_project");
    expect(BACKEND_COMMANDS.SAVE_PROJECT).toBe("save_project");
  });

  it("loads a project with the path and validates the answer", async () => {
    const answer = {
      path: "/Users/x/cut.qcproj",
      project: createProject(),
      candidates: [],
    };
    const mockInvoke = vi.fn().mockResolvedValue(answer);

    const result = await loadProject("/Users/x/cut.qcproj", { invoke: mockInvoke });

    expect(mockInvoke).toHaveBeenCalledWith("load_project", {
      path: "/Users/x/cut.qcproj",
    });
    expect(result).toEqual(answer);
  });

  it("saves a project with the path and the document, and answers the canonical path", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({ path: "/private/x/cut.qcproj" });
    const project = createProject();

    const result = await saveProject("/x/cut.qcproj", project, { invoke: mockInvoke });

    expect(mockInvoke).toHaveBeenCalledWith("save_project", {
      path: "/x/cut.qcproj",
      project,
    });
    expect(result).toEqual({ path: "/private/x/cut.qcproj" });
  });

  it("sends no relPath: the backend writes it (ADR 072)", async () => {
    const mockInvoke = vi.fn().mockResolvedValue({ path: "/x/cut.qcproj" });
    const source = {
      id: "s1",
      path: "/x/clips/a.mp4",
      relPath: "clips/a.mp4",
      size: 10,
      mtime: 1,
      videoStreamIndex: 0,
      videoTimeBase: { n: 1, d: 1000 },
      videoStartPts: null,
      videoEndPts: null,
      videoDurationTicks: null,
      approximateDurationSeconds: null,
      avgFrameRate: null,
      rFrameRate: null,
      reportedFrameCount: null,
      audioStreamIndex: 1,
    };
    const project: Project = { ...createProject(), sources: [source] };

    await saveProject("/x/cut.qcproj", project, { invoke: mockInvoke });

    const payload = mockInvoke.mock.calls[0][1] as { project: Project };
    const sent = payload.project.sources[0];
    expect("relPath" in sent).toBe(false);
    const { relPath: _relPath, ...expected } = source;
    expect(sent).toEqual(expected);
    // The document of the caller does not change.
    expect(project.sources[0].relPath).toBe("clips/a.mp4");
  });

  it("normalizes a backend rejection into a ProjectCommandError with its facts", async () => {
    const mockInvoke = vi.fn().mockRejectedValue({
      code: "invalidProject",
      field: "sources[0].relPath",
    });

    const promise = loadProject("/x/cut.qcproj", { invoke: mockInvoke });
    await expect(promise).rejects.toBeInstanceOf(ProjectCommandError);
    await expect(promise).rejects.toMatchObject({
      code: "invalidProject",
      field: "sources[0].relPath",
    });

    mockInvoke.mockRejectedValueOnce({ code: "invalidPath" });
    await expect(
      saveProject("/x/cut.json", createProject(), { invoke: mockInvoke }),
    ).rejects.toMatchObject({ code: "invalidPath" });
  });

  it("refuses an answer of the wrong shape rather than casting it", async () => {
    const load = vi.fn().mockResolvedValue({
      path: "/x/cut.qcproj",
      project: { ...createProject(), renderSettings: {} },
      candidates: [],
    });
    await expect(loadProject("/x/cut.qcproj", { invoke: load })).rejects.toMatchObject({
      code: "unknown",
    });

    const save = vi.fn().mockResolvedValue(undefined);
    const promise = saveProject("/x/cut.qcproj", createProject(), { invoke: save });
    await expect(promise).rejects.toBeInstanceOf(ProjectCommandError);
    await expect(promise).rejects.toMatchObject({ code: "unknown" });
  });
});
