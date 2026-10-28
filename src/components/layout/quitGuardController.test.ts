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
import { settingsWindowDraftStore } from "@/features/settings/settingsWindowDraft";
import type { Pts, Segment } from "@/types/project";
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

const OPEN_SOURCE = "s-open";

function createSegment(id: string): Segment {
  return { id, sourceId: OPEN_SOURCE, inPts: "0" as Pts, outPts: "1000" as Pts };
}

function createInput(overrides: Partial<QuitGuardInput> = {}): QuitGuardInput {
  return {
    timeline: { sourceId: OPEN_SOURCE, segments: [], pendingInPts: null },
    exportStatus: "idle",
    exportTracking: false,
    unsavedPresetName: null,
    queuedExports: 0,
    ...overrides,
  };
}

const WITH_SEGMENTS = createInput({
  timeline: {
    sourceId: OPEN_SOURCE,
    segments: [createSegment("a"), createSegment("b")],
    pendingInPts: null,
  },
});

// The guard only passes the result through, so any value stands for it.
const IMPORT_RESULT = ["clip-1"];

/** A confirm_quit that never settles, as when the application ends before it answers. */
function neverSettles(): Promise<unknown> {
  return new Promise(() => undefined);
}

function setup(input: QuitGuardInput, overrides: QuitGuardDependencies = {}) {
  let current = input;
  const confirmQuit = vi.fn(neverSettles);
  const importPaths = vi.fn((_paths: readonly string[], _index: number | null) =>
    Promise.resolve<unknown>(IMPORT_RESULT),
  );
  const clearTimeline = vi.fn();
  const guard = createQuitGuard({
    readInput: () => current,
    confirmQuit,
    importPaths,
    clearTimeline,
    ...overrides,
  });
  return {
    guard,
    confirmQuit,
    importPaths,
    clearTimeline,
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
        segments: 0,
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
    const { guard } = setup(WITH_SEGMENTS, { confirmQuit });

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
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    guard.confirm();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("changes nothing on cancel, and asks again on the next request", () => {
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    guard.cancel();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();

    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("ignores the cancel that Radix sends after the confirm button", () => {
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

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
      segments: 2,
      pendingIn: false,
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
        segments: 0,
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
