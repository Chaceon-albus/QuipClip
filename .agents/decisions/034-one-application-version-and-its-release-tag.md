# 034. Keep one application version, and publish each release as immutable

- Status: Accepted
- Date: 2026-09-25
- Deciders: capric98

## Context

Before this record, three files set the application version to `0.1.0`:
`package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. `Cargo.lock`
repeats the value of `Cargo.toml`. No check kept the three values equal.

Tauri 2 uses the values in these places:

- When `tauri.conf.json` has a `version` field, Tauri uses that value for the bundles, for
  the `PackageInfo` of the application, and for the version resource of the Windows
  executable. The About panel of the macOS menu (`menu.rs`) reads `PackageInfo`.
- When `tauri.conf.json` has no `version` field, the Tauri runtime and the Tauri CLI use
  the `[package] version` of `Cargo.toml`. `tauri-winres` also uses that value for the
  Windows version resource.
- The `Cargo.toml` value also sets `CARGO_PKG_VERSION` and the `Cargo.lock` entry.
- Nothing reads the `package.json` value. The package is private, and nobody publishes it.
- Two more fields can set a version apart from the others. `bundle.macOS.bundleVersion`
  sets `CFBundleVersion`, and `bundle.windows.wix.version` sets the MSI product version.

A difference between the copies causes no error. For example, a change to
`tauri.conf.json` alone gives installers with the new version and a crate with the old
version.

The repository had no release workflow. The project wants GitHub immutable releases. When
a person publishes an immutable release, nobody can move its tag, and nobody can add,
change, or delete its assets. When a person deletes that release, nobody can use its tag
name again. The title and the notes stay editable. GitHub makes a release attestation at
the publish. GitHub recommends this order: make a draft release, attach all the assets,
then publish the draft. The repository setting applies only to releases that a person
publishes after the setting is on.

Thus a published release with a wrong version, a wrong commit, or a missing asset stays
wrong. The only correction is a new release with a new version.

## Decision

**One copy.** The `[package] version` of `src-tauri/Cargo.toml` is the only copy of the
application version that a person edits. `tauri.conf.json` and `package.json` have no
`version` field. No Tauri configuration file has `bundle.macOS.bundleVersion` or
`bundle.windows.wix.version`.

The copy stays in `Cargo.toml` and not in `tauri.conf.json`, although the Tauri
documentation recommends `tauri.conf.json`. A crate with no version gets the version
`0.0.0`, and that wrong value goes to `CARGO_PKG_VERSION` and to `Cargo.lock`. When we
remove the copy in `tauri.conf.json`, nothing gets a wrong value, because every tool then
reads `Cargo.toml`.

**Cargo writes the second copy.** `Cargo.lock` repeats the version, and only cargo writes
it. `cargo update --workspace` changes only the packages of the workspace. It still reads
the registry index. The script first tries it with `--offline`. It tries again with
network access only when cargo names offline mode as a possible cause.

**Release version form.** A release version is `MAJOR.MINOR.PATCH`, with no pre-release
part and no build part. `MAJOR` and `MINOR` are 255 or less, and `PATCH` is 65535 or less.
The limits come from the MSI product version, because `bundle.targets` is `"all"` and the
Windows build makes an MSI package. The MSI format accepts a pre-release part only when it
is all digits. A pre-release version needs a separate decision.

**Release tag.** The release tag is `v` and the version, for example `v0.2.0`. It is an
annotated tag on a commit on `main`, and the `Cargo.toml` of that commit has the version.

**The scripts.** `scripts/version.mjs` has three commands:

- `show` prints the version.
- `check [--tag <tag>]` finds a second copy, a `Cargo.lock` entry that does not agree, a
  version that is not a release version, and a tag that is not the release tag. It also
  refuses a JSON5 or TOML Tauri configuration file, because it cannot read one.
- `bump <major | minor | patch | X.Y.Z>` changes `Cargo.toml` and `Cargo.lock`. It does
  not commit, tag, or push. It restores both files when `cargo update` fails, when the
  user presses Ctrl-C, or when cargo changes a different package in `Cargo.lock`.

`scripts/release-assets.mjs` holds the one list of the assets of a release: the macOS
disk image for `aarch64`, the MSI package, and the NSIS installer. The release workflow
uses it to check the bundles and the draft.

`pnpm version:check` and `pnpm version:bump` run the version script. Vitest tests run the
check on the repository, so `pnpm test` fails in the gate and in CI when a second copy of
the version appears.

**The release workflow.** `.github/workflows/release.yml` makes one immutable release for
each release tag. It obeys these rules:

1. Only the push of a tag that matches `v*` starts it. A new push of the same tag stops
   the old run.
2. The `verify` job checks the tag name with `scripts/version.mjs`. It also makes sure
   that the tag is annotated, that the tag points at the checked out commit, and that
   `main` contains that commit.
3. The `ci` job runs `ci.yml` on the tagged commit, through `workflow_call`. Nothing
   builds when the gate fails on that commit.
4. The `build` jobs make the bundles for macOS on `aarch64` and Windows on `x86_64`. The
   maintainer decided that the release has no macOS `x86_64` bundle. The jobs keep the
   bundles as workflow artifacts. Their token can only read. They use no dependency
   cache, so a cache from a different run cannot change a published bundle.
   `cargo fetch --locked` stops a build that would change `Cargo.lock`.
5. The `draft` job finds the draft release of the tag, or makes one on the tagged commit.
   It stops when a published release of the tag exists. It deletes the old assets of the
   draft and attaches the bundles. Then it checks that the draft holds exactly the
   expected assets, and that the SHA-256 digest of each asset is the digest of its bundle.
6. The `publish` job runs in the `release` environment. A person can add required
   reviewers to that environment, who inspect the draft first. After the approval, the job
   checks the draft assets and their digests again. It checks the tag immediately before
   it publishes the draft. Nothing else publishes a release.
7. The release becomes Latest only when no other published release has a higher version.
8. After the publish, the job makes sure that the release is immutable, and it runs
   `gh release verify`. A failure in these two steps does not make the release wrong.

Only the `draft` and `publish` jobs have a token that can write. They run the scripts of
the repository, `gh`, and `curl`, and no build code. Each action is pinned to a commit.

**macOS signature.** `tauri.macos.conf.json` sets `bundle.macOS.signingIdentity` to `-`,
so the Tauri bundler signs the macOS bundle ad hoc. Without it, the bundle has only the
signature of the linker and no sealed resources, and `codesign --verify --deep --strict`
refuses it. macOS can then say that a downloaded copy is damaged. The ad-hoc signature
passes that check. macOS still blocks the first start, because the bundle has no
Developer ID and nobody notarizes it.

**Re-runs.** A re-run uses the workflow file of the tagged commit.

- When a job fails for a temporary cause, use "Re-run failed jobs". The artifacts of the
  `build` jobs that passed stay available to the re-run. GitHub allows a re-run for 30
  days, and the artifacts stay for 30 days.
- When the fault is in the source or in the workflow file, a re-run cannot correct it.

**Tags.** Before the publish, no published release of the tag exists. When a fault needs
a change to the source, delete the draft and the tag. Correct the fault on `main`, and
make the tag again on the new commit. The version stays the same. After the publish,
nobody can move or delete the tag.

## Consequences

- A release changes one line in `Cargo.toml` and one line in `Cargo.lock`, and the script
  writes both.
- `pnpm test` fails when a second copy of the version appears, or when `Cargo.lock` does
  not agree with `Cargo.toml`.
- `package.json` has no version. `npm version` and `pnpm version` add the field again, so
  do not use them.
- The project cannot make a pre-release version until a new decision allows one.
- A version that a published release used stays used. The next release takes the next
  version.
- Each release runs the full CI again on the tagged commit, and the bundles build with no
  cache. A release takes longer than a push to `main`.
- `scripts/release-assets.mjs` knows the bundle names of Tauri 2. When Tauri changes a
  bundle name, the check stops the publish. The script then needs a change on `main`, and
  the tag moves to the new commit.
- The pinned actions do not update. A person updates them by hand.
- A Mac with an Intel processor gets no bundle. It cannot run the `aarch64` disk image,
  because Rosetta translates only `x86_64` code on Apple silicon.
- The bundles have no signature from a developer identity. macOS blocks the first start
  until the user allows it in Privacy & Security, and Windows SmartScreen warns at the
  first start. A published release cannot get signed bundles later. Signed bundles need a
  new decision and a new version.
