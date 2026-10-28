//! Build a pure [`ExportPlan`] from a source probe, a preset, and the requested segments.
//!
//! [`build_plan`] performs ADR 014's preflight checks and its timestamp arithmetic with no
//! side effect of its own: every filesystem fact it needs travels through the injected
//! `inspect` closure, the same pattern `capabilities::probe_capabilities_with` uses for its
//! injected `run_list`, `run_smoke`, and `emit`. A caller with a real filesystem supplies a
//! closure that calls `std::fs::metadata`; a test supplies a closure backed by a fixed table
//! and never touches disk. [`PathFacts`] is an enum, not three independent booleans,
//! specifically so an existing file with no usable identity cannot be represented; see its
//! doc comment for why that distinction is load-bearing.

use super::copy::{self, CopyQuestion};
use super::{
    ExportAudioMode, ExportErrorCode, ExportPlan, ExportStreams, OutputTiming, PlannedAudio,
    PlannedSegment, PlannedSource, PlannedVideo, SourceAudio, VideoFit,
    AUDIO_PREFIX_MARGIN_MILLISECONDS, MAX_AUDIO_PREFIXES, MAX_EXPORT_PIECES,
    MAX_HELD_AUDIO_SILENCE_SECONDS, SEEK_MARGIN_SECONDS,
};
use crate::ffmpeg::probe::{AudioFrames, AudioGap, AudioProbe, MediaProbe};
use crate::project::Resolution;
use crate::settings::{
    AudioChannels, AudioSampleRateSetting, FrameRateSetting, Preset, ResolutionSetting,
};
use crate::time::{pts_seconds, Pts, Rational};
use std::path::Path;

/// One requested piece, before [`build_plan`] derives a seek position or audio ticks from it.
///
/// A piece is one interval of one source (ADR 052, ADR 053). This is deliberately narrower than
/// `project::Segment`: a plan request only needs the source and the two PTS values that name the
/// interval, not a segment's id. ADR 002's half-open convention applies here exactly as it does to
/// `project::Segment`: `in_pts` is inclusive, `out_pts` is the PTS of the first excluded
/// presented frame, and a valid boundary has `in_pts < out_pts`. Both PTS values are in the time
/// base of the source that `source` names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentBoundary {
    /// The index of the source of the piece in [`PlanRequest::sources`].
    pub source: usize,
    pub in_pts: Pts,
    pub out_pts: Pts,
}

/// One source of a plan request, with what the export read of it in preparation.
#[derive(Debug, Clone, Copy)]
pub struct PlanSource<'a> {
    /// The media file. Must be an absolute path.
    pub path: &'a Path,
    /// The source's probe, from a re-probe taken when the export starts (ADR 014's
    /// "Other rules": the renderer re-probes rather than trusting stale project metadata).
    pub probe: &'a MediaProbe,
    /// What the export read about the frames of the audio stream of [`MediaProbe::audio`] inside
    /// the pieces of this source, from `ffmpeg::probe::probe_audio_gaps`. Empty when the export
    /// read none, or the read failed.
    ///
    /// The fill of a chain holds the silence of each gap of [`AudioFrames::gaps`] in memory, so the
    /// plan bounds the longest gap of each piece with the silence in front of the first sample
    /// (check 15). The decision on a copy of the audio reads the rest (step 13a).
    pub audio_frames: &'a AudioFrames,
}

/// The plain data [`build_plan`] needs to plan one export.
///
/// `segments` carries request order, and [`ExportPlan::segments`] preserves that order
/// exactly: ADR 014's "The command" section concatenates the rendered pieces in project
/// array order, so this function must never reorder or deduplicate them. Concat order need
/// not match source-PTS order; see [`ExportPlan::input_seek_seconds`] for a case
/// where that distinction matters.
pub struct PlanRequest<'a> {
    /// The sources of the pieces, in the order of their first piece. Every source has a piece.
    pub sources: &'a [PlanSource<'a>],
    /// The final output location. Must also be an absolute path.
    pub destination: &'a Path,
    /// The requested pieces, in concat order.
    pub segments: &'a [SegmentBoundary],
    /// The export preset selecting the container, the encoders, the quality, and the two
    /// output settings.
    pub preset: &'a Preset,
    /// Which streams of the sources the export writes, as the user chose them. This decides
    /// which parts of [`ExportPlan`] exist; see [`ExportStreams`].
    pub streams: ExportStreams,
    /// Whether the request asks to copy the audio rather than encode it (ADR 048, step 13a).
    pub audio_mode: ExportAudioMode,
}

/// An opaque, comparable identity for one file on disk, used only to detect that two
/// different path strings name the same underlying file.
///
/// A real `inspect` implementation packs a platform file identity into this value -- for
/// example a device and inode number on a Unix filesystem, or a file index obtained from
/// `GetFileInformationByHandle` on Windows -- so that a symlink, a hard link, or a
/// case-insensitive filesystem cannot defeat the "destination equals source" check by
/// spelling the same file two different ways. This type carries no meaning of its own
/// beyond equality: [`build_plan`] never inspects the wrapped value, only compares two of
/// them. [`PathFacts::File`] requires one of these for every existing file precisely so
/// that obligation cannot be skipped; see that type's doc comment for why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PathIdentity(u128);

impl PathIdentity {
    /// Wrap a platform-specific file identity, already packed into a `u128` by the caller.
    #[must_use]
    pub const fn new(value: u128) -> Self {
        Self(value)
    }
}

/// What the filesystem reports about one path, injected into [`build_plan`] through
/// `inspect` so the function itself never touches disk.
///
/// This is an enum, not three independent booleans, on purpose. [`PathFacts::File`] always
/// carries a [`PathIdentity`], so "this path exists and is a regular file, but there is no
/// usable identity for it" is not a value this type can hold at all. The struct this
/// replaced *could* hold that combination (`exists: true, is_file: true, identity: None`),
/// and so could a real, existing destination file on a filesystem where identity lookup is
/// expensive or was simply skipped -- and that value compared equal, under "no identity,"
/// to a destination that does not exist yet. `build_plan`'s same-file check could then not
/// tell "different file" from "I could not tell," and treated both as safe to write to.
///
/// Concretely: a Windows `inspect` built on `std::fs::metadata` alone cannot produce a file
/// index -- that needs `GetFileInformationByHandle` on an open handle -- so a naive
/// implementation reports `identity: None` for a real, existing destination file. If that
/// destination is actually the source under a different name (a hard link, or a
/// case-insensitive-volume collision such as `SOURCE.mp4` beside `source.mp4` on NTFS or
/// APFS), the plan would still pass, and the renderer would rename its temporary output
/// over the user's own source: unrecoverable data loss with no error reported. Moving the
/// obligation into the type means the *caller* -- the only layer that can open a handle --
/// must produce a real identity for every path it reports as a file, or the code does not
/// compile.
///
/// **Symlinks.** This contract does not by itself say whether `inspect` follows a symlink
/// (`std::fs::metadata`) or reports the link itself (`std::fs::symlink_metadata`); that
/// choice belongs to the concrete `inspect`, which is [`super::fsinspect::inspect_path`]. It
/// is not a free choice,
/// though: `inspect` must follow symlinks when it computes identity, exactly as
/// `std::fs::metadata` does, or a symlinked destination that targets the source reports the
/// link's own identity instead of the source's, and the same-file check can be defeated the
/// same way a missing identity defeated it above. `commands::media::import_media` already
/// canonicalizes the imported source path (`fs::canonicalize` inside `validate_media`)
/// before it reaches any later pipeline, so a symlink at the *source* position is already
/// resolved by the time an export plans; a symlinked *destination* -- freshly chosen by the
/// user on each export -- is the case this contract still has to cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathFacts {
    /// The path does not exist.
    Absent,
    /// The path exists and is a regular file, with this identity.
    ///
    /// `read_only` is the attribute [`crate::fsutil::replace_file_within`] refuses a
    /// destination on (ADR 015): on Unix, no write bit set for anybody; on Windows, the
    /// read-only attribute. It is read from the path's own final component, never from a
    /// symlink's target, because the rename that publishes the export never resolves that
    /// component either -- so a symlinked destination reports the link's attribute and is
    /// replaced, exactly as `replace_file_within` replaces it. An attribute that could not be
    /// read is `false`: `replace_file_within` treats an unreadable attribute as no confirmed
    /// refusal on both platforms, and this preflight must not refuse a file that the
    /// publication would accept. [`build_plan`] reads this only in the destination position; a
    /// read-only source is an ordinary source, since the renderer only reads it.
    File {
        identity: PathIdentity,
        read_only: bool,
    },
    /// The path exists and is a directory.
    Directory,
    /// The path exists but is neither a regular file nor a directory (for example, a
    /// device node or a named pipe on a Unix filesystem).
    Other,
}

/// Build a fully resolved [`ExportPlan`], or the first preflight or computation failure.
///
/// # Preflight
///
/// Checks run in this order; the first failure wins:
///
/// 1. `segments` is empty -- [`ExportErrorCode::NoSegments`].
/// 2. `segments` holds more than [`MAX_EXPORT_PIECES`] pieces --
///    [`ExportErrorCode::TooManySegments`].
/// 3. `sources` is empty, a piece names a source index out of range, or a source has no piece --
///    [`ExportErrorCode::InvalidSources`]. Then `sources` holds more than
///    [`super::inputs::MAX_EXPORT_INPUTS`] sources -- [`ExportErrorCode::TooManySources`]. Then
///    any segment has `in_pts >= out_pts` -- [`ExportErrorCode::InvalidSegment`]. Then the pieces
///    need more runs in source order than [`super::inputs::MAX_EXPORT_INPUTS`] --
///    [`ExportErrorCode::PiecesOutOfOrder`] ([`super::inputs::check_runs`], ADR 055). This is the
///    order of `commands::export`, which refuses such a request before the plan; these checks
///    hold the precondition for any other caller.
/// 4. A source path is empty, contains a NUL byte, or is not absolute --
///    [`ExportErrorCode::SourcePathInvalid`]. Checks 4 to 6 run for each source in turn.
/// 5. A source does not exist -- [`ExportErrorCode::SourceNotFound`].
/// 6. A source is not a regular file -- [`ExportErrorCode::SourceNotFile`].
/// 7. `destination` is empty, contains a NUL byte, has no file name, has no parent, or is
///    not absolute -- [`ExportErrorCode::OutputPathInvalid`].
/// 8. `destination`'s parent is missing or is not a directory --
///    [`ExportErrorCode::OutputDirectoryMissing`].
/// 9. `destination` exists but is a directory, or is neither a regular file nor a directory
///    -- [`ExportErrorCode::OutputPathInvalid`].
/// 10. `destination` and a source name the same file --
///     [`ExportErrorCode::OutputEqualsSource`].
/// 11. `destination` exists as a regular file the user protected against writing --
///     [`ExportErrorCode::OutputReadOnly`].
/// 12. The export writes video ([`ExportStreams::writes_video`]), and the preset's frame rate
///     is [`FrameRateSetting::Source`] but no source has a valid `avg_frame_rate` or
///     `r_frame_rate`, or the resolved rate is not strictly positive --
///     [`ExportErrorCode::SourceFrameRateUnknown`]. `source` is the highest nominal rate among
///     the sources (ADR 053), and a source with no rate does not take part. An audio-only export
///     times no frames, so it skips this check.
/// 13. The export is [`ExportStreams::AudioOnly`], and no source has an audio stream that holds
///     packets ([`AudioProbe::holds_no_packets`]) -- [`ExportErrorCode::SourceHasNoAudio`]. This
///     check opens the audio step, because it is the one question about the audio that comes
///     before its sample rate: a stream that is absent has no rate to ask about. An export of
///     only the audio of empty streams would write a file of silence and nothing else.
///
///     Step 13a is no check: a request with [`ExportAudioMode::Copy`] asks [`copy::decide`]
///     whether the plan copies the audio (ADR 048), with the probe of the source of the first
///     piece; it refuses any request of more than one piece (ADR 053). When it copies, the plan
///     carries [`ExportPlan::copied_audio`] and no [`ExportPlan::audio`], so checks 14 and 15,
///     which are about the decode of the stream, do not run. When it does not, the plan carries
///     the reason in [`ExportPlan::audio_copy_refusal`], and every later step runs as for an
///     encode.
/// 14. The export writes audio ([`ExportStreams::writes_audio`]), and a source reports an
///     audio stream whose sample rate is absent, not positive, or larger than `u32` --
///     [`ExportErrorCode::SourceAudioRateUnknown`]. A video-only export never reads the
///     audio stream, so it skips this check.
/// 15. The export writes audio, and the silence that the fills hold in memory adds up to more
///     than [`MAX_HELD_AUDIO_SILENCE_SECONDS`] -- [`ExportErrorCode::AudioGapTooLong`]. That
///     silence has two parts. The first is the part of each piece that reaches the first sample
///     of the audio stream of its source, before that sample, less its silence prefix
///     ([`PlannedSegment::audio_prefix`]). A piece that ends at or before the sample counts
///     nothing, because the end pad of its chain writes its silence frame by frame, without
///     holding it (`graph::audio_end_pad`). The second is the longest gap of
///     [`PlanSource::audio_frames`] that the piece holds audio behind (`longest_held_gap`). Each
///     piece counts the longer of the two, because one chain holds one of them at a time. The
///     sum is checked once every piece is planned, because the prefixes go to the longest
///     silences of all pieces. A probe that reports no start of the stream bounds no silence in
///     front of the first sample, and a stream that holds no packets, or a source without a
///     stream, bounds nothing: its chains generate their silence frame by frame.
///
/// `destination` must be absolute for the same reason `source` must: a CWD-relative path
/// would carry an ambiguous location into a pipeline that spawns a child process and later
/// renames a file, and `fsutil::parent_directory` already treats an empty parent as
/// deliberately unusable rather than "the current directory."
///
/// This function deliberately does not validate a segment boundary against
/// `probe.video_duration_ticks` or `probe.video_start_pts`. ADR 002 states that duration
/// metadata describes the reported source extent and "is not an edit boundary"; treating it
/// as one here would let unreliable container metadata reject a boundary the user actually
/// selected against real decoded frames.
///
/// # Computation
///
/// For each segment, in order: the exact duration in seconds, the input seek position (ADR
/// 014's "The seek", clamped at zero and reported as `None` when clamped), and the audio
/// tick boundary when [`ExportPlan::audio`] is `Some`. `total_duration` is the exact
/// rational sum of every segment's duration, and [`PlannedVideo::expected_frames`] rounds
/// each segment's frame count individually before summing -- never the reverse, since
/// rounding the total instead can produce a different, and wrong, expected count.
/// [`PlannedAudio::expected_duration`] is `total_duration`: the graph writes the audio of every
/// segment at its whole length, whatever part of it the source audio stream reaches
/// (`graph::audio_end_pad`).
///
/// Each piece is timed with the probe of its own source: its video time base, its container
/// start, its stream indices and its audio sample rate. No step compares a PTS of one source with
/// a PTS of another (ADR 002, ADR 053).
///
/// The plan carries [`ExportPlan::video`] exactly when the export writes video, with the canvas
/// and the fit steps of ADR 053 (`video_geometry`). It carries [`ExportPlan::audio`] exactly when
/// the export writes audio, a source reports an audio stream, and the plan does not copy it (step
/// 13a). Check 13 makes the rules leave no plan that writes nothing: the one choice without video
/// is refused when there is no audio to write, and otherwise its plan encodes or copies the audio.
/// A source whose stream holds no packets carries [`SourceAudio::silence_layout`], and the chains
/// of its pieces generate silence instead of reading the stream. A piece of a source without an
/// audio stream generates silence at the output rate and layout.
///
/// With one source, every rule of ADR 053 gives the value of the plan before it, except for an
/// explicit preset size, which now fits the picture with black bars instead of stretching it.
///
/// [`ExportStreams::VideoAndAudio`] with [`ExportAudioMode::Encode`] plans exactly what every
/// export planned before the two choices existed, so such a request renders the same command as
/// before, byte for byte.
///
/// No step here uses floating point. Every quantity is either an integer or a [`Rational`],
/// per ADR 002.
pub fn build_plan(
    request: &PlanRequest<'_>,
    inspect: impl Fn(&Path) -> PathFacts,
) -> Result<ExportPlan, ExportErrorCode> {
    let segments = request.segments;
    if segments.is_empty() {
        return Err(ExportErrorCode::NoSegments);
    }
    if segments.len() > MAX_EXPORT_PIECES {
        return Err(ExportErrorCode::TooManySegments);
    }
    let sources = request.sources;
    if sources.is_empty()
        || segments
            .iter()
            .any(|segment| segment.source >= sources.len())
        || (0..sources.len()).any(|index| !segments.iter().any(|segment| segment.source == index))
    {
        return Err(ExportErrorCode::InvalidSources);
    }
    if sources.len() > super::inputs::MAX_EXPORT_INPUTS {
        return Err(ExportErrorCode::TooManySources);
    }
    if segments
        .iter()
        .any(|segment| segment.in_pts >= segment.out_pts)
    {
        return Err(ExportErrorCode::InvalidSegment);
    }
    super::inputs::check_runs(segments)?;

    let mut source_identities = Vec::with_capacity(sources.len());
    for source in sources {
        if !source_path_is_valid(source.path) {
            return Err(ExportErrorCode::SourcePathInvalid);
        }
        match inspect(source.path) {
            PathFacts::Absent => return Err(ExportErrorCode::SourceNotFound),
            PathFacts::Directory | PathFacts::Other => return Err(ExportErrorCode::SourceNotFile),
            PathFacts::File { identity, .. } => source_identities.push(identity),
        }
    }

    let destination = request.destination;
    if destination_path_is_invalid(destination) {
        return Err(ExportErrorCode::OutputPathInvalid);
    }
    let parent = destination
        .parent()
        .expect("destination_path_is_invalid rejected a destination with no parent");
    if !matches!(inspect(parent), PathFacts::Directory) {
        return Err(ExportErrorCode::OutputDirectoryMissing);
    }

    let destination_facts = inspect(destination);
    // The renderer reserves a temporary file beside the destination
    // (`fsutil::reserve_temporary_path`), lets ffmpeg write into it, and then renames that
    // file over the destination (`PendingOutput::commit`, which calls `commit_within`, which
    // calls `fsutil::replace_file_within` with `EXPORT_PUBLISH_BUDGET`). A rename cannot replace a
    // directory with a regular file (`EISDIR` on Unix; `MoveFileEx` with
    // `MOVEFILE_REPLACE_EXISTING` is documented to fail on a directory target on Windows),
    // and a device node, a socket, or a named pipe is not a file the renderer can rename
    // over either. The reservation only touches the destination's *parent*, so it would
    // still succeed here, and the whole encode -- potentially minutes of it -- would run
    // before the final rename failed. Reject the destination now instead, which is what
    // this preflight exists for. There is no dedicated code for this case:
    // `OutputPathInvalid` already means "the destination is not a usable output file
    // path," whichever way the path is unusable.
    match destination_facts {
        PathFacts::Directory | PathFacts::Other => return Err(ExportErrorCode::OutputPathInvalid),
        PathFacts::Absent | PathFacts::File { .. } => {}
    }

    // Any source, not only the first: the rename would replace whichever source the destination
    // names.
    let same_identity = matches!(
        destination_facts,
        PathFacts::File { identity, .. } if source_identities.contains(&identity)
    );
    if sources.iter().any(|source| source.path == destination) || same_identity {
        return Err(ExportErrorCode::OutputEqualsSource);
    }

    // The same argument as the check above, for the other file the rename can refuse. ADR 015
    // makes `fsutil::replace_file_within` refuse to replace a destination the user protected,
    // on both platforms, and `PendingOutput::commit`'s own documentation asks a planning stage
    // to reject such a destination ahead of the render. This is that stage: without the check
    // here, a user who protected their output file waits out the whole encode and then reads
    // `outputRenameFailed`, and the cleanup guard deletes the render on the way out.
    //
    // `read_only` is the very attribute the replacement guard reads, taken from the
    // destination's own final component, so the preflight and the publication cannot disagree
    // about which files are refused; `PathFacts::File` carries what that means, including why
    // an unreadable attribute reads as `false` here. This runs after the same-file check on
    // purpose: a destination that *is* a source is the more dangerous condition and the more
    // specific report, whether or not the source happens to be protected.
    //
    // The late guard in `commit` stays. This check closes the common path, where the user
    // protected the file before the export started; the file can still be protected between
    // this check and the rename, and that window is what the late guard is for.
    if matches!(
        destination_facts,
        PathFacts::File {
            read_only: true,
            ..
        }
    ) {
        return Err(ExportErrorCode::OutputReadOnly);
    }

    let preset = request.preset;
    let streams = request.streams;
    // Only an export that writes video times frames. An audio-only export reads neither rate,
    // so a source whose frame rate is unknown can still export its audio.
    let output_frame_rate = if streams.writes_video() {
        let rate = match preset.frame_rate {
            FrameRateSetting::Rate(rate) => rate,
            FrameRateSetting::Source => {
                highest_nominal_rate(sources).ok_or(ExportErrorCode::SourceFrameRateUnknown)?
            }
        };
        // A non-positive frame rate cannot time anything (the graph builder would have to emit
        // `fps=0` or worse). `settings::validate_settings` already rejects a non-positive rate
        // for a saved preset, and `probe::normalize` already filters the probe's own rates to
        // strictly positive ones, but `PlanRequest` accepts any `&Preset` and any `&MediaProbe`,
        // so this function re-checks cheaply here rather than trusting either precondition
        // silently. There is no dedicated "invalid frame rate" code, so this reuses
        // `SourceFrameRateUnknown`: whichever path produced the value, the renderer still has no
        // usable rate to time the output with.
        if rate.num() <= 0 {
            return Err(ExportErrorCode::SourceFrameRateUnknown);
        }
        Some(rate)
    } else {
        None
    };

    let zero = zero_rational();
    let margin = seek_margin_rational();
    // An audio-only export of sources with no audio would write nothing at all, so it is
    // refused here, before the rate question below can be asked of a stream that is absent. A
    // stream that holds no packets is no audio either: the export would be silence alone.
    if streams == ExportStreams::AudioOnly
        && sources.iter().all(|source| {
            source
                .probe
                .audio
                .as_ref()
                .is_none_or(|audio| audio.holds_no_packets)
        })
    {
        return Err(ExportErrorCode::SourceHasNoAudio);
    }
    // Step 13a: a request that asks to copy the audio gets a copy when `copy::decide` agrees, and
    // an encode otherwise, with the reason for the log. A copy plans no `PlannedAudio`, so the
    // checks below that read the audio stream, the rate and the silence of the fills, are those of
    // an encode only (ADR 048). `copy::decide` refuses more than one piece, so the source of the
    // first piece is the source of the one piece it can copy (ADR 053).
    let first_source = &sources[segments[0].source];
    let copy = match request.audio_mode {
        ExportAudioMode::Encode => None,
        ExportAudioMode::Copy => Some(copy::decide(&CopyQuestion {
            probe: first_source.probe,
            streams,
            container: preset.container,
            segments,
            frames: first_source.audio_frames,
        })),
    };
    let audio_copy_refusal = copy
        .as_ref()
        .and_then(|answer| answer.as_ref().err().copied());
    let copied_audio = copy.and_then(Result::ok);
    // An audio stream with no usable sample rate is refused, not dropped. ADR 014 cuts audio
    // at integer ticks of `1 / sample_rate` and forbids the microsecond `atrim` fallback, so
    // there is no exact way to cut this track. Planning it away instead would set `concat=a=0`
    // and emit neither `-map "[a]"` nor `-c:a`, and the export would then exit zero with a
    // video-only file for a source whose audio the preview played -- the same silent failure
    // ADR 014 rules out for the short stream specifier one paragraph earlier.
    //
    // A video-only export is the one exception, and it is not the silent failure: the user
    // asked for a file without sound, so the audio stream is never read and its rate is never
    // needed.
    //
    // The output format is resolved here too, so the graph renders numbers and never reads the
    // preset (`plan_audio`). The rate range and the bitrate range are not re-checked here:
    // `settings::validate_settings` bounds both, and `commands::export` plans only from the
    // preset of a request that `start_export` checked with `settings::validate_preset`, which
    // applies the same rules.
    let writes_audio = streams.writes_audio()
        && copied_audio.is_none()
        && sources.iter().any(|source| source.probe.audio.is_some());
    let (audio, source_audio) = if writes_audio {
        let (audio, source_audio) = plan_audio(sources, preset)?;
        (Some(audio), source_audio)
    } else {
        (None, vec![None; sources.len()])
    };
    // The silence in front of the first sample, for each piece that reaches that sample, in
    // piece order. The prefixes and the bound read it once every piece is planned.
    let mut leading_silences: Vec<Option<Rational>> = Vec::with_capacity(segments.len());
    // The pieces that can carry a silence prefix, with the rate of their source.
    let mut prefix_rates: Vec<Option<u32>> = Vec::with_capacity(segments.len());
    // The longest gap inside the stream that the fill of each piece holds, in piece order.
    // The bound reads it with the silence in front of the first sample.
    let mut longest_gaps: Vec<Rational> = Vec::with_capacity(segments.len());

    let mut planned_segments = Vec::with_capacity(segments.len());
    let mut total_duration = zero;
    let mut total_frames: u64 = 0;

    for segment in segments {
        let source = &sources[segment.source];
        let probe = source.probe;
        // Every value of a piece comes from the probe of its own source (ADR 053).
        let video_time_base = probe.video_time_base;
        let format_start_time = probe.format_start_time.unwrap_or(zero);
        // From here on, the source audio is the stream the chain of this piece reads. A stream
        // that holds no packets is read by no chain, so nothing below waits for it or fills in
        // front of it, and neither does a source without a stream.
        let read_audio = source_audio[segment.source]
            .as_ref()
            .filter(|audio| audio.reads_stream())
            .and(probe.audio.as_ref());
        // The first sample of the source audio, for the bound on the silence in front of it
        // (`MAX_HELD_AUDIO_SILENCE_SECONDS`). Only a piece that reads audio has one.
        let audio_start = read_audio.and_then(|audio| audio.start_time);

        // Every `Option`-returning step below can fail for more reasons than one segment's
        // own PTS values overflowing. `probe.video_time_base` is not re-validated here: a
        // `MediaProbe` built outside `probe::normalize` (a test, or a future caller) could
        // carry a non-positive time base, and `pts_seconds` returns `None` for that. An
        // extreme `format_start_time` could also overflow the subtraction below on its own,
        // independent of any single segment. There is no dedicated overflow code in
        // `ExportErrorCode`, and that is deliberate: a sweep of realistic time bases, start
        // times, frame rates, and sample rates out to 30 days of media found no overflow
        // anywhere in this function. `InvalidSegment` is reported here only as a
        // last-resort fallback for an input this function cannot make sense of; its
        // closest existing meaning, "this segment's numbers cannot be used to render," fits
        // an unrepresentable timestamp too.
        let in_seconds =
            pts_seconds(segment.in_pts, video_time_base).ok_or(ExportErrorCode::InvalidSegment)?;
        let out_seconds =
            pts_seconds(segment.out_pts, video_time_base).ok_or(ExportErrorCode::InvalidSegment)?;
        let duration = out_seconds
            .sub(in_seconds)
            .ok_or(ExportErrorCode::InvalidSegment)?;

        // The part of a segment before the first sample of the audio becomes silence. A segment
        // that ends at or before the sample needs nothing here: the end pad of its chain writes its
        // silence frame by frame (`graph::audio_end_pad`), and every chain that reads the stream
        // carries that pad, in an export without video and in the audio process of an export with
        // video (ADR 043).
        let leading_silence =
            match audio_start.filter(|start| *start > in_seconds && *start < out_seconds) {
                Some(start) => Some(
                    start
                        .sub(in_seconds)
                        .ok_or(ExportErrorCode::InvalidSegment)?,
                ),
                None => None,
            };
        leading_silences.push(leading_silence);
        prefix_rates.push(
            read_audio
                .filter(|audio| takes_audio_prefixes(audio))
                .and_then(|audio| audio.sample_rate),
        );
        longest_gaps.push(match read_audio {
            Some(_) => longest_held_gap(
                &source.audio_frames.gaps,
                in_seconds,
                out_seconds,
                audio_start,
            )
            .ok_or(ExportErrorCode::InvalidSegment)?,
            None => zero,
        });

        let raw_seek = in_seconds
            .sub(format_start_time)
            .and_then(|value| value.sub(margin))
            .ok_or(ExportErrorCode::InvalidSegment)?;
        // ADR 014's "The seek" section clamps at zero and requires the renderer to omit
        // `-ss` for a clamped input rather than emit a trailing `-ss 0` (measurement 7).
        // `Rational` always stores a positive denominator, so the sign lives entirely in
        // the numerator: `num() > 0` is an exact "is this strictly positive" test, so an
        // exact zero clamps to `None` exactly like a negative value does.
        let seek_seconds = (raw_seek.num() > 0).then_some(raw_seek);

        let (audio_in_tick, audio_out_tick) = match (&audio, &source_audio[segment.source]) {
            (Some(_), Some(stream)) => {
                let in_tick = audio_tick(segment.in_pts, video_time_base, stream.sample_rate)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                let out_tick = audio_tick(segment.out_pts, video_time_base, stream.sample_rate)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                (Some(in_tick), Some(out_tick))
            }
            // A source without an audio stream reads nothing, and its silence is generated at the
            // output rate. Its length is the duration of the piece at that rate, rounded half away
            // from zero (ADR 002), and the ticks run from 0 to it (ADR 053).
            (Some(planned), None) => {
                let rate = Rational::new(i64::from(planned.output_sample_rate), 1)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                let length = duration
                    .mul(rate)
                    .and_then(round_rational_to_i128)
                    .and_then(|value| i64::try_from(value).ok())
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                (Some(0), Some(length))
            }
            // `ExportPlan::audio` is `None`: no source has an audio stream, the export is video
            // only, or the plan copies the audio. Both ticks stay `None` too, distinct from an
            // overflow above, which is reported as an error rather than silently `None`.
            (None, _) => (None, None),
        };

        let frames = match output_frame_rate {
            Some(rate) => {
                let segment_frames_exact =
                    duration.mul(rate).ok_or(ExportErrorCode::InvalidSegment)?;
                let segment_frames = round_rational_to_i128(segment_frames_exact)
                    .and_then(|value| u64::try_from(value).ok())
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                total_frames = total_frames
                    .checked_add(segment_frames)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                Some(segment_frames)
            }
            None => None,
        };

        total_duration = total_duration
            .add(duration)
            .ok_or(ExportErrorCode::InvalidSegment)?;

        planned_segments.push(PlannedSegment {
            source: segment.source,
            in_pts: segment.in_pts,
            out_pts: segment.out_pts,
            seek_seconds,
            audio_in_tick,
            audio_out_tick,
            frames,
            audio_prefix: None,
        });
    }

    if audio.is_some() {
        assign_audio_prefixes(&mut planned_segments, &leading_silences, &prefix_rates)?;
        // What the fill of each chain holds in memory: the silence in front of the first sample,
        // less the prefix, which streams, or the longest gap inside the stream, whichever is
        // longer. One chain holds one of them at a time (`longest_held_gap`). The chains of all
        // pieces can build their fills at the same time, so the bound is on the sum.
        let max_held_silence = max_held_audio_silence_rational();
        let mut held = zero;
        for ((segment, silence), longest_gap) in planned_segments
            .iter()
            .zip(&leading_silences)
            .zip(&longest_gaps)
        {
            let leading = match (silence, segment.audio_prefix) {
                (None, _) => zero,
                (Some(silence), None) => *silence,
                (Some(silence), Some(prefix)) => {
                    let rate = source_audio[segment.source]
                        .as_ref()
                        .map(|audio| audio.sample_rate)
                        .ok_or(ExportErrorCode::InvalidSegment)?;
                    Rational::new(prefix, i64::from(rate))
                        .and_then(|streamed| silence.sub(streamed))
                        .ok_or(ExportErrorCode::InvalidSegment)?
                }
            };
            held = held
                .add(leading.max(*longest_gap))
                .ok_or(ExportErrorCode::InvalidSegment)?;
        }
        if held > max_held_silence {
            return Err(ExportErrorCode::AudioGapTooLong);
        }
    }

    // The canvas and the fit step of each source, only for a plan that writes video.
    let (canvas, fits) = if output_frame_rate.is_some() {
        video_geometry(sources, preset.resolution).ok_or(ExportErrorCode::InvalidSegment)?
    } else {
        (None, vec![None; sources.len()])
    };
    // Every audio chain that reads the stream ends at the length of its segment
    // (`graph::audio_end_pad`), and `concat` pads it further to the length of its video where
    // there is video. A late start, an early end, and a segment that the audio does not reach at
    // all therefore write silence, and the audio of every segment runs for the whole segment (ADR
    // 014 measurement 23).
    let audio = audio.map(|audio| PlannedAudio {
        expected_duration: total_duration,
        ..audio
    });
    let planned_sources = sources
        .iter()
        .zip(source_audio)
        .zip(fits)
        .map(|((source, audio), fit)| PlannedSource {
            path: source.path.to_path_buf(),
            video_stream_index: source.probe.video_stream_index,
            fit,
            audio,
            flv_input: None,
        })
        .collect();

    Ok(ExportPlan {
        sources: planned_sources,
        destination: destination.to_path_buf(),
        video: output_frame_rate.map(|rate| PlannedVideo {
            timing: OutputTiming::ConstantFrameRate(rate),
            canvas,
            encoder: preset.video_encoder.clone(),
            quality: preset.quality,
            pixel_format: preset.pixel_format.clone(),
            options: preset.video_options.clone(),
            expected_frames: Some(total_frames),
        }),
        audio,
        copied_audio,
        audio_copy_refusal,
        segments: planned_segments,
        container: preset.container,
        total_duration,
    })
}

