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
#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    File::open(parent_directory(destination))?.sync_all()
}

/// Replace `destination` with `source` in one atomic step.
///
/// Plain `fs::rename` on Windows fails when `destination` already exists, so this calls
/// `MoveFileExW` directly with `MOVEFILE_REPLACE_EXISTING` to get the same atomic-replace
/// semantics as the Unix rename, plus `MOVEFILE_WRITE_THROUGH` so the call does not return
/// until the replace is durable on disk.
#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
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
#[cfg(not(any(unix, windows)))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

/// An armed guard that deletes a temporary file unless [`disarm`](Self::disarm) is called.
///
/// [`write_bytes_atomically`] arms this right after creating the temporary file and disarms it
/// only once the rename over the destination has succeeded, so the temporary file is removed on
/// every early return -- a failed write, a failed sync, or a failed rename -- and left alone
/// only after it no longer exists under its temporary name.
struct TemporaryFileCleanup {
    path: PathBuf,
    armed: bool,
}

impl TemporaryFileCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
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
