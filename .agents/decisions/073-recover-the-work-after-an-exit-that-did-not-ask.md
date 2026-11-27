# 073. Recover the work after an exit that did not ask

- Status: Accepted
- Date: 2026-11-27
- Deciders: capric98
- Amends: ADR 027, ADR 072

## Context

ADR 072 gives the session a project that the user saves with an action. It asks before a quit
drops changes that are not saved (ADR 027). Some exits cannot ask:

- a crash of the application or of the system
- a process that the system or the user ends
- the Dock Quit of macOS, a logout, and the end of the Windows session. They raise only
  `RunEvent::Exit`, which no dialog can stop (ADR 027).

Each of them loses the changes that are not saved. ADR 072 left this part to a later record.

The user chose these points:

- QuipClip writes a recovery file a short time after each edit. The file is in the application
  data directory, and not next to the project file.
- After an exit that did not ask, the next start asks whether to restore the work.
- A quit that the user confirmed leaves no recovery file.
- The work of a project with no file can be recovered too.

Two processes of QuipClip can run at the same time (ADR 013). A start must not offer the work
of a process that still runs, and two processes must not restore one file.

## Decision

### One process owns the recovery

The directory `recovery` in the application data directory holds the files of this record. The
settings file is in the same data directory (ADR 013).

The file `owner.lock` in that directory is never removed. A process is the **owner** while it
holds an exclusive lock of the system on that file, through one handle that it keeps. The
system releases the lock when the process ends, in each way.

- A process tries to take the lock, with no wait, at the start of each command of this record
  that uses the directory, until it is the owner. It then stays the owner until it ends.
- Only the owner reads, writes, renames or removes a file of the directory. A process that is
  not the owner has no recovery: its commands change nothing and say so in their answer.

So no file of the directory has two processes that use it. Inside the owner, one lock of the
backend puts the commands of this record in an order: one command runs at a time.

The owner has these files:

- `current.json`, the **recovery file** of its session.
- `offer-<id>.json`, the **offers**: recovery files of sessions that ended with no confirmed
  quit. `<id>` is 16 lowercase hexadecimal digits that the backend makes new for each offer.

A recovery file is a JSON document:

```jsonc
{
  "recoveryVersion": 1,
  // The canonical path of the project file of the session, or else its proposed path, or null.
  "projectPath": "/Users/me/Cuts/Stream.qcproj",
  // The document of ADR 072, as a save makes it, with no `relPath`.
  "project": { "schemaVersion": 1, "sources": [], "clips": [], "segments": [] },
}
```

The backend validates `project` with the rules of a project file (ADR 010, ADR 072). The size
limit of a project file applies to `project` with the measure of a save, so a document that a
save accepts is never refused here. The backend writes the recovery file with no indentation,
and a read accepts a file of the size limit of a project file plus 64 KiB. The backend writes
the file as a save writes a project file (ADR 015).

### The session of a page

The backend counts the **recovery sessions**. A new session starts each time a page of the
main window starts to load (the hook that ADR 046 uses). The session has a **token**.

- `start_recovery` answers with the token of the session. It reads no file, so it cannot fail
  for a reason of the directory. Each other command of this record carries the token, and
  `confirm_quit` carries it too. A command with another token changes nothing. So a late
  command of an earlier page, as after a reload of the web view, has no effect.
- The backend notes, with each `current.json` that it writes, the token of the command that
  wrote it. The hook of the page load does not wait for a command that runs, so a note for
  "the session now" would be wrong when a write of the earlier page ends after the hook.
- When a command of the owner finds a `current.json` that no command with its own token
  wrote, the file is the work of an earlier page or of a process that ended. The backend then
  gives it the name of a new offer, before each other step of the command. When that rename
  fails, the command changes nothing more and says so in its answer.

### The line of the recovery commands

The page sends the commands of this record one after another: one command runs at a time, and
the next starts after the answer. This is the **recovery line** of the page.

`write_recovery`, `clear_recovery` and `finish_restore` answer with two facts, also when they
failed: whether the process is the owner, and what `current.json` holds after the command: the
state that this command wrote, nothing, or not known. "Not known" is the answer when a step
failed and the backend cannot say what the file holds, and the answer of a process that is not
the owner. The page keeps the last such answer as the **written state**. At the start it is
"nothing". The rename of a `current.json` to an offer (see above) is never the rename of a
file of the token of the page, so no other command changes the written state.

### When the page writes the file

The **recovery state** of the session is one of these two:

