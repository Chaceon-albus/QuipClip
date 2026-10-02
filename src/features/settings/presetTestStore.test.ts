import { describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@/lib/ipc";
import {
  PresetTestError,
  presetTestFingerprint,
  type PresetTestEntry,
  type PresetTestResponse,
  type PresetTestResult,
} from "./presetTest";
import {
  createPresetTestStore,
  latestPresetTestResult,
  selectPresetTestView,
  startPresetTestSync,
  type PresetTestRun,
  type PresetTestSelection,
  type PresetTestSourceHandlers,
} from "./presetTestStore";
import type { Preset } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function preset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-h264-mp4",
    name: "H.264 MP4",
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    pixelFormat: "yuv420p",
    videoOptions: [],
    audioOptions: [],
    ...overrides,
  };
}

function result(
  status: PresetTestResult["status"],
  testedAt: number,
  line?: string,
): PresetTestResult {
  return line === undefined ? { status, testedAt } : { status, testedAt, line };
}

function response(value: PresetTestResult, stored = true): PresetTestResponse {
  return { result: value, stored };
}

/** A promise with its two settle functions, for an IPC call that the test answers by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("refreshStored", () => {
  it("publishes the stored results by preset id and counts the read", async () => {
    const store = createPresetTestStore({
      presetTestResults: () =>
        Promise.resolve([{ presetId: "a", result: result("passed", 100) }]),
    });
    expect(store.getState().storedStatus).toBe("idle");

    const read = store.getState().refreshStored();
    expect(store.getState().storedStatus).toBe("loading");
    await read;

    expect(store.getState().stored).toEqual({ a: result("passed", 100) });
    expect(store.getState().storedStatus).toBe("ready");
    expect(store.getState().storedReads).toBe(1);
  });

  it("lets only the newest read publish", async () => {
    const first = deferred<PresetTestEntry[]>();
    const second = deferred<PresetTestEntry[]>();
    const answers = [first.promise, second.promise];
    const store = createPresetTestStore({ presetTestResults: () => answers.shift()! });

    const older = store.getState().refreshStored();
    const newer = store.getState().refreshStored();
    second.resolve([{ presetId: "new", result: result("passed", 200) }]);
    await newer;
    first.resolve([{ presetId: "old", result: result("failed", 100) }]);
    await older;

    expect(store.getState().stored).toEqual({ new: result("passed", 200) });
    expect(store.getState().storedReads).toBe(1);
  });

  it("keeps the earlier results on screen while a read runs, and empties them when it fails", async () => {
    const answers: Array<() => Promise<PresetTestEntry[]>> = [
      () => Promise.resolve([{ presetId: "a", result: result("passed", 100) }]),
      () => Promise.reject(new PresetTestError("ffmpegPairMissing")),
    ];
    const store = createPresetTestStore({
      presetTestResults: () => answers.shift()!(),
    });
    await store.getState().refreshStored();

    const failing = store.getState().refreshStored();
    expect(store.getState().storedStatus).toBe("ready");
    expect(store.getState().stored).toEqual({ a: result("passed", 100) });
    await failing;

    expect(store.getState().storedStatus).toBe("error");
    expect(store.getState().stored).toEqual({});
    expect(store.getState().storedReads).toBe(2);
  });
});

describe("runTest", () => {
  it("shows the run while it runs and keeps its result under the fingerprint", async () => {
    const answer = deferred<PresetTestResponse>();
    const testPreset = vi.fn(() => answer.promise);
    const store = createPresetTestStore({ testPreset });
    const draft = preset({ name: "Unsaved" });
    const key = presetTestFingerprint(draft);

    const run = store.getState().runTest(draft);
    expect(store.getState().runs[key]).toEqual({ status: "running", generation: 0 });
    expect(testPreset).toHaveBeenCalledWith(draft);

    answer.resolve(response(result("passedWithWarnings", 300, "[warning] x")));
    const finished: PresetTestRun = {
      status: "finished",
      result: result("passedWithWarnings", 300, "[warning] x"),
      stored: true,
      generation: 0,
    };
    await expect(run).resolves.toEqual(finished);
    expect(store.getState().runs[key]).toEqual(finished);
  });

  it("keeps a result that Rust did not store as one that was not stored", async () => {
    const store = createPresetTestStore({
      testPreset: () => Promise.resolve(response(result("failed", 300), false)),
    });
    const run = await store.getState().runTest(preset());
    expect(run).toMatchObject({ status: "finished", stored: false });
    expect(selectPresetTestView(store.getState(), preset(), preset())).toEqual({
      kind: "result",
      result: result("failed", 300),
      stored: false,
    });
  });

  it("joins a second test of the same fingerprint instead of starting another", async () => {
    const answer = deferred<PresetTestResponse>();
    const testPreset = vi.fn(() => answer.promise);
    const store = createPresetTestStore({ testPreset });

    const first = store.getState().runTest(preset());
    const second = store.getState().runTest(preset({ id: "copy", name: "Copy" }));
    expect(second).toBe(first);
    expect(testPreset).toHaveBeenCalledTimes(1);

    answer.resolve(response(result("passed", 300)));
    await first;
    // The run ended, so a new test runs again.
    testPreset.mockResolvedValueOnce(response(result("passed", 301)));
    await store.getState().runTest(preset());
    expect(testPreset).toHaveBeenCalledTimes(2);
  });

  it("records a refusal with its code and the time it arrived", async () => {
    const store = createPresetTestStore({
      testPreset: () => Promise.reject(new PresetTestError("exportRunning")),
      now: () => 500,
    });
    const run = await store.getState().runTest(preset());
    expect(run).toMatchObject({ status: "failed", at: 500, generation: 0 });
    expect(run.status === "failed" && run.error.code).toBe("exportRunning");
  });
});

describe("a change of binary", () => {
  it("raises the generation only for a binary other than the last known one", () => {
    const store = createPresetTestStore();
    expect(store.getState().noteBinary(null)).toBe(false);
    expect(store.getState().noteBinary("a")).toBe(false);
    expect(store.getState().noteBinary("a")).toBe(false);
    // A probe that starts again knows no binary for a moment.
    expect(store.getState().noteBinary(null)).toBe(false);
    expect(store.getState().noteBinary("a")).toBe(false);
    expect(store.getState().generation).toBe(0);
    expect(store.getState().noteBinary("b")).toBe(true);
    expect(store.getState().generation).toBe(1);
  });

  it("hides the runs and empties the stored results of the binary before", async () => {
    const store = createPresetTestStore({
      testPreset: () => Promise.resolve(response(result("passed", 300))),
      presetTestResults: () =>
        Promise.resolve([{ presetId: preset().id, result: result("passed", 200) }]),
    });
    store.getState().noteBinary("old");
    await store.getState().refreshStored();
    await store.getState().runTest(preset());
    expect(latestPresetTestResult(store.getState(), preset(), preset())).not.toBeNull();

    store.getState().noteBinary("new");

    expect(store.getState().stored).toEqual({});
    expect(store.getState().storedStatus).toBe("loading");
    expect(latestPresetTestResult(store.getState(), preset(), preset())).toBeNull();
    expect(selectPresetTestView(store.getState(), preset(), preset())).toEqual({
      kind: "none",
    });
  });

  it("drops the read that was in flight at the switch", async () => {
    const read = deferred<PresetTestEntry[]>();
    const store = createPresetTestStore({ presetTestResults: () => read.promise });
    store.getState().noteBinary("old");
    const pending = store.getState().refreshStored();

    store.getState().noteBinary("new");
    read.resolve([{ presetId: preset().id, result: result("passed", 200) }]);
    await pending;

    expect(store.getState().stored).toEqual({});
    expect(store.getState().storedReads).toBe(0);
  });

  it("ignores the late result of a test that ran at the switch, and keeps the newer run", async () => {
    const oldAnswer = deferred<PresetTestResponse>();
    const newAnswer = deferred<PresetTestResponse>();
    const answers = [oldAnswer.promise, newAnswer.promise];
    const store = createPresetTestStore({ testPreset: () => answers.shift()! });
    const key = presetTestFingerprint(preset());
    store.getState().noteBinary("old");

    const oldRun = store.getState().runTest(preset());
    store.getState().noteBinary("new");
    // The test of the binary before does not show as running for the new binary.
    expect(selectPresetTestView(store.getState(), preset(), preset())).toEqual({
      kind: "none",
    });
    // A test of the new binary does not join the old one.
    const newRun = store.getState().runTest(preset());
    expect(newRun).not.toBe(oldRun);

    oldAnswer.resolve(response(result("failed", 300)));
    await oldRun;
    expect(store.getState().runs[key]).toEqual({ status: "running", generation: 1 });

    newAnswer.resolve(response(result("passed", 301)));
    await newRun;
    expect(selectPresetTestView(store.getState(), preset(), preset())).toEqual({
      kind: "result",
      result: result("passed", 301),
      stored: true,
    });
  });

  it("does not show a late result of the binary before when no newer run exists", async () => {
    const answer = deferred<PresetTestResponse>();
    const store = createPresetTestStore({ testPreset: () => answer.promise });
    store.getState().noteBinary("old");
    const run = store.getState().runTest(preset());
    store.getState().noteBinary("new");

    answer.resolve(response(result("failed", 300)));
    await run;

    expect(latestPresetTestResult(store.getState(), preset(), preset())).toBeNull();
    expect(selectPresetTestView(store.getState(), preset(), preset())).toEqual({
      kind: "none",
    });
  });
});

describe("selecting what to show", () => {
  const saved = preset();
  const key = presetTestFingerprint(saved);

  function state(overrides: Partial<PresetTestSelection> = {}): PresetTestSelection {
    return { stored: {}, runs: {}, generation: 0, ...overrides };
  }

  function finished(value: PresetTestResult, stored = true): PresetTestRun {
    return { status: "finished", result: value, stored, generation: 0 };
  }

  it("shows nothing for a preset with no result", () => {
    expect(selectPresetTestView(state(), saved, saved)).toEqual({ kind: "none" });
    expect(latestPresetTestResult(state(), saved, saved)).toBeNull();
  });

  it("shows the stored result of a saved preset as stored", () => {
    const stored = { [saved.id]: result("failed", 100, "[error] x") };
    expect(selectPresetTestView(state({ stored }), saved, saved)).toEqual({
      kind: "result",
      result: result("failed", 100, "[error] x"),
      stored: true,
    });
  });

  it("shows the stored result for a draft only while its tested fields are the stored ones", () => {
    const stored = { [saved.id]: result("passed", 100) };
    const renamed = preset({ name: "Renamed draft" });
    expect(selectPresetTestView(state({ stored }), renamed, saved).kind).toBe("result");

    const retuned = preset({ videoOptions: [{ name: "preset", value: "fast" }] });
    expect(selectPresetTestView(state({ stored }), retuned, saved)).toEqual({
      kind: "none",
    });
    // Another preset never reads the stored result of this one.
    expect(
      selectPresetTestView(state({ stored }), preset({ id: "other" }), saved),
    ).toEqual({ kind: "none" });
  });

  it("shows a run of this window while it runs, over every result", () => {
    const stored = { [saved.id]: result("passed", 100) };
    const runs = { [key]: { status: "running" as const, generation: 0 } };
    expect(selectPresetTestView(state({ stored, runs }), saved, saved)).toEqual({
      kind: "running",
    });
    // A row shows the newest known result, not the run.
    expect(latestPresetTestResult(state({ stored, runs }), saved, saved)).toEqual(
      result("passed", 100),
    );
  });

  it("shows the newer of a result of this window and the stored result, this window on a tie", () => {
    const own = { [key]: finished(result("failed", 200), false) };
    expect(
      selectPresetTestView(
        state({ stored: { [saved.id]: result("passed", 100) }, runs: own }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "result", result: result("failed", 200), stored: false });
    expect(
      selectPresetTestView(
        state({ stored: { [saved.id]: result("passed", 300) }, runs: own }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "result", result: result("passed", 300), stored: true });
    expect(
      latestPresetTestResult(
        state({ stored: { [saved.id]: result("passed", 200) }, runs: own }),
        saved,
        saved,
      ),
    ).toEqual(result("failed", 200));
  });

  it("ignores a run of an older generation", () => {
    const runs = { [key]: finished(result("passed", 200)) };
    expect(selectPresetTestView(state({ runs, generation: 1 }), saved, saved)).toEqual({
      kind: "none",
    });
    expect(
      selectPresetTestView(
        state({ runs: { [key]: { status: "running", generation: 0 } }, generation: 1 }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "none" });
  });

  it("shows a refusal until a newer result arrives", () => {
    const error = new PresetTestError("exportRunning");
    const runs = {
      [key]: { status: "failed" as const, error, at: 200, generation: 0 },
    };
    expect(
      selectPresetTestView(
        state({ stored: { [saved.id]: result("passed", 100) }, runs }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "error", error });
    expect(
      selectPresetTestView(
        state({ stored: { [saved.id]: result("passed", 200) }, runs }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "error", error });
    // The other window tested later, and its stored result wins.
    expect(
      selectPresetTestView(
        state({ stored: { [saved.id]: result("passed", 201) }, runs }),
        saved,
        saved,
      ),
    ).toEqual({ kind: "result", result: result("passed", 201), stored: true });
    expect(selectPresetTestView(state({ runs }), saved, saved)).toEqual({
      kind: "error",
      error,
    });
  });
});

describe("startPresetTestSync", () => {
  function fakeEvent() {
    let handler: ((payload: unknown) => void) | null = null;
    const ready = deferred<UnlistenFn>();
    const unlisten = vi.fn();
    return {
      subscribe: (next: (payload: unknown) => void) => {
        handler = next;
        return ready.promise;
      },
      emit: (payload: unknown) => handler?.(payload),
      ready: () => ready.resolve(unlisten),
      unlisten,
    };
  }

  it("reads once the subscription stands, then for each source change and each foreign test", async () => {
    const presetTestResults = vi.fn(() => Promise.resolve([]));
    const store = createPresetTestStore({ presetTestResults });
    const event = fakeEvent();
    let handlers: PresetTestSourceHandlers | null = null;
    const stopSources = vi.fn();

    const stop = startPresetTestSync({
      store,
      subscribeTested: event.subscribe,
      ownLabel: "main",
      subscribeSources: (next) => {
        handlers = next;
        next.binary("first");
        return stopSources;
      },
    });
    // The first binary is noted, and raises nothing.
    expect(store.getState().generation).toBe(0);
    expect(presetTestResults).not.toHaveBeenCalled();

    event.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(presetTestResults).toHaveBeenCalledTimes(1);

    handlers!.changed();
    expect(presetTestResults).toHaveBeenCalledTimes(2);

    // The same binary again reads nothing; another binary raises the generation and reads.
    handlers!.binary("first");
    expect(presetTestResults).toHaveBeenCalledTimes(2);
    handlers!.binary("second");
    expect(store.getState().generation).toBe(1);
    expect(presetTestResults).toHaveBeenCalledTimes(3);

    event.emit({ origin: "settings" });
    expect(presetTestResults).toHaveBeenCalledTimes(4);

    // The test of this window holds its result already, and a malformed payload reads nothing.
    event.emit({ origin: "main" });
    event.emit({ origin: "" });
    expect(presetTestResults).toHaveBeenCalledTimes(4);

    stop();
    expect(stopSources).toHaveBeenCalledTimes(1);
    expect(event.unlisten).toHaveBeenCalledTimes(1);
    event.emit({ origin: "settings" });
    expect(presetTestResults).toHaveBeenCalledTimes(4);
  });
});
