# 055. Run each export in a work directory, with its filter graph in a file

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 004, ADR 014, ADR 016, ADR 017, ADR 040, ADR 043, ADR 046, ADR 048, ADR 050,
  ADR 053, ADR 054

## Context

Each export passes its filter graph inline, as the value of `-filter_complex`. On Windows,
`CreateProcessW` accepts at most 32,767 characters on one command line. ADR 014 keeps 1 KiB
free, so the budget is 31,743 bytes. In the widest command, the graph uses about 95 % of that
budget.

The graph grows with each piece, so the budget sets the limit of pieces. ADR 014 set the limit
at 100 segments. The fit step of ADR 053 made each chain longer, and the limit went down to 48
pieces. A later measurement of ADR 053 set the rule 92 − S for an export of S sources.

ADR 014 measurement 13 found no single spelling of a graph file that every supported `ffmpeg`
reads. That is true, but two spellings together cover every supported build:

- FFmpeg 2.0 and later read `-filter_complex_script <file>`. FFmpeg 7.0 deprecated it, and
  FFmpeg 9.0.2 does not have it.
- FFmpeg 7.0 and later read `-/filter_complex <file>`. The FFmpeg Changelog lists this syntax
  under version 7.0. ADR 014 and ADR 040 say 7.1, which is wrong.

No ADR sets a minimum version of `ffmpeg`. But the graphs use the short option names of
`aformat`, which need FFmpeg 4.3 (ADR 014). So an export can run only on FFmpeg 4.3 or later,
and each such build reads one of the two spellings.

The user chose these points:

- Each export gets its own work directory. It holds the graph files and the FLV heads.
- The output stays where it is now: a reserved file in the destination directory, renamed on
  success (ADR 004). A user can see the file of a crashed export there.
- When `ffmpeg` reads neither spelling, the export fails. No inline form stays as a fallback.
- An export joins at most 256 pieces.
- Each FLV source gets its own head.
- An export whose pieces are too far out of source order fails before the save dialog.
- The renderer creates no links to the sources. On Windows, an ordinary user cannot always create
  a symbolic link, and a hard link must stay on one volume.

## Measurements

These measurements used FFmpeg 9.0.2 (Homebrew) on macOS, with 10 CPU cores. The sources were
H.264 at 30 fps with a GOP of 2 s: 120 s at 1920x1080 and 60 s at 3840x2160. Each piece was
0.4 s long, and `concat` joined the pieces.

1. `-/filter_complex <file>` ran and exited 0. `-filter_complex_script <file>` printed
   `Unrecognized option 'filter_complex_script'` and exited 8. `-/i <file>` printed
   `Unrecognized option '/i'`. So the inputs cannot move into a file.
2. Each piece read its own input with `-ss`. The peak memory grew with the count of inputs:

   | Inputs | 1080p | 2160p |
   | --- | --- | --- |
   | 25 | 799 MiB | 2549 MiB |
   | 50 | 1410 MiB | 3391 MiB |
   | 100 | 1994 MiB | 4150 MiB |
   | 200 | 3200 MiB | 4375 MiB |

   `-threads 2` on each input did not lower it: 4619 MiB at 1080p with 200 inputs.
3. The same 200 pieces, in source order, through one input and `split`: 128 MiB at 1080p and
   420 MiB at 2160p. This run was also faster: 1.1 s against 5.1 s at 1080p.
4. Two sources of 1080p, 200 pieces that alternate between the sources, each source in source
   order: two inputs with `split` used 272 MiB.
5. One source of 1080p, 40 pieces in reverse source order, through one input and `split`: 1528 MiB.
   `concat` holds the frames that `split` gives a piece that waits. ADR 014 measured the same
   cost: one wait of 50 s at 1280x720 took 2078 MiB, against 156 MiB in source order.

## Decision

### The work directory

Each export creates the directory `export-<pid>-<n>` in the cache directory of the application
(`app_cache_dir()`). `<pid>` is the process ID of QuipClip. `<n>` is a counter of the process.
When a directory of that name exists, for example from a crash of a process with the same ID,
the export tries the next number. The work directory holds these files:

