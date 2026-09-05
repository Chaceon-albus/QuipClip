//! Shared vocabulary for the ADR 014 export renderer.
//!
//! ADR 004 gave the semantic steps of the renderer -- probe, plan, build a filter graph,
//! run ffmpeg, verify the frame count, rename the output -- without settling the timestamp
//! arithmetic or the command shape. ADR 014 settles both, from measurements on a real
//! ffmpeg, and this module holds the types that every later stage of the renderer shares.
//!
//! [`plan`] builds the pure [`ExportPlan`] from a source probe, a preset, and the requested
//! segment boundaries: it resolves the output frame rate, computes each segment's exact
//! duration and seek position, and converts video PTS into audio ticks. [`ExportPlan`] also
//! exposes [`ExportPlan::single_input_seek_seconds`], the one extra value ADR 014's second
//! graph shape (one input for the whole source) needs beyond the per-segment plan. Later
//! units add `graph` (the `trim`/`atrim` filter chains), `arguments` (the ffmpeg command
//! line), `progress` (the `frame`-based progress reader), `process` (spawning and
//! supervising ffmpeg), `output` (the temporary-file rename), and `registry` (wiring the
//! Tauri command). None of those modules exist yet; this unit only supplies the vocabulary
//! they will share, including every [`ExportErrorCode`] variant those later stages will
//! eventually produce.

pub mod plan;

pub use plan::{build_plan, PathFacts, PathIdentity, PlanRequest, SegmentBoundary};

use crate::project::Resolution;
use crate::settings::{Container, Quality};
use crate::time::{Pts, Rational};
use serde::Serialize;
use std::path::PathBuf;

/// The largest number of segments [`plan::build_plan`] accepts in one export request.
///
/// This is a plain sanity bound, not a command-line-limit calculation: ADR 014's second
/// graph shape (one input, one seek, `split`/`asplit`) exists precisely so the command
/// line stays inside the platform budget regardless of segment count, so segment count
/// alone does not force this limit. ADR 014 measurement 14 found that many inputs of one
/// file do not cause a failure -- runs with 8, 32, and 64 segments gave exactly 200, 800,
/// and 1600 frames, and the largest run used 20 MB of memory -- so this bound exists only
/// to reject a request so large it very likely reflects a mistake (a malformed project, a
/// runaway script) rather than a real editing session, before that request reaches later,
/// more expensive stages of the pipeline.
pub const MAX_EXPORT_SEGMENTS: usize = 500;

/// The seek margin ADR 014 selects, in whole seconds.
///
/// ADR 014 measurement 9 found that input seek alone is not frame-exact on MPEG-TS: a
/// request for PTS 277200 returned PTS 313200, an error of ten frames, because accurate
/// seek can only discard frames the demuxer already supplied, never recover frames it
/// skipped. The margin must therefore be larger than one group of pictures, so the seek
/// lands *before* the target and `trim` can discard the surplus. ADR 014 also requires a
/// real capture from a content delivery network to confirm this margin against a longer
/// GOP; this constant only records the value the decision settled on.
pub const SEEK_MARGIN_SECONDS: i64 = 5;

/// How the export renderer times its output frames.
///
/// ADR 014's "Output timing" section requires version 1 to always write constant-frame-rate
/// output, because `concat` needs one frame rate and a variable-frame-rate source has none.
/// It also requires that a later variable-frame-rate mode be an addition to this type, not a
/// rewrite of it: the graph builder selects the `fps` filter (or, in that later mode, omits
/// it) through a `match` on this enum. This type therefore holds exactly one variant today,
/// on purpose -- the `match` in the graph builder is exhaustive by necessity, not by an
/// accident of an unfinished enum, and adding the second variant later is additive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputTiming {
    /// Version 1 writes constant-frame-rate output, at this rational frame rate.
    ConstantFrameRate(Rational),
}

