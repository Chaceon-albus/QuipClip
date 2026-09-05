//! Render an [`ExportPlan`] into the inline `-filter_complex` graph ADR 014 specifies.
//!
//! [`build_filter_graph`] is pure: it reads a finished plan and returns one string. It runs
//! no process, touches no file, and reads no clock, so every rule ADR 014 settled about the
//! graph is testable without ffmpeg installed -- which is what the pinned-string tests below
//! do, exactly as `capabilities::smoke`'s tests pin ADR 006's two smoke commands verbatim.
//!
//! Four of ADR 014's decisions live here and nowhere else:
//!
//! - Every chain binds an **absolute** stream index, never the short specifier `[i:v]` or
//!   `[i:a]`. A short specifier selects the first stream of its type; the probe selects the
//!   stream carrying the `default` disposition. ADR 014 records a real file where those two
//!   rules disagree -- a non-default AC-3 stream at index 1 beside a default AAC stream at
//!   index 2 -- so `[0:a]` would silently export audio the preview never played, with no
//!   error anywhere. [`ExportPlan::video_stream_index`] and [`PlannedAudio::stream_index`]
//!   carry the indices the probe chose, and this module emits them verbatim.
//! - Every boundary is `start_pts`/`end_pts` in integer ticks, never `start`/`end`. FFmpeg
//!   parses the `start` and `end` options into microseconds, and that truncation loses the
//!   precision ADR 002 protects. The video ticks are the raw source PTS values, correct
//!   under `-copyts` by ADR 014 measurements 1 and 3; the audio ticks are the plan's
//!   precomputed `audio_in_tick`/`audio_out_tick`, so this module performs no timestamp
//!   arithmetic of its own and cannot round anything.
//! - Every audio chain **pins its input link to the source's own sample rate** with an
//!   `aformat` in front of `atrim`. This one looks redundant beside the `aformat` that ends
//!   the same chain, and it is not: see [`audio_input_pin`] for the measurement, and do not
//!   delete it.
//! - The two graph shapes exist because one input for each segment repeats the source path,
//!   and Windows limits a command line to 32767 bytes. [`GraphShape`] names the choice but
//!   does not make it: only the argument builder knows the assembled command's length, so
//!   the caller passes the shape in. Neither shape makes that length independent of the
//!   segment count; see [`GraphShape`] for the measured growth.
//!
//! One filter pair is conditional for a reason that is not about the command line at all:
//! `scale` and `setsar=1` are emitted only for a plan that asks for an explicit resolution.
//! Forcing square pixels on the source-resolution path would squash an anamorphic source
//! against what the preview showed. The comment beside that branch has the measurement.
//!
//! No step here uses floating point. A frame rate renders as `num/den` (ADR 002), so an NTSC
//! rate reaches ffmpeg as the exact `30000/1001`, never a rounded decimal.

use super::{ExportPlan, OutputTiming, PlannedAudio, PlannedSegment};
use crate::project::Resolution;

/// The pixel format every video chain ends in, from ADR 014's chain template.
///
/// `concat` requires every one of its video inputs to agree on pixel format, so each chain
/// normalizes to one before the join rather than relying on the source's own.
const VIDEO_PIXEL_FORMAT: &str = "format=yuv420p";

