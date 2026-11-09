//! Whether an FLV still holds the revision of its import while a recorder writes it (ADR 058).
//!
//! A revision is the path, the size and the modification time that the import read (ADR 010).
//! A recorder that still writes an FLV adds bytes after that size, so each later read of the file
//! gives another size and another modification time. The file still holds the revision when its
//! first `size` bytes did not change, because every reader of an FLV source stops at that size
//! ([`super::FlvSource::open_within`]).
//!
//! The import keeps a fingerprint of the last bytes in front of that size, and a later check reads
//! the same bytes again. The fingerprint starts after the first frame. A recorder that ends a
//! recording can write the duration, the size and a keyframe index into `onMetaData` in place,
//! and that does not change a frame. A recorder that starts the file again, or that moves the
//! frames to make room for an index, changes the bytes of the fingerprint.

use super::cache::Revision;
use super::head::FlvHead;
use super::reader::{read_exact_at, ByteSource, FileSource};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// The most bytes in front of the size of a revision that its fingerprint covers.
pub const FINGERPRINT_LEN: u64 = 64 * 1024;

/// The number of revisions whose fingerprints the process keeps. The oldest goes first.
const KEEP_FINGERPRINTS: usize = 256;

/// How a file compares with a revision of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The file has the size and the modification time of the revision.
    Same,
    /// The file is an FLV whose first `size` bytes hold the revision, as far as the fingerprint
    /// shows. A recorder added bytes to it, or wrote its head in place. A reader that stops at
    /// the size of the revision reads the revision.
    Grown,
    /// The file does not hold the revision, or nothing shows that it does.
    Changed,
}

/// The FNV-1a hash of the bytes `[start, size)` of a revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    start: u64,
    hash: u64,
}

static FINGERPRINTS: Mutex<Vec<(Revision, Fingerprint)>> = Mutex::new(Vec::new());

fn fingerprints() -> MutexGuard<'static, Vec<(Revision, Fingerprint)>> {
    FINGERPRINTS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// Read and keep the fingerprint of `revision`, the revision of the FLV at `path`
/// ([`fingerprint`] and [`keep`]).
pub fn remember(revision: &Revision, path: &Path) {
    if let Some(fingerprint) = fingerprint(path, revision.size) {
        keep(revision, fingerprint);
    }
}

/// The fingerprint of the first `size` bytes of the FLV at `path`. A file that the FLV reader
/// cannot read, or whose first `size` bytes hold no frame, has none. Only [`Verdict::Same`] can
/// then hold for its revision. The import reads it right after it reads the size, so the bytes
/// are those of the revision also when a recorder starts the file again during the probe.
pub fn fingerprint(path: &Path, size: u64) -> Option<Fingerprint> {
    read_fingerprint(path, size)
}

/// Keep `fingerprint` as the fingerprint of `revision`.
pub fn keep(revision: &Revision, fingerprint: Fingerprint) {
    let mut kept = fingerprints();
    kept.retain(|(known, _)| known != revision);
    if kept.len() >= KEEP_FINGERPRINTS {
        kept.remove(0);
    }
    kept.push((revision.clone(), fingerprint));
}

/// Compare the file at `path`, which has `size` bytes and the modification time `mtime` now, with
/// `revision`. `path` is the canonical path that `revision.path` names.
pub fn verdict(revision: &Revision, path: &Path, size: u64, mtime: i64) -> Verdict {
    if size == revision.size && mtime == revision.mtime {
        return Verdict::Same;
    }
    if size < revision.size || mtime < revision.mtime {
        return Verdict::Changed;
    }
    // The copy releases the lock before the read, which can wait for a share.
    let known = fingerprints()
        .iter()
        .find(|(known, _)| known == revision)
        .map(|(_, fingerprint)| *fingerprint);
    let Some(known) = known else {
        return Verdict::Changed;
    };
    match hash_of_file(path, known.start, revision.size) {
        Some(hash) if hash == known.hash => Verdict::Grown,
        _ => Verdict::Changed,
    }
}

/// The fingerprint of the first `size` bytes of the FLV at `path`.
fn read_fingerprint(path: &Path, size: u64) -> Option<Fingerprint> {
    let mut source = FileSource::open_within(path, size, None).ok()?;
    if source.len() < size {
        return None;
    }
    let head = FlvHead::read(&mut source).ok()?;
    let start = size
        .saturating_sub(FINGERPRINT_LEN)
        .max(head.first_frame_offset);
    if start >= size {
        return None;
    }
    let hash = hash_range(&mut source, start, size)?;
    Some(Fingerprint { start, hash })
}

/// The hash of the bytes `[start, size)` of the file at `path`, or `None` when the file holds
/// fewer than `size` bytes or cannot be read.
fn hash_of_file(path: &Path, start: u64, size: u64) -> Option<u64> {
    let mut source = FileSource::open_within(path, size, None).ok()?;
    if source.len() < size {
        return None;
    }
    hash_range(&mut source, start, size)
}

