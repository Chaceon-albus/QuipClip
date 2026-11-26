# 066. Change the export order of the segments in a dialog

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 007, ADR 026

## Context

The export joins the segments in the order of the segment array (ADR 007). A new segment goes
to the end of that array. A Split puts its two halves at the place of the segment. A move of a
clip keeps the export order (ADR 052). The user had no action to change the order of the
segments for an export.

To export in another order, the user had to delete segments and mark them again.

The user asked for a way to change the order in one place that shows all the segments, and not
with a step on each segment.

## Decision

### The segments of the export

The **segments of the export** are the segments that a request for an export would take at
that moment, in that order. One function gives their ids. These parts use that function, so
they agree with the export and with each other:

- the code that builds the request
- the rows of the dialog of this record, and their numbers
- the count of the segment summary in the gutter of the track row, and whether the action of
  this record is available
- the number `#N` of each bar, its tooltip and its accessible name

A bar still shows only for a segment that has a place on the timeline.

### The Export Order dialog

A modal dialog, Export Order, lists the segments of the export. Each row shows:

- the number of the row in the list
- the name of the segment (ADR 065), when it has one
- its In and its Out as sequence time, in the format that the timeline shows (ADR 028)
- its duration

A row of a segment whose position on the timeline is not known shows a dash for those times.

### How it opens

A new action, Export Order, opens the dialog. It is a row of the key table (ADR 026) with the
key `Cmd+Shift+E` on macOS and `Ctrl+Shift+E` on Windows. The action is available while the
export has two or more segments. It does nothing while a drag trims the edge of a segment, as
the other edit actions (ADR 030).

The segment summary in the gutter of the track row becomes a button that runs the action. Its
tooltip names the action and its key.

The context menu of a segment does not get an item for it. That menu acts on its segment, or
on the selection that its segment is part of (ADR 026, ADR 045). A request for the menu of a
segment that is not part of a selection of several segments also selects that segment, which
clears a pending In (ADR 007). An order of all the segments of the export is not an action on
one segment or on a selection.

### The changes in the dialog

The dialog holds a draft: the ids of the segments of the export, in an order. The timeline
store does not change while the user changes the draft.

- **A drag.** The user drags a row with the pointer to another place. The list scrolls when the
  pointer is near its top or its bottom. The dialog uses pointer events, and not the drag and
  drop of HTML, because the window takes the drop of a file.
- **The keyboard.** While a row has the focus, Up and Down with no modifier move the focus from
  row to row. Up and Down with `Alt` (`Option` on macOS) and no other modifier move the focused
  row one place, and the focus stays on that row. The dialog takes each key that it handles, so
  the key does not also scroll the list. The window keyboard layer does nothing while a dialog
  is open (ADR 021), and no key of the key table uses `Alt`, so the dialog owns these keys.
- **Sort by Timeline Position.** A button puts the rows in the order of the start of each
  segment on the sequence. It compares the exact starts, not the text of the rows. Segments
  with the same start, and segments with no known position, keep their order among themselves.
  Segments with no known position go after the others.

The numbers of the rows follow each change.

### A timeline that changes while the dialog is open

An import that started before the dialog opened can end while it is open, and a trim that the
user released can then write its boundary. So the rows read the segments from the store by id,
and they show a change of a time or of a name at once.

When the ids of the segments of the export are no longer the ids of the draft, the dialog
discards the draft. It shows the segments of the export in their order of that moment, and it
says that the timeline changed.

### The result

The confirm button gives the draft to the timeline as one edit, with one undo step. The cancel
button and Escape discard the draft. A draft in the order of the array is no edit.

The store action takes the ids in the new order. It does nothing unless those ids are exactly
the ids of the segments of the export, each one time. When the action does nothing for that
reason, the dialog discards the draft and says that the timeline changed, as above. Otherwise
the action writes the segments of the export in
the new order into the places that they hold in the array. Each other segment of the array
keeps its place. In the same edit it writes the list of selected segments in the order of the
new array (ADR 045). The selection and the current segment name the same segments as before.

### What stays

The array is still the only source of the export order (ADR 007). Nothing sorts the segments
without a request of the user. The sort button of the dialog is such a request.

## Consequences

- The position of a segment on the timeline can differ from its place in the export order, as
  before. The numbers on the bars and the dialog show the export order.
- The bars of the segments are in the document in the order of the array. So a new order also
  changes the Tab order of the bars. It can change which of two overlapping bars shows on top
  when neither is selected nor has the focus.
- A new order can need more inputs (ADR 055). After the earlier checks pass, the export
  refuses an order that needs more than 85 input runs, with `piecesOutOfOrder`, as before.
- The dialog does not rename a segment. Rename Segment does that (ADR 065).
