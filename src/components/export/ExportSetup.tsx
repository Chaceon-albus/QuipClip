import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Notice } from "@/components/common/Notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFfmpegStore } from "@/features/ffmpeg";
import { useSettingsStore } from "@/features/settings";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import { presentPresetEncoderMark } from "@/components/settings/presetPresenter";
import { presentSettingsError } from "@/components/settings/settingsErrorPresenter";
import type { Preset } from "@/features/settings/types";
import {
  presentPresetSummary,
  resolveExportSetupStepState,
  type SetupBlockerView,
} from "./exportSetupPresenter";

export interface ExportSetupProps {
  /** Identifier of the currently chosen preset, or null if no preset is available. */
  selectedPresetId: string | null;
  /** Currently selected preset, or null if absent. */
  selectedPreset: Preset | null;
  /** Active setup blocker, or null if export can proceed. */
  blocker: SetupBlockerView | null;
  /** Callback fired when the user selects a different preset from the dropdown. */
  onSelect: (presetId: string) => void;
}

/**
 * Presentational component for the export dialog setup step.
 *
 * Implements ADR 024:
 * - Allows choosing the preset before triggering the native save dialog.
 * - Displays non-blocking capability warnings for unavailable encoders.
 * - Shows blockers (missing presets, container-audio encoder mismatches) as alerts.
 * - Displays a compact two-column definition list summarizing preset parameters.
 */
export function ExportSetup({
  selectedPresetId,
  selectedPreset,
  blocker,
  onSelect,
}: ExportSetupProps) {
  const { t, i18n } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;

  const resolvedLanguage = getResolvedLanguage(i18n);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(resolvedLanguage),
    [resolvedLanguage],
  );

  // Read capability status with the same shallow selector as PresetLibrarySection
  const ffmpegState = useFfmpegStore(
    useShallow((state) => ({ status: state.status, results: state.results })),
  );

  const settings = useSettingsStore((state) => state.settings);
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);

  const stepState = resolveExportSetupStepState({ settings, status, error });

  if (stepState === "loading") {
    return (
      <div className="py-2 text-sm text-muted-foreground">{t("common.loading")}</div>
    );
  }

  if (stepState === "error") {
    const errorView = presentSettingsError(error);
    return (
      <div className="space-y-3 py-2">
        {errorView ? (
          <Notice tone="destructive" role="alert">
            {translate(errorView.key, errorView.values)}
          </Notice>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t("export.setup.settingsErrorHint")}
        </p>
      </div>
    );
  }

  if (stepState === "empty") {
    return (
      <div className="space-y-3 py-2">
        {blocker ? (
          <Notice tone="destructive" role="alert">
            <p>{translate(blocker.key, blocker.values)}</p>
          </Notice>
        ) : null}
      </div>
    );
  }

  const presets = settings?.presets ?? [];
  const encoderMark = selectedPreset
    ? presentPresetEncoderMark(ffmpegState, selectedPreset)
    : null;
  const summaryRows = selectedPreset
    ? presentPresetSummary(selectedPreset, numberFormatter)
    : [];

  return (
    <div className="space-y-4 py-2">
      {/* Preset Selector */}
      <div className="space-y-1.5">
        <label
          htmlFor="export-preset-select"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("export.setup.presetLabel")}
        </label>
        <Select value={selectedPresetId ?? undefined} onValueChange={onSelect}>
          <SelectTrigger id="export-preset-select" className="w-full">
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

      {/* Preset summary definition list */}
      {selectedPreset ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {summaryRows.map((row) => (
            <Fragment key={row.id}>
              <dt className="text-muted-foreground">{translate(row.labelKey)}</dt>
              <dd>{translate(row.valueKey, row.valueValues)}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
