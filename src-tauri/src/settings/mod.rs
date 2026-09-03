//! Document types, validation, and file operations for the application settings file.
//!
//! ADR 013 defines the on-disk shape: `<app_data>/settings.json`, at schema version 1,
//! holding an optional ffmpeg path, a list of export presets, and an optional active preset
//! id. The top of this module holds the pure parts of that decision -- the serde types and
//! [`validate_settings`] -- with no file I/O. The bottom half holds loading, saving, seeding,
//! restore, reset, the permissive ffmpeg-path accessor, and the read/write lock that
//! coordinates them.

pub mod defaults;

use crate::project::Resolution;
use crate::time::Rational;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

/// The settings schema this build reads and writes; see ADR 013.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The largest number of presets [`validate_settings`] accepts.
pub const MAX_PRESETS: usize = 100;

/// The largest preset name length, counted in `chars()`, [`validate_settings`] accepts.
pub const MAX_PRESET_NAME_CHARS: usize = 120;

/// The largest resolution dimension, in pixels, [`validate_settings`] accepts on either axis
/// of a [`ResolutionSetting::Custom`] value.
pub const MAX_RESOLUTION_DIMENSION: u32 = 16_384;

/// The largest encoder name length, counted in `chars()`, [`validate_settings`] accepts.
pub const MAX_ENCODER_NAME_CHARS: usize = 64;

// A fourth private copy of the JavaScript `Number.MAX_SAFE_INTEGER` bound. `project/mod.rs`,
// `commands/project.rs`, and `commands/media.rs` each already hold their own; ADR 009 caps a
// commit to one refactor, and hoisting this constant to a shared location is not this
// milestone's refactor.
const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The application settings document, `<app_data>/settings.json` at schema version 1.
///
/// `ffmpeg_path` and `active_preset_id` are absent from the JSON, never `null`, when they
/// hold no value; see ADR 013. A read still accepts an explicit `null` for either, because
/// `#[serde(default)]` on an `Option` field also accepts a `null` on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// The schema version this document claims. Must equal [`CURRENT_SCHEMA_VERSION`] to
    /// pass [`validate_settings`].
    pub schema_version: u32,
    /// An explicit ffmpeg location the user configured, ahead of every other entry in the
    /// ADR 005 resolution order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    /// The user's export presets, in display order.
    pub presets: Vec<Preset>,
    /// The id of the preset the interface currently has selected, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_preset_id: Option<String>,
}

/// One export preset: an identity, a container, two encoder names, a quality control, and
/// two output settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    /// A stable identifier that [`Settings::active_preset_id`] references.
    pub id: String,
    /// The display name. Duplicates across presets are legal; the id disambiguates.
    pub name: String,
    /// The output container. The render layer of ADR 004 selects a muxer from this value.
    pub container: Container,
    /// The ffmpeg video encoder name, validated to reach `-c:v` as a codec name only.
    pub video_encoder: String,
    /// The ffmpeg audio encoder name, validated to reach `-c:a` as a codec name only.
    pub audio_encoder: String,
    /// The quality control and its value.
    pub quality: Quality,
    /// The output resolution: the source resolution, or an explicit width and height.
    pub resolution: ResolutionSetting,
    /// The output frame rate: the source frame rate, or an explicit rational rate.
    pub frame_rate: FrameRateSetting,
}

/// The output container. The set is closed: the render layer of ADR 004 selects a muxer
/// from this value, and an open set would let an unmuxable value reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Container {
    Mp4,
    Mov,
    Mkv,
}

/// A preset's quality control: a kind and the value that kind interprets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quality {
    pub kind: QualityKind,
    /// The value `kind` interprets. Always non-negative on the wire: a negative value is a
    /// JSON type error, not a [`SettingsValidationError`], and `u32` already fits inside the
    /// JavaScript safe-integer range, so it needs no extra range check of its own.
    pub value: u32,
}

/// The strategy a preset's [`Quality`] uses to control output size or fidelity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityKind {
    /// Constant Rate Factor: lower is higher quality. Valid range `0..=63`.
    Crf,
    /// A fixed bitrate, in **kilobits per second**. Valid range `1..=200_000`.
    Bitrate,
    /// An encoder-defined quality scale. Valid range `1..=100`.
    QualityScale,
}

/// The output resolution: the source video's own resolution, or an explicit width and
/// height.
///
/// The wire shape is the string `"source"` or an object of `w` and `h`. `Serialize` and
/// `Deserialize` are hand-written below with a `Visitor`, not `#[serde(untagged)]`: an
/// untagged enum buffers the value and, on a mismatch, reports "data did not match any
/// variant of untagged enum ...", naming neither the offending field nor the expected shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionSetting {
    /// Keep the source video's resolution; the string `"source"` on the wire.
    Source,
    /// Render at this explicit resolution.
    Custom(Resolution),
}

impl Serialize for ResolutionSetting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Source => serializer.serialize_str("source"),
            Self::Custom(resolution) => resolution.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ResolutionSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ResolutionVisitor;

        impl<'de> de::Visitor<'de> for ResolutionVisitor {
            type Value = ResolutionSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the string \"source\" or an object with `w` and `h`")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "source" {
                    Ok(ResolutionSetting::Source)
                } else {
                    Err(de::Error::invalid_value(de::Unexpected::Str(value), &self))
                }
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                Resolution::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(ResolutionSetting::Custom)
            }
        }

        deserializer.deserialize_any(ResolutionVisitor)
    }
}

/// The output frame rate: the source video's own frame rate, or an explicit rational rate.
///
/// The wire shape is the string `"source"` or an object of `n` and `d`, matching
/// [`ResolutionSetting`]'s hand-written `Visitor` approach and for the same reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameRateSetting {
    /// Keep the source video's frame rate; the string `"source"` on the wire.
    Source,
    /// Render at this explicit rational rate.
    Rate(Rational),
}

impl Serialize for FrameRateSetting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Source => serializer.serialize_str("source"),
            Self::Rate(rate) => rate.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for FrameRateSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FrameRateVisitor;

        impl<'de> de::Visitor<'de> for FrameRateVisitor {
            type Value = FrameRateSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the string \"source\" or an object with `n` and `d`")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "source" {
                    Ok(FrameRateSetting::Source)
                } else {
                    Err(de::Error::invalid_value(de::Unexpected::Str(value), &self))
                }
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                Rational::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(FrameRateSetting::Rate)
            }
        }

        deserializer.deserialize_any(FrameRateVisitor)
    }
}

/// Which of a [`Preset`]'s two encoder-name fields failed validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetField {
    VideoEncoder,
    AudioEncoder,
}

impl fmt::Display for PresetField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::VideoEncoder => "videoEncoder",
            Self::AudioEncoder => "audioEncoder",
        };
        formatter.write_str(name)
    }
}

impl fmt::Display for QualityKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Crf => "crf",
            Self::Bitrate => "bitrate",
            Self::QualityScale => "qualityScale",
        };
        formatter.write_str(name)
    }
}

