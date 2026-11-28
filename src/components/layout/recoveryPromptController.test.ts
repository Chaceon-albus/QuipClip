import { describe, expect, it, vi } from "vitest";
import { held, flush } from "@/features/project/projectTestSupport";
import type { RestoreProjectResult } from "@/features/project/openStep";
import { createRecoveryOffersStore } from "@/features/recovery/controller";
import type { RecoveryOfferSummary } from "@/features/recovery/types";
import {
  canShowRecoveryPrompt,
  createRecoveryPrompt,
  watchEach,
  type RecoveryPromptFacts,
} from "./recoveryPromptController";

function offer(id: string, writtenAtMs: number): RecoveryOfferSummary {
  return { id: id.padStart(16, "0"), writtenAtMs, projectPath: null };
}

const ONE = offer("1", 100);
const TWO = offer("2", 200);
const THREE = offer("3", 300);

/** A prompt over a new offers store, a gate that the test opens, and held restores. */
function harness(options: { free?: boolean } = {}) {
  const offers = createRecoveryOffersStore();
  let free = options.free ?? true;
  const listeners = new Set<() => void>();
  const watch = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const restores: ReturnType<typeof held<RestoreProjectResult>>[] = [];
  const restore = vi.fn((_offer: RecoveryOfferSummary) => {
    const answer = held<RestoreProjectResult>();
    restores.push(answer);
    return answer.promise;
  });
  const discards: ReturnType<typeof held<unknown>>[] = [];
  const discard = vi.fn((_id: string) => {
    const answer = held<unknown>();
    discards.push(answer);
    return answer.promise;
  });
  const prompt = createRecoveryPrompt({
    offers,
    canShow: () => free,
    watch,
    restore,
    discard,
  });
  return {
    offers,
    prompt,
    watch,
    restore,
    restores,
    discard,
    discards,
    shown: () => prompt.store.getState().offer,
    /** Opens or closes the gate, and tells the watchers, as a store or the document does. */
    setFree: (next: boolean) => {
      free = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    watching: () => listeners.size,
  };
}

describe("the recovery prompt shows (ADR 073)", () => {
  it("shows for the first offer to show, and takes it from the offers", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    expect(h.shown()).toBeNull();
    await flush();

    expect(h.shown()).toEqual(TWO);
    expect(h.offers.getState().offers).toEqual([ONE]);
  });

  it("shows for an offer that was there before the prompt", async () => {
    const offers = createRecoveryOffersStore();
    offers.getState().add([ONE]);
    const prompt = createRecoveryPrompt({
      offers,
      canShow: () => true,
      watch: () => () => undefined,
      restore: () => Promise.resolve({ status: "restored" }),
      discard: () => Promise.resolve(),
    });
    await flush();
    expect(prompt.store.getState().offer).toEqual(ONE);
  });

  it("waits while it cannot show, and shows when the wait ended, with no polling", async () => {
    const h = harness({ free: false });
    h.offers.getState().add([ONE]);
    await flush();
    expect(h.shown()).toBeNull();
    expect(h.watching()).toBe(1);

    h.setFree(false);
    await flush();
    expect(h.shown()).toBeNull();

    h.setFree(true);
    await flush();
    expect(h.shown()).toEqual(ONE);
    // It watches only while an offer waits.
    expect(h.watching()).toBe(0);
  });

  it("watches nothing while it has no offer", async () => {
    const h = harness({ free: false });
    await flush();
    expect(h.watch).not.toHaveBeenCalled();
  });

  it("stays as it is while a quit runs above it", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    // A quit prompt opens above the recovery prompt, and the user cancels it.
    h.setFree(false);
    await flush();
    h.setFree(true);
    await flush();

    expect(h.shown()).toEqual(TWO);
    expect(h.offers.getState().offers).toEqual([ONE]);
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled();
  });

  it("shows one prompt at a time, for a later offer too", async () => {
    const h = harness();
    h.offers.getState().add([ONE]);
    await flush();
    h.offers.getState().add([THREE]);
    await flush();
    expect(h.shown()).toEqual(ONE);
    expect(h.offers.getState().offers).toEqual([THREE]);
  });
});

