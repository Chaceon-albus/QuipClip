//! Document types and validation for the application settings file.
//!
//! ADR 013 defines the on-disk shape: `<app_data>/settings.json`, at schema version 1,
//! holding an optional ffmpeg path, a list of export presets, and an optional active preset
//! id. This module holds only the pure parts of that decision -- the serde types and
//! [`validate_settings`] -- with no file I/O. Loading, saving, seeding, and the read/write
//! lock belong to a separate unit.

use crate::project::Resolution;
use crate::time::Rational;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;

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
}
