/**
 * File name helpers for display.
 */

/** A file name split into the part before its extension and the extension. */
export interface FileNameParts {
  /** The name without its extension. `stem + extension` is always the whole name. */
  readonly stem: string;
  /** The last dot and the characters after it, such as `.mp4`, or an empty string. */
  readonly extension: string;
}

/**
 * Splits a file name at its last dot, so that a display can truncate the stem and keep the
 * extension visible.
 *
 * The input is a base name, not a path. Only the last dot starts the extension, so
 * `a.tar.gz` gives `a.tar` and `.gz`. A dot that is the first character, as in `.gitignore`,
 * does not start an extension. This agrees with `hasVideoFileExtension`. A dot that is the
 * last character, as in `clip.`, does not start an extension either, because no characters
 * follow it.
 */
export function splitFileName(name: string): FileNameParts {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return { stem: name, extension: "" };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}
