//! Shared atomic-file-replacement machinery.
//!
//! `project::save` and `ffmpeg::capabilities::cache::write` both need to write a file so that
//! no reader ever observes a half-written result: write the new bytes to a fresh temporary
//! file in the destination's own directory, then rename that file over the destination. A
//! rename within one directory is atomic on every platform this application targets, so a
//! reader always sees either the previous contents or the complete new ones, never a mix of
//! both. Atomic is not the same as safe under concurrency: on Windows the rename step can
//! still fail while another writer replaces the same destination, so [`replace_file_within`] layers
//! two renames and a bounded retry there (ADR 015). This module holds that machinery once. ADR 015
//! tabulates the four write paths that reach it: the settings file (ADR 013), the
//! capability cache (ADR 006), the project file (ADR 010), and the export output publication
//! (ADR 004, ADR 014). All four call it in this repository, and the settings write and the cache
//! write are the two that run today: version 1 writes no project file (ADR 010), and
//! `PendingOutput::commit` is called only from its own tests.
//!
//! The public surface is two functions, not one combined `write_json_atomically`. A combined
//! function would need a new error type carrying both an `io::Error` and a `serde_json::Error`,
//! and each caller would need a new `From` impl to absorb it. Splitting on the existing error
//! boundary needs neither: [`to_pretty_json_line`] returns a `serde_json::Result`, and
//! [`write_bytes_atomically`] returns an `io::Result`, and the callers' own error types
//! (`ProjectFileError`, `CacheError`) already implement `From<io::Error>` and
//! `From<serde_json::Error>`. A caller chains the two with the existing `?` conversions and
//! needs nothing new.

use serde::Serialize;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// A per-process counter that makes each temporary file name unique.
///
/// Two callers racing to write into the same directory, or one caller invoked twice in quick
/// succession, each draw a distinct sequence number from this counter before either one opens
/// its temporary file, so the names never collide even when both stamp the same process id and
/// land in the same directory at the same instant.
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Serialize `value` as pretty-printed JSON with exactly one trailing newline.
///
/// A plain `serde_json::to_vec_pretty` call leaves no trailing newline; this adds one so the
/// file a caller writes reads like an ordinary text file and diffs cleanly.
pub fn to_pretty_json_line<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<Vec<u8>> {
    let mut json = serde_json::to_vec_pretty(value)?;
    json.push(b'\n');
    Ok(json)
}

/// Write `bytes` to `path` so that a reader never observes a partial file.
///
/// This creates a temporary file in `path`'s own directory, writes and syncs `bytes` to it,
/// then renames the temporary file over `path`. The rename is the only step visible to a
/// reader, and a rename within one directory is atomic on every platform this application
/// targets, so a reader always sees either the previous contents of `path` or the complete new
/// `bytes`, never a partial write.
///
/// An error leaves `path` untouched: the temporary file is removed on every failure path, and
/// nothing is renamed over `path` unless the write and the sync both succeeded.
///
/// A read-only `path` is one of those errors, reported as `PermissionDenied` on both platforms
/// (ADR 015), and a `path` that already exists keeps its permission bits across the replacement.
/// [`replace_file_within`] holds both rules and the reasons for them.
pub fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (temporary_path, mut temporary_file) = create_temporary_file(path)?;
    let mut cleanup = TemporaryFileCleanup::new(temporary_path);
    let write_result = temporary_file
        .write_all(bytes)
        .and_then(|()| temporary_file.sync_all());
    drop(temporary_file);
    write_result?;
    replace_file(cleanup.path(), path)?;
    cleanup.disarm();
    Ok(())
}

/// Create a fresh, exclusively-owned temporary file next to `path`.
///
/// The name is `.{file_name}.tmp-{pid}-{sequence}`, retried up to 100 times against
/// [`TEMP_FILE_COUNTER`] so that a collision with another writer, or with a leftover file from
/// a crashed run, is vanishingly unlikely and never fatal on its own.
///
/// The two `io::Error`s this can return -- a `path` with no file name, and 100 straight name
/// collisions -- carry a fixed, feature-neutral message rather than one naming the caller (for
/// example "project file" or "cache file"). Nobody should add a label parameter for this: every
/// caller today already loses the message before a person could read it. `project::save` keeps
/// a detail only when the underlying error carries a raw OS error code, which a synthetic
/// `io::Error::new` never does, and `capabilities::cache::write` discards its whole `Result`.
/// ADR 011 forbids user-facing English coming out of Rust in any case, so the message is free
/// to stay generic.
///
/// **On Unix the temporary file is created at `path`'s own mode, not at `0o666 & !umask`.**
/// [`replace_file_within`] carries `path`'s mode onto the temporary file before the rename, so
/// the *final* state was already right; without this the *transit* was not. The new bytes are
/// written and synced into the temporary file before that copy runs, so a settings file the user
/// narrowed to `0o600` had its new contents world-readable for the length of the write, and an
/// export was far worse: [`reserve_temporary_path`] hands the reservation to `ffmpeg`, which
/// writes the whole encode into it, so a render aimed at a `0o600` destination stayed
/// world-readable for the minutes or hours the encode took. Reading the mode here closes that
/// window.
///
/// Three details of what is passed to `open`:
/// - the owner write bit is always added. The process, or the `ffmpeg` child in the export case,
///   must be able to write the file it just created, and a `destination` with no owner write bit
///   -- `0o444`, or the group-only `0o460` -- would otherwise produce a reservation nothing can
///   write. This is the one bit the transit may hold that the destination does not, and it grants
///   nothing to anybody but the owner, who is writing the file in any case;
/// - only the low nine bits are passed. POSIX does not define `open`'s treatment of the set-id
///   and sticky bits, so those are left to the pre-rename copy, which uses `chmod`;
/// - `umask` still applies to a mode passed to `open`, and it can only clear bits, never set
///   them. So this can land narrower than `path` but never wider, and the copy in
///   [`replace_file_within`] is what widens it back before the rename.
///
/// A missing `path` keeps the historic behaviour exactly: there is no mode to read, no `mode` is
/// passed, and the file arrives at `0o666 & !umask`. Narrowing that case to `0o600` would make
/// every newly exported video owner-only, which is a product decision this function does not own.
fn create_temporary_file(path: &Path) -> io::Result<(PathBuf, File)> {
    let directory = parent_directory(path);
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination file name")
    })?;
    // Read once, above the loop: a retry changes neither the destination nor its mode.
    #[cfg(unix)]
    let destination_mode = destination_creation_mode(path);
    for _ in 0..100 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(".tmp-{}-{sequence}", std::process::id()));
        let temporary_path = directory.join(temporary_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = destination_mode {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        match options.open(&temporary_path) {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique temporary file",
    ))
}

