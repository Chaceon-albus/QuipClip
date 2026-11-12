// The manifest of the ffmpeg download (ADR 059).
//
// The application embeds src-tauri/resources/ffmpeg-manifest.json and downloads only the files
// that it pins: each URL, its SHA-256, its size, and the exact entries of each zip. This script
// writes that file from the current release of each source. Run it before each version bump.
//
//   node scripts/ffmpeg-manifest.mjs           writes the manifest
//   node scripts/ffmpeg-manifest.mjs --check   exits 1 when the manifest differs from a new run
//
// The script exits 1 on any failure too, such as a network error, with a message that names
// the URL. It reads GITHUB_TOKEN when it is set, because the GitHub API limits requests with no
// token. It sends the token only to api.github.com.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "src-tauri/resources/ffmpeg-manifest.json";
export const SCHEMA_VERSION = 1;

/** The GitHub API. The token goes to this origin only. */
const GITHUB_API_ORIGIN = "https://api.github.com";
/**
 * The Windows builds of Gyan on GitHub. Each FFmpeg release has a tag of its own. Dated
 * snapshots share the list, and the list is not in the order of the versions, so the script
 * reads every page.
 */
const GYAN_RELEASES = `${GITHUB_API_ORIGIN}/repos/GyanD/codexffmpeg/releases?per_page=100`;
const GYAN_DOWNLOADS = "https://github.com/GyanD/codexffmpeg/releases/download";
const GYAN_SOURCE = "github.com/GyanD/codexffmpeg";
/** The most pages of releases that the script reads. On 2026-11-05 the list had 7. */
const MAX_RELEASE_PAGES = 20;
/**
 * Gyan states the licence of its builds only in prose: GPLv3. The install checks these flags
 * against the `configuration:` line of the programs, so a change is caught there.
 */
const GYAN_LICENSE = { gpl: true, version3: true, nonfree: false };

/** The macOS builds of martin-riedl. `redirect/latest` answers with the versioned path. */
const MARTIN_RIEDL_ORIGIN = "https://ffmpeg.martin-riedl.de";
const MARTIN_RIEDL_LATEST = `${MARTIN_RIEDL_ORIGIN}/redirect/latest/macos/arm64/release`;
const MARTIN_RIEDL_SOURCE = "ffmpeg.martin-riedl.de";

/** The longest wait for one request of a small answer. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The longest wait for the download of a whole zip. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** The most requests for one `redirect/latest` address of martin-riedl. */
const REDIRECT_ATTEMPTS = 6;

/**
 * The end of a zip holds the end of central directory record and a comment of at most 64 KiB.
 * The 20 more bytes hold a Zip64 locator in front of the record, so the reader can refuse it.
 */
const ZIP_TAIL_BYTES = 20 + 22 + 0xffff;

/** The compression methods of a zip entry that the application can extract. */
const ZIP_METHODS = new Map([
  [0, "stored"],
  [8, "deflate"],
]);

/**
 * @typedef {{ gpl: boolean, version3: boolean, nonfree: boolean }} License
 * @typedef {{ path: string, method: "stored" | "deflate", size: number }} Entry
 * @typedef {{ ffmpeg?: Entry, ffprobe?: Entry }} Entries
 * @typedef {{ urls: string[], sha256: string, size: number, entries: Entries }} Archive
 * @typedef {{ version: string, source: string, license: License, archives: Archive[] }} Target
 * @typedef {{ schemaVersion: number, targets: Record<string, Target> }} Manifest
 * @typedef {{ path: string, method: number, size: number }} ZipEntry
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {{ name: string, size: number, state?: string, digest?: string | null, browser_download_url: string }} GitHubAsset
 * @typedef {{ tag_name: string, draft: boolean, prerelease: boolean, assets: GitHubAsset[] }} GitHubRelease
 */

/**
 * Splits a release version such as `9.0.2` into numbers, or gives null for another tag.
 * @param {string} tag
 * @returns {number[] | null}
 */
export function versionParts(tag) {
  if (!/^\d+(\.\d+){0,2}$/.test(tag)) return null;
  return tag.split(".").map(Number);
}

