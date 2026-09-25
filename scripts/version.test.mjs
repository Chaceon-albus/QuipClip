import { describe, expect, it } from "vitest";
import {
  checkFiles,
  lockWithoutVersion,
  nextVersion,
  parseVersion,
  readLockVersion,
  readManifest,
  readRepoFiles,
  replaceManifestVersion,
  tagFor,
} from "./version.mjs";

const MANIFEST = `[package]
name = "quipclip"
# A comment above the version.
version = "1.2.3"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies.serde]
version = "1"
`;

const LOCK = `version = 4

[[package]]
name = "quipclip"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "quipclip"
version = "1.2.3"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

/** @param {Partial<import("./version.mjs").RepoFiles>} [changes] */
function files(changes = {}) {
  return {
    manifest: MANIFEST,
    lock: LOCK,
    packageJson: JSON.stringify({ name: "quipclip", private: true }),
    tauriConfigs: {
      "src-tauri/tauri.conf.json": JSON.stringify({ productName: "QuipClip" }),
    },
    unreadConfigs: [],
    ...changes,
  };
}

describe("parseVersion", () => {
  it("accepts MAJOR.MINOR.PATCH up to the MSI limits", () => {
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseVersion("255.255.65535")).toEqual({
      major: 255,
      minor: 255,
      patch: 65535,
    });
  });

  it.each([
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "v1.2.3",
    " 1.2.3",
    "1.2.3-beta.1",
    "1.2.3-1",
    "1.2.3+4",
    "",
  ])("refuses %j", (text) => {
    expect(() => parseVersion(text)).toThrow(/not a release version/);
  });

  it.each(["256.0.0", "0.256.0", "0.0.65536"])(
    "refuses %s, which the MSI bundle cannot hold",
    (text) => {
      expect(() => parseVersion(text)).toThrow(/MSI/);
    },
  );
});

describe("nextVersion", () => {
  it("raises one part and sets the lower parts to zero", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("accepts an explicit version that is higher", () => {
    expect(nextVersion("1.2.3", "1.10.0")).toBe("1.10.0");
  });

  it("refuses a version that is not higher", () => {
    expect(() => nextVersion("1.2.3", "1.2.3")).toThrow(/not higher/);
    expect(() => nextVersion("1.2.3", "1.1.9")).toThrow(/not higher/);
  });

  it("refuses a result above the MSI limits", () => {
    expect(() => nextVersion("255.0.0", "major")).toThrow(/MSI/);
    expect(() => nextVersion("0.0.65535", "patch")).toThrow(/MSI/);
  });

  it("refuses a request that is not a part name or a version", () => {
    expect(() => nextVersion("1.2.3", "prerelease")).toThrow(/not a release version/);
  });
});

describe("the Cargo.toml version", () => {
  it("reads the name and the version of the [package] table only", () => {
    expect(readManifest(MANIFEST)).toEqual({ name: "quipclip", version: "1.2.3" });
  });

  it("changes only the version line of the [package] table", () => {
    const changed = replaceManifestVersion(MANIFEST, "1.3.0");
    expect(changed).toBe(MANIFEST.replace('version = "1.2.3"', 'version = "1.3.0"'));
    expect(changed).toContain('tauri-build = { version = "2", features = [] }');
    expect(changed).toContain('[dependencies.serde]\nversion = "1"');
  });

  it("keeps CRLF line ends and a trailing comment", () => {
    const text = '[package]\r\nname = "a"\r\nversion = "1.0.0" # note\r\n';
    expect(readManifest(text).version).toBe("1.0.0");
    expect(replaceManifestVersion(text, "1.0.1")).toBe(
      '[package]\r\nname = "a"\r\nversion = "1.0.1" # note\r\n',
    );
  });

  it("refuses a [package] table with no string version", () => {
    expect(() =>
      readManifest('[package]\nname = "a"\nversion.workspace = true\n'),
    ).toThrow(/one version/);
    expect(() =>
      readManifest('[package]\nname = "a"\n\n[lib]\nversion = "1"\n'),
    ).toThrow(/one version/);
  });

  it("refuses a manifest with no [package] table", () => {
    expect(() => readManifest('[workspace]\nmembers = ["a"]\n')).toThrow(
      /no \[package\]/,
    );
  });
});

describe("readLockVersion", () => {
  it("reads the workspace package and skips a registry package of the same name", () => {
    expect(readLockVersion(LOCK, "quipclip")).toBe("1.2.3");
  });

  it("refuses a lock file with no workspace package of that name", () => {
    expect(() => readLockVersion(LOCK, "other")).toThrow(/It has 0/);
  });
});

describe("lockWithoutVersion", () => {
  it("ignores only the version of the workspace package", () => {
    const bumped = LOCK.replace(
      'name = "quipclip"\nversion = "1.2.3"',
      'name = "quipclip"\nversion = "1.3.0"',
    );
    expect(bumped).not.toBe(LOCK);
    expect(lockWithoutVersion(bumped, "quipclip")).toBe(
      lockWithoutVersion(LOCK, "quipclip"),
    );
    expect(lockWithoutVersion(LOCK, "quipclip")).toContain('version = "9.9.9"');
  });

  it("finds a change to another package", () => {
    const changed = LOCK.replace(
      'name = "serde"\nversion = "1.0.0"',
      'name = "serde"\nversion = "1.0.1"',
    );
    expect(lockWithoutVersion(changed, "quipclip")).not.toBe(
      lockWithoutVersion(LOCK, "quipclip"),
    );
  });
});

describe("checkFiles", () => {
  it("finds no problem when Cargo.toml holds the only copy", () => {
    expect(checkFiles(files())).toEqual({ version: "1.2.3", problems: [] });
  });

  it("finds a version in package.json or in a Tauri configuration file", () => {
    const { problems } = checkFiles(
      files({
        packageJson: JSON.stringify({ name: "quipclip", version: "1.2.3" }),
        tauriConfigs: {
          "src-tauri/tauri.conf.json": JSON.stringify({ productName: "QuipClip" }),
          "src-tauri/tauri.windows.conf.json": JSON.stringify({ version: "1.2.3" }),
        },
      }),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^package\.json has a "version" field/);
    expect(problems[1]).toMatch(
      /^src-tauri\/tauri\.windows\.conf\.json has a "version"/,
    );
  });

  it("finds a Tauri field that sets the macOS or the MSI version apart", () => {
    const config = {
      bundle: {
        macOS: { bundleVersion: "7", minimumSystemVersion: "10.15" },
        windows: { wix: { version: "1.2.3.4", language: "en-US" } },
      },
    };
    const { problems } = checkFiles(
      files({
        tauriConfigs: { "src-tauri/tauri.conf.json": JSON.stringify(config) },
      }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/"bundle\.macOS\.bundleVersion" field/),
      expect.stringMatching(/"bundle\.windows\.wix\.version" field/),
    ]);
    const lowerCase = { bundle: { macos: { bundleVersion: "7" } } };
    expect(
      checkFiles(
        files({
          tauriConfigs: { "src-tauri/tauri.conf.json": JSON.stringify(lowerCase) },
        }),
      ).problems,
    ).toEqual([expect.stringMatching(/"bundle\.macos\.bundleVersion" field/)]);
  });

  it("ignores a field named version below another key", () => {
    const config = { plugins: { version: "1" }, bundle: { windows: { version: "1" } } };
    expect(
      checkFiles(
        files({
          tauriConfigs: { "src-tauri/tauri.conf.json": JSON.stringify(config) },
        }),
      ).problems,
    ).toEqual([]);
  });

  it("refuses a Tauri configuration file that it cannot read", () => {
    const { problems } = checkFiles(files({ unreadConfigs: ["src-tauri/Tauri.toml"] }));
    expect(problems).toEqual([expect.stringMatching(/^src-tauri\/Tauri\.toml exists/)]);
  });

  it("finds a file that is not valid JSON", () => {
    const { problems } = checkFiles(files({ packageJson: "{" }));
    expect(problems).toEqual([
      expect.stringMatching(/^package\.json is not valid JSON/),
    ]);
  });

  it("finds a lock file that records a different version", () => {
    const { problems } = checkFiles(
      files({ manifest: replaceManifestVersion(MANIFEST, "1.2.4") }),
    );
    expect(problems).toEqual([
      expect.stringMatching(/Cargo\.lock records quipclip 1\.2\.3/),
    ]);
  });

  it("finds a Cargo.toml version that is not a release version", () => {
    const { problems } = checkFiles(
      files({ manifest: MANIFEST.replace('"1.2.3"', '"1.2.3-beta.1"') }),
    );
    expect(problems[0]).toMatch(/not a release version/);
  });

  it("compares a tag with the release tag of the version", () => {
    expect(tagFor("1.2.3")).toBe("v1.2.3");
    expect(checkFiles(files(), "v1.2.3").problems).toEqual([]);
    for (const tag of ["1.2.3", "v1.2.4", "refs/tags/v1.2.3", "app-v1.2.3"]) {
      expect(checkFiles(files(), tag).problems).toEqual([
        expect.stringMatching(/release tag is "v1\.2\.3"/),
      ]);
    }
  });
});

describe("this repository", () => {
  it("holds one application version, in src-tauri/Cargo.toml", () => {
    const { version, problems } = checkFiles(readRepoFiles());
    expect(problems).toEqual([]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
