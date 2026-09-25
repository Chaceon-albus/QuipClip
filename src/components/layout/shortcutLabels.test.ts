import { describe, expect, it } from "vitest";
import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_BINDINGS,
  bindingAppliesToPlatform,
  type ShortcutBinding,
  type ShortcutPlatform,
} from "./shortcutBindings";
import {
  SHORTCUT_KEY_NAME_KEYS,
  ariaKeyShortcutsFor,
  chipShortcutsFor,
  formatAriaKeyShortcut,
  formatShortcut,
  resolveShortcutKeyNames,
  shortcutFor,
  shortcutsFor,
  type ShortcutKeyNames,
} from "./shortcutLabels";

const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows"];

/** Walks a dotted key through a catalog, the way i18next resolves it. */
function lookup(catalog: unknown, key: string): string {
  const value = key.split(".").reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === "object" && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, catalog);
  if (typeof value !== "string") {
    throw new Error(`missing catalog key ${key}`);
  }
  return value;
}

const EN_NAMES: ShortcutKeyNames = resolveShortcutKeyNames((key) => lookup(en, key));
const ZH_NAMES: ShortcutKeyNames = resolveShortcutKeyNames((key) => lookup(zhCN, key));

/** A stable name for a binding: its action, its key and its modifiers. */
function idOf(binding: ShortcutBinding): string {
  const key =
    binding.key.kind === "named"
      ? binding.key.key === " "
        ? "Space"
        : binding.key.key
      : binding.key.kind === "letter"
        ? binding.key.letter
        : binding.key.kind === "numpad"
          ? binding.key.code
          : binding.key.character;
  return [binding.action, ...binding.modifiers, key].join(":");
}

interface Row {
  readonly id: string;
  /** The chip on macOS, or null when the binding does not exist there. */
  readonly macos: string | null;
  readonly windows: string | null;
  readonly ariaMacos: string | null;
  readonly ariaWindows: string | null;
}

