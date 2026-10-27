/**
 * File path comparison by text, with no file system access.
 *
 * `isSameDisplayPath` in `fileName.ts` answers another question: whether two locations show
 * as one for display, on a platform that the caller names, with a trailing separator ignored.
 * `isSameFilePath` decides from the text of each path alone whether two file paths name one
 * file.
 */

// A Windows path in the verbatim form that `std::fs::canonicalize` returns.
const VERBATIM_UNC_PREFIX = "\\\\?\\UNC\\";
const VERBATIM_PREFIX = "\\\\?\\";
// A drive letter or a UNC share at the start of a Windows path.
const WINDOWS_PATH_START = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** Rewrites a Windows verbatim path to its ordinary form, and leaves other paths alone. */
function withoutVerbatimPrefix(path: string): string {
  if (path.startsWith(VERBATIM_UNC_PREFIX)) {
    return `\\\\${path.slice(VERBATIM_UNC_PREFIX.length)}`;
  }
  if (path.startsWith(VERBATIM_PREFIX)) {
    return path.slice(VERBATIM_PREFIX.length);
  }
  return path;
}

/** Options of `isSameFilePath`. */
export interface SameFilePathOptions {
  /**
   * Compares POSIX paths without regard to letter case and Unicode normalization too.
   *
   * A caller sets it when a false match costs less than a missed one. The default volume of
   * macOS ignores case and normalization, so two names that differ only in case, or one in
   * composed and one in decomposed form, are one file there, and a caller that must not let
   * two writers reach one file treats them as one. On a volume that respects case, the
   * answer is then true for two different files. Windows paths ignore case with or without
   * this option.
   */
  readonly ignoreCase?: boolean;
}

/**
 * True when two paths name the same file as far as their text shows.
 *
 * The open video has the canonical path from the import. On Windows that path is in the
 * verbatim form (`\\?\C:\...`), and a file dialog or a drop reports the ordinary form. So the
 * test removes the verbatim prefix. It compares Windows paths without regard to letter case
 * or separator, as the Windows file system does, and every other path exactly, unless
 * `options.ignoreCase` is set. A Windows path never names the same file as any other path.
 *
 * The test reads no file system. A symbolic link answers false, and so does any other
 * spelling of one file that the rules above do not fold.
 */
export function isSameFilePath(
  first: string,
  second: string,
  options: SameFilePathOptions = {},
): boolean {
  const a = withoutVerbatimPrefix(first);
  const b = withoutVerbatimPrefix(second);
  const aIsWindows = WINDOWS_PATH_START.test(a);
  if (aIsWindows !== WINDOWS_PATH_START.test(b)) {
    // Without the option two such paths are never equal anyway. With it, a character that
    // lowers to a drive letter, such as the Kelvin sign, could otherwise match a Windows path.
    return false;
  }
  if (aIsWindows) {
    const normalize = (path: string) => path.replaceAll("/", "\\").toLowerCase();
    return normalize(a) === normalize(b);
  }
  if (options.ignoreCase === true) {
    const fold = (path: string) => path.normalize("NFD").toLowerCase();
    return fold(a) === fold(b);
  }
  return a === b;
}
