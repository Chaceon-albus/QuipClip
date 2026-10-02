# 040. Give each preset encoder options, a constant-quality kind and a pixel format

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 013, ADR 014, ADR 023

## Context

A preset named a container, two encoders, one quality control, the output size and rate, and
the audio settings. The user could not tune an encoder: there was no way to pass `-preset slow`
to libx264, `-profile:v main10` to VideoToolbox, or `-multipass fullres` to NVENC. The user
also wanted 10-bit output and the constant-quality mode of NVENC, and supplied five tuned
encoder blocks as the new defaults.

Three facts shaped the design:

- ffmpeg reads each argument that follows the name of an option with no argument as the next
  output file. A free text field would therefore let a value become a second output.
- The graph ended each video chain in `format=yuv420p`, which truncates a 10-bit source to 8 bits
  before the encoder. ADR 014 measurement 19 moved that format into one chain at the start of
  the graph.
- NVENC sets `b` to 2 Mbit/s by default. With `-cq` alone that average caps the quality.

v0.1.0 is released, so a change of the shape of the settings document needs a new schema
version (ADR 023).

## Decision

### Three new preset fields

- `videoOptions` and `audioOptions` are ordered lists of `{ name, value }`. The renderer writes
  each one as two arguments, `-<name>:v <value>` or `-<name>:a <value>`, after the managed flags
  of its stream. The stream specifier keeps a video option away from the audio encoder.
- `quality.kind` takes a new value, `cq`, from 1 to 63. It renders as `-cq <n> -b:v 0`.
- `pixelFormat` names the pixel format of the output video: 1 to 32 characters from
  `[a-z0-9_]`, `yuv420p` by default. It is the format of the first chain of the graph, and the
  renderer also writes `-pix_fmt <format>` after `-c:v`.

The order of the video arguments is `-c:v`, `-pix_fmt`, the quality flags, then the video
options. The audio arguments are `-c:a`, `-b:a`, then the audio options. An audio-only export
writes no video arguments, and a video-only export writes no audio arguments (ADR 036).

### The rules for an option

Rust validates each option, and the editor checks the same rules first. A vitest reads the Rust
source and compares the lists and the limits.

- The name starts with an ASCII letter and holds only ASCII letters, digits, `_`, `.` and `-`,
  1 to 64 characters. The rule refuses `:`, which would change the stream specifier, and `/`,
  because FFmpeg 7.1 and later read the value of `-/<name>` from a file.
- The name is not in `DENIED_OPTION_NAMES`, a list of 198 names in two parts:
  - Every option of the fftools tables that takes no argument, in the tags from n7.1 to n9.0.2:
    each boolean option and its `no` form, each function option with no argument, and each
    option that prints and exits. On FFmpeg 9.0.2, `-<name>:v x` made `x` an output file for
    exactly the booleans, the `no` forms, `report` and `vstats`.
  - The options that QuipClip sets or that break the export: the codecs, the formats, the
    inputs and the group separators, the maps and the filters, the timing and the seek options
    that the cut of ADR 014 relies on, the options that change the frames or the streams that
    the success checks count, the process and log controls, the options that write a file
    beside the output, and the files of options. The prefixes of the earlier draft became exact
    names, because a prefix would refuse real encoder options such as `mapping_family`.
- The value holds 1 to 512 characters, with no NUL, CR, LF or `"`, and it does not end in `\`.
  The last two rules keep the command line budget exact on Windows: the quoting of an argument
  there writes each `"` as `\"`, doubles the backslashes in front of it, and doubles the
  backslashes at the end of an argument that it puts in quotes.
- A list holds at most 32 options, with no name twice. The two lists of a preset render at most
  1024 bytes together.

With the `:v` or `:a` specifier, ffmpeg looks a name up among the encoder options only. A muxer
option such as `movflags` can therefore never take effect through this path.

### The command line budget

The widest plan that the settings permit holds 100 segments, the longest paths, 64 options that
render 1024 bytes, and a pixel format of 32 characters. It measures 31620 of the 31743 bytes of
the Windows budget, which leaves 123 bytes. 101 segments do not fit. ADR 014 gave 1607 free
bytes before this record. (Changed on 2026-10-02: the shorter audio chain of ADR 014
measurement 20 brings the widest plan to 31509 bytes, which leaves 234 bytes.)

### Schema version 2

`CURRENT_SCHEMA_VERSION` is 2. A load of a version 1 file gives the new keys their defaults,
`yuv420p` and two empty lists, and writes nothing. A save writes version 2 at the next revision.
The permissive reader of the FFmpeg path reads version 1 and version 2. A release before this
record reads a version 2 file as a later version and does not write over it (ADR 013). A version
1 preset renders the command line of before, plus `-pix_fmt yuv420p`. The encoded packets were
identical with and without that flag for libx264, libx265 and ProRes.

