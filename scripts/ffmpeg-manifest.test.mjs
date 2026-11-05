import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as prettier from "prettier";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  compareVersions,
  formatManifest,
  gyanReleases,
  highestRelease,
  isContentRange,
  latestLocation,
  licenseOfVersionOutput,
  main,
  MANIFEST_PATH,
  namesVersion,
  nextPage,
  programEntry,
  readRemoteZipEntries,
  readZipEntries,
  sha256OfDigest,
  sha256OfFile,
  versionOfMartinRiedlUrl,
  versionParts,
} from "./ffmpeg-manifest.mjs";

/**
 * Builds a small zip of stored entries with a central directory. The CRC fields stay 0, because
 * the script reads only the central directory.
 * @param {{ path: string, bytes: Uint8Array, method?: number, flags?: number }[]} files
 * @param {{ comment?: Uint8Array, zip64Size?: boolean }} [options]
 * @returns {Uint8Array}
 */
function buildZip(files, options = {}) {
  const encoder = new TextEncoder();
  /** @type {number[]} */
  const local = [];
  /** @type {number[]} */
  const central = [];
  const u16 = (/** @type {number[]} */ out, /** @type {number} */ value) =>
    out.push(value & 0xff, (value >>> 8) & 0xff);
  const u32 = (/** @type {number[]} */ out, /** @type {number} */ value) =>
    out.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  for (const file of files) {
    const name = encoder.encode(file.path);
    const offset = local.length;
    const method = file.method ?? 0;
    const size = options.zip64Size ? 0xffffffff : file.bytes.length;
    u32(local, 0x04034b50);
    u16(local, 20);
    u16(local, file.flags ?? 0);
    u16(local, method);
    u32(local, 0);
    u32(local, 0);
    u32(local, file.bytes.length);
    u32(local, file.bytes.length);
    u16(local, name.length);
    u16(local, 0);
    local.push(...name, ...file.bytes);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, file.flags ?? 0);
    u16(central, method);
    u32(central, 0);
    u32(central, 0);
    u32(central, file.bytes.length);
    u32(central, size);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }
  const comment = options.comment ?? new Uint8Array();
  /** @type {number[]} */
  const end = [];
  u32(end, 0x06054b50);
  u16(end, 0);
  u16(end, 0);
  u16(end, files.length);
  u16(end, files.length);
  u32(end, central.length);
  u32(end, local.length);
  u16(end, comment.length);
  return new Uint8Array([...local, ...central, ...end, ...comment]);
}

