//! Assemble ADR 014's `ffmpeg` command line, and refuse one that does not fit the platform's limit.
//!
//! [`build_arguments`] is pure: it reads a finished [`ExportPlan`], the name of its graph file, and
//! the reserved output path, and it returns the argument vector verbatim. It spawns nothing, opens
//! nothing, and reads no clock, so every rule ADR 014 settled about the command is testable
//! without ffmpeg installed -- which is what the pinned-vector tests below do, exactly as
//! [`crate::ffmpeg::capabilities::smoke`]'s tests pin ADR 006's two smoke commands verbatim.
//!
//! Five of ADR 014's rules live here and nowhere else.
//!
//! - **`-copyts` is set once, before the first input.** Measurement 18 found the option
//!   global: one instance gives raw source PTS on every input, which is the timestamp domain
//!   the plan's `trim` boundaries live in. A second instance changes nothing except the length
//!   of the command line.
//! - **`-y` is mandatory.** [`super::output::PendingOutput`] reserves the output path by
//!   *creating* the file, so the path exists, and holds zero bytes, before ffmpeg starts.
//!   Without `-y` ffmpeg prints `File '<path>' already exists. Exiting.` -- and **exits zero**,
//!   because fftools maps `AVERROR_EXIT` to exit code 0. A caller that read only the exit
//!   status would then rename that zero-byte reservation over the user's video. `output.rs`
//!   documents the measurement; this module is the one that has to act on it.
//! - **`-f <muxer>` is mandatory.** The reserved name ends in `.tmp-<pid>-<sequence>`, not in
//!   `.mp4`, so ffmpeg has no extension to infer a muxer from. [`Container::Mkv`] selects the
//!   muxer named `matroska`, not `mkv`; the other two names match their enum variants, except
//!   that an audio-only export of a MOV preset writes an `.m4a` through the `mp4` muxer (see
//!   `muxer_of`).
//! - **An input `-ss` is omitted, never zeroed.** ADR 014's "The seek" section clamps a negative
//!   seek at zero and reports it as [`None`], and measurement 7 records that the legacy trailing
//!   `-ss 0` idiom has had no effect since ffmpeg 2.1. A literal zero would be dead weight, so
//!   an input whose [`seek_seconds`](super::PlannedSegment::seek_seconds) is `None` carries no
//!   `-ss` at all. The output `-ss` of a copy of the audio is not that seek, and it is written at
//!   zero too ([`build_copy_arguments`], ADR 048).
//! - **The graph is in a file.** Since ADR 055, the encoder and the audio process read their graphs
//!   from files in the work directory of the export, and a command carries the option and the
//!   name of the file: `-/filter_complex encoder.graph` on FFmpeg 7.0 and later, and
//!   `-filter_complex_script encoder.graph` on older builds. ADR 014 measurement 13 found no single
//!   spelling that every build reads, so the probe of [`super::graph_file`] chooses one of the two.
//!   The command line no longer grows with the chains of the graph.
//!
//! Without the graph, the command holds the fixed arguments and the inputs, and the inputs decide
//! its length. The inputs come from an [`InputAssignment`] of [`super::inputs`], which the caller
//! passes to the graph builder and to this module alike: no command here is measured to choose
//! them. The tests below prove that every assignment fits the Windows budget: no assignment holds
//! more than [`MAX_EXPORT_INPUTS`](super::inputs::MAX_EXPORT_INPUTS) inputs, and the widest command
//! of that many inputs fits. [`check_command_line`] still refuses a longer command before it
//! spawns, as a guard that the tests make unreachable. See [`WINDOWS_COMMAND_LINE_LIMIT`] for the
//! budget.
//!
//! No step here uses floating point. A seek reaches ffmpeg as an exact decimal expansion of the
//! plan's [`Rational`], truncated at ffmpeg's own microsecond resolution; the private
//! `render_seek` has the rounding rule and its one-sided guarantee.

use super::flv_input::FlvInput;
use super::graph::{build_filter_graph, build_video_graph, input_layout, GraphInput};
use super::graph_file::GraphFile;
use super::inputs::InputAssignment;
use super::{CopiedAudio, ExportPlan, PlannedAudio, PlannedVideo};
use crate::settings::{Container, OptionStream, PresetOption, Quality, QualityKind};
use crate::time::Rational;
use std::path::Path;

/// The process-level flags every export command opens with, in ADR 014's order.
///
/// `-nostdin` comes from ADR 004: a child that can read the terminal can also block on a
/// prompt nobody will answer. `-progress pipe:1 -nostats` is what makes
/// [`super::progress::ProgressReader`] work at all -- without it stdout carries nothing to
/// parse and every snapshot stays empty. `-y` is the mandatory overwrite flag this module's
/// documentation describes.
const PROCESS_FLAGS: [&str; 8] = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-progress",
    "pipe:1",
    "-nostats",
    "-y",
];

/// The number of decimal places [`render_seek`] renders a seek position with.
///
/// ffmpeg parses a duration argument into `AV_TIME_BASE` units, and `AV_TIME_BASE` is
/// 1000000, so a seventh decimal digit cannot change where the seek lands. This is a limit on
/// the *spelling*, not on the arithmetic: the value itself stays an exact [`Rational`] until
/// this last step, per ADR 002.
const SEEK_DECIMALS: u32 = 6;

/// The hard limit Windows places on one command line, in characters, from `CreateProcessW`'s
/// documented maximum for `lpCommandLine`.
///
/// This is the number ADR 014's "The graph shape" section budgets against, and the reason
/// [`super::inputs::MAX_EXPORT_INPUTS`] exists. It is *not* the 8191-character limit of
/// `cmd.exe`: the renderer spawns ffmpeg directly, with no shell in between.
pub const WINDOWS_COMMAND_LINE_LIMIT: usize = 32_767;

/// The `ARG_MAX` of macOS, in bytes, as `getconf ARG_MAX` reports it.
///
/// This limit covers the arguments *and* the environment block together, and `execve` charges
/// for both plus its own per-string overhead, so it is a ceiling rather than a spawnable size:
/// measured with a 4463-byte environment, the largest argument block that actually execs is
/// 1043694 bytes, which is below [`UNIX_COMMAND_LINE_BUDGET`]. A command sized exactly to that
/// budget would therefore fail with `E2BIG` on macOS.
///
/// Nothing reaches it. [`super::inputs::MAX_EXPORT_INPUTS`] holds the widest command the settings
/// permit below the Windows budget, more than 30 times smaller, so this constant is a real platform
/// number for the platform rather than a bound the renderer ever tests. The inputs of an export do
/// not depend on the platform: macOS and Windows open the same inputs for the same pieces.
pub const UNIX_ARGUMENT_LIMIT: usize = 1_048_576;

/// Bytes held back from the platform limit for everything this module cannot see.
///
/// The command line the operating system counts also carries the ffmpeg executable path as
/// argument zero, which [`super::process::ExportProcessRequest`] supplies and this module
/// never sees, plus whatever quoting the standard library's spawn code adds around it. 1 KiB
/// is four times the 260 characters Windows allows a non-extended path, so it covers argument
/// zero several times over.
///
/// On Windows the environment does *not* come out of this budget: `CreateProcessW` measures
/// `lpEnvironment` against its own separate 32767-character maximum, so 1 KiB against the
/// command line is the whole of what this holds back. On macOS the environment *is* charged to
/// the same `ARG_MAX`, and 1 KiB does not cover a real one; see [`UNIX_ARGUMENT_LIMIT`] for why
/// that shortfall stays theoretical.
const COMMAND_LINE_HEADROOM_BYTES: usize = 1_024;

/// The bytes one argument adds to the assembled command line beyond its own content.
///
/// One separating space, and two quotation marks for the arguments that need them -- the
/// source path and the output path can. Charging every argument for quoting
/// it may not need keeps the estimate on the safe side of the real command line, which is the
/// only side that matters for a budget.
const ARGUMENT_OVERHEAD_BYTES: usize = 3;

/// What one command line may occupy on Windows, after the headroom.
///
/// This constant exists separately from [`COMMAND_LINE_BUDGET`] so a test can assert the
/// Windows property while running on macOS. That is not a convenience: the developers and CI
/// of this project run on macOS, whose limit is 32 times larger, so a budget test written
/// against the host platform's own number would pass on every machine that ever runs it and
/// prove nothing about the platform the limit belongs to.
pub const WINDOWS_COMMAND_LINE_BUDGET: usize =
    WINDOWS_COMMAND_LINE_LIMIT - COMMAND_LINE_HEADROOM_BYTES;

/// What one command line may occupy on macOS, after the headroom.
pub const UNIX_COMMAND_LINE_BUDGET: usize = UNIX_ARGUMENT_LIMIT - COMMAND_LINE_HEADROOM_BYTES;

/// The command-line budget of the platform this build runs on.
///
/// The export runs on the machine that plans it, so the host's own limit is the right one.
#[cfg(windows)]
pub const COMMAND_LINE_BUDGET: usize = WINDOWS_COMMAND_LINE_BUDGET;

/// The command-line budget of the platform this build runs on.
///
/// The export runs on the machine that plans it, so the host's own limit is the right one.
#[cfg(not(windows))]
pub const COMMAND_LINE_BUDGET: usize = UNIX_COMMAND_LINE_BUDGET;

/// Refuse `arguments` when they are longer than [`COMMAND_LINE_BUDGET`], the budget of this
/// platform, with a detail that names both lengths.
///
/// The inputs of a command come from [`super::inputs::assign_inputs`], and the tests of this
/// module prove that the widest command of every assignment fits the Windows budget, so this never
/// refuses a command of a plan that [`super::plan::build_plan`] made. It is the guard of ADR 055
/// for what the tests cannot see: a command that does not start must fail with a cause, not with
/// an error of the operating system. `commands::export` reports the refusal as
/// `ffmpegSpawnFailed` with this detail.
///
/// # Errors
///
/// The detail, when the command is too long.
pub fn check_command_line(arguments: &[String]) -> Result<(), String> {
    check_command_line_within(arguments, COMMAND_LINE_BUDGET)
}

/// [`check_command_line`] against an explicit budget, so a test can ask the question with a
/// small one.
fn check_command_line_within(arguments: &[String], budget: usize) -> Result<(), String> {
    let length = command_line_length(arguments);
    if length > budget {
        return Err(format!(
            "the command line needs {length} bytes, over the budget of {budget}"
        ));
    }
    Ok(())
}

/// The graph of the encoder of `plan` with the inputs of `inputs`: [`build_video_graph`] when the
/// audio has its own process of ADR 043, and the graph of one process, [`build_filter_graph`],
/// otherwise. A plan
/// that copies its audio has no [`ExportPlan::audio`], so [`build_filter_graph`] renders the graph
/// of its video alone, whether a copy process runs beside the encoder or not (ADR 048).
#[must_use]
pub fn encoder_graph(plan: &ExportPlan, inputs: &InputAssignment) -> String {
    if plan.separate_audio_process() {
        build_video_graph(plan, inputs)
    } else {
        build_filter_graph(plan, inputs)
    }
}

/// The number of bytes an assembled argument vector occupies on a command line.
///
/// Byte length, not character count, is the conservative measure of the two: Windows counts
/// UTF-16 code units, and no character encodes to fewer UTF-8 bytes than it does UTF-16 units,
/// so a non-ASCII path can only make this estimate larger than the real command line, never
/// smaller.
fn command_line_length(arguments: &[String]) -> usize {
    arguments
        .iter()
        .map(|argument| argument.len() + ARGUMENT_OVERHEAD_BYTES)
        .sum()
}

/// Build the complete ffmpeg argument vector for `plan`, in ADR 014's order.
///
/// `graph` names the file in the work directory that holds the string [`encoder_graph`] returned
/// for these same `inputs` (ADR 055). The command carries the option of the probe and the name of the
/// file, as two arguments, and never the graph itself. `output` is the reserved temporary path
/// [`super::output::PendingOutput::path`] returns, **not** [`ExportPlan::destination`]: ffmpeg
/// writes the reservation, and the rename that publishes the destination happens after this
/// process has exited.
///
/// The vector excludes the executable itself. [`super::process::ExportProcessRequest`] carries
/// the ffmpeg path separately, exactly as [`std::process::Command`] does.
///
/// # Preconditions
///
/// `plan.segments` must not be empty, and `inputs` must be the assignment that the graph in the
/// file `graph` was rendered with.
/// [`super::plan::build_plan`] rejects an empty request with
/// [`ExportErrorCode::NoSegments`](super::ExportErrorCode::NoSegments), so an empty plan cannot
/// arise from it, and a debug assertion catches a hand-built one: it would produce a command
/// with no `-i` at all. Two assignments can disagree about how many `-i` arguments the graph's
/// input labels refer to, so mismatching them produces a command ffmpeg rejects while parsing
/// the graph.
///
/// # Video
///
/// `-map "[v]"`, `-c:v`, `-pix_fmt`, and the quality flags appear exactly when
/// [`ExportPlan::video`] is [`Some`], which is exactly when [`build_filter_graph`] writes a
/// `[v]` output label. [`super::plan::build_plan`] plans video for every export that writes
/// it, so every such command carries them all, and an audio-only command carries none of them.
///
/// The order for the video stream is `-c:v <encoder> -pix_fmt <format>`, then the quality
/// flags, then each encoder option of the preset as `-<name>:v <value>`. The audio stream
/// follows the same pattern: `-c:a`, `-b:a` when the preset holds a bitrate, then each
/// `-<name>:a <value>`.
///
/// A plan without video also changes the muxer. An audio-only export writes an audio file, an
/// `.m4a` beside an MP4 or a MOV preset and an `.mka` beside an MKV preset. The frontend will
/// name the destination with that extension; this module never renames it. See [`muxer_of`]
/// for the choice.
///
/// # Audio
///
/// A `-map` of the audio and an audio encoder appear exactly when [`ExportPlan::audio`] is
/// [`Some`], and the copy below is the one other case that maps audio. For
/// a plan of one process, the map is `-map "[a]"`, and for every plan
/// [`super::plan::build_plan`] produces, [`build_filter_graph`] then writes an `[a]` output
/// label. (The two can only disagree for a hand-built plan that carries an audio stream but leaves
/// a segment without ticks; `build_filter_graph` documents that case, and a debug assertion there
/// is what reports it.) For a plan whose audio has its own process
/// ([`ExportPlan::separate_audio_process`]), the command opens `-f wav -i pipe:0` after the
/// inputs of the source, and the map is `-map <n>:a`, the audio of that pipe, outside the graph
/// (ADR 043). Neither the audio encoder name nor an audio bitrate reaches the command line
/// otherwise.
///
/// A plan with video that copies its audio ([`ExportPlan::separate_copy_process`]) opens
/// `-f nut -i pipe:0` in the same place, maps `-map <n>:a`, and writes `-c:a copy` after the video
/// flags, with `-bsf:a aac_adtstoasc` for AAC from MPEG-TS (ADR 048). Its graph is the graph of a
/// plan without audio, and the command carries no output `-ss`, `-to`, `-t` or `-shortest`: the
/// copy process ends the stream, and the encoder reads `pipe:0` to its end. A plan without video
/// that copies its audio has no graph, and [`build_copy_arguments`] writes its command.
///
/// `-b:a <n>k` follows `-c:a` directly when the audio part also carries a
/// [`super::PlannedAudio::bitrate`] (ADR 023). [`Quality`] still describes the video stream
/// only. With no bitrate the audio encoder runs at its own default, which is what every export
/// did before ADR 023, so an older preset renders the same vector as before. This writes the
/// flag for any encoder, lossless ones included: ADR 023 leaves the knowledge of which encoders
/// take no bitrate to the editor, which clears the value for them.
#[must_use]
pub fn build_arguments(
    plan: &ExportPlan,
    inputs: &InputAssignment,
    graph: GraphFile<'_>,
    output: &Path,
) -> Vec<String> {
    debug_assert!(
        !plan.segments.is_empty(),
        "an export plan must carry at least one segment"
    );

    let mut arguments: Vec<String> = PROCESS_FLAGS
        .iter()
        .map(|flag| (*flag).to_owned())
        .collect();

    // One `-copyts`, before every input, for all of them. ADR 014 measurement 18: the option is
    // global, so a copy on each input would buy nothing but bytes -- about a kilobyte of them at
    // the most inputs a command opens.
    arguments.push("-copyts".to_owned());

    debug_assert!(
        plan.audio.is_none() || plan.copied_audio.is_none(),
        "a plan encodes its audio or copies it, never both"
    );
    debug_assert!(
        plan.video.is_some() || plan.copied_audio.is_none(),
        "the copy of an export without video has no graph; build_copy_arguments writes it"
    );

    let inputs = push_inputs(&mut arguments, plan, inputs, plan.video.is_some());
    // The audio of an export whose audio has its own process arrives as a WAV stream on stdin
    // (ADR 043), and copied packets arrive as a NUT stream (ADR 048). The pipe follows the inputs
    // of the source, so the graph's input numbers do not move. `-f` is necessary: a pipe has no
    // name to infer a demuxer from.
    if plan.separate_audio_process() {
        push_pair(&mut arguments, "-f", AUDIO_PIPE_FORMAT);
        push_pair(&mut arguments, "-i", "pipe:0");
    } else if plan.separate_copy_process() {
        push_pair(&mut arguments, "-f", COPY_PIPE_FORMAT);
        push_pair(&mut arguments, "-i", "pipe:0");
    }

    push_pair(&mut arguments, graph.option.flag(), graph.name);
    if plan.video.is_some() {
        push_pair(&mut arguments, "-map", "[v]");
    }
    if plan.audio.is_some() {
        // The audio of the pipe goes to the encoder without a filter. Its samples already have the
        // rate and the layout of the preset, and the graph of the encoder reads no audio input.
        let audio = if plan.separate_audio_process() {
            format!("{inputs}:a")
        } else {
            "[a]".to_owned()
        };
        push_pair(&mut arguments, "-map", &audio);
    } else if plan.separate_copy_process() {
        push_pair(&mut arguments, "-map", &format!("{inputs}:a"));
    }

    push_encoder_arguments(&mut arguments, plan.video.as_ref(), plan.audio.as_ref());
    if let Some(copied) = plan.copied_audio.as_ref() {
        push_copy_codec(&mut arguments, copied);
    }
    push_muxer_arguments(&mut arguments, plan.container, plan.video.is_some());
    arguments.push(path_argument(output));
    arguments
}

