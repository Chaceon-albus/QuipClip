//! Persistence for versioned QuipClip project files.

use crate::time::{FrameCount, Pts, Rational, TickCount};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf, Prefix};

/// The project schema this build reads and writes.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The largest number of characters (Unicode scalar values) in the name of a segment (ADR 065).
pub const SEGMENT_NAME_MAX_CHARS: usize = 80;

/// The most bytes in front of the size of a revision that the fingerprint of an FLV covers
/// (ADR 058). `crate::flv::growth::FINGERPRINT_LEN` has the same value.
pub const FINGERPRINT_MAX_LEN: u64 = 64 * 1024;

/// The largest project file in bytes that `load` reads and `save` writes (32 MiB). A larger file
/// is refused with [`ProjectFileError::TooLarge`], so a wrong or hostile file cannot fill the
/// memory of the process.
pub const PROJECT_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// A project document stored in a `.qcproj` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFile {
    pub schema_version: u32,
    pub sources: Vec<Source>,
    /// The sequence: each clip places one source, and the array order is the sequence order
    /// (ADR 052).
    pub clips: Vec<Clip>,
    /// The segments in export order (ADR 007). Each boundary names a clip (ADR 052).
    pub segments: Vec<Segment>,
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
    /// The path of the source relative to the directory of the project file, with `/` between
    /// its parts, or `None` when the two paths have no common root (ADR 072). `save` writes it
    /// from `path` and ignores the value of the caller. The file has no `relPath` field for
    /// `None`, and the loader refuses `null` and a value that `is_valid_rel_path` refuses.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub rel_path: Option<String>,
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
    /// The absolute index of the audio stream that the user chose for this source, or `None`
    /// when the source has no override and uses its preferred audio stream (ADR 070). The file
    /// has no `audioStreamIndex` field for `None`: the field is not written for `None`, and the
    /// loader refuses `null`. A value is a non-negative integer that fits a `u32`, as the
    /// absolute stream index of ffprobe does.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present_stream_index"
    )]
    pub audio_stream_index: Option<u32>,
    /// The fingerprint of an FLV that the import kept, or `None` when it kept none (ADR 058,
    /// ADR 072). The file has no `fingerprint` field for `None`, and the loader refuses `null`.
    /// `validate_project` refuses a fingerprint that `parse_fingerprint` refuses.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub fingerprint: Option<SourceFingerprint>,
}

/// The text form of the fingerprint of an FLV (ADR 058, ADR 072): the FNV-1a hash of the bytes
/// from `start` to the size of the revision.
///
/// - `start` is a canonical decimal string of a `u64`: digits only, and no leading zero but
///   `"0"` itself. It is smaller than the size of the revision, and the size less `start` is
///   [`FINGERPRINT_MAX_LEN`] at most.
/// - `fnv1a64` is the hash as exactly 16 lowercase hexadecimal digits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceFingerprint {
    pub start: String,
    pub fnv1a64: String,
}

/// The fields of [`SourceFingerprint`], read by the derived reader of serde. That reader also
/// takes a sequence (`["13", "9f3c5a7714e0b2d1"]`), so [`SourceFingerprint`] gives it a map only.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFingerprintFields {
    start: String,
    fnv1a64: String,
}

impl<'de> Deserialize<'de> for SourceFingerprint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ObjectOnly;

        impl<'de> Visitor<'de> for ObjectOnly {
            type Value = SourceFingerprint;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object with the fields start and fnv1a64")
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let fields = SourceFingerprintFields::deserialize(
                    serde::de::value::MapAccessDeserializer::new(map),
                )?;
                Ok(SourceFingerprint {
                    start: fields.start,
                    fnv1a64: fields.fnv1a64,
                })
            }
        }

        deserializer.deserialize_map(ObjectOnly)
    }
}

impl SourceFingerprint {
    /// The text form of the fingerprint `[start, size)` with the hash `hash`.
    pub fn from_parts(start: u64, hash: u64) -> Self {
        Self {
            start: start.to_string(),
            fnv1a64: format!("{hash:016x}"),
        }
    }
}

/// The start and the hash of `fingerprint`, the fingerprint of a revision of `size` bytes, or
/// `None` when it breaks a rule of [`SourceFingerprint`].
pub fn parse_fingerprint(fingerprint: &SourceFingerprint, size: u64) -> Option<(u64, u64)> {
    let start = parse_canonical_u64(&fingerprint.start)?;
    if start >= size || size - start > FINGERPRINT_MAX_LEN {
        return None;
    }
    let hash_text = fingerprint.fnv1a64.as_bytes();
    if hash_text.len() != 16
        || !hash_text
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return None;
    }
    let hash = u64::from_str_radix(&fingerprint.fnv1a64, 16).ok()?;
    Some((start, hash))
}

/// The value of a canonical decimal string of a `u64`, or `None` for another text.
fn parse_canonical_u64(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.is_empty()
        || !bytes.iter().all(u8::is_ascii_digit)
        || (bytes.len() > 1 && bytes[0] == b'0')
    {
        return None;
    }
    text.parse().ok()
}

/// True when `rel_path` is a relative path of the project file (ADR 072): parts with `/` between
/// them, zero or more `..` parts first and then one or more names. Each part is exactly one path
/// component of the kind `ParentDir` or `Normal`. That refuses an empty text, an empty part, `.`,
/// a root, a drive, a NUL, a `..` after a name, and on Windows a part that holds a backslash. On
/// every host, the first part must not have the form of a drive (an ASCII letter and `:`), so a
/// file from Windows reads the same on macOS.
///
/// A `..` after a name is refused because the candidate builder resolves the parts by their text:
/// with only leading `..` parts, it never takes a named component off, so a symbolic link in the
/// path cannot change the file that the path names.
pub fn is_valid_rel_path(rel_path: &str) -> bool {
    if rel_path.contains('\0') || starts_with_drive(rel_path) {
        return false;
    }
    let mut parts = rel_path.split('/').peekable();
    while parts.peek() == Some(&"..") {
        parts.next();
    }
    let mut names = 0usize;
    for part in parts {
        if !is_rel_path_name(part) {
            return false;
        }
        names += 1;
    }
    names > 0
}

