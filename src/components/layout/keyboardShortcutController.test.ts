import { describe, expect, it, vi } from "vitest";
import {
  EDITABLE_TAG_NAMES,
  KEYBOARD_OWNER_SELECTOR,
  MODAL_LAYER_SELECTOR,
  OPEN_TOOLTIP_SELECTOR,
  ESCAPE_OWNER_SELECTOR,
  SPLITTER_KEYS,
  SPLITTER_SELECTOR,
  isGestureEscape,
  isShortcutSuppressed,
  isSplitterKey,
  resolveShortcut,
  type ShortcutContext,
  type ShortcutEventTarget,
  type ShortcutKeyEvent,
} from "./keyboardShortcutController";
import {
  SHORTCUT_BINDINGS,
  bindingAppliesToPlatform,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutPlatform,
} from "./shortcutBindings";
import { RESIZING_TIMELINE_ATTRIBUTE } from "./timelineResizeCursor";

const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows"];

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

/** The `event.code` of a plain US-layout press of a named key. */
function codeOfNamedKey(key: string): string {
  return key === " " ? "Space" : key;
}

function createKeyEvent(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  const key = overrides.key ?? " ";
  return {
    key,
    code: codeOfNamedKey(key),
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: createTarget(),
    isOverlayOpen: false,
    isTooltipOpen: false,
    ...overrides,
  };
}

/** Builds the plain US-layout key press that a binding names on a platform. */
function eventForBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
  overrides: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  const primary = binding.modifiers.includes("primary");
  const shift = binding.modifiers.includes("shift");
  let key: string;
  let code: string;
  switch (binding.key.kind) {
    case "named":
      key = binding.key.key;
      code = codeOfNamedKey(binding.key.key);
      break;
    case "letter":
      key = shift ? binding.key.letter : binding.key.letter.toLowerCase();
      code = `Key${binding.key.letter}`;
      break;
    case "character":
      key = binding.key.character;
      // A row with no position matches the typed symbol, so any code names it.
      code = binding.key.code ?? "Unidentified";
      break;
    case "numpad":
      key = binding.key.character;
      code = binding.key.code;
      break;
  }
  return createKeyEvent({
    key,
    code,
    shiftKey: shift,
    metaKey: primary && platform === "macos",
    ctrlKey: primary && platform === "windows",
    ...overrides,
  });
}

function contextWith(
  available: readonly ShortcutAction[] | "all",
  platform: ShortcutPlatform = "windows",
): ShortcutContext {
  return {
    platform,
    isActionAvailable: (action) => available === "all" || available.includes(action),
  };
}

const NOT_CLAIMED = { claimed: false, action: null };
const CLAIMED_WITHOUT_ACTION = { claimed: true, action: null };

/** A plain press of each new key of ADR 026, for the suppression tests. */
function newKeyEvents(
  platform: ShortcutPlatform,
  overrides: Partial<ShortcutKeyEvent>,
): ShortcutKeyEvent[] {
  const primary: Partial<ShortcutKeyEvent> =
    platform === "macos" ? { metaKey: true } : { ctrlKey: true };
  return [
    createKeyEvent({ key: "i", code: "KeyI", ...overrides }),
    createKeyEvent({ key: "o", code: "KeyO", ...overrides }),
    createKeyEvent({ key: "I", code: "KeyI", shiftKey: true, ...overrides }),
    createKeyEvent({ key: "Home", ...overrides }),
    createKeyEvent({ key: "End", ...overrides }),
    createKeyEvent({ key: "Delete", ...overrides }),
    createKeyEvent({ key: "Backspace", ...overrides }),
    createKeyEvent({ key: "Escape", ...overrides }),
    createKeyEvent({ key: "ArrowRight", shiftKey: true, ...overrides }),
    createKeyEvent({ key: "z", code: "KeyZ", ...primary, ...overrides }),
    createKeyEvent({
      key: "Z",
      code: "KeyZ",
      shiftKey: true,
      ...primary,
      ...overrides,
    }),
    createKeyEvent({ key: "o", code: "KeyO", ...primary, ...overrides }),
    createKeyEvent({ key: "e", code: "KeyE", ...primary, ...overrides }),
    createKeyEvent({ key: ",", code: "Comma", ...primary, ...overrides }),
    // The zoom keys type characters, so a text field must keep every one of them.
    createKeyEvent({ key: "=", code: "Equal", ...overrides }),
    createKeyEvent({ key: "-", code: "Minus", ...overrides }),
    createKeyEvent({ key: "+", code: "NumpadAdd", ...overrides }),
    createKeyEvent({ key: "-", code: "NumpadSubtract", ...overrides }),
    createKeyEvent({ key: "\\", code: "Backslash", ...overrides }),
    // The layout variants and Shift+Z type characters too: +, = and a capital Z.
    createKeyEvent({ key: "+", code: "Equal", shiftKey: true, ...overrides }),
    createKeyEvent({ key: "=", code: "Minus", shiftKey: true, ...overrides }),
    createKeyEvent({ key: "+", code: "BracketRight", ...overrides }),
    createKeyEvent({ key: "Z", code: "KeyZ", shiftKey: true, ...overrides }),
  ];
}

