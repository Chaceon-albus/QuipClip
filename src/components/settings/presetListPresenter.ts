/**
 * Pure presenter for the preset list of the Export Presets tab.
 *
 * The tab has two panes. The left pane is the preset list with a toolbar under it, and the
 * right pane is the editor of the selected preset. This module answers:
 * - Which row the tab selects when it opens, and which row takes the selection after a delete.
 * - Which row holds the one Tab stop of the list.
 * - When each action of the toolbar is off, and why.
 *
 * Returns translation keys and values without calling the i18n runtime (ADR 011). The line under
 * the name of each row is `presentPresetRowSummary` in `presetPresenter.ts`, because the preset
 * select of the export setup step shows the same line.
 *
 * `findPresetRow`, `findTabStopRow` and `findListFocusRow` are the functions that read the
 * document, and they read only the element that the caller passes.
 */

import type { Preset } from "@/features/settings/types";
import { decideLeaveRequest } from "./presetDraftGuard";
import type { PresetLibraryView } from "./presetLibraryController";
import {
  MAX_PRESETS,
  presentDuplicatePresetAction,
  type DuplicatePresetActionView,
} from "./presetPresenter";

/**
 * Returns the preset that the tab selects when it opens: the default (active) preset, or the
 * first preset when no preset has the active id. Returns null for an empty library.
 *
 * This is the rule of the export setup step (ADR 024), so the tab and the export dialog open on
 * the same preset.
 */
export function pickDefaultPresetId(
  presets: readonly Pick<Preset, "id">[],
  activePresetId: string | null,
): string | null {
  if (
    activePresetId !== null &&
    presets.some((preset) => preset.id === activePresetId)
  ) {
    return activePresetId;
  }
  return presets[0]?.id ?? null;
}

/**
 * Returns the preset that the tab selects when the dialog opens: the preset that the opener
 * named, when the library has it, and otherwise the default preset (`pickDefaultPresetId`).
 *
 * "Manage Presets…" of the export setup step names the preset that the step shows, so the
 * tab opens on the preset that the user looked at (`SettingsPanelState.openingPresetId`).
 */
export function pickOpeningPresetId(
  presets: readonly Pick<Preset, "id">[],
  activePresetId: string | null,
  openingPresetId: string | null,
): string | null {
  if (
    openingPresetId !== null &&
    presets.some((preset) => preset.id === openingPresetId)
  ) {
    return openingPresetId;
  }
  return pickDefaultPresetId(presets, activePresetId);
}

/**
 * Returns the preset that a new session of the dialog selects, or null to keep the selection.
 *
 * The session opens on `pickOpeningPresetId`. The rule of the unsaved draft applies
 * (`decideLeaveRequest`): a draft with an unsaved edit, or a write in flight, keeps the
 * selection. The dialog mounts the tab when it opens, and no draft exists then. A dialog that
 * opens again during its exit animation keeps the tab mounted, with the selection of the last
 * session, and a close leaves no unsaved edit.
 */
export function pickSessionSelection(
  view: Pick<
    PresetLibraryView,
    "presets" | "activePresetId" | "selectedPresetId" | "dirty" | "pending"
  >,
  openingPresetId: string | null,
): string | null {
  const id = pickOpeningPresetId(view.presets, view.activePresetId, openingPresetId);
  if (id === null || id === view.selectedPresetId) {
    return null;
  }
  // No prompt is open at the start of a session, so `defer` cannot come back.
  return decideLeaveRequest(view, false) === "leave" ? id : null;
}

/**
 * Returns the preset that takes the selection after the preset `deletedId` is deleted: the row
 * after it, or the row before it when it is the last row. Returns null when no other row
 * remains, or when no row has `deletedId`.
 *
 * The selection thus stays at the same place in the list, as in a macOS source list, and the
 * editor pane is empty only when the library is empty.
 */
export function pickSelectionAfterDelete(
  presetIds: readonly string[],
  deletedId: string,
): string | null {
  const index = presetIds.indexOf(deletedId);
  if (index === -1) {
    return null;
  }
  return presetIds[index + 1] ?? presetIds[index - 1] ?? null;
}

/**
 * Returns the row that holds the one Tab stop of the list (a roving tab index): the selected
 * row, or the first row when no row is selected. Returns null for an empty list.
 */
export function pickListTabStopId(
  presetIds: readonly string[],
  selectedPresetId: string | null,
): string | null {
  if (selectedPresetId !== null && presetIds.includes(selectedPresetId)) {
    return selectedPresetId;
  }
  return presetIds[0] ?? null;
}

/** The state of one action of the toolbar under the preset list. */
export type PresetToolbarActionView = DuplicatePresetActionView;

const OFF_WITHOUT_REASON: PresetToolbarActionView = { disabled: true, reason: null };
const ON: PresetToolbarActionView = { disabled: false, reason: null };

/**
 * Presents the Add button. It needs the loaded document and room in the library, and it waits
 * while a write is in flight. A full library is the one state that it explains, with the
 * message that `presentDuplicatePresetAction` also gives.
 *
 * An unsaved draft does not disable Add. The section asks the user about the draft first.
 */
