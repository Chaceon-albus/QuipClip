import { describe, expect, it } from "vitest";
import { MAX_PRESET_NAME_CHARS } from "./limits";
import {
  fillNameSlot,
  fitContainedName,
  nextFreeCopyName,
  nextFreePresetName,
  PRESET_NAME_SLOT,
  splitGraphemes,
  type CopyNameForms,
} from "./presetNaming";

// The forms mirror the English catalog: `settings.preset.newName`,
// `settings.preset.newNameNumbered`, `settings.preset.copyName`, and
// `settings.preset.copyNameNumbered`. The module never calls the i18n runtime.
const NEW_BASE = "New Preset";
const newNumbered = (n: number) => `New Preset ${n}`;

const COPY_FORMS: CopyNameForms = {
  base: `${PRESET_NAME_SLOT} Copy`,
  numbered: (n) => `${PRESET_NAME_SLOT} Copy ${n}`,
};

// The Simplified Chinese forms, to show that the rule does not depend on the language.
const ZH_COPY_FORMS: CopyNameForms = {
  base: `${PRESET_NAME_SLOT} 副本`,
  numbered: (n) => `${PRESET_NAME_SLOT} 副本 ${n}`,
};

// Grapheme clusters of more than one code point, written as escapes so that no joiner is
// invisible in the source.
/** Man, woman, girl: five code points, with U+200D between the three emoji. */
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
/** The flag of Japan: two regional indicator symbols. */
const FLAG_JP = "\u{1F1EF}\u{1F1F5}";
/** Thumbs up with a medium skin tone modifier. */
const THUMBS_UP_MEDIUM = "\u{1F44D}\u{1F3FD}";
/** "e" and U+0301 COMBINING ACUTE ACCENT. */
const E_ACUTE_COMBINING = "e\u{301}";

describe("splitGraphemes", () => {
  it("keeps each cluster of more than one code point as one unit", () => {
    expect(
      splitGraphemes(`a${FAMILY}${FLAG_JP}${THUMBS_UP_MEDIUM}${E_ACUTE_COMBINING}`),
    ).toEqual(["a", FAMILY, FLAG_JP, THUMBS_UP_MEDIUM, E_ACUTE_COMBINING]);
  });

  it("splits by code point with no segmenter", () => {
    expect(splitGraphemes(`a${FLAG_JP}`, null)).toEqual([
      "a",
      "\u{1F1EF}",
      "\u{1F1F5}",
    ]);
  });
});

describe("PRESET_NAME_SLOT", () => {
  it("is one character from the private use area, with no brace for i18next to read", () => {
    expect([...PRESET_NAME_SLOT]).toHaveLength(1);
    const codePoint = PRESET_NAME_SLOT.codePointAt(0) ?? 0;
    expect(codePoint).toBeGreaterThanOrEqual(0xe000);
    expect(codePoint).toBeLessThanOrEqual(0xf8ff);
  });
});

describe("fillNameSlot", () => {
  it("puts the name in the slot", () => {
    expect(fillNameSlot(`${PRESET_NAME_SLOT} Copy 2`, "Main")).toBe("Main Copy 2");
  });

  it("keeps a name that holds placeholder or replacement-pattern text exactly", () => {
    for (const name of ["A {{n}}", "{{name}}", "$& $1 $$", `A ${PRESET_NAME_SLOT} B`]) {
      expect(fillNameSlot(`${PRESET_NAME_SLOT} Copy 2`, name)).toBe(`${name} Copy 2`);
    }
  });

  it("returns a form with no slot unchanged", () => {
    expect(fillNameSlot("Copy", "Main")).toBe("Copy");
  });
});

