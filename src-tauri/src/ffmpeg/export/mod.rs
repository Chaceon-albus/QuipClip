//! Shared vocabulary for the ADR 014 export renderer.
//!
//! ADR 004 gave the semantic steps of the renderer -- probe, plan, build a filter graph,
//! run ffmpeg, verify the frame count, rename the output -- without settling the timestamp
//! arithmetic or the command shape. ADR 014 settles both, from measurements on a real
//! ffmpeg, and this module holds the types that every later stage of the renderer shares.
//!
//! [`plan`] builds the pure [`ExportPlan`] from a source probe, a preset, and the requested
//! segment boundaries: it resolves the output frame rate and the audio output format,
//! computes each segment's exact duration and seek position, and converts video PTS into
//! audio ticks. [`ExportPlan`] also
//! exposes [`ExportPlan::single_input_seek_seconds`], the one extra value ADR 014's second
//! graph shape (one input for the whole source) needs beyond the per-segment plan.
//!
//! [`fsinspect`] is the one production implementation of that injected closure: it turns a real
//! path into the [`PathFacts`] the planner reads, and it reports a file only when it could also
//! read a platform identity for it, so a destination that spells the source a second way -- a hard
//! link, a symlink, a case-insensitive volume -- cannot pass the same-file check.
//!
//! [`graph`] renders a finished plan into ADR 014's inline `-filter_complex` string: one
//! `trim`/`atrim` chain for each segment, cut on absolute stream indices at integer
//! `start_pts`/`end_pts` boundaries, joined by `concat` in plan order, in whichever of the two
//! [`GraphShape`] variants the argument builder's command-line budget allows.
//!
//! [`arguments`] builds the ffmpeg argument vector from a plan, a rendered graph, and the
//! reserved output path, in the order ADR 014's "The command" section gives. This module also
//! holds the command-line budget, because the graph goes on the command line.
//! [`arguments::choose_graph_shape`] decides whether one input for each segment stays inside
//! that budget, and [`graph`] does not. Two of the arguments are mandatory. Without `-f`,
//! ffmpeg cannot select a muxer for the reserved name, and it stops with an error. Without
//! `-y`, ffmpeg does not write the reserved file, and it exits with code 0. That second
//! failure is silent, and [`output`] holds the measurement.
//!
//! [`progress`] is the `frame`-based progress reader: it accumulates the `key=value` line
//! stream of `ffmpeg -progress pipe:1 -nostats` into one [`ProgressSnapshot`] for each completed
//! block, and it ignores the output-time keys that ADR 014 measurement 12 found wrong under
//! `-copyts`.
//!
//! [`registry`] holds the single-flight guard and the cancellation flag: it decides whether an
//! export may start at all, refusing a second one while one is running, and it carries a stop
//! request from the command layer to the process stage. It owns no path, no plan, and no
//! process handle.
//!
//! [`output`] owns the temporary output file that ADR 004 and ADR 014's "Other rules" require:
//! it reserves a path in the destination's own directory for the spawned ffmpeg to write,
//! renames that file over the destination once the render has succeeded, and deletes it on
//! every other exit path, a panic included.
//!
//! [`process`] owns the `ffmpeg` child: it refuses to spawn one for an export the user has
//! already cancelled, drains both of the child's pipes on their own threads so a chatty encoder
//! can never block itself inside a write, feeds [`progress`] the stdout stream one line at a
//! time, kills and reaps the child on cancellation and on a panic alike, and reports an exit
//! status that the caller must **not** read as a successful export on its own -- see
//! [`process::ExportProcessStatus::Exited`] for the measured case where `ffmpeg` writes no frames
//! and still exits zero.
//!
//! [`verify`] is the success check of an export that writes no video. The frame count cannot
//! verify such an export, so [`verify::verify_audio_output`] reads the finished file back through
//! ffprobe instead: one audio stream, no video stream, and a duration inside a measured tolerance
//! of the plan's.

pub mod arguments;
pub mod fsinspect;
pub mod graph;
pub mod output;
pub mod plan;
pub mod process;
pub mod progress;
pub mod registry;
pub mod verify;

