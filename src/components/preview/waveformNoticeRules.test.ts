import { describe, expect, it } from "vitest";
import {
  IDLE_WAVEFORM_SOURCE,
  type WaveformSourceState,
  type WaveformState,
} from "@/features/waveform";
import {
  resolveWaveformNotices,
  WAVEFORM_ERROR_KEYS,
  waveformErrorKey,
} from "./waveformNoticeRules";

function state(
  sources: Record<string, Partial<WaveformSourceState>>,
  runningSourceId: string | null = null,
): WaveformState {
  return {
    runningSourceId,
    sources: Object.fromEntries(
      Object.entries(sources).map(([id, source]) => [
        id,
        { ...IDLE_WAVEFORM_SOURCE, ...source },
      ]),
    ),
  };
}

const name = (sourceId: string) => `${sourceId}.flv`;

describe("resolveWaveformNotices", () => {
  it("warns while a job reads the file, with its progress", () => {
    expect(
      resolveWaveformNotices(
        state({ s1: { phase: "running", cached: false, progress: 0.426 } }, "s1"),
        name,
      ),
    ).toEqual([{ kind: "waveform", sourceId: "s1", name: "s1.flv", percent: 42 }]);
    expect(
      resolveWaveformNotices(
        state({ s1: { phase: "running", cached: false, progress: null } }, "s1"),
        name,
      ),
    ).toEqual([{ kind: "waveform", sourceId: "s1", name: "s1.flv", percent: null }]);
  });

  it("shows no warning for a cache hit or before the reply of the start", () => {
    expect(
      resolveWaveformNotices(
        state({ s1: { phase: "running", cached: true } }, "s1"),
        name,
      ),
    ).toEqual([]);
    expect(
      resolveWaveformNotices(
        state({ s1: { phase: "running", cached: null } }, "s1"),
        name,
      ),
    ).toEqual([]);
  });

  it("shows the error of a failed job with its diagnostic text", () => {
    expect(
      resolveWaveformNotices(
        state({
          s2: { phase: "failed", errorCode: "readFailed", errorDetail: "EIO" },
        }),
        name,
      ),
    ).toEqual([
      {
        kind: "waveformError",
        sourceId: "s2",
        name: "s2.flv",
        messageKey: WAVEFORM_ERROR_KEYS.readFailed,
        detail: "EIO",
      },
    ]);
  });

  it("puts the running job first and hides a closed notice", () => {
    const notices = resolveWaveformNotices(
      state(
        {
          s1: { phase: "failed", errorCode: "busy" },
          s2: { phase: "running", cached: false, progress: 1.4 },
          s3: { phase: "failed", errorCode: "decodeFailed", noticeDismissed: true },
          s4: { phase: "ready" },
        },
        "s2",
      ),
      name,
    );
    expect(notices.map((notice) => [notice.kind, notice.sourceId])).toEqual([
      ["waveform", "s2"],
      ["waveformError", "s1"],
    ]);
    expect(notices[0]).toMatchObject({ percent: 100 });
  });
});

describe("waveformErrorKey", () => {
  it("gives each code a whole message", () => {
    expect(waveformErrorKey("ffmpegNotFound")).toBe(WAVEFORM_ERROR_KEYS.ffmpegNotFound);
    expect(waveformErrorKey("sourceChanged")).toBe(WAVEFORM_ERROR_KEYS.sourceChanged);
    expect(waveformErrorKey("sourceUnreadable")).toBe(WAVEFORM_ERROR_KEYS.readFailed);
    expect(waveformErrorKey("spawnFailed")).toBe(WAVEFORM_ERROR_KEYS.decodeFailed);
    expect(waveformErrorKey("busy")).toBe(WAVEFORM_ERROR_KEYS.busy);
    expect(waveformErrorKey("invalidResponse")).toBe(WAVEFORM_ERROR_KEYS.other);
    expect(waveformErrorKey(null)).toBe(WAVEFORM_ERROR_KEYS.other);
  });
});
