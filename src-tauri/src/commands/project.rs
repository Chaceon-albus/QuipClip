//! Tauri commands for loading and saving project files.

use crate::project::{self, ProjectFile, ProjectFileError, ProjectValidationError};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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

/// Load one validated project from an explicit file path.
#[tauri::command]
pub async fn load_project(path: String) -> Result<ProjectFile, ProjectCommandError> {
    tauri::async_runtime::spawn_blocking(move || load_project_with(&path))
        .await
        .map_err(|_| generated_error(ProjectCommandErrorCode::CommandExecutionFailed))?
}

fn load_project_with(path: &str) -> Result<ProjectFile, ProjectCommandError> {
    let path = validate_load_path(path)?;
    project::load(path).map_err(|error| map_project_error(error, IoOperation::Read))
}

/// Save one validated project to an explicit file path.
#[tauri::command]
pub async fn save_project(path: String, project: ProjectFile) -> Result<(), ProjectCommandError> {
    tauri::async_runtime::spawn_blocking(move || save_project_with(&path, &project))
        .await
        .map_err(|_| generated_error(ProjectCommandErrorCode::CommandExecutionFailed))?
}

fn save_project_with(path: &str, project: &ProjectFile) -> Result<(), ProjectCommandError> {
    let path = validate_save_path(path)?;
    project::save(path, project).map_err(|error| map_project_error(error, IoOperation::Write))
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
        ProjectValidationError::UnknownActiveSource { .. } => ProjectCommandError {
            field: Some("activeSourceId".to_owned()),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
        ProjectValidationError::UnknownSegmentSource { index, .. }
        | ProjectValidationError::MissingSegmentStartPts { index, .. } => ProjectCommandError {
            field: Some(format!("segments[{index}].sourceId")),
            ..ProjectCommandError::new(ProjectCommandErrorCode::InvalidProject)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{RenderSettings, Resolution, Segment, Source};
    use crate::time::{FrameCount, Pts, Rational, TickCount};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn serializes_project_and_error_command_contracts_in_camel_case() {
        let project = example_project();
        let project_value = serde_json::to_value(project).unwrap();
        assert_eq!(project_value["schemaVersion"], 1);
        assert_eq!(
            project_value["renderSettings"]["frameRate"],
            serde_json::json!({ "n": 30, "d": 1 })
        );
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

        run(save_project(
            path.to_str().unwrap().to_owned(),
            project.clone(),
        ))
        .unwrap();

        assert_eq!(
            run(load_project(path.to_str().unwrap().to_owned())).unwrap(),
            project
        );
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
        assert_eq!(
            run(save_project(
                directory.path.to_str().unwrap().to_owned(),
                example_project()
            ))
            .unwrap_err()
            .code,
            ProjectCommandErrorCode::PathNotFile
        );
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

    fn example_project() -> ProjectFile {
        ProjectFile {
            schema_version: 1,
            render_settings: RenderSettings {
                frame_rate: Rational::new(30, 1).unwrap(),
                resolution: Resolution { w: 1920, h: 1080 },
            },
            sources: vec![Source {
                id: "s1".to_owned(),
                path: "/clips/clip.mp4".to_owned(),
                rel_path: "clip.mp4".to_owned(),
                size: 100,
                mtime: 1_700_000_000,
                video_stream_index: 0,
                video_time_base: Rational::new(1, 90_000).unwrap(),
                video_start_pts: Some(Pts::new(0)),
                video_duration_ticks: Some(TickCount::new(900_000).unwrap()),
                approximate_duration_seconds: Some(10.0),
                avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
                r_frame_rate: Some(Rational::new(30, 1).unwrap()),
                reported_frame_count: Some(FrameCount::new(300).unwrap()),
            }],
            segments: vec![Segment {
                id: "g1".to_owned(),
                source_id: "s1".to_owned(),
                in_pts: Pts::new(10),
                out_pts: Pts::new(20),
            }],
            active_source_id: "s1".to_owned(),
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
