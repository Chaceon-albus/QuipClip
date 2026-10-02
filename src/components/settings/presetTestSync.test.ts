import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createFfmpegStore } from "@/features/ffmpeg/store";
import {
  CapabilityProbeError,
  type CapabilityProbeEvent,
  type CapabilityProbeForcedEvent,
  type CapabilityProbeStart,
  type FfmpegStatus,
} from "@/features/ffmpeg/types";
import {
  binaryKeyOf,
  subscribePresetTestSources,
  type PresetTestSourceStores,
} from "./presetTestSync";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

/**
 * Two small stores with the fields that the sources read. The other fields of the real states
 * are absent, so each store is cast to the state type it stands for.
 */
function stores() {
  const settings = createStore<{ settings: { revision: number } | null }>()(() => ({
    settings: null,
  }));
  const ffmpeg = createStore<{
    status: FfmpegStatus;
    paths: { ffmpeg: string; ffprobe: string } | null;
    version: string | null;
    done: number;
  }>()(() => ({ status: "idle", paths: null, version: null, done: 0 }));
  return {
    settings,
    ffmpeg,
    sources: {
      settings: settings as unknown as PresetTestSourceStores["settings"],
      ffmpeg: ffmpeg as unknown as PresetTestSourceStores["ffmpeg"],
    },
  };
}

function handlers() {
  return { changed: vi.fn(), binary: vi.fn() };
}

const HOMEBREW = {
  ffmpeg: "/opt/homebrew/bin/ffmpeg",
  ffprobe: "/opt/homebrew/bin/ffprobe",
};

const READY = { status: "ready", paths: HOMEBREW, version: "9.0.2" } as const;

describe("binaryKeyOf", () => {
  it("names the binary of a finished probe by its path and its version", () => {
    expect(binaryKeyOf(READY)).toBe(
      JSON.stringify(["/opt/homebrew/bin/ffmpeg", "9.0.2"]),
    );
    expect(binaryKeyOf(READY)).not.toBe(binaryKeyOf({ ...READY, version: "9.0.3" }));
  });

  it("names no binary before a probe finished, or after it found none", () => {
    expect(binaryKeyOf({ status: "idle", paths: null, version: null })).toBeNull();
    expect(binaryKeyOf({ ...READY, status: "probing", version: null })).toBeNull();
    expect(binaryKeyOf({ ...READY, status: "probing" })).toBeNull();
    expect(binaryKeyOf({ status: "missing", paths: null, version: null })).toBeNull();
  });
});

describe("subscribePresetTestSources", () => {
  it("reports the binary that is known when it starts", () => {
    const { ffmpeg, sources } = stores();
    ffmpeg.setState(READY);
    const calls = handlers();
    subscribePresetTestSources(calls, sources);
    expect(calls.binary).toHaveBeenCalledWith(binaryKeyOf(READY));
    expect(calls.changed).not.toHaveBeenCalled();
  });

  it("reports a new revision of the settings document, and not a write with the old one", () => {
    const { settings, sources } = stores();
    const calls = handlers();
    subscribePresetTestSources(calls, sources);

    settings.setState({ settings: { revision: 4 } });
    expect(calls.changed).toHaveBeenCalledTimes(1);
    // An optimistic save publishes its document with the revision it was built on.
    settings.setState({ settings: { revision: 4 } });
    expect(calls.changed).toHaveBeenCalledTimes(1);
    settings.setState({ settings: { revision: 5 } });
    expect(calls.changed).toHaveBeenCalledTimes(2);
    settings.setState({ settings: null });
    expect(calls.changed).toHaveBeenCalledTimes(3);
  });

  it("reports each change of the binary, and not the progress of a probe", () => {
    const { ffmpeg, sources } = stores();
    const calls = handlers();
    subscribePresetTestSources(calls, sources);
    expect(calls.binary).toHaveBeenLastCalledWith(null);

    ffmpeg.setState(READY);
    expect(calls.binary).toHaveBeenCalledTimes(2);
    ffmpeg.setState({ done: 3 });
    expect(calls.binary).toHaveBeenCalledTimes(2);
    ffmpeg.setState({ version: "9.0.3" });
    expect(calls.binary).toHaveBeenCalledTimes(3);
    expect(calls.binary).toHaveBeenLastCalledWith(
      binaryKeyOf({ ...READY, version: "9.0.3" }),
    );
    expect(calls.changed).not.toHaveBeenCalled();
  });

  it("stops reporting when it is stopped", () => {
    const { settings, ffmpeg, sources } = stores();
    const calls = handlers();
    const stop = subscribePresetTestSources(calls, sources);
    stop();

    settings.setState({ settings: { revision: 9 } });
    ffmpeg.setState(READY);
    expect(calls.changed).not.toHaveBeenCalled();
    expect(calls.binary).toHaveBeenCalledTimes(1);
  });

  it("reads the results again when a probe ends with no binary, once", () => {
    const { ffmpeg, sources } = stores();
    ffmpeg.setState(READY);
    const calls = handlers();
    subscribePresetTestSources(calls, sources);

    ffmpeg.setState({ status: "missing", paths: null, version: null });
    expect(calls.changed).toHaveBeenCalledTimes(1);
    ffmpeg.setState({ done: 0 });
    expect(calls.changed).toHaveBeenCalledTimes(1);
    ffmpeg.setState({ status: "locating" });
    ffmpeg.setState({ status: "failed" });
    expect(calls.changed).toHaveBeenCalledTimes(2);
  });
});

