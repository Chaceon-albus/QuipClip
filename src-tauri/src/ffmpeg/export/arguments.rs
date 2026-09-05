//! Assemble ADR 014's `ffmpeg` command line, and pick the graph shape that fits inside it.
//!
//! [`build_arguments`] is pure: it reads a finished [`ExportPlan`], a rendered graph, and the
//! reserved output path, and it returns the argument vector verbatim. It spawns nothing, opens
//! nothing, and reads no clock, so every rule ADR 014 settled about the command is testable
//! without ffmpeg installed -- which is what the pinned-vector tests below do, exactly as
//! [`crate::ffmpeg::capabilities::smoke`]'s tests pin ADR 006's two smoke commands verbatim.
//!
//! Five of ADR 014's rules live here and nowhere else.
//!
//! - **`-copyts` is set once, before the first input.** Measurement 18 found the option
//!   global: one instance gives raw source PTS on every input, which is the timestamp domain
//!   the plan's `trim` boundaries live in. A second instance changes nothing except the length
//!   of the command line, and at the segment cap that length is the whole constraint.
//! - **`-y` is mandatory.** [`super::output::PendingOutput`] reserves the output path by
//!   *creating* the file, so the path exists, and holds zero bytes, before ffmpeg starts.
//!   Without `-y` ffmpeg prints `File '<path>' already exists. Exiting.` -- and **exits zero**,
//!   because fftools maps `AVERROR_EXIT` to exit code 0. A caller that read only the exit
//!   status would then rename that zero-byte reservation over the user's video. `output.rs`
//!   documents the measurement; this module is the one that has to act on it.
//! - **`-f <muxer>` is mandatory.** The reserved name ends in `.tmp-<pid>-<sequence>`, not in
//!   `.mp4`, so ffmpeg has no extension to infer a muxer from. [`Container::Mkv`] selects the
//!   muxer named `matroska`, not `mkv`; the other two names match their enum variants.
//! - **`-ss` is omitted, never zeroed.** ADR 014's "The seek" section clamps a negative seek at
//!   zero and reports it as [`None`], and measurement 7 records that the legacy trailing
//!   `-ss 0` idiom has had no effect since ffmpeg 2.1. A literal zero would be dead weight, so
//!   an input whose [`seek_seconds`](super::PlannedSegment::seek_seconds) is `None` carries no
//!   `-ss` at all.
//! - **The graph rides inline.** Measurement 13 leaves no portable spelling for a graph file:
//!   `-filter_complex_script` is gone from ffmpeg 9.0.1, and its replacement `-/filter_complex`
//!   did not exist before 7.1. The graph is therefore one ordinary argument, and it competes
//!   with every other argument for one command-line budget.
//!
//! That last rule is why [`choose_graph_shape`] lives here rather than in [`super::graph`].
//! Only this module can measure the assembled command, so only this module can decide which of
//! ADR 014's two [`GraphShape`] variants an export can afford. See [`WINDOWS_COMMAND_LINE_LIMIT`]
//! for the budget, and the tests for the one assertion that keeps
//! [`MAX_EXPORT_SEGMENTS`](super::MAX_EXPORT_SEGMENTS) and that limit from drifting apart.
//!
//! No step here uses floating point. A seek reaches ffmpeg as an exact decimal expansion of the
//! plan's [`Rational`], truncated at ffmpeg's own microsecond resolution; the private
//! `render_seek` has the rounding rule and its one-sided guarantee.

use super::graph::build_filter_graph;
use super::{ExportPlan, GraphShape};
use crate::settings::{Container, Quality, QualityKind};
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
/// [`super::MAX_EXPORT_SEGMENTS`] exists at all. It is *not* the 8191-character limit of
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
/// Nothing reaches it. [`super::MAX_EXPORT_SEGMENTS`] holds the widest command the settings
/// permit near 31500 bytes, 33 times smaller, so this constant is a real platform number for
/// the platform rather than a bound the renderer ever tests -- and one consequence is worth
/// stating plainly: because [`COMMAND_LINE_BUDGET`] is the host's own, [`GraphShape::SingleInput`]
/// is unreachable on macOS in production. Only a Windows user's export can select the fallback;
/// on macOS it is exercised by the tests alone.
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
/// source path, the output path, and the graph all can. Charging every argument for quoting
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

