import { describe, expect, it } from "vitest";
import {
  EDITABLE_TAG_NAMES,
  KEYBOARD_OWNER_SELECTOR,
  MODAL_LAYER_SELECTOR,
  isShortcutSuppressed,
  resolveShortcut,
  type ShortcutCapabilities,
  type ShortcutEventTarget,
  type ShortcutKeyEvent,
} from "./keyboardShortcutController";

function createTarget(
  overrides: Partial<ShortcutEventTarget> = {},
): ShortcutEventTarget {
  return {
    tagName: "BODY",
    isContentEditable: false,
    hasAncestorMatching: () => false,
    ...overrides,
  };
}

function createKeyEvent(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: " ",
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: createTarget(),
    isOverlayOpen: false,
    ...overrides,
  };
}

describe("keyboardShortcutController", () => {
  const fullCapabilities: ShortcutCapabilities = {
    hasActiveSource: true,
    hasNominalRate: true,
  };

  describe("resolveShortcut mappings and capability gating", () => {
    // 1. Space with a body target and an active source -> togglePlayback
    it("resolves Space with a body target and an active source to togglePlayback", () => {
      const event = createKeyEvent({ key: " " });
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    // 2. ArrowLeft with both capabilities -> stepBackOneFrame
    it("resolves ArrowLeft with both capabilities to stepBackOneFrame", () => {
      const event = createKeyEvent({ key: "ArrowLeft" });
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });
    });

    // 3. ArrowRight with both capabilities -> stepForwardOneFrame
    it("resolves ArrowRight with both capabilities to stepForwardOneFrame", () => {
      const event = createKeyEvent({ key: "ArrowRight" });
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 4. target: null resolves the same as a body target (nothing focused is the main case)
    it("resolves target: null the same as a body target", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " ", target: null }), fullCapabilities),
      ).toEqual({
        claimed: true,
        action: "togglePlayback",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", target: null }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", target: null }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 5. A role="slider" target resolves to a step action
    it("resolves a role='slider' target to a step action", () => {
      // In the DOM, a slider element has role="slider" and is not inside any menu/dialog.
      // closest(KEYBOARD_OWNER_SELECTOR) returns null because KEYBOARD_OWNER_SELECTOR
      // does not include role="slider".
      const sliderTarget: ShortcutEventTarget = {
        tagName: "DIV",
        isContentEditable: false,
        hasAncestorMatching: (selector) => {
          return selector.split(",").some((part) => part.trim() === '[role="slider"]');
        },
      };

      expect(sliderTarget.hasAncestorMatching(KEYBOARD_OWNER_SELECTOR)).toBe(false);

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", target: sliderTarget }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", target: sliderTarget }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 6. Unmapped keys -> {claimed: false, action: null}
    it("returns {claimed: false, action: null} for unmapped keys", () => {
      const unmappedKeys = [
        "a",
        "Enter",
        "Escape",
        "Home",
        "ArrowUp",
        "ArrowDown",
        "Tab",
      ];
      for (const key of unmappedKeys) {
        expect(resolveShortcut(createKeyEvent({ key }), fullCapabilities)).toEqual({
          claimed: false,
          action: null,
        });
      }

      // Assert Enter and Escape by name: Enter keeps buttons reachable, Escape belongs to Radix
      expect(
        resolveShortcut(createKeyEvent({ key: "Enter" }), fullCapabilities),
      ).toEqual({
        claimed: false,
        action: null,
      });

      expect(
        resolveShortcut(createKeyEvent({ key: "Escape" }), fullCapabilities),
      ).toEqual({
        claimed: false,
        action: null,
      });
    });

    // 7. Space with hasActiveSource: false -> {claimed: true, action: null}
    it("claims Space without an action when hasActiveSource is false", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " " }), {
          hasActiveSource: false,
          hasNominalRate: true,
        }),
      ).toEqual({
        claimed: true,
        action: null,
      });
    });

    // 8. ArrowRight with hasActiveSource: true, hasNominalRate: false -> {claimed: true, action: null}
    it("claims ArrowRight without an action when hasNominalRate is false", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: "ArrowRight" }), {
          hasActiveSource: true,
          hasNominalRate: false,
        }),
      ).toEqual({
        claimed: true,
        action: null,
      });
    });

    // 9. ArrowLeft with hasActiveSource: false -> {claimed: true, action: null}
    it("claims ArrowLeft without an action when hasActiveSource is false", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: "ArrowLeft" }), {
          hasActiveSource: false,
          hasNominalRate: true,
        }),
      ).toEqual({
        claimed: true,
        action: null,
      });
    });

    // 10. Space does NOT require hasNominalRate
    it("allows Space to toggle playback even when hasNominalRate is false", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " " }), {
          hasActiveSource: true,
          hasNominalRate: false,
        }),
      ).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    // 11. repeat: true on both arrows -> the step action, unchanged
    it("passes through repeat: true on both arrows to support continuous stepping", () => {
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", repeat: true }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", repeat: true }),
          fullCapabilities,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 12. repeat: true on Space -> {claimed: true, action: null}
    it("claims a repeated Space with a null action to prevent rapid toggling and scrolling", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " ", repeat: true }), fullCapabilities),
      ).toEqual({
        claimed: true,
        action: null,
      });
    });
  });

  // 13. One test per suppression clause, each asserting {claimed: false, action: null}
  describe("suppression clauses", () => {
    it("suppresses when ctrlKey is true on both Space and ArrowRight", () => {
      const spaceEvent = createKeyEvent({ key: " ", ctrlKey: true });
      expect(isShortcutSuppressed(spaceEvent)).toBe(true);
      expect(resolveShortcut(spaceEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });

      const arrowEvent = createKeyEvent({ key: "ArrowRight", ctrlKey: true });
      expect(isShortcutSuppressed(arrowEvent)).toBe(true);
      expect(resolveShortcut(arrowEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when metaKey is true on both Space and ArrowRight", () => {
      const spaceEvent = createKeyEvent({ key: " ", metaKey: true });
      expect(isShortcutSuppressed(spaceEvent)).toBe(true);
      expect(resolveShortcut(spaceEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });

      const arrowEvent = createKeyEvent({ key: "ArrowRight", metaKey: true });
      expect(isShortcutSuppressed(arrowEvent)).toBe(true);
      expect(resolveShortcut(arrowEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when altKey is true on both Space and ArrowRight", () => {
      const spaceEvent = createKeyEvent({ key: " ", altKey: true });
      expect(isShortcutSuppressed(spaceEvent)).toBe(true);
      expect(resolveShortcut(spaceEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });

      const arrowEvent = createKeyEvent({ key: "ArrowRight", altKey: true });
      expect(isShortcutSuppressed(arrowEvent)).toBe(true);
      expect(resolveShortcut(arrowEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when shiftKey is true on both Space and ArrowRight (reserved for multi-frame)", () => {
      const spaceEvent = createKeyEvent({ key: " ", shiftKey: true });
      expect(isShortcutSuppressed(spaceEvent)).toBe(true);
      expect(resolveShortcut(spaceEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });

      const arrowEvent = createKeyEvent({ key: "ArrowRight", shiftKey: true });
      expect(isShortcutSuppressed(arrowEvent)).toBe(true);
      expect(resolveShortcut(arrowEvent, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when isComposing is true", () => {
      const event = createKeyEvent({ key: " ", isComposing: true });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when keyCode is 229 with isComposing: false", () => {
      const event = createKeyEvent({
        key: " ",
        isComposing: false,
        keyCode: 229,
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("does not throw and does not suppress when keyCode is absent entirely", () => {
      const event: ShortcutKeyEvent = {
        key: " ",
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        target: createTarget(),
        isOverlayOpen: false,
      };
      expect("keyCode" in event).toBe(false);
      expect(isShortcutSuppressed(event)).toBe(false);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    it("suppresses when defaultPrevented is true", () => {
      const event = createKeyEvent({ key: " ", defaultPrevented: true });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target is an INPUT tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "INPUT" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target is a TEXTAREA tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "TEXTAREA" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target is a SELECT tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "SELECT" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target has isContentEditable: true on a DIV", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "DIV", isContentEditable: true }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target hasAncestorMatching matches [role='dialog']", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({
          tagName: "BUTTON",
          hasAncestorMatching: (sel) => sel.includes('[role="dialog"]'),
        }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target hasAncestorMatching matches [role='menu']", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({
          tagName: "DIV",
          hasAncestorMatching: (sel) => sel.includes('[role="menu"]'),
        }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target hasAncestorMatching matches [role='listbox']", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({
          tagName: "DIV",
          hasAncestorMatching: (sel) => sel.includes('[role="listbox"]'),
        }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("suppresses when target hasAncestorMatching matches [contenteditable='true']", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({
          tagName: "SPAN",
          hasAncestorMatching: (sel) => sel.includes('[contenteditable="true"]'),
        }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });

    it("claims Space and returns togglePlayback on a closed popup trigger because a closed trigger does not own the keyboard", () => {
      const popupTriggerTarget: ShortcutEventTarget = {
        tagName: "BUTTON",
        isContentEditable: false,
        hasAncestorMatching: (selector) =>
          selector.split(",").some((part) => part.trim() === '[aria-haspopup="menu"]'),
      };
      expect(popupTriggerTarget.hasAncestorMatching(KEYBOARD_OWNER_SELECTOR)).toBe(
        false,
      );

      const event = createKeyEvent({
        key: " ",
        target: popupTriggerTarget,
      });
      expect(isShortcutSuppressed(event)).toBe(false);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    it("claims ArrowRight and returns stepForwardOneFrame on a closed popup trigger", () => {
      const popupTriggerTarget: ShortcutEventTarget = {
        tagName: "BUTTON",
        isContentEditable: false,
        hasAncestorMatching: (selector) =>
          selector.split(",").some((part) => part.trim() === '[aria-haspopup="menu"]'),
      };
      expect(popupTriggerTarget.hasAncestorMatching(KEYBOARD_OWNER_SELECTOR)).toBe(
        false,
      );

      const event = createKeyEvent({
        key: "ArrowRight",
        target: popupTriggerTarget,
      });
      expect(isShortcutSuppressed(event)).toBe(false);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    it("suppresses when isOverlayOpen is true even with a plain body target", () => {
      const event = createKeyEvent({
        key: " ",
        isOverlayOpen: true,
        target: createTarget({
          tagName: "BODY",
          hasAncestorMatching: () => false,
        }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, fullCapabilities)).toEqual({
        claimed: false,
        action: null,
      });
    });
  });

  // 14. EDITABLE_TAG_NAMES is exactly ["INPUT", "TEXTAREA", "SELECT"] and every entry is uppercase
  describe("constants integrity", () => {
    it("defines EDITABLE_TAG_NAMES exactly as uppercase INPUT, TEXTAREA, SELECT", () => {
      expect(EDITABLE_TAG_NAMES).toEqual(["INPUT", "TEXTAREA", "SELECT"]);
      for (const tag of EDITABLE_TAG_NAMES) {
        expect(tag).toBe(tag.toUpperCase());
      }
    });

    // 15. KEYBOARD_OWNER_SELECTOR contains each of dialog, alertdialog, menu, listbox, combobox, option, contenteditable
    it("contains all required keyboard owner tokens in KEYBOARD_OWNER_SELECTOR", () => {
      const requiredTokens = [
        "dialog",
        "alertdialog",
        "menu",
        "menubar",
        "menuitem",
        "listbox",
        "combobox",
        "option",
        "contenteditable",
      ];
      for (const token of requiredTokens) {
        expect(KEYBOARD_OWNER_SELECTOR).toContain(token);
      }
      expect(KEYBOARD_OWNER_SELECTOR).not.toContain("aria-haspopup");
    });

    it("names dialog, alertdialog, menu, and listbox in MODAL_LAYER_SELECTOR with data-state guard", () => {
      const requiredRoles = [
        'role="dialog"',
        'role="alertdialog"',
        'role="menu"',
        'role="listbox"',
      ];
      for (const role of requiredRoles) {
        expect(MODAL_LAYER_SELECTOR).toContain(role);
      }
      expect(MODAL_LAYER_SELECTOR).toContain(':not([data-state="closed"])');
    });
  });
});