/// A structurally valid settings document whose values violate an ADR 013 invariant.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsValidationError {
    SchemaVersion {
        found: u32,
        expected: u32,
    },
    TooManyPresets {
        count: usize,
    },
    EmptyPresetId {
        index: usize,
    },
    DuplicatePresetId {
        index: usize,
    },
    EmptyPresetName {
        index: usize,
    },
    PresetNameTooLong {
        index: usize,
        chars: usize,
    },
    /// The render layer of ADR 004 builds `-c:v <name>` (or `-c:a <name>`) with no shell in
    /// between, so a name outside `[0-9A-Za-z_.-]`, or one that does not start with an
    /// alphanumeric character, could reach ffmpeg as an extra argument rather than as a
    /// codec name. This is why the frontend cannot be trusted with an encoder name: Rust
    /// validates it here instead.
    InvalidEncoderName {
        index: usize,
        field: PresetField,
    },
    QualityOutOfRange {
        index: usize,
        kind: QualityKind,
        value: u32,
    },
    InvalidResolution {
        index: usize,
    },
    InvalidFrameRate {
        index: usize,
    },
    UnsafeInteger {
        field: String,
        value: i128,
    },
    UnknownActivePreset {
        preset_id: String,
    },
    InvalidFfmpegPath,
}

impl fmt::Display for SettingsValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SchemaVersion { found, expected } => write!(
                formatter,
                "schemaVersion must be {expected} when saving, but was {found}"
            ),
            Self::TooManyPresets { count } => write!(
                formatter,
                "presets holds {count} entries, more than the {MAX_PRESETS} allowed"
            ),
            Self::EmptyPresetId { index } => write!(formatter, "presets[{index}].id is empty"),
            Self::DuplicatePresetId { index } => {
                write!(formatter, "presets[{index}].id is duplicated")
            }
            Self::EmptyPresetName { index } => {
                write!(formatter, "presets[{index}].name is blank")
            }
            Self::PresetNameTooLong { index, chars } => write!(
                formatter,
                "presets[{index}].name holds {chars} characters, more than the {MAX_PRESET_NAME_CHARS} allowed"
            ),
            Self::InvalidEncoderName { index, field } => write!(
                formatter,
                "presets[{index}].{field} is not a valid encoder name"
            ),
            Self::QualityOutOfRange { index, kind, value } => write!(
                formatter,
                "presets[{index}].quality.value {value} is out of range for {kind}"
            ),
            Self::InvalidResolution { index } => {
                write!(formatter, "presets[{index}].resolution is invalid")
            }
            Self::InvalidFrameRate { index } => {
                write!(formatter, "presets[{index}].frameRate is invalid")
            }
            Self::UnsafeInteger { field, value } => write!(
                formatter,
                "{field} value {value} is outside the JavaScript safe integer range"
            ),
            Self::UnknownActivePreset { preset_id } => write!(
                formatter,
                "activePresetId {preset_id:?} does not name a preset"
            ),
            Self::InvalidFfmpegPath => write!(formatter, "ffmpegPath is invalid"),
        }
    }
}

impl Error for SettingsValidationError {}

/// Validate a settings document against every ADR 013 invariant serde's types do not already
/// enforce.
///
/// Structural correctness -- field presence, camelCase keys, the `"source"` keyword shapes,
/// and a positive rational denominator -- is already guaranteed by the time a `Settings`
/// value exists, because deserialization rejects a structurally invalid document before this
/// function ever runs. This function checks what remains: the schema version, preset id and
/// name shape, the encoder-name security rule, the quality and resolution ranges, the
/// safe-integer bounds on a custom frame rate, and the two cross-references
/// (`active_preset_id` naming a preset, and every preset id being unique).
pub fn validate_settings(settings: &Settings) -> Result<(), SettingsValidationError> {
    if settings.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(SettingsValidationError::SchemaVersion {
            found: settings.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }
    if settings.presets.len() > MAX_PRESETS {
        return Err(SettingsValidationError::TooManyPresets {
            count: settings.presets.len(),
        });
    }

    let mut preset_ids = HashSet::new();
    for (index, preset) in settings.presets.iter().enumerate() {
        if preset.id.trim().is_empty() {
            return Err(SettingsValidationError::EmptyPresetId { index });
        }
        if !preset_ids.insert(preset.id.as_str()) {
            return Err(SettingsValidationError::DuplicatePresetId { index });
        }

        let trimmed_name = preset.name.trim();
        if trimmed_name.is_empty() {
            return Err(SettingsValidationError::EmptyPresetName { index });
        }
        let name_chars = trimmed_name.chars().count();
        if name_chars > MAX_PRESET_NAME_CHARS {
            return Err(SettingsValidationError::PresetNameTooLong {
                index,
                chars: name_chars,
            });
        }

        if !is_valid_encoder_name(&preset.video_encoder) {
            return Err(SettingsValidationError::InvalidEncoderName {
                index,
                field: PresetField::VideoEncoder,
            });
        }
        if !is_valid_encoder_name(&preset.audio_encoder) {
            return Err(SettingsValidationError::InvalidEncoderName {
                index,
                field: PresetField::AudioEncoder,
            });
        }

        if !is_valid_quality(preset.quality) {
            return Err(SettingsValidationError::QualityOutOfRange {
                index,
                kind: preset.quality.kind,
                value: preset.quality.value,
            });
        }

        if let ResolutionSetting::Custom(resolution) = preset.resolution {
            if !(1..=MAX_RESOLUTION_DIMENSION).contains(&resolution.w)
                || !(1..=MAX_RESOLUTION_DIMENSION).contains(&resolution.h)
            {
                return Err(SettingsValidationError::InvalidResolution { index });
            }
        }

        if let FrameRateSetting::Rate(rate) = preset.frame_rate {
            validate_safe_integer(
                &format!("presets[{index}].frameRate.n"),
                i128::from(rate.num()),
            )?;
            validate_safe_integer(
                &format!("presets[{index}].frameRate.d"),
                i128::from(rate.den()),
            )?;
            if rate.num() <= 0 {
                return Err(SettingsValidationError::InvalidFrameRate { index });
            }
        }
    }

    if let Some(active_preset_id) = &settings.active_preset_id {
        if !preset_ids.contains(active_preset_id.as_str()) {
            return Err(SettingsValidationError::UnknownActivePreset {
                preset_id: active_preset_id.clone(),
            });
        }
    }

    if let Some(ffmpeg_path) = &settings.ffmpeg_path {
        if ffmpeg_path.trim().is_empty() || ffmpeg_path.contains('\0') {
            return Err(SettingsValidationError::InvalidFfmpegPath);
        }
    }

    Ok(())
}

/// Check an encoder name against the ADR 013 character rule: 1 to
/// [`MAX_ENCODER_NAME_CHARS`] characters from `[0-9A-Za-z_.-]`, starting with an
/// alphanumeric character.
fn is_valid_encoder_name(name: &str) -> bool {
    let char_count = name.chars().count();
    if !(1..=MAX_ENCODER_NAME_CHARS).contains(&char_count) {
        return false;
    }
    let starts_alphanumeric = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric());
    starts_alphanumeric
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Check a quality value against the range its kind defines.
fn is_valid_quality(quality: Quality) -> bool {
    match quality.kind {
        QualityKind::Crf => quality.value <= 63,
        QualityKind::Bitrate => (1..=200_000).contains(&quality.value),
        QualityKind::QualityScale => (1..=100).contains(&quality.value),
    }
}

/// Reject a value outside the JavaScript safe-integer range, mirroring `project`'s
/// `UnsafeInteger` treatment.
fn validate_safe_integer(field: &str, value: i128) -> Result<(), SettingsValidationError> {
    let bound = i128::from(JAVASCRIPT_MAX_SAFE_INTEGER);
    if !(-bound..=bound).contains(&value) {
        return Err(SettingsValidationError::UnsafeInteger {
            field: field.to_owned(),
            value,
        });
    }
    Ok(())
}

/// The settings file's name inside the application data directory; see ADR 013.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// The fixed backup name [`reset`] moves a damaged settings file to.
///
/// ADR 013 uses one fixed name rather than a timestamped one, so a machine that gets reset
/// repeatedly does not accumulate an unbounded number of backup files in the application data
/// directory; each reset simply overwrites the previous backup.
pub const INVALID_SETTINGS_FILE_NAME: &str = "settings.invalid.json";

/// A failure to read, validate, or save the settings document.
///
/// This mirrors [`crate::project::ProjectFileError`] with one addition, [`Self::Unreadable`]:
/// ADR 013 requires [`save`] to refuse to overwrite a settings file it cannot read back, so
/// that a transient or partial read failure never masks the loss of an entire preset library.
#[derive(Debug)]
pub enum SettingsFileError {
    Io(io::Error),
    Json(serde_json::Error),
    Validation(SettingsValidationError),
    FutureSchemaVersion {
        found: u64,
        supported: u32,
    },
    /// [`save`] refused to write because the file that already exists at the destination
    /// could not be read back. The bytes on disk are left exactly as they were.
    Unreadable,
}

impl fmt::Display for SettingsFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "settings file I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "settings JSON is invalid: {error}"),
            Self::Validation(error) => write!(formatter, "settings values are invalid: {error}"),
            Self::FutureSchemaVersion { found, supported } => write!(
                formatter,
                "settings schema version {found} is newer than supported version {supported}"
            ),
            Self::Unreadable => write!(
                formatter,
                "the existing settings file could not be read; refusing to overwrite it"
            ),
        }
    }
}

