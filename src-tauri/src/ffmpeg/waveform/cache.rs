//! The cache of envelopes (ADR 056).
//!
//! Each envelope is one file in `<app_cache>/waveform/`. The name of the file is a hash of the
//! [`EnvelopeKey`], and the file holds the key again in its header, so a collision or a file of
//! another format is a miss. A file that does not agree with its key is deleted.
//!
//! The modification time of a file is the time of its last use: a hit sets it to now. The cleanup
//! deletes the entries that were not used for [`UNUSED_AGE`], the temporary files of writes that
//! stopped, and then the least recently used entries until the cache holds at most
//! [`LIMIT_BYTES`]. The most recently used entry always stays. The cleanup runs once after each
//! start of the application, after each write, and on a clear.
//!
//! The lock of this module holds within one process. A second copy of the application can run at
//! the same time, so a clear deletes only the temporary files that the cleanup would delete too,
//! and a read treats a file that another process deleted as a miss.

use super::{BUCKET_RATE, BYTES_PER_BUCKET, SAMPLE_RATE};
use crate::flv::cache::Revision;
use crate::fsutil::write_bytes_atomically;
use crate::time::{Pts, Rational};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

/// The directory under the application cache directory.
pub const CACHE_DIR_NAME: &str = "waveform";
/// The most bytes that the entries of the cache hold together.
pub const LIMIT_BYTES: u64 = 256 * 1024 * 1024;
/// An entry that was not used for this long is deleted.
pub const UNUSED_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// A temporary file older than this belongs to a write that stopped, and is deleted.
pub const TEMPORARY_AGE: Duration = Duration::from_secs(60 * 60);

const EXTENSION: &str = "qcwf";
const MAGIC: &[u8; 4] = b"QCWF";
/// The version of the file format. A new version gives new file names, so two versions of the
/// application never read the files of each other.
const FORMAT_VERSION: u32 = 1;
/// The meaning of the payload: a peak code, then an RMS code, for each bucket.
const ENCODING: &str = "peakRmsDbQ4";

/// One lock for every read, write, cleanup and clear, so a cleanup never deletes a file that a
/// read of this process has open, and two writes never interleave.
static CACHE_LOCK: Mutex<()> = Mutex::new(());
/// True after the cleanup of this application run.
static SWEPT: AtomicBool = AtomicBool::new(false);

/// Everything that decides the content of an envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvelopeKey {
    pub revision: Revision,
    /// The absolute index of the audio stream that the job decoded.
    pub audio_stream_index: u32,
    /// `videoStartPts`, the time of bucket 0.
    pub origin_pts: Pts,
    /// The video time base of `origin_pts`.
    pub time_base: Rational,
}

impl EnvelopeKey {
    /// The file name of the entry: an FNV-1a hash of the key, the format version and the rates.
    /// The hash is stable across builds, unlike the hasher of the standard library.
    #[must_use]
    pub fn file_name(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        feed(self.revision.path.as_bytes());
        feed(&[0]);
        feed(&self.revision.size.to_le_bytes());
        feed(&self.revision.mtime.to_le_bytes());
        feed(&self.audio_stream_index.to_le_bytes());
        feed(&self.origin_pts.value().to_le_bytes());
        feed(&self.time_base.num().to_le_bytes());
        feed(&self.time_base.den().to_le_bytes());
        feed(&FORMAT_VERSION.to_le_bytes());
        feed(&SAMPLE_RATE.to_le_bytes());
        feed(&BUCKET_RATE.to_le_bytes());
        format!("{hash:016x}.{EXTENSION}")
    }
}

/// The flags of a complete envelope that the page shows with it (ADR 056).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvelopeFlags {
    /// The FLV timestamps went back, so a later run wrote over an earlier one.
    pub timestamps_decrease: bool,
    /// A damaged tag had no tag after it, so the envelope ends there.
    pub damaged: bool,
    /// The envelope reached the limit of its buckets.
    pub truncated: bool,
}

/// A complete envelope: two codes for each bucket, from bucket 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEnvelope {
    pub buckets: Vec<u8>,
    pub flags: EnvelopeFlags,
}