/// Reserve a unique temporary path next to `destination`, without leaving a handle open on it.
///
/// The export renderer (ADR 004, ADR 014) needs a bare path to hand to a spawned `ffmpeg`
/// process, not a `File` this process still holds open: `ffmpeg` opens and writes the path
/// itself, so a handle this process kept open would serve this process no purpose. Closing it
/// immediately also removes any dependence on exactly what share flags `ffmpeg`'s own open
/// uses, and on the muxer being able to re-open the output for a second pass (for example
/// `-movflags +faststart` does that). This function reserves the name by opening it with
/// `create_new(true)`, so no other writer can claim the same name in the window between the
/// reservation and `ffmpeg` opening it, then closes the handle immediately and returns only the
/// path.
///
/// The reservation lands in `destination`'s own directory, the same directory
/// [`write_bytes_atomically`] uses for its own temporary file, so that once `ffmpeg` finishes,
/// [`replace_file`] can rename the reservation over `destination` as a same-filesystem, atomic
/// step rather than a cross-filesystem copy.
///
/// The name and retry discipline are exactly `create_temporary_file`'s:
/// `.{file_name}.tmp-{pid}-{sequence}`, drawn from the same per-process counter, retried up to
/// 100 times before giving up with an `AlreadyExists` error. As with that function, a
/// `destination` file name close to the platform's `NAME_MAX` can push the generated name past
/// the limit and surface as `ENAMETOOLONG` instead of retrying as `AlreadyExists`; that
/// limitation is pre-existing and out of scope for this function.
///
/// Reserving the path by creating it means the path exists and is zero bytes the moment this
/// function returns, before `ffmpeg` has run at all. The caller's `ffmpeg` invocation must
/// account for that:
/// - it must pass `-y`, because ADR 004 also requires `-nostdin`, which puts the interactive
///   overwrite prompt out of reach: ffmpeg refuses the existing zero-byte reservation outright
///   and prints `File '<path>' already exists. Exiting.` and then
///   `Error opening output file <path>.` It does not print "Not overwriting - exiting"; that
///   line comes from the prompt itself, which only a run without `-nostdin` reaches, and only
///   when stdin is at end of file;
/// - it must pass an explicit `-f <format>`, because the reserved name's extension is
///   `.tmp-{pid}-{sequence}`, not `destination`'s, so ffmpeg cannot infer the muxer from it.
///
/// A missing `-y` then fails in the one way a caller is least likely to notice. Measured on
/// ffmpeg 9.0.1, that refusal exits with status 0 -- fftools maps `AVERROR_EXIT` to zero --
/// and leaves the reservation at zero bytes. A caller that checks only the exit status reads
/// the run as a success, renames the reservation over `destination`, and so publishes a
/// zero-byte file over the user's own video. The exit status alone cannot detect this. The
/// frame count comparison ADR 014 requires is what catches it: the final `frame` value ffmpeg
/// reported never reaches the expected count, so the renderer reports `frameCountMismatch` and
/// never reaches the rename.
///
/// The caller owns the reserved path from here on. This function arms no cleanup guard, because
/// the reservation must survive past this call's return for `ffmpeg` to write into -- only the
/// caller knows when the export has actually finished or failed. A caller that needs to remove
/// the reservation on an early failure -- discovery fails, the spawn fails, the user cancels --
/// can wrap the returned path in the same `TemporaryFileCleanup` guard [`write_bytes_atomically`]
/// uses, rather than hand-rolling its own cleanup on every early return.
pub fn reserve_temporary_path(destination: &Path) -> io::Result<PathBuf> {
    let (path, file) = create_temporary_file(destination)?;
    // Close the handle immediately: this process has nothing left to do with it, and closing
    // it now removes any dependence on exactly what share flags ffmpeg's own open uses, or on
    // ffmpeg's muxer re-opening the output for a second pass.
    drop(file);
    Ok(path)
}

/// The directory a temporary file for `path` belongs in.
///
/// A bare file name with no directory component -- `path.parent()` returning `Some` of an
/// empty path, or `None` -- maps to the current directory, matching how the standard library
/// itself resolves a bare relative name.
fn parent_directory(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        Some(_) | None => Path::new("."),
    }
}

/// The retry budget [`replace_file`] spends, and the one every caller used before the budget
/// became a parameter (ADR 015).
///
/// 511 milliseconds is sized for the settings file (ADR 013) and the capability cache (ADR 006),
/// where a scanner holds a file of a few kilobytes for milliseconds. It is deliberately short,
/// because both of those writes run under a lock the rest of the application waits on.
///
/// It is the wrong size for the export publication, where a scanner reading back a file of
/// several gigabytes holds it for seconds and a failed rename discards a finished encode. That
/// caller passes its own budget to [`replace_file_within`]; see
/// `ffmpeg::export::output::EXPORT_PUBLISH_BUDGET`.
pub const DEFAULT_REPLACE_BUDGET: Duration = Duration::from_millis(511);

// While the waits still double, a budget of 2^n - 1 milliseconds buys exactly n waits: those n
// waits sum to 2^n - 1 and exhaust the budget, so the (n+1)-th wait of 2^n milliseconds is 2^n
// milliseconds too large for the nothing that is left. `MAXIMUM_RETRY_WAIT` breaks that law from
// 4095 milliseconds on, where the doubling has already stopped: 4095 buys 13 waits, not 12. 511
// is 2^9 - 1 and is below that point, so the default budget buys the nine waits 1, 2, 4, 8, 16, 32,
// 64, 128 and 256, and therefore ten attempts. That is the schedule this module had before the
// budget was a parameter, byte for byte, and it is why the existing Windows tests still pass
// unchanged. Changing this value changes both figures, and five doc comments state them.
const _: () = assert!(DEFAULT_REPLACE_BUDGET.as_millis() == 511);

/// Replace `destination` with `source` in one atomic step, spending [`DEFAULT_REPLACE_BUDGET`].
///
/// This is [`replace_file_within`] with the budget the settings file and the capability cache
/// need; that function carries the whole description of what the replacement does per platform,
/// and it is the one to call with a longer budget.
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    replace_file_within(source, destination, DEFAULT_REPLACE_BUDGET)
}

/// Replace `destination` with `source` in one atomic step, waiting up to `budget` for a
/// transient sharing failure to clear.
///
/// A plain rename is already atomic on Unix, so this adds three things and no more: a refusal to
/// overwrite a read-only `destination`, a copy of `destination`'s permission bits onto `source`,
/// and the directory fsync that makes the rename itself durable across a crash. `budget` is unused
/// here: `rename(2)` is safe under concurrency, so there is nothing on this platform to wait out.
///
/// **A read-only `destination` is refused before the rename.** ADR 015 states that refusal as
/// product behaviour, and `rename(2)` does not supply it: it needs the write and search
/// permissions on the parent *directory*, not any permission on the destination file, so a
/// `chmod 444` destination is replaced without complaint. So this reads `destination` and reports
/// `PermissionDenied` when it is a regular file with no write bit set for anybody -- exactly what
/// `Permissions::readonly()` answers, and exactly the attribute the Windows arm reads through
/// `destination_is_read_only`, so the two platforms refuse the same file. (That name is
/// `#[cfg(windows)]`, so it is not linked here.)
///
/// The read is `symlink_metadata`, not `metadata`, for the reason
/// `destination_is_read_only` gives: `rename(2)` never resolves the destination's final
/// component either, so the mode that decides this is the mode on that component. A `destination`
/// that is a symlink to a read-only file is therefore replaced, and the file it pointed at keeps
/// its contents.
///
/// Anything that is not a regular file -- a directory, a symlink, a missing path -- is left for
/// `rename(2)` to report. Inventing an error for those cases would replace a kernel error that
/// names the real condition with a worse one.
///
/// **This is not a test of whether this process can write `destination`, and it does not try to
/// be.** A destination owned by another user with mode `0o644` is not read-only by this test, yet
/// this process cannot write it either, and `rename(2)` replaces it anyway. Closing that gap needs
/// a capability probe -- `OpenOptions::new().write(true).open(destination)` -- and this refuses
/// one for two reasons. It would diverge from the Windows arm, because root opens a `0o444` file
/// for writing successfully and would therefore be permitted to overwrite exactly the file the
/// user protected, which is the case this guard exists for. And a `destination` that is a FIFO
/// would block that open indefinitely, turning a rename into a hang.
///
/// **The refusal is the one error this arm manufactures**, because no system call was made and
/// so there is no operating-system error to report. It is not the only one the module
/// manufactures: [`create_temporary_file`] makes two more, for a `path` with no file name and for
/// 100 straight name collisions, and on Windows `absolute_path_without_following_file` makes a
/// third. The discipline below is the same for all four, and `create_temporary_file` states it
/// for its own pair. That costs the diagnostic: `map_io_error` in
/// `commands/settings.rs`, `commands/project.rs`, and the `commit` mapping in
/// `commands/export.rs` all keep a detail only when the error carries a raw operating-system code
/// (ADR 011), and this error carries none. The cost is accepted rather than papered over. Do not
/// reach for `io::Error::from_raw_os_error(13)`: that would claim `EACCES` came from a `rename(2)`
/// that never ran, and a reader following the code into a system-call trace would find no such
/// call. The `permissionDenied` code every caller already reports is the exact and complete
/// account of this refusal -- there is nothing a kernel could add, because no kernel was asked.
///
/// **`destination`'s permission bits are carried onto `source` before the rename.** A replacement
/// writes a fresh inode, so without this step a settings file the user narrowed to `0o600` came
/// back world-readable after the very first save, and nothing reported it, because the
/// replacement succeeded. Only the low twelve bits are copied: `Metadata::permissions` on Unix
/// carries the whole `st_mode` including the file-type bits, and POSIX leaves `chmod`'s treatment
/// of bits outside `0o7777` unspecified.
///
/// It happens before the rename, not after. A `chmod` after the rename would leave a window in
/// which a reader opening `destination` sees the temporary file's permissions instead of the
/// ones it is meant to keep.
///
/// This is the second read of `destination`'s mode, and it is not a redundant one.
/// [`create_temporary_file`] already read it, to *create* the temporary file at that mode rather
/// than at `0o666 & !umask`, which is what keeps the new bytes from being world-readable while
/// they are still being written. That read cannot be the last word: `umask` narrows a mode passed
/// to `open`, the owner write bit is added there and has to come back off, the set-id and sticky
/// bits are not passed to `open` at all, and `destination`'s mode may have changed since. This
/// read is the authority, and it is deliberately the later of the two.
///
/// Its result is discarded, for the reason the parent-directory sync's result is discarded one
/// line below the rename: the caller was promised a replacement, and a mode that could not be
/// copied is a smaller loss than a settings save reported as a failure after it already
/// succeeded.
///
/// The rename is the step that publishes, and the directory fsync only adds durability across a
/// crash. A failed fsync is therefore not reported: an `Err` from this function always means
/// either the read-only refusal above or a failed rename, and `destination` still holds what it
/// held before in both cases. Reporting a failed
/// fsync would tell every caller that the replacement did not happen when it did -- a settings
/// save, a settings reset that has already moved the old file aside, and an export publication
/// that has already written the user's chosen path.
///
/// The two platform arms are less symmetric than they look, and this is the arm a macOS
/// developer reads. This one needs neither layer nor retry, because `rename(2)` is also safe when
/// two writers target one destination, and the parent-directory fsync makes it durable. The
/// Windows arm reaches the concurrency guarantee through two rename layers and a bounded retry, and
/// reaches durability on every attempt that carries `MOVEFILE_WRITE_THROUGH` (ADR 015). Do not
/// assume a change here has an equivalent there, or the reverse -- a `budget` that decides
/// nothing here decides how long the call blocks there.
///
/// [`write_bytes_atomically`] is one caller, through [`replace_file`]. The export renderer
/// (ADR 004, ADR 014) is a second, direct one: it calls this itself, with its own longer budget,
/// once the `ffmpeg` process it spawned has finished writing the path
/// [`reserve_temporary_path`] reserved, to move that output over the destination the user chose.
#[cfg(unix)]
pub fn replace_file_within(source: &Path, destination: &Path, _budget: Duration) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    // One read serves both steps, and both steps look at the destination's own final component
    // rather than whatever a symlink there points at.
    if let Some(permissions) = destination_permissions(destination) {
        if permissions.readonly() {
            // The one error this arm manufactures -- `create_temporary_file` makes two more of
            // its own. It carries no raw operating-system code, because no system call was made,
            // and every caller therefore drops its message (ADR 011). The message is for a
            // developer reading a log, not for the user.
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the destination is read-only",
            ));
        }
        // Carry the destination's mode onto the temporary file *before* the rename, so no reader
        // ever opens the destination and finds the temporary file's mode. The low twelve bits
        // only: `permissions()` carries the file-type bits too, and POSIX leaves `chmod`
        // undefined for those. A failure here costs the mode, not the replacement.
        //
        // `create_temporary_file` read this mode as well, to create the file at it. This read is
        // the authority: it clears the owner write bit that read had to add, it carries the
        // set-id bits `open` is not defined for, and if the destination's mode changed while the
        // bytes were being written it is the later read that should win.
        let _ = fs::set_permissions(
            source,
            fs::Permissions::from_mode(permissions.mode() & PERMISSION_BITS),
        );
    }
    fs::rename(source, destination)?;
    // The rename is complete and every reader already sees it. A failed directory open or fsync
    // costs durability across a crash; it does not undo the replacement, so it must not be
    // reported as one.
    let _ = File::open(parent_directory(destination)).and_then(|directory| directory.sync_all());
    Ok(())
}

