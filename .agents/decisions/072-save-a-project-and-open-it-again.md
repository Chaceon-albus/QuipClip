# 072. Save a project and open it again

- Status: Accepted
- Date: 2026-11-26
- Deciders: capric98
- Amends: ADR 010, ADR 020, ADR 024, ADR 026, ADR 027, ADR 038, ADR 052, ADR 058, ADR 070
- Amended by: ADR 073

## Context

Version 1 writes no project file (ADR 010). The segments last for one session. ADR 027 asks
before a quit that loses them, but each quit still ends the work. The user cuts long
recordings and marks tens of segments in one of them. A quit, a crash or a restart then costs
all of that work.

The format of the project file, its validation and its atomic write exist in the backend
(ADR 010). The commands `load_project` and `save_project` are registered, and nothing calls
them. The page has no function that makes a document from the sequence, and none that puts a
document on the sequence. Three more parts did not exist:

- The document needs `renderSettings` and `relPath`. No part of the application can give
  either value.
- A source gets its identifier, its permission for the web view and its FLV fingerprint from
  the import of its session (ADR 052, ADR 058). A new session has none of them.
- Nothing knows whether the sequence changed after a save.

The user chose these points:

- A save is an action of the user. `Cmd+S` on macOS and `Ctrl+S` on Windows save. "Save As…"
  has no key, because that key with `Shift` is Export Frame (ADR 069). The title shows the name
  of the project and a mark for changes that are not saved. QuipClip asks before it drops such
  changes. It does not write each edit into the project file.
- The open of a project is strict. Each video must be the revision that the project saved
  (ADR 010). An FLV that a recorder wrote further opens as the part that the project saved
  (ADR 058). For each other file, the user locates the file, or the open stops. QuipClip does
  not open a project on a file that changed, and it does not open a project with a file that
  is absent.
- One Open action takes videos and project files. A video joins the sequence, as before. A
  project replaces the sequence.
- QuipClip will get back the work after an exit that did not ask. A later record gives that
  part.

## Decision

### The project of the session

The session has one **project**. The project has a file, or it has no file. At the start, the
project has no file and the sequence is empty.

The **content** of the project is:

- the clips of the sequence, in sequence order (ADR 052)
- the segments whose clips are on the sequence, in the export order, each with its two edit
  points and its name (ADR 065, ADR 066)
- for each source that a clip names, the audio stream that the user chose (ADR 070)

These are not content: the pending In, the selection, the position of the playhead, the zoom,
the clip that the preview shows, and the history of Undo.

The project has a **saved content**: the content that the last save wrote, or that the last
open read. The saved content of a project with no file is the empty content.

The project is **modified** when its content is not equal to its saved content. The comparison
is by value. So an Undo that goes back to the saved content makes the project not modified. A
project is also modified from an open in which the user located a file at another path until
the next save (see "The files that the user locates").

**The project has a file only while the sequence has one or more clips.** Each change that
leaves the sequence with no clip closes the project: the project then has no file, and its
saved content is the empty content. Clear Timeline, the removal of the last clip, an Undo and
a Redo can each do that. A later change that puts a clip on the sequence does not give the
file back. This rule has one reason. Without it, a user who empties the sequence of the
project of one recording, and then marks the next recording, replaces the file of the first
project with one press of `Cmd+S`.

The project has an **identity**. The identity changes each time the project closes, and each
time an open changes the session. A step that waits for a file or for a dialog notes the
identity when it starts, and it changes the project afterward only when the identity is still
the same.

Undo and Redo are available while the sequence has no clip, when the history has an entry for
them (ADR 026). Before this record they needed a video in the preview, so Undo did not work
after Clear Timeline.

The project has **changes to save** in these two cases:

- It has a file, and it is modified.
- It has no file, and the sequence has one or more segments. This is the test of ADR 027.

### The document

The document of ADR 010 changes before a build writes it for the first time. The schema
version stays 1, because no build wrote a file.

