# 056. Show the audio envelope of a source on the timeline

- Status: Accepted
- Date: 2026-10-28
- Deciders: capric98
- Amends: ADR 007, ADR 017, ADR 046, ADR 052

## Context

The user records live streams, and each recording is several hours long. The user must find the
parts where a person sings or speaks. A loudness envelope on the timeline shows these parts. The
user does not need the waveform of each sample.

The page cannot compute the envelope:

- The content security policy permits `asset:` under `media-src` only (ADR 019). The page cannot
  read the bytes of a file.
- The web views do not open FLV, MPEG-TS and some other containers (ADR 046).
- A decode in the page keeps all the PCM in memory. At 48 kHz stereo in 32-bit float, one hour
  is about 1.4 GB.

FFmpeg and Rust can compute it. But the envelope needs one read of the whole file. ADR 046
rejected a second read of the source for the scrub cue. FLV interleaves audio and video, so an
audio read also reads all the video bytes. On a network share, a read of a recording of 10 GB
takes minutes.

The user chose these points:

- The feature is off by default. The menu of a clip label starts it for the source of that clip.
- The envelope fills from left to right while FFmpeg reads the file.
- One envelope job runs at a time in the application.
- While the job runs, the same menu item cancels it.
- A notice says that the preview can stutter while the job reads the file.
- The result goes into a cache. The cache has a fixed size limit and a periodic cleanup. The
  Settings window shows its size and can clear it.
- The envelope shows only for the current application run. A later request reads the cache.
- The envelope is a translucent layer above the segments.

## Measurements

These measurements used FFmpeg 9.0.2 (Homebrew) on macOS. Each test file of measurements 1 to 9
was 20 s of H.264 at 30 fps with two B-frames and a GOP of 2 s, and AAC at 48 kHz. The audio had
a 1 kHz burst of 50 ms at the start of each second. A script folded the output into buckets of
10 ms, found the start of each burst, and compared it with the position that the generator
gave.

The command was:

```
ffmpeg -nostdin -copyts -i <file> -map 0:<audio index>
  -af aresample=8000,aresample=async=1:min_hard_comp=0.01:first_pts=<N> -f s16le -ac 1 pipe:1
```

`N` is `videoStartPts × videoTimeBase × 8000`, rounded. Sample 0 of the output is then the time
of `videoStartPts`, which is media time 0 of the preview (ADR 046).

1. Each burst started within one bucket of its correct position in these files: MP4, MKV,
   MPEG-TS that starts at 1.4 s and at 601.4 s, and FLV. The same was true with the audio 0.279 s
   late (MP4, FLV, MPEG-TS) and 0.3 s early (MKV, FLV, MPEG-TS).
2. In an MP4 without an edit list, the first audio packet lasted 3200 ticks of 1/48000. The
   `async` filling put each burst at its correct position. A decode that counts samples from the
   first frame put each burst 50 ms early.
3. A negative `first_pts` is valid. With `first_pts=-4000`, the output started with 0.5 s of
   silence, and the first burst was in bucket 50. A negative `videoStartPts` therefore needs no
   other command.
4. Two MPEG-TS files were joined with the `concat` protocol: 10 s at 48 kHz, then 10 s at
   44.1 kHz, with continuous timestamps. At the change of the sample rate, FFmpeg made the filter
   graph again. The new `aresample` applied `first_pts` again and added silence from `N` to the
   time of the change. Each burst after the change was 9.93 s late, and the output was 29.9 s
   long. With `-reinit_filter 0`, FFmpeg stopped at the change with "Changing audio frame
   properties on the fly is not supported". At `-loglevel info`, FFmpeg wrote the line
   "Reconfiguring filter graph because audio parameters changed" at the change. It wrote no such
   line for the files of measurements 1 and 2.
