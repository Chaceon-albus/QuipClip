import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  cancelExport as clientCancelExport,
  createExportQueueStore,
  createExportStore,
  exportQueueStore,
  exportStore,
  type ExportRequest,
  type ExportProgressEvent,
  type ExportSubmission,
} from "@/features/export";
import type { DropContentAnswer } from "@/features/project/dropContent";
import {
  createOpenProjectStore,
  createProjectOpenStep,
  type OpenProjectResult,
  type ProjectOpenStep,
} from "@/features/project/openStep";
import { held, mediaAt, type Held } from "@/features/project/projectTestSupport";
import { createMediaStore } from "@/features/media/store";
import { ImportMediaError, type ImportMediaResult } from "@/features/media/types";
import { importClips } from "@/features/sequence/importClips";
import { createTimelineStore } from "@/features/timeline/store";
import type { LoadProjectResult } from "@/features/project/types";
import type { ProjectSaveError, ProjectSaveResult } from "@/features/project/saveStep";
import { projectStore } from "@/features/project/store";
import { settingsWindowDraftStore } from "@/features/settings/settingsWindowDraft";
import type { Pts } from "@/types/project";
import {
  countQueuedExports,
  decideQuit,
  presentQuitPrompt,
  type QuitGuardInput,
} from "./quitGuard";
import {
  createQuitGuard,
  readQuitGuardInput,
  type QuitGuardDependencies,
  type QuitGuardQueueState,
} from "./quitGuardController";
import { createPresetDraft } from "@/features/settings/presetDocument";
import { createOpenAction } from "./openAction";
import { reportingSaveStep } from "./projectOpenStep";

function createInput(overrides: Partial<QuitGuardInput> = {}): QuitGuardInput {
  return {
    timeline: { segmentCount: 0, hasPendingIn: false },
    project: { hasChangesToSave: false, isModifiedFile: false, fileName: null },
    exportStatus: "idle",
    exportTracking: false,
    unsavedPresetName: null,
    queuedExports: 0,
    ...overrides,
  };
}

const TWO_SEGMENTS = { segmentCount: 2, hasPendingIn: false };

/** A project with no file whose sequence has two segments: it has changes to save. */
const WITH_SEGMENTS = createInput({
  timeline: TWO_SEGMENTS,
  project: { hasChangesToSave: true, isModifiedFile: false, fileName: null },
});

/** A project with a file that is modified, on a sequence with two segments (ADR 072). */
const MODIFIED_FILE = createInput({
  timeline: TWO_SEGMENTS,
  project: { hasChangesToSave: true, isModifiedFile: true, fileName: "cut.qcproj" },
});

/** The same project after a save: it has its file and no changes to save. */
const SAVED_FILE = createInput({
  timeline: TWO_SEGMENTS,
  project: { hasChangesToSave: false, isModifiedFile: false, fileName: "cut.qcproj" },
});

/** A loss other than the project: the quit dialog has its plain form. */
const WITH_DRAFT = createInput({ unsavedPresetName: "Archive" });

// The guard only passes the result through, so any value stands for it.
const IMPORT_RESULT = ["clip-1"];

/** A confirm_quit that never settles, as when the application ends before it answers. */
function neverSettles(): Promise<unknown> {
  return new Promise(() => undefined);
}

/**
 * A fake save step. `run` starts a step of another caller, as a save of the Save action, which
 * runs until `finish`. `save` answers with the next queued answer, or with a held promise when
 * no answer is queued. A queued `busy` answers as the real step does: another step runs, and
 * it holds until `finish`, so a flow that does not wait for it fails its test.
 */
function createSaveStep() {
  let running: Promise<void> | null = null;
  let endRunning: () => void = () => {};
  const run = () => {
    running = new Promise<void>((resolve) => {
      endRunning = () => {
        running = null;
        resolve();
      };
    });
  };
  const answers: ProjectSaveResult[] = [];
  const pending: ReturnType<typeof held<ProjectSaveResult>>[] = [];
  const save = vi.fn((_mode: "save" | "saveAs"): Promise<ProjectSaveResult> => {
    const next = answers.shift();
    if (next !== undefined) {
      if (next.status === "busy" && running === null) {
        run();
      }
      return Promise.resolve(next);
    }
    const answer = held<ProjectSaveResult>();
    pending.push(answer);
    return answer.promise;
  });
  return {
    save,
    isRunning: () => running !== null,
    whenIdle: () => running ?? Promise.resolve(),
    /** Queues the answer of the next `save`. */
    answer: (result: ProjectSaveResult) => {
      answers.push(result);
    },
    /** The held answers of the calls of `save` with no queued answer. */
    pending,
    /** Starts a step of another caller, which runs until `finish`. */
    run,
    finish: () => {
      endRunning();
    },
  };
}

const SAVED: ProjectSaveResult = {
  status: "saved",
  path: "/p/cut.qcproj",
  bound: true,
};
const SAVE_ERROR: ProjectSaveError = { kind: "invalidName", path: "/p/cut.txt" };

/** Lets each pending promise callback run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function setup(input: QuitGuardInput, overrides: QuitGuardDependencies = {}) {
  let current = input;
  const confirmQuit = vi.fn(neverSettles);
  const importPaths = vi.fn((_paths: readonly string[], _index: number | null) =>
    Promise.resolve<unknown>(IMPORT_RESULT),
  );
  const clearTimeline = vi.fn();
  const saveStep = createSaveStep();
  // The save error that shows, as the save error store holds it.
  let shownError: unknown = null;
  const reportSaveError = vi.fn((error: ProjectSaveError) => {
    shownError = error;
  });
  const focusWindow = vi.fn();
  const guard = createQuitGuard({
    readInput: () => current,
    confirmQuit,
    importPaths,
    clearTimeline,
    saveStep,
    reportSaveError,
    readSaveError: () => shownError,
    focusWindow,
    ...overrides,
  });
  return {
    guard,
    confirmQuit,
    importPaths,
    clearTimeline,
    saveStep,
    reportSaveError,
    focusWindow,
    /** Shows a save error, as an earlier save that failed does. */
    showSaveError: (error: unknown) => {
      shownError = error;
    },
    setInput: (next: QuitGuardInput) => {
      current = next;
    },
  };
}

