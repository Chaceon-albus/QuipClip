# 046. Preview a container that the web view cannot open through MediaSource windows

- Status: Accepted
- Date: 2026-10-17
- Deciders: capric98
- Amends: ADR 002, ADR 003, ADR 014, ADR 017, ADR 019, ADR 022, ADR 026, ADR 028, ADR 039,
  ADR 043

## Context

WebView2 and WKWebView do not open FLV. They also do not open MPEG-TS, AVI and ASF (WMV), and
WKWebView does not open MKV. For these containers the preview shows the decode failure panel of
ADR 003, and the panel tells the user to convert the file. ADR 003 planned a proxy file for this
case: FFmpeg writes a file that the web view can open, and the preview plays that file.

The user records live streams as FLV. The files are many gigabytes, and they are on a NAS that
the computer reads over SMB. Some recorders keep writing the same file after the stream
reconnects, and they write a new decoder configuration there. A proxy file must read the whole
source and write a second large file before the first frame shows. That takes minutes on a
share, and it doubles the disk use.

The export has a related fault. FFmpeg cannot seek in an FLV that has no keyframe index. An FLV
from a live recorder has no such index, so `-ss T` reads the file from its start up to `T`
(measurement 1). An export of a segment late in the file therefore reads almost the whole file.

`MediaSource` lets the page give the `<video>` element the bytes of a fragmented MP4 (fMP4) in
pieces. FFmpeg can remux a part of the source into fMP4 with `-c copy`, which decodes nothing.
The preview can therefore read and remux only the part that it plays.

## Measurements

These measurements use ffmpeg 9.0.2 on macOS. The research of 2026-10-16 measured items 1 to 6.
It counted the bytes that FFmpeg read through an HTTP server that logs each `Range` request. The
test of 2026-10-17 measured items 7 to 21 with a WKWebView on macOS and HeadlessChrome 155. Its
media are 120 s of 1280x720 H.264 High with B-frames at 30 fps, a GOP of 2 s, and AAC at 48 kHz.
One more file is 1920x1080 at 14 Mbit/s with a GOP of 10 s.

1. The test used `-ss` on a 427 MB FLV of 240 s without a keyframe index. FFmpeg read 68.5 MB
   for 30 s, 119.7 MB for 60 s, 222.9 MB for 120 s and 409.5 MB for 230 s. It demuxed and did
   not decode, so the CPU time was 0.2 s. The same seek read 14.0 MB on MPEG-TS, 8.1 MB on MKV,
   9.2 MB on MP4, and 11.2 MB on an FLV that FFmpeg wrote with `add_keyframe_index`.
2. A window that starts at a mid-file keyframe can use the `concat` and `subfile` protocols:
   `-copyts -i "concat:head.flv|subfile,,start,X,end,SIZE,,:file.flv"`. `head.flv` holds the
   bytes before the first media tag, and `X` is the byte offset of a keyframe tag. The frames and
   timestamps were the same as in the source. For 31.7 s from the keyframe at 198.265 s, FFmpeg
   read 57.6 MB, of which the window was 56.4 MB. It read 5.4 MB when the reader took only the
   first fragment.
3. FFmpeg starts in about 40 ms. It writes the first fMP4 byte of a 4.4 MB slice 50 ms after the
   start.
4. The mp4 muxer gives each track its own origin in a window that starts mid-file. Video starts
   at 0.067 s and audio at 0.000 s, so the audio lag of 18 ms is lost. The fix is
   `-movflags frag_keyframe+empty_moov+default_base_moof+frag_discont -use_editlist 0` with
   `-copyts` and `-avoid_negative_ts disabled`. Then the `tfdt` of each track keeps its absolute
   decode time (video 10.010 s, audio 10.028 s) and the file has no edit list.
5. The FLV time base is 1/1000. ffprobe reports `duration_ts` and `nb_frames` as N/A. Without
   `onMetaData`, `format.duration` is the end timestamp: 1254.477 for a 20 s file that starts at
   1234.567. With `onMetaData` it is the length that the metadata gives. `avg_frame_rate` was
   989/33 and 1000/33 on files where `r_frame_rate` was the correct 30/1.
6. A copy window from MPEG-TS into fMP4 needs `-bsf:a aac_adtstoasc`. Without it the mp4 muxer
   refuses the ADTS AAC and writes zero frames. An output `-t` with `-copyts` is compared with
   the absolute timestamps and writes zero frames on MPEG-TS and on MKV. An input `-t`, before
   `-i`, works. `-movflags negative_cts_offsets` moved the first video PTS by one frame (from
   1072 to 1616 ticks of 1/16000).
7. The test fed a window through stdin, with
   `head + slice | ffmpeg -f flv -copyts -i pipe:0 ... -c copy -f mp4`. The window from the
   keyframe at 60 s holds the same 300 video packets as the source: the same PTS, DTS, size and
   MD5. The audio data is the same. The mp4 container gives the audio exact sample timing, which
   differs from the millisecond timestamps of the FLV by 1 ms at most.
8. In that window the `tfdt` is absolute for each track: video 60.067 s, audio 60.014 s.
9. A head of the FLV header and the config tags, with no script tag, gives the streams in the
   order of the source: video 0, audio 1. This is true for a file with `onMetaData` and for a
   file without it.
10. With `frag_keyframe` alone, the first fragment waits for the next keyframe. These are the
    times to the first fragment of a 14 Mbit/s window with a GOP of 10 s, fed at a fixed rate:

    | Feed rate | `frag_keyframe` alone | `-frag_duration 500000` |
    | --------- | --------------------- | ----------------------- |
    | 30 MB/s   | 589 ms                | 80 ms                   |
    | 100 MB/s  | 180 ms                | 49 ms                   |

11. One read can feed two FFmpeg processes. A tee of 10.42 MB to a remux process and an
    audio process completed both. When the audio process was killed partway, the remux process
    still completed.
12. The MPEG-TS window also needs the movflag `delay_moov`. With the bitstream filter alone, the
    muxer writes the `moov` before the first packet, so the `esds` holds no AudioSpecificConfig.
    WKWebView then failed the append with `MEDIA_ERR_DECODE` and closed the MediaSource. With
    `delay_moov` the `esds` holds the config. The research session then measured a TS that
    starts at 1234.567 s. With `frag_discont`, the `tfdt` stayed absolute, and the file had no
    edit list: video 1244.533 s (the keyframe DTS), audio 1244.412063 s (the first audio PTS).
13. `-ss 31` on MPEG-TS landed on the keyframe after the target, at 32 s. On MKV it landed on the
    keyframe before the target, at 30 s. ADR 014 records the same behaviour of MPEG-TS.
