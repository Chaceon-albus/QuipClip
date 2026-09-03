//! Shared vocabulary for ffmpeg capability probing.
//!
//! ADR 006 splits the probe into a listing step and a smoke-test step, then a cache. This
//! module holds the types both steps share: the kind of a codec, the outcome of a smoke
//! test, the licence flags read from `-version`, and the fixed set of encoders the smoke
//! test exercises. The listing parsers live in [`listing`]. The smoke test itself, its
//! timed process runner, and the application-wide smoke-test lock live in [`smoke`].

pub mod listing;
pub mod smoke;

pub use listing::{
    license_flags, parse_codec_list, parse_filter_list, parse_hwaccel_list, parse_version,
};
pub use smoke::{
    classify, run_smoke_test, run_with_timeout, smoke_arguments, stderr_tail, CommandOutcome,
    CommandStatus, SMOKE_TIMEOUT,
};

use serde::{Deserialize, Serialize};

/// The media kind ffmpeg reports for one codec row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodecKind {
    Video,
    Audio,
    Subtitle,
}

/// The outcome of a smoke test for one candidate encoder.
///
/// The listing step alone can only ever produce [`EncoderStatus::NotListed`]; the other
/// variants belong to the smoke-test step that ADR 006 describes but this unit does not
/// implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncoderStatus {
    Works,
    NotListed,
    Failed,
    TimedOut,
}

/// The licence flags read from the `configuration:` line of `ffmpeg -version`.
///
/// ADR 005 needs these for the consent dialog. This is the only capability that the
/// `-version` output carries and no other listing does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFlags {
    pub gpl: bool,
    pub nonfree: bool,
    pub version3: bool,
}

/// One row of `ffmpeg -encoders` or `ffmpeg -decoders`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCodec {
    pub name: String,
    pub kind: CodecKind,
    pub experimental: bool,
    pub description: String,
}

/// The version string and the configuration flags parsed from `ffmpeg -version`.
///
/// ADR 006's `located` event carries the version, and the cache key includes the version
/// string, so this type crosses both the cache file and the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub configuration_flags: Vec<String>,
}

/// One encoder the smoke test exercises.
///
/// The name matches the ffmpeg encoder name exactly, so a listing lookup and a smoke-test
/// invocation both use it verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub name: &'static str,
    pub kind: CodecKind,
}

/// The fixed set of encoders ADR 006 tests, video first and then audio.
///
/// The set is fixed by decision, not discovered from a listing: a probe of every listed
/// encoder would run for a long time and would test encoders that no export preset offers.
pub const TESTED_ENCODERS: [Candidate; 12] = [
    Candidate {
        name: "h264_nvenc",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "hevc_nvenc",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_qsv",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_amf",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_videotoolbox",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "hevc_videotoolbox",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libx264",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libx265",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libsvtav1",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libfdk_aac",
        kind: CodecKind::Audio,
    },
    Candidate {
        name: "aac",
        kind: CodecKind::Audio,
    },
    Candidate {
        name: "libopus",
        kind: CodecKind::Audio,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the full name list, in order, and each entry's [`CodecKind`].
    ///
    /// A wrong kind is silent and harmful: the smoke-test unit would feed an audio encoder
    /// the `color=` video source per ADR 006 and report a working encoder as broken. Since
    /// the name list is asserted in full, a rename cannot pass silently either.
    #[test]
    fn tested_encoders_have_the_expected_names_and_kinds() {
        const AUDIO: [&str; 3] = ["libfdk_aac", "aac", "libopus"];
        const VIDEO: [&str; 9] = [
            "h264_nvenc",
            "hevc_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_videotoolbox",
            "hevc_videotoolbox",
            "libx264",
            "libx265",
            "libsvtav1",
        ];

        let names: Vec<&str> = TESTED_ENCODERS
            .iter()
            .map(|candidate| candidate.name)
            .collect();
        let expected: Vec<&str> = VIDEO.into_iter().chain(AUDIO).collect();
        assert_eq!(names, expected);

        for candidate in TESTED_ENCODERS {
            let expected_kind = if AUDIO.contains(&candidate.name) {
                CodecKind::Audio
            } else {
                CodecKind::Video
            };
            assert_eq!(candidate.kind, expected_kind);
        }
    }
}