/// Build the argument vector of the audio process of `plan` (ADR 043). `graph` names the file
/// that holds the graph [`super::graph::build_audio_graph`] rendered with `inputs` (ADR 055).
///
/// The process opens the inputs of `inputs` whose pieces read an audio stream, with the seeks and
/// the FLV slices with which the encoder opens them, maps the `[a]` of its graph,
/// and writes it to its stdout as 32-bit float PCM in WAV, which the encoder reads as `pipe:0`.
/// A second output maps the stand-in video `[pv]` to the `null` muxer, which writes nothing and
/// opens no file, so the stdout carries the WAV stream alone. That output, and not a `nullsink` in
/// the graph, keeps the audio in step; see [`super::graph::build_audio_graph`].
///
/// - The flags differ from [`PROCESS_FLAGS`] on purpose. `-progress pipe:1` would write the
///   progress text into the stdout that carries the audio, and only the encoder's progress
///   counts. `-y` has no file to overwrite.
/// - `pcm_f32le` holds every sample of the `fltp` that the chains end in without a change.
/// - WAV is the one container of the three measured that keeps a channel layout through the pipe,
///   in its channel mask. NUT and Matroska reported `5.1(side)` as `unknown` on the other side,
///   and WAV gave it back, on FFmpeg 9.0.2. A stereo or mono stream arrives as 2 or 1 channels of
///   no layout, and the encoder writes them as stereo and mono again, so the output headers did
///   not change. A layout that no mask names, such as `downmix` or `22.2`, arrives without its
///   names (ADR 043). A WAV stream on a pipe has no length in its header, and the reader reads it
///   to its end: a pipe of 4.6 GB, 25 min of 7.1 at 96 kHz, arrived whole.
/// - The process writes the audio at the length of the export. The encoder therefore reads its
///   `pipe:0` to the end, which [`super::ExportProcessRequest::audio_arguments`] requires: no
///   `-shortest` and no output `-t` here or in the encoder.
#[must_use]
pub fn build_audio_arguments(
    plan: &ExportPlan,
    inputs: &InputAssignment,
    graph: GraphFile<'_>,
) -> Vec<String> {
    debug_assert!(
        !plan.segments.is_empty(),
        "an export plan must carry at least one segment"
    );
    let mut arguments: Vec<String> = AUDIO_PROCESS_FLAGS
        .iter()
        .map(|flag| (*flag).to_owned())
        .collect();
    arguments.push("-copyts".to_owned());
    push_inputs(&mut arguments, plan, inputs, false);
    push_pair(&mut arguments, graph.option.flag(), graph.name);
    push_pair(&mut arguments, "-map", "[a]");
    push_pair(&mut arguments, "-c:a", AUDIO_PIPE_CODEC);
    push_pair(&mut arguments, "-f", AUDIO_PIPE_FORMAT);
    arguments.push("pipe:1".to_owned());
    // The stand-in video, to an output that discards it. `rawvideo` is the encoder every build
    // has, and its frames are 2x2 pixels.
    push_pair(&mut arguments, "-map", "[pv]");
    push_pair(&mut arguments, "-c:v", "rawvideo");
    push_pair(&mut arguments, "-f", "null");
    arguments.push("-".to_owned());
    arguments
}

/// The flags the command of the audio process opens with: [`PROCESS_FLAGS`] without
/// `-progress pipe:1` and without `-y`. See [`build_audio_arguments`].
const AUDIO_PROCESS_FLAGS: [&str; 5] =
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-nostats"];

/// The codec of the audio in the pipe from the audio process to the encoder.
const AUDIO_PIPE_CODEC: &str = "pcm_f32le";

/// The container of the audio in the pipe from the audio process to the encoder.
const AUDIO_PIPE_FORMAT: &str = "wav";

/// The container of the packets in the pipe from the copy process to the encoder (ADR 048).
///
/// NUT keeps the timestamps of the packets in the time base of the stream, so the encoder writes
/// them exactly as the copy process moved them. Matroska rounds them to milliseconds. NUT gives E-AC-3 the codec
/// of AC-3 on the other side, and the `mp4` muxer then refuses it, so E-AC-3 is not copied (ADR 048
/// measurement 7).
const COPY_PIPE_FORMAT: &str = "nut";

/// The bitstream filter that converts AAC from ADTS to the configuration MP4 and Matroska store.
const ADTS_TO_ASC_FILTER: &str = "aac_adtstoasc";

/// Where the command of [`build_copy_arguments`] writes the packets that it copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOutput<'a> {
    /// The stdout of the copy process of an export with video, as NUT, which the encoder reads as
    /// its `pipe:0` ([`ExportPlan::separate_copy_process`]).
    Pipe,
    /// The output file of an export without video: the reserved temporary path that
    /// [`super::output::PendingOutput::path`] returns.
    File(&'a Path),
}

/// Build the argument vector of the command that copies the audio packets of `plan` (ADR 048), or
/// [`None`] when the plan copies no audio ([`ExportPlan::copied_audio`]).
///
/// The command opens the input of the one segment as the encoder does, with the same seek or the
/// same FLV slice, and maps the audio stream by its absolute index with `-c:a copy`. It has no
/// filter graph. The cut is an output `-ss` and `-to` at the absolute In and Out points:
///
/// - Under `-copyts`, an output `-ss` drops the packets whose decoding time is before it, and
///   moves the timestamps of the rest back by it. `-to` ends the output at the first packet whose
///   decoding time is at or after it. Where the source audio covers the segment, the audio of the
///   output therefore starts and ends within one packet of the In and the Out point, at the place
///   it holds in the source (ADR 048 measurements 3 and 4). The plan copies only such a segment.
/// - The output `-ss` is written at an In point of zero too, unlike the input seek of ADR 014. It
///   then drops the priming packet of AAC, whose timestamp is negative (measurement 5).
/// - ADR 046 measurement 6 found that an output `-t` under `-copyts` writes no frames. An output
///   `-ss` with `-to` reads both on the timeline of the source, so the cut works (measurement 3).
///
/// For [`CopyOutput::Pipe`], the flags are those of the audio process of ADR 043, and the command
/// writes NUT to its stdout: no `-progress pipe:1`, which would write text into that stdout, and no
/// `-y`. The encoder ([`build_arguments`]) reads the stream as `pipe:0`, and its own command
/// converts AAC from ADTS where the plan asks, because the muxer of the output file needs the
/// result.
///
/// For [`CopyOutput::File`], the command is the whole export of a plan without video: the flags of
/// every export command, the conversion from ADTS, and the muxer of an audio-only export
/// ([`muxer_of`]).
///
/// # Panics
///
/// In a debug build, when the plan has more than one segment or also encodes audio, or when
/// `output` does not match the plan: [`CopyOutput::Pipe`] for a plan with video, and
/// [`CopyOutput::File`] for a plan without it.
#[must_use]
pub fn build_copy_arguments(plan: &ExportPlan, output: CopyOutput<'_>) -> Option<Vec<String>> {
    let copied = plan.copied_audio.as_ref()?;
    debug_assert!(
        plan.segments.len() == 1,
        "an export copies the audio of one segment only"
    );
    debug_assert!(
        plan.audio.is_none(),
        "a plan encodes its audio or copies it, never both"
    );
    debug_assert!(
        matches!(output, CopyOutput::Pipe) == plan.video.is_some(),
        "a copy with video writes to the pipe, and a copy without video writes the file"
    );

    let flags: &[&str] = match output {
        CopyOutput::Pipe => &AUDIO_PROCESS_FLAGS,
        CopyOutput::File(_) => &PROCESS_FLAGS,
    };
    let mut arguments: Vec<String> = flags.iter().map(|flag| (*flag).to_owned()).collect();
    arguments.push("-copyts".to_owned());
    let sources: Vec<usize> = plan.segments.iter().map(|segment| segment.source).collect();
    push_inputs(
        &mut arguments,
        plan,
        &InputAssignment::one_per_piece(&sources),
        true,
    );
    push_pair(
        &mut arguments,
        "-map",
        &format!("0:{}", copied.stream_index),
    );
    match output {
        CopyOutput::Pipe => push_pair(&mut arguments, "-c:a", COPY_CODEC),
        CopyOutput::File(_) => push_copy_codec(&mut arguments, copied),
    }
    push_pair(&mut arguments, "-ss", &render_time(copied.start));
    push_pair(&mut arguments, "-to", &render_time(copied.end));
    match output {
        CopyOutput::Pipe => {
            push_pair(&mut arguments, "-f", COPY_PIPE_FORMAT);
            arguments.push("pipe:1".to_owned());
        }
        CopyOutput::File(path) => {
            // The file of a copy holds the audio alone.
            push_muxer_arguments(&mut arguments, plan.container, false);
            arguments.push(path_argument(path));
        }
    }
    Some(arguments)
}

/// The name of the codec that copies packets.
const COPY_CODEC: &str = "copy";

/// Append the codec of the copied audio for the command that writes the output file:
/// `-c:a copy`, and the conversion from ADTS when [`CopiedAudio::adts_to_asc`] asks for it.
fn push_copy_codec(arguments: &mut Vec<String>, copied: &CopiedAudio) {
    push_pair(arguments, "-c:a", COPY_CODEC);
    if copied.adts_to_asc {
        push_pair(arguments, "-bsf:a", ADTS_TO_ASC_FILTER);
    }
}

/// Append the inputs of `inputs` that the command reads, and return how many there are.
///
/// The inputs are those of [`input_layout`], which the graph of the same command reads: with
/// `every_piece`, every input; without it, only those of the pieces whose chains read an audio
/// stream (ADR 053). Each input opens its source with the seek of its earliest piece, or with the
/// FLV slice of that piece. Both come from the input of the assignment, not from the pieces the
/// command reads, so every process that opens an input opens it the same way.
///
/// The encoder and the audio process open the same kind of inputs. A process that reads the
/// audio of a source and one that reads its video each read from the keyframe in front of the
/// seek, so the same seeks serve both.
fn push_inputs(
    arguments: &mut Vec<String>,
    plan: &ExportPlan,
    inputs: &InputAssignment,
    every_piece: bool,
) -> usize {
    let layout = input_layout(plan, inputs, every_piece);
    for input in &layout.inputs {
        let pieces = &inputs.inputs()[input.assigned].pieces;
        let path = &plan.sources[input.source].path;
        match flv_offset(plan, input, pieces) {
            Some((flv, offset)) => push_flv_input(arguments, flv, offset, path),
            // The seek of the earliest piece of the input, which is its first piece in an
            // assignment of `assign_inputs`. This must be `input_seek_seconds`, not the seek of the
            // first piece of the plan: concat order need not match source order, so seeking to a
            // later piece would skip material an earlier one still needs.
            None => push_input(arguments, plan.input_seek_seconds(pieces), path),
        }
    }
    layout.inputs.len()
}

/// The FLV input of the source of `input` and the offset of its slice: the earliest slice of
/// `pieces`, the pieces of the input in the assignment, which is the slice of its first piece in
/// an assignment of `assign_inputs`. `None` when the source has no FLV input, or no offset for a
/// piece, which `commands::export` never makes.
///
/// [`FlvInput::segment_offsets`] holds one offset for each piece of its source, in concat order,
/// so the offset of a piece is at the number of pieces of the same source in front of it.
/// `commands::export` checks exactly these slices before the export (ADR 046, ADR 055).
fn flv_offset<'a>(
    plan: &'a ExportPlan,
    input: &GraphInput,
    pieces: &[usize],
) -> Option<(&'a FlvInput, u64)> {
    let flv = plan.sources[input.source].flv_input.as_ref()?;
    let offsets: Option<Vec<u64>> = pieces
        .iter()
        .map(|piece| {
            let ordinal = plan.segments[..*piece]
                .iter()
                .filter(|segment| segment.source == input.source)
                .count();
            flv.segment_offsets.get(ordinal).copied()
        })
        .collect();
    let offset = offsets?.into_iter().min()?;
    Some((flv, offset))
}

/// Append one FLV input of ADR 046: the head and the slice of the source from `offset`, joined
/// with the concat protocol, and no seek. FFmpeg runs in the work directory of the export, which
/// holds the head, so the command names the head by its file name (ADR 055).
fn push_flv_input(arguments: &mut Vec<String>, flv: &FlvInput, offset: u64, source: &Path) {
    arguments.push("-i".to_owned());
    arguments.push(flv.url(&flv.head_name, offset, source));
}

/// Append the encoder arguments of each part a command writes: the video ones when `video` is
/// [`Some`], then the audio ones when `audio` is [`Some`], in the order [`build_arguments`]
/// documents.
///
/// [`build_arguments`] calls this for an export, and the test of a preset on this machine
/// (`crate::ffmpeg::capabilities::preset_test`) calls it for its short encode, so the test
/// writes exactly the encoder flags an export of the same preset writes.
pub(crate) fn push_encoder_arguments(
    arguments: &mut Vec<String>,
    video: Option<&PlannedVideo>,
    audio: Option<&PlannedAudio>,
) {
    if let Some(video) = video {
        push_pair(arguments, "-c:v", &video.encoder);
        // The graph already ends the video in this format. With the flag, ffmpeg reports an
        // encoder that cannot take the format with a warning, where the graph alone would let it
        // convert to a format of the encoder's own with no word. The export runs at
        // `-loglevel error`, so only a run at warning level, such as the test of a preset,
        // shows that warning; the export then still writes the encoder's own format.
        push_pair(arguments, "-pix_fmt", &video.pixel_format);
        push_quality(arguments, video.quality);
        push_options(arguments, &video.options, OptionStream::Video);
    }
    if let Some(audio) = audio {
        push_pair(arguments, "-c:a", &audio.encoder);
        // Kilobits per second on the wire, with the `k` suffix, as for `-b:v`: the bare number
        // would mean bits per second, which is a thousand times too small.
        if let Some(bitrate) = audio.bitrate {
            push_pair(arguments, "-b:a", &format!("{bitrate}k"));
        }
        push_options(arguments, &audio.options, OptionStream::Audio);
    }
}

/// Append the muxer arguments for `container`: `-movflags +faststart` where it applies, then
/// `-f <muxer>`. See [`muxer_of`] for the choice.
///
/// The test of a preset calls this too, and it writes its short encode through the same muxer
/// to a real file, because some faults, such as a codec tag the muxer refuses, show only when
/// the muxer writes the header.
pub(crate) fn push_muxer_arguments(
    arguments: &mut Vec<String>,
    container: Container,
    with_video: bool,
) {
    let (muxer, faststart) = muxer_of(container, with_video);
    if faststart {
        push_pair(arguments, "-movflags", "+faststart");
    }
    push_pair(arguments, "-f", muxer);
}

/// Append one input group: the seek when there is one, and `-i <source>`.
///
/// `-copyts` is not here. It belongs to the command, not to an input: ADR 014 measurement 18
/// found the option global, so [`build_arguments`] emits it once ahead of every input group.
/// What it buys is the timestamp domain the plan's `trim` boundaries are written in --
/// measurement 1 found that without it the filter graph observes shifted timestamps, and the
/// boundaries are raw source PTS values that only line up under the unshifted ones.
fn push_input(arguments: &mut Vec<String>, seek: Option<Rational>, source: &Path) {
    // No `else` branch on purpose: a seek of zero is spelled by the absence of `-ss`, never by
    // `-ss 0`. See this module's documentation, and `render_seek` for the second way a seek
    // reaches this point as a zero.
    if let Some(rendered) = seek.and_then(render_seek) {
        push_pair(arguments, "-ss", &rendered);
    }
    arguments.push("-i".to_owned());
    arguments.push(path_argument(source));
}

/// Append a flag and its value as two separate arguments.
fn push_pair(arguments: &mut Vec<String>, flag: &str, value: &str) {
    arguments.push(flag.to_owned());
    arguments.push(value.to_owned());
}

/// Append the quality flags for one preset's [`Quality`], from ADR 013.
///
/// `Bitrate` is stored in kilobits per second, so it reaches ffmpeg with the `k` suffix; the
/// bare number would mean bits per second, which is a thousand times too small and would still
/// encode, badly, without any error.
///
/// `Cq` writes `-b:v 0` after `-cq`. The NVENC encoders set a default bitrate of 2 Mbit/s,
/// and a constant quality under that bitrate would be capped by it.
fn push_quality(arguments: &mut Vec<String>, quality: Quality) {
    let value = quality.value.to_string();
    match quality.kind {
        QualityKind::Crf => push_pair(arguments, "-crf", &value),
        QualityKind::Cq => {
            push_pair(arguments, "-cq", &value);
            push_pair(arguments, "-b:v", "0");
        }
        QualityKind::Bitrate => push_pair(arguments, "-b:v", &format!("{value}k")),
        QualityKind::QualityScale => push_pair(arguments, "-q:v", &value),
    }
}

/// Append the encoder options of one stream, in their order, each as its flag and its value.
///
/// The flag carries the stream specifier (see [`crate::settings::PresetOption::flag`]), so a
/// video option never reaches the audio encoder. Each option comes after the flags this module
/// writes for its stream, so an option that `settings::validate_settings` let through cannot
/// take the place of one of them. The value is one argument, verbatim: no shell reads it.
fn push_options(arguments: &mut Vec<String>, options: &[PresetOption], stream: OptionStream) {
    for option in options {
        push_pair(arguments, &option.flag(stream), &option.value);
    }
}

/// The muxer name for one container, and whether `-movflags +faststart` applies to it, for a
/// command that writes video (`with_video`) or one that writes audio only.
///
/// The two answers come from one `match` because they are one decision. `+faststart` is an
/// option of the mov/mp4 muxer family and nothing else; pairing it with the muxer name here
/// means a container added later cannot pick up a muxer without also stating whether the flag
/// belongs on it. `Mkv` maps to `matroska`, which is the muxer's real name -- `ffmpeg -f mkv`
/// is not a muxer at all.
///
/// An audio-only export writes an audio file. Beside an MP4 or a MOV preset that file is an
/// `.m4a`, written by the `mp4` muxer, with `+faststart` for the same reason as an MP4 video.
/// `mov` is not used for it: the `mov` muxer refuses `flac` and `opus` (ADR 023 measurement 2),
/// and the `mp4` muxer accepts both, so a MOV preset whose audio encoder only the `mp4` muxer
/// takes still exports its audio. Nor is `ipod`, the muxer ffmpeg itself infers from an `.m4a`
/// name: on ffmpeg 9.0.2 it refuses `flac` as well ("codec not currently supported in
/// container"). A custom PCM encoder from a MOV preset may need a newer ffmpeg in the `mp4` muxer.
/// Beside an MKV preset the file is an `.mka`, which the `matroska` muxer writes as it writes an
/// `.mkv`.
///
/// The plan reads the muxer too, to decide whether the output can hold copied audio
/// (`super::copy::decide`, ADR 048).
pub(crate) const fn muxer_of(container: Container, with_video: bool) -> (&'static str, bool) {
    match (container, with_video) {
        (Container::Mp4, _) | (Container::Mov, false) => ("mp4", true),
        (Container::Mov, true) => ("mov", true),
        (Container::Mkv, _) => ("matroska", false),
    }
}

