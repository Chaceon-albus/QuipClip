import { describe, expect, it, vi } from "vitest";
import type { ImportMediaResult } from "@/features/media";
import type { Pts, Segment } from "@/types/project";
import type { QuitGuardInput } from "./quitGuard";
import { createQuitGuard, type QuitGuardDependencies } from "./quitGuardController";

const OPEN_SOURCE = "s-open";

function createSegment(id: string): Segment {
  return { id, sourceId: OPEN_SOURCE, inPts: "0" as Pts, outPts: "1000" as Pts };
}

function createInput(overrides: Partial<QuitGuardInput> = {}): QuitGuardInput {
  return {
    timeline: { sourceId: OPEN_SOURCE, segments: [], pendingInPts: null },
    exportStatus: "idle",
    unsavedPresetName: null,
    openMediaPath: "/videos/open.mp4",
    ...overrides,
  };
}

const WITH_SEGMENTS = createInput({
  timeline: {
    sourceId: OPEN_SOURCE,
    segments: [createSegment("a"), createSegment("b")],
    pendingInPts: null,
  },
});

// The guard only passes the result through, so any object stands for it.
const IMPORT_RESULT = { path: "/videos/next.mp4" } as unknown as ImportMediaResult;

/** A confirm_quit that never settles, as when the application ends before it answers. */
function neverSettles(): Promise<unknown> {
  return new Promise(() => undefined);
}

function setup(input: QuitGuardInput, overrides: QuitGuardDependencies = {}) {
  let current = input;
  const confirmQuit = vi.fn(neverSettles);
  const importPath = vi.fn(() =>
    Promise.resolve<ImportMediaResult | null>(IMPORT_RESULT),
  );
  const guard = createQuitGuard({
    readInput: () => current,
    confirmQuit,
    importPath,
    ...overrides,
  });
  return {
    guard,
    confirmQuit,
    importPath,
    setInput: (next: QuitGuardInput) => {
      current = next;
    },
  };
}