/**
 * Compares two versions part by part. A missing part counts as 0, so `9.0` is lower than
 * `9.0.2`.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Gives the release with the highest version among the releases that are published, are not
 * pre-releases, and have a version tag.
 * @param {GitHubRelease[]} releases
 * @returns {GitHubRelease}
 */
export function highestRelease(releases) {
  /** @type {{ release: GitHubRelease, parts: number[] } | null} */
  let best = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const parts = versionParts(release.tag_name);
    if (parts === null) continue;
    if (best === null || compareVersions(parts, best.parts) > 0)
      best = { release, parts };
  }
  if (best === null)
    throw new Error(`${GYAN_SOURCE} has no release with a version tag.`);
  return best.release;
}

/**
 * Gives the URL of the next page of a GitHub `Link` header, or null on the last page.
 * @param {string | null} link
 * @returns {string | null}
 */
export function nextPage(link) {
  for (const part of (link ?? "").split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * Gives the hexadecimal SHA-256 of a GitHub asset digest, `sha256:<hex>`.
 * @param {string | null | undefined} digest
 * @param {string} name
 * @returns {string}
 */
export function sha256OfDigest(digest, name) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest ?? "");
  if (match === null) throw new Error(`${name} has no SHA-256 digest on GitHub.`);
  return match[1];
}

/**
 * Gives the hexadecimal SHA-256 of a `.sha256` file, `<hex>  <name>` or `<hex>` alone.
 * @param {string} text
 * @param {string} url
 * @returns {string}
 */
export function sha256OfFile(text, url) {
  const match = /^([0-9a-fA-F]{64})(\s|$)/.exec(text.trim());
  if (match === null) throw new Error(`${url} holds no SHA-256.`);
  return match[1].toLowerCase();
}

/**
 * Reads the licence flags from the `configuration:` line of `-version` output.
 * @param {string} text
 * @returns {License}
 */
export function licenseOfVersionOutput(text) {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("configuration:"));
  if (line === undefined)
    throw new Error("The version output has no configuration line.");
  const flags = new Set(line.trim().split(/\s+/).slice(1));
  return {
    gpl: flags.has("--enable-gpl"),
    version3: flags.has("--enable-version3"),
    nonfree: flags.has("--enable-nonfree"),
  };
}

/**
 * True when `-version` output names `program` at `version`, followed by the end of the token
 * or by a character other than a digit or a dot. So `9.0.2-https://…` matches `9.0.2`, and
 * `9.0.20` does not.
 * @param {string} text
 * @param {string} program
 * @param {string} version
 * @returns {boolean}
 */
export function namesVersion(text, program, version) {
  const escaped = version.replaceAll(".", "\\.");
  return new RegExp(`^${program} version ${escaped}(?![\\d.])`, "m").test(text);
}

/**
 * Gives the FFmpeg version of a versioned martin-riedl path, such as `9.0.2` of
 * `/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip`.
 * @param {string} url
 * @returns {string}
 */
export function versionOfMartinRiedlUrl(url) {
  const segments = new URL(url).pathname.split("/");
  const directory = segments.at(-2) ?? "";
  const match = /^\d+_(\d+(?:\.\d+){0,2})$/.exec(directory);
  if (match === null)
    throw new Error(`${url} is not a versioned path of a release build.`);
  return match[1];
}

/**
 * Decodes the name of a zip entry. Bit 11 of the flags marks a UTF-8 name. With no bit 11, the
 * format reads the name as code page 437, which agrees with UTF-8 only for ASCII. So such a
 * name with another byte gives null, and the entry cannot match a program, whose name is ASCII.
 * @param {Uint8Array} bytes
 * @param {number} flags
 * @returns {string | null}
 */
function decodeEntryName(bytes, flags) {
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte >= 0x80)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the entries of a zip from its central directory: the path, the compression method
 * and the size after extraction of each file. `tail` holds the last bytes of the zip, and
 * `readRange` reads the central directory once the tail gives its place. An entry whose name
 * has no unambiguous decoding is left out.
 *
 * The reader refuses a Zip64 archive, and a damaged or misplaced central directory.
 * @param {Uint8Array} tail The last bytes of the zip, at least its end of central directory.
 * @param {number} size The size of the whole zip.
 * @param {(start: number, end: number) => Promise<Uint8Array>} readRange Reads bytes
 *   `start` to `end`, both included.
 * @returns {Promise<ZipEntry[]>}
 */
