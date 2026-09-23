import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFfmpegStore } from "@/features/ffmpeg";
import type { FfmpegState } from "@/features/ffmpeg/types";
import { settingsStore } from "@/features/settings/store";
import {
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  type Preset,
  type PresetAudioChannels,
  type PresetContainer,
  type QualityKind,
} from "@/features/settings/types";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  presentDeletePresetConfirm,
  presentRestoreDefaultsConfirm,
  type DeletePresetConfirmView,
} from "./presetConfirmPresenter";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  isUnsavedPresetRow,
  presentPresetDraftStatus,
  presentUnsavedDraftPrompt,
  type PresetDraftGuard,
} from "./presetDraftGuard";
import {
  createPresetLibraryController,
  type PresetLibraryController,
  type PresetLibraryView,
} from "./presetLibraryController";
import {
  CUSTOM_ENCODER_VALUE,
  MAX_PRESETS,
  groupIssuesByField,
  isActivationKey,
  joinDescribedBy,
  parseAudioBitrateValue,
  parseAudioSampleRateValue,
  presentAudioBitrateSelect,
  presentAudioBitrateValue,
  presentAudioChannelsSelect,
  presentAudioSampleRateSelect,
  presentAudioSampleRateValue,
  presentContainer,
  presentEncoderSelect,
  presentFrameRateInvalid,
  presentNumericField,
  presentPresetEncoderMark,
  presentQualityKind,
  presentResolutionInvalid,
  presentSaveBlockedSummary,
  type MessageView,
} from "./presetPresenter";

/**
 * The validation messages under one field. `id` is the target of the field's
 * `aria-describedby`. Renders nothing when the field has no message.
 */
function FieldError({
  id,
  messages,
  translate,
}: {
  id: string;
  messages: readonly MessageView[];
  translate: (key: string, options?: Record<string, string | number>) => string;
}) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <div id={id} className="space-y-0.5 text-xs text-destructive-text">
      {messages.map((message, index) => (
        <p key={index}>{translate(message.key, message.values)}</p>
      ))}
    </div>
  );
}

