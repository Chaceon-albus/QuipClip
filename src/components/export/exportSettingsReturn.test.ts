import { afterEach, describe, expect, it, vi } from "vitest";

import { runExportFlow } from "@/components/layout/exportFlowController";
import { runNativeMenuAction } from "@/components/layout/useNativeMenuActions";
import type { ExportRunLiveState } from "@/features/export/runState";
import { EXPORT_STATUSES, type ExportStatus } from "@/features/export/types";
import type { MediaSourceRevisionDescriptor } from "@/features/media";
import {
  createSettingsPanelStore,
  settingsPanelStore,
} from "@/features/settings/panelStore";
import type { Preset, Settings } from "@/features/settings/types";
import type { Pts } from "@/types/project";
import { createOpenStepGeneration, runOpenStepAgain } from "./exportBackToSetup";
import {
  canReturnToSetup,
  createSettingsCloseListener,
  createSettingsReturnSlot,
  decideSettingsReturn,
  pickReturnPresetId,
  planSettingsReturn,
  type SettingsReturn,
  type SettingsReturnCloseInput,
} from "./exportSettingsReturn";
import { resolveSetupPresetId } from "./exportSetupPresenter";

const MEDIA: MediaSourceRevisionDescriptor = {
  path: "/media/source.mp4",
  size: 1000,
  mtime: 1_700_000_000,
};

const IDLE = { status: "idle", tracking: false } as const;

const PRESETS = [{ id: "a" }, { id: "b" }, { id: "c" }];

function createPreset(id: string): Preset {
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
  };
}

function createSettings(ids: string[], activePresetId?: string): Settings {
  return {
    schemaVersion: 1,
    revision: 1,
    presets: ids.map(createPreset),
    ...(activePresetId === undefined ? {} : { activePresetId }),
  };
}

function kept(overrides: Partial<SettingsReturn<string>> = {}): SettingsReturn<string> {
  return {
    keptPresetId: "b",
    shownPresetId: "b",
    media: MEDIA,
    opener: "export-button",
    ...overrides,
  };
}

function closeInput(
  overrides: Partial<SettingsReturnCloseInput<string>> = {},
): SettingsReturnCloseInput<string> {
  return {
    kept: kept(),
    returnTo: "exportSetup",
    exportState: IDLE,
    media: MEDIA,
    presets: PRESETS,
    settingsSelectedPresetId: "b",
    ...overrides,
  };
}

describe("canReturnToSetup", () => {
  // The setup step shows only while the store is idle. A live run is never idle, and a
  // `failed` that the store still tracks is live (ADR 025).
  it.each(EXPORT_STATUSES)(
    "returns only to an idle store, for status '%s'",
    (status: ExportStatus) => {
      expect(canReturnToSetup({ status, tracking: false }, MEDIA)).toBe(
        status === "idle",
      );
      if (status !== "idle") {
        expect(canReturnToSetup({ status, tracking: true }, MEDIA)).toBe(false);
      }
    },
  );

  it("refuses with no source", () => {
    expect(canReturnToSetup(IDLE, null)).toBe(false);
  });
});

describe("planSettingsReturn", () => {
  it("keeps the choice, the shown preset, the source revision and the opener", () => {
    expect(
      planSettingsReturn({
        exportState: IDLE,
        media: { ...MEDIA, fileName: "source.mp4" } as MediaSourceRevisionDescriptor,
        requestedPresetId: "c",
        shownPresetId: "c",
        opener: "export-button",
      }),
    ).toEqual({
      keptPresetId: "c",
      shownPresetId: "c",
      media: MEDIA,
      opener: "export-button",
    });
  });

  // The user did not change the select, and the step showed the default preset.
  it("keeps no choice when the user chose none", () => {
    const plan = planSettingsReturn({
      exportState: IDLE,
      media: MEDIA,
      requestedPresetId: null,
      shownPresetId: "a",
      opener: null,
    });
    expect(plan?.keptPresetId).toBeNull();
    expect(plan?.shownPresetId).toBe("a");
    expect(plan?.opener).toBeNull();
  });

  // The Open Settings button of an empty library or of a settings file that did not load.
  it("plans a return when the step lists no preset", () => {
    const plan = planSettingsReturn({
      exportState: IDLE,
      media: MEDIA,
      requestedPresetId: null,
      shownPresetId: null,
      opener: null,
    });
    expect(plan).not.toBeNull();
    expect(plan?.shownPresetId).toBeNull();
  });

  it("plans no return while a run is live, the store is not idle, or no source is open", () => {
    const base = {
      media: MEDIA,
      requestedPresetId: "b",
      shownPresetId: "b",
      opener: null,
    };
    expect(
      planSettingsReturn({
        ...base,
        exportState: { status: "running", tracking: true },
      }),
    ).toBeNull();
    expect(
      planSettingsReturn({
        ...base,
        exportState: { status: "failed", tracking: true },
      }),
    ).toBeNull();
    expect(
      planSettingsReturn({
        ...base,
        exportState: { status: "failed", tracking: false },
      }),
    ).toBeNull();
    expect(planSettingsReturn({ ...base, exportState: IDLE, media: null })).toBeNull();
  });
});

