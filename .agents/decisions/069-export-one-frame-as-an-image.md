# 069. Export the frame that Mark In would mark as an image

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 017, ADR 026

## Context

The user asked for a way to save the frame that the preview shows as an image, for example as
the cover of a clip.

QuipClip writes video and audio files only. The containers of a preset are MP4, MOV and
Matroska (ADR 013), and the check of an export counts the frames of a video (ADR 014).

The preview does not know the source PTS of the frame on screen. While the calibration is
ready, the playback store holds a PTS that it inferred for the frame that the web view
presented (ADR 003). Mark In writes that PTS, and an export starts a segment with the first
frame whose PTS is not before it (ADR 014). ADR 003 names the cases in which that frame is not
the frame on screen.

## Decision

### What the image is

The Export Frame action saves one frame of the source as a PNG file. The frame is the first
frame of the segment that a Mark In at that moment would start: the first frame, of the video
stream that an export reads, whose PTS is not before the inferred PTS. The action promises
that frame, and it promises nothing more exact than a mark does.

### The action

Export Frame is a row of the key table (ADR 026) with the key `Cmd+Shift+S` on macOS and
`Ctrl+Shift+S` on Windows. The transport bar gets a button for it, and the File menu of macOS
gets the item "Export Frame…". The key, the button and the menu item run the same plan.

The plan accepts the action only while all of these conditions are true:

- The playback store holds a confirmed frame of the attached element, and the calibration is
  ready. This is the condition of Mark In with no current segment (ADR 003, ADR 007).
- The attached element is not stalled (ADR 039) and not retired (ADR 063).
- No drag trims the edge of a segment, and no press on an edge is armed (ADR 030).
- No other Export Frame action is in progress.

When the plan accepts the action, it records these facts at once, and the action is in
progress from that moment:

- the source of the attached clip: its path and its revision
- the inferred PTS of the confirmed frame, in the time base of that source. On a sequence this
  is the PTS of the playback store, not the sequence time of the interface (ADR 052).
- the time that the preview shows, for the name of the file
- the paths of all the sources of the session

A change of the playhead, of the clip or of the playback after that moment does not change
them. The action stays in progress until the user cancels the save dialog, or the command ends.
While it is in progress, its key, its button and its menu item do nothing, and the button
shows that it is busy.

### The save dialog

The action opens the save dialog of the system, with the filter PNG. The name that it offers
is the name of the source file without its extension, an underscore, and the recorded time.
In that time each `:` and each `.` is a `-`. The extension is `png`. If the user cancels the
dialog, the action ends.

### The command

A new command of the main window writes the file. Its request has the recorded facts and the
path of the output.

The command refuses the request when one of these is true:

- The path of the output does not end in `.png`. The letters can have either case.
- The path fails the destination check of an export (ADR 016): it is not absolute, its folder
  does not exist, or it is a folder.
- The path is one of the sources of the request, by its path or by the identity of its file.
- The revision of the source differs from the recorded one (ADR 024, ADR 058).

The command and the export queue do not compare their destinations. The path of an image ends
in `.png`, and the save dialog of an export offers the extension of its container (ADR 036).

The command probes the source and reads the video stream that an export reads. Its input is:

- For an FLV, the input of ADR 046, bound to the recorded revision, in a work directory of its
  own (ADR 055). When that input is not available, the command fails. It does not read the
  whole file.
- For each other source, the file with `-copyts`. The input seek is the PTS in seconds, less the
  start time of the container, less 5 seconds. The command has no input seek when that value is
  not above zero (ADR 014).

One FFmpeg process decodes and writes one frame:

```text
-filter_complex [0:<video stream>]trim=start_pts=<PTS>,setpts=PTS-STARTPTS,
                scale=<width>:<height>,setsar=1,format=rgb24[v]
-map [v] -frames:v 1 -c:v png -f image2 -update 1 <temporary file>
```

