//! The download and install of `ffmpeg` and `ffprobe` after the consent of the user (ADR 058).
//!
//! [`manifest`] holds the pinned files of each target. [`download`] writes one archive to disk
//! and checks its size and its SHA-256. [`extract`] takes one program out of a zip. [`steps`]
//! runs the whole install, from the download to the move into `<local_data>/bin`. [`registry`]
//! holds the one slot of the install.

pub mod download;
pub mod extract;
pub mod manifest;
pub mod registry;
pub mod steps;

use serde::Serialize;

/// The stable error codes of the install (ADR 058). The frontend mirrors them exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallErrorCode {
    /// This build of QuipClip has no download.
    UnsupportedTarget,
    /// Another install runs now.
    Busy,
    /// Discovery finds a pair that the download must not replace.
    AlreadyFound,
    /// Tauri gives no data directory or no local data directory.
    AppDataUnavailable,
    /// Tauri gives no cache directory, or the install work directory cannot be made.
    WorkDirectoryUnavailable,
    NetworkFailed,
    HttpStatus,
    SizeMismatch,
    HashMismatch,
    ArchiveInvalid,
    EntryMissing,
    WriteFailed,
    VersionCheckFailed,
    Canceled,
    /// The install could not run: a thread did not start, or it stopped on an internal error.
    /// The export, the probe and the envelope jobs have the same code.
    CommandExecutionFailed,
}
