/**
 * The ffmpeg-syntax text of the encoder options of a preset: the canonical text the preset
 * editor shows, and the import of a text that a user typed or pasted.
 *
 * The text is how people write ffmpeg options in a terminal, so the import reads the quoting
 * and the line continuations of the shells that people copy from: bash, `cmd.exe`, and
 * PowerShell. It reads them here, in the interface, and nowhere else. Rust never reads a shell
 * syntax: it receives the two option lists as data, and it writes each option as two process
 * arguments with no shell in between.
 *
 * Pure module with no React and no i18next dependencies. Each issue carries a code, the line
 * and the column where it starts, and the values its message needs, so the presenter can show
 * the issue under the text with a complete message (ADR 011).
 */

import {
  isDeniedOptionName,
  isValidOptionName,
  isValidOptionValue,
  MAX_OPTION_VALUE_CHARS,
  MAX_PRESET_OPTION_BYTES,
  MAX_PRESET_OPTIONS,
  optionFlag,
  renderedOptionBytes,
  type OptionStream,
} from "./limits";
import { withAudioEncoder } from "./presetDocument";
import type { Preset, PresetAudioChannels, PresetOption, QualityKind } from "./types";

/** A place in the text: the line and the column, both counted from 1. */
export type TextPosition = {
  line: number;
  column: number;
};

/** Why an import refused the text. */
export type OptionSyntaxErrorCode =
  | "unterminatedQuote"
  | "curlyQuote"
  | "unexpectedValue"
  | "missingValue"
  | "streamSpecifier"
  | "optionName"
  | "optionDenied"
  | "optionDuplicate"
  | "optionValue"
  | "integerValue"
  | "bitrateValue"
  | "channelsValue"
  | "qualityConflict"
  | "zeroBitrate"
  | "tooManyOptions"
  | "optionsTooLong";

/** One reason the import refused the text, at the place where it starts. */
export type OptionSyntaxError = TextPosition & {
  code: OptionSyntaxErrorCode;
  values?: Record<string, string | number>;
};

/** Something the import changed beyond a plain copy of the text into the option lists. */
export type OptionSyntaxNote =
  /** `-b:v 0` with the cq kind: the kind writes it itself. */
  | { code: "zeroBitrateCq" }
  /** `-b:v 0` with crf or qualityScale: the encoder needs no bitrate there. */
  | { code: "zeroBitrateConstant" }
  /** These flags of the text went into fields of the preset, in their order in the text. */
  | { code: "movedToFields"; flags: string[] };

/** The outcome of `importOptionsText`. */
export type OptionImportResult =
  | { ok: true; preset: Preset; notes: OptionSyntaxNote[] }
  | { ok: false; errors: OptionSyntaxError[] };

/** One word of the text after the shell rules: quotes removed, continuations joined. */
type Token = {
  value: string;
  /** The index in the text of the first character of the word. */
  start: number;
  /** True when the first character of the word came from inside quotes. */
  quoted: boolean;
};

/** The characters that end a line in bash (`\`), `cmd.exe` (`^`), and PowerShell (`` ` ``). */
const CONTINUATION_CHARACTERS = new Set(["\\", "^", "`"]);

/**
 * Returns a function that converts an index of `text` into the line and the column of that
 * character. It finds the line by a binary search over the line starts, so a long pasted text
 * costs one pass, not one pass for each word.
 */
function positionsOf(text: string): (index: number) => TextPosition {
  const lineStarts = [0];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "\n") {
      lineStarts.push(at + 1);
    }
  }
  return (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= index) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: index - lineStarts[low] + 1 };
  };
}

/**
 * Answers whether the character at `index` is a line continuation: a continuation character
 * with only spaces or tabs after it on its line. Returns the index after the end of the line,
 * or -1. A continuation on the last line of the text ends the text.
 */
function continuationEnd(text: string, index: number): number {
  if (!CONTINUATION_CHARACTERS.has(text[index])) {
    return -1;
  }
  let at = index + 1;
  while (
    at < text.length &&
    (text[at] === " " || text[at] === "\t" || text[at] === "\r")
  ) {
    at++;
  }
  if (at === text.length) {
    return at;
  }
  return text[at] === "\n" ? at + 1 : -1;
}