describe("subscribePresetTestSources with the ffmpeg store", () => {
  const START: CapabilityProbeStart = {
    runId: "run-1",
    ffmpeg: HOMEBREW.ffmpeg,
    ffprobe: HOMEBREW.ffprobe,
    origin: "path",
  };
  const LICENSE = { gpl: true, nonfree: false, version3: true };

  /** A real ffmpeg store whose events the test sends, and the binary keys that it reported. */
  function probedStore() {
    let emit: (event: CapabilityProbeEvent) => void = () => undefined;
    let takeOver: (event: CapabilityProbeForcedEvent) => void = () => undefined;
    let run = 0;
    let missing = false;
    const ffmpeg = createFfmpegStore({
      subscribeCapabilityProbe: (handler) => {
        emit = handler;
        return Promise.resolve(() => undefined);
      },
      subscribeForcedCapabilityProbe: (handler) => {
        takeOver = handler;
        return Promise.resolve(() => undefined);
      },
      startCapabilityProbe: () =>
        missing
          ? Promise.reject(new CapabilityProbeError({ code: "ffmpegPairMissing" }))
          : Promise.resolve({ ...START, runId: `run-${++run}` }),
    });
    const { sources } = stores();
    const calls = handlers();
    subscribePresetTestSources(calls, { settings: sources.settings, ffmpeg });

    function finish(start: CapabilityProbeStart, version: string): void {
      emit({
        event: "located",
        runId: start.runId,
        ffmpeg: start.ffmpeg,
        ffprobe: start.ffprobe,
        origin: start.origin,
        version,
        license: LICENSE,
      });
      emit({
        event: "finished",
        runId: start.runId,
        source: "probe",
        report: { version, license: LICENSE, hwaccels: [], encoders: [], probedAt: 0 },
      });
    }

    async function probe(version: string): Promise<void> {
      const start = await ffmpeg.getState().startProbe(true);
      if (start === null) {
        throw new Error("the probe did not start");
      }
      finish(start, version);
    }

    /** A probe that the other window forced, which this window takes over. */
    function forced(version: string): void {
      const start = { ...START, runId: `forced-${++run}` };
      takeOver({ outcome: "started", origin: "settings", start });
      finish(start, version);
    }

    /** A probe that finds no FFmpeg. */
    async function lose(): Promise<void> {
      missing = true;
      await ffmpeg.getState().startProbe(true);
      missing = false;
    }

    const keys = () =>
      (calls.binary.mock.calls as [string | null][])
        .map(([key]) => key)
        .filter((key) => key !== null);
    return { probe, forced, lose, keys, calls };
  }

  it("reports one key for each probe of the same binary, start, located and finished", async () => {
    const { probe, keys } = probedStore();
    await probe("9.0.2");
    expect(keys()).toEqual([binaryKeyOf(READY)]);
    // The key goes away while the second probe runs, and comes back the same.
    await probe("9.0.2");
    expect(keys()).toEqual([binaryKeyOf(READY), binaryKeyOf(READY)]);
  });

  it("reports a new key when a probe finds another version", async () => {
    const { probe, keys } = probedStore();
    await probe("9.0.2");
    await probe("9.0.3");
    expect(keys()[keys().length - 1]).toBe(binaryKeyOf({ ...READY, version: "9.0.3" }));
  });

  it("reports the same key for a probe that the other window forced", async () => {
    const { probe, forced, keys } = probedStore();
    await probe("9.0.2");
    forced("9.0.2");
    expect(keys()).toEqual([binaryKeyOf(READY), binaryKeyOf(READY)]);
  });

  it("reads the results again once when a probe finds no FFmpeg", async () => {
    const { probe, lose, calls } = probedStore();
    await probe("9.0.2");
    expect(calls.changed).not.toHaveBeenCalled();
    await lose();
    expect(calls.changed).toHaveBeenCalledTimes(1);
    expect(calls.binary).toHaveBeenLastCalledWith(null);
  });
});
