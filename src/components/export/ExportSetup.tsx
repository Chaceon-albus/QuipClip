import { Fragment, useCallback, useId, useMemo, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFfmpegStore } from "@/features/ffmpeg";
import { useMediaStore } from "@/features/media";
import { resolveTimecodeDisplay } from "@/features/playback";
import { useSettingsStore, type SettingsSection } from "@/features/settings";
import { useTimecodePreference } from "@/features/settings/timecodePreference";
import {
  selectActiveSourceSegmentCount,
  totalActiveSourceSegments,
  useTimelineStore,
  type TimelineStoreState,
} from "@/features/timeline";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import { presentPresetEncoderMark } from "@/components/settings/presetPresenter";
import { presentSettingsError } from "@/components/settings/settingsErrorPresenter";
import type { Preset } from "@/features/settings/types";
import {
  activeSourceDurationTicks,
  presentExportSummarySentence,
  presentPresetSummary,
  presentSetupSettingsSection,
  presentSizeEstimate,
  resolveExportSetupStepState,
  type ExportSummarySentenceView,
  type PresetSummaryGroupView,
  type PresetSummaryRowView,
  type SetupBlockerView,
} from "./exportSetupPresenter";

// One bigint or null, which compare by value, so the step renders again only when the exact
// duration changes.
const selectActiveSourceDurationTicks = (state: TimelineStoreState) =>
  activeSourceDurationTicks(state.segments, state.sourceId);

type Translate = (key: string, options?: Record<string, string | number>) => string;

/**
 * The first line of the step: what the export writes, and how long it is.
 *
 * A shortened file name shows the whole name in its tooltip. The tooltip reaches only a
 * mouse, so assistive technology reads a second, visually hidden copy of the whole sentence
 * with the whole name, and not the shortened copy. Both copies are the one catalog message.
 */
function SummarySentence({
  view,
  translate,
}: {
  view: ExportSummarySentenceView;
  translate: Translate;
}) {
  const sentence = (fileName: string) =>
    translate(view.key, { count: view.count, fileName, duration: view.duration });
  if (!view.shortened) {
    return <p className="text-sm text-foreground">{sentence(view.fileName)}</p>;
  }
  return (
    <p className="text-sm text-foreground">
      <span aria-hidden="true" title={view.title}>
        {sentence(view.fileName)}
      </span>
      <span className="sr-only">{sentence(view.fullFileName)}</span>
    </p>
  );
}

/**
 * The rows of one part of the preset summary. Every list has the same label column, so the
 * values of the container row and of both groups start at one edge.
 */
