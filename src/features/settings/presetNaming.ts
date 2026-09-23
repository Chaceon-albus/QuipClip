/**
 * Pure rules that choose the name of a preset the application creates: a new preset from Add,
 * or a copy from Duplicate.
 *
 * A preset name is user data (ADR 013). The application writes a catalog name once, when it
 * creates the preset, and never translates it again. Each form is one complete catalog
 * message, such as "New Preset {{n}}" or "{{name}} Copy {{n}}". The caller formats the forms,
 * and this module only chooses which form to write, so no name is assembled from fragments
 * (ADR 011). The module has no i18n runtime, so the tests pass plain strings and functions.
 *
 * NAME COMPARISON. Two names are the same when they are equal after the surrounding white
 * space is removed from both. The comparison is case-sensitive. The validator trims a name
 * before it checks it, and the preset list does not show the surrounding white space, so
 * "New Preset " and "New Preset" look the same in the list. "new preset" looks different, so
 * it does not take the name "New Preset".
 */

import { MAX_PRESET_NAME_CHARS } from "./limits";

/**
 * The value that the caller gives for `{{name}}` when it formats a copy form. This module
 * then puts the source name where the slot is.
 *
 * The source name must not go through i18next interpolation. i18next replaces each
 * placeholder by a search for its first occurrence in the partly formatted string. When the
 * source name holds the text "{{n}}", the number then goes into the name and not into the
 * form: "A {{n}}" gives "A 2 Copy {{n}}" and not "A {{n}} Copy 2". The slot is one character
 * from the Unicode private use area. It holds no brace, so i18next does not change it, and no
 * catalog message holds it. It can occur in a source name, but that does no harm: this module
 * looks for the slot only in the formatted form, never in the name.
 */
export const PRESET_NAME_SLOT = "\uE000";

/** The catalog forms of the name of a new preset. */
export type PresetNameForms = {
  /** The form with no number, such as "New Preset". */
  readonly base: string;
  /** The form with the number `n`, such as "New Preset 2". `n` starts at 2. */
  readonly numbered: (n: number) => string;
};

/**
 * The catalog forms of the name of a copy, formatted with `PRESET_NAME_SLOT` as the value of
 * `{{name}}`.
 */
export type CopyNameForms = {
  /** The form with no number, such as "<slot> Copy" for "Main Copy". */
  readonly base: string;
  /** The form with the number `n`, such as "<slot> Copy 2" for "Main Copy 2". `n` starts at 2. */
  readonly numbered: (n: number) => string;
};

/** Counts Unicode code points, as the validator and Rust `chars().count()` do. */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Puts `name` in each `PRESET_NAME_SLOT` of `form`. `split` and `join` read neither string as
 * a pattern, so a "$&" or a "{{n}}" in the name stays as it is.
 */
export function fillNameSlot(form: string, name: string): string {
  return form.split(PRESET_NAME_SLOT).join(name);
}

/**
 * Returns the first name in the sequence `base`, `numbered(2)`, `numbered(3)`, ... that no
 * name in `existingNames` takes. See the module comment for the comparison rule.
 *
 * The returned name is the form exactly as the caller formatted it.
 *
 * The search tries at most one numbered form more than the count of distinct taken names.
 * When `numbered` gives a different name for each `n`, one of those forms is always free.
 * The bound also ends the search for a catalog form that ignores `n`: the function then
 * returns the last form it tried. That name is taken, but it is still a valid name, because
 * two presets can have the same name (ADR 013).
 */
export function nextFreePresetName(
  existingNames: Iterable<string>,
  base: string,
  numbered: (n: number) => string,
): string {
  const taken = new Set<string>();
  for (const name of existingNames) {
    taken.add(name.trim());
  }
  if (!taken.has(base.trim())) {
    return base;
  }
  let candidate = base;
  for (let n = 2; n <= taken.size + 2; n++) {
    candidate = numbered(n);
    if (!taken.has(candidate.trim())) {
      return candidate;
    }
  }
  return candidate;
}

