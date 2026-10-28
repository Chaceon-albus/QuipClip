//! Shared vocabulary for the ADR 014 export renderer.
//!
//! ADR 004 gave the semantic steps of the renderer -- probe, plan, build a filter graph,
//! run ffmpeg, verify the frame count, rename the output -- without settling the timestamp
//! arithmetic or the command shape. ADR 014 settles both, from measurements on a real
//! ffmpeg, and this module holds the types that every later stage of the renderer shares.
//!
//! [`plan`] builds the pure [`ExportPlan`] from the probes of the sources, a preset, and the
//! requested pieces (ADR 053): it resolves the output frame rate, frame size and audio output
//! format, computes each piece's exact duration and seek position with the probe of its own
//! source, and converts video PTS into audio ticks. [`ExportPlan`] also
//! exposes [`ExportPlan::input_seek_seconds`], the seek of an input that several pieces read, and
//! [`ExportPlan::separate_audio_process`], which writes the audio of an export with video in a
//! second `ffmpeg` (ADR 043). A plan of one segment can copy the packets of the source audio
//! instead ([`CopiedAudio`], ADR 048), and [`ExportPlan::separate_copy_process`] says when that
//! copy runs in a second `ffmpeg`.
//!
//! [`fsinspect`] is the one production implementation of that injected closure: it turns a real
//! path into the [`PathFacts`] the planner reads, and it reports a file only when it could also
//! read a platform identity for it, so a destination that spells the source a second way -- a hard
//! link, a symlink, a case-insensitive volume -- cannot pass the same-file check.
//!
//! [`inputs`] chooses the inputs of the processes of an export from its pieces alone (ADR 055): one
//! input for each piece up to [`inputs::MAX_EXPORT_INPUTS`] pieces, and otherwise the fewest runs
//! of pieces in source order, each run one input. It is a pure function, and the tests of
//! [`arguments`] prove that each of its answers fits the Windows command-line budget.
//!
//! [`graph`] renders a finished plan into ADR 014's `-filter_complex` string: one
//! `trim`/`atrim` chain for each segment, cut on absolute stream indices at integer
//! `start_pts`/`end_pts` boundaries, joined by `concat` in plan order, with the inputs of an
//! [`inputs::InputAssignment`]: `split` and `asplit` divide an input among its pieces.
//!
//! [`graph_file`] holds the graph files of ADR 055: the export writes each graph into a file of
//! its work directory, and a command names the file with `-/filter_complex` (FFmpeg 7.0 and
//! later) or `-filter_complex_script` (older builds). Its option probe asks the installed
//! `ffmpeg` which of the two it reads, and keeps each successful answer for the life of the
//! process.
//!
//! [`arguments`] builds the ffmpeg argument vector from a plan, the name of its graph file, and
//! the reserved output path, in the order ADR 014's "The command" section gives, with the inputs
//! of the same [`inputs::InputAssignment`] as the graph. This module also holds the command-line
//! budget, which the inputs of a command spend now that the graph is in a file, and the check that
//! refuses a command longer than that budget. Two of the arguments are mandatory. Without `-f`,
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
//! [`work_directory`] owns the work directory of an export (ADR 055): the `ffmpeg` processes run
//! in it, it holds the FLV heads, and it is removed when the processes end and on every other exit
//! path.
//!
//! [`verify`] holds the checks that read the finished file back. The frame count cannot verify an
//! export that writes no video, so [`verify::verify_audio_output`] reads its file back through
//! ffprobe instead: one audio stream, no video stream, and a duration inside a measured tolerance
//! of the plan's. An export with video that copies its audio passes the frame count and then
//! [`verify::verify_copy_streams`], which reads back that the file holds the copied audio
//! (ADR 048).

pub mod arguments;
pub mod copy;
pub mod flv_input;
pub mod fsinspect;
pub mod graph;
pub mod graph_file;
pub mod inputs;
pub mod output;
pub mod plan;
pub mod process;
pub mod progress;
pub mod registry;
pub mod verify;
pub mod work_directory;

pub use arguments::{
    build_arguments, build_audio_arguments, build_copy_arguments, check_command_line,
    encoder_graph, CopyOutput,
};
pub use fsinspect::inspect_path;
pub use graph::{build_audio_graph, build_filter_graph, build_video_graph};
pub use inputs::{assign_inputs, InputAssignment, MAX_EXPORT_INPUTS};
pub use output::PendingOutput;
pub use plan::{build_plan, PathFacts, PathIdentity, PlanRequest, PlanSource, SegmentBoundary};
pub use process::{
    run_export_process, ExportProcessOutcome, ExportProcessRequest, ExportProcessStatus,
};
pub use progress::{ProgressReader, ProgressSnapshot};
pub use registry::{ExportRegistry, ExportSlot, Submission, WaitingRun};
pub use verify::{
    verify_audio_output, verify_copied_audio_output, verify_copy_streams, AudioOutputMismatch,
};

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

