import { describe, expect, it } from "vitest";
import {
  calculateFrameFromCurrentTime,
  calculateFrameFromMediaTime,
  clampDisplayFrame,
  createSourceLifecycleGuard,
  formatDisplayTimecode,
  formatTotalTimecode,
  getMediaSourceIdentity,
  SourceLifecycleController,
} from "./previewFrame";

describe("Preview Frame Helpers & ADR-003 Math", () => {
  const fps30 = { n: 30, d: 1 };
  const fps25 = { n: 25, d: 1 };
  const fpsNtsc = { n: 30000, d: 1001 }; // ~29.97002997... fps

  describe("getMediaSourceIdentity", () => {
    it("returns empty string for null or undefined media", () => {
      expect(getMediaSourceIdentity(null)).toBe("");
      expect(getMediaSourceIdentity(undefined)).toBe("");
    });

    it("generates deterministic identity token from canonical path, size, and mtime", () => {
      const media = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      expect(getMediaSourceIdentity(media)).toBe(
        "/videos/sample.mp4:1048576:1724976000",
      );
    });

    it("produces distinct identity when file is modified at the same path (mtime changed)", () => {
      const original = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      const modified = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976500,
      };
      expect(getMediaSourceIdentity(original)).not.toBe(
        getMediaSourceIdentity(modified),
      );
    });

    it("produces distinct identity when file size changes at the same path", () => {
      const original = {
        path: "/videos/sample.mp4",
        size: 1048576,
        mtime: 1724976000,
      };
      const modified = {
        path: "/videos/sample.mp4",
        size: 2097152,
        mtime: 1724976000,
      };
      expect(getMediaSourceIdentity(original)).not.toBe(
        getMediaSourceIdentity(modified),
      );
    });
  });

  describe("clampDisplayFrame", () => {
    it("preserves valid frame indices within [0, frameCount - 1]", () => {
      expect(clampDisplayFrame(0, 300)).toBe(0);
      expect(clampDisplayFrame(150, 300)).toBe(150);
      expect(clampDisplayFrame(299, 300)).toBe(299);
    });

    it("clamps negative raw frame indices to 0", () => {
      expect(clampDisplayFrame(-1, 300)).toBe(0);
      expect(clampDisplayFrame(-100, 300)).toBe(0);
    });

    it("clamps upper bound to frameCount - 1", () => {
      expect(clampDisplayFrame(300, 300)).toBe(299);
      expect(clampDisplayFrame(500, 300)).toBe(299);
    });

    it("clamps to 0 when frameCount is 0 or negative", () => {
      expect(clampDisplayFrame(0, 0)).toBe(0);
      expect(clampDisplayFrame(10, 0)).toBe(0);
      expect(clampDisplayFrame(10, -50)).toBe(0);
    });

    it("handles non-integer floats by truncating and clamping safely", () => {
      expect(clampDisplayFrame(10.7, 300)).toBe(10);
      expect(clampDisplayFrame(-0.5, 300)).toBe(0);
      expect(clampDisplayFrame(NaN, 300)).toBe(0);
    });
  });

  describe("calculateFrameFromMediaTime (RVFC readback)", () => {
    it("converts mediaTime accurately with zero startTime at 25 fps", () => {
      const startTime = { n: 0, d: 1 };
      const frameCount = 250;

      // At 25 fps: 1.0s is frame 25
      expect(calculateFrameFromMediaTime(1.0, startTime, fps25, frameCount)).toBe(25);
      // 0.0s is frame 0
      expect(calculateFrameFromMediaTime(0.0, startTime, fps25, frameCount)).toBe(0);
      // 4.0s is frame 100
      expect(calculateFrameFromMediaTime(4.0, startTime, fps25, frameCount)).toBe(100);
    });

    it("handles positive startTime offset correctly at 30 fps", () => {
      // Stream starts at PTS = 1.0s (30 frames)
      const startTime = { n: 1, d: 1 };
      const frameCount = 300;

      // mediaTime = 1.0s corresponds to relative offset 0s -> frame 0
      expect(calculateFrameFromMediaTime(1.0, startTime, fps30, frameCount)).toBe(0);

      // mediaTime = 2.0s corresponds to relative offset 1.0s -> frame 30
      expect(calculateFrameFromMediaTime(2.0, startTime, fps30, frameCount)).toBe(30);

      // mediaTime = 0.5s corresponds to relative offset -0.5s -> clamped to frame 0
      expect(calculateFrameFromMediaTime(0.5, startTime, fps30, frameCount)).toBe(0);
    });

    it("handles negative startTime offset correctly at 25 fps", () => {
      // Container has negative PTS start: startTime = -1.0s (-25 frames)
      const startTime = { n: -1, d: 1 };
      const frameCount = 250;

      // mediaTime = -1.0s -> offset 0s -> frame 0
      expect(calculateFrameFromMediaTime(-1.0, startTime, fps25, frameCount)).toBe(0);

      // mediaTime = 0.0s -> offset +1.0s -> frame 25
      expect(calculateFrameFromMediaTime(0.0, startTime, fps25, frameCount)).toBe(25);

      // mediaTime = 1.0s -> offset +2.0s -> frame 50
      expect(calculateFrameFromMediaTime(1.0, startTime, fps25, frameCount)).toBe(50);
    });

    it("handles fractional NTSC 30000/1001 fps with nonzero rational startTime", () => {
      // startTime = 1001/30000 seconds (exact 1 frame PTS offset)
      const startTime = { n: 1001, d: 30000 };
      const frameCount = 300;

      // mediaTime = 1001/30000s -> offset 0s -> frame 0
      expect(
        calculateFrameFromMediaTime(1001 / 30000, startTime, fpsNtsc, frameCount),
      ).toBe(0);

      // mediaTime = 31 * (1001/30000)s -> offset 30 frames -> frame 30
      const mediaTime30Frames = (31 * 1001) / 30000;
      expect(
        calculateFrameFromMediaTime(mediaTime30Frames, startTime, fpsNtsc, frameCount),
      ).toBe(30);
    });

    it("clamps display frame to [0, frameCount - 1] on exceeding mediaTime", () => {
      const startTime = { n: 0, d: 1 };
      const frameCount = 100;

      // 10.0s at 25fps would be frame 250, but frameCount is 100 -> clamped to 99
      expect(calculateFrameFromMediaTime(10.0, startTime, fps25, frameCount)).toBe(99);
    });
  });

  describe("calculateFrameFromCurrentTime (Fallback semantics)", () => {
    it("converts video.currentTime accurately at 25 fps", () => {
      const frameCount = 250;

      expect(calculateFrameFromCurrentTime(0.0, fps25, frameCount)).toBe(0);
      expect(calculateFrameFromCurrentTime(1.0, fps25, frameCount)).toBe(25);
      expect(calculateFrameFromCurrentTime(2.5, fps25, frameCount)).toBe(62);
    });

    it("converts video.currentTime accurately for NTSC 30000/1001 fps", () => {
      const frameCount = 300;

      // 1001/30000s = frame 1
      expect(calculateFrameFromCurrentTime(1001 / 30000, fpsNtsc, frameCount)).toBe(1);

      // (30 * 1001) / 30000s = 1.001s = frame 30
      expect(calculateFrameFromCurrentTime(1.001, fpsNtsc, frameCount)).toBe(30);
    });

    it("clamps currentTime fallback to valid display range [0, frameCount - 1]", () => {
      const frameCount = 100;

      expect(calculateFrameFromCurrentTime(-5.0, fps25, frameCount)).toBe(0);
      expect(calculateFrameFromCurrentTime(100.0, fps25, frameCount)).toBe(99);
    });
  });

  describe("Timecode Formatting", () => {
    it("formats display timecode from integer frame index", () => {
      expect(formatDisplayTimecode(0, fps30)).toBe("00:00:00:00");
      expect(formatDisplayTimecode(29, fps30)).toBe("00:00:00:29");
      expect(formatDisplayTimecode(30, fps30)).toBe("00:00:01:00");
      expect(formatDisplayTimecode(299, fps30)).toBe("00:00:09:29");
    });

    it("formats total timecode at exclusive frameCount (ADR 002, ADR 007)", () => {
      // 300 frames total at 30 fps is exactly 10s: 00:00:10:00
      expect(formatTotalTimecode(300, fps30)).toBe("00:00:10:00");
      expect(formatTotalTimecode(250, fps25)).toBe("00:00:10:00");
      expect(formatTotalTimecode(0, fps30)).toBe("00:00:00:00");
      expect(formatTotalTimecode(-10, fps30)).toBe("00:00:00:00");
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

    it("guards RVFC frame updates and decode error dispatch across simulated component lifecycle", () => {
      const guard = createSourceLifecycleGuard(sourceA);

      let currentFrame = 0;
      let videoError = false;

      const handleFrame = (sourceId: string, frame: number) => {
        if (!guard.isActive(sourceId)) {
          return false;
        }
        currentFrame = frame;
        return true;
      };

      const handleError = (sourceId: string) => {
        if (!guard.isActive(sourceId)) {
          return false;
        }
        videoError = true;
        return true;
      };

      // Frame 1 arrives from source A while source A is active -> accepted
      expect(handleFrame(sourceA, 24)).toBe(true);
      expect(currentFrame).toBe(24);

      // Source B commits and layout effect activates source B
      guard.activate(sourceB);

      // Late RVFC callback from source A arrives after B commits -> rejected
      expect(handleFrame(sourceA, 48)).toBe(false);
      expect(currentFrame).toBe(24); // Untouched

      // Late decode error event from source A arrives -> rejected
      expect(handleError(sourceA)).toBe(false);
      expect(videoError).toBe(false); // Untouched

      // Frame arrives from newly active source B -> accepted
      expect(handleFrame(sourceB, 10)).toBe(true);
      expect(currentFrame).toBe(10);

      // Decode error from source B -> accepted
      expect(handleError(sourceB)).toBe(true);
      expect(videoError).toBe(true);
    });
  });
});