5. The same change in one FLV, read directly, put each burst after the change 20 s late.
6. Rust can send the audio tags of an FLV to FFmpeg through stdin, with `-f flv -copyts -i
   pipe:0`. The stream starts with an FLV header with the flags `0x04` (audio only) and the AAC
   configuration tag. The audio tags follow. A new process starts at a changed AAC
   configuration. With the origin at the `videoStartPts` of the probe, each run put the bursts at
   the correct positions, also after the change of measurement 5. For files with no change, the
   runs and the direct read gave the same bucket for each burst.
7. An FLV whose timestamps start again at 0 after 20 s (a reconnect): the direct read with
   `async` dropped the second recording. The runs placed the second recording on the start of the
   first one. MSE in the preview does the same with later data of the same time (ADR 046).
8. An FLV with a forward jump of 100 s: the direct read and the runs put the second part at the
   same buckets. The runs did not send the silence of the gap through the pipe.
9. The first PCM byte of a run came about 47 ms after the start of its process.
10. FFmpeg decoded the audio of a 404 MB FLV of 10 minutes in 0.27 s (0.49 s of CPU), from the
    page cache. The read of the file therefore sets the time of a job. On a share at 110 MB/s,
    a recording of 10 GB needs about 90 s. This value is an estimate. No measurement of the
    contention with the preview on a share exists yet.

## Decision

### The menu item

The menu of each clip label (`ClipLabels`) gets one item at the top, then a separator. The item
acts on the source of the clip. Its text follows the state of that source:

| State of the source                    | Item              | Enabled                        |
| -------------------------------------- | ----------------- | ------------------------------ |
| No envelope, no job                    | Show Waveform     | When no other job runs         |
| A job of this source runs              | Cancel Waveform   | Yes                            |
| The envelope shows                     | Hide Waveform     | Yes                            |
| No audio stream, or no `videoStartPts` | Show Waveform     | No                             |

The item calls the envelope a waveform, because users know that word. The item does not go into
the segment menu. ADR 026 does not change.

The envelope belongs to the source. Each clip of the source draws the part of the envelope in the
range of that clip (ADR 052).

The page keeps the state for the current application run only. The state does not go into the
project file, the settings file, the undo stack or the web view storage. Hide drops the data in
the page. A later Show reads the cache, so the envelope shows again at once.

### The job

One job runs at a time in the application. A request while a job runs fails with `busy`. A cache
hit does not take the slot: Rust sends the cached data at once.

The page sends the values of its import result: the path, size and modification time of the
source, the index of the audio stream that the probe chose, `videoStartPts` with its time base,
and `approximateDurationSeconds` when the probe has it. Rust checks the path, the asset scope and
the revision as the preview does (ADR 046).

The job decodes the audio to 8 kHz mono `s16le`. One bucket is 10 ms, 80 samples. Bucket `k`
holds the time from `k/100` to `(k+1)/100` seconds after `videoStartPts`.

`min_hard_comp=0.01` fills or cuts at a drift of one bucket. The default of `aresample` is
100 ms. The preview PCM keeps the default, because its windows are short. A job reads hours of
audio.

The input of FFmpeg depends on the container:

- **Not FLV.** One process, with the command of the measurements. `-map` names the audio stream
  that the probe chose (`AudioProbe.index`), not `0:a:0`.
- **FLV.** Rust reads the tags of the file in order and sends the audio tags only, in runs
  (measurement 6). A new run starts at one of these:
  - A timestamp that jumps more than 10 s forward or backward from the previous audio tag.
  - An AAC configuration tag whose data differs from the current configuration. A copy of the
    current configuration does not start a run.

  Each run has its own process. The start of a run is the later of `videoStartPts` and the time
  of its first audio tag, rounded down to a bucket boundary. Bucket boundaries count from
  `videoStartPts`, so the start is never below bucket 0. `first_pts` names that start, and Rust
  writes the buckets of the run from it. The buckets of a later run replace the buckets of an
  earlier run at the same time (measurement 7). Then the end message has the flag
  `timestampsDecrease`. A backward jump of 10 s or less stays in its run, and `async` cuts the
  audio that overlaps. At a damaged tag, Rust searches for the next tag as the preview does
  (ADR 046). When it finds none, the job ends with the envelope that it has and the flag
  `damaged`.

  An FLV with audio that is not AAC, such as MP3, has no configuration tag. Its runs start only
  at a jump of the timestamps.

