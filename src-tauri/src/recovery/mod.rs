//! The recovery of the work after an exit that did not ask (ADR 073).
//!
//! The directory `recovery` of the application data directory holds three kinds of files:
//!
//! - `owner.lock`. A process is the **owner** while it holds an exclusive lock on this file,
//!   through one handle that it keeps. Only the owner reads, writes, renames or removes a file
//!   of the directory. No step removes `owner.lock`.
//! - `current.json`, the recovery file of the session of the owner.
//! - `offer-<id>.json`, the offers: recovery files of sessions that ended with no confirmed
//!   quit.
//!
//! A page of the main window has a **session**. Each page load starts a new session with a new
//! token, and each command carries the token of its page. A command with another token changes
//! nothing. The backend notes the token of the command that wrote `current.json`. A command of
//! the owner that finds a `current.json` that no command with its own token wrote gives that
//! file the name of a new offer before each other step.
//!
//! One lock of the backend puts the commands in an order. The page load and the end of the
//! recovery at a confirmed quit do not wait for that lock to change the session or to end it.
//!
//! This module holds no Tauri type, so its tests run it on a temporary directory.
//! `commands::recovery` gives it to the page.

pub mod file;

#[cfg(test)]
mod tests;

use crate::commands::project::{map_document_error, ProjectCommandError};
use crate::project::{ProjectFile, PROJECT_FILE_MAX_BYTES};
use file::{InvalidRecoveryFile, ReadRecoveryError, CURRENT_FILE_NAME, OWNER_LOCK_FILE_NAME};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The time that the end of the recovery at a confirmed quit has in all: for the wait for the
/// command that runs, and for a removal of `current.json` that the system refuses and that it
/// tries again (ADR 073).
pub const END_BUDGET: Duration = Duration::from_secs(1);

/// The longest pause between two tries of the end of the recovery.
const END_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// What `current.json` holds after a command that writes or removes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CurrentFile {
    /// The state that this command wrote.
    Written,
    /// No file.
    Nothing,
    /// The backend cannot say: a step failed, or the process is not the owner.
    NotKnown,
}

/// How a command of the recovery ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryStatus {
    /// The command did its work.
    Done,
    /// The process is not the owner, or the data directory is not known or cannot be made. The
    /// command changed nothing.
    NotOwner,
    /// The token is not the token of the session, or the recovery of the session ended at a
    /// confirmed quit. The command changed nothing.
    StaleSession,
    /// The backend refused the document, by a rule of a project file or by the size limit.
    Refused,
    /// A step failed. `error` says which.
    Failed,
}

/// Stable error names translated by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryErrorCode {
    /// The identifier of an offer does not have the form of 16 lowercase hexadecimal digits.
    InvalidOfferId,
    /// The offer does not exist.
    OfferNotFound,
    /// A `current.json` of another session could not get the name of an offer.
    RenameFailed,
    /// The directory or a recovery file could not be read.
    ReadFailed,
    /// `current.json` could not be written.
    WriteFailed,
    /// `current.json` or an offer could not be removed.
    RemoveFailed,
    /// The offer is not a valid recovery file. `project` holds the error of its document when
    /// the document is the cause.
    InvalidRecoveryFile,
    /// The offer has another `recoveryVersion` than this build reads.
    UnsupportedRecoveryVersion,
    /// The backend refused the document. `project` holds the error of the project rules.
    DocumentRefused,
    /// The command did not run to its end.
    CommandExecutionFailed,
    /// `finish_restore` came with no `state` argument. An explicit null is the only form of
    /// "nothing to recover", so the command changed no file and kept the offer.
    MissingRestoreState,
}

/// A failure of a recovery command, with a stable code and the untranslated facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryError {
    pub code: RecoveryErrorCode,
    /// The text of an error of the operating system, untranslated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The error of the document, with the codes of the project commands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<Box<ProjectCommandError>>,
}

impl RecoveryError {
    fn new(code: RecoveryErrorCode) -> Self {
        Self {
            code,
            detail: None,
            project: None,
        }
    }