/// True when `text` starts with the form of a drive: an ASCII letter and `:`.
fn starts_with_drive(text: &str) -> bool {
    matches!(text.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}

/// True when `part` is exactly one path component of the kind `Normal`, and the text of that
/// component is the whole part. `Path::components` drops a `.` after a name, so the last test
/// refuses a part such as `a\.` on Windows.
fn is_rel_path_name(part: &str) -> bool {
    let mut components = Path::new(part).components();
    match (components.next(), components.next()) {
        (Some(component @ Component::Normal(_)), None) => {
            component.as_os_str().to_str() == Some(part)
        }
        _ => false,
    }
}

/// True when `path` is a path text that a document can hold for a source: not empty, and with
/// no NUL (ADR 072).
pub fn is_valid_source_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0')
}

/// The path of `source` relative to the directory `base`, with `/` between its parts (ADR
/// 072), or `None` when the two paths are not both absolute, when their prefixes or roots are
/// not equal (another drive or another share on Windows), when a component is not valid
/// Unicode, or when the result is not a valid `relPath`.
///
/// The comparison is by component, not by text: `fs::canonicalize` gives a verbatim path on
/// Windows (`\\?\C:\...`), and a verbatim drive and a plain drive of the same letter are one
/// root. The source file does not have to exist.
pub fn relative_path(base: &Path, source: &Path) -> Option<String> {
    if !base.is_absolute() || !source.is_absolute() {
        return None;
    }
    let base_components: Vec<Component<'_>> = base.components().collect();
    let source_components: Vec<Component<'_>> = source.components().collect();
    let (base_root, base_rest) = split_root(&base_components)?;
    let (source_root, source_rest) = split_root(&source_components)?;
    if !same_root(&base_root, &source_root) {
        return None;
    }
    let common = base_rest
        .iter()
        .zip(source_rest)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<&str> = Vec::new();
    for component in &base_rest[common..] {
        component.as_os_str().to_str()?;
        parts.push("..");
    }
    for component in &source_rest[common..] {
        parts.push(component.as_os_str().to_str()?);
    }
    let joined = parts.join("/");
    is_valid_rel_path(&joined).then_some(joined)
}

/// The root of an absolute path. [`same_root`] compares two of them.
#[derive(Debug)]
enum RootKey<'a> {
    /// The root of a path with no prefix, as each absolute path on Unix has.
    Plain,
    /// A drive, by its letter.
    Disk(u8),
    /// A share, by its server and its name.
    Share(&'a str, &'a str),
    /// Each other prefix, by its text.
    Other(&'a str),
}

/// True when two roots are one root: a verbatim drive or share is equal to the plain one, and
/// the letter of a drive and the names of a share compare with ASCII case folding only. Two
/// names that differ outside ASCII are two roots.
fn same_root(left: &RootKey<'_>, right: &RootKey<'_>) -> bool {
    match (left, right) {
        (RootKey::Plain, RootKey::Plain) => true,
        (RootKey::Disk(left), RootKey::Disk(right)) => left.eq_ignore_ascii_case(right),
        (RootKey::Share(left_server, left_share), RootKey::Share(right_server, right_share)) => {
            left_server.eq_ignore_ascii_case(right_server)
                && left_share.eq_ignore_ascii_case(right_share)
        }
        (RootKey::Other(left), RootKey::Other(right)) => left == right,
        _ => false,
    }
}

/// The root of an absolute path, and the components after it, or `None` for a path with no
/// root or with a prefix that is not Unicode.
fn split_root<'a, 'b>(
    components: &'b [Component<'a>],
) -> Option<(RootKey<'a>, &'b [Component<'a>])> {
    match components {
        [Component::RootDir, rest @ ..] => Some((RootKey::Plain, rest)),
        [Component::Prefix(prefix), Component::RootDir, rest @ ..] => {
            let key = match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => RootKey::Disk(letter),
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    RootKey::Share(server.to_str()?, share.to_str()?)
                }
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
                    RootKey::Other(prefix.as_os_str().to_str()?)
                }
            };
            Some((key, rest))
        }
        _ => None,
    }
}

/// The paths at which a project file in the directory `project_directory` looks for `source`,
/// in order (ADR 072): its `relPath` resolved against that directory when the entry has one,
/// and then its `path`. Equal paths appear once.
///
/// Each part of `relPath` is resolved by its text: a name is added as a component, and `..`
/// takes the last component off. A verbatim path of Windows (`\\?\C:\...`) does not resolve
/// `..` when the system reads it, and `project_directory` is canonical, so the result names the
/// file that `save` measured the path to. A valid `relPath` has its `..` parts first
/// ([`is_valid_rel_path`]), so a `..` only takes off a component of `project_directory`, never a
/// name of the `relPath`, and a symbolic link in the `relPath` cannot change the target.
pub fn candidate_paths(project_directory: &Path, source: &Source) -> Vec<String> {
    let mut candidates = Vec::with_capacity(2);
    if let Some(rel_path) = source.rel_path.as_deref() {
        let mut resolved = PathBuf::from(project_directory);
        for part in rel_path.split('/') {
            if part == ".." {
                resolved.pop();
            } else {
                resolved.push(part);
            }
        }
        if let Some(text) = resolved.to_str() {
            candidates.push(text.to_owned());
        }
    }
    if !candidates.contains(&source.path) {
        candidates.push(source.path.clone());
    }
    candidates
}

