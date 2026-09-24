import { describe, expect, it } from "vitest";
import {
  decidePresetListKey,
  type PresetListKeyPress,
  type PresetListKeyState,
} from "./presetListKeyboard";

function press(
  key: string,
  overrides: Partial<PresetListKeyPress> = {},
): PresetListKeyPress {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

function state(
  focusedId: string,
  overrides: Partial<PresetListKeyState> = {},
): PresetListKeyState {
  return { presetIds: ["a", "b", "c"], focusedId, canDelete: true, ...overrides };
}

describe("decidePresetListKey", () => {
  describe("arrow keys", () => {
    it("moves down to the next row and up to the previous row", () => {
      expect(decidePresetListKey(press("ArrowDown"), state("a"))).toStrictEqual({
        kind: "select",
        id: "b",
      });
      expect(decidePresetListKey(press("ArrowUp"), state("c"))).toStrictEqual({
        kind: "select",
        id: "b",
      });
    });

    // The list does not wrap. The key is still consumed, so the pane does not scroll.
    it("consumes the key at either end of the list", () => {
      expect(decidePresetListKey(press("ArrowDown"), state("c"))).toStrictEqual({
        kind: "consume",
      });
      expect(decidePresetListKey(press("ArrowUp"), state("a"))).toStrictEqual({
        kind: "consume",
      });
    });

    it("moves once for each repeat of a held key", () => {
      expect(
        decidePresetListKey(press("ArrowDown", { repeat: true }), state("a")),
      ).toStrictEqual({ kind: "select", id: "b" });
    });

    it("moves from a focused row that is no longer in the list to an end of the list", () => {
      expect(decidePresetListKey(press("ArrowDown"), state("gone"))).toStrictEqual({
        kind: "select",
        id: "a",
      });
      expect(decidePresetListKey(press("ArrowUp"), state("gone"))).toStrictEqual({
        kind: "select",
        id: "c",
      });
    });

    it("consumes the key in a list with one row", () => {
      const single = state("a", { presetIds: ["a"] });
      expect(decidePresetListKey(press("ArrowDown"), single)).toStrictEqual({
        kind: "consume",
      });
      expect(decidePresetListKey(press("ArrowUp"), single)).toStrictEqual({
        kind: "consume",
      });
    });
  });

  describe("Home and End", () => {
    it("move to the first and the last row", () => {
      expect(decidePresetListKey(press("Home"), state("b"))).toStrictEqual({
        kind: "select",
        id: "a",
      });
      expect(decidePresetListKey(press("End"), state("b"))).toStrictEqual({
        kind: "select",
        id: "c",
      });
    });

    it("consume the key on the row they would select", () => {
      expect(decidePresetListKey(press("Home"), state("a"))).toStrictEqual({
        kind: "consume",
      });
      expect(decidePresetListKey(press("End"), state("c"))).toStrictEqual({
        kind: "consume",
      });
    });
  });

  describe("Enter and F2", () => {
    it.each(["Enter", "F2"])("%s moves the focus to the name field", (key) => {
      expect(decidePresetListKey(press(key), state("b"))).toStrictEqual({
        kind: "editName",
      });
    });

    it.each(["Enter", "F2"])("a repeat of %s does nothing", (key) => {
      expect(
        decidePresetListKey(press(key, { repeat: true }), state("b")),
      ).toStrictEqual({
        kind: "consume",
      });
    });
  });

  describe("Delete and Backspace", () => {
    // The Delete key of a Mac keyboard sends Backspace.
    it.each(["Delete", "Backspace"])(
      "%s starts the delete of the focused row",
      (key) => {
        expect(decidePresetListKey(press(key), state("b"))).toStrictEqual({
          kind: "delete",
          id: "b",
        });
      },
    );

    it.each(["Delete", "Backspace"])(
      "%s does nothing while a delete cannot start",
      (key) => {
        expect(
          decidePresetListKey(press(key), state("b", { canDelete: false })),
        ).toStrictEqual({ kind: "consume" });
      },
    );

    it("does nothing for a repeat, because the first press opened the confirmation", () => {
      expect(
        decidePresetListKey(press("Delete", { repeat: true }), state("b")),
      ).toStrictEqual({ kind: "consume" });
    });

    it("does nothing for a focused row that is no longer in the list", () => {
      expect(decidePresetListKey(press("Delete"), state("gone"))).toStrictEqual({
        kind: "consume",
      });
    });
  });

  it("consumes Space, because the selection already follows the focus", () => {
    expect(decidePresetListKey(press(" "), state("b"))).toStrictEqual({
      kind: "consume",
    });
  });

  it.each(["Tab", "Escape", "a", "ArrowLeft", "ArrowRight", "PageDown"])(
    "ignores %s",
    (key) => {
      expect(decidePresetListKey(press(key), state("b"))).toStrictEqual({
        kind: "ignore",
      });
    },
  );

  // The system and the web view keep every combination with a modifier.
  it.each([["altKey"], ["ctrlKey"], ["metaKey"], ["shiftKey"]] as const)(
    "ignores every list key with %s held",
    (modifier) => {
      for (const key of [
        "ArrowDown",
        "Home",
        "Enter",
        "F2",
        "Delete",
        "Backspace",
        " ",
      ]) {
        expect(
          decidePresetListKey(press(key, { [modifier]: true }), state("b")),
        ).toStrictEqual({ kind: "ignore" });
      }
    },
  );

  it("ignores a key that an input method took", () => {
    expect(
      decidePresetListKey(press("ArrowDown", { isComposing: true }), state("a")),
    ).toStrictEqual({ kind: "ignore" });
    // The first key of a composition can report `isComposing` as false.
    expect(
      decidePresetListKey(press("Process", { keyCode: 229 }), state("a")),
    ).toStrictEqual({ kind: "ignore" });
    expect(
      decidePresetListKey(press("Enter", { keyCode: 229 }), state("a")),
    ).toStrictEqual({ kind: "ignore" });
  });
});
