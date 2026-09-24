import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
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
import { useFfmpegStore } from "@/features/ffmpeg";
import type { FfmpegState } from "@/features/ffmpeg/types";
import { PRESET_NAME_SLOT } from "@/features/settings/presetNaming";
import { settingsStore } from "@/features/settings/store";
import {
  PRESET_CONTAINERS,
  QUALITY_KINDS,
  type Preset,
  type PresetAudioChannels,
  type PresetContainer,
  type QualityKind,
} from "@/features/settings/types";
import { OUTPUT_CUSTOM_VALUE } from "@/features/settings/videoOutputChoices";
import { getResolvedLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  presentDeletePresetConfirm,
  presentRestoreDefaultsConfirm,
  type DeletePresetConfirmView,
} from "./presetConfirmPresenter";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  decideLeavePromptKey,
  decideLeaveRequest,
  pickCreateFailureFocus,
  pickPromptCancelFocus,
  pickPromptOpenFocus,
  pickPromptReturnFocus,
  PRESET_LEAVE_PROMPT_ATTRIBUTE,
  presentPresetDraftStatus,
  presentSaveAndLeaveLabel,
  presentUnsavedDraftPrompt,
  toPromptFocusTarget,
  type PendingLeave,
  type PresetDraftGuard,
} from "./presetDraftGuard";
import {
  createPresetLibraryController,
  type PresetLibraryController,
  type PresetLibraryView,
} from "./presetLibraryController";
import { PresetList, PresetListToolbar } from "./PresetList";
import {
  findListFocusRow,
  findPresetRow,
  pickDefaultPresetId,
  pickSelectionAfterDelete,
  presentAddPresetAction,
  presentDeletePresetAction,
  presentDuplicateSelectedAction,
  presentRestoreBuiltInAction,
} from "./presetListPresenter";
import {
  CUSTOM_ENCODER_VALUE,
  MAX_PRESETS,
  groupIssuesByField,
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
  presentFrameRateSelect,
  presentFrameRateTermInput,
  presentNumericField,
  presentQualityKind,
  presentQualityValueInput,
  presentResolutionInput,
  presentResolutionInvalid,
  presentResolutionSelect,
  presentSaveBlockedSummary,
  type MessageView,
  type NumberInputView,
} from "./presetPresenter";

/**
 * One group of the preset editor: a fieldset that its legend names, around a two-column form.
 * Each row is a label in the first column and its control in the second. A message or a hint
 * under a control starts in the second column (`col-start-2`), so it stays under the control.
 *
 * The grid is a child of the fieldset, not the fieldset itself. The rendered legend of a
 * fieldset is never a grid item, and older web views do not lay out a fieldset as a grid.
 *
 * Two rules keep a long value inside the editor, such as a stored custom encoder name of 64
 * characters:
 * - The control column is `minmax(0,1fr)`, not `1fr`. A `1fr` track has the minimum `auto`, so
 *   it never becomes narrower than its widest control, and a long Select label then pushes the
 *   column past the editor border.
 * - The fieldset has `min-w-0`. By default a fieldset is never narrower than its `min-content`
 *   width. This rule limits the fieldset only. The column rule above limits the grid inside it.
 *
 * The legend has the style of the section headings of the settings dialog, so it reads as the
 * heading of its group and not as one more row label.
 */
function FormGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="font-heading text-sm font-medium text-foreground">
        {legend}
      </legend>
      <div className="mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {children}
      </div>
    </fieldset>
  );
}

/** The label of one form row. It is right-aligned against its control, as in a macOS form. */
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-right text-xs font-medium text-muted-foreground"
    >
      {children}
    </label>
  );
}

/**
 * The label of one encoder option. An encoder name is free text of up to 64 characters, so the
 * label must shorten with an ellipsis when the trigger is too narrow.
 *
 * Radix shows the children of the selected item inside the trigger's value span, and the
 * trigger makes that span a flex container. This span is then a flex item, which is a block,
 * so `truncate` can clip it and add the ellipsis.
 *
 * In the open list the span is a flex item too, because `SelectItem` makes the text span of
 * each item a flex container. The list shows the full label only because it grows to the width
 * of its widest item, and the minimum window width of 1024 px leaves room for that. In a window
 * too narrow for the list, the label in the list gets an ellipsis as well.
 */
function EncoderOptionLabel({ children }: { children: ReactNode }) {
  return <span className="truncate">{children}</span>;
}

/**
 * A number input with the `min`, `max`, and `step` of `field`, and an optional unit inside
 * the field on the right. The unit carries `unitId`, so the input can name it in
 * `aria-describedby`. The right padding keeps the typed value and the spin buttons clear of
 * the unit.
 */
