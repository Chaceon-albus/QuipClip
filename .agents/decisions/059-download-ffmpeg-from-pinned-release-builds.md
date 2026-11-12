# 059. Download ffmpeg from pinned release builds into the local data directory

- Status: Accepted
- Date: 2026-11-05
- Deciders: capric98
- Amends: ADR 005, ADR 006, ADR 017, ADR 038, ADR 057

(Changed on 2026-11-12.) This record had the number 058 at first. The record of an FLV that a
recorder still writes also took 058 on another branch, and that branch was published first. A
merge joined the two branches. That record keeps 058, and this record has 059. The commits that
built this download name this record ADR 058.

## Context

ADR 005 gives four steps to find `ffmpeg` and `ffprobe`. Steps 1 to 3 are implemented. Step 4,
a download that the user agrees to, is not (ADR 005, note of 2026-11-04). A user with no
`ffmpeg` must install it by hand before QuipClip can open a video.

A check of the sources on 2026-11-05 found these facts:

- **BtbN/FFmpeg-Builds** uploads its `latest` assets again every day. The `latest` zip of a day
  is not the same file as the dated zip of that day. A SHA-256 of a `latest` asset therefore
  stops matching within one day. The dated `autobuild-…` tags stay for 14 days, and the last
  build of each month stays for two years.
- **Gyan** publishes its Windows builds on GitHub, in `GyanD/codexffmpeg`, with one tag for each
  FFmpeg release. The highest release tag is `9.0.2`. The tag `7.1` of 2024 still serves its
  assets. The GitHub API gives a SHA-256 `digest` for each asset. The builds are GPLv3, 64-bit
  and static.
- The Gyan **essentials** build has no `libsvtav1`. The **full** build has it. A default preset
  uses `libsvtav1` (ADR 040). The full zip, `ffmpeg-9.0.2-full_build.zip`, is about 258 MB.
  gyan.dev serves the full build only as `.7z`, so the full zip is on GitHub only.
- **ffmpeg.martin-riedl.de** serves macOS builds on versioned paths, for example
  `/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip`, with one zip for `ffmpeg` and one for
  `ffprobe`. Each zip has a `.sha256` file beside it on the versioned path only. The same path
  holds `versions.txt`, with the `-version` output of the build. The 9.0.2 build for arm64 has
  `libsvtav1`, `libx264`, `libx265` and `libopus`, and its configuration has `--enable-gpl
  --enable-version3`. The programs in the zips are signed and not notarized.
- No public build has `libfdk_aac`. It is a nonfree library, so a build with it cannot be
  distributed.
- On Windows, `app_data_dir()` is `%APPDATA%\<id>`, in the roaming profile (ADR 057). The two
  programs of the full build are large. A roaming profile copies them to each computer, and the
  sign-in gets slower.

The user chose these points:

- Windows uses the Gyan full zip of the highest release. A script pins it again at each
  QuipClip release.
- QuipClip offers the download only in the FFmpeg tab of the Settings window.
- An archive can have more than one URL for the same bytes. QuipClip has no mirror setting.
- A close of the Settings window or a quit cancels the download, with no question.
- The programs go into the local data directory, not into the roaming profile.

## Decision

### Sources

| Target           | Source                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `windows-x86_64` | Gyan, `ffmpeg-<version>-full_build.zip` of the highest release tag  |
| `macos-aarch64`  | martin-riedl, `ffmpeg.zip` and `ffprobe.zip` of the current release |

The target is the compile target of QuipClip, not the processor of the computer. These two
targets are the bundles of ADR 034. Windows on Arm runs the `x86_64` bundle, so it gets the
`x86_64` download and runs it through emulation. A build of QuipClip for another target has no
entry, and it offers no download. The install guide of the FFmpeg tab is then the only help.

### The manifest pins each file

`src-tauri/resources/ffmpeg-manifest.json` holds one entry for each target. The application
embeds the file when it compiles (`include_str!`), so the file is not a bundle resource. An
entry holds these values:

