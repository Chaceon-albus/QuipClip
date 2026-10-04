# 044. Let the arrow keys step a frame while the video is paused, and add D and F

- Status: Accepted
- Date: 2026-10-04
- Deciders: capric98
- Amends: ADR 037

## Context

ADR 037 gave `←` and `→` the time jumps of PotPlayer and mpv: 5 seconds without a modifier, 1
second with `Shift`, and 30 seconds with `primary`. It moved the frame step to `,` and `.`.

The user reported two problems with that table after use:

- To adjust an edit point by frames, the user reaches for `D` and `F`, the frame-step keys of
  PotPlayer. These keys did nothing.
- During an adjustment by frames, the user also presses an arrow key. The arrow then jumps 5
  seconds, and the playhead leaves the place that the user adjusted.

A frame step during playback is rarely useful: the step stops the playback. A jump of 5 seconds
while the video is paused is also rarely what the user wants. So the state of the playback tells
which of the two the user means.

## Decision

### The arrows with no modifier

`ArrowLeft` and `ArrowRight` with no modifier have one action each, `stepOrJumpBack` and
`stepOrJumpForward`. The plan of the action reads the playback state at the key press:

- While the video plays (`isPlaying`, which includes the playback of a segment), the key jumps 5
  seconds by the rules of ADR 037. The jump keeps the playback running.
- While the video is paused, the key steps one frame. This is the step of `,` and `.`, with the
  same condition, the same cue (ADR 019) and the same rule for a held key: each repeat steps
  again, and a repeated step back plays no cue.
- While the video is paused and no frame step can run, the key jumps 5 seconds. A frame step
  cannot run without a nominal frame rate, or during a decode stall (ADR 039). The key then still
  moves the playhead, and the seek of the jump also loads a stalled preview again.

`Shift` with an arrow still jumps 1 second, and `primary` with an arrow still jumps 30 seconds,
in both states. While the video is paused, no key jumps 5 seconds, except an arrow when no frame
step can run.

### D and F

`D` steps one frame back and `F` one frame forward. `Shift` with `D` or `F` steps ten frames.
The letters match by the rule of ADR 026: the letter that the layout types, and the position
only when the layout types no ASCII character there. A Dvorak user therefore presses the keys
that show D and F. No other binding uses these keys.

The rows of `D` and `F` come after the rows of `,` and `.` in the table, so the first key of
each step stays `,` or `.`. The tooltip of each frame-step button names two keys: `,` and `D`,
or `.` and `F`. `aria-keyshortcuts` names `, D` and `. F`, and `Shift+< Shift+D` and
`Shift+> Shift+F` for the steps of ten frames.

### The table

This table replaces the rows of `ArrowLeft` and `ArrowRight` and the rows of the frame steps in
the table of ADR 037. The rows of `ArrowUp` and `ArrowDown` do not change.

| Key                        | Modifiers | Action                                               | Repeat |
| -------------------------- | --------- | ---------------------------------------------------- | ------ |
| `ArrowLeft` / `ArrowRight` | none      | paused: step one frame. Playing: jump 5 seconds      | acts   |
| `ArrowLeft` / `ArrowRight` | `Shift`   | jump 1 second back / forward                         | acts   |
| `ArrowLeft` / `ArrowRight` | `primary` | jump 30 seconds back / forward                       | acts   |
| `,` / `.`                  | none      | step one frame back / forward                        | acts   |
| `D` / `F`                  | none      | step one frame back / forward                        | acts   |
| `,` / `.`                  | `Shift`   | step ten frames back / forward                       | acts   |
| `D` / `F`                  | `Shift`   | step ten frames back / forward                       | acts   |

The layout rows of ADR 037 for `,` and `.` do not change.

## Consequences

- A user who adjusts by frames can use the arrows, `,` and `.`, or `D` and `F`. None of these
  keys moves the playhead by seconds while the video is paused, except an arrow when no frame
  step can run.
- A user who wants a jump of 5 seconds while the video is paused presses `Space` first, or uses
  `Shift` or `primary` with the arrow for 1 or 30 seconds.
- The same key acts in two ways, so the state of the Play button tells the user what the arrow
  does.
- An arrow reads the playback state at each press, also at each repeat of a held key. When the
  playback stops, for example at the end of the media or at the stop of a segment playback, the
  next press steps frames. A user who did not see the playback stop can then expect a jump and
  get a step.
