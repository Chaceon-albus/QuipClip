//! Show and open the file that an export published.
//!
//! The two commands here take a run id and not a path. The export worker records the
//! destination of each run that it publishes, and a command acts only on the recorded
//! destination of the run that it names. The web view therefore cannot tell the operating
//! system to open or show a path of its choice. The most that a compromised web view can do
//! through these commands is to open or show the file that the last export wrote.
//!
//! # Why the opener plugin's own commands are not used
//!
//! The plugin's `open_path` command takes a path from the web view and checks it against a
//! scope. That scope is static: it comes from the capability file, which is compiled into the
//! application. An export destination is any path that the user picks in the save dialog, so a
//! static scope that covers every destination must cover every path. That scope would let the
//! web view start any executable file on the machine. The plugin's `reveal_item_in_dir` command
//! checks no scope at all. This module calls the plugin's Rust functions instead. The plugin is
//! not registered, and the capability file grants the web view no opener permission.
//!
//! # Why Open accepts only a video extension
//!
//! `start_export` accepts any destination path, so the recorded path can have any extension.
//! The default handler of some extensions runs the file, such as `.bat` on Windows or
//! `.command` on macOS, and the content of an export includes metadata from the source file.
//! Open therefore acts only on a file with the extension of a container that a preset can
//! name. Show has no such check, because it only selects the file in the file manager and runs
//! nothing.

use crate::settings::Container;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The stable codes of a failed show or open request (ADR 011).
///
/// Each variant spells its wire string explicitly, so that
/// `src/features/export/output.test.ts` can read the vocabulary out of this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ExportOutputErrorCode {
    /// No export published a file under the run id in this process, or a later export
    /// replaced the record. The application decides this without a system call, so the code
    /// carries no diagnostic.
    #[serde(rename = "outputUnknown")]
    OutputUnknown,
    /// The recorded file is not at its path now. The user moved, renamed, or deleted it after
    /// the export. The code carries no diagnostic.
    #[serde(rename = "outputMissing")]
    OutputMissing,
    /// Open refused the file, because its extension is not the extension of a container that
    /// a preset can name. The module documentation gives the reason. The code carries no
    /// diagnostic.
    #[serde(rename = "outputNotVideo")]
    OutputNotVideo,
    /// The file manager did not show the file. The failure modes of the file manager cannot
    /// be enumerated, so this code carries the diagnostic of the operating system.
    #[serde(rename = "revealFailed")]
    RevealFailed,
    /// The operating system did not open the file with its default application. This code
    /// carries the diagnostic of the operating system, for the same reason as `RevealFailed`.
    #[serde(rename = "openFailed")]
    OpenFailed,
}

/// The rejection payload of [`reveal_export_output`] and [`open_export_output`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutputError {
    pub code: ExportOutputErrorCode,
    /// Untranslated diagnostic text. ADR 011 keeps it out of `code`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ExportOutputError {
    fn new(code: ExportOutputErrorCode) -> Self {
        Self { code, detail: None }
    }

    fn with_detail(code: ExportOutputErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
        }
    }
}

/// The destination of the last export that this process published.
///
/// `lib.rs` stores one value as Tauri managed state. The export worker writes it after the
/// rename and before it emits the `finished` event, so a request that follows that event finds
/// the record. `start_export` clears it when a new run takes the export slot. The commands in
/// this module read it.
///
/// The record holds one run. The interface shows the result of one run at a time, and a new
/// run gets a new run id, so an older run id stops matching when a newer run publishes.
#[derive(Debug, Default)]
pub struct PublishedExports {
    last: Mutex<Option<PublishedExport>>,
}

#[derive(Debug)]
struct PublishedExport {
    run_id: String,
    path: PathBuf,
}

impl PublishedExports {
    /// Record that the run `run_id` published its output at `path`. The record replaces the
    /// record of an earlier run.
    pub fn record(&self, run_id: &str, path: PathBuf) {
        let replaced = self.lock().replace(PublishedExport {
            run_id: run_id.to_owned(),
            path,
        });
        // Free the earlier record after the lock is released.
        drop(replaced);
    }