/// The sample format, sample rate, and channel layout every audio chain ends in, from ADR
/// 014's chain template.
///
/// The `48000` here is the *output* rate `concat` receives, and it is deliberately a
/// constant rather than [`PlannedAudio::sample_rate`]: that field is the unit the plan's
/// audio ticks are measured in (the source stream's own rate, which ADR 014 measurement 4
/// found at 44100, 48000, and 32000 Hz), not a target. `concat` requires its audio inputs to
/// agree, so each chain resamples to this one rate; the ticks stay in the source's rate
/// because that is the unit `atrim` reads them in. The test fixtures deliberately use a
/// 44100 Hz source so the two numbers can never be confused for each other.
///
/// This is not the same `aformat` as [`audio_input_pin`], which carries the *source* rate and
/// stands at the head of the chain. Both are needed, for opposite reasons: this one converts
/// the cut audio to the one rate `concat` joins at; that one stops ffmpeg from converting
/// the audio *before* the cut, which would read the boundary ticks in the wrong unit.
const AUDIO_SAMPLE_FORMAT: &str =
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/// Which of ADR 014's two graph shapes to render.
///
/// This module never selects between them. The choice depends on the length of the whole
/// assembled command line, and only the argument builder can measure that. Passing the
/// decision in keeps this function pure and keeps the budget arithmetic in the one place
/// that has the whole command.
///
/// **Neither shape makes the command line independent of the segment count.** ADR 014
/// measurement 15 has the figures: the graph grows by about the same amount for each added
/// segment under *both* shapes, and the `SingleInput` graph is the larger of the two at
/// every count, because the `split` and `asplit` chains cost more than the input specifiers
/// they replace. What `SingleInput` saves lies outside the graph -- it writes the source
/// path once instead of once for each segment -- so it extends the reachable segment count
/// without removing the growth. ADR 014's "graph shape" section draws the conclusion this
/// module cannot: the segment cap, not the shape, is what keeps an export inside Windows'
/// 32767-byte limit, and a larger export needs the version-gated `-/filter_complex <file>`
/// form that measurement 13 rules out for the inline path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphShape {
    /// One `-i` for each segment: chain `i` reads input `i`, so no splitter is needed.
    ///
    /// This is the shape ADR 014 prefers, and measurement 14 supports it: runs with 8, 32,
    /// and 64 inputs of one file produced exactly the expected frame counts, and the largest
    /// used 20 MB of memory. Many inputs are cheap. Their only cost is that each one repeats
    /// the source path and its flags on the command line.
    InputPerSegment,
    /// One `-i` for the whole source, divided among the chains by `split` and `asplit`.
    ///
    /// The graph this renders is slightly *larger* than `InputPerSegment`'s at the same
    /// segment count; what it saves is the repeated input path and flags around it. It needs
    /// the single seek [`ExportPlan::single_input_seek_seconds`] returns, not any one
    /// segment's own.
    SingleInput,
}

/// Render `plan` as the one-line `-filter_complex` argument for the requested shape.
///
/// The result is a single line: chains separated by `;`, with no newline and no trailing
/// separator, so the caller passes it to ffmpeg as one argument unchanged. ADR 014
/// measurement 13 rules out the alternative of writing the graph to a file --
/// `-filter_complex_script` does not exist in ffmpeg 9.0.1, its replacement `-/filter_complex`
/// did not exist before 7.1, and no single spelling works on every version a user can have.
///
/// The chains appear in `plan.segments` order, which is concat order, and the `concat` filter
/// consumes them in that same order. ADR 007 makes the project's array order authoritative
/// and forbids sorting it; concat order need not match source-PTS order, and nothing here
/// sorts or deduplicates.
///
/// # Preconditions
///
/// `plan.segments` must not be empty. [`build_plan`](super::plan::build_plan) rejects an
/// empty request with [`ExportErrorCode::NoSegments`](super::ExportErrorCode::NoSegments),
/// so an empty plan cannot arise from it, and a debug assertion catches a hand-built one:
/// the graph it would otherwise render carries `concat=n=0` (and `split=0` under
/// [`GraphShape::SingleInput`]), which ffmpeg rejects.
///
/// # Audio
///
/// A plan with no audio produces no audio anywhere: no `atrim` chain, no `asplit`, `a=0` on
/// `concat`, and `[v]` as the only output label. ADR 014 records why version 1 needs no
/// silence generation here -- it exports one source, so a segment without audio cannot occur
/// between segments with audio -- and ADR 004's silence generation belongs to the
/// multi-source work.
///
/// This function treats audio as one decision for the whole graph rather than one per
/// segment. [`build_plan`](super::plan::build_plan) is the only producer of an
/// [`ExportPlan`], and it fills every segment's audio ticks exactly when
/// [`ExportPlan::audio`] is `Some`, so a plan carrying an audio stream but a segment without
/// ticks cannot arise from it; a debug assertion catches a hand-built one. Neither branch
/// would export successfully if it ever did arise, and the fallback is not the safe one of
/// the two -- it only moves where the failure lands. Writing the audio chains anyway
/// produces a graph whose `concat=a=1` flag disagrees with its inputs, which ffmpeg rejects
/// while parsing; falling back to video only produces a graph with no `[a]` label while the
/// argument builder still emits `-map "[a]"` and `-c:a` from a `plan.audio` that is still
/// `Some`, which ffmpeg rejects when it resolves the map. The debug assertion, not the
/// fallback, is what actually reports the condition.
#[must_use]
pub fn build_filter_graph(plan: &ExportPlan, shape: GraphShape) -> String {
    debug_assert!(
        !plan.segments.is_empty(),
        "an export plan must carry at least one segment"
    );
    let audio = resolve_audio(plan);
    debug_assert!(
        plan.audio.is_none() || audio.is_some(),
        "a plan that declares an audio stream must carry audio ticks on every segment"
    );

    let count = plan.segments.len();
    let mut chains: Vec<String> = Vec::new();

    if shape == GraphShape::SingleInput {
        chains.push(splitter_chain(
            plan.video_stream_index,
            "",
            "split",
            "sv",
            count,
        ));
        if let Some((planned, _)) = &audio {
            // The rate pin goes in front of `asplit`, not on each branch behind it: this
            // chain's head *is* the input link, so one filter pins it directly. See
            // `audio_input_pin`.
            chains.push(splitter_chain(
                planned.stream_index,
                &audio_input_pin(*planned),
                "asplit",
                "sa",
                count,
            ));
        }
    }

    for (index, segment) in plan.segments.iter().enumerate() {
        chains.push(video_chain(plan, shape, index, *segment));
        if let Some((planned, ticks)) = &audio {
            chains.push(audio_chain(*planned, shape, index, ticks[index]));
        }
    }

    chains.push(concat_chain(count, audio.is_some()));
    chains.join(";")
}

