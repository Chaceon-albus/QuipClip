import { describe, expect, it } from "vitest";
import type { Pts, Rational } from "@/types/project";
import {
  getDisplayedElapsedSeconds,
  isPlaybackPositionApproximate,
} from "./presentation";
import type { CalibrationStatus, PresentedFrame } from "./types";

describe("isPlaybackPositionApproximate", () => {
  const presented: PresentedFrame = {
    mediaTime: 1,
    inferredSourcePts: "25" as Pts,
  };

  const statuses: CalibrationStatus[] = ["calibrating", "ready", "unavailable"];

  it("reports an exact position only for a ready status with a presented frame", () => {
    expect(isPlaybackPositionApproximate("ready", presented)).toBe(false);
  });

  it("reports an approximate position for a ready status awaiting the RVFC callback", () => {
    expect(isPlaybackPositionApproximate("ready", null)).toBe(true);
  });

  it.each(statuses.filter((status) => status !== "ready"))(
    "reports an approximate position for status %s with a presented frame",
    (status) => {
      expect(isPlaybackPositionApproximate(status, presented)).toBe(true);
    },
  );

  it.each(statuses.filter((status) => status !== "ready"))(
    "reports an approximate position for status %s with no presented frame",
    (status) => {
      expect(isPlaybackPositionApproximate(status, null)).toBe(true);
    },
  );
});

describe("getDisplayedElapsedSeconds", () => {
  const tb25: Rational = { n: 1, d: 25 };
  const startPts = "0" as Pts;
  const presentedFrame: PresentedFrame = {
    mediaTime: 2.0,
    inferredSourcePts: "50" as Pts, // 50 / 25 = 2.0s
  };

  it("prioritizes finite seekTargetSeconds over presentedFrame and approximate clock", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: 3.5,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 1.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(3.5);
  });

  it("prioritizes seekTargetSeconds of 0 over other positions", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: 0,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 5.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(0);
  });

  it("falls back to presentedFrame inferred PTS when seekTargetSeconds is null and calibrated", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 1.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(2.0);
  });

  it("falls back to 0 when calibrated presentedFrame elapsed calculation yields null", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: {
          mediaTime: 1.0,
          inferredSourcePts: "invalid" as Pts,
        },
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 4.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(0);
  });

  it("falls back to approximateBrowserTimeSeconds when status is not ready", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: null,
        calibrationStatus: "calibrating",
        approximateBrowserTimeSeconds: 4.25,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(4.25);
  });

  it("falls back to approximateBrowserTimeSeconds when presentedFrame is null in ready status", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: null,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 6.5,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(6.5);
  });

  it("falls back to approximateBrowserTimeSeconds when timing metadata is missing", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 7.2,
      },
      null,
      undefined,
    );
    expect(result).toBe(7.2);
  });

  it("returns 0 when approximateBrowserTimeSeconds is null and no other position is available", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: null,
        presentedFrame: null,
        calibrationStatus: "unavailable",
        approximateBrowserTimeSeconds: null,
      },
      null,
      null,
    );
    expect(result).toBe(0);
  });

  it("ignores non-finite seekTargetSeconds and proceeds down the priority chain", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: Number.NaN,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 1.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(2.0);
  });

  it("ignores negative seekTargetSeconds and proceeds down the priority chain", () => {
    const result = getDisplayedElapsedSeconds(
      {
        seekTargetSeconds: -1.0,
        presentedFrame,
        calibrationStatus: "ready",
        approximateBrowserTimeSeconds: 1.0,
      },
      startPts,
      tb25,
    );
    expect(result).toBe(2.0);
  });
});