- `renderSettings` goes. No part of the application has such a setting. The presets hold the
  settings of the output (ADR 013).
- `relPath` of a source is optional. The backend writes it at each save. The page does not
  send it. It is a relative path with `/` between its parts. The loader refuses a `relPath`
  that has a root or a drive.
- A source can have `fingerprint`, the fingerprint of an FLV (ADR 058):

  ```jsonc
  "fingerprint": { "start": "1048576", "fnv1a64": "9f3c5a7714e0b2d1" }
  ```

  `start` is a canonical decimal string. It is not negative, it is smaller than `size`, and
  `size` less `start` is 65536 at most. `fnv1a64` is 16 lowercase hexadecimal digits. The
  loader refuses each other form.

A save writes these lists:

- `sources`: one entry for each source that a clip of the sequence names. The entry has the
  facts of the import of that source: the path, the size, the modification time, the facts of
  the video stream, and the fingerprint when the import kept one. It has `audioStreamIndex`
  when the user chose a stream.
- `clips`: the clips of the sequence, in sequence order.
- `segments`: the segments whose clips are on the sequence, in the export order.

Each `id` in a document is a name inside the document only. An open gives each source the
identifier that the session has for its revision (ADR 052). That is a new identifier when the
session did not import the revision before. An open makes a new identifier for each clip and
for each segment. So an identifier of a clip is never used again (ADR 052), also when the same
project opens two times in one session. No part of the session that holds the identifier of a
clip or of a segment from before the open finds it after the open.

### Save

The key table gets two actions, **Save** and **Save As…**.

- Save writes the file of the project. For a project with no file, it does what Save As does.
- Save As opens the save dialog of the system, with the filter of project files. For a project
  with a file, the dialog proposes the name of that file. For a project with no file, it
  proposes the name of the file of the first clip, with the extension `.qcproj`.
- The name of a project file ends in `.qcproj`. The test ignores the letter case. For a name
  with another end, the step writes nothing and shows an error.

A save step does this:

1. It reads the content and the identity of the project one time. Save As reads them after the
   save dialog closes.
2. It tests the document with the tests of an open (see "The open of a project", step 4). A
   document that fails writes nothing, and a dialog shows the error. One such case exists
   today. The sequence can hold a clip whose length only the web view gave, next to another
   clip (ADR 052). The document has no length from the web view, so an open cannot put that
   sequence together. The error names the file of that clip.
3. It sends the document and the path to `save_project`. The backend validates the document,
   writes the `relPath` of each source, and replaces the file as one step (ADR 010, ADR 015).
   It answers with the canonical path of the file.
4. When the write succeeded, and the identity of the project is still that of step 1, the
   project has that file. Its saved content is the content that step 1 read. So a change of the
   sequence during the write leaves the project modified. When the identity changed, the file
   is written, and the project of the session does not change: the sequence was empty in the
   meantime, or an open changed the session.
5. When the write failed, the project does not change. A dialog shows the error.

One save step runs at a time. A request for Save or Save As while a step runs does nothing. A
quit, the open of a project and Clear Timeline wait for the save step that runs, and then they
test the project.

The backend makes `relPath` from the directory of the project file to the path of the source.
It joins the parts of the path with `/`, with `..` for each step to a parent directory. The
entry has a `relPath` when the two paths have the same root. On Windows, that is the same
drive or the same share. Otherwise the entry has none.

Save and Save As are available when the sequence has one or more clips. They do nothing while
a dialog of the window is open, while a drag trims the edge of a segment, and while a press on
an edge is armed (ADR 030), as Rename.

### One Open action

The Open action (ADR 026) takes videos and project files. Its file dialog lists both kinds,
and its label is "Open…". A file whose name ends in `.qcproj` is a project file. The test
ignores the letter case. The dialog that adds a video from the export dialog (ADR 024) still
lists only videos.

The action first gets the files: from the file dialog of the system, or from a drop. Only
then does it decide what it does:

- No project file: the action imports the videos, as before (ADR 052). A file that is not a
  video is left out, as before.
