//! Persistence for versioned QuipClip project files.

use crate::time::Rational;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// The newest project schema this build can read and write.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A project document stored in a `.qcproj` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFile {
    pub schema_version: u32,
    pub timebase: Rational,
    pub resolution: Resolution,
    pub sources: Vec<Source>,
    pub segments: Vec<Segment>,
    pub active_source_id: String,
}

/// The output resolution in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub w: u32,
    pub h: u32,
}

/// A source identity and its portable and absolute locations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub path: String,
    pub rel_path: String,
    pub size: u64,
    pub mtime: i64,
    pub timebase: Rational,
    pub frame_count: i64,
}

/// One source-time interval. The out frame is exclusive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Segment {
    pub id: String,
    pub source_id: String,
    pub in_frame: i64,
    pub out_frame: i64,
}

/// A failure to read, validate, migrate, or save a project document.
#[derive(Debug)]
pub enum ProjectFileError {
    Io(io::Error),
    Json(serde_json::Error),
    Validation(ProjectValidationError),
    FutureSchemaVersion { found: u64, supported: u32 },
    UnsupportedLegacySchemaVersion { found: u32 },
}

/// A project value that cannot safely cross the Rust and TypeScript boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectValidationError {
    SchemaVersion { found: u32, expected: u32 },
    NonPositiveTimebase { field: String },
    UnsafeInteger { field: String, value: i128 },
    NegativeFrameValue { field: String, value: i64 },
    InvalidSegmentRange { index: usize },
}

impl fmt::Display for ProjectValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SchemaVersion { found, expected } => write!(
                formatter,
                "schemaVersion must be {expected} when saving, but was {found}"
            ),
            Self::NonPositiveTimebase { field } => {
                write!(formatter, "{field} must be a positive timebase")
            }
            Self::UnsafeInteger { field, value } => write!(
                formatter,
                "{field} value {value} is outside the JavaScript safe integer range"
            ),
            Self::NegativeFrameValue { field, value } => {
                write!(
                    formatter,
                    "{field} frame value must be nonnegative, but was {value}"
                )
            }
            Self::InvalidSegmentRange { index } => write!(
                formatter,
                "segments[{index}] must have an exclusive outFrame greater than inFrame"
            ),
        }
    }
}

impl Error for ProjectValidationError {}

impl fmt::Display for ProjectFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "project file I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "project JSON is invalid: {error}"),
            Self::Validation(error) => write!(formatter, "project values are invalid: {error}"),
            Self::FutureSchemaVersion { found, supported } => write!(
                formatter,
                "project schema version {found} is newer than supported version {supported}"
            ),
            Self::UnsupportedLegacySchemaVersion { found } => {
                write!(
                    formatter,
                    "project schema version {found} cannot be migrated"
                )
            }
        }
    }
}

impl Error for ProjectFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::FutureSchemaVersion { .. } | Self::UnsupportedLegacySchemaVersion { .. } => None,
        }
    }
}