    /// Forget the recorded run. `start_export` calls this when a new run takes the export
    /// slot, so no request can act on the output of an earlier run while a later run writes,
    /// possibly to the same path.
    pub fn clear(&self) {
        let cleared = self.lock().take();
        // Free the record after the lock is released.
        drop(cleared);
    }

    /// The published path of the run `run_id`, or `None` when that run is not the recorded
    /// run.
    #[must_use]
    pub fn path_for(&self, run_id: &str) -> Option<PathBuf> {
        self.lock()
            .as_ref()
            .filter(|published| published.run_id == run_id)
            .map(|published| published.path.clone())
    }

    /// Lock the record, and recover a poisoned lock instead of propagating it.
    ///
    /// The data is one `Option` that each method replaces or reads as a whole, so a panic
    /// cannot leave it half updated. `ExportRegistry::lock` recovers its poison for the same
    /// reason.
    fn lock(&self) -> MutexGuard<'_, Option<PublishedExport>> {
        self.last.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The two requests that the interface can make for a published file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputAction {
    /// Show the file selected in Finder or in File Explorer.
    Reveal,
    /// Open the file with the default application of its type.
    Open,
}

impl OutputAction {
    fn failure_code(self) -> ExportOutputErrorCode {
        match self {
            Self::Reveal => ExportOutputErrorCode::RevealFailed,
            Self::Open => ExportOutputErrorCode::OpenFailed,
        }
    }

    /// The refusal that applies to `path` before any file system access, or `None`.
    fn refusal(self, path: &Path) -> Option<ExportOutputError> {
        match self {
            Self::Reveal => None,
            Self::Open => (!has_video_extension(path))
                .then(|| ExportOutputError::new(ExportOutputErrorCode::OutputNotVideo)),
        }
    }

    fn perform(self, path: &Path) -> Result<(), tauri_plugin_opener::Error> {
        match self {
            Self::Reveal => tauri_plugin_opener::reveal_item_in_dir(path),
            Self::Open => tauri_plugin_opener::open_path(path, None::<&str>),
        }
    }
}

/// Every container that a preset can name. Each entry is at the index that
/// [`container_position`] gives it.
const CONTAINERS: [Container; 3] = [Container::Mp4, Container::Mov, Container::Mkv];

/// The index of `container` in [`CONTAINERS`].
///
/// The match has no wildcard arm, so a new variant of [`Container`] does not compile until it
/// has an arm here. Give the new variant the next index, and add it at that index in
/// [`CONTAINERS`] and in [`container_extension`].
const fn container_position(container: Container) -> usize {
    match container {
        Container::Mp4 => 0,
        Container::Mov => 1,
        Container::Mkv => 2,
    }
}

// The build fails when an entry of `CONTAINERS` is not at its own `container_position`. So no
// variant is listed twice, and the list holds the variants in the order of the match.
const _: () = {
    let mut index = 0;
    while index < CONTAINERS.len() {
        assert!(
            container_position(CONTAINERS[index]) == index,
            "CONTAINERS must list each Container at its container_position"
        );
        index += 1;
    }
};

/// The file extension of `container`, which is also its name in the settings file and in the
/// filter of the save dialog. The match has no wildcard arm, so a new container does not
/// compile until it has an extension here.
fn container_extension(container: Container) -> &'static str {
    match container {
        Container::Mp4 => "mp4",
        Container::Mov => "mov",
        Container::Mkv => "mkv",
    }
}

/// Whether the extension of `path` is the extension of a container, in any letter case.
fn has_video_extension(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    CONTAINERS
        .into_iter()
        .any(|container| extension.eq_ignore_ascii_case(container_extension(container)))
}

/// Show the published file of the run `runId` in Finder or in File Explorer.
#[tauri::command]
pub async fn reveal_export_output(
    published: tauri::State<'_, PublishedExports>,
    run_id: String,
) -> Result<(), ExportOutputError> {
    run_output_action(&published, &run_id, OutputAction::Reveal).await
}

