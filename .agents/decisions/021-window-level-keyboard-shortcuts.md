# 021. Give the window one keyboard layer for play and for the frame step

- Status: Accepted
- Date: 2026-09-21
- Deciders: capric98
- Amended by: ADR 026

## Context

QuipClip had no keyboard layer. `src/App.tsx` renders `AppShell`, and nothing
listened for a key press at the level of the window.

One element stepped a frame from the keyboard. `TimelinePanel` put a key handler
on the `role="slider"` element of the seek surface. That handler ran only while
that element held the focus. A user who opened a file and never pressed Tab has
the focus on the body, so the arrow keys did nothing. The user reported this as a
fault, and it was one.

The two step buttons of the transport bar call the same action under a different
condition. The buttons need an attached, ready source and a valid nominal frame
rate. The arrow keys needed a calibrated source as well. One action had two
conditions, and the stricter one belonged to the keys.

`seekNominal` needs neither condition to be that strict. It reads `currentTime`
from the element, it adds one nominal frame interval, and it assigns the result.
Calibration never enters that path. The calibration test on the arrow keys
therefore refused a step that the action could always perform.

The play action had no key. `togglePlayback` was reachable from one button.

## Decision

One listener owns the keyboard of the window. It is a `keydown` listener on the
window, in the capture phase. `src/components/layout/useKeyboardShortcuts.ts`
mounts it once from `AppShell`, and it stays for the life of the process.

The layer maps three keys:

- `Space` starts and stops playback.
- `ArrowLeft` steps one frame back.
- `ArrowRight` steps one frame forward.

`src/components/layout/keyboardShortcutController.ts` holds every rule as one
pure function. The listener reads the event, it builds a plain description of
that event, and it asks the pure function what to do. The pure function has tests
that need no document.

### The capture phase on the window

The capture phase on the window is the first position in the path of a key press.
No other handler can take the event before it. No other handler can stop the
event before it.

A listener in the bubble phase is the last position. Any handler between the
target and the window can silence it. That is the same fault this layer corrects,
so the layer must not be able to suffer it.

Radix registers its own Escape handler on the document, in the capture phase. A
listener on the document would decide its order against that handler by the order
of registration. A listener on the window is ahead of it without a rule.

The cost is that the layer sees every key press in the application. The rules
below pay that cost.

### The layer cancels the key press it owns

A cancelled key press for `Space` does not operate a button that holds the focus.
A button takes `Space` on the key release, and only when the key press set the
active state of that button. A cancelled key press never sets it.

Cancelling the key press is not sufficient on its own. It stops the native
operation of a plain button, because that operation happens on the key release. It
does not stop a handler that a library registered on the key press, and such a
handler never examines whether the event was cancelled. Radix opens a menu from
`Enter` and from `Space` in exactly such a handler. One press of `Space` on a
focused menu trigger therefore started playback and also opened the menu.

The layer therefore also stops the propagation of a key press it owns. The event
reaches no handler below the window, which is what ownership has to mean. The reach
of that rule is bounded by the conditions below: a key press inside a dialog, a
menu, a list box or a text field is never owned, so every widget of an open overlay
keeps its own keys.

The layer therefore takes `Space` from every control of the main window. `Enter`
still operates every button, and `Enter` and `ArrowDown` still open every menu, so
no control loses its keyboard.

Two alternatives were refused. A blur destroys the position of the user in the
Tab order and removes the focus ring. A test on the focus gives the correct
result for the play button and the wrong result for every other button: `Space`
on a focused Undo button would undo an edit.

### A button of the transport bar does not keep the focus after a click

The layer takes `Space` from a button that holds the focus. The transport bar is
the place where that matters, because its buttons are edit actions that the user
presses with the mouse many times in a session. A user who pressed Delete Segment
and then pressed `Space` would expect playback, and the previous rule gave them a
second delete.

Each button of the transport bar therefore cancels the default action of its
mouse-down event. The browser gives the focus to a button on mouse down, so a
cancelled mouse down leaves the focus where it was. The click still occurs,
because the browser sends a click on mouse up and does not test the mouse down.

The Tab order does not change. A user who reaches a button with the Tab key still
focuses it, and `Enter` still operates it. Only the mouse path changes, and the
mouse path is the one that produced the surprise.

WebKit does not give the focus to a button on a click, so this rule changes
nothing on macOS. It changes the behaviour on Windows, where the web view follows
the other rule.

### When the layer does nothing

The layer does not act when any of these is true:

- The key press is already cancelled.
- `Ctrl`, `Cmd`, `Alt` or `Shift` is held. The first three belong to the system
  and to the web view. `Shift` is held free for a later step of several frames.
- The key press belongs to an input method. The layer tests `isComposing` and
  also the legacy code 229, because the first key of a composition reports
  `isComposing` as false in several engines.
