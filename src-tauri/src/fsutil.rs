//! Shared atomic-file-replacement machinery.
//!
//! `project::save` and `ffmpeg::capabilities::cache::write` both need to write a file so that
//! no reader ever observes a half-written result: write the new bytes to a fresh temporary
//! file in the destination's own directory, then rename that file over the destination. A
//! rename within one directory is atomic on every platform this application targets, so a
//! reader always sees either the previous contents or the complete new ones, never a mix of
//! both. This module holds that machinery once. A settings module and the ADR 004 export
//! output file are the next two callers.
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
fn create_temporary_file(path: &Path) -> io::Result<(PathBuf, File)> {
    let directory = parent_directory(path);
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing destination file name")
    })?;
    for _ in 0..100 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(".tmp-{}-{sequence}", std::process::id()));
        let temporary_path = directory.join(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
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

/// Replace `destination` with `source` in one atomic step.
///
/// A plain rename is already atomic on Unix, so this only adds the directory fsync that makes
/// the rename itself durable across a crash.
///
/// [`write_bytes_atomically`] is one caller. The export renderer (ADR 004, ADR 014) is a
/// second, direct one: it calls this itself once the `ffmpeg` process it spawned has finished
/// writing the path [`reserve_temporary_path`] reserved, to move that output over the
/// destination the user chose.
#[cfg(unix)]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    File::open(parent_directory(destination))?.sync_all()
}

/// Replace `destination` with `source` in one atomic step.
///
/// Plain `fs::rename` on Windows fails when `destination` already exists, so this calls
/// `MoveFileExW` directly with `MOVEFILE_REPLACE_EXISTING` to get the same atomic-replace
/// semantics as the Unix rename, plus `MOVEFILE_WRITE_THROUGH` so the call does not return
/// until the replace is durable on disk.
///
/// [`write_bytes_atomically`] is one caller. The export renderer (ADR 004, ADR 014) is a
/// second, direct one: it calls this itself once the `ffmpeg` process it spawned has finished
/// writing the path [`reserve_temporary_path`] reserved, to move that output over the
/// destination the user chose. `ffmpeg` must have closed its own handle to the source by then,
/// or this call fails the same way an in-process caller's leftover handle would.
#[cfg(windows)]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source = absolute_path_without_following_file(source)?;
    let destination = absolute_path_without_following_file(destination)?;
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

/// Resolve `path` to an absolute path without following it as a symlink, for `MoveFileExW`.
///
/// `Path::canonicalize` would follow `path` itself if it names a symlink, which is wrong for a
/// rename endpoint; canonicalizing only the parent directory and rejoining the file name avoids
/// that while still producing the absolute path `MoveFileExW` needs.
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
/// fsync nor the Windows `MoveFileExW` treatment has a portable equivalent here.
///
/// [`write_bytes_atomically`] is one caller. The export renderer (ADR 004, ADR 014) is a
/// second, direct one: it calls this itself once the `ffmpeg` process it spawned has finished
/// writing the path [`reserve_temporary_path`] reserved, to move that output over the
/// destination the user chose. QuipClip does not ship on such a platform today, but this keeps
/// the module buildable on one.
#[cfg(not(any(unix, windows)))]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
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
