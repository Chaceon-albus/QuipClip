//! Persistence for versioned QuipClip project files.

use crate::time::{FrameCount, Pts, Rational, TickCount};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

/// The project schema this build reads and writes.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// A project document stored in a `.qcproj` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFile {
    pub schema_version: u32,
    pub render_settings: RenderSettings,
    pub sources: Vec<Source>,
    pub segments: Vec<Segment>,
    pub active_source_id: String,
}

/// Output settings that do not define source edit positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderSettings {
    pub frame_rate: Rational,
    pub resolution: Resolution,
}

/// The output resolution in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub w: u32,
    pub h: u32,
}

/// Durable identity, location, revision, and source video timing metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub path: String,
    pub rel_path: String,
    pub size: u64,
    pub mtime: i64,
    pub video_stream_index: u32,
    pub video_time_base: Rational,
    pub video_start_pts: Option<Pts>,
    pub video_duration_ticks: Option<TickCount>,
    pub approximate_duration_seconds: Option<f64>,
    pub avg_frame_rate: Option<Rational>,
    pub r_frame_rate: Option<Rational>,
    pub reported_frame_count: Option<FrameCount>,
}

/// One half-open source PTS interval `[in_pts, out_pts)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Segment {
    pub id: String,
    pub source_id: String,
    pub in_pts: Pts,
    pub out_pts: Pts,
}

/// A failure to read, validate, or save a project document.
#[derive(Debug)]
pub enum ProjectFileError {
    Io(io::Error),
    Json(serde_json::Error),
    Validation(ProjectValidationError),
    FutureSchemaVersion { found: u64, supported: u32 },
}

/// A structurally valid project whose values violate project invariants.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectValidationError {
    SchemaVersion { found: u32, expected: u32 },
    NonPositiveTimebase { field: String },
    InvalidFrameRate { field: String },
    InvalidApproximateDuration { index: usize },
    UnsafeInteger { field: String, value: i128 },
    EmptySourceId { index: usize },
    DuplicateSourceId { index: usize },
    EmptySegmentId { index: usize },
    DuplicateSegmentId { index: usize },
    UnknownActiveSource { source_id: String },
    UnknownSegmentSource { index: usize, source_id: String },
    MissingSegmentStartPts { index: usize, source_id: String },
    InvalidSegmentRange { index: usize },
}

impl fmt::Display for ProjectValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SchemaVersion { found, expected } => write!(
                formatter,
                "schemaVersion must be {expected} when saving, but was {found}"
            ),
            Self::NonPositiveTimebase { field } => write!(formatter, "{field} must be positive"),
            Self::InvalidFrameRate { field } => write!(formatter, "{field} must be positive"),
            Self::InvalidApproximateDuration { index } => write!(
                formatter,
                "sources[{index}].approximateDurationSeconds must be finite and non-negative"
            ),
            Self::UnsafeInteger { field, value } => write!(
                formatter,
                "{field} value {value} is outside the JavaScript safe integer range"
            ),
            Self::EmptySourceId { index } => write!(formatter, "sources[{index}].id is empty"),
            Self::DuplicateSourceId { index } => {
                write!(formatter, "sources[{index}].id is duplicated")
            }
            Self::EmptySegmentId { index } => write!(formatter, "segments[{index}].id is empty"),
            Self::DuplicateSegmentId { index } => {
                write!(formatter, "segments[{index}].id is duplicated")
            }
            Self::UnknownActiveSource { source_id } => {
                write!(
                    formatter,
                    "activeSourceId {source_id:?} does not name a source"
                )
            }
            Self::UnknownSegmentSource { index, source_id } => write!(
                formatter,
                "segments[{index}].sourceId {source_id:?} does not name a source"
            ),
            Self::MissingSegmentStartPts { index, source_id } => write!(
                formatter,
                "segments[{index}] references source {source_id:?} without videoStartPts"
            ),
            Self::InvalidSegmentRange { index } => write!(
                formatter,
                "segments[{index}] must have an exclusive outPts greater than inPts"
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
        }
    }
}

impl Error for ProjectFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::FutureSchemaVersion { .. } => None,
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
    let project: ProjectFile = serde_json::from_slice(&bytes)?;
    validate_project(&project)?;
    Ok(project)
}

/// Save a project as readable UTF-8 JSON and atomically replace the destination.
pub fn save(path: impl AsRef<Path>, project: &ProjectFile) -> Result<(), ProjectFileError> {
    let path = path.as_ref();
    validate_project(project)?;
    let json = crate::fsutil::to_pretty_json_line(project)?;
    crate::fsutil::write_bytes_atomically(path, &json)?;
    Ok(())
}

