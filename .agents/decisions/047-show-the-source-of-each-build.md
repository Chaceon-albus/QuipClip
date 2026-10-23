# 047. Show the source of each build beside the version

- Status: Accepted
- Date: 2026-10-23
- Deciders: capric98
- Amends: ADR 018, ADR 034, ADR 038

## Context

A release and a build from a later commit can have the same version. `Cargo.toml` changes
its version only for a release (ADR 034). A person who runs `git pull` and then
`pnpm tauri build` gets the version of the last release. Nothing in the application shows
that this build is not that release.

The user asked for a mark that distinguishes these builds. The version cannot hold the mark:

- The MSI bundle accepts a build part in a version only when that part is a number of 65535
  or less. A commit hash is not such a number, and `bundle.targets` is `"all"`.
- ADR 034 permits only `MAJOR.MINOR.PATCH`, and `pnpm test` refuses every other form.

Before this record, only the About panel of the macOS menu showed the version. No view on
Windows showed it.

## Decision

### The source of a build

Each build records its source: the abbreviated hash of the commit, the branch, and a modified
flag. The version does not change.

- The source does not name the branch on `main` or when HEAD is detached. The checkout of a
  release tag has a detached HEAD, so a release shows only its commit.
- The modified flag is true when a tracked file differs from the commit. An untracked file
  does not count. Scratch files would otherwise mark almost every local build as modified,
  and a new source file usually comes with a change to a tracked file that names it. The
  submodules under `.agents/` do not count.
- A build with no git checkout, or with no git, has no source. It shows only the version.

### Where git runs

`build.rs` runs `git` at compile time. It gives the three values to the crate as
compile-time environment variables, and `src-tauri/src/build_info.rs` reads them.
`git status` runs with `--no-optional-locks`, so it does not write the index.

tauri-build names the files that it reads, so cargo runs the build script again only when a
named file changes. The build script names these paths:

- HEAD, the loose branch refs, the packed refs, and `reftable` for a repository in the
  reftable format. `git rev-parse --git-path` gives their paths. A pull, a commit, a
  checkout, and a reset change one of them.
- `src-tauri/src`. A change to the Rust sources compiles the crate again.
- `dist` at the repository root, in a bundled build only. That build embeds `dist`, so a
  change to it compiles the crate again. `pnpm tauri build` writes `dist` first.

The script names only a path that exists. When a named path does not exist, cargo runs the
script on every build.

The modified flag of a dev build can be out of date. In `pnpm tauri dev`, a change to the
frontend alone does not run the build script again. A `git stash` that changes no Rust file
does not run it either. The next change to the Rust sources reads the flag again.

### The exemption from ADR 018

`build.rs` holds a second `#[allow(clippy::disallowed_methods)]`, for `Command::new`. The rule
of ADR 018 keeps a console window away from a child of the application. The build script runs
inside cargo at compile time, never in the application. It cannot use `procutil`, which is
part of the library.

### Where the source shows

- The About panel of the macOS menu shows the source in parentheses after the version, in
  English: `Version 0.1.1 (feature/trim a1b2c3d, modified)`. A build with no source keeps the
  default text of the panel.
- The Settings window has a fourth tab, About, after Export Presets. It shows the name of the
  application and one line with the version and the source, in the language of the interface.
  Each form of the line is one complete message in the catalogs (ADR 011). A person can
  select the line and copy it into a bug report. The tab can show the licenses later.
- The main window shows nothing new.

### The command

`build_info` returns the version and the source. Only the Settings window may call it.
`open_settings_window` accepts the section `about`.

## Consequences

- A build from a commit after a release looks different from the release, on both
  platforms.
- A release build also shows its commit. That commit is the commit of the release tag.
- Two builds of one commit look the same, also when the release workflow made one of them.
- The modified flag of a dev build can be out of date until the next change to the Rust
  sources.
- A new untracked file alone under `public/` or `src-tauri/capabilities/` changes the build,
  but the modified flag stays false.
- Each change to the Rust sources now runs the whole build script again, tauri-build
  included. The crate compiles again in any case, but each incremental build takes longer.
- Each bundled build runs the build script again, because `dist` changes. Such a build
  compiles the crate again in any case.
- git decides the length of the abbreviated hash. Two clones of the repository can give two
  lengths for one commit.
- ADR 034: the version keeps its form. The source is not part of the version.
- ADR 038: the Settings window has four tabs, and its capability grants `build_info`.