pub use arguments::{build_arguments, choose_graph_shape};
pub use fsinspect::inspect_path;
pub use graph::{build_filter_graph, GraphShape};
pub use output::PendingOutput;
pub use plan::{build_plan, PathFacts, PathIdentity, PlanRequest, SegmentBoundary};
pub use process::{
    run_export_process, ExportProcessOutcome, ExportProcessRequest, ExportProcessStatus,
};
pub use progress::{ProgressReader, ProgressSnapshot};
pub use registry::{ExportRegistry, ExportSlot};
pub use verify::{verify_audio_output, AudioOutputMismatch};

use crate::project::Resolution;
use crate::settings::{AudioChannels, Container, PresetOption, Quality};
use crate::time::{Pts, Rational};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which streams of the source an export writes.
///
/// The user chooses this in the export dialog, and it crosses the wire on every export request.
/// [`plan::build_plan`] reads it, and it decides which of the two optional parts of an
/// [`ExportPlan`] exist:
///
/// - [`ExportStreams::VideoAndAudio`] plans video, and audio when the source has an audio stream.
///   This is the behaviour of every export before the choice existed.
/// - [`ExportStreams::VideoOnly`] plans video and never audio. A source without audio, or with an
///   audio stream that reports no sample rate, exports as it would with sound removed.
/// - [`ExportStreams::AudioOnly`] plans audio and never video. A source without an audio stream
///   is refused with [`ExportErrorCode::SourceHasNoAudio`].
///
/// Each variant names its wire string explicitly, rather than through `rename_all`, so the
/// frontend's parity test can read the strings from this file
/// (`src/features/export/types.test.ts`), as it reads the error codes below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportStreams {
    /// The video, and the audio when the source has an audio stream.
    #[serde(rename = "videoAndAudio")]
    VideoAndAudio,
    /// The video only.
    #[serde(rename = "videoOnly")]
    VideoOnly,
    /// The audio only.
    #[serde(rename = "audioOnly")]
    AudioOnly,
}

impl ExportStreams {
    /// Whether an export with this choice writes the source's video.
    #[must_use]
    pub const fn writes_video(self) -> bool {
        matches!(self, Self::VideoAndAudio | Self::VideoOnly)
    }

    /// Whether an export with this choice writes the source's audio, when the source has any.
    #[must_use]
    pub const fn writes_audio(self) -> bool {
        matches!(self, Self::VideoAndAudio | Self::AudioOnly)
    }
}

/// The largest number of segments [`plan::build_plan`] accepts in one export request.
///
/// This is a command-line budget, not a sanity bound. ADR 014 measurement 13 leaves the
/// renderer no portable way to move the filter graph off the command line:
/// `-filter_complex_script` is absent from ffmpeg 9.0.1, and its replacement
/// `-/filter_complex` is absent before 7.1, so no single spelling works on every build a
/// user can have. The graph therefore rides inline and competes with the arguments for the
/// one command-line budget Windows allows.
///
/// ADR 014 measurement 15 measures what that costs: the graph grows by about the same
/// amount for each added segment in *both* [`GraphShape`] variants. The single-input shape
/// (one seek, then `split`/`asplit`) writes the source path once instead of once for each
/// segment, so it reaches further on a long path, but it does not remove that growth. ADR
/// 014's "The graph shape" section keeps the byte figures and the reach they imply; the
/// conclusion is that neither shape can spell an export much larger than this cap on
/// Windows. 100 keeps the command line inside the Windows budget even for a long source
/// path, and it is still far above the number of segments a person marks by hand.
///
/// ffmpeg itself is not the constraint here: measurement 14 found that many inputs of one
/// file do not cause a failure. A larger export needs the graph off the command line
/// instead, through the `-/filter_complex <file>` form that ffmpeg 7.1 and later accept.
/// The capability probe already reads the version, so a later unit can select that form on
/// a build that offers it and keep the inline form on an older one. ADR 014 does not
/// require that work, and this crate does not do it.
pub const MAX_EXPORT_SEGMENTS: usize = 100;

/// The longest silence, in whole seconds, that the segments of an export may need in front of
/// the first sample of the source audio stream, all together.
///
/// The part of a segment before that sample becomes silence: the audio chain fills it when the
/// segment reaches the sample (`graph::audio_chain`), and `concat` pads it when the segment ends
/// at or before the sample and another segment follows. FFmpeg holds each of the two whole in
/// memory before it writes it.
/// ADR 014 measurement 21 measured the fill alone on AAC audio, at this bound: 95 MiB on 48000 Hz
/// stereo, 215 MiB on 48000 Hz 5.1, and 532 MiB on 96000 Hz 7.1. The plan refuses more with
/// [`ExportErrorCode::AudioGapTooLong`]. The bound does not cover the decoded video that FFmpeg
/// keeps until the first audio frame arrives, which measurement 21 also records.
pub const MAX_LEADING_AUDIO_SILENCE_SECONDS: i64 = 60;

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

