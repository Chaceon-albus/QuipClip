# 012. Search standard Homebrew paths on macOS

- Status: Accepted
- Date: 2026-08-30
- Deciders: capric98

## Context

ADR 005 requires a `PATH` lookup after the configured path. A macOS application that
starts from Finder or the Dock can receive a small system `PATH`. This value does not
usually include the paths that Homebrew uses. Homebrew installs command links in
`/opt/homebrew/bin` on Apple silicon and in `/usr/local/bin` on Intel.

The two programs can therefore exist and run from a terminal, but QuipClip cannot find
them. Starting a login shell would load user shell files during application startup. Those
files can be slow, can print output, and can run commands that are unrelated to QuipClip.

## Decision

On macOS, the `PATH` lookup uses this directory order:

1. Directories from the application process `PATH`, in their existing order.
2. `/opt/homebrew/bin`.
3. `/usr/local/bin`.

Stable deduplication keeps the first occurrence of each candidate pair. These two extra
locations have the same `Path` origin as directories from the process `PATH`.

The configured path remains first in the full resolution order. The application data
directory remains after all `PATH` locations. QuipClip does not start a login shell and
does not change the process `PATH`. Other operating systems keep the ADR 005 behavior.

## Consequences

- A macOS application that starts from Finder or the Dock can find a standard Homebrew
  installation.
- A directory that the user put in `PATH` keeps priority over the standard Homebrew
  directories.
- Installations in other package-manager directories still require a configured path or a
  matching process `PATH`.
- Discovery stays deterministic and does not run user shell startup files.