fn hash_range(source: &mut FileSource, start: u64, end: u64) -> Option<u64> {
    let mut bytes = vec![0u8; usize::try_from(end.checked_sub(start)?).ok()?];
    read_exact_at(source, start, &mut bytes).ok()?;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    Some(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::{recording, RecordingOptions, TestDirectory};
    use std::path::PathBuf;

    /// A recording of `seconds`, written to a new directory, and the revision of its first
    /// `size` bytes as an import reads it while the file has `size` bytes.
    fn imported(seconds: u32) -> (TestDirectory, PathBuf, Vec<u8>, Revision) {
        let bytes = recording(&RecordingOptions {
            seconds,
            ..RecordingOptions::default()
        })
        .bytes;
        let dir = TestDirectory::new();
        let path = dir.path.join("live.flv");
        // The import sees the file cut inside a tag, as a recorder leaves it between two writes.
        let size = bytes.len() - 1000;
        std::fs::write(&path, &bytes[..size]).unwrap();
        let revision = Revision {
            path: path.to_string_lossy().into_owned(),
            size: size as u64,
            mtime: 100,
        };
        remember(&revision, &path);
        (dir, path, bytes, revision)
    }

    #[test]
    fn the_same_size_and_time_is_the_same_revision() {
        let (_dir, path, _, revision) = imported(10);
        assert_eq!(
            verdict(&revision, &path, revision.size, revision.mtime),
            Verdict::Same
        );
    }

    #[test]
    fn a_file_that_a_recorder_added_to_holds_its_revision() {
        let (_dir, path, bytes, revision) = imported(10);
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            verdict(&revision, &path, bytes.len() as u64, 101),
            Verdict::Grown
        );
        // A rewrite of the head in place, as of `onMetaData` at the end of a recording, keeps
        // the revision too, also at the same size.
        let mut rewritten = bytes[..revision.size as usize].to_vec();
        rewritten[20] ^= 0xFF;
        std::fs::write(&path, &rewritten).unwrap();
        assert_eq!(
            verdict(&revision, &path, revision.size, 101),
            Verdict::Grown
        );
    }

    #[test]
    fn a_change_in_front_of_the_size_of_the_revision_is_a_change() {
        let (_dir, path, bytes, revision) = imported(10);
        let mut changed = bytes.clone();
        changed[revision.size as usize - 10] ^= 0xFF;
        std::fs::write(&path, &changed).unwrap();
        assert_eq!(
            verdict(&revision, &path, changed.len() as u64, 101),
            Verdict::Changed
        );
    }

    #[test]
    fn a_shorter_file_an_earlier_time_or_no_fingerprint_is_a_change() {
        let (_dir, path, bytes, revision) = imported(10);
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            verdict(&revision, &path, revision.size - 1, 101),
            Verdict::Changed
        );
        assert_eq!(
            verdict(&revision, &path, bytes.len() as u64, 99),
            Verdict::Changed
        );
        let unknown = Revision {
            mtime: 50,
            ..revision.clone()
        };
        assert_eq!(
            verdict(&unknown, &path, bytes.len() as u64, 101),
            Verdict::Changed
        );
        // The size of the file on disk decides, not only the size that the caller read.
        std::fs::write(&path, &bytes[..revision.size as usize - 1]).unwrap();
        assert_eq!(
            verdict(&revision, &path, bytes.len() as u64, 101),
            Verdict::Changed
        );
    }

    #[test]
    fn a_file_that_is_not_an_flv_gets_no_fingerprint() {
        let dir = TestDirectory::new();
        let path = dir.path.join("clip.mp4");
        std::fs::write(&path, vec![0u8; 4096]).unwrap();
        let revision = Revision {
            path: path.to_string_lossy().into_owned(),
            size: 2048,
            mtime: 100,
        };
        remember(&revision, &path);
        assert_eq!(verdict(&revision, &path, 4096, 101), Verdict::Changed);
    }

    fn kept(revision: &Revision) -> Fingerprint {
        fingerprints()
            .iter()
            .find(|(known, _)| known == revision)
            .map(|(_, fingerprint)| *fingerprint)
            .unwrap()
    }

    #[test]
    fn the_fingerprint_starts_after_the_first_frame_and_covers_at_most_its_length() {
        // About 10 MB: the fingerprint covers the last 64 KiB in front of the size.
        let (_dir, _path, _, long) = imported(600);
        assert_eq!(kept(&long).start, long.size - FINGERPRINT_LEN);
        // About 25 KB: the fingerprint covers everything from the first frame.
        let (_short_dir, short_path, _, short) = imported(1);
        let head = FlvHead::read(&mut FileSource::open(&short_path, None).unwrap()).unwrap();
        assert!(short.size - head.first_frame_offset < FINGERPRINT_LEN);
        assert_eq!(kept(&short).start, head.first_frame_offset);
    }
}
