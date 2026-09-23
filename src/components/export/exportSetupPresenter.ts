/**
 * Pure presenter for the export dialog setup step.
 *
 * Implements preset resolution, summary presentation, and export blocker detection
 * according to ADR 011, ADR 023, and ADR 024. Pure module with no React dependencies.
 */

import {
  formatAudioSampleRateKHz,
  presentContainer,
} from "@/components/settings/presetPresenter";
import {
  isAudioEncoderAllowedIn,
  isLosslessAudioEncoder,
} from "@/features/settings/audioCodecs";
import type {
  Preset,
  Settings,
  SettingsError,
  SettingsStatus,
} from "@/features/settings/types";

/**
 * View model for a single summary row in the preset details list.
 */
export type PresetSummaryRowView = {
  id: string;
  labelKey: string;
  valueKey: string;
  valueValues?: Record<string, string>;
};

/**
 * Blocker message indicating why an export cannot proceed with the given preset.
 */
export type SetupBlockerView = {
  key: string;
  values?: Record<string, string>;
};

/**
 * Resolves the effective preset identifier for the export setup dialog.
 *
 * Hierarchy per ADR 024:
 * 1. The user's explicit in-dialog selection (`requestedId`), when that preset still exists.
 * 2. The active preset from settings (`settings.activePresetId`), when that preset exists.
 * 3. The first preset in the library, when the active preset identifier dangles or is unset.
 * 4. `null` when no presets exist or settings are not loaded yet.
 */
export function resolveSetupPresetId(
  settings: Settings | null,
  requestedId: string | null,
): string | null {
  if (!settings || settings.presets.length === 0) {
    return null;
  }

  if (requestedId !== null && settings.presets.some((p) => p.id === requestedId)) {
    return requestedId;
  }

  if (
    settings.activePresetId !== undefined &&
    settings.presets.some((p) => p.id === settings.activePresetId)
  ) {
    return settings.activePresetId;
  }

  return settings.presets[0]?.id ?? null;
}

/**
 * Formats a frame rate fraction n/d as a localized decimal string with at most 3 fraction digits.
 *
 * For example, 30000/1001 renders as "29.97" and 24000/1001 renders as "23.976", matching
 * standard video industry conventions without assembling sentences from fragments.
 */
export function formatFps(
  numerator: number,
  denominator: number,
  formatter: Intl.NumberFormat,
): string {
  const fpsFormatter = new Intl.NumberFormat(formatter.resolvedOptions().locale, {
    maximumFractionDigits: 3,
  });
  return fpsFormatter.format(numerator / denominator);
}

/**
 * Builds the compact definition list rows summarizing the selected preset's configuration.
 *
 * Emits exactly nine rows in a fixed order:
 * 1. Container
 * 2. Video Encoder
 * 3. Quality
 * 4. Audio Encoder
 * 5. Audio Bitrate
 * 6. Sample Rate
 * 7. Channels
 * 8. Resolution
 * 9. Frame Rate
 */
