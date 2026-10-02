import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOW_EVENTS, type EmitFn, type EventSubscribe } from "@/lib/ipc";
import {
  applyPreferenceChange,
  broadcastLanguagePreference,
  broadcastPreferenceChange,
  changeThemePreference,
  changeTimecodeFormat,
  startPreferenceSync,
  validatePreferenceChangedPayload,
  type PreferenceTargets,
} from "./preferenceSync";
import { createThemePreferenceStore, themePreferenceStore } from "./themePreference";
import {
  createTimecodePreferenceStore,
  timecodePreferenceStore,
} from "./timecodePreference";

/**
 * A fake of the Tauri event bus: every emit reaches every listener, the listener of the
 * emitting window included, as `listen` with the default target does.
 */
function createBus() {
  const listeners = new Set<(payload: unknown) => void>();
  const emitted: { event: string; payload: unknown }[] = [];
  const emit = vi.fn<EmitFn>((event, payload) => {
    emitted.push({ event, payload });
    for (const listener of listeners) {
      listener(payload);
    }
    return Promise.resolve();
  });
  const subscribe: EventSubscribe = (handler) => {
    listeners.add(handler);
    return Promise.resolve(() => {
      listeners.delete(handler);
    });
  };
  return { emit, subscribe, emitted };
}

function createTargets() {
  return {
    applyTheme: vi.fn<PreferenceTargets["applyTheme"]>(),
    applyLanguage: vi.fn<PreferenceTargets["applyLanguage"]>(),
    applyTimecodeFormat: vi.fn<PreferenceTargets["applyTimecodeFormat"]>(),
  } satisfies PreferenceTargets;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  themePreferenceStore.getState().setPreference("system");
  timecodePreferenceStore.getState().setFormat("frames");
});

describe("validatePreferenceChangedPayload", () => {
  it("reads each preference with a value that it takes", () => {
    expect(
      validatePreferenceChangedPayload({
        key: "theme",
        value: "dark",
        origin: "settings",
      }),
    ).toEqual({ key: "theme", value: "dark", origin: "settings" });
    expect(
      validatePreferenceChangedPayload({
        key: "language",
        value: "zh-CN",
        origin: "settings",
      }),
    ).toEqual({ key: "language", value: "zh-CN", origin: "settings" });
    expect(
      validatePreferenceChangedPayload({
        key: "timecodeFormat",
        value: "milliseconds",
        origin: "settings",
      }),
    ).toEqual({ key: "timecodeFormat", value: "milliseconds", origin: "settings" });
  });

  it("refuses an unknown preference, a value it does not take, and a missing window", () => {
    expect(validatePreferenceChangedPayload(null)).toBeNull();
    expect(
      validatePreferenceChangedPayload({
        key: "muted",
        value: true,
        origin: "settings",
      }),
    ).toBeNull();
    expect(
      validatePreferenceChangedPayload({
        key: "theme",
        value: "blue",
        origin: "settings",
      }),
    ).toBeNull();
    expect(
      validatePreferenceChangedPayload({
        key: "language",
        value: "fr",
        origin: "settings",
      }),
    ).toBeNull();
    expect(
      validatePreferenceChangedPayload({
        key: "timecodeFormat",
        value: "seconds",
        origin: "settings",
      }),
    ).toBeNull();
    expect(
      validatePreferenceChangedPayload({ key: "theme", value: "dark" }),
    ).toBeNull();
    expect(
      validatePreferenceChangedPayload({ key: "theme", value: "dark", origin: "" }),
    ).toBeNull();
  });
});

