import { describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@/lib/ipc";
import {
  createTauriQuitRequestSources,
  startQuitRequestListeners,
  type CloseRequest,
  type QuitRequestSources,
} from "./useQuitGuard";

/** A subscription whose promise the test settles, so a test can order it after a release. */
function deferredSubscription() {
  let resolve: (unlisten: UnlistenFn) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<UnlistenFn>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSources() {
  const close = deferredSubscription();
  const quit = deferredSubscription();
  let closeHandler: ((event: CloseRequest) => void) | null = null;
  let quitHandler: (() => void) | null = null;
  const sources: QuitRequestSources = {
    onCloseRequested: (handler) => {
      closeHandler = handler;
      return close.promise;
    },
    onQuitRequested: (handler) => {
      quitHandler = handler;
      return quit.promise;
    },
  };
  return {
    sources,
    close,
    quit,
    requestClose: () => {
      const event = { preventDefault: vi.fn() };
      closeHandler?.(event);
      return event;
    },
    requestExit: () => {
      quitHandler?.();
    },
  };
}

/** Lets the `then` callbacks of settled subscriptions run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startQuitRequestListeners", () => {
  it("cancels every close request and runs the quit decision", async () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    startQuitRequestListeners(requestQuit, fake.sources);
    fake.close.resolve(vi.fn());
    fake.quit.resolve(vi.fn());
    await flush();

    const event = fake.requestClose();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });

  it("runs the quit decision on an exit request that Rust held back", async () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    startQuitRequestListeners(requestQuit, fake.sources);
    fake.close.resolve(vi.fn());
    fake.quit.resolve(vi.fn());
    await flush();

    fake.requestExit();
    fake.requestExit();

    // The guard itself ignores the second request while its prompt is open.
    expect(requestQuit).toHaveBeenCalledTimes(2);
  });

  it("releases both subscriptions and stops calling the decision", async () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    const unlistenClose = vi.fn();
    const unlistenQuit = vi.fn();
    const release = startQuitRequestListeners(requestQuit, fake.sources);
    fake.close.resolve(unlistenClose);
    fake.quit.resolve(unlistenQuit);
    await flush();

    release();

    expect(unlistenClose).toHaveBeenCalledTimes(1);
    expect(unlistenQuit).toHaveBeenCalledTimes(1);
    fake.requestExit();
    expect(requestQuit).not.toHaveBeenCalled();
  });

  it("releases a subscription that resolves after the release, as StrictMode causes", async () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    const unlistenClose = vi.fn();
    const unlistenQuit = vi.fn();
    const release = startQuitRequestListeners(requestQuit, fake.sources);

    release();
    fake.close.resolve(unlistenClose);
    fake.quit.resolve(unlistenQuit);
    await flush();

    expect(unlistenClose).toHaveBeenCalledTimes(1);
    expect(unlistenQuit).toHaveBeenCalledTimes(1);
  });

  it("still cancels a close request that reaches a released handler", () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    const release = startQuitRequestListeners(requestQuit, fake.sources);
    release();

    // The subscription has not resolved yet, so the handler is still registered. Tauri would
    // destroy the window after a handler that does not cancel the request.
    const event = fake.requestClose();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestQuit).not.toHaveBeenCalled();
  });

  it("survives a refused subscription and keeps the other one", async () => {
    const requestQuit = vi.fn();
    const fake = createSources();
    startQuitRequestListeners(requestQuit, fake.sources);
    fake.close.reject(new Error("refused"));
    fake.quit.resolve(vi.fn());
    await flush();

    fake.requestExit();

    expect(requestQuit).toHaveBeenCalledTimes(1);
  });

  it("survives a source that throws when it subscribes", () => {
    const requestQuit = vi.fn();
    const sources: QuitRequestSources = {
      onCloseRequested: () => {
        throw new Error("no runtime");
      },
      onQuitRequested: () => {
        throw new Error("no runtime");
      },
    };

    const release = startQuitRequestListeners(requestQuit, sources);

    expect(() => {
      release();
    }).not.toThrow();
    expect(requestQuit).not.toHaveBeenCalled();
  });
});

describe("createTauriQuitRequestSources", () => {
  it("returns null outside the Tauri shell", () => {
    expect(createTauriQuitRequestSources()).toBeNull();
  });
});
