import { describe, expect, it } from "vitest";
import { presentExportAction } from "@/components/layout/exportActionPresenter";
import {
  presentFrameRateSelect,
  presentPresetEncoderMark,
  presentPresetRowSummary,
} from "@/components/settings/presetPresenter";
import type { FfmpegState } from "@/features/ffmpeg/types";
import { SettingsError, type Preset, type Settings } from "@/features/settings/types";
import { FRAME_RATE_CHOICES } from "@/features/settings/videoOutputChoices";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { MILLISECONDS_TIMECODE_DISPLAY, type TimecodeDisplay } from "@/lib/timecode";
import type { Pts, Rational, Segment } from "@/types/project";
import {
  SUMMARY_FILE_NAME_MAX_GRAPHEMES,
  activeSourceDurationTicks,
  estimateExportBytes,
  formatEstimatedSize,
  formatFps,
  formatFrameRate,
  isBelowOneKilobyte,
  isolateText,
  presentExportSummarySentence,
  presentPresetOptions,
  presentPresetSummary,
  presentSetupBlocker,
  presentSetupSettingsSection,
  presentSizeEstimate,
  resolveExportSetupStepState,
  resolveSetupPresetId,
  roundToSignificantDigits,
  truncateFileNameMiddle,
  type ExactBytes,
  type ExportSizeInput,
  type ExportSummaryInput,
  type PresetSummarySource,
  type PresetSummaryView,
} from "./exportSetupPresenter";

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
    ...overrides,
  };
}

function createSettings(presets: Preset[], activePresetId?: string): Settings {
  return {
    schemaVersion: 1,
    revision: 1,
    activePresetId,
    presets,
  };
}

