import { describe, expect, it } from "vitest";

import { deletePreset } from "@/features/settings/presetDocument";
import type { Preset, Settings } from "@/features/settings/types";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  presentDeletePresetConfirm,
  presentRestoreDefaultsConfirm,
} from "./presetConfirmPresenter";

/**
 * Resolves a dotted translation key path against a nested catalog object, mirroring how
 * i18next itself walks a namespaced key. Follows the same convention as
 * `presetPresenter.test.ts`.
 */
function resolveCatalogKey(catalog: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
}

function createPreset(id: string, name: string): Preset {
  return {
    id,
    name,
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
  };
}

const h264 = createPreset("default-h264-mp4", "H.264 MP4");
const hevc = createPreset("default-hevc-mp4", "HEVC MP4");
const mine = createPreset("mine", "My Preset");

describe("presentDeletePresetConfirm", () => {
  it("returns null when no preset has the id", () => {
    expect(
      presentDeletePresetConfirm([h264], "default-h264-mp4", "missing"),
    ).toBeNull();
  });

  it("names the preset in the title and carries its id for the confirmed delete", () => {
    const view = presentDeletePresetConfirm([h264, mine], "default-h264-mp4", "mine");
    expect(view?.title).toStrictEqual({
      key: "settings.preset.deleteDialog.title",
      values: { name: "My Preset" },
    });
    expect(view?.presetId).toBe("mine");
  });

  it("says only that the delete cannot be undone when the preset is not active", () => {
    const view = presentDeletePresetConfirm([h264, mine], "default-h264-mp4", "mine");
    expect(view?.description).toStrictEqual({
      key: "settings.preset.deleteDialog.description",
    });
  });

  it("says only that the delete cannot be undone when no preset is active", () => {
    const view = presentDeletePresetConfirm([h264, mine], null, "mine");
    expect(view?.description).toStrictEqual({
      key: "settings.preset.deleteDialog.description",
    });
  });

  it("names the preset that becomes active when the active preset is deleted", () => {
    const view = presentDeletePresetConfirm(
      [h264, hevc, mine],
      "default-hevc-mp4",
      "default-hevc-mp4",
    );
    expect(view?.description).toStrictEqual({
      key: "settings.preset.deleteDialog.descriptionDefault",
      values: { next: "My Preset" },
    });
  });

  it("names the new last preset when the deleted active preset was last", () => {
    const view = presentDeletePresetConfirm([h264, hevc, mine], "mine", "mine");
    expect(view?.description).toStrictEqual({
      key: "settings.preset.deleteDialog.descriptionDefault",
      values: { next: "HEVC MP4" },
    });
  });

  it("says that no preset stays active when the active preset is the only one", () => {
    const view = presentDeletePresetConfirm([mine], "mine", "mine");
    expect(view?.description).toStrictEqual({
      key: "settings.preset.deleteDialog.descriptionLast",
    });
  });

  // The confirmation promises which preset becomes active. It must be the one the delete
  // writes, for every position of the active preset.
  it("names the same preset that deletePreset makes active", () => {
    const presets = [h264, hevc, mine];
    for (const active of presets) {
      const view = presentDeletePresetConfirm(presets, active.id, active.id);
      const settings: Settings = {
        schemaVersion: 1,
        revision: 0,
        presets,
        activePresetId: active.id,
      };
      const nextActiveId = deletePreset(settings, active.id).activePresetId;
      const nextActive = presets.find((preset) => preset.id === nextActiveId);
      expect(view?.description.values).toStrictEqual({ next: nextActive?.name });
    }
  });

  it("emits only keys that exist in both catalogs", () => {
    const views = [
      presentDeletePresetConfirm([h264, mine], "default-h264-mp4", "mine"),
      presentDeletePresetConfirm([h264, mine], "mine", "mine"),
      presentDeletePresetConfirm([mine], "mine", "mine"),
    ];
    for (const view of views) {
      for (const message of [view?.title, view?.description]) {
        expect(message).toBeDefined();
        for (const catalog of [en, zhCN]) {
          expect(typeof resolveCatalogKey(catalog, message!.key)).toBe("string");
        }
      }
    }
  });
});

describe("presentRestoreDefaultsConfirm", () => {
  it("emits the title and a description with no values", () => {
    expect(presentRestoreDefaultsConfirm()).toStrictEqual({
      title: { key: "settings.preset.restoreDialog.title" },
      description: { key: "settings.preset.restoreDialog.description" },
    });
  });

  it("emits only keys that exist in both catalogs", () => {
    const { title, description } = presentRestoreDefaultsConfirm();
    for (const message of [title, description]) {
      for (const catalog of [en, zhCN]) {
        expect(typeof resolveCatalogKey(catalog, message.key)).toBe("string");
      }
    }
  });
});
