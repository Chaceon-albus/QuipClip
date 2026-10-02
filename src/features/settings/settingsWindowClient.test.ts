import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS, type EventSubscribe, type InvokeFn } from "@/lib/ipc";
import {
  closeSettingsWindow,
  openSettingsWindow,
  startSettingsWindowRequestListener,
  takeSettingsWindowRequest,
  validateSettingsWindowRequest,
  type SettingsWindowRequest,
} from "./settingsWindowClient";

/** A fake invoke that records each call and answers with `answer`. */
function createInvoke(answer: () => Promise<unknown>) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = (<T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return answer() as Promise<T>;
  }) as InvokeFn;
  return { invoke, calls };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openSettingsWindow", () => {
  it("asks Rust for the window with the tab and the preset", async () => {
    const { invoke, calls } = createInvoke(() => Promise.resolve(null));
    await expect(openSettingsWindow("presets", "p2", { invoke })).resolves.toBe(true);
    expect(calls).toEqual([
      {
        cmd: BACKEND_COMMANDS.OPEN_SETTINGS_WINDOW,
        args: { section: "presets", presetId: "p2" },
      },
    ]);
  });

  it("sends null for a tab and a preset that the caller did not name", async () => {
    const { invoke, calls } = createInvoke(() => Promise.resolve(null));
    await openSettingsWindow(undefined, undefined, { invoke });
    await openSettingsWindow("ffmpeg", undefined, { invoke });
    expect(calls.map((call) => call.args)).toEqual([
      { section: null, presetId: null },
      { section: "ffmpeg", presetId: null },
    ]);
  });

  it("resolves false and logs when the window did not open", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { invoke } = createInvoke(() =>
      Promise.reject(new Error("windowUnavailable")),
    );
    await expect(openSettingsWindow(null, null, { invoke })).resolves.toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("closeSettingsWindow", () => {
  it("asks Rust to close the calling window, and names no window", async () => {
    const { invoke, calls } = createInvoke(() => Promise.resolve(null));
    await expect(closeSettingsWindow({ invoke })).resolves.toBe(true);
    expect(calls).toEqual([
      { cmd: BACKEND_COMMANDS.CLOSE_SETTINGS_WINDOW, args: undefined },
    ]);
  });

  it("resolves false and logs when the window did not close", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { invoke } = createInvoke(() => Promise.reject(new Error("refused")));
    await expect(closeSettingsWindow({ invoke })).resolves.toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("validateSettingsWindowRequest", () => {
  it("reads a request with a known tab, a preset, or neither", () => {
    expect(
      validateSettingsWindowRequest({ section: "presets", presetId: "p1" }),
    ).toEqual({
      section: "presets",
      presetId: "p1",
    });
    expect(validateSettingsWindowRequest({ section: null, presetId: null })).toEqual({
      section: null,
      presetId: null,
    });
  });

  it("reads no request from null and from a malformed value", () => {
    expect(validateSettingsWindowRequest(null)).toBeNull();
    expect(validateSettingsWindowRequest("presets")).toBeNull();
    expect(
      validateSettingsWindowRequest({ section: "about", presetId: null }),
    ).toBeNull();
    expect(validateSettingsWindowRequest({ section: null, presetId: "" })).toBeNull();
    expect(validateSettingsWindowRequest({ section: null, presetId: 3 })).toBeNull();
    expect(validateSettingsWindowRequest({ presetId: null })).toBeNull();
  });
});

describe("takeSettingsWindowRequest", () => {
  it("takes the pending request", async () => {
    const { invoke, calls } = createInvoke(() =>
      Promise.resolve({ section: "ffmpeg", presetId: null }),
    );
    await expect(takeSettingsWindowRequest({ invoke })).resolves.toEqual({
      section: "ffmpeg",
      presetId: null,
    });
    expect(calls).toEqual([
      { cmd: BACKEND_COMMANDS.TAKE_SETTINGS_WINDOW_REQUEST, args: undefined },
    ]);
  });

  it("resolves null when the command fails", async () => {
    const { invoke } = createInvoke(() => Promise.reject(new Error("refused")));
    await expect(takeSettingsWindowRequest({ invoke })).resolves.toBeNull();
  });
});

describe("startSettingsWindowRequestListener", () => {
  /** A navigate subscription that the test resolves and fires. */
  function createNavigate() {
    let resolve: () => void = () => undefined;
    let handler: ((payload: unknown) => void) | null = null;
    const subscribe: EventSubscribe = (next) => {
      handler = next;
      return new Promise((resolvePromise) => {
        resolve = () => {
          resolvePromise(() => {});
        };
      });
    };
    return {
      subscribe,
      resolve: () => {
        resolve();
      },
      fire: () => {
        handler?.(null);
      },
    };
  }

  it("takes the request once the listener is in place, and again on each navigate", async () => {
    const navigate = createNavigate();
    const queue: (SettingsWindowRequest | null)[] = [
      { section: "presets", presetId: "p1" },
      { section: "ffmpeg", presetId: null },
    ];
    const take = vi.fn(() => Promise.resolve(queue.shift() ?? null));
    const onRequest = vi.fn();
    const stop = startSettingsWindowRequestListener({
      onRequest,
      subscribe: navigate.subscribe,
      take,
    });

    // No take before the listener is in place, so no request falls between the two.
    await flushPromises();
    expect(take).not.toHaveBeenCalled();

    navigate.resolve();
    await flushPromises();
    expect(onRequest).toHaveBeenCalledWith({ section: "presets", presetId: "p1" });

    navigate.fire();
    await flushPromises();
    expect(onRequest).toHaveBeenLastCalledWith({ section: "ffmpeg", presetId: null });

    // A navigate whose request another take already took finds nothing.
    navigate.fire();
    await flushPromises();
    expect(onRequest).toHaveBeenCalledTimes(2);
    stop();
  });

  it("applies no request after the stop", async () => {
    const navigate = createNavigate();
    let answer: (request: SettingsWindowRequest | null) => void = () => undefined;
    const take = vi.fn(
      () =>
        new Promise<SettingsWindowRequest | null>((resolve) => {
          answer = resolve;
        }),
    );
    const onRequest = vi.fn();
    const stop = startSettingsWindowRequestListener({
      onRequest,
      subscribe: navigate.subscribe,
      take,
    });
    navigate.resolve();
    await flushPromises();
    expect(take).toHaveBeenCalledTimes(1);

    stop();
    answer({ section: "general", presetId: null });
    await flushPromises();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("survives a take that rejects", async () => {
    const navigate = createNavigate();
    const onRequest = vi.fn();
    const stop = startSettingsWindowRequestListener({
      onRequest,
      subscribe: navigate.subscribe,
      take: () => Promise.reject(new Error("refused")),
    });
    navigate.resolve();
    await flushPromises();
    expect(onRequest).not.toHaveBeenCalled();
    stop();
  });
});