impl Error for SettingsFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::FutureSchemaVersion { .. } | Self::Unreadable => None,
        }
    }
}

impl From<io::Error> for SettingsFileError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for SettingsFileError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<SettingsValidationError> for SettingsFileError {
    fn from(error: SettingsValidationError) -> Self {
        Self::Validation(error)
    }
}

/// A probe of just the `schemaVersion` field, read before full deserialization so a future
/// document is reported by its version rather than as an opaque JSON error. This mirrors
/// `project::SchemaEnvelope` exactly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaEnvelope {
    schema_version: u64,
}

/// A narrow, permissive probe of the settings file used by [`configured_ffmpeg_path`]: the
/// schema version and the ffmpeg path, with every other key ignored.
///
/// This deliberately does NOT derive `deny_unknown_fields`, unlike [`Settings`]. [`Settings`]
/// must stay strict, because a permissive load could silently accept a document the rest of
/// the application cannot trust. This probe exists for the opposite reason: it must survive
/// damage anywhere else in the document, so it looks at nothing but these two fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegPathProbe {
    schema_version: u64,
    #[serde(default)]
    ffmpeg_path: Option<String>,
}

/// One process-wide lock over the settings file's write path.
///
/// [`save`], [`restore_default_presets`], and [`reset`] each take this lock exactly once and
/// then do their work through a private `*_locked` helper or by calling [`load`] (which takes
/// no lock of its own). `std::sync::Mutex` is not reentrant, so a function that took this lock
/// and then called the public [`save`] would deadlock against itself; none of them do.
///
/// A poisoned lock is recovered with `PoisonError::into_inner`, the same recovery
/// `ffmpeg::capabilities::cache::CACHE_LOCK` and `ffmpeg::capabilities::smoke::SMOKE_LOCK`
/// use: a writer that panics while holding this lock must not permanently disable settings
/// persistence for the rest of the process's life.
///
/// [`load`] and [`configured_ffmpeg_path`] take no lock at all. [`save`] finishes with an
/// atomic rename (see [`crate::fsutil::write_bytes_atomically`]), so a reader always observes
/// either the whole previous file or the whole new one, never a torn write. Taking the lock
/// for a read would serialize every read behind a slow write and would add a second path to a
/// deadlock, with no correctness benefit to show for it.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// The result of [`load`]: the document, and whether it came from the seed table because no
/// file existed yet.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSettings {
    pub settings: Settings,
    pub seeded: bool,
}

/// Load and validate the settings document from `app_data_directory`.
///
/// Three outcomes, per ADR 013:
/// - the file is absent (`io::ErrorKind::NotFound`): this returns
///   [`defaults::seeded_settings`] with `seeded: true`, and creates neither the file nor
///   `app_data_directory` itself. A read with a write side effect would make tests
///   order-dependent, and it would turn a first-run permission problem into a confusing
///   startup error that has nothing to do with settings.
/// - the file exists and validates: this returns it with `seeded: false`.
/// - the file is corrupt, fails validation, or is otherwise unreadable: this returns `Err`.
///
/// A `schemaVersion` above [`CURRENT_SCHEMA_VERSION`] is caught by a [`SchemaEnvelope`] probe
/// read before the full document deserializes, exactly as `project::load` does, so a document
/// from a later build is reported by its version rather than as an opaque JSON error.
///
/// This takes no lock; see [`SETTINGS_LOCK`] for why.
pub fn load(app_data_directory: &Path) -> Result<LoadedSettings, SettingsFileError> {
    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LoadedSettings {
                settings: defaults::seeded_settings(),
                seeded: true,
            });
        }
        Err(error) => return Err(SettingsFileError::Io(error)),
    };

    let envelope: SchemaEnvelope = serde_json::from_slice(&bytes)?;
    if envelope.schema_version > u64::from(CURRENT_SCHEMA_VERSION) {
        return Err(SettingsFileError::FutureSchemaVersion {
            found: envelope.schema_version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    let settings: Settings = serde_json::from_slice(&bytes)?;
    validate_settings(&settings)?;
    Ok(LoadedSettings {
        settings,
        seeded: false,
    })
}

/// Validate and save `settings` to `app_data_directory`, refusing to overwrite a file this
/// build cannot read back.
///
/// This is the data-loss guard and the single most important behaviour in this module. A
/// capability cache miss (see `ffmpeg::capabilities::cache`) costs one extra probe on the
/// next launch; a lost preset library costs the user work that nothing can rebuild. So, after
/// validating the new document, this re-reads whatever currently exists at the destination
/// through the strict [`load`] -- the same reader a later launch would use -- before writing
/// anything:
/// - nothing exists yet ([`load`]'s "no file" outcome): proceed.
/// - [`load`] succeeds: proceed.
/// - [`load`] fails for any reason -- corrupt JSON, a failed [`validate_settings`], or a
///   schema version above [`CURRENT_SCHEMA_VERSION`] -- return [`SettingsFileError::Unreadable`]
///   and leave the bytes on disk exactly as they were. ADR 013 requires this: a document a
///   later build wrote, or one with a damaged preset a hand edit could still recover, must
///   survive an older build's save instead of being silently overwritten with seeds. Checking
///   only "is this JSON" would miss both cases, so the guard reuses the strict reader rather
///   than re-implementing a weaker check of its own.
///
/// `app_data_directory` is created first when it does not exist yet.
pub fn save(app_data_directory: &Path, settings: &Settings) -> Result<(), SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    save_locked(app_data_directory, settings)
}

/// The body of [`save`], factored out so [`restore_default_presets`] and [`reset`] can reuse
/// it while already holding [`SETTINGS_LOCK`], without calling the public [`save`] and
/// deadlocking on the non-reentrant `Mutex`.
///
/// This calls [`load`] directly rather than the public [`save`] to run its overwrite guard:
/// [`load`] takes no lock of its own (see [`SETTINGS_LOCK`]), so calling it here is safe even
/// though [`save_locked`] already holds the lock.
fn save_locked(app_data_directory: &Path, settings: &Settings) -> Result<(), SettingsFileError> {
    validate_settings(settings)?;

    match load(app_data_directory) {
        Ok(_) => {}
        Err(SettingsFileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(SettingsFileError::Unreadable),
    }

    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    fs::create_dir_all(app_data_directory)?;
    let json = crate::fsutil::to_pretty_json_line(settings)?;
    crate::fsutil::write_bytes_atomically(&path, &json)?;
    Ok(())
}

/// Restore every seeded default preset, keeping every other preset, `ffmpegPath`, and
/// `activePresetId` intact, then save.
///
/// For each seed in [`defaults::default_presets`], this replaces the preset with that id in
/// place when one exists, or appends the seed when it is absent. It never rebuilds the
/// document from the seed table: doing so would silently discard every user-added preset and
/// would clear the `ffmpegPath` the user just configured, which is exactly the mistake ADR
/// 013 calls out by name. When `activePresetId` is absent afterwards and the preset list is
/// non-empty, this sets it to the first seed so restoring presets from an empty library still
/// leaves one selected.
pub fn restore_default_presets(app_data_directory: &Path) -> Result<Settings, SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);

    let mut settings = load(app_data_directory)?.settings;
    for seed in defaults::default_presets() {
        match settings
            .presets
            .iter_mut()
            .find(|preset| preset.id == seed.id)
        {
            Some(existing) => *existing = seed,
            None => settings.presets.push(seed),
        }
    }
    if settings.active_preset_id.is_none() {
        if let Some(first) = settings.presets.first() {
            settings.active_preset_id = Some(first.id.clone());
        }
    }

    save_locked(app_data_directory, &settings)?;
    Ok(settings)
}

