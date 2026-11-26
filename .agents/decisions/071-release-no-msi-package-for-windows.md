# 071. Release no MSI package for Windows

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 034

## Context

`tauri.conf.json` sets `bundle.targets` to `"all"`. Thus the Windows build of the release
workflow makes two bundles: an MSI package and an NSIS installer (`-setup.exe`). The
releases 0.1.0 to 0.2.1 hold both bundles.

The two bundles install the same application. They are different only in the install:

- With the defaults of Tauri 2, the NSIS installer installs QuipClip for the current user,
  below `%LOCALAPPDATA%`. It does not need administrator rights.
- The MSI package installs QuipClip for all users, below `Program Files`. It needs
  administrator rights. An administrator can also send it to many computers, for example
  with Group Policy.

One person installs QuipClip on their own computer. The project knows of no user who
installs it on many computers. Two Windows bundles make the user choose between them. When a
user installs both bundles, the computer has two copies of QuipClip.

The MSI product version also sets the limits of the release version form (ADR 034). `MAJOR`
and `MINOR` are 255 or less, and `PATCH` is 65535 or less.

The NSIS template of the Tauri CLI 2.12.4 looks for an installation from an MSI package. It
reads the uninstall keys below `HKLM`. It looks for a key with the same product name and
publisher, and with an uninstall command that starts with `msiexec`. When it finds one, it
shows its reinstall page. When the user continues, it always runs the MSI uninstaller
before it installs. If the user cancels the uninstaller, or the uninstaller fails, the
installer goes back to its reinstall page and installs nothing. A silent install (`/S`)
does not show the page and does not remove the MSI installation.

## Decision

- `tauri.windows.conf.json` sets `bundle.targets` to `["nsis"]`. Tauri merges this file
  into `tauri.conf.json` for a Windows build. Thus the Windows build makes only the NSIS
  installer. The macOS build does not change.
- The release workflow does not upload an `.msi` file. `scripts/release-assets.mjs` lists
  two assets: the macOS disk image for `aarch64` and the NSIS installer.
- The NSIS installer keeps the defaults of Tauri 2. This record does not set
  `bundle.windows.nsis.installMode`.
- The limits of the release version form do not change. Each part of the version resource
  of the Windows executable can be 65535 or less, so each release version is also correct
  there. If an MSI package comes back, the version rule needs no change. A change of the
  limits needs a new decision.
- `scripts/version.mjs` continues to refuse the `bundle.windows.wix.version` field.

## Consequences

- Each new release holds two assets, not three. The Windows build does not run WiX.
- The published releases keep their MSI packages, because those releases are immutable.
- A user cannot install QuipClip for all users of a computer. An administrator cannot send
  an MSI package to many computers. If a user asks for one of these, a new decision can set
  `bundle.windows.nsis.installMode` to `"both"`, or can add the MSI package again.
- A user who installed QuipClip from an MSI package can run the NSIS installer of a new
  release. In an install with pages, the installer finds the old installation and runs
  its uninstaller first. Windows can ask for administrator rights for this step. The
  settings and the downloaded FFmpeg stay, because they are in the data folders of the
  user and not in the install folder. Nobody tested this change of installer on Windows
  before this record.
- A silent install does not remove the MSI installation, so the computer then has two
  copies of QuipClip.
- When the computer has an MSI installation and also an NSIS installation, the first run
  of the installer can stop after it removes the MSI installation. A second run then
  installs QuipClip.
- The MSI check is part of the NSIS template of the Tauri CLI. If a later Tauri CLI removes
  the check, a user who installed from an MSI package gets a second copy of QuipClip.
