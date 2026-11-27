//! Tauri commands for loading and saving project files.

use crate::project::{self, ProjectFile, ProjectFileError, ProjectValidationError};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The end of the name of a project file. The test ignores the letter case (ADR 072).
const PROJECT_FILE_EXTENSION: &str = ".qcproj";

/// Stable error names translated by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectCommandErrorCode {
    InvalidPath,
    PathNotFound,
    PathNotFile,
    PathNotUnicode,
    PermissionDenied,
    ReadFailed,
    WriteFailed,
    InvalidJson,
    InvalidProject,
    UnsafeProjectValue,
    FutureSchemaVersion,
    /// The project file, or the document that a save would write, is larger than
    /// `project::PROJECT_FILE_MAX_BYTES` (32 MiB).
    TooLarge,
    CommandExecutionFailed,
}

/// A command error with a localizable code and optional untranslated facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommandError {
    pub code: ProjectCommandErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found_schema_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_schema_version: Option<u32>,
}

impl ProjectCommandError {
    fn new(code: ProjectCommandErrorCode) -> Self {
        Self {
            code,
            detail: None,
            field: None,
            value: None,
            found_schema_version: None,
            supported_schema_version: None,
        }
    }

    fn with_schema(code: ProjectCommandErrorCode, found: u64, supported: u32) -> Self {
        Self {
            found_schema_version: Some(found),
            supported_schema_version: Some(supported),
            ..Self::new(code)
        }
    }
}

/// The answer of [`load_project`] (ADR 072).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    /// The canonical path of the project file.
    pub path: String,
    /// The validated document.
    pub project: ProjectFile,
    /// The candidate paths of each source, in the order of `project.sources`: the `relPath`
    /// resolved against the directory of the project file when the entry has one, and then the
    /// `path`. Equal paths appear once.
    pub candidates: Vec<Vec<String>>,
}

/// The answer of [`save_project`] (ADR 072).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    /// The canonical path of the written project file.
    pub path: String,
}

/// Load one validated project from an explicit file path.
#[tauri::command]
pub async fn load_project(path: String) -> Result<LoadedProject, ProjectCommandError> {
    tauri::async_runtime::spawn_blocking(move || load_project_with(&path))
        .await
        .map_err(|_| generated_error(ProjectCommandErrorCode::CommandExecutionFailed))?
}

fn load_project_with(path: &str) -> Result<LoadedProject, ProjectCommandError> {
    let path = validate_load_path(path)?;
    let document =
        project::load(&path).map_err(|error| map_project_error(error, IoOperation::Read))?;
    let directory = path
        .parent()
        .ok_or_else(|| ProjectCommandError::new(ProjectCommandErrorCode::InvalidPath))?;
    let candidates = document
        .sources
        .iter()
        .map(|source| project::candidate_paths(directory, source))
        .collect();
    Ok(LoadedProject {
        path: unicode_text(&path)?,
        project: document,
        candidates,
    })
}

/// Save one validated project to an explicit file path. The backend writes the `relPath` of
/// each source, and ignores the value of the caller (ADR 072).
#[tauri::command]
pub async fn save_project(
    path: String,
    project: ProjectFile,
) -> Result<SavedProject, ProjectCommandError> {
    tauri::async_runtime::spawn_blocking(move || save_project_with(&path, &project))
        .await
        .map_err(|_| generated_error(ProjectCommandErrorCode::CommandExecutionFailed))?
}

fn save_project_with(
    path: &str,
    project: &ProjectFile,
) -> Result<SavedProject, ProjectCommandError> {
    let path = validate_save_path(path)?;
    project::save(&path, project).map_err(|error| map_project_error(error, IoOperation::Write))?;
    Ok(SavedProject {
        path: unicode_text(&path)?,
    })
}

/// The text of a path that `ensure_unicode_path` accepted.
fn unicode_text(path: &Path) -> Result<String, ProjectCommandError> {
    ensure_unicode_path(path)?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| ProjectCommandError::new(ProjectCommandErrorCode::PathNotUnicode))
}

