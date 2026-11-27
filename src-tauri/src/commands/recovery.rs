//! Tauri commands of the recovery (ADR 073).
//!
//! The rules live in `crate::recovery`. Each command here reads the managed
//! [`Recovery`], and runs the work that touches files on `spawn_blocking`, so no file step holds
//! the main thread. Each command answers with a value, also when a step failed: the answer
//! carries the facts that the page needs, and a stable error code.

use crate::recovery::{
    ChangeAnswer, DiscardAnswer, ListAnswer, ReadAnswer, Recovery, RecoveryError, StartAnswer,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// The managed recovery, or `None` before the setup hook managed it.
fn recovery(app: &AppHandle) -> Option<Arc<Recovery>> {
    app.try_state::<Arc<Recovery>>()
        .map(|state| Arc::clone(state.inner()))
}

/// Answers with the token of the recovery session of the page. It reads no file.
#[tauri::command]
pub fn start_recovery(recovery: State<'_, Arc<Recovery>>) -> StartAnswer {
    recovery.start()
}

/// Removes the temporary files of a write of `current.json`, and lists the valid offers.
#[tauri::command]
pub async fn list_recovery_offers(app: AppHandle, token: String) -> ListAnswer {
    let Some(recovery) = recovery(&app) else {
        return ListAnswer::execution_failed();
    };
    tauri::async_runtime::spawn_blocking(move || recovery.list_offers(&token))
        .await
        .unwrap_or_else(|_| ListAnswer::execution_failed())
}

/// Validates the document and writes `current.json`. The document comes as JSON, so the
/// backend reads it with the rules of a project file and refuses a document of a wrong shape
/// in its answer.
#[tauri::command]
pub async fn write_recovery(
    app: AppHandle,
    token: String,
    project_path: Option<String>,
    project: serde_json::Value,
) -> ChangeAnswer {
    let Some(recovery) = recovery(&app) else {
        return ChangeAnswer::execution_failed();
    };
    tauri::async_runtime::spawn_blocking(move || {
        recovery.write(&token, project_path.as_deref(), project)
    })
    .await
    .unwrap_or_else(|_| ChangeAnswer::execution_failed())
}

/// Removes `current.json` when a command with the token wrote it.
#[tauri::command]
pub async fn clear_recovery(app: AppHandle, token: String) -> ChangeAnswer {
    let Some(recovery) = recovery(&app) else {
        return ChangeAnswer::execution_failed();
    };
    tauri::async_runtime::spawn_blocking(move || recovery.clear(&token))
        .await
        .unwrap_or_else(|_| ChangeAnswer::execution_failed())
}

/// Reads and validates one offer, and answers with its path, its document and its candidates.
#[tauri::command]
pub async fn read_recovery(app: AppHandle, token: String, id: String) -> ReadAnswer {
    let Some(recovery) = recovery(&app) else {
        return ReadAnswer::execution_failed();
    };
    tauri::async_runtime::spawn_blocking(move || recovery.read_offer(&token, &id))
        .await
        .unwrap_or_else(|_| ReadAnswer::execution_failed())
}

/// Removes one offer.
#[tauri::command]
pub async fn discard_recovery(app: AppHandle, token: String, id: String) -> DiscardAnswer {
    let Some(recovery) = recovery(&app) else {
        return DiscardAnswer::execution_failed();
    };
    tauri::async_runtime::spawn_blocking(move || recovery.discard_offer(&token, &id))
        .await
        .unwrap_or_else(|_| DiscardAnswer::execution_failed())
}

/// The `state` argument of `finish_restore`, as the page sent it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RestoreArgument {
    /// The page sent no `state`. The core never sees this as "nothing".
    Missing,
    /// The page sent `state: null`: nothing to recover.
    Nothing,
    /// The page sent another value. The core reads it as `{ projectPath, project }`, and
    /// refuses each other shape.
    Work(serde_json::Value),
}

/// Reads the `state` argument from the arguments of the call. A typed argument cannot do it:
/// Tauri gives `None` both for a missing key and for null, and one wrong call of the page would
/// then remove `current.json` and the offer, both copies of the work.
pub(crate) fn restore_argument(arguments: Option<&serde_json::Value>) -> RestoreArgument {
    match arguments.and_then(|arguments| arguments.get("state")) {
        None => RestoreArgument::Missing,
        Some(serde_json::Value::Null) => RestoreArgument::Nothing,
        Some(value) => RestoreArgument::Work(value.clone()),
    }
}

