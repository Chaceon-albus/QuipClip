//! On-disk cache for ADR 006 capability probe reports.
//!
//! The cache lives at `<app_data>/capabilities.json` and holds a bounded list of entries.
//! Each entry pairs a [`CacheKey`] with the [`CapabilityReport`] it was probed under and the
//! time of that probe. ADR 006 requires the list shape, not a single entry, because the
//! application never cancels a superseded probe run: two runs can finish at nearly the same
//! time, and both call [`write`] while the other is still in flight. A naive
//! read-modify-write would let the later `rename` silently discard the earlier writer's
//! entry. [`write`] serializes the whole read-merge-write sequence behind [`CACHE_LOCK`] so
//! that never happens for two writers in this process.
//!
//! [`CACHE_LOCK`] is scoped to this process. It does not, and cannot, protect against a
//! second QuipClip process running at the same time, or a user editing the cache file by
//! hand while the application runs. There is no single-instance guard in this project, so a
//! second process is reachable. Either case can still lose an entry the same way the lock
//! prevents within one process; the cost is one extra probe on the next launch, not a
//! diagnostic or a crash.
//!
//! A read never fails outward. [`read`] treats a missing file, an unreadable file, corrupt
//! JSON, an unrecognized `schemaVersion`, a key that does not match all four fields, or a
//! `probedAt` outside the range the frontend accepts as a plain miss and returns `None`. The
//! user must never see a diagnostic for a damaged cache file, and a write failure must never
//! keep a probe result from reaching the frontend, so [`write`]'s `Result` exists for a
//! caller that wants to log the failure, not one that must act on it.
//!
//! The entry list deserializes as one unit, so one damaged entry among several loses every
//! entry in the file, not just the damaged one; see [`load_cache_file`]. This is deliberate:
//! the cache is a pure optimization, so the all-or-nothing behaviour never surfaces as an
//! error, and the cost of losing the whole file is the same one extra probe per entry that a
//! single miss already costs.

use super::CapabilityReport;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The cache file's name inside the application data directory.
pub const CACHE_FILE_NAME: &str = "capabilities.json";

/// The largest number of entries the cache file holds at once.
///
/// ADR 006 sets this so the file stays small: a system binary, a downloaded binary, and a
/// handful of binaries a user tried during development all fit comfortably.
pub const MAX_ENTRIES: usize = 8;

/// The cache file schema version this build writes, and the only version it reads.
///
/// [`load_cache_file`] treats any other value as an unreadable file, the same as corrupt
/// JSON, so a future schema change can freely change the file shape without a migration.
pub const CACHE_SCHEMA_VERSION: u32 = 1;

/// The largest `probedAt` value [`read`] accepts.
///
/// This mirrors the frontend contract, not any property of `i64`: the frontend requires
/// `probedAt` to be strictly greater than `0` and at most this value, so a build that stored
/// a report using a wider or looser range would write an entry the frontend refuses to parse.
/// A machine with a wrong clock at probe time is the realistic way to get such a value.
/// Because the cache has no expiry and the key would still match on the next launch, an
/// unbounded `probedAt` would poison an entry forever with no self-healing; treating it as a
/// miss in [`read`] instead lets the next probe overwrite it with a fresh, valid value.
pub const MAX_PROBED_AT_SECONDS: i64 = 4_294_967_295;

/// One process-wide lock over the whole read-merge-write cycle in [`write`].
///
/// ADR 006: the application never cancels a superseded probe, so two calls to [`write`] can
/// be in flight for two different runs at the same time. Without this lock, both could read
/// the same entry list before either replaced it, and the later rename would silently
/// discard the earlier writer's entry. A poisoned lock is recovered rather than propagated as
/// a panic, the same way `smoke::SMOKE_LOCK` is: a panicking writer must not permanently
/// disable the cache for the rest of the process's life.
///
/// Scope: this is a single process's in-memory `Mutex`, not a file lock. It only serializes
/// writers within this process. A second QuipClip process, or a user editing the cache file
/// directly, is outside its reach and can still lose an entry the same way; the cost is one
/// extra probe, not a corrupted file, since [`write`] always reads the current file before
/// merging.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

/// Identifies one probed ffmpeg binary well enough to invalidate a stale report.
///
/// ADR 006's cache key is the absolute binary path, the reported version string, and the
/// binary's size and modification time. A change to any one of the four fields means a
/// different binary as far as the cache is concerned, so a user who upgrades or replaces
/// ffmpeg gets a fresh probe with no manual step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheKey {
    pub ffmpeg_path: String,
    pub version: String,
    pub size: u64,
    pub mtime: i64,
}

