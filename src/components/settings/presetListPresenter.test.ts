import { describe, expect, it } from "vitest";
import { MAX_PRESETS } from "@/features/settings/limits";
import type { Preset, QualityKind, Settings } from "@/features/settings/types";
import { createI18nInstance } from "@/i18n";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  createPresetLibraryController,
  type PresetLibraryView,
} from "./presetLibraryController";
import {
  canStartPresetDelete,
  findListFocusRow,
  findPresetRow,
  findTabStopRow,
  pickDefaultPresetId,
  pickListTabStopId,
  pickSelectionAfterDelete,
  PRESET_ROW_ID_ATTRIBUTE,
  presentAddPresetAction,
  presentDeletePresetAction,
  presentDuplicateSelectedAction,
  presentPresetRowSummary,
  presentRestoreBuiltInAction,
} from "./presetListPresenter";

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

function createPreset(id: string, overrides: Partial<Preset> = {}): Preset {
  return {
    id,
    name: `Preset ${id}`,
    container: "mp4",
    videoEncoder: "libx264",
    audioEncoder: "aac",
    audioBitrate: 320,
    audioSampleRate: "source",
    audioChannels: "source",
    quality: { kind: "crf", value: 20 },
    resolution: "source",
    frameRate: "source",
    ...overrides,
  };
}

/**
 * Drives a real controller to the view under test, so each action is presented from the view
 * the controller really produces and not from a hand-built copy of it.
 */
function viewAfter(
  presets: Preset[],
  act: (controller: ReturnType<typeof createPresetLibraryController>) => void = () =>
    undefined,
): PresetLibraryView {
  const settings: Settings = { schemaVersion: 1, revision: 7, presets };
  const controller = createPresetLibraryController({ getSettings: () => settings });
  act(controller);
  return controller.getView();
}

async function translatorFor(language: "en" | "zh-CN") {
  const instance = await createI18nInstance({
    initialPreference: language,
    storage: null,
    systemLanguages: [],
  });
  return instance.t as unknown as (
    key: string,
    options?: Record<string, string | number>,
  ) => string;
}

const formatter = new Intl.NumberFormat("en");

describe("presentPresetRowSummary", () => {
  it("names the container, the video encoder, and a CRF", () => {
    expect(presentPresetRowSummary(createPreset("a"), formatter)).toStrictEqual({
      key: "settings.preset.rowSummaryCrf",
      values: { container: "MP4", encoder: "libx264", value: "20" },
    });
  });

  it("selects the message of each quality kind", () => {
    const keys = (["crf", "bitrate", "qualityScale"] as const).map(
      (kind: QualityKind) =>
        presentPresetRowSummary(
          createPreset("a", { quality: { kind, value: 5 } }),
          formatter,
        ).key,
    );
    expect(keys).toStrictEqual([
      "settings.preset.rowSummaryCrf",
      "settings.preset.rowSummaryBitrate",
      "settings.preset.rowSummaryQualityScale",
    ]);
  });

  it("formats the quality value with the formatter of the interface language", () => {
    const preset = createPreset("a", {
      container: "mkv",
      quality: { kind: "bitrate", value: 8000 },
    });
    expect(presentPresetRowSummary(preset, formatter).values).toStrictEqual({
      container: "MKV",
      encoder: "libx264",
      value: "8,000",
    });
  });

  // The line never asks the capability probe, so a hardware encoder that this machine does
  // not have and a custom name both show verbatim. The encoder mark reports availability.
  it.each(["h264_nvenc", "my-encoder_2.0", "a".repeat(64)])(
    "shows the encoder name %s verbatim",
    (encoder) => {
      const summary = presentPresetRowSummary(
        createPreset("a", { videoEncoder: encoder }),
        formatter,
      );
      expect(summary.values?.encoder).toBe(encoder);
    },
  );

  it("names only keys that both catalogs define", () => {
    for (const kind of ["crf", "bitrate", "qualityScale"] as const) {
      const { key } = presentPresetRowSummary(
        createPreset("a", { quality: { kind, value: 1 } }),
        formatter,
      );
      expect(typeof resolveCatalogKey(en, key)).toBe("string");
      expect(typeof resolveCatalogKey(zhCN, key)).toBe("string");
    }
  });

  it.each([
    ["en", "crf", 20, "MP4 · libx264 · CRF 20"],
    ["en", "bitrate", 8000, "MP4 · libx264 · 8,000 kbps"],
    ["en", "qualityScale", 5, "MP4 · libx264 · Quality scale 5"],
    ["zh-CN", "crf", 20, "MP4 · libx264 · CRF 20"],
    ["zh-CN", "bitrate", 8000, "MP4 · libx264 · 8,000 kbps"],
    ["zh-CN", "qualityScale", 5, "MP4 · libx264 · 质量系数 5"],
  ] as const)(
    "renders the %s line for %s %i",
    async (language, kind, value, expected) => {
      const translate = await translatorFor(language);
      const summary = presentPresetRowSummary(
        createPreset("a", { quality: { kind, value } }),
        new Intl.NumberFormat(language),
      );
      expect(translate(summary.key, summary.values)).toBe(expected);
    },
  );

  // A stored encoder name is user data. i18next must not escape it.
  it("renders an encoder name with punctuation unchanged", async () => {
    const translate = await translatorFor("en");
    const summary = presentPresetRowSummary(
      createPreset("a", { videoEncoder: "my-enc.v2_x" }),
      formatter,
    );
    expect(translate(summary.key, summary.values)).toBe("MP4 · my-enc.v2_x · CRF 20");
  });
});

