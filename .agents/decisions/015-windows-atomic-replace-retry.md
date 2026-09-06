# 015. Replace a file on Windows through a layered rename

- Status: Accepted
- Date: 2026-09-05
- Deciders: capric98

## Context

ADR 010 introduced the pattern that writes a temporary file and then renames it over the
destination. `fsutil::replace_file` holds the rename step. Four write paths call it, and two
of them run today:

| Write path                    | Decision         | Runs today                            |
| ----------------------------- | ---------------- | ------------------------------------- |
| The settings file write       | ADR 013          | Yes                                   |
| The capability cache write    | ADR 006          | Yes                                   |
| The project file write        | ADR 010          | No. Version 1 writes no project file. |
| The export output publication | ADR 004, ADR 014 | No. Only tests call `commit`.         |

On Unix, `replace_file` calls `rename(2)` and then opens the parent directory and calls
`sync_all` on it. The rename is atomic, and the directory sync makes it durable. Two writers
that call it at the same time cannot make a reader see a partial file, and one of the two
renames wins.

On Windows, `replace_file` calls `MoveFileExW` with
`MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`.

**The recorded reason for that direct call is wrong.** The doc comment says that `fs::rename`
fails on Windows when the destination exists. The standard library passes
`MOVEFILE_REPLACE_EXISTING` in `fs::rename`, so `fs::rename` replaces an existing destination.
The true reason to keep a direct call is `MOVEFILE_WRITE_THROUGH`. The standard library does
not pass that flag, and Windows has no equivalent of the Unix directory sync.

`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` is atomic. It fails when a different program, or
a different thread, keeps a handle open on the source file or on the destination file:

| Code | Name                      | Condition                                                   |
| ---- | ------------------------- | ----------------------------------------------------------- |
| 5    | `ERROR_ACCESS_DENIED`     | A different replacement left the destination delete-pending |
| 32   | `ERROR_SHARING_VIOLATION` | A program holds a file and did not permit deletion          |
| 33   | `ERROR_LOCK_VIOLATION`    | A program holds a byte-range lock on a file                 |
| 1224 | `ERROR_USER_MAPPED_FILE`  | A program holds a file in mapped memory                     |

A virus scanner or a file indexer can cause the last three conditions. These conditions occur
most frequently for a file that a program wrote a short time before.

Code 5 is the one code in this set with permanent causes. A read-only destination, an access
list that denies deletion, and a destination that is a directory all raise code 5 and never
clear.

**Rust 1.85 added a second path to `fs::rename`.** The change is `rust-lang/rust` pull request
131072. `MoveFileExW` can fail with
`ERROR_ACCESS_DENIED`. The standard library then opens the source and calls
`SetFileInformationByHandle` with `FileRenameInfoEx`. It sets the flags
`FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS`. POSIX semantics removes
the destination name at once. It does not leave the destination delete-pending. The path needs a
recent Windows 10 or later, on NTFS. The standard library reports the first error when the
volume does not support the flags. One exception exists: it substitutes `ERROR_DIR_NOT_EMPTY`,
code 145, when the second attempt raises that code.

**A current standard library takes that second path for `ERROR_ACCESS_DENIED` only.** It calls
`MoveFileExW` first, and it takes the second path only when that call reports code 5. For the
other three codes, `fs::rename` is one `MoveFileExW` call with `MOVEFILE_REPLACE_EXISTING` and
nothing more. Rust 1.85 is shaped the other way round. It never calls `MoveFileExW`, and
`FileRenameInfoEx` is its first attempt. The decision below holds under both shapes, because the
three other codes stay on the durable call for the write-through flag alone.

Delete-pending is the condition behind the Windows failure of the test
`eight_concurrent_writers_into_one_directory_never_collide_on_a_temporary_name`. One thread
leaves the destination delete-pending, and the next thread reads code 5.

The cost of a failure is not equal for each write path. A failed settings write or a failed cache
write costs one more attempt at a later time. `PendingOutput::commit` consumes its value, and the
cleanup guard stays armed through an early return, so a failed rename **deletes the finished
encode**.

## Decision

Windows `replace_file` resolves both paths one time, above the loop, and then makes up to 10
attempts (`MAXIMUM_REPLACE_ATTEMPTS`) in two layers.

**Layer 1, the durable call.** `MoveFileExW` with
`MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`. Attempt 1 always uses it, and every later
attempt uses it unless the rule below sends that attempt to layer 2.

**Layer 2, `std::fs::rename`, for one condition only.** An attempt uses layer 2 when the last
error is code 5 and the destination is not read-only. Layer 2 then reaches the POSIX-semantics
path above, which completes through a delete-pending destination instead of waiting for it to
clear. Delegating that path to the standard library keeps a large `unsafe` block over a
structure with a variable length out of this repository.

The condition is narrow for two reasons.

**The other three codes gain nothing from layer 2.** The standard library takes its second path
for code 5 only. `fs::rename` after code 32, 33 or 1224 is therefore layer 1 without the
write-through flag. It would give up durability and gain nothing. Those codes clear through
waiting alone, so they stay on layer 1.