function PresetEditor({
  draft,
  view,
  controller,
  ffmpegState,
  onRequestDelete,
}: {
  draft: Preset;
  view: PresetLibraryView;
  controller: PresetLibraryController;
  ffmpegState: Pick<FfmpegState, "status" | "results">;
  /** Asks the user to confirm the delete. The section owns the confirmation. */
  onRequestDelete: (id: string) => void;
}) {
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

  const videoSelect = presentEncoderSelect(ffmpegState, "video", draft.videoEncoder);
  const audioSelect = presentEncoderSelect(ffmpegState, "audio", draft.audioEncoder);
  const bitrateSelect = presentAudioBitrateSelect(
    draft.audioEncoder,
    draft.audioBitrate,
    numberFormatter,
  );
  const sampleRateSelect = presentAudioSampleRateSelect(
    draft.audioSampleRate,
    numberFormatter,
  );
  const channelsSelect = presentAudioChannelsSelect();

  const issueGroups = groupIssuesByField(view.issues);
  const resolutionInvalid = presentResolutionInvalid(draft, view.issues);
  const frameRateInvalid = presentFrameRateInvalid(draft, view.issues);
  const saveBlocked = presentSaveBlockedSummary(view.issues);

  // One id base for the editor. Each label names its control through `htmlFor`, and each
  // control names its message and its hint through `aria-describedby`.
  const idBase = useId();
  const ids = {
    name: `${idBase}-name`,
    nameError: `${idBase}-name-error`,
    container: `${idBase}-container`,
    containerError: `${idBase}-container-error`,
    videoEncoder: `${idBase}-video-encoder`,
    videoEncoderReason: `${idBase}-video-encoder-reason`,
    videoEncoderCustom: `${idBase}-video-encoder-custom`,
    videoEncoderCustomHint: `${idBase}-video-encoder-custom-hint`,
    videoEncoderError: `${idBase}-video-encoder-error`,
    audioEncoder: `${idBase}-audio-encoder`,
    audioEncoderReason: `${idBase}-audio-encoder-reason`,
    audioEncoderCustom: `${idBase}-audio-encoder-custom`,
    audioEncoderCustomHint: `${idBase}-audio-encoder-custom-hint`,
    audioEncoderError: `${idBase}-audio-encoder-error`,
    audioBitrate: `${idBase}-audio-bitrate`,
    audioBitrateHint: `${idBase}-audio-bitrate-hint`,
    audioBitrateError: `${idBase}-audio-bitrate-error`,
    audioSampleRate: `${idBase}-audio-sample-rate`,
    audioSampleRateError: `${idBase}-audio-sample-rate-error`,
    audioChannels: `${idBase}-audio-channels`,
    qualityKind: `${idBase}-quality-kind`,
    qualityValue: `${idBase}-quality-value`,
    qualityError: `${idBase}-quality-error`,
    resolution: `${idBase}-resolution`,
    resolutionW: `${idBase}-resolution-w`,
    resolutionH: `${idBase}-resolution-h`,
    resolutionError: `${idBase}-resolution-error`,
    frameRate: `${idBase}-frame-rate`,
    frameRateN: `${idBase}-frame-rate-n`,
    frameRateD: `${idBase}-frame-rate-d`,
    frameRateError: `${idBase}-frame-rate-error`,
    saveBlocked: `${idBase}-save-blocked`,
  };

  const nameInvalid = issueGroups.name.length > 0;
  const containerInvalid = issueGroups.container.length > 0;
  const videoEncoderInvalid = issueGroups.videoEncoder.length > 0;
  const audioEncoderInvalid = issueGroups.audioEncoder.length > 0;
  const audioBitrateInvalid = issueGroups.audioBitrate.length > 0;
  const audioSampleRateInvalid = issueGroups.audioSampleRate.length > 0;
  const qualityInvalid = issueGroups.quality.length > 0;

  // An encoder issue belongs to the control that holds the name. With the custom field open,
  // that is the text input and not the list.
  const videoListInvalid = videoEncoderInvalid && !view.videoEncoderIsCustom;
  const videoCustomInvalid = videoEncoderInvalid && view.videoEncoderIsCustom;
  const audioListInvalid = audioEncoderInvalid && !view.audioEncoderIsCustom;
  const audioCustomInvalid = audioEncoderInvalid && view.audioEncoderIsCustom;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-3">
      {/* Preset Name */}
      <div className="space-y-1">
        <label htmlFor={ids.name} className="text-xs font-medium text-muted-foreground">
          {t("settings.preset.nameLabel")}
        </label>
        <Input
          id={ids.name}
          aria-invalid={nameInvalid}
          aria-describedby={joinDescribedBy(nameInvalid && ids.nameError)}
          value={draft.name}
          onChange={(e) => controller.setName(e.target.value)}
        />
        <FieldError
          id={ids.nameError}
          messages={issueGroups.name}
          translate={translate}
        />
      </div>

      {/* Container */}
      <div className="space-y-1">
        <label
          htmlFor={ids.container}
          className="text-xs font-medium text-muted-foreground"
        >
          {t("settings.preset.containerLabel")}
        </label>
        <Select
          value={draft.container}
          onValueChange={(val) => controller.setContainer(val as PresetContainer)}
        >
          <SelectTrigger
            id={ids.container}
            aria-invalid={containerInvalid}
            aria-describedby={joinDescribedBy(containerInvalid && ids.containerError)}
            className="w-full"
          >
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
        <FieldError
          id={ids.containerError}
          messages={issueGroups.container}
          translate={translate}
        />
      </div>

      {/* Video Encoder */}
      <div className="space-y-1">
        <label
          htmlFor={ids.videoEncoder}
          className="text-xs font-medium text-muted-foreground"
        >
          {t("settings.preset.videoEncoderLabel")}
        </label>
        <Select
          value={view.videoEncoderIsCustom ? CUSTOM_ENCODER_VALUE : draft.videoEncoder}
          onValueChange={(val) => controller.chooseEncoder("video", val)}
        >
          <SelectTrigger
            id={ids.videoEncoder}
            aria-invalid={videoListInvalid}
            aria-describedby={joinDescribedBy(
              videoListInvalid && ids.videoEncoderError,
              videoSelect.currentReasonKey !== undefined && ids.videoEncoderReason,
            )}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {videoSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, option.labelValues)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {videoListInvalid ? (
          <FieldError
            id={ids.videoEncoderError}
            messages={issueGroups.videoEncoder}
            translate={translate}
          />
        ) : null}
        {videoSelect.currentReasonKey ? (
          <p
            id={ids.videoEncoderReason}
            className={cn(
              "text-xs",
              videoSelect.currentReasonTone === "warning"
                ? "text-warning-text"
                : "text-muted-foreground",
            )}
          >
            {translate(videoSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.videoEncoderIsCustom ? (
          <div className="space-y-1 pt-1">
            <label
              htmlFor={ids.videoEncoderCustom}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.encoder.customLabel")}
            </label>
            <Input
              id={ids.videoEncoderCustom}
              aria-invalid={videoCustomInvalid}
              aria-describedby={joinDescribedBy(
                videoCustomInvalid && ids.videoEncoderError,
                ids.videoEncoderCustomHint,
              )}
              value={draft.videoEncoder}
              onChange={(e) => controller.setEncoderName("video", e.target.value)}
            />
            {videoCustomInvalid ? (
              <FieldError
                id={ids.videoEncoderError}
                messages={issueGroups.videoEncoder}
                translate={translate}
              />
            ) : null}
            <p
              id={ids.videoEncoderCustomHint}
              className="text-xs text-muted-foreground"
            >
              {t("settings.encoder.customHint")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Audio Encoder */}
      <div className="space-y-1">
        <label
          htmlFor={ids.audioEncoder}
          className="text-xs font-medium text-muted-foreground"
        >
          {t("settings.preset.audioEncoderLabel")}
        </label>
        <Select
          value={view.audioEncoderIsCustom ? CUSTOM_ENCODER_VALUE : draft.audioEncoder}
          onValueChange={(val) => controller.chooseEncoder("audio", val)}
        >
          <SelectTrigger
            id={ids.audioEncoder}
            aria-invalid={audioListInvalid}
            aria-describedby={joinDescribedBy(
              audioListInvalid && ids.audioEncoderError,
              audioSelect.currentReasonKey !== undefined && ids.audioEncoderReason,
            )}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {audioSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, option.labelValues)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {audioListInvalid ? (
          <FieldError
            id={ids.audioEncoderError}
            messages={issueGroups.audioEncoder}
            translate={translate}
          />
        ) : null}
        {audioSelect.currentReasonKey ? (
          <p
            id={ids.audioEncoderReason}
            className={cn(
              "text-xs",
              audioSelect.currentReasonTone === "warning"
                ? "text-warning-text"
                : "text-muted-foreground",
            )}
          >
            {translate(audioSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.audioEncoderIsCustom ? (
          <div className="space-y-1 pt-1">
            <label
              htmlFor={ids.audioEncoderCustom}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.encoder.customLabel")}
            </label>
            <Input
              id={ids.audioEncoderCustom}
              aria-invalid={audioCustomInvalid}
              aria-describedby={joinDescribedBy(
                audioCustomInvalid && ids.audioEncoderError,
                ids.audioEncoderCustomHint,
              )}
              value={draft.audioEncoder}
              onChange={(e) => controller.setEncoderName("audio", e.target.value)}
            />
            {audioCustomInvalid ? (
              <FieldError
                id={ids.audioEncoderError}
                messages={issueGroups.audioEncoder}
                translate={translate}
              />
            ) : null}
            <p
              id={ids.audioEncoderCustomHint}
              className="text-xs text-muted-foreground"
            >
              {t("settings.encoder.customHint")}
            </p>
          </div>
        ) : null}
      </div>

      {/* Audio Bitrate, Sample Rate, Channels */}
      <div className="space-y-1">
        <div className="grid grid-cols-3 gap-2">
          {/* Audio Bitrate */}
          <div className="space-y-1">
            <label
              htmlFor={ids.audioBitrate}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.preset.audioBitrateLabel")}
            </label>
            <Select
              disabled={bitrateSelect.disabled}
              value={presentAudioBitrateValue(draft.audioBitrate)}
              onValueChange={(val) =>
                controller.setAudioBitrate(parseAudioBitrateValue(val))
              }
            >
              <SelectTrigger
                id={ids.audioBitrate}
                aria-invalid={audioBitrateInvalid}
                aria-describedby={joinDescribedBy(
                  audioBitrateInvalid && ids.audioBitrateError,
                  bitrateSelect.hintKey !== undefined && ids.audioBitrateHint,
                )}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {bitrateSelect.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {translate(option.labelKey, option.labelValues)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              id={ids.audioBitrateError}
              messages={issueGroups.audioBitrate}
              translate={translate}
            />
          </div>

          {/* Audio Sample Rate */}
          <div className="space-y-1">
            <label
              htmlFor={ids.audioSampleRate}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.preset.audioSampleRateLabel")}
            </label>
            <Select
              value={presentAudioSampleRateValue(draft.audioSampleRate)}
              onValueChange={(val) =>
                controller.setAudioSampleRate(parseAudioSampleRateValue(val))
              }
            >
              <SelectTrigger
                id={ids.audioSampleRate}
                aria-invalid={audioSampleRateInvalid}
                aria-describedby={joinDescribedBy(
                  audioSampleRateInvalid && ids.audioSampleRateError,
                )}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sampleRateSelect.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {translate(option.labelKey, option.labelValues)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError
              id={ids.audioSampleRateError}
              messages={issueGroups.audioSampleRate}
              translate={translate}
            />
          </div>

          {/* Audio Channels */}
          <div className="space-y-1">
            <label
              htmlFor={ids.audioChannels}
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.preset.audioChannelsLabel")}
            </label>
            <Select
              value={draft.audioChannels}
              onValueChange={(val) =>
                controller.setAudioChannels(val as PresetAudioChannels)
              }
            >
              <SelectTrigger id={ids.audioChannels} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channelsSelect.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {translate(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {bitrateSelect.hintKey ? (
          <p id={ids.audioBitrateHint} className="text-xs text-muted-foreground">
            {translate(bitrateSelect.hintKey)}
          </p>
        ) : null}
      </div>

      {/* Quality Kind and Value */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label
            htmlFor={ids.qualityKind}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("settings.preset.qualityKindLabel")}
          </label>
          <Select
            value={draft.quality.kind}
            onValueChange={(val) => controller.setQualityKind(val as QualityKind)}
          >
            <SelectTrigger id={ids.qualityKind} className="w-full">
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
          <label
            htmlFor={ids.qualityValue}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("settings.preset.qualityValueLabel")}
          </label>
          <Input
            id={ids.qualityValue}
            type="number"
            aria-invalid={qualityInvalid}
            aria-describedby={joinDescribedBy(qualityInvalid && ids.qualityError)}
            value={presentNumericField(draft.quality.value)}
            onChange={(e) => controller.updateQualityValue(e.target.value)}
          />
          <FieldError
            id={ids.qualityError}
            messages={issueGroups.quality}
            translate={translate}
          />
        </div>
      </div>

      {/* Resolution */}
      <div className="space-y-2">
        <div className="space-y-1">
          <label
            htmlFor={ids.resolution}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("settings.preset.resolutionLabel")}
          </label>
          <Select
            value={view.resolutionMode}
            onValueChange={(val) =>
              controller.setResolutionMode(val as "source" | "custom")
            }
          >
            <SelectTrigger id={ids.resolution} className="w-full">
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
          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label
                  htmlFor={ids.resolutionW}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("settings.preset.widthLabel")}
                </label>
                <Input
                  id={ids.resolutionW}
                  type="number"
                  aria-invalid={resolutionInvalid.w}
                  aria-describedby={joinDescribedBy(
                    resolutionInvalid.w && ids.resolutionError,
                  )}
                  value={presentNumericField(draft.resolution.w)}
                  onChange={(e) =>
                    controller.updateResolutionField("w", e.target.value)
                  }
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor={ids.resolutionH}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("settings.preset.heightLabel")}
                </label>
                <Input
                  id={ids.resolutionH}
                  type="number"
                  aria-invalid={resolutionInvalid.h}
                  aria-describedby={joinDescribedBy(
                    resolutionInvalid.h && ids.resolutionError,
                  )}
                  value={presentNumericField(draft.resolution.h)}
                  onChange={(e) =>
                    controller.updateResolutionField("h", e.target.value)
                  }
                />
              </div>
            </div>
            {/* One message for the pair: `validatePresetFields` reports the width and the
                height as one field. Only the input with the bad value is marked. */}
            <FieldError
              id={ids.resolutionError}
              messages={issueGroups.resolution}
              translate={translate}
            />
          </div>
        ) : null}
      </div>

      {/* Frame Rate */}
      <div className="space-y-2">
        <div className="space-y-1">
          <label
            htmlFor={ids.frameRate}
            className="text-xs font-medium text-muted-foreground"
          >
            {t("settings.preset.frameRateLabel")}
          </label>
          <Select
            value={view.frameRateMode}
            onValueChange={(val) =>
              controller.setFrameRateMode(val as "source" | "custom")
            }
          >
            <SelectTrigger id={ids.frameRate} className="w-full">
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
          <div className="space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label
                  htmlFor={ids.frameRateN}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("settings.preset.frameRateNumeratorLabel")}
                </label>
                <Input
                  id={ids.frameRateN}
                  type="number"
                  aria-invalid={frameRateInvalid.n}
                  aria-describedby={joinDescribedBy(
                    frameRateInvalid.n && ids.frameRateError,
                  )}
                  value={presentNumericField(draft.frameRate.n)}
                  onChange={(e) => controller.updateFrameRateField("n", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor={ids.frameRateD}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t("settings.preset.frameRateDenominatorLabel")}
                </label>
                <Input
                  id={ids.frameRateD}
                  type="number"
                  aria-invalid={frameRateInvalid.d}
                  aria-describedby={joinDescribedBy(
                    frameRateInvalid.d && ids.frameRateError,
                  )}
                  value={presentNumericField(draft.frameRate.d)}
                  onChange={(e) => controller.updateFrameRateField("d", e.target.value)}
                />
              </div>
            </div>
            {/* One message for the pair, as for the resolution above. */}
            <FieldError
              id={ids.frameRateError}
              messages={issueGroups.frameRate}
              translate={translate}
            />
          </div>
        ) : null}
      </div>

      {/* An issue that names no field of this editor. Each other issue shows at its field. */}
      {issueGroups.other.length > 0 ? (
        <Notice tone="destructive">
          <div className="space-y-1">
            {issueGroups.other.map((message, index) => (
              <p key={index}>{translate(message.key, message.values)}</p>
            ))}
          </div>
        </Notice>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            size="sm"
            disabled={!view.canSave || view.pending}
            aria-describedby={joinDescribedBy(saveBlocked !== null && ids.saveBlocked)}
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
          {/* Says why Save is off. Save names this line through `aria-describedby`. */}
          {saveBlocked ? (
            <span id={ids.saveBlocked} className="text-xs text-destructive-text">
              {translate(saveBlocked.key, saveBlocked.values)}
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
          {/* The red label keeps 4.5:1 only up to the /10 fill: in the dark theme a /12 fill
              already gives 4.46:1. Thus the press keeps the hover fill, which also replaces
              the teal press fill of the outline variant, and turns the border red. */}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive-text hover:bg-destructive/10 hover:text-destructive-text active:border-destructive/50 active:bg-destructive/10"
            disabled={view.pending}
            onClick={() => {
              onRequestDelete(draft.id);
            }}
          >
            {t("settings.preset.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface PresetLibrarySectionProps {
  /**
   * Receives the state of the draft and the actions that settle it, each time the state
   * changes, and `CLEAN_PRESET_DRAFT_GUARD` when the section unmounts. The settings dialog
   * reads it to keep a close request from dropping an unsaved draft. Pass a stable function,
   * such as a state setter.
   */
  onDraftChange?: (guard: PresetDraftGuard) => void;
}

export function PresetLibrarySection({ onDraftChange }: PresetLibrarySectionProps) {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;

  // Only `status` and `results` reach `presentEncoderSelect` and `presentPresetEncoderMark`.
  // Selecting the two fields with a shallow comparison keeps a capability-probe write that
  // touches neither from re-rendering the whole preset library.
  const ffmpegState = useFfmpegStore(
    useShallow((state) => ({ status: state.status, results: state.results })),
  );
  const [pendingView, setView] = useState<PresetLibraryView | null>(null);

  // Row the user asked to switch to while an edit is unsaved. The controller documents that
  // `select` discards a dirty draft without warning and leaves the confirmation to the
  // view; this holds the pending target until the user answers.
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);

  // The delete confirmation. `prompt` is presented when the dialog opens and is kept after it
  // closes, so the title and the description stay on screen while the dialog animates out,
  // even after the delete has removed the preset they name. The dialog is modal, so this
  // window cannot change the preset library while it is open. Another window or another copy
  // of QuipClip can still save, so the text can be out of date. The delete stays safe: it
  // removes the preset by id, not by position, and the revision check of ADR 013 refuses a save
  // that is based on a library another process has changed.
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    prompt: DeletePresetConfirmView | null;
  }>({ open: false, prompt: null });
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const restorePrompt = presentRestoreDefaultsConfirm();

  const controller = useMemo(
    () =>
      createPresetLibraryController({
        onChange: setView,
      }),
    [],
  );

  const view = pendingView ?? controller.getView();

  // Drop the pending target as soon as the draft is clean, derived during render the way
  // `PreviewPane` clears its decode error. A Save or a Cancel elsewhere in the editor clears
  // `dirty` only, so without this the prompt would merely hide while still holding the old
  // target: a later edit would bring it back aimed at a row the user never answered for, and
  // its Discard button would throw away an edit nobody offered to discard.
  if (pendingSelectId !== null && !view.dirty) {
    setPendingSelectId(null);
  }

  useEffect(() => {
    controller.activate();
    return () => {
      controller.deactivate();
    };
  }, [controller]);

  // Report the draft upward. The guard is rebuilt only when one of its values changes, so the
  // dialog renders again only then. The actions call the controller, which owns the draft.
  const { dirty, presetName, canSave, pending } = presentPresetDraftStatus(view);
  const draftGuard = useMemo<PresetDraftGuard>(
    () => ({
      dirty,
      presetName,
      canSave,
      pending,
      save: () => controller.saveDraftBeforeLeaving(),
      discard: () => {
        controller.cancelDraft();
      },
    }),
    [controller, dirty, presetName, canSave, pending],
  );
  const unsavedPrompt = presentUnsavedDraftPrompt(draftGuard);

  useEffect(() => {
    onDraftChange?.(draftGuard);
  }, [onDraftChange, draftGuard]);

  // The draft ends with this section, because the dialog unmounts its content when it closes.
  useEffect(() => {
    if (onDraftChange === undefined) {
      return undefined;
    }
    return () => {
      onDraftChange(CLEAN_PRESET_DRAFT_GUARD);
    };
  }, [onDraftChange]);

  useEffect(() => {
    // Compare the settings slice rather than resubscribing to every store write. The store
    // publishes pure lifecycle transitions ("loading", "saving", "ready") that leave
    // `settings` referentially identical, and each of those would otherwise rebuild the
    // draft for a field this controller never reads.
    let previous = settingsStore.getState().settings;
    controller.syncFromSettings(previous);
    return settingsStore.subscribe((state) => {
      if (state.settings === previous) {
        return;
      }
      previous = state.settings;
      controller.syncFromSettings(state.settings);
    });
  }, [controller]);

  const handleActivateRow = (id: string) => {
    // No selection change while a write is in flight. A Save and Switch that is running holds
    // its target, and a row pressed now would either move the prompt to a target that the
    // running save then ignores, or select a row under that save.
    if (view.pending) {
      return;
    }
    if (view.dirty && id !== view.selectedPresetId) {
      setPendingSelectId(id);
      return;
    }
    controller.select(id);
  };

  // The target is a parameter and is not read from state after the save: a save that leaves
  // the draft clean also clears `pendingSelectId`, as described above.
  const handleSaveAndSwitch = async (id: string) => {
    if (await controller.saveDraftBeforeLeaving()) {
      controller.select(id);
    }
  };

  const handleRequestDelete = (id: string) => {
    const prompt = presentDeletePresetConfirm(view.presets, view.activePresetId, id);
    if (prompt !== null) {
      setDeleteConfirm({ open: true, prompt });
    }
  };

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
            // Gated on `ready` as well as `pending`: `restore_default_presets` begins by
            // reading the settings file, so it fails the same way the load did and must not
            // be the one enabled control in a state where it cannot work.
            disabled={view.ready ? view.pending : true}
            onClick={() => {
              setRestoreConfirmOpen(true);
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

      {/* The target above is cleared once the draft is clean, so a Save or a Cancel elsewhere
          in the editor leaves no stale prompt behind. */}
      {pendingSelectId !== null && unsavedPrompt !== null ? (
        <Notice tone="warning" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 wrap-break-word">
              {translate(unsavedPrompt.message.key, unsavedPrompt.message.values)}
            </span>
            {/* Outline and ghost buttons inherit the text color. Reset it here so the
                buttons do not take the warning color of the box. The order and the styles
                match the unsaved-changes prompt in the settings dialog footer. */}
            <div className="flex items-center gap-2 text-foreground">
              <Button
                variant="ghost"
                size="sm"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={() => {
                  controller.select(pendingSelectId);
                  setPendingSelectId(null);
                }}
              >
                {t("settings.preset.discardConfirm")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={() => setPendingSelectId(null)}
              >
                {t("settings.preset.discardCancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={unsavedPrompt.saveDisabled}
                onClick={() => {
                  void handleSaveAndSwitch(pendingSelectId);
                }}
              >
                {t("settings.preset.saveAndSwitch")}
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}

      {!view.ready ? (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      ) : view.presets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.preset.empty")}</p>
      ) : (
        <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-1">
          {view.presets.map((preset) => {
            const encoderMark = presentPresetEncoderMark(ffmpegState, preset);
            return (
              <div
                key={preset.id}
                role="button"
                tabIndex={0}
                onClick={() => handleActivateRow(preset.id)}
                onKeyDown={(e) => {
                  if (isActivationKey(e.key)) {
                    handleActivateRow(preset.id);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors",
                  preset.id === view.selectedPresetId
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{preset.name}</span>
                  {isUnsavedPresetRow(view, preset.id) ? (
                    <>
                      {/* The dot is decorative. The `sr-only` span carries its meaning into
                          the row's accessible name, as the encoder badge does. */}
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                      />
                      <span className="sr-only">{` ${t("settings.preset.unsaved")}`}</span>
                    </>
                  ) : null}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {encoderMark ? (
                    <Tooltip>
                      {/* The badge stays out of the tab order: the row around it is already
                          `role="button"` with `tabIndex={0}`, and a focusable child would nest
                          one interactive control inside another. The tooltip opens on a pointer
                          or on focus, so it reaches a mouse only; the `sr-only` span carries the
                          same encoder name and reason into the row's accessible name, where a
                          keyboard or screen-reader user reads them. */}
                      <TooltipTrigger asChild>
                        <span
                          tabIndex={-1}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-2xs leading-none font-semibold",
                            encoderMark.tone === "warning"
                              ? "bg-warning/10 text-warning-text"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {translate(encoderMark.badgeKey)}
                          <span className="sr-only">
                            {` ${translate(encoderMark.titleKey, encoderMark.titleValues)} ${translate(encoderMark.reasonKey)}`}
                          </span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="flex-col items-start gap-1">
                        <p className="font-semibold">
                          {translate(encoderMark.titleKey, encoderMark.titleValues)}
                        </p>
                        <p>{translate(encoderMark.reasonKey)}</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {preset.id === view.activePresetId ? (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-2xs leading-none font-semibold text-primary">
                      {t("settings.preset.activeBadge")}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view.draft ? (
        <PresetEditor
          key={view.draft.id}
          draft={view.draft}
          view={view}
          controller={controller}
          ffmpegState={ffmpegState}
          onRequestDelete={handleRequestDelete}
        />
      ) : null}

      {/* Each confirm button keeps the gate of the button that opened its dialog: the
          controller requires every write to wait while `view.pending` is true. */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm((previous) => ({ ...previous, open }))}
        title={
          deleteConfirm.prompt
            ? translate(
                deleteConfirm.prompt.title.key,
                deleteConfirm.prompt.title.values,
              )
            : null
        }
        description={
          deleteConfirm.prompt
            ? translate(
                deleteConfirm.prompt.description.key,
                deleteConfirm.prompt.description.values,
              )
            : null
        }
        confirmLabel={t("settings.preset.deleteDialog.confirm")}
        cancelLabel={t("common.cancel")}
        destructive
        confirmDisabled={view.pending}
        onConfirm={() => {
          if (deleteConfirm.prompt) {
            void controller.deletePreset(deleteConfirm.prompt.presetId);
          }
        }}
      />
      <ConfirmDialog
        open={restoreConfirmOpen}
        onOpenChange={setRestoreConfirmOpen}
        title={translate(restorePrompt.title.key)}
        description={translate(restorePrompt.description.key)}
        confirmLabel={t("settings.preset.restoreDefaults")}
        cancelLabel={t("common.cancel")}
        destructive
        confirmDisabled={view.ready ? view.pending : true}
        onConfirm={() => {
          void controller.restoreDefaults();
        }}
      />
    </section>
  );
}
