//! Tauri commands for the test of a preset on this machine.
//!
//! `test_preset` runs the test of [`crate::ffmpeg::capabilities::preset_test`] for one preset
//! object, which the Settings window sends as the draft in its editor, saved or not, and the
//! export setup of the main window sends as the selected preset. Rust validates the preset with
//! the validation of a saved preset first, so the editor cannot test a preset it could not save.
//! `preset_test_results` reads the stored results for the presets of the settings document, on
//! the binary that discovery finds now.
//!
//! The test runs under the smoke-test lock of ADR 006, and never while an export runs (ADR 016):
//! the two would compete for the encoder, and a test that competed reports a working preset as
//! broken. A test that an export overlapped still reaches the window that asked, and it is not
//! stored. A result is information only: an export never reads it.
//!
//! Each stored result also reaches every window as [`PRESET_TESTED_EVENT`], so the window that
//! did not ask reads the stored results again.
//!
//! [`PresetTestErrorCode`] is a pinned contract, mirrored by `src/features/settings/presetTest.ts`,
//! as `commands::settings` pins its own codes.

use crate::ffmpeg::capabilities::cache::{self, CacheKey};
use crate::ffmpeg::capabilities::preset_test::{
    self, build_test_arguments, classify_test, EncoderTurn, PresetTestResult, OUTPUT_PLACEHOLDER,
    PRESET_TEST_TIMEOUT,
};
use crate::ffmpeg::capabilities::{
    parse_version, preset_test_cache, run_with_timeout, CommandOutcome, CommandStatus,
    StdoutCapture,
};
use crate::ffmpeg::export::ExportRegistry;
use crate::ffmpeg::{self, FfmpegPaths, LocateError};
use crate::settings::{
    self, LoadedSettings, Preset, Settings, SettingsFileError, CURRENT_SCHEMA_VERSION,
};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// The event that announces a stored result, with the label of the window whose test stored
/// it. Its payload is [`PresetTested`].
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.PRESET_TESTED`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const PRESET_TESTED_EVENT: &str = "ffmpeg:preset-tested";

/// The payload of [`PRESET_TESTED_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetTested<'a> {
    /// The label of the window that ran the test.
    pub origin: &'a str,
}

// Defines `PresetTestErrorCode` and, for tests only, `ALL_ERROR_CODES`, from one list, as
// `commands::settings::settings_error_codes!` does and for the same reason.
macro_rules! preset_test_error_codes {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        /// Stable error names the frontend mirrors exactly. See the module doc comment.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub enum PresetTestErrorCode {
            $($variant),+
        }

        /// Every [`PresetTestErrorCode`] variant. Test-only.
        #[cfg(test)]
        const ALL_ERROR_CODES: &[PresetTestErrorCode] = &[$(PresetTestErrorCode::$variant),+];
    };
}

preset_test_error_codes! {
    AppDataUnavailable => "appDataUnavailable",
    InvalidPreset => "invalidPreset",
    ExportRunning => "exportRunning",
    FfmpegPairMissing => "ffmpegPairMissing",
    FfmpegSpawnFailed => "ffmpegSpawnFailed",
    TemporaryFileUnavailable => "temporaryFileUnavailable",
    SettingsUnreadable => "settingsUnreadable",
    CommandExecutionFailed => "commandExecutionFailed",
}

/// A command error with a stable code and an optional untranslated diagnostic (ADR 011).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetTestError {
    pub code: PresetTestErrorCode,
    /// The validation message of an invalid preset, or the operating-system message of a
    /// failed file or process operation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PresetTestError {
    fn new(code: PresetTestErrorCode) -> Self {
        Self { code, detail: None }
    }

    fn with_detail(code: PresetTestErrorCode, detail: impl ToString) -> Self {
        Self {
            code,
            detail: Some(detail.to_string()),
        }
    }
}

/// The stored result of one preset of the settings document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetTestEntry {
    pub preset_id: String,
    pub result: PresetTestResult,
}

/// The result of [`preset_test_results`]: one entry for each preset of the settings document
/// with a stored result on the current binary, in the order of the document. A preset with no
/// stored result has no entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetTestResults {
    pub results: Vec<PresetTestEntry>,
}