/// How an export writes the audio of the source: encoded by the preset, or copied (ADR 048).
///
/// [`plan::build_plan`] copies the audio only when [`copy::decide`] agrees, and otherwise encodes
/// it as for [`ExportAudioMode::Encode`]: no refusal fails the export. Each variant names its wire
/// string explicitly, as [`ExportStreams`] does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportAudioMode {
    /// Decode, cut and encode the audio with the settings of the preset.
    #[serde(rename = "encode")]
    Encode,
    /// Copy the packets of the source audio, when the plan can.
    #[serde(rename = "copy")]
    Copy,
}

/// The most pieces of one export request (ADR 055, "The limits and their order").
///
/// A segment that crosses a junction counts one piece for each of its clips (ADR 053), so the
/// limit can stop an export of fewer segments than pieces. The frontend checks the same limit in
/// the OPEN step and names it in the message of [`ExportErrorCode::TooManySegments`];
/// `MAX_EXPORT_PIECES` in `src/features/export/sequenceRequest.ts` mirrors this value, and
/// `src/features/export/types.test.ts` reads it from this file.
///
/// Since ADR 055 the filter graph is in a file of the work directory ([`graph_file`]), so a
/// command line holds the fixed arguments and the inputs, and [`inputs`] opens at most
/// [`inputs::MAX_EXPORT_INPUTS`] inputs in one process. A piece therefore costs no bytes of the
/// command of the encoder or of the audio process. The one command that still grows with the
/// pieces is the read of the audio gaps (ADR 014 measurement 28), about 27 bytes for each piece of
/// one source. The tests of `arguments.rs` and `probe.rs` prove that every command fits the
/// Windows budget at this count. The value bounds the memory and the run time of one export; it
/// is a judgement of ADR 055, not a measured maximum.
pub const MAX_EXPORT_PIECES: usize = 256;

/// The longest silence, in whole seconds, that the segments of an export may need FFmpeg to
/// hold in memory, all together: in front of the first sample of the source audio stream, and in
/// the gaps inside the stream.
///
/// The part of a segment before that sample becomes silence. When the segment reaches the
/// sample, the audio chain fills that part (`graph::audio_chain`), and FFmpeg holds the whole
/// fill in memory before it writes any of it. ADR 014 measurement 21 measured the fill alone on
/// AAC audio, at this bound: 95 MiB on 48000 Hz stereo, 215 MiB on 48000 Hz 5.1, and 532 MiB on
/// 96000 Hz 7.1. The plan refuses more with [`ExportErrorCode::AudioGapTooLong`].
///
/// A segment with a silence prefix ([`PlannedSegment::audio_prefix`]) gets most of that silence
/// streamed, and only the rest counts. A segment that ends at or before the sample needs no fill
/// either. The end pad of its chain (`graph::audio_end_pad`) writes its silence frame by frame,
/// and holds none of it (ADR 014 measurement 23). Every audio chain carries that pad since the
/// audio has its own process (ADR 043), so such a segment counts nothing toward this bound.
///
/// The fill also makes the silence of a gap inside the stream, longer than
/// [`AUDIO_FILL_MIN_GAP_MILLISECONDS`], and holds all of it in memory too (ADR 014 measurement
/// 28). The export reads those gaps inside the segments before it plans
/// (`ffmpeg::probe::probe_audio_gaps`). The fill passes the silence of one gap on before it reads
/// the frame behind the next, so one chain holds one silence at a time. Each segment counts the
/// longer of its silence in front of the first sample, less the prefix, and the longest gap that
/// it holds audio behind. The silence after the last frame of a segment counts nothing, because
/// the end pad writes it.
pub const MAX_HELD_AUDIO_SILENCE_SECONDS: i64 = 60;

/// The longest gap, in milliseconds, between two frames of the audio that the fill of a chain
/// writes no silence for.
///
/// This is the default `min_hard_comp` of `aresample`, 0.1 s, which the fill
/// (`graph::audio_gap_fill`) keeps. Behind a longer gap, the fill makes the silence of the whole
/// gap, and FFmpeg holds it in memory until the fill has passed it on
/// ([`MAX_HELD_AUDIO_SILENCE_SECONDS`]). The read of the gaps in front of the plan reports only the
/// longer gaps.
pub const AUDIO_FILL_MIN_GAP_MILLISECONDS: i64 = 100;

/// The silence, in milliseconds, that a silence prefix leaves in front of the first audio
/// packet of its segment, for the fill of the chain to close (ADR 014 measurement 27).
///
/// The prefix ends before the first packet, and the fill (`graph::audio_gap_fill`) writes the
/// rest from the real timestamp of the first decoded sample. The fill writes silence only for a
/// gap of more than 0.1 s, so the cut stays exact while the first decoded sample lies at most
/// 0.15 s before the start that the plan reads. That start is the first packet or the start that
/// the probe reports, and the first decoded sample lies at it or after it, by the priming of the
/// encoder, which is at most 2112 samples, 48 ms at 44100 Hz. The fill holds this margin in
/// memory, so it counts toward [`MAX_HELD_AUDIO_SILENCE_SECONDS`].
pub const AUDIO_PREFIX_MARGIN_MILLISECONDS: i64 = 250;