**A read-only destination stays a refusal.** The second path of the standard library exists to
ignore the read-only attribute. An attempt that used it would overwrite a file that the user
protected. QuipClip refuses that replacement today, and this decision keeps the refusal. The
check reads the metadata of the destination, and it does not follow the final component of the
path. The attribute that `MoveFileExW` refused is the attribute on that component. A failed read
counts as protected, because a check that protects a file must not open layer 2 for an attribute
that it cannot read. A destination that the check confirms as read-only reports at once. No
later attempt can change that answer.

`replace_file` moves to a further attempt only for the four codes in the table above. It reports
every other error at the attempt that raises it. It waits before each attempt after the first.
The first wait is 1 millisecond, and each wait is two times the wait before it. The last wait is
256 milliseconds, and the nine waits total 511 milliseconds.

`replace_file` reports the last operating-system error. It does not make a new error. ADR 011
forbids user-facing sentences that Rust generates, and permits unchanged operating-system text.
`map_io_error` in `commands/settings.rs` therefore keeps a diagnostic only when the error holds
a raw operating-system code. A new error holds no such code, and QuipClip would lose the
diagnostic.
`fs::rename` itself substitutes codes. Its second path can fail for a reason other than code
145. It then reports the earlier `ERROR_ACCESS_DENIED` and not the true cause. A code 5 out of
layer 2 can therefore be a stand-in.

`Cargo.toml` declares `rust-version = "1.85"`. Layer 2 has no value below that version, and an
older toolchain degrades it with no diagnostic instead of failing the build.

**This decision does not size the wait for the export publication.** 511 milliseconds is correct
for a settings file and a cache file. A scanner holds a file of a few kilobytes for
milliseconds. That limit is too short for an export output. A scanner that reads back a file of
several gigabytes can hold it for seconds. No production code publishes an export today. The
decision that gives `PendingOutput::commit` a production caller must size that wait, and must
specify the report that the user sees while the wait continues.

Four tests hold this decision:

- `eight_concurrent_writers_into_one_directory_never_collide_on_a_temporary_name` must pass on
  Windows. It is the failure this decision answers.
- A Windows test must hold the destination open with a share mode of 0 and then call
  `replace_file`. It must assert the reported code. It must also assert an elapsed time of at
  least 511 milliseconds, and an upper bound that a further attempt would exceed.
- A Windows test must call the routing rule with each of the four codes, and with a writable
  destination and a read-only one. Only code 5 on a writable destination can reach layer 2.
- A Windows test must mark the destination read-only and then call `replace_file`. It must assert
  that the call fails with code 5, and that the destination keeps its contents.

The Unix arm does not change. The arm for other platforms does not change.

## Consequences

- The eight-writer race is passed, not removed. Layer 1 runs first on every call, so a writer can
  still leave a delete-pending destination for the next writer. The retry alone also clears that
  state, because the pending delete completes when the handle that holds it closes. Layer 2
  removes the wait and not the race. No test in this repository separates the two.
- Layer 1 is atomic and durable. Layer 2 is atomic and not durable, because no write-through flag
  reaches it. Code 5 is the only code that gives that up. The other outcome for code 5 on the
  export path is no file at all.
- A volume that is not NTFS, and a Windows older than the version that added the flags, get no
  POSIX semantics. A code-5 attempt there is one `MoveFileExW` call without the write-through
  flag, so it is atomic and not durable. An exFAT or FAT32 removable drive is the usual example.
- QuipClip reports a permanent failure after 511 milliseconds of waiting and nine more rename
  calls. Two permanent cases report sooner. A read-only destination reports at the first attempt,
  because the check confirms it. A destination that is a directory reports at the second attempt
  with code 145.
- The waiting happens while the settings lock or the cache lock is held. One contended settings
  write therefore delays every other settings write by up to 511 milliseconds. `load` and
  `configured_ffmpeg_path` take no lock, so a read is not delayed. Every write path runs through
  `spawn_blocking`, so no window stops.
- ADR 006 records that a second QuipClip process can drop a cache entry. This decision does not
  repair that. The gap is in the read, the merge and the write, and this changes only the rename.
  The cache writer also discards its result, so a failed cache rename reaches nobody.
- `settings::reset` renames the settings file to `settings.invalid.json` with `fs::rename`
  directly. That call gets the second path for code 5, and it gets no retry for any code. A
  sharing violation there still fails at the first attempt. This decision does not change it.
  A failed reset leaves the damaged file in place and costs one more attempt.
- `Cargo.toml` now declares `rust-version`, which also turns on `clippy::incompatible_msrv` for
  the whole crate. Under `-D warnings`, a later use of a standard-library item that became stable
  after 1.85 therefore fails the build until someone raises the declared version.
- `PendingOutput::commit` requires its caller to test `ExportSlot::is_canceled` before the
  rename. No decision record holds that rule, and `ffmpeg/export/output.rs` holds it. The gap
  between that test and the publication grows from microseconds to as much as 511 milliseconds.
  A cancel that arrives inside that gap still publishes the file.
