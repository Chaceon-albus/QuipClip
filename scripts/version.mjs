// The application version: show it, check it, and bump it.
//
// `src-tauri/Cargo.toml` holds the only copy of the version that a person edits. Tauri
// reads the version from that file, because `tauri.conf.json` has no `version` field.
// `Cargo.lock` holds a second copy, and cargo writes that copy. `package.json` has no
// `version` field.
//
//   node scripts/version.mjs show
//   node scripts/version.mjs check [--tag <tag>]
//   node scripts/version.mjs bump <major | minor | patch | X.Y.Z>
//
// `show` prints only the version, so a workflow step can read it. `check` exits 1 when
// the version has a second copy, when the lock file does not agree, or when the tag is
// not the release tag of the version. `bump` changes Cargo.toml and Cargo.lock and
// nothing else. It does not commit, tag, or push.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const MANIFEST = path.join(TAURI_DIR, "Cargo.toml");
const LOCK = path.join(TAURI_DIR, "Cargo.lock");
const PACKAGE_JSON = path.join(ROOT, "package.json");

/** The release tag of a version is this prefix and the version, for example `v1.2.3`. */
export const TAG_PREFIX = "v";

// A release version is MAJOR.MINOR.PATCH, with no pre-release part and no build part.
// The Windows MSI bundle writes the version as an MSI product version. That format
// accepts MAJOR and MINOR up to 255 and PATCH up to 65535, and it accepts a pre-release
// part only when that part is all digits. A version outside these limits builds on macOS
// and then fails on Windows, so this script refuses it before the release starts.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PART_LIMITS = { major: 255, minor: 255, patch: 65535 };
const PARTS = /** @type {const} */ (["major", "minor", "patch"]);

/**
 * @typedef {{ major: number, minor: number, patch: number }} Version
 * @typedef {{
 *   manifest: string,
 *   lock: string,
 *   packageJson: string,
 *   tauriConfigs: Record<string, string>,
 *   unreadConfigs: string[],
 * }} RepoFiles
 */

// The fields of a Tauri configuration file that set a version apart from Cargo.toml.
// `bundleVersion` sets CFBundleVersion of the macOS bundle. `wix.version` sets the MSI
// product version. Tauri accepts `macOS` and `macos` as the key of the macOS section.
const TAURI_VERSION_FIELDS = [
  ["version"],
  ["bundle", "macOS", "bundleVersion"],
  ["bundle", "macos", "bundleVersion"],
  ["bundle", "windows", "wix", "version"],
];

/**
 * Parses a release version. Throws when the text is not a release version.
 * @param {string} text
 * @returns {Version}
 */
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      `"${text}" is not a release version. Use MAJOR.MINOR.PATCH, for example 1.2.3.`,
    );
  }
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  for (const part of PARTS) {
    if (version[part] > PART_LIMITS[part]) {
      throw new Error(
        `The ${part} part of ${text} is more than ${PART_LIMITS[part]}. ` +
          "The Windows MSI bundle cannot hold it.",
      );
    }
  }
  return version;
}

/**
 * @param {Version} version
 * @returns {string}
 */
export function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * @param {Version} a
 * @param {Version} b
 * @returns {number} Less than 0 when `a` is lower, 0 when equal, more than 0 when higher.
 */
export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Gives the version that follows `current`. The request is a part name or an explicit
 * version. Throws when the result is not higher than `current`, or is out of limits.
 * @param {string} current
 * @param {string} request `major`, `minor`, `patch`, or `X.Y.Z`.
 * @returns {string}
 */
export function nextVersion(current, request) {
  const now = parseVersion(current);
  /** @type {Version} */
  let next;
  switch (request) {
    case "major":
      next = { major: now.major + 1, minor: 0, patch: 0 };
      break;
    case "minor":
      next = { major: now.major, minor: now.minor + 1, patch: 0 };
      break;
    case "patch":
      next = { major: now.major, minor: now.minor, patch: now.patch + 1 };
      break;
    default:
      next = parseVersion(request);
  }
  const text = formatVersion(next);
  parseVersion(text);
  if (compareVersions(next, now) <= 0) {
    throw new Error(`${text} is not higher than the current version ${current}.`);
  }
  return text;
}

/**
 * Gives the release tag of a version.
 * @param {string} version
 * @returns {string}
 */
export function tagFor(version) {
  return `${TAG_PREFIX}${version}`;
}

