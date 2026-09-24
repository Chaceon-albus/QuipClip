import { describe, expect, it } from "vitest";

import { rationalsEqual } from "@/lib/time";

import { validatePresetFields } from "./limits";
import { createPresetDraft } from "./presetDocument";
import {
  FRAME_RATE_CHOICES,
  frameRateChoiceValue,
  frameRateFromChoice,
  OUTPUT_CUSTOM_VALUE,
  OUTPUT_SOURCE_VALUE,
  RESOLUTION_CHOICES,
  resolutionChoiceValue,
  resolutionFromChoice,
} from "./videoOutputChoices";

describe("videoOutputChoices", () => {
  describe("sentinel values", () => {
    it("uses the stored word 'source' and the word 'custom'", () => {
      expect(OUTPUT_SOURCE_VALUE).toBe("source");
      expect(OUTPUT_CUSTOM_VALUE).toBe("custom");
    });
  });

  describe("FRAME_RATE_CHOICES", () => {
    it("pins the rates, their order, and their exact rationals", () => {
      expect(
        FRAME_RATE_CHOICES.map((choice) => [choice.value, choice.rate, choice.nominal]),
      ).toEqual([
        ["24000/1001", { n: 24000, d: 1001 }, 23.976],
        ["24/1", { n: 24, d: 1 }, 24],
        ["25/1", { n: 25, d: 1 }, 25],
        ["30000/1001", { n: 30000, d: 1001 }, 29.97],
        ["30/1", { n: 30, d: 1 }, 30],
        ["50/1", { n: 50, d: 1 }, 50],
        ["60000/1001", { n: 60000, d: 1001 }, 59.94],
        ["60/1", { n: 60, d: 1 }, 60],
      ]);
    });

    it("gives each choice a unique value that is not a sentinel", () => {
      const values = FRAME_RATE_CHOICES.map((choice) => choice.value);
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain(OUTPUT_SOURCE_VALUE);
      expect(values).not.toContain(OUTPUT_CUSTOM_VALUE);
    });

    it("writes the value as the rate's own n/d", () => {
      for (const choice of FRAME_RATE_CHOICES) {
        expect(choice.value).toBe(`${choice.rate.n}/${choice.rate.d}`);
      }
    });

    it("holds no two choices that are equal as fractions", () => {
      for (const [i, a] of FRAME_RATE_CHOICES.entries()) {
        for (const b of FRAME_RATE_CHOICES.slice(i + 1)) {
          expect(rationalsEqual(a.rate, b.rate)).toBe(false);
        }
      }
    });

    it("holds only rates that pass the preset validation", () => {
      for (const choice of FRAME_RATE_CHOICES) {
        const preset = {
          ...createPresetDraft("p", "P"),
          frameRate: { ...choice.rate },
        };
        expect(validatePresetFields(preset)).toEqual([]);
      }
    });

    it("names each drop-frame rate within 0.001 of its exact value", () => {
      for (const choice of FRAME_RATE_CHOICES) {
        expect(Math.abs(choice.rate.n / choice.rate.d - choice.nominal)).toBeLessThan(
          0.001,
        );
      }
    });
  });

  describe("frameRateChoiceValue and frameRateFromChoice", () => {
    it("round-trips every choice", () => {
      for (const choice of FRAME_RATE_CHOICES) {
        const rate = frameRateFromChoice(choice.value);
        expect(rate).toEqual(choice.rate);
        expect(rate).not.toBeNull();
        expect(frameRateChoiceValue(rate ?? "source")).toBe(choice.value);
      }
    });

    it("round-trips 'source'", () => {
      expect(frameRateChoiceValue("source")).toBe(OUTPUT_SOURCE_VALUE);
      expect(frameRateFromChoice(OUTPUT_SOURCE_VALUE)).toBe("source");
    });

    it("maps each drop-frame rate to its exact rational", () => {
      expect(frameRateFromChoice("24000/1001")).toEqual({ n: 24000, d: 1001 });
      expect(frameRateFromChoice("30000/1001")).toEqual({ n: 30000, d: 1001 });
      expect(frameRateFromChoice("60000/1001")).toEqual({ n: 60000, d: 1001 });
    });

    it("matches a stored rate that equals a choice as a fraction", () => {
      expect(frameRateChoiceValue({ n: 48, d: 2 })).toBe("24/1");
      expect(frameRateChoiceValue({ n: 240, d: 10 })).toBe("24/1");
      expect(frameRateChoiceValue({ n: 48000, d: 2002 })).toBe("24000/1001");
      expect(frameRateChoiceValue({ n: 90000, d: 3003 })).toBe("30000/1001");
      expect(frameRateChoiceValue({ n: 120, d: 2 })).toBe("60/1");
    });

    it("does not match a decimal approximation of a drop-frame rate", () => {
      expect(frameRateChoiceValue({ n: 23976, d: 1000 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 2997, d: 100 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 5994, d: 100 })).toBe(OUTPUT_CUSTOM_VALUE);
    });

    it("maps a rate that is no choice to custom", () => {
      expect(frameRateChoiceValue({ n: 15, d: 1 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 120, d: 1 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 12000, d: 1001 })).toBe(OUTPUT_CUSTOM_VALUE);
    });

    it("maps an invalid rate to custom, even when it equals a choice as a fraction", () => {
      expect(frameRateChoiceValue({ n: -24, d: -1 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 24, d: 0 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 0, d: 1 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: Number.NaN, d: 1 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 24, d: Number.NaN })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(frameRateChoiceValue({ n: 24.5, d: 1 })).toBe(OUTPUT_CUSTOM_VALUE);
    });

    it("compares large terms exactly", () => {
      // Each term is a safe integer, but each cross product with 1001 or 24000 is not, so
      // only an exact comparison tells these two rates apart.
      const k = 1_000_000_000;
      expect(frameRateChoiceValue({ n: 24000 * k, d: 1001 * k })).toBe("24000/1001");
      expect(frameRateChoiceValue({ n: 24000 * k + 1, d: 1001 * k })).toBe(
        OUTPUT_CUSTOM_VALUE,
      );
    });

    it("answers null for custom and for an unknown value", () => {
      expect(frameRateFromChoice(OUTPUT_CUSTOM_VALUE)).toBeNull();
      expect(frameRateFromChoice("48/2")).toBeNull();
      expect(frameRateFromChoice("24")).toBeNull();
      expect(frameRateFromChoice("")).toBeNull();
    });

    it("returns a new object each time, so a change to it cannot reach the table", () => {
      const first = frameRateFromChoice("24000/1001");
      const second = frameRateFromChoice("24000/1001");
      expect(first).not.toBe(second);
      expect(first).not.toBe(FRAME_RATE_CHOICES[0]?.rate);
      if (first !== null && first !== "source") {
        first.n = 1;
      }
      expect(FRAME_RATE_CHOICES[0]?.rate).toEqual({ n: 24000, d: 1001 });
    });
  });

  describe("RESOLUTION_CHOICES", () => {
    it("pins the sizes and their order", () => {
      expect(RESOLUTION_CHOICES.map((choice) => [choice.value, choice.size])).toEqual([
        ["3840x2160", { w: 3840, h: 2160 }],
        ["2560x1440", { w: 2560, h: 1440 }],
        ["1920x1080", { w: 1920, h: 1080 }],
        ["1280x720", { w: 1280, h: 720 }],
      ]);
    });

    it("gives each choice a unique value that is not a sentinel", () => {
      const values = RESOLUTION_CHOICES.map((choice) => choice.value);
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain(OUTPUT_SOURCE_VALUE);
      expect(values).not.toContain(OUTPUT_CUSTOM_VALUE);
    });

    it("writes the value as the size's own WxH", () => {
      for (const choice of RESOLUTION_CHOICES) {
        expect(choice.value).toBe(`${choice.size.w}x${choice.size.h}`);
      }
    });

    it("holds only sizes that pass the preset validation", () => {
      for (const choice of RESOLUTION_CHOICES) {
        const preset = {
          ...createPresetDraft("p", "P"),
          resolution: { ...choice.size },
        };
        expect(validatePresetFields(preset)).toEqual([]);
      }
    });
  });

  describe("resolutionChoiceValue and resolutionFromChoice", () => {
    it("round-trips every choice", () => {
      for (const choice of RESOLUTION_CHOICES) {
        const size = resolutionFromChoice(choice.value);
        expect(size).toEqual(choice.size);
        expect(size).not.toBeNull();
        expect(resolutionChoiceValue(size ?? "source")).toBe(choice.value);
      }
    });

    it("round-trips 'source'", () => {
      expect(resolutionChoiceValue("source")).toBe(OUTPUT_SOURCE_VALUE);
      expect(resolutionFromChoice(OUTPUT_SOURCE_VALUE)).toBe("source");
    });

    it("matches a stored size with the same width and height", () => {
      expect(resolutionChoiceValue({ w: 1920, h: 1080 })).toBe("1920x1080");
      expect(resolutionChoiceValue({ w: 1280, h: 720 })).toBe("1280x720");
    });

    it("maps a size that is no choice to custom", () => {
      // The transposed size is a portrait output, not the same choice.
      expect(resolutionChoiceValue({ w: 1080, h: 1920 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(resolutionChoiceValue({ w: 1920, h: 1088 })).toBe(OUTPUT_CUSTOM_VALUE);
      expect(resolutionChoiceValue({ w: 640, h: 360 })).toBe(OUTPUT_CUSTOM_VALUE);
    });

    it("maps an invalid size to custom", () => {
      expect(resolutionChoiceValue({ w: Number.NaN, h: 1080 })).toBe(
        OUTPUT_CUSTOM_VALUE,
      );
      expect(resolutionChoiceValue({ w: 1920, h: Number.NaN })).toBe(
        OUTPUT_CUSTOM_VALUE,
      );
      expect(resolutionChoiceValue({ w: 0, h: 0 })).toBe(OUTPUT_CUSTOM_VALUE);
    });

    it("answers null for custom and for an unknown value", () => {
      expect(resolutionFromChoice(OUTPUT_CUSTOM_VALUE)).toBeNull();
      expect(resolutionFromChoice("1920×1080")).toBeNull();
      expect(resolutionFromChoice("")).toBeNull();
    });

    it("returns a new object each time, so a change to it cannot reach the table", () => {
      const first = resolutionFromChoice("1920x1080");
      const second = resolutionFromChoice("1920x1080");
      expect(first).not.toBe(second);
      if (first !== null && first !== "source") {
        first.w = 1;
      }
      expect(RESOLUTION_CHOICES[2]?.size).toEqual({ w: 1920, h: 1080 });
    });
  });
});