The audio format can change in the middle of a file that is not FLV, and in an FLV run of audio
that is not AAC. FFmpeg then adds silence (measurement 4). The job runs FFmpeg at
`-loglevel info -nostats` and reads each line of its error output. When a line holds
"Reconfiguring filter graph", the end message has the flag `alignmentUncertain`. As a second
check, when the output is more than 1 s longer than `approximateDurationSeconds`, the job sets
the same flag. With no duration, only the first check applies.

For each bucket, Rust keeps the peak and the RMS of the samples. Each value is one byte in steps
of 0.25 dB. Code 0 is silence, and code `c` is `c / 4 − 63.75` dB. One hour of audio is 720 kB.
The page chooses the scale of the display, so a change of the display does not change the cache.

Rust limits the count of buckets to `approximateDurationSeconds` × 1.25 + 60 s, and to 72 hours.
With no duration, only the 72 hours apply. Rust drops the buckets after the limit, and the end
message has the flag `truncated`. A damaged timestamp therefore cannot allocate a large buffer.

### The end of a job

| End                              | The page                       | The cache | The item next |
| -------------------------------- | ------------------------------ | --------- | ------------- |
| `complete`                       | Shows the envelope             | Keeps it  | Hide Waveform |
| `complete`, any other flag       | Shows the envelope             | Keeps it  | Hide Waveform |
| `complete`, `alignmentUncertain` | Shows the envelope             | Does not  | Hide Waveform |
| `canceled`                       | Drops the data that it has     | Does not  | Show Waveform |
| `failed`                         | Drops the data, shows an error | Does not  | Show Waveform |

The other flags are `timestampsDecrease`, `damaged` and `truncated`. The cache keeps them with
the envelope, and a cache hit gives them again.

### Cancel, reload and exit

A cancel sets the cancel flag of the job and kills its process. The reads of the file run on a
helper thread, and the job polls every 50 ms, as in ADR 050. After a cancel, the job waits at
most 2 s for that thread. Then it ends as `canceled` and frees the slot.

Each request carries a number: microseconds since the Unix epoch, as the requests of the preview
windows (ADR 046). When a page load of the main window starts, Rust sets the floor to the time
now and cancels the running job. Rust refuses each request below the floor. A late request of
the old page therefore cannot take the slot.

When the main window is destroyed, Rust cancels the job. The exit handler kills the job, refuses
each later request, and gives the job no part of the budget of ADR 017. The job writes its cache
file only at its end, with one atomic replace. A kill during that write can leave a temporary
file, and the cleanup deletes it after 1 hour.

### The channel

The start command returns at once, and the data comes through a Tauri channel:

- A binary message holds a little-endian `u32` start bucket, a little-endian `u32` count, and
  the count of byte pairs, peak first. During a job, Rust sends one each 250 ms. A cache hit
  sends messages of at most 65,536 buckets.
- A JSON progress message comes at most 4 times each second.
- A JSON end message gives the status (`complete`, `canceled` or `failed`), an error code, the
  count of buckets, and the flags `cached`, `timestampsDecrease`, `damaged`, `truncated` and
  `alignmentUncertain`.

Error codes are stable names (ADR 011):

- The start command: `invalidRequest`, `sourceUnreadable`, `sourceNotAllowed`, `sourceChanged`,
  `noAudio`, `busy`, `superseded`, `closed`, `cacheUnavailable`, `ffmpegNotFound` and
  `commandExecutionFailed`.
- The end message: `spawnFailed`, `readFailed`, `decodeFailed` and `sourceChanged`. A failure
  of FFmpeg also gives the last lines of its error output, untranslated (ADR 011).

When a message cannot go to the page, the job cancels itself.

### The cache

