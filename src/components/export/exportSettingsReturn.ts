/**
 * Pure rules for the return from the settings dialog to the setup step of the export dialog.
 *
 * "Manage Presets..." and the "Open Settings..." buttons of the setup step open the settings
 * dialog on the Presets tab. The export dialog closes first, so the two modal dialogs are
 * never open together. When the settings dialog closes, the export dialog opens again on the
 * setup step, with the preset choice kept, as Premiere Pro and Media Encoder do. The two
 * dialogs show together only while one fades out and the other fades in.
 *
 * 1. The export dialog keeps what the setup step showed (`SettingsReturn`) while the settings
 *    dialog is open. The export dialog holds it in its own state, and not in the run state of
 *    the export store, because a reset of the store does not end the choice.
 * 2. The settings dialog opens on the preset that the setup step showed. Its session carries
 *    `returnTo: "exportSetup"`, and every other opening of the dialog clears that field.
 * 3. When the settings dialog closes, by any path, `createSettingsCloseListener` asks
 *    `decideSettingsReturn` whether the export dialog opens again, and which preset it selects.
 * 4. Each return runs the open step of ADR 024 again (`runOpenStepAgain` in
 *    `exportBackToSetup.ts`), and Export stays disabled until that step answers. The settings
 *    dialog can close a Back step before its source check answered, and the file can change
 *    while the settings dialog is open, so the setup step never shows a source that no check
 *    passed.
 *
 * The return never crosses a run or a change of the source: it is dropped when a run is live,
 * when the store is not idle, or when the media closed or changed while the settings dialog
 * was open.
 *
 * The Open Settings recovery of a failed run is not part of the setup step, and it does not
 * return.
 *
 * The module has no React and no document, so the tests need neither.
 */

import { isExportRunLive, type ExportRunLiveState } from "@/features/export/runState";
import {
  isSameSourceRevision,
  type MediaSourceRevisionDescriptor,
} from "@/features/media/sourceIdentity";
import type {
  SettingsPanelState,
  SettingsReturnTarget,
} from "@/features/settings/panelStore";
import type { Preset } from "@/features/settings/types";

/** What the setup step showed when it opened the settings dialog. */
export interface SettingsReturn<Opener = unknown> {
  /**
   * The preset that the user chose in the setup step, or null when the user chose none. The
   * step then showed the default preset (ADR 024).
   */
  readonly keptPresetId: string | null;
  /**
   * The preset that the setup step showed, and that the Presets tab opens on, or null when
   * the step listed no preset.
   */
  readonly shownPresetId: string | null;
  /** The revision of the open source when the settings dialog opened. */
  readonly media: MediaSourceRevisionDescriptor;
  /**
   * The element that opened the export dialog, or null. It takes the focus back when the
   * export dialog closes after the return, because the element that held the focus when the
   * export dialog opened again was a control of the settings dialog.
   */
  readonly opener: Opener | null;
}

/** The state that the setup step reads when it opens the settings dialog. */
export interface SettingsReturnPlanInput<Opener> {
  /** The status and the tracking of the export store, read at the click. */
  readonly exportState: ExportRunLiveState;
  /** The open media, read at the click, or null. */
  readonly media: MediaSourceRevisionDescriptor | null;
  /** The choice of the setup step: `requestedPresetId` of the dialog. */
  readonly requestedPresetId: string | null;
  /** The preset that the setup step shows (`resolveSetupPresetId`). */
  readonly shownPresetId: string | null;
  readonly opener: Opener | null;
}

/**
 * True while the export dialog can open again on the setup step: the store is idle, it holds
 * no live run, and a source is open.
 *
 * The setup step shows only while the store is idle (`resolveExportDialogStep`), and the open
 * step of ADR 024 refuses an export with no source. `isExportRunLive` is also read, although
 * an idle store never holds a live run, because a reopen over a live run would drop the only
 * record of that run (ADR 025).
 */