/// Test `preset` on this machine, store the result for the current binary, and return it.
///
/// The work runs on the blocking pool: it can wait for the smoke-test lock behind a capability
/// probe, and then runs one process of at most [`PRESET_TEST_TIMEOUT`].
#[tauri::command]
pub async fn test_preset(
    app: AppHandle,
    window: WebviewWindow,
    registry: tauri::State<'_, Arc<ExportRegistry>>,
    preset: Preset,
) -> Result<PresetTestResult, PresetTestError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| PresetTestError::new(PresetTestErrorCode::AppDataUnavailable))?;
    let temporary_directory = app.path().app_cache_dir().map_err(|error| {
        PresetTestError::with_detail(PresetTestErrorCode::TemporaryFileUnavailable, error)
    })?;
    let registry = Arc::clone(&registry);

    let run = tauri::async_runtime::spawn_blocking(move || {
        test_preset_with(
            &preset,
            TestDirectories {
                app_data: &app_data_directory,
                temporary: &temporary_directory,
            },
            &registry,
            discover_for_test,
            cache_key_of,
            |turn, ffmpeg, arguments, output| {
                preset_test::run_test_command(turn, ffmpeg, arguments, output, PRESET_TEST_TIMEOUT)
            },
            current_unix_seconds,
        )
    })
    .await
    .map_err(|_| PresetTestError::new(PresetTestErrorCode::CommandExecutionFailed))??;

    if run.stored {
        // A failed emit means that no other window listens, and the result already reaches
        // this one.
        let _ = app.emit(
            PRESET_TESTED_EVENT,
            PresetTested {
                origin: window.label(),
            },
        );
    }
    Ok(run.result)
}

/// Read the stored results for the presets of the settings document, on the binary that
/// discovery finds now.
#[tauri::command]
pub async fn preset_test_results(app: AppHandle) -> Result<PresetTestResults, PresetTestError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| PresetTestError::new(PresetTestErrorCode::AppDataUnavailable))?;
    tauri::async_runtime::spawn_blocking(move || {
        preset_test_results_with(
            &app_data_directory,
            settings::load,
            discover_for_test,
            cache_key_of,
        )
    })
    .await
    .map_err(|_| PresetTestError::new(PresetTestErrorCode::CommandExecutionFailed))?
}

/// The two directories a test uses: the application data directory, which holds the settings
/// and the cache file, and the directory that holds the output of the test while it runs.
#[derive(Debug, Clone, Copy)]
struct TestDirectories<'a> {
    app_data: &'a Path,
    temporary: &'a Path,
}

/// The result of [`test_preset_with`], and whether the cache now holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PresetTestRun {
    result: PresetTestResult,
    stored: bool,
}

/// The body of [`test_preset`], with every step that reaches outside the process injected:
/// executable discovery, the cache key of the binary, the run of the command, and the clock.
///
/// The order is the order of the checks the result depends on:
///
/// 1. The preset passes the validation of a saved preset, inside a document of its own.
/// 2. No export runs. Discovery and the lock wait come after this, so a refusal costs nothing.
/// 3. Discovery finds ffmpeg, and the cache key of the binary is read. A binary with no key
///    still runs the test; its result is not stored.
/// 4. The test waits for the smoke-test lock, and checks again that no export runs, because an
///    export can begin during the wait. It reads the count of begun exports under the lock.
/// 5. The command runs, and its output is deleted.
/// 6. The result is stored only when the count of begun exports did not move, so a test that
///    an export overlapped, even a short export that also ended, is not stored.
fn test_preset_with<Discover, KeyOf, Run, Now>(
    preset: &Preset,
    directories: TestDirectories<'_>,
    registry: &ExportRegistry,
    discover: Discover,
    key_of: KeyOf,
    run: Run,
    now: Now,
) -> Result<PresetTestRun, PresetTestError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    KeyOf: FnOnce(&Path) -> Option<CacheKey>,
    Run: FnOnce(&EncoderTurn, &Path, &[String], &Path) -> io::Result<CommandOutcome>,
    Now: FnOnce() -> i64,
{
    validate_preset(preset)?;
    if registry.active_run_id().is_some() {
        return Err(PresetTestError::new(PresetTestErrorCode::ExportRunning));
    }

    let paths = discover(directories.app_data)
        .map_err(|_| PresetTestError::new(PresetTestErrorCode::FfmpegPairMissing))?;
    let key = key_of(&paths.ffmpeg);

    fs::create_dir_all(directories.temporary).map_err(|error| {
        PresetTestError::with_detail(PresetTestErrorCode::TemporaryFileUnavailable, error)
    })?;
    let output = preset_test::test_output_path(directories.temporary);
    let key_arguments = build_test_arguments(preset, OUTPUT_PLACEHOLDER);
    let arguments = build_test_arguments(preset, &output.to_string_lossy());

    let turn = preset_test::wait_for_encoder_turn();
    let begun = registry.begun_count();
    if registry.active_run_id().is_some() {
        return Err(PresetTestError::new(PresetTestErrorCode::ExportRunning));
    }
    let outcome = run(&turn, &paths.ffmpeg, &arguments, &output).map_err(|error| {
        PresetTestError::with_detail(PresetTestErrorCode::FfmpegSpawnFailed, error)
    })?;
    let result = classify_test(&outcome, now());
    let overlapped = registry.begun_count() != begun;
    drop(turn);

    // A failed write is not a failed test: the result still reaches the window that asked.
    let stored = match key {
        Some(key) if !overlapped => {
            preset_test_cache::write(directories.app_data, &key, &key_arguments, &result).is_ok()
        }
        _ => false,
    };
    Ok(PresetTestRun { result, stored })
}

