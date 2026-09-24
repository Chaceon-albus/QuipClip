import { describe, expect, it } from "vitest";
import { createI18nInstance } from "@/i18n";
import { MAX_PRESETS } from "@/features/settings/limits";
import {
  nextFreeCopyName,
  PRESET_NAME_SLOT,
  type CopyNameForms,
} from "@/features/settings/presetNaming";
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
  groupIssuesByField,
  joinDescribedBy,
  presentEncoderOption,
  presentEncoderSelect,
  presentFrameRateInvalid,
  presentNumericField,
  presentPresetEncoderMark,
  presentPresetIssue,
  presentQualityKind,
  presentResolutionInvalid,
  presentDuplicatePresetAction,
  presentFrameRateSelect,
  presentFrameRateTermInput,
  presentQualityValueInput,
  presentResolutionInput,
  presentResolutionSelect,
  presentSaveBlockedSummary,
} from "./presetPresenter";
import {
  FRAME_RATE_CHOICES,
  frameRateChoiceValue,
  OUTPUT_CUSTOM_VALUE,
  OUTPUT_SOURCE_VALUE,
  RESOLUTION_CHOICES,
  resolutionChoiceValue,
} from "@/features/settings/videoOutputChoices";
import { createPresetDraft } from "@/features/settings/presetDocument";
import { QUALITY_KINDS } from "@/features/settings/types";

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

  describe("groupIssuesByField", () => {
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

    const EMPTY_GROUPS = {
      name: [],
      container: [],
      videoEncoder: [],
      audioEncoder: [],
      audioBitrate: [],
      audioSampleRate: [],
      quality: [],
      resolution: [],
      frameRate: [],
      other: [],
    };

    it("returns an empty list for every field, and for other, when there are no issues", () => {
      expect(groupIssuesByField([])).toStrictEqual(EMPTY_GROUPS);
    });

    it("puts each issue under the field it names, with the presented message", () => {
      const issues: PresetFieldIssue[] = [
        { field: "name", code: "required" },
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ];

      expect(groupIssuesByField(issues)).toStrictEqual({
        ...EMPTY_GROUPS,
        name: [{ key: "settings.field.required" }],
        quality: [
          {
            key: "settings.field.outOfRange",
            values: { kind: "crf", min: 0, max: 63 },
          },
        ],
      });
    });

    it("tells the five numeric fields apart: each notInteger message is under its own field", () => {
      const preset: Preset = {
        ...basePreset,
        quality: { kind: "crf", value: Number.NaN },
        resolution: { w: Number.NaN, h: 1080 },
        frameRate: { n: 30, d: Number.NaN },
      };
      const groups = groupIssuesByField(validatePresetFields(preset));

      const notInteger = [{ key: "settings.field.notInteger" }];
      expect(groups.quality).toStrictEqual(notInteger);
      expect(groups.resolution).toStrictEqual(notInteger);
      expect(groups.frameRate).toStrictEqual(notInteger);
      expect(groups.other).toStrictEqual([]);
    });

    it("shows a containerMismatch issue under both the audio encoder and the container", () => {
      const preset: Preset = { ...basePreset, container: "mov", audioEncoder: "flac" };
      const groups = groupIssuesByField(validatePresetFields(preset));

      const message = {
        key: "settings.field.containerMismatch",
        values: { container: "MOV", encoder: "flac" },
      };
      expect(groups.audioEncoder).toStrictEqual([message]);
      expect(groups.container).toStrictEqual([message]);
      expect(groups.other).toStrictEqual([]);
    });

    it("keeps every other audio encoder issue under the audio encoder only", () => {
      const groups = groupIssuesByField([{ field: "audioEncoder", code: "charset" }]);
      expect(groups.audioEncoder).toStrictEqual([{ key: "settings.field.charset" }]);
      expect(groups.container).toStrictEqual([]);
    });

    it("puts an issue that names no field of the editor under other", () => {
      // The type allows only known fields. A cast stands for a field that reaches the issues
      // before the editor has a place for it.
      const unknown = {
        field: "subtitleTrack",
        code: "required",
      } as unknown as PresetFieldIssue;

      expect(groupIssuesByField([unknown])).toStrictEqual({
        ...EMPTY_GROUPS,
        other: [{ key: "settings.field.required" }],
      });
    });

    it("does not treat an inherited object property as a field", () => {
      const inherited = {
        field: "toString",
        code: "required",
      } as unknown as PresetFieldIssue;

      expect(groupIssuesByField([inherited]).other).toStrictEqual([
        { key: "settings.field.required" },
      ]);
    });

    it("keeps the order of the issues inside one group", () => {
      const groups = groupIssuesByField([
        { field: "quality", code: "notInteger" },
        {
          field: "quality",
          code: "outOfRange",
          values: { kind: "crf", min: 0, max: 63 },
        },
      ]);
      expect(groups.quality.map((message) => message.key)).toStrictEqual([
        "settings.field.notInteger",
        "settings.field.outOfRange",
      ]);
    });
  });

  describe("presentSaveBlockedSummary", () => {
    it("returns null when there are no issues", () => {
      expect(presentSaveBlockedSummary([])).toBeNull();
    });

    it("counts issues, not messages: a containerMismatch that shows at two fields counts once", () => {
      const issues: PresetFieldIssue[] = [
        { field: "name", code: "required" },
        {
          field: "audioEncoder",
          code: "containerMismatch",
          values: { container: "mov", encoder: "flac" },
        },
      ];
      expect(presentSaveBlockedSummary(issues)).toStrictEqual({
        key: "settings.preset.saveBlocked",
        values: { count: 2 },
      });
    });

    it.each([
      ["en", 1, "Fix 1 problem to save."],
      ["en", 3, "Fix 3 problems to save."],
      ["zh-CN", 1, "修正 1 个问题后即可保存。"],
      ["zh-CN", 3, "修正 3 个问题后即可保存。"],
    ] as const)(
      "renders the plural form in %s for a count of %i",
      async (language, count, expected) => {
        const instance = await createI18nInstance({
          initialPreference: language,
          storage: null,
          systemLanguages: [],
        });
        const issues: PresetFieldIssue[] = Array.from({ length: count }, () => ({
          field: "name",
          code: "required",
        }));
        const summary = presentSaveBlockedSummary(issues);
        expect(summary).not.toBeNull();
        const translate = instance.t as unknown as (
          key: string,
          options?: Record<string, string | number>,
        ) => string;
        expect(translate(summary!.key, summary!.values)).toBe(expected);
      },
    );
  });

  describe("presentDuplicatePresetAction", () => {
    const clean = { canAdd: true, dirty: false, pending: false };

    it("enables Duplicate with no reason for a clean draft and a library with room", () => {
      expect(presentDuplicatePresetAction(clean)).toStrictEqual({
        disabled: false,
        reason: null,
      });
    });

    it("disables Duplicate while the draft holds an unsaved edit and says why", () => {
      expect(presentDuplicatePresetAction({ ...clean, dirty: true })).toStrictEqual({
        disabled: true,
        reason: { key: "settings.preset.duplicateBlockedUnsaved" },
      });
    });

    it("disables Duplicate in a full library and gives the limit message that Add shows", () => {
      expect(presentDuplicatePresetAction({ ...clean, canAdd: false })).toStrictEqual({
        disabled: true,
        reason: { key: "settings.preset.limitReached", values: { max: MAX_PRESETS } },
      });
    });

    it("names the limit before the unsaved edit, because a save does not remove the limit", () => {
      expect(
        presentDuplicatePresetAction({ canAdd: false, dirty: true, pending: false })
          .reason,
      ).toStrictEqual({
        key: "settings.preset.limitReached",
        values: { max: MAX_PRESETS },
      });
    });

    it("disables Duplicate with no reason while a write is in flight", () => {
      expect(presentDuplicatePresetAction({ ...clean, pending: true })).toStrictEqual({
        disabled: true,
        reason: null,
      });
    });
  });

  // The controller receives the name forms already formatted, so these tests run the real
  // catalogs through i18next. A formatted name is stored as user data (ADR 013), so it must
  // hold the source name exactly: no HTML escape, and no other change.
  describe("generated preset name forms", () => {
    async function translatorFor(language: "en" | "zh-CN") {
      const instance = await createI18nInstance({
        initialPreference: language,
        storage: null,
        systemLanguages: [],
      });
      return instance.t as unknown as (
        key: string,
        options?: Record<string, string | number>,
      ) => string;
    }

    it.each([
      ["en", "New Preset", "New Preset 2", "Main Copy", "Main Copy 3"],
      ["zh-CN", "新预设", "新预设 2", "Main 副本", "Main 副本 3"],
    ] as const)(
      "formats the %s forms",
      async (language, newName, newNumbered, copyName, copyNumbered) => {
        const translate = await translatorFor(language);

        expect(translate("settings.preset.newName")).toBe(newName);
        expect(translate("settings.preset.newNameNumbered", { n: 2 })).toBe(
          newNumbered,
        );
        expect(translate("settings.preset.copyName", { name: "Main" })).toBe(copyName);
        expect(
          translate("settings.preset.copyNameNumbered", { name: "Main", n: 3 }),
        ).toBe(copyNumbered);
      },
    );

    // The component formats the copy forms with the name slot, as here, and the naming rule
    // puts the source name in the slot. The source name never goes through i18next.
    it.each([
      ["en", "Copy"],
      ["zh-CN", "副本"],
    ] as const)(
      "keeps the source name exactly in the %s copy forms",
      async (language, word) => {
        const translate = await translatorFor(language);
        const forms: CopyNameForms = {
          base: translate("settings.preset.copyName", { name: PRESET_NAME_SLOT }),
          numbered: (n) =>
            translate("settings.preset.copyNameNumbered", {
              name: PRESET_NAME_SLOT,
              n,
            }),
        };
        const name = `A & <B> "C" 'D' {{n}} {{name}} $& $1`;

        const first = nextFreeCopyName([name], name, forms);
        expect(first).toBe(`${name} ${word}`);
        expect(nextFreeCopyName([name, first], name, forms)).toBe(`${name} ${word} 2`);
      },
    );
  });

  describe("presentResolutionInvalid", () => {
    const basePreset: Preset = {
      id: "preset-1",
      name: "Default Preset",
      container: "mp4",
      videoEncoder: "libx264",
      audioEncoder: "aac",
      audioSampleRate: "source",
      audioChannels: "source",
      quality: { kind: "crf", value: 20 },
      resolution: { w: 1280, h: 720 },
      frameRate: "source",
    };

    function invalidFor(resolution: Preset["resolution"]) {
      const draft: Preset = { ...basePreset, resolution };
      return presentResolutionInvalid(draft, validatePresetFields(draft));
    }

    it("marks neither input when the resolution is valid", () => {
      expect(invalidFor({ w: 1280, h: 720 })).toStrictEqual({ w: false, h: false });
    });

    it("marks neither input when the resolution is the source", () => {
      expect(invalidFor("source")).toStrictEqual({ w: false, h: false });
    });

    it("marks only the width when the width is blank", () => {
      expect(invalidFor({ w: Number.NaN, h: 720 })).toStrictEqual({
        w: true,
        h: false,
      });
    });

    it("marks only the height when the height is out of range", () => {
      expect(invalidFor({ w: 1280, h: 20_000 })).toStrictEqual({ w: false, h: true });
    });

    it("marks both inputs when both hold a bad value", () => {
      expect(invalidFor({ w: 0, h: Number.NaN })).toStrictEqual({ w: true, h: true });
    });

    it("marks neither input when the issue list holds no resolution issue", () => {
      const draft: Preset = { ...basePreset, resolution: { w: Number.NaN, h: 720 } };
      expect(presentResolutionInvalid(draft, [])).toStrictEqual({ w: false, h: false });
    });

    it("marks both inputs when the issue list names the resolution but neither input fails alone", () => {
      // Stands for a future rule on the pair as a whole, such as an aspect ratio.
      const draft: Preset = { ...basePreset, resolution: { w: 1280, h: 720 } };
      expect(
        presentResolutionInvalid(draft, [{ field: "resolution", code: "outOfRange" }]),
      ).toStrictEqual({ w: true, h: true });
    });
  });

  describe("presentFrameRateInvalid", () => {
    const basePreset: Preset = {
      id: "preset-1",
      name: "Default Preset",
      container: "mp4",
      videoEncoder: "libx264",
      audioEncoder: "aac",
      audioSampleRate: "source",
      audioChannels: "source",
      quality: { kind: "crf", value: 20 },
      resolution: "source",
      frameRate: { n: 30000, d: 1001 },
    };

    function invalidFor(frameRate: Preset["frameRate"]) {
      const draft: Preset = { ...basePreset, frameRate };
      return presentFrameRateInvalid(draft, validatePresetFields(draft));
    }

    it("marks neither input when the frame rate is valid", () => {
      expect(invalidFor({ n: 30000, d: 1001 })).toStrictEqual({ n: false, d: false });
    });

    it("marks neither input when the frame rate is the source", () => {
      expect(invalidFor("source")).toStrictEqual({ n: false, d: false });
    });

    it("marks only the denominator when the denominator is blank", () => {
      expect(invalidFor({ n: 30, d: Number.NaN })).toStrictEqual({ n: false, d: true });
    });

    it("marks only the numerator when the numerator is zero", () => {
      expect(invalidFor({ n: 0, d: 1 })).toStrictEqual({ n: true, d: false });
    });

    it("marks both inputs when both hold a bad value", () => {
      expect(invalidFor({ n: -1, d: 0 })).toStrictEqual({ n: true, d: true });
    });
  });

  describe("joinDescribedBy", () => {
    it("joins the present ids with one space", () => {
      expect(joinDescribedBy("a-error", "a-hint")).toBe("a-error a-hint");
    });

    it("skips false, null, undefined, and the empty string", () => {
      expect(joinDescribedBy(false, "a-hint", null, undefined, "")).toBe("a-hint");
    });

    it("returns undefined when no id is present, so the attribute does not render", () => {
      expect(joinDescribedBy(false, undefined)).toBeUndefined();
      expect(joinDescribedBy()).toBeUndefined();
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

  describe("presentFrameRateSelect", () => {
    it("lists source, each fixed rate by its conventional name, and custom last", () => {
      const result = presentFrameRateSelect(new Intl.NumberFormat("en-US"));
      expect(result.options).toEqual([
        { value: "source", labelKey: "settings.preset.sourceOption" },
        {
          value: "24000/1001",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "23.976" },
        },
        {
          value: "24/1",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "24" },
        },
        {
          value: "25/1",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "25" },
        },
        {
          value: "30000/1001",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "29.97" },
        },
        {
          value: "30/1",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "30" },
        },
        {
          value: "50/1",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "50" },
        },
        {
          value: "60000/1001",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "59.94" },
        },
        {
          value: "60/1",
          labelKey: "settings.preset.frameRateValue",
          labelValues: { value: "60" },
        },
        { value: "custom", labelKey: "settings.preset.customOption" },
      ]);
    });

    it("formats the names in the number format of the locale", () => {
      const result = presentFrameRateSelect(new Intl.NumberFormat("de-DE"));
      expect(result.options[1]?.labelValues).toEqual({ value: "23,976" });
      expect(result.options[4]?.labelValues).toEqual({ value: "29,97" });
    });

    it("holds an option for every value that a stored frame rate maps to", () => {
      const values = presentFrameRateSelect(new Intl.NumberFormat("en-US")).options.map(
        (option) => option.value,
      );
      for (const frameRate of [
        "source" as const,
        { n: 48, d: 2 },
        { n: 60000, d: 1001 },
        { n: 15, d: 1 },
        { n: Number.NaN, d: 1 },
      ]) {
        expect(values).toContain(frameRateChoiceValue(frameRate));
      }
      expect(values).toContain(OUTPUT_CUSTOM_VALUE);
    });
  });

  describe("presentResolutionSelect", () => {
    it("lists source, each fixed size, and custom last", () => {
      expect(presentResolutionSelect().options).toEqual([
        { value: "source", labelKey: "settings.preset.sourceOption" },
        {
          value: "3840x2160",
          labelKey: "settings.preset.resolutionValue",
          labelValues: { w: "3840", h: "2160" },
        },
        {
          value: "2560x1440",
          labelKey: "settings.preset.resolutionValue",
          labelValues: { w: "2560", h: "1440" },
        },
        {
          value: "1920x1080",
          labelKey: "settings.preset.resolutionValue",
          labelValues: { w: "1920", h: "1080" },
        },
        {
          value: "1280x720",
          labelKey: "settings.preset.resolutionValue",
          labelValues: { w: "1280", h: "720" },
        },
        { value: "custom", labelKey: "settings.preset.customOption" },
      ]);
    });

    it("holds an option for every value that a stored resolution maps to", () => {
      const values = presentResolutionSelect().options.map((option) => option.value);
      for (const resolution of [
        "source" as const,
        { w: 1920, h: 1080 },
        { w: 1080, h: 1920 },
        { w: Number.NaN, h: 1080 },
      ]) {
        expect(values).toContain(resolutionChoiceValue(resolution));
      }
    });

    it("lists each choice once, with the sentinels at the two ends", () => {
      const values = presentResolutionSelect().options.map((option) => option.value);
      expect(values).toEqual([
        OUTPUT_SOURCE_VALUE,
        ...RESOLUTION_CHOICES.map((choice) => choice.value),
        OUTPUT_CUSTOM_VALUE,
      ]);
      const rates = presentFrameRateSelect(new Intl.NumberFormat("en-US")).options.map(
        (option) => option.value,
      );
      expect(rates).toEqual([
        OUTPUT_SOURCE_VALUE,
        ...FRAME_RATE_CHOICES.map((choice) => choice.value),
        OUTPUT_CUSTOM_VALUE,
      ]);
    });
  });

  describe("presentQualityValueInput", () => {
    it("gives the CRF range, no unit, and the CRF hint", () => {
      expect(presentQualityValueInput("crf")).toEqual({
        min: 0,
        max: 63,
        step: 1,
        hintKey: "settings.preset.qualityHintCrf",
      });
    });

    it("gives the bitrate range, the kbps unit, and the bitrate hint", () => {
      expect(presentQualityValueInput("bitrate")).toEqual({
        min: 1,
        max: 200_000,
        step: 1,
        unitKey: "settings.preset.unitKbps",
        hintKey: "settings.preset.qualityHintBitrate",
      });
    });

    it("gives the quality scale range, no unit, and the quality scale hint", () => {
      expect(presentQualityValueInput("qualityScale")).toEqual({
        min: 1,
        max: 100,
        step: 1,
        hintKey: "settings.preset.qualityHintQualityScale",
      });
    });

    it.each(QUALITY_KINDS)(
      "agrees with validatePresetFields at both ends of the %s range",
      (kind) => {
        const { min, max } = presentQualityValueInput(kind);
        const issuesAt = (value: number) =>
          validatePresetFields({
            ...createPresetDraft("p", "P"),
            quality: { kind, value },
          });
        expect(issuesAt(min)).toEqual([]);
        expect(max).toBeDefined();
        expect(issuesAt(max ?? Number.NaN)).toEqual([]);
        expect(issuesAt(min - 1)).toHaveLength(1);
        expect(issuesAt((max ?? Number.NaN) + 1)).toHaveLength(1);
      },
    );
  });

  describe("presentResolutionInput", () => {
    it("gives the dimension range of ADR 013 and the pixel unit", () => {
      expect(presentResolutionInput()).toEqual({
        min: 1,
        max: 16_384,
        step: 1,
        unitKey: "settings.preset.unitPixels",
      });
    });

    it("agrees with validatePresetFields at both ends of the range", () => {
      const { min, max } = presentResolutionInput();
      const issuesAt = (w: number) =>
        validatePresetFields({
          ...createPresetDraft("p", "P"),
          resolution: { w, h: 720 },
        });
      expect(issuesAt(min)).toEqual([]);
      expect(issuesAt(max ?? Number.NaN)).toEqual([]);
      expect(issuesAt(min - 1)).toHaveLength(1);
      expect(issuesAt((max ?? Number.NaN) + 1)).toHaveLength(1);
    });
  });

  describe("presentFrameRateTermInput", () => {
    it("gives a minimum of 1, no maximum, and no unit", () => {
      expect(presentFrameRateTermInput()).toEqual({ min: 1, step: 1 });
    });

    it("agrees with the positive rule of validatePresetFields", () => {
      const { min } = presentFrameRateTermInput();
      const issuesAt = (n: number, d: number) =>
        validatePresetFields({ ...createPresetDraft("p", "P"), frameRate: { n, d } });
      expect(issuesAt(min, min)).toEqual([]);
      expect(issuesAt(min - 1, 1)).toEqual([{ field: "frameRate", code: "positive" }]);
      expect(issuesAt(1, min - 1)).toEqual([{ field: "frameRate", code: "positive" }]);
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
      // the Duplicate action
      "settings.preset.duplicateBlockedUnsaved",
      "settings.preset.limitReached",
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
      // the resolution and frame rate choices
      "settings.preset.customOption",
      "settings.preset.frameRateValue",
      "settings.preset.resolutionValue",
      // the number inputs: units and the quality value hints
      "settings.preset.unitKbps",
      "settings.preset.unitPixels",
      "settings.preset.qualityHintCrf",
      "settings.preset.qualityHintBitrate",
      "settings.preset.qualityHintQualityScale",
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