function NumberInput({
  field,
  unit,
  unitId,
  className,
  ...props
}: {
  field: NumberInputView;
  unit?: string;
  unitId?: string;
} & Omit<ComponentProps<typeof Input>, "type" | "min" | "max" | "step">) {
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        className={cn(unit !== undefined && "pr-12", className)}
      />
      {unit !== undefined ? (
        <span
          id={unitId}
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5 text-xs text-muted-foreground"
        >
          {unit}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The validation messages under one field. `id` is the target of the field's
 * `aria-describedby`. Renders nothing when the field has no message. It sits in the control
 * column of the `FormGroup` grid. A message can hold a custom encoder name with no space in
 * it, so a long word breaks instead of running past the column.
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
    <div
      id={id}
      className="col-start-2 min-w-0 space-y-0.5 text-xs wrap-break-word text-destructive-text"
    >
      {messages.map((message, index) => (
        <p key={index}>{translate(message.key, message.values)}</p>
      ))}
    </div>
  );
}

/**
 * The fields of the selected preset: the scrolling body of the editor pane on the right of the
 * tab. `PresetEditorFooter` sits under it.
 */
function PresetEditor({
  draft,
  view,
  controller,
  ffmpegState,
  numberFormatter,
  focusName,
  onNameFocused,
}: {
  draft: Preset;
  view: PresetLibraryView;
  controller: PresetLibraryController;
  ffmpegState: Pick<FfmpegState, "status" | "results">;
  numberFormatter: Intl.NumberFormat;
  /**
   * True when Add or Duplicate just created this preset, or when Enter or F2 on its list row
   * asked for the name. The name field then takes the focus once, with its text selected, and
   * the editor calls `onNameFocused`.
   */
  focusName: boolean;
  /** Reports that the name field took the focus, so the section clears `focusName`. */
  onNameFocused: () => void;
}) {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;

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
  const resolutionSelect = presentResolutionSelect();
  const frameRateSelect = presentFrameRateSelect(numberFormatter);
  const qualityInput = presentQualityValueInput(draft.quality.kind);
  const resolutionInput = presentResolutionInput();
  const frameRateTermInput = presentFrameRateTermInput();
  const pixelUnit = resolutionInput.unitKey
    ? translate(resolutionInput.unitKey)
    : undefined;

  const issueGroups = groupIssuesByField(view.issues);
  const resolutionInvalid = presentResolutionInvalid(draft, view.issues);
  const frameRateInvalid = presentFrameRateInvalid(draft, view.issues);

  // The section keys this editor by the preset id, so the editor mounts again for each
  // selected preset. A row press also mounts it, with `focusName` false, and the focus stays
  // on the list. The section clears `focusName` in `onNameFocused`, so a later render does not
  // take the focus again.
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusName) {
      return;
    }
    const input = nameInputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
    onNameFocused();
  }, [focusName, onNameFocused]);

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
    qualityValueUnit: `${idBase}-quality-value-unit`,
    qualityHint: `${idBase}-quality-hint`,
    qualityError: `${idBase}-quality-error`,
    resolution: `${idBase}-resolution`,
    resolutionW: `${idBase}-resolution-w`,
    resolutionWUnit: `${idBase}-resolution-w-unit`,
    resolutionH: `${idBase}-resolution-h`,
    resolutionHUnit: `${idBase}-resolution-h-unit`,
    resolutionError: `${idBase}-resolution-error`,
    frameRate: `${idBase}-frame-rate`,
    frameRateN: `${idBase}-frame-rate-n`,
    frameRateD: `${idBase}-frame-rate-d`,
    frameRateError: `${idBase}-frame-rate-error`,
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
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <FormGroup legend={t("settings.preset.groupGeneral")}>
        {/* Preset Name */}
        <FieldLabel htmlFor={ids.name}>{t("settings.preset.nameLabel")}</FieldLabel>
        <Input
          ref={nameInputRef}
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

        {/* Container */}
        <FieldLabel htmlFor={ids.container}>
          {t("settings.preset.containerLabel")}
        </FieldLabel>
        <Select
          value={draft.container}
          onValueChange={(val) => controller.setContainer(val as PresetContainer)}
        >
          <SelectTrigger
            id={ids.container}
            aria-invalid={containerInvalid}
            aria-describedby={joinDescribedBy(containerInvalid && ids.containerError)}
            className="w-full min-w-0"
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
      </FormGroup>

      <FormGroup legend={t("settings.preset.groupVideo")}>
        {/* Video Encoder */}
        <FieldLabel htmlFor={ids.videoEncoder}>
          {t("settings.preset.videoEncoderLabel")}
        </FieldLabel>
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
            className="w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {videoSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <EncoderOptionLabel>
                  {translate(option.labelKey, option.labelValues)}
                </EncoderOptionLabel>
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
              "col-start-2 text-xs",
              videoSelect.currentReasonTone === "warning"
                ? "text-warning-text"
                : "text-muted-foreground",
            )}
          >
            {translate(videoSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.videoEncoderIsCustom ? (
          <>
            <FieldLabel htmlFor={ids.videoEncoderCustom}>
              {t("settings.encoder.customLabel")}
            </FieldLabel>
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
              className="col-start-2 text-xs text-muted-foreground"
            >
              {t("settings.encoder.customHint")}
            </p>
          </>
        ) : null}

        {/* Quality Kind and Value */}
        <FieldLabel htmlFor={ids.qualityKind}>
          {t("settings.preset.qualityKindLabel")}
        </FieldLabel>
        <Select
          value={draft.quality.kind}
          onValueChange={(val) => controller.setQualityKind(val as QualityKind)}
        >
          <SelectTrigger id={ids.qualityKind} className="w-full min-w-0">
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

        <FieldLabel htmlFor={ids.qualityValue}>
          {t("settings.preset.qualityValueLabel")}
        </FieldLabel>
        <NumberInput
          id={ids.qualityValue}
          field={qualityInput}
          unit={qualityInput.unitKey ? translate(qualityInput.unitKey) : undefined}
          unitId={ids.qualityValueUnit}
          aria-invalid={qualityInvalid}
          aria-describedby={joinDescribedBy(
            qualityInvalid && ids.qualityError,
            qualityInput.unitKey !== undefined && ids.qualityValueUnit,
            ids.qualityHint,
          )}
          value={presentNumericField(draft.quality.value)}
          onChange={(e) => controller.updateQualityValue(e.target.value)}
        />
        <FieldError
          id={ids.qualityError}
          messages={issueGroups.quality}
          translate={translate}
        />
        <p id={ids.qualityHint} className="col-start-2 text-xs text-muted-foreground">
          {translate(qualityInput.hintKey)}
        </p>

        {/* Resolution */}
        <FieldLabel htmlFor={ids.resolution}>
          {t("settings.preset.resolutionLabel")}
        </FieldLabel>
        <Select
          value={view.resolutionChoice}
          onValueChange={(val) => controller.chooseResolution(val)}
        >
          <SelectTrigger id={ids.resolution} className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {resolutionSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, option.labelValues)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {view.resolutionChoice === OUTPUT_CUSTOM_VALUE &&
        draft.resolution !== "source" ? (
          <>
            <FieldLabel htmlFor={ids.resolutionW}>
              {t("settings.preset.widthLabel")}
            </FieldLabel>
            <NumberInput
              id={ids.resolutionW}
              field={resolutionInput}
              unit={pixelUnit}
              unitId={ids.resolutionWUnit}
              aria-invalid={resolutionInvalid.w}
              aria-describedby={joinDescribedBy(
                resolutionInvalid.w && ids.resolutionError,
                ids.resolutionWUnit,
              )}
              value={presentNumericField(draft.resolution.w)}
              onChange={(e) => controller.updateResolutionField("w", e.target.value)}
            />
            <FieldLabel htmlFor={ids.resolutionH}>
              {t("settings.preset.heightLabel")}
            </FieldLabel>
            <NumberInput
              id={ids.resolutionH}
              field={resolutionInput}
              unit={pixelUnit}
              unitId={ids.resolutionHUnit}
              aria-invalid={resolutionInvalid.h}
              aria-describedby={joinDescribedBy(
                resolutionInvalid.h && ids.resolutionError,
                ids.resolutionHUnit,
              )}
              value={presentNumericField(draft.resolution.h)}
              onChange={(e) => controller.updateResolutionField("h", e.target.value)}
            />
            {/* One message for the pair: `validatePresetFields` reports the width and the
                height as one field. Only the input with the bad value is marked. */}
            <FieldError
              id={ids.resolutionError}
              messages={issueGroups.resolution}
              translate={translate}
            />
          </>
        ) : null}

        {/* Frame Rate */}
        <FieldLabel htmlFor={ids.frameRate}>
          {t("settings.preset.frameRateLabel")}
        </FieldLabel>
        <Select
          value={view.frameRateChoice}
          onValueChange={(val) => controller.chooseFrameRate(val)}
        >
          <SelectTrigger id={ids.frameRate} className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {frameRateSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {translate(option.labelKey, option.labelValues)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {view.frameRateChoice === OUTPUT_CUSTOM_VALUE &&
        draft.frameRate !== "source" ? (
          <>
            <FieldLabel htmlFor={ids.frameRateN}>
              {t("settings.preset.frameRateNumeratorLabel")}
            </FieldLabel>
            <NumberInput
              id={ids.frameRateN}
              field={frameRateTermInput}
              aria-invalid={frameRateInvalid.n}
              aria-describedby={joinDescribedBy(
                frameRateInvalid.n && ids.frameRateError,
              )}
              value={presentNumericField(draft.frameRate.n)}
              onChange={(e) => controller.updateFrameRateField("n", e.target.value)}
            />
            <FieldLabel htmlFor={ids.frameRateD}>
              {t("settings.preset.frameRateDenominatorLabel")}
            </FieldLabel>
            <NumberInput
              id={ids.frameRateD}
              field={frameRateTermInput}
              aria-invalid={frameRateInvalid.d}
              aria-describedby={joinDescribedBy(
                frameRateInvalid.d && ids.frameRateError,
              )}
              value={presentNumericField(draft.frameRate.d)}
              onChange={(e) => controller.updateFrameRateField("d", e.target.value)}
            />
            {/* One message for the pair, as for the resolution above. */}
            <FieldError
              id={ids.frameRateError}
              messages={issueGroups.frameRate}
              translate={translate}
            />
          </>
        ) : null}
      </FormGroup>

      <FormGroup legend={t("settings.preset.groupAudio")}>
        {/* Audio Encoder */}
        <FieldLabel htmlFor={ids.audioEncoder}>
          {t("settings.preset.audioEncoderLabel")}
        </FieldLabel>
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
            className="w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {audioSelect.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <EncoderOptionLabel>
                  {translate(option.labelKey, option.labelValues)}
                </EncoderOptionLabel>
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
              "col-start-2 text-xs",
              audioSelect.currentReasonTone === "warning"
                ? "text-warning-text"
                : "text-muted-foreground",
            )}
          >
            {translate(audioSelect.currentReasonKey)}
          </p>
        ) : null}
        {view.audioEncoderIsCustom ? (
          <>
            <FieldLabel htmlFor={ids.audioEncoderCustom}>
              {t("settings.encoder.customLabel")}
            </FieldLabel>
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
              className="col-start-2 text-xs text-muted-foreground"
            >
              {t("settings.encoder.customHint")}
            </p>
          </>
        ) : null}

        {/* Audio Bitrate */}
        <FieldLabel htmlFor={ids.audioBitrate}>
          {t("settings.preset.audioBitrateLabel")}
        </FieldLabel>
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
            className="w-full min-w-0"
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
        {bitrateSelect.hintKey ? (
          <p
            id={ids.audioBitrateHint}
            className="col-start-2 text-xs text-muted-foreground"
          >
            {translate(bitrateSelect.hintKey)}
          </p>
        ) : null}

        {/* Audio Sample Rate */}
        <FieldLabel htmlFor={ids.audioSampleRate}>
          {t("settings.preset.audioSampleRateLabel")}
        </FieldLabel>
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
            className="w-full min-w-0"
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

        {/* Audio Channels */}
        <FieldLabel htmlFor={ids.audioChannels}>
          {t("settings.preset.audioChannelsLabel")}
        </FieldLabel>
        <Select
          value={draft.audioChannels}
          onValueChange={(val) =>
            controller.setAudioChannels(val as PresetAudioChannels)
          }
        >
          <SelectTrigger id={ids.audioChannels} className="w-full min-w-0">
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
      </FormGroup>

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
    </div>
  );
}