- One project file and no other project file and no video: the action opens that project.
- Each other set that has a project file: the action opens nothing, and it shows a message.
  The message says that a project file opens alone.

The action gives all the files of one file dialog to the line of the imports as one request,
as a drop does. So no other request comes between two files of one dialog.

A drop of a project file does not use the place of the pointer. The conditions that stop a
drop do not change. A request for videos that waited in the line behind the open of a project
adds its clips at the end of the new sequence, whatever place its drop had.

When an import gives a revision that the session has as a source already, the facts of that
source do not change (ADR 052). So an import after an open does not replace the end that the
open gave to an FLV (see "The check of a source").

### The open of a project

The step starts when the action has the path of one project file.

1. The step waits for its turn in the line of the imports (ADR 052). The imports run one after
   another, and a later import waits for the end of this step.
2. The step waits for a save step that runs. When another dialog of the window is open then,
   the step stops with no change. Otherwise it makes an open step of the export that waits
   stale: that step then opens no dialog and reports nothing (ADR 024). Then, when the project
   has changes to save, the step asks (see "Before the content is dropped").
3. The step shows the **project dialog**, a dialog of the application. The dialog is modal, so
   no action of the user changes the sequence while it shows. It shows the progress of the
   step, the files to locate, and each error.
4. `load_project` reads and validates the file (ADR 010). It answers with the canonical path of
   the file, the document, and the candidate paths of each source: the `relPath` from the
   directory of the project file when the entry has one, and then the `path`. The page then
   tests the document with the rules of the sequence that the backend does not test (ADR 052).
   No test reads a length from the web view. A document that fails a test does not open, and
   the dialog shows the error.