/// The `st_mode` bits `chmod` is defined for: the twelve permission and set-id bits.
///
/// [`replace_file_within`] masks with this before it copies a mode. `Metadata::permissions` on
/// Unix carries the whole `st_mode`, file-type bits included, and POSIX leaves `chmod`'s
/// behaviour unspecified for anything outside this mask.
#[cfg(unix)]
const PERMISSION_BITS: u32 = 0o7777;

/// The permissions of `destination`, or `None` when `destination` is not a regular file.
///
/// This is the Unix counterpart of `destination_is_read_only`, and it answers for both of
/// [`replace_file_within`]'s pre-rename steps: the read-only refusal and the mode copy.
///
/// The read is `symlink_metadata`, not `metadata`, because `rename(2)` never resolves the
/// destination's final component. The mode that decides the refusal is the mode on that
/// component, so following a link here would read the wrong file -- refusing a link that points
/// at a read-only file while nothing protected would be touched, and overwriting a read-only link
/// that points at a writable file.
///
/// `None` for a directory, for a symlink, for a missing path, and for an unreadable one. Each of
/// those is left to `rename(2)`, which reports the real condition better than a guard here could
/// guess it. Note the asymmetry with the Windows arm this is otherwise a mirror of: there an
/// unreadable attribute is the *protected* answer, because layer 2 would ignore the attribute and
/// succeed. Here there is no second layer to close, and a failed read means `rename(2)` is about
/// to fail on the same path for the same reason and say so with a real error.
#[cfg(unix)]
fn destination_permissions(destination: &Path) -> Option<fs::Permissions> {
    fs::symlink_metadata(destination)
        .ok()
        .filter(|metadata| metadata.file_type().is_file())
        .map(|metadata| metadata.permissions())
}

/// The `mode` [`create_temporary_file`] passes to `open` for a temporary file next to
/// `destination`, or `None` when there is no mode to read.
///
/// `destination`'s own low nine bits, plus the owner write bit the process needs to write the
/// file it just created. [`create_temporary_file`] carries why each of those three choices is
/// what it is; `None` -- a missing, non-regular or unreadable `destination` -- means no `mode` is
/// passed at all, so the file keeps the historic `0o666 & !umask`.
#[cfg(unix)]
fn destination_creation_mode(destination: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;

    destination_permissions(destination)
        .map(|permissions| (permissions.mode() & 0o777) | OWNER_WRITE_BIT)
}

/// `S_IWUSR`: the one bit [`create_temporary_file`] adds to the mode it reads.
#[cfg(unix)]
const OWNER_WRITE_BIT: u32 = 0o200;