// Finds the lines of the `[package]` table. The table ends at the next table header, so
// the `version` key of a dependency table is never in the range.
/**
 * @param {string[]} lines
 * @returns {{ start: number, end: number }}
 */
function packageTableRange(lines) {
  const start = lines.findIndex((line) => line.trim() === "[package]");
  if (start < 0) {
    throw new Error("src-tauri/Cargo.toml has no [package] table.");
  }
  const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return { start, end: next < 0 ? lines.length : next };
}

/**
 * Finds the one line in the `[package]` table that sets `key` to a string.
 * @param {string[]} lines
 * @param {string} key
 * @returns {{ index: number, value: string }}
 */
function packageField(lines, key) {
  const { start, end } = packageTableRange(lines);
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`);
  /** @type {{ index: number, value: string }[]} */
  const found = [];
  for (let index = start + 1; index < end; index += 1) {
    const match = pattern.exec(lines[index].replace(/\r$/, ""));
    if (match) found.push({ index, value: match[1] });
  }
  if (found.length !== 1) {
    throw new Error(
      `The [package] table of src-tauri/Cargo.toml must have one ${key} = "..." line. ` +
        `It has ${found.length}.`,
    );
  }
  return found[0];
}

/**
 * Reads the package name and the version from the text of Cargo.toml.
 * @param {string} text
 * @returns {{ name: string, version: string }}
 */
export function readManifest(text) {
  const lines = text.split("\n");
  return {
    name: packageField(lines, "name").value,
    version: packageField(lines, "version").value,
  };
}

/**
 * Gives the text of Cargo.toml with a new package version. Every other byte stays.
 * @param {string} text
 * @param {string} version
 * @returns {string}
 */
export function replaceManifestVersion(text, version) {
  const lines = text.split("\n");
  const { index } = packageField(lines, "version");
  lines[index] = lines[index].replace(/"[^"]*"/, `"${version}"`);
  return lines.join("\n");
}

/**
 * Reads the version that Cargo.lock records for the package `name` of this workspace. A
 * registry or git package has a `source` line, and a workspace package has none.
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
export function readLockVersion(text, name) {
  const found = text
    .split(/^\[\[package\]\]\r?$/m)
    .slice(1)
    .filter(
      (block) =>
        /^name = "([^"]*)"\r?$/m.exec(block)?.[1] === name &&
        !/^source = /m.test(block),
    )
    .map((block) => /^version = "([^"]*)"\r?$/m.exec(block)?.[1]);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(
      `src-tauri/Cargo.lock must have one workspace package "${name}" with a version. ` +
        `It has ${found.length}.`,
    );
  }
  return found[0];
}

/**
 * Gives the text of Cargo.lock with an empty version for the workspace package `name`.
 * Two lock files that differ only in the version of that package give the same text.
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
export function lockWithoutVersion(text, name) {
  return text
    .split(/(^\[\[package\]\]\r?$)/m)
    .map((block) =>
      /^name = "([^"]*)"\r?$/m.exec(block)?.[1] === name && !/^source = /m.test(block)
        ? block.replace(/^version = "[^"]*"(\r?)$/m, 'version = ""$1')
        : block,
    )
    .join("");
}

/**
 * Checks the files that could hold the version. The result lists every problem, not only
 * the first one.
 * @param {RepoFiles} files
 * @param {string} [tag] A release tag to compare with the version.
 * @returns {{ version: string | undefined, problems: string[] }}
 */
export function checkFiles(files, tag) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string | undefined} */
  let version;
  /** @type {string | undefined} */
  let name;

  try {
    ({ name, version } = readManifest(files.manifest));
    parseVersion(version);
  } catch (error) {
    problems.push(errorMessage(error));
  }

  if (name !== undefined && version !== undefined) {
    try {
      const locked = readLockVersion(files.lock, name);
      if (locked !== version) {
        problems.push(
          `src-tauri/Cargo.lock records ${name} ${locked}, but src-tauri/Cargo.toml ` +
            `has ${version}. Run: cargo update --workspace --manifest-path ` +
            "src-tauri/Cargo.toml",
        );
      }
    } catch (error) {
      problems.push(errorMessage(error));
    }
  }

  /** @type {[string, string, string[][]][]} */
  const jsonFiles = [
    ["package.json", files.packageJson, [["version"]]],
    ...Object.entries(files.tauriConfigs).map(
      /** @returns {[string, string, string[][]]} */
      ([file, text]) => [file, text, TAURI_VERSION_FIELDS],
    ),
  ];
  for (const [file, text, fields] of jsonFiles) {
    /** @type {unknown} */
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      problems.push(`${file} is not valid JSON: ${errorMessage(error)}`);
      continue;
    }
    for (const field of fields) {
      if (hasField(data, field)) {
        problems.push(
          `${file} has a "${field.join(".")}" field. Remove it. ` +
            "src-tauri/Cargo.toml holds the only copy of the version.",
        );
      }
    }
  }

  for (const file of files.unreadConfigs) {
    problems.push(
      `${file} exists, and this check reads only tauri*.conf.json files. ` +
        "Keep the Tauri configuration in JSON files, or extend scripts/version.mjs.",
    );
  }

  if (tag !== undefined && version !== undefined && tag !== tagFor(version)) {
    problems.push(
      `The tag "${tag}" is not the release tag of version ${version}. ` +
        `The release tag is "${tagFor(version)}".`,
    );
  }

  return { version, problems };
}

/**
 * True when `data` has the nested field `field`, for example `["bundle", "macOS"]`.
 * @param {unknown} data
 * @param {string[]} field
 * @returns {boolean}
 */
function hasField(data, field) {
  /** @type {unknown} */
  let node = data;
  for (const key of field) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      return false;
    }
    node = /** @type {Record<string, unknown>} */ (node)[key];
  }
  return true;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the files of this repository that `checkFiles` examines. Every
 * `src-tauri/tauri*.conf.json` file is included, because a platform configuration file
 * can also set a version. A JSON5 or TOML configuration file is listed by name only,
 * because this script cannot parse it.
 * @returns {RepoFiles}
 */
export function readRepoFiles() {
  /** @type {Record<string, string>} */
  const tauriConfigs = {};
  /** @type {string[]} */
  const unreadConfigs = [];
  for (const entry of readdirSync(TAURI_DIR).sort()) {
    if (/^tauri(\.[a-z]+)?\.conf\.json$/.test(entry)) {
      tauriConfigs[`src-tauri/${entry}`] = readFileSync(
        path.join(TAURI_DIR, entry),
        "utf8",
      );
    } else if (
      /^(tauri(\.[a-z]+)?\.conf\.json5|Tauri(\.[a-z]+)?\.toml)$/i.test(entry)
    ) {
      unreadConfigs.push(`src-tauri/${entry}`);
    }
  }
  return {
    manifest: readFileSync(MANIFEST, "utf8"),
    lock: readFileSync(LOCK, "utf8"),
    packageJson: readFileSync(PACKAGE_JSON, "utf8"),
    tauriConfigs,
    unreadConfigs,
  };
}

/**
 * @param {string[]} problems
 */
function reportProblems(problems) {
  for (const problem of problems) console.error(`error: ${problem}`);
}

function show() {
  const { version, problems } = checkFiles(readRepoFiles());
  if (problems.length > 0 || version === undefined) {
    reportProblems(problems);
    return 1;
  }
  console.log(version);
  return 0;
}

/**
 * @param {string[]} args
 */
function check(args) {
  /** @type {string | undefined} */
  let tag;
  if (args.length === 2 && args[0] === "--tag") {
    tag = args[1];
  } else if (args.length !== 0) {
    return usage();
  }
  const { version, problems } = checkFiles(readRepoFiles(), tag);
  if (problems.length > 0) {
    reportProblems(problems);
    return 1;
  }
  const tagNote = tag === undefined ? "" : `, and ${tag} is its release tag`;
  console.log(`Version ${version}: one copy in src-tauri/Cargo.toml${tagNote}.`);
  return 0;
}

/**
 * @param {string[]} args
 */
function bump(args) {
  if (args.length !== 1) return usage();
  const before = readRepoFiles();
  const { version: current, problems } = checkFiles(before);
  if (problems.length > 0 || current === undefined) {
    reportProblems(problems);
    console.error("Correct these problems before a bump.");
    return 1;
  }

  const changed = execFileSync(
    "git",
    ["status", "--porcelain", "--", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (changed.trim() !== "") {
    console.error(
      "error: src-tauri/Cargo.toml or src-tauri/Cargo.lock has changes that are not " +
        "committed. The bump commit must hold only the version change.",
    );
    return 1;
  }

  const next = nextVersion(current, args[0]);
  const restore = () => {
    writeFileSync(MANIFEST, before.manifest);
    writeFileSync(LOCK, before.lock);
  };

  // A listener stops Node from exiting at Ctrl-C. The signal also stops cargo, so
  // `execFileSync` throws, and the catch below restores both files. Without the listener,
  // Node exits at once and leaves the new Cargo.toml in place.
  process.on("SIGINT", () => {});

  writeFileSync(MANIFEST, replaceManifestVersion(before.manifest, next));
  try {
    updateLockFile();
  } catch (error) {
    restore();
    console.error(
      `error: cargo update failed: ${errorMessage(error)}. ` +
        "src-tauri/Cargo.toml and src-tauri/Cargo.lock are as they were.",
    );
    return 1;
  }

  const afterFiles = readRepoFiles();
  const after = checkFiles(afterFiles);
  if (after.problems.length > 0 || after.version !== next) {
    restore();
    reportProblems(after.problems);
    console.error(
      "error: the bump did not give one consistent version. " +
        "src-tauri/Cargo.toml and src-tauri/Cargo.lock are as they were.",
    );
    return 1;
  }
  const { name } = readManifest(afterFiles.manifest);
  if (
    lockWithoutVersion(afterFiles.lock, name) !== lockWithoutVersion(before.lock, name)
  ) {
    restore();
    console.error(
      "error: cargo update changed other packages in src-tauri/Cargo.lock. " +
        "src-tauri/Cargo.toml and src-tauri/Cargo.lock are as they were.",
    );
    return 1;
  }

  const tag = tagFor(next);
  console.log(`Version ${current} -> ${next}.`);
  console.log("Changed src-tauri/Cargo.toml and src-tauri/Cargo.lock.");
  console.log("");
  console.log("Next steps:");
  console.log("  git add src-tauri/Cargo.toml src-tauri/Cargo.lock");
  console.log(`  git commit -m "chore(tauri): release ${next}"`);
  console.log("  Push the commit to main, and wait for CI to pass. Then:");
  console.log(`  git tag -a ${tag} -m "QuipClip ${next}"`);
  console.log(`  pnpm version:check --tag ${tag}`);
  console.log(`  git push origin ${tag}`);
  return 0;
}

// The exit statuses of a process that Ctrl-C stopped: 130 on a POSIX shell, and
// STATUS_CONTROL_C_EXIT (0xC000013A) on Windows, which Node can give as signed or
// unsigned.
const INTERRUPT_STATUSES = new Set([130, 0xc000013a, 0xc000013a - 2 ** 32]);

/**
 * Runs `cargo update`, shows its error output, and throws when it fails.
 * @param {string[]} args
 * @returns {{ ok: true } | { ok: false, stderr: string }}
 */
function runCargoUpdate(args) {
  const result = spawnSync(
    "cargo",
    ["update", "--workspace", "--manifest-path", MANIFEST, ...args],
    { cwd: ROOT, stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal !== null || INTERRUPT_STATUSES.has(result.status ?? 0)) {
    throw new Error("cargo update was interrupted");
  }
  return result.status === 0 ? { ok: true } : { ok: false, stderr: result.stderr };
}

// Writes the new version into Cargo.lock. `--workspace` updates only the packages of
// this workspace, and cargo documents it for a lock file after a version change in
// Cargo.toml. Cargo still reads the registry index to resolve the lock file. The first
// try uses only the local copy of the index. The second try downloads the index, and it
// runs only when cargo names offline mode as a possible cause of the failure.
function updateLockFile() {
  const offline = runCargoUpdate(["--offline"]);
  if (offline.ok) return;
  if (!/offline/i.test(offline.stderr)) {
    throw new Error("cargo update --offline failed");
  }
  console.error("cargo update --offline failed. Trying again with network access.");
  if (!runCargoUpdate([]).ok) throw new Error("cargo update failed");
}

function usage() {
  console.error(
    [
      "usage: node scripts/version.mjs show",
      "       node scripts/version.mjs check [--tag <tag>]",
      "       node scripts/version.mjs bump <major | minor | patch | X.Y.Z>",
    ].join("\n"),
  );
  return 2;
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "show":
      return args.length === 0 ? show() : usage();
    case "check":
      return check(args);
    case "bump":
      return bump(args);
    default:
      return usage();
  }
}

/** True when Node runs this file, and false when a test imports it. */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
