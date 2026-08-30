# Open work

The initialization session ended on 2026-08-29. At that checkpoint, the repository
reported a successful full gate. The gate included `pnpm test` with 35 tests and
`cargo test` with 27 tests.

Agents resolved the implementation work in sections A through D on 2026-08-29. The
combined full gate passed. The gate included `pnpm lint`, `pnpm typecheck`,
`pnpm format:check`, `pnpm test` with 98 tests, and `pnpm build`. It also included
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` with
44 tests.

## A. Rust `Rational` — completed on 2026-08-29

The Rust writer completed the `Rational` corrections in `src-tauri/src/time.rs`.

- Private fields and validated deserialization now protect every `Rational` invariant.
- The type has a decimal-string constructor for ffprobe duration values.
- Each fps operation rejects a non-positive frame rate.
- Frame counts cannot be negative.
- The formatting API uses the nine-decimal ffmpeg precision constant.
- The timecode parser accepts only the format that the formatter emits.
- The updated documentation matches the implementation.
- New tests cover deserialization, ordering, formatting, parsing, and arithmetic boundaries.

The independent high-reasoning reviewer approved these changes. The Rust checks passed
independently. They included `cargo fmt --check`, 44 tests, Clippy with warnings denied,
and the diff check.

## B. Frontend time functions — completed on 2026-08-29

Gemini 3.7 Flash High corrected `src/lib/time.ts` and its tests.

- `parseFrameRate` rejects a non-positive frame rate.
- Each fps function throws `RangeError` for an invalid frame-rate object.
- The tests cover invalid signs, invalid denominators, fractional values, and unsafe integers.

The independent high-reasoning reviewer approved these changes.

## C. Project source types — completed on 2026-08-29

Gemini 3.7 Flash High separated the persisted source type from the runtime source type.
The persisted type cannot contain proxy state. The runtime type can contain the proxy path
and status. A compile-time test prevents accidental assignment of a runtime source to the
persisted type.

The independent high-reasoning reviewer approved these changes. The targeted frontend
checks for sections B and C passed. They included 98 tests, TypeScript, ESLint, Prettier,
and the diff check.

## D. The application shell — implementation completed on 2026-08-29

Gemini 3.7 Flash High completed the shell corrections from the independent review.

- The application now follows the system theme.
- The timeline scrollbar uses the palette and has a transparent track.
- The Out control identifies the boundary as exclusive.
- The timeline sample uses one source and a linear ruler.
- Unimplemented controls are disabled.
- The title bar and decorative icons have clearer accessibility behavior.
- Each platform-specific `app.windows` entry repeats all common fields from the base window.
- The macOS window keeps `Overlay` and `hiddenTitle`. The Windows window keeps
  `decorations: false`.

The independent high-reasoning reviewer approved the changes in the third review. The
review reported zero blocking and zero non-blocking findings.

## E. Undecided

The interface labels are English. The design reference is Chinese, and the project has no
i18n system. Make an i18n decision before the interface grows.

## F. Not started

Implementation has not started for the features in this section. The follow-up task after
initialization on 2026-08-29 did not advance these features. Existing decision records
define their designs.

- `src-tauri/src/ffmpeg/`: locate, download, probe, capabilities, and export. See ADR 005
  and ADR 006.
- `src-tauri/resources/ffmpeg-manifest.json` and `scripts/update-ffmpeg-manifest.ts`. ADR 005
  records the two download sources and their checksum support.
- `src-tauri/src/project/`: read and write `.qcproj` files. Use a temporary file and then
  rename it. See ADR 010.
- The Rust command that widens the asset-protocol scope for each open file. ADR 003 defines
  this command. The configuration exists, but the runtime command does not.
- Zustand stores and the undo and redo command stack.

The repository does not contain empty module skeletons for `ffmpeg/` or `project/`. The
decision records contain the current design.

## G. Partially verified

`pnpm tauri build` passed outside the sandbox on macOS. The build generated `QuipClip.app`
and `QuipClip_0.1.0_aarch64.dmg`. No agent built or ran the application on Windows.

## H. Environment note, outside this repository

This machine has `core.autocrlf=true` in the global git configuration. This setting is for
Windows. On macOS, it writes CRLF into files that have no `.gitattributes` entry. This
repository now names those files, so the setting is safe for this repository. The setting
can still affect other repositories on this machine.
