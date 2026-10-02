import { describe, expect, it, vi } from "vitest";
import type { EventSubscribe, UnlistenFn } from "@/lib/ipc";
import {
  startSettingsChangedSync,
  validateSettingsChangedPayload,
} from "./settingsSync";
import type { Settings } from "./types";

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    revision: 4,
    presets: [
      {
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
      },
    ],
    activePresetId: "default-h264-mp4",
    ...overrides,
  };
}

/** A subscription that resolves at once and delivers what the test sends. */
function createBus() {
  let handler: ((payload: unknown) => void) | null = null;
  const unlisten = vi.fn<UnlistenFn>();
  const subscribe: EventSubscribe = (next) => {
    handler = next;
    return Promise.resolve(unlisten);
  };
  return {
    subscribe,
    unlisten,
    send: (payload: unknown) => {
      handler?.(payload);
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("validateSettingsChangedPayload", () => {
  it("reads a valid document and the window that wrote it", () => {
    const settings = createSettings();
    expect(validateSettingsChangedPayload({ settings, origin: "settings" })).toEqual({
      settings,
      origin: "settings",
    });
  });

  it("refuses a payload without a valid document or a window label", () => {
    const settings = createSettings();
    expect(validateSettingsChangedPayload(null)).toBeNull();
    expect(validateSettingsChangedPayload("settings")).toBeNull();
    expect(validateSettingsChangedPayload({ settings })).toBeNull();
    expect(validateSettingsChangedPayload({ settings, origin: "" })).toBeNull();
    expect(validateSettingsChangedPayload({ settings, origin: 1 })).toBeNull();
    expect(
      validateSettingsChangedPayload({
        settings: { ...settings, revision: -1 },
        origin: "main",
      }),
    ).toBeNull();
    expect(
      validateSettingsChangedPayload({
        settings: { ...settings, schemaVersion: 2 },
        origin: "main",
      }),
    ).toBeNull();
  });
});

describe("startSettingsChangedSync", () => {
  it("hands a document of the other window to the store", async () => {
    const bus = createBus();
    const adopt = vi.fn();
    const stop = startSettingsChangedSync({
      subscribe: bus.subscribe,
      ownLabel: "main",
      adopt,
    });
    await flushPromises();

    const settings = createSettings({ revision: 9 });
    bus.send({ settings, origin: "settings" });
    expect(adopt).toHaveBeenCalledWith(settings);
    stop();
  });

  it("ignores the event of its own write and a malformed event", async () => {
    const bus = createBus();
    const adopt = vi.fn();
    const stop = startSettingsChangedSync({
      subscribe: bus.subscribe,
      ownLabel: "settings",
      adopt,
    });
    await flushPromises();

    bus.send({ settings: createSettings(), origin: "settings" });
    bus.send({ settings: { revision: 3 }, origin: "main" });
    bus.send(undefined);
    expect(adopt).not.toHaveBeenCalled();
    stop();
  });

  it("stops with the release and takes nothing after it", async () => {
    const bus = createBus();
    const adopt = vi.fn();
    const stop = startSettingsChangedSync({
      subscribe: bus.subscribe,
      ownLabel: "main",
      adopt,
    });
    await flushPromises();

    stop();
    bus.send({ settings: createSettings(), origin: "settings" });
    expect(bus.unlisten).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });
});
