# Open work

State at the end of the initialization session, 2026-08-29.

The repository builds, runs, and passes its full gate: `pnpm lint`, `pnpm typecheck`,
`pnpm format:check`, `pnpm test` (35), `pnpm build`, `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test` (27). The application shell
opens and renders in both themes.

Nothing below is a blocker for the checkpoint, because no feature code calls the modules
that carry the defects. Sections A, B, and C must close before anything is built on top of
them.

## A. Rust `Rational` — `src-tauri/src/time.rs`

An independent review found these and reproduced every one. None is fixed.

1. **The derived `Deserialize` bypasses `Rational::new`.** `{"n":1,"d":0}` deserializes to
   `Ok(Rational { num: 1, den: 0 })`. `timecode` and `frame_from_timecode` then panic with
   "attempt to divide by zero" inside `ceil_div_i128`, and `format_seconds` trips its
   `debug_assert`. ADR 002 rule 5 says the type never panics. ADR 010 puts these values in
   a project file the user can edit, so this is a file-corruption crash.
   Fix: `#[serde(try_from = "RationalWire")]` over a private wire struct, make `num` and
   `den` private, and add `num()` and `den()` accessors.
2. **`Ord` breaks its contract for any value that did not come through `new`.**
   `{"n":2,"d":4}` and `{"n":1,"d":2}`: `cmp` returns `Equal` while `==` returns `false`.
   A `BTreeSet` of the two has length 1 and a `HashSet` has length 2. With a negative
   denominator the order is also intransitive: `{"n":1,"d":-1}`, `{"n":0,"d":1}`,
   `{"n":-1,"d":-1}` sort to `[-1, 0, 1]` in the wrong order. Fixed by item 1.
3. **No decimal-string constructor.** ffprobe reports `format.duration` as `"14.014000"`,
   and `from_ffprobe` returns `None` for it. `frame_count_for_duration` therefore has no
   reachable caller, and ADR 010 needs a `frameCount` per source. Add `from_decimal_str`
   that builds `num = digits`, `den = 10^fraction_length`, exactly.
4. **A zero timebase is accepted and the module disagrees with itself.**
   `Rational::new(0, 1)` succeeds. As an fps, `frame_at_seconds` returns `Some(0)` for
   every input and `timecode` prints `FF` stuck at `00`, while `seconds_at_frame` correctly
   returns `None`. Make all four fps-taking methods return `None` when `num <= 0`.
5. **`frame_count_for_duration` returns a negative count** for a negative duration.
   `Rational::new(25,1).frame_count_for_duration(Rational::new(-2,5))` gives `Some(-10)`.
6. **`format_seconds` prints a wrong, plausible number for `decimals >= 20`**, because
   `saturating_pow` clamps and the result is then divided as if exact. Nine decimals, which
   is what ADR 004 uses, is always exact, so there is no live bug. Add
   `pub const FFMPEG_DECIMALS: u32 = 9;`, which a doc comment already claims exists.
7. **`frame_from_timecode` accepts input the formatter cannot emit.** `"+5:00:00:00"`,
   `"00:00:00:+5"`, and `"1:2:3:4"` all parse.
8. Quality: `&self` on four methods and `self` on the rest of a `Copy` type, no
   `#[must_use]` anywhere, and three doc comments that state something false. One of them
   argues for the public fields that cause item 1.

Test gaps worth closing: rejection of `{"num":..,"den":..}`; deserialization of an
invariant-breaking document; `Ord`/`Eq` agreement plus a `BTreeSet`/`HashSet` length test;
`format_seconds` at 0 decimals and the `-0` suppression branch; strictly increasing
9-decimal strings over a run of NTSC frames; a midpoint test that asserts the value and not
only the ordering; negative operands for the four arithmetic methods; 24000/1001 and
60000/1001.

## B. Frontend `src/lib/time.ts`

The same defect class as A.4, confirmed by probe:

```
parseFrameRate("0/1")                  -> {"n":0,"d":1}       should be null
parseFrameRate("-25/1")                -> {"n":-25,"d":1}     should be null
secondsAtFrame(5, {n:0,d:1})           -> Infinity            would set currentTime=Infinity
formatTimecode(5, {n:0,d:1})           -> "00:00:05:00"       silently wrong
formatTimecode(5, {n:-25,d:1})         -> "00:00:05:00"       silently wrong
```

Fix symmetrically with the Rust side. Reject a non-positive rate in `parseFrameRate`, and
make the fps-taking functions throw a `RangeError`, since after that the only producer
cannot emit an invalid rate.

The rest of the module was cross-checked against exact rational arithmetic computed in
Python. All 12 cases agree byte for byte, including frame 3,600,000 at 30000/1001 and
negative frames.

## C. `src/types/project.ts`

`Source` carries `proxy?: string`. ADR 010 says the project file holds no cache, and ADR
007's runtime `Source` uses `proxy?: { path, state }`. The file conflates the persisted
shape and the runtime shape. Split them: a persisted type with no proxy, and a runtime type
that adds it.

## D. The application shell

Its independent review was interrupted and never reported, so the code is unreviewed.

One known defect: in the dark theme the timeline's horizontal scrollbar renders as a bright
light bar above the status bar. Add `::-webkit-scrollbar` rules to `src/styles/globals.css`
using `--border-strong` for the thumb. Use the pseudo-elements and not `scrollbar-color`,
because `scrollbar-color` needs Safari 18.2 and ADR 003 sets the floor at macOS 12.3.

## E. Undecided

The interface labels are English. The design reference is Chinese, and no i18n is set up.
Decide before the interface grows.

## F. Not started

All of it is feature work, and all of it has a decision record already.

- `src-tauri/src/ffmpeg/`: locate, download, probe, capabilities, export. ADR 005, ADR 006.
- `src-tauri/resources/ffmpeg-manifest.json` and `scripts/update-ffmpeg-manifest.ts`.
  ADR 005 records the two download sources and the fact that both publish checksums.
- `src-tauri/src/project/`: read and write `.qcproj`, with the temporary-file-then-rename
  step. ADR 010.
- The Rust side that widens the asset-protocol scope for each opened file. ADR 003. The
  configuration is in place, the runtime call is not.
- Zustand stores and the undo and redo command stack.

Empty module skeletons for `ffmpeg/` and `project/` were deliberately not committed. An
empty module is noise, and the ADRs already hold the design.

## G. Not verified

`pnpm tauri build` has never run. Only `pnpm tauri dev` was exercised, and only on macOS.
Nothing has been built or run on Windows.

## H. Environment note, outside this repository

This machine has `core.autocrlf=true` in the global git configuration. That is the Windows
setting, and on macOS it makes git write CRLF into files that have no `.gitattributes`
entry. This repository now names those files, so it is safe. Other repositories on the same
machine are not.