/// Runs `finish_restore` for a decoded argument. A missing argument changes no file and keeps
/// the offer.
pub(crate) fn finish_restore_with(
    recovery: &Recovery,
    token: &str,
    id: &str,
    argument: RestoreArgument,
) -> ChangeAnswer {
    match argument {
        RestoreArgument::Missing => ChangeAnswer::missing_restore_state(recovery.is_owner()),
        RestoreArgument::Nothing => recovery.finish_restore(token, id, None),
        RestoreArgument::Work(value) => recovery.finish_restore(token, id, Some(value)),
    }
}

/// Writes `current.json` from `state`, or removes it when `state` is null, and then removes the
/// offer `id`. `state` is required: the command reads it from the request itself (see
/// [`restore_argument`]).
///
/// Tauri requires a `Result` from an async command that borrows its request. The command
/// never answers `Err`: each failure is in the answer.
#[tauri::command]
pub async fn finish_restore(
    app: AppHandle,
    token: String,
    id: String,
    request: tauri::ipc::Request<'_>,
) -> Result<ChangeAnswer, RecoveryError> {
    let arguments = match request.body() {
        tauri::ipc::InvokeBody::Json(arguments) => Some(arguments),
        tauri::ipc::InvokeBody::Raw(_) => None,
    };
    let argument = restore_argument(arguments);
    let Some(recovery) = recovery(&app) else {
        return Ok(ChangeAnswer::execution_failed());
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        finish_restore_with(&recovery, &token, &id, argument)
    })
    .await
    .unwrap_or_else(|_| ChangeAnswer::execution_failed()))
}

