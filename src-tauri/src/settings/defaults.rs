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
//!
//! # The seeds
//!
//! | Id | Platform | Video | Encoder options |
//! | --- | --- | --- | --- |
//! | [`DEFAULT_H264_MP4_ID`] | every | `libx264`, CRF 20, `yuv420p` | `preset`, `x264-params` |
//! | [`DEFAULT_AV1_MP4_ID`] | every | `libsvtav1`, CRF 38, `yuv420p10le` | `preset`, `g`, `svtav1-params` |
//! | [`DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID`] | macOS | `hevc_videotoolbox`, quality scale 80, `p010le` | see `hevc_videotoolbox_preset` |
//! | [`DEFAULT_NVENC_MP4_ID`] | Windows | `h264_nvenc`, CQ 25, `yuv420p` | see `nvenc_options` |
//! | [`DEFAULT_HEVC_NVENC_MP4_ID`] | Windows | `hevc_nvenc`, CQ 25, `p010le` | the H.264 ones and `tag hvc1` |
//!
//! Every seed writes AAC at 320 kbps, at the sample rate and with the channels of the source,
//! into MP4.
//!
//! An encoder option that only repeats the default of its encoder, or that changes nothing in
//! practice, is left out of a seed. An option name that an older ffmpeg does not know ends the
//! export with an error, so each option a seed carries is one more way for the seed to fail. The
//! options left out are:
//!
//! - `-realtime 0` and `-allow_sw 0` of VideoToolbox, which are its defaults.
//! - `-power_efficient 0` of VideoToolbox. Its ffmpeg default is -1, which leaves the property
//!   unset, and the system then does not prefer power efficiency, so 0 is expected to change
//!   nothing.
//! - `-tune hq` and `-aq-strength 8` of NVENC, which are its defaults.
//! - `-b:v 0`, which the `cq` and quality-scale kinds write or do not need.
//!
//! The NVENC seeds keep `-g 250`. The ffmpeg default of `g` for NVENC is -1, which takes the GOP
//! length of the NVIDIA preset, and that length is not known. `g` is a generic codec option, so
//! every ffmpeg knows it.
//!
//! The VideoToolbox seed carries `-spatial_aq 1`, which FFmpeg added in 8.0. On an older FFmpeg
//! that seed fails with an unknown option, and the test of a preset on this machine reports it.
//!
//! # Retired seeds
//!
//! An id in [`RETIRED_SEED_IDS`] named a seed of an earlier release, and no seed uses it again.
//! Restore replaces each seed by id and appends a seed that is absent (ADR 013), so a retired
//! seed in a library stays there as an ordinary preset of the user's, unchanged. A seed that
//! keeps the id of an earlier seed also keeps its codec, so a restore never turns a preset that
//! wrote H.264 into one that writes something else.

use super::{
    AudioChannels, AudioSampleRateSetting, Container, FrameRateSetting, Preset, PresetOption,
    Quality, QualityKind, ResolutionSetting, Settings, CURRENT_SCHEMA_VERSION,
};

/// The id of the default H.264-in-MP4 seed. [`seeded_settings`] selects this as the initial
/// `activePresetId`.
pub const DEFAULT_H264_MP4_ID: &str = "default-h264-mp4";

/// The id of the AV1-in-MP4 seed, which names the `libsvtav1` encoder.
pub const DEFAULT_AV1_MP4_ID: &str = "default-av1-mp4";

/// The id of the macOS hardware seed, which names the `hevc_videotoolbox` encoder.
pub const DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID: &str = "default-hevc-videotoolbox-mp4";

/// The id of the Windows hardware seed that names the `h264_nvenc` encoder. The first release
/// used this id for the same encoder, so it stays.
pub const DEFAULT_NVENC_MP4_ID: &str = "default-nvenc-mp4";

/// The id of the Windows hardware seed that names the `hevc_nvenc` encoder.
pub const DEFAULT_HEVC_NVENC_MP4_ID: &str = "default-hevc-nvenc-mp4";

