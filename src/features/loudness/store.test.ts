import { describe, expect, it, vi } from "vitest";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts } from "@/types/project";
import { LoudnessCache } from "./cache";
import type { LoudnessHandlers, LoudnessJob } from "./client";
import { createLoudnessStore } from "./store";
import { LoudnessError, type LoudnessEnd, type LoudnessScope } from "./types";

function scope(size = 10, revised = true): LoudnessScope {
  return {
    sources: [
      {
        id: "a",
        path: "/media/a.mp4",
        ...(revised ? { expectedRevision: { size, mtime: 1 } } : {}),
      },
    ],
    pieces: [{ sourceId: "a", inPts: "0" as Pts, outPts: "9000" as Pts }],
    segmentCount: 1,
    preset: createPresetDraft("p", "P"),
    streams: "videoAndAudio",
  };
}

/** A fake of the client: each start is a job that Rust accepted, and that the test ends. */
function fakeClient() {
  const jobs: {
    scope: LoudnessScope;
    handlers: LoudnessHandlers;
    canceled: boolean;
  }[] = [];
  const start = (scope: LoudnessScope, handlers: LoudnessHandlers): LoudnessJob => {
    const job = { scope, handlers, canceled: false };
    jobs.push(job);
    return {
      started: Promise.resolve({ jobId: jobs.length }),
      cancel: () => {
        job.canceled = true;
      },
    };
  };
  return { jobs, start };
}

const COMPLETE: LoudnessEnd = {
  status: "complete",
  integratedLufs: -14,
  truePeakDbtp: 0.7,
};