/// One planned segment: the raw source PTS boundary, the seek that reaches it cheaply, and
/// the audio tick boundary that lands on the same instant.
///
/// ADR 014's "boundary mechanism" keeps `in_pts` and `out_pts` as the stored source PTS
/// values with no conversion -- measurements 1 and 3 make that exact -- so the graph
/// builder's `trim`/`setpts` chain reads them verbatim. `seek_seconds` and the audio ticks
/// are the two values [`plan::build_plan`] derives from that boundary ahead of time, so the
/// argument builder and the graph builder never repeat the arithmetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedSegment {
    /// The inclusive start of the segment, as a raw source video PTS.
    pub in_pts: Pts,
    /// The exclusive end of the segment, as a raw source video PTS.
    pub out_pts: Pts,
    /// The input seek position for this segment's own `-i`, under ADR 014's first graph
    /// shape (one input per segment), in seconds from the container start; `None` when the
    /// computed value clamped to zero.
    ///
    /// ADR 014's second graph shape (one input for the whole source) needs a different,
    /// single seek value instead of any one segment's own value here -- see
    /// [`ExportPlan::single_input_seek_seconds`]. Concat order need not match source-PTS
    /// order, so `segments[0].seek_seconds` is the wrong value to reuse for that shape
    /// whenever the earliest segment (by `in_pts`) is not first in this array.
    ///
    /// ADR 014's "The seek" section also requires the renderer to omit `-ss` entirely
    /// rather than emit a trailing `-ss 0`: measurement 7 found that idiom has no effect on
    /// ffmpeg 2.1 and later, so a literal zero would be dead weight on the command line,
    /// not a no-op the renderer needs to preserve.
    pub seek_seconds: Option<Rational>,
    /// The inclusive start of the segment's audio, in ticks of `1 / sample_rate`, or `None`
    /// when [`ExportPlan::audio`] is `None`.
    ///
    /// This is `round(pts * videoTimeBase * sampleRate)` computed from the *video* PTS's
    /// own absolute origin (ADR 014's decision), never relative to `video_start_pts` or
    /// `format_start_time`; `plan`'s audio-tick tests pin exactly this. A negative value is
    /// not an error: ADR 002 permits a source to start at a negative PTS, and a negative
    /// tick here names a real instant before that absolute zero -- exactly the domain
    /// `atrim=start_pts=` expects when the audio stream's own raw PTS (kept intact by
    /// `-copyts`) is negative at that same instant.
    pub audio_in_tick: Option<i64>,
    /// The exclusive end of the segment's audio, in the same tick unit and under the same
    /// sign convention as `audio_in_tick`.
    pub audio_out_tick: Option<i64>,
}

/// The audio stream a plan addresses, and the sample rate its ticks are measured in.
///
/// These two facts always travel together; see [`ExportPlan::audio`] for why bundling them
/// into one type, rather than two independent optional fields, is the point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedAudio {
    /// The absolute index of the audio stream the filter graph must address.
    ///
    /// ADR 014's "The command" section requires the graph to bind this stream by its
    /// absolute index, never the short specifier `[i:a]`, for the same reason as
    /// [`ExportPlan::video_stream_index`].
    pub stream_index: u32,
    /// The sample rate every `audio_in_tick`/`audio_out_tick` in this plan's segments is
    /// measured in: the tick unit is `1 / sample_rate` seconds.
    pub sample_rate: u32,
}

