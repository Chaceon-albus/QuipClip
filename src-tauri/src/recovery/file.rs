//! The recovery file and the names of the files in the recovery directory (ADR 073).
//!
//! A recovery file is one JSON object with no indentation:
//!
//! ```json
//! {"recoveryVersion":1,"projectPath":"/Users/me/Cuts/Stream.qcproj","project":{...}}
//! ```
//!
//! `project` is a project document of ADR 072 with no `relPath`. It has the rules of a project
//! file, and the size limit of a project file applies to it with the measure of a save. A read
//! accepts a file of that limit plus [`READ_MARGIN_BYTES`].

use crate::project::{self, ProjectFile, ProjectFileError};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::SystemTime;

/// The version of the recovery file that this build reads and writes.
pub const RECOVERY_VERSION: u64 = 1;

/// The bytes that a recovery file can have above the size limit of a project file: the fields
/// around the document, and its `projectPath`.
pub const READ_MARGIN_BYTES: u64 = 64 * 1024;

/// The recovery file of the session of the owner.
pub const CURRENT_FILE_NAME: &str = "current.json";

/// The file whose lock makes a process the owner. No step removes it.
pub const OWNER_LOCK_FILE_NAME: &str = "owner.lock";

const OFFER_PREFIX: &str = "offer-";
const OFFER_SUFFIX: &str = ".json";
const OFFER_ID_LEN: usize = 16;

/// The start of the name of a temporary file that a write of `current.json` makes
/// (`fsutil::write_bytes_atomically`).
const CURRENT_TEMPORARY_PREFIX: &str = ".current.json.tmp-";

/// True when `id` has the exact form of the identifier of an offer: 16 lowercase hexadecimal
/// digits. The backend checks each identifier from the page with it before it makes a path.
#[must_use]
pub fn is_offer_id(id: &str) -> bool {
    id.len() == OFFER_ID_LEN
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The file name of the offer `id`. The caller checked `id` with [`is_offer_id`].
#[must_use]
pub fn offer_file_name(id: &str) -> String {
    format!("{OFFER_PREFIX}{id}{OFFER_SUFFIX}")
}

/// The identifier of an offer from its file name, or `None` for each other name.
#[must_use]
pub fn offer_id_of_file_name(name: &str) -> Option<&str> {
    name.strip_prefix(OFFER_PREFIX)
        .and_then(|rest| rest.strip_suffix(OFFER_SUFFIX))
        .filter(|id| is_offer_id(id))
}

/// True when `name` is the whole name of a temporary file of a write of `current.json`, in the
/// exact form that `fsutil::create_temporary_file` gives: `.current.json.tmp-<pid>-<sequence>`.
/// The process id is the canonical decimal text of a `u32`, and the sequence that of a `u64`:
/// digits only, no sign, no leading zero but `0` itself, and in range.
#[must_use]
pub fn is_current_temporary_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(CURRENT_TEMPORARY_PREFIX) else {
        return false;
    };
    let Some((pid, sequence)) = rest.split_once('-') else {
        return false;
    };
    is_canonical_decimal::<u32>(pid) && is_canonical_decimal::<u64>(sequence)
}

/// True when `text` is the canonical decimal text of a value of `T`: the text that `to_string`
/// gives for the value that it reads as.
fn is_canonical_decimal<T>(text: &str) -> bool
where
    T: std::str::FromStr + ToString,
{
    !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && text
            .parse::<T>()
            .is_ok_and(|value| value.to_string() == text)
}

/// The canonical decimal value of a `u64`, or `None` for each other text. The token of a
/// recovery session has this form.
#[must_use]
pub fn parse_canonical_u64(text: &str) -> Option<u64> {
    if is_canonical_decimal::<u64>(text) {
        text.parse().ok()
    } else {
        None
    }
}

/// The largest recovery file that a read accepts.
#[must_use]
pub fn read_limit(project_limit: u64) -> u64 {
    project_limit.saturating_add(READ_MARGIN_BYTES)
}

/// The content of a valid recovery file.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryContent {
    pub project_path: Option<String>,
    pub project: ProjectFile,
}

