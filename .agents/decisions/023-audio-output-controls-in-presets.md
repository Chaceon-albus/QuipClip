# 023. Give each preset an audio bitrate, a sample rate, and a channel setting

- Status: Accepted
- Date: 2026-09-22
- Deciders: capric98
- Amends: ADR 006, ADR 013, ADR 014

## Context

A preset names an audio encoder and nothing else about the audio. ADR 013 gives no audio
bitrate control, so the encoder runs at its own default. The native `aac` encoder then
writes 128 kbps. The user reported that value as too low for an export.

The capability probe of ADR 006 tests three audio encoders: `libfdk_aac`, `aac`, and
`libopus`. The preset editor lists the encoders that the probe reports. A user therefore
cannot select a lossless encoder from the list.

ADR 014 ends every audio chain in this filter:

```
aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo
```

The filter resamples a 44100 Hz source to 48000 Hz, and it mixes a 5.1 source down to two
channels. That loss is acceptable in a lossy delivery file. It defeats the purpose of a
lossless encoder.

Measurements on ffmpeg 9.0.2, on macOS:

1. `flac` and `alac` encode the `fltp` output of the chain. ffmpeg converts the samples to
   `s32` (24 bit) in front of the encoder.
2. The `mov` muxer refuses `flac` and `opus` with the message "flac only supported in MP4."
   The `mp4` and `matroska` muxers accept `aac`, `flac`, `alac`, `opus`, and `mp3`.
3. The final `aformat` was changed to the source rate, with no `channel_layouts` option. A
   5.1 source at 44100 Hz then stays 5.1 at 44100 Hz through `aac`, `flac`, and `alac`.
   ffmpeg mixes it down to stereo for `libmp3lame`, and it resamples it to 48000 Hz for
   `libopus`. The graph needs no filter that is specific to one encoder.
4. The audio smoke command of ADR 006 passes for `flac`, `alac`, `libmp3lame`, and
   `aac_at`. `aac_at -b:a 320k` writes a valid MP4.

## Decision

### Three preset fields

```json
{
  "audioEncoder": "aac",
  "audioBitrate": 320,
  "audioSampleRate": "source",
  "audioChannels": "source"
}
```

- `audioBitrate` counts kilobits per second, from 8 to 1536. The renderer writes
  `-b:a <n>k` after `-c:a`. The key is absent when the preset holds no value. The encoder
  then uses its own default.
- `audioSampleRate` is the word `source` or an integer from 8000 to 192000 Hz. `source`
  selects the sample rate of the source audio stream.
- `audioChannels` is `source`, `stereo`, or `mono`. `source` keeps the channel layout of
  the source audio stream.

The final `aformat` of each audio chain takes its rate and its layout from the last two
fields. The value `source` for channels omits the `channel_layouts` option. The leading
`aformat` of ADR 014 does not change. It still pins the input link at the source rate,
because the audio ticks of the plan are in that unit.

`concat` still receives inputs that agree. Every chain reads the same audio stream, so every
chain ends at the same rate and with the same layout.

When the encoder cannot accept the requested format, ffmpeg converts the samples in front of
the encoder (measurement 3). The application does not narrow the choices for each encoder,
for the reason ADR 013 gives about quality ranges: a preset can name an encoder that this
machine does not have.

### An old file reads as the old behavior

A read that finds no `audioSampleRate` takes 48000. A read that finds no `audioChannels`
takes `stereo`. A read that finds no `audioBitrate` writes no `-b:a`. A preset from an older
file therefore renders the same command line as before, byte for byte.

A save always writes `audioSampleRate` and `audioChannels`. It writes `audioBitrate` only
when the preset holds a value, as it does for `ffmpegPath`.

The schema version stays 1. The application has no release yet, and each change here is an
addition that an old document satisfies through the defaults.

### Seeds

The seeded presets select 320 kbps, the source rate, and the source channels. The restore
action of ADR 013 writes these values over an older seed with the same identifier.

### A lossless encoder takes no bitrate

`flac` and `alac` are lossless. The editor disables the bitrate control for them. When the
user selects one of them, the editor clears the stored bitrate.

Rust does not know which encoders are lossless. It writes `-b:a` whenever the preset holds a
bitrate, as it writes `-c:a` for any valid encoder name.

### A container that refuses an audio encoder

The editor refuses to save a preset that pairs `mov` with `flac` or with `libopus`
(measurement 2). The editor knows only these conflicts. It accepts every other pair, because
a custom encoder name can be anything the installed build offers.

For every other pair, the check is the error that ffmpeg itself writes. ADR 016 reports it
as `ffmpegProcessFailed`, with the text from standard error.

Rust does not repeat this rule. The rule is a fact about muxers. It is not a limit that
keeps the settings document usable, which is the purpose of the checks in ADR 013.

### Tested encoders

The tested set of ADR 006 adds four audio encoders: `aac_at`, `libmp3lame`, `flac`, and
`alac`. The set then holds 16 names.

`aac_at` is the AAC encoder of the macOS AudioToolbox framework. Only a macOS build of
ffmpeg lists it. On another platform the probe reports it as not listed, as it already does
for the hardware video encoders of other platforms.

The capability cache schema version changes from 1 to 2, because ADR 006 requires a new
version for each change to the tested set. The first start after the upgrade runs the probe
again.

## Consequences

- A preset can write lossless audio at the rate and with the layout of the source.
- An older build reads a document with the new keys as damaged, because `Preset` refuses
  unknown fields. The older build does not write over the file (ADR 013). It reports a
  validation error instead of a schema version. This is acceptable before the first release.
  The first release fixes the preset shape, and a later addition then needs a new schema
  version.
- With `source` for rate or channels, the output format depends on the source. One preset
  can write different rates and layouts for two different sources.
- The frontend and Rust both hold the new ranges. A test on each side pins them.
- An audio encoder outside the tested set reaches the editor only as a custom name, as
  before.
