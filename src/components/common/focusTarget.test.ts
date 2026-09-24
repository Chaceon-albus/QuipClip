import { describe, expect, it } from "vitest";

import {
  canTakeFocus,
  isElementRendered,
  isInOpenDialog,
  OPEN_DIALOG_SELECTOR,
  toPromptFocusTarget,
  type PromptFocusTarget,
} from "./focusTarget";

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

describe("isElementRendered", () => {
  it("uses checkVisibility where the web view has it", () => {
    expect(isElementRendered({ checkVisibility: () => true, offsetParent: null })).toBe(
      true,
    );
    expect(isElementRendered({ checkVisibility: () => false, offsetParent: {} })).toBe(
      false,
    );
  });

  it("falls back to offsetParent without checkVisibility", () => {
    expect(isElementRendered({ offsetParent: {} })).toBe(true);
    // An element inside a `display: none` subtree has no offset parent.
    expect(isElementRendered({ offsetParent: null })).toBe(false);
  });
});

describe("canTakeFocus", () => {
  it("accepts a target in the document, rendered, and enabled", () => {
    expect(canTakeFocus(fakeTarget())).toBe(true);
  });

  it("refuses no target, a detached one, a hidden one, and a disabled one", () => {
    expect(canTakeFocus(null)).toBe(false);
    expect(canTakeFocus(fakeTarget({ isConnected: false }))).toBe(false);
    expect(canTakeFocus(fakeTarget({ isRendered: false }))).toBe(false);
    expect(canTakeFocus(fakeTarget({ isDisabled: true }))).toBe(false);
  });
});

describe("toPromptFocusTarget", () => {
  it("returns null for no element", () => {
    expect(toPromptFocusTarget(null)).toBeNull();
  });

  // The rules read the element when the focus moves, so a button that is enabled after it was
  // wrapped can take the focus.
  it("reads the element each time a member is read, and focuses it", () => {
    let disabled = true;
    let focused = 0;
    const element = {
      isConnected: true,
      offsetParent: {},
      matches: (selector: string) => selector === ":disabled" && disabled,
      focus: () => {
        focused++;
      },
    };
    const target = toPromptFocusTarget(element as unknown as HTMLElement);

    expect(target?.isConnected).toBe(true);
    expect(target?.isRendered).toBe(true);
    expect(target?.isDisabled).toBe(true);
    disabled = false;
    expect(target?.isDisabled).toBe(false);
    target?.focus();
    expect(focused).toBe(1);
  });
});

describe("isInOpenDialog", () => {
  /** An element whose nearest dialog ancestor is `dialog`, or that has none. */
  function inside(dialog: object | null) {
    const selectors: string[] = [];
    return {
      selectors,
      closest: (selector: string) => {
        selectors.push(selector);
        return dialog;
      },
    };
  }

  it("answers true inside an open dialog, and asks with the open-dialog selector", () => {
    const element = inside({});
    expect(isInOpenDialog(element)).toBe(true);
    expect(element.selectors).toEqual([OPEN_DIALOG_SELECTOR]);
  });

  it("answers false outside every open dialog, and for no element", () => {
    expect(isInOpenDialog(inside(null))).toBe(false);
    expect(isInOpenDialog(null)).toBe(false);
  });

  // Radix keeps a closing dialog mounted during its exit animation, with that state.
  it("names both roles and leaves out a dialog in its exit animation", () => {
    expect(OPEN_DIALOG_SELECTOR).toBe(
      '[role="dialog"]:not([data-state="closed"]),' +
        '[role="alertdialog"]:not([data-state="closed"])',
    );
  });
});
