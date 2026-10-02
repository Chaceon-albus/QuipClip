//! On-disk cache for the results of preset tests ([`super::preset_test`]).
//!
//! The cache lives at `<app_data>/preset-tests.json`, beside the capability cache of ADR 006,
//! and follows its rules: a bounded list of entries, one process-wide lock over the whole
//! read-merge-write cycle, an atomic replacement of the file, and a damaged file read as a miss,
//! never as an error the user sees.
//!
//! An entry is keyed by two things. The first is the [`CacheKey`] of ADR 006: the binary path,
//! the version string, and the size and modification time of the binary, so a change of ffmpeg
//! misses. The second is the command of the test with [`super::preset_test::OUTPUT_PLACEHOLDER`]
//! in place of the output path. The command holds every preset field that reaches ffmpeg in a
//! test and nothing else, so two presets that differ only in their name share an entry, and a
//! preset whose encoder settings change misses. Storing the command itself needs no hash, and two
//! different commands can never share an entry.
//!
//! A result never blocks an export: it is information for the interface, and the export does not
//! read this file.

use super::cache::{CacheError, CacheKey, MAX_PROBED_AT_SECONDS};
use super::preset_test::PresetTestResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// The cache file's name inside the application data directory.
pub const PRESET_TEST_CACHE_FILE_NAME: &str = "preset-tests.json";

/// The largest number of entries the file holds at once.
///
/// A user tests a few drafts of each preset, on one or two binaries. 64 entries hold that, and
/// the file stays under a few hundred kilobytes even with the longest commands the settings
/// permit.
pub const MAX_PRESET_TEST_ENTRIES: usize = 64;

/// The schema version this build writes, and the only version it reads.
///
/// Any other value reads as a miss, as for the capability cache. The value changes when the
/// meaning of a stored result changes, such as a new rule in `classify_test`, because the
/// command of the test, and with it the key, would not change.
pub const PRESET_TEST_CACHE_SCHEMA_VERSION: u32 = 1;

/// One process-wide lock over the read-merge-write cycle of [`write`], for the reason
/// `cache::CACHE_LOCK` gives. A poisoned lock is recovered.
static PRESET_TEST_CACHE_LOCK: Mutex<()> = Mutex::new(());

/// One stored result: the binary it ran on, the command it ran, and what it found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetTestEntry {
    key: CacheKey,
    arguments: Vec<String>,
    result: PresetTestResult,
}

/// The whole cache file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetTestCacheFile {
    schema_version: u32,
    entries: Vec<PresetTestEntry>,
}

/// Every stored result for the binary of `key`, each with the command it ran.
///
/// A missing, unreadable, or damaged file, and a schema version this build does not read, give
/// no results. An entry whose `testedAt` lies outside the range the interface accepts is left
/// out, as `cache::read` leaves out such a `probedAt`, so the next test of that preset writes a
/// valid one.
#[must_use]
pub fn read_all(app_data_directory: &Path, key: &CacheKey) -> Vec<(Vec<String>, PresetTestResult)> {
    let Some(file) = load(&app_data_directory.join(PRESET_TEST_CACHE_FILE_NAME)) else {
        return Vec::new();
    };
    file.entries
        .into_iter()
        .filter(|entry| entry.key == *key && is_valid_tested_at(entry.result.tested_at))
        .map(|entry| (entry.arguments, entry.result))
        .collect()
}

/// The stored result of the test `arguments` on the binary of `key`, or `None`.
#[must_use]
pub fn read(
    app_data_directory: &Path,
    key: &CacheKey,
    arguments: &[String],
) -> Option<PresetTestResult> {
    read_all(app_data_directory, key)
        .into_iter()
        .find(|(stored, _)| stored == arguments)
        .map(|(_, result)| result)
}

/// Store `result` for the test `arguments` on the binary of `key`, replacing an earlier result
/// of the same test, and creating the application data directory when it does not exist.
///
/// A new entry in a full file first removes the entries with the oldest `testedAt` until the
/// file has room. A failure is for the caller to log: a result that is not stored still reaches
/// the interface.
pub fn write(
    app_data_directory: &Path,
    key: &CacheKey,
    arguments: &[String],
    result: &PresetTestResult,
) -> Result<(), CacheError> {
    let _guard = PRESET_TEST_CACHE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    fs::create_dir_all(app_data_directory)?;
    let path = app_data_directory.join(PRESET_TEST_CACHE_FILE_NAME);

    let mut file = load(&path).unwrap_or_default();
    file.schema_version = PRESET_TEST_CACHE_SCHEMA_VERSION;
    upsert(&mut file.entries, key, arguments, result);

    let json = crate::fsutil::to_pretty_json_line(&file)?;
    crate::fsutil::write_bytes_atomically(&path, &json)?;
    Ok(())
}

/// Read and parse the file, or `None` for anything that makes it unusable. The entry list
/// parses as one unit, so one damaged entry loses the whole file, as for the capability cache.
fn load(path: &Path) -> Option<PresetTestCacheFile> {
    let bytes = fs::read(path).ok()?;
    let file: PresetTestCacheFile = serde_json::from_slice(&bytes).ok()?;
    (file.schema_version == PRESET_TEST_CACHE_SCHEMA_VERSION).then_some(file)
}

