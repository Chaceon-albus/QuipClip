/**
 * Pure presenter for the stream switches of the export setup step (ADR 036).
 *
 * The preset summary of the step has a Video group and an Audio group. A switch at the end of
 * each heading chooses whether the export writes that stream. This module presents the two
 * switches and applies the choice to the summary: the Container row names the file that the
 * export writes, and a group whose stream the export does not write shows one line in place
 * of its rows. Pure module with no React dependencies.
 */

import { presentContainer } from "@/components/settings/presetPresenter";
import {
  exportOutputExtension,
  resolveExportStreams,
  sourceHasAudio,
  type ExportStreamChoice,
  type ExportStreamKind,
} from "@/features/export/streamChoice";
import type { ExportStreams } from "@/features/export/types";
import type { MediaProbe } from "@/features/media";
import type { PresetContainer } from "@/features/settings/types";
import type {
  PresetSummaryGroupView,
  PresetSummaryRowView,
  PresetSummaryView,
} from "./exportSetupPresenter";

/** The reason that a switch cannot change, as the key of its tooltip. */
export type StreamSwitchLockKey =
  | "export.setup.keepOneStream"
  | "export.setup.sourceHasNoAudio"
  | "export.setup.videoRequired";

/** One switch at the end of a group heading of the preset summary. */
export type StreamSwitchView = {
  readonly kind: ExportStreamKind;
  /** True when the export writes the stream. */
  readonly checked: boolean;
  /** The accessible name of the switch. */
  readonly labelKey: "export.setup.exportVideo" | "export.setup.exportAudio";
  /**
   * Why the switch cannot change, or null when the user can switch it. A locked switch
   * carries `aria-disabled` and not `disabled`, so it keeps the focus and its tooltip, which
   * shows this text. It ignores a toggle.
   */
  readonly lockKey: StreamSwitchLockKey | null;
};

/** The switch of each group of the preset summary. */
export type StreamSwitchesView = Readonly<Record<ExportStreamKind, StreamSwitchView>>;

/**
 * Presents the two switches for the choice of the user and the source.
 *
 * Each switch shows the streams that the export writes (`resolveExportStreams`), so the
 * switches never claim a stream that the export does not write.
 *
 * - The last switch that is on is locked, with `keepOneStream`: the export writes at least
 *   one stream.
 * - With a source that has no audio stream, the audio switch is off and locked, with
 *   `sourceHasNoAudio`. The video switch is then locked with `videoRequired`, which names the
 *   missing audio, because "at least the video or the audio" would offer a choice that the
 *   source does not have.
 *
 * @param choice The switches as the user set them.
 * @param source The probe of the open source, or null with no source. With no source, the
 *   audio is not known to be missing.
 */
export function presentStreamSwitches(
  choice: ExportStreamChoice,
  source: Pick<MediaProbe, "audio"> | null,
): StreamSwitchesView {
  const hasAudio = sourceHasAudio(source);
  const streams = resolveExportStreams(choice, hasAudio);
  const video = streams !== "audioOnly";
  const audio = streams !== "videoOnly";
  let audioLockKey: StreamSwitchLockKey | null = null;
  if (!hasAudio) {
    audioLockKey = "export.setup.sourceHasNoAudio";
  } else if (!video) {
    audioLockKey = "export.setup.keepOneStream";
  }
  return {
    video: {
      kind: "video",
      checked: video,
      labelKey: "export.setup.exportVideo",
      lockKey: !hasAudio
        ? "export.setup.videoRequired"
        : audio
          ? null
          : "export.setup.keepOneStream",
    },
    audio: {
      kind: "audio",
      checked: audio,
      labelKey: "export.setup.exportAudio",
      lockKey: audioLockKey,
    },
  };
}

/**
 * The Container row of an audio-only export: the extension of the file and the name of its
 * format, ".m4a (MP4)" for an MP4 or a MOV preset and ".mka (MKV)" for an MKV preset (ADR
 * 036), with the container names that the rest of the summary uses. Both are technical
 * identifiers, passed through untranslated.
 */
function presentAudioOnlyContainerRow(
  row: PresetSummaryRowView,
  container: PresetContainer,
): PresetSummaryRowView {
  return {
    ...row,
    valueKey: "export.setup.audioOnlyContainer",
    valueValues: {
      extension: `.${exportOutputExtension(container, "audioOnly")}`,
      format: presentContainer(container === "mkv" ? "mkv" : "mp4"),
    },
  };
}

/** True when the export writes the stream of the group. */
function writesGroup(
  id: PresetSummaryGroupView["id"],
  streams: ExportStreams,
): boolean {
  return id === "video" ? streams !== "audioOnly" : streams !== "videoOnly";
}

/**
 * The group of a stream that the export does not write: one muted line in place of its rows.
 * A group that already shows a note keeps it. That is the note of a source with no audio,
 * which also says why the export writes no audio.
 */
function presentUnexportedGroup(group: PresetSummaryGroupView): PresetSummaryGroupView {
  if (group.rows.length === 0 && group.noteKey !== undefined) {
    return group;
  }
  return { ...group, rows: [], noteKey: "export.setup.notExported" };
}

/**
 * Applies the streams that the export writes to the preset summary of
 * `presentPresetSummary`.
 *
 * - The Container row names the output: the container of the preset, or for an audio-only
 *   export the extension and the format of the audio file.
 * - A group whose stream the export does not write shows "Not exported" in place of its rows.
 *
 * @param summary The summary of the selected preset.
 * @param container The container of the selected preset.
 * @param streams The streams that the export writes (`resolveExportStreams`).
 */
export function presentStreamSummary(
  summary: PresetSummaryView,
  container: PresetContainer,
  streams: ExportStreams,
): PresetSummaryView {
  return {
    container:
      streams === "audioOnly"
        ? presentAudioOnlyContainerRow(summary.container, container)
        : summary.container,
    groups: summary.groups.map((group) =>
      writesGroup(group.id, streams) ? group : presentUnexportedGroup(group),
    ),
  };
}
