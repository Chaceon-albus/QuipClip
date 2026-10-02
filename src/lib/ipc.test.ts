import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BACKEND_COMMANDS,
  BACKEND_EVENTS,
  WINDOW_EVENTS,
  emitEvent,
  emitEventTo,
  listenInCurrentWindow,
  listenWindowEvent,
  startEventListener,
  type EmitFn,
  type EmitToFn,
  type EventSubscribe,
  type ListenFn,
  type UnlistenFn,
} from "./ipc";

// The listen of the current window. The fake records the event name and keeps the handler.
const webviewWindow = vi.hoisted(() => ({
  listen: vi.fn((_event: string, _handler: (event: { payload: unknown }) => void) =>
    Promise.resolve(() => {}),
  ),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => webviewWindow,
}));

/**
 * Reads the leaf names registered with `tauri::generate_handler!` out of the Rust source.
 *
 * Every value of `BACKEND_COMMANDS` and its Rust registration are two independent hand-written
 * copies of the same string, and until this test existed nothing compared them. Most commands
 * fail loudly when they drift, because the caller surfaces the rejection, but
 * `read_source_revision` does not: `sourceRevisionStillMatches` treats every read failure as
 * "no mismatch observed", which is correct for a deleted file or a share that stopped
 * answering, and makes an unknown command indistinguishable from an unchanged file. A rename on
 * the Rust side alone would switch the whole replacement warning off with no failing test and
 * no user-visible symptom (ADR 010).
 */
const GENERATE_HANDLER_PATTERN =
  /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/;

function readRustRegisteredCommands(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)),
    "utf8",
  );

  const invocation = GENERATE_HANDLER_PATTERN.exec(source);
  expect(invocation).not.toBeNull();

  // Each entry is a module path such as `commands::media::read_source_revision`; the command
  // name is its last segment.
  const paths = invocation![1].matchAll(
    /^\s*(?:[a-z_][a-z0-9_]*::)+([a-z_][a-z0-9_]*)\s*,?\s*$/gm,
  );
  return Array.from(paths, (match) => match[1]);
}

describe("Backend command parity", () => {
  it("registers every BACKEND_COMMANDS name in the Rust invoke handler", () => {
    const registered = readRustRegisteredCommands();

    // Guards the parse itself: a moved lib.rs or a reformatted handler list would otherwise
    // read as an empty registration and pass the comparison below.
    expect(registered.length).toBeGreaterThan(8);
    expect(new Set(registered).size).toBe(registered.length);

    const missing = Object.values(BACKEND_COMMANDS).filter(
      (command) => !registered.includes(command),
    );
    expect(missing).toEqual([]);
  });
});

describe("Backend event parity", () => {
  it("names the quit request event exactly as the Rust constant does", () => {
    // A rename on one side only leaves every quit held back by Rust with no dialog to answer
    // it (ADR 027), so the two copies of the name are compared here.
    const source = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/commands/quit.rs", import.meta.url)),
      "utf8",
    );
    const match = /pub const QUIT_REQUESTED_EVENT: &str = "([^"]+)";/.exec(source);

    expect(match).not.toBeNull();
    expect(match![1]).toBe(BACKEND_EVENTS.QUIT_REQUESTED);
  });

  it("names the menu action event exactly as the Rust constant does", () => {
    // A rename on one side only leaves every command item of the macOS menu with no listener,
    // so Open Media and Export in the menu would do nothing.
    expect(readRustEventConstant("menu.rs", "MENU_ACTION_EVENT")).toBe(
      BACKEND_EVENTS.MENU_ACTION,
    );
  });

  it("names the settings change event exactly as the Rust constant does", () => {
    // A rename on one side only leaves the other window on the document it loaded, and its
    // next save is refused as a conflict that the user did not cause.
    expect(
      readRustEventConstant("commands/settings.rs", "SETTINGS_CHANGED_EVENT"),
    ).toBe(BACKEND_EVENTS.SETTINGS_CHANGED);
  });

  it("names the Settings window navigate event exactly as the Rust constant does", () => {
    // A rename on one side only leaves an open Settings window on its tab when a control
    // opens it on another tab or on a preset.
    expect(readRustEventConstant("commands/settings_window.rs", "NAVIGATE_EVENT")).toBe(
      BACKEND_EVENTS.SETTINGS_WINDOW_NAVIGATE,
    );
  });

  it("names the Settings window draft event exactly as the Rust constant does", () => {
    // Rust sends this event when it destroys the Settings window. A rename on one side only
    // leaves the quit guard naming a draft of a window that is gone.
    expect(readRustEventConstant("commands/settings_window.rs", "DRAFT_EVENT")).toBe(
      WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT,
    );
  });

  it("names the forced probe event exactly as the Rust constant does", () => {
    // A rename on one side only leaves the main window on the capabilities of the old ffmpeg
    // after the Settings window changed the path.
    expect(
      readRustEventConstant(
        "commands/capabilities.rs",
        "CAPABILITY_PROBE_FORCED_EVENT",
      ),
    ).toBe(BACKEND_EVENTS.CAPABILITY_PROBE_FORCED);
  });
});

/** Reads the value of `pub const <name>: &str = "...";` from a file under `src-tauri/src`. */
function readRustEventConstant(file: string, name: string): string | null {
  const source = readFileSync(
    fileURLToPath(new URL(`../../src-tauri/src/${file}`, import.meta.url)),
    "utf8",
  );
  const match = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source);
  return match === null ? null : match[1];
}

