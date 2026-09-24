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

/**
 * Removes the Windows verbatim prefix from a path, for display.
 *
 * `std::fs::canonicalize` on Windows returns a verbatim path: `\\?\C:\tools\ffmpeg.exe` for
 * a drive path and `\\?\UNC\server\share\ffmpeg.exe` for a network share. The prefix is
 * correct, but it is not the form that the user types or sees in File Explorer. This function
 * gives `C:\tools\ffmpeg.exe` and `\\server\share\ffmpeg.exe`.
 *
 * Only those two forms change. Any other verbatim path, such as a volume GUID path, has no
 * drive letter to show, so it stays as it is. A path without the prefix, which includes every
 * macOS path, also stays as it is.
 */
export function stripVerbatimPrefix(path: string): string {
  if (/^\\\\\?\\[A-Za-z]:(\\|$)/.test(path)) {
    return path.slice(4);
  }
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    return `\\\\${path.slice(8)}`;
  }
  return path;
}

/**
 * Puts a Windows path in one form for a comparison: with `\` as the only separator, without
 * the verbatim prefix, without one trailing separator, and in lower case.
 *
 * The separators are folded first, so a prefix written with `/` is also removed. A drive root
 * such as `C:\` keeps its separator, because `C:` without it names the working folder of that
 * drive.
 */
function comparableWindowsPath(path: string): string {
  let result = stripVerbatimPrefix(path.replace(/\//g, "\\"));
  if (result.endsWith("\\") && !/^[A-Za-z]:\\$/.test(result) && !/^\\+$/.test(result)) {
    result = result.slice(0, -1);
  }
  return result.toLowerCase();
}

/**
 * True when two paths name the same location for display: they are equal after
 * `stripVerbatimPrefix`.
 *
 * With `windows`, the comparison also accepts the other forms of one Windows path: `/` for
 * `\`, one trailing separator, and a different letter case, because Windows file names do
 * not depend on letter case. Without it, as on macOS, the paths must be equal.
 */
export function isSameDisplayPath(a: string, b: string, windows: boolean): boolean {
  if (windows) {
    return comparableWindowsPath(a) === comparableWindowsPath(b);
  }
  return stripVerbatimPrefix(a) === stripVerbatimPrefix(b);
}
