import { describe, expect, it } from "vitest";
import {
  calculateRulerTickStepSeconds,
  DEFAULT_RULER_MARKER_COUNT,
  generateQuantizedRulerMarkers,
  generateRulerMarkers,
  generateRulerMarkersForStep,
  MAX_QUANTIZED_RULER_TICK_COUNT,
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

describe("Quantized Ruler Markers", () => {
  describe("Ladder Choice and Interval Selection", () => {
    it("picks expected ladder steps for a 3-hour source across lane widths", () => {
      const threeHours = 10800;
      // 1344 px picks 1800 s
      expect(calculateRulerTickStepSeconds(threeHours, 1344)).toBe(1800);
      // 13440 px picks 120 s
      expect(calculateRulerTickStepSeconds(threeHours, 13440)).toBe(120);
      // 99904 px picks 30 s (400-tick cap forces it up from spacing-only answer)
      expect(calculateRulerTickStepSeconds(threeHours, 99904)).toBe(30);
    });

    it("picks smallest ladder entry for durations shorter than the smallest ladder entry", () => {
      expect(calculateRulerTickStepSeconds(0.5, 1344)).toBe(1);
      expect(calculateRulerTickStepSeconds(0.1, 1000)).toBe(1);
    });

    it("produces equal step values for two different lane widths inside the same rung", () => {
      const threeHours = 10800;
      // Both 1344 px and 1400 px fall into the 1800s rung (900s requires >= 1440 px)
      const stepA = calculateRulerTickStepSeconds(threeHours, 1344);
      const stepB = calculateRulerTickStepSeconds(threeHours, 1400);
      expect(stepA).toBe(1800);
      expect(stepB).toBe(1800);
      expect(stepA).toBe(stepB);
    });
  });

  describe("Indeterminate and Invalid Inputs", () => {
    it("returns null and [] for invalid, non-positive, or non-finite inputs", () => {
      // laneWidthPx <= 0 and non-finite
      expect(calculateRulerTickStepSeconds(100, 0)).toBeNull();
      expect(calculateRulerTickStepSeconds(100, -10)).toBeNull();
      expect(calculateRulerTickStepSeconds(100, NaN)).toBeNull();
      expect(calculateRulerTickStepSeconds(100, Infinity)).toBeNull();
      expect(calculateRulerTickStepSeconds(100, -Infinity)).toBeNull();

      expect(generateQuantizedRulerMarkers(100, 0)).toEqual([]);
      expect(generateQuantizedRulerMarkers(100, -10)).toEqual([]);
      expect(generateQuantizedRulerMarkers(100, NaN)).toEqual([]);
      expect(generateQuantizedRulerMarkers(100, Infinity)).toEqual([]);
      expect(generateQuantizedRulerMarkers(100, -Infinity)).toEqual([]);

      // totalDurationSeconds null, undefined, 0, negative, and non-finite
      expect(calculateRulerTickStepSeconds(null, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(undefined, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(0, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(-10, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(NaN, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(Infinity, 1344)).toBeNull();
      expect(calculateRulerTickStepSeconds(-Infinity, 1344)).toBeNull();

      expect(generateQuantizedRulerMarkers(null, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(undefined, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(0, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(-10, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(NaN, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(Infinity, 1344)).toEqual([]);
      expect(generateQuantizedRulerMarkers(-Infinity, 1344)).toEqual([]);
    });
  });

  describe("Quantized Marker Properties and Invariants", () => {
    it("places the first marker at 0% with 00:00:00.000", () => {
      const markers = generateQuantizedRulerMarkers(10800, 1344);
      expect(markers.length).toBeGreaterThan(0);
      expect(markers[0]).toEqual({
        seconds: 0,
        percent: 0,
        left: "0%",
        timecode: "00:00:00.000",
      });
    });

    it("ensures every marker lands on an exact multiple of the step", () => {
      const duration = 10800;
      const width = 1344;
      const step = calculateRulerTickStepSeconds(duration, width)!;
      expect(step).toBe(1800);

      const markers = generateQuantizedRulerMarkers(duration, width);
      for (const marker of markers) {
        expect(marker.seconds % step).toBe(0);
        expect(Number.isInteger(marker.seconds / step)).toBe(true);
      }
    });

    it("ensures the last marker is <= totalDurationSeconds and is exactly 100% for whole multiples", () => {
      // Whole multiple: 10800 s with step 1800 s
      const markersWhole = generateQuantizedRulerMarkers(10800, 1344);
      const lastWhole = markersWhole[markersWhole.length - 1];
      expect(lastWhole.seconds).toBe(10800);
      expect(lastWhole.percent).toBe(100);
      expect(lastWhole.left).toBe("100%");

      // Non-whole multiple: 10000 s with lane width 1344 px (step 900 s)
      const markersNonWhole = generateQuantizedRulerMarkers(10000, 1344);
      const lastNonWhole = markersNonWhole[markersNonWhole.length - 1];
      expect(lastNonWhole.seconds).toBeLessThanOrEqual(10000);
      expect(lastNonWhole.seconds).toBe(9900);
      expect(lastNonWhole.percent).toBe(99);
      expect(lastNonWhole.percent).toBeLessThan(100);
      expect(lastNonWhole.left).toBe("99%");
    });

    it("has strictly increasing percent across markers", () => {
      const markers = generateQuantizedRulerMarkers(10800, 1344);
      for (let i = 1; i < markers.length; i++) {
        expect(markers[i].percent).toBeGreaterThan(markers[i - 1].percent);
      }
    });

    it("never exceeds MAX_QUANTIZED_RULER_TICK_COUNT across extremes", () => {
      // Extremely wide lanes (extreme zoom-in)
      const extremeWidths = [10_000, 99_904, 500_000, 1_000_000, 10_000_000];
      for (const width of extremeWidths) {
        const markers = generateQuantizedRulerMarkers(10800, width);
        expect(markers.length).toBeLessThanOrEqual(MAX_QUANTIZED_RULER_TICK_COUNT);
      }

      // Very long source durations
      const extremeDurations = [3600, 10800, 43200, 86400, 1_000_000, 10_000_000];
      for (const duration of extremeDurations) {
        const markers = generateQuantizedRulerMarkers(duration, 100_000);
        expect(markers.length).toBeLessThanOrEqual(MAX_QUANTIZED_RULER_TICK_COUNT);
      }

      // Narrow lanes
      for (const width of [10, 50, 100, 200]) {
        const markers = generateQuantizedRulerMarkers(10800, width);
        expect(markers.length).toBeLessThanOrEqual(MAX_QUANTIZED_RULER_TICK_COUNT);
      }
    });
  });

  describe("generateRulerMarkersForStep", () => {
    it("generates expected markers when stepSeconds is provided directly", () => {
      const markers = generateRulerMarkersForStep(10.0, 2);
      expect(markers).toHaveLength(6);
      expect(markers[0]).toEqual({
        timecode: "00:00:00.000",
        seconds: 0,
        percent: 0,
        left: "0%",
      });
      expect(markers[5]).toEqual({
        timecode: "00:00:10.000",
        seconds: 10,
        percent: 100,
        left: "100%",
      });
    });

    it("returns an empty array when stepSeconds is null, invalid, or non-positive", () => {
      expect(generateRulerMarkersForStep(10.0, null)).toEqual([]);
      expect(generateRulerMarkersForStep(10.0, 0)).toEqual([]);
      expect(generateRulerMarkersForStep(10.0, -5)).toEqual([]);
      expect(generateRulerMarkersForStep(10.0, NaN)).toEqual([]);
      expect(generateRulerMarkersForStep(null, 2)).toEqual([]);
      expect(generateRulerMarkersForStep(0, 2)).toEqual([]);
      expect(generateRulerMarkersForStep(-10, 2)).toEqual([]);
    });

    it("matches generateQuantizedRulerMarkers output for the same step", () => {
      const duration = 10800;
      const width = 1344;
      const step = calculateRulerTickStepSeconds(duration, width);
      const markersFromStep = generateRulerMarkersForStep(duration, step);
      const quantizedMarkers = generateQuantizedRulerMarkers(duration, width);
      expect(markersFromStep).toEqual(quantizedMarkers);
    });
  });
});