/// The body of [`preset_test_results`], with the settings read, discovery and the cache key
/// injected.
///
/// A binary with no cache key has no stored results, so the answer is empty, as for a cache file
/// that is missing or damaged.
fn preset_test_results_with<Load, Discover, KeyOf>(
    app_data_directory: &Path,
    load: Load,
    discover: Discover,
    key_of: KeyOf,
) -> Result<PresetTestResults, PresetTestError>
where
    Load: FnOnce(&Path) -> Result<LoadedSettings, SettingsFileError>,
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    KeyOf: FnOnce(&Path) -> Option<CacheKey>,
{
    let loaded = load(app_data_directory)
        .map_err(|_| PresetTestError::new(PresetTestErrorCode::SettingsUnreadable))?;
    let paths = discover(app_data_directory)
        .map_err(|_| PresetTestError::new(PresetTestErrorCode::FfmpegPairMissing))?;
    let Some(key) = key_of(&paths.ffmpeg) else {
        return Ok(PresetTestResults { results: vec![] });
    };

    let stored = preset_test_cache::read_all(app_data_directory, &key);
    let results = loaded
        .settings
        .presets
        .iter()
        .filter_map(|preset| {
            let arguments = build_test_arguments(preset, OUTPUT_PLACEHOLDER);
            stored
                .iter()
                .find(|(stored_arguments, _)| *stored_arguments == arguments)
                .map(|(_, result)| PresetTestEntry {
                    preset_id: preset.id.clone(),
                    result: result.clone(),
                })
        })
        .collect();
    Ok(PresetTestResults { results })
}

/// Check `preset` with [`settings::validate_settings`], in a document that holds it alone, so
/// a preset the editor could not save is not tested either.
fn validate_preset(preset: &Preset) -> Result<(), PresetTestError> {
    let document = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        revision: 0,
        ffmpeg_path: None,
        presets: vec![preset.clone()],
        active_preset_id: None,
    };
    settings::validate_settings(&document)
        .map_err(|error| PresetTestError::with_detail(PresetTestErrorCode::InvalidPreset, error))
}

/// Resolve ffmpeg in the order of ADR 005, with the configured path of the settings first, as
/// the capability probe and the export do.
fn discover_for_test(app_data_directory: &Path) -> Result<FfmpegPaths, LocateError> {
    let configured = settings::configured_ffmpeg_path(app_data_directory);
    ffmpeg::discover(configured.as_deref(), app_data_directory)
}

/// The cache key of the binary that [`cache_key_of`] read last.
///
/// The key needs the version string, which costs one `ffmpeg -version` process. The Settings
/// window and the export setup read the stored results often, so the key of the last binary is
/// kept, and a binary with the same path, size and modification time reuses its version. A
/// different binary changes one of the three, which is the rule of the ADR 006 key itself.
static CACHE_KEY_MEMO: Mutex<Option<CacheKey>> = Mutex::new(None);

