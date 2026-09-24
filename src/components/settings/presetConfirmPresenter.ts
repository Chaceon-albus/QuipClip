/**
 * Pure presenter for the two confirmations of the preset library: delete a preset, and
 * restore the default presets.
 *
 * Returns translation keys and values without calling the i18n runtime. Each description is
 * one complete catalog message, so no sentence is assembled from fragments (ADR 011).
 */

import { activePresetIdAfterDelete } from "@/features/settings/presetDocument";
import type { Preset } from "@/features/settings/types";
import type { MessageView } from "./presetPresenter";

export type ConfirmMessagesView = {
  title: MessageView;
  description: MessageView;
};

export type DeletePresetConfirmView = ConfirmMessagesView & {
  /** The preset the confirmed delete removes. */
  presetId: string;
};

/**
 * Presents the confirmation for deleting the preset `id`, or returns null when no preset has
 * that id.
 *
 * The title names the stored preset, not the draft, because the delete removes the stored
 * preset. When `id` is the active preset, the description also says which preset becomes
 * active. It asks `activePresetIdAfterDelete`, the rule that `deletePreset` itself applies,
 * so the name shown is the preset that the delete really makes active.
 */
export function presentDeletePresetConfirm(
  presets: readonly Preset[],
  activePresetId: string | null,
  id: string,
): DeletePresetConfirmView | null {
  const preset = presets.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    return null;
  }

  const title: MessageView = {
    key: "settings.preset.deleteDialog.title",
    values: { name: preset.name },
  };

  if (activePresetId !== id) {
    return {
      presetId: id,
      title,
      description: { key: "settings.preset.deleteDialog.description" },
    };
  }

  const nextActiveId = activePresetIdAfterDelete(presets, activePresetId, id);
  const nextActive = presets.find((candidate) => candidate.id === nextActiveId);
  if (nextActive === undefined) {
    return {
      presetId: id,
      title,
      description: { key: "settings.preset.deleteDialog.descriptionLast" },
    };
  }

  return {
    presetId: id,
    title,
    description: {
      key: "settings.preset.deleteDialog.descriptionDefault",
      values: { next: nextActive.name },
    },
  };
}

/**
 * Presents the confirmation for restoring the default presets.
 *
 * The description does not say how many presets the restore writes. The seed table lives in
 * Rust (`default_presets` in src-tauri/src/settings/defaults.rs), no command reports it, and
 * a copy of its length here would go stale without any test failing.
 */
export function presentRestoreDefaultsConfirm(): ConfirmMessagesView {
  return {
    title: { key: "settings.preset.restoreDialog.title" },
    description: { key: "settings.preset.restoreDialog.description" },
  };
}
