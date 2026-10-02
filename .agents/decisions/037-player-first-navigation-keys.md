# 037. Give the arrow keys time jumps, and move the frame step to the comma and the period

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 021, ADR 026, ADR 035

## Context

ADR 021 and ADR 026 gave the arrow keys the frame step: one frame without a modifier, ten frames
with `Shift`. `ArrowUp` and `ArrowDown` stayed unbound, so that the containers that scroll and the
menus kept them.

A user asked for a preview that moves like a player. In PotPlayer and mpv, `←` and `→` jump five
seconds. QuipClip moved one frame, so a user who wanted to move through a long source had to hold
a key or drag the playhead. The user compared three tables and chose a player-first table:

- The arrows jump in time, as in PotPlayer and mpv.
- The frame step moves to `,` and `.`, the keys of mpv, LosslessCut and YouTube. Final Cut Pro
  uses the same keys to nudge an edit point.
- `↑` and `↓` go to the previous and the next edit point, as in Final Cut Pro, DaVinci Resolve
  and Premiere Pro.

## Decision

### The key table

This table replaces the rows of the arrow keys in the table of ADR 026. Every other row of that
table does not change.

| Key                        | Modifiers | Action                                     | Repeat |
| -------------------------- | --------- | ------------------------------------------ | ------ |
| `ArrowLeft` / `ArrowRight` | none      | jump 5 seconds back / forward              | acts   |
| `ArrowLeft` / `ArrowRight` | `Shift`   | jump 1 second back / forward               | acts   |
| `ArrowLeft` / `ArrowRight` | `primary` | jump 30 seconds back / forward             | acts   |
| `,` / `.`                  | none      | step one frame back / forward              | acts   |
| `,` / `.`                  | `Shift`   | step ten frames back / forward             | acts   |
| `ArrowUp` / `ArrowDown`    | none      | go to the previous / the next edit point   | acts   |

`primary` is `Cmd` on macOS and `Ctrl` on Windows. `Alt` stays unclaimed. No menu accelerator of
the application uses an arrow key, and the layer cancels every key press that it owns, so the web
view does nothing else with `Cmd+←` or `Ctrl+←`.

### How the layer names `,` and `.`

`,` and `.` are punctuation. ADR 026 matches punctuation on `event.key`, because on another layout
its position types another character. The rows of this record follow that rule, with three
additions:

- `,` and `.` without a modifier match `event.key`. They fall back to the `Comma` and the
  `Period` position only when `event.key` is not one printable ASCII character, as `primary`
  with `,` does. A Cyrillic layout therefore steps from those two positions. The numpad keys
  `NumpadDecimal` and `NumpadComma` never match, because the numpad decimal key types `,` on
  German layouts.
- A new key kind, `characterAt`, matches `event.key` and `event.code` together. The ten-frame
  rows are `Shift` with `<` at `Comma` and `Shift` with `>` at `Period`, where a US, UK, JIS or
  Brazilian layout types those characters. The tooltip names them `⇧,` and `⇧.` on macOS and
  `Shift+,` and `Shift+.` on Windows. `aria-keyshortcuts` names the key that the press reports,
  `Shift+<` and `Shift+>`.
- Layout rows, which no tooltip and no `aria-keyshortcuts` names:
  - `Shift` with `;` at `Comma` and with `:` at `Period`, for German, Swiss, Spanish, Italian,
    Portuguese and the Nordic layouts.
  - `Shift` with `<` at `KeyW` and with `>` at `KeyE`, for Dvorak.
  - `Shift` with `?` at `Comma`, for Czech, Slovak and Hungarian.
  - `Shift` with `?` at `KeyM`, and `Shift` with `.` at `Comma`, for French AZERTY, whose `.`
    needs `Shift`.

No row adds a second meaning on a US layout. `Shift` with `;` and `Shift` with `M` do nothing
there. `/` and `Shift` with `/` stay Play Segment, and `primary` with `,` stays Settings.

French and Belgian AZERTY lose the ten-frame step forward: `Shift` on the key after the `.` types
`/`, which is Play Segment. Canadian Multilingual loses both ten-frame steps. The tests hold one
row for each layout above, and also for Turkish Q, Russian and Greek. The facts about the layouts
come from the knowledge of the writer and were not checked on real systems.

### The time jumps

A time jump counts from the displayed position of ADR 022: the seek target first, then the frame
on screen, then the approximate clock. A held key repeats approximately 30 times each second. Each
repeat counts from the pending target, so a held key adds one jump for each repeat, and the store
still runs one seek at a time.

- On the exact frame grid of ADR 022, the jump moves a whole number of frames: `round(J × rate)`,
  with a tie away from zero (ADR 002). The start is the frame of the displayed position by the
  rule of ADR 028, or the exact frame on screen when no seek is pending. The target is a frame
  start, so `←` then `→` returns to the start frame. At 29.97 frames each second, 1 s, 5 s and
  30 s move 30, 150 and 899 frames. A jump by the ADR 028 rule from the time alone would move 149
  frames for 5 s at that rate, and the error would grow with each repeat.
- Off the grid, the jump seeks to the nearest tick of the target with `seekToPts`. Without a
  calibration, it uses `seekApproximate`.
- A target before the first frame takes the plan of Home. A target after the last frame of the
  extent takes the plan of End.
- Every jump carries `keepPlaying` (ADR 035), also when it takes the plan of Home or End. A jump
  during playback therefore keeps playing.
- A jump plays no cue (ADR 019).
- A jump does nothing when the element is paused, no seek is pending, and the target frame is the
  frame on screen.
- While the calibration is open, the store defers the jump, as ADR 022 requires.

### The edit points

The edit points are the In and the Out of every segment of the active source, and the pending In,
each one once. `↑` goes to the latest point strictly before the position, and `↓` goes to the
earliest point strictly after it. The position is the pending target, or the frame on screen, or
the approximate clock. On the grid, the points compare by ADR 028 frame index. Off the grid they
compare by ticks. A point at the position is skipped. The seek is the seek of Go to In and Go to
Out: it needs a ready calibration, and it pauses.

### Who keeps `ArrowUp` and `ArrowDown`

The layer still does nothing in a dialog, a menu, a list box, a text field, or on the focused
splitter (ADR 021, ADR 026). It also leaves `↑` and `↓` alone in two more cases:

- The target is inside an element with `aria-haspopup="menu"`, because a Radix menu trigger opens
  its menu on `ArrowDown`.
- The target is inside an element marked `data-scroll-keys`, and that element overflows
  vertically. The diagnostic details, the stack of preview notices, the decode failure panel and
  the import error panel carry the marker. A panel whose content fits gives the keys to the edit
  points.

## Consequences

- The step buttons of the transport bar still step one frame. Their tooltips now name `,` and `.`.
- `Shift` with an arrow is now a jump of one second, not ten frames. ADR 026 stated the earlier
  meaning.
- ADR 019 and ADR 022 name the key of the frame step "the arrow key", for example "a held arrow
  key repeats approximately 30 times each second". Since this record, that key is `,` or `.`. The
  rules about a held frame-step key do not change.
- `↑` and `↓` with the focus on the page body inside a panel that overflows claim the key and do
  nothing, by the rule of ADR 026 that a key whose condition is false is owned. The panel then
  does not scroll. This happens only with no media or with a decode failure, in a small preview,
  after a click on text that cannot take the focus.
- The layout facts above need a check on real systems. A wrong fact costs one binding on one
  layout, and the frame-step buttons still work.
