import { describe, expect, it } from "vitest";
import { LoudnessCache } from "@/features/loudness/cache";
import type { LoudnessHandlers, LoudnessJob } from "@/features/loudness/client";
import { createLoudnessStore, loudnessRequestId } from "@/features/loudness/store";
import type { LoudnessEnd, LoudnessScope } from "@/features/loudness/types";
import { createPresetDraft } from "@/features/settings/presetDocument";
import type { Pts } from "@/types/project";
import { createGainAdjust, presentGainAdjust } from "./gainAdjust";

/** The scope of an export of one source, `size` bytes long. */
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

/** True peaks of +0.7 dBTP fill -1.7 dB, and of -3.0 dBTP fill 0.0 dB. */
const complete = (truePeakDbtp: number): LoudnessEnd => ({
  status: "complete",
  integratedLufs: -14,
  truePeakDbtp,
});

/** The step, with a fake client: each start is a job that Rust accepted, and that the test ends. */
function setup() {
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
  const loudness = createLoudnessStore({ start, cache: new LoudnessCache() });
  const adjust = createGainAdjust(loudness);
  /** What a render that names the request of `shown` shows, with the gain of a preset. */
  const view = (shown: LoudnessScope | null, presetGainTenths = 0) =>
    presentGainAdjust(
      adjust.store.getState(),
      loudness.getState().measurement,
      shown === null ? null : loudnessRequestId(shown),
      presetGainTenths,
    );
  return { jobs, loudness, adjust, view };
}

describe("the Adjust switch of the setup step (ADR 061)", () => {
  it("measures when it becomes active, and fills the gain when the measurement completes", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope());
    expect(jobs).toHaveLength(1);
    // The field shows the gain of the preset, and the export waits.
    expect(view(scope(), -30)).toMatchObject({
      fieldText: "-3.0",
      measurement: { status: "measuring" },
      pending: true,
    });
    jobs[0].handlers.onEnd(complete(0.7));
    expect(view(scope(), -30)).toMatchObject({
      fieldText: "-1.7",
      measurement: { status: "complete" },
      pending: false,
    });
  });

  it("waits in a render that names a request that has not started yet", () => {
    const { jobs, adjust, view } = setup();
    // The first render of a later opening: the step follows nothing yet.
    expect(view(scope(), -30)).toMatchObject({
      fieldText: "-3.0",
      measurement: { status: "measuring" },
      pending: true,
    });
    adjust.follow(scope());
    jobs[0].handlers.onEnd(complete(0.7));
    // The first render after a change of the audio: the result is of the request before.
    expect(view(scope(20), -30)).toMatchObject({
      fieldText: "-3.0",
      measurement: { status: "measuring", progress: null },
      pending: true,
    });
  });

  it("shows the gain of the selected preset until a completion, and after a failure", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope());
    // Another preset with the same audio is the same request, and its gain shows.
    expect(view(scope(), 20).fieldText).toBe("2.0");
    jobs[0].handlers.onEnd({ status: "failed", code: "audioShort", detail: null });
    expect(view(scope(), 20)).toMatchObject({
      fieldText: "2.0",
      measurement: { status: "failed" },
      pending: false,
    });
    expect(view(scope(), -30).fieldText).toBe("-3.0");
  });

  it("keeps a typed gain for the same request, and forgets it for another", () => {
    const { jobs, loudness, adjust, view } = setup();
    adjust.follow(scope());
    jobs[0].handlers.onEnd(complete(0.7));
    adjust.type("-4.5");
    // A new object with the same audio changes nothing.
    adjust.follow(scope());
    expect(jobs).toHaveLength(1);
    expect(view(scope()).fieldText).toBe("-4.5");
    // The store publishes the same result again: it does not fill the field again.
    loudness.setState({ measurement: loudness.getState().measurement });
    expect(view(scope()).fieldText).toBe("-4.5");
    // Other audio is another request.
    adjust.follow(scope(20));
    expect(view(scope(20)).fieldText).toBe("0.0");
    expect(jobs).toHaveLength(2);
  });

  it("measures again when the audio changes, and a late result of the request before fills nothing", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope());
    adjust.follow(scope(20));
    // Rust runs one measurement at a time: the store cancels the first, and waits for its end.
    expect(jobs[0].canceled).toBe(true);
    expect(jobs).toHaveLength(1);
    jobs[0].handlers.onEnd(complete(0.7));
    expect(view(scope(20))).toMatchObject({ fieldText: "0.0", pending: true });
    expect(jobs).toHaveLength(2);
    expect(jobs[1].scope).toEqual(scope(20));
    jobs[1].handlers.onEnd(complete(-3));
    expect(view(scope(20))).toMatchObject({ fieldText: "0.0", pending: false });
    expect(view(scope(20)).measurement).toMatchObject({
      status: "complete",
      values: { truePeakDbtp: -3 },
    });
  });

  it("cancels when it stops being active, and shows nothing then", () => {
    const { jobs, loudness, adjust, view } = setup();
    adjust.follow(scope());
    // The dialog closes, the Audio switch turns off, or the Adjust switch turns off.
    adjust.follow(null);
    expect(jobs[0].canceled).toBe(true);
    expect(loudness.getState().measurement.status).toBe("idle");
    expect(view(null, -30)).toMatchObject({
      fieldText: "-3.0",
      measurement: { status: "idle" },
      pending: false,
    });
    // A typed value has no request to belong to.
    adjust.type("-9.0");
    expect(adjust.store.getState().text).toBeNull();
  });

  it("measures again when it becomes active again, and fills from a kept result at once", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope());
    jobs[0].handlers.onEnd(complete(0.7));
    adjust.type("-4.5");
    // A later opening of the dialog, or the Audio switch on again.
    adjust.follow(null);
    adjust.follow(scope());
    expect(jobs).toHaveLength(1);
    expect(view(scope())).toMatchObject({
      fieldText: "-1.7",
      measurement: { status: "complete" },
      pending: false,
    });
  });

  it("ends the wait at a cancel that the page did not ask for, with no line", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope());
    // Rust cancels its jobs at the exit.
    jobs[0].handlers.onEnd({ status: "canceled" });
    expect(view(scope(), -30)).toMatchObject({
      fieldText: "-3.0",
      measurement: { status: "idle" },
      pending: false,
    });
  });

  it("measures again a source with no revision when it becomes active again", () => {
    const { jobs, adjust, view } = setup();
    adjust.follow(scope(10, false));
    jobs[0].handlers.onEnd(complete(0.7));
    adjust.follow(null);
    adjust.follow(scope(10, false));
    expect(jobs).toHaveLength(2);
    expect(view(scope(10, false))).toMatchObject({ fieldText: "0.0", pending: true });
  });
});