// One row for each binding of the table, in the English catalog.
const ROWS: readonly Row[] = [
  {
    id: "togglePlayback:Space",
    macos: "Space",
    windows: "Space",
    ariaMacos: "Space",
    ariaWindows: "Space",
  },
  { id: "playSegment:/", macos: "/", windows: "/", ariaMacos: "/", ariaWindows: "/" },
  {
    id: "stepBackOneFrame:ArrowLeft",
    macos: "←",
    windows: "←",
    ariaMacos: "ArrowLeft",
    ariaWindows: "ArrowLeft",
  },
  {
    id: "stepForwardOneFrame:ArrowRight",
    macos: "→",
    windows: "→",
    ariaMacos: "ArrowRight",
    ariaWindows: "ArrowRight",
  },
  {
    id: "stepBackTenFrames:shift:ArrowLeft",
    macos: "⇧←",
    windows: "Shift+←",
    ariaMacos: "Shift+ArrowLeft",
    ariaWindows: "Shift+ArrowLeft",
  },
  {
    id: "stepForwardTenFrames:shift:ArrowRight",
    macos: "⇧→",
    windows: "Shift+→",
    ariaMacos: "Shift+ArrowRight",
    ariaWindows: "Shift+ArrowRight",
  },
  {
    id: "goToStart:Home",
    macos: "Home",
    windows: "Home",
    ariaMacos: "Home",
    ariaWindows: "Home",
  },
  {
    id: "goToEnd:End",
    macos: "End",
    windows: "End",
    ariaMacos: "End",
    ariaWindows: "End",
  },
  { id: "markIn:I", macos: "I", windows: "I", ariaMacos: "I", ariaWindows: "I" },
  { id: "markOut:O", macos: "O", windows: "O", ariaMacos: "O", ariaWindows: "O" },
  {
    id: "goToSegmentIn:shift:I",
    macos: "⇧I",
    windows: "Shift+I",
    ariaMacos: "Shift+I",
    ariaWindows: "Shift+I",
  },
  {
    id: "goToSegmentOut:shift:O",
    macos: "⇧O",
    windows: "Shift+O",
    ariaMacos: "Shift+O",
    ariaWindows: "Shift+O",
  },
  {
    id: "deleteSegment:Delete",
    macos: "⌦",
    windows: "Delete",
    ariaMacos: "Delete",
    ariaWindows: "Delete",
  },
  {
    id: "deleteSegment:Backspace",
    macos: "⌫",
    windows: "Backspace",
    ariaMacos: "Backspace",
    ariaWindows: "Backspace",
  },
  {
    id: "finishSegment:Escape",
    macos: "Esc",
    windows: "Esc",
    ariaMacos: "Escape",
    ariaWindows: "Escape",
  },
  {
    id: "undo:primary:Z",
    macos: "⌘Z",
    windows: "Ctrl+Z",
    ariaMacos: "Meta+Z",
    ariaWindows: "Control+Z",
  },
  {
    id: "redo:primary:shift:Z",
    macos: "⇧⌘Z",
    windows: "Ctrl+Shift+Z",
    ariaMacos: "Meta+Shift+Z",
    ariaWindows: "Control+Shift+Z",
  },
  {
    id: "redo:primary:Y",
    macos: null,
    windows: "Ctrl+Y",
    ariaMacos: null,
    ariaWindows: "Control+Y",
  },
  {
    id: "openMedia:primary:O",
    macos: "⌘O",
    windows: "Ctrl+O",
    ariaMacos: "Meta+O",
    ariaWindows: "Control+O",
  },
  {
    id: "export:primary:E",
    macos: "⌘E",
    windows: "Ctrl+E",
    ariaMacos: "Meta+E",
    ariaWindows: "Control+E",
  },
  {
    id: "openSettings:primary:,",
    macos: "⌘,",
    windows: "Ctrl+,",
    ariaMacos: "Meta+,",
    ariaWindows: "Control+,",
  },
  { id: "zoomIn:=", macos: "=", windows: "=", ariaMacos: "=", ariaWindows: "=" },
  // The chip draws the hyphen-minus as the minus sign U+2212.
  {
    id: "zoomOut:-",
    macos: "−",
    windows: "−",
    ariaMacos: "-",
    ariaWindows: "-",
  },
  {
    id: "zoomIn:NumpadAdd",
    macos: "Num +",
    windows: "Num +",
    ariaMacos: "Plus",
    ariaWindows: "Plus",
  },
  {
    id: "zoomOut:NumpadSubtract",
    macos: "Num −",
    windows: "Num −",
    ariaMacos: "-",
    ariaWindows: "-",
  },
  {
    id: "zoomToFit:\\",
    macos: "\\",
    windows: "\\",
    ariaMacos: "\\",
    ariaWindows: "\\",
  },
  // The layout variants. No chip names them, because none is the first binding of its action,
  // and ariaKeyShortcutsFor leaves them out. The Windows form of Shift with + is `Shift++`.
  {
    id: "zoomIn:shift:=",
    macos: "⇧=",
    windows: "Shift+=",
    ariaMacos: "Shift+=",
    ariaWindows: "Shift+=",
  },
  { id: "zoomIn:+", macos: "+", windows: "+", ariaMacos: "Plus", ariaWindows: "Plus" },
  {
    id: "zoomIn:shift:+",
    macos: "⇧+",
    windows: "Shift++",
    ariaMacos: "Shift+Plus",
    ariaWindows: "Shift+Plus",
  },
  {
    id: "playSegment:shift:/",
    macos: "⇧/",
    windows: "Shift+/",
    ariaMacos: "Shift+/",
    ariaWindows: "Shift+/",
  },
  {
    id: "zoomToFit:shift:Z",
    macos: "⇧Z",
    windows: "Shift+Z",
    ariaMacos: "Shift+Z",
    ariaWindows: "Shift+Z",
  },
];

function rowOf(binding: ShortcutBinding): Row {
  const row = ROWS.find((candidate) => candidate.id === idOf(binding));
  if (row === undefined) {
    throw new Error(`no row for binding ${idOf(binding)}`);
  }
  return row;
}

