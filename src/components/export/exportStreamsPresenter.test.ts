import { describe, expect, it } from "vitest";
import { BOTH_EXPORT_STREAMS, type ExportStreamChoice } from "@/features/export";
import type { AudioProbe } from "@/features/media";
import type { Preset } from "@/features/settings/types";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  presentPresetSummary,
  type PresetSummarySource,
  type PresetSummaryView,
} from "./exportSetupPresenter";
import {
  presentStreamSummary,
  presentStreamSwitches,
  type StreamSwitchesView,
} from "./exportStreamsPresenter";

/** Walks a dotted message key through a catalog, as i18next does. */
function lookup(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, catalog);
}

function createPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "default-preset",
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
    pixelFormat: "yuv420p",
    videoOptions: [],
    audioOptions: [],
    ...overrides,
  };
}

const STEREO: AudioProbe = { index: 1, codec: "aac", sampleRate: 48000, channels: 2 };

function createSource(audio: AudioProbe | null): PresetSummarySource {
  return {
    width: 1920,
    height: 1080,
    avgFrameRate: { n: 30, d: 1 },
    rFrameRate: { n: 30, d: 1 },
    audio,
  };
}

const VIDEO_ONLY: ExportStreamChoice = { video: true, audio: false };
const AUDIO_ONLY: ExportStreamChoice = { video: false, audio: true };

const formatter = new Intl.NumberFormat("en");

describe("presentStreamSwitches", () => {
  it("turns both switches on by default, and locks neither", () => {
    expect(presentStreamSwitches(BOTH_EXPORT_STREAMS, createSource(STEREO))).toEqual({
      video: {
        kind: "video",
        checked: true,
        labelKey: "export.setup.exportVideo",
        lockKey: null,
      },
      audio: {
        kind: "audio",
        checked: true,
        labelKey: "export.setup.exportAudio",
        lockKey: null,
      },
    } satisfies StreamSwitchesView);
  });

  it("locks the video switch when it is the last switch that is on", () => {
    const switches = presentStreamSwitches(VIDEO_ONLY, createSource(STEREO));
    expect(switches.video).toMatchObject({
      checked: true,
      lockKey: "export.setup.keepOneStream",
    });
    // The audio switch can be turned on again.
    expect(switches.audio).toMatchObject({ checked: false, lockKey: null });
  });

  it("locks the audio switch when it is the last switch that is on", () => {
    const switches = presentStreamSwitches(AUDIO_ONLY, createSource(STEREO));
    expect(switches.audio).toMatchObject({
      checked: true,
      lockKey: "export.setup.keepOneStream",
    });
    expect(switches.video).toMatchObject({ checked: false, lockKey: null });
  });

  it.each([BOTH_EXPORT_STREAMS, VIDEO_ONLY, AUDIO_ONLY])(
    "turns the audio off and locks both switches for a source with no audio (%o)",
    (choice) => {
      const switches = presentStreamSwitches(choice, createSource(null));
      expect(switches.audio).toMatchObject({
        checked: false,
        lockKey: "export.setup.sourceHasNoAudio",
      });
      // The video is then the last stream, whatever the choice says, and its tooltip names the
      // missing audio rather than offering a choice of streams.
      expect(switches.video).toMatchObject({
        checked: true,
        lockKey: "export.setup.videoRequired",
      });
    },
  );

  it("follows the choice with no source, because the audio is not known to be missing", () => {
    expect(presentStreamSwitches(AUDIO_ONLY, null)).toMatchObject({
      video: { checked: false, lockKey: null },
      audio: { checked: true, lockKey: "export.setup.keepOneStream" },
    });
  });

  it("names only keys that both catalogs define", () => {
    const keys = [BOTH_EXPORT_STREAMS, VIDEO_ONLY, AUDIO_ONLY].flatMap((choice) =>
      [createSource(STEREO), createSource(null)].flatMap((source) => {
        const switches = presentStreamSwitches(choice, source);
        return [switches.video, switches.audio].flatMap((view) =>
          view.lockKey === null ? [view.labelKey] : [view.labelKey, view.lockKey],
        );
      }),
    );
    expect(new Set(keys)).toStrictEqual(
      new Set([
        "export.setup.exportVideo",
        "export.setup.exportAudio",
        "export.setup.keepOneStream",
        "export.setup.sourceHasNoAudio",
        "export.setup.videoRequired",
      ]),
    );
    for (const key of keys) {
      expect(typeof lookup(en, key)).toBe("string");
      expect(typeof lookup(zhCN, key)).toBe("string");
    }
  });
});