describe("pickDefaultPresetId", () => {
  const presets = [createPreset("a"), createPreset("b"), createPreset("c")];

  it("selects the active preset", () => {
    expect(pickDefaultPresetId(presets, "b")).toBe("b");
  });

  it("selects the first preset when no preset has the active id", () => {
    expect(pickDefaultPresetId(presets, "gone")).toBe("a");
  });

  it("selects the first preset when there is no active id", () => {
    expect(pickDefaultPresetId(presets, null)).toBe("a");
  });

  it("returns null for an empty library", () => {
    expect(pickDefaultPresetId([], "a")).toBeNull();
    expect(pickDefaultPresetId([], null)).toBeNull();
  });
});

describe("pickSelectionAfterDelete", () => {
  const ids = ["a", "b", "c"];

  it("selects the row after the deleted row", () => {
    expect(pickSelectionAfterDelete(ids, "a")).toBe("b");
    expect(pickSelectionAfterDelete(ids, "b")).toBe("c");
  });

  it("selects the row before the deleted row when it was the last row", () => {
    expect(pickSelectionAfterDelete(ids, "c")).toBe("b");
  });

  it("returns null when the deleted row was the only row", () => {
    expect(pickSelectionAfterDelete(["a"], "a")).toBeNull();
  });

  it("returns null when no row has the id", () => {
    expect(pickSelectionAfterDelete(ids, "gone")).toBeNull();
    expect(pickSelectionAfterDelete([], "a")).toBeNull();
  });
});

describe("pickListTabStopId", () => {
  const ids = ["a", "b", "c"];

  it("puts the Tab stop on the selected row", () => {
    expect(pickListTabStopId(ids, "b")).toBe("b");
  });

  it("puts the Tab stop on the first row when no row is selected", () => {
    expect(pickListTabStopId(ids, null)).toBe("a");
  });

  it("puts the Tab stop on the first row when the selection names no row", () => {
    expect(pickListTabStopId(ids, "gone")).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(pickListTabStopId([], null)).toBeNull();
  });
});

describe("presentAddPresetAction", () => {
  const ready = { ready: true, canAdd: true, pending: false };

  it("enables Add with no reason", () => {
    expect(presentAddPresetAction(ready)).toStrictEqual({
      disabled: false,
      reason: null,
    });
  });

  it("disables Add with no reason before the document loads", () => {
    expect(presentAddPresetAction({ ...ready, ready: false })).toStrictEqual({
      disabled: true,
      reason: null,
    });
  });

  it("disables Add in a full library and gives the limit message", () => {
    expect(presentAddPresetAction({ ...ready, canAdd: false })).toStrictEqual({
      disabled: true,
      reason: { key: "settings.preset.limitReached", values: { max: MAX_PRESETS } },
    });
  });

  it("disables Add with no reason while a write is in flight", () => {
    expect(presentAddPresetAction({ ...ready, pending: true })).toStrictEqual({
      disabled: true,
      reason: null,
    });
  });

  // The section asks about the draft first, so an unsaved edit leaves Add on.
  it("keeps Add on over an unsaved draft", () => {
    const view = viewAfter([createPreset("a")], (controller) => {
      controller.select("a");
      controller.setName("Edited");
    });
    expect(view.dirty).toBe(true);
    expect(presentAddPresetAction(view).disabled).toBe(false);
  });
});