/**
 * Splits `text` into words with the rules the shells share:
 *
 * - Spaces, tabs, and line breaks separate words.
 * - `\`, `^`, or `` ` `` with nothing after it on its line continues the line. The character
 *   and the line break are removed, so the text reads as one line.
 * - In double quotes, `\"` is a quote and `\\` is a backslash. Every other character is itself.
 * - In single quotes, every character is itself.
 * - Quoted and unquoted parts with no space between them make one word.
 * - Outside quotes, every other character is itself, so a Windows path keeps its backslashes.
 *
 * A quote must end on its line. A quote that does not is an `unterminatedQuote` error at the
 * quote, and the split goes on at the next line. The text of the quote still makes a word, so
 * the flag in front of it does not report a missing value as a second error.
 */
function tokenize(
  text: string,
  positionAt: (index: number) => TextPosition,
): { tokens: Token[]; errors: OptionSyntaxError[] } {
  const tokens: Token[] = [];
  const errors: OptionSyntaxError[] = [];
  let at = 0;
  let current: Token | null = null;

  const finish = () => {
    if (current !== null) {
      tokens.push(current);
      current = null;
    }
  };

  while (at < text.length) {
    const character = text[at];
    const continued = continuationEnd(text, at);
    if (continued !== -1) {
      at = continued;
      continue;
    }
    if (
      character === " " ||
      character === "\t" ||
      character === "\r" ||
      character === "\n"
    ) {
      finish();
      at++;
      continue;
    }
    if (character === '"' || character === "'") {
      const quoteStart = at;
      let value = "";
      at++;
      let closed = false;
      while (at < text.length && text[at] !== "\n") {
        if (text[at] === character) {
          closed = true;
          at++;
          break;
        }
        if (
          character === '"' &&
          text[at] === "\\" &&
          (text[at + 1] === '"' || text[at + 1] === "\\")
        ) {
          value += text[at + 1];
          at += 2;
          continue;
        }
        value += text[at];
        at++;
      }
      if (!closed) {
        errors.push({ code: "unterminatedQuote", ...positionAt(quoteStart) });
      }
      if (current === null) {
        current = { value, start: quoteStart, quoted: true };
      } else {
        current.value += value;
      }
      continue;
    }
    // A curly quote, as a word processor or a web page writes it, is no quote to ffmpeg. Read
    // as a character, it would reach the encoder inside the value: libx264 then drops the
    // first and the last entry of a parameter string with a warning that the export hides.
    if (CURLY_QUOTES.has(character)) {
      errors.push({ code: "curlyQuote", ...positionAt(at) });
    }
    if (current === null) {
      current = { value: character, start: at, quoted: false };
    } else {
      current.value += character;
    }
    at++;
  }
  finish();
  return { tokens, errors };
}

/** The curly quotes that pasted text often holds in place of `"` and `'`. */
const CURLY_QUOTES = new Set(["\u201C", "\u201D", "\u2018", "\u2019"]);

