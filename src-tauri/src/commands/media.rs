//! Media import validation and probing.

use crate::ffmpeg::capabilities::PROBE_DETAIL_LIMIT;
use crate::ffmpeg::{self, FfmpegPaths, MediaProbe, ProbeError};
use crate::settings;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Facts about one validated media file that the frontend can use immediately.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMediaResult {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub mtime: i64,
    pub probe: MediaProbe,
}

/// The revision facts of one media file, and nothing else.
///
/// This is the payload of [`read_source_revision`]. It carries no probe: the frontend compares
/// it against the revision of the file it imported, and a comparison of path, size, and
/// modification time needs no stream facts (ADR 010).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevision {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

/// Stable error names translated by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportMediaErrorCode {
    InvalidPath,
    PathNotFound,
    PathNotFile,
    PathNotUnicode,
    MetadataFailed,
    UnsafeMetadata,
    AppDataUnavailable,
    FfmpegPairMissing,
    FfprobeSpawnFailed,
    FfprobeProcessFailed,
    FfprobeParseFailed,
    /// `ffprobe` was still running at `ffmpeg::probe::PROBE_TIMEOUT` and was killed. An
    /// import of a file on a share that stops answering ends here rather than staying in the
    /// loading state for as long as the application runs.
    FfprobeTimedOut,
    AssetScopeDenied,
    CommandExecutionFailed,
}

/// A command error with a localizable code and optional untranslated diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMediaError {
    pub code: ImportMediaErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

impl ImportMediaError {
    fn new(code: ImportMediaErrorCode) -> Self {
        Self {
            code,
            detail: None,
            exit_code: None,
        }
    }

    fn with_detail(code: ImportMediaErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
            exit_code: None,
        }
    }
}

#[derive(Debug)]
struct ValidatedMedia {
    path: PathBuf,
    path_text: String,
    file_name: String,
    size: u64,
    mtime: i64,
}

/// Validate, inspect, and authorize exactly one user-selected media file.
#[tauri::command]
pub async fn import_media(
    app: tauri::AppHandle,
    path: String,
) -> Result<ImportMediaResult, ImportMediaError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| generated_error(ImportMediaErrorCode::AppDataUnavailable))?;

    tauri::async_runtime::spawn_blocking(move || {
        import_media_with(
            &path,
            &app_data_directory,
            settings::configured_ffmpeg_path,
            ffmpeg::discover,
            ffmpeg::probe_media,
            |media_path| {
                app.asset_protocol_scope()
                    .allow_file(media_path)
                    .map_err(|error| error.to_string())
            },
        )
    })
    .await
    .map_err(|error| join_failure(&error))?
}

fn import_media_with<ConfiguredPath, Discover, Probe, Allow>(
    path: &str,
    app_data_directory: &Path,
    configured_path: ConfiguredPath,
    discover: Discover,
    probe: Probe,
    allow: Allow,
) -> Result<ImportMediaResult, ImportMediaError>
where
    ConfiguredPath: FnOnce(&Path) -> Option<PathBuf>,
    Discover: FnOnce(Option<&Path>, &Path) -> Result<FfmpegPaths, ffmpeg::LocateError>,
    Probe: FnOnce(&Path, &Path) -> Result<MediaProbe, ProbeError>,
    Allow: FnOnce(&Path) -> Result<(), String>,
{
    let media = validate_media(path)?;
    let configured = configured_path(app_data_directory);
    let executables = discover(configured.as_deref(), app_data_directory)
        .map_err(|_| generated_error(ImportMediaErrorCode::FfmpegPairMissing))?;
    let probe = probe(&executables.ffprobe, &media.path).map_err(map_probe_error)?;

    // The scope denial carries its diagnostic. `import_media`'s closure stringifies the Tauri
    // error on purpose, and a denial is not an enumerable condition: the scope layer refuses a
    // pattern for reasons this command does not decide and cannot list. ADR 011 keeps the text
    // there -- the interface still renders the localized `assetScopeDenied`, and the string is
    // only what a user copies into a bug report.
    allow(&media.path).map_err(|detail| {
        ImportMediaError::with_detail(ImportMediaErrorCode::AssetScopeDenied, detail)
    })?;

    Ok(ImportMediaResult {
        path: media.path_text,
        file_name: media.file_name,
        size: media.size,
        mtime: media.mtime,
        probe,
    })
}

