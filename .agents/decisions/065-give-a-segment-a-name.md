# 065. Give a segment a name

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 007, ADR 010, ADR 026, ADR 045

## Context

A segment shows as its number in the export order, `#N` (ADR 007). The user who marks many
segments in a long recording cannot tell them apart without a seek to each one.

A segment stores an id, two clip ids and two PTS values. The two clip ids can name the same
clip. A segment has no field for text.

The user asked for a name on each segment. Later records can use the name for the name of an
output file and for the title of a chapter. This record gives the name and the way to set it.
It gives the name no part in an export.

## Decision

### The name

A segment can have a name. A segment with no name is the default. Two segments can have the
same name.

A name is valid when all of these conditions are true:

- It has 1 to 80 characters. A character here is one Unicode scalar value, so a letter outside
  the Basic Multilingual Plane counts as one.
- Its first character and its last character do not have the Unicode property `White_Space`.
- It has no control character (the general category `Cc`, which includes the tab and each line
  break), no U+2028 and no U+2029.
- It has no surrogate without its pair.

The name is an optional field `name` of the segment in the timeline store. The derived segment
that the interface reads carries it too. A segment with no name has no such field. The store
keeps only a valid name.

### The Rename Segment action

A new action, Rename Segment, sets the name of the current segment. It is a row of the key
table (ADR 026) with the key `F2` on both platforms. The context menu of a segment gets the
item "Rename…" for it, between two separators, after Play Segment and before Delete Segment.
The item shows `F2`, as each item of that menu shows its key. It follows the rules of that
menu: it is enabled when one segment is current, and it is disabled for a request on several
selected segments (ADR 045).

The action does nothing while a drag trims the edge of a segment, as the other edit actions
(ADR 030).

The action opens a modal dialog with one text field. The field holds the name, with all its
text selected.

- The confirm button, and Enter, give the text of the field to the timeline. The dialog first
  removes each character that a name cannot have, and then the characters with the property
  `White_Space` at the two ends. Text that is then empty removes the name.
- The confirm button and Enter do nothing while the text, after those two steps, has more than
  80 characters. The dialog then says why.
- The cancel button, and Escape, keep the name.
- While the input method composes text, Enter and Escape belong to the input method, and the
  dialog does not act on them.

The dialog is a modal dialog, and not a field on the bar of the segment. While a dialog is
open, the window keyboard layer does nothing, and the Open Media and Export items of the macOS
menu do nothing (ADR 021). A field outside a dialog would stop only the keyboard layer.

When the item of the native context menu starts the action, the dialog opens after the menu
closes. The choice of the item and the end of the menu can reach the page in either order, and
the dialog opens when both arrived.

### The segment of the dialog

The dialog names its segment by its id, from the moment it opens. A change of the current
segment does not change that. At the confirm:

- When no segment has that id, the dialog changes nothing.
- When a change of the clips divided the segment while the dialog was open (ADR 052), the name
  goes to the part that kept the id.

### A rename is an edit

A rename is one edit of the timeline, with one undo step. A rename to the name that the
segment has is no edit. Undo and Redo restore the name with the segment.

### Split, and the parts of a segment

Split gives its two halves the name of the segment. The parts that a change of the clips makes
of a segment (ADR 052) also keep its name.

### Where the name shows

- On the bar of the segment, after the number, when the bar has room for it. The bar cuts a
  name that is too long.
- In the title of the segment tooltip, after the number.
- In the accessible name of the segment.

### The project document

`SequenceSegment` and the Rust `Segment` of the project file get the optional field `name`.
A segment with no name has no such field in the file, and the loader refuses `null`. The Rust
code that reads a document and the Rust code that writes one use the same check, and they
refuse a name that is not valid. The schema version stays 1, because no released version
writes a project file (ADR 010).

## Consequences

- A name lasts as long as its segment: for the session, until a version saves the project.
- The numbers stay. A name does not replace `#N`, because the number gives the export order.
- `F2` is a new named key of the key table. On a Mac keyboard whose function keys control the
  hardware, the user presses `fn` with it, or uses the menu item.
- A name has no effect on an export until a later record uses it.
