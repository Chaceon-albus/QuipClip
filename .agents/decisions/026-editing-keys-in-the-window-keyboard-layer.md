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
| `\`                                   | none              | fit the whole source in the timeline    | taken, no act |

"Taken, no act" means that the layer owns a repeated key press and performs nothing, as
ADR 021 does for a held `Space`.

### The rule for modifiers

A binding matches only when the held modifiers equal its set exactly. `Shift+Ctrl+I`
does not match `I`. A key press that matches no binding is not owned, so the system and the
web view keep every combination that the table does not name.

### How the layer names a key

A letter matches `event.key` when that value is one ASCII letter, compared without case.
Otherwise it matches `event.code`. The first rule follows the keyboard layout that the user
selected, so a Dvorak user presses the key that shows `I`. The second rule covers the cases
where `event.key` is not a plain letter: a Cyrillic or Greek layout, a dead key, and the
character that `Option` makes on macOS. `Caps Lock` does not change a match. A named key
such as `Home`, `Delete` or an arrow matches `event.key`.

### The condition for each action

Each action has the same condition as the control that performs it. Mark In from the key
and Mark In from the button use one predicate. When the condition is false, the layer owns
the key press and performs nothing, as ADR 021 does for `Space` without media. The key then
cannot go to another handler that the user cannot see.

- Mark In and Mark Out write the PTS of the frame the browser confirmed, as ADR 003 and
  ADR 022 require. A key press during a pending seek does nothing.
- A step of ten frames is one request to `seekNominal` with ten frame intervals. It is not
  ten requests. ADR 019 sounds one cue for it.
- Go to the Out point seeks to `outPts`. The segment is half open (ADR 002), so that frame
  is the first frame after the segment. It is also the frame at which the user pressed
  Mark Out, so a mark and a return to it show the same frame.
- Home and End need an attached, ready source. Home seeks to `videoStartPts` when the
  source is calibrated, and to time zero on the approximate clock when it is not. End seeks
  to the last frame on the approximate clock. ADR 021 refused a global `Home` because it
  needed this second branch. This record supplies it.
- Undo and redo act on the edit history. They do nothing inside a text field, because the
  layer does nothing there, and the field keeps its own undo.

### The tooltips

The table is the only source of the key names in the interface. A tooltip that names a key
reads it from the table, and formats it for the platform: `⌘⇧Z` on macOS, `Ctrl+Shift+Z` on
Windows.

## Consequences

- The keyboard path covers the whole editing loop: open, move, mark, delete, undo, zoom,
  export.
- `Shift` with an arrow now steps ten frames. ADR 021 held `Shift` free for this.
- `Ctrl`, `Cmd` and `Alt` stay with the system and the web view, except for the combinations
  in the table.
- On macOS the default application menu of Tauri binds `Cmd+Z` and `Shift+Cmd+Z` to its Edit
  menu. The implementation must confirm in the built application that the web view receives
  these key presses first. If the menu takes them, a later unit routes them from a custom
  menu to the layer.
- `Escape` finishes the named segment only when no dialog or menu is open. Radix keeps its
  own `Escape` for an open overlay, because the layer does nothing there.
- `ArrowUp` and `ArrowDown` still stay with the containers that scroll and with the menus.
- The layer answers more keys, so more key presses are cancelled in the main window. A key
  in the table no longer reaches a focused button of the main window. `Enter` still
  operates every button.
