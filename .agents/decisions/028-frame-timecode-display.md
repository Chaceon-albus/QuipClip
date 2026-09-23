# 028. Show the elapsed time as a frame timecode by default

- Status: Accepted
- Date: 2026-09-23
- Deciders: capric98
- Amends: ADR 002

## Context

The interface shows source-relative elapsed time as `HH:MM:SS.mmm` (ADR 002 and
`docs/architecture.md`). Premiere Pro, DaVinci Resolve and Final Cut Pro show
`HH:MM:SS:FF` by default, and the user edits frame by frame. With milliseconds, one frame
step changes three digits, and a seek target that lies less than one frame from the frame
on screen (ADR 022) shows a different number from that frame.

ADR 002 allows frame-rate metadata for diagnostics and nominal navigation only. Frame rate
must never create an edit boundary.

## Decision

The interface shows elapsed time as `HH:MM:SS:FF` by default. The user can change the
format to `HH:MM:SS.mmm` in Settings, and the choice persists in the web view store, next
to the language preference (ADR 011).

`FF` comes from the nominal frame rate of the source: the average frame rate, else the real
frame rate, as the status bar uses them.

- `HH:MM:SS` is the whole elapsed seconds, the same as in the millisecond format.
- `FF` is the frame index inside that second: the fractional part of the elapsed seconds,
  multiplied by the nominal rate, rounded down. Before the rounding, the display adds half a
  tick of the source video time base, and at least 1 µs. Containers such as Matroska store
  each PTS rounded to the millisecond, so at 29.97 fps a frame start can lie up to 0.5 ms
  before its nominal position. Without the margin, that frame shows the number of the frame
  before it, and a frame step repeats one number and skips the next. The display still names
  the frame that contains the time, not the nearest frame, so a seek target in the middle of
  a frame shows the same number as the frame that answers it.

This is a display rule only. No edit, seek or export reads `FF`. A mark still stores the
PTS of the frame on screen.

For an integer rate such as 24, 25, 30 or 60, `FF` is the same as the non-drop-frame SMPTE
count. For 23.976, 29.97 and 59.94, `FF` counts frames inside each real second, so the
display never drifts from the millisecond format. It is not SMPTE drop-frame or
non-drop-frame timecode.

The millisecond format is used when the source has no nominal frame rate. It is also used
when the average frame rate and the real frame rate differ, because the source then has a
variable frame rate and `FF` would not name a frame.

The ruler labels follow the same format, and they may shorten the label to the tick step,
for example `00:05` or `00:05:12`.

## Consequences

- A frame step changes the last two digits by one, as the user expects from other editors.
- A user who needs milliseconds can switch the format in Settings.
- Exports, the project file and the time model do not change.
- A variable-frame-rate source never shows a frame timecode.