- The FFmpeg version, and the host that the user sees.
- The licence flags `gpl`, `version3` and `nonfree`.
- Each archive: its URLs, its SHA-256 and its size.
- Each program in an archive: its exact path in the zip, its compression method and its size
  after extraction.

A URL is the stable address of the file: the `browser_download_url` of a GitHub asset, or the
versioned path of martin-riedl. It is never the CDN address that the stable address redirects
to, because that address expires.

An archive can list more than one URL. All its URLs serve the same bytes, and QuipClip tries
them in order. Today no source has a second URL, so each archive has one URL.

QuipClip never asks a source for a version or a SHA-256 at run time. A SHA-256 that comes from
the host of the file at the time of the download does not check that file. The manifest is the
only source of a SHA-256.

### The script

`scripts/ffmpeg-manifest.mjs` writes the manifest. `pnpm ffmpeg:manifest` runs it. ADR 005 named
`scripts/update-ffmpeg-manifest.ts`. The scripts of this repository are `.mjs` modules that
node runs, so the script follows them.

- **Gyan.** The script reads the releases of `GyanD/codexffmpeg` from the GitHub API. It takes
  the release with the highest version among the releases that are not pre-releases. It takes
  the URL, the size and the `digest` of its `*-full_build.zip` asset. Gyan states the licence in
  prose only, so the script holds the flags `gpl` and `version3` as constants.
- **martin-riedl.** The script reads the `Location` of
  `redirect/latest/macos/arm64/release/ffmpeg.zip` and of `ffprobe.zip`, with no body. That
  gives the versioned path of the current release. Then it reads the `.sha256` file of each zip,
  the size from a `HEAD` request, and the licence flags from `versions.txt`.
- **Each zip.** The script reads the central directory of the zip with HTTP range requests. When
  a host does not serve a range, the script downloads the zip once, checks its SHA-256, and
  reads the directory from the file. It records the exact path, the method and the size of each
  program. It refuses a method other than stored or deflate.
- **A second URL.** The script adds a second URL only when the published SHA-256 of that URL is
  the SHA-256 of the first URL.
- The script reads `GITHUB_TOKEN` when it is set, because the GitHub API limits requests with
  no token.

At each release, the maintainer runs the script before the version bump. When the manifest
changes, the maintainer commits it alone, with `chore(ffmpeg)`, and waits for CI on that commit.
`docs/releasing.md` gets this step together with the script. A QuipClip release therefore
downloads the highest FFmpeg release at the time when the maintainer ran the script. An older
QuipClip downloads an older FFmpeg.

### The programs go into `<local_data>/bin`

`<local_data>` is `app_local_data_dir()` of Tauri:

