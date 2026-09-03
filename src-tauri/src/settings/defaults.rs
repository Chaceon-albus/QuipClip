//! Seed data for a fresh `settings.json`.
//!
//! ADR 013: a missing settings file loads seeded presets in memory without writing anything,
//! and the first save is what actually persists them. Every seeded id here is a fixed
//! constant, never generated at runtime, so two loads of a missing file produce
//! byte-identical documents -- "not yet persisted" stays harmless, and a saved
//! `activePresetId` keeps naming the same preset across restarts. A `settings::tests` test
//! pins the exact id strings for this reason: renaming one would orphan a user's
//! `activePresetId`.
//!
//! Every seed here is an ordinary, editable, deletable preset once the document exists; ADR
//! 013 gives none of them special protection beyond what [`super::restore_default_presets`]
//! does on request.

use super::{
    Container, FrameRateSetting, Preset, Quality, QualityKind, ResolutionSetting, Settings,
    CURRENT_SCHEMA_VERSION,
};

/// The id of the default H.264-in-MP4 seed. [`seeded_settings`] selects this as the initial
/// `activePresetId`.
pub const DEFAULT_H264_MP4_ID: &str = "default-h264-mp4";

/// The id of the default HEVC-in-MP4 seed.
pub const DEFAULT_HEVC_MP4_ID: &str = "default-hevc-mp4";

/// The id of the macOS hardware seed, which names the `h264_videotoolbox` encoder.
pub const DEFAULT_VIDEOTOOLBOX_MP4_ID: &str = "default-videotoolbox-mp4";

/// The id of the Windows hardware seed, which names the `h264_nvenc` encoder.
pub const DEFAULT_NVENC_MP4_ID: &str = "default-nvenc-mp4";

/// The display name shared by both hardware seeds.
const HARDWARE_PRESET_NAME: &str = "H.264 MP4 (hardware)";

/// The bitrate, in kilobits per second, both hardware seeds use.
///
/// The hardware seeds use `bitrate`, not `qualityScale`, because `h264_videotoolbox` accepts
/// `-q:v` only on some hardware and ffmpeg builds, while every hardware encoder this
/// application targets accepts a bitrate unconditionally. A quality-scale seed would work on
/// some machines and silently fail to control quality on others; a bitrate seed works
/// everywhere.
const HARDWARE_PRESET_BITRATE_KBPS: u32 = 12_000;

/// Build a plain software preset with a CRF quality control. Both software seeds share this
/// shape and differ only in id, name, and encoder.
fn crf_preset(id: &str, name: &str, video_encoder: &str, crf: u32) -> Preset {
    Preset {
        id: id.to_owned(),
        name: name.to_owned(),
        container: Container::Mp4,
        video_encoder: video_encoder.to_owned(),
        audio_encoder: "aac".to_owned(),
        quality: Quality {
            kind: QualityKind::Crf,
            value: crf,
        },
        resolution: ResolutionSetting::Source,
        frame_rate: FrameRateSetting::Source,
    }
}

/// Build the platform hardware preset, or `None` on a platform with no hardware seed.
fn hardware_preset() -> Option<Preset> {
    let (id, video_encoder) = if cfg!(target_os = "macos") {
        (DEFAULT_VIDEOTOOLBOX_MP4_ID, "h264_videotoolbox")
    } else if cfg!(target_os = "windows") {
        (DEFAULT_NVENC_MP4_ID, "h264_nvenc")
    } else {
        return None;
    };
    Some(Preset {
        id: id.to_owned(),
        name: HARDWARE_PRESET_NAME.to_owned(),
        container: Container::Mp4,
        video_encoder: video_encoder.to_owned(),
        audio_encoder: "aac".to_owned(),
        quality: Quality {
            kind: QualityKind::Bitrate,
            value: HARDWARE_PRESET_BITRATE_KBPS,
        },
        resolution: ResolutionSetting::Source,
        frame_rate: FrameRateSetting::Source,
    })
}

/// Build the seeded export presets for this platform: H.264 in MP4, HEVC in MP4, and one
/// hardware preset selected by `cfg!(target_os = ...)`. A platform that is neither macOS nor
/// Windows gets only the two software seeds, never a third seed naming an encoder that
/// platform cannot have.
pub fn default_presets() -> Vec<Preset> {
    let mut presets = vec![
        crf_preset(DEFAULT_H264_MP4_ID, "H.264 MP4", "libx264", 20),
        crf_preset(DEFAULT_HEVC_MP4_ID, "HEVC MP4", "libx265", 24),
    ];
    if let Some(hardware) = hardware_preset() {
        presets.push(hardware);
    }
    presets
}

