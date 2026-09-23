/**
 * File name and file path helpers for display.
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

/** A file path split into the file name and the name of the folder that holds the file. */
export interface FilePathParts {
  /** The last segment of the path: the file name. */
  readonly name: string;
  /**
   * The name of the folder that holds the file: its last segment, or the root itself, such as
   * "/" or "C:\". Null for a path with no folder.
   */
  readonly folderName: string | null;
}

/**
 * Splits a file path into the file name and the name of its folder.
 *
 * A path that starts with "/" is a POSIX path, and only "/" separates its segments. A
 * backslash is a legal character in a macOS file name, so it must not split one. Every other
 * path is a Windows path, such as "C:\Videos\out.mp4" or "\\server\share\out.mp4", and both
 * "\" and "/" separate its segments. Empty segments, from a doubled or a trailing separator,
 * are skipped.
 *
 * Null when the path has no segment.
 */
export function splitFilePath(path: string): FilePathParts | null {
  const posix = path.startsWith("/");
  const segments = path
    .split(posix ? "/" : /[/\\]/)
    .filter((segment) => segment !== "");
  if (segments.length === 0) {
    return null;
  }
  const name = segments[segments.length - 1];
  if (segments.length >= 2) {
    const folder = segments[segments.length - 2];
    // "C:\out.mp4": the folder is the drive root, and its segment is the bare drive "C:".
    if (!posix && segments.length === 2 && /^[A-Za-z]:$/.test(folder)) {
      return { name, folderName: `${folder}\\` };
    }
    return { name, folderName: folder };
  }
  // A single segment. "/out.mp4" sits in the root. "out.mp4" names no folder.
  return { name, folderName: posix ? "/" : null };
}