/** A negative number, such as `-1` or `-0.5`: a value, not an option. */
const NEGATIVE_NUMBER = /^-(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Answers whether a word names an option: it starts with `-`, it is not a negative number,
 * and its first character did not come from quotes. A quoted word is always a value, so
 * `"-x"` is the value `-x`.
 */
function isOptionToken(token: Token): boolean {
  return (
    !token.quoted &&
    token.value.startsWith("-") &&
    token.value.length > 1 &&
    !NEGATIVE_NUMBER.test(token.value)
  );
}

/** The preset fields that the import fills from a flag of the text. */
type ManagedField =
  | "videoEncoder"
  | "audioEncoder"
  | "crf"
  | "cq"
  | "qualityScale"
  | "videoBitrate"
  | "audioBitrate"
  | "audioSampleRate"
  | "audioChannels"
  | "pixelFormat";

/**
 * The flags the import moves into preset fields, keyed by the flag without its leading `-`.
 * A flag of these names with another stream specifier is no managed flag, and the deny list
 * then refuses it. A `Map`, so that no text can reach a property of `Object.prototype`.
 */
const MANAGED_FLAGS: ReadonlyMap<string, ManagedField> = new Map([
  ["c:v", "videoEncoder"],
  ["c:a", "audioEncoder"],
  ["crf", "crf"],
  ["crf:v", "crf"],
  ["cq", "cq"],
  ["cq:v", "cq"],
  ["q:v", "qualityScale"],
  ["b:v", "videoBitrate"],
  ["b:a", "audioBitrate"],
  ["ar", "audioSampleRate"],
  ["ar:a", "audioSampleRate"],
  ["ac", "audioChannels"],
  ["ac:a", "audioChannels"],
  ["pix_fmt", "pixelFormat"],
  ["pix_fmt:v", "pixelFormat"],
]);

/** The quality kind that each quality flag sets. */
const QUALITY_FIELDS: Partial<Record<ManagedField, QualityKind>> = {
  crf: "crf",
  cq: "cq",
  qualityScale: "qualityScale",
  videoBitrate: "bitrate",
};

/** One managed flag of the text, with its value and the place of the flag. */
type ManagedValue = TextPosition & {
  field: ManagedField;
  flag: string;
  value: string;
};

/** One option of the text, with the place of its flag. */
type PlacedOption = TextPosition & {
  stream: OptionStream;
  option: PresetOption;
};

/**
 * Parses a bitrate as ffmpeg writes it, `8000k`, `24M`, or a number of bits per second, into
 * kilobits per second. Returns null for any other text, and for a value that is not a whole
 * number of kilobits per second.
 */
function parseKilobits(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value);
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  const suffix = match[2].toLowerCase();
  const kilobits =
    suffix === "m" ? amount * 1000 : suffix === "k" ? amount : amount / 1000;
  return Number.isSafeInteger(kilobits) ? kilobits : null;
}

/** Parses a whole number written in decimal digits, or returns null. */
function parseWholeNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** The channel layout `-ac` sets: 1 is mono, 2 is stereo. QuipClip offers no other count. */
function parseChannels(value: string): PresetAudioChannels | null {
  if (value === "1") {
    return "mono";
  }
  if (value === "2") {
    return "stereo";
  }
  return null;
}

/**
 * Imports ffmpeg-syntax text into a copy of `draft`.
 *
 * The text replaces both option lists of the draft. An option with the `:a` specifier goes to
 * the audio list, and an option with `:v` or with no specifier goes to the video list. These
 * flags go into fields of the preset instead: `-c:v`, `-c:a`, `-crf`, `-cq`, `-q:v`, `-b:v`,
 * `-b:a`, `-ar`, `-ac`, and `-pix_fmt`. A field that the text does not name keeps its value.
 *
 * A word that starts with `-` is a flag, unless it is a negative number or it starts with a
 * quote. Every flag takes a value, because every option a preset can hold takes one.
 *
 * `-b:v 0` beside a constant-quality kind (`crf`, `cq`, or `qualityScale`, from the text or
 * from the draft) sets no bitrate, and a note says so: the cq kind writes it itself, and the
 * other two need no bitrate.
 *
 * The import is all or nothing. When the text holds any error, the result holds every error,
 * in the order of the text, and the draft does not change.
 */