export async function readZipEntries(tail, size, readRange) {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  // The record ends at the end of the zip, after its comment. A signature inside the comment
  // fails this check.
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === tail.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("The zip has no end of central directory record.");
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    throw new Error("The zip is a Zip64 archive, which this script does not read.");
  }
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error("The zip is a Zip64 archive, which this script does not read.");
  }
  const recordOffset = size - tail.length + end;
  if (directoryOffset + directorySize > recordOffset) {
    throw new Error("The central directory of the zip lies outside the zip.");
  }
  if (count === 0) return [];
  const directory = await readRange(
    directoryOffset,
    directoryOffset + directorySize - 1,
  );
  const data = new DataView(
    directory.buffer,
    directory.byteOffset,
    directory.byteLength,
  );
  /** @type {ZipEntry[]} */
  const entries = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || data.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The central directory of the zip is damaged.");
    }
    const flags = data.getUint16(offset + 8, true);
    const method = data.getUint16(offset + 10, true);
    const compressed = data.getUint32(offset + 20, true);
    const uncompressed = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localOffset = data.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length)
      throw new Error("The central directory of the zip is damaged.");
    if ([compressed, uncompressed, localOffset].includes(0xffffffff)) {
      throw new Error("The zip has a Zip64 entry, which this script does not read.");
    }
    const name = decodeEntryName(
      directory.subarray(offset + 46, offset + 46 + nameLength),
      flags,
    );
    if (name !== null) entries.push({ path: name, method, size: uncompressed });
    offset = next;
  }
  if (offset !== directory.length) {
    throw new Error("The central directory of the zip has bytes after its last entry.");
  }
  return entries;
}

/**
 * Gives the one entry of a program in a zip. In a Windows zip of Gyan, the program is
 * `<top>/bin/<fileName>`. In a macOS zip of martin-riedl, it is `<fileName>` at the root.
 * @param {ZipEntry[]} entries
 * @param {string} fileName
 * @param {boolean} inBin True for `<top>/bin/<fileName>`, false for `<fileName>`.
 * @param {string} zip The zip, for the messages.
 * @returns {Entry}
 */
export function programEntry(entries, fileName, inBin, zip) {
  const matches = entries.filter((entry) => {
    const parts = entry.path.split("/");
    if (parts.at(-1) !== fileName) return false;
    return inBin
      ? parts.length === 3 && parts[0] !== "" && parts[1] === "bin"
      : parts.length === 1;
  });
  if (matches.length !== 1) {
    throw new Error(`${zip} has ${matches.length} entries for ${fileName}, not one.`);
  }
  const [entry] = matches;
  const method = ZIP_METHODS.get(entry.method);
  if (method === undefined) {
    throw new Error(`${zip} compresses ${entry.path} with method ${entry.method}.`);
  }
  if (!(entry.size > 0)) throw new Error(`${zip} has an empty ${entry.path}.`);
  return {
    path: entry.path,
    method: /** @type {"stored" | "deflate"} */ (method),
    size: entry.size,
  };
}

/**
 * Sends one request with a time limit, and fails on a network error or an HTTP error. Each
 * message names the URL.
 * @param {Fetch} fetchFn
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeout]
 * @returns {Promise<Response>}
 */
async function request(fetchFn, url, init = {}, timeout = REQUEST_TIMEOUT_MS) {
  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeout), ...init });
  } catch (error) {
    throw new Error(`${url}: ${describeError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}.`);
  }
  return response;
}

/**
 * Gives the message of an error of `fetch`, with the code of its cause when it has one.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {{ code?: unknown } | undefined} */ (error.cause);
  return typeof cause?.code === "string"
    ? `${error.message} (${cause.code})`
    : error.message;
}

