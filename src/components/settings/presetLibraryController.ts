/**
 * Pure preset library controller for the export preset library dialog.
 *
 * The repository has no jsdom and no `@testing-library`, so all dialog logic lives in a
 * tested `.ts` module and the paired `.tsx` view contains only `view.x ? A : B`. This
 * controller is the tested module for the preset library screen.
 *
 * It is DELIBERATELY THINNER than `LanguageMenuController`. The settings store already owns
 * the serialized write queue, the optimistic display state, and the rollback anchor (see
 * `src/features/settings/store.ts`). Adding a second queue, a second monotonic request id, or
 * a second rollback anchor here would mean two systems racing to own one file -- a bug, not
 * redundancy. This controller owns exactly one thing the store cannot know: the unsaved
 * draft. Everything else it reads from the settings document and writes through the store's
 * `saveSettings` action.
 */

import {
  addPreset as addPresetToDocument,
  createPresetDraft,
  DEFAULT_CUSTOM_FRAME_RATE,
  DEFAULT_CUSTOM_RESOLUTION,
  deletePreset as deletePresetFromDocument,
  setActivePreset,
  updatePreset,
} from "@/features/settings/presetDocument";
import {
  canAddPreset,
  defaultQualityValue,
  validatePresetFields,
  type PresetFieldIssue,
} from "@/features/settings/limits";
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  isLosslessAudioEncoder,
} from "@/features/settings/audioCodecs";
import {
  nextFreeCopyName,
  nextFreePresetName,
  type CopyNameForms,
  type PresetNameForms,
} from "@/features/settings/presetNaming";
// Import the store MODULE directly, never the "@/features/settings" barrel. The barrel also
// re-exports "./client", whose `saveSettings` is the raw IPC call that bypasses the store's
// serialized write queue (ADR 013). Taking that export by mistake would let this controller's
// whole-document writes race the store's own writes and silently revert the settings file.
import { settingsStore } from "@/features/settings/store";
import type {
  Preset,
  PresetAudioChannels,
  PresetAudioSampleRate,
  PresetContainer,
  QualityKind,
  Settings,
} from "@/features/settings/types";

/**
 * Sentinel value for the "custom encoder" choice in an encoder `<Select>`.
 *
 * MUST NOT be a value `isValidEncoderName` accepts (guarded by a test in
 * `presetLibraryController.test.ts`): if it were, choosing "custom" from the list would be
 * indistinguishable from the user typing this exact literal string as a real encoder name.
 */
export const CUSTOM_ENCODER_VALUE = "__custom__";

/**
 * Parses raw text from a numeric input into an integer, or `NaN` when the field is blank or
 * the text does not parse to a whole number.
 *
 * `Number("")` and `Number("   ")` both evaluate to `0` in JavaScript, which would let an
 * emptied field masquerade as a real, in-range value -- crf 0 is a valid CRF. Checking for a
 * blank string BEFORE calling `Number` is what keeps a cleared field from silently becoming a
 * valid 0. It is also what keeps the field clearable at all: writing 0 back into a controlled
 * input re-renders its value as "0", so the next keystroke reads "0" followed by the typed
 * digit instead of replacing it. Storing `NaN` instead renders as an empty string, which a new
 * keystroke replaces cleanly.
 *
 * Every field this parses -- quality, resolution, frame rate -- is an integer on the wire
 * (Rust reads each as a bounded integer), so a fractional value such as "1.5" is exactly as
 * invalid as blank or non-numeric text and also maps to `NaN`, not to the literal fraction.
 *
 * `NaN` is never a safe integer (`Number.isSafeInteger(NaN) === false`), so
 * `validatePresetFields` reports `notInteger` for it, `canSave` becomes false, and the user
 * sees why -- rather than the field silently accepting an out-of-range or wrong value.
 */
