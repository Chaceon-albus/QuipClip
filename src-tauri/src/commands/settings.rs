//! Tauri commands exposing the ADR 013 application settings file.
//!
//! Each command resolves `app.path().app_data_dir()`, then runs the real work on
//! `spawn_blocking` through an inner `*_with` function that takes the directory directly, so
//! that function -- unlike the command itself -- can be unit-tested with no [`AppHandle`].
//! Every mutating command returns the document [`crate::settings`] actually wrote to disk, so
//! the interface renders what Rust stored rather than what it guessed.
//!
//! [`SettingsCommandErrorCode`] is a pinned contract: `src/features/settings` on the frontend
//! will mirror this exact set of strings. Adding, removing, or renaming a variant without
//! telling the frontend is the silent-runtime-failure class ADR 011 exists to prevent, which is
//! why `every_error_code_serializes_to_its_stable_camel_case_string` below is the most valuable
//! test in this module.

use crate::settings::{self, LoadedSettings, Settings, SettingsFileError, SettingsValidationError};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// A fifth private copy of the JavaScript `Number.MAX_SAFE_INTEGER` bound; see the comment on
// `settings::JAVASCRIPT_MAX_SAFE_INTEGER` for why each of these copies stays local rather than
// being hoisted into one shared constant.
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// Defines `SettingsCommandErrorCode` and, for tests only, `ALL_ERROR_CODES`: an exhaustive
// slice of every variant, generated from the very list that defines the enum. Before this
// macro existed, the enum and the test's own hand-written array of variants were two
// independent lists that happened to agree; nothing forced a variant added to one into the
// other, so the set assertion in
// `every_error_code_serializes_to_its_stable_camel_case_string` never actually caught a
// variant the frontend contract had not been told about. Generating `ALL_ERROR_CODES` from
// this same invocation closes that gap: a variant added here reaches the enum and the test
// list in the same edit.
macro_rules! settings_error_codes {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        /// Stable error names the frontend mirrors exactly. See the module doc comment.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub enum SettingsCommandErrorCode {
            $($variant),+
        }

        /// Every [`SettingsCommandErrorCode`] variant. Test-only; see
        /// `every_error_code_serializes_to_its_stable_camel_case_string`.
        #[cfg(test)]
        const ALL_ERROR_CODES: &[SettingsCommandErrorCode] = &[$(SettingsCommandErrorCode::$variant),+];
    };
}

settings_error_codes! {
    AppDataUnavailable => "appDataUnavailable",
    ReadFailed => "readFailed",
    PermissionDenied => "permissionDenied",
    WriteFailed => "writeFailed",
    InvalidJson => "invalidJson",
    InvalidSettings => "invalidSettings",
    UnsafeSettingsValue => "unsafeSettingsValue",
    FutureSchemaVersion => "futureSchemaVersion",
    SettingsUnreadable => "settingsUnreadable",
    SettingsConflict => "settingsConflict",
    BackupFailed => "backupFailed",
    InvalidPath => "invalidPath",
    CommandExecutionFailed => "commandExecutionFailed",
}

/// A command error with a stable code and optional untranslated facts.
///
/// No variant ever carries a user-facing English sentence (ADR 011): `detail` holds an
/// operating-system diagnostic only when one exists, `field` and `value` name and quote the
/// offending data, and the schema-version fields carry only numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCommandError {
    pub code: SettingsCommandErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub found_schema_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_schema_version: Option<u32>,
}

impl SettingsCommandError {
    fn new(code: SettingsCommandErrorCode) -> Self {
        Self {
            code,
            detail: None,
            field: None,
            value: None,
            found_schema_version: None,
            supported_schema_version: None,
        }
    }
}

/// The result of [`load_settings`]: the document, and whether it came from the ADR 013 seed
/// table because no settings file exists yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSettingsResult {
    pub settings: Settings,
    pub seeded: bool,
}

impl From<LoadedSettings> for LoadSettingsResult {
    fn from(loaded: LoadedSettings) -> Self {
        Self {
            settings: loaded.settings,
            seeded: loaded.seeded,
        }
    }
}

/// Load the settings document, seeding it in memory when no file exists yet.
#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<LoadSettingsResult, SettingsCommandError> {
    let app_data_directory = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_settings_with(&app_data_directory))
        .await
        .map_err(|_| generated_error(SettingsCommandErrorCode::CommandExecutionFailed))?
}

fn load_settings_with(
    app_data_directory: &Path,
) -> Result<LoadSettingsResult, SettingsCommandError> {
    settings::load(app_data_directory)
        .map(LoadSettingsResult::from)
        .map_err(|error| map_settings_error(error, IoOperation::Read))
}

