// The assets of a release, and the checks of the release workflow.
//
// A published immutable release cannot get, lose, or change an asset. This file is the
// one list of the assets that each release must hold. The release workflow uses it
// before it attaches the bundles and again before it publishes the draft.
//
//   node scripts/release-assets.mjs files <dir>
//   node scripts/release-assets.mjs draft <assets.json> <dir>
//
// `files` exits 1 unless the files below <dir> are exactly the bundles of the version,
// and prints their paths, one on each line. `draft` exits 1 unless the draft assets in
// <assets.json> are exactly the bundles below <dir>: the same names, all uploaded, and
// the same SHA-256 digests. <assets.json> holds the JSON array of the release assets that
// the GitHub API gives.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles, readRepoFiles } from "./version.mjs";

/**
 * @typedef {{ name: string, state: string, size: number, digest?: string | null }} ReleaseAsset
 */

/**
 * Gives the file names of the bundles that each release must hold. The names are the
 * names that the Tauri 2 bundler writes, in this order: the macOS disk image for
 * `aarch64`, the Windows MSI package, and the Windows NSIS installer. Tauri names the
 * `x86_64` architecture `x64`. The release has no macOS `x86_64` bundle.
 * @param {string} productName
 * @param {string} version
 * @returns {string[]}
 */
export function releaseAssetNames(productName, version) {
  return [
    `${productName}_${version}_aarch64.dmg`,
    `${productName}_${version}_x64_en-US.msi`,
    `${productName}_${version}_x64-setup.exe`,
  ];
}

/**
 * Compares a list of names with the expected names. The result lists every problem.
 * @param {string[]} expected
 * @param {string[]} actual
 * @param {string} where Where the names come from, for the messages.
 * @returns {string[]}
 */
export function compareNames(expected, actual, where) {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const name of actual) {
    if (seen.has(name)) problems.push(`${where} has ${name} more than one time.`);
    seen.add(name);
    if (!expected.includes(name))
      problems.push(`${where} has ${name}, which is not a bundle.`);
  }
  for (const name of expected) {
    if (!seen.has(name)) problems.push(`${where} has no ${name}.`);
  }
  return problems;
}

/**
 * Checks the assets of a draft release: exactly the expected names, each uploaded, none
 * empty, and each with the digest of the local bundle of the same name. GitHub gives the
 * digest as `sha256:` and the hexadecimal SHA-256 of the asset.
 * @param {string[]} expected
 * @param {ReleaseAsset[]} assets
 * @param {Map<string, string>} digests The digest of each local bundle, by file name.
 * @returns {string[]}
 */
export function checkDraftAssets(expected, assets, digests) {
  const problems = compareNames(
    expected,
    assets.map((asset) => asset.name),
    "The draft",
  );
  for (const asset of assets) {
    if (asset.state !== "uploaded") {
      problems.push(`${asset.name} has the state "${asset.state}", not "uploaded".`);
    }
    if (!(asset.size > 0)) problems.push(`${asset.name} is empty.`);
    const local = digests.get(asset.name);
    if (local !== undefined && asset.digest !== local) {
      problems.push(
        `${asset.name} has the digest ${asset.digest ?? "(none)"}, ` +
          `but the bundle has ${local}.`,
      );
    }
  }
  return problems;
}

/**
 * Gives the GitHub form of the SHA-256 digest of a file.
 * @param {string} file
 * @returns {string}
 */
export function fileDigest(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

/**
 * Gives the paths of all files below a directory, in sorted order.
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

/**
 * Reads the product name from tauri.conf.json and the version from Cargo.toml.
 * @returns {{ productName: string, version: string }}
 */
function readRelease() {
  const files = readRepoFiles();
  const { version, problems } = checkFiles(files);
  if (problems.length > 0 || version === undefined) {
    throw new Error(problems.join(" "));
  }
  const config = JSON.parse(files.tauriConfigs["src-tauri/tauri.conf.json"] ?? "{}");
  if (typeof config.productName !== "string" || config.productName === "") {
    throw new Error("src-tauri/tauri.conf.json has no productName.");
  }
  return { productName: config.productName, version };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const [command, ...args] = argv;
  const valid =
    (command === "files" && args.length === 1) ||
    (command === "draft" && args.length === 2);
  if (!valid) {
    console.error(
      [
        "usage: node scripts/release-assets.mjs files <dir>",
        "       node scripts/release-assets.mjs draft <assets.json> <dir>",
      ].join("\n"),
    );
    return 2;
  }
  const { productName, version } = readRelease();
  const expected = releaseAssetNames(productName, version);

  const dir = command === "files" ? args[0] : args[1];
  const paths = listFiles(path.resolve(dir));
  const fileProblems = compareNames(
    expected,
    paths.map((file) => path.basename(file)),
    dir,
  );
  if (fileProblems.length > 0) {
    for (const problem of fileProblems) console.error(`error: ${problem}`);
    return 1;
  }
  if (command === "files") {
    for (const file of paths) console.log(file);
    return 0;
  }

  /** @type {unknown} */
  const assets = JSON.parse(readFileSync(path.resolve(args[0]), "utf8"));
  if (!Array.isArray(assets)) {
    console.error(`error: ${args[0]} does not hold a JSON array.`);
    return 1;
  }
  const digests = new Map(paths.map((file) => [path.basename(file), fileDigest(file)]));
  const problems = checkDraftAssets(
    expected,
    /** @type {ReleaseAsset[]} */ (assets),
    digests,
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    return 1;
  }
  console.log(
    `The draft holds the ${expected.length} bundles of ${version}, with their digests.`,
  );
  return 0;
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
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