export function presentPresetSummary(
  preset: Preset,
  formatter: Intl.NumberFormat,
): PresetSummaryRowView[] {
  // 1. Container: technical identifier passed through without translation
  const containerRow: PresetSummaryRowView = {
    id: "container",
    labelKey: "settings.preset.containerLabel",
    valueKey: "export.setup.value",
    valueValues: { value: presentContainer(preset.container) },
  };

  // 2. Video Encoder: technical encoder name passed through verbatim
  const videoEncoderRow: PresetSummaryRowView = {
    id: "videoEncoder",
    labelKey: "settings.preset.videoEncoderLabel",
    valueKey: "export.setup.value",
    valueValues: { value: preset.videoEncoder },
  };

  // 3. Quality: CRF, bitrate, or quality scale
  let qualityValueKey: string;
  switch (preset.quality.kind) {
    case "crf":
      qualityValueKey = "export.setup.qualityCrf";
      break;
    case "bitrate":
      qualityValueKey = "export.setup.qualityBitrate";
      break;
    case "qualityScale":
      qualityValueKey = "export.setup.qualityScale";
      break;
  }
  const qualityRow: PresetSummaryRowView = {
    id: "quality",
    labelKey: "export.setup.qualityLabel",
    valueKey: qualityValueKey,
    valueValues: { value: formatter.format(preset.quality.value) },
  };

  // 4. Audio Encoder: technical encoder name passed through verbatim
  const audioEncoderRow: PresetSummaryRowView = {
    id: "audioEncoder",
    labelKey: "settings.preset.audioEncoderLabel",
    valueKey: "export.setup.value",
    valueValues: { value: preset.audioEncoder },
  };

  // 5. Audio Bitrate: Lossless has no bitrate; absent bitrate uses default; otherwise formatted kbps
  let audioBitrateRow: PresetSummaryRowView;
  if (isLosslessAudioEncoder(preset.audioEncoder)) {
    audioBitrateRow = {
      id: "audioBitrate",
      labelKey: "settings.preset.audioBitrateLabel",
      valueKey: "export.setup.audioBitrateLossless",
    };
  } else if (preset.audioBitrate === undefined) {
    audioBitrateRow = {
      id: "audioBitrate",
      labelKey: "settings.preset.audioBitrateLabel",
      valueKey: "settings.preset.audioBitrateDefault",
    };
  } else {
    audioBitrateRow = {
      id: "audioBitrate",
      labelKey: "settings.preset.audioBitrateLabel",
      valueKey: "settings.preset.audioBitrateValue",
      valueValues: { value: formatter.format(preset.audioBitrate) },
    };
  }

  // 6. Sample Rate: "source" or formatted in kHz (e.g. 48 kHz, 44.1 kHz)
  let sampleRateRow: PresetSummaryRowView;
  if (preset.audioSampleRate === "source") {
    sampleRateRow = {
      id: "audioSampleRate",
      labelKey: "settings.preset.audioSampleRateLabel",
      valueKey: "settings.preset.sourceOption",
    };
  } else {
    sampleRateRow = {
      id: "audioSampleRate",
      labelKey: "settings.preset.audioSampleRateLabel",
      valueKey: "settings.preset.audioSampleRateValue",
      valueValues: {
        value: formatAudioSampleRateKHz(preset.audioSampleRate, formatter),
      },
    };
  }

  // 7. Channels: "source", "stereo", or "mono"
  let channelsValueKey: string;
  switch (preset.audioChannels) {
    case "source":
      channelsValueKey = "settings.preset.sourceOption";
      break;
    case "stereo":
      channelsValueKey = "settings.preset.audioChannelsStereo";
      break;
    case "mono":
      channelsValueKey = "settings.preset.audioChannelsMono";
      break;
  }
  const channelsRow: PresetSummaryRowView = {
    id: "audioChannels",
    labelKey: "settings.preset.audioChannelsLabel",
    valueKey: channelsValueKey,
  };

  // 8. Resolution: "source" or formatted dimensions (e.g. 1920 × 1080)
  let resolutionRow: PresetSummaryRowView;
  if (preset.resolution === "source") {
    resolutionRow = {
      id: "resolution",
      labelKey: "settings.preset.resolutionLabel",
      valueKey: "settings.preset.sourceOption",
    };
  } else {
    // Dimension is a technical coordinate, not a counted quantity, keeping unformatted integers
    resolutionRow = {
      id: "resolution",
      labelKey: "settings.preset.resolutionLabel",
      valueKey: "export.setup.resolutionValue",
      valueValues: {
        width: String(preset.resolution.w),
        height: String(preset.resolution.h),
      },
    };
  }

  // 9. Frame Rate: "source" or formatted fps decimal with up to 3 fraction digits
  let frameRateRow: PresetSummaryRowView;
  if (preset.frameRate === "source") {
    frameRateRow = {
      id: "frameRate",
      labelKey: "settings.preset.frameRateLabel",
      valueKey: "settings.preset.sourceOption",
    };
  } else {
    frameRateRow = {
      id: "frameRate",
      labelKey: "settings.preset.frameRateLabel",
      valueKey: "export.setup.frameRateValue",
      valueValues: {
        value: formatFps(preset.frameRate.n, preset.frameRate.d, formatter),
      },
    };
  }

  return [
    containerRow,
    videoEncoderRow,
    qualityRow,
    audioEncoderRow,
    audioBitrateRow,
    sampleRateRow,
    channelsRow,
    resolutionRow,
    frameRateRow,
  ];
}

/**
 * Checks whether an export blocker exists for the given preset.
 *
 * Returns `export.setup.noPresets` when no preset is selected or available.
 * Returns `settings.field.containerMismatch` when the preset pairs an incompatible container
 * and audio encoder (e.g. mov + flac, mov + libopus per ADR 023).
 * Otherwise returns `null`, indicating the setup step allows proceeding to file destination selection.
 */
export function presentSetupBlocker(preset: Preset | null): SetupBlockerView | null {
  if (preset === null) {
    return { key: "export.setup.noPresets" };
  }

  if (!isAudioEncoderAllowedIn(preset.container, preset.audioEncoder)) {
    return {
      key: "settings.field.containerMismatch",
      values: {
        container: presentContainer(preset.container),
        encoder: preset.audioEncoder,
      },
    };
  }

  return null;
}

/**
 * Display state for the export setup view step.
 */
export type ExportSetupStepState = "loading" | "error" | "empty" | "ready";

/**
 * Resolves the display state for the export setup step from the settings store state.
 *
 * - "loading": Settings document has not loaded yet and the store is not in error.
 * - "error": Settings document is absent and the store encountered an error loading.
 * - "empty": Settings document is loaded but contains zero presets.
 * - "ready": Settings document is loaded and has at least one preset.
 */
export function resolveExportSetupStepState(state: {
  settings: Settings | null;
  status: SettingsStatus;
  error?: SettingsError | null;
}): ExportSetupStepState {
  if (state.settings === null) {
    if (state.status === "error" || state.error) {
      return "error";
    }
    return "loading";
  }

  if (state.settings.presets.length === 0) {
    return "empty";
  }

  return "ready";
}
