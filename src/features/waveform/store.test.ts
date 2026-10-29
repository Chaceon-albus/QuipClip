import { describe, expect, it } from "vitest";
import {
  createWaveformStore,
  IDLE_WAVEFORM_SOURCE,
  selectWaveformSource,
} from "./store";
import { NO_WAVEFORM_FLAGS } from "./types";

function setup() {
  let clock = 0;
  const store = createWaveformStore({ now: () => clock });
  return {
    store,
    advance: (ms: number) => {
      clock += ms;
    },
    source: (id = "s1") => selectWaveformSource(store.getState(), id),
  };
}

describe("createWaveformStore", () => {
  it("starts with every source idle and no job", () => {
    const { store, source } = setup();
    expect(store.getState().runningSourceId).toBeNull();
    expect(source()).toEqual(IDLE_WAVEFORM_SOURCE);
  });

  it("runs a job, notes the cache, and ends ready with the flags", () => {
    const { store, source } = setup();
    store.getState().begin("s1");
    expect(store.getState().runningSourceId).toBe("s1");
    expect(source().phase).toBe("running");
    // Unknown until the reply of the start.
    expect(source().cached).toBeNull();
    store.getState().setCached("s1", true);
    expect(source().cached).toBe(true);
    const flags = { ...NO_WAVEFORM_FLAGS, truncated: true };
    store.getState().finish("s1", { phase: "ready", cached: true, flags });
    expect(store.getState().runningSourceId).toBeNull();
    expect(source()).toMatchObject({
      phase: "ready",
      cached: true,
      flags,
      progress: null,
    });
  });

  it("ends failed with the error, and idle with no entry", () => {
    const { store, source } = setup();
    store.getState().begin("s1");
    store.getState().dismissNotice("s1");
    store.getState().finish("s1", {
      phase: "failed",
      errorCode: "readFailed",
      errorDetail: "EIO",
    });
    expect(source()).toMatchObject({
      phase: "failed",
      errorCode: "readFailed",
      errorDetail: "EIO",
      noticeDismissed: false,
    });
    store.getState().begin("s1");
    store.getState().finish("s1", { phase: "idle" });
    expect(store.getState().sources).toEqual({});
  });

  it("throttles the progress to 4 updates each second", () => {
    const { store, source, advance } = setup();
    store.getState().begin("s1");
    store.getState().setProgress("s1", 0.1);
    expect(source().progress).toBe(0.1);
    advance(100);
    store.getState().setProgress("s1", 0.2);
    expect(source().progress).toBe(0.1);
    advance(150);
    store.getState().setProgress("s1", 0.3);
    expect(source().progress).toBe(0.3);
  });

  it("ignores the progress and the cache flag of a source that does not run", () => {
    const { store, source } = setup();
    store.getState().setProgress("s1", 0.5);
    store.getState().setCached("s1", true);
    expect(source()).toEqual(IDLE_WAVEFORM_SOURCE);
  });

  it("dismisses the notice of a source that is not idle", () => {
    const { store, source } = setup();
    store.getState().dismissNotice("s1");
    expect(store.getState().sources).toEqual({});
    store.getState().begin("s1");
    store.getState().dismissNotice("s1");
    expect(source().noticeDismissed).toBe(true);
  });

  it("resets a source that does not run, and keeps one that runs", () => {
    const { store, source } = setup();
    store.getState().begin("s1");
    store.getState().reset("s1");
    expect(source().phase).toBe("running");
    store
      .getState()
      .finish("s1", { phase: "ready", cached: false, flags: NO_WAVEFORM_FLAGS });
    store.getState().reset("s1");
    expect(source()).toEqual(IDLE_WAVEFORM_SOURCE);
  });

  it("keeps the slot of another source when one finishes", () => {
    const { store } = setup();
    store.getState().begin("s2");
    store.getState().finish("s1", { phase: "idle" });
    expect(store.getState().runningSourceId).toBe("s2");
  });
});
