import { describe, expect, it, vi } from "vitest";
import { WINDOW_EVENTS, type EmitToFn, type EventSubscribe } from "@/lib/ipc";
import {
  createSettingsWindowDraftStore,
  reportSettingsWindowDraft,
  startSettingsWindowDraftMirror,
  validateSettingsWindowDraftPayload,
} from "./settingsWindowDraft";

/**
 * A fake of the Tauri event bus for one event. `emitTo` reaches every listener, as `listen`
 * with the default target hears an event that was sent to another window.
 */
function createBus() {
  const listeners = new Set<(payload: unknown) => void>();
  const emitTo = vi.fn<EmitToFn>((_target, _event, payload) => {
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
  return { emitTo, subscribe };
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
  it("sends the draft to the main window with the label of this window", () => {
    const emitTo = vi.fn<EmitToFn>(() => Promise.resolve());
    reportSettingsWindowDraft("Web 1080p", { emitTo, ownLabel: "settings" });
    expect(emitTo).toHaveBeenCalledWith("main", WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT, {
      name: "Web 1080p",
      origin: "settings",
    });
  });

  it("sends nothing outside the Tauri shell, and survives a failed emit", async () => {
    const emitTo = vi.fn<EmitToFn>(() => Promise.resolve());
    reportSettingsWindowDraft("Web", { emitTo, ownLabel: null });
    expect(emitTo).not.toHaveBeenCalled();

    expect(() => {
      reportSettingsWindowDraft("Web", {
        emitTo: () => Promise.reject(new Error("refused")),
        ownLabel: "settings",
      });
      reportSettingsWindowDraft("Web", {
        emitTo: () => {
          throw new Error("no runtime");
        },
        ownLabel: "settings",
      });
    }).not.toThrow();
    await flushPromises();
  });
});

describe("startSettingsWindowDraftMirror", () => {
  it("mirrors each report of the Settings window, up to the cleared draft", async () => {
    const bus = createBus();
    const store = createSettingsWindowDraftStore();
    const stop = startSettingsWindowDraftMirror({
      subscribe: bus.subscribe,
      ownLabel: "main",
      store,
    });
    await flushPromises();
    expect(store.getState().unsavedPresetName).toBeNull();

    reportSettingsWindowDraft("Archive", { emitTo: bus.emitTo, ownLabel: "settings" });
    expect(store.getState().unsavedPresetName).toBe("Archive");

    // A new preset with no name yet still holds an unsaved edit.
    reportSettingsWindowDraft("", { emitTo: bus.emitTo, ownLabel: "settings" });
    expect(store.getState().unsavedPresetName).toBe("");

    // Rust sends this payload when it destroys the Settings window.
    await bus.emitTo("main", WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT, {
      name: null,
      origin: "settings",
    });
    expect(store.getState().unsavedPresetName).toBeNull();
    stop();
  });

  it("ignores its own payload, a malformed payload, and every payload after the stop", async () => {
    const bus = createBus();
    const store = createSettingsWindowDraftStore();
    const stop = startSettingsWindowDraftMirror({
      subscribe: bus.subscribe,
      ownLabel: "main",
      store,
    });
    await flushPromises();

    await bus.emitTo("main", WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT, {
      name: "Mine",
      origin: "main",
    });
    await bus.emitTo("main", WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT, { name: 4 });
    expect(store.getState().unsavedPresetName).toBeNull();

    stop();
    reportSettingsWindowDraft("Late", { emitTo: bus.emitTo, ownLabel: "settings" });
    expect(store.getState().unsavedPresetName).toBeNull();
  });
});