/// The deadline for the `-version` process of [`read_version`], as for a listing of the
/// capability probe.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// How often [`read_version`] polls its process.
const VERSION_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The ADR 006 cache key of `ffmpeg`, or `None` when the binary has no metadata or no version.
fn cache_key_of(ffmpeg: &Path) -> Option<CacheKey> {
    cache_key_with(ffmpeg, &CACHE_KEY_MEMO, read_version)
}

/// [`cache_key_of`] with the memo and the version read supplied, so a test can count the reads.
fn cache_key_with<ReadVersion>(
    ffmpeg: &Path,
    memo: &Mutex<Option<CacheKey>>,
    read_version: ReadVersion,
) -> Option<CacheKey>
where
    ReadVersion: FnOnce(&Path) -> Option<String>,
{
    // The fingerprint with no version: the path, the size and the modification time as they
    // are now.
    let current = cache::fingerprint(ffmpeg, "").ok()?;
    let same_binary = |known: &CacheKey| {
        known.ffmpeg_path == current.ffmpeg_path
            && known.size == current.size
            && known.mtime == current.mtime
    };
    {
        let known = memo
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(known) = known.as_ref().filter(|known| same_binary(known)) {
            return Some(known.clone());
        }
    }
    // Read without the lock, so a slow binary does not hold up a reader of another one.
    let key = CacheKey {
        version: read_version(ffmpeg)?,
        ..current
    };
    *memo
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(key.clone());
    Some(key)
}

/// The version string of `ffmpeg -version`, or `None` when the process fails or prints no
/// version line.
fn read_version(ffmpeg: &Path) -> Option<String> {
    let outcome = run_with_timeout(
        ffmpeg,
        &["-version".to_owned()],
        VERSION_TIMEOUT,
        VERSION_POLL_INTERVAL,
        StdoutCapture::Capture,
    )
    .ok()?;
    if !matches!(outcome.status, CommandStatus::Exited { success: true, .. }) {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&outcome.stdout)).map(|info| info.version)
}