/// Whether `tested_at` lies in the range the interface accepts for a time, the range of
/// `probedAt` (`cache::MAX_PROBED_AT_SECONDS`).
fn is_valid_tested_at(tested_at: i64) -> bool {
    tested_at > 0 && tested_at <= MAX_PROBED_AT_SECONDS
}

/// Replace the entry of `key` and `arguments`, or add one, removing the oldest entries first
/// when the list is full. The loop also trims a list that was already over the cap, as
/// `cache::upsert_entry` does.
fn upsert(
    entries: &mut Vec<PresetTestEntry>,
    key: &CacheKey,
    arguments: &[String],
    result: &PresetTestResult,
) {
    if let Some(existing) = entries
        .iter_mut()
        .find(|entry| entry.key == *key && entry.arguments == arguments)
    {
        existing.result = result.clone();
        return;
    }

    while entries.len() >= MAX_PRESET_TEST_ENTRIES {
        let Some(oldest) = entries
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.result.tested_at)
            .map(|(index, _)| index)
        else {
            break;
        };
        entries.remove(oldest);
    }

    entries.push(PresetTestEntry {
        key: key.clone(),
        arguments: arguments.to_vec(),
        result: result.clone(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::capabilities::preset_test::PresetTestStatus;
    use std::io;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-preset-test-cache-{}-{sequence}",
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

        fn file(&self) -> PathBuf {
            self.path.join(PRESET_TEST_CACHE_FILE_NAME)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn key(suffix: &str) -> CacheKey {
        CacheKey {
            ffmpeg_path: format!("/opt/ffmpeg-{suffix}/bin/ffmpeg"),
            version: "9.0.2".to_owned(),
            size: 1_000_000,
            mtime: 1_700_000_000,
        }
    }

    fn arguments(encoder: &str) -> Vec<String> {
        ["-c:v", encoder, "-f", "mp4", "<output>"]
            .iter()
            .map(|argument| (*argument).to_owned())
            .collect()
    }

    fn result(status: PresetTestStatus, tested_at: i64) -> PresetTestResult {
        PresetTestResult {
            status,
            line: match status {
                PresetTestStatus::Passed => None,
                _ => Some("[error] x".to_owned()),
            },
            exit_code: None,
            tested_at,
        }
    }

    #[test]
    fn a_written_result_reads_back_for_its_binary_and_its_command_only() {
        let directory = TestDirectory::new();
        let passed = result(PresetTestStatus::Passed, 1_790_000_000);
        write(&directory.path, &key("a"), &arguments("libx264"), &passed).unwrap();

        assert_eq!(
            read(&directory.path, &key("a"), &arguments("libx264")),
            Some(passed)
        );
        assert_eq!(
            read(&directory.path, &key("a"), &arguments("libx265")),
            None
        );
        assert_eq!(
            read(&directory.path, &key("b"), &arguments("libx264")),
            None
        );
        let mut upgraded = key("a");
        upgraded.version = "9.0.3".to_owned();
        assert_eq!(
            read(&directory.path, &upgraded, &arguments("libx264")),
            None
        );
    }

    #[test]
    fn the_file_is_versioned_camel_case_and_stores_the_command() {
        let directory = TestDirectory::new();
        write(
            &directory.path,
            &key("a"),
            &arguments("libx264"),
            &result(PresetTestStatus::Failed, 1_790_000_000),
        )
        .unwrap();

        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.file()).unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        let entry = &value["entries"][0];
        assert_eq!(entry["key"]["ffmpegPath"], "/opt/ffmpeg-a/bin/ffmpeg");
        assert_eq!(entry["arguments"][4], "<output>");
        assert_eq!(entry["result"]["status"], "failed");
        assert_eq!(entry["result"]["testedAt"], 1_790_000_000);
    }

    #[test]
    fn a_second_result_of_one_test_replaces_the_first_and_others_merge() {
        let directory = TestDirectory::new();
        write(
            &directory.path,
            &key("a"),
            &arguments("libx264"),
            &result(PresetTestStatus::Failed, 1_790_000_000),
        )
        .unwrap();
        write(
            &directory.path,
            &key("a"),
            &arguments("libsvtav1"),
            &result(PresetTestStatus::Passed, 1_790_000_001),
        )
        .unwrap();
        write(
            &directory.path,
            &key("b"),
            &arguments("libx264"),
            &result(PresetTestStatus::Passed, 1_790_000_002),
        )
        .unwrap();
        let retested = result(PresetTestStatus::PassedWithWarnings, 1_790_000_003);
        write(&directory.path, &key("a"), &arguments("libx264"), &retested).unwrap();

        let file = load(&directory.file()).unwrap();
        assert_eq!(file.entries.len(), 3);
        assert_eq!(
            read(&directory.path, &key("a"), &arguments("libx264")),
            Some(retested)
        );
        assert_eq!(read_all(&directory.path, &key("a")).len(), 2);
        assert_eq!(read_all(&directory.path, &key("b")).len(), 1);
    }

    #[test]
    fn the_entry_after_the_cap_evicts_the_oldest_test() {
        let directory = TestDirectory::new();
        // Written newest first, so the oldest test is the last one written before the cap, not
        // the first: eviction goes by `testedAt`, not by position.
        for index in 0..MAX_PRESET_TEST_ENTRIES {
            let tested_at = 1_790_000_100 - i64::try_from(index).unwrap();
            write(
                &directory.path,
                &key("a"),
                &arguments(&format!("encoder{index}")),
                &result(PresetTestStatus::Passed, tested_at),
            )
            .unwrap();
        }
        write(
            &directory.path,
            &key("a"),
            &arguments("newest"),
            &result(PresetTestStatus::Passed, 1_790_000_200),
        )
        .unwrap();

        let entries = read_all(&directory.path, &key("a"));
        assert_eq!(entries.len(), MAX_PRESET_TEST_ENTRIES);
        let oldest = arguments(&format!("encoder{}", MAX_PRESET_TEST_ENTRIES - 1));
        assert!(!entries.iter().any(|(stored, _)| *stored == oldest));
        assert!(entries
            .iter()
            .any(|(stored, _)| *stored == arguments("newest")));
        assert!(entries
            .iter()
            .any(|(stored, _)| *stored == arguments("encoder0")));
    }

    #[test]
    fn a_file_over_the_cap_is_trimmed_by_one_write() {
        let directory = TestDirectory::new();
        let entries = (0..MAX_PRESET_TEST_ENTRIES * 2)
            .map(|index| PresetTestEntry {
                key: key("a"),
                arguments: arguments(&format!("encoder{index}")),
                result: result(
                    PresetTestStatus::Passed,
                    1_790_000_000 + i64::try_from(index).unwrap(),
                ),
            })
            .collect();
        let file = PresetTestCacheFile {
            schema_version: PRESET_TEST_CACHE_SCHEMA_VERSION,
            entries,
        };
        fs::write(directory.file(), serde_json::to_vec(&file).unwrap()).unwrap();

        write(
            &directory.path,
            &key("a"),
            &arguments("trigger"),
            &result(PresetTestStatus::Passed, 1_790_009_999),
        )
        .unwrap();

        assert_eq!(
            load(&directory.file()).unwrap().entries.len(),
            MAX_PRESET_TEST_ENTRIES
        );
    }

    #[test]
    fn a_damaged_file_is_a_miss_and_the_next_write_replaces_it() {
        let directory = TestDirectory::new();
        for damaged in [
            &b"{ not json"[..],
            br#"{"schemaVersion":1,"entries":[{"key":1}]}"#,
            br#"{"schemaVersion":2,"entries":[]}"#,
            br#"{"schemaVersion":1,"entries":[{"key":{"ffmpegPath":"/opt/ffmpeg-a/bin/ffmpeg","version":"9.0.2","size":1000000,"mtime":1700000000},"arguments":["<output>"],"result":{"status":"exploded","testedAt":1790000000}}]}"#,
        ] {
            fs::write(directory.file(), damaged).unwrap();
            assert!(read_all(&directory.path, &key("a")).is_empty());
        }

        let passed = result(PresetTestStatus::Passed, 1_790_000_000);
        write(&directory.path, &key("a"), &arguments("libx264"), &passed).unwrap();
        assert_eq!(
            read(&directory.path, &key("a"), &arguments("libx264")),
            Some(passed)
        );
    }

    #[test]
    fn a_missing_file_and_a_missing_directory_are_a_miss() {
        let directory = TestDirectory::new();
        assert!(read_all(&directory.path, &key("a")).is_empty());
        assert!(read_all(&directory.path.join("absent"), &key("a")).is_empty());
    }

    #[test]
    fn an_out_of_range_tested_at_reads_as_a_miss() {
        let directory = TestDirectory::new();
        for tested_at in [0, -1, MAX_PROBED_AT_SECONDS + 1] {
            let file = PresetTestCacheFile {
                schema_version: PRESET_TEST_CACHE_SCHEMA_VERSION,
                entries: vec![PresetTestEntry {
                    key: key("a"),
                    arguments: arguments("libx264"),
                    result: result(PresetTestStatus::Passed, tested_at),
                }],
            };
            fs::write(directory.file(), serde_json::to_vec(&file).unwrap()).unwrap();
            assert_eq!(
                read(&directory.path, &key("a"), &arguments("libx264")),
                None,
                "{tested_at}"
            );
        }
    }

    #[test]
    fn writing_into_a_missing_directory_creates_it_and_leaves_no_temporary_file() {
        let directory = TestDirectory::new();
        let nested = directory.path.join("nested").join("app-data");
        write(
            &nested,
            &key("a"),
            &arguments("libx264"),
            &result(PresetTestStatus::Passed, 1_790_000_000),
        )
        .unwrap();

        assert!(nested.join(PRESET_TEST_CACHE_FILE_NAME).is_file());
        let leftover = fs::read_dir(&nested)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover);
    }
}