/// True when the path text `path` ends in `.qcproj`, with ASCII case folding (ADR 072). The
/// test reads the text as the caller sent it, before `Path` reads components: `Path` drops a
/// final `.`, so `/work/cut.qcproj/.` would otherwise pass.
fn has_project_extension(path: &str) -> bool {
    path.len() >= PROJECT_FILE_EXTENSION.len()
        && path.is_char_boundary(path.len() - PROJECT_FILE_EXTENSION.len())
        && path[path.len() - PROJECT_FILE_EXTENSION.len()..]
            .eq_ignore_ascii_case(PROJECT_FILE_EXTENSION)
}

fn validate_load_path(path: &str) -> Result<PathBuf, ProjectCommandError> {
    validate_path_text(path)?;
    let canonical =
        fs::canonicalize(path).map_err(|error| map_io_error(error, IoOperation::Read))?;
    ensure_unicode_path(&canonical)?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| map_io_error(error, IoOperation::Read))?;
    if !metadata.is_file() {
        return Err(ProjectCommandError::new(
            ProjectCommandErrorCode::PathNotFile,
        ));
    }
    Ok(canonical)
}

fn validate_save_path(path: &str) -> Result<PathBuf, ProjectCommandError> {
    validate_path_text(path)?;
    if !has_project_extension(path) {
        return Err(ProjectCommandError::new(
            ProjectCommandErrorCode::InvalidPath,
        ));
    }
    let requested = Path::new(path);
    let file_name = requested
        .file_name()
        .ok_or_else(|| ProjectCommandError::new(ProjectCommandErrorCode::InvalidPath))?;
    if matches!(
        requested.components().next_back(),
        Some(Component::CurDir | Component::ParentDir)
    ) {
        return Err(ProjectCommandError::new(
            ProjectCommandErrorCode::InvalidPath,
        ));
    }

    let parent = requested
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| map_io_error(error, IoOperation::Write))?;
    ensure_unicode_path(&canonical_parent)?;
    if !fs::metadata(&canonical_parent)
        .map_err(|error| map_io_error(error, IoOperation::Write))?
        .is_dir()
    {
        return Err(ProjectCommandError::new(
            ProjectCommandErrorCode::InvalidPath,
        ));
    }

    let destination = canonical_parent.join(file_name);
    ensure_unicode_path(&destination)?;
    match fs::metadata(&destination) {
        Ok(metadata) if !metadata.is_file() => Err(ProjectCommandError::new(
            ProjectCommandErrorCode::PathNotFile,
        )),
        Ok(_) => Ok(destination),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(destination),
        Err(error) => Err(map_io_error(error, IoOperation::Write)),
    }
}

fn validate_path_text(path: &str) -> Result<(), ProjectCommandError> {
    if path.trim().is_empty() || path.contains('\0') {
        Err(ProjectCommandError::new(
            ProjectCommandErrorCode::InvalidPath,
        ))
    } else {
        Ok(())
    }
}

fn ensure_unicode_path(path: &Path) -> Result<(), ProjectCommandError> {
    if path.to_str().is_some() {
        Ok(())
    } else {
        Err(ProjectCommandError::new(
            ProjectCommandErrorCode::PathNotUnicode,
        ))
    }
}

fn generated_error(code: ProjectCommandErrorCode) -> ProjectCommandError {
    ProjectCommandError::new(code)
}

#[derive(Debug, Clone, Copy)]
enum IoOperation {
    Read,
    Write,
}

fn map_io_error(error: io::Error, operation: IoOperation) -> ProjectCommandError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => ProjectCommandErrorCode::PathNotFound,
        io::ErrorKind::PermissionDenied => ProjectCommandErrorCode::PermissionDenied,
        io::ErrorKind::InvalidInput => ProjectCommandErrorCode::InvalidPath,
        _ => match operation {
            IoOperation::Read => ProjectCommandErrorCode::ReadFailed,
            IoOperation::Write => ProjectCommandErrorCode::WriteFailed,
        },
    };
    let detail = error.raw_os_error().map(|_| error.to_string());
    ProjectCommandError {
        detail,
        ..ProjectCommandError::new(code)
    }
}

fn map_project_error(error: ProjectFileError, operation: IoOperation) -> ProjectCommandError {
    match error {
        ProjectFileError::Io(error) => map_io_error(error, operation),
        ProjectFileError::Json(_) => ProjectCommandError::new(ProjectCommandErrorCode::InvalidJson),
        ProjectFileError::Validation(error) => map_validation_error(error),
        ProjectFileError::FutureSchemaVersion { found, supported } => map_schema_version(
            ProjectCommandErrorCode::FutureSchemaVersion,
            found,
            supported,
        ),
        ProjectFileError::TooLarge { .. } => {
            ProjectCommandError::new(ProjectCommandErrorCode::TooLarge)
        }
    }
}