/// The video part of a plan: the stream it reads, how the output frames are timed and sized,
/// the encoder settings a preset selected, and the frame count the export must reach.
///
/// Everything here describes the video stream only, and it only means something when there is
/// video to write. [`ExportPlan::video`] holds it as one optional part for that reason, as
/// [`ExportPlan::audio`] holds [`PlannedAudio`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedVideo {
    /// The absolute index of the video stream the filter graph must address.
    ///
    /// ADR 014's "The command" section requires the graph to bind this stream by its
    /// absolute index, never the short specifier `[i:v]`, for the same reason as
    /// [`PlannedAudio::stream_index`].
    pub stream_index: u32,
    /// How the renderer times its output frames. See [`OutputTiming`].
    pub timing: OutputTiming,
    /// The output resolution, or `None` to keep the source video's own resolution.
    pub resolution: Option<Resolution>,
    /// The ffmpeg video encoder name, verbatim from the preset.
    pub encoder: String,
    /// The quality control and its value, verbatim from the preset.
    pub quality: Quality,
    /// The pixel format of the output video, verbatim from the preset.
    ///
    /// The graph converts the joined video to it in its first chain, and the argument builder
    /// writes it as `-pix_fmt` after `-c:v`.
    pub pixel_format: String,
    /// The encoder options of the video stream, verbatim from the preset, in the order the
    /// argument builder writes them: each one as `-<name>:v <value>`, after the quality flags.
    pub options: Vec<PresetOption>,
    /// The expected final `frame` count, for ADR 014's progress and frame-count comparison.
    ///
    /// This is `Some` under every [`OutputTiming`] this crate implements today. It is an
    /// `Option`, not a plain `u64`, because ADR 014's "Output timing" section records that a
    /// future variable-frame-rate mode cannot predict a frame count in advance; that mode
    /// will report `None` here instead of widening this field's meaning.
    pub expected_frames: Option<u64>,
}

/// The audio part of a plan: the stream it addresses, the sample rate its ticks are measured
/// in, the format every audio chain ends in, and the encoder settings a preset selected.
///
/// The first two facts always travel together; see [`ExportPlan::audio`] for why bundling them
/// into one type, rather than two independent optional fields, is the point. The output format
/// and the encoder settings belong here too, because they only mean something when there is
/// audio to format and to encode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAudio {
    /// The absolute index of the audio stream the filter graph must address.
    ///
    /// ADR 014's "The command" section requires the graph to bind this stream by its
    /// absolute index, never the short specifier `[i:a]`, for the same reason as
    /// [`PlannedVideo::stream_index`].
    pub stream_index: u32,
    /// The sample rate every `audio_in_tick`/`audio_out_tick` in this plan's segments is
    /// measured in: the tick unit is `1 / sample_rate` seconds.
    ///
    /// This is always the source stream's own rate, whatever the preset asks for, because the
    /// graph pins each input link to it before `atrim` reads the ticks (ADR 014 measurement 17).
    pub sample_rate: u32,
    /// The sample rate every audio chain resamples to before `concat`, in hertz.
    ///
    /// [`plan::build_plan`] resolves the preset's [`AudioSampleRateSetting::Source`] to
    /// [`Self::sample_rate`] here, so the graph renders a number and never reads the preset.
    /// Every chain reads the same audio stream and ends at this one rate, so `concat` still
    /// receives inputs that agree (ADR 023).
    ///
    /// [`AudioSampleRateSetting::Source`]: crate::settings::AudioSampleRateSetting::Source
    pub output_sample_rate: u32,
    /// The channel layout every audio chain ends in.
    ///
    /// [`AudioChannels::Source`] is the one value the plan cannot resolve to a concrete layout:
    /// the probe reports a channel count, not a layout, so the graph instead names no layout at
    /// all and the chain keeps the source stream's own (ADR 023). As with the rate, every chain
    /// reads the same stream, so every chain ends with the same layout.
    pub output_channels: AudioChannels,
    /// The ffmpeg audio encoder name, verbatim from the preset.
    pub encoder: String,
    /// The audio bitrate in kilobits per second, verbatim from the preset, or `None` to leave
    /// the audio encoder at its own default.
    ///
    /// The argument builder writes it as `-b:a <n>k` directly after `-c:a` (ADR 023).
    pub bitrate: Option<u32>,
    /// The encoder options of the audio stream, verbatim from the preset, in the order the
    /// argument builder writes them: each one as `-<name>:a <value>`, after `-b:a`.
    pub options: Vec<PresetOption>,
    /// The length of audio an export of the segments writes, in seconds, exact.
    ///
    /// This is a sum over the segments that the stream's probed extent
    /// ([`AudioProbe::start_time`] and [`AudioProbe::duration`]) reaches: for each one, the time
    /// from its In point to the earlier of its Out point and the end of the stream. It is
    /// [`ExportPlan::total_duration`] when the stream covers every segment, and when the audio of
    /// the source only starts after an In point: the graph fills that late start with silence
    /// (`graph::audio_chain`). It is shorter when the audio ends before a segment's Out point,
    /// because `atrim` then finds no samples for the rest and an audio-only export writes none,
    /// and when the stream does not reach a segment at all, which then writes nothing.
    /// [`verify::verify_audio_output`] compares the finished file with this value, so a correct
    /// export of such a source is not reported as truncated. A side of the extent that the probe
    /// does not report bounds nothing: with no extent at all, this is the total duration.
    ///
    /// The graph does not read it. It is a bound for the success check, and never an edit
    /// boundary (ADR 002).
    ///
    /// [`AudioProbe::start_time`]: crate::ffmpeg::probe::AudioProbe::start_time
    /// [`AudioProbe::duration`]: crate::ffmpeg::probe::AudioProbe::duration
    pub expected_duration: Rational,
}