The cache is the directory `waveform` in the application cache directory. Each entry is one
file. The name of the file is an FNV-1a hash of these values, as in the key of the FLV cache
(ADR 046):

- the path, size and modification time of the source
- the audio stream index
- the origin PTS and its time base
- the format version, the sample rate and the bucket rate

The file holds a header with all of these values, then the data. A file whose header does not
agree, or whose data has the wrong length, is a miss, and Rust deletes it.

- The cache holds at most 256 MiB. When it holds more, Rust deletes the entries that were used
  least recently. A hit sets the modification time of the file to now, so that time is the time
  of the last use.
- Rust deletes each entry that was not used for 30 days, and each temporary file that is older
  than 1 hour.
- The cleanup runs once on a background thread after each start of the application, after each
  write, and on a clear. So the cache gets its cleanup also when the user does not use the
  feature.
- One lock holds every read, write, cleanup and clear of the cache.
- At the end of a job, Rust reads the size and the modification time of the source again. When
  they changed, as when a recorder still writes the file, the job fails with `sourceChanged` and
  writes no cache.

The General tab of the Settings window shows the size of the cache and has a Clear button. The
limits are constants, so the settings file does not change (ADR 013).

### The display

One `<canvas>` draws the envelope of every clip whose source shows it. The canvas covers the
visible part of the lane plus a margin on each side, and it moves with the scroll. Its layer is
above the segments (z-index 10) and below the clip labels, the pending In, the trim preview
(z-index 20) and the playhead (z-index 30). It takes no pointer events, and the accessibility tree
does not show it.

The canvas draws the envelope about the centre line of the track, on a dB scale down to −54 dB.
The RMS is the darker part, and the peak is the lighter part. A column of pixels shows the
highest code of the buckets in it. When a bucket is wider than one column, each column of the
bucket shows its code.

The position of each clip comes from `calculateClipBarLayouts`, which places the clip bars. The
time in a source comes from the clip range and the virtual timeline only (ADR 052).

The envelope grows while the data comes. The growth comes from new data. It is not an animation,
so the motion rule of ADR 007 does not apply to it.

### The notice

When a job starts without a cache hit, the notification area of the preview shows a warning. The
warning gives the name of the file and the progress. It says that the preview can stutter until
the job ends. The user can close it. It closes when the job ends. A failed job shows an error
notice.

## Rejected alternatives

- **A decode in the page.** The page cannot read the file, the web view cannot open FLV, and the
  PCM of one hour needs about 1.4 GB.
- **PCM to the page.** Four hours of PCM at 8 kHz is about 230 MB through the channel. The fold
  in Rust is a short loop.
- **An image from the `showwavespic` filter for each view.** It shows the RMS only, it needs a
  new image after each zoom, and it needs a seek for each view.
- **A direct read of an FLV.** It puts the audio after a changed AAC configuration at the wrong
  time, and it drops a recording after a restart of the timestamps (measurements 5 and 7).
- **`-reinit_filter 0` against a changed format.** FFmpeg stops at the change (measurement 4).
- **A native context menu on the clip bar.** The user chose the menu of the clip label.
- **A size limit in the settings file.** It needs a new schema version (ADR 013). The user chose a
  fixed limit.

## Consequences

- A job reads the whole source. On a share, the preview reads the same file at the same time and
  can stutter. The notice says so. This version does not limit the rate of the read. If the
  measurement on a share shows stalls of the preview, a later change can limit it.
- A file that is not FLV and that changes its audio format shows an envelope that can be late
  after the change. The cache does not keep that envelope.
- After a restart of the FLV timestamps, the envelope shows the later recording where the two
  overlap, as the preview does.
- Four new commands: `start_waveform`, `cancel_waveform`, `waveform_cache_usage` and
  `clear_waveform_cache`. The Settings window can call the last two.
- The envelope shows no detail below 10 ms. A long source shows few pixels for each second,
  because the content of the timeline is at most 100,000 px wide
  (`MAX_TIMELINE_CONTENT_WIDTH_PX`).
