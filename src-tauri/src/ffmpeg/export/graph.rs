//! Render an [`ExportPlan`] into the inline `-filter_complex` graph ADR 014 specifies.
//!
//! [`build_filter_graph`] is pure: it reads a finished plan and returns one string. It runs
//! no process, touches no file, and reads no clock, so every rule ADR 014 settled about the
//! graph is testable without ffmpeg installed -- which is what the pinned-string tests below
//! do, exactly as `capabilities::smoke`'s tests pin ADR 006's two smoke commands verbatim.
//!
//! Six of ADR 014's decisions live here and nowhere else:
//!
//! - Every chain binds an **absolute** stream index, never the short specifier `[i:v]` or
//!   `[i:a]`. A short specifier selects the first stream of its type; the probe selects the
//!   stream carrying the `default` disposition. ADR 014 records a real file where those two
//!   rules disagree -- a non-default AC-3 stream at index 1 beside a default AAC stream at
//!   index 2 -- so `[0:a]` would silently export audio the preview never played, with no
//!   error anywhere. [`PlannedVideo::stream_index`] and [`PlannedAudio::stream_index`]
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
//! - The one exception to the rules of this list and the next two is a chain of an audio stream
//!   that holds no packets. It reads no input: it generates the silence of its segment, at the
//!   length and in the output format of every other chain. See [`audio_silence_chain`].
//! - Every audio chain **starts its audio at the segment's In point**, not at its first
//!   sample: it subtracts the In tick, and an `aresample` fills a late start and a gap with
//!   silence. A source whose audio starts after the In point otherwise plays early against its
//!   video; see [`audio_chain`] for the measurement.
//! - Every audio chain that `concat` does not pad **ends at the segment's length**: the last
//!   chain of a graph with video, and every chain of a graph without video, pad their audio with
//!   silence to the planned tick length. A segment that lies wholly before the first audio sample
//!   or wholly after the last one otherwise writes no audio at all; see [`audio_end_pad`]. Every
//!   chain of the audio process of an export with video is cut to that length as well; see
//!   [`audio_exact_end`].
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
//! One filter stands outside every chain: the `format` that sets the output pixel format reads
//! the output of `concat` once, where ADR 014's chain template first ended each chain with it.
//! The reason is the command-line budget. Its chain comes **first** in the graph text, and that
//! position is what keeps the output the same; see [`video_output_format`].
//!
//! No step here uses floating point. A frame rate renders as `num/den` (ADR 002), so an NTSC
//! rate reaches ffmpeg as the exact `30000/1001`, never a rounded decimal.

use super::{ExportPlan, OutputTiming, PlannedAudio, PlannedSegment, PlannedVideo};
use crate::project::Resolution;
use crate::settings::AudioChannels;

/// Render the one `format` filter of the graph: from the joined video at `[vc]` to the graph's
/// `[v]` output label, at `pixel_format`, which is [`PlannedVideo::pixel_format`].
///
/// `settings::validate_settings` holds the name to `[a-z0-9_]`, so it cannot change the graph
/// around it.
///
/// [`build_filter_graph`] writes this as the **first** chain of the graph, ahead of every
/// segment chain and of the `concat` that writes `[vc]`. A chain can read a label that a later
/// chain writes. Do not move this chain to the end of the graph, beside the `concat` it reads.
///
/// ADR 014's chain template ended every video chain in `format=yuv420p`, in front of `concat`.
/// One filter behind `concat` writes the same output, and the position in the text is why.
/// A `format` filter never converts anything: it only narrows the formats its link can carry,
/// and ffmpeg inserts a converter wherever two filters cannot agree. `concat` holds one format
/// list for its video output and every video input together, and ffmpeg merges the lists link
/// by link, in the order the filters appear in the graph text. With this chain first, the target
/// format reaches that shared list before any decoded format does, so each input whose format
/// differs is converted once, in front of `concat`, as the filter in each chain converted it.
/// With this chain last, the decoded format of one segment could reach the shared list first. A
/// segment decoded in another format was then converted to that format in front of `concat`,
/// and everything was converted again behind it. That needs segments that decode to different
/// formats, such as a source joined from parts in different formats, and the measurement found
/// it only on the source-resolution path: an explicit resolution's `scale` converts straight to
/// the target.
///
/// This depends on ffmpeg's negotiation order, which ffmpeg does not document as a contract. A
/// measurement on ffmpeg 9.0.2 (ADR 014, measurement 19) covers it: the framemd5 hashes of the video and of the audio are
/// identical between this graph and a `format` in each chain, on ADR 014's six fixtures, on a
/// 10-bit 4:2:2 source, and on sources that decode to different formats in different segments
/// (4:2:2 beside 4:2:0, and 10-bit beside 8-bit), in both [`GraphShape`] variants, with and
/// without `scale`. `the_pixel_format_chain_is_the_first_chain_of_every_graph` pins the position.
///
/// The reason for one filter is the command-line budget, not the graph. A filter in each chain
/// costs its bytes once for each segment, and at [`super::MAX_EXPORT_SEGMENTS`] the widest
/// command the settings permit had 130 bytes of slack left on Windows. `,format=yuv420p` took
/// 1500 bytes at the cap, and a 10-bit name such as `yuv420p10le` would take 400 more. As one
/// chain, the filter and its label cost 23 bytes at `yuv420p`, whatever the segment count.
fn video_output_format(pixel_format: &str) -> String {
    format!("[vc]format={pixel_format}[v]")
}

/// Render the `aformat` every audio chain ends in: the sample format, the plan's output rate,
/// and the plan's channel layout, from ADR 014's chain template as ADR 023 amends it.
///
/// The rate here is [`PlannedAudio::output_sample_rate`], the *output* rate `concat`
/// receives, and never [`PlannedAudio::sample_rate`]: that field is the unit the plan's audio
/// ticks are measured in (the source stream's own rate, which ADR 014 measurement 4 found at
/// 44100, 48000, and 32000 Hz), not a target. The two are equal whenever the output rate
/// matches the source rate: always for a preset that asks for the source rate, which
/// [`super::plan::build_plan`] has already resolved to a number, and also for a fixed rate
/// that happens to match, such as the legacy 48000 Hz on a 48000 Hz source. The test fixtures deliberately use a 44100 Hz source with a 48000 Hz output, so the
/// two numbers can never be confused for each other.
///
/// Every chain reads the same audio stream, or generates silence in one layout
/// ([`audio_silence_chain`]), and renders this same filter, so every chain ends at one rate and
/// with one layout, and `concat` still receives inputs that agree. For
/// [`AudioChannels::Source`] the filter names no channel layout at all, so each chain keeps
/// the source stream's layout; ADR 023 measurement 3 found that ffmpeg then converts in front
/// of an encoder that cannot take that layout, so no filter here depends on the encoder.
///
/// The filter spells its options by their short names: `f` for `sample_fmts`, `r` for
/// `sample_rates`, and `cl` for `channel_layouts`. ffmpeg declares each short name as a second
/// entry for the same option field, so the filter is the same filter, and a 48000 Hz stereo
/// chain renders `aformat=f=fltp:r=48000:cl=stereo` for the constant ADR 014 fixed as
/// `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`. The reason is the
/// command-line budget: this filter is in every chain, and the short names take 34 bytes from
/// each one with a channel layout, which pays for the filter [`audio_gap_fill`] adds to each
/// chain. The short names exist from ffmpeg 4.3 on; ffmpeg 4.2 does not know them and refuses
/// the graph.
///
/// This is not the same `aformat` as [`audio_input_pin`], which carries the *source* rate and
/// stands at the head of the chain. Both are needed, for opposite reasons: this one converts
/// the cut audio to the one format `concat` joins at; that one stops ffmpeg from converting
/// the audio *before* the cut, which would read the boundary ticks in the wrong unit.
pub(crate) fn audio_output_format(audio: &PlannedAudio) -> String {
    let layout = match audio.output_channels {
        AudioChannels::Source => "",
        AudioChannels::Stereo => ":cl=stereo",
        AudioChannels::Mono => ":cl=mono",
    };
    format!("aformat=f=fltp:r={}{layout}", audio.output_sample_rate)
}

/// Which of ADR 014's two graph shapes to render: one input for each segment, or one input.
///
/// This module never selects between them. The choice depends on the length of the whole
/// assembled command line, and only the argument builder can measure that. Passing the
/// decision in keeps this function pure and keeps the budget arithmetic in the one place
/// that has the whole command.
///
/// **Neither shape makes the command line independent of the segment count.** ADR 014
/// measurement 15 has the figures: the graph grows by about the same amount for each added
/// segment under *both* shapes. The two graphs changed places after measurement 17 added the
/// input rate pin, which costs one filter for each audio chain under `InputPerSegment` and
/// exactly one filter in front of `asplit` under `SingleInput`. `SingleInput` therefore holds
/// the larger graph for the first seven segments, and the smaller graph from eight segments
/// upward: 27916 bytes against 28289 bytes at the segment cap. The pin decides where the two
/// cross: since it spells its rate as `r=` (see [`audio_output_format`]), it costs 11 bytes less
/// in each chain under `InputPerSegment`, and they crossed between three and four segments
/// before, at 28327 bytes against 29789. (Those were measured after the pixel format moved behind
/// `concat`, which took the same 1477 bytes from both.) What `SingleInput` saves lies
/// outside the graph as well -- it writes the source path once instead of once for each
/// segment -- so it extends the reachable segment count without removing the growth. ADR 014's "graph shape" section draws the conclusion this
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
    /// The graph this renders is slightly *larger* than `InputPerSegment`'s for the first
    /// seven segments and slightly *smaller* from eight segments upward (ADR 014 measurement
    /// 15); what it saves at every count is the repeated input path and the flags around it.
    /// It needs the single seek [`ExportPlan::single_input_seek_seconds`] returns, not any one
    /// segment's own.
    SingleInput,
}