14. A copy window from an H.264 AVI with B-frames has PTS equal to DTS, because AVI stores no
    PTS. The frames then show in decode order.
15. Both web views reject MP3 inside MP4 (`mp4a.6B`, `mp4a.69` and `mp4a.40.34`). A window with
    `-c:v copy -c:a aac` plays. Its audio `start_time` moved 21.3 ms earlier than in the source.
    But a tone in the window started within 21 µs of the same tone in the FFmpeg decode of the
    source. The encoder places 1024 priming samples before the first real sample, and FFmpeg
    moves the first packet PTS back by that amount. `-af adelay=1024S` made the tone 21 ms late.
16. FFmpeg's matroska muxer writes the end timestamp as the duration of a file with a start
    offset. An MKV that starts at 1234.567 s reports a `format.duration` of 1354.588.
17. Both web views have `MediaSource` and `requestVideoFrameCallback`. Only WKWebView has
    `fastSeek`. `MediaSource.isTypeSupported` gave these results:

    | Codec string                               | WKWebView | Chrome |
    | ------------------------------------------ | --------- | ------ |
    | `avc1.64001F`, `avc1.640028`, `mp4a.40.2`  | yes       | yes    |
    | `mp4a.40.5`, `hvc1`, `hev1`, `fLaC`        | yes       | yes    |
    | `opus`                                     | no        | yes    |
    | `ac-3`                                     | yes       | no     |
    | `mp4a.6B`, `mp4a.69`, `mp4a.40.34`         | no        | no     |

18. The page set `timestampOffset` to −(start PTS × time base). The frame callbacks then gave a
    `mediaTime` equal to (PTS − start PTS) × time base:
    - With a time base of 1/1000, the error was 0 µs over 346 callbacks in WKWebView and 311 in
      Chrome.
    - With a time base of 1/90000, the error was 0.33 µs at most in WKWebView and 1 µs in Chrome.
    - No callback gave a PTS that differed from the frame's PTS by a tick.
    - The first callback after the load had a `mediaTime` of 0 in every case.
19. Both web views accepted the negative DTS of the first keyframe (−67 ms after the offset).
    Playback continued across the second init segment of a second window. Two more files played
    from 0, with `readyState` 4 and the first frame at 0. The video of one file starts at
    1234.588 s. The audio of the other starts 279 ms after its video. WKWebView reported
    `buffered` from 0.279 s for the second file, and it still played.
20. The page set the duration before the first append. A seek to 97 s, with data to 10 s, then
    stayed at 97 s and reported `seeking` until the data came. `seeked` followed 33 to 54 ms
    after the append, and the first frame 34 to 45 ms after it. After `endOfStream`, the element
    sent `ended` at the end. `abort()` while the source was `ended` threw `InvalidStateError` in
    both web views. A `remove` after the end set the source to `open` again.
21. An `<audio>` element on a MediaSource with audio windows played a scrub burst of 50 ms:
    - In Chrome, `seeked` arrived in less than 1 ms, and the burst ended about 95 ms after the
      request.
    - In WKWebView the seek took 2 to 54 ms, but the media clock started 210 to 250 ms after
      `play()`. The burst ended about 425 ms after the request.
    - A hidden `<video>` element and a window with video and audio gave the same delay in
      WKWebView.
22. (Added with the window command.) The `first_pts` option of `aresample` counts samples of the
    input rate of its filter, not of its output rate. With `aresample=48000:first_pts=N` on a
    44.1 kHz source, N counted 44.1 kHz samples, and a large N cut every sample. With
    `aresample=48000,aresample=async=1:first_pts=N`, a 1 kHz tone in the PCM started within
    42 µs (44.1 kHz) and 333 µs (48 kHz) of the same tone in the FFmpeg decode of the source,
    for a window from an FLV keyframe through stdin. For an MKV window with `-ss`, it started
    within 250 µs and 167 µs.
23. (Added with the export.) The test served a 212.9 MB FLV of 120 s without a keyframe index,
    1920x1080 H.264 at about 14 Mbit/s with a GOP of 10 s and AAC, through the HTTP server of
    items 1 to 6. It exported the segment from 100 s to 105 s with the trim of ADR 014. With
    `-ss 95`, FFmpeg read 212.7 MB. With the `concat` input from the keyframe at 90.067 s, which
    is the keyframe at or before In − 5 s, it read 30.9 MB. The `framemd5` of the 385 output
    frames of video and audio was the same. The `concat` protocol limits the protocols of its
    parts to `concat`, `file` and `subfile`, so the HTTP part needed `-protocol_whitelist`. The
    export opens only files.
24. (Added with the verification.) In HeadlessChrome and in WKWebView, a window across a
    reconnect with a new AVC configuration and another picture size gave `MEDIA_ERR_DECODE` at
    the join, and the seeks after the join stalled. With the end of the window at the changed
    config tag, every seek after the join showed its frame in Chrome.
25. (Added with the verification.) In 200 random seeks in HeadlessChrome, two kinds of seek
    stayed `seeking`: a seek that waited for a window that then stopped at its byte limit before
    the target, and a seek less than one GOP before the end of the appended video after the
    window had ended. With the rules of "Seeks", 200 seeks on each of two files passed, with a
    median of 83 ms (720p) and 135 ms (1080p, GOP 10 s) to the frame, and at most 303 ms.
26. (Added with the verification.) In WKWebView, a seek that began before its data was buffered
    ended wrongly when the data arrived, in 30 to 50 % of far seeks. Chrome showed none of these:
    - The element showed the next keyframe: for a target of 64.533 s it showed the frame of
      66.000 s, and `currentTime` stayed 64.533 s.
    - The element moved `currentTime` itself near the next keyframe, as from 14.358 s to 16.448 s.
    - The seek never ended, with the target buffered and the source ended, and the store queued
      every later seek behind it.
    A seek again to the same time, 1 ms away, or twice in one task changed nothing. A seek 3, 5
    or 10 ms away, after WebKit ended its seek, showed the right frame. A seek during the
    `seeked` of WebKit, or a seek back to the target of a seek that WebKit did not end, could
    stay `seeking` for good. With the repair of "Seeks", 60 exact seeks on each of two files and
    60 seeks of the ruler on 720p landed on the target frame in WKWebView, with a median of
    101 ms (720p) and 240 ms (1080p, GOP 10 s).
    (Added on 2026-10-18.) After WebKit moved the element by itself, the seek back to exactly the
    target ended 1 ms after it began, so WebKit did not seek again. In 2 of 11 such repairs the
    picture kept the frame where WebKit had moved. With the repair 3 ms from the target, that seek
    ended 16 to 164 ms after it began, and it showed the target frame in each of 16 such repairs.
    The runs with that repair had 720 exact seeks over six random series and 400 seeks to targets
    that were not buffered, on the 1080p and the 720p FLV, and each seek landed on its target
    frame.
