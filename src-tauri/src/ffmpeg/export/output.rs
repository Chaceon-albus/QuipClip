//! The temporary export output file, from its reservation to either a commit or a removal.
//!
//! ADR 004 requires the renderer to "write a temporary output in the destination directory and
//! rename it on success", and ADR 014's "Other rules" repeats it. The reason is the one
//! [`crate::fsutil`] already records for the project file and the capability cache: a rename
//! inside one directory is atomic, so nothing that reads the destination -- the user's file
//! manager, a media player, a second export -- ever observes a half-muxed video at the path the
//! user chose.
//!
//! The export differs from those two callers in the one way that decides the shape of this
//! module: the bytes are written by a **separate `ffmpeg` process**, not by this one. There is no
//! `File` here to write and sync, so [`crate::fsutil::write_bytes_atomically`] does not apply.
//! [`PendingOutput`] therefore splits that function's body across the lifetime of a child
//! process: reserve a path, hand the bare path out for `ffmpeg` to write, and then either rename
//! it over the destination or delete it.
//!
//! **The removal is a drop guard, not a cleanup call.** Every step between the reservation and
//! the rename can fail: `ffmpeg` discovery fails, the spawn fails, the child exits non-zero, the
//! final frame count does not match (ADR 014's `frameCountMismatch`), the user cancels, or a
//! worker panics parsing a progress line. Only the last of those is beyond the reach of a `?` and
//! a `match`, and it is the one that matters most, because what a missed cleanup leaves behind is
//! a zero-length `.movie.mp4.tmp-1234-0` sitting in the folder the user picked for their video --
//! not in a system temporary directory nobody looks at. [`PendingOutput`] therefore removes the
//! reservation on [`Drop`] unless [`PendingOutput::commit`] has succeeded, exactly as
//! [`super::registry::ExportSlot`] releases the export slot on drop rather than trusting a worker
//! to release it on every exit path. The removal itself is
//! [`crate::fsutil::TemporaryFileCleanup`], which is `pub(crate)` for this module's benefit; this
//! module hand-rolls no `remove_file` of its own.
//!
//! **Two obligations land on the `ffmpeg` command line.** They are stated again on
//! [`PendingOutput::reserve`] and [`PendingOutput::path`], because dropping either one breaks
//! every export -- and the first one breaks it silently:
//!
//! - `-y` is mandatory. The reservation creates the file, so the output path already exists, and
//!   is zero bytes, before `ffmpeg` starts. ADR 004 also requires `-nostdin`, so `ffmpeg` cannot
//!   prompt about it; measured on ffmpeg 9.0.1, it prints `File '<path>' already exists. Exiting.`
//!   and stops. Do not go looking for `Not overwriting - exiting`: that is the reply to the
//!   interactive prompt, and `-nostdin` is precisely the flag that guarantees the prompt never
//!   runs.
//!
//!   **That refusal exits zero.** fftools maps `AVERROR_EXIT` to exit code 0, so the child
//!   reports success while the reservation still holds the zero bytes this module created it
//!   with. A process stage that gates [`PendingOutput::commit`] on the exit status alone
//!   therefore publishes an empty file over the video the user asked for, and nothing anywhere
//!   reports an error. This module cannot detect it: a zero-byte reservation `ffmpeg` refused to
//!   touch is byte-for-byte a reservation `ffmpeg` has not written to yet. ADR 014's frame-count
//!   comparison is the only thing that catches it -- `frame` never reaches
//!   [`super::ExportPlan::expected_frames`], so the renderer reports `frameCountMismatch` and
//!   never reaches `commit` at all.
//! - An explicit `-f <muxer>` is mandatory. The reserved name ends in `.tmp-{pid}-{sequence}`,
//!   not in `.mp4`, so `ffmpeg` has no extension to infer a muxer from. ADR 014's "The command"
//!   section already carries `-f` for this reason; `mkv` selects the muxer `matroska`.

use crate::fsutil::{replace_file, reserve_temporary_path, TemporaryFileCleanup};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