/// The preset value `source` for the frame rate: the highest nominal rate among `sources`, where
/// the nominal rate of a source is its `avg_frame_rate`, else its `r_frame_rate` (ADR 014), and
/// the rates compare as exact rationals (ADR 053). A source with no rate does not take part, and
/// `None` means that no source has one.
///
/// With the highest rate, `fps` only repeats frames of a slower constant-frame-rate source, and
/// every chain gives `concat` the one rate, so `concat` never falls back to 25 frames per second.
fn highest_nominal_rate(sources: &[PlanSource<'_>]) -> Option<Rational> {
    sources
        .iter()
        .filter_map(|source| source.probe.avg_frame_rate.or(source.probe.r_frame_rate))
        .max()
}

/// The audio part of a plan that writes audio, and the [`SourceAudio`] of each source, in the
/// order of `sources` (ADR 053, ADR 023).
///
/// - The output rate of the preset value `source` is the highest rate among the sources with an
///   audio stream, with or without packets. Each of their streams needs a rate, or the plan is
///   refused with [`ExportErrorCode::SourceAudioRateUnknown`] (check 14).
/// - The layout of the preset value `source` is the layout of the source with the most channels,
///   the earlier source on a tie. The closing `aformat` names it ([`PlannedAudio::output_layout`])
///   when the layouts of those sources differ. A layout counts as the pair of the name and the
///   channel count the probe reports.
/// - A piece of a source without an audio stream generates its silence in
///   [`PlannedAudio::absent_layout`], at the output rate, and a piece of a stream without packets
///   in its [`SourceAudio::silence_layout`]. When some pieces read a stream and some generate
///   silence, and the name of a silence is not the name of the layout of the streams, the closing
///   `aformat` names the layout too. That is so for a layout without a plain name, such as
///   ffprobe's `6 channels (FL+FR+...)`, whose silence takes `6c`. So `concat` never chooses
///   between two layouts (ADR 053). Otherwise no chain names a layout, as before.
///
/// The silence of a layout of more than 8 channels without a plain name is stereo
/// (`silence_layout`). FFmpeg 9.0.2 parses `<count>c` above 8 only for 10, 12, 14, 16 and 24
/// channels, and FFmpeg 4.3 to 5.0 for none of them.
///
/// With one source, the rate is its rate and no chain names a layout, as before ADR 053: its
/// pieces either all read the stream or all generate silence.
fn plan_audio(
    sources: &[PlanSource<'_>],
    preset: &Preset,
) -> Result<(PlannedAudio, Vec<Option<SourceAudio>>), ExportErrorCode> {
    let mut source_audio = Vec::with_capacity(sources.len());
    let mut highest_rate: Option<u32> = None;
    let mut widest: Option<&AudioProbe> = None;
    let mut layouts_differ = false;
    for source in sources {
        let Some(audio) = source.probe.audio.as_ref() else {
            source_audio.push(None);
            continue;
        };
        let sample_rate = audio
            .sample_rate
            .ok_or(ExportErrorCode::SourceAudioRateUnknown)?;
        highest_rate = Some(highest_rate.map_or(sample_rate, |rate| rate.max(sample_rate)));
        match widest {
            None => widest = Some(audio),
            Some(chosen) => {
                if (&chosen.channel_layout, chosen.channels)
                    != (&audio.channel_layout, audio.channels)
                {
                    layouts_differ = true;
                }
                // Strictly more, so an earlier source wins a tie.
                if audio.channels.unwrap_or(0) > chosen.channels.unwrap_or(0) {
                    widest = Some(audio);
                }
            }
        }
        source_audio.push(Some(SourceAudio {
            stream_index: audio.index,
            sample_rate,
            silence_layout: audio
                .holds_no_packets
                .then(|| silence_layout(preset.audio_channels, audio)),
        }));
    }
    let (Some(highest_rate), Some(widest)) = (highest_rate, widest) else {
        // The caller plans audio only when a source has an audio stream.
        return Err(ExportErrorCode::SourceHasNoAudio);
    };
    let output_sample_rate = match preset.audio_sample_rate {
        AudioSampleRateSetting::Source => highest_rate,
        AudioSampleRateSetting::Fixed(rate) => rate,
    };
    let absent_layout = silence_layout(preset.audio_channels, widest);
    // The layout the streams that are read share, when they share one, and whether a silence of
    // another name meets them in `concat`.
    let read_layout = sources
        .iter()
        .filter_map(|source| source.probe.audio.as_ref())
        .find(|audio| !audio.holds_no_packets)
        .map(|audio| audio.channel_layout.as_deref());
    let silence_differs = read_layout.is_some_and(|read| {
        sources
            .iter()
            .zip(&source_audio)
            .filter_map(|(source, planned)| match (&source.probe.audio, planned) {
                (None, _) => Some(absent_layout.as_str()),
                (Some(_), Some(planned)) => planned.silence_layout.as_deref(),
                (Some(_), None) => None,
            })
            .any(|silence| read != Some(silence))
    });
    let output_layout = match preset.audio_channels {
        AudioChannels::Source => (layouts_differ || silence_differs).then(|| absent_layout.clone()),
        AudioChannels::Stereo | AudioChannels::Mono => Some(absent_layout.clone()),
    };
    Ok((
        PlannedAudio {
            output_sample_rate,
            output_channels: preset.audio_channels,
            output_layout,
            absent_layout,
            encoder: preset.audio_encoder.clone(),
            bitrate: preset.audio_bitrate,
            options: preset.audio_options.clone(),
            gain_tenths_db: preset.audio_gain_tenths_db,
            // The total duration, once the pieces are summed.
            expected_duration: zero_rational(),
        },
        source_audio,
    ))
}

/// The frame of one source as a player shows it (ADR 053): the coded size with the SAR and the
/// rotation applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DisplayGeometry {
    /// The display width: the coded width times the SAR, rounded half up, swapped with the height
    /// for a rotation of 90 or 270 degrees.
    width: u32,
    /// The display height.
    height: u32,
    /// The exact display aspect ratio: the coded width times the SAR over the coded height, or
    /// its inverse for a rotation of 90 or 270 degrees. It is not the ratio of the rounded size.
    aspect: Rational,
    /// Whether the pixels are square: no SAR, or a SAR of 1.
    square: bool,
}

/// The [`DisplayGeometry`] of `probe`, or `None` for a frame without a size. An unknown SAR
/// counts as 1.
fn display_geometry(probe: &MediaProbe) -> Option<DisplayGeometry> {
    let one = Rational::new(1, 1)?;
    let sar = probe.sample_aspect_ratio.unwrap_or(one);
    let coded_width = Rational::new(i64::from(probe.width), 1)?;
    let scaled_width = coded_width.mul(sar)?;
    let width = u32::try_from(round_half_up(scaled_width)?).ok()?;
    let aspect = scaled_width.div(Rational::new(i64::from(probe.height), 1)?)?;
    let quarter_turn = matches!(probe.rotation, 90 | 270);
    let (width, height, aspect) = if quarter_turn {
        (probe.height, width, one.div(aspect)?)
    } else {
        (width, probe.height, aspect)
    };
    (width > 0 && height > 0).then_some(DisplayGeometry {
        width,
        height,
        aspect,
        square: sar == one,
    })
}

/// Round a non-negative rational to the nearest integer, a half up.
fn round_half_up(value: Rational) -> Option<i64> {
    let numerator = i128::from(value.num());
    let denominator = i128::from(value.den());
    i64::try_from((2 * numerator + denominator).div_euclid(2 * denominator)).ok()
}

/// A side of a canvas made even, as the 4:2:0 pixel formats need it and `pad` rounds an odd side
/// down: an odd side loses one pixel, and a side of 1 becomes 2 (ADR 053).
fn even_side(side: u32) -> u32 {
    if side <= 1 {
        2
    } else {
        side - side % 2
    }
}

/// The canvas of a plan with video, and the [`VideoFit`] of each source, in the order of
/// `sources` (ADR 053), or `None` when a source has a frame without a size or the arithmetic
/// overflows.
///
/// - An explicit preset size is the canvas, with even sides.
/// - With `source`, sources that all share the coded size, the SAR and the rotation get no canvas
///   and no fit, as a single source always does. Two SARs compare after an unknown SAR is read
///   as 1, as the probe reads it.
/// - Otherwise the canvas is the display size with the largest area, the earlier source on a
///   tie, with even sides.
///
/// A source whose display size is not the canvas, or whose SAR is not 1, gets a fit step
/// ([`fit_on_canvas`]).
#[allow(clippy::type_complexity)]
fn video_geometry(
    sources: &[PlanSource<'_>],
    resolution: ResolutionSetting,
) -> Option<(Option<Resolution>, Vec<Option<VideoFit>>)> {
    let geometries: Vec<DisplayGeometry> = sources
        .iter()
        .map(|source| display_geometry(source.probe))
        .collect::<Option<_>>()?;
    let canvas = match resolution {
        ResolutionSetting::Custom(Resolution { w, h }) => Some(Resolution {
            w: even_side(w),
            h: even_side(h),
        }),
        ResolutionSetting::Source => {
            let key = |probe: &MediaProbe| {
                (
                    probe.width,
                    probe.height,
                    probe
                        .sample_aspect_ratio
                        .filter(|sar| *sar != Rational::new(1, 1).expect("1/1 is valid")),
                    probe.rotation,
                )
            };
            let first = key(sources[0].probe);
            if sources.iter().all(|source| key(source.probe) == first) {
                None
            } else {
                let mut largest = geometries[0];
                for geometry in &geometries[1..] {
                    // Strictly larger, so an earlier source wins a tie.
                    if u64::from(geometry.width) * u64::from(geometry.height)
                        > u64::from(largest.width) * u64::from(largest.height)
                    {
                        largest = *geometry;
                    }
                }
                Some(Resolution {
                    w: even_side(largest.width),
                    h: even_side(largest.height),
                })
            }
        }
    };
    let Some(canvas) = canvas else {
        return Some((None, vec![None; sources.len()]));
    };
    let fits = geometries
        .iter()
        .map(|geometry| {
            if geometry.square && geometry.width == canvas.w && geometry.height == canvas.h {
                Some(None)
            } else {
                fit_on_canvas(canvas, geometry.aspect).map(Some)
            }
        })
        .collect::<Option<_>>()?;
    Some((Some(canvas), fits))
}

/// The fit of a picture of the exact display aspect ratio `aspect` on `canvas`, whose sides are
/// even (ADR 053).
///
/// 1. The side that limits the fit takes the size of the canvas on that side: the width when the
///    picture is wider than the canvas, the height when it is narrower, both when the two aspect
///    ratios are equal.
/// 2. The other side is the exact value for `aspect`, rounded to the nearest even number, a tie
///    up, and at least 2.
/// 3. Each offset is half of the difference to the canvas, rounded down to an even number.
///
/// So a 1080x1920 picture on a 1920x1080 canvas is 1080 high and 1080 x 9/16 = 607.5 wide, which
/// rounds to 608, at x = 656.
fn fit_on_canvas(canvas: Resolution, aspect: Rational) -> Option<VideoFit> {
    let canvas_width = Rational::new(i64::from(canvas.w), 1)?;
    let canvas_height = Rational::new(i64::from(canvas.h), 1)?;
    let canvas_aspect = canvas_width.div(canvas_height)?;
    let (width, height) = match aspect.cmp(&canvas_aspect) {
        std::cmp::Ordering::Equal => (canvas.w, canvas.h),
        std::cmp::Ordering::Greater => (canvas.w, round_even(canvas_width.div(aspect)?)?),
        std::cmp::Ordering::Less => (round_even(canvas_height.mul(aspect)?)?, canvas.h),
    };
    let width = width.min(canvas.w);
    let height = height.min(canvas.h);
    let offset = |canvas_side: u32, side: u32| {
        let half = (canvas_side - side) / 2;
        half - half % 2
    };
    Some(VideoFit {
        width,
        height,
        x: offset(canvas.w, width),
        y: offset(canvas.h, height),
    })
}

/// Round a positive rational to the nearest even number, a tie up, and at least 2: twice the half
/// of the value rounded half up.
fn round_even(value: Rational) -> Option<u32> {
    let half = value.div(Rational::new(2, 1)?)?;
    let even = round_half_up(half)?.checked_mul(2)?;
    u32::try_from(even.max(2)).ok()
}

/// `source` must be a non-empty, NUL-free, absolute path.
///
/// `OsStr::as_encoded_bytes` reports the platform-native byte representation without
/// requiring the path to be valid Unicode, so this check works the same way on a Windows
/// UTF-16 path and a Unix arbitrary-bytes path.
fn source_path_is_valid(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.as_os_str().as_encoded_bytes().contains(&0)
        && path.is_absolute()
}

/// `destination` must be non-empty, NUL-free, absolute, and must have both a file name and
/// a parent.
fn destination_path_is_invalid(path: &Path) -> bool {
    path.as_os_str().is_empty()
        || path.as_os_str().as_encoded_bytes().contains(&0)
        || path.file_name().is_none()
        || path.parent().is_none()
        || !path.is_absolute()
}

/// The rational zero, `0/1`.
///
/// `Rational::new` is not a `const fn` (it runs `Rational::reduce`'s gcd loop at runtime),
/// so this is a small function rather than a true module constant; it exists so
/// [`build_plan`] does not construct and `.expect()` this value inline.
fn zero_rational() -> Rational {
    Rational::new(0, 1).expect("0/1 always reduces to a valid Rational")
}

/// [`SEEK_MARGIN_SECONDS`] as a [`Rational`], for the same reason as [`zero_rational`].
fn seek_margin_rational() -> Rational {
    Rational::new(SEEK_MARGIN_SECONDS, 1)
        .expect("SEEK_MARGIN_SECONDS/1 always reduces to a valid Rational")
}

/// The longest channel layout name [`silence_layout`] copies from the probe into the graph.
const MAX_SILENCE_LAYOUT_NAME_BYTES: usize = 32;

/// The channel layout of the silence of an audio stream that holds no packets
/// ([`SourceAudio::silence_layout`]).
///
/// A preset that names a layout gets that layout, the one every chain ends in anyway. A preset
/// that keeps the source layout gets the layout that ffprobe reports for the stream, when it is a
/// plain name such as `stereo` or `5.1(side)`. A name with other characters, such as the
/// `6 channels (FL+FR+...)` that ffprobe writes for a custom order, or a name longer than
/// [`MAX_SILENCE_LAYOUT_NAME_BYTES`], does not go into the graph text. The silence then takes
/// `<count>c`, the default layout of the channel count, for 1 to 8 channels. FFmpeg 4.3 and later
/// parse that spelling for those counts. FFmpeg 4.3 to 5.0 have no default layout for most larger
/// counts, and FFmpeg 9.0.2 refuses `64c`. For a larger count, or no count, the silence is stereo,
/// the default of the presets.
fn silence_layout(channels: AudioChannels, audio: &AudioProbe) -> String {
    match channels {
        AudioChannels::Stereo => "stereo".to_owned(),
        AudioChannels::Mono => "mono".to_owned(),
        AudioChannels::Source => audio
            .channel_layout
            .as_deref()
            .filter(|layout| is_plain_layout_name(layout))
            .map(str::to_owned)
            .or_else(|| {
                audio
                    .channels
                    .filter(|count| (1..=8).contains(count))
                    .map(|count| format!("{count}c"))
            })
            .unwrap_or_else(|| "stereo".to_owned()),
    }
}

/// The fastest source sample rate that gets silence prefixes. The `concat` of a prefix rounds its
/// timestamps to microseconds, and `asettb` gives back whole samples exactly only below about
/// 333 kHz (`graph::audio_silence_prefix`). This is the top of the range of the presets.
const MAX_AUDIO_PREFIX_SAMPLE_RATE: u32 = 192_000;

/// Whether the chains of `audio` can carry silence prefixes: a rate up to
/// [`MAX_AUDIO_PREFIX_SAMPLE_RATE`], and a layout that `aresample` can convert the mono silence
/// to. It cannot convert it to an ambisonic layout, which ffprobe names `ambisonic <order>` with
/// any channels after it, nor to `binaural`, the one named layout of `ffmpeg -layouts` that fails.
/// FFmpeg then stops with "Output channel layout ... is not supported". Every other layout took
/// the prefix with identical samples, those of a custom order and those without a name included,
/// and so does a stream whose layout ffprobe does not report.
fn takes_audio_prefixes(audio: &AudioProbe) -> bool {
    audio
        .sample_rate
        .is_some_and(|rate| rate <= MAX_AUDIO_PREFIX_SAMPLE_RATE)
        && audio
            .channel_layout
            .as_deref()
            .is_none_or(|layout| !layout.starts_with("ambisonic") && layout != "binaural")
}

/// Whether ffprobe's name of a layout is plain: at most [`MAX_SILENCE_LAYOUT_NAME_BYTES`] of
/// letters, digits and `.()+-_`, as `stereo` and `5.1(side)` are.
fn is_plain_layout_name(layout: &str) -> bool {
    layout.len() <= MAX_SILENCE_LAYOUT_NAME_BYTES
        && layout
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".()+-_".contains(&byte))
}

/// Give a silence prefix ([`PlannedSegment::audio_prefix`]) to the pieces with the longest
/// silence in front of the first audio sample, at most [`MAX_AUDIO_PREFIXES`] of them.
///
/// `leading_silences` holds that silence in seconds for each piece that reaches the sample, in
/// piece order, and `rates` the sample rate of the source of each piece whose stream can carry a
/// prefix (`takes_audio_prefixes`), or `None`. A prefix is the silence less
/// [`AUDIO_PREFIX_MARGIN_MILLISECONDS`], in whole samples at the rate of the source of the piece,
/// rounded down, so it ends before the first packet whatever the rounding. A piece gets one only
/// when the prefix is at least one second: a shorter fill costs less memory than the prefix costs
/// bytes of the command line. The longest prefixes, compared in seconds, go first, because pieces
/// of several sources count their samples at different rates (ADR 053). Two equal prefixes go to
/// the earlier piece first. With one source, seconds order the prefixes as their samples did.
fn assign_audio_prefixes(
    segments: &mut [PlannedSegment],
    leading_silences: &[Option<Rational>],
    rates: &[Option<u32>],
) -> Result<(), ExportErrorCode> {
    let margin = Rational::new(AUDIO_PREFIX_MARGIN_MILLISECONDS, 1000)
        .expect("AUDIO_PREFIX_MARGIN_MILLISECONDS/1000 always reduces to a valid Rational");
    let mut candidates: Vec<(usize, i64, Rational)> = Vec::new();
    for (index, (silence, rate)) in leading_silences.iter().zip(rates).enumerate() {
        let (Some(silence), Some(rate)) = (silence, rate) else {
            continue;
        };
        let one_second = i64::from(*rate);
        let rate = Rational::new(one_second, 1).ok_or(ExportErrorCode::InvalidSegment)?;
        let samples = silence
            .sub(margin)
            .and_then(|prefix| prefix.mul(rate))
            .ok_or(ExportErrorCode::InvalidSegment)?;
        let prefix = i64::try_from(i128::from(samples.num()).div_euclid(i128::from(samples.den())))
            .map_err(|_| ExportErrorCode::InvalidSegment)?;
        if prefix >= one_second {
            let seconds =
                Rational::new(prefix, one_second).ok_or(ExportErrorCode::InvalidSegment)?;
            candidates.push((index, prefix, seconds));
        }
    }
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    for (index, prefix, _) in candidates.into_iter().take(MAX_AUDIO_PREFIXES) {
        segments[index].audio_prefix = Some(prefix);
    }
    Ok(())
}

/// [`MAX_HELD_AUDIO_SILENCE_SECONDS`] as a [`Rational`], for the same reason as
/// [`zero_rational`].
fn max_held_audio_silence_rational() -> Rational {
    Rational::new(MAX_HELD_AUDIO_SILENCE_SECONDS, 1)
        .expect("MAX_HELD_AUDIO_SILENCE_SECONDS/1 always reduces to a valid Rational")
}

/// The longest gap of `gaps` that the fill of the audio chain of the segment from `in_seconds` to
/// `out_seconds` holds, in seconds, or `None` when the time overflows.
///
/// The fill makes the silence of a gap when a frame of the segment comes behind it: a gap whose
/// `to` lies after the In point and before the Out point. It makes the silence of the part of the
/// gap after the In point. The silence after the last frame of a segment is no gap here, because
/// the end pad writes it frame by frame. A gap that the In point lies in, and a gap without a
/// `from`, are the silence in front of the first frame of the segment. They count only when the
/// stream has audio in front of the In point: its first sample, `audio_start`, lies at or before
/// the In point, or, when the start is unknown, the read found a frame in front of the gap.
/// Otherwise the segment starts before the first sample, and check 15 counts that silence less the
/// prefix of the segment, or a stream without a known start bounds none of it.
///
/// Only the longest gap counts. When the frame behind a gap arrives, the fill makes the silence of
/// the whole gap and keeps it in memory. It passes the silence on in frames of 4096 samples, one
/// frame each time the next filter asks, and it reads no further frame until it has passed on all
/// of it. So one chain holds the silence of one gap at a time. In FFmpeg 9.0.2, 306 gaps of 0.25 s,
/// 703 gaps of 0.36 s with one frame of audio between, and two gaps of 40 s 43 ms apart each took
/// the memory of their longest gap, and a late start of 40 s with a gap of 40 s took the memory of
/// one of them (ADR 014 measurement 28).
fn longest_held_gap(
    gaps: &[AudioGap],
    in_seconds: Rational,
    out_seconds: Rational,
    audio_start: Option<Rational>,
) -> Option<Rational> {
    let mut longest = zero_rational();
    for gap in gaps
        .iter()
        .filter(|gap| gap.to > in_seconds && gap.to < out_seconds)
    {
        let audio_in_front = match audio_start {
            Some(start) => start <= in_seconds,
            None => gap.from.is_some(),
        };
        let from = match gap.from {
            Some(from) if from > in_seconds => from,
            _ if audio_in_front => in_seconds,
            _ => continue,
        };
        longest = longest.max(gap.to.sub(from)?);
    }
    Some(longest)
}

/// Convert one source PTS into an audio tick at `sample_rate`, as `round(pts * time_base *
/// sample_rate)`, computed as one exact rational value and rounded exactly once.
///
/// Returns `None` only on an arithmetic overflow; the caller distinguishes that case from
/// "no audio," which never calls this function at all.
fn audio_tick(pts: Pts, time_base: Rational, sample_rate: u32) -> Option<i64> {
    let seconds = pts_seconds(pts, time_base)?;
    let sample_rate = Rational::new(i64::from(sample_rate), 1)?;
    let ticks = seconds.mul(sample_rate)?;
    let rounded = round_rational_to_i128(ticks)?;
    i64::try_from(rounded).ok()
}

/// Round a rational value to the nearest integer, with ties rounding away from zero.
///
/// This matches `time::format_seconds`'s tie-breaking rule elsewhere in this crate: both
/// round the magnitude half up and then reapply the sign, so `1/2` rounds to `1` and `-1/2`
/// rounds to `-1`.
///
/// Every `Rational` this crate can construct stores its numerator and denominator as `i64`
/// (`Rational::reduce` guarantees it), so widening both to `i128`/`u128` here leaves well
/// over 64 bits of headroom before any step below could overflow. Given that invariant,
/// this function cannot actually return `None` for any `Rational` value that exists today
/// -- every intermediate value here stays far inside `i128`'s range. It still returns
/// `Option<i128>` rather than a plain `i128`, matching the checked style every other
/// arithmetic helper in this crate uses, so a future widening of `Rational` itself does not
/// quietly hand a caller here an unchecked assumption. The `debug_assert!` below states,
/// locally, the one invariant this function actually leans on.
fn round_rational_to_i128(value: Rational) -> Option<i128> {
    debug_assert!(
        value.den() > 0,
        "Rational::reduce guarantees a positive denominator"
    );
    let numerator = i128::from(value.num());
    // `Rational` always stores a positive denominator, so this is always a positive i128.
    let denominator = i128::from(value.den());
    let negative = numerator < 0;
    let magnitude = numerator.unsigned_abs();
    let denominator_magnitude = denominator.unsigned_abs();
    let quotient = magnitude / denominator_magnitude;
    let remainder = magnitude % denominator_magnitude;
    let doubled_remainder = remainder.checked_mul(2)?;
    let rounded_magnitude = if doubled_remainder >= denominator_magnitude {
        quotient.checked_add(1)?
    } else {
        quotient
    };
    let rounded_magnitude = i128::try_from(rounded_magnitude).ok()?;
    if negative {
        rounded_magnitude.checked_neg()
    } else {
        Some(rounded_magnitude)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::copy::CopyRefusal;
    use crate::ffmpeg::export::{CopiedAudio, MAX_EXPORT_INPUTS};
    use crate::ffmpeg::probe::AudioProbe;
    use crate::project::Resolution;
    use crate::settings::{AudioChannels, Container, Quality, QualityKind};
    use std::collections::HashMap;
    use std::path::PathBuf;

    // -- round_rational_to_i128 ----------------------------------------------------------

    #[test]
    fn rounds_down_when_the_remainder_is_below_one_half() {
        assert_eq!(
            round_rational_to_i128(Rational::new(7, 3).unwrap()),
            Some(2)
        );
    }

    #[test]
    fn rounds_up_when_the_remainder_is_above_one_half() {
        assert_eq!(
            round_rational_to_i128(Rational::new(8, 3).unwrap()),
            Some(3)
        );
    }

    #[test]
    fn rounds_exact_halves_away_from_zero() {
        assert_eq!(
            round_rational_to_i128(Rational::new(1, 2).unwrap()),
            Some(1)
        );
        assert_eq!(
            round_rational_to_i128(Rational::new(-1, 2).unwrap()),
            Some(-1)
        );
        assert_eq!(
            round_rational_to_i128(Rational::new(5, 2).unwrap()),
            Some(3)
        );
        assert_eq!(
            round_rational_to_i128(Rational::new(-5, 2).unwrap()),
            Some(-3)
        );
    }

    #[test]
    fn rounds_negative_non_half_values_away_from_zero() {
        assert_eq!(
            round_rational_to_i128(Rational::new(-8, 3).unwrap()),
            Some(-3)
        );
        assert_eq!(
            round_rational_to_i128(Rational::new(-7, 3).unwrap()),
            Some(-2)
        );
    }

    #[test]
    fn rounds_an_exact_integer_to_itself() {
        assert_eq!(
            round_rational_to_i128(Rational::new(4, 1).unwrap()),
            Some(4)
        );
        assert_eq!(
            round_rational_to_i128(Rational::new(0, 1).unwrap()),
            Some(0)
        );
    }

    // -- build_plan fixtures --------------------------------------------------------------

    // `source_path_is_valid` requires an absolute path, and Windows's `Path::is_absolute`
    // requires a prefix (a drive letter or a UNC root) as well as a root: a Unix-style
    // `/media/source.mp4` is not absolute there. These constants exist so every test below
    // gets a path `source_path_is_valid`/`destination_path_is_invalid` actually accepts on
    // the platform CI runs the test suite on, rather than only on Unix.
    #[cfg(windows)]
    const SOURCE: &str = r"C:\media\source.mp4";
    #[cfg(windows)]
    const SOURCE_PARENT: &str = r"C:\media";
    #[cfg(windows)]
    const DESTINATION: &str = r"C:\export\out.mp4";
    #[cfg(windows)]
    const DESTINATION_PARENT: &str = r"C:\export";

    #[cfg(not(windows))]
    const SOURCE: &str = "/media/source.mp4";
    #[cfg(not(windows))]
    const SOURCE_PARENT: &str = "/media";
    #[cfg(not(windows))]
    const DESTINATION: &str = "/export/out.mp4";
    #[cfg(not(windows))]
    const DESTINATION_PARENT: &str = "/export";

    fn boundary(in_pts: i64, out_pts: i64) -> SegmentBoundary {
        SegmentBoundary {
            source: 0,
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
        }
    }

    fn sample_probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov,mp4,m4a,3gp,3g2,mj2".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: None,
            bit_depth: None,
            width: 1920,
            height: 1080,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: None,
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: None,
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: None,
        }
    }

    fn sample_preset() -> Preset {
        Preset {
            id: "preset-1".to_owned(),
            name: "Test preset".to_owned(),
            container: Container::Mp4,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            audio_bitrate: None,
            audio_sample_rate: AudioSampleRateSetting::Fixed(48_000),
            audio_channels: AudioChannels::Stereo,
            audio_gain_tenths_db: 0,
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            resolution: ResolutionSetting::Source,
            frame_rate: FrameRateSetting::Source,
            pixel_format: "yuv420p".to_owned(),
            video_options: vec![],
            audio_options: vec![],
        }
    }

    fn present_file(identity: u128) -> PathFacts {
        PathFacts::File {
            identity: PathIdentity::new(identity),
            read_only: false,
        }
    }

    /// A regular file the user protected against writing: the same file as
    /// [`present_file`], with the one attribute `fsutil::replace_file_within` refuses on.
    fn present_read_only_file(identity: u128) -> PathFacts {
        PathFacts::File {
            identity: PathIdentity::new(identity),
            read_only: true,
        }
    }

    fn present_directory() -> PathFacts {
        PathFacts::Directory
    }

    fn present_other() -> PathFacts {
        PathFacts::Other
    }

    fn absent() -> PathFacts {
        PathFacts::Absent
    }

    /// The default filesystem fixture for a plan that should pass every path preflight
    /// check: a real source file, a destination directory that exists, and a destination
    /// that does not exist yet (the ordinary "export has not run before" case).
    fn valid_path_facts() -> HashMap<PathBuf, PathFacts> {
        let mut facts = HashMap::new();
        facts.insert(PathBuf::from(SOURCE), present_file(1));
        facts.insert(PathBuf::from(DESTINATION_PARENT), present_directory());
        facts.insert(PathBuf::from(DESTINATION), absent());
        facts
    }

    /// Build an `inspect` closure from a fixed table. A path absent from the table reports
    /// as if nothing were there, matching what a real `std::fs::metadata` call would report
    /// for a path that does not exist.
    fn inspect_from(facts: HashMap<PathBuf, PathFacts>) -> impl Fn(&Path) -> PathFacts {
        move |path: &Path| facts.get(path).copied().unwrap_or(PathFacts::Absent)
    }

    /// The video part of a plan that [`build_plan`] produced for an export that writes video.
    fn video(plan: &ExportPlan) -> &PlannedVideo {
        plan.video
            .as_ref()
            .expect("an export that writes video plans video")
    }

    fn plan_with(
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        facts: HashMap<PathBuf, PathFacts>,
    ) -> Result<ExportPlan, ExportErrorCode> {
        plan_streams(ExportStreams::VideoAndAudio, segments, probe, preset, facts)
    }

    /// [`plan_with`] for an explicit stream choice. Every test that does not name one plans
    /// video and audio, which is what every export planned before the choice existed.
    fn plan_streams(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        facts: HashMap<PathBuf, PathFacts>,
    ) -> Result<ExportPlan, ExportErrorCode> {
        plan_streams_with_gaps(streams, segments, probe, preset, facts, &[])
    }

    /// [`plan_streams`] with the gaps `audio_gaps` that the export read inside the audio stream.
    fn plan_streams_with_gaps(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        facts: HashMap<PathBuf, PathFacts>,
        audio_gaps: &[AudioGap],
    ) -> Result<ExportPlan, ExportErrorCode> {
        let frames = AudioFrames {
            gaps: audio_gaps.to_vec(),
            ..AudioFrames::default()
        };
        plan_read(
            streams,
            segments,
            probe,
            preset,
            facts,
            &frames,
            ExportAudioMode::Encode,
        )
    }

    /// Plan a request with the audio mode `audio_mode`, after the read of the frames `frames`.
    fn plan_read(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        facts: HashMap<PathBuf, PathFacts>,
        frames: &AudioFrames,
        audio_mode: ExportAudioMode,
    ) -> Result<ExportPlan, ExportErrorCode> {
        let request = PlanRequest {
            sources: &[PlanSource {
                path: Path::new(SOURCE),
                probe,
                audio_frames: frames,
            }],
            destination: Path::new(DESTINATION),
            segments,
            preset,
            streams,
            audio_mode,
        };
        build_plan(&request, inspect_from(facts))
    }

    /// Plan a request that asks to copy the audio (ADR 048), after the read of the frames
    /// `frames`, against valid paths.
    fn plan_copy(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        frames: &AudioFrames,
    ) -> Result<ExportPlan, ExportErrorCode> {
        plan_read(
            streams,
            segments,
            probe,
            preset,
            valid_path_facts(),
            frames,
            ExportAudioMode::Copy,
        )
    }

    // -- preflight: segment count and ordering --------------------------------------------

    #[test]
    fn an_empty_segment_list_is_rejected_with_no_segments() {
        let error =
            plan_with(&[], &sample_probe(), &sample_preset(), valid_path_facts()).unwrap_err();
        assert_eq!(error, ExportErrorCode::NoSegments);
    }

    #[test]
    fn more_than_the_maximum_segment_count_is_rejected_with_too_many_segments() {
        let segments: Vec<SegmentBoundary> = (0..=MAX_EXPORT_PIECES as i64)
            .map(|index| boundary(index * 10, index * 10 + 5))
            .collect();
        let error = plan_with(
            &segments,
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::TooManySegments);
    }

    #[test]
    fn exactly_the_maximum_segment_count_is_accepted() {
        let segments: Vec<SegmentBoundary> = (0..MAX_EXPORT_PIECES as i64)
            .map(|index| boundary(index * 10, index * 10 + 5))
            .collect();
        let plan = plan_with(
            &segments,
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments.len(), MAX_EXPORT_PIECES);
    }

    #[test]
    fn a_segment_whose_in_pts_is_not_before_its_out_pts_is_rejected_with_invalid_segment() {
        for segment in [boundary(5, 5), boundary(5, 4)] {
            let error = plan_with(
                &[segment],
                &sample_probe(),
                &sample_preset(),
                valid_path_facts(),
            )
            .unwrap_err();
            assert_eq!(error, ExportErrorCode::InvalidSegment);
        }
    }

    // -- preflight: source path --------------------------------------------------------

    #[test]
    fn a_malformed_source_path_is_rejected_with_source_path_invalid() {
        for source in ["", "relative/source.mp4", "/media/bad\0source.mp4"] {
            let request = PlanRequest {
                sources: &[PlanSource {
                    path: Path::new(source),
                    probe: &sample_probe(),
                    audio_frames: &AudioFrames::default(),
                }],
                destination: Path::new(DESTINATION),
                segments: &[boundary(0, 1)],
                preset: &sample_preset(),
                streams: ExportStreams::VideoAndAudio,
                audio_mode: ExportAudioMode::Encode,
            };
            let error = build_plan(&request, inspect_from(valid_path_facts())).unwrap_err();
            assert_eq!(
                error,
                ExportErrorCode::SourcePathInvalid,
                "source: {source:?}"
            );
        }
    }

    #[test]
    fn a_source_that_does_not_exist_is_rejected_with_source_not_found() {
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), absent());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceNotFound);
    }

    #[test]
    fn a_source_that_is_a_directory_is_rejected_with_source_not_file() {
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_directory());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceNotFile);
    }

    #[test]
    fn a_source_that_is_neither_a_file_nor_a_directory_is_rejected_with_source_not_file() {
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_other());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceNotFile);
    }

    // -- preflight: destination path ----------------------------------------------------

    #[test]
    fn a_malformed_destination_path_is_rejected_with_output_path_invalid() {
        for destination in [
            "",
            "relative/out.mp4",
            "/export/bad\0out.mp4",
            "/",
            "/export/..",
        ] {
            let request = PlanRequest {
                sources: &[PlanSource {
                    path: Path::new(SOURCE),
                    probe: &sample_probe(),
                    audio_frames: &AudioFrames::default(),
                }],
                destination: Path::new(destination),
                segments: &[boundary(0, 1)],
                preset: &sample_preset(),
                streams: ExportStreams::VideoAndAudio,
                audio_mode: ExportAudioMode::Encode,
            };
            let error = build_plan(&request, inspect_from(valid_path_facts())).unwrap_err();
            assert_eq!(
                error,
                ExportErrorCode::OutputPathInvalid,
                "destination: {destination:?}"
            );
        }
    }

    #[test]
    fn a_missing_destination_directory_is_rejected_with_output_directory_missing() {
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION_PARENT), absent());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputDirectoryMissing);
    }

    #[test]
    fn a_destination_parent_that_is_a_file_is_rejected_with_output_directory_missing() {
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION_PARENT), present_file(9));
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputDirectoryMissing);
    }

    #[test]
    fn a_destination_that_is_an_existing_directory_is_rejected_with_output_path_invalid() {
        // The parent exists and is a directory, so step 8 passes; without step 9 this plan
        // would be returned as valid, ffmpeg would encode the whole export, and only the
        // final rename in `commit` would fail.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_directory());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputPathInvalid);
    }

    #[test]
    fn a_destination_that_is_neither_a_file_nor_a_directory_is_rejected_with_output_path_invalid() {
        // A device node, a socket, or a named pipe is not something the renderer can rename
        // a finished temporary file over either.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_other());
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputPathInvalid);
    }

    #[test]
    fn an_absent_destination_and_an_unrelated_existing_file_both_still_pass_the_output_path_check()
    {
        // The guard against step 9 over-rejecting: the two destination shapes an ordinary
        // export actually produces -- a first export, where nothing is there yet, and a
        // re-export over a previous output whose identity differs from the source -- must
        // both still plan.
        for destination_facts in [absent(), present_file(7)] {
            let mut facts = valid_path_facts();
            facts.insert(PathBuf::from(DESTINATION), destination_facts);
            let plan = plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts)
                .unwrap_or_else(|error| panic!("destination: {destination_facts:?}, {error:?}"));
            assert_eq!(plan.destination, PathBuf::from(DESTINATION));
        }
    }

    #[test]
    fn a_destination_identical_to_the_source_path_is_rejected_with_output_equals_source() {
        let request = PlanRequest {
            sources: &[PlanSource {
                path: Path::new(SOURCE),
                probe: &sample_probe(),
                audio_frames: &AudioFrames::default(),
            }],
            destination: Path::new(SOURCE),
            segments: &[boundary(0, 1)],
            preset: &sample_preset(),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
        };
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_file(1));
        // The destination is the source path itself here, so its parent is `SOURCE_PARENT`,
        // not `DESTINATION_PARENT`: the fixture must report that directory as present too,
        // or the parent check (step 8) would fail the plan with `OutputDirectoryMissing`
        // before this check (step 10) ever runs.
        facts.insert(PathBuf::from(SOURCE_PARENT), present_directory());
        let error = build_plan(&request, inspect_from(facts)).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputEqualsSource);
    }

    #[test]
    fn a_destination_sharing_the_sources_file_identity_is_rejected_with_output_equals_source() {
        // Different path text, e.g. a symlink or a hard link, but the same underlying file:
        // the plain string comparison above must not be the only guard.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_file(42));
        facts.insert(PathBuf::from(DESTINATION), present_file(42));
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputEqualsSource);
    }

    #[test]
    fn a_destination_with_no_identity_conflict_is_accepted() {
        let plan = plan_with(
            &[boundary(0, 1)],
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.destination, PathBuf::from(DESTINATION));
    }

    #[test]
    fn an_ordinary_overwrite_of_a_pre_existing_different_file_is_accepted() {
        // Every other fixture makes the destination absent (a first export). This is the
        // common re-export case: the destination already exists, as a previous export's
        // output, but it is not the source.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_file(7));
        let plan = plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap();
        assert_eq!(plan.destination, PathBuf::from(DESTINATION));
    }

    // -- preflight: a protected destination ------------------------------------------------

    #[test]
    fn a_read_only_destination_is_rejected_with_output_read_only() {
        // The refusal this check exists for. `fsutil::replace_file_within` refuses this file at
        // the rename (ADR 015), so without the check the user sits through the whole encode and
        // then reads `outputRenameFailed` while the cleanup guard deletes the render.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_read_only_file(7));
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputReadOnly);
    }

    #[test]
    fn a_destination_that_does_not_exist_yet_is_never_refused_as_read_only() {
        // The ordinary case: a first export has nothing at the destination at all, and there is
        // no attribute to refuse it on. `valid_path_facts` already reports `DESTINATION` as
        // absent, so this states the requirement rather than discovering it.
        let plan = plan_with(
            &[boundary(0, 1)],
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.destination, PathBuf::from(DESTINATION));
    }

    #[test]
    fn a_read_only_source_does_not_refuse_the_export() {
        // The attribute is read in the destination position only. The renderer only reads the
        // source, so a user whose source is protected -- a file on a read-only volume, or one
        // they deliberately locked -- must still be able to export from it.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_read_only_file(1));
        let plan = plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap();
        assert_eq!(plan.sources[0].path, PathBuf::from(SOURCE));
    }

    #[test]
    fn a_read_only_destination_that_is_the_source_reports_output_equals_source() {
        // Check order, stated as a test: the same-file refusal is the more dangerous condition
        // and the more specific report, so it must win over the read-only refusal rather than
        // depend on which check a later edit happens to put first.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), present_read_only_file(42));
        facts.insert(PathBuf::from(DESTINATION), present_read_only_file(42));
        let error =
            plan_with(&[boundary(0, 1)], &sample_probe(), &sample_preset(), facts).unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputEqualsSource);
    }

    // -- preflight: frame rate ------------------------------------------------------------

    #[test]
    fn a_source_frame_rate_preset_with_no_reported_rate_is_rejected() {
        let mut probe = sample_probe();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = None;
        let error = plan_with(
            &[boundary(0, 1)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceFrameRateUnknown);
    }

    #[test]
    fn an_explicit_preset_frame_rate_needs_no_reported_rate_at_all() {
        let mut probe = sample_probe();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = None;
        let mut preset = sample_preset();
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(24, 1).unwrap());
        let plan = plan_with(&[boundary(0, 1)], &probe, &preset, valid_path_facts()).unwrap();
        assert_eq!(
            video(&plan).timing,
            OutputTiming::ConstantFrameRate(Rational::new(24, 1).unwrap())
        );
    }

    #[test]
    fn a_source_frame_rate_preset_falls_back_from_avg_to_r_frame_rate() {
        let mut probe = sample_probe();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = Some(Rational::new(25, 1).unwrap());
        let plan = plan_with(
            &[boundary(0, 1)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            video(&plan).timing,
            OutputTiming::ConstantFrameRate(Rational::new(25, 1).unwrap())
        );
    }

    #[test]
    fn a_non_positive_explicit_frame_rate_is_rejected_with_source_frame_rate_unknown() {
        // `PlanRequest` accepts any `&Preset`, so a caller that skipped
        // `settings::validate_settings` (or a future one that never runs it) must not be
        // able to plan a `0/1` rate through to `expected_frames: Some(0)` and an `fps=0`
        // filter.
        let mut preset = sample_preset();
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(0, 1).unwrap());
        let error = plan_with(
            &[boundary(0, 1)],
            &sample_probe(),
            &preset,
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceFrameRateUnknown);
    }

    // -- computation: exact duration -------------------------------------------------------

    #[test]
    fn total_duration_is_exact_for_a_1001_over_30000_time_base() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1001, 30_000).unwrap();
        // Each segment spans exactly 30000 ticks, i.e. exactly 1001 seconds at this time
        // base; two of them must sum to exactly 2002 seconds, with no rounding.
        let segments = [boundary(0, 30_000), boundary(30_000, 60_000)];
        let plan = plan_with(&segments, &probe, &sample_preset(), valid_path_facts()).unwrap();
        assert_eq!(plan.total_duration, Rational::new(2002, 1).unwrap());
    }

    #[test]
    fn total_duration_preserves_request_order_across_segments() {
        let segments = [boundary(0, 90), boundary(200, 500), boundary(500, 700)];
        let plan = plan_with(
            &segments,
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        let boundaries: Vec<(i64, i64)> = plan
            .segments
            .iter()
            .map(|segment| (segment.in_pts.value(), segment.out_pts.value()))
            .collect();
        assert_eq!(boundaries, vec![(0, 90), (200, 500), (500, 700)]);
    }

    // -- computation: expected_frames rounds per segment, not once at the end -------------

    #[test]
    fn expected_frames_rounds_each_segment_before_summing() {
        // Each segment is 2.5 seconds long at 1 frame per second: 2.5 rounds to 3 away from
        // zero, so two such segments must total 6. Rounding the 5-second total instead
        // would give exactly 5, so this proves the code truly rounds per segment.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 2).unwrap();
        let mut preset = sample_preset();
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(1, 1).unwrap());
        let segments = [boundary(0, 5), boundary(5, 10)];
        let plan = plan_with(&segments, &probe, &preset, valid_path_facts()).unwrap();
        assert_eq!(video(&plan).expected_frames, Some(6));
        assert_eq!(plan.total_duration, Rational::new(5, 1).unwrap());
    }

    #[test]
    fn expected_frames_at_ntsc_rounds_each_segment_before_summing() {
        // Real NTSC: tb 1/30000, rate 30000/1001. Each segment is 501 ticks = 501/30000 s;
        // at this rate that is 501/1001 frames per segment (~0.5005), which rounds up to 1
        // per segment for three segments, summing to 3. Rounding the 1503-tick total
        // instead gives 1503/1001 frames (~1.5025), which rounds to 2 -- a different, and
        // wrong, answer.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 30_000).unwrap();
        let mut preset = sample_preset();
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(30_000, 1001).unwrap());
        let segments = [boundary(0, 501), boundary(501, 1002), boundary(1002, 1503)];
        let plan = plan_with(&segments, &probe, &preset, valid_path_facts()).unwrap();
        assert_eq!(video(&plan).expected_frames, Some(3));
    }

    // -- computation: seek, clamped and unclamped -----------------------------------------

    #[test]
    fn a_seek_that_would_go_negative_clamps_to_none_and_a_positive_seek_survives() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 1).unwrap();
        probe.format_start_time = Some(Rational::new(10, 1).unwrap());
        // Segment 1: in_pts=3s. 3 - 10 - 5 margin = -12, clamps to zero -> None.
        // Segment 2: in_pts=20s. 20 - 10 - 5 margin = 5 -> Some(5).
        let segments = [boundary(3, 4), boundary(20, 21)];
        let plan = plan_with(&segments, &probe, &sample_preset(), valid_path_facts()).unwrap();
        assert_eq!(plan.segments[0].seek_seconds, None);
        assert_eq!(
            plan.segments[1].seek_seconds,
            Some(Rational::new(5, 1).unwrap())
        );
    }

    #[test]
    fn a_missing_format_start_time_is_treated_as_zero() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 1).unwrap();
        probe.format_start_time = None;
        // in_pts = 20s, no format start time, margin 5 -> 15.
        let plan = plan_with(
            &[boundary(20, 21)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.segments[0].seek_seconds,
            Some(Rational::new(15, 1).unwrap())
        );
    }

    #[test]
    fn a_seek_of_exactly_zero_is_none_not_some_zero() {
        // Measurement 7 of ADR 014: a trailing `-ss 0` must never be emitted. This is the
        // exact boundary that decides whether the argument builder omits `-ss` at all.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 1).unwrap();
        probe.format_start_time = Some(Rational::new(10, 1).unwrap());
        // in_pts = 15s: 15 - 10 - 5 margin = 0 exactly.
        let plan = plan_with(
            &[boundary(15, 16)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments[0].seek_seconds, None);
    }

    #[test]
    fn a_tiny_positive_seek_survives_clamping() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 30_000).unwrap();
        probe.format_start_time = None;
        // in_pts = 150001 ticks: 150001/30000 - 0 - 150000/30000 (margin) = 1/30000, a
        // sub-tick-of-a-second positive value that must survive the clamp as `Some`.
        let plan = plan_with(
            &[boundary(150_001, 150_002)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.segments[0].seek_seconds,
            Some(Rational::new(1, 30_000).unwrap())
        );
    }

    #[test]
    fn a_negative_format_start_time_is_subtracted_correctly() {
        // ADR 002 permits a negative reported time, and `probe::parse_format_start_time`
        // already parses one; this proves the seek arithmetic treats "subtract a negative"
        // as "add" rather than mishandling the sign.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 1).unwrap();
        probe.format_start_time = Some(Rational::new(-2, 1).unwrap());
        // in_pts = 10s: 10 - (-2) - 5 margin = 7.
        let plan = plan_with(
            &[boundary(10, 11)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.segments[0].seek_seconds,
            Some(Rational::new(7, 1).unwrap())
        );
    }

    // -- computation: the seek of an input of several pieces -----------------------------------

    #[test]
    fn input_seek_seconds_uses_the_earliest_segment_by_in_pts_not_array_order() {
        // Concat order deliberately reverses source order here: the first segment in the
        // array starts later in the source than the second. A naive implementation that
        // reused `segments[0].seek_seconds` for an input of both pieces would seek to
        // 5 seconds in, skipping past the second segment's material, which starts at 1
        // second.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 90_000).unwrap();
        let segments = [boundary(900_000, 1_800_000), boundary(90_000, 180_000)];
        let plan = plan_with(&segments, &probe, &sample_preset(), valid_path_facts()).unwrap();
        assert_eq!(
            plan.segments[0].seek_seconds,
            Some(Rational::new(5, 1).unwrap())
        );
        assert_eq!(plan.segments[1].seek_seconds, None);
        assert_eq!(plan.input_seek_seconds(&[0, 1]), None);
    }

    // -- computation: audio ticks ----------------------------------------------------------

    #[test]
    fn audio_ticks_round_correctly_at_44100_hz() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 30_000).unwrap();
        probe.audio = Some(AudioProbe {
            index: 1,
            codec: Some("aac".to_owned()),
            sample_rate: Some(44_100),
            channels: Some(2),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        // 1001 ticks * 1/30000 s = 1001/30000 s; * 44100 = 44144100/30000 = 1471.47,
        // which rounds to 1471.
        let plan = plan_with(
            &[boundary(0, 1001)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.audio,
            Some(PlannedAudio {
                output_sample_rate: 48_000,
                output_channels: AudioChannels::Stereo,
                output_layout: Some("stereo".to_owned()),
                absent_layout: "stereo".to_owned(),
                encoder: "aac".to_owned(),
                bitrate: None,
                options: vec![],
                gain_tenths_db: 0,
                // Every segment is expected for its whole length.
                expected_duration: Rational::new(1001, 30_000).unwrap(),
            })
        );
        assert_eq!(
            plan.sources[0].audio,
            Some(SourceAudio {
                stream_index: 1,
                sample_rate: 44_100,
                silence_layout: None,
            })
        );
        assert_eq!(plan.segments[0].audio_in_tick, Some(0));
        assert_eq!(plan.segments[0].audio_out_tick, Some(1471));
    }

    #[test]
    fn audio_ticks_round_correctly_at_48000_hz() {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 30_000).unwrap();
        probe.audio = Some(AudioProbe {
            index: 2,
            codec: Some("aac".to_owned()),
            sample_rate: Some(48_000),
            channels: Some(2),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        // 1001 ticks * 1/30000 s = 1001/30000 s; * 48000 = 48048000/30000 = 1601.6,
        // which rounds to 1602.
        let plan = plan_with(
            &[boundary(0, 1001)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.audio,
            Some(PlannedAudio {
                output_sample_rate: 48_000,
                output_channels: AudioChannels::Stereo,
                output_layout: Some("stereo".to_owned()),
                absent_layout: "stereo".to_owned(),
                encoder: "aac".to_owned(),
                bitrate: None,
                options: vec![],
                gain_tenths_db: 0,
                // Every segment is expected for its whole length.
                expected_duration: Rational::new(1001, 30_000).unwrap(),
            })
        );
        assert_eq!(
            plan.sources[0].audio,
            Some(SourceAudio {
                stream_index: 2,
                sample_rate: 48_000,
                silence_layout: None,
            })
        );
        assert_eq!(plan.segments[0].audio_in_tick, Some(0));
        assert_eq!(plan.segments[0].audio_out_tick, Some(1602));
    }

    #[test]
    fn audio_ticks_use_the_absolute_source_pts_origin_not_video_start_pts_or_format_start_time() {
        // ADR 014's own reference fixture: tb 1/12800, video starts at PTS 128000 (10.0s).
        // This is the load-bearing regression test for the audio-tick conversion: at
        // in_pts=128000 the absolute PTS-to-seconds conversion, a
        // `video_start_pts`-relative conversion, and a `format_start_time`-relative
        // conversion all diverge hugely at 48000 Hz (480000 vs 0 vs 1115), so a
        // reimplementation that subtracts either origin before converting to ticks fails
        // this test -- even though it could pass every other audio-tick test here, where
        // `in_pts` starts at (or near) zero and every origin collapses to the same value.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 12_800).unwrap();
        probe.video_start_pts = Some(Pts::new(128_000));
        probe.format_start_time = Some(Rational::from_decimal_str("9.97678").unwrap());
        probe.audio = Some(AudioProbe {
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
        });
        let plan = plan_with(
            &[boundary(128_000, 140_800)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments[0].audio_in_tick, Some(480_000));
        assert_eq!(plan.segments[0].audio_out_tick, Some(528_000));
    }

    #[test]
    fn a_source_with_no_audio_yields_no_audio_and_no_ticks() {
        let probe = sample_probe();
        assert!(probe.audio.is_none());
        let plan = plan_with(
            &[boundary(0, 1001)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.audio, None);
        assert_eq!(plan.segments[0].audio_in_tick, None);
        assert_eq!(plan.segments[0].audio_out_tick, None);
    }

    #[test]
    fn audio_present_but_with_no_reported_sample_rate_refuses_the_whole_plan() {
        let mut probe = sample_probe();
        probe.audio = Some(AudioProbe {
            index: 1,
            codec: Some("ac3".to_owned()),
            sample_rate: None,
            channels: Some(6),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        let error = plan_with(
            &[boundary(0, 1001)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        // No usable sample rate means no exact way to cut this audio at all (ADR 014
        // forbids the imprecise `atrim` start/end fallback). Planning the track away
        // instead would export a video-only file for a source the preview played with
        // sound, and report nothing, so the preflight refuses the export here.
        assert_eq!(error, ExportErrorCode::SourceAudioRateUnknown);
    }

    // -- computation: the ADR 023 audio output format -------------------------------------

    /// A probe with a 44100 Hz, six-channel audio stream at index 1: a rate that is not 48000
    /// and a layout that is not stereo, so neither legacy value can pass for the source's own.
    fn probe_with_44100_hz_surround_audio() -> MediaProbe {
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 30_000).unwrap();
        probe.audio = Some(AudioProbe {
            index: 1,
            codec: Some("ac3".to_owned()),
            sample_rate: Some(44_100),
            channels: Some(6),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        probe
    }

    #[test]
    fn a_source_sample_rate_resolves_to_the_source_streams_own_rate() {
        // The graph must render a number, so `source` is resolved here rather than there. The
        // tick unit is untouched: it is the source rate whatever the preset asks for.
        let mut preset = sample_preset();
        preset.audio_sample_rate = AudioSampleRateSetting::Source;
        preset.audio_channels = AudioChannels::Source;
        let plan = plan_with(
            &[boundary(0, 1001)],
            &probe_with_44100_hz_surround_audio(),
            &preset,
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(
            plan.audio,
            Some(PlannedAudio {
                output_sample_rate: 44_100,
                output_channels: AudioChannels::Source,
                output_layout: None,
                // The silence of a source without audio would take the layout of the stream,
                // six channels without a plain name here.
                absent_layout: "6c".to_owned(),
                encoder: "aac".to_owned(),
                bitrate: None,
                options: vec![],
                gain_tenths_db: 0,
                // Every segment is expected for its whole length.
                expected_duration: Rational::new(1001, 30_000).unwrap(),
            })
        );
        assert_eq!(
            plan.sources[0].audio,
            Some(SourceAudio {
                stream_index: 1,
                sample_rate: 44_100,
                silence_layout: None,
            })
        );
        assert_eq!(plan.segments[0].audio_out_tick, Some(1471));
    }

    #[test]
    fn a_fixed_sample_rate_and_channel_choice_reach_the_plan_and_leave_the_ticks_alone() {
        for (sample_rate, channels) in [
            (96_000, AudioChannels::Mono),
            (48_000, AudioChannels::Stereo),
            (8_000, AudioChannels::Source),
        ] {
            let mut preset = sample_preset();
            preset.audio_sample_rate = AudioSampleRateSetting::Fixed(sample_rate);
            preset.audio_channels = channels;
            let plan = plan_with(
                &[boundary(0, 1001)],
                &probe_with_44100_hz_surround_audio(),
                &preset,
                valid_path_facts(),
            )
            .unwrap();
            let audio = plan.audio.expect("the probe reports audio");
            assert_eq!(plan.sources[0].audio.as_ref().unwrap().sample_rate, 44_100);
            assert_eq!(audio.output_sample_rate, sample_rate);
            assert_eq!(audio.output_channels, channels);
            // Still 1471 at the source's 44100 Hz, not 1602 at 48000 or any other output rate.
            assert_eq!(plan.segments[0].audio_out_tick, Some(1471));
        }
    }

    #[test]
    fn the_preset_audio_bitrate_is_copied_verbatim() {
        for bitrate in [None, Some(8), Some(320), Some(1536)] {
            let mut preset = sample_preset();
            preset.audio_bitrate = bitrate;
            let plan = plan_with(
                &[boundary(0, 1001)],
                &probe_with_44100_hz_surround_audio(),
                &preset,
                valid_path_facts(),
            )
            .unwrap();
            assert_eq!(
                plan.audio.expect("the probe reports audio").bitrate,
                bitrate
            );
        }
    }

    #[test]
    fn a_preset_without_the_adr_023_keys_plans_the_legacy_48000_hz_stereo_output() {
        // What an older settings document deserializes to, planned against a source that is
        // neither 48000 Hz nor stereo: the output must still be 48000 Hz stereo with no bitrate,
        // which is what every export wrote before ADR 023.
        let legacy: Preset = serde_json::from_value(serde_json::json!({
            "id": "preset-1",
            "name": "Test preset",
            "container": "mp4",
            "videoEncoder": "libx264",
            "audioEncoder": "aac",
            "quality": {"kind": "crf", "value": 20},
            "resolution": "source",
            "frameRate": "source",
        }))
        .unwrap();
        let plan = plan_with(
            &[boundary(0, 1001)],
            &probe_with_44100_hz_surround_audio(),
            &legacy,
            valid_path_facts(),
        )
        .unwrap();
        let audio = plan.audio.expect("the probe reports audio");
        assert_eq!(audio.output_sample_rate, 48_000);
        assert_eq!(audio.output_channels, AudioChannels::Stereo);
        assert_eq!(audio.bitrate, None);
    }

    #[test]
    fn a_negative_in_pts_yields_a_correctly_signed_seek_and_audio_tick() {
        // ADR 002 permits a source to start at a negative PTS (`Pts` holds the full signed
        // `i64` range), and `probe.rs` accepts a negative `start_pts`. A segment's own
        // `in_pts` can therefore be negative too; this proves both derived values keep the
        // correct sign rather than, say, taking an absolute value.
        let mut probe = sample_probe();
        probe.video_time_base = Rational::new(1, 1).unwrap();
        probe.format_start_time = None;
        probe.audio = Some(AudioProbe {
            index: 0,
            codec: Some("aac".to_owned()),
            sample_rate: Some(2),
            channels: Some(1),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        // in_pts = -3s: seek = -3 - 0 - 5 margin = -8, clamps to None.
        // audio_in_tick = round(-3s * 2 Hz) = -6.
        let plan = plan_with(
            &[boundary(-3, 1)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments[0].seek_seconds, None);
        assert_eq!(plan.segments[0].audio_in_tick, Some(-6));
    }

    // -- computation: resolution ------------------------------------------------------------

    #[test]
    fn a_source_resolution_preset_carries_no_resolution_override() {
        let plan = plan_with(
            &[boundary(0, 1)],
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(video(&plan).canvas, None);
    }

    #[test]
    fn a_custom_resolution_preset_carries_its_explicit_dimensions() {
        let mut preset = sample_preset();
        preset.resolution = ResolutionSetting::Custom(Resolution { w: 1280, h: 720 });
        let plan = plan_with(
            &[boundary(0, 1)],
            &sample_probe(),
            &preset,
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(video(&plan).canvas, Some(Resolution { w: 1280, h: 720 }));
    }

    // -- computation: the video part -------------------------------------------------------

    #[test]
    fn every_plan_carries_video_with_the_presets_own_settings() {
        // The plan has an optional video part, and `build_plan` fills it every time: for a
        // source without audio, and for one with audio. Every field is the preset's or the
        // probe's own, resolved once here.
        let mut probe = sample_probe();
        probe.video_stream_index = 3;
        let mut preset = sample_preset();
        preset.video_encoder = "hevc_videotoolbox".to_owned();
        preset.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 8_000,
        };
        let expected = PlannedVideo {
            timing: OutputTiming::ConstantFrameRate(Rational::new(30, 1).unwrap()),
            canvas: None,
            encoder: "hevc_videotoolbox".to_owned(),
            quality: Quality {
                kind: QualityKind::Bitrate,
                value: 8_000,
            },
            // 90000 ticks at 1/90000 is one second, at 30 frames per second.
            pixel_format: "yuv420p".to_owned(),
            options: vec![],
            expected_frames: Some(30),
        };

        let silent =
            plan_with(&[boundary(0, 90_000)], &probe, &preset, valid_path_facts()).unwrap();
        assert_eq!(silent.audio, None);
        assert_eq!(silent.video.as_ref(), Some(&expected));
        assert_eq!(silent.sources[0].video_stream_index, 3);
        assert_eq!(silent.expected_frames(), Some(30));

        probe.audio = Some(AudioProbe {
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
        });
        let with_audio =
            plan_with(&[boundary(0, 90_000)], &probe, &preset, valid_path_facts()).unwrap();
        assert!(with_audio.audio.is_some());
        assert_eq!(with_audio.video.as_ref(), Some(&expected));
        assert_eq!(with_audio.expected_frames(), Some(30));
    }

    // -- the stream choice -----------------------------------------------------------------

    /// A probe with a 48000 Hz stereo audio stream at index 1, beside the sample video.
    fn probe_with_audio() -> MediaProbe {
        let mut probe = sample_probe();
        probe.audio = Some(AudioProbe {
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
        });
        probe
    }

    /// A probe whose audio stream reports no sample rate.
    fn probe_with_unknown_audio_rate() -> MediaProbe {
        let mut probe = sample_probe();
        probe.audio = Some(AudioProbe {
            index: 1,
            codec: Some("ac3".to_owned()),
            sample_rate: None,
            channels: Some(6),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: None,
            reported_packets: None,
            holds_no_packets: false,
        });
        probe
    }

    #[test]
    fn video_and_audio_plans_both_parts_as_every_export_did_before_the_choice() {
        // The default choice. `plan_with` plans it, so every other test in this module is a
        // test of this choice too; this one states the two parts side by side.
        let plan = plan_streams(
            ExportStreams::VideoAndAudio,
            &[boundary(0, 90_000)],
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert!(plan.video.is_some());
        assert!(plan.audio.is_some());
        assert_eq!(
            plan.sources[0]
                .audio
                .as_ref()
                .map(|audio| audio.stream_index),
            Some(1)
        );
        assert_eq!(plan.expected_frames(), Some(30));
        assert_eq!(plan.segments[0].audio_out_tick, Some(48_000));
    }

    #[test]
    fn audio_only_plans_the_audio_part_and_no_video_part() {
        let segments = [boundary(900_000, 990_000), boundary(90_000, 180_000)];
        let both = plan_streams(
            ExportStreams::VideoAndAudio,
            &segments,
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        let audio_only = plan_streams(
            ExportStreams::AudioOnly,
            &segments,
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();

        assert_eq!(audio_only.video, None);
        // No video part, so no frame count to predict or to check.
        assert_eq!(audio_only.expected_frames(), None);
        // Everything that does not belong to the video part is the plan of both parts: the
        // audio, every segment with its seek and its ticks, the container, and the duration. The
        // frame count of each segment belongs to the video part.
        assert_eq!(audio_only.audio, both.audio);
        let without_frames: Vec<PlannedSegment> = both
            .segments
            .iter()
            .map(|segment| PlannedSegment {
                frames: None,
                ..*segment
            })
            .collect();
        assert_eq!(audio_only.segments, without_frames);
        assert_eq!(audio_only.container, both.container);
        assert_eq!(audio_only.total_duration, Rational::new(2, 1).unwrap());
        assert_eq!(audio_only.total_duration, both.total_duration);
    }

    #[test]
    fn audio_only_of_a_source_without_audio_is_refused_with_source_has_no_audio() {
        let error = plan_streams(
            ExportStreams::AudioOnly,
            &[boundary(0, 90_000)],
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceHasNoAudio);
    }

    #[test]
    fn the_missing_audio_check_comes_after_the_path_checks() {
        // Check 13 sits in the stream checks, behind every path check: a source that is not
        // there is reported as missing, not as a source without audio.
        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(SOURCE), absent());
        let error = plan_streams(
            ExportStreams::AudioOnly,
            &[boundary(0, 90_000)],
            &sample_probe(),
            &sample_preset(),
            facts,
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceNotFound);

        let mut facts = valid_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_read_only_file(7));
        let error = plan_streams(
            ExportStreams::AudioOnly,
            &[boundary(0, 90_000)],
            &sample_probe(),
            &sample_preset(),
            facts,
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::OutputReadOnly);
    }

    #[test]
    fn audio_only_still_refuses_an_audio_stream_with_no_sample_rate() {
        // The audio part needs the rate exactly as before: it is the unit of the ticks.
        let error = plan_streams(
            ExportStreams::AudioOnly,
            &[boundary(0, 90_000)],
            &probe_with_unknown_audio_rate(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceAudioRateUnknown);
    }

    #[test]
    fn audio_only_needs_no_frame_rate() {
        // A source whose frame rate is unknown cannot export video, and it can still export its
        // audio: the audio part times no frames. A preset rate of zero is ignored the same way.
        let mut probe = probe_with_audio();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = None;
        for frame_rate in [
            FrameRateSetting::Source,
            FrameRateSetting::Rate(Rational::new(0, 1).unwrap()),
        ] {
            let mut preset = sample_preset();
            preset.frame_rate = frame_rate;
            let plan = plan_streams(
                ExportStreams::AudioOnly,
                &[boundary(0, 90_000)],
                &probe,
                &preset,
                valid_path_facts(),
            )
            .unwrap();
            assert_eq!(plan.video, None);
            assert!(plan.audio.is_some());
        }

        // The same source and preset refuse an export that writes video.
        let error = plan_streams(
            ExportStreams::VideoAndAudio,
            &[boundary(0, 90_000)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceFrameRateUnknown);
    }

    #[test]
    fn video_only_plans_no_audio_part_and_no_audio_ticks() {
        let plan = plan_streams(
            ExportStreams::VideoOnly,
            &[boundary(0, 90_000)],
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.audio, None);
        assert_eq!(plan.segments[0].audio_in_tick, None);
        assert_eq!(plan.segments[0].audio_out_tick, None);
        assert_eq!(plan.expected_frames(), Some(30));

        // The video part is the one an export of both parts plans.
        let both = plan_streams(
            ExportStreams::VideoAndAudio,
            &[boundary(0, 90_000)],
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.video, both.video);
        assert_eq!(plan.total_duration, both.total_duration);
    }

    #[test]
    fn video_only_accepts_a_source_without_audio_and_one_whose_audio_rate_is_unknown() {
        // Neither condition can affect a file without sound. Check 14 refuses the second one
        // for every export that writes audio, and a video-only export never reads the stream.
        for probe in [sample_probe(), probe_with_unknown_audio_rate()] {
            let plan = plan_streams(
                ExportStreams::VideoOnly,
                &[boundary(0, 90_000)],
                &probe,
                &sample_preset(),
                valid_path_facts(),
            )
            .unwrap();
            assert_eq!(plan.audio, None);
            assert_eq!(plan.expected_frames(), Some(30));
        }
    }

    #[test]
    fn video_only_still_refuses_an_unknown_frame_rate() {
        let mut probe = probe_with_audio();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = None;
        let error = plan_streams(
            ExportStreams::VideoOnly,
            &[boundary(0, 90_000)],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceFrameRateUnknown);
    }

    #[test]
    fn no_stream_choice_plans_an_export_with_neither_part() {
        // The graph and the argument builder both reject a plan with neither part. The
        // planner is the place that keeps one from existing: every choice either plans a part
        // or refuses.
        for streams in [
            ExportStreams::VideoAndAudio,
            ExportStreams::VideoOnly,
            ExportStreams::AudioOnly,
        ] {
            for probe in [sample_probe(), probe_with_audio()] {
                let has_audio = probe.audio.is_some();
                match plan_streams(
                    streams,
                    &[boundary(0, 90_000)],
                    &probe,
                    &sample_preset(),
                    valid_path_facts(),
                ) {
                    Ok(plan) => {
                        assert!(plan.video.is_some() || plan.audio.is_some());
                        assert_eq!(plan.video.is_some(), streams.writes_video());
                        assert_eq!(plan.audio.is_some(), streams.writes_audio() && has_audio);
                    }
                    Err(error) => {
                        assert_eq!(
                            (streams, has_audio, error),
                            (
                                ExportStreams::AudioOnly,
                                false,
                                ExportErrorCode::SourceHasNoAudio
                            )
                        );
                    }
                }
            }
        }
    }

    // -- the extent of the source audio -----------------------------------------------------

    /// [`probe_with_audio`] with an audio stream that starts at `start` seconds and runs for
    /// `length` seconds, either side unknown when `None`.
    fn probe_with_audio_extent(start: Option<&str>, length: Option<&str>) -> MediaProbe {
        let mut probe = probe_with_audio();
        let audio = probe.audio.as_mut().unwrap();
        audio.start_time = start.map(|text| Rational::from_decimal_str(text).unwrap());
        audio.duration = length.map(|text| Rational::from_decimal_str(text).unwrap());
        probe
    }

    /// A segment from `from` to `to` seconds, at the sample probe's time base of 1/90000.
    fn seconds_boundary(from: &str, to: &str) -> SegmentBoundary {
        let ticks = |text: &str| {
            let value = Rational::from_decimal_str(text)
                .unwrap()
                .mul(Rational::new(90_000, 1).unwrap())
                .unwrap();
            assert_eq!(value.den(), 1, "{text} s is a whole number of ticks");
            value.num()
        };
        boundary(ticks(from), ticks(to))
    }

    /// The expected audio of an audio-only export of `segments` from `probe`.
    fn expected_audio(probe: &MediaProbe, segments: &[SegmentBoundary]) -> (Rational, Rational) {
        let plan = plan_streams(
            ExportStreams::AudioOnly,
            segments,
            probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        (
            plan.audio
                .expect("audio only plans audio")
                .expected_duration,
            plan.total_duration,
        )
    }

    fn decimal(text: &str) -> Rational {
        Rational::from_decimal_str(text).unwrap()
    }

    #[test]
    fn an_audio_only_export_expects_its_whole_planned_duration_whatever_the_audio_reaches() {
        // Every audio chain of a graph without video ends at the length of its segment
        // (`graph::audio_end_pad`, ADR 014 measurement 23), and the gap fill starts it at the In
        // point. So the extent of the source audio no longer shortens what an audio-only export
        // writes: a late start is filled in front of the first sample, and the part of a segment
        // after the last sample, or a segment the audio does not reach at all, is padded.
        let cases = [
            // The audio covers every segment.
            (
                vec![seconds_boundary("0", "2"), seconds_boundary("60", "62.5")],
                (Some("0"), Some("130")),
                "4.5",
            ),
            // A recording that opened the microphone 0.3 s after the camera.
            (
                vec![seconds_boundary("0", "2"), seconds_boundary("60", "62")],
                (Some("0.3"), Some("129.7")),
                "4",
            ),
            // [0, 0.2) ends before the first sample, and [0.1, 0.4) reaches it.
            (
                vec![
                    seconds_boundary("0", "0.2"),
                    seconds_boundary("60", "62"),
                    seconds_boundary("0.1", "0.4"),
                ],
                (Some("0.3"), Some("129.7")),
                "2.5",
            ),
            // One segment reaches past both ends of the audio.
            (
                vec![seconds_boundary("0", "130")],
                (Some("0.3"), Some("128.7")),
                "130",
            ),
            // A phone recording whose audio stops 1 s before its video, with one segment wholly
            // after the end.
            (
                vec![
                    seconds_boundary("128", "130"),
                    seconds_boundary("60", "61"),
                    seconds_boundary("129.3", "129.9"),
                ],
                (Some("0"), Some("129")),
                "3.6",
            ),
            // Every segment lies after the end of the audio. The plan refused this before the
            // pad, because the export wrote an empty file that a check against 0 s passed. It
            // now writes silence for the whole duration, as the export with video does.
            (
                vec![
                    seconds_boundary("129.2", "129.8"),
                    seconds_boundary("129.5", "130"),
                ],
                (Some("0"), Some("129")),
                "1.1",
            ),
            // The probe reports one side of the extent, or neither.
            (
                vec![seconds_boundary("0", "0.2"), seconds_boundary("128", "130")],
                (Some("0.3"), None),
                "2.2",
            ),
            (
                vec![seconds_boundary("0", "0.2"), seconds_boundary("128", "130")],
                (None, Some("129")),
                "2.2",
            ),
            (
                vec![seconds_boundary("0", "0.2"), seconds_boundary("128", "130")],
                (None, None),
                "2.2",
            ),
        ];
        for (segments, (start, length), total) in cases {
            let (expected, planned) =
                expected_audio(&probe_with_audio_extent(start, length), &segments);
            assert_eq!(planned, decimal(total), "{start:?} {length:?}");
            assert_eq!(expected, planned, "{start:?} {length:?}");
        }
    }

    #[test]
    fn a_late_audio_start_leaves_the_in_tick_at_the_in_point_for_every_choice_with_audio() {
        // The graph subtracts the In tick to start the audio of a segment at its In point
        // (`graph::audio_chain`), so the tick must name the In point itself, never the first
        // sample of a stream that starts after it. The probed extent bounds only the leading
        // silence, never the cut. At the sample
        // probe's 1/90000 and 48000 Hz, 0 s and 2 s are the ticks 0 and 96000.
        let segments = [seconds_boundary("0", "2")];
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            for probe in [
                probe_with_audio_extent(Some("0.3"), Some("129.7")),
                probe_with_audio_extent(None, None),
            ] {
                let plan = plan_streams(
                    streams,
                    &segments,
                    &probe,
                    &sample_preset(),
                    valid_path_facts(),
                )
                .unwrap();
                assert_eq!(plan.segments[0].audio_in_tick, Some(0), "{streams:?}");
                assert_eq!(plan.segments[0].audio_out_tick, Some(96_000), "{streams:?}");
            }
        }
    }

    /// Plans `segments` of a source whose audio starts at 60.5 s, for `streams`.
    fn plan_late_audio(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
    ) -> Result<ExportPlan, ExportErrorCode> {
        plan_streams(
            streams,
            segments,
            &probe_with_audio_extent(Some("60.5"), Some("60")),
            &sample_preset(),
            valid_path_facts(),
        )
    }

    #[test]
    fn a_long_silence_in_front_of_the_first_sample_streams_as_a_prefix() {
        // [0.4, 61) needs 60.1 s of silence in front of the first sample at 60.5 s. The chain
        // streams all of it but the margin of 0.25 s (ADR 014 measurement 27), so the plan does not
        // refuse it, as it did when the fill held all of it in memory.
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let plan = plan_late_audio(streams, &[seconds_boundary("0.4", "61")]).unwrap();
            // 60.1 s less 0.25 s, at 48000 Hz.
            assert_eq!(
                plan.segments[0].audio_prefix,
                Some(2_872_800),
                "{streams:?}"
            );
        }
    }

    #[test]
    fn a_silence_shorter_than_a_second_and_the_margin_gets_no_prefix() {
        // 1.25 s would give a prefix of exactly 1 s, the shortest that the plan writes.
        let short = plan_late_audio(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("59.26", "61")],
        )
        .unwrap();
        assert_eq!(short.segments[0].audio_prefix, None);
        let exact = plan_late_audio(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("59.25", "61")],
        )
        .unwrap();
        assert_eq!(exact.segments[0].audio_prefix, Some(48_000));
        // A segment that starts after the first sample, or ends before it, gets none.
        let around = plan_late_audio(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("70", "80"), seconds_boundary("0", "50")],
        )
        .unwrap();
        assert!(around.segments.iter().all(|s| s.audio_prefix.is_none()));
    }

    #[test]
    fn the_longest_silences_get_the_prefixes_and_the_rest_counts_toward_the_bound() {
        // 20 segments, each 3.5 s in front of the first sample, and one of 30.5 s placed last.
        // The longest silence comes first in the choice, then the earlier segments. Sixteen
        // prefixes stream all but 0.25 s each, and five segments fill 3.5 s each in memory: 21.5 s
        // in all, inside the bound.
        let mut segments: Vec<SegmentBoundary> =
            (0..20).map(|_| seconds_boundary("57", "61")).collect();
        segments.push(seconds_boundary("30", "61"));
        let plan = plan_late_audio(ExportStreams::VideoAndAudio, &segments).unwrap();
        let prefixed: Vec<usize> = plan
            .segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| segment.audio_prefix.is_some())
            .map(|(index, _)| index)
            .collect();
        assert_eq!(prefixed.len(), MAX_AUDIO_PREFIXES);
        assert_eq!(prefixed[..15], (0..15).collect::<Vec<_>>()[..]);
        assert_eq!(prefixed[15], 20);
        assert_eq!(plan.segments[20].audio_prefix, Some(30 * 48_000 + 12_000));
    }

    #[test]
    fn a_prefix_rounds_down_to_whole_samples_at_44100_hz() {
        // 60.5 s less 0.401 s less 0.25 s is 59.849 s, 2639340.9 samples at 44100 Hz. The prefix
        // takes 2639340, so it ends before the margin, where rounding to nearest would take one more.
        let mut probe = probe_with_audio_extent(Some("60.5"), Some("60"));
        probe.audio.as_mut().unwrap().sample_rate = Some(44_100);
        let plan = plan_with(
            &[seconds_boundary("0.401", "61")],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments[0].audio_prefix, Some(2_639_340));
    }

    #[test]
    fn a_stream_that_the_prefix_cannot_convert_to_gets_no_prefix() {
        let prefix = |layout: Option<&str>, rate: u32| {
            let mut probe = probe_with_audio_extent(Some("60.5"), Some("60"));
            let audio = probe.audio.as_mut().unwrap();
            audio.channel_layout = layout.map(str::to_owned);
            audio.sample_rate = Some(rate);
            plan_with(
                &[seconds_boundary("30", "61")],
                &probe,
                &sample_preset(),
                valid_path_facts(),
            )
            .unwrap()
            .segments[0]
                .audio_prefix
        };
        // No layout name, a named layout, a custom order and a layout without a name take it.
        for layout in [
            None,
            Some("5.1(side)"),
            Some("2.1"),
            Some("2 channels (FR+FL)"),
            Some("4 channels (FL+FR+LFE+BC)"),
        ] {
            assert!(prefix(layout, 48_000).is_some(), "{layout:?}");
        }
        // `aresample` cannot convert mono to an ambisonic layout, nor to `binaural`.
        for layout in ["ambisonic 1", "ambisonic 2+stereo", "binaural"] {
            assert_eq!(prefix(Some(layout), 48_000), None, "{layout}");
        }
        // Above 192000 Hz, the timestamps of the prefix do not round back to whole samples.
        assert!(prefix(None, 192_000).is_some());
        assert_eq!(prefix(None, 384_000), None);
    }

    #[test]
    fn the_silence_that_the_fills_hold_is_bounded_together() {
        // The first sample is at 60.5 s. The 16 pieces with the longest silence, 10.5 s each, get
        // a prefix, and the fill of each holds only the margin of 0.25 s: 4 s together. The other
        // pieces get no prefix, because at most 16 pieces of an export have one, and their fills
        // hold all of their silence: 68 pieces of 0.7 s and one of 8.4 s fill the 56 s left. So
        // the most pieces that overlap one another in one export, one run each (ADR 055), fill
        // exactly the bound of 60 s, and one more hundredth of a second goes over it.
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let mut full: Vec<SegmentBoundary> =
                (0..16).map(|_| seconds_boundary("50", "61")).collect();
            full.extend((0..68).map(|_| seconds_boundary("59.8", "61")));
            full.push(seconds_boundary("52.1", "61"));
            assert_eq!(full.len(), MAX_EXPORT_INPUTS);
            let plan = plan_late_audio(streams, &full).unwrap();
            let prefixes = plan
                .segments
                .iter()
                .filter(|piece| piece.audio_prefix.is_some())
                .count();
            assert_eq!(prefixes, MAX_AUDIO_PREFIXES, "{streams:?}");
            let mut over = full.clone();
            over[MAX_EXPORT_INPUTS - 1] = seconds_boundary("52.09", "61");
            assert_eq!(
                plan_late_audio(streams, &over).unwrap_err(),
                ExportErrorCode::AudioGapTooLong,
                "{streams:?}"
            );
        }
    }

    #[test]
    fn a_segment_before_the_audio_counts_nothing_toward_the_bound() {
        // A segment that ends at or before the first sample gets its silence from the end pad of
        // its chain, which holds none of it in memory (`graph::audio_end_pad`). Every chain that
        // reads the stream carries that pad: in an export without video, and in the audio process
        // of an export with video (ADR 043). So [0, 60.5) counts nothing, and a cut at the first
        // sample leaves only the 30 s of [30.5, 61) to count.
        let alone = [seconds_boundary("0", "60.5"), seconds_boundary("61", "62")];
        let cut = [
            seconds_boundary("0", "30.5"),
            seconds_boundary("30.5", "61"),
        ];
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            for segments in [&alone[..], &cut[..]] {
                plan_late_audio(streams, segments).unwrap();
            }
        }
    }

    #[test]
    fn a_segment_after_the_first_sample_needs_no_leading_silence() {
        plan_late_audio(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("60.5", "130")],
        )
        .unwrap();
        // A stream that starts before the video, at a negative time, bounds nothing either.
        plan_streams(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("0", "130")],
            &probe_with_audio_extent(Some("-1"), Some("131")),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
    }

    #[test]
    fn the_leading_silence_is_not_bounded_without_audio_or_without_a_probed_start() {
        let segment = [seconds_boundary("0", "120")];
        // A video-only export reads no audio.
        plan_late_audio(ExportStreams::VideoOnly, &segment).unwrap();
        // A probe that reports no start of the stream bounds nothing.
        plan_streams(
            ExportStreams::VideoAndAudio,
            &segment,
            &probe_with_audio_extent(None, None),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
    }

    #[test]
    fn an_unknown_sample_rate_is_reported_before_the_leading_silence() {
        let mut probe = probe_with_audio_extent(Some("100"), Some("20"));
        probe.audio.as_mut().unwrap().sample_rate = None;
        let error = plan_streams(
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("0", "120")],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceAudioRateUnknown);
    }

    // -- the gaps inside the audio stream ------------------------------------------------------

    /// A gap from `from` to `to` seconds, as `ffmpeg::probe::probe_audio_gaps` reads it.
    fn audio_gap(from: Option<&str>, to: &str) -> AudioGap {
        AudioGap {
            from: from.map(|text| Rational::from_decimal_str(text).unwrap()),
            to: Rational::from_decimal_str(to).unwrap(),
        }
    }

    /// [`plan_streams_with_gaps`] for `streams` and `segments` of a source whose audio starts at
    /// `start` seconds, with the gaps `gaps`.
    fn plan_gaps(
        streams: ExportStreams,
        start: Option<&str>,
        segments: &[SegmentBoundary],
        gaps: &[AudioGap],
    ) -> Result<ExportPlan, ExportErrorCode> {
        plan_streams_with_gaps(
            streams,
            segments,
            &probe_with_audio_extent(start, Some("200")),
            &sample_preset(),
            valid_path_facts(),
            gaps,
        )
    }

    #[test]
    fn a_gap_inside_the_stream_counts_when_its_segment_holds_audio_behind_it() {
        // The audio of a Matroska source stops at 10 s and resumes at 100 s, as ffmpeg 9.0.2 cut a
        // test source (ADR 014 measurement 28). The fill of a segment that holds the frame at 100 s
        // writes the 90 s in front of it at once.
        let gaps = [audio_gap(None, "0"), audio_gap(Some("10"), "100")];
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let plan =
                |segments: &[SegmentBoundary]| plan_gaps(streams, Some("0"), segments, &gaps);
            assert_eq!(
                plan(&[seconds_boundary("5", "110")]).unwrap_err(),
                ExportErrorCode::AudioGapTooLong,
                "{streams:?}"
            );
            // A segment that ends in the gap holds no audio behind it, and its end pad writes the
            // rest of the segment frame by frame. So does a segment that ends at the frame.
            plan(&[seconds_boundary("5", "99")]).unwrap();
            plan(&[seconds_boundary("5", "100")]).unwrap();
            // A segment that starts in the gap, after the first sample, fills from its In point:
            // 50 s fit the bound, and 70 s do not.
            plan(&[seconds_boundary("50", "110")]).unwrap();
            assert_eq!(
                plan(&[seconds_boundary("30", "110")]).unwrap_err(),
                ExportErrorCode::AudioGapTooLong
            );
            // A segment that starts at the frame holds no gap.
            plan(&[seconds_boundary("100", "190")]).unwrap();
        }
        // A video-only export reads no audio.
        plan_gaps(
            ExportStreams::VideoOnly,
            Some("0"),
            &[seconds_boundary("5", "110")],
            &gaps,
        )
        .unwrap();
    }

    #[test]
    fn the_gaps_of_all_segments_count_together_with_the_silence_in_front_of_the_first_sample() {
        // Every chain can hold its fill at the same time, so the bound is on the sum, as it is for
        // the silence in front of the first sample.
        let gaps = [audio_gap(None, "0"), audio_gap(Some("10"), "40")];
        let two = [seconds_boundary("5", "50"), seconds_boundary("5", "50")];
        plan_gaps(ExportStreams::VideoAndAudio, Some("0"), &two, &gaps).unwrap();
        let three = [
            seconds_boundary("5", "50"),
            seconds_boundary("5", "50"),
            seconds_boundary("5", "50"),
        ];
        assert_eq!(
            plan_gaps(ExportStreams::VideoAndAudio, Some("0"), &three, &gaps).unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // The audio starts at 60.5 s. [30, 61) gets a prefix and leaves its margin of 0.25 s to the
        // fill. The read reports the silence in front of the first frame too, as a gap without a
        // `from`, and that gap does not count twice. A gap of 59.75 s behind the first sample
        // reaches the bound exactly, and one of 59.76 s goes over it.
        let late = |to: &str| {
            plan_gaps(
                ExportStreams::VideoAndAudio,
                Some("60.5"),
                &[seconds_boundary("30", "61"), seconds_boundary("61", "190")],
                &[audio_gap(None, "60.5"), audio_gap(Some("70"), to)],
            )
        };
        late("129.75").unwrap();
        assert_eq!(
            late("129.76").unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
    }

    #[test]
    fn only_the_longest_gap_of_each_segment_counts() {
        // One chain held the silence of one gap at a time (ADR 014 measurement 28): 306 dropouts
        // of 0.25 s in an hour took 27 MiB, and two gaps of 40 s 43 ms apart took the memory of
        // one.
        let mut dropouts = vec![audio_gap(None, "0")];
        for index in 1..=300 {
            let end = Rational::new(12 * index, 1).unwrap();
            dropouts.push(AudioGap {
                from: Some(end.sub(Rational::new(1, 4).unwrap()).unwrap()),
                to: end,
            });
        }
        let hour = [seconds_boundary("5", "3605")];
        plan_gaps(ExportStreams::VideoAndAudio, Some("0"), &hour, &dropouts).unwrap();
        let close = [
            audio_gap(None, "0"),
            audio_gap(Some("10"), "50"),
            audio_gap(Some("50.02"), "90.02"),
        ];
        let segment = [seconds_boundary("5", "100")];
        plan_gaps(ExportStreams::VideoAndAudio, Some("0"), &segment, &close).unwrap();
        // A longer gap among them goes over the bound alone.
        let mut longer = close.to_vec();
        longer.push(audio_gap(Some("91"), "152"));
        assert_eq!(
            plan_gaps(
                ExportStreams::VideoAndAudio,
                Some("0"),
                &[seconds_boundary("5", "160")],
                &longer
            )
            .unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // The longest gap counts wherever it lies in the segment.
        assert_eq!(
            plan_gaps(
                ExportStreams::VideoAndAudio,
                Some("0"),
                &segment,
                &[
                    audio_gap(None, "0"),
                    audio_gap(Some("10"), "71"),
                    audio_gap(Some("72"), "80"),
                ],
            )
            .unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // The longest gaps of two segments add up.
        assert_eq!(
            plan_gaps(
                ExportStreams::VideoAndAudio,
                Some("0"),
                &[seconds_boundary("5", "60"), seconds_boundary("55", "100")],
                &close
            )
            .unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
    }

    #[test]
    fn a_segment_counts_the_longer_of_its_late_start_and_its_longest_gap() {
        // [59.5, 190) starts 1 s before the first sample, too close for a prefix, so its fill
        // holds that second. One chain holds one silence at a time: a late start of 40 s with a
        // gap of 40 s took the memory of one of them (ADR 014 measurement 28). So a gap of 59.5 s
        // behind it fits the bound, and a gap of 60.5 s does not.
        let plan = |to: &str| {
            plan_gaps(
                ExportStreams::VideoAndAudio,
                Some("60.5"),
                &[seconds_boundary("59.5", "190")],
                &[audio_gap(None, "60.5"), audio_gap(Some("70"), to)],
            )
        };
        plan("129.5").unwrap();
        assert_eq!(plan("130.5").unwrap_err(), ExportErrorCode::AudioGapTooLong);
        // The other side: a stream in the `binaural` layout gets no prefix, so [1.5, 120) holds
        // its 59 s in front of the first sample, and a gap of 30 s behind it adds nothing.
        let mut probe = probe_with_audio_extent(Some("60.5"), Some("200"));
        probe.audio.as_mut().unwrap().channel_layout = Some("binaural".to_owned());
        let late = |from: &str| {
            plan_streams_with_gaps(
                ExportStreams::VideoAndAudio,
                &[seconds_boundary(from, "120")],
                &probe,
                &sample_preset(),
                valid_path_facts(),
                &[audio_gap(None, "60.5"), audio_gap(Some("70"), "100")],
            )
        };
        assert_eq!(late("1.5").unwrap().segments[0].audio_prefix, None);
        assert_eq!(late("0").unwrap_err(), ExportErrorCode::AudioGapTooLong);
    }

    #[test]
    fn the_silence_in_front_of_the_first_frame_counts_only_behind_a_known_first_sample() {
        // A segment that starts before the first frame and has no frame in front of it in the read
        // fills from its In point. When the probe reports no start of the stream, that frame can
        // be the first sample, and a stream without a known start bounds no silence in front of it.
        let gaps = [audio_gap(None, "80")];
        let segment = [seconds_boundary("10", "90")];
        plan_gaps(ExportStreams::VideoAndAudio, None, &segment, &gaps).unwrap();
        assert_eq!(
            plan_gaps(ExportStreams::VideoAndAudio, Some("0"), &segment, &gaps).unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // A frame in front of the In point shows audio in front of it, without a known start too:
        // [50, 110) fills 50 s from its In point, and [30, 110) fills 70 s.
        let behind_a_frame = [audio_gap(None, "0"), audio_gap(Some("5.02"), "100.011")];
        plan_gaps(
            ExportStreams::VideoAndAudio,
            None,
            &[seconds_boundary("0", "5"), seconds_boundary("50", "110")],
            &behind_a_frame,
        )
        .unwrap();
        assert_eq!(
            plan_gaps(
                ExportStreams::VideoAndAudio,
                None,
                &[seconds_boundary("30", "110")],
                &behind_a_frame,
            )
            .unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // A gap behind a frame of the segment counts without a known start.
        assert_eq!(
            plan_gaps(
                ExportStreams::VideoAndAudio,
                None,
                &segment,
                &[audio_gap(None, "10"), audio_gap(Some("15"), "80")],
            )
            .unwrap_err(),
            ExportErrorCode::AudioGapTooLong
        );
        // A stream that holds no packets is read by no chain, so its gaps count nothing.
        let mut probe = probe_with_audio_extent(Some("0"), Some("200"));
        probe.audio.as_mut().unwrap().holds_no_packets = true;
        plan_streams_with_gaps(
            ExportStreams::VideoAndAudio,
            &segment,
            &probe,
            &sample_preset(),
            valid_path_facts(),
            &[audio_gap(Some("15"), "80")],
        )
        .unwrap();
    }

    // -- an audio stream that holds no packets -----------------------------------------------

    /// The probe of a Matroska source of 120 s whose audio track holds no packets, after the
    /// export read its first packet: the start and the length are the container's.
    fn probe_with_empty_audio() -> MediaProbe {
        let mut probe = probe_with_audio_extent(Some("0"), Some("120"));
        probe.audio.as_mut().unwrap().holds_no_packets = true;
        probe
    }

    #[test]
    fn a_stream_without_packets_plans_silence_and_no_second_input() {
        let segments = [seconds_boundary("0", "1"), seconds_boundary("126", "127")];
        let plan = plan_with(
            &segments,
            &probe_with_empty_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        let audio = plan.audio.as_ref().unwrap();
        assert_eq!(
            plan.sources[0]
                .audio
                .as_ref()
                .unwrap()
                .silence_layout
                .as_deref(),
            Some("stereo")
        );
        // The ticks still give each chain its length, and the audio still runs for every segment.
        assert_eq!(plan.segments[1].audio_in_tick, Some(126 * 48_000));
        assert_eq!(plan.segments[1].audio_out_tick, Some(127 * 48_000));
        assert_eq!(audio.expected_duration, Rational::new(2, 1).unwrap());
        // The chains read no stream, so the plan is one process, while the same plan from a
        // stream with packets gives the audio its own process (ADR 043).
        assert!(!plan.separate_audio_process());
        let mut with_packets = probe_with_empty_audio();
        with_packets.audio.as_mut().unwrap().holds_no_packets = false;
        let with_packets = plan_with(
            &segments,
            &with_packets,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert!(with_packets.separate_audio_process());
    }

    #[test]
    fn a_stream_without_packets_bounds_no_leading_silence() {
        // The reported start lies after the segment, but no chain fills in front of it.
        let mut probe = probe_with_audio_extent(Some("90"), Some("30"));
        probe.audio.as_mut().unwrap().holds_no_packets = true;
        plan_with(
            &[seconds_boundary("0", "80")],
            &probe,
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
    }

    #[test]
    fn an_audio_only_export_of_a_stream_without_packets_has_no_audio() {
        let error = plan_streams(
            ExportStreams::AudioOnly,
            &[seconds_boundary("0", "1")],
            &probe_with_empty_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap_err();
        assert_eq!(error, ExportErrorCode::SourceHasNoAudio);
        // A video-only export never reads the audio, so it plans as it would for any source.
        let plan = plan_streams(
            ExportStreams::VideoOnly,
            &[seconds_boundary("0", "1")],
            &probe_with_empty_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert!(plan.audio.is_none());
    }

    #[test]
    fn a_stream_with_packets_plans_no_silence() {
        let plan = plan_with(
            &[seconds_boundary("0", "1")],
            &probe_with_audio(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert!(plan.audio.is_some());
        assert_eq!(plan.sources[0].audio.as_ref().unwrap().silence_layout, None);
    }

    #[test]
    fn the_audio_part_carries_the_gain_of_the_preset() {
        for gain in [0, -15, 200] {
            let preset = Preset {
                audio_gain_tenths_db: gain,
                ..sample_preset()
            };
            let plan = plan_with(
                &[seconds_boundary("0", "1")],
                &probe_with_audio(),
                &preset,
                valid_path_facts(),
            )
            .unwrap();
            assert_eq!(plan.audio.unwrap().gain_tenths_db, gain);
        }
    }

    #[test]
    fn the_silence_takes_the_layout_of_the_preset_or_a_plain_layout_of_the_stream() {
        let layout_of = |channels: AudioChannels, layout: Option<&str>, count: Option<u32>| {
            let mut probe = probe_with_empty_audio();
            let audio = probe.audio.as_mut().unwrap();
            audio.channel_layout = layout.map(str::to_owned);
            audio.channels = count;
            let preset = Preset {
                audio_channels: channels,
                ..sample_preset()
            };
            plan_with(
                &[seconds_boundary("0", "1")],
                &probe,
                &preset,
                valid_path_facts(),
            )
            .unwrap()
            .sources[0]
                .audio
                .clone()
                .unwrap()
                .silence_layout
                .unwrap()
        };
        // A preset that names a layout gets it, whatever the stream reports.
        assert_eq!(
            layout_of(AudioChannels::Stereo, Some("5.1"), Some(6)),
            "stereo"
        );
        assert_eq!(layout_of(AudioChannels::Mono, Some("5.1"), Some(6)), "mono");
        // A preset that keeps the source layout gets a plain name of the stream.
        for layout in ["5.1(side)", "7.1(wide-side)", "FL+FR+LFE", "22.2"] {
            assert_eq!(
                layout_of(AudioChannels::Source, Some(layout), Some(6)),
                layout
            );
        }
        // Any other name gives the default layout of the channel count, and no count gives stereo.
        for layout in [
            "6 channels (FL+FR+FC+LFE+SL+SR)",
            "5.1:x",
            "5.1,anull",
            "FL+FR+FC+LFE+BL+BR+FLC+FRC+BC+SL+SR",
        ] {
            assert_eq!(
                layout_of(AudioChannels::Source, Some(layout), Some(6)),
                "6c",
                "{layout}"
            );
        }
        assert_eq!(layout_of(AudioChannels::Source, None, Some(3)), "3c");
        assert_eq!(layout_of(AudioChannels::Source, None, Some(8)), "8c");
        assert_eq!(layout_of(AudioChannels::Source, None, None), "stereo");
        // FFmpeg parses `<count>c` only for the counts that have a default layout.
        for count in [10, 16, 24, 64] {
            assert_eq!(
                layout_of(AudioChannels::Source, Some("unparsed name"), Some(count)),
                "stereo",
                "{count}"
            );
        }
    }

    #[test]
    fn a_stream_without_packets_and_without_a_sample_rate_is_refused_as_before() {
        // An MPEG-TS stream without packets reports a rate of 0 (ADR 014 measurement 26). With
        // video, the rate is asked first, as for any stream without one. Without video, the stream
        // is no audio, which comes before its rate.
        let mut probe = probe_with_empty_audio();
        probe.audio.as_mut().unwrap().sample_rate = None;
        let refusal = |streams| {
            plan_streams(
                streams,
                &[seconds_boundary("0", "1")],
                &probe,
                &sample_preset(),
                valid_path_facts(),
            )
            .unwrap_err()
        };
        assert_eq!(
            refusal(ExportStreams::VideoAndAudio),
            ExportErrorCode::SourceAudioRateUnknown
        );
        assert_eq!(
            refusal(ExportStreams::AudioOnly),
            ExportErrorCode::SourceHasNoAudio
        );
    }

    #[test]
    fn a_plan_with_video_and_audio_from_the_stream_gives_the_audio_its_own_process() {
        // Whatever the extent of the audio: the encoder's graph then reads no audio input, so no
        // late start, early end or gap of the stream makes FFmpeg keep the decoded video (ADR
        // 043). Without video or without audio, the plan is one process.
        let segments = [seconds_boundary("0", "10"), seconds_boundary("30", "40")];
        for probe in [
            probe_with_audio(),
            probe_with_audio_extent(Some("30"), Some("100")),
            probe_with_audio_extent(Some("0"), Some("20")),
            probe_with_audio_extent(None, None),
        ] {
            let plan = |streams| {
                plan_streams(
                    streams,
                    &segments,
                    &probe,
                    &sample_preset(),
                    valid_path_facts(),
                )
                .unwrap()
            };
            assert!(plan(ExportStreams::VideoAndAudio).separate_audio_process());
            assert!(!plan(ExportStreams::AudioOnly).separate_audio_process());
            assert!(!plan(ExportStreams::VideoOnly).separate_audio_process());
        }
        let without_audio = plan_with(
            &segments,
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert!(!without_audio.separate_audio_process());
    }

    #[test]
    fn every_segment_carries_its_frame_count_when_the_plan_writes_video() {
        // The terms of the expected count, one for each segment, rounded as it rounds them.
        let segments = [
            seconds_boundary("0", "1.25"),
            seconds_boundary("10", "10.02"),
        ];
        let preset = Preset {
            frame_rate: FrameRateSetting::Rate(Rational::new(30_000, 1_001).unwrap()),
            ..sample_preset()
        };
        let plan = plan_with(&segments, &probe_with_audio(), &preset, valid_path_facts()).unwrap();
        // 1.25 s is 37.46 frames and 0.02 s is 0.5994 frames at 30000/1001.
        let frames: Vec<Option<u64>> = plan.segments.iter().map(|segment| segment.frames).collect();
        assert_eq!(frames, [Some(37), Some(1)]);
        assert_eq!(plan.expected_frames(), Some(38));
        let audio_only = plan_streams(
            ExportStreams::AudioOnly,
            &segments,
            &probe_with_audio(),
            &preset,
            valid_path_facts(),
        )
        .unwrap();
        assert!(audio_only
            .segments
            .iter()
            .all(|segment| segment.frames.is_none()));
    }

    #[test]
    fn the_extent_changes_nothing_in_an_audio_only_plan_inside_the_bound() {
        // An audio-only plan reads the extent only for the bound on the leading silence. Inside
        // that bound, a source whose audio starts late and ends inside the segment plans the
        // same ticks and the same expected audio as a source whose probe reports no extent.
        let segments = [seconds_boundary("0", "2")];
        let plan = |probe: &MediaProbe| {
            plan_streams(
                ExportStreams::AudioOnly,
                &segments,
                probe,
                &sample_preset(),
                valid_path_facts(),
            )
            .unwrap()
        };
        let late = plan(&probe_with_audio_extent(Some("0.3"), Some("1.2")));
        let unknown = plan(&probe_with_audio_extent(None, None));
        assert_eq!(late.segments, unknown.segments);
        assert_eq!(late.total_duration, unknown.total_duration);
        assert_eq!(late.audio, unknown.audio);
        assert_eq!(
            late.audio
                .expect("audio only plans audio")
                .expected_duration,
            decimal("2")
        );
    }

    // -- the copy of the audio (ADR 048) --------------------------------------------------

    /// An MP4 source as the probe splits its format names, with 48000 Hz AAC from 0 s to 100 s.
    fn copy_probe() -> MediaProbe {
        let mut probe = probe_with_audio_extent(Some("0"), Some("100"));
        probe.format_names = ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]
            .map(str::to_owned)
            .to_vec();
        probe
    }

    /// The one segment of the copy tests, from 10 s to 15 s.
    fn copy_segment() -> SegmentBoundary {
        seconds_boundary("10", "15")
    }

    /// The length of one AAC frame at 48000 Hz, 1024/48000 s.
    fn aac_frame() -> Rational {
        Rational::new(1024, 48_000).unwrap()
    }

    /// What the read of the frames finds from `first` to `end` seconds with `fine` gaps between
    /// them, in AAC frames at 48000 Hz. The gaps of the bound join across 0.1 s.
    fn read(first: &str, fine: &[(&str, &str)], end: &str) -> AudioFrames {
        let front = AudioGap {
            from: None,
            to: decimal(first),
        };
        let between = fine.iter().map(|(from, to)| AudioGap {
            from: Some(decimal(from)),
            to: decimal(to),
        });
        let long = |gap: &AudioGap| {
            gap.from
                .is_none_or(|from| gap.to.sub(from).unwrap() > Rational::new(1, 10).unwrap())
        };
        let fine_gaps: Vec<AudioGap> = std::iter::once(front).chain(between).collect();
        AudioFrames {
            gaps: fine_gaps.iter().copied().filter(long).collect(),
            fine_gaps,
            end: Some(decimal(end)),
            longest_frame: Some(aac_frame()),
        }
    }

    /// The read of the frames when the audio covers the copy segment: the first frame starts in
    /// front of the In point, and the last one ends after the Out point.
    fn covered() -> AudioFrames {
        read("9.99", &[], "15.01")
    }

    /// Plan a copy of `segments` from `probe` with `preset`, after the read `frames`.
    fn copy_of(
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        frames: &AudioFrames,
    ) -> ExportPlan {
        plan_copy(streams, segments, probe, preset, frames).unwrap()
    }

    /// Assert that a request to copy plans exactly the encode of the same request after the same
    /// read, and carries `refusal` as the reason.
    fn assert_refused(
        refusal: CopyRefusal,
        streams: ExportStreams,
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        frames: &AudioFrames,
    ) {
        let mut copy = copy_of(streams, segments, probe, preset, frames);
        assert_eq!(copy.audio_copy_refusal, Some(refusal));
        assert_eq!(copy.copied_audio, None);
        copy.audio_copy_refusal = None;
        let encode = plan_read(
            streams,
            segments,
            probe,
            preset,
            valid_path_facts(),
            frames,
            ExportAudioMode::Encode,
        )
        .unwrap();
        assert_eq!(copy, encode, "{refusal:?}");
    }

    /// [`assert_refused`] for the copy segment of [`copy_probe`] with the sample preset, in both
    /// choices of streams that write audio.
    fn assert_refused_both(refusal: CopyRefusal, frames: &AudioFrames) {
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            assert_refused(
                refusal,
                streams,
                &[copy_segment()],
                &copy_probe(),
                &sample_preset(),
                frames,
            );
        }
    }

    /// Whether the copy segment of [`copy_probe`] copies after the read `frames`, in both choices
    /// of streams that write audio.
    fn copies_both(frames: &AudioFrames) -> bool {
        [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly]
            .into_iter()
            .all(|streams| {
                copy_of(
                    streams,
                    &[copy_segment()],
                    &copy_probe(),
                    &sample_preset(),
                    frames,
                )
                .copied_audio
                .is_some()
            })
    }

    #[test]
    fn a_copy_of_one_covered_segment_plans_the_copy_and_no_encode_of_the_audio() {
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let plan = copy_of(
                streams,
                &[copy_segment()],
                &copy_probe(),
                &sample_preset(),
                &covered(),
            );
            assert_eq!(
                plan.copied_audio,
                Some(CopiedAudio {
                    stream_index: 1,
                    start: decimal("10"),
                    end: decimal("15"),
                    adts_to_asc: false,
                }),
                "{streams:?}"
            );
            assert_eq!(plan.audio_copy_refusal, None);
            assert_eq!(plan.audio, None);
            assert_eq!(plan.video.is_some(), streams.writes_video());
            // No chain reads the audio, so no segment has ticks or a prefix.
            assert_eq!(plan.segments[0].audio_in_tick, None);
            assert_eq!(plan.segments[0].audio_out_tick, None);
            assert_eq!(plan.segments[0].audio_prefix, None);
            assert_eq!(plan.total_duration, decimal("5"));
        }
    }

    #[test]
    fn a_request_to_encode_plans_no_copy_and_ignores_what_only_a_copy_reads() {
        let plan = |frames: &AudioFrames| {
            plan_read(
                ExportStreams::VideoAndAudio,
                &[copy_segment()],
                &copy_probe(),
                &sample_preset(),
                valid_path_facts(),
                frames,
                ExportAudioMode::Encode,
            )
            .unwrap()
        };
        let encode = plan(&covered());
        assert_eq!(encode.copied_audio, None);
        assert_eq!(encode.audio_copy_refusal, None);
        assert!(encode.audio.is_some());
        // The fine gaps, the end and the longest frame change nothing in an encode.
        let gaps_only = AudioFrames {
            gaps: covered().gaps,
            ..AudioFrames::default()
        };
        assert_eq!(encode, plan(&gaps_only));
    }

    #[test]
    fn a_copy_that_the_request_or_the_source_does_not_allow_is_an_encode() {
        let preset = sample_preset();
        let video_and_audio = ExportStreams::VideoAndAudio;
        // Two segments.
        assert_refused(
            CopyRefusal::NotOneSegment,
            video_and_audio,
            &[copy_segment(), seconds_boundary("20", "25")],
            &copy_probe(),
            &preset,
            &covered(),
        );
        // No audio to write.
        assert_refused(
            CopyRefusal::NoAudioWritten,
            ExportStreams::VideoOnly,
            &[copy_segment()],
            &copy_probe(),
            &preset,
            &covered(),
        );
        // A stream that holds no packets.
        let mut empty = copy_probe();
        empty.audio.as_mut().unwrap().holds_no_packets = true;
        assert_refused(
            CopyRefusal::NoAudio,
            video_and_audio,
            &[copy_segment()],
            &empty,
            &preset,
            &covered(),
        );
        // A demuxer that was not measured.
        let mut avi = copy_probe();
        avi.format_names = vec!["avi".to_owned()];
        assert_refused(
            CopyRefusal::SourceFormat,
            video_and_audio,
            &[copy_segment()],
            &avi,
            &preset,
            &covered(),
        );
        // A rate below the minimum.
        let mut low = copy_probe();
        low.audio.as_mut().unwrap().sample_rate = Some(22_050);
        assert_refused(
            CopyRefusal::SampleRate,
            video_and_audio,
            &[copy_segment()],
            &low,
            &preset,
            &covered(),
        );
        // Opus into MP4, FLAC anywhere, E-AC-3, and a codec that the probe does not name.
        for codec in [Some("opus"), Some("flac"), Some("eac3"), None] {
            let mut probe = copy_probe();
            probe.audio.as_mut().unwrap().codec = codec.map(str::to_owned);
            assert_refused(
                CopyRefusal::Codec,
                video_and_audio,
                &[copy_segment()],
                &probe,
                &preset,
                &covered(),
            );
        }
        // An In point before zero, where an output `-ss` was not measured.
        assert_refused(
            CopyRefusal::Boundary,
            video_and_audio,
            &[boundary(-90_000, 90_000)],
            &copy_probe(),
            &preset,
            &read("-1.01", &[], "1.01"),
        );
    }

    #[test]
    fn a_read_that_found_no_frame_or_failed_is_an_encode() {
        // The probe says that the audio covers the segment, but the read found nothing there: a
        // dropout across the segment, or a read that failed. Nothing shows a packet to copy.
        assert_refused_both(CopyRefusal::NoFrames, &AudioFrames::default());
        // An FLV source, whose probe reports no length of its audio, encodes as well.
        let mut flv = copy_probe();
        flv.format_names = vec!["flv".to_owned()];
        flv.audio.as_mut().unwrap().duration = None;
        assert_refused(
            CopyRefusal::NoFrames,
            ExportStreams::VideoAndAudio,
            &[copy_segment()],
            &flv,
            &sample_preset(),
            &AudioFrames::default(),
        );
        // The read gives the frames of the FLV source, and the copy runs.
        let plan = copy_of(
            ExportStreams::AudioOnly,
            &[copy_segment()],
            &flv,
            &sample_preset(),
            &covered(),
        );
        assert!(plan.copied_audio.is_some(), "{:?}", plan.audio_copy_refusal);
    }

    #[test]
    fn the_first_frame_may_lie_up_to_one_packet_and_a_rounding_after_the_in_point() {
        // A Matroska read leaves out the frame that holds the In point, and a decoder can drop
        // that frame after its seek. Matroska and FLV time the frames in whole milliseconds.
        let latest = Rational::new(10, 1)
            .unwrap()
            .add(aac_frame())
            .unwrap()
            .add(decimal("0.002"))
            .unwrap();
        let at = |first: Rational| AudioFrames {
            fine_gaps: vec![AudioGap {
                from: None,
                to: first,
            }],
            ..covered()
        };
        assert!(copies_both(&at(latest)));
        let later = latest.add(Rational::new(1, 48_000).unwrap()).unwrap();
        assert_refused_both(CopyRefusal::LateStart, &at(later));
    }

    #[test]
    fn a_segment_shorter_than_three_frames_is_an_encode() {
        // One frame of video at 60 fps holds no AAC packet start when the In point falls just after
        // one, and the copy would write a stream without packets. The bound is three of the longest
        // frames, not capped.
        let three = Rational::new(3, 1).unwrap().mul(aac_frame()).unwrap();
        let ticks = three.mul(Rational::new(90_000, 1).unwrap()).unwrap();
        assert_eq!(
            ticks.den(),
            1,
            "three AAC frames are whole ticks of 1/90000"
        );
        let from = 900_000;
        let read_around = || read("9.99", &[], "10.1");
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            assert_refused(
                CopyRefusal::ShortSegment,
                streams,
                &[boundary(from, from + ticks.num() - 1)],
                &copy_probe(),
                &sample_preset(),
                &read_around(),
            );
            let plan = copy_of(
                streams,
                &[boundary(from, from + ticks.num())],
                &copy_probe(),
                &sample_preset(),
                &read_around(),
            );
            assert!(plan.copied_audio.is_some(), "{:?}", plan.audio_copy_refusal);
        }
        // Long frames make a longer shortest segment: 120 ms Opus frames ask for 0.36 s.
        let long = AudioFrames {
            longest_frame: Some(decimal("0.12")),
            ..read("9.99", &[], "10.5")
        };
        assert_refused(
            CopyRefusal::ShortSegment,
            ExportStreams::VideoAndAudio,
            &[seconds_boundary("10", "10.35")],
            &copy_probe(),
            &sample_preset(),
            &long,
        );
    }

    #[test]
    fn a_gap_longer_than_one_packet_inside_the_segment_is_an_encode() {
        // 85 ms behind the frame that holds the In point: the gaps of the bound join it, and the
        // fine gaps show it.
        let joined = read("9.99", &[("10.011", "10.096")], "15.01");
        assert!(joined.gaps.iter().all(|gap| gap.from.is_none()));
        assert_refused_both(CopyRefusal::Gap, &joined);
        // A gap that starts inside the segment and ends after it, and one that holds the In point.
        assert_refused_both(CopyRefusal::Gap, &read("9.99", &[("14.9", "15.5")], "16"));
        assert_refused_both(CopyRefusal::Gap, &read("9", &[("9.95", "10.05")], "15.01"));
        // A gap of one packet or less is one packet of error, as at the ends.
        assert!(copies_both(&read("9.99", &[("12", "12.02")], "15.01")));
        // A gap that ends in front of the In point leaves the segment covered.
        assert!(copies_both(&read("0", &[("1", "9.99")], "15.01")));
    }

    #[test]
    fn the_last_frame_may_end_up_to_one_packet_before_the_out_point() {
        let one = Rational::new(15, 1).unwrap().sub(aac_frame()).unwrap();
        let ending = |end: Rational| AudioFrames {
            end: Some(end),
            ..covered()
        };
        assert!(copies_both(&ending(one)));
        let earlier = one.sub(Rational::new(1, 48_000).unwrap()).unwrap();
        assert_refused_both(CopyRefusal::EarlyEnd, &ending(earlier));
    }

    #[test]
    fn one_packet_is_never_more_than_the_cap() {
        // Frames of 120 ms, as Opus can write them: each end may still lie only 60 ms off.
        let long = |end: &str| AudioFrames {
            longest_frame: Some(decimal("0.12")),
            ..read("9.99", &[], end)
        };
        assert!(copies_both(&long("14.94")));
        assert_refused_both(CopyRefusal::EarlyEnd, &long("14.939"));
    }

    #[test]
    fn the_muxer_of_the_output_decides_which_codecs_copy() {
        let mut mkv = sample_preset();
        mkv.container = Container::Mkv;
        let mut mov = sample_preset();
        mov.container = Container::Mov;
        let copies = |codec: &str, preset: &Preset, streams: ExportStreams| {
            let mut probe = copy_probe();
            probe.audio.as_mut().unwrap().codec = Some(codec.to_owned());
            copy_of(streams, &[copy_segment()], &probe, preset, &covered())
                .copied_audio
                .is_some()
        };
        let video_and_audio = ExportStreams::VideoAndAudio;
        assert!(copies("opus", &mkv, video_and_audio));
        assert!(copies("opus", &mkv, ExportStreams::AudioOnly));
        assert!(!copies("opus", &mov, video_and_audio));
        // An audio-only export of a MOV preset writes through the `mp4` muxer.
        assert!(!copies("opus", &mov, ExportStreams::AudioOnly));
        for codec in ["aac", "mp3", "ac3"] {
            for preset in [&sample_preset(), &mkv, &mov] {
                for streams in [video_and_audio, ExportStreams::AudioOnly] {
                    assert!(copies(codec, preset, streams), "{codec} {streams:?}");
                }
            }
        }
    }

    #[test]
    fn the_aac_of_an_mpeg_ts_source_converts_from_adts() {
        let mut probe = copy_probe();
        probe.format_names = vec!["mpegts".to_owned()];
        let plan = copy_of(
            ExportStreams::VideoAndAudio,
            &[copy_segment()],
            &probe,
            &sample_preset(),
            &covered(),
        );
        assert!(plan.copied_audio.unwrap().adts_to_asc);
        probe.audio.as_mut().unwrap().codec = Some("mp3".to_owned());
        let plan = copy_of(
            ExportStreams::VideoAndAudio,
            &[copy_segment()],
            &probe,
            &sample_preset(),
            &covered(),
        );
        assert!(!plan.copied_audio.unwrap().adts_to_asc);
    }

    #[test]
    fn a_copy_never_hides_a_refusal_of_the_plan() {
        // A source whose audio has no rate is refused as for an encode, and an audio-only export
        // of a source without audio too.
        let mut unknown = copy_probe();
        unknown.audio.as_mut().unwrap().sample_rate = None;
        assert_eq!(
            plan_copy(
                ExportStreams::VideoAndAudio,
                &[copy_segment()],
                &unknown,
                &sample_preset(),
                &covered(),
            ),
            Err(ExportErrorCode::SourceAudioRateUnknown)
        );
        assert_eq!(
            plan_copy(
                ExportStreams::AudioOnly,
                &[copy_segment()],
                &sample_probe(),
                &sample_preset(),
                &covered(),
            ),
            Err(ExportErrorCode::SourceHasNoAudio)
        );
    }

    // -- several sources (ADR 053) ----------------------------------------------------------

    #[cfg(windows)]
    const SOURCES: [&str; 3] = [
        r"C:\media\source.mp4",
        r"C:\media\second.mov",
        r"C:\media\third.mkv",
    ];
    #[cfg(not(windows))]
    const SOURCES: [&str; 3] = ["/media/source.mp4", "/media/second.mov", "/media/third.mkv"];

    /// The path facts of [`valid_path_facts`], with every path of [`SOURCES`] a file of its own.
    fn several_path_facts() -> HashMap<PathBuf, PathFacts> {
        let mut facts = valid_path_facts();
        for (identity, source) in (1..).zip(SOURCES) {
            facts.insert(PathBuf::from(source), present_file(identity));
        }
        facts
    }

    /// A piece of the source `source` from `in_pts` to `out_pts`.
    fn piece(source: usize, in_pts: i64, out_pts: i64) -> SegmentBoundary {
        SegmentBoundary {
            source,
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
        }
    }

    /// A probe of a `width`x`height` video with the SAR `sar`, the rotation `rotation` and the
    /// nominal rate `rate`, at the time base of 1/90000 and without audio.
    fn video_probe(
        width: u32,
        height: u32,
        sar: Option<(i64, i64)>,
        rotation: u16,
        rate: Option<(i64, i64)>,
    ) -> MediaProbe {
        let rate = rate.map(|(num, den)| Rational::new(num, den).unwrap());
        MediaProbe {
            width,
            height,
            sample_aspect_ratio: sar.map(|(num, den)| Rational::new(num, den).unwrap()),
            rotation,
            avg_frame_rate: rate,
            r_frame_rate: rate,
            ..sample_probe()
        }
    }

    /// An audio stream at `index` of `rate` Hz with `channels` channels in `layout`.
    fn audio_stream(index: u32, rate: u32, channels: u32, layout: Option<&str>) -> AudioProbe {
        AudioProbe {
            index,
            codec: Some("aac".to_owned()),
            sample_rate: Some(rate),
            channels: Some(channels),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: layout.map(str::to_owned),
            reported_packets: None,
            holds_no_packets: false,
        }
    }

    /// Plan `pieces` of the sources `probes`, at the paths of [`SOURCES`] in that order.
    fn plan_sources(
        streams: ExportStreams,
        probes: &[MediaProbe],
        pieces: &[SegmentBoundary],
        preset: &Preset,
    ) -> Result<ExportPlan, ExportErrorCode> {
        let frames = AudioFrames::default();
        let sources: Vec<PlanSource<'_>> = probes
            .iter()
            .zip(SOURCES)
            .map(|(probe, path)| PlanSource {
                path: Path::new(path),
                probe,
                audio_frames: &frames,
            })
            .collect();
        build_plan(
            &PlanRequest {
                sources: &sources,
                destination: Path::new(DESTINATION),
                segments: pieces,
                preset,
                streams,
                audio_mode: ExportAudioMode::Encode,
            },
            inspect_from(several_path_facts()),
        )
    }

    /// The canvas and the fit of each source of a plan of one piece of each of `probes`.
    fn geometry_of(
        probes: &[MediaProbe],
        resolution: ResolutionSetting,
    ) -> (Option<Resolution>, Vec<Option<VideoFit>>) {
        let pieces: Vec<SegmentBoundary> = (0..probes.len())
            .map(|source| piece(source, 0, 90_000))
            .collect();
        let preset = Preset {
            resolution,
            ..sample_preset()
        };
        let plan = plan_sources(ExportStreams::VideoOnly, probes, &pieces, &preset).unwrap();
        let fits = plan.sources.iter().map(|source| source.fit).collect();
        (video(&plan).canvas, fits)
    }

    fn fit(width: u32, height: u32, x: u32, y: u32) -> Option<VideoFit> {
        Some(VideoFit {
            width,
            height,
            x,
            y,
        })
    }

    #[test]
    fn an_anamorphic_source_beside_a_full_hd_source_fits_the_full_hd_canvas() {
        // 720x480 at 32:27 shows 853x480 at 16:9 exactly, so it fills 1920x1080. Its SAR is not
        // 1, so it gets the fit step even though its aspect ratio is the canvas's.
        let anamorphic = video_probe(720, 480, Some((32, 27)), 0, Some((30_000, 1001)));
        let full_hd = video_probe(1920, 1080, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(&[anamorphic, full_hd], ResolutionSetting::Source),
            (
                Some(Resolution { w: 1920, h: 1080 }),
                vec![fit(1920, 1080, 0, 0), None]
            )
        );
    }

    #[test]
    fn a_portrait_source_after_a_landscape_source_is_pillarboxed_on_the_landscape_canvas() {
        // The two display sizes have the same area, so the source of the earlier piece wins. The
        // portrait picture is 1080 high and 1080 x 9/16 = 607.5 wide, which rounds to 608, at
        // x = (1920 - 608) / 2 = 656. A coded portrait and a rotated landscape show the same.
        let landscape = video_probe(1920, 1080, None, 0, Some((30, 1)));
        for portrait in [
            video_probe(1080, 1920, None, 0, Some((30, 1))),
            video_probe(1920, 1080, None, 90, Some((30, 1))),
            video_probe(1920, 1080, None, 270, Some((30, 1))),
        ] {
            assert_eq!(
                geometry_of(&[landscape.clone(), portrait], ResolutionSetting::Source),
                (
                    Some(Resolution { w: 1920, h: 1080 }),
                    vec![None, fit(608, 1080, 656, 0)]
                )
            );
        }
    }

    #[test]
    fn a_portrait_source_first_gives_a_portrait_canvas() {
        let portrait = video_probe(1080, 1920, None, 0, Some((30, 1)));
        let landscape = video_probe(1920, 1080, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(&[portrait, landscape], ResolutionSetting::Source),
            (
                Some(Resolution { w: 1080, h: 1920 }),
                vec![None, fit(1080, 608, 0, 656)]
            )
        );
    }

    #[test]
    fn sources_of_one_size_sar_and_rotation_get_no_canvas_and_no_fit() {
        // As a single source always does: an anamorphic source keeps its own SAR, and no chain
        // scales (ADR 014 measurement 16).
        let anamorphic = || video_probe(720, 480, Some((32, 27)), 0, Some((30, 1)));
        assert_eq!(
            geometry_of(&[anamorphic(), anamorphic()], ResolutionSetting::Source),
            (None, vec![None, None])
        );
        assert_eq!(
            geometry_of(&[anamorphic()], ResolutionSetting::Source),
            (None, vec![None])
        );
        // An unknown SAR reads as square pixels, as the probe reads it.
        let square = video_probe(1920, 1080, Some((1, 1)), 0, Some((30, 1)));
        let unknown = video_probe(1920, 1080, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(&[square, unknown], ResolutionSetting::Source),
            (None, vec![None, None])
        );
        // Another rotation of the same coded size is another picture.
        let rotated = video_probe(1920, 1080, None, 90, Some((30, 1)));
        let upright = video_probe(1920, 1080, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(&[upright, rotated], ResolutionSetting::Source).0,
            Some(Resolution { w: 1920, h: 1080 })
        );
    }

    #[test]
    fn a_preset_size_is_the_canvas_with_even_sides_and_fits_every_source() {
        // An odd side loses one pixel, and a side of 1 becomes 2. A source of the canvas's size
        // and square pixels needs no fit; one of another aspect ratio is pillarboxed.
        let full_hd = video_probe(1920, 1080, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(
                std::slice::from_ref(&full_hd),
                ResolutionSetting::Custom(Resolution { w: 1281, h: 721 })
            ),
            (
                Some(Resolution { w: 1280, h: 720 }),
                vec![fit(1280, 720, 0, 0)]
            )
        );
        assert_eq!(
            geometry_of(
                std::slice::from_ref(&full_hd),
                ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 })
            ),
            (Some(Resolution { w: 1920, h: 1080 }), vec![None])
        );
        let four_three = video_probe(640, 480, None, 0, Some((30, 1)));
        assert_eq!(
            geometry_of(
                &[four_three],
                ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 })
            ),
            (
                Some(Resolution { w: 1920, h: 1080 }),
                vec![fit(1440, 1080, 240, 0)]
            )
        );
        assert_eq!(
            geometry_of(
                &[full_hd],
                ResolutionSetting::Custom(Resolution { w: 1, h: 3 })
            )
            .0,
            Some(Resolution { w: 2, h: 2 })
        );
    }

    #[test]
    fn the_fit_rounds_to_an_even_side_a_tie_up_and_each_offset_down_to_an_even_number() {
        let canvas = Resolution { w: 1920, h: 1080 };
        let aspect = |num: i64, den: i64| Rational::new(num, den).unwrap();
        // 1080 x 607/1080 = 607, an odd number: the tie between 606 and 608 goes up.
        assert_eq!(
            fit_on_canvas(canvas, aspect(607, 1080)),
            fit(608, 1080, 656, 0)
        );
        // 1080 x 605.9/1080 rounds to 606, and the half of 1314 is 657, rounded down to 656.
        assert_eq!(
            fit_on_canvas(canvas, aspect(6059, 10_800)),
            fit(606, 1080, 656, 0)
        );
        // A wide picture takes the width, and its height rounds: 1920 / (21/9) = 822.86 -> 822,
        // at y = 129 rounded down to 128.
        assert_eq!(fit_on_canvas(canvas, aspect(21, 9)), fit(1920, 822, 0, 128));
        // The canvas's own aspect ratio fills it.
        assert_eq!(fit_on_canvas(canvas, aspect(16, 9)), fit(1920, 1080, 0, 0));
        // A side never rounds to nothing.
        assert_eq!(
            fit_on_canvas(canvas, aspect(1, 100_000)),
            fit(2, 1080, 958, 0)
        );
    }

    #[test]
    fn the_display_size_rounds_the_width_half_up_and_swaps_for_a_quarter_turn() {
        // 720 x 32/27 = 853.33 -> 853; 704 x 10/11 = 640 exactly; 3 x 1/2 = 1.5 -> 2.
        let size_of = |width: u32, sar: (i64, i64), rotation: u16| {
            let geometry =
                display_geometry(&video_probe(width, 480, Some(sar), rotation, None)).unwrap();
            (geometry.width, geometry.height)
        };
        assert_eq!(size_of(720, (32, 27), 0), (853, 480));
        assert_eq!(size_of(704, (10, 11), 0), (640, 480));
        assert_eq!(size_of(3, (1, 2), 0), (2, 480));
        assert_eq!(size_of(720, (32, 27), 90), (480, 853));
        assert_eq!(size_of(720, (32, 27), 180), (853, 480));
    }

    #[test]
    fn the_source_frame_rate_is_the_highest_nominal_rate_of_the_sources() {
        let at = |rate: Option<(i64, i64)>| video_probe(1920, 1080, None, 0, rate);
        let pieces = [
            piece(0, 0, 90_000),
            piece(1, 0, 90_000),
            piece(2, 0, 90_000),
        ];
        let rate_of = |probes: &[MediaProbe]| {
            plan_sources(
                ExportStreams::VideoOnly,
                probes,
                &pieces[..probes.len()],
                &sample_preset(),
            )
            .map(|plan| video(&plan).timing)
        };
        let rate =
            |num: i64, den: i64| OutputTiming::ConstantFrameRate(Rational::new(num, den).unwrap());
        // Compared as exact rationals: 30000/1001 is below 30, and 60 is above both.
        assert_eq!(
            rate_of(&[
                at(Some((30_000, 1001))),
                at(Some((60, 1))),
                at(Some((24, 1)))
            ]),
            Ok(rate(60, 1))
        );
        assert_eq!(
            rate_of(&[at(Some((30_000, 1001))), at(Some((30, 1)))]),
            Ok(rate(30, 1))
        );
        // A source without a rate does not take part, and none at all is refused.
        assert_eq!(rate_of(&[at(None), at(Some((25, 1)))]), Ok(rate(25, 1)));
        assert_eq!(
            rate_of(&[at(None), at(None)]),
            Err(ExportErrorCode::SourceFrameRateUnknown)
        );
        // `avg_frame_rate` comes before `r_frame_rate`, as for one source.
        let mut averaged = at(Some((50, 1)));
        averaged.avg_frame_rate = Some(Rational::new(24, 1).unwrap());
        assert_eq!(rate_of(&[averaged, at(Some((30, 1)))]), Ok(rate(30, 1)));
        // An explicit rate wins, and then no source needs one.
        let preset = Preset {
            frame_rate: FrameRateSetting::Rate(Rational::new(25, 1).unwrap()),
            ..sample_preset()
        };
        let plan = plan_sources(
            ExportStreams::VideoOnly,
            &[at(None), at(None)],
            &pieces[..2],
            &preset,
        )
        .unwrap();
        assert_eq!(video(&plan).timing, rate(25, 1));
    }

    #[test]
    fn the_expected_frames_round_each_piece_on_its_own_with_a_half_away_from_zero() {
        // Three frames of a 24 fps source last 1/8 s, which is 7.5 frames at 60 fps. Each piece
        // rounds to 8, so two of them expect 16, not the 15 of the rounded sum.
        let film = video_probe(1920, 1080, None, 0, Some((24, 1)));
        let fast = video_probe(1280, 720, None, 0, Some((60, 1)));
        let pieces = [
            piece(0, 0, 11_250),
            piece(1, 0, 90_000),
            piece(0, 90_000, 101_250),
        ];
        let plan = plan_sources(
            ExportStreams::VideoOnly,
            &[film, fast],
            &pieces,
            &sample_preset(),
        )
        .unwrap();
        let frames: Vec<Option<u64>> = plan.segments.iter().map(|piece| piece.frames).collect();
        assert_eq!(frames, vec![Some(8), Some(60), Some(8)]);
        assert_eq!(plan.expected_frames(), Some(76));
    }

    #[test]
    fn each_piece_is_timed_with_its_own_source() {
        // The second source has another time base and a container start of 10 s. Its In point of
        // 20 s seeks to 20 - 10 - 5 = 5 s, and its ticks count its own audio rate.
        let mut first = video_probe(1920, 1080, None, 0, Some((30, 1)));
        first.audio = Some(audio_stream(1, 48_000, 2, Some("stereo")));
        let mut second = video_probe(1920, 1080, None, 0, Some((30, 1)));
        second.video_time_base = Rational::new(1, 1000).unwrap();
        second.format_start_time = Some(Rational::new(10, 1).unwrap());
        second.video_stream_index = 1;
        second.audio = Some(audio_stream(0, 44_100, 2, Some("stereo")));
        let pieces = [piece(0, 900_000, 990_000), piece(1, 20_000, 21_000)];
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[first, second],
            &pieces,
            &sample_preset(),
        )
        .unwrap();
        assert_eq!(plan.segments[0].seek_seconds, Rational::new(5, 1));
        assert_eq!(plan.segments[1].seek_seconds, Rational::new(5, 1));
        assert_eq!(
            (
                plan.segments[0].audio_in_tick,
                plan.segments[0].audio_out_tick
            ),
            (Some(480_000), Some(528_000))
        );
        assert_eq!(
            (
                plan.segments[1].audio_in_tick,
                plan.segments[1].audio_out_tick
            ),
            (Some(882_000), Some(926_100))
        );
        assert_eq!(plan.total_duration, Rational::new(2, 1).unwrap());
        assert_eq!(plan.sources[1].video_stream_index, 1);
        assert_eq!(plan.sources[1].audio.as_ref().unwrap().stream_index, 0);
        assert_eq!(plan.sources[1].path, PathBuf::from(SOURCES[1]));
        // The single input of a source seeks for the pieces of that source only.
        assert_eq!(plan.input_seek_seconds(&[1]), Rational::new(5, 1));
    }

    #[test]
    fn the_source_audio_format_is_the_highest_rate_and_the_widest_layout() {
        let preset = Preset {
            audio_sample_rate: AudioSampleRateSetting::Source,
            audio_channels: AudioChannels::Source,
            ..sample_preset()
        };
        let with_audio = |audio: Option<AudioProbe>| MediaProbe {
            audio,
            ..sample_probe()
        };
        let pieces = [
            piece(0, 0, 90_000),
            piece(1, 0, 90_000),
            piece(2, 0, 90_000),
        ];
        let audio_of = |probes: &[MediaProbe]| {
            plan_sources(
                ExportStreams::VideoAndAudio,
                probes,
                &pieces[..probes.len()],
                &preset,
            )
            .unwrap()
            .audio
            .unwrap()
        };

        // Different layouts: the closing `aformat` names the layout of the most channels, at
        // the highest rate, and a source without audio takes part in neither.
        let audio = audio_of(&[
            with_audio(Some(audio_stream(1, 44_100, 2, Some("stereo")))),
            with_audio(None),
            with_audio(Some(audio_stream(1, 48_000, 6, Some("5.1(side)")))),
        ]);
        assert_eq!(audio.output_sample_rate, 48_000);
        assert_eq!(audio.output_layout.as_deref(), Some("5.1(side)"));
        assert_eq!(audio.absent_layout, "5.1(side)");

        // One layout: no chain names it, as for one source, and the silence of a source
        // without audio takes it.
        let audio = audio_of(&[
            with_audio(Some(audio_stream(1, 32_000, 2, Some("stereo")))),
            with_audio(Some(audio_stream(1, 44_100, 2, Some("stereo")))),
            with_audio(None),
        ]);
        assert_eq!(audio.output_sample_rate, 44_100);
        assert_eq!(audio.output_layout, None);
        assert_eq!(audio.absent_layout, "stereo");

        // Equal counts: the source of the earlier piece wins, and a layout without a plain name
        // gives the default layout of its count.
        let audio = audio_of(&[
            with_audio(Some(audio_stream(
                1,
                48_000,
                6,
                Some("6 channels (FL+FR+FC+LFE+SL+SR)"),
            ))),
            with_audio(Some(audio_stream(1, 48_000, 6, Some("5.1")))),
        ]);
        assert_eq!(audio.output_layout.as_deref(), Some("6c"));

        // A stream without packets takes part, as a stream with packets does.
        let mut empty = audio_stream(1, 96_000, 8, Some("7.1"));
        empty.holds_no_packets = true;
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[
                with_audio(Some(audio_stream(1, 48_000, 2, Some("stereo")))),
                with_audio(Some(empty)),
            ],
            &pieces[..2],
            &preset,
        )
        .unwrap();
        let audio = plan.audio.as_ref().unwrap();
        assert_eq!(audio.output_sample_rate, 96_000);
        assert_eq!(audio.output_layout.as_deref(), Some("7.1"));
        assert_eq!(
            plan.sources[1]
                .audio
                .as_ref()
                .unwrap()
                .silence_layout
                .as_deref(),
            Some("7.1")
        );

        // The preset's own values win.
        let fixed = plan_sources(
            ExportStreams::VideoAndAudio,
            &[
                with_audio(Some(audio_stream(1, 44_100, 2, Some("stereo")))),
                with_audio(Some(audio_stream(1, 48_000, 6, Some("5.1")))),
            ],
            &pieces[..2],
            &sample_preset(),
        )
        .unwrap();
        let audio = fixed.audio.as_ref().unwrap();
        assert_eq!(audio.output_sample_rate, 48_000);
        assert_eq!(audio.output_layout.as_deref(), Some("stereo"));
        // Each source keeps its own rate as the unit of its ticks.
        assert_eq!(fixed.sources[0].audio.as_ref().unwrap().sample_rate, 44_100);
        assert_eq!(fixed.segments[0].audio_out_tick, Some(44_100));
    }

    #[test]
    fn a_source_without_audio_gets_silence_of_its_length_at_the_output_rate() {
        // 50 ticks of 1/90000 s at 44100 Hz are 24.5 samples, which round away from zero to 25.
        // A piece of 1 s is 44100 of them. Its ticks run from 0, so their difference is the
        // length.
        let preset = Preset {
            audio_sample_rate: AudioSampleRateSetting::Fixed(44_100),
            ..sample_preset()
        };
        let mut with_audio = sample_probe();
        with_audio.audio = Some(audio_stream(1, 48_000, 2, Some("stereo")));
        let pieces = [
            piece(1, 1_000, 1_050),
            piece(0, 0, 90_000),
            piece(1, 90_000, 180_000),
        ];
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[with_audio, sample_probe()],
            &pieces,
            &preset,
        );
        // The pieces name source 1 first, but a request names its sources in the order of their
        // first piece; this one does not, which `build_plan` accepts.
        let plan = plan.unwrap();
        let ticks: Vec<(Option<i64>, Option<i64>)> = plan
            .segments
            .iter()
            .map(|piece| (piece.audio_in_tick, piece.audio_out_tick))
            .collect();
        assert_eq!(
            ticks,
            vec![
                (Some(0), Some(25)),
                (Some(0), Some(48_000)),
                (Some(0), Some(44_100)),
            ]
        );
        assert_eq!(plan.audio_tick_rate(0), Some(44_100));
        assert_eq!(plan.audio_tick_rate(1), Some(48_000));
        assert_eq!(plan.sources[1].audio, None);
        // One piece reads a stream, so the audio has its own process (ADR 043).
        assert!(plan.reads_audio_stream());
        assert!(plan.separate_audio_process());
        assert!(!plan.piece_reads_audio(0));
        assert!(plan.piece_reads_audio(1));
    }

    #[test]
    fn the_audio_of_sources_without_packets_or_without_audio_is_written_or_refused() {
        let mut empty = sample_probe();
        empty.audio = Some(AudioProbe {
            holds_no_packets: true,
            ..audio_stream(1, 48_000, 2, Some("stereo"))
        });
        let mut with_audio = sample_probe();
        with_audio.audio = Some(audio_stream(1, 48_000, 2, Some("stereo")));
        let pieces = [piece(0, 0, 90_000), piece(1, 0, 90_000)];

        // No source has an audio stream: no audio is written, and an audio-only export of
        // streams without packets is refused.
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[sample_probe(), sample_probe()],
            &pieces,
            &sample_preset(),
        )
        .unwrap();
        assert_eq!(plan.audio, None);
        assert_eq!(
            plan_sources(
                ExportStreams::AudioOnly,
                &[sample_probe(), empty.clone()],
                &pieces,
                &sample_preset(),
            )
            .unwrap_err(),
            ExportErrorCode::SourceHasNoAudio
        );
        // A stream without packets beside a source without audio writes silence in one process.
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[sample_probe(), empty],
            &pieces,
            &sample_preset(),
        )
        .unwrap();
        assert!(plan.audio.is_some());
        assert!(!plan.separate_audio_process());
        // An audio-only export of a source with audio and one without writes both.
        let plan = plan_sources(
            ExportStreams::AudioOnly,
            &[sample_probe(), with_audio],
            &pieces,
            &sample_preset(),
        )
        .unwrap();
        assert_eq!(
            plan.audio.unwrap().expected_duration,
            Rational::new(2, 1).unwrap()
        );
        // A source with an audio stream of no rate is refused, whichever source it is.
        let mut unknown = sample_probe();
        unknown.audio = Some(AudioProbe {
            sample_rate: None,
            ..audio_stream(1, 48_000, 2, None)
        });
        assert_eq!(
            plan_sources(
                ExportStreams::VideoAndAudio,
                &[sample_probe(), unknown],
                &pieces,
                &sample_preset(),
            )
            .unwrap_err(),
            ExportErrorCode::SourceAudioRateUnknown
        );
    }

    #[test]
    fn a_copy_of_the_audio_needs_one_piece() {
        // A segment across a junction has two pieces, so its audio is encoded (ADR 048, ADR 053).
        let probe = probe_with_audio();
        let frames = AudioFrames::default();
        let sources = [
            PlanSource {
                path: Path::new(SOURCES[0]),
                probe: &probe,
                audio_frames: &frames,
            },
            PlanSource {
                path: Path::new(SOURCES[1]),
                probe: &probe,
                audio_frames: &frames,
            },
        ];
        let plan = build_plan(
            &PlanRequest {
                sources: &sources,
                destination: Path::new(DESTINATION),
                segments: &[piece(0, 0, 450_000), piece(1, 0, 450_000)],
                preset: &sample_preset(),
                streams: ExportStreams::VideoAndAudio,
                audio_mode: ExportAudioMode::Copy,
            },
            inspect_from(several_path_facts()),
        )
        .unwrap();
        assert_eq!(plan.copied_audio, None);
        assert_eq!(
            plan.audio_copy_refusal,
            Some(copy::CopyRefusal::NotOneSegment)
        );
        assert!(plan.audio.is_some());
    }

    #[test]
    fn the_sources_must_match_the_pieces_and_the_destination_must_be_none_of_them() {
        let probes = [sample_probe(), sample_probe()];
        let plan = |pieces: &[SegmentBoundary]| {
            plan_sources(ExportStreams::VideoOnly, &probes, pieces, &sample_preset())
        };
        // A piece names a source that is not there, or a source has no piece.
        assert_eq!(
            plan(&[piece(0, 0, 1), piece(2, 0, 1)]).unwrap_err(),
            ExportErrorCode::InvalidSources
        );
        assert_eq!(
            plan(&[piece(0, 0, 1), piece(0, 1, 2)]).unwrap_err(),
            ExportErrorCode::InvalidSources
        );
        assert!(plan(&[piece(1, 0, 1), piece(0, 0, 1)]).is_ok());
        // Every source is checked in turn.
        let frames = AudioFrames::default();
        let sources: Vec<PlanSource<'_>> = probes
            .iter()
            .zip(SOURCES)
            .map(|(probe, path)| PlanSource {
                path: Path::new(path),
                probe,
                audio_frames: &frames,
            })
            .collect();
        let preset = sample_preset();
        let pieces = [piece(0, 0, 1), piece(1, 0, 1)];
        let request = |destination: &'static str| PlanRequest {
            sources: &sources,
            destination: Path::new(destination),
            segments: &pieces,
            preset: &preset,
            streams: ExportStreams::VideoOnly,
            audio_mode: ExportAudioMode::Encode,
        };
        let mut facts = several_path_facts();
        facts.insert(PathBuf::from(SOURCES[1]), absent());
        assert_eq!(
            build_plan(&request(DESTINATION), inspect_from(facts)).unwrap_err(),
            ExportErrorCode::SourceNotFound
        );
        // A destination that is the second source is refused, by its identity and by its path.
        let mut facts = several_path_facts();
        facts.insert(PathBuf::from(DESTINATION), present_file(2));
        assert_eq!(
            build_plan(&request(DESTINATION), inspect_from(facts)).unwrap_err(),
            ExportErrorCode::OutputEqualsSource
        );
        let mut facts = several_path_facts();
        facts.insert(PathBuf::from(SOURCE_PARENT), present_directory());
        assert_eq!(
            build_plan(&request(SOURCES[1]), inspect_from(facts)).unwrap_err(),
            ExportErrorCode::OutputEqualsSource
        );
    }

    #[test]
    fn pieces_too_far_out_of_order_are_refused_after_the_checks_of_the_sources() {
        // ADR 055: more pieces than `MAX_EXPORT_INPUTS` in reverse source order need one run each.
        let probes = [sample_probe()];
        let reversed: Vec<SegmentBoundary> = (0..=MAX_EXPORT_INPUTS)
            .rev()
            .map(|index| {
                let start = i64::try_from(index).unwrap() * 90_000;
                piece(0, start, start + 90_000)
            })
            .collect();
        let refusal = |pieces: &[SegmentBoundary]| {
            plan_sources(ExportStreams::VideoOnly, &probes, pieces, &sample_preset()).unwrap_err()
        };
        assert_eq!(refusal(&reversed), ExportErrorCode::PiecesOutOfOrder);
        let mut unknown = reversed.clone();
        unknown[0].source = 1;
        assert_eq!(refusal(&unknown), ExportErrorCode::InvalidSources);
        let mut empty = reversed.clone();
        empty[1].out_pts = empty[1].in_pts;
        assert_eq!(refusal(&empty), ExportErrorCode::InvalidSegment);
        let mut ordered = reversed;
        ordered.reverse();
        assert!(plan_sources(
            ExportStreams::VideoOnly,
            &probes,
            &ordered,
            &sample_preset()
        )
        .is_ok());
    }

    #[test]
    fn the_limit_counts_pieces_whatever_the_count_of_sources() {
        // ADR 055: the limit of pieces no longer lowers with each source.
        let probes = [sample_probe(), sample_probe()];
        // The pieces are in source order, so their runs fit (ADR 055).
        let pieces: Vec<SegmentBoundary> = (0..=MAX_EXPORT_PIECES)
            .map(|index| {
                let start = i64::try_from(index).unwrap() * 90_000;
                piece(index % 2, start, start + 90_000)
            })
            .collect();
        assert_eq!(
            plan_sources(ExportStreams::VideoOnly, &probes, &pieces, &sample_preset()).unwrap_err(),
            ExportErrorCode::TooManySegments
        );
        assert!(plan_sources(
            ExportStreams::VideoOnly,
            &probes,
            &pieces[..MAX_EXPORT_PIECES],
            &sample_preset()
        )
        .is_ok());
    }

    /// The plan of `pieces` over `count` sources, all at the path of the first of [`SOURCES`],
    /// with the probe of [`sample_probe`].
    fn plan_of_many_sources(
        count: usize,
        pieces: &[SegmentBoundary],
    ) -> Result<ExportPlan, ExportErrorCode> {
        let frames = AudioFrames::default();
        let probe = sample_probe();
        let sources: Vec<PlanSource<'_>> = (0..count)
            .map(|_| PlanSource {
                path: Path::new(SOURCES[0]),
                probe: &probe,
                audio_frames: &frames,
            })
            .collect();
        build_plan(
            &PlanRequest {
                sources: &sources,
                destination: Path::new(DESTINATION),
                segments: pieces,
                preset: &sample_preset(),
                streams: ExportStreams::VideoOnly,
                audio_mode: ExportAudioMode::Encode,
            },
            inspect_from(several_path_facts()),
        )
    }

    #[test]
    fn more_sources_than_inputs_are_refused_in_the_order_of_adr_055() {
        // Each source needs one input, so an export uses at most `MAX_EXPORT_INPUTS` sources.
        let one_each = |count: usize| -> Vec<SegmentBoundary> {
            (0..count).map(|source| piece(source, 0, 90_000)).collect()
        };
        assert!(plan_of_many_sources(MAX_EXPORT_INPUTS, &one_each(MAX_EXPORT_INPUTS)).is_ok());
        let over = MAX_EXPORT_INPUTS + 1;
        assert_eq!(
            plan_of_many_sources(over, &one_each(over)).unwrap_err(),
            ExportErrorCode::TooManySources
        );

        // `noSegments`, `tooManySegments` and `invalidSources` come first.
        assert_eq!(
            plan_of_many_sources(over, &[]).unwrap_err(),
            ExportErrorCode::NoSegments
        );
        let mut many = one_each(over);
        many.resize(MAX_EXPORT_PIECES + 1, piece(0, 0, 90_000));
        assert_eq!(
            plan_of_many_sources(over, &many).unwrap_err(),
            ExportErrorCode::TooManySegments
        );
        let mut unknown = one_each(over);
        unknown[4].source = over;
        assert_eq!(
            plan_of_many_sources(over, &unknown).unwrap_err(),
            ExportErrorCode::InvalidSources
        );
        // `invalidSources` also comes before `invalidSegment`.
        let mut both = one_each(over);
        both[4].source = over;
        both[2].out_pts = both[2].in_pts;
        assert_eq!(
            plan_of_many_sources(over, &both).unwrap_err(),
            ExportErrorCode::InvalidSources
        );

        // `invalidSegment` and `piecesOutOfOrder` come after.
        let mut empty = one_each(over);
        empty[2].out_pts = empty[2].in_pts;
        assert_eq!(
            plan_of_many_sources(over, &empty).unwrap_err(),
            ExportErrorCode::TooManySources
        );
        let mut reversed = one_each(over);
        for index in (1..=MAX_EXPORT_INPUTS as i64).rev() {
            reversed.push(piece(0, index * 90_000, (index + 1) * 90_000));
        }
        assert_eq!(
            plan_of_many_sources(over, &reversed).unwrap_err(),
            ExportErrorCode::TooManySources
        );
    }

    #[test]
    fn a_silence_of_another_name_than_the_shared_layout_is_named_in_the_closing_format() {
        // Streams that share a layout without a plain name, beside a source without audio or a
        // stream without packets: the silence takes `6c`, so every chain names `6c`, and
        // `concat` does not choose between two layouts.
        let preset = Preset {
            audio_sample_rate: AudioSampleRateSetting::Source,
            audio_channels: AudioChannels::Source,
            ..sample_preset()
        };
        let custom = Some("6 channels (FL+FR+FC+LFE+SL+SR)");
        let with_audio = |audio: Option<AudioProbe>| MediaProbe {
            audio,
            ..sample_probe()
        };
        let pieces = [piece(0, 0, 90_000), piece(1, 0, 90_000)];
        let layout_of = |second: Option<AudioProbe>| {
            plan_sources(
                ExportStreams::VideoAndAudio,
                &[
                    with_audio(Some(audio_stream(1, 48_000, 6, custom))),
                    with_audio(second),
                ],
                &pieces,
                &preset,
            )
            .unwrap()
            .audio
            .unwrap()
            .output_layout
        };
        assert_eq!(layout_of(None).as_deref(), Some("6c"));
        let mut empty = audio_stream(1, 48_000, 6, custom);
        empty.holds_no_packets = true;
        assert_eq!(layout_of(Some(empty)).as_deref(), Some("6c"));
        // Two streams of that layout, read both, need no name: no silence meets them.
        assert_eq!(layout_of(Some(audio_stream(1, 48_000, 6, custom))), None);
        // A plain shared name is the name of the silence too.
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[
                with_audio(Some(audio_stream(1, 48_000, 6, Some("5.1")))),
                with_audio(None),
            ],
            &pieces,
            &preset,
        )
        .unwrap();
        assert_eq!(plan.audio.unwrap().output_layout, None);
        // One source of that layout whose stream holds no packets names none, as before.
        let mut alone = audio_stream(1, 48_000, 6, custom);
        alone.holds_no_packets = true;
        let plan = plan_sources(
            ExportStreams::VideoAndAudio,
            &[with_audio(Some(alone))],
            &pieces[..1],
            &preset,
        )
        .unwrap();
        assert_eq!(plan.audio.unwrap().output_layout, None);
    }
}