/// Render a path as one command-line argument.
///
/// A path that is not valid Unicode reaches ffmpeg through `to_string_lossy`, which is the
/// same down-conversion [`crate::ffmpeg::locate`] and [`crate::ffmpeg::capabilities::cache`]
/// already apply, and it is forced by the interface: an argument vector of [`String`] cannot
/// carry an unpaired surrogate or a non-UTF-8 byte. Such a path is not reachable through the
/// application -- the frontend supplies both paths as JSON strings -- so the loss is confined
/// to a caller that builds an [`ExportPlan`] from raw bytes.
fn path_argument(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Render an exact rational number of seconds as the decimal `-ss` expects, or [`None`] for a
/// value ffmpeg would read as no seek at all.
///
/// The expansion is exact for every value whose denominator divides a power of ten, which is
/// the common case; the rest are **truncated toward zero** at [`SEEK_DECIMALS`], never rounded
/// to nearest.
///
/// # The guarantee is one-sided
///
/// Truncation moves a **positive** value marginally *earlier*, which is the same direction ADR
/// 014's `SEEK_MARGIN_SECONDS` already moves it: a seek that lands early costs a few decoded
/// frames, and a seek that lands late can cost real ones (measurement 9). It moves a
/// **negative** value later -- `-2/3` renders as `-0.666666`, which is nearer to zero than the
/// value asked for -- so "never later" holds for the positive half of the domain only.
///
/// That is the whole domain a plan can produce. [`super::plan::build_plan`] clamps at zero and
/// keeps the value only when `raw_seek.num() > 0`, so a negative seek reaches here from a
/// hand-built plan and from nothing else, and ffmpeg has no use for one either. Rendering it
/// with a leading `-` rather than refusing it keeps this function total; it is not a claim that
/// the result is correct to seek with. At ffmpeg's own microsecond resolution the error is
/// under a microsecond in either direction, against a margin of five seconds.
///
/// This does not call [`crate::time::format_seconds`]. That function rounds to nearest, which
/// is the wrong direction here, and it returns an [`Option`] whose `None` this call site could
/// only answer with a panic or an invented seek. The arithmetic below is total: an `i64`
/// numerator scaled by a million stays far inside `i128`.
///
/// Trailing zeros are trimmed, so an integral seek renders as `5` and not `5.000000`. ffmpeg
/// parses both identically; the short form is what a user reads in a log.
///
/// # The `None` case
///
/// A seek whose whole magnitude is under one microsecond truncates to zero, and this returns
/// [`None`] for it rather than the string `0`. That keeps ADR 014's "never emit `-ss 0`" rule a
/// property of this module rather than a property of the values that happen to reach it: a
/// plan's seek is clamped at zero and reported as [`None`] when it clamps, but a *positive*
/// seek finer than ffmpeg's own resolution is still reachable from a source with a very fine
/// time base, and it is exactly the input that would otherwise spell the forbidden flag. The
/// substitution is also the safe one: dropping the flag seeks to the container start instead of
/// a point under a microsecond later, which costs a few decoded frames and no accuracy.
fn render_seek(seek: Rational) -> Option<String> {
    let scale = 10_u128.pow(SEEK_DECIMALS);
    let numerator = i128::from(seek.num()).unsigned_abs();
    // `Rational` reduces with a positive denominator, so the sign lives entirely in the
    // numerator and the magnitude arithmetic below never has to consider it.
    let denominator = i128::from(seek.den()).unsigned_abs();
    let scaled = numerator * scale / denominator;
    if scaled == 0 {
        return None;
    }
    let sign = if seek.num() < 0 { "-" } else { "" };
    let whole = scaled / scale;
    let fraction = scaled % scale;
    if fraction == 0 {
        return Some(format!("{sign}{whole}"));
    }
    let digits = format!("{fraction:0>width$}", width = SEEK_DECIMALS as usize);
    let digits = digits.trim_end_matches('0');
    Some(format!("{sign}{whole}.{digits}"))
}

/// Render an exact rational number of seconds as the output `-ss` or `-to` of a copy (ADR 048):
/// [`render_seek`]'s spelling, except that a zero renders as `0`.
///
/// The output `-ss` of a copy is not the input seek that ADR 014 never writes as zero. At an In
/// point of zero it drops the packets before the In point, the priming packet of AAC among them,
/// so it must be written. The truncation toward zero moves a bound by less than a microsecond,
/// and the cut keeps whole packets.
fn render_time(seconds: Rational) -> String {
    render_seek(seconds).unwrap_or_else(|| "0".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::flv_input::head_name;
    use crate::ffmpeg::export::graph_file::{
        GraphFileOption, AUDIO_GRAPH_FILE, ENCODER_GRAPH_FILE,
    };
    use crate::ffmpeg::export::inputs::{assign_inputs, MAX_EXPORT_INPUTS};
    use crate::ffmpeg::export::plan::SegmentBoundary;
    use crate::ffmpeg::export::{
        max_export_pieces, OutputTiming, PlannedAudio, PlannedSegment, PlannedSource, PlannedVideo,
        SourceAudio, VideoFit, MAX_AUDIO_PREFIXES, MAX_EXPORT_SEGMENTS,
    };
    use crate::project::Resolution;
    use crate::settings::{
        AudioChannels, MAX_AUDIO_BITRATE_KBPS, MAX_AUDIO_SAMPLE_RATE, MAX_CONSTANT_QUALITY,
        MAX_ENCODER_NAME_CHARS, MAX_PIXEL_FORMAT_CHARS, MAX_PRESET_OPTIONS,
        MAX_PRESET_OPTION_BYTES, MAX_RESOLUTION_DIMENSION, MIN_AUDIO_BITRATE_KBPS,
        MIN_AUDIO_GAIN_TENTHS_DB, MIN_AUDIO_SAMPLE_RATE,
    };
    use crate::time::Pts;
    use std::path::PathBuf;

    /// The inputs of a pinned command: one input for each piece, or one input for each source that
    /// `split` and `asplit` divide among its pieces, the single-input shape of ADR 014.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Inputs {
        PerPiece,
        PerSource,
    }

    impl Inputs {
        /// The assignment of these inputs for the pieces of `plan`.
        fn of(self, plan: &ExportPlan) -> InputAssignment {
            let sources: Vec<usize> = plan.segments.iter().map(|segment| segment.source).collect();
            match self {
                Self::PerPiece => InputAssignment::one_per_piece(&sources),
                Self::PerSource => InputAssignment::one_per_source(&sources),
            }
        }
    }

    // The builders with the inputs of `Inputs`, so each pinned command names its layout.

    fn build_arguments(
        plan: &ExportPlan,
        inputs: Inputs,
        graph: GraphFile<'_>,
        output: &Path,
    ) -> Vec<String> {
        super::build_arguments(plan, &inputs.of(plan), graph, output)
    }

    fn build_audio_arguments(
        plan: &ExportPlan,
        inputs: Inputs,
        graph: GraphFile<'_>,
    ) -> Vec<String> {
        super::build_audio_arguments(plan, &inputs.of(plan), graph)
    }

    fn encoder_graph(plan: &ExportPlan, inputs: Inputs) -> String {
        super::encoder_graph(plan, &inputs.of(plan))
    }

    fn build_filter_graph(plan: &ExportPlan, inputs: Inputs) -> String {
        super::build_filter_graph(plan, &inputs.of(plan))
    }

    fn build_audio_graph(plan: &ExportPlan, inputs: Inputs) -> String {
        crate::ffmpeg::export::graph::build_audio_graph(plan, &inputs.of(plan))
    }

    /// The graph file of the encoder, as the probe of ADR 055 finds it on FFmpeg 7.0 and later.
    ///
    /// `build_arguments` writes the option and the name of the file as two arguments, and never
    /// reads the graph. `graph.rs` pins what the graph contains for every shape, resolution, and
    /// timing mode, so the vectors below are about the flags *around* the graph file.
    const GRAPH: GraphFile<'static> = GraphFile {
        option: GraphFileOption::Slash,
        name: ENCODER_GRAPH_FILE,
    };

    /// The graph file of the audio process of ADR 043, as for [`GRAPH`].
    const AUDIO_GRAPH: GraphFile<'static> = GraphFile {
        option: GraphFileOption::Slash,
        name: AUDIO_GRAPH_FILE,
    };

    /// The source path every fixture plan cuts from.
    const SOURCE: &str = "/media/source.mp4";

    /// The reserved temporary output path, in `PendingOutput::reserve`'s own naming: a dotted
    /// name beside the destination, suffixed with the process id and a sequence number.
    ///
    /// The destination itself (`/export/out.mp4`) must never appear on a command line. ffmpeg
    /// writes the reservation, and the rename that publishes the destination happens after the
    /// process has exited.
    const OUTPUT: &str = "/export/.out.mp4.tmp-4242-0";

    /// The three fixture segments, in concat order, with the seek each one implies.
    ///
    /// The PTS and tick numbers are `graph.rs`'s own fixture, so a vector here can be read
    /// beside a graph there: ADR 014 measurement 6's constant-frame-rate MP4, video time base
    /// 1/12800, cut against a 44100 Hz audio stream. The seeks are what `build_plan` derives
    /// from those boundaries with a container start time of zero and ADR 014's five-second
    /// margin: 148480/12800 - 5 = 6.6, 128000/12800 - 5 = 5, and 256000/12800 - 5 = 15.
    ///
    /// Element 1 starts *earlier* in the source than element 0, and therefore carries the
    /// smallest seek. ADR 007 makes array order authoritative and forbids sorting, so this
    /// ordering is what separates `input_seek_seconds` from `segments[0]`.
    fn fixture_segments(count: usize) -> Vec<PlannedSegment> {
        [
            segment(148_480, 151_552, 511_560, 522_144, Rational::new(33, 5)),
            segment(128_000, 134_144, 441_000, 462_168, Rational::new(5, 1)),
            segment(256_000, 262_144, 882_000, 903_168, Rational::new(15, 1)),
        ][..count]
            .to_vec()
    }

    fn segment(
        in_pts: i64,
        out_pts: i64,
        audio_in_tick: i64,
        audio_out_tick: i64,
        seek_seconds: Option<Rational>,
    ) -> PlannedSegment {
        PlannedSegment {
            source: 0,
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
            seek_seconds,
            audio_in_tick: Some(audio_in_tick),
            audio_out_tick: Some(audio_out_tick),
            // 25 frames per second at the time base of 1/12800: one frame is 512 ticks.
            frames: Some(u64::try_from((out_pts - in_pts) / 512).unwrap()),
            audio_prefix: None,
        }
    }

    /// The audio part written out in the pre-ADR 023 format of 48000 Hz stereo.
    fn legacy_audio() -> PlannedAudio {
        PlannedAudio {
            output_sample_rate: 48_000,
            output_channels: AudioChannels::Stereo,
            output_layout: Some("stereo".to_owned()),
            absent_layout: "stereo".to_owned(),
            encoder: "aac".to_owned(),
            bitrate: None,
            options: vec![],
            gain_tenths_db: 0,
            // The command does not read it; any value renders the same command.
            expected_duration: Rational::new(1, 1).unwrap(),
        }
    }

    /// One source at `path`: video at `video_index`, and an audio stream at `audio_index`, with
    /// ticks at `sample_rate`, that the chains read.
    fn source_at(
        path: &str,
        video_index: u32,
        audio_index: u32,
        sample_rate: u32,
    ) -> PlannedSource {
        PlannedSource {
            path: PathBuf::from(path),
            video_stream_index: video_index,
            fit: None,
            audio: Some(SourceAudio {
                stream_index: audio_index,
                sample_rate,
                silence_layout: None,
            }),
            flv_input: None,
        }
    }

    /// A plan over the first `count` fixture segments: H.264 video at CRF 20, AAC audio at the
    /// encoder's own default bitrate, MP4.
    ///
    /// No audio bitrate, as a preset from before ADR 023 plans, so every pinned vector below
    /// that does not set one is the vector ADR 014 shipped.
    fn fixture_plan(count: usize) -> ExportPlan {
        let frames = 6 + 12 * (count - 1);
        ExportPlan {
            sources: vec![source_at(SOURCE, 1, 2, 44_100)],
            destination: PathBuf::from("/export/out.mp4"),
            video: Some(PlannedVideo {
                timing: OutputTiming::ConstantFrameRate(Rational::new(25, 1).unwrap()),
                canvas: None,
                encoder: "libx264".to_owned(),
                quality: Quality {
                    kind: QualityKind::Crf,
                    value: 20,
                },
                pixel_format: "yuv420p".to_owned(),
                options: vec![],
                expected_frames: Some(u64::try_from(frames).unwrap()),
            }),
            audio: Some(legacy_audio()),
            segments: fixture_segments(count),
            container: Container::Mp4,
            total_duration: Rational::new(i64::try_from(frames).unwrap(), 25).unwrap(),
            copied_audio: None,
            audio_copy_refusal: None,
        }
    }

    /// The video part of a fixture plan, which every fixture carries.
    fn video_mut(plan: &mut ExportPlan) -> &mut PlannedVideo {
        plan.video
            .as_mut()
            .expect("every fixture plan carries video")
    }

    /// The audio part of a fixture plan that still carries one.
    fn audio_mut(plan: &mut ExportPlan) -> &mut PlannedAudio {
        plan.audio
            .as_mut()
            .expect("this fixture plan carries audio")
    }

    /// `build_arguments` for a fixture plan and the sentinel graph, against `OUTPUT`.
    fn arguments(plan: &ExportPlan, shape: Inputs) -> Vec<String> {
        build_arguments(plan, shape, GRAPH, Path::new(OUTPUT))
    }

    #[test]
    fn builds_the_exact_adr_014_command_for_one_segment() {
        assert_eq!(
            arguments(&fixture_plan(1), Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_script_option_names_the_same_file_in_the_same_place() {
        // The probe of ADR 055 finds `-filter_complex_script` on a build older than 7.0. The
        // command is the command of `-/filter_complex` with the other flag.
        let script = |name| GraphFile {
            option: GraphFileOption::Script,
            name,
        };
        assert_eq!(
            build_arguments(
                &fixture_plan(1),
                Inputs::PerPiece,
                script(ENCODER_GRAPH_FILE),
                Path::new(OUTPUT)
            ),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-filter_complex_script",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
        assert_eq!(
            build_audio_arguments(&fixture_plan(1), Inputs::PerPiece, script(AUDIO_GRAPH_FILE)),
            vec![
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostats",
                "-copyts",
                "-ss",
                "6.6",
                "-i",
                "/media/source.mp4",
                "-filter_complex_script",
                "audio.graph",
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
        );
    }

    /// The input arguments of a command: everything between `-copyts` and the graph file.
    fn input_arguments(plan: &ExportPlan, shape: Inputs) -> Vec<String> {
        let all = arguments(plan, shape);
        let start = all.iter().position(|a| a == "-copyts").unwrap() + 1;
        let end = all.iter().position(|a| a == "-/filter_complex").unwrap();
        all[start..end].to_vec()
    }

    #[test]
    fn the_audio_process_writes_its_audio_as_wav_to_its_stdout_and_no_progress() {
        // The same inputs as the encoder, the `[a]` of its graph, and 32-bit float PCM in WAV on
        // stdout. No `-progress pipe:1`, which would write text into that stdout, and no `-y`.
        // The stand-in video goes to the `null` muxer, which opens no file.
        let plan = fixture_plan(3);
        let tail = [
            "-/filter_complex",
            "audio.graph",
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
        ];
        let head = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-copyts",
        ];
        let per_segment = [
            "-ss", "6.6", "-i", SOURCE, "-ss", "5", "-i", SOURCE, "-ss", "15", "-i", SOURCE,
        ];
        assert_eq!(
            build_audio_arguments(&plan, Inputs::PerPiece, AUDIO_GRAPH),
            [&head[..], &per_segment[..], &tail[..]].concat()
        );
        assert_eq!(
            build_audio_arguments(&plan, Inputs::PerSource, AUDIO_GRAPH),
            [&head[..], &["-ss", "5", "-i", SOURCE][..], &tail[..]].concat()
        );
    }

    #[test]
    fn the_encoder_of_a_separate_audio_process_maps_the_audio_of_its_stdin() {
        // The pipe follows the inputs of the source, and the encoder maps its audio by input
        // number, past the graph.
        let plan = fixture_plan(3);
        assert!(plan.separate_audio_process());
        let per_segment = arguments(&plan, Inputs::PerPiece);
        let pipe = per_segment.iter().position(|a| a == "pipe:0").unwrap();
        assert_eq!(per_segment[pipe - 3..pipe], ["-f", "wav", "-i"]);
        assert_eq!(per_segment[pipe + 1], "-/filter_complex");
        let maps: Vec<&str> = per_segment
            .iter()
            .enumerate()
            .filter(|(_, argument)| *argument == "-map")
            .map(|(index, _)| per_segment[index + 1].as_str())
            .collect();
        assert_eq!(maps, ["[v]", "3:a"]);
        let single = arguments(&plan, Inputs::PerSource);
        assert!(single.windows(2).any(|pair| pair == ["-map", "1:a"]));
        assert_eq!(
            input_arguments(&plan, Inputs::PerSource),
            ["-ss", "5", "-i", SOURCE, "-f", "wav", "-i", "pipe:0"]
        );
    }

    #[test]
    fn an_export_of_one_process_opens_no_pipe() {
        let mut silence = fixture_plan(2);
        silence.sources[0].audio.as_mut().unwrap().silence_layout = Some("stereo".to_owned());
        for plan in [
            video_only_plan(2, Container::Mp4),
            audio_only_plan(2, Container::Mp4),
            silence,
        ] {
            assert!(!plan.separate_audio_process());
            for shape in [Inputs::PerPiece, Inputs::PerSource] {
                let all = arguments(&plan, shape);
                assert!(!all.iter().any(|a| a == "pipe:0"), "{all:?}");
                assert!(
                    !all.windows(2)
                        .any(|pair| pair[0] == "-map" && pair[1].ends_with(":a")),
                    "{all:?}"
                );
            }
        }
    }

    #[test]
    fn every_input_that_a_graph_reads_is_on_the_command_line_of_its_process() {
        // For both processes and both layouts of the inputs, the graph reads exactly the inputs of the source on
        // its command line. The pipe is the last input of the encoder, and only its map reads it.
        let input_count = |arguments: &[String]| arguments.iter().filter(|a| *a == "-i").count();
        let read = |graph: &str| -> std::collections::BTreeSet<usize> {
            graph
                .split('[')
                .filter_map(|label| label.split_once(':'))
                .filter_map(|(input, _)| input.parse().ok())
                .collect()
        };
        for count in 1..=3 {
            let plan = fixture_plan(count);
            for shape in [Inputs::PerPiece, Inputs::PerSource] {
                let graph = encoder_graph(&plan, shape);
                let encoder = build_arguments(&plan, shape, GRAPH, Path::new(OUTPUT));
                let sources = input_count(&encoder) - 1;
                assert_eq!(read(&graph), (0..sources).collect(), "{count} {shape:?}");
                assert!(encoder.contains(&format!("{sources}:a")), "{encoder:?}");

                let graph = build_audio_graph(&plan, shape);
                let audio = build_audio_arguments(&plan, shape, AUDIO_GRAPH);
                assert_eq!(read(&graph), (0..input_count(&audio)).collect());
                assert_eq!(input_count(&audio), sources, "{count} {shape:?}");
            }
        }
    }

    #[test]
    fn gives_every_segment_its_own_seeked_input_when_each_piece_has_one() {
        // Three inputs, three seeks, and the source path written three times -- the cost that
        // `MAX_EXPORT_INPUTS` bounds at a high segment count (ADR 055). One `-copyts` covers all
        // three inputs (ADR 014 measurement 18), so it appears once, ahead of the first.
        assert_eq!(
            arguments(&fixture_plan(3), Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-ss",
                "5",
                "-i",
                "/media/source.mp4",
                "-ss",
                "15",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "3:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_single_input_shape_opens_the_source_once_and_seeks_to_the_earliest_segment() {
        // The one seek is 5, from fixture element 1, and not 6.6, from element 0. Element 1
        // starts earlier in the source than element 0 while appearing after it in concat
        // order, so a builder that reused `segments[0].seek_seconds` would seek 1.6 s past
        // material element 1 still needs, and would export a truncated segment with no error
        // anywhere.
        assert_eq!(
            arguments(&fixture_plan(3), Inputs::PerSource),
            vec![
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
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    /// The fixture plan of three segments with an FLV input: a slice for each segment, in concat
    /// order, of a source of 212700000 bytes. Element 1 starts first, as in the fixture.
    fn flv_plan() -> ExportPlan {
        let mut plan = fixture_plan(3);
        plan.sources[0].path = PathBuf::from("/media/live.flv");
        plan.sources[0].flv_input = Some(FlvInput {
            head_name: head_name(0),
            source_size: 212_700_000,
            segment_offsets: vec![9_000_000, 4_000_000, 30_000_000],
            first_frame_offset: 13,
        });
        plan
    }

    #[test]
    fn an_flv_input_opens_each_slice_with_the_concat_protocol_and_no_seek() {
        // FFmpeg runs in the work directory, which holds the head, so each input names the head
        // by its file name. The slices start at the keyframes that the reader located, so no
        // input carries `-ss`, and `-copyts` keeps the timestamps that the `trim` boundaries use.
        assert_eq!(
            input_arguments(&flv_plan(), Inputs::PerPiece),
            vec![
                "-i",
                "concat:h0.flv|subfile,,start,9000000,end,212700000,,:/media/live.flv",
                "-i",
                "concat:h0.flv|subfile,,start,4000000,end,212700000,,:/media/live.flv",
                "-i",
                "concat:h0.flv|subfile,,start,30000000,end,212700000,,:/media/live.flv",
                "-f",
                "wav",
                "-i",
                "pipe:0",
            ]
        );
    }

    #[test]
    fn the_single_flv_input_starts_at_the_earliest_slice() {
        // Element 1 starts first in the source, so its slice holds every segment.
        assert_eq!(
            input_arguments(&flv_plan(), Inputs::PerSource),
            vec![
                "-i",
                "concat:h0.flv|subfile,,start,4000000,end,212700000,,:/media/live.flv",
                "-f",
                "wav",
                "-i",
                "pipe:0",
            ]
        );
    }

    #[test]
    fn the_audio_process_opens_the_same_flv_slices_as_the_encoder() {
        let plan = flv_plan();
        let inputs = |arguments: &[String]| -> Vec<String> {
            arguments
                .windows(2)
                .filter(|pair| pair[0] == "-i" && pair[1] != "pipe:0")
                .map(|pair| pair[1].clone())
                .collect()
        };
        for shape in [Inputs::PerPiece, Inputs::PerSource] {
            let audio = build_audio_arguments(&plan, shape, AUDIO_GRAPH);
            assert!(!audio.iter().any(|argument| argument == "-ss"), "{audio:?}");
            assert_eq!(
                inputs(&audio),
                inputs(&arguments(&plan, shape)),
                "{shape:?}"
            );
        }
    }

    #[test]
    fn a_plan_without_audio_maps_and_encodes_video_only() {
        // `build_filter_graph` writes no `[a]` label for such a plan, so a stray `-map "[a]"`
        // here would fail the export while ffmpeg resolves the map, and a stray `-c:a` would
        // name an encoder for a stream that does not exist.
        let mut plan = fixture_plan(1);
        plan.audio = None;
        plan.segments[0].audio_in_tick = None;
        plan.segments[0].audio_out_tick = None;
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_plan_without_video_maps_and_encodes_audio_only() {
        // An audio-only export plans no video. The rule for a plan without it mirrors the
        // rule above: `build_filter_graph` writes no `[v]` label for such a plan, so neither
        // `-map "[v]"` nor `-c:v` nor the quality flag may appear.
        let mut plan = fixture_plan(1);
        plan.video = None;
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    /// The fixture plan without its video part, as an audio-only export plans it.
    fn audio_only_plan(count: usize, container: Container) -> ExportPlan {
        let mut plan = fixture_plan(count);
        plan.video = None;
        plan.container = container;
        plan
    }

    /// The fixture plan without its audio part, as a video-only export plans it.
    fn video_only_plan(count: usize, container: Container) -> ExportPlan {
        let mut plan = fixture_plan(count);
        plan.audio = None;
        for segment in &mut plan.segments {
            segment.audio_in_tick = None;
            segment.audio_out_tick = None;
        }
        plan.container = container;
        plan
    }

    #[test]
    fn an_audio_only_mov_plan_writes_an_m4a_through_the_mp4_muxer() {
        // The one container whose muxer changes. The `mov` muxer refuses `flac` and `opus`
        // (ADR 023 measurement 2), and an audio file beside a MOV preset is an `.m4a`, which the
        // `mp4` muxer writes. `+faststart` stays, as for every MP4.
        let mut plan = audio_only_plan(2, Container::Mov);
        audio_mut(&mut plan).bitrate = Some(320);
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-ss",
                "5",
                "-i",
                "/media/source.mp4",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn an_audio_only_single_input_mkv_plan_writes_an_mka_through_the_matroska_muxer() {
        assert_eq!(
            arguments(&audio_only_plan(3, Container::Mkv), Inputs::PerSource),
            vec![
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
                "/media/source.mp4",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-f",
                "matroska",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_audio_only_muxer_follows_the_container_in_both_shapes() {
        // MP4 and MOV write an `.m4a` through `mp4`, with `+faststart`; MKV writes an `.mka`
        // through `matroska`, without it. No video flag of any kind reaches the line.
        for shape in [Inputs::PerPiece, Inputs::PerSource] {
            for (container, muxer, faststart) in [
                (Container::Mp4, "mp4", true),
                (Container::Mov, "mp4", true),
                (Container::Mkv, "matroska", false),
            ] {
                let emitted = arguments(&audio_only_plan(2, container), shape);
                let position = emitted
                    .iter()
                    .position(|argument| argument == "-f")
                    .expect("every command names a muxer");
                assert_eq!(emitted[position + 1], muxer, "{container:?} {shape:?}");
                assert_eq!(
                    emitted.iter().any(|argument| argument == "+faststart"),
                    faststart,
                    "{container:?} {shape:?}: {emitted:?}"
                );
                for flag in ["[v]", "-c:v", "-pix_fmt", "-crf", "-cq", "-b:v", "-q:v"] {
                    assert!(
                        !emitted.iter().any(|argument| argument == flag),
                        "{flag} in an audio-only command: {emitted:?}"
                    );
                }
                assert!(emitted.iter().any(|argument| argument == "[a]"));
                assert!(emitted.iter().any(|argument| argument == "-c:a"));
            }
        }
    }

    #[test]
    fn a_video_only_plan_keeps_the_container_muxer_and_names_no_audio_flag_in_both_shapes() {
        // The muxer of a video-only export is the muxer of every video export: `mov` stays
        // `mov`. The audio part is absent, so its map, its encoder and its bitrate are too.
        for shape in [Inputs::PerPiece, Inputs::PerSource] {
            for (container, muxer) in [
                (Container::Mp4, "mp4"),
                (Container::Mov, "mov"),
                (Container::Mkv, "matroska"),
            ] {
                let emitted = arguments(&video_only_plan(2, container), shape);
                let position = emitted
                    .iter()
                    .position(|argument| argument == "-f")
                    .expect("every command names a muxer");
                assert_eq!(emitted[position + 1], muxer, "{container:?} {shape:?}");
                for flag in ["[a]", "-c:a", "-b:a"] {
                    assert!(
                        !emitted.iter().any(|argument| argument == flag),
                        "{flag} in a video-only command: {emitted:?}"
                    );
                }
                assert!(emitted.iter().any(|argument| argument == "[v]"));
                assert!(emitted.iter().any(|argument| argument == "-c:v"));
            }
        }
        assert_eq!(
            arguments(&video_only_plan(2, Container::Mov), Inputs::PerSource),
            vec![
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
                "/media/source.mp4",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-movflags",
                "+faststart",
                "-f",
                "mov",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_segment_whose_seek_clamped_to_none_carries_no_ss_at_all() {
        // ADR 014 measurement 7: the trailing `-ss 0` idiom is a workaround for ffmpeg before
        // 2.1 and has no effect on any build a user can install today. The absence of the flag
        // is the spelling of a zero seek, so the second input group here opens with `-copyts`
        // and goes straight to `-i`.
        let mut plan = fixture_plan(2);
        plan.segments[1].seek_seconds = None;
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "2:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_mov_container_selects_the_mov_muxer_and_keeps_faststart() {
        let mut plan = fixture_plan(1);
        plan.container = Container::Mov;
        plan.destination = PathBuf::from("/export/out.mov");
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mov",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_mkv_container_selects_the_matroska_muxer_and_drops_faststart() {
        // `-f mkv` is not a muxer: `ffmpeg -h muxer=mkv` reports nothing, and the muxer is
        // named `matroska`. `+faststart` belongs to the mov/mp4 family only, so passing it to
        // the matroska muxer is an unknown option, not a no-op.
        let mut plan = fixture_plan(1);
        plan.container = Container::Mkv;
        plan.destination = PathBuf::from("/export/out.mkv");
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-f",
                "matroska",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_bitrate_preset_reaches_ffmpeg_in_kilobits() {
        // ADR 013 stores a bitrate in kilobits per second. Dropping the `k` would ask for 8000
        // bits per second, a thousand times too small -- and ffmpeg would encode that without
        // complaint.
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).encoder = "h264_nvenc".to_owned();
        video_mut(&mut plan).quality = Quality {
            kind: QualityKind::Bitrate,
            value: 8_000,
        };
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "h264_nvenc",
                "-pix_fmt",
                "yuv420p",
                "-b:v",
                "8000k",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_quality_scale_preset_uses_q_v_and_leaves_an_unset_audio_bitrate_off_the_line() {
        // `Quality` describes the video stream only, so `-q:v` never turns into an audio flag.
        // The fixture holds no audio bitrate, so the audio encoder runs at its own default and
        // no `-b:a` appears; `the_audio_bitrate_flag_appears_exactly_when_set_and_there_is_audio`
        // below covers the other half.
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).quality = Quality {
            kind: QualityKind::QualityScale,
            value: 3,
        };
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-q:v",
                "3",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn an_audio_bitrate_reaches_ffmpeg_in_kilobits_directly_after_the_audio_encoder() {
        // ADR 023's seed value. `-b:a` sits between `-c:a aac` and the muxer flags, and it
        // carries the `k` suffix for the reason `a_bitrate_preset_reaches_ffmpeg_in_kilobits`
        // gives for `-b:v`.
        let mut plan = fixture_plan(1);
        audio_mut(&mut plan).bitrate = Some(320);
        assert_eq!(
            arguments(&plan, Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_single_input_mkv_plan_with_a_bitrate_carries_b_a_after_c_a_and_no_faststart() {
        // The other shape and the container without `+faststart`, so the flag's position is
        // pinned against the end of the vector as well as against the `-c:a` in front of it.
        let mut plan = fixture_plan(3);
        plan.container = Container::Mkv;
        plan.destination = PathBuf::from("/export/out.mkv");
        // 510 kbps, not the settings maximum: libopus refuses more than 256 kbps for each
        // channel, and 510 kbps is valid for stereo.
        audio_mut(&mut plan).encoder = "libopus".to_owned();
        audio_mut(&mut plan).bitrate = Some(510);
        assert_eq!(
            arguments(&plan, Inputs::PerSource),
            vec![
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
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "libopus",
                "-b:a",
                "510k",
                "-f",
                "matroska",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn the_audio_bitrate_flag_appears_exactly_when_set_and_there_is_audio() {
        // Four cases, both shapes. With no bitrate the vector is the pre-ADR 023 one, byte for
        // byte. With no audio, the bitrate leaves with the audio part, and `-b:a` must not reach
        // the line either: it would name a bitrate for a stream the graph never writes, exactly
        // as a stray `-c:a` would.
        for shape in [Inputs::PerPiece, Inputs::PerSource] {
            for bitrate in [None, Some(MIN_AUDIO_BITRATE_KBPS), Some(320)] {
                for has_audio in [true, false] {
                    let mut plan = fixture_plan(2);
                    audio_mut(&mut plan).bitrate = bitrate;
                    if !has_audio {
                        plan.audio = None;
                        for segment in &mut plan.segments {
                            segment.audio_in_tick = None;
                            segment.audio_out_tick = None;
                        }
                    }
                    let emitted = arguments(&plan, shape);
                    let flags = emitted
                        .iter()
                        .filter(|argument| argument.as_str() == "-b:a")
                        .count();
                    let expected = match bitrate {
                        Some(_) if has_audio => 1,
                        _ => 0,
                    };
                    assert_eq!(
                        flags, expected,
                        "{bitrate:?}, audio {has_audio}: {emitted:?}"
                    );

                    if let (Some(bitrate), true) = (bitrate, has_audio) {
                        let encoder = emitted
                            .iter()
                            .position(|argument| argument == "-c:a")
                            .expect("a plan with audio names an audio encoder");
                        assert_eq!(emitted[encoder + 2], "-b:a", "{emitted:?}");
                        assert_eq!(emitted[encoder + 3], format!("{bitrate}k"), "{emitted:?}");
                    } else if has_audio {
                        // Removing the setting changes nothing else: the vector equals the one
                        // a plan with no bitrate at all produces.
                        let mut unset = plan.clone();
                        audio_mut(&mut unset).bitrate = None;
                        assert_eq!(emitted, arguments(&unset, shape));
                    } else {
                        // Without audio, nothing of the audio part reaches the line: no map, no
                        // encoder, and no bitrate, whatever bitrate the dropped part carried.
                        // The vector equals the one a plan that never held a bitrate produces.
                        for flag in ["[a]", "-c:a", "-b:a"] {
                            assert!(
                                !emitted.iter().any(|argument| argument == flag),
                                "{flag} with no audio: {emitted:?}"
                            );
                        }
                        let mut silent = fixture_plan(2);
                        silent.audio = None;
                        for segment in &mut silent.segments {
                            segment.audio_in_tick = None;
                            segment.audio_out_tick = None;
                        }
                        assert_eq!(emitted, arguments(&silent, shape));
                    }
                }
            }
        }
    }

    #[test]
    fn a_plan_whose_earliest_seek_clamped_opens_the_single_input_with_no_ss() {
        // `input_seek_seconds` returns `None` when the earliest segment by `in_pts`
        // clamped, and the one input group must then carry no `-ss` either.
        let mut plan = fixture_plan(3);
        plan.segments[1].seek_seconds = None;
        let arguments = arguments(&plan, Inputs::PerSource);
        assert_eq!(
            arguments,
            vec![
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-y",
                "-copyts",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn a_positive_seek_renders_as_an_exact_decimal_and_never_lands_later() {
        // Every case is an exact rational, rendered without floating point. The pair that
        // matters is the one that does not terminate: 2/3 must render 0.666666 and never
        // 0.666667, because rounding to nearest would place the seek *after* the requested
        // instant, and ADR 014 measurement 9 is about exactly that failure -- a seek that
        // lands late removes frames the output needs, and `trim` cannot recover them.
        //
        // The name says *positive* because the guarantee is one-sided. Truncation toward zero
        // renders -2/3 as -0.666666, which is later than the value asked for. `build_plan`
        // keeps a seek only when `raw_seek.num() > 0`, so no plan can carry a negative one; the
        // two cases below pin what the total function does with one, not a property to rely on.
        for (num, den, expected) in [
            (33_i64, 5_i64, Some("6.6")),
            (5, 1, Some("5")),
            (15, 1, Some("15")),
            (1, 3, Some("0.333333")),
            (2, 3, Some("0.666666")),
            // 1/12800 is 0.000078125 exactly: three digits past ffmpeg's own resolution.
            (1, 12_800, Some("0.000078")),
            (36_000, 1, Some("36000")),
            (-8, 1, Some("-8")),
            // Toward zero, which for a negative value is toward *later*. Unreachable from a
            // plan; see the comment above.
            (-2, 3, Some("-0.666666")),
            // Under one microsecond: no flag at all, never `-ss 0`.
            (1, 1_000_000_000, None),
            (-1, 1_000_000_000, None),
        ] {
            let seek = Rational::new(num, den).expect("the fixture rational is valid");
            assert_eq!(
                render_seek(seek).as_deref(),
                expected,
                "rendering {num}/{den}"
            );
        }
    }

    #[test]
    fn an_ntsc_plan_carries_the_exact_rational_frame_rate_and_a_truncated_seek() {
        // The real graph, not the sentinel: an NTSC rate reaches ffmpeg as 30000/1001 (ADR
        // 002), never as a rounded 29.97, and the whole graph goes into the graph file that the
        // command names (ADR 055). The seek is 1/3 s -- 160000/30000 - 5 -- which has no finite
        // decimal, so it renders truncated at ffmpeg's microsecond resolution and lands
        // marginally early.
        //
        // The `aformat=sample_rates=48000` at the head of the audio chain is `graph.rs`'s input
        // pin, and this test is the one place in this module that shows it. It exists because
        // of the `-ss` above: ADR 014 measurement 17 found that a seeked input reports the rate
        // the graph negotiates for its *output*, so without the pin `atrim` would read the
        // plan's source-rate ticks in the wrong unit. A 48000 Hz fixture cannot show the fault
        // -- the two rates agree -- so `graph.rs` owns that test; this one only pins the graph beside the command that
        // names its file.
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).timing = OutputTiming::ConstantFrameRate(
            Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
        );
        plan.sources[0].audio.as_mut().unwrap().sample_rate = 48_000;
        plan.segments[0] = segment(160_000, 190_030, 256_000, 304_048, Rational::new(1, 3));
        video_mut(&mut plan).expected_frames = Some(30);
        plan.total_duration = Rational::new(1_001, 1_000).expect("1.001 is a valid duration");

        assert_eq!(
            build_filter_graph(&plan, Inputs::PerPiece),
            concat!(
                "sws_flags=lanczos+accurate_rnd+full_chroma_int;[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=160000:end_pts=190030,setpts=PTS-STARTPTS,",
                "fps=30000/1001[v0];",
                "[0:2]aformat=r=48000,atrim=start_pts=256000:end_pts=304048,",
                "asetpts=PTS-256000,aresample=48000:first_pts=0,",
                "apad=whole_len=48048,asetpts=N,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_arguments(&plan, Inputs::PerPiece, GRAPH, Path::new(OUTPUT)),
            vec![
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
                "0.333333",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    fn option(name: &str, value: &str) -> PresetOption {
        PresetOption {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    /// The fixture plan with a 10-bit pixel format, the NVENC constant quality, and encoder
    /// options on both streams.
    fn plan_with_options(count: usize) -> ExportPlan {
        let mut plan = fixture_plan(count);
        let video = video_mut(&mut plan);
        video.encoder = "hevc_nvenc".to_owned();
        video.pixel_format = "p010le".to_owned();
        video.quality = Quality {
            kind: QualityKind::Cq,
            value: 25,
        };
        video.options = vec![
            option("preset", "p7"),
            option("rc", "vbr"),
            option("tag", "hvc1"),
        ];
        let audio = audio_mut(&mut plan);
        audio.bitrate = Some(320);
        audio.options = vec![option("aac_coder", "twoloop")];
        plan
    }

    #[test]
    fn writes_the_pixel_format_the_quality_and_the_options_of_each_stream_in_order() {
        // The order for each stream: the encoder, `-pix_fmt` for video, the managed quality or
        // bitrate flags, and then the options of the preset with the specifier of the stream.
        // `-b:v 0` belongs to the constant quality, so it follows `-cq` at once.
        assert_eq!(
            arguments(&plan_with_options(1), Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "hevc_nvenc",
                "-pix_fmt",
                "p010le",
                "-cq",
                "25",
                "-b:v",
                "0",
                "-preset:v",
                "p7",
                "-rc:v",
                "vbr",
                "-tag:v",
                "hvc1",
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-aac_coder:a",
                "twoloop",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
    }

    #[test]
    fn each_quality_kind_writes_its_own_flags_after_the_pixel_format() {
        for (kind, value, flags) in [
            (QualityKind::Crf, 20, vec!["-crf", "20"]),
            (QualityKind::Cq, 1, vec!["-cq", "1", "-b:v", "0"]),
            (QualityKind::Bitrate, 8_000, vec!["-b:v", "8000k"]),
            (QualityKind::QualityScale, 80, vec!["-q:v", "80"]),
        ] {
            let mut plan = fixture_plan(1);
            video_mut(&mut plan).quality = Quality { kind, value };
            let emitted = arguments(&plan, Inputs::PerPiece);
            let video = emitted
                .iter()
                .position(|argument| argument == "-c:v")
                .expect("the command names -c:v");
            assert_eq!(emitted[video + 2], "-pix_fmt", "{kind:?}");
            assert_eq!(
                emitted[video + 4..video + 4 + flags.len()],
                flags[..],
                "{kind:?}: {emitted:?}"
            );
            assert_eq!(emitted[video + 4 + flags.len()], "-c:a", "{kind:?}");
        }
    }

    #[test]
    fn an_export_without_a_stream_writes_none_of_its_options() {
        // The options of a stream leave with the stream, as its encoder and its flags do.
        let mut audio_only = plan_with_options(2);
        audio_only.video = None;
        let emitted = arguments(&audio_only, Inputs::PerPiece);
        for flag in ["-pix_fmt", "-cq", "-preset:v", "-rc:v", "-tag:v"] {
            assert!(
                !emitted.iter().any(|argument| argument == flag),
                "{flag}: {emitted:?}"
            );
        }
        assert!(emitted.iter().any(|argument| argument == "-aac_coder:a"));

        let mut video_only = plan_with_options(2);
        video_only.audio = None;
        for segment in &mut video_only.segments {
            segment.audio_in_tick = None;
            segment.audio_out_tick = None;
        }
        let emitted = arguments(&video_only, Inputs::PerSource);
        assert!(!emitted.iter().any(|argument| argument == "-aac_coder:a"));
        assert!(emitted.iter().any(|argument| argument == "-tag:v"));
    }

    #[test]
    fn an_option_value_reaches_ffmpeg_as_one_argument_verbatim() {
        // No shell reads the command, so quotes, spaces, colons, and a leading `-` stay inside
        // the one argument after the flag.
        let value = r#"aq-mode=3:psy-rd=0.8,0.0 "quoted" -1 $HOME"#;
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).options = vec![option("x264-params", value)];
        let emitted = arguments(&plan, Inputs::PerPiece);
        let flag = emitted
            .iter()
            .position(|argument| argument == "-x264-params:v")
            .expect("the option reaches the command");
        assert_eq!(emitted[flag + 1], value);
        assert_eq!(emitted[flag + 2], "-c:a");
    }

    #[test]
    fn the_settings_measure_of_the_options_is_the_bytes_of_their_arguments() {
        // `settings::validate_settings` bounds the options by `PresetOption::rendered_bytes`.
        // The bound means something only when it counts the arguments this module writes.
        let plan = plan_with_options(1);
        let emitted = arguments(&plan, Inputs::PerPiece);
        let video_options = &plan.video.as_ref().expect("the plan has video").options;
        let audio_options = &plan.audio.as_ref().expect("the plan has audio").options;
        let mut measured = 0;
        for (stream, options) in [
            (OptionStream::Video, video_options),
            (OptionStream::Audio, audio_options),
        ] {
            for option in options {
                let flag = option.flag(stream);
                let position = emitted
                    .iter()
                    .position(|argument| *argument == flag)
                    .expect("each option reaches the command");
                assert_eq!(emitted[position + 1], option.value);
                measured += emitted[position].len() + emitted[position + 1].len();
                assert_eq!(
                    option.rendered_bytes(stream),
                    emitted[position].len() + emitted[position + 1].len()
                );
            }
        }
        assert_eq!(
            measured,
            "-preset:vp7-rc:vvbr-tag:vhvc1-aac_coder:atwoloop".len()
        );
    }

    #[test]
    fn the_widest_options_are_at_both_limits_of_the_settings() {
        // `widest_plan` is only as wide as these lists: the most entries in each list, and
        // the most bytes both lists may render together. The settings must also accept them.
        let options = widest_options();
        assert_eq!(options.len(), MAX_PRESET_OPTIONS);
        let bytes: usize = [OptionStream::Video, OptionStream::Audio]
            .iter()
            .map(|stream| {
                options
                    .iter()
                    .map(|option| option.rendered_bytes(*stream))
                    .sum::<usize>()
            })
            .sum();
        assert_eq!(bytes, MAX_PRESET_OPTION_BYTES);

        let mut preset = crate::settings::defaults::default_presets().remove(0);
        preset.pixel_format = "a".repeat(MAX_PIXEL_FORMAT_CHARS);
        preset.video_options = options.clone();
        preset.audio_options = options;
        preset.quality = Quality {
            kind: QualityKind::Cq,
            value: MAX_CONSTANT_QUALITY,
        };
        let mut settings = crate::settings::defaults::seeded_settings();
        settings.presets = vec![preset];
        settings.active_preset_id = None;
        assert_eq!(crate::settings::validate_settings(&settings), Ok(()));
    }

    #[test]
    fn the_constant_quality_is_the_widest_quality_kind() {
        // `-cq 63 -b:v 0` is four arguments, against two for each other kind, so it is the
        // widest even beside `-b:v 200000k`. Each kind at the top of its range is measured.
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        let widest = widest_plan(MAX_EXPORT_SEGMENTS);
        for (kind, value) in [
            (QualityKind::Crf, 63),
            (QualityKind::Bitrate, 200_000),
            (QualityKind::QualityScale, 100),
        ] {
            let mut plan = widest_plan(MAX_EXPORT_SEGMENTS);
            video_mut(&mut plan).quality = Quality { kind, value };
            for shape in [Inputs::PerPiece, Inputs::PerSource] {
                assert!(
                    measured_length(&plan, &shape.of(&plan), &reservation)
                        < measured_length(&widest, &shape.of(&widest), &reservation),
                    "{kind:?} as {shape:?} is not narrower than the constant quality"
                );
            }
        }
    }

    /// Every plan and shape the guard tests below sweep: both shapes, every container, with and
    /// without audio, without video, every quality kind, an audio bitrate, a clamped seek, and a
    /// sub-microsecond seek.
    fn guard_matrix() -> Vec<(ExportPlan, Inputs)> {
        let mut cases: Vec<(ExportPlan, Inputs)> = Vec::new();
        for shape in [Inputs::PerPiece, Inputs::PerSource] {
            for count in [1, 3] {
                cases.push((fixture_plan(count), shape));
            }
            for container in [Container::Mp4, Container::Mov, Container::Mkv] {
                let mut plan = fixture_plan(2);
                plan.container = container;
                cases.push((plan, shape));
                cases.push((audio_only_plan(2, container), shape));
                cases.push((video_only_plan(2, container), shape));
            }
            for kind in [
                QualityKind::Crf,
                QualityKind::Cq,
                QualityKind::Bitrate,
                QualityKind::QualityScale,
            ] {
                let mut plan = fixture_plan(2);
                video_mut(&mut plan).quality = Quality { kind, value: 7 };
                cases.push((plan, shape));
            }
            cases.push((plan_with_options(2), shape));
            let mut with_audio_bitrate = fixture_plan(2);
            audio_mut(&mut with_audio_bitrate).bitrate = Some(320);
            cases.push((with_audio_bitrate, shape));

            let mut silent = fixture_plan(2);
            silent.audio = None;
            for segment in &mut silent.segments {
                segment.audio_in_tick = None;
                segment.audio_out_tick = None;
            }
            cases.push((silent, shape));

            let mut clamped = fixture_plan(3);
            clamped.segments[1].seek_seconds = None;
            cases.push((clamped, shape));

            let mut all_clamped = fixture_plan(2);
            for segment in &mut all_clamped.segments {
                segment.seek_seconds = None;
            }
            cases.push((all_clamped, shape));

            let mut sub_microsecond = fixture_plan(2);
            for segment in &mut sub_microsecond.segments {
                segment.seek_seconds = Rational::new(1, 1_000_000_000);
            }
            cases.push((sub_microsecond, shape));
        }
        cases
    }

    #[test]
    fn every_command_with_a_graph_names_one_graph_file_and_never_a_bare_ss_zero() {
        // Two rules that no single pinned vector can guarantee, so they are swept over the whole
        // matrix instead, for both options of the probe.
        //
        // ADR 055: each command that carries a graph names its file once, with the option that
        // the probe found, and never carries the graph inline. The process runs in the work
        // directory, so the name has no path. A copy command has no graph (ADR 048), and names no
        // file. `-ss 0` (ADR 014 measurement 7) is a workaround for ffmpeg before 2.1 with no
        // effect on any build a user can install.
        let is_graph_flag =
            |argument: &str| argument == "-/filter_complex" || argument == "-filter_complex_script";
        for option in [GraphFileOption::Slash, GraphFileOption::Script] {
            for (plan, shape) in guard_matrix() {
                let encoder = GraphFile {
                    option,
                    name: ENCODER_GRAPH_FILE,
                };
                let mut commands = vec![(
                    build_arguments(&plan, shape, encoder, Path::new(OUTPUT)),
                    ENCODER_GRAPH_FILE,
                )];
                if plan.separate_audio_process() {
                    let audio = GraphFile {
                        option,
                        name: AUDIO_GRAPH_FILE,
                    };
                    commands.push((build_audio_arguments(&plan, shape, audio), AUDIO_GRAPH_FILE));
                }
                for (arguments, name) in commands {
                    assert!(
                        !arguments
                            .iter()
                            .any(|argument| argument == "-filter_complex"),
                        "{arguments:?}"
                    );
                    let flags: Vec<usize> = arguments
                        .iter()
                        .enumerate()
                        .filter(|(_, argument)| is_graph_flag(argument))
                        .map(|(index, _)| index)
                        .collect();
                    assert_eq!(flags.len(), 1, "{arguments:?}");
                    assert_eq!(arguments[flags[0]], option.flag());
                    assert_eq!(arguments[flags[0] + 1], name);
                    assert!(!name.contains(['/', '\\']), "{name}");
                    for (index, argument) in arguments.iter().enumerate() {
                        if argument != "-ss" {
                            continue;
                        }
                        let value = &arguments[index + 1];
                        assert_ne!(value, "0", "{arguments:?}");
                        assert_ne!(
                            value.trim_start_matches('-').trim_matches('0'),
                            ".",
                            "{arguments:?}"
                        );
                    }
                }
            }
        }
        for container in [Container::Mp4, Container::Mov, Container::Mkv] {
            for copy in [
                copy_process(&copy_plan(container)),
                copy_to_file(&audio_only_copy_plan(container)),
            ] {
                assert!(
                    !copy
                        .iter()
                        .any(|argument| argument.contains("filter_complex")),
                    "{copy:?}"
                );
                assert!(
                    !copy.iter().any(|argument| argument.ends_with(".graph")),
                    "{copy:?}"
                );
            }
        }
    }

    #[test]
    fn every_command_carries_the_mandatory_overwrite_and_muxer_flags_and_writes_the_reservation() {
        // `-y` and `-f` are the two flags whose absence `output.rs` documents as export-losing:
        // without `-y`, ffmpeg refuses to touch the reserved file and still exits zero, so a
        // caller reading the exit status alone publishes zero bytes over the user's video;
        // without `-f`, the `.tmp-<pid>-<sequence>` suffix leaves ffmpeg no extension to infer
        // a muxer from. The last argument must be the reservation, and the destination must not
        // appear at all: ffmpeg never writes the published path.
        for (plan, shape) in guard_matrix() {
            let arguments = arguments(&plan, shape);
            assert!(arguments.iter().any(|argument| argument == "-y"));
            // The last `-f`: the one in front of a pipe of audio names its demuxer.
            let muxer = arguments
                .iter()
                .rposition(|argument| argument == "-f")
                .expect("every command names a muxer");
            assert!(matches!(
                arguments[muxer + 1].as_str(),
                "mp4" | "mov" | "matroska"
            ));
            assert_eq!(arguments.last().map(String::as_str), Some(OUTPUT));
            let destination = plan.destination.to_string_lossy().into_owned();
            assert!(!arguments.contains(&destination), "{arguments:?}");
        }
    }

    /// ADR 013's encoder-name rule, as `settings::validate_settings` enforces it: 1 to
    /// [`MAX_ENCODER_NAME_CHARS`] characters from `[0-9A-Za-z_.-]`, starting with an
    /// alphanumeric one.
    ///
    /// This is a local copy because `settings::is_valid_encoder_name` is private, and the
    /// assertions below pin it against known-good and known-bad names so it cannot rot into a
    /// check that accepts everything.
    fn is_encoder_name(value: &str) -> bool {
        let length = value.chars().count();
        (1..=MAX_ENCODER_NAME_CHARS).contains(&length)
            && value
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphanumeric())
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    }

    /// The fixture command with the two encoder names substituted, and nothing else touched.
    fn arguments_with_encoders(video: &str, audio: &str) -> (Vec<String>, Vec<String>) {
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).encoder = video.to_owned();
        audio_mut(&mut plan).encoder = audio.to_owned();
        let emitted = arguments(&plan, Inputs::PerPiece);

        let mut expected = arguments(&fixture_plan(1), Inputs::PerPiece);
        for (flag, name) in [("-c:v", video), ("-c:a", audio)] {
            let position = expected
                .iter()
                .position(|argument| argument == flag)
                .unwrap_or_else(|| panic!("the fixture command names {flag}"));
            expected[position + 1] = name.to_owned();
        }
        (emitted, expected)
    }

    #[test]
    fn an_encoder_name_reaches_ffmpeg_verbatim_and_moves_nothing_else() {
        // Each name occupies its own argument, immediately after its own flag, byte for byte as
        // the plan carries it. Nothing is quoted, escaped, joined to the flag, or reordered, so
        // whatever ffmpeg makes of a name is decided by the name alone.
        for (video, audio) in [
            ("libx264", "aac"),
            ("libx265", "libopus"),
            ("h264_nvenc", "libvorbis"),
            ("hevc_videotoolbox", "ac3"),
            ("libsvtav1", "libmp3lame"),
            (&"a".repeat(MAX_ENCODER_NAME_CHARS), "a"),
        ] {
            let (emitted, expected) = arguments_with_encoders(video, audio);
            assert_eq!(emitted, expected, "{video} and {audio}");
        }
    }

    #[test]
    fn a_flag_shaped_encoder_name_is_stopped_by_settings_validation_and_not_by_this_module() {
        // Where the guarantee actually lives. This module quotes nothing and checks nothing: a
        // name that could be read as an option is refused before it can be stored, by ADR 013's
        // character rule in `settings::validate_settings` -- 1 to MAX_ENCODER_NAME_CHARS
        // characters from `[0-9A-Za-z_.-]`, the first of them alphanumeric, which no option can
        // satisfy because every option starts with `-`.
        for hostile in [
            "-i",
            "-c:v libx264",
            "",
            &"a".repeat(MAX_ENCODER_NAME_CHARS + 1),
        ] {
            assert!(!is_encoder_name(hostile), "{hostile}");
        }
        for accepted in ["libx264", "aac", "h264_nvenc", "libsvtav1", "hevc.qsv"] {
            assert!(is_encoder_name(accepted), "{accepted}");
        }

        // And what the vector does if one ever got through anyway: the name stays in its value
        // position and displaces nothing, so the command reads
        // `-c:v -i -pix_fmt yuv420p -crf 20 -c:a ...`.
        // ffmpeg fails loudly on it -- measured as `Unknown encoder '-i'`, exit 8, no output
        // written -- rather than consuming it as an input option, which is the outcome that
        // makes a missing escape here recoverable instead of silent.
        let (emitted, expected) = arguments_with_encoders("-i", "-f");
        assert_eq!(emitted, expected);
        let video = emitted
            .iter()
            .position(|argument| argument == "-c:v")
            .expect("the command names -c:v");
        assert_eq!(emitted[video + 1], "-i");
        assert_eq!(emitted[video + 2], "-pix_fmt");
        assert_eq!(emitted[video + 4], "-crf");
        assert_eq!(emitted[video + 5], "20");
    }

    /// A long, realistic Windows source path: a dated capture folder under a user profile.
    ///
    /// 106 characters. Nothing here is unusual for a person who keeps recordings by event --
    /// a full account name, a spaced folder name, and a descriptive file name -- and a Windows
    /// path may be four times longer still (260 characters without the extended-length
    /// prefix), so this is a long path, not the longest one.
    const WINDOWS_SOURCE: &str = concat!(
        r"C:\Users\alexandra.whitfield\Videos\Captures\2026-08-31 Grand Final",
        r"\grand-final-full-broadcast-2160p60.mkv",
    );

    /// The reserved output path beside a destination in the same profile, in
    /// `PendingOutput::reserve`'s naming.
    const WINDOWS_OUTPUT: &str = concat!(
        r"C:\Users\alexandra.whitfield\Videos\Exports",
        r"\.grand-final-highlights.mp4.tmp-13724-0",
    );

    /// A plan sized to the widest realistic command line, over `count` segments.
    ///
    /// Every dimension that costs command-line bytes is set near its realistic maximum, because
    /// the budget question is about byte length and nothing else:
    ///
    /// - Ten-digit PTS values and ten-digit audio ticks, as a multi-hour source at a 1/90000
    ///   MPEG-TS time base with high-rate audio produces.
    /// - An NTSC frame rate, which spells `fps=30000/1001` rather than `fps=25/1`.
    /// - An explicit 4K resolution, which adds `scale=3840:2160,setsar=1` to every video chain.
    /// - A twelve-character seek, from a rational with no finite decimal.
    /// - A seventeen-character encoder name, the longest among the shipped presets' candidates.
    /// - The long Windows paths above, and MP4, whose `-movflags +faststart` is the only
    ///   container-dependent argument.
    fn windows_plan(count: usize) -> ExportPlan {
        let segments = (0..count)
            .map(|index| {
                let index = i64::try_from(index).expect("the segment count fits in an i64");
                let in_pts = 1_000_000_000 + index * 5_000_000;
                let in_tick = 5_000_000_000 + index * 26_666_666;
                PlannedSegment {
                    source: 0,
                    in_pts: Pts::new(in_pts),
                    out_pts: Pts::new(in_pts + 900_900),
                    // 100000/3 = 33333.333333..., so the seek renders at the full width
                    // `SEEK_DECIMALS` allows.
                    seek_seconds: Rational::new(100_000 + index, 3),
                    audio_in_tick: Some(in_tick),
                    audio_out_tick: Some(in_tick + 4_804_800),
                    // 900900 ticks of 1/90000 s at 30000/1001 frames per second.
                    frames: Some(300),
                    audio_prefix: None,
                }
            })
            .collect();
        let mut source = source_at(WINDOWS_SOURCE, 1, 2, 48_000);
        source.fit = Some(VideoFit {
            width: 3840,
            height: 2160,
            x: 0,
            y: 0,
        });
        ExportPlan {
            sources: vec![source],
            destination: PathBuf::from(
                r"C:\Users\alexandra.whitfield\Videos\Exports\grand-final-highlights.mp4",
            ),
            video: Some(PlannedVideo {
                timing: OutputTiming::ConstantFrameRate(
                    Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
                ),
                canvas: Some(Resolution { w: 3840, h: 2160 }),
                encoder: "hevc_videotoolbox".to_owned(),
                quality: Quality {
                    kind: QualityKind::Crf,
                    value: 20,
                },
                pixel_format: "yuv420p".to_owned(),
                options: vec![],
                expected_frames: Some(30 * u64::try_from(count).expect("the count fits in a u64")),
            }),
            audio: Some(legacy_audio()),
            segments,
            container: Container::Mp4,
            total_duration: Rational::new(
                901 * i64::try_from(count).expect("the segment count fits in an i64"),
                30_000,
            )
            .expect("the fixture duration is representable"),
            copied_audio: None,
            audio_copy_refusal: None,
        }
    }

    /// The graph file that the budget tests measure the command of the encoder with: the longer of
    /// the two options of ADR 055, `-filter_complex_script`, so a command that fits with it fits
    /// with either.
    const MEASURED_ENCODER_GRAPH: GraphFile<'static> = GraphFile {
        option: GraphFileOption::Script,
        name: ENCODER_GRAPH_FILE,
    };

    /// The graph file of the audio process, as for [`MEASURED_ENCODER_GRAPH`].
    const MEASURED_AUDIO_GRAPH: GraphFile<'static> = GraphFile {
        option: GraphFileOption::Script,
        name: AUDIO_GRAPH_FILE,
    };

    /// The length of the command line of the encoder of `plan` with `inputs`, for `output`.
    fn measured_length(plan: &ExportPlan, inputs: &InputAssignment, output: &str) -> usize {
        command_line_length(&super::build_arguments(
            plan,
            inputs,
            MEASURED_ENCODER_GRAPH,
            Path::new(output),
        ))
    }

    /// The length of the command of the audio process of `plan` with `inputs`.
    fn measured_audio_length(plan: &ExportPlan, inputs: &InputAssignment) -> usize {
        command_line_length(&super::build_audio_arguments(
            plan,
            inputs,
            MEASURED_AUDIO_GRAPH,
        ))
    }

    /// The video time base of every fixture of the budget tests: 1/90000, as in MPEG-TS.
    fn fixture_time_base() -> Rational {
        Rational::new(1, 90_000).unwrap()
    }

    /// The inputs that production chooses for `plan` ([`assign_inputs`]), each source at
    /// [`fixture_time_base`].
    fn production_inputs(plan: &ExportPlan) -> InputAssignment {
        let pieces: Vec<SegmentBoundary> = plan
            .segments
            .iter()
            .map(|segment| SegmentBoundary {
                source: segment.source,
                in_pts: segment.in_pts,
                out_pts: segment.out_pts,
            })
            .collect();
        let time_bases = vec![fixture_time_base(); plan.sources.len()];
        assign_inputs(&pieces, &time_bases).expect("the fixture pieces fit the runs")
    }

    #[test]
    fn a_full_length_plan_on_a_long_windows_path_fits_the_windows_command_line() {
        // A realistic plan at the limit of one source: a 106-character path, ordinary encoder
        // names, no encoder options, and a 4K fit step in every chain. Its pieces are in source
        // order, about 45 s apart, so production reads them through runs cut at their gaps, up to
        // `MAX_EXPORT_INPUTS` inputs (ADR 055). The widest commands are measured below.
        let plan = windows_plan(MAX_EXPORT_SEGMENTS);
        let inputs = production_inputs(&plan);
        assert_eq!(inputs.inputs().len(), MAX_EXPORT_INPUTS);
        let length = measured_length(&plan, &inputs, WINDOWS_OUTPUT);
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "{MAX_EXPORT_SEGMENTS} segments need {length} bytes, over the \
             {WINDOWS_COMMAND_LINE_BUDGET}-byte budget of Windows' {WINDOWS_COMMAND_LINE_LIMIT}"
        );
        // The audio process opens the inputs of the pieces whose chains read audio, and has a
        // graph file of its own, so its command meets the same budget on its own (ADR 043).
        assert!(plan.separate_audio_process());
        let length = measured_audio_length(&plan, &inputs);
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "the audio process at {MAX_EXPORT_SEGMENTS} segments needs {length} bytes"
        );
    }

    /// The longest path Windows accepts without the extended-length prefix, counting the
    /// terminating NUL that `MAX_PATH` includes and this string does not.
    const WINDOWS_MAX_PATH_CHARS: usize = 260;

    /// A path of exactly `WINDOWS_MAX_PATH_CHARS - 1` characters, ending in `suffix`.
    fn longest_windows_path(suffix: &str) -> String {
        let head = r"C:\Users\alexandra.whitfield\Videos\Captures\";
        let fill = WINDOWS_MAX_PATH_CHARS - 1 - head.len() - suffix.len();
        format!("{head}{}{suffix}", "a".repeat(fill))
    }

    /// The longest channel layout name the closing `aformat` can carry: `7.1(wide-side)`, the
    /// longest name of FFmpeg's table of named layouts.
    ///
    /// With the preset value `source` and sources of different layouts, the closing `aformat`
    /// names the layout of the source with the most channels (ADR 053). The plan takes that name
    /// from ffprobe only when it is plain (`plan::is_plain_layout_name`), and ffprobe writes a
    /// plain name only for a layout of that table. Every other layout reads as `6 channels (...)`
    /// or similar, which holds spaces, and the plan then names the default layout of the count,
    /// such as `6c`.
    const WIDEST_CHANNEL_LAYOUT: &str = "7.1(wide-side)";

    /// The audio stream and output format that spell the longest audio chains: a two-digit
    /// stream index, and 192000 Hz both in the input pin and in the closing `aformat`, with the
    /// layout [`WIDEST_CHANNEL_LAYOUT`]. The gain is [`MIN_AUDIO_GAIN_TENTHS_DB`], whose text
    /// `-20.0` is the longest a gain spells (ADR 054).
    ///
    /// 192000 is the top of ADR 023's fixed range, and it is one digit longer than 48000.
    /// [`WIDEST_CHANNEL_LAYOUT`], which the preset value `source` names for sources of different
    /// layouts (ADR 053), is the longest layout choice: `stereo` is eight bytes shorter, `mono`
    /// ten, and `source` for sources of one layout drops the whole `:cl=` option.
    /// `the_widest_audio_format_is_the_one_the_widest_plan_carries_and_it_fits_at_the_cap`
    /// checks the choice.
    ///
    /// This bound assumes a probed rate of at most six digits, and no code enforces it: the
    /// probe accepts any rate above 0. The gap fill of each chain writes the stream's own rate
    /// for every output choice, and a `source` output rate writes it in the closing `aformat`
    /// too, so each digit past six adds one byte for each segment, two with `source`, and one
    /// for the pin. A probed rate longer than six digits is therefore outside the measured
    /// budget. The consequence is not a wrong output: at the segment cap on Windows, the command
    /// line can exceed the limit, and the spawn then fails and reports `ffmpegSpawnFailed`. A
    /// silence prefix writes the rate three more times, but the plan gives none to a stream
    /// faster than 192000 Hz, so the prefixes add nothing past six digits.
    fn widest_audio() -> PlannedAudio {
        PlannedAudio {
            output_sample_rate: MAX_AUDIO_SAMPLE_RATE,
            output_channels: AudioChannels::Source,
            output_layout: Some(WIDEST_CHANNEL_LAYOUT.to_owned()),
            absent_layout: WIDEST_CHANNEL_LAYOUT.to_owned(),
            encoder: "a".repeat(MAX_ENCODER_NAME_CHARS),
            bitrate: Some(MAX_AUDIO_BITRATE_KBPS),
            options: widest_options(),
            gain_tenths_db: MIN_AUDIO_GAIN_TENTHS_DB,
            // The command does not read it; any value renders the same command.
            expected_duration: Rational::new(1, 1).unwrap(),
        }
    }

    /// The source that spells the widest inputs and chains: a path of `MAX_PATH`, two-digit stream
    /// indices, an audio stream at [`MAX_AUDIO_SAMPLE_RATE`], and a fit step whose numbers have the
    /// digits of [`MAX_RESOLUTION_DIMENSION`] on every side and offset.
    fn widest_source(suffix: &str) -> PlannedSource {
        let mut source = source_at(&longest_windows_path(suffix), 10, 11, MAX_AUDIO_SAMPLE_RATE);
        source.fit = Some(VideoFit {
            width: MAX_RESOLUTION_DIMENSION,
            height: MAX_RESOLUTION_DIMENSION,
            x: MAX_RESOLUTION_DIMENSION,
            y: MAX_RESOLUTION_DIMENSION,
        });
        source
    }

    /// The option list that, on both streams, spells the longest options the settings permit: [`MAX_PRESET_OPTIONS`] entries of 16 bytes each,
    /// so the two lists render exactly [`MAX_PRESET_OPTION_BYTES`].
    ///
    /// The count is at its maximum because each option costs two arguments, and each argument
    /// costs [`ARGUMENT_OVERHEAD_BYTES`] beyond its content. For a fixed number of rendered
    /// bytes, more options spell a longer command line.
    /// `the_widest_options_are_at_both_limits_of_the_settings` checks both limits.
    fn widest_options() -> Vec<PresetOption> {
        (0..MAX_PRESET_OPTIONS)
            .map(|index| PresetOption {
                name: format!("opt{index:02}"),
                value: "v".repeat(8),
            })
            .collect()
    }

    /// The widest plan the settings schema permits, over `count` segments.
    ///
    /// Every dimension is at the maximum `settings::validate_settings` accepts, or at the
    /// widest a real source can make it, so this measures the bound rather than a fixture:
    /// `MAX_PATH` for the source *and* the reservation, [`MAX_ENCODER_NAME_CHARS`] for both
    /// encoder names, `MAX_RESOLUTION_DIMENSION` on both axes, the longest quality arguments
    /// (`-cq 63 -b:v 0`, four arguments; see `the_constant_quality_is_the_widest_quality_kind`),
    /// [`MAX_PIXEL_FORMAT_CHARS`] for the pixel format, which the first chain of the graph and
    /// `-pix_fmt` both carry, the widest option lists [`widest_options`] names, MP4 for its extra
    /// `-movflags +faststart`, an NTSC rate, two-digit stream indices, the widest audio format
    /// [`widest_audio`] names, the longest audio bitrate (`-b:a 1536k`, the top of ADR 023's
    /// range), eleven-digit PTS values, twelve-digit audio ticks, nine-digit frame counts for the
    /// stand-in video of the audio process, and a seek that fills every decimal place
    /// [`SEEK_DECIMALS`] allows.
    ///
    /// Every segment ends at the largest twelve-digit tick, so every length carries twelve digits
    /// too: the stand-in silence of the encoder (`graph::stand_in_audio_chain`) and the end of each
    /// chain of the audio process (`graph::audio_exact_end`) write it for each segment, the latter
    /// twice. A length is longer than its Out tick only when the In tick is negative. A negative In
    /// tick of fewer than about 10^10 ticks shortens `start_pts` and the reset by at least as many
    /// bytes as it adds to the lengths. Between 10^10 and 10^11, a chain of the audio process can
    /// grow by one byte, about 100 bytes at the cap, which the slack of the widest plan covers.
    fn widest_plan(count: usize) -> ExportPlan {
        let segments = (0..count)
            .map(|index| {
                let index = i64::try_from(index).expect("the segment count fits in an i64");
                let in_pts = 10_000_000_000 + index * 100_000_000;
                let in_tick = 100_000_000_000 + index * 1_000_000_000;
                PlannedSegment {
                    source: 0,
                    in_pts: Pts::new(in_pts),
                    out_pts: Pts::new(in_pts + 900_900),
                    seek_seconds: Rational::new(100_000 + index, 3),
                    audio_in_tick: Some(in_tick),
                    audio_out_tick: Some(WIDEST_AUDIO_TICK),
                    frames: Some(WIDEST_FRAME_COUNT),
                    // The last segments, as many as may have one, carry a prefix of twelve digits:
                    // their indices have two digits, and each prefixed chain writes its index four
                    // times. The audio after the prefix starts 12000 ticks before the Out point, so
                    // the In tick plus the prefix keeps twelve digits, as in a real plan.
                    audio_prefix: (usize::try_from(index).expect("the index fits")
                        + MAX_AUDIO_PREFIXES
                        >= count)
                        .then_some(WIDEST_AUDIO_TICK - 12_000 - in_tick),
                }
            })
            .collect();
        ExportPlan {
            sources: vec![widest_source(".mkv")],
            destination: PathBuf::from(longest_windows_path(".mp4")),
            video: Some(PlannedVideo {
                timing: OutputTiming::ConstantFrameRate(
                    Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
                ),
                canvas: Some(Resolution {
                    w: MAX_RESOLUTION_DIMENSION,
                    h: MAX_RESOLUTION_DIMENSION,
                }),
                encoder: "a".repeat(MAX_ENCODER_NAME_CHARS),
                quality: Quality {
                    kind: QualityKind::Cq,
                    value: MAX_CONSTANT_QUALITY,
                },
                pixel_format: "a".repeat(MAX_PIXEL_FORMAT_CHARS),
                options: widest_options(),
                expected_frames: Some(30 * u64::try_from(count).expect("the count fits in a u64")),
            }),
            audio: Some(widest_audio()),
            segments,
            container: Container::Mp4,
            total_duration: Rational::new(
                901 * i64::try_from(count).expect("the segment count fits in an i64"),
                30_000,
            )
            .expect("the fixture duration is representable"),
            copied_audio: None,
            audio_copy_refusal: None,
        }
    }

    /// [`widest_plan`] with its pieces spread over `sources` sources in turn, piece `i` from
    /// source `i % sources`, each source at a path of `MAX_PATH` ([`widest_source`]). With as many
    /// sources as pieces, every piece opens an input of its own.
    fn widest_plan_of_sources(count: usize, sources: usize) -> ExportPlan {
        let sources = sources.clamp(1, count);
        let mut plan = widest_plan(count);
        plan.sources = (0..sources)
            .map(|index| widest_source(&format!("-{index:03}.mkv")))
            .collect();
        for (index, segment) in plan.segments.iter_mut().enumerate() {
            segment.source = index % sources;
        }
        plan
    }

    /// The second layout of [`silenced`]: `5.1.2(back)`, the longest name of FFmpeg's table of
    /// eight channels after [`WIDEST_CHANNEL_LAYOUT`]. Its count ties with the widest layout, so
    /// the earlier source keeps the name of the closing `aformat`, and the silence of its own
    /// source is as long as a second name can be.
    const SECOND_CHANNEL_LAYOUT: &str = "5.1.2(back)";

    /// `plan` with no piece that reads an audio stream, so the export is one process whose graph
    /// generates the silence of every piece: the first source has a stream without packets in the
    /// layout [`WIDEST_CHANNEL_LAYOUT`], the second one in [`SECOND_CHANNEL_LAYOUT`], and every
    /// other source has no audio stream. The layouts differ, so every closing `aformat` names
    /// [`WIDEST_CHANNEL_LAYOUT`], and every silence of a source without audio is generated in it at
    /// the output rate, with a length of twelve digits.
    fn silenced(mut plan: ExportPlan) -> ExportPlan {
        for (index, source) in plan.sources.iter_mut().enumerate() {
            source.audio = match index {
                0 => Some(SourceAudio {
                    stream_index: 11,
                    sample_rate: MAX_AUDIO_SAMPLE_RATE,
                    silence_layout: Some(WIDEST_CHANNEL_LAYOUT.to_owned()),
                }),
                1 => Some(SourceAudio {
                    stream_index: 11,
                    sample_rate: MAX_AUDIO_SAMPLE_RATE,
                    silence_layout: Some(SECOND_CHANNEL_LAYOUT.to_owned()),
                }),
                _ => None,
            };
        }
        for segment in &mut plan.segments {
            segment.audio_prefix = None;
            if segment.source >= 2 {
                segment.audio_in_tick = Some(0);
            }
        }
        plan
    }

    /// [`widest_plan`] of `count` pieces of `sources` sources in which the first source holds the
    /// first `first_pieces` pieces, the second source the next one, and the other sources the
    /// rest in turn, or the second source all of them when there are two, and the one source all
    /// of them when there is one. Every source holds a
    /// piece, so `count` is at least `first_pieces + sources - 1`. Skewed toward the first source,
    /// with an FLV input on every source or on none, this covers how the inputs fall among the
    /// sources.
    fn skewed_plan(count: usize, sources: usize, first_pieces: usize) -> ExportPlan {
        assert!(count >= first_pieces + sources - 1);
        let mut plan = widest_plan(count);
        plan.sources = (0..sources)
            .map(|index| widest_source(&format!("-{index:03}.mkv")))
            .collect();
        for (index, segment) in plan.segments.iter_mut().enumerate() {
            segment.source = if index < first_pieces || sources == 1 {
                0
            } else if index == first_pieces || sources == 2 {
                1
            } else {
                2 + (index - first_pieces - 1) % (sources - 2)
            };
        }
        plan
    }

    /// Every plan the budget sweep measures for `sources` sources at `count` pieces, with a name
    /// for a report. The shapes are the round robin of [`widest_plan_of_sources`] and, with two
    /// sources or more, every skew of [`skewed_plan`] toward the first source, with one piece for
    /// each other source or all `count` pieces. Each shape comes with every piece reading audio
    /// and [`silenced`], with video and [`without_video`], and with and without an FLV input on
    /// every source (ADR 055).
    fn budget_sweep(count: usize, sources: usize) -> Vec<(String, ExportPlan)> {
        let mut shapes = vec![(
            format!("{sources} sources in turn"),
            widest_plan_of_sources(count, sources),
        )];
        if sources > 1 {
            for first_pieces in 1..=count - sources + 1 {
                // The other sources hold one piece each, or share every piece that is left.
                for total in [first_pieces + sources - 1, count] {
                    shapes.push((
                        format!("{sources} sources, {first_pieces} of {total} pieces in the first"),
                        skewed_plan(total, sources, first_pieces),
                    ));
                }
            }
        }
        let mut plans = Vec::new();
        for (name, plan) in shapes {
            for silent in [false, true] {
                for video in [true, false] {
                    let mut plan = if silent {
                        silenced(plan.clone())
                    } else {
                        plan.clone()
                    };
                    if !video {
                        plan = without_video(plan);
                    }
                    let name = format!(
                        "{name}{}{}",
                        if silent { ", silent" } else { "" },
                        if video { "" } else { ", no video" }
                    );
                    plans.push((name.clone(), plan.clone()));
                    plans.push((format!("{name}, FLV"), with_flv_inputs_everywhere(plan)));
                }
            }
        }
        plans
    }

    /// The most sources of one export: each source holds a piece, and [`max_export_pieces`] lowers
    /// the limit by one for each source.
    fn max_export_sources() -> usize {
        (1..)
            .take_while(|sources| max_export_pieces(*sources) >= *sources)
            .last()
            .expect("one source holds a piece")
    }

    /// The length of the command of the encoder of `plan` and of its audio process, with the
    /// inputs production chooses. The audio process is `None` for an export of one process.
    fn chosen_lengths(plan: &ExportPlan, reservation: &str) -> (usize, Option<usize>) {
        let inputs = production_inputs(plan);
        assert!(inputs.inputs().len() <= MAX_EXPORT_INPUTS);
        let encoder = measured_length(plan, &inputs, reservation);
        let audio = plan
            .separate_audio_process()
            .then(|| measured_audio_length(plan, &inputs));
        (encoder, audio)
    }

    /// Whether every command of `plan` fits the Windows budget with the inputs production chooses.
    fn fits_windows(plan: &ExportPlan, reservation: &str) -> bool {
        let (encoder, audio) = chosen_lengths(plan, reservation);
        encoder <= WINDOWS_COMMAND_LINE_BUDGET
            && audio.is_none_or(|length| length <= WINDOWS_COMMAND_LINE_BUDGET)
    }

    /// The FLV input of a source of `count` pieces whose numbers have the digits of `size`: a
    /// slice for each piece, each from an offset just below `size`. The head has the name of a
    /// source with a two-digit index, wider than the index of any source that an export can hold.
    fn widest_flv_input(count: usize, size: u64) -> FlvInput {
        let count = u64::try_from(count).expect("the count fits in a u64");
        FlvInput {
            head_name: head_name(99),
            source_size: size,
            segment_offsets: (0..count).map(|index| size - 1 - index).collect(),
            first_frame_offset: 13,
        }
    }

    /// `plan` with the FLV input of [`widest_flv_input`] on its first source.
    fn with_flv_input(mut plan: ExportPlan, size: u64) -> ExportPlan {
        let count = plan
            .segments
            .iter()
            .filter(|segment| segment.source == 0)
            .count();
        plan.sources[0].flv_input = Some(widest_flv_input(count, size));
        plan
    }

    /// `plan` with the FLV input of [`widest_flv_input`] on every source, at the largest size a
    /// file can have: each FLV source of an export gets its own head (ADR 055).
    fn with_flv_inputs_everywhere(mut plan: ExportPlan) -> ExportPlan {
        for index in 0..plan.sources.len() {
            let count = plan
                .segments
                .iter()
                .filter(|segment| segment.source == index)
                .count();
            plan.sources[index].flv_input = Some(widest_flv_input(count, u64::MAX));
        }
        plan
    }

    #[test]
    fn the_widest_plan_with_an_flv_input_still_fits_at_the_segment_cap() {
        // Every source of the plan has an FLV input, and each command of the plan, with the
        // inputs production chooses, still fits at the limit of its count of sources, with the
        // largest numbers a file can have. A long path of the application data does not count:
        // each command names its heads by their file names.
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        for sources in [1, 2, 7, max_export_sources()] {
            let plan = with_flv_inputs_everywhere(widest_plan_of_sources(
                max_export_pieces(sources),
                sources,
            ));
            assert!(fits_windows(&plan, &reservation), "{sources} sources");
        }
    }

    /// The largest audio tick of twelve digits, which [`widest_plan`] assumes as the widest.
    const WIDEST_AUDIO_TICK: i64 = 999_999_999_999;

    /// The largest frame count of nine digits, which [`widest_plan`] gives every segment for the
    /// stand-in video of the audio process (`graph::stand_in_video_chain`).
    ///
    /// Nine digits cover more than 96 days of one segment at 120 frames per second. The PTS of
    /// [`widest_plan`] have eleven digits at a time base of 1/90000, about 12.9 days.
    const WIDEST_FRAME_COUNT: u64 = 999_999_999;

    /// The widest plan of an export without video, over `count` segments: [`widest_plan`]
    /// without its video part.
    ///
    /// Every audio chain of a graph without video ends in the end pad (`graph::audio_end_pad`),
    /// so every segment here ends at [`WIDEST_AUDIO_TICK`], and every pad carries a twelve-digit
    /// length.
    fn widest_audio_only_plan(count: usize) -> ExportPlan {
        without_video(widest_plan(count))
    }

    /// `plan` without its video part, every segment ending at [`WIDEST_AUDIO_TICK`].
    fn without_video(mut plan: ExportPlan) -> ExportPlan {
        plan.video = None;
        for segment in &mut plan.segments {
            segment.audio_out_tick = Some(WIDEST_AUDIO_TICK);
        }
        plan
    }

    /// The widest plan of `count` inputs: [`widest_plan`] of `count` pieces, each of its own source
    /// at a path of `MAX_PATH`, and each source an FLV input with the widest numbers
    /// ([`with_flv_inputs_everywhere`]). Each piece is one input, so the assignment is one input for
    /// each piece.
    ///
    /// An FLV input is the widest input that the code writes. A seeked input writes `-ss`, a seek
    /// of at most fourteen characters for a source shorter than 12.9 days, `-i` and the path. An
    /// FLV input writes `-i` and the path with the head, two numbers of twenty digits, and the
    /// separators of the concat protocol around them, about 60 bytes more.
    fn widest_inputs_plan(count: usize) -> ExportPlan {
        with_flv_inputs_everywhere(widest_plan_of_sources(count, count))
    }

    /// The longest command of the encoder and of the audio process of an export of `count` inputs,
    /// over every kind of plan of [`widest_inputs_plan`]: with the audio in its own process, with
    /// every piece generating silence ([`silenced`]), and without video ([`without_video`]).
    fn widest_lengths(count: usize) -> (usize, usize) {
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        let plan = widest_inputs_plan(count);
        let mut encoder = 0;
        let mut audio = 0;
        for plan in [
            plan.clone(),
            silenced(plan.clone()),
            without_video(plan.clone()),
            without_video(silenced(plan)),
        ] {
            let sources: Vec<usize> = plan.segments.iter().map(|segment| segment.source).collect();
            let inputs = InputAssignment::one_per_piece(&sources);
            assert_eq!(inputs.inputs().len(), count);
            encoder = encoder.max(measured_length(&plan, &inputs, &reservation));
            if plan.separate_audio_process() {
                audio = audio.max(measured_audio_length(&plan, &inputs));
            }
        }
        (encoder, audio)
    }

    #[test]
    fn max_export_inputs_fit_the_windows_budget_at_the_widest_settings() {
        // ADR 055: every assignment holds at most `MAX_EXPORT_INPUTS` inputs, so the widest
        // command of that many inputs is the widest command of any export. Each input is an FLV
        // input, each path has 259 characters, and each setting is at its widest.
        let (encoder, audio) = widest_lengths(MAX_EXPORT_INPUTS);
        assert!(
            encoder <= WINDOWS_COMMAND_LINE_BUDGET,
            "the encoder of {MAX_EXPORT_INPUTS} inputs needs {encoder} bytes, over the \
             {WINDOWS_COMMAND_LINE_BUDGET}-byte budget"
        );
        assert!(
            audio <= WINDOWS_COMMAND_LINE_BUDGET,
            "the audio process of {MAX_EXPORT_INPUTS} inputs needs {audio} bytes, over the \
             {WINDOWS_COMMAND_LINE_BUDGET}-byte budget"
        );
        // The audio process opens the inputs of the encoder, and no pipe, so it is never the
        // longer command.
        assert!(audio <= encoder);
    }

    #[test]
    fn one_more_input_does_not_fit_the_windows_budget() {
        // `MAX_EXPORT_INPUTS` is the largest count that fits, not a count that fits: a command
        // made shorter must raise it, as a longer one must lower it.
        let (encoder, _) = widest_lengths(MAX_EXPORT_INPUTS + 1);
        assert!(
            encoder > WINDOWS_COMMAND_LINE_BUDGET,
            "the encoder of {} inputs needs only {encoder} bytes; raise MAX_EXPORT_INPUTS",
            MAX_EXPORT_INPUTS + 1
        );
    }

    #[test]
    fn the_widest_plan_of_one_source_fits_at_every_count_of_pieces() {
        // The pieces of one source in source order, with gaps of about 1100 s, at every count up
        // to the limit: production reads them through one input for each piece, and past
        // `MAX_EXPORT_INPUTS` through runs cut at their gaps, up to that many inputs.
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        for count in 1..=MAX_EXPORT_SEGMENTS {
            for plan in [
                widest_plan(count),
                with_flv_input(widest_plan(count), u64::MAX),
            ] {
                assert!(
                    fits_windows(&plan, &reservation),
                    "{count} pieces: {:?}",
                    chosen_lengths(&plan, &reservation)
                );
            }
        }
    }

    #[test]
    fn the_widest_plan_the_settings_permit_fits_with_any_number_of_sources() {
        // For every count of sources up to the most of one export, every plan of `budget_sweep` of
        // the most pieces of one export must fit every command, with the inputs that production
        // chooses: the pieces in turn or skewed toward the FLV source, every piece reading audio
        // or every piece generating silence ([`silenced`]), with and without video, and with and
        // without an FLV input. The sweep also holds the plans of fewer pieces in which each
        // source but the first holds one piece. The count of pieces is the limit of one source,
        // past the limit of more sources, because the inputs, not that limit, keep the command
        // inside the budget (ADR 055).
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        for sources in 1..=max_export_sources() {
            for (name, plan) in budget_sweep(MAX_EXPORT_SEGMENTS, sources) {
                assert!(
                    fits_windows(&plan, &reservation),
                    "{name} does not fit: {:?}",
                    chosen_lengths(&plan, &reservation)
                );
            }
        }
        // The sweep holds both kinds of plan.
        let plan = widest_plan_of_sources(max_export_pieces(3), 3);
        assert!(silenced(plan.clone()).audio.is_some());
        assert!(!silenced(plan.clone()).separate_audio_process());
        assert!(plan.separate_audio_process());
    }

    #[test]
    fn the_widest_plan_without_video_still_fits_at_the_segment_cap() {
        // A graph without video pads every audio chain (`graph::audio_end_pad`). The graph is in
        // a file since ADR 055, so only the command that names it is measured here. The sweep
        // above holds the plans without video of several sources.
        let reservation = longest_windows_path(".m4a.tmp-13724-0");
        let plan = widest_audio_only_plan(MAX_EXPORT_SEGMENTS);
        let inputs = production_inputs(&plan);
        let graph = super::build_filter_graph(&plan, &inputs);
        assert_eq!(
            graph.matches("apad=whole_len=").count(),
            MAX_EXPORT_SEGMENTS,
            "every chain of a graph without video ends in the pad"
        );
        let length = measured_length(&plan, &inputs, &reservation);
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "the widest plan without video at {MAX_EXPORT_SEGMENTS} segments needs {length} \
             bytes, over the {WINDOWS_COMMAND_LINE_BUDGET}-byte budget"
        );
    }

    #[test]
    fn the_widest_audio_format_is_the_one_the_widest_plan_carries_and_it_fits_at_the_cap() {
        // ADR 023 made the closing `aformat` and `-b:a` preset settings, so the widest command
        // now depends on them, and the test above is only as good as `widest_audio` is wide.
        // This sweeps every other audio choice at the cap to prove none spells a longer command
        // with either layout of the inputs, and then asks the budget question for the widest one directly.
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        let widest = widest_plan(MAX_EXPORT_SEGMENTS);
        let widest_length =
            |inputs: &InputAssignment| -> usize { measured_length(&widest, inputs, &reservation) };

        for output_sample_rate in [MIN_AUDIO_SAMPLE_RATE, 44_100, 48_000, MAX_AUDIO_SAMPLE_RATE] {
            for (output_channels, output_layout) in [
                (AudioChannels::Source, None),
                (AudioChannels::Source, Some("5.1(side)")),
                (AudioChannels::Source, Some(WIDEST_CHANNEL_LAYOUT)),
                (AudioChannels::Stereo, Some("stereo")),
                (AudioChannels::Mono, Some("mono")),
            ] {
                for audio_bitrate in [
                    None,
                    Some(MIN_AUDIO_BITRATE_KBPS),
                    Some(320),
                    Some(MAX_AUDIO_BITRATE_KBPS),
                ] {
                    let mut plan = widest_plan(MAX_EXPORT_SEGMENTS);
                    plan.audio = Some(PlannedAudio {
                        output_sample_rate,
                        output_channels,
                        output_layout: output_layout.map(str::to_owned),
                        bitrate: audio_bitrate,
                        ..widest_audio()
                    });
                    for shape in [Inputs::PerPiece, Inputs::PerSource] {
                        let inputs = shape.of(&plan);
                        assert!(
                            measured_length(&plan, &inputs, &reservation) <= widest_length(&inputs),
                            "{output_sample_rate} Hz, {output_channels:?}, {audio_bitrate:?} \
                             as {shape:?} is wider than the widest plan"
                        );
                        assert!(
                            measured_audio_length(&plan, &inputs)
                                <= measured_audio_length(&widest, &inputs),
                            "the audio process of {output_sample_rate} Hz, {output_channels:?} \
                             as {shape:?} is wider than the widest plan"
                        );
                    }
                }
            }
        }

        // What ADR 023 costs on the command line, byte for byte. Against the 48000 Hz stereo
        // format ADR 014 fixed, with no bitrate: `-b:a 1536k`, which is two arguments of 4 and 5
        // bytes plus the per-argument overhead of each. The closing `aformat` filters are in the
        // graph, which is in a file since ADR 055, so they contribute nothing to the difference.
        let inputs = production_inputs(&widest);
        let mut legacy = widest_plan(MAX_EXPORT_SEGMENTS);
        legacy.audio = Some(PlannedAudio {
            output_sample_rate: 48_000,
            output_channels: AudioChannels::Stereo,
            output_layout: Some("stereo".to_owned()),
            bitrate: None,
            ..widest_audio()
        });
        assert_eq!(
            widest_length(&inputs) - measured_length(&legacy, &inputs, &reservation),
            (4 + ARGUMENT_OVERHEAD_BYTES) + (5 + ARGUMENT_OVERHEAD_BYTES)
        );

        let length = widest_length(&inputs);
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "the widest audio format at {MAX_EXPORT_SEGMENTS} segments needs {length} bytes, \
             over the {WINDOWS_COMMAND_LINE_BUDGET}-byte budget"
        );
        let audio_length = measured_audio_length(&widest, &inputs);
        assert!(
            audio_length <= WINDOWS_COMMAND_LINE_BUDGET,
            "the audio process of the widest audio format at {MAX_EXPORT_SEGMENTS} segments \
             needs {audio_length} bytes, over the budget"
        );
    }

    #[test]
    fn a_command_over_its_budget_is_refused_with_both_lengths_and_one_at_it_is_not() {
        // The guard of ADR 055 against a command that the tests of the budget missed: measured
        // against an artificial budget, the refusal comes exactly one byte past the length.
        let plan = windows_plan(20);
        let command = super::build_arguments(
            &plan,
            &production_inputs(&plan),
            GRAPH,
            Path::new(WINDOWS_OUTPUT),
        );
        let length = command_line_length(&command);
        assert_eq!(check_command_line_within(&command, length), Ok(()));
        assert_eq!(
            check_command_line_within(&command, length - 1),
            Err(format!(
                "the command line needs {length} bytes, over the budget of {}",
                length - 1
            ))
        );
        // The host's own budget accepts every command that fits the Windows one.
        assert_eq!(check_command_line(&command), Ok(()));
    }

    #[test]
    fn the_encoder_and_the_audio_process_open_the_same_inputs_with_the_same_seeks_and_slices() {
        // One assignment serves both processes (ADR 055). The audio process opens the inputs whose
        // pieces read audio, each exactly as the encoder opens it.
        let mut plan = with_flv_input(widest_plan_of_sources(MAX_EXPORT_INPUTS + 6, 3), u64::MAX);
        // The third source has no audio stream: its pieces generate silence in the audio process.
        plan.sources[2].audio = None;
        let inputs = production_inputs(&plan);
        let groups = |arguments: &[String]| -> Vec<Vec<String>> {
            let mut groups = Vec::new();
            let mut index = 0;
            while index < arguments.len() {
                match arguments[index].as_str() {
                    "-ss" => {
                        groups.push(arguments[index..index + 4].to_vec());
                        index += 4;
                    }
                    "-i" if arguments[index + 1] != "pipe:0" => {
                        groups.push(arguments[index..index + 2].to_vec());
                        index += 2;
                    }
                    _ => index += 1,
                }
            }
            groups
        };
        let encoder = groups(&super::build_arguments(
            &plan,
            &inputs,
            GRAPH,
            Path::new(OUTPUT),
        ));
        let audio = groups(&super::build_audio_arguments(&plan, &inputs, AUDIO_GRAPH));
        assert_eq!(encoder.len(), inputs.inputs().len());
        let reading: Vec<Vec<String>> = inputs
            .inputs()
            .iter()
            .zip(&encoder)
            .filter(|(input, _)| input.source != 2)
            .map(|(_, group)| group.clone())
            .collect();
        assert_eq!(audio, reading);
        assert!(audio.len() < encoder.len());
        assert!(audio.iter().any(|group| group[1].starts_with("concat:")));
    }

    #[test]
    fn the_windows_budget_leaves_room_for_the_executable_and_is_below_the_platform_limit() {
        // The headroom is the part of the limit this module cannot measure: argument zero, the
        // ffmpeg executable path, which the process stage supplies.
        assert_eq!(
            WINDOWS_COMMAND_LINE_BUDGET + COMMAND_LINE_HEADROOM_BYTES,
            WINDOWS_COMMAND_LINE_LIMIT
        );
        assert_eq!(
            UNIX_COMMAND_LINE_BUDGET + COMMAND_LINE_HEADROOM_BYTES,
            UNIX_ARGUMENT_LIMIT
        );
        // The host budget is one of the two, and never something else. This is a compile-time
        // assertion because both operands are constants: a `cfg` that selected neither, or a
        // third budget added without a platform behind it, fails to build rather than to run.
        const {
            assert!(
                COMMAND_LINE_BUDGET == WINDOWS_COMMAND_LINE_BUDGET
                    || COMMAND_LINE_BUDGET == UNIX_COMMAND_LINE_BUDGET
            );
        }
    }

    /// The fixture plan of one segment that copies its audio (ADR 048): the video-only plan with
    /// a [`CopiedAudio`] of stream 2, cut at the In and Out points of the segment,
    /// 148480/12800 = 11.6 s and 151552/12800 = 11.84 s.
    fn copy_plan(container: Container) -> ExportPlan {
        let mut plan = video_only_plan(1, container);
        plan.copied_audio = Some(CopiedAudio {
            stream_index: 2,
            start: Rational::new(148_480, 12_800).unwrap(),
            end: Rational::new(151_552, 12_800).unwrap(),
            adts_to_asc: false,
        });
        plan
    }

    /// The copy plan without its video part, as an audio-only export plans it.
    fn audio_only_copy_plan(container: Container) -> ExportPlan {
        let mut plan = copy_plan(container);
        plan.video = None;
        plan
    }

    /// The copy plan of an MPEG-TS source, whose AAC needs the conversion from ADTS.
    fn adts_copy_plan(container: Container) -> ExportPlan {
        let mut plan = copy_plan(container);
        plan.copied_audio.as_mut().unwrap().adts_to_asc = true;
        plan
    }

    /// The command of the copy process of `plan`.
    fn copy_process(plan: &ExportPlan) -> Vec<String> {
        build_copy_arguments(plan, CopyOutput::Pipe).expect("the plan copies its audio")
    }

    /// The command of an export without video that copies its audio, against `OUTPUT`.
    fn copy_to_file(plan: &ExportPlan) -> Vec<String> {
        build_copy_arguments(plan, CopyOutput::File(Path::new(OUTPUT)))
            .expect("the plan copies its audio")
    }

    #[test]
    fn a_plan_with_video_that_copies_its_audio_runs_a_copy_process() {
        let plan = copy_plan(Container::Mp4);
        assert!(plan.separate_copy_process());
        // The copy process is not the audio process of ADR 043, which decodes the audio.
        assert!(!plan.separate_audio_process());
        assert!(!audio_only_copy_plan(Container::Mp4).separate_copy_process());
        assert!(!fixture_plan(1).separate_copy_process());
    }

    #[test]
    fn the_copy_process_writes_the_cut_packets_as_nut_to_its_stdout() {
        // The input of the encoder, the stream by its absolute index, and the cut as an output
        // `-ss` and `-to` at the absolute In and Out points. The flags of the audio process: no
        // `-progress pipe:1` and no `-y`. No graph, and no conversion from ADTS, which the encoder
        // writes.
        assert_eq!(
            copy_process(&adts_copy_plan(Container::Mp4)),
            vec![
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostats",
                "-copyts",
                "-ss",
                "6.6",
                "-i",
                "/media/source.mp4",
                "-map",
                "0:2",
                "-c:a",
                "copy",
                "-ss",
                "11.6",
                "-to",
                "11.84",
                "-f",
                "nut",
                "pipe:1",
            ]
        );
    }

    #[test]
    fn the_encoder_of_a_copy_process_copies_the_audio_of_its_stdin() {
        // The graph is the graph of a plan without audio, the pipe is NUT, and the audio is
        // copied. Nothing cuts the output of the encoder: the copy process ends the stream.
        assert_eq!(
            arguments(&copy_plan(Container::Mp4), Inputs::PerPiece),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-f",
                "nut",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
        let graph = |plan: &ExportPlan| encoder_graph(plan, Inputs::PerPiece);
        assert_eq!(
            graph(&copy_plan(Container::Mp4)),
            graph(&video_only_plan(1, Container::Mp4))
        );
    }

    #[test]
    fn the_encoder_of_a_copy_writes_the_muxer_of_its_container_and_converts_adts() {
        let tail = |plan: &ExportPlan| {
            let all = arguments(plan, Inputs::PerPiece);
            let codec = all.iter().position(|a| a == "-c:a").unwrap();
            all[codec..].to_vec()
        };
        assert_eq!(
            tail(&copy_plan(Container::Mov)),
            [
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                "-f",
                "mov",
                OUTPUT
            ]
        );
        assert_eq!(
            tail(&copy_plan(Container::Mkv)),
            ["-c:a", "copy", "-f", "matroska", OUTPUT]
        );
        assert_eq!(
            tail(&adts_copy_plan(Container::Mp4)),
            [
                "-c:a",
                "copy",
                "-bsf:a",
                "aac_adtstoasc",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                OUTPUT
            ]
        );
    }

    #[test]
    fn an_audio_only_copy_writes_the_output_file_in_one_command_without_a_graph() {
        assert_eq!(
            copy_to_file(&audio_only_copy_plan(Container::Mp4)),
            vec![
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
                "6.6",
                "-i",
                "/media/source.mp4",
                "-map",
                "0:2",
                "-c:a",
                "copy",
                "-ss",
                "11.6",
                "-to",
                "11.84",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "/export/.out.mp4.tmp-4242-0",
            ]
        );
        // A MOV preset writes an `.m4a` through the `mp4` muxer, as every audio-only export does,
        // and an MKV preset an `.mka` through `matroska`.
        let muxer = |plan: &ExportPlan| {
            let all = copy_to_file(plan);
            let to = all.iter().position(|a| a == "-to").unwrap();
            all[to + 2..].to_vec()
        };
        assert_eq!(
            muxer(&audio_only_copy_plan(Container::Mov)),
            ["-movflags", "+faststart", "-f", "mp4", OUTPUT]
        );
        assert_eq!(
            muxer(&audio_only_copy_plan(Container::Mkv)),
            ["-f", "matroska", OUTPUT]
        );
        let mut adts = audio_only_copy_plan(Container::Mp4);
        adts.copied_audio.as_mut().unwrap().adts_to_asc = true;
        let all = copy_to_file(&adts);
        assert!(all
            .windows(4)
            .any(|four| four == ["-c:a", "copy", "-bsf:a", "aac_adtstoasc"]));
    }

    #[test]
    fn the_copy_writes_its_output_seek_at_an_in_point_of_zero() {
        // An In point of zero needs no input seek, which ADR 014 never writes as zero. The output
        // `-ss 0` still drops the priming packet of AAC, so it stays.
        let mut plan = copy_plan(Container::Mp4);
        plan.segments[0].seek_seconds = None;
        let copied = plan.copied_audio.as_mut().unwrap();
        copied.start = Rational::new(0, 1).unwrap();
        copied.end = Rational::new(5, 1).unwrap();
        assert_eq!(
            copy_process(&plan)[5..13],
            ["-copyts", "-i", SOURCE, "-map", "0:2", "-c:a", "copy", "-ss"]
        );
        assert_eq!(copy_process(&plan)[13..16], ["0", "-to", "5"]);
    }

    #[test]
    fn the_copy_process_opens_the_flv_slice_of_the_encoder() {
        let mut plan = copy_plan(Container::Mp4);
        plan.sources[0].path = PathBuf::from("/media/live.flv");
        plan.sources[0].flv_input = Some(FlvInput {
            head_name: head_name(0),
            source_size: 212_700_000,
            segment_offsets: vec![9_000_000],
            first_frame_offset: 13,
        });
        let slice = "concat:h0.flv|subfile,,start,9000000,end,212700000,,:/media/live.flv";
        assert_eq!(copy_process(&plan)[5..8], ["-copyts", "-i", slice]);
        assert_eq!(
            input_arguments(&plan, Inputs::PerPiece),
            ["-i", slice, "-f", "nut", "-i", "pipe:0"]
        );
    }

    #[test]
    fn no_copy_command_cuts_the_encoder_or_carries_a_graph() {
        // The encoder must read `pipe:0` to its end, and an output option of the encoder would cut
        // the video too. So `-ss` appears in the encoder only in front of its input, and `-to`,
        // `-t` and `-shortest` never. A copy command has no graph, and each command has one
        // `-copyts`.
        let count = |all: &[String], flag: &str| all.iter().filter(|a| *a == flag).count();
        for container in [Container::Mp4, Container::Mov, Container::Mkv] {
            for plan in [copy_plan(container), adts_copy_plan(container)] {
                let encoder = arguments(&plan, Inputs::PerPiece);
                for flag in ["-to", "-t", "-shortest"] {
                    assert_eq!(count(&encoder, flag), 0, "{flag} in {encoder:?}");
                }
                let first_input = encoder.iter().position(|a| a == "-i").unwrap();
                assert!(encoder[first_input..].iter().all(|a| a != "-ss"));
                assert_eq!(count(&encoder, "-copyts"), 1);
                let copy = copy_process(&plan);
                assert_eq!(count(&copy, "-filter_complex"), 0);
                assert_eq!(count(&copy, "-copyts"), 1);
                assert_eq!(count(&copy, "-to"), 1);
            }
            let file = copy_to_file(&audio_only_copy_plan(container));
            assert_eq!(count(&file, "-filter_complex"), 0);
            assert_eq!(count(&file, "-copyts"), 1);
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "the copy of an export without video has no graph")]
    fn the_encoder_command_of_an_audio_only_copy_trips_the_debug_assertion() {
        // `commands::export` writes that export with `build_copy_arguments` alone. Its graph
        // would have neither part, which ffmpeg rejects.
        let _ = arguments(&audio_only_copy_plan(Container::Mp4), Inputs::PerPiece);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "never both")]
    fn a_plan_that_encodes_and_copies_its_audio_trips_the_debug_assertion() {
        let mut plan = copy_plan(Container::Mp4);
        plan.audio = fixture_plan(1).audio;
        let _ = arguments(&plan, Inputs::PerPiece);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "a copy with video writes to the pipe")]
    fn a_copy_with_video_into_the_file_trips_the_debug_assertion() {
        // The file of a copy holds the audio alone. With video, the encoder writes the file.
        let _ = copy_to_file(&copy_plan(Container::Mp4));
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "one segment only")]
    fn a_copy_of_two_segments_trips_the_debug_assertion() {
        let mut plan = copy_plan(Container::Mp4);
        plan.segments = video_only_plan(2, Container::Mp4).segments;
        let _ = copy_process(&plan);
    }

    #[test]
    fn a_plan_that_copies_no_audio_has_no_copy_command() {
        for plan in [fixture_plan(1), video_only_plan(1, Container::Mp4)] {
            assert_eq!(build_copy_arguments(&plan, CopyOutput::Pipe), None);
            assert_eq!(
                build_copy_arguments(&plan, CopyOutput::File(Path::new(OUTPUT))),
                None
            );
        }
    }

    #[test]
    fn the_time_of_a_copy_renders_a_zero_and_truncates_as_a_seek() {
        assert_eq!(render_time(Rational::new(0, 1).unwrap()), "0");
        assert_eq!(render_time(Rational::new(1, 3_000_000).unwrap()), "0");
        assert_eq!(render_time(Rational::new(58, 5).unwrap()), "11.6");
        assert_eq!(
            render_time(Rational::new(1001, 30_000).unwrap()),
            "0.033366"
        );
    }

    // -- several sources (ADR 053) ----------------------------------------------------------

    /// The fixture plan of three pieces with piece 1 from a second source, which has no audio
    /// stream and an FLV input when `flv` holds. Pieces 0 and 2 stay pieces of the first source.
    fn two_source_plan(flv: bool) -> ExportPlan {
        let mut plan = fixture_plan(3);
        let mut second = source_at("/media/second.flv", 0, 1, 44_100);
        second.audio = None;
        if flv {
            second.flv_input = Some(FlvInput {
                head_name: head_name(1),
                source_size: 212_700_000,
                segment_offsets: vec![4_000_000],
                first_frame_offset: 13,
            });
        }
        plan.sources.push(second);
        plan.segments[1].source = 1;
        plan.segments[1].audio_in_tick = Some(0);
        plan.segments[1].audio_out_tick = Some(14_400);
        plan
    }

    #[test]
    fn each_piece_opens_its_own_source_and_the_audio_process_only_the_pieces_it_reads() {
        let plan = two_source_plan(false);
        assert!(plan.separate_audio_process());
        // The encoder reads the video of every piece: one input for each, from its own source.
        assert_eq!(
            input_arguments(&plan, Inputs::PerPiece),
            [
                "-ss",
                "6.6",
                "-i",
                SOURCE,
                "-ss",
                "5",
                "-i",
                "/media/second.flv",
                "-ss",
                "15",
                "-i",
                SOURCE,
                "-f",
                "wav",
                "-i",
                "pipe:0",
            ]
        );
        // One input for each source, in the order of its first piece, seeked for the earliest
        // of its pieces: 6.6 s for pieces 0 and 2 of the first source.
        assert_eq!(
            input_arguments(&plan, Inputs::PerSource),
            [
                "-ss",
                "6.6",
                "-i",
                SOURCE,
                "-ss",
                "5",
                "-i",
                "/media/second.flv",
                "-f",
                "wav",
                "-i",
                "pipe:0",
            ]
        );
        // The audio process reads no input for the piece of the source without audio.
        let audio = |shape: Inputs| {
            let all = build_audio_arguments(&plan, shape, AUDIO_GRAPH);
            let start = all.iter().position(|a| a == "-copyts").unwrap() + 1;
            let end = all.iter().position(|a| a == "-/filter_complex").unwrap();
            all[start..end].to_vec()
        };
        assert_eq!(
            audio(Inputs::PerPiece),
            ["-ss", "6.6", "-i", SOURCE, "-ss", "15", "-i", SOURCE]
        );
        assert_eq!(audio(Inputs::PerSource), ["-ss", "6.6", "-i", SOURCE]);
    }

    #[test]
    fn the_flv_input_of_one_source_takes_the_offsets_of_its_own_pieces() {
        // The second source holds one piece, so its one offset belongs to piece 1, and its head
        // has the index of the second source.
        let plan = two_source_plan(true);
        let slice = "concat:h1.flv|subfile,,start,4000000,end,212700000,,:/media/second.flv";
        assert_eq!(
            input_arguments(&plan, Inputs::PerPiece)[4..6],
            ["-i", slice]
        );
        assert_eq!(
            input_arguments(&plan, Inputs::PerSource)[4..6],
            ["-i", slice]
        );
    }
}
