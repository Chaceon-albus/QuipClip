import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_PREFERENCES } from "@/i18n";
import { BACKEND_COMMANDS, type EventSubscribe, type InvokeFn } from "@/lib/ipc";
import { THEME_PREFERENCES } from "@/lib/theme";
import { TIMECODE_FORMATS } from "@/lib/timecode";
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

/** Reads a `const <name>: &[&str] = &[...]` list of `src-tauri/src/commands/preferences.rs`. */
function readRustValues(name: string): string[] {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../src-tauri/src/commands/preferences.rs", import.meta.url),
    ),
    "utf8",
  );
  const match = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(
    source,
  );
  expect(match, name).not.toBeNull();
  return Array.from(match![1].matchAll(/"([^"]+)"/g), (value) => value[1]);
}

/** The values that `broadcast_preference` takes for each key, read from the Rust source. */
const RUST_VALUES: Readonly<Record<string, readonly string[]>> = {
  theme: readRustValues("THEME_VALUES"),
  language: readRustValues("LANGUAGE_VALUES"),
  timecodeFormat: readRustValues("TIMECODE_FORMAT_VALUES"),
};

/**
 * A fake of Tauri for windows that hold the capability of the Settings window: a page can
 * listen and invoke, and it has no emit at all. The invoke of each window stands for Rust:
 * `broadcast_preference` checks the key and the value as the command does, and sends the event
 * to every listener, the listener of the calling window included, with the label of the
 * calling window. Every other command is refused, as a command that the capability does not
 * grant is.
 */
function createTauri() {
  const listeners = new Set<(payload: unknown) => void>();
  const sent: unknown[] = [];
  const deliver = (payload: unknown) => {
    sent.push(payload);
    for (const listener of listeners) {
      listener(payload);
    }
  };
  const subscribe: EventSubscribe = (handler) => {
    listeners.add(handler);
    return Promise.resolve(() => {
      listeners.delete(handler);
    });
  };
  const calls: { label: string; cmd: string; args?: Record<string, unknown> }[] = [];
  const invokeAs =
    (label: string): InvokeFn =>
    <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ label, cmd, args });
      if (cmd !== BACKEND_COMMANDS.BROADCAST_PREFERENCE) {
        return Promise.reject(new Error(`${cmd} not allowed`));
      }
      const key = String(args?.key);
      const value = String(args?.value);
      if (!(RUST_VALUES[key] ?? []).includes(value)) {
        return Promise.reject(new Error("invalidPreference"));
      }
      deliver({ key, value, origin: label });
      return Promise.resolve(null as T);
    };
  return { subscribe, deliver, sent, calls, invokeAs };
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

describe("the values of each preference", () => {
  it("are the values that Rust takes in broadcast_preference", () => {
    // A value that only the page knows would be refused, and the other window would keep
    // its old value with no error to show.
    expect(RUST_VALUES.theme).toEqual([...THEME_PREFERENCES]);
    expect(RUST_VALUES.language).toEqual([...LANGUAGE_PREFERENCES]);
    expect(RUST_VALUES.timecodeFormat).toEqual([...TIMECODE_FORMATS]);
  });
});

describe("broadcastPreferenceChange", () => {
  it("asks Rust to send the change, and Rust names the calling window", () => {
    const tauri = createTauri();
    broadcastPreferenceChange(
      { key: "theme", value: "light" },
      { invoke: tauri.invokeAs("settings") },
    );
    expect(tauri.calls).toEqual([
      {
        label: "settings",
        cmd: BACKEND_COMMANDS.BROADCAST_PREFERENCE,
        args: { key: "theme", value: "light" },
      },
    ]);
    expect(tauri.sent).toEqual([{ key: "theme", value: "light", origin: "settings" }]);
  });

  it("survives an invoke that rejects or throws", async () => {
    expect(() => {
      broadcastPreferenceChange(
        { key: "language", value: "en" },
        { invoke: () => Promise.reject(new Error("refused")) },
      );
      broadcastPreferenceChange(
        { key: "language", value: "en" },
        {
          invoke: () => {
            throw new Error("no runtime");
          },
        },
      );
    }).not.toThrow();
    await flushPromises();
  });

  it("sends a language that the language control applied", () => {
    const tauri = createTauri();
    broadcastLanguagePreference("zh-CN", { invoke: tauri.invokeAs("settings") });
    expect(tauri.sent).toEqual([
      { key: "language", value: "zh-CN", origin: "settings" },
    ]);
  });
});