/// Pair the plan's audio stream with every segment's tick boundary, or report no audio.
///
/// The `collect` into an `Option<Vec<_>>` is the whole-graph decision described on
/// [`build_filter_graph`]: one segment missing a tick means no audio anywhere, never a
/// half-written audio path.
fn resolve_audio(plan: &ExportPlan) -> Option<(PlannedAudio, Vec<(i64, i64)>)> {
    let planned = plan.audio?;
    let ticks: Option<Vec<(i64, i64)>> = plan
        .segments
        .iter()
        .map(|segment| segment.audio_in_tick.zip(segment.audio_out_tick))
        .collect();
    Some((planned, ticks?))
}

/// Render the `split`/`asplit` chain that feeds every segment chain from one input.
///
/// `pin` is inserted between the input link and the splitter, already carrying its own
/// trailing comma, or is empty. Only the audio splitter uses it, for
/// [`audio_input_pin`]'s reason; the video link has no equivalent hazard, because ADR 014
/// measurement 3 found the video input link time base equal to the video stream's own with
/// or without a seek.
fn splitter_chain(stream_index: u32, pin: &str, filter: &str, label: &str, count: usize) -> String {
    let outputs: String = (0..count)
        .map(|index| format!("[{label}{index}]"))
        .collect();
    format!("[0:{stream_index}]{pin}{filter}={count}{outputs}")
}

