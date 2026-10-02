# 041. Test a preset on this machine

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 006, ADR 016, ADR 038

## Context

The capability probe of ADR 006 encodes 0.2 s with each encoder and its default settings. A
preset of ADR 040 carries options, a pixel format and a container, so it can still fail when an
export starts, on a machine where its encoder passed the probe:

- An FFmpeg for x86_64, such as an old Homebrew build under Rosetta, refuses `-q:v` for
  VideoToolbox.
- FFmpeg 7.1 does not know `spatial_aq`.
- An NVIDIA GPU of the Pascal generation has no HEVC B-frames and no `b_ref_mode`.
- The `hvc1` tag on H.264 fails only when the muxer writes its header.
- A pixel format that the encoder cannot take gives only a warning.

The user asked for a test of a preset on this machine.

## Decision

### The test

`test_preset(preset)` takes a whole preset, so the editor can test a draft that is not saved. Rust
checks it with the validation of a saved preset. The command renders the arguments of the export
with the same builders: the encoder arguments, the pixel format as the first chain of the graph,
the options, and the muxer arguments. The input is a black `color` source of 256 by 256 at 25
frames each second for 0.2 s, and an `anullsrc` source at the sample rate and channel layout of the
preset, or 48000 Hz stereo for `source`. The command writes with the real muxer to a temporary
file in the cache directory of the application, because some faults appear only at the header,
and it deletes the file on every path. It runs at `-loglevel level+warning`.

- The test holds the lock of the smoke tests of ADR 006 while FFmpeg runs, so it never runs at the
  same time as a smoke test.
- It does not start while an export runs. A counter of the exports that began lets the command
  see an export that started and ended during the test. Such a result is not stored.
- The timeout is 10 s, twice the timeout of a smoke test. On this Mac a cold test took at most
  0.25 s, but a cold disk, a hardware encoder that starts slowly, or a first scan of the
  executable by an antivirus program can take seconds, and a false time-out would be stored.
- The child process starts with no console window on Windows (ADR 018), and a time-out kills and
  reaps it.

(Changed on 2026-10-02.) The black source carries `setparams=range=tv`. Without a colour
range, `h264_videotoolbox` warned on every test of an 8-bit format, so every such preset read as
passed with a warning. The response also says whether Rust stored the result: not when an export
overlapped the test, when the binary has no cache key, or when the write of the cache failed.
Before each test, the command deletes the temporary files of other processes that are older than
60 s, which a quit during a test can leave behind. A test of the command compares the encoder,
pixel format, option and muxer arguments with what the export renders for the same preset, for
every seed.

### The result

The result is one of `passed`, `passedWithWarnings`, `failed` and `timedOut`, with one line of
FFmpeg. A line counts only when it has the prefix of FFmpeg itself, `[name @ pointer] [level]`,
so the information lines of SVT-AV1 and x265 do not count. The pointer is removed, and the line is
cut to 512 bytes. A failure shows its first error line, or else its first warning, or else its
first line. A result never blocks an export: a false negative must not stop work that would
succeed (ADR 006).

### The cache

`<app_data>/preset-tests.json`, at schema version 1, keeps the results. The key is the cache key
of ADR 006, which names the binary by its path, version, size and modification time, and the
arguments of the test with the output path replaced. A new binary therefore misses, and two
presets that render the same arguments share a result. The file holds at most 64 entries, and the
oldest goes first. A damaged file is a miss, and a write replaces the file atomically.
`preset_test_results()` returns the stored results of the saved presets for the binary in use.

### The interface

(Added on 2026-10-02.) Three places show a result:

- **The preset editor** of the Settings window has a Test button. It tests the draft as it is,
  so the test includes an unsaved edit. The test first applies the text of the extra
  parameters, as Save does. The button is off for a draft with a field problem or a failed
  import of the extra parameters, because Rust validates the draft as a saved preset.
- **Each row of the preset list** has a mark for the stored result of that preset.
- **The setup step of the export** has a row "Preset Test" with the result, its FFmpeg line, and
  Test Again. When the step opens, it reads the stored results. It tests a preset once in the
  background when no stored result exists for that preset and binary. It does not test while an
  export runs, or when the read failed, for example when FFmpeg is missing.

The two sources of a result are the stored results that Rust returns and the tests that the
window ran. A test that the window ran covers a draft and a result that Rust did not store. A
stored result applies only while the fields that reach the test equal those of the saved preset.

A result belongs to one binary. The window makes the key of the binary from its path and its
version, and only from a probe that finished. A probe of the same binary therefore does not
change the key. A new key starts a new generation, and the results of the old binary stop
showing. This includes a late result from a test that ran during the change. When a probe ends
with no binary, the window reads the stored results again. When FFmpeg is missing, that read
clears them.

The status line of a result is not a live region, so a screen reader does not read it for each
row of the list or for a test in the background. The window announces only a test that
the user started, at its start and at its end. It does not announce a test that ends after a
change of binary, because its result no longer shows.

### Grants

Both windows may call `test_preset` and `preset_test_results` (ADR 038). The Settings window tests
the draft in its editor, and the main window reads and runs tests for the setup step of the
export. A finished test sends `ffmpeg:preset-tested`, so the other window reads the results again.

## Consequences

- A preset that fails on this machine shows its FFmpeg line before an export starts.
- The test does not cover every field of a preset. The resolution, the frame rate, the sample
  rate and the layout of a real source, and the stream choice of ADR 036 do not reach it. A pass
  can therefore come before an export that fails, for example an 8K export on VideoToolbox, and a
  MOV preset with FLAC fails the test although its audio-only export uses the `mp4` muxer and
  works.
- A test that runs while the application quits is not awaited, as for a smoke test.