/// Read the revision facts of one already-imported media file.
///
/// A stat, and nothing more. It runs no `ffprobe` and grants no asset scope: it opens nothing
/// for the web view, so widening the asset scope here would be a grant with no reader.
///
/// The refusals are [`validate_media`]'s own, so an invalid path, a file that is gone, a path
/// that is no longer a regular file, and metadata outside the safe-integer range are decided in
/// the one place `import_media` decides them and are reported with the same
/// [`ImportMediaErrorCode`] values the frontend already translates.
#[tauri::command]
pub async fn read_source_revision(path: String) -> Result<SourceRevision, ImportMediaError> {
    tauri::async_runtime::spawn_blocking(move || read_source_revision_blocking(&path))
        .await
        .map_err(|error| join_failure(&error))?
}

/// The body of [`read_source_revision`], off the async runtime so a test can reach it.
fn read_source_revision_blocking(path: &str) -> Result<SourceRevision, ImportMediaError> {
    let media = validate_media(path)?;
    Ok(SourceRevision {
        path: media.path_text,
        size: media.size,
        mtime: media.mtime,
    })
}

fn validate_media(path: &str) -> Result<ValidatedMedia, ImportMediaError> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ImportMediaError::new(ImportMediaErrorCode::InvalidPath));
    }

    let canonical = fs::canonicalize(path).map_err(map_canonicalize_error)?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        ImportMediaError::with_detail(ImportMediaErrorCode::MetadataFailed, error.to_string())
    })?;
    if !metadata.is_file() {
        return Err(ImportMediaError::new(ImportMediaErrorCode::PathNotFile));
    }

    let (path_text, file_name) = unicode_path_fields(&canonical)?;
    let size = metadata.len();
    if size > JAVASCRIPT_MAX_SAFE_INTEGER as u64 {
        return Err(ImportMediaError::new(ImportMediaErrorCode::UnsafeMetadata));
    }
    let modified = metadata.modified().map_err(|error| {
        ImportMediaError::with_detail(ImportMediaErrorCode::MetadataFailed, error.to_string())
    })?;
    let mtime = unix_seconds(modified)?;

    Ok(ValidatedMedia {
        path: canonical,
        path_text,
        file_name,
        size,
        mtime,
    })
}

fn unicode_path_fields(path: &Path) -> Result<(String, String), ImportMediaError> {
    let path_text = path
        .to_str()
        .ok_or_else(|| ImportMediaError::new(ImportMediaErrorCode::PathNotUnicode))?
        .to_owned();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ImportMediaError::new(ImportMediaErrorCode::PathNotUnicode))?
        .to_owned();
    Ok((path_text, file_name))
}

fn map_canonicalize_error(error: io::Error) -> ImportMediaError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => ImportMediaErrorCode::PathNotFound,
        io::ErrorKind::InvalidInput => ImportMediaErrorCode::InvalidPath,
        _ => ImportMediaErrorCode::MetadataFailed,
    };
    ImportMediaError::with_detail(code, error.to_string())
}

/// A failure QuipClip decides for itself about a condition it can enumerate, where the code is
/// the whole account and there is nothing a diagnostic could add (ADR 011).
///
/// Two codes reach this: `appDataUnavailable`, which says the platform gave the application no
/// data directory, and `ffmpegPairMissing`, which says discovery found no `ffmpeg` and `ffprobe`
/// pair. No system call produced either answer.
fn generated_error(code: ImportMediaErrorCode) -> ImportMediaError {
    ImportMediaError::new(code)
}