/// The most segments of one export that get a silence prefix ([`PlannedSegment::audio_prefix`]).
///
/// A prefix costs about 120 bytes of the filter graph of its process. Before ADR 055 moved the
/// graph into a file, the widest command line had not that much for every segment. The segments
/// with the longest silence in front of the first sample get the prefixes. Any other segment fills
/// its silence in memory, and that counts toward [`MAX_HELD_AUDIO_SILENCE_SECONDS`].
pub const MAX_AUDIO_PREFIXES: usize = 16;

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
    /// The index of the source of this piece in [`ExportPlan::sources`].
    ///
    /// Every other field of this type is in the units of that source: its video time base, its
    /// container start, and the sample rate of its audio (ADR 053). The plan never compares a
    /// value of one source with a value of another.
    pub source: usize,
    /// The inclusive start of the segment, as a raw source video PTS.
    pub in_pts: Pts,
    /// The exclusive end of the segment, as a raw source video PTS.
    pub out_pts: Pts,
    /// The input seek position for an input of this segment alone, in seconds from the container
    /// start; `None` when the computed value clamped to zero.
    ///
    /// An input that several pieces read through `split` ([`inputs::ExportInput`]) is seeked
    /// for the earliest of them -- see [`ExportPlan::input_seek_seconds`]. Concat order need not
    /// match source-PTS order, so the seek of the first piece of the plan is not the seek of
    /// every input.
    ///
    /// ADR 014's "The seek" section also requires the renderer to omit `-ss` entirely
    /// rather than emit a trailing `-ss 0`: measurement 7 found that idiom has no effect on
    /// ffmpeg 2.1 and later, so a literal zero would be dead weight on the command line,
    /// not a no-op the renderer needs to preserve.
    pub seek_seconds: Option<Rational>,
    /// The inclusive start of the segment's audio, in ticks of `1 / sample_rate`, or `None`
    /// when [`ExportPlan::audio`] is `None`.
    ///
    /// The rate is [`SourceAudio::sample_rate`] of the source of the piece. A piece whose source
    /// has no audio stream ([`PlannedSource::audio`] is `None` in a plan with audio) has no
    /// source rate and reads nothing: its ticks are `0` and `round(duration * outputRate)`, in
    /// ticks of [`PlannedAudio::output_sample_rate`], so that their difference is the length of
    /// its silence (ADR 053).
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
    /// The number of frames the video chain of this segment writes, or `None` when
    /// [`ExportPlan::video`] is `None`.
    ///
    /// This is `round((outPts - inPts) * videoTimeBase * outputFrameRate)`, the term of one
    /// segment in [`PlannedVideo::expected_frames`]. The graph of the audio process of an export
    /// with video gives each segment a stand-in video of this many frames, so that `concat` there
    /// pads the audio of the segment to the length of its video, as it does in the encoder (ADR
    /// 043).
    pub frames: Option<u64>,
    /// The number of samples of silence, at [`SourceAudio::sample_rate`] of its source, that the
    /// audio chain of this segment generates in front of the audio it reads, or `None` for no
    /// prefix.
    ///
    /// [`plan::build_plan`] gives a prefix to a segment that starts at least 1 s plus
    /// [`AUDIO_PREFIX_MARGIN_MILLISECONDS`] before the first sample of the source audio and reaches
    /// that sample, to at most [`MAX_AUDIO_PREFIXES`] segments, and only for a stream of at most
    /// 192000 Hz whose layout is not ambisonic or `binaural`, which the mono silence of the prefix
    /// cannot be converted to. The prefix is the time from the In point to the first sample, less
    /// the margin. The fill of the chain holds its silence in memory, and the prefix streams it
    /// instead (`graph::audio_silence_prefix`, ADR 014 measurement 27).
    pub audio_prefix: Option<i64>,
}

/// The video part of a plan: the stream it reads, how the output frames are timed and sized,
/// the encoder settings a preset selected, and the frame count the export must reach.
///
/// Everything here describes the video stream only, and it only means something when there is
/// video to write. [`ExportPlan::video`] holds it as one optional part for that reason, as
/// [`ExportPlan::audio`] holds [`PlannedAudio`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedVideo {
    /// How the renderer times its output frames. See [`OutputTiming`].
    pub timing: OutputTiming,
    /// The frame size of the output, or `None` to keep the size of the sources.
    ///
    /// `None` only when the preset keeps the source size and every source has the same coded
    /// size, SAR and rotation, so `concat` gets one size and one SAR without a filter. Otherwise
    /// it is the preset size, or the largest display size of the sources, with even sides, and
    /// each source whose display size or SAR does not fit it has a [`PlannedSource::fit`] (ADR
    /// 053).
    pub canvas: Option<Resolution>,
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