/**
 * The part of `Intl.Segmenter` that this module uses. The project compiles against the
 * ES2021 library, which has no type for it.
 */
export interface GraphemeSegmenter {
  segment(input: string): Iterable<{ readonly segment: string }>;
}

type GraphemeSegmenterConstructor = new (
  locales: undefined,
  options: { readonly granularity: "grapheme" },
) => GraphemeSegmenter;

/**
 * The segmenter of the web view, or null when the web view has no `Intl.Segmenter`. Grapheme
 * boundaries do not depend on the language, so the segmenter takes no locale.
 */
const DEFAULT_GRAPHEME_SEGMENTER: GraphemeSegmenter | null = (() => {
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor })
    .Segmenter;
  return typeof Segmenter === "function"
    ? new Segmenter(undefined, { granularity: "grapheme" })
    : null;
})();

/**
 * Splits `text` into grapheme clusters: the units that a reader sees as one character. An
 * emoji joined with U+200D, a flag, an emoji with a skin tone, and a letter with a combining
 * accent are each one cluster of more than one code point.
 *
 * With no segmenter, as in an older web view, each code point is one unit. A cut then keeps
 * surrogate pairs whole but can split a cluster.
 */
export function splitGraphemes(
  text: string,
  segmenter: GraphemeSegmenter | null = DEFAULT_GRAPHEME_SEGMENTER,
): string[] {
  if (segmenter === null) {
    return [...text];
  }
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * Formats a name that contains another name, and shortens the contained name until the
 * result holds at most `max` code points after the trim that the validator applies.
 *
 * A copy of a preset with a long name would otherwise exceed `MAX_PRESET_NAME_CHARS`, and the
 * save of the copy would fail. The fixed text of the form, such as " Copy 2", stays complete.
 *
 * The limit counts code points, as the validator and Rust do. The cut removes whole grapheme
 * clusters from the end of the contained name (see `splitGraphemes`) until it has removed at
 * least the excess code points, and then removes the trailing white space. A cluster is never
 * split, so the result can hold a few code points less than `max`.
 *
 * When the fixed text alone is longer than `max`, the contained name becomes empty and the
 * result is still too long. No catalog form comes near that length.
 */
export function fitContainedName(
  format: (name: string) => string,
  name: string,
  max: number = MAX_PRESET_NAME_CHARS,
  segmenter: GraphemeSegmenter | null = DEFAULT_GRAPHEME_SEGMENTER,
): string {
  let graphemes = splitGraphemes(name, segmenter);
  let candidate = format(name);
  while (graphemes.length > 0) {
    let excess = codePointLength(candidate.trim()) - max;
    if (excess <= 0) {
      return candidate;
    }
    while (excess > 0) {
      const removed = graphemes.pop();
      if (removed === undefined) {
        break;
      }
      excess -= codePointLength(removed);
    }
    const shortened = graphemes.join("").trimEnd();
    graphemes = splitGraphemes(shortened, segmenter);
    candidate = format(shortened);
  }
  return candidate;
}

/**
 * Returns the name of a copy of the preset named `sourceName`: the first free name in the
 * sequence of copy forms (see `nextFreePresetName`), with the source name in the slot of each
 * form.
 *
 * The surrounding white space of `sourceName` is removed first, so a copy of " Main " is
 * "Main Copy". Each form is fitted into `MAX_PRESET_NAME_CHARS` (see `fitContainedName`).
 */
export function nextFreeCopyName(
  existingNames: Iterable<string>,
  sourceName: string,
  forms: CopyNameForms,
): string {
  const name = sourceName.trim();
  const fit = (form: string) =>
    fitContainedName((contained) => fillNameSlot(form, contained), name);
  return nextFreePresetName(existingNames, fit(forms.base), (n) =>
    fit(forms.numbered(n)),
  );
}
