//! Show the file that an export published.
//!
//! The command here takes a run id and not a path. The export worker records the destination
//! of each run that it publishes, and the command acts only on the recorded destination of the
//! run that it names. The web view therefore cannot tell the operating system to show a path of
//! its choice. The most that a compromised web view can do through this command is to show a
//! path that one of the recent exports published to.
//!
//! Show has no check of the file extension, because it only selects the file in the file
//! manager and runs nothing.
//!
//! # Why the opener plugin's own commands are not used
//!
//! A registered plugin injects its link-click script into the web view, and any opener
//! permission in a capability would give the web view the plugin's commands. The plugin's
//! `open_path` command takes a path from the web view and checks it against a scope. That scope
//! is static: it comes from the capability file, which is compiled into the application. An
//! export destination is any path that the user picks in the save dialog, so a static scope that
//! covers every destination must cover every path. That scope would let the web view start any
//! executable file on the machine. The plugin's `reveal_item_in_dir` command checks no scope at
//! all. This module calls the plugin's Rust function instead. The plugin is not registered, and
//! the capability file grants the web view no opener permission.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The stable codes of a failed show request (ADR 011).
///
/// Each variant spells its wire string explicitly, so that
/// `src/features/export/output.test.ts` can read the vocabulary out of this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ExportOutputErrorCode {
    /// No export published a file under the run id in this process, or the record is gone: a
    /// later export published to the same path, or [`PUBLISHED_EXPORT_LIMIT`] later exports
    /// published. The application decides this without a system call, so the code carries no
    /// diagnostic.
    #[serde(rename = "outputUnknown")]
    OutputUnknown,
    /// The recorded file is not at its path now. The user moved, renamed, or deleted it after
    /// the export. The code carries no diagnostic.
    #[serde(rename = "outputMissing")]
    OutputMissing,
    /// The file manager did not show the file. The failure modes of the file manager cannot
    /// be enumerated, so this code carries the diagnostic of the operating system.
    #[serde(rename = "revealFailed")]
    RevealFailed,
}