/// A failure to fingerprint an ffmpeg binary or to write the capability cache.
///
/// Nothing here represents a read failure: ADR 006 treats a damaged or unreadable cache file
/// as a plain miss, so [`read`] returns `Option`, never this type.
#[derive(Debug)]
pub enum CacheError {
    /// A filesystem operation failed: reading the binary's metadata, creating the
    /// application data directory, or writing and renaming the temporary cache file.
    Io(io::Error),
    /// The merged cache contents could not be serialized to JSON.
    Json(serde_json::Error),
}

impl fmt::Display for CacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "capability cache I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "capability cache JSON is invalid: {error}"),
        }
    }
}

impl Error for CacheError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
        }
    }
}

impl From<io::Error> for CacheError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for CacheError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// One cached probe: the key it was probed under, when, and what it found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    key: CacheKey,
    probed_at: i64,
    report: CapabilityReport,
}

/// The whole cache file: a schema version and a bounded list of entries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    schema_version: u32,
    entries: Vec<CacheEntry>,
}

/// Compute the cache key for `ffmpeg_path` from its current size and modification time.
///
/// This reads the binary's metadata fresh every call; it does not consult the cache itself.
pub fn fingerprint(ffmpeg_path: &Path, version: &str) -> Result<CacheKey, CacheError> {
    let metadata = fs::metadata(ffmpeg_path)?;
    let modified = metadata.modified()?;
    Ok(CacheKey {
        ffmpeg_path: ffmpeg_path.to_string_lossy().into_owned(),
        version: version.to_owned(),
        size: metadata.len(),
        mtime: unix_seconds(modified),
    })
}

/// Convert a modification time to whole seconds since the Unix epoch.
///
/// This duplicates the private `unix_seconds` in `commands/media.rs` rather than sharing it:
/// hoisting a twelve-line helper into `time.rs` is a cross-module refactor that belongs to
/// its own commit, not to this feature (ADR 009). Two differences from that copy are
/// deliberate. First, `ImportMediaResult` crosses the IPC boundary to code that parses it as
/// a JavaScript `number`, so its copy also rejects a value outside the JavaScript
/// safe-integer range; `CacheKey` never crosses that boundary, so this copy skips that check.
/// Second, that copy returns a `Result` and rejects an out-of-range value; this copy cannot
/// fail, so a pre-epoch time so extreme that the whole-seconds count would not fit in an
/// `i64` is clamped to `i64::MIN` instead. Both copies still do the same `i128` widening
/// before negating, so the clamp is the only path that ever loses precision.
fn unix_seconds(time: SystemTime) -> i64 {
    let seconds = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i128::from(duration.as_secs()),
        Err(error) => {
            let duration = error.duration();
            let whole_seconds = i128::from(duration.as_secs());
            if duration.subsec_nanos() == 0 {
                -whole_seconds
            } else {
                -whole_seconds - 1
            }
        }
    };
    seconds.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

/// Look up a cached report for `key`, treating any problem reading the cache as a miss.
///
/// ADR 006 requires a missing file, an unreadable file, corrupt JSON, an unrecognized
/// `schemaVersion`, or a key that does not match all four fields to be a plain cache miss,
/// never an error the user sees. This returns `Option` for exactly that reason.
///
/// An entry whose `probedAt` falls outside [`MAX_PROBED_AT_SECONDS`] is also a miss, the same
/// as a damaged entry: see [`MAX_PROBED_AT_SECONDS`] for why a value this build itself wrote
/// can still be out of range.
pub fn read(app_data_directory: &Path, key: &CacheKey) -> Option<CapabilityReport> {
    let path = app_data_directory.join(CACHE_FILE_NAME);
    let file = load_cache_file(&path)?;
    let entry = file.entries.into_iter().find(|entry| entry.key == *key)?;
    if entry.probed_at <= 0 || entry.probed_at > MAX_PROBED_AT_SECONDS {
        return None;
    }
    Some(entry.report)
}