    /// An error of a file step. Only the text of an error of the operating system is kept, as
    /// the other commands keep it (ADR 011).
    fn io(code: RecoveryErrorCode, error: &io::Error) -> Self {
        Self {
            detail: error.raw_os_error().map(|_| error.to_string()),
            ..Self::new(code)
        }
    }

    fn invalid_file(invalid: InvalidRecoveryFile) -> Self {
        match invalid {
            InvalidRecoveryFile::Version => {
                Self::new(RecoveryErrorCode::UnsupportedRecoveryVersion)
            }
            InvalidRecoveryFile::Document(error) => Self {
                project: Some(Box::new(map_document_error(error))),
                ..Self::new(RecoveryErrorCode::InvalidRecoveryFile)
            },
            InvalidRecoveryFile::TooLarge | InvalidRecoveryFile::Shape => {
                Self::new(RecoveryErrorCode::InvalidRecoveryFile)
            }
        }
    }

    /// The error for a command whose blocking task did not end.
    #[must_use]
    pub fn execution_failed() -> Self {
        Self::new(RecoveryErrorCode::CommandExecutionFailed)
    }
}

/// The answer of `start_recovery`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAnswer {
    /// The token of the session, as a decimal string.
    pub token: String,
}

/// The answer of `write_recovery`, `clear_recovery` and `finish_restore`. It has the two facts
/// also when the command failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeAnswer {
    pub owner: bool,
    pub status: RecoveryStatus,
    pub current: CurrentFile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RecoveryError>,
}

impl ChangeAnswer {
    fn closed(owner: bool, status: RecoveryStatus) -> Self {
        Self {
            owner,
            status,
            current: CurrentFile::NotKnown,
            error: None,
        }
    }

    fn failed(current: CurrentFile, error: RecoveryError) -> Self {
        Self {
            owner: true,
            status: RecoveryStatus::Failed,
            current,
            error: Some(error),
        }
    }

    fn done(current: CurrentFile) -> Self {
        Self {
            owner: true,
            status: RecoveryStatus::Done,
            current,
            error: None,
        }
    }

    /// The answer for a command whose blocking task did not end.
    #[must_use]
    pub fn execution_failed() -> Self {
        Self::not_run(RecoveryError::execution_failed())
    }

    /// The answer of a `finish_restore` with no `state` argument. The command changed nothing,
    /// so it cannot say what the file holds. `owner` is whether the process holds the owner lock
    /// now.
    #[must_use]
    pub fn missing_restore_state(owner: bool) -> Self {
        Self {
            owner,
            ..Self::not_run(RecoveryError::new(RecoveryErrorCode::MissingRestoreState))
        }
    }

    fn not_run(error: RecoveryError) -> Self {
        Self {
            owner: false,
            status: RecoveryStatus::Failed,
            current: CurrentFile::NotKnown,
            error: Some(error),
        }
    }
}

/// One offer of [`ListAnswer`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferSummary {
    /// The identifier of the offer: 16 lowercase hexadecimal digits.
    pub id: String,
    /// The time of the last write of the offer, in milliseconds since the Unix epoch.
    pub written_at_ms: u64,
    pub project_path: Option<String>,
}

/// The answer of `list_recovery_offers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAnswer {
    pub owner: bool,
    pub status: RecoveryStatus,
    /// False when the process is not the owner, or when a step failed: the directory could not
    /// be read, the rename of a `current.json` failed, or an offer could not be read.
    pub complete: bool,
    /// The valid offers, the newest first.
    pub offers: Vec<OfferSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RecoveryError>,
}

impl ListAnswer {
    fn closed(owner: bool, status: RecoveryStatus) -> Self {
        Self {
            owner,
            status,
            complete: false,
            offers: Vec::new(),
            error: None,
        }
    }

    /// The answer for a command whose blocking task did not end.
    #[must_use]
    pub fn execution_failed() -> Self {
        Self {
            error: Some(RecoveryError::execution_failed()),
            ..Self::closed(false, RecoveryStatus::Failed)
        }
    }
}

/// The offer that `read_recovery` read. `candidates` has the shape of the candidates of
/// `load_project`: one list for each source, here with one path, the `path` of the entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredOffer {
    pub project_path: Option<String>,
    pub project: ProjectFile,
    pub candidates: Vec<Vec<String>>,
}