describe("pickReturnPresetId", () => {
  it("selects the preset that the user selected in Settings", () => {
    expect(
      pickReturnPresetId({
        presets: PRESETS,
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: "c",
      }),
    ).toBe("c");
  });

  it("keeps the choice when the selection in Settings did not change", () => {
    expect(
      pickReturnPresetId({
        presets: PRESETS,
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: "b",
      }),
    ).toBe("b");
  });

  // Settings then selects the neighbour, or nothing when the library is empty.
  it("keeps the choice when Settings selects nothing", () => {
    expect(
      pickReturnPresetId({
        presets: PRESETS,
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: null,
      }),
    ).toBe("b");
  });

  it("keeps the choice when the preset selected in Settings no longer exists", () => {
    expect(
      pickReturnPresetId({
        presets: PRESETS,
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: "gone",
      }),
    ).toBe("b");
  });

  it("falls back to the default when the kept choice no longer exists", () => {
    expect(
      pickReturnPresetId({
        presets: [{ id: "a" }, { id: "c" }],
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: "b",
      }),
    ).toBeNull();
  });

  // A delete of the shown preset moves the selection to its neighbour, which is a change.
  it("selects the neighbour that took the selection after a delete of the shown preset", () => {
    expect(
      pickReturnPresetId({
        presets: [{ id: "a" }, { id: "c" }],
        keptPresetId: "b",
        shownPresetId: "b",
        settingsSelectedPresetId: "c",
      }),
    ).toBe("c");
  });

  it("follows the default when the user chose none and did not change the selection", () => {
    expect(
      pickReturnPresetId({
        presets: PRESETS,
        keptPresetId: null,
        shownPresetId: "a",
        settingsSelectedPresetId: "a",
      }),
    ).toBeNull();
  });

  // An empty library, or a settings file that did not load: the step showed no preset.
  it("selects a preset that the user added when the step showed none", () => {
    expect(
      pickReturnPresetId({
        presets: [{ id: "new" }],
        keptPresetId: null,
        shownPresetId: null,
        settingsSelectedPresetId: "new",
      }),
    ).toBe("new");
  });

  it("gives the setup step the preset that ADR 024 names when it returns null", () => {
    // The user chose "b", then deleted it and set "c" as the default in Settings, and
    // selected "a" last. "a" is a change of the selection, so it wins.
    const settings = createSettings(["a", "c"], "c");
    const changed = pickReturnPresetId({
      presets: settings.presets,
      keptPresetId: "b",
      shownPresetId: "b",
      settingsSelectedPresetId: "a",
    });
    expect(resolveSetupPresetId(settings, changed)).toBe("a");

    // With no change of the selection and no kept preset, the default preset shows.
    const unchanged = pickReturnPresetId({
      presets: settings.presets,
      keptPresetId: "b",
      shownPresetId: "b",
      settingsSelectedPresetId: "b",
    });
    expect(unchanged).toBeNull();
    expect(resolveSetupPresetId(settings, unchanged)).toBe("c");
  });
});