/// A reserved temporary output file and the destination it is waiting to become.
///
/// The value owns the reservation for the whole render. Dropping it -- by returning, by `?`, or
/// by unwinding out of a panic -- deletes the reserved file, unless [`PendingOutput::commit`] has
/// already renamed it over the destination and disarmed the guard. That makes "the temporary file
/// is cleaned up" a property of the type rather than a rule every exit path of the process stage
/// has to remember.
///
/// The type deliberately holds no `File` handle. `ffmpeg` opens the path itself, so a handle kept
/// here would serve nothing and would only add a dependency on what share flags the child's own
/// open uses, and on the muxer being free to re-open its output for a second pass (which
/// `-movflags +faststart` does). [`crate::fsutil::reserve_temporary_path`] closes its handle for
/// the same reason.
#[must_use = "a PendingOutput deletes its reserved file when it is dropped, so a reservation \
              that is not bound for the lifetime of the render is gone before ffmpeg can write \
              to it"]
pub struct PendingOutput {
    /// The reserved path, plus the armed removal that runs on drop.
    ///
    /// This is [`crate::fsutil::TemporaryFileCleanup`], the same guard
    /// [`crate::fsutil::write_bytes_atomically`] arms around its own temporary file, reused
    /// rather than reimplemented: that visibility is `pub(crate)` precisely so this module can
    /// take it. The path lives inside the guard rather than beside it so the two can never
    /// disagree about which file the drop deletes.
    cleanup: TemporaryFileCleanup,
    /// The final path the user chose, which [`PendingOutput::commit`] renames the reservation
    /// over.
    ///
    /// It is captured at reservation time rather than taken as an argument by
    /// [`PendingOutput::commit`], and that makes one destructive mistake unrepresentable. A
    /// `commit(destination)` signature invites a caller to hand over the export's *source* path
    /// -- the two travel together in every plan, and [`super::ExportPlan`] holds them as adjacent
    /// fields. That rename is same-filesystem and atomic, so it would succeed in silence, and the
    /// user's input video would be gone, overwritten by the export cut out of it. (Naming some
    /// unrelated directory is the harmless half of the same slip: a cross-filesystem rename fails
    /// loudly with `EXDEV`.) There is no argument to get wrong when there is no argument.
    destination: PathBuf,
}

// The pending output is created on the thread that sets the export up and moves to the blocking
// worker that supervises `ffmpeg`, and it is dropped on whichever of the two unwinds first, so it
// needs `Send + 'static`. That obligation is pinned here as a compile-time assertion rather than
// left to the distant call site, exactly as `registry` pins the same property of `ExportSlot`: a
// future field that is not thread-safe -- an `Rc`, a `Cell`, a raw pointer -- would otherwise
// compile cleanly in this module and fail only in the unit that spawns the worker.
//
// The bound asks for `Sync` as well as `Send`, and the `Cell` in that list is the reason.
// `Cell<T>` is `Send` whenever `T` is, so a `Send`-only assertion would wave it straight through;
// only `!Sync` catches it. `PendingOutput` is already `Sync`, so asking for both costs nothing
// and keeps the assertion as strong as the sentence above claims it is.
const _: () = {
    const fn assert_send_and_sync<T: Send + Sync + 'static>() {}
    assert_send_and_sync::<PendingOutput>();
};

