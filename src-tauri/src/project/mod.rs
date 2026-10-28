//! Persistence for versioned QuipClip project files.

use crate::time::{FrameCount, Pts, Rational, TickCount};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// The sequence: each clip places one source, and the array order is the sequence order
    /// (ADR 052).
    pub clips: Vec<Clip>,
    /// The segments in export order (ADR 007). Each boundary names a clip (ADR 052).
    pub segments: Vec<Segment>,
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
    /// The PTS that follows the last presented frame, the end boundary of the clip range, or
    /// `None` when the probe could not read it (ADR 052).
    pub video_end_pts: Option<Pts>,
    pub video_duration_ticks: Option<TickCount>,
    pub approximate_duration_seconds: Option<f64>,
    pub avg_frame_rate: Option<Rational>,
    pub r_frame_rate: Option<Rational>,
    pub reported_frame_count: Option<FrameCount>,
}

/// One placement of a source on the sequence. It stores no sequence time (ADR 052).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clip {
    pub id: String,
    pub source_id: String,
}

/// One half-open interval on the sequence, from `in_pts` on the In clip to `out_pts` on the Out
/// clip. Each PTS is in the video time base of its own clip's source (ADR 002, ADR 052).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Segment {
    pub id: String,
    pub in_clip_id: String,
    pub in_pts: Pts,
    pub out_clip_id: String,
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
    SchemaVersion {
        found: u32,
        expected: u32,
    },
    NonPositiveTimebase {
        field: String,
    },
    InvalidFrameRate {
        field: String,
    },
    InvalidApproximateDuration {
        index: usize,
    },
    UnsafeInteger {
        field: String,
        value: i128,
    },
    EmptySourceId {
        index: usize,
    },
    DuplicateSourceId {
        index: usize,
    },
    EmptyClipId {
        index: usize,
    },
    DuplicateClipId {
        index: usize,
    },
    UnknownClipSource {
        index: usize,
        source_id: String,
    },
    EmptySegmentId {
        index: usize,
    },
    DuplicateSegmentId {
        index: usize,
    },
    UnknownSegmentClip {
        index: usize,
        field: &'static str,
        clip_id: String,
    },
    MissingSegmentStartPts {
        index: usize,
        source_id: String,
    },
    SegmentCrossesUnknownEnd {
        index: usize,
        clip_id: String,
    },
    InvalidSegmentRange {
        index: usize,
    },
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
            Self::EmptyClipId { index } => write!(formatter, "clips[{index}].id is empty"),
            Self::DuplicateClipId { index } => write!(formatter, "clips[{index}].id is duplicated"),
            Self::UnknownClipSource { index, source_id } => write!(
                formatter,
                "clips[{index}].sourceId {source_id:?} does not name a source"
            ),
            Self::EmptySegmentId { index } => write!(formatter, "segments[{index}].id is empty"),
            Self::DuplicateSegmentId { index } => {
                write!(formatter, "segments[{index}].id is duplicated")
            }
            Self::UnknownSegmentClip {
                index,
                field,
                clip_id,
            } => write!(
                formatter,
                "segments[{index}].{field} {clip_id:?} does not name a clip"
            ),
            Self::MissingSegmentStartPts { index, source_id } => write!(
                formatter,
                "segments[{index}] references source {source_id:?} without videoStartPts"
            ),
            Self::SegmentCrossesUnknownEnd { index, clip_id } => write!(
                formatter,
                "segments[{index}] crosses the end of clip {clip_id:?}, whose source has no videoEndPts"
            ),
            Self::InvalidSegmentRange { index } => write!(
                formatter,
                "segments[{index}] must lie in its clip ranges, in sequence order, in the one form of ADR 052"
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

    let sources_by_id: HashMap<&str, &Source> = project
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let mut clip_indexes = HashMap::new();
    let mut clip_sources = Vec::with_capacity(project.clips.len());
    for (index, clip) in project.clips.iter().enumerate() {
        if clip.id.is_empty() {
            return Err(ProjectValidationError::EmptyClipId { index });
        }
        if clip_indexes.insert(clip.id.as_str(), index).is_some() {
            return Err(ProjectValidationError::DuplicateClipId { index });
        }
        let source = sources_by_id
            .get(clip.source_id.as_str())
            .copied()
            .ok_or_else(|| ProjectValidationError::UnknownClipSource {
                index,
                source_id: clip.source_id.clone(),
            })?;
        clip_sources.push(source);
    }

    let mut segment_ids = HashSet::new();
    for (index, segment) in project.segments.iter().enumerate() {
        if segment.id.is_empty() {
            return Err(ProjectValidationError::EmptySegmentId { index });
        }
        if !segment_ids.insert(segment.id.as_str()) {
            return Err(ProjectValidationError::DuplicateSegmentId { index });
        }
        validate_segment(index, segment, &clip_indexes, &clip_sources, &project.clips)?;
    }
    Ok(())
}

