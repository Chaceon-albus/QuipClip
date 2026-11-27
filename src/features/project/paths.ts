/**
 * Path text helpers of the project file (ADR 072). The page gets the paths of the system as text.
 * A path in a Windows form separates its parts with `\` or `/`. Each other path separates them with
 * `/` only: on macOS a backslash is a legal character of a file name.
 */

/** The extension of a project file, in lower case. */
export const PROJECT_FILE_EXTENSION = ".qcproj";

/**
 * True when `path` has a Windows form: a drive letter, `:` and a separator (`C:\` or `C:/`), or
 * two backslashes at the start, as a share (`\\server\share`) and the verbatim forms (`\\?\`).
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The index of the last separator of `path`, or -1. */
function lastSeparator(path: string): number {
  const slash = path.lastIndexOf("/");
  return isWindowsPath(path) ? Math.max(slash, path.lastIndexOf("\\")) : slash;
}

/** The last part of `path`: the name of the file. */
export function fileNameOfPath(path: string): string {
  return path.slice(lastSeparator(path) + 1);
}

/** The directory of `path` with no separator at its end, or null when the path has none. */
export function directoryOfPath(path: string): string | null {
  const index = lastSeparator(path);
  if (index < 0) {
    return null;
  }
  // A root such as `/` or `C:\` keeps its separator.
  return index === 0 || (isWindowsPath(path) && path[index - 1] === ":")
    ? path.slice(0, index + 1)
    : path.slice(0, index);
}

/**
 * The path of the file `name` in the directory of `path`, with the separator that `path` uses
 * there. Null when `path` has no directory.
 */
export function siblingPath(path: string, name: string): string | null {
  const index = lastSeparator(path);
  return index < 0 ? null : `${path.slice(0, index + 1)}${name}`;
}

/** `text` with each ASCII capital letter in lower case, and each other character as it is. */
function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * True when the name of the file of `path` ends in `.qcproj` (ADR 072). The test ignores the case
 * of ASCII letters only.
 */
export function hasProjectExtension(path: string): boolean {
  return asciiLowerCase(fileNameOfPath(path)).endsWith(PROJECT_FILE_EXTENSION);
}

/**
 * The name of a project file for the video file `fileName`: its name with the extension replaced by
 * `.qcproj`, or with `.qcproj` added when it has no extension (ADR 072, Save As). A dot at the
 * start of the name does not start an extension.
 */
export function projectFileNameFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}${PROJECT_FILE_EXTENSION}`;
}