fn validate_project(project: &ProjectFile) -> Result<(), ProjectValidationError> {
    if project.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(ProjectValidationError::SchemaVersion {
            found: project.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }
    validate_rational_numbers(
        "renderSettings.frameRate",
        project.render_settings.frame_rate,
    )?;
    if project.render_settings.frame_rate.num() <= 0 {
        return Err(ProjectValidationError::InvalidFrameRate {
            field: "renderSettings.frameRate".to_owned(),
        });
    }

    let mut source_ids = HashSet::new();
    for (index, source) in project.sources.iter().enumerate() {
        if source.id.is_empty() {
            return Err(ProjectValidationError::EmptySourceId { index });
        }
        if !source_ids.insert(source.id.as_str()) {
            return Err(ProjectValidationError::DuplicateSourceId { index });
        }
        validate_unsigned_integer(&format!("sources[{index}].size"), source.size)?;
        validate_signed_integer(&format!("sources[{index}].mtime"), source.mtime)?;
        validate_positive_rational(
            &format!("sources[{index}].videoTimeBase"),
            source.video_time_base,
        )?;
        for (name, rate) in [
            ("avgFrameRate", source.avg_frame_rate),
            ("rFrameRate", source.r_frame_rate),
        ] {
            if let Some(rate) = rate {
                let field = format!("sources[{index}].{name}");
                validate_rational_numbers(&field, rate)?;
                if rate.num() <= 0 {
                    return Err(ProjectValidationError::InvalidFrameRate {
                        field: format!("sources[{index}].{name}"),
                    });
                }
            }
        }
        if source
            .approximate_duration_seconds
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(ProjectValidationError::InvalidApproximateDuration { index });
        }
    }
    if !source_ids.contains(project.active_source_id.as_str()) {
        return Err(ProjectValidationError::UnknownActiveSource {
            source_id: project.active_source_id.clone(),
        });
    }

    let mut segment_ids = HashSet::new();
    for (index, segment) in project.segments.iter().enumerate() {
        if segment.id.is_empty() {
            return Err(ProjectValidationError::EmptySegmentId { index });
        }
        if !segment_ids.insert(segment.id.as_str()) {
            return Err(ProjectValidationError::DuplicateSegmentId { index });
        }
        let source = project
            .sources
            .iter()
            .find(|source| source.id == segment.source_id)
            .ok_or_else(|| ProjectValidationError::UnknownSegmentSource {
                index,
                source_id: segment.source_id.clone(),
            })?;
        if source.video_start_pts.is_none() {
            return Err(ProjectValidationError::MissingSegmentStartPts {
                index,
                source_id: segment.source_id.clone(),
            });
        }
        if segment.out_pts <= segment.in_pts {
            return Err(ProjectValidationError::InvalidSegmentRange { index });
        }
    }
    Ok(())
}

fn validate_positive_rational(field: &str, value: Rational) -> Result<(), ProjectValidationError> {
    validate_rational_numbers(field, value)?;
    if value.num() <= 0 {
        return Err(ProjectValidationError::NonPositiveTimebase {
            field: field.to_owned(),
        });
    }
    Ok(())
}