- The width and the height are the display size of the source: its picture size with the
  sample aspect ratio and the rotation applied, as the plan of an export computes it before it
  fits a picture into a canvas (ADR 053). FFmpeg rotates the picture by its default rule, as in
  an export.
- The picture has 8 bits for each of red, green and blue, and no alpha.

The process writes a temporary file beside the destination. The command then reads that file
itself. The command fails when FFmpeg fails, when FFmpeg has not ended 60 seconds after it
started, or when the file is not one complete PNG picture of the planned width and height. The
command reads the clock when the guard of the process returns, so an FFmpeg that ends in the
last moments before the limit can count as late. A
complete picture has the PNG signature, an `IHDR` chunk with that size, 8 bits, the colour type
RGB, and a compression, a filter and an interlace method that PNG defines, one run of one or
more `IDAT` chunks, a correct CRC in each chunk, and an `IEND` chunk at the end of the file. The
command does not decompress the picture data. Otherwise the command renames the file onto the destination, as an export does
(ADR 004). On Windows that rename waits at most 2 seconds for another process that holds the
destination.

The steps before FFmpeg have the time limit of the preparation of an export, for one source
(ADR 050): the checks of the request, the probe, and the FLV input. When a step has not
answered at that limit, the command ends with an error. A step that answers after the command
ended starts no FFmpeg, and it removes what it made, as the helper of an export does.

One Export Frame command runs at a time. It can run while a video export runs. It is not a run
of the export queue.

### The exit of the application

An exit cancels a command that runs, and waits a bounded time for its process to end and for
its temporary file to go, as it does for an export (ADR 017). The quit dialog of ADR 027 does
not ask about it.

### The result

When the command ends, a notice in the notification area of the preview gives the name of the
file. When it fails, the notice gives the error and the detail of FFmpeg when there is one. The
notice belongs to the action, so a change of the clip does not remove it, and the removal of
each clip does not remove it.

The notice of a success goes after 5 seconds, by the rule of the other notices of the preview
that go by themselves: the pointer or the focus on the notice holds it. The notice of a failure
stays until the user closes it, or until the plan accepts the action again.

## Consequences

- The image is the first frame of a segment that a Mark In at that moment would start, at the
  full display size of the source. A preset has no effect on it.
- In the cases of ADR 003 in which a mark is not on the frame on screen, the image is not the
  frame on screen either. When no frame has a PTS that is not before the inferred PTS, the
  command fails.
- While the calibration is not ready, the action is not available, as the mark actions are not.
- For a file with several video streams, the image comes from the stream that an export reads.
  A `MediaSource` preview shows the first video stream of the file (ADR 046).
- A picture with more than 8 bits for each colour is written with 8 bits. A picture in a wide
  colour space or with a high dynamic range is not mapped to another colour space, so it can
  look pale in a viewer.
- A user who gives an export a name that ends in `.png`, and then gives an image the same path
  while that export waits or runs, gets the file of the one that ends last. Neither command
  knows the destination of the other.
- The command checks the revision of the source before FFmpeg starts, and for an FLV again
  when it builds the input. A file that is replaced after those checks, before FFmpeg opens it,
  is not detected. An export has the same limit.
- The read of the result and the rename have no time limit of their own, as the rename of an
  export has none. A file system that stops answering at that moment keeps the action in
  progress until it answers. An exit does not wait for it longer than the budget of ADR 017.
- The temporary file gets the mode of a destination that exists. So a destination that the user
  can write and cannot read makes the check of the result fail, and the destination stays as it
  was.
- When the user moves or renames the folder of the destination while the command runs, the
  command fails, and its temporary file can stay in that folder, as the temporary file of an
  export can.
- The notice has no button that shows the file in the file manager. ADR 029 permits that action
  only for the path of an export run.
- JPEG is not offered. A later record can add it.
- `Cmd+S` and `Ctrl+S` stay free for a later action that saves the project.