/**
 * Reads the body of a response, and fails with the URL in the message.
 * @param {Response} response
 * @param {string} url
 * @returns {Promise<Uint8Array>}
 */
async function bodyOf(response, url) {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`${url}: ${describeError(error)}`, { cause: error });
  }
}

/**
 * True when a `Content-Range` header names the range `start`-`end` of a file of `size` bytes.
 * @param {string | null} header
 * @param {number} start
 * @param {number} end
 * @param {number} size
 * @returns {boolean}
 */
export function isContentRange(header, start, end, size) {
  return header === `bytes ${start}-${end}/${size}`;
}

/**
 * Downloads a whole zip, checks its size and SHA-256, and reads its entries. So the entries
 * belong to the bytes of the SHA-256.
 * @param {Fetch} fetchFn
 * @param {string} url
 * @param {number} size
 * @param {string} sha256
 * @returns {Promise<ZipEntry[]>}
 */
export async function readDownloadedZipEntries(fetchFn, url, size, sha256) {
  const response = await request(fetchFn, url, {}, DOWNLOAD_TIMEOUT_MS);
  return zipEntriesOfBytes(await bodyOf(response, url), url, size, sha256);
}

/**
 * Checks the size and the SHA-256 of a whole zip, and reads its entries.
 * @param {Uint8Array} whole
 * @param {string} url
 * @param {number} size
 * @param {string} sha256
 * @returns {Promise<ZipEntry[]>}
 */
async function zipEntriesOfBytes(whole, url, size, sha256) {
  const digest = createHash("sha256").update(whole).digest("hex");
  if (whole.length !== size || digest !== sha256) {
    throw new Error(`${url} did not give the bytes of its published SHA-256 and size.`);
  }
  return readZipEntries(whole, size, async (start, end) =>
    whole.subarray(start, end + 1),
  );
}

/**
 * Reads the entries of a zip at `url` with HTTP range requests. Each answer must name the
 * range and the size of the zip. When the host answers a range request with the whole file, the
 * script reads the whole zip once, checks its SHA-256, and reads the entries from those bytes.
 * @param {Fetch} fetchFn
 * @param {string} url
 * @param {number} size
 * @param {string} sha256
 * @returns {Promise<ZipEntry[]>}
 */