/// A fully resolved, ready-to-render export: one source, its segments in concat order, and
/// the video and audio parts with the encoder settings a preset selected.
///
/// [`plan::build_plan`] is the only place that produces this type. Every field is already
/// resolved -- no later stage of the renderer re-reads the preset or the probe -- so a
/// change to a preset after planning cannot silently retarget an export already in flight.
///
/// Both parts are optional, and each one is a whole decision for the graph: a part that is
/// `None` writes no chain, no label, no map, and no encoder flag anywhere. [`plan::build_plan`]
/// plans each part from the [`ExportStreams`] choice of the request, and it never produces a
/// plan with neither part.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    /// The source media file every segment cuts from.
    pub source: PathBuf,
    /// The final output location. The renderer writes a temporary file beside it and
    /// renames on success (ADR 004, ADR 014's "Other rules").
    pub destination: PathBuf,
    /// The video this plan writes, or `None` for a plan with no video.
    ///
    /// [`plan::build_plan`] fills this part exactly when [`ExportStreams::writes_video`] holds
    /// for the request. A plan without it is an audio-only export, and the frame count cannot
    /// verify that export; [`verify`] holds the check that does.
    pub video: Option<PlannedVideo>,
    /// The audio stream this plan addresses, together with the sample rate every audio
    /// tick in [`PlannedSegment`] is measured in, or `None` when the plan writes no audio.
    ///
    /// ADR 014 requires an exact `atrim` boundary in ticks of `1 / sample_rate`, and
    /// forbids the imprecise fallback of `atrim`'s `start`/`end` options, which ffmpeg
    /// parses into microseconds -- exactly the truncation ADR 002 already rules out
    /// elsewhere. A source whose audio stream carries no usable sample rate therefore has
    /// no ADR-014-compliant way to be cut at all, and [`plan::build_plan`] refuses the whole
    /// export with [`ExportErrorCode::SourceAudioRateUnknown`] rather than reaching this
    /// field: dropping the track here would write a video-only file for a source the
    /// preview played with sound, and report nothing. `None` therefore means one of two
    /// things, and both are stated, never silent: the source has no audio, or the user chose
    /// [`ExportStreams::VideoOnly`]. Bundling the stream index and the sample rate into
    /// one [`PlannedAudio`] makes "an audio stream to address, but no exact way to address
    /// it" unrepresentable, instead of leaving that combination as an unstated policy
    /// question for the graph builder.
    pub audio: Option<PlannedAudio>,
    /// The segments to render, in the order they must appear in the concatenated output.
    pub segments: Vec<PlannedSegment>,
    /// The output container, which selects the muxer (ADR 004).
    pub container: Container,
    /// The exact total output duration: the rational sum of every segment's duration.
    pub total_duration: Rational,
}