export function presentAddPresetAction(
  view: Pick<PresetLibraryView, "ready" | "canAdd" | "pending">,
): PresetToolbarActionView {
  if (!view.ready) {
    return OFF_WITHOUT_REASON;
  }
  if (!view.canAdd) {
    return {
      disabled: true,
      reason: { key: "settings.preset.limitReached", values: { max: MAX_PRESETS } },
    };
  }
  return view.pending ? OFF_WITHOUT_REASON : ON;
}

/** True when the selection names a preset of the library. */
function hasSelectedPreset(
  view: Pick<PresetLibraryView, "presets" | "selectedPresetId">,
): boolean {
  return view.presets.some((preset) => preset.id === view.selectedPresetId);
}

/**
 * True when a delete of a preset can start: the document is loaded and no write is in flight.
 * The Delete key of a list row uses this rule, and the Delete button adds that a preset is
 * selected.
 */
export function canStartPresetDelete(
  view: Pick<PresetLibraryView, "ready" | "pending">,
): boolean {
  return view.ready && !view.pending;
}

/**
 * Presents the Delete button, which deletes the selected preset after a confirmation. It has
 * nothing to say when it is off: the list shows that no preset is selected, and a write in
 * flight disables it for a moment only.
 */
export function presentDeletePresetAction(
  view: Pick<PresetLibraryView, "ready" | "pending" | "presets" | "selectedPresetId">,
): PresetToolbarActionView {
  return canStartPresetDelete(view) && hasSelectedPreset(view)
    ? ON
    : OFF_WITHOUT_REASON;
}

/**
 * Presents the Duplicate item of the toolbar menu, which copies the selected preset. It adds
 * two conditions to `presentDuplicatePresetAction`: the document is loaded, and a preset is
 * selected. Neither condition has a reason text, as for `presentDeletePresetAction`.
 */
export function presentDuplicateSelectedAction(
  view: Pick<
    PresetLibraryView,
    "ready" | "canAdd" | "dirty" | "pending" | "presets" | "selectedPresetId"
  >,
): PresetToolbarActionView {
  if (!view.ready || !hasSelectedPreset(view)) {
    return OFF_WITHOUT_REASON;
  }
  return presentDuplicatePresetAction(view);
}

/**
 * Presents the Restore Built-in Presets item of the toolbar menu. It needs the loaded document:
 * `restore_default_presets` begins by reading the settings file, so it fails the same way the
 * load did. It waits while a write is in flight, as every write action does.
 */
export function presentRestoreBuiltInAction(
  view: Pick<PresetLibraryView, "ready" | "pending">,
): PresetToolbarActionView {
  return view.ready && !view.pending ? ON : OFF_WITHOUT_REASON;
}

/** The attribute that names the preset of a list row. Each row of `PresetList` sets it. */
export const PRESET_ROW_ID_ATTRIBUTE = "data-preset-id";

/**
 * Returns the row of the preset `id` in `list`, or null when the list has no such row. The
 * section uses it to move the focus to a row after a change of the selection.
 *
 * It compares the attribute value, and does not build a selector from the id. An id is free
 * text in a settings file that another build can write, so a selector could fail to parse.
 */
export function findPresetRow(
  list: HTMLElement | null,
  id: string | null,
): HTMLElement | null {
  if (list === null || id === null) {
    return null;
  }
  for (const row of list.querySelectorAll<HTMLElement>(
    `[${PRESET_ROW_ID_ATTRIBUTE}]`,
  )) {
    if (row.getAttribute(PRESET_ROW_ID_ATTRIBUTE) === id) {
      return row;
    }
  }
  return null;
}

/**
 * Returns the row of `list` that holds the Tab stop (`tabindex="0"`), or null when the list has
 * no rows. This is the rendered answer of `pickListTabStopId`, so it names a row that is on
 * screen even while a write that removes that row is in flight.
 */
export function findTabStopRow(list: HTMLElement | null): HTMLElement | null {
  return (
    list?.querySelector<HTMLElement>(`[${PRESET_ROW_ID_ATTRIBUTE}][tabindex="0"]`) ??
    null
  );
}

/**
 * Returns the row that takes the focus when the list takes it: the row of `preferredId` while
 * that row is on screen, or else the row that holds the Tab stop (`findTabStopRow`). Returns
 * null when the list has no rows.
 *
 * A delete passes the row that takes the selection after it (`pickSelectionAfterDelete`). While
 * the write is in flight, the Tab stop is still on the deleted row, and when the write ends, the
 * selection is empty for a moment before the neighbour is selected, which puts the Tab stop on
 * the first row. The preferred row keeps the focus and the scroll on the neighbour through both
 * states.
 */
export function findListFocusRow(
  list: HTMLElement | null,
  preferredId: string | null,
): HTMLElement | null {
  return findPresetRow(list, preferredId) ?? findTabStopRow(list);
}