describe("changeThemePreference and changeTimecodeFormat", () => {
  it("apply the value in this window and send it", () => {
    const tauri = createTauri();
    const options = { invoke: tauri.invokeAs("settings") };
    changeThemePreference("dark", options);
    changeTimecodeFormat("milliseconds", options);

    expect(themePreferenceStore.getState().preference).toBe("dark");
    expect(timecodePreferenceStore.getState().format).toBe("milliseconds");
    expect(tauri.sent).toEqual([
      { key: "theme", value: "dark", origin: "settings" },
      { key: "timecodeFormat", value: "milliseconds", origin: "settings" },
    ]);
  });

  it("ignore a value that the preference does not take", () => {
    const tauri = createTauri();
    const options = { invoke: tauri.invokeAs("settings") };
    changeThemePreference("blue" as never, options);
    changeTimecodeFormat("seconds" as never, options);
    expect(tauri.calls).toEqual([]);
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
    const tauri = createTauri();
    const targets = createTargets();
    const stop = startPreferenceSync({
      subscribe: tauri.subscribe,
      ownLabel: "main",
      targets,
    });
    await flushPromises();

    tauri.deliver({ key: "theme", value: "dark", origin: "main" });
    tauri.deliver({ key: "theme", value: 7 });
    expect(targets.applyTheme).not.toHaveBeenCalled();

    tauri.deliver({ key: "theme", value: "dark", origin: "settings" });
    expect(targets.applyTheme).toHaveBeenCalledWith("dark");

    stop();
    tauri.deliver({ key: "theme", value: "light", origin: "settings" });
    expect(targets.applyTheme).toHaveBeenCalledTimes(1);
  });

  it("carries a change from the Settings window to the main window, once, with no emit", async () => {
    // The Settings window is the module stores; the main window has stores of its own. The
    // page of the Settings window only invokes and listens, as its capability allows.
    const tauri = createTauri();
    const mainTheme = createThemePreferenceStore({ storage: null });
    const mainTimecode = createTimecodePreferenceStore({ storage: null });
    const mainLanguage = vi.fn();
    const settingsTargets = createTargets();
    const stopMain = startPreferenceSync({
      subscribe: tauri.subscribe,
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
      subscribe: tauri.subscribe,
      ownLabel: "settings",
      targets: settingsTargets,
    });
    await flushPromises();

    const options = { invoke: tauri.invokeAs("settings") };
    changeThemePreference("dark", options);
    changeTimecodeFormat("milliseconds", options);
    broadcastLanguagePreference("zh-CN", options);

    expect(mainTheme.getState().preference).toBe("dark");
    expect(mainTimecode.getState().format).toBe("milliseconds");
    expect(mainLanguage).toHaveBeenCalledWith("zh-CN");
    // One event for each change: the receiver applies the value and sends nothing back, and
    // the Settings window ignores its own event.
    expect(tauri.calls).toHaveLength(3);
    expect(tauri.sent).toHaveLength(3);
    expect(settingsTargets.applyTheme).not.toHaveBeenCalled();
    expect(settingsTargets.applyTimecodeFormat).not.toHaveBeenCalled();
    expect(settingsTargets.applyLanguage).not.toHaveBeenCalled();

    stopMain();
    stopSettings();
  });

  it("sends nothing for a value that Rust refuses", async () => {
    const tauri = createTauri();
    const targets = createTargets();
    const stop = startPreferenceSync({
      subscribe: tauri.subscribe,
      ownLabel: "main",
      targets,
    });
    await flushPromises();

    broadcastPreferenceChange({ key: "theme", value: "blue" } as never, {
      invoke: tauri.invokeAs("settings"),
    });
    await flushPromises();
    expect(tauri.sent).toEqual([]);
    expect(targets.applyTheme).not.toHaveBeenCalled();
    stop();
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
