/**
 * Pure ffmpeg path controller for the settings dialog.
 *
 * Choosing an ffmpeg path is not one action: it opens a native picker, writes the whole
 * settings document, and then re-runs the capability probe so the status bar reflects the new
 * binary. That orchestration is real logic with a silent failure mode (see RULE 1 below), and
 * the repository has no jsdom and no `@testing-library`, so it lives here, in a tested `.ts`
 * module, and the paired `.tsx` view only calls it.
 */

// Import the store MODULES directly, never the "@/features/settings" barrel. The barrel also
// re-exports "./client", whose `saveSettings` is the raw IPC call that bypasses the store's
// serialized write queue (ADR 013). Taking that export by mistake would let this controller's
// whole-document write race the store's own writes and silently revert the settings file.
import { settingsStore } from "@/features/settings/store";
import { ffmpegStore } from "@/features/ffmpeg/store";
import {
  openFfmpegPathDialog,
  type OpenFfmpegPathDialogOptions,
} from "@/features/settings/dialog";
import type { Settings } from "@/features/settings/types";

/**
 * Snapshot of the ffmpeg path state for the view layer to render.
 */
export type FfmpegPathView = {
  /** The configured ffmpeg path, or null when the document has no configured path. */
  path: string | null;
  /** True while a choose, a clear, or a check is in flight. */
  pending: boolean;
  /**
   * True exactly when the controller currently has a settings document to work from
   * (`getSettingsFn() !== null`). False right after a failed load, when `choose()` and
   * `clear()` are safe no-ops that open no dialog, save nothing, and probe nothing. A view
   * should disable its buttons while this is false: otherwise every click is a silent no-op,
   * and `path === null` is indistinguishable from "the application does not know yet".
   */
  ready: boolean;
};

/**
 * Options for configuring an `FfmpegPathController` instance.
 *
 * Every collaborator is an optional injected function. Its production default is resolved at
 * call time from the relevant store singleton, so a stale reference is never captured.
 */
export interface FfmpegPathControllerOptions {
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
   * Opens the native file or directory picker. Defaults to `openFfmpegPathDialog`.
   */
  openDialog?: (options: OpenFfmpegPathDialogOptions) => Promise<string | null>;

  /**
   * Starts the ffmpeg capability probe. Defaults to `ffmpegStore.getState().startProbe`.
   */
  startProbe?: (force?: boolean) => Promise<unknown>;

  /**
   * Callback invoked with the latest view whenever it changes while the controller is active.
   */
  onChange?: (view: FfmpegPathView) => void;
}

/**
 * Builds the next settings document from `settings`, replacing only `ffmpegPath` and
 * preserving every other key exactly.
 *
 * This SPREADS the loaded document rather than rebuilding it field by field, matching
 * `buildSettings` in `@/features/settings/presetDocument`. `revision`, the ADR 013
 * compare-and-swap token, is why that matters: a rebuilt document would drop it, `isSettings`
 * in the store would then refuse the document before the IPC ever ran, and setting an ffmpeg
 * path would silently stop working. The spread also carries any key a later schema adds.
 *
 * ADR 013: an unset optional key is ABSENT, never an empty string and never null. `ffmpegPath`
 * is therefore deleted first and written back only when it is not undefined, so the clear case
 * omits the key entirely. Rust rejects a blank path with `InvalidFfmpegPath`, so writing `""`
 * would fail the save and leave the user unable to clear the setting at all.
 */
function buildNextSettings(
  settings: Settings,
  ffmpegPath: string | undefined,
): Settings {
  const next: Settings = { ...settings };
  delete next.ffmpegPath;
  if (ffmpegPath !== undefined) {
    next.ffmpegPath = ffmpegPath;
  }
  return next;
}

/**
 * Controller managing the ffmpeg path setting: opening the native picker, writing the whole
 * settings document, and re-probing capabilities so the status bar reflects the new binary.
 */
export class FfmpegPathController {
  private readonly getSettingsFn: () => Settings | null;
  private readonly saveSettingsFn: (settings: Settings) => Promise<Settings | null>;
  private readonly openDialogFn: (
    options: OpenFfmpegPathDialogOptions,
  ) => Promise<string | null>;
  private readonly startProbeFn: (force?: boolean) => Promise<unknown>;
  private readonly onChange?: (view: FfmpegPathView) => void;

  private active = true;
  private pendingCount = 0;