/// The ids of seeds that an earlier release shipped and this one does not: the `libx265` seed
/// and the `h264_videotoolbox` seed of v0.1.0. No seed may use one of them again, because a
/// library of that release can still hold a preset with that id. See this module's
/// documentation.
pub const RETIRED_SEED_IDS: &[&str] = &["default-hevc-mp4", "default-videotoolbox-mp4"];

/// The audio bitrate, in kilobits per second, every seed uses.
///
/// ADR 023 exists because a seed that named `aac` and no bitrate ran the native encoder at its
/// own default of 128 kbps, which the user reported as too low for an export. Every seed pairs
/// this with the source sample rate and the source channel layout, so the filter graph of a
/// seed resamples nothing and mixes nothing down. ffmpeg still converts, in front of the
/// encoder, only what the encoder cannot accept (ADR 023 measurement 3): native `aac` accepts
/// at most 96000 Hz, for example, so a 192000 Hz source is still resampled.
const SEED_AUDIO_BITRATE_KBPS: u32 = 320;

/// Build the encoder options of a seed from pairs of a name and a value.
fn options(pairs: &[(&str, &str)]) -> Vec<PresetOption> {
    pairs
        .iter()
        .map(|(name, value)| PresetOption {
            name: (*name).to_owned(),
            value: (*value).to_owned(),
        })
        .collect()
}

/// Build one seed: MP4, AAC at [`SEED_AUDIO_BITRATE_KBPS`] at the rate and with the channels
/// of the source, the resolution and the frame rate of the source, no audio options, and the
/// video settings given.
fn seed(
    id: &str,
    name: &str,
    video_encoder: &str,
    quality: Quality,
    pixel_format: &str,
    video_options: Vec<PresetOption>,
) -> Preset {
    Preset {
        id: id.to_owned(),
        name: name.to_owned(),
        container: Container::Mp4,
        video_encoder: video_encoder.to_owned(),
        audio_encoder: "aac".to_owned(),
        audio_bitrate: Some(SEED_AUDIO_BITRATE_KBPS),
        audio_sample_rate: AudioSampleRateSetting::Source,
        audio_channels: AudioChannels::Source,
        quality,
        resolution: ResolutionSetting::Source,
        frame_rate: FrameRateSetting::Source,
        pixel_format: pixel_format.to_owned(),
        video_options,
        audio_options: vec![],
    }
}

/// The H.264 seed: `libx264` at CRF 20 and the `slow` preset, with the x264 settings of the
/// user's own exports.
fn h264_preset() -> Preset {
    seed(
        DEFAULT_H264_MP4_ID,
        "H.264 MP4",
        "libx264",
        Quality {
            kind: QualityKind::Crf,
            value: 20,
        },
        "yuv420p",
        options(&[
            ("preset", "slow"),
            (
                "x264-params",
                "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0:qcomp=0.65:rc-lookahead=60:bframes=6:b-adapt=2",
            ),
        ]),
    )
}

/// The AV1 seed: `libsvtav1` at CRF 38 and preset 5, 10-bit, with a key frame every 250
/// frames. `libsvtav1` sets `g` to -1, which leaves the key frame interval to SVT-AV1, so the
/// seed names it.
fn av1_preset() -> Preset {
    seed(
        DEFAULT_AV1_MP4_ID,
        "AV1 MP4",
        "libsvtav1",
        Quality {
            kind: QualityKind::Crf,
            value: 38,
        },
        "yuv420p10le",
        options(&[
            ("preset", "5"),
            ("g", "250"),
            (
                "svtav1-params",
                "tune=0:enable-variance-boost=1:variance-boost-strength=2:film-grain=0",
            ),
        ]),
    )
}

