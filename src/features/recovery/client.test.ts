import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS } from "@/lib/ipc";
import type { PersistedSource, Project } from "@/types/project";
import {
  clearRecovery,
  discardRecovery,
  finishRestore,
  listRecoveryOffers,
  readRecovery,
  startRecovery,
  writeRecovery,
} from "./client";
import { RecoveryCommandError } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function sourceWithRelPath(): PersistedSource {
  return {
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
  };
}

function createProject(sources: PersistedSource[] = []): Project {
  return { schemaVersion: 1, sources, clips: [], segments: [] };
}

const WRITTEN = { owner: true, status: "done", current: "written" };

describe("recovery clients", () => {
  it("names the seven commands as the Rust registration does", () => {
    expect(BACKEND_COMMANDS.START_RECOVERY).toBe("start_recovery");
    expect(BACKEND_COMMANDS.LIST_RECOVERY_OFFERS).toBe("list_recovery_offers");
    expect(BACKEND_COMMANDS.WRITE_RECOVERY).toBe("write_recovery");
    expect(BACKEND_COMMANDS.CLEAR_RECOVERY).toBe("clear_recovery");
    expect(BACKEND_COMMANDS.READ_RECOVERY).toBe("read_recovery");
    expect(BACKEND_COMMANDS.DISCARD_RECOVERY).toBe("discard_recovery");
    expect(BACKEND_COMMANDS.FINISH_RESTORE).toBe("finish_restore");
  });

  it("starts the recovery with no argument and answers the token", async () => {
    const invoke = vi.fn().mockResolvedValue({ token: "3" });
    await expect(startRecovery({ invoke })).resolves.toEqual({ token: "3" });
    expect(invoke).toHaveBeenCalledWith("start_recovery");
  });

  it("throws a RecoveryCommandError when the start fails", async () => {
    const rejected = vi.fn().mockRejectedValue("not allowed");
    const promise = startRecovery({ invoke: rejected });
    await expect(promise).rejects.toBeInstanceOf(RecoveryCommandError);
    await expect(promise).rejects.toMatchObject({
      code: "unknown",
      detail: "not allowed",
    });

    const malformed = vi.fn().mockResolvedValue({ token: 3 });
    await expect(startRecovery({ invoke: malformed })).rejects.toMatchObject({
      code: "unknown",
    });
  });

  it("lists the offers with the token", async () => {
    const answer = {
      owner: true,
      status: "done",
      complete: true,
      offers: [{ id: "0123456789abcdef", writtenAtMs: 5, projectPath: null }],
    };
    const invoke = vi.fn().mockResolvedValue(answer);
    await expect(listRecoveryOffers("4", { invoke })).resolves.toEqual(answer);
    expect(invoke).toHaveBeenCalledWith("list_recovery_offers", { token: "4" });
  });

  it("writes the work with no relPath and does not change the document of the caller", async () => {
    const invoke = vi.fn().mockResolvedValue(WRITTEN);
    const project = createProject([sourceWithRelPath()]);

    const result = await writeRecovery(
      "4",
      { projectPath: "/x/cut.qcproj", project },
      { invoke },
    );

    expect(result).toEqual(WRITTEN);
    const [command, payload] = invoke.mock.calls[0] as [
      string,
      { token: string; projectPath: string | null; project: Project },
    ];
    expect(command).toBe("write_recovery");
    expect(payload.token).toBe("4");
    expect(payload.projectPath).toBe("/x/cut.qcproj");
    expect("relPath" in payload.project.sources[0]).toBe(false);
    const { relPath: _relPath, ...expected } = sourceWithRelPath();
    expect(payload.project.sources[0]).toEqual(expected);
    expect(project.sources[0].relPath).toBe("clips/a.mp4");
  });

  it("sends a null path for a project with no path", async () => {
    const invoke = vi.fn().mockResolvedValue(WRITTEN);
    await writeRecovery(
      "4",
      { projectPath: null, project: createProject() },
      { invoke },
    );
    expect(invoke).toHaveBeenCalledWith("write_recovery", {
      token: "4",
      projectPath: null,
      project: createProject(),
    });
  });

  it("clears with the token", async () => {
    const answer = { owner: true, status: "done", current: "nothing" };
    const invoke = vi.fn().mockResolvedValue(answer);
    await expect(clearRecovery("4", { invoke })).resolves.toEqual(answer);
    expect(invoke).toHaveBeenCalledWith("clear_recovery", { token: "4" });
  });

  it("reads and discards one offer by its id", async () => {
    const read = vi.fn().mockResolvedValue({
      owner: true,
      status: "failed",
      error: { code: "offerNotFound" },
    });
    const result = await readRecovery("4", "0123456789abcdef", { invoke: read });
    expect(read).toHaveBeenCalledWith("read_recovery", {
      token: "4",
      id: "0123456789abcdef",
    });
    expect(result.error?.code).toBe("offerNotFound");

    const discard = vi.fn().mockResolvedValue({ owner: true, status: "done" });
    await expect(
      discardRecovery("4", "0123456789abcdef", { invoke: discard }),
    ).resolves.toEqual({ owner: true, status: "done" });
    expect(discard).toHaveBeenCalledWith("discard_recovery", {
      token: "4",
      id: "0123456789abcdef",
    });
  });

  it("finishes a restore with the work, or with null", async () => {
    const invoke = vi.fn().mockResolvedValue(WRITTEN);
    const project = createProject([sourceWithRelPath()]);
    await finishRestore(
      "4",
      "0123456789abcdef",
      { projectPath: "/x/cut.qcproj", project },
      { invoke },
    );
    const payload = invoke.mock.calls[0][1] as {
      state: { projectPath: string; project: Project };
    };
    expect(payload).toMatchObject({ token: "4", id: "0123456789abcdef" });
    expect(payload.state.projectPath).toBe("/x/cut.qcproj");
    expect("relPath" in payload.state.project.sources[0]).toBe(false);

    const nothing = vi
      .fn()
      .mockResolvedValue({ owner: true, status: "done", current: "nothing" });
    await finishRestore("4", "0123456789abcdef", null, { invoke: nothing });
    expect(nothing).toHaveBeenCalledWith("finish_restore", {
      token: "4",
      id: "0123456789abcdef",
      state: null,
    });
    // The argument is always present: the backend refuses a call with no state (ADR 073).
    const sent = nothing.mock.calls[0][1] as Record<string, unknown>;
    expect("state" in sent).toBe(true);
    expect(sent.state).toBeNull();
  });

  it("answers a failed change with no owner and notKnown when the command rejects", async () => {
    const rejected = vi.fn().mockRejectedValue("invalid args `project`");
    for (const call of [
      () =>
        writeRecovery(
          "4",
          { projectPath: null, project: createProject() },
          { invoke: rejected },
        ),
      () => clearRecovery("4", { invoke: rejected }),
      () => finishRestore("4", "0123456789abcdef", null, { invoke: rejected }),
    ]) {
      const result = await call();
      expect(result.owner).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.current).toBe("notKnown");
      expect(result.error).toBeInstanceOf(RecoveryCommandError);
      expect(result.error).toMatchObject({ code: "unknown" });
    }
  });

  it("answers a failure for an answer of the wrong shape rather than casting it", async () => {
    const malformed = vi.fn().mockResolvedValue({ owner: true, status: "done" });
    const change = await clearRecovery("4", { invoke: malformed });
    expect(change).toMatchObject({
      owner: false,
      status: "failed",
      current: "notKnown",
    });
    expect(change.error?.code).toBe("unknown");
    expect(change.error?.detail).toBeUndefined();

    const list = await listRecoveryOffers("4", { invoke: malformed });
    expect(list).toMatchObject({
      owner: false,
      status: "failed",
      complete: false,
      offers: [],
    });

    const read = await readRecovery("4", "0123456789abcdef", { invoke: malformed });
    expect(read).toMatchObject({ owner: false, status: "failed" });
    expect(read.offer).toBeUndefined();

    const discard = await discardRecovery("4", "0123456789abcdef", {
      invoke: vi.fn().mockResolvedValue(null),
    });
    expect(discard).toMatchObject({ owner: false, status: "failed" });
    expect(discard.error?.code).toBe("unknown");
  });
});