/// Merge `report` into the on-disk cache under `key`, creating the application data
/// directory first when it does not exist yet.
///
/// This acquires [`CACHE_LOCK`], reads the current file (or starts from an empty one when it
/// is missing or damaged), replaces the entry for `key` or adds a new one, then writes the
/// whole list to a temporary file in `app_data_directory` and renames it over the cache file.
/// The lock covers that entire sequence, not just the final write: two callers that both
/// merely read-then-wrote without a shared lock could each read the same old list and the
/// second `rename` would discard the first caller's entry. Holding one lock for read, merge,
/// and write closes that window.
///
/// A write failure is not fatal to a probe: this returns `Result` so a caller can log the
/// failure, but the probe result must still reach the frontend even when the cache write
/// fails, so no caller should treat this `Err` as reason to fail the probe itself.
pub fn write(
    app_data_directory: &Path,
    key: &CacheKey,
    report: &CapabilityReport,
) -> Result<(), CacheError> {
    let _guard = CACHE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    fs::create_dir_all(app_data_directory)?;
    let path = app_data_directory.join(CACHE_FILE_NAME);

    let mut file = load_cache_file(&path).unwrap_or_default();
    file.schema_version = CACHE_SCHEMA_VERSION;
    upsert_entry(&mut file.entries, key, report);

    let json = crate::fsutil::to_pretty_json_line(&file)?;
    crate::fsutil::write_bytes_atomically(&path, &json)?;
    Ok(())
}

/// Read and parse the cache file, returning `None` for anything that makes it unusable: a
/// missing file, any other I/O error, invalid JSON, or a `schemaVersion` this build does not
/// read.
///
/// `entries` deserializes as one `Vec`, so a single damaged entry fails the whole list and
/// this returns `None` for the entire file, discarding every other entry along with it. That
/// is deliberate, not an oversight: the cache is a pure optimization, and the cost of losing
/// every entry is the same one extra probe per entry that losing just the damaged one would
/// have cost anyway.
fn load_cache_file(path: &Path) -> Option<CacheFile> {
    let bytes = fs::read(path).ok()?;
    let file: CacheFile = serde_json::from_slice(&bytes).ok()?;
    if file.schema_version != CACHE_SCHEMA_VERSION {
        return None;
    }
    Some(file)
}