describe("Restore", () => {
  it("closes the prompt and restores its offer, and shows no prompt more after a restore", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    const restoring = h.prompt.restore();
    expect(h.shown()).toBeNull();
    expect(h.restore).toHaveBeenCalledWith(TWO);
    h.restores[0]?.resolve({ status: "restored" });
    await restoring;
    await flush();

    expect(h.shown()).toBeNull();
    h.offers.getState().add([THREE]);
    await flush();
    expect(h.shown()).toBeNull();
  });

  it("shows no prompt while the restore runs", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    void h.prompt.restore();
    await flush();
    expect(h.shown()).toBeNull();
  });

  it("shows the prompt again for the same offer after a restore that stopped before step 8", async () => {
    const stops: RestoreProjectResult[] = [
      { status: "failed", error: { kind: "entriesDiffer", entryIds: ["a", "b"] } },
      { status: "canceled", by: "user" },
      { status: "stopped", saveError: null },
      { status: "stopped", saveError: { kind: "invalidName", path: "/p/a.txt" } },
      { status: "blocked" },
    ];
    for (const result of stops) {
      const h = harness();
      h.offers.getState().add([ONE, TWO]);
      await flush();
      // A newer offer arrives while the restore runs.
      const restoring = h.prompt.restore();
      h.offers.getState().add([THREE]);
      h.restores[0]?.resolve(result);
      await restoring;
      await flush();
      expect(h.shown()).toEqual(TWO);
    }
  });

  it("waits for each dialog to close before it shows again", async () => {
    const h = harness();
    h.offers.getState().add([ONE]);
    await flush();
    const restoring = h.prompt.restore();
    h.setFree(false);
    h.restores[0]?.resolve({ status: "canceled", by: "user" });
    await restoring;
    await flush();
    expect(h.shown()).toBeNull();

    h.setFree(true);
    await flush();
    expect(h.shown()).toEqual(ONE);
  });

  it("shows no prompt more after a request to quit stopped the restore", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();
    const restoring = h.prompt.restore();
    h.restores[0]?.resolve({ status: "canceled", by: "quit" });
    await restoring;
    await flush();

    expect(h.shown()).toBeNull();
    h.setFree(true);
    await flush();
    expect(h.shown()).toBeNull();
  });

  it("does nothing while no prompt shows", async () => {
    const h = harness();
    await h.prompt.restore();
    expect(h.restore).not.toHaveBeenCalled();
  });
});

describe("Discard", () => {
  it("removes the offer, and then shows the prompt for the next offer", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    const discarding = h.prompt.discard();
    expect(h.discard).toHaveBeenCalledWith(TWO.id);
    await flush();
    // The next prompt waits for the end of the removal.
    expect(h.shown()).toBeNull();
    h.discards[0]?.resolve({ owner: true, status: "done" });
    await discarding;
    await flush();
    expect(h.shown()).toEqual(ONE);
  });

  it("goes to the next offer also when the removal failed", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    const discarding = h.prompt.discard();
    h.discards[0]?.resolve({ owner: true, status: "failed" });
    await discarding;
    await flush();

    expect(h.shown()).toEqual(ONE);
    // The offer of the failed removal is not offered again in this life of the page.
    expect(h.offers.getState().offers).toEqual([]);
  });

  it("goes to the next offer when the removal rejects", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    const discarding = h.prompt.discard();
    h.discards[0]?.reject(new Error("no shell"));
    await discarding;
    await flush();

    expect(h.shown()).toEqual(ONE);
  });
});

