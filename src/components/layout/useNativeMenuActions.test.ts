import { afterEach, describe, expect, it, vi } from "vitest";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { exportPanelStore } from "@/features/export";
import { openMediaFileDialog } from "@/features/media";
import type { UnlistenFn } from "@/lib/ipc";
import { nativeContextMenuState } from "./nativeContextMenuState";
import {
  runNativeMenuAction,
  startNativeMenuActionListener,
  type NativeMenuSubscribe,
} from "./useNativeMenuActions";

// The Open Media item opens the native file dialog. The fake answers with no file, so the
// call shows that the item ran and imports nothing.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

/** A subscription whose promise the test settles, so a test can order it after a release. */
function createSubscription() {
  let resolve: (unlisten: UnlistenFn) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<UnlistenFn>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  let handler: ((payload: unknown) => void) | null = null;
  const subscribe: NativeMenuSubscribe = (next) => {
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

describe("startNativeMenuActionListener", () => {
  it("passes each menu event to the handler", async () => {
    const subscription = createSubscription();
    const onPayload = vi.fn();
    const release = startNativeMenuActionListener(onPayload, subscription.subscribe);
    subscription.resolve(vi.fn());
    await flushPromises();

    subscription.send("openMedia");
    subscription.send("export");
    expect(onPayload.mock.calls).toEqual([["openMedia"], ["export"]]);
    release();
  });

  it("releases the subscription once, and ignores an event after the release", async () => {
    const subscription = createSubscription();
    const unlisten = vi.fn();
    const onPayload = vi.fn();
    const release = startNativeMenuActionListener(onPayload, subscription.subscribe);
    subscription.resolve(unlisten);
    await flushPromises();

    release();
    release();
    subscription.send("openSettings");
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("releases a subscription that resolves after the release", async () => {
    // React StrictMode releases the effect once before the subscription resolves.
    const subscription = createSubscription();
    const unlisten = vi.fn();
    const onPayload = vi.fn();
    const release = startNativeMenuActionListener(onPayload, subscription.subscribe);

    release();
    subscription.resolve(unlisten);
    await flushPromises();
    subscription.send("openSettings");
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("survives a refused subscription", async () => {
    const subscription = createSubscription();
    const release = startNativeMenuActionListener(vi.fn(), subscription.subscribe);
    subscription.reject(new Error("listen refused"));
    await flushPromises();
    expect(() => release()).not.toThrow();
  });

  it("survives a subscription that throws before it returns a promise", () => {
    const release = startNativeMenuActionListener(vi.fn(), () => {
      throw new Error("no runtime");
    });
    expect(() => release()).not.toThrow();
  });
});

describe("runNativeMenuAction", () => {
  afterEach(async () => {
    // Lets each Open Media dialog that a test opened answer, so no dialog stays open for the
    // next test.
    await flushPromises();
    vi.mocked(tauriOpen).mockClear();
    exportPanelStore.getState().setOpen(false);
  });

  it("opens the Open Media dialog from the Open Media item", () => {
    runNativeMenuAction("openMedia");
    expect(tauriOpen).toHaveBeenCalledTimes(1);
  });

  it("does not export while no media is open, as the Export button does not", () => {
    runNativeMenuAction("export");
    expect(exportPanelStore.getState().open).toBe(false);
  });

  it("ignores a payload that names no command item", () => {
    runNativeMenuAction("markIn");
    runNativeMenuAction(undefined);
    // The Settings item opens its window in Rust, so this action is not a menu event.
    runNativeMenuAction("openSettings");
    expect(tauriOpen).not.toHaveBeenCalled();
    expect(exportPanelStore.getState().open).toBe(false);
  });

  it("does nothing while a native context menu of the page is open", () => {
    // The menu of a timeline segment marks itself open from the right-click until it closes.
    const mark = nativeContextMenuState.open();
    try {
      runNativeMenuAction("openMedia");
      expect(tauriOpen).not.toHaveBeenCalled();
    } finally {
      mark.close();
    }
    runNativeMenuAction("openMedia");
    expect(tauriOpen).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the native Open Media dialog is open", async () => {
    let close: (value: string | null) => void = () => undefined;
    const dialog = new Promise<string | null>((resolve) => {
      close = resolve;
    });
    const running = openMediaFileDialog({
      filterName: "Video Files",
      openDialog: vi.fn().mockReturnValue(dialog),
    });

    runNativeMenuAction("openMedia");
    expect(tauriOpen).not.toHaveBeenCalled();

    close(null);
    await running;
    runNativeMenuAction("openMedia");
    expect(tauriOpen).toHaveBeenCalledTimes(1);
  });
});
