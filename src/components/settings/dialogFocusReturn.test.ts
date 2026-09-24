import { describe, expect, it } from "vitest";
import { createDialogFocusReturn, type FocusReturnTarget } from "./dialogFocusReturn";

function fakeTarget(isConnected = true): FocusReturnTarget {
  return { isConnected, focus: () => {} };
}

describe("dialog focus return", () => {
  it("returns the opener after a keyboard close", () => {
    const rule = createDialogFocusReturn();
    const gear = fakeTarget();

    rule.noteOpened(gear);
    rule.noteInteraction("keyboard");

    expect(rule.takeCloseTarget()).toBe(gear);
  });

  it("returns nothing after a pointer close", () => {
    const rule = createDialogFocusReturn();

    rule.noteOpened(fakeTarget());
    rule.noteInteraction("pointer");

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("uses the latest interaction only", () => {
    const pointerLast = createDialogFocusReturn();
    const gear = fakeTarget();
    pointerLast.noteOpened(gear);
    pointerLast.noteInteraction("keyboard");
    pointerLast.noteInteraction("pointer");
    expect(pointerLast.takeCloseTarget()).toBeNull();

    // A pointer user who closes with Escape is a keyboard close.
    const keyboardLast = createDialogFocusReturn();
    keyboardLast.noteOpened(gear);
    keyboardLast.noteInteraction("pointer");
    keyboardLast.noteInteraction("keyboard");
    expect(keyboardLast.takeCloseTarget()).toBe(gear);
  });

  it("returns the opener for a close that no interaction caused", () => {
    const rule = createDialogFocusReturn();
    const gear = fakeTarget();

    rule.noteOpened(gear);

    expect(rule.takeCloseTarget()).toBe(gear);
  });

  it("returns the named return target in place of the opener", () => {
    const rule = createDialogFocusReturn();
    const openSettingsButton = fakeTarget(false);
    const exportButton = fakeTarget();

    rule.noteOpened(openSettingsButton, exportButton);
    rule.noteInteraction("keyboard");

    expect(rule.takeCloseTarget()).toBe(exportButton);
  });

  it("returns the opener when the caller names no return target", () => {
    const withNull = createDialogFocusReturn();
    const gear = fakeTarget();
    withNull.noteOpened(gear, null);
    expect(withNull.takeCloseTarget()).toBe(gear);

    const withUndefined = createDialogFocusReturn();
    withUndefined.noteOpened(gear, undefined);
    expect(withUndefined.takeCloseTarget()).toBe(gear);
  });

  it("returns nothing when the named return target left the document", () => {
    const rule = createDialogFocusReturn();

    rule.noteOpened(fakeTarget(), fakeTarget(false));
    rule.noteInteraction("keyboard");

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("applies the pointer rule to a named return target", () => {
    const rule = createDialogFocusReturn();

    rule.noteOpened(fakeTarget(), fakeTarget());
    rule.noteInteraction("pointer");

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("returns nothing when no element held the focus at open", () => {
    const rule = createDialogFocusReturn();

    rule.noteOpened(null);
    rule.noteInteraction("keyboard");

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("returns nothing when the opener left the document", () => {
    const rule = createDialogFocusReturn();

    rule.noteOpened(fakeTarget(false));
    rule.noteInteraction("keyboard");

    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("forgets the opener after one close", () => {
    const rule = createDialogFocusReturn();
    const gear = fakeTarget();

    rule.noteOpened(gear);
    expect(rule.takeCloseTarget()).toBe(gear);
    expect(rule.takeCloseTarget()).toBeNull();
  });

  it("resets the interaction on each open", () => {
    const rule = createDialogFocusReturn();
    const first = fakeTarget();
    const second = fakeTarget();

    rule.noteOpened(first);
    rule.noteInteraction("pointer");
    expect(rule.takeCloseTarget()).toBeNull();

    rule.noteOpened(second);
    expect(rule.takeCloseTarget()).toBe(second);
  });
});