function SummaryRows({
  rows,
  translate,
}: {
  rows: readonly PresetSummaryRowView[];
  translate: Translate;
}) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map((row) => (
        <Fragment key={row.id}>
          <dt className="text-muted-foreground">{translate(row.labelKey)}</dt>
          {/* An encoder name is free text of up to 64 characters with no space in it. */}
          <dd className="wrap-anywhere text-foreground">
            {translate(row.valueKey, row.valueValues)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** One group of the preset summary, named by its heading. */
function SummaryGroup({
  group,
  translate,
}: {
  group: PresetSummaryGroupView;
  translate: Translate;
}) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className="space-y-1">
      <h3 id={headingId} className="font-medium text-foreground">
        {translate(group.headingKey)}
      </h3>
      {group.rows.length > 0 ? (
        <SummaryRows rows={group.rows} translate={translate} />
      ) : null}
      {group.noteKey ? (
        <p className="text-muted-foreground">{translate(group.noteKey)}</p>
      ) : null}
    </div>
  );
}

export interface ExportSetupProps {
  /** Identifier of the currently chosen preset, or null if no preset is available. */
  selectedPresetId: string | null;
  /** Currently selected preset, or null if absent. */
  selectedPreset: Preset | null;
  /** Active setup blocker, or null if export can proceed. */
  blocker: SetupBlockerView | null;
  /** Callback fired when the user selects a different preset from the dropdown. */
  onSelect: (presetId: string) => void;
  /**
   * Opens the settings dialog at `section`. The export dialog closes first, so two modal
   * dialogs never show together.
   */
  onOpenSettings: (section: SettingsSection) => void;
  /**
   * Takes the first control of the step: the preset select, or Open Settings when no preset
   * can be listed. The dialog gives it the focus after Back.
   */
  firstControlRef?: Ref<HTMLButtonElement>;
}

/**
 * Presentational component for the export dialog setup step.
 *
 * Implements ADR 024:
 * - Allows choosing the preset before triggering the native save dialog.
 * - Displays non-blocking capability warnings for unavailable encoders.
 * - Shows a container-audio encoder mismatch as an alert.
 * - Shows an empty library as a neutral notice, because it is not an error, and a settings
 *   file that did not load as an alert. Both offer Open Settings.
 * - States the export in one sentence at the top: the segment count, the file name, and the
 *   total duration that the Export tooltip of the title bar also shows (ADR 028).
 * - Summarizes the preset under Video and Audio. A "Same as Source" value names the value of
 *   the open source.
 * - Estimates the output size when the preset sets a video bitrate.
 */
export function ExportSetup({
  selectedPresetId,
  selectedPreset,
  blocker,
  onSelect,
  onOpenSettings,
  firstControlRef,
}: ExportSetupProps) {
  const { t, i18n } = useTranslation();
  const translate = t as Translate;

  const resolvedLanguage = getResolvedLanguage(i18n);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(resolvedLanguage),
    [resolvedLanguage],
  );

  // The open source and its segments, read as the title bar reads them, so the sentence shows
  // the duration of the Export tooltip in the same timecode format (ADR 028).
  const media = useMediaStore((state) => state.media);
  const probe = media?.probe ?? null;
  const timecodePreference = useTimecodePreference((state) => state.format);
  const timecodeDisplay = useMemo(
    () => resolveTimecodeDisplay(timecodePreference, probe),
    [timecodePreference, probe],
  );
  const segmentCount = useTimelineStore(selectActiveSourceSegmentCount);
  // The total of the Export tooltip, for the sentence only. It is one bigint or null, which
  // compare by value, so the step renders again only when the total changes.
  const selectSegmentTotal = useCallback(
    (state: TimelineStoreState) =>
      totalActiveSourceSegments(state.segments, state.sourceId, probe, timecodeDisplay),
    [probe, timecodeDisplay],
  );
  const segmentTotal = useTimelineStore(selectSegmentTotal);
  // The size estimate reads the exact duration in ticks, never the display total.
  const durationTicks = useTimelineStore(selectActiveSourceDurationTicks);
  const summarySentence = presentExportSummarySentence({
    fileName: media?.fileName ?? null,
    segmentCount,
    segmentTotal,
    display: timecodeDisplay,
  });
  const sentence = summarySentence ? (
    <SummarySentence view={summarySentence} translate={translate} />
  ) : null;

  // Read capability status with the same shallow selector as PresetLibrarySection
  const ffmpegState = useFfmpegStore(
    useShallow((state) => ({ status: state.status, results: state.results })),
  );

  const settings = useSettingsStore((state) => state.settings);
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);

  const stepState = resolveExportSetupStepState({ settings, status, error });
  const settingsSection = presentSetupSettingsSection(stepState);
  const openSettingsButton =
    settingsSection !== null ? (
      <Button
        ref={firstControlRef}
        variant="outline"
        size="sm"
        onClick={() => {
          onOpenSettings(settingsSection);
        }}
      >
        {t("export.action.openSettings")}
      </Button>
    ) : null;

  // The sentence states the segments, which do not depend on the settings, so every state of
  // the step shows it first.
  if (stepState === "loading") {
    return (
      <div className="space-y-3 py-2">
        {sentence}
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  if (stepState === "error") {
    const errorView = presentSettingsError(error);
    return (
      <div className="space-y-3 py-2">
        {sentence}
        {errorView ? (
          <Notice tone="destructive" role="alert">
            {translate(errorView.key, errorView.values)}
          </Notice>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("export.setup.settingsErrorHint")}
        </p>
        {openSettingsButton}
      </div>
    );
  }

  // An empty library is a state the user can change, not an error, so the notice is
  // neutral. The button stays outside the notice, because the notice is a live region.
  if (stepState === "empty") {
    return (
      <div className="space-y-3 py-2">
        {sentence}
        <Notice tone="neutral" role="status">
          <p>{t("export.setup.noPresets")}</p>
        </Notice>
        {openSettingsButton}
      </div>
    );
  }

  const presets = settings?.presets ?? [];
  const encoderMark = selectedPreset
    ? presentPresetEncoderMark(ffmpegState, selectedPreset)
    : null;
  const summary = selectedPreset
    ? presentPresetSummary(selectedPreset, numberFormatter, probe)
    : null;
  const sizeEstimate =
    selectedPreset && probe
      ? presentSizeEstimate(
          {
            preset: selectedPreset,
            hasAudio: probe.audio !== null,
            durationTicks,
            videoTimeBase: probe.videoTimeBase,
          },
          numberFormatter,
        )
      : null;

  return (
    <div className="space-y-4 py-2">
      {sentence}

      {/* Preset Selector */}
      <div className="space-y-1.5">
        <label
          htmlFor="export-preset-select"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("export.setup.presetLabel")}
        </label>
        <Select value={selectedPresetId ?? undefined} onValueChange={onSelect}>
          <SelectTrigger
            ref={firstControlRef}
            id="export-preset-select"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Non-blocking encoder availability mark */}
      {encoderMark ? (
        <div className="flex items-start gap-2 text-xs">
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-2xs leading-none font-semibold",
              encoderMark.tone === "warning"
                ? "bg-warning/10 text-warning-text"
                : "bg-muted text-muted-foreground",
            )}
          >
            {translate(encoderMark.badgeKey)}
          </span>
          <div className="space-y-0.5">
            <p className="font-semibold">
              {translate(encoderMark.titleKey, encoderMark.titleValues)}
            </p>
            <p className="text-muted-foreground">{translate(encoderMark.reasonKey)}</p>
          </div>
        </div>
      ) : null}

      {/* Blocker alert if compatibility issue */}
      {blocker ? (
        <Notice tone="destructive" role="alert">
          <p>{translate(blocker.key, blocker.values)}</p>
        </Notice>
      ) : null}

      {/* Preset summary: the container, then the Video and the Audio groups */}
      {summary ? (
        <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
          <SummaryRows rows={[summary.container]} translate={translate} />
          {summary.groups.map((group) => (
            <SummaryGroup key={group.id} group={group} translate={translate} />
          ))}
        </div>
      ) : null}

      {sizeEstimate ? (
        <p className="text-xs text-muted-foreground">
          {translate(sizeEstimate.key, sizeEstimate.values)}
        </p>
      ) : null}
    </div>
  );
}