/// Render the `aformat` that holds an audio **input** link at the source's own sample rate,
/// with the trailing comma that joins it to the filter behind it.
///
/// This is the one filter in the graph that exists to defeat an ffmpeg behaviour rather than
/// to express a decision, so it reads as redundant beside [`AUDIO_SAMPLE_FORMAT`] at the end
/// of the same chain. It is not. **Deleting it silently desynchronizes every export that
/// seeks.**
///
/// ADR 014 measurement 17 has the behaviour. FFmpeg negotiates one sample rate over a filter
/// link, and it configures an input's audio buffer source at whatever the link settles on.
/// With no `-ss`, that is the source stream's own rate. With `-ss` -- which ADR 014's "The
/// seek" puts on almost every export -- the negotiation instead pulls the *output* rate
/// backwards through the graph, out of [`AUDIO_SAMPLE_FORMAT`]'s `48000`, and the input
/// arrives already resampled. The `atrim` boundaries do not follow: the plan computes them as
/// `round(pts * videoTimeBase * sampleRate)` in the source's rate, and `atrim` reads them in
/// whatever unit its input link happens to use. On the measured 44100 Hz source,
/// `start_pts=441000` therefore means 10 s without the seek and 9.1875 s with it -- the cut
/// starts early, and the segment loses length in proportion to its position in the source. A
/// 1.000000 s segment measured 0.918750 s.
///
/// Nothing downstream can catch that. The video frame count is untouched, so ADR 014's
/// `frameCountMismatch` guard passes, ffmpeg exits zero, and the export ships with the audio
/// seconds out of step with the picture. A 48000 Hz source hides the fault completely,
/// because the two rates agree.
///
/// Pinning the link to [`PlannedAudio::sample_rate`] restores the boundary: the constraint
/// applies to this filter's *input* link as well as its output, so it reaches back to the
/// buffer source and the ticks are read in the unit they were computed in. The pin therefore
/// has to sit on the input link itself -- in front of `atrim`, and in front of `asplit` under
/// [`GraphShape::SingleInput`] rather than on the branches behind it, which is also one
/// filter instead of one for each segment.
fn audio_input_pin(audio: PlannedAudio) -> String {
    format!("aformat=sample_rates={},", audio.sample_rate)
}

/// Render one segment's video chain, from its input link to its `[v<index>]` output label.
fn video_chain(
    plan: &ExportPlan,
    shape: GraphShape,
    index: usize,
    segment: PlannedSegment,
) -> String {
    let source = match shape {
        GraphShape::InputPerSegment => format!("[{index}:{}]", plan.video_stream_index),
        GraphShape::SingleInput => format!("[sv{index}]"),
    };
    // ADR 014's "Output timing": version 1 always writes constant-frame-rate output, because
    // `concat` needs one frame rate and a variable-frame-rate source has none. The decision
    // also requires a later variable-frame-rate mode to be an addition, and this `match` is
    // where it lands: that mode omits the `fps` filter instead of choosing a different rate,
    // so the choice cannot be a rate lookup on an unconditional filter.
    let timing = match plan.timing {
        OutputTiming::ConstantFrameRate(rate) => format!(",fps={}/{}", rate.num(), rate.den()),
    };
    // `scale` and `setsar=1` travel together, and a plan that keeps the source resolution
    // emits neither of them.
    //
    // `setsar=1` overwrites the sample aspect ratio; it does not preserve it. ADR 014
    // measurement 16 has the case: on a source that does not have square pixels the filter
    // compresses the picture horizontally, and omitting it keeps the source's own display
    // aspect. The preview element honours that display aspect, so an export that normalized
    // SAR here would not look like what the user marked, and nothing would report an error:
    // the same silent-mismatch failure ADR 014 forbids for audio stream selection, applied
    // to geometry. This is the default path, not an edge case -- both shipped presets use
    // `ResolutionSetting::Source`, which `plan.rs` maps to `None`.
    //
    // Version 1 exports one source, so every chain already carries that source's own SAR and
    // `concat` has nothing to reconcile. With an explicit resolution the filter is correct
    // and necessary: `scale` keeps the source SAR, which would then describe the wrong
    // geometry at the new pixel dimensions.
    let scale = match plan.resolution {
        Some(Resolution { w, h }) => format!(",scale={w}:{h},setsar=1"),
        None => String::new(),
    };
    let head = format!(
        "{source}trim=start_pts={}:end_pts={},setpts=PTS-STARTPTS",
        segment.in_pts.value(),
        segment.out_pts.value()
    );
    let tail = format!(",{VIDEO_PIXEL_FORMAT}[v{index}]");
    format!("{head}{timing}{scale}{tail}")
}

