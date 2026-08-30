import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULER_MARKER_COUNT,
  generateRulerMarkers,
  MAX_RULER_MARKER_COUNT,
  MIN_RULER_MARKER_COUNT,
  sanitizeMarkerCount,
} from "./timelineMarkers";

describe("Timeline Ruler Markers Helper", () => {
  const fps30 = { n: 30, d: 1 };
  const fps25 = { n: 25, d: 1 };
  const fps24 = { n: 24, d: 1 };
  const fpsNtsc = { n: 30000, d: 1001 }; // 29.97002997... fps

  describe("Even Spacing and Default Marker Count", () => {
    it("generates 6 evenly spaced markers by default for 300 frames at 30 fps (10s)", () => {
      const markers = generateRulerMarkers(300, fps30);

      expect(markers).toHaveLength(6);

      expect(markers[0]).toEqual({
        frame: 0,
        timecode: "00:00:00:00",
        percent: 0,
        left: "0%",
      });

      expect(markers[1]).toEqual({
        frame: 60,
        timecode: "00:00:02:00",
        percent: 20,
        left: "20%",
      });

      expect(markers[2]).toEqual({
        frame: 120,
        timecode: "00:00:04:00",
        percent: 40,
        left: "40%",
      });

      expect(markers[3]).toEqual({
        frame: 180,
        timecode: "00:00:06:00",
        percent: 60,
        left: "60%",
      });

      expect(markers[4]).toEqual({
        frame: 240,
        timecode: "00:00:08:00",
        percent: 80,
        left: "80%",
      });

      expect(markers[5]).toEqual({
        frame: 300,
        timecode: "00:00:10:00",
        percent: 100,
        left: "100%",
      });
    });

    it("generates exact non-drop-frame timecodes for 25 fps content", () => {
      const markers = generateRulerMarkers(250, fps25);

      expect(markers).toHaveLength(6);
      expect(markers[0].timecode).toBe("00:00:00:00");
      expect(markers[1].timecode).toBe("00:00:02:00");
      expect(markers[2].timecode).toBe("00:00:04:00");
      expect(markers[3].timecode).toBe("00:00:06:00");
      expect(markers[4].timecode).toBe("00:00:08:00");
      expect(markers[5].timecode).toBe("00:00:10:00");
    });

    it("generates exact non-drop-frame timecodes for 24 fps cinema content", () => {
      const markers = generateRulerMarkers(240, fps24);

      expect(markers).toHaveLength(6);
      expect(markers[0].timecode).toBe("00:00:00:00");
      expect(markers[1].timecode).toBe("00:00:02:00");
      expect(markers[2].timecode).toBe("00:00:04:00");
      expect(markers[3].timecode).toBe("00:00:06:00");
      expect(markers[4].timecode).toBe("00:00:08:00");
      expect(markers[5].timecode).toBe("00:00:10:00");
    });

    it("generates exact timecodes for NTSC 30000/1001 fps timebase", () => {
      // 1001 frames at 30000/1001 fps = 33.400033... seconds
      // ceil(30000/1001) = 30 frames per second slots (00..29)
      // 1001 frames / 30 = 33 seconds + 11 frames -> 00:00:33:11
      const markers = generateRulerMarkers(1001, fpsNtsc);

      expect(markers).toHaveLength(6);
      expect(markers[0].timecode).toBe("00:00:00:00");
      expect(markers[5].frame).toBe(1001);
      expect(markers[5].timecode).toBe("00:00:33:11");
      expect(markers[5].left).toBe("100%");
    });
  });

  describe("Custom Marker Counts", () => {
    it("supports custom marker counts such as 3 or 5 markers", () => {
      const markers3 = generateRulerMarkers(100, fps25, { markerCount: 3 });
      expect(markers3).toHaveLength(3);
      expect(markers3[0].left).toBe("0%");
      expect(markers3[0].frame).toBe(0);
      expect(markers3[1].left).toBe("50%");
      expect(markers3[1].frame).toBe(50);
      expect(markers3[2].left).toBe("100%");
      expect(markers3[2].frame).toBe(100);

      const markers5 = generateRulerMarkers(100, fps25, { markerCount: 5 });
      expect(markers5).toHaveLength(5);
      expect(markers5[0].left).toBe("0%");
      expect(markers5[1].left).toBe("25%");
      expect(markers5[2].left).toBe("50%");
      expect(markers5[3].left).toBe("75%");
      expect(markers5[4].left).toBe("100%");
    });
  });

  describe("Large Integers & MAX_SAFE_INTEGER Safety", () => {
    it("handles Number.MAX_SAFE_INTEGER frameCount safely without overflow or NaN", () => {
      const markers = generateRulerMarkers(Number.MAX_SAFE_INTEGER, fps30);

      expect(markers).toHaveLength(6);
      expect(markers[0].frame).toBe(0);
      expect(markers[0].timecode).toBe("00:00:00:00");

      expect(markers[5].frame).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(markers[5].frame)).toBe(true);
      expect(markers[5].timecode).not.toContain("NaN");
      expect(markers[5].timecode).toBe("83399993099:27:13:01");
      expect(markers[5].left).toBe("100%");
    });

    it("clamps frameCount exceeding Number.MAX_SAFE_INTEGER safely to MAX_SAFE_INTEGER", () => {
      const markers = generateRulerMarkers(Number.MAX_SAFE_INTEGER + 100, fps30);

      expect(markers).toHaveLength(6);
      expect(markers[5].frame).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(markers[5].frame)).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("handles frameCount = 0 safely", () => {
      const markers = generateRulerMarkers(0, fps30);

      expect(markers).toHaveLength(6);
      for (const m of markers) {
        expect(m.frame).toBe(0);
        expect(m.timecode).toBe("00:00:00:00");
      }
      expect(markers[0].left).toBe("0%");
      expect(markers[5].left).toBe("100%");
    });

    it("clamps negative frameCount to 0 safely", () => {
      const markers = generateRulerMarkers(-50, fps30);

      expect(markers).toHaveLength(6);
      expect(markers[0].frame).toBe(0);
      expect(markers[5].frame).toBe(0);
    });

    it("clamps markerCount < 2 to minimum 2 markers", () => {
      const markers = generateRulerMarkers(100, fps30, { markerCount: 1 });

      expect(markers).toHaveLength(2);
      expect(markers[0].left).toBe("0%");
      expect(markers[0].frame).toBe(0);
      expect(markers[1].left).toBe("100%");
      expect(markers[1].frame).toBe(100);
    });

    it("handles float inputs by truncating to safe integers", () => {
      const markers = generateRulerMarkers(300.9, fps30, { markerCount: 6.8 });

      expect(markers).toHaveLength(6);
      expect(markers[0].frame).toBe(0);
      expect(markers[5].frame).toBe(300);
    });
  });

  describe("Marker Count Sanitization & Upper Cap Safety", () => {
    describe("sanitizeMarkerCount helper", () => {
      it("returns default 6 markers when input is undefined", () => {
        expect(sanitizeMarkerCount(undefined)).toBe(DEFAULT_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount()).toBe(DEFAULT_RULER_MARKER_COUNT);
      });

      it("returns default 6 markers when input is NaN", () => {
        expect(sanitizeMarkerCount(NaN)).toBe(DEFAULT_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(Number("invalid"))).toBe(DEFAULT_RULER_MARKER_COUNT);
      });

      it("caps Infinity and +Infinity to MAX_RULER_MARKER_COUNT", () => {
        expect(sanitizeMarkerCount(Infinity)).toBe(MAX_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(Number.POSITIVE_INFINITY)).toBe(
          MAX_RULER_MARKER_COUNT,
        );
      });

      it("clamps -Infinity to MIN_RULER_MARKER_COUNT", () => {
        expect(sanitizeMarkerCount(-Infinity)).toBe(MIN_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(Number.NEGATIVE_INFINITY)).toBe(
          MIN_RULER_MARKER_COUNT,
        );
      });

      it("caps Number.MAX_SAFE_INTEGER to MAX_RULER_MARKER_COUNT", () => {
        expect(sanitizeMarkerCount(Number.MAX_SAFE_INTEGER)).toBe(
          MAX_RULER_MARKER_COUNT,
        );
      });

      it("clamps negative numbers and values below MIN to MIN_RULER_MARKER_COUNT", () => {
        expect(sanitizeMarkerCount(-100)).toBe(MIN_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(0)).toBe(MIN_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(1)).toBe(MIN_RULER_MARKER_COUNT);
      });

      it("caps values exceeding MAX_RULER_MARKER_COUNT to MAX", () => {
        expect(sanitizeMarkerCount(101)).toBe(MAX_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(500)).toBe(MAX_RULER_MARKER_COUNT);
        expect(sanitizeMarkerCount(100000)).toBe(MAX_RULER_MARKER_COUNT);
      });

      it("truncates float markerCount values within valid range", () => {
        expect(sanitizeMarkerCount(7.9)).toBe(7);
        expect(sanitizeMarkerCount(10.2)).toBe(10);
      });
    });

    describe("generateRulerMarkers with extreme markerCount options", () => {
      it("preserves default 6 markers on NaN markerCount without producing zero markers", () => {
        const markers = generateRulerMarkers(300, fps30, { markerCount: NaN });
        expect(markers).toHaveLength(DEFAULT_RULER_MARKER_COUNT);
        expect(markers[0].frame).toBe(0);
        expect(markers[markers.length - 1].frame).toBe(300);
      });

      it("caps Infinity markerCount to MAX_RULER_MARKER_COUNT without infinite looping", () => {
        const markers = generateRulerMarkers(300, fps30, { markerCount: Infinity });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[markers.length - 1].left).toBe("100%");
      });

      it("clamps -Infinity markerCount to MIN_RULER_MARKER_COUNT", () => {
        const markers = generateRulerMarkers(300, fps30, { markerCount: -Infinity });
        expect(markers).toHaveLength(MIN_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[0].frame).toBe(0);
        expect(markers[1].left).toBe("100%");
        expect(markers[1].frame).toBe(300);
      });

      it("caps Number.MAX_SAFE_INTEGER markerCount to MAX_RULER_MARKER_COUNT without excessive allocation", () => {
        const markers = generateRulerMarkers(300, fps30, {
          markerCount: Number.MAX_SAFE_INTEGER,
        });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[markers.length - 1].left).toBe("100%");
      });

      it("caps large custom markerCount to MAX_RULER_MARKER_COUNT", () => {
        const markers = generateRulerMarkers(300, fps30, { markerCount: 500 });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
      });
    });
  });
});