/**
 * The footer of the editor pane: Save and Cancel, the lines that say the draft is unsaved or
 * why Save is off, and Set as Default. The section puts it under `PresetEditor`, outside the
 * scrolling fields, so it stays at the bottom of the pane at every scroll position. Duplicate
 * and Delete are in the toolbar under the list.
 */
function PresetEditorFooter({
  draft,
  view,
  controller,
}: {
  draft: Preset;
  view: PresetLibraryView;
  controller: PresetLibraryController;
}) {
  const { t } = useTranslation();
  const translate = t as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;
  const saveBlocked = presentSaveBlockedSummary(view.issues);
  const idBase = useId();
  const saveBlockedId = `${idBase}-save-blocked`;

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={!view.canSave || view.pending}
          aria-describedby={joinDescribedBy(saveBlocked !== null && saveBlockedId)}
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
          <span id={saveBlockedId} className="text-xs text-destructive-text">
            {translate(saveBlocked.key, saveBlocked.values)}
          </span>
        ) : null}
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={view.pending || draft.id === view.activePresetId}
        onClick={() => {
          void controller.setActive(draft.id);
        }}
      >
        {t("settings.preset.setDefault")}
      </Button>
    </div>
  );
}

/**
 * The control that takes the focus after a write:
 * - `add`: the Add button, after an Add that did not select a new preset, when the write
 *   dropped the focus (see `pickCreateFailureFocus`).
 * - `more`: the menu button of the toolbar, after a Duplicate that did not select a copy, on
 *   the same condition.
 * - `list`: the Tab stop of the preset list, or Add when the list is empty, after every delete
 *   that succeeded. One rule, whatever opened the confirmation: a list row or the Delete
 *   button, and whatever the speed of the write.
 */