describe("requestQuit", () => {
  it("quits at once and shows no prompt when nothing would be lost", () => {
    const { guard, confirmQuit } = setup(createInput());

    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("shows the quit prompt with the loss when work would be lost", () => {
    const { guard, confirmQuit } = setup(
      createInput({ exportStatus: "running", unsavedPresetName: "Archive" }),
    );

    guard.requestQuit();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "quit",
      loss: {
        segments: 0,
        pendingIn: false,
        exportActive: true,
        unsavedPreset: "Archive",
      },
    });
  });

  it("does not replace an open quit prompt on a second request", () => {
    const { guard, confirmQuit, setInput } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    const first = guard.store.getState().prompt;
    // The work changes, and a second close request arrives while the prompt is open.
    setInput(createInput());
    guard.requestQuit();

    expect(guard.store.getState().prompt).toBe(first);
    expect(confirmQuit).not.toHaveBeenCalled();
  });

  it("ignores every request after the quit started", () => {
    const { guard, confirmQuit, setInput } = setup(createInput());

    guard.requestQuit();
    setInput(WITH_SEGMENTS);
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("ignores a later request after confirm_quit resolved", async () => {
    // Rust only queues the exit, so the command can answer before the application ends.
    const confirmQuit = vi.fn(() => Promise.resolve(null));
    const { guard, setInput } = setup(createInput(), { confirmQuit });

    guard.requestQuit();
    await Promise.resolve();
    await Promise.resolve();
    setInput(WITH_SEGMENTS);
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("ignores a later request after a confirmed quit resolved", async () => {
    const confirmQuit = vi.fn(() => Promise.resolve(null));
    const { guard } = setup(WITH_SEGMENTS, { confirmQuit });

    guard.requestQuit();
    guard.confirm();
    await Promise.resolve();
    await Promise.resolve();
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("runs the decision again after confirm_quit failed", async () => {
    const confirmQuit = vi.fn(() => Promise.reject(new Error("no runtime")));
    const { guard } = setup(createInput(), { confirmQuit });

    guard.requestQuit();
    // Let the rejection reach the guard.
    await Promise.resolve();
    await Promise.resolve();
    guard.requestQuit();

    expect(confirmQuit).toHaveBeenCalledTimes(2);
  });

  it("takes the place of an open replace prompt, and the open resolves with null", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    const opened = guard.requestOpen("/videos/next.mp4");
    expect(guard.store.getState().prompt?.kind).toBe("replace");

    guard.requestQuit();

    expect(guard.store.getState().prompt?.kind).toBe("quit");
    await expect(opened).resolves.toBeNull();
    // The quit prompt must not open the video that the replace prompt was about.
    guard.cancel();
    expect(importPath).not.toHaveBeenCalled();
  });
});

describe("confirm and cancel of the quit prompt", () => {
  it("quits on confirm and closes the prompt", () => {
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    guard.confirm();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("changes nothing on cancel, and asks again on the next request", () => {
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    guard.cancel();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();

    guard.requestQuit();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });

  it("ignores the cancel that Radix sends after the confirm button", () => {
    const { guard, confirmQuit } = setup(WITH_SEGMENTS);

    guard.requestQuit();
    guard.confirm();
    guard.cancel();

    expect(confirmQuit).toHaveBeenCalledTimes(1);
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("does nothing on a confirm with no prompt open", () => {
    const { guard, confirmQuit, importPath } = setup(WITH_SEGMENTS);

    guard.confirm();

    expect(confirmQuit).not.toHaveBeenCalled();
    expect(importPath).not.toHaveBeenCalled();
  });
});

describe("requestOpen", () => {
  it("opens at once when the open source has no segments", async () => {
    const { guard, importPath } = setup(createInput());

    await expect(guard.requestOpen("/videos/next.mp4")).resolves.toBe(IMPORT_RESULT);

    expect(importPath).toHaveBeenCalledWith("/videos/next.mp4");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("asks first when the open source has segments, and opens the file on confirm", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    const opened = guard.requestOpen("/videos/next.mp4");

    expect(importPath).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toEqual({
      kind: "replace",
      segments: 2,
      pendingIn: false,
    });

    guard.confirm();
    guard.cancel();

    await expect(opened).resolves.toBe(IMPORT_RESULT);
    expect(importPath).toHaveBeenCalledTimes(1);
    expect(importPath).toHaveBeenCalledWith("/videos/next.mp4");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("opens the file that is already open again with no question", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    await expect(guard.requestOpen("/videos/open.mp4")).resolves.toBe(IMPORT_RESULT);

    expect(importPath).toHaveBeenCalledWith("/videos/open.mp4");
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("carries the pending In point into the replace prompt", () => {
    const { guard } = setup(
      createInput({
        timeline: {
          sourceId: OPEN_SOURCE,
          segments: [createSegment("a")],
          pendingInPts: "500" as Pts,
        },
      }),
    );

    void guard.requestOpen("/videos/next.mp4");

    expect(guard.store.getState().prompt).toEqual({
      kind: "replace",
      segments: 1,
      pendingIn: true,
    });
  });

  it("opens nothing on cancel and resolves with null", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    const opened = guard.requestOpen("/videos/next.mp4");
    guard.cancel();

    await expect(opened).resolves.toBeNull();
    expect(importPath).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt).toBeNull();
  });

  it("resolves with null when the import rejects after a confirm", async () => {
    const importPath = vi.fn(() => Promise.reject(new Error("import failed")));
    const { guard } = setup(WITH_SEGMENTS, { importPath });

    const opened = guard.requestOpen("/videos/next.mp4");
    guard.confirm();

    await expect(opened).resolves.toBeNull();
  });

  it("refuses a second request while a prompt is open", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    const first = guard.requestOpen("/videos/first.mp4");
    await expect(guard.requestOpen("/videos/second.mp4")).resolves.toBeNull();

    guard.confirm();
    await expect(first).resolves.toBe(IMPORT_RESULT);
    expect(importPath).toHaveBeenCalledTimes(1);
    expect(importPath).toHaveBeenCalledWith("/videos/first.mp4");
  });

  it("refuses a request while the quit prompt is open", async () => {
    const { guard, importPath } = setup(WITH_SEGMENTS);

    guard.requestQuit();

    await expect(guard.requestOpen("/videos/next.mp4")).resolves.toBeNull();
    expect(importPath).not.toHaveBeenCalled();
    expect(guard.store.getState().prompt?.kind).toBe("quit");
  });
});
