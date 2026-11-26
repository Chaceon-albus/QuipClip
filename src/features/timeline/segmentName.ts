/**
 * The rule of the name of a segment (ADR 065).
 *
 * A name is valid when all of these conditions are true:
 *
 * - It has 1 to 80 characters. A character is one Unicode scalar value, so a letter outside the
 *   Basic Multilingual Plane counts as one. JavaScript counts a string in UTF-16 code units, so
 *   the rule never reads `String.prototype.length`. The Rust loader counts with `str::chars`.
 * - Its first character and its last character do not have the Unicode property `White_Space`.
 *   That is the set of `char::is_whitespace` of Rust. `String.prototype.trim` removes another
 *   set (it also removes U+FEFF), so the rule does not use it.
 * - It has no control character (the general category `Cc`, which includes the tab and each line
 *   break), no U+2028 and no U+2029.
 * - It has no surrogate without its pair. A Rust string cannot hold one.
 *
 * `src-tauri/src/project/mod.rs` applies the same rule to a project file, and both test files run
 * the shared samples of `segmentNameCases.json`, so the two rules cannot drift.
 *
 * The module has no React, DOM or store dependency.
 */

/** The largest number of characters (Unicode scalar values) in a name. */
export const SEGMENT_NAME_MAX_LENGTH = 80;

/**
 * Each character that a name cannot have: a `Cc` character, U+2028, U+2029, and a surrogate
 * without its pair. With the `u` flag a paired surrogate is one code point, so `\p{Cs}` matches
 * only a lone surrogate.
 */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cs}\u2028\u2029]/gu;

/** One character that a name cannot have, for a test. */
const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cs}\u2028\u2029]/u;

/** The `White_Space` characters at the start and at the end of a text. */
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** A `White_Space` character at the start or at the end of a text, for a test. */
const WHITE_SPACE_AT_EDGE = /^\p{White_Space}|\p{White_Space}$/u;

/** The number of characters (Unicode scalar values) of a text. A lone surrogate counts as one. */
export function segmentNameLength(text: string): number {
  // The string iterator walks code points.
  return Array.from(text).length;
}

/**
 * Removes each character that a name cannot have: a `Cc` character (the tab and each line break
 * among them), U+2028, U+2029 and a lone surrogate. The first step of the rename dialog, which a
 * paste into its field applies too.
 */
export function removeSegmentNameForbiddenCharacters(text: string): string {
  return text.replace(FORBIDDEN_CHARACTERS, "");
}

/** True when the value is a valid name by the rule of ADR 065. */
export function isValidSegmentName(value: string): boolean {
  const length = segmentNameLength(value);
  return (
    length >= 1 &&
    length <= SEGMENT_NAME_MAX_LENGTH &&
    !WHITE_SPACE_AT_EDGE.test(value) &&
    !FORBIDDEN_CHARACTER.test(value)
  );
}

/**
 * What the text of the rename field gives the segment (`normalizeSegmentNameInput`).
 *
 * - `name`: a valid name.
 * - `none`: no name. The rename removes the name.
 * - `tooLong`: the text has more than `SEGMENT_NAME_MAX_LENGTH` characters after the two steps.
 *   The confirm does nothing, and the dialog says why. `length` is the number of characters.
 */
export type SegmentNameInput =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "none" }
  | { readonly kind: "tooLong"; readonly length: number };

/**
 * The two steps of the rename dialog at the confirm (ADR 065): it removes each character that a
 * name cannot have, and then the `White_Space` characters at the two ends. Text that is then empty
 * gives no name. Text that then has more than 80 characters gives no result.
 *
 * Each `name` result is valid (`isValidSegmentName`), because the removal comes before the trim.
 */
export function normalizeSegmentNameInput(text: string): SegmentNameInput {
  const cleaned = removeSegmentNameForbiddenCharacters(text).replace(
    EDGE_WHITE_SPACE,
    "",
  );
  if (cleaned === "") {
    return { kind: "none" };
  }
  const length = segmentNameLength(cleaned);
  if (length > SEGMENT_NAME_MAX_LENGTH) {
    return { kind: "tooLong", length };
  }
  return { kind: "name", name: cleaned };
}
