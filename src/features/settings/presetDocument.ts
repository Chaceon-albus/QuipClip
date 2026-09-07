/**
 * Pure document operations for the export preset library.
 *
 * The settings dialog has no per-preset command: every change to the preset library goes to
 * Rust as a whole replacement `Settings` document through `save_settings` (ADR 013). This
 * module is the algebra that builds the next document. It performs no IO and never mutates
 * its input, so the dangerous cases -- chiefly repairing `activePresetId` after a delete --
 * are testable with no store and no mock.
 */

import type { Rational, Resolution } from "@/types/project";

import type { Preset, Settings } from "./types";

/**
 * Resolution written when the user switches the output resolution setting from "same as
 * source" to a custom value. A product decision, not a derived constant, so it lives beside
 * `createPresetDraft`.
 */
export const DEFAULT_CUSTOM_RESOLUTION: Resolution = { w: 1920, h: 1080 };

/**
 * Frame rate written when the user switches the output frame rate setting from "same as
 * source" to a custom value. A product decision, not a derived constant, so it lives beside
 * `createPresetDraft`.
 */
export const DEFAULT_CUSTOM_FRAME_RATE: Rational = { n: 30, d: 1 };

/**
 * Builds a new export preset draft with sensible defaults for immediate creation.
 *
 * The defaults match the H.264 seed in `src-tauri/src/settings/defaults.rs`: mp4 container,
 * libx264 video encoder, aac audio encoder, CRF 20, source resolution, and source frame rate.
 *
 * The caller supplies `id` and `name`. This function never generates an id itself, so callers
 * that need deterministic tests inject one.
 */
export function createPresetDraft(id: string, name: string): Preset {
  return {
    id,
    name,
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
  };
}

/**
 * Finds the preset with the given id, or undefined when no preset matches.
 */
export function findPreset(settings: Settings, id: string): Preset | undefined {
  return settings.presets.find((preset) => preset.id === id);
}

/**
 * Builds the next `Settings` document from the given presets and active preset id.
 *
 * This SPREADS the loaded document rather than rebuilding it field by field, so every key
 * the caller loaded rides along untouched. `revision`, the ADR 013 compare-and-swap token,
 * is why that matters: a rebuilt document would drop it, and the save built on the result
 * would either fail the frontend validator or compare a revision nothing wrote. Every editor
 * in this module goes through here, so one spread covers all of them.
 *
 * `activePresetId` is deleted first and then written only when it is not undefined, so
 * callers that pass `undefined` get a document where the key is absent, never present with an
 * undefined value (ADR 013, RULE 2). `ffmpegPath` is preserved exactly by the spread: present
 * stays present with the same value, absent stays absent.
 */
function buildSettings(
  settings: Settings,
  presets: Preset[],
  activePresetId: string | undefined,
): Settings {
  const next: Settings = {
    ...settings,
    presets,
  };
  delete next.activePresetId;
  if (activePresetId !== undefined) {
    next.activePresetId = activePresetId;
  }
  return next;
}

/**
 * Appends a preset to the end of the library.
 *
 * This does NOT enforce `MAX_PRESETS`. A pure function that silently refused to add a preset
 * would be invisible to its caller, which is worse than an explicit check at the call site.
 * The caller must check `canAddPreset` from "./limits" before calling this function.
 *
 * This also does NOT check for an id already present in `settings.presets`. It appends
 * unconditionally, so appending a preset whose id collides with an existing one yields a
 * document Rust rejects with `DuplicatePresetId`. The caller must supply a fresh id.
 */
export function addPreset(settings: Settings, preset: Preset): Settings {
  const presets = [...settings.presets, preset];
  return buildSettings(settings, presets, settings.activePresetId);
}

/**
 * Replaces the preset with the matching id in place, preserving array order.
 *
 * Returns a document with the same values when no preset matches that id.
 */
export function updatePreset(settings: Settings, preset: Preset): Settings {
  const index = settings.presets.findIndex((existing) => existing.id === preset.id);
  const presets =
    index === -1
      ? [...settings.presets]
      : settings.presets.map((existing, i) => (i === index ? preset : existing));
  return buildSettings(settings, presets, settings.activePresetId);
}

/**
 * Removes the preset with the given id and repairs `activePresetId` so it never dangles.
 *
 * This module is the only place in the system that can create a dangling `activePresetId`:
 * it is the only code that removes a preset from a document that is then written back whole.
 * Rust does not tolerate the result: `save_settings` hard-rejects a dangling `activePresetId`
 * with `UnknownActivePreset`. Leaving the id pointed at a preset this function just removed
 * would make the settings file unwritable -- every later save would fail, for a reason the
 * user cannot see, until the application restarts. So:
 *
 * - When the removed preset was not active, `activePresetId` is left untouched.
 * - When the removed preset was active and other presets remain, `activePresetId` re-points
 *   to the preset that now occupies the removed index (the neighbour that slid into its
 *   place), or the last preset when the removed one was last. This moves the selection the
 *   way a user expects.
 * - When the removed preset was active and no presets remain, `activePresetId` is absent from
 *   the returned object.
 *
 * Deleting an id that is not present returns a document with the same values, unchanged.
 */
export function deletePreset(settings: Settings, id: string): Settings {
  const index = settings.presets.findIndex((preset) => preset.id === id);
  if (index === -1) {
    return buildSettings(settings, [...settings.presets], settings.activePresetId);
  }

  const presets = settings.presets.filter((preset) => preset.id !== id);

  if (settings.activePresetId !== id) {
    return buildSettings(settings, presets, settings.activePresetId);
  }

  if (presets.length === 0) {
    return buildSettings(settings, presets, undefined);
  }

  const nextActiveIndex = Math.min(index, presets.length - 1);
  return buildSettings(settings, presets, presets[nextActiveIndex].id);
}

/**
 * Sets or clears the active preset id.
 *
 * Passing `null` deletes the `activePresetId` key from the returned document rather than
 * setting it to an explicit `null` or `undefined` value (ADR 013, RULE 2).
 *
 * Passing a string that names no preset in `settings.presets` leaves `activePresetId`
 * unchanged -- present stays at its current value, absent stays absent -- rather than writing
 * the unknown id through. `save_settings` hard-rejects a dangling `activePresetId` with
 * `UnknownActivePreset`, which would make the settings file unwritable -- every later save
 * would fail, for a reason the user cannot see, until the application restarts.
 */
export function setActivePreset(settings: Settings, id: string | null): Settings {
  if (id === null) {
    return buildSettings(settings, [...settings.presets], undefined);
  }
  const nextActivePresetId =
    findPreset(settings, id) === undefined ? settings.activePresetId : id;
  return buildSettings(settings, [...settings.presets], nextActivePresetId);
}