- **Nothing to recover**: the project has no changes to save (ADR 072).
- **Work to recover**: the project has changes to save. The state is then the content of the
  project and one path: the path of its file, or else its proposed path (see "The restore"),
  or no path.

So a project with a file that is not modified has no recovery file. A sequence with clips, no
segment and no project file has none either, as ADR 027 asks nothing about it.

The page follows the recovery state from the answer of `start_recovery`. It **compares** the
recovery state with the written state. The two differ when they are not equal, and always when
the written state is "not known".

The page keeps the written state equal to the recovery state with one entry of the recovery
line, the **sync**. One sync waits in the line at most. A sync holds no state. When the line
reaches it, the page compares at that moment and sends one command for the recovery state
then, or no command when the states do not differ:

- "Nothing to recover": `clear_recovery`.
- "Work to recover": the page makes the document as a save does (ADR 072, "Save", steps 1
  and 2) and sends `write_recovery` with the document and the path. When it cannot make the
  document, the state is a refused state (rule 3), and the page sends `clear_recovery` in the
  same sync when the written state is not "nothing".

So no command carries a state that is older than its start. A save, an Undo or a restore that
came while the sync waited decides what the sync sends.

The page compares at the answer of `start_recovery`, after each change of the recovery state,
and after each answer of the line. When the states differ and no wait of rule 4 runs:

1. For "nothing to recover", the page puts a sync in the line with no wait. A save thus
   removes the recovery file directly after its write.
2. For "work to recover", the page starts a wait of 1 second when none runs. At the end of the
   wait it puts a sync in the line.
3. A state for which the page cannot make the document is a **refused state**. One such case
   exists: a clip whose length only the web view gave, next to another clip (ADR 072). A state
   whose document the backend refuses, by a rule of the document or by the size limit, is a
   refused state too. The backend then removes `current.json` itself, and it answers with
   "nothing", or with "not known" when the removal failed. A refused state must have no
   recovery file: an old file would give back another state than the session has. While the
   recovery state is equal to the last refused state, the page takes it as "nothing to
   recover" in each rule of this section.
4. When a command fails for another reason, or the process is not the owner, the page waits
   and then puts a sync in the line: 2 seconds after the first such answer, then 4, 8 and 16
   seconds, then 30 seconds each time. A command that succeeds ends this series. So a write
   that failed, a clear that failed, and the work of a process that becomes the owner later
   need no new edit.

### A quit that the user confirmed

The quit of ADR 072 gets one more step. Before the quit guard reads the losses for the last
time, it waits until the recovery line is empty, for 2 seconds at most. A wait of the page
between two commands is not in the line, so only a command that runs or that is next can hold
the quit. The quit guard then reads the losses, and it calls `confirm_quit` in the same step,
with no wait between the two. So a change that came during the wait is in that last read.
From that call, the page puts no more command in the line.

`confirm_quit` (ADR 027) carries the token. With the token of the session, the backend does
this:

1. It ends the recovery of the session at once, with no wait for a command that runs. Each
   later command of this record changes nothing. A write that runs then does not give its
   file the name `current.json` when it reaches that step after this moment.
2. It removes `current.json` when a command with that token wrote it. For the wait for a
   command that runs, and for a removal that the system refuses and that it tries again, it
   has 1 second in all.
3. It ends the application as before, also when step 2 did not remove the file in that time.

So a quit with "Don't Save" leaves no recovery file. The quit guard calls `confirm_quit` only
after the user had the question of ADR 072, or when nothing would be lost.

A `confirm_quit` with no token, or with another token, removes nothing, and it ends the
application as before: the user confirmed the quit, or nothing would be lost. A page that
started again and did not get its token yet thus cannot remove the work of the page before
it.

`RunEvent::Exit` with no confirmed quit removes nothing. So the Dock Quit, a logout and the
end of the Windows session leave `current.json`. The next owner makes it an offer.

### The offers at the start

After `start_recovery`, the page puts `list_recovery_offers` in the line. The backend then
removes each temporary file that a write of `current.json` left: a file of the directory whose
whole name is `.current.json.tmp-`, a number, `-`, and a number, the form that the writer of
ADR 015 gives. It removes no other file that it does not know. It reads and validates each
offer, and it removes an offer that is not a valid recovery file. The answer has:

- whether the process is the owner
- the offers, the newest first: for each its `<id>`, the time of its last write, and its
  `projectPath`
- whether the list is complete. It is not complete when the process is not the owner, or when
  a step failed: the directory could not be read, the rename of a `current.json` failed, or an
  offer could not be read.

