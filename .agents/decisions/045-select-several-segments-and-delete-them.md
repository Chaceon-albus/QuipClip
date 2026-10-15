# 045. Select several segments, and delete them together

- Status: Accepted
- Date: 2026-10-14
- Deciders: capric98
- Amends: ADR 007, ADR 026, ADR 030

## Context

ADR 007 gives the timeline one current segment. Mark In, Mark Out, Split and Delete act on that
segment, and never on a segment that the playhead suggests. A click selects one segment. Delete
removes it and leaves nothing current.

The user asked for two more ways to select segments, so that several segments can be deleted
together:

- `primary` with `A` selects every segment. `primary` is `Cmd` on macOS and `Ctrl` on Windows.
- `primary` with a click adds a segment to the selection.

Before this record, the user had to click each segment and press Delete for each one.

## Decision

### The selection

The timeline store holds `selectedSegmentIds`, the selected segments in the order of the project
array. That order is the export order (ADR 007).

- A selection of one segment makes that segment current, as a click did before.
- A selection of several segments leaves nothing current. Mark In, Mark Out, Split, Go to In and
  Go to Out then have no named target. They do not guess between the selected segments. This
  keeps the rule of ADR 007.
- A selection is not an edit. It adds no history entry. A change that selects a segment clears a
  pending In mark, as a click did before. While any segment is selected, no In mark is pending.

These requests select only their own segment, as before:

- a click on the body of a segment
- a click on an edge
- a press that starts a trim (ADR 030)
- a request for the context menu of a segment that is not in a selection of several (see below)

`primary` with a click on a segment adds that segment to the selection, or removes it when it is
selected. This applies to the body and to an edge. It also applies to a click from the keyboard
on a focused segment: `Cmd+Enter` on macOS and `Ctrl+Enter` on Windows. The click does not seek.
Its press does not start a trim.

The modifiers must match exactly, as in the key table of ADR 026: `Shift` or `Alt` with `primary`
makes a plain click. On macOS a Control click still opens the context menu (ADR 007). On Windows
a Control click is now not a plain click: it adds or removes the segment.

### Select All

`primary` with `A` selects every segment of the active source. The condition is an active source
with at least one segment. When the condition is false, the keyboard layer owns the key press and
does nothing (ADR 026). A repeated key press is taken and does nothing. While a drag trims an
edge, the key does nothing, as the edit keys do (ADR 030). It would change the selection from the
segment of the trim.

The keyboard layer does nothing inside a text field (ADR 021). The field then selects its own
text. On macOS the web view gives the key press to the page first. It gives the press to the Edit
menu only when the page does not cancel it (ADR 026). So the Select All item of the Edit menu
still works inside a text field.

### Delete with several selected segments

Delete removes every selected segment of the active source. The key, the Delete button and the
Delete Segment item of the context menu use one condition. It needs an active source and at least
one selected segment. The removal is one edit with one history entry. One undo restores the segments
in their places and selects them again. After the removal nothing is selected, so the next Delete
cannot act on a segment that the user did not name.

The name and the tooltip of the Delete button say "Delete Selected Segment" while one segment or
none is selected. For a selection of several, they give the count, such as "Delete 3 Selected
Segments".

### Other actions with several selected segments

- Mark In marks a pending In at the frame on screen. The selection ends.
- Mark Out and Split are disabled. The reason of Split says "Select only one segment."
- Escape and the Finish button end the selection, with no history entry.
- Play Segment plays the segment at the playhead, as with no current segment (ADR 026).
- The duration in the transport bar shows nothing, because no segment is current.

### The context menu of a selection

(Added on 2026-10-14.) A request for the context menu of a segment keeps a selection of several
segments when the segment is one of them. The menu then acts on the whole selection:

- Delete Segment names the count, such as "Delete 3 Segments", and deletes every selected
  segment. It plans the command of the `Delete` key, so it has the same condition.
- Go to In and Go to Out are disabled, because they need one current segment. Play Segment is
  disabled too, also while a segment plays. Its key would act on the segment at the playhead,
  which the menu did not name. The menu keeps its shape, as ADR 026 requires for a disabled item.
- The item plans again when it runs. It runs nothing when the selection changed while the menu
  was open.

A request on a segment outside the selection, or with one segment or none selected, selects only
that segment, as before.

### The drawing

Each selected segment takes the selected style of ADR 007: the brand fill, the inverted label,
the 2px border and the inset line. Each one reports `aria-pressed`. The playhead keeps its ring
over the selected fill also when several segments are selected. Only the current segment shows
the box of its Out frame at a high zoom, so a selection of several shows no such box.

### Undo and redo

A history entry holds the selection. Undo and redo restore it, but only the segments that the
restored array still holds and that belong to the active source. The current segment follows
from the restored selection.

## Consequences

- Delete is the only action that acts on several segments. Every other edit still needs one
  named target.
- The context menu of a selection offers only Delete. A later record can add more actions that
  act on several segments.
- The key table of ADR 026 gains one row. `primary` with `A` no longer reaches the web view
  outside a text field.
- The Select All item of the macOS Edit menu does not select segments. A key press of `Cmd+A`
  reaches the page first and selects them. A click on the menu item sends the system action to
  the web view, which selects no segment.
- No click selects a range of segments. `Shift` with a click stays a plain click.
- A segment narrower than 12px has a wider hit area only while it is not selected (ADR 007).
  After Select All, a click on a narrow segment must hit its true width, and a click beside it
  can hit a selected neighbour.
