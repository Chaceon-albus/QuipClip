//! Decide whether an export copies the packets of the source audio, in place of a decode and an
//! encode (ADR 048).
//!
//! [`decide`] is pure, as [`super::plan::build_plan`] is, and the plan calls it when the request
//! asks for a copy. It answers with the [`CopiedAudio`] of the plan, or with the reason the plan
//! encodes the audio instead. No reason fails the export: an encode writes the audio that the user
//! asked for, cut to the sample, and the reason goes to the log. The interface offers the copy only
//! where its own facts allow it, by the same lists of codecs and demuxers and the same lowest
//! sample rate (`src/features/export/audioCopy.ts`, whose test compares them with these). The
//! other reasons are facts that only the export reads: where the audio starts and ends inside the
//! segment, and the gaps inside it.
//!
//! A copy keeps whole packets, so each end of the copied audio lies within one packet of its point
//! where the audio covers the segment. It writes no silence. Audio that starts late, ends early or
//! has a gap inside the segment would stay so in the output: it would start or stop more than one
//! packet from its point, an export without video that ends early would fail its duration check,
//! a segment with no audio would give no packet to copy, and a player that ignores an MP4 edit
//! list would play the audio early. The plan encodes such audio, and the fill of the graph writes
//! its silence (ADR 014).

use super::arguments::muxer_of;
use super::plan::SegmentBoundary;
use super::{CopiedAudio, ExportStreams};
use crate::ffmpeg::probe::{AudioFrames, MediaProbe, FINE_GAP_MILLISECONDS};
use crate::settings::Container;
use crate::time::{pts_seconds, Rational};

/// One audio codec whose packets an export copies, and the muxers that take them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopyableAudio {
    /// The codec, by the name that ffprobe gives it in `codec_name`.
    pub codec: &'static str,
    /// The muxers that take the packets of the codec, by the names of `arguments::muxer_of`.
    pub muxers: &'static [&'static str],
}

/// The codecs whose packets an export copies, each with the muxers that take them.
///
/// ADR 048 lists the codec and muxer pairs that were measured on FFmpeg 9.0.2, through the NUT
/// pipe of an export with video and into the file of an export without video. The packets of the
/// output were the packets of the source, and the audio kept its place against the video.
///
/// - E-AC-3 is not in the list. The NUT pipe gives it the codec of AC-3, and the `mp4` muxer then
///   refuses it (ADR 048 measurement 7).
/// - Opus goes into Matroska only. The `mov` muxer refuses it (ADR 023), and in the `mp4` muxer
///   its last packet ended before the Out point.
/// - FLAC, ALAC, PCM, Vorbis and every other codec were not measured. A packet of PCM can hold a
///   whole chunk of a MOV file, much longer than one frame of a codec in this list.
pub const COPYABLE_AUDIO: [CopyableAudio; 4] = [
    CopyableAudio {
        codec: "aac",
        muxers: &["mp4", "mov", "matroska"],
    },
    CopyableAudio {
        codec: "mp3",
        muxers: &["mp4", "mov", "matroska"],
    },
    CopyableAudio {
        codec: "ac3",
        muxers: &["mp4", "mov", "matroska"],
    },
    CopyableAudio {
        codec: "opus",
        muxers: &["matroska"],
    },
];

/// The demuxers of the sources whose audio an export copies, each by a name that ffprobe lists in
/// `format_names`: MP4 and MOV, Matroska and WebM, MPEG-TS, and FLV. These were measured (ADR 048).
pub const COPY_SOURCE_FORMATS: [&str; 4] = ["mov", "matroska", "mpegts", "flv"];

/// The lowest sample rate, in hertz, of audio that an export copies.
///
/// A frame of AAC, MP3 and AC-3 lasts 2048 samples at most, the frame of HE-AAC as the decoder
/// gives it, which is 64 ms at this rate. Below it, one packet of those codecs can last longer
/// than [`COPY_MAX_EDGE_MILLISECONDS`], and the plan would refuse most copies. An Opus frame does
/// not follow the rate, and lasts 120 ms at most; the plan reads its length from the frames.
pub const MIN_COPY_SAMPLE_RATE: u32 = 32_000;