export async function readRemoteZipEntries(fetchFn, url, size, sha256) {
  const tailStart = Math.max(0, size - ZIP_TAIL_BYTES);
  const tailResponse = await request(
    fetchFn,
    url,
    { headers: { Range: `bytes=${tailStart}-${size - 1}` } },
    DOWNLOAD_TIMEOUT_MS,
  );
  if (tailResponse.status !== 206) {
    return zipEntriesOfBytes(await bodyOf(tailResponse, url), url, size, sha256);
  }
  const tail = await bodyOf(tailResponse, url);
  if (
    tail.length !== size - tailStart ||
    !isContentRange(
      tailResponse.headers.get("content-range"),
      tailStart,
      size - 1,
      size,
    )
  ) {
    throw new Error(
      `${url} did not answer the range ${tailStart}-${size - 1} of ${size}.`,
    );
  }
  return readZipEntries(tail, size, async (start, end) => {
    const response = await request(fetchFn, url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    const bytes = await bodyOf(response, url);
    if (
      response.status !== 206 ||
      bytes.length !== end - start + 1 ||
      !isContentRange(response.headers.get("content-range"), start, end, size)
    ) {
      throw new Error(`${url} did not answer the range ${start}-${end} of ${size}.`);
    }
    return bytes;
  });
}

/**
 * Gives the headers of a request to the GitHub API.
 * @param {string | undefined} token
 * @returns {Record<string, string>}
 */
function gitHubHeaders(token) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Reads every page of the releases of Gyan. A next page outside the GitHub API is refused,
 * because the request carries the token.
 * @param {Fetch} fetchFn
 * @param {string | undefined} token
 * @returns {Promise<GitHubRelease[]>}
 */
export async function gyanReleases(fetchFn, token) {
  /** @type {GitHubRelease[]} */
  const releases = [];
  /** @type {string | null} */
  let url = GYAN_RELEASES;
  for (let page = 0; url !== null; page++) {
    if (page === MAX_RELEASE_PAGES) {
      throw new Error(
        `${GYAN_SOURCE} has more than ${MAX_RELEASE_PAGES} pages of releases.`,
      );
    }
    if (!URL.canParse(url) || new URL(url).origin !== GITHUB_API_ORIGIN) {
      throw new Error(`The next page of releases, ${url}, is outside the GitHub API.`);
    }
    const response = await request(fetchFn, url, { headers: gitHubHeaders(token) });
    /** @type {unknown} */
    let items;
    try {
      items = await response.json();
    } catch (error) {
      throw new Error(`${url}: ${describeError(error)}`, { cause: error });
    }
    if (!Array.isArray(items))
      throw new Error(`${url} did not give a list of releases.`);
    releases.push(.../** @type {GitHubRelease[]} */ (items));
    url = nextPage(response.headers.get("link"));
  }
  return releases;
}

/**
 * Gives the Windows target: the full build zip of the highest Gyan release.
 * @param {Fetch} fetchFn
 * @param {string | undefined} token
 * @returns {Promise<Target>}
 */
export async function gyanTarget(fetchFn, token) {
  const release = highestRelease(await gyanReleases(fetchFn, token));
  const version = release.tag_name;
  const name = `ffmpeg-${version}-full_build.zip`;
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) throw new Error(`${GYAN_SOURCE} ${version} has no ${name}.`);
  const url = `${GYAN_DOWNLOADS}/${version}/${name}`;
  if (asset.browser_download_url !== url) {
    throw new Error(
      `${name} has the address ${asset.browser_download_url}, not ${url}.`,
    );
  }
  if (asset.state !== undefined && asset.state !== "uploaded") {
    throw new Error(`${name} has the state "${asset.state}", not "uploaded".`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`${name} has no valid size.`);
  }
  const sha256 = sha256OfDigest(asset.digest, name);
  const entries = await readRemoteZipEntries(fetchFn, url, asset.size, sha256);
  return {
    version,
    source: GYAN_SOURCE,
    license: { ...GYAN_LICENSE },
    archives: [
      {
        urls: [url],
        sha256,
        size: asset.size,
        entries: {
          ffmpeg: programEntry(entries, "ffmpeg.exe", true, name),
          ffprobe: programEntry(entries, "ffprobe.exe", true, name),
        },
      },
    ],
  };
}

/**
 * Gives the `Location` of a `redirect/latest` address of martin-riedl.
 *
 * On 2026-11-05 that address answered 307 and 404 in turn, 12 times in a row, while the
 * versioned paths always answered 200. So a 404 is tried again, at most
 * {@link REDIRECT_ATTEMPTS} times. Any other answer that is not a redirect fails at once.
 * @param {Fetch} fetchFn
 * @param {string} latest
 * @returns {Promise<string>}
 */
export async function latestLocation(fetchFn, latest) {
  for (let attempt = 1; attempt <= REDIRECT_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetchFn(latest, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: "HEAD",
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(`${latest}: ${describeError(error)}`, { cause: error });
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null)
      return location;
    if (response.status !== 404) {
      throw new Error(`${latest} answered ${response.status}, not a redirect.`);
    }
  }
  throw new Error(`${latest} answered 404 ${REDIRECT_ATTEMPTS} times.`);
}

/**
 * Gives the archive of one program of the current martin-riedl release, and its version. The
 * script downloads the zip once, so its entries and its `.sha256` file are checked against
 * its bytes.
 * @param {Fetch} fetchFn
 * @param {"ffmpeg" | "ffprobe"} program
 * @returns {Promise<{ version: string, url: string, archive: Archive }>}
 */