describe("shortcutLabels", () => {
  describe("the rows", () => {
    // A new binding without a row, or a row whose binding was removed, fails here.
    it("hold exactly one row for each binding of the table", () => {
      const ids = SHORTCUT_BINDINGS.map(idOf);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toStrictEqual(ROWS.map((row) => row.id).sort());
    });
  });

  describe("formatShortcut", () => {
    for (const binding of SHORTCUT_BINDINGS) {
      const row = rowOf(binding);
      for (const platform of PLATFORMS) {
        const expected = platform === "macos" ? row.macos : row.windows;
        if (expected === null) {
          it(`has no ${row.id} binding on ${platform}`, () => {
            expect(bindingAppliesToPlatform(binding, platform)).toBe(false);
          });
          continue;
        }
        it(`formats ${row.id} as ${expected} on ${platform}`, () => {
          expect(bindingAppliesToPlatform(binding, platform)).toBe(true);
          expect(formatShortcut(binding, platform, EN_NAMES)).toBe(expected);
        });
      }
    }

    it("puts the macOS modifiers in the HIG order, Shift before Command", () => {
      const redo = shortcutFor("redo", "macos");
      expect(redo).not.toBeNull();
      if (redo === null) {
        return;
      }
      // The order is the same when the table lists the modifiers the other way round.
      const reversed: ShortcutBinding = {
        ...redo,
        modifiers: [...redo.modifiers].reverse(),
      };
      expect(formatShortcut(redo, "macos", EN_NAMES)).toBe("⇧⌘Z");
      expect(formatShortcut(reversed, "macos", EN_NAMES)).toBe("⇧⌘Z");
      expect(formatShortcut(reversed, "windows", EN_NAMES)).toBe("Ctrl+Shift+Z");
    });

    it("reads every word from the key names, and no symbol", () => {
      const names: ShortcutKeyNames = {
        space: "<space>",
        home: "<home>",
        end: "<end>",
        delete: "<delete>",
        backspace: "<backspace>",
        escape: "<escape>",
        ctrl: "<ctrl>",
        shift: "<shift>",
        numpad: "<numpad>",
      };
      const label = (
        action: Parameters<typeof shortcutFor>[0],
        platform: ShortcutPlatform,
      ) => {
        const binding = shortcutFor(action, platform);
        return binding === null ? null : formatShortcut(binding, platform, names);
      };
      expect(label("togglePlayback", "macos")).toBe("<space>");
      expect(label("goToStart", "macos")).toBe("<home>");
      expect(label("goToEnd", "windows")).toBe("<end>");
      expect(label("deleteSegment", "windows")).toBe("<delete>");
      expect(label("finishSegment", "macos")).toBe("<escape>");
      expect(label("redo", "windows")).toBe("<ctrl>+<shift>+Z");
      expect(label("stepBackTenFrames", "windows")).toBe("<shift>+←");
      // macOS draws the modifiers and the delete keys as symbols.
      expect(label("redo", "macos")).toBe("⇧⌘Z");
      expect(label("deleteSegment", "macos")).toBe("⌫");
      // The punctuation of the zoom keys is a symbol in every language.
      expect(label("zoomIn", "macos")).toBe("=");
      expect(label("zoomOut", "windows")).toBe("−");
      expect(label("zoomToFit", "windows")).toBe("\\");

      const numpadPlus = SHORTCUT_BINDINGS.find(
        (binding) => binding.key.kind === "numpad" && binding.key.code === "NumpadAdd",
      );
      expect(numpadPlus && formatShortcut(numpadPlus, "windows", names)).toBe(
        "<numpad> +",
      );
    });

    it("names the zoom keys = and − on the chips, not the numpad keys", () => {
      for (const platform of PLATFORMS) {
        const zoomIn = shortcutFor("zoomIn", platform);
        const zoomOut = shortcutFor("zoomOut", platform);
        const fit = shortcutFor("zoomToFit", platform);
        expect(zoomIn && formatShortcut(zoomIn, platform, EN_NAMES)).toBe("=");
        expect(zoomOut && formatShortcut(zoomOut, platform, EN_NAMES)).toBe("−");
        expect(fit && formatShortcut(fit, platform, EN_NAMES)).toBe("\\");
      }
    });

    it("uses the Simplified Chinese numpad word before the numpad symbol", () => {
      const numpadMinus = SHORTCUT_BINDINGS.find(
        (binding) =>
          binding.key.kind === "numpad" && binding.key.code === "NumpadSubtract",
      );
      expect(numpadMinus && formatShortcut(numpadMinus, "windows", ZH_NAMES)).toBe(
        "小键盘 −",
      );
    });

    it("uses the Simplified Chinese name of the space bar and keeps the key cap labels", () => {
      const space = shortcutFor("togglePlayback", "windows");
      const home = shortcutFor("goToStart", "windows");
      const escape = shortcutFor("finishSegment", "macos");
      const redo = shortcutFor("redo", "windows");
      expect(space && formatShortcut(space, "windows", ZH_NAMES)).toBe("空格");
      expect(space && formatShortcut(space, "macos", ZH_NAMES)).toBe("空格");
      expect(home && formatShortcut(home, "windows", ZH_NAMES)).toBe("Home");
      expect(escape && formatShortcut(escape, "macos", ZH_NAMES)).toBe("Esc");
      expect(redo && formatShortcut(redo, "windows", ZH_NAMES)).toBe("Ctrl+Shift+Z");
    });
  });

  describe("formatAriaKeyShortcut", () => {
    for (const binding of SHORTCUT_BINDINGS) {
      const row = rowOf(binding);
      for (const platform of PLATFORMS) {
        const expected = platform === "macos" ? row.ariaMacos : row.ariaWindows;
        if (expected === null) {
          continue;
        }
        it(`writes ${row.id} as ${expected} on ${platform}`, () => {
          expect(formatAriaKeyShortcut(binding, platform)).toBe(expected);
        });
      }
    }
  });

  describe("shortcutFor", () => {
    it("finds a binding for every action on both platforms", () => {
      for (const action of SHORTCUT_ACTIONS) {
        for (const platform of PLATFORMS) {
          const binding = shortcutFor(action, platform);
          expect(binding?.action).toBe(action);
          expect(binding && bindingAppliesToPlatform(binding, platform)).toBe(true);
        }
      }
    });

    it("names Backspace for Delete Segment on macOS, the key labelled delete on a Mac", () => {
      const binding = shortcutFor("deleteSegment", "macos");
      expect(binding?.key).toStrictEqual({ kind: "named", key: "Backspace" });
      expect(binding && formatShortcut(binding, "macos", EN_NAMES)).toBe("⌫");
    });

    it("names Delete for Delete Segment on Windows", () => {
      const binding = shortcutFor("deleteSegment", "windows");
      expect(binding?.key).toStrictEqual({ kind: "named", key: "Delete" });
      expect(binding && formatShortcut(binding, "windows", EN_NAMES)).toBe("Delete");
    });

    it("names Ctrl+Shift+Z for Redo on Windows, not Ctrl+Y", () => {
      const binding = shortcutFor("redo", "windows");
      expect(binding && formatShortcut(binding, "windows", EN_NAMES)).toBe(
        "Ctrl+Shift+Z",
      );
    });

    it("names the one-frame step for the step buttons, not the ten-frame step", () => {
      const back = shortcutFor("stepBackOneFrame", "windows");
      const forward = shortcutFor("stepForwardOneFrame", "macos");
      expect(back && formatShortcut(back, "windows", EN_NAMES)).toBe("←");
      expect(forward && formatShortcut(forward, "macos", EN_NAMES)).toBe("→");
    });

    it("returns the same binding as the first entry of shortcutsFor", () => {
      for (const action of SHORTCUT_ACTIONS) {
        for (const platform of PLATFORMS) {
          expect(shortcutFor(action, platform)).toBe(shortcutsFor(action, platform)[0]);
        }
      }
    });
  });

  describe("shortcutsFor", () => {
    it("returns every binding of the action on the platform, canonical first", () => {
      for (const action of SHORTCUT_ACTIONS) {
        for (const platform of PLATFORMS) {
          const expected = SHORTCUT_BINDINGS.filter(
            (binding) =>
              binding.action === action && bindingAppliesToPlatform(binding, platform),
          );
          expect(new Set(shortcutsFor(action, platform))).toStrictEqual(
            new Set(expected),
          );
        }
      }
    });
  });

  describe("ariaKeyShortcutsFor", () => {
    it("lists every binding of the action, canonical first, separated by spaces", () => {
      expect(ariaKeyShortcutsFor("redo", "windows")).toBe("Control+Shift+Z Control+Y");
      expect(ariaKeyShortcutsFor("redo", "macos")).toBe("Meta+Shift+Z");
      expect(ariaKeyShortcutsFor("deleteSegment", "macos")).toBe("Backspace Delete");
      expect(ariaKeyShortcutsFor("deleteSegment", "windows")).toBe("Delete Backspace");
      expect(ariaKeyShortcutsFor("zoomIn", "macos")).toBe("= Plus");
      expect(ariaKeyShortcutsFor("zoomIn", "windows")).toBe("= Plus");
    });

    it("lists a token once when two bindings share it, as the two minus keys do", () => {
      for (const platform of PLATFORMS) {
        expect(ariaKeyShortcutsFor("zoomOut", platform)).toBe("-");
      }
    });

    it("leaves the layout variants out, and keeps Shift+Z for Fit", () => {
      for (const platform of PLATFORMS) {
        // Not "= Plus Shift+= Shift+Plus": the variants name = and + again.
        expect(ariaKeyShortcutsFor("zoomIn", platform)).toBe("= Plus");
        expect(ariaKeyShortcutsFor("zoomToFit", platform)).toBe("\\ Shift+Z");
        // Not "/ Shift+/": the variant names / again, and the chip names / only.
        expect(ariaKeyShortcutsFor("playSegment", platform)).toBe("/");
        expect(
          chipShortcutsFor("playSegment", platform).map((b) => b.key),
        ).toStrictEqual([{ kind: "character", character: "/", code: "Slash" }]);
      }
      // Every binding that is not a variant appears.
      for (const action of SHORTCUT_ACTIONS) {
        for (const platform of PLATFORMS) {
          const tokens = ariaKeyShortcutsFor(action, platform)?.split(" ") ?? [];
          for (const binding of shortcutsFor(action, platform)) {
            if (binding.layoutVariant !== true) {
              expect(tokens).toContain(formatAriaKeyShortcut(binding, platform));
            }
          }
        }
      }
    });

    it("keeps the chip of Fit on \\, the first binding", () => {
      for (const platform of PLATFORMS) {
        const fit = shortcutFor("zoomToFit", platform);
        expect(fit && formatShortcut(fit, platform, EN_NAMES)).toBe("\\");
      }
    });
  });

  describe("chipShortcutsFor", () => {
    const chipsOf = (
      action: Parameters<typeof chipShortcutsFor>[0],
      platform: ShortcutPlatform,
    ) =>
      chipShortcutsFor(action, platform).map((binding) =>
        formatShortcut(binding, platform, EN_NAMES),
      );

    it("gives Fit two chips, \\ and Shift+Z, for a layout that needs AltGr or Option", () => {
      expect(chipsOf("zoomToFit", "macos")).toStrictEqual(["\\", "⇧Z"]);
      expect(chipsOf("zoomToFit", "windows")).toStrictEqual(["\\", "Shift+Z"]);
    });

    it("gives every other action the chip of its first binding only", () => {
      for (const action of SHORTCUT_ACTIONS) {
        if (action === "zoomToFit") {
          continue;
        }
        for (const platform of PLATFORMS) {
          expect(chipShortcutsFor(action, platform)).toStrictEqual([
            shortcutFor(action, platform),
          ]);
        }
      }
      // Zoom In keeps =, and its layout variants and the numpad key are no chips.
      expect(chipsOf("zoomIn", "windows")).toStrictEqual(["="]);
      expect(chipsOf("redo", "windows")).toStrictEqual(["Ctrl+Shift+Z"]);
    });

    it("lists one binding for an action with one binding", () => {
      expect(ariaKeyShortcutsFor("togglePlayback", "macos")).toBe("Space");
      expect(ariaKeyShortcutsFor("stepBackOneFrame", "windows")).toBe("ArrowLeft");
      expect(ariaKeyShortcutsFor("openSettings", "macos")).toBe("Meta+,");
      expect(ariaKeyShortcutsFor("export", "windows")).toBe("Control+E");
    });
  });

  describe("the key names in the catalogs", () => {
    it("exist and are not empty in both catalogs", () => {
      for (const key of Object.values(SHORTCUT_KEY_NAME_KEYS)) {
        expect(lookup(en, key)).not.toBe("");
        expect(lookup(zhCN, key)).not.toBe("");
      }
    });

    it("resolve to the English key cap labels", () => {
      expect(EN_NAMES).toStrictEqual({
        space: "Space",
        home: "Home",
        end: "End",
        delete: "Delete",
        backspace: "Backspace",
        escape: "Esc",
        ctrl: "Ctrl",
        shift: "Shift",
        numpad: "Num",
      });
    });

    it("localize only the space bar and the numpad word in Simplified Chinese", () => {
      expect(ZH_NAMES).toStrictEqual({ ...EN_NAMES, space: "空格", numpad: "小键盘" });
    });
  });
});