/// Reads an `audioStreamIndex` field that is present. Only a non-negative integer that fits a
/// `u32` is an index, so `null`, a fraction, a negative number and a string are JSON errors. An
/// absent field is `None` through `serde(default)`, and never reaches this function.
fn deserialize_present_stream_index<'de, D>(deserializer: D) -> Result<Option<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    u32::deserialize(deserializer).map(Some)
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
    /// The name of the segment, or `None` for a segment with no name (ADR 065). The file has no
    /// `name` field for a segment with no name: the field is not written for `None`, and the
    /// loader refuses `null`. `validate_project` refuses a name that `is_valid_segment_name`
    /// refuses, when a document is read and when one is written.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present_name"
    )]
    pub name: Option<String>,
}

/// Reads a `name` field that is present. Only a string is a name, so `null` is a JSON error. An
/// absent field is `None` through `serde(default)`, and never reaches this function.
fn deserialize_present_name<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

/// Reads an optional field that is present, such as `relPath` or `fingerprint`. Only a value of
/// the type is accepted, so `null` is a JSON error. An absent field is `None` through
/// `serde(default)`, and never reaches this function.
pub(crate) fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// True when the text is a valid segment name by the rule of ADR 065, the rule of
/// `isValidSegmentName` in `src/features/timeline/segmentName.ts`:
///
/// - 1 to 80 characters, each one Unicode scalar value;
/// - no character with the Unicode property `White_Space` (`char::is_whitespace`) at the start or
///   at the end;
/// - no control character of the general category `Cc` (`char::is_control`), no U+2028 and no
///   U+2029.
///
/// A Rust string cannot hold a surrogate without its pair, so that condition needs no test here:
/// the JSON reader refuses such a string.
pub fn is_valid_segment_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=SEGMENT_NAME_MAX_CHARS).contains(&count)
        && !name.chars().next().is_some_and(char::is_whitespace)
        && !name.chars().next_back().is_some_and(char::is_whitespace)
        && !name
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
}

/// A failure to read, validate, or save a project document.
#[derive(Debug)]
pub enum ProjectFileError {
    Io(io::Error),
    Json(serde_json::Error),
    Validation(ProjectValidationError),
    FutureSchemaVersion {
        found: u64,
        supported: u32,
    },
    /// The file, or the serialized document of a save, has more than `limit` bytes.
    TooLarge {
        limit: u64,
    },
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
    InvalidSegmentName {
        index: usize,
    },
    InvalidRelPath {
        index: usize,
    },
    InvalidFingerprint {
        index: usize,
    },
    InvalidSourcePath {
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
            Self::InvalidSegmentName { index } => write!(
                formatter,
                "segments[{index}].name must have 1 to {SEGMENT_NAME_MAX_CHARS} characters, no white space at either end, and no control character or line separator (ADR 065)"
            ),
            Self::InvalidRelPath { index } => write!(
                formatter,
                "sources[{index}].relPath must be `..` parts and then names, with `/` between them, no drive and no NUL (ADR 072)"
            ),
            Self::InvalidSourcePath { index } => write!(
                formatter,
                "sources[{index}].path must not be empty and must have no NUL (ADR 072)"
            ),
            Self::InvalidFingerprint { index } => write!(
                formatter,
                "sources[{index}].fingerprint must have a canonical decimal start below the size, at most {FINGERPRINT_MAX_LEN} bytes in front of the size, and 16 lowercase hexadecimal digits (ADR 072)"
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
            Self::TooLarge { limit } => {
                write!(formatter, "project file has more than {limit} bytes")
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
            Self::FutureSchemaVersion { .. } | Self::TooLarge { .. } => None,
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

/// Load and validate a project document from disk. A file of more than
/// [`PROJECT_FILE_MAX_BYTES`] bytes is refused, and no more than one byte past that limit is read.
pub fn load(path: impl AsRef<Path>) -> Result<ProjectFile, ProjectFileError> {
    load_within(path.as_ref(), PROJECT_FILE_MAX_BYTES)
}

/// [`load`] with the limit `limit`, so a test can use a small one.
fn load_within(path: &Path, limit: u64) -> Result<ProjectFile, ProjectFileError> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(ProjectFileError::TooLarge { limit });
    }
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
///
/// The `relPath` of each source is written here, from the canonical directory of `path` to the
/// `path` of the source (ADR 072). The values of the caller are ignored. The result is the
/// written document. A serialized document of more than [`PROJECT_FILE_MAX_BYTES`] bytes is
/// refused before the write.
pub fn save(
    path: impl AsRef<Path>,
    project: &ProjectFile,
) -> Result<ProjectFile, ProjectFileError> {
    save_within(path.as_ref(), project, PROJECT_FILE_MAX_BYTES)
}

/// [`save`] with the limit `limit`, so a test can use a small one.
fn save_within(
    path: &Path,
    project: &ProjectFile,
    limit: u64,
) -> Result<ProjectFile, ProjectFileError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let directory = fs::canonicalize(parent)?;
    let mut written = project.clone();
    for source in &mut written.sources {
        source.rel_path = relative_path(&directory, Path::new(&source.path));
    }
    validate_project(&written)?;
    let json = crate::fsutil::to_pretty_json_line(&written)?;
    if json.len() as u64 > limit {
        return Err(ProjectFileError::TooLarge { limit });
    }
    crate::fsutil::write_bytes_atomically(path, &json)?;
    Ok(written)
}

fn validate_project(project: &ProjectFile) -> Result<(), ProjectValidationError> {
    if project.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(ProjectValidationError::SchemaVersion {
            found: project.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
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
        if !is_valid_source_path(&source.path) {
            return Err(ProjectValidationError::InvalidSourcePath { index });
        }
        if source
            .rel_path
            .as_deref()
            .is_some_and(|rel_path| !is_valid_rel_path(rel_path))
        {
            return Err(ProjectValidationError::InvalidRelPath { index });
        }
        if source
            .fingerprint
            .as_ref()
            .is_some_and(|fingerprint| parse_fingerprint(fingerprint, source.size).is_none())
        {
            return Err(ProjectValidationError::InvalidFingerprint { index });
        }
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
        if segment
            .name
            .as_deref()
            .is_some_and(|name| !is_valid_segment_name(name))
        {
            return Err(ProjectValidationError::InvalidSegmentName { index });
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
        let written = save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), written);
        // Only the relative paths change: the save writes them from the place of the file.
        let mut expected = project.clone();
        for (source, written) in expected.sources.iter_mut().zip(&written.sources) {
            source.rel_path.clone_from(&written.rel_path);
        }
        assert_eq!(written, expected);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));
    }