impl PendingOutput {
    /// Reserve a temporary file next to `destination` for the `ffmpeg` child to write.
    ///
    /// The reservation lands in `destination`'s own directory, never a system temporary
    /// directory, so [`PendingOutput::commit`] can finish with a rename inside one directory --
    /// atomic, and free -- instead of a cross-filesystem copy of a file that can be gigabytes.
    /// [`crate::fsutil::reserve_temporary_path`] picks the name,
    /// `.{file_name}.tmp-{pid}-{sequence}`, and creates it with `create_new`, so no second writer
    /// can claim the same name between this call and `ffmpeg` opening it.
    ///
    /// # The two flags the caller's command must carry
    ///
    /// Because the reservation *creates* the file, the output path exists and is zero bytes
    /// before `ffmpeg` starts. The command that receives [`PendingOutput::path`] must therefore
    /// pass `-y`: ADR 004 also requires `-nostdin`, and an `ffmpeg` that may neither prompt nor
    /// overwrite prints `File '<path>' already exists. Exiting.` and gives up. It must also pass
    /// an explicit `-f <muxer>`, since the reserved name's extension is `.tmp-{pid}-{sequence}`
    /// rather than the destination's, so no muxer can be inferred from it.
    ///
    /// Note the exit status of that refusal is **zero**, so a caller that checks only the exit
    /// status will go on to [`PendingOutput::commit`] and publish an empty file over the user's
    /// destination. The module documentation carries the full note; ADR 014's frame-count
    /// comparison is what stands between a missing `-y` and a silently empty export.
    ///
    /// # Errors
    ///
    /// Returns the `io::Error` from the reservation: `destination` has no file name, its
    /// directory refuses the new file (missing, read-only, out of space), 100 consecutive
    /// generated names collided, or the generated name was itself too long. That last one is
    /// inherited, not introduced here: [`crate::fsutil::reserve_temporary_path`] documents that a
    /// `destination` file name close to the platform's `NAME_MAX` can push
    /// `.{file_name}.tmp-{pid}-{sequence}` past the limit, which then surfaces as `ENAMETOOLONG`
    /// instead of retrying as `AlreadyExists`. The export renderer reports all of these as
    /// [`super::ExportErrorCode::OutputNotWritable`]. Nothing is created on any of those paths,
    /// so there is nothing to clean up and no guard is armed.
    ///
    /// # This is not a preflight check on the destination
    ///
    /// A `destination` that is an existing *directory* reserves successfully. The reservation is
    /// assembled from the parent directory and the file name, and both of those are perfectly
    /// usable when the file name happens to name a folder; the failure surfaces only at
    /// [`PendingOutput::commit`], because no platform renames a file over a directory. A user who
    /// picks a folder therefore sits through an entire encode before anything reports the
    /// problem. Rejecting that case belongs ahead of this call, in the planning stage -- do not
    /// read a successful reservation as evidence that the destination is writable as a file.
    pub fn reserve(destination: &Path) -> io::Result<Self> {
        let reserved = reserve_temporary_path(destination)?;
        Ok(Self {
            cleanup: TemporaryFileCleanup::new(reserved),
            destination: destination.to_path_buf(),
        })
    }

    /// The reserved path, to pass to `ffmpeg` as its output argument.
    ///
    /// The file at this path already exists and is empty, so the command must carry `-y` and an
    /// explicit `-f <muxer>`; see [`PendingOutput::reserve`] for why each one is mandatory.
    ///
    /// This is a borrow, not an owned `PathBuf`, and what that buys is one specific compile
    /// error: `let reserved = pending.path(); pending.commit();` is rejected as E0505, because
    /// `commit` consumes the value the path is borrowed from. Holding the reserved name across
    /// the call that renames it away is worth catching at compile time.
    ///
    /// It does not stop the path from outliving the file, and it cannot. The ordinary way to use
    /// this -- `command.arg(pending.path())` -- ends the borrow immediately, because
    /// `Command::arg` copies into an `OsString` of its own, so
    /// `command.arg(pending.path()); drop(pending);` compiles cleanly and hands `ffmpeg` the name
    /// of a file the drop has already deleted. Keeping the [`PendingOutput`] alive until the
    /// child has exited is the caller's obligation; the borrow checker does not carry it.
    #[must_use]
    pub fn path(&self) -> &Path {
        self.cleanup.path()
    }

    /// The final destination this reservation will be renamed over.
    ///
    /// The process stage reports this path once the export completes, and names it in an error,
    /// so it does not have to carry the destination alongside this value and risk the two
    /// disagreeing.
    #[must_use]
    pub fn destination(&self) -> &Path {
        &self.destination
    }