describe("decideSettingsReturn", () => {
  it("opens the setup step again with the choice and the opener", () => {
    expect(decideSettingsReturn(closeInput())).toEqual({
      requestedPresetId: "b",
      opener: "export-button",
    });
  });

  it("selects the preset that the user selected in Settings", () => {
    expect(
      decideSettingsReturn(closeInput({ settingsSelectedPresetId: "c" }))
        ?.requestedPresetId,
    ).toBe("c");
  });

  it("drops the return when the export dialog kept nothing", () => {
    expect(decideSettingsReturn(closeInput({ kept: null }))).toBeNull();
  });

  // The status bar gear, the settings key and the menu item open a session with no return.
  it("drops the return for a settings session that the setup step did not open", () => {
    expect(decideSettingsReturn(closeInput({ returnTo: null }))).toBeNull();
  });

  it.each(EXPORT_STATUSES.filter((status) => status !== "idle"))(
    "drops the return when the store is '%s'",
    (status: ExportStatus) => {
      expect(
        decideSettingsReturn(closeInput({ exportState: { status, tracking: false } })),
      ).toBeNull();
      expect(
        decideSettingsReturn(closeInput({ exportState: { status, tracking: true } })),
      ).toBeNull();
    },
  );

  it("drops the return when the media closed", () => {
    expect(decideSettingsReturn(closeInput({ media: null }))).toBeNull();
  });

  it("drops the return when another file or another revision is open", () => {
    expect(
      decideSettingsReturn(
        closeInput({ media: { ...MEDIA, path: "/media/other.mp4" } }),
      ),
    ).toBeNull();
    expect(
      decideSettingsReturn(closeInput({ media: { ...MEDIA, size: 2000 } })),
    ).toBeNull();
    expect(
      decideSettingsReturn(closeInput({ media: { ...MEDIA, mtime: MEDIA.mtime + 1 } })),
    ).toBeNull();
  });

  // The same file at the same revision, imported again, keeps its segments (ADR 010).
  it("returns when the same revision of the same file is open again", () => {
    expect(decideSettingsReturn(closeInput({ media: { ...MEDIA } }))).not.toBeNull();
  });
});

describe("createSettingsReturnSlot", () => {
  it("gives back what it holds once", () => {
    const slot = createSettingsReturnSlot<string>();
    expect(slot.take()).toBeNull();

    const first = kept();
    slot.hold(first);
    expect(slot.take()).toBe(first);
    expect(slot.take()).toBeNull();
  });

  it("holds only the latest value", () => {
    const slot = createSettingsReturnSlot<string>();
    const second = kept({ keptPresetId: "c" });
    slot.hold(kept());
    slot.hold(second);
    expect(slot.take()).toBe(second);
  });
});

/** The readers of the close listener, as mocks that answer the given state. */
function readers(state: {
  exportState?: ExportRunLiveState;
  media?: MediaSourceRevisionDescriptor | null;
}) {
  return {
    readExportState: vi.fn(() => state.exportState ?? IDLE),
    readMedia: vi.fn(() => (state.media === undefined ? MEDIA : state.media)),
    readPresets: vi.fn(() => PRESETS),
  };
}

/** A panel store with the close listener that the export dialog subscribes to it. */
function listenToCloses(state: Parameters<typeof readers>[0] = {}) {
  const store = createSettingsPanelStore();
  const slot = createSettingsReturnSlot<string>();
  const read = readers(state);
  const onReturn = vi.fn();
  store.subscribe(createSettingsCloseListener({ slot, ...read, onReturn }));
  return { store, slot, read, onReturn };
}

