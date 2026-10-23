/**
 * The version and the source of this build, for the About tab of Settings (ADR 047).
 *
 * `build_info` (`src-tauri/src/commands/build_info.rs`) returns values that are fixed when the
 * Rust crate is compiled. The build script reads the source from git.
 */

import { BACKEND_COMMANDS, invokeCommand, type InvokeFn } from "@/lib/ipc";

/** The commit that a build came from. */
export interface BuildSource {
  /** The abbreviated hash of the commit. */
  readonly commit: string;
  /** The branch, or null on the default branch and for a detached HEAD. */
  readonly branch: string | null;
  /** True when a tracked file differed from the commit. */
  readonly modified: boolean;
}

/** What the About tab shows. */
export interface BuildInfo {
  /** The application version (ADR 034). */
  readonly version: string;
  /** The source of the build, or null when the build had no git checkout. */
  readonly source: BuildSource | null;
}

/** Options for `loadBuildInfo`. A test passes a fake invoke. */
export interface BuildInfoOptions {
  readonly invoke?: InvokeFn;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateBuildSource(value: unknown): BuildSource | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const { commit, branch, modified } = candidate;
  if (
    !isNonEmptyString(commit) ||
    (branch !== null && !isNonEmptyString(branch)) ||
    typeof modified !== "boolean"
  ) {
    return undefined;
  }
  return { commit, branch, modified };
}

/**
 * Reads the result of `build_info`: a non-empty version and a source or null. Anything else
 * reads as null.
 */
export function validateBuildInfo(value: unknown): BuildInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate.version;
  const source = validateBuildSource(candidate.source);
  if (!isNonEmptyString(version) || source === undefined) {
    return null;
  }
  return { version, source };
}

/**
 * Reads the build info, or resolves null when the command failed or returned something else.
 * The About tab then shows no version line, so a failure goes to the console.
 */
export async function loadBuildInfo(
  options: BuildInfoOptions = {},
): Promise<BuildInfo | null> {
  const invoke = options.invoke ?? invokeCommand;
  try {
    const info = validateBuildInfo(await invoke<unknown>(BACKEND_COMMANDS.BUILD_INFO));
    if (info === null) {
      console.error("The build info has an unknown shape.");
    }
    return info;
  } catch (error) {
    console.error("Failed to read the build info:", error);
    return null;
  }
}