    /// Publish the rendered output: rename the temporary file over the destination.
    ///
    /// This is the one step a reader of the destination can observe, and
    /// [`crate::fsutil::replace_file`] makes it atomic and durable on each platform -- a rename
    /// plus a directory fsync on Unix, `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING |
    /// MOVEFILE_WRITE_THROUGH` on Windows, which also lets the rename replace an existing
    /// destination that a plain `fs::rename` would refuse there.
    ///
    /// # What the caller must have done first
    ///
    /// The `ffmpeg` child must have exited and closed its own handle to the reserved path. On
    /// Windows a live handle in the child fails this call outright; on Unix it would publish a
    /// truncated file instead, which is worse. ADR 014's frame-count comparison and
    /// [`super::registry::ExportSlot::is_canceled`] both belong before this call as well: a
    /// cancel that arrives while `ffmpeg` is finishing must discard the output rather than leave
    /// the user with a published file and a message that says the export was cancelled.
    ///
    /// # A destination that is a symlink is replaced, not written through
    ///
    /// [`crate::fsutil::replace_file`] never resolves the destination's final component: on Unix
    /// `fs::rename` does not follow it, and the Windows arm canonicalizes only the parent
    /// directory, deliberately, for exactly this reason. So a destination that is a symlink ends
    /// up a regular file holding the export, and whatever it pointed at is left untouched. That
    /// is what `mv` does, and what [`crate::fsutil::write_bytes_atomically`] already does for the
    /// project file and the settings, so this is the behaviour the rest of the application is
    /// consistent with rather than a quirk of the export.
    ///
    /// # Errors
    ///
    /// Returns the `io::Error` from the rename, reported by the renderer as
    /// [`super::ExportErrorCode::OutputRenameFailed`]. A failure leaves `destination` exactly as
    /// it was, and the temporary file is still deleted, because `self` is consumed here and its
    /// guard is disarmed only after the rename has succeeded.
    pub fn commit(mut self) -> io::Result<()> {
        replace_file(self.cleanup.path(), &self.destination)?;
        // The disarm buys little on this path, and is kept because it is honest and free: the
        // guard targets the *temporary* name, and the rename just moved that name away, so an
        // armed drop here would call `remove_file` on a path that no longer exists, take
        // `NotFound`, and swallow it. It cannot reach the published destination. Do not read this
        // line as the thing that protects the finished export -- nothing has to.
        //
        // Where this line sits is what matters, and it matters above, on the failure path. The
        // `?` returns with the guard still armed, and that is what deletes the temporary file
        // after a rename that failed. Disarming before the rename would strand a reservation on
        // every failed commit; the test named
        // `a_failed_commit_leaves_the_destination_untouched_and_still_removes_the_temporary_file`
        // is what fails if anyone moves it.
        self.cleanup.disarm();
        Ok(())
    }
}