impl CachedEnvelope {
    #[must_use]
    pub fn bucket_count(&self) -> usize {
        self.buckets.len() / BYTES_PER_BUCKET
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    key: EnvelopeKey,
    sample_rate: u32,
    bucket_rate: u32,
    encoding: String,
    bucket_count: u64,
    flags: EnvelopeFlags,
}

/// The size of the cache, for the Settings window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    pub bytes: u64,
    pub entries: u64,
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    CACHE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn cache_dir(cache_root: &Path) -> PathBuf {
    cache_root.join(CACHE_DIR_NAME)
}

fn encode(key: &EnvelopeKey, envelope: &CachedEnvelope) -> io::Result<Vec<u8>> {
    let header = Header {
        version: FORMAT_VERSION,
        key: key.clone(),
        sample_rate: SAMPLE_RATE,
        bucket_rate: BUCKET_RATE,
        encoding: ENCODING.to_owned(),
        bucket_count: envelope.bucket_count() as u64,
        flags: envelope.flags,
    };
    let header = serde_json::to_vec(&header).map_err(io::Error::other)?;
    let header_len = u32::try_from(header.len()).map_err(io::Error::other)?;
    let mut bytes = Vec::with_capacity(8 + header.len() + envelope.buckets.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&header_len.to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&envelope.buckets);
    Ok(bytes)
}

/// The envelope in `bytes`, or `None` when they are not a whole entry of `key`.
fn decode(key: &EnvelopeKey, bytes: &[u8]) -> Option<CachedEnvelope> {
    let rest = bytes.strip_prefix(MAGIC)?;
    let (length, rest) = rest.split_first_chunk::<4>()?;
    let header_len = usize::try_from(u32::from_le_bytes(*length)).ok()?;
    if rest.len() < header_len {
        return None;
    }
    let (header, payload) = rest.split_at(header_len);
    let header: Header = serde_json::from_slice(header).ok()?;
    let expected_len = usize::try_from(header.bucket_count)
        .ok()?
        .checked_mul(BYTES_PER_BUCKET)?;
    let agrees = header.version == FORMAT_VERSION
        && header.key == *key
        && header.sample_rate == SAMPLE_RATE
        && header.bucket_rate == BUCKET_RATE
        && header.encoding == ENCODING
        && payload.len() == expected_len;
    agrees.then(|| CachedEnvelope {
        buckets: payload.to_vec(),
        flags: header.flags,
    })
}

/// The cached envelope of `key`, or `None` on a miss. A hit sets the modification time of the
/// entry to now. An entry that does not agree with `key` is deleted.
#[must_use]
pub fn read(cache_root: &Path, key: &EnvelopeKey) -> Option<CachedEnvelope> {
    let _guard = lock();
    let path = cache_dir(cache_root).join(key.file_name());
    let bytes = fs::read(&path).ok()?;
    let Some(envelope) = decode(key, &bytes) else {
        let _ = fs::remove_file(&path);
        return None;
    };
    // A failed touch only makes the entry look older to the cleanup.
    let _ = File::options()
        .write(true)
        .open(&path)
        .and_then(|file| file.set_modified(SystemTime::now()));
    Some(envelope)
}

/// Writes the envelope of `key` with one atomic replace, then runs the cleanup. An error of the
/// cleanup does not fail the write, because the entry is saved.
pub fn write(cache_root: &Path, key: &EnvelopeKey, envelope: &CachedEnvelope) -> io::Result<()> {
    if envelope.buckets.len() % BYTES_PER_BUCKET != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "an envelope holds two codes for each bucket",
        ));
    }
    let bytes = encode(key, envelope)?;
    let _guard = lock();
    let dir = cache_dir(cache_root);
    fs::create_dir_all(&dir)?;
    write_bytes_atomically(&dir.join(key.file_name()), &bytes)?;
    let _ = sweep_locked(&dir, SystemTime::now(), LIMIT_BYTES);
    Ok(())
}

/// Runs the cleanup once in each application run: the first call cleans, later calls do
/// nothing. An error leaves the next call to try again.
pub fn sweep_once(cache_root: &Path) -> io::Result<()> {
    sweep_once_with(&SWEPT, cache_root, SystemTime::now())
}

fn sweep_once_with(swept: &AtomicBool, cache_root: &Path, now: SystemTime) -> io::Result<()> {
    if swept.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let result = sweep(cache_root, now, LIMIT_BYTES);
    if result.is_err() {
        swept.store(false, Ordering::Release);
    }
    result
}

/// Deletes the unused entries, the stopped temporary files, and the least recently used entries
/// above `limit` bytes.
pub fn sweep(cache_root: &Path, now: SystemTime, limit: u64) -> io::Result<()> {
    let _guard = lock();
    sweep_locked(&cache_dir(cache_root), now, limit)
}

/// The size of the cache.
pub fn usage(cache_root: &Path) -> io::Result<CacheUsage> {
    let _guard = lock();
    let mut usage = CacheUsage::default();
    for file in list(&cache_dir(cache_root))? {
        if file.kind == FileKind::Entry {
            usage.bytes += file.len;
            usage.entries += 1;
        }
    }
    Ok(usage)
}