5. The step checks each source that a clip names, one after another (see "The check of a
   source"). It does not read a source that no clip names.
6. When a source is not found, the dialog lists the files to locate, and the step waits for
   the user.
7. When each source is found, the step compares each file with its expected revision again,
   with no probe. `read_source_revision` gets the optional argument of `import_media` for
   this, and it gives the same verdict (see "The check of a source"). A file that is absent,
   that cannot be read, or that is another file is not found, and the step goes back to 6.
   The step then tests the sequence that step 8 would make, with the facts that the sources
   have in this session, by the rules of step 4. When that test fails, the step does not
   change the session, and the dialog shows the error. A new probe can give another length
   than the entry has, and the layout of the sequence reads that length (ADR 052).
8. The step changes the session (see "What the open changes").

Until step 8, the step changes nothing of the sequence, of the project and of the title.
Cancel of the dialog stops the step at each moment before step 8. A save that the prompt of
step 2 ran stays: the project then has the file of that save.

A request to quit (ADR 027) while the step is before step 8 stops the step first, as Cancel
does. Then the quit tests the project. So the quit dialog and the open never hold two
different projects.

### The check of a source

`import_media` gets an optional argument: the revision that the caller expects. It is the
size, the modification time, and the fingerprint when the document has one. The answer of the
command gets the fingerprint that the import kept, so a save can write it.

With an expected revision, the command compares the file with it before the probe. When the
revision has a fingerprint, the command reads the fingerprint of the first `size` bytes of the
file itself, as an import does (ADR 058), with the size of the revision. The two fingerprints
are equal when their `start` values and their hashes are equal.

| Verdict | Condition                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same    | The size and the modification time are those of the revision. When the revision has a fingerprint, the two fingerprints are also equal.              |
| Grown   | The revision has a fingerprint. The size is not smaller. The modification time is not earlier. The two fingerprints are equal.                       |
| Other   | Each other case. The command answers with the error `revisionMismatch`. It runs no probe, and it gives the web view no permission to read the file. |

For `Same`, the import continues as before. For `Grown`, the import reads the file as its
first `size` bytes, with the size of the expected revision:

- The probe stops at that size where a probe can (ADR 058).
- The probe must name `flv`. Otherwise the command answers with `revisionMismatch`.
- The answer carries the size and the modification time of the expected revision.
- The process keeps the fingerprint for that revision, as an import does.

So the source of a recording that grew is the revision that the project saved. Each later
check of the session accepts the file as ADR 058 states.

A file **reads as the entry says** when its `videoStreamIndex`, its `videoTimeBase` and its
`videoStartPts` are equal to those of the entry, and this rule for `videoEndPts` holds:

- For an entry with no fingerprint, the `videoEndPts` is equal to that of the entry.
- For an entry with a fingerprint, the session takes the `videoEndPts` of the entry, and the
  value of the new probe has no effect. The end of an FLV is the time of its last frame in the
  revision plus a nominal frame interval (ADR 052). The rate for that interval comes from the
  head of the file, and a part of the probe can read past the size of the revision. A file
  that grew, or whose recorder wrote its metadata again, can thus give another end for the
  same revision. The end that the import of the saved revision gave is the end of that
  revision.

When the entry has `audioStreamIndex`, the probe must also have an audio stream with that
index that the user can choose (ADR 070). Each other fact of the source in the session is the
fact of the new probe, such as the approximate length that the preview uses.

For each source, the page tries the candidate paths in order. Each candidate gives one of
these results:

- **It holds.** The import succeeded, and the file reads as the entry says.
- **It is absent.** The path names no file. That is each of the errors `pathNotFound`,
  `pathNotFile` and `invalidPath` of the import. A path that names a directory is such a case.
- **It is another file.** The command answered with `revisionMismatch`.
- **It cannot be used.** The import failed with another error, or the file does not read as
  the entry says.

The first candidate that holds is the file of the source, and the source is found. Otherwise
the source is not found. Its reason is the result of the first candidate that is not absent.
When each candidate is absent, the reason is that the file is absent.

Two entries can give the same revision of the same file. The session has one source for that
revision (ADR 052), so the open gives both entries that source. The two entries must then be
equal in each field but `id`, `path` and `relPath`. Otherwise the document does not open, and
the dialog shows the error.

### The files that the user locates

For the sources that are not found, the project dialog shows a list. Each row has the name of
the file, the path that the document has, and the reason: the file is absent, the file
changed, or the file cannot be used, with its error.

- "Locate…" in a row opens the file dialog of the system for one file. The step checks that
  file as a candidate of the row. Each row has this action, whatever its reason is.
- When the file holds, the row is found. The step then tries, for each other row that is not
  found, the file with the name of that row in the directory of the located file.
- When the file does not hold, the row stays, and it shows the result of that file.
- The Open button of the dialog is available when each source is found. Cancel stops the
  step, and nothing changes.

A file from "Locate…", or from the directory of a located file, can have another path than
the `path` of its entry. The open then makes the project modified, and the next save writes
the new path. A file that a candidate of the document gave does not make the project
modified, also when the `relPath` gave it at a new place.

### What the open changes

Step 8 changes the session as one step:

- The playback stops, and each seek that waits is dropped.
- The sequence gets the clips and the segments of the document, with new identifiers. Each clip
  names the source of its file in this session. The history of Undo is empty. The sequence has
  no pending In and no selection. The preview shows the first clip, paused at the start of the
  sequence. That is also true when the preview showed the same file before the open: it then
  shows the first frame. Each reader that follows the audio choice of a source (ADR 070)
  reads the choice of the document. A document with no clip gives an empty sequence, and the
  preview shows no clip.
- The sources of the session are the sources of the document. The audio choices are those of
  the document. The choices of the sources that left go with them.
- When the sequence has a clip, the project has the file of the document. Its saved content is
  its content after this step. A document with no clip leaves a project with no file. The
  identity of the project changes.
- The exports that run or wait do not change. Each of them holds its own request (ADR 049).

The check of a source that held gave the web view the permission to read its file, and the
process keeps its fingerprint, as after each import. Both stay also when the user cancels.

### Before the content is dropped

Three actions drop the content of the project: a quit, the open of a project, and Clear
Timeline. Each of them can show the **save prompt**. The prompt names the file of the project,
or it says that the project has no file. It has three buttons (ADR 031):

- **Save** is the primary button. It runs a save step. The prompt runs the step itself, so the
  conditions of the Save action do not apply. When the write fails, or the user cancels the
  save dialog, the action stops. When the write succeeds, the action tests the project again.
  With no changes to save, the action continues. Otherwise the prompt shows again, because an
  edit or an import that ended during the write changed the content.
- **Don't Save** is the discard button. The action continues.
- **Cancel** stops the action. It has the default focus, as in each dialog that asks before
  work is lost (ADR 031).

The three actions use the prompt in this way:

- **The open of a project** shows the prompt when the project has changes to save.
- **A quit** (ADR 027). The test "one or more segments" becomes "the project has changes to
  save". When the project has changes to save, the quit dialog is the save prompt. It also
  lists each other loss of ADR 027: the pending In, the exports and the preset draft. When the
  project has no changes to save, the quit dialog is as before. In each form, when the user
  confirms, the quit reads the losses again before it ends the application. When a loss exists
  then that the dialog did not list, the dialog shows again with the new list. An import that
  ended, or a preset draft of the Settings window, can add such a loss while the dialog shows
  or while Save writes.
- **Clear Timeline** (ADR 052) empties the sequence, so it closes the project. When the project
  has a file and is modified, the action shows the save prompt. Otherwise, when the sequence
  has segments, it asks as before. Clear Timeline stays one edit. Undo brings the clips and
  the segments back, but not the file.

Each other change that closes the project asks nothing: the removal of the last clip, an Undo
and a Redo. Each of them is one edit, and the history can take it back. The content then
belongs to a project with no file.

### The name in the title

- When the project has a file, the centre of the title bar shows the name of the project file
  in front of the name of the video (ADR 020). A modified project has a dot in front of the
  name of the project file. The accessible name of the title then says that the project has
  changes that are not saved.
- The title of the window for the system is the name of the project file and then
  ` — QuipClip`, with `• ` in front for a modified project.
- For a project with no file, both titles are as before.

### Menus, keys and permissions

- The key table gets Save on `primary` with `S`. A repeated key press is taken and does
  nothing. Save As has no binding (ADR 067).
- The File menu of macOS and the File menu of the title bar get "Save" and "Save As…" after
  the Open item. The Open item has the label "Open…" in both menus.
- The main window gets the permission for `load_project` and `save_project`. No other window
  gets it. ADR 038 gave these two commands to no window.
- Each error of the two commands, and `revisionMismatch`, has a message in each catalog
  (ADR 011). The project dialog shows the errors of an open. A save that fails shows a dialog
  of its own.

## Rejected alternatives

- **Write each edit into the project file.** The user chose a save that is an action. A file
  that follows each edit cannot keep the state of the last deliberate save.
- **"Open anyway" for a file that changed.** The edit points are PTS values of one revision
  (ADR 002). On another revision they can name other frames, and the next export would cut
  them with no warning.
- **A clip with no file on the sequence.** The preview, the envelope and the export would each
  need a state for a source that cannot be read.
- **The identifiers of the document as the identifiers of the session.** A session can hold
  another identifier for the same revision already. A part of the session that waits for a
  clip, such as a seek, would also find a clip of the old sequence in the new one.
- **Keep the file of the project while the sequence is empty.** Then Redo of Clear Timeline
  after a save, or the removal of each clip one by one, leaves a file that the next `Cmd+S`
  replaces with other work.
- **A separate "Open Project…" item.** The user chose one Open action.
- **A hash of all the bytes of each file.** A recording has tens of gigabytes, so each open
  would read for minutes. This record keeps the revision of ADR 010 and the fingerprint of
  ADR 058.
- **A test of the file on disk before each Save.** It would stop a save over a project file
  that another program wrote meanwhile. This record does not add it.

## Consequences

- QuipClip can save the work of a session and open it again. `README.md` and
  `docs/architecture.md` must say so when the code is in.
- The check of a source does not read all the bytes of a file. It is the revision of ADR 010
  and, for an FLV, the fingerprint of ADR 058, with their limits. A file that another file
  replaced with the same size and the same modification time passes when it reads as the entry
  says. An FLV whose earlier bytes changed passes when the bytes of its fingerprint did not
  change. One session has the same limits today.
- A file can change between its check and the probe of the same import, and after step 7 of an
  open. Each later reader of the session compares the revision again, as after each import
  (ADR 046, ADR 024, ADR 058).
- A file that is not an FLV cannot open after its modification time changed, also when its
  bytes are the same. A copy with a tool that does not keep the times gives such a file.
- An MPEG-TS or a Matroska recording that grew after the save cannot open, as it cannot stay
  open in one session (ADR 058).
- An FLV that grew opens with the length that the project saved. To get the later part, the
  user opens the file again, as in one session (ADR 058).
- The fingerprint of an FLV is now also in the project file. `import_media` gets one argument
  and its answer gets one field, which ADR 058 did not need. The process still keeps 256
  fingerprints at most (ADR 058), and the checks of an open count as imports there. As each
  import, a check replaces the fingerprint that the process keeps for the same path, size and
  modification time.
- An installation whose FFmpeg reads another stream index, another time base or another start
  of a video than the installation that saved cannot open the project. For a file that is not
  an FLV, that is also true for another end.
- Each open imports each source of the project again, with one probe for each. The project
  dialog shows during that time.
- The identifiers of the clips and of the segments change with each open. The identifier of a
  source is that of the session for its revision. So a save after an open writes other
  identifiers than the file had.
- The quit reads the preset draft from the mirror of the main window (ADR 038). The Settings
  window sends each change of the draft as an event. So a draft that started directly before
  the user confirmed the quit dialog can be absent from the second read of the losses, as
  from the first read before this record.
- A project with more than 256 FLV files that grew opens, but the process then keeps the
  fingerprints of only 256 of them (ADR 058). The readers of the session refuse the others
  when they grew, until the user opens fewer of them.
- Save writes the file of the project with no test of what that file holds now. When a second
  QuipClip, or another program, wrote the same path after the last open or save, its content
  is lost. Between the save dialog and the write of Save As, another program can also make a
  file with the chosen name, and the write replaces it.
- A sequence in which a clip has its length only from the web view, next to another clip,
  cannot be saved.
- A quit with a saved project that is not modified asks nothing about its segments.
- (Changed on 2026-11-27.) A quit, the open of a project and Clear Timeline wait for a save
  step that runs, with no dialog for the wait. A request to quit stops an open that waits. A
  write that the system holds, as on a network drive that does not answer, can hold these
  actions until the write ends.
- (Changed on 2026-11-27.) From the moment the quit guard gets the path of a project file
  until that open ends, Clear Timeline and each other Open request do nothing. The open first
  waits for a trim that the user released and that did not commit yet. It stops with no change
  when a drag trims a segment edge, or a press on an edge is armed, at the moment of its test
  for another dialog.
- After the sequence was empty, the project has no file. `Cmd+S` then asks for a new file when
  a clip is on the sequence again, also after an Undo. Save is not available while the
  sequence is empty, so no save writes a document with no clip.
- The pending In is not in the file. The quit dialog still names it (ADR 027).
- The Dock Quit, a logout and the end of the Windows session cannot ask (ADR 027). They still
  lose the changes that are not saved, until the record for the recovery.

  (Changed on 2026-11-27.) ADR 073 is that record. QuipClip writes a recovery file, and the
  next start offers it. A restore is an open that reads its document from a recovery file. It
  leaves the project with no file and with a proposed path: Save and Save As propose the name
  and the directory of that path in the save dialog.
- A double-click on a project file in the file manager does not open it. QuipClip registers no
  file type. It also keeps no list of the last projects.