/// Validate and save `settings`, refusing to overwrite a file this build cannot read back, and
/// return the document that reached disk.
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    settings: Settings,
) -> Result<Settings, SettingsCommandError> {
    let app_data_directory = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_settings_with(&app_data_directory, settings))
        .await
        .map_err(|_| generated_error(SettingsCommandErrorCode::CommandExecutionFailed))?
}

/// The body of [`save_settings`]. `settings::save` writes the document it validates with one
/// change of its own -- it bumps `revision`, the ADR 013 compare-and-swap token -- and returns
/// what it wrote, so this returns that value and never `new_settings`. Returning the input
/// would hand the interface the revision it sent, which is one behind the file on disk, and its
/// very next save would then be refused as a `settingsConflict`.
fn save_settings_with(
    app_data_directory: &Path,
    new_settings: Settings,
) -> Result<Settings, SettingsCommandError> {
    settings::save(app_data_directory, &new_settings)
        .map_err(|error| map_settings_error(error, IoOperation::Write))
}

/// Restore every ADR 013 seed preset over the current library, keeping every other preset,
/// `ffmpegPath`, and `activePresetId` intact, and return the document that reached disk.
#[tauri::command]
pub async fn restore_default_presets(app: AppHandle) -> Result<Settings, SettingsCommandError> {
    let app_data_directory = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || restore_default_presets_with(&app_data_directory))
        .await
        .map_err(|_| generated_error(SettingsCommandErrorCode::CommandExecutionFailed))?
}

fn restore_default_presets_with(
    app_data_directory: &Path,
) -> Result<Settings, SettingsCommandError> {
    // `settings::restore_default_presets` reads the current document through `load` before it
    // ever writes anything, so an unclassified `Io` failure is at least as likely to come from
    // that read as from the write that follows. This has no way to tell which side actually
    // failed -- unlike `reset`, `restore_default_presets` carries no `Backup`-style phase
    // marker -- so `Read` is the deliberate choice: it keeps this consistent with
    // `load_settings_with` for the shared "something occupies the settings file's path"
    // failure both functions can hit.
    settings::restore_default_presets(app_data_directory)
        .map_err(|error| map_settings_error(error, IoOperation::Read))
}

/// Move a damaged settings file aside and write fresh seeds, returning the document that
/// reached disk.
#[tauri::command]
pub async fn reset_settings(app: AppHandle) -> Result<Settings, SettingsCommandError> {
    let app_data_directory = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || reset_settings_with(&app_data_directory))
        .await
        .map_err(|_| generated_error(SettingsCommandErrorCode::CommandExecutionFailed))?
}

fn reset_settings_with(app_data_directory: &Path) -> Result<Settings, SettingsCommandError> {
    settings::reset(app_data_directory).map_err(map_reset_error)
}

/// Resolve the application data directory, or the one generated failure a missing directory
/// produces.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, SettingsCommandError> {
    app.path()
        .app_data_dir()
        .map_err(|_| generated_error(SettingsCommandErrorCode::AppDataUnavailable))
}

fn generated_error(code: SettingsCommandErrorCode) -> SettingsCommandError {
    SettingsCommandError::new(code)
}

/// Which side of the settings file [`map_io_error`] is mapping an [`io::Error`] for. Only the
/// unclassified fallback -- anything that is not `PermissionDenied` -- depends on this:
/// `permissionDenied` is reported the same way for either side.
#[derive(Debug, Clone, Copy)]
enum IoOperation {
    Read,
    Write,
}

fn map_io_error(error: io::Error, operation: IoOperation) -> SettingsCommandError {
    let code = match error.kind() {
        io::ErrorKind::PermissionDenied => SettingsCommandErrorCode::PermissionDenied,
        _ => match operation {
            IoOperation::Read => SettingsCommandErrorCode::ReadFailed,
            IoOperation::Write => SettingsCommandErrorCode::WriteFailed,
        },
    };
    // Only a raw OS error code proves this diagnostic came from the operating system rather
    // than from a synthetic `io::Error` built elsewhere in the process; a synthetic message
    // must never reach the user (ADR 011). This mirrors `commands/project.rs` exactly.
    let detail = error.raw_os_error().map(|_| error.to_string());
    SettingsCommandError {
        detail,
        ..SettingsCommandError::new(code)
    }
}