/// Choose the [`GraphShape`] this plan can afford, for an export that will write `output`.
///
/// `output` is the **reserved temporary path** [`super::output::PendingOutput::path`] returns,
/// not [`ExportPlan::destination`]: the reservation is what appears on the command line, and
/// it is the longer of the two. It is the only path the plan does not already carry, which is
/// why it is the only path this function takes -- measuring a source path the caller passed
/// separately would let the budget describe a command that [`build_arguments`] never builds.
///
/// The rule is ADR 014's: prefer one input for each segment, and fall back to one input for
/// the whole source when the first shape does not fit. `SingleInput` is not the smaller graph
/// -- measurement 15 found it the larger of the two at every segment count -- so it is a
/// fallback, never a default. What it saves lies outside the graph: it writes the source path
/// and its input flags once instead of once for each segment.
///
/// # This function cannot fail
///
/// There is no third shape, so a plan too large for both is simply rendered in the one that
/// reaches furthest. Nothing here reports that condition, and nothing needs to: ADR 014 makes
/// [`super::MAX_EXPORT_SEGMENTS`] the guarantee, and [`super::plan::build_plan`] enforces that
/// cap before an [`ExportPlan`] exists at all. The test
/// `a_full_length_plan_on_a_long_windows_path_fits_the_windows_command_line` is what holds the
/// cap and the platform limit together; if the cap ever rises past what the limit allows, that
/// test fails rather than a user's export failing.
///
/// # Cost
///
/// This renders the `InputPerSegment` graph to measure it, and the caller then renders the
/// graph of the shape it returns, so the common case builds a graph string twice. That is the
/// point. A projected length -- ADR 014 measurement 15's "about 260 bytes for each segment"
/// turned into a formula -- would be a second, silently drifting copy of everything
/// [`build_filter_graph`] decides, and measurement 15's own figures have already moved once
/// since it was written. Measuring the real thing costs about 42 KB of allocation on the
/// largest plan this crate accepts, against an export that then runs for minutes.
#[must_use]
pub fn choose_graph_shape(plan: &ExportPlan, output: &Path) -> GraphShape {
    choose_graph_shape_within(plan, output, COMMAND_LINE_BUDGET)
}