impl GraphShape {
    /// True for the shape that divides one input among the chains.
    #[must_use]
    pub const fn is_single_input(self) -> bool {
        matches!(self, Self::SingleInput)
    }
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
/// The plan must also carry at least one of its two parts. A plan with neither would render
/// `concat=v=0:a=0`, which ffmpeg rejects too; `build_plan` never produces one, because it
/// refuses an audio-only export of a source without audio, and a debug assertion catches a
/// hand-built plan that has neither.
///
/// # Video
///
/// A plan with no video produces no video anywhere: no `trim` chain, no `split`, no `format`,
/// `v=0` on `concat`, and `[a]` as the only output label. This is the rule for audio below,
/// applied to the other part, so each part is one decision for the whole graph.
/// [`build_plan`](super::plan::build_plan) plans no video for an audio-only export, and that is
/// the plan that reaches this branch.
///
/// # Audio
///
/// A plan with no audio produces no audio anywhere: no `atrim` chain, no `asplit`, `a=0` on
/// `concat`, and `[v]` as the only output label. That plan comes from a source without audio,
/// and from a video-only export of any source; the two render the same graph. ADR 014 records
/// why version 1 needs no silence generation for a source without audio -- it exports one
/// source, so a segment without an audio stream cannot occur between segments with one -- and
/// ADR 004's silence generation belongs to the multi-source work. A segment of a source *with*
/// audio that the stream does not reach is a different case, and its own chain writes the
/// silence: see [`audio_end_pad`]. A plan whose audio stream holds no packets reads that stream
/// nowhere, and no `asplit` divides it: each chain generates the silence of its segment, see
/// [`audio_silence_chain`].
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
    let video = plan.video.as_ref();
    let audio = resolve_audio(plan);
    debug_assert!(
        plan.audio.is_none() || audio.is_some(),
        "a plan that declares an audio stream must carry audio ticks on every segment"
    );
    debug_assert!(
        video.is_some() || plan.audio.is_some(),
        "an export plan must carry video, audio, or both"
    );

    let count = plan.segments.len();
    let mut chains: Vec<String> = Vec::new();

    // The pixel format goes first in the text, ahead of the chains and the `concat` whose output
    // it reads. ffmpeg negotiates in text order, and only this position converts each segment
    // once; see `video_output_format`.
    if let Some(video) = video {
        chains.push(video_output_format(&video.pixel_format));
    }

    if shape.is_single_input() {
        if let Some(video) = video {
            chains.push(splitter_chain(
                0,
                video.stream_index,
                "",
                "split",
                "sv",
                count,
            ));
        }
        // A plan whose chains generate silence reads no audio stream, so nothing is split.
        if let Some((planned, _)) = audio
            .as_ref()
            .filter(|(planned, _)| planned.silence_layout.is_none())
        {
            // The rate pin goes in front of `asplit`, not on each branch behind it: this
            // chain's head *is* the input link, so one filter pins it directly. See
            // `audio_input_pin`.
            chains.push(splitter_chain(
                0,
                planned.stream_index,
                &audio_input_pin(planned),
                "asplit",
                "sa",
                count,
            ));
        }
    }

    let audio_inputs = audio_input_indices(plan, shape);
    for (index, segment) in plan.segments.iter().enumerate() {
        if let Some(video) = video {
            chains.push(video_chain(video, shape, index, *segment));
        }
        if let Some((planned, ticks)) = &audio {
            if let Some(layout) = &planned.silence_layout {
                chains.push(audio_silence_chain(planned, layout, index, ticks[index]));
                continue;
            }
            // `concat` pads the audio of a segment to its video when another segment follows, so
            // only the chains it does not pad need their own end; see `audio_end_pad`.
            let end = if video.is_none() || index + 1 == count {
                ChainEnd::Padded
            } else {
                ChainEnd::Open
            };
            chains.push(audio_chain(
                planned,
                audio_inputs[index],
                index,
                ticks[index],
                end,
            ));
        }
    }

    chains.push(concat_chain(count, video.is_some(), audio.is_some()));
    chains.join(";")
}

/// Render the graph of the encoder of an export whose audio has its own process
/// ([`ExportPlan::separate_audio_process`]), for the requested shape.
///
/// It is the graph of one process with each audio chain replaced by a stand-in: the silence of
/// the planned length of the segment, which reads no input (`stand_in_audio_chain`). `concat`
/// therefore places the video of each segment where it places it when it reads the real audio,
/// at the end of the longer of the two, and its audio output goes to `anullsink`. The audio that
/// the encoder writes comes from the pipe of the audio process, which the argument builder maps
/// directly, outside this graph (ADR 043).
///
/// The graph has no audio input, and that is its purpose: ffmpeg configures a filter graph only
/// when each input link has a first frame, and it keeps each decoded video frame until then
/// (ADR 014 measurement 21).
///
/// # Preconditions
///
/// The plan carries video and audio, and every segment its ticks. A debug assertion reports a
/// plan without either part.
#[must_use]
pub fn build_video_graph(plan: &ExportPlan, shape: GraphShape) -> String {
    debug_assert!(
        plan.separate_audio_process(),
        "the graph of the encoder needs video and audio ticks"
    );
    let (Some(video), Some((audio, ticks))) = (plan.video.as_ref(), resolve_audio(plan)) else {
        return build_filter_graph(plan, shape);
    };
    let count = plan.segments.len();
    let mut chains = vec![video_output_format(&video.pixel_format)];
    if shape.is_single_input() {
        chains.push(splitter_chain(
            0,
            video.stream_index,
            "",
            "split",
            "sv",
            count,
        ));
    }
    for (index, segment) in plan.segments.iter().enumerate() {
        chains.push(video_chain(video, shape, index, *segment));
        chains.push(stand_in_audio_chain(audio, index, ticks[index]));
    }
    let inputs: String = (0..count)
        .map(|index| format!("[v{index}][pa{index}]"))
        .collect();
    chains.push(format!("{inputs}concat=n={count}:v=1:a=1[vc][pa]"));
    chains.push("[pa]anullsink".to_owned());
    chains.join(";")
}

/// Render the graph of the audio process of an export with video
/// ([`ExportPlan::separate_audio_process`]), for the requested shape.
///
/// It is the graph of one process with each video chain replaced by a stand-in: a video of
/// [`PlannedSegment::frames`] tiny frames at the output rate, which reads no input
/// (`stand_in_video_chain`). `concat` therefore pads the audio of each segment to the length of
/// its video, as it does when it reads the real video. Its video output, `[pv]`, is left
/// unconnected: the argument builder maps it to an output of the `null` muxer.
///
/// That output is not `nullsink`, and that is a measured requirement. A sink in the graph lets
/// ffmpeg request frames of `[pv]` whatever the audio output needs. When the stand-in video of a
/// segment has ended, `concat` answers each such request with the audio of that segment, and
/// `apad` writes silence without reading any input, so one pass of the graph wrote 570 s of
/// silence into the queue of `[a]`: 344 MiB, against 28 MiB for the same graph with a `null`
/// output, whose frames ffmpeg requests in step with the audio (ADR 043).
/// Every audio chain ends at exactly the length of its segment (`audio_exact_end`), so no silence
/// that `concat` pads is longer than the rounding of the frame count, and every chain has the
/// length of the stand-in silence that the encoder places its video against. The process writes
/// `[a]` to its stdout, and the encoder reads it (ADR 043).
///
/// The graph decodes no video, so no decoded video waits in it for the first audio frame.
///
/// # Preconditions
///
/// As for [`build_video_graph`], and every segment carries its frame count.
#[must_use]
pub fn build_audio_graph(plan: &ExportPlan, shape: GraphShape) -> String {
    debug_assert!(
        plan.separate_audio_process(),
        "the graph of the audio process needs video and audio ticks"
    );
    let (Some(video), Some((audio, ticks))) = (plan.video.as_ref(), resolve_audio(plan)) else {
        return build_filter_graph(plan, shape);
    };
    let count = plan.segments.len();
    let mut chains = Vec::new();
    if shape.is_single_input() {
        chains.push(splitter_chain(
            0,
            audio.stream_index,
            &audio_input_pin(audio),
            "asplit",
            "sa",
            count,
        ));
    }
    let audio_inputs = audio_input_indices(plan, shape);
    for (index, segment) in plan.segments.iter().enumerate() {
        debug_assert!(
            segment.frames.is_some(),
            "a plan with video carries the frame count of every segment"
        );
        chains.push(stand_in_video_chain(
            video,
            index,
            segment.frames.unwrap_or(0),
        ));
        chains.push(audio_chain(
            audio,
            audio_inputs[index],
            index,
            ticks[index],
            ChainEnd::Exact,
        ));
    }
    let inputs: String = (0..count)
        .map(|index| format!("[pv{index}][a{index}]"))
        .collect();
    chains.push(format!("{inputs}concat=n={count}:v=1:a=1[pv][a]"));
    chains.join(";")
}

/// Render the stand-in for the video of one segment in the graph of the audio process:
/// `frames` frames of 2x2 pixels at the output frame rate, to the `[pv<index>]` label.
///
/// The video chain of the encoder ends in `fps=<rate>`, so its frames carry the timestamps `0, 1,
/// 2, ...` in the time base `1/rate`, and `color` with the same rate gives the same. `concat` takes
/// the length of a segment's video from those timestamps, so the stand-in gives the audio of the
/// segment the length that the real video gives it in the encoder. The frame count is the plan's
/// rounding of the segment's length, the same term [`PlannedVideo::expected_frames`] sums and the
/// frame count check compares. The frames are 2x2 because nothing reads their pixels.
fn stand_in_video_chain(video: &PlannedVideo, index: usize, frames: u64) -> String {
    let rate = match video.timing {
        OutputTiming::ConstantFrameRate(rate) => format!("{}/{}", rate.num(), rate.den()),
    };
    format!("color=s=2x2:r={rate},trim=end_frame={frames}[pv{index}]")
}