/// A fully resolved, ready-to-render export: one source, its segments in concat order, and
/// the encoder settings a preset selected.
///
/// [`plan::build_plan`] is the only place that produces this type. Every field is already
/// resolved -- no later stage of the renderer re-reads the preset or the probe -- so a
/// change to a preset after planning cannot silently retarget an export already in flight.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    /// The source media file every segment cuts from.
    pub source: PathBuf,
    /// The final output location. The renderer writes a temporary file beside it and
    /// renames on success (ADR 004, ADR 014's "Other rules").
    pub destination: PathBuf,
    /// The absolute index of the video stream the filter graph must address.
    ///
    /// ADR 014's "The command" section requires the graph to bind this stream by its
    /// absolute index, never the short specifier `[i:v]`, for the same reason as
    /// [`PlannedAudio::stream_index`].
    pub video_stream_index: u32,
    /// The audio stream this plan addresses, together with the sample rate every audio
    /// tick in [`PlannedSegment`] is measured in, or `None` when there is no exact way to
    /// cut this source's audio.
    ///
    /// ADR 014 requires an exact `atrim` boundary in ticks of `1 / sample_rate`, and
    /// forbids the imprecise fallback of `atrim`'s `start`/`end` options, which ffmpeg
    /// parses into microseconds -- exactly the truncation ADR 002 already rules out
    /// elsewhere. A source whose audio stream carries no reported sample rate therefore has
    /// no ADR-014-compliant way to be cut at all, so this plan treats it exactly like a
    /// source with no audio stream: `audio` is `None`, the output carries no audio track,
    /// and every segment's audio ticks are `None` too. Bundling the stream index and the
    /// sample rate into one [`PlannedAudio`] makes "an audio stream to address, but no
    /// exact way to address it" unrepresentable, instead of leaving that combination as an
    /// unstated policy question for the graph builder.
    pub audio: Option<PlannedAudio>,
    /// The segments to render, in the order they must appear in the concatenated output.
    pub segments: Vec<PlannedSegment>,
    /// How the renderer times its output frames. See [`OutputTiming`].
    pub timing: OutputTiming,
    /// The output resolution, or `None` to keep the source video's own resolution.
    pub resolution: Option<Resolution>,
    /// The ffmpeg video encoder name, verbatim from the preset.
    pub video_encoder: String,
    /// The ffmpeg audio encoder name, verbatim from the preset.
    pub audio_encoder: String,
    /// The quality control and its value, verbatim from the preset.
    pub quality: Quality,
    /// The output container, which selects the muxer (ADR 004).
    pub container: Container,
    /// The exact total output duration: the rational sum of every segment's duration.
    pub total_duration: Rational,
    /// The expected final `frame` count, for ADR 014's progress and frame-count comparison.
    ///
    /// This is `Some` under every [`OutputTiming`] this crate implements today. It is an
    /// `Option`, not a plain `u64`, because ADR 014's "Output timing" section records that a
    /// future variable-frame-rate mode cannot predict a frame count in advance; that mode
    /// will report `None` here instead of widening this field's meaning.
    pub expected_frames: Option<u64>,
}

impl ExportPlan {
    /// The single input seek ADR 014's second graph shape needs: one input for the whole
    /// source, seeked once before the earliest frame any segment requires, with
    /// `split`/`asplit` dividing the decoded stream among each segment's own `trim` chain.
    ///
    /// This is **not** `self.segments[0].seek_seconds`. `segments` is in concat order, and
    /// concat order need not match source-PTS order: an export can present its segments out
    /// of source order, so the first array element is not necessarily the segment with the
    /// smallest `in_pts`. Seeking to the first array element's position in that case can
    /// skip past material an earlier-in-source, later-in-array segment still needs.
    ///
    /// The fix needs no new arithmetic. Every segment's own `seek_seconds` is a strictly
    /// increasing function of its `in_pts` alone -- same time base, same
    /// `format_start_time`, same margin, for every segment of one source and one plan -- so
    /// the segment with the smallest `in_pts` already carries the correct single-input seek
    /// in its own `seek_seconds` field, clamped exactly as ADR 014 requires. This method
    /// only has to find that segment.
    #[must_use]
    pub fn single_input_seek_seconds(&self) -> Option<Rational> {
        self.segments
            .iter()
            .min_by_key(|segment| segment.in_pts)
            .and_then(|segment| segment.seek_seconds)
    }
}