While the list is not complete, the page sends the command again: after 2 seconds, and then
each 30 seconds. The lock of a process that ended can stay for some time on Windows, and a
process can become the owner in the middle of its session. A complete list ends this.

The page keeps the **offers to show**, the newest first. Each answer adds the offers that the
page did not get in an earlier answer of this life of the page. An answer removes no offer
from them. The offer of a prompt that shows, or of a restore that runs, is not one of the
offers to show.

The page shows the recovery prompt for the first offer to show. It shows the prompt only
while no other dialog of the window is open and no drag of a trim runs. Otherwise it keeps
the offers and shows the prompt when both ended.

The prompt does not delay the write of the recovery file. The page follows the recovery state
from the answer of `start_recovery`, so work that the user did before the prompt showed has a
recovery file while the prompt shows.

### The recovery prompt

The prompt is a dialog of the main window (ADR 031). It names the project file of the offer,
or it says that the project had no file. It shows the time of the last write of the offer, in
the format of the language of the interface.

- **Restore** is the primary button. The prompt closes, and the restore starts (see "The
  restore").
- **Discard** is the discard button. The page puts `discard_recovery` in the line, and the
  prompt then shows for the next offer to show. When the removal fails, the offer stays for
  the next start, and the prompt still goes to the next offer.
- **Not Now** is the cancel button, and it has the default focus (ADR 031). The offer stays,
  and the next start offers it again.

After "Not Now", and after a restore that changed the session, the page shows no recovery
prompt more in this life of the page, also for an offer that a later answer lists. Those
offers stay for the next start.

A request to quit while the prompt shows runs the quit of ADR 027 above the prompt, with no
other change. The offers stay.

### The restore

The restore is an open of a project (ADR 072, "The open of a project") with these
differences:

- Step 4 reads the offer with `read_recovery`, not `load_project`. The answer has the
  `projectPath` of the offer, the document, and for each source one candidate path, the `path`
  of its entry.
- Each other step before step 8 is the same: the turn in the line of the imports, the save
  prompt when the session has changes to save, the project dialog, the check of each source
  with its expected revision, the files that the user locates, and step 7.
- Step 8 changes the session as an open does, with one difference: **the project has no
  file.** Its saved content is the empty content. So the restored work has changes to save
  when it has a segment, as each project with no file.
- The project keeps the `projectPath` of the offer as its **proposed path**. Save and
  Save As then propose the name and the directory of that path in the save dialog. The
  proposed path goes when the project closes, when a save gives the project a file, and when
  an open or a restore changes the session. It is a part of the recovery state, so a second
  restore proposes it again.
- In step 8 the page puts `finish_restore` in the recovery line, with the `<id>` of the offer.
  When the line reaches it, the page sends it with the recovery state at that moment, as a
  sync does: the document and the path, or nothing. The backend writes `current.json` from it,
  or removes `current.json`, and then removes the offer. So the work has a recovery file with
  no wait of 1 second. A sync holds no state, so no command with an older state comes after
  it.
- "Nothing" in `finish_restore` is only for a session with no changes to save. When the state
  at that moment is a refused state, the page sends no `finish_restore`, and the offer stays.
  When the backend refuses the document, it removes `current.json` and keeps the offer.
- When `finish_restore` fails, its answer says what `current.json` holds, and the page follows
  the recovery state from there. The offer then stays.

When the restore stops before step 8 by an error, by Cancel, or by the save prompt, the offer
stays, and the recovery prompt shows again for the same offer: the user gave no last answer
for that offer yet. When a request to quit stops
the restore (ADR 072), the recovery prompt does not show again in this life of the page. The
offer stays for the next start.

The restore gives the project no file for one reason. The recovery file can be older than the
project file: a save can end directly before the exit, and the removal of the recovery file
does not happen then. A restore that kept the file would let the next `Cmd+S` replace the
newer project file with no question. With no file, the first save shows the save dialog, and
the system asks before it replaces a file.

### Commands and permissions

The backend gets these commands. Only the main window has the permission for them. Each
command is in the command list of the backend (`APP_COMMANDS`), from which `build.rs` makes
the permissions of the application, and in the capability of the main window, as the tests of
`lib.rs` require.

No command takes a path of a recovery file from the page. The backend makes each such path
from the data directory and from an `<id>` that has the form of 16 lowercase hexadecimal
digits. The `projectPath` is a fact of the document, and the backend opens no file with it.

| Command                | What it does                                                                   |
| ---------------------- | ------------------------------------------------------------------------------ |
| `start_recovery`       | Answers with the token of the recovery session of the page.                    |
| `list_recovery_offers` | Removes the temporary files of a write, and lists the valid offers.            |
| `write_recovery`       | Validates the document and writes `current.json`.                              |
| `clear_recovery`       | Removes `current.json` when a command with the token wrote it.                 |
| `read_recovery`        | Reads and validates one offer. Answers with its path, document and candidates. |
| `discard_recovery`     | Removes one offer.                                                             |
| `finish_restore`       | Writes or removes `current.json`, and then removes one offer.                  |

`confirm_quit` gets the token as an optional argument.

Each text of the prompt, and each error that the project dialog shows for a restore, has a
message in each catalog (ADR 011).

## Rejected alternatives

- **A recovery file for each process.** Each process then needs a lock file of its own, and a
  start must test the lock files of the other processes, take a claim on a file before it
  offers it, and remove the lock files that no process holds. Each of these steps has an order
  of events between two processes that loses a file or offers it two times. One owner needs
  one lock that is never removed.
- **A restore that keeps the project file.** See "The restore": the next save could replace a
  newer project file.
- **A quit that waits until the recovery file is removed, or that asks again when the removal
  fails.** The user already answered the question of the quit. The next start can ask about a
  file that stayed.
- **Write the recovery file next to the project file.** A project with no file has no such
  place, and the directory of a project can be read-only or on a share.
- **Write the project file itself after each edit.** ADR 072 rejected it: the file must keep
  the state of the last deliberate save.
- **A restore that starts with no question.** The user chose a question. The offer can also be
  work that the user wanted to drop, when the system ended the process during the quit dialog.
- **Remove the recovery file at each exit that the system reports.** The Dock Quit, a logout
  and the end of the Windows session are the exits that lose work with no question.
- **Keep the history of Undo, the pending In, and the position.** They are not content
  (ADR 072). The recovery file holds what a project file holds.

## Consequences

- The work of a session survives a crash of the application, a process that ends, the Dock
  Quit, a logout and the end of the Windows session. The edits of about the last second can be
  absent: the wait of 1 second, and the time of the commands that run then.
- While the directory refuses a write, the recovery file is older than the session. The page
  tries again, with the waits of this record.
- For a crash of the system or a loss of power, the recovery file is as safe as ADR 015 makes
  a file. The backend writes the data to the disk before it gives the file its name, but a
  file system can still lose the last write. The start then finds the recovery file before
  it, a file that is not valid and that the start removes, or no file.
- **When two processes of QuipClip run, only the owner has a recovery.** The work in the other
  process has no recovery file until the owner ends. The other process then becomes the owner
  with its next command, 30 seconds later at most, and it writes its work then.
- A process that becomes the owner in the middle of its session can show the recovery prompt
  then, for the work of the process that ended.
- A restored project has no file. The first save shows the save dialog with the name and the
  directory of the project file that the work had.
- The recovery file does not hold the pending In, the selection, the position of the playhead
  and the history of Undo.
- A restore checks each source as an open does (ADR 072). A source that changed or that is
  absent needs "Locate…", or the restore stops and the offer stays.
- The recovery state of a project with a file that is modified and has no segment gives a
  recovery file. Its restore gives clips and no segment, which is no work to recover, so
  `finish_restore` then removes the recovery file.
- A sequence that cannot be saved (ADR 072) has no recovery file.
- When the system refuses the removal of `current.json` in a confirmed quit for more than 1
  second, the file stays. A write that the system holds for longer than that can also give
  the file its name after the removal. The next start then offers work that the user chose to
  drop, and the user discards it there.
- After `confirm_quit`, the application still runs for a short time while it stops an export
  (ADR 017). An edit in that time has no recovery file. The user confirmed the quit.
- A `confirm_quit` of a page whose token is not the token of the session still ends the
  application. That can happen only when the web view loads its page again at the moment of a
  confirmed quit. The recovery file then stays, and the next start offers it.
- When the process ends between step 8 of a restore and the end of `finish_restore`, the offer
  stays beside the recovery file of the same work. The next start then offers the work two
  times, and the user discards one.
- An offer stays until the user restores it or discards it. "Not Now" at each start keeps it.
- The recovery files hold paths of videos and of project files, as the settings file holds
  paths (ADR 013). They are in the data directory of the user.
- An offer that a later version of QuipClip wrote, with a document that this version cannot
  validate, is removed at the start.
- `README.md` and `docs/architecture.md` must describe the recovery when the code is in.