function parseNumericField(raw: string): number {
  if (raw.trim() === "") {
    return Number.NaN;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Deep-copies a preset so mutating the copy never alters the stored preset.
 *
 * A shallow `{ ...preset }` shares `quality`, `resolution`, and `frameRate` with the stored
 * document, because those fields are themselves objects (except when `resolution` or
 * `frameRate` holds the literal string "source"). Writing `draft.quality.value = 63` on a
 * shallow copy would mutate the settings document in place.
 */
function clonePreset(preset: Preset): Preset {
  return {
    ...preset,
    quality: { ...preset.quality },
    resolution: preset.resolution === "source" ? "source" : { ...preset.resolution },
    frameRate: preset.frameRate === "source" ? "source" : { ...preset.frameRate },
  };
}

/**
 * Snapshot of preset library state for the view layer to render.
 */
export type PresetLibraryView = {
  presets: Preset[];
  selectedPresetId: string | null;
  activePresetId: string | null;
  draft: Preset | null;
  dirty: boolean;
  issues: PresetFieldIssue[];
  canAdd: boolean;
  canSave: boolean;
  pending: boolean;

  /**
   * Whether a settings document is available. False while the store has not loaded yet, which
   * lets the view tell "still loading" apart from "no presets" and keep Add disabled instead
   * of enabled-but-silently-refusing.
   */
  ready: boolean;

  /**
   * Whether the user explicitly chose the "custom" option for the video encoder. This is
   * controller state, NOT derived from the draft: a preset whose stored encoder simply is not
   * in the probe list is a normal unavailable option, not custom. Reset to false whenever a
   * different draft is loaded.
   */
  videoEncoderIsCustom: boolean;

  /** Same as `videoEncoderIsCustom`, for the audio encoder. */
  audioEncoderIsCustom: boolean;

  /** "source" when the draft's resolution is the literal string "source", else "custom". */
  resolutionMode: "source" | "custom";

  /** "source" when the draft's frame rate is the literal string "source", else "custom". */
  frameRateMode: "source" | "custom";
};

/**
 * Options for configuring a `PresetLibraryController` instance.
 *
 * Every collaborator is an optional injected function. Its production default is resolved at
 * call time from the settings store singleton, so a stale reference is never captured.
 */
export interface PresetLibraryControllerOptions {
  /**
   * Reads the current settings document. Defaults to the settings store's current state.
   * Returns `null` before the store has loaded.
   */
  getSettings?: () => Settings | null;

  /**
   * Persists a whole settings document through the store's serialized write queue.
   * Defaults to `settingsStore.getState().saveSettings`. Resolves `null` on failure; never
   * rejects.
   */
  saveSettings?: (settings: Settings) => Promise<Settings | null>;

  /**
   * Restores the default preset seeds. Defaults to
   * `settingsStore.getState().restoreDefaultPresets`. Resolves `null` on failure; never
   * rejects.
   */
  restoreDefaultPresets?: () => Promise<Settings | null>;

  /**
   * Generates an id for a newly created preset. Defaults to `crypto.randomUUID`.
   */
  generateId?: () => string;

  /**
   * Callback invoked with the latest view whenever it changes while the controller is active.
   */
  onChange?: (view: PresetLibraryView) => void;
}

/**
 * Controller managing the export preset library dialog: selection, the unsaved draft, and the
 * writes that commit a draft to the settings document.
 *
 * STALE-BASE HAZARD: `restoreDefaultPresets` publishes its restored document only after the
 * IPC call resolves, unlike `saveSettings`, which the store applies optimistically. A write
 * action (`saveDraft`, `addPreset`, `duplicatePreset`, `deletePreset`, `setActive`) called
 * WHILE a restore is in flight would compute its next document from the pre-restore library
 * and could overwrite the restore on disk. The view MUST disable every write action while
 * `view.pending` is true; `pending` is exposed on the view for exactly this purpose.
 */
export class PresetLibraryController {
  private readonly getSettingsFn: () => Settings | null;
  private readonly saveSettingsFn: (settings: Settings) => Promise<Settings | null>;
  private readonly restoreDefaultPresetsFn: () => Promise<Settings | null>;
  private readonly generateIdFn: () => string;
  private readonly onChange?: (view: PresetLibraryView) => void;

  private active = true;
  private needsNotify = false;
  private pendingCount = 0;

  private selectedPresetId: string | null = null;
  private draft: Preset | null = null;
  private dirty = false;
  private issues: PresetFieldIssue[] = [];

  // Controller state, not derived from the draft: see `PresetLibraryView.videoEncoderIsCustom`.
  private videoEncoderIsCustom = false;
  private audioEncoderIsCustom = false;

  constructor(options: PresetLibraryControllerOptions = {}) {
    this.getSettingsFn =
      options.getSettings ?? (() => settingsStore.getState().settings);
    this.saveSettingsFn =
      options.saveSettings ?? ((next) => settingsStore.getState().saveSettings(next));
    this.restoreDefaultPresetsFn =
      options.restoreDefaultPresets ??
      (() => settingsStore.getState().restoreDefaultPresets());
    this.generateIdFn = options.generateId ?? (() => crypto.randomUUID());
    this.onChange = options.onChange;
  }

  /**
   * Builds the current view snapshot for the UI to render.
   */
  getView(): PresetLibraryView {
    const settings = this.getSettingsFn();
    const presets = settings?.presets ?? [];
    return {
      presets,
      selectedPresetId: this.selectedPresetId,
      activePresetId: settings?.activePresetId ?? null,
      draft: this.draft,
      dirty: this.dirty,
      issues: this.issues,
      canAdd: canAddPreset(presets.length),
      canSave: this.dirty && this.issues.length === 0,
      pending: this.pendingCount > 0,
      ready: settings !== null,
      videoEncoderIsCustom: this.videoEncoderIsCustom,
      audioEncoderIsCustom: this.audioEncoderIsCustom,
      resolutionMode:
        this.draft && this.draft.resolution !== "source" ? "custom" : "source",
      frameRateMode:
        this.draft && this.draft.frameRate !== "source" ? "custom" : "source",
    };
  }

  /**
   * Sets the selection and loads a fresh COPY of that preset as the draft, with `dirty` set to
   * false. This DISCARDS an unsaved draft without warning: the view exposes `dirty` so the
   * interface can ask the user to confirm before calling `select` on top of an edit in
   * progress.
   *
   * Passing `null` clears the selection and the draft.
   */
  select(id: string | null): void {
    this.selectedPresetId = id;
    this.loadDraftFrom(this.getSettingsFn(), id);
    this.notify();
  }

  /**
   * Merges `patch` into the current draft, recomputes `issues`, and marks the draft dirty.
   * No-op when there is no draft.
   */
  updateDraft(patch: Partial<Preset>): void {
    if (!this.draft) {
      return;
    }
    this.draft = { ...this.draft, ...patch };
    this.issues = validatePresetFields(this.draft);
    this.dirty = true;
    this.notify();
  }

  /**
   * Sets the draft's display name to `raw`, verbatim. No-op when there is no draft.
   */
  setName(raw: string): void {
    this.updateDraft({ name: raw });
  }

  /**
   * Sets the draft's output container. No-op when there is no draft.
   */
  setContainer(container: PresetContainer): void {
    this.updateDraft({ container });
  }

  /**
   * Handles a selection from an encoder `<Select>`.
   *
   * When `value` is `CUSTOM_ENCODER_VALUE`, this sets the matching `*IsCustom` flag and
   * leaves the stored encoder name UNCHANGED, so the free-text field that then opens is
   * pre-filled with whatever the preset already had. Otherwise it clears the flag and stores
   * `value` as the encoder name.
   *
   * No-op when there is no draft.
   */
  chooseEncoder(kind: "video" | "audio", value: string): void {
    if (!this.draft) {
      return;
    }
    if (value === CUSTOM_ENCODER_VALUE) {
      if (kind === "video") {
        this.videoEncoderIsCustom = true;
      } else {
        this.audioEncoderIsCustom = true;
      }
      // Nothing in the preset itself changed, but the method still recomputes issues and
      // marks the draft dirty, matching every other draft-editing method here.
      this.updateDraft({});
      return;
    }
    if (kind === "video") {
      this.videoEncoderIsCustom = false;
      this.updateDraft({ videoEncoder: value });
    } else {
      this.audioEncoderIsCustom = false;
      this.applyAudioEncoder(value);
    }
  }

  /**
   * Sets the draft's encoder name from the custom free-text field, verbatim.
   *
   * Does NOT trim `raw`. `validatePresetFields` rejects a padded name as a `charset` failure,
   * and trimming here would hide that from the user while Rust would still reject it.
   *
   * Does NOT apply the lossless encoder rule: typing free-text names must not clear or set
   * `audioBitrate` on intermediate keystrokes. Only `chooseEncoder` applies that rule.
   *
   * No-op when there is no draft.
   */
  setEncoderName(kind: "video" | "audio", raw: string): void {
    if (kind === "video") {
      this.updateDraft({ videoEncoder: raw });
    } else {
      this.updateDraft({ audioEncoder: raw });
    }
  }

  /**
   * Applies an audio encoder change to the draft, enforcing lossless vs. lossy bitrate rules (ADR 023):
   * - A new encoder that is lossless removes `audioBitrate`.
   * - A change from a lossless encoder to a non-lossless encoder, with no bitrate stored, sets `DEFAULT_AUDIO_BITRATE_KBPS`.
   */
  private applyAudioEncoder(newEncoder: string): void {
    if (!this.draft) {
      return;
    }
    const wasLossless = isLosslessAudioEncoder(this.draft.audioEncoder);
    const isLossless = isLosslessAudioEncoder(newEncoder);
    const nextDraft: Preset = {
      ...this.draft,
      audioEncoder: newEncoder,
    };

    if (isLossless) {
      delete nextDraft.audioBitrate;
    } else if (wasLossless && nextDraft.audioBitrate === undefined) {
      nextDraft.audioBitrate = DEFAULT_AUDIO_BITRATE_KBPS;
    }

    this.draft = nextDraft;
    this.issues = validatePresetFields(this.draft);
    this.dirty = true;
    this.notify();
  }

  /**
   * Sets the draft's audio bitrate in kbps, or null for encoder default.
   *
   * Setting null removes the `audioBitrate` key completely rather than storing `undefined`
   * or `null`, matching the wire contract where an absent key means encoder default (ADR 023).
   *
   * No-op when there is no draft.
   */
  setAudioBitrate(value: number | null): void {
    if (!this.draft) {
      return;
    }
    const nextDraft: Preset = { ...this.draft };
    if (value === null) {
      delete nextDraft.audioBitrate;
    } else {
      nextDraft.audioBitrate = value;
    }
    this.draft = nextDraft;
    this.issues = validatePresetFields(this.draft);
    this.dirty = true;
    this.notify();
  }

  /**
   * Sets the draft's audio sample rate ("source" or numeric frequency in Hz).
   *
   * No-op when there is no draft.
   */
  setAudioSampleRate(value: PresetAudioSampleRate): void {
    this.updateDraft({ audioSampleRate: value });
  }

  /**
   * Sets the draft's audio channel layout ("source", "stereo", or "mono").
   *
   * No-op when there is no draft.
   */
  setAudioChannels(value: PresetAudioChannels): void {
    this.updateDraft({ audioChannels: value });
  }

  /**
   * Sets the draft's quality kind and REPLACES its numeric value with that kind's default
   * (`defaultQualityValue`). Carrying the old number across kinds would turn a crf of 20 into
   * 20 kbit/s, or a bitrate of 8000 into a crf far out of range that the user would have to
   * clear by hand.
   *
   * No-op when there is no draft.
   */
  setQualityKind(kind: QualityKind): void {
    this.updateDraft({ quality: { kind, value: defaultQualityValue(kind) } });
  }

  /**
   * Parses `raw` from the quality value input and stores the result.
   *
   * A blank or unparseable `raw` stores `NaN` rather than coercing to 0 (see
   * `parseNumericField`), so an emptied field reports `notInteger` and disables Save instead
   * of silently becoming a valid CRF 0.
   *
   * No-op when there is no draft.
   */
  updateQualityValue(raw: string): void {
    if (!this.draft) {
      return;
    }
    this.updateDraft({
      quality: { kind: this.draft.quality.kind, value: parseNumericField(raw) },
    });
  }

  /**
   * Switches the draft's resolution between "same as source" and a custom value.
   *
   * Switching to "custom" writes `DEFAULT_CUSTOM_RESOLUTION`. Switching to "source" writes the
   * literal string "source".
   *
   * No-op when there is no draft.
   */
  setResolutionMode(mode: "source" | "custom"): void {
    this.updateDraft({
      resolution: mode === "source" ? "source" : { ...DEFAULT_CUSTOM_RESOLUTION },
    });
  }

  /**
   * Parses `raw` from a custom resolution field (width or height) and stores the result,
   * carrying the other dimension through unchanged. Falls back to `DEFAULT_CUSTOM_RESOLUTION`
   * for the dimension it carries through when the draft's resolution is still "source".
   *
   * A blank or unparseable `raw` stores `NaN` (see `parseNumericField`), never 0.
   *
   * No-op when there is no draft.
   */
  updateResolutionField(field: "w" | "h", raw: string): void {
    if (!this.draft) {
      return;
    }
    const base =
      this.draft.resolution === "source"
        ? DEFAULT_CUSTOM_RESOLUTION
        : this.draft.resolution;
    this.updateDraft({ resolution: { ...base, [field]: parseNumericField(raw) } });
  }

  /**
   * Switches the draft's frame rate between "same as source" and a custom value.
   *
   * Switching to "custom" writes `DEFAULT_CUSTOM_FRAME_RATE`. Switching to "source" writes the
   * literal string "source".
   *
   * No-op when there is no draft.
   */
  setFrameRateMode(mode: "source" | "custom"): void {
    this.updateDraft({
      frameRate: mode === "source" ? "source" : { ...DEFAULT_CUSTOM_FRAME_RATE },
    });
  }

  /**
   * Parses `raw` from a custom frame rate field (numerator or denominator) and stores the
   * result, carrying the other component through unchanged. Falls back to
   * `DEFAULT_CUSTOM_FRAME_RATE` for the component it carries through when the draft's frame
   * rate is still "source".
   *
   * A blank or unparseable `raw` stores `NaN` (see `parseNumericField`), never 0.
   *
   * No-op when there is no draft.
   */
  updateFrameRateField(field: "n" | "d", raw: string): void {
    if (!this.draft) {
      return;
    }
    const base =
      this.draft.frameRate === "source"
        ? DEFAULT_CUSTOM_FRAME_RATE
        : this.draft.frameRate;
    this.updateDraft({ frameRate: { ...base, [field]: parseNumericField(raw) } });
  }

  /**
   * Writes the current draft to the settings document, using `updatePreset` when the draft id
   * already exists in the document and `addPreset` when it does not.
   *
   * Performs no IPC and returns `false` when there is no draft, when the draft is not dirty,
   * when `issues` is non-empty, or when the settings document has not loaded yet. Clears
   * `dirty` only when the write succeeds AND `this.draft` is still the draft this call
   * started with; a `null` result from `saveSettings` (the store's failure signal) leaves
   * `dirty` true so the user's edit is not lost.
   *
   * The identity check guards against a stale completion: the user can `select` a different
   * preset (or keep typing into it) while this write is in flight, and a `dirty` clear that
   * belongs to the OLD draft must never land on that unrelated, still-unsaved draft (RULE 3).
   * `LanguageMenuController` guards its analogous race with a monotonic request id; this
   * controller only ever has one draft at a time, so comparing draft identity is enough --
   * a second request-id counter here would duplicate state the settings store already owns.
   */
  async saveDraft(): Promise<boolean> {
    if (!this.draft || !this.dirty || this.issues.length > 0) {
      return false;
    }
    const settings = this.getSettingsFn();
    if (!settings) {
      return false;
    }

    const draft = this.draft;
    const exists = settings.presets.some((preset) => preset.id === draft.id);
    const next = exists
      ? updatePreset(settings, draft)
      : addPresetToDocument(settings, draft);

    this.pendingCount++;
    this.notify();
    let saved: Settings | null;
    try {
      saved = await this.saveSettingsFn(next);
    } finally {
      this.pendingCount--;
    }

    if (saved === null) {
      this.notify();
      return false;
    }

    if (this.draft === draft) {
      this.dirty = false;
    }
    this.notify();
    return true;
  }

  /**
   * Saves the draft before the user leaves it: for a switch to another preset, or for a close
   * of the settings dialog.
   *
   * Resolves true only when the write succeeded AND no unsaved edit remains, so the caller can
   * leave without losing work. An edit made while the write was in flight is not in the write,
   * so `saveDraft` keeps `dirty` true for it. This method then resolves false, and the caller
   * stays on the draft. When `saveDraft` refuses or fails, this method resolves false too.
   */
  async saveDraftBeforeLeaving(): Promise<boolean> {
    const saved = await this.saveDraft();
    return saved && !this.dirty;
  }

  /**
   * Reloads the draft from the stored document, discarding unsaved edits, and clears `dirty`.
   */
  cancelDraft(): void {
    this.loadDraftFrom(this.getSettingsFn(), this.selectedPresetId);
    this.notify();
  }

  /**
   * Creates a new preset, writes it, and selects it on success.
   *
   * The name is the first free name among `names.base`, `names.numbered(2)`, ... in the
   * document this call writes (see `nextFreePresetName`). The forms are PARAMETERS: this
   * controller must not import i18next, so the component passes already-translated text. The
   * stored name is then user data and is never translated again (ADR 013).
   *
   * Resolves the id of the new preset when the write succeeded and the new preset is now
   * selected, so the view can move the focus to its name. Resolves null otherwise.
   *
   * Refuses and performs no IPC when the settings document has not loaded, when
   * `canAddPreset` is false for the current preset count, or when the draft holds an unsaved
   * edit. Selecting the new preset would discard that edit, so the view must settle the draft
   * first, through the unsaved-changes prompt.
   */
  async addPreset(names: PresetNameForms): Promise<string | null> {
    const settings = this.getSettingsFn();
    if (!settings || !canAddPreset(settings.presets.length) || this.dirty) {
      return null;
    }

    const name = nextFreePresetName(
      settings.presets.map((preset) => preset.name),
      names.base,
      names.numbered,
    );
    return this.writeNewPreset(settings, createPresetDraft(this.generateIdFn(), name));
  }

  /**
   * Creates a copy of the STORED preset with `id`, writes it, and selects the copy on success.
   *
   * The copy is a deep copy (`clonePreset`) with a new id from the id generator, so it shares
   * no object with the source, and its id is unique in the document (ADR 013). It goes to the
   * end of the library, as a new preset does. Its name is the first free name among
   * `names.base`, `names.numbered(2)`, ..., each with the stored name of the source in its
   * `PRESET_NAME_SLOT` (see `nextFreeCopyName`).
   *
   * Resolves the id of the copy when the write succeeded and the copy is now selected.
   * Resolves null otherwise.
   *
   * Refuses and performs no IPC when the settings document has not loaded, when
   * `canAddPreset` is false, when no preset has `id`, or when the draft holds an unsaved edit.
   * The last rule has two reasons. The copy is made from the stored preset, so a copy made
   * while the draft is dirty would not contain the edit on screen. And selecting the copy
   * would discard that edit.
   */
  async duplicatePreset(id: string, names: CopyNameForms): Promise<string | null> {
    const settings = this.getSettingsFn();
    if (!settings || !canAddPreset(settings.presets.length) || this.dirty) {
      return null;
    }
    const source = settings.presets.find((preset) => preset.id === id);
    if (source === undefined) {
      return null;
    }

    const name = nextFreeCopyName(
      settings.presets.map((preset) => preset.name),
      source.name,
      names,
    );
    const copy: Preset = { ...clonePreset(source), id: this.generateIdFn(), name };
    return this.writeNewPreset(settings, copy);
  }

  /**
   * Deletes the preset with `id` by delegating to `deletePreset` from `presetDocument.ts`,
   * which repairs a dangling `activePresetId` (RULE 2). This never reimplements the removal:
   * Rust rejects a dangling `activePresetId` with `UnknownActivePreset`, which would make
   * every later save fail until the application restarts.
   *
   * Clears the selection and the draft only when the deleted preset was the selected one.
   */
  async deletePreset(id: string): Promise<boolean> {
    const settings = this.getSettingsFn();
    if (!settings) {
      return false;
    }

    const next = deletePresetFromDocument(settings, id);

    this.pendingCount++;
    this.notify();
    let saved: Settings | null;
    try {
      saved = await this.saveSettingsFn(next);
    } finally {
      this.pendingCount--;
    }

    if (saved === null) {
      this.notify();
      return false;
    }

    if (this.selectedPresetId === id) {
      this.selectedPresetId = null;
      this.draft = null;
      this.dirty = false;
      this.issues = [];
    }
    this.notify();
    return true;
  }

  /**
   * Sets the active preset id and writes the resulting document.
   */
  async setActive(id: string): Promise<boolean> {
    const settings = this.getSettingsFn();
    if (!settings) {
      return false;
    }

    const next = setActivePreset(settings, id);

    this.pendingCount++;
    this.notify();
    let saved: Settings | null;
    try {
      saved = await this.saveSettingsFn(next);
    } finally {
      this.pendingCount--;
    }
    this.notify();
    return saved !== null;
  }

  /**
   * Restores the default preset seeds.
   *
   * RULE 1: this calls ONLY the injected `restoreDefaultPresets`. It NEVER builds a settings
   * document here and NEVER calls `saveSettings`. Rust already preserves `ffmpegPath` and
   * merges the default seeds into the existing library by id; rebuilding the document in this
   * controller and writing it would be exactly how a user's ffmpeg path gets silently erased.
   */
  async restoreDefaults(): Promise<boolean> {
    this.pendingCount++;
    this.notify();
    let restored: Settings | null;
    try {
      restored = await this.restoreDefaultPresetsFn();
    } finally {
      this.pendingCount--;
    }

    if (restored === null) {
      this.notify();
      return false;
    }

    // Reload the current selection against the restored document: a merge can change the
    // values of the selected preset, or remove it entirely.
    //
    // RULE 3 applies here as it does in `syncFromSettings`: a restore merges the seeds by
    // id and keeps every other preset, so it says nothing about the preset the user is
    // editing, and reloading over a dirty draft would discard that edit with no prompt.
    // The one condition that still replaces a dirty draft is the selected preset no longer
    // being in the restored document, because there is then nothing left to save it to.
    const selectedSurvives =
      this.selectedPresetId !== null &&
      restored.presets.some((preset) => preset.id === this.selectedPresetId);
    if (!this.dirty || !selectedSurvives) {
      this.loadDraftFrom(restored, this.selectedPresetId);
    }
    this.notify();
    return true;
  }

  /**
   * Called by the React effect when the settings store's document changes.
   *
   * RULE 3: this returns EARLY, changing nothing, while `dirty` is true or a write is in
   * flight. This mirrors `LanguageMenuController.handleLanguageChanged`'s `pendingCount > 0`
   * guard: a save landing mid-edit must never overwrite the user's unsaved typing.
   */
  syncFromSettings(settings: Settings | null): void {
    if (this.dirty || this.pendingCount > 0) {
      return;
    }
    this.loadDraftFrom(settings, this.selectedPresetId);
    this.notify();
  }

  /**
   * Activates the controller, re-enabling `onChange` callbacks and flushing any change that
   * happened while deactivated.
   */
  activate(): void {
    this.active = true;
    if (this.needsNotify) {
      this.needsNotify = false;
      this.onChange?.(this.getView());
    }
  }

  /**
   * Deactivates the controller, suppressing `onChange` callbacks (e.g. on component unmount).
   * Internal state still mutates normally; it reconciles on the next `activate()`.
   */
  deactivate(): void {
    this.active = false;
  }

  /**
   * Disposes the controller. Currently equivalent to `deactivate()`.
   */
  dispose(): void {
    this.deactivate();
  }

  /**
   * Appends `preset` to `settings`, writes the result, and selects `preset` on success. The
   * shared tail of `addPreset` and `duplicatePreset`.
   *
   * Resolves the id of `preset` when it is now selected, and null when the write failed.
   *
   * RULE 3: it resolves null and keeps the selection when the draft became dirty while the
   * write was in flight. The fields of the current preset stay editable during the write, and
   * a selection now would discard that edit with no prompt. The new preset is in the library
   * all the same, and the user can select it from the list.
   */
  private async writeNewPreset(
    settings: Settings,
    preset: Preset,
  ): Promise<string | null> {
    const next = addPresetToDocument(settings, preset);

    this.pendingCount++;
    this.notify();
    let saved: Settings | null;
    try {
      saved = await this.saveSettingsFn(next);
    } finally {
      this.pendingCount--;
    }

    if (saved === null || this.dirty) {
      this.notify();
      return null;
    }

    this.select(preset.id);
    return preset.id;
  }

  /**
   * Loads a fresh COPY of the preset matching `id` from `settings` as the draft, with `dirty`
   * false, and recomputes `issues` for it. Mutating the returned draft, including its nested
   * `quality`, `resolution`, and `frameRate` fields, never alters the stored preset because
   * `clonePreset` always produces new objects for all of them.
   */
  private loadDraftFrom(settings: Settings | null, id: string | null): void {
    const preset =
      id === null
        ? undefined
        : settings?.presets.find((candidate) => candidate.id === id);
    this.draft = preset ? clonePreset(preset) : null;
    this.issues = preset ? validatePresetFields(preset) : [];
    this.dirty = false;
    // A newly loaded draft never inherits an in-progress "choose a custom encoder" edit from
    // whatever was loaded before it.
    this.videoEncoderIsCustom = false;
    this.audioEncoderIsCustom = false;
  }

  /**
   * Emits the current view through `onChange` when active; otherwise records that a
   * reconciling notification is owed on the next `activate()`.
   */
  private notify(): void {
    if (this.active) {
      this.onChange?.(this.getView());
      return;
    }
    this.needsNotify = true;
  }
}

/**
 * Factory helper to create a `PresetLibraryController` instance.
 */
export function createPresetLibraryController(
  options: PresetLibraryControllerOptions = {},
): PresetLibraryController {
  return new PresetLibraryController(options);
}