/// Replace the entry whose key equals `key`, or insert a new one.
///
/// A new entry that would push the list past [`MAX_ENTRIES`] first evicts the oldest entries
/// by `probedAt`, one at a time, until the list has room. That loop restores the cap even
/// when the file already held more than [`MAX_ENTRIES`] entries when it was read -- from a
/// hand-edited file, or from a previous build that wrote a larger cap that was since lowered
/// -- rather than merely keeping it from growing further. Replacing an existing key's entry
/// never evicts, because that does not grow the list.
fn upsert_entry(entries: &mut Vec<CacheEntry>, key: &CacheKey, report: &CapabilityReport) {
    if let Some(existing) = entries.iter_mut().find(|entry| entry.key == *key) {
        existing.probed_at = report.probed_at;
        existing.report = report.clone();
        return;
    }

    while entries.len() >= MAX_ENTRIES {
        let Some(oldest_index) = entries
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.probed_at)
            .map(|(index, _)| index)
        else {
            break;
        };
        entries.remove(oldest_index);
    }

    entries.push(CacheEntry {
        key: key.clone(),
        probed_at: report.probed_at,
        report: report.clone(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::capabilities::{CodecKind, EncoderResult, EncoderStatus, LicenseFlags};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::Duration;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn sample_key(suffix: &str) -> CacheKey {
        CacheKey {
            ffmpeg_path: format!("/opt/ffmpeg-{suffix}/bin/ffmpeg"),
            version: "6.1.1".to_owned(),
            size: 1_000_000,
            mtime: 1_700_000_000,
        }
    }

    fn sample_report(probed_at: i64) -> CapabilityReport {
        CapabilityReport {
            version: "6.1.1".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: false,
            },
            hwaccels: vec!["videotoolbox".to_owned()],
            encoders: vec![EncoderResult {
                name: "libx264".to_owned(),
                kind: CodecKind::Video,
                listed: true,
                status: EncoderStatus::Works,
                exit_code: Some(0),
                detail: None,
            }],
            probed_at,
        }
    }

    #[test]
    fn unix_seconds_matches_expected_values_for_ordinary_times() {
        let cases: [(SystemTime, i64); 5] = [
            (UNIX_EPOCH, 0),
            (UNIX_EPOCH + Duration::from_secs(1), 1),
            (UNIX_EPOCH - Duration::from_secs(1), -1),
            // A pre-epoch time with a fractional second floors toward negative infinity:
            // 1.5 seconds before the epoch is -2 seconds, not -1.
            (UNIX_EPOCH - Duration::from_millis(1_500), -2),
            (UNIX_EPOCH - Duration::from_millis(500), -1),
        ];
        for (time, expected) in cases {
            assert_eq!(unix_seconds(time), expected, "input {time:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_seconds_clamps_instead_of_panicking_for_an_extreme_pre_epoch_time() {
        // `i64::MIN` is exactly `-(2^63)`, so it is representable as a Unix `tv_sec`, which
        // makes `UNIX_EPOCH - 2^63 seconds` a valid `SystemTime` on Unix. (It is not
        // reachable on Windows, where `SystemTime` is FILETIME-based and cannot represent
        // anything before 1601, so this test is Unix-only, the same way the temporary-file
        // permission test above is Unix-only for the opposite reason.) `duration_since` then
        // returns an `Err` whose duration is exactly `2^63` seconds. The old implementation
        // widened that with a plain `as` cast to `i64`, which silently wrapped to
        // `i64::MIN`, then negated it, which panics in a debug build and wraps again in a
        // release build. This asserts the fixed implementation clamps to `i64::MIN` instead
        // of doing either.
        let extreme = UNIX_EPOCH - Duration::from_secs(1u64 << 63);
        assert_eq!(unix_seconds(extreme), i64::MIN);
    }

    #[test]
    fn fingerprint_reads_the_binarys_current_size_and_modification_time() {
        let directory = TestDirectory::new();
        let binary_path = directory.path.join("ffmpeg");
        fs::write(&binary_path, b"fake ffmpeg binary contents").unwrap();

        let metadata = fs::metadata(&binary_path).unwrap();
        let expected_mtime = unix_seconds(metadata.modified().unwrap());

        let key = fingerprint(&binary_path, "6.1.1").unwrap();

        assert_eq!(key.ffmpeg_path, binary_path.to_string_lossy());
        assert_eq!(key.version, "6.1.1");
        assert_eq!(key.size, metadata.len());
        assert_eq!(key.mtime, expected_mtime);
    }

    #[test]
    fn fingerprint_fails_for_a_missing_binary() {
        let directory = TestDirectory::new();
        let missing = directory.path.join("does-not-exist");
        assert!(fingerprint(&missing, "6.1.1").is_err());
    }

    #[test]
    fn absent_exit_code_and_detail_are_omitted_from_the_wire_json_not_written_as_null() {
        let directory = TestDirectory::new();
        let key = sample_key("wire-shape");
        let mut report = sample_report(1_700_002_000);
        report.encoders = vec![EncoderResult {
            name: "aac".to_owned(),
            kind: CodecKind::Audio,
            listed: true,
            status: EncoderStatus::Works,
            exit_code: None,
            detail: None,
        }];
        write(&directory.path, &key, &report).unwrap();

        let path = directory.path.join(CACHE_FILE_NAME);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();

        // The top-level and entry keys are camelCase on disk: this is what the frontend
        // (`src/features/ffmpeg/validation.ts`) parses.
        assert!(value.get("schemaVersion").is_some());
        assert!(value.get("entries").is_some());
        let entry = &value["entries"][0];
        assert!(entry.get("probedAt").is_some());
        assert!(entry["key"].get("ffmpegPath").is_some());

        let encoder = entry["report"]["encoders"][0].as_object().unwrap();
        assert!(
            !encoder.contains_key("exitCode"),
            "exitCode must be entirely absent, not written as null, for a candidate with no \
             exit code, or the frontend's `isI32` check rejects it and drops the whole report"
        );
        assert!(
            !encoder.contains_key("detail"),
            "detail must be entirely absent, not written as null, for a candidate with no detail"
        );
    }

    #[test]
    fn a_file_already_over_the_cap_is_trimmed_back_to_max_entries_by_one_write() {
        let directory = TestDirectory::new();
        let path = directory.path.join(CACHE_FILE_NAME);

        // Seed a file that already holds more than MAX_ENTRIES, bypassing `upsert_entry`
        // entirely: this is reachable from a hand-edited file, or from a previous build that
        // wrote a larger cap that was since lowered.
        let seeded_entries: Vec<CacheEntry> = (0..(MAX_ENTRIES * 2))
            .map(|index| {
                let probed_at = 1_700_000_000 + i64::try_from(index).unwrap();
                CacheEntry {
                    key: sample_key(&format!("seeded-{index}")),
                    probed_at,
                    report: sample_report(probed_at),
                }
            })
            .collect();
        let seeded_file = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            entries: seeded_entries,
        };
        fs::write(&path, serde_json::to_vec(&seeded_file).unwrap()).unwrap();

        write(
            &directory.path,
            &sample_key("trim-trigger"),
            &sample_report(1_700_000_999),
        )
        .unwrap();

        let written: CacheFile = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written.entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn an_out_of_range_probed_at_reads_as_a_miss() {
        let directory = TestDirectory::new();
        let path = directory.path.join(CACHE_FILE_NAME);

        for probed_at in [0i64, -1, MAX_PROBED_AT_SECONDS + 1] {
            let key = sample_key(&format!("probed-at-{probed_at}"));
            let file = CacheFile {
                schema_version: CACHE_SCHEMA_VERSION,
                entries: vec![CacheEntry {
                    key: key.clone(),
                    probed_at,
                    report: sample_report(probed_at),
                }],
            };
            fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
            assert_eq!(read(&directory.path, &key), None, "probed_at {probed_at}");
        }
    }

    #[test]
    fn the_maximum_probed_at_still_reads_as_a_hit() {
        let directory = TestDirectory::new();
        let path = directory.path.join(CACHE_FILE_NAME);
        let key = sample_key("probed-at-max");
        let report = sample_report(MAX_PROBED_AT_SECONDS);
        let file = CacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            entries: vec![CacheEntry {
                key: key.clone(),
                probed_at: MAX_PROBED_AT_SECONDS,
                report: report.clone(),
            }],
        };
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(read(&directory.path, &key), Some(report));
    }

    #[test]
    fn round_trip_write_then_read_returns_the_report() {
        let directory = TestDirectory::new();
        let key = sample_key("round-trip");
        let report = sample_report(1_700_000_100);
        write(&directory.path, &key, &report).unwrap();
        assert_eq!(read(&directory.path, &key), Some(report));
    }

    #[test]
    fn a_changed_size_misses() {
        let directory = TestDirectory::new();
        let key = sample_key("size");
        write(&directory.path, &key, &sample_report(1_700_000_200)).unwrap();
        let mut changed = key;
        changed.size += 1;
        assert_eq!(read(&directory.path, &changed), None);
    }

    #[test]
    fn a_changed_mtime_misses() {
        let directory = TestDirectory::new();
        let key = sample_key("mtime");
        write(&directory.path, &key, &sample_report(1_700_000_300)).unwrap();
        let mut changed = key;
        changed.mtime += 1;
        assert_eq!(read(&directory.path, &changed), None);
    }

    #[test]
    fn a_changed_version_misses() {
        let directory = TestDirectory::new();
        let key = sample_key("version");
        write(&directory.path, &key, &sample_report(1_700_000_400)).unwrap();
        let mut changed = key;
        changed.version = "6.1.2".to_owned();
        assert_eq!(read(&directory.path, &changed), None);
    }

    #[test]
    fn a_changed_path_misses() {
        let directory = TestDirectory::new();
        let key = sample_key("path");
        write(&directory.path, &key, &sample_report(1_700_000_500)).unwrap();
        let mut changed = key;
        changed.ffmpeg_path = "/opt/somewhere-else/ffmpeg".to_owned();
        assert_eq!(read(&directory.path, &changed), None);
    }

    #[test]
    fn corrupt_json_misses_instead_of_erroring() {
        let directory = TestDirectory::new();
        fs::write(directory.path.join(CACHE_FILE_NAME), b"{ not json at all").unwrap();
        assert_eq!(read(&directory.path, &sample_key("corrupt")), None);
    }

    #[test]
    fn unknown_schema_version_misses() {
        let directory = TestDirectory::new();
        let key = sample_key("schema");
        write(&directory.path, &key, &sample_report(1_700_000_600)).unwrap();

        let path = directory.path.join(CACHE_FILE_NAME);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["schemaVersion"] = serde_json::json!(CACHE_SCHEMA_VERSION + 1);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        assert_eq!(read(&directory.path, &key), None);
    }

    #[test]
    fn a_missing_file_and_a_missing_directory_both_miss() {
        let directory = TestDirectory::new();
        assert_eq!(read(&directory.path, &sample_key("missing-file")), None);

        let missing_directory = directory.path.join("does-not-exist");
        assert_eq!(
            read(&missing_directory, &sample_key("missing-directory")),
            None
        );
    }

    #[test]
    fn writing_into_a_missing_directory_creates_it_and_succeeds() {
        let directory = TestDirectory::new();
        let nested = directory.path.join("nested").join("app-data");
        assert!(!nested.exists());

        let key = sample_key("nested");
        let report = sample_report(1_700_000_700);
        write(&nested, &key, &report).unwrap();

        assert!(nested.join(CACHE_FILE_NAME).is_file());
        assert_eq!(read(&nested, &key), Some(report));
    }

    #[test]
    fn the_ninth_distinct_entry_evicts_the_oldest_by_probed_at() {
        let directory = TestDirectory::new();
        let mut keys = Vec::new();
        for index in 0..9 {
            let key = sample_key(&format!("evict-{index}"));
            let report = sample_report(1_700_000_000 + i64::from(index));
            write(&directory.path, &key, &report).unwrap();
            keys.push(key);
        }

        // The first entry written also has the smallest probedAt, so it must be the one
        // evicted; the other eight, indices 1 through 8, all survive.
        assert_eq!(read(&directory.path, &keys[0]), None);
        for key in &keys[1..] {
            assert!(read(&directory.path, key).is_some());
        }
    }

    #[test]
    fn rewriting_an_existing_key_replaces_its_entry_rather_than_growing_the_list() {
        let directory = TestDirectory::new();
        let key = sample_key("replace");
        write(&directory.path, &key, &sample_report(1_700_000_800)).unwrap();
        write(&directory.path, &key, &sample_report(1_700_000_900)).unwrap();

        let path = directory.path.join(CACHE_FILE_NAME);
        let file: CacheFile = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(file.entries.len(), 1);
        assert_eq!(
            read(&directory.path, &key),
            Some(sample_report(1_700_000_900))
        );
    }

    #[test]
    fn write_merges_with_an_existing_entry_for_a_different_binary_instead_of_clobbering_it() {
        // This is the property the entry list exists for: two different binaries, probed
        // one after another, must both still be readable afterward.
        let directory = TestDirectory::new();
        let key_x = sample_key("binary-x");
        let key_y = sample_key("binary-y");
        let report_x = sample_report(1_700_001_000);
        let report_y = sample_report(1_700_001_100);

        write(&directory.path, &key_x, &report_x).unwrap();
        write(&directory.path, &key_y, &report_y).unwrap();

        assert_eq!(read(&directory.path, &key_x), Some(report_x));
        assert_eq!(read(&directory.path, &key_y), Some(report_y));
    }

    #[test]
    fn concurrent_writers_for_different_binaries_do_not_lose_each_others_entries() {
        // CACHE_LOCK serializes the whole read-merge-write cycle, so two real threads
        // calling `write` at the same time must still both survive, the same as the
        // sequential merge test above but exercised under actual concurrency.
        let directory = TestDirectory::new();
        let key_x = sample_key("concurrent-x");
        let key_y = sample_key("concurrent-y");
        let report_x = sample_report(1_700_001_200);
        let report_y = sample_report(1_700_001_300);

        let path_for_x = directory.path.clone();
        let path_for_y = directory.path.clone();
        let key_for_x = key_x.clone();
        let key_for_y = key_y.clone();
        let report_for_x = report_x.clone();
        let report_for_y = report_y.clone();

        let writer_x = thread::spawn(move || write(&path_for_x, &key_for_x, &report_for_x));
        let writer_y = thread::spawn(move || write(&path_for_y, &key_for_y, &report_for_y));
        writer_x.join().unwrap().unwrap();
        writer_y.join().unwrap().unwrap();

        assert_eq!(read(&directory.path, &key_x), Some(report_x));
        assert_eq!(read(&directory.path, &key_y), Some(report_y));
    }

    #[test]
    fn no_temporary_file_survives_a_successful_write() {
        // A permission-based failure injection is not portable across the windows-latest
        // and macos-latest CI runners, so this test pins only the successful path: after
        // `write` returns, no `.capabilities.json.tmp-*` file is left behind. The failure
        // path -- a partial file never surviving a write that errors out partway -- is
        // exercised only by the shared `fsutil` module's armed-Drop cleanup guard, and has
        // no dedicated test here.
        let directory = TestDirectory::new();
        write(
            &directory.path,
            &sample_key("no-leftover"),
            &sample_report(1_700_001_400),
        )
        .unwrap();

        let leftover = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(
            !leftover,
            "a temporary cache file was left behind after a successful write"
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
                    "quipclip-ffmpeg-capabilities-cache-test-{}-{sequence}",
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
