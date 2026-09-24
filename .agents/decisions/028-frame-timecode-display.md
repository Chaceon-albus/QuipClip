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

The display names the frame that contains the time, by that frame's nominal start:

1. It adds a small margin to the elapsed time (see below).
2. It finds the frame index `J`: the elapsed time multiplied by the nominal rate, rounded
   down.
3. `HH:MM:SS` is the whole seconds of the nominal start of frame `J`, that is `J` divided by
   the rate, rounded down.
4. `FF` is `J` minus the index of the first frame that starts in that second.

The margin is at least 1 µs. When the nominal frame interval is not a whole number of ticks
of the source video time base, the margin is one tick. Containers such as Matroska store
each PTS rounded to the millisecond, so at 29.97 fps a frame start can lie up to 0.5 ms
before its nominal position, and up to one full tick before it when the first frame's PTS is
also rounded, because elapsed time counts from that first frame. Without the margin, that
frame shows the number of the frame before it, and a frame step repeats one number and skips
the next. When the interval is a whole number of ticks, as with a time base of 1/25 at 25
fps, the frame starts lie exactly on the tick grid, and one tick could be a whole frame. The
margin is then only 1 µs.

The margin must also stay less than half a frame interval minus 1 µs. When one tick is not
less than that, the margin is a quarter of the interval, and at least 1 µs, so a time in the
middle of a frame still shows that frame. This applies to coarse time bases, such as 1/24 at
23.976 fps or 1/60 at 59.94 fps.

The display rounds down and never to the nearest frame, so a seek target in the middle of a
frame shows the same number as the frame that answers it (ADR 022).

At 23.976, 29.97 and 59.94 fps, a frame can start just before a whole second. Inside that
frame, the frame format still shows the earlier second, while the millisecond format shows
the new one, for less than one frame interval. A simpler rule that split the elapsed time
into whole seconds and a fraction first was tested and refused: its frame bins drift
against the real frames, so it repeats and skips numbers at those rates.

This is a display rule only. No edit, seek or export reads `FF`. A mark still stores the
PTS of the frame on screen. (Changed on 2026-09-24: a typed timecode now reads `FF` to find
the frame to seek to. See "Typed timecode" below. No edit and no export reads it, and a mark
still stores the PTS of the frame on screen.)

For an integer rate such as 24, 25, 30 or 60, `FF` is the same as the non-drop-frame SMPTE
count. For 23.976, 29.97 and 59.94, `FF` counts frames inside each real second, so the
display never drifts from the millisecond format by more than one frame. It is not SMPTE
drop-frame or non-drop-frame timecode.

The millisecond format is used when the source has no nominal frame rate. It is also used
when the average frame rate and the real frame rate differ, because the source then has a
variable frame rate and `FF` would not name a frame.

The ruler labels follow the same format. A label names the frame that the preview shows at
its tick, and it leaves out the parts that the tick step does not need: for example `00:05`
(`MM:SS`), `00:05:12` (`MM:SS:FF` at a frame step), or `0:05:12` (`H:MM:SS` for a source of
one hour or longer). Below 1 fps a second can hold no frame start, so the ticks sit on frame
starts, and each label names the second in which its frame starts.

### Typed timecode

(Added on 2026-09-24.) A click on the preview timecode, or `Enter` while it has the focus,
turns it into a text field. `Enter` seeks, and `Escape`, an empty entry, a click outside the
field and a blur inside the window cancel. The field accepts the format that the display
uses.

| Form | Frame format | Millisecond format |
| --- | --- | --- |
| Fields with `:` | 2 to 4 fields; missing leading fields are 0: `5:12` is `00:00:05:12` | 1 to 3 fields that end in seconds |
| Digits only | Right-aligned, `FF` first: `1012` is `00:00:10:12` | Seconds: `90` is 90 seconds |
| A decimal part | Not accepted | `.` and up to 3 digits |
| `.` among digits | Fills the field it lands in with zeros: `3.` is 3 seconds, `3..` is 3 minutes | Not applicable |
| A field that is too large | Carries into the next field | Carries into the next field |
| `+` or `-` first | A relative step of the frames that the unsigned form names | A relative time added to the displayed time |
| `;`, mixed separators, other characters | Refused | Refused |

Above 100 fps, `FF` has three digits, and a `.` in `FF` adds three zeros. The frame index of
an absolute entry is `ceil(S × rate) + FF`, where `S` is the whole seconds of its fields. A
time at or after the end of the source goes where End goes. A negative absolute time cannot
be typed, because a leading `-` always means a relative entry.

The seek follows the rules of ADR 022:

- A relative entry in the frame format is one `seekNominal` request with its frame count.
- An absolute frame on the frame grid is a `seekToFrameIndex` request to the middle of that
  frame, with no cue.
- Any other absolute time seeks to the last tick whose timecode equals the typed value, so
  the display then shows exactly the typed value. Without a calibration, it seeks on the
  approximate clock.
- An entry that names the frame on screen, with no seek pending and no playback, does
  nothing. During playback it seeks only when the element has already left that frame.

## Consequences

- A frame step changes the last two digits by one, as the user expects from other editors.
- A user who needs milliseconds can switch the format in Settings.
- Exports, the project file and the time model do not change.
- A variable-frame-rate source never shows a frame timecode.