export function canReturnToSetup(
  exportState: ExportRunLiveState,
  media: MediaSourceRevisionDescriptor | null,
): boolean {
  return (
    !isExportRunLive(exportState) && exportState.status === "idle" && media !== null
  );
}

/**
 * Returns what the export dialog keeps while the settings dialog is open, or null when the
 * setup step cannot return (`canReturnToSetup`). With null, the settings dialog opens as it
 * does from any other control, and it returns to nothing.
 */
export function planSettingsReturn<Opener>({
  exportState,
  media,
  requestedPresetId,
  shownPresetId,
  opener,
}: SettingsReturnPlanInput<Opener>): SettingsReturn<Opener> | null {
  if (media === null || !canReturnToSetup(exportState, media)) {
    return null;
  }
  return {
    keptPresetId: requestedPresetId,
    shownPresetId,
    media: { path: media.path, size: media.size, mtime: media.mtime },
    opener,
  };
}

/** The ids that decide which preset the setup step selects after the return. */
export interface ReturnPresetInput {
  /** The presets of the library when the settings dialog closed. */
  readonly presets: readonly Pick<Preset, "id">[];
  /** `SettingsReturn.keptPresetId`. */
  readonly keptPresetId: string | null;
  /** `SettingsReturn.shownPresetId`, the preset that the Presets tab opened on. */
  readonly shownPresetId: string | null;
  /** The preset that the Presets tab selected when it closed, or null. */
  readonly settingsSelectedPresetId: string | null;
}

/**
 * Returns the choice of the setup step after the return, as `requestedPresetId`, or null for
 * the default preset of ADR 024 (`resolveSetupPresetId`):
 *
 * 1. The preset that the Presets tab selected, when the user changed the selection there and
 *    that preset still exists. The tab opened on `shownPresetId`, so a selection that differs
 *    from it is a change. A delete, an Add and a Duplicate change the selection too.
 * 2. Otherwise the choice that the setup step kept, when that preset still exists.
 * 3. Otherwise null.
 */
export function pickReturnPresetId({
  presets,
  keptPresetId,
  shownPresetId,
  settingsSelectedPresetId,
}: ReturnPresetInput): string | null {
  const exists = (id: string | null): id is string =>
    id !== null && presets.some((preset) => preset.id === id);
  if (settingsSelectedPresetId !== shownPresetId && exists(settingsSelectedPresetId)) {
    return settingsSelectedPresetId;
  }
  return exists(keptPresetId) ? keptPresetId : null;
}

/** The state that decides the return when the settings dialog closes. */
export interface SettingsReturnCloseInput<Opener> {
  /** What the export dialog kept, taken from its slot, or null when it kept nothing. */
  readonly kept: SettingsReturn<Opener> | null;
  /** `returnTo` of the settings session that closed. */
  readonly returnTo: SettingsReturnTarget | null;
  /** The status and the tracking of the export store, read at the close. */
  readonly exportState: ExportRunLiveState;
  /** The open media, read at the close, or null. */
  readonly media: MediaSourceRevisionDescriptor | null;
  /** The presets of the library, read at the close. */
  readonly presets: readonly Pick<Preset, "id">[];
  /** `selectedPresetId` of the settings session that closed. */
  readonly settingsSelectedPresetId: string | null;
}

/** How the export dialog opens again after the return. */
export interface SettingsReturnDecision<Opener> {
  /** The new `requestedPresetId` of the dialog (`pickReturnPresetId`). */
  readonly requestedPresetId: string | null;
  /** The opener of the export dialog (`SettingsReturn.opener`). */
  readonly opener: Opener | null;
}

