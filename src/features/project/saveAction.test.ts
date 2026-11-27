import { describe, expect, it, vi } from "vitest";
import { isSystemFileDialogOpen } from "@/lib/systemFileDialog";
import { held } from "./projectTestSupport";
import { createSaveProjectAction, openProjectSaveDialog } from "./saveAction";
import { createProjectSaveErrorStore } from "./saveErrorStore";
import type { ProjectSaveError, ProjectSaveResult } from "./saveStep";

type SaveDialog = NonNullable<
  Parameters<typeof openProjectSaveDialog>[0]["saveDialog"]
>;

describe("openProjectSaveDialog", () => {
  it("proposes the name in the directory, with the filter of project files", async () => {
    const saveDialog = vi.fn<SaveDialog>(() => Promise.resolve("/out/cut.qcproj"));

    await expect(
      openProjectSaveDialog({
        defaultName: "clip.qcproj",
        defaultDirectory: "/media",
        filterName: "QuipClip Projects",
        saveDialog,
      }),
    ).resolves.toBe("/out/cut.qcproj");

    expect(saveDialog).toHaveBeenCalledExactlyOnceWith({
      defaultPath: "/media/clip.qcproj",
      filters: [{ name: "QuipClip Projects", extensions: ["qcproj"] }],
    });
  });

  it("proposes the name alone with no directory", async () => {
    const saveDialog = vi.fn<SaveDialog>(() => Promise.resolve(null));
    await openProjectSaveDialog({
      defaultName: "clip.qcproj",
      defaultDirectory: null,
      filterName: "QuipClip Projects",
      saveDialog,
    });
    expect(saveDialog.mock.calls[0]?.[0]).toMatchObject({ defaultPath: "clip.qcproj" });
  });

  it("answers null for a cancel and for an empty path", async () => {
    for (const answer of [null, "", "  "]) {
      await expect(
        openProjectSaveDialog({
          defaultName: "clip.qcproj",
          defaultDirectory: "/media",
          filterName: "QuipClip Projects",
          saveDialog: () => Promise.resolve(answer),
        }),
      ).resolves.toBeNull();
    }
  });

  it("counts the dialog while it shows, also when it fails", async () => {
    const answer = held<string | null>();
    expect(isSystemFileDialogOpen()).toBe(false);
    const open = openProjectSaveDialog({
      defaultName: "clip.qcproj",
      defaultDirectory: "/media",
      filterName: "QuipClip Projects",
      saveDialog: () => answer.promise,
    });
    expect(isSystemFileDialogOpen()).toBe(true);
    answer.resolve("/out/cut.qcproj");
    await open;
    expect(isSystemFileDialogOpen()).toBe(false);

    // A failure of the dialog rejects, and the save step makes it `dialogFailed`.
    const failing = openProjectSaveDialog({
      defaultName: "clip.qcproj",
      defaultDirectory: "/media",
      filterName: "QuipClip Projects",
      saveDialog: () => Promise.reject(new Error("no dialog")),
    });
    expect(isSystemFileDialogOpen()).toBe(true);
    await expect(failing).rejects.toThrow("no dialog");
    expect(isSystemFileDialogOpen()).toBe(false);
  });
});

describe("createSaveProjectAction", () => {
  const ERROR: ProjectSaveError = { kind: "noClip" };

  it("passes the mode to the save step and answers its result", async () => {
    const save = vi.fn((_mode: "save" | "saveAs") =>
      Promise.resolve<ProjectSaveResult>({ status: "canceled" }),
    );
    const reportError = vi.fn();
    const run = createSaveProjectAction({ saveStep: { save }, reportError });

    await expect(run("saveAs")).resolves.toEqual({ status: "canceled" });
    await run("save");

    expect(save.mock.calls).toEqual([["saveAs"], ["save"]]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports only the error of a failed save", async () => {
    const results: ProjectSaveResult[] = [
      { status: "saved", path: "/p/cut.qcproj", bound: true },
      { status: "busy" },
      { status: "canceled" },
      { status: "failed", error: ERROR },
    ];
    const reportError = vi.fn();
    const run = createSaveProjectAction({
      saveStep: { save: () => Promise.resolve(results.shift() ?? { status: "busy" }) },
      reportError,
    });

    for (let index = 0; index < 4; index += 1) {
      await run("save");
    }

    expect(reportError).toHaveBeenCalledExactlyOnceWith(ERROR);
  });
});

describe("the save error store", () => {
  it("shows the last reported error until the dialog closes", () => {
    const store = createProjectSaveErrorStore();
    expect(store.getState().error).toBeNull();

    store.getState().report({ kind: "noClip" });
    store.getState().report({ kind: "invalidName", path: "/p/cut.txt" });
    expect(store.getState().error).toEqual({ kind: "invalidName", path: "/p/cut.txt" });

    store.getState().dismiss();
    expect(store.getState().error).toBeNull();
  });
});