type FocusReturnTarget = "add" | "more" | "list";

export interface PresetLibrarySectionProps {
  /**
   * Receives the state of the draft and the actions that settle it, each time the state
   * changes, and `CLEAN_PRESET_DRAFT_GUARD` when the section unmounts. The settings dialog
   * reads it to keep a close request from dropping an unsaved draft. Pass a stable function,
   * such as a state setter.
   */
  onDraftChange?: (guard: PresetDraftGuard) => void;
  /**
   * True while the settings dialog shows its own unsaved-changes prompt. A switch to another
   * preset, or Add, then opens no second prompt, and calls `onFocusClosePrompt` instead.
   */
  closePromptOpen?: boolean;
  /** Moves the focus to the unsaved-changes prompt of the settings dialog. */
  onFocusClosePrompt?: () => void;
  /**
   * True while the Export Presets tab is the visible tab. The panels stay mounted when they
   * are hidden, and a hidden list cannot scroll its selected row into view. Default true.
   */
  visible?: boolean;
}

/**
 * The Export Presets tab. It has two panes: the preset list with its toolbar on the left, and
 * the editor of the selected preset on the right. The section fills the height that the
 * settings dialog gives the tab, and each pane scrolls on its own, so the dialog keeps its
 * height when the selection changes.
 */