/// The most, in milliseconds, that one end of the audio may lie inside the segment, and that a gap
/// inside the segment may last, for the plan to copy the audio.
///
/// The bound of each end is the longest frame that the read of the frames found: one packet, which
/// the user accepts for a copy. This caps it. The check of an export without video allows its
/// audio to end 100 ms early (`verify::AUDIO_DURATION_SHORT_TOLERANCE_MS`), so an end within this
/// distance passes it with a margin of 40 ms.
pub const COPY_MAX_EDGE_MILLISECONDS: i64 = 60;

/// The fewest frames, of the longest frame of the read, that a segment must last for the plan to
/// copy its audio.
///
/// The copy keeps the packets that start inside the segment. A segment shorter than the distance
/// between two packet starts can hold none, and the copy then writes a stream without packets: the
/// encoder stops at the end of its pipe before any video, and a file without video holds no stream
/// (ADR 048). The rules of [`decide`] leave at most two frames between the In point and the next
/// packet start, one frame in front of the first frame of the read and one gap of one frame, so
/// three frames always hold a packet start. One frame of video at 24 to 60 frames per second is
/// shorter than three frames of every codec of [`COPYABLE_AUDIO`].
pub const SHORT_SEGMENT_PACKETS: i64 = 3;

/// Why a plan encodes the audio that the request asked it to copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyRefusal {
    /// The export writes no audio.
    NoAudioWritten,
    /// The export has more than one segment.
    NotOneSegment,
    /// The source has no audio stream, or its stream holds no packets.
    NoAudio,
    /// The demuxer of the source is not one of [`COPY_SOURCE_FORMATS`].
    SourceFormat,
    /// The sample rate of the stream is unknown, or below [`MIN_COPY_SAMPLE_RATE`].
    SampleRate,
    /// The muxer of the output does not take the codec of the stream, by [`COPYABLE_AUDIO`].
    Codec,
    /// A boundary of the segment is not a time, or the In point lies before zero, where an output
    /// `-ss` was not measured.
    Boundary,
    /// The read of the frames inside the segment found none, or failed. Nothing then shows that
    /// the stream holds packets to copy there.
    NoFrames,
    /// The segment lasts less than [`SHORT_SEGMENT_PACKETS`] of the longest frame of the read, and
    /// may hold no packet start to copy.
    ShortSegment,
    /// The audio starts after the In point.
    LateStart,
    /// The audio has a gap inside the segment.
    Gap,
    /// The audio ends before the Out point.
    EarlyEnd,
}

/// What [`decide`] reads.
#[derive(Debug, Clone, Copy)]
pub struct CopyQuestion<'a> {
    /// The probe of the source, corrected from the first audio packet as the plan reads it.
    pub probe: &'a MediaProbe,
    /// The streams that the export writes.
    pub streams: ExportStreams,
    /// The container of the preset, which selects the muxer.
    pub container: Container,
    /// The segments of the request.
    pub segments: &'a [SegmentBoundary],
    /// What the read of the frames inside the segments found (`ffmpeg::probe::probe_audio_gaps`).
    /// Empty when the read found no frame, or failed.
    pub frames: &'a AudioFrames,
}

