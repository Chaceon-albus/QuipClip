import { describe, expect, it } from "vitest";
import type { ImportMediaResult } from "@/features/media/types";
import type { Pts } from "@/types/project";
import { resolveWaveformAction } from "./menuAction";
import { IDLE_WAVEFORM_SOURCE, type WaveformState } from "./store";

const MEDIA = {
  path: "/media/a.mp4",
  fileName: "a.mp4",
  size: 1,
  mtime: 1,
  probe: {
    videoStartPts: "0" as Pts,
    audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
  },
} as unknown as ImportMediaResult;

function withProbe(probe: Partial<ImportMediaResult["probe"]>): ImportMediaResult {
  return { ...MEDIA, probe: { ...MEDIA.probe, ...probe } };
}

const IDLE: WaveformState = { sources: {}, runningSourceId: null };

function state(phase: "running" | "ready" | "failed", sourceId = "s1"): WaveformState {
  return {
    sources: { [sourceId]: { ...IDLE_WAVEFORM_SOURCE, phase } },
    runningSourceId: phase === "running" ? sourceId : null,
  };
}

describe("resolveWaveformAction", () => {
  it("offers Show when nothing runs", () => {
    expect(resolveWaveformAction("s1", MEDIA, IDLE)).toEqual({
      action: "show",
      enabled: true,
    });
  });

  it("offers Cancel while this source runs", () => {
    expect(resolveWaveformAction("s1", MEDIA, state("running"))).toEqual({
      action: "cancel",
      enabled: true,
    });
  });

  it("offers Hide while the envelope shows", () => {
    expect(resolveWaveformAction("s1", MEDIA, state("ready"))).toEqual({
      action: "hide",
      enabled: true,
    });
  });

  it("disables Show while another source runs", () => {
    expect(resolveWaveformAction("s1", MEDIA, state("running", "s2"))).toEqual({
      action: "show",
      enabled: false,
    });
  });

  it("disables Show for a source with no audio, no start PTS, or no import result", () => {
    expect(resolveWaveformAction("s1", withProbe({ audio: null }), IDLE)).toEqual({
      action: "show",
      enabled: false,
    });
    expect(
      resolveWaveformAction("s1", withProbe({ videoStartPts: null }), IDLE),
    ).toEqual({
      action: "show",
      enabled: false,
    });
    expect(resolveWaveformAction("s1", undefined, IDLE).enabled).toBe(false);
  });

  it("offers Show again after a failed job", () => {
    expect(resolveWaveformAction("s1", MEDIA, state("failed"))).toEqual({
      action: "show",
      enabled: true,
    });
  });
});
