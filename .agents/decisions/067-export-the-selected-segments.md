# 067. Export the selected segments

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 024, ADR 026, ADR 045, ADR 066

## Context

One export writes one file that joins all the segments of the export (ADR 004, ADR 066). The
user who cuts several parts out of a long recording frequently wants a file with one part, or
with some of the parts. To get it, the user had to delete the other segments, export, and undo.

A first design gave one file to each segment from one confirmation of the export dialog. Three
reviews of that design found faults in the names of the files, in the files that exist already,
and in the admission of several runs to the queue and the journal as one step (ADR 049,
ADR 051). The user then chose a smaller action: export only the selected segments, as one
ordinary export. For several files, the user runs the action again. The queue takes a new
export while another export runs (ADR 049), so the user does not wait between two of them.

## Decision

### The scope of an export

An export has a **scope**: the whole export, or a list of segment ids.

- With the whole export, the export takes the segments of the export (ADR 066), as before.
- With a list, the export takes the segments of the export whose id is in the list, in the
  export order. The order of the list has no effect, and the order of the selection has none.

One function gives the segments of a scope, with their pieces. Inside the export dialog and the
export flow, each reader of the segments of the export reads them through that function:

- the checks before the dialog opens: the test for no segments, the limits of the parts and the
  source files (ADR 053), the imported media of the sources, and the revisions of the sources
  (ADR 024)
- the two builders of the request, and the request of the loudness measurement (ADR 061)
- the facts of the setup step: the segment count, the total duration, the sources, the streams,
  the output summary, the size estimate, and the test for the Copy audio switch (ADR 048)

Nothing outside the dialog reads a scope. The numbers of the bars, the segment summary, the
count and the tooltip of the Export button, the readouts of the transport and of the preview,
and the Export Order dialog read the segments of the export, as before.

A list has a **record**: the pieces of each of its segments, read one time, when the action of
this record makes the list. A list is valid only while each of its segments is a segment of
the export and gives the pieces of the record. The export of a list that is not valid sends
nothing. The flow then reports `selectedSegmentsChanged`, an error of the page that the backend
does not send, and the dialog shows it as it shows `noSegments`. The user selects the segments
again. So a list never gives fewer frames, or other frames, than the user selected.

### Which scope a setup step has

The scope goes with each step of the flow. No step reads a scope that another step set later.

- **An action of the user.** The Export action starts an open step with the whole export. The
  action of this record starts an open step with a new list of the selected segments, with its
  record. An open step can wait for a check of the source files. When it shows the setup step,
  or the error of its checks, it sets the scope of that setup step to its own scope. An open
  step that shows nothing sets nothing. Before an open step shows the setup step of a list, or
  the error of a check, it tests that the list is valid. When the list is not valid, it shows
  `selectedSegmentsChanged`.
- **The answer "Export anyway" (ADR 024).** It closes the setup step and opens it again for the
  same export. The scope stays.
- **The confirm step.** It reads the scope of the setup step one time, when the user confirms.
  It uses that scope for each thing that it does afterward: the default name, the save dialog,
  the request, and the answer to the request. For a list, it tests that the list is valid
  before it opens the save dialog, and again after the save dialog closes. The step does such a
  test for the effective audio streams already (ADR 070).
- **The answer to the request.** Each answer keeps the scope of its request, with the record of
  a list. A run that the queue takes keeps it with the id of the run, and the page keeps it for
  the runs that the dialog can show. A refusal of the queue, and a failure of the start that
  has no run id, keep it with that failure, in the store that holds the failure. The refusal
  can arrive after the user left the setup step, and after another action opened another setup
  step (ADR 049). It does not change the scope of a setup step that shows.
- **Back from a result or a failure of a request.** The Back control reads the scope that the
  result or the failure keeps, before it resets it. The scope of the setup step becomes that
  scope, from the moment of the press. A list keeps its record, so the user can change the
  timeline while a run is in the background, and Back then shows `selectedSegmentsChanged`
  when the list is no longer valid. A run with no kept scope, such as a run from before the
  page loaded again (ADR 051), has the whole export as its scope.
- **Back from the error of an open step.** The scope stays. That open step set it.
- **The dialog hides or closes, or the user cancels the save dialog.** The scope stays.

A request is complete when the queue takes it. The scope has no effect on a run.

### The action

A new action, Export Selected Segments, joins the actions of the key table (ADR 026). It has no
binding: no key runs it, and it has no accelerator, no key in a tooltip and no
`aria-keyshortcuts` value. The plan and the run of the action are those of the key table, as
for each other action.