### The editor

(Added on 2026-10-02.) The preset editor of the Settings window has a group Extra Parameters with a text area in the
syntax of the ffmpeg command line. Apply reads the text:

- Double and single quotes, and line continuations with `\`, `^` and `` ` ``, as a shell, the
  Windows command prompt and PowerShell write them. A word that starts with `-` is a value only
  when it is a number or in quotes.
- The flags that a preset field holds go into that field: `-c:v`, `-c:a`, `-crf`, `-cq`,
  `-q:v`, `-b:v`, `-b:a`, `-ar`, `-ac` and `-pix_fmt`. A `-b:v 0` next to a constant-quality kind
  is absorbed with a note.
- An option with `:a` goes to the audio list, and every other option to the video list.
- A curly quote (“ ” ‘ ’) outside quotes is an error. Pasted text often holds one, and as a
  character it would reach the encoder inside the value, where libx264 drops the first and the
  last entry of a parameter string with a warning that the export hides.
- The import is all or nothing, and each error names its line and its column.

The text area shows the canonical text of the two lists, one option on each line. A Save reads
any text that was not applied. Text typed while a save runs keeps the draft unsaved, so a switch
to another preset or a close asks first.

### The seeds

(Added on 2026-10-02.) The seeded presets follow the five blocks that the user gave. Each one
writes AAC at 320 kbps, at the rate and with the channels of the source, into MP4.

| Id | Platform | Video | Options |
| --- | --- | --- | --- |
| `default-h264-mp4` (active) | every | libx264, CRF 20, yuv420p | `preset slow`, the `x264-params` of the user |
| `default-av1-mp4` | every | libsvtav1, CRF 38, yuv420p10le | `preset 5`, `g 250`, the `svtav1-params` of the user |
| `default-hevc-videotoolbox-mp4` | macOS | hevc_videotoolbox, quality 80, p010le | `profile main10`, `prio_speed 0`, `spatial_aq 1`, `bf 3`, `g 300`, `tag hvc1` |
| `default-nvenc-mp4` | Windows | h264_nvenc, CQ 25, yuv420p | `preset p7`, `rc vbr`, `multipass fullres`, `rc-lookahead 32`, `spatial-aq 1`, `temporal-aq 1`, `bf 3`, `b_ref_mode middle`, `g 250` |
| `default-hevc-nvenc-mp4` | Windows | hevc_nvenc, CQ 25, p010le | the same, and `tag hvc1` |

- The NVENC seeds use pure constant quality, with no `-maxrate` and no `-bufsize`, as the user
  chose.
- A seed leaves out an option that repeats the default of its encoder, because an option that
  an older FFmpeg does not know ends the export: `-realtime 0`, `-allow_sw 0` and
  `-power_efficient 0` of VideoToolbox, and `-tune hq` and `-aq-strength 8` of NVENC. The NVENC
  seeds keep `-g 250`, because the FFmpeg default of `g` for NVENC is -1, which takes the GOP
  length of the NVIDIA preset.
- `-q:v` of VideoToolbox works only with an FFmpeg for Apple silicon, and `-spatial_aq` needs
  FFmpeg 8.0 or later. On an Intel Mac or with FFmpeg 7.1, the VideoToolbox seed fails.
- `default-hevc-mp4`, the x265 seed, and `default-videotoolbox-mp4`, the VideoToolbox H.264 seed,
  are retired. No seed uses those ids again. A restore replaces each seed by id and appends a
  seed that is absent (ADR 013), so a retired seed stays in a library as a preset of the user. A
  seed that keeps the id of an earlier seed keeps its codec.
- A real encode on this Mac with FFmpeg 9.0.2 wrote H.264 High with `avc1` and key frames 250
  frames apart, AV1 Main 10-bit, and HEVC Main 10 with `hvc1` and key frames 300 frames apart.

## Consequences

- A user can tune an encoder, ask for 10-bit output, and use the constant-quality mode of NVENC.
- Two risks remain. A parameter string of an encoder can still write a file, for example
  `x264-params` with `stats=`, `x265-params` with `csv=`, or `-flags:v +pass1`. That is the trust
  that the user already has through the path of FFmpeg. And the deny list covers FFmpeg up to
  9.0.2. A later release can add an option with no argument, whose value then becomes an output
  file that `-y` overwrites. The check of the fftools tables must run again for each new release
  that QuipClip supports.
- The `-pix_fmt` warning of an encoder that cannot take the format shows only in a run at warning
  level. The export runs at error level, and ffmpeg then writes a format of the encoder's own.
- `cq` accepts 1 to 63 because `av1_nvenc` does. `h264_nvenc` and `hevc_nvenc` refuse 52 to 63,
  and ffmpeg reports that as an error of the export.
- A file of version 2 cannot go back to v0.1.0 without a reset of the settings.
