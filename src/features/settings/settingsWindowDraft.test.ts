import { describe, expect, it } from "vitest";
import { BACKEND_COMMANDS, type EventSubscribe, type InvokeFn } from "@/lib/ipc";
import { MAX_PRESET_NAME_CHARS } from "./limits";
import {
  createSettingsWindowDraftStore,
  reportSettingsWindowDraft,
  startSettingsWindowDraftMirror,
  validateSettingsWindowDraftPayload,
} from "./settingsWindowDraft";

/**
 * The longest draft name that Rust sends on: `MAX_DRAFT_NAME_CHARS` in
 * `settings_window.rs`, which is the longest preset name of ADR 013.
 */
const MAX_DRAFT_NAME_CHARS = MAX_PRESET_NAME_CHARS;

/**
 * A fake of Tauri for the two windows. The Settings window holds no emit: its invoke stands
 * for Rust, which takes `report_settings_draft` only from the Settings window, cuts the name,
 * and sends the event to the main window with the label of the Settings window. A listener
 * with the default target hears that event too.
 */
function createTauri() {
  const listeners = new Set<(payload: unknown) => void>();
  const deliver = (payload: unknown) => {
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
      if (cmd !== BACKEND_COMMANDS.REPORT_SETTINGS_DRAFT) {
        return Promise.reject(new Error(`${cmd} not allowed`));
      }
      if (label === "settings") {
        const name = args?.name;
        deliver({
          name:
            typeof name === "string"
              ? [...name].slice(0, MAX_DRAFT_NAME_CHARS).join("")
              : null,
          origin: "settings",
        });
      }
      return Promise.resolve(null as T);
    };
  return { subscribe, deliver, calls, invokeAs };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("validateSettingsWindowDraftPayload", () => {
  it("reads a name, an empty name, and no name", () => {
    expect(
      validateSettingsWindowDraftPayload({ name: "Web", origin: "settings" }),
    ).toEqual({ name: "Web", origin: "settings" });
    expect(
      validateSettingsWindowDraftPayload({ name: "", origin: "settings" }),
    ).toEqual({
      name: "",
      origin: "settings",
    });
    expect(
      validateSettingsWindowDraftPayload({ name: null, origin: "settings" }),
    ).toEqual({ name: null, origin: "settings" });
  });

  it("refuses a malformed payload", () => {
    expect(validateSettingsWindowDraftPayload(null)).toBeNull();
    expect(validateSettingsWindowDraftPayload({ name: "Web" })).toBeNull();
    expect(validateSettingsWindowDraftPayload({ name: "Web", origin: "" })).toBeNull();
    expect(
      validateSettingsWindowDraftPayload({ name: 1, origin: "settings" }),
    ).toBeNull();
    expect(validateSettingsWindowDraftPayload({ origin: "settings" })).toBeNull();
  });
});

describe("reportSettingsWindowDraft", () => {
  it("asks Rust to send the draft to the main window", () => {
    const tauri = createTauri();
    reportSettingsWindowDraft("Web 1080p", { invoke: tauri.invokeAs("settings") });
    expect(tauri.calls).toEqual([
      {
        label: "settings",
        cmd: BACKEND_COMMANDS.REPORT_SETTINGS_DRAFT,
        args: { name: "Web 1080p" },
      },
    ]);
  });

  it("survives an invoke that rejects or throws", async () => {
    expect(() => {
      reportSettingsWindowDraft("Web", {
        invoke: () => Promise.reject(new Error("refused")),
      });
      reportSettingsWindowDraft("Web", {
        invoke: () => {
          throw new Error("no runtime");
        },
      });
    }).not.toThrow();
    await flushPromises();
  });
});

describe("startSettingsWindowDraftMirror", () => {
  it("mirrors each report of the Settings window, up to the cleared draft, with no emit", async () => {
    const tauri = createTauri();
    const store = createSettingsWindowDraftStore();
    const stop = startSettingsWindowDraftMirror({
      subscribe: tauri.subscribe,
      ownLabel: "main",
      store,
    });
    await flushPromises();
    expect(store.getState().unsavedPresetName).toBeNull();

    const settings = { invoke: tauri.invokeAs("settings") };
    reportSettingsWindowDraft("Archive", settings);
    expect(store.getState().unsavedPresetName).toBe("Archive");

    // A new preset with no name yet still holds an unsaved edit.
    reportSettingsWindowDraft("", settings);
    expect(store.getState().unsavedPresetName).toBe("");

    // A name that the user is still typing past the limit still names the draft.
    reportSettingsWindowDraft("x".repeat(500), settings);
    expect(store.getState().unsavedPresetName).toBe("x".repeat(MAX_DRAFT_NAME_CHARS));

    // Rust sends this payload when it destroys the Settings window.
    tauri.deliver({ name: null, origin: "settings" });
    expect(store.getState().unsavedPresetName).toBeNull();
    stop();
  });

  it("takes no report that Rust refuses from the main window", async () => {
    const tauri = createTauri();
    const store = createSettingsWindowDraftStore();
    const stop = startSettingsWindowDraftMirror({
      subscribe: tauri.subscribe,
      ownLabel: "main",
      store,
    });
    await flushPromises();

    reportSettingsWindowDraft("Forged", { invoke: tauri.invokeAs("main") });
    expect(store.getState().unsavedPresetName).toBeNull();
    stop();
  });

  it("ignores its own payload, a malformed payload, and every payload after the stop", async () => {
    const tauri = createTauri();
    const store = createSettingsWindowDraftStore();
    const stop = startSettingsWindowDraftMirror({
      subscribe: tauri.subscribe,
      ownLabel: "main",
      store,
    });
    await flushPromises();

    tauri.deliver({ name: "Mine", origin: "main" });
    tauri.deliver({ name: 4 });
    expect(store.getState().unsavedPresetName).toBeNull();

    stop();
    reportSettingsWindowDraft("Late", { invoke: tauri.invokeAs("settings") });
    expect(store.getState().unsavedPresetName).toBeNull();
  });
});
