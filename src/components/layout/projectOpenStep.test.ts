import { describe, expect, it, vi } from "vitest";
import { VIDEO_FILE_EXTENSIONS } from "@/features/media/dialog";
import { openProjectStore } from "@/features/project/openStep";
import { isSystemFileDialogOpen, trackSystemFileDialog } from "@/lib/systemFileDialog";
import type { ProjectSaveError, ProjectSaveResult } from "@/features/project/saveStep";
import type { Pts } from "@/types/project";
import {
  createPageOpenStep,
  isOtherDialogOpen,
  isSegmentTrimBusy,
  openLocateFileDialog,
  reportingSaveStep,
  whenTrimSettled,
} from "./projectOpenStep";

describe("isOtherDialogOpen (ADR 072, open step 2)", () => {
  const none = {
    hasPageOverlay: () => false,
    hasSystemFileDialog: () => false,
    isTrimBusy: () => false,
  };

  it("is false while no overlay, no file dialog of the system and no trim is open", () => {
    expect(isOtherDialogOpen(none)).toBe(false);
  });

  it("is true while an overlay of the page is open", () => {
    expect(isOtherDialogOpen({ ...none, hasPageOverlay: () => true })).toBe(true);
  });

  it("is true while a file dialog of the system that the page opened is open", () => {
    expect(isOtherDialogOpen({ ...none, hasSystemFileDialog: () => true })).toBe(true);
  });

  it("is true while a trim of a segment edge is in progress", () => {
    expect(isOtherDialogOpen({ ...none, isTrimBusy: () => true })).toBe(true);
  });

  it("reads the count of the file dialogs of the system by default", async () => {
    let close: (value: null) => void = () => undefined;
    const dialog = trackSystemFileDialog(
      () =>
        new Promise<null>((resolve) => {
          close = resolve;
        }),
    );
    const tests = { hasPageOverlay: () => false, isTrimBusy: () => false };
    expect(isOtherDialogOpen(tests)).toBe(true);
    close(null);
    await dialog;
    expect(isOtherDialogOpen(tests)).toBe(false);
  });

  it("is false in node with no document, no menu, no dialog and no trim", () => {
    expect(isOtherDialogOpen()).toBe(false);
  });
});

describe("isSegmentTrimBusy (ADR 030)", () => {
  /** A trim session in one state: an armed press or a drag (`isLocked`), and its view. */
  function session(locked: boolean, phase: "dragging" | "committing" | null) {
    return {
      isLocked: () => locked,
      getView: () =>
        phase === null
          ? null
          : { segmentId: "s1", edge: "in" as const, fixedPts: "0" as Pts, phase },
    };
  }

  it("is false while no trim runs", () => {
    expect(isSegmentTrimBusy(session(false, null))).toBe(false);
  });

  it("is true while a press on an edge is armed", () => {
    expect(isSegmentTrimBusy(session(true, null))).toBe(true);
  });

  it("is true while a drag trims an edge", () => {
    expect(isSegmentTrimBusy(session(true, "dragging"))).toBe(true);
  });

  it("is true while a released trim waits for the frame that commits it", () => {
    expect(isSegmentTrimBusy(session(false, "committing"))).toBe(true);
  });

  it("reads the trim session of the page by default", () => {
    expect(isSegmentTrimBusy()).toBe(false);
  });
});

describe("reportingSaveStep", () => {
  it("reports a save that failed, and passes each result through", async () => {
    const error: ProjectSaveError = { kind: "invalidName", path: "/p/cut.txt" };
    const results: ProjectSaveResult[] = [
      { status: "failed", error },
      { status: "saved", path: "/p/cut.qcproj", bound: true },
      { status: "canceled" },
    ];
    const report = vi.fn();
    const whenIdle = vi.fn(() => Promise.resolve());
    const step = reportingSaveStep(
      {
        save: vi.fn(() => Promise.resolve(results.shift() as ProjectSaveResult)),
        whenIdle,
      },
      report,
    );

    await expect(step.save("save")).resolves.toEqual({ status: "failed", error });
    await step.save("save");
    await step.save("save");
    await step.whenIdle();

    expect(report.mock.calls).toEqual([[error]]);
    expect(whenIdle).toHaveBeenCalledTimes(1);
  });
});