| File | Content |
| --- | --- |
| `encoder.graph` | The graph of the encoder |
| `audio.graph` | The graph of the audio process of ADR 043, when it runs |
| `probe.graph` | The graph of the option probe (see below) |
| `h<k>.flv` | The head of the FLV source at index `<k>` of the plan |

The encoder, the audio process of ADR 043, the copy process of ADR 048 and the option probe
start with the work directory as their current directory. Their commands name these files by
their names alone. The `ffprobe` runs of preparation keep their current directory and name a
head by its full path, as they do now.

Preparation creates the work directory before the first source. When the cache directory has no
path, or the work directory or a graph file cannot be written, the export fails with
`workDirectoryUnavailable`. A write never creates the work directory. So a write that an
abandoned helper (ADR 050) makes after the removal fails, and it leaves nothing.

The export removes the work directory after both processes end, and before the rename of the
output. A failure, a Stop, a panic and an abandoned preparation also remove it. On Windows, the
removal of the whole directory waits at most 511 ms in total for a file that another program
holds. That fits in the exit budget of ADR 017. When the removal fails, the export writes a log
line and keeps the path in a list of the process.

At the start of each preparation, a sweep tries the paths in that list again. It also removes
each `export-*` directory that the process does not use and whose modification time is at least
24 hours old. `ffmpeg` reads the graph file when it reads its options, and it opens each input,
with the parts of a `concat:` input, before it encodes. So a work directory is necessary only
until its processes start. 24 hours is far above the time limit of preparation (ADR 050), so the
sweep does not remove the directory of an export of another QuipClip process that runs now. On
Windows, an `ffmpeg` that outlives a crash keeps its current directory open. Then the sweep
fails, and it tries again at the next export.

### The option probe

Preparation finds the spelling that the installed `ffmpeg` reads. It writes `probe.graph` with
the graph `nullsrc=s=16x16:d=0.04[v]` and runs this command in the work directory:

```
ffmpeg -nostdin -hide_banner -loglevel error -/filter_complex probe.graph -map [v] -f null -
```

- Exit 0: the export uses `-/filter_complex`.
- An exit that is not 0, with the message `Unrecognized option`: the same command runs with
  `-filter_complex_script`. Exit 0 gives that spelling. The same message again gives
  `graphFileUnsupported`.
- A process that does not start gives `ffmpegSpawnFailed`. Another exit that is not 0, or no exit
  after 10 seconds, gives `ffmpegProcessFailed` with a detail. A Stop gives `canceled`.

The probe uses only parts that every video export also uses: `nullsrc`, the `null` muxer and its
default encoder. The process keeps a successful answer for each `ffmpeg` binary, by its path,
size and modification time. It keeps no failure. The probe runs only for an export whose
commands carry a graph, so a copy of the audio alone (ADR 048) never runs it. The capability
probe of ADR 006 and its cache do not change.

Each command that carries a graph names its file with the option that the probe found, for
example `-/filter_complex encoder.graph`. The file holds the text that the command line held
before: ASCII, with no byte order mark and no line end. Other commands keep a short inline graph:
the preset test (ADR 041) and the preview (ADR 046).

### The inputs of a process

A command line now holds the fixed arguments and the inputs. The plan chooses the inputs from
the pieces, not from the length of the command. A test proves that each choice fits the budget.

`MAX_EXPORT_INPUTS` is the largest count of inputs at which the widest command fits the Windows
budget. In that command, each input is an FLV input, each path has 259 characters, and each
setting is at its widest. One process never opens more inputs than that. The pipe of the encoder
does not count. A dated note of this record gives the measured value. It is below the 91 inputs
of the widest export before this record, so the memory and the file handles of the worst export
do not grow. An FLV input holds two files, so the count stays below the 256 file descriptors of a
macOS application.

Each process applies these rules to the pieces that it reads from an input. For example, the
audio process of ADR 043 reads only the pieces that read audio, as now. The first rule that
applies gives the inputs:

1. When the process reads at most `MAX_EXPORT_INPUTS` pieces, each piece gets its own input, as
   before.