const sha256 = (/** @type {Uint8Array} */ bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** Reads a zip that is held in memory. */
const readBytes = (/** @type {Uint8Array} */ zip) =>
  readZipEntries(zip, zip.length, async (start, end) => zip.subarray(start, end + 1));

/**
 * A fetch over fixed routes. A route that holds bytes answers a range request with 206 and a
 * `Content-Range`, unless `noRanges` is set. A route can hold a list of statuses, used in turn.
 * @param {Record<string, { status?: number | number[], body?: Uint8Array | string, headers?: Record<string, string> }>} routes
 * @param {{ noRanges?: boolean, badContentRange?: boolean }} [options]
 */
function fakeFetch(routes, options = {}) {
  /** @type {{ url: string, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {(url: string, init?: RequestInit) => Promise<Response>} */
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response("missing", { status: 404 });
    const status = Array.isArray(route.status)
      ? (route.status.shift() ?? 404)
      : (route.status ?? 200);
    const headers = new Headers(route.headers ?? {});
    const range = new Headers(init?.headers ?? {}).get("range");
    if (route.body instanceof Uint8Array && range !== null && !options.noRanges) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) throw new Error(`bad range ${range}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = options.badContentRange ? route.body.length + 1 : route.body.length;
      headers.set("content-range", `bytes ${start}-${end}/${total}`);
      return new Response(route.body.subarray(start, end + 1), {
        status: 206,
        headers,
      });
    }
    if (init?.method === "HEAD") return new Response(null, { status, headers });
    return new Response(route.body ?? null, { status, headers });
  };
  return { fetchFn, calls };
}

describe("versions", () => {
  it("reads only plain version tags", () => {
    expect(versionParts("9.0.2")).toEqual([9, 0, 2]);
    expect(versionParts("9.0")).toEqual([9, 0]);
    for (const tag of ["v9.0.2", "9.0.2-rc1", "latest", "2026-10-01", "9.0.2.1"]) {
      expect(versionParts(tag)).toBeNull();
    }
  });

  it("compares part by part, with a missing part as 0", () => {
    expect(compareVersions([9, 0, 10], [9, 0, 2])).toBeGreaterThan(0);
    expect(compareVersions([9, 0], [9, 0, 2])).toBeLessThan(0);
    expect(compareVersions([9, 0], [9, 0, 0])).toBe(0);
  });

  it("takes the highest published release, not the newest", () => {
    const release = (/** @type {string} */ tag, extra = {}) => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [],
      ...extra,
    });
    const releases = [
      release("8.1.3"),
      release("10.0", { prerelease: true }),
      release("9.0.2"),
      release("9.1", { draft: true }),
      release("9.0"),
      release("2026-11-02-git-b034eb5e7e"),
    ];
    expect(highestRelease(releases).tag_name).toBe("9.0.2");
    expect(() => highestRelease([release("tools")])).toThrow(/no release/);
  });

  it("matches a version only up to the end of its number", () => {
    const text = "ffmpeg version 9.0.2-https://www.martin-riedl.de Copyright\n";
    expect(namesVersion(text, "ffmpeg", "9.0.2")).toBe(true);
    expect(namesVersion("ffmpeg version 9.0.2\n", "ffmpeg", "9.0.2")).toBe(true);
    expect(namesVersion("ffmpeg version 9.0.20\n", "ffmpeg", "9.0.2")).toBe(false);
    expect(namesVersion("ffmpeg version 9.0.2.1\n", "ffmpeg", "9.0.2")).toBe(false);
    expect(namesVersion("ffmpeg version 9.0.2\n", "ffprobe", "9.0.2")).toBe(false);
  });
});

describe("checksums, licences and pages", () => {
  const hex = "a".repeat(64);

  it("reads a GitHub digest and refuses a missing one", () => {
    expect(sha256OfDigest(`sha256:${hex}`, "x.zip")).toBe(hex);
    expect(() => sha256OfDigest(null, "x.zip")).toThrow(/no SHA-256/);
    expect(() => sha256OfDigest(`sha1:${hex}`, "x.zip")).toThrow(/no SHA-256/);
  });

  it("reads a .sha256 file with or without a file name", () => {
    expect(sha256OfFile(`${hex.toUpperCase()}  ffmpeg.zip\n`, "u")).toBe(hex);
    expect(sha256OfFile(`${hex}\n`, "u")).toBe(hex);
    expect(() => sha256OfFile("not a hash", "u")).toThrow(/no SHA-256/);
  });

  it("reads the licence flags from the configuration line", () => {
    const text =
      "ffmpeg version 9.0.2\r\nconfiguration: --enable-gpl --enable-version3 --x\r\n";
    expect(licenseOfVersionOutput(text)).toEqual({
      gpl: true,
      version3: true,
      nonfree: false,
    });
    expect(() => licenseOfVersionOutput("ffmpeg version 1")).toThrow(/configuration/);
  });

  it("reads the version of a versioned martin-riedl path", () => {
    const url =
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip";
    expect(versionOfMartinRiedlUrl(url)).toBe("9.0.2");
    expect(() =>
      versionOfMartinRiedlUrl(
        "https://ffmpeg.martin-riedl.de/redirect/latest/ffmpeg.zip",
      ),
    ).toThrow(/versioned/);
  });

  it("reads the next page of a Link header", () => {
    const link =
      '<https://api.github.com/repositories/1/releases?page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/releases?page=7>; rel="last"';
    expect(nextPage(link)).toBe(
      "https://api.github.com/repositories/1/releases?page=2",
    );
    expect(nextPage('<https://x/?page=1>; rel="prev"')).toBeNull();
    expect(nextPage(null)).toBeNull();
  });

  it("checks the range and the size of a Content-Range", () => {
    expect(isContentRange("bytes 10-19/100", 10, 19, 100)).toBe(true);
    expect(isContentRange("bytes 10-19/101", 10, 19, 100)).toBe(false);
    expect(isContentRange("bytes 10-19/*", 10, 19, 100)).toBe(false);
    expect(isContentRange(null, 10, 19, 100)).toBe(false);
  });
});

describe("zip entries", () => {
  const exe = new Uint8Array([1, 2, 3, 4, 5]);
  const zip = buildZip([
    { path: "ffmpeg-9.0.2-full_build/", bytes: new Uint8Array() },
    { path: "ffmpeg-9.0.2-full_build/bin/ffmpeg.exe", bytes: exe },
    { path: "ffmpeg-9.0.2-full_build/bin/ffprobe.exe", bytes: exe.subarray(0, 3) },
    { path: "ffmpeg-9.0.2-full_build/doc/ffmpeg.exe", bytes: exe },
  ]);

  it("reads the path, the method and the size of each entry", async () => {
    const entries = await readBytes(zip);
    expect(entries.map((entry) => entry.path)).toEqual([
      "ffmpeg-9.0.2-full_build/",
      "ffmpeg-9.0.2-full_build/bin/ffmpeg.exe",
      "ffmpeg-9.0.2-full_build/bin/ffprobe.exe",
      "ffmpeg-9.0.2-full_build/doc/ffmpeg.exe",
    ]);
    expect(entries[1]).toEqual({
      path: "ffmpeg-9.0.2-full_build/bin/ffmpeg.exe",
      method: 0,
      size: 5,
    });
  });

  it("finds the record behind a comment that holds the signature", async () => {
    const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(30).fill(0)]);
    const withComment = buildZip([{ path: "ffmpeg", bytes: exe }], { comment });
    expect((await readBytes(withComment)).map((entry) => entry.path)).toEqual([
      "ffmpeg",
    ]);
  });

  it("refuses bytes with no end of central directory", async () => {
    await expect(readBytes(new Uint8Array(40))).rejects.toThrow(
      /end of central directory/,
    );
  });

  it("refuses a Zip64 archive and a Zip64 entry", async () => {
    await expect(
      readBytes(buildZip([{ path: "ffmpeg", bytes: exe }], { zip64Size: true })),
    ).rejects.toThrow(/Zip64 entry/);
    const plain = buildZip([{ path: "ffmpeg", bytes: exe }]);
    const end = plain.length - 22;
    // A Zip64 end of central directory locator right in front of the record.
    const locator = new Uint8Array([0x50, 0x4b, 0x06, 0x07, ...new Array(16).fill(0)]);
    const withLocator = new Uint8Array([
      ...plain.subarray(0, end),
      ...locator,
      ...plain.subarray(end),
    ]);
    await expect(readBytes(withLocator)).rejects.toThrow(/Zip64 archive/);
  });

  it("refuses a damaged or misplaced central directory", async () => {
    const damaged = zip.slice();
    // The first byte of the central directory is no longer a signature.
    const directoryOffset = new DataView(damaged.buffer).getUint32(
      damaged.length - 6,
      true,
    );
    damaged[directoryOffset] = 0;
    await expect(readBytes(damaged)).rejects.toThrow(/damaged/);

    const misplaced = zip.slice();
    new DataView(misplaced.buffer).setUint32(misplaced.length - 6, zip.length, true);
    await expect(readBytes(misplaced)).rejects.toThrow(/outside the zip/);

    // The last entry names more bytes than the directory holds.
    const truncated = zip.slice();
    const view = new DataView(truncated.buffer);
    const directorySize = view.getUint32(truncated.length - 10, true);
    view.setUint32(truncated.length - 10, directorySize - 4, true);
    await expect(readBytes(truncated)).rejects.toThrow(/damaged|outside/);
  });

  it("leaves out a name that is not ASCII with no UTF-8 flag", async () => {
    const latin = buildZip([
      { path: "doc/ré.txt", bytes: exe },
      { path: "doc/ré2.txt", bytes: exe, flags: 0x0800 },
      { path: "ffmpeg", bytes: exe },
    ]);
    expect((await readBytes(latin)).map((entry) => entry.path)).toEqual([
      "doc/ré2.txt",
      "ffmpeg",
    ]);
  });

  it("takes the one program entry in its place", async () => {
    const entries = await readBytes(zip);
    expect(programEntry(entries, "ffprobe.exe", true, "z.zip")).toEqual({
      path: "ffmpeg-9.0.2-full_build/bin/ffprobe.exe",
      method: "stored",
      size: 3,
    });
    expect(() => programEntry(entries, "ffmpeg.exe", false, "z.zip")).toThrow(
      /0 entries/,
    );
    const twice = [...entries, { ...entries[1], path: "other/bin/ffmpeg.exe" }];
    expect(() => programEntry(twice, "ffmpeg.exe", true, "z.zip")).toThrow(/2 entries/);
    const deep = [{ ...entries[1], path: "a/b/bin/ffmpeg.exe" }];
    expect(() => programEntry(deep, "ffmpeg.exe", true, "z.zip")).toThrow(/0 entries/);
  });

  it("refuses a method that the application cannot extract, and an empty program", () => {
    const entry = { path: "ffmpeg", method: 12, size: 5 };
    expect(() => programEntry([entry], "ffmpeg", false, "z.zip")).toThrow(/method 12/);
    expect(() =>
      programEntry([{ ...entry, method: 8, size: 0 }], "ffmpeg", false, "z.zip"),
    ).toThrow(/empty/);
    expect(
      programEntry([{ ...entry, method: 8 }], "ffmpeg", false, "z.zip").method,
    ).toBe("deflate");
  });

  it("reads a remote zip with two range requests", async () => {
    const url = "https://example.test/a.zip";
    const { fetchFn, calls } = fakeFetch({ [url]: { body: zip } });
    const entries = await readRemoteZipEntries(fetchFn, url, zip.length, sha256(zip));
    expect(entries).toHaveLength(4);
    expect(calls).toHaveLength(2);
  });

  it("refuses a range answer for a file of another size", async () => {
    const url = "https://example.test/a.zip";
    const { fetchFn } = fakeFetch({ [url]: { body: zip } }, { badContentRange: true });
    await expect(
      readRemoteZipEntries(fetchFn, url, zip.length, sha256(zip)),
    ).rejects.toThrow(/did not answer the range/);
  });

  it("downloads the whole zip once when the host ignores ranges, and checks it", async () => {
    const url = "https://example.test/a.zip";
    const { fetchFn, calls } = fakeFetch({ [url]: { body: zip } }, { noRanges: true });
    expect(
      await readRemoteZipEntries(fetchFn, url, zip.length, sha256(zip)),
    ).toHaveLength(4);
    expect(calls).toHaveLength(1);
    await expect(
      readRemoteZipEntries(fetchFn, url, zip.length, "0".repeat(64)),
    ).rejects.toThrow(/published SHA-256/);
  });

  it("names the URL when the network fails", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    };
    await expect(
      readRemoteZipEntries(failing, "https://example.test/a.zip", 100, "0".repeat(64)),
    ).rejects.toThrow("https://example.test/a.zip: fetch failed (ENOTFOUND)");
  });
});

describe("buildManifest", () => {
  const winZip = buildZip([
    { path: "ffmpeg-9.0.2-full_build/bin/ffmpeg.exe", bytes: new Uint8Array(7) },
    { path: "ffmpeg-9.0.2-full_build/bin/ffprobe.exe", bytes: new Uint8Array(6) },
  ]);
  const macFfmpeg = buildZip([{ path: "ffmpeg", bytes: new Uint8Array(9) }]);
  const macFfprobe = buildZip([{ path: "ffprobe", bytes: new Uint8Array(8) }]);
  const winUrl =
    "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip";
  const macDir = "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2";
  const latest = "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release";
  const releasesUrl =
    "https://api.github.com/repos/GyanD/codexffmpeg/releases?per_page=100";
  const page2 =
    "https://api.github.com/repositories/306803927/releases?per_page=100&page=2";

  /** @param {Record<string, unknown>} [asset] */
  const release = (asset = {}) => ({
    tag_name: "9.0.2",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "ffmpeg-9.0.2-full_build.zip",
        size: winZip.length,
        state: "uploaded",
        digest: `sha256:${sha256(winZip)}`,
        browser_download_url: winUrl,
        ...asset,
      },
    ],
  });

  /** @param {Record<string, unknown>} [overrides] */
  const routes = (overrides = {}) => ({
    [releasesUrl]: {
      body: JSON.stringify([
        {
          tag_name: "2026-11-02-git-b034eb5e7e",
          draft: false,
          prerelease: false,
          assets: [],
        },
        { tag_name: "8.1.3", draft: false, prerelease: false, assets: [] },
      ]),
      headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
    },
    [page2]: { body: JSON.stringify([release()]) },
    [winUrl]: { body: winZip },
    [`${latest}/ffmpeg.zip`]: {
      status: [404, 307],
      headers: { location: `${macDir}/ffmpeg.zip` },
    },
    [`${latest}/ffprobe.zip`]: {
      status: [307],
      headers: { location: `${macDir}/ffprobe.zip` },
    },
    [`${macDir}/ffmpeg.zip.sha256`]: { body: `${sha256(macFfmpeg)}  ffmpeg.zip\n` },
    [`${macDir}/ffprobe.zip.sha256`]: { body: `${sha256(macFfprobe)}  ffprobe.zip\n` },
    [`${macDir}/ffmpeg.zip`]: {
      body: macFfmpeg,
      headers: { "content-length": String(macFfmpeg.length) },
    },
    [`${macDir}/ffprobe.zip`]: {
      body: macFfprobe,
      headers: { "content-length": String(macFfprobe.length) },
    },
    [`${macDir}/versions.txt`]: {
      body: "ffmpeg version 9.0.2-https://www.martin-riedl.de\nconfiguration: --enable-gpl --enable-version3\n",
    },
    ...overrides,
  });

  it("pins each archive of both targets, with the release of a later page", async () => {
    const { fetchFn, calls } = fakeFetch(routes());
    const manifest = await buildManifest(fetchFn, "secret");
    expect(manifest).toEqual({
      schemaVersion: 1,
      targets: {
        "windows-x86_64": {
          version: "9.0.2",
          source: "github.com/GyanD/codexffmpeg",
          license: { gpl: true, version3: true, nonfree: false },
          archives: [
            {
              urls: [winUrl],
              sha256: sha256(winZip),
              size: winZip.length,
              entries: {
                ffmpeg: {
                  path: "ffmpeg-9.0.2-full_build/bin/ffmpeg.exe",
                  method: "stored",
                  size: 7,
                },
                ffprobe: {
                  path: "ffmpeg-9.0.2-full_build/bin/ffprobe.exe",
                  method: "stored",
                  size: 6,
                },
              },
            },
          ],
        },
        "macos-aarch64": {
          version: "9.0.2",
          source: "ffmpeg.martin-riedl.de",
          license: { gpl: true, version3: true, nonfree: false },
          archives: [
            {
              urls: [`${macDir}/ffmpeg.zip`],
              sha256: sha256(macFfmpeg),
              size: macFfmpeg.length,
              entries: { ffmpeg: { path: "ffmpeg", method: "stored", size: 9 } },
            },
            {
              urls: [`${macDir}/ffprobe.zip`],
              sha256: sha256(macFfprobe),
              size: macFfprobe.length,
              entries: { ffprobe: { path: "ffprobe", method: "stored", size: 8 } },
            },
          ],
        },
      },
    });
    // The token goes to the GitHub API only.
    for (const call of calls) {
      const authorization = new Headers(call.init?.headers ?? {}).get("authorization");
      expect(authorization).toBe(
        call.url.startsWith("https://api.github.com/") ? "Bearer secret" : null,
      );
    }
  });

  it("refuses a next page of releases outside the GitHub API", async () => {
    const { fetchFn } = fakeFetch(
      routes({
        [releasesUrl]: {
          body: "[]",
          headers: { link: '<https://example.test/releases?page=2>; rel="next"' },
        },
      }),
    );
    await expect(gyanReleases(fetchFn, "secret")).rejects.toThrow(
      /outside the GitHub API/,
    );
  });

  it("stops at the page limit, and names the URL of a body that is not JSON", async () => {
    // Each page names itself as the next page, so the list never ends.
    const { fetchFn } = fakeFetch(
      routes({
        [releasesUrl]: {
          body: "[]",
          headers: { link: `<${releasesUrl}>; rel="next"` },
        },
      }),
    );
    await expect(gyanReleases(fetchFn, undefined)).rejects.toThrow(
      /more than 20 pages/,
    );
    const notJson = fakeFetch(routes({ [releasesUrl]: { body: "<html>" } }));
    await expect(gyanReleases(notJson.fetchFn, undefined)).rejects.toThrow(
      `${releasesUrl}: `,
    );
  });

  it("refuses an asset with no full build, no digest, or another address", async () => {
    for (const [asset, message] of [
      [
        { name: "ffmpeg-9.0.2-essentials_build.zip" },
        /has no ffmpeg-9.0.2-full_build.zip/,
      ],
      [{ digest: null }, /no SHA-256 digest/],
      [{ browser_download_url: "https://example.test/x.zip" }, /has the address/],
      [{ state: "starter" }, /state "starter"/],
      [{ size: 0 }, /no valid size/],
    ]) {
      const { fetchFn } = fakeFetch(
        routes({ [page2]: { body: JSON.stringify([release(asset)]) } }),
      );
      await expect(buildManifest(fetchFn, undefined)).rejects.toThrow(message);
    }
  });

  it("asks the redirect again after a 404, and gives up after its attempts", async () => {
    const answers = [404, 404, 307];
    /** @type {(url: string, init?: RequestInit) => Promise<Response>} */
    const flaky = async () => {
      const status = answers.shift() ?? 404;
      const headers = status === 307 ? { location: `${macDir}/ffmpeg.zip` } : undefined;
      return new Response(null, { status, headers });
    };
    expect(await latestLocation(flaky, `${latest}/ffmpeg.zip`)).toBe(
      `${macDir}/ffmpeg.zip`,
    );
    await expect(latestLocation(flaky, `${latest}/ffmpeg.zip`)).rejects.toThrow(
      /404 6 times/,
    );
    const broken = async () => new Response(null, { status: 500 });
    await expect(latestLocation(broken, `${latest}/ffmpeg.zip`)).rejects.toThrow(/500/);
    const offline = async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    await expect(latestLocation(offline, `${latest}/ffmpeg.zip`)).rejects.toThrow(
      `${latest}/ffmpeg.zip: fetch failed (ECONNRESET)`,
    );
  });

  it("refuses a redirect out of the martin-riedl host", async () => {
    const { fetchFn } = fakeFetch(
      routes({
        [`${latest}/ffmpeg.zip`]: {
          status: 307,
          headers: { location: "https://example.test/1_9.0.2/ffmpeg.zip" },
        },
      }),
    );
    await expect(buildManifest(fetchFn, undefined)).rejects.toThrow(/outside/);
  });

  it("refuses ffmpeg and ffprobe of two versions", async () => {
    const other =
      "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789000000_9.0.1";
    const { fetchFn } = fakeFetch(
      routes({
        [`${latest}/ffprobe.zip`]: {
          status: 307,
          headers: { location: `${other}/ffprobe.zip` },
        },
        [`${other}/ffprobe.zip.sha256`]: { body: `${sha256(macFfprobe)}\n` },
        [`${other}/ffprobe.zip`]: {
          body: macFfprobe,
          headers: { "content-length": String(macFfprobe.length) },
        },
      }),
    );
    await expect(buildManifest(fetchFn, undefined)).rejects.toThrow(
      /9\.0\.2 and ffprobe 9\.0\.1/,
    );
  });

  it("refuses a martin-riedl zip whose bytes do not match its .sha256 file", async () => {
    const { fetchFn } = fakeFetch(
      routes({ [`${macDir}/ffmpeg.zip.sha256`]: { body: `${"0".repeat(64)}\n` } }),
    );
    await expect(buildManifest(fetchFn, undefined)).rejects.toThrow(
      /published SHA-256/,
    );
  });

  it("refuses a missing size and a versions.txt of another version", async () => {
    const noSize = fakeFetch(routes({ [`${macDir}/ffmpeg.zip`]: { body: macFfmpeg } }));
    await expect(buildManifest(noSize.fetchFn, undefined)).rejects.toThrow(
      /gives no size/,
    );
    const otherVersion = fakeFetch(
      routes({
        [`${macDir}/versions.txt`]: {
          body: "ffmpeg version 9.0.20\nconfiguration: --enable-gpl\n",
        },
      }),
    );
    await expect(buildManifest(otherVersion.fetchFn, undefined)).rejects.toThrow(
      /does not name ffmpeg 9\.0\.2/,
    );
  });

  it("formats the manifest as Prettier does", async () => {
    const { fetchFn } = fakeFetch(routes());
    const text = await formatManifest(await buildManifest(fetchFn, undefined));
    const file = path.resolve(MANIFEST_PATH);
    const options = (await prettier.resolveConfig(file)) ?? {};
    expect(
      await prettier.check(text, { ...options, plugins: [], filepath: file }),
    ).toBe(true);
    expect(text).toContain(
      '"license": { "gpl": true, "version3": true, "nonfree": false }',
    );
  });

  describe("main", () => {
    /** @type {string[]} */
    const roots = [];
    afterEach(() => {
      for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it("writes the manifest into a new directory, and then finds it current", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const root = mkdtempSync(path.join(tmpdir(), "ffmpeg-manifest-"));
      roots.push(root);
      const run = (/** @type {string[]} */ argv) =>
        main(argv, { fetchFn: fakeFetch(routes()).fetchFn, token: undefined, root });

      expect(await run(["--check"])).toBe(1);
      expect(await run([])).toBe(0);
      const text = readFileSync(path.join(root, MANIFEST_PATH), "utf8");
      expect(JSON.parse(text).targets["windows-x86_64"].version).toBe("9.0.2");
      expect(await run(["--check"])).toBe(0);
      expect(await run(["--write"])).toBe(2);
    });
  });
});