describe("broadcastPreferenceChange", () => {
  it("emits the change with the label of this window", () => {
    const bus = createBus();
    broadcastPreferenceChange(
      { key: "theme", value: "light" },
      { emit: bus.emit, ownLabel: "settings" },
    );
    expect(bus.emitted).toEqual([
      {
        event: WINDOW_EVENTS.PREFERENCES_CHANGED,
        payload: { key: "theme", value: "light", origin: "settings" },
      },
    ]);
  });

  it("emits nothing outside the Tauri shell, where the window has no label", () => {
    const bus = createBus();
    broadcastPreferenceChange(
      { key: "theme", value: "light" },
      { emit: bus.emit, ownLabel: null },
    );
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("survives an emit that rejects or throws", async () => {
    expect(() => {
      broadcastPreferenceChange(
        { key: "language", value: "en" },
        { emit: () => Promise.reject(new Error("refused")), ownLabel: "settings" },
      );
      broadcastPreferenceChange(
        { key: "language", value: "en" },
        {
          emit: () => {
            throw new Error("no runtime");
          },
          ownLabel: "settings",
        },
      );
    }).not.toThrow();
    await flushPromises();
  });

  it("sends a language that the language control applied", () => {
    const bus = createBus();
    broadcastLanguagePreference("zh-CN", { emit: bus.emit, ownLabel: "settings" });
    expect(bus.emitted[0]?.payload).toEqual({
      key: "language",
      value: "zh-CN",
      origin: "settings",
    });
  });
});

describe("changeThemePreference and changeTimecodeFormat", () => {
  it("apply the value in this window and send it", () => {
    const bus = createBus();
    changeThemePreference("dark", { emit: bus.emit, ownLabel: "settings" });
    changeTimecodeFormat("milliseconds", { emit: bus.emit, ownLabel: "settings" });

    expect(themePreferenceStore.getState().preference).toBe("dark");
    expect(timecodePreferenceStore.getState().format).toBe("milliseconds");
    expect(bus.emitted.map((entry) => entry.payload)).toEqual([
      { key: "theme", value: "dark", origin: "settings" },
      { key: "timecodeFormat", value: "milliseconds", origin: "settings" },
    ]);
  });

  it("ignore a value that the preference does not take", () => {
    const bus = createBus();
    changeThemePreference("blue" as never, { emit: bus.emit, ownLabel: "settings" });
    changeTimecodeFormat("seconds" as never, { emit: bus.emit, ownLabel: "settings" });
    expect(bus.emit).not.toHaveBeenCalled();
    expect(themePreferenceStore.getState().preference).toBe("system");
  });
});

describe("applyPreferenceChange", () => {
  it("routes each preference to its target", () => {
    const targets = createTargets();
    applyPreferenceChange({ key: "theme", value: "light" }, targets);
    applyPreferenceChange({ key: "language", value: "en" }, targets);
    applyPreferenceChange({ key: "timecodeFormat", value: "frames" }, targets);
    expect(targets.applyTheme).toHaveBeenCalledWith("light");
    expect(targets.applyLanguage).toHaveBeenCalledWith("en");
    expect(targets.applyTimecodeFormat).toHaveBeenCalledWith("frames");
  });
});

describe("startPreferenceSync", () => {
  it("applies a change of another window and ignores its own and a malformed one", async () => {
    const bus = createBus();
    const targets = createTargets();
    const stop = startPreferenceSync({
      subscribe: bus.subscribe,
      ownLabel: "main",
      targets,
    });
    await flushPromises();

    await bus.emit(WINDOW_EVENTS.PREFERENCES_CHANGED, {
      key: "theme",
      value: "dark",
      origin: "main",
    });
    await bus.emit(WINDOW_EVENTS.PREFERENCES_CHANGED, { key: "theme", value: 7 });
    expect(targets.applyTheme).not.toHaveBeenCalled();

    await bus.emit(WINDOW_EVENTS.PREFERENCES_CHANGED, {
      key: "theme",
      value: "dark",
      origin: "settings",
    });
    expect(targets.applyTheme).toHaveBeenCalledWith("dark");

    stop();
    await bus.emit(WINDOW_EVENTS.PREFERENCES_CHANGED, {
      key: "theme",
      value: "light",
      origin: "settings",
    });
    expect(targets.applyTheme).toHaveBeenCalledTimes(1);
  });

  it("carries a change from the Settings window to the main window, once", async () => {
    // The Settings window is the module stores; the main window has stores of its own.
    const bus = createBus();
    const mainTheme = createThemePreferenceStore({ storage: null });
    const mainTimecode = createTimecodePreferenceStore({ storage: null });
    const mainLanguage = vi.fn();
    const settingsTargets = createTargets();
    const stopMain = startPreferenceSync({
      subscribe: bus.subscribe,
      ownLabel: "main",
      targets: {
        applyTheme: (value) => {
          mainTheme.getState().adoptPreference(value);
        },
        applyLanguage: mainLanguage,
        applyTimecodeFormat: (value) => {
          mainTimecode.getState().adoptFormat(value);
        },
      },
    });
    const stopSettings = startPreferenceSync({
      subscribe: bus.subscribe,
      ownLabel: "settings",
      targets: settingsTargets,
    });
    await flushPromises();

    const options = { emit: bus.emit, ownLabel: "settings" };
    changeThemePreference("dark", options);
    changeTimecodeFormat("milliseconds", options);
    broadcastLanguagePreference("zh-CN", options);

    expect(mainTheme.getState().preference).toBe("dark");
    expect(mainTimecode.getState().format).toBe("milliseconds");
    expect(mainLanguage).toHaveBeenCalledWith("zh-CN");
    // One event for each change: the receiver applies the value and sends nothing back, and
    // the Settings window ignores its own event.
    expect(bus.emit).toHaveBeenCalledTimes(3);
    expect(settingsTargets.applyTheme).not.toHaveBeenCalled();
    expect(settingsTargets.applyTimecodeFormat).not.toHaveBeenCalled();
    expect(settingsTargets.applyLanguage).not.toHaveBeenCalled();

    stopMain();
    stopSettings();
  });
});

describe("adopting a preference", () => {
  it("changes the value and writes no storage", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const theme = createThemePreferenceStore({ storage });
    const timecode = createTimecodePreferenceStore({ storage });

    theme.getState().adoptPreference("light");
    timecode.getState().adoptFormat("milliseconds");

    expect(theme.getState().preference).toBe("light");
    expect(timecode.getState().format).toBe("milliseconds");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("ignores a value that the preference does not take", () => {
    const theme = createThemePreferenceStore({ storage: null });
    const timecode = createTimecodePreferenceStore({ storage: null });
    theme.getState().adoptPreference("blue" as never);
    timecode.getState().adoptFormat("seconds" as never);
    expect(theme.getState().preference).toBe("system");
    expect(timecode.getState().format).toBe("frames");
  });
});