/// The rejection payload of [`reveal_export_output`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutputError {
    pub code: ExportOutputErrorCode,
    /// Untranslated diagnostic text. ADR 011 keeps it out of `code`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ExportOutputError {
    fn new(code: ExportOutputErrorCode) -> Self {
        Self { code, detail: None }
    }

    fn with_detail(code: ExportOutputErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

/// How many published exports [`PublishedExports`] remembers.
///
/// The interface lists the runs of one batch of queued exports, and each finished run offers
/// Show. A batch that is longer than this loses Show on its oldest runs, which then answer
/// `outputUnknown`. The bound keeps a session that exports all day from growing the record
/// without end.
pub const PUBLISHED_EXPORT_LIMIT: usize = 64;

/// The destinations of the recent exports that this process published.
///
/// `lib.rs` stores one value as Tauri managed state. The export worker writes a record after
/// the rename and before it emits the `finished` event, so a request that follows that event
/// finds the record. The command in this module reads it.
///
/// A record stays while later runs export, because a queue of exports shows the result of each
/// run, and the user can ask to show the file of an earlier run while a later one writes. A
/// run that writes elsewhere cannot change the file of the earlier run. A run that writes to the
/// same path writes a temporary file first and replaces the earlier file only at its rename, so
/// until then the earlier file is still the one that its run published. After a successful
/// rename, the worker always records the new run, and that record removes the record of the
/// earlier run for the same path. Between the rename and the record, Show for the earlier run
/// selects the file of the new run. That is harmless: Show runs nothing, and the path is one
/// that the user chose for both runs.
///
/// On Windows, File Explorer can read the earlier file for a thumbnail while it shows it, and so
/// hold it open for a moment while the new run renames over it. The rename retries for the
/// publication budget of ADR 016, which covers a short hold.
///
/// The comparison is by path as written. Two spellings of one file keep both records: two
/// letter cases or two Unicode normalizations on a volume that ignores them, or a path through
/// a symbolic link such as `/tmp` and `/private/tmp`. Show for the earlier run then selects the
/// file that the later run wrote, which is harmless for the same reason.
#[derive(Debug, Default)]
pub struct PublishedExports {
    /// The list of records, oldest first, at most [`PUBLISHED_EXPORT_LIMIT`] long, with no two
    /// records for one path.
    records: Mutex<VecDeque<PublishedExport>>,
}

#[derive(Debug)]
struct PublishedExport {
    run_id: String,
    path: PathBuf,
}

impl PublishedExports {
    /// Record that the run `run_id` published its output at `path`.
    ///
    /// The method removes the record of an earlier run with the same path, because the file at
    /// that path is now the output of this run. It removes records by path before it adds the
    /// new one. Then, when the list is longer than [`PUBLISHED_EXPORT_LIMIT`], it removes the
    /// oldest record.
    pub fn record(&self, run_id: &str, path: PathBuf) {
        let removed: Vec<PublishedExport> = {
            let mut records = self.lock();
            let mut removed = Vec::new();
            let mut index = 0;
            while index < records.len() {
                if records[index].path == path || records[index].run_id == run_id {
                    removed.extend(records.remove(index));
                } else {
                    index += 1;
                }
            }
            records.push_back(PublishedExport {
                run_id: run_id.to_owned(),
                path,
            });
            while records.len() > PUBLISHED_EXPORT_LIMIT {
                removed.extend(records.pop_front());
            }
            removed
        };
        // Free the removed records after the lock is released.
        drop(removed);
    }

    /// The published path of the run `run_id`, or `None` when no record names that run.
    #[must_use]
    pub fn path_for(&self, run_id: &str) -> Option<PathBuf> {
        self.lock()
            .iter()
            .find(|published| published.run_id == run_id)
            .map(|published| published.path.clone())
    }

    /// Lock the list of records, and recover a poisoned lock instead of propagating it.
    ///
    /// Each method changes the records only through `VecDeque` calls that complete or do
    /// nothing, so a panic cannot leave a record half written. `ExportRegistry::lock` recovers
    /// its poison for the same reason.
    fn lock(&self) -> MutexGuard<'_, VecDeque<PublishedExport>> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Show the published file of the run `runId` in Finder or in File Explorer.
///
/// The command finds the recorded path, then does the file system check and the system call on
/// the blocking pool. The existence check and the system call can wait on a network share that
/// stopped answering, and the file manager can take a moment to answer. The async executor must
/// not wait for them.
#[tauri::command]
pub async fn reveal_export_output(
    published: tauri::State<'_, PublishedExports>,
    run_id: String,
) -> Result<(), ExportOutputError> {
    let path = published
        .path_for(&run_id)
        .ok_or_else(|| ExportOutputError::new(ExportOutputErrorCode::OutputUnknown))?;
    tauri::async_runtime::spawn_blocking(move || {
        reveal_published_path(&path, |path| tauri_plugin_opener::reveal_item_in_dir(path))
    })
    .await
    .map_err(|error| {
        ExportOutputError::with_detail(ExportOutputErrorCode::RevealFailed, error.to_string())
    })?
}

/// Check that `path` still exists, then call `reveal` on it.
///
/// A missing file is a condition that the application can name, so it has its own code with no
/// diagnostic. Every other failure is reported as `revealFailed` with the text of the error,
/// because the failure modes of the file system and of the file manager cannot be enumerated
/// (ADR 011).
///
/// `reveal` is a parameter so that a test can observe the order of the check and the call
/// without a file manager.
fn reveal_published_path<Reveal, RevealError>(
    path: &Path,
    reveal: Reveal,
) -> Result<(), ExportOutputError>
where
    Reveal: FnOnce(&Path) -> Result<(), RevealError>,
    RevealError: std::fmt::Display,
{
    match path.try_exists() {
        Ok(true) => {}
        Ok(false) => return Err(ExportOutputError::new(ExportOutputErrorCode::OutputMissing)),
        Err(error) => {
            return Err(ExportOutputError::with_detail(
                ExportOutputErrorCode::RevealFailed,
                error.to_string(),
            ))
        }
    }
    reveal(path).map_err(|error| {
        ExportOutputError::with_detail(ExportOutputErrorCode::RevealFailed, error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs;

    /// A directory under the system temporary directory that the test deletes on drop.
    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "quipclip-export-output-{label}-{}",
                crate::commands::next_run_id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn every_error_code_serializes_to_its_stable_camel_case_string() {
        let pairs = [
            (ExportOutputErrorCode::OutputUnknown, "outputUnknown"),
            (ExportOutputErrorCode::OutputMissing, "outputMissing"),
            (ExportOutputErrorCode::RevealFailed, "revealFailed"),
        ];
        for (code, wire) in pairs {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
    }

    #[test]
    fn an_error_omits_an_absent_detail_entirely_and_not_as_null() {
        let bare =
            serde_json::to_value(ExportOutputError::new(ExportOutputErrorCode::OutputMissing))
                .unwrap();
        assert_eq!(bare, serde_json::json!({ "code": "outputMissing" }));

        let detailed = serde_json::to_value(ExportOutputError::with_detail(
            ExportOutputErrorCode::RevealFailed,
            "the file manager did not answer",
        ))
        .unwrap();
        assert_eq!(
            detailed,
            serde_json::json!({
                "code": "revealFailed",
                "detail": "the file manager did not answer"
            })
        );
    }

    #[test]
    fn a_record_answers_only_for_its_own_run() {
        let published = PublishedExports::default();
        assert_eq!(published.path_for("1-0"), None);

        published.record("1-0", PathBuf::from("/movies/first.mp4"));
        assert_eq!(
            published.path_for("1-0"),
            Some(PathBuf::from("/movies/first.mp4"))
        );
        assert_eq!(published.path_for("1-1"), None);
    }

    #[test]
    fn a_later_record_keeps_the_earlier_run() {
        let published = PublishedExports::default();
        published.record("1-0", PathBuf::from("/movies/first.mp4"));
        published.record("2-1", PathBuf::from("/movies/second.mp4"));

        assert_eq!(
            published.path_for("1-0"),
            Some(PathBuf::from("/movies/first.mp4"))
        );
        assert_eq!(
            published.path_for("2-1"),
            Some(PathBuf::from("/movies/second.mp4"))
        );
    }

    #[test]
    fn a_record_for_the_same_path_replaces_the_earlier_run() {
        let published = PublishedExports::default();
        published.record("1-0", PathBuf::from("/movies/out.mp4"));
        published.record("2-1", PathBuf::from("/movies/other.mp4"));
        published.record("3-2", PathBuf::from("/movies/out.mp4"));

        assert_eq!(published.path_for("1-0"), None);
        assert_eq!(
            published.path_for("2-1"),
            Some(PathBuf::from("/movies/other.mp4"))
        );
        assert_eq!(
            published.path_for("3-2"),
            Some(PathBuf::from("/movies/out.mp4"))
        );
    }

    #[test]
    fn a_full_record_forgets_the_oldest_run_first() {
        let published = PublishedExports::default();
        for index in 0..=PUBLISHED_EXPORT_LIMIT {
            published.record(
                &format!("{index}-0"),
                PathBuf::from(format!("/movies/{index}.mp4")),
            );
        }

        assert_eq!(published.path_for("0-0"), None);
        assert_eq!(
            published.path_for("1-0"),
            Some(PathBuf::from("/movies/1.mp4"))
        );
        let newest = PUBLISHED_EXPORT_LIMIT;
        assert_eq!(
            published.path_for(&format!("{newest}-0")),
            Some(PathBuf::from(format!("/movies/{newest}.mp4")))
        );
        assert_eq!(published.lock().len(), PUBLISHED_EXPORT_LIMIT);
    }

    #[test]
    fn a_same_path_record_in_a_full_list_keeps_the_oldest_other_run() {
        let published = PublishedExports::default();
        for index in 0..PUBLISHED_EXPORT_LIMIT {
            published.record(
                &format!("{index}-0"),
                PathBuf::from(format!("/movies/{index}.mp4")),
            );
        }

        // The path of a run in the middle of the full list.
        published.record("new-0", PathBuf::from("/movies/10.mp4"));

        assert_eq!(published.path_for("10-0"), None);
        assert_eq!(
            published.path_for("0-0"),
            Some(PathBuf::from("/movies/0.mp4"))
        );
        assert_eq!(
            published.path_for("new-0"),
            Some(PathBuf::from("/movies/10.mp4"))
        );
        assert_eq!(published.lock().len(), PUBLISHED_EXPORT_LIMIT);
    }

    #[test]
    fn a_second_record_of_one_run_keeps_one_record() {
        // A run publishes once. If a caller recorded it twice, the newer path wins and the
        // run still has one record.
        let published = PublishedExports::default();
        published.record("1-0", PathBuf::from("/movies/first.mp4"));
        published.record("1-0", PathBuf::from("/movies/again.mp4"));

        assert_eq!(
            published.path_for("1-0"),
            Some(PathBuf::from("/movies/again.mp4"))
        );
        assert_eq!(published.lock().len(), 1);
    }

    #[test]
    fn an_existing_file_is_passed_to_the_file_manager() {
        let directory = TempDirectory::new("exists");
        let file = directory.0.join("out.mp4");
        fs::write(&file, b"video").unwrap();
        let seen = RefCell::new(None);

        let result = reveal_published_path(&file, |path| {
            *seen.borrow_mut() = Some(path.to_path_buf());
            Ok::<(), std::io::Error>(())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(seen.into_inner(), Some(file));
    }

    #[test]
    fn show_accepts_any_extension_because_it_runs_nothing() {
        let directory = TempDirectory::new("any-extension");
        let file = directory.0.join("out.command");
        fs::write(&file, b"video").unwrap();
        let called = Cell::new(false);

        let result = reveal_published_path(&file, |_| {
            called.set(true);
            Ok::<(), std::io::Error>(())
        });

        assert_eq!(result, Ok(()));
        assert!(
            called.get(),
            "show must not refuse a file for its extension"
        );
    }

    #[test]
    fn a_missing_file_reports_its_own_code_and_makes_no_system_call() {
        let directory = TempDirectory::new("missing");
        let file = directory.0.join("moved-away.mp4");
        let called = Cell::new(false);

        let result = reveal_published_path(&file, |_| {
            called.set(true);
            Ok::<(), std::io::Error>(())
        });

        assert_eq!(
            result,
            Err(ExportOutputError::new(ExportOutputErrorCode::OutputMissing))
        );
        assert!(
            !called.get(),
            "a missing file must not reach the file manager"
        );
    }

    #[test]
    fn a_failed_show_reports_reveal_failed_with_the_diagnostic() {
        let directory = TempDirectory::new("fails");
        let file = directory.0.join("out.mp4");
        fs::write(&file, b"video").unwrap();

        let result = reveal_published_path(&file, |_| Err("the file manager did not answer"));

        assert_eq!(
            result,
            Err(ExportOutputError::with_detail(
                ExportOutputErrorCode::RevealFailed,
                "the file manager did not answer"
            ))
        );
    }
}