async function martinRiedlArchive(fetchFn, program) {
  const latest = `${MARTIN_RIEDL_LATEST}/${program}.zip`;
  const url = new URL(await latestLocation(fetchFn, latest), latest).href;
  if (!url.startsWith(`${MARTIN_RIEDL_ORIGIN}/`)) {
    throw new Error(`${latest} redirected to ${url}, outside ${MARTIN_RIEDL_SOURCE}.`);
  }
  const version = versionOfMartinRiedlUrl(url);
  const sha256 = sha256OfFile(
    await (await request(fetchFn, `${url}.sha256`)).text(),
    url,
  );
  const head = await request(fetchFn, url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length") ?? Number.NaN);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error(`${url} gives no size.`);
  const entries = await readDownloadedZipEntries(fetchFn, url, size, sha256);
  const zip = `${program}.zip`;
  return {
    version,
    url,
    archive: {
      urls: [url],
      sha256,
      size,
      entries: { [program]: programEntry(entries, program, false, zip) },
    },
  };
}

/**
 * Gives the macOS arm64 target: the ffmpeg zip and the ffprobe zip of the current martin-riedl
 * release, with the licence flags of its `versions.txt`.
 * @param {Fetch} fetchFn
 * @returns {Promise<Target>}
 */
export async function martinRiedlTarget(fetchFn) {
  const ffmpeg = await martinRiedlArchive(fetchFn, "ffmpeg");
  const ffprobe = await martinRiedlArchive(fetchFn, "ffprobe");
  if (ffmpeg.version !== ffprobe.version) {
    throw new Error(
      `${MARTIN_RIEDL_SOURCE} gives ffmpeg ${ffmpeg.version} and ffprobe ${ffprobe.version}.`,
    );
  }
  const versions = new URL("versions.txt", ffmpeg.url).href;
  const text = await (await request(fetchFn, versions)).text();
  if (!namesVersion(text, "ffmpeg", ffmpeg.version)) {
    throw new Error(`${versions} does not name ffmpeg ${ffmpeg.version}.`);
  }
  return {
    version: ffmpeg.version,
    source: MARTIN_RIEDL_SOURCE,
    license: licenseOfVersionOutput(text),
    archives: [ffmpeg.archive, ffprobe.archive],
  };
}

/**
 * Builds the manifest from the current release of each source. Each archive has one URL,
 * because no source publishes a second URL for the same bytes.
 * @param {Fetch} fetchFn
 * @param {string | undefined} token
 * @returns {Promise<Manifest>}
 */
export async function buildManifest(fetchFn, token) {
  return {
    schemaVersion: SCHEMA_VERSION,
    targets: {
      "windows-x86_64": await gyanTarget(fetchFn, token),
      "macos-aarch64": await martinRiedlTarget(fetchFn),
    },
  };
}

/**
 * Gives the text of the manifest file, in the form that Prettier gives it. JSON needs no
 * plugin of the configuration, and a plugin name would resolve against the working directory.
 * @param {Manifest} manifest
 * @param {string} [root]
 * @returns {Promise<string>}
 */
export async function formatManifest(manifest, root = ROOT) {
  const prettier = await import("prettier");
  const file = path.join(root, MANIFEST_PATH);
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(manifest), {
    ...options,
    plugins: [],
    filepath: file,
  });
}

/**
 * Runs the script. The arguments after `argv` exist for the tests.
 * @param {string[]} argv
 * @param {{ fetchFn?: Fetch, token?: string, root?: string }} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  const check = argv.length === 1 && argv[0] === "--check";
  if (argv.length > 0 && !check) {
    console.error("usage: node scripts/ffmpeg-manifest.mjs [--check]");
    return 2;
  }
  const root = options.root ?? ROOT;
  const manifest = await buildManifest(
    options.fetchFn ?? globalThis.fetch,
    "token" in options ? options.token : process.env.GITHUB_TOKEN,
  );
  const text = await formatManifest(manifest, root);
  const file = path.join(root, MANIFEST_PATH);
  for (const [target, entry] of Object.entries(manifest.targets)) {
    console.log(`${target}: FFmpeg ${entry.version} from ${entry.source}`);
  }
  if (check) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // A missing manifest differs from any new run.
    }
    if (current !== text) {
      console.error(`error: ${MANIFEST_PATH} differs from the current releases.`);
      return 1;
    }
    console.log(`${MANIFEST_PATH} is current.`);
    return 0;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`Wrote ${MANIFEST_PATH}.`);
  return 0;
}

/**
 * True when Node runs this file, and false when a test or another script imports it.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
