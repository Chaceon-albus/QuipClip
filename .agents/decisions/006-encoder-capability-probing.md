# 006. Probe encoder capability by listing, then by a smoke test, then cache the result

- Status: Accepted
- Date: 2026-08-29
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

**Step 2, smoke test.** For each candidate the export presets care about, run a real encode
of a fraction of a second and discard the output:

```
ffmpeg -hide_banner -f lavfi -i color=c=black:s=256x256:r=25:d=0.2 -c:v <enc> -f null -
```

Audio encoders use an `anullsrc` input. Each test has a 5-second timeout, because a broken
hardware encoder can hang instead of fail.

The tested set is `h264_nvenc`, `hevc_nvenc`, `h264_qsv`, `h264_amf`, `h264_videotoolbox`,
`hevc_videotoolbox`, `libx264`, `libx265`, `libsvtav1`, `libfdk_aac`, `aac`, and
`libopus`.

**Concurrency.** The job runs off the main thread. It sends each result to the frontend as
that result lands. The application stays usable while the probe runs, and the export dialog
adds each encoder as its result arrives.

**Cache.** Write the result to `<app_data>/capabilities.json`. The cache key is the
absolute binary path, the version string, and the binary size and mtime. A change to any of
those invalidates the cache, so a user who upgrades ffmpeg gets a fresh probe with no
manual step.

## Consequences

- The export dialog never offers an encoder that fails at the first frame.
- The first probe costs a few seconds of background work. Later runs read a JSON file.
- The tested set is a fixed list, so a new encoder needs a code change. That is deliberate.
  A probe of every listed encoder would run for a long time and would test encoders that no
  preset offers.
- A hardware encoder that passes a 256x256 test can still fail on a 4K source, for example
  when the GPU has a resolution limit. The export path must still handle an encoder failure
  and must offer the software fallback.