  private path: string | null = null;
  // The path last actually delivered through `onChange`. `activate()` compares this against
  // `path` to decide whether reconciliation has anything real to report, following the same
  // idiom as `LanguageMenuController.lastNotifiedPreference`. Without it, ANY notify() while
  // deactivated -- including a `syncFromSettings` that lands on the same path -- would make
  // `activate()` fire a spurious `onChange`.
  private lastNotifiedPath: string | null = null;

  constructor(options: FfmpegPathControllerOptions = {}) {
    this.getSettingsFn =
      options.getSettings ?? (() => settingsStore.getState().settings);
    this.saveSettingsFn =
      options.saveSettings ?? ((next) => settingsStore.getState().saveSettings(next));
    this.openDialogFn = options.openDialog ?? openFfmpegPathDialog;
    this.startProbeFn =
      options.startProbe ?? ((force) => ffmpegStore.getState().startProbe(force));
    this.onChange = options.onChange;
  }

  /**
   * Builds the current view snapshot for the UI to render.
   *
   * `ready` is recomputed from `getSettingsFn()` on every call, never cached, so it always
   * reflects whether the controller currently has a settings document to act on.
   */
  getView(): FfmpegPathView {
    return {
      path: this.path,
      pending: this.pendingCount > 0,
      ready: this.getSettingsFn() !== null,
    };
  }

  /**
   * Opens the native picker in `mode`, writes the resulting path to the whole settings
   * document, and re-probes ffmpeg capabilities.
   *
   * RULE 4: cancel (the dialog resolves `null`) performs NO save and NO probe, and returns
   * false. RULE 1: a successful save is followed by `startProbe(true)`, forcing past the
   * cached capability report so the status bar reflects the new binary. A failed save
   * (`saveSettings` resolves `null`) returns false and starts NO probe: re-probing after a
   * failed write would report the old path as though it were the new one.
   *
   * Returns false as a safe no-op, performing no IPC, when there is no settings document yet,
   * or when a choose or clear is already in flight.
   */
  async choose(mode: "file" | "directory"): Promise<boolean> {
    // Refuse a second concurrent choose or clear: two in-flight operations would open two
    // native dialogs and issue two whole-document writes, each racing from its own snapshot.
    if (this.pendingCount > 0) {
      return false;
    }

    if (!this.getSettingsFn()) {
      return false;
    }

    this.pendingCount++;
    this.notify();

    try {
      // Pass mode straight through with NO `filters` option: an `extensions` filter would
      // hide extensionless binaries, which is every macOS and Linux ffmpeg.
      const picked = await this.openDialogFn({ mode });

      // RULE 4: cancel changes nothing.
      if (picked === null) {
        return false;
      }

      // Re-read the settings document NOW, after the dialog resolved, instead of reusing a
      // snapshot taken before it opened. The dialog await above can last as long as the user
      // browses the filesystem; a preset add/edit/delete, a restore-default-presets, or an
      // activePresetId change that landed during that window would otherwise be silently
      // overwritten by the stale snapshot's build below.
      const settings = this.getSettingsFn();
      if (!settings) {
        return false;
      }

      // RULE 2: build the next document from the current one, replacing only ffmpegPath.
      const next = buildNextSettings(settings, picked);
      const saved = await this.saveSettingsFn(next);

      if (saved === null) {
        // Failed save: do not probe, and leave the displayed path untouched.
        return false;
      }

      // Assign the displayed path as soon as the save resolves, BEFORE starting the probe
      // below. The write already succeeded, so the new path is authoritative; showing the old
      // one for the whole probe duration would contradict the write that just landed.
      this.path = saved.ffmpegPath ?? null;

      // RULE 1: the capability report is cached. Without `force`, the application keeps
      // reporting the OLD ffmpeg's encoders and the path change looks ignored.
      await this.startProbeAndShowPath();

      return true;
    } finally {
      this.finishOperation();
    }
  }

  /**
   * Clears the configured ffmpeg path by writing a document with NO `ffmpegPath` key, then
   * re-probes ffmpeg capabilities.
   *
   * RULE 3: the written document has the key ABSENT, never an empty string and never null.
   * Succeeds even when the document already has no configured path.
   *
   * Returns false as a safe no-op, performing no IPC, when there is no settings document yet,
   * or when a choose or clear is already in flight.
   */
  async clear(): Promise<boolean> {
    // Refuse a second concurrent choose or clear; see the identical guard in choose().
    if (this.pendingCount > 0) {
      return false;
    }

    const settings = this.getSettingsFn();
    if (!settings) {
      return false;
    }

    this.pendingCount++;
    this.notify();

    try {
      const next = buildNextSettings(settings, undefined);
      const saved = await this.saveSettingsFn(next);

      if (saved === null) {
        // Failed save: do not probe, and leave the displayed path untouched.
        return false;
      }

      // Assign the displayed path before starting the probe; see the identical reasoning in
      // choose().
      this.path = saved.ffmpegPath ?? null;

      // RULE 1: re-probe with force, exactly as a successful choose() does.
      await this.startProbeAndShowPath();

      return true;
    } finally {
      this.finishOperation();
    }
  }