27. (Added with the verification.) A test page ran the real preview, playback store,
    controller and cue in HeadlessChrome and in WKWebView on macOS, with the window code of the
    backend behind a test server in place of the IPC of Tauri. It opened seven FLV files: 720p
    with and without metadata, one that starts at 1234.567 s, one cut in the middle of a GOP,
    one with audio 300 ms late, one with a reconnect, 1080p at 14 Mbit/s with a GOP of 10 s,
    and one with MP3 audio.
    - The calibration was ready at the metadata, and every presented frame matched a PTS of
      ffprobe, also after seeks and frame steps. A frame step moved one frame.
    - The first frame showed 150 to 310 ms after the import, the probe included.
    - In Chrome a far seek showed its frame after 15 to 114 ms (720p) and 99 to 235 ms (1080p).
    - The cue started each burst 10 ms ahead on the clock of the context. The output latency
      was 24 ms in Chrome and 12.8 ms in WKWebView. In WKWebView the context started suspended
      and ran 8 to 14 ms later, so the first burst played about 12 ms late.
    - The first window of a 120 s file of 62 MB read 31.5 MB for its 60 s.
    - Playback reached `ended` at the end of each file.
28. (Added with the gap rule.) The same test page opened three FLV files with a stretch that the
    windows skip: a reconnect whose new part starts 1 s into a GOP, where the buffered data has
    a hole of 4.1 s, the reconnect file of measurement 27, with a hole of 2.1 s, and a 720p file
    with 200 KB of damage, with a hole of 2.3 s.
    - Both engines stopped at the end of the buffered range before the hole and stayed there.
      Chrome sent `waiting` and reported a position up to 0.29 s before the end while it waited.
      It showed no frame of the last 0.26 s before the hole. WebKit stopped at the end.
    - A seek into the hole stayed `seeking`. Its window started at the keyframe before the target
      and ended before it, and no window started after it.
    - In Chrome, a seek with less than about 200 ms of buffered data after its target showed its
      frame but stayed `seeking`: a target 0.237 s before the end completed, and one 0.187 s
      before it did not. The store then queued every later seek behind it.
    - WebKit completed a seek 0.05 s before the end of the range and showed its frame.
    - With the rule of "Seeks", the playback went on after the hole in both engines. A seek into
      the hole showed the first frame after it after 13 to 54 ms. Frame steps crossed the hole
      forward and back. In WKWebView they reached each frame before the hole.
    - Files without a hole played as in measurement 27, with no seek over a gap: nine files in
      Chrome and seven in WKWebView. 60 exact seeks on each of three files passed in Chrome. In
      WKWebView 60 passed on the 720p file and 59 on the 1080p file. In the miss, WebKit moved
      the element itself, and the seek back of the repair (measurement 26) showed no new frame.
      (Added on 2026-10-18.) The repair seeks 3 ms from the target there.
29. (Added with the NAL check.) A recording of 1360 s ended with a video tag whose frame data was
    `00 00 00 ca`. Its video is H.264 High at 1080x1920 with a NAL length size of 4, and its audio
    is AAC. The data is a length of 202 with no NAL unit after it. Probably the recording stopped
    there.
    - FFmpeg copied the frame into the window as a sample of 4 bytes and exited with 0.
    - Chromium 152 failed the append of that window with `MEDIA_ERR_DECODE`
      (`CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample for decode`). The
      MediaSource went to `ended`, and the picture of the position stayed on screen.
    - The page prefetches the last window, so the stall of ADR 039 showed 20 to 60 s before that
      tag. Each reload that reached the last window stalled again.
    - The same window without that tag played to `ended`. A temporary test ran the writer with
      the NAL check of "The window" on the file. Its window also played to `ended`.
    - No other sample of the file failed the NAL check. The file also has two or three IDR frames
      in a row at four places. Their PTS lie 2.5 to 7.3 s after their DTS. The file also has video
      gaps of 2.4 to 3 s with continuous audio. The real controller in Chromium played, sought
      and decoded these parts with no error.
    - FFmpeg gave the sample in front of a video gap of 2.4 s a duration of 2.4 s, and the
      buffered data stayed one range. A test with libx264 files found the same for gaps of 1.7 s
      and 9 s. For gaps of 11 s and 14 s, the last sample kept the duration of one frame. These
      gaps are longer than the default 10 s of `max_interleave_delta`. Reading FFmpeg's mp4 muxer
      says that it takes the duration from the next packet of the track in its interleave
      queue.

## Decision

### Which sources take the path

A source takes the MediaSource path when all of these are true:

- `findUnplayableContainer` (ADR 003) names its container for this platform.
- The container is FLV, MPEG-TS or MKV. AVI and ASF (WMV) keep the decode failure panel. A copy
  window from AVI loses the PTS (measurement 14). The usual WMV codecs are not H.264 or HEVC.
- `MediaSource` exists, and `MediaSource.isTypeSupported` accepts a codec string for the video
  codec. H.264 is the main case. HEVC takes the path where the web view accepts `hev1`, the
  sample entry that FFmpeg writes into MP4.
- The probe gives a duration.

