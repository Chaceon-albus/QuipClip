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
  presentPresetEncoderMark,
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

    it("maps unknown with reason notTested to settings.encoder.reasonNotTested and tone neutral", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unknown",
          reason: "notTested",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unknown",
        reasonKey: "settings.encoder.reasonNotTested",
        tone: "neutral",
      });
    });

    it("maps unknown with reason notProbed to settings.encoder.reasonNotProbed and tone neutral", () => {
      expect(
        presentEncoderOption({
          name: "libx264",
          availability: "unknown",
          reason: "notProbed",
        }),
      ).toStrictEqual({
        availabilityKey: "settings.encoder.unknown",
        reasonKey: "settings.encoder.reasonNotProbed",
        tone: "neutral",
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
        tone: "warning",
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
        tone: "warning",
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
        tone: "warning",
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
        currentReasonTone: "warning",
      });
    });

    it("returns currentReasonKey and currentReasonTone when the selected encoder is unknown", () => {
      const state = createProbeState({ status: "ready", results: [] });

      const result = presentEncoderSelect(state, "video", "libvpx-vp9");

      expect(result.currentReasonKey).toBe("settings.encoder.reasonNotTested");
      expect(result.currentReasonTone).toBe("neutral");
    });

    // The row badge drops `notProbed`, the editor keeps it: here the user asked about this one
    // preset, so "not checked yet" answers the question instead of repeating a global fact.
    it("keeps the notProbed reason line for the selected encoder while the probe runs", () => {
      const state = createProbeState({ status: "probing", results: [] });

      const result = presentEncoderSelect(state, "video", "libx264");

      expect(result.currentReasonKey).toBe("settings.encoder.reasonNotProbed");
      expect(result.currentReasonTone).toBe("neutral");
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

  describe("presentPresetEncoderMark", () => {
    const preset = { videoEncoder: "libx264", audioEncoder: "aac" };

    it("returns null when both encoders are known to work", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libx264", kind: "video", listed: true, status: "works" },
          { name: "aac", kind: "audio", listed: true, status: "works" },
        ],
      });

      expect(presentPresetEncoderMark(state, preset)).toBeNull();
    });

    it("marks an unavailable video encoder with the warning tone", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libx264", kind: "video", listed: true, status: "failed" },
          { name: "aac", kind: "audio", listed: true, status: "works" },
        ],
      });

      expect(presentPresetEncoderMark(state, preset)).toStrictEqual({
        encoderName: "libx264",
        availability: "unavailable",
        tone: "warning",
        badgeKey: "settings.encoder.unavailable",
        titleKey: "settings.preset.encoderMarkTitle",
        titleValues: { name: "libx264" },
        reasonKey: "settings.encoder.reasonFailed",
      });
    });

    it("marks an untested audio encoder with the neutral tone when the video encoder works", () => {
      const state = createProbeState({
        status: "ready",
        results: [{ name: "libx264", kind: "video", listed: true, status: "works" }],
      });

      expect(presentPresetEncoderMark(state, preset)).toStrictEqual({
        encoderName: "aac",
        availability: "unknown",
        tone: "neutral",
        badgeKey: "settings.encoder.unknown",
        titleKey: "settings.preset.encoderMarkTitle",
        titleValues: { name: "aac" },
        reasonKey: "settings.encoder.reasonNotTested",
      });
    });

    // One badge on one line: the row reports the video encoder and never both.
    it("reports the video encoder only when both encoders are unavailable", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libx264", kind: "video", listed: false, status: "notListed" },
          { name: "aac", kind: "audio", listed: true, status: "timedOut" },
        ],
      });

      const mark = presentPresetEncoderMark(state, preset);

      expect(mark?.encoderName).toBe("libx264");
      expect(mark?.reasonKey).toBe("settings.encoder.reasonNotListed");
      expect(mark?.tone).toBe("warning");
    });

    // Severity beats slot order. The video encoder is absent from a finished report, so nothing
    // is known about it; the audio encoder carries a verdict the probe actually reached. Naming
    // the video encoder here would show a neutral badge for a preset that will fail on export.
    it("reports the audio encoder when it is unavailable and the video encoder is only unknown", () => {
      const state = createProbeState({
        status: "ready",
        results: [
          { name: "libfdk_aac", kind: "audio", listed: false, status: "notListed" },
        ],
      });

      expect(
        presentPresetEncoderMark(state, {
          videoEncoder: "libvpx-vp9",
          audioEncoder: "libfdk_aac",
        }),
      ).toStrictEqual({
        encoderName: "libfdk_aac",
        availability: "unavailable",
        tone: "warning",
        badgeKey: "settings.encoder.unavailable",
        titleKey: "settings.preset.encoderMarkTitle",
        titleValues: { name: "libfdk_aac" },
        reasonKey: "settings.encoder.reasonNotListed",
      });
    });

    // A missing report holds for every name at once, so marking on it badges every row and
    // singles out none. The editor's reason line still carries `notProbed`.
    it.each(["idle", "locating", "probing", "missing", "failed"] as const)(
      "returns null while the probe has not reported, with status %s",
      (status) => {
        const state = createProbeState({ status, results: [] });

        expect(presentPresetEncoderMark(state, preset)).toBeNull();
      },
    );

    // Severity still wins: a real verdict on one encoder outranks the other being unprobed.
    it("reports an unavailable encoder even when the other one is not probed", () => {
      const state = createProbeState({
        status: "probing",
        results: [{ name: "libx264", kind: "video", listed: true, status: "failed" }],
      });

      expect(presentPresetEncoderMark(state, preset)).toStrictEqual({
        encoderName: "libx264",
        availability: "unavailable",
        tone: "warning",
        badgeKey: "settings.encoder.unavailable",
        titleKey: "settings.preset.encoderMarkTitle",
        titleValues: { name: "libx264" },
        reasonKey: "settings.encoder.reasonFailed",
      });
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
      // all three unavailable reason keys
      "settings.encoder.reasonNotListed",
      "settings.encoder.reasonFailed",
      "settings.encoder.reasonTimedOut",
      // both unknown reason keys
      "settings.encoder.reasonNotTested",
      "settings.encoder.reasonNotProbed",
      // the preset row's encoder mark
      "settings.preset.encoderMarkTitle",
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