export function PresetLibrarySection({
  onDraftChange,
  closePromptOpen = false,
  onFocusClosePrompt,
  visible = true,
}: PresetLibrarySectionProps) {
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

  // Only `status` and `results` reach `presentEncoderSelect` and `presentPresetEncoderMark`.
  // Selecting the two fields with a shallow comparison keeps a capability-probe write that
  // touches neither from re-rendering the whole preset library.
  const ffmpegState = useFfmpegStore(
    useShallow((state) => ({ status: state.status, results: state.results })),
  );
  const [pendingView, setView] = useState<PresetLibraryView | null>(null);

  // What the user asked for while an edit is unsaved. The controller documents that `select`
  // discards a dirty draft without warning, and `addPreset` refuses to add over one, so both
  // leave the confirmation to the view; this holds the pending request until the user answers.
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  // The element that held the focus when the prompt opened. "Keep Editing" gives it back: the
  // row the user was on for a request from the list, or the field the user was editing.
  const promptReturnFocusRef = useRef<HTMLElement | null>(null);
  const promptCancelRef = useRef<HTMLButtonElement>(null);
  const promptMessageRef = useRef<HTMLSpanElement>(null);
  // Counts the requests of the settings dialog to move the focus to the prompt. See
  // `PresetDraftGuard.focusLeavePrompt`.
  const [leavePromptFocusRequests, setLeavePromptFocusRequests] = useState(0);

  // The preset whose name field takes the focus once: after Add or Duplicate created it, or
  // after Enter or F2 on its row. The editor of that preset clears it when the field has the
  // focus.
  const [focusNameId, setFocusNameId] = useState<string | null>(null);
  const handleNameFocused = useCallback(() => {
    setFocusNameId(null);
  }, []);

  // The control that takes the focus back after a write that dropped it. Each request is a new
  // object, and the effect below handles each object once, when the write is over.
  const listRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [focusReturn, setFocusReturn] = useState<{
    readonly target: FocusReturnTarget;
  } | null>(null);
  const handledFocusReturnRef = useRef<typeof focusReturn>(null);

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

  // Drop the pending request as soon as the draft is clean, derived during render the way
  // `PreviewPane` clears its decode error. A Save or a Cancel elsewhere in the editor clears
  // `dirty` only, so without this the prompt would merely hide while still holding the old
  // request: a later edit would bring it back aimed at a request the user never answered for,
  // and its Discard button would throw away an edit nobody offered to discard.
  if (pendingLeave !== null && !view.dirty) {
    setPendingLeave(null);
  }

  useEffect(() => {
    controller.activate();
    return () => {
      controller.deactivate();
    };
  }, [controller]);

  // The tab opens on the default (active) preset, or on the first preset when no preset has the
  // active id (see `pickDefaultPresetId`). This runs once for each open of the dialog, because
  // the dialog mounts this section when it opens. It does not run again when a later change
  // clears the selection: a delete selects the neighbour itself, and a restore of the built-in
  // presets selects the default (active) preset itself (see `confirmDelete` and
  // `restoreDefaults`).
  const initialSelectionDoneRef = useRef(false);
  useEffect(() => {
    if (initialSelectionDoneRef.current || !view.ready) {
      return;
    }
    initialSelectionDoneRef.current = true;
    if (view.selectedPresetId !== null) {
      return;
    }
    const id = pickDefaultPresetId(view.presets, view.activePresetId);
    if (id !== null) {
      controller.select(id);
    }
  }, [
    controller,
    view.ready,
    view.selectedPresetId,
    view.presets,
    view.activePresetId,
  ]);

  // The row that takes the selection after the delete in flight, or null. See
  // `findListFocusRow`.
  const deleteNeighbourIdRef = useRef<string | null>(null);

  // The element that the list gives the focus to: the neighbour of a delete in flight while it
  // is on screen, else the row that holds the Tab stop, else the Add button when the list is
  // empty. It reads the rendered rows, not the controller. The store publishes a write before
  // it reaches the disk, so while a delete is in flight the controller already reads a library
  // without the deleted row, and the rows on screen still show it.
  const findListFocusTarget = useCallback(
    (): HTMLElement | null =>
      findListFocusRow(listRef.current, deleteNeighbourIdRef.current) ??
      addButtonRef.current,
    [],
  );

  // Each button is disabled while the write is in flight, so the effect waits until `pending`
  // is false and the target can take the focus. See `FocusReturnTarget` for which control
  // takes it.
  useEffect(() => {
    if (
      focusReturn === null ||
      view.pending ||
      handledFocusReturnRef.current === focusReturn
    ) {
      return;
    }
    handledFocusReturnRef.current = focusReturn;
    switch (focusReturn.target) {
      case "add":
      case "more":
        pickCreateFailureFocus(
          toPromptFocusTarget(
            focusReturn.target === "add" ? addButtonRef.current : moreButtonRef.current,
          ),
          document.activeElement,
        )?.focus();
        return;
      case "list":
        // The confirmation gives the focus to the same element when it closes after the
        // write (`confirmFocus`). This call covers a write that ends after the confirmation
        // closed, when the deleted row that held the focus leaves the list.
        findListFocusTarget()?.focus();
        deleteNeighbourIdRef.current = null;
        return;
    }
  }, [findListFocusTarget, focusReturn, view.pending]);

  // Report the draft upward. The guard is rebuilt only when one of its values changes, so the
  // dialog renders again only then. The actions call the controller, which owns the draft.
  const { dirty, presetName, canSave, pending } = presentPresetDraftStatus(view);
  // The prompt shows while a request waits and the draft holds an unsaved edit, which is when
  // `presentUnsavedDraftPrompt` presents one.
  const leavePromptShown = pendingLeave !== null && dirty;
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
      leavePromptOpen: leavePromptShown,
      focusLeavePrompt: () => {
        setLeavePromptFocusRequests((count) => count + 1);
      },
    }),
    [controller, dirty, presetName, canSave, pending, leavePromptShown],
  );
  const unsavedPrompt = presentUnsavedDraftPrompt(draftGuard);

  // The prompt takes the focus when it opens, as the prompt of the settings dialog does: "Keep
  // Editing", so Enter picks the choice that changes nothing. A request from the list thus
  // takes a keyboard user from the row to the prompt. A new request while the prompt is open
  // only changes its target, and the focus stays where it is. A close request of the settings
  // dialog while the prompt is open brings the focus back to it (`focusLeavePrompt`). That
  // request can also switch to this tab, and the effect runs after the tab is visible.
  useEffect(() => {
    if (leavePromptShown) {
      pickPromptOpenFocus(
        toPromptFocusTarget(promptCancelRef.current),
        toPromptFocusTarget(promptMessageRef.current),
      )?.focus();
    }
  }, [leavePromptShown, leavePromptFocusRequests]);

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

  const focusRow = (id: string) => {
    findPresetRow(listRef.current, id)?.focus();
  };

  // Opens the prompt for `request`, or changes the target of the prompt that is open.
  const raiseLeavePrompt = (request: PendingLeave) => {
    if (pendingLeave === null) {
      const active = document.activeElement;
      promptReturnFocusRef.current = pickPromptReturnFocus(
        active instanceof HTMLElement ? active : null,
        document.body,
      );
    }
    setPendingLeave(request);
  };

  // Selects the row `id` from the list, through the unsaved-draft guard, and moves the focus to
  // it. The selection follows the focus, so the focus moves only with the selection: while a
  // prompt asks about the draft, the selection and the focus stay on the old row. See
  // `decideLeaveRequest`.
  const handleSelectRow = (id: string) => {
    if (id === view.selectedPresetId) {
      focusRow(id);
      return;
    }
    switch (decideLeaveRequest(view, closePromptOpen)) {
      case "ignore":
        return;
      case "defer":
        onFocusClosePrompt?.();
        return;
      case "raise":
        raiseLeavePrompt({ kind: "select", id });
        return;
      case "leave":
        controller.select(id);
        focusRow(id);
        return;
    }
  };

  // Enter or F2 on a row. A row that holds the focus is the selected row, except the first row
  // while no preset is selected, and then there is no draft to guard.
  const handleEditName = (id: string) => {
    if (id !== view.selectedPresetId) {
      if (decideLeaveRequest(view, closePromptOpen) !== "leave") {
        return;
      }
      controller.select(id);
    }
    setFocusNameId(id);
  };

  // The controller picks the first free name from these forms, in the document it writes.
  // The name is then user data and is never translated again (ADR 013).
  const addNewPreset = async () => {
    const id = await controller.addPreset({
      base: t("settings.preset.newName"),
      numbered: (n) => translate("settings.preset.newNameNumbered", { n }),
    });
    if (id !== null) {
      setFocusNameId(id);
    } else {
      setFocusReturn({ target: "add" });
    }
  };

  const handleRequestAdd = () => {
    switch (decideLeaveRequest(view, closePromptOpen)) {
      case "ignore":
        return;
      case "defer":
        onFocusClosePrompt?.();
        return;
      case "raise":
        raiseLeavePrompt({ kind: "add" });
        return;
      case "leave":
        void addNewPreset();
        return;
    }
  };

  // Duplicate is off while the draft is dirty, so this never runs over an unsaved edit. See
  // `presentDuplicatePresetAction`. The forms carry the name slot and not the source name:
  // the source name must not go through i18next (see `PRESET_NAME_SLOT`).
  const handleDuplicate = async (id: string) => {
    const copyId = await controller.duplicatePreset(id, {
      base: translate("settings.preset.copyName", { name: PRESET_NAME_SLOT }),
      numbered: (n) =>
        translate("settings.preset.copyNameNumbered", { name: PRESET_NAME_SLOT, n }),
    });
    if (copyId !== null) {
      setFocusNameId(copyId);
    } else {
      setFocusReturn({ target: "more" });
    }
  };

  // Carries out a pending request. The caller first makes the draft clean. The prompt that held
  // the focus closes, so a switch gives the focus to the row it selects, and the list stays
  // where the keyboard user left it.
  const leave = (request: PendingLeave) => {
    if (request.kind === "select") {
      controller.select(request.id);
      focusRow(request.id);
    } else {
      void addNewPreset();
    }
  };

  // The request is a parameter and is not read from state after the save: a save that leaves
  // the draft clean also clears `pendingLeave`, as described above.
  const handleSaveAndLeave = async (request: PendingLeave) => {
    // The save disables every choice while it runs, and a disabled button drops the focus to
    // the document body. The message keeps the focus inside the prompt, as in the prompt of the
    // settings dialog.
    promptMessageRef.current?.focus();
    if (await controller.saveDraftBeforeLeaving()) {
      leave(request);
    }
  };

  const handleKeepEditing = () => {
    const returnFocus = promptReturnFocusRef.current;
    promptReturnFocusRef.current = null;
    setPendingLeave(null);
    pickPromptCancelFocus(
      toPromptFocusTarget(returnFocus),
      toPromptFocusTarget(findPresetRow(listRef.current, view.selectedPresetId)),
    )?.focus();
  };

  const handleRequestDelete = (id: string) => {
    const prompt = presentDeletePresetConfirm(view.presets, view.activePresetId, id);
    if (prompt !== null) {
      setDeleteConfirm({ open: true, prompt });
    }
  };

  // The selection moves to the row that takes the place of the deleted row, so the editor pane
  // is empty only when the library is. The controller clears the selection when it deletes the
  // selected preset, and it cannot know the neighbour after the write, because the deleted row
  // is gone by then.
  const confirmDelete = async (id: string) => {
    const next = pickSelectionAfterDelete(
      view.presets.map((preset) => preset.id),
      id,
    );
    // The confirmation calls `findListFocusTarget` when it closes, which can be while the
    // write is in flight. The neighbour then takes the focus at once, and keeps it.
    deleteNeighbourIdRef.current = next;
    if (!(await controller.deletePreset(id))) {
      // The preset stays, and so does the selection. The focus goes back to the selected row,
      // away from the neighbour that the confirmation may have focused.
      deleteNeighbourIdRef.current = null;
      setFocusReturn({ target: "list" });
      return;
    }
    if (controller.getView().selectedPresetId === null && next !== null) {
      controller.select(next);
    }
    setFocusReturn({ target: "list" });
  };

  // A restore keeps every preset and the selection, so it selects a preset only when none was
  // selected, such as after a delete of the last preset. The editor pane then shows the
  // default preset, as when the tab opens.
  const restoreDefaults = async () => {
    if (!(await controller.restoreDefaults())) {
      return;
    }
    const current = controller.getView();
    if (current.selectedPresetId !== null) {
      return;
    }
    const id = pickDefaultPresetId(current.presets, current.activePresetId);
    if (id !== null) {
      controller.select(id);
    }
  };

  const addAction = presentAddPresetAction(view);
  const deleteAction = presentDeletePresetAction(view);
  const duplicateAction = presentDuplicateSelectedAction(view);
  const restoreAction = presentRestoreBuiltInAction(view);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      {!view.canAdd ? (
        <p className="text-xs text-muted-foreground">
          {translate("settings.preset.limitReached", { max: MAX_PRESETS })}
        </p>
      ) : null}

      {/* The request above is cleared once the draft is clean, so a Save or a Cancel elsewhere
          in the editor leaves no stale prompt behind. */}
      {pendingLeave !== null && unsavedPrompt !== null ? (
        <Notice
          tone="warning"
          role="alert"
          {...{ [PRESET_LEAVE_PROMPT_ATTRIBUTE]: "" }}
          onKeyDown={(event) => {
            // The settings dialog leaves Escape inside this prompt to it. See
            // `decideLeavePromptKey`.
            switch (decideLeavePromptKey(event.key, unsavedPrompt)) {
              case "keepEditing":
                event.preventDefault();
                handleKeepEditing();
                return;
              case "hold":
                event.preventDefault();
                return;
              case "ignore":
                return;
            }
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* `tabIndex={-1}` lets the message take the focus while a save disables every
                button, without adding a stop to the Tab order. */}
            <span
              ref={promptMessageRef}
              tabIndex={-1}
              className="min-w-0 wrap-break-word outline-none"
            >
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
                  // `addPreset` refuses to add over an unsaved edit, so the edit goes first.
                  controller.cancelDraft();
                  leave(pendingLeave);
                  setPendingLeave(null);
                }}
              >
                {t("settings.preset.discardConfirm")}
              </Button>
              <Button
                ref={promptCancelRef}
                variant="outline"
                size="sm"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={handleKeepEditing}
              >
                {t("settings.preset.discardCancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={unsavedPrompt.saveDisabled}
                onClick={() => {
                  void handleSaveAndLeave(pendingLeave);
                }}
              >
                {translate(presentSaveAndLeaveLabel(pendingLeave))}
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}

      {/* One row that is exactly the free height (`minmax(0,1fr)`), so a long list or a long
          editor scrolls inside its pane and never makes the grid taller than the tab. */}
      <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-3">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PresetList
              view={view}
              ffmpegState={ffmpegState}
              numberFormatter={numberFormatter}
              listRef={listRef}
              visible={visible}
              onSelectRow={handleSelectRow}
              onEditName={handleEditName}
              onDeleteRow={handleRequestDelete}
            />
          </div>
          <PresetListToolbar
            add={addAction}
            remove={deleteAction}
            duplicate={duplicateAction}
            restore={restoreAction}
            menuDisabled={!view.ready}
            addButtonRef={addButtonRef}
            moreButtonRef={moreButtonRef}
            onAdd={handleRequestAdd}
            onDelete={() => {
              if (view.selectedPresetId !== null) {
                handleRequestDelete(view.selectedPresetId);
              }
            }}
            onDuplicate={() => {
              if (view.selectedPresetId !== null) {
                void handleDuplicate(view.selectedPresetId);
              }
            }}
            onRestore={() => {
              setRestoreConfirmOpen(true);
            }}
          />
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/20">
          {view.draft ? (
            <>
              <PresetEditor
                key={view.draft.id}
                draft={view.draft}
                view={view}
                controller={controller}
                ffmpegState={ffmpegState}
                numberFormatter={numberFormatter}
                focusName={focusNameId === view.draft.id}
                onNameFocused={handleNameFocused}
              />
              <PresetEditorFooter
                draft={view.draft}
                view={view}
                controller={controller}
              />
            </>
          ) : view.ready ? (
            <p className="m-auto p-3 text-xs text-muted-foreground">
              {t("settings.preset.noSelection")}
            </p>
          ) : null}
        </div>
      </div>

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
            void confirmDelete(deleteConfirm.prompt.presetId);
          }
        }}
        // After a confirm, the list takes the focus, on the row that takes the selection, or
        // Add when the list is empty, whatever opened the dialog. A cancel gives the focus back
        // to the opener, or to the list when nothing held the focus when the dialog opened.
        confirmFocus={findListFocusTarget}
        fallbackFocus={findListFocusTarget}
      />
      <ConfirmDialog
        open={restoreConfirmOpen}
        onOpenChange={setRestoreConfirmOpen}
        title={translate(restorePrompt.title.key)}
        description={translate(restorePrompt.description.key)}
        confirmLabel={t("settings.preset.restoreBuiltIn")}
        cancelLabel={t("common.cancel")}
        destructive
        confirmDisabled={view.ready ? view.pending : true}
        onConfirm={() => {
          void restoreDefaults();
        }}
      />
    </section>
  );
}