Any other source keeps the native element of ADR 003 or the decode failure panel. A source
whose audio codec the web view rejects takes the path with its audio transcoded (see "The
window").

### The window

A window is one FFmpeg process that remuxes a part of the source into fMP4 and writes it to its
stdout. Rust sends the bytes to the page through a `tauri::ipc::Channel`. The page appends them
to one SourceBuffer that holds the video and the audio.

**FLV.** Rust reads the bytes of the window from the file and writes them to the stdin of
FFmpeg, after a head (see "The head and the locator"):

```
ffmpeg -hide_banner -loglevel error -f flv -copyts -i pipe:0
  -map 0:v:0 [-map 0:a:0] -c copy [-c:a aac]
  -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+frag_discont
  -frag_duration 500000 -use_editlist 0 -avoid_negative_ts disabled pipe:1
```

Rust parses the tags while it writes them. It records each keyframe and each config tag in the
keyframe table, it counts the bytes that it reads, and it ends the slice itself. The window
starts at a keyframe tag. It ends at the first of these:

- the first keyframe tag at or after the start plus 60 s
- the first keyframe tag after 64 MiB of source
- the first keyframe tag after a changed config tag (see below)
- the end of the file

The next window starts at that keyframe tag. Two windows therefore never overlap, and no `-to` is
necessary. The writer also ends the slice in front of a frame whose timestamp lies more than 10 s
below an earlier one. The mp4 muxer refuses a decreasing timestamp and loses the fragment that it
holds, so a slice that ran across a restart would lose the seconds before it.

(Added with the verification.) The mp4 muxer also keeps the configuration of the head for the
whole output. A window across a reconnect with another picture size therefore gave a decode error
in both web views (measurement 24). At a config tag that differs from the configuration of the
same kind in the head, after a frame of that kind, the writer stops writing and closes both
stdins, so the processes finish the output. It reads on to the next keyframe tag, records the
config tags on the way, and checks the timestamps. The next window starts at that keyframe. The
reader of the window waits for the writer while it reads on. At the end of the file the window
reached the end, and the tags after the config tag never play. A read on that finds no keyframe
within 64 MiB stops there, as at damage. A copy of the configuration of the head passes.

The head of a window also takes each config tag that follows its keyframe before the first frame
of its kind, within 64 tags, because FFmpeg's flv muxer writes the new configuration of a stream
in front of its next packet.

(Added with the NAL check.) Chromium's MP4 parser splits each H.264 and HEVC sample into NAL
units. It fails the append of the whole segment when the chain of units does not end exactly at
the end of the sample. It also fails the append when a unit has the length 0. This is the rule of
Chromium's `AVC::ConvertFrameToAnnexB`, and measurement 29 shows the first case. A recording that
stopped while it wrote a frame can end with such a frame. So the writer applies this rule, the NAL
check, to each video frame. It takes the NAL length size from the video configuration in the head:

- From the first frame that fails the NAL check, the writer leaves out the video frames up to the
  next keyframe that passes it. It writes that keyframe. The writer still writes the audio, the
  config tags and the other tags, so the sound stays continuous. For a stretch of up to about
  10 s, FFmpeg gives the last video sample in front of the stretch the duration up to that
  keyframe (measurement 29).
- Only the time limit and the byte limit of the list above wait for a keyframe that passes the
  NAL check and that ends no such stretch. If a window ends at a keyframe that the writer leaves
  out, the next window starts with no video. If a window ends at the keyframe after the stretch,
  FFmpeg gets no later frame for the last sample in front of the stretch. That sample then keeps
  the duration of one frame. The read on after a changed config tag still ends at the next
  keyframe tag, also when that keyframe fails the NAL check.
- The 64 MiB of the list count only the tags that the writer writes. Because of that, and because
  the limits wait for such a keyframe, a window with a stretch can be longer than 60 s and 64 MiB.
- The writer measures a stretch from the first frame that fails the NAL check. When the stretch
  is longer than 64 MiB, it ends the read at the current tag. The read on after a changed config
  tag does the same. The window names that place, and the next request walks from it to the next
  keyframe.
- The writer checks no frame when it has no NAL length size. That is the case for another codec,
  for a record that is too short, for a size of 3, and for a head with no video configuration.
  The read on after a changed config tag writes nothing, and the next window checks with its own
  head.
- The NAL check runs on every platform, because each sample that fails it breaks the sample
  format of ISO/IEC 14496-15. The test of WebKit with such a sample is open (see "Open checks").

**MPEG-TS and MKV.** FFmpeg reads the file and seeks itself:

```
ffmpeg -hide_banner -loglevel error -copyts -ss <S> -t <L> -i <path>
  -map 0:v:0 [-map 0:a:0] [-bsf:a aac_adtstoasc] -c copy [-c:a aac]
  -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+frag_discont+delay_moov
  -frag_duration 500000 -use_editlist 0 -avoid_negative_ts disabled pipe:1
```

This is the seek form. The FLV form above has no `-ss`. `S` is the target minus the container
start time (ADR 014 measurement 8) minus a margin, clamped at 0. The first margin is
`SEEK_MARGIN_SECONDS` of ADR 014, so the preview and the export agree. `L` is the window length,
60 s, plus the margin. `-t` must stay an input option, before `-i` (measurement 6). MPEG-TS adds
the bitstream filter (measurement 6). The seek form adds `delay_moov` for both containers,
because MPEG-TS needs it (measurement 12).
A seek can land after the target (measurement 13). When a window holds no frame at or before the
target, the page asks again with twice the margin, up to 60 s. A window that continues the
buffered data keeps that data, and only the window starts again. A window whose input seek reads
from the start of the file cannot start earlier, so the gap rule of the section "Calibration"
applies instead. A window that holds no frame, as after an input seek past the last keyframe,
also asks again with twice the margin. At 60 s it fails: an end of the stream with no data would
set the duration to 0. An MPEG-TS or MKV window that ends more than 1 s before its requested end
reached the end of the file when its video ends within 5 s of the duration of the probe. An early
end in the middle of the file goes on after it.

**Audio.** `-map 0:a:0` is present when the source has an audio stream. When the web view
rejects the audio codec, the window transcodes the audio to AAC with `-c:a aac` and no delay
filter (measurement 15). When the transcode fails, the window has no audio, and the preview
shows a notice that it plays without sound. The page also checks the codec strings of the first
init segment. When the web view refuses only the audio there, the window starts again with the
audio transcoded, and then without audio. The track count of a SourceBuffer cannot change, so
this choice happens before the first append.

`-frag_duration 500000` writes a fragment for each 0.5 s of media. A long GOP therefore does not
delay the first picture (measurement 10).

### The head and the locator

The head of an FLV window is the FLV header, `PreviousTagSize0`, and the config tags: the AVC or
HEVC decoder configuration and the AAC AudioSpecificConfig. Rust copies each tag byte for byte.
The head holds no script tag. The `keyframes` file positions of `onMetaData` are wrong inside a
window, and an ffprobe `-read_intervals` would seek by them. The head of a window uses the latest
config tags that the keyframe table knows at or before the start of the window. A recorder writes
a new decoder configuration after a reconnect.

Rust finds the keyframe at or before a target in this order:

1. The `keyframes` index of `onMetaData`, when the file has one.
2. The keyframe table, when two keyframes of one known run bracket the target.
3. A bisection on byte offsets. At each probe Rust finds the next tag boundary. It checks the tag
   type, the data size, the stream id and `PreviousTagSize` over three tags, and reads the
   timestamp. A last walk, with a tolerance of 1 s for interleaved audio, finds the keyframe.
   Rust records the config tags in each block that a probe reads.
4. A sequential scan of the tag headers from the start. Rust uses it when the timestamps decrease:
   a timestamp more than 10 s below a timestamp at a lower offset, or a last tag before the first.
   Rust reports this to the page (see "Failures").

When the walk of the head does not reach the first keyframe, as in a recording that starts in
the middle of a long GOP, the locator walks the tags once to find it.

On the files of the test of 2026-10-17, a locate with an empty table read 2.8 to 3.5 MB on the
4 Mbit/s file with a GOP of 2 s. It read 6.5 to 21.9 MB on the 14 Mbit/s file with a GOP of
10 s. Most of it is the walk back to the keyframe. The window that follows reads the same GOP
again, so a seek with an empty table reads at most about two GOPs. A locate that the keyframe
table answers reads nothing. The extent of the file (see "The probe") reads 0.2 to 0.6 MB at
its end.

The keyframe table grows with each window and each locate. Rust saves it beside `head.flv` in
`<app_data>/flv-cache/<key>/`, where the key comes from the path, the size and the modification
time of the source. The sidecar records that revision, and Rust ignores a sidecar of another
revision. The cache keeps 16 sources and never removes one that a window or an export uses. The
preview writes nothing else.

### The window policy

- The page keeps about 20 s behind the play position and requests the next window when less than
  30 s is buffered ahead of it.
- One video window runs for each source at a time. A new request kills the running window. Each
  request takes a generation number, and Rust starts FFmpeg only while that number is still the
  latest, so a slow locate never kills a newer window. The page also numbers the requests of
  each lane, and Rust refuses a request with a lower number than one it already took, because
  each request runs on its own thread and a slow check of the file can delay it.
- A new page in the main window, as after a reload, stops every window. Tauri still delivers to
  a channel of the page before, so Rust cannot see that page go. The page numbers its requests
  in microseconds of the clock, and the reload sets the lowest number that each lane takes to
  its own time. A late request of the old page then starts nothing, and every request of the new
  page lies above the floor. After the exit, no request starts a window.
- The lane of a window is free when its remux output ends. The next request then starts at once
  and does not cut off the PCM of the window before it, which a close or the exit still stops.
- The page acknowledges the bytes that it appended. Rust stops reading the stdout of FFmpeg while
  more than 8 MiB are not acknowledged. FFmpeg then stops, the stdin writer stops, and the reads
  from the share stop. The stdout and stdin pipes, one fragment that the muxer holds and the
  1 MiB read buffer of the writer come on top, so about 10 MiB lie beyond the acknowledged
  bytes. A window that the next request kills has read at most that much more.
- An end message with the status `complete`, no resume point and no end of file comes from a
  writer that did not report in time, as when a read of the share stalls. The page then resumes
  by time from the last fragment that it appended.
- The page removes data behind the position only up to a keyframe, because the MSE
  specification extends a remove to the next random access point: a remove to any other time
  would drop the GOP that holds the position.
- When the SourceBuffer is full, the page removes the data up to the last keyframe at least 2 s
  behind the position. When no keyframe lies there, it waits until the position moves, and the
  credit holds FFmpeg. A seek counts the room from its target. When the target waits for that
  room, the page drops the data and starts a window at the target. Without known keyframes, it
  removes the data more than 30 s behind the position.
- The page decides from the video that the fragments of the windows hold, not from `buffered`.
  The buffered ranges of a SourceBuffer with audio and video are the intersection of the two
  tracks. A browser removes data on its own when the SourceBuffer is full, so the page clips
  that video to the buffered ranges after each change. A browser removes video only up to a
  keyframe. So a span that starts before a range loses its start up to the latest keyframe at
  or before the range start, and keeps its start when no keyframe lies there, as for audio
  that starts late. Fragments with no sync flags give no keyframes. A span then keeps at most
  1 s before the range. The end of a span can lie up to 1 s after the range, where the audio
  ended.
- A later init segment with other codec strings, as after a reconnect, takes `changeType` first.
- A window that goes on by time must start at least 1 s later than the one before it. Otherwise
  the windows end at the same place each time. The video before that place plays, and the
  preview stops when the position reaches it, as for a failed window (see "Failures"). The
  element stops at the end of the buffered range, which can come first: the audio can end
  earlier, and with B-frames the page estimates the end of the video a few frames late. So the
  preview stops at the earlier of the two.
- An application exit kills every window process (ADR 017 amendment). A window writes no file,
  so the exit does not wait for it.

### The media timeline and the calibration

The page sets `timestampOffset` to −(`videoStartPts` × `videoTimeBase`). The `tfdt` of every
window is absolute (measurements 4, 8 and 12). A frame of PTS `p` therefore has the media time
(`p` − `videoStartPts`) × `videoTimeBase`, and media time 0 is `videoStartPts`. This is the
formula of ADR 003 with the anchor at media time 0, so the calibration is known before the first
frame. The store takes this anchor when the metadata loads, and it does not wait for the first
frame callback. Measurement 18 shows that the frame callbacks report these media times exactly.

The first frame that the element shows is not always the frame of `videoStartPts`. `-c copy`
drops the frames before the first keyframe, and MSE drops frames before a keyframe. On a file
that starts in the middle of a GOP, the first frame therefore comes later. The known anchor is still
correct for it. The first-frame anchor of ADR 003 would bind `videoStartPts` to the wrong frame.

A self-check runs on each element. The page reads the first frame of the first window from its
first `moof`: the `tfdt` plus the composition offset of the first sample. On FLV, Rust also
reports the PTS of the first keyframe tag of the window, and the two must be equal. The first
frame callback must report the media time of that frame within half a frame interval, or within
20 ms when the source has no nominal frame rate. Otherwise the calibration becomes unavailable
for the attachment, and the store logs both values. A reload attaches a new element, which the
check covers again.

A play or a seek before the first frame callback can make that callback name another frame,
so the check does not run. A playing element reports only the latest frame since the last
callback. This holds for a play that the store did not start, such as from a media key. An exact
seek into the expected frame is the exception, and the check still runs. The seek over a start
gap is such a seek. The store counts a seek as one into the expected frame when its target lies
in a set range. The range starts a quarter of a frame interval before the frame and ends three
quarters into it. A seek to the start of the next frame therefore never counts, also on a source
whose frames start before their nominal start.

When no frame lies at the element's position after the first window, the page asks the store to
seek to the first buffered frame. The store stays the only writer of `currentTime`. A file that
starts in the middle of a GOP is such a case: media time 0 is then a frame that never shows, and
the first window starts at the first keyframe. The same holds after a seek whose target lies
before the first keyframe of the file, because no window can start earlier. The element still
waits for that seek, which never completes, so the store replaces it with the seek over the gap,
whose target is buffered (see "Seeks").

### Seeks

A seek outside the buffered data stays `seeking` until the window delivers it. The page sets
`mediaSource.duration` before the first append, so the seek is not clamped to the buffered end
(measurement 20). The page then cancels the running window, removes all buffered data, and
requests a window at the keyframe at or before the target. It calls `abort()` only while the
source is `open` (measurement 20). The page calls `endOfStream` after it appends the last window
of the file. A later `remove` sets the source to `open` again (measurement 20), and the MSE
specification says the same of an append. The page therefore calls `endOfStream` again after
each such change while the last window stays buffered.

For a MediaSource source, a seek request that is not a scrub sample can replace the running seek
at once (ADR 022 amendment). It does so when the target of the running seek is not buffered and
the window of that seek does not deliver the new target. Otherwise the next click waits for the
window of the previous one. The store counts a target from 1 s before the running target to 10 s
after it as delivered. The window starts at the keyframe at or before the running target. The
page waits for a running window when the target lies at most 10 s after the video that the window
read. The exact seek at the release of a drag and a forward frame step stay in that
part, so they wait in the queue and do not start the window again. A backward frame step stays
in it for its first second only. A request whose target is buffered also replaces the running
seek, because it completes at once. The seek over a gap (see "Calibration" and below) always
replaces it: the buffered ranges are the intersection of the audio and the video, so a first
frame before the first audio sample is not buffered. When a request waits in
the queue behind that seek, as a click during the wait does, that request replaces the stuck
seek as an exact seek instead, and the seek over the gap goes. A scrub sample always
waits in the queue of ADR 022, so a drag still shows a picture each time a window arrives.

(Added with the verification.) When the running window that a seek waits for ends before it
delivers the target, as at its byte limit, the next window starts at once if it starts at or
before the target and at most 10 s before it. Otherwise the page drops the buffered data and
requests a window at the target, once for each seek. A seek into the buffered data also starts
the next window when that data ends within 30 s of the target: a paused element that waits there
sends no `timeupdate`, and the decoder keeps back the last frames for the reorder of B-frames until
more data or the end of the stream comes (measurement 25).

(Added with the verification.) In WKWebView, a seek that began with no video at its target can
end on the wrong frame, or never end, when its data arrives (measurement 26). So on macOS the page
repairs such a seek once, when the appended video holds the target. It waits until WebKit ends
the seek and 100 ms more, or 1 s when WebKit does not end it. Then:

- When a seek waits in the queue, it starts. It is a new seek for WebKit too.
- When the element still stands at the target, the store seeks 3 ms from the target and reads
  that position as the target. On an exact frame grid the seek goes toward the middle of the
  nominal frame that holds the target, counted one tick later, because a PTS can lie up to a
  tick before the nominal start of its frame. So it stays in that frame, unless the frame lasts
  6 ms and four ticks or less, where no such seek runs. Off the grid, or before the calibration,
  the seek goes 3 ms after the target, and it leaves the frame when the target lies in the last
  3 ms of a frame. At the end of the file it goes 3 ms before the target.
- When WebKit moved the element itself, the last seek of the store still names the target, no
  playback runs, and the element does not seek any more, the store also seeks 3 ms from the
  target by the rule above, and reads that position as the target. A seek back to exactly the
  target did not make WebKit seek again, and in 2 of 11 repairs the wrong frame stayed
  (measurement 26). Where a frame is too short for the 3 ms, the store seeks to the target itself.
  That case keeps the risk, and the test did not measure it. On the 1 ms ticks of FLV it applies
  from 100 frames per second.
- A scrub sample gets one fastSeek 3 ms away.

A newer seek or a playback cancels the repair. A seek that keeps a playback running gets none,
and that case was not measured. The repair also runs for the late seeks that landed right, so a
late seek costs one more seek on macOS, a decode from the keyframe. A seek that takes more than
1 s to decode is repaired during its decode and decodes again. WebView2 does not need the
repair, and Windows does not do it.

(Added with the gap rule.) The windows can skip a stretch in the middle of the file. After a
reconnect whose new part starts in the middle of a GOP, and after damage, a window ends before the
stretch, and the next window starts at the keyframe after it. The buffered data then has a hole.
Both engines stop at the end of the range before the hole, and a seek into the hole never
completes (measurement 28).

A hole that the running window has passed is permanent, because the windows append in time order.
A window that starts by time, as an MPEG-TS or Matroska window does, rewrites the end of the data.
The browser then drops the old frames up to the next old keyframe, because they depend on the
frames that the window replaces. That hole lies after the first frame of the window, and it goes
when the window appends past it, so it does not count until then. The page asks the store to seek
over a permanent hole of at most 15 s:

- When the playback waits at the end of the range, the store seeks to the start of the next range
  and plays on. The playback waits when the element plays, has no data after its frame, and
  stands at most 0.5 s before the end. The page tests this at `waiting`, at `timeupdate`, and
  after each append.
- A seek into the hole goes on in its direction. It goes to the start of the next range. A seek of
  a paused element that came from that range or later goes back to the end of the range before
  the hole. So a frame step back from the first frame after the hole crosses it. A seek during
  the playback, as the seek to the In of a segment playback, goes on after the hole, so it plays
  no frame before its target.
- In Chromium, a seek with less than about 0.2 s of data after it, before a hole, shows its frame
  but never completes (measurement 28). So a seek into the last 0.25 s of the range counts as a
  seek into the hole, and the seek back goes to 0.25 s before the end. WebKit completes such a
  seek, so on macOS neither applies.
- When the window of a seek ends before the target, the next window starts when the target lies
  at most 15 s after the video of that window. The hole then shows. Such a seek never starts a
  window at its target again.

The page asks once until the next seek. The seek over a gap, before the first frame or over a
hole, keeps a running playback and the stop point of a segment playback (ADR 026), because it
continues the playback that the user started. The frames of the hole are out of reach of a seek.
In Chromium, so are the frames of the last 0.25 s before it.

### The scrub cue

The scrub cue of a MediaSource source does not use an element. WKWebView starts the media clock
of a MediaSource element 210 to 250 ms after `play()`, so a burst ended about 425 ms after its
request (measurement 21). The user did not accept that delay. The page does not mount the hidden
`<audio>` of ADR 019 for a MediaSource source.

An audio process decodes the audio of each window to PCM:

```
ffmpeg ... -map 0:a:0 -af aresample=48000,aresample=async=1:first_pts=<start> -f s16le -ac 1 pipe:1
```

`first_pts` makes sample 0 the start of the window, with silence or a cut against the
timestamps. It counts samples of the input rate of its filter, so the first `aresample` converts
to 48 kHz (measurement 22). On FLV the stdin writer of the video window writes the same bytes to
this process, so the source is read once (measurements 11 and 22). The process starts only when
the source has an audio stream. On MPEG-TS and MKV it runs its own `-ss` windows, and the cue
requests one when its target lies outside the PCM that it holds. The output is about 96 KB/s.

The page keeps the PCM of the last windows. It plays each burst with an `AudioBufferSourceNode`
that starts at the sample of the target, through a gain node that the Mute toggle sets. These
rules of ADR 019 keep their behaviour:

- the burst length of 50 ms
- the continuation of a forward request
- the silent backward repeat
- the lag limits of a step and of a drag

ADR 019 reads the media clock of its element for the stop and the lag. The Web Audio cue reads
its own position instead: the start sample of the burst plus the time since its start on the
`AudioContext` clock. The stop is the end time of the scheduled buffer, so the cue needs no
clock check. A request whose PCM has not arrived waits for it for the watchdog time of ADR 019:
one burst plus 1 s. Then the cue drops it. A failed audio process never stops the video
window. It disables the cue for that source.

### Failures

- The web view rejects the codec string of the first init segment: the decode failure panel
  with the codec reason of ADR 003. The panel shows the refused type behind a disclosure. A
  later rejection, after the source showed a frame, is the stall of ADR 039. An error of the
  element with `MEDIA_ERR_SRC_NOT_SUPPORTED` before the first frame also takes the codec reason:
  it comes from the MediaSource, not from a container that the web view cannot open.
- The element reports a decode error after the source decoded in part: the stall of ADR 039.
  The next seek loads a new element and a new controller, and the store seeks to the place of
  the stall. On FLV, the first window that serves that seek asks Rust to scan the tag headers
  from the last known config tag to the window start first. The head of that window then holds
  the config tags that the scan found, which a reconnect can have changed. Only the element of
  the reload that the stall asked for scans. A later reload does not scan again.
- A window fails after the source decoded in part: the stall of ADR 039 too. Its notice says that
  the preview could not read that part of the file.
- A window fails before the source decoded: the panel that says that the file could not be read,
  with the diagnostic text of the failure behind a disclosure (ADR 011).
- A read of the source fails, as on a share that stopped answering: the window ends as failed
  with that reason, and the page can ask again. A damaged tag ends the window too, and the end
  message names the first keyframe after the damage, so the page can play on from there. A
  restart of the timestamps does the same.
- (Added with the NAL check.) A video frame that fails the NAL check no longer fails the append.
  The writer leaves out the video frames from that frame up to the next keyframe that passes the
  NAL check (see "The window").
- FFmpeg is not found: the panel says that this preview needs FFmpeg.
- The timestamps decrease: a notice says so once, and the store disables precise editing for
  the source. A notice that the user dismisses stays hidden until the user opens another
  video, also after a reload of the element. MSE writes later data over earlier data of the same
  time, so marks there are not reliable.

### The probe

`approximateDurationSeconds` counts from the first video frame, as the step bounds of the store
and the ruler already assume:

- The stream duration, when ffprobe gives it.
- For FLV that the reader can read: the PTS of the last video tag, plus one frame interval,
  minus the video start PTS (measurement 5). The interval comes from the average rate after the
  rule below.
- For Matroska, and for FLV that the reader cannot read: `format.duration` minus the video
  start. FFmpeg's muxers write the end timestamp as the duration of a file with a start offset
  (measurements 5 and 16). When that gives less than 0, the duration was a length, as another
  muxer or the `onMetaData` of an FLV gives it, and the next rule applies. QuipClip assumes that
  a length with a small start offset is rare: such a file reads short by its start.
- Otherwise: `format.duration` minus (video start − container start).

This also changes the fallback of the native containers by the audio lead, so that it agrees
with `videoDurationTicks` (ADR 002 amendment). The MediaSource duration is
`approximateDurationSeconds`. It is a browser value, and it never enters the project state.

For FLV, when `r_frame_rate` is valid and `avg_frame_rate` lies within 2 % of it, the probe
reports `r_frame_rate` as the average rate. The rule reads only what ffprobe reports, so the
probe of an import and the probe of an export agree. The measured averages 989/33 and 1000/33
lie 0.1 % and 1.01 % from 30/1 (measurement 5). On an FLV of 30000/1001 frames per second,
ffprobe reported `r_frame_rate` 30000/1001 and `avg_frame_rate` 989/33, and the rule gives
30000/1001. The nominal step of ADR 003, the frame grid of ADR 028 and the `source` rate of the
export (ADR 014) then use the real rate. A rate that differs by more than 2 % stays as the probe
gives it.

### The export

An FLV input of the export uses the `concat` and `subfile` protocols (measurement 2) instead of
`-ss`. This applies to both processes of an export with video and audio (ADR 043). It starts at
the keyframe at or before In − `SEEK_MARGIN_SECONDS`, and `-copyts` and the trim on raw PTS of
ADR 014 stay. For a late segment, this input read 30.9 MB where `-ss` read 212.7 MB, and the
frames were the same (measurement 23).

Before the plan, Rust locates the keyframe of each segment and writes `head.flv` to the cache.
The export uses the same open source as the preview, so it knows what the windows found, and
the cache keeps the directory of the source while the source is open. All the inputs of an
export share one head: the head of the earliest slice. FFmpeg runs in the directory of the head,
and the command names the head by its file name, so the path of the application data does not
make each input longer. The single input of ADR 014 opens the earliest slice.

Then ffprobe decodes the start of each slice in one run: the first 64 packets of both streams, or
the first 8 video packets when the check leaves out the audio. All these runs share one
`PROBE_TIMEOUT` of 30 s. The check looks for a config change that no read has seen,
because a slice after such a change decodes with the configuration of the head:

- The first video frame must decode with no error at the picture size of the probe.
- When the export writes audio and the audio stream has packets, the audio frames must decode
  with no error, with the channels of the probe. A raw AAC frame does not carry its sample
  rate, so the audio of a slice after a change of the rate decodes with no error at the rate of
  the head. The timestamps of the tags keep the real timing, so the check compares each step
  between two frames with the samples of the first frame at the rate of the probe. It skips a
  step longer than 1.5 times that time, which is a gap that the export fills, and it needs 4
  other steps. The sum of these steps must be within 2 % of the time of their samples, and at
  least within 3 ms. A change from 44100 Hz to 48000 Hz moves the timestamps by 8 %.

The slice from the first frame of the file needs no check, because the head holds the
configurations of the start of the file. The check is a heuristic. A frame can decode at the
right size with no error and still use a wrong parameter of the head. A harmless error line
refuses the slices. Audio that starts after the 64 packets, audio timestamps that do not
advance, and more jitter than the tolerance also refuse them. The export then uses `-ss`, which
reads more and is correct. A cancel during the locate or the check ends the export as canceled.

The input keeps `-ss` in these cases:

- A path holds `|`, which `concat` cannot escape. This includes the path of the head.
- The reader cannot read the file, or the head cannot be written.
- The stream order of the window differs from the stream indices of the probe.
- The timestamps decrease.
- The keyframe table knows a config change in the file. One head cannot hold two
  configurations.
- The start of a slice does not decode as the check requires, or the check does not end in
  time.

The reason goes to the log, and the export runs with `-ss`.

An FLV input is longer than a seeked input: 42 bytes longer with numbers of 12 digits, and
58 bytes longer with numbers of 20 digits. So the command line of ADR 014 reaches its budget with
fewer segments. The budget tests use a Windows path of 106 characters. On that path, with a
source smaller than 1 TB, the encoder keeps one input for each segment up to 81 segments, and the
audio process of ADR 043 up to 69. With `-ss` the counts are 92 and 77. For the widest plan that
the settings permit, with the largest numbers that a file can have, the counts are 52 and 45,
against 59 and 50. Above these counts a process opens one input, which fits at the cap of 100
segments.

The read of the audio gaps (ADR 014 measurement 28) opens the same slices. It joins the ranges
that overlap or touch. For each group, it reads the slice of the earliest range from its start
to the end of the group, with `-read_intervals %<end>`. It names the head by its full path. All
the runs share one `PROBE_TIMEOUT`.

## Rejected alternatives

- **A proxy file.** It reads the whole source and writes a second large file before the first
  frame. On a share that takes minutes.
- **A transmuxer in JavaScript, such as flv.js or mpegts.js, as the player.** A seek needs the
  keyframe index of `onMetaData`, which live recordings do not have. Their timestamp fixes
  rewrite the timestamps, so the media time no longer maps to the source PTS (ADR 003).
- **`concat` and `subfile` for the preview.** Through stdin, Rust learns the keyframes and the
  config tags while it streams, and it counts the bytes. A `|` in a path and a drive letter on
  Windows cause no problem. The export keeps `concat`, because it opens several inputs and its
  stdin carries the audio pipe of ADR 043.
- **A `timestampOffset` of 0.** The media time would equal the source time. A file that starts
  at 1234.567 s then has no data at `currentTime` 0, so the element would wait there. The anchor
  guard of ADR 003 also refuses a first frame more than 1 s away from the position that it read.
- **The first-frame anchor against `videoStartPts`.** It binds the wrong frame when the first
  frame is not the frame of `videoStartPts`.
- **An `<audio>` element on a MediaSource for the cue.** It is late by about 0.3 to 0.4 s in
  WKWebView (measurement 21).
- **A second read of the source for the cue.** FLV interleaves audio and video. An audio window
  would therefore read all the video bytes again: about 35 MB for 20 s at 14 Mbit/s.
- **`negative_cts_offsets`.** It moves the PTS (measurement 6).
- **A delay filter on the AAC transcode.** It makes the audio late (measurement 15).

## Consequences

- An FLV on a share opens without a full read. The preview reads each window once and writes
  only `head.flv` and the keyframe sidecar.
- The backend has a new module, `src-tauri/src/flv/`, that reads FLV tags. A window runs one or
  two FFmpeg processes.
- Precise editing works on these sources, and the calibration does not depend on the first frame.
- MP3 audio plays through a transcode. Its first 21 ms of priming lie before the first real
  sample.
- The cue of a MediaSource source needs an `AudioContext`. Its start delay needs a measurement in
  the unit that writes it.
- A drag over a part that is not buffered starts a window for each sample that the queue
  releases. On a share the picture changes more slowly during a drag.
- Known limitations:
  - A reconnect that changes only the configuration of the audio in the middle of a GOP loses
    the rest of that GOP. A reconnect whose new part starts in the middle of a GOP, and damage,
    leave a hole that the preview seeks over (see "Seeks"). The frames of the hole do not show
    in the preview, and on Windows neither do the frames of the last 0.25 s before it. The
    export still reads them. A hole of more than 15 s stops the playback until the user moves
    the playhead.
  - A config change that no scan has seen yet gives a decode error and the stall of ADR 039.
    The reload after it scans first. The export checks each slice, and it keeps `-ss` when a
    slice does not decode.
  - An open GOP, where leading B-frames refer to the previous GOP, gives frames below the
    keyframe PTS in a window. MSE drops them or shows errors, and the self-check then disables
    the calibration. QuipClip assumes that live encoders write closed GOPs.
  - An FLV whose timestamps decrease plays, but precise editing is disabled for it.
  - The reader accepts a `PreviousTagSize` of 11 + data size only. FFmpeg also accepts other
    values from some old muxers. Such a file fails the reader and keeps the decode failure
    panel.
  - The 32-bit timestamps of FLV wrap after 49.7 days. The reader reports a wrap as decreasing
    timestamps.
  - (Added with the NAL check.) The video frames that the writer leaves out from a frame that
    fails the NAL check do not show. The frame in front of them stays on screen. The export does
    not use the NAL check.
  - (Added with the NAL check.) Some stretches become a hole in the video:
    - a stretch of more than about 10 s, the default `max_interleave_delta` of FFmpeg
    - a stretch that the read on after a changed config tag or the 64 MiB reach ends, because
      the window has no later frame
    - a stretch at the start of a window that continues the data, which can follow the read on
      after a changed config tag or the 64 MiB reach

    The gap rule of "Seeks" handles a hole of up to 15 s. A longer hole stops the playback with
    no notice until the user moves the playhead. At the end of the file, the video ends at the
    frame in front of the stretch.
  - (Added with the NAL check.) When the start keyframe of a window that serves a seek fails the
    NAL check, the video of the window starts at the next keyframe that passes it. The store
    seeks over that gap, as before the first frame, up to 15 s. Over 15 s the seek waits with no
    notice. When the first window of an element starts at such a keyframe, the self-check of the
    first frame disables the calibration for that attachment.
  - (Added with the NAL check.) A window that leaves out all of its video, as at a last keyframe
    that fails the NAL check, ends with no video fragment and fails (`noFrames`). After a part of
    the source decoded, this is the stall of ADR 039. Before that, the panel says that the file
    could not be read. No test measured this case.
- Open checks:
  - The export with `concat` and `subfile` on Windows, with a drive letter, a UNC path and a
    `\\?\` path. Reading FFmpeg's `url_find_protocol` says that these work. Nothing on macOS
    runs them.
  - The preview through stdin on Windows. The anonymous pipes of Windows have small buffers,
    so the time to the first fragment needs a measurement there. A slow feed would take a larger
    buffer through a named pipe or a temporary slice file, not another design.
  - WebView2. Chrome is the only Chromium engine that the test measured.
  - HEVC. Both web views accept `hvc1`, but the test played only H.264.
  - The application itself. Measurements 24 to 27 ran the real preview in a test page, with a
    test server in place of Tauri. The export of a segment and a share over SMB did not run.
  - In WKWebView: a late seek during a playback, which gets no repair, and the repair at rates
    other than 30 frames per second.
  - (Added with the NAL check.) WebKit with a sample that fails the NAL check, the NAL check on
    HEVC, and the application itself on Windows with the recording of measurement 29.