/// Report a blocking-task join failure as `commandExecutionFailed`, carrying what went wrong.
///
/// A join failure is not an enumerable condition, so ADR 011 keeps its diagnostic. The value both
/// callers pass is a `JoinError`, and its `Display` says whether the task **panicked** or was
/// **cancelled** -- two different faults with two different investigations, and the bare code
/// tells them apart not at all.
///
/// The parameter is `&impl Display` rather than the concrete error type because a `JoinError`
/// cannot be constructed outside tokio, so a test can only reach this mapping with a stand-in. The
/// test that does so proves the text is carried, not that tokio produced it.
fn join_failure(error: &impl std::fmt::Display) -> ImportMediaError {
    ImportMediaError::with_detail(
        ImportMediaErrorCode::CommandExecutionFailed,
        error.to_string(),
    )
}

fn unix_seconds(time: SystemTime) -> Result<i64, ImportMediaError> {
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
    if !(-i128::from(JAVASCRIPT_MAX_SAFE_INTEGER)..=i128::from(JAVASCRIPT_MAX_SAFE_INTEGER))
        .contains(&seconds)
    {
        return Err(ImportMediaError::new(ImportMediaErrorCode::UnsafeMetadata));
    }
    Ok(seconds as i64)
}

/// Map one `ffprobe` failure to a stable code, a raw diagnostic, and an exit code.
///
/// Visible to the crate because `commands::export` re-probes the source when an export starts
/// (ADR 014's "Other rules") and must report the same three failures. It translates the codes
/// below into its own vocabulary rather than keeping a second copy of this mapping, which
/// could drift away from this one.
pub(crate) fn map_probe_error(error: ProbeError) -> ImportMediaError {
    match error {
        ProbeError::Spawn { source } => ImportMediaError::with_detail(
            ImportMediaErrorCode::FfprobeSpawnFailed,
            source.to_string(),
        ),
        ProbeError::ProcessFailed { code, stderr } => ImportMediaError {
            code: ImportMediaErrorCode::FfprobeProcessFailed,
            detail: diagnostic_text(&stderr),
            exit_code: code,
        },
        ProbeError::Parse { source: _, stderr } => ImportMediaError {
            code: ImportMediaErrorCode::FfprobeParseFailed,
            detail: diagnostic_text(&stderr),
            exit_code: None,
        },
        // The deadline itself is not reported as a detail: it is this application's own
        // policy, not a diagnostic from ffprobe, and ADR 011 keeps an English sentence out of
        // a payload the frontend translates. Whatever ffprobe did manage to write before it
        // was killed is still carried, exactly as for the two failures above.
        ProbeError::TimedOut { timeout: _, stderr } => ImportMediaError {
            code: ImportMediaErrorCode::FfprobeTimedOut,
            detail: diagnostic_text(&stderr),
            exit_code: None,
        },
    }
}