  /**
   * Forces a fresh capability probe past the cache for the current FFmpeg configuration.
   *
   * The cache key already holds the binary's path, version, size and mtime (ADR 006), so an
   * upgraded ffmpeg misses the cache on its own. The case this control exists for is the one
   * the key cannot see — the SAME binary on a machine that changed underneath it, such as a
   * GPU driver installed so `h264_nvenc` now works. A cached answer is exactly wrong there.
   *
   * Reuses the same pendingCount gate, refusing while a choose, clear, or another reprobe is
   * in flight. Reports pending for its duration.
   */
  async reprobe(): Promise<boolean> {
    if (this.pendingCount > 0) {
      return false;
    }

    if (!this.getSettingsFn()) {
      return false;
    }

    this.pendingCount++;
    this.notify();

    try {
      await this.startProbeFn(true);
      return true;
    } finally {
      this.finishOperation();
    }
  }

  /**
   * Updates the displayed path from `settings`. A `null` document yields `path: null`.
   *
   * Called by the view layer on mount and whenever the settings store's document changes, so
   * the displayed path stays current even when it changed through a different controller or
   * component.
   *
   * While a choose, a clear, or a check is in flight, the call changes nothing. The settings
   * store publishes a document BEFORE its disk write, so during the save of a choose or a
   * clear it already holds the new path while the ffmpeg store still holds the check result
   * for the old one. The view would pair the two. The operation shows the new path itself,
   * together with the probe that checks it (see `startProbeAndShowPath`), and it reads the
   * settings again when it ends (see `finishOperation`), so no document that arrives in the
   * meantime is lost.
   */
  syncFromSettings(settings: Settings | null): void {
    if (this.pendingCount > 0) {
      return;
    }
    this.path = settings?.ffmpegPath ?? null;
    this.notify();
  }

  /**
   * Activates the controller, re-enabling `onChange` callbacks and flushing any change that
   * happened while deactivated.
   *
   * Emits ONLY when the path actually diverged from what was last notified: a `syncFromSettings`
   * that landed on the same path while deactivated must not produce a spurious `onChange`.
   */
  activate(): void {
    this.active = true;
    if (this.lastNotifiedPath !== this.path) {
      this.lastNotifiedPath = this.path;
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
   * Emits the current view through `onChange` when active. While deactivated, this is a no-op:
   * `activate()` reconciles by comparing `path` against `lastNotifiedPath` directly, so no flag
   * needs to be recorded here.
   */
  private notify(): void {
    if (this.active) {
      this.lastNotifiedPath = this.path;
      this.onChange?.(this.getView());
    }
  }

  /**
   * Starts the forced probe, then emits the path that a choose or a clear just saved.
   *
   * The emit comes after the call, not before it: the store's `startProbe` sets its status to
   * `locating` before its first await, so the new path and `locating` reach the view together,
   * and the view never shows the new path next to the check result for the old one.
   */
  private async startProbeAndShowPath(): Promise<void> {
    const probe = this.startProbeFn(true);
    this.notify();
    await probe;
  }

  /**
   * Ends a choose, a clear, or a check: releases the pending gate, reads the displayed path
   * from the settings again, and emits.
   *
   * `syncFromSettings` changes nothing while the operation runs, so the settings are read here.
   * They hold the saved document after a successful write, and the last confirmed document
   * after a failed one, which the store rolls back to. A document that another writer
   * published in the meantime also arrives here.
   */
  private finishOperation(): void {
    this.pendingCount--;
    if (this.pendingCount === 0) {
      this.path = this.getSettingsFn()?.ffmpegPath ?? null;
    }
    this.notify();
  }
}

/**
 * Factory helper to create an `FfmpegPathController` instance.
 */
export function createFfmpegPathController(
  options: FfmpegPathControllerOptions = {},
): FfmpegPathController {
  return new FfmpegPathController(options);
}