/// Why a recovery file is not valid.
#[derive(Debug)]
pub enum InvalidRecoveryFile {
    /// The file has more bytes than [`read_limit`].
    TooLarge,
    /// The file is not JSON, or it does not have the fields of a recovery file.
    Shape,
    /// `recoveryVersion` is absent or another value than [`RECOVERY_VERSION`].
    Version,
    /// The document does not have the rules of a project file.
    Document(ProjectFileError),
}

/// A failure to read a recovery file.
#[derive(Debug)]
pub enum ReadRecoveryError {
    /// The file could not be read. The caller leaves it.
    Io(io::Error),
    /// The file was read and is not a valid recovery file.
    Invalid(InvalidRecoveryFile),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryFileOut<'a> {
    recovery_version: u64,
    project_path: Option<&'a str>,
    project: &'a ProjectFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryFileIn {
    /// [`decode`] checked the version before this read.
    #[serde(rename = "recoveryVersion")]
    _recovery_version: serde::de::IgnoredAny,
    /// A string or null. The field must be present: `deserialize_with` makes it required.
    #[serde(deserialize_with = "deserialize_nullable_string")]
    project_path: Option<String>,
    project: serde_json::Value,
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

/// Makes the bytes of a recovery file from the document that the page sent.
///
/// The document is read with the steps of a project file. Its `relPath` values go, as a save
/// ignores those of the caller, and the document then has the rules of a project file and the
/// size limit `project_limit` with the measure of a save. So a document that a save accepts is
/// never refused here. The whole file must also fit in [`read_limit`], so that a read accepts
/// it: only a `projectPath` of more than about 64 KiB can fail that test.
pub fn encode(
    project_path: Option<&str>,
    project: serde_json::Value,
    project_limit: u64,
) -> Result<Vec<u8>, ProjectFileError> {
    let mut document = project::document_from_value(project)?;
    for source in &mut document.sources {
        source.rel_path = None;
    }
    project::validate_project(&document)?;
    project::serialize_for_save(&document, project_limit)?;
    let bytes = serde_json::to_vec(&RecoveryFileOut {
        recovery_version: RECOVERY_VERSION,
        project_path,
        project: &document,
    })?;
    let limit = read_limit(project_limit);
    if bytes.len() as u64 > limit {
        return Err(ProjectFileError::TooLarge { limit });
    }
    Ok(bytes)
}

/// Reads and validates the bytes of a recovery file.
pub fn decode(bytes: &[u8]) -> Result<RecoveryContent, InvalidRecoveryFile> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| InvalidRecoveryFile::Shape)?;
    let version = value
        .as_object()
        .ok_or(InvalidRecoveryFile::Shape)?
        .get("recoveryVersion")
        .and_then(serde_json::Value::as_u64);
    if version != Some(RECOVERY_VERSION) {
        return Err(InvalidRecoveryFile::Version);
    }
    let raw = RecoveryFileIn::deserialize(value).map_err(|_| InvalidRecoveryFile::Shape)?;
    let document =
        project::document_from_value(raw.project).map_err(InvalidRecoveryFile::Document)?;
    // The writer never writes `relPath`, so a file that has one is not a recovery file of
    // this build.
    if document
        .sources
        .iter()
        .any(|source| source.rel_path.is_some())
    {
        return Err(InvalidRecoveryFile::Shape);
    }
    project::validate_project(&document)
        .map_err(|error| InvalidRecoveryFile::Document(error.into()))?;
    Ok(RecoveryContent {
        project_path: raw.project_path,
        project: document,
    })
}

/// Reads and validates the recovery file at `path`, and answers its content and the time of its
/// last write. The read stops one byte after [`read_limit`].
pub fn read(
    path: &Path,
    project_limit: u64,
) -> Result<(RecoveryContent, SystemTime), ReadRecoveryError> {
    let limit = read_limit(project_limit);
    let file = fs::File::open(path).map_err(ReadRecoveryError::Io)?;
    let modified = file
        .metadata()
        .and_then(|metadata| metadata.modified())
        .map_err(ReadRecoveryError::Io)?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(ReadRecoveryError::Io)?;
    if bytes.len() as u64 > limit {
        return Err(ReadRecoveryError::Invalid(InvalidRecoveryFile::TooLarge));
    }
    let content = decode(&bytes).map_err(ReadRecoveryError::Invalid)?;
    Ok((content, modified))
}