/// The answer of `read_recovery`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAnswer {
    pub owner: bool,
    pub status: RecoveryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offer: Option<RecoveredOffer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RecoveryError>,
}

impl ReadAnswer {
    fn closed(owner: bool, status: RecoveryStatus) -> Self {
        Self {
            owner,
            status,
            offer: None,
            error: None,
        }
    }

    fn failed(error: RecoveryError) -> Self {
        Self {
            error: Some(error),
            ..Self::closed(true, RecoveryStatus::Failed)
        }
    }

    /// The answer for a command whose blocking task did not end.
    #[must_use]
    pub fn execution_failed() -> Self {
        Self {
            error: Some(RecoveryError::execution_failed()),
            ..Self::closed(false, RecoveryStatus::Failed)
        }
    }
}

/// The answer of `discard_recovery`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardAnswer {
    pub owner: bool,
    pub status: RecoveryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RecoveryError>,
}

impl DiscardAnswer {
    fn closed(owner: bool, status: RecoveryStatus) -> Self {
        Self {
            owner,
            status,
            error: None,
        }
    }

    fn failed(error: RecoveryError) -> Self {
        Self {
            error: Some(error),
            ..Self::closed(true, RecoveryStatus::Failed)
        }
    }

    /// The answer for a command whose blocking task did not end.
    #[must_use]
    pub fn execution_failed() -> Self {
        Self {
            error: Some(RecoveryError::execution_failed()),
            ..Self::closed(false, RecoveryStatus::Failed)
        }
    }
}

/// The recovery state that `finish_restore` writes: the document and the path. The core reads
/// it from the JSON of the page itself, so a state of a wrong shape is a refused document.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreState {
    /// A string or null. The field must be present: `deserialize_with` makes it required.
    #[serde(deserialize_with = "deserialize_nullable_string")]
    project_path: Option<String>,
    project: serde_json::Value,
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

/// What the end of the recovery at a confirmed quit did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndOutcome {
    /// The quit carried no token or another token. Nothing ended, and nothing was removed.
    NotTheSession,
    /// The recovery ended, and no `current.json` of the session was there to remove.
    NothingToRemove,
    /// The recovery ended, and `current.json` of the session is gone.
    Removed,
    /// The recovery ended. A command still ran when the time ran out, so nothing was removed.
    CommandStillRan,
    /// The recovery ended. The system refused the removal of `current.json` until the time ran
    /// out.
    RemoveFailed,
    /// The recovery ended. The worker did not answer in the time, for example because a
    /// removal blocked in the file system. It goes on alone, and the quit does not wait for it.
    TimedOut,
    /// The recovery ended. The worker thread did not start, so nothing was removed.
    WorkerNotStarted,
}

/// The state that the command lock guards.
#[derive(Debug, Default)]
struct CommandState {
    /// The handle that holds the lock on `owner.lock`, while the process is the owner.
    owner: Option<File>,
    /// The token of the command that wrote `current.json`. After the step that gives a
    /// `current.json` of another session the name of an offer, the file is absent or this
    /// token is the token of the command.
    writer: Option<u64>,
}

/// The recovery of one process.
#[derive(Debug)]
pub struct Recovery {
    /// The directory `recovery`, or `None` when the data directory is not known.
    directory: Option<PathBuf>,
    /// The size limit of a project file. A test uses a small one.
    project_limit: u64,
    /// The token of the session now.
    session: AtomicU64,
    /// The token of the next session. Tokens only grow, so none repeats.
    next_token: AtomicU64,
    /// Set by a confirmed quit of the session. It is never cleared: the application is ending.
    ended: AtomicBool,
    /// The one lock of the backend that puts the commands in an order.
    commands: Mutex<CommandState>,
}

/// The parts of a command that may change the directory.
struct Entered<'a> {
    state: MutexGuard<'a, CommandState>,
    token: u64,
    directory: &'a Path,
}

impl Recovery {
    /// A recovery that uses `directory`, the directory `recovery` of the data directory, or no
    /// directory when the data directory is not known. The first session starts now.
    #[must_use]
    pub fn new(directory: Option<PathBuf>) -> Self {
        Self::with_project_limit(directory, PROJECT_FILE_MAX_BYTES)
    }