    #[test]
    fn a_document_with_render_settings_is_refused() {
        // ADR 072 removes `renderSettings`, and no build wrote a file with it.
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["renderSettings"] = serde_json::json!({
            "frameRate": {"n": 30000, "d": 1001},
            "resolution": {"w": 1920, "h": 1080}
        });
        assert_json_error(value);
        let written =
            serde_json::to_value(serde_json::from_str::<ProjectFile>(EXAMPLE).unwrap()).unwrap();
        assert!(written.get("renderSettings").is_none());
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
            name: None,
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
            name: None,
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

    /// The text of a case of `src/features/timeline/segmentNameCases.json`, or `None` when the text
    /// holds a surrogate without its pair, which a Rust string cannot hold.
    fn shared_name_case_text(case: &serde_json::Value) -> Option<String> {
        let base = match case.get("text") {
            Some(text) => text.as_str().expect("a case text is a string").to_owned(),
            None => {
                let units: Vec<u16> = case["utf16"]
                    .as_array()
                    .expect("a case without text has UTF-16 units")
                    .iter()
                    .map(|unit| u16::try_from(unit.as_u64().expect("a unit")).expect("a unit"))
                    .collect();
                String::from_utf16(&units).ok()?
            }
        };
        let repeat = case
            .get("repeat")
            .map_or(1, |repeat| repeat.as_u64().expect("a repeat count"));
        Some(base.repeat(usize::try_from(repeat).expect("a small repeat count")))
    }

    /// The samples of `src/features/timeline/segmentNameCases.json`, which the vitest of
    /// `isValidSegmentName` in `src/features/timeline/segmentName.test.ts` runs too, so the two
    /// rules of ADR 065 cannot drift.
    #[test]
    fn segment_names_agree_with_the_shared_cases_of_the_frontend() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/features/timeline/segmentNameCases.json"
        ))
        .expect("the shared cases are JSON");
        let cases = table["cases"].as_array().expect("the cases are a list");
        assert!(cases.len() >= 30, "the shared cases were read");
        for case in cases {
            let label = case["name"].as_str().expect("each case has a name");
            let valid = case["valid"]
                .as_bool()
                .expect("each case says whether it is valid");
            let Some(text) = shared_name_case_text(case) else {
                // A lone surrogate: the JSON reader refuses the document before validation.
                assert!(!valid, "{label}: a lone surrogate is never valid");
                let surrogate = case["utf16"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|unit| format!("\\u{:04x}", unit.as_u64().unwrap()))
                    .collect::<String>();
                let document = EXAMPLE.replace(
                    r#""outPts":"27000"}"#,
                    &format!(r#""outPts":"27000","name":"{surrogate}"}}"#),
                );
                assert!(
                    serde_json::from_str::<ProjectFile>(&document).is_err(),
                    "{label}: the reader refuses the document"
                );
                continue;
            };
            assert_eq!(is_valid_segment_name(&text), valid, "{label}");
            let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
            project.segments[0].name = Some(text.clone());
            let checked = validate_project(&project);
            if valid {
                assert!(checked.is_ok(), "{label}");
                // The written document carries the name, and the reader gives it back.
                let json = serde_json::to_string(&project).unwrap();
                let read: ProjectFile = serde_json::from_str(&json).unwrap();
                assert_eq!(
                    read.segments[0].name.as_deref(),
                    Some(text.as_str()),
                    "{label}"
                );
            } else {
                assert!(
                    matches!(
                        checked,
                        Err(ProjectValidationError::InvalidSegmentName { index: 0 })
                    ),
                    "{label}"
                );
            }
        }
    }

    #[test]
    fn a_segment_with_no_name_has_no_name_field() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        assert!(project
            .segments
            .iter()
            .all(|segment| segment.name.is_none()));
        let value = serde_json::to_value(&project).unwrap();
        for segment in value["segments"].as_array().unwrap() {
            assert!(segment.get("name").is_none());
        }
    }

    #[test]
    fn refuses_null_for_a_name() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["segments"][0]["name"] = serde_json::Value::Null;
        assert_json_error(value.clone());
        value["segments"][0]["name"] = serde_json::json!(5);
        assert_json_error(value);
    }

    #[test]
    fn loads_and_saves_a_named_segment_and_refuses_a_bad_name_both_ways() {
        let directory = TestDirectory::new();
        let path = directory.path.join("named.qcproj");
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["segments"][1]["name"] = serde_json::json!("Intro 😀");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let project = load(&path).unwrap();
        assert_eq!(project.segments[1].name.as_deref(), Some("Intro 😀"));
        assert_eq!(project.segments[0].name, None);
        let written = save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), written);
        assert_eq!(written.segments, project.segments);

        // The reader refuses a name that is not valid.
        value["segments"][1]["name"] = serde_json::json!(" Intro");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&path),
            Err(ProjectFileError::Validation(
                ProjectValidationError::InvalidSegmentName { index: 1 }
            ))
        ));
        // The writer refuses it too, and leaves the file as it was.
        let before = fs::read(&path).unwrap();
        let mut bad = project;
        bad.segments[2].name = Some(String::new());
        assert!(matches!(
            save(&path, &bad),
            Err(ProjectFileError::Validation(
                ProjectValidationError::InvalidSegmentName { index: 2 }
            ))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_source_with_no_audio_override_has_no_audio_stream_index_field() {
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        assert!(project
            .sources
            .iter()
            .all(|source| source.audio_stream_index.is_none()));
        let value = serde_json::to_value(&project).unwrap();
        for source in value["sources"].as_array().unwrap() {
            assert!(source.get("audioStreamIndex").is_none());
        }
    }

    #[test]
    fn loads_and_saves_the_audio_stream_index_of_a_source() {
        // ADR 070: the optional field of the override of a source.
        let directory = TestDirectory::new();
        let path = directory.path.join("override.qcproj");
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        value["sources"][1]["audioStreamIndex"] = serde_json::json!(3);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let project = load(&path).unwrap();
        assert_eq!(project.sources[0].audio_stream_index, None);
        assert_eq!(project.sources[1].audio_stream_index, Some(3));
        let written = save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), written);
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["sources"][1]["audioStreamIndex"], 3);
        assert!(written["sources"][0].get("audioStreamIndex").is_none());
        // Index 0 is a valid absolute index, and so is the largest u32.
        value["sources"][1]["audioStreamIndex"] = serde_json::json!(0);
        let zero: ProjectFile = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(zero.sources[1].audio_stream_index, Some(0));
        value["sources"][1]["audioStreamIndex"] = serde_json::json!(u32::MAX);
        let largest: ProjectFile = serde_json::from_value(value).unwrap();
        assert_eq!(largest.sources[1].audio_stream_index, Some(u32::MAX));
    }

    #[test]
    fn refuses_an_audio_stream_index_that_is_null_or_not_a_u32() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        for bad in [
            serde_json::Value::Null,
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("1"),
            serde_json::json!(u64::from(u32::MAX) + 1),
        ] {
            value["sources"][0]["audioStreamIndex"] = bad;
            assert_json_error(value.clone());
        }
    }

    /// A fingerprint of the text form, for the tests below.
    fn fingerprint(start: &str, hash: &str) -> SourceFingerprint {
        SourceFingerprint {
            start: start.to_owned(),
            fnv1a64: hash.to_owned(),
        }
    }

    #[test]
    fn a_fingerprint_keeps_each_bound_of_its_form() {
        const HASH: &str = "9f3c5a7714e0b2d1";
        let size = 1_048_576 + 65_536;
        // The last 64 KiB in front of the size, and one byte in front of it.
        assert_eq!(
            parse_fingerprint(&fingerprint("1048576", HASH), size),
            Some((1_048_576, 0x9f3c_5a77_14e0_b2d1))
        );
        assert_eq!(parse_fingerprint(&fingerprint("1048575", HASH), size), None);
        assert_eq!(
            parse_fingerprint(&fingerprint(&(size - 1).to_string(), HASH), size),
            Some((size - 1, 0x9f3c_5a77_14e0_b2d1))
        );
        // The start must be smaller than the size.
        assert_eq!(
            parse_fingerprint(&fingerprint(&size.to_string(), HASH), size),
            None
        );
        assert_eq!(
            parse_fingerprint(&fingerprint("0", HASH), 1),
            Some((0, 0x9f3c_5a77_14e0_b2d1))
        );
        assert_eq!(parse_fingerprint(&fingerprint("0", HASH), 0), None);
        assert_eq!(
            parse_fingerprint(&fingerprint("0", HASH), 65_536),
            Some((0, 0x9f3c_5a77_14e0_b2d1))
        );
        assert_eq!(parse_fingerprint(&fingerprint("0", HASH), 65_537), None);
        // The start is a canonical decimal string of a u64.
        for start in [
            "",
            "01",
            "00",
            "+1",
            "-1",
            " 1",
            "1 ",
            "1.0",
            "1e3",
            "x",
            "18446744073709551616",
        ] {
            assert_eq!(
                parse_fingerprint(&fingerprint(start, HASH), u64::MAX),
                None,
                "{start:?}"
            );
        }
        assert_eq!(
            parse_fingerprint(&fingerprint("18446744073709551614", HASH), u64::MAX),
            Some((u64::MAX - 1, 0x9f3c_5a77_14e0_b2d1))
        );
        // The hash is exactly 16 lowercase hexadecimal digits.
        for hash in [
            "",
            "9f3c5a7714e0b2d",
            "9f3c5a7714e0b2d10",
            "9F3C5A7714E0B2D1",
            "9f3c5a7714e0b2dg",
            "+f3c5a7714e0b2d1",
            " f3c5a7714e0b2d1",
        ] {
            assert_eq!(
                parse_fingerprint(&fingerprint("1", hash), 100),
                None,
                "{hash:?}"
            );
        }
        assert_eq!(
            parse_fingerprint(&fingerprint("1", "0000000000000000"), 100),
            Some((1, 0))
        );
        assert_eq!(
            parse_fingerprint(&fingerprint("1", "ffffffffffffffff"), 100),
            Some((1, u64::MAX))
        );
        // The text form of the parts is the form that the parse reads.
        let text = SourceFingerprint::from_parts(7, 0xab);
        assert_eq!(text, fingerprint("7", "00000000000000ab"));
        assert_eq!(parse_fingerprint(&text, 8), Some((7, 0xab)));
    }

    #[test]
    fn loads_and_saves_a_fingerprint_and_refuses_a_bad_one_both_ways() {
        let directory = TestDirectory::new();
        let path = directory.path.join("fingerprint.qcproj");
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        // The size of the first source is 1234.
        value["sources"][0]["fingerprint"] =
            serde_json::json!({ "start": "13", "fnv1a64": "9f3c5a7714e0b2d1" });
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let project = load(&path).unwrap();
        assert_eq!(
            project.sources[0].fingerprint,
            Some(fingerprint("13", "9f3c5a7714e0b2d1"))
        );
        assert_eq!(project.sources[1].fingerprint, None);
        let written = save(&path, &project).unwrap();
        assert_eq!(load(&path).unwrap(), written);
        let read: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            read["sources"][0]["fingerprint"],
            serde_json::json!({ "start": "13", "fnv1a64": "9f3c5a7714e0b2d1" })
        );
        assert!(read["sources"][1].get("fingerprint").is_none());

        // The loader refuses a start that is not smaller than the size.
        value["sources"][0]["fingerprint"]["start"] = serde_json::json!("1234");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&path),
            Err(ProjectFileError::Validation(
                ProjectValidationError::InvalidFingerprint { index: 0 }
            ))
        ));
        // The writer refuses a bad fingerprint too, and leaves the file as it was.
        let before = fs::read(&path).unwrap();
        let mut bad = project.clone();
        bad.sources[1].fingerprint = Some(fingerprint("0", "9F3C5A7714E0B2D1"));
        assert!(matches!(
            save(&path, &bad),
            Err(ProjectFileError::Validation(
                ProjectValidationError::InvalidFingerprint { index: 1 }
            ))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn refuses_a_fingerprint_that_is_null_or_not_of_its_shape() {
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        for bad in [
            serde_json::Value::Null,
            serde_json::json!("13:9f3c5a7714e0b2d1"),
            serde_json::json!({ "start": 13, "fnv1a64": "9f3c5a7714e0b2d1" }),
            serde_json::json!({ "start": "13" }),
            serde_json::json!({ "start": "13", "fnv1a64": "9f3c5a7714e0b2d1", "size": 1 }),
            // The derived reader of serde takes a sequence for a struct; this one does not.
            serde_json::json!(["13", "9f3c5a7714e0b2d1"]),
        ] {
            value["sources"][0]["fingerprint"] = bad;
            assert_json_error(value.clone());
        }
        assert!(
            serde_json::from_value::<SourceFingerprint>(serde_json::json!([
                "13",
                "9f3c5a7714e0b2d1"
            ]))
            .is_err()
        );
        assert_eq!(
            serde_json::from_value::<SourceFingerprint>(serde_json::json!({
                "start": "13",
                "fnv1a64": "9f3c5a7714e0b2d1"
            }))
            .unwrap(),
            fingerprint("13", "9f3c5a7714e0b2d1")
        );
    }

    #[test]
    fn validates_the_form_of_a_rel_path() {
        for valid in [
            "a.mp4",
            "clips/a.mp4",
            "../a.mp4",
            "../../x/y/a.mp4",
            "a b/ç.mkv",
            "a..b",
            "...",
            ".hidden",
        ] {
            assert!(is_valid_rel_path(valid), "{valid:?}");
        }
        for invalid in [
            "",
            "/a.mp4",
            "a//b.mp4",
            "a/",
            "./a.mp4",
            "a/./b.mp4",
            ".",
            "a/.",
            "/",
            // Only leading `..` parts, and then one or more names.
            "..",
            "../..",
            "a/..",
            "a/../b.mp4",
            "link/../take.mp4",
            "../a/../b.mp4",
            // A drive form in the first part, on every host.
            "C:/clips/a.mp4",
            "c:a.mp4",
            "Z:",
            "a\0b.mp4",
        ] {
            assert!(!is_valid_rel_path(invalid), "{invalid:?}");
        }
        #[cfg(windows)]
        for invalid in ["C:a.mp4", "a\\b.mp4", "\\a.mp4", "//server/share/a.mp4"] {
            assert!(!is_valid_rel_path(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn the_loader_refuses_a_rel_path_that_is_null_or_not_relative() {
        let directory = TestDirectory::new();
        let path = directory.path.join("relative.qcproj");
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        for bad in ["/clips/a.mp4", "", "a/./b.mp4", "a//b.mp4"] {
            value["sources"][1]["relPath"] = serde_json::json!(bad);
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                matches!(
                    load(&path),
                    Err(ProjectFileError::Validation(
                        ProjectValidationError::InvalidRelPath { index: 1 }
                    ))
                ),
                "{bad:?}"
            );
        }
        value["sources"][1]["relPath"] = serde_json::Value::Null;
        assert_json_error(value.clone());
        // An entry with no relative path loads.
        value["sources"][1]
            .as_object_mut()
            .unwrap()
            .remove("relPath");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(load(&path).unwrap().sources[1].rel_path, None);
    }

    #[cfg(unix)]
    #[test]
    fn makes_the_relative_path_from_the_directory_to_the_source() {
        let base = Path::new("/Users/x/projects/cut");
        for (source, expected) in [
            ("/Users/x/projects/cut/a.mp4", Some("a.mp4")),
            (
                "/Users/x/projects/cut/clips/day 1/a.mp4",
                Some("clips/day 1/a.mp4"),
            ),
            ("/Users/x/projects/a.mp4", Some("../a.mp4")),
            (
                "/Users/x/videos/live/a.flv",
                Some("../../videos/live/a.flv"),
            ),
            ("/a.mp4", Some("../../../../a.mp4")),
            // The directory itself is not a file.
            ("/Users/x/projects/cut", None),
            // A path with no name after the `..` parts, and a `..` after a name.
            ("/Users/x/projects", None),
            ("/Users/x/projects/cut/a/../b.mp4", None),
            ("clips/a.mp4", None),
        ] {
            assert_eq!(
                relative_path(base, Path::new(source)).as_deref(),
                expected,
                "{source}"
            );
        }
        assert_eq!(
            relative_path(Path::new("/"), Path::new("/a.mp4")).as_deref(),
            Some("a.mp4")
        );
        assert_eq!(relative_path(Path::new("cut"), Path::new("/a.mp4")), None);
    }

    #[cfg(windows)]
    #[test]
    fn makes_the_relative_path_on_one_drive_or_share_only() {
        let base = Path::new(r"\\?\C:\Users\x\cut");
        for (source, expected) in [
            (r"\\?\C:\Users\x\cut\a.mp4", Some("a.mp4")),
            (r"\\?\C:\Users\x\cut\clips\a.mp4", Some("clips/a.mp4")),
            (r"\\?\C:\Users\x\videos\a.mp4", Some("../videos/a.mp4")),
            // A verbatim drive and a plain drive of the same letter are one root.
            (r"c:\Users\x\a.mp4", Some("../a.mp4")),
            // Another drive and a share have another root.
            (r"\\?\D:\Users\x\cut\a.mp4", None),
            (r"\\?\UNC\server\share\a.mp4", None),
            (r"\\server\share\a.mp4", None),
        ] {
            assert_eq!(
                relative_path(base, Path::new(source)).as_deref(),
                expected,
                "{source}"
            );
        }
        let share = Path::new(r"\\?\UNC\Server\Share\cut");
        assert_eq!(
            relative_path(share, Path::new(r"\\server\share\v\a.mp4")).as_deref(),
            Some("../v/a.mp4")
        );
        assert_eq!(
            relative_path(share, Path::new(r"\\server\other\a.mp4")),
            None
        );
    }

    #[test]
    fn roots_compare_with_ascii_case_folding_only() {
        assert!(same_root(&RootKey::Plain, &RootKey::Plain));
        assert!(same_root(&RootKey::Disk(b'c'), &RootKey::Disk(b'C')));
        assert!(!same_root(&RootKey::Disk(b'C'), &RootKey::Disk(b'D')));
        assert!(same_root(
            &RootKey::Share("Server", "Share"),
            &RootKey::Share("SERVER", "share")
        ));
        // Names that differ outside ASCII are two roots, and the entry gets no relPath.
        assert!(!same_root(
            &RootKey::Share("server", "Ärzte"),
            &RootKey::Share("server", "ärzte")
        ));
        assert!(!same_root(
            &RootKey::Share("Ünit", "share"),
            &RootKey::Share("ünit", "share")
        ));
        assert!(!same_root(&RootKey::Plain, &RootKey::Disk(b'C')));
        assert!(!same_root(
            &RootKey::Other(r"\\?\Volume{1}"),
            &RootKey::Other(r"\\?\volume{1}")
        ));
    }

    #[test]
    fn the_size_of_a_project_file_has_a_limit_both_ways() {
        assert_eq!(PROJECT_FILE_MAX_BYTES, 32 * 1024 * 1024);
        let directory = TestDirectory::new();
        let path = directory.path.join("limit.qcproj");
        fs::write(&path, EXAMPLE).unwrap();
        let size = EXAMPLE.len() as u64;
        assert!(load_within(&path, size).is_ok());
        assert!(matches!(
            load_within(&path, size - 1),
            Err(ProjectFileError::TooLarge { limit }) if limit == size - 1
        ));
        // A file far over the limit is refused before the JSON reader sees it.
        fs::write(&path, vec![b'x'; 10_000]).unwrap();
        assert!(matches!(
            load_within(&path, 100),
            Err(ProjectFileError::TooLarge { limit: 100 })
        ));

        // The save refuses a document over the limit before the write.
        let project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        let written = save_within(&path, &project, PROJECT_FILE_MAX_BYTES).unwrap();
        let length = fs::read(&path).unwrap().len() as u64;
        assert!(save_within(&path, &project, length).is_ok());
        let before = fs::read(&path).unwrap();
        assert!(matches!(
            save_within(&path, &project, length - 1),
            Err(ProjectFileError::TooLarge { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(load(&path).unwrap(), written);
    }

    #[test]
    fn the_path_of_a_source_is_not_empty_and_has_no_nul() {
        let directory = TestDirectory::new();
        let path = directory.path.join("paths.qcproj");
        let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        for bad in ["", "/clips/a\0.mp4"] {
            value["sources"][1]["path"] = serde_json::json!(bad);
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                matches!(
                    load(&path),
                    Err(ProjectFileError::Validation(
                        ProjectValidationError::InvalidSourcePath { index: 1 }
                    ))
                ),
                "{bad:?}"
            );
            let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
            project.sources[0].path = bad.to_owned();
            assert!(
                matches!(
                    save(directory.path.join("save.qcproj"), &project),
                    Err(ProjectFileError::Validation(
                        ProjectValidationError::InvalidSourcePath { index: 0 }
                    ))
                ),
                "{bad:?}"
            );
        }
    }

    /// The cases of `src/features/project/pathTextCases.json`, which the vitest of
    /// `validateProjectDocument` runs too: Rust never answers `load_project` with a path text that
    /// the page refuses, and the page refuses each one that Rust refuses.
    #[test]
    fn path_texts_agree_with_the_shared_cases_of_the_frontend() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/features/project/pathTextCases.json"
        ))
        .expect("the shared cases are JSON");
        let directory = TestDirectory::new();
        let path = directory.path.join("cases.qcproj");
        let rel_cases = table["relPath"].as_array().expect("relPath cases");
        let path_cases = table["path"].as_array().expect("path cases");
        assert!(rel_cases.len() >= 20 && path_cases.len() >= 4);
        for case in rel_cases {
            let text = case["text"].as_str().unwrap();
            let valid = case["valid"].as_bool().unwrap();
            assert_eq!(is_valid_rel_path(text), valid, "relPath {text:?}");
            let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
            value["sources"][0]["relPath"] = serde_json::json!(text);
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            let loaded = load(&path);
            if valid {
                assert!(loaded.is_ok(), "relPath {text:?}");
            } else {
                assert!(
                    matches!(
                        loaded,
                        Err(ProjectFileError::Validation(
                            ProjectValidationError::InvalidRelPath { index: 0 }
                        ))
                    ),
                    "relPath {text:?}"
                );
            }
        }
        for case in path_cases {
            let text = case["text"].as_str().unwrap();
            let valid = case["valid"].as_bool().unwrap();
            assert_eq!(is_valid_source_path(text), valid, "path {text:?}");
            let mut value: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
            value["sources"][0]["path"] = serde_json::json!(text);
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(load(&path).is_ok(), valid, "path {text:?}");
        }
    }

    #[test]
    fn the_save_writes_the_relative_path_of_each_source_itself() {
        let directory = TestDirectory::new();
        let root = fs::canonicalize(&directory.path).unwrap();
        let projects = root.join("projects");
        fs::create_dir(&projects).unwrap();
        let path = projects.join("cut.qcproj");
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        // The source files do not have to exist.
        project.sources[0].path = projects
            .join("clips")
            .join("a.mp4")
            .to_str()
            .unwrap()
            .to_owned();
        project.sources[1].path = root
            .join("videos")
            .join("b.mkv")
            .to_str()
            .unwrap()
            .to_owned();
        project.sources[0].rel_path = Some("ignored.mp4".to_owned());
        project.sources[1].rel_path = None;
        let written = save(&path, &project).unwrap();
        assert_eq!(written.sources[0].rel_path.as_deref(), Some("clips/a.mp4"));
        assert_eq!(
            written.sources[1].rel_path.as_deref(),
            Some("../videos/b.mkv")
        );
        assert_eq!(load(&path).unwrap(), written);
        // The same file in the directory of the project.
        project.sources[0].path = projects.join("a.mp4").to_str().unwrap().to_owned();
        let written = save(&path, &project).unwrap();
        assert_eq!(written.sources[0].rel_path.as_deref(), Some("a.mp4"));
        // A path that is not absolute gets none, and the caller's value does not stay.
        project.sources[0].path = "clips/a.mp4".to_owned();
        let written = save(&path, &project).unwrap();
        assert_eq!(written.sources[0].rel_path, None);
        let read: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(read["sources"][0].get("relPath").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_save_measures_from_the_canonical_directory_of_the_destination() {
        // A link to the directory: the relative path starts at the directory that it names.
        let directory = TestDirectory::new();
        let root = fs::canonicalize(&directory.path).unwrap();
        let real = root.join("real").join("deep");
        fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, root.join("link")).unwrap();
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].path = root.join("a.mp4").to_str().unwrap().to_owned();
        let written = save(root.join("link").join("cut.qcproj"), &project).unwrap();
        assert_eq!(written.sources[0].rel_path.as_deref(), Some("../../a.mp4"));
    }

    #[test]
    fn the_candidates_are_the_relative_path_and_then_the_path_once_each() {
        let mut source = serde_json::from_str::<ProjectFile>(EXAMPLE)
            .unwrap()
            .sources[0]
            .clone();
        let directory = std::env::temp_dir().join("projects").join("cut");
        let text = |path: PathBuf| path.to_str().unwrap().to_owned();
        source.path = text(std::env::temp_dir().join("old").join("a.mp4"));

        source.rel_path = Some("clips/a.mp4".to_owned());
        assert_eq!(
            candidate_paths(&directory, &source),
            vec![
                text(directory.join("clips").join("a.mp4")),
                source.path.clone()
            ]
        );
        // `..` takes the last component off, by the text of the path.
        source.rel_path = Some("../../old/a.mp4".to_owned());
        assert_eq!(
            candidate_paths(&directory, &source),
            vec![source.path.clone()]
        );
        source.rel_path = Some("../a.mp4".to_owned());
        assert_eq!(
            candidate_paths(&directory, &source),
            vec![
                text(std::env::temp_dir().join("projects").join("a.mp4")),
                source.path.clone()
            ]
        );
        // With no relative path, the path alone.
        source.rel_path = None;
        assert_eq!(
            candidate_paths(&directory, &source),
            vec![source.path.clone()]
        );
    }

    #[test]
    fn a_saved_project_finds_its_sources_at_the_relative_path_after_a_move() {
        let directory = TestDirectory::new();
        let root = fs::canonicalize(&directory.path).unwrap();
        let old = root.join("old");
        fs::create_dir_all(old.join("clips")).unwrap();
        let mut project: ProjectFile = serde_json::from_str(EXAMPLE).unwrap();
        project.sources[0].path = old.join("clips").join("a.mp4").to_str().unwrap().to_owned();
        project.sources[1].path = root.join("b.mkv").to_str().unwrap().to_owned();
        let written = save(old.join("cut.qcproj"), &project).unwrap();
        // The folder of the project moves with its clips.
        let new = root.join("new");
        fs::rename(&old, &new).unwrap();
        let loaded = load(new.join("cut.qcproj")).unwrap();
        assert_eq!(loaded, written);
        assert_eq!(
            candidate_paths(&new, &loaded.sources[0]),
            vec![
                new.join("clips").join("a.mp4").to_str().unwrap().to_owned(),
                loaded.sources[0].path.clone()
            ]
        );
        assert_eq!(
            candidate_paths(&new, &loaded.sources[1]),
            vec![loaded.sources[1].path.clone()]
        );
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