fn map_schema_version(
    code: ProjectCommandErrorCode,
    found: u64,
    supported: u32,
) -> ProjectCommandError {
    if found > JAVASCRIPT_MAX_SAFE_INTEGER {
        ProjectCommandError {
            field: Some("schemaVersion".to_owned()),
            value: Some(found.to_string()),
            ..ProjectCommandError::new(ProjectCommandErrorCode::UnsafeProjectValue)
        }
    } else {
        ProjectCommandError::with_schema(code, found, supported)
    }
}

fn map_validation_error(error: ProjectValidationError) -> ProjectCommandError {
    match error {
        ProjectValidationError::SchemaVersion { found, expected } if found > expected => {
            ProjectCommandError::with_schema(
                ProjectCommandErrorCode::FutureSchemaVersion,
                u64::from(found),
                expected,
            )
        }
        ProjectValidationError::SchemaVersion { .. } => {
            ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        }
        ProjectValidationError::UnsafeInteger { field, value } => ProjectCommandError {
            field: Some(field),
            value: Some(value.to_string()),
            ..ProjectCommandError::new(ProjectCommandErrorCode::UnsafeProjectValue)
        },
        ProjectValidationError::NonPositiveTimebase { field }
        | ProjectValidationError::InvalidFrameRate { field } => ProjectCommandError {
            field: Some(field),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidApproximateDuration { index } => ProjectCommandError {
            field: Some(format!("sources[{index}].approximateDurationSeconds")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidSegmentRange { index } => ProjectCommandError {
            field: Some(format!("segments[{index}]")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidSegmentName { index } => ProjectCommandError {
            field: Some(format!("segments[{index}].name")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidSourcePath { index } => ProjectCommandError {
            field: Some(format!("sources[{index}].path")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidRelPath { index } => ProjectCommandError {
            field: Some(format!("sources[{index}].relPath")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::InvalidFingerprint { index } => ProjectCommandError {
            field: Some(format!("sources[{index}].fingerprint")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::EmptySourceId { index }
        | ProjectValidationError::DuplicateSourceId { index } => ProjectCommandError {
            field: Some(format!("sources[{index}].id")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::EmptySegmentId { index }
        | ProjectValidationError::DuplicateSegmentId { index } => ProjectCommandError {
            field: Some(format!("segments[{index}].id")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::EmptyClipId { index }
        | ProjectValidationError::DuplicateClipId { index } => ProjectCommandError {
            field: Some(format!("clips[{index}].id")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::UnknownClipSource { index, .. } => ProjectCommandError {
            field: Some(format!("clips[{index}].sourceId")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::UnknownSegmentClip { index, field, .. } => ProjectCommandError {
            field: Some(format!("segments[{index}].{field}")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::MissingSegmentStartPts { index, .. }
        | ProjectValidationError::SegmentCrossesUnknownEnd { index, .. } => ProjectCommandError {
            field: Some(format!("segments[{index}]")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Clip, Segment, Source, SourceFingerprint};
    use crate::time::{FrameCount, Pts, Rational, TickCount};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn serializes_project_and_error_command_contracts_in_camel_case() {
        let project = example_project();
        let project_value = serde_json::to_value(project).unwrap();
        assert_eq!(project_value["schemaVersion"], 1);
        assert!(project_value.get("renderSettings").is_none());
        assert_eq!(project_value["sources"][0]["relPath"], "clip.mp4");
        assert_eq!(project_value["segments"][0]["outPts"], "20");
        assert!(project_value.get("schema_version").is_none());

        let error =
            ProjectCommandError::with_schema(ProjectCommandErrorCode::FutureSchemaVersion, 2, 1);
        let error_value = serde_json::to_value(error).unwrap();
        assert_eq!(error_value["code"], "futureSchemaVersion");
        assert_eq!(error_value["foundSchemaVersion"], 2);
        assert_eq!(error_value["supportedSchemaVersion"], 1);
        assert!(error_value.get("detail").is_none());
        assert!(error_value.get("found_schema_version").is_none());
    }

    #[test]
    fn public_commands_save_and_load_a_project_atomically() {
        let directory = TestDirectory::new();
        let path = directory.path.join("round-trip.qcproj");
        fs::write(&path, b"old project contents").unwrap();
        let project = example_project();
        let canonical = fs::canonicalize(&path).unwrap();

        let saved = run(save_project(
            path.to_str().unwrap().to_owned(),
            project.clone(),
        ))
        .unwrap();
        assert_eq!(saved.path, canonical.to_str().unwrap());

        let loaded = run(load_project(path.to_str().unwrap().to_owned())).unwrap();
        assert_eq!(loaded.path, canonical.to_str().unwrap());
        // The save wrote the relative path itself: `/clips/clip.mp4` from the test directory.
        let mut expected = project;
        expected.sources[0].rel_path = loaded.project.sources[0].rel_path.clone();
        assert_eq!(loaded.project, expected);
        // `/clips/clip.mp4` has no drive, so it is not absolute on Windows and gets no relative
        // path there.
        if cfg!(unix) {
            assert!(loaded.project.sources[0]
                .rel_path
                .as_deref()
                .is_some_and(
                    |rel_path| rel_path.starts_with("../") && rel_path.ends_with("clips/clip.mp4")
                ));
        }
        assert_eq!(loaded.candidates, vec![vec!["/clips/clip.mp4".to_owned()]]);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));
        let entries = fs::read_dir(&directory.path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![std::ffi::OsString::from("round-trip.qcproj")]);
    }

    #[test]
    fn failed_public_save_preserves_the_existing_project() {
        let directory = TestDirectory::new();
        let path = directory.path.join("preserve.qcproj");
        fs::write(&path, b"old project contents").unwrap();
        let mut project = example_project();
        project.segments[0].out_pts = project.segments[0].in_pts;

        let error = run(save_project(path.to_str().unwrap().to_owned(), project)).unwrap_err();

        assert_eq!(error.code, ProjectCommandErrorCode::InvalidProject);
        assert_eq!(fs::read(&path).unwrap(), b"old project contents");
        assert_eq!(fs::read_dir(&directory.path).unwrap().count(), 1);

        let mut unsafe_project = example_project();
        unsafe_project.sources[0].size = JAVASCRIPT_MAX_SAFE_INTEGER + 1;
        let unsafe_error = run(save_project(
            path.to_str().unwrap().to_owned(),
            unsafe_project,
        ))
        .unwrap_err();
        assert_eq!(
            unsafe_error.code,
            ProjectCommandErrorCode::UnsafeProjectValue
        );
        assert_eq!(unsafe_error.field.as_deref(), Some("sources[0].size"));
        assert_eq!(unsafe_error.value.as_deref(), Some("9007199254740992"));
        assert_eq!(fs::read(&path).unwrap(), b"old project contents");
    }

    #[test]
    fn public_load_maps_malformed_future_and_legacy_projects() {
        let directory = TestDirectory::new();
        let path = directory.path.join("version.qcproj");

        fs::write(&path, b"{").unwrap();
        let malformed = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(malformed.code, ProjectCommandErrorCode::InvalidJson);
        assert_eq!(malformed.detail, None);

        let mut value = serde_json::to_value(example_project()).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let future = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(future.code, ProjectCommandErrorCode::FutureSchemaVersion);
        assert_eq!(future.found_schema_version, Some(2));
        assert_eq!(future.supported_schema_version, Some(1));

        value["schemaVersion"] = serde_json::json!(9_007_199_254_740_992_u64);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let unsafe_version = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(
            unsafe_version.code,
            ProjectCommandErrorCode::UnsafeProjectValue
        );
        assert_eq!(unsafe_version.field.as_deref(), Some("schemaVersion"));
        assert_eq!(unsafe_version.value.as_deref(), Some("9007199254740992"));
        assert_eq!(unsafe_version.found_schema_version, None);

        value["schemaVersion"] = serde_json::json!(0);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let legacy = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(legacy.code, ProjectCommandErrorCode::InvalidProject);
        assert_eq!(legacy.found_schema_version, None);
    }

    #[test]
    fn public_commands_reject_empty_missing_and_directory_paths() {
        let directory = TestDirectory::new();
        let missing = directory.path.join("missing.qcproj");

        for path in ["", "  ", "bad\0path"] {
            assert_eq!(
                run(load_project(path.to_owned())).unwrap_err().code,
                ProjectCommandErrorCode::InvalidPath
            );
            assert_eq!(
                run(save_project(path.to_owned(), example_project()))
                    .unwrap_err()
                    .code,
                ProjectCommandErrorCode::InvalidPath
            );
        }
        assert_eq!(
            run(load_project(missing.to_str().unwrap().to_owned()))
                .unwrap_err()
                .code,
            ProjectCommandErrorCode::PathNotFound
        );
        assert_eq!(
            run(load_project(directory.path.to_str().unwrap().to_owned()))
                .unwrap_err()
                .code,
            ProjectCommandErrorCode::PathNotFile
        );
        let folder = directory.path.join("folder.qcproj");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            run(save_project(
                folder.to_str().unwrap().to_owned(),
                example_project()
            ))
            .unwrap_err()
            .code,
            ProjectCommandErrorCode::PathNotFile
        );
    }

    #[test]
    fn the_save_refuses_a_name_that_does_not_end_in_the_project_extension() {
        let directory = TestDirectory::new();
        for name in ["cut.json", "cut", "cut.qcproj.bak", "cut.qcpro", "qcproj"] {
            let path = directory.path.join(name);
            let error = run(save_project(
                path.to_str().unwrap().to_owned(),
                example_project(),
            ))
            .unwrap_err();
            assert_eq!(error.code, ProjectCommandErrorCode::InvalidPath, "{name}");
            assert!(!path.exists(), "{name}");
        }
        // The test ignores the letter case.
        for name in ["cut.QCPROJ", "cut.QcProj", "片段.qcproj", ".qcproj"] {
            let path = directory.path.join(name);
            let saved = run(save_project(
                path.to_str().unwrap().to_owned(),
                example_project(),
            ))
            .unwrap();
            assert!(saved.path.ends_with(name), "{name}");
            assert!(path.is_file(), "{name}");
        }
        // The directory of the file is a directory, not a name with the extension.
        assert_eq!(
            run(save_project(
                directory
                    .path
                    .join("cut.qcproj")
                    .join("..")
                    .to_str()
                    .unwrap()
                    .to_owned(),
                example_project(),
            ))
            .unwrap_err()
            .code,
            ProjectCommandErrorCode::InvalidPath
        );
        // The test reads the text as the caller sent it: `Path` drops a final `.`, so these
        // would otherwise write `fresh.qcproj`. (`cut.qcproj` exists already on a file system that
        // ignores the letter case, from `cut.QCPROJ` above.)
        let target = directory.path.join("fresh.qcproj");
        let target_text = target.to_str().unwrap();
        let separator = std::path::MAIN_SEPARATOR;
        for text in [
            format!("{target_text}/."),
            format!("{target_text}{separator}."),
            format!("{target_text}/"),
            format!("{target_text} "),
        ] {
            assert_eq!(
                run(save_project(text.clone(), example_project()))
                    .unwrap_err()
                    .code,
                ProjectCommandErrorCode::InvalidPath,
                "{text}"
            );
            assert!(!target.exists(), "{text}");
        }
    }

    #[test]
    fn the_load_answers_the_relative_candidate_and_then_the_path_after_a_move() {
        let directory = TestDirectory::new();
        let root = fs::canonicalize(&directory.path).unwrap();
        let old = root.join("old");
        fs::create_dir_all(old.join("clips")).unwrap();
        let mut project = example_project();
        let old_clip = old.join("clips").join("a.mp4").to_str().unwrap().to_owned();
        project.sources[0].path = old_clip.clone();
        run(save_project(
            old.join("cut.qcproj").to_str().unwrap().to_owned(),
            project,
        ))
        .unwrap();
        // The folder of the project moves with its clips.
        let new = root.join("new");
        fs::rename(&old, &new).unwrap();

        let loaded = run(load_project(
            new.join("cut.qcproj").to_str().unwrap().to_owned(),
        ))
        .unwrap();
        assert_eq!(
            loaded.project.sources[0].rel_path.as_deref(),
            Some("clips/a.mp4")
        );
        assert_eq!(
            loaded.candidates,
            vec![vec![
                new.join("clips").join("a.mp4").to_str().unwrap().to_owned(),
                old_clip,
            ]]
        );
    }

    #[test]
    fn a_project_file_larger_than_the_limit_is_too_large() {
        let directory = TestDirectory::new();
        let path = directory.path.join("large.qcproj");
        // A sparse file: the load reads the limit and one byte more, and no further.
        fs::File::create(&path)
            .unwrap()
            .set_len(project::PROJECT_FILE_MAX_BYTES + 1)
            .unwrap();
        let error = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(error.code, ProjectCommandErrorCode::TooLarge);
        assert_eq!(
            serde_json::to_value(&error).unwrap()["code"],
            serde_json::json!("tooLarge")
        );
        assert_eq!(
            map_project_error(ProjectFileError::TooLarge { limit: 1 }, IoOperation::Write).code,
            ProjectCommandErrorCode::TooLarge
        );
    }

    #[test]
    fn the_load_answers_the_candidates_of_each_source_in_order() {
        let directory = TestDirectory::new();
        let root = fs::canonicalize(&directory.path).unwrap();
        let path = root.join("cut.qcproj");
        let mut project = example_project();
        let mut second = project.sources[0].clone();
        second.id = "s2".to_owned();
        second.path = root
            .join("media")
            .join("b.mp4")
            .to_str()
            .unwrap()
            .to_owned();
        project.sources.push(second);
        run(save_project(path.to_str().unwrap().to_owned(), project)).unwrap();

        let loaded = run(load_project(path.to_str().unwrap().to_owned())).unwrap();
        assert_eq!(
            loaded.project.sources[1].rel_path.as_deref(),
            Some("media/b.mp4")
        );
        let b = root
            .join("media")
            .join("b.mp4")
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            loaded.candidates,
            vec![vec!["/clips/clip.mp4".to_owned()], vec![b]]
        );
        let value = serde_json::to_value(&loaded).unwrap();
        assert!(value["candidates"].is_array());
        assert!(value["project"]["sources"].is_array());
        assert!(value["path"].is_string());
        assert_eq!(value.as_object().unwrap().len(), 3);
    }

    #[test]
    fn the_commands_carry_the_fingerprint_and_map_the_new_fields() {
        let directory = TestDirectory::new();
        let path = directory.path.join("fingerprint.qcproj");
        let mut project = example_project();
        project.sources[0].fingerprint = Some(SourceFingerprint {
            start: "0".to_owned(),
            fnv1a64: "00000000000000ff".to_owned(),
        });
        run(save_project(
            path.to_str().unwrap().to_owned(),
            project.clone(),
        ))
        .unwrap();
        let loaded = run(load_project(path.to_str().unwrap().to_owned())).unwrap();
        assert_eq!(
            loaded.project.sources[0].fingerprint,
            project.sources[0].fingerprint
        );

        // A start that is not smaller than the size of the source (100).
        project.sources[0].fingerprint = Some(SourceFingerprint {
            start: "100".to_owned(),
            fnv1a64: "00000000000000ff".to_owned(),
        });
        let error = run(save_project(path.to_str().unwrap().to_owned(), project)).unwrap_err();
        assert_eq!(error.code, ProjectCommandErrorCode::InvalidProject);
        assert_eq!(error.field.as_deref(), Some("sources[0].fingerprint"));

        // A relative path with a root, written by another program.
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["sources"][0]["relPath"] = serde_json::json!("/clips/clip.mp4");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let error = run(load_project(path.to_str().unwrap().to_owned())).unwrap_err();
        assert_eq!(error.code, ProjectCommandErrorCode::InvalidProject);
        assert_eq!(error.field.as_deref(), Some("sources[0].relPath"));
    }

    #[test]
    fn maps_io_and_validation_failures_without_generated_english_details() {
        for (kind, expected) in [
            (
                io::ErrorKind::NotFound,
                ProjectCommandErrorCode::PathNotFound,
            ),
            (
                io::ErrorKind::PermissionDenied,
                ProjectCommandErrorCode::PermissionDenied,
            ),
            (io::ErrorKind::Other, ProjectCommandErrorCode::ReadFailed),
        ] {
            let error = map_io_error(
                io::Error::new(kind, "generated diagnostic"),
                IoOperation::Read,
            );
            assert_eq!(error.code, expected);
            assert_eq!(error.detail, None);
        }

        let json = map_project_error(
            ProjectFileError::Json(serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err()),
            IoOperation::Read,
        );
        assert_eq!(json.code, ProjectCommandErrorCode::InvalidJson);
        assert_eq!(json.detail, None);

        let unsafe_value = map_validation_error(ProjectValidationError::UnsafeInteger {
            field: "sources[0].size".to_owned(),
            value: 9_007_199_254_740_992,
        });
        assert_eq!(
            unsafe_value.code,
            ProjectCommandErrorCode::UnsafeProjectValue
        );
        assert_eq!(unsafe_value.field.as_deref(), Some("sources[0].size"));
        assert_eq!(unsafe_value.value.as_deref(), Some("9007199254740992"));
        assert_eq!(unsafe_value.detail, None);

        let command = generated_error(ProjectCommandErrorCode::CommandExecutionFailed);
        assert_eq!(command.detail, None);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_only_raw_operating_system_io_diagnostics() {
        let error = map_io_error(io::Error::from_raw_os_error(13), IoOperation::Write);

        assert_eq!(error.code, ProjectCommandErrorCode::PermissionDenied);
        assert!(error.detail.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_unicode_paths_before_project_io() {
        use std::os::unix::ffi::OsStringExt;

        let path = PathBuf::from(std::ffi::OsString::from_vec(vec![b'n', 0xff]));
        assert_eq!(
            ensure_unicode_path(&path).unwrap_err().code,
            ProjectCommandErrorCode::PathNotUnicode
        );
    }

    fn run<Output>(future: impl std::future::Future<Output = Output>) -> Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn maps_the_clip_and_segment_validation_errors_to_fields() {
        let cases = [
            (
                ProjectValidationError::EmptyClipId { index: 1 },
                "clips[1].id",
            ),
            (
                ProjectValidationError::DuplicateClipId { index: 2 },
                "clips[2].id",
            ),
            (
                ProjectValidationError::UnknownClipSource {
                    index: 0,
                    source_id: "s9".to_owned(),
                },
                "clips[0].sourceId",
            ),
            (
                ProjectValidationError::UnknownSegmentClip {
                    index: 3,
                    field: "inClipId",
                    clip_id: "c9".to_owned(),
                },
                "segments[3].inClipId",
            ),
            (
                ProjectValidationError::MissingSegmentStartPts {
                    index: 4,
                    source_id: "s1".to_owned(),
                },
                "segments[4]",
            ),
            (
                ProjectValidationError::SegmentCrossesUnknownEnd {
                    index: 5,
                    clip_id: "c1".to_owned(),
                },
                "segments[5]",
            ),
            (
                ProjectValidationError::InvalidSegmentName { index: 6 },
                "segments[6].name",
            ),
            (
                ProjectValidationError::InvalidRelPath { index: 7 },
                "sources[7].relPath",
            ),
            (
                ProjectValidationError::InvalidFingerprint { index: 8 },
                "sources[8].fingerprint",
            ),
            (
                ProjectValidationError::InvalidSourcePath { index: 9 },
                "sources[9].path",
            ),
        ];
        for (error, field) in cases {
            let mapped = map_validation_error(error);
            assert_eq!(mapped.code, ProjectCommandErrorCode::InvalidProject);
            assert_eq!(mapped.field.as_deref(), Some(field));
        }
    }

    fn example_project() -> ProjectFile {
        ProjectFile {
            schema_version: 1,
            sources: vec![Source {
                id: "s1".to_owned(),
                path: "/clips/clip.mp4".to_owned(),
                rel_path: Some("clip.mp4".to_owned()),
                size: 100,
                mtime: 1_700_000_000,
                video_stream_index: 0,
                video_time_base: Rational::new(1, 90_000).unwrap(),
                video_start_pts: Some(Pts::new(0)),
                video_end_pts: Some(Pts::new(900_000)),
                video_duration_ticks: Some(TickCount::new(900_000).unwrap()),
                approximate_duration_seconds: Some(10.0),
                avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
                r_frame_rate: Some(Rational::new(30, 1).unwrap()),
                reported_frame_count: Some(FrameCount::new(300).unwrap()),
                audio_stream_index: None,
                fingerprint: None,
            }],
            clips: vec![Clip {
                id: "c1".to_owned(),
                source_id: "s1".to_owned(),
            }],
            segments: vec![Segment {
                id: "g1".to_owned(),
                in_clip_id: "c1".to_owned(),
                in_pts: Pts::new(10),
                out_clip_id: "c1".to_owned(),
                out_pts: Pts::new(20),
                name: None,
            }],
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-project-command-test-{}-{sequence}",
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
