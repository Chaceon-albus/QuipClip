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

use super::{
    ExportErrorCode, ExportPlan, OutputTiming, PlannedAudio, PlannedSegment, MAX_EXPORT_SEGMENTS,
    SEEK_MARGIN_SECONDS,
};
use crate::ffmpeg::probe::MediaProbe;
use crate::settings::{AudioSampleRateSetting, FrameRateSetting, Preset, ResolutionSetting};
use crate::time::{pts_seconds, Pts, Rational};
use std::path::Path;

/// One requested segment boundary, before [`build_plan`] derives a seek position or audio
/// ticks from it.
///
/// This is deliberately narrower than `project::Segment`: a plan request only needs the two
/// PTS values that name a source interval, not the segment's id or its source id. ADR 002's
/// half-open convention applies here exactly as it does to `project::Segment`: `in_pts` is
/// inclusive, `out_pts` is the PTS of the first excluded presented frame, and a valid
/// boundary has `in_pts < out_pts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentBoundary {
    pub in_pts: Pts,
    pub out_pts: Pts,
}

/// The plain data [`build_plan`] needs to plan one export.
///
/// `segments` carries request order, and [`ExportPlan::segments`] preserves that order
/// exactly: ADR 014's "The command" section concatenates the rendered segments in project
/// array order, so this function must never reorder or deduplicate them. Concat order need
/// not match source-PTS order; see [`ExportPlan::single_input_seek_seconds`] for a case
/// where that distinction matters.
pub struct PlanRequest<'a> {
    /// The source media file every segment cuts from. Must be an absolute path.
    pub source: &'a Path,
    /// The final output location. Must also be an absolute path.
    pub destination: &'a Path,
    /// The requested segment boundaries, in concat order.
    pub segments: &'a [SegmentBoundary],
    /// The source's probe, from a re-probe taken when the export starts (ADR 014's
    /// "Other rules": the renderer re-probes rather than trusting stale project metadata).
    pub probe: &'a MediaProbe,
    /// The export preset selecting the container, the encoders, the quality, and the two
    /// output settings.
    pub preset: &'a Preset,
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
/// 2. `segments` holds more than [`MAX_EXPORT_SEGMENTS`] --
///    [`ExportErrorCode::TooManySegments`].
/// 3. Any segment has `in_pts >= out_pts` -- [`ExportErrorCode::InvalidSegment`].
/// 4. `source` is empty, contains a NUL byte, or is not absolute --
///    [`ExportErrorCode::SourcePathInvalid`].
/// 5. `source` does not exist -- [`ExportErrorCode::SourceNotFound`].
/// 6. `source` is not a regular file -- [`ExportErrorCode::SourceNotFile`].
/// 7. `destination` is empty, contains a NUL byte, has no file name, has no parent, or is
///    not absolute -- [`ExportErrorCode::OutputPathInvalid`].
/// 8. `destination`'s parent is missing or is not a directory --
///    [`ExportErrorCode::OutputDirectoryMissing`].
/// 9. `destination` exists but is a directory, or is neither a regular file nor a directory
///    -- [`ExportErrorCode::OutputPathInvalid`].
/// 10. `destination` and `source` name the same file --
///     [`ExportErrorCode::OutputEqualsSource`].
/// 11. `destination` exists as a regular file the user protected against writing --
///     [`ExportErrorCode::OutputReadOnly`].
/// 12. The preset's frame rate is [`FrameRateSetting::Source`] but the probe has neither a
///     valid `avg_frame_rate` nor `r_frame_rate`, or the resolved rate is not strictly
///     positive -- [`ExportErrorCode::SourceFrameRateUnknown`].
/// 13. The probe reports an audio stream whose sample rate is absent, not positive, or
///     larger than `u32` -- [`ExportErrorCode::SourceAudioRateUnknown`].
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
/// rational sum of every segment's duration, and `expected_frames` rounds each segment's
/// frame count individually before summing -- never the reverse, since rounding the total
/// instead can produce a different, and wrong, expected count.
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
    if segments.len() > MAX_EXPORT_SEGMENTS {
        return Err(ExportErrorCode::TooManySegments);
    }
    if segments
        .iter()
        .any(|segment| segment.in_pts >= segment.out_pts)
    {
        return Err(ExportErrorCode::InvalidSegment);
    }

    let source = request.source;
    if !source_path_is_valid(source) {
        return Err(ExportErrorCode::SourcePathInvalid);
    }
    let source_facts = inspect(source);
    match source_facts {
        PathFacts::Absent => return Err(ExportErrorCode::SourceNotFound),
        PathFacts::Directory | PathFacts::Other => return Err(ExportErrorCode::SourceNotFile),
        PathFacts::File { .. } => {}
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

    let same_identity = matches!(
        (source_facts, destination_facts),
        (PathFacts::File { identity: a, .. }, PathFacts::File { identity: b, .. }) if a == b
    );
    if source == destination || same_identity {
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
    // purpose: a destination that *is* the source is the more dangerous condition and the more
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

    let probe = request.probe;
    let preset = request.preset;
    let output_frame_rate = match preset.frame_rate {
        FrameRateSetting::Rate(rate) => rate,
        FrameRateSetting::Source => probe
            .avg_frame_rate
            .or(probe.r_frame_rate)
            .ok_or(ExportErrorCode::SourceFrameRateUnknown)?,
    };
    // A non-positive frame rate cannot time anything (the graph builder would have to emit
    // `fps=0` or worse). `settings::validate_settings` already rejects a non-positive rate
    // for a saved preset, and `probe::normalize` already filters the probe's own rates to
    // strictly positive ones, but `PlanRequest` accepts any `&Preset` and any `&MediaProbe`,
    // so this function re-checks cheaply here rather than trusting either precondition
    // silently. There is no dedicated "invalid frame rate" code, so this reuses
    // `SourceFrameRateUnknown`: whichever path produced the value, the renderer still has no
    // usable rate to time the output with.
    if output_frame_rate.num() <= 0 {
        return Err(ExportErrorCode::SourceFrameRateUnknown);
    }

    let video_time_base = probe.video_time_base;
    let zero = zero_rational();
    let format_start_time = probe.format_start_time.unwrap_or(zero);
    let margin = seek_margin_rational();
    // An audio stream with no usable sample rate is refused, not dropped. ADR 014 cuts audio
    // at integer ticks of `1 / sample_rate` and forbids the microsecond `atrim` fallback, so
    // there is no exact way to cut this track. Planning it away instead would set `concat=a=0`
    // and emit neither `-map "[a]"` nor `-c:a`, and the export would then exit zero with a
    // video-only file for a source whose audio the preview played -- the same silent failure
    // ADR 014 rules out for the short stream specifier one paragraph earlier.
    //
    // The output format is resolved here too, so the graph renders numbers and never reads the
    // preset. `source` for the rate becomes the source stream's own rate. `source` for the
    // channels stays as it is, because the probe reports a channel count and not a layout; see
    // `PlannedAudio::output_channels`. The rate range and the bitrate range are not re-checked
    // here: `settings::validate_settings` bounds both, and `commands::export` plans only from a
    // preset it read out of the settings document through the validating `settings::load`.
    let audio = match probe.audio.as_ref() {
        None => None,
        Some(audio) => {
            let sample_rate = audio
                .sample_rate
                .ok_or(ExportErrorCode::SourceAudioRateUnknown)?;
            let output_sample_rate = match preset.audio_sample_rate {
                AudioSampleRateSetting::Source => sample_rate,
                AudioSampleRateSetting::Fixed(rate) => rate,
            };
            Some(PlannedAudio {
                stream_index: audio.index,
                sample_rate,
                output_sample_rate,
                output_channels: preset.audio_channels,
            })
        }
    };

    let mut planned_segments = Vec::with_capacity(segments.len());
    let mut total_duration = zero;
    let mut total_frames: u64 = 0;

    for segment in segments {
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

        let (audio_in_tick, audio_out_tick) = match audio {
            Some(audio) => {
                let in_tick = audio_tick(segment.in_pts, video_time_base, audio.sample_rate)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                let out_tick = audio_tick(segment.out_pts, video_time_base, audio.sample_rate)
                    .ok_or(ExportErrorCode::InvalidSegment)?;
                (Some(in_tick), Some(out_tick))
            }
            // `ExportPlan::audio` is `None`, which now means one thing only: the source
            // reports no audio stream. Both ticks stay `None` too, distinct from an
            // overflow above, which is reported as an error rather than silently `None`.
            None => (None, None),
        };

        let segment_frames_exact = duration
            .mul(output_frame_rate)
            .ok_or(ExportErrorCode::InvalidSegment)?;
        let segment_frames = round_rational_to_i128(segment_frames_exact)
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(ExportErrorCode::InvalidSegment)?;
        total_frames = total_frames
            .checked_add(segment_frames)
            .ok_or(ExportErrorCode::InvalidSegment)?;

        total_duration = total_duration
            .add(duration)
            .ok_or(ExportErrorCode::InvalidSegment)?;

        planned_segments.push(PlannedSegment {
            in_pts: segment.in_pts,
            out_pts: segment.out_pts,
            seek_seconds,
            audio_in_tick,
            audio_out_tick,
        });
    }

    let resolution = match preset.resolution {
        ResolutionSetting::Source => None,
        ResolutionSetting::Custom(resolution) => Some(resolution),
    };

    Ok(ExportPlan {
        source: source.to_path_buf(),
        destination: destination.to_path_buf(),
        video_stream_index: probe.video_stream_index,
        audio,
        segments: planned_segments,
        timing: OutputTiming::ConstantFrameRate(output_frame_rate),
        resolution,
        video_encoder: preset.video_encoder.clone(),
        audio_encoder: preset.audio_encoder.clone(),
        audio_bitrate: preset.audio_bitrate,
        quality: preset.quality,
        container: preset.container,
        total_duration,
        expected_frames: Some(total_frames),
    })
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
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            resolution: ResolutionSetting::Source,
            frame_rate: FrameRateSetting::Source,
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

    fn plan_with(
        segments: &[SegmentBoundary],
        probe: &MediaProbe,
        preset: &Preset,
        facts: HashMap<PathBuf, PathFacts>,
    ) -> Result<ExportPlan, ExportErrorCode> {
        let source = Path::new(SOURCE);
        let destination = Path::new(DESTINATION);
        let request = PlanRequest {
            source,
            destination,
            segments,
            probe,
            preset,
        };
        build_plan(&request, inspect_from(facts))
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
        let segments: Vec<SegmentBoundary> = (0..=MAX_EXPORT_SEGMENTS as i64)
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
        let segments: Vec<SegmentBoundary> = (0..MAX_EXPORT_SEGMENTS as i64)
            .map(|index| boundary(index * 10, index * 10 + 5))
            .collect();
        let plan = plan_with(
            &segments,
            &sample_probe(),
            &sample_preset(),
            valid_path_facts(),
        )
        .unwrap();
        assert_eq!(plan.segments.len(), MAX_EXPORT_SEGMENTS);
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
                source: Path::new(source),
                destination: Path::new(DESTINATION),
                segments: &[boundary(0, 1)],
                probe: &sample_probe(),
                preset: &sample_preset(),
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
                source: Path::new(SOURCE),
                destination: Path::new(destination),
                segments: &[boundary(0, 1)],
                probe: &sample_probe(),
                preset: &sample_preset(),
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
            source: Path::new(SOURCE),
            destination: Path::new(SOURCE),
            segments: &[boundary(0, 1)],
            probe: &sample_probe(),
            preset: &sample_preset(),
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
        assert_eq!(plan.source, PathBuf::from(SOURCE));
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
            plan.timing,
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
            plan.timing,
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
        assert_eq!(plan.expected_frames, Some(6));
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
        assert_eq!(plan.expected_frames, Some(3));
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

    // -- computation: the second graph shape's single seek ---------------------------------

    #[test]
    fn single_input_seek_seconds_uses_the_earliest_segment_by_in_pts_not_array_order() {
        // Concat order deliberately reverses source order here: the first segment in the
        // array starts later in the source than the second. A naive implementation that
        // reused `segments[0].seek_seconds` for ADR 014's second graph shape would seek to
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
        assert_eq!(plan.single_input_seek_seconds(), None);
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
                stream_index: 1,
                sample_rate: 44_100,
                output_sample_rate: 48_000,
                output_channels: AudioChannels::Stereo,
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
                stream_index: 2,
                sample_rate: 48_000,
                output_sample_rate: 48_000,
                output_channels: AudioChannels::Stereo,
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
                stream_index: 1,
                sample_rate: 44_100,
                output_sample_rate: 44_100,
                output_channels: AudioChannels::Source,
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
            assert_eq!(audio.sample_rate, 44_100);
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
            assert_eq!(plan.audio_bitrate, bitrate);
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
        assert_eq!(plan.audio_bitrate, None);
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
        assert_eq!(plan.resolution, None);
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
        assert_eq!(plan.resolution, Some(Resolution { w: 1280, h: 720 }));
    }
}
