/**
 * The default names that the save dialog of an export proposes (ADR 024, ADR 067).
 *
 * The name is only a proposal. The user can change it, and the save dialog asks before it
 * replaces a file.
 *
 * The module has no React dependency.
 */

/** The longest file name, in bytes of UTF-8, that a name with a name part can have. */
export const SEGMENT_FILE_NAME_MAX_BYTES = 200;

/** The characters that a file name of Windows or macOS cannot hold, or that separate a path. */
const SEPARATOR_CHARACTERS = /[\\/:*?"<>|]/gu;

/** Each control character (`Cc`). */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** Spaces and full stops at the end of a text. */
const TRAILING_SPACES_AND_STOPS = /[ .]+$/u;

const encoder = new TextEncoder();

/** The number of bytes of `text` in UTF-8. */
function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** The name of a file without its extension, as the name of the whole export removes it. */
export function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "");
}

/** The name of the whole export: `<source name>_export.<extension>` (ADR 024). */
export function exportFileName(sourceFileName: string, extension: string): string {
  return `${stripFileExtension(sourceFileName)}_export.${extension}`;
}

/** The facts of the name of an export of one segment. */
export interface SegmentFileNameInput {
  /** The name of the file that the first piece of the segment reads, with its extension. */
  readonly sourceFileName: string;
  /** The number of the segment among all the segments of the export, from 1 (ADR 066). */
  readonly number: number;
  /** The name of the segment (ADR 065), or undefined for a segment with no name. */
  readonly name: string | undefined;
  /** The extension of the output, without the full stop. */
  readonly extension: string;
}

/**
 * The longest start of `text` whose length in UTF-8 is at most `maxBytes`. The cut is at a
 * character (a Unicode scalar value), so it never splits a character.
 */
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const length = utf8Length(character);
    if (bytes + length > maxBytes) {
      break;
    }
    bytes += length;
    result += character;
  }
  return result;
}

/**
 * The name that the save dialog proposes for an export of exactly one segment (ADR 067):
 *
 * - `<source name>_<number>.<extension>`
 * - `<source name>_<number> <name>.<extension>`
 *
 * `<source name>` is the name of the source file without its extension, not changed.
 * `<number>` has a leading zero below 10. `<name>` is the name of the segment with each of
 * `\ / : * ? " < > |` and each control character changed to `_`, then cut at the end, at a
 * character, so that the whole file name has no more than 200 bytes in UTF-8, then with the
 * spaces and full stops at its end removed.
 *
 * The name has no name part, and no space in front of it, when the segment has no name, when the
 * name part is empty after the changes, or when the name without a name part has 200 bytes or
 * more already.
 */
export function segmentFileName(input: SegmentFileNameInput): string {
  const number = input.number < 10 ? `0${String(input.number)}` : String(input.number);
  const stem = `${stripFileExtension(input.sourceFileName)}_${number}`;
  const extension = `.${input.extension}`;
  const bare = `${stem}${extension}`;
  if (input.name === undefined) {
    return bare;
  }
  const bareBytes = utf8Length(bare);
  if (bareBytes >= SEGMENT_FILE_NAME_MAX_BYTES) {
    return bare;
  }
  const replaced = input.name
    .replace(SEPARATOR_CHARACTERS, "_")
    .replace(CONTROL_CHARACTERS, "_");
  // One byte goes to the space in front of the name part.
  const budget = SEGMENT_FILE_NAME_MAX_BYTES - bareBytes - 1;
  const part = cutToBytes(replaced, Math.max(budget, 0)).replace(
    TRAILING_SPACES_AND_STOPS,
    "",
  );
  return part.length === 0 ? bare : `${stem} ${part}${extension}`;
}