describe("createSettingsCloseListener", () => {
  it("returns once, with the selection of the closed Presets tab", () => {
    const { store, slot, onReturn } = listenToCloses();

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    store.getState().setSelectedPresetId("c");
    store.getState().hide();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledWith({
      requestedPresetId: "c",
      opener: "export-button",
    });

    // The next opening is a normal one, and the slot is empty.
    store.getState().show();
    store.getState().hide();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("keeps the choice when the selection of the Presets tab did not change", () => {
    const { store, slot, onReturn } = listenToCloses();

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    store.getState().setSelectedPresetId("b");
    store.getState().hide();
    expect(onReturn).toHaveBeenCalledWith({
      requestedPresetId: "b",
      opener: "export-button",
    });
  });

  // The status bar gear, the settings key and the menu item open a session with no return. A
  // kept value can never make that session return, whatever the order.
  it("drops a kept choice at the close of a normal session", () => {
    const { store, slot, onReturn } = listenToCloses();

    slot.hold(kept());
    store.getState().show("ffmpeg");
    store.getState().hide();
    expect(onReturn).not.toHaveBeenCalled();
    expect(slot.take()).toBeNull();
  });

  it("acts on no change that is not a close, and reads no state for it", () => {
    const { store, slot, read, onReturn } = listenToCloses();

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    store.getState().setSelectedPresetId("c");
    store.getState().setSection("general");
    store.getState().setUnsavedPresetName("Bravo");
    // A close while the dialog is closed is no close.
    const closed = createSettingsPanelStore();
    closed.subscribe(createSettingsCloseListener({ slot, ...read, onReturn }));
    closed.getState().hide();

    expect(onReturn).not.toHaveBeenCalled();
    expect(read.readExportState).not.toHaveBeenCalled();
    expect(read.readMedia).not.toHaveBeenCalled();
    expect(read.readPresets).not.toHaveBeenCalled();
    expect(slot.take()).not.toBeNull();
  });

  // The unsaved-draft prompt keeps the dialog open, and the dialog calls `hide` only after
  // the answer: Save, Don't Save, or a close with no draft.
  it("waits for the close that the unsaved-draft prompt holds back", () => {
    const { store, slot, onReturn } = listenToCloses();

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    store.getState().setUnsavedPresetName("Bravo");
    expect(onReturn).not.toHaveBeenCalled();

    store.getState().setUnsavedPresetName(null);
    store.getState().hide();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("reads the export store at the close, and drops the return for a live run", () => {
    const state: { exportState: ExportRunLiveState } = { exportState: IDLE };
    const { store, slot, onReturn } = listenToCloses(state);

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    state.exportState = { status: "running", tracking: true };
    store.getState().hide();
    expect(onReturn).not.toHaveBeenCalled();
    expect(slot.take()).toBeNull();
  });

  it("reads the media at the close, and drops the return for a changed source", () => {
    const state: { media: MediaSourceRevisionDescriptor | null } = { media: MEDIA };
    const { store, slot, onReturn } = listenToCloses(state);

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    state.media = { ...MEDIA, mtime: MEDIA.mtime + 1 };
    store.getState().hide();

    slot.hold(kept());
    store.getState().show("presets", { selectPresetId: "b", returnTo: "exportSetup" });
    state.media = null;
    store.getState().hide();
    expect(onReturn).not.toHaveBeenCalled();
  });
});

/**
 * The options of one open step for the source `MEDIA`, whose source check answers only when
 * the test calls `answer`. `changed` makes the answer a changed file.
 */
function pendingOpenStep() {
  let answer: (changed: boolean) => void = () => {};
  const readSourceRevision = vi.fn(
    () =>
      new Promise<MediaSourceRevisionDescriptor>((resolve) => {
        answer = (changed) => {
          resolve({ ...MEDIA, size: changed ? MEDIA.size + 1 : MEDIA.size });
        };
      }),
  );
  const settings = createSettings(["a", "b"], "a");
  return {
    readSourceRevision,
    answer: (changed: boolean) => {
      answer(changed);
    },
    options: {
      filterName: "Video Files",
      getExportState: () => IDLE,
      getMedia: () => ({ ...MEDIA, fileName: "source.mp4" }),
      readSourceRevision,
      getSourceId: () => "src-1",
      getSegments: () => [
        { id: "s1", sourceId: "src-1", inPts: "0" as Pts, outPts: "100" as Pts },
      ],
      getSettings: () => settings,
    },
  };
}

/** The effects and the Export flag of the dialog, recorded. */
function dialogEffects() {
  const pending: boolean[] = [];
  return {
    pending,
    setPending: (value: boolean) => {
      pending.push(value);
    },
    effects: { setModalOpen: vi.fn(), reportError: vi.fn() },
  };
}

// The setup step shows only after the open step of ADR 024 passed. The settings dialog can
// close a Back step before its source check answered: the dialog closes, and the Back step
// becomes stale. Each return therefore runs the open step again, with a check of its own.
describe("the open step that a return runs", () => {
  it("reports a changed source that a stale Back step had not reported yet", async () => {
    const generation = createOpenStepGeneration();
    const back = pendingOpenStep();
    const backDialog = dialogEffects();
    const backStep = runOpenStepAgain({
      generation,
      effects: backDialog.effects,
      setPending: backDialog.setPending,
      run: (effects) => runExportFlow({ ...effects, ...back.options }),
    });
    await vi.waitFor(() => {
      expect(back.readSourceRevision).toHaveBeenCalled();
    });

    // "Manage Presets..." closes the dialog, which makes the Back step stale, and the
    // settings dialog closes again before the check of the Back step answers.
    generation.invalidate();
    const again = pendingOpenStep();
    const dialog = dialogEffects();
    const returnStep = runOpenStepAgain({
      generation,
      effects: dialog.effects,
      setPending: dialog.setPending,
      run: (effects) =>
        runExportFlow({ ...effects, ...again.options }, { replace: true }),
    });
    await vi.waitFor(() => {
      expect(again.readSourceRevision).toHaveBeenCalled();
    });
    expect(dialog.pending).toEqual([true]);

    // The stale step answers first. It changes nothing, and Export stays disabled.
    back.answer(true);
    await expect(backStep).resolves.toBe(false);
    expect(backDialog.effects.reportError).not.toHaveBeenCalled();
    expect(backDialog.effects.setModalOpen).not.toHaveBeenCalled();
    expect(backDialog.pending).toEqual([true]);
    expect(dialog.pending).toEqual([true]);

    // The check of the return reports the change, and the confirmation shows.
    again.answer(true);
    await expect(returnStep).resolves.toBe(false);
    expect(dialog.effects.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "sourceRevisionChanged" }),
    );
    expect(dialog.pending).toEqual([true, false]);
  });

  it("enables Export when the source check of the return passes", async () => {
    const generation = createOpenStepGeneration();
    const step = pendingOpenStep();
    const dialog = dialogEffects();
    const returnStep = runOpenStepAgain({
      generation,
      effects: dialog.effects,
      setPending: dialog.setPending,
      run: (effects) =>
        runExportFlow({ ...effects, ...step.options }, { replace: true }),
    });
    await vi.waitFor(() => {
      expect(step.readSourceRevision).toHaveBeenCalled();
    });
    expect(dialog.pending).toEqual([true]);

    step.answer(false);
    await expect(returnStep).resolves.toBe(true);
    expect(dialog.effects.reportError).not.toHaveBeenCalled();
    expect(dialog.pending).toEqual([true, false]);
  });

  // Without `replace`, the guard of `runExportFlow` refuses the step while the stale Back step
  // waits, and the setup step would enable Export with no check.
  it("needs replace: a plain step for the same file gets no check while a stale one waits", async () => {
    const generation = createOpenStepGeneration();
    const back = pendingOpenStep();
    const backStep = runOpenStepAgain({
      generation,
      effects: dialogEffects().effects,
      setPending: () => {},
      run: (effects) => runExportFlow({ ...effects, ...back.options }),
    });
    await vi.waitFor(() => {
      expect(back.readSourceRevision).toHaveBeenCalled();
    });
    generation.invalidate();

    const plain = pendingOpenStep();
    await expect(
      runExportFlow({ ...dialogEffects().effects, ...plain.options }),
    ).resolves.toBe(false);
    expect(plain.readSourceRevision).not.toHaveBeenCalled();

    back.answer(false);
    await backStep;
  });
});

describe("a normal opening of Settings", () => {
  afterEach(() => {
    settingsPanelStore.getState().hide();
  });

  // The menu item plans the same command as the settings key (ADR 026).
  it("carries no return from the Settings item of the menu", () => {
    settingsPanelStore.getState().show("presets", {
      selectPresetId: "b",
      returnTo: "exportSetup",
    });
    settingsPanelStore.getState().hide();

    runNativeMenuAction("openSettings");
    expect(settingsPanelStore.getState().open).toBe(true);
    expect(settingsPanelStore.getState().returnTo).toBeNull();
    expect(settingsPanelStore.getState().openingPresetId).toBeNull();
  });
});