describe("requestQuit", () => {
  it("quits at once and shows no prompt when nothing would be lost", () => {
    const { guard, confirmQuit } = setup(createInput());

    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("shows the quit prompt with the loss when work would be lost", () => {
    const { guard, confirmQuit } = setup(
      createInput({ exportStatus: "running", unsavedPresetName: "Archive" }),
    );

    guard.requestQuit();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: {
        project: null,
        pendingIn: false,
        exportActive: true,
        queuedExports: 0,
        unsavedPreset: "Archive",
      },
    });
  });

  // A quit can start while the Settings window has the focus, for example from Cmd+Q.
  it("brings the main window forward when the quit prompt opens, and only then", () => {
    const focusWindow = vi.fn();
    const asking = setup(WITH_SEGMENTS, { focusWindow });
    asking.guard.requestQuit();
    expect(focusWindow).toHaveBeenCalledTimes(1);

    const quiet = vi.fn();
    const quitting = setup(createInput(), { focusWindow: quiet });
    quitting.guard.requestQuit();
    expect(quiet).not.toHaveBeenCalled();
  });

  it("does not replace an open quit prompt on a second request", () => {
    const { guard, confirmQuit, setInput } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    const first = guard.store.getState().prompt;
    // The work changes, and a second close request arrives while the prompt is open.
    setInput(createInput());
    guard.requestQuit();

    expect(guard.store.getState().prompt).toBe(first);
    expect(confirmQuit).not.toHaveBeenCalled();
  });

  it("ignores every request after the quit started", () => {
    const { guard, confirmQuit, setInput } = setup(createInput());

    guard.requestQuit();
    setInput(WITH_SEGMENTS);
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("ignores a later request after confirm_quit resolved", async () => {
    // Rust only queues the exit, so the command can answer before the application ends.
    const confirmQuit = vi.fn(() => Promise.resolve(null));
    const { guard, setInput } = setup(createInput(), { confirmQuit });

    guard.requestQuit();
    await Promise.resolve();
    await Promise.resolve();
    setInput(WITH_SEGMENTS);
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("ignores a later request after a confirmed quit resolved", async () => {
    const confirmQuit = vi.fn(() => Promise.resolve(null));
    const { guard } = setup(WITH_DRAFT, { confirmQuit });

    guard.requestQuit();
    guard.confirm();
    await Promise.resolve();
    await Promise.resolve();
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("runs the decision again after confirm_quit failed", async () => {
    const confirmQuit = vi.fn(() => Promise.reject(new Error("no runtime")));
    const { guard } = setup(createInput(), { confirmQuit });

    guard.requestQuit();
    // Let the rejection reach the guard.
    await Promise.resolve();
    await Promise.resolve();
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(2);
  });

  it("takes the place of an open clear prompt, and nothing clears", () => {
    const { guard, clearTimeline } = setup(WITH_SEGMENTS);

    guard.requestClear();
    expect(guard.store.getState().prompt?.kind).toBe("clear");

    guard.requestQuit();

    expect(guard.store.getState().prompt?.kind).toBe("quit");
    guard.cancel();
    expect(clearTimeline).not.toHaveBeenCalled();
  });
});

describe("confirm and cancel of the quit prompt", () => {
  it("quits on confirm and closes the prompt", () => {
    const { guard, confirmQuit } = setup(WITH_DRAFT);

    guard.requestQuit();
    guard.confirm();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("changes nothing on cancel, and asks again on the next request", () => {
    const { guard, confirmQuit } = setup(WITH_DRAFT);

    guard.requestQuit();
    guard.cancel();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();

    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("ignores the cancel that Radix sends after the confirm button", () => {
    const { guard, confirmQuit } = setup(WITH_DRAFT);

    guard.requestQuit();
    guard.confirm();
    guard.cancel();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("does nothing on a confirm with no prompt open", () => {
    const { guard, confirmQuit, clearTimeline } = setup(WITH_SEGMENTS);

    guard.confirm();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(clearTimeline).not.toHaveBeenCalled();
  });
});

describe("requestOpen", () => {
  it("imports at once, also when the sequence has segments (ADR 052)", async () => {
    const { guard, importPaths } = setup(WITH_SEGMENTS);

    await expect(guard.requestOpen("/videos/next.mp4")).resolves.toBe(IMPORT_RESULT);

    expect(importPaths).toHaveBeenCalledWith(["/videos/next.mp4"], null);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("passes several paths and a junction through", async () => {
    const { guard, importPaths } = setup(createInput());

    await guard.requestOpen(["/videos/a.mp4", "/videos/b.mp4"], 2);

    expect(importPaths).toHaveBeenCalledWith(["/videos/a.mp4", "/videos/b.mp4"], 2);
  });

  it("imports nothing while a prompt is open", async () => {
    const { guard, importPaths } = setup(WITH_SEGMENTS);

    guard.requestClear();
    await expect(guard.requestOpen("/videos/next.mp4")).resolves.toEqual([]);

    expect(importPaths).not.toHaveBeenCalled();
  });
});

describe("requestClear", () => {
  it("clears at once when the sequence has no segment", () => {
    const { guard, clearTimeline } = setup(createInput());

    guard.requestClear();

    expect(clearTimeline).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("asks first when the sequence has segments, and clears on confirm", () => {
    const { guard, clearTimeline } = setup(WITH_SEGMENTS);

    guard.requestClear();
    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "clear",
      change: { form: "plain", segments: 2, pendingIn: false },
    });

    guard.confirm();
    guard.cancel();
    expect(clearTimeline).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("clears nothing on cancel", () => {
    const { guard, clearTimeline } = setup(WITH_SEGMENTS);

    guard.requestClear();
    guard.cancel();

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
  });
});
describe("the quit prompt for a live export after a failed Stop request", () => {
  /**
   * A real export store with a Stop that waits for the run id of its start. After the answer
   * the store sends `cancel_export` through the real client to an IPC layer that rejects.
   */
  async function stopWhileTheStartWaits() {
    let emit!: (event: ExportProgressEvent) => void;
    let answerStart: (start: ExportSubmission) => void = () => {};
    const startFn = vi.fn(
      () =>
        new Promise<ExportSubmission>((resolve) => {
          answerStart = resolve;
        }),
    );
    const store = createExportStore({
      subscribeExportProgress: (handler) => {
        emit = handler;
        return Promise.resolve(() => {});
      },
      startExport: startFn,
      cancelExport: (runId) =>
        clientCancelExport(runId, { invoke: vi.fn().mockRejectedValue("IPC closed") }),
    });
    const starting = store.getState().startExport({
      sources: [{ id: "source", path: "/videos/open.mp4" }],
      outputPath: "/videos/out.mp4",
      pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
      segmentCount: 1,
      preset: createPresetDraft("default", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    });
    await vi.waitFor(() => {
      expect(startFn).toHaveBeenCalled();
    });
    const stopping = store.getState().cancelExport();
    return {
      store,
      starting,
      stopping,
      emit: (event: ExportProgressEvent) => {
        emit(event);
      },
      answerStart: (start: ExportSubmission) => {
        answerStart(start);
      },
    };
  }

  /** Answers the start, and lets the Stop request for the named run fail. */
  async function failTheStopAfterTheAnswer() {
    const fixture = await stopWhileTheStartWaits();
    fixture.answerStart({ runId: "run-kept", queued: false });
    await fixture.starting;
    await expect(fixture.stopping).resolves.toBe(false);
    expect(fixture.store.getState()).toMatchObject({
      status: "failed",
      runId: "run-kept",
      tracking: true,
    });
    return fixture;
  }

  function inputOf(store: ReturnType<typeof createExportStore>): QuitGuardInput {
    const { status, tracking } = store.getState();
    return createInput({ exportStatus: status, exportTracking: tracking });
  }

  it("asks first while the Stop still waits for the run id", async () => {
    const { store } = await stopWhileTheStartWaits();
    expect(store.getState()).toMatchObject({ status: "preparing", tracking: true });
    const { guard, confirmQuit } = setup(createInput(), {
      readInput: () => inputOf(store),
    });

    guard.requestQuit();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("asks first, names the export, and quits on confirm", async () => {
    const { store } = await failTheStopAfterTheAnswer();
    const { guard, confirmQuit } = setup(createInput(), {
      readInput: () => inputOf(store),
    });

    guard.requestQuit();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: {
        project: null,
        pendingIn: false,
        exportActive: true,
        queuedExports: 0,
        unsavedPreset: null,
      },
    });

    // Rust then cancels the run that holds the export slot (ADR 017).
    guard.confirm();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("quits at once when the kept run has ended and nothing else would be lost", async () => {
    const { store, emit } = await failTheStopAfterTheAnswer();
    const { guard, confirmQuit } = setup(createInput(), {
      readInput: () => inputOf(store),
    });

    // Still live once the start answered.
    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
    guard.cancel();

    emit({ event: "failed", runId: "run-kept", code: "ffmpegProcessFailed" });
    guard.requestQuit();

    expect(guard.store.getState().prompt).toBeNull();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });
});

describe("readQuitGuardInput", () => {
  it("reads the status and the tracking of the production export store", () => {
    // The production store has no injected client, so the test writes its public state.
    exportStore.setState({ status: "failed", tracking: true });
    try {
      const input = readQuitGuardInput();
      expect(input).toMatchObject({ exportStatus: "failed", exportTracking: true });
      expect(decideQuit(input).loss.exportActive).toBe(true);
    } finally {
      exportStore.getState().reset();
    }
    expect(readQuitGuardInput()).toMatchObject({
      exportStatus: "idle",
      exportTracking: false,
    });
  });

  it("reads the unsaved preset draft that the Settings window reported", () => {
    settingsWindowDraftStore.setState({ unsavedPresetName: "Web 1080p" });
    try {
      const input = readQuitGuardInput();
      expect(input.unsavedPresetName).toBe("Web 1080p");
      expect(decideQuit(input).loss.unsavedPreset).toBe("Web 1080p");
    } finally {
      settingsWindowDraftStore.setState({ unsavedPresetName: null });
    }
    expect(readQuitGuardInput().unsavedPresetName).toBeNull();
  });

  it("reads the facts of the production project (ADR 072)", () => {
    expect(readQuitGuardInput().project).toEqual({
      hasChangesToSave: false,
      isModifiedFile: false,
      fileName: null,
    });
    // The test writes the public state. The located mark makes the project modified.
    projectStore.setState({
      file: { path: "/p/cut.qcproj", name: "cut.qcproj" },
      located: true,
    });
    try {
      expect(readQuitGuardInput().project).toEqual({
        hasChangesToSave: true,
        isModifiedFile: true,
        fileName: "cut.qcproj",
      });
      projectStore.setState({ located: false });
      // The empty sequence is the saved content, so the project is not modified.
      expect(readQuitGuardInput().project).toEqual({
        hasChangesToSave: false,
        isModifiedFile: false,
        fileName: "cut.qcproj",
      });
    } finally {
      projectStore.getState().closeProject(false);
    }
  });
});

describe("the save prompt of the quit (ADR 072)", () => {
  it("shows the save prompt for a project with changes to save", () => {
    const { guard, focusWindow } = setup(MODIFIED_FILE);

    guard.requestQuit();

    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: {
        project: { fileName: "cut.qcproj" },
        pendingIn: false,
        exportActive: false,
        queuedExports: 0,
        unsavedPreset: null,
      },
    });
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it("quits with no question for a saved project that is not modified", () => {
    const { guard, confirmQuit } = setup(SAVED_FILE);

    guard.requestQuit();

    expect(guard.store.getState().prompt).toBeNull();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("quits after Don't Save, and runs no save", () => {
    const { guard, confirmQuit, saveStep } = setup(MODIFIED_FILE);

    guard.requestQuit();
    guard.discard();

    expect(saveStep.save).not.toHaveBeenCalled();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("saves on Save, with no test of the conditions of the action, and then quits", async () => {
    const { guard, confirmQuit, saveStep, setInput } = setup(MODIFIED_FILE);

    guard.requestQuit();
    guard.confirm();
    // The prompt closes while the save runs, and the quit waits for it.
    expect(guard.store.getState().prompt).toBeNull();
    expect(saveStep.save).toHaveBeenCalledExactlyOnceWith("save");
    expect(confirmQuit).not.toHaveBeenCalled();

    setInput(SAVED_FILE);
    saveStep.pending[0]?.resolve(SAVED);
    await flush();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("shows the prompt again when the project still has changes to save after the write", async () => {
    // An edit during the write leaves the project modified.
    const { guard, confirmQuit, saveStep } = setup(MODIFIED_FILE);
    saveStep.answer(SAVED);

    guard.requestQuit();
    guard.confirm();
    await flush();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "quit",
      loss: { project: { fileName: "cut.qcproj" } },
    });
  });

  it("shows the prompt again for a new loss after the write, also with no project left", async () => {
    const { guard, confirmQuit, saveStep, setInput } = setup(MODIFIED_FILE);

    guard.requestQuit();
    guard.confirm();
    // A preset draft of the Settings window starts while Save writes.
    setInput({ ...SAVED_FILE, unsavedPresetName: "Archive" });
    saveStep.pending[0]?.resolve(SAVED);
    await flush();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: {
        project: null,
        pendingIn: false,
        exportActive: false,
        queuedExports: 0,
        unsavedPreset: "Archive",
      },
    });
    // The plain dialog now: Quit quits.
    guard.confirm();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("ends the quit when the user cancels the save dialog", async () => {
    const { guard, confirmQuit, saveStep, reportSaveError } = setup(WITH_SEGMENTS);
    saveStep.answer({ status: "canceled" });

    guard.requestQuit();
    guard.confirm();
    await flush();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(reportSaveError).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
    // The flow ended, so a new request asks again.
    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("ends the quit and reports the error of a save that failed", async () => {
    const { guard, confirmQuit, saveStep, reportSaveError } = setup(MODIFIED_FILE);
    saveStep.answer({ status: "failed", error: SAVE_ERROR });

    guard.requestQuit();
    guard.confirm();
    await flush();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(reportSaveError).toHaveBeenCalledExactlyOnceWith(SAVE_ERROR);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("goes on after busy, as after saved, once the step that runs ends", async () => {
    const { guard, confirmQuit, saveStep, setInput } = setup(MODIFIED_FILE);
    saveStep.answer({ status: "busy" });

    guard.requestQuit();
    guard.confirm();
    setInput(SAVED_FILE);
    await flush();
    // Another step runs, and the quit waits for it before it reads the losses.
    expect(saveStep.isRunning()).toBe(true);
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();

    saveStep.finish();
    await flush();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("waits for a save step that runs before its first decision", async () => {
    const { guard, confirmQuit, saveStep, setInput } = setup(MODIFIED_FILE);
    saveStep.run();

    guard.requestQuit();
    expect(guard.store.getState().prompt).toBeNull();
    expect(confirmQuit).not.toHaveBeenCalled();
    // A second request while the flow waits does nothing.
    guard.requestQuit();

    setInput(SAVED_FILE);
    saveStep.finish();
    await flush();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(saveStep.save).not.toHaveBeenCalled();
  });

  it("does nothing on a request while Save of the prompt runs", async () => {
    const { guard, saveStep, focusWindow } = setup(MODIFIED_FILE);

    guard.requestQuit();
    guard.confirm();
    guard.requestQuit();
    await flush();

    expect(saveStep.save).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it("asks again after a plain Quit when a loss appeared that the dialog did not list", () => {
    const { guard, confirmQuit, setInput, focusWindow } = setup(WITH_DRAFT);

    guard.requestQuit();
    setInput({ ...WITH_DRAFT, queuedExports: 1 });
    guard.confirm();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "quit",
      loss: { unsavedPreset: "Archive", queuedExports: 1 },
    });
    expect(focusWindow).toHaveBeenCalledTimes(2);
    guard.confirm();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("asks again after Don't Save for a loss that the dialog did not list", () => {
    const { guard, confirmQuit, setInput } = setup(MODIFIED_FILE);

    guard.requestQuit();
    setInput({ ...MODIFIED_FILE, unsavedPresetName: "Archive" });
    guard.discard();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "quit",
      loss: { project: { fileName: "cut.qcproj" }, unsavedPreset: "Archive" },
    });
  });

  it("quits after a plain Quit when a listed loss went", () => {
    const { guard, confirmQuit, setInput } = setup(WITH_DRAFT);

    guard.requestQuit();
    setInput(createInput());
    guard.confirm();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Don't Save of a plain dialog, which has no such button", () => {
    const { guard, confirmQuit } = setup(WITH_DRAFT);

    guard.requestQuit();
    const prompt = guard.store.getState().prompt;
    guard.discard();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBe(prompt);
  });

  it("ignores the dismissal of a prompt that a button replaced", () => {
    // Radix sends the dismissal after the button, with the prompt of the last render.
    const { guard, setInput } = setup(WITH_DRAFT);

    guard.requestQuit();
    const first = guard.store.getState().prompt ?? undefined;
    setInput({ ...WITH_DRAFT, queuedExports: 1 });
    guard.confirm();
    const second = guard.store.getState().prompt;
    guard.cancel(first);

    expect(second).not.toBeNull();
    expect(guard.store.getState().prompt).toBe(second);
    guard.cancel(second ?? undefined);
    expect(guard.store.getState().prompt).toBeNull();
  });
});

describe("the save prompt of Clear Timeline (ADR 072)", () => {
  it("shows the save form for a project with a file that is modified", () => {
    const { guard, clearTimeline } = setup(MODIFIED_FILE);

    guard.requestClear();

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "clear",
      change: { form: "save", fileName: "cut.qcproj", pendingIn: false },
    });
  });

  it("clears on Don't Save, and ends on Cancel", () => {
    const dontSave = setup(MODIFIED_FILE);
    dontSave.guard.requestClear();
    dontSave.guard.discard();
    expect(dontSave.clearTimeline).toHaveBeenCalledTimes(1);
    expect(dontSave.saveStep.save).not.toHaveBeenCalled();

    const cancel = setup(MODIFIED_FILE);
    cancel.guard.requestClear();
    cancel.guard.cancel();
    expect(cancel.clearTimeline).not.toHaveBeenCalled();
    expect(cancel.guard.store.getState().prompt).toBeNull();
  });

  it("saves on Save, and then clears with no second question", async () => {
    const { guard, clearTimeline, saveStep, setInput } = setup(MODIFIED_FILE);

    guard.requestClear();
    guard.confirm();
    expect(saveStep.save).toHaveBeenCalledExactlyOnceWith("save");
    expect(clearTimeline).not.toHaveBeenCalled();

    // The saved project has segments: the plain form would ask, and after Save it does not.
    setInput(SAVED_FILE);
    saveStep.pending[0]?.resolve(SAVED);
    await flush();

    expect(clearTimeline).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("shows the save form again while the project is still modified after the write", async () => {
    const { guard, clearTimeline, saveStep } = setup(MODIFIED_FILE);
    saveStep.answer(SAVED);

    guard.requestClear();
    guard.confirm();
    await flush();

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "clear",
      change: { form: "save" },
    });
  });

  it("ends when the user cancels the save dialog, and reports a save that failed", async () => {
    const canceled = setup(MODIFIED_FILE);
    canceled.saveStep.answer({ status: "canceled" });
    canceled.guard.requestClear();
    canceled.guard.confirm();
    await flush();
    expect(canceled.clearTimeline).not.toHaveBeenCalled();
    expect(canceled.reportSaveError).not.toHaveBeenCalled();

    const failed = setup(MODIFIED_FILE);
    failed.saveStep.answer({ status: "failed", error: SAVE_ERROR });
    failed.guard.requestClear();
    failed.guard.confirm();
    await flush();
    expect(failed.clearTimeline).not.toHaveBeenCalled();
    expect(failed.reportSaveError).toHaveBeenCalledExactlyOnceWith(SAVE_ERROR);
    // The flow ended, so a new Clear Timeline asks again.
    failed.guard.requestClear();
    expect(failed.guard.store.getState().prompt?.kind).toBe("clear");
  });

  it("waits for a save step that runs, and then decides", async () => {
    const { guard, clearTimeline, saveStep, setInput } = setup(MODIFIED_FILE);
    saveStep.run();

    guard.requestClear();
    expect(guard.store.getState().prompt).toBeNull();
    // The flow runs, so a second Clear Timeline and an import do nothing.
    guard.requestClear();
    await expect(guard.requestOpen("/videos/next.mp4")).resolves.toEqual([]);

    setInput(createInput());
    saveStep.finish();
    await flush();

    expect(clearTimeline).toHaveBeenCalledTimes(1);
  });

  it("waits after busy for the step that runs, and then clears", async () => {
    const { guard, clearTimeline, saveStep, setInput } = setup(MODIFIED_FILE);
    saveStep.answer({ status: "busy" });

    guard.requestClear();
    guard.confirm();
    setInput(SAVED_FILE);
    await flush();
    expect(saveStep.isRunning()).toBe(true);
    expect(clearTimeline).not.toHaveBeenCalled();

    saveStep.finish();
    await flush();
    expect(clearTimeline).toHaveBeenCalledTimes(1);
  });

  it("decides again after Save when the project closed during the write", async () => {
    // During the write the last clip goes and an Undo brings it back: the project has no file
    // now, and the sequence has segments that the file does not have.
    const { guard, clearTimeline, saveStep, setInput } = setup(MODIFIED_FILE);

    guard.requestClear();
    guard.confirm();
    setInput(WITH_SEGMENTS);
    saveStep.pending[0]?.resolve({
      status: "saved",
      path: "/p/cut.qcproj",
      bound: false,
    });
    await flush();

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "clear",
      change: { form: "plain", segments: 2, pendingIn: false },
    });
    // Clear of the plain form clears.
    guard.confirm();
    expect(clearTimeline).toHaveBeenCalledTimes(1);
  });

  it("clears after Save when nothing is left to ask, and with no segment", async () => {
    const { guard, clearTimeline, saveStep, setInput } = setup(MODIFIED_FILE);

    guard.requestClear();
    guard.confirm();
    setInput(createInput());
    saveStep.pending[0]?.resolve(SAVED);
    await flush();

    expect(clearTimeline).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save of a flow that a quit dropped, and the quit does not hide it", async () => {
    const { guard, clearTimeline, saveStep, reportSaveError, setInput, confirmQuit } =
      setup(MODIFIED_FILE);

    guard.requestClear();
    guard.confirm();
    saveStep.run();
    guard.requestQuit();
    setInput(SAVED_FILE);
    saveStep.pending[0]?.resolve({ status: "failed", error: SAVE_ERROR });
    await flush();

    expect(reportSaveError).toHaveBeenCalledExactlyOnceWith(SAVE_ERROR);
    expect(clearTimeline).not.toHaveBeenCalled();
    saveStep.finish();
    await flush();
    expect(clearTimeline).not.toHaveBeenCalled();
    // The error came while the quit waited, so the quit ends with no quit and no prompt, and the
    // save error dialog shows. The user can quit again after it.
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
    guard.requestQuit();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("quits after the wait when the step ended with no new save error", async () => {
    const { guard, confirmQuit, saveStep, setInput, showSaveError } = setup(SAVED_FILE);
    // An error of an earlier save still shows. It did not come during the wait.
    showSaveError(SAVE_ERROR);
    saveStep.run();

    guard.requestQuit();
    expect(confirmQuit).not.toHaveBeenCalled();
    setInput(SAVED_FILE);
    saveStep.finish();
    await flush();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("ends the quit when a save that it waited for fails, as a Save of the menu", async () => {
    const { guard, confirmQuit, saveStep, showSaveError } = setup(SAVED_FILE);
    saveStep.run();

    guard.requestQuit();
    // The Save action reports its error, and then the step ends.
    showSaveError({ kind: "noClip" });
    saveStep.finish();
    await flush();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("never clears after a quit dropped it, also when its save ends later", async () => {
    const { guard, clearTimeline, saveStep, setInput, confirmQuit } =
      setup(MODIFIED_FILE);

    guard.requestClear();
    guard.confirm();
    // The quit drops the flow that waits for its save. The quit waits for the save too.
    saveStep.run();
    guard.requestQuit();
    expect(guard.store.getState().prompt).toBeNull();

    setInput(SAVED_FILE);
    saveStep.pending[0]?.resolve(SAVED);
    saveStep.finish();
    await flush();

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a request while a quit flow runs", () => {
    const { guard, clearTimeline } = setup(MODIFIED_FILE);

    guard.requestQuit();
    guard.requestClear();

    expect(guard.store.getState().prompt?.kind).toBe("quit");
    expect(clearTimeline).not.toHaveBeenCalled();
  });
});

describe("the queued exports in the quit guard", () => {
  function createQueue(state: Partial<QuitGuardQueueState> = {}) {
    return createStore<QuitGuardQueueState>()(() => ({
      waiting: [],
      removing: [],
      enqueuing: 0,
      ...state,
    }));
  }

  it("reads the waiting runs and the submissions for the queue of the injected store", () => {
    const queue = createQueue({ waiting: ["run-2", "run-3"], enqueuing: 1 });
    expect(readQuitGuardInput(queue).queuedExports).toBe(3);
  });

  it("does not count a waiting run that the user removes", () => {
    const queue = createQueue({ waiting: ["run-2", "run-3"], removing: ["run-3"] });
    expect(readQuitGuardInput(queue).queuedExports).toBe(1);
  });

  it("reads the production queue store by default", () => {
    // The production store has no injected client, so the test writes its public state.
    exportQueueStore.setState({ waiting: ["run-2"], enqueuing: 1 });
    try {
      expect(readQuitGuardInput().queuedExports).toBe(2);
    } finally {
      exportQueueStore.setState({ waiting: [], enqueuing: 0 });
    }
    expect(readQuitGuardInput().queuedExports).toBe(0);
  });

  it("asks before a quit while exports wait, and quits at once when none wait", () => {
    const queue = createQueue({ waiting: ["run-2"] });
    const confirmQuit = vi.fn(() => Promise.resolve());
    const guard = createQuitGuard({
      queueStore: queue,
      confirmQuit,
      focusWindow: () => {},
    });

    // The close button of the window and an exit request both call `requestQuit`.
    guard.requestQuit();
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "quit",
      loss: { queuedExports: 1 },
    });
    guard.cancel();

    // A submission for the queue that has no answer counts too.
    queue.setState({ waiting: [], enqueuing: 1 });
    guard.requestQuit();
    expect(guard.store.getState().prompt).toMatchObject({
      kind: "quit",
      loss: { queuedExports: 1 },
    });
    guard.cancel();

    queue.setState({ enqueuing: 0 });
    guard.requestQuit();
    expect(guard.store.getState().prompt).toBeNull();
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });
});

describe("the quit prompt with the real export stores", () => {
  function request(outputPath: string): ExportRequest {
    return {
      sources: [{ id: "source", path: "/media/source.mp4" }],
      outputPath,
      pieces: [{ sourceId: "source", inPts: "0" as Pts, outPts: "1000" as Pts }],
      segmentCount: 1,
      preset: createPresetDraft("mp4-h264", "Test preset"),
      streams: "videoAndAudio",
      audioMode: "encode",
    };
  }

  /** A real export store and queue store whose `start_export` answers when the test says. */
  function setupStores() {
    const answers: Array<(submission: ExportSubmission) => void> = [];
    const start = vi.fn(
      () =>
        new Promise<ExportSubmission>((resolve) => {
          answers.push(resolve);
        }),
    );
    const subscribe = () => Promise.resolve(() => {});
    const cancel = () => Promise.resolve(true);
    const store = createExportStore({
      subscribeExportProgress: subscribe,
      startExport: start,
      cancelExport: cancel,
    });
    const queue = createExportQueueStore({
      exportStore: store,
      startExport: start,
      cancelExport: cancel,
      subscribeExportProgress: subscribe,
    });
    const guard = createQuitGuard({
      readInput: () => {
        const { status, tracking } = store.getState();
        return createInput({
          exportStatus: status,
          exportTracking: tracking,
          queuedExports: countQueuedExports(queue.getState()),
        });
      },
      confirmQuit: () => Promise.resolve(),
      focusWindow: () => {},
    });
    return { start, answers, queue, guard };
  }

  function promptLines(guard: ReturnType<typeof createQuitGuard>): string[] {
    const prompt = guard.store.getState().prompt;
    return prompt?.kind === "quit"
      ? presentQuitPrompt(prompt.loss).lines.map((line) => line.key)
      : [];
  }

  it("names only the live export while a direct start waits for its answer", async () => {
    const { start, answers, queue, guard } = setupStores();
    const starting = queue.getState().submit(request("/out/a.mp4"));
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(queue.getState()).toMatchObject({ submitting: 1, enqueuing: 0 });

    guard.requestQuit();
    expect(promptLines(guard)).toEqual(["quitGuard.loss.export"]);
    guard.cancel();

    answers[0]?.({ runId: "run-1", queued: false });
    await starting;
  });

  it("names the queued export while a submission for the queue waits for its answer", async () => {
    const { start, answers, queue, guard } = setupStores();
    const starting = queue.getState().submit(request("/out/a.mp4"));
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    answers[0]?.({ runId: "run-1", queued: false });
    await starting;

    const queuing = queue.getState().submit(request("/out/b.mp4"));
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(2);
    });
    expect(queue.getState()).toMatchObject({ submitting: 1, enqueuing: 1 });

    guard.requestQuit();
    expect(promptLines(guard)).toEqual([
      "quitGuard.loss.export",
      "quitGuard.loss.queued",
    ]);
    guard.cancel();

    answers[1]?.({ runId: "run-2", queued: true });
    await queuing;
    expect(queue.getState()).toMatchObject({
      submitting: 0,
      enqueuing: 0,
      waiting: ["run-2"],
    });
  });
});

/**
 * A fake open step. `open` holds its answer until the test settles it, and the step counts as
 * opening until then. `ask` calls the save prompt that the guard gave to the factory.
 */
function createOpenStepFake() {
  let ask: () => Promise<DropContentAnswer> = () => Promise.resolve("cancel");
  let opening = false;
  const results: Held<OpenProjectResult>[] = [];
  const step: ProjectOpenStep = {
    store: createOpenProjectStore(),
    open: vi.fn((_path: string) => {
      opening = true;
      const answer = held<OpenProjectResult>();
      results.push(answer);
      return answer.promise.finally(() => {
        opening = false;
      });
    }),
    // The guard starts no restore yet.
    restore: vi.fn(() => Promise.resolve({ status: "canceled", by: "user" } as const)),
    locate: vi.fn(() => Promise.resolve(false)),
    locateFile: vi.fn(() => Promise.resolve(false)),
    confirm: vi.fn(() => false),
    cancel: vi.fn(() => {
      opening = false;
    }),
    isOpening: () => opening,
  };
  return {
    step,
    createOpenStep: (next: () => Promise<DropContentAnswer>) => {
      ask = next;
      return step;
    },
    ask: () => ask(),
    results,
  };
}

describe("requestOpen with a project file (ADR 072, One Open action)", () => {
  it("opens one project file with the open step, and imports nothing", async () => {
    const open = createOpenStepFake();
    const { guard, importPaths } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
    });

    const request = guard.requestOpen(["/p/cut.qcproj"], 2);
    expect(open.step.open).toHaveBeenCalledWith("/p/cut.qcproj");
    expect(importPaths).not.toHaveBeenCalled();
    open.results[0]?.resolve({ status: "opened", path: "/p/cut.qcproj" });

    await expect(request).resolves.toEqual({ status: "opened", path: "/p/cut.qcproj" });
  });

  it("gives the guard the open step that it made", () => {
    const open = createOpenStepFake();
    const { guard } = setup(createInput(), { createOpenStep: open.createOpenStep });

    expect(guard.openStep).toBe(open.step);
  });

  it("opens nothing for a project file with a video, and reports projectNotAlone", async () => {
    const open = createOpenStepFake();
    const reportOpenError = vi.fn();
    const { guard, importPaths } = setup(createInput(), {
      createOpenStep: open.createOpenStep,
      reportOpenError,
    });

    await expect(guard.requestOpen(["/p/cut.qcproj", "/v/a.mp4"])).resolves.toEqual([]);

    expect(open.step.open).not.toHaveBeenCalled();
    expect(importPaths).not.toHaveBeenCalled();
    expect(reportOpenError).toHaveBeenCalledTimes(1);
    expect(reportOpenError.mock.calls[0]?.[0]).toMatchObject({
      code: "projectNotAlone",
    });
  });

  it("opens nothing for two project files", async () => {
    const open = createOpenStepFake();
    const reportOpenError = vi.fn();
    const { guard } = setup(createInput(), {
      createOpenStep: open.createOpenStep,
      reportOpenError,
    });

    await guard.requestOpen(["/p/a.qcproj", "/p/b.qcproj"]);

    expect(open.step.open).not.toHaveBeenCalled();
    expect(reportOpenError).toHaveBeenCalledTimes(1);
  });

  it("does not report the save error of a stopped open: the save step of the page did", async () => {
    // `createPageOpenStep` gives the open step a save step that reports a failed save itself,
    // so a second report here would show the error two times.
    const open = createOpenStepFake();
    const { guard, reportSaveError } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
    });

    const request = guard.requestOpen("/p/cut.qcproj");
    open.results[0]?.resolve({ status: "stopped", saveError: SAVE_ERROR });
    await request;

    expect(reportSaveError).not.toHaveBeenCalled();
  });

  it("shows nothing more for each other result", async () => {
    const open = createOpenStepFake();
    const { guard, reportSaveError } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
    });
    const results: OpenProjectResult[] = [
      { status: "stopped", saveError: null },
      { status: "canceled" },
      { status: "blocked" },
      { status: "failed", error: { kind: "entriesDiffer", entryIds: ["a", "b"] } },
    ];
    for (const [index, result] of results.entries()) {
      const request = guard.requestOpen("/p/cut.qcproj");
      open.results[index]?.resolve(result);
      await request;
    }

    expect(reportSaveError).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("opens nothing while a prompt is open, or while a flow runs", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(WITH_SEGMENTS, { createOpenStep: open.createOpenStep });

    guard.requestClear();
    await guard.requestOpen("/p/cut.qcproj");
    guard.cancel();
    guard.requestQuit();
    guard.confirm();
    await guard.requestOpen("/p/cut.qcproj");

    expect(open.step.open).not.toHaveBeenCalled();
  });
});

describe("the open of a project is a flow of the guard (ADR 072)", () => {
  it("takes no Clear Timeline, no import and no second open until the open ends", async () => {
    const open = createOpenStepFake();
    const { guard, importPaths, clearTimeline } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
    });

    const request = guard.requestOpen("/p/cut.qcproj");
    expect(guard.canOpen()).toBe(false);
    guard.requestClear();
    await guard.requestOpen("/v/a.mp4");
    await guard.requestOpen("/p/other.qcproj");

    expect(clearTimeline).not.toHaveBeenCalled();
    expect(importPaths).not.toHaveBeenCalled();
    expect(open.step.open).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();

    open.results[0]?.resolve({ status: "canceled" });
    await request;
    expect(guard.canOpen()).toBe(true);
    guard.requestClear();
    expect(guard.store.getState().prompt?.kind).toBe("clear");
  });

  it("ends when the open fails or opens, as when it is canceled", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(createInput(), { createOpenStep: open.createOpenStep });

    const first = guard.requestOpen("/p/cut.qcproj");
    open.results[0]?.resolve({ status: "opened", path: "/p/cut.qcproj" });
    await first;
    expect(guard.canOpen()).toBe(true);

    const second = guard.requestOpen("/p/cut.qcproj");
    open.results[1]?.resolve({
      status: "failed",
      error: { kind: "entriesDiffer", entryIds: ["a", "b"] },
    });
    await second;
    expect(guard.canOpen()).toBe(true);
  });
});

describe("canOpen", () => {
  it("is true while no prompt shows, no flow runs and the quit did not start", () => {
    const { guard } = setup(WITH_SEGMENTS);
    expect(guard.canOpen()).toBe(true);
  });

  it("is false while a prompt shows, while a flow waits, and after the quit started", () => {
    const shown = setup(WITH_SEGMENTS);
    shown.guard.requestClear();
    expect(shown.guard.canOpen()).toBe(false);

    const waiting = setup(WITH_SEGMENTS);
    waiting.saveStep.run();
    waiting.guard.requestQuit();
    expect(waiting.guard.store.getState().prompt).toBeNull();
    expect(waiting.guard.canOpen()).toBe(false);

    const quitting = setup(createInput());
    quitting.guard.requestQuit();
    expect(quitting.guard.canOpen()).toBe(false);
  });

  it("keeps the Open action from showing its file dialog while a quit waits for a save", async () => {
    const { guard, saveStep, importPaths } = setup(WITH_SEGMENTS);
    saveStep.run();
    guard.requestQuit();
    const openDialog = vi.fn().mockResolvedValue(["/v/a.mp4"]);

    await createOpenAction({
      canOpen: () => guard.canOpen(),
      requestOpen: (paths) => guard.requestOpen(paths),
      openDialog,
      filterName: () => "Open",
    })();

    expect(openDialog).not.toHaveBeenCalled();
    expect(importPaths).not.toHaveBeenCalled();
  });
});

describe("requestVideos (ADR 024, ADR 072)", () => {
  it("imports the videos at the end of the sequence", async () => {
    const { guard, importPaths } = setup(WITH_SEGMENTS);

    await expect(guard.requestVideos(["/v/a.mp4", "/v/b.mp4"])).resolves.toBe(
      IMPORT_RESULT,
    );

    expect(importPaths).toHaveBeenCalledWith(["/v/a.mp4", "/v/b.mp4"], null);
  });

  it("opens no project and imports nothing for a request with a project file", async () => {
    const open = createOpenStepFake();
    const reportOpenError = vi.fn();
    const { guard, importPaths } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
      reportOpenError,
    });

    await guard.requestVideos(["/p/cut.qcproj"]);
    await guard.requestVideos(["/v/a.mp4", "/p/CUT.QCPROJ"]);

    expect(open.step.open).not.toHaveBeenCalled();
    expect(importPaths).not.toHaveBeenCalled();
    expect(reportOpenError).toHaveBeenCalledTimes(2);
    expect(reportOpenError.mock.calls[0]?.[0]).toMatchObject({
      code: "projectNotAlone",
    });
  });

  it("imports nothing while a prompt is open", async () => {
    const { guard, importPaths } = setup(WITH_SEGMENTS);

    guard.requestClear();
    await guard.requestVideos(["/v/a.mp4"]);

    expect(importPaths).not.toHaveBeenCalled();
  });
});

describe("the message of a mixed request in the line of the imports (ADR 072)", () => {
  it("does not stop an import that runs: the clip joins, and the error shows after it", async () => {
    const slow = held<ImportMediaResult>();
    const media = createMediaStore({
      importMedia: (path) =>
        path === "/v/slow.mp4"
          ? slow.promise
          : Promise.reject(new ImportMediaError({ code: "pathNotFound" })),
    });
    const timeline = createTimelineStore();
    const { guard } = setup(createInput(), {
      importPaths: (paths, index) => importClips(paths, index, { media, timeline }),
      reportOpenError: (error) => {
        media.getState().reportError(error);
      },
    });

    const importing = guard.requestOpen(["/v/slow.mp4"]);
    const mixed = guard.requestOpen(["/p/cut.qcproj", "/v/a.mp4"]);
    await flush();
    expect(media.getState().error).toBeNull();

    slow.resolve(mediaAt("/v/slow.mp4"));
    await importing;
    expect(timeline.getState().clips).toHaveLength(1);
    expect(media.getState().error).toBeNull();

    await mixed;
    expect(timeline.getState().clips).toHaveLength(1);
    expect(media.getState().error?.code).toBe("projectNotAlone");
  });
});

describe("the save prompt of the open of a project (ADR 072)", () => {
  /** A guard whose open flow runs, over a fake open step. */
  function openRunning(input: QuitGuardInput) {
    const open = createOpenStepFake();
    const context = setup(input, { createOpenStep: open.createOpenStep });
    void context.guard.requestOpen("/p/other.qcproj");
    return { ...context, open };
  }

  it("shows the save form with the name of the file of the project", () => {
    const { guard, open } = openRunning(MODIFIED_FILE);

    void open.ask();

    expect(guard.store.getState().prompt).toEqual({
      kind: "open",
      project: { fileName: "cut.qcproj" },
    });
  });

  it("says that a project with no file has no file", () => {
    const { guard, open } = openRunning(WITH_SEGMENTS);

    void open.ask();

    expect(guard.store.getState().prompt).toEqual({
      kind: "open",
      project: { fileName: null },
    });
  });

  it("answers Cancel at once outside an open flow", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(MODIFIED_FILE, { createOpenStep: open.createOpenStep });

    await expect(open.ask()).resolves.toBe("cancel");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("answers Save, and runs no save itself: the open step runs it", async () => {
    const { guard, saveStep, open } = openRunning(MODIFIED_FILE);

    const answer = open.ask();
    const shown = guard.store.getState().prompt ?? undefined;
    guard.confirm();
    // Radix sends a dismissal after the button. It changes nothing.
    guard.cancel(shown);

    await expect(answer).resolves.toBe("save");
    expect(saveStep.save).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
    // The open flow goes on during the write.
    expect(guard.canOpen()).toBe(false);
  });

  it("answers Don't Save and Cancel", async () => {
    const { guard, open } = openRunning(MODIFIED_FILE);

    const first = open.ask();
    guard.discard();
    await expect(first).resolves.toBe("dontSave");

    const second = open.ask();
    guard.cancel();
    await expect(second).resolves.toBe("cancel");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("shows again after an answer, as when changes are left after the save", async () => {
    const { guard, open } = openRunning(MODIFIED_FILE);

    const first = open.ask();
    guard.confirm();
    await first;
    void open.ask();

    expect(guard.store.getState().prompt?.kind).toBe("open");
  });

  it("answers Cancel at once while another prompt shows", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(MODIFIED_FILE, { createOpenStep: open.createOpenStep });

    guard.requestClear();
    const shown = guard.store.getState().prompt;

    await expect(open.ask()).resolves.toBe("cancel");
    expect(guard.store.getState().prompt).toBe(shown);
  });

  it("answers Cancel at once after the quit started", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(createInput(), { createOpenStep: open.createOpenStep });

    guard.requestQuit();

    await expect(open.ask()).resolves.toBe("cancel");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("starts no import and no Clear Timeline while it shows", async () => {
    const { guard, importPaths, clearTimeline, open } = openRunning(MODIFIED_FILE);

    void open.ask();
    await guard.requestOpen("/v/a.mp4");
    guard.requestClear();

    expect(importPaths).not.toHaveBeenCalled();
    expect(clearTimeline).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("open");
  });
});

describe("a quit stops an open (ADR 072, The open of a project)", () => {
  it("cancels an open that is before step 8, and then tests the project", () => {
    const open = createOpenStepFake();
    const { guard, confirmQuit } = setup(createInput(), {
      createOpenStep: open.createOpenStep,
    });

    void guard.requestOpen("/p/cut.qcproj");
    guard.requestQuit();

    expect(open.step.cancel).toHaveBeenCalledTimes(1);
    expect(confirmQuit).toHaveBeenCalledTimes(1);
  });

  it("does not cancel when no open runs", () => {
    const open = createOpenStepFake();
    const { guard } = setup(WITH_SEGMENTS, { createOpenStep: open.createOpenStep });

    guard.requestQuit();

    expect(open.step.cancel).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("drops the save prompt of an open, which answers Cancel, and shows the quit prompt", async () => {
    const open = createOpenStepFake();
    const { guard } = setup(MODIFIED_FILE, { createOpenStep: open.createOpenStep });

    void guard.requestOpen("/p/other.qcproj");
    const answer = open.ask();
    guard.requestQuit();

    await expect(answer).resolves.toBe("cancel");
    expect(open.step.cancel).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: decideQuit(MODIFIED_FILE).loss,
    });
  });
});

describe("the open of a project with the real open step", () => {
  /** A guard over a real open step whose commands the test holds. */
  function realOpen(input: QuitGuardInput, changes: boolean) {
    const loading = held<LoadProjectResult>();
    const loadProject = vi.fn((_path: string) => loading.promise);
    const openSave = vi.fn(() => Promise.resolve(SAVED));
    let hasChanges = changes;
    const context = setup(input, {
      createOpenStep: (ask) =>
        createProjectOpenStep({
          saveStep: { save: openSave, whenIdle: () => Promise.resolve() },
          ask,
          isOtherDialogOpen: () => false,
          pickFile: () => Promise.resolve(null),
          staleExportOpenStep: () => undefined,
          hasChangesToSave: () => hasChanges,
          loadProject,
          runInImportLine: (task) => task(),
        }),
    });
    return {
      ...context,
      loadProject,
      openSave,
      setChanges: (next: boolean) => {
        hasChanges = next;
      },
    };
  }

  it("stops the open while it reads the file, closes the project dialog, and then asks", async () => {
    const { guard, loadProject } = realOpen(WITH_SEGMENTS, false);

    const request = guard.requestOpen("/p/cut.qcproj");
    await flush();
    expect(loadProject).toHaveBeenCalledWith("/p/cut.qcproj");
    expect(guard.openStep.store.getState().phase.kind).toBe("loading");

    guard.requestQuit();

    expect(guard.openStep.isOpening()).toBe(false);
    expect(guard.openStep.store.getState().phase.kind).toBe("idle");
    await expect(request).resolves.toEqual({ status: "canceled" });
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: decideQuit(WITH_SEGMENTS).loss,
    });
  });

  it("drops its save prompt on a quit, and the open reads no file", async () => {
    const { guard, loadProject, openSave } = realOpen(MODIFIED_FILE, true);

    const request = guard.requestOpen("/p/other.qcproj");
    await flush();
    expect(guard.store.getState().prompt).toEqual({
      kind: "open",
      project: { fileName: "cut.qcproj" },
    });

    guard.requestQuit();
    await flush();

    await expect(request).resolves.toEqual({ status: "canceled" });
    expect(loadProject).not.toHaveBeenCalled();
    expect(openSave).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("saves on Save of its prompt, and then reads the project file", async () => {
    const context = realOpen(MODIFIED_FILE, true);
    const { guard, loadProject, openSave } = context;

    void guard.requestOpen("/p/other.qcproj");
    await flush();
    context.setChanges(false);
    guard.confirm();
    await flush();

    expect(openSave).toHaveBeenCalledWith("save");
    expect(loadProject).toHaveBeenCalledWith("/p/other.qcproj");
    expect(guard.store.getState().prompt).toBeNull();
    guard.openStep.cancel();
  });

  it("reads the project file after Don't Save, and stops after Cancel", async () => {
    const first = realOpen(MODIFIED_FILE, true);
    void first.guard.requestOpen("/p/other.qcproj");
    await flush();
    first.guard.discard();
    await flush();
    expect(first.loadProject).toHaveBeenCalledTimes(1);
    first.guard.openStep.cancel();

    const second = realOpen(MODIFIED_FILE, true);
    const request = second.guard.requestOpen("/p/other.qcproj");
    await flush();
    second.guard.cancel();
    await expect(request).resolves.toEqual({ status: "stopped", saveError: null });
    expect(second.loadProject).not.toHaveBeenCalled();
  });
});

/**
 * A save step whose write the test ends, as the real step: `save` starts one step, a second
 * request while it runs answers `busy`, and `whenIdle` waits for the promise that `save` gave, so
 * a reaction that the caller of `save` registered runs before the wait goes on.
 */
function createDeferredSaveStep() {
  let pending: Held<ProjectSaveResult> | null = null;
  let running: Promise<ProjectSaveResult> | null = null;
  const save = vi.fn((_mode: "save" | "saveAs"): Promise<ProjectSaveResult> => {
    if (running !== null) {
      return Promise.resolve({ status: "busy" });
    }
    const answer = held<ProjectSaveResult>();
    pending = answer;
    running = answer.promise.finally(() => {
      running = null;
    });
    return running;
  });
  return {
    save,
    isRunning: () => running !== null,
    whenIdle: async () => {
      while (running !== null) {
        await running.catch(() => undefined);
      }
    },
    /** Ends the write that runs with `result`. */
    finish: (result: ProjectSaveResult) => {
      pending?.resolve(result);
      pending = null;
    },
  };
}

describe("the open of a project with one save step for the guard and the open", () => {
  /**
   * A guard and a real open step over one deferred save step. The open step gets the save step
   * as the page gives it, which reports a failed save itself (`reportingSaveStep`).
   */
  function sharedSave(input: QuitGuardInput) {
    const saveStep = createDeferredSaveStep();
    const loading = held<LoadProjectResult>();
    const loadProject = vi.fn((_path: string) => loading.promise);
    let hasChanges = true;
    let report: (error: ProjectSaveError) => void = () => undefined;
    const context = setup(input, {
      saveStep,
      createOpenStep: (ask) =>
        createProjectOpenStep({
          saveStep: reportingSaveStep(saveStep, (error) => {
            report(error);
          }),
          ask,
          isOtherDialogOpen: () => false,
          pickFile: () => Promise.resolve(null),
          staleExportOpenStep: () => undefined,
          hasChangesToSave: () => hasChanges,
          loadProject,
          runInImportLine: (task) => task(),
        }),
    });
    report = context.reportSaveError;
    return {
      ...context,
      saveStep,
      loadProject,
      setChanges: (next: boolean) => {
        hasChanges = next;
      },
    };
  }

  it("takes no Clear Timeline during the write of Save, and the open goes on after it", async () => {
    const context = sharedSave(MODIFIED_FILE);
    const { guard, saveStep, loadProject, clearTimeline } = context;

    const request = guard.requestOpen("/p/other.qcproj");
    await flush();
    expect(guard.store.getState().prompt?.kind).toBe("open");
    guard.confirm();
    await flush();
    expect(saveStep.save).toHaveBeenCalledTimes(1);
    expect(saveStep.isRunning()).toBe(true);

    guard.requestClear();
    await guard.requestOpen("/v/a.mp4");
    expect(guard.store.getState().prompt).toBeNull();
    expect(clearTimeline).not.toHaveBeenCalled();

    context.setChanges(false);
    saveStep.finish(SAVED);
    await flush();

    expect(loadProject).toHaveBeenCalledWith("/p/other.qcproj");
    expect(guard.openStep.store.getState().phase.kind).toBe("loading");
    guard.openStep.cancel();
    await expect(request).resolves.toEqual({ status: "canceled" });
    expect(guard.canOpen()).toBe(true);
  });

  it("reports a failed write one time when a quit stopped the open during it, and does not quit", async () => {
    const { guard, saveStep, loadProject, confirmQuit, reportSaveError } =
      sharedSave(MODIFIED_FILE);

    const request = guard.requestOpen("/p/other.qcproj");
    await flush();
    guard.confirm();
    await flush();
    expect(saveStep.isRunning()).toBe(true);

    guard.requestQuit();
    await expect(request).resolves.toEqual({ status: "canceled" });
    expect(guard.store.getState().prompt).toBeNull();

    saveStep.finish({ status: "failed", error: SAVE_ERROR });
    await flush();

    expect(reportSaveError).toHaveBeenCalledTimes(1);
    expect(reportSaveError).toHaveBeenCalledWith(SAVE_ERROR);
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
    expect(loadProject).not.toHaveBeenCalled();
  });

  it("reports a failed write one time when the open stops on it", async () => {
    const { guard, saveStep, reportSaveError } = sharedSave(MODIFIED_FILE);

    const request = guard.requestOpen("/p/other.qcproj");
    await flush();
    guard.confirm();
    await flush();
    saveStep.finish({ status: "failed", error: SAVE_ERROR });

    await expect(request).resolves.toEqual({
      status: "stopped",
      saveError: SAVE_ERROR,
    });
    expect(reportSaveError).toHaveBeenCalledTimes(1);
  });
});

describe("the open of a project waits for a trim that waits to commit (ADR 030, ADR 072)", () => {
  it("starts the open step only after the trim settled", async () => {
    const open = createOpenStepFake();
    const trim = held<void>();
    const { guard } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
      waitForTrimCommit: () => trim.promise,
    });

    const request = guard.requestOpen("/p/cut.qcproj");
    await flush();
    expect(open.step.open).not.toHaveBeenCalled();
    // The wait is a part of the open flow.
    expect(guard.canOpen()).toBe(false);

    trim.resolve();
    await flush();
    expect(open.step.open).toHaveBeenCalledWith("/p/cut.qcproj");
    open.results[0]?.resolve({ status: "opened", path: "/p/cut.qcproj" });
    await expect(request).resolves.toEqual({ status: "opened", path: "/p/cut.qcproj" });
  });

  it("starts the open step in the same call while no trim waits", () => {
    const open = createOpenStepFake();
    const { guard } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
      waitForTrimCommit: () => null,
    });

    void guard.requestOpen("/p/cut.qcproj");

    expect(open.step.open).toHaveBeenCalledTimes(1);
  });

  it("stops the open on a quit during the wait, and the open step never starts", async () => {
    const open = createOpenStepFake();
    const trim = held<void>();
    const { guard } = setup(WITH_SEGMENTS, {
      createOpenStep: open.createOpenStep,
      waitForTrimCommit: () => trim.promise,
    });

    const request = guard.requestOpen("/p/cut.qcproj");
    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");

    trim.resolve();
    await expect(request).resolves.toEqual({ status: "canceled" });
    expect(open.step.open).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });
});
