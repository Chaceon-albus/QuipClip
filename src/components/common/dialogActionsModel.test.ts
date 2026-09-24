import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDialogPlatform,
  orderDialogActions,
  type DialogActionRole,
  type DialogPlatform,
} from "./dialogActionsModel";

interface TestAction {
  role: DialogActionRole;
  id: string;
}

const action = (role: DialogActionRole, id: string = role): TestAction => ({
  role,
  id,
});

function order(platform: DialogPlatform, actions: readonly TestAction[]): string[] {
  return orderDialogActions(platform, actions).map((placement) => placement.action.id);
}

function apartIds(platform: DialogPlatform, actions: readonly TestAction[]): string[] {
  return orderDialogActions(platform, actions)
    .filter((placement) => placement.apart)
    .map((placement) => placement.action.id);
}

describe("orderDialogActions", () => {
  describe("a confirmation: Cancel and the primary action", () => {
    const actions = [action("primary", "delete"), action("cancel")];

    it("puts the primary action rightmost on macOS, with Cancel at its left", () => {
      expect(order("macos", actions)).toEqual(["cancel", "delete"]);
    });

    it("puts the primary action first on Windows, with Cancel at its right", () => {
      expect(order("windows", actions)).toEqual(["delete", "cancel"]);
    });

    it("does not depend on the order in which the caller gives the actions", () => {
      const reversed = [...actions].reverse();

      expect(order("macos", reversed)).toEqual(["cancel", "delete"]);
      expect(order("windows", reversed)).toEqual(["delete", "cancel"]);
    });

    it("sets no action apart", () => {
      expect(apartIds("macos", actions)).toEqual([]);
      expect(apartIds("windows", actions)).toEqual([]);
    });
  });

  describe("an unsaved-changes prompt: Don't Save, Cancel, and Save", () => {
    const actions = [
      action("primary", "save"),
      action("cancel"),
      action("discard", "dontSave"),
    ];

    it("puts Don't Save apart at the far left on macOS, then Cancel and Save", () => {
      expect(order("macos", actions)).toEqual(["dontSave", "cancel", "save"]);
      expect(apartIds("macos", actions)).toEqual(["dontSave"]);
    });

    it("puts Don't Save directly after Save on Windows, and Cancel last", () => {
      expect(order("windows", actions)).toEqual(["save", "dontSave", "cancel"]);
      expect(apartIds("windows", actions)).toEqual([]);
    });
  });

  describe("an alternative action", () => {
    const actions = [
      action("cancel"),
      action("alternative", "reimport"),
      action("primary", "exportAnyway"),
    ];

    it("goes at the left of Cancel on macOS", () => {
      expect(order("macos", actions)).toEqual(["reimport", "cancel", "exportAnyway"]);
    });

    it("goes between the primary action and Cancel on Windows", () => {
      expect(order("windows", actions)).toEqual(["exportAnyway", "reimport", "cancel"]);
    });

    it("is never set apart", () => {
      expect(apartIds("macos", actions)).toEqual([]);
    });
  });

  it("keeps the order of the caller among actions of one role", () => {
    const actions = [
      action("primary", "save"),
      action("alternative", "first"),
      action("alternative", "second"),
    ];

    expect(order("macos", actions)).toEqual(["first", "second", "save"]);
    expect(order("windows", actions)).toEqual(["save", "first", "second"]);
  });

  // The finished export: Show and Open, and Done, which closes the dialog and is its
  // default button. Done is last on both platforms, as the Close button of a WinUI dialog.
  it("orders a footer with alternatives and Cancel and no primary action", () => {
    const actions = [
      action("alternative", "reveal"),
      action("alternative", "open"),
      action("cancel", "done"),
    ];

    expect(order("macos", actions)).toEqual(["reveal", "open", "done"]);
    expect(order("windows", actions)).toEqual(["reveal", "open", "done"]);
    expect(apartIds("macos", actions)).toEqual([]);
    expect(apartIds("windows", actions)).toEqual([]);
  });

  it("puts a discard after the primary action and before the alternatives on Windows", () => {
    const actions = [
      action("alternative", "other"),
      action("cancel"),
      action("discard", "discard"),
      action("primary", "save"),
    ];

    expect(order("windows", actions)).toEqual(["save", "discard", "other", "cancel"]);
    expect(order("macos", actions)).toEqual(["discard", "other", "cancel", "save"]);
  });

  it("orders a footer with no Cancel: a discard and the primary action", () => {
    const actions = [action("discard", "stop"), action("primary", "runInBackground")];

    expect(order("macos", actions)).toEqual(["stop", "runInBackground"]);
    expect(apartIds("macos", actions)).toEqual(["stop"]);
    expect(order("windows", actions)).toEqual(["runInBackground", "stop"]);
    expect(apartIds("windows", actions)).toEqual([]);
  });

  it("orders a footer with Cancel alone", () => {
    expect(order("macos", [action("cancel", "close")])).toEqual(["close"]);
    expect(order("windows", [action("cancel", "close")])).toEqual(["close"]);
  });

  it("returns an empty order for no action", () => {
    expect(orderDialogActions("macos", [])).toEqual([]);
  });

  it("puts every action that stands apart before the others", () => {
    const placements = orderDialogActions("macos", [
      action("primary"),
      action("discard", "first"),
      action("cancel"),
      action("discard", "second"),
    ]);
    const firstGrouped = placements.findIndex((placement) => !placement.apart);

    expect(
      placements.slice(0, firstGrouped).every((placement) => placement.apart),
    ).toBe(true);
    expect(placements.slice(firstGrouped).some((placement) => placement.apart)).toBe(
      false,
    );
    expect(placements.map((placement) => placement.action.id)).toEqual([
      "first",
      "second",
      "cancel",
      "primary",
    ]);
  });

  it("does not change the list of the caller", () => {
    const actions = [action("primary"), action("cancel")];

    orderDialogActions("macos", actions);

    expect(actions.map((entry) => entry.id)).toEqual(["primary", "cancel"]);
  });
});

describe("getDialogPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers macOS for a macOS user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    });

    expect(getDialogPlatform()).toBe("macos");
  });

  it("answers Windows for a Windows user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    });

    expect(getDialogPlatform()).toBe("windows");
  });

  it("answers Windows for every other platform, as the title bar does", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });

    expect(getDialogPlatform()).toBe("windows");
  });
});
