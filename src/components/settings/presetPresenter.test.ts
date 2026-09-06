import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import {
  validatePresetFields,
  type PresetFieldIssue,
} from "@/features/settings/limits";
import type { Preset } from "@/features/settings/types";
import type { EncoderProbeState } from "./encoderAvailability";
import { CUSTOM_ENCODER_VALUE as CONTROLLER_CUSTOM_ENCODER_VALUE } from "./presetLibraryController";
import {
  CUSTOM_ENCODER_VALUE,
  isActivationKey,
  presentContainer,
  presentEncoderOption,
  presentEncoderSelect,
  presentNumericField,
  presentPresetIssue,
  presentPresetIssues,
  presentQualityKind,
} from "./presetPresenter";

/**
 * Resolves a dotted translation key path (e.g. "settings.field.tooLong") against a nested
 * catalog object, mirroring how i18next itself walks a namespaced key. Follows the same
 * convention as `settingsErrorPresenter.test.ts`'s guard, applied here to every key this
 * presenter can emit.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createProbeState(
  overrides: Partial<EncoderProbeState> = {},
): EncoderProbeState {
  return { status: "ready", results: [], ...overrides };
}

describe("presetPresenter", () => {
  describe("CUSTOM_ENCODER_VALUE", () => {
    it("re-exports the controller's sentinel exactly, so there is exactly one definition", () => {
      expect(CUSTOM_ENCODER_VALUE).toBe(CONTROLLER_CUSTOM_ENCODER_VALUE);
    });
  });

  describe("cross-module agreement with validatePresetFields", () => {
    const basePreset: Preset = {
      id: "preset-1",
      name: "Default Preset",
      container: "mp4",
      videoEncoder: "libx264",
      audioEncoder: "aac",
      quality: { kind: "crf", value: 20 },
      resolution: "source",
      frameRate: "source",
    };

    it("maps a name over 120 characters to settings.field.tooLong carrying { max: 120 }", () => {
      const preset: Preset = { ...basePreset, name: "a".repeat(121) };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("tooLong");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.tooLong",
        values: { max: 120 },
      });
    });

    it("maps a blank name to settings.field.required with no values", () => {
      const preset: Preset = { ...basePreset, name: "   " };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("required");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.required",
      });
    });

    it("maps an encoder with a bad charset to settings.field.charset with no values", () => {
      const preset: Preset = { ...basePreset, videoEncoder: "bad name!" };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("charset");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.charset",
      });
    });

    it("maps a fractional quality value to settings.field.notInteger with no values", () => {
      const preset: Preset = { ...basePreset, quality: { kind: "crf", value: 20.5 } };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("notInteger");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.notInteger",
      });
    });

    it("maps an out-of-range crf to settings.field.outOfRange with both min and max", () => {
      const preset: Preset = { ...basePreset, quality: { kind: "crf", value: 100 } };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("outOfRange");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.outOfRange",
        values: { kind: "crf", min: 0, max: 63 },
      });
    });

    it("maps a frame rate of { n: 0, d: 1 } to settings.field.positive with no values", () => {
      const preset: Preset = { ...basePreset, frameRate: { n: 0, d: 1 } };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("positive");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.positive",
      });
    });
  });

  describe("presentPresetIssues", () => {
    it("derives a stable unique id per entry and passes through key and values", () => {
      const issues: PresetFieldIssue[] = [
        { field: "name", code: "required" },
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ];

      expect(presentPresetIssues(issues)).toStrictEqual([
        { id: "name-required-0", key: "settings.field.required" },
        {
          id: "quality-outOfRange-1",
          key: "settings.field.outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ]);
    });

    it("gives two issues sharing field and code distinct ids", () => {
      const issues: PresetFieldIssue[] = [
        { field: "quality", code: "notInteger" },
        { field: "quality", code: "notInteger" },
      ];

      const result = presentPresetIssues(issues);
      expect(result[0].id).not.toBe(result[1].id);
    });

    it("returns an empty array for no issues", () => {
      expect(presentPresetIssues([])).toStrictEqual([]);
    });
  });

  describe("presentEncoderOption", () => {
    it("maps available with no reasonKey", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "available",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.available",
      });
    });

    it("maps unknown with no reasonKey", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unknown",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unknown",
      });
    });

    it("maps unavailable with reason notListed to settings.encoder.reasonNotListed", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unavailable",
          reason: "notListed",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unavailable",
        reasonKey: "settings.encoder.reasonNotListed",
      });
    });

    it("maps unavailable with reason failed to settings.encoder.reasonFailed", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unavailable",
          reason: "failed",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unavailable",
        reasonKey: "settings.encoder.reasonFailed",
      });
    });

    it("maps unavailable with reason timedOut to settings.encoder.reasonTimedOut", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unavailable",
          reason: "timedOut",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unavailable",
        reasonKey: "settings.encoder.reasonTimedOut",
      });
    });
  });

  describe("presentEncoderSelect", () => {
    it("maps available options to complete option-label view models and appends the custom sentinel last", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libx264", kind: "video", listed: true, status: "works" },
          { name: "libx265", kind: "video", listed: true, status: "works" },
        ],
      });

      const result = presentEncoderSelect(state, "video", "libx264");

      expect(result).toStrictEqual({
        options: [
          {
            value: "libx264",
            labelKey: "settings.encoder.optionLabelAvailable",
            labelValues: { name: "libx264" },
          },
          {
            value: "libx265",
            labelKey: "settings.encoder.optionLabelAvailable",
            labelValues: { name: "libx265" },
          },
          {
            value: CUSTOM_ENCODER_VALUE,
            labelKey: "settings.preset.customOption",
            labelValues: { name: "" },
          },
        ],
      });
    });

    it("returns currentReasonKey for the selected encoder when it is unavailable with a reason", () => {
      const state = createProbeState({
        status: "ready",
        results: [{ name: "libx264", kind: "video", listed: true, status: "failed" }],
      });

      const result = presentEncoderSelect(state, "video", "libx264");

      expect(result).toStrictEqual({
        options: [
          {
            value: "libx264",
            labelKey: "settings.encoder.optionLabelUnavailable",
            labelValues: { name: "libx264" },
          },
          {
            value: CUSTOM_ENCODER_VALUE,
            labelKey: "settings.preset.customOption",
            labelValues: { name: "" },
          },
        ],
        currentReasonKey: "settings.encoder.reasonFailed",
      });
    });

    it("omits currentReasonKey entirely when there is no matching current option", () => {
      const state = createProbeState({ status: "ready", results: [] });

      const result = presentEncoderSelect(state, "video", "");

      expect(result).toStrictEqual({
        options: [
          {
            value: CUSTOM_ENCODER_VALUE,
            labelKey: "settings.preset.customOption",
            labelValues: { name: "" },
          },
        ],
      });
      expect(result).not.toHaveProperty("currentReasonKey");
    });

    it("omits currentReasonKey when the current option is available", () => {
      const state = createProbeState({
        status: "ready",
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
      });

      const result = presentEncoderSelect(state, "video", "libx264");

      expect(result).not.toHaveProperty("currentReasonKey");
    });

    it("filters options by kind", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libx264", kind: "video", listed: true, status: "works" },
          { name: "aac", kind: "audio", listed: true, status: "works" },
        ],
      });

      const result = presentEncoderSelect(state, "audio", "aac");

      expect(result.options.map((option) => option.value)).toStrictEqual([
        "aac",
        CUSTOM_ENCODER_VALUE,
      ]);
    });
  });

  describe("presentQualityKind", () => {
    it("maps crf to settings.quality.crf", () => {
      expect(presentQualityKind("crf")).toBe("settings.quality.crf");
    });

    it("maps bitrate to settings.quality.bitrate", () => {
      expect(presentQualityKind("bitrate")).toBe("settings.quality.bitrate");
    });

    it("maps qualityScale to settings.quality.qualityScale", () => {
      expect(presentQualityKind("qualityScale")).toBe("settings.quality.qualityScale");
    });
  });

  describe("presentContainer", () => {
    it("maps mp4 to MP4", () => {
      expect(presentContainer("mp4")).toBe("MP4");
    });

    it("maps mov to MOV", () => {
      expect(presentContainer("mov")).toBe("MOV");
    });

    it("maps mkv to MKV", () => {
      expect(presentContainer("mkv")).toBe("MKV");
    });
  });

  describe("presentNumericField", () => {
    it("renders NaN as an empty string", () => {
      expect(presentNumericField(Number.NaN)).toBe("");
    });

    it("renders zero as the string 0", () => {
      expect(presentNumericField(0)).toBe("0");
    });

    it("renders a positive integer as text", () => {
      expect(presentNumericField(1920)).toBe("1920");
    });

    it("renders a negative integer as text", () => {
      expect(presentNumericField(-5)).toBe("-5");
    });
  });

  describe("isActivationKey", () => {
    it("activates on Enter", () => {
      expect(isActivationKey("Enter")).toBe(true);
    });

    it("activates on Space", () => {
      expect(isActivationKey(" ")).toBe(true);
    });

    it("does not activate on other keys", () => {
      expect(isActivationKey("Tab")).toBe(false);
      expect(isActivationKey("a")).toBe(false);
      expect(isActivationKey("Spacebar")).toBe(false);
    });
  });

  // Every key this presenter can emit must resolve to a non-empty string in the English
  // catalog, so a renamed or deleted message fails here instead of rendering a raw key on
  // screen. Follows the same convention as `settingsErrorPresenter.test.ts`.
  describe("catalog coverage", () => {
    const emittedKeys = [
      // all six field issue codes
      "settings.field.required",
      "settings.field.tooLong",
      "settings.field.charset",
      "settings.field.outOfRange",
      "settings.field.notInteger",
      "settings.field.positive",
      // all three availability keys
      "settings.encoder.available",
      "settings.encoder.unavailable",
      "settings.encoder.unknown",
      // all three reason keys
      "settings.encoder.reasonNotListed",
      "settings.encoder.reasonFailed",
      "settings.encoder.reasonTimedOut",
      // all three quality kinds
      "settings.quality.crf",
      "settings.quality.bitrate",
      "settings.quality.qualityScale",
      // all three complete encoder option labels
      "settings.encoder.optionLabelAvailable",
      "settings.encoder.optionLabelUnavailable",
      "settings.encoder.optionLabelUnknown",
    ];

    it.each(emittedKeys)(
      "resolves key '%s' to a non-empty string in the English catalog",
      (key) => {
        const resolved = resolveCatalogKey(en, key);
        expect(typeof resolved).toBe("string");
        expect((resolved as string).trim().length).toBeGreaterThan(0);
      },
    );
  });
});