describe("exportSetupPresenter", () => {
  const formatter = new Intl.NumberFormat("en");

  describe("resolveSetupPresetId", () => {
    it("returns null when settings is null or presets are empty", () => {
      expect(resolveSetupPresetId(null, "p1")).toBeNull();
      expect(resolveSetupPresetId(createSettings([]), "p1")).toBeNull();
    });

    it("returns requestedId when a preset with that id exists", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p1");

      expect(resolveSetupPresetId(settings, "p2")).toBe("p2");
    });

    it("falls back to activePresetId when requestedId is null or missing from presets", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settings = createSettings([p1, p2], "p2");

      expect(resolveSetupPresetId(settings, null)).toBe("p2");
      expect(resolveSetupPresetId(settings, "non-existent")).toBe("p2");
    });

    it("falls back to the first preset id when activePresetId dangles or is unset", () => {
      const p1 = createPreset({ id: "p1" });
      const p2 = createPreset({ id: "p2" });
      const settingsWithDangling = createSettings([p1, p2], "dangling-id");
      const settingsWithoutActive = createSettings([p1, p2]);

      expect(resolveSetupPresetId(settingsWithDangling, null)).toBe("p1");
      expect(resolveSetupPresetId(settingsWithoutActive, null)).toBe("p1");
    });
  });

  describe("formatFps", () => {
    it("formats fractional frame rates with at most 3 decimal fraction digits", () => {
      // 30000/1001 = 29.9700299... -> 29.97
      expect(formatFps(30000, 1001, formatter)).toBe("29.97");
      // 24000/1001 = 23.9760239... -> 23.976
      expect(formatFps(24000, 1001, formatter)).toBe("23.976");
      // 60000/1001 = 59.9400599... -> 59.94
      expect(formatFps(60000, 1001, formatter)).toBe("59.94");
      // Whole numbers
      expect(formatFps(30, 1, formatter)).toBe("30");
      expect(formatFps(24, 1, formatter)).toBe("24");
      expect(formatFps(60, 1, formatter)).toBe("60");
    });
  });

  describe("formatFrameRate", () => {
    it("labels every fixed choice as the frame rate select of the preset editor does", () => {
      const editorLabels = presentFrameRateSelect(formatter)
        .options.filter(
          (option) => option.labelKey === "settings.preset.frameRateValue",
        )
        .map((option) => option.labelValues?.value);
      expect(
        FRAME_RATE_CHOICES.map((choice) => formatFrameRate(choice.rate, formatter)),
      ).toEqual(editorLabels);
    });

    it("finds a choice by the value of the fraction, not by its terms", () => {
      expect(formatFrameRate({ n: 48, d: 2 }, formatter)).toBe("24");
      expect(formatFrameRate({ n: 60000, d: 2002 }, formatter)).toBe("29.97");
    });

    it("formats any other rate with at most 3 fraction digits", () => {
      expect(formatFrameRate({ n: 2997, d: 100 }, formatter)).toBe("29.97");
      expect(formatFrameRate({ n: 15, d: 1 }, formatter)).toBe("15");
      expect(formatFrameRate({ n: 120, d: 1 }, formatter)).toBe("120");
      expect(formatFrameRate({ n: 1, d: 3 }, formatter)).toBe("0.333");
    });

    it("uses the number format of the locale", () => {
      const german = new Intl.NumberFormat("de");
      expect(formatFrameRate({ n: 30000, d: 1001 }, german)).toBe("29,97");
      expect(formatFrameRate({ n: 2997, d: 100 }, german)).toBe("29,97");
    });
  });

  describe("truncateFileNameMiddle", () => {
    it("returns a name of at most the limit unchanged", () => {
      expect(truncateFileNameMiddle("clip.mov")).toBe("clip.mov");
      const forty = `${"a".repeat(36)}.mov`;
      expect(truncateFileNameMiddle(forty)).toBe(forty);
      expect(SUMMARY_FILE_NAME_MAX_GRAPHEMES).toBe(40);
    });

    it("keeps the start and the end of the stem, and the whole extension", () => {
      expect(truncateFileNameMiddle("abcdefghijkl.mp4", 10)).toBe("abc…kl.mp4");
    });

    it("shortens a long name to the limit by default", () => {
      const name = "Recording 2026-09-23 at 10.15.32 final cut.mov";
      const result = truncateFileNameMiddle(name);
      expect(result).toBe("Recording 2026-09-…0.15.32 final cut.mov");
      expect([...result]).toHaveLength(SUMMARY_FILE_NAME_MAX_GRAPHEMES);
    });

    it("removes the white space next to the mark", () => {
      expect(truncateFileNameMiddle("ab defgh i.mp4", 10)).toBe("ab…i.mp4");
    });

    it("shortens the whole name when the extension takes more than half the limit", () => {
      expect(truncateFileNameMiddle("ab.abcdefghijkl", 10)).toBe("ab.ab…ijkl");
    });

    it("never splits a grapheme cluster", () => {
      const family = "👩‍👩‍👧‍👦";
      const name = `${family.repeat(12)}.mov`;
      expect(truncateFileNameMiddle(name, 10)).toBe(
        `${family.repeat(3)}…${family.repeat(2)}.mov`,
      );
    });

    it("counts each Chinese character as one cluster", () => {
      const result = truncateFileNameMiddle(`${"视频片段".repeat(12)}.mp4`);
      expect([...result]).toHaveLength(SUMMARY_FILE_NAME_MAX_GRAPHEMES);
      expect(result.startsWith("视频片段")).toBe(true);
      expect(result.endsWith("片段.mp4")).toBe(true);
    });
  });

  describe("presentExportSummarySentence", () => {
    const fps25: Rational = { n: 25, d: 1 };
    const ms: Rational = { n: 1, d: 1000 };
    const framesDisplay: TimecodeDisplay = {
      format: "frames",
      rate: fps25,
      videoTimeBase: ms,
    };

    function summaryInput(
      overrides: Partial<ExportSummaryInput> = {},
    ): ExportSummaryInput {
      return {
        fileName: "clip.mov",
        segmentCount: 3,
        // 251 frames at 25 fps.
        segmentTotal: 251n,
        display: framesDisplay,
        ...overrides,
      };
    }

    it("names the count, the file, and the frame total", () => {
      expect(presentExportSummarySentence(summaryInput())).toEqual({
        key: "export.setup.summary",
        count: 3,
        fileName: "\u2068clip.mov\u2069",
        fullFileName: "\u2068clip.mov\u2069",
        shortened: false,
        title: "clip.mov",
        duration: "00:00:10:01",
      });
    });

    it("isolates the file name, so a right-to-left name cannot reorder the sentence", () => {
      const hebrew = "סרטון חופשה.mov";
      const view = presentExportSummarySentence(summaryInput({ fileName: hebrew }));
      expect(view?.fileName).toBe(`\u2068${hebrew}\u2069`);
      expect(view?.fullFileName).toBe(`\u2068${hebrew}\u2069`);
      // The tooltip shows the name alone, so it needs no isolation marks.
      expect(view?.title).toBe(hebrew);

      // Each placeholder of the catalog then holds one isolated run: the name cannot swap
      // places with the count or the duration.
      const sentence = en.export.setup.summary_other
        .replace("{{count}}", "3")
        .replace("{{fileName}}", view?.fileName ?? "")
        .replace("{{duration}}", view?.duration ?? "");
      expect(sentence).toBe(
        `Export 3 segments from \u2068${hebrew}\u2069 · 00:00:10:01 in total`,
      );
      expect(isolateText("")).toBe("\u2068\u2069");
    });

    it("shortens inside the isolation marks, which the limit does not count", () => {
      const name = `${"a".repeat(36)}.mov`;
      const view = presentExportSummarySentence(summaryInput({ fileName: name }));
      expect(view?.fileName).toBe(`\u2068${name}\u2069`);
      expect(view?.shortened).toBe(false);
    });

    it("shows the duration of the Export tooltip in each timecode format", () => {
      const cases: Partial<ExportSummaryInput>[] = [
        {},
        { segmentTotal: 10_040n, display: MILLISECONDS_TIMECODE_DISPLAY },
        { segmentTotal: null },
        { segmentTotal: null, display: MILLISECONDS_TIMECODE_DISPLAY },
        {
          segmentTotal: 1_000n,
          display: { format: "frames", rate: { n: 30000, d: 1001 }, videoTimeBase: ms },
        },
      ];
      for (const overrides of cases) {
        const input = summaryInput(overrides);
        const tooltip = presentExportAction({
          hasMedia: true,
          exportStatus: "idle",
          segmentCount: input.segmentCount,
          segmentTotal: input.segmentTotal,
          display: input.display,
        });
        expect(tooltip.label.key).toBe("titleBar.exportTooltip.exportSegments");
        const tooltipDuration =
          tooltip.label.key === "titleBar.exportTooltip.exportSegments"
            ? tooltip.label.duration
            : null;
        expect(presentExportSummarySentence(input)?.duration).toBe(tooltipDuration);
      }
      expect(
        presentExportSummarySentence(
          summaryInput({
            segmentTotal: 10_040n,
            display: MILLISECONDS_TIMECODE_DISPLAY,
          }),
        )?.duration,
      ).toBe("00:00:10.040");
      expect(
        presentExportSummarySentence(summaryInput({ segmentTotal: null }))?.duration,
      ).toBe("--:--:--:--");
    });

    it("shortens a long file name and keeps the whole name for the tooltip and assistive technology", () => {
      const name = "Recording 2026-09-23 at 10.15.32 final cut.mov";
      expect(presentExportSummarySentence(summaryInput({ fileName: name }))).toEqual(
        expect.objectContaining({
          fileName: "\u2068Recording 2026-09-…0.15.32 final cut.mov\u2069",
          fullFileName: `\u2068${name}\u2069`,
          shortened: true,
          title: name,
        }),
      );
    });

    it("states nothing with no open source or no segment", () => {
      expect(presentExportSummarySentence(summaryInput({ fileName: null }))).toBeNull();
      expect(
        presentExportSummarySentence(summaryInput({ segmentCount: 0 })),
      ).toBeNull();
    });
  });

  describe("presentPresetSummary", () => {
    function createSource(
      overrides: Partial<PresetSummarySource> = {},
    ): PresetSummarySource {
      return {
        width: 1920,
        height: 1080,
        avgFrameRate: { n: 30000, d: 1001 },
        rFrameRate: { n: 30000, d: 1001 },
        audio: { index: 1, codec: "aac", sampleRate: 48000, channels: 2 },
        ...overrides,
      };
    }

    function rowOf(summary: PresetSummaryView, id: string) {
      return summary.groups.flatMap((group) => group.rows).find((row) => row.id === id);
    }

    it("puts the container first, then the Video group and the Audio group", () => {
      const preset = createPreset({
        container: "mp4",
        videoEncoder: "libx264",
        quality: { kind: "crf", value: 22 },
        audioEncoder: "aac",
        audioBitrate: 256,
        audioSampleRate: 48000,
        audioChannels: "stereo",
        resolution: { w: 1920, h: 1080 },
        frameRate: { n: 30000, d: 1001 },
      });

      const summary = presentPresetSummary(preset, formatter, null);

      expect(summary.container).toEqual({
        id: "container",
        labelKey: "settings.preset.containerLabel",
        valueKey: "export.setup.value",
        valueValues: { value: "MP4" },
      });
      expect(summary.groups).toEqual([
        {
          id: "video",
          headingKey: "settings.preset.groupVideo",
          rows: [
            {
              id: "videoEncoder",
              labelKey: "settings.preset.videoEncoderLabel",
              valueKey: "export.setup.value",
              valueValues: { value: "libx264" },
            },
            {
              id: "quality",
              labelKey: "export.setup.qualityLabel",
              valueKey: "export.setup.qualityCrf",
              valueValues: { value: "22" },
            },
            {
              id: "resolution",
              labelKey: "settings.preset.resolutionLabel",
              valueKey: "export.setup.resolutionValue",
              valueValues: { width: "1920", height: "1080" },
            },
            {
              id: "frameRate",
              labelKey: "settings.preset.frameRateLabel",
              valueKey: "export.setup.frameRateValue",
              valueValues: { value: "29.97" },
            },
          ],
        },
        {
          id: "audio",
          headingKey: "settings.preset.groupAudio",
          rows: [
            {
              id: "audioEncoder",
              labelKey: "settings.preset.audioEncoderLabel",
              valueKey: "export.setup.value",
              valueValues: { value: "aac" },
            },
            {
              id: "audioBitrate",
              labelKey: "settings.preset.audioBitrateLabel",
              valueKey: "settings.preset.audioBitrateValue",
              valueValues: { value: "256" },
            },
            {
              id: "audioSampleRate",
              labelKey: "settings.preset.audioSampleRateLabel",
              valueKey: "settings.preset.audioSampleRateValue",
              valueValues: { value: "48" },
            },
            {
              id: "audioChannels",
              labelKey: "settings.preset.audioChannelsLabel",
              valueKey: "settings.preset.audioChannelsStereo",
            },
          ],
        },
      ]);
    });

    it("shows a stated value the same way with or without an open source", () => {
      const preset = createPreset({
        audioSampleRate: 44100,
        audioChannels: "mono",
        resolution: { w: 1280, h: 720 },
        frameRate: { n: 25, d: 1 },
      });
      expect(presentPresetSummary(preset, formatter, createSource())).toEqual(
        presentPresetSummary(preset, formatter, null),
      );
    });

    it("handles quality kinds bitrate and qualityScale", () => {
      const bitratePreset = createPreset({
        quality: { kind: "bitrate", value: 8000 },
      });
      const scalePreset = createPreset({
        quality: { kind: "qualityScale", value: 50 },
      });

      expect(
        rowOf(presentPresetSummary(bitratePreset, formatter, null), "quality"),
      ).toEqual({
        id: "quality",
        labelKey: "export.setup.qualityLabel",
        valueKey: "export.setup.qualityBitrate",
        valueValues: { value: "8,000" },
      });
      expect(
        rowOf(presentPresetSummary(scalePreset, formatter, null), "quality"),
      ).toEqual({
        id: "quality",
        labelKey: "export.setup.qualityLabel",
        valueKey: "export.setup.qualityScale",
        valueValues: { value: "50" },
      });
    });

    it("handles lossless audio encoder and absent bitrate", () => {
      const losslessPreset = createPreset({
        audioEncoder: "flac",
        audioBitrate: undefined,
      });
      const defaultBitratePreset = createPreset({
        audioEncoder: "aac",
        audioBitrate: undefined,
      });

      expect(
        rowOf(presentPresetSummary(losslessPreset, formatter, null), "audioBitrate"),
      ).toEqual({
        id: "audioBitrate",
        labelKey: "settings.preset.audioBitrateLabel",
        valueKey: "export.setup.audioBitrateLossless",
      });
      expect(
        rowOf(
          presentPresetSummary(defaultBitratePreset, formatter, null),
          "audioBitrate",
        ),
      ).toEqual({
        id: "audioBitrate",
        labelKey: "settings.preset.audioBitrateLabel",
        valueKey: "settings.preset.audioBitrateDefault",
      });
    });

    it("names the value of the open source beside each 'Same as Source'", () => {
      const summary = presentPresetSummary(createPreset(), formatter, createSource());

      expect(rowOf(summary, "resolution")).toEqual({
        id: "resolution",
        labelKey: "settings.preset.resolutionLabel",
        valueKey: "export.setup.sourceResolution",
        valueValues: { width: "1920", height: "1080" },
      });
      expect(rowOf(summary, "frameRate")).toEqual({
        id: "frameRate",
        labelKey: "settings.preset.frameRateLabel",
        valueKey: "export.setup.sourceFrameRate",
        valueValues: { value: "29.97" },
      });
      expect(rowOf(summary, "audioSampleRate")).toEqual({
        id: "audioSampleRate",
        labelKey: "settings.preset.audioSampleRateLabel",
        valueKey: "export.setup.sourceSampleRate",
        valueValues: { value: "48" },
      });
      expect(rowOf(summary, "audioChannels")).toEqual({
        id: "audioChannels",
        labelKey: "settings.preset.audioChannelsLabel",
        valueKey: "export.setup.sourceChannels",
        valueValues: { count: 2 },
      });
    });

    it("keeps the frame size in plain digits and formats the rates for the locale", () => {
      const german = new Intl.NumberFormat("de");
      const summary = presentPresetSummary(
        createPreset(),
        german,
        createSource({
          width: 3840,
          height: 2160,
          audio: { index: 1, codec: "aac", sampleRate: 44100, channels: 6 },
        }),
      );
      expect(rowOf(summary, "resolution")?.valueValues).toEqual({
        width: "3840",
        height: "2160",
      });
      expect(rowOf(summary, "frameRate")?.valueValues).toEqual({ value: "29,97" });
      expect(rowOf(summary, "audioSampleRate")?.valueValues).toEqual({ value: "44,1" });
      expect(rowOf(summary, "audioChannels")?.valueValues).toEqual({ count: 6 });
    });

    it("takes the source frame rate that the export uses: avg_frame_rate, then r_frame_rate", () => {
      const fromReal = presentPresetSummary(
        createPreset(),
        formatter,
        createSource({ avgFrameRate: null, rFrameRate: { n: 25, d: 1 } }),
      );
      expect(rowOf(fromReal, "frameRate")?.valueValues).toEqual({ value: "25" });

      const fromAverage = presentPresetSummary(
        createPreset(),
        formatter,
        createSource({
          avgFrameRate: { n: 24000, d: 1001 },
          rFrameRate: { n: 24, d: 1 },
        }),
      );
      expect(rowOf(fromAverage, "frameRate")?.valueValues).toEqual({ value: "23.976" });
    });

    it("shows only 'Same as Source' for a value that the probe does not state", () => {
      const summary = presentPresetSummary(
        createPreset(),
        formatter,
        createSource({
          avgFrameRate: null,
          rFrameRate: { n: 0, d: 1 },
          audio: { index: 1, codec: null, sampleRate: null, channels: null },
        }),
      );
      for (const id of ["frameRate", "audioSampleRate", "audioChannels"]) {
        expect(rowOf(summary, id)?.valueKey).toBe("settings.preset.sourceOption");
        expect(rowOf(summary, id)?.valueValues).toBeUndefined();
      }
      expect(rowOf(summary, "resolution")?.valueKey).toBe(
        "export.setup.sourceResolution",
      );
    });

    it("shows only 'Same as Source' with no open source", () => {
      const summary = presentPresetSummary(createPreset(), formatter, null);
      for (const id of [
        "resolution",
        "frameRate",
        "audioSampleRate",
        "audioChannels",
      ]) {
        expect(rowOf(summary, id)).toEqual(
          expect.objectContaining({ valueKey: "settings.preset.sourceOption" }),
        );
        expect(rowOf(summary, id)?.valueValues).toBeUndefined();
      }
    });

    it("shows a note in place of the audio rows when the source has no audio", () => {
      const summary = presentPresetSummary(
        createPreset(),
        formatter,
        createSource({ audio: null }),
      );
      expect(summary.groups[1]).toEqual({
        id: "audio",
        headingKey: "settings.preset.groupAudio",
        rows: [],
        noteKey: "export.setup.noSourceAudio",
      });
      expect(summary.groups[0].rows).toHaveLength(4);
    });

    it("formats 44.1 kHz sample rate correctly", () => {
      const preset = createPreset({ audioSampleRate: 44100 });
      expect(
        rowOf(presentPresetSummary(preset, formatter, null), "audioSampleRate"),
      ).toEqual({
        id: "audioSampleRate",
        labelKey: "settings.preset.audioSampleRateLabel",
        valueKey: "settings.preset.audioSampleRateValue",
        valueValues: { value: "44.1" },
      });
    });

    it("handles mono channel option", () => {
      const preset = createPreset({ audioChannels: "mono" });
      expect(
        rowOf(presentPresetSummary(preset, formatter, createSource()), "audioChannels"),
      ).toEqual({
        id: "audioChannels",
        labelKey: "settings.preset.audioChannelsLabel",
        valueKey: "settings.preset.audioChannelsMono",
      });
    });
  });

  describe("activeSourceDurationTicks", () => {
    function segment(
      id: string,
      sourceId: string,
      inPts: bigint,
      outPts: bigint,
    ): Segment {
      return {
        id,
        sourceId,
        inPts: String(inPts) as Pts,
        outPts: String(outPts) as Pts,
      };
    }

    it("adds the tick lengths of the segments of the active source only", () => {
      const segments = [
        segment("a", "s1", 90_000n, 990_900n),
        segment("b", "s2", 0n, 5_000_000n),
        segment("c", "s1", 2_000_000n, 2_900_900n),
      ];
      expect(activeSourceDurationTicks(segments, "s1")).toBe(1_801_800n);
      expect(activeSourceDurationTicks(segments, "s2")).toBe(5_000_000n);
    });

    it("counts from any start PTS, a negative one too", () => {
      expect(
        activeSourceDurationTicks([segment("a", "s1", -3_003n, 3_003n)], "s1"),
      ).toBe(6_006n);
    });

    it("keeps the sum exact beyond the safe integer range", () => {
      const big = 2n ** 61n;
      expect(
        activeSourceDurationTicks(
          [segment("a", "s1", 0n, big), segment("b", "s1", big, 2n * big)],
          "s1",
        ),
      ).toBe(2n * big);
    });

    it("returns 0 with no segment of the active source, or no active source", () => {
      const segments = [segment("a", "s1", 0n, 10n)];
      expect(activeSourceDurationTicks([], "s1")).toBe(0n);
      expect(activeSourceDurationTicks(segments, "s2")).toBe(0n);
      expect(activeSourceDurationTicks(segments, null)).toBe(0n);
    });

    it("returns null for a segment of the active source with no valid range", () => {
      const valid = segment("a", "s1", 0n, 10n);
      expect(
        activeSourceDurationTicks([valid, segment("b", "s1", 20n, 20n)], "s1"),
      ).toBe(null);
      expect(
        activeSourceDurationTicks([valid, segment("b", "s1", 30n, 20n)], "s1"),
      ).toBe(null);
      expect(
        activeSourceDurationTicks(
          [valid, { id: "b", sourceId: "s1", inPts: "01" as Pts, outPts: "20" as Pts }],
          "s1",
        ),
      ).toBeNull();
      // A broken segment of another source does not hide the duration of this one.
      expect(
        activeSourceDurationTicks([valid, segment("b", "s2", 30n, 20n)], "s1"),
      ).toBe(10n);
    });

    it("gives the estimate from the segments, in ticks and not in the frames of the display", () => {
      // Two segments of 300 frames at 30000/1001 fps in a 1/90000 time base: 3003 ticks per
      // frame, 900,900 ticks per segment, 20.02 s in total. The frame display counts 600.
      const segments = [
        segment("a", "s1", 90_000n, 990_900n),
        segment("b", "s2", 0n, 5_000_000n),
        segment("c", "s1", 2_000_000n, 2_900_900n),
      ];
      const videoTimeBase: Rational = { n: 1, d: 90000 };
      const input: ExportSizeInput = {
        preset: {
          quality: { kind: "bitrate", value: 8000 },
          audioEncoder: "aac",
          audioBitrate: 320,
        },
        hasAudio: true,
        durationTicks: activeSourceDurationTicks(segments, "s1"),
        videoTimeBase,
      };
      const bytes = estimateExportBytes(input);
      // 8320 kbps × 1000 / 8 × 20.02 s = 20,820,800 bytes.
      expect(bytes).not.toBeNull();
      expect(bytes!.num).toBe(20_820_800n * bytes!.den);
      expect(presentSizeEstimate(input, formatter)).toEqual({
        key: "export.setup.estimatedSize",
        values: { size: "21 MB" },
      });
    });
  });

  describe("estimateExportBytes", () => {
    const ms: Rational = { n: 1, d: 1000 };

    function sizeInput(overrides: Partial<ExportSizeInput> = {}): ExportSizeInput {
      return {
        preset: {
          quality: { kind: "bitrate", value: 8000 },
          audioEncoder: "aac",
          audioBitrate: 320,
        },
        hasAudio: true,
        // 10 s.
        durationTicks: 10_000n,
        videoTimeBase: ms,
        ...overrides,
      };
    }

    /** The exact value of an estimate, which must be a whole number of bytes here. */
    function wholeBytes(bytes: ExactBytes | null): bigint | null {
      if (bytes === null) {
        return null;
      }
      expect(bytes.num % bytes.den).toBe(0n);
      return bytes.num / bytes.den;
    }

    it("multiplies the video and the audio bitrate by the duration", () => {
      // (8000 + 320) kbps × 1000 / 8 × 10 s
      expect(wholeBytes(estimateExportBytes(sizeInput()))).toBe(10_400_000n);
    });

    it("adds no audio when the source has no audio stream", () => {
      expect(wholeBytes(estimateExportBytes(sizeInput({ hasAudio: false })))).toBe(
        10_000_000n,
      );
      // With no audio stream, the audio settings of the preset do not matter.
      expect(
        wholeBytes(
          estimateExportBytes(
            sizeInput({
              hasAudio: false,
              preset: {
                quality: { kind: "bitrate", value: 8000 },
                audioEncoder: "flac",
              },
            }),
          ),
        ),
      ).toBe(10_000_000n);
    });

    it("keeps the duration exact in a time base that is not a whole fraction of a second", () => {
      // 1001 frames at 30000/1001 fps in a 1/90000 time base: 3003 ticks each, 33.4 s.
      const bytes = estimateExportBytes(
        sizeInput({
          preset: {
            quality: { kind: "bitrate", value: 1 },
            audioEncoder: "aac",
            audioBitrate: 1,
          },
          durationTicks: 1001n * 3003n,
          videoTimeBase: { n: 1, d: 90000 },
        }),
      );
      // 2 kbps × 1000 / 8 × 3006003 / 90000 s = 8350.00833... bytes, as an exact fraction.
      expect(bytes).not.toBeNull();
      expect(bytes!.num * 90000n * 8n).toBe(2000n * 3006003n * bytes!.den);
    });

    it("stays exact beyond the safe integer range", () => {
      const ticks = 2n ** 60n;
      const bytes = estimateExportBytes(sizeInput({ durationTicks: ticks }));
      expect(bytes).not.toBeNull();
      expect(bytes!.num * 8n * 1000n).toBe(8320n * 1000n * ticks * bytes!.den);
    });

    it("gives no estimate for a CRF or a quality scale", () => {
      for (const kind of ["crf", "qualityScale"] as const) {
        expect(
          estimateExportBytes(
            sizeInput({
              preset: {
                quality: { kind, value: 20 },
                audioEncoder: "aac",
                audioBitrate: 320,
              },
            }),
          ),
        ).toBeNull();
      }
    });

    it("gives no estimate when the audio bitrate of a source with audio is not known", () => {
      expect(
        estimateExportBytes(
          sizeInput({
            preset: { quality: { kind: "bitrate", value: 8000 }, audioEncoder: "aac" },
          }),
        ),
      ).toBeNull();
      for (const audioEncoder of ["flac", "alac"]) {
        expect(
          estimateExportBytes(
            sizeInput({
              preset: {
                quality: { kind: "bitrate", value: 8000 },
                audioEncoder,
                audioBitrate: 320,
              },
            }),
          ),
        ).toBeNull();
      }
    });

    it("gives no estimate for a bitrate of 0 kbps", () => {
      expect(
        estimateExportBytes(
          sizeInput({
            preset: {
              quality: { kind: "bitrate", value: 0 },
              audioEncoder: "aac",
              audioBitrate: 320,
            },
          }),
        ),
      ).toBeNull();
      expect(
        estimateExportBytes(
          sizeInput({
            preset: {
              quality: { kind: "bitrate", value: 8000 },
              audioEncoder: "aac",
              audioBitrate: 0,
            },
          }),
        ),
      ).toBeNull();
    });

    it("gives no estimate when the duration or the time base is not known", () => {
      expect(estimateExportBytes(sizeInput({ durationTicks: null }))).toBeNull();
      expect(estimateExportBytes(sizeInput({ durationTicks: 0n }))).toBeNull();
      expect(estimateExportBytes(sizeInput({ durationTicks: -1n }))).toBeNull();
      expect(estimateExportBytes(sizeInput({ videoTimeBase: null }))).toBeNull();
      expect(
        estimateExportBytes(sizeInput({ videoTimeBase: { n: 0, d: 1 } })),
      ).toBeNull();
    });
  });

  describe("roundToSignificantDigits", () => {
    it.each([
      [10_400_000n, 1n, 10n, 6],
      [125n, 1n, 13n, 1],
      [124n, 1n, 12n, 1],
      [1n, 8n, 13n, -2],
      [1n, 3n, 33n, -2],
      [5n, 1n, 50n, -1],
      [99n, 10n, 99n, -1],
      [100n, 10n, 10n, 0],
      [996n, 100n, 10n, 0],
      [999_600_000n, 1n, 10n, 8],
    ])("rounds %s / %s to %s × 10^%s", (num, den, mantissa, exponent) => {
      expect(roundToSignificantDigits(num, den, 2)).toEqual({ mantissa, exponent });
    });

    it("rounds to any count of digits", () => {
      expect(roundToSignificantDigits(123_456n, 1n, 1)).toEqual({
        mantissa: 1n,
        exponent: 5,
      });
      expect(roundToSignificantDigits(123_456n, 1n, 4)).toEqual({
        mantissa: 1235n,
        exponent: 2,
      });
    });

    it("returns null for a value that is not positive or a count below 1", () => {
      expect(roundToSignificantDigits(0n, 1n, 2)).toBeNull();
      expect(roundToSignificantDigits(-5n, 1n, 2)).toBeNull();
      expect(roundToSignificantDigits(5n, 0n, 2)).toBeNull();
      expect(roundToSignificantDigits(5n, 1n, 0)).toBeNull();
    });
  });

  describe("formatEstimatedSize", () => {
    const bytes = (num: bigint, den = 1n): ExactBytes => ({ num, den });

    it.each([
      [10_400_000n, "10 MB"],
      [125_000_000n, "130 MB"],
      [994_000_000n, "990 MB"],
      // The rounding boundary between MB and GB: 99.5 × 10^7 rounds up to 1.0 × 10^9.
      [994_999_999n, "990 MB"],
      [995_000_000n, "1 GB"],
      [999_600_000n, "1 GB"],
      [1_000n, "1 kB"],
      [1_234_567_890n, "1.2 GB"],
      [130_000n, "130 kB"],
      [999_000n, "1 MB"],
      [1_500_000_000_000n, "1.5 TB"],
      [2_500_000_000_000_000n, "2,500 TB"],
    ])("formats %s bytes as %s", (value, text) => {
      expect(formatEstimatedSize(bytes(value), "en")).toBe(text);
    });

    it("formats no value below 1 kB, which has a message of its own", () => {
      expect(formatEstimatedSize(bytes(125n), "en")).toBeNull();
      expect(formatEstimatedSize(bytes(999n), "en")).toBeNull();
      // 999.6 bytes would round to 1.0 kB, but the value is below 1 kB.
      expect(formatEstimatedSize(bytes(9_996n, 10n), "en")).toBeNull();
    });

    it("compares a value with 1 kB exactly", () => {
      expect(isBelowOneKilobyte(bytes(999n))).toBe(true);
      expect(isBelowOneKilobyte(bytes(9_999n, 10n))).toBe(true);
      expect(isBelowOneKilobyte(bytes(1_000n))).toBe(false);
      expect(isBelowOneKilobyte(bytes(8_000n, 8n))).toBe(false);
    });

    it("uses the number format of the locale", () => {
      expect(formatEstimatedSize(bytes(1_234_567_890n), "zh-CN")).toBe("1.2 GB");
      // German puts a no-break space between the number and the unit.
      expect(formatEstimatedSize(bytes(1_234_567_890n), "de")).toBe("1,2 GB");
    });

    it("returns null for a value that is not positive", () => {
      expect(formatEstimatedSize(bytes(0n), "en")).toBeNull();
    });
  });

  describe("presentSizeEstimate", () => {
    const input: ExportSizeInput = {
      preset: {
        quality: { kind: "bitrate", value: 12_000 },
        audioEncoder: "aac",
        audioBitrate: 320,
      },
      hasAudio: true,
      // 83.48 s.
      durationTicks: 83_480n,
      videoTimeBase: { n: 1, d: 1000 },
    };

    it("gives the rounded size for a preset in bitrate mode", () => {
      // 12320 kbps × 1000 / 8 × 83.48 s = 128,559,200 bytes.
      expect(presentSizeEstimate(input, formatter)).toEqual({
        key: "export.setup.estimatedSize",
        values: { size: "130 MB" },
      });
    });

    it("says 'less than 1 kB' for an estimate below 1 kB", () => {
      // 2 kbps × 1000 / 8 × 1/90000 s: 1 tick, about 0.0028 bytes.
      const tiny: ExportSizeInput = {
        preset: {
          quality: { kind: "bitrate", value: 1 },
          audioEncoder: "aac",
          audioBitrate: 1,
        },
        hasAudio: true,
        durationTicks: 1n,
        videoTimeBase: { n: 1, d: 90000 },
      };
      expect(presentSizeEstimate(tiny, formatter)).toEqual({
        key: "export.setup.estimatedSizeBelowOneKilobyte",
      });
      // 2 kbps × 1000 / 8 × 4 s = 1000 bytes, exactly 1 kB.
      expect(
        presentSizeEstimate(
          { ...tiny, durationTicks: 4n, videoTimeBase: { n: 1, d: 1 } },
          formatter,
        ),
      ).toEqual({ key: "export.setup.estimatedSize", values: { size: "1 kB" } });
    });

    it("gives nothing for a preset with no estimate", () => {
      expect(
        presentSizeEstimate(
          {
            ...input,
            preset: { ...input.preset, quality: { kind: "crf", value: 20 } },
          },
          formatter,
        ),
      ).toBeNull();
    });
  });

  describe("the summary keys", () => {
    it("name a message in both catalogs", () => {
      for (const key of [
        "export.setup.sourceResolution",
        "export.setup.sourceFrameRate",
        "export.setup.sourceSampleRate",
        "export.setup.noSourceAudio",
        "export.setup.estimatedSizeBelowOneKilobyte",
        "export.setup.estimatedSize",
        "settings.preset.groupVideo",
        "settings.preset.groupAudio",
      ]) {
        expect(typeof lookup(en, key)).toBe("string");
        expect(typeof lookup(zhCN, key)).toBe("string");
      }
    });

    it("give the counted messages the plural forms of each language", () => {
      for (const [base, placeholders] of [
        ["export.setup.summary", ["{{count}}", "{{fileName}}", "{{duration}}"]],
        ["export.setup.sourceChannels", ["{{count}}"]],
      ] as const) {
        expect(typeof lookup(en, `${base}_one`)).toBe("string");
        // Chinese uses the `other` category alone.
        expect(lookup(zhCN, `${base}_one`)).toBeUndefined();
        for (const message of [
          lookup(en, `${base}_one`),
          lookup(en, `${base}_other`),
          lookup(zhCN, `${base}_other`),
        ]) {
          for (const placeholder of placeholders) {
            expect(message).toContain(placeholder);
          }
        }
      }
    });

    it("label the estimate as approximate", () => {
      expect(en.export.setup.estimatedSize).toContain("about {{size}}");
      expect(zhCN.export.setup.estimatedSize).toContain("约 {{size}}");
    });
  });

  describe("presentSetupBlocker", () => {
    it("returns export.setup.noPresets when preset is null", () => {
      expect(presentSetupBlocker(null)).toEqual({
        key: "export.setup.noPresets",
      });
    });

    it("returns containerMismatch issue values when mov is paired with flac or libopus", () => {
      const movFlac = createPreset({ container: "mov", audioEncoder: "flac" });
      const movOpus = createPreset({ container: "mov", audioEncoder: "libopus" });

      expect(presentSetupBlocker(movFlac)).toEqual({
        key: "settings.field.containerMismatch",
        values: {
          container: "MOV",
          encoder: "flac",
        },
      });

      expect(presentSetupBlocker(movOpus)).toEqual({
        key: "settings.field.containerMismatch",
        values: {
          container: "MOV",
          encoder: "libopus",
        },
      });
    });

    it("pins uppercase container name MOV in containerMismatch blocker values", () => {
      const movFlac = createPreset({ container: "mov", audioEncoder: "flac" });
      const blocker = presentSetupBlocker(movFlac);

      expect(blocker?.values?.container).toBe("MOV");
    });

    it("returns null for compatible container and audio encoder combinations", () => {
      expect(
        presentSetupBlocker(createPreset({ container: "mp4", audioEncoder: "aac" })),
      ).toBeNull();
      expect(
        presentSetupBlocker(createPreset({ container: "mov", audioEncoder: "aac" })),
      ).toBeNull();
      expect(
        presentSetupBlocker(createPreset({ container: "mkv", audioEncoder: "flac" })),
      ).toBeNull();
    });
  });

  describe("resolveExportSetupStepState", () => {
    it("returns loading when settings is null and status is loading", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "loading",
        }),
      ).toBe("loading");
    });

    it("returns loading when settings is null and status is idle", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "idle",
        }),
      ).toBe("loading");
    });

    it("returns error when settings is null and status is error", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "error",
          error: new SettingsError({ code: "invalidSettings" }),
        }),
      ).toBe("error");
    });

    it("returns error when settings is null and error is present regardless of status", () => {
      expect(
        resolveExportSetupStepState({
          settings: null,
          status: "idle",
          error: new SettingsError({ code: "readFailed" }),
        }),
      ).toBe("error");
    });

    it("returns empty when settings is loaded but presets are empty", () => {
      expect(
        resolveExportSetupStepState({
          settings: createSettings([]),
          status: "ready",
        }),
      ).toBe("empty");
    });

    it("returns ready when settings is loaded and presets has items", () => {
      expect(
        resolveExportSetupStepState({
          settings: createSettings([createPreset()]),
          status: "ready",
        }),
      ).toBe("ready");
    });
  });

  describe("presentSetupSettingsSection", () => {
    it("opens the Presets section when the library holds no preset", () => {
      expect(presentSetupSettingsSection("empty")).toBe("presets");
    });

    it("opens the Presets section when the settings file did not load", () => {
      expect(presentSetupSettingsSection("error")).toBe("presets");
    });

    it("offers no section while the settings load or when a preset can be chosen", () => {
      expect(presentSetupSettingsSection("loading")).toBeNull();
      expect(presentSetupSettingsSection("ready")).toBeNull();
    });
  });

  describe("presentPresetOptions", () => {
    // Every encoder that the presets below name works, except the one hardware encoder.
    const probe: Pick<FfmpegState, "status" | "results"> = {
      status: "ready",
      results: [
        { name: "libx264", kind: "video", listed: true, status: "works" },
        { name: "libx265", kind: "video", listed: true, status: "works" },
        { name: "aac", kind: "audio", listed: true, status: "works" },
        { name: "h264_nvenc", kind: "video", listed: false, status: "notListed" },
      ],
    };
    const h264 = createPreset({ id: "h264", name: "H.264 MP4" });
    const hevc = createPreset({
      id: "hevc",
      name: "HEVC MKV",
      container: "mkv",
      videoEncoder: "libx265",
      quality: { kind: "bitrate", value: 8000 },
    });
    const nvenc = createPreset({
      id: "nvenc",
      name: "NVENC",
      videoEncoder: "h264_nvenc",
      quality: { kind: "qualityScale", value: 5 },
    });

    it("lists every preset in library order, with its stored name", () => {
      const options = presentPresetOptions(
        createSettings([nvenc, h264, hevc], "h264"),
        probe,
        formatter,
      );
      expect(options.map((option) => [option.id, option.name])).toStrictEqual([
        ["nvenc", "NVENC"],
        ["h264", "H.264 MP4"],
        ["hevc", "HEVC MKV"],
      ]);
    });

    it("marks the default preset, and only that preset", () => {
      const options = presentPresetOptions(
        createSettings([h264, hevc, nvenc], "hevc"),
        probe,
        formatter,
      );
      expect(options.map((option) => option.isDefault)).toStrictEqual([
        false,
        true,
        false,
      ]);
    });

    // The step then selects the first preset (`resolveSetupPresetId`), but that preset is not
    // the default preset, so it carries no badge. The preset list shows no badge either.
    it.each([
      ["names no preset", "gone"],
      ["is unset", undefined],
    ])("marks no preset when the default id %s", (_label, activePresetId) => {
      const settings = createSettings([h264, hevc], activePresetId);
      expect(resolveSetupPresetId(settings, null)).toBe("h264");
      const options = presentPresetOptions(settings, probe, formatter);
      expect(options.some((option) => option.isDefault)).toBe(false);
    });

    it("gives each item the summary line of the preset list row", () => {
      const options = presentPresetOptions(
        createSettings([h264, hevc, nvenc], "h264"),
        probe,
        formatter,
      );
      expect(options.map((option) => option.summary)).toStrictEqual(
        [h264, hevc, nvenc].map((preset) => presentPresetRowSummary(preset, formatter)),
      );
      expect(options[1]?.summary).toStrictEqual({
        key: "settings.preset.rowSummaryBitrate",
        values: { container: "MKV", encoder: "libx265", value: "8,000" },
      });
    });

    it("gives each item the encoder mark of the preset list row", () => {
      const options = presentPresetOptions(
        createSettings([h264, nvenc], "h264"),
        probe,
        formatter,
      );
      expect(options[0]?.encoderMark).toBeNull();
      expect(options[1]?.encoderMark).toStrictEqual(
        presentPresetEncoderMark(probe, nvenc),
      );
      expect(options[1]?.encoderMark).toMatchObject({
        encoderName: "h264_nvenc",
        availability: "unavailable",
        tone: "warning",
      });
    });

    it("lists no item for an empty library", () => {
      expect(presentPresetOptions(createSettings([]), probe, formatter)).toStrictEqual(
        [],
      );
    });

    it("names only keys that both catalogs define", () => {
      const options = presentPresetOptions(
        createSettings([h264, hevc, nvenc], "h264"),
        probe,
        formatter,
      );
      const keys = options.flatMap((option) => [
        option.summary.key,
        ...(option.encoderMark
          ? [
              option.encoderMark.badgeKey,
              option.encoderMark.titleKey,
              option.encoderMark.reasonKey,
            ]
          : []),
      ]);
      for (const key of [
        ...keys,
        "settings.preset.defaultBadge",
        "export.action.managePresets",
      ]) {
        expect(typeof lookup(en, key)).toBe("string");
        expect(typeof lookup(zhCN, key)).toBe("string");
      }
    });
  });
});