impl From<io::Error> for ProjectFileError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ProjectFileError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<ProjectValidationError> for ProjectFileError {
    fn from(error: ProjectValidationError) -> Self {
        Self::Validation(error)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaEnvelope {
    schema_version: u64,
}

/// Load and validate a project document from disk.
pub fn load(path: impl AsRef<Path>) -> Result<ProjectFile, ProjectFileError> {
    let bytes = fs::read(path)?;
    let envelope: SchemaEnvelope = serde_json::from_slice(&bytes)?;

    if envelope.schema_version > u64::from(CURRENT_SCHEMA_VERSION) {
        return Err(ProjectFileError::FutureSchemaVersion {
            found: envelope.schema_version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    let project = if envelope.schema_version < u64::from(CURRENT_SCHEMA_VERSION) {
        migrate(&bytes, envelope.schema_version as u32)?
    } else {
        serde_json::from_slice(&bytes)?
    };
    validate_project(&project)?;
    Ok(project)
}

/// Save a project as readable UTF-8 JSON and atomically replace the destination.
pub fn save(path: impl AsRef<Path>, project: &ProjectFile) -> Result<(), ProjectFileError> {
    let path = path.as_ref();
    validate_project(project)?;
    let mut json = serde_json::to_vec_pretty(project)?;
    json.push(b'\n');

    let (temporary_path, mut temporary_file) = create_temporary_file(path)?;
    let mut cleanup = TemporaryFileCleanup::new(temporary_path);
    let write_result = temporary_file
        .write_all(&json)
        .and_then(|()| temporary_file.sync_all());
    drop(temporary_file);
    write_result?;
    replace_file(cleanup.path(), path)?;
    cleanup.disarm();
    Ok(())
}

fn validate_project(project: &ProjectFile) -> Result<(), ProjectValidationError> {
    if project.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(ProjectValidationError::SchemaVersion {
            found: project.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }

    validate_timebase("timebase", project.timebase)?;
    for (index, source) in project.sources.iter().enumerate() {
        validate_unsigned_integer(&format!("sources[{index}].size"), source.size)?;
        validate_signed_integer(&format!("sources[{index}].mtime"), source.mtime)?;
        validate_frame_value(&format!("sources[{index}].frameCount"), source.frame_count)?;
        validate_timebase(&format!("sources[{index}].timebase"), source.timebase)?;
    }
    for (index, segment) in project.segments.iter().enumerate() {
        validate_frame_value(&format!("segments[{index}].inFrame"), segment.in_frame)?;
        validate_frame_value(&format!("segments[{index}].outFrame"), segment.out_frame)?;
        if segment.out_frame <= segment.in_frame {
            return Err(ProjectValidationError::InvalidSegmentRange { index });
        }
    }
    Ok(())
}

fn validate_timebase(field: &str, value: Rational) -> Result<(), ProjectValidationError> {
    validate_signed_integer(&format!("{field}.n"), value.num())?;
    validate_signed_integer(&format!("{field}.d"), value.den())?;
    if value.num() <= 0 {
        return Err(ProjectValidationError::NonPositiveTimebase {
            field: field.to_owned(),
        });
    }
    Ok(())
}

fn validate_frame_value(field: &str, value: i64) -> Result<(), ProjectValidationError> {
    validate_signed_integer(field, value)?;
    if value < 0 {
        return Err(ProjectValidationError::NegativeFrameValue {
            field: field.to_owned(),
            value,
        });
    }
    Ok(())
}

fn validate_signed_integer(field: &str, value: i64) -> Result<(), ProjectValidationError> {
    if !(-JAVASCRIPT_MAX_SAFE_INTEGER..=JAVASCRIPT_MAX_SAFE_INTEGER).contains(&value) {
        return Err(ProjectValidationError::UnsafeInteger {
            field: field.to_owned(),
            value: i128::from(value),
        });
    }
    Ok(())
}

fn validate_unsigned_integer(field: &str, value: u64) -> Result<(), ProjectValidationError> {
    if value > JAVASCRIPT_MAX_SAFE_INTEGER as u64 {
        return Err(ProjectValidationError::UnsafeInteger {
            field: field.to_owned(),
            value: i128::from(value),
        });
    }
    Ok(())
}

fn migrate(bytes: &[u8], schema_version: u32) -> Result<ProjectFile, ProjectFileError> {
    let _ = bytes;
    Err(ProjectFileError::UnsupportedLegacySchemaVersion {
        found: schema_version,
    })
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    let directory = parent_directory(destination);
    File::open(directory)?.sync_all()
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
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

#[cfg(windows)]
fn absolute_path_without_following_file(path: &Path) -> io::Result<PathBuf> {
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing project file name"))?;
    Ok(parent_directory(path).canonicalize()?.join(file_name))
}

#[cfg(not(any(unix, windows)))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn create_temporary_file(path: &Path) -> io::Result<(PathBuf, File)> {
    let directory = parent_directory(path);
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing project file name"))?;

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
        "could not create a unique temporary project file",
    ))
}

fn parent_directory(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        Some(_) | None => Path::new("."),
    }
}

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

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    const EXAMPLE: &str = r#"{
  "schemaVersion": 1,
  "timebase": { "n": 30000, "d": 1001 },
  "resolution": { "w": 1920, "h": 1080 },
  "sources": [
    {
      "id": "s1",
      "path": "/Users/x/clips/a.mp4",
      "relPath": "clips/a.mp4",
      "size": 12345678,
      "mtime": 1787073674,
      "timebase": { "n": 30000, "d": 1001 },
      "frameCount": 10790
    }
  ],
  "segments": [{ "id": "g1", "sourceId": "s1", "inFrame": 120, "outFrame": 360 }],
  "activeSourceId": "s1"
}"#;

    #[test]
    fn loads_the_schema_version_one_example() {
        let directory = TestDirectory::new();
        let path = directory.path.join("example.qcproj");
        fs::write(&path, EXAMPLE).unwrap();

        let project = load(&path).expect("example should load");

        assert_eq!(project.schema_version, 1);
        assert_eq!(project.timebase, Rational::new(30000, 1001).unwrap());
        assert_eq!(project.resolution, Resolution { w: 1920, h: 1080 });
        assert_eq!(project.sources[0].rel_path, "clips/a.mp4");
        assert_eq!(project.segments[0].out_frame, 360);
        assert_eq!(project.active_source_id, "s1");
    }

    #[test]
    fn public_load_normalizes_rationals_and_rejects_a_zero_denominator() {
        let directory = TestDirectory::new();
        let normalized_path = directory.path.join("normalized.qcproj");
        let normalized = EXAMPLE.replace(
            "\"timebase\": { \"n\": 30000, \"d\": 1001 }",
            "\"timebase\": { \"n\": -60000, \"d\": -2002 }",
        );
        fs::write(&normalized_path, normalized).unwrap();
        let project = load(&normalized_path).expect("equivalent rational should load");
        assert_eq!(project.timebase, Rational::new(30000, 1001).unwrap());
        assert_eq!(
            project.sources[0].timebase,
            Rational::new(30000, 1001).unwrap()
        );

        let invalid_path = directory.path.join("invalid.qcproj");
        let invalid = EXAMPLE.replacen("\"d\": 1001", "\"d\": 0", 1);
        fs::write(&invalid_path, invalid).unwrap();
        assert!(matches!(
            load(&invalid_path),
            Err(ProjectFileError::Json(_))
        ));
    }

    #[test]
    fn rejects_a_future_schema_version_with_a_typed_error() {
        let directory = TestDirectory::new();
        let path = directory.path.join("future.qcproj");
        fs::write(
            &path,
            EXAMPLE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2"),
        )
        .unwrap();

        let error = load(&path).unwrap_err();
        assert!(matches!(
            error,
            ProjectFileError::FutureSchemaVersion {
                found: 2,
                supported: CURRENT_SCHEMA_VERSION
            }
        ));
    }

    #[test]
    fn rejects_wide_future_schema_versions_with_the_typed_error() {
        let directory = TestDirectory::new();
        let path = directory.path.join("wide-future.qcproj");

        for version in [u64::from(u32::MAX) + 1, JAVASCRIPT_MAX_SAFE_INTEGER as u64] {
            fs::write(
                &path,
                EXAMPLE.replace(
                    "\"schemaVersion\": 1",
                    &format!("\"schemaVersion\": {version}"),
                ),
            )
            .unwrap();
            assert!(matches!(
                load(&path),
                Err(ProjectFileError::FutureSchemaVersion {
                    found,
                    supported: CURRENT_SCHEMA_VERSION
                }) if found == version
            ));
        }
    }

    #[test]
    fn routes_a_lower_schema_version_to_the_migration_seam() {
        let directory = TestDirectory::new();
        let path = directory.path.join("legacy.qcproj");
        fs::write(
            &path,
            EXAMPLE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 0"),
        )
        .unwrap();

        assert!(matches!(
            load(&path),
            Err(ProjectFileError::UnsupportedLegacySchemaVersion { found: 0 })
        ));
    }

    #[test]
    fn save_rejects_lower_and_higher_schema_versions() {
        let directory = TestDirectory::new();
        let path = directory.path.join("schema.qcproj");
        let mut project = example_project();

        for version in [0, CURRENT_SCHEMA_VERSION + 1] {
            project.schema_version = version;
            assert!(matches!(
                save(&path, &project),
                Err(ProjectFileError::Validation(
                    ProjectValidationError::SchemaVersion {
                        found,
                        expected: CURRENT_SCHEMA_VERSION
                    }
                )) if found == version
            ));
        }
        assert!(!path.exists());
    }

    #[test]
    fn save_overwrites_atomically_ends_with_a_newline_and_round_trips() {
        let directory = TestDirectory::new();
        let path = directory.path.join("round-trip.qcproj");
        fs::write(&path, b"old project contents").unwrap();
        let project = example_project();

        save(&path, &project).unwrap();

        let bytes = fs::read(&path).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert_eq!(load(&path).unwrap(), project);
    }

    #[test]
    fn saves_to_a_bare_relative_file_name() {
        let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = PathBuf::from(format!(
            ".quipclip-bare-project-{}-{sequence}.qcproj",
            std::process::id()
        ));
        let _cleanup = TestFileCleanup(path.clone());
        let project = example_project();
        fs::write(&path, b"old project contents").unwrap();

        save(&path, &project).unwrap();

        assert_eq!(load(&path).unwrap(), project);
    }

    #[test]
    fn accepts_javascript_safe_integer_boundaries_through_save_and_load() {
        let directory = TestDirectory::new();
        let path = directory.path.join("boundaries.qcproj");
        let mut project = example_project();
        project.timebase = Rational::new(JAVASCRIPT_MAX_SAFE_INTEGER, 1).unwrap();
        project.sources[0].size = JAVASCRIPT_MAX_SAFE_INTEGER as u64;
        project.sources[0].mtime = -JAVASCRIPT_MAX_SAFE_INTEGER;
        project.sources[0].frame_count = JAVASCRIPT_MAX_SAFE_INTEGER;
        project.sources[0].timebase = Rational::new(1, JAVASCRIPT_MAX_SAFE_INTEGER).unwrap();
        project.segments[0].in_frame = JAVASCRIPT_MAX_SAFE_INTEGER - 1;
        project.segments[0].out_frame = JAVASCRIPT_MAX_SAFE_INTEGER;

        save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), project);
    }

    #[test]
    fn public_load_rejects_unsafe_or_invalid_integer_values() {
        assert_invalid_json_value(
            &["sources", "0", "size"],
            (9_007_199_254_740_992_u64).into(),
        );
        assert_invalid_json_value(&["sources", "0", "mtime"], 9_007_199_254_740_992_i64.into());
        assert_invalid_json_value(
            &["sources", "0", "frameCount"],
            9_007_199_254_740_992_i64.into(),
        );
        assert_invalid_json_value(&["sources", "0", "frameCount"], (-1).into());
        assert_invalid_json_value(&["segments", "0", "inFrame"], (-1).into());
        assert_invalid_json_value(
            &["segments", "0", "outFrame"],
            9_007_199_254_740_992_i64.into(),
        );
        assert_invalid_json_value(&["segments", "0", "outFrame"], 120.into());
        assert_invalid_json_value(&["timebase", "n"], 9_007_199_254_740_992_i64.into());
        assert_invalid_json_value(
            &["sources", "0", "timebase", "d"],
            9_007_199_254_740_997_i64.into(),
        );
    }

    #[test]
    fn public_load_and_save_reject_nonpositive_timebases() {
        let directory = TestDirectory::new();
        let path = directory.path.join("nonpositive.qcproj");
        let mut project = example_project();
        project.timebase = Rational::new(0, 1).unwrap();
        assert!(matches!(
            save(&path, &project),
            Err(ProjectFileError::Validation(
                ProjectValidationError::NonPositiveTimebase { .. }
            ))
        ));

        project = example_project();
        project.sources[0].timebase = Rational::new(-1, 1).unwrap();
        assert!(matches!(
            save(&path, &project),
            Err(ProjectFileError::Validation(
                ProjectValidationError::NonPositiveTimebase { .. }
            ))
        ));

        assert_invalid_json_value(&["timebase", "n"], 0.into());
        assert_invalid_json_value(&["sources", "0", "timebase", "n"], (-30000).into());
    }

    #[test]
    fn public_save_rejects_unsafe_and_invalid_frame_values() {
        let directory = TestDirectory::new();
        let path = directory.path.join("invalid-save.qcproj");
        let mut project = example_project();
        project.sources[0].size = JAVASCRIPT_MAX_SAFE_INTEGER as u64 + 1;
        assert!(matches!(
            save(&path, &project),
            Err(ProjectFileError::Validation(
                ProjectValidationError::UnsafeInteger { .. }
            ))
        ));

        project = example_project();
        project.segments[0].in_frame = -1;
        assert!(matches!(
            save(&path, &project),
            Err(ProjectFileError::Validation(
                ProjectValidationError::NegativeFrameValue { .. }
            ))
        ));

        project = example_project();
        project.timebase = Rational::new(JAVASCRIPT_MAX_SAFE_INTEGER + 1, 1).unwrap();
        assert!(matches!(
            save(&path, &project),
            Err(ProjectFileError::Validation(
                ProjectValidationError::UnsafeInteger { .. }
            ))
        ));
    }

    #[test]
    fn rejects_unknown_runtime_and_proxy_fields() {
        let mut root_proxy: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        root_proxy["proxy"] = serde_json::json!({ "path": "cache.mov" });
        assert_load_json_error(root_proxy);

        let mut source_proxy: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        source_proxy["sources"][0]["proxyPath"] = serde_json::json!("cache.mov");
        assert_load_json_error(source_proxy);
    }

    #[test]
    fn requires_rel_path_in_the_version_one_contract() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["sources"][0]
            .as_object_mut()
            .unwrap()
            .remove("relPath");
        assert_load_json_error(value);
    }

    fn example_project() -> ProjectFile {
        serde_json::from_str(EXAMPLE).unwrap()
    }

    fn assert_invalid_json_value(path: &[&str], replacement: serde_json::Value) {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        let mut target = &mut value;
        for component in path {
            target = if let Ok(index) = component.parse::<usize>() {
                &mut target[index]
            } else {
                &mut target[*component]
            };
        }
        *target = replacement;

        let directory = TestDirectory::new();
        let project_path = directory.path.join("invalid.qcproj");
        fs::write(&project_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&project_path),
            Err(ProjectFileError::Validation(_))
        ));
    }

    fn assert_load_json_error(value: serde_json::Value) {
        let directory = TestDirectory::new();
        let path = directory.path.join("unknown-field.qcproj");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(load(&path), Err(ProjectFileError::Json(_))));
    }

    struct TestDirectory {
        path: PathBuf,
    }

    struct TestFileCleanup(PathBuf);

    impl Drop for TestFileCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-project-test-{}-{sequence}",
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
