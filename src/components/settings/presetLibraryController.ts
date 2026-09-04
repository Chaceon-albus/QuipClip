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
  deletePreset as deletePresetFromDocument,
  setActivePreset,
  updatePreset,
} from "@/features/settings/presetDocument";
import {
  canAddPreset,
  validatePresetFields,
  type PresetFieldIssue,
} from "@/features/settings/limits";
// Import the store MODULE directly, never the "@/features/settings" barrel. The barrel also
// re-exports "./client", whose `saveSettings` is the raw IPC call that bypasses the store's
// serialized write queue (ADR 013). Taking that export by mistake would let this controller's
// whole-document writes race the store's own writes and silently revert the settings file.
import { settingsStore } from "@/features/settings/store";
import type { Preset, Settings } from "@/features/settings/types";

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
 * action (`saveDraft`, `addPreset`, `deletePreset`, `setActive`) called WHILE a restore is in
 * flight would compute its next document from the pre-restore library and could overwrite the
 * restore on disk. The view MUST disable every write action while `view.pending` is true;
 * `pending` is exposed on the view for exactly this purpose.
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
   * Reloads the draft from the stored document, discarding unsaved edits, and clears `dirty`.
   */
  cancelDraft(): void {
    this.loadDraftFrom(this.getSettingsFn(), this.selectedPresetId);
    this.notify();
  }

  /**
   * Creates a new preset named `name`, writes it, and selects it on success.
   *
   * Refuses and performs no IPC when `canAddPreset` is false for the current preset count.
   * The name is a PARAMETER: this controller must not import i18next, so the component passes
   * already-translated text. The stored name is then user data and is never translated again
   * (ADR 013).
   */
  async addPreset(name: string): Promise<boolean> {
    const settings = this.getSettingsFn();
    if (!settings || !canAddPreset(settings.presets.length)) {
      return false;
    }

    const preset = createPresetDraft(this.generateIdFn(), name);
    const next = addPresetToDocument(settings, preset);

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

    this.select(preset.id);
    return true;
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
    this.loadDraftFrom(restored, this.selectedPresetId);
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