/// Cut the last [`PROBE_DETAIL_LIMIT`] bytes of an `ffprobe` stderr capture into text, or
/// `None` when the capture is empty.
///
/// [`ffmpeg::capabilities::stderr_tail`] does the work rather than a `str::from_utf8` of its
/// own. `from_utf8` discards the whole diagnostic for one invalid byte anywhere in it, so an
/// `ffprobe` running under a non-UTF-8 locale reported nothing at all; `stderr_tail` walks
/// forward to a character boundary and repairs the rest with `from_utf8_lossy`, so a mangled
/// byte costs a character instead of the diagnostic. It returns `None` for empty input, which
/// is the empty case, so this needs no branch of its own.
///
/// The capture this reads is a **head**: `ffmpeg::probe` keeps its first bytes, and stays on
/// that end deliberately. An `ffprobe` runs once, briefly, at `-v error`, so it cannot build up
/// the per-frame flood that made the export runner move to a tail capture.
///
/// The bound is [`PROBE_DETAIL_LIMIT`] itself, not a second constant holding the same number.
/// An import failure and a capability probe failure fill the same `detail: Option<String>` on
/// the same IPC boundary for the same purpose — a diagnostic a user copies into a bug report,
/// never the message the interface shows (ADR 011) — so they are one policy with one name.
fn diagnostic_text(bytes: &[u8]) -> Option<String> {
    ffmpeg::capabilities::stderr_tail(bytes, PROBE_DETAIL_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::{ExecutableOrigin, ProbeParseError};
    use crate::time::{FrameCount, Pts, Rational, TickCount};
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn serializes_the_command_contract_with_camel_case_names() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let result = successful_import(&media_path);

        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value["fileName"], "clip.mp4");
        assert_eq!(value["size"], 5);
        assert_eq!(
            value["probe"]["avgFrameRate"],
            serde_json::json!({ "n": 30, "d": 1 })
        );
        assert!(value.get("file_name").is_none());
    }

    #[test]
    fn rejects_empty_missing_and_directory_paths_before_discovery() {
        let directory = TestDirectory::new();
        for (path, expected) in [
            ("".to_owned(), ImportMediaErrorCode::InvalidPath),
            (
                directory
                    .path
                    .join("missing.mp4")
                    .to_string_lossy()
                    .into_owned(),
                ImportMediaErrorCode::PathNotFound,
            ),
            (
                directory.path.to_string_lossy().into_owned(),
                ImportMediaErrorCode::PathNotFile,
            ),
        ] {
            let called = RefCell::new(false);
            let error = import_media_with(
                &path,
                &directory.path,
                |_| unreachable!(),
                |_, _| {
                    *called.borrow_mut() = true;
                    unreachable!()
                },
                |_, _| unreachable!(),
                |_| unreachable!(),
            )
            .unwrap_err();
            assert_eq!(error.code, expected);
            assert!(!*called.borrow());
        }
    }

    #[test]
    fn a_revision_read_refuses_the_same_paths_the_import_refuses() {
        let directory = TestDirectory::new();
        for (path, expected) in [
            ("".to_owned(), ImportMediaErrorCode::InvalidPath),
            (
                directory
                    .path
                    .join("missing.mp4")
                    .to_string_lossy()
                    .into_owned(),
                ImportMediaErrorCode::PathNotFound,
            ),
            (
                directory.path.to_string_lossy().into_owned(),
                ImportMediaErrorCode::PathNotFile,
            ),
        ] {
            let error = read_source_revision_blocking(&path).unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[test]
    fn a_revision_read_reports_the_canonical_path_and_the_byte_length() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let canonical = media_path.canonicalize().unwrap();

        let revision = read_source_revision_blocking(media_path.to_str().unwrap()).unwrap();

        assert_eq!(revision.path, canonical.to_str().unwrap());
        assert_eq!(revision.size, 5);
        assert_eq!(
            revision.mtime,
            unix_seconds(fs::metadata(&canonical).unwrap().modified().unwrap()).unwrap()
        );
    }

    /// Every field of `SourceRevision` is one word, so `rename_all = "camelCase"` renames
    /// nothing today and this test cannot exercise it. The attribute is carried for the day a
    /// two-word field arrives; the field count below is what would fail if a probe fact were
    /// added.
    #[test]
    fn a_revision_serializes_exactly_the_three_revision_facts() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");

        let revision = read_source_revision_blocking(media_path.to_str().unwrap()).unwrap();
        let value = serde_json::to_value(&revision).unwrap();

        assert_eq!(value["size"], 5);
        assert_eq!(value["mtime"], revision.mtime);
        assert!(value["path"].is_string());
        // The comparison needs three facts. Anything else here would be a fact the frontend
        // could start to depend on, and this command runs no `ffprobe` to produce one.
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(value.get("probe").is_none());
    }

    #[test]
    fn reports_a_missing_ffmpeg_pair_without_probing_or_authorizing() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let probe_called = RefCell::new(false);
        let allow_called = RefCell::new(false);

        let error = import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| None,
            |_, _| Err(ffmpeg::LocateError::NotFound { inspected: vec![] }),
            |_, _| {
                *probe_called.borrow_mut() = true;
                unreachable!()
            },
            |_| {
                *allow_called.borrow_mut() = true;
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ImportMediaErrorCode::FfmpegPairMissing);
        assert_eq!(error.detail, None);
        assert!(!*probe_called.borrow());
        assert!(!*allow_called.borrow());
    }

    #[test]
    fn authorizes_only_the_canonical_file_after_a_successful_probe() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let canonical = media_path.canonicalize().unwrap();
        let events = RefCell::new(Vec::new());

        let result = import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| {
                events.borrow_mut().push("configured-path");
                None
            },
            |_, _| {
                events.borrow_mut().push("discover");
                Ok(fake_executables(&directory.path))
            },
            |_, path| {
                assert_eq!(path, canonical);
                events.borrow_mut().push("probe");
                Ok(fake_probe())
            },
            |path| {
                assert_eq!(path, canonical);
                events.borrow_mut().push("allow-file");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            &*events.borrow(),
            &["configured-path", "discover", "probe", "allow-file"]
        );
        assert_eq!(result.path, canonical.to_str().unwrap());
        assert_eq!(result.file_name, "clip.mp4");
        assert_eq!(result.size, 5);
    }

    #[test]
    fn passes_the_configured_path_from_settings_into_discovery() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let received: RefCell<Option<Option<PathBuf>>> = RefCell::new(None);

        import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| Some(PathBuf::from("/configured/bin")),
            |configured, _| {
                *received.borrow_mut() = Some(configured.map(Path::to_path_buf));
                Ok(fake_executables(&directory.path))
            },
            |_, _| Ok(fake_probe()),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(
            received.into_inner(),
            Some(Some(PathBuf::from("/configured/bin")))
        );
    }

    #[test]
    fn an_absent_configured_path_passes_none_to_discovery() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let received: RefCell<Option<Option<PathBuf>>> = RefCell::new(None);

        import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| None,
            |configured, _| {
                *received.borrow_mut() = Some(configured.map(Path::to_path_buf));
                Ok(fake_executables(&directory.path))
            },
            |_, _| Ok(fake_probe()),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(received.into_inner(), Some(None));
    }

    #[test]
    fn never_authorizes_a_file_when_probe_fails() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let allowed = RefCell::new(false);

        let error = import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| None,
            |_, _| Ok(fake_executables(&directory.path)),
            |_, _| {
                Err(ProbeError::ProcessFailed {
                    code: Some(7),
                    stderr: b"decoder rejected input".to_vec(),
                })
            },
            |_| {
                *allowed.borrow_mut() = true;
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ImportMediaErrorCode::FfprobeProcessFailed);
        assert_eq!(error.exit_code, Some(7));
        assert_eq!(error.detail.as_deref(), Some("decoder rejected input"));
        assert!(!*allowed.borrow());
    }

    #[test]
    fn maps_probe_failures_to_distinct_stable_codes() {
        let spawn = map_probe_error(ProbeError::Spawn {
            source: io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
        });
        let parse = map_probe_error(ProbeError::Parse {
            source: ProbeParseError::Json(
                serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err(),
            ),
            stderr: Vec::new(),
        });

        let timed_out = map_probe_error(ProbeError::TimedOut {
            timeout: Duration::from_secs(30),
            stderr: b"stalled on the share".to_vec(),
        });

        assert_eq!(spawn.code, ImportMediaErrorCode::FfprobeSpawnFailed);
        assert_eq!(parse.code, ImportMediaErrorCode::FfprobeParseFailed);
        assert_eq!(timed_out.code, ImportMediaErrorCode::FfprobeTimedOut);
        assert_eq!(timed_out.detail.as_deref(), Some("stalled on the share"));
        assert_eq!(timed_out.exit_code, None);
        assert_eq!(
            serde_json::to_value(timed_out).unwrap()["code"],
            "ffprobeTimedOut"
        );
        assert_eq!(spawn.detail.as_deref(), Some("denied"));
        assert_eq!(parse.detail, None);
        assert_eq!(
            serde_json::to_value(spawn).unwrap()["code"],
            "ffprobeSpawnFailed"
        );
    }

    #[test]
    fn maps_scope_denial_after_probe() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");

        let error = import_media_with(
            media_path.to_str().unwrap(),
            &directory.path,
            |_| None,
            |_, _| Ok(fake_executables(&directory.path)),
            |_, _| Ok(fake_probe()),
            |_| Err("scope rejected pattern".to_owned()),
        )
        .unwrap_err();

        assert_eq!(error.code, ImportMediaErrorCode::AssetScopeDenied);
        // This assertion used to be `None`, pinning the rule the amended ADR 011 retires: the
        // string was dropped because Rust authored it. A scope denial is not an enumerable set of
        // conditions, so the text is the only thing that says which pattern the scope refused and
        // why. The interface still renders the localized `assetScopeDenied`.
        assert_eq!(error.detail.as_deref(), Some("scope rejected pattern"));
    }

    // The two codes that stay bare, and the reason is the condition rather than the origin: each
    // is one thing QuipClip decided for itself, with no system call behind it, so the code is the
    // whole account. `assetScopeDenied` and `commandExecutionFailed` were in this list until they
    // gained a diagnostic each; the two tests above and below hold them now.
    #[test]
    fn a_failure_about_an_enumerable_condition_carries_no_diagnostic() {
        for code in [
            ImportMediaErrorCode::AppDataUnavailable,
            ImportMediaErrorCode::FfmpegPairMissing,
        ] {
            let error = generated_error(code);
            assert_eq!(error.code, code);
            assert_eq!(error.detail, None);
            assert_eq!(error.exit_code, None);
        }
    }

    // A `JoinError` cannot be constructed outside tokio, so the stand-in below is the closest a
    // test can get to the real value. It holds the mapping: a panic and a cancellation are two
    // faults, and `commandExecutionFailed` alone cannot tell a reader which one happened.
    #[test]
    fn a_join_failure_carries_the_reason_the_task_did_not_finish() {
        let error = join_failure(&"task 12 panicked");

        assert_eq!(error.code, ImportMediaErrorCode::CommandExecutionFailed);
        assert_eq!(error.detail.as_deref(), Some("task 12 panicked"));
        assert_eq!(error.exit_code, None);
    }

    #[test]
    fn parse_failure_repairs_and_bounds_raw_ffprobe_stderr() {
        let source = || {
            ProbeParseError::Json(serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err())
        };

        let valid = map_probe_error(ProbeError::Parse {
            source: source(),
            stderr: b"raw ffprobe diagnostic".to_vec(),
        });
        let empty = map_probe_error(ProbeError::Parse {
            source: source(),
            stderr: Vec::new(),
        });
        // This test used to assert `None` here, pinning the fault: one invalid byte anywhere
        // discarded the whole diagnostic, so an `ffprobe` under a non-UTF-8 locale reported
        // nothing a user could read. A repaired diagnostic is worth more than no diagnostic.
        let invalid = map_probe_error(ProbeError::Parse {
            source: source(),
            stderr: b"cannot open \xff\xfe.mkv".to_vec(),
        });
        let long = map_probe_error(ProbeError::Parse {
            source: source(),
            stderr: vec![b'x'; PROBE_DETAIL_LIMIT * 4],
        });
        // The same length in bytes no byte of which is valid UTF-8. The limit cuts input bytes,
        // and the lossy repair then expands each one into a three-byte `U+FFFD`, so this is the
        // real bound on what crosses the wire.
        let long_invalid = map_probe_error(ProbeError::Parse {
            source: source(),
            stderr: vec![0xff; PROBE_DETAIL_LIMIT * 4],
        });

        assert_eq!(valid.detail.as_deref(), Some("raw ffprobe diagnostic"));
        assert_eq!(empty.detail, None);
        let invalid_detail = invalid
            .detail
            .expect("an invalid byte must not cost the whole detail");
        assert!(invalid_detail.contains('\u{fffd}'));
        assert!(invalid_detail.starts_with("cannot open "));
        assert!(invalid_detail.ends_with(".mkv"));
        // `<=`, not `==`: the limit bounds the input bytes the cut keeps, and the ASCII fixture
        // is the case where those two counts happen to agree.
        let long_detail = long.detail.expect("a long stderr still has a detail");
        assert!(long_detail.len() <= PROBE_DETAIL_LIMIT);
        assert_eq!(long_detail, "x".repeat(PROBE_DETAIL_LIMIT));
        let long_invalid_detail = long_invalid
            .detail
            .expect("an all-invalid stderr still has a detail");
        assert_eq!(long_invalid_detail.len(), 3 * PROBE_DETAIL_LIMIT);
        assert_eq!(long_invalid_detail.chars().count(), PROBE_DETAIL_LIMIT);
    }

    #[test]
    fn canonicalize_errors_keep_raw_operating_system_diagnostics() {
        let error = map_canonicalize_error(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "raw operating system diagnostic",
        ));

        assert_eq!(error.code, ImportMediaErrorCode::MetadataFailed);
        assert_eq!(
            error.detail.as_deref(),
            Some("raw operating system diagnostic")
        );
    }

    #[test]
    fn floors_times_before_the_unix_epoch_to_integer_seconds() {
        assert_eq!(
            unix_seconds(UNIX_EPOCH - Duration::from_millis(1)).unwrap(),
            -1
        );
        assert_eq!(
            unix_seconds(UNIX_EPOCH - Duration::from_secs(2)).unwrap(),
            -2
        );
        assert_eq!(
            unix_seconds(UNIX_EPOCH + Duration::from_millis(1999)).unwrap(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_path_that_is_not_unicode() {
        use std::os::unix::ffi::OsStringExt;

        let path = PathBuf::from(std::ffi::OsString::from_vec(vec![b'x', 0xff]));

        let error = unicode_path_fields(&path).unwrap_err();

        assert_eq!(error.code, ImportMediaErrorCode::PathNotUnicode);
    }

    fn successful_import(media_path: &Path) -> ImportMediaResult {
        let app_data = media_path.parent().unwrap();
        import_media_with(
            media_path.to_str().unwrap(),
            app_data,
            |_| None,
            |_, _| Ok(fake_executables(app_data)),
            |_, _| Ok(fake_probe()),
            |_| Ok(()),
        )
        .unwrap()
    }

    fn fake_executables(directory: &Path) -> FfmpegPaths {
        FfmpegPaths {
            ffmpeg: directory.join("ffmpeg"),
            ffprobe: directory.join("ffprobe"),
            origin: ExecutableOrigin::Path,
        }
    }

    fn fake_probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: Some("QuickTime / MOV".to_owned()),
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: Some("High".to_owned()),
            pixel_format: Some("yuv420p".to_owned()),
            bit_depth: Some(8),
            width: 1920,
            height: 1080,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: Some(Pts::new(0)),
            video_duration_ticks: Some(TickCount::new(900_000).unwrap()),
            approximate_duration_seconds: Some(10.0),
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: Some(FrameCount::new(300).unwrap()),
            audio: None,
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let counter = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-import-media-{}-{counter}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
            let path = self.path.join(name);
            fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