/// Replace `destination` with `source` in one atomic step, through two layered renames, waiting
/// up to `budget` for a transient sharing failure to clear.
///
/// Both layers replace an existing `destination`, and both are atomic. `std::fs::rename` on
/// Windows passes `MOVEFILE_REPLACE_EXISTING` too, so an existing destination is not the reason
/// this calls `MoveFileExW` directly. The reason is `MOVEFILE_WRITE_THROUGH`, which the standard
/// library does not pass: Windows has no equivalent of the Unix parent-directory fsync, so that
/// flag is the only crash-durability guarantee this function has here (ADR 015).
///
/// **Layer 1, the durable call.** `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`. It is atomic and durable, and almost
/// every call ends here with the guarantee the Unix arm gets from its directory fsync. Every
/// attempt runs layer 1 unless the routing rule below sends that one attempt to layer 2.
///
/// **Layer 2, one narrow detour.** `std::fs::rename`. Since Rust 1.85 the standard library can
/// open the source and call `SetFileInformationByHandle` with `FileRenameInfoEx` and
/// `FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS`, which a recent
/// Windows 10 or later supplies on NTFS. POSIX semantics removes the destination name at once,
/// instead of leaving it delete-pending, and delete-pending is exactly what makes the next of
/// several racing writers read code 5. So layer 2 dissolves that race rather than waiting it out.
/// Delegating it to the standard library also keeps a large `unsafe` block over a
/// variable-length structure out of this repository.
///
/// Layer 2 is atomic and **not** durable, because no write-through flag reaches it. That trade
/// is deliberate (ADR 015): on the export publication path the alternative outcome is no file at
/// all, so a replacement that is atomic but not yet flushed beats a lost encode.
///
/// **Which code reaches layer 2.** Only `ERROR_ACCESS_DENIED`, and only when `destination` is
/// not read-only. A current `fs::rename` gates its whole POSIX-semantics path behind that one
/// code: it calls `MoveFileExW(old, new, MOVEFILE_REPLACE_EXISTING)` first and takes the POSIX
/// path only when that call reports code 5. Rust 1.85, the floor `Cargo.toml` declares, is
/// shaped the other way round: `FileRenameInfoEx` is its first attempt, and `FileRenameInfo` is
/// the fallback on `ERROR_INVALID_PARAMETER`. Neither shape changes this rule. For
/// `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION` and `ERROR_USER_MAPPED_FILE` -- the
/// virus-scanner and file-indexer codes, and the common case on a freshly muxed export --
/// `fs::rename` would be layer 1 **minus** `MOVEFILE_WRITE_THROUGH`: it would surrender the only
/// durability guarantee this arm has. Those three therefore stay on layer 1 and stay durable,
/// for the write-through flag alone. A read-only destination is excluded for a separate reason;
/// [`destination_is_read_only`] carries it. [`routes_to_posix_rename`] holds the whole rule, and
/// is the function this loop calls.
///
/// A confirmed read-only destination also ends the call at once, without the remaining waits: the
/// condition is permanent, layer 2 is closed to it, and no later attempt can succeed, so sleeping
/// the rest of the budget would only hold the caller's lock for nothing. An attribute that cannot
/// be read is not a confirmed refusal, so it keeps the retries: an ordinary delete-pending race
/// still clears by waiting.
///
/// This makes one attempt for the first rename and one more for each wait [`retry_waits`] yields
/// out of `budget`, and it goes on to the next attempt only for the codes
/// [`is_transient_sharing_error`] accepts. Every other error is reported at the attempt that
/// raises it, which can be the last one if transient failures came first. A wait precedes each
/// attempt after the first, and no wait follows the last attempt. The last `io::Error` is
/// returned unchanged **by this module**, never wrapped and
/// never replaced: a synthetic error carries no raw operating-system code, and `map_io_error` in
/// `commands/settings.rs` keeps a diagnostic only when the error carries one (ADR 011).
/// `fs::rename` itself is not so faithful, so a code 5 out of layer 2 can be a stand-in: when its
/// POSIX attempt fails for any reason other than `ERROR_DIR_NOT_EMPTY` it reports the earlier
/// `ERROR_ACCESS_DENIED` rather than the real cause.
///
/// **The budget is the caller's, not this function's.** [`replace_file`] passes
/// [`DEFAULT_REPLACE_BUDGET`], 511 milliseconds, and that size is set by the settings file and the
/// cache file, where a scanner holds a file of a few kilobytes for milliseconds. It is too short
/// for the export publication, where a scanner reads back a file of several gigabytes and holds it
/// for seconds, and where a rename this function gives up on discards a finished encode. That
/// caller passes its own, far longer budget; see `ffmpeg::export::output::EXPORT_PUBLISH_BUDGET`.
/// A separate application that holds the destination open -- a media player, for example -- is a
/// genuinely unbounded condition that only the user can clear. That case is the reason `budget` is
/// a limit at all, rather than an unbounded wait.
///
/// Both paths are resolved one time, above the loop. A retry changes neither path, and the two
/// directory opens `canonicalize` performs are network round trips on a network share, so
/// hoisting them keeps the whole call as close to `budget` as this design allows. `budget` bounds
/// the sleeping alone: the two `canonicalize` round trips, the rename calls themselves and the
/// `symlink_metadata` reads from the read-only guard -- two on each code-5 attempt, one for the
/// early return and one for the routing rule -- all sit outside it.
///
/// The Unix arm needs neither layer nor retry, so the two arms are less symmetric than they
/// look. A reader of one must not assume the other has the same shape.
///
/// [`write_bytes_atomically`] is one caller, through [`replace_file`]. The export renderer
/// (ADR 004, ADR 014) is a second, direct one: it calls this itself, with its own longer budget,
/// once the `ffmpeg` process it spawned has finished
/// writing the path [`reserve_temporary_path`] reserved, to move that output over the
/// destination the user chose. `ffmpeg` must have closed its own handle to the source by then,
/// or this call fails the same way an in-process caller's leftover handle would -- and there
/// the retry only delays the report, because that handle never goes away on its own.
#[cfg(windows)]
pub fn replace_file_within(source: &Path, destination: &Path, budget: Duration) -> io::Result<()> {
    let source = absolute_path_without_following_file(source)?;
    let destination = absolute_path_without_following_file(destination)?;

    // The first attempt. Always layer 1. A `let` binding rather than a loop iteration, so the
    // compiler proves `last_error` holds a value on every path that reaches the loop.
    let mut last_error = match move_file_write_through(&source, &destination) {
        Ok(()) => return Ok(()),
        Err(error) if is_transient_sharing_error(&error) => error,
        Err(error) => return Err(error),
    };

    // Every attempt after the first, one per wait the budget affords. `retry_waits` owns the
    // whole schedule and the whole stopping rule, so the loop performs exactly one wait per
    // attempt after the first and never one after the last attempt.
    for wait in retry_waits(budget) {
        // A confirmed read-only destination is a permanent code-5 condition, and layer 2 is
        // closed to it, so no later attempt can succeed. Report it now instead of sleeping the
        // rest of the budget while the caller holds SETTINGS_LOCK or CACHE_LOCK. Only
        // `Some(true)` ends the call: `None` means the attribute could not be read, which is not
        // a confirmed refusal, and an ordinary delete-pending race still clears by waiting. The
        // attribute is read only when the code is 5, so the common path pays nothing.
        if last_error.raw_os_error() == Some(ERROR_ACCESS_DENIED)
            && destination_is_read_only(&destination) == Some(true)
        {
            return Err(last_error);
        }
        std::thread::sleep(wait);
        // Route by the code the previous attempt raised. `fs::rename` gates its
        // POSIX-semantics fallback behind ERROR_ACCESS_DENIED alone, so for any other code it
        // is layer 1 without MOVEFILE_WRITE_THROUGH: no new capability, and no durability.
        // Repeat the durable call instead.
        let attempt = if routes_to_posix_rename(&last_error, &destination) {
            fs::rename(&source, &destination)
        } else {
            move_file_write_through(&source, &destination)
        };
        last_error = match attempt {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_sharing_error(&error) => error,
            Err(error) => return Err(error),
        };
    }
    Err(last_error)
}

/// A backstop on the number of rename attempts one [`replace_file_within`] call makes.
///
/// This is not what sizes a call. The budget does: [`retry_waits`] stops as soon as the next wait
/// no longer fits, and because the waits double until they reach [`MAXIMUM_RETRY_WAIT`], a budget
/// of `b` seconds already buys fewer than `b + 10` attempts. Reaching 1000 attempts therefore
/// needs a budget near 1000 seconds -- more than sixteen minutes of sleeping inside one call --
/// which is about thirty-three times the longest budget any caller in this repository passes. The
/// constant exists so that a budget arrived at by arithmetic somewhere else, or by a future
/// settings value, cannot turn a bounded wait into an unbounded loop; it is a guard rail, not a
/// tuning knob.
#[cfg(any(windows, test))]
const MAXIMUM_REPLACE_ATTEMPTS: u32 = 1000;

/// The largest single wait [`retry_waits`] yields, however large the budget is.
///
/// Doubling without a cap abandons most of a long budget. Under this module's stopping rule, an
/// uncapped 30-second budget takes the fourteen waits 1 to 8192 milliseconds, which total 16.4
/// seconds, and then stops, because the fifteenth wait of 16.4 seconds does not fit in the 13.6
/// seconds that are left. It would report a failure after 16.4 seconds when it was given 30, with
/// 13.6 seconds -- 45 percent of the budget -- unspent. Uncapped doubling also looks at the
/// destination more and more slowly toward the end, so a destination that becomes free early
/// stays unpublished for as long as 8.2 seconds, the largest wait that schedule reaches. Capping
/// each wait at one second spends the budget the caller asked for and keeps the tail polling at a
/// steady rate, at the cost of more attempts, which are cheap next to the sleeping (ADR 016).
#[cfg(any(windows, test))]
const MAXIMUM_RETRY_WAIT: Duration = Duration::from_secs(1);

/// `ERROR_ACCESS_DENIED`: a different replacement left the destination delete-pending.
///
/// This code is treated as transient, and no code in this set is always transient: a media player
/// that holds the destination raises `ERROR_SHARING_VIOLATION` for as long as the user leaves it
/// open, and a permanently mapped file raises `ERROR_USER_MAPPED_FILE` the same way. The
/// permanent code-5 conditions are a read-only destination, which [`destination_is_read_only`]
/// makes [`replace_file_within`] refuse deliberately, an access list that denies deletion, and a
/// `destination` that is an existing directory. `ffmpeg::export::output` documents that last case
/// as reachable: a user who picks a directory as the export target reserves a temporary path
/// successfully and then fails at the rename. A permanent case does not have to spend the whole
/// budget. A directory destination can report at attempt 2, because `fs::rename` substitutes
/// `ERROR_DIR_NOT_EMPTY` (145) when its POSIX attempt raises it, and 145 is not in this set, so
/// [`replace_file_within`] stops there. Treating code 5 as transient at all is the accepted cost of
/// clearing the delete-pending race, which is both common and short.
#[cfg(windows)]
const ERROR_ACCESS_DENIED: i32 = 5;

