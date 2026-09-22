import { describe, expect, it } from "vitest";
import type { Pts, Rational, TickCount } from "@/types/project";
import {
  createSourceLifecycleGuard,
  formatApproximateTime,
  formatMillisecondsTimecode,
  formatPreviewCurrentTime,
  formatPreviewTotalDuration,
  formatSourceRelativeTime,
  isPreviewTimeApproximate,
  SourceLifecycleController,
} from "./previewFrame";

describe("Preview Frame Helpers & ADR 003 Math", () => {
  const tb25: Rational = { n: 1, d: 25 };
  const tb30: Rational = { n: 1, d: 30 };
  const tbNtsc: Rational = { n: 1001, d: 30000 };
  const tb90k: Rational = { n: 1, d: 90000 };

  describe("formatMillisecondsTimecode", () => {
    it("formats 0 seconds as 00:00:00.000", () => {
      expect(formatMillisecondsTimecode(0)).toBe("00:00:00.000");
    });

    it("formats whole seconds and sub-second milliseconds accurately", () => {
      expect(formatMillisecondsTimecode(1)).toBe("00:00:01.000");
      expect(formatMillisecondsTimecode(1.234)).toBe("00:00:01.234");
      expect(formatMillisecondsTimecode(1.005)).toBe("00:00:01.005");
      expect(formatMillisecondsTimecode(59.999)).toBe("00:00:59.999");
    });

    it("formats minutes and hours rollover correctly", () => {
      expect(formatMillisecondsTimecode(60)).toBe("00:01:00.000");
      expect(formatMillisecondsTimecode(3600)).toBe("01:00:00.000");
      expect(formatMillisecondsTimecode(3661.5)).toBe("01:01:01.500");
      expect(formatMillisecondsTimecode(3723.456)).toBe("01:02:03.456");
    });

    it("handles invalid or non-finite inputs by returning 00:00:00.000", () => {
      expect(formatMillisecondsTimecode(-1)).toBe("00:00:00.000");
      expect(formatMillisecondsTimecode(NaN)).toBe("00:00:00.000");
      expect(formatMillisecondsTimecode(Infinity)).toBe("00:00:00.000");
      expect(formatMillisecondsTimecode(-Infinity)).toBe("00:00:00.000");
      expect(formatMillisecondsTimecode(null as unknown as number)).toBe(
        "00:00:00.000",
      );
      expect(formatMillisecondsTimecode(Number.MAX_VALUE)).toBe("00:00:00.000");
    });
  });

  describe("formatSourceRelativeTime", () => {
    it("formats zero elapsed time relative to videoStartPts as 00:00:00.000", () => {
      expect(formatSourceRelativeTime("0" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:00.000",
      );
      expect(formatSourceRelativeTime("1000" as Pts, "1000" as Pts, tb25)).toBe(
        "00:00:00.000",
      );
    });

    it("formats positive elapsed PTS with zero start PTS at 25 fps and 30 fps", () => {
      // 25 ticks at 1/25 is exactly 1.000s
      expect(formatSourceRelativeTime("25" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:01.000",
      );
      // 30 ticks at 1/30 is exactly 1.000s
      expect(formatSourceRelativeTime("30" as Pts, "0" as Pts, tb30)).toBe(
        "00:00:01.000",
      );
      // 50 ticks at 1/25 is exactly 2.000s
      expect(formatSourceRelativeTime("50" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:02.000",
      );
      // 1 tick at 1/25 is 0.040s (40ms)
      expect(formatSourceRelativeTime("1" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:00.040",
      );
    });

    it("formats positive elapsed PTS with nonzero start PTS", () => {
      const startPts = "5000" as Pts;
      // Inferred PTS 5025 at 25fps -> delta 25 ticks -> 1.000s
      expect(formatSourceRelativeTime("5025" as Pts, startPts, tb25)).toBe(
        "00:00:01.000",
      );
      // Inferred PTS 5000 -> delta 0 ticks -> 0.000s
      expect(formatSourceRelativeTime("5000" as Pts, startPts, tb25)).toBe(
        "00:00:00.000",
      );
    });

    it("formats positive elapsed PTS with negative start PTS (ADR 002)", () => {
      const startPts = "-50" as Pts;
      // Inferred PTS -25 at 25fps -> delta (-25 - (-50)) = 25 ticks -> 1.000s
      expect(formatSourceRelativeTime("-25" as Pts, startPts, tb25)).toBe(
        "00:00:01.000",
      );
      // Inferred PTS 0 at 25fps -> delta (0 - (-50)) = 50 ticks -> 2.000s
      expect(formatSourceRelativeTime("0" as Pts, startPts, tb25)).toBe("00:00:02.000");
    });

    it("formats high-frequency time base (1/90000) accurately", () => {
      const startPts = "90000" as Pts;
      // 90000 ticks delta = 1.000s
      expect(formatSourceRelativeTime("180000" as Pts, startPts, tb90k)).toBe(
        "00:00:01.000",
      );
      // 45000 ticks delta = 0.500s
      expect(formatSourceRelativeTime("135000" as Pts, startPts, tb90k)).toBe(
        "00:00:00.500",
      );
    });

    it("formats fractional NTSC time base accurately", () => {
      const startPts = "0" as Pts;
      // 30000 ticks at 1001/30000 = 1001s = 16min 41s
      expect(formatSourceRelativeTime("30000" as Pts, startPts, tbNtsc)).toBe(
        "00:16:41.000",
      );
    });

    it("formats negative elapsed time with leading minus sign", () => {
      // Inferred PTS before start PTS
      expect(formatSourceRelativeTime("0" as Pts, "25" as Pts, tb25)).toBe(
        "-00:00:01.000",
      );
    });

    it("handles malformed or invalid PTS strings gracefully", () => {
      expect(formatSourceRelativeTime("invalid" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:00.000",
      );
      expect(formatSourceRelativeTime("0" as Pts, "invalid" as Pts, tb25)).toBe(
        "00:00:00.000",
      );
      expect(formatSourceRelativeTime("+10" as Pts, "0" as Pts, tb25)).toBe(
        "00:00:00.000",
      );
    });
  });

  describe("formatApproximateTime", () => {
    it("formats positive approximate seconds", () => {
      expect(formatApproximateTime(0)).toBe("00:00:00.000");
      expect(formatApproximateTime(5.123)).toBe("00:00:05.123");
      expect(formatApproximateTime(65.5)).toBe("00:01:05.500");
    });

    it("formats negative approximate seconds with minus sign", () => {
      expect(formatApproximateTime(-1.5)).toBe("-00:00:01.500");
    });

    it("handles non-finite approximate seconds", () => {
      expect(formatApproximateTime(NaN)).toBe("00:00:00.000");
      expect(formatApproximateTime(Infinity)).toBe("00:00:00.000");
    });
  });

  describe("formatPreviewTotalDuration", () => {
    it("formats reported source extent when videoDurationTicks and videoTimeBase exist", () => {
      const ticks = "250" as TickCount; // 250 ticks at 1/25 = 10.000s
      expect(formatPreviewTotalDuration(null, ticks, tb25)).toBe("00:00:10.000");
    });

    it("falls back to approximateDurationSeconds when ticks are unavailable", () => {
      expect(formatPreviewTotalDuration(12.345, null, null)).toBe("00:00:12.345");
    });

    it("returns 00:00:00.000 when both are unavailable or invalid", () => {
      expect(formatPreviewTotalDuration(null, null, null)).toBe("00:00:00.000");
      expect(formatPreviewTotalDuration(undefined, null, null)).toBe("00:00:00.000");
    });
  });

  describe("formatPreviewCurrentTime", () => {
    it("returns source-relative formatted time when calibrationStatus is ready", () => {
      const presented = {
        mediaTime: 1.0,
        inferredSourcePts: "25" as Pts,
      };
      const result = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tb25,
        1.0,
      );
      expect(result).toBe("00:00:01.000");
    });

    it("returns approximate browser time when calibrationStatus is calibrating", () => {
      const result = formatPreviewCurrentTime(
        null,
        "calibrating",
        "0" as Pts,
        tb25,
        2.5,
      );
      expect(result).toBe("00:00:02.500");
    });

    it("returns approximate browser time when calibrationStatus is unavailable", () => {
      const result = formatPreviewCurrentTime(null, "unavailable", null, tb25, 3.75);
      expect(result).toBe("00:00:03.750");
    });

    it("formats seekTargetSeconds when ready and seek is pending", () => {
      const presented = {
        mediaTime: 1.0,
        inferredSourcePts: "25" as Pts,
      };
      const result = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tb25,
        1.0,
        4.5,
      );
      expect(result).toBe("00:00:04.500");
    });

    it("formats seekTargetSeconds of 0 when ready and seek is pending", () => {
      const presented = {
        mediaTime: 1.0,
        inferredSourcePts: "25" as Pts,
      };
      const result = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tb25,
        1.0,
        0,
      );
      expect(result).toBe("00:00:00.000");
    });

    it("formats seekTargetSeconds when calibrating and seek is pending", () => {
      const result = formatPreviewCurrentTime(
        null,
        "calibrating",
        "0" as Pts,
        tb25,
        2.5,
        5.123,
      );
      expect(result).toBe("00:00:05.123");
    });

    it("formats seekTargetSeconds when unavailable and seek is pending", () => {
      const result = formatPreviewCurrentTime(
        null,
        "unavailable",
        null,
        tb25,
        3.75,
        7.89,
      );
      expect(result).toBe("00:00:07.890");
    });

    it("falls through when seekTargetSeconds is null or negative", () => {
      const presented = {
        mediaTime: 1.0,
        inferredSourcePts: "25" as Pts,
      };
      expect(
        formatPreviewCurrentTime(presented, "ready", "0" as Pts, tb25, 1.0, null),
      ).toBe("00:00:01.000");
      expect(
        formatPreviewCurrentTime(presented, "ready", "0" as Pts, tb25, 1.0, -1),
      ).toBe("00:00:01.000");
    });
  });

  describe("isPreviewTimeApproximate", () => {
    it("identifies calibration and unavailable fallbacks", () => {
      expect(isPreviewTimeApproximate("calibrating")).toBe(true);
      expect(isPreviewTimeApproximate("unavailable")).toBe(true);
    });

    it("keeps a ready source non-approximate even when presentedFrame is null between a seek and its frame callback", () => {
      // Locking down the frame step flicker regression: the badge depends on calibration status alone
      expect(isPreviewTimeApproximate("ready")).toBe(false);
    });
  });

  describe("Source Lifecycle Guard & Concurrency Controller", () => {
    const sourceA = "/videos/fileA.mp4:1048576:1724976000";
    const sourceB = "/videos/fileB.mp4:2097152:1724976500";

    it("activates source A and accepts callbacks for source A while rejecting unmatched sources", () => {
      const guard = createSourceLifecycleGuard();
      expect(guard.getActiveId()).toBe("");
      expect(guard.isActive(sourceA)).toBe(false);

      guard.activate(sourceA);
      expect(guard.getActiveId()).toBe(sourceA);
      expect(guard.isActive(sourceA)).toBe(true);
      expect(guard.isActive(sourceB)).toBe(false);
      expect(guard.isActive("")).toBe(false);
    });

    it("handles standard lifecycle transition (A cleanup then B activation), rejecting late A callbacks and accepting B", () => {
      const guard = createSourceLifecycleGuard(sourceA);
      expect(guard.isActive(sourceA)).toBe(true);

      // Layout effect transition: cleanup A, then activate B
      guard.deactivate(sourceA);
      expect(guard.isActive(sourceA)).toBe(false);
      expect(guard.getActiveId()).toBe("");

      guard.activate(sourceB);
      expect(guard.isActive(sourceB)).toBe(true);
      expect(guard.isActive(sourceA)).toBe(false);
      expect(guard.getActiveId()).toBe(sourceB);
    });

    it("handles inverted cleanup ordering (B activated before late A cleanup) without deactivating B", () => {
      const guard = createSourceLifecycleGuard(sourceA);

      // React / async edge case: B is activated before A's late cleanup runs
      guard.activate(sourceB);
      expect(guard.isActive(sourceB)).toBe(true);

      // Late cleanup for older source A fires
      guard.deactivate(sourceA);

      // Newer source B must remain active and not accidentally cleared
      expect(guard.isActive(sourceB)).toBe(true);
      expect(guard.getActiveId()).toBe(sourceB);
      expect(guard.isActive(sourceA)).toBe(false);
    });

    it("simulates React 19 StrictMode mount-unmount-remount cycle safely", () => {
      const guard = new SourceLifecycleController();

      // Initial mount layout effect
      guard.activate(sourceA);
      expect(guard.isActive(sourceA)).toBe(true);

      // StrictMode simulated unmount cleanup
      guard.deactivate(sourceA);
      expect(guard.isActive(sourceA)).toBe(false);

      // StrictMode simulated remount layout setup
      guard.activate(sourceA);
      expect(guard.isActive(sourceA)).toBe(true);
      expect(guard.getActiveId()).toBe(sourceA);
    });

    it("resets active state on targeted or unconditional deactivation", () => {
      const guard = createSourceLifecycleGuard(sourceA);

      // Targeted deactivation of active source
      guard.deactivate(sourceA);
      expect(guard.isActive(sourceA)).toBe(false);
      expect(guard.getActiveId()).toBe("");

      // Reactivate and unconditional deactivation
      guard.activate(sourceB);
      expect(guard.isActive(sourceB)).toBe(true);

      guard.deactivate();
      expect(guard.isActive(sourceB)).toBe(false);
      expect(guard.getActiveId()).toBe("");
    });

    it("safely handles empty, null, and undefined source identities", () => {
      const guard = createSourceLifecycleGuard();

      guard.activate("");
      expect(guard.getActiveId()).toBe("");
      expect(guard.isActive("")).toBe(false);

      guard.activate(null);
      expect(guard.getActiveId()).toBe("");
      expect(guard.isActive(null)).toBe(false);

      guard.activate(undefined);
      expect(guard.getActiveId()).toBe("");
      expect(guard.isActive(undefined)).toBe(false);
    });
  });
});