describe("nextFreePresetName", () => {
  it("returns the base form when no preset takes it", () => {
    expect(nextFreePresetName([], NEW_BASE, newNumbered)).toBe("New Preset");
    expect(nextFreePresetName(["H.264 MP4"], NEW_BASE, newNumbered)).toBe("New Preset");
  });

  it("returns the numbered form from 2 when the base form is taken", () => {
    expect(nextFreePresetName(["New Preset"], NEW_BASE, newNumbered)).toBe(
      "New Preset 2",
    );
  });

  it("returns the first free number and fills a gap", () => {
    expect(
      nextFreePresetName(
        ["New Preset", "New Preset 2", "New Preset 3"],
        NEW_BASE,
        newNumbered,
      ),
    ).toBe("New Preset 4");
    expect(
      nextFreePresetName(["New Preset", "New Preset 3"], NEW_BASE, newNumbered),
    ).toBe("New Preset 2");
  });

  it("returns the base form when only numbered forms are taken", () => {
    expect(
      nextFreePresetName(["New Preset 2", "New Preset 3"], NEW_BASE, newNumbered),
    ).toBe("New Preset");
  });

  it("compares case-sensitively", () => {
    expect(nextFreePresetName(["new preset"], NEW_BASE, newNumbered)).toBe(
      "New Preset",
    );
    expect(nextFreePresetName(["NEW PRESET"], NEW_BASE, newNumbered)).toBe(
      "New Preset",
    );
  });

  it("ignores the surrounding white space of a stored name", () => {
    expect(nextFreePresetName(["New Preset "], NEW_BASE, newNumbered)).toBe(
      "New Preset 2",
    );
    expect(
      nextFreePresetName(["  New Preset", "New Preset 2\t"], NEW_BASE, newNumbered),
    ).toBe("New Preset 3");
  });

  it("does not ignore white space inside a name", () => {
    expect(nextFreePresetName(["New  Preset"], NEW_BASE, newNumbered)).toBe(
      "New Preset",
    );
  });

  it("works with the Simplified Chinese forms", () => {
    expect(
      nextFreePresetName(["新预设", "新预设 2"], "新预设", (n) => `新预设 ${n}`),
    ).toBe("新预设 3");
  });

  it("reads each stored name once from any iterable", () => {
    const names = new Set(["New Preset"]);
    expect(nextFreePresetName(names.values(), NEW_BASE, newNumbered)).toBe(
      "New Preset 2",
    );
  });

  it("stops for a numbered form that ignores the number and returns a taken but valid name", () => {
    let calls = 0;
    const constant = () => {
      calls++;
      return "Stuck";
    };

    expect(nextFreePresetName(["New Preset", "Stuck"], NEW_BASE, constant)).toBe(
      "Stuck",
    );
    // Two distinct taken names allow at most three numbered tries.
    expect(calls).toBe(3);
  });

  it("finds a free name in a full library", () => {
    const names = [
      "New Preset",
      ...Array.from({ length: 99 }, (_, i) => newNumbered(i + 2)),
    ];

    expect(nextFreePresetName(names, NEW_BASE, newNumbered)).toBe("New Preset 101");
  });
});