// Defines `ExportErrorCode` and, for tests only, `ALL_EXPORT_ERROR_CODES`: an exhaustive
// slice of every variant, generated from the same list that defines the enum. Without this
// macro the enum and a hand-written test array are two independent lists that happen to
// agree; nothing would force a variant added to one into the other, so a set-equality
// assertion in a test could stay green after a variant silently went untranslated on the
// frontend. This mirrors `commands::settings::settings_error_codes!` exactly, for the same
// reason: see `every_error_code_serializes_to_its_stable_camel_case_string` below.
macro_rules! export_error_codes {
    ($($(#[$attr:meta])* $variant:ident => $wire:literal),+ $(,)?) => {
        /// Stable, localizable error codes for the export renderer.
        ///
        /// ADR 011 forbids a user-facing English sentence in a code the frontend matches
        /// against; a diagnostic belongs in a separate field a later caller attaches, never
        /// in this enum, matching `ImportMediaErrorCode` and `CapabilityProbeErrorCode`
        /// elsewhere in this crate. Every variant below is documented with the stage that
        /// produces it; most of those stages (`graph`, `arguments`, `progress`, `process`,
        /// `output`, `registry`) are not implemented yet, so their variants are reserved
        /// here so every later stage of the pipeline shares one closed error vocabulary from
        /// the start, rather than each stage growing its own.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub enum ExportErrorCode {
            $($(#[$attr])* $variant),+
        }

        /// Every [`ExportErrorCode`] variant. Test-only; see
        /// `every_error_code_serializes_to_its_stable_camel_case_string`.
        #[cfg(test)]
        const ALL_EXPORT_ERROR_CODES: &[ExportErrorCode] = &[$(ExportErrorCode::$variant),+];
    };
}

export_error_codes! {
    /// Reserved for the Tauri command layer (not implemented yet): the command could not
    /// resolve the application data directory needed to read settings or run ffmpeg
    /// discovery, mirroring `ImportMediaErrorCode::AppDataUnavailable` and
    /// `CapabilityProbeErrorCode::AppDataUnavailable`.
    AppDataUnavailable => "appDataUnavailable",
    /// Reserved for the registry stage (not implemented yet): the settings file could not
    /// be read to resolve the requested preset or the configured ffmpeg path.
    SettingsUnreadable => "settingsUnreadable",
    /// Reserved for the registry stage (not implemented yet): the requested preset id is
    /// not present in the settings document.
    PresetNotFound => "presetNotFound",
    /// Reserved for the registry stage (not implemented yet): `ffmpeg` and `ffprobe` could
    /// not both be located, mirroring `CapabilityProbeErrorCode::FfmpegPairMissing`.
    FfmpegPairMissing => "ffmpegPairMissing",
    /// Reserved for the registry stage's mandatory re-probe (not implemented yet; ADR 014's
    /// "Other rules": the renderer re-probes the source when an export starts): `ffprobe`
    /// failed to start.
    FfprobeSpawnFailed => "ffprobeSpawnFailed",
    /// Reserved for the registry stage's re-probe (not implemented yet): `ffprobe` exited
    /// unsuccessfully.
    FfprobeProcessFailed => "ffprobeProcessFailed",
    /// Reserved for the registry stage's re-probe (not implemented yet): `ffprobe`'s output
    /// failed to parse.
    FfprobeParseFailed => "ffprobeParseFailed",
    /// Produced by [`plan::build_plan`]: the request carried zero segments.
    NoSegments => "noSegments",
    /// Produced by [`plan::build_plan`]: the request carried more than
    /// [`MAX_EXPORT_SEGMENTS`] segments.
    TooManySegments => "tooManySegments",
    /// Produced by [`plan::build_plan`]: a segment's `in_pts` was not strictly before its
    /// `out_pts`, or an internal timestamp computation could not be represented exactly.
    InvalidSegment => "invalidSegment",
    /// Produced by [`plan::build_plan`]: the source path is empty, contains a NUL byte, or
    /// is not absolute.
    SourcePathInvalid => "sourcePathInvalid",
    /// Produced by [`plan::build_plan`]: the source path does not exist.
    SourceNotFound => "sourceNotFound",
    /// Produced by [`plan::build_plan`]: the source path exists but is not a regular file.
    SourceNotFile => "sourceNotFile",
    /// Produced by [`plan::build_plan`]: the destination path is empty, contains a NUL
    /// byte, has no file name, has no parent, or is not absolute.
    OutputPathInvalid => "outputPathInvalid",
    /// Produced by [`plan::build_plan`]: the destination's parent directory does not exist
    /// or is not a directory.
    OutputDirectoryMissing => "outputDirectoryMissing",
    /// Produced by [`plan::build_plan`]: the destination names the same file as the
    /// source.
    OutputEqualsSource => "outputEqualsSource",
    /// Reserved for the output stage (not implemented yet): the destination directory
    /// rejected the reserved temporary file.
    OutputNotWritable => "outputNotWritable",
    /// Produced by [`plan::build_plan`]: the preset asks for the source's own frame rate
    /// but the probe reports neither a valid `avg_frame_rate` nor `r_frame_rate`, or the
    /// resolved frame rate (from either the probe or an explicit preset rate) is not
    /// strictly positive.
    SourceFrameRateUnknown => "sourceFrameRateUnknown",
    /// Reserved for the registry stage (not implemented yet): the preset names an encoder
    /// the capability probe did not report as working.
    EncoderUnavailable => "encoderUnavailable",
    /// Reserved for the process stage (not implemented yet): the `ffmpeg` child process
    /// failed to start.
    FfmpegSpawnFailed => "ffmpegSpawnFailed",
    /// Reserved for the process stage (not implemented yet): `ffmpeg` exited unsuccessfully.
    FfmpegProcessFailed => "ffmpegProcessFailed",
    /// Reserved for the progress stage (not implemented yet): the final `frame` count
    /// differed from [`ExportPlan::expected_frames`] (ADR 014's frame-count comparison).
    FrameCountMismatch => "frameCountMismatch",
    /// Reserved for the output stage (not implemented yet): the renderer could not rename
    /// the temporary file over the destination.
    OutputRenameFailed => "outputRenameFailed",
    /// Reserved for the process stage (not implemented yet): the user canceled an export in
    /// progress.
    Canceled => "canceled",
    /// Reserved for the Tauri command layer (not implemented yet): the blocking task
    /// running the pipeline itself failed to execute, mirroring
    /// `ImportMediaErrorCode::CommandExecutionFailed`.
    CommandExecutionFailed => "commandExecutionFailed",
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ALL_EXPORT_ERROR_CODES` is generated by the same `export_error_codes!` invocation
    /// that defines `ExportErrorCode`, so a variant added to the enum without adding it to
    /// that invocation fails to compile -- this list cannot go stale relative to the enum
    /// the way a hand-written array could. This test then asks serde itself, through
    /// `serde_json::to_value`, for the wire string of every one of those variants, rather
    /// than consulting a second hand-written table: a variant added to the enum, or one
    /// whose rename serde produces differently than expected, changes the set below. The
    /// frontend translates these exact strings (ADR 011), so this is the test that catches
    /// a renamed variant becoming an untranslated string in the UI.
    #[test]
    fn every_error_code_serializes_to_its_stable_camel_case_string() {
        let mut serialized: Vec<String> = ALL_EXPORT_ERROR_CODES
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
                "canceled",
                "commandExecutionFailed",
                "encoderUnavailable",
                "ffmpegPairMissing",
                "ffmpegProcessFailed",
                "ffmpegSpawnFailed",
                "ffprobeParseFailed",
                "ffprobeProcessFailed",
                "ffprobeSpawnFailed",
                "frameCountMismatch",
                "invalidSegment",
                "noSegments",
                "outputDirectoryMissing",
                "outputEqualsSource",
                "outputNotWritable",
                "outputPathInvalid",
                "outputRenameFailed",
                "presetNotFound",
                "settingsUnreadable",
                "sourceFrameRateUnknown",
                "sourceNotFile",
                "sourceNotFound",
                "sourcePathInvalid",
                "tooManySegments",
            ]
        );
    }
}