/// Whole seconds since the Unix epoch, with a floor of 1, as for the `probedAt` of a capability
/// report: the interface refuses a time of 0.
fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(1)
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::capabilities::preset_test::PresetTestStatus;
    use crate::ffmpeg::ExecutableOrigin;
    use crate::settings::defaults::every_platform_seed;
    use std::cell::Cell;
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
                "quipclip-preset-test-command-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn app_data(&self) -> PathBuf {
            self.path.join("app-data")
        }

        fn temporary(&self) -> PathBuf {
            self.path.join("cache")
        }

        fn directories(&self) -> (PathBuf, PathBuf) {
            (self.app_data(), self.temporary())
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn seed(id: &str) -> Preset {
        every_platform_seed()
            .into_iter()
            .find(|preset| preset.id == id)
            .unwrap()
    }

    fn found(directory: &TestDirectory) -> impl FnOnce(&Path) -> Result<FfmpegPaths, LocateError> {
        let ffmpeg = directory.path.join("ffmpeg");
        move |_: &Path| {
            Ok(FfmpegPaths {
                ffmpeg: ffmpeg.clone(),
                ffprobe: ffmpeg.with_file_name("ffprobe"),
                origin: ExecutableOrigin::Path,
            })
        }
    }

    fn not_found(_: &Path) -> Result<FfmpegPaths, LocateError> {
        Err(LocateError::NotFound { inspected: vec![] })
    }

    fn key() -> CacheKey {
        CacheKey {
            ffmpeg_path: "/opt/homebrew/bin/ffmpeg".to_owned(),
            version: "9.0.2".to_owned(),
            size: 1_000,
            mtime: 1_700_000_000,
        }
    }

    fn exited(code: i32, stderr: &str) -> CommandOutcome {
        CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(code),
                success: code == 0,
            },
            stderr: stderr.as_bytes().to_vec(),
            stdout: Vec::new(),
        }
    }

    const NOW: i64 = 1_790_000_000;

    #[test]
    fn every_error_code_serializes_to_its_stable_camel_case_string() {
        let serialized: Vec<String> = ALL_ERROR_CODES
            .iter()
            .map(|code| {
                serde_json::to_value(code)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(
            serialized,
            vec![
                "appDataUnavailable",
                "invalidPreset",
                "exportRunning",
                "ffmpegPairMissing",
                "ffmpegSpawnFailed",
                "temporaryFileUnavailable",
                "settingsUnreadable",
                "commandExecutionFailed",
            ]
        );
    }

    #[test]
    fn the_wire_shapes_are_camel_case_and_omit_an_absent_detail() {
        assert_eq!(
            serde_json::to_value(PresetTestError::new(PresetTestErrorCode::ExportRunning)).unwrap(),
            serde_json::json!({ "code": "exportRunning" })
        );
        assert_eq!(
            serde_json::to_value(PresetTestResults {
                results: vec![PresetTestEntry {
                    preset_id: "default-h264-mp4".to_owned(),
                    result: PresetTestResult {
                        status: PresetTestStatus::Passed,
                        line: None,
                        exit_code: None,
                        tested_at: NOW,
                    },
                }],
            })
            .unwrap(),
            serde_json::json!({
                "results": [{
                    "presetId": "default-h264-mp4",
                    "result": { "status": "passed", "testedAt": NOW },
                }],
            })
        );
        assert_eq!(
            serde_json::to_value(PresetTested { origin: "settings" }).unwrap(),
            serde_json::json!({ "origin": "settings" })
        );
    }

    #[test]
    fn a_test_runs_the_command_of_the_preset_against_a_fresh_output_and_stores_the_result() {
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());
        let preset = seed("default-h264-mp4");
        let ran_with = Cell::new(None);

        let run = test_preset_with(
            &preset,
            TestDirectories {
                app_data: &app_data,
                temporary: &temporary,
            },
            &registry,
            found(&directory),
            |_| Some(key()),
            |_, ffmpeg: &Path, arguments: &[String], output: &Path| {
                ran_with.set(Some((
                    ffmpeg.to_path_buf(),
                    arguments.to_vec(),
                    output.to_path_buf(),
                )));
                Ok(exited(0, ""))
            },
            || NOW,
        )
        .unwrap();

        assert_eq!(
            run,
            PresetTestRun {
                result: PresetTestResult {
                    status: PresetTestStatus::Passed,
                    line: None,
                    exit_code: None,
                    tested_at: NOW,
                },
                stored: true,
            }
        );
        let (ffmpeg, arguments, output) = ran_with.take().expect("the command ran");
        assert_eq!(ffmpeg, directory.path.join("ffmpeg"));
        assert_eq!(output.parent(), Some(temporary.as_path()));
        let mut expected = build_test_arguments(&preset, OUTPUT_PLACEHOLDER);
        *expected.last_mut().unwrap() = output.to_string_lossy().into_owned();
        assert_eq!(arguments, expected);
        // The key holds the placeholder, not the output of this one run.
        assert_eq!(
            preset_test_cache::read(
                &app_data,
                &key(),
                &build_test_arguments(&preset, OUTPUT_PLACEHOLDER)
            ),
            Some(run.result)
        );
    }

    #[test]
    fn a_test_is_refused_while_an_export_runs_and_reaches_nothing() {
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());
        let _export = registry.begin("export-1").unwrap();

        let error = test_preset_with(
            &seed("default-h264-mp4"),
            TestDirectories {
                app_data: &app_data,
                temporary: &temporary,
            },
            &registry,
            |_: &Path| -> Result<FfmpegPaths, LocateError> {
                panic!("a refused test must not discover ffmpeg")
            },
            |_| panic!("a refused test must not read the version"),
            |_, _: &Path, _: &[String], _: &Path| panic!("a refused test must not run"),
            || NOW,
        )
        .unwrap_err();

        assert_eq!(error.code, PresetTestErrorCode::ExportRunning);
        assert!(!temporary.exists());
        assert!(!app_data
            .join(preset_test_cache::PRESET_TEST_CACHE_FILE_NAME)
            .exists());
    }

    #[test]
    fn a_test_that_an_export_overlapped_reaches_the_caller_and_is_not_stored() {
        // The export begins and ends inside the test, so the slot is free again afterwards; only
        // the count of begun exports shows it.
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());
        let preset = seed("default-h264-mp4");

        let run = test_preset_with(
            &preset,
            TestDirectories {
                app_data: &app_data,
                temporary: &temporary,
            },
            &registry,
            found(&directory),
            |_| Some(key()),
            |_, _: &Path, _: &[String], _: &Path| {
                drop(registry.begin("short-export").unwrap());
                Ok(exited(1, "[h264_videotoolbox @ 0x1] [error] busy\n"))
            },
            || NOW,
        )
        .unwrap();

        assert_eq!(run.result.status, PresetTestStatus::Failed);
        assert!(!run.stored);
        assert_eq!(
            preset_test_cache::read(
                &app_data,
                &key(),
                &build_test_arguments(&preset, OUTPUT_PLACEHOLDER)
            ),
            None
        );
    }

    #[test]
    fn a_preset_the_editor_could_not_save_is_not_tested() {
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());
        let mut preset = seed("default-h264-mp4");
        preset.pixel_format = "yuv420p,scale=1:1".to_owned();

        let error = test_preset_with(
            &preset,
            TestDirectories {
                app_data: &app_data,
                temporary: &temporary,
            },
            &registry,
            found(&directory),
            |_| Some(key()),
            |_, _: &Path, _: &[String], _: &Path| panic!("an invalid preset must not run"),
            || NOW,
        )
        .unwrap_err();

        assert_eq!(error.code, PresetTestErrorCode::InvalidPreset);
        assert_eq!(
            error.detail.as_deref(),
            Some("presets[0].pixelFormat is not a valid pixel format name")
        );
    }

    #[test]
    fn a_missing_ffmpeg_and_a_binary_that_cannot_start_are_errors_and_store_nothing() {
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());
        let directories = TestDirectories {
            app_data: &app_data,
            temporary: &temporary,
        };

        let missing = test_preset_with(
            &seed("default-h264-mp4"),
            directories,
            &registry,
            not_found,
            |_| Some(key()),
            |_, _: &Path, _: &[String], _: &Path| panic!("nothing to run"),
            || NOW,
        )
        .unwrap_err();
        assert_eq!(missing.code, PresetTestErrorCode::FfmpegPairMissing);

        let spawn = test_preset_with(
            &seed("default-h264-mp4"),
            directories,
            &registry,
            found(&directory),
            |_| Some(key()),
            |_, _: &Path, _: &[String], _: &Path| {
                Err(io::Error::new(io::ErrorKind::NotFound, "no such file"))
            },
            || NOW,
        )
        .unwrap_err();
        assert_eq!(spawn.code, PresetTestErrorCode::FfmpegSpawnFailed);
        assert_eq!(spawn.detail.as_deref(), Some("no such file"));
        assert!(!app_data
            .join(preset_test_cache::PRESET_TEST_CACHE_FILE_NAME)
            .exists());
    }

    #[test]
    fn a_binary_with_no_cache_key_still_tests_and_stores_nothing() {
        let directory = TestDirectory::new();
        let (app_data, temporary) = directory.directories();
        let registry = Arc::new(ExportRegistry::default());

        let run = test_preset_with(
            &seed("default-av1-mp4"),
            TestDirectories {
                app_data: &app_data,
                temporary: &temporary,
            },
            &registry,
            found(&directory),
            |_| None,
            |_, _: &Path, _: &[String], _: &Path| Ok(exited(0, "")),
            || NOW,
        )
        .unwrap();

        assert_eq!(run.result.status, PresetTestStatus::Passed);
        assert!(!run.stored);
    }

    fn loaded(presets: Vec<Preset>) -> Result<LoadedSettings, SettingsFileError> {
        Ok(LoadedSettings {
            settings: Settings {
                schema_version: CURRENT_SCHEMA_VERSION,
                revision: 3,
                ffmpeg_path: None,
                presets,
                active_preset_id: None,
            },
            seeded: false,
        })
    }

    #[test]
    fn the_stored_results_name_each_preset_whose_test_command_has_one() {
        let directory = TestDirectory::new();
        let app_data = directory.app_data();
        let h264 = seed("default-h264-mp4");
        let av1 = seed("default-av1-mp4");
        // A copy with another id and name runs the same command, so it shares the result.
        let mut renamed = h264.clone();
        renamed.id = "copy".to_owned();
        renamed.name = "My copy".to_owned();
        // A copy with another option runs another command, so it has no result.
        let mut tuned = h264.clone();
        tuned.id = "tuned".to_owned();
        tuned.video_options[0].value = "veryslow".to_owned();

        let warned = PresetTestResult {
            status: PresetTestStatus::PassedWithWarnings,
            line: Some("[warning] x".to_owned()),
            exit_code: None,
            tested_at: NOW,
        };
        preset_test_cache::write(
            &app_data,
            &key(),
            &build_test_arguments(&h264, OUTPUT_PLACEHOLDER),
            &warned,
        )
        .unwrap();

        let results = preset_test_results_with(
            &app_data,
            |_| loaded(vec![av1, h264.clone(), renamed, tuned]),
            found(&directory),
            |_| Some(key()),
        )
        .unwrap();

        assert_eq!(
            results,
            PresetTestResults {
                results: vec![
                    PresetTestEntry {
                        preset_id: "default-h264-mp4".to_owned(),
                        result: warned.clone(),
                    },
                    PresetTestEntry {
                        preset_id: "copy".to_owned(),
                        result: warned,
                    },
                ],
            }
        );

        // Another binary has no results at all.
        let mut other = key();
        other.version = "8.0".to_owned();
        let results = preset_test_results_with(
            &app_data,
            |_| loaded(vec![h264]),
            found(&directory),
            move |_| Some(other),
        )
        .unwrap();
        assert!(results.results.is_empty());
    }

    #[test]
    fn the_stored_results_report_an_unreadable_document_and_a_missing_ffmpeg() {
        let directory = TestDirectory::new();
        let app_data = directory.app_data();

        let unreadable = preset_test_results_with(
            &app_data,
            |_| Err(SettingsFileError::Io(io::Error::other("damaged"))),
            found(&directory),
            |_| Some(key()),
        )
        .unwrap_err();
        assert_eq!(unreadable.code, PresetTestErrorCode::SettingsUnreadable);

        let missing =
            preset_test_results_with(&app_data, |_| loaded(vec![]), not_found, |_| Some(key()))
                .unwrap_err();
        assert_eq!(missing.code, PresetTestErrorCode::FfmpegPairMissing);

        let no_key = preset_test_results_with(
            &app_data,
            |_| loaded(vec![seed("default-h264-mp4")]),
            found(&directory),
            |_| None,
        )
        .unwrap();
        assert!(no_key.results.is_empty());
    }

    #[test]
    fn the_cache_key_reads_the_version_once_for_one_binary_and_again_after_a_change() {
        let directory = TestDirectory::new();
        let ffmpeg = directory.path.join("ffmpeg");
        fs::write(&ffmpeg, b"one binary").unwrap();
        let memo = Mutex::new(None);
        let reads = Cell::new(0);
        let read = |_: &Path| {
            reads.set(reads.get() + 1);
            Some("9.0.2".to_owned())
        };

        let first = cache_key_with(&ffmpeg, &memo, read).unwrap();
        let second = cache_key_with(&ffmpeg, &memo, read).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.version, "9.0.2");
        assert_eq!(first, cache::fingerprint(&ffmpeg, "9.0.2").unwrap());
        assert_eq!(reads.get(), 1);

        // A binary of another size is another binary.
        fs::write(&ffmpeg, b"another, longer binary").unwrap();
        let third = cache_key_with(&ffmpeg, &memo, read).unwrap();
        assert_eq!(reads.get(), 2);
        assert_ne!(third.size, first.size);
    }

    #[test]
    fn a_binary_with_no_version_or_no_metadata_has_no_cache_key() {
        let directory = TestDirectory::new();
        let ffmpeg = directory.path.join("ffmpeg");
        let memo = Mutex::new(None);
        assert_eq!(
            cache_key_with(&ffmpeg, &memo, |_| panic!(
                "no metadata, so no version read"
            )),
            None
        );
        fs::write(&ffmpeg, b"a binary").unwrap();
        assert_eq!(cache_key_with(&ffmpeg, &memo, |_| None), None);
        assert_eq!(*memo.lock().unwrap(), None);
    }

    #[test]
    fn read_version_answers_none_for_a_binary_that_prints_no_version() {
        // The test binary stands in for ffmpeg: it refuses `-version` and exits non-zero.
        let program = std::env::current_exe().unwrap();
        assert_eq!(read_version(&program), None);
    }
}
