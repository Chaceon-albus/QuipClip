import { Fragment, useMemo, type Ref } from "react";
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
import { useSettingsStore, type SettingsSection } from "@/features/settings";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import { presentPresetEncoderMark } from "@/components/settings/presetPresenter";
import { presentSettingsError } from "@/components/settings/settingsErrorPresenter";
import type { Preset } from "@/features/settings/types";
import {
  presentPresetSummary,
  presentSetupSettingsSection,
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
 * - Displays a compact two-column definition list summarizing preset parameters.
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
        {openSettingsButton}
      </div>
    );
  }

  // An empty library is a state the user can change, not an error, so the notice is
  // neutral. The button stays outside the notice, because the notice is a live region.
  if (stepState === "empty") {
    return (
      <div className="space-y-3 py-2">
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