/// Build the whole seeded settings document: [`default_presets`], no configured ffmpeg path,
/// and [`DEFAULT_H264_MP4_ID`] selected as the active preset.
///
/// The seeded names are English. ADR 011 and ADR 013 both treat them as user data from the
/// moment the file exists -- a user can rename or delete any of them -- so the interface must
/// not translate them.
pub fn seeded_settings() -> Settings {
    Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        ffmpeg_path: None,
        presets: default_presets(),
        active_preset_id: Some(DEFAULT_H264_MP4_ID.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::validate_settings;

    #[test]
    fn every_default_preset_id_is_pinned() {
        assert_eq!(DEFAULT_H264_MP4_ID, "default-h264-mp4");
        assert_eq!(DEFAULT_HEVC_MP4_ID, "default-hevc-mp4");
        assert_eq!(DEFAULT_VIDEOTOOLBOX_MP4_ID, "default-videotoolbox-mp4");
        assert_eq!(DEFAULT_NVENC_MP4_ID, "default-nvenc-mp4");
    }

    #[test]
    fn seed_ids_are_stable_across_two_loads() {
        let first = default_presets();
        let second = default_presets();
        let first_ids: Vec<&str> = first.iter().map(|preset| preset.id.as_str()).collect();
        let second_ids: Vec<&str> = second.iter().map(|preset| preset.id.as_str()).collect();
        assert_eq!(first_ids, second_ids);
    }

    #[test]
    fn the_seeded_presets_all_pass_validation() {
        assert!(validate_settings(&seeded_settings()).is_ok());
    }

    #[test]
    fn the_software_seeds_name_the_encoders_adr_013_lists() {
        // Pins the seed table's actual content, not just its ids: ADR 013 names libx264 and
        // libx265 by name, both under a CRF quality control.
        let presets = default_presets();
        assert_eq!(presets[0].video_encoder, "libx264");
        assert_eq!(presets[0].container, Container::Mp4);
        assert_eq!(presets[0].quality.kind, QualityKind::Crf);
        assert_eq!(presets[1].video_encoder, "libx265");
        assert_eq!(presets[1].quality.kind, QualityKind::Crf);
    }

    #[test]
    fn the_hardware_seed_controls_quality_with_a_bitrate_never_a_quality_scale() {
        // Every hardware encoder this application targets accepts a bitrate unconditionally;
        // only some accept a quality scale. A QualityScale seed here would silently fail to
        // control quality on the hardware that does not support it.
        let Some(hardware) = hardware_preset() else {
            return;
        };
        assert_eq!(hardware.quality.kind, QualityKind::Bitrate);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn a_platform_with_no_hardware_encoder_gets_the_two_software_seeds_only() {
        assert_eq!(default_presets().len(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_seeds_the_videotoolbox_hardware_preset() {
        let presets = default_presets();
        let ids: Vec<&str> = presets.iter().map(|preset| preset.id.as_str()).collect();
        assert!(ids.contains(&DEFAULT_VIDEOTOOLBOX_MP4_ID));
        assert!(!ids.contains(&DEFAULT_NVENC_MP4_ID));
        assert_eq!(presets.len(), 3);
        assert_eq!(presets[2].video_encoder, "h264_videotoolbox");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_seeds_the_nvenc_hardware_preset() {
        let presets = default_presets();
        let ids: Vec<&str> = presets.iter().map(|preset| preset.id.as_str()).collect();
        assert!(ids.contains(&DEFAULT_NVENC_MP4_ID));
        assert!(!ids.contains(&DEFAULT_VIDEOTOOLBOX_MP4_ID));
        assert_eq!(presets.len(), 3);
        assert_eq!(presets[2].video_encoder, "h264_nvenc");
    }

    #[test]
    fn seeded_settings_selects_the_h264_preset_as_active() {
        let settings = seeded_settings();
        assert_eq!(
            settings.active_preset_id.as_deref(),
            Some(DEFAULT_H264_MP4_ID)
        );
    }
}