    /// [`Recovery::new`] with the size limit `project_limit`, so a test can use a small one.
    #[must_use]
    pub fn with_project_limit(directory: Option<PathBuf>, project_limit: u64) -> Self {
        Self {
            directory,
            project_limit,
            session: AtomicU64::new(1),
            next_token: AtomicU64::new(2),
            ended: AtomicBool::new(false),
            commands: Mutex::new(CommandState::default()),
        }
    }

    /// Starts a new session, when a page of the main window starts to load. It does not wait
    /// for a command that runs: it only makes a new token the token of the session.
    pub fn start_session(&self) {
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        self.session.store(token, Ordering::SeqCst);
    }

    /// Whether the process holds the owner lock now, read under the command lock. It makes no
    /// try to take the owner lock, and it does not touch the directory.
    #[must_use]
    pub fn is_owner(&self) -> bool {
        self.lock_commands().owner.is_some()
    }

    /// `start_recovery`: the token of the session. It reads no file.
    #[must_use]
    pub fn start(&self) -> StartAnswer {
        StartAnswer {
            token: self.session.load(Ordering::SeqCst).to_string(),
        }
    }

    fn lock_commands(&self) -> MutexGuard<'_, CommandState> {
        self.commands.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the command lock, checks the token, and tries to become the owner. The error is
    /// the answer of a command that changes nothing: whether the process is the owner, and why.
    fn enter(&self, token: &str) -> Result<Entered<'_>, (bool, RecoveryStatus)> {
        let mut state = self.lock_commands();
        let token = match parse_token(token) {
            Some(token)
                if !self.ended.load(Ordering::SeqCst)
                    && token == self.session.load(Ordering::SeqCst) =>
            {
                token
            }
            _ => return Err((state.owner.is_some(), RecoveryStatus::StaleSession)),
        };
        let Some(directory) = self.directory.as_deref() else {
            return Err((false, RecoveryStatus::NotOwner));
        };
        if !ensure_owner(&mut state, directory) {
            return Err((false, RecoveryStatus::NotOwner));
        }
        Ok(Entered {
            state,
            token,
            directory,
        })
    }

    /// `list_recovery_offers`: removes the temporary files of a write of `current.json`, removes
    /// each offer that is not a valid recovery file, and lists the valid offers, the newest
    /// first.
    pub fn list_offers(&self, token: &str) -> ListAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return ListAnswer::closed(owner, status),
        };
        if let Err(error) = adopt_current(&mut entered) {
            return ListAnswer {
                owner: true,
                status: RecoveryStatus::Failed,
                complete: false,
                offers: Vec::new(),
                error: Some(error),
            };
        }
        let entries = match fs::read_dir(entered.directory) {
            Ok(entries) => entries,
            Err(error) => {
                return ListAnswer {
                    owner: true,
                    status: RecoveryStatus::Failed,
                    complete: false,
                    offers: Vec::new(),
                    error: Some(RecoveryError::io(RecoveryErrorCode::ReadFailed, &error)),
                }
            }
        };
        let mut offers = Vec::new();
        let mut first_error = None;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    first_error
                        .get_or_insert(RecoveryError::io(RecoveryErrorCode::ReadFailed, &error));
                    continue;
                }
            };
            let name = entry.file_name();
            // A name that is not Unicode is not a name of this record.
            let Some(name) = name.to_str() else {
                continue;
            };
            let is_temporary = file::is_current_temporary_name(name);
            let offer_id = file::offer_id_of_file_name(name);
            if !is_temporary && offer_id.is_none() {
                continue;
            }
            // Only a file is a file of this record. The type of the entry itself, so a link is
            // not followed.
            match entry.file_type() {
                Ok(file_type) if file_type.is_file() => {}
                Ok(_) => continue,
                Err(error) => {
                    if offer_id.is_some() {
                        first_error.get_or_insert(RecoveryError::io(
                            RecoveryErrorCode::ReadFailed,
                            &error,
                        ));
                    }
                    continue;
                }
            }
            let path = entry.path();
            if is_temporary {
                // A removal that fails leaves the file for the next list.
                let _ = fs::remove_file(&path);
                continue;
            }
            let Some(id) = offer_id else {
                continue;
            };
            match file::read(&path, self.project_limit) {
                Ok((content, modified)) => offers.push((
                    modified,
                    OfferSummary {
                        id: id.to_owned(),
                        written_at_ms: unix_millis(modified),
                        project_path: content.project_path,
                    },
                )),
                Err(ReadRecoveryError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
                Err(ReadRecoveryError::Io(error)) => {
                    // An offer that cannot be read stays.
                    first_error
                        .get_or_insert(RecoveryError::io(RecoveryErrorCode::ReadFailed, &error));
                }
                Err(ReadRecoveryError::Invalid(_)) => {
                    // A removal that fails leaves the offer, and the list is not complete, so
                    // the page asks again.
                    if let Err(error) = remove_if_present(&path) {
                        first_error.get_or_insert(RecoveryError::io(
                            RecoveryErrorCode::RemoveFailed,
                            &error,
                        ));
                    }
                }
            }
        }
        // The full time of the file system orders the offers, the newest first. The identifier
        // breaks only an exact tie.
        offers.sort_by(|(left_time, left), (right_time, right)| {
            right_time
                .cmp(left_time)
                .then_with(|| left.id.cmp(&right.id))
        });
        let offers: Vec<OfferSummary> = offers.into_iter().map(|(_, offer)| offer).collect();
        let complete = first_error.is_none();
        ListAnswer {
            owner: true,
            status: if complete {
                RecoveryStatus::Done
            } else {
                RecoveryStatus::Failed
            },
            complete,
            offers,
            error: first_error,
        }
    }

    /// `write_recovery`: validates the document and writes `current.json`.
    pub fn write(
        &self,
        token: &str,
        project_path: Option<&str>,
        project: serde_json::Value,
    ) -> ChangeAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return ChangeAnswer::closed(owner, status),
        };
        if let Err(error) = adopt_current(&mut entered) {
            return ChangeAnswer::failed(CurrentFile::NotKnown, error);
        }
        let bytes = match file::encode(project_path, project, self.project_limit) {
            Ok(bytes) => bytes,
            Err(error) => return refuse(&mut entered, error),
        };
        self.write_current(&mut entered, &bytes)
    }

    /// `clear_recovery`: removes `current.json` when a command with the token wrote it.
    pub fn clear(&self, token: &str) -> ChangeAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return ChangeAnswer::closed(owner, status),
        };
        if let Err(error) = adopt_current(&mut entered) {
            return ChangeAnswer::failed(CurrentFile::NotKnown, error);
        }
        match remove_own_current(&mut entered) {
            Ok(()) => ChangeAnswer::done(CurrentFile::Nothing),
            Err(error) => ChangeAnswer::failed(
                CurrentFile::NotKnown,
                RecoveryError::io(RecoveryErrorCode::RemoveFailed, &error),
            ),
        }
    }

    /// `read_recovery`: reads and validates one offer.
    pub fn read_offer(&self, token: &str, id: &str) -> ReadAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return ReadAnswer::closed(owner, status),
        };
        if !file::is_offer_id(id) {
            return ReadAnswer::failed(RecoveryError::new(RecoveryErrorCode::InvalidOfferId));
        }
        if let Err(error) = adopt_current(&mut entered) {
            return ReadAnswer::failed(error);
        }
        let path = entered.directory.join(file::offer_file_name(id));
        match file::read(&path, self.project_limit) {
            Ok((content, _)) => {
                let candidates = content
                    .project
                    .sources
                    .iter()
                    .map(|source| vec![source.path.clone()])
                    .collect();
                ReadAnswer {
                    owner: true,
                    status: RecoveryStatus::Done,
                    offer: Some(RecoveredOffer {
                        project_path: content.project_path,
                        project: content.project,
                        candidates,
                    }),
                    error: None,
                }
            }
            Err(ReadRecoveryError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                ReadAnswer::failed(RecoveryError::new(RecoveryErrorCode::OfferNotFound))
            }
            Err(ReadRecoveryError::Io(error)) => {
                ReadAnswer::failed(RecoveryError::io(RecoveryErrorCode::ReadFailed, &error))
            }
            Err(ReadRecoveryError::Invalid(invalid)) => {
                ReadAnswer::failed(RecoveryError::invalid_file(invalid))
            }
        }
    }

    /// `discard_recovery`: removes one offer. An offer that is already gone is a success.
    pub fn discard_offer(&self, token: &str, id: &str) -> DiscardAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return DiscardAnswer::closed(owner, status),
        };
        if !file::is_offer_id(id) {
            return DiscardAnswer::failed(RecoveryError::new(RecoveryErrorCode::InvalidOfferId));
        }
        if let Err(error) = adopt_current(&mut entered) {
            return DiscardAnswer::failed(error);
        }
        match remove_if_present(&entered.directory.join(file::offer_file_name(id))) {
            Ok(()) => DiscardAnswer::closed(true, RecoveryStatus::Done),
            Err(error) => {
                DiscardAnswer::failed(RecoveryError::io(RecoveryErrorCode::RemoveFailed, &error))
            }
        }
    }

    /// `finish_restore`: writes `current.json` from `state`, or removes `current.json` when
    /// `state` is `None`, and then removes the offer `id`. `None` is only the explicit null of
    /// the page: the command layer never makes `None` from a missing argument. `state` is the
    /// JSON object `{ projectPath, project }`. A state of a wrong shape and a refused document
    /// remove `current.json` and keep the offer. A failed write keeps the offer.
    pub fn finish_restore(
        &self,
        token: &str,
        id: &str,
        state: Option<serde_json::Value>,
    ) -> ChangeAnswer {
        let mut entered = match self.enter(token) {
            Ok(entered) => entered,
            Err((owner, status)) => return ChangeAnswer::closed(owner, status),
        };
        if !file::is_offer_id(id) {
            return ChangeAnswer::failed(
                CurrentFile::NotKnown,
                RecoveryError::new(RecoveryErrorCode::InvalidOfferId),
            );
        }
        if let Err(error) = adopt_current(&mut entered) {
            return ChangeAnswer::failed(CurrentFile::NotKnown, error);
        }
        let answer = match state {
            Some(state) => {
                // Only a JSON object is a state. serde reads a sequence into a struct too, so
                // `[path, project]` would otherwise pass as the two fields.
                let fields = match serde_json::Map::deserialize(state) {
                    Ok(fields) => fields,
                    Err(error) => return refuse(&mut entered, error.into()),
                };
                let state = match RestoreState::deserialize(serde_json::Value::Object(fields)) {
                    Ok(state) => state,
                    Err(error) => return refuse(&mut entered, error.into()),
                };
                let bytes = match file::encode(
                    state.project_path.as_deref(),
                    state.project,
                    self.project_limit,
                ) {
                    Ok(bytes) => bytes,
                    Err(error) => return refuse(&mut entered, error),
                };
                self.write_current(&mut entered, &bytes)
            }
            None => match remove_own_current(&mut entered) {
                Ok(()) => ChangeAnswer::done(CurrentFile::Nothing),
                Err(error) => ChangeAnswer::failed(
                    CurrentFile::NotKnown,
                    RecoveryError::io(RecoveryErrorCode::RemoveFailed, &error),
                ),
            },
        };
        if answer.status != RecoveryStatus::Done {
            return answer;
        }
        match remove_if_present(&entered.directory.join(file::offer_file_name(id))) {
            Ok(()) => answer,
            Err(error) => ChangeAnswer::failed(
                answer.current,
                RecoveryError::io(RecoveryErrorCode::RemoveFailed, &error),
            ),
        }
    }

    /// Writes `bytes` as `current.json`, and notes the token of the command. A write that
    /// reaches its rename after the end of the recovery does not give its file the name.
    fn write_current(&self, entered: &mut Entered<'_>, bytes: &[u8]) -> ChangeAnswer {
        let path = entered.directory.join(CURRENT_FILE_NAME);
        match crate::fsutil::write_bytes_atomically_unless(&path, bytes, || {
            self.ended.load(Ordering::SeqCst)
        }) {
            Ok(true) => {
                entered.state.writer = Some(entered.token);
                ChangeAnswer::done(CurrentFile::Written)
            }
            Ok(false) => ChangeAnswer::closed(true, RecoveryStatus::StaleSession),
            Err(error) => ChangeAnswer::failed(
                CurrentFile::NotKnown,
                RecoveryError::io(RecoveryErrorCode::WriteFailed, &error),
            ),
        }
    }

    /// The end of the recovery at a confirmed quit (ADR 073), with [`END_BUDGET`].
    pub fn end(self: &Arc<Self>, token: Option<&str>) -> EndOutcome {
        self.end_with(token, END_BUDGET, remove_if_present)
    }

    /// [`Recovery::end`] with the time `budget`, so a test can use a short one.
    pub fn end_within(self: &Arc<Self>, token: Option<&str>, budget: Duration) -> EndOutcome {
        self.end_with(token, budget, remove_if_present)
    }

    /// The end of the recovery with the removal `remove`, so a test can make it block.
    ///
    /// With the token of the session, it ends the recovery at once on the thread of the caller,
    /// with no wait for a command that runs: each later command changes nothing. A worker
    /// thread then waits for the command lock and removes `current.json` when a command with
    /// that token wrote it. The caller waits for the worker until `budget` ends, and then
    /// returns in each case, also when the file stays. So the caller never waits longer than
    /// `budget`, also when a removal blocks in the file system.
    fn end_with(
        self: &Arc<Self>,
        token: Option<&str>,
        budget: Duration,
        remove: fn(&Path) -> io::Result<()>,
    ) -> EndOutcome {
        let Some(token) = token.and_then(parse_token) else {
            return EndOutcome::NotTheSession;
        };
        if token != self.session.load(Ordering::SeqCst) {
            return EndOutcome::NotTheSession;
        }
        self.ended.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + budget;
        let (sender, receiver) = mpsc::channel();
        let recovery = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("recovery-end".to_owned())
            .spawn(move || {
                let outcome = recovery.remove_at_end(token, deadline, remove);
                // The caller may have stopped to wait, so a failed send changes nothing.
                let _ = sender.send(outcome);
                // The log line comes from this thread, after the answer: a write to a standard
                // error stream that is a full pipe can block, and the thread of the quit must
                // not wait for it.
                if matches!(
                    outcome,
                    EndOutcome::CommandStillRan | EndOutcome::RemoveFailed
                ) {
                    eprintln!(
                        "recovery: the recovery file was not removed at the quit: {outcome:?}"
                    );
                }
            });
        if spawned.is_err() {
            return EndOutcome::WorkerNotStarted;
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(outcome) => outcome,
            Err(_) => EndOutcome::TimedOut,
        }
    }

    /// The work of the end on the worker thread: the wait for the command lock, and the
    /// removal of `current.json` of `token` with its tries. Each step tests `deadline` first.
    fn remove_at_end(
        &self,
        token: u64,
        deadline: Instant,
        remove: fn(&Path) -> io::Result<()>,
    ) -> EndOutcome {
        let Some(mut state) = self.lock_commands_until(deadline) else {
            return EndOutcome::CommandStillRan;
        };
        if state.writer != Some(token) || state.owner.is_none() {
            return EndOutcome::NothingToRemove;
        }
        let Some(directory) = self.directory.as_deref() else {
            return EndOutcome::NothingToRemove;
        };
        if remove_until(&directory.join(CURRENT_FILE_NAME), deadline, remove) {
            state.writer = None;
            EndOutcome::Removed
        } else {
            EndOutcome::RemoveFailed
        }
    }

    /// The command lock, or `None` when a command still holds it at `deadline`. The deadline is
    /// tested before each try, so the lock is never taken after it.
    fn lock_commands_until(&self, deadline: Instant) -> Option<MutexGuard<'_, CommandState>> {
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            match self.commands.try_lock() {
                Ok(guard) => return Some(guard),
                Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(END_POLL_INTERVAL.min(deadline - now));
                }
            }
        }
    }
}

