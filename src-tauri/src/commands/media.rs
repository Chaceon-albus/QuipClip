//! Media import validation and probing.

use crate::ffmpeg::capabilities::PROBE_DETAIL_LIMIT;
use crate::ffmpeg::{self, FfmpegPaths, MediaProbe, ProbeError};
use crate::flv::cache::Revision;
use crate::flv::growth;
use crate::project::{self, SourceFingerprint};
use crate::settings;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// The text form of a fingerprint and the fingerprint of the process cover the same bytes.
const _: () = assert!(project::FINGERPRINT_MAX_LEN == growth::FINGERPRINT_LEN);

/// Facts about one validated media file that the frontend can use immediately.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMediaResult {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub mtime: i64,
    pub probe: MediaProbe,
    /// The fingerprint that this import kept for its revision (ADR 058), in the text form of
    /// the project file (ADR 072), or `None` when it kept none. Only an FLV has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<SourceFingerprint>,
}

/// The revision of a file that the caller expects (ADR 072): the size, the modification time,
/// and the fingerprint of an FLV when the project file has one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedRevision {
    pub size: u64,
    pub mtime: i64,
    /// Absent for a revision with no fingerprint. A present `null` is refused.
    #[serde(default, deserialize_with = "crate::project::deserialize_present")]
    pub fingerprint: Option<SourceFingerprint>,
}

/// What the check of a file against an expected revision found, when it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExpectedVerdict {
    /// The revision has no fingerprint, and the file has its size and its modification time.
    /// The import continues as an import with no expected revision.
    Same,
    /// The revision has this fingerprint, and the file holds it: `Same` or `Grown` of ADR 072.
    /// The import reads the file as the expected revision.
    Fingerprinted(growth::Fingerprint),
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
    /// The file is not the revision that the caller expects (ADR 072). The command ran no probe
    /// and gave the web view no permission to read the file.
    RevisionMismatch,
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
pub(crate) struct ValidatedMedia {
    pub(crate) path: PathBuf,
    pub(crate) path_text: String,
    file_name: String,
    pub(crate) size: u64,
    pub(crate) mtime: i64,
}

