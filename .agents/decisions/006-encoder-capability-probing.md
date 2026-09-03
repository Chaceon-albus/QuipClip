# 006. Probe encoder capability by listing, then by a smoke test, then cache the result

- Status: Accepted
- Date: 2026-09-03
- Deciders: capric98

## Context

The export presets must offer only the encoders that work on this machine. `ffmpeg
-encoders` is not enough to decide that. A GPL build lists `h264_nvenc` on every machine,
including a machine with no NVIDIA GPU. The same holds for `h264_qsv` and `h264_amf`. The
encoder appears in the list and fails at the first frame.

The list is reliable in the other direction. An encoder the build does not have is absent
from `-encoders`, and `ffmpeg -h encoder=<name>` then reports that the codec is not
recognized. Absence is therefore a sufficient signal, and the list is the right first step.

The probe must not block the user interface. A full probe runs a dozen short ffmpeg
processes.

## Decision

Probe in two steps, then cache.

**Step 1, list.** Parse `ffmpeg -hide_banner -encoders`, `-decoders`, `-hwaccels`, and
`-filters`. This gives the candidate set. Also read the `configuration:` line from
`-version`, for the licence flags `--enable-gpl`, `--enable-nonfree`, and
`--enable-version3`. ADR 005 needs those for the consent dialog. The licence flags are the
only capability that lives there and nowhere else.

The four listings do not share one output format:

- `-encoders` and `-decoders` print a flag column of six characters. One parser reads both.
- `-filters` prints a flag column, then one more column for the input and output
  signature. The printed flag width does not match the legend above the list, so a parser
  must not depend on that width. The filter name is the second field of the row.
- `-hwaccels` prints one header line and then bare names.

**The first implementation runs two of these four listings.** It runs `-encoders` and
`-hwaccels`. It also runs `-version` for the licence flags. It does not run `-decoders` or
`-filters`. No code reads a decoder list or a filter list yet. The preview proxy of ADR 003
and the export renderer of ADR 004 are the expected consumers. Neither decision requires a
list today. The parser for each list ships now, with its tests. The command runs when the
first consumer arrives. The application does not run a command whose output no code reads.

**Step 2, smoke test.** For each candidate the export presets care about, run a real encode
of a fraction of a second and discard the output:

```
ffmpeg -hide_banner -f lavfi -i color=c=black:s=256x256:r=25:d=0.2 -c:v <enc> -f null -
```

Audio encoders use an `anullsrc` input:

```
ffmpeg -hide_banner -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.2 -c:a <enc> -f null -
```

The audio test must set an explicit duration, because `anullsrc` is an infinite source. A
test without a duration limit runs until the timeout and reports a working encoder as
broken.

Each test has a 5-second timeout, because a broken hardware encoder can hang instead of
fail.

The tested set is `h264_nvenc`, `hevc_nvenc`, `h264_qsv`, `h264_amf`, `h264_videotoolbox`,
`hevc_videotoolbox`, `libx264`, `libx265`, `libsvtav1`, `libfdk_aac`, `aac`, and
`libopus`.

**Concurrency.** The job runs off the main thread. It sends each result to the frontend as
that result lands. The application stays usable while the probe runs, and the export dialog
adds each encoder as its result arrives.

The smoke tests run one after another. Two hardware encoder tests that run together compete
for the same encoder hardware. That competition makes a working encoder fail. That result
is a false negative, and the probe exists to prevent it.

One lock holds the smoke-test phase for the whole application. A superseded run and the
active run therefore never test an encoder at the same time. The active run waits for the
superseded run to end.

**Event contract.** The probe reports through one Tauri event named
`ffmpeg:capability-probe`. The payload is a tagged union with these variants:

| Variant    | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `located`  | The application resolved the executables and the version                       |
| `result`   | One candidate finished, and this is its status                                 |
| `finished` | The run completed, and this is the full report                                 |
| `failed`   | The run stopped. The payload holds the stable error code and its named values. |

Every variant carries a `runId`. The command that starts a probe returns the same `runId`.
One event name gives the frontend one subscription, one validator, and one order of
arrival.

**The backend does not cancel a probe.** A superseded run finishes, and the frontend
discards each event whose `runId` is not the active one. A cancelled run would need a
cancellation token in every step. The cost of a run that continues is bounded. The worst
case is twelve tests of five seconds in the background.

**Cache.** Write the result to `<app_data>/capabilities.json`. The file holds a list of
entries. Each entry holds one cache key, one probe time, and one report. The cache key is
the absolute binary path, the version string, and the binary size and mtime. A change to
any of those invalidates that entry, so a user who upgrades ffmpeg gets a fresh probe with
no manual step.

The file holds a maximum of eight entries. The application removes the oldest entry by
probe time when the file is full. Eight entries hold a system binary, a downloaded binary,
and several binaries that a user tried, and the file stays small.

One lock holds each cache write. The writer reads the current file, replaces or adds its
own entry, and writes the whole list to a temporary file. It then renames that file over
`capabilities.json`. A late write therefore keeps the entries that another run wrote. ADR
005 and ADR 010 already use a temporary file and a rename.

The application reads a damaged or unreadable cache file as a miss. It does not report an
error for that file. The probe result reaches the frontend even when the cache write fails.

**Executable resolution.** The first implementation does not read a configured path from
the application settings. ADR 005 puts that path first in the resolution order. The
application has no settings storage yet. Until it has one, the probe resolves the
executables through `PATH` and the application data directory.

When the application does not find the executables, the `failed` payload names each
candidate that it inspected, in search order. Each candidate holds the `ffmpeg` path, the
`ffprobe` path, and the origin class. The user then sees where the application looked. On
macOS that order includes the two Homebrew directories from ADR 012.

## Consequences

- The export dialog never offers an encoder that fails at the first frame.
- The first probe costs a few seconds of background work. Later runs read a JSON file.
- The tested set is a fixed list, so a new encoder needs a code change. That is deliberate.
  A probe of every listed encoder would run for a long time and would test encoders that no
  preset offers.
- A hardware encoder that passes a 256x256 test can still fail on a 4K source, for example
  when the GPU has a resolution limit. The export path must still handle an encoder failure
  and must offer the software fallback.
- Sequential tests make the probe slower than a parallel probe. That cost buys a correct
  result on a machine with one encoder device.
- A new probe waits for a superseded probe to release the smoke-test lock. Its first result
  can arrive up to a minute late.
- A superseded run continues to spend processor time until it ends. The frontend ignores
  its events, and the merge on write keeps its late write from destroying the entry of
  another binary.
- No caller supplies a configured path until settings storage exists. A user whose ffmpeg
  is outside `PATH` and the application data directory cannot point the application at it.
  ADR 005 keeps that step first in the order, and it returns with the settings storage.
- The decoder parser and the filter parser have tests but no caller. The milestone that
  adds the first caller also adds the command that feeds them.
