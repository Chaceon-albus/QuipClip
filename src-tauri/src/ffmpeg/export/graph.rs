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
/// Every chain reads the same audio stream and renders this same filter, so every chain ends
/// at one rate and with one layout, and `concat` still receives inputs that agree. For
/// [`AudioChannels::Source`] the filter names no `channel_layouts` at all, so each chain keeps
/// the source stream's layout; ADR 023 measurement 3 found that ffmpeg then converts in front
/// of an encoder that cannot take that layout, so no filter here depends on the encoder.
///
/// A preset from before ADR 023 plans 48000 Hz and [`AudioChannels::Stereo`], and this renders
/// exactly the constant ADR 014 used to fix:
/// `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`.
///
/// This is not the same `aformat` as [`audio_input_pin`], which carries the *source* rate and
/// stands at the head of the chain. Both are needed, for opposite reasons: this one converts
/// the cut audio to the one format `concat` joins at; that one stops ffmpeg from converting
/// the audio *before* the cut, which would read the boundary ticks in the wrong unit.
fn audio_output_format(audio: &PlannedAudio) -> String {
    let layout = match audio.output_channels {
        AudioChannels::Source => "",
        AudioChannels::Stereo => ":channel_layouts=stereo",
        AudioChannels::Mono => ":channel_layouts=mono",
    };
    format!(
        "aformat=sample_fmts=fltp:sample_rates={}{layout}",
        audio.output_sample_rate
    )
}