describe("presentStreamSummary", () => {
  function summaryOf(preset: Preset, audio: AudioProbe | null): PresetSummaryView {
    return presentPresetSummary(preset, formatter, createSource(audio));
  }

  it("keeps the whole summary of an export of the video and the audio", () => {
    const preset = createPreset();
    const summary = summaryOf(preset, STEREO);
    expect(
      presentStreamSummary(summary, preset.container, "videoAndAudio"),
    ).toStrictEqual(summary);
  });

  it("collapses the Audio group of a video-only export to one line", () => {
    const preset = createPreset({ container: "mkv" });
    const summary = summaryOf(preset, STEREO);
    const shown = presentStreamSummary(summary, preset.container, "videoOnly");
    expect(shown.container).toStrictEqual(summary.container);
    expect(shown.groups[0]).toStrictEqual(summary.groups[0]);
    expect(shown.groups[1]).toStrictEqual({
      id: "audio",
      headingKey: "settings.preset.groupAudio",
      rows: [],
      noteKey: "export.setup.notExported",
    });
  });

  it("collapses the Video group of an audio-only export to one line", () => {
    const preset = createPreset();
    const summary = summaryOf(preset, STEREO);
    const shown = presentStreamSummary(summary, preset.container, "audioOnly");
    expect(shown.groups[0]).toStrictEqual({
      id: "video",
      headingKey: "settings.preset.groupVideo",
      rows: [],
      noteKey: "export.setup.notExported",
    });
    expect(shown.groups[1]).toStrictEqual(summary.groups[1]);
  });

  it("keeps the note of a source with no audio, which says why no audio is written", () => {
    const preset = createPreset();
    const summary = summaryOf(preset, null);
    const shown = presentStreamSummary(summary, preset.container, "videoOnly");
    expect(shown.groups[1]).toStrictEqual({
      id: "audio",
      headingKey: "settings.preset.groupAudio",
      rows: [],
      noteKey: "export.setup.noSourceAudio",
    });
  });

  it.each([
    ["mp4", "videoAndAudio", "export.setup.value", { value: "MP4" }],
    ["mov", "videoAndAudio", "export.setup.value", { value: "MOV" }],
    ["mkv", "videoAndAudio", "export.setup.value", { value: "MKV" }],
    ["mp4", "videoOnly", "export.setup.value", { value: "MP4" }],
    ["mov", "videoOnly", "export.setup.value", { value: "MOV" }],
    ["mkv", "videoOnly", "export.setup.value", { value: "MKV" }],
    [
      "mp4",
      "audioOnly",
      "export.setup.audioOnlyContainer",
      { extension: ".m4a", format: "MP4" },
    ],
    [
      "mov",
      "audioOnly",
      "export.setup.audioOnlyContainer",
      { extension: ".m4a", format: "MP4" },
    ],
    [
      "mkv",
      "audioOnly",
      "export.setup.audioOnlyContainer",
      { extension: ".mka", format: "MKV" },
    ],
  ] as const)(
    "names the output of a %s preset with %s in the Container row",
    (container, streams, valueKey, valueValues) => {
      const preset = createPreset({ container });
      const shown = presentStreamSummary(summaryOf(preset, STEREO), container, streams);
      expect(shown.container).toStrictEqual({
        id: "container",
        labelKey: "settings.preset.containerLabel",
        valueKey,
        valueValues,
      });
    },
  );

  it("names only keys that both catalogs define, with the same placeholders", () => {
    const placeholders = (text: unknown) =>
      String(text)
        .match(/\{\{\w+\}\}/g)
        ?.sort() ?? [];
    for (const key of [
      "export.setup.notExported",
      "export.setup.audioOnlyContainer",
      "dialog.audioFilter",
    ]) {
      const english = lookup(en, key);
      const chinese = lookup(zhCN, key);
      expect(typeof english).toBe("string");
      expect(typeof chinese).toBe("string");
      expect(placeholders(chinese)).toEqual(placeholders(english));
    }
    expect(en.export.setup.audioOnlyContainer).toBe("{{extension}} ({{format}})");
    expect(zhCN.export.setup.audioOnlyContainer).toBe("{{extension}}（{{format}}）");
  });
});