/// Written by hand because [`crate::fsutil::TemporaryFileCleanup`] does not implement [`Debug`],
/// and this type is worth logging: the process stage records which temporary path it handed to
/// `ffmpeg`. Deriving would require changing `fsutil`, so the two fields are formatted directly.
impl fmt::Debug for PendingOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingOutput")
            .field("path", &self.path())
            .field("destination", &self.destination)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Stand in for the `ffmpeg` child: open the reserved path with a fresh handle, the way the
    /// child would, and write the rendered output through it.
    fn write_as_ffmpeg_would(path: &Path, contents: &[u8]) {
        fs::write(path, contents).expect("the reserved path must be writable by another opener");
    }

    /// Every entry of `directory` whose name carries the reservation marker.
    fn leftover_temporary_files(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .expect("the test directory must be readable")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().contains(".tmp-"))
            })
            .collect()
    }

    #[test]
    fn reserve_places_the_temporary_file_in_the_destinations_own_directory() {
        // A reservation in the system temporary directory would turn `commit` into a
        // cross-filesystem copy of a file that can be gigabytes, and it would stop being atomic.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        let pending = PendingOutput::reserve(&destination).unwrap();

        assert_eq!(
            pending.path().parent(),
            Some(directory.path.as_path()),
            "the reservation must share the destination's directory so the rename stays on one \
             filesystem"
        );
        assert_eq!(pending.destination(), destination);
    }

    #[test]
    fn reserve_leaves_an_empty_file_at_the_path_it_hands_to_ffmpeg() {
        // The file existing before ffmpeg starts is what forces `-y` on the command line, and
        // the name it exists under is what forces an explicit `-f <muxer>`.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        let pending = PendingOutput::reserve(&destination).unwrap();

        let metadata = fs::metadata(pending.path()).expect("the reserved path must exist");
        assert!(metadata.is_file());
        assert_eq!(metadata.len(), 0);
        assert!(
            pending
                .path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".tmp-"),
            "the reserved name carries no usable extension, which is why the command must pass \
             an explicit -f <muxer>"
        );
    }

    #[test]
    fn dropping_a_pending_output_without_a_commit_removes_the_reserved_file() {
        // The plain shape of every early failure: discovery fails, the spawn fails, ffmpeg exits
        // non-zero, the frame count does not match, or the user cancels.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        let reserved = {
            let pending = PendingOutput::reserve(&destination).unwrap();
            write_as_ffmpeg_would(pending.path(), b"a partly muxed video");
            pending.path().to_path_buf()
        };

        assert!(
            !reserved.exists(),
            "the drop must not leave a temporary file in the folder the user picked"
        );
        assert!(
            !destination.exists(),
            "an abandoned render must publish nothing"
        );
        assert!(leftover_temporary_files(&directory.path).is_empty());
    }

    #[test]
    fn commit_publishes_the_render_when_the_destination_does_not_exist_yet() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        let pending = PendingOutput::reserve(&destination).unwrap();
        let reserved = pending.path().to_path_buf();
        write_as_ffmpeg_would(pending.path(), b"the rendered movie");

        pending.commit().unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"the rendered movie");
        assert!(!reserved.exists(), "the temporary name must be gone");
        assert!(leftover_temporary_files(&directory.path).is_empty());
    }

    #[test]
    fn commit_replaces_an_existing_destination_with_the_new_contents() {
        // Re-exporting over a previous export is ordinary use, and on Windows a plain
        // `fs::rename` would refuse it; `fsutil::replace_file` is what makes it work.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        fs::write(&destination, b"a movie exported earlier").unwrap();
        let pending = PendingOutput::reserve(&destination).unwrap();
        write_as_ffmpeg_would(pending.path(), b"the movie exported now");

        pending.commit().unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"the movie exported now");
        assert!(leftover_temporary_files(&directory.path).is_empty());
    }

    #[test]
    fn a_committed_destination_survives_the_drop_that_follows_the_commit() {
        // A plain end-to-end regression check, and deliberately no more than that. It does not
        // pin `commit`'s disarm, and it cannot: after a successful rename the reserved name is
        // gone, so even an armed guard would only take `NotFound` from `remove_file` and swallow
        // it. Delete the disarm and this test stays green. What pins the disarm is its position,
        // and the test that fails when it moves above the rename is
        // `a_failed_commit_leaves_the_destination_untouched_and_still_removes_the_temporary_file`.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        {
            let pending = PendingOutput::reserve(&destination).unwrap();
            write_as_ffmpeg_would(pending.path(), b"the rendered movie");
            pending.commit().unwrap();
        }

        assert!(
            destination.exists(),
            "the drop after a successful commit must not delete the published export"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"the rendered movie");
    }

    #[test]
    fn a_failed_commit_leaves_the_destination_untouched_and_still_removes_the_temporary_file() {
        // A destination that names a directory makes the rename fail on every platform this
        // application targets, without needing a permission trick that differs between them.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("occupant.txt"), b"not ours to delete").unwrap();

        let pending = PendingOutput::reserve(&destination).unwrap();
        let reserved = pending.path().to_path_buf();
        write_as_ffmpeg_would(pending.path(), b"the rendered movie");

        assert!(
            pending.commit().is_err(),
            "renaming a file over a directory must fail"
        );
        assert!(
            !reserved.exists(),
            "a failed commit must still remove the temporary file"
        );
        assert!(destination.is_dir(), "the destination must be untouched");
        assert_eq!(
            fs::read(destination.join("occupant.txt")).unwrap(),
            b"not ours to delete"
        );
        assert!(leftover_temporary_files(&directory.path).is_empty());
    }

    #[test]
    fn a_panic_between_reserve_and_commit_removes_the_reserved_file() {
        // The exit path no `?` and no `match` covers, and the reason the removal is a drop guard
        // rather than a cleanup call: a worker that panics -- a slice index on a malformed
        // progress line, a `PoisonError` from some other lock -- never reaches any cleanup it
        // was supposed to run. Without the guard it strands a zero-length
        // `.movie.mp4.tmp-{pid}-{sequence}` in the folder the user picked for their video.
        let directory = TestDirectory::new();
        let destination = directory.path.join("movie.mp4");
        let mut reserved = None;

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let pending = PendingOutput::reserve(&destination).unwrap();
            write_as_ffmpeg_would(pending.path(), b"a partly muxed video");
            reserved = Some(pending.path().to_path_buf());
            panic!("the export worker panics before it can commit the output");
        }));

        assert!(outcome.is_err(), "the closure should have panicked");
        let reserved = reserved.expect("the reservation must have been made before the panic");
        assert!(
            !reserved.exists(),
            "an unwinding worker must not strand a temporary file in the output folder"
        );
        assert!(
            !destination.exists(),
            "a panicking render must publish nothing"
        );
        assert!(leftover_temporary_files(&directory.path).is_empty());
    }

    /// A unique, self-deleting directory under the system temporary directory.
    ///
    /// This crate has no `tempfile` dependency, so `fsutil` and `project` each hand-roll this
    /// same struct; this is the third copy, kept identical to those two on purpose rather than
    /// hoisted into a shared test helper, which would need a new `#[cfg(test)]` module reachable
    /// from three places.
    struct TestDirectory {
        path: PathBuf,
    }
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-export-output-test-{}-{sequence}",
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