/// Move a damaged settings file aside and write fresh seeds.
///
/// This renames the existing file to [`INVALID_SETTINGS_FILE_NAME`] in the same directory --
/// one fixed backup name, so app data does not grow without bound across repeated resets --
/// then writes [`defaults::seeded_settings`]. When the rename itself fails for a reason other
/// than the source file being absent, this returns that error and writes nothing, leaving the
/// original file in place. A missing settings file is not an error: it is treated the same as
/// [`load`]'s "no file yet" outcome, and this simply writes the seeds.
pub fn reset(app_data_directory: &Path) -> Result<Settings, SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);

    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let backup_path = app_data_directory.join(INVALID_SETTINGS_FILE_NAME);
    match fs::rename(&path, &backup_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(SettingsFileError::Io(error)),
    }

    let settings = defaults::seeded_settings();
    save_locked(app_data_directory, &settings)?;
    Ok(settings)
}

/// The configured ffmpeg path, or `None` for any problem reading it.
///
/// This is the permissive counterpart to the strict [`load`]/[`save`] surface described in
/// [`FfmpegPathProbe`]. It reads the same settings file, but through that narrow probe, which
/// ignores every key except `schemaVersion` and `ffmpegPath`. A missing file, an unreadable
/// file, corrupt JSON, an absent `ffmpegPath` key, a blank or NUL-bearing path, or a
/// `schemaVersion` above [`CURRENT_SCHEMA_VERSION`] are all `None`, never an error. The NUL
/// check mirrors [`validate_settings`]'s own [`SettingsValidationError::InvalidFfmpegPath`]
/// rule, so this permissive probe never reports a path the strict [`load`] would reject.
///
/// This exists so that ffmpeg discovery survives a damaged preset. Without it, one malformed
/// preset entry anywhere in `presets` would fail strict deserialization of the whole
/// [`Settings`] document, costing the user their configured ffmpeg path along with it, and the
/// application would report "ffmpeg missing" for a reason that has nothing to do with ffmpeg.
/// The strict surface ([`load`], [`save`]) stays exactly as strict as it is for everything
/// that writes the file; when this probe falls back to `None`, discovery simply degrades to
/// `PATH` and the application data directory, which is exactly the behaviour from before
/// settings existed at all.
///
/// This takes no lock, for the same reason [`load`] does not: [`save`] replaces the file with
/// an atomic rename, so a reader here always observes a whole file, never a torn one.
pub fn configured_ffmpeg_path(app_data_directory: &Path) -> Option<PathBuf> {
    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let bytes = fs::read(path).ok()?;
    let probe: FfmpegPathProbe = serde_json::from_slice(&bytes).ok()?;
    if probe.schema_version > u64::from(CURRENT_SCHEMA_VERSION) {
        return None;
    }
    let ffmpeg_path = probe.ffmpeg_path?;
    if ffmpeg_path.trim().is_empty() || ffmpeg_path.contains('\0') {
        return None;
    }
    Some(PathBuf::from(ffmpeg_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_preset(id: &str) -> Preset {
        Preset {
            id: id.to_owned(),
            name: "H.264 MP4".to_owned(),
            container: Container::Mp4,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            resolution: ResolutionSetting::Source,
            frame_rate: FrameRateSetting::Source,
        }
    }

    fn sample_settings(presets: Vec<Preset>) -> Settings {
        Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            ffmpeg_path: None,
            presets,
            active_preset_id: None,
        }
    }

    #[test]
    fn settings_json_uses_camel_case_and_the_decided_keyword_shapes() {
        let source_preset = sample_preset("source-preset");
        let mut custom_preset = sample_preset("custom-preset");
        custom_preset.resolution = ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 });
        custom_preset.frame_rate = FrameRateSetting::Rate(Rational::new(30000, 1001).unwrap());

        let settings = Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            ffmpeg_path: Some("/opt/homebrew/bin/ffmpeg".to_owned()),
            presets: vec![source_preset, custom_preset],
            active_preset_id: Some("source-preset".to_owned()),
        };

        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["schemaVersion"], serde_json::json!(1));
        assert_eq!(
            value["presets"][0]["videoEncoder"],
            serde_json::json!("libx264")
        );
        assert_eq!(value["presets"][0]["container"], serde_json::json!("mp4"));
        assert_eq!(
            value["presets"][0]["quality"],
            serde_json::json!({"kind": "crf", "value": 20})
        );
        assert_eq!(
            value["presets"][0]["resolution"],
            serde_json::json!("source")
        );
        assert_eq!(
            value["presets"][0]["frameRate"],
            serde_json::json!("source")
        );
        assert_eq!(
            value["presets"][1]["resolution"],
            serde_json::json!({"w": 1920, "h": 1080})
        );
        assert_eq!(
            value["presets"][1]["frameRate"],
            serde_json::json!({"n": 30000, "d": 1001})
        );
        assert_eq!(value["activePresetId"], serde_json::json!("source-preset"));
    }

    #[test]
    fn an_unset_ffmpeg_path_and_active_preset_are_absent_not_null() {
        let settings = sample_settings(vec![]);
        let value = serde_json::to_value(&settings).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("ffmpegPath"));
        assert!(!object.contains_key("activePresetId"));
    }

    #[test]
    fn a_null_ffmpeg_path_still_deserializes_as_unset() {
        let json = r#"{"schemaVersion":1,"ffmpegPath":null,"presets":[],"activePresetId":null}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.ffmpeg_path, None);
        assert_eq!(settings.active_preset_id, None);
    }

    #[test]
    fn absent_optional_keys_deserialize_as_unset() {
        // `ffmpegPath` and `activePresetId` are absent entirely here, not `null`. Only
        // `#[serde(default)]` lets this document -- the module's own serialized output for
        // an unset value, per `an_unset_ffmpeg_path_and_active_preset_are_absent_not_null`
        // -- load at all.
        let json = r#"{"schemaVersion":1,"presets":[]}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.ffmpeg_path, None);
        assert_eq!(settings.active_preset_id, None);
    }

    #[test]
    fn a_settings_value_with_unset_optionals_round_trips_through_json() {
        let settings = sample_settings(vec![]);
        let json = serde_json::to_string(&settings).unwrap();
        let round_tripped: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped, settings);
    }

    #[test]
    fn an_unknown_resolution_keyword_names_the_expected_value() {
        let error = serde_json::from_str::<ResolutionSetting>(r#""src""#).unwrap_err();
        assert!(error.to_string().contains("source"), "message was: {error}");
    }

    #[test]
    fn rejects_an_unknown_field_on_settings() {
        let json = r#"{"schemaVersion":1,"presets":[],"bogus":true}"#;
        let error = serde_json::from_str::<Settings>(json).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_unknown_field_on_preset() {
        let value = serde_json::json!({
            "id": "preset-1",
            "name": "Sample",
            "container": "mp4",
            "videoEncoder": "libx264",
            "audioEncoder": "aac",
            "quality": {"kind": "crf", "value": 20},
            "resolution": "source",
            "frameRate": "source",
            "bogus": true,
        });
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_unknown_field_on_quality() {
        let value = serde_json::json!({"kind": "crf", "value": 20, "bogus": true});
        let error = serde_json::from_value::<Quality>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_misspelled_resolution_field_is_reported_as_an_unknown_field() {
        let error = serde_json::from_str::<ResolutionSetting>(r#"{"width":1920,"height":1080}"#)
            .unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_misspelled_frame_rate_field_is_reported_as_an_unknown_field() {
        let error = serde_json::from_str::<FrameRateSetting>(r#"{"num":30,"den":1}"#).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_zero_denominator_frame_rate_is_rejected_by_the_inner_rational() {
        let error = serde_json::from_str::<FrameRateSetting>(r#"{"n":30,"d":0}"#).unwrap_err();
        assert!(
            error.to_string().contains("invalid rational"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_encoder_name_that_could_be_read_as_an_ffmpeg_flag() {
        let names: Vec<String> = vec![
            "-f".to_owned(),
            "libx264 -y".to_owned(),
            "lib;rm".to_owned(),
            String::new(),
            ".hidden".to_owned(),
            "_lead".to_owned(),
            "a".repeat(MAX_ENCODER_NAME_CHARS + 1),
        ];
        for field in [PresetField::VideoEncoder, PresetField::AudioEncoder] {
            for name in &names {
                let mut preset = sample_preset("preset-1");
                match field {
                    PresetField::VideoEncoder => preset.video_encoder = name.clone(),
                    PresetField::AudioEncoder => preset.audio_encoder = name.clone(),
                }
                let error = validate_settings(&sample_settings(vec![preset])).unwrap_err();
                assert!(
                    matches!(
                        error,
                        SettingsValidationError::InvalidEncoderName { field: error_field, .. }
                            if error_field == field
                    ),
                    "field {field:?}, name {name:?}: got {error:?}"
                );
            }
        }
    }

    #[test]
    fn accepts_the_encoder_names_the_capability_probe_reports() {
        for name in [
            "libx264",
            "h264_videotoolbox",
            "libsvtav1",
            "aac",
            "libopus",
        ] {
            let mut preset = sample_preset("preset-1");
            preset.video_encoder = name.to_owned();
            preset.audio_encoder = name.to_owned();
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected {name}"
            );
        }
    }

    #[test]
    fn resolution_and_frame_rate_source_and_custom_round_trip() {
        let resolution_source = ResolutionSetting::Source;
        let json = serde_json::to_string(&resolution_source).unwrap();
        assert_eq!(
            serde_json::from_str::<ResolutionSetting>(&json).unwrap(),
            resolution_source
        );

        let resolution_custom = ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 });
        let json = serde_json::to_string(&resolution_custom).unwrap();
        assert_eq!(
            serde_json::from_str::<ResolutionSetting>(&json).unwrap(),
            resolution_custom
        );

        let frame_rate_source = FrameRateSetting::Source;
        let json = serde_json::to_string(&frame_rate_source).unwrap();
        assert_eq!(
            serde_json::from_str::<FrameRateSetting>(&json).unwrap(),
            frame_rate_source
        );

        let frame_rate_custom = FrameRateSetting::Rate(Rational::new(30, 1).unwrap());
        let json = serde_json::to_string(&frame_rate_custom).unwrap();
        assert_eq!(
            serde_json::from_str::<FrameRateSetting>(&json).unwrap(),
            frame_rate_custom
        );
    }

    #[test]
    fn rejects_a_quality_value_outside_its_kinds_range() {
        for (kind, value) in [(QualityKind::Crf, 0), (QualityKind::Crf, 63)] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality { kind, value };
            assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
        }

        for (kind, value) in [
            (QualityKind::Crf, 64),
            (QualityKind::Bitrate, 0),
            (QualityKind::QualityScale, 101),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality { kind, value };
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::QualityOutOfRange { .. })
            ));
        }
    }

    #[test]
    fn enforces_the_bitrate_and_quality_scale_bounds() {
        let mut at_bitrate_cap = sample_preset("preset-1");
        at_bitrate_cap.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 200_000,
        };
        assert!(validate_settings(&sample_settings(vec![at_bitrate_cap])).is_ok());

        let mut over_bitrate_cap = sample_preset("preset-1");
        over_bitrate_cap.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 200_001,
        };
        assert!(matches!(
            validate_settings(&sample_settings(vec![over_bitrate_cap])),
            Err(SettingsValidationError::QualityOutOfRange { .. })
        ));

        let mut min_quality_scale = sample_preset("preset-1");
        min_quality_scale.quality = Quality {
            kind: QualityKind::QualityScale,
            value: 1,
        };
        assert!(validate_settings(&sample_settings(vec![min_quality_scale])).is_ok());

        let mut max_quality_scale = sample_preset("preset-1");
        max_quality_scale.quality = Quality {
            kind: QualityKind::QualityScale,
            value: 100,
        };
        assert!(validate_settings(&sample_settings(vec![max_quality_scale])).is_ok());
    }

    #[test]
    fn rejects_a_zero_or_oversized_resolution() {
        for resolution in [
            Resolution { w: 0, h: 1080 },
            Resolution { w: 1920, h: 0 },
            Resolution {
                w: MAX_RESOLUTION_DIMENSION + 1,
                h: 1080,
            },
            Resolution {
                w: 1920,
                h: MAX_RESOLUTION_DIMENSION + 1,
            },
        ] {
            let mut preset = sample_preset("preset-1");
            preset.resolution = ResolutionSetting::Custom(resolution);
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::InvalidResolution { .. })
            ));
        }

        // The cap itself is inclusive on both axes.
        let mut preset = sample_preset("preset-1");
        preset.resolution = ResolutionSetting::Custom(Resolution {
            w: MAX_RESOLUTION_DIMENSION,
            h: MAX_RESOLUTION_DIMENSION,
        });
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn rejects_a_non_positive_or_unsafe_frame_rate() {
        for rate in [Rational::new(0, 1).unwrap(), Rational::new(-30, 1).unwrap()] {
            let mut preset = sample_preset("preset-1");
            preset.frame_rate = FrameRateSetting::Rate(rate);
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::InvalidFrameRate { .. })
            ));
        }

        // A safe positive numerator paired with a denominator outside the JavaScript safe
        // integer range must be rejected as unsafe, not silently accepted.
        let mut preset = sample_preset("preset-1");
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(1, i64::MAX).unwrap());
        assert!(matches!(
            validate_settings(&sample_settings(vec![preset])),
            Err(SettingsValidationError::UnsafeInteger { .. })
        ));
    }

    #[test]
    fn rejects_empty_and_duplicate_preset_ids() {
        let empty_id_preset = sample_preset("");
        assert!(matches!(
            validate_settings(&sample_settings(vec![empty_id_preset])),
            Err(SettingsValidationError::EmptyPresetId { index: 0 })
        ));

        // A whitespace-only id must be rejected the same way, matching the trimmed check
        // already applied to the preset name.
        let whitespace_id_preset = sample_preset("   ");
        assert!(matches!(
            validate_settings(&sample_settings(vec![whitespace_id_preset])),
            Err(SettingsValidationError::EmptyPresetId { index: 0 })
        ));

        let first = sample_preset("dup");
        let second = sample_preset("dup");
        assert!(matches!(
            validate_settings(&sample_settings(vec![first, second])),
            Err(SettingsValidationError::DuplicatePresetId { index: 1 })
        ));
    }

    #[test]
    fn allows_duplicate_preset_names() {
        let mut first = sample_preset("preset-1");
        first.name = "Web 1080p".to_owned();
        let mut second = sample_preset("preset-2");
        second.name = "Web 1080p".to_owned();
        assert!(validate_settings(&sample_settings(vec![first, second])).is_ok());
    }

    #[test]
    fn rejects_a_blank_or_over_long_preset_name() {
        let mut blank = sample_preset("preset-1");
        blank.name = "   ".to_owned();
        assert!(matches!(
            validate_settings(&sample_settings(vec![blank])),
            Err(SettingsValidationError::EmptyPresetName { .. })
        ));

        // A multi-byte character proves the count uses `chars()`, not the byte length:
        // "\u{e9}" is two bytes in UTF-8 but one char.
        let mut too_long = sample_preset("preset-2");
        too_long.name = "\u{e9}".repeat(MAX_PRESET_NAME_CHARS + 1);
        assert!(matches!(
            validate_settings(&sample_settings(vec![too_long])),
            Err(SettingsValidationError::PresetNameTooLong { chars, .. })
                if chars == MAX_PRESET_NAME_CHARS + 1
        ));
    }

    #[test]
    fn rejects_more_presets_than_the_cap() {
        let over_cap: Vec<Preset> = (0..=MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        assert!(matches!(
            validate_settings(&sample_settings(over_cap)),
            Err(SettingsValidationError::TooManyPresets { count })
                if count == MAX_PRESETS + 1
        ));

        let at_cap: Vec<Preset> = (0..MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        assert!(validate_settings(&sample_settings(at_cap)).is_ok());
    }

    #[test]
    fn rejects_an_active_preset_id_that_names_nothing() {
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.active_preset_id = Some("missing".to_owned());
        assert!(matches!(
            validate_settings(&settings),
            Err(SettingsValidationError::UnknownActivePreset { preset_id })
                if preset_id == "missing"
        ));
    }

    #[test]
    fn accepts_no_active_preset_alongside_a_non_empty_preset_list() {
        let settings = sample_settings(vec![sample_preset("preset-1"), sample_preset("preset-2")]);
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn rejects_a_blank_or_nul_bearing_ffmpeg_path() {
        for path in ["", "   ", "/opt/homebrew/bin/ffmpeg\0"] {
            let mut settings = sample_settings(vec![]);
            settings.ffmpeg_path = Some(path.to_owned());
            assert!(
                matches!(
                    validate_settings(&settings),
                    Err(SettingsValidationError::InvalidFfmpegPath)
                ),
                "accepted {path:?}"
            );
        }
    }

    #[test]
    fn accepts_a_path_that_does_not_exist() {
        let mut settings = sample_settings(vec![]);
        settings.ffmpeg_path = Some("/this/path/does/not/exist/ffmpeg".to_owned());
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn round_trips_every_container_and_quality_kind() {
        for (container, wire) in [
            (Container::Mp4, "mp4"),
            (Container::Mov, "mov"),
            (Container::Mkv, "mkv"),
        ] {
            let json = serde_json::to_string(&container).unwrap();
            assert_eq!(json, format!("\"{wire}\""), "container was: {container:?}");
            assert_eq!(serde_json::from_str::<Container>(&json).unwrap(), container);
        }
        for (kind, wire) in [
            (QualityKind::Crf, "crf"),
            (QualityKind::Bitrate, "bitrate"),
            (QualityKind::QualityScale, "qualityScale"),
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{wire}\""), "kind was: {kind:?}");
            assert_eq!(serde_json::from_str::<QualityKind>(&json).unwrap(), kind);
        }
    }

    #[test]
    fn rejects_a_schema_version_other_than_one() {
        let mut settings = sample_settings(vec![]);
        settings.schema_version = 2;
        assert!(matches!(
            validate_settings(&settings),
            Err(SettingsValidationError::SchemaVersion {
                found: 2,
                expected: 1
            })
        ));
    }

    #[test]
    fn validate_settings_accepts_a_well_formed_document() {
        let mut custom_preset = sample_preset("custom");
        custom_preset.resolution = ResolutionSetting::Custom(Resolution { w: 1280, h: 720 });
        custom_preset.frame_rate = FrameRateSetting::Rate(Rational::new(24, 1).unwrap());
        let mut settings = sample_settings(vec![sample_preset("default"), custom_preset]);
        settings.active_preset_id = Some("default".to_owned());
        settings.ffmpeg_path = Some("/opt/homebrew/bin/ffmpeg".to_owned());
        assert!(validate_settings(&settings).is_ok());
    }

    // -- File operations: load, save, restore, reset, and the permissive accessor. --

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-settings-test-{}-{sequence}",
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

    /// Run `f` on a background thread and wait up to `timeout` for it to finish.
    /// [`restore_and_reset_do_not_deadlock`] uses this so that a real regression -- a
    /// `*_locked` helper calling the public [`save`] and deadlocking on the non-reentrant
    /// `Mutex` -- is reported instead of hanging forever.
    ///
    /// A timeout here means the worker is stuck holding [`SETTINGS_LOCK`], and it will never
    /// release it: the thread is detached and keeps running after this function returns, so
    /// every other settings test in the same process would then block behind that same lock
    /// forever. Returning `None` and letting the test merely fail would not prevent that; a
    /// plain `cargo test` run would still hang past this one failing test. So a timeout here
    /// ends the whole process instead, which fails fast rather than hanging CI to its job
    /// timeout.
    fn call_with_timeout<T: Send + 'static>(
        timeout: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(f());
        });
        match receiver.recv_timeout(timeout) {
            Ok(value) => Some(value),
            Err(_) => {
                // The worker still holds SETTINGS_LOCK and never will release it, so every
                // other settings test would block behind it. End the process instead of
                // hanging CI.
                eprintln!(
                    "settings deadlock probe timed out; the worker still holds SETTINGS_LOCK"
                );
                std::process::exit(101);
            }
        }
    }

    #[test]
    fn a_missing_file_loads_seeded_defaults_without_creating_it() {
        let directory = TestDirectory::new();
        let loaded = load(&directory.path).unwrap();
        assert!(loaded.seeded);
        assert_eq!(loaded.settings, defaults::seeded_settings());
        assert!(
            fs::read_dir(&directory.path).unwrap().next().is_none(),
            "load must not create the settings file, or anything else, in the directory"
        );
    }

    #[test]
    fn a_missing_app_data_directory_also_loads_seeded_defaults_without_creating_it() {
        let directory = TestDirectory::new();
        let missing = directory.path.join("does-not-exist");
        let loaded = load(&missing).unwrap();
        assert!(loaded.seeded);
        assert_eq!(loaded.settings, defaults::seeded_settings());
        assert!(
            !missing.exists(),
            "load must not create the application data directory either"
        );
    }

    #[test]
    fn save_then_load_round_trips_with_a_trailing_newline_and_no_leftover_temporary() {
        let directory = TestDirectory::new();
        let settings = sample_settings(vec![sample_preset("preset-1")]);
        save(&directory.path, &settings).unwrap();

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings, settings);

        let path = directory.path.join(SETTINGS_FILE_NAME);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));

        let leftover = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover, "a temporary settings file was left behind");
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_it_cannot_read_and_leaves_the_bytes_intact() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_from_a_future_schema_version() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        // Syntactically valid JSON, and even a schema-envelope-valid future document, but
        // this build must still refuse it: ADR 013 requires a later build's document to
        // survive an older build's save rather than being overwritten.
        let original_bytes = br#"{"schemaVersion":2,"presets":[],"somethingNew":true}"#.to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_that_fails_validation() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        // Well-formed JSON that deserializes cleanly but fails validate_settings: an unknown
        // activePresetId. The old "does this parse as JSON" guard would have accepted this
        // and overwritten it.
        let original_bytes =
            br#"{"schemaVersion":1,"presets":[],"activePresetId":"gone"}"#.to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_into_a_missing_directory_creates_it_and_succeeds() {
        let directory = TestDirectory::new();
        let nested = directory.path.join("nested").join("app-data");
        assert!(!nested.exists());

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        save(&nested, &settings).unwrap();

        assert!(nested.join(SETTINGS_FILE_NAME).is_file());
        assert_eq!(load(&nested).unwrap().settings, settings);
    }

    #[test]
    fn corrupt_json_is_an_error_not_a_silent_default() {
        let directory = TestDirectory::new();
        fs::write(directory.path.join(SETTINGS_FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::Json(_))
        ));
    }

    #[test]
    fn a_future_schema_version_is_typed_and_a_lower_one_is_a_validation_error() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let settings = sample_settings(vec![]);
        let mut value = serde_json::to_value(&settings).unwrap();

        value["schemaVersion"] = serde_json::json!(2);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::FutureSchemaVersion {
                found: 2,
                supported: 1
            })
        ));

        value["schemaVersion"] = serde_json::json!(0);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::Validation(
                SettingsValidationError::SchemaVersion {
                    found: 0,
                    expected: 1
                }
            ))
        ));
    }

    #[test]
    fn configured_ffmpeg_path_survives_a_damaged_preset() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let json = serde_json::json!({
            "schemaVersion": 1,
            "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
            "presets": [{"id": "broken", "container": "not-a-real-container"}],
            "activePresetId": "broken",
        });
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        // The strict surface really does reject this document; the probe below must still
        // find the path despite that failure, not because the document happens to be fine.
        assert!(load(&directory.path).is_err());
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/opt/homebrew/bin/ffmpeg"))
        );
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_missing_corrupt_or_future_file() {
        let directory = TestDirectory::new();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        let future = serde_json::json!({
            "schemaVersion": 2,
            "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
            "presets": [],
        });
        fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_blank_or_absent_path() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);

        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"schemaVersion": 1, "presets": []})).unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "ffmpegPath": "   ",
                "presets": [],
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_path_the_strict_surface_would_reject() {
        // validate_settings rejects a NUL-bearing ffmpegPath (InvalidFfmpegPath); the
        // permissive probe must reject it too, not report a path load/save would refuse.
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "ffmpegPath": "/a\0b",
                "presets": [],
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_reads_a_document_saved_through_the_strict_surface() {
        let directory = TestDirectory::new();
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.ffmpeg_path = Some("/usr/local/bin/ffmpeg".to_owned());
        save(&directory.path, &settings).unwrap();
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/usr/local/bin/ffmpeg"))
        );
    }

    #[test]
    fn restore_default_presets_replaces_an_edited_default_by_id_and_keeps_user_presets() {
        let directory = TestDirectory::new();
        let mut edited_default = defaults::default_presets().remove(0);
        edited_default.name = "Edited name".to_owned();
        edited_default.quality.value = 63;
        let user_preset = sample_preset("user-preset");

        let mut settings = sample_settings(vec![edited_default.clone(), user_preset.clone()]);
        settings.active_preset_id = Some(user_preset.id.clone());
        save(&directory.path, &settings).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();

        let restored_default = restored
            .presets
            .iter()
            .find(|preset| preset.id == edited_default.id)
            .unwrap();
        assert_eq!(restored_default, &defaults::default_presets()[0]);
        assert_ne!(restored_default.name, "Edited name");
        assert_eq!(
            restored.presets[0].id, edited_default.id,
            "the seed must replace the edited default in place, keeping display order"
        );

        assert!(restored
            .presets
            .iter()
            .any(|preset| preset.id == user_preset.id));
        assert_eq!(restored.active_preset_id, Some(user_preset.id));
        assert_eq!(load(&directory.path).unwrap().settings, restored);
    }

    #[test]
    fn restore_default_presets_keeps_the_configured_ffmpeg_path() {
        let directory = TestDirectory::new();
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.ffmpeg_path = Some("/opt/homebrew/bin/ffmpeg".to_owned());
        save(&directory.path, &settings).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();
        assert_eq!(
            restored.ffmpeg_path.as_deref(),
            Some("/opt/homebrew/bin/ffmpeg")
        );
        assert_eq!(
            load(&directory.path)
                .unwrap()
                .settings
                .ffmpeg_path
                .as_deref(),
            Some("/opt/homebrew/bin/ffmpeg")
        );
    }

    #[test]
    fn restore_default_presets_appends_missing_seeds_and_seeds_an_absent_active_preset() {
        let directory = TestDirectory::new();
        let empty = Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            ffmpeg_path: None,
            presets: vec![],
            active_preset_id: None,
        };
        save(&directory.path, &empty).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();
        let seed_ids: Vec<String> = defaults::default_presets()
            .into_iter()
            .map(|preset| preset.id)
            .collect();
        for id in &seed_ids {
            assert!(restored.presets.iter().any(|preset| &preset.id == id));
        }
        assert_eq!(restored.active_preset_id.as_ref(), Some(&seed_ids[0]));
    }

    #[test]
    fn restore_default_presets_on_a_missing_file_creates_it_with_the_seeds() {
        let directory = TestDirectory::new();
        let restored = restore_default_presets(&directory.path).unwrap();
        assert_eq!(restored, defaults::seeded_settings());
        assert!(directory.path.join(SETTINGS_FILE_NAME).is_file());
    }

    #[test]
    fn restore_default_presets_on_a_corrupt_existing_file_is_an_error() {
        let directory = TestDirectory::new();
        fs::write(directory.path.join(SETTINGS_FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            restore_default_presets(&directory.path),
            Err(SettingsFileError::Json(_))
        ));
    }

    #[test]
    fn restore_default_presets_refuses_rather_than_exceeding_the_preset_cap() {
        // With a full preset library, appending the seeds would push the count past
        // MAX_PRESETS. Refusing beats silently truncating the user's library, so this pins
        // that refusal -- and that nothing is written -- as documented behaviour rather than
        // a surprise.
        let directory = TestDirectory::new();
        let full_presets: Vec<Preset> = (0..MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        let settings = sample_settings(full_presets);
        save(&directory.path, &settings).unwrap();

        let seed_count = defaults::default_presets().len();
        let error = restore_default_presets(&directory.path).unwrap_err();
        assert!(matches!(
            error,
            SettingsFileError::Validation(SettingsValidationError::TooManyPresets { count })
                if count == MAX_PRESETS + seed_count
        ));

        // Nothing was written: the file on disk still holds the un-restored settings.
        assert_eq!(load(&directory.path).unwrap().settings, settings);
    }

    #[test]
    fn deleting_every_default_and_saving_does_not_reseed_on_the_next_load() {
        let directory = TestDirectory::new();
        let user_preset = sample_preset("only-user-preset");
        let mut settings = sample_settings(vec![user_preset.clone()]);
        settings.active_preset_id = Some(user_preset.id.clone());
        save(&directory.path, &settings).unwrap();

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings.presets.len(), 1);
        assert_eq!(loaded.settings.presets[0].id, user_preset.id);
    }

    #[test]
    fn reset_moves_the_damaged_file_aside_and_writes_defaults() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let original_bytes = b"{ this is not valid settings json".to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = reset(&directory.path).unwrap();
        assert_eq!(settings, defaults::seeded_settings());

        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        assert_eq!(fs::read(&backup_path).unwrap(), original_bytes);

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings, defaults::seeded_settings());
    }

    #[test]
    fn reset_with_no_existing_file_just_writes_seeds() {
        let directory = TestDirectory::new();
        let settings = reset(&directory.path).unwrap();
        assert_eq!(settings, defaults::seeded_settings());
        assert!(!directory.path.join(INVALID_SETTINGS_FILE_NAME).exists());
        assert_eq!(
            load(&directory.path).unwrap().settings,
            defaults::seeded_settings()
        );
    }

    #[test]
    fn reset_overwrites_a_previous_backup_rather_than_accumulating_files() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);

        fs::write(&path, b"first damaged file").unwrap();
        reset(&directory.path).unwrap();

        fs::write(&path, b"{ not json, second damage").unwrap();
        reset(&directory.path).unwrap();

        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        assert_eq!(
            fs::read(&backup_path).unwrap(),
            b"{ not json, second damage"
        );

        let entries: Vec<_> = fs::read_dir(&directory.path).unwrap().collect();
        assert_eq!(
            entries.len(),
            2,
            "only the live settings file and one fixed backup should exist"
        );
    }

    #[test]
    fn reset_writes_nothing_when_the_rename_fails() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let original_bytes = b"{ this is not valid settings json".to_vec();
        fs::write(&path, &original_bytes).unwrap();
        // A non-empty directory at the backup name makes fs::rename fail with something
        // other than NotFound.
        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        fs::create_dir(&backup_path).unwrap();
        fs::write(backup_path.join("occupied"), b"x").unwrap();

        let error = reset(&directory.path).unwrap_err();
        assert!(matches!(error, SettingsFileError::Io(_)));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_recovers_from_a_poisoned_lock() {
        let directory = TestDirectory::new();
        // Poison SETTINGS_LOCK from a thread that panics while holding it, the same way a
        // panicking save would. save's `PoisonError::into_inner` recovery must still hand
        // back a usable guard afterward instead of propagating the poison as a panic.
        let poison_result = thread::spawn(|| {
            let _guard = SETTINGS_LOCK.lock().unwrap();
            panic!("poison SETTINGS_LOCK on purpose for the recovery test");
        })
        .join();
        assert!(poison_result.is_err());
        assert!(SETTINGS_LOCK.is_poisoned());

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        save(&directory.path, &settings).unwrap();
        assert_eq!(load(&directory.path).unwrap().settings, settings);
    }

    #[test]
    fn restore_and_reset_do_not_deadlock() {
        let directory = TestDirectory::new();

        let restore_path = directory.path.clone();
        let restore_result = call_with_timeout(Duration::from_secs(5), move || {
            restore_default_presets(&restore_path)
        });
        assert!(
            restore_result.is_some(),
            "restore_default_presets did not return; it likely deadlocked on its own lock"
        );
        assert!(restore_result.unwrap().is_ok());

        let reset_path = directory.path.clone();
        let reset_result = call_with_timeout(Duration::from_secs(5), move || reset(&reset_path));
        assert!(
            reset_result.is_some(),
            "reset did not return; it likely deadlocked on its own lock"
        );
        assert!(reset_result.unwrap().is_ok());
    }

    #[test]
    fn file_name_constants_match_adr_013() {
        assert_eq!(SETTINGS_FILE_NAME, "settings.json");
        assert_eq!(INVALID_SETTINGS_FILE_NAME, "settings.invalid.json");
    }

    #[test]
    fn settings_file_error_display_messages_name_the_kind_of_failure() {
        let io_error = SettingsFileError::from(io::Error::other("boom"));
        assert!(io_error.to_string().contains("I/O"));

        let json_error =
            SettingsFileError::from(serde_json::from_str::<Settings>("{").unwrap_err());
        assert!(json_error.to_string().contains("JSON"));

        let validation_error = SettingsFileError::from(SettingsValidationError::InvalidFfmpegPath);
        assert!(validation_error.to_string().contains("values are invalid"));

        let future = SettingsFileError::FutureSchemaVersion {
            found: 9,
            supported: 1,
        };
        assert!(future.to_string().contains("newer than supported"));

        assert!(SettingsFileError::Unreadable
            .to_string()
            .contains("could not be read"));
    }
}
