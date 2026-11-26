import { describe, expect, it, vi } from "vitest";
import type { Pts } from "@/types/project";
import type { FrameExportResult } from "./client";
import {
  createFrameExportController,
  frameFileName,
  type FrameExportEffects,
  type FrameExportFacts,
} from "./controller";
import type { FrameExportRequest } from "./types";

const FACTS: FrameExportFacts = {
  sourcePath: "/media/Holiday Trip.mp4",
  sourceFileName: "Holiday Trip.mp4",
  sourceRevision: { size: 4096, mtime: 1_700_000_000 },
  pts: "450450" as Pts,
  displayedTime: "00:01:05.005",
  sessionSourcePaths: ["/media/Holiday Trip.mp4", "/media/b.mov"],
};

/** A promise and the functions that settle it, so a test decides when an effect answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function effects(overrides: Partial<FrameExportEffects> = {}): FrameExportEffects {
  return {
    chooseOutputPath: vi.fn(() => Promise.resolve("/out/cover.png")),
    exportFrame: vi.fn((request: FrameExportRequest): Promise<FrameExportResult> =>
      Promise.resolve({ kind: "done", outputPath: request.outputPath }),
    ),
    ...overrides,
  };
}

describe("frameFileName (ADR 069)", () => {
  it("joins the name of the source without its extension and the time, with - for : and .", () => {
    expect(frameFileName("clip.mp4", "00:01:23.456")).toBe("clip_00-01-23-456.png");
    expect(frameFileName("Holiday Trip.mp4", "00:01:05.005")).toBe(
      "Holiday Trip_00-01-05-005.png",
    );
  });

  it("keeps the frame timecode and the dots of the stem before the extension", () => {
    expect(frameFileName("a.b.mkv", "00:00:10:15")).toBe("a.b_00-00-10-15.png");
    expect(frameFileName("noextension", "-00:00:00.040")).toBe(
      "noextension_-00-00-00-040.png",
    );
  });
});

describe("createFrameExportController (ADR 069)", () => {
  it("offers the name of the record, and sends the recorded facts with the chosen path", async () => {
    const fx = effects();
    const controller = createFrameExportController(fx);
    await controller.start(FACTS);
    expect(fx.chooseOutputPath).toHaveBeenCalledWith("Holiday Trip_00-01-05-005.png");
    expect(fx.exportFrame).toHaveBeenCalledWith({
      sourcePath: "/media/Holiday Trip.mp4",
      sourceRevision: { size: 4096, mtime: 1_700_000_000 },
      pts: "450450",
      sessionSourcePaths: ["/media/Holiday Trip.mp4", "/media/b.mov"],
      outputPath: "/out/cover.png",
    });
    expect(controller.store.getState()).toEqual({
      busy: false,
      notice: { id: 1, kind: "saved", fileName: "cover.png" },
    });
  });

  it("is busy from the start until the command ends, and ignores a second start", async () => {
    const dialog = deferred<string | null>();
    const command = deferred<FrameExportResult>();
    const fx = effects({
      chooseOutputPath: vi.fn(() => dialog.promise),
      exportFrame: vi.fn(() => command.promise),
    });
    const controller = createFrameExportController(fx);

    const first = controller.start(FACTS);
    // Busy before the first await, so a second key press during the dialog finds it busy.
    expect(controller.store.getState().busy).toBe(true);
    await controller.start({ ...FACTS, pts: "1" as Pts });
    expect(fx.chooseOutputPath).toHaveBeenCalledTimes(1);

    dialog.resolve("C:\\out\\frame.png");
    await vi.waitFor(() => expect(fx.exportFrame).toHaveBeenCalledTimes(1));
    expect(controller.store.getState().busy).toBe(true);
    await controller.start(FACTS);
    expect(fx.chooseOutputPath).toHaveBeenCalledTimes(1);

    command.resolve({ kind: "done", outputPath: "C:\\out\\frame.png" });
    await first;
    expect(controller.store.getState()).toEqual({
      busy: false,
      notice: { id: 1, kind: "saved", fileName: "frame.png" },
    });
  });

  it("ends the action at a cancel of the dialog, with no command and no new notice", async () => {
    const fx = effects({ chooseOutputPath: vi.fn(() => Promise.resolve(null)) });
    const controller = createFrameExportController(fx);
    await controller.start(FACTS);
    expect(fx.exportFrame).not.toHaveBeenCalled();
    expect(controller.store.getState()).toEqual({ busy: false, notice: null });
    // The next action can start.
    await controller.start(FACTS);
    expect(fx.chooseOutputPath).toHaveBeenCalledTimes(2);
  });

  it("shows the error and the detail of a failed command", async () => {
    const fx = effects({
      exportFrame: vi.fn(() =>
        Promise.resolve<FrameExportResult>({
          kind: "failed",
          failure: { code: "ffmpegProcessFailed", detail: "Invalid argument" },
        }),
      ),
    });
    const controller = createFrameExportController(fx);
    await controller.start(FACTS);
    expect(controller.store.getState()).toEqual({
      busy: false,
      notice: {
        id: 1,
        kind: "failed",
        code: "ffmpegProcessFailed",
        detail: "Invalid argument",
      },
    });
  });

  it("reports a dialog that failed, and an effect that rejected, and ends the action", async () => {
    const dialogFails = createFrameExportController(
      effects({
        chooseOutputPath: vi.fn(() => Promise.reject(new Error("no window"))),
      }),
    );
    await dialogFails.start(FACTS);
    expect(dialogFails.store.getState()).toEqual({
      busy: false,
      notice: { id: 1, kind: "failed", code: "dialogFailed", detail: null },
    });

    const commandRejects = createFrameExportController(
      effects({ exportFrame: vi.fn(() => Promise.reject(new Error("bug"))) }),
    );
    await commandRejects.start(FACTS);
    expect(commandRejects.store.getState()).toEqual({
      busy: false,
      notice: { id: 1, kind: "failed", code: "unknown", detail: null },
    });
  });

  it("keeps a failure until the plan accepts the action again, and removes it at that moment", async () => {
    const dialog = deferred<string | null>();
    let chooser: () => Promise<string | null> = () => Promise.resolve("/out/cover.png");
    let answer: FrameExportResult = {
      kind: "failed",
      failure: { code: "noFrame", detail: "no frame" },
    };
    const controller = createFrameExportController(
      effects({
        chooseOutputPath: vi.fn(() => chooser()),
        exportFrame: vi.fn(() => Promise.resolve(answer)),
      }),
    );
    await controller.start(FACTS);
    expect(controller.store.getState().notice).toMatchObject({
      id: 1,
      kind: "failed",
      code: "noFrame",
    });

    // The next action is accepted: the failure goes at once, before the dialog answers.
    chooser = () => dialog.promise;
    answer = { kind: "done", outputPath: "/out/cover.png" };
    const second = controller.start(FACTS);
    expect(controller.store.getState()).toEqual({ busy: true, notice: null });
    dialog.resolve("/out/cover.png");
    await second;
    expect(controller.store.getState().notice).toMatchObject({ id: 2, kind: "saved" });

    // A late dismiss of the first notice leaves the second one.
    controller.dismissNotice(1);
    expect(controller.store.getState().notice).toMatchObject({ id: 2 });
    controller.dismissNotice(2);
    expect(controller.store.getState().notice).toBeNull();
  });

  it("changes nothing at a start that finds the action in progress", async () => {
    // A key press that the plan refuses never reaches the controller, so it cannot remove the
    // notice. A start while an action runs is refused here, and it changes nothing either.
    const dialog = deferred<string | null>();
    let chooser: () => Promise<string | null> = () => Promise.resolve("/out/a.png");
    const controller = createFrameExportController(
      effects({
        chooseOutputPath: vi.fn(() => chooser()),
        exportFrame: vi.fn(() =>
          Promise.resolve<FrameExportResult>({
            kind: "failed",
            failure: { code: "imageCheckFailed", detail: null },
          }),
        ),
      }),
    );
    await controller.start(FACTS);
    const failure = controller.store.getState().notice;
    expect(failure).toMatchObject({ kind: "failed" });
    chooser = () => dialog.promise;
    const running = controller.start(FACTS);
    expect(controller.store.getState().notice).toBeNull();
    // A second start during that action changes nothing.
    await controller.start(FACTS);
    expect(controller.store.getState()).toEqual({ busy: true, notice: null });
    dialog.resolve(null);
    await running;
  });

  it("removes the notice of the action before when the dialog of the next one is canceled", async () => {
    let chooser: () => Promise<string | null> = () => Promise.resolve("/out/a.png");
    const controller = createFrameExportController(
      effects({
        chooseOutputPath: vi.fn(() => chooser()),
        exportFrame: vi.fn(() =>
          Promise.resolve<FrameExportResult>({
            kind: "failed",
            failure: { code: "noFrame", detail: null },
          }),
        ),
      }),
    );
    await controller.start(FACTS);
    expect(controller.store.getState().notice).not.toBeNull();
    chooser = () => Promise.resolve(null);
    await controller.start(FACTS);
    expect(controller.store.getState()).toEqual({ busy: false, notice: null });
  });
});