describe("the measurement of the setup step (ADR 061)", () => {
  it("measures, reports the progress, and keeps the result", () => {
    const client = fakeClient();
    const cache = new LoudnessCache();
    const store = createLoudnessStore({ start: client.start, cache });
    store.getState().measure(scope());
    expect(store.getState().measurement).toEqual({
      status: "measuring",
      generation: 1,
      progress: null,
    });
    client.jobs[0].handlers.onProgress({ readUs: 5, totalUs: 10 });
    expect(store.getState().measurement).toMatchObject({ progress: { readUs: 5 } });
    client.jobs[0].handlers.onEnd(COMPLETE);
    expect(store.getState().measurement).toEqual({
      status: "complete",
      generation: 1,
      values: { integratedLufs: -14, truePeakDbtp: 0.7 },
    });
    // The same audio again: the kept result, at once, with a new generation.
    store.getState().measure(scope());
    expect(client.jobs).toHaveLength(1);
    expect(store.getState().measurement).toMatchObject({
      status: "complete",
      generation: 2,
    });
  });

  it("measures again a source with no revision, and keeps nothing for it", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10, false));
    client.jobs[0].handlers.onEnd(COMPLETE);
    store.getState().measure(scope(10, false));
    expect(client.jobs).toHaveLength(2);
  });

  it("starts another measurement after the end of the one that it cancels", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    store.getState().measure(scope(11));
    expect(client.jobs[0].canceled).toBe(true);
    // Rust runs one measurement at a time: the next one waits for this end.
    expect(client.jobs).toHaveLength(1);
    client.jobs[0].handlers.onEnd({ status: "canceled" });
    expect(client.jobs).toHaveLength(2);
    expect(client.jobs[1].scope.sources[0].expectedRevision?.size).toBe(11);
    expect(store.getState().measurement.status).toBe("measuring");
    client.jobs[1].handlers.onEnd(COMPLETE);
    expect(store.getState().measurement.status).toBe("complete");
  });

  it("asks again for a measurement that it canceled, after its end", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    store.getState().measure(scope(11));
    store.getState().measure(scope(10));
    client.jobs[0].handlers.onEnd({ status: "canceled" });
    expect(client.jobs).toHaveLength(2);
    expect(client.jobs[1].scope.sources[0].expectedRevision?.size).toBe(10);
  });

  it("keeps the measurement that runs when the step asks for it again", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    store.getState().measure(scope(10));
    expect(client.jobs).toHaveLength(1);
    expect(client.jobs[0].canceled).toBe(false);
    client.jobs[0].handlers.onEnd(COMPLETE);
    expect(store.getState().measurement).toMatchObject({
      status: "complete",
      generation: 2,
    });
  });

  it("ignores the progress of a job that it canceled, also when the step asks for it again", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    store.getState().measure(scope(11));
    store.getState().measure(scope(10));
    // The canceled job still sends a progress message before its end.
    client.jobs[0].handlers.onProgress({ readUs: 5, totalUs: 10 });
    expect(store.getState().measurement).toMatchObject({
      status: "measuring",
      progress: null,
    });
    client.jobs[0].handlers.onEnd({ status: "canceled" });
    expect(client.jobs).toHaveLength(2);
    client.jobs[1].handlers.onProgress({ readUs: 6, totalUs: 10 });
    expect(store.getState().measurement).toMatchObject({ progress: { readUs: 6 } });
  });

  it("lets a subscriber stop or replace the measurement that a call starts", () => {
    const client = fakeClient();
    const stopping = createLoudnessStore({ start: client.start });
    const unsubscribe = stopping.subscribe((state) => {
      if (state.measurement.status === "measuring") {
        unsubscribe();
        state.stop();
      }
    });
    stopping.getState().measure(scope(10));
    expect(client.jobs).toHaveLength(0);
    expect(stopping.getState().measurement.status).toBe("idle");

    const replacing = createLoudnessStore({ start: client.start });
    const stopListening = replacing.subscribe((state) => {
      if (state.measurement.status === "measuring") {
        stopListening();
        state.measure(scope(20));
      }
    });
    replacing.getState().measure(scope(10));
    expect(client.jobs).toHaveLength(1);
    expect(client.jobs[0].scope.sources[0].expectedRevision?.size).toBe(20);
    expect(client.jobs[0].canceled).toBe(false);
    client.jobs[0].handlers.onEnd(COMPLETE);
    expect(replacing.getState().measurement.status).toBe("complete");
  });

  it("starts again while Rust still holds its slot, and gives up after its limit", async () => {
    vi.useFakeTimers();
    try {
      let refusals = 2;
      const starts: LoudnessScope[] = [];
      const handlers: LoudnessHandlers[] = [];
      const store = createLoudnessStore({
        start: (requested, given) => {
          starts.push(requested);
          handlers.push(given);
          const refused = refusals > 0;
          refusals -= 1;
          return {
            started: refused
              ? Promise.reject(new LoudnessError("busy"))
              : Promise.resolve({ jobId: starts.length }),
            cancel: () => undefined,
          };
        },
        busyRetryMs: 100,
        busyRetryLimitMs: 1_000,
      });
      store.getState().measure(scope(10));
      await vi.advanceTimersByTimeAsync(250);
      expect(starts).toHaveLength(3);
      expect(store.getState().measurement.status).toBe("measuring");
      handlers[2].onEnd(COMPLETE);
      expect(store.getState().measurement.status).toBe("complete");

      // A slot that stays taken past the limit is a refusal.
      refusals = 1_000;
      store.getState().measure(scope(11));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(store.getState().measurement).toMatchObject({
        status: "failed",
        code: "busy",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a request that waits from a result that a canceled measurement still gave", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    store.getState().measure(scope(11));
    store.getState().measure(scope(10));
    // The canceled measurement of the first scope completed all the same.
    client.jobs[0].handlers.onEnd(COMPLETE);
    expect(client.jobs).toHaveLength(1);
    expect(store.getState().measurement).toMatchObject({
      status: "complete",
      generation: 3,
      values: { integratedLufs: -14 },
    });
  });

  it("sends a cancel that came while the store waited for the job", () => {
    const canceled: number[] = [];
    let store: ReturnType<typeof createLoudnessStore> | null = null;
    store = createLoudnessStore({
      start: () => {
        // A subscriber stops the measurement before the start returns its job.
        store?.getState().stop();
        return {
          started: Promise.resolve({ jobId: 1 }),
          cancel: () => {
            canceled.push(1);
          },
        };
      },
    });
    store.getState().measure(scope(10));
    expect(canceled).toEqual([1]);
    expect(store.getState().measurement.status).toBe("idle");
  });

  it("stops: cancels the measurement and ignores its end", () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope());
    store.getState().stop();
    expect(client.jobs[0].canceled).toBe(true);
    expect(store.getState().measurement.status).toBe("idle");
    client.jobs[0].handlers.onProgress({ readUs: 1, totalUs: 2 });
    client.jobs[0].handlers.onEnd({ status: "canceled" });
    expect(store.getState().measurement.status).toBe("idle");
  });

  it("reports a failure of the measurement and a refusal of its start", async () => {
    const client = fakeClient();
    const store = createLoudnessStore({ start: client.start });
    store.getState().measure(scope(10));
    client.jobs[0].handlers.onEnd({
      status: "failed",
      code: "audioShort",
      detail: "x",
    });
    expect(store.getState().measurement).toEqual({
      status: "failed",
      generation: 1,
      code: "audioShort",
      detail: "x",
    });

    // Rust refuses the start for a page before the last page load: no end message comes, and
    // the store reports the refusal at once. (`busy` starts again; see the test above.)
    const refusing = createLoudnessStore({
      start: () => ({
        started: Promise.reject(new LoudnessError("superseded")),
        cancel: () => undefined,
      }),
    });
    refusing.getState().measure(scope(12));
    await vi.waitFor(() => {
      expect(refusing.getState().measurement.status).toBe("failed");
    });
    expect(refusing.getState().measurement).toMatchObject({
      status: "failed",
      code: "superseded",
    });
  });
});