describe("keyboardShortcutController", () => {
  const allAvailable = contextWith("all");

  describe("resolveShortcut mappings and capability gating", () => {
    // 1. Space with a body target and an active source -> togglePlayback
    it("resolves Space with a body target and an active source to togglePlayback", () => {
      const event = createKeyEvent({ key: " " });
      expect(resolveShortcut(event, allAvailable)).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    // 2. ArrowLeft with both capabilities -> stepBackOneFrame
    it("resolves ArrowLeft with both capabilities to stepBackOneFrame", () => {
      const event = createKeyEvent({ key: "ArrowLeft" });
      expect(resolveShortcut(event, allAvailable)).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });
    });

    // 3. ArrowRight with both capabilities -> stepForwardOneFrame
    it("resolves ArrowRight with both capabilities to stepForwardOneFrame", () => {
      const event = createKeyEvent({ key: "ArrowRight" });
      expect(resolveShortcut(event, allAvailable)).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 4. target: null resolves the same as a body target (nothing focused is the main case)
    it("resolves target: null the same as a body target", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " ", target: null }), allAvailable),
      ).toEqual({
        claimed: true,
        action: "togglePlayback",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", target: null }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", target: null }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "i", code: "KeyI", target: null }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "markIn",
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
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", target: sliderTarget }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });

      // The slider pattern goes to the minimum and the maximum on Home and End, and the
      // window layer does that everywhere.
      expect(
        resolveShortcut(
          createKeyEvent({ key: "Home", target: sliderTarget }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "goToStart",
      });
    });

    // 6. Unmapped keys -> {claimed: false, action: null}
    it("returns {claimed: false, action: null} for unmapped keys", () => {
      const unmappedKeys = [
        "a",
        "Enter",
        "ArrowUp",
        "ArrowDown",
        "Tab",
        "PageUp",
        "F5",
      ];
      for (const key of unmappedKeys) {
        expect(resolveShortcut(createKeyEvent({ key }), allAvailable)).toEqual(
          NOT_CLAIMED,
        );
      }

      // Assert Enter by name: Enter keeps every button reachable.
      expect(resolveShortcut(createKeyEvent({ key: "Enter" }), allAvailable)).toEqual(
        NOT_CLAIMED,
      );
    });

    // Changed by ADR 026: ADR 021 did not claim Escape or Home.
    it("claims Escape and Home, which ADR 026 adds to the table", () => {
      expect(resolveShortcut(createKeyEvent({ key: "Escape" }), allAvailable)).toEqual({
        claimed: true,
        action: "finishSegment",
      });
      expect(resolveShortcut(createKeyEvent({ key: "Home" }), allAvailable)).toEqual({
        claimed: true,
        action: "goToStart",
      });
    });

    // 7. Space whose action is unavailable -> {claimed: true, action: null}
    it("claims Space without an action when togglePlayback is unavailable", () => {
      expect(resolveShortcut(createKeyEvent({ key: " " }), contextWith([]))).toEqual(
        CLAIMED_WITHOUT_ACTION,
      );
    });

    // 8. ArrowRight whose action is unavailable -> {claimed: true, action: null}
    it("claims ArrowRight without an action when the step is unavailable", () => {
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight" }),
          contextWith(["togglePlayback"]),
        ),
      ).toEqual(CLAIMED_WITHOUT_ACTION);
    });

    // 9. ArrowLeft whose action is unavailable -> {claimed: true, action: null}
    it("claims ArrowLeft without an action when the step is unavailable", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: "ArrowLeft" }), contextWith([])),
      ).toEqual(CLAIMED_WITHOUT_ACTION);
    });

    // 10. Each key asks for its own action only: Space does not need the step condition.
    it("asks the availability of the matched action only", () => {
      const isActionAvailable = vi.fn(
        (action: ShortcutAction) => action === "togglePlayback",
      );
      expect(
        resolveShortcut(createKeyEvent({ key: " " }), {
          platform: "windows",
          isActionAvailable,
        }),
      ).toEqual({ claimed: true, action: "togglePlayback" });
      expect(isActionAvailable).toHaveBeenCalledTimes(1);
      expect(isActionAvailable).toHaveBeenCalledWith("togglePlayback");
    });

    // 11. repeat: true on both arrows -> the step action, unchanged
    it("passes through repeat: true on both arrows to support continuous stepping", () => {
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", repeat: true }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepBackOneFrame",
      });

      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", repeat: true }),
          allAvailable,
        ),
      ).toEqual({
        claimed: true,
        action: "stepForwardOneFrame",
      });
    });

    // 12. repeat: true on Space -> {claimed: true, action: null}
    it("claims a repeated Space with a null action to prevent rapid toggling and scrolling", () => {
      expect(
        resolveShortcut(createKeyEvent({ key: " ", repeat: true }), allAvailable),
      ).toEqual(CLAIMED_WITHOUT_ACTION);
    });
  });

  describe("every binding of the table", () => {
    for (const platform of PLATFORMS) {
      for (const binding of SHORTCUT_BINDINGS) {
        if (!bindingAppliesToPlatform(binding, platform)) {
          continue;
        }
        const event = eventForBinding(binding, platform);
        const label = `${binding.action} from key ${JSON.stringify(event.key)} on ${platform}`;

        it(`claims and performs ${label} when available`, () => {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action: binding.action,
          });
        });

        it(`claims and performs nothing for ${label} when unavailable`, () => {
          const others = SHORTCUT_BINDINGS.map((b) => b.action).filter(
            (action) => action !== binding.action,
          );
          expect(resolveShortcut(event, contextWith(others, platform))).toEqual(
            CLAIMED_WITHOUT_ACTION,
          );
        });

        it(`applies the "${binding.repeat}" repeat policy to ${label}`, () => {
          const isActionAvailable = vi.fn(() => true);
          const resolution = resolveShortcut(
            { ...event, repeat: true },
            { platform, isActionAvailable },
          );
          if (binding.repeat === "acts") {
            expect(resolution).toEqual({ claimed: true, action: binding.action });
          } else {
            expect(resolution).toEqual(CLAIMED_WITHOUT_ACTION);
            // A taken repeat performs nothing, so it does not read the state either.
            expect(isActionAvailable).not.toHaveBeenCalled();
          }
        });
      }
    }

    it("takes a repeated press of every key that ADR 026 marks 'taken, no act'", () => {
      const taken = [
        createKeyEvent({ key: " " }),
        createKeyEvent({ key: "Home" }),
        createKeyEvent({ key: "End" }),
        createKeyEvent({ key: "i", code: "KeyI" }),
        createKeyEvent({ key: "o", code: "KeyO" }),
        createKeyEvent({ key: "I", code: "KeyI", shiftKey: true }),
        createKeyEvent({ key: "O", code: "KeyO", shiftKey: true }),
        createKeyEvent({ key: "Delete" }),
        createKeyEvent({ key: "Backspace" }),
        createKeyEvent({ key: "Escape" }),
        createKeyEvent({ key: "o", code: "KeyO", ctrlKey: true }),
        createKeyEvent({ key: "e", code: "KeyE", ctrlKey: true }),
        createKeyEvent({ key: ",", code: "Comma", ctrlKey: true }),
        createKeyEvent({ key: "\\", code: "Backslash" }),
        createKeyEvent({ key: "Z", code: "KeyZ", shiftKey: true }),
      ];
      for (const event of taken) {
        expect(resolveShortcut({ ...event, repeat: true }, allAvailable)).toEqual(
          CLAIMED_WITHOUT_ACTION,
        );
      }
    });

    it("acts on a repeated press of every key that ADR 026 marks 'acts'", () => {
      const acts: readonly [ShortcutKeyEvent, ShortcutAction][] = [
        [createKeyEvent({ key: "ArrowLeft" }), "stepBackOneFrame"],
        [createKeyEvent({ key: "ArrowRight" }), "stepForwardOneFrame"],
        [createKeyEvent({ key: "ArrowLeft", shiftKey: true }), "stepBackTenFrames"],
        [createKeyEvent({ key: "ArrowRight", shiftKey: true }), "stepForwardTenFrames"],
        [createKeyEvent({ key: "z", code: "KeyZ", ctrlKey: true }), "undo"],
        [
          createKeyEvent({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }),
          "redo",
        ],
        [createKeyEvent({ key: "y", code: "KeyY", ctrlKey: true }), "redo"],
        [createKeyEvent({ key: "=", code: "Equal" }), "zoomIn"],
        [createKeyEvent({ key: "-", code: "Minus" }), "zoomOut"],
        [createKeyEvent({ key: "+", code: "NumpadAdd" }), "zoomIn"],
        [createKeyEvent({ key: "-", code: "NumpadSubtract" }), "zoomOut"],
        [createKeyEvent({ key: "+", code: "Equal", shiftKey: true }), "zoomIn"],
        [createKeyEvent({ key: "=", code: "Minus", shiftKey: true }), "zoomIn"],
        [createKeyEvent({ key: "+", code: "BracketRight" }), "zoomIn"],
      ];
      for (const [event, action] of acts) {
        expect(resolveShortcut({ ...event, repeat: true }, allAvailable)).toEqual({
          claimed: true,
          action,
        });
      }
    });

    it("reads primary from the platform of the context", () => {
      const cmdZ = createKeyEvent({ key: "z", code: "KeyZ", metaKey: true });
      const ctrlZ = createKeyEvent({ key: "z", code: "KeyZ", ctrlKey: true });

      expect(resolveShortcut(cmdZ, contextWith("all", "macos"))).toEqual({
        claimed: true,
        action: "undo",
      });
      expect(resolveShortcut(ctrlZ, contextWith("all", "macos"))).toEqual(NOT_CLAIMED);

      expect(resolveShortcut(ctrlZ, contextWith("all", "windows"))).toEqual({
        claimed: true,
        action: "undo",
      });
      expect(resolveShortcut(cmdZ, contextWith("all", "windows"))).toEqual(NOT_CLAIMED);
    });

    it("claims Ctrl+Y as redo on Windows and leaves Y to the system on macOS", () => {
      const ctrlY = createKeyEvent({ key: "y", code: "KeyY", ctrlKey: true });
      const cmdY = createKeyEvent({ key: "y", code: "KeyY", metaKey: true });
      expect(resolveShortcut(ctrlY, contextWith("all", "windows"))).toEqual({
        claimed: true,
        action: "redo",
      });
      expect(resolveShortcut(ctrlY, contextWith("all", "macos"))).toEqual(NOT_CLAIMED);
      expect(resolveShortcut(cmdY, contextWith("all", "macos"))).toEqual(NOT_CLAIMED);
    });

    it("matches a letter from event.code when event.key is not an ASCII letter", () => {
      // A Cyrillic layout: ш is on the physical I key.
      expect(
        resolveShortcut(createKeyEvent({ key: "ш", code: "KeyI" }), allAvailable),
      ).toEqual({ claimed: true, action: "markIn" });
      // A Dvorak layout: the key that shows I is the physical G key.
      expect(
        resolveShortcut(createKeyEvent({ key: "i", code: "KeyG" }), allAvailable),
      ).toEqual({ claimed: true, action: "markIn" });
      // Caps Lock: an uppercase value with no Shift held is still Mark In.
      expect(
        resolveShortcut(createKeyEvent({ key: "I", code: "KeyI" }), allAvailable),
      ).toEqual({ claimed: true, action: "markIn" });
      // The dead key that Option+I makes on macOS names I, but Alt is held.
      expect(
        resolveShortcut(
          createKeyEvent({ key: "Dead", code: "KeyI", altKey: true }),
          contextWith("all", "macos"),
        ),
      ).toEqual(NOT_CLAIMED);
    });
  });

  // The modifier rule of ADR 026: a binding matches only when the held modifiers equal its
  // set exactly. Every combination the table does not name is not claimed.
  describe("the modifier rule", () => {
    it("does not claim Space or ArrowRight with Ctrl held", () => {
      for (const platform of PLATFORMS) {
        const spaceEvent = createKeyEvent({ key: " ", ctrlKey: true });
        expect(isShortcutSuppressed(spaceEvent)).toBe(false);
        expect(resolveShortcut(spaceEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );

        const arrowEvent = createKeyEvent({ key: "ArrowRight", ctrlKey: true });
        expect(resolveShortcut(arrowEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );
      }
    });

    it("does not claim Space or ArrowRight with Meta held", () => {
      for (const platform of PLATFORMS) {
        const spaceEvent = createKeyEvent({ key: " ", metaKey: true });
        expect(resolveShortcut(spaceEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );

        const arrowEvent = createKeyEvent({ key: "ArrowRight", metaKey: true });
        expect(resolveShortcut(arrowEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );
      }
    });

    it("does not claim Space or ArrowRight with Alt held", () => {
      for (const platform of PLATFORMS) {
        const spaceEvent = createKeyEvent({ key: " ", altKey: true });
        expect(resolveShortcut(spaceEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );

        const arrowEvent = createKeyEvent({ key: "ArrowRight", altKey: true });
        expect(resolveShortcut(arrowEvent, contextWith("all", platform))).toEqual(
          NOT_CLAIMED,
        );
      }
    });

    it("does not claim Shift+Space", () => {
      const spaceEvent = createKeyEvent({ key: " ", shiftKey: true });
      expect(resolveShortcut(spaceEvent, allAvailable)).toEqual(NOT_CLAIMED);
    });

    // Changed by ADR 026: ADR 021 refused Shift+ArrowRight and held Shift free for this step.
    it("claims Shift+ArrowLeft and Shift+ArrowRight as the ten-frame step", () => {
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowRight", shiftKey: true }),
          allAvailable,
        ),
      ).toEqual({ claimed: true, action: "stepForwardTenFrames" });
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", shiftKey: true }),
          allAvailable,
        ),
      ).toEqual({ claimed: true, action: "stepBackTenFrames" });
    });

    it("does not claim Ctrl+Shift+I, Cmd+Shift+I, Alt+I or Alt+Shift+I", () => {
      for (const platform of PLATFORMS) {
        for (const event of [
          createKeyEvent({ key: "I", code: "KeyI", ctrlKey: true, shiftKey: true }),
          createKeyEvent({ key: "I", code: "KeyI", metaKey: true, shiftKey: true }),
          createKeyEvent({ key: "i", code: "KeyI", altKey: true }),
          createKeyEvent({ key: "I", code: "KeyI", altKey: true, shiftKey: true }),
        ]) {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual(
            NOT_CLAIMED,
          );
        }
      }
    });

    it("does not claim primary+Alt+Z or primary+I", () => {
      for (const platform of PLATFORMS) {
        const primary: Partial<ShortcutKeyEvent> =
          platform === "macos" ? { metaKey: true } : { ctrlKey: true };
        expect(
          resolveShortcut(
            createKeyEvent({ key: "z", code: "KeyZ", altKey: true, ...primary }),
            contextWith("all", platform),
          ),
        ).toEqual(NOT_CLAIMED);
        expect(
          resolveShortcut(
            createKeyEvent({ key: "i", code: "KeyI", ...primary }),
            contextWith("all", platform),
          ),
        ).toEqual(NOT_CLAIMED);
      }
    });

    it("does not ask the availability of an unclaimed key", () => {
      const isActionAvailable = vi.fn(() => true);
      resolveShortcut(createKeyEvent({ key: " ", ctrlKey: true }), {
        platform: "windows",
        isActionAvailable,
      });
      resolveShortcut(createKeyEvent({ key: "Enter" }), {
        platform: "windows",
        isActionAvailable,
      });
      expect(isActionAvailable).not.toHaveBeenCalled();
    });
  });

  // 13. One test per suppression clause, each asserting {claimed: false, action: null}
  describe("suppression clauses", () => {
    it("suppresses when isComposing is true", () => {
      const event = createKeyEvent({ key: " ", isComposing: true });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("suppresses when keyCode is 229 with isComposing: false", () => {
      const event = createKeyEvent({
        key: " ",
        isComposing: false,
        keyCode: 229,
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("does not throw and does not suppress when keyCode is absent entirely", () => {
      const event: ShortcutKeyEvent = {
        key: " ",
        code: "Space",
        repeat: false,
        isComposing: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        target: createTarget(),
        isOverlayOpen: false,
        isTooltipOpen: false,
      };
      expect("keyCode" in event).toBe(false);
      expect(isShortcutSuppressed(event)).toBe(false);
      expect(resolveShortcut(event, allAvailable)).toEqual({
        claimed: true,
        action: "togglePlayback",
      });
    });

    it("suppresses when defaultPrevented is true", () => {
      const event = createKeyEvent({ key: " ", defaultPrevented: true });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("suppresses when target is an INPUT tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "INPUT" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    // The typed timecode of the preview is an INPUT. Its text uses keys that the table binds:
    // `+` and `-` zoom, Backspace deletes a segment, Escape finishes one, and the arrows, Home
    // and End move the playhead. The field keeps all of them, and Escape closes the field.
    it("leaves every key of the typed timecode field to the field", () => {
      const field = createTarget({ tagName: "INPUT" });
      const presses: Partial<ShortcutKeyEvent>[] = [
        { key: "+", code: "Equal", shiftKey: true },
        { key: "-", code: "Minus" },
        { key: "=", code: "Equal" },
        { key: "Backspace", code: "Backspace" },
        { key: "Delete", code: "Delete" },
        { key: "Escape", code: "Escape" },
        { key: "ArrowLeft", code: "ArrowLeft" },
        { key: "ArrowRight", code: "ArrowRight", shiftKey: true },
        { key: "Home", code: "Home" },
        { key: "End", code: "End" },
        { key: " ", code: "Space" },
        { key: "i", code: "KeyI" },
        { key: "z", code: "KeyZ", metaKey: true },
        { key: "z", code: "KeyZ", ctrlKey: true },
      ];
      for (const press of presses) {
        const event = createKeyEvent({ ...press, target: field });
        expect(resolveShortcut(event, allAvailable), press.key).toEqual(NOT_CLAIMED);
      }
    });

    it("suppresses when target is a TEXTAREA tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "TEXTAREA" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("suppresses when target is a SELECT tag", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "SELECT" }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("suppresses when target has isContentEditable: true on a DIV", () => {
      const event = createKeyEvent({
        key: " ",
        target: createTarget({ tagName: "DIV", isContentEditable: true }),
      });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
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
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
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
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
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
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
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
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
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
      expect(resolveShortcut(event, allAvailable)).toEqual({
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
      expect(resolveShortcut(event, allAvailable)).toEqual({
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
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });
  });

  describe("suppression clauses for the keys of ADR 026", () => {
    const suppressingContexts: readonly [string, Partial<ShortcutKeyEvent>][] = [
      ["a text input", { target: createTarget({ tagName: "INPUT" }) }],
      ["a textarea", { target: createTarget({ tagName: "TEXTAREA" }) }],
      ["a select", { target: createTarget({ tagName: "SELECT" }) }],
      [
        "an editable element",
        { target: createTarget({ tagName: "DIV", isContentEditable: true }) },
      ],
      [
        "a dialog",
        {
          target: createTarget({
            tagName: "BUTTON",
            hasAncestorMatching: (sel) => sel.includes('[role="dialog"]'),
          }),
        },
      ],
      [
        "a menu",
        {
          target: createTarget({
            tagName: "DIV",
            hasAncestorMatching: (sel) => sel.includes('[role="menu"]'),
          }),
        },
      ],
      [
        "a list box",
        {
          target: createTarget({
            tagName: "DIV",
            hasAncestorMatching: (sel) => sel.includes('[role="listbox"]'),
          }),
        },
      ],
      ["an open modal layer with the focus on the body", { isOverlayOpen: true }],
      ["an input method composition", { isComposing: true }],
      ["a key an input method took", { keyCode: 229 }],
      ["an event already cancelled", { defaultPrevented: true }],
    ];

    for (const [name, overrides] of suppressingContexts) {
      for (const platform of PLATFORMS) {
        it(`does not claim any new key inside ${name} on ${platform}`, () => {
          for (const event of newKeyEvents(platform, overrides)) {
            expect(isShortcutSuppressed(event)).toBe(true);
            expect(resolveShortcut(event, contextWith("all", platform))).toEqual(
              NOT_CLAIMED,
            );
          }
        });
      }
    }

    it("leaves primary+Z to a text field, so the field keeps its own undo", () => {
      const event = createKeyEvent({
        key: "z",
        code: "KeyZ",
        metaKey: true,
        target: createTarget({ tagName: "INPUT" }),
      });
      expect(resolveShortcut(event, contextWith("all", "macos"))).toEqual(NOT_CLAIMED);
    });

    it("leaves Escape to an open dialog, so Radix closes it", () => {
      const event = createKeyEvent({ key: "Escape", isOverlayOpen: true });
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });

    it("claims every new key outside those contexts", () => {
      for (const platform of PLATFORMS) {
        for (const event of newKeyEvents(platform, {})) {
          expect(isShortcutSuppressed(event)).toBe(false);
          expect(resolveShortcut(event, contextWith("all", platform)).claimed).toBe(
            true,
          );
        }
      }
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

    it("names the shadcn tooltip content in OPEN_TOOLTIP_SELECTOR and leaves a closing tooltip out", () => {
      // The shadcn wrapper sets data-slot="tooltip-content"; Radix sets data-state to
      // delayed-open, instant-open or closed on the same element.
      expect(OPEN_TOOLTIP_SELECTOR).toBe(
        '[data-slot="tooltip-content"]:not([data-state="closed"])',
      );
      // A tooltip is not a modal layer: it must not suppress the whole layer.
      expect(MODAL_LAYER_SELECTOR).not.toContain("tooltip");
    });
  });

  // ADR 026: Escape while a tooltip is open is not owned, so Radix closes the tooltip first.
  describe("the zoom keys", () => {
    const zoomKeys: readonly [string, ShortcutKeyEvent, ShortcutAction][] = [
      ["=", createKeyEvent({ key: "=", code: "Equal" }), "zoomIn"],
      ["-", createKeyEvent({ key: "-", code: "Minus" }), "zoomOut"],
      ["numpad +", createKeyEvent({ key: "+", code: "NumpadAdd" }), "zoomIn"],
      ["numpad -", createKeyEvent({ key: "-", code: "NumpadSubtract" }), "zoomOut"],
      ["\\", createKeyEvent({ key: "\\", code: "Backslash" }), "zoomToFit"],
    ];

    for (const platform of PLATFORMS) {
      for (const [name, event, action] of zoomKeys) {
        it(`claims ${name} as ${action} on ${platform}`, () => {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action,
          });
        });

        it(`owns ${name} and does nothing at the limit on ${platform}`, () => {
          // At zoom 1 Zoom Out and Fit are unavailable, and at the ceiling Zoom In is. A held
          // key that reaches the limit still reaches no other handler.
          expect(resolveShortcut(event, contextWith([], platform))).toEqual(
            CLAIMED_WITHOUT_ACTION,
          );
          expect(
            resolveShortcut({ ...event, repeat: true }, contextWith([], platform)),
          ).toEqual(CLAIMED_WITHOUT_ACTION);
        });
      }
    }

    it("does not claim primary with = and -", () => {
      for (const platform of PLATFORMS) {
        const primary: Partial<ShortcutKeyEvent> =
          platform === "macos" ? { metaKey: true } : { ctrlKey: true };
        for (const event of [
          createKeyEvent({ key: "=", code: "Equal", ...primary }),
          createKeyEvent({ key: "-", code: "Minus", ...primary }),
          createKeyEvent({ key: "+", code: "NumpadAdd", ...primary }),
          createKeyEvent({ key: "\\", code: "Backslash", ...primary }),
        ]) {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual(
            NOT_CLAIMED,
          );
        }
      }
    });

    it("claims the layout variants of = and +, which zoom in and act on a repeat", () => {
      for (const platform of PLATFORMS) {
        for (const event of [
          // US Shift+Equal types +.
          createKeyEvent({ key: "+", code: "Equal", shiftKey: true }),
          // JIS Shift+Minus types =.
          createKeyEvent({ key: "=", code: "Minus", shiftKey: true }),
          // The German + key is unshifted.
          createKeyEvent({ key: "+", code: "BracketRight" }),
        ]) {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action: "zoomIn",
          });
          expect(
            resolveShortcut({ ...event, repeat: true }, contextWith("all", platform)),
          ).toEqual({ claimed: true, action: "zoomIn" });
        }
      }
    });

    it("claims Shift+Z as Fit and takes its repeat, apart from undo and redo", () => {
      for (const platform of PLATFORMS) {
        const primary: Partial<ShortcutKeyEvent> =
          platform === "macos" ? { metaKey: true } : { ctrlKey: true };
        const shiftZ = createKeyEvent({ key: "Z", code: "KeyZ", shiftKey: true });
        expect(resolveShortcut(shiftZ, contextWith("all", platform))).toEqual({
          claimed: true,
          action: "zoomToFit",
        });
        expect(
          resolveShortcut({ ...shiftZ, repeat: true }, contextWith("all", platform)),
        ).toEqual(CLAIMED_WITHOUT_ACTION);
        expect(
          resolveShortcut({ ...shiftZ, ...primary }, contextWith("all", platform)),
        ).toEqual({ claimed: true, action: "redo" });
        expect(
          resolveShortcut(
            createKeyEvent({ key: "z", code: "KeyZ", ...primary }),
            contextWith("all", platform),
          ),
        ).toEqual({ claimed: true, action: "undo" });
      }
    });

    it("does not claim Shift with - or \\, or Alt with a zoom key", () => {
      for (const platform of PLATFORMS) {
        for (const event of [
          createKeyEvent({ key: "_", code: "Minus", shiftKey: true }),
          createKeyEvent({ key: "|", code: "Backslash", shiftKey: true }),
          createKeyEvent({ key: "=", code: "Equal", altKey: true }),
          createKeyEvent({ key: "+", code: "BracketRight", altKey: true }),
          createKeyEvent({ key: "Z", code: "KeyZ", shiftKey: true, altKey: true }),
        ]) {
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual(
            NOT_CLAIMED,
          );
        }
      }
    });
  });

  describe("Escape and an open tooltip", () => {
    const escape = (overrides: Partial<ShortcutKeyEvent> = {}) =>
      createKeyEvent({ key: "Escape", ...overrides });

    it("does not claim Escape while a tooltip is open", () => {
      for (const platform of PLATFORMS) {
        const isActionAvailable = vi.fn(() => true);
        const event = escape({ isTooltipOpen: true });
        // The tooltip is not a suppression context: only the Escape binding yields.
        expect(isShortcutSuppressed(event)).toBe(false);
        expect(resolveShortcut(event, { platform, isActionAvailable })).toEqual(
          NOT_CLAIMED,
        );
        expect(isActionAvailable).not.toHaveBeenCalled();
      }
    });

    it("does not claim Escape while a tooltip is open, even when no segment is in progress", () => {
      expect(resolveShortcut(escape({ isTooltipOpen: true }), contextWith([]))).toEqual(
        NOT_CLAIMED,
      );
    });

    it("does not claim a repeated Escape while a tooltip is open", () => {
      expect(
        resolveShortcut(escape({ isTooltipOpen: true, repeat: true }), allAvailable),
      ).toEqual(NOT_CLAIMED);
    });

    it("closes the tooltip with the first Escape and finishes the segment with the second", () => {
      // First press: a tooltip is open, so the key goes on to Radix, which closes it.
      expect(resolveShortcut(escape({ isTooltipOpen: true }), allAvailable)).toEqual(
        NOT_CLAIMED,
      );
      // Second press: the tooltip is closed or closing (data-state="closed"), so the layer
      // owns the key and finishes the segment.
      expect(resolveShortcut(escape({ isTooltipOpen: false }), allAvailable)).toEqual({
        claimed: true,
        action: "finishSegment",
      });
    });

    it("keeps every other key of the table while a tooltip is open", () => {
      for (const platform of PLATFORMS) {
        for (const binding of SHORTCUT_BINDINGS) {
          if (
            !bindingAppliesToPlatform(binding, platform) ||
            binding.yieldsToOpenTooltip
          ) {
            continue;
          }
          const event = eventForBinding(binding, platform, { isTooltipOpen: true });
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action: binding.action,
          });
        }
      }
    });

    it("gives the tooltip yield to the Escape binding only", () => {
      const yielding = SHORTCUT_BINDINGS.filter((b) => b.yieldsToOpenTooltip === true);
      expect(yielding).toHaveLength(1);
      expect(yielding[0]?.key).toEqual({ kind: "named", key: "Escape" });
      expect(yielding[0]?.action).toBe("finishSegment");
    });

    it("still leaves Escape to an open dialog when a tooltip is open inside it", () => {
      const event = escape({ isTooltipOpen: true, isOverlayOpen: true });
      expect(isShortcutSuppressed(event)).toBe(true);
      expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
    });
  });

  describe("a focused splitter", () => {
    // The target answers the splitter selector only, as the focused timeline splitter does:
    // it carries the splitter marker, inside no dialog, menu or list box.
    const splitterTarget = createTarget({
      tagName: "DIV",
      hasAncestorMatching: (selector) => selector === SPLITTER_SELECTOR,
    });

    it("names the splitter marker, and not every separator", () => {
      expect(SPLITTER_SELECTOR).toBe("[data-splitter]");
      expect(SPLITTER_SELECTOR).not.toContain("separator");
      expect(SPLITTER_KEYS).toEqual(["ArrowUp", "ArrowDown", "Home", "End"]);
      expect(splitterTarget.hasAncestorMatching(KEYBOARD_OWNER_SELECTOR)).toBe(false);
    });

    it("keeps Home and End for the splitter, so they do not go to the first or last frame", () => {
      for (const key of ["Home", "End"]) {
        const onBody = createKeyEvent({ key });
        expect(resolveShortcut(onBody, allAvailable).claimed).toBe(true);

        const onSplitter = createKeyEvent({ key, target: splitterTarget });
        expect(isSplitterKey(onSplitter)).toBe(true);
        expect(resolveShortcut(onSplitter, allAvailable)).toEqual(NOT_CLAIMED);
        expect(resolveShortcut({ ...onSplitter, repeat: true }, allAvailable)).toEqual(
          NOT_CLAIMED,
        );
      }
    });

    it("keeps ArrowUp and ArrowDown for the splitter, with and without Shift", () => {
      for (const key of ["ArrowUp", "ArrowDown"]) {
        for (const shiftKey of [false, true]) {
          const event = createKeyEvent({ key, shiftKey, target: splitterTarget });
          expect(isSplitterKey(event)).toBe(true);
          expect(resolveShortcut(event, allAvailable)).toEqual(NOT_CLAIMED);
        }
      }
    });

    it("keeps every other key of the table while the splitter has the focus", () => {
      for (const platform of PLATFORMS) {
        for (const binding of SHORTCUT_BINDINGS) {
          if (!bindingAppliesToPlatform(binding, platform)) {
            continue;
          }
          const event = eventForBinding(binding, platform, { target: splitterTarget });
          if (SPLITTER_KEYS.includes(event.key)) {
            continue;
          }
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action: binding.action,
          });
        }
      }
    });

    it("still plays with Space and steps with the arrows that do not move it", () => {
      expect(
        resolveShortcut(
          createKeyEvent({ key: " ", target: splitterTarget }),
          allAvailable,
        ),
      ).toEqual({ claimed: true, action: "togglePlayback" });
      expect(
        resolveShortcut(
          createKeyEvent({ key: "ArrowLeft", target: splitterTarget }),
          allAvailable,
        ),
      ).toEqual({ claimed: true, action: "stepBackOneFrame" });
    });

    it("does not own a splitter key with Ctrl, Cmd or Alt", () => {
      for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
        const event = createKeyEvent({
          key: "Home",
          target: splitterTarget,
          [modifier]: true,
        });
        expect(isSplitterKey(event)).toBe(false);
      }
    });

    it("does not own a splitter key when the target is not a splitter", () => {
      expect(isSplitterKey(createKeyEvent({ key: "Home" }))).toBe(false);
      expect(isSplitterKey(createKeyEvent({ key: "Home", target: null }))).toBe(false);
    });
  });

  describe("Escape during a drag of the timeline splitter", () => {
    // During the drag the document root carries the attribute of the resize cursor, so every
    // target answers the selector through `closest`.
    const inDrag = (overrides: Partial<ShortcutKeyEvent> = {}) =>
      createKeyEvent({
        key: "Escape",
        target: createTarget({
          hasAncestorMatching: (selector) => selector === ESCAPE_OWNER_SELECTOR,
        }),
        ...overrides,
      });

    it("reads the attribute of the resize cursor on the document root", () => {
      expect(ESCAPE_OWNER_SELECTOR).toBe(`[${RESIZING_TIMELINE_ATTRIBUTE}]`);
      expect(ESCAPE_OWNER_SELECTOR).toBe("[data-resizing-timeline]");
    });

    it("leaves Escape to the drag, so it does not finish the segment", () => {
      expect(resolveShortcut(createKeyEvent({ key: "Escape" }), allAvailable)).toEqual({
        claimed: true,
        action: "finishSegment",
      });
      expect(isGestureEscape(inDrag())).toBe(true);
      expect(resolveShortcut(inDrag(), allAvailable)).toEqual(NOT_CLAIMED);
      expect(resolveShortcut(inDrag({ repeat: true }), allAvailable)).toEqual(
        NOT_CLAIMED,
      );
      expect(resolveShortcut(inDrag({ shiftKey: true }), allAvailable)).toEqual(
        NOT_CLAIMED,
      );
    });

    it("keeps every other key of the table during the drag", () => {
      const dragTarget = createTarget({
        hasAncestorMatching: (selector) => selector === ESCAPE_OWNER_SELECTOR,
      });
      for (const platform of PLATFORMS) {
        for (const binding of SHORTCUT_BINDINGS) {
          if (!bindingAppliesToPlatform(binding, platform)) {
            continue;
          }
          const event = eventForBinding(binding, platform, { target: dragTarget });
          if (event.key === "Escape") {
            continue;
          }
          expect(resolveShortcut(event, contextWith("all", platform))).toEqual({
            claimed: true,
            action: binding.action,
          });
        }
      }
    });

    it("does not own Escape when no drag runs", () => {
      const idleRoot = () => ({ hasAttribute: () => false });
      expect(isGestureEscape(createKeyEvent({ key: "Escape" }), idleRoot)).toBe(false);
      expect(
        isGestureEscape(createKeyEvent({ key: "Escape", target: null }), idleRoot),
      ).toBe(false);
      expect(isGestureEscape(inDrag({ key: "Home" }))).toBe(false);
    });

    it("reads the document root for a key press with no element target", () => {
      const dragRoot = () => ({
        hasAttribute: (name: string) => name === RESIZING_TIMELINE_ATTRIBUTE,
      });
      const noTarget = createKeyEvent({ key: "Escape", target: null });
      expect(isGestureEscape(noTarget, dragRoot)).toBe(true);
      expect(isGestureEscape({ ...noTarget, key: "Home" }, dragRoot)).toBe(false);
      // Outside a document there is no root, so no drag owns the key.
      expect(isGestureEscape(noTarget, () => null)).toBe(false);
      expect(isGestureEscape(noTarget)).toBe(false);
    });

    it("leaves Escape with no element target to the drag in the resolver", () => {
      vi.stubGlobal("document", {
        documentElement: {
          hasAttribute: (name: string) => name === RESIZING_TIMELINE_ATTRIBUTE,
        },
      });
      try {
        expect(
          resolveShortcut(
            createKeyEvent({ key: "Escape", target: null }),
            allAvailable,
          ),
        ).toEqual(NOT_CLAIMED);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(
        resolveShortcut(createKeyEvent({ key: "Escape", target: null }), allAvailable),
      ).toEqual({ claimed: true, action: "finishSegment" });
    });
  });
});