describe("canStartPresetDelete", () => {
  it("is true when the document is loaded and no write is in flight", () => {
    expect(canStartPresetDelete({ ready: true, pending: false })).toBe(true);
  });

  it("is false before the document loads or while a write is in flight", () => {
    expect(canStartPresetDelete({ ready: false, pending: false })).toBe(false);
    expect(canStartPresetDelete({ ready: true, pending: true })).toBe(false);
  });
});

describe("presentDeletePresetAction", () => {
  const presets = [createPreset("a"), createPreset("b")];

  it("enables Delete for a selected preset", () => {
    const view = viewAfter(presets, (controller) => controller.select("b"));
    expect(presentDeletePresetAction(view)).toStrictEqual({
      disabled: false,
      reason: null,
    });
  });

  it("disables Delete when no preset is selected", () => {
    expect(presentDeletePresetAction(viewAfter(presets)).disabled).toBe(true);
  });

  it("disables Delete when the selection names no preset", () => {
    const view = viewAfter(presets, (controller) => controller.select("gone"));
    expect(presentDeletePresetAction(view).disabled).toBe(true);
  });

  it("disables Delete while a write is in flight or before the document loads", () => {
    const view = viewAfter(presets, (controller) => controller.select("a"));
    expect(presentDeletePresetAction({ ...view, pending: true }).disabled).toBe(true);
    expect(presentDeletePresetAction({ ...view, ready: false }).disabled).toBe(true);
  });

  // The delete confirmation covers an unsaved edit of the preset it deletes.
  it("keeps Delete on over an unsaved draft", () => {
    const view = viewAfter(presets, (controller) => {
      controller.select("a");
      controller.setName("Edited");
    });
    expect(presentDeletePresetAction(view).disabled).toBe(false);
  });
});

describe("presentDuplicateSelectedAction", () => {
  const presets = [createPreset("a"), createPreset("b")];

  it("enables Duplicate for a clean, selected preset", () => {
    const view = viewAfter(presets, (controller) => controller.select("a"));
    expect(presentDuplicateSelectedAction(view)).toStrictEqual({
      disabled: false,
      reason: null,
    });
  });

  it("disables Duplicate with no reason when no preset is selected", () => {
    expect(presentDuplicateSelectedAction(viewAfter(presets))).toStrictEqual({
      disabled: true,
      reason: null,
    });
  });

  it("disables Duplicate with no reason before the document loads", () => {
    const view = viewAfter(presets, (controller) => controller.select("a"));
    expect(presentDuplicateSelectedAction({ ...view, ready: false })).toStrictEqual({
      disabled: true,
      reason: null,
    });
  });

  it("keeps the rules of presentDuplicatePresetAction for a selected preset", () => {
    const dirty = viewAfter(presets, (controller) => {
      controller.select("a");
      controller.setName("Edited");
    });
    expect(presentDuplicateSelectedAction(dirty)).toStrictEqual({
      disabled: true,
      reason: { key: "settings.preset.duplicateBlockedUnsaved" },
    });

    const clean = viewAfter(presets, (controller) => controller.select("a"));
    expect(presentDuplicateSelectedAction({ ...clean, canAdd: false })).toStrictEqual({
      disabled: true,
      reason: { key: "settings.preset.limitReached", values: { max: MAX_PRESETS } },
    });
    expect(presentDuplicateSelectedAction({ ...clean, pending: true })).toStrictEqual({
      disabled: true,
      reason: null,
    });
  });
});

describe("presentRestoreBuiltInAction", () => {
  it("enables Restore Built-in Presets when the document is loaded and no write is in flight", () => {
    expect(presentRestoreBuiltInAction({ ready: true, pending: false })).toStrictEqual({
      disabled: false,
      reason: null,
    });
  });

  it("disables Restore Built-in Presets before the document loads or while a write is in flight", () => {
    expect(presentRestoreBuiltInAction({ ready: false, pending: false }).disabled).toBe(
      true,
    );
    expect(presentRestoreBuiltInAction({ ready: true, pending: true }).disabled).toBe(
      true,
    );
  });
});

