import { describe, expect, it } from "vitest";
import type { TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational, TickCount } from "@/types/project";
import {
  createSourceLifecycleGuard,
  formatApproximateTime,
  formatPreviewCurrentTime,
  formatPreviewTotalDuration,
  formatSourceRelativeTime,
  showsApproximateBadge,
  SourceLifecycleController,
} from "./previewFrame";

describe("Preview Frame Helpers & ADR 003 Math", () => {
  const tb25: Rational = { n: 1, d: 25 };
  const tb30: Rational = { n: 1, d: 30 };
  const tbNtsc: Rational = { n: 1001, d: 30000 };
  const tb90k: Rational = { n: 1, d: 90000 };

  // These displays use the smallest frame boundary margin, so the tests below check the
  // routing of each position to the formatter. The one-tick margin has its own test.
  const frames25: TimecodeDisplay = {
    format: "frames",
    rate: { n: 25, d: 1 },
    videoTimeBase: null,
  };
  const frames2997: TimecodeDisplay = {
    format: "frames",
    rate: { n: 30000, d: 1001 },
    videoTimeBase: null,
  };
  const milliseconds: TimecodeDisplay = { format: "milliseconds" };

  describe("frame format (ADR 028)", () => {
    it("formats an inferred PTS with exact frame arithmetic", () => {
      expect(formatSourceRelativeTime("1" as Pts, "0" as Pts, tb25, frames25)).toBe(
        "00:00:00:01",
      );
      expect(
        formatSourceRelativeTime("5025" as Pts, "5000" as Pts, tb25, frames25),
      ).toBe("00:00:01:00");
      expect(formatSourceRelativeTime("-25" as Pts, "-50" as Pts, tb25, frames25)).toBe(
        "00:00:01:00",
      );
      // Frame 15 at 29.97 fps with a 1/90000 time base.
      expect(
        formatSourceRelativeTime("135045" as Pts, "90000" as Pts, tb90k, frames2997),
      ).toBe("00:00:00:15");
    });

    it("formats an inferred PTS before the start with a leading minus sign", () => {
      expect(formatSourceRelativeTime("0" as Pts, "25" as Pts, tb25, frames25)).toBe(
        "-00:00:01:00",
      );
    });

    it("formats an invalid PTS as zero frames", () => {
      expect(
        formatSourceRelativeTime("invalid" as Pts, "0" as Pts, tb25, frames25),
      ).toBe("00:00:00:00");
      expect(
        formatSourceRelativeTime("0" as Pts, "0" as Pts, { n: 0, d: 1 }, frames25),
      ).toBe("00:00:00:00");
    });

    it("formats a PTS delta above the safe-integer range in frames", () => {
      // The millisecond format cannot convert this delta; the exact frame format can.
      expect(
        formatSourceRelativeTime(
          "9007199254740993" as Pts,
          "0" as Pts,
          tb90k,
          frames25,
        ),
      ).toMatch(/^\d+:\d{2}:\d{2}:\d{2}$/);
      expect(
        formatSourceRelativeTime(
          "9007199254740993" as Pts,
          "0" as Pts,
          tb90k,
          milliseconds,
        ),
      ).toBe("00:00:00.000");
    });

    it("formats the approximate clock in frames", () => {
      expect(formatApproximateTime(1.16, frames25)).toBe("00:00:01:04");
      expect(formatApproximateTime(-1.5, frames25)).toBe("-00:00:01:12");
      expect(formatApproximateTime(Number.NaN, frames25)).toBe("00:00:00:00");
    });

    it("formats the total extent in frames", () => {
      expect(formatPreviewTotalDuration(null, "250" as TickCount, tb25, frames25)).toBe(
        "00:00:10:00",
      );
      expect(formatPreviewTotalDuration(12.345, null, null, frames25)).toBe(
        "00:00:12:08",
      );
    });

    it("formats the pending seek target in frames", () => {
      const presented = { mediaTime: 1.0, inferredSourcePts: "25" as Pts };
      expect(
        formatPreviewCurrentTime(
          presented,
          "ready",
          "0" as Pts,
          tb25,
          1.0,
          1.16,
          frames25,
        ),
      ).toBe("00:00:01:04");
      expect(
        formatPreviewCurrentTime(null, "unavailable", null, tb25, 3.75, null, frames25),
      ).toBe("00:00:03:18");
    });

    it("formats the presented frame in frames when no seek is pending", () => {
      const presented = { mediaTime: 1.0, inferredSourcePts: "29" as Pts };
      expect(
        formatPreviewCurrentTime(
          presented,
          "ready",
          "0" as Pts,
          tb25,
          1.0,
          null,
          frames25,
        ),
      ).toBe("00:00:01:04");
    });

    it("shows the same frame for a seek target and the frame that answers it (ADR 022)", () => {
      // Frame 15 at 29.97 fps, one tick per frame. The seek target is the floating-point
      // value of its exact start.
      const presented = { mediaTime: 0.5005, inferredSourcePts: "15" as Pts };
      const target = (15 * 1001) / 30000;
      const whilePending = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tbNtsc,
        0.5005,
        target,
        frames2997,
      );
      const settled = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tbNtsc,
        0.5005,
        null,
        frames2997,
      );
      expect(whilePending).toBe("00:00:00:15");
      expect(settled).toBe(whilePending);
    });

    it("applies the one-tick margin of the display's time base to a PTS and a seek target", () => {
      // Matroska stores PTS in milliseconds. Frame 3 at 29.97 fps starts at 100.1 ms, and
      // its PTS is 100. Without the margin it would show frame 02.
      const tbMilli: Rational = { n: 1, d: 1000 };
      const matroska2997: TimecodeDisplay = {
        format: "frames",
        rate: { n: 30000, d: 1001 },
        videoTimeBase: tbMilli,
      };
      const presented = { mediaTime: 0.1, inferredSourcePts: "100" as Pts };
      const settled = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tbMilli,
        0.1,
        null,
        matroska2997,
      );
      // A seek target 0.9 frame into frame 3.
      const target = (3.9 * 1001) / 30000;
      const whilePending = formatPreviewCurrentTime(
        presented,
        "ready",
        "0" as Pts,
        tbMilli,
        0.1,
        target,
        matroska2997,
      );
      expect(settled).toBe("00:00:00:03");
      expect(whilePending).toBe(settled);
      expect(
        formatSourceRelativeTime("100" as Pts, "0" as Pts, tbMilli, frames2997),
      ).toBe("00:00:00:02");
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

    it("returns the placeholder when both are unavailable or invalid, because the extent is unknown", () => {
      expect(formatPreviewTotalDuration(null, null, null)).toBe("--:--:--.---");
      expect(formatPreviewTotalDuration(undefined, null, null)).toBe("--:--:--.---");
      expect(formatPreviewTotalDuration(-1, null, null)).toBe("--:--:--.---");
      expect(formatPreviewTotalDuration(null, null, null, frames25)).toBe(
        "--:--:--:--",
      );
    });

    it("falls back to the approximate duration when the tick count cannot be converted", () => {
      expect(
        formatPreviewTotalDuration(12.345, "9007199254740993" as TickCount, tb25),
      ).toBe("00:00:12.345");
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

  describe("showsApproximateBadge", () => {
    it("marks a source that cannot calibrate while the picture plays", () => {
      expect(showsApproximateBadge("unavailable", false)).toBe(true);
    });

    it("keeps a ready source unmarked even when presentedFrame is null between a seek and its frame callback", () => {
      // Locking down the frame step flicker regression: the badge depends on calibration status alone
      expect(showsApproximateBadge("ready", false)).toBe(false);
    });

    it("does not mark the position while the calibration runs", () => {
      // The status bar says Preparing in the neutral tone. The state ends at the first frame.
      expect(showsApproximateBadge("calibrating", false)).toBe(false);
    });

    it("hides the badge while the decode-failure panel replaces the picture", () => {
      expect(showsApproximateBadge("calibrating", true)).toBe(false);
      expect(showsApproximateBadge("unavailable", true)).toBe(false);
      expect(showsApproximateBadge("ready", true)).toBe(false);
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