describe("Not Now and the dismissal", () => {
  it("closes the prompt, and shows no prompt more in this life of the page", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    h.prompt.notNow();
    await flush();
    expect(h.shown()).toBeNull();
    h.offers.getState().add([THREE]);
    await flush();
    expect(h.shown()).toBeNull();
    // The offers stay for the next start.
    expect(h.offers.getState().offers).toEqual([THREE, ONE]);
  });

  it("is Not Now for Escape, and ignores the dismissal that Radix sends after a button", async () => {
    const h = harness();
    h.offers.getState().add([ONE, TWO]);
    await flush();

    const shown = h.shown() ?? undefined;
    const discarding = h.prompt.discard();
    h.prompt.cancel(shown);
    h.discards[0]?.resolve({ owner: true, status: "done" });
    await discarding;
    await flush();
    expect(h.shown()).toEqual(ONE);

    h.prompt.cancel(shown);
    expect(h.shown()).toEqual(ONE);
    h.prompt.cancel(h.shown() ?? undefined);
    expect(h.shown()).toBeNull();
  });
});

describe("canShowRecoveryPrompt", () => {
  const FREE: RecoveryPromptFacts = {
    guardFree: true,
    projectDialogOpen: false,
    saveErrorOpen: false,
    exportDialogOpen: false,
    exportOpenStepWaiting: false,
    nativeMenuOpen: false,
    otherDialogOpen: false,
  };

  it("is true only while no dialog shows, the guard is free, and no trim runs", () => {
    expect(canShowRecoveryPrompt(FREE)).toBe(true);
    expect(canShowRecoveryPrompt({ ...FREE, guardFree: false })).toBe(false);
    expect(canShowRecoveryPrompt({ ...FREE, projectDialogOpen: true })).toBe(false);
    expect(canShowRecoveryPrompt({ ...FREE, saveErrorOpen: true })).toBe(false);
    expect(canShowRecoveryPrompt({ ...FREE, exportDialogOpen: true })).toBe(false);
    expect(canShowRecoveryPrompt({ ...FREE, otherDialogOpen: true })).toBe(false);
  });

  it("waits for an open step of the export that has not opened its dialog yet", () => {
    expect(canShowRecoveryPrompt({ ...FREE, exportOpenStepWaiting: true })).toBe(false);
  });

  it("waits for a native menu whose choice is pending", () => {
    expect(canShowRecoveryPrompt({ ...FREE, nativeMenuOpen: true })).toBe(false);
  });
});

describe("the gate follows an open step of the export (ADR 073)", () => {
  it("shows the prompt when the open step of the export ended, and not before", async () => {
    let waiting = true;
    const listeners = new Set<() => void>();
    const offers = createRecoveryOffersStore();
    const prompt = createRecoveryPrompt({
      offers,
      canShow: () =>
        canShowRecoveryPrompt({
          guardFree: true,
          projectDialogOpen: false,
          saveErrorOpen: false,
          exportDialogOpen: false,
          exportOpenStepWaiting: waiting,
          nativeMenuOpen: false,
          otherDialogOpen: false,
        }),
      watch: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      restore: () => Promise.resolve({ status: "restored" }),
      discard: () => Promise.resolve(),
    });
    offers.getState().add([ONE]);
    await flush();
    expect(prompt.store.getState().offer).toBeNull();

    // The step settles with no dialog, as after a check that failed, and tells it.
    waiting = false;
    for (const listener of [...listeners]) {
      listener();
    }
    await flush();
    expect(prompt.store.getState().offer).toEqual(ONE);
  });
});

describe("watchEach", () => {
  it("subscribes the listener to each source, and stops them all with one call", () => {
    const releases = [vi.fn(), vi.fn()];
    const listener = vi.fn();
    const sources = releases.map((release) =>
      vi.fn((next: () => void) => {
        next();
        return release;
      }),
    );

    const stop = watchEach(sources, listener);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(releases[0]).not.toHaveBeenCalled();

    stop();
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });
});