/// The end of the range of a clip of `source`: its `videoEndPts`, or `None` when it is unknown.
/// An end that is not after the start is metadata that cannot be right, and it reads as unknown,
/// as `clipRange` reads it in `src/features/timeline/sequence.ts`.
fn clip_end(source: &Source) -> Option<Pts> {
    match (source.video_start_pts, source.video_end_pts) {
        (Some(start), Some(end)) if end > start => Some(end),
        _ => None,
    }
}

/// Check one segment against the rules of ADR 052. The In lies in the range of its clip and
/// before its end, the Out after the start and at or before the end, an end that is not known
/// bounds nothing, the In clip does not come after the Out clip, and on one clip `in < out`.
/// Every clip from the In clip to the Out clip needs a `videoStartPts`, and every clip before the
/// Out clip needs a `videoEndPts`, because QuipClip cannot name the last frame of a clip without it.
/// Raw PTS values are compared only on one clip (ADR 002).
fn validate_segment(
    index: usize,
    segment: &Segment,
    clip_indexes: &HashMap<&str, usize>,
    clip_sources: &[&Source],
    clips: &[Clip],
) -> Result<(), ProjectValidationError> {
    let clip_index = |field: &'static str, clip_id: &str| {
        clip_indexes.get(clip_id).copied().ok_or_else(|| {
            ProjectValidationError::UnknownSegmentClip {
                index,
                field,
                clip_id: clip_id.to_owned(),
            }
        })
    };
    let in_index = clip_index("inClipId", &segment.in_clip_id)?;
    let out_index = clip_index("outClipId", &segment.out_clip_id)?;
    if in_index > out_index {
        return Err(ProjectValidationError::InvalidSegmentRange { index });
    }
    for clip in in_index..=out_index {
        let source = clip_sources[clip];
        if source.video_start_pts.is_none() {
            return Err(ProjectValidationError::MissingSegmentStartPts {
                index,
                source_id: source.id.clone(),
            });
        }
        if clip < out_index && clip_end(source).is_none() {
            return Err(ProjectValidationError::SegmentCrossesUnknownEnd {
                index,
                clip_id: clips[clip].id.clone(),
            });
        }
    }
    let in_source = clip_sources[in_index];
    let out_source = clip_sources[out_index];
    let in_inside = in_source
        .video_start_pts
        .is_some_and(|start| segment.in_pts >= start)
        && clip_end(in_source).is_none_or(|end| segment.in_pts < end);
    let out_inside = out_source
        .video_start_pts
        .is_some_and(|start| segment.out_pts > start)
        && clip_end(out_source).is_none_or(|end| segment.out_pts <= end);
    let ordered = in_index < out_index || segment.in_pts < segment.out_pts;
    if !(in_inside && out_inside && ordered) {
        return Err(ProjectValidationError::InvalidSegmentRange { index });
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
    "videoEndPts":"32368200","videoDurationTicks":"32370000","approximateDurationSeconds":359.666667,
    "avgFrameRate":{"n":30000,"d":1001},"rFrameRate":{"n":30000,"d":1001},"reportedFrameCount":null
  },{
    "id":"s2","path":"/clips/b.mkv","relPath":"b.mkv","size":99,"mtime":1700000001,
    "videoStreamIndex":0,"videoTimeBase":{"n":1,"d":1000},"videoStartPts":"0",
    "videoEndPts":"5000","videoDurationTicks":null,"approximateDurationSeconds":5.0,
    "avgFrameRate":{"n":25,"d":1},"rFrameRate":{"n":25,"d":1},"reportedFrameCount":null
  }],
  "clips":[{"id":"c1","sourceId":"s1"},{"id":"c2","sourceId":"s2"},{"id":"c3","sourceId":"s1"}],
  "segments":[
    {"id":"g1","inClipId":"c1","inPts":"9000","outClipId":"c1","outPts":"27000"},
    {"id":"g2","inClipId":"c1","inPts":"32000000","outClipId":"c3","outPts":"9000"},
    {"id":"g3","inClipId":"c2","inPts":"0","outClipId":"c2","outPts":"5000"}
  ]
}"#;

    #[test]
    fn loads_and_round_trips_source_pts_schema_atomically() {
        let directory = TestDirectory::new();
        let path = directory.path.join("example.qcproj");
        fs::write(&path, EXAMPLE).unwrap();
        let project = load(&path).unwrap();
        assert_eq!(project.sources[0].video_start_pts, Some(Pts::new(-1800)));
        assert_eq!(project.sources[0].video_end_pts, Some(Pts::new(32_368_200)));
        assert_eq!(project.clips[1].source_id, "s2");
        assert_eq!(project.segments[0].out_pts, Pts::new(27000));
        assert_eq!(project.segments[1].out_clip_id, "c3");
        save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), project);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));
    }

    #[test]
    fn old_frame_grid_shape_is_a_normal_json_failure() {
        let directory = TestDirectory::new();
        let path = directory.path.join("old.qcproj");
        fs::write(&path, r#"{"schemaVersion":1,"timebase":{"n":30,"d":1},"resolution":{"w":1,"h":1},"sources":[],"clips":[],"segments":[]}"#).unwrap();
        assert!(matches!(load(&path), Err(ProjectFileError::Json(_))));
    }

    #[test]
    fn rejects_unknown_runtime_fields() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["sources"][0]["proxy"] = serde_json::json!({"path":"cache.mov"});
        assert_json_error(value);
    }

    /// A segment on one clip, for the tests that need one more.
    fn one_clip_segment(id: &str, clip: &str, in_pts: i64, out_pts: i64) -> Segment {
        Segment {
            id: id.to_owned(),
            in_clip_id: clip.to_owned(),
            in_pts: Pts::new(in_pts),
            out_clip_id: clip.to_owned(),
            out_pts: Pts::new(out_pts),
        }
    }

    fn assert_invalid_range(project: &ProjectFile) {
        assert!(matches!(
            validate_project(project),
            Err(ProjectValidationError::InvalidSegmentRange { .. })
        ));
    }

    #[test]
    fn source_without_start_pts_is_valid_until_referenced() {
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].video_start_pts = None;
        project.segments.clear();
        assert!(validate_project(&project).is_ok());
        project.segments.push(one_clip_segment("g1", "c1", 0, 1));
        assert!(matches!(
            validate_project(&project),
            Err(ProjectValidationError::MissingSegmentStartPts { .. })
        ));
    }

    #[test]
    fn a_crossing_needs_a_start_and_an_end_on_every_clip_it_passes() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        let mut changed = project.clone();
        changed.sources[1].video_start_pts = None;
        changed.segments.retain(|segment| segment.id == "g2");
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::MissingSegmentStartPts { source_id, .. }) if source_id == "s2"
        ));
        changed = project.clone();
        changed.sources[1].video_end_pts = None;
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::SegmentCrossesUnknownEnd { index: 1, clip_id }) if clip_id == "c2"
        ));
        // The Out clip itself needs no end.
        changed = project;
        changed.sources[1].video_end_pts = None;
        changed.segments.retain(|segment| segment.id == "g1");
        changed
            .segments
            .push(one_clip_segment("g4", "c2", 0, 99_999));
        assert!(validate_project(&changed).is_ok());
    }

    #[test]
    fn segment_boundaries_keep_the_one_form_and_the_sequence_order() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        // An Out at the end of a clip is valid; one tick after it is not.
        let mut changed = project.clone();
        changed.segments[2].out_pts = Pts::new(5001);
        assert_invalid_range(&changed);
        // An In at the end of a clip is the start of the next clip, so it is refused.
        changed = project.clone();
        changed.segments[1].in_pts = Pts::new(32_368_200);
        assert_invalid_range(&changed);
        // An Out at the start of a clip is the end of the clip before it, so it is refused.
        changed = project.clone();
        changed.segments[1].out_pts = Pts::new(-1800);
        assert_invalid_range(&changed);
        // An In before the start of its clip.
        changed = project.clone();
        changed.segments[0].in_pts = Pts::new(-1801);
        assert_invalid_range(&changed);
        // The In clip after the Out clip.
        changed = project.clone();
        changed.segments[1].in_clip_id = "c3".to_owned();
        changed.segments[1].out_clip_id = "c1".to_owned();
        assert_invalid_range(&changed);
        // On two clips, the raw PTS values are not compared: 32000000 > 9000 is fine.
        assert!(validate_project(&project).is_ok());
    }

    #[test]
    fn reads_an_end_that_is_not_after_the_start_as_unknown() {
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[1].video_end_pts = Some(Pts::new(0));
        // The end bounds nothing on its own clip, as `clipRange` reads it in TypeScript.
        project.segments.retain(|segment| segment.id == "g3");
        project.segments[0].out_pts = Pts::new(99_999);
        assert!(validate_project(&project).is_ok());
        // A crossing after that clip needs a known end.
        project.segments = vec![Segment {
            id: "g9".to_owned(),
            in_clip_id: "c2".to_owned(),
            in_pts: Pts::new(10),
            out_clip_id: "c3".to_owned(),
            out_pts: Pts::new(9000),
        }];
        assert!(matches!(
            validate_project(&project),
            Err(ProjectValidationError::SegmentCrossesUnknownEnd { index: 0, clip_id }) if clip_id == "c2"
        ));
    }

    #[test]
    fn validates_clip_ids_and_sources() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        let mut changed = project.clone();
        changed.clips[1].id = "c1".to_owned();
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::DuplicateClipId { index: 1 })
        ));
        changed = project.clone();
        changed.clips[0].id = String::new();
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::EmptyClipId { index: 0 })
        ));
        changed = project;
        changed.clips[2].source_id = "missing".to_owned();
        assert!(matches!(
            validate_project(&changed),
            Err(ProjectValidationError::UnknownClipSource { index: 2, source_id }) if source_id == "missing"
        ));
    }

    #[test]
    fn validates_ids_references_time_bases_and_half_open_ranges() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        let mut changed = project.clone();
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
    fn rejects_duplicate_segment_ids_and_unknown_segment_clips() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();

        let mut duplicate = project.clone();
        duplicate
            .segments
            .push(one_clip_segment("g1", "c1", 30_000, 40_000));
        assert!(matches!(
            validate_project(&duplicate),
            Err(ProjectValidationError::DuplicateSegmentId { index: 3 })
        ));

        let mut unknown_clip = project;
        unknown_clip.segments[0].out_clip_id = "missing".to_owned();
        assert!(matches!(
            validate_project(&unknown_clip),
            Err(ProjectValidationError::UnknownSegmentClip {
                index: 0,
                field: "outClipId",
                clip_id
            }) if clip_id == "missing"
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