- It is available when the Export action is available, one or more segments are selected
  (ADR 045), and no import runs. An import that ends can insert a clip and split a segment
  (ADR 052), which would change what a list names.
- It does nothing while a drag trims the edge of a segment, and while a press on an edge is
  armed (ADR 030), as Rename and Export Order.
- It opens the export dialog on the setup step, as the Export action does, with the list of the
  selected segments as the setup scope. While a run is active or waits, that setup step is the
  step of a new export for the queue (ADR 049).

The context menu of a segment gets an item for the action, directly after "Rename…".

- In the menu of one segment, the label is "Export Segment…".
- In the menu of a selection of several segments, the label is "Export N Segments…", with the
  number of the segments. The item acts on that selection. After Delete, it is the second
  action that acts on several segments.
- The item names the segment, or the exact selection, of its menu. It opens the dialog after
  the menu closes, as "Rename…" does (ADR 065). At that moment it plans the action again, and
  it runs only when the plan is the kind that the item showed and the selection is still the
  one that the menu named.

### What the setup step shows

Each part of the step shows the facts of the setup scope.

For a list, the step shows one more line. It says that the export takes only the selected
segments, and it gives the number of the segments of the scope and the number of the segments
of the export.

The sentence of the step names a source file. For a list, that is the file that the pieces of
the scope read, when they read one file. When they read several files, the sentence names no
file. For the whole export, the sentence is as before.

The size estimate reads the exact duration of the segments of the scope that have a place on
the timeline, as it reads the segments of the whole export.

The Copy audio switch is available for a scope that passes its test (ADR 048, ADR 053). So a
scope of one segment with one piece can copy its audio, also when the timeline has more
segments.

### The default name of the file

The save dialog of an export proposes the name `<source name>_export.<extension>` (ADR 024).
When a list gives exactly one segment, the save dialog proposes one of these names:

```text
<source name>_<number>.<extension>
<source name>_<number> <name>.<extension>
```

- `<source name>` is the name of the file that the first piece of the segment reads, without
  its extension. It is the name of a file that exists, and it is not changed, as in the name of
  the whole export.
- `<number>` is the number of the segment among all the segments of the export, as its bar
  shows it (ADR 066). It has a leading zero below 10.
- `<name>` is the name of the segment (ADR 065) with these changes. Each of the characters
  `\ / : * ? " < > |` and each control character becomes `_`. The name part is then cut at the
  end, at a character, so that the whole file name has no more than 200 bytes in UTF-8. Spaces
  and full stops at the end of the name part are then removed.
- The name has no name part, and no space in front of it, in these cases: the segment has no
  name, the name part is empty after the changes, or the name without a name part has 200 bytes
  or more already.

For the whole export, and for a list that gives two or more segments, the name is as before.
The name is only a proposal. The user can change it, and the save dialog asks before a file is
replaced.

## Consequences

- A file for each of N segments takes N runs of the action and N save dialogs. No action writes
  several files from one confirmation.
- The export of a scope is an ordinary request. The backend, the queue, the journal and the
  wire contract do not change.
- An action can have no binding. The tests of the key table then require a binding for each
  action but those that the table names as actions with no binding.
- The macOS File menu gets no item for the action, because its items do not follow the
  selection.
- The scope decides which pieces the loudness measurement measures. The identity of that audio
  decides which kept result applies (ADR 061). When a list gives each segment of the export,
  it can use a kept result of the whole export, if the identity of the audio is the same.
- After the page loads again, Back from the result of an earlier run opens the setup step of
  the whole export, also when that run had a list. The step shows no line for selected
  segments then, and it counts all the segments.
- The default name of a list of several segments is the name of the whole export. The save
  dialog asks before it replaces that file.
- While an import runs, the item of the menu is disabled.
- A change of a selected segment between the action and the request stops that export with an
  error. The dialog is modal, so such a change comes only from an import that ends, or from an
  edit while an open step waits for its checks.
- The rule that one open step runs at a time for a source, and what it does to a Back that
  starts while another open step waits, are as before. This record does not change them. The
  open step that waits can check other files than the files of the scope of that Back. When
  the rule declines the checks of that Back, the preparation of the run still checks the
  revisions that the request carries.
- After an edit of a selected segment while its run is in the background, Back from the result
  of that run shows `selectedSegmentsChanged`, and the user selects the segments again.