- The target is an `input`, a `textarea`, a `select`, or an editable element.
- The target is inside a dialog, a menu or a list box. Radix gives those
  containers the roles `dialog`, `menu` and `listbox`, and a Radix menu item takes
  `Space` for its own selection and for its type-ahead.
- A modal layer is open anywhere in the document. A layer that is running its exit
  animation does not count. Radix keeps a closed layer mounted while that animation
  runs, and a layer that is closing no longer owns the keyboard.
  This test repeats the one above on purpose. It covers the state where a dialog is
  open and the focus rests on the body, which a test on the target alone cannot
  see.

### The condition for a frame step

The condition is an attached, ready source with a valid nominal frame rate. This
is the condition the two step buttons carry, and it is the condition `seekNominal`
states for itself.

A source that never calibrates therefore steps. Its playhead moves on the
approximate clock, and the cue of ADR 019 sounds. It still cannot mark an In point
or an Out point, which ADR 003 requires.

### The handler of the slider is removed

Two handlers for one behaviour would move the playhead two frames for one key
press. The capture phase gives the slider no way to yield, because the layer has
already decided before a handler of React runs.

The element keeps `role="slider"`, its position in the Tab order, and its ARIA
values. The requirement of that role is that the element answers the arrow keys
while it holds the focus. It does, because the layer answers them everywhere, and
`aria-valuenow` still changes. Only the place of the handler moves.

### Repeats

A held arrow key steps for every repeat. ADR 019 tuned the sound cue for
approximately thirty requests each second, and its continuation rule exists for
that rate. A limit in this layer would discard steps that the user asked for, and
an editor whose step count differs from the key press count is not frame accurate.

A held `Space` starts or stops playback once. The layer takes the repeated key
press and does nothing with it, so a held key neither scrolls the page nor starts
and stops playback thirty times each second.

(Changed on 2026-09-24.) The two step buttons repeat the same way when the user holds
them. A primary press with no modifier steps at once. After 400 ms the button repeats
about every 33 ms, and each repeat is one `seekNominal` request, like a key repeat. The
click that ends the same press takes no second step. A click that no pointer press
started, such as `Enter` or a click from assistive technology, steps once and never
repeats. Release, a pointer that leaves the button, a lost window focus, a disabled
button and an unmount end the repeat.

### Two fields, not one

The pure function reports whether the layer owns the key press, and separately
which action to perform. A held `Space`, and `Space` while no media is open, both
own the key press and perform nothing.

One nullable field cannot express that. Under one field, `Space` would operate
whatever button holds the focus while no media is open, and would not while media
is open. The meaning of the key would depend on state the user cannot see, which
is the fault this record removes.

## Consequences

- The arrow keys answer wherever the focus is. The condition they carry is the
  condition the step buttons carry, which is looser than the condition the keys
  carried before.
- The two step buttons stay. They keep the mouse on the frame step, and their
  tooltips name the keys.
- `Space` no longer operates a button that holds the focus in the main window.
  `Enter` still does. `Space` keeps its meaning inside a dialog and inside a menu,
  where the layer does nothing, so every menu item still takes it.
  Later change: the preset list of the settings dialog is now a list box. Its rows
  take the arrow keys, and `Space` there does nothing.
- A button of the transport bar does not take the focus from a mouse click, so
  `Space` after a click on an edit action starts playback and does not repeat that
  action. A button still takes the focus from the Tab key.
- The menu of the title bar and the language menu of the status bar no longer open
  with `Space`. They open with `Enter` and with `ArrowDown`. A trigger that holds
  the focus while its menu is closed does not own the keyboard, so `Space` there
  starts playback. Radix returns the focus to the trigger when a menu closes, and
  the earlier rule left the arrow keys dead on that trigger until the user clicked
  somewhere else. That was the same fault this record removes.
  Later change: the status bar no longer has a language menu. Its gear opens the
  Settings dialog, and the language choice is in that dialog.
- `ArrowUp` and `ArrowDown` no longer step a frame. They stepped one only while the
  slider held the focus, and that state is the fault this record removes. Those two
  keys stay with the containers that scroll and with the menus that move a
  selection.
- `Home` no longer seeks to the start of the source. It did so only under the
  calibration test. `seekToPts` reports a failed seek on a source that never
  calibrates, so a global `Home` needs a second branch on the approximate clock.
  That is a new behaviour, and not a move of this one.
- A frame step taken while the calibration is still open does not refuse precise
  editing. (Changed on 2026-09-24. Before that, such a step moved the element before
  the anchor, and the attachment lost precise editing.) The playback store defers the
  step until the first frame callback takes the anchor (ADR 022), and each press adds
  one frame to the deferred step, so the step count still equals the press count.
- ADR 019 names the two callers of `seekNominal` as the arrow keys of the focused
  timeline and the two step buttons. Both callers remain. The arrow keys move from
  the focused timeline to the window.