/// The macOS hardware seed: `hevc_videotoolbox` at quality 80, 10-bit Main 10, tagged `hvc1`
/// so that the players of Apple open the MP4.
///
/// The quality scale is the `-q:v` of VideoToolbox. FFmpeg offers it on Apple silicon only,
/// and refuses it with an error on an Intel Mac. `g 300` is named because the generic default
/// of `g` is 12, which VideoToolbox would read as a key frame every 12 frames. `spatial_aq` is
/// an option of FFmpeg 8.0 and later.
fn hevc_videotoolbox_preset() -> Preset {
    seed(
        DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID,
        "HEVC MP4 (hardware)",
        "hevc_videotoolbox",
        Quality {
            kind: QualityKind::QualityScale,
            value: 80,
        },
        "p010le",
        options(&[
            ("profile", "main10"),
            ("prio_speed", "0"),
            ("spatial_aq", "1"),
            ("bf", "3"),
            ("g", "300"),
            ("tag", "hvc1"),
        ]),
    )
}

/// The encoder options both NVENC seeds share: the slowest preset, variable bitrate with no
/// bitrate cap (the constant quality alone controls it), two full-resolution passes, a
/// look-ahead of 32 frames, spatial and temporal adaptive quantization, and three B-frames,
/// the middle one a reference.
fn nvenc_options() -> Vec<PresetOption> {
    options(&[
        ("preset", "p7"),
        ("rc", "vbr"),
        ("multipass", "fullres"),
        ("rc-lookahead", "32"),
        ("spatial-aq", "1"),
        ("temporal-aq", "1"),
        ("bf", "3"),
        ("b_ref_mode", "middle"),
        ("g", "250"),
    ])
}

/// The Windows H.264 hardware seed: `h264_nvenc` at CQ 25.
fn h264_nvenc_preset() -> Preset {
    seed(
        DEFAULT_NVENC_MP4_ID,
        "H.264 MP4 (hardware)",
        "h264_nvenc",
        Quality {
            kind: QualityKind::Cq,
            value: 25,
        },
        "yuv420p",
        nvenc_options(),
    )
}

/// The Windows HEVC hardware seed: `hevc_nvenc` at CQ 25, 10-bit, tagged `hvc1`.
fn hevc_nvenc_preset() -> Preset {
    let mut video_options = nvenc_options();
    video_options.extend(options(&[("tag", "hvc1")]));
    seed(
        DEFAULT_HEVC_NVENC_MP4_ID,
        "HEVC MP4 (hardware)",
        "hevc_nvenc",
        Quality {
            kind: QualityKind::Cq,
            value: 25,
        },
        "p010le",
        video_options,
    )
}

/// Build the hardware seeds of this platform: the VideoToolbox one on macOS, the two NVENC
/// ones on Windows, and none elsewhere, so no platform gets a seed naming an encoder that
/// platform cannot have.
fn hardware_presets() -> Vec<Preset> {
    if cfg!(target_os = "macos") {
        vec![hevc_videotoolbox_preset()]
    } else if cfg!(target_os = "windows") {
        vec![h264_nvenc_preset(), hevc_nvenc_preset()]
    } else {
        vec![]
    }
}

/// Build the seeded export presets for this platform: H.264 in MP4, AV1 in MP4, and the
/// hardware seeds of `hardware_presets`, in that order. See this module's documentation for
/// the table.
pub fn default_presets() -> Vec<Preset> {
    let mut presets = vec![h264_preset(), av1_preset()];
    presets.extend(hardware_presets());
    presets
}

