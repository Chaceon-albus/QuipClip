# 026. Put the editing keys in the window keyboard layer

- Status: Accepted
- Date: 2026-09-23
- Deciders: capric98
- Amends: ADR 021

## Context

ADR 021 gives the window one keyboard layer. That layer maps three keys: `Space`,
`ArrowLeft` and `ArrowRight`. It does nothing when `Ctrl`, `Cmd`, `Alt` or `Shift` is
held.

QuipClip is a tool for marking In and Out points. With only three keys, the user must move
the mouse to the transport bar for each mark, each delete and each undo. Premiere Pro,
DaVinci Resolve and Final Cut Pro all use the same keys for these actions: `I` and `O`
mark, `Delete` removes, `Cmd+Z` or `Ctrl+Z` undoes. A user of those editors tries these keys
first. A review of the interface found that the missing keys are the largest gap in the
keyboard path. The user chose the full industry set.

ADR 021 refuses every modifier. It gives two reasons. `Ctrl`, `Cmd` and `Alt` belong to the
system and to the web view. `Shift` is held free for a later step of several frames. The
second reason no longer applies, because this record uses `Shift` for that step. The
first reason stays true for every combination that this record does not name.

## Decision

The layer of ADR 021 stays the one listener. Its rules about the capture phase, ownership,
focus, input methods, text fields, dialogs, menus and list boxes stay as they are. This
record changes two things: the list of keys, and the rule for modifiers.

### The key table

One table holds every binding. Each binding names a key, an exact set of modifiers, and an
action. `primary` is `Cmd` on macOS and `Ctrl` on Windows.