impl ExportPlan {
    /// The expected final `frame` count, for ADR 014's progress and frame-count comparison:
    /// [`PlannedVideo::expected_frames`] of [`Self::video`].
    ///
    /// `None` comes from two different cases, and they must not be read as one. The video part
    /// reports `None` when it cannot predict a count, as ADR 014's future variable-frame-rate
    /// mode will; the comparison then has nothing to compare, and the progress has no total. A
    /// plan without a video part also reports `None`, because it writes no frames at all; for
    /// that plan the comparison cannot catch the failure ADR 016 relies on it for, an ffmpeg that
    /// wrote nothing and exited zero. `commands::export` therefore never runs the frame-count
    /// check for a plan without video. It runs [`verify::verify_audio_output`] instead, which
    /// reads the finished file back.
    #[must_use]
    pub fn expected_frames(&self) -> Option<u64> {
        self.video.as_ref().and_then(|video| video.expected_frames)
    }

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
        /// elsewhere in this crate. Every variant below is documented with the function that
        /// produces it. All of them have one today except [`ExportErrorCode::EncoderUnavailable`],
        /// which ADR 016 defers by name. The stages the variants below once called "the
        /// registry stage" are the preparation steps of `commands::export`; that name
        /// predates the `registry` module, which is the single-flight guard and produces
        /// none of these codes itself.
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
    /// Produced by `commands::export::start_export`: the command could not resolve the
    /// application data directory needed to read settings or run ffmpeg discovery,
    /// mirroring `ImportMediaErrorCode::AppDataUnavailable` and
    /// `CapabilityProbeErrorCode::AppDataUnavailable`.
    AppDataUnavailable => "appDataUnavailable",
    /// Produced by `commands::export::start_export`: an export was requested while another
    /// one is already running. [`registry::ExportRegistry::begin`] answers `None` when a run
    /// already holds the single slot, and the command layer turns that `None` into this code
    /// rather than queueing the request.
    ExportAlreadyRunning => "exportAlreadyRunning",
    /// Produced by `commands::export::prepare_export_with`: the settings file could not be
    /// read to resolve the requested preset or the configured ffmpeg path.
    SettingsUnreadable => "settingsUnreadable",
    /// Produced by `commands::export::resolve_preset`: the requested preset id is not
    /// present in the settings document, or the request named none and the document has no
    /// active preset either.
    PresetNotFound => "presetNotFound",
    /// Produced by `commands::export::prepare_export_with`: `ffmpeg` and `ffprobe` could not
    /// both be located, mirroring `CapabilityProbeErrorCode::FfmpegPairMissing`.
    FfmpegPairMissing => "ffmpegPairMissing",
    /// Produced by `commands::export::map_reprobe_error`, for the mandatory re-probe (ADR
    /// 014's "Other rules": the renderer re-probes the source when an export starts):
    /// `ffprobe` failed to start.
    FfprobeSpawnFailed => "ffprobeSpawnFailed",
    /// Produced by `commands::export::map_reprobe_error`: `ffprobe` exited unsuccessfully.
    FfprobeProcessFailed => "ffprobeProcessFailed",
    /// Produced by `commands::export::map_reprobe_error`: `ffprobe`'s output failed to
    /// parse.
    FfprobeParseFailed => "ffprobeParseFailed",
    /// Produced by `commands::export::map_reprobe_error`: `ffprobe` was still running at
    /// [`crate::ffmpeg::probe::PROBE_TIMEOUT`] and was killed. A stalled re-probe holds the
    /// single export slot, so it is bounded rather than waited on.
    FfprobeTimedOut => "ffprobeTimedOut",
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
    /// Produced by `commands::export::prepare_export_with`: the destination directory
    /// rejected the reserved temporary file ([`output::PendingOutput::reserve`]).
    OutputNotWritable => "outputNotWritable",
    /// Produced by [`plan::build_plan`]: the destination already exists as a regular file the
    /// user protected against writing, so ADR 015's refusal in
    /// [`crate::fsutil::replace_file_within`] would reject the publication.
    ///
    /// This is a separate code from [`ExportErrorCode::OutputNotWritable`] because the two
    /// name different things and offer the user different ways out. That code is the
    /// destination *directory* refusing a new file, and its message says so in both catalogs;
    /// this one is one protected file inside a directory that accepts writes, where the way
    /// out is to clear the protection or to choose another name, not to choose another folder.
    ///
    /// The plan refuses it rather than leaving it to [`output::PendingOutput::commit`]: the
    /// reservation only touches the destination's parent, so the whole encode would otherwise
    /// run and then be discarded at the final rename. The late guard in `commit` still stands,
    /// for a file that is protected after this check and before the rename.
    OutputReadOnly => "outputReadOnly",
    /// Produced by [`plan::build_plan`]: the preset asks for the source's own frame rate
    /// but the probe reports neither a valid `avg_frame_rate` nor `r_frame_rate`, or the
    /// resolved frame rate (from either the probe or an explicit preset rate) is not
    /// strictly positive. An export with [`ExportStreams::AudioOnly`] times no frames, so it
    /// never produces this code.
    SourceFrameRateUnknown => "sourceFrameRateUnknown",
    /// Produced by [`plan::build_plan`]: the source reports an audio stream, and that
    /// stream carries no usable sample rate.
    ///
    /// ADR 014 cuts audio at integer ticks of `1 / sample_rate` and forbids the microsecond
    /// `atrim` fallback, so an unknown rate leaves no exact way to cut the track. The plan
    /// refuses the export rather than dropping the track: a dropped track writes a
    /// video-only file for a source the preview played with sound, and reports nothing --
    /// the same silent class of failure ADR 014 rules out for the short stream specifier.
    ///
    /// An export with [`ExportStreams::VideoOnly`] never reads the audio stream, so it never
    /// produces this code.
    SourceAudioRateUnknown => "sourceAudioRateUnknown",
    /// Produced by [`plan::build_plan`]: the request asks for [`ExportStreams::AudioOnly`], and
    /// the source reports no audio stream. A plan without video and without audio would write
    /// nothing, so the export is refused before anything is reserved.
    SourceHasNoAudio => "sourceHasNoAudio",
    /// Produced by [`plan::build_plan`]: the export writes audio, and the parts of its segments
    /// before the first sample of the source audio stream add up to more than
    /// [`MAX_LEADING_AUDIO_SILENCE_SECONDS`].
    ///
    /// Each of those parts becomes silence that FFmpeg holds in memory until it is complete. An
    /// export with [`ExportStreams::AudioOnly`] counts only the segments that reach the first
    /// sample, because it writes nothing for the others. An export with
    /// [`ExportStreams::VideoOnly`] reads no audio, so it never produces this code. The probe
    /// reports only where the stream starts, so a gap inside the stream is not bounded.
    AudioGapTooLong => "audioGapTooLong",
    /// Reserved: the preset names an encoder the capability probe did not report as
    /// working.
    ///
    /// This is the one code in this vocabulary that no function produces. ADR 016's "The
    /// encoder test reports only a known failure" defers it by name: "**The first
    /// implementation does not make this test.** It reads no capability cache, and
    /// `encoderUnavailable` stays a code that no code path produces. The test needs the
    /// version string, which needs one more `ffmpeg` process, and that is a separate unit."
    /// Until that unit lands, a bad encoder arrives as [`ExportErrorCode::FfmpegProcessFailed`]
    /// with the diagnostic text from `ffmpeg`.
    EncoderUnavailable => "encoderUnavailable",
    /// Produced by `commands::export::run_export_with`: the `ffmpeg` child process failed
    /// to start.
    FfmpegSpawnFailed => "ffmpegSpawnFailed",
    /// Produced by `commands::export::run_export_with`: `ffmpeg` exited unsuccessfully.
    FfmpegProcessFailed => "ffmpegProcessFailed",
    /// Produced by `commands::export::verified_frame_count`: the final `frame` count
    /// differed from [`ExportPlan::expected_frames`] (ADR 014's frame-count comparison).
    FrameCountMismatch => "frameCountMismatch",
    /// Produced by `commands::export::run_export_with`, for an export without video: the
    /// finished file holds one audio stream, but ffprobe reports a duration outside
    /// [`verify`]'s tolerance of [`PlannedAudio::expected_duration`], or no duration at all. The
    /// failure carries the measured and the expected duration as named values.
    AudioDurationMismatch => "audioDurationMismatch",
    /// Produced by `commands::export::run_export_with`, for an export without video: ffmpeg
    /// exited zero with no progress block at all, ffprobe could not read the finished file (it
    /// exited unsuccessfully, or its answer does not parse), or the file does not hold exactly
    /// one audio stream and no video stream.
    OutputStreamsMismatch => "outputStreamsMismatch",
    /// Produced by `commands::export::run_export_with`: the renderer could not rename the
    /// temporary file over the destination.
    OutputRenameFailed => "outputRenameFailed",
    /// Produced by `commands::export::run_export_with`, on either of ADR 016's two cancel
    /// tests: the user canceled an export in progress.
    ///
    /// Also produced by `commands::export::prepare_export_with` and by
    /// `commands::export::start_export`, for a cancel that arrives while the run is still in
    /// preparation. Preparation already holds the export slot and can last as long as
    /// [`crate::ffmpeg::probe::PROBE_TIMEOUT`], so a cancel there ends the run rather than
    /// letting it work through every remaining step and then start `ffmpeg`.
    Canceled => "canceled",
    /// Produced by `commands::export::start_export` when the blocking task running the
    /// preparation failed to execute, and by `commands::export::run_export_worker` when the
    /// worker panicked or its thread could not be started, mirroring
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
                "audioDurationMismatch",
                "audioGapTooLong",
                "canceled",
                "commandExecutionFailed",
                "encoderUnavailable",
                "exportAlreadyRunning",
                "ffmpegPairMissing",
                "ffmpegProcessFailed",
                "ffmpegSpawnFailed",
                "ffprobeParseFailed",
                "ffprobeProcessFailed",
                "ffprobeSpawnFailed",
                "ffprobeTimedOut",
                "frameCountMismatch",
                "invalidSegment",
                "noSegments",
                "outputDirectoryMissing",
                "outputEqualsSource",
                "outputNotWritable",
                "outputPathInvalid",
                "outputReadOnly",
                "outputRenameFailed",
                "outputStreamsMismatch",
                "presetNotFound",
                "settingsUnreadable",
                "sourceAudioRateUnknown",
                "sourceFrameRateUnknown",
                "sourceHasNoAudio",
                "sourceNotFile",
                "sourceNotFound",
                "sourcePathInvalid",
                "tooManySegments",
            ]
        );
    }

    /// Every [`ExportStreams`] variant, through an exhaustive `match`: a variant added to the
    /// enum fails to compile here until it is added to this list too.
    fn all_export_streams() -> Vec<ExportStreams> {
        let all = [
            ExportStreams::VideoAndAudio,
            ExportStreams::VideoOnly,
            ExportStreams::AudioOnly,
        ];
        for streams in all {
            match streams {
                ExportStreams::VideoAndAudio
                | ExportStreams::VideoOnly
                | ExportStreams::AudioOnly => {}
            }
        }
        all.to_vec()
    }

    #[test]
    fn every_stream_choice_crosses_the_wire_as_its_stable_camel_case_string() {
        // The frontend sends these exact strings (`EXPORT_STREAMS` in
        // `src/features/export/types.ts`), and its parity test reads the `rename` attributes of
        // this enum. This asks serde for both directions, so a rename that serde spells
        // differently than the attribute reads cannot pass.
        let mut serialized = Vec::new();
        for streams in all_export_streams() {
            let value = serde_json::to_value(streams).unwrap();
            let wire = value.as_str().unwrap().to_owned();
            assert_eq!(
                serde_json::from_value::<ExportStreams>(value).unwrap(),
                streams
            );
            serialized.push(wire);
        }
        assert_eq!(serialized, vec!["videoAndAudio", "videoOnly", "audioOnly"]);

        // Any other spelling is refused, the Rust variant name included.
        for refused in ["VideoAndAudio", "video", "audio", "videoAndaudio", ""] {
            assert!(
                serde_json::from_value::<ExportStreams>(serde_json::json!(refused)).is_err(),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn each_stream_choice_names_the_parts_it_writes() {
        let parts: Vec<(bool, bool)> = all_export_streams()
            .into_iter()
            .map(|streams| (streams.writes_video(), streams.writes_audio()))
            .collect();
        assert_eq!(parts, vec![(true, true), (true, false), (false, true)]);
    }
}
