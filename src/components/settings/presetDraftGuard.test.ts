import { describe, expect, it } from "vitest";

import type { PromptFocusTarget } from "@/components/common/focusTarget";
import type { Preset, Settings } from "@/features/settings/types";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  CLEAN_PRESET_DRAFT_GUARD,
  decideCloseRequest,
  decideLeavePromptKey,
  decideLeaveRequest,
  decidePromptSaveOutcome,
  isFocusLost,
  isInsideLeavePrompt,
  isUnsavedPresetRow,
  pickCreateFailureFocus,
  pickPromptCancelFocus,
  pickPromptOpenFocus,
  pickPromptReturnFocus,
  PRESET_LEAVE_PROMPT_ATTRIBUTE,
  presentPresetDraftStatus,
  presentSaveAndLeaveLabel,
  presentUnsavedDraftPrompt,
  type FocusHolderProbe,
  type PresetDraftStatus,
} from "./presetDraftGuard";
import {
  createPresetLibraryController,
  type PresetLibraryView,
} from "./presetLibraryController";

/**
 * Resolves a dotted translation key path against a nested catalog object, mirroring how
 * i18next itself walks a namespaced key. Follows the same convention as
 * `presetConfirmPresenter.test.ts`.
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

/**
 * Drives a real controller to the view under test, so the status is derived from the view
 * the controller really produces and not from a hand-built copy of it.
 */
function viewAfter(
  presets: Preset[],
  act: (controller: ReturnType<typeof createPresetLibraryController>) => void,
): PresetLibraryView {
  const settings: Settings = { schemaVersion: 1, revision: 7, presets };
  const controller = createPresetLibraryController({ getSettings: () => settings });
  act(controller);
  return controller.getView();
}

const h264 = createPreset("default-h264-mp4", "H.264 MP4");
const mine = createPreset("mine", "My Preset");

function status(overrides: Partial<PresetDraftStatus> = {}): PresetDraftStatus {
  return {
    dirty: true,
    presetName: "My Preset",
    canSave: true,
    pending: false,
    ...overrides,
  };
}

/** A focus target that can take the focus unless an override says otherwise. */
function fakeTarget(overrides: Partial<PromptFocusTarget> = {}): PromptFocusTarget {
  return {
    isConnected: true,
    isRendered: true,
    isDisabled: false,
    focus: () => {},
    ...overrides,
  };
}

describe("presentPresetDraftStatus", () => {
  it("reports a clean status with no name when there is no draft", () => {
    const view = viewAfter([h264, mine], () => undefined);
    expect(presentPresetDraftStatus(view)).toStrictEqual({
      dirty: false,
      presetName: null,
      canSave: false,
      pending: false,
    });
  });

  it("reports a clean status for a draft that has no edit", () => {
    const view = viewAfter([h264, mine], (controller) => controller.select("mine"));
    expect(presentPresetDraftStatus(view)).toStrictEqual({
      dirty: false,
      presetName: "My Preset",
      canSave: false,
      pending: false,
    });
  });

  it("copies dirty and canSave from the controller for an edited draft", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.setContainer("mkv");
    });
    expect(presentPresetDraftStatus(view)).toMatchObject({
      dirty: true,
      canSave: true,
    });
  });

  it("reports canSave false for an edited draft with an issue", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.updateQualityValue("");
    });
    expect(presentPresetDraftStatus(view)).toMatchObject({
      dirty: true,
      canSave: false,
    });
  });

  // The list shows the stored name, and a renamed draft can hold a half-typed or empty name.
  it("names the stored preset, not the renamed draft", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.setName("");
    });
    expect(presentPresetDraftStatus(view).presetName).toBe("My Preset");
  });

  it("falls back to the draft name when the document has no preset with the draft id", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.updateDraft({ id: "not-stored", name: "Draft Name" });
    });
    expect(presentPresetDraftStatus(view).presetName).toBe("Draft Name");
  });

  it("copies pending from the controller", () => {
    const view: PresetLibraryView = {
      ...viewAfter([mine], (controller) => controller.select("mine")),
      pending: true,
    };
    expect(presentPresetDraftStatus(view).pending).toBe(true);
  });
});

