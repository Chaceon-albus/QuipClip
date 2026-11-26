# 070. Choose the audio stream of a source

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 010, ADR 019, ADR 024, ADR 046, ADR 056, ADR 061, ADR 062

## Context

A file can hold several audio streams. A recording program can write the microphone and the
sound of the desktop as two streams of one file.

QuipClip used one audio stream of each source, and the user could not choose it. The parts of
QuipClip did not all use the same stream:

- The probe keeps one audio stream, the **preferred** stream: the first one with the `default`
  disposition, or the first audio stream when none has it. It does not keep the others, and it
  reads no language and no title.
- The export and the loudness measurement (ADR 061) read the preferred stream by its absolute
  index (ADR 014). The audio envelope (ADR 056) does the same, except for an FLV, whose input
  holds the audio tags only and is mapped as `0:a:0`.
- The windows of a `MediaSource` source and the PCM windows of the cue map `0:a:0`, the first
  audio stream of their input (ADR 046, ADR 062). For a file that is not an FLV, that is a
  different audio stream from the preferred one when the stream with the `default` disposition
  is not the first. The page still decides between a copy and a transcode of that audio from
  the codec of the preferred stream.
- The native `<video>` element, and the hidden `<audio>` element of the cue, play the stream
  that the web view chooses (ADR 019). No code reads the `audioTracks` of an element. The
  repository records no test of which stream each web view plays.

The user asked for a way to choose the stream. A file with one audio stream must look and
behave as before.

## Decision

### The probe lists the audio streams

The probe keeps a list of all the audio streams of a file, in the order of the file. For each
one it keeps the absolute index, the codec, the sample rate, the channel count, the `default`
disposition, and the `language` and `title` tags when the stream has them. It reads those two
tags in each letter case, because some Matroska files have them in upper case. The preferred
stream stays as it is, by the same rule.

### The override and the effective stream

The user can set an **override** for a source: one of its audio streams. The **effective**
audio stream of a source is its override, or its preferred stream when it has no override.

- The override is state of the session, kept for the id of the source. The id of a source names
  one revision of a file (ADR 007), so a file that changed is a new source with no override. Two
  clips of one source have one override.
- The override is not an edit of the timeline, and Undo does not change it.
- The override records the absolute index of the stream, and its codec, its sample rate and its
  channel count from the probe of the import.
- The persisted source of the project document gets the optional field `audioStreamIndex`
  (ADR 010). A document without it has no override. Version 1 still writes no project file.

The menu of a clip label gets a submenu, "Audio Track", only for a source with two or more
audio streams. It has one item for each stream, and a mark on the effective one. An item shows
the number of the stream among the audio streams, from 1, its title or its language when the
file gives one, its codec and its channel count. The menus of two clips of one source show and
set the same override. A source with one audio stream, or with none, has no such submenu, and
nothing else in the interface changes for it.

A source that is an FLV has no such submenu and no override, also when the probe lists two or
more audio streams. QuipClip reads one audio stream of an FLV (ADR 046), and each reader of an
FLV keeps its own mapping.

### The export and the loudness measurement

The source of a request carries the optional field `audioStream` when the source has an
override: the recorded index, codec, sample rate and channel count.

- After its own probe, the backend takes the audio stream with that index in place of the
  preferred one. It refuses the request with `audioStreamChanged` when the file has no audio
  stream with that index, when the codec, the sample rate or the channel count of that stream
  differs from the request, or when the file is now an FLV. This also holds after "Export
  anyway" (ADR 024), which removes only the check of the revision.
- Each later step uses the full probe of that stream, as it used the preferred one: the first
  packet, the gaps, the plan, the copy of the audio and its tags.
- A request that writes no audio carries the field too, and the backend does not check it.
- When the effective stream of each source that has audio holds no packets, an export with no
  video is refused with `sourceHasNoAudio`, as before (ADR 036). An export with video writes
  silence for such a stream, as before (ADR 053). The backend never takes another stream in its
  place.

The loudness measurement prepares as an export does, with the same field. The key of a kept
result includes the effective stream of each source.

The confirm step of the export records the effective streams with the other facts of the step
before it opens the save dialog. When they differ after the dialog closes, the step sends
nothing and returns to the setup step. A change of an override while the setup step is open
gives the step new facts: the summary, the Copy audio switch and the stream switches read the
effective streams, and a measurement that runs for the old streams ends with no result.

### The audio envelope

The request of an envelope names the effective stream, which the cache key on disk already
includes. An FLV keeps its own mapping.

A change of the effective stream of a source ends the envelope job of that source, removes the
envelope that the timeline shows for it, and makes the page refuse each later message of that
job. The entries on disk stay under their keys.

### The preview through a MediaSource, and the PCM cue

For a source that is not an FLV, the request of a window names the effective stream, and FFmpeg
maps it by its absolute index, not `0:a:0`. The page decides between a copy and a transcode of
the audio from the codec of that stream, with the checks of ADR 046. An FLV has one audio
stream for QuipClip, and its inputs keep the mapping `0:a:0`. The backend refuses a request
that reads audio of a source that is not an FLV and names no stream. It does not probe the file
again for each window. The revision of the source binds the index to the file (ADR 058).

- **A `MediaSource` source.** A change of the effective stream replaces the preview element
  through the reload of ADR 039, with no stall, as a recalibration does (ADR 063). The new
  element gets a new MediaSource and new windows, and it goes back to the position of the
  playhead. The playback does not start again.
- **A native source with a PCM cue (ADR 062).** A change of the effective stream replaces the
  cue, with its PCM and its windows. The element and its calibration do not change.

### The native preview

The native `<video>` element and the hidden `<audio>` element play the stream that the web view
chooses, as before. QuipClip does not control it and does not know it.

For a native source with two or more audio streams, the submenu therefore shows a note: the
playback of the preview can use a different audio track from the one that the export uses. The
note shows for each effective stream, also the preferred one. The step cue plays the effective
stream only where the PCM cue is active.

## Consequences

- For a file with one audio stream, the interface and each output stay the same.
- For a file whose audio stream with the `default` disposition is not its first audio stream,
  the preview through a MediaSource and the PCM cue now use the preferred stream, with no action
  of the user. Before, they used the first stream, with the codec decision of the preferred one.
  The sound of such a preview can change, appear or go.
- FFmpeg writes an MP4 header that is not valid for a window that copies an AC-3 stream with no
  packet in that window. The preview then shows the decode failure panel. This was so before
  for the first audio stream of a file. It is now so for the effective stream. A file whose
  preferred stream is such a stream, and is not its first audio stream, can thus lose a
  preview that it had.
- For a native source with several audio streams, the sound of the playback can differ from the
  sound of the export, the envelope and the PCM cue, as it could before. The note says so. A
  later record can set the audio track of the element, after a test of the two web views.
- A stream with no packets and with no sample rate in the probe stops an export that writes
  audio with `sourceAudioRateUnknown`, before the rule of the silence applies. A preferred
  stream of that kind did so before. The user can now choose such a stream.
- An override that names the preferred stream is an override: the request carries it, and the
  backend checks it. The loudness measurement keeps one result for it and for no override,
  because the effective stream is the same.
- An override lasts for the session, until a version saves the project.
- A change of the override of a `MediaSource` source loads the preview again, so the preview
  shows a short wait and stops a playback.