/// `ERROR_SHARING_VIOLATION`: a program holds an endpoint and did not permit deletion.
#[cfg(windows)]
const ERROR_SHARING_VIOLATION: i32 = 32;

/// `ERROR_LOCK_VIOLATION`: a program holds a byte-range lock on an endpoint.
#[cfg(windows)]
const ERROR_LOCK_VIOLATION: i32 = 33;

/// `ERROR_USER_MAPPED_FILE`: a program holds an endpoint in mapped memory.
#[cfg(windows)]
const ERROR_USER_MAPPED_FILE: i32 = 1224;

/// Whether `error` is the kind of transient sharing failure a new attempt can clear.
///
/// Only the four codes ADR 015 lists qualify. Every other error, including one carrying no raw
/// operating-system code at all, is reported at the attempt that raises it, with no further
/// attempt and no further wait. Read [`ERROR_ACCESS_DENIED`] before you rely on "transient":
/// several permanent conditions raise that code as well.
#[cfg(windows)]
fn is_transient_sharing_error(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(
            ERROR_ACCESS_DENIED
                | ERROR_SHARING_VIOLATION
                | ERROR_LOCK_VIOLATION
                | ERROR_USER_MAPPED_FILE
        )
    )
}

/// Whether the attempt that follows `last_error` uses layer 2.
///
/// The whole routing rule lives here so that a test can pin it. [`replace_file_within`] calls this
/// function itself, rather than restating the condition inline, so the rule a test observes is
/// the rule that runs.
///
/// `Some(false)` is the only read-only answer that opens layer 2. `None` -- the attribute could
/// not be read -- keeps layer 1, for the reason [`destination_is_read_only`] states.
#[cfg(windows)]
fn routes_to_posix_rename(last_error: &io::Error, destination: &Path) -> bool {
    last_error.raw_os_error() == Some(ERROR_ACCESS_DENIED)
        && destination_is_read_only(destination) == Some(false)
}

/// Whether `destination` carries the read-only attribute, or `None` if the attribute is unreadable.
///
/// This is the one `ERROR_ACCESS_DENIED` case [`replace_file_within`] deliberately refuses to
/// clear. A read-only destination fails layer 1 with code 5, and layer 2 would succeed on it: the
/// standard library's POSIX-semantics path exists precisely to move a file while ignoring the
/// read-only attribute. Routing it there would make QuipClip overwrite a file the user
/// protected, where today the call fails. So [`replace_file_within`] keeps that failure and never
/// takes layer 2 for a read-only destination.
///
/// This guard exists to protect a file the user marked read-only, so an attribute it cannot read
/// must not open layer 2. `None` is therefore the protected answer, not a permissive one: an
/// answer of "not read-only" drawn from a failed metadata read would send a genuinely read-only
/// destination to layer 2, which ignores the attribute and succeeds, and the protected file would
/// be overwritten with no error reported at all. `None` still keeps the layer 1 retries, because
/// an unreadable attribute is not a confirmed refusal and an ordinary delete-pending race must
/// still clear by waiting.
///
/// The read is `symlink_metadata`, not `metadata`, because [`replace_file_within`] never resolves
/// the destination's final component: [`absolute_path_without_following_file`] canonicalizes only
/// the parent. The attribute `MoveFileExW` refused is the one on that final component itself, so
/// following a symlink here would read the wrong file -- refusing a link that points at a
/// read-only file while nothing protected would be touched, and overwriting a read-only link that
/// points at a writable file.
#[cfg(windows)]
fn destination_is_read_only(destination: &Path) -> Option<bool> {
    fs::symlink_metadata(destination)
        .ok()
        .map(|metadata| metadata.permissions().readonly())
}

/// The wait before retry number `retry_index`, counting the first retry as index 0.
///
/// The waits double from 1 millisecond -- 1, 2, 4, 8, 16, 32, 64, 128, 256, 512 -- and every one
/// after that is [`MAXIMUM_RETRY_WAIT`] (ADR 016).
#[cfg(any(windows, test))]
fn replace_retry_delay(retry_index: u32) -> Duration {
    // Clamp before shifting, not after. Rust defines both outcomes of a shift of 64 or more, and
    // neither is usable here: with overflow checks on, which is the default in a debug build,
    // `1u64 << 64` panics; with them off, the shift amount is masked to its low six bits, so
    // `1u64 << 64` silently becomes `1u64 << 0` and the wait collapses to 1 millisecond. 32 is far
    // past the point where the cap takes over -- 2^32 milliseconds is seven weeks -- so the clamp
    // only ever prevents that, and never changes which value the cap already decided.
    Duration::from_millis(1u64 << retry_index.min(32)).min(MAXIMUM_RETRY_WAIT)
}

/// Every wait one [`replace_file_within`] call performs for `budget`, in order.
///
/// This is the whole retry schedule and the whole stopping rule, in one place: an attempt happens
/// for the first rename and for each wait this yields, so the number of attempts is one more than
/// the number of waits. A wait is yielded while it still fits in what is left of `budget`, and the
/// iterator ends as soon as one does not -- `checked_sub` returning `None` is that rule. The
/// Windows arm of [`replace_file_within`] consumes this directly, so the schedule a test collects
/// here is the schedule that runs; the other two arms do not retry at all and never call it.
///
/// With [`DEFAULT_REPLACE_BUDGET`] this yields 1, 2, 4, 8, 16, 32, 64, 128 and 256 milliseconds:
/// nine waits summing to exactly 511, which exhausts the budget, so the tenth wait of 512 is 512
/// milliseconds too large for the nothing that is left. That is nine waits and ten attempts, byte
/// for byte the fixed schedule this module ran before the budget was a parameter, and it is why
/// the `#[cfg(windows)]` tests that time a held destination still pass unchanged.
#[cfg(any(windows, test))]
fn retry_waits(budget: Duration) -> impl Iterator<Item = Duration> {
    let mut remaining = budget;
    // `saturating_sub`, not `- 1`: a `MAXIMUM_REPLACE_ATTEMPTS` of 0 would underflow a `u32` to
    // `u32::MAX` with overflow checks off, turning the guard rail into the unbounded loop it
    // exists to prevent.
    (0..MAXIMUM_REPLACE_ATTEMPTS.saturating_sub(1)).map_while(move |retry_index| {
        let wait = replace_retry_delay(retry_index);
        remaining = remaining.checked_sub(wait)?;
        Some(wait)
    })
}

/// Layer 1: one `MoveFileExW` call that replaces `destination` with `source`, durably.
///
/// `MOVEFILE_WRITE_THROUGH` is the whole reason this hand-written call exists, and it is the
/// only part of [`replace_file_within`] the standard library cannot supply. Both paths arrive
/// already resolved, because [`replace_file_within`] resolves them one time above its loop.
#[cfg(windows)]
fn move_file_write_through(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Resolve `path` to an absolute path without following it as a symlink, for both rename layers.
///
/// `Path::canonicalize` would follow `path` itself if it names a symlink, which is wrong for a
/// rename endpoint; canonicalizing only the parent directory and rejoining the file name avoids
/// that while still producing the absolute path `MoveFileExW` needs. [`replace_file_within`] calls
/// this twice, above its loop, and both layers reuse the two results.
#[cfg(windows)]
fn absolute_path_without_following_file(path: &Path) -> io::Result<PathBuf> {
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination file name")
    })?;
    Ok(parent_directory(path).canonicalize()?.join(file_name))
}

/// Replace `destination` with `source` on a platform with neither Unix nor Windows semantics.
///
/// This falls back to a plain rename with no extra durability step, since neither the Unix
/// fsync nor the Windows `MoveFileExW` treatment has a portable equivalent here. `budget` is
/// unused for the same reason there is no retry: this arm assumes nothing about what a failed
/// rename means on a platform nobody has characterised, so it has nothing to wait out.
///
/// [`write_bytes_atomically`] is one caller, through [`replace_file`]. The export renderer
/// (ADR 004, ADR 014) is a second, direct one: it calls this itself, with its own longer budget,
/// once the `ffmpeg` process it spawned has finished
/// writing the path [`reserve_temporary_path`] reserved, to move that output over the
/// destination the user chose. QuipClip does not ship on such a platform today, but this keeps
/// the module buildable on one.
#[cfg(not(any(unix, windows)))]
pub fn replace_file_within(source: &Path, destination: &Path, _budget: Duration) -> io::Result<()> {
    fs::rename(source, destination)
}