describe("decideCloseRequest", () => {
  it("closes when the draft holds no unsaved edit", () => {
    expect(decideCloseRequest(status({ dirty: false }), false)).toBe("close");
  });

  it("closes when no preset library is mounted", () => {
    expect(decideCloseRequest(CLEAN_PRESET_DRAFT_GUARD, false)).toBe("close");
  });

  // The prompt clears itself once the draft is clean, but a request in the same tick can
  // still see it open. There is nothing left to lose, so the request closes the dialog.
  it("closes when the draft became clean while the prompt was still open", () => {
    expect(decideCloseRequest(status({ dirty: false }), true)).toBe("close");
  });

  it("raises the prompt for a dirty draft when no prompt is open", () => {
    expect(decideCloseRequest(status(), false)).toBe("raise");
  });

  // A draft that cannot be saved still holds work that a close would lose.
  it("raises the prompt for a dirty draft that cannot be saved", () => {
    expect(decideCloseRequest(status({ canSave: false }), false)).toBe("raise");
  });

  it("raises the prompt while a write is in flight", () => {
    expect(decideCloseRequest(status({ pending: true }), false)).toBe("raise");
  });

  it("cancels the open prompt, as its Cancel button does", () => {
    expect(decideCloseRequest(status(), true)).toBe("cancel");
    expect(decideCloseRequest(status({ canSave: false }), true)).toBe("cancel");
  });

  // Cancel is disabled while a save is in flight, so the request must not do what it cannot.
  it("holds the open prompt while a save is in flight", () => {
    expect(decideCloseRequest(status({ pending: true }), true)).toBe("hold");
  });

  // Only one prompt at a time: Escape from a row, the header close button, and the footer
  // Close button all go to the prompt of the preset library while it is open.
  it("defers to the prompt of the preset library while it is open", () => {
    expect(decideCloseRequest(status(), false, true)).toBe("defer");
    expect(decideCloseRequest(status({ canSave: false }), false, true)).toBe("defer");
    expect(decideCloseRequest(status({ pending: true }), false, true)).toBe("defer");
  });

  it("still closes a clean draft, because the prompt of the library closes with the edit", () => {
    expect(decideCloseRequest(status({ dirty: false }), false, true)).toBe("close");
  });

  it("treats a missing third argument as a closed library prompt", () => {
    expect(decideCloseRequest(status(), false)).toBe("raise");
  });
});

describe("decideLeaveRequest", () => {
  it("ignores a request while a write is in flight", () => {
    expect(decideLeaveRequest({ dirty: true, pending: true }, false)).toBe("ignore");
    expect(decideLeaveRequest({ dirty: false, pending: true }, false)).toBe("ignore");
    expect(decideLeaveRequest({ dirty: true, pending: true }, true)).toBe("ignore");
  });

  it("leaves a clean draft at once", () => {
    expect(decideLeaveRequest({ dirty: false, pending: false }, false)).toBe("leave");
  });

  it("raises the prompt of the preset library for an unsaved edit", () => {
    expect(decideLeaveRequest({ dirty: true, pending: false }, false)).toBe("raise");
  });

  // Only one prompt at a time: the footer prompt already asks about this draft.
  it("defers to the prompt of the settings dialog while it is open", () => {
    expect(decideLeaveRequest({ dirty: true, pending: false }, true)).toBe("defer");
  });
});

describe("decideLeavePromptKey", () => {
  it("answers Escape with Keep Editing", () => {
    expect(decideLeavePromptKey("Escape", { choicesDisabled: false })).toBe(
      "keepEditing",
    );
  });

  // Keep Editing is disabled while a save that the prompt started is in flight.
  it("holds the prompt on Escape while a save is in flight", () => {
    expect(decideLeavePromptKey("Escape", { choicesDisabled: true })).toBe("hold");
  });

  it.each(["Enter", " ", "Tab", "ArrowDown"])("ignores %s", (key) => {
    expect(decideLeavePromptKey(key, { choicesDisabled: false })).toBe("ignore");
  });
});