/// The [`CopiedAudio`] of a plan whose request asks for a copy of the audio, or the reason the
/// plan encodes the audio instead.
///
/// The checks run in the order of [`CopyRefusal`], and the first failure wins. The last five read
/// the frames that the export read inside the segment ([`AudioFrames`]); the probe of the stream is
/// not enough, because it can report audio that covers a segment that holds none. One packet is
/// the longest frame of the read, capped at [`COPY_MAX_EDGE_MILLISECONDS`]:
///
/// - A read that found no frame, or failed, gives no copy.
/// - A segment shorter than [`SHORT_SEGMENT_PACKETS`] of the longest frame, not capped, gives no
///   copy.
/// - The first frame of the read may start up to one packet after the In point, and
///   [`FINE_GAP_MILLISECONDS`] more for the timestamps of Matroska and FLV, which are whole
///   milliseconds. The read of a Matroska source leaves out the frame that holds the In point, and
///   a decoder can drop that frame after its seek, so the first frame of a stream that covers the
///   In point lies within one packet after it (ADR 048 measurement 14). A later first frame is a
///   late start.
/// - A gap between two frames ([`AudioFrames::fine_gaps`]) that reaches into the segment and is
///   longer than one packet is a gap. A shorter one is one packet of error, as at the ends.
/// - The end of the last frame may lie up to one packet before the Out point. The read stops at the
///   first packet at or after the Out point, so an earlier end is an early end.
///
/// # Errors
///
/// The [`CopyRefusal`] of the first check that fails.
pub fn decide(question: &CopyQuestion<'_>) -> Result<CopiedAudio, CopyRefusal> {
    if !question.streams.writes_audio() {
        return Err(CopyRefusal::NoAudioWritten);
    }
    let [segment] = question.segments else {
        return Err(CopyRefusal::NotOneSegment);
    };
    let probe = question.probe;
    let audio = probe
        .audio
        .as_ref()
        .filter(|audio| !audio.holds_no_packets)
        .ok_or(CopyRefusal::NoAudio)?;
    if !probe
        .format_names
        .iter()
        .any(|name| COPY_SOURCE_FORMATS.contains(&name.as_str()))
    {
        return Err(CopyRefusal::SourceFormat);
    }
    if !audio
        .sample_rate
        .is_some_and(|rate| rate >= MIN_COPY_SAMPLE_RATE)
    {
        return Err(CopyRefusal::SampleRate);
    }
    let (muxer, _) = muxer_of(question.container, question.streams.writes_video());
    let codec = audio.codec.as_deref().ok_or(CopyRefusal::Codec)?;
    if !COPYABLE_AUDIO
        .iter()
        .any(|copyable| copyable.codec == codec && copyable.muxers.contains(&muxer))
    {
        return Err(CopyRefusal::Codec);
    }

    let start = pts_seconds(segment.in_pts, probe.video_time_base).ok_or(CopyRefusal::Boundary)?;
    let end = pts_seconds(segment.out_pts, probe.video_time_base).ok_or(CopyRefusal::Boundary)?;
    if start.num() < 0 || start >= end {
        return Err(CopyRefusal::Boundary);
    }

    let frames = question.frames;
    let (Some(last), Some(longest)) = (frames.end, frames.longest_frame) else {
        return Err(CopyRefusal::NoFrames);
    };
    let first = frames
        .fine_gaps
        .iter()
        .find(|gap| gap.from.is_none())
        .map(|gap| gap.to)
        .ok_or(CopyRefusal::NoFrames)?;
    let shortest = Rational::new(SHORT_SEGMENT_PACKETS, 1)
        .and_then(|count| longest.mul(count))
        .ok_or(CopyRefusal::Boundary)?;
    if end.sub(start).ok_or(CopyRefusal::Boundary)? < shortest {
        return Err(CopyRefusal::ShortSegment);
    }
    let cap = Rational::new(COPY_MAX_EDGE_MILLISECONDS, 1000)
        .expect("COPY_MAX_EDGE_MILLISECONDS/1000 always reduces to a valid Rational");
    let packet = longest.min(cap);
    let rounding = Rational::new(FINE_GAP_MILLISECONDS, 1000)
        .expect("FINE_GAP_MILLISECONDS/1000 always reduces to a valid Rational");
    let latest_first = packet.add(rounding).ok_or(CopyRefusal::Boundary)?;
    if first.sub(start).ok_or(CopyRefusal::Boundary)? > latest_first {
        return Err(CopyRefusal::LateStart);
    }
    for gap in &frames.fine_gaps {
        let Some(from) = gap.from else {
            continue;
        };
        if from < end && gap.to > start && gap.to.sub(from).ok_or(CopyRefusal::Boundary)? > packet {
            return Err(CopyRefusal::Gap);
        }
    }
    if end.sub(last).ok_or(CopyRefusal::Boundary)? > packet {
        return Err(CopyRefusal::EarlyEnd);
    }

    Ok(CopiedAudio {
        stream_index: audio.index,
        start,
        end,
        adts_to_asc: codec == "aac" && probe.format_names.iter().any(|name| name == "mpegts"),
    })
}