/// The token of a page, or `None` for a text that is not the canonical decimal text of a token:
/// a leading zero, a sign or a space makes another token.
fn parse_token(token: &str) -> Option<u64> {
    file::parse_canonical_u64(token)
}

/// Makes the process the owner when it is not: it makes the directory and `owner.lock` when
/// they are absent, and takes an exclusive lock with no wait. It keeps the one handle while it
/// holds the lock, so it never opens a second handle on the file then.
fn ensure_owner(state: &mut CommandState, directory: &Path) -> bool {
    if state.owner.is_some() {
        return true;
    }
    if fs::create_dir_all(directory).is_err() {
        return false;
    }
    let Ok(lock_file) = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(OWNER_LOCK_FILE_NAME))
    else {
        return false;
    };
    match lock_file.try_lock() {
        Ok(()) => {
            state.owner = Some(lock_file);
            true
        }
        // The handle closes here, and the process tries again at its next command.
        Err(_) => false,
    }
}

/// Gives a `current.json` that no command with the token of this command wrote the name of a
/// new offer. It is the first step of each command of the owner. When it fails, the command
/// changes nothing more.
fn adopt_current(entered: &mut Entered<'_>) -> Result<(), RecoveryError> {
    if entered.state.writer == Some(entered.token) {
        return Ok(());
    }
    let current = entered.directory.join(CURRENT_FILE_NAME);
    match fs::symlink_metadata(&current) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            entered.state.writer = None;
            return Ok(());
        }
        Err(error) => return Err(RecoveryError::io(RecoveryErrorCode::RenameFailed, &error)),
    }
    let offer = new_offer_path(entered.directory)
        .map_err(|error| RecoveryError::io(RecoveryErrorCode::RenameFailed, &error))?;
    fs::rename(&current, &offer)
        .map_err(|error| RecoveryError::io(RecoveryErrorCode::RenameFailed, &error))?;
    entered.state.writer = None;
    Ok(())
}

