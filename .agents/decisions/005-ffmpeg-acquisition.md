# 005. Find ffmpeg on the system, then in app data, then download it with consent

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

QuipClip needs `ffmpeg` and `ffprobe`. It must not bundle them:

- The builds that hold `libx264`, `libx265`, and NVENC are GPL. Shipping them inside a
  closed installer creates a licence obligation.
- A bundled copy adds near 80 MB per platform to the installer.

The user set this order: check the environment, then check the application data directory,
then ask the user and download.

A check of the release APIs on 2026-08-29 found one hard constraint. **BtbN/FFmpeg-Builds
publishes no macOS asset.** The release holds only `win64`, `winarm64`, `linux64`, and
`linuxarm64`. macOS therefore needs a second source. `ffmpeg.martin-riedl.de` serves static
macOS builds for `arm64` and `amd64`. It ships `ffmpeg` and `ffprobe` as separate archives.
A `redirect/latest/...` URL answers 307 with a pinned versioned path.

## Decision

**Resolution order**, first hit wins:

1. An explicit path saved in the application settings.
2. A `PATH` lookup.
3. `<app_data_dir>/bin/ffmpeg[.exe]` and `<app_data_dir>/bin/ffprobe[.exe]`.
4. Ask the user for consent, then download.

`app_data_dir()` from the Tauri path API already follows both platform rules:
`%APPDATA%\<identifier>` on Windows, and `~/Library/Application Support/<identifier>` on
macOS. The application does not build these paths by hand.

**Manifest.** `src-tauri/resources/ffmpeg-manifest.json` maps a target triple to a URL, a
SHA-256, an archive kind, and the path inside the archive.

| Target | Source |
|---|---|
| `windows-x86_64` | BtbN `ffmpeg-n9.0-latest-win64-gpl-9.0.zip` |
| `windows-aarch64` | BtbN `ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip` |
| `macos-aarch64` | `ffmpeg.martin-riedl.de` macOS arm64, two archives |
| `macos-x86_64` | `ffmpeg.martin-riedl.de` macOS amd64, two archives |

Both sources publish checksums, so the manifest script reads them instead of downloading
tens of megabytes to hash. BtbN publishes a `checksums.sha256` asset on the release. The
macOS source serves a `<file>.sha256` sidecar next to each archive, but only on the pinned
versioned path. The `redirect/latest/` path serves no sidecar.

`scripts/update-ffmpeg-manifest.ts` resolves the redirects, reads the published checksums,
and rewrites the manifest. The manifest is never generated at run time, because a checksum
fetched at run time is not a check.

**BtbN replaces the assets on a tag named `latest`.** A pinned hash therefore stops
matching for users who already installed the application, not only for the maintainer. This
is expected, and it is not a security event. On a hash mismatch the application does not
install the file. It reports the mismatch and offers the same choices as the consent
dialog: pick an existing binary, or install through another route.

**Consent.** The dialog states the licence of the build. It states the download size. It
offers two alternatives. The user can choose an existing binary. On macOS the user can
install through Homebrew. The application never downloads before the user agrees.

The licence flags of a build are in the `configuration:` line of `ffmpeg -version`, as
`--enable-gpl`, `--enable-nonfree`, and `--enable-version3`. The dialog reads them from
there for a binary that was already on the system.

**Install.** Verify the SHA-256 before any extraction. Extract into a temporary directory.
Set mode `0755` on Unix. Rename into `bin/` as the last step, so a failed download never
leaves a half-written binary in place. Then run `ffmpeg -version` and `ffprobe -version` to
confirm the result.

A file that Rust writes carries no `com.apple.quarantine` attribute, so Gatekeeper does not
block it. The macOS builds also carry a Developer ID signature. The installer clears the
attribute anyway, because the cost is one call.

## Consequences

- No GPL binary ships in the installer, so the licence obligation stays with the user.
- Two download sources means two failure modes and two update paths. The manifest script
  hides the difference from the application code.
- A pinned hash goes stale when a source publishes a new build. The mismatch path must be a
  normal, tested branch of the installer, not an error dialog.
- A user behind a firewall can still work. The settings path and the `PATH` lookup need no
  network.
