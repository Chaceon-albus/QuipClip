import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDraftAssets,
  compareNames,
  fileDigest,
  releaseAssetNames,
} from "./release-assets.mjs";
import { readManifest, readRepoFiles } from "./version.mjs";

const SCRIPT = fileURLToPath(new URL("./release-assets.mjs", import.meta.url));
const NAMES = releaseAssetNames("QuipClip", "1.2.3");

describe("releaseAssetNames", () => {
  it("gives the three Tauri 2 bundle names of a version", () => {
    expect(NAMES).toEqual([
      "QuipClip_1.2.3_aarch64.dmg",
      "QuipClip_1.2.3_x64_en-US.msi",
      "QuipClip_1.2.3_x64-setup.exe",
    ]);
  });
});

describe("compareNames", () => {
  it("accepts exactly the expected names in any order", () => {
    expect(compareNames(NAMES, [...NAMES].reverse(), "x")).toEqual([]);
  });

  it("finds a missing, an extra, and a repeated name", () => {
    const actual = [NAMES[0], NAMES[0], NAMES[2], "QuipClip_1.2.3_x64.dmg"];
    expect(compareNames(NAMES, actual, "The draft")).toEqual([
      "The draft has QuipClip_1.2.3_aarch64.dmg more than one time.",
      "The draft has QuipClip_1.2.3_x64.dmg, which is not a bundle.",
      "The draft has no QuipClip_1.2.3_x64_en-US.msi.",
    ]);
  });

  it("refuses the bundles of a different version", () => {
    const old = releaseAssetNames("QuipClip", "1.2.2");
    expect(compareNames(NAMES, old, "x")).toHaveLength(6);
  });
});

describe("checkDraftAssets", () => {
  const digests = new Map(NAMES.map((name, index) => [name, `sha256:${index}`]));
  /** @param {Partial<import("./release-assets.mjs").ReleaseAsset>[]} [changes] */
  const assets = (changes = []) =>
    NAMES.map((name, index) => ({
      name,
      state: "uploaded",
      size: 100,
      digest: `sha256:${index}`,
      ...changes[index],
    }));

  it("accepts three uploaded bundles with the digests of the local files", () => {
    expect(checkDraftAssets(NAMES, assets(), digests)).toEqual([]);
  });

  it("refuses an asset that is not uploaded, or that is empty", () => {
    expect(
      checkDraftAssets(NAMES, assets([{ state: "starter" }, { size: 0 }]), digests),
    ).toEqual([
      'QuipClip_1.2.3_aarch64.dmg has the state "starter", not "uploaded".',
      "QuipClip_1.2.3_x64_en-US.msi is empty.",
    ]);
  });

  it("refuses an asset with a different digest, or with no digest", () => {
    expect(
      checkDraftAssets(
        NAMES,
        assets([{}, { digest: "sha256:other" }, { digest: null }]),
        digests,
      ),
    ).toEqual([
      "QuipClip_1.2.3_x64_en-US.msi has the digest sha256:other, but the bundle has sha256:1.",
      "QuipClip_1.2.3_x64-setup.exe has the digest (none), but the bundle has sha256:2.",
    ]);
  });
});

describe("fileDigest", () => {
  it("gives sha256: and the hexadecimal SHA-256 of the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-assets-"));
    try {
      const file = path.join(dir, "a.txt");
      writeFileSync(file, "abc");
      expect(fileDigest(file)).toBe(
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the command", () => {
  /** @type {string | undefined} */
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const { version } = readManifest(readRepoFiles().manifest);
  /** @param {string[]} args */
  const run = (args) => {
    try {
      return {
        status: 0,
        out: execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" }),
      };
    } catch (error) {
      const failed = /** @type {{ status: number, stderr: string }} */ (error);
      return { status: failed.status, out: failed.stderr };
    }
  };

  it("lists the bundles below a directory when they are exactly the release", () => {
    dir = mkdtempSync(path.join(tmpdir(), "release-assets-"));
    const names = releaseAssetNames("QuipClip", version);
    names.forEach((name, index) => {
      const sub = path.join(dir ?? "", ["dmg", "msi", "nsis"][index]);
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, name), "x");
    });
    const result = run(["files", dir]);
    expect(result.status).toBe(0);
    expect(
      result.out
        .trim()
        .split("\n")
        .map((line) => path.basename(line))
        .sort(),
    ).toEqual([...names].sort());

    writeFileSync(path.join(dir, "extra.txt"), "x");
    expect(run(["files", dir])).toEqual({
      status: 1,
      out: expect.stringContaining("extra.txt, which is not a bundle"),
    });
  });

  it("checks a JSON list of draft assets against the local bundles", () => {
    dir = mkdtempSync(path.join(tmpdir(), "release-assets-"));
    const bundles = path.join(dir, "bundles");
    mkdirSync(bundles);
    const names = releaseAssetNames("QuipClip", version);
    for (const name of names) writeFileSync(path.join(bundles, name), name);
    const file = path.join(dir, "assets.json");
    /** @param {string} [changed] A name whose asset gets a wrong digest. */
    const write = (changed) =>
      writeFileSync(
        file,
        JSON.stringify(
          names.map((name) => ({
            name,
            state: "uploaded",
            size: 1,
            digest:
              name === changed ? "sha256:0" : fileDigest(path.join(bundles, name)),
          })),
        ),
      );
    write();
    expect(run(["draft", file, bundles]).status).toBe(0);
    write(names[1]);
    expect(run(["draft", file, bundles])).toEqual({
      status: 1,
      out: expect.stringContaining(`${names[1]} has the digest sha256:0`),
    });
    writeFileSync(file, JSON.stringify([]));
    expect(run(["draft", file, bundles]).status).toBe(1);
    expect(run(["draft", file]).status).toBe(2);
  });

  it("prints the usage for a wrong command", () => {
    expect(run(["upload"]).status).toBe(2);
  });
});