| Key                                   | Modifiers         | Action                                  | Repeat        |
| ------------------------------------- | ----------------- | --------------------------------------- | ------------- |
| `Space`                               | none              | start or stop playback                  | taken, no act |
| `/`                                   | none              | play the segment to its last frame      | taken, no act |
| `ArrowLeft` / `ArrowRight`            | none              | step one frame back / forward           | acts          |
| `ArrowLeft` / `ArrowRight`            | `Shift`           | step ten frames back / forward          | acts          |
| `Home` / `End`                        | none              | go to the first / last frame            | taken, no act |
| `I` / `O`                             | none              | mark In / mark Out                      | taken, no act |
| `I` / `O`                             | `Shift`           | go to the In / Out of the named segment | taken, no act |
| `Delete` / `Backspace`                | none              | delete the named segment                | taken, no act |
| `Escape`                              | none              | finish the named segment                | taken, no act |
| `Z`                                   | `primary`         | undo                                    | acts          |
| `Z`                                   | `primary`,`Shift` | redo                                    | acts          |
| `Y`                                   | `Ctrl` (Windows)  | redo                                    | acts          |
| `O`                                   | `primary`         | open media                              | taken, no act |
| `E`                                   | `primary`         | export                                  | taken, no act |
| `,`                                   | `primary`         | open Settings                           | taken, no act |
| `=` / `-` (and the numpad `+` / `-`)  | none              | zoom the timeline in / out              | acts          |
| `+`                                   | none              | zoom the timeline in                    | acts          |
| `=` / `+`                             | `Shift`           | zoom the timeline in                    | acts          |
| `\`                                   | none              | fit the whole source in the timeline    | taken, no act |
| `/`                                   | `Shift`           | play the segment to its last frame      | taken, no act |
| `Z`                                   | `Shift`           | fit the whole source in the timeline    | taken, no act |

"Taken, no act" means that the layer owns a repeated key press and performs nothing, as
ADR 021 does for a held `Space`.

(Added on 2026-09-23.) The rows for `+`, and for `=` and `+` with `Shift`, serve keyboard
layouts where `=` needs `Shift`, such as JIS and German, and layouts with a `+` key. On a US
layout `Shift` with `=` types `+`, so these rows add no second meaning there. `Shift+Z` is the
Final Cut Pro key for Zoom to Fit. It serves layouts where `\` needs `AltGr` or `Option`.

A tooltip names the first row of an action. Fit is the one exception: its tooltip names `\`
and `Shift+Z`, because on many layouts the first key needs `AltGr` or `Option`.
`aria-keyshortcuts` lists every row of the action in table order, drops a repeated token, and
leaves out the three layout rows: `+`, and `=` and `+` with `Shift`. (Changed on
2026-09-24: it leaves out four layout rows: `+`, `=` and `+` with `Shift`, and `/` with
`Shift`.)

### The rule for modifiers

A binding matches only when the held modifiers equal its set exactly. `Shift+Ctrl+I`
does not match `I`. A key press that matches no binding is not owned, so the system and the
web view keep every combination that the table does not name.

### How the layer names a key

A letter matches `event.key` when that value is one ASCII letter, compared without case.
It matches `event.code` only when `event.key` is not one printable ASCII character. A
printable ASCII character that is not the letter, such as the `.` that the E key types on
a Dvorak layout, does not match. The first rule follows the keyboard layout that the user
selected, so a Dvorak user presses the key that shows `I`. The second rule covers the cases
where `event.key` is not a plain letter: a Cyrillic or Greek layout, a dead key, and the
character that `Option` makes on macOS. `Caps Lock` does not change a match. A named key
such as `Home`, `Delete` or an arrow matches `event.key`.

A punctuation key, such as `=`, `-`, `+` or `\`, matches `event.key` only. It has no
fallback to `event.code`, because on another layout its position types another character:
German `ß` sits where US has `-`, and Spanish `ç` sits where US has `\`. The one exception is
`primary` with `,`, which also matches the `Comma` position when `event.key` is not one
printable ASCII character, as the letters do. (Changed on 2026-09-24: the `/` of Play
Segment is a second exception, below.) A numpad key matches `event.code` only, for
example `NumpadAdd`, so it matches on every layout and in both Num Lock states.

(Added on 2026-09-24.) The `/` of Play Segment is a second exception. It matches `event.key`
first, and it falls back to the `Slash` position only when `event.key` is not one printable
ASCII character, as the comma of `primary` with `,` does. On German, Spanish, Italian and
Nordic layouts the `Slash` position types `-`, so that key still zooms out. The numpad `/`
types `/`, so it matches too. A second row serves layouts that type `/` with `Shift`, such as
German, Spanish and Nordic `Shift+7` and French AZERTY `Shift` with the `:` key. That row
holds `Shift` and matches `event.key` only, with no fallback to a position. On a US layout
`Shift` with the `Slash` key types `?`, which matches no row, so the second row adds no second
meaning there. No other row holds `Shift` with `/`.

### The condition for each action

Each action has the same condition as the control that performs it. Mark In from the key
and Mark In from the button use one predicate. When the condition is false, the layer owns
the key press and performs nothing, as ADR 021 does for `Space` without media. The key then
cannot go to another handler that the user cannot see.

Two cases own the key press and perform nothing, because the action would harm the state
or change nothing:

- A seek to the frame that is already on screen, when no seek is pending. ADR 022 says
  that such a seek may bring no frame callback. Mark In and Mark Out would then stay
  disabled. Go to the start, and go to the In or Out point, do nothing in this case.
  (Changed on 2026-09-24.) End does nothing in this case too, by the rule of its target.
  On the frame grid of ADR 022, End does nothing when the ADR 028 index of the frame on
  screen is the index of the last frame or a later index. Off the grid, End does nothing
  when the frame on screen starts at or after the last tick of the extent. The playback
  store also does nothing when the element stands at or after that tick, or at the end of
  the element when that is earlier, within 1 µs (`extentEnd`, ADR 022). On the
  approximate clock, End does nothing when the element is within half a nominal frame of
  the end of the ruler. Each of these tests needs a frame on screen, no pending seek and no
  playback. The first two also need a ready calibration.
- Home and End while the calibration is open. A seek in that window refuses precise
  editing for the attachment (ADR 021). (Changed on 2026-09-24: this case no longer
  exists. Home, End, Go to In, Go to Out and the edge click of ADR 007 now send their
  seek while the calibration is open, and the playback store defers it until the anchor
  (ADR 022). Home asks for the first frame, which the store drops at the anchor because
  that frame is on screen. End goes to the last frame before and after the anchor. On the
  frame grid, the store keeps End as a seek to the first frame followed by that many frame
  steps. At the anchor it drops the seek, and the steps run as one step from the first
  frame. Off the grid, the store keeps the PTS of the last tick. End on the approximate
  clock keeps that clock after the anchor too, so it lands in the same place before and
  after it. Only an unavailable calibration refuses
  Go to In, Go to Out and the edge click.)

One case does not own the key press: `Escape` while a tooltip is open. Radix then closes
the tooltip. A second `Escape` finishes the segment.

(Added on 2026-09-24.) The timeline splitter (ADR 007) is a focusable separator. While it has
the focus, it owns `ArrowUp`, `ArrowDown`, `Home` and `End` with no modifier, as a list box
owns its arrow keys under ADR 021, and the layer does nothing with them. `Home` and `End`
then move the splitter and not the playhead. Every other key keeps its meaning. While a
drag of the splitter runs, the layer also leaves `Escape` alone, and the drag cancels on it.

(Changed on 2026-09-24.) While a drag trims a segment edge (ADR 030), `Escape` cancels the
trim and does not finish the segment, and Mark In, Mark Out, Delete, Undo and Redo own the
key press and do nothing.

The actions behave as follows:

- Mark In and Mark Out write the PTS of the frame the browser confirmed, as ADR 003 and
  ADR 022 require. A key press during a pending seek does nothing.
- A step of ten frames is one request to `seekNominal` with ten frame intervals. It is not
  ten requests. ADR 019 sounds one cue for it.
- Go to the Out point seeks to `outPts`. The segment is half open (ADR 002), so that frame
  is the first frame after the segment. It is also the frame at which the user pressed
  Mark Out, so a mark and a return to it show the same frame.
- Home and End need an attached, ready source. Home seeks to `videoStartPts` when the
  source is calibrated, and to time zero on the approximate clock when it is not. ADR 021
  refused a global `Home` because it needed this second branch. This record supplies it.
- (Changed on 2026-09-24.) End goes to the last video frame of the extent when the
  calibration is ready or still open, and the probe gives a valid `videoStartPts`, a
  positive `videoDurationTicks` and a valid video time base. The target counts from
  `videoStartPts`, so an audio track that starts before the video does not move it.
  - On the frame grid, End calls `seekToFrameIndex` with the index of the last frame: the
    last nominal frame whose start lies more than the margin of ADR 028 inside the extent.
    The element seeks to the middle of that frame, and the playhead shows its nominal
    start. An Out edge that a drag trims to the end (ADR 030) gets the same frame.
  - Off the grid, End calls `seekToPts` with the last tick of the extent,
    `videoStartPts + videoDurationTicks − 1`, and the option `extentEnd`. The browser shows
    the frame that holds that tick.
  - In all other cases, End seeks to the end of the ruler on the approximate clock, with
    `keepBrowserTimeline`.

  A typed time at or after the end makes the same call (ADR 028). On the frame grid, a
  frame step forward from the last frame of the extent is the edge of ADR 022 and only
  pauses.
- Undo and redo act on the edit history. They do nothing inside a text field, because the
  layer does nothing there, and the field keeps its own undo.
- (Added on 2026-09-24.) Play Segment (`/`, the Play Selection of Final Cut Pro) plays one
  segment and stops on its last frame, the frame before `outPts`.
  - The segment is the current segment. With no current segment, it is the segment of the
    active source that holds the PTS of the frame on screen, half open (ADR 002). The key
    does nothing when no segment holds that PTS, when more than one segment holds it (ADR 007
    refuses a guess between overlapping segments), or when no frame is on screen because a
    seek is pending.
  - The action needs an active source, a ready calibration, and a segment that holds a
    frame. ADR 022 lists the cases that cannot play. While the calibration is `calibrating` or `unavailable`, the key does
    nothing. The stop reads the exact PTS of each presented frame, and `play` drops a seek
    that the store defers before the anchor. (Changed on 2026-09-24: the context menu of a
    segment now shows the action. A native menu shows no disabled reason.)
  - The action seeks to `inPts` with `seekToPts` and plays. The sound and the mute state are
    those of normal playback. No cue sounds (ADR 019).
  - A second `/` while the segment plays pauses, as `Space` does.
  - `Space`, a click, a frame step, a scrub, a trim, a new source, a pause from the system
    and a loss of the calibration end the segment playback. Home, End, Go to In, Go to Out
    and a typed timecode end it when their plan calls the store. On the first frame of the
    playback, Go to In finds its frame on screen and does nothing. A seek from the system
    ends it only after the stop: while the segment plays, the stop stays, and a frame past
    the last frame is pulled back. A playback that starts later has no stop point.
  - ADR 022 gives the stop rule.

### The context menu of a segment

(Added on 2026-09-24.) The context menu of a segment (ADR 007) holds these items, in this
order: Go to In (`Shift+I`), Go to Out (`Shift+O`), Play Segment (`/`), a separator, and Delete
Segment (`Delete`, `⌫` on macOS). Each item names the action of its row in the key table.
An item is enabled when the plan of its key acts (`planShortcutCommand`), and it runs that
plan through the runner of the key. The item plans again when it runs, so a condition that
changed while the menu was open applies, and it runs nothing when another segment became
current. An item runs only the kind of command that it showed when the menu opened. An item
of an earlier menu never runs after a later menu opened. An item whose condition is false
is disabled, not hidden. While a segment plays, `/` pauses, so the Play Segment item shows
the label Pause and pauses; after the segment stopped, an item that showed Pause runs
nothing.

The key of each item comes from the key table. On macOS the item carries the accelerator of
its row, and the system draws it in the form of the tooltips, such as `⇧I`. On Windows the
item text carries the tooltip form after a tab, such as `Shift+I`, and the menu shows it in
its accelerator column. The labels come from the catalog.

The menu holds only actions whose operand is the segment. Mark In, Mark Out and Split act at
the playhead, which a right-click does not move. Finish Segment clears the selection that the
right-click made, and its key, Escape, closes the menu.

While the menu is prepared or open, the window keyboard layer and the command items of the
macOS menu do nothing, as for any open menu (ADR 021). A native menu has no element in the
document, so the page keeps its own flag, `nativeContextMenuState`, from the decision to open
until the popup closes.

### The tooltips

The table is the only source of the key names in the interface. A tooltip that names a key
reads it from the table, and formats it for the platform: `⇧⌘Z` on macOS (the Apple order: ⌃ ⌥ ⇧ ⌘, then the key), `Ctrl+Shift+Z` on
Windows.

## Consequences

- The keyboard path covers the whole editing loop: open, move, mark, delete, undo, zoom,
  export.
- `Shift` with an arrow now steps ten frames. ADR 021 held `Shift` free for this.
- `Ctrl`, `Cmd` and `Alt` stay with the system and the web view, except for the combinations
  in the table. `primary` with `=` or `-` is not claimed. Tauri turns off the zoom keys of the
  web view by default, so these combinations do nothing.
- (Added on 2026-09-24.) The macOS application menu has Settings… on `Cmd+,`, and a File
  menu with Open Media… on `Cmd+O`, Export… on `Cmd+E` and Close Window. Each of the
  three new items sends one event with the action name of this table, and the frontend runs
  the same plan with the same conditions as the keyboard layer: nothing happens while a
  dialog, a menu or the Open Media panel is open. The items stay enabled, as Quit does. A key
  press that the page handles never reaches the menu: WebKit gives a `Cmd` key to the page
  first, and the layer cancels every press that it owns. A key that the layer does not own,
  for example inside a dialog, reaches the menu item, and its handler then does nothing. So
  one press runs an action at most once.
- On macOS the default application menu of Tauri binds `Cmd+Z` and `Shift+Cmd+Z` to its Edit
  menu. The implementation must confirm in the built application that the web view receives
  these key presses first. If the menu takes them, a later unit routes them from a custom
  menu to the layer.
- `Escape` finishes the named segment only when no dialog or menu is open. Radix keeps its
  own `Escape` for an open overlay, because the layer does nothing there.
- `ArrowUp` and `ArrowDown` still stay with the containers that scroll and with the menus.
- (Added on 2026-09-24.) End reads `videoDurationTicks` as the extent of the video frames.
  ADR 002 does not make it the end of the last frame, and ADR 003 keeps the discovery of the
  last frame as future work. When the extent ends early, End shows an earlier frame. When
  it ends at the start of the real last frame, or within one tick of it, End, the frame step
  and a typed time stop one frame before that frame. Only a click on the ruler or a scrub
  reaches it. When the extent ends more than the margin of ADR 028 after the last frame,
  for example because the last sample lasts longer than one frame interval, End targets a
  frame that does not exist. The playhead then shows that frame first and moves back to the
  last frame when it arrives, and a second End seeks onto the frame on screen, which may
  bring no frame callback (ADR 022). On a grid whose frame interval is a whole number of
  ticks, one extra tick is enough. No rule can tell this from a real last frame of one
  tick. The durations of MP4 and MOV files rarely do this.
- (Added on 2026-09-24.) Two short last frames are not End's target, because no rule can
  tell them from a rounded extent. On an exact grid whose frame interval is not a whole
  number of ticks, a last frame of one tick is dropped when its extent is also a one-tick
  rounding of the end of the frame before it. When a tick is 1 µs or less, a last frame of
  1 µs or less is dropped.
- (Added on 2026-09-24.) Off the grid, the playhead first shows the last tick. When the frame
  arrives, the playhead moves back to the start of that frame, by less than one frame. End
  from inside the last frame, before its last tick, seeks onto the frame on screen, and that
  seek may bring no frame callback (ADR 022).
- (Added on 2026-09-24.) If the calibration becomes unavailable after a deferred End on the
  frame grid, the request runs on the approximate clock as the first frame and that many
  steps. A later End then goes to the end of the ruler.
- The layer answers more keys, so more key presses are cancelled in the main window. A key
  in the table no longer reaches a focused button of the main window. `Enter` still
  operates every button.
