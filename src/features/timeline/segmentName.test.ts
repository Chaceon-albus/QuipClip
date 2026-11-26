import { describe, expect, it } from "vitest";
import {
  SEGMENT_NAME_MAX_LENGTH,
  isValidSegmentName,
  normalizeSegmentNameInput,
  removeSegmentNameForbiddenCharacters,
  segmentNameLength,
} from "./segmentName";
import nameCases from "./segmentNameCases.json";

interface NameCase {
  readonly name: string;
  readonly text?: string;
  readonly utf16?: readonly number[];
  readonly repeat?: number;
  readonly valid: boolean;
}

/** The text of a shared case, as the test of the Rust loader builds it too. */
function textOf(entry: NameCase): string {
  const base = entry.text ?? String.fromCharCode(...(entry.utf16 ?? []));
  return base.repeat(entry.repeat ?? 1);
}

const CASES: readonly NameCase[] = nameCases.cases;

describe("segment name rule (ADR 065)", () => {
  it("allows 80 characters", () => {
    expect(SEGMENT_NAME_MAX_LENGTH).toBe(80);
  });

  it("reads the shared samples", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(CASES.some((entry) => entry.valid)).toBe(true);
    expect(CASES.some((entry) => !entry.valid)).toBe(true);
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))(
    "judges the shared sample %s as the Rust loader does",
    (_name, entry) => {
      expect(isValidSegmentName(textOf(entry))).toBe(entry.valid);
    },
  );

  it("counts Unicode scalar values, so a character outside the BMP counts once", () => {
    expect(segmentNameLength("abc")).toBe(3);
    expect(segmentNameLength("\u{1f600}")).toBe(1);
    expect(segmentNameLength("\u{20000}")).toBe(1);
    expect("\u{1f600}".length).toBe(2);
  });
});

describe("normalizeSegmentNameInput (ADR 065)", () => {
  it("removes the White_Space characters at the two ends and keeps those inside", () => {
    expect(normalizeSegmentNameInput("  Intro  ")).toStrictEqual({
      kind: "name",
      name: "Intro",
    });
    expect(normalizeSegmentNameInput("Part  one")).toStrictEqual({
      kind: "name",
      name: "Part  one",
    });
    expect(normalizeSegmentNameInput("\u3000开场\u00a0")).toStrictEqual({
      kind: "name",
      name: "开场",
    });
    // U+FEFF is not White_Space, so the trim keeps it, as Rust does.
    expect(normalizeSegmentNameInput("\ufeffA")).toStrictEqual({
      kind: "name",
      name: "\ufeffA",
    });
  });

  it("removes each character that a name cannot have, before the trim", () => {
    expect(normalizeSegmentNameInput("a\tb\nc\u2028d\u2029e\u0000f")).toStrictEqual({
      kind: "name",
      name: "abcdef",
    });
    expect(normalizeSegmentNameInput("a\ud800b\udc00")).toStrictEqual({
      kind: "name",
      name: "ab",
    });
    // The removal comes first, so a space that a control character hid at an end goes too.
    expect(normalizeSegmentNameInput("\u0001 Intro \u0002")).toStrictEqual({
      kind: "name",
      name: "Intro",
    });
    // A paired surrogate is one character and stays.
    expect(normalizeSegmentNameInput("\u{1f600}")).toStrictEqual({
      kind: "name",
      name: "\u{1f600}",
    });
  });

  it("gives no name for empty text, and for text that the two steps empty", () => {
    expect(normalizeSegmentNameInput("")).toStrictEqual({ kind: "none" });
    expect(normalizeSegmentNameInput("   ")).toStrictEqual({ kind: "none" });
    expect(normalizeSegmentNameInput("\t\n\u0000\u3000")).toStrictEqual({
      kind: "none",
    });
  });

  it("refuses more than 80 characters after the two steps", () => {
    const longest = "a".repeat(SEGMENT_NAME_MAX_LENGTH);
    expect(normalizeSegmentNameInput(`  ${longest}  `)).toStrictEqual({
      kind: "name",
      name: longest,
    });
    expect(normalizeSegmentNameInput(`${longest}\t\t`)).toStrictEqual({
      kind: "name",
      name: longest,
    });
    expect(normalizeSegmentNameInput(`${longest}b`)).toStrictEqual({
      kind: "tooLong",
      length: 81,
    });
    expect(normalizeSegmentNameInput("\u{1f600}".repeat(81))).toStrictEqual({
      kind: "tooLong",
      length: 81,
    });
    // 80 characters outside the BMP are 160 UTF-16 code units, and still a name.
    const emoji = "\u{1f600}".repeat(80);
    expect(normalizeSegmentNameInput(emoji)).toStrictEqual({
      kind: "name",
      name: emoji,
    });
  });

  it("removes the forbidden characters and keeps every other one", () => {
    expect(removeSegmentNameForbiddenCharacters(" a\r\nb\t\u2028c\ud800 ")).toBe(
      " abc ",
    );
    expect(removeSegmentNameForbiddenCharacters("\u{1f600} x")).toBe("\u{1f600} x");
  });

  it("gives only valid names", () => {
    for (const text of [
      " a ",
      "\u0001 a",
      "a\u0085 ",
      "\u2028\u3000b\u2029",
      "x".repeat(80),
      "\ud800 y",
    ]) {
      const result = normalizeSegmentNameInput(text);
      if (result.kind === "name") {
        expect(isValidSegmentName(result.name)).toBe(true);
      }
    }
  });
});