/// The answer to a refused document: `current.json` goes when a command with the token wrote
/// it, so no old file gives back another state than the session has.
fn refuse(entered: &mut Entered<'_>, error: crate::project::ProjectFileError) -> ChangeAnswer {
    let current = match remove_own_current(entered) {
        Ok(()) => CurrentFile::Nothing,
        Err(_) => CurrentFile::NotKnown,
    };
    ChangeAnswer {
        owner: true,
        status: RecoveryStatus::Refused,
        current,
        error: Some(RecoveryError {
            project: Some(Box::new(map_document_error(error))),
            ..RecoveryError::new(RecoveryErrorCode::DocumentRefused)
        }),
    }
}

/// Removes `current.json` when a command with the token of this command wrote it. After
/// [`adopt_current`], no other `current.json` is there.
fn remove_own_current(entered: &mut Entered<'_>) -> io::Result<()> {
    if entered.state.writer != Some(entered.token) {
        return Ok(());
    }
    remove_if_present(&entered.directory.join(CURRENT_FILE_NAME))?;
    entered.state.writer = None;
    Ok(())
}

/// Removes the file at `path`. A file that is already gone is a success.
fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// `remove`, tried again while it fails, until `deadline`. The deadline is tested before each
/// try, so no try starts after it. True when the file is gone.
fn remove_until(path: &Path, deadline: Instant, remove: fn(&Path) -> io::Result<()>) -> bool {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        if remove(path).is_ok() {
            return true;
        }
        std::thread::sleep(
            END_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

/// A path for a new offer: a new identifier of 16 lowercase hexadecimal digits that is not the
/// name of a file that exists. The owner alone makes files in the directory, so the name stays
/// free until the rename.
fn new_offer_path(directory: &Path) -> io::Result<PathBuf> {
    for _ in 0..100 {
        let id = format!("{:016x}", random_u64());
        let path = directory.join(file::offer_file_name(&id));
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(path),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find a free offer name",
    ))
}

/// A random number with no crate: the keyed hash of the standard library, with new random keys
/// for each call, over a counter and the time.
fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher, RandomState};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0),
    );
    hasher.finish()
}

/// Milliseconds since the Unix epoch, or 0 for a time before it.
fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