/**
 * Decides, when the settings dialog closes, whether the export dialog opens again on the setup
 * step. Returns null to drop the return:
 *
 * - The export dialog kept nothing, or the session that closed was not opened for the setup
 *   step. A settings dialog that the status bar, the menu or a key opened never returns.
 * - A run is live, or the store is not idle (`canReturnToSetup`). No run can start while the
 *   settings dialog is modal, so this is a guard.
 * - The media closed, or another file or another revision of the file is open. The kept choice
 *   is about the source that the setup step showed.
 */
export function decideSettingsReturn<Opener>({
  kept,
  returnTo,
  exportState,
  media,
  presets,
  settingsSelectedPresetId,
}: SettingsReturnCloseInput<Opener>): SettingsReturnDecision<Opener> | null {
  if (kept === null || returnTo !== "exportSetup") {
    return null;
  }
  if (
    !canReturnToSetup(exportState, media) ||
    !isSameSourceRevision(kept.media, media)
  ) {
    return null;
  }
  return {
    requestedPresetId: pickReturnPresetId({
      presets,
      keptPresetId: kept.keptPresetId,
      shownPresetId: kept.shownPresetId,
      settingsSelectedPresetId,
    }),
    opener: kept.opener,
  };
}

/**
 * Holds one `SettingsReturn` while the settings dialog is open. `take` empties the slot, and
 * the export dialog calls it at every close of the settings dialog, so a kept choice never
 * outlives the settings session that it was kept for.
 */
export interface SettingsReturnSlot<Opener> {
  hold: (kept: SettingsReturn<Opener>) => void;
  take: () => SettingsReturn<Opener> | null;
}

export function createSettingsReturnSlot<Opener>(): SettingsReturnSlot<Opener> {
  let kept: SettingsReturn<Opener> | null = null;
  return {
    hold: (next) => {
      kept = next;
    },
    take: () => {
      const taken = kept;
      kept = null;
      return taken;
    },
  };
}

/** The fields of the settings panel store that the close listener reads. */
export type SettingsSessionState = Pick<
  SettingsPanelState,
  "open" | "returnTo" | "selectedPresetId"
>;

/** What `createSettingsCloseListener` reads when the settings dialog closes, and calls. */
export interface SettingsCloseListenerOptions<Opener> {
  /** The slot of the export dialog. The listener empties it at every close. */
  readonly slot: SettingsReturnSlot<Opener>;
  /** Reads the status and the tracking of the export store. */
  readonly readExportState: () => ExportRunLiveState;
  /** Reads the open media, or null. */
  readonly readMedia: () => MediaSourceRevisionDescriptor | null;
  /** Reads the presets of the library. */
  readonly readPresets: () => readonly Pick<Preset, "id">[];
  /**
   * Opens the export dialog again on the setup step, and runs the open step again. The
   * listener calls it only for a return that `decideSettingsReturn` allows.
   */
  readonly onReturn: (decision: SettingsReturnDecision<Opener>) => void;
}

/**
 * Returns the listener that the export dialog subscribes to the settings panel store.
 *
 * It acts once for each close of the settings dialog, by any path: Close, the close control,
 * Escape, or the prompt of an unsaved draft. The close is the change of `open` from true to
 * false, and the listener reads the session that closed from `previous`, because `hide`
 * clears `returnTo`. It reads the other state at the close. A close that the unsaved-draft
 * prompt holds back does not change `open`, so the return waits for the answer.
 */
export function createSettingsCloseListener<Opener>({
  slot,
  readExportState,
  readMedia,
  readPresets,
  onReturn,
}: SettingsCloseListenerOptions<Opener>): (
  state: SettingsSessionState,
  previous: SettingsSessionState,
) => void {
  return (state, previous) => {
    if (!previous.open || state.open) {
      return;
    }
    const decision = decideSettingsReturn({
      kept: slot.take(),
      returnTo: previous.returnTo,
      exportState: readExportState(),
      media: readMedia(),
      presets: readPresets(),
      settingsSelectedPresetId: previous.selectedPresetId,
    });
    if (decision !== null) {
      onReturn(decision);
    }
  };
}