/// Render one segment's audio chain, from its input link to its `[a<index>]` output label.
///
/// Under [`GraphShape::InputPerSegment`] this chain starts at an input link, so it carries
/// [`audio_input_pin`] itself. Under [`GraphShape::SingleInput`] it starts behind `asplit`,
/// and the splitter chain already pinned the one input link they share; repeating the pin
/// here would only add a filter for each segment to a graph ADR 014 measurement 15 already
/// counts in bytes against the Windows command-line limit.
fn audio_chain(audio: PlannedAudio, shape: GraphShape, index: usize, ticks: (i64, i64)) -> String {
    let source = match shape {
        GraphShape::InputPerSegment => {
            format!("[{index}:{}]{}", audio.stream_index, audio_input_pin(audio))
        }
        GraphShape::SingleInput => format!("[sa{index}]"),
    };
    let (in_tick, out_tick) = ticks;
    let head = format!("{source}atrim=start_pts={in_tick}:end_pts={out_tick}");
    format!("{head},asetpts=PTS-STARTPTS,{AUDIO_SAMPLE_FORMAT}[a{index}]")
}

/// Render the closing `concat` filter and the graph's output labels.
fn concat_chain(count: usize, has_audio: bool) -> String {
    let inputs: String = (0..count)
        .map(|index| {
            if has_audio {
                format!("[v{index}][a{index}]")
            } else {
                format!("[v{index}]")
            }
        })
        .collect();
    let audio_streams = u8::from(has_audio);
    let outputs = if has_audio { "[v][a]" } else { "[v]" };
    format!("{inputs}concat=n={count}:v=1:a={audio_streams}{outputs}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Container, Quality, QualityKind};
    use crate::time::{Pts, Rational};
    use std::path::PathBuf;

    /// The three fixture segments, in concat order.
    ///
    /// The numbers describe one real source: ADR 014 measurement 6's constant-frame-rate
    /// MP4, whose video time base is 1/12800, cut against a **44100 Hz** audio stream. One
    /// audio tick is therefore `pts * 441 / 128`, and 148480 is the exact PTS (11.6 s) that
    /// measurement's accurate seek returned. Every boundary is a whole 25 fps frame, 512
    /// ticks apart, so a fixture number can never accidentally be a rounded one.
    ///
    /// Two properties of this fixture are load-bearing, not decoration:
    ///
    /// - The source rate is 44100, while `AUDIO_SAMPLE_FORMAT` pins the output rate at
    ///   48000. Replacing that constant with [`PlannedAudio::sample_rate`] therefore changes
    ///   every pinned string below, instead of passing unnoticed as it would if the fixture
    ///   also ran at 48000. The same gap is what makes [`audio_input_pin`] visible at all:
    ///   its `44100` and the chain's closing `48000` are two different rates in one chain,
    ///   and a 48000 Hz fixture would render them identically -- which is exactly why the
    ///   fault ADR 014 measurement 17 records reached a shipped graph unseen.
    /// - Element 1 starts *earlier* in the source than element 0. ADR 007 makes array order
    ///   authoritative and forbids sorting; a builder that sorted by `in_pts` would reorder
    ///   this fixture and change every pinned string of two or more segments.
    fn fixture_segments(count: usize) -> Vec<PlannedSegment> {
        [
            segment(148_480, 151_552, 511_560, 522_144),
            segment(128_000, 134_144, 441_000, 462_168),
            segment(256_000, 262_144, 882_000, 903_168),
        ][..count]
            .to_vec()
    }

    /// One planned segment. `seek_seconds` is filled with a plausible value the graph must
    /// ignore: the seek belongs on the command line, never inside a filter chain.
    fn segment(
        in_pts: i64,
        out_pts: i64,
        audio_in_tick: i64,
        audio_out_tick: i64,
    ) -> PlannedSegment {
        PlannedSegment {
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
            seek_seconds: Rational::new(33, 5),
            audio_in_tick: Some(audio_in_tick),
            audio_out_tick: Some(audio_out_tick),
        }
    }

    /// A plan over the first `count` fixture segments: video stream 1, audio stream 2 at
    /// 44100 Hz, 25 fps, and the source's own resolution.
    ///
    /// Neither stream index is the one a short specifier would bind. `[0:v]` and `[0:a]`
    /// would both resolve to stream 0 on a file laid out this way, so a chain that used a
    /// short specifier, or hardcoded index 1 for audio, fails every pinned string below.
    fn fixture_plan(count: usize) -> ExportPlan {
        let frames = 6 + 12 * (count - 1);
        ExportPlan {
            source: PathBuf::from("/media/source.mp4"),
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

    #[test]
    fn one_input_per_segment_renders_one_segment_as_a_single_chain_pair() {
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn one_input_per_segment_gives_the_second_segment_its_own_input_index() {
        let graph = build_filter_graph(&fixture_plan(2), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn one_input_per_segment_keeps_input_and_label_numbering_aligned_across_three_segments() {
        let graph = build_filter_graph(&fixture_plan(3), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[2:1]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v2];",
                "[2:2]aformat=sample_rates=44100,atrim=start_pts=882000:end_pts=903168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2];",
                "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn a_single_input_still_splits_for_one_segment() {
        // A one-output `split` is a pass-through, and emitting it keeps one rule for every
        // segment count: chain `i` always reads `[sv<i>]`. A special case for `n = 1` would
        // buy nothing and would give the argument builder a second shape to reason about.
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[0:1]split=1[sv0];",
                "[0:2]aformat=sample_rates=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn a_single_input_feeds_two_segments_through_one_split_and_one_asplit() {
        let graph = build_filter_graph(&fixture_plan(2), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn a_single_input_keeps_split_and_chain_labels_aligned_across_three_segments() {
        let graph = build_filter_graph(&fixture_plan(3), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[0:1]split=3[sv0][sv1][sv2];",
                "[0:2]aformat=sample_rates=44100,asplit=3[sa0][sa1][sa2];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[sv2]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v2];",
                "[sa2]atrim=start_pts=882000:end_pts=903168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2];",
                "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn the_chains_follow_array_order_not_source_pts_order() {
        // ADR 007 makes the project's array order authoritative and forbids sorting it. The
        // fixture's second element starts earlier in the source than its first, so a builder
        // that sorted by `in_pts` would emit these three boundaries in a different order --
        // and would silently reorder the user's export.
        let graph = build_filter_graph(&fixture_plan(3), GraphShape::InputPerSegment);
        let first = graph.find("start_pts=148480").expect("segment 0");
        let second = graph.find("start_pts=128000").expect("segment 1");
        let third = graph.find("start_pts=256000").expect("segment 2");
        assert!(first < second, "array order must survive: {graph}");
        assert!(second < third, "array order must survive: {graph}");
    }

    #[test]
    fn the_audio_output_rate_is_a_constant_not_the_sources_tick_rate() {
        // The fixture's audio stream runs at 44100 Hz, so its ticks are in 1/44100 units,
        // while ADR 014's chain template resamples every chain to 48000 Hz for `concat`.
        // Swapping `AUDIO_SAMPLE_FORMAT`'s constant for `PlannedAudio::sample_rate` would keep
        // the ticks correct and still produce the wrong output rate. The chain now carries the
        // source rate too, in `audio_input_pin` at its head, so this asserts the two rates by
        // position rather than by presence: 44100 in front of the cut, 48000 behind it.
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::InputPerSegment);
        assert!(
            graph.contains("aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144"),
            "{graph}"
        );
        assert!(
            graph.contains("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"),
            "{graph}"
        );
        assert!(
            !graph.contains("sample_rates=44100:channel_layouts"),
            "{graph}"
        );
    }

    #[test]
    fn the_audio_input_link_is_pinned_to_the_source_rate_in_both_shapes() {
        // The test class ADR 014's consequences ask for: a fixture that is not 48000 Hz.
        //
        // Measurement 17. An input seek makes ffmpeg configure that input's audio at the rate
        // the graph negotiates for its *output*, pulled backwards out of `AUDIO_SAMPLE_FORMAT`.
        // `atrim` then reads the plan's source-rate ticks as 48000ths: on this 44100 Hz
        // fixture `start_pts=441000` means 9.1875 s instead of 10 s, and a 1.000000 s segment
        // exports 0.918750 s of audio, starting in the wrong place, with the error growing
        // with the segment's position in the source. The video frame count is untouched, so
        // ADR 014's `frameCountMismatch` guard cannot see it and the export exits zero.
        //
        // Only a source whose rate differs from 48000 can show the fault, which is why this
        // asserts the fixture's rate first: at 48000 the two rates agree and every assertion
        // below would still pass with the pin deleted.
        let plan = fixture_plan(2);
        assert_eq!(plan.audio.expect("fixture audio").sample_rate, 44_100);

        // One input for each segment: every chain begins at an input link of its own, so
        // every chain carries the pin.
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert!(
            graph.contains("[0:2]aformat=sample_rates=44100,atrim="),
            "{graph}"
        );
        assert!(
            graph.contains("[1:2]aformat=sample_rates=44100,atrim="),
            "{graph}"
        );

        // One input: the chains begin behind `asplit`, so the pin belongs on the single input
        // link in front of it. That is the link ffmpeg configures the buffer source from, and
        // one filter covers every branch instead of one for each segment.
        let graph = build_filter_graph(&plan, GraphShape::SingleInput);
        assert!(
            graph.contains("[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];"),
            "{graph}"
        );
        assert_eq!(graph.matches("sample_rates=44100").count(), 1, "{graph}");
        assert!(graph.contains("[sa0]atrim=start_pts=511560"), "{graph}");
        assert!(graph.contains("[sa1]atrim=start_pts=441000"), "{graph}");
    }

    #[test]
    fn the_input_pin_renders_the_plans_own_rate_not_the_fixtures() {
        // ADR 014 measurement 4 met source rates of 44100, 48000, and 32000 Hz. A pin that
        // spelled a literal 44100 would satisfy every other test in this module and would
        // still misread a 32000 Hz source's boundaries, by the mechanism the pin exists to
        // stop. The ticks here are that source's own: 148480 and 151552 at time base 1/12800
        // are 11.6 s and 11.84 s, which are 371200 and 378880 ticks at 32000 Hz.
        let mut plan = fixture_plan(1);
        plan.audio = Some(PlannedAudio {
            stream_index: 2,
            sample_rate: 32_000,
        });
        plan.segments[0].audio_in_tick = Some(371_200);
        plan.segments[0].audio_out_tick = Some(378_880);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=32000,atrim=start_pts=371200:end_pts=378880,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:1]split=1[sv0];",
                "[0:2]aformat=sample_rates=32000,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sa0]atrim=start_pts=371200:end_pts=378880,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn a_plan_without_audio_renders_no_audio_chain_and_one_output_label() {
        let mut plan = fixture_plan(2);
        plan.audio = None;
        for segment in &mut plan.segments {
            segment.audio_in_tick = None;
            segment.audio_out_tick = None;
        }
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[v0][v1]concat=n=2:v=1:a=0[v]",
            )
        );
    }

    #[test]
    fn a_single_input_without_audio_emits_no_asplit() {
        let mut plan = fixture_plan(2);
        plan.audio = None;
        for segment in &mut plan.segments {
            segment.audio_in_tick = None;
            segment.audio_out_tick = None;
        }
        let graph = build_filter_graph(&plan, GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[0:1]split=2[sv0][sv1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v1];",
                "[v0][v1]concat=n=2:v=1:a=0[v]",
            )
        );
        assert!(!graph.contains("asplit"));
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "audio ticks on every segment")]
    fn a_plan_that_declares_audio_but_lost_a_segments_ticks_trips_the_debug_assertion() {
        // `build_plan` cannot produce this state; it fills every segment's ticks exactly
        // when the plan carries audio. Neither rendering choice would export successfully if
        // it ever did arise -- see `build_filter_graph`'s doc -- so the assertion is the
        // report, and the video-only fallback a release build takes is only the quieter of
        // two failures. This test is compiled out of a release build, where that fallback is
        // what happens instead.
        let mut plan = fixture_plan(2);
        plan.segments[1].audio_out_tick = None;
        let _ = build_filter_graph(&plan, GraphShape::InputPerSegment);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "at least one segment")]
    fn an_empty_plan_trips_the_debug_assertion() {
        // `build_plan` returns `NoSegments` for an empty request, so this is unreachable
        // through the pipeline. Rendered anyway it would produce `concat=n=0`, which ffmpeg
        // rejects.
        let mut plan = fixture_plan(1);
        plan.segments.clear();
        let _ = build_filter_graph(&plan, GraphShape::InputPerSegment);
    }

    #[test]
    fn a_source_resolution_plan_carries_neither_scale_nor_setsar() {
        // `setsar=1` overwrites the sample aspect ratio rather than preserving it, so on a
        // source without square pixels it yields a squashed picture the preview never showed
        // and no error would report -- ADR 014 measurement 16. Both shipped presets keep the
        // source resolution, so this is the default path, not an edge case.
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
        assert!(!graph.contains("scale="), "{graph}");
        assert!(!graph.contains("setsar"), "{graph}");
    }

    #[test]
    fn an_explicit_resolution_emits_scale_immediately_before_setsar() {
        let mut plan = fixture_plan(1);
        plan.resolution = Some(Resolution { w: 1920, h: 1080 });
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "scale=1920:1080,setsar=1,format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
        assert!(graph.contains("scale=1920:1080,setsar=1"), "{graph}");
    }

    #[test]
    fn an_ntsc_frame_rate_renders_as_an_exact_fraction_not_a_decimal() {
        let mut plan = fixture_plan(1);
        plan.timing = OutputTiming::ConstantFrameRate(Rational::new(30_000, 1001).unwrap());
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,",
                "fps=30000/1001,format=yuv420p[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
        // 30000/1001 has no terminating decimal expansion, so any rounded spelling of it
        // reaches ffmpeg as a different frame rate than the plan resolved.
        assert!(!graph.contains("29.97"), "{graph}");
    }

    #[test]
    fn every_chain_names_the_stream_index_the_probe_chose_in_both_shapes() {
        // ADR 014's real disagreement case: the default audio stream is not the first audio
        // stream. A hardcoded 1, or the short specifier `[0:a]`, would bind the wrong stream
        // and export audio the preview never played, with no error reported anywhere.
        let mut plan = fixture_plan(1);
        plan.video_stream_index = 2;
        plan.audio = Some(PlannedAudio {
            stream_index: 5,
            sample_rate: 44_100,
        });
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[0:2]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[0:5]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]split=1[sv0];",
                "[0:5]aformat=sample_rates=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "format=yuv420p[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[v][a]",
            )
        );
    }

    #[test]
    fn no_graph_uses_a_short_specifier_or_a_microsecond_trim_boundary() {
        // The mistakes ADR 014 forbids by name. A short specifier binds the first stream of
        // its type instead of the one the probe selected. `start=` and `end=` -- as opposed
        // to `start_pts=` and `end_pts=` -- parse into microseconds, which truncates away the
        // precision ADR 002 protects, and either end of the boundary can be mistyped
        // independently. This test is deliberately separate from the pinned strings above:
        // it still fails if someone updates every expected string to match a regression.
        let mut scaled = fixture_plan(3);
        scaled.resolution = Some(Resolution { w: 1280, h: 720 });
        let mut silent = fixture_plan(3);
        silent.audio = None;

        for plan in [fixture_plan(3), scaled, silent] {
            for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                let graph = build_filter_graph(&plan, shape);
                assert!(!graph.contains("[0:v]"), "short video specifier in {graph}");
                assert!(!graph.contains("[0:a]"), "short audio specifier in {graph}");
                assert!(
                    !graph.contains("trim=start="),
                    "truncating start in {graph}"
                );
                assert!(
                    !graph.contains("atrim=start="),
                    "truncating astart in {graph}"
                );
                assert!(!graph.contains(":end="), "truncating end in {graph}");
                // The same guard for the rate pin. A chain that cuts audio without it reads
                // its boundary ticks in the output's rate after a seek (measurement 17), and
                // no later stage of the export reports that.
                assert!(
                    plan.audio.is_none() || graph.contains("aformat=sample_rates=44100,"),
                    "unpinned audio input link in {graph}"
                );
            }
        }
    }

    #[test]
    fn the_graph_is_one_line_with_no_trailing_separator() {
        for count in 1..=3 {
            for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                let graph = build_filter_graph(&fixture_plan(count), shape);
                assert!(!graph.contains('\n'), "newline in {graph}");
                assert!(!graph.ends_with(';'), "trailing separator in {graph}");
                assert!(!graph.contains(";;"), "empty chain in {graph}");
            }
        }
    }
}