/// Which of ADR 014's two graph shapes to render.
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
/// the larger graph for the first three segments, and the smaller graph from four segments
/// upward: 28327 bytes against 29789 bytes at the segment cap, since the pixel format moved
/// behind `concat` (it was 29804 against 31266 with a `format` in each chain, and the move takes
/// the same 1477 bytes from both). What `SingleInput` saves lies
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
    /// three segments and slightly *smaller* from four segments upward (ADR 014 measurement
    /// 15); what it saves at every count is the repeated input path and the flags around it.
    /// It needs the single seek [`ExportPlan::single_input_seek_seconds`] returns, not any one
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
/// why version 1 needs no silence generation here -- it exports one source, so a segment
/// without audio cannot occur between segments with audio -- and ADR 004's silence generation
/// belongs to the multi-source work.
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

    if shape == GraphShape::SingleInput {
        if let Some(video) = video {
            chains.push(splitter_chain(video.stream_index, "", "split", "sv", count));
        }
        if let Some((planned, _)) = &audio {
            // The rate pin goes in front of `asplit`, not on each branch behind it: this
            // chain's head *is* the input link, so one filter pins it directly. See
            // `audio_input_pin`.
            chains.push(splitter_chain(
                planned.stream_index,
                &audio_input_pin(planned),
                "asplit",
                "sa",
                count,
            ));
        }
    }

    for (index, segment) in plan.segments.iter().enumerate() {
        if let Some(video) = video {
            chains.push(video_chain(video, shape, index, *segment));
        }
        if let Some((planned, ticks)) = &audio {
            chains.push(audio_chain(planned, shape, index, ticks[index]));
        }
    }

    chains.push(concat_chain(count, video.is_some(), audio.is_some()));
    chains.join(";")
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
fn audio_input_pin(audio: &PlannedAudio) -> String {
    format!("aformat=sample_rates={},", audio.sample_rate)
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
    let source = match shape {
        GraphShape::InputPerSegment => format!("[{index}:{}]", video.stream_index),
        GraphShape::SingleInput => format!("[sv{index}]"),
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

/// Render one segment's audio chain, from its input link to its `[a<index>]` output label.
///
/// Under [`GraphShape::InputPerSegment`] this chain starts at an input link, so it carries
/// [`audio_input_pin`] itself. Under [`GraphShape::SingleInput`] it starts behind `asplit`,
/// and the splitter chain already pinned the one input link they share; repeating the pin
/// here would only add a filter for each segment to a graph ADR 014 measurement 15 already
/// counts in bytes against the Windows command-line limit.
fn audio_chain(audio: &PlannedAudio, shape: GraphShape, index: usize, ticks: (i64, i64)) -> String {
    let source = match shape {
        GraphShape::InputPerSegment => {
            format!("[{index}:{}]{}", audio.stream_index, audio_input_pin(audio))
        }
        GraphShape::SingleInput => format!("[sa{index}]"),
    };
    let (in_tick, out_tick) = ticks;
    let head = format!("{source}atrim=start_pts={in_tick}:end_pts={out_tick}");
    let format = audio_output_format(audio);
    format!("{head},asetpts=PTS-STARTPTS,{format}[a{index}]")
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[2:1]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1[v2];",
                "[2:2]aformat=sample_rates=44100,atrim=start_pts=882000:end_pts=903168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2];",
                "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][a]",
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
                "[0:2]aformat=sample_rates=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
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
                "[0:2]aformat=sample_rates=44100,asplit=3[sa0][sa1][sa2];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[sv2]trim=start_pts=256000:end_pts=262144,setpts=PTS-STARTPTS,fps=25/1[v2];",
                "[sa2]atrim=start_pts=882000:end_pts=903168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2];",
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
        plan.audio = Some(fixture_audio(2, 32_000));
        plan.segments[0].audio_in_tick = Some(371_200);
        plan.segments[0].audio_out_tick = Some(378_880);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=sample_rates=32000,atrim=start_pts=371200:end_pts=378880,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=1[sv0];",
                "[0:2]aformat=sample_rates=32000,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=371200:end_pts=378880,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert!(!build_filter_graph(&plan, GraphShape::InputPerSegment).contains("48000"));
    }

    #[test]
    fn source_channels_name_no_channel_layout_in_both_shapes() {
        // The seeds' own format: the source rate and the source layout. With no
        // `channel_layouts` option each chain keeps the stream's layout, so a 5.1 source stays
        // 5.1 through an encoder that takes it (ADR 023 measurement 3).
        let plan = plan_with_output(2, 44_100, AudioChannels::Source);
        assert_eq!(
            build_filter_graph(&plan, GraphShape::InputPerSegment),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100[a0];",
                "[1:1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=44100[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=2[sv0][sv1];",
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100[a0];",
                "[sv1]trim=start_pts=128000:end_pts=134144,setpts=PTS-STARTPTS,fps=25/1[v1];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=44100[a1];",
                "[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][a]",
            )
        );

        // Source channels with a fixed rate: the option is still absent, and the rate is the
        // plan's own.
        let fixed_rate = plan_with_output(1, 96_000, AudioChannels::Source);
        for shape in [GraphShape::InputPerSegment, GraphShape::SingleInput] {
            let graph = build_filter_graph(&fixed_rate, shape);
            assert!(!graph.contains("channel_layouts"), "{graph}");
            assert!(
                graph.contains(",aformat=sample_fmts=fltp:sample_rates=96000[a0];"),
                "{graph}"
            );
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:1]split=1[sv0];",
                "[0:2]aformat=sample_rates=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
    }

    #[test]
    fn every_chain_of_one_graph_ends_in_the_same_audio_format() {
        // `concat` needs inputs that agree. Every chain reads the same stream and renders the
        // same closing filter, so one graph must hold exactly one spelling of it, once for each
        // segment, whatever the format.
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
                    assert_eq!(graph.matches("aformat=sample_fmts=").count(), 3, "{graph}");
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[1:2]aformat=sample_rates=44100,atrim=start_pts=441000:end_pts=462168,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
                "[a0][a1]concat=n=2:v=0:a=1[a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[0:2]aformat=sample_rates=44100,asplit=2[sa0][sa1];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[sa1]atrim=start_pts=441000:end_pts=462168,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:1]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,",
                "fps=30000/1001[v0];",
                "[0:2]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                "[0:5]aformat=sample_rates=44100,atrim=start_pts=511560:end_pts=522144,",
                "asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
                "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
            )
        );
        assert_eq!(
            build_filter_graph(&plan, GraphShape::SingleInput),
            concat!(
                "[vc]format=yuv420p[v];",
                "[0:2]split=1[sv0];",
                "[0:5]aformat=sample_rates=44100,asplit=1[sa0];",
                "[sv0]trim=start_pts=148480:end_pts=151552,setpts=PTS-STARTPTS,fps=25/1[v0];",
                "[sa0]atrim=start_pts=511560:end_pts=522144,asetpts=PTS-STARTPTS,",
                "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0];",
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
                    plan.audio.is_none() || graph.contains("aformat=sample_rates=44100,"),
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