describe("isInsideLeavePrompt", () => {
  it("asks the target for an ancestor with the prompt attribute", () => {
    const selectors: string[] = [];
    const inside = {
      closest: (selector: string) => {
        selectors.push(selector);
        return {};
      },
    };
    expect(isInsideLeavePrompt(inside)).toBe(true);
    expect(selectors).toStrictEqual([`[${PRESET_LEAVE_PROMPT_ATTRIBUTE}]`]);
  });

  it("is false for a target outside the prompt, or for no target", () => {
    expect(isInsideLeavePrompt({ closest: () => null })).toBe(false);
    expect(isInsideLeavePrompt(null)).toBe(false);
  });
});

describe("decidePromptSaveOutcome", () => {
  it("closes after a save that succeeded", () => {
    expect(decidePromptSaveOutcome(true, false)).toBe("close");
  });

  it("reveals the error after a save that failed", () => {
    expect(decidePromptSaveOutcome(false, true)).toBe("revealError");
  });

  // An edit that arrived during the write keeps the draft dirty with no error to show.
  it("stays on the prompt after a save that left an edit unsaved", () => {
    expect(decidePromptSaveOutcome(false, false)).toBe("stay");
  });
});

describe("CLEAN_PRESET_DRAFT_GUARD", () => {
  it("reports that nothing unsaved remains, so a stray save call never blocks a close", async () => {
    await expect(CLEAN_PRESET_DRAFT_GUARD.save()).resolves.toBe(true);
    expect(() => CLEAN_PRESET_DRAFT_GUARD.discard()).not.toThrow();
  });

  it("reports no prompt of the preset library", () => {
    expect(CLEAN_PRESET_DRAFT_GUARD.leavePromptOpen).toBe(false);
    expect(() => CLEAN_PRESET_DRAFT_GUARD.focusLeavePrompt()).not.toThrow();
  });
});

describe("presentUnsavedDraftPrompt", () => {
  it("returns null when the draft holds no unsaved edit", () => {
    expect(presentUnsavedDraftPrompt(status({ dirty: false }))).toBeNull();
    expect(presentUnsavedDraftPrompt(CLEAN_PRESET_DRAFT_GUARD)).toBeNull();
  });

  it("names the preset in one complete message", () => {
    expect(presentUnsavedDraftPrompt(status())?.message).toStrictEqual({
      key: "settings.preset.unsavedPrompt",
      values: { name: "My Preset" },
    });
  });

  it("enables every choice for a draft that can be saved", () => {
    expect(presentUnsavedDraftPrompt(status())).toMatchObject({
      saveDisabled: false,
      choicesDisabled: false,
    });
  });

  it("disables only the save button for a draft that cannot be saved", () => {
    expect(presentUnsavedDraftPrompt(status({ canSave: false }))).toMatchObject({
      saveDisabled: true,
      choicesDisabled: false,
    });
  });

  it("disables every choice while a write is in flight", () => {
    expect(presentUnsavedDraftPrompt(status({ pending: true }))).toMatchObject({
      saveDisabled: true,
      choicesDisabled: true,
    });
  });

  it("emits only keys that exist in both catalogs, each with the name placeholder", () => {
    const message = presentUnsavedDraftPrompt(status())?.message;
    expect(message).toBeDefined();
    for (const catalog of [en, zhCN]) {
      const text = resolveCatalogKey(catalog, message!.key);
      expect(typeof text).toBe("string");
      expect(text).toContain("{{name}}");
    }
  });

  it("uses button labels that exist in both catalogs", () => {
    for (const key of [
      "settings.preset.dontSave",
      "settings.preset.discardConfirm",
      "settings.preset.discardCancel",
      "settings.preset.saveAndSwitch",
      "settings.preset.saveAndAdd",
      "settings.preset.unsaved",
      "common.cancel",
      "common.save",
    ]) {
      for (const catalog of [en, zhCN]) {
        expect(typeof resolveCatalogKey(catalog, key)).toBe("string");
      }
    }
  });
});