/// The audio part of a plan: the format every audio chain ends in, and the encoder settings a
/// preset selected.
///
/// What each chain reads, and the unit its ticks count in, belongs to its source:
/// [`PlannedSource::audio`]. A plan with this part writes an audio stream when at least one
/// source of the pieces has an audio stream, with or without packets (ADR 053).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAudio {
    /// The sample rate every audio chain resamples to before `concat`, in hertz.
    ///
    /// [`plan::build_plan`] resolves the preset's [`AudioSampleRateSetting::Source`] to the
    /// highest [`SourceAudio::sample_rate`] among the sources with an audio stream, so the graph
    /// renders a number and never reads the preset. Every chain ends at this one rate, so `concat`
    /// receives inputs that agree (ADR 023, ADR 053). With one source this is the rate of its
    /// stream.
    ///
    /// [`AudioSampleRateSetting::Source`]: crate::settings::AudioSampleRateSetting::Source
    pub output_sample_rate: u32,
    /// The channel layout the preset asks for. [`AudioChannels::Source`] keeps the layout of the
    /// sources; see [`Self::output_layout`] for the name the chains end in.
    pub output_channels: AudioChannels,
    /// The channel layout that the closing `aformat` of every chain names, or `None` for a chain
    /// that names no layout and keeps the layout of its stream.
    ///
    /// The preset's `stereo` and `mono` name themselves. [`AudioChannels::Source`] names no
    /// layout when every source with an audio stream has the same layout, as before ADR 053.
    /// When the layouts differ, it names the layout of the source with the most channels, an
    /// earlier source on a tie, so `concat` does not choose one; a layout without a plain name
    /// gives the default layout of its channel count (`plan::silence_layout`).
    pub output_layout: Option<String>,
    /// The channel layout of the silence of a piece whose source has no audio stream: the layout
    /// of [`Self::output_layout`], or, when that is `None`, the one layout the sources share. Its
    /// silence is generated at [`Self::output_sample_rate`] in this layout (ADR 053).
    pub absent_layout: String,
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
    /// The gain of the joined audio in tenths of a decibel, verbatim from the preset (ADR 054).
    ///
    /// The graph writes it as one `volume` filter behind `concat` (`graph::audio_gain_chain`),
    /// and only when it is not 0 and a piece reads an audio stream. An export that copies the
    /// audio (ADR 048) applies no gain, as it applies no other audio setting of the preset.
    pub gain_tenths_db: i32,
    /// The length of audio an export of the segments writes, in seconds, exact.
    ///
    /// This is [`ExportPlan::total_duration`], whatever part of the segments the source audio
    /// covers. The graph starts the audio of each segment at its In point and fills a late start
    /// with silence (`graph::audio_chain`), and it pads the end of every audio chain that `concat`
    /// does not pad to the length of its segment (`graph::audio_end_pad`). So a segment that the
    /// audio ends inside, or does not reach at all, writes silence for the rest (ADR 014
    /// measurement 23). Before that pad, this was the part of each segment up to the probed end
    /// of the stream, and the probe could misplace that end by the whole segment (ADR 036).
    /// [`verify::verify_audio_output`] compares the finished file of an export without video
    /// with this value.
    ///
    /// The graph does not read it. It is a bound for the success check, and never an edit
    /// boundary (ADR 002).
    pub expected_duration: Rational,
}

/// The audio stream of one source, as the chains of its pieces use it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceAudio {
    /// The absolute index of the audio stream the filter graph must address.
    ///
    /// ADR 014's "The command" section requires the graph to bind this stream by its
    /// absolute index, never the short specifier `[i:a]`: a short specifier selects the first
    /// audio stream, and the probe selects the stream with the `default` disposition.
    pub stream_index: u32,
    /// The sample rate every `audio_in_tick`/`audio_out_tick` of the pieces of this source is
    /// measured in: the tick unit is `1 / sample_rate` seconds.
    ///
    /// This is always the stream's own rate, whatever the preset asks for, because the graph pins
    /// each input link to it before `atrim` reads the ticks (ADR 014 measurement 17).
    pub sample_rate: u32,
    /// The channel layout of the silence that every chain of this source generates, or `None`
    /// when the chains read the stream.
    ///
    /// [`plan::build_plan`] sets it when the audio stream holds no packets
    /// ([`crate::ffmpeg::AudioProbe::holds_no_packets`]). An input of that stream never gives
    /// an audio frame, so FFmpeg would keep the decoded video until the end of the file before
    /// it configures the graph: 1416 MiB for a segment of 5 s from a source of 120 s at 640x360
    /// (ADR 014 measurement 26). Each chain then generates the silence of its piece
    /// (`graph::audio_silence_chain`) at [`Self::sample_rate`] and reads no input.
    ///
    /// The layout is the one the chain ends in when [`PlannedAudio::output_channels`] names one,
    /// and otherwise the layout of the stream, so the output track has the layout it would have
    /// if the stream held audio.
    pub silence_layout: Option<String>,
}

impl SourceAudio {
    /// True when the chains of this source read its audio stream.
    #[must_use]
    pub fn reads_stream(&self) -> bool {
        self.silence_layout.is_none()
    }
}

/// The size and the place of one source's picture on the canvas (ADR 053): the fit step
/// `scale=<width>:<height>:flags=...,setsar=1,pad=<W>:<H>:<x>:<y>` of each of its pieces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoFit {
    /// The width of the scaled picture, an even number of pixels.
    pub width: u32,
    /// The height of the scaled picture, an even number of pixels.
    pub height: u32,
    /// The left offset of the picture on the canvas, an even number of pixels.
    pub x: u32,
    /// The top offset of the picture on the canvas, an even number of pixels.
    pub y: u32,
}