/// The end of the recovery for `confirm_quit` (ADR 073). With the token of the session, it ends
/// the recovery at once, and a worker thread removes `current.json` of the session. The caller
/// waits for the worker for `recovery::END_BUDGET` at most, so the main thread is held for one
/// second at most. With no token, another token, or no managed recovery, it does nothing.
pub fn end_recovery(app: &AppHandle, token: Option<&str>) {
    let Some(recovery) = recovery(app) else {
        return;
    };
    // No output here: this is the thread of the quit, and a write to a standard error stream
    // that is a full pipe can block it. The worker writes the line for an outcome that it knows.
    let _ = recovery.end(token);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::{CurrentFile, RecoveryErrorCode, RecoveryStatus};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-recovery-command-test-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn project_value() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "sources": [{
                "id": "s1",
                "path": "/clips/clip.mp4",
                "size": 100,
                "mtime": 1_700_000_000,
                "videoStreamIndex": 0,
                "videoTimeBase": { "n": 1, "d": 90_000 },
                "videoStartPts": "0",
                "videoEndPts": "900000",
                "videoDurationTicks": "900000",
                "approximateDurationSeconds": 10.0,
                "avgFrameRate": { "n": 30, "d": 1 },
                "rFrameRate": { "n": 30, "d": 1 },
                "reportedFrameCount": "300"
            }],
            "clips": [{ "id": "c1", "sourceId": "s1" }],
            "segments": [{
                "id": "g1", "inClipId": "c1", "inPts": "10", "outClipId": "c1", "outPts": "20"
            }]
        })
    }

    const ID: &str = "0123456789abcdef";

    /// A recovery whose session wrote `current.json`, beside one offer. Answers the paths of
    /// the two files and the token.
    fn written_with_offer(directory: &TestDirectory) -> (Recovery, String, PathBuf, PathBuf) {
        let recovery = Recovery::new(Some(directory.path.join("recovery")));
        let token = recovery.start().token;
        assert_eq!(
            recovery.write(&token, None, project_value()).current,
            CurrentFile::Written
        );
        let current = directory.path.join("recovery").join("current.json");
        let offer = directory
            .path
            .join("recovery")
            .join(format!("offer-{ID}.json"));
        fs::copy(&current, &offer).unwrap();
        (recovery, token, current, offer)
    }

    #[test]
    fn the_state_argument_is_read_from_the_arguments_of_the_call() {
        let arguments = json!({ "token": "1", "id": ID });
        assert_eq!(restore_argument(Some(&arguments)), RestoreArgument::Missing);
        assert_eq!(restore_argument(None), RestoreArgument::Missing);
        let arguments = json!({ "token": "1", "id": ID, "state": null });
        assert_eq!(restore_argument(Some(&arguments)), RestoreArgument::Nothing);
        let state = json!({ "projectPath": null, "project": project_value() });
        let arguments = json!({ "token": "1", "id": ID, "state": state.clone() });
        assert_eq!(
            restore_argument(Some(&arguments)),
            RestoreArgument::Work(state)
        );
        let arguments = json!({ "state": {} });
        assert_eq!(
            restore_argument(Some(&arguments)),
            RestoreArgument::Work(json!({}))
        );
    }

    #[test]
    fn a_missing_state_changes_no_file_and_keeps_the_offer() {
        let directory = TestDirectory::new();
        let (recovery, token, current, offer) = written_with_offer(&directory);
        let before = fs::read(&current).unwrap();

        let answer = finish_restore_with(
            &recovery,
            &token,
            ID,
            restore_argument(Some(&json!({ "token": token, "id": ID }))),
        );
        // The write made this process the owner.
        assert!(answer.owner);
        assert_eq!(answer.status, RecoveryStatus::Failed);
        assert_eq!(answer.current, CurrentFile::NotKnown);
        assert_eq!(
            answer.error.unwrap().code,
            RecoveryErrorCode::MissingRestoreState
        );
        assert_eq!(fs::read(&current).unwrap(), before);
        assert!(offer.is_file());

        // A second process on the same directory is not the owner, and the answer says so.
        let second = Recovery::new(Some(directory.path.join("recovery")));
        let second_token = second.start().token;
        let answer = finish_restore_with(&second, &second_token, ID, RestoreArgument::Missing);
        assert!(!answer.owner);
        assert_eq!(answer.status, RecoveryStatus::Failed);
        assert_eq!(
            answer.error.unwrap().code,
            RecoveryErrorCode::MissingRestoreState
        );
        assert!(
            !second.is_owner(),
            "the answer made no try to take the lock"
        );
        assert_eq!(fs::read(&current).unwrap(), before);
        assert!(offer.is_file());
    }

    #[test]
    fn an_explicit_null_removes_the_file_and_then_the_offer() {
        let directory = TestDirectory::new();
        let (recovery, token, current, offer) = written_with_offer(&directory);
        let answer = finish_restore_with(
            &recovery,
            &token,
            ID,
            restore_argument(Some(&json!({ "token": token, "id": ID, "state": null }))),
        );
        assert_eq!(answer.status, RecoveryStatus::Done);
        assert_eq!(answer.current, CurrentFile::Nothing);
        assert!(!current.exists());
        assert!(!offer.exists());
    }

    #[test]
    fn a_state_of_a_wrong_shape_is_refused_and_keeps_the_offer() {
        let directory = TestDirectory::new();
        let (recovery, token, current, offer) = written_with_offer(&directory);
        let answer = finish_restore_with(
            &recovery,
            &token,
            ID,
            restore_argument(Some(
                &json!({ "token": token, "id": ID, "state": { "projectPath": null } }),
            )),
        );
        assert_eq!(answer.status, RecoveryStatus::Refused);
        assert_eq!(answer.current, CurrentFile::Nothing);
        assert!(!current.exists());
        assert!(offer.is_file());
    }

    #[test]
    fn a_state_writes_the_file_and_then_removes_the_offer() {
        let directory = TestDirectory::new();
        let (recovery, token, current, offer) = written_with_offer(&directory);
        let state = json!({ "projectPath": "/cut.qcproj", "project": project_value() });
        let answer = finish_restore_with(
            &recovery,
            &token,
            ID,
            restore_argument(Some(&json!({ "token": token, "id": ID, "state": state }))),
        );
        assert_eq!(answer.status, RecoveryStatus::Done);
        assert_eq!(answer.current, CurrentFile::Written);
        assert!(current.is_file());
        assert!(!offer.exists());
    }
}
