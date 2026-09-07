import { describe, expect, it } from "vitest";
import type { Pts } from "@/types/project";
import { isPlaybackPositionApproximate } from "./presentation";
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