/// Render the stand-in for the audio of one segment in the graph of the encoder: the silence of
/// the planned length at the source rate, converted to the output rate, to the `[pa<index>]`
/// label.
///
/// The audio chain of the audio process ends at exactly `<out tick - in tick>` samples at the
/// source rate ([`audio_exact_end`]), also when its source audio overlaps itself, and its closing
/// `aformat` resamples to the output rate. The stand-in gives `concat` the same number of samples
/// through the same conversion, so `concat` places the video of the segment where it places it
/// with the real audio. One channel is enough, because the layout does not change the number of
/// samples, and nothing reads them.
fn stand_in_audio_chain(audio: &PlannedAudio, index: usize, ticks: (i64, i64)) -> String {
    let (in_tick, out_tick) = ticks;
    let length = out_tick.saturating_sub(in_tick).max(0);
    format!(
        "anullsrc=r={}:cl=mono,atrim=end_sample={length},aformat=f=fltp:r={}[pa{index}]",
        audio.sample_rate, audio.output_sample_rate
    )
}

/// Pair the plan's audio stream with every segment's tick boundary, or report no audio.
///
/// The `collect` into an `Option<Vec<_>>` is the whole-graph decision described on
/// [`build_filter_graph`]: one segment missing a tick means no audio anywhere, never a
/// half-written audio path.
fn resolve_audio(plan: &ExportPlan) -> Option<(&PlannedAudio, Vec<(i64, i64)>)> {
    let planned = plan.audio.as_ref()?;
    let ticks: Option<Vec<(i64, i64)>> = plan
        .segments
        .iter()
        .map(|segment| segment.audio_in_tick.zip(segment.audio_out_tick))
        .collect();
    Some((planned, ticks?))
}

/// The input that the audio chain of each segment reads under `InputPerSegment`, in segment
/// order, or `None` for each chain under the shape that reads the audio from `asplit`.
///
/// Segment `i` reads input `i`, in the graph of one process and in the graph of the audio
/// process alike: each process opens its own inputs.
fn audio_input_indices(plan: &ExportPlan, shape: GraphShape) -> Vec<Option<usize>> {
    (0..plan.segments.len())
        .map(|index| (!shape.is_single_input()).then_some(index))
        .collect()
}

/// Render the `split`/`asplit` chain that feeds every segment chain from one input.
///
/// `input` is the input that the splitter reads. `pin` is inserted between the input link and the
/// splitter, already carrying its own trailing comma, or is empty. Only the audio splitter uses it,
/// for [`audio_input_pin`]'s reason; the video link has no equivalent hazard, because ADR 014
/// measurement 3 found the video input link time base equal to the video stream's own with or
/// without a seek.
fn splitter_chain(
    input: usize,
    stream_index: u32,
    pin: &str,
    filter: &str,
    label: &str,
    count: usize,
) -> String {
    let outputs: String = (0..count)
        .map(|index| format!("[{label}{index}]"))
        .collect();
    format!("[{input}:{stream_index}]{pin}{filter}={count}{outputs}")
}

/// Render the `aformat` that holds an audio **input** link at the source's own sample rate,
/// with the trailing comma that joins it to the filter behind it.
///
/// This is the one filter in the graph that exists to defeat an ffmpeg behaviour rather than
/// to express a decision, so it reads as redundant beside [`audio_output_format`] at the end
/// of the same chain. When the preset keeps the source rate, the two filters even render the
/// same number. It is still not redundant, and it stays on every chain whatever the preset
/// asks for. **Deleting it silently desynchronizes every export that seeks and resamples.**
///
/// ADR 014 measurement 17 has the behaviour. FFmpeg negotiates one sample rate over a filter
/// link, and it configures an input's audio buffer source at whatever the link settles on.
/// With no `-ss`, that is the source stream's own rate. With `-ss` -- which ADR 014's "The
/// seek" puts on almost every export -- the negotiation instead pulls the *output* rate
/// backwards through the graph, out of the rate [`audio_output_format`] closes the chain at
/// (48000 in the measurement), and the input arrives already resampled. The `atrim` boundaries
/// do not follow: the plan computes them as
/// `round(pts * videoTimeBase * sampleRate)` in the source's rate, and `atrim` reads them in
/// whatever unit its input link happens to use. On the measured 44100 Hz source,
/// `start_pts=441000` therefore means 10 s without the seek and 9.1875 s with it -- the cut
/// starts early, and the segment loses length in proportion to its position in the source. A
/// 1.000000 s segment measured 0.918750 s.
///
/// Nothing downstream can catch that. The video frame count is untouched, so ADR 014's
/// `frameCountMismatch` guard passes, ffmpeg exits zero, and the export ships with the audio
/// seconds out of step with the picture. A source already at the output rate hides the fault
/// completely, because the two rates agree -- which is also why a preset that keeps the source
/// rate never shows it, and why that is no reason to drop the pin for such a preset.
///
/// Pinning the link to [`PlannedAudio::sample_rate`] restores the boundary: the constraint
/// applies to this filter's *input* link as well as its output, so it reaches back to the
/// buffer source and the ticks are read in the unit they were computed in. The pin therefore
/// has to sit on the input link itself -- in front of `atrim`, and in front of `asplit` under
/// [`GraphShape::SingleInput`] rather than on the branches behind it, which is also one
/// filter instead of one for each segment.
///
/// `r` is the short name of `sample_rates`, for the reason [`audio_output_format`] gives.
fn audio_input_pin(audio: &PlannedAudio) -> String {
    format!("aformat=r={},", audio.sample_rate)
}

