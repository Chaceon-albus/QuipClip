/**
 * Pure presenter for the version line of the About tab of Settings (ADR 047).
 *
 * The line gives the version and, in parentheses, the source of the build: the branch when it
 * is not the default branch, the commit, and a mark when the sources differed from the commit.
 * The macOS About panel shows the same parts in English (`src-tauri/src/build_info.rs`). Each
 * combination is one complete message, so no component joins translated fragments (ADR 011).
 */

import type { BuildInfo } from "@/lib/buildInfo";

/** Translation key and interpolation values for the version line, ready for `t()`. */
export type VersionLineView = {
  key: string;
  values: Record<string, string>;
};

/** Builds the version line of `info`. */
export function presentVersionLine(info: BuildInfo): VersionLineView {
  const { version, source } = info;
  if (source === null) {
    return { key: "settings.about.version", values: { version } };
  }
  const { commit, branch, modified } = source;
  if (branch === null) {
    return {
      key: modified
        ? "settings.about.versionCommitModified"
        : "settings.about.versionCommit",
      values: { version, commit },
    };
  }
  return {
    key: modified
      ? "settings.about.versionBranchCommitModified"
      : "settings.about.versionBranchCommit",
    values: { version, branch, commit },
  };
}