/// Validate, inspect, and authorize exactly one user-selected media file.
///
/// With `expected`, the file must be that revision (ADR 072), or the command answers
/// `revisionMismatch` before the probe and before the grant. An FLV whose revision has a
/// fingerprint and that a recorder wrote further is read as its first `expected.size` bytes.
#[tauri::command]
pub async fn import_media(
    app: tauri::AppHandle,
    path: String,
    expected: Option<ExpectedRevision>,
) -> Result<ImportMediaResult, ImportMediaError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| generated_error(ImportMediaErrorCode::AppDataUnavailable))?;

    tauri::async_runtime::spawn_blocking(move || {
        import_media_with(
            &path,
            expected.as_ref(),
            &app_data_directory,
            settings::configured_ffmpeg_path,
            ffmpeg::discover,
            ffmpeg::probe_media_up_to,
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

#[allow(clippy::too_many_arguments)]
fn import_media_with<ConfiguredPath, Discover, Probe, Allow>(
    path: &str,
    expected: Option<&ExpectedRevision>,
    app_data_directory: &Path,
    configured_path: ConfiguredPath,
    discover: Discover,
    probe: Probe,
    allow: Allow,
) -> Result<ImportMediaResult, ImportMediaError>
where
    ConfiguredPath: FnOnce(&Path) -> Option<PathBuf>,
    Discover: FnOnce(Option<&Path>, &Path) -> Result<FfmpegPaths, ffmpeg::LocateError>,
    Probe: FnOnce(&Path, &Path, u64) -> Result<MediaProbe, ProbeError>,
    Allow: FnOnce(&Path) -> Result<(), String>,
{
    let media = validate_media(path)?;
    // The check of an expected revision comes before the probe and before the grant (ADR 072).
    let verdict = expected
        .map(|expected| check_expected(&media, expected))
        .transpose()?;
    // The revision that this import reads, and its fingerprint.
    let (size, mtime, fingerprint, must_be_flv) = match (expected, verdict) {
        (Some(expected), Some(ExpectedVerdict::Fingerprinted(fingerprint))) => {
            (expected.size, expected.mtime, Some(fingerprint), true)
        }
        // Right after the size, before the probe can take seconds: a recorder that starts the
        // file again meanwhile must not give its bytes to this revision (ADR 058). A file that
        // is not an FLV gives none after one block.
        _ => (
            media.size,
            media.mtime,
            growth::fingerprint(&media.path, media.size),
            false,
        ),
    };
    let configured = configured_path(app_data_directory);
    let executables = discover(configured.as_deref(), app_data_directory)
        .map_err(|_| generated_error(ImportMediaErrorCode::FfmpegPairMissing))?;
    // The probe reads an FLV no further than the size of this revision, so the length that it
    // reports is the length of the revision, also while a recorder still writes the file
    // (ADR 058).
    let probe = probe(&executables.ffprobe, &media.path, size).map_err(map_probe_error)?;
    let is_flv = probe.format_names.iter().any(|name| name == "flv");
    // Only an FLV can hold a fingerprint, so a revision with one names an FLV (ADR 072).
    if must_be_flv && !is_flv {
        return Err(ImportMediaError::new(
            ImportMediaErrorCode::RevisionMismatch,
        ));
    }

    // The scope denial carries its diagnostic. `import_media`'s closure stringifies the Tauri
    // error on purpose, and a denial is not an enumerable condition: the scope layer refuses a
    // pattern for reasons this command does not decide and cannot list. ADR 011 keeps the text
    // there -- the interface still renders the localized `assetScopeDenied`, and the string is
    // only what a user copies into a bug report.
    allow(&media.path).map_err(|detail| {
        ImportMediaError::with_detail(ImportMediaErrorCode::AssetScopeDenied, detail)
    })?;

    // Later checks of this revision accept the file when a recorder only added to it.
    let kept = fingerprint.filter(|_| is_flv);
    if let Some(fingerprint) = kept {
        growth::keep(
            &Revision {
                path: media.path_text.clone(),
                size,
                mtime,
            },
            fingerprint,
        );
    }

    Ok(ImportMediaResult {
        path: media.path_text,
        file_name: media.file_name,
        size,
        mtime,
        probe,
        fingerprint: kept.map(|fingerprint| {
            SourceFingerprint::from_parts(fingerprint.start(), fingerprint.fnv1a64())
        }),
    })
}

/// Compare the file that `media` describes with the revision `expected` (ADR 072).
///
/// - With no fingerprint, the file holds the revision when its size and its modification time
///   are those of the revision (`Same`).
/// - With a fingerprint, the file holds the revision when its size is not smaller, its
///   modification time is not earlier, and the fingerprint of its first `expected.size` bytes
///   has the start and the hash of the expected one (`Same` or `Grown`).
///
/// Each other case is `revisionMismatch`. A fingerprint that breaks a rule of the project file
/// names no revision of a file, so it is `revisionMismatch` too.
///
/// First the file must open for reading. A stat does not show that: a file whose permissions
/// refuse each read keeps its size and its modification time. Such a file fails with
/// `metadataFailed` and the error of the system as its detail.
fn check_expected(
    media: &ValidatedMedia,
    expected: &ExpectedRevision,
) -> Result<ExpectedVerdict, ImportMediaError> {
    fs::File::open(&media.path).map_err(|error| {
        ImportMediaError::with_detail(ImportMediaErrorCode::MetadataFailed, error.to_string())
    })?;
    let mismatch = || ImportMediaError::new(ImportMediaErrorCode::RevisionMismatch);
    let Some(text) = expected.fingerprint.as_ref() else {
        return if media.size == expected.size && media.mtime == expected.mtime {
            Ok(ExpectedVerdict::Same)
        } else {
            Err(mismatch())
        };
    };
    let (start, hash) = project::parse_fingerprint(text, expected.size).ok_or_else(mismatch)?;
    let wanted = growth::Fingerprint::new(start, hash);
    if media.size < expected.size || media.mtime < expected.mtime {
        return Err(mismatch());
    }
    match growth::fingerprint(&media.path, expected.size) {
        Some(found) if found == wanted => Ok(ExpectedVerdict::Fingerprinted(wanted)),
        _ => Err(mismatch()),
    }
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
///
/// With `expected`, the command gives the verdict of `import_media` for that revision (ADR 072)
/// with no probe: a file that does not hold it answers `revisionMismatch`. A file that holds it
/// answers its stat, as without `expected`.
#[tauri::command]
pub async fn read_source_revision(
    path: String,
    expected: Option<ExpectedRevision>,
) -> Result<SourceRevision, ImportMediaError> {
    tauri::async_runtime::spawn_blocking(move || {
        read_source_revision_blocking(&path, expected.as_ref())
    })
    .await
    .map_err(|error| join_failure(&error))?
}

/// The body of [`read_source_revision`], off the async runtime so a test can reach it.
fn read_source_revision_blocking(
    path: &str,
    expected: Option<&ExpectedRevision>,
) -> Result<SourceRevision, ImportMediaError> {
    let media = validate_media(path)?;
    if let Some(expected) = expected {
        check_expected(&media, expected)?;
    }
    Ok(SourceRevision {
        path: media.path_text,
        size: media.size,
        mtime: media.mtime,
    })
}

pub(crate) fn validate_media(path: &str) -> Result<ValidatedMedia, ImportMediaError> {
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
        // Only the probe of an export output takes a cancel flag, and `commands::export` maps
        // that probe's cancel itself. The import and the re-probe of the source pass none, so
        // this arm is unreachable. It reports rather than panics, as an unexpected failure.
        ProbeError::Canceled => {
            debug_assert!(false, "a probe of the source cannot be canceled");
            ImportMediaError::new(ImportMediaErrorCode::FfprobeProcessFailed)
        }
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
                None,
                &directory.path,
                |_| unreachable!(),
                |_, _| {
                    *called.borrow_mut() = true;
                    unreachable!()
                },
                |_, _, _| unreachable!(),
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
            let error = read_source_revision_blocking(&path, None).unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[test]
    fn a_revision_read_reports_the_canonical_path_and_the_byte_length() {
        let directory = TestDirectory::new();
        let media_path = directory.file("clip.mp4", b"media");
        let canonical = media_path.canonicalize().unwrap();

        let revision = read_source_revision_blocking(media_path.to_str().unwrap(), None).unwrap();

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

        let revision = read_source_revision_blocking(media_path.to_str().unwrap(), None).unwrap();
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
            None,
            &directory.path,
            |_| None,
            |_, _| Err(ffmpeg::LocateError::NotFound { inspected: vec![] }),
            |_, _, _| {
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
            None,
            &directory.path,
            |_| {
                events.borrow_mut().push("configured-path");
                None
            },
            |_, _| {
                events.borrow_mut().push("discover");
                Ok(fake_executables(&directory.path))
            },
            |_, path, size| {
                assert_eq!(path, canonical);
                // The probe reads the file as the revision of the import (ADR 058).
                assert_eq!(size, 5);
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
            None,
            &directory.path,
            |_| Some(PathBuf::from("/configured/bin")),
            |configured, _| {
                *received.borrow_mut() = Some(configured.map(Path::to_path_buf));
                Ok(fake_executables(&directory.path))
            },
            |_, _, _| Ok(fake_probe()),
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
            None,
            &directory.path,
            |_| None,
            |configured, _| {
                *received.borrow_mut() = Some(configured.map(Path::to_path_buf));
                Ok(fake_executables(&directory.path))
            },
            |_, _, _| Ok(fake_probe()),
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
            None,
            &directory.path,
            |_| None,
            |_, _| Ok(fake_executables(&directory.path)),
            |_, _, _| {
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
            None,
            &directory.path,
            |_| None,
            |_, _| Ok(fake_executables(&directory.path)),
            |_, _, _| Ok(fake_probe()),
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
            None,
            app_data,
            |_| None,
            |_, _| Ok(fake_executables(app_data)),
            |_, _, _| Ok(fake_probe()),
            |_| Ok(()),
        )
        .unwrap()
    }

    /// Imports `bytes` as an FLV with `probe`, calls `during_probe` inside the probe, and then
    /// writes `after` to the file. Returns the verdict on the file as it is then.
    fn grown_import_verdict(
        bytes: &[u8],
        probe: MediaProbe,
        during_probe: &dyn Fn(&Path),
        after: &[u8],
    ) -> growth::Verdict {
        let directory = TestDirectory::new();
        let media_path = directory.file("live.flv", bytes);
        let result = import_media_with(
            media_path.to_str().unwrap(),
            None,
            &directory.path,
            |_| None,
            |_, _| Ok(fake_executables(&directory.path)),
            |_, path, _| {
                during_probe(path);
                Ok(probe)
            },
            |_| Ok(()),
        )
        .unwrap();
        fs::write(&media_path, after).unwrap();
        let now = validate_media(&result.path).unwrap();
        growth::verdict(
            &Revision {
                path: result.path.clone(),
                size: result.size,
                mtime: result.mtime,
            },
            &now.path,
            now.size,
            now.mtime,
        )
    }

    #[test]
    fn an_flv_import_keeps_the_fingerprint_that_it_read_before_the_probe() {
        let bytes = crate::flv::test_support::recording(
            &crate::flv::test_support::RecordingOptions::default(),
        )
        .bytes;
        let cut = bytes.len() - 1000;
        let flv = || MediaProbe {
            format_names: vec!["flv".to_owned()],
            ..fake_probe()
        };
        let mut restarted = bytes.clone();
        restarted[cut - 10] ^= 0xFF;

        // A recorder that only adds to the file keeps the revision of an FLV.
        assert_eq!(
            grown_import_verdict(&bytes[..cut], flv(), &|_| {}, &bytes),
            growth::Verdict::Grown
        );
        // Another container keeps no fingerprint.
        assert_eq!(
            grown_import_verdict(&bytes[..cut], fake_probe(), &|_| {}, &bytes),
            growth::Verdict::Changed
        );
        // A recorder that starts the file again during the probe gives the revision no bytes of
        // the new file: the fingerprint came before the probe.
        assert_eq!(
            grown_import_verdict(
                &bytes[..cut],
                flv(),
                &|path| fs::write(path, &restarted).unwrap(),
                &restarted,
            ),
            growth::Verdict::Changed
        );
    }

    /// What one import with an expected revision did: its result, the size that each probe
    /// read, and the number of grants of the asset scope.
    struct ExpectedImport {
        result: Result<ImportMediaResult, ImportMediaError>,
        probes: Vec<u64>,
        grants: usize,
    }

    fn import_expecting(
        path: &Path,
        expected: &ExpectedRevision,
        probe: MediaProbe,
    ) -> ExpectedImport {
        let probes = RefCell::new(Vec::new());
        let grants = RefCell::new(0);
        let app_data = path.parent().unwrap();
        let result = import_media_with(
            path.to_str().unwrap(),
            Some(expected),
            app_data,
            |_| None,
            |_, _| Ok(fake_executables(app_data)),
            |_, _, size| {
                probes.borrow_mut().push(size);
                Ok(probe)
            },
            |_| {
                *grants.borrow_mut() += 1;
                Ok(())
            },
        );
        ExpectedImport {
            result,
            probes: probes.into_inner(),
            grants: grants.into_inner(),
        }
    }

    fn assert_mismatch_without_probe(import: &ExpectedImport, case: &str) {
        assert_eq!(
            import.result.as_ref().map(|_| ()).unwrap_err().code,
            ImportMediaErrorCode::RevisionMismatch,
            "{case}"
        );
        assert!(import.probes.is_empty(), "{case}");
        assert_eq!(import.grants, 0, "{case}");
    }

    fn flv_probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["flv".to_owned()],
            ..fake_probe()
        }
    }

    /// The text form of a fingerprint of the process.
    fn text_of(fingerprint: growth::Fingerprint) -> SourceFingerprint {
        SourceFingerprint::from_parts(fingerprint.start(), fingerprint.fnv1a64())
    }

    /// A recording cut inside a tag, as a recorder leaves it between two writes, written as
    /// `live.flv` in a new directory. Returns the whole recording and the revision of the cut
    /// file with its fingerprint, as a project file holds it.
    fn saved_flv() -> (TestDirectory, PathBuf, Vec<u8>, ExpectedRevision) {
        let bytes = crate::flv::test_support::recording(
            &crate::flv::test_support::RecordingOptions::default(),
        )
        .bytes;
        let directory = TestDirectory::new();
        let path = directory.file("live.flv", &bytes[..bytes.len() - 1000]);
        let media = validate_media(path.to_str().unwrap()).unwrap();
        let fingerprint = growth::fingerprint(&media.path, media.size).unwrap();
        let expected = ExpectedRevision {
            size: media.size,
            mtime: media.mtime,
            fingerprint: Some(text_of(fingerprint)),
        };
        (directory, path, bytes, expected)
    }

    /// The verdict of ADR 058 on the file at `path` now, for the revision of `result`.
    fn verdict_now(path: &Path, result: &ImportMediaResult) -> growth::Verdict {
        let now = validate_media(path.to_str().unwrap()).unwrap();
        growth::verdict(
            &Revision {
                path: result.path.clone(),
                size: result.size,
                mtime: result.mtime,
            },
            &now.path,
            now.size,
            now.mtime,
        )
    }

    #[test]
    fn the_same_flv_imports_as_the_expected_revision_and_keeps_its_fingerprint() {
        let (_directory, path, bytes, expected) = saved_flv();
        let import = import_expecting(&path, &expected, flv_probe());
        let result = import.result.unwrap();
        assert_eq!(import.probes, vec![expected.size]);
        assert_eq!(import.grants, 1);
        assert_eq!(result.size, expected.size);
        assert_eq!(result.mtime, expected.mtime);
        assert_eq!(result.fingerprint, expected.fingerprint);
        // The process keeps the fingerprint, so a later check accepts the file that grew.
        fs::write(&path, &bytes).unwrap();
        assert_eq!(verdict_now(&path, &result), growth::Verdict::Grown);
    }

    #[test]
    fn a_grown_flv_imports_as_the_revision_that_the_project_saved() {
        let (_directory, path, bytes, expected) = saved_flv();
        fs::write(&path, &bytes).unwrap();
        let import = import_expecting(&path, &expected, flv_probe());
        let result = import.result.unwrap();
        // The probe reads the first `size` bytes, and the answer is the expected revision.
        assert_eq!(import.probes, vec![expected.size]);
        assert_eq!(import.grants, 1);
        assert_eq!(result.size, expected.size);
        assert!(result.size < bytes.len() as u64);
        assert_eq!(result.mtime, expected.mtime);
        assert_eq!(result.fingerprint, expected.fingerprint);
        assert_eq!(verdict_now(&path, &result), growth::Verdict::Grown);
    }

    #[test]
    fn a_file_that_is_not_the_expected_revision_runs_no_probe_and_no_grant() {
        let (_directory, path, bytes, expected) = saved_flv();
        let cut = expected.size as usize;
        let fingerprint = expected.fingerprint.clone().unwrap();
        let (start, hash) = project::parse_fingerprint(&fingerprint, expected.size).unwrap();

        // A recorder that started the file again: other bytes in front of the size.
        let mut restarted = bytes.clone();
        restarted[cut - 10] ^= 0xFF;
        fs::write(&path, &restarted).unwrap();
        assert_mismatch_without_probe(
            &import_expecting(&path, &expected, flv_probe()),
            "restarted",
        );

        // A smaller file.
        fs::write(&path, &bytes[..cut - 1]).unwrap();
        assert_mismatch_without_probe(&import_expecting(&path, &expected, flv_probe()), "smaller");

        // The file as it was saved, against other expectations.
        fs::write(&path, &bytes[..cut]).unwrap();
        let mtime = validate_media(path.to_str().unwrap()).unwrap().mtime;
        let cases = [
            (
                "an earlier time",
                ExpectedRevision {
                    mtime: mtime + 1,
                    ..expected.clone()
                },
            ),
            (
                "another start",
                ExpectedRevision {
                    mtime,
                    fingerprint: Some(SourceFingerprint::from_parts(start + 1, hash)),
                    ..expected.clone()
                },
            ),
            (
                "another hash",
                ExpectedRevision {
                    mtime,
                    fingerprint: Some(SourceFingerprint::from_parts(start, hash ^ 1)),
                    ..expected.clone()
                },
            ),
            (
                "a fingerprint that breaks its form",
                ExpectedRevision {
                    mtime,
                    fingerprint: Some(SourceFingerprint {
                        start: fingerprint.start.clone(),
                        fnv1a64: fingerprint.fnv1a64.to_uppercase(),
                    }),
                    ..expected.clone()
                },
            ),
            (
                "a start beyond the size",
                ExpectedRevision {
                    mtime,
                    fingerprint: Some(SourceFingerprint::from_parts(expected.size, hash)),
                    ..expected.clone()
                },
            ),
        ];
        for (case, other) in &cases {
            assert_mismatch_without_probe(&import_expecting(&path, other, flv_probe()), case);
        }
        // The same file against its own revision still imports.
        let same = ExpectedRevision {
            mtime,
            ..expected.clone()
        };
        assert!(import_expecting(&path, &same, flv_probe()).result.is_ok());
    }

    #[test]
    fn a_revision_with_a_fingerprint_needs_an_flv() {
        // A file that is not an FLV has no fingerprint: no probe runs.
        let directory = TestDirectory::new();
        let path = directory.file("clip.mp4", &[0u8; 4096]);
        let media = validate_media(path.to_str().unwrap()).unwrap();
        let expected = ExpectedRevision {
            size: media.size,
            mtime: media.mtime,
            fingerprint: Some(SourceFingerprint::from_parts(0, 0x1234)),
        };
        assert_mismatch_without_probe(&import_expecting(&path, &expected, flv_probe()), "zeros");

        // The bytes of an FLV whose probe names another format: the probe runs, the grant does
        // not, and the process keeps no fingerprint.
        let (_flv_directory, flv_path, bytes, expected) = saved_flv();
        fs::write(&flv_path, &bytes).unwrap();
        let import = import_expecting(&flv_path, &expected, fake_probe());
        assert_eq!(
            import.result.as_ref().map(|_| ()).unwrap_err().code,
            ImportMediaErrorCode::RevisionMismatch
        );
        assert_eq!(import.probes, vec![expected.size]);
        assert_eq!(import.grants, 0);
        let now = validate_media(flv_path.to_str().unwrap()).unwrap();
        assert_eq!(
            growth::verdict(
                &Revision {
                    path: now.path_text.clone(),
                    size: expected.size,
                    mtime: expected.mtime,
                },
                &now.path,
                now.size,
                now.mtime,
            ),
            growth::Verdict::Changed
        );
    }

    #[test]
    fn a_revision_with_no_fingerprint_needs_the_same_size_and_time() {
        let directory = TestDirectory::new();
        let path = directory.file("clip.mp4", b"media");
        let media = validate_media(path.to_str().unwrap()).unwrap();
        let same = ExpectedRevision {
            size: 5,
            mtime: media.mtime,
            fingerprint: None,
        };
        let import = import_expecting(&path, &same, fake_probe());
        let result = import.result.unwrap();
        assert_eq!(import.probes, vec![5]);
        assert_eq!(import.grants, 1);
        assert_eq!((result.size, result.mtime), (5, media.mtime));
        assert_eq!(result.fingerprint, None);
        for (case, other) in [
            (
                "another size",
                ExpectedRevision {
                    size: 4,
                    ..same.clone()
                },
            ),
            (
                "another time",
                ExpectedRevision {
                    mtime: media.mtime - 1,
                    ..same.clone()
                },
            ),
        ] {
            assert_mismatch_without_probe(&import_expecting(&path, &other, fake_probe()), case);
        }

        // An FLV of the same revision imports as with no expected revision, and keeps its
        // fingerprint. One that grew needs the fingerprint in the expected revision.
        let (_flv_directory, flv_path, bytes, with_fingerprint) = saved_flv();
        let without = ExpectedRevision {
            fingerprint: None,
            ..with_fingerprint.clone()
        };
        let result = import_expecting(&flv_path, &without, flv_probe())
            .result
            .unwrap();
        assert_eq!(result.fingerprint, with_fingerprint.fingerprint);
        fs::write(&flv_path, &bytes).unwrap();
        assert_mismatch_without_probe(
            &import_expecting(&flv_path, &without, flv_probe()),
            "grown without a fingerprint",
        );
    }

    #[test]
    fn an_import_answers_the_fingerprint_that_it_kept() {
        let (directory, path, _bytes, expected) = saved_flv();
        let import = |probe: MediaProbe| {
            import_media_with(
                path.to_str().unwrap(),
                None,
                &directory.path,
                |_| None,
                |_, _| Ok(fake_executables(&directory.path)),
                |_, _, _| Ok(probe),
                |_| Ok(()),
            )
            .unwrap()
        };
        let flv = import(flv_probe());
        assert_eq!(flv.fingerprint, expected.fingerprint);
        let value = serde_json::to_value(&flv).unwrap();
        let fingerprint = expected.fingerprint.unwrap();
        assert_eq!(
            value["fingerprint"],
            serde_json::json!({ "start": fingerprint.start, "fnv1a64": fingerprint.fnv1a64 })
        );
        // Another container keeps none, and the answer has no field.
        let other = import(fake_probe());
        assert_eq!(other.fingerprint, None);
        assert!(serde_json::to_value(&other)
            .unwrap()
            .get("fingerprint")
            .is_none());
    }

    #[test]
    fn a_revision_read_gives_the_verdict_of_an_expected_revision() {
        let (_directory, path, bytes, expected) = saved_flv();
        let text = path.to_str().unwrap();
        // The same file answers its stat.
        let same = read_source_revision_blocking(text, Some(&expected)).unwrap();
        assert_eq!((same.size, same.mtime), (expected.size, expected.mtime));
        // A file that grew answers the stat of the file now.
        fs::write(&path, &bytes).unwrap();
        let grown = read_source_revision_blocking(text, Some(&expected)).unwrap();
        assert_eq!(grown.size, bytes.len() as u64);
        // Another file answers the error.
        let mut restarted = bytes.clone();
        restarted[expected.size as usize - 10] ^= 0xFF;
        fs::write(&path, &restarted).unwrap();
        assert_eq!(
            read_source_revision_blocking(text, Some(&expected))
                .unwrap_err()
                .code,
            ImportMediaErrorCode::RevisionMismatch
        );
        // With no fingerprint, only the same size and time hold.
        let now = read_source_revision_blocking(text, None).unwrap();
        let exact = ExpectedRevision {
            size: now.size,
            mtime: now.mtime,
            fingerprint: None,
        };
        assert_eq!(
            read_source_revision_blocking(text, Some(&exact)).unwrap(),
            now
        );
        assert_eq!(
            read_source_revision_blocking(
                text,
                Some(&ExpectedRevision {
                    size: now.size - 1,
                    ..exact
                })
            )
            .unwrap_err()
            .code,
            ImportMediaErrorCode::RevisionMismatch
        );
    }

    #[test]
    fn a_mismatch_wins_over_a_missing_ffmpeg() {
        // The check comes before discovery: no callback may run.
        let directory = TestDirectory::new();
        let path = directory.file("clip.mp4", b"media");
        let media = validate_media(path.to_str().unwrap()).unwrap();
        let other = ExpectedRevision {
            size: 4,
            mtime: media.mtime,
            fingerprint: None,
        };
        let error = import_media_with(
            path.to_str().unwrap(),
            Some(&other),
            &directory.path,
            |_| panic!("the configured path must not be read"),
            |_, _| panic!("discovery must not run"),
            |_, _, _| panic!("the probe must not run"),
            |_| panic!("the grant must not happen"),
        )
        .unwrap_err();
        assert_eq!(error.code, ImportMediaErrorCode::RevisionMismatch);
    }

    #[cfg(unix)]
    #[test]
    fn an_expected_revision_needs_a_file_that_opens_for_reading() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let path = directory.file("clip.mp4", b"media");
        let media = validate_media(path.to_str().unwrap()).unwrap();
        let same = ExpectedRevision {
            size: media.size,
            mtime: media.mtime,
            fingerprint: None,
        };
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let readable = fs::File::open(&path).is_ok();
        let text = path.to_str().unwrap();
        // The stat alone does not see the permissions, so a revision read with no expected
        // revision still answers.
        let stat = read_source_revision_blocking(text, None);
        let with_expected = read_source_revision_blocking(text, Some(&same));
        let import = import_expecting(&path, &same, fake_probe());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(stat.unwrap().size, media.size);
        // A process that reads each file anyway, such as one of the superuser, cannot test this.
        if readable {
            return;
        }
        let error = with_expected.unwrap_err();
        assert_eq!(error.code, ImportMediaErrorCode::MetadataFailed);
        assert!(error.detail.is_some());
        let error = import.result.as_ref().map(|_| ()).unwrap_err();
        assert_eq!(error.code, ImportMediaErrorCode::MetadataFailed);
        assert!(import.probes.is_empty());
        assert_eq!(import.grants, 0);
    }

    #[test]
    fn an_expected_revision_reads_from_camel_case_json_and_refuses_null() {
        let plain: ExpectedRevision =
            serde_json::from_value(serde_json::json!({ "size": 5, "mtime": -3 })).unwrap();
        assert_eq!(
            plain,
            ExpectedRevision {
                size: 5,
                mtime: -3,
                fingerprint: None
            }
        );
        let with: ExpectedRevision = serde_json::from_value(serde_json::json!({
            "size": 5,
            "mtime": 1,
            "fingerprint": { "start": "0", "fnv1a64": "00000000000000ff" }
        }))
        .unwrap();
        assert_eq!(
            with.fingerprint,
            Some(SourceFingerprint::from_parts(0, 0xff))
        );
        for bad in [
            serde_json::json!({ "size": 5, "mtime": 1, "fingerprint": null }),
            serde_json::json!({ "size": 5, "mtime": 1, "videoEndPts": "1" }),
            serde_json::json!({ "size": 5 }),
            serde_json::json!({ "size": -1, "mtime": 1 }),
            serde_json::json!({
                "size": 5,
                "mtime": 1,
                "fingerprint": { "start": "0", "fnv1a64": "00000000000000ff", "x": 1 }
            }),
        ] {
            assert!(
                serde_json::from_value::<ExpectedRevision>(bad.clone()).is_err(),
                "{bad}"
            );
        }
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
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: None,
            audio_streams: Vec::new(),
            audio_stream_probes: Vec::new(),
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