/// Render one segment's video chain, from its input link to its `[v<index>]` output label.
///
/// The chain carries no `format` filter. The pixel format is set once, behind `concat`; see
/// [`video_output_format`].
fn video_chain(
    video: &PlannedVideo,
    shape: GraphShape,
    index: usize,
    segment: PlannedSegment,
) -> String {
    let source = if shape.is_single_input() {
        format!("[sv{index}]")
    } else {
        format!("[{index}:{}]", video.stream_index)
    };
    // ADR 014's "Output timing": version 1 always writes constant-frame-rate output, because
    // `concat` needs one frame rate and a variable-frame-rate source has none. The decision
    // also requires a later variable-frame-rate mode to be an addition, and this `match` is
    // where it lands: that mode omits the `fps` filter instead of choosing a different rate,
    // so the choice cannot be a rate lookup on an unconditional filter.
    let timing = match video.timing {
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
    let scale = match video.resolution {
        Some(Resolution { w, h }) => format!(",scale={w}:{h},setsar=1"),
        None => String::new(),
    };
    let head = format!(
        "{source}trim=start_pts={}:end_pts={},setpts=PTS-STARTPTS",
        segment.in_pts.value(),
        segment.out_pts.value()
    );
    format!("{head}{timing}{scale}[v{index}]")
}

/// Render the `aresample` that writes silence where a segment's audio has no samples: in front
/// of its first sample, and in a gap inside the stream.
///
/// `first_pts=0` states that the output starts at timestamp 0, which is the segment's In point
/// once [`audio_timestamp_reset`] has run. With that option libswresample turns on its
/// timestamp compensation, as `async=1` would, so `async=1` adds bytes and changes nothing. The
/// defaults then decide what is compensated: a first sample more than 1 ms after timestamp 0 is
/// preceded by silence, a gap of more than 0.1 s (`min_hard_comp`) inside the segment is filled
/// with silence, and an overlap of more than 0.1 s is dropped. Nothing is stretched. A shorter
/// gap inside a segment stays unfilled: the rest of that segment plays early by up to 0.1 s, and
/// `concat` or [`audio_end_pad`] pads the end of the segment, so the next one starts in sync
/// again.
///
/// The filter's output rate is the source rate, [`PlannedAudio::sample_rate`]. It therefore
/// resamples nothing. When the closing [`audio_output_format`] asks for another rate, ffmpeg
/// still inserts its own resampler in front of it, as it did before this filter existed. The
/// filter converts only the channel layout, which ffmpeg converted ahead of the cut before.
/// Without the rate, this filter also took over the resampling, and M7 found the samples of a
/// downmix with a resample (stereo or 5.1 at 44100 Hz to mono or stereo at 48000 Hz) up to
/// 9.5e-7 away from those of the earlier graph: one conversion rounds differently from two. With
/// the rate, every case M7 measured gave the same samples. The rate costs 6 or 7 bytes in each
/// chain.
fn audio_gap_fill(audio: &PlannedAudio) -> String {
    format!("aresample={}:first_pts=0", audio.sample_rate)
}

/// Render the `asetpts` that moves a segment's In point to timestamp 0: `PTS-<in tick>`, or
/// `PTS+<magnitude>` for a negative tick, which ADR 002 permits (see
/// [`PlannedSegment::audio_in_tick`]).
///
/// The tick is the plan's [`PlannedSegment::audio_in_tick`], the same number `atrim` cuts at,
/// in the unit the input link counts in, which [`audio_input_pin`] holds at the source rate.
/// ffmpeg evaluates the expression in double precision, as it evaluated `PTS-STARTPTS`, and
/// that is exact for every tick below 2^53: about 1500 years at 192000 Hz.
fn audio_timestamp_reset(in_tick: i64) -> String {
    if in_tick < 0 {
        format!("asetpts=PTS+{}", in_tick.unsigned_abs())
    } else {
        format!("asetpts=PTS-{in_tick}")
    }
}

/// Render the filters that pad a segment's audio with silence to its planned length:
/// `apad=whole_len=<out tick - in tick>,asetpts=N`.
///
/// `atrim` passes no sample for a segment that lies wholly before the first sample of the source
/// audio or wholly after the last one, and none for the part of a segment after the last sample.
/// [`audio_gap_fill`] fills only *in front of* a sample, so such a chain wrote nothing, or ended
/// early. `concat` pads the audio of a segment to the length of its video when another segment
/// follows it. It never pads the last segment, and it pads nothing in a graph without video. ADR
/// 014 measurement 23 (ffmpeg 9.0.2) found the results without this pad:
///
/// - With one segment wholly outside the audio, ffmpeg failed with "Could not open encoder before
///   EOF" when no input gave an audio frame. Otherwise it exited zero and wrote an MP4 without an
///   audio track, which the frame count check passes.
/// - With a last segment wholly outside the audio, the audio track ended with the segment before.
/// - An audio-only export wrote nothing for such a segment, so its later segments came earlier in
///   the file than in the export with video (ADR 036).
///
/// [`build_filter_graph`] therefore pads exactly the chains `concat` does not pad: the last chain
/// of a graph with video, and every chain of a graph without video.
///
/// `whole_len` is a minimum count of samples on the link that `apad` reads, at the source rate
/// that [`audio_gap_fill`] sets. ffmpeg inserts its own resampler behind these filters, in front
/// of the closing [`audio_output_format`]; the measurement found it there in every graph. The
/// length is the difference of the plan's ticks, the numbers `atrim` cuts at, so a chain whose
/// audio covers the segment without a gap already holds that many samples, and `apad` adds none.
/// A gap of 0.1 s or less inside the segment, which [`audio_gap_fill`] leaves unfilled, comes
/// back as silence at the end of the segment: the samples after the gap stay early, as they were,
/// and the segment still ends at its length. `apad` never removes a sample.
///
/// `asetpts=N` is necessary. `apad` stamps its silence with the timestamp after the last frame
/// it passed, and with no timestamp when it passed none. `concat` rescales that missing value as
/// a number, and the measurement found such frames at about -9.2e18 behind `concat`. ffmpeg 9.0.2
/// repaired them before the encoder, which it does not document. `N` is the count of samples in
/// front of each frame, in the time base of 1/rate that [`audio_gap_fill`] gives the link, and
/// that filter already numbers its output contiguously from 0. So `N` changes nothing in a chain
/// whose audio covers the segment, and it numbers the silence after the last frame.
///
/// The silence streams: `apad` writes a frame only when the next filter asks for one. A last
/// segment of 575 s after the end of 48000 Hz 5.1 audio peaked at 42 MiB, against 45 MiB for a
/// source whose audio covers it. The padding of `concat` is not streamed: the same segment with
/// another one behind it took 900 MiB. A pad in every chain of a graph with video removes that
/// cost too. The one command of ADR 014 had no room for it at [`super::MAX_EXPORT_SEGMENTS`], and
/// the audio process of ADR 043 has: every chain of [`build_audio_graph`] carries it, cut to the
/// length ([`audio_exact_end`]).
///
/// On sources whose audio covers every segment, measurement 23 found the video and audio frames
/// that leave the graph identical by framemd5 with and without the pad, in 441 runs: MP4, MKV,
/// MPEG-TS and MOV, 32000 to 48000 Hz, mono, stereo and 5.1, 1, 3 and 100 segments, every graph
/// shape, at the source format, at 48000 Hz stereo and at 44100 Hz mono.
///
/// Two of these results depend on ffmpeg behaviour that ffmpeg does not document. ffmpeg merges
/// the formats of the links in the order of the filters in the graph text, and that order keeps
/// the link into `apad` at the source rate and puts the resampler behind `asetpts=N`. And
/// `asetpts=N` is an identity only because [`audio_gap_fill`] numbers its output from 0 without a
/// gap. A later ffmpeg can change either, and measurement 23 must then be repeated.
fn audio_end_pad(in_tick: i64, out_tick: i64) -> String {
    debug_assert!(
        in_tick <= out_tick,
        "a planned segment cannot end before it starts"
    );
    let length = out_tick.saturating_sub(in_tick).max(0);
    format!("apad=whole_len={length},asetpts=N")
}

/// Render the filters that give a chain of the audio process exactly the length of its segment:
/// [`audio_end_pad`] with `atrim=end_sample=<out tick - in tick>` between its two filters.
///
/// The end pad adds silence up to the length and never removes a sample. A chain whose source audio
/// overlaps itself by less than 0.1 s keeps the overlap ([`audio_gap_fill`]), and is then longer
/// than its segment. In the graph of one process, `concat` moved the video of the next segment by
/// that much. The encoder of ADR 043 places its video against a stand-in silence of exactly the
/// length (`stand_in_audio_chain`), so a longer chain would put the audio of every later segment
/// behind its video, by the sum of the overlaps. A file joined with `-c copy` overlaps by about 21
/// ms at each join. The cut drops the samples past the length, at the end of the segment, and keeps
/// each segment in step with its video.
fn audio_exact_end(in_tick: i64, out_tick: i64) -> String {
    debug_assert!(
        in_tick <= out_tick,
        "a planned segment cannot end before it starts"
    );
    let length = out_tick.saturating_sub(in_tick).max(0);
    format!("apad=whole_len={length},atrim=end_sample={length},asetpts=N")
}

/// How [`audio_chain`] ends, in front of its closing format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChainEnd {
    /// No end of its own: `concat` pads the chain to the length of its video.
    Open,
    /// The end pad, which gives the chain at least the length of its segment ([`audio_end_pad`]).
    Padded,
    /// The end pad and a cut, which give the chain exactly the length of its segment
    /// ([`audio_exact_end`]).
    Exact,
}

/// Render one segment's audio chain, from its input link to its `[a<index>]` output label:
/// the cut, the timestamp reset, the gap fill, the end that `end` names, and the output
/// format.
///
/// Under [`GraphShape::InputPerSegment`] this chain starts at an input link, so it carries
/// [`audio_input_pin`] itself. Under [`GraphShape::SingleInput`] it starts behind `asplit`,
/// and the splitter chain already pinned the one input link they share; repeating the pin
/// here would only add a filter for each segment to a graph ADR 014 measurement 15 already
/// counts in bytes against the Windows command-line limit.
///
/// **The audio of a segment starts at the segment's In point, not at its first sample.** The
/// chain subtracts the In tick ([`audio_timestamp_reset`]), and [`audio_gap_fill`] then writes
/// silence from the In point to the first sample. The chain used `asetpts=PTS-STARTPTS`, which
/// subtracts the timestamp of the first sample `atrim` passes. When the source audio starts
/// after the In point, as in a phone recording whose microphone opened after its camera, that
/// sample lies after the In point: the reset removed the gap, `concat` padded the missing time
/// with silence at the end of the segment, and the audio of the segment played as early as the
/// gap. A gap inside the stream did the same at the sample level: the output kept its
/// timestamps but held no samples for it, so a decoder that plays the samples one after another
/// played the rest of the segment early by the gap. The video frame count sees neither fault.
///
/// Measurement M7 (ffmpeg 9.0.2) used test sources with a tone burst on the frame of each white
/// flash, with audio that starts 0.3 s late, ends 1 s early, or has no packets for 0.5 s, in
/// MP4 and MKV, at 44100 and 48000 Hz, with 1 and 3 segments in both shapes and at three output
/// formats. With `PTS-STARTPTS`, a segment whose In point lay before the first audio sample
/// played 0.043 to 0.300 s early, by its own gap, and the audio after the 0.5 s gap played
/// 0.500 s early. With this chain, every burst lay within 0.8 ms of its flash.
///
/// The fill stands in each chain, between the reset and the closing `aformat`, because the two
/// other places for one filter fail:
///
/// - Behind `concat`, the late start of a segment that is not the first one reaches the filter
///   as a gap inside the stream, and a gap of up to 0.1 s stays there. M7 measured 0.043 to
///   0.067 s left.
/// - On the input link, in front of `atrim`, the filter numbers the samples again before the
///   cut, and `atrim` cuts on those numbers instead of the source timestamps. M7 found the
///   audio of a 3-segment MPEG-TS export two samples longer.
///
/// A source whose audio covers the segment does not change. Its first sample after `atrim` is
/// at the In tick, so the reset is the one `PTS-STARTPTS` made, and the fill compensates
/// nothing. M7 found the samples identical by MD5 with and without this chain on ADR 014's six
/// fixtures, in both shapes, at the source rate, at 48000 Hz stereo, and at 44100 Hz mono; on
/// stereo and 5.1 sources in every layout at the source rate and at 48000 Hz; and on 100
/// segments of a 130 s source. Only the timestamps of some MPEG-TS frames changed, by one
/// sample, because the fill numbers its output without the rounding of the source timestamps.
///
/// The reset and the fill add 33 bytes to each chain with a 12-digit tick at 192000 Hz. The
/// short names of [`audio_output_format`] take 34 bytes from a chain with a channel layout and
/// 21 from one without, and 11 from each input pin, so the widest command stays inside the
/// Windows budget at [`super::MAX_EXPORT_SEGMENTS`]; see `arguments.rs`.
fn audio_chain(
    audio: &PlannedAudio,
    input: Option<usize>,
    index: usize,
    ticks: (i64, i64),
    end: ChainEnd,
) -> String {
    let source = match input {
        Some(input) => format!("[{input}:{}]{}", audio.stream_index, audio_input_pin(audio)),
        None => format!("[sa{index}]"),
    };
    let (in_tick, out_tick) = ticks;
    let head = format!("{source}atrim=start_pts={in_tick}:end_pts={out_tick}");
    let reset = audio_timestamp_reset(in_tick);
    let fill = audio_gap_fill(audio);
    let pad = match end {
        ChainEnd::Open => String::new(),
        ChainEnd::Padded => format!(",{}", audio_end_pad(in_tick, out_tick)),
        ChainEnd::Exact => format!(",{}", audio_exact_end(in_tick, out_tick)),
    };
    let format = audio_output_format(audio);
    format!("{head},{reset},{fill}{pad},{format}[a{index}]")
}