describe("findPresetRow", () => {
  type FakeRow = { id: string; getAttribute: (name: string) => string | null };

  function fakeList(ids: readonly string[]) {
    const rows: FakeRow[] = ids.map((id) => ({
      id,
      getAttribute: (name) => (name === PRESET_ROW_ID_ATTRIBUTE ? id : null),
    }));
    const selectors: string[] = [];
    const list = {
      querySelectorAll: (selector: string) => {
        selectors.push(selector);
        return rows;
      },
    };
    return { list: list as unknown as HTMLElement, rows, selectors };
  }

  it("returns the row whose attribute holds the id", () => {
    const { list, rows } = fakeList(["a", "b", "c"]);
    expect(findPresetRow(list, "b")).toBe(rows[1]);
  });

  // The id is free text, so the query names the attribute only, and the match compares values.
  it("finds an id that would not parse inside a selector", () => {
    const { list, rows, selectors } = fakeList(['a"] b', "c"]);
    expect(findPresetRow(list, 'a"] b')).toBe(rows[0]);
    expect(selectors).toStrictEqual([`[${PRESET_ROW_ID_ATTRIBUTE}]`]);
  });

  it("returns null for no list, no id, or no matching row", () => {
    const { list } = fakeList(["a"]);
    expect(findPresetRow(null, "a")).toBeNull();
    expect(findPresetRow(list, null)).toBeNull();
    expect(findPresetRow(list, "gone")).toBeNull();
  });
});

describe("findTabStopRow", () => {
  it("asks the list for the row that holds the Tab stop", () => {
    const row = { id: "b" };
    const selectors: string[] = [];
    const list = {
      querySelector: (selector: string) => {
        selectors.push(selector);
        return row;
      },
    } as unknown as HTMLElement;

    expect(findTabStopRow(list)).toBe(row);
    expect(selectors).toStrictEqual([`[${PRESET_ROW_ID_ATTRIBUTE}][tabindex="0"]`]);
  });

  it("returns null for no list, or a list with no rows", () => {
    const empty = { querySelector: () => null } as unknown as HTMLElement;
    expect(findTabStopRow(null)).toBeNull();
    expect(findTabStopRow(empty)).toBeNull();
  });
});

describe("findListFocusRow", () => {
  type FakeRow = { id: string; getAttribute: (name: string) => string | null };

  function fakeList(ids: readonly string[], tabStopId: string | null) {
    const rows: FakeRow[] = ids.map((id) => ({
      id,
      getAttribute: (name) => (name === PRESET_ROW_ID_ATTRIBUTE ? id : null),
    }));
    const list = {
      querySelectorAll: () => rows,
      querySelector: () => rows.find((row) => row.id === tabStopId) ?? null,
    };
    return { list: list as unknown as HTMLElement, rows };
  }

  // A slow delete: the deleted row "b" still holds the Tab stop, and the neighbour "c" is on
  // screen. The focus goes to the neighbour, not to the row that is about to leave.
  it("prefers the row of the preferred id while it is on screen", () => {
    const { list, rows } = fakeList(["a", "b", "c"], "b");
    expect(findListFocusRow(list, "c")).toBe(rows[2]);
  });

  // The write ended and the selection is empty for a moment, so the Tab stop is on the first row.
  it("keeps the preferred row when the Tab stop moved to the first row", () => {
    const { list, rows } = fakeList(["a", "c"], "a");
    expect(findListFocusRow(list, "c")).toBe(rows[1]);
  });

  it("falls back to the Tab stop when the preferred row is not on screen, or there is none", () => {
    const { list, rows } = fakeList(["a", "b"], "b");
    expect(findListFocusRow(list, "gone")).toBe(rows[1]);
    expect(findListFocusRow(list, null)).toBe(rows[1]);
  });

  it("returns null for an empty list or no list", () => {
    const { list } = fakeList([], null);
    expect(findListFocusRow(list, "a")).toBeNull();
    expect(findListFocusRow(null, "a")).toBeNull();
  });
});
