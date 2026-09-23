import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import {
  validatePresetFields,
  type PresetFieldIssue,
} from "@/features/settings/limits";
import type { Preset, PresetAudioSampleRate } from "@/features/settings/types";
import type { EncoderProbeState } from "./encoderAvailability";
import { CUSTOM_ENCODER_VALUE as CONTROLLER_CUSTOM_ENCODER_VALUE } from "./presetLibraryController";
import {
  AUDIO_BITRATE_DEFAULT_VALUE,
  CUSTOM_ENCODER_VALUE,
  isActivationKey,
  parseAudioBitrateValue,
  parseAudioSampleRateValue,
  presentAudioBitrateSelect,
  presentAudioBitrateValue,
  presentAudioChannelsSelect,
  presentAudioSampleRateSelect,
  presentAudioSampleRateValue,
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
      audioBitrate: 320,
      audioSampleRate: "source",
      audioChannels: "source",
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

    it("maps a containerMismatch issue to settings.field.containerMismatch carrying container and encoder", () => {
      const preset: Preset = { ...basePreset, container: "mov", audioEncoder: "flac" };
      const issues = validatePresetFields(preset);
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("containerMismatch");
      expect(issues[0].values?.container).toBe("mov");
      expect(presentPresetIssue(issues[0])).toStrictEqual({
        key: "settings.field.containerMismatch",
        values: { container: "MOV", encoder: "flac" },
      });
    });

    it("maps raw container value through presentContainer for containerMismatch issue", () => {
      const issue: PresetFieldIssue = {
        field: "audioEncoder",
        code: "containerMismatch",
        values: { container: "mov", encoder: "libopus" },
      };
      expect(presentPresetIssue(issue)).toStrictEqual({
        key: "settings.field.containerMismatch",
        values: { container: "MOV", encoder: "libopus" },
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

  describe("presentAudioBitrateSelect", () => {
    const formatter = new Intl.NumberFormat("en-US");

    it("builds standard options for a lossy audio encoder with default", () => {
      const result = presentAudioBitrateSelect("aac", undefined, formatter);
      expect(result.disabled).toBe(false);
      expect(result.hintKey).toBeUndefined();
      expect(result.options[0]).toEqual({
        value: "default",
        labelKey: "settings.preset.audioBitrateDefault",
      });
      expect(result.options.slice(1).map((opt) => opt.value)).toEqual([
        "96",
        "128",
        "160",
        "192",
        "256",
        "320",
      ]);
      expect(result.options[1]).toEqual({
        value: "96",
        labelKey: "settings.preset.audioBitrateValue",
        labelValues: { value: "96" },
      });
    });

    it("builds libopus options up to 510 kbps", () => {
      const result = presentAudioBitrateSelect("libopus", 128, formatter);
      expect(result.disabled).toBe(false);
      expect(result.options.map((opt) => opt.value)).toEqual([
        "default",
        "64",
        "96",
        "128",
        "160",
        "192",
        "256",
        "320",
        "510",
      ]);
    });

    it("appends current stored value when not in the choices list", () => {
      const result = presentAudioBitrateSelect("aac", 112, formatter);
      expect(result.options.map((opt) => opt.value)).toEqual([
        "default",
        "96",
        "128",
        "160",
        "192",
        "256",
        "320",
        "112",
      ]);
      expect(result.options[7]).toEqual({
        value: "112",
        labelKey: "settings.preset.audioBitrateValue",
        labelValues: { value: "112" },
      });
    });

    it("disables the select with a hint for lossless encoders", () => {
      const resultFlac = presentAudioBitrateSelect("flac", undefined, formatter);
      expect(resultFlac.disabled).toBe(true);
      expect(resultFlac.hintKey).toBe("settings.preset.audioBitrateLossless");
      expect(resultFlac.options).toEqual([
        {
          value: "default",
          labelKey: "settings.preset.audioBitrateDefault",
        },
      ]);

      const resultAlac = presentAudioBitrateSelect("alac", undefined, formatter);
      expect(resultAlac.disabled).toBe(true);
      expect(resultAlac.hintKey).toBe("settings.preset.audioBitrateLossless");
    });

    it("keeps select enabled with a hint when a lossless encoder has a stored bitrate", () => {
      const result = presentAudioBitrateSelect("flac", 320, formatter);
      expect(result.disabled).toBe(false);
      expect(result.hintKey).toBe("settings.preset.audioBitrateLossless");
      expect(result.options.map((opt) => opt.value)).toEqual([
        AUDIO_BITRATE_DEFAULT_VALUE,
        "320",
      ]);
    });
  });

  describe("presentAudioSampleRateSelect", () => {
    const formatter = new Intl.NumberFormat("en-US");

    it("builds options with source and standard sample rates in kHz", () => {
      const result = presentAudioSampleRateSelect("source", formatter);
      expect(result.options).toEqual([
        {
          value: "source",
          labelKey: "settings.preset.sourceOption",
        },
        {
          value: "44100",
          labelKey: "settings.preset.audioSampleRateValue",
          labelValues: { value: "44.1" },
        },
        {
          value: "48000",
          labelKey: "settings.preset.audioSampleRateValue",
          labelValues: { value: "48" },
        },
        {
          value: "96000",
          labelKey: "settings.preset.audioSampleRateValue",
          labelValues: { value: "96" },
        },
      ]);
    });

    it("appends current stored sample rate when not in the choices list", () => {
      const result = presentAudioSampleRateSelect(88200, formatter);
      expect(result.options.map((opt) => opt.value)).toEqual([
        "source",
        "44100",
        "48000",
        "96000",
        "88200",
      ]);
      expect(result.options[4]).toEqual({
        value: "88200",
        labelKey: "settings.preset.audioSampleRateValue",
        labelValues: { value: "88.2" },
      });
    });
  });

  describe("presentAudioChannelsSelect", () => {
    it("returns source, stereo, and mono options", () => {
      const result = presentAudioChannelsSelect();
      expect(result.options).toEqual([
        { value: "source", labelKey: "settings.preset.sourceOption" },
        { value: "stereo", labelKey: "settings.preset.audioChannelsStereo" },
        { value: "mono", labelKey: "settings.preset.audioChannelsMono" },
      ]);
    });
  });

  describe("presentAudioBitrateValue and parseAudioBitrateValue", () => {
    it("maps undefined to AUDIO_BITRATE_DEFAULT_VALUE and numbers to strings", () => {
      expect(presentAudioBitrateValue(undefined)).toBe(AUDIO_BITRATE_DEFAULT_VALUE);
      expect(presentAudioBitrateValue(128)).toBe("128");
      expect(presentAudioBitrateValue(320)).toBe("320");
    });

    it("parses AUDIO_BITRATE_DEFAULT_VALUE to null and number strings to numbers", () => {
      expect(parseAudioBitrateValue(AUDIO_BITRATE_DEFAULT_VALUE)).toBeNull();
      expect(parseAudioBitrateValue("128")).toBe(128);
      expect(parseAudioBitrateValue("320")).toBe(320);
    });
  });

  describe("presentAudioSampleRateValue and parseAudioSampleRateValue", () => {
    it("maps 'source' and numeric sample rates to string select values", () => {
      expect(presentAudioSampleRateValue("source")).toBe("source");
      expect(presentAudioSampleRateValue(48000)).toBe("48000");
      expect(presentAudioSampleRateValue(44100)).toBe("44100");
    });

    it("parses 'source' to 'source' and numeric strings to numbers", () => {
      expect(parseAudioSampleRateValue("source")).toBe("source");
      expect(parseAudioSampleRateValue("48000")).toBe(48000);
      expect(parseAudioSampleRateValue("44100")).toBe(44100);
    });
  });

  describe("selected value option matching", () => {
    const formatter = new Intl.NumberFormat("en-US");

    it("always matches one of the options in presentAudioBitrateSelect", () => {
      const cases: Array<{ encoder: string; bitrate: number | undefined }> = [
        { encoder: "aac", bitrate: undefined },
        { encoder: "aac", bitrate: 128 },
        { encoder: "aac", bitrate: 112 },
        { encoder: "libopus", bitrate: undefined },
        { encoder: "libopus", bitrate: 510 },
        { encoder: "flac", bitrate: undefined },
        { encoder: "flac", bitrate: 320 },
      ];

      for (const { encoder, bitrate } of cases) {
        const selectView = presentAudioBitrateSelect(encoder, bitrate, formatter);
        const selectedValue = presentAudioBitrateValue(bitrate);
        expect(selectView.options.some((opt) => opt.value === selectedValue)).toBe(
          true,
        );
      }
    });

    it("always matches one of the options in presentAudioSampleRateSelect", () => {
      const cases: Array<PresetAudioSampleRate> = [
        "source",
        44100,
        48000,
        96000,
        22050,
      ];

      for (const rate of cases) {
        const selectView = presentAudioSampleRateSelect(rate, formatter);
        const selectedValue = presentAudioSampleRateValue(rate);
        expect(selectView.options.some((opt) => opt.value === selectedValue)).toBe(
          true,
        );
      }
    });

    it("always matches one of the options in presentAudioChannelsSelect", () => {
      const channelsView = presentAudioChannelsSelect();
      for (const channels of ["source", "stereo", "mono"] as const) {
        expect(channelsView.options.some((opt) => opt.value === channels)).toBe(true);
      }
    });

    it("always matches one of the options in presentEncoderSelect", () => {
      const probeState = createProbeState({
        results: [
          { name: "libx264", kind: "video", listed: true, status: "works" },
          { name: "aac", kind: "audio", listed: true, status: "works" },
        ],
      });

      for (const current of ["libx264", "nonexistent", CUSTOM_ENCODER_VALUE]) {
        const selectView = presentEncoderSelect(probeState, "video", current);
        expect(selectView.options.some((opt) => opt.value === current)).toBe(true);
      }

      for (const current of ["aac", "alac", CUSTOM_ENCODER_VALUE]) {
        const selectView = presentEncoderSelect(probeState, "audio", current);
        expect(selectView.options.some((opt) => opt.value === current)).toBe(true);
      }
    });
  });

  // Every key this presenter can emit must resolve to a non-empty string in the English
  // catalog, so a renamed or deleted message fails here instead of rendering a raw key on
  // screen. Follows the same convention as `settingsErrorPresenter.test.ts`.
  describe("catalog coverage", () => {
    const emittedKeys = [
      // all seven field issue codes
      "settings.field.required",
      "settings.field.tooLong",
      "settings.field.charset",
      "settings.field.outOfRange",
      "settings.field.notInteger",
      "settings.field.positive",
      "settings.field.containerMismatch",
      // audio preset controls
      "settings.preset.audioBitrateDefault",
      "settings.preset.audioBitrateValue",
      "settings.preset.audioBitrateLossless",
      "settings.preset.sourceOption",
      "settings.preset.audioSampleRateValue",
      "settings.preset.audioChannelsStereo",
      "settings.preset.audioChannelsMono",
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