/// Render the audio chain of one segment of an audio stream that holds no packets: the silence of
/// the segment, generated from no input, to its `[a<index>]` output label.
///
/// `anullsrc` generates silence at [`PlannedAudio::sample_rate`] in
/// [`PlannedAudio::silence_layout`]. `atrim=end_sample=<out tick - in tick>` ends it at the number
/// of samples that [`audio_end_pad`] gives a chain that reads the stream, and the closing
/// [`audio_output_format`] is the one of every other chain. So the silence has the length, the
/// rate and the layout that the audio of the segment would have.
///
/// The chain reads no input, and that is its purpose. An input of a stream that holds no packets
/// gives no audio frame before the end of the file, and ffmpeg configures the graph only when each
/// input link has a first frame. Until then it keeps each decoded video frame of that input in
/// memory: the whole rest of the file. `anullsrc` writes one frame when the filter behind it asks
/// for one, so the chain keeps none of its silence in memory either. ADR 014 measurement 26 has
/// the figures.
fn audio_silence_chain(
    audio: &PlannedAudio,
    layout: &str,
    index: usize,
    ticks: (i64, i64),
) -> String {
    let (in_tick, out_tick) = ticks;
    let length = out_tick.saturating_sub(in_tick).max(0);
    format!(
        "anullsrc=r={}:cl={layout},atrim=end_sample={length},{}[a{index}]",
        audio.sample_rate,
        audio_output_format(audio)
    )
}