export function importOptionsText(text: string, draft: Preset): OptionImportResult {
  const positionAt = positionsOf(text);
  const { tokens, errors } = tokenize(text, positionAt);
  const managed: ManagedValue[] = [];
  const options: PlacedOption[] = [];
  const names: Record<OptionStream, Set<string>> = {
    video: new Set(),
    audio: new Set(),
  };
  const managedSeen = new Set<ManagedField>();

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const position = positionAt(token.start);
    if (!isOptionToken(token)) {
      errors.push({
        code: "unexpectedValue",
        ...position,
        values: { value: token.value },
      });
      index++;
      continue;
    }
    const next = tokens[index + 1];
    const value = next !== undefined && !isOptionToken(next) ? next.value : null;
    index += value === null ? 1 : 2;

    const flag = token.value;
    const body = flag.slice(1);
    const colon = body.indexOf(":");
    const name = colon === -1 ? body : body.slice(0, colon);
    const specifier = colon === -1 ? "" : body.slice(colon + 1);

    const field = MANAGED_FLAGS.get(body);
    if (field !== undefined) {
      if (value === null) {
        errors.push({ code: "missingValue", ...position, values: { flag } });
      } else if (managedSeen.has(field)) {
        errors.push({ code: "optionDuplicate", ...position, values: { flag } });
      } else {
        managedSeen.add(field);
        managed.push({ field, flag, value, ...position });
      }
      continue;
    }

    if (specifier !== "" && specifier !== "v" && specifier !== "a") {
      errors.push({ code: "streamSpecifier", ...position, values: { flag } });
      continue;
    }
    if (!isValidOptionName(name)) {
      errors.push({ code: "optionName", ...position, values: { flag } });
      continue;
    }
    if (isDeniedOptionName(name)) {
      errors.push({ code: "optionDenied", ...position, values: { flag } });
      continue;
    }
    if (value === null) {
      errors.push({ code: "missingValue", ...position, values: { flag } });
      continue;
    }
    if (!isValidOptionValue(value)) {
      errors.push({
        code: "optionValue",
        ...position,
        values: { flag, max: MAX_OPTION_VALUE_CHARS },
      });
      continue;
    }
    const stream: OptionStream = specifier === "a" ? "audio" : "video";
    if (names[stream].has(name)) {
      errors.push({ code: "optionDuplicate", ...position, values: { flag } });
      continue;
    }
    names[stream].add(name);
    options.push({ stream, option: { name, value }, ...position });
  }

  // The quality: one kind at most, and `-b:v 0` beside a constant-quality kind.
  let next: Preset = { ...draft };
  const notes: OptionSyntaxNote[] = [];
  let quality: { kind: QualityKind; value: string; entry: ManagedValue } | null = null;
  let zeroBitrate: ManagedValue | null = null;
  for (const entry of managed) {
    const kind = QUALITY_FIELDS[entry.field];
    if (kind === undefined) {
      continue;
    }
    if (kind === "bitrate" && parseKilobits(entry.value) === 0) {
      zeroBitrate = entry;
      continue;
    }
    if (quality !== null) {
      errors.push({
        code: "qualityConflict",
        line: entry.line,
        column: entry.column,
        values: { flag: entry.flag, other: quality.entry.flag },
      });
      continue;
    }
    quality = { kind, value: entry.value, entry };
  }
  const qualityKind = quality?.kind ?? draft.quality.kind;
  if (zeroBitrate !== null) {
    if (qualityKind === "bitrate") {
      errors.push({
        code: "zeroBitrate",
        line: zeroBitrate.line,
        column: zeroBitrate.column,
        values: { flag: zeroBitrate.flag },
      });
    } else {
      notes.push({
        code: qualityKind === "cq" ? "zeroBitrateCq" : "zeroBitrateConstant",
      });
    }
  }
  if (quality !== null) {
    const { entry } = quality;
    const value =
      quality.kind === "bitrate"
        ? parseKilobits(quality.value)
        : parseWholeNumber(quality.value);
    if (value === null) {
      errors.push({
        code: quality.kind === "bitrate" ? "bitrateValue" : "integerValue",
        line: entry.line,
        column: entry.column,
        values: { flag: entry.flag, value: quality.value },
      });
    } else {
      next.quality = { kind: quality.kind, value };
    }
  }

  // The other managed flags. The audio encoder goes first, so that an explicit `-b:a` in the
  // same text wins over the bitrate rule of `withAudioEncoder`.
  const ordered = [...managed].sort(
    (a, b) => Number(b.field === "audioEncoder") - Number(a.field === "audioEncoder"),
  );
  for (const entry of ordered) {
    const at = { line: entry.line, column: entry.column };
    switch (entry.field) {
      case "videoEncoder":
        next.videoEncoder = entry.value;
        break;
      case "audioEncoder":
        next = withAudioEncoder(next, entry.value);
        break;
      case "pixelFormat":
        next.pixelFormat = entry.value;
        break;
      case "audioBitrate": {
        const kilobits = parseKilobits(entry.value);
        if (kilobits === null) {
          errors.push({
            code: "bitrateValue",
            ...at,
            values: { flag: entry.flag, value: entry.value },
          });
        } else {
          next.audioBitrate = kilobits;
        }
        break;
      }
      case "audioSampleRate": {
        const rate = parseWholeNumber(entry.value);
        if (rate === null) {
          errors.push({
            code: "integerValue",
            ...at,
            values: { flag: entry.flag, value: entry.value },
          });
        } else {
          next.audioSampleRate = rate;
        }
        break;
      }
      case "audioChannels": {
        const channels = parseChannels(entry.value);
        if (channels === null) {
          errors.push({
            code: "channelsValue",
            ...at,
            values: { flag: entry.flag, value: entry.value },
          });
        } else {
          next.audioChannels = channels;
        }
        break;
      }
      case "crf":
      case "cq":
      case "qualityScale":
      case "videoBitrate":
        // The quality pass above handled these.
        break;
    }
  }

  // The limits of the lists: the count of each list, then the bytes of both together.
  const videoOptions: PresetOption[] = [];
  const audioOptions: PresetOption[] = [];
  let bytes = 0;
  let bytesReported = false;
  for (const placed of [...options].sort(
    (a, b) => Number(a.stream === "audio") - Number(b.stream === "audio"),
  )) {
    const list = placed.stream === "audio" ? audioOptions : videoOptions;
    list.push(placed.option);
    if (list.length === MAX_PRESET_OPTIONS + 1) {
      errors.push({
        code: "tooManyOptions",
        line: placed.line,
        column: placed.column,
        values: { max: MAX_PRESET_OPTIONS },
      });
    }
    bytes += renderedOptionBytes(placed.option, placed.stream);
    if (bytes > MAX_PRESET_OPTION_BYTES && !bytesReported) {
      bytesReported = true;
      errors.push({
        code: "optionsTooLong",
        line: placed.line,
        column: placed.column,
        values: { max: MAX_PRESET_OPTION_BYTES },
      });
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    return { ok: false, errors };
  }

  // `-b:v 0` set no field, and its own note says why.
  const moved = managed.filter((entry) => entry !== zeroBitrate);
  if (moved.length > 0) {
    notes.unshift({ code: "movedToFields", flags: moved.map((entry) => entry.flag) });
  }
  return { ok: true, preset: { ...next, videoOptions, audioOptions }, notes };
}