/// Build a `backupFailed` error from the [`io::Error`] a backup rename raised, keeping the OS
/// diagnostic only when one exists (ADR 011). Shared by [`map_reset_error`], the only real
/// producer of [`SettingsFileError::Backup`], and by [`map_settings_error`]'s defensive arm for
/// the same variant.
fn backup_failed_error(io_error: io::Error) -> SettingsCommandError {
    let detail = io_error.raw_os_error().map(|_| io_error.to_string());
    SettingsCommandError {
        detail,
        ..SettingsCommandError::new(SettingsCommandErrorCode::BackupFailed)
    }
}

/// Map a [`SettingsFileError`] returned by [`settings::load`] or [`settings::save`] (directly,
/// or through [`settings::restore_default_presets`], which calls both).
fn map_settings_error(error: SettingsFileError, operation: IoOperation) -> SettingsCommandError {
    match error {
        SettingsFileError::Io(io_error) => map_io_error(io_error, operation),
        SettingsFileError::Json(_) => {
            // serde's message is dropped deliberately: it is an internal diagnostic, not a
            // user-facing fact, and ADR 011 forbids shipping one across the command boundary.
            SettingsCommandError::new(SettingsCommandErrorCode::InvalidJson)
        }
        SettingsFileError::Validation(validation_error) => map_validation_error(validation_error),
        SettingsFileError::FutureSchemaVersion { found, supported } => {
            map_schema_version(found, supported)
        }
        SettingsFileError::Unreadable => {
            SettingsCommandError::new(SettingsCommandErrorCode::SettingsUnreadable)
        }
        // The two revision numbers are dropped here, the way serde's message is dropped for
        // `Json` just above: they are a Rust-side diagnostic, and the frontend's only recovery
        // is to reload the settings and re-apply the edit, which no number changes.
        SettingsFileError::Conflict { .. } => {
            SettingsCommandError::new(SettingsCommandErrorCode::SettingsConflict)
        }
        // `load`, `save`, and `restore_default_presets` never construct `Backup`: only
        // `settings::reset`'s own rename does, and `map_reset_error` handles that case before
        // ever reaching this function. This arm exists so the match stays exhaustive as the
        // enum evolves; if `Backup` ever did arrive here, `backupFailed` is still the
        // accurate code for it.
        SettingsFileError::Backup(io_error) => backup_failed_error(io_error),
    }
}

/// Map a [`SettingsFileError`] returned by [`settings::reset`].
///
/// [`SettingsFileError::Backup`] is the one failure that is genuinely about the ADR 013 backup
/// rename `reset` attempts before it writes anything, so only it is reported as `backupFailed`.
/// Every other variant -- including `Io`, which after a successful rename can only come from
/// the `save_locked` call that follows -- goes through the same [`map_settings_error`] table
/// every other command uses, so `permissionDenied`, `readFailed`, and `writeFailed` stay
/// reachable from `reset_settings` too.
fn map_reset_error(error: SettingsFileError) -> SettingsCommandError {
    match error {
        SettingsFileError::Backup(io_error) => backup_failed_error(io_error),
        other => map_settings_error(other, IoOperation::Write),
    }
}

/// Report a schema version above what this build supports, re-coding one above the JavaScript
/// safe-integer range as `unsafeSettingsValue` instead, exactly as `commands/project.rs` does.
fn map_schema_version(found: u64, supported: u32) -> SettingsCommandError {
    if found > JAVASCRIPT_MAX_SAFE_INTEGER {
        SettingsCommandError {
            field: Some("schemaVersion".to_owned()),
            value: Some(found.to_string()),
            ..SettingsCommandError::new(SettingsCommandErrorCode::UnsafeSettingsValue)
        }
    } else {
        SettingsCommandError {
            found_schema_version: Some(found),
            supported_schema_version: Some(supported),
            ..SettingsCommandError::new(SettingsCommandErrorCode::FutureSchemaVersion)
        }
    }
}