describe("fitContainedName", () => {
  const copy = (name: string) => `${name} Copy`;

  it("returns the formatted name unchanged when it fits", () => {
    expect(fitContainedName(copy, "Main")).toBe("Main Copy");
    const exact = "a".repeat(MAX_PRESET_NAME_CHARS - " Copy".length);
    expect(fitContainedName(copy, exact)).toBe(`${exact} Copy`);
  });

  it("shortens the contained name so the result holds MAX_PRESET_NAME_CHARS", () => {
    const long = "a".repeat(MAX_PRESET_NAME_CHARS);
    const result = fitContainedName(copy, long);

    expect([...result].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(result.endsWith(" Copy")).toBe(true);
  });

  it("keeps the whole fixed text of a numbered form", () => {
    const long = "b".repeat(MAX_PRESET_NAME_CHARS);
    const result = fitContainedName((name) => `${name} Copy 12`, long);

    expect([...result].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(result.endsWith(" Copy 12")).toBe(true);
  });

  it("counts code points and never splits a surrogate pair", () => {
    // Each emoji is one code point and two UTF-16 code units.
    const long = "😀".repeat(MAX_PRESET_NAME_CHARS);
    const result = fitContainedName(copy, long);

    expect([...result].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(result).toBe(`${"😀".repeat(MAX_PRESET_NAME_CHARS - 5)} Copy`);
  });

  // Each cluster is one character on screen and more than one code point. A cut by code point
  // would keep only the first part of it.
  it.each([
    ["an emoji sequence joined with U+200D", FAMILY],
    ["a flag", FLAG_JP],
    ["an emoji with a skin tone", THUMBS_UP_MEDIUM],
    ["a letter with a combining accent", E_ACUTE_COMBINING],
  ])("removes %s at the cut point whole", (_label, cluster) => {
    const clusterLength = [...cluster].length;
    // The result is one code point too long, and the cluster holds the last code points.
    const kept = "a".repeat(MAX_PRESET_NAME_CHARS - " Copy".length + 1 - clusterLength);
    const result = fitContainedName(copy, `${kept}${cluster}`);

    expect(result).toBe(`${kept} Copy`);
    expect([...result].length).toBeLessThanOrEqual(MAX_PRESET_NAME_CHARS);
  });

  it("keeps a cluster that fits", () => {
    const kept = "a".repeat(
      MAX_PRESET_NAME_CHARS - " Copy".length - [...FAMILY].length,
    );

    expect(fitContainedName(copy, `${kept}${FAMILY}`)).toBe(`${kept}${FAMILY} Copy`);
  });

  it("keeps a cluster before the cut point and removes only the end", () => {
    const result = fitContainedName(
      copy,
      `${FLAG_JP}${"a".repeat(MAX_PRESET_NAME_CHARS)}`,
    );

    expect(result.startsWith(FLAG_JP)).toBe(true);
    expect(result.endsWith("a Copy")).toBe(true);
    expect([...result].length).toBe(MAX_PRESET_NAME_CHARS);
  });

  it("cuts by code point with no segmenter, as in an older web view", () => {
    const kept = "a".repeat(
      MAX_PRESET_NAME_CHARS - " Copy".length + 1 - [...FAMILY].length,
    );
    const result = fitContainedName(
      copy,
      `${kept}${FAMILY}`,
      MAX_PRESET_NAME_CHARS,
      null,
    );

    expect([...result].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(result).toBe(`${kept}${[...FAMILY].slice(0, -1).join("")} Copy`);
  });

  it("removes white space that the cut leaves at the end of the contained name", () => {
    // The cut keeps "abc " of "abc def", and the trailing space goes too.
    const result = fitContainedName(copy, "abc def", "abc  Copy".length);

    expect(result).toBe("abc Copy");
  });

  it("returns the fixed text alone when it is longer than the limit", () => {
    expect(fitContainedName(copy, "Main", 3)).toBe(" Copy");
  });
});

describe("nextFreeCopyName", () => {
  it("names the first copy with the base form", () => {
    expect(nextFreeCopyName(["Main"], "Main", COPY_FORMS)).toBe("Main Copy");
  });

  it("numbers the copy when the base form is taken", () => {
    expect(nextFreeCopyName(["Main", "Main Copy"], "Main", COPY_FORMS)).toBe(
      "Main Copy 2",
    );
    expect(
      nextFreeCopyName(["Main", "Main Copy", "Main Copy 2"], "Main", COPY_FORMS),
    ).toBe("Main Copy 3");
  });

  it("names a copy of a copy from the full source name", () => {
    expect(nextFreeCopyName(["Main", "Main Copy"], "Main Copy", COPY_FORMS)).toBe(
      "Main Copy Copy",
    );
  });

  it("removes the surrounding white space of the source name", () => {
    expect(nextFreeCopyName([" Main "], " Main ", COPY_FORMS)).toBe("Main Copy");
  });

  it("keeps a source name that holds placeholder text exactly", () => {
    expect(nextFreeCopyName(["A {{n}}"], "A {{n}}", COPY_FORMS)).toBe("A {{n}} Copy");
    expect(nextFreeCopyName(["A {{n}}", "A {{n}} Copy"], "A {{n}}", COPY_FORMS)).toBe(
      "A {{n}} Copy 2",
    );
  });

  it("works with the Simplified Chinese forms", () => {
    expect(nextFreeCopyName(["主预设", "主预设 副本"], "主预设", ZH_COPY_FORMS)).toBe(
      "主预设 副本 2",
    );
  });

  it("never splits a flag at the end of a long source name", () => {
    // 114 letters and a flag of two code points: the copy form is one code point too long.
    const name = `${"x".repeat(114)}${FLAG_JP}`;

    expect(nextFreeCopyName([name], name, COPY_FORMS)).toBe(`${"x".repeat(114)} Copy`);
  });

  it("fits a copy of a long name into MAX_PRESET_NAME_CHARS", () => {
    const long = "x".repeat(MAX_PRESET_NAME_CHARS);
    const first = nextFreeCopyName([long], long, COPY_FORMS);

    expect([...first].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(first.endsWith(" Copy")).toBe(true);

    const second = nextFreeCopyName([long, first], long, COPY_FORMS);
    expect([...second].length).toBe(MAX_PRESET_NAME_CHARS);
    expect(second.endsWith(" Copy 2")).toBe(true);
  });
});