/// Deletes every entry and the temporary files of writes that stopped, and returns the bytes of
/// the deleted entries. A younger temporary file can belong to a write of another process, so it
/// stays.
pub fn clear(cache_root: &Path) -> io::Result<u64> {
    let _guard = lock();
    let now = SystemTime::now();
    let mut removed = 0;
    for file in list(&cache_dir(cache_root))? {
        match file.kind {
            FileKind::Entry => {
                if fs::remove_file(&file.path).is_ok() {
                    removed += file.len;
                }
            }
            FileKind::Temporary if older_than(&file, now, TEMPORARY_AGE) => {
                let _ = fs::remove_file(&file.path);
            }
            FileKind::Temporary => {}
        }
    }
    Ok(removed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Entry,
    Temporary,
}

struct CacheFile {
    path: PathBuf,
    kind: FileKind,
    len: u64,
    modified: SystemTime,
}

/// The entries and the temporary files in `dir`. A missing directory is an empty cache. A file of
/// any other name is not part of the cache and stays.
fn list(dir: &Path) -> io::Result<Vec<CacheFile>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let entry_suffix = format!(".{EXTENSION}");
    let temporary_marker = format!(".{EXTENSION}.tmp-");
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let kind = if name.starts_with('.') && name.contains(&temporary_marker) {
            FileKind::Temporary
        } else if !name.starts_with('.') && name.ends_with(&entry_suffix) {
            FileKind::Entry
        } else {
            continue;
        };
        files.push(CacheFile {
            path: entry.path(),
            kind,
            len: metadata.len(),
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }
    Ok(files)
}

fn older_than(file: &CacheFile, now: SystemTime, age: Duration) -> bool {
    now.duration_since(file.modified)
        .is_ok_and(|elapsed| elapsed > age)
}

fn sweep_locked(dir: &Path, now: SystemTime, limit: u64) -> io::Result<()> {
    let mut entries = Vec::new();
    for file in list(dir)? {
        match file.kind {
            FileKind::Temporary if older_than(&file, now, TEMPORARY_AGE) => {
                let _ = fs::remove_file(&file.path);
            }
            FileKind::Temporary => {}
            FileKind::Entry if older_than(&file, now, UNUSED_AGE) => {
                let _ = fs::remove_file(&file.path);
            }
            FileKind::Entry => entries.push(file),
        }
    }
    let mut total: u64 = entries.iter().map(|file| file.len).sum();
    // The least recently used entry first. The most recently used entry stays, also when it alone
    // is above the limit, because a job wrote it or a page reads it now.
    entries.sort_by_key(|file| file.modified);
    entries.pop();
    for file in entries {
        if total <= limit {
            break;
        }
        if fs::remove_file(&file.path).is_ok() {
            total -= file.len;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::TestDirectory;

    fn key(path: &str) -> EnvelopeKey {
        EnvelopeKey {
            revision: Revision {
                path: path.to_owned(),
                size: 1000,
                mtime: 1_700_000_000,
            },
            audio_stream_index: 1,
            origin_pts: Pts::new(67),
            time_base: Rational::new(1, 1000).unwrap(),
        }
    }

    fn envelope(buckets: usize) -> CachedEnvelope {
        CachedEnvelope {
            buckets: (0..buckets * 2).map(|i| (i % 251) as u8).collect(),
            flags: EnvelopeFlags {
                timestamps_decrease: true,
                damaged: false,
                truncated: false,
            },
        }
    }

    fn entry_path(root: &Path, key: &EnvelopeKey) -> PathBuf {
        cache_dir(root).join(key.file_name())
    }

    fn set_age(path: &Path, now: SystemTime, age: Duration) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(now - age)
            .unwrap();
    }

    #[test]
    fn a_written_envelope_reads_back() {
        let root = TestDirectory::new();
        let key = key("/media/a.flv");
        write(&root.path, &key, &envelope(500)).unwrap();
        assert_eq!(read(&root.path, &key), Some(envelope(500)));
        assert_eq!(read(&root.path, &key).unwrap().bucket_count(), 500);
    }

    #[test]
    fn an_empty_envelope_reads_back() {
        let root = TestDirectory::new();
        let key = key("/media/a.flv");
        write(&root.path, &key, &envelope(0)).unwrap();
        assert_eq!(read(&root.path, &key), Some(envelope(0)));
    }

    #[test]
    fn every_part_of_the_key_changes_the_file_name() {
        let base = key("/media/a.flv");
        let mut names = vec![base.file_name()];
        let mut other = base.clone();
        other.revision.path.push('x');
        names.push(other.file_name());
        let mut other = base.clone();
        other.revision.size += 1;
        names.push(other.file_name());
        let mut other = base.clone();
        other.revision.mtime += 1;
        names.push(other.file_name());
        let mut other = base.clone();
        other.audio_stream_index = 2;
        names.push(other.file_name());
        let mut other = base.clone();
        other.origin_pts = Pts::new(68);
        names.push(other.file_name());
        let mut other = base.clone();
        other.time_base = Rational::new(1, 90_000).unwrap();
        names.push(other.file_name());
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), names.len());
        assert!(names.iter().all(|name| name.ends_with(".qcwf")));
    }

    #[test]
    fn a_missing_entry_is_a_miss() {
        let root = TestDirectory::new();
        assert_eq!(read(&root.path, &key("/media/a.flv")), None);
    }

    #[test]
    fn an_entry_of_another_key_under_the_same_name_is_a_miss_and_is_deleted() {
        let root = TestDirectory::new();
        let first = key("/media/a.flv");
        let second = key("/media/b.flv");
        write(&root.path, &first, &envelope(10)).unwrap();
        // Put the entry of `first` where `second` looks, as a hash collision would.
        fs::rename(
            entry_path(&root.path, &first),
            entry_path(&root.path, &second),
        )
        .unwrap();
        assert_eq!(read(&root.path, &second), None);
        assert!(!entry_path(&root.path, &second).exists());
    }

    #[test]
    fn a_damaged_entry_is_a_miss_and_is_deleted() {
        let root = TestDirectory::new();
        let key = key("/media/a.flv");
        write(&root.path, &key, &envelope(10)).unwrap();
        let path = entry_path(&root.path, &key);
        let bytes = fs::read(&path).unwrap();
        // A payload one byte short.
        fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
        assert_eq!(read(&root.path, &key), None);
        assert!(!path.exists());
        // Bytes that are not an entry.
        fs::write(&path, b"not an envelope").unwrap();
        assert_eq!(read(&root.path, &key), None);
        assert!(!path.exists());
        // A header length past the end.
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert_eq!(read(&root.path, &key), None);
        assert!(!path.exists());
    }

    #[test]
    fn a_hit_marks_the_entry_as_used_now() {
        let root = TestDirectory::new();
        let key = key("/media/a.flv");
        write(&root.path, &key, &envelope(10)).unwrap();
        let path = entry_path(&root.path, &key);
        let now = SystemTime::now();
        set_age(&path, now, Duration::from_secs(10 * 24 * 60 * 60));
        read(&root.path, &key).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(now.duration_since(modified).unwrap_or_default() < Duration::from_secs(60));
    }

    #[test]
    fn the_cleanup_deletes_unused_entries_and_stopped_writes() {
        let root = TestDirectory::new();
        let now = SystemTime::now();
        let old = key("/media/old.flv");
        let recent = key("/media/recent.flv");
        write(&root.path, &old, &envelope(10)).unwrap();
        write(&root.path, &recent, &envelope(10)).unwrap();
        set_age(
            &entry_path(&root.path, &old),
            now,
            UNUSED_AGE + Duration::from_secs(60),
        );
        set_age(
            &entry_path(&root.path, &recent),
            now,
            UNUSED_AGE - Duration::from_secs(60),
        );
        let dir = cache_dir(&root.path);
        let stopped = dir.join(".0123456789abcdef.qcwf.tmp-1-1");
        let running = dir.join(".0123456789abcdef.qcwf.tmp-1-2");
        let foreign = dir.join("notes.txt");
        for path in [&stopped, &running, &foreign] {
            fs::write(path, b"x").unwrap();
        }
        set_age(&stopped, now, TEMPORARY_AGE + Duration::from_secs(60));
        set_age(&foreign, now, UNUSED_AGE * 2);
        sweep(&root.path, now, LIMIT_BYTES).unwrap();
        assert!(!entry_path(&root.path, &old).exists());
        assert!(entry_path(&root.path, &recent).exists());
        assert!(!stopped.exists());
        assert!(running.exists());
        assert!(foreign.exists());
    }

    #[test]
    fn the_cleanup_deletes_the_least_recently_used_entries_above_the_limit() {
        let root = TestDirectory::new();
        let now = SystemTime::now();
        let keys: Vec<_> = (0..4).map(|i| key(&format!("/media/{i}.flv"))).collect();
        for (age, key) in keys.iter().enumerate() {
            write(&root.path, key, &envelope(1000)).unwrap();
            set_age(
                &entry_path(&root.path, key),
                now,
                Duration::from_secs(60 * (age as u64 + 1)),
            );
        }
        let size = fs::metadata(entry_path(&root.path, &keys[0]))
            .unwrap()
            .len();
        // Room for two entries: the two least recently used ones go.
        sweep(&root.path, now, size * 2 + size / 2).unwrap();
        assert!(entry_path(&root.path, &keys[0]).exists());
        assert!(entry_path(&root.path, &keys[1]).exists());
        assert!(!entry_path(&root.path, &keys[2]).exists());
        assert!(!entry_path(&root.path, &keys[3]).exists());
    }

    #[test]
    fn the_most_recently_used_entry_stays_above_the_limit() {
        let root = TestDirectory::new();
        let now = SystemTime::now();
        let older = key("/media/older.flv");
        let newer = key("/media/newer.flv");
        write(&root.path, &older, &envelope(1000)).unwrap();
        write(&root.path, &newer, &envelope(1000)).unwrap();
        set_age(
            &entry_path(&root.path, &older),
            now,
            Duration::from_secs(120),
        );
        set_age(
            &entry_path(&root.path, &newer),
            now,
            Duration::from_secs(60),
        );
        sweep(&root.path, now, 1).unwrap();
        assert!(!entry_path(&root.path, &older).exists());
        assert!(entry_path(&root.path, &newer).exists());
    }

    #[test]
    fn a_write_refuses_half_a_bucket() {
        let root = TestDirectory::new();
        let half = CachedEnvelope {
            buckets: vec![1, 2, 3],
            flags: EnvelopeFlags::default(),
        };
        let error = write(&root.path, &key("/media/a.flv"), &half).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn the_cleanup_of_a_run_happens_once_and_again_after_a_failure() {
        let root = TestDirectory::new();
        let swept = AtomicBool::new(false);
        let now = SystemTime::now();
        // A file where the cache directory belongs makes the listing fail.
        fs::write(cache_dir(&root.path), b"x").unwrap();
        assert!(sweep_once_with(&swept, &root.path, now).is_err());
        assert!(!swept.load(Ordering::Acquire));
        fs::remove_file(cache_dir(&root.path)).unwrap();
        let old = key("/media/old.flv");
        write(&root.path, &old, &envelope(10)).unwrap();
        set_age(&entry_path(&root.path, &old), now, UNUSED_AGE * 2);
        sweep_once_with(&swept, &root.path, now).unwrap();
        assert!(swept.load(Ordering::Acquire));
        assert!(!entry_path(&root.path, &old).exists());
        // A later call does nothing.
        write(&root.path, &old, &envelope(10)).unwrap();
        set_age(&entry_path(&root.path, &old), now, UNUSED_AGE * 2);
        sweep_once_with(&swept, &root.path, now).unwrap();
        assert!(entry_path(&root.path, &old).exists());
    }

    #[test]
    fn a_cleanup_of_a_missing_cache_does_nothing() {
        let root = TestDirectory::new();
        sweep(&root.path, SystemTime::now(), LIMIT_BYTES).unwrap();
        assert_eq!(usage(&root.path).unwrap(), CacheUsage::default());
        assert_eq!(clear(&root.path).unwrap(), 0);
    }

    #[test]
    fn the_usage_counts_entries_and_a_clear_deletes_them() {
        let root = TestDirectory::new();
        let first = key("/media/a.flv");
        let second = key("/media/b.flv");
        write(&root.path, &first, &envelope(100)).unwrap();
        write(&root.path, &second, &envelope(300)).unwrap();
        let dir = cache_dir(&root.path);
        let now = SystemTime::now();
        let stopped = dir.join(".0123456789abcdef.qcwf.tmp-1-3");
        let running = dir.join(".0123456789abcdef.qcwf.tmp-1-4");
        let foreign = dir.join("notes.txt");
        for path in [&stopped, &running, &foreign] {
            fs::write(path, b"x").unwrap();
        }
        set_age(&stopped, now, TEMPORARY_AGE + Duration::from_secs(60));
        let measured = usage(&root.path).unwrap();
        assert_eq!(measured.entries, 2);
        let expected = fs::metadata(entry_path(&root.path, &first)).unwrap().len()
            + fs::metadata(entry_path(&root.path, &second)).unwrap().len();
        assert_eq!(measured.bytes, expected);
        assert_eq!(clear(&root.path).unwrap(), expected);
        assert_eq!(read(&root.path, &first), None);
        assert!(!stopped.exists());
        assert!(running.exists());
        assert!(foreign.exists());
        assert_eq!(usage(&root.path).unwrap(), CacheUsage::default());
    }
}