describe("emitEvent", () => {
  it("emits the window event with its payload", async () => {
    const emit = vi.fn<EmitFn>(() => Promise.resolve());
    await emitEvent(WINDOW_EVENTS.PREFERENCES_CHANGED, { origin: "main" }, emit);
    expect(emit).toHaveBeenCalledWith("preferences:changed", { origin: "main" });
  });
});

describe("startEventListener", () => {
  /** A subscription whose promise the test settles, so a test can order it after a release. */
  function createSubscription() {
    let resolve: (unlisten: UnlistenFn) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<UnlistenFn>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let handler: ((payload: unknown) => void) | null = null;
    const subscribe: EventSubscribe = (next) => {
      handler = next;
      return promise;
    };
    return {
      subscribe,
      resolve,
      reject,
      send: (payload: unknown) => {
        handler?.(payload);
      },
    };
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("passes each payload to the handler until the release, and releases once", async () => {
    const subscription = createSubscription();
    const unlisten = vi.fn();
    const onPayload = vi.fn();
    const release = startEventListener(subscription.subscribe, onPayload);
    subscription.resolve(unlisten);
    await flushPromises();

    subscription.send("a");
    release();
    release();
    subscription.send("b");
    expect(onPayload.mock.calls).toEqual([["a"]]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases a subscription that resolves after the release", async () => {
    // React StrictMode releases the effect once before the subscription resolves.
    const subscription = createSubscription();
    const unlisten = vi.fn();
    const onPayload = vi.fn();
    const release = startEventListener(subscription.subscribe, onPayload);

    release();
    subscription.resolve(unlisten);
    await flushPromises();
    subscription.send("late");
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("survives a refused subscription and a subscribe that throws", async () => {
    const subscription = createSubscription();
    const release = startEventListener(subscription.subscribe, vi.fn());
    subscription.reject(new Error("listen refused"));
    await flushPromises();
    expect(() => release()).not.toThrow();

    const releaseThrown = startEventListener(() => {
      throw new Error("no runtime");
    }, vi.fn());
    expect(() => releaseThrown()).not.toThrow();
  });

  it("calls onReady once the subscription is in place, and not after the release", async () => {
    const subscription = createSubscription();
    const onReady = vi.fn();
    const release = startEventListener(subscription.subscribe, vi.fn(), onReady);
    expect(onReady).not.toHaveBeenCalled();
    subscription.resolve(vi.fn());
    await flushPromises();
    expect(onReady).toHaveBeenCalledTimes(1);
    release();

    const late = createSubscription();
    const lateReady = vi.fn();
    const releaseLate = startEventListener(late.subscribe, vi.fn(), lateReady);
    releaseLate();
    late.resolve(vi.fn());
    await flushPromises();
    expect(lateReady).not.toHaveBeenCalled();
  });

  it("calls onReady when the subscription is refused or throws, so a caller still reads", async () => {
    const refused = createSubscription();
    const onRefused = vi.fn();
    startEventListener(refused.subscribe, vi.fn(), onRefused);
    refused.reject(new Error("listen refused"));
    await flushPromises();
    expect(onRefused).toHaveBeenCalledTimes(1);

    const onThrown = vi.fn();
    startEventListener(
      () => {
        throw new Error("no runtime");
      },
      vi.fn(),
      onThrown,
    );
    expect(onThrown).not.toHaveBeenCalled();
    await flushPromises();
    expect(onThrown).toHaveBeenCalledTimes(1);
  });
});

describe("listenWindowEvent", () => {
  it("listens in the current window, so an event sent to another window is not heard", async () => {
    const handler = vi.fn();
    await listenWindowEvent(BACKEND_EVENTS.QUIT_REQUESTED, handler);
    expect(webviewWindow.listen).toHaveBeenCalledWith(
      "app:quit-requested",
      expect.any(Function),
    );
    const deliver = webviewWindow.listen.mock.calls[0]?.[1];
    deliver?.({ payload: null });
    expect(handler).toHaveBeenCalledWith(null);
  });

  it("passes the unwrapped payload through a custom listen", async () => {
    let deliver: ((event: { payload: unknown }) => void) | null = null;
    const listen: ListenFn = (_event, handler) => {
      deliver = handler as (event: { payload: unknown }) => void;
      return Promise.resolve(() => {});
    };
    const handler = vi.fn();
    await listenWindowEvent(WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT, handler, listen);
    deliver!({ payload: { name: null, origin: "settings" } });
    expect(handler).toHaveBeenCalledWith({ name: null, origin: "settings" });
  });

  it("names the listen of the current window", async () => {
    webviewWindow.listen.mockClear();
    await listenInCurrentWindow("settings-window:navigate", () => {});
    expect(webviewWindow.listen).toHaveBeenCalledTimes(1);
  });
});

describe("emitEventTo", () => {
  it("emits the window event to the named window with its payload", async () => {
    const emitTo = vi.fn<EmitToFn>(() => Promise.resolve());
    await emitEventTo(
      "main",
      WINDOW_EVENTS.SETTINGS_WINDOW_DRAFT,
      { name: null, origin: "settings" },
      emitTo,
    );
    expect(emitTo).toHaveBeenCalledWith("main", "settings-window:draft", {
      name: null,
      origin: "settings",
    });
  });
});

describe("Window event names", () => {
  it("are distinct from every backend event name", () => {
    // A window event that shared a name with a backend event would reach a listener that
    // validates another payload.
    const backend = new Set<string>(Object.values(BACKEND_EVENTS));
    for (const name of Object.values(WINDOW_EVENTS)) {
      expect(backend.has(name)).toBe(false);
    }
  });
});