/// One source of an export, with what the graph and the command read of it (ADR 053).
///
/// [`ExportPlan::sources`] holds the sources in the order of their first piece.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedSource {
    /// The media file the pieces of this source cut from.
    pub path: PathBuf,
    /// The absolute index of the video stream the filter graph must address, for the reason of
    /// [`SourceAudio::stream_index`].
    pub video_stream_index: u32,
    /// The fit step of the pieces of this source, or `None` when their frames already have the
    /// size and the SAR of the output. Always `None` in a plan without video.
    pub fit: Option<VideoFit>,
    /// The audio stream of this source, or `None` when the plan writes no encoded audio or the
    /// source has no audio stream. In a plan with [`ExportPlan::audio`], a piece of a source
    /// without one gets the silence of its length at the output rate (`graph::audio_silence_chain`).
    pub audio: Option<SourceAudio>,
    /// The FLV input of ADR 046, which opens each input of this source as the head of the source
    /// and a slice of it from a keyframe in place of an input seek, or `None` for the input seek
    /// of ADR 014. [`plan::build_plan`] leaves it `None`. `commands::export` sets it for each FLV
    /// source, with one offset for each piece of this source. FFmpeg runs in the work directory of
    /// the export, which holds the head of each such source as `h<k>.flv`, and the command names
    /// each head by its file name (ADR 055).
    pub flv_input: Option<flv_input::FlvInput>,
}

/// The audio part of a plan that copies the packets of the source audio stream into the output
/// (`-c:a copy`), in place of a [`PlannedAudio`] that decodes, cuts and encodes them (ADR 048).
///
/// A copy keeps whole packets. The command keeps the packets from the first one whose decoding
/// time is at or after [`Self::start`] to the last one whose decoding time is before
/// [`Self::end`], and it moves their timestamps back by [`Self::start`]. Where the source audio
/// covers the segment, each end of the copied audio therefore lies within one packet of the In
/// point or the Out point, which the user accepts for this mode, and the audio keeps its place
/// against the video. A copy writes no silence, so audio that starts late, ends early or has a gap
/// inside the segment stays so in the output, and the plan encodes such audio instead. ADR 048
/// holds the measurements.
///
/// The cut reads the absolute times of the source that `-copyts` keeps, so neither value is
/// relative to the container start, as the seek of [`PlannedSegment::seek_seconds`] is. They are
/// bounds for the command, and never edit boundaries (ADR 002).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopiedAudio {
    /// The absolute index of the audio stream whose packets the export copies.
    pub stream_index: u32,
    /// The In point of the segment, in seconds: `inPts * videoTimeBase`, exact.
    pub start: Rational,
    /// The Out point of the segment, in seconds: `outPts * videoTimeBase`, exact.
    pub end: Rational,
    /// Whether the command that writes the output file converts the AAC of the stream from ADTS
    /// to the configuration that MP4 and Matroska store (`-bsf:a aac_adtstoasc`). This is the
    /// AAC of an MPEG-TS source, as the preview copies it (ADR 046).
    pub adts_to_asc: bool,
}