/// An armed guard that deletes a temporary file unless [`disarm`](Self::disarm) is called.
///
/// [`write_bytes_atomically`] arms this right after creating the temporary file and disarms it
/// only once the rename over the destination has succeeded, so the temporary file is removed on
/// every early return -- a failed write, a failed sync, or a failed rename -- and left alone
/// only after it no longer exists under its temporary name.
///
/// Visibility is `pub(crate)` so the export renderer (ADR 004, ADR 014) can reuse it for the
/// path [`reserve_temporary_path`] hands back. Without this, the export module would need to
/// hand-roll its own `let _ = fs::remove_file(...)` on every early return -- discovery fails,
/// the `ffmpeg` spawn fails, the user cancels -- and a bug in any one of those call sites would
/// leave a zero-byte `.{file_name}.tmp-{pid}-{sequence}` behind in the user's chosen output
/// folder, not in a temporary directory nobody looks at.
pub(crate) struct TemporaryFileCleanup {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFileCleanup {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryFileCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn write_bytes_atomically_replaces_existing_contents_and_leaves_no_temporary_file() {
        let directory = TestDirectory::new();
        let path = directory.path.join("value.txt");
        write_bytes_atomically(&path, b"first").unwrap();
        write_bytes_atomically(&path, b"second, and longer").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second, and longer");
        let entries: Vec<_> = fs::read_dir(&directory.path).unwrap().collect();
        assert_eq!(
            entries.len(),
            1,
            "the directory must hold only the destination file"
        );
    }

    #[test]
    fn parent_directory_maps_a_bare_file_name_to_the_current_directory() {
        assert_eq!(parent_directory(Path::new("example.txt")), Path::new("."));
    }

    #[test]
    fn to_pretty_json_line_ends_with_exactly_one_newline_and_is_indented() {
        let value = serde_json::json!({"a": 1});
        let bytes = to_pretty_json_line(&value).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert_ne!(
            bytes[bytes.len() - 2],
            b'\n',
            "must not end with two newlines"
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            text.lines().any(|line| line.starts_with("  ")),
            "pretty printing must indent at least one line"
        );
    }

    #[test]
    fn two_temporary_files_for_one_destination_never_share_a_name() {
        let directory = TestDirectory::new();
        let path = directory.path.join("value.txt");
        let (first, _first_file) = create_temporary_file(&path).unwrap();
        let (second, _second_file) = create_temporary_file(&path).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn eight_concurrent_writers_into_one_directory_never_collide_on_a_temporary_name() {
        let directory = TestDirectory::new();
        let path = directory.path.join("value.txt");
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                let contents = format!("contents-{index}").into_bytes();
                thread::spawn(move || write_bytes_atomically(&path, &contents))
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let leftover = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(
            !leftover,
            "a temporary file was left behind after concurrent writes"
        );
    }

    #[test]
    fn reserve_temporary_path_places_the_reservation_in_the_destinations_own_directory() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        let reserved = reserve_temporary_path(&destination).unwrap();
        assert_eq!(
            reserved.parent(),
            Some(directory.path.as_path()),
            "the reservation must share destination's directory, not the system temp \
             directory, so the later rename stays on one filesystem"
        );
    }

    #[test]
    fn reserve_temporary_path_creates_an_empty_file_at_the_reserved_path() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        let reserved = reserve_temporary_path(&destination).unwrap();
        let metadata = fs::metadata(&reserved).unwrap();
        assert_eq!(metadata.len(), 0);
    }

