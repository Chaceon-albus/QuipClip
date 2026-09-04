import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFfmpegStore } from "@/features/ffmpeg";
import type { FfmpegState } from "@/features/ffmpeg/types";
import { settingsStore } from "@/features/settings/store";
import {
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  type Preset,
  type PresetContainer,
  type QualityKind,
} from "@/features/settings/types";
import { cn } from "@/lib/utils";
import {
  createPresetLibraryController,
  type PresetLibraryController,
  type PresetLibraryView,
} from "./presetLibraryController";
import {
  CUSTOM_ENCODER_VALUE,
  MAX_PRESETS,
  isActivationKey,
  presentContainer,
  presentEncoderSelect,
  presentNumericField,
  presentPresetIssues,
  presentQualityKind,
} from "./presetPresenter";

function PresetEditor({
  draft,
  view,
  controller,
  ffmpegState,
}: {
  draft: Preset;
  view: PresetLibraryView;
  controller: PresetLibraryController;
  ffmpegState: FfmpegState;
}) {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;

  const videoSelect = presentEncoderSelect(ffmpegState, "video", draft.videoEncoder);
  const audioSelect = presentEncoderSelect(ffmpegState, "audio", draft.audioEncoder);
  const issues = presentPresetIssues(view.issues);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-3">
      {/* Preset Name */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.preset.nameLabel")}
        </label>
        <Input
          value={draft.name}
          onChange={(e) => controller.setName(e.target.value)}
        />
      </div>

      {/* Container */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.preset.containerLabel")}
        </label>
        <Select
          value={draft.container}
          onValueChange={(val) => controller.setContainer(val as PresetContainer)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_CONTAINERS.map((container) => (
              <SelectItem key={container} value={container}>
                {presentContainer(container)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Video Encoder */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.preset.videoEncoderLabel")}
        </label>
        <Select
          value={view.videoEncoderIsCustom ? CUSTOM_ENCODER_VALUE : draft.videoEncoder}
          onValueChange={(val) => controller.chooseEncoder("video", val)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {videoSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, {
                  ...option.labelValues,
                  availability: translate(option.labelValues.availability),
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {videoSelect.currentReasonKey ? (
          <p className="text-xs text-warning">
            {translate(videoSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.videoEncoderIsCustom ? (
          <div className="space-y-1 pt-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("settings.encoder.customLabel")}
            </label>
            <Input
              value={draft.videoEncoder}
              onChange={(e) => controller.setEncoderName("video", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.encoder.customHint")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Audio Encoder */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.preset.audioEncoderLabel")}
        </label>
        <Select
          value={view.audioEncoderIsCustom ? CUSTOM_ENCODER_VALUE : draft.audioEncoder}
          onValueChange={(val) => controller.chooseEncoder("audio", val)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {audioSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, {
                  ...option.labelValues,
                  availability: translate(option.labelValues.availability),
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {audioSelect.currentReasonKey ? (
          <p className="text-xs text-warning">
            {translate(audioSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.audioEncoderIsCustom ? (
          <div className="space-y-1 pt-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("settings.encoder.customLabel")}
            </label>
            <Input
              value={draft.audioEncoder}
              onChange={(e) => controller.setEncoderName("audio", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.encoder.customHint")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Quality Kind and Value */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.preset.qualityKindLabel")}
          </label>
          <Select
            value={draft.quality.kind}
            onValueChange={(val) => controller.setQualityKind(val as QualityKind)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUALITY_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {translate(presentQualityKind(kind))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.preset.qualityValueLabel")}
          </label>
          <Input
            type="number"
            value={presentNumericField(draft.quality.value)}
            onChange={(e) => controller.updateQualityValue(e.target.value)}
          />
        </div>
      </div>

      {/* Resolution */}
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.preset.resolutionLabel")}
          </label>
          <Select
            value={view.resolutionMode}
            onValueChange={(val) =>
              controller.setResolutionMode(val as "source" | "custom")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source">
                {t("settings.preset.sourceOption")}
              </SelectItem>
              <SelectItem value="custom">
                {t("settings.preset.customOption")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {view.resolutionMode === "custom" && draft.resolution !== "source" ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t("settings.preset.widthLabel")}
              </label>
              <Input
                type="number"
                value={presentNumericField(draft.resolution.w)}
                onChange={(e) => controller.updateResolutionField("w", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t("settings.preset.heightLabel")}
              </label>
              <Input
                type="number"
                value={presentNumericField(draft.resolution.h)}
                onChange={(e) => controller.updateResolutionField("h", e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Frame Rate */}
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.preset.frameRateLabel")}
          </label>
          <Select
            value={view.frameRateMode}
            onValueChange={(val) =>
              controller.setFrameRateMode(val as "source" | "custom")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source">
                {t("settings.preset.sourceOption")}
              </SelectItem>
              <SelectItem value="custom">
                {t("settings.preset.customOption")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {view.frameRateMode === "custom" && draft.frameRate !== "source" ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t("settings.preset.frameRateNumeratorLabel")}
              </label>
              <Input
                type="number"
                value={presentNumericField(draft.frameRate.n)}
                onChange={(e) => controller.updateFrameRateField("n", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t("settings.preset.frameRateDenominatorLabel")}
              </label>
              <Input
                type="number"
                value={presentNumericField(draft.frameRate.d)}
                onChange={(e) => controller.updateFrameRateField("d", e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Issues */}
      {issues.length > 0 ? (
        <div className="space-y-1 rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive">
          {issues.map((issue) => (
            <p key={issue.id}>{translate(issue.key, issue.values)}</p>
          ))}
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            disabled={!view.canSave || view.pending}
            onClick={() => {
              void controller.saveDraft();
            }}
          >
            {t("common.save")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={view.pending}
            onClick={() => {
              controller.cancelDraft();
            }}
          >
            {t("common.cancel")}
          </Button>
          {view.dirty ? (
            <span className="text-xs text-muted-foreground">
              {t("settings.preset.unsaved")}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={view.pending || draft.id === view.activePresetId}
            onClick={() => {
              void controller.setActive(draft.id);
            }}
          >
            {t("settings.preset.setActive")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={view.pending}
            onClick={() => {
              void controller.deletePreset(draft.id);
            }}
          >
            {t("settings.preset.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PresetLibrarySection() {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;

  const ffmpegState = useFfmpegStore();
  const [pendingView, setView] = useState<PresetLibraryView | null>(null);

  const controller = useMemo(
    () =>
      createPresetLibraryController({
        onChange: setView,
      }),
    [],
  );

  const view = pendingView ?? controller.getView();

  useEffect(() => {
    controller.activate();
    return () => {
      controller.deactivate();
    };
  }, [controller]);

  useEffect(() => {
    controller.syncFromSettings(settingsStore.getState().settings);
    return settingsStore.subscribe((state) => {
      controller.syncFromSettings(state.settings);
    });
  }, [controller]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm font-medium">
          {t("settings.preset.section")}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={view.ready ? !view.canAdd || view.pending : true}
            onClick={() => {
              void controller.addPreset(t("settings.preset.newName"));
            }}
          >
            {t("settings.preset.add")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={view.pending}
            onClick={() => {
              void controller.restoreDefaults();
            }}
          >
            {t("settings.preset.restoreDefaults")}
          </Button>
        </div>
      </div>

      {!view.canAdd ? (
        <p className="text-xs text-muted-foreground">
          {translate("settings.preset.limitReached", { max: MAX_PRESETS })}
        </p>
      ) : null}

      {!view.ready ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : view.presets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.preset.empty")}</p>
      ) : (
        <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-1">
          {view.presets.map((preset) => (
            <div
              key={preset.id}
              role="button"
              tabIndex={0}
              onClick={() => controller.select(preset.id)}
              onKeyDown={(e) => {
                if (isActivationKey(e.key)) {
                  controller.select(preset.id);
                }
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors",
                preset.id === view.selectedPresetId
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <span className="truncate">{preset.name}</span>
              {preset.id === view.activePresetId ? (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {t("settings.preset.activeBadge")}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {view.draft ? (
        <PresetEditor
          key={view.draft.id}
          draft={view.draft}
          view={view}
          controller={controller}
          ffmpegState={ffmpegState}
        />
      ) : null}
    </section>
  );
}