/// A fully resolved, ready-to-render export: its sources, its pieces in concat order, and
/// the video and audio parts with the encoder settings a preset selected.
///
/// [`plan::build_plan`] is the only place that produces this type. Every field is already
/// resolved -- no later stage of the renderer re-reads the preset or the probe -- so a
/// change to a preset after planning cannot silently retarget an export already in flight.
///
/// Both parts are optional, and each one is a whole decision for the graph: a part that is
/// `None` writes no chain, no label, no map, and no encoder flag anywhere. [`plan::build_plan`]
/// plans each part from the [`ExportStreams`] choice of the request, and it never produces a
/// plan that writes nothing: a plan with neither part copies its audio
/// ([`Self::copied_audio`]).
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    /// The sources of the pieces, in the order of their first piece. Each one has at least one
    /// piece ([`PlannedSegment::source`]).
    pub sources: Vec<PlannedSource>,
    /// The final output location. The renderer writes a temporary file beside it and
    /// renames on success (ADR 004, ADR 014's "Other rules").
    pub destination: PathBuf,
    /// The video this plan writes, or `None` for a plan with no video.
    ///
    /// [`plan::build_plan`] fills this part exactly when [`ExportStreams::writes_video`] holds
    /// for the request. A plan without it is an audio-only export, and the frame count cannot
    /// verify that export; [`verify`] holds the check that does.
    pub video: Option<PlannedVideo>,
    /// The audio this plan encodes: the format every audio chain ends in and the encoder
    /// settings, or `None` when the plan writes no encoded audio. What each chain reads, and the
    /// rate its ticks count in, belongs to the source of its piece ([`PlannedSource::audio`],
    /// [`ExportPlan::audio_tick_rate`]).
    ///
    /// ADR 014 requires an exact `atrim` boundary in ticks of `1 / sample_rate`, and
    /// forbids the imprecise fallback of `atrim`'s `start`/`end` options, which ffmpeg
    /// parses into microseconds -- exactly the truncation ADR 002 already rules out
    /// elsewhere. A source whose audio stream carries no usable sample rate therefore has
    /// no ADR-014-compliant way to be cut at all, and [`plan::build_plan`] refuses the whole
    /// export with [`ExportErrorCode::SourceAudioRateUnknown`] rather than reaching this
    /// field: dropping the track here would write a video-only file for a source the
    /// preview played with sound, and report nothing. `None` therefore means one of three
    /// things, and all are stated, never silent: no source of the pieces has an audio stream,
    /// the user chose [`ExportStreams::VideoOnly`], or the plan copies the audio
    /// ([`Self::copied_audio`]). A [`SourceAudio`] always carries its stream index and its rate
    /// together, so "an audio stream to address, but no exact way to address it" cannot be
    /// represented. A source without an audio stream in a plan with audio is not that case: its
    /// pieces generate silence at the output rate (ADR 053).
    pub audio: Option<PlannedAudio>,
    /// The audio this plan copies from the source, or `None` when the plan encodes its audio or
    /// writes none (ADR 048).
    ///
    /// A plan holds at most one of [`Self::audio`] and this part, and this part only with one
    /// segment. With video, a second `ffmpeg` copies the packets into a pipe, and the encoder
    /// copies them from it into the output ([`Self::separate_copy_process`]); the graph of the
    /// encoder is the graph of a plan without audio. Without video, one `ffmpeg` copies the
    /// packets into the output file, and the command has no filter graph
    /// ([`arguments::build_copy_arguments`]).
    pub copied_audio: Option<CopiedAudio>,
    /// Why the plan encodes the audio that the request asked it to copy, or `None` when the
    /// request asked for no copy or the plan copies (ADR 048). No stage of the renderer reads it:
    /// `commands::export` writes it to the log, and the export runs as an encode.
    pub audio_copy_refusal: Option<copy::CopyRefusal>,
    /// The pieces to render, in the order they must appear in the concatenated output. The
    /// field keeps the name of ADR 014, whose segments were the pieces of one source.
    pub segments: Vec<PlannedSegment>,
    /// The output container, which selects the muxer (ADR 004).
    pub container: Container,
    /// The exact total output duration: the rational sum of every segment's duration.
    pub total_duration: Rational,
}

impl ExportPlan {
    /// True when a second `ffmpeg` writes the audio of this export and the encoder reads it from
    /// a pipe (ADR 043): the plan writes video, and its audio chains read the audio stream.
    ///
    /// FFmpeg configures a filter graph only when each input link has a first frame, and it keeps
    /// every decoded video frame until then (ADR 014 measurement 21). An input whose audio comes
    /// late, never, or only after a gap therefore makes the encoder keep the video of that time.
    /// With the audio in its own process, the graph of the encoder reads no audio input, and the
    /// graph of the audio process decodes no video. A plan without video has nothing to keep, a
    /// plan without audio nothing to wait for, and a plan whose chains all generate silence
    /// ([`SourceAudio::silence_layout`], or a source without an audio stream) reads no audio
    /// input, so each of those is one process. One piece that reads a stream is enough for a
    /// second process, and the other pieces get their silence chains there (ADR 053).
    #[must_use]
    pub fn separate_audio_process(&self) -> bool {
        self.video.is_some() && self.audio.is_some() && self.reads_audio_stream()
    }

    /// True when the chain of at least one piece reads an audio stream of its source: a plan
    /// with [`Self::audio`] in which a source of the pieces has a stream that holds packets.
    #[must_use]
    pub fn reads_audio_stream(&self) -> bool {
        self.audio.is_some() && (0..self.segments.len()).any(|piece| self.piece_reads_audio(piece))
    }

    /// True when the audio chain of the piece `piece` reads the audio stream of its source.
    #[must_use]
    pub fn piece_reads_audio(&self, piece: usize) -> bool {
        self.audio.is_some()
            && self
                .segments
                .get(piece)
                .and_then(|segment| self.sources.get(segment.source))
                .and_then(|source| source.audio.as_ref())
                .is_some_and(SourceAudio::reads_stream)
    }

    /// The source of the piece `piece`.
    ///
    /// # Panics
    ///
    /// When `piece` or its source index is out of range, which [`plan::build_plan`] never makes.
    #[must_use]
    pub fn source_of(&self, piece: usize) -> &PlannedSource {
        &self.sources[self.segments[piece].source]
    }

    /// The sample rate the audio ticks of the piece `piece` count in: the rate of the audio stream
    /// of its source, or [`PlannedAudio::output_sample_rate`] for a source without one, whose
    /// ticks are the length of its silence at that rate. `None` in a plan without audio.
    #[must_use]
    pub fn audio_tick_rate(&self, piece: usize) -> Option<u32> {
        let audio = self.audio.as_ref()?;
        Some(
            self.source_of(piece)
                .audio
                .as_ref()
                .map_or(audio.output_sample_rate, |source| source.sample_rate),
        )
    }