| System  | Directory                                                       |
| ------- | --------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\io.github.capric98.quipclip\bin`                |
| macOS   | `~/Library/Application Support/io.github.capric98.quipclip/bin` |

Discovery searches `<local_data>/bin` after `<app_data>/bin`. Its origin is `appData`, so the
wire contract of ADR 006 does not change. On macOS the two directories are one directory, and
the stable deduplication of discovery removes the second candidate.

On Windows, `%LOCALAPPDATA%\<id>` is also the cache directory of ADR 057. `bin` is therefore a
name at the top of the cache directory. No cleanup removes it.

### When QuipClip offers the download

Only Rust decides. The command `ffmpeg_download_offer` returns the offer when all of these
conditions are true. Otherwise it returns nothing.

1. The manifest has an entry for the compile target.
2. Tauri gives `app_local_data_dir()` and `app_cache_dir()`.
3. One of these is true:
   - Discovery finds no pair.
   - Discovery finds a pair whose two canonical paths are in the canonical `<local_data>/bin`,
     and the version check of that pair fails. The version check runs `ffmpeg -version` and
     `ffprobe -version`. It fails when a program does not start, exits with an error, runs for
     more than 10 s, or prints no version line. It also fails when the two programs print two
     different versions.

The second case is usually a damaged earlier download. On macOS it can also be a pair that the
user put into `<app_data>/bin`. The page asks for the offer each time the FFmpeg tab shows the
status `missing` or `failed`. The command `start_ffmpeg_install` checks the same conditions
again. Condition 1 gives `unsupportedTarget`. Condition 2 gives `appDataUnavailable` or
`workDirectoryUnavailable`. Condition 3 gives `alreadyFound`.

A pair that discovery finds and that passes the version check is never replaced. A pair that
fails the check is not in use by QuipClip. On Windows, a move onto a program that runs fails
with `writeFailed` and does not stop that program.

### The consent

Before the download, a dialog shows the FFmpeg version, the host, the licence, the download
size and the directory. It also says that the download replaces a file of the same name in that
directory, and that a path in Settings stays first. The dialog offers Choose File… as the
alternative. The install guide of the tab stays visible: Homebrew on macOS, `winget` on
Windows. QuipClip downloads nothing before the user agrees.

(Changed on 2026-11-05.) The dialog says that the download replaces a program only when the
offer is for a pair in `<local_data>/bin` that fails the version check. When that directory holds
only one of the two programs, the install replaces that file, and the dialog does not say so. The
tab shows the install guide only for the status `missing`. This also applies to the guide after
`sizeMismatch` or `hashMismatch`, and after a deleted source file. When the status is `failed`,
the text of the offer does not refer to the guide.

### The install

1. QuipClip downloads each archive into the install work directory,
   `<cache>/work/ffmpeg-install-<pid>-<n>/`. It computes the SHA-256 while the bytes arrive. It
   stops with `sizeMismatch` when the body gets longer than the size of the manifest. At the
   end it compares the size and the SHA-256 with the manifest.
2. It extracts only the two programs, and compares the size of each with the manifest. The zip
   reader checks the CRC. It deletes each zip after its extraction.
3. On Unix it sets the mode `0755`. On macOS it also removes `com.apple.quarantine`, and it
   ignores a failure of that step.
4. It runs the version check of the two programs. The version must start with the version of
   the manifest, and the licence flags must equal the flags of the manifest. So QuipClip never
   installs a build whose licence is not the licence of the dialog.
5. It moves `ffprobe` and then `ffmpeg` into `<local_data>/bin` with
   `fsutil::replace_file_within` (ADR 015). The budget is 30 s, as for the publication of an
   export (ADR 016). When the two directories are on two volumes, it first copies the program
   into a temporary file in `bin`. On Unix it then sets the mode `0755` again. Then it replaces
   the destination with the temporary file. On Unix, a destination file with no write
   permission makes the move fail.
6. It removes the install work directory.

ADR 005 ran `-version` after the rename. This record runs it before, so a program that fails the
check never reaches `bin`.

The HTTP client uses HTTPS only. It follows at most 10 redirects, and each redirect must go to
an HTTPS address. It has no list of allowed hosts, because the SHA-256 of the manifest is what
QuipClip trusts. It uses the proxy of the system, and it does not read a PAC file. A connection
must open within 30 s. A read that gets no byte for 60 s fails. The download has no limit of
total time.

(Added on 2026-11-05.) Until the response head arrives, the limit of 60 s is one limit for the
whole request: the connection, the TLS, each redirect and the wait for the server. The client
does not start that limit again at a redirect.

Only a network failure, an HTTP status, a wrong size or a wrong SHA-256 makes QuipClip try the
next URL. A local failure, such as `writeFailed`, `workDirectoryUnavailable` or `canceled`,
stops the install at once. When each URL fails, the result is `hashMismatch` if one URL gave a
wrong SHA-256. Otherwise it is `sizeMismatch` if one URL gave a wrong size. Otherwise it is the
error of the last URL.

The error codes are `unsupportedTarget`, `busy`, `alreadyFound`, `appDataUnavailable`,
`workDirectoryUnavailable`, `networkFailed`, `httpStatus`, `sizeMismatch`, `hashMismatch`,
`archiveInvalid`, `entryMissing`, `writeFailed`, `versionCheckFailed` and `canceled`. After
`sizeMismatch` or `hashMismatch`, the same URL would give the same bytes again. The tab then
offers Choose File… and the install guide, and not Try Again.

(Added on 2026-11-05.) A fifteenth code, `commandExecutionFailed`, reports an install that could
not run: its thread did not start, or it stopped on an internal error. The page also uses
`commandExecutionFailed` for a refusal with no known code, and `invalidResponse` for a reply or a
message of the wrong shape. The tab offers Try Again after `busy`, `networkFailed`,
`httpStatus`, `workDirectoryUnavailable`, `writeFailed`, `commandExecutionFailed` and
`invalidResponse`, while the tab still shows the offer, because a new attempt with the same files
can succeed. It offers no Try Again after the other codes.

### The commands

| Command                 | Use                                                     |
| ----------------------- | ------------------------------------------------------- |
| `ffmpeg_download_offer` | The offer for the dialog, or nothing                    |
| `start_ffmpeg_install`  | Starts the one install job, with a channel for progress |
| `cancel_ffmpeg_install` | Cancels that job                                        |

Only the Settings window may call these commands (ADR 038). The job sends its progress and its
end through a channel, as the envelope job of ADR 056 does. So the install needs no new event.

(Added on 2026-11-05.) `start_ffmpeg_install` takes the slot first, and it checks the conditions
of the offer while it holds the slot. So a second request gets `busy` before the version check,
and the check cannot pass for a pair that a running install replaces. A close or a reload of the
Settings window stops that version check, and the request then gives `canceled`. The job removes
its work directory and frees the slot. Then it sends its end. So a page that starts again at the
end finds the slot free.

### Cancel and exit

The download belongs to the Settings window. A close or a reload of that window cancels it. A
quit signals the cancel and does not wait for it. Nothing asks the user first.

A kill at any time leaves each file in `bin` as it was, or complete, because each file arrives
by a rename. A kill between the two moves can leave a new `ffprobe` beside an old `ffmpeg`. The
two programs then print two different versions, so the pair fails the version check, and the
offer shows again.

### Changes to ADR 057

- The layout of the cache directory gains `<cache>/work/ffmpeg-install-<pid>-<n>/`. The install
  removes it, and the sweep below removes one that a kill left.
- The install is a third step that creates `work`, after the export and the preset test.
- The cleanup at start gains two steps, 5 and 6, after the four steps of ADR 057. They also
  run before each install.
  - In `<cache>/work/`, it removes each install work directory of at least 24 hours that this
    process does not use.
  - In `<local_data>/bin`, it removes each temporary file of `fsutil` of at least 24 hours.
    Such a file has a name of the form `.<name>.tmp-<pid>-<n>`. This step needs the local data
    directory.

### Changes to other records

- ADR 006: discovery searches `<local_data>/bin` after the application data directory.
- ADR 017: the exit handler signals the cancel of the install and does not wait. The install
  writes into `bin` only by a rename, so the handler gives it no part of its budget.
- ADR 038: the Settings window may call the three commands above, and only that window.

## Consequences

- A user with no `ffmpeg` can get it from the FFmpeg tab of Settings.
- The Windows download is about 258 MB. It has `libsvtav1` and the hardware encoders of the
  full build.
- At its peak, the install uses the disk space of the zips and of the extracted programs.
- No download has `libfdk_aac`. The download gives the `aac` encoder of FFmpeg. On macOS it also
  gives `aac_at` when the build has AudioToolbox.
- The manifest proves only that a file is the file that the source served when the maintainer
  ran the script. It does not prove that the source is honest.
- When a source deletes a pinned file, the download of that QuipClip release fails. The tab then
  shows the error and the install guide. A later release pins a new file.
- After a quit or a kill, the install work directory stays until a start or an install that
  comes at least 24 hours later.
- An uninstall keeps the download, unless the uninstaller deletes the application data.
- The desktop build gains an HTTP client and a zip reader, so the application gets larger.
- A pair on `PATH`, or in `<app_data>/bin` on Windows, that fails gets no offer. The user chose
  that pair, so QuipClip does not replace it.
- Two QuipClip processes can install at the same time. Each has its own install work directory,
  and the last successful move of each file wins. On Windows, a move onto a program in use
  fails.
- On Windows the origin `appData` now covers two directories. The text of the FFmpeg tab and the
  README must name both.
- The release steps gain one step: run the script before the version bump.
