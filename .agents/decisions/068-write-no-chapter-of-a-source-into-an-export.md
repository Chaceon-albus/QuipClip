# 068. Write no chapter of a source into an export

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 014, ADR 048, ADR 055

## Context

The FFmpeg commands of an export name no chapter option. FFmpeg then copies the chapters of the
first input that has chapters into the output file.

A measurement on 2026-11-26 with FFmpeg 9.1 on macOS showed the result. The source was an MP4
of 30 seconds with two chapters, from 0 to 12 seconds and from 12 to 30 seconds.

**The encoder command.** The commands had the shape of ADR 014: one `-copyts`, an input seek for
each input, `trim`, `setpts`, `fps` and `concat`, and the muxers `mp4` and `mov` with
`-movflags +faststart`, and `matroska`. The export joined the source ranges from 5 to 8 seconds
and from 15 to 19 seconds. Those ranges have 7 seconds and 210 frames.

- In MP4, MOV and Matroska, the output had the two chapters of the source, with the starts 0
  and 12 seconds and the ends 12 and 30 seconds. The input seek did not move them, and the
  length of the output did not cut them.
- In MP4 and MOV, the movie header of the output then gave a duration of 30 seconds. ffprobe
  still reported 7.000 seconds as the duration of the format. For Matroska it reported 7.021
  seconds, with the chapters and without them.
- With two sources of which only the second had chapters, the output had the chapters of the
  second source.
- With the output option `-map_chapters -1`, the output had no chapter and no chapter track. In
  MP4 and MOV the movie header then gave 7 seconds. The tags of the file and the tags of the
  video and audio streams were the same as before. The `moov` atom was still in front of the
  media data, and the video still had 210 frames.

**The command that copies the audio into a file (ADR 048).** That command cuts with an output
seek and an output stop. A copy of the source range from 5 to 8 seconds into `.m4a` had one
chapter, from 0 to 3 seconds: the cut moved and shortened the chapters of the source. Its movie
header gave 3.011 seconds with the chapter track and without it.

So a file that QuipClip exports from a source with chapters has chapters that it did not ask
for. From the encoder they name wrong places, and an MP4 or MOV file then has a wrong duration
in its movie header.

## Decision

Each FFmpeg command of an export that writes the output file has the output option
`-map_chapters -1`. Those commands are:

- the encoder command (ADR 014), also when its audio comes from the pipe of ADR 043 or from the
  copy pipe of ADR 048
- the command that copies the audio into a file with no video (ADR 048)

The option follows the last `-map` option of the command and, in the encoder of a copy, the
`-map_metadata:s:a:0` option that the command has today. The commands get no `-map_metadata`
option that they do not have today. So the tags of the file, and the tags of the video and
audio streams, stay as they are.

The other FFmpeg commands write no file that QuipClip publishes: the audio process of ADR 043,
the copy process of ADR 048 that writes into a pipe, the loudness measurement (ADR 061) and the
preset test (ADR 041). They do not change. The encoder removes a chapter that the copy pipe
carries.

A user cannot set the option in a preset. `map_chapters` is one of the option names that a
preset refuses (ADR 040).

### The length of the command

The option adds 21 bytes to the encoder command, as the test of ADR 055 counts them. In the
fixture of that test, whose paths are ASCII, the widest encoder command now has 31,469 bytes
with 85 inputs and 31,814 bytes with 86 inputs. The limit of 85 inputs stays.

The guard of ADR 055 refuses a command of more than 31,743 bytes in UTF-8 before FFmpeg starts.
A command that had from 31,723 to 31,743 bytes before this record is now refused, with
`ffmpegSpawnFailed`. Such a command has many inputs with long paths. This record does not
change the guard.

## Consequences

- A file that QuipClip exports has no chapters.
- An MP4 or MOV file that the encoder writes from a source with chapters has the duration of its
  own media in its movie header.
- An `.m4a` file that copies the audio of a source with chapters no longer has a chapter track.
  ffprobe can then report a slightly shorter duration of the format for it: 2.995 seconds in
  place of 3.011 seconds in a test of the measured file. The check of an audio-only export reads
  that duration (ADR 036), and both values passed it.
- An export whose command was within 21 bytes of the limit of ADR 055 is now refused.
- A later record can write a chapter for each segment. The same measurement showed that FFmpeg
  takes chapters from an `ffmetadata` input with `-map_chapters` and its index. A test in the
  review of this record showed that the place of a segment in the output is not always the sum
  of the planned frame counts of the pieces before it. So that record first needs a rule for the
  place of each chapter.
- The measurement is of FFmpeg 9.1 only.