/// The seeds of every platform, in the order of the table in this module's documentation, for a
/// test that must cover each seed on any host, such as the golden commands of the preset test.
#[cfg(test)]
pub(crate) fn every_platform_seed() -> Vec<Preset> {
    vec![
        h264_preset(),
        av1_preset(),
        hevc_videotoolbox_preset(),
        h264_nvenc_preset(),
        hevc_nvenc_preset(),
    ]
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
        // Revision 0, the same value `#[serde(default)]` gives a document written before that
        // field existed, so the first save over either compares 0 against 0 and succeeds.
        revision: 0,
        ffmpeg_path: None,
        presets: default_presets(),
        active_preset_id: Some(DEFAULT_H264_MP4_ID.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::{
        build_arguments, build_audio_arguments, build_audio_graph, build_plan, encoder_graph,
        ExportPlan, ExportStreams, GraphShape, PathFacts, PathIdentity, PlanRequest,
        SegmentBoundary,
    };
    use crate::ffmpeg::{AudioProbe, MediaProbe};
    use crate::settings::{
        load, restore_default_presets, validate_settings, SETTINGS_FILE_NAME, VERSION_1_FIXTURE,
    };
    use crate::time::{Pts, Rational};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn ids(presets: &[Preset]) -> Vec<&str> {
        presets.iter().map(|preset| preset.id.as_str()).collect()
    }

    #[test]
    fn every_default_preset_id_is_pinned() {
        assert_eq!(DEFAULT_H264_MP4_ID, "default-h264-mp4");
        assert_eq!(DEFAULT_AV1_MP4_ID, "default-av1-mp4");
        assert_eq!(
            DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID,
            "default-hevc-videotoolbox-mp4"
        );
        assert_eq!(DEFAULT_NVENC_MP4_ID, "default-nvenc-mp4");
        assert_eq!(DEFAULT_HEVC_NVENC_MP4_ID, "default-hevc-nvenc-mp4");
        assert_eq!(
            RETIRED_SEED_IDS,
            &["default-hevc-mp4", "default-videotoolbox-mp4"]
        );
    }

    #[test]
    fn no_seed_of_any_platform_reuses_a_retired_id() {
        // Every seed of every platform, built directly, so the test holds on each platform.
        for preset in [
            h264_preset(),
            av1_preset(),
            hevc_videotoolbox_preset(),
            h264_nvenc_preset(),
            hevc_nvenc_preset(),
        ] {
            assert!(
                !RETIRED_SEED_IDS.contains(&preset.id.as_str()),
                "{} reuses a retired id",
                preset.id
            );
        }
    }

    #[test]
    fn a_reused_id_keeps_the_codec_of_the_first_release() {
        // v0.1.0 seeded `default-h264-mp4` with libx264 and `default-nvenc-mp4` with h264_nvenc.
        // A restore replaces a seed by id, so a reused id that changed its codec would turn a
        // preset that wrote H.264 into one that writes something else.
        assert_eq!(h264_preset().video_encoder, "libx264");
        assert_eq!(h264_nvenc_preset().video_encoder, "h264_nvenc");
    }

    #[test]
    fn seed_ids_are_stable_across_two_loads() {
        let first = default_presets();
        let second = default_presets();
        assert_eq!(ids(&first), ids(&second));
    }

    #[test]
    fn the_seeded_presets_all_pass_validation_on_every_platform() {
        assert!(validate_settings(&seeded_settings()).is_ok());
        // The seeds of the other platforms too: a seed this build does not ship still has to be
        // valid on the platform that does.
        let mut every = seeded_settings();
        every.presets = vec![
            h264_preset(),
            av1_preset(),
            hevc_videotoolbox_preset(),
            h264_nvenc_preset(),
            hevc_nvenc_preset(),
        ];
        assert!(validate_settings(&every).is_ok());
    }

    #[test]
    fn every_seed_writes_320_kbps_aac_at_the_source_rate_and_layout_into_mp4() {
        // ADR 023's seed values. `restore_default_presets` writes these over an older seed with
        // the same id, so pinning them here pins what a restore gives a user too.
        for preset in [
            h264_preset(),
            av1_preset(),
            hevc_videotoolbox_preset(),
            h264_nvenc_preset(),
            hevc_nvenc_preset(),
        ] {
            assert_eq!(preset.container, Container::Mp4, "{}", preset.id);
            assert_eq!(preset.audio_encoder, "aac", "{}", preset.id);
            assert_eq!(preset.audio_bitrate, Some(320), "{}", preset.id);
            assert_eq!(
                preset.audio_sample_rate,
                AudioSampleRateSetting::Source,
                "{}",
                preset.id
            );
            assert_eq!(
                preset.audio_channels,
                AudioChannels::Source,
                "{}",
                preset.id
            );
            assert!(preset.audio_options.is_empty(), "{}", preset.id);
        }
    }

    #[test]
    fn no_seed_repeats_an_encoder_default_that_the_seed_table_leaves_out() {
        // These names only repeat a default of their encoder, and a name an older ffmpeg does
        // not know ends the export, so no seed carries them. `-b:v 0` belongs to the cq kind.
        for preset in [
            hevc_videotoolbox_preset(),
            h264_nvenc_preset(),
            hevc_nvenc_preset(),
        ] {
            for name in [
                "realtime",
                "allow_sw",
                "power_efficient",
                "tune",
                "aq-strength",
            ] {
                assert!(
                    !preset
                        .video_options
                        .iter()
                        .any(|option| option.name == name),
                    "{} carries {name}",
                    preset.id
                );
            }
        }
        // The user chose pure constant quality, so no NVENC seed caps the bitrate.
        for preset in [h264_nvenc_preset(), hevc_nvenc_preset()] {
            for name in ["maxrate", "bufsize"] {
                assert!(
                    !preset
                        .video_options
                        .iter()
                        .any(|option| option.name == name),
                    "{} carries {name}",
                    preset.id
                );
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn a_platform_with_no_hardware_encoder_gets_the_two_software_seeds_only() {
        assert_eq!(
            ids(&default_presets()),
            vec![DEFAULT_H264_MP4_ID, DEFAULT_AV1_MP4_ID]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_seeds_h264_av1_and_the_videotoolbox_hevc_preset() {
        assert_eq!(
            ids(&default_presets()),
            vec![
                DEFAULT_H264_MP4_ID,
                DEFAULT_AV1_MP4_ID,
                DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_seeds_h264_av1_and_both_nvenc_presets() {
        assert_eq!(
            ids(&default_presets()),
            vec![
                DEFAULT_H264_MP4_ID,
                DEFAULT_AV1_MP4_ID,
                DEFAULT_NVENC_MP4_ID,
                DEFAULT_HEVC_NVENC_MP4_ID
            ]
        );
    }

    #[test]
    fn seeded_settings_selects_the_h264_preset_as_active() {
        let settings = seeded_settings();
        assert_eq!(
            settings.active_preset_id.as_deref(),
            Some(DEFAULT_H264_MP4_ID)
        );
        assert_eq!(settings.presets[0].id, DEFAULT_H264_MP4_ID);
    }

    // -- The command each seed renders. --

    /// The source the golden commands cut from, and the reservation they write.
    #[cfg(windows)]
    const SOURCE: &str = r"C:\media\source.mov";
    #[cfg(windows)]
    const DESTINATION: &str = r"C:\export\out.mp4";
    #[cfg(windows)]
    const DESTINATION_PARENT: &str = r"C:\export";
    #[cfg(windows)]
    const RESERVATION: &str = r"C:\export\.out.mp4.tmp-4242-0";
    #[cfg(not(windows))]
    const SOURCE: &str = "/media/source.mov";
    #[cfg(not(windows))]
    const DESTINATION: &str = "/export/out.mp4";
    #[cfg(not(windows))]
    const DESTINATION_PARENT: &str = "/export";
    #[cfg(not(windows))]
    const RESERVATION: &str = "/export/.out.mp4.tmp-4242-0";

    /// A 30 fps source with 48000 Hz stereo audio, in a 1/90000 time base.
    fn probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: Some("yuv420p".to_owned()),
            bit_depth: Some(8),
            width: 1920,
            height: 1080,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: Some(Pts::new(0)),
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: None,
            audio: Some(AudioProbe {
                index: 1,
                codec: Some("aac".to_owned()),
                sample_rate: Some(48_000),
                channels: Some(2),
                start_time: None,
                duration: None,
                tagged_end: None,
                channel_layout: None,
                reported_packets: None,
                holds_no_packets: false,
            }),
        }
    }

    /// The command `preset` renders for one segment from 10 s to 12 s of [`probe`].
    fn command_of(preset: &Preset) -> Vec<String> {
        let plan = plan_of(preset);
        let graph = encoder_graph(&plan, GraphShape::InputPerSegment);
        build_arguments(
            &plan,
            GraphShape::InputPerSegment,
            &graph,
            Path::new(RESERVATION),
        )
    }

    /// The plan of [`command_of`].
    fn plan_of(preset: &Preset) -> ExportPlan {
        let segments = [SegmentBoundary {
            in_pts: Pts::new(900_000),
            out_pts: Pts::new(1_080_000),
        }];
        let source = PathBuf::from(SOURCE);
        let destination = PathBuf::from(DESTINATION);
        let parent = PathBuf::from(DESTINATION_PARENT);
        build_plan(
            &PlanRequest {
                source: &source,
                destination: &destination,
                segments: &segments,
                probe: &probe(),
                preset,
                streams: ExportStreams::VideoAndAudio,
                audio_gaps: &[],
            },
            |path: &Path| {
                if path == source {
                    PathFacts::File {
                        identity: PathIdentity::new(1),
                        read_only: false,
                    }
                } else if path == parent {
                    PathFacts::Directory
                } else {
                    PathFacts::Absent
                }
            },
        )
        .expect("the seed plans")
    }

    /// Every argument in front of `-c:v`, which only the pixel format of a seed changes: the
    /// process flags, the seek 5 s before the In point, the input, the pipe of the audio process
    /// (ADR 043), the graph, and the maps.
    fn head(pixel_format: &str) -> Vec<String> {
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-y",
            "-copyts",
            "-ss",
            "5",
            "-i",
            SOURCE,
            "-f",
            "wav",
            "-i",
            "pipe:0",
            "-filter_complex",
            &format!(
                "[vc]format={pixel_format}[v];\
                 [0:0]trim=start_pts=900000:end_pts=1080000,setpts=PTS-STARTPTS,fps=30/1[v0];\
                 anullsrc=r=48000:cl=mono,atrim=end_sample=96000,aformat=f=fltp:r=48000[pa0];\
                 [v0][pa0]concat=n=1:v=1:a=1[vc][pa];[pa]anullsink"
            ),
            "-map",
            "[v]",
            "-map",
            "1:a",
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect()
    }

    /// The arguments behind the video options, which every seed shares: AAC at 320 kbps into
    /// MP4, written to the reservation.
    fn tail() -> Vec<String> {
        [
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            RESERVATION,
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect()
    }

    /// The golden command of a seed: [`head`], the video arguments of the seed, and [`tail`].
    fn golden(pixel_format: &str, video: &[&str]) -> Vec<String> {
        let mut command = head(pixel_format);
        command.extend(video.iter().map(|argument| (*argument).to_owned()));
        command.extend(tail());
        command
    }

    #[test]
    fn every_seed_renders_the_golden_command_of_its_audio_process() {
        // The audio process reads the same input, writes the cut audio at the length of the
        // segment against a stand-in video of 60 frames, and sends it to the encoder as WAV. The
        // video settings of a seed do not reach it, and the seeds share their audio settings.
        let golden: Vec<String> = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-copyts",
            "-ss",
            "5",
            "-i",
            SOURCE,
            "-filter_complex",
            "color=s=2x2:r=30/1,trim=end_frame=60[pv0];\
             [0:1]aformat=r=48000,atrim=start_pts=480000:end_pts=576000,\
             asetpts=PTS-480000,aresample=48000:first_pts=0,apad=whole_len=96000,\
             atrim=end_sample=96000,asetpts=N,aformat=f=fltp:r=48000[a0];\
             [pv0][a0]concat=n=1:v=1:a=1[pv][a]",
            "-map",
            "[a]",
            "-c:a",
            "pcm_f32le",
            "-f",
            "wav",
            "pipe:1",
            "-map",
            "[pv]",
            "-c:v",
            "rawvideo",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect();
        for preset in default_presets() {
            let plan = plan_of(&preset);
            let graph = build_audio_graph(&plan, GraphShape::InputPerSegment);
            assert_eq!(
                build_audio_arguments(&plan, GraphShape::InputPerSegment, &graph),
                golden,
                "{}",
                preset.id
            );
        }
    }

    #[test]
    fn the_h264_seed_renders_its_golden_command() {
        assert_eq!(
            command_of(&h264_preset()),
            golden(
                "yuv420p",
                &[
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-crf",
                    "20",
                    "-preset:v",
                    "slow",
                    "-x264-params:v",
                    "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0:qcomp=0.65:rc-lookahead=60:bframes=6:b-adapt=2",
                ]
            )
        );
    }

    #[test]
    fn the_av1_seed_renders_its_golden_command() {
        assert_eq!(
            command_of(&av1_preset()),
            golden(
                "yuv420p10le",
                &[
                    "-c:v",
                    "libsvtav1",
                    "-pix_fmt",
                    "yuv420p10le",
                    "-crf",
                    "38",
                    "-preset:v",
                    "5",
                    "-g:v",
                    "250",
                    "-svtav1-params:v",
                    "tune=0:enable-variance-boost=1:variance-boost-strength=2:film-grain=0",
                ]
            )
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_videotoolbox_hevc_seed_renders_its_golden_command() {
        let presets = default_presets();
        let seed = presets
            .iter()
            .find(|preset| preset.id == DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID)
            .expect("macOS seeds the VideoToolbox preset");
        assert_eq!(
            command_of(seed),
            golden(
                "p010le",
                &[
                    "-c:v",
                    "hevc_videotoolbox",
                    "-pix_fmt",
                    "p010le",
                    "-q:v",
                    "80",
                    "-profile:v",
                    "main10",
                    "-prio_speed:v",
                    "0",
                    "-spatial_aq:v",
                    "1",
                    "-bf:v",
                    "3",
                    "-g:v",
                    "300",
                    "-tag:v",
                    "hvc1",
                ]
            )
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_nvenc_seeds_render_their_golden_commands() {
        let presets = default_presets();
        let find = |id: &str| -> &Preset {
            presets
                .iter()
                .find(|preset| preset.id == id)
                .expect("Windows seeds both NVENC presets")
        };
        let nvenc = [
            "-preset:v",
            "p7",
            "-rc:v",
            "vbr",
            "-multipass:v",
            "fullres",
            "-rc-lookahead:v",
            "32",
            "-spatial-aq:v",
            "1",
            "-temporal-aq:v",
            "1",
            "-bf:v",
            "3",
            "-b_ref_mode:v",
            "middle",
            "-g:v",
            "250",
        ];

        let mut h264 = vec![
            "-c:v",
            "h264_nvenc",
            "-pix_fmt",
            "yuv420p",
            "-cq",
            "25",
            "-b:v",
            "0",
        ];
        h264.extend(nvenc);
        assert_eq!(
            command_of(find(DEFAULT_NVENC_MP4_ID)),
            golden("yuv420p", &h264)
        );

        let mut hevc = vec![
            "-c:v",
            "hevc_nvenc",
            "-pix_fmt",
            "p010le",
            "-cq",
            "25",
            "-b:v",
            "0",
        ];
        hevc.extend(nvenc);
        hevc.extend(["-tag:v", "hvc1"]);
        assert_eq!(
            command_of(find(DEFAULT_HEVC_NVENC_MP4_ID)),
            golden("p010le", &hevc)
        );
    }

    // -- Restore over a library of the first release. --

    static TEST_DIRECTORY_COUNTER: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence =
                TEST_DIRECTORY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-defaults-test-{}-{sequence}",
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

    #[test]
    fn restore_over_a_version_1_library_replaces_the_reused_seeds_appends_the_new_ones_and_keeps_the_retired_ones(
    ) {
        // The macOS library of the first release, with the NVENC seed of its Windows build
        // added, so both platforms see a reused seed id of their own platform replaced.
        let directory = TestDirectory::new();
        let mut library: serde_json::Value = serde_json::from_str(VERSION_1_FIXTURE).unwrap();
        library["presets"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "default-nvenc-mp4",
                "name": "H.264 MP4 (hardware)",
                "container": "mp4",
                "videoEncoder": "h264_nvenc",
                "audioEncoder": "aac",
                "audioBitrate": 320,
                "audioSampleRate": "source",
                "audioChannels": "source",
                "quality": { "kind": "bitrate", "value": 12000 },
                "resolution": "source",
                "frameRate": "source"
            }));
        fs::write(
            directory.path.join(SETTINGS_FILE_NAME),
            serde_json::to_vec(&library).unwrap(),
        )
        .unwrap();
        let before = load(&directory.path).unwrap().settings;
        assert_eq!(before.schema_version, 2);

        let restored = restore_default_presets(&directory.path).unwrap();
        assert_eq!(restored.schema_version, 2);
        assert_eq!(restored.revision, before.revision + 1);
        assert_eq!(restored.ffmpeg_path, before.ffmpeg_path);
        // Restore keeps the active preset, which is the user's own here.
        assert_eq!(restored.active_preset_id.as_deref(), Some("user-prores"));

        // Each preset of the library keeps its place. A seed id the library held now holds
        // the seed, and every other preset is the one the library held, unchanged: the two
        // retired seeds and the user's own preset.
        let seeds = default_presets();
        for (index, old) in before.presets.iter().enumerate() {
            let now = &restored.presets[index];
            assert_eq!(now.id, old.id);
            match seeds.iter().find(|seed| seed.id == old.id) {
                Some(seed) => assert_eq!(now, seed, "{}", old.id),
                None => assert_eq!(now, old, "{}", old.id),
            }
        }
        for retired in RETIRED_SEED_IDS {
            let kept = restored
                .presets
                .iter()
                .find(|preset| preset.id == *retired)
                .expect("a retired seed stays in the library");
            assert_eq!(
                Some(kept),
                before.presets.iter().find(|preset| preset.id == *retired)
            );
        }
        assert_eq!(
            restored
                .presets
                .iter()
                .find(|preset| preset.id == "default-hevc-mp4")
                .map(|preset| preset.video_encoder.as_str()),
            Some("libx265")
        );

        // The seeds the library did not hold follow, in seed order.
        let appended: Vec<&str> = ids(&restored.presets[before.presets.len()..]);
        let expected: Vec<&str> = seeds
            .iter()
            .filter(|seed| !before.presets.iter().any(|old| old.id == seed.id))
            .map(|seed| seed.id.as_str())
            .collect();
        assert_eq!(appended, expected);
        assert!(appended.contains(&DEFAULT_AV1_MP4_ID));
        #[cfg(target_os = "macos")]
        assert_eq!(
            appended,
            vec![DEFAULT_AV1_MP4_ID, DEFAULT_HEVC_VIDEOTOOLBOX_MP4_ID]
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            appended,
            vec![DEFAULT_AV1_MP4_ID, DEFAULT_HEVC_NVENC_MP4_ID]
        );

        // The NVENC seed of the first release is the seed of this release on Windows, and an
        // ordinary preset elsewhere.
        let nvenc = restored
            .presets
            .iter()
            .find(|preset| preset.id == DEFAULT_NVENC_MP4_ID)
            .unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!(nvenc, &h264_nvenc_preset());
        } else {
            assert_eq!(
                nvenc.quality,
                Quality {
                    kind: QualityKind::Bitrate,
                    value: 12_000
                }
            );
        }

        // The H.264 seed the library held is the seed of this release now.
        assert_eq!(restored.presets[0], h264_preset());
        assert_eq!(load(&directory.path).unwrap().settings, restored);
    }
}