fn validate_rational_numbers(field: &str, value: Rational) -> Result<(), ProjectValidationError> {
    validate_signed_integer(&format!("{field}.n"), value.num())?;
    validate_signed_integer(&format!("{field}.d"), value.den())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);
    const EXAMPLE: &str = r#"{
  "schemaVersion": 1,
  "renderSettings": {"frameRate":{"n":30000,"d":1001},"resolution":{"w":1920,"h":1080}},
  "sources": [{
    "id":"s1","path":"/clips/a.mp4","relPath":"a.mp4","size":1234,"mtime":1700000000,
    "videoStreamIndex":0,"videoTimeBase":{"n":1,"d":90000},"videoStartPts":"-1800",
    "videoDurationTicks":"32370000","approximateDurationSeconds":359.666667,
    "avgFrameRate":{"n":30000,"d":1001},"rFrameRate":{"n":30000,"d":1001},"reportedFrameCount":null
  }],
  "segments":[{"id":"g1","sourceId":"s1","inPts":"9000","outPts":"27000"}],
  "activeSourceId":"s1"
}"#;

    #[test]
    fn loads_and_round_trips_source_pts_schema_atomically() {
        let directory = TestDirectory::new();
        let path = directory.path.join("example.qcproj");
        fs::write(&path, EXAMPLE).unwrap();
        let project = load(&path).unwrap();
        assert_eq!(project.sources[0].video_start_pts, Some(Pts::new(-1800)));
        assert_eq!(project.segments[0].out_pts, Pts::new(27000));
        save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), project);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));
    }

    #[test]
    fn old_frame_grid_shape_is_a_normal_json_failure() {
        let directory = TestDirectory::new();
        let path = directory.path.join("old.qcproj");
        fs::write(&path, r#"{"schemaVersion":1,"timebase":{"n":30,"d":1},"resolution":{"w":1,"h":1},"sources":[],"segments":[],"activeSourceId":"s1"}"#).unwrap();
        assert!(matches!(load(&path), Err(ProjectFileError::Json(_))));
    }

    #[test]
    fn rejects_unknown_runtime_fields() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["sources"][0]["proxy"] = serde_json::json!({"path":"cache.mov"});
        assert_json_error(value);
    }

    #[test]
    fn source_without_start_pts_is_valid_until_referenced() {
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].video_start_pts = None;
        project.segments.clear();
        assert!(validate_project(&project).is_ok());
        project.segments.push(Segment {
            id: "g1".to_owned(),
            source_id: "s1".to_owned(),
            in_pts: Pts::new(0),
            out_pts: Pts::new(1),
        });
        assert!(matches!(
            validate_project(&project),
            Err(ProjectValidationError::MissingSegmentStartPts { .. })
        ));
    }

    #[test]
    fn validates_ids_references_time_bases_and_half_open_ranges() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        let mut changed = project.clone();
        changed.active_source_id = "missing".to_owned();
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::UnknownActiveSource { .. })
        ));
        changed = project.clone();
        changed.sources.push(changed.sources[0].clone());
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::DuplicateSourceId { .. })
        ));
        changed = project.clone();
        changed.segments[0].out_pts = changed.segments[0].in_pts;
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::InvalidSegmentRange { .. })
        ));
        changed = project;
        changed.sources[0].video_time_base = Rational::new(-1, 90000).unwrap();
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::NonPositiveTimebase { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_segment_ids_and_unknown_segment_sources() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();

        let mut duplicate = project.clone();
        duplicate.segments.push(Segment {
            id: duplicate.segments[0].id.clone(),
            source_id: "s1".to_owned(),
            in_pts: Pts::new(30_000),
            out_pts: Pts::new(40_000),
        });
        assert!(matches!(
            validate_project(&duplicate),
            Err(ProjectValidationError::DuplicateSegmentId { index: 1 })
        ));

        let mut unknown_source = project;
        unknown_source.segments[0].source_id = "missing".to_owned();
        assert!(matches!(
            validate_project(&unknown_source),
            Err(ProjectValidationError::UnknownSegmentSource {
                index: 0,
                source_id
            }) if source_id == "missing"
        ));
    }

    #[test]
    fn nullable_durations_are_not_segment_prerequisites() {
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].video_duration_ticks = None;
        project.sources[0].approximate_duration_seconds = None;
        assert!(validate_project(&project).is_ok());
    }

    #[test]
    fn rejects_invalid_approximate_duration_and_unsafe_metadata() {
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].approximate_duration_seconds = Some(f64::INFINITY);
        assert!(matches!(
            validate_project(&project),
            Err(ProjectValidationError::InvalidApproximateDuration { .. })
        ));
        project = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].size = JAVASCRIPT_MAX_SAFE_INTEGER as u64 + 1;
        assert!(matches!(
            validate_project(&project),
            Err(ProjectValidationError::UnsafeInteger { .. })
        ));
    }

    #[test]
    fn future_schema_is_typed_but_lower_version_uses_validation() {
        let directory = TestDirectory::new();
        let path = directory.path.join("version.qcproj");
        fs::write(
            &path,
            EXAMPLE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2"),
        )
        .unwrap();
        assert!(matches!(
            load(&path),
            Err(ProjectFileError::FutureSchemaVersion { found: 2, .. })
        ));
        fs::write(
            &path,
            EXAMPLE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 0"),
        )
        .unwrap();
        assert!(matches!(
            load(&path),
            Err(ProjectFileError::Validation(
                ProjectValidationError::SchemaVersion {
                    found: 0,
                    expected: 1
                }
            ))
        ));
    }

    fn assert_json_error(value: serde_json::Value) {
        let directory = TestDirectory::new();
        let path = directory.path.join("invalid.qcproj");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(load(&path), Err(ProjectFileError::Json(_))));
    }

    struct TestDirectory {
        path: PathBuf,
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