/// Render the `concat` filter, with the joined video at `[vc]` and the joined audio at the
/// graph's `[a]` output label, for whichever of the two parts the plan carries.
///
/// The video does not leave the graph here. [`video_output_format`], the first chain of the
/// graph, reads `[vc]` and writes `[v]`, so the label the argument builder maps is the same in
/// every graph.
fn concat_chain(count: usize, has_video: bool, has_audio: bool) -> String {
    let inputs: String = (0..count)
        .map(|index| {
            let video = if has_video {
                format!("[v{index}]")
            } else {
                String::new()
            };
            let audio = if has_audio {
                format!("[a{index}]")
            } else {
                String::new()
            };
            format!("{video}{audio}")
        })
        .collect();
    let video_streams = u8::from(has_video);
    let audio_streams = u8::from(has_audio);
    let video_output = if has_video { "[vc]" } else { "" };
    let audio_output = if has_audio { "[a]" } else { "" };
    format!(
        "{inputs}concat=n={count}:v={video_streams}:a={audio_streams}{video_output}{audio_output}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::ExportStreams;
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
    /// - The source rate is 44100, while the plan's output rate is 48000 -- the value a preset
    ///   from before ADR 023 plans. Rendering [`PlannedAudio::sample_rate`] where
    ///   [`PlannedAudio::output_sample_rate`] belongs therefore changes every pinned string
    ///   below, instead of passing unnoticed as it would if the fixture also ran at 48000. The
    ///   same gap is what makes [`audio_input_pin`] visible at all: its `44100` and the chain's
    ///   closing `48000` are two different rates in one chain, and a 48000 Hz fixture would
    ///   render them identically -- which is exactly why the fault ADR 014 measurement 17
    ///   records reached a shipped graph unseen.
    /// - The output is 48000 Hz stereo, the pre-ADR 023 default, so every pinned string below is
    ///   byte-identical to the graph ADR 014 shipped before the output format became a preset
    ///   setting. That is ADR 023's compatibility promise, stated as a fixture.
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
            // 25 frames per second at the time base of 1/12800: one frame is 512 ticks.
            frames: Some(u64::try_from((out_pts - in_pts) / 512).unwrap()),
        }
    }

    /// A plan over the first `count` fixture segments: video stream 1, audio stream 2 at
    /// 44100 Hz written out as 48000 Hz stereo, 25 fps, and the source's own resolution.
    ///
    /// Neither stream index is the one a short specifier would bind. `[0:v]` and `[0:a]`
    /// would both resolve to stream 0 on a file laid out this way, so a chain that used a
    /// short specifier, or hardcoded index 1 for audio, fails every pinned string below.
    fn fixture_plan(count: usize) -> ExportPlan {
        let frames = 6 + 12 * (count - 1);
        ExportPlan {
            source: PathBuf::from("/media/source.mp4"),
            destination: PathBuf::from("/export/out.mp4"),
            video: Some(PlannedVideo {
                stream_index: 1,
                timing: OutputTiming::ConstantFrameRate(Rational::new(25, 1).unwrap()),
                resolution: None,
                encoder: "libx264".to_owned(),
                quality: Quality {
                    kind: QualityKind::Crf,
                    value: 20,
                },
                pixel_format: "yuv420p".to_owned(),
                options: vec![],
                expected_frames: Some(u64::try_from(frames).unwrap()),
            }),
            audio: Some(fixture_audio(2, 44_100)),
            segments: fixture_segments(count),
            container: Container::Mp4,
            total_duration: Rational::new(i64::try_from(frames).unwrap(), 25).unwrap(),
        }
    }

    /// An audio stream at `stream_index`, with ticks at `sample_rate`, written out in the
    /// pre-ADR 023 format of 48000 Hz stereo.
    fn fixture_audio(stream_index: u32, sample_rate: u32) -> PlannedAudio {
        PlannedAudio {
            stream_index,
            sample_rate,
            output_sample_rate: 48_000,
            output_channels: AudioChannels::Stereo,
            encoder: "aac".to_owned(),
            bitrate: None,
            options: vec![],
            // The graph does not read it; any value renders the same graph.
            expected_duration: Rational::new(1, 1).unwrap(),
            silence_layout: None,
        }
    }

    /// The video part of a fixture plan, which every fixture carries.
    fn video_mut(plan: &mut ExportPlan) -> &mut PlannedVideo {
        plan.video
            .as_mut()
            .expect("every fixture plan carries video")
    }

    #[test]
    fn one_input_per_segment_renders_one_segment_as_a_single_chain_pair() {
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn one_input_per_segment_gives_the_second_segment_its_own_input_index() {
        let graph = build_filter_graph(&fixture_plan(2), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn one_input_per_segment_keeps_input_and_label_numbering_aligned_across_three_segments() {
        let graph = build_filter_graph(&fixture_plan(3), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[2:1]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1[v2];",
                "[2:2]aformat=r=44100,atrim=start_pts=882000:end_pts=903168,asetpts=PTS-882000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a2];",
                "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn the_encoder_of_a_separate_audio_process_places_its_video_against_stand_in_silence() {
        // The graph of one process, with each audio chain replaced by the silence of its planned
        // length, from no input. No chain reads stream 2.
        let plan = fixture_plan(2);
        assert!(plan.separate_audio_process());
        assert_eq!(
            build_video_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "anullsrc=r=44100:cl=mono,atrim=end_sample=10584,aformat=f=fltp:r=48000[pa0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "anullsrc=r=44100:cl=mono,atrim=end_sample=21168,aformat=f=fltp:r=48000[pa1];",
                "[v0][pa0][v1][pa1]concat=n=2:v=1:a=1[vc][pa];",
                "[pa]anullsink",
            )
        );
        assert_eq!(
            build_video_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "anullsrc=r=44100:cl=mono,atrim=end_sample=10584,aformat=f=fltp:r=48000[pa0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "anullsrc=r=44100:cl=mono,atrim=end_sample=21168,aformat=f=fltp:r=48000[pa1];",
                "[v0][pa0][v1][pa1]concat=n=2:v=1:a=1[vc][pa];",
                "[pa]anullsink",
            )
        );
    }

    #[test]
    fn the_audio_process_pads_every_chain_against_a_stand_in_video_of_the_planned_frames() {
        // The graph of one process, with each video chain replaced by the planned number of
        // frames at the output rate, from no input, and every audio chain cut to its length.
        let plan = fixture_plan(2);
        assert_eq!(
            build_audio_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "color=s=2x2:r=25/1,trim=end_frame=6[pv0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,atrim=end_sample=10584,",
                "asetpts=N,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "color=s=2x2:r=25/1,trim=end_frame=12[pv1];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,atrim=end_sample=21168,",
                "asetpts=N,aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[pv0][a0][pv1][a1]concat=n=2:v=1:a=1[pv][a]",
            )
        );
        assert_eq!(
            build_audio_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "color=s=2x2:r=25/1,trim=end_frame=6[pv0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,atrim=end_sample=10584,",
                "asetpts=N,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "color=s=2x2:r=25/1,trim=end_frame=12[pv1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,atrim=end_sample=21168,",
                "asetpts=N,aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[pv0][a0][pv1][a1]concat=n=2:v=1:a=1[pv][a]",
            )
        );
    }

    #[test]
    fn the_stand_ins_take_the_exact_rates_and_lengths_of_the_plan() {
        // An NTSC rate renders as its exact fraction in the stand-in video, as in `fps`, and the
        // stand-in silence converts from the source rate to the output rate of the plan.
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).timing =
            OutputTiming::ConstantFrameRate(Rational::new(30_000, 1_001).unwrap());
        plan.segments[0].frames = Some(7);
        plan.audio.as_mut().unwrap().output_sample_rate = 32_000;
        let audio = build_audio_graph(&plan, GraphShape::InputPerSegment);
        assert!(
            audio.starts_with("color=s=2x2:r=30000/1001,trim=end_frame=7[pv0];"),
            "{audio}"
        );
        let video = build_video_graph(&plan, GraphShape::InputPerSegment);
        assert!(
            video.contains(
                "anullsrc=r=44100:cl=mono,atrim=end_sample=10584,aformat=f=fltp:r=32000[pa0]"
            ),
            "{video}"
        );
    }

    #[test]
    fn a_plan_without_video_or_with_silence_has_no_separate_audio_process() {
        let mut audio_only = fixture_plan(1);
        audio_only.video = None;
        let mut video_only = fixture_plan(1);
        video_only.audio = None;
        for plan in [audio_only, video_only, plan_with_silence(1, "stereo")] {
            assert!(!plan.separate_audio_process());
        }
    }

    /// `fixture_plan(count)` with an audio stream that holds no packets, silenced in `layout`.
    fn plan_with_silence(count: usize, layout: &str) -> ExportPlan {
        let mut plan = fixture_plan(count);
        plan.audio.as_mut().unwrap().silence_layout = Some(layout.to_owned());
        plan
    }

    #[test]
    fn a_stream_without_packets_generates_the_silence_of_each_segment_from_no_input() {
        // Each chain generates its length at the source rate and ends in the format of every
        // other chain. No chain reads stream 2, and the last chain needs no pad of its own.
        let graph =
            build_filter_graph(&plan_with_silence(2, "stereo"), GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "anullsrc=r=44100:cl=stereo,atrim=end_sample=10584,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "anullsrc=r=44100:cl=stereo,atrim=end_sample=21168,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn a_single_input_of_a_stream_without_packets_splits_only_the_video() {
        let graph = build_filter_graph(&plan_with_silence(2, "5.1(side)"), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "anullsrc=r=44100:cl=5.1(side),atrim=end_sample=10584,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "anullsrc=r=44100:cl=5.1(side),atrim=end_sample=21168,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn the_silence_of_an_audio_only_plan_ends_each_chain_at_its_length() {
        // `build_plan` refuses an audio-only export of a stream without packets. The graph still
        // renders a hand-built one with one chain for each segment and nothing else.
        let mut plan = plan_with_silence(2, "mono");
        plan.video = None;
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "anullsrc=r=44100:cl=mono,atrim=end_sample=10584,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "anullsrc=r=44100:cl=mono,atrim=end_sample=21168,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
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
                "[vc]format=yuv420p[v];",
                "[0:1]split=1[sv0];",
                "[0:2]aformat=r=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn a_single_input_feeds_two_segments_through_one_split_and_one_asplit() {
        let graph = build_filter_graph(&fixture_plan(2), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn a_single_input_keeps_split_and_chain_labels_aligned_across_three_segments() {
        let graph = build_filter_graph(&fixture_plan(3), GraphShape::SingleInput);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=3[sv0][sv1][sv2];",
                "[0:2]aformat=r=44100,asplit=3[sa0][sa1][sa2];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[sv2]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1[v2];",
                "[sa2]atrim=start_pts=882000:end_pts=903168,asetpts=PTS-882000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a2];",
                "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][a]",
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
    fn the_audio_output_rate_is_the_plans_output_rate_not_the_sources_tick_rate() {
        // The fixture's audio stream runs at 44100 Hz, so its ticks are in 1/44100 units,
        // while its plan resamples every chain to 48000 Hz for `concat`. Rendering
        // `PlannedAudio::sample_rate` in the closing `aformat` instead of `output_sample_rate`
        // would keep the ticks correct and still produce the wrong output rate. The chain
        // carries the source rate too, in `audio_input_pin` at its head, so this asserts the
        // two rates by position rather than by presence: 44100 in front of the cut, 48000
        // behind it.
        let graph = build_filter_graph(&fixture_plan(1), GraphShape::InputPerSegment);
        assert!(
            graph.contains("aformat=r=44100,atrim=start_pts=511560:end_pts=522144"),
            "{graph}"
        );
        assert!(
            graph.contains("aformat=f=fltp:r=48000:cl=stereo"),
            "{graph}"
        );
        assert!(!graph.contains("r=44100:cl"), "{graph}");
    }

    #[test]
    fn the_audio_input_link_is_pinned_to_the_source_rate_in_both_shapes() {
        // The test class ADR 014's consequences ask for: a fixture that is not 48000 Hz.
        //
        // Measurement 17. An input seek makes ffmpeg configure that input's audio at the rate
        // the graph negotiates for its *output*, pulled backwards out of the closing `aformat`.
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
        assert_eq!(
            plan.audio.as_ref().expect("fixture audio").sample_rate,
            44_100
        );

        // One input for each segment: every chain begins at an input link of its own, so
        // every chain carries the pin.
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert!(graph.contains("[0:2]aformat=r=44100,atrim="), "{graph}");
        assert!(graph.contains("[1:2]aformat=r=44100,atrim="), "{graph}");

        // One input: the chains begin behind `asplit`, so the pin belongs on the single input
        // link in front of it. That is the link ffmpeg configures the buffer source from, and
        // one filter covers every branch instead of one for each segment.
        let graph = build_filter_graph(&plan, GraphShape::SingleInput);
        assert!(
            graph.contains("[0:2]aformat=r=44100,asplit=2[sa0][sa1];"),
            "{graph}"
        );
        assert_eq!(graph.matches("aformat=r=44100").count(), 1, "{graph}");
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
        plan.audio = Some(fixture_audio(2, 32_000));
        plan.segments[0].audio_in_tick = Some(371_200);
        plan.segments[0].audio_out_tick = Some(378_880);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=32000,atrim=start_pts=371200:end_pts=378880,asetpts=PTS-371200,",
                "aresample=32000:first_pts=0,apad=whole_len=7680,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=1[sv0];",
                "[0:2]aformat=r=32000,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=371200:end_pts=378880,asetpts=PTS-371200,",
                "aresample=32000:first_pts=0,apad=whole_len=7680,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
    }

    // -- The ADR 023 output format --------------------------------------------------------

    /// The fixture plan with its output format replaced, and nothing else touched.
    fn plan_with_output(count: usize, rate: u32, channels: AudioChannels) -> ExportPlan {
        let mut plan = fixture_plan(count);
        plan.audio = Some(PlannedAudio {
            output_sample_rate: rate,
            output_channels: channels,
            ..fixture_audio(2, 44_100)
        });
        plan
    }

    #[test]
    fn a_source_rate_ends_every_chain_at_44100_and_keeps_the_input_pin_in_both_shapes() {
        // `build_plan` resolves the preset's `source` rate to the stream's own 44100, so the
        // closing `aformat` now renders the same number as the pin at the head of the chain.
        // The pin must stay anyway: see `audio_input_pin`.
        let plan = plan_with_output(2, 44_100, AudioChannels::Stereo);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=44100:cl=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=44100:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=44100:cl=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=44100:cl=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert!(!build_filter_graph(&plan, GraphShape::InputPerSegment).contains("48000"));
    }

    #[test]
    fn source_channels_name_no_channel_layout_in_both_shapes() {
        // The seeds' own format: the source rate and the source layout. With no `cl` option
        // (`channel_layouts`) each chain keeps the stream's layout, so a 5.1 source stays 5.1
        // through an encoder that takes it (ADR 023 measurement 3).
        let plan = plan_with_output(2, 44_100, AudioChannels::Source);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=44100[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=44100[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,aformat=f=fltp:r=44100[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=44100[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );

        // Source channels with a fixed rate: the option is still absent, and the rate is the
        // plan's own.
        let fixed_rate = plan_with_output(1, 96_000, AudioChannels::Source);
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&fixed_rate, shape);
            assert!(!graph.contains("cl="), "{graph}");
            assert!(graph.contains(",aformat=f=fltp:r=96000[a0];"), "{graph}");
        }
    }

    #[test]
    fn mono_channels_render_the_mono_layout_in_both_shapes() {
        let plan = plan_with_output(1, 48_000, AudioChannels::Mono);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=mono[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=1[sv0];",
                "[0:2]aformat=r=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=mono[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn every_chain_of_one_graph_ends_in_the_same_audio_format() {
        // `concat` needs inputs that agree. Every chain reads the same stream, or generates
        // silence, and renders the same closing filter, so one graph must hold exactly one
        // spelling of it, once for each segment, whatever the format.
        for channels in [
            AudioChannels::Source,
            AudioChannels::Stereo,
            AudioChannels::Mono,
        ] {
            for rate in [8_000, 44_100, 192_000] {
                let plan = plan_with_output(3, rate, channels);
                let expected = audio_output_format(plan.audio.as_ref().expect("fixture audio"));
                for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                    let graph = build_filter_graph(&plan, shape);
                    assert_eq!(graph.matches("aformat=f=").count(), 3, "{graph}");
                    assert_eq!(
                        graph.matches(&format!("{expected}[a")).count(),
                        3,
                        "{graph}"
                    );
                }
            }
        }
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
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[v0][v1]concat=n=2:v=1:a=0[vc]",
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
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[v0][v1]concat=n=2:v=1:a=0[vc]",
            )
        );
        assert!(!graph.contains("asplit"));
    }

    #[test]
    fn a_plan_without_video_renders_no_video_chain_and_one_output_label_in_both_shapes() {
        // An audio-only export plans no video. The rule for a plan without it is the rule
        // for a plan without audio, applied to the other part: nothing of the part anywhere,
        // `v=0` on `concat`, no `format`, and `[a]` as the only output label.
        let mut plan = fixture_plan(2);
        plan.video = None;
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );
    }

    // -- The stream choice, through the planner -------------------------------------------

    // Absolute on the platform the tests run on, as `build_plan` requires. The graph never
    // shows a path, so only the planner reads these.
    #[cfg(windows)]
    const PLANNED_SOURCE: &str = r"C:\media\source.mp4";
    #[cfg(windows)]
    const PLANNED_DESTINATION: &str = r"C:\export\out.mp4";
    #[cfg(not(windows))]
    const PLANNED_SOURCE: &str = "/media/source.mp4";
    #[cfg(not(windows))]
    const PLANNED_DESTINATION: &str = "/export/out.mp4";

    /// [`build_plan`] over the first two fixture segments, for a source laid out as the fixture
    /// plan describes it: video stream 1 at time base 1/12800 and 25 fps, and, when `with_audio`
    /// holds, audio stream 2 at 44100 Hz. The preset writes 25 fps H.264 and 48000 Hz stereo AAC.
    ///
    /// [`build_plan`]: crate::ffmpeg::export::plan::build_plan
    fn planned(
        streams: ExportStreams,
        with_audio: bool,
    ) -> Result<ExportPlan, crate::ffmpeg::export::ExportErrorCode> {
        use crate::ffmpeg::export::plan::{
            build_plan, PathFacts, PathIdentity, PlanRequest, SegmentBoundary,
        };
        use crate::ffmpeg::probe::{AudioProbe, MediaProbe};
        use crate::settings::{
            AudioSampleRateSetting, FrameRateSetting, Preset, ResolutionSetting,
        };
        use std::path::Path;

        let probe = MediaProbe {
            format_names: vec!["mov,mp4,m4a,3gp,3g2,mj2".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: None,
            bit_depth: None,
            width: 1920,
            height: 1080,
            video_stream_index: 1,
            video_time_base: Rational::new(1, 12_800).unwrap(),
            video_start_pts: None,
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: Some(Rational::new(25, 1).unwrap()),
            r_frame_rate: Some(Rational::new(25, 1).unwrap()),
            reported_frame_count: None,
            audio: with_audio.then(|| AudioProbe {
                index: 2,
                codec: Some("aac".to_owned()),
                sample_rate: Some(44_100),
                channels: Some(2),
                start_time: None,
                duration: None,
                tagged_end: None,
                channel_layout: None,
                reported_packets: None,
                holds_no_packets: false,
            }),
        };
        let preset = Preset {
            id: "preset-1".to_owned(),
            name: "Test preset".to_owned(),
            container: Container::Mp4,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            audio_bitrate: None,
            audio_sample_rate: AudioSampleRateSetting::Fixed(48_000),
            audio_channels: AudioChannels::Stereo,
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            resolution: ResolutionSetting::Source,
            frame_rate: FrameRateSetting::Source,
            pixel_format: "yuv420p".to_owned(),
            video_options: vec![],
            audio_options: vec![],
        };
        let segments: Vec<SegmentBoundary> = fixture_segments(2)
            .iter()
            .map(|segment| SegmentBoundary {
                in_pts: segment.in_pts,
                out_pts: segment.out_pts,
            })
            .collect();
        let source = Path::new(PLANNED_SOURCE);
        let destination = Path::new(PLANNED_DESTINATION);
        let parent = destination.parent().unwrap().to_path_buf();
        build_plan(
            &PlanRequest {
                source,
                destination,
                segments: &segments,
                probe: &probe,
                preset: &preset,
                streams,
            },
            move |path: &Path| {
                if path == Path::new(PLANNED_SOURCE) {
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
    }

    #[test]
    fn video_and_audio_from_the_planner_renders_the_graph_of_every_earlier_export() {
        // The default choice changes nothing: the planned plan renders exactly the fixture plan's
        // graph, which the pinned strings above hold, in both shapes.
        let plan = planned(ExportStreams::VideoAndAudio, true).unwrap();
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            assert_eq!(
                build_filter_graph(&plan, shape),
                build_filter_graph(&fixture_plan(2), shape)
            );
        }
    }

    #[test]
    fn video_only_from_the_planner_renders_no_audio_in_both_shapes_with_and_without_source_audio() {
        let input_per_segment = concat!(
            "[vc]format=yuv420p[v];",
            "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
            "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
            "[v0][v1]concat=n=2:v=1:a=0[vc]",
        );
        let single_input = concat!(
            "[vc]format=yuv420p[v];",
            "[0:1]split=2[sv0][sv1];",
            "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
            "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
            "[v0][v1]concat=n=2:v=1:a=0[vc]",
        );
        // A video-only export of a source with audio, of a source without it, and an export of
        // both parts from a source without audio all render the one silent graph.
        for (streams, with_audio) in [
            (ExportStreams::VideoOnly, true),
            (ExportStreams::VideoOnly, false),
            (ExportStreams::VideoAndAudio, false),
        ] {
            let plan = planned(streams, with_audio).unwrap();
            assert_eq!(
                build_filter_graph(&plan, GraphShape::InputPerSegment),
                input_per_segment,
                "{streams:?}, source audio {with_audio}"
            );
            assert_eq!(
                build_filter_graph(&plan, GraphShape::SingleInput),
                single_input,
                "{streams:?}, source audio {with_audio}"
            );
        }
    }

    #[test]
    fn audio_only_from_the_planner_renders_no_video_in_both_shapes() {
        let plan = planned(ExportStreams::AudioOnly, true).unwrap();
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[1:2]aformat=r=44100,atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]aformat=r=44100,asplit=2[sa0][sa1];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-441000,",
                "aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );

        // Without audio in the source there is no graph to render: the planner refuses.
        assert_eq!(
            planned(ExportStreams::AudioOnly, false),
            Err(crate::ffmpeg::export::ExportErrorCode::SourceHasNoAudio)
        );
    }

    #[test]
    fn every_audio_chain_from_the_planner_resets_at_the_planned_in_tick() {
        // The reset subtracts the plan's own In tick, the number `atrim` cuts at, and not a
        // number of its own: a second computation of the tick could round the other way, and
        // the audio of the segment would then start one sample off its In point. Both choices
        // that write audio render the same audio chains, in both shapes.
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let plan = planned(streams, true).unwrap();
            for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                let graph = build_filter_graph(&plan, shape);
                for segment in &plan.segments {
                    let (in_tick, out_tick) = (
                        segment.audio_in_tick.expect("a planned tick"),
                        segment.audio_out_tick.expect("a planned tick"),
                    );
                    let chain = format!(
                        "atrim=start_pts={in_tick}:end_pts={out_tick},asetpts=PTS-{in_tick},\
                         aresample=44100:first_pts=0,"
                    );
                    assert_eq!(graph.matches(&chain).count(), 1, "{streams:?} {graph}");
                }
            }
        }
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "video, audio, or both")]
    fn a_plan_with_neither_part_trips_the_debug_assertion() {
        // `build_plan` refuses the one request that could produce this plan, an audio-only
        // export of a source without audio, so this is unreachable through the pipeline.
        // Rendered anyway it would produce `concat=n=1:v=0:a=0`, which ffmpeg rejects.
        let mut plan = fixture_plan(1);
        plan.video = None;
        plan.audio = None;
        plan.segments[0].audio_in_tick = None;
        plan.segments[0].audio_out_tick = None;
        let _ = build_filter_graph(&plan, GraphShape::InputPerSegment);
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
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert!(!graph.contains("scale="), "{graph}");
        assert!(!graph.contains("setsar"), "{graph}");
    }

    #[test]
    fn an_explicit_resolution_emits_scale_immediately_before_setsar() {
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).resolution = Some(Resolution { w: 1920, h: 1080 });
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1,",
                "scale=1920:1080,setsar=1[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert!(graph.contains("scale=1920:1080,setsar=1"), "{graph}");
    }

    #[test]
    fn an_ntsc_frame_rate_renders_as_an_exact_fraction_not_a_decimal() {
        let mut plan = fixture_plan(1);
        video_mut(&mut plan).timing =
            OutputTiming::ConstantFrameRate(Rational::new(30_000, 1001).unwrap());
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        assert_eq!(
            graph,
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=30000/1001[v0];",
                "[0:2]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
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
        video_mut(&mut plan).stream_index = 2;
        plan.audio = Some(fixture_audio(5, 44_100));
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:2]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:5]aformat=r=44100,atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:2]split=1[sv0];",
                "[0:5]aformat=r=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-511560,",
                "aresample=44100:first_pts=0,apad=whole_len=10584,asetpts=N,",
                "aformat=f=fltp:r=48000:cl=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
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
        video_mut(&mut scaled).resolution = Some(Resolution { w: 1280, h: 720 });
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
                    plan.audio.is_none() || graph.contains("aformat=r=44100,"),
                    "unpinned audio input link in {graph}"
                );
            }
        }
    }

    #[test]
    fn the_pixel_format_chain_is_the_first_chain_of_every_graph() {
        // The two rules `video_output_format` holds, swept rather than pinned. No segment chain
        // carries a `format`, because a filter in each chain costs its bytes once for each
        // segment, against a command-line budget that `arguments.rs` measures at the segment cap.
        // And the one `format` chain is the first chain of the graph text: ffmpeg negotiates
        // pixel formats in text order, and at the end of the graph the same chain converts a
        // segment twice when segments decode to different formats. Like the guard above, this
        // still fails if every pinned string is updated to match a regression.
        let mut scaled = fixture_plan(3);
        video_mut(&mut scaled).resolution = Some(Resolution { w: 1280, h: 720 });
        let mut silent = fixture_plan(3);
        silent.audio = None;
        for segment in &mut silent.segments {
            segment.audio_in_tick = None;
            segment.audio_out_tick = None;
        }

        for plan in [
            fixture_plan(1),
            fixture_plan(2),
            fixture_plan(3),
            scaled,
            silent,
        ] {
            for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                let graph = build_filter_graph(&plan, shape);
                assert!(
                    !graph.contains(",format="),
                    "a chain carries a format in {graph}"
                );
                assert_eq!(graph.matches("format=yuv420p").count(), 1, "{graph}");
                assert_eq!(
                    graph.split(';').next(),
                    Some("[vc]format=yuv420p[v]"),
                    "{graph}"
                );
                // `[vc]` joins exactly two filters: `concat` writes it, the format reads it.
                assert_eq!(graph.matches("[vc]").count(), 2, "{graph}");
                assert_eq!(graph.matches("[v]").count(), 1, "{graph}");
            }
        }
    }

    #[test]
    fn the_format_behind_concat_renders_the_pixel_format_it_is_given() {
        // One parameter carries the pixel format, so a preset value reaches the graph through
        // this function alone.
        assert_eq!(video_output_format("yuv420p"), "[vc]format=yuv420p[v]");
        assert_eq!(video_output_format("p010le"), "[vc]format=p010le[v]");
        assert_eq!(
            video_output_format("yuv420p10le"),
            "[vc]format=yuv420p10le[v]"
        );
    }

    #[test]
    fn the_planned_pixel_format_reaches_the_first_chain_and_nowhere_else() {
        // The preset value replaces the constant of ADR 014's template, and the chain that
        // carries it stays the first chain of the graph (measurement 19), in both shapes and
        // with or without `scale`.
        for format in ["p010le", "yuv420p10le", "nv12"] {
            let mut scaled = fixture_plan(3);
            video_mut(&mut scaled).resolution = Some(Resolution { w: 1280, h: 720 });
            for mut plan in [fixture_plan(1), fixture_plan(3), scaled] {
                video_mut(&mut plan).pixel_format = format.to_owned();
                for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                    let graph = build_filter_graph(&plan, shape);
                    let first = format!("[vc]format={format}[v]");
                    assert_eq!(graph.split(';').next(), Some(first.as_str()), "{graph}");
                    assert_eq!(graph.matches("[vc]format=").count(), 1, "{graph}");
                    assert!(!graph.contains(",format="), "{graph}");
                    assert!(!graph.contains("format=yuv420p["), "{graph}");

                    // Nothing else in the graph moves: the graph of the default format, with
                    // the one name replaced, is the same string.
                    let mut default = plan.clone();
                    video_mut(&mut default).pixel_format = "yuv420p".to_owned();
                    assert_eq!(
                        build_filter_graph(&default, shape).replacen(
                            "format=yuv420p",
                            &format!("format={format}"),
                            1
                        ),
                        graph
                    );
                }
            }
        }
    }

    #[test]
    fn every_audio_chain_starts_at_its_in_point_and_fills_the_gap_in_both_shapes() {
        // The rule `audio_chain` holds, swept rather than pinned, so this still fails if every
        // pinned string is updated to match a regression. `asetpts=PTS-STARTPTS` subtracts the
        // first sample that `atrim` passes, and that sample lies after the In point when the
        // source audio starts late or has a gap there (measurement M7). The reset must name the
        // In tick, and the fill must follow it, in front of the closing `aformat`. The video
        // chains keep `setpts=PTS-STARTPTS`: `trim` cuts at a frame that exists, so the first
        // frame it passes is the In point.
        for count in 1..=3 {
            for plan in [
                fixture_plan(count),
                plan_with_output(count, 44_100, AudioChannels::Source),
            ] {
                let audio = plan.audio.as_ref().expect("fixture audio");
                let fill = audio_gap_fill(audio);
                let closing = audio_output_format(audio);
                for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                    let graph = build_filter_graph(&plan, shape);
                    let audio_chains: Vec<&str> = graph
                        .split(';')
                        .filter(|chain| chain.contains("atrim="))
                        .collect();
                    assert_eq!(audio_chains.len(), count, "{graph}");
                    for (index, (chain, segment)) in
                        audio_chains.iter().zip(&plan.segments).enumerate()
                    {
                        let in_tick = segment.audio_in_tick.expect("fixture ticks");
                        let out_tick = segment.audio_out_tick.expect("fixture ticks");
                        // The last chain also ends at the segment's length; see
                        // `the_chains_that_concat_does_not_pad_end_at_the_planned_length`.
                        let pad = if index + 1 == count {
                            format!(",{}", audio_end_pad(in_tick, out_tick))
                        } else {
                            String::new()
                        };
                        let tail =
                            format!(",asetpts=PTS-{in_tick},{fill}{pad},{closing}[a{index}]");
                        assert!(chain.ends_with(&tail), "{chain}");
                        assert!(!chain.contains("STARTPTS"), "{chain}");
                    }
                    assert_eq!(graph.matches(&fill).count(), count, "{graph}");
                    assert_eq!(graph.matches("aresample=").count(), count, "{graph}");
                    let video_chains: Vec<&str> = graph
                        .split(';')
                        .filter(|chain| chain.contains("]trim="))
                        .collect();
                    assert_eq!(video_chains.len(), count, "{graph}");
                    for chain in video_chains {
                        assert!(chain.contains(",setpts=PTS-STARTPTS,fps="), "{chain}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_gap_fill_writes_the_source_rate_and_leaves_the_resampling_to_ffmpeg() {
        // The fixture resamples 44100 Hz to 48000 Hz. A fill at the output rate, or at no rate,
        // would take the resampling over from the converter ffmpeg inserts in front of the
        // closing `aformat`, and M7 found a downmix with a resample in one conversion a few
        // float steps away from the samples of the earlier graph. See `audio_gap_fill`.
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&fixture_plan(3), shape);
            assert_eq!(
                graph.matches("aresample=44100:first_pts=0,").count(),
                3,
                "{graph}"
            );
            assert!(!graph.contains("aresample=48000"), "{graph}");
            assert!(!graph.contains("aresample=first_pts"), "{graph}");
        }
    }

    #[test]
    fn a_negative_in_tick_resets_by_adding_its_magnitude() {
        // ADR 002 permits a source to start at a negative PTS, so an In tick can be negative;
        // `plan.rs` pins the sign of the tick itself. The reset then adds the magnitude.
        assert_eq!(audio_timestamp_reset(0), "asetpts=PTS-0");
        assert_eq!(audio_timestamp_reset(511_560), "asetpts=PTS-511560");
        assert_eq!(audio_timestamp_reset(-6), "asetpts=PTS+6");
        assert_eq!(
            audio_timestamp_reset(i64::MIN),
            "asetpts=PTS+9223372036854775808"
        );

        let mut plan = fixture_plan(1);
        plan.segments[0].audio_in_tick = Some(-6);
        plan.segments[0].audio_out_tick = Some(4);
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&plan, shape);
            assert!(
                graph.contains("atrim=start_pts=-6:end_pts=4,asetpts=PTS+6,aresample=44100:"),
                "{graph}"
            );
        }
    }

    #[test]
    fn no_graph_spells_an_aformat_option_by_its_long_name() {
        // The short names pay for the gap fill in every chain; `audio_output_format` has the
        // arithmetic, and `arguments.rs` measures the budget at the segment cap. A long name back
        // in a chain costs its bytes once for each segment.
        for channels in [
            AudioChannels::Source,
            AudioChannels::Stereo,
            AudioChannels::Mono,
        ] {
            for count in 1..=3 {
                let plan = plan_with_output(count, 48_000, channels);
                for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                    let graph = build_filter_graph(&plan, shape);
                    for long in ["sample_fmts=", "sample_rates=", "channel_layouts="] {
                        assert!(!graph.contains(long), "{long} in {graph}");
                    }
                }
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

    // -- The end pad ------------------------------------------------------------------------

    #[test]
    fn the_chains_that_concat_does_not_pad_end_at_the_planned_length() {
        // `concat` pads the audio of a segment to its video only when another segment follows,
        // so a graph with video pads its last chain, and a graph without video pads every chain
        // (measurement 23). A chain that pads nothing else stays as it was, byte for byte, which
        // is what keeps a source whose audio covers the segments unchanged.
        for count in 1..=3 {
            for with_video in [true, false] {
                let mut plan = fixture_plan(count);
                if !with_video {
                    plan.video = None;
                }
                let audio = plan.audio.clone().expect("fixture audio");
                for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
                    let graph = build_filter_graph(&plan, shape);
                    let audio_chains: Vec<&str> = graph
                        .split(';')
                        .filter(|chain| chain.contains("atrim="))
                        .collect();
                    assert_eq!(audio_chains.len(), count, "{graph}");
                    for (index, (chain, segment)) in
                        audio_chains.iter().zip(&plan.segments).enumerate()
                    {
                        let in_tick = segment.audio_in_tick.expect("fixture ticks");
                        let out_tick = segment.audio_out_tick.expect("fixture ticks");
                        let fill = audio_gap_fill(&audio);
                        let closing = audio_output_format(&audio);
                        let padded = !with_video || index + 1 == count;
                        let tail = if padded {
                            format!(
                                ",{fill},apad=whole_len={},asetpts=N,{closing}[a{index}]",
                                out_tick - in_tick
                            )
                        } else {
                            format!(",{fill},{closing}[a{index}]")
                        };
                        assert!(chain.ends_with(&tail), "{shape:?} {chain}");
                    }
                    let pads = if with_video { 1 } else { count };
                    assert_eq!(graph.matches("apad=").count(), pads, "{graph}");
                    assert_eq!(graph.matches(",asetpts=N,").count(), pads, "{graph}");
                }
            }
        }
    }

    #[test]
    fn the_pad_length_is_the_planned_tick_length_of_the_segment() {
        // The length is the difference of the two ticks `atrim` cuts at, in samples of the
        // source rate, so it never adds a sample to a chain whose audio covers the segment. A
        // negative In tick, which ADR 002 permits, still gives the length and not a position.
        assert_eq!(
            audio_end_pad(511_560, 522_144),
            "apad=whole_len=10584,asetpts=N"
        );
        assert_eq!(audio_end_pad(-6, 4), "apad=whole_len=10,asetpts=N");
        assert_eq!(audio_end_pad(0, 0), "apad=whole_len=0,asetpts=N");

        let mut plan = fixture_plan(1);
        plan.segments[0].audio_in_tick = Some(-6);
        plan.segments[0].audio_out_tick = Some(4);
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&plan, shape);
            assert!(
                graph.contains(
                    "asetpts=PTS+6,aresample=44100:first_pts=0,apad=whole_len=10,asetpts=N,aformat="
                ),
                "{graph}"
            );
        }
    }

    #[test]
    fn the_pad_follows_the_gap_fill_at_the_source_rate_and_never_the_closing_format() {
        // `whole_len` counts samples of the link `apad` reads. Behind the gap fill that link runs
        // at the source rate, the unit of the ticks; behind the closing `aformat` it would run at
        // the output rate, 48000 Hz on this 44100 Hz fixture, and the length would be wrong by
        // the ratio of the two rates.
        let plan = fixture_plan(2);
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&plan, shape);
            assert!(
                graph.contains("aresample=44100:first_pts=0,apad=whole_len=21168,asetpts=N,"),
                "{graph}"
            );
            assert!(!graph.contains("cl=stereo,apad"), "{graph}");
        }
    }
}