/** A negative number, or a word with no character that the import reads in a special way. */
const PLAIN_VALUE = /^[^\s"'\\^`]+$/;

/**
 * Writes one value so that `importOptionsText` reads it back unchanged: as it is when it holds
 * no special character and does not start with `-`, else in double quotes, with `\` and `"`
 * escaped. A negative number stays bare, because the import reads it as a value.
 */
function quoteValue(value: string): string {
  if (
    NEGATIVE_NUMBER.test(value) ||
    (PLAIN_VALUE.test(value) && !value.startsWith("-"))
  ) {
    return value;
  }
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

/**
 * The canonical text of the option lists of a preset: one option on each line, the video
 * options first, each written as the flag Rust writes for it and its value, such as
 * `-preset:v slow` or `-profile:a aac_low`.
 *
 * `importOptionsText` of this text gives the same lists back, and changes no field.
 */
export function renderOptionsText(
  preset: Pick<Preset, "videoOptions" | "audioOptions">,
): string {
  const lines: string[] = [];
  for (const option of preset.videoOptions) {
    lines.push(`${optionFlag(option, "video")} ${quoteValue(option.value)}`);
  }
  for (const option of preset.audioOptions) {
    lines.push(`${optionFlag(option, "audio")} ${quoteValue(option.value)}`);
  }
  return lines.join("\n");
}
