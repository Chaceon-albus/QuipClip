import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULER_MARKER_COUNT,
  generateRulerMarkers,
  MAX_RULER_MARKER_COUNT,
  MIN_RULER_MARKER_COUNT,
  sanitizeMarkerCount,
} from "./timelineMarkers";

describe("Timeline Ruler Markers Helper", () => {
  describe("Even Spacing and Default Marker Count", () => {
    it("generates 6 evenly spaced markers by default for 10.0 seconds", () => {
      const markers = generateRulerMarkers(10.0);

      expect(markers).toHaveLength(6);

      expect(markers[0]).toEqual({
        timecode: "00:00:00.000",
        seconds: 0,
        percent: 0,
        left: "0%",
      });

      expect(markers[1]).toEqual({
        timecode: "00:00:02.000",
        seconds: 2,
        percent: 20,
        left: "20%",
      });

      expect(markers[2]).toEqual({
        timecode: "00:00:04.000",
        seconds: 4,
        percent: 40,
        left: "40%",
      });

      expect(markers[3]).toEqual({
        timecode: "00:00:06.000",
        seconds: 6,
        percent: 60,
        left: "60%",
      });

      expect(markers[4]).toEqual({
        timecode: "00:00:08.000",
        seconds: 8,
        percent: 80,
        left: "80%",
      });

      expect(markers[5]).toEqual({
        timecode: "00:00:10.000",
        seconds: 10,
        percent: 100,
        left: "100%",
      });
    });

    it("formats source-relative ruler labels for an arbitrary extent", () => {
      const markers = generateRulerMarkers(250.5);

      expect(markers).toHaveLength(6);
      expect(markers[0].timecode).toBe("00:00:00.000");
      expect(markers[5].timecode).toBe("00:04:10.500");
      expect(markers[5].left).toBe("100%");
    });
  });

  describe("Custom Marker Counts", () => {
    it("supports custom marker counts such as 3 or 5 markers", () => {
      const markers3 = generateRulerMarkers(100, { markerCount: 3 });
      expect(markers3).toHaveLength(3);
      expect(markers3[0].left).toBe("0%");
      expect(markers3[0].seconds).toBe(0);
      expect(markers3[1].left).toBe("50%");
      expect(markers3[1].seconds).toBe(50);
      expect(markers3[2].left).toBe("100%");
      expect(markers3[2].seconds).toBe(100);

      const markers5 = generateRulerMarkers(100, { markerCount: 5 });
      expect(markers5).toHaveLength(5);
      expect(markers5[0].left).toBe("0%");
      expect(markers5[1].left).toBe("25%");
      expect(markers5[2].left).toBe("50%");
      expect(markers5[3].left).toBe("75%");
      expect(markers5[4].left).toBe("100%");
    });
  });

  describe("Indeterminate and Edge Cases", () => {
    it("returns empty array for duration null, undefined, 0, or negative (fully indeterminate ruler)", () => {
      expect(generateRulerMarkers(null)).toEqual([]);
      expect(generateRulerMarkers(undefined)).toEqual([]);
      expect(generateRulerMarkers(0)).toEqual([]);
      expect(generateRulerMarkers(-10)).toEqual([]);
      expect(generateRulerMarkers(NaN)).toEqual([]);
    });

    it("clamps markerCount < 2 to minimum 2 markers", () => {
      const markers = generateRulerMarkers(100, { markerCount: 1 });

      expect(markers).toHaveLength(2);
      expect(markers[0].left).toBe("0%");
      expect(markers[0].seconds).toBe(0);
      expect(markers[1].left).toBe("100%");
      expect(markers[1].seconds).toBe(100);
    });

    it("handles float markerCount by truncating to safe integers", () => {
      const markers = generateRulerMarkers(300, { markerCount: 6.8 });

      expect(markers).toHaveLength(6);
      expect(markers[0].seconds).toBe(0);
      expect(markers[5].seconds).toBe(300);
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
        const markers = generateRulerMarkers(300, { markerCount: NaN });
        expect(markers).toHaveLength(DEFAULT_RULER_MARKER_COUNT);
        expect(markers[0].seconds).toBe(0);
        expect(markers[markers.length - 1].seconds).toBe(300);
      });

      it("caps Infinity markerCount to MAX_RULER_MARKER_COUNT without infinite looping", () => {
        const markers = generateRulerMarkers(300, { markerCount: Infinity });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[markers.length - 1].left).toBe("100%");
      });

      it("clamps -Infinity markerCount to MIN_RULER_MARKER_COUNT", () => {
        const markers = generateRulerMarkers(300, { markerCount: -Infinity });
        expect(markers).toHaveLength(MIN_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[0].seconds).toBe(0);
        expect(markers[1].left).toBe("100%");
        expect(markers[1].seconds).toBe(300);
      });

      it("caps Number.MAX_SAFE_INTEGER markerCount to MAX_RULER_MARKER_COUNT without excessive allocation", () => {
        const markers = generateRulerMarkers(300, {
          markerCount: Number.MAX_SAFE_INTEGER,
        });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
        expect(markers[0].left).toBe("0%");
        expect(markers[markers.length - 1].left).toBe("100%");
      });

      it("caps large custom markerCount to MAX_RULER_MARKER_COUNT", () => {
        const markers = generateRulerMarkers(300, { markerCount: 500 });
        expect(markers).toHaveLength(MAX_RULER_MARKER_COUNT);
      });
    });
  });
});