describe("openLocateFileDialog (ADR 072, The files that the user locates)", () => {
  it("asks for one video file in the directory of the path of the document", async () => {
    const openDialog = vi.fn().mockResolvedValue("/new/a.mp4");

    await expect(
      openLocateFileDialog({
        defaultDirectory: "/old",
        filterName: "Video Files",
        openDialog,
      }),
    ).resolves.toBe("/new/a.mp4");

    expect(openDialog).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      defaultPath: "/old",
      filters: [{ name: "Video Files", extensions: [...VIDEO_FILE_EXTENSIONS] }],
    });
  });

  it("names no directory when the path of the document has none", async () => {
    const openDialog = vi.fn().mockResolvedValue(null);

    await openLocateFileDialog({ defaultDirectory: null, filterName: "V", openDialog });

    expect(openDialog.mock.calls[0]?.[0]).not.toHaveProperty("defaultPath");
  });

  it("answers null after a cancel or a blank answer", async () => {
    for (const answer of [null, "", "  ", ["/a.mp4"]]) {
      await expect(
        openLocateFileDialog({
          defaultDirectory: "/old",
          filterName: "V",
          openDialog: vi.fn().mockResolvedValue(answer),
        }),
      ).resolves.toBeNull();
    }
  });

  it("rejects when the dialog fails, so the open step keeps the row", async () => {
    await expect(
      openLocateFileDialog({
        defaultDirectory: "/old",
        filterName: "V",
        openDialog: vi.fn().mockRejectedValue(new Error("no dialog")),
      }),
    ).rejects.toThrow("no dialog");
    expect(isSystemFileDialogOpen()).toBe(false);
  });

  it("counts as a file dialog of the system while it shows", async () => {
    let answer: (value: string | null) => void = () => undefined;
    const running = openLocateFileDialog({
      defaultDirectory: "/old",
      filterName: "V",
      openDialog: vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            answer = resolve;
          }),
      ) as never,
    });
    expect(isSystemFileDialogOpen()).toBe(true);
    answer(null);
    await running;
    expect(isSystemFileDialogOpen()).toBe(false);
  });
});

describe("createPageOpenStep", () => {
  it("writes to the store that the project dialog shows", () => {
    const step = createPageOpenStep(() => Promise.resolve("cancel"));

    expect(step.store).toBe(openProjectStore);
    expect(step.isOpening()).toBe(false);
  });
});

describe("whenTrimSettled (ADR 030, ADR 072)", () => {
  /** A trim session whose phase the test sets, with the listeners of `subscribe`. */
  function trimSession(phase: "dragging" | "committing" | null) {
    let current = phase;
    const listeners = new Set<() => void>();
    return {
      getView: () =>
        current === null
          ? null
          : {
              segmentId: "s1",
              edge: "out" as const,
              fixedPts: "0" as Pts,
              phase: current,
            },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      set: (next: "dragging" | "committing" | null) => {
        current = next;
        for (const listener of [...listeners]) {
          listener();
        }
      },
      listeners,
    };
  }

  it("waits for nothing while no released trim waits for its commit", () => {
    expect(whenTrimSettled(trimSession(null))).toBeNull();
    // A drag is not a wait for the commit. The test for another dialog reads it.
    expect(whenTrimSettled(trimSession("dragging"))).toBeNull();
  });

  it("settles when the trim that waits committed or gave up, and stops listening", async () => {
    const session = trimSession("committing");
    let settled = false;
    const waiting = whenTrimSettled(session);
    void waiting?.then(() => {
      settled = true;
    });

    session.set("committing");
    await Promise.resolve();
    expect(settled).toBe(false);

    session.set(null);
    await waiting;
    expect(settled).toBe(true);
    expect(session.listeners.size).toBe(0);
  });

  it("reads the trim session of the page by default", () => {
    expect(whenTrimSettled()).toBeNull();
  });
});