    #[test]
    fn reserve_temporary_path_leaves_a_writable_file_at_the_reserved_path() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        let reserved = reserve_temporary_path(&destination).unwrap();
        // Stand in for the ffmpeg child process: open the reserved path with a fresh handle,
        // the way ffmpeg itself would, and write the output through it.
        let mut file = OpenOptions::new().write(true).open(&reserved).unwrap();
        file.write_all(b"ffmpeg output").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(fs::read(&reserved).unwrap(), b"ffmpeg output");
    }

    #[test]
    fn two_reservations_for_one_destination_never_share_a_path() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        let first = reserve_temporary_path(&destination).unwrap();
        let second = reserve_temporary_path(&destination).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn replace_file_moves_a_file_over_an_existing_destination() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();
        replace_file(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new contents");
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_directory_that_cannot_be_opened_still_publishes_the_replacement() {
        // The rename is the step that publishes; the parent-directory fsync only adds durability
        // across a crash. A directory with mode 0o300 grants the write and search permissions
        // `rename(2)` needs and withholds the read permission `File::open` needs, so it separates
        // the two steps without a file-descriptor limit or an unmount.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("value.txt");
        fs::write(&destination, b"old contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        fs::set_permissions(&directory.path, fs::Permissions::from_mode(0o300)).unwrap();
        let directory_opens = File::open(&directory.path).is_ok();
        let result = replace_file(&source, &destination);
        fs::set_permissions(&directory.path, fs::Permissions::from_mode(0o700)).unwrap();

        if directory_opens {
            // A process that ignores the mode -- root, most often -- cannot reach the case this
            // test exists for, so it claims nothing.
            return;
        }
        result.expect("a failed parent-directory fsync must not be reported as a failed rename");
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"new contents",
            "the rename published, so the caller must not be told that it did not"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_destination_is_refused_rather_than_overwritten() {
        // The Unix twin of the Windows test of the same name, and the guard's whole reason to
        // exist: `rename(2)` needs the write and search permissions on the parent *directory*,
        // not any permission on the destination file, so without this guard a `chmod 444`
        // destination is replaced in silence on macOS (ADR 015).
        //
        // Note the difference from the Windows twin, and do not copy its restore dance:
        // `remove_dir_all` deletes a 0o444 file inside a writable directory on Unix, so `Drop`
        // cleans up whatever these assertions do and the mode needs no restoring first.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"protected contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o444)).unwrap();

        let error = replace_file(&source, &destination).unwrap_err();

        assert_eq!(
            error.kind(),
            io::ErrorKind::PermissionDenied,
            "a read-only destination must be refused as PermissionDenied, got {error:?}"
        );
        assert_eq!(
            error.raw_os_error(),
            None,
            "no system call was made, so the refusal carries no operating-system code and every \
             caller drops its message (ADR 011)"
        );
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"protected contents",
            "the protected destination must keep its contents"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_bytes_atomically_refuses_a_read_only_destination_and_leaves_no_temporary_file() {
        // The refusal happens after `create_temporary_file`, so the cleanup guard is what keeps
        // the settings folder clean when the destination is protected.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let path = directory.path.join("settings.json");
        fs::write(&path, b"protected contents").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

        let error = write_bytes_atomically(&path, b"new contents").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"protected contents");
        let leftover = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover, "the refused write must leave no temporary file");
    }

    #[cfg(unix)]
    #[test]
    fn a_replacement_carries_the_destinations_permission_bits() {
        // A replacement writes a fresh inode, so without the copy a settings file the user
        // narrowed came back wider after the very first save, with no error to notice.
        //
        // The mode is 0o470 rather than the obvious 0o600, and every bit of it is chosen so that
        // the assertion is red if either half of the mode handling is deleted:
        // - the group execute bit is one `0o666 & !umask` can never produce, so the test does not
        //   depend on this machine's umask. Under `umask 077` a 0o600 assertion passes with the
        //   whole mode copy deleted, which is what made the earlier version of this test vacuous;
        // - no owner write bit, which is the one bit `create_temporary_file` adds to the mode it
        //   creates the temporary file at. So the temporary file is 0o670 here, and only the
        //   pre-rename copy can bring it back to 0o470;
        // - one write bit for the group, because a mode with no write bit for anybody is
        //   `readonly()` and would be refused instead of replaced.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let path = directory.path.join("settings.json");
        fs::write(&path, b"old contents").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o470)).unwrap();

        write_bytes_atomically(&path, b"new contents").unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o470,
            "the replacement must carry the mode the user set"
        );
        // Without this the test would pass on a replacement that did nothing at all.
        assert_eq!(fs::read(&path).unwrap(), b"new contents");
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_file_is_created_at_the_destinations_own_mode() {
        // The other half of the promise the mode copy makes. The copy fixes the destination's
        // final state; this fixes the transit. Without it the new bytes are written and synced
        // into a `0o666 & !umask` file, so a settings file narrowed to 0o600 is world-readable
        // for the length of the write -- and on the export path, where ffmpeg writes the whole
        // encode into the reservation, for the length of the encode.
        //
        // `reserve_temporary_path` is what makes this observable: it hands the path back rather
        // than keeping the window inside one call.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).unwrap();

        let reserved = reserve_temporary_path(&destination).unwrap();

        assert_eq!(
            fs::metadata(&reserved).unwrap().permissions().mode() & 0o777,
            0o600,
            "the reservation ffmpeg writes the encode into must not be wider than the \
             destination it is aimed at"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_file_next_to_a_destination_with_no_owner_write_bit_is_still_writable() {
        // Why `create_temporary_file` adds the owner write bit to the mode it reads. A 0o470
        // destination is not `readonly()` -- the group write bit is set -- so it is replaced, not
        // refused, and an export aimed at it must therefore work. Created at a bare 0o470 the
        // reservation would be one nothing can write, and ffmpeg would fail to open its own
        // output with a diagnostic pointing nowhere near the cause.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o470)).unwrap();

        let reserved = reserve_temporary_path(&destination).unwrap();

        // Stand in for the ffmpeg child: a fresh handle on the reserved path, the way ffmpeg
        // opens it, rather than the handle this process already had.
        let mut file = OpenOptions::new().write(true).open(&reserved).unwrap();
        file.write_all(b"ffmpeg output").unwrap();
        drop(file);
        assert_eq!(fs::read(&reserved).unwrap(), b"ffmpeg output");
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_file_for_a_missing_destination_keeps_the_default_creation_mode() {
        // A missing destination has no mode to read, so the historic `0o666 & !umask` must
        // survive unchanged: narrowing this case to 0o600 would silently make every newly
        // exported video owner-only, which is not a change this module may make on its own.
        //
        // The expected mode comes from a `File::create` next to it rather than from a literal,
        // because `File::create` opens with the same 0o666 the umask then narrows. That keeps the
        // assertion exact on every machine without reading the umask.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        let default_mode = {
            let witness = directory.path.join("witness.txt");
            File::create(&witness).unwrap();
            fs::metadata(&witness).unwrap().permissions().mode() & 0o777
        };

        let reserved = reserve_temporary_path(&destination).unwrap();

        assert_eq!(
            fs::metadata(&reserved).unwrap().permissions().mode() & 0o777,
            default_mode,
            "a missing destination must leave the creation mode exactly as it was"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_replacement_into_a_missing_destination_needs_no_mode_to_carry() {
        // There is nothing to read a mode from, so the guard must stay out of the way rather
        // than manufacture an error. No exact mode is asserted: the temporary file arrives with
        // `0o666 & !umask`, and umask varies by machine.
        let directory = TestDirectory::new();
        let path = directory.path.join("settings.json");

        write_bytes_atomically(&path, b"new contents").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new contents");
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_that_is_a_symlink_to_a_read_only_file_is_still_replaced() {
        // This pins that the guard reads the link and not its target. `rename(2)` replaces the
        // link itself, so the protected file the link pointed at is never touched -- and a guard
        // that followed the link would refuse a replacement that harms nothing.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let target = directory.path.join("target.txt");
        fs::write(&target, b"protected contents").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o444)).unwrap();
        let destination = directory.path.join("link.txt");
        std::os::unix::fs::symlink(&target, &destination).unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        replace_file(&source, &destination).unwrap();

        assert!(
            !fs::symlink_metadata(&destination)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must have been replaced by the new regular file"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"new contents");
        assert_eq!(
            fs::read(&target).unwrap(),
            b"protected contents",
            "the file the link pointed at must be untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_this_user_can_write_is_not_read_only_and_is_replaced() {
        // The documented gap, in a test rather than only in prose. `Permissions::readonly()` is
        // true only when no write bit is set for anybody, which is the attribute ADR 015 names
        // and the same one the Windows arm reads. A 0o644 destination is therefore replaced.
        //
        // That is the near half of the documented gap. The far half -- a 0o644 destination owned
        // by somebody else, which this process cannot write at all and which `rename(2)`
        // replaces anyway -- is not exercised here, because an unprivileged test cannot create a
        // file it does not own. `replace_file_within`'s documentation carries that case, and why
        // closing it would need a capability probe this module refuses.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o644)).unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        replace_file(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new contents");
    }

    #[cfg(unix)]
    #[test]
    fn a_destination_that_is_a_directory_reports_the_operating_systems_own_error() {
        // The regular-file filter is what keeps the synthetic refusal out of the way of a real
        // kernel error. A raw operating-system code is the proof that the kernel answered: it is
        // also what every caller needs to keep the diagnostic (ADR 011).
        //
        // The `chmod 0o555` is what makes this test about the filter rather than about
        // `rename(2)`. `create_dir` yields `0o777 & !umask` = 0o755, which is not `readonly()`,
        // so with the filter deleted the guard would fall through to the rename anyway and the
        // assertion below would still pass. At 0o555 the directory has no write bit for anybody,
        // so a guard that did not filter on the file type would refuse it synthetically and this
        // test turns red.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::create_dir(&destination).unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o555)).unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        let error = replace_file(&source, &destination).unwrap_err();

        assert!(
            error.raw_os_error().is_some(),
            "a directory destination must report the kernel's own error, got {error:?}"
        );
        assert!(destination.is_dir(), "the destination must be untouched");
    }

    #[test]
    fn the_default_budget_affords_nine_waits_totalling_511_milliseconds() {
        // The schedule comes out of `retry_waits`, the same iterator the Windows loop drives, so
        // this observes the rule rather than a copy of it. The expected waits are bare literals
        // for the reason the transient-code test spells out: a list rebuilt from
        // `replace_retry_delay` would agree with any doubling schedule, including a wrong one.
        //
        // Only the count and the values are observable here, because the Unix arm does not
        // retry at all. That these waits are actually slept is observed by
        // `a_held_destination_spends_the_whole_budget_and_reports_the_operating_system_code`,
        // which times a real call on Windows and still passes unchanged -- the point of keeping
        // the default budget at 511 milliseconds.
        let waits: Vec<Duration> = retry_waits(DEFAULT_REPLACE_BUDGET).collect();
        assert_eq!(
            waits,
            [1u64, 2, 4, 8, 16, 32, 64, 128, 256].map(Duration::from_millis),
            "the default budget must reproduce the fixed schedule this module ran before the \
             budget was a parameter"
        );
        assert_eq!(
            waits.iter().sum::<Duration>(),
            DEFAULT_REPLACE_BUDGET,
            "511 milliseconds is spent exactly, with nothing left for a tenth wait of 512"
        );
    }

    #[test]
    fn a_larger_budget_affords_more_attempts_and_never_a_wait_past_the_cap() {
        let default_waits = retry_waits(DEFAULT_REPLACE_BUDGET).count();
        let budget = Duration::from_secs(30);
        let waits: Vec<Duration> = retry_waits(budget).collect();

        assert!(
            waits.len() > default_waits,
            "a 30-second budget must buy more attempts than 511 milliseconds does, got \
             {} against {default_waits}",
            waits.len()
        );
        assert!(
            waits.iter().all(|wait| *wait <= MAXIMUM_RETRY_WAIT),
            "no single wait may exceed the cap, got {waits:?}"
        );
        assert!(
            waits.contains(&MAXIMUM_RETRY_WAIT),
            "a budget this large must reach the cap rather than keep doubling, got {waits:?}"
        );
        let spent: Duration = waits.iter().sum();
        assert!(spent <= budget, "the schedule must stay inside the budget");
        assert!(
            spent + MAXIMUM_RETRY_WAIT > budget,
            "the schedule must stop only because the next wait no longer fits, and it left \
             {:?} unspent",
            budget - spent
        );
    }

    #[test]
    fn a_budget_below_the_first_wait_yields_no_wait() {
        // An attempt happens for the first rename and for each wait, so no wait means exactly one
        // attempt. That attempt is not observable here -- this drives `retry_waits` as a pure
        // function -- so this test claims only the empty schedule. A budget this small is the
        // caller asking for no retry, not for no rename.
        for budget in [Duration::ZERO, Duration::from_micros(999)] {
            assert_eq!(
                retry_waits(budget).count(),
                0,
                "a budget of {budget:?} cannot afford the first wait of 1 millisecond"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_the_four_transient_sharing_codes_start_a_new_attempt() {
        // Bare literals, not the module's own constants. A test that feeds a module's constants
        // into a predicate matching on those same constants restates them and observes nothing:
        // change ERROR_USER_MAPPED_FILE to 1225 and it still passes, while Windows silently
        // stops retrying mapped-file conflicts.
        for code in [5, 32, 33, 1224] {
            assert!(
                is_transient_sharing_error(&io::Error::from_raw_os_error(code)),
                "operating-system code {code} must start a new attempt"
            );
        }
        // The values themselves are a separate claim, so assert them separately.
        assert_eq!(
            [
                ERROR_ACCESS_DENIED,
                ERROR_SHARING_VIOLATION,
                ERROR_LOCK_VIOLATION,
                ERROR_USER_MAPPED_FILE
            ],
            [5, 32, 33, 1224],
            "the constants must keep the values ADR 015 tabulates"
        );
        // ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND are permanent: no wait clears them.
        for code in [2, 3] {
            assert!(
                !is_transient_sharing_error(&io::Error::from_raw_os_error(code)),
                "operating-system code {code} must fail immediately"
            );
        }
        // An error with no raw operating-system code carries no evidence of a sharing failure.
        assert!(!is_transient_sharing_error(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "no raw operating-system code"
        )));
    }

    #[cfg(windows)]
    #[test]
    fn a_held_destination_spends_the_whole_budget_and_reports_the_operating_system_code() {
        // This test is the guard on the export publication path, and it covers three properties
        // together, from observed behaviour rather than from the constants the loop uses: the
        // attempt count, the total wait, and the fidelity of the reported error. A loop that
        // ran fewer attempts, or that dropped a wait, returns too early. A loop that wrapped or
        // rebuilt the error loses the raw operating-system code, and `map_io_error` in
        // `commands/settings.rs` then drops the diagnostic (ADR 011).
        //
        // What it does not cover: no test reaches layer 2's POSIX-semantics path
        // deterministically. `share_mode(0)` yields ERROR_SHARING_VIOLATION, which never routes
        // there, and the only code-5 route `replace_file` allows is the delete-pending race,
        // which `eight_concurrent_writers_into_one_directory_never_collide_on_a_temporary_name`
        // reaches only under real contention.
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::Instant;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        // A share mode of 0 denies every other open, including the delete a rename needs, and
        // this handle is held for the whole call, so every attempt fails the same way and no
        // layer can succeed.
        let _held_open = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&destination)
            .expect(
                "the test could not take the exclusive handle it needs; another program, a \
                 virus scanner for example, holds the destination this test just wrote",
            );

        let started = Instant::now();
        let error = replace_file(&source, &destination).unwrap_err();
        let elapsed = started.elapsed();

        assert!(
            matches!(
                error.raw_os_error(),
                Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION)
            ),
            "the operating-system error must reach the caller unchanged, got {error:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(511),
            "ten attempts leave nine waits totalling 511 milliseconds, waited {elapsed:?}"
        );
        // The upper bound is tight on purpose, because a loose one observes no attempt count: an
        // eleventh attempt would add a 512-millisecond wait and still finish under a second. The
        // nine `Sleep` calls each round up to the system timer tick, worst case about 15.6
        // milliseconds, so a realistic ceiling is around 650 milliseconds and this bound leaves
        // roughly 370 milliseconds of headroom. It is still a clock standing in for a count: a
        // runner stalled for longer than that headroom fails this line with no regression behind
        // it.
        assert!(
            elapsed < Duration::from_millis(1023),
            "an extra attempt would add a 512-millisecond wait, waited {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_short_budget_reaches_the_retry_loop_and_ends_the_call_early() {
        // The one test that observes `budget` arriving at the Windows loop. Elapsed time is the
        // only thing that can observe it: a loop that ignored `budget` and always spent
        // DEFAULT_REPLACE_BUDGET would report the same operating-system code here, and every
        // other test in this crate would still pass. So this calls `replace_file_within`
        // directly, with a budget no other test passes, and asserts the call is far shorter than
        // the default would have been.
        //
        // The share_mode(0) idiom is
        // `a_held_destination_spends_the_whole_budget_and_reports_the_operating_system_code`'s:
        // every attempt fails the same way, so the call runs the whole schedule.
        use std::os::windows::fs::OpenOptionsExt;
        use std::time::Instant;

        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"old contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        let _held_open = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&destination)
            .expect(
                "the test could not take the exclusive handle it needs; another program, a \
                 virus scanner for example, holds the destination this test just wrote",
            );

        // 7 milliseconds buys the three waits 1, 2 and 4, and therefore four attempts.
        let started = Instant::now();
        let error =
            replace_file_within(&source, &destination, Duration::from_millis(7)).unwrap_err();
        let elapsed = started.elapsed();

        assert!(
            matches!(
                error.raw_os_error(),
                Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION)
            ),
            "the operating-system error must reach the caller unchanged, got {error:?}"
        );
        // Three `Sleep` calls each round up to the system timer tick, worst case about 15.6
        // milliseconds, so a realistic ceiling is around 55 milliseconds. 255 leaves generous
        // headroom for a loaded runner and is still far below the 511 milliseconds the default
        // budget spends, which is the figure this bound exists to exclude.
        assert!(
            elapsed < Duration::from_millis(255),
            "a 7-millisecond budget must not spend the 511 milliseconds the default budget does, \
             waited {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_destination_is_refused_rather_than_overwritten() {
        // `replace_file` routes ERROR_ACCESS_DENIED to `fs::rename`, whose POSIX-semantics path
        // moves a file while ignoring the read-only attribute. This pins the exclusion that
        // keeps it from doing so: a file the user marked read-only must survive.
        let directory = TestDirectory::new();
        let destination = directory.path.join("output.mp4");
        fs::write(&destination, b"protected contents").unwrap();
        let source = directory.path.join("source.tmp");
        fs::write(&source, b"new contents").unwrap();

        let mut permissions = fs::metadata(&destination).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&destination, permissions).unwrap();

        let error = replace_file(&source, &destination).unwrap_err();

        // Clear the read-only bit before the assertions, not after. An assertion that fails is
        // the point of this test, and `remove_dir_all` cannot delete a read-only file on
        // Windows, so a bit cleared after a panic is never cleared and the run leaks a temporary
        // directory.
        let mut permissions = fs::metadata(&destination).unwrap().permissions();
        // The lint warns that this makes a file world writable on Unix. This test is
        // Windows-only, so that hazard cannot arise, and the bit must be cleared for `Drop`
        // to remove the directory.
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&destination, permissions).unwrap();

        assert_eq!(
            error.raw_os_error(),
            Some(ERROR_ACCESS_DENIED),
            "a read-only destination must report code 5, got {error:?}"
        );
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"protected contents",
            "the protected destination must keep its contents"
        );
    }

    #[cfg(windows)]
    #[test]
    fn only_code_5_on_a_writable_destination_routes_to_the_posix_rename() {
        // This is the rule an earlier version of `replace_file` got wrong: it sent every
        // transient code to `fs::rename`, which is layer 1 minus MOVEFILE_WRITE_THROUGH, and so
        // it surrendered durability for nothing on the three sharing codes. Nothing else in this
        // suite catches that. `a_held_destination_...` spends the same budget and reports the
        // same code on either route, and `only_the_four_transient_sharing_codes_...` tests the
        // transient set, not the route.
        let directory = TestDirectory::new();
        let writable = directory.path.join("writable.mp4");
        fs::write(&writable, b"contents").unwrap();

        assert!(
            routes_to_posix_rename(&io::Error::from_raw_os_error(5), &writable),
            "code 5 on a writable destination must take layer 2, the one route that clears the \
             delete-pending race"
        );
        for code in [32, 33, 1224] {
            assert!(
                !routes_to_posix_rename(&io::Error::from_raw_os_error(code), &writable),
                "operating-system code {code} must stay on layer 1 and keep MOVEFILE_WRITE_THROUGH"
            );
        }

        let read_only = directory.path.join("read-only.mp4");
        fs::write(&read_only, b"protected contents").unwrap();
        let mut permissions = fs::metadata(&read_only).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&read_only, permissions).unwrap();

        let routed = routes_to_posix_rename(&io::Error::from_raw_os_error(5), &read_only);

        // Clear the bit before asserting, so a failure still leaves a directory `Drop` can
        // remove.
        let mut permissions = fs::metadata(&read_only).unwrap().permissions();
        // The lint warns that this makes a file world writable on Unix. This test is
        // Windows-only, so that hazard cannot arise.
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&read_only, permissions).unwrap();

        assert!(
            !routed,
            "code 5 on a read-only destination must stay on layer 1: layer 2 ignores the \
             read-only attribute and would overwrite a file the user protected"
        );
    }

    struct TestDirectory {
        path: PathBuf,
    }
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-fsutil-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("could not create test directory: {error}"),
                }
            }
            panic!("could not create a unique test directory")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