/// Open the published file of the run `runId` with the default application of its type.
#[tauri::command]
pub async fn open_export_output(
    published: tauri::State<'_, PublishedExports>,
    run_id: String,
) -> Result<(), ExportOutputError> {
    run_output_action(&published, &run_id, OutputAction::Open).await
}

/// Find the recorded path, then do the file system check and the system call on the blocking
/// pool.
///
/// The existence check and the system call can wait on a network share that stopped
/// answering, and the file manager can take a moment to answer. The async executor must not
/// wait for them.
async fn run_output_action(
    published: &PublishedExports,
    run_id: &str,
    action: OutputAction,
) -> Result<(), ExportOutputError> {
    let path = published
        .path_for(run_id)
        .ok_or_else(|| ExportOutputError::new(ExportOutputErrorCode::OutputUnknown))?;
    if let Some(refusal) = action.refusal(&path) {
        return Err(refusal);
    }
    tauri::async_runtime::spawn_blocking(move || {
        act_on_published_path(&path, action.failure_code(), |path| action.perform(path))
    })
    .await
    .map_err(|error| ExportOutputError::with_detail(action.failure_code(), error.to_string()))?
}

/// Check that `path` still exists, then call `perform` on it.
///
/// A missing file is a condition that the application can name, so it has its own code with no
/// diagnostic. Every other failure is reported as `failure_code` with the text of the error,
/// because the failure modes of the file system and of the file manager cannot be enumerated
/// (ADR 011).
///
/// `perform` is a parameter so that a test can observe the order of the check and the call
/// without a file manager.
fn act_on_published_path<Perform, PerformError>(
    path: &Path,
    failure_code: ExportOutputErrorCode,
    perform: Perform,
) -> Result<(), ExportOutputError>
where
    Perform: FnOnce(&Path) -> Result<(), PerformError>,
    PerformError: std::fmt::Display,
{
    match path.try_exists() {
        Ok(true) => {}
        Ok(false) => return Err(ExportOutputError::new(ExportOutputErrorCode::OutputMissing)),
        Err(error) => {
            return Err(ExportOutputError::with_detail(
                failure_code,
                error.to_string(),
            ))
        }
    }
    perform(path).map_err(|error| ExportOutputError::with_detail(failure_code, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::fs;

    /// A directory under the system temporary directory that the test deletes on drop.
    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "quipclip-export-output-{label}-{}",
                crate::commands::next_run_id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn every_error_code_serializes_to_its_stable_camel_case_string() {
        let pairs = [
            (ExportOutputErrorCode::OutputUnknown, "outputUnknown"),
            (ExportOutputErrorCode::OutputMissing, "outputMissing"),
            (ExportOutputErrorCode::OutputNotVideo, "outputNotVideo"),
            (ExportOutputErrorCode::RevealFailed, "revealFailed"),
            (ExportOutputErrorCode::OpenFailed, "openFailed"),
        ];
        for (code, wire) in pairs {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
    }

    #[test]
    fn an_error_omits_an_absent_detail_entirely_and_not_as_null() {
        let bare =
            serde_json::to_value(ExportOutputError::new(ExportOutputErrorCode::OutputMissing))
                .unwrap();
        assert_eq!(bare, serde_json::json!({ "code": "outputMissing" }));

        let detailed = serde_json::to_value(ExportOutputError::with_detail(
            ExportOutputErrorCode::OpenFailed,
            "no application",
        ))
        .unwrap();
        assert_eq!(
            detailed,
            serde_json::json!({ "code": "openFailed", "detail": "no application" })
        );
    }

    #[test]
    fn a_record_answers_only_for_its_own_run() {
        let published = PublishedExports::default();
        assert_eq!(published.path_for("1-0"), None);

        published.record("1-0", PathBuf::from("/movies/first.mp4"));
        assert_eq!(
            published.path_for("1-0"),
            Some(PathBuf::from("/movies/first.mp4"))
        );
        assert_eq!(published.path_for("1-1"), None);
    }

    #[test]
    fn a_clear_forgets_the_recorded_run() {
        let published = PublishedExports::default();
        published.record("1-0", PathBuf::from("/movies/first.mp4"));

        published.clear();

        assert_eq!(published.path_for("1-0"), None);
    }

    #[test]
    fn a_later_record_replaces_the_earlier_run() {
        let published = PublishedExports::default();
        published.record("1-0", PathBuf::from("/movies/first.mp4"));
        published.record("2-1", PathBuf::from("/movies/second.mp4"));

        assert_eq!(published.path_for("1-0"), None);
        assert_eq!(
            published.path_for("2-1"),
            Some(PathBuf::from("/movies/second.mp4"))
        );
    }

    #[test]
    fn an_existing_file_is_passed_to_the_action() {
        let directory = TempDirectory::new("exists");
        let file = directory.0.join("out.mp4");
        fs::write(&file, b"video").unwrap();
        let seen = RefCell::new(None);

        let result = act_on_published_path(&file, ExportOutputErrorCode::RevealFailed, |path| {
            *seen.borrow_mut() = Some(path.to_path_buf());
            Ok::<(), std::io::Error>(())
        });

        assert_eq!(result, Ok(()));
        assert_eq!(seen.into_inner(), Some(file));
    }

    #[test]
    fn a_missing_file_reports_its_own_code_and_makes_no_system_call() {
        let directory = TempDirectory::new("missing");
        let file = directory.0.join("moved-away.mp4");
        let called = Cell::new(false);

        let result = act_on_published_path(&file, ExportOutputErrorCode::OpenFailed, |_| {
            called.set(true);
            Ok::<(), std::io::Error>(())
        });

        assert_eq!(
            result,
            Err(ExportOutputError::new(ExportOutputErrorCode::OutputMissing))
        );
        assert!(
            !called.get(),
            "a missing file must not reach the file manager"
        );
    }

    #[test]
    fn a_failed_action_reports_the_action_code_with_the_diagnostic() {
        let directory = TempDirectory::new("fails");
        let file = directory.0.join("out.mp4");
        fs::write(&file, b"video").unwrap();

        let reveal = act_on_published_path(&file, ExportOutputErrorCode::RevealFailed, |_| {
            Err("the file manager did not answer")
        });
        assert_eq!(
            reveal,
            Err(ExportOutputError::with_detail(
                ExportOutputErrorCode::RevealFailed,
                "the file manager did not answer"
            ))
        );

        let open = act_on_published_path(&file, ExportOutputErrorCode::OpenFailed, |_| {
            Err("no application for this type")
        });
        assert_eq!(
            open,
            Err(ExportOutputError::with_detail(
                ExportOutputErrorCode::OpenFailed,
                "no application for this type"
            ))
        );
    }

    #[test]
    fn open_accepts_only_the_extension_of_a_container() {
        for accepted in ["/movies/out.mp4", "/movies/out.MOV", "/movies/out.Mkv"] {
            assert_eq!(
                OutputAction::Open.refusal(Path::new(accepted)),
                None,
                "{accepted}"
            );
        }
        for refused in [
            "/movies/out.command",
            "/movies/Out.app",
            "/movies/out.bat",
            "/movies/out",
            "/movies/out.mp4.exe",
        ] {
            assert_eq!(
                OutputAction::Open.refusal(Path::new(refused)),
                Some(ExportOutputError::new(
                    ExportOutputErrorCode::OutputNotVideo
                )),
                "{refused}"
            );
        }
    }

    #[test]
    fn show_accepts_any_extension_because_it_runs_nothing() {
        assert_eq!(
            OutputAction::Reveal.refusal(Path::new("/movies/out.command")),
            None
        );
    }

    #[test]
    fn every_container_extension_is_the_name_the_settings_file_uses() {
        for container in CONTAINERS {
            assert_eq!(
                serde_json::to_value(container).unwrap(),
                container_extension(container)
            );
        }
    }

    #[test]
    fn each_action_reports_its_own_failure_code() {
        assert_eq!(
            OutputAction::Reveal.failure_code(),
            ExportOutputErrorCode::RevealFailed
        );
        assert_eq!(
            OutputAction::Open.failure_code(),
            ExportOutputErrorCode::OpenFailed
        );
    }
}
