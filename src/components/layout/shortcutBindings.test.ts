import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_BINDINGS,
  bindingAppliesToPlatform,
  findShortcutBinding,
  getShortcutPlatform,
  matchesShortcutKey,
  matchesShortcutModifiers,
  type ShortcutAction,
  type ShortcutBinding,
  type ShortcutKey,
  type ShortcutKeyPress,
  type ShortcutPlatform,
} from "./shortcutBindings";

const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows"];

function press(overrides: Partial<ShortcutKeyPress> = {}): ShortcutKeyPress {
  return {
    key: " ",
    code: "Space",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

/** The held modifiers that `primary` means on the platform. */
function primary(platform: ShortcutPlatform): Partial<ShortcutKeyPress> {
  return platform === "macos" ? { metaKey: true } : { ctrlKey: true };
}

function actionOf(
  p: ShortcutKeyPress,
  platform: ShortcutPlatform,
): ShortcutAction | null {
  return findShortcutBinding(p, platform)?.action ?? null;
}

describe("shortcutBindings", () => {
  describe("the table of ADR 026", () => {
    // One row for each binding of ADR 026 except the zoom rows. The key press is the plain
    // US-layout press that names the key.
    const rows: readonly {
      readonly name: string;
      readonly press: (platform: ShortcutPlatform) => ShortcutKeyPress;
      readonly action: ShortcutAction;
      readonly repeat: "acts" | "taken";
    }[] = [
      {
        name: "Space",
        press: () => press({ key: " ", code: "Space" }),
        action: "togglePlayback",
        repeat: "taken",
      },
      {
        name: "ArrowLeft",
        press: () => press({ key: "ArrowLeft", code: "ArrowLeft" }),
        action: "stepBackOneFrame",
        repeat: "acts",
      },
      {
        name: "ArrowRight",
        press: () => press({ key: "ArrowRight", code: "ArrowRight" }),
        action: "stepForwardOneFrame",
        repeat: "acts",
      },
      {
        name: "Shift+ArrowLeft",
        press: () => press({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }),
        action: "stepBackTenFrames",
        repeat: "acts",
      },
      {
        name: "Shift+ArrowRight",
        press: () => press({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }),
        action: "stepForwardTenFrames",
        repeat: "acts",
      },
      {
        name: "Home",
        press: () => press({ key: "Home", code: "Home" }),
        action: "goToStart",
        repeat: "taken",
      },
      {
        name: "End",
        press: () => press({ key: "End", code: "End" }),
        action: "goToEnd",
        repeat: "taken",
      },
      {
        name: "I",
        press: () => press({ key: "i", code: "KeyI" }),
        action: "markIn",
        repeat: "taken",
      },
      {
        name: "O",
        press: () => press({ key: "o", code: "KeyO" }),
        action: "markOut",
        repeat: "taken",
      },
      {
        name: "Shift+I",
        press: () => press({ key: "I", code: "KeyI", shiftKey: true }),
        action: "goToSegmentIn",
        repeat: "taken",
      },
      {
        name: "Shift+O",
        press: () => press({ key: "O", code: "KeyO", shiftKey: true }),
        action: "goToSegmentOut",
        repeat: "taken",
      },
      {
        name: "Delete",
        press: () => press({ key: "Delete", code: "Delete" }),
        action: "deleteSegment",
        repeat: "taken",
      },
      {
        name: "Backspace",
        press: () => press({ key: "Backspace", code: "Backspace" }),
        action: "deleteSegment",
        repeat: "taken",
      },
      {
        name: "Escape",
        press: () => press({ key: "Escape", code: "Escape" }),
        action: "finishSegment",
        repeat: "taken",
      },
      {
        name: "primary+Z",
        press: (platform) => press({ key: "z", code: "KeyZ", ...primary(platform) }),
        action: "undo",
        repeat: "acts",
      },
      {
        name: "primary+Shift+Z",
        press: (platform) =>
          press({ key: "Z", code: "KeyZ", shiftKey: true, ...primary(platform) }),
        action: "redo",
        repeat: "acts",
      },
      {
        name: "primary+O",
        press: (platform) => press({ key: "o", code: "KeyO", ...primary(platform) }),
        action: "openMedia",
        repeat: "taken",
      },
      {
        name: "primary+E",
        press: (platform) => press({ key: "e", code: "KeyE", ...primary(platform) }),
        action: "export",
        repeat: "taken",
      },
      {
        name: "primary+,",
        press: (platform) => press({ key: ",", code: "Comma", ...primary(platform) }),
        action: "openSettings",
        repeat: "taken",
      },
    ];

    for (const platform of PLATFORMS) {
      for (const row of rows) {
        it(`maps ${row.name} to ${row.action} (${row.repeat}) on ${platform}`, () => {
          const binding = findShortcutBinding(row.press(platform), platform);
          expect(binding?.action).toBe(row.action);
          expect(binding?.repeat).toBe(row.repeat);
        });
      }
    }

    it("maps Ctrl+Y to redo (acts) on Windows only", () => {
      const binding = findShortcutBinding(
        press({ key: "y", code: "KeyY", ctrlKey: true }),
        "windows",
      );
      expect(binding?.action).toBe("redo");
      expect(binding?.repeat).toBe("acts");

      // On macOS neither Ctrl+Y nor Cmd+Y belongs to the table.
      expect(
        findShortcutBinding(press({ key: "y", code: "KeyY", ctrlKey: true }), "macos"),
      ).toBeNull();
      expect(
        findShortcutBinding(press({ key: "y", code: "KeyY", metaKey: true }), "macos"),
      ).toBeNull();
    });

    it("gives every action at least one binding on each platform", () => {
      for (const platform of PLATFORMS) {
        const bound = new Set(
          SHORTCUT_BINDINGS.filter((b) => bindingAppliesToPlatform(b, platform)).map(
            (b) => b.action,
          ),
        );
        for (const action of SHORTCUT_ACTIONS) {
          expect(bound.has(action)).toBe(true);
        }
      }
    });

    it("never binds one key and one modifier set twice on one platform", () => {
      const signature = (binding: ShortcutBinding): string => {
        const key: ShortcutKey = binding.key;
        const name =
          key.kind === "named"
            ? `named:${key.key}`
            : key.kind === "letter"
              ? `letter:${key.letter}`
              : `character:${key.character}`;
        return `${name}|${[...binding.modifiers].sort().join("+")}`;
      };
      for (const platform of PLATFORMS) {
        const seen = new Set<string>();
        for (const binding of SHORTCUT_BINDINGS) {
          if (!bindingAppliesToPlatform(binding, platform)) {
            continue;
          }
          const s = signature(binding);
          expect(seen.has(s)).toBe(false);
          seen.add(s);
        }
      }
    });

    it("has no zoom binding yet: the zoom keys stay with the web view", () => {
      // The zoom rows of ADR 026 arrive with the timeline zoom controls.
      for (const platform of PLATFORMS) {
        for (const p of [
          press({ key: "=", code: "Equal" }),
          press({ key: "-", code: "Minus" }),
          press({ key: "+", code: "NumpadAdd" }),
          press({ key: "-", code: "NumpadSubtract" }),
          press({ key: "\\", code: "Backslash" }),
        ]) {
          expect(findShortcutBinding(p, platform)).toBeNull();
        }
      }
    });

    it("leaves ArrowUp, ArrowDown, Enter and Tab out of the table", () => {
      for (const platform of PLATFORMS) {
        for (const key of ["ArrowUp", "ArrowDown", "Enter", "Tab"]) {
          expect(findShortcutBinding(press({ key, code: key }), platform)).toBeNull();
        }
      }
    });
  });

  describe("the modifier rule: the held set must equal the binding set exactly", () => {
    it("rejects Ctrl+Shift+I and Cmd+Shift+I for I and for Shift+I", () => {
      for (const platform of PLATFORMS) {
        expect(
          actionOf(
            press({ key: "I", code: "KeyI", shiftKey: true, ctrlKey: true }),
            platform,
          ),
        ).toBeNull();
        expect(
          actionOf(
            press({ key: "I", code: "KeyI", shiftKey: true, metaKey: true }),
            platform,
          ),
        ).toBeNull();
      }
    });

    it("rejects Alt with any key of the table", () => {
      for (const platform of PLATFORMS) {
        for (const p of [
          press({ key: "i", code: "KeyI", altKey: true }),
          press({ key: " ", code: "Space", altKey: true }),
          press({ key: "ArrowRight", code: "ArrowRight", altKey: true }),
          press({ key: "z", code: "KeyZ", altKey: true, ...primary(platform) }),
        ]) {
          expect(actionOf(p, platform)).toBeNull();
        }
      }
    });

    it("rejects Shift+Space, Ctrl+Space and Cmd+Space", () => {
      for (const platform of PLATFORMS) {
        expect(actionOf(press({ key: " ", shiftKey: true }), platform)).toBeNull();
        expect(actionOf(press({ key: " ", ctrlKey: true }), platform)).toBeNull();
        expect(actionOf(press({ key: " ", metaKey: true }), platform)).toBeNull();
      }
    });

    it("rejects primary with an arrow, Home, End, I, O, Delete and Escape", () => {
      for (const platform of PLATFORMS) {
        for (const [key, code] of [
          ["ArrowLeft", "ArrowLeft"],
          ["ArrowRight", "ArrowRight"],
          ["Home", "Home"],
          ["End", "End"],
          ["i", "KeyI"],
          ["Delete", "Delete"],
          ["Backspace", "Backspace"],
          ["Escape", "Escape"],
        ]) {
          expect(
            actionOf(press({ key, code, ...primary(platform) }), platform),
          ).toBeNull();
        }
      }
    });

    it("rejects Shift with Home, End, Delete, Escape and Z", () => {
      for (const platform of PLATFORMS) {
        for (const [key, code] of [
          ["Home", "Home"],
          ["End", "End"],
          ["Delete", "Delete"],
          ["Escape", "Escape"],
          ["Z", "KeyZ"],
        ]) {
          expect(actionOf(press({ key, code, shiftKey: true }), platform)).toBeNull();
        }
      }
    });

    it("rejects a plain Z, E and comma, which need primary", () => {
      for (const platform of PLATFORMS) {
        expect(actionOf(press({ key: "z", code: "KeyZ" }), platform)).toBeNull();
        expect(actionOf(press({ key: "e", code: "KeyE" }), platform)).toBeNull();
        expect(actionOf(press({ key: ",", code: "Comma" }), platform)).toBeNull();
      }
    });

    it("rejects primary+Shift+O, primary+Shift+E and primary+Shift+comma", () => {
      for (const platform of PLATFORMS) {
        for (const [key, code] of [
          ["O", "KeyO"],
          ["E", "KeyE"],
          ["<", "Comma"],
        ]) {
          expect(
            actionOf(
              press({ key, code, shiftKey: true, ...primary(platform) }),
              platform,
            ),
          ).toBeNull();
        }
      }
    });

    it("rejects Ctrl and Cmd held together with Z", () => {
      for (const platform of PLATFORMS) {
        expect(
          actionOf(
            press({ key: "z", code: "KeyZ", ctrlKey: true, metaKey: true }),
            platform,
          ),
        ).toBeNull();
      }
    });

    it("rejects AltGr on Windows, which reports Ctrl and Alt together", () => {
      expect(
        actionOf(
          press({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true }),
          "windows",
        ),
      ).toBeNull();
    });

    it("maps primary to Cmd on macOS and to Ctrl on Windows", () => {
      // macOS: Cmd+Z undoes, Ctrl+Z belongs to the system.
      expect(actionOf(press({ key: "z", code: "KeyZ", metaKey: true }), "macos")).toBe(
        "undo",
      );
      expect(
        actionOf(press({ key: "z", code: "KeyZ", ctrlKey: true }), "macos"),
      ).toBeNull();

      // Windows: Ctrl+Z undoes, the Windows key with Z belongs to the system.
      expect(
        actionOf(press({ key: "z", code: "KeyZ", ctrlKey: true }), "windows"),
      ).toBe("undo");
      expect(
        actionOf(press({ key: "z", code: "KeyZ", metaKey: true }), "windows"),
      ).toBeNull();
    });

    it("answers the modifier test directly for each set", () => {
      const none = press();
      expect(matchesShortcutModifiers([], none, "macos")).toBe(true);
      expect(matchesShortcutModifiers(["shift"], none, "macos")).toBe(false);
      expect(
        matchesShortcutModifiers(
          ["primary", "shift"],
          press({ metaKey: true }),
          "macos",
        ),
      ).toBe(false);
      expect(
        matchesShortcutModifiers(
          ["primary", "shift"],
          press({ metaKey: true, shiftKey: true }),
          "macos",
        ),
      ).toBe(true);
      expect(
        matchesShortcutModifiers(
          ["primary", "shift"],
          press({ ctrlKey: true, shiftKey: true }),
          "windows",
        ),
      ).toBe(true);
    });
  });

  describe("how the layer names a key", () => {
    const letterI: ShortcutKey = { kind: "letter", letter: "I" };
    const letterO: ShortcutKey = { kind: "letter", letter: "O" };
    const comma: ShortcutKey = { kind: "character", character: ",", code: "Comma" };

    it("matches a letter by event.key when it is one ASCII letter, without case", () => {
      expect(matchesShortcutKey(letterI, { key: "i", code: "KeyI" })).toBe(true);
      expect(matchesShortcutKey(letterI, { key: "I", code: "KeyI" })).toBe(true);
    });

    it("follows the selected layout: a Dvorak key that shows I marks In", () => {
      // Dvorak puts I on the physical G key, and the physical I key shows C.
      expect(matchesShortcutKey(letterI, { key: "i", code: "KeyG" })).toBe(true);
      expect(matchesShortcutKey(letterI, { key: "c", code: "KeyI" })).toBe(false);

      for (const platform of PLATFORMS) {
        expect(actionOf(press({ key: "i", code: "KeyG" }), platform)).toBe("markIn");
        expect(actionOf(press({ key: "c", code: "KeyI" }), platform)).toBeNull();
        // Dvorak puts O on the physical S key, and the physical O key shows R.
        expect(actionOf(press({ key: "o", code: "KeyS" }), platform)).toBe("markOut");
        expect(actionOf(press({ key: "r", code: "KeyO" }), platform)).toBeNull();
      }
    });

    it("falls back to event.code for a Cyrillic layout", () => {
      // The Russian layout puts ш on the physical I key, щ on the physical O key, and я on
      // the physical Z key.
      expect(matchesShortcutKey(letterI, { key: "ш", code: "KeyI" })).toBe(true);
      for (const platform of PLATFORMS) {
        expect(actionOf(press({ key: "ш", code: "KeyI" }), platform)).toBe("markIn");
        expect(
          actionOf(press({ key: "Ш", code: "KeyI", shiftKey: true }), platform),
        ).toBe("goToSegmentIn");
        expect(actionOf(press({ key: "щ", code: "KeyO" }), platform)).toBe("markOut");
        expect(
          actionOf(press({ key: "я", code: "KeyZ", ...primary(platform) }), platform),
        ).toBe("undo");
      }
    });

    it("falls back to event.code for a Greek layout", () => {
      // The Greek layout puts ι on the physical I key.
      expect(matchesShortcutKey(letterI, { key: "ι", code: "KeyI" })).toBe(true);
    });

    it("falls back to event.code for a dead key", () => {
      expect(matchesShortcutKey(letterI, { key: "Dead", code: "KeyI" })).toBe(true);
      expect(matchesShortcutKey(letterO, { key: "Dead", code: "KeyI" })).toBe(false);
    });

    it("falls back to event.code for the character that Option makes on macOS", () => {
      // Option+O makes ø, and Option+I is the circumflex dead key, on the US layout.
      expect(matchesShortcutKey(letterO, { key: "ø", code: "KeyO" })).toBe(true);
      expect(matchesShortcutKey(letterI, { key: "Dead", code: "KeyI" })).toBe(true);

      // The key is named, but Alt is held, and no binding holds Alt.
      expect(
        actionOf(press({ key: "ø", code: "KeyO", altKey: true }), "macos"),
      ).toBeNull();
      expect(
        actionOf(press({ key: "Dead", code: "KeyI", altKey: true }), "macos"),
      ).toBeNull();
    });

    it("does not let Caps Lock change a match", () => {
      // Caps Lock makes an uppercase key value with no Shift held.
      for (const platform of PLATFORMS) {
        expect(actionOf(press({ key: "I", code: "KeyI" }), platform)).toBe("markIn");
        expect(actionOf(press({ key: "O", code: "KeyO" }), platform)).toBe("markOut");
        expect(
          actionOf(press({ key: "Z", code: "KeyZ", ...primary(platform) }), platform),
        ).toBe("undo");
      }
    });

    it("matches a named key by event.key only", () => {
      const home: ShortcutKey = { kind: "named", key: "Home" };
      expect(matchesShortcutKey(home, { key: "Home", code: "Home" })).toBe(true);
      // The numpad 7 with Num Lock off reports Home.
      expect(matchesShortcutKey(home, { key: "Home", code: "Numpad7" })).toBe(true);
      // The numpad 7 with Num Lock on reports 7.
      expect(matchesShortcutKey(home, { key: "7", code: "Numpad7" })).toBe(false);
      expect(matchesShortcutKey(home, { key: "Unidentified", code: "Home" })).toBe(
        false,
      );
    });

    it("matches the comma by event.key when it is a printable ASCII character", () => {
      expect(matchesShortcutKey(comma, { key: ",", code: "Comma" })).toBe(true);
      // AZERTY puts the comma on the physical M key, and the physical comma key shows a
      // semicolon.
      expect(matchesShortcutKey(comma, { key: ",", code: "KeyM" })).toBe(true);
      expect(matchesShortcutKey(comma, { key: ";", code: "Comma" })).toBe(false);
    });

    it("falls back to event.code for the comma on a Cyrillic layout", () => {
      // The Russian layout puts б on the physical comma key.
      expect(matchesShortcutKey(comma, { key: "б", code: "Comma" })).toBe(true);
      for (const platform of PLATFORMS) {
        expect(
          actionOf(press({ key: "б", code: "Comma", ...primary(platform) }), platform),
        ).toBe("openSettings");
      }
    });

    it("does not match a letter from an ASCII punctuation value on another code", () => {
      expect(matchesShortcutKey(letterI, { key: ",", code: "KeyW" })).toBe(false);
    });

    it("does not match a letter key that types ASCII punctuation on the layout", () => {
      // A letter matches event.code only when event.key is not one printable ASCII
      // character. Dvorak types a period on the physical E key and a semicolon on the
      // physical Z key, so neither names its QWERTY letter. The Dvorak key that shows E (the
      // physical D key) names E.
      const letterE: ShortcutKey = { kind: "letter", letter: "E" };
      const letterZ: ShortcutKey = { kind: "letter", letter: "Z" };
      expect(matchesShortcutKey(letterE, { key: ".", code: "KeyE" })).toBe(false);
      expect(matchesShortcutKey(letterZ, { key: ";", code: "KeyZ" })).toBe(false);
      expect(matchesShortcutKey(letterE, { key: "e", code: "KeyD" })).toBe(true);

      for (const platform of PLATFORMS) {
        // primary + the Dvorak period does not export, and primary + the Dvorak semicolon
        // does not undo.
        expect(
          actionOf(press({ key: ".", code: "KeyE", ...primary(platform) }), platform),
        ).toBeNull();
        expect(
          actionOf(press({ key: ";", code: "KeyZ", ...primary(platform) }), platform),
        ).toBeNull();
        // Dvorak types a comma on the physical W key. The comma follows the layout, so that
        // key opens Settings.
        expect(
          actionOf(press({ key: ",", code: "KeyW", ...primary(platform) }), platform),
        ).toBe("openSettings");
        // The Dvorak keys that show E and Z still work.
        expect(
          actionOf(press({ key: "e", code: "KeyD", ...primary(platform) }), platform),
        ).toBe("export");
        expect(
          actionOf(press({ key: "z", code: "Slash", ...primary(platform) }), platform),
        ).toBe("undo");
      }
    });

    it("does not match a letter from a space on the letter position", () => {
      expect(matchesShortcutKey(letterI, { key: " ", code: "KeyI" })).toBe(false);
    });

    it("still falls back to event.code for a value that is not one ASCII character", () => {
      // A dead key, a non-Latin letter, and an unidentified key are not one printable ASCII
      // character, so the physical position decides.
      expect(matchesShortcutKey(letterI, { key: "Dead", code: "KeyI" })).toBe(true);
      expect(matchesShortcutKey(letterI, { key: "ш", code: "KeyI" })).toBe(true);
      expect(matchesShortcutKey(letterI, { key: "Unidentified", code: "KeyI" })).toBe(
        true,
      );
    });
  });

  describe("getShortcutPlatform", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("reports macos for a macOS user agent", () => {
      vi.stubGlobal("navigator", {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      });
      expect(getShortcutPlatform()).toBe("macos");
    });

    it("reports windows for a Windows user agent", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      });
      expect(getShortcutPlatform()).toBe("windows");
    });

    it("takes the Windows branch for Linux and for no navigator", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      });
      expect(getShortcutPlatform()).toBe("windows");
      vi.stubGlobal("navigator", undefined);
      expect(getShortcutPlatform()).toBe("windows");
    });
  });
});