/// [`choose_graph_shape`] against an explicit budget, so a test can ask the Windows question
/// on a host that is not Windows.
fn choose_graph_shape_within(plan: &ExportPlan, output: &Path, budget: usize) -> GraphShape {
    let graph = build_filter_graph(plan, GraphShape::InputPerSegment);
    let arguments = build_arguments(plan, GraphShape::InputPerSegment, &graph, output);
    if command_line_length(&arguments) <= budget {
        GraphShape::InputPerSegment
    } else {
        GraphShape::SingleInput
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
/// `graph` is the string [`build_filter_graph`] returned for this same `shape`; it is copied
/// into exactly one argument, unexamined. `output` is the reserved temporary path
/// [`super::output::PendingOutput::path`] returns, **not** [`ExportPlan::destination`]: ffmpeg
/// writes the reservation, and the rename that publishes the destination happens after this
/// process has exited.
///
/// The vector excludes the executable itself. [`super::process::ExportProcessRequest`] carries
/// the ffmpeg path separately, exactly as [`std::process::Command`] does.
///
/// # Preconditions
///
/// `plan.segments` must not be empty, and `shape` must be the shape `graph` was rendered in.
/// [`super::plan::build_plan`] rejects an empty request with
/// [`ExportErrorCode::NoSegments`](super::ExportErrorCode::NoSegments), so an empty plan cannot
/// arise from it, and a debug assertion catches a hand-built one: it would produce a command
/// with no `-i` at all. The two shapes disagree about how many `-i` arguments the graph's input
/// labels refer to, so mismatching them produces a command ffmpeg rejects while parsing the
/// graph.
///
/// # Audio
///
/// `-map "[a]"` and `-c:a` appear exactly when [`ExportPlan::audio`] is [`Some`], which for
/// every plan [`super::plan::build_plan`] produces is exactly when [`build_filter_graph`]
/// writes an `[a]` output label. (The two can only disagree for a hand-built plan that carries
/// an audio stream but leaves a segment without ticks; `build_filter_graph` documents that
/// case, and a debug assertion there is what reports it.) Neither the audio encoder name nor an
/// audio bitrate reaches the command line otherwise. ADR 013 gives no audio bitrate control at
/// all: [`Quality`] describes the video stream, and the audio encoder runs at its own default.
#[must_use]
pub fn build_arguments(
    plan: &ExportPlan,
    shape: GraphShape,
    graph: &str,
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
    // the segment cap under `InputPerSegment`, which is where the saving lands, since
    // `SingleInput` opens one input and would carry one copy either way.
    arguments.push("-copyts".to_owned());

    match shape {
        GraphShape::InputPerSegment => {
            for segment in &plan.segments {
                push_input(&mut arguments, segment.seek_seconds, &plan.source);
            }
        }
        // One input, seeked once before the earliest frame any segment needs. This must be
        // `single_input_seek_seconds`, not `segments[0].seek_seconds`: concat order need not
        // match source order, so the first array element is not necessarily the earliest one,
        // and seeking to it would skip material a later array element still needs.
        GraphShape::SingleInput => {
            push_input(
                &mut arguments,
                plan.single_input_seek_seconds(),
                &plan.source,
            );
        }
    }

    push_pair(&mut arguments, "-filter_complex", graph);
    push_pair(&mut arguments, "-map", "[v]");
    if plan.audio.is_some() {
        push_pair(&mut arguments, "-map", "[a]");
    }

    push_pair(&mut arguments, "-c:v", &plan.video_encoder);
    let (quality_flag, quality_value) = quality_arguments(plan.quality);
    push_pair(&mut arguments, quality_flag, &quality_value);
    if plan.audio.is_some() {
        push_pair(&mut arguments, "-c:a", &plan.audio_encoder);
    }

    let (muxer, faststart) = muxer_of(plan.container);
    if faststart {
        push_pair(&mut arguments, "-movflags", "+faststart");
    }
    push_pair(&mut arguments, "-f", muxer);
    arguments.push(path_argument(output));
    arguments
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

/// The quality flag and rendered value for one preset's [`Quality`], from ADR 013.
///
/// `Bitrate` is stored in kilobits per second, so it reaches ffmpeg with the `k` suffix; the
/// bare number would mean bits per second, which is a thousand times too small and would still
/// encode, badly, without any error.
fn quality_arguments(quality: Quality) -> (&'static str, String) {
    match quality.kind {
        QualityKind::Crf => ("-crf", quality.value.to_string()),
        QualityKind::Bitrate => ("-b:v", format!("{}k", quality.value)),
        QualityKind::QualityScale => ("-q:v", quality.value.to_string()),
    }
}

/// The muxer name for one container, and whether `-movflags +faststart` applies to it.
///
/// The two answers come from one `match` because they are one decision. `+faststart` is an
/// option of the mov/mp4 muxer family and nothing else; pairing it with the muxer name here
/// means a container added later cannot pick up a muxer without also stating whether the flag
/// belongs on it. `Mkv` maps to `matroska`, which is the muxer's real name -- `ffmpeg -f mkv`
/// is not a muxer at all.
const fn muxer_of(container: Container) -> (&'static str, bool) {
    match container {
        Container::Mp4 => ("mp4", true),
        Container::Mov => ("mov", true),
        Container::Mkv => ("matroska", false),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::{OutputTiming, PlannedAudio, PlannedSegment, MAX_EXPORT_SEGMENTS};
    use crate::project::Resolution;
    use crate::settings::{MAX_ENCODER_NAME_CHARS, MAX_RESOLUTION_DIMENSION};
    use crate::time::Pts;
    use std::path::PathBuf;

    /// A stand-in for a rendered filter graph.
    ///
    /// `build_arguments` copies its `graph` argument into exactly one argument without reading
    /// it, and `graph.rs` already pins what that string contains for every shape, resolution,
    /// and timing mode. A sentinel keeps the vectors below about the flags *around* the graph,
    /// and it still fails loudly for a builder that split the graph across two arguments or
    /// moved it away from `-filter_complex`. Two tests below pass the real thing instead.
    const GRAPH: &str = "<graph>";

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
    /// ordering is what separates `single_input_seek_seconds` from `segments[0]`.
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
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
            seek_seconds,
            audio_in_tick: Some(audio_in_tick),
            audio_out_tick: Some(audio_out_tick),
        }
    }

    /// A plan over the first `count` fixture segments: H.264 video at CRF 20, AAC audio, MP4.
    fn fixture_plan(count: usize) -> ExportPlan {
        let frames = 6 + 12 * (count - 1);
        ExportPlan {
            source: PathBuf::from(SOURCE),
            destination: PathBuf::from("/export/out.mp4"),
            video_stream_index: 1,
            audio: Some(PlannedAudio {
                stream_index: 2,
                sample_rate: 44_100,
            }),
            segments: fixture_segments(count),
            timing: OutputTiming::ConstantFrameRate(Rational::new(25, 1).unwrap()),
            resolution: None,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            container: Container::Mp4,
            total_duration: Rational::new(i64::try_from(frames).unwrap(), 25).unwrap(),
            expected_frames: Some(u64::try_from(frames).unwrap()),
        }
    }

    /// `build_arguments` for a fixture plan and the sentinel graph, against `OUTPUT`.
    fn arguments(plan: &ExportPlan, shape: GraphShape) -> Vec<String> {
        build_arguments(plan, shape, GRAPH, Path::new(OUTPUT))
    }

    #[test]
    fn builds_the_exact_adr_014_command_for_one_segment() {
        assert_eq!(
            arguments(&fixture_plan(1), GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
    fn gives_every_segment_its_own_seeked_input_under_the_first_shape() {
        // Three inputs, three seeks, and the source path written three times -- the cost that
        // makes the second shape necessary at a high segment count. One `-copyts` covers all
        // three inputs (ADR 014 measurement 18), so it appears once, ahead of the first.
        assert_eq!(
            arguments(&fixture_plan(3), GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
            arguments(&fixture_plan(3), GraphShape::SingleInput),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
    fn a_plan_without_audio_maps_and_encodes_video_only() {
        // `build_filter_graph` writes no `[a]` label for such a plan, so a stray `-map "[a]"`
        // here would fail the export while ffmpeg resolves the map, and a stray `-c:a` would
        // name an encoder for a stream that does not exist.
        let mut plan = fixture_plan(1);
        plan.audio = None;
        plan.segments[0].audio_in_tick = None;
        plan.segments[0].audio_out_tick = None;
        assert_eq!(
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-c:v",
                "libx264",
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
    fn a_segment_whose_seek_clamped_to_none_carries_no_ss_at_all() {
        // ADR 014 measurement 7: the trailing `-ss 0` idiom is a workaround for ffmpeg before
        // 2.1 and has no effect on any build a user can install today. The absence of the flag
        // is the spelling of a zero seek, so the second input group here opens with `-copyts`
        // and goes straight to `-i`.
        let mut plan = fixture_plan(2);
        plan.segments[1].seek_seconds = None;
        assert_eq!(
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
        plan.video_encoder = "h264_nvenc".to_owned();
        plan.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 8_000,
        };
        assert_eq!(
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "h264_nvenc",
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
    fn a_quality_scale_preset_uses_q_v_and_still_leaves_the_audio_bitrate_alone() {
        // ADR 013 defines no audio bitrate control at all: `Quality` describes the video
        // stream, and the audio encoder runs at its own default. `-b:a` appears nowhere.
        let mut plan = fixture_plan(1);
        plan.quality = Quality {
            kind: QualityKind::QualityScale,
            value: 3,
        };
        assert_eq!(
            arguments(&plan, GraphShape::InputPerSegment),
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
    fn a_plan_whose_earliest_seek_clamped_opens_the_single_input_with_no_ss() {
        // `single_input_seek_seconds` returns `None` when the earliest segment by `in_pts`
        // clamped, and the one input group must then carry no `-ss` either.
        let mut plan = fixture_plan(3);
        plan.segments[1].seek_seconds = None;
        let arguments = arguments(&plan, GraphShape::SingleInput);
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
                "-filter_complex",
                "<graph>",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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
        // 002), never as a rounded 29.97, and the whole graph travels as one argument. The
        // seek is 1/3 s -- 160000/30000 - 5 -- which has no finite decimal, so it renders
        // truncated at ffmpeg's microsecond resolution and lands marginally early.
        //
        // The `aformat=sample_rates=48000` at the head of the audio chain is `graph.rs`'s input
        // pin, and this test is the one place in this module that shows it. It exists because
        // of the `-ss` above: ADR 014 measurement 17 found that a seeked input reports the rate
        // the graph negotiates for its *output*, so without the pin `atrim` would read the
        // plan's source-rate ticks in the wrong unit. A 48000 Hz fixture cannot show the fault
        // -- the two rates agree -- so `graph.rs` owns that test; this one only pins that the
        // command carries whatever graph it was handed, verbatim.
        let mut plan = fixture_plan(1);
        plan.timing = OutputTiming::ConstantFrameRate(
            Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
        );
        plan.audio = Some(PlannedAudio {
            stream_index: 2,
            sample_rate: 48_000,
        });
        plan.segments[0] = segment(160_000, 190_030, 256_000, 304_048, Rational::new(1, 3));
        plan.expected_frames = Some(30);
        plan.total_duration = Rational::new(1_001, 1_000).expect("1.001 is a valid duration");

        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            build_arguments(
                &plan,
                GraphShape::InputPerSegment,
                &graph,
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
                "0.333333",
                "-i",
                "/media/source.mp4",
                "-filter_complex",
                concat!(
                    "[0:1]trim=start_pts=160000:end_pts=190030,setpts=PTS-STARTPTS,",
                    "fps=30000/1001,format=yuv420p[v0];",
                    "[0:2]aformat=sample_rates=48000,",
                    "atrim=start_pts=256000:end_pts=304048,asetpts=PTS-STARTPTS,",
                    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                    "[v0][a0]concat=n=1:v=1:a=1[v][a]",
                ),
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-c:v",
                "libx264",
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

    /// Every plan and shape the guard tests below sweep: both shapes, every container, with
    /// and without audio, every quality kind, a clamped seek, and a sub-microsecond seek.
    fn guard_matrix() -> Vec<(ExportPlan, GraphShape)> {
        let mut cases: Vec<(ExportPlan, GraphShape)> = Vec::new();
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            for count in [1, 3] {
                cases.push((fixture_plan(count), shape));
            }
            for container in [Container::Mp4, Container::Mov, Container::Mkv] {
                let mut plan = fixture_plan(2);
                plan.container = container;
                cases.push((plan, shape));
            }
            for kind in [
                QualityKind::Crf,
                QualityKind::Bitrate,
                QualityKind::QualityScale,
            ] {
                let mut plan = fixture_plan(2);
                plan.quality = Quality { kind, value: 7 };
                cases.push((plan, shape));
            }
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
    fn no_command_ever_carries_filter_complex_script_or_a_bare_ss_zero() {
        // Two rules from ADR 014 that no single pinned vector can guarantee, so they are swept
        // over the whole matrix instead.
        //
        // `-filter_complex_script` (measurement 13) is absent from ffmpeg 9.0.1, and its
        // replacement `-/filter_complex` did not exist before 7.1, so neither spelling is
        // portable and the graph must ride inline. `-ss 0` (measurement 7) is a workaround for
        // ffmpeg before 2.1 with no effect on any build a user can install.
        for (plan, shape) in guard_matrix() {
            let arguments = arguments(&plan, shape);
            assert!(
                !arguments
                    .iter()
                    .any(|argument| argument.contains("filter_complex_script")),
                "{arguments:?}"
            );
            assert!(
                !arguments
                    .iter()
                    .any(|argument| argument == "-/filter_complex"),
                "{arguments:?}"
            );
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
            let muxer = arguments
                .iter()
                .position(|argument| argument == "-f")
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
        plan.video_encoder = video.to_owned();
        plan.audio_encoder = audio.to_owned();
        let emitted = arguments(&plan, GraphShape::InputPerSegment);

        let mut expected = arguments(&fixture_plan(1), GraphShape::InputPerSegment);
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
        // position and displaces nothing, so the command reads `-c:v -i -crf 20 -c:a ...`.
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
        assert_eq!(emitted[video + 2], "-crf");
        assert_eq!(emitted[video + 3], "20");
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
                    in_pts: Pts::new(in_pts),
                    out_pts: Pts::new(in_pts + 900_900),
                    // 100000/3 = 33333.333333..., so the seek renders at the full width
                    // `SEEK_DECIMALS` allows.
                    seek_seconds: Rational::new(100_000 + index, 3),
                    audio_in_tick: Some(in_tick),
                    audio_out_tick: Some(in_tick + 4_804_800),
                }
            })
            .collect();
        ExportPlan {
            source: PathBuf::from(WINDOWS_SOURCE),
            destination: PathBuf::from(
                r"C:\Users\alexandra.whitfield\Videos\Exports\grand-final-highlights.mp4",
            ),
            video_stream_index: 1,
            audio: Some(PlannedAudio {
                stream_index: 2,
                sample_rate: 48_000,
            }),
            segments,
            timing: OutputTiming::ConstantFrameRate(
                Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
            ),
            resolution: Some(Resolution { w: 3840, h: 2160 }),
            video_encoder: "hevc_videotoolbox".to_owned(),
            audio_encoder: "aac".to_owned(),
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            container: Container::Mp4,
            total_duration: Rational::new(
                901 * i64::try_from(count).expect("the segment count fits in an i64"),
                30_000,
            )
            .expect("the fixture duration is representable"),
            expected_frames: Some(30 * u64::try_from(count).expect("the count fits in a u64")),
        }
    }

    /// The length of the command line one shape produces for a plan and an output path.
    fn measured_length(plan: &ExportPlan, shape: GraphShape, output: &str) -> usize {
        let graph = build_filter_graph(plan, shape);
        command_line_length(&build_arguments(plan, shape, &graph, Path::new(output)))
    }

    #[test]
    fn a_full_length_plan_on_a_long_windows_path_fits_the_windows_command_line() {
        // This is the test that keeps `MAX_EXPORT_SEGMENTS` and the platform limit from
        // drifting apart. `plan.rs` enforces the cap of 100, but its boundary tests are
        // symbolic -- they would pass at any value -- so nothing else in the crate would notice
        // a raised cap producing a command line Windows refuses to start. ADR 014 chose 100 for
        // this reason and this reason only.
        //
        // Note what is asserted: not that the preferred shape fits, but that the shape
        // `choose_graph_shape` *returns* fits. There is no third shape, so the fallback's own
        // length is the real limit of the renderer.
        //
        // This plan measures 30253 of the 31743 available bytes. Do not read that gap as the
        // margin the cap has: this fixture uses a 106-character path and ordinary encoder
        // names, and the widest plan the settings actually permit needs 31498 at the same
        // count. `the_widest_plan_the_settings_permit_still_fits_at_the_segment_cap` measures
        // that one, and it is the test that justifies the cap. This one is about the realistic
        // case, and about the fallback being reached at all.
        let plan = windows_plan(MAX_EXPORT_SEGMENTS);
        let shape = choose_graph_shape_within(
            &plan,
            Path::new(WINDOWS_OUTPUT),
            WINDOWS_COMMAND_LINE_BUDGET,
        );
        let length = measured_length(&plan, shape, WINDOWS_OUTPUT);
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "{MAX_EXPORT_SEGMENTS} segments as {shape:?} need {length} bytes, over the \
             {WINDOWS_COMMAND_LINE_BUDGET}-byte budget of Windows' {WINDOWS_COMMAND_LINE_LIMIT}"
        );
        // At this size the first shape cannot fit: it repeats a 106-character path 100 times.
        // The fallback is therefore load-bearing at the cap, not a theoretical branch.
        assert_eq!(shape, GraphShape::SingleInput);
        assert!(
            measured_length(&plan, GraphShape::InputPerSegment, WINDOWS_OUTPUT)
                > WINDOWS_COMMAND_LINE_BUDGET
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

    /// The widest plan the settings schema permits, over `count` segments.
    ///
    /// Every dimension is at the maximum `settings::validate_settings` accepts, or at the
    /// widest a real source can make it, so this measures the bound rather than a fixture:
    /// `MAX_PATH` for the source *and* the reservation, [`MAX_ENCODER_NAME_CHARS`] for both
    /// encoder names, `MAX_RESOLUTION_DIMENSION` on both axes, the longest quality argument
    /// (`-b:v 200000k`, the top of the bitrate range), MP4 for its extra `-movflags
    /// +faststart`, an NTSC rate, two-digit stream indices, a 192000 Hz audio rate in the input
    /// pin, eleven-digit PTS values, twelve-digit audio ticks, and a seek that fills every
    /// decimal place [`SEEK_DECIMALS`] allows.
    fn widest_plan(count: usize) -> ExportPlan {
        let segments = (0..count)
            .map(|index| {
                let index = i64::try_from(index).expect("the segment count fits in an i64");
                let in_pts = 10_000_000_000 + index * 100_000_000;
                let in_tick = 100_000_000_000 + index * 1_000_000_000;
                PlannedSegment {
                    in_pts: Pts::new(in_pts),
                    out_pts: Pts::new(in_pts + 900_900),
                    seek_seconds: Rational::new(100_000 + index, 3),
                    audio_in_tick: Some(in_tick),
                    audio_out_tick: Some(in_tick + 4_804_800),
                }
            })
            .collect();
        ExportPlan {
            source: PathBuf::from(longest_windows_path(".mkv")),
            destination: PathBuf::from(longest_windows_path(".mp4")),
            video_stream_index: 10,
            audio: Some(PlannedAudio {
                stream_index: 11,
                sample_rate: 192_000,
            }),
            segments,
            timing: OutputTiming::ConstantFrameRate(
                Rational::new(30_000, 1_001).expect("30000/1001 is a valid rate"),
            ),
            resolution: Some(Resolution {
                w: MAX_RESOLUTION_DIMENSION,
                h: MAX_RESOLUTION_DIMENSION,
            }),
            video_encoder: "a".repeat(MAX_ENCODER_NAME_CHARS),
            audio_encoder: "a".repeat(MAX_ENCODER_NAME_CHARS),
            quality: Quality {
                kind: QualityKind::Bitrate,
                value: 200_000,
            },
            container: Container::Mp4,
            total_duration: Rational::new(
                901 * i64::try_from(count).expect("the segment count fits in an i64"),
                30_000,
            )
            .expect("the fixture duration is representable"),
            expected_frames: Some(30 * u64::try_from(count).expect("the count fits in a u64")),
        }
    }

    #[test]
    fn the_widest_plan_the_settings_permit_still_fits_at_the_segment_cap() {
        // The cap is a byte budget, so the value that justifies it has to be measured against
        // the widest command the settings can produce -- not against a plausible one. This scans
        // for the largest segment count that still fits, on the fixture above, choosing the
        // shape the way production does.
        //
        // Measured at the time of writing: the widest permitted plan needs 31498 of the 31743
        // available bytes at the cap, and 101 segments do not fit. The cap of 100 is therefore
        // exactly the largest value that is safe -- there are 245 bytes of slack, not the
        // thousand a plausible-looking fixture suggests. (A realistic plan on a 106-character
        // path measures 30253 at the same count.) The assertion is one-sided on purpose:
        // shortening the command is welcome and must not fail a test, but a filter added to the
        // graph or a settings maximum raised has to bring the cap down with it, and that is the
        // drift this catches.
        let reservation = longest_windows_path(".mp4.tmp-13724-0");
        let output = Path::new(&reservation);
        let largest = (1..=160)
            .take_while(|count| {
                let plan = widest_plan(*count);
                let shape = choose_graph_shape_within(&plan, output, WINDOWS_COMMAND_LINE_BUDGET);
                let graph = build_filter_graph(&plan, shape);
                command_line_length(&build_arguments(&plan, shape, &graph, output))
                    <= WINDOWS_COMMAND_LINE_BUDGET
            })
            .count();
        assert!(
            largest >= MAX_EXPORT_SEGMENTS,
            "the widest permitted plan fits {largest} segments, under the cap of \
             {MAX_EXPORT_SEGMENTS}; lower the cap or shorten the command"
        );
    }

    #[test]
    fn choose_graph_shape_prefers_one_input_for_each_segment_while_it_fits() {
        // The preferred shape survives a realistic export: a handful of segments on the long
        // Windows path, and on the host's own budget through the public entry point.
        for count in [1, 3, 10] {
            let plan = windows_plan(count);
            assert_eq!(
                choose_graph_shape_within(
                    &plan,
                    Path::new(WINDOWS_OUTPUT),
                    WINDOWS_COMMAND_LINE_BUDGET
                ),
                GraphShape::InputPerSegment,
                "{count} segments"
            );
            assert_eq!(
                choose_graph_shape(&plan, Path::new(WINDOWS_OUTPUT)),
                GraphShape::InputPerSegment,
                "{count} segments"
            );
        }
    }

    #[test]
    fn choose_graph_shape_falls_back_exactly_at_the_budget_and_not_before() {
        // The boundary, measured rather than guessed: the first shape is chosen at a budget of
        // exactly its own length, and one byte less is enough to reject it.
        let plan = windows_plan(20);
        let output = Path::new(WINDOWS_OUTPUT);
        let length = measured_length(&plan, GraphShape::InputPerSegment, WINDOWS_OUTPUT);
        assert_eq!(
            choose_graph_shape_within(&plan, output, length),
            GraphShape::InputPerSegment
        );
        assert_eq!(
            choose_graph_shape_within(&plan, output, length - 1),
            GraphShape::SingleInput
        );
    }

    #[test]
    fn the_fallback_shape_shortens_the_command_line_by_writing_the_path_once() {
        // This is the property `choose_graph_shape` rests on, and the only one it needs: the
        // fallback writes the source path and its input flags once instead of once for each
        // segment, so its command line is the shorter of the two wherever the choice is live.
        //
        // The *graph* half of ADR 014 measurement 15 has since stopped holding. The record says
        // the single-input graph is "the larger of the two at every count", which was true as
        // measured: `split` and `asplit` cost more than the input labels they replace. Commit
        // 79f9918 then added the audio input-rate pin, which `InputPerSegment` pays for on every
        // chain and `SingleInput` pays for once, in front of `asplit`. Measured on this fixture:
        // the single-input graph is larger at 1, 2 and 3 segments and smaller from 4 up --
        // 29804 bytes against 31266 at the cap. No decision changes, because the fallback was
        // never selected for its graph size, but a reader taking the record at face value would
        // mis-predict where the budget goes.
        let plan = windows_plan(MAX_EXPORT_SEGMENTS);
        assert!(
            measured_length(&plan, GraphShape::SingleInput, WINDOWS_OUTPUT)
                < measured_length(&plan, GraphShape::InputPerSegment, WINDOWS_OUTPUT)
        );
        assert!(
            build_filter_graph(&plan, GraphShape::SingleInput).len()
                < build_filter_graph(&plan, GraphShape::InputPerSegment).len(),
            "the reversal described above"
        );
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
}