    /// True when a second `ffmpeg` copies the audio packets of the source into a pipe, and the
    /// encoder copies them from that pipe into the output (ADR 048): the plan writes video and
    /// copies its audio ([`Self::copied_audio`]).
    ///
    /// The cut of a copy is an output `-ss` and `-to` of the command that copies, and an output
    /// option applies to every stream of its output. In the encoder it would also cut the video,
    /// so the copy has a command of its own. This is not [`Self::separate_audio_process`]: that
    /// process decodes the audio, and its encoder reads PCM.
    #[must_use]
    pub fn separate_copy_process(&self) -> bool {
        self.video.is_some() && self.copied_audio.is_some()
    }

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

    /// The seek of an input that `pieces` read, all of one source: the seek of the piece with the
    /// smallest `in_pts`, before the earliest frame that any of them requires (ADR 014's "The
    /// seek"). `split`/`asplit` divide the decoded stream among the `trim` chain of each piece.
    ///
    /// In an assignment of [`inputs::assign_inputs`] the pieces of an input are in source order, so
    /// this is the seek of its first piece, and an input of one piece takes that piece's own seek.
    /// The rule here does not depend on that order: concat order need not match source-PTS order,
    /// and a seek to a later piece would skip material an earlier one needs.
    ///
    /// Every piece's own `seek_seconds` is a strictly increasing function of its `in_pts` alone --
    /// same time base, same `format_start_time`, same margin, for every piece of one source and one
    /// plan -- so the piece with the smallest `in_pts` already carries the correct seek, clamped
    /// exactly as ADR 014 requires. This method only has to find that piece. It never compares the
    /// PTS of two sources: the pieces are of one source.
    #[must_use]
    pub fn input_seek_seconds(&self, pieces: &[usize]) -> Option<Rational> {
        debug_assert!(
            pieces
                .windows(2)
                .all(|pair| self.segments[pair[0]].source == self.segments[pair[1]].source),
            "one input reads one source"
        );
        pieces
            .iter()
            .map(|piece| &self.segments[*piece])
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
    /// Produced by `commands::export::start_export`: the application exit began, so the
    /// registry starts and queues no export any more
    /// ([`registry::ExportRegistry::close_for_exit`]).
    ExportQueueClosed => "exportQueueClosed",
    /// Produced by `commands::export::start_export`: the preset of the request fails the
    /// rules of the settings document (`settings::validate_preset`). The detail carries the
    /// reason. The request carries the whole preset (ADR 049), so the export reads no settings
    /// file.
    InvalidPreset => "invalidPreset",
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
    /// Produced by `commands::export::run_export_job_with`: preparation did not end within
    /// `commands::export::PREPARATION_TIMEOUT`. A step of preparation that waits in the file
    /// system, such as the discovery of ffmpeg on a share that stopped answering, cannot be
    /// interrupted, so the export thread stops waiting for it and releases the slot. The detail
    /// names the stage of preparation that was running.
    PreparationTimedOut => "preparationTimedOut",
    /// Produced by [`plan::build_plan`] and `commands::export::resolve_request`: the request
    /// carried zero pieces.
    NoSegments => "noSegments",
    /// Produced by [`plan::build_plan`] and `commands::export::resolve_request`: the request
    /// carried more than [`MAX_EXPORT_PIECES`] pieces (ADR 053: the limit counts pieces; ADR 055
    /// sets it).
    TooManySegments => "tooManySegments",
    /// Produced by `commands::export::resolve_request`: the list of sources of the request does
    /// not match its pieces. The list is empty, an id is empty or appears twice, a piece names an
    /// id that the list does not hold, or a source has no piece. The detail names the fault and
    /// the id, as a diagnostic for a bug report (ADR 011): the frontend builds the request, so
    /// only a fault there produces this code.
    InvalidSources => "invalidSources",
    /// Produced by `commands::export::resolve_request`: the `segmentCount` of the request is 0 or
    /// larger than the number of its pieces. Each segment gives at least one piece (ADR 052).
    InvalidSegmentCount => "invalidSegmentCount",
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
    /// Produced by `commands::export::check_source_revision`: the size or the modification time
    /// of a source differs from the revision that the request expects, so the segments may
    /// name other frames (ADR 049). The detail is the id of that source in the request (ADR 053).
    SourceRevisionMismatch => "sourceRevisionMismatch",
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
    /// the source reports no audio stream, or one that holds no packets (ADR 014 measurement 26).
    /// A plan without video and without audio would write nothing, and one of an empty stream only
    /// silence, so the export is refused before anything is reserved.
    SourceHasNoAudio => "sourceHasNoAudio",
    /// Produced by [`plan::build_plan`]: the export writes audio, and the silence that the fills
    /// of its chains hold in memory adds up to more than [`MAX_HELD_AUDIO_SILENCE_SECONDS`].
    ///
    /// Each segment counts the longer of two silences: its part before the first sample of the
    /// source audio stream, less its silence prefix, and the longest gap inside the stream that it
    /// holds audio behind. FFmpeg holds each of them in memory until the fill has passed it on. For
    /// the part before the first sample, every export counts only the segments that reach it,
    /// because the end pad of each chain that reads the stream writes the silence of the others
    /// frame by frame, without holding it (`graph::audio_end_pad`): every chain of an export
    /// without video, and every chain of the audio process of an export with video (ADR 043). An
    /// export with [`ExportStreams::VideoOnly`] reads no audio, so it never produces this code. A
    /// gap inside the stream counts only when the read of the gaps in front of the plan succeeded
    /// (`ffmpeg::probe::probe_audio_gaps`).
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
    /// to start. Also produced by [`graph_file::probe_graph_file_option`], when the process of
    /// the option probe fails to start, and by `commands::export::prepare_export_with`, when a
    /// command is longer than the command-line budget of the platform
    /// ([`arguments::check_command_line`]), with the lengths in the detail (ADR 055).
    FfmpegSpawnFailed => "ffmpegSpawnFailed",
    /// Produced by `commands::export::run_export_with`: `ffmpeg` exited unsuccessfully. Also
    /// produced by [`graph_file::probe_graph_file_option`], when the option probe fails for a
    /// reason other than an unrecognized option, or does not exit in time (ADR 055).
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
    /// Produced by `commands::export::run_export_job_with` when preparation panicked or its
    /// helper thread could not be started, and by `commands::export::run_export_worker` when the
    /// worker panicked or its thread could not be started, mirroring
    /// `ImportMediaErrorCode::CommandExecutionFailed`.
    CommandExecutionFailed => "commandExecutionFailed",
    /// Produced by `commands::export::start_export`, when the cache directory of the application
    /// has no path, and by `commands::export::prepare_export_with`, when the work directory of
    /// the export cannot be created or a graph file cannot be written in it (ADR 055).
    WorkDirectoryUnavailable => "workDirectoryUnavailable",
    /// Produced by [`graph_file::probe_graph_file_option`]: the `ffmpeg` of the export reads a
    /// filter graph from a file with neither `-/filter_complex` nor `-filter_complex_script`
    /// (ADR 055). The detail carries the stderr tail of the second run.
    GraphFileUnsupported => "graphFileUnsupported",
    /// Produced by `commands::export::resolve_request` and [`plan::build_plan`]: the pieces need
    /// more runs in source order than [`inputs::MAX_EXPORT_INPUTS`] ([`inputs::check_runs`],
    /// ADR 055). A run is the pieces of one source that one input can feed through `split` without
    /// a piece that waits. The check comes after the checks of the sources and the segments,
    /// because the count of runs needs valid source ids and In points before Out points.
    PiecesOutOfOrder => "piecesOutOfOrder",
    /// Produced by `commands::export::resolve_request` and [`plan::build_plan`]: the request
    /// carried more sources than [`inputs::MAX_EXPORT_INPUTS`], because each source needs one
    /// input (ADR 055). The check comes after the check of the list of sources, so the count is
    /// the count of valid sources that the pieces name.
    TooManySources => "tooManySources",
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
                "exportQueueClosed",
                "ffmpegPairMissing",
                "ffmpegProcessFailed",
                "ffmpegSpawnFailed",
                "ffprobeParseFailed",
                "ffprobeProcessFailed",
                "ffprobeSpawnFailed",
                "ffprobeTimedOut",
                "frameCountMismatch",
                "graphFileUnsupported",
                "invalidPreset",
                "invalidSegment",
                "invalidSegmentCount",
                "invalidSources",
                "noSegments",
                "outputDirectoryMissing",
                "outputEqualsSource",
                "outputNotWritable",
                "outputPathInvalid",
                "outputReadOnly",
                "outputRenameFailed",
                "outputStreamsMismatch",
                "piecesOutOfOrder",
                "preparationTimedOut",
                "sourceAudioRateUnknown",
                "sourceFrameRateUnknown",
                "sourceHasNoAudio",
                "sourceNotFile",
                "sourceNotFound",
                "sourcePathInvalid",
                "sourceRevisionMismatch",
                "tooManySegments",
                "tooManySources",
                "workDirectoryUnavailable",
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
    fn every_audio_mode_crosses_the_wire_as_its_stable_string() {
        // The frontend sends these exact strings (`EXPORT_AUDIO_MODES` in
        // `src/features/export/types.ts`), and its parity test reads the `rename` attributes of
        // this enum, as for the stream choice below.
        let all = [ExportAudioMode::Encode, ExportAudioMode::Copy];
        for audio_mode in all {
            match audio_mode {
                ExportAudioMode::Encode | ExportAudioMode::Copy => {}
            }
        }
        let serialized: Vec<String> = all
            .iter()
            .map(|audio_mode| {
                let value = serde_json::to_value(audio_mode).unwrap();
                assert_eq!(
                    serde_json::from_value::<ExportAudioMode>(value.clone()).unwrap(),
                    *audio_mode
                );
                value.as_str().unwrap().to_owned()
            })
            .collect();
        assert_eq!(serialized, vec!["encode", "copy"]);
        for refused in ["Encode", "Copy", "passthrough", ""] {
            assert!(
                serde_json::from_value::<ExportAudioMode>(serde_json::json!(refused)).is_err(),
                "{refused:?}"
            );
        }
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