describe("isUnsavedPresetRow", () => {
  it("marks only the selected row while its draft is dirty", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.setName("Renamed");
    });
    expect(isUnsavedPresetRow(view, "mine")).toBe(true);
    expect(isUnsavedPresetRow(view, "default-h264-mp4")).toBe(false);
  });

  it("marks no row while the draft is clean", () => {
    const view = viewAfter([h264, mine], (controller) => controller.select("mine"));
    expect(isUnsavedPresetRow(view, "mine")).toBe(false);
  });

  it("marks no row after the edit is cancelled", () => {
    const view = viewAfter([h264, mine], (controller) => {
      controller.select("mine");
      controller.setName("Renamed");
      controller.cancelDraft();
    });
    expect(isUnsavedPresetRow(view, "mine")).toBe(false);
  });
});

describe("pickPromptOpenFocus", () => {
  it("gives the focus to Cancel", () => {
    const cancel = fakeTarget();
    const message = fakeTarget();
    expect(pickPromptOpenFocus(cancel, message)).toBe(cancel);
  });

  // A save in flight disables Cancel. The message keeps the focus inside the prompt.
  it("gives the focus to the message while Cancel is disabled", () => {
    const message = fakeTarget();
    expect(pickPromptOpenFocus(fakeTarget({ isDisabled: true }), message)).toBe(
      message,
    );
  });

  it("gives the focus to the message before Cancel is mounted", () => {
    const message = fakeTarget();
    expect(pickPromptOpenFocus(null, message)).toBe(message);
  });

  it("returns null when neither element can take the focus", () => {
    expect(
      pickPromptOpenFocus(
        fakeTarget({ isDisabled: true }),
        fakeTarget({ isRendered: false }),
      ),
    ).toBeNull();
    expect(pickPromptOpenFocus(null, null)).toBeNull();
  });
});

describe("pickPromptCancelFocus", () => {
  it("returns the element that held the focus when the prompt opened", () => {
    const field = fakeTarget();
    const close = fakeTarget();
    expect(pickPromptCancelFocus(field, close)).toBe(field);
  });

  // The prompt replaces the footer Close button, so a request from that button leaves a
  // detached element.
  it("falls back to the Close button when that element left the document", () => {
    const close = fakeTarget();
    expect(pickPromptCancelFocus(fakeTarget({ isConnected: false }), close)).toBe(
      close,
    );
  });

  // A request from the General tab switches to the preset tab. The panels stay mounted, so
  // the field is still connected, but its panel is `display: none`.
  it("falls back to the Close button when that element is in a hidden panel", () => {
    const close = fakeTarget();
    expect(pickPromptCancelFocus(fakeTarget({ isRendered: false }), close)).toBe(close);
  });

  it("falls back to the Close button when that element is disabled", () => {
    const close = fakeTarget();
    expect(pickPromptCancelFocus(fakeTarget({ isDisabled: true }), close)).toBe(close);
  });

  it("falls back to the Close button when no element held the focus", () => {
    const close = fakeTarget();
    expect(pickPromptCancelFocus(null, close)).toBe(close);
  });

  it("returns null when neither element can take the focus", () => {
    expect(pickPromptCancelFocus(fakeTarget({ isConnected: false }), null)).toBeNull();
    expect(pickPromptCancelFocus(null, fakeTarget({ isRendered: false }))).toBeNull();
    expect(pickPromptCancelFocus(null, null)).toBeNull();
  });

  // Keep Editing in the prompt of the preset library. An arrow key on a row raised the
  // prompt, so the row the user was on takes the focus back, and it is still the selected row.
  describe("for Keep Editing in the preset library", () => {
    it("returns the focus to the row that raised the prompt", () => {
      const oldRow = fakeTarget();
      const selectedRow = fakeTarget();
      expect(pickPromptCancelFocus(oldRow, selectedRow)).toBe(oldRow);
    });

    // A pointer press on a row does not move the focus, so the field the user was editing
    // takes it back.
    it("returns the focus to the field the user was editing", () => {
      const field = fakeTarget();
      expect(pickPromptCancelFocus(field, fakeTarget())).toBe(field);
    });

    it("falls back to the selected row when nothing held the focus", () => {
      const selectedRow = fakeTarget();
      expect(pickPromptCancelFocus(null, selectedRow)).toBe(selectedRow);
      expect(
        pickPromptCancelFocus(fakeTarget({ isConnected: false }), selectedRow),
      ).toBe(selectedRow);
    });
  });
});