2. Otherwise, the pieces of each source are divided into runs. A run is a sequence of pieces in
   export order. Each piece of a run starts at or after the Out point of the piece before it, in
   the time of that source. A run reads one input from the seek of its first piece, and `split`
   and `asplit` give each piece its frames. No piece of a run waits, so `concat` holds no frames
   (measurements 3 and 4).
   - The plan finds the fewest runs. It takes the pieces in export order. It adds each piece to
     the run of the same source that has the latest Out point at or before the In point of the
     piece. When no run has such an Out point, the piece starts a new run.
   - A gap between two pieces of a run is a part of the source that the input decodes and no
     piece uses. While there are fewer inputs than `MAX_EXPORT_INPUTS`, the plan divides a run
     at its largest gap of at least 30 seconds. It compares the gaps of all sources as
     durations in seconds, never as raw PTS (ADR 002).
   - A source whose pieces are in source order, with no gap of 30 seconds, needs one input. That
     is the single-input shape of ADR 014.
3. When all the pieces of the request need more runs than `MAX_EXPORT_INPUTS`, the export fails
   with `piecesOutOfOrder`. The message names the limit. A process reads a subset of the pieces
   in the same order, so it never needs more runs than all the pieces.

A command longer than the budget does not start. The export then fails with `ffmpegSpawnFailed`
and a detail. The test of the budget makes this case impossible.

### The limits and their order

- An export joins at most 256 pieces (`MAX_EXPORT_PIECES`). A segment that crosses a junction
  counts one piece for each of its clips, as before.
- An export uses at most `MAX_EXPORT_INPUTS` sources, because each source needs one input.
- The read of the audio gaps (ADR 014 measurement 28) adds about 27 bytes for each piece to its
  `ffprobe` command. At 256 pieces of one source, that command must fit the budget too.
- The backend checks the request in this order: `noSegments`, `tooManySegments`,
  `invalidSources`, `tooManySources`, `invalidSegmentCount`, `invalidSegment` and
  `piecesOutOfOrder`. The count of runs needs valid source IDs and In points before Out points,
  so it comes last.
- The OPEN step of the export checks `tooManySegments`, `tooManySources` and `piecesOutOfOrder`
  in that order, before the save dialog. It counts the runs with the same rule as the backend.
  Each message names its limit.

The rule 92 − S of ADR 014 and ADR 053 ends.

### The FLV heads

Each FLV source gets its own head in the work directory, `h<k>.flv`. The rule of ADR 053 that one
command can name only one head ends. Each FLV source gets the FLV input of ADR 046.

- The head is the head of the earliest slice that starts an input of that source.
- The slice check of ADR 046 decodes only the slices that start an input. So it runs at most
  `MAX_EXPORT_INPUTS` `ffprobe` processes in its one time limit, as before.
- The cache of ADR 046 keeps the keyframe table. It no longer holds `head.flv` for the export.
- When a head cannot be written, that source uses the input seek, as before.

## Consequences

- The limit of pieces no longer depends on the filters of a chain. A new filter in each chain
  costs no command-line bytes.
- An export of more pieces than `MAX_EXPORT_INPUTS` reads its sources through runs. Pieces in
  source order then use much less memory than one input for each piece (measurements 3 and 4).
  An export far out of order fails before the save dialog, not in `ffmpeg` with too little
  memory (measurement 5).
- An export of at most `MAX_EXPORT_INPUTS` pieces keeps one input for each piece and its memory
  cost (measurement 2). On macOS, an export of more pieces than that and at most 91 pieces used
  that shape before. It now uses runs.
- The 30-second rule is a judgement. Decoding 30 s of a 30 fps source takes 900 frames, and one
  more input costs about 15 to 35 MiB (measurement 2).
- Each `ffmpeg` binary runs the option probe once in a session.
- A crash can leave a work directory in the cache. A later export removes it after 24 hours. It
  holds small files only: the graphs and the heads.
- Old `head.flv` files stay in `flv-cache` until its eviction removes their directory.
- An export of many FLV sources opens each of them in the source cache of the preview. So the
  preview can lose its keyframe tables sooner (`KEPT_SOURCES` and `KEEP_SOURCES` of ADR 046).
- `MAX_AUDIO_PREFIXES` of ADR 014 was set by the command-line budget. That reason is gone. This
  record keeps its value of 16. A later record can raise it.
- The frontend and the backend count the runs with the same rule. A shared table of cases tests
  both.
- An `ffmpeg` older than 2.0 reads neither spelling, and its export fails with
  `graphFileUnsupported`. No supported build is in that case.
