import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Notice } from "@/components/common/Notice";
import { ShortcutTooltipContent } from "@/components/common/ShortcutTooltipContent";
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
  isUnsavedPresetRow,
  pickCreateFailureFocus,
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
  presentDuplicatePresetAction,
  presentEncoderSelect,
  presentFrameRateInvalid,
  presentFrameRateSelect,
  presentFrameRateTermInput,
  presentNumericField,
  presentPresetEncoderMark,
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

function PresetEditor({
  draft,
  view,
  controller,
  ffmpegState,
  focusName,
  onNameFocused,
  duplicateButtonRef,
  onRequestDuplicate,
  onRequestDelete,
}: {
  draft: Preset;
  view: PresetLibraryView;
  controller: PresetLibraryController;
  ffmpegState: Pick<FfmpegState, "status" | "results">;
  /**
   * True when Add or Duplicate just created this preset. The name field then takes the focus
   * once, with its text selected, and the editor calls `onNameFocused`.
   */
  focusName: boolean;
  /** Reports that the name field took the focus, so the section clears `focusName`. */
  onNameFocused: () => void;
  /** The Duplicate button, which takes the focus back after a Duplicate that failed. */
  duplicateButtonRef: RefObject<HTMLButtonElement | null>;
  /** Duplicates the preset. The section owns the name forms and the focus. */
  onRequestDuplicate: (id: string) => void;
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
  const saveBlocked = presentSaveBlockedSummary(view.issues);
  const duplicateAction = presentDuplicatePresetAction(view);
  const duplicateReason = duplicateAction.reason
    ? translate(duplicateAction.reason.key, duplicateAction.reason.values)
    : null;

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
    saveBlocked: `${idBase}-save-blocked`,
    duplicateReason: `${idBase}-duplicate-reason`,
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
          {/* A disabled button takes no pointer events, so the span around it is the tooltip
              trigger, as in the transport bar. The span has no tabIndex, so the Tab order
              does not change. The tooltip has content only while there is a reason, so an
              enabled button shows no tooltip that repeats its label. The button names the
              reason in `aria-describedby` for a screen reader. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  ref={duplicateButtonRef}
                  variant="outline"
                  size="sm"
                  disabled={duplicateAction.disabled}
                  aria-describedby={joinDescribedBy(
                    duplicateReason !== null && ids.duplicateReason,
                  )}
                  onClick={() => {
                    onRequestDuplicate(draft.id);
                  }}
                >
                  {t("settings.preset.duplicate")}
                </Button>
                {duplicateReason !== null ? (
                  <span id={ids.duplicateReason} className="sr-only">
                    {duplicateReason}
                  </span>
                ) : null}
              </span>
            </TooltipTrigger>
            {duplicateReason !== null ? (
              <ShortcutTooltipContent
                label={t("settings.preset.duplicate")}
                reason={duplicateReason}
              />
            ) : null}
          </Tooltip>
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

/** The two buttons that create a preset. See `pickCreateFailureFocus`. */
type CreateButton = "add" | "duplicate";

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

  // What the user asked for while an edit is unsaved. The controller documents that `select`
  // discards a dirty draft without warning, and `addPreset` refuses to add over one, so both
  // leave the confirmation to the view; this holds the pending request until the user answers.
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);

  // The preset whose name field takes the focus once, after Add or Duplicate created it. The
  // editor of that preset clears it when the field has the focus.
  const [focusNameId, setFocusNameId] = useState<string | null>(null);
  const handleNameFocused = useCallback(() => {
    setFocusNameId(null);
  }, []);

  // The button that takes the focus back after an Add or a Duplicate that did not select a
  // new preset. Each such result is a new request object, and the effect below handles each
  // object once, when the write is over.
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const duplicateButtonRef = useRef<HTMLButtonElement>(null);
  const [focusReturn, setFocusReturn] = useState<{
    readonly button: CreateButton;
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

  // The button is disabled while the write is in flight, so the effect waits until `pending`
  // is false and the button can take the focus. See `pickCreateFailureFocus` for when the
  // focus moves.
  useEffect(() => {
    if (
      focusReturn === null ||
      view.pending ||
      handledFocusReturnRef.current === focusReturn
    ) {
      return;
    }
    handledFocusReturnRef.current = focusReturn;
    const button =
      focusReturn.button === "add" ? addButtonRef.current : duplicateButtonRef.current;
    pickCreateFailureFocus(
      toPromptFocusTarget(button),
      document.activeElement,
    )?.focus();
  }, [focusReturn, view.pending]);

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
      setPendingLeave({ kind: "select", id });
      return;
    }
    controller.select(id);
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
      setFocusReturn({ button: "add" });
    }
  };

  const handleRequestAdd = () => {
    if (view.pending) {
      return;
    }
    if (view.dirty) {
      setPendingLeave({ kind: "add" });
      return;
    }
    void addNewPreset();
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
      setFocusReturn({ button: "duplicate" });
    }
  };

  // Carries out a pending request. The caller first makes the draft clean.
  const leave = (request: PendingLeave) => {
    if (request.kind === "select") {
      controller.select(request.id);
    } else {
      void addNewPreset();
    }
  };

  // The request is a parameter and is not read from state after the save: a save that leaves
  // the draft clean also clears `pendingLeave`, as described above.
  const handleSaveAndLeave = async (request: PendingLeave) => {
    if (await controller.saveDraftBeforeLeaving()) {
      leave(request);
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
            ref={addButtonRef}
            onClick={handleRequestAdd}
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

      {/* The request above is cleared once the draft is clean, so a Save or a Cancel elsewhere
          in the editor leaves no stale prompt behind. */}
      {pendingLeave !== null && unsavedPrompt !== null ? (
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
                  // `addPreset` refuses to add over an unsaved edit, so the edit goes first.
                  controller.cancelDraft();
                  leave(pendingLeave);
                  setPendingLeave(null);
                }}
              >
                {t("settings.preset.discardConfirm")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={unsavedPrompt.choicesDisabled}
                onClick={() => setPendingLeave(null)}
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
          focusName={focusNameId === view.draft.id}
          onNameFocused={handleNameFocused}
          duplicateButtonRef={duplicateButtonRef}
          onRequestDuplicate={(id) => {
            void handleDuplicate(id);
          }}
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