/// Map one [`SettingsValidationError`] to its stable code and dotted field path.
fn map_validation_error(error: SettingsValidationError) -> SettingsCommandError {
    match error {
        // `validate_settings` runs on every `save`, not only behind the envelope probe `load`
        // uses, so a frontend-supplied document can carry a schema version above what this
        // build supports without ever going through `SettingsFileError::FutureSchemaVersion`.
        SettingsValidationError::SchemaVersion { found, expected } if found > expected => {
            map_schema_version(u64::from(found), expected)
        }
        SettingsValidationError::SchemaVersion { .. } => {
            SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        }
        SettingsValidationError::TooManyPresets { .. } => SettingsCommandError {
            field: Some("presets".to_owned()),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::EmptyPresetId { index }
        | SettingsValidationError::DuplicatePresetId { index } => SettingsCommandError {
            field: Some(format!("presets[{index}].id")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::EmptyPresetName { index }
        | SettingsValidationError::PresetNameTooLong { index, .. } => SettingsCommandError {
            field: Some(format!("presets[{index}].name")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::InvalidEncoderName { index, field } => SettingsCommandError {
            field: Some(format!("presets[{index}].{field}")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::AudioBitrateOutOfRange { index, .. } => SettingsCommandError {
            field: Some(format!("presets[{index}].audioBitrate")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::AudioSampleRateOutOfRange { index, .. } => SettingsCommandError {
            field: Some(format!("presets[{index}].audioSampleRate")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::QualityOutOfRange { index, .. } => SettingsCommandError {
            field: Some(format!("presets[{index}].quality.value")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::InvalidResolution { index } => SettingsCommandError {
            field: Some(format!("presets[{index}].resolution")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::InvalidFrameRate { index } => SettingsCommandError {
            field: Some(format!("presets[{index}].frameRate")),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        SettingsValidationError::UnsafeInteger { field, value } => SettingsCommandError {
            field: Some(field),
            value: Some(value.to_string()),
            ..SettingsCommandError::new(SettingsCommandErrorCode::UnsafeSettingsValue)
        },
        SettingsValidationError::UnknownActivePreset { .. } => SettingsCommandError {
            field: Some("activePresetId".to_owned()),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings)
        },
        // `validate_settings` produces `InvalidFfmpegPath` only for a blank or NUL-bearing
        // path, which is exactly what `invalidPath` is reserved for; every other validation
        // failure above maps to `invalidSettings` instead.
        SettingsValidationError::InvalidFfmpegPath => SettingsCommandError {
            field: Some("ffmpegPath".to_owned()),
            ..SettingsCommandError::new(SettingsCommandErrorCode::InvalidPath)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Rational;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn sample_preset(id: &str) -> settings::Preset {
        settings::Preset {
            id: id.to_owned(),
            name: "H.264 MP4".to_owned(),
            container: settings::Container::Mp4,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            audio_bitrate: None,
            audio_sample_rate: settings::AudioSampleRateSetting::Fixed(48_000),
            audio_channels: settings::AudioChannels::Stereo,
            quality: settings::Quality {
                kind: settings::QualityKind::Crf,
                value: 20,
            },
            resolution: settings::ResolutionSetting::Source,
            frame_rate: settings::FrameRateSetting::Source,
        }
    }

    /// A document at revision 0, the value a first save compares against; see
    /// `settings::save`.
    fn sample_settings(presets: Vec<settings::Preset>) -> Settings {
        Settings {
            schema_version: settings::CURRENT_SCHEMA_VERSION,
            revision: 0,
            ffmpeg_path: None,
            presets,
            active_preset_id: None,
        }
    }

    #[test]
    fn every_error_code_serializes_to_its_stable_camel_case_string() {
        // `ALL_ERROR_CODES` is generated by the same `settings_error_codes!` invocation that
        // defines `SettingsCommandErrorCode`, so a variant added to the enum without adding it
        // to that invocation fails to compile -- this list cannot go stale relative to the
        // enum the way a hand-written array could. This test then asks serde itself, through
        // `serde_json::to_value`, for the wire string of every one of those variants, rather
        // than consulting a second hand-written table: a variant added to the enum, or one
        // whose rename serde produces differently than expected, changes the set below.
        let mut serialized: Vec<String> = ALL_ERROR_CODES
            .iter()
            .map(|code| {
                serde_json::to_value(code)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        serialized.sort_unstable();

        assert_eq!(
            serialized,
            vec![
                "appDataUnavailable",
                "backupFailed",
                "commandExecutionFailed",
                "futureSchemaVersion",
                "invalidJson",
                "invalidPath",
                "invalidSettings",
                "permissionDenied",
                "readFailed",
                "settingsConflict",
                "settingsUnreadable",
                "unsafeSettingsValue",
                "writeFailed",
            ]
        );
    }

    #[test]
    fn serializes_the_command_contracts_in_camel_case() {
        let result = LoadSettingsResult {
            settings: sample_settings(vec![sample_preset("preset-1")]),
            seeded: true,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["seeded"], serde_json::json!(true));
        assert_eq!(value["settings"]["schemaVersion"], serde_json::json!(1));

        let with_schema = SettingsCommandError {
            found_schema_version: Some(2),
            supported_schema_version: Some(1),
            ..SettingsCommandError::new(SettingsCommandErrorCode::FutureSchemaVersion)
        };
        let with_schema_value = serde_json::to_value(&with_schema).unwrap();
        assert_eq!(with_schema_value["code"], "futureSchemaVersion");
        assert_eq!(with_schema_value["foundSchemaVersion"], 2);
        assert_eq!(with_schema_value["supportedSchemaVersion"], 1);

        let bare = SettingsCommandError::new(SettingsCommandErrorCode::InvalidSettings);
        let bare_value = serde_json::to_value(&bare).unwrap();
        let object = bare_value.as_object().unwrap();
        assert!(!object.contains_key("detail"));
        assert!(!object.contains_key("field"));
        assert!(!object.contains_key("value"));
        assert!(!object.contains_key("foundSchemaVersion"));
        assert!(!object.contains_key("supportedSchemaVersion"));
    }

    #[test]
    fn validation_failures_carry_the_dotted_field_path() {
        let quality = map_validation_error(SettingsValidationError::QualityOutOfRange {
            index: 2,
            kind: settings::QualityKind::Crf,
            value: 999,
        });
        assert_eq!(quality.code, SettingsCommandErrorCode::InvalidSettings);
        assert_eq!(quality.field.as_deref(), Some("presets[2].quality.value"));

        let audio_bitrate = map_validation_error(SettingsValidationError::AudioBitrateOutOfRange {
            index: 1,
            value: 4_000,
        });
        assert_eq!(
            audio_bitrate.code,
            SettingsCommandErrorCode::InvalidSettings
        );
        assert_eq!(
            audio_bitrate.field.as_deref(),
            Some("presets[1].audioBitrate")
        );
        assert_eq!(audio_bitrate.value, None);

        let audio_sample_rate =
            map_validation_error(SettingsValidationError::AudioSampleRateOutOfRange {
                index: 3,
                value: 7_999,
            });
        assert_eq!(
            audio_sample_rate.code,
            SettingsCommandErrorCode::InvalidSettings
        );
        assert_eq!(
            audio_sample_rate.field.as_deref(),
            Some("presets[3].audioSampleRate")
        );
        assert_eq!(audio_sample_rate.value, None);

        let encoder = map_validation_error(SettingsValidationError::InvalidEncoderName {
            index: 0,
            field: settings::PresetField::VideoEncoder,
        });
        assert_eq!(encoder.code, SettingsCommandErrorCode::InvalidSettings);
        assert_eq!(encoder.field.as_deref(), Some("presets[0].videoEncoder"));

        let active_preset = map_validation_error(SettingsValidationError::UnknownActivePreset {
            preset_id: "missing".to_owned(),
        });
        assert_eq!(
            active_preset.code,
            SettingsCommandErrorCode::InvalidSettings
        );
        assert_eq!(active_preset.field.as_deref(), Some("activePresetId"));

        let ffmpeg_path = map_validation_error(SettingsValidationError::InvalidFfmpegPath);
        assert_eq!(ffmpeg_path.code, SettingsCommandErrorCode::InvalidPath);
        assert_eq!(ffmpeg_path.field.as_deref(), Some("ffmpegPath"));

        // The remaining `map_validation_error` arms, one assertion each, so every arm has at
        // least one behavioural test.
        let future_version = map_validation_error(SettingsValidationError::SchemaVersion {
            found: 2,
            expected: 1,
        });
        assert_eq!(
            future_version.code,
            SettingsCommandErrorCode::FutureSchemaVersion
        );
        let stale_version = map_validation_error(SettingsValidationError::SchemaVersion {
            found: 0,
            expected: 1,
        });
        assert_eq!(
            stale_version.code,
            SettingsCommandErrorCode::InvalidSettings
        );
        let too_many_presets =
            map_validation_error(SettingsValidationError::TooManyPresets { count: 999 });
        assert_eq!(too_many_presets.field.as_deref(), Some("presets"));
        let empty_preset_id =
            map_validation_error(SettingsValidationError::EmptyPresetId { index: 1 });
        assert_eq!(empty_preset_id.field.as_deref(), Some("presets[1].id"));
        let empty_preset_name =
            map_validation_error(SettingsValidationError::EmptyPresetName { index: 3 });
        assert_eq!(empty_preset_name.field.as_deref(), Some("presets[3].name"));
        let invalid_resolution =
            map_validation_error(SettingsValidationError::InvalidResolution { index: 4 });
        assert_eq!(
            invalid_resolution.field.as_deref(),
            Some("presets[4].resolution")
        );
        let invalid_frame_rate =
            map_validation_error(SettingsValidationError::InvalidFrameRate { index: 5 });
        assert_eq!(
            invalid_frame_rate.field.as_deref(),
            Some("presets[5].frameRate")
        );
        let unsafe_integer = map_validation_error(SettingsValidationError::UnsafeInteger {
            field: "presets[0].quality.value".to_owned(),
            value: 9_007_199_254_740_992,
        });
        assert_eq!(
            unsafe_integer.field.as_deref(),
            Some("presets[0].quality.value")
        );
        assert_eq!(unsafe_integer.value.as_deref(), Some("9007199254740992"));
    }

    #[test]
    fn generated_errors_never_expose_internal_english_details() {
        for code in [
            SettingsCommandErrorCode::AppDataUnavailable,
            SettingsCommandErrorCode::CommandExecutionFailed,
        ] {
            let error = generated_error(code);
            assert_eq!(error.code, code);
            assert_eq!(error.detail, None);
            assert_eq!(error.field, None);
            assert_eq!(error.value, None);
            assert_eq!(error.found_schema_version, None);
            assert_eq!(error.supported_schema_version, None);
        }
    }

    #[test]
    fn save_refuses_a_document_the_frontend_should_not_have_sent() {
        let directory = TestDirectory::new();
        let valid = sample_settings(vec![sample_preset("preset-1")]);
        settings::save(&directory.path, &valid).unwrap();
        let path = directory.path.join(settings::SETTINGS_FILE_NAME);
        let before = fs::read(&path).unwrap();

        let mut invalid = valid;
        invalid.active_preset_id = Some("does-not-exist".to_owned());

        let error = save_settings_with(&directory.path, invalid).unwrap_err();

        assert_eq!(error.code, SettingsCommandErrorCode::InvalidSettings);
        assert_eq!(error.field.as_deref(), Some("activePresetId"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn save_refuses_an_out_of_range_audio_value_with_its_field_path_on_the_wire() {
        // The ADR 023 audio ranges, end to end: the frontend matches `code` and `field` in this
        // exact serialized form, and the file on disk stays as it was.
        let directory = TestDirectory::new();
        let valid = sample_settings(vec![sample_preset("preset-0"), sample_preset("preset-1")]);
        settings::save(&directory.path, &valid).unwrap();
        let path = directory.path.join(settings::SETTINGS_FILE_NAME);
        let before = fs::read(&path).unwrap();

        let mut bad_bitrate = valid.clone();
        bad_bitrate.presets[1].audio_bitrate = Some(settings::MAX_AUDIO_BITRATE_KBPS + 1);
        let error = save_settings_with(&directory.path, bad_bitrate).unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code": "invalidSettings", "field": "presets[1].audioBitrate"})
        );

        let mut bad_rate = valid;
        bad_rate.presets[1].audio_sample_rate =
            settings::AudioSampleRateSetting::Fixed(settings::MIN_AUDIO_SAMPLE_RATE - 1);
        let error = save_settings_with(&directory.path, bad_rate).unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code": "invalidSettings", "field": "presets[1].audioSampleRate"})
        );

        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_damaged_file_maps_to_settings_unreadable_on_save_and_invalid_json_on_load() {
        let directory = TestDirectory::new();
        let path = directory.path.join(settings::SETTINGS_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();

        let load_error = load_settings_with(&directory.path).unwrap_err();
        assert_eq!(load_error.code, SettingsCommandErrorCode::InvalidJson);
        assert_eq!(load_error.detail, None);

        let save_error = save_settings_with(
            &directory.path,
            sample_settings(vec![sample_preset("preset-1")]),
        )
        .unwrap_err();
        assert_eq!(
            save_error.code,
            SettingsCommandErrorCode::SettingsUnreadable
        );
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn restore_default_presets_reports_the_same_code_load_does_for_an_unreadable_path() {
        // A directory occupying the settings file's name makes `fs::read` inside
        // `settings::load` fail before `restore_default_presets` reaches a write, so both
        // commands must report the same code for it. Which code differs by platform: Unix
        // reports a kind that is not `PermissionDenied`, so `map_io_error` consults the
        // `IoOperation` and answers `ReadFailed`; Windows reports `PermissionDenied`, an arm
        // that ignores the operation. The exact code is therefore pinned below on Unix only,
        // where it is the one check that catches `restore_default_presets_with` switching to
        // `IoOperation::Write`; pinning it on Windows would fail at run time, not break the
        // build. `maps_io_failures_without_generated_english_details` pins both branches of
        // `map_io_error` on every platform, but not the operation any caller passes to it.
        let directory = TestDirectory::new();
        fs::create_dir(directory.path.join(settings::SETTINGS_FILE_NAME)).unwrap();

        let load_error = load_settings_with(&directory.path).unwrap_err();
        let restore_error = restore_default_presets_with(&directory.path).unwrap_err();

        assert_eq!(load_error.code, restore_error.code);
        assert!(matches!(
            load_error.code,
            SettingsCommandErrorCode::ReadFailed | SettingsCommandErrorCode::PermissionDenied,
        ));
        // Unix only, for the reason given above.
        #[cfg(unix)]
        assert_eq!(load_error.code, SettingsCommandErrorCode::ReadFailed);
    }

    #[test]
    fn save_restore_and_reset_return_exactly_what_a_fresh_load_reads() {
        let save_directory = TestDirectory::new();
        let mut preset = sample_preset("preset-1");
        // `{"n": 60, "d": 2}` is unreduced. Deserializing it here runs the value through
        // `Rational::try_from`, the same conversion a frontend-supplied document goes through
        // over Tauri's JSON IPC boundary, so this pins that dependency rather than a
        // `Rational` `Rational::new` had already reduced before this test ever saw it.
        let unreduced_frame_rate: Rational =
            serde_json::from_value(serde_json::json!({"n": 60, "d": 2})).unwrap();
        preset.frame_rate = settings::FrameRateSetting::Rate(unreduced_frame_rate);
        let saved =
            save_settings_with(&save_directory.path, sample_settings(vec![preset])).unwrap();
        let reloaded_after_save = load_settings_with(&save_directory.path).unwrap();
        assert!(!reloaded_after_save.seeded);
        assert_eq!(reloaded_after_save.settings, saved);

        let restore_directory = TestDirectory::new();
        let restored = restore_default_presets_with(&restore_directory.path).unwrap();
        let reloaded = load_settings_with(&restore_directory.path).unwrap();
        assert!(!reloaded.seeded);
        assert_eq!(reloaded.settings, restored);

        let reset_directory = TestDirectory::new();
        fs::write(
            reset_directory.path.join(settings::SETTINGS_FILE_NAME),
            b"{ not json",
        )
        .unwrap();
        let reset = reset_settings_with(&reset_directory.path).unwrap();
        let reloaded_after_reset = load_settings_with(&reset_directory.path).unwrap();
        assert!(!reloaded_after_reset.seeded);
        assert_eq!(reloaded_after_reset.settings, reset);
    }

    #[test]
    fn a_stale_save_maps_to_settings_conflict_and_drops_both_revision_numbers() {
        let directory = TestDirectory::new();
        let sent = sample_settings(vec![sample_preset("preset-1")]);
        let saved = settings::save(&directory.path, &sent).unwrap();
        // A second save lands the file at revision 2, leaving `saved` -- at revision 1 -- as
        // the stale copy a window that has not reloaded would still be holding.
        settings::save(&directory.path, &saved).unwrap();

        let error = save_settings_with(&directory.path, saved).unwrap_err();

        assert_eq!(error.code, SettingsCommandErrorCode::SettingsConflict);
        // The two revision numbers are dropped at this layer: they are a Rust-side
        // diagnostic, and the only recovery is to reload and re-apply the edit.
        assert_eq!(error.detail, None);
        assert_eq!(error.field, None);
        assert_eq!(error.value, None);
        assert_eq!(error.found_schema_version, None);
        assert_eq!(error.supported_schema_version, None);
    }

    #[test]
    fn save_returns_the_bumped_document_rather_than_the_one_it_was_given() {
        // `save_settings_with` must return what `settings::save` wrote, not its input.
        // Returning the input would hand the interface a revision one behind the file, and
        // its very next save would be refused as a conflict.
        let directory = TestDirectory::new();
        let sent = sample_settings(vec![sample_preset("preset-1")]);
        let returned = save_settings_with(&directory.path, sent.clone()).unwrap();

        assert_eq!(sent.revision, 0);
        assert_eq!(returned.revision, 1);
        // The interface can save again straight from the returned document.
        let again = save_settings_with(&directory.path, returned).unwrap();
        assert_eq!(again.revision, 2);
    }

    #[test]
    fn a_future_schema_version_is_reported_with_both_version_numbers() {
        let directory = TestDirectory::new();
        let path = directory.path.join(settings::SETTINGS_FILE_NAME);
        let mut value = serde_json::to_value(sample_settings(vec![])).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = load_settings_with(&directory.path).unwrap_err();

        assert_eq!(error.code, SettingsCommandErrorCode::FutureSchemaVersion);
        assert_eq!(error.found_schema_version, Some(2));
        assert_eq!(
            error.supported_schema_version,
            Some(settings::CURRENT_SCHEMA_VERSION)
        );
    }

    #[test]
    fn a_schema_version_above_the_javascript_safe_range_is_reported_as_an_unsafe_value() {
        let directory = TestDirectory::new();
        let path = directory.path.join(settings::SETTINGS_FILE_NAME);
        let mut value = serde_json::to_value(sample_settings(vec![])).unwrap();
        value["schemaVersion"] = serde_json::json!(9_007_199_254_740_992_u64);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let error = load_settings_with(&directory.path).unwrap_err();

        assert_eq!(error.code, SettingsCommandErrorCode::UnsafeSettingsValue);
        assert_eq!(error.field.as_deref(), Some("schemaVersion"));
        assert_eq!(error.value.as_deref(), Some("9007199254740992"));
        assert_eq!(error.found_schema_version, None);
    }

    #[test]
    fn reset_backup_failures_without_a_raw_os_code_map_to_backup_failed_with_no_detail() {
        let error = map_reset_error(SettingsFileError::Backup(io::Error::other(
            "synthetic failure",
        )));
        assert_eq!(error.code, SettingsCommandErrorCode::BackupFailed);
        assert_eq!(error.detail, None);
    }

    #[cfg(unix)]
    #[test]
    fn reset_backup_failures_with_a_raw_os_code_keep_the_diagnostic() {
        let error = map_reset_error(SettingsFileError::Backup(io::Error::from_raw_os_error(13)));
        assert_eq!(error.code, SettingsCommandErrorCode::BackupFailed);
        assert!(error.detail.is_some());
    }

    #[test]
    fn reset_io_failures_after_a_successful_rename_go_through_the_shared_io_mapping() {
        // Unlike `Backup`, a bare `Io` from `settings::reset` can only come from the
        // `save_locked` call that follows a successful rename, so it must go through the same
        // read/write mapping every other command uses instead of being folded into
        // `backupFailed`.
        let permission_denied = map_reset_error(SettingsFileError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "generated diagnostic",
        )));
        assert_eq!(
            permission_denied.code,
            SettingsCommandErrorCode::PermissionDenied
        );
        assert_eq!(permission_denied.detail, None);

        let write_failed = map_reset_error(SettingsFileError::Io(io::Error::other(
            "generated diagnostic",
        )));
        assert_eq!(write_failed.code, SettingsCommandErrorCode::WriteFailed);
        assert_eq!(write_failed.detail, None);
    }

    #[cfg(unix)]
    #[test]
    fn reset_settings_reports_permission_denied_for_a_write_failure_after_a_successful_rename() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        // No settings.json exists, so the rename `reset` attempts first is an ignored
        // NotFound; making the directory read-only forces the write that follows -- inside
        // `save_locked` -- to fail instead, proving `permissionDenied` is reachable from
        // `reset_settings` and not swallowed into `backupFailed`.
        fs::set_permissions(&directory.path, fs::Permissions::from_mode(0o500)).unwrap();

        let result = reset_settings_with(&directory.path);

        // Restore write permission so `TestDirectory`'s `Drop` can remove the directory.
        fs::set_permissions(&directory.path, fs::Permissions::from_mode(0o700)).unwrap();

        let error = result.unwrap_err();
        assert_eq!(error.code, SettingsCommandErrorCode::PermissionDenied);
    }

    #[test]
    fn maps_io_failures_without_generated_english_details() {
        for (kind, operation, expected) in [
            (
                io::ErrorKind::PermissionDenied,
                IoOperation::Read,
                SettingsCommandErrorCode::PermissionDenied,
            ),
            (
                io::ErrorKind::PermissionDenied,
                IoOperation::Write,
                SettingsCommandErrorCode::PermissionDenied,
            ),
            (
                io::ErrorKind::Other,
                IoOperation::Read,
                SettingsCommandErrorCode::ReadFailed,
            ),
            (
                io::ErrorKind::Other,
                IoOperation::Write,
                SettingsCommandErrorCode::WriteFailed,
            ),
        ] {
            let error = map_io_error(io::Error::new(kind, "generated diagnostic"), operation);
            assert_eq!(error.code, expected);
            assert_eq!(error.detail, None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_only_raw_operating_system_io_diagnostics() {
        let error = map_io_error(io::Error::from_raw_os_error(13), IoOperation::Read);
        assert_eq!(error.code, SettingsCommandErrorCode::PermissionDenied);
        assert!(error.detail.is_some());
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-settings-command-test-{}-{sequence}",
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