describe("pickPromptReturnFocus", () => {
  const body = { id: "body" };

  it("records the element that holds the focus when a prompt opens", () => {
    const row = { id: "row" };
    expect(pickPromptReturnFocus(row, body)).toBe(row);
  });

  // The focus rests on the body when no control holds it, and the body is no place to return to.
  it("records nothing for the document body or for no element", () => {
    expect(pickPromptReturnFocus(body, body)).toBeNull();
    expect(pickPromptReturnFocus(null, body)).toBeNull();
  });
});

describe("presentSaveAndLeaveLabel", () => {
  it("says Save and Switch for a switch to another preset", () => {
    expect(presentSaveAndLeaveLabel({ kind: "select", id: "mine" })).toBe(
      "settings.preset.saveAndSwitch",
    );
  });

  it("says Save and Add for Add", () => {
    expect(presentSaveAndLeaveLabel({ kind: "add" })).toBe(
      "settings.preset.saveAndAdd",
    );
  });

  it.each([
    ["en", { kind: "select", id: "mine" }, "Save and Switch"],
    ["en", { kind: "add" }, "Save and Add"],
    ["zh-CN", { kind: "select", id: "mine" }, "保存并切换"],
    ["zh-CN", { kind: "add" }, "保存并添加"],
  ] as const)("labels the %s button for %o as %s", (language, request, expected) => {
    const catalog = language === "en" ? en : zhCN;
    expect(resolveCatalogKey(catalog, presentSaveAndLeaveLabel(request))).toBe(
      expected,
    );
  });
});

/** A fake of `document.activeElement`. */
function fakeHolder(tagName: string, role: string | null = null): FocusHolderProbe {
  return {
    tagName,
    getAttribute: (name) => (name === "role" ? role : null),
  };
}

describe("isFocusLost", () => {
  it("is true when no element or the document body holds the focus", () => {
    expect(isFocusLost(null)).toBe(true);
    expect(isFocusLost(fakeHolder("BODY"))).toBe(true);
  });

  // Radix moves the focus to the dialog when the focused prompt button leaves the document.
  it("is true when the dialog element itself holds the focus", () => {
    expect(isFocusLost(fakeHolder("DIV", "dialog"))).toBe(true);
  });

  it("is false when a control holds the focus", () => {
    expect(isFocusLost(fakeHolder("INPUT"))).toBe(false);
    expect(isFocusLost(fakeHolder("BUTTON"))).toBe(false);
    expect(isFocusLost(fakeHolder("DIV", "button"))).toBe(false);
  });
});

describe("pickCreateFailureFocus", () => {
  // The button was disabled during the write, and the browser moved the focus to the body.
  it("returns the button when the focus is lost", () => {
    const button = fakeTarget();
    expect(pickCreateFailureFocus(button, fakeHolder("BODY"))).toBe(button);
    expect(pickCreateFailureFocus(button, fakeHolder("DIV", "dialog"))).toBe(button);
    expect(pickCreateFailureFocus(button, null)).toBe(button);
  });

  // The user moved the focus during the write, such as into the name field.
  it("keeps the focus on a control", () => {
    expect(pickCreateFailureFocus(fakeTarget(), fakeHolder("INPUT"))).toBeNull();
  });

  it("returns null when the button cannot take the focus", () => {
    const body = fakeHolder("BODY");
    expect(pickCreateFailureFocus(fakeTarget({ isDisabled: true }), body)).toBeNull();
    expect(pickCreateFailureFocus(fakeTarget({ isConnected: false }), body)).toBeNull();
    expect(pickCreateFailureFocus(fakeTarget({ isRendered: false }), body)).toBeNull();
    expect(pickCreateFailureFocus(null, body)).toBeNull();
  });
});
