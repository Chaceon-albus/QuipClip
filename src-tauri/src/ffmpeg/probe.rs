//! ffprobe execution and normalization for imported media, and for the finished file of an
//! export that writes no video ([`probe_output_audio`]).

use crate::ffmpeg::capabilities::smoke::{kill_and_reap, read_capped};
use crate::procutil::command_without_console;
use crate::time::{format_seconds, pts_seconds, FrameCount, Pts, Rational, TickCount};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::ffi::OsStr;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// The deadline one `ffprobe` run gets before it is killed.
///
/// ADR 006 bounds the smoke test because "a broken hardware encoder can hang instead of
/// fail". An `ffprobe` that reads a file on a share which stops answering has the same
/// failure mode, and the cost is higher: an export holds the single export slot while its
/// re-probe runs, so a stalled probe would hold that slot until the application restarts, and
/// every later export would wait behind it in the queue (ADR 049).
///
/// 30 seconds is far above the real cost of a probe, even of a large file on a slow disk,
/// and it is short enough that a person waiting on an import is told something rather than
/// left with an interface that never leaves the loading state.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// How often [`probe_media_within`] looks at the child process.
///
/// The same interval the smoke test uses. It bounds how long a finished `ffprobe` waits to
/// be noticed, and a probe is short enough that the poll rate costs nothing next to it.
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The largest number of stdout bytes one probe retains.
///
/// `Command::output()` kept no bound at all here. This one exists so a child that never
/// stops writing cannot exhaust memory, and it is set far above any real answer: the JSON of
/// `-show_format -show_streams` is a few kilobytes for an ordinary file and stays well under
/// a megabyte even for a container with an unusual number of streams. A truncated answer is
/// not silently accepted -- it is invalid JSON, so it reports [`ProbeError::Parse`]. The one
/// answer that is not JSON, the frames of [`probe_audio_gaps`], is about 3 MB for each hour of
/// audio that it reads. Its parse fails an answer that reaches this limit.
const STDOUT_CAPTURE_LIMIT: usize = 16 * 1024 * 1024;

/// The largest number of stderr bytes one probe retains, matching the smoke path's cap.
///
/// This is a **head** cap: [`read_capped`] keeps the first 8 KiB. `capabilities::smoke`'s
/// `STDERR_CAPTURE_LIMIT` is the same head cap of the same size, and `ffmpeg::export::process`'s
/// is a **tail** cap. The three are separate constants on purpose: they no longer bound the same
/// end of a stream, so one shared constant would assert an equality that is not true.
const STDERR_CAPTURE_LIMIT: usize = 8 * 1024;

/// Normalized media facts needed by the editor and later capability checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub format_names: Vec<String>,
    pub format_long_name: Option<String>,
    /// The container start time, from `format.start_time`, in seconds.
    ///
    /// ADR 014 measurement 8: an input `-ss` is relative to this value, not to an absolute
    /// timestamp. The renderer computes each seek as `inPts * videoTimeBase - formatStartTime
    /// - margin`, so this must stay exact and must never round-trip through `f64` (ADR 002).
    ///
    /// This is not the video stream's own start time. ADR 014 measurement 2 compared the
    /// container start time against the video stream's start time, both in seconds, and the
    /// two values differed in every one of its six fixtures, not only when an audio stream
    /// starts first.
    ///
    /// A missing value here is not a harmless default: the renderer then has to treat the
    /// container as if it started at zero, and an export can silently drop frames from the
    /// start of a segment when the real start time was not zero.
    pub format_start_time: Option<Rational>,
    pub video_codec: String,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub video_stream_index: u32,
    pub video_time_base: Rational,
    pub video_start_pts: Option<Pts>,
    pub video_duration_ticks: Option<TickCount>,
    /// The approximate length of the video in seconds, counted from the first video frame, as
    /// `video_duration_ticks` counts it (ADR 002, ADR 046). It is the stream duration when
    /// ffprobe gives one. Otherwise it is `format.duration` less the lead of the video start
    /// over the container start. Matroska and FLV have their own rules, because their
    /// `format.duration` can be the end timestamp: see [`approximate_duration`] and
    /// [`correct_flv_probe`]. For UI layout and browser seeks only.
    pub approximate_duration_seconds: Option<f64>,
    pub avg_frame_rate: Option<Rational>,
    pub r_frame_rate: Option<Rational>,
    pub reported_frame_count: Option<FrameCount>,
    /// The shape of one stored pixel, from the stream's `sample_aspect_ratio` (`64:45` gives
    /// 64/45), or `None` when ffprobe reports none, `N/A`, `0:1` or a part that is not positive.
    /// `None` reads as square pixels.
    pub sample_aspect_ratio: Option<Rational>,
    /// The clockwise turn, 0, 90, 180 or 270 degrees, that a player applies to show the stored
    /// picture upright. See [`display_rotation`].
    pub rotation: u16,
    /// The exclusive end of the video: the PTS that follows the last presented frame, in
    /// `video_time_base` (ADR 052). Only the probe of an import reads it ([`probe_media`]), from
    /// the tags of an FLV ([`flv_video_end`]) or from the last packets of any other file
    /// ([`probe_video_end`]). `None` when that read failed. The re-probe of an export
    /// ([`probe_media_until_canceled`]) leaves it `None` for every file, FLV included, so no
    /// export code reads an end that only some files carry; the export takes the end from the
    /// project.
    pub video_end_pts: Option<Pts>,
    pub audio: Option<AudioProbe>,
}

/// Basic facts about the preferred audio stream, when one exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    /// The absolute stream index of this audio stream, as ffprobe reported it.
    ///
    /// The export filter graph must address this exact stream by its absolute index. A short
    /// specifier such as `[0:a]` does not invoke ffmpeg's "best stream" selection; filter
    /// graph label resolution walks the input's streams in order and binds the first one
    /// that matches. That is not always the stream `preferred_stream` picked below, which
    /// prefers the stream that carries the `default` disposition: the two rules disagree
    /// whenever the default audio stream is not the first audio stream. One test fixture in
    /// this file is exactly that case — `preferred_stream` returns stream 2, and `[0:a]`
    /// would bind stream 1 (ADR 014).
    pub index: u32,
    pub codec: Option<String>,
    /// The sample rate of this stream in hertz, or `None` when ffprobe reports none or `0`.
    ///
    /// ffprobe reports `0` for the audio of an MPEG-TS or MPEG-PS source whose first packet comes
    /// after its analysis. An export that writes audio then reads the rate from that packet
    /// ([`probe_audio_sample_rate_at`]).
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    /// The channel layout of this stream as ffprobe names it, such as `stereo` or `5.1(side)`, or
    /// `None` when ffprobe reports none or `unknown`.
    ///
    /// Only the export reads it, to generate silence in the layout of a stream that holds no
    /// packets ([`Self::holds_no_packets`]). It is not on the import wire.
    #[serde(skip)]
    pub channel_layout: Option<String>,
    /// The number of packets the container records for this stream, from `nb_frames`, or `None`
    /// when ffprobe reports none.
    ///
    /// An MP4 file records the samples of each track in its index, so its count is there before
    /// any packet is read. A Matroska file records none. Only [`Self::take_no_packet`] reads it.
    #[serde(skip)]
    pub reported_packets: Option<u64>,
    /// True when the stream holds no audio at all: the export's read of its first packet found
    /// none, and the container does not contradict that read ([`Self::take_no_packet`]).
    ///
    /// The probe never sets it. It analyzes only the start of the file, and it gives a stream
    /// without packets the start and the length of the container, so such a stream looks like
    /// audio that covers the whole file. The export then generates silence and reads no input for
    /// the audio, because an input whose audio never arrives makes FFmpeg keep the decoded video
    /// of the whole rest of the file in memory (ADR 014 measurement 26).
    #[serde(skip)]
    pub holds_no_packets: bool,
    /// The time of the first sample of this stream, in seconds on the timeline of the container,
    /// or `None` when ffprobe reports none.
    ///
    /// This is `start_pts` times the stream's `time_base`, exact, and the decimal `start_time`
    /// only when one of those two is missing. It is the time `-copyts` gives the stream's first
    /// sample, which is the timeline of the segment boundaries. A source whose audio starts after
    /// its video, such as a recording that opened the microphone late, has a value above the
    /// video's start here.
    ///
    /// The export reads this only to bound the silence that its segments need in front of the
    /// first sample, and to tell that silence from a gap inside the stream
    /// (`MAX_HELD_AUDIO_SILENCE_SECONDS` of the export module). [`Self::duration`]
    /// decided, with this, whether the segments took their audio from a second input, until the
    /// audio of an export with video got its own process (ADR 043). No decision reads the length
    /// now. Neither is an edit boundary (ADR 002), and neither is on the import wire: the
    /// interface does not read them.
    ///
    /// ffprobe can report the start of the container here when the audio starts more than about
    /// 5 s into a Matroska, MPEG-TS or MPEG-PS file. An export that writes audio therefore
    /// corrects this value, and [`Self::duration`] with it, from the first packet of the stream
    /// ([`Self::take_first_packet`]).
    #[serde(skip)]
    pub start_time: Option<Rational>,
    /// The length of this stream in seconds, or `None` when ffprobe reports none.
    ///
    /// This is `duration_ts` times the stream's `time_base`, exact; then the decimal `duration`;
    /// then [`Self::tagged_end`] less [`Self::start_time`], because the `matroska` demuxer reports
    /// no other length for a stream and its tag holds the end of the track. A source whose audio
    /// stops before its video, such as a phone recording, has a value below the video's length
    /// here.
    #[serde(skip)]
    pub duration: Option<Rational>,
    /// The end of this stream in seconds on the timeline of the container, from its `DURATION`
    /// tag, or `None` when the stream has no such tag or the tag does not parse.
    ///
    /// Only [`Self::take_first_packet`] reads this field directly. It is the end of the track
    /// that [`Self::duration`] subtracts the start from. It is kept so that a start that moves
    /// still has an end when ffprobe reported no end of the stream, or reported an end that does
    /// not lie after the first packet.
    #[serde(skip)]
    pub tagged_end: Option<Rational>,
}

impl AudioProbe {
    /// Correct [`Self::start_time`] with `first_packet`, the time of the first packet of this
    /// stream that [`probe_first_audio_packet`] read. Returns whether the start moved.
    ///
    /// The start moves only when the packet comes after the reported start, or when ffprobe
    /// reported no start. An earlier packet changes nothing: a source that ffprobe reads
    /// correctly has its first packet at the reported start, or before it by the priming of the
    /// encoder, which the reported start of a Matroska stream already skips.
    ///
    /// The first packet comes after the reported start only when the analysis of ffprobe read
    /// no packet of the stream. The start and the length that ffprobe then reports belong to the
    /// container: `libavformat` gives a stream that it has no time for the start and the
    /// duration of the container. That `duration_ts` is therefore not a length of the stream, and
    /// the length must not stay as it is.
    ///
    /// This keeps the end of the stream and moves its start. The end is the reported start plus
    /// the reported length, which is the end of the container when the values are the
    /// container's. Only when that end is unknown, or does not lie after `first_packet`, is the
    /// end [`Self::tagged_end`], and only when the tag lies after the packet. The reported end
    /// comes first because a muxer other than FFmpeg's can write the length of the track in the
    /// tag (ADR 036), and such a tag read as an end would end the audio early. When ffprobe
    /// reported a start, the end therefore never moves before the end that the export used
    /// without this correction. When it reported none, there was no end before, and the tag can
    /// give one. The length is the end less the new start, or `None` when no end lies after the
    /// packet.
    pub fn take_first_packet(&mut self, first_packet: Rational) -> bool {
        if self.start_time.is_some_and(|start| first_packet <= start) {
            return false;
        }
        let reported_end = self
            .start_time
            .zip(self.duration)
            .and_then(|(start, length)| start.add(length));
        let end = reported_end
            .into_iter()
            .chain(self.tagged_end)
            .find(|end| *end > first_packet);
        self.start_time = Some(first_packet);
        self.duration = end
            .and_then(|end| end.sub(first_packet))
            .filter(|length| length.num() > 0);
        true
    }

    /// Record that [`probe_first_audio_packet`] read this stream and found no packet. Returns
    /// whether [`Self::holds_no_packets`] is now set.
    ///
    /// That read reports no packet only when ffprobe wrote no error, but a read error that no
    /// demuxer reports still ends the read as the end of the file does. The container can show
    /// that the read ended early, and then the mark is not set:
    ///
    /// - [`Self::reported_packets`] counts at least one packet, as the index of an MP4 file does.
    /// - [`Self::tagged_end`] lies after zero. The `matroska` muxer of FFmpeg writes the end of
    ///   the track there, `00:00:00.000000000` for a track without packets (ADR 014 measurement
    ///   26). A muxer that writes the length of the track in the same tag gives a time after zero
    ///   for audio too.
    ///
    /// Only the `DURATION` tag counts. Older versions of mkvmerge write their statistics as
    /// `DURATION-eng` and `NUMBER_OF_FRAMES-eng`, and this check does not read them, so for such a
    /// file only the stderr of the read guards a stream with audio.
    ///
    /// Without the mark the stream keeps what the probe reported, as after a read that failed.
    pub fn take_no_packet(&mut self) -> bool {
        let counted = self.reported_packets.is_some_and(|count| count > 0);
        let tagged = self.tagged_end.is_some_and(|end| end.num() > 0);
        self.holds_no_packets = !counted && !tagged;
        self.holds_no_packets
    }
}

/// A failure to invoke ffprobe or normalize its output.
#[derive(Debug)]
pub enum ProbeError {
    Spawn {
        source: io::Error,
    },
    ProcessFailed {
        code: Option<i32>,
        stderr: Vec<u8>,
    },
    Parse {
        source: ProbeParseError,
        stderr: Vec<u8>,
    },
    /// `ffprobe` was still running at the deadline and was killed. See [`PROBE_TIMEOUT`] for
    /// why the probe is bounded at all.
    TimedOut {
        timeout: Duration,
        stderr: Vec<u8>,
    },
    /// The caller's cancel flag was set while `ffprobe` ran, and the run killed it.
    ///
    /// Only [`probe_output_audio`], [`probe_first_audio_packet`], [`probe_audio_sample_rate_at`]
    /// and [`probe_audio_gaps`] take a cancel flag: they run while an export holds the
    /// export slot, where a user's Stop and an application quit (ADR 017) must not wait out
    /// [`PROBE_TIMEOUT`]. [`probe_media`] never reports this.
    Canceled,
}

/// A deterministic JSON parsing or normalization failure.
#[derive(Debug)]
pub enum ProbeParseError {
    Json(serde_json::Error),
    Invalid(ProbeDataError),
}

/// Invalid or incomplete ffprobe data required for source identification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeDataError {
    MissingVideo,
    MissingField {
        field: &'static str,
    },
    InvalidInteger {
        field: &'static str,
        value: String,
    },
    InvalidTimeBase {
        value: String,
    },
    InvalidDimensions {
        width: i128,
        height: i128,
    },
    /// The answer of [`probe_audio_gaps`] cannot be read, for the reason `detail` names.
    InvalidFrames {
        detail: &'static str,
    },
}

impl fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn { source } => write!(formatter, "could not start ffprobe: {source}"),
            Self::ProcessFailed { code, .. } => {
                write!(
                    formatter,
                    "ffprobe exited unsuccessfully with status {code:?}"
                )
            }
            Self::Parse { source, .. } => write!(formatter, "ffprobe output is invalid: {source}"),
            Self::TimedOut { timeout, .. } => {
                write!(formatter, "ffprobe did not finish within {timeout:?}")
            }
            Self::Canceled => write!(formatter, "ffprobe was stopped by a cancel request"),
        }
    }
}

impl Error for ProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn { source } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::ProcessFailed { .. } | Self::TimedOut { .. } | Self::Canceled => None,
        }
    }
}

impl fmt::Display for ProbeParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "malformed JSON: {error}"),
            Self::Invalid(error) => error.fmt(formatter),
        }
    }
}

impl Error for ProbeParseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Invalid(_) => None,
        }
    }
}

impl fmt::Display for ProbeDataError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingVideo => write!(formatter, "no video stream was reported"),
            Self::MissingField { field } => write!(formatter, "required field {field} is missing"),
            Self::InvalidInteger { field, value } => {
                write!(formatter, "{field} is not a valid integer: {value}")
            }
            Self::InvalidTimeBase { value } => {
                write!(formatter, "video time_base is not positive: {value}")
            }
            Self::InvalidDimensions { width, height } => {
                write!(formatter, "video dimensions are invalid: {width}x{height}")
            }
            Self::InvalidFrames { detail } => {
                write!(
                    formatter,
                    "the frames of the audio read are invalid: {detail}"
                )
            }
        }
    }
}

impl Error for ProbeDataError {}

impl From<serde_json::Error> for ProbeParseError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<ProbeDataError> for ProbeParseError {
    fn from(error: ProbeDataError) -> Self {
        Self::Invalid(error)
    }
}

/// Run the resolved ffprobe executable and normalize its JSON output, within
/// [`PROBE_TIMEOUT`], and read the end of the video. The import uses this form.
///
/// The end of an FLV whose tags the reader can read comes from its tags already
/// ([`correct_flv_probe`]). Any other file, and an FLV that the tags gave no end, takes it from a
/// second run that reads the last packets of the video ([`probe_video_end`]). A failure of that
/// run leaves the end `None` and does not fail the import, as a failed read of an audio start
/// does not fail an export (ADR 014).
pub fn probe_media(ffprobe_path: &Path, media_path: &Path) -> Result<MediaProbe, ProbeError> {
    let (mut probe, extent) =
        probe_media_and_flv_extent(ffprobe_path, media_path, PROBE_TIMEOUT, None)?;
    probe.video_end_pts = extent
        .and_then(|extent| extent.last_video_pts)
        .and_then(|last_ms| flv_video_end(&probe, last_ms))
        .or_else(|| probe_video_end(ffprobe_path, media_path, &probe));
    Ok(probe)
}

/// [`probe_media`] under a cancel flag: a set flag kills ffprobe at its next poll and returns
/// [`ProbeError::Canceled`].
///
/// The re-probe of an export uses this form. The export holds the single export slot while it
/// prepares, and a cancel must not wait for the whole deadline on a share that stopped
/// answering.
pub fn probe_media_until_canceled(
    ffprobe_path: &Path,
    media_path: &Path,
    cancel: &AtomicBool,
) -> Result<MediaProbe, ProbeError> {
    probe_media_with(ffprobe_path, media_path, PROBE_TIMEOUT, Some(cancel))
}

/// [`probe_media`] with an explicit deadline.
///
/// The bound is a constant rather than a parameter of every caller because it is one policy
/// for the whole application, exactly as `capabilities::smoke::SMOKE_TIMEOUT` is; this form
/// exists so the deadline can be varied under test.
pub fn probe_media_within(
    ffprobe_path: &Path,
    media_path: &Path,
    timeout: Duration,
) -> Result<MediaProbe, ProbeError> {
    probe_media_with(ffprobe_path, media_path, timeout, None)
}

/// The body of [`probe_media_within`] and [`probe_media_until_canceled`]. These forms read no
/// end of the video, so `video_end_pts` is `None` for every file.
fn probe_media_with(
    ffprobe_path: &Path,
    media_path: &Path,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<MediaProbe, ProbeError> {
    probe_media_and_flv_extent(ffprobe_path, media_path, timeout, cancel).map(|(probe, _)| probe)
}

/// The first run of every probe of a source, with the extent that the tags of an FLV gave, when
/// the file is an FLV that the reader can read.
fn probe_media_and_flv_extent(
    ffprobe_path: &Path,
    media_path: &Path,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> Result<(MediaProbe, Option<crate::flv::locate::Extent>), ProbeError> {
    let arguments = [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-of"),
        OsStr::new("json"),
        OsStr::new("-show_format"),
        OsStr::new("-show_streams"),
        OsStr::new("-i"),
        media_path.as_os_str(),
    ];
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        timeout,
        PROBE_POLL_INTERVAL,
        cancel,
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    let mut probe = finish_probe_run(run, timeout)?;
    // The tags give the length of an FLV better than ffprobe does.
    let extent = correct_flv_file(&mut probe, media_path);
    Ok((probe, extent))
}

/// How one `ffprobe` run ended, and everything it wrote.
#[derive(Debug)]
struct ProbeRun {
    end: ProbeEnd,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// How one `ffprobe` run ended.
#[derive(Debug, Clone, Copy)]
enum ProbeEnd {
    /// The process ended on its own.
    Exited(ProbeExit),
    /// The process was still running at the deadline and was killed.
    TimedOut,
    /// The caller's cancel flag was set while the process ran, and it was killed.
    Canceled,
}

/// The exit status of an `ffprobe` that ended on its own.
#[derive(Debug, Clone, Copy)]
struct ProbeExit {
    code: Option<i32>,
    success: bool,
}

/// What ffprobe reports about the finished file of an export that writes no video.
///
/// [`MediaProbe`] cannot describe that file: it requires a video stream, and refuses a file
/// without one as [`ProbeDataError::MissingVideo`]. This type holds only the three facts the
/// success check of `ffmpeg::export::verify` reads, and it requires nothing, so an output with
/// the wrong streams is reported by that check rather than as a parse failure here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputAudioProbe {
    /// The number of streams whose `codec_type` is `audio`.
    pub audio_streams: u32,
    /// The number of streams whose `codec_type` is `video`, an attached picture included.
    pub video_streams: u32,
    /// The duration of the file in seconds, exact, or `None` when ffprobe reports none.
    ///
    /// This is `format.duration`, and the duration of the one audio stream only when the format
    /// reports none. The format field is the one both audio containers fill: the `matroska`
    /// demuxer reports no stream duration for an `.mka`, and keeps the length in the segment
    /// header, which ffprobe shows as `format.duration`. In an `.m4a` the two agree.
    pub duration: Option<Rational>,
    /// The `start_time` of the one audio stream, in seconds, exact, or `None` when the file holds
    /// another number of audio streams or ffprobe reports none.
    ///
    /// An `.m4a` whose audio was copied starts its audio where the first packet lies after the In
    /// point, less the priming of AAC, and its `duration` counts from that start (ADR 048). The
    /// check of a copy adds the two.
    pub audio_start: Option<Rational>,
}

/// Run the resolved ffprobe executable on the finished file of an export that writes no video,
/// within [`PROBE_TIMEOUT`], and stop it when `cancel` is set.
///
/// The invocation, the runner and the deadline are those of [`probe_media`], so this probe
/// follows the same rules for its child process (`procutil`, ADR 018) and cannot hold the export
/// slot for longer than one probe of the source could.
///
/// `cancel` is the export's own flag. The runner reads it at every poll, so a Stop, or the
/// cancel that an application quit sends (ADR 017), kills ffprobe within one poll interval and
/// returns [`ProbeError::Canceled`]. The export then ends as canceled, and the guard of its
/// reservation deletes the temporary file. A source that stopped answering would otherwise hold
/// the export in the canceling state for up to [`PROBE_TIMEOUT`], far past the five seconds a
/// quit waits.
pub fn probe_output_audio(
    ffprobe_path: &Path,
    output_path: &Path,
    cancel: &AtomicBool,
) -> Result<OutputAudioProbe, ProbeError> {
    let arguments = [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-of"),
        OsStr::new("json"),
        OsStr::new("-show_format"),
        OsStr::new("-show_streams"),
        OsStr::new("-i"),
        output_path.as_os_str(),
    ];
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        PROBE_TIMEOUT,
        PROBE_POLL_INTERVAL,
        Some(cancel),
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    finish_probe_run_with(run, PROBE_TIMEOUT, parse_output_audio_json)
}

/// Read [`OutputAudioProbe`] from the JSON of `-show_format -show_streams`.
///
/// Only malformed JSON fails. A missing `streams` array counts no streams, and a duration that
/// is absent, `N/A`, or not a fixed-point decimal reads as `None`; the success check reports
/// both conditions with a code of its own.
pub fn parse_output_audio_json(json: &[u8]) -> Result<OutputAudioProbe, ProbeParseError> {
    let raw: RawOutputProbe = serde_json::from_slice(json)?;
    let count = |kind: &str| {
        let streams = raw
            .streams
            .iter()
            .filter(|stream| stream.codec_type.as_deref() == Some(kind))
            .count();
        u32::try_from(streams).unwrap_or(u32::MAX)
    };
    let audio_streams = count("audio");
    let video_streams = count("video");
    let only_audio = || {
        let mut audio = raw
            .streams
            .iter()
            .filter(|stream| stream.codec_type.as_deref() == Some("audio"));
        match (audio.next(), audio.next()) {
            (Some(stream), None) => Some(stream),
            _ => None,
        }
    };
    let duration = raw
        .format
        .as_ref()
        .and_then(|format| parse_decimal_seconds(format.duration.as_deref()))
        .or_else(|| {
            only_audio().and_then(|stream| parse_decimal_seconds(stream.duration.as_deref()))
        });
    let audio_start =
        only_audio().and_then(|stream| parse_decimal_seconds(stream.start_time.as_deref()));
    Ok(OutputAudioProbe {
        audio_streams,
        video_streams,
        duration,
        audio_start,
    })
}

#[derive(Deserialize)]
struct RawOutputProbe {
    #[serde(default)]
    streams: Vec<RawOutputStream>,
    format: Option<RawOutputFormat>,
}

#[derive(Deserialize)]
struct RawOutputStream {
    codec_type: Option<String>,
    duration: Option<String>,
    start_time: Option<String>,
}

#[derive(Deserialize)]
struct RawOutputFormat {
    duration: Option<String>,
}

/// Parse a duration that ffprobe writes with `%f`, exactly, or `None` for anything else.
///
/// This is [`parse_format_start_time`]'s rule, for a duration: fixed point through
/// `Rational::from_decimal_str`, never `f64` (ADR 002), and `N/A` or any other text as unknown.
fn parse_decimal_seconds(value: Option<&str>) -> Option<Rational> {
    let text = value
        .map(str::trim)
        .filter(|text| !text.is_empty() && *text != "N/A")?;
    Rational::from_decimal_str(text)
}

/// What [`probe_first_audio_packet`] reads about the first packet of one stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstAudioPacket {
    /// The `pts` of the packet times the `time_base` of the stream, exact, or `None` when the
    /// packet has no usable `pts` or the stream no positive time base.
    pub time: Option<Rational>,
    /// The byte position of the packet in the file, or `None` when ffprobe reports none.
    pub position: Option<u64>,
    /// The id of the stream in its container, such as the PID of an MPEG-TS stream, or `None`
    /// when the container gives its streams no id, as Matroska does.
    pub stream_id: Option<u32>,
}

/// Run the resolved ffprobe executable to read the first packet of the stream `stream_index` of
/// `media_path`, within [`PROBE_TIMEOUT`], and stop it when `cancel` is set.
///
/// [`probe_media`] analyzes about the first 5 s of a file. In a Matroska, MPEG-TS or MPEG-PS source
/// whose audio starts later than that, it reports the start of the container as the start of the
/// audio (ADR 014 measurements 22 and 25). After the same analysis, this run reads packets until
/// the first packet of the one stream, and decodes none of them, so it finds that start at any
/// distance.
/// [`AudioProbe::take_first_packet`] applies its time. Its position and the id of the stream let
/// [`probe_audio_sample_rate_at`] read a sample rate that the analysis missed.
///
/// The answer is `None` only when the stream holds no packet, as far as this read can tell; see
/// [`first_packet_answer`]. The runner, the deadline and the cancel rule are those of
/// [`probe_output_audio`] (`procutil`, ADR 018).
pub fn probe_first_audio_packet(
    ffprobe_path: &Path,
    media_path: &Path,
    stream_index: u32,
    cancel: &AtomicBool,
) -> Result<Option<FirstAudioPacket>, ProbeError> {
    let stream = stream_index.to_string();
    let arguments = [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-select_streams"),
        OsStr::new(&stream),
        OsStr::new("-show_entries"),
        OsStr::new("packet=pts,pos:stream=id,time_base"),
        // Stop after one packet of the selected stream. The packets of the other streams in
        // front of it are read and dropped, not decoded.
        OsStr::new("-read_intervals"),
        OsStr::new("%+#1"),
        OsStr::new("-of"),
        OsStr::new("json"),
        OsStr::new("-i"),
        media_path.as_os_str(),
    ];
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        PROBE_TIMEOUT,
        PROBE_POLL_INTERVAL,
        Some(cancel),
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    let stderr = run.stderr.clone();
    let packet = finish_probe_run_with(run, PROBE_TIMEOUT, parse_first_packet_json)?;
    first_packet_answer(packet, stderr)
}

/// Decide what an answer of [`probe_first_audio_packet`] that exited successfully says, given what
/// ffprobe wrote to stderr.
///
/// A packet is an answer whatever stderr holds. An answer without a packet is not always the end of
/// the stream: ffprobe ends its read of packets at a read error as it ends it at the end of the
/// file, and exits 0 either way. A Matroska file that ends early reports `File ended prematurely`
/// and lists no packet, although its track holds audio further on (ADR 014 measurement 26). So an
/// answer without a packet reads as `None`, a stream without packets, only when ffprobe wrote
/// nothing but white space to stderr. Otherwise it is a read that failed:
/// [`ProbeError::Parse`] with a missing `packets` field, and the stderr of the run.
fn first_packet_answer(
    packet: Option<FirstAudioPacket>,
    stderr: Vec<u8>,
) -> Result<Option<FirstAudioPacket>, ProbeError> {
    if packet.is_none() && !stderr.iter().all(u8::is_ascii_whitespace) {
        return Err(ProbeError::Parse {
            source: ProbeParseError::Invalid(ProbeDataError::MissingField { field: "packets" }),
            stderr,
        });
    }
    Ok(packet)
}

/// Read the answer of [`probe_first_audio_packet`].
///
/// Malformed JSON fails. An answer without a packet reads as `None` when it lists the selected
/// stream, and fails with a missing `streams` field when it does not: ffprobe then found no stream
/// at that index, which says nothing about the packets of the stream the caller means. A packet
/// without a usable `pts`, `pos` or stream `id`, and a missing or non-positive time base, leave
/// that field `None`: the caller then keeps what [`probe_media`] reported for it.
pub fn parse_first_packet_json(json: &[u8]) -> Result<Option<FirstAudioPacket>, ProbeParseError> {
    let raw: RawFirstPacket = serde_json::from_slice(json)?;
    let Some(packet) = raw.packets.first() else {
        if raw.streams.is_empty() {
            return Err(ProbeParseError::Invalid(ProbeDataError::MissingField {
                field: "streams",
            }));
        }
        return Ok(None);
    };
    let stream = raw.streams.first();
    let pts = parse_optional_i64_value(packet.pts.as_ref(), "packets.pts")
        .ok()
        .flatten();
    let time_base = stream
        .and_then(|stream| stream.time_base.as_deref())
        .and_then(Rational::from_ffprobe)
        .filter(|value| value.num() > 0);
    let position = parse_optional_i64_value(packet.pos.as_ref(), "packets.pos")
        .ok()
        .flatten()
        .and_then(|position| u64::try_from(position).ok());
    Ok(Some(FirstAudioPacket {
        time: pts
            .zip(time_base)
            .and_then(|(pts, time_base)| pts_seconds(Pts::new(pts), time_base)),
        position,
        stream_id: stream.and_then(|stream| parse_stream_id(stream.id.as_deref())),
    }))
}

/// Parse a stream `id` as ffprobe writes it, `0x` and hexadecimal digits, or decimal digits.
fn parse_stream_id(value: Option<&str>) -> Option<u32> {
    let text = value?.trim();
    match text.strip_prefix("0x") {
        Some(hex) if !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            u32::from_str_radix(hex, 16).ok()
        }
        Some(_) => None,
        None if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => {
            text.parse().ok()
        }
        None => None,
    }
}

#[derive(Deserialize)]
struct RawFirstPacket {
    #[serde(default)]
    packets: Vec<RawPacket>,
    #[serde(default)]
    streams: Vec<RawPacketStream>,
}

#[derive(Deserialize)]
struct RawPacket {
    pts: Option<Value>,
    pos: Option<Value>,
}

#[derive(Deserialize)]
struct RawPacketStream {
    id: Option<String>,
    time_base: Option<String>,
}

/// How far in front of the approximate end of the video [`probe_video_end`] starts its read, in
/// seconds.
///
/// The approximate duration is a float of the container's or the stream's own account, and ffprobe
/// seeks to the keyframe at or before the start of the interval. 10 s covers an approximate
/// duration that is a few seconds long, and the frames that a decoder reorders past the last
/// keyframe, and it costs a few hundred packets of JSON.
const VIDEO_TAIL_MARGIN_SECONDS: i64 = 10;

/// The deadline of one run of [`probe_video_end`].
///
/// Shorter than [`PROBE_TIMEOUT`]: the import waits for this run after the first one, and it
/// reads a fact that the import does not need. A file whose read goes back far, as a very long
/// GOP or the second read from the start makes it, or a file on a slow share, gives up its end
/// rather than hold the import for another 30 s.
const VIDEO_TAIL_TIMEOUT: Duration = Duration::from_secs(10);

/// Run the resolved ffprobe executable to read the exclusive end of the video of `media_path`
/// (ADR 052), each run within [`VIDEO_TAIL_TIMEOUT`]. `probe` is the answer of the first run.
///
/// The first run reports no end that is exact: `duration_ts` is absent from Matroska, MPEG-TS
/// and FLV, and the durations are floats. This run reads the packets of the video stream from
/// [`VIDEO_TAIL_MARGIN_SECONDS`] before the approximate end, and decodes none of them;
/// [`parse_video_tail_json`] takes the end from them.
///
/// An answer without a keyframe is not the whole tail. An MP4 or a Matroska file that is asked
/// for a start past its end goes back to its last keyframe, but MPEG-TS and MPEG-PS resync on
/// the next packet: a TS of 29.9 s asked for 40 s listed one packet, not the one with the largest
/// `pts`, and a program stream listed packets whose `pts` was their `dts`. An approximate
/// duration more than 10 s long, as a duration from the bitrate gives it, starts the read there.
/// So such an answer reads the file again once, from the start of the video
/// ([`video_tail_restart`]), and an answer from there without a keyframe is no end.
///
/// `None` when the approximate duration is unknown, so the run has no place to start, and when
/// a run fails in any way: an end that cannot be read is an unknown end, not a failed import.
/// The import has no cancel, as the first run has none.
pub fn probe_video_end(ffprobe_path: &Path, media_path: &Path, probe: &MediaProbe) -> Option<Pts> {
    let video_start = video_start_seconds(probe);
    let first = video_tail_start(
        probe.format_start_time,
        video_start,
        probe.approximate_duration_seconds,
    )?;
    match read_video_tail(ffprobe_path, media_path, probe, first)? {
        VideoTail::Read(end) => end,
        VideoTail::WithoutKeyframe => {
            let restart = video_tail_restart(probe.format_start_time, video_start)?;
            if restart >= first {
                return None;
            }
            match read_video_tail(ffprobe_path, media_path, probe, restart)? {
                VideoTail::Read(end) => end,
                VideoTail::WithoutKeyframe => None,
            }
        }
    }
}

/// One run of [`probe_video_end`] from `start` seconds. `None` when the run fails.
fn read_video_tail(
    ffprobe_path: &Path,
    media_path: &Path,
    probe: &MediaProbe,
    start: Rational,
) -> Option<VideoTail> {
    let interval = format!("{}%", format_seconds(start, 6)?);
    let stream = probe.video_stream_index.to_string();
    let arguments = [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-select_streams"),
        OsStr::new(&stream),
        OsStr::new("-show_entries"),
        OsStr::new("packet=pts,duration,flags"),
        // From the keyframe at or before `start` to the end of the file.
        OsStr::new("-read_intervals"),
        OsStr::new(&interval),
        OsStr::new("-of"),
        OsStr::new("json"),
        OsStr::new("-i"),
        media_path.as_os_str(),
    ];
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        VIDEO_TAIL_TIMEOUT,
        PROBE_POLL_INTERVAL,
        None,
    )
    .ok()?;
    finish_probe_run_with(run, VIDEO_TAIL_TIMEOUT, |json| {
        parse_video_tail_json(json, probe)
    })
    .ok()
}

/// The exact time of the first video frame of `probe` in seconds, or `None` when the probe gives
/// no start or the time base cannot carry it.
fn video_start_seconds(probe: &MediaProbe) -> Option<Rational> {
    probe
        .video_start_pts
        .and_then(|pts| pts_seconds(pts, probe.video_time_base))
}

/// The start of the first read of [`probe_video_end`], in seconds on the timeline that
/// `-read_intervals` seeks on: the start of the file plus the whole seconds of the approximate
/// duration, less [`VIDEO_TAIL_MARGIN_SECONDS`], and not below 0.
///
/// The start of the file is the container start, else the exact start of the video, else 0. A
/// TS that starts at 1000 s and reports no container start would otherwise read from its first
/// packet. This is a seek target, not a timestamp of the edit, so the float of the approximate
/// duration may decide it: only its whole seconds enter, and the rest of the arithmetic is exact.
/// `None` when the approximate duration is unknown.
fn video_tail_start(
    format_start_time: Option<Rational>,
    video_start: Option<Rational>,
    approximate_duration_seconds: Option<f64>,
) -> Option<Rational> {
    let duration =
        approximate_duration_seconds.filter(|value| value.is_finite() && *value >= 0.0)?;
    // `as` saturates a float that is too large, and the checked arithmetic below then refuses it.
    let whole_seconds = Rational::new(duration.floor() as i64, 1)?;
    let margin = Rational::new(VIDEO_TAIL_MARGIN_SECONDS, 1)?;
    let start = format_start_time
        .or(video_start)
        .unwrap_or(Rational::new(0, 1)?)
        .add(whole_seconds)?
        .sub(margin)?;
    non_negative(start)
}

/// The start of the second read of [`probe_video_end`]: the container start, else the exact
/// start of the video, else 0, and not below 0.
fn video_tail_restart(
    format_start_time: Option<Rational>,
    video_start: Option<Rational>,
) -> Option<Rational> {
    non_negative(
        format_start_time
            .or(video_start)
            .unwrap_or(Rational::new(0, 1)?),
    )
}

fn non_negative(value: Rational) -> Option<Rational> {
    if value.num() < 0 {
        Rational::new(0, 1)
    } else {
        Some(value)
    }
}

/// What one answer of [`probe_video_end`] says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoTail {
    /// The answer holds a keyframe, so it holds every frame from that keyframe to the end of the
    /// file: the end, or `None` when the packets give none.
    Read(Option<Pts>),
    /// The answer holds no keyframe, so it may be only a part of the tail.
    WithoutKeyframe,
}

/// Read the answer of [`probe_video_end`] for the video that `probe` describes.
///
/// Malformed JSON fails. An answer without a packet flagged `K` is
/// [`VideoTail::WithoutKeyframe`]: the frame with the largest `pts` comes after the last keyframe
/// in decode order, so only a read that starts at a keyframe is sure to hold it. Otherwise the
/// end is [`video_end_from_packets`] of the packets that are presented, with the nominal frame
/// interval of `probe` as the duration of a packet that gives none.
///
/// A packet whose `flags` hold `D` is not presented, so it gives no end. ffprobe 9 prints such
/// flags as `_D_` and `KD_`. It flags them so in an MP4 whose edit list ends before the media
/// of its track: a track of 2 s at 30 fps whose edit was cut to 1.5 s listed every packet of
/// the last 0.5 s with its own `pts` and `duration` and the flag `D`, and the last presented
/// frame was the last packet without it. The pre-roll in front of an edit list that starts
/// after the first keyframe carries the same flag. A stream copy with `-t` writes no tail edit:
/// it ends the track at a packet, and every packet that it writes is presented.
///
/// A presented packet without a usable `pts` makes the end `None`. That packet is a frame whose
/// time the read does not know, and it can be the last one: an MPEG-2 program stream with
/// B-frames listed its last two packets in decode order with `pts` `N/A`, and the largest `pts`
/// of the others ended two frames early. Such files list `N/A` throughout, so an MPEG-PS source
/// and an AVI with B-frames always get no end, and their clips keep an approximate extent
/// (ADR 052).
pub fn parse_video_tail_json(
    json: &[u8],
    probe: &MediaProbe,
) -> Result<VideoTail, ProbeParseError> {
    let raw: RawVideoTail = serde_json::from_slice(json)?;
    let flagged = |packet: &RawTailPacket, flag: char| {
        packet
            .flags
            .as_deref()
            .is_some_and(|flags| flags.contains(flag))
    };
    if !raw.packets.iter().any(|packet| flagged(packet, 'K')) {
        return Ok(VideoTail::WithoutKeyframe);
    }
    let packets: Option<Vec<TailPacket>> = raw
        .packets
        .iter()
        .filter(|packet| !flagged(packet, 'D'))
        .map(|packet| {
            let pts = parse_optional_i64_value(packet.pts.as_ref(), "packets.pts")
                .ok()
                .flatten()?;
            let duration = parse_optional_i64_value(packet.duration.as_ref(), "packets.duration")
                .ok()
                .flatten();
            Some(TailPacket { pts, duration })
        })
        .collect();
    let Some(packets) = packets else {
        return Ok(VideoTail::Read(None));
    };
    let interval = nominal_interval_ticks(
        probe.avg_frame_rate.or(probe.r_frame_rate),
        probe.video_time_base,
    )
    .map(ceil_to_ticks);
    Ok(VideoTail::Read(video_end_from_packets(
        &packets,
        interval,
        probe.video_start_pts,
    )))
}

/// One presented packet of the read of [`probe_video_end`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailPacket {
    pub pts: i64,
    pub duration: Option<i64>,
}

/// The exclusive end of the video from its last packets (ADR 052): the largest `pts + duration`
/// over `packets`.
///
/// The packets come in decode order, so the packet with the largest `pts` is not the last one
/// when the stream reorders its frames. A packet without a duration or with a duration that is
/// not positive lasts `interval` ticks, the nominal frame interval rounded up to a whole tick;
/// when such a packet exists and there is no interval, the end is `None`. `None` as well when
/// `packets` is empty, when a sum overflows, and when the end is not after `start`, the PTS of
/// the first frame.
pub fn video_end_from_packets(
    packets: &[TailPacket],
    interval: Option<i64>,
    start: Option<Pts>,
) -> Option<Pts> {
    let end = packets
        .iter()
        .map(|packet| {
            let duration = packet
                .duration
                .filter(|duration| *duration > 0)
                .or(interval)?;
            packet.pts.checked_add(duration)
        })
        .collect::<Option<Vec<i64>>>()?
        .into_iter()
        .max()?;
    match start {
        Some(start) if end <= start.value() => None,
        _ => Some(Pts::new(end)),
    }
}

/// The nominal interval of one frame at `rate`, in ticks of `time_base`, exact: `1 / (rate *
/// time_base)`. `None` without a positive rate.
fn nominal_interval_ticks(rate: Option<Rational>, time_base: Rational) -> Option<Rational> {
    let rate = rate.filter(|rate| rate.num() > 0)?;
    rate.mul(time_base)?
        .recip()
        .filter(|interval| interval.num() > 0)
}

/// A number of ticks rounded up to a whole tick. A positive value, such as a frame interval,
/// gives at least 1.
fn ceil_to_ticks(value: Rational) -> i64 {
    // The denominator of a `Rational` is positive, so the Euclidean quotient is the floor, and
    // the floor of `i64::MAX` leaves no remainder to add.
    value.num().div_euclid(value.den()) + i64::from(value.num().rem_euclid(value.den()) != 0)
}

#[derive(Deserialize)]
struct RawVideoTail {
    #[serde(default)]
    packets: Vec<RawTailPacket>,
}

#[derive(Deserialize)]
struct RawTailPacket {
    pts: Option<Value>,
    duration: Option<Value>,
    flags: Option<String>,
}

/// Run the resolved ffprobe executable to read the sample rate of the stream with the id
/// `stream_id`, with the file read from the byte `position`, within [`PROBE_TIMEOUT`], and stop it
/// when `cancel` is set.
///
/// In an MPEG-TS or MPEG-PS source whose audio starts after the analysis of [`probe_media`], the
/// probe reads no packet of the audio stream and reports a sample rate of 0 (ADR 014 measurements
/// 22 and 25). Only the packets of the stream carry the rate. This run starts its own analysis at
/// the position of the first of them, which [`probe_first_audio_packet`] read, so it reads that
/// packet within its first 5 s however late the audio starts (measurement 25). The demuxer finds
/// the program tables again after the skip, but it can number the streams in another order, so
/// the stream is selected by its id and not by its index.
///
/// The answer is `None` when no stream with that id reports a positive rate. The runner, the
/// deadline and the cancel rule are those of [`probe_output_audio`] (`procutil`, ADR 018).
pub fn probe_audio_sample_rate_at(
    ffprobe_path: &Path,
    media_path: &Path,
    position: u64,
    stream_id: u32,
    cancel: &AtomicBool,
) -> Result<Option<u32>, ProbeError> {
    let position = position.to_string();
    let stream = format!("i:{stream_id}");
    let arguments = [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-skip_initial_bytes"),
        OsStr::new(&position),
        OsStr::new("-select_streams"),
        OsStr::new(&stream),
        OsStr::new("-show_entries"),
        OsStr::new("stream=id,sample_rate"),
        OsStr::new("-of"),
        OsStr::new("json"),
        OsStr::new("-i"),
        media_path.as_os_str(),
    ];
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        PROBE_TIMEOUT,
        PROBE_POLL_INTERVAL,
        Some(cancel),
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    finish_probe_run_with(run, PROBE_TIMEOUT, |json| {
        parse_sample_rate_json(json, stream_id)
    })
}

/// Read the answer of [`probe_audio_sample_rate_at`] for the stream with the id `stream_id`.
///
/// Only malformed JSON fails. No stream with that id, and a rate that is absent, `0`, or not an
/// integer that fits a `u32`, read as `None`.
pub fn parse_sample_rate_json(json: &[u8], stream_id: u32) -> Result<Option<u32>, ProbeParseError> {
    let raw: RawSampleRate = serde_json::from_slice(json)?;
    Ok(raw
        .streams
        .iter()
        .find(|stream| parse_stream_id(stream.id.as_deref()) == Some(stream_id))
        .and_then(|stream| {
            parse_optional_text_i64(stream.sample_rate.as_deref(), "streams.sample_rate")
                .ok()
                .flatten()
        })
        .and_then(|rate| u32::try_from(rate).ok())
        .filter(|rate| *rate > 0))
}

#[derive(Deserialize)]
struct RawSampleRate {
    #[serde(default)]
    streams: Vec<RawSampleRateStream>,
}

#[derive(Deserialize)]
struct RawSampleRateStream {
    id: Option<String>,
    sample_rate: Option<String>,
}

/// One stretch of the timeline in which [`probe_audio_gaps`] read no frame of an audio stream.
///
/// Inside a range of the read, a gap is time in which the stream holds no frame. Between two
/// ranges, a gap can also hold time that the read did not cover. A segment lies inside one range,
/// so the part of a gap after its In point holds no frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioGap {
    /// The end of the last frame in front of the gap, in seconds on the timeline of the container,
    /// or `None` when the read found no frame in front of it.
    ///
    /// The read of a range starts with the frame at the start of the range or a frame in front of
    /// it, or with the frame behind it, which a decoder can drop after a seek. A range that starts
    /// at or before the start of the file starts with its first frame. So when this is `None`, the
    /// stream holds no frame between the start of the range of [`Self::to`] and [`Self::to`], give
    /// or take one frame.
    pub from: Option<Rational>,
    /// The start of the first frame behind the gap, in seconds on the timeline of the container.
    pub to: Rational,
}

/// The answer of [`probe_audio_gaps`]: the gaps, and what the decision on a copy of the audio
/// reads about the frames (ADR 048).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioFrames {
    /// The gaps longer than the `min_gap` of the read, in order of time, with the stretch in front
    /// of the first frame. Empty when the read found no frame.
    pub gaps: Vec<AudioGap>,
    /// The gaps longer than [`FINE_GAP_MILLISECONDS`], in the form of [`Self::gaps`].
    ///
    /// The `min_gap` of the export joins the frames on the two sides of a gap of up to 0.1 s,
    /// because the fill of a chain writes no silence for such a gap. A copy writes no silence at
    /// all, so it needs the shorter gaps too.
    pub fine_gaps: Vec<AudioGap>,
    /// The end of the last frame that the read found, in seconds on the timeline of the
    /// container, or `None` when it found none.
    ///
    /// A read stops at the first packet at or after the end of its last range, so where the
    /// stream covers that end, this lies at it or after it. The stretch after the last frame is
    /// not a gap, so only this shows audio that ends inside a segment.
    pub end: Option<Rational>,
    /// The length of the longest frame that the read found, in seconds, or `None` when it found
    /// none: one packet of the stream, as the copy keeps it.
    pub longest_frame: Option<Rational>,
}

/// The longest gap, in milliseconds, between two frames that [`AudioFrames::fine_gaps`] joins.
///
/// Matroska and FLV store their timestamps in milliseconds. A frame of 1024 samples at 48000 Hz
/// lasts 21.333 ms, so the next frame can start up to a millisecond after the end of the one in
/// front of it, with no audio missing between them.
pub const FINE_GAP_MILLISECONDS: i64 = 2;

/// What [`probe_audio_gaps`] reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioGapRead<'a> {
    /// The absolute index of the audio stream.
    pub stream_index: u32,
    /// The sample rate of the stream, which gives each frame its length.
    pub sample_rate: u32,
    /// The ranges of the timeline to read, each a start and an end in seconds, in any order. They
    /// can overlap.
    pub ranges: &'a [(Rational, Rational)],
    /// The longest gap that the answer leaves out. The frames on the two sides of a shorter gap
    /// join.
    pub min_gap: Rational,
    /// The FLV input of the export (ADR 046), whose slices the read opens in place of the seeks
    /// of `-read_intervals`, with one offset for each range, and the work directory of the export
    /// that holds its head (ADR 055), or `None`.
    pub flv: Option<(&'a crate::ffmpeg::export::flv_input::FlvInput, &'a Path)>,
}

/// Run the resolved ffprobe executable to find the gaps in the audio stream `read.stream_index` of
/// `media_path` inside `read.ranges`, within [`PROBE_TIMEOUT`], and stop it when `cancel` is set.
///
/// The fill of an export chain makes the silence of a whole gap inside the stream when the frame
/// behind the gap arrives, and FFmpeg holds that silence in memory until the fill has passed it on
/// (ADR 014 measurement 28). [`probe_media`] reports only where the stream starts. This run decodes
/// the frames of the one stream inside the ranges and reads the timestamp and the number of samples
/// of each frame, as the fill sees them. It decodes no other stream. A read of the packets alone is
/// not enough: an MP4 file stores a gap as the length of the packet in front of it, and the decoder
/// gives that packet the samples of one frame.
///
/// The answer lists the gaps longer than `read.min_gap`, in order of time, and the end of the last
/// frame ([`parse_audio_frames_csv`]). An empty `read.ranges` reads nothing. The runner, the
/// deadline and the cancel rule are those of [`probe_output_audio`] (`procutil`, ADR 018).
pub fn probe_audio_gaps(
    ffprobe_path: &Path,
    media_path: &Path,
    read: &AudioGapRead<'_>,
    cancel: &AtomicBool,
) -> Result<AudioFrames, ProbeError> {
    if read.ranges.is_empty() {
        return Ok(AudioFrames::default());
    }
    if let Some((flv, work_directory)) = read
        .flv
        .filter(|(flv, _)| flv.segment_offsets.len() == read.ranges.len())
    {
        return probe_audio_gaps_in_slices(
            ffprobe_path,
            media_path,
            read,
            flv,
            work_directory,
            cancel,
        );
    }
    let intervals = read_intervals_argument(read.ranges).ok_or_else(|| ProbeError::Parse {
        source: invalid_frames("a range cannot be written in microseconds"),
        stderr: Vec::new(),
    })?;
    let stream = read.stream_index.to_string();
    let arguments = audio_gap_arguments(&stream, &intervals, media_path.as_os_str());
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        PROBE_TIMEOUT,
        PROBE_POLL_INTERVAL,
        Some(cancel),
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    finish_probe_run_with(run, PROBE_TIMEOUT, |csv| {
        parse_audio_frames_csv(csv, read.sample_rate, read.min_gap)
    })
}

/// The arguments of one read of the audio gaps: the stream `stream`, the intervals `intervals` of
/// `-read_intervals`, and the input `input`.
///
/// The intervals grow with the pieces of the source: [`read_intervals_argument`] writes one
/// interval for each range that touches no other: about 27 bytes for each piece of an ordinary
/// source (ADR 055), and at most 56 with bounds of the widest `i64`. The test `the_gap_read_of_the_most_pieces_fits_the_windows_budget` holds the command at
/// [`crate::ffmpeg::export::MAX_EXPORT_PIECES`] pieces inside the Windows budget.
fn audio_gap_arguments<'a>(
    stream: &'a str,
    intervals: &'a str,
    input: &'a OsStr,
) -> [&'a OsStr; 12] {
    [
        OsStr::new("-v"),
        OsStr::new("error"),
        OsStr::new("-select_streams"),
        OsStr::new(stream),
        OsStr::new("-show_entries"),
        OsStr::new("frame=pts_time,nb_samples"),
        OsStr::new("-read_intervals"),
        OsStr::new(intervals),
        OsStr::new("-of"),
        OsStr::new("csv=p=0"),
        OsStr::new("-i"),
        input,
    ]
}

/// [`probe_audio_gaps`] for an FLV source (ADR 046). FFmpeg cannot seek in an FLV without a
/// keyframe index, so each interval of `-read_intervals` would read the file from its start. The
/// read therefore opens one slice for each group of ranges that overlap or touch: the head and
/// the source from the keyframe of the earliest range of the group, which the export opens too.
/// It reads the slice from its start to the end of the group, `-read_intervals %<end>`. The tags
/// keep their timestamps, so the answers join in order of time and parse as one. All the runs
/// share one [`PROBE_TIMEOUT`]. The head is named by its full path in `work_directory`, the work
/// directory of the export, so the read keeps the working directory of this process.
///
/// An export can join up to [`crate::ffmpeg::export::MAX_EXPORT_PIECES`] pieces, so one source
/// can give 256 groups. One process for each group, one after another, could then spend the whole
/// [`PROBE_TIMEOUT`] on the start of the processes alone, which takes about 100 ms on Windows. So
/// at most [`SLICE_READ_WORKERS`] runs work at the same time. Each run reads the same bytes as
/// before, and the answers still join in the order of the groups. After a failure or a cancel, no
/// new run starts, and the first failure in the order of the groups is the answer.
fn probe_audio_gaps_in_slices(
    ffprobe_path: &Path,
    media_path: &Path,
    read: &AudioGapRead<'_>,
    flv: &crate::ffmpeg::export::flv_input::FlvInput,
    work_directory: &Path,
    cancel: &AtomicBool,
) -> Result<AudioFrames, ProbeError> {
    let parse_error = |message: &'static str| ProbeError::Parse {
        source: invalid_frames(message),
        stderr: Vec::new(),
    };
    let head = flv.head_path(work_directory);
    let head = head.to_string_lossy();
    if head.contains('|') {
        return Err(parse_error(
            "the path of the head holds the concat separator",
        ));
    }
    let microsecond = Rational::new(1, 1_000_000).expect("1/1000000 is a valid Rational");
    // The interval and the input of each group, in the order of the groups.
    let runs = slice_groups(read.ranges, &flv.segment_offsets)
        .into_iter()
        .map(|(end, offset)| {
            let end = end
                .add(microsecond)
                .and_then(|end| format_seconds(end, 6))
                .ok_or_else(|| parse_error("a range cannot be written in microseconds"))?;
            Ok((format!("%{end}"), flv.url(&head, offset, media_path)))
        })
        .collect::<Result<Vec<(String, String)>, ProbeError>>()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let stream = read.stream_index.to_string();
    let read_one = |(interval, input): &(String, String)| -> Result<Vec<u8>, ProbeError> {
        let arguments = audio_gap_arguments(&stream, interval, OsStr::new(input));
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProbeError::TimedOut {
                timeout: PROBE_TIMEOUT,
                stderr: Vec::new(),
            });
        }
        let run = run_probe_process(
            ffprobe_path,
            &arguments,
            remaining,
            PROBE_POLL_INTERVAL,
            Some(cancel),
        )
        .map_err(|source| ProbeError::Spawn { source })?;
        finish_probe_run_with(run, remaining, |bytes| Ok(bytes.to_vec()))
    };
    let answers = run_in_order(&runs, SLICE_READ_WORKERS, cancel, read_one);
    // A Stop wins over every other answer: with runs at the same time, an earlier run can fail
    // in the same poll in which a later one sees the flag, and a failure of the read is not fatal
    // to its caller, a Stop is.
    if cancel.load(Ordering::SeqCst) {
        return Err(ProbeError::Canceled);
    }
    let csv = join_slice_answers(answers)?;
    parse_audio_frames_csv(&csv, read.sample_rate, read.min_gap).map_err(|source| {
        ProbeError::Parse {
            source,
            stderr: Vec::new(),
        }
    })
}

/// The most runs of [`probe_audio_gaps_in_slices`] that work at the same time.
///
/// Each run reads the audio of one short slice, so its time is mostly the start of the process.
/// With 256 groups, eight runs at a time need about 32 rounds, which is a few seconds even where a
/// start takes 300 ms, far inside [`PROBE_TIMEOUT`]. The count is chosen for the start of the
/// processes, not for the reads: on a network share, eight reads at a time can each be slower,
/// but they read the same bytes within the same deadline.
const SLICE_READ_WORKERS: usize = 8;

/// Join the answers of the runs of [`probe_audio_gaps_in_slices`] in the order of the groups, each
/// answer on lines of its own.
///
/// A run that never started stopped for a failure of another run or for a cancel. The first
/// failure in the order of the groups wins over it, so a run skipped before a failure does not
/// hide that failure. Skipped runs with no failure mean a cancel.
fn join_slice_answers(
    answers: Vec<Option<Result<Vec<u8>, ProbeError>>>,
) -> Result<Vec<u8>, ProbeError> {
    let mut csv = Vec::new();
    let mut skipped = false;
    for answer in answers {
        match answer {
            Some(Ok(answer)) => {
                csv.extend_from_slice(&answer);
                if !csv.ends_with(b"\n") {
                    csv.push(b'\n');
                }
            }
            Some(Err(error)) => return Err(error),
            None => skipped = true,
        }
    }
    if skipped {
        return Err(ProbeError::Canceled);
    }
    Ok(csv)
}

/// Sets its flag when the thread that holds it unwinds, so a run that panics stops the others as
/// a failure does.
struct FailOnPanic<'a>(&'a AtomicBool);

impl Drop for FailOnPanic<'_> {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.store(true, Ordering::SeqCst);
        }
    }
}

/// Run `run` on each of `jobs` with at most `workers` runs at the same time, and return the answers
/// in the order of `jobs`.
///
/// After an `Err`, a panic of a run or a set `cancel`, no new run starts, and each job that did not
/// start answers `None`. A run that works already ends as `run` decides: a probe run reads
/// `cancel` too. A panic of a run reaches the caller when every worker has stopped.
fn run_in_order<J: Sync, T: Send, E: Send>(
    jobs: &[J],
    workers: usize,
    cancel: &AtomicBool,
    run: impl Fn(&J) -> Result<T, E> + Sync,
) -> Vec<Option<Result<T, E>>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let answers: Vec<std::sync::Mutex<Option<Result<T, E>>>> =
        jobs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    thread::scope(|scope| {
        for _ in 0..workers.clamp(1, jobs.len().max(1)) {
            scope.spawn(|| {
                let _guard = FailOnPanic(&failed);
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(job) = jobs.get(index) else {
                        break;
                    };
                    if failed.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    let answer = run(job);
                    if answer.is_err() {
                        failed.store(true, Ordering::SeqCst);
                    }
                    *answers[index]
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(answer);
                }
            });
        }
    });
    answers
        .into_iter()
        .map(|answer| {
            answer
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
        .collect()
}

/// One audio frame that [`probe_slice_start`] decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedAudioFrame {
    /// The presentation time in seconds, or `None` when the frame has none.
    pub pts: Option<Rational>,
    pub nb_samples: u32,
    pub channels: Option<u32>,
}

/// The frames that [`probe_slice_start`] decoded from the start of an input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceStart {
    /// The width and the height of the first frame of the video stream, or `None` when the read
    /// decoded none.
    pub picture: Option<(u32, u32)>,
    /// The frames of the audio stream, in order.
    pub audio: Vec<DecodedAudioFrame>,
    /// True when the decoder reported no error. A frame decoded with the decoder configuration of
    /// another part of the file makes the decoder report errors.
    pub clean: bool,
}

/// Run the resolved ffprobe executable to decode the first `packets` packets of `input` within
/// `timeout`, and stop it when `cancel` is set. The answer holds the first frame of the stream
/// `video_stream` and the frames of the stream `audio_stream`. With an audio stream the count is
/// of the packets of all streams. Without one, the run reads the video stream alone, so an error
/// of the audio decoder does not count.
///
/// The export checks each FLV slice with it before it uses the slices (ADR 046): a slice that
/// starts after a change of the decoder configuration that no read has seen decodes with the
/// configuration of the head. `input` is the input as FFmpeg reads it, such as a `concat:`
/// input. One run reads both streams, so a check costs one process for each slice.
pub fn probe_slice_start(
    ffprobe_path: &Path,
    input: &OsStr,
    video_stream: u32,
    audio_stream: Option<u32>,
    packets: u32,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<SliceStart, ProbeError> {
    let interval = format!("%+#{packets}");
    let video = video_stream.to_string();
    let mut arguments = vec![OsStr::new("-v"), OsStr::new("error")];
    if audio_stream.is_none() {
        arguments.extend([OsStr::new("-select_streams"), OsStr::new(&video)]);
    }
    arguments.extend([
        OsStr::new("-show_entries"),
        OsStr::new("frame=media_type,stream_index,pts_time,nb_samples,channels,width,height"),
        OsStr::new("-read_intervals"),
        OsStr::new(&interval),
        OsStr::new("-of"),
        OsStr::new("csv=p=0"),
        OsStr::new("-i"),
        input,
    ]);
    let run = run_probe_process(
        ffprobe_path,
        &arguments,
        timeout,
        PROBE_POLL_INTERVAL,
        Some(cancel),
    )
    .map_err(|source| ProbeError::Spawn { source })?;
    let clean = run.stderr.iter().all(u8::is_ascii_whitespace);
    finish_probe_run_with(run, timeout, |csv| {
        parse_slice_start(csv, video_stream, audio_stream, clean)
    })
}

/// Read the answer of [`probe_slice_start`]. FFprobe writes the fields of a frame in its own
/// order: the media type, the stream, the time, and then the width and the height of a video
/// frame, or the samples and the channels of an audio frame.
fn parse_slice_start(
    csv: &[u8],
    video_stream: u32,
    audio_stream: Option<u32>,
    clean: bool,
) -> Result<SliceStart, ProbeParseError> {
    let text = std::str::from_utf8(csv).map_err(|_| invalid_frames("the answer is not UTF-8"))?;
    let mut picture = None;
    let mut audio = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let fields: Vec<&str> = line.split(',').map(str::trim).collect();
        let field = |index: usize| fields.get(index).copied().unwrap_or("");
        let Ok(stream) = field(1).parse::<u32>() else {
            return Err(invalid_frames("a frame has no stream index"));
        };
        match field(0) {
            "video" if stream == video_stream && picture.is_none() => {
                match (field(3).parse::<u32>(), field(4).parse::<u32>()) {
                    (Ok(width), Ok(height)) => picture = Some((width, height)),
                    _ => return Err(invalid_frames("a frame has no picture size")),
                }
            }
            "audio" if Some(stream) == audio_stream => {
                let pts = match field(2) {
                    "N/A" => None,
                    text => Some(
                        Rational::from_decimal_str(text)
                            .ok_or_else(|| invalid_frames("a pts_time is not a decimal"))?,
                    ),
                };
                let nb_samples = field(3)
                    .parse::<u32>()
                    .map_err(|_| invalid_frames("an nb_samples is not a count"))?;
                audio.push(DecodedAudioFrame {
                    pts,
                    nb_samples,
                    channels: field(4).parse::<u32>().ok(),
                });
            }
            _ => {}
        }
    }
    Ok(SliceStart {
        picture,
        audio,
        clean,
    })
}

/// The groups of `ranges` that overlap or touch, in order of time, each as its end and the
/// smallest offset of its ranges: the slice that holds all of them.
fn slice_groups(ranges: &[(Rational, Rational)], offsets: &[u64]) -> Vec<(Rational, u64)> {
    let mut sorted: Vec<(Rational, Rational, u64)> = ranges
        .iter()
        .zip(offsets)
        .map(|(&(start, end), &offset)| (start, end, offset))
        .collect();
    sorted.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut groups: Vec<(Rational, Rational, u64)> = Vec::with_capacity(sorted.len());
    for (start, end, offset) in sorted {
        match groups.last_mut() {
            Some(last) if start <= last.1 => {
                last.1 = last.1.max(end);
                last.2 = last.2.min(offset);
            }
            _ => groups.push((start, end, offset)),
        }
    }
    groups
        .into_iter()
        .map(|(_, end, offset)| (end, offset))
        .collect()
}

/// Spell `ranges` for `-read_intervals`, or `None` when a bound cannot be written in
/// microseconds.
///
/// Ranges that overlap or touch join, and the intervals come in order of time. Each start moves at
/// least 0.5 µs earlier and each end at least 0.5 µs later, so the rounding to microseconds loses
/// no part of a range. ffprobe reads each interval from a seek to its start, which lands at or
/// before the start in the measured containers, and stops at the first packet of the stream at or
/// after its end. So the answer holds every frame of each range, give or take the first frame,
/// which a decoder can drop after a seek, and some frames in front of it.
fn read_intervals_argument(ranges: &[(Rational, Rational)]) -> Option<String> {
    let mut sorted = ranges.to_vec();
    sorted.sort_unstable();
    let mut joined: Vec<(Rational, Rational)> = Vec::with_capacity(sorted.len());
    for (start, end) in sorted {
        match joined.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => joined.push((start, end)),
        }
    }
    let microsecond = Rational::new(1, 1_000_000)?;
    let mut intervals = Vec::with_capacity(joined.len());
    for (start, end) in joined {
        let start = format_seconds(start.sub(microsecond)?, 6)?;
        let end = format_seconds(end.add(microsecond)?, 6)?;
        intervals.push(format!("{start}%{end}"));
    }
    Some(intervals.join(","))
}

/// Read the answer of [`probe_audio_gaps`]: one line for each decoded frame, its `pts_time` and
/// its `nb_samples`, in the order of the reads.
///
/// A frame lasts its samples at `sample_rate`. The length that the container gives the packet is
/// not read, because an MP4 file stores a gap as the length of the packet in front of it. A frame
/// without a timestamp starts where the frame in front of it ends, as FFmpeg times it. A frame in
/// front of the first timestamp of the answer ends where the next frame with a timestamp starts.
/// Frames that overlap, or lie at most `min_gap` apart, join. The gaps are the stretches between
/// the joined frames, and the stretch in front of the first frame, which has no `from`. The fine
/// gaps are the same with frames joined across [`FINE_GAP_MILLISECONDS`] only. The end is the end
/// of the last joined stretch, and the longest frame is the longest that a line gives. An answer
/// without frames has no gap, no end and no longest frame.
///
/// These fail: an answer that reaches the capture limit, which can be cut, an answer that is not
/// UTF-8, a line that is not two fields, optionally followed by empty fields, a timestamp that is
/// neither a decimal nor `N/A`, a sample count that is neither an integer that fits a `u32` nor
/// `N/A`, a `sample_rate` of 0, and a time that a [`Rational`] cannot hold. A frame without a
/// sample count lasts no time.
pub fn parse_audio_frames_csv(
    csv: &[u8],
    sample_rate: u32,
    min_gap: Rational,
) -> Result<AudioFrames, ProbeParseError> {
    if csv.len() >= STDOUT_CAPTURE_LIMIT {
        return Err(invalid_frames("the answer reached the capture limit"));
    }
    if sample_rate == 0 {
        return Err(invalid_frames("the sample rate is 0"));
    }
    let text = std::str::from_utf8(csv).map_err(|_| invalid_frames("the answer is not UTF-8"))?;
    let overflow = || invalid_frames("a time is out of range");
    let zero = Rational::new(0, 1).expect("0/1 always reduces to a valid Rational");
    let mut covered = CoveredStretches::new(min_gap);
    let mut fine = CoveredStretches::new(
        Rational::new(FINE_GAP_MILLISECONDS, 1000)
            .expect("FINE_GAP_MILLISECONDS/1000 always reduces to a valid Rational"),
    );
    let mut add = |start: Rational, end: Rational| {
        covered.add(start, end)?;
        fine.add(start, end)
    };
    let mut longest_frame: Option<Rational> = None;
    // The end of the frame in front, which a frame without a timestamp starts at.
    let mut end_in_front: Option<Rational> = None;
    // The length of the frames without a timestamp in front of the first frame with one.
    let mut unplaced = zero;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut fields = line.split(',').map(str::trim);
        let (Some(time), Some(samples)) = (fields.next(), fields.next()) else {
            return Err(invalid_frames("a line is not two fields"));
        };
        // The side data of a frame, such as the downmix information of AC-3, adds a section that
        // `-show_entries` leaves empty: an empty field behind the two.
        if fields.any(|field| !field.is_empty()) {
            return Err(invalid_frames("a line is not two fields"));
        }
        let start = match time {
            "N/A" => None,
            text => Some(
                Rational::from_decimal_str(text)
                    .ok_or_else(|| invalid_frames("a pts_time is not a decimal"))?,
            ),
        };
        let length = match samples {
            "N/A" => zero,
            text => text
                .parse::<u32>()
                .ok()
                .and_then(|count| Rational::new(i64::from(count), i64::from(sample_rate)))
                .ok_or_else(|| invalid_frames("an nb_samples is not a count"))?,
        };
        longest_frame = Some(longest_frame.map_or(length, |longest| longest.max(length)));
        let start = match (start, end_in_front) {
            (Some(start), _) => {
                if unplaced > zero {
                    add(start.sub(unplaced).ok_or_else(overflow)?, start).ok_or_else(overflow)?;
                    unplaced = zero;
                }
                start
            }
            (None, Some(end)) => end,
            (None, None) => {
                unplaced = unplaced.add(length).ok_or_else(overflow)?;
                continue;
            }
        };
        let end = start.add(length).ok_or_else(overflow)?;
        add(start, end).ok_or_else(overflow)?;
        end_in_front = Some(end);
    }
    let (gaps, end) = covered.gaps_and_end().ok_or_else(overflow)?;
    let (fine_gaps, _) = fine.gaps_and_end().ok_or_else(overflow)?;
    Ok(AudioFrames {
        gaps,
        fine_gaps,
        // Frames without a timestamp and nothing behind them have no place, so no length either.
        longest_frame: end.and(longest_frame),
        end,
    })
}

/// A [`ProbeParseError`] for an answer of [`probe_audio_gaps`] that cannot be read.
fn invalid_frames(detail: &'static str) -> ProbeParseError {
    ProbeParseError::Invalid(ProbeDataError::InvalidFrames { detail })
}

/// The stretches of a timeline that frames cover, joined across gaps of at most `min_gap`.
struct CoveredStretches {
    min_gap: Rational,
    stretches: Vec<(Rational, Rational)>,
}

impl CoveredStretches {
    fn new(min_gap: Rational) -> Self {
        Self {
            min_gap,
            stretches: Vec::new(),
        }
    }

    /// Add the frame from `start` to `end`, or `None` when the time overflows.
    ///
    /// The frames of one read come in order, so most of them join the last stretch here. The
    /// others are joined by [`Self::gaps_and_end`].
    fn add(&mut self, start: Rational, end: Rational) -> Option<()> {
        if let Some(last) = self.stretches.last_mut() {
            if start >= last.0 && start <= last.1.add(self.min_gap)? {
                last.1 = last.1.max(end);
                return Some(());
            }
        }
        self.stretches.push((start, end));
        Some(())
    }

    /// The gaps between the stretches, in order of time, and the end of the last stretch, or
    /// `None` when the time overflows.
    fn gaps_and_end(mut self) -> Option<(Vec<AudioGap>, Option<Rational>)> {
        self.stretches.sort_unstable();
        let mut joined: Vec<(Rational, Rational)> = Vec::with_capacity(self.stretches.len());
        for (start, end) in self.stretches {
            match joined.last_mut() {
                Some(last) if start <= last.1.add(self.min_gap)? => last.1 = last.1.max(end),
                _ => joined.push((start, end)),
            }
        }
        let mut from = None;
        let gaps = joined
            .into_iter()
            .map(|(start, end)| {
                let gap = AudioGap { from, to: start };
                from = Some(end);
                gap
            })
            .collect();
        // `from` now holds the end of the last stretch.
        Some((gaps, from))
    }
}

/// Turn one finished run into a probe or into the failure it reports.
///
/// Separate from [`probe_media_within`] so the four outcomes -- killed at the deadline, a
/// non-zero exit, unparsable output, and a good probe -- are each reachable from a test
/// without a real `ffprobe` and without waiting for a real deadline.
fn finish_probe_run(run: ProbeRun, timeout: Duration) -> Result<MediaProbe, ProbeError> {
    finish_probe_run_with(run, timeout, parse_probe_json)
}

/// [`finish_probe_run`] with the parse of the answer passed in, so the probe of a source and the
/// probe of an export output share one account of the ways a run can fail.
///
/// A canceled run is not parsed, as a run killed at the deadline is not: a killed probe
/// answered nothing.
fn finish_probe_run_with<T>(
    run: ProbeRun,
    timeout: Duration,
    parse: impl FnOnce(&[u8]) -> Result<T, ProbeParseError>,
) -> Result<T, ProbeError> {
    let exit = match run.end {
        ProbeEnd::Exited(exit) => exit,
        ProbeEnd::TimedOut => {
            return Err(ProbeError::TimedOut {
                timeout,
                stderr: run.stderr,
            });
        }
        ProbeEnd::Canceled => return Err(ProbeError::Canceled),
    };
    if !exit.success {
        return Err(ProbeError::ProcessFailed {
            code: exit.code,
            stderr: run.stderr,
        });
    }
    parse(&run.stdout).map_err(|source| ProbeError::Parse {
        source,
        stderr: run.stderr,
    })
}

/// Run `program` with `args`, killing it if it has not finished by `timeout`, and capture
/// both of its output streams.
///
/// This is `capabilities::smoke::run_with_timeout` with a stdout capture added. That runner
/// discards stdout, and a probe's whole answer arrives on stdout, so it cannot be called
/// here as it stands; the drain discipline it documents is reproduced exactly, and its
/// `read_capped` is shared rather than copied. The two runners should become one once that
/// one grows a stdout capture of its own.
///
/// Both pipes are drained on their own threads from the moment the child spawns. That is a
/// correctness requirement, not an optimization: a child that fills either pipe's operating
/// system buffer blocks in its own write and never exits, and an undrained pipe would then
/// produce a false timeout. Killing the child closes both of its ends, so the two joins at
/// the end are bounded on every path: `kill_and_reap` runs on each exit from the polling
/// loop that did not already collect the child's status.
///
/// `cancel`, when the caller passes one, is read at every poll, after the exit status and before
/// the deadline. A set flag ends the child as the deadline does, and the run reports
/// [`ProbeEnd::Canceled`]. A child that exited in the same poll still reports its exit.
fn run_probe_process(
    program: &Path,
    args: &[&OsStr],
    timeout: Duration,
    poll: Duration,
    cancel: Option<&AtomicBool>,
) -> io::Result<ProbeRun> {
    let mut child = command_without_console(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .expect("stdout was requested as piped above");
    let stderr = child
        .stderr
        .take()
        .expect("stderr was requested as piped above");
    let stdout_thread = thread::spawn(move || read_capped(stdout, STDOUT_CAPTURE_LIMIT));
    let stderr_thread = thread::spawn(move || read_capped(stderr, STDERR_CAPTURE_LIMIT));

    // The polling below returns its `Result` rather than using `?` in this function, so that
    // every path -- the error paths included -- still ends the child and joins both drain
    // threads before this function returns. A failed `try_wait` that returned early would
    // leave a live, unreaped `ffprobe` holding both pipes open, and because `read_capped`
    // reads until the pipe closes, the joins below would then wait for that child with no
    // bound at all. On Unix, dropping a `Child` neither kills nor reaps it, so nothing later
    // would end it.
    let polled = (|| -> io::Result<Result<ExitStatus, ProbeEnd>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(Ok(status));
            }
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Ok(Err(ProbeEnd::Canceled));
            }
            if Instant::now() >= deadline {
                return Ok(Err(ProbeEnd::TimedOut));
            }
            thread::sleep(poll);
        }
    })();

    // Only the first arm has a child the polling already reaped. The deadline, the cancel and
    // the failed-`try_wait` arms all leave a process that may still be running, so each one
    // ends it here, before the joins below.
    let end = match polled {
        Ok(Ok(status)) => Ok(ProbeEnd::Exited(ProbeExit {
            code: status.code(),
            success: status.success(),
        })),
        Ok(Err(end)) => kill_and_reap(&mut child).map(|()| end),
        Err(error) => {
            // The polling failure is what this run reports. The kill runs only to bound the
            // joins below, so its own result has nowhere to go.
            let _ = kill_and_reap(&mut child);
            Err(error)
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();

    Ok(ProbeRun {
        end: end?,
        stdout,
        stderr,
    })
}

/// Parse and normalize ffprobe JSON without invoking a process.
pub fn parse_probe_json(json: &[u8]) -> Result<MediaProbe, ProbeParseError> {
    let raw: RawProbe = serde_json::from_slice(json)?;
    normalize(raw).map_err(Into::into)
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Deserialize)]
struct RawStream {
    index: Option<Value>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    bits_per_raw_sample: Option<String>,
    bits_per_sample: Option<Value>,
    width: Option<Value>,
    height: Option<Value>,
    time_base: Option<String>,
    start_pts: Option<Value>,
    duration_ts: Option<Value>,
    duration: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    nb_frames: Option<String>,
    sample_rate: Option<String>,
    channels: Option<Value>,
    channel_layout: Option<String>,
    start_time: Option<String>,
    sample_aspect_ratio: Option<String>,
    /// The side data of the stream. Only the display matrix is read ([`display_rotation`]). A
    /// `Value`, so an entry of a form this code does not know never fails the probe.
    side_data_list: Option<Value>,
    #[serde(default)]
    disposition: RawDisposition,
    #[serde(default)]
    tags: RawStreamTags,
}

#[derive(Default, Deserialize)]
struct RawStreamTags {
    /// The stream length the `matroska` muxer writes, as `HH:MM:SS.nnnnnnnnn`.
    #[serde(rename = "DURATION")]
    duration: Option<String>,
    /// The clockwise rotation that FFmpeg before version 5 reported for an MP4 with a display
    /// matrix, in degrees.
    rotate: Option<String>,
}

#[derive(Default, Deserialize)]
struct RawDisposition {
    #[serde(default)]
    default: i64,
    #[serde(default)]
    attached_pic: i64,
}

#[derive(Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    format_long_name: Option<String>,
    duration: Option<String>,
    start_time: Option<String>,
}

fn normalize(raw: RawProbe) -> Result<MediaProbe, ProbeDataError> {
    let format = raw.format.as_ref();
    let video = preferred_stream(&raw.streams, "video", |stream| {
        stream.disposition.attached_pic == 0
    })
    .ok_or(ProbeDataError::MissingVideo)?;
    let audio = preferred_stream(&raw.streams, "audio", |_| true);

    let format_name = required_text(
        format.and_then(|value| value.format_name.as_deref()),
        "format.format_name",
    )?;
    let video_codec =
        required_text(video.codec_name.as_deref(), "streams.video.codec_name")?.to_owned();
    let width = required_json_integer(video.width.as_ref(), "streams.video.width")?;
    let height = required_json_integer(video.height.as_ref(), "streams.video.height")?;
    if width <= 0 || height <= 0 || width > i128::from(u32::MAX) || height > i128::from(u32::MAX) {
        return Err(ProbeDataError::InvalidDimensions { width, height });
    }

    let stream_index = required_json_integer(video.index.as_ref(), "streams.video.index")?;
    let video_stream_index =
        u32::try_from(stream_index).map_err(|_| ProbeDataError::InvalidInteger {
            field: "streams.video.index",
            value: stream_index.to_string(),
        })?;
    let time_base_text = required_text(video.time_base.as_deref(), "streams.video.time_base")?;
    let video_time_base = Rational::from_ffprobe(time_base_text)
        .filter(|value| value.num() > 0)
        .ok_or_else(|| ProbeDataError::InvalidTimeBase {
            value: time_base_text.to_owned(),
        })?;

    let format_names: Vec<String> = format_name
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    let has_format = |wanted: &str| format_names.iter().any(|name| name == wanted);
    let video_start_pts =
        parse_optional_i64_value(video.start_pts.as_ref(), "streams.video.start_pts")?
            .map(Pts::new);
    let video_start = video_start_pts
        .and_then(|pts| pts_seconds(pts, video_time_base))
        .map(Rational::to_f64)
        .or_else(|| {
            video
                .start_time
                .as_deref()
                .and_then(|text| text.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite())
        });
    let format_start_time =
        parse_format_start_time(format.and_then(|value| value.start_time.as_deref()));
    let approximate_duration_seconds = approximate_duration(
        video.duration.as_deref(),
        format.and_then(|value| value.duration.as_deref()),
        video_start,
        format_start_time.map(Rational::to_f64),
        has_format("matroska") || has_format("flv"),
    );
    let r_frame_rate = optional_positive_rational(video.r_frame_rate.as_deref());
    let mut avg_frame_rate = optional_positive_rational(video.avg_frame_rate.as_deref());
    if has_format("flv") {
        avg_frame_rate = flv_average_rate(avg_frame_rate, r_frame_rate);
    }

    Ok(MediaProbe {
        format_names,
        format_long_name: format.and_then(|value| value.format_long_name.clone()),
        format_start_time,
        video_codec,
        video_profile: video.profile.clone(),
        pixel_format: video.pix_fmt.clone(),
        bit_depth: parse_bit_depth(video)?,
        width: width as u32,
        height: height as u32,
        video_stream_index,
        video_time_base,
        video_start_pts,
        video_duration_ticks: parse_optional_i64_value(
            video.duration_ts.as_ref(),
            "streams.video.duration_ts",
        )?
        .and_then(TickCount::new),
        approximate_duration_seconds,
        avg_frame_rate,
        r_frame_rate,
        reported_frame_count: parse_optional_text_i64(
            video.nb_frames.as_deref(),
            "streams.video.nb_frames",
        )?
        .and_then(FrameCount::new),
        sample_aspect_ratio: parse_sample_aspect_ratio(video.sample_aspect_ratio.as_deref()),
        rotation: display_rotation(video),
        // The first run reads no packet at the end. `probe_media` and the FLV correction set it.
        video_end_pts: None,
        audio: audio.map(normalize_audio).transpose()?,
    })
}

fn preferred_stream<'a, F>(
    streams: &'a [RawStream],
    kind: &str,
    eligible: F,
) -> Option<&'a RawStream>
where
    F: Fn(&RawStream) -> bool,
{
    let candidates = streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some(kind) && eligible(stream));
    candidates
        .clone()
        .find(|stream| stream.disposition.default != 0)
        .or_else(|| candidates.into_iter().next())
}

fn normalize_audio(raw: &RawStream) -> Result<AudioProbe, ProbeDataError> {
    let stream_index = required_json_integer(raw.index.as_ref(), "streams.audio.index")?;
    let index = u32::try_from(stream_index).map_err(|_| ProbeDataError::InvalidInteger {
        field: "streams.audio.index",
        value: stream_index.to_string(),
    })?;
    let start_time = audio_start_time(raw);
    let tagged_end = parse_tag_duration(raw.tags.duration.as_deref());
    Ok(AudioProbe {
        index,
        codec: raw.codec_name.clone(),
        sample_rate: parse_optional_text_i64(
            raw.sample_rate.as_deref(),
            "streams.audio.sample_rate",
        )?
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0),
        channels: raw
            .channels
            .as_ref()
            .map(|value| json_integer(value, "streams.audio.channels"))
            .transpose()?
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0),
        channel_layout: raw
            .channel_layout
            .as_deref()
            .map(str::trim)
            .filter(|layout| !layout.is_empty() && *layout != "unknown")
            .map(str::to_owned),
        // A count that does not parse reads as unknown, as the extent below does: the import needs
        // the video stream only.
        reported_packets: parse_optional_text_i64(
            raw.nb_frames.as_deref(),
            "streams.audio.nb_frames",
        )
        .ok()
        .flatten()
        .and_then(|count| u64::try_from(count).ok()),
        holds_no_packets: false,
        start_time,
        duration: audio_duration(raw, start_time, tagged_end),
        tagged_end,
    })
}

/// The time base of an audio stream, or `None` when it is absent or not positive.
fn audio_time_base(raw: &RawStream) -> Option<Rational> {
    raw.time_base
        .as_deref()
        .and_then(Rational::from_ffprobe)
        .filter(|value| value.num() > 0)
}

/// [`AudioProbe::start_time`]: `start_pts` in the stream's time base, else the decimal
/// `start_time`.
///
/// A value that does not parse reads as unknown and never fails the probe. The import needs the
/// video stream only, and the export reads this only to bound the leading silence, not as an edit
/// point, so a malformed audio field must not refuse a file that imported before.
fn audio_start_time(raw: &RawStream) -> Option<Rational> {
    let exact = parse_optional_i64_value(raw.start_pts.as_ref(), "streams.audio.start_pts")
        .ok()
        .flatten()
        .zip(audio_time_base(raw))
        .and_then(|(pts, time_base)| pts_seconds(Pts::new(pts), time_base));
    exact.or_else(|| parse_decimal_seconds(raw.start_time.as_deref()))
}

/// [`AudioProbe::duration`]: `duration_ts` in the stream's time base, else the decimal
/// `duration`, else `tagged_end`, the parsed `DURATION` tag, less `start`. A negative length reads
/// as unknown. As for [`audio_start_time`], nothing here fails the probe.
///
/// The tag is not a length. The `matroska` muxer of ffmpeg 9.0.2 writes it as the end of the
/// track on the container timeline: an audio track muxed to start at 0.3 s with 129.721 s of
/// audio carries `00:02:10.021000000`. Its length is therefore the tag less the start of the
/// stream, and a tag with no known start gives no length.
fn audio_duration(
    raw: &RawStream,
    start: Option<Rational>,
    tagged_end: Option<Rational>,
) -> Option<Rational> {
    let exact = parse_optional_i64_value(raw.duration_ts.as_ref(), "streams.audio.duration_ts")
        .ok()
        .flatten()
        .zip(audio_time_base(raw))
        .and_then(|(ticks, time_base)| pts_seconds(Pts::new(ticks), time_base));
    let tagged = || {
        tagged_end
            .zip(start)
            .and_then(|(end, start)| end.sub(start))
    };
    exact
        .or_else(|| parse_decimal_seconds(raw.duration.as_deref()))
        .or_else(tagged)
        .filter(|value| value.num() >= 0)
}

/// Parse a `DURATION` tag of the form `HH:MM:SS.nnnnnnnnn` exactly, or `None` for anything else.
fn parse_tag_duration(value: Option<&str>) -> Option<Rational> {
    let mut parts = value?.trim().split(':');
    let (hours, minutes, seconds) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || hours.is_empty()
        || minutes.is_empty()
        || !hours.bytes().all(|byte| byte.is_ascii_digit())
        || !minutes.bytes().all(|byte| byte.is_ascii_digit())
        || !seconds.starts_with(|first: char| first.is_ascii_digit())
    {
        return None;
    }
    let hours = Rational::new(hours.parse::<i64>().ok()?.checked_mul(3_600)?, 1)?;
    let minutes = Rational::new(minutes.parse::<i64>().ok()?.checked_mul(60)?, 1)?;
    let seconds = Rational::from_decimal_str(seconds)?;
    hours.add(minutes)?.add(seconds)
}

fn parse_bit_depth(video: &RawStream) -> Result<Option<u32>, ProbeDataError> {
    if let Some(value) = parse_optional_text_i64(
        video.bits_per_raw_sample.as_deref(),
        "streams.video.bits_per_raw_sample",
    )? {
        if let Ok(value) = u32::try_from(value) {
            if value > 0 {
                return Ok(Some(value));
            }
        }
    }
    if let Some(value) = video.bits_per_sample.as_ref() {
        let value = json_integer(value, "streams.video.bits_per_sample")?;
        if let Ok(value) = u32::try_from(value) {
            if value > 0 {
                return Ok(Some(value));
            }
        }
    }
    Ok(video.pix_fmt.as_deref().and_then(infer_pixel_bit_depth))
}

fn infer_pixel_bit_depth(pixel_format: &str) -> Option<u32> {
    let name = pixel_format.to_ascii_lowercase();
    if name.starts_with("p010") {
        return Some(10);
    }
    if name.starts_with("p012") {
        return Some(12);
    }
    if name.starts_with("p016") {
        return Some(16);
    }

    let planar_family = name.starts_with("yuv")
        || name.starts_with("yuva")
        || name.starts_with("gbr")
        || name.starts_with("gray");
    if planar_family {
        for (marker, depth) in [("p10", 10), ("p12", 12), ("p16", 16)] {
            if name.contains(marker) {
                return Some(depth);
            }
        }
        for (marker, depth) in [("gray10", 10), ("gray12", 12), ("gray16", 16)] {
            if name.starts_with(marker) {
                return Some(depth);
            }
        }
    }

    match name.as_str() {
        "rgb48le" | "rgb48be" | "bgr48le" | "bgr48be" | "rgba64le" | "rgba64be" | "bgra64le"
        | "bgra64be" => Some(16),
        "yuv420p" | "yuv422p" | "yuv444p" | "yuv410p" | "yuv411p" | "yuv440p" | "yuvj420p"
        | "yuvj422p" | "yuvj444p" | "gbrp" | "gray" | "gray8" | "nv12" | "nv21" | "yuyv422"
        | "uyvy422" | "rgb24" | "bgr24" | "rgba" | "bgra" | "argb" | "abgr" | "pal8" => Some(8),
        _ => None,
    }
}

fn required_text<'a>(
    value: Option<&'a str>,
    field: &'static str,
) -> Result<&'a str, ProbeDataError> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty() && *text != "N/A")
        .ok_or(ProbeDataError::MissingField { field })
}

fn required_json_integer(
    value: Option<&Value>,
    field: &'static str,
) -> Result<i128, ProbeDataError> {
    value
        .ok_or(ProbeDataError::MissingField { field })
        .and_then(|value| json_integer(value, field))
}

fn json_integer(value: &Value, field: &'static str) -> Result<i128, ProbeDataError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(i128::from)
            .or_else(|| number.as_u64().map(i128::from)),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
    .ok_or_else(|| ProbeDataError::InvalidInteger {
        field,
        value: value.to_string(),
    })
}

fn parse_optional_i64_value(
    value: Option<&Value>,
    field: &'static str,
) -> Result<Option<i64>, ProbeDataError> {
    let Some(value) = value else { return Ok(None) };
    if matches!(value, Value::String(text) if text.trim().is_empty() || text == "N/A") {
        return Ok(None);
    }
    let integer = json_integer(value, field)?;
    i64::try_from(integer)
        .map(Some)
        .map_err(|_| ProbeDataError::InvalidInteger {
            field,
            value: value.to_string(),
        })
}

fn parse_optional_text_i64(
    value: Option<&str>,
    field: &'static str,
) -> Result<Option<i64>, ProbeDataError> {
    let Some(text) = value
        .map(str::trim)
        .filter(|text| !text.is_empty() && *text != "N/A")
    else {
        return Ok(None);
    };
    text.parse()
        .map(Some)
        .map_err(|_| ProbeDataError::InvalidInteger {
            field,
            value: text.to_owned(),
        })
}

fn optional_positive_rational(value: Option<&str>) -> Option<Rational> {
    value
        .and_then(Rational::from_ffprobe)
        .filter(|value| value.num() > 0)
}

/// Parse a `sample_aspect_ratio` as ffprobe writes it, `64:45`. ffprobe writes `0:1` and `N/A`
/// for a stream that does not say, and both read as `None`, as any part that is not a positive
/// integer does.
fn parse_sample_aspect_ratio(value: Option<&str>) -> Option<Rational> {
    let (numerator, denominator) = value?.trim().split_once(':')?;
    let numerator: i64 = numerator.trim().parse().ok()?;
    let denominator: i64 = denominator.trim().parse().ok()?;
    if numerator <= 0 || denominator <= 0 {
        return None;
    }
    Rational::new(numerator, denominator)
}

/// The clockwise turn that shows the picture of `video` upright: 0, 90, 180 or 270.
///
/// The display matrix comes first. ffprobe prints its `rotation` as the counter-clockwise angle
/// of `av_display_rotation_get`, so the clockwise turn is its negative: ffprobe 9 prints `-90`
/// for the matrix of a phone that recorded upright, a picture that turns 90 degrees clockwise,
/// and `90` for a file remuxed with `-display_rotation 90`. The legacy `rotate` tag is already
/// clockwise. An FFmpeg before version 5 printed it beside the matrix; FFmpeg 9 writes neither
/// for `-metadata:s:v rotate=90`, so only an ffprobe of another build is expected to report the
/// tag alone. An angle within 1 degree of a quarter turn takes that turn, any other angle reads
/// as 0 ([`quarter_turn`]), and a stream without either reads as 0.
fn display_rotation(video: &RawStream) -> u16 {
    let matrix = video
        .side_data_list
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries.iter().find_map(|entry| {
                if entry.get("side_data_type").and_then(Value::as_str) != Some("Display Matrix") {
                    return None;
                }
                json_degrees(entry.get("rotation")?).map(|counter_clockwise| -counter_clockwise)
            })
        });
    let legacy = video
        .tags
        .rotate
        .as_deref()
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|degrees| degrees.is_finite());
    matrix.or(legacy).map(quarter_turn).unwrap_or(0)
}

/// An angle in degrees as a JSON number or numeric text, when it is finite.
fn json_degrees(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|degrees: &f64| degrees.is_finite())
}

/// The quarter turn in [0, 360) that a clockwise angle in degrees is exactly, or 0 when it is no
/// quarter turn.
///
/// ffprobe prints the rotation of a display matrix as a whole number, and FFmpeg's autorotation
/// transposes the picture only for an angle that is a quarter turn. Measured with ffmpeg 9.0.2 and
/// `-display_rotation`: 90 turns a 320x240 frame to 240x320, while 89.4, 90.6 and 91 keep 320x240
/// and rotate inside the frame. So any other angle reads as 0 here, and the canvas keeps its width
/// and height as the exported picture does. An angle between 90.5 and 91 still prints as 90; only
/// the raw matrix tells it apart, and the files of real cameras and phones use exact angles.
fn quarter_turn(clockwise: f64) -> u16 {
    if clockwise % 90.0 != 0.0 {
        return 0;
    }
    // A finite f64 divided by 90 and rounded fits an i64 after the remainder, which `as`
    // saturates in any case; `rem_euclid` brings a negative turn into 0..4.
    let quarters = ((clockwise / 90.0).round() % 4.0) as i64;
    (quarters.rem_euclid(4) * 90) as u16
}

/// Parse `format.start_time` exactly, treating anything but a fixed-point decimal as unknown.
///
/// ADR 014 measurement 8 needs this value for an exact seek computation, so it goes through
/// `Rational::from_decimal_str` rather than `f64` (ADR 002). An absent field, the literal
/// `"N/A"`, and any text that is not a base-10 integer or fixed-point decimal all become
/// `None` instead of failing the whole probe, because a missing video stream is the only
/// failure that should block importing the source. `None` is still not a safe value to see
/// here: the renderer falls back to treating the container as if it started at zero, and an
/// export can silently drop frames from the start of a segment when the real start time was
/// not zero.
///
/// `ffprobe -of json` formats this field with `%f`, so it is always fixed point today and
/// this parse never fails on real output. If the probe invocation ever adds `-unit` or
/// `-prefix`, ffprobe can switch to scientific notation, which is not fixed point; this
/// function would then return `None` for a real value, silently, and every seek that depends
/// on it would lose its container offset.
fn parse_format_start_time(value: Option<&str>) -> Option<Rational> {
    let text = value
        .map(str::trim)
        .filter(|text| !text.is_empty() && *text != "N/A")?;
    Rational::from_decimal_str(text)
}

/// The approximate length of the video, counted from its first frame (ADR 046).
///
/// The stream duration already counts from the first frame of the stream. `format.duration`
/// counts from the container start, so the lead of the video start over the container start
/// comes off it. FFmpeg's matroska and flv muxers write the end timestamp as the duration of a
/// file that starts away from 0 (ADR 046 measurements 5 and 16), so for these containers the
/// video start comes off whole. When that gives less than 0, the duration was a length after all,
/// as an MKV from another muxer or the `onMetaData` duration of an FLV gives it, and the lead
/// comes off instead. A length with a small start offset still reads short by that start, which
/// ADR 046 accepts.
fn approximate_duration(
    stream: Option<&str>,
    format: Option<&str>,
    video_start: Option<f64>,
    format_start: Option<f64>,
    end_timestamp: bool,
) -> Option<f64> {
    let parse = |text: &str| {
        text.trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
    };
    if let Some(duration) = stream.and_then(parse) {
        return Some(duration);
    }
    let duration = format.and_then(parse)?;
    let valid = |value: f64| value.is_finite() && value >= 0.0;
    if end_timestamp {
        if let Some(length) = video_start
            .or(format_start)
            .map(|start| duration - start)
            .filter(|length| valid(*length))
        {
            return Some(length);
        }
    }
    let lead = video_start
        .zip(format_start)
        .map(|(video, format)| (video - format).max(0.0))
        .unwrap_or(0.0);
    Some(
        Some(duration - lead)
            .filter(|length| valid(*length))
            .unwrap_or(duration),
    )
}

/// The average rate of an FLV: `r_frame_rate` when the two rates lie within
/// [`FLV_RATE_TOLERANCE`] of each other (ADR 046). It needs only what ffprobe reports, so the probe
/// of the import and the probe of an export always agree.
fn flv_average_rate(average: Option<Rational>, real: Option<Rational>) -> Option<Rational> {
    match (average, real) {
        (Some(average), Some(real))
            if real.to_f64() > 0.0
                && ((average.to_f64() - real.to_f64()) / real.to_f64()).abs()
                    <= FLV_RATE_TOLERANCE =>
        {
            Some(real)
        }
        _ => average,
    }
}

/// The largest relative difference between `avg_frame_rate` and `r_frame_rate` that an FLV
/// treats as one constant rate. The millisecond timestamps of FLV make ffprobe report averages
/// such as 989/33 and 1000/33 for 30 fps, 0.1 % and 1.01 % away (ADR 046 measurement 5).
const FLV_RATE_TOLERANCE: f64 = 0.02;

/// Correct the length of an FLV with what the tags of the file show (ADR 046).
///
/// The length counts from the first video frame to the end of the last one: the latest video
/// presentation time, plus one frame interval, less the video start. ffprobe's `format.duration`
/// is the end timestamp of an FLV without `onMetaData` and the length that the metadata gives
/// otherwise, so it serves neither case exactly. A length below 0, as timestamps that restart
/// give, keeps the probe as it is.
pub fn correct_flv_probe(probe: &mut MediaProbe, extent: Option<crate::flv::locate::Extent>) {
    let Some(extent) = extent else {
        return;
    };
    let Some(last_ms) = extent.last_video_pts else {
        return;
    };
    let start_ms = probe
        .video_start_pts
        .and_then(|pts| pts_seconds(pts, probe.video_time_base))
        .map(|seconds| seconds.to_f64() * 1000.0)
        .or(extent.first_video_pts.map(|pts| pts as f64));
    let Some(start_ms) = start_ms else {
        return;
    };
    // The average rate first: after `flv_average_rate` it is the real rate of a constant-rate
    // file, and on a variable-rate file `r_frame_rate` can be a much higher guess.
    let interval_ms = probe
        .avg_frame_rate
        .or(probe.r_frame_rate)
        .map(|rate| 1000.0 / rate.to_f64())
        .filter(|interval| interval.is_finite() && *interval > 0.0)
        .unwrap_or(0.0);
    let length = (last_ms as f64 + interval_ms - start_ms) / 1000.0;
    if length.is_finite() && length >= 0.0 {
        probe.approximate_duration_seconds = Some(length);
    }
}

/// The exclusive end of the video of an FLV whose latest video frame shows at `last_ms`
/// milliseconds (ADR 052): that time plus the nominal frame interval, in ticks of the video time
/// base and rounded up to a whole tick.
///
/// The tags of an FLV carry no duration of a frame, so the nominal interval stands in for the
/// duration of the last frame, as it does for a packet without one in [`video_end_from_packets`].
/// ffprobe gives an FLV the time base 1/1000, so the time of the tag is already a whole number of
/// ticks; the exact arithmetic serves any other time base as well. `None` without a rate, and when
/// the end is not after the video start.
fn flv_video_end(probe: &MediaProbe, last_ms: i64) -> Option<Pts> {
    let interval = nominal_interval_ticks(
        probe.avg_frame_rate.or(probe.r_frame_rate),
        probe.video_time_base,
    )?;
    let last = Rational::new(last_ms, 1000)?.div(probe.video_time_base)?;
    let end = ceil_to_ticks(last.add(interval)?);
    match probe.video_start_pts {
        Some(start) if end <= start.value() => None,
        _ => Some(Pts::new(end)),
    }
}

/// Correct the probe of the FLV at `path` with its tags, when it is an FLV that the reader can
/// read, and return the extent that the tags gave. Any other file keeps the probe as ffprobe gave
/// it and gives no extent.
fn correct_flv_file(probe: &mut MediaProbe, path: &Path) -> Option<crate::flv::locate::Extent> {
    if !probe.format_names.iter().any(|name| name == "flv")
        || !crate::flv::has_signature(path).unwrap_or(false)
    {
        return None;
    }
    let extent = crate::flv::FlvSource::open(path, None)
        .and_then(|source| source.extent())
        .ok();
    correct_flv_probe(probe, extent);
    extent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_source_pts_metadata_without_synthesizing_frames() {
        let probe = parse_value(base_probe()).unwrap();
        assert_eq!(probe.video_stream_index, 2);
        assert_eq!(probe.video_time_base, Rational::new(1, 90_000).unwrap());
        assert_eq!(probe.video_start_pts, Some(Pts::new(-1800)));
        assert_eq!(
            probe.video_duration_ticks,
            Some(TickCount::new(900_000).unwrap())
        );
        assert_eq!(probe.reported_frame_count, None);
        assert_eq!(
            probe.avg_frame_rate,
            Some(Rational::new(30_000, 1001).unwrap())
        );
        assert_eq!(probe.approximate_duration_seconds, Some(10.01));
    }

    #[test]
    fn missing_start_pts_duration_ticks_and_frame_metadata_remain_playable() {
        let mut value = base_probe();
        for field in [
            "start_pts",
            "duration_ts",
            "duration",
            "nb_frames",
            "avg_frame_rate",
            "r_frame_rate",
        ] {
            value["streams"][0].as_object_mut().unwrap().remove(field);
        }
        value["format"].as_object_mut().unwrap().remove("duration");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.video_start_pts, None);
        assert_eq!(probe.video_duration_ticks, None);
        assert_eq!(probe.approximate_duration_seconds, None);
        assert_eq!(probe.avg_frame_rate, None);
        assert_eq!(probe.r_frame_rate, None);
        assert_eq!(probe.reported_frame_count, None);
    }

    #[test]
    fn invalid_optional_rates_and_durations_become_unavailable() {
        let mut value = base_probe();
        value["streams"][0]["avg_frame_rate"] = serde_json::json!("0/0");
        value["streams"][0]["r_frame_rate"] = serde_json::json!("broken");
        value["streams"][0]["duration"] = serde_json::json!("NaN");
        value["format"]["duration"] = serde_json::json!("-1");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.avg_frame_rate, None);
        assert_eq!(probe.r_frame_rate, None);
        assert_eq!(probe.approximate_duration_seconds, None);
    }

    #[test]
    fn invalid_stream_duration_falls_back_to_valid_format_duration() {
        let mut value = base_probe();
        value["streams"][0]["duration"] = serde_json::json!("-1");
        value["format"]["duration"] = serde_json::json!("10.02");
        // The fixture gives no container start, so no lead comes off.
        assert_eq!(
            parse_value(value).unwrap().approximate_duration_seconds,
            Some(10.02)
        );
    }

    #[test]
    fn the_format_duration_fallback_counts_from_the_first_video_frame() {
        // An MP4-shaped probe whose audio starts 23 ms before its video: the fallback is shorter
        // than format.duration by exactly the lead of the video start over the container start.
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]["start_pts"] = serde_json::json!("6030");
        value["format"]["duration"] = serde_json::json!("10.02");
        value["format"]["start_time"] = serde_json::json!("0.044000");
        let probe = parse_value(value).unwrap();
        let expected = 10.02 - (6030.0 / 90_000.0 - 0.044);
        let actual = probe.approximate_duration_seconds.unwrap();
        assert!(
            (actual - expected).abs() < 1e-9,
            "{actual} against {expected}"
        );
    }

    #[test]
    fn a_matroska_duration_is_the_end_timestamp_less_the_video_start() {
        // ADR 046 measurement 16: an MKV that starts at 1234.567 s reports 1354.588.
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]["time_base"] = serde_json::json!("1/1000");
        value["streams"][0]["start_pts"] = serde_json::json!("1234567");
        value["format"]["format_name"] = serde_json::json!("matroska,webm");
        value["format"]["duration"] = serde_json::json!("1354.588000");
        value["format"]["start_time"] = serde_json::json!("1234.567000");
        let actual = parse_value(value)
            .unwrap()
            .approximate_duration_seconds
            .unwrap();
        assert!((actual - 120.021).abs() < 1e-9, "{actual}");
    }

    fn flv_probe() -> MediaProbe {
        let mut value = base_probe();
        value["streams"][0]["time_base"] = serde_json::json!("1/1000");
        value["streams"][0]["start_pts"] = serde_json::json!("1234588");
        value["streams"][0]["avg_frame_rate"] = serde_json::json!("1000/33");
        value["streams"][0]["r_frame_rate"] = serde_json::json!("30/1");
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration_ts");
        value["format"]["format_name"] = serde_json::json!("flv");
        value["format"]["duration"] = serde_json::json!("1354.488000");
        value["format"]["start_time"] = serde_json::json!("1234.567000");
        parse_value(value).unwrap()
    }

    #[test]
    fn an_flv_takes_its_length_from_the_tags_and_its_rate_from_r_frame_rate() {
        // live.flv of the test of 2026-10-17: video from 1234.588 s to a last frame at
        // 1354.555 s at 30 fps, and ffprobe's format.duration is the end timestamp.
        let mut probe = flv_probe();
        correct_flv_probe(
            &mut probe,
            Some(crate::flv::locate::Extent {
                first_video_pts: Some(1_234_588),
                last_video_pts: Some(1_354_555),
            }),
        );
        assert_eq!(probe.avg_frame_rate, Some(Rational::new(30, 1).unwrap()));
        let length = probe.approximate_duration_seconds.unwrap();
        assert!((length - (119.967 + 1.0 / 30.0)).abs() < 1e-9, "{length}");
    }

    #[test]
    fn the_flv_rate_rule_needs_only_the_probe_and_keeps_a_rate_more_than_2_percent_away() {
        // 989/33 and 1000/33 are the measured averages of 30 fps files; 2943/100 lies 1.9 % below
        // 30 and 2937/100 lies 2.1 % below it.
        for (average, real, expected) in [
            ("989/33", "30/1", "30/1"),
            ("1000/33", "30/1", "30/1"),
            ("989/33", "30000/1001", "30000/1001"),
            ("2943/100", "30/1", "30/1"),
            ("2937/100", "30/1", "2937/100"),
            ("25/1", "30/1", "25/1"),
        ] {
            let mut value = base_probe();
            value["format"]["format_name"] = serde_json::json!("flv");
            value["streams"][0]["avg_frame_rate"] = serde_json::json!(average);
            value["streams"][0]["r_frame_rate"] = serde_json::json!(real);
            let probe = parse_value(value).unwrap();
            assert_eq!(
                probe.avg_frame_rate,
                Rational::from_ffprobe(expected),
                "average {average} against {real}"
            );
        }
        // Another container keeps both rates as ffprobe gives them.
        let mut value = base_probe();
        value["streams"][0]["avg_frame_rate"] = serde_json::json!("989/33");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.avg_frame_rate, Rational::from_ffprobe("989/33"));
    }

    #[test]
    fn an_flv_without_metadata_reads_its_end_timestamp_as_a_length_from_the_video_start() {
        // When the reader cannot read the file, the probe still takes the video start off the
        // end timestamp that ffprobe reports.
        let mut probe = flv_probe();
        let length = probe.approximate_duration_seconds.unwrap();
        assert!((length - (1354.488 - 1234.588)).abs() < 1e-9, "{length}");
        correct_flv_probe(&mut probe, None);
        assert_eq!(probe.approximate_duration_seconds, Some(length));
    }

    #[test]
    fn a_length_that_the_tags_put_below_zero_keeps_the_probe() {
        let mut probe = flv_probe();
        let before = probe.approximate_duration_seconds;
        correct_flv_probe(
            &mut probe,
            Some(crate::flv::locate::Extent {
                first_video_pts: Some(1_234_588),
                last_video_pts: Some(1_000),
            }),
        );
        assert_eq!(probe.approximate_duration_seconds, before);
    }

    #[test]
    fn the_tag_length_converts_a_start_in_another_time_base() {
        let mut probe = flv_probe();
        probe.video_time_base = Rational::new(1, 90_000).unwrap();
        probe.video_start_pts = Some(Pts::new(90_000));
        correct_flv_probe(
            &mut probe,
            Some(crate::flv::locate::Extent {
                first_video_pts: None,
                last_video_pts: Some(11_000),
            }),
        );
        let length = probe.approximate_duration_seconds.unwrap();
        assert!((length - (10.0 + 1.0 / 30.0)).abs() < 1e-9, "{length}");
    }

    #[test]
    fn the_flv_correction_reads_the_tags_of_a_real_file() {
        let recording =
            crate::flv::test_support::recording(&crate::flv::test_support::RecordingOptions {
                seconds: 20,
                ..Default::default()
            });
        let dir = crate::flv::test_support::TestDirectory::new();
        let path = dir.path.join("source.flv");
        std::fs::write(&path, &recording.bytes).unwrap();
        let mut probe = flv_probe();
        probe.video_start_pts = Some(Pts::new(67));
        let extent = correct_flv_file(&mut probe, &path);
        let last = recording.frames.iter().map(|f| f.2).max().unwrap();
        let expected = (last as f64 + 1000.0 / 30.0 - 67.0) / 1000.0;
        let length = probe.approximate_duration_seconds.unwrap();
        assert!(
            (length - expected).abs() < 1e-9,
            "{length} against {expected}"
        );
        // 30 fps in the 1/1000 of an FLV is 33.33 ticks, rounded up to 34. The correction gives
        // the extent and reads no end of its own; the import takes it from the extent.
        assert_eq!(probe.video_end_pts, None);
        let extent = extent.unwrap();
        assert_eq!(extent.last_video_pts, Some(last));
        assert_eq!(flv_video_end(&probe, last), Some(Pts::new(last + 34)));
        // A file with another signature keeps the probe.
        let other = dir.path.join("other.flv");
        std::fs::write(&other, b"not an flv").unwrap();
        let mut probe = flv_probe();
        let before = probe.approximate_duration_seconds;
        correct_flv_file(&mut probe, &other);
        assert_eq!(probe.approximate_duration_seconds, before);
    }

    #[test]
    fn the_video_start_comes_from_a_numeric_start_pts_or_from_start_time() {
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]["start_pts"] = serde_json::json!(6030);
        value["format"]["duration"] = serde_json::json!("10.02");
        value["format"]["start_time"] = serde_json::json!("0.044000");
        let numeric = parse_value(value.clone()).unwrap();
        assert_eq!(numeric.video_start_pts, Some(Pts::new(6030)));
        let expected = 10.02 - (6030.0 / 90_000.0 - 0.044);
        assert!((numeric.approximate_duration_seconds.unwrap() - expected).abs() < 1e-9);

        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("start_pts");
        value["streams"][0]["start_time"] = serde_json::json!("0.067000");
        let from_text = parse_value(value).unwrap();
        let expected = 10.02 - (0.067 - 0.044);
        assert!((from_text.approximate_duration_seconds.unwrap() - expected).abs() < 1e-9);
    }

    #[test]
    fn a_video_that_starts_before_the_container_takes_nothing_off() {
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["format"]["duration"] = serde_json::json!("10.02");
        value["format"]["start_time"] = serde_json::json!("0.500000");
        // The fixture video starts at -1800/90000 s, before the container start.
        assert_eq!(
            parse_value(value).unwrap().approximate_duration_seconds,
            Some(10.02)
        );
    }

    #[test]
    fn a_matroska_length_with_a_large_start_falls_back_to_the_lead() {
        // An MKV whose Duration is a length, as another muxer writes it, starting at 1000 s.
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]["time_base"] = serde_json::json!("1/1000");
        value["streams"][0]["start_pts"] = serde_json::json!("1000033");
        value["format"]["format_name"] = serde_json::json!("matroska,webm");
        value["format"]["duration"] = serde_json::json!("120.000000");
        value["format"]["start_time"] = serde_json::json!("1000.000000");
        let length = parse_value(value)
            .unwrap()
            .approximate_duration_seconds
            .unwrap();
        assert!((length - (120.0 - 0.033)).abs() < 1e-9, "{length}");
    }

    #[test]
    fn a_matroska_without_a_video_start_takes_the_container_start_off() {
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("start_pts");
        value["format"]["format_name"] = serde_json::json!("matroska,webm");
        value["format"]["duration"] = serde_json::json!("1354.588000");
        value["format"]["start_time"] = serde_json::json!("1234.567000");
        let length = parse_value(value)
            .unwrap()
            .approximate_duration_seconds
            .unwrap();
        assert!((length - 120.021).abs() < 1e-9, "{length}");
    }

    #[test]
    fn infers_bit_depth_from_pixel_format_when_numeric_depth_is_missing_or_zero() {
        for (numeric_depth, pixel_format, expected) in [
            (None, "yuv420p10le", Some(10)),
            (Some("0"), "p012le", Some(12)),
            (None, "rgb48le", Some(16)),
            (None, "yuv420p", Some(8)),
            (None, "unknown", None),
        ] {
            let mut value = base_probe();
            value["streams"][0]["pix_fmt"] = serde_json::json!(pixel_format);
            match numeric_depth {
                Some(depth) => {
                    value["streams"][0]["bits_per_raw_sample"] = serde_json::json!(depth);
                }
                None => {
                    value["streams"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("bits_per_raw_sample");
                }
            }
            assert_eq!(parse_value(value).unwrap().bit_depth, expected);
        }
    }

    #[test]
    fn explicit_positive_bit_depth_takes_precedence_over_pixel_format() {
        let mut value = base_probe();
        value["streams"][0]["bits_per_raw_sample"] = serde_json::json!("12");
        value["streams"][0]["pix_fmt"] = serde_json::json!("yuv420p10le");
        assert_eq!(parse_value(value).unwrap().bit_depth, Some(12));
    }

    #[test]
    fn accepts_full_i64_pts_range_and_rejects_negative_tick_counts_as_unavailable() {
        let mut value = base_probe();
        value["streams"][0]["start_pts"] = serde_json::json!(i64::MIN.to_string());
        value["streams"][0]["duration_ts"] = serde_json::json!("-1");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.video_start_pts, Some(Pts::new(i64::MIN)));
        assert_eq!(probe.video_duration_ticks, None);
    }

    #[test]
    fn requires_positive_video_time_base_and_stream_index() {
        let mut value = base_probe();
        value["streams"][0]["time_base"] = serde_json::json!("0/0");
        assert!(matches!(
            parse_value(value),
            Err(ProbeParseError::Invalid(
                ProbeDataError::InvalidTimeBase { .. }
            ))
        ));

        let mut value = base_probe();
        value["streams"][0].as_object_mut().unwrap().remove("index");
        assert!(matches!(
            parse_value(value),
            Err(ProbeParseError::Invalid(ProbeDataError::MissingField {
                field: "streams.video.index"
            }))
        ));
    }

    #[test]
    fn selects_default_non_attached_video_and_default_audio() {
        let mut value = base_probe();
        let attached = serde_json::json!({
            "index":0,"codec_type":"video","codec_name":"mjpeg","width":600,"height":600,
            "time_base":"1/25","disposition":{"default":1,"attached_pic":1}
        });
        value["streams"].as_array_mut().unwrap().insert(0, attached);
        value["streams"].as_array_mut().unwrap().push(serde_json::json!({
            "index":3,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2,
            "disposition":{"default":1,"attached_pic":0}
        }));
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.video_stream_index, 2);
        assert_eq!(probe.audio.as_ref().unwrap().sample_rate, Some(48_000));
    }

    #[test]
    fn audio_index_is_the_absolute_stream_index_of_the_selected_default_audio_stream() {
        // Video at 0, a non-default audio at 1, and the default-disposition audio at 2:
        // `preferred_stream` must return the stream at 2, and `AudioProbe.index` must carry
        // that same absolute index so the export filter graph can name it exactly (ADR 014).
        let value = serde_json::json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "time_base": "1/90000",
                    "disposition": {"default": 1, "attached_pic": 0}
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "ac3",
                    "sample_rate": "44100",
                    "channels": 2,
                    "disposition": {"default": 0, "attached_pic": 0}
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 6,
                    "disposition": {"default": 1, "attached_pic": 0}
                }
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"}
        });
        let probe = parse_value(value).unwrap();
        // Assert the whole `AudioProbe`, not just `index`: this proves every field came from
        // stream 2, the default-disposition stream, and none of it leaked from stream 1.
        let audio = probe.audio.unwrap();
        assert_eq!(audio.index, 2);
        assert_eq!(audio.codec, Some("aac".to_owned()));
        assert_eq!(audio.sample_rate, Some(48_000));
        assert_eq!(audio.channels, Some(6));
    }

    #[test]
    fn audio_index_falls_back_to_the_first_audio_stream_when_none_is_marked_default() {
        // No audio stream carries `default`, so `preferred_stream` falls back to the first
        // audio stream in file order, which is stream 1, not stream 0 or 2.
        let value = serde_json::json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "time_base": "1/90000",
                    "disposition": {"default": 1, "attached_pic": 0}
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "ac3",
                    "sample_rate": "44100",
                    "channels": 2,
                    "disposition": {"default": 0, "attached_pic": 0}
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 6,
                    "disposition": {"default": 0, "attached_pic": 0}
                }
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"}
        });
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.audio.unwrap().index, 1);
    }

    #[test]
    fn format_start_time_parses_a_positive_decimal_exactly() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("9.976780");
        let probe = parse_value(value).unwrap();
        // The literal reduced fraction, not the parser checked against itself: 9976780 over
        // 1000000, reduced by 20, is 498839 over 50000.
        assert_eq!(probe.format_start_time, Rational::new(498_839, 50_000));
    }

    #[test]
    fn format_start_time_parses_a_negative_decimal_exactly() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("-0.500000");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.format_start_time, Rational::new(-1, 2));
    }

    #[test]
    fn format_start_time_parses_zero_exactly() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("0.000000");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.format_start_time, Rational::new(0, 1));
    }

    #[test]
    fn format_start_time_is_none_when_the_field_is_absent() {
        let probe = parse_value(base_probe()).unwrap();
        assert_eq!(probe.format_start_time, None);
    }

    #[test]
    fn format_start_time_is_none_for_an_empty_string() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.format_start_time, None);
    }

    #[test]
    fn format_start_time_is_none_for_the_literal_n_a() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("N/A");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.format_start_time, None);
    }

    #[test]
    fn format_start_time_non_numeric_text_becomes_none_without_failing_the_parse() {
        let mut value = base_probe();
        value["format"]["start_time"] = serde_json::json!("not-a-number");
        let probe = parse_value(value).unwrap();
        assert_eq!(probe.format_start_time, None);
    }

    #[test]
    fn serializes_pts_and_tick_metadata_as_decimal_strings() {
        let mut raw = base_probe();
        raw["streams"][0]["nb_frames"] = serde_json::json!("300");
        raw["format"]["start_time"] = serde_json::json!("9.976780");
        raw["streams"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "index": 7,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2,
                "disposition": {"default": 1, "attached_pic": 0}
            }));
        let probe = parse_value(raw).unwrap();
        assert_eq!(
            probe.reported_frame_count,
            Some(FrameCount::new(300).unwrap())
        );
        let value = serde_json::to_value(probe).unwrap();
        assert_eq!(value["videoStartPts"], "-1800");
        assert_eq!(value["videoDurationTicks"], "900000");
        assert_eq!(value["reportedFrameCount"], "300");
        // Pin the cross-IPC wire shape for both new fields: `formatStartTime` crosses as the
        // same `{"n":...,"d":...}` object every other `Rational` field uses, and the audio
        // stream index crosses under the key `index`.
        assert_eq!(
            value["formatStartTime"],
            serde_json::json!({"n": 498_839, "d": 50_000})
        );
        assert_eq!(value["audio"]["index"], 7);
        assert!(value.get("frameCount").is_none());
        assert!(value.get("isVfr").is_none());

        // An absent `format.start_time` serializes as JSON `null`: the field carries no
        // `skip_serializing_if`, so the key is always present on the wire.
        let without_start_time = parse_value(base_probe()).unwrap();
        let value = serde_json::to_value(without_start_time).unwrap();
        assert_eq!(value["formatStartTime"], serde_json::Value::Null);
    }

    // -- the bounded runner -------------------------------------------------------------------

    #[test]
    fn a_run_that_hit_the_deadline_reports_a_timeout_and_keeps_what_was_written() {
        let run = ProbeRun {
            end: ProbeEnd::TimedOut,
            stdout: b"{".to_vec(),
            stderr: b"the share stopped answering".to_vec(),
        };

        let error = finish_probe_run(run, Duration::from_secs(30)).unwrap_err();

        // The truncated stdout is not parsed at all. A killed probe answered nothing, and
        // reporting a parse failure would name the wrong cause.
        match error {
            ProbeError::TimedOut { timeout, stderr } => {
                assert_eq!(timeout, Duration::from_secs(30));
                assert_eq!(stderr, b"the share stopped answering");
            }
            other => panic!("expected a timeout, got {other:?}"),
        }
    }

    #[test]
    fn a_run_that_exited_unsuccessfully_still_reports_the_process_failure() {
        let run = ProbeRun {
            end: ProbeEnd::Exited(ProbeExit {
                code: Some(1),
                success: false,
            }),
            stdout: Vec::new(),
            stderr: b"invalid data".to_vec(),
        };

        let error = finish_probe_run(run, PROBE_TIMEOUT).unwrap_err();

        assert!(matches!(
            error,
            ProbeError::ProcessFailed { code: Some(1), .. }
        ));
    }

    #[test]
    fn a_successful_run_parses_its_captured_stdout() {
        let run = ProbeRun {
            end: ProbeEnd::Exited(ProbeExit {
                code: Some(0),
                success: true,
            }),
            stdout: serde_json::to_vec(&base_probe()).unwrap(),
            stderr: Vec::new(),
        };

        let probe = finish_probe_run(run, PROBE_TIMEOUT).unwrap();

        assert_eq!(probe.video_stream_index, 2);
    }

    #[test]
    fn a_run_that_exits_on_its_own_captures_both_streams() {
        // The test binary itself, run with an argument its harness rejects: a deterministic,
        // immediate, non-zero exit on every platform this crate targets, with no shell and no
        // dependency on ffprobe being installed. `capabilities::smoke` uses the same fixture.
        let program = std::env::current_exe().expect("the test binary has a path");

        let run = run_probe_process(
            &program,
            &[OsStr::new("--this-flag-does-not-exist")],
            Duration::from_secs(5),
            Duration::from_millis(10),
            None,
        )
        .expect("the test binary should spawn and exit quickly");

        let ProbeEnd::Exited(exit) = run.end else {
            panic!("the process exited on its own, got {:?}", run.end);
        };
        assert!(!exit.success);
    }

    #[cfg(unix)]
    #[test]
    fn a_stalled_probe_is_killed_at_the_deadline_instead_of_waited_on() {
        // One process, no shell. A shell that forked would die on `Child::kill` while `sleep`
        // kept the inherited pipe write handles open, and the two drain joins would then block
        // for the full ten seconds -- which the elapsed assertion below catches.
        let started = Instant::now();

        let run = run_probe_process(
            Path::new("/bin/sleep"),
            &[OsStr::new("10")],
            Duration::from_millis(200),
            Duration::from_millis(10),
            None,
        )
        .expect("the process should spawn and then be killed");

        let elapsed = started.elapsed();
        assert!(
            matches!(run.end, ProbeEnd::TimedOut),
            "a killed process reports no exit"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the deadline to fire well before the ten-second sleep, took {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_stalled_probe_is_killed_at_the_deadline_instead_of_waited_on() {
        // `ping -n 20 127.0.0.1` occupies a process for about nineteen seconds and needs no
        // tool outside a default install. It must run as one process, not through `cmd.exe /c`:
        // `cmd.exe` stays alive as the parent of `ping`, so `Child::kill` terminates only
        // `cmd.exe` while `ping` keeps the inherited pipe write handles open, and the drain
        // joins then block for that full runtime.
        let started = Instant::now();

        let run = run_probe_process(
            Path::new("ping.exe"),
            &[OsStr::new("-n"), OsStr::new("20"), OsStr::new("127.0.0.1")],
            Duration::from_millis(200),
            Duration::from_millis(10),
            None,
        )
        .expect("the process should spawn and then be killed");

        let elapsed = started.elapsed();
        assert!(
            matches!(run.end, ProbeEnd::TimedOut),
            "a killed process reports no exit"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the deadline to fire well before ping finishes, took {elapsed:?}"
        );
    }

    /// Run `program` under a 30-second deadline, and set its cancel flag from another thread
    /// after 150 ms. Returns how the run ended and how long it took.
    fn run_and_cancel(program: &Path, args: &[&OsStr]) -> (ProbeEnd, Duration) {
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let run = thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(150));
                cancel.store(true, Ordering::SeqCst);
            });
            run_probe_process(
                program,
                args,
                PROBE_TIMEOUT,
                Duration::from_millis(10),
                Some(&cancel),
            )
            .expect("the process should spawn and then be killed")
        });
        (run.end, started.elapsed())
    }

    #[cfg(unix)]
    #[test]
    fn a_canceled_probe_is_killed_at_once_instead_of_waiting_for_the_deadline() {
        // The probe of an export output runs under the export's cancel flag. A share that stopped
        // answering holds ffprobe for the whole deadline, and an application quit waits only five
        // seconds (ADR 017), so the flag has to end the child, not only the wait for it. One
        // process, no shell, for the reason the deadline test above gives.
        let (end, elapsed) = run_and_cancel(Path::new("/bin/sleep"), &[OsStr::new("10")]);

        assert!(matches!(end, ProbeEnd::Canceled), "{end:?}");
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the cancel to end the ten-second sleep at once, took {elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_canceled_probe_is_killed_at_once_instead_of_waiting_for_the_deadline() {
        // The Windows twin of the test above, with the process of the Windows deadline test.
        let (end, elapsed) = run_and_cancel(
            Path::new("ping.exe"),
            &[OsStr::new("-n"), OsStr::new("20"), OsStr::new("127.0.0.1")],
        );

        assert!(matches!(end, ProbeEnd::Canceled), "{end:?}");
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the cancel to end ping at once, took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_media_probe_stops_on_the_cancel_flag_and_reports_the_cancel() {
        // The re-probe of an export runs under the flag of the run. The program here ignores
        // the arguments of ffprobe and waits, as an ffprobe that a share holds does: `exec`
        // keeps it one process, so the kill reaches it. A Windows twin is not written, because
        // no Windows program that is always present ignores these arguments. The
        // `run_probe_process` twins cover the kill there.
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "quipclip-probe-cancel-{}-{}",
            std::process::id(),
            crate::commands::next_run_id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let program = directory.join("stalled-ffprobe");
        std::fs::write(&program, "#!/bin/sh\nexec /bin/sleep 10\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = AtomicBool::new(false);
        let started = Instant::now();

        let result = thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(150));
                cancel.store(true, Ordering::SeqCst);
            });
            probe_media_until_canceled(&program, Path::new("/media/source.mp4"), &cancel)
        });
        let elapsed = started.elapsed();
        let _ = std::fs::remove_dir_all(&directory);

        assert!(matches!(result, Err(ProbeError::Canceled)), "{result:?}");
        assert!(
            elapsed < Duration::from_secs(2),
            "expected the cancel to end the stalled probe at once, took {elapsed:?}"
        );
    }

    #[test]
    fn a_canceled_run_reports_the_cancel_and_parses_nothing() {
        // What the child wrote before it was killed is not an answer, as for a timeout.
        let run = ProbeRun {
            end: ProbeEnd::Canceled,
            stdout: br#"{"streams":[{"codec_type":"audio"}]}"#.to_vec(),
            stderr: Vec::new(),
        };
        assert!(matches!(
            finish_probe_run_with(run, PROBE_TIMEOUT, parse_output_audio_json),
            Err(ProbeError::Canceled)
        ));
    }

    #[test]
    fn an_unset_cancel_flag_lets_the_probe_run_to_its_own_exit() {
        let program = std::env::current_exe().expect("the test binary has a path");
        let cancel = AtomicBool::new(false);

        let run = run_probe_process(
            &program,
            &[OsStr::new("--this-flag-does-not-exist")],
            Duration::from_secs(5),
            Duration::from_millis(10),
            Some(&cancel),
        )
        .expect("the test binary should spawn and exit quickly");

        assert!(matches!(run.end, ProbeEnd::Exited(_)), "{:?}", run.end);
    }

    // -- the extent of the source audio stream -------------------------------------------------

    /// The base probe with one audio stream whose fields are `audio`, merged over an index and a
    /// codec type.
    fn probe_with_audio_stream(audio: Value) -> MediaProbe {
        let mut value = base_probe();
        let mut stream = serde_json::json!({ "index": 1, "codec_type": "audio" });
        for (key, field) in audio.as_object().unwrap() {
            stream[key] = field.clone();
        }
        value["streams"].as_array_mut().unwrap().push(stream);
        parse_value(value).unwrap()
    }

    #[test]
    fn the_audio_extent_is_exact_from_its_ticks_and_its_time_base() {
        // An audio stream that starts 0.3 s late and runs 129.7 s, at 44100 Hz: the ticks give
        // the exact values, whatever the rounded decimals say.
        let audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/44100",
            "start_pts": 13230,
            "start_time": "0.299999",
            "duration_ts": 5719770,
            "duration": "129.699999"
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, Some(seconds("0.3")));
        assert_eq!(audio.duration, Some(seconds("129.7")));
    }

    #[test]
    fn the_audio_extent_falls_back_to_the_decimals_and_then_to_the_duration_tag() {
        // Without ticks, the decimals.
        let audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_time": "0.300000",
            "duration": "129.000000"
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, Some(seconds("0.3")));
        assert_eq!(audio.duration, Some(seconds("129")));

        // The shape the `matroska` demuxer gives, copied from the measured late-audio source: no
        // stream duration, and a tag that holds the end of the track, 0.3 s + 129.721 s.
        let audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 300,
            "start_time": "0.300000",
            "duration_ts": "N/A",
            "duration": "N/A",
            "tags": { "DURATION": "00:02:10.021000000" }
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, Some(seconds("0.3")));
        assert_eq!(audio.duration, Some(seconds("129.721")));

        // A tag is an end, so with no start it places nothing and gives no length.
        let audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_time": "N/A",
            "tags": { "DURATION": "00:02:10.021000000" }
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, None);
        assert_eq!(audio.duration, None);
    }

    #[test]
    fn a_missing_or_malformed_audio_extent_reads_as_unknown_and_never_fails_the_probe() {
        // The import needs the video stream only. An audio field this probe did not read before
        // must not refuse a file that imported before.
        for audio in [
            serde_json::json!({}),
            serde_json::json!({ "start_pts": "abc", "duration_ts": [1], "time_base": "1/44100" }),
            serde_json::json!({ "start_pts": 0, "time_base": "0/1", "duration_ts": 10 }),
            serde_json::json!({ "start_time": "N/A", "duration": "-1.000000" }),
            serde_json::json!({ "tags": { "DURATION": "2:09" } }),
            serde_json::json!({ "tags": { "DURATION": "00:02:x9.000000000" } }),
        ] {
            let audio = probe_with_audio_stream(audio.clone()).audio.unwrap();
            assert_eq!(audio.start_time, None, "{audio:?}");
            assert_eq!(audio.duration, None, "{audio:?}");
        }
    }

    #[test]
    fn the_duration_tag_parses_hours_minutes_and_exact_seconds() {
        assert_eq!(
            parse_tag_duration(Some("01:02:03.500000000")),
            Some(seconds("3723.5"))
        );
        assert_eq!(parse_tag_duration(Some("00:00:05")), Some(seconds("5")));
        for refused in ["", "5.0", "1:2:3:4", ":00:05.0", "00:-1:05.0", "00:00:.5"] {
            assert_eq!(parse_tag_duration(Some(refused)), None, "{refused:?}");
        }
    }

    #[test]
    fn the_audio_extent_is_not_on_the_import_wire() {
        // Only the export reads it. The interface's validator and types know nothing of it.
        let probe = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/44100",
            "start_pts": 13230,
            "duration_ts": 5719770
        }));
        let value = serde_json::to_value(&probe).unwrap();
        let audio = value["audio"].as_object().unwrap();
        assert!(!audio.contains_key("startTime"));
        assert!(!audio.contains_key("duration"));
        assert!(!audio.contains_key("taggedEnd"));
        assert!(!audio.contains_key("channelLayout"));
        assert!(!audio.contains_key("holdsNoPackets"));
        assert_eq!(value["audio"]["index"], 1);
    }

    #[test]
    fn a_read_without_a_packet_marks_the_stream_only_when_the_container_does_not_record_audio() {
        let audio = |fields: Value| probe_with_audio_stream(fields).audio.unwrap();
        // The Matroska track of ADR 014 measurement 26: no count, and a tag of zero.
        let mut empty = audio(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 120_000,
            "tags": { "DURATION": "00:00:00.000000000" }
        }));
        assert_eq!(empty.reported_packets, None);
        assert!(empty.take_no_packet());
        assert!(empty.holds_no_packets);
        // A track with audio: a positive tag, or a count in the index of an MP4 file.
        for fields in [
            serde_json::json!({ "time_base": "1/1000", "tags": { "DURATION": "00:02:00.021000000" } }),
            serde_json::json!({ "time_base": "1/48000", "nb_frames": "5626" }),
        ] {
            let mut recorded = audio(fields.clone());
            assert!(!recorded.take_no_packet(), "{fields}");
            assert!(!recorded.holds_no_packets, "{fields}");
        }
        // A count of zero, or one that does not parse, records nothing.
        for count in ["0", "N/A", "x"] {
            let mut stream = audio(serde_json::json!({ "nb_frames": count }));
            assert!(stream.take_no_packet(), "{count}");
        }
        assert_eq!(
            audio(serde_json::json!({ "nb_frames": "5626" })).reported_packets,
            Some(5626)
        );
    }

    #[test]
    fn the_channel_layout_is_the_name_ffprobe_gives_and_unknown_reads_as_none() {
        for (reported, expected) in [
            (serde_json::json!("stereo"), Some("stereo")),
            (serde_json::json!("5.1(side)"), Some("5.1(side)")),
            (serde_json::json!("unknown"), None),
            (serde_json::json!(""), None),
            (Value::Null, None),
        ] {
            let audio = probe_with_audio_stream(serde_json::json!({
                "channels": 2,
                "channel_layout": reported
            }))
            .audio
            .unwrap();
            assert_eq!(audio.channel_layout.as_deref(), expected, "{reported:?}");
            assert!(!audio.holds_no_packets);
        }
    }

    // -- the first packet of the source audio stream ------------------------------------------

    fn parse_first_packet(value: Value) -> Option<FirstAudioPacket> {
        parse_first_packet_json(&serde_json::to_vec(&value).unwrap()).unwrap()
    }

    #[test]
    fn the_first_packet_is_its_pts_in_the_time_base_its_position_and_the_id_of_its_stream() {
        // The answers ffprobe 9.0.2 wrote for sources whose audio starts 60 s after the video:
        // Matroska at 1/1000 without stream ids, MPEG-TS at 1/90000 with its program and the PID,
        // MPEG-PS with its stream id, and MP4 at 1/48000.
        let matroska = parse_first_packet(serde_json::json!({
            "packets": [{ "pts": 59979, "pos": "137779244", "side_data_list": [{}] }],
            "programs": [],
            "stream_groups": [],
            "streams": [{ "time_base": "1/1000" }]
        }));
        assert_eq!(
            matroska,
            Some(FirstAudioPacket {
                time: Some(seconds("59.979")),
                position: Some(137_779_244),
                stream_id: None,
            })
        );
        let transport = parse_first_packet(serde_json::json!({
            "packets": [{ "pts": 5524080, "pos": "141608932", "side_data_list": [{}] }],
            "programs": [{ "streams": [{ "id": "0x101", "time_base": "1/90000" }] }],
            "stream_groups": [],
            "streams": [{ "id": "0x101", "time_base": "1/90000" }]
        }));
        assert_eq!(
            transport,
            Some(FirstAudioPacket {
                time: Rational::new(5_524_080, 90_000),
                position: Some(141_608_932),
                stream_id: Some(0x101),
            })
        );
        let program = parse_first_packet(serde_json::json!({
            "packets": [{ "pts": 5447098, "pos": "48171022" }],
            "programs": [],
            "stream_groups": [],
            "streams": [{ "id": "0x1c0", "time_base": "1/90000" }]
        }))
        .unwrap();
        assert_eq!(program.stream_id, Some(0x1c0));
        let mp4 = parse_first_packet(serde_json::json!({
            "packets": [{ "pts": 2878976 }],
            "streams": [{ "time_base": "1/48000" }]
        }))
        .unwrap();
        assert_eq!(mp4.time, Rational::new(2_878_976, 48_000));
        assert_eq!(mp4.position, None);
        // The priming of an encoder puts the first packet before zero.
        let primed = parse_first_packet(serde_json::json!({
            "packets": [{ "pts": -1024 }],
            "streams": [{ "time_base": "1/48000" }]
        }))
        .unwrap();
        assert_eq!(primed.time, Rational::new(-1024, 48_000));
    }

    #[test]
    fn an_answer_without_a_packet_reads_as_none_only_when_it_lists_the_stream() {
        // The answer ffprobe 9.0.2 wrote for a Matroska track that holds no packets.
        for answer in [
            serde_json::json!({
                "packets": [],
                "programs": [],
                "stream_groups": [],
                "streams": [{ "time_base": "1/1000" }]
            }),
            serde_json::json!({ "streams": [{ "id": "0x101", "time_base": "1/1000" }] }),
        ] {
            assert_eq!(parse_first_packet(answer.clone()), None, "{answer}");
        }
        // The answer for an index that names no stream lists none. It says nothing about the
        // packets of the stream the caller means.
        for answer in [
            serde_json::json!({ "packets": [], "programs": [], "stream_groups": [], "streams": [] }),
            serde_json::json!({}),
        ] {
            assert!(
                matches!(
                    parse_first_packet_json(&serde_json::to_vec(&answer).unwrap()),
                    Err(ProbeParseError::Invalid(ProbeDataError::MissingField {
                        field: "streams"
                    }))
                ),
                "{answer}"
            );
        }
        assert!(matches!(
            parse_first_packet_json(b"{"),
            Err(ProbeParseError::Json(_))
        ));
    }

    #[test]
    fn an_answer_without_a_packet_counts_only_when_ffprobe_reported_no_error() {
        let packet = FirstAudioPacket {
            time: Some(seconds("59.979")),
            position: None,
            stream_id: None,
        };
        // A packet is an answer whatever stderr holds.
        assert_eq!(
            first_packet_answer(Some(packet), b"[h264] error\n".to_vec()).unwrap(),
            Some(packet)
        );
        for stderr in [&b""[..], b"\n", b" \r\n\t"] {
            assert_eq!(first_packet_answer(None, stderr.to_vec()).unwrap(), None);
        }
        // What ffprobe 9.0.2 wrote for a Matroska file cut off before its first audio packet.
        let stderr = b"[matroska,webm @ 0x7ac1040000] File ended prematurely\n".to_vec();
        match first_packet_answer(None, stderr.clone()) {
            Err(ProbeError::Parse {
                source: ProbeParseError::Invalid(ProbeDataError::MissingField { field }),
                stderr: reported,
            }) => {
                assert_eq!(field, "packets");
                assert_eq!(reported, stderr);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_packet_field_that_does_not_parse_reads_as_none_and_keeps_the_others() {
        let time_base = |value: Value| serde_json::json!([{ "id": "0x101", "time_base": value }]);
        for (packet, streams) in [
            (serde_json::json!({}), time_base("1/1000".into())),
            (
                serde_json::json!({ "pts": "N/A" }),
                time_base("1/1000".into()),
            ),
            (
                serde_json::json!({ "pts": "x" }),
                time_base("1/1000".into()),
            ),
            (serde_json::json!({ "pts": 12 }), time_base("0/1".into())),
            (
                serde_json::json!({ "pts": 12 }),
                serde_json::json!([{ "id": "0x101" }]),
            ),
        ] {
            let answer = serde_json::json!({ "packets": [packet], "streams": streams });
            let packet = parse_first_packet(answer.clone()).unwrap();
            assert_eq!(packet.time, None, "{answer}");
            assert_eq!(packet.stream_id, Some(0x101), "{answer}");
        }
        for position in [
            serde_json::json!("N/A"),
            serde_json::json!("-1"),
            serde_json::json!("x"),
        ] {
            let packet = parse_first_packet(serde_json::json!({
                "packets": [{ "pts": 12, "pos": position }],
                "streams": [{ "time_base": "1/1000" }]
            }))
            .unwrap();
            assert_eq!(packet.position, None, "{position}");
            assert_eq!(packet.time, Some(seconds("0.012")));
        }
    }

    #[test]
    fn a_stream_id_parses_as_ffprobe_writes_it_and_nothing_else() {
        assert_eq!(parse_stream_id(Some("0x101")), Some(0x101));
        assert_eq!(parse_stream_id(Some("0x1c0")), Some(0x1c0));
        assert_eq!(parse_stream_id(Some("257")), Some(257));
        for refused in ["", "0x", "0xg1", "-1", "1.5", "a:1", "0x100000000"] {
            assert_eq!(parse_stream_id(Some(refused)), None, "{refused:?}");
        }
        assert_eq!(parse_stream_id(None), None);
    }

    #[test]
    fn the_sample_rate_is_read_from_the_stream_with_the_id_and_only_a_positive_rate_counts() {
        // The answer ffprobe 9.0.2 wrote for an MPEG-TS source with AAC 60 s late, read from the
        // position of its first audio packet: the stream appears in its program too.
        let answer = serde_json::json!({
            "programs": [{ "streams": [{ "id": "0x101", "sample_rate": "48000" }] }],
            "stream_groups": [],
            "streams": [{ "id": "0x101", "sample_rate": "48000" }]
        });
        let parse = |value: &Value, id| {
            parse_sample_rate_json(&serde_json::to_vec(value).unwrap(), id).unwrap()
        };
        assert_eq!(parse(&answer, 0x101), Some(48_000));
        // Another stream's rate is not this stream's.
        assert_eq!(parse(&answer, 0x100), None);
        for streams in [
            serde_json::json!([]),
            serde_json::json!([{ "id": "0x101" }]),
            serde_json::json!([{ "id": "0x101", "sample_rate": "0" }]),
            serde_json::json!([{ "id": "0x101", "sample_rate": "-48000" }]),
            serde_json::json!([{ "id": "0x101", "sample_rate": "N/A" }]),
            serde_json::json!([{ "id": "0x101", "sample_rate": "4294967296" }]),
            serde_json::json!([{ "sample_rate": "48000" }]),
        ] {
            assert_eq!(
                parse(&serde_json::json!({ "streams": streams }), 0x101),
                None,
                "{streams}"
            );
        }
        assert!(matches!(
            parse_sample_rate_json(b"{", 0x101),
            Err(ProbeParseError::Json(_))
        ));
    }

    /// The gaps that [`parse_audio_frames_csv`] reads from `csv` at `sample_rate`, with the
    /// minimum gap of the export, 0.1 s.
    fn gaps_of(csv: &str, sample_rate: u32) -> Vec<AudioGap> {
        frames_of(csv, sample_rate).gaps
    }

    /// The whole answer that [`parse_audio_frames_csv`] reads from `csv`, as [`gaps_of`] reads it.
    fn frames_of(csv: &str, sample_rate: u32) -> AudioFrames {
        parse_audio_frames_csv(csv.as_bytes(), sample_rate, seconds("0.1")).unwrap()
    }

    #[test]
    fn the_end_is_the_end_of_the_last_frame_after_the_frames_join() {
        // The last frame starts at 9.984 s and lasts 1024 samples at 48000 Hz.
        let csv = "9.920000,1024\n9.941000,1024\n9.963000,1024\n9.984000,1024\n";
        assert_eq!(
            frames_of(csv, 48_000).end,
            Some(
                seconds("9.984")
                    .add(Rational::new(1024, 48_000).unwrap())
                    .unwrap()
            )
        );
        // Frames that arrive out of order: the end is that of the latest stretch, not of the last
        // line.
        assert_eq!(
            frames_of("5,1000\n1,1000\n", 1000),
            AudioFrames {
                gaps: vec![gap(None, "1"), gap(Some("2"), "5")],
                fine_gaps: vec![gap(None, "1"), gap(Some("2"), "5")],
                end: Some(seconds("6")),
                longest_frame: Some(seconds("1")),
            }
        );
        // An answer without frames has no end, and frames without a place have no length.
        assert_eq!(frames_of("", 48_000), AudioFrames::default());
        assert_eq!(frames_of("N/A,1000\n", 1000), AudioFrames::default());
    }

    #[test]
    fn the_fine_gaps_show_the_gaps_that_the_bound_joins_and_not_the_rounding_of_milliseconds() {
        // Frames of 1024 samples at 48000 Hz timed to the millisecond, as Matroska and FLV store
        // them, with a hole of 85 ms after the second frame and one of 0.5 s later.
        let csv = "10.000,1024\n10.021,1024\n10.128,1024\n10.149,1024\n11.000,1024\n";
        let frames = frames_of(csv, 48_000);
        // The bound joins the frames across 0.1 s, so it sees only the hole of 0.5 s.
        assert_eq!(
            frames.gaps,
            vec![
                gap(None, "10"),
                AudioGap {
                    from: Some(
                        seconds("10.149")
                            .add(Rational::new(1024, 48_000).unwrap())
                            .unwrap()
                    ),
                    to: seconds("11"),
                }
            ]
        );
        // The fine gaps join only across 2 ms: the 1/3 ms of rounding between the first two
        // frames is no gap, and the hole of 85 ms is one.
        assert_eq!(frames.fine_gaps.len(), 3);
        assert_eq!(
            frames.fine_gaps[1],
            AudioGap {
                from: Some(
                    seconds("10.021")
                        .add(Rational::new(1024, 48_000).unwrap())
                        .unwrap()
                ),
                to: seconds("10.128"),
            }
        );
        assert_eq!(frames.longest_frame, Rational::new(1024, 48_000));
        // The longest frame is the longest line.
        assert_eq!(
            frames_of("0,1024\n0.5,2048\n", 48_000).longest_frame,
            Rational::new(2048, 48_000)
        );
    }

    fn gap(from: Option<&str>, to: &str) -> AudioGap {
        AudioGap {
            from: from.map(seconds),
            to: seconds(to),
        }
    }

    #[test]
    fn frames_without_a_gap_leave_only_the_stretch_in_front_of_the_first_frame() {
        // Frames of 1024 samples at 48000 Hz, as ffprobe 9.0.2 timed them in a Matroska source,
        // to the millisecond: each frame ends a third of a millisecond after the next one starts.
        let csv = "9.920000,1024\n9.941000,1024\n9.963000,1024\n9.984000,1024\n";
        assert_eq!(gaps_of(csv, 48_000), vec![gap(None, "9.92")]);
        assert_eq!(gaps_of("", 48_000), vec![]);
        // Lines that end in a carriage return, as on Windows.
        assert_eq!(
            gaps_of("1,1000\r\n3,1000\r\n", 1000),
            vec![gap(None, "1"), gap(Some("2"), "3")]
        );
        // An AC-3 frame carries side data, and ffprobe 9.0.2 writes an empty field for it.
        assert_eq!(
            gaps_of("0.000000,1280,\n0.029000,1536,\n0.061000,1536,\n", 48_000),
            vec![gap(None, "0")]
        );
    }

    #[test]
    fn a_frame_lasts_its_samples_and_not_the_length_of_its_packet() {
        // ffprobe 9.0.2 on an MP4 copy of a source whose audio stops at 10.0055 s and resumes at
        // 100.011 s. The packet in front of the gap lasts 90 s in the file, and it decodes to 1024
        // samples. The second read lands on that packet again.
        let csv = "9.962500,16\n9.962833,1024\n9.984167,1024\n9.984167,1024\n\
                   100.011000,1024\n100.032333,1024\n";
        let end = seconds("9.984167")
            .add(Rational::new(1024, 48_000).unwrap())
            .unwrap();
        assert_eq!(
            gaps_of(csv, 48_000),
            vec![
                gap(None, "9.9625"),
                AudioGap {
                    from: Some(end),
                    to: seconds("100.011"),
                },
            ]
        );
    }

    #[test]
    fn a_gap_of_at_most_the_minimum_joins_its_frames() {
        // Frames of 1 s. 0.1 s between the first two joins them, and 0.2 s is a gap.
        assert_eq!(
            gaps_of("0,1000\n1.1,1000\n2.3,1000\n", 1000),
            vec![gap(None, "0"), gap(Some("2.1"), "2.3")]
        );
        // A frame without a sample count lasts no time.
        assert_eq!(
            gaps_of("5,N/A\n6,1000\n", 1000),
            vec![gap(None, "5"), gap(Some("5"), "6")]
        );
    }

    #[test]
    fn a_frame_without_a_timestamp_follows_the_frame_in_front_of_it() {
        // The AAC of an MPEG-TS source whose audio the analysis missed: only the first frame of
        // each PES packet has a timestamp. The two frames in front of the first timestamp end at
        // it, and a frame behind a frame starts where that one ends.
        let csv = "N/A,1000\nN/A,1000\n10,1000\nN/A,1000\nN/A,1000\n13,1000\n20,1000\nN/A,1000\n";
        assert_eq!(
            gaps_of(csv, 1000),
            vec![gap(None, "8"), gap(Some("14"), "20")]
        );
        // A timestamp in front of the start of the file.
        assert_eq!(
            gaps_of("-0.5,1000\n0.5,1000\n2,1000\n", 1000),
            vec![gap(None, "-0.5"), gap(Some("1.5"), "2")]
        );
        // Frames without a timestamp and nothing behind them have no place.
        assert_eq!(gaps_of("N/A,1000\nN/A,1000\n", 1000), vec![]);
    }

    #[test]
    fn the_frames_of_each_read_join_where_they_belong_in_time() {
        // The second read lands in front of the end of the first one and repeats two frames.
        assert_eq!(
            gaps_of(
                "10,1000\n11,1000\n12,1000\n11,1000\n12,1000\n30,1000\n",
                1000
            ),
            vec![gap(None, "10"), gap(Some("13"), "30")]
        );
        // The seek of an MPEG-TS source can land far in front of its target.
        assert_eq!(
            gaps_of("10,1000\n11,1000\n5,1000\n6,1000\n40,1000\n", 1000),
            vec![gap(None, "5"), gap(Some("7"), "10"), gap(Some("12"), "40")]
        );
    }

    #[test]
    fn an_answer_of_frames_that_cannot_be_read_fails() {
        let fails = |csv: &[u8], rate| {
            matches!(
                parse_audio_frames_csv(csv, rate, seconds("0.1")),
                Err(ProbeParseError::Invalid(
                    ProbeDataError::InvalidFrames { .. }
                ))
            )
        };
        for csv in [
            "1.5\n",
            "1.5,1024,5\n",
            "1.5,1024,,5\n",
            "x,1024\n",
            "1.5.2,1024\n",
            "1.5,-1\n",
            "1.5,1.5\n",
            "1.5,4294967296\n",
        ] {
            assert!(fails(csv.as_bytes(), 48_000), "{csv:?}");
        }
        assert!(fails(b"1.5,1024\n", 0));
        assert!(fails(b"1.5,1024\n\xff\n", 48_000));
        // An answer as long as the capture limit can be cut.
        assert!(fails(&vec![b'\n'; STDOUT_CAPTURE_LIMIT], 48_000));
        assert!(!fails(&vec![b'\n'; STDOUT_CAPTURE_LIMIT - 1], 48_000));
    }

    #[test]
    fn the_read_intervals_join_overlapping_ranges_in_order_and_round_outward() {
        let ranges = [
            (seconds("60"), seconds("62.5")),
            (seconds("0"), seconds("2")),
            (seconds("1"), seconds("3")),
            (seconds("3"), seconds("4")),
            (seconds("-1.5"), seconds("-1")),
            (
                Rational::new(301, 3).unwrap(),
                Rational::new(302, 3).unwrap(),
            ),
        ];
        assert_eq!(
            read_intervals_argument(&ranges).as_deref(),
            Some(
                "-1.500001%-0.999999,-0.000001%4.000001,59.999999%62.500001,\
                 100.333332%100.666668"
            )
        );
    }

    /// The length of the command of a read of the audio gaps, as the export measures a command
    /// line.
    fn gap_read_length(intervals: &str, input: &str) -> usize {
        let arguments: Vec<String> = audio_gap_arguments("99", intervals, OsStr::new(input))
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        crate::ffmpeg::export::arguments::command_line_length(&arguments)
    }

    /// A path of 259 characters, the longest that Windows accepts without the extended-length
    /// prefix, ending in `suffix`.
    fn longest_windows_path(suffix: &str) -> String {
        let head = r"C:\Users\alexandra.whitfield\Videos\Captures\";
        format!(
            "{head}{}{suffix}",
            "a".repeat(259 - head.len() - suffix.len())
        )
    }

    #[test]
    fn the_gap_read_of_the_most_pieces_fits_the_windows_budget() {
        use crate::ffmpeg::export::arguments::WINDOWS_COMMAND_LINE_BUDGET;
        use crate::ffmpeg::export::flv_input::{head_name, FlvInput};
        use crate::ffmpeg::export::MAX_EXPORT_PIECES;

        // ADR 055: the intervals of `-read_intervals` grow with the pieces of one source. The
        // widest that the code writes: every piece touches no other, so each one is an interval of
        // its own, and each bound has thirteen integer digits, a sign and six decimals. A bound
        // with more integer digits does not survive the move of 1 microsecond in an `i64`
        // rational, so the code does not write it.
        let count = i64::try_from(MAX_EXPORT_PIECES).unwrap();
        let ranges: Vec<(Rational, Rational)> = (0..count)
            .map(|index| {
                let start = -9_200_000_000_000_000_000 + index * 10_000_000_000_000 + 1;
                (
                    Rational::new(start, 1_000_000).unwrap(),
                    Rational::new(start + 1_000_000_000, 1_000_000).unwrap(),
                )
            })
            .collect();
        let intervals = read_intervals_argument(&ranges).unwrap();
        assert_eq!(intervals.split(',').count(), MAX_EXPORT_PIECES);
        assert!(intervals
            .split(['%', ','])
            .all(|bound| bound.len() == "-9200000000000.000000".len()));
        let fourteen_digits = Rational::new(-20_000_000_000_001, 2).unwrap();
        assert_eq!(
            read_intervals_argument(&[(
                fourteen_digits,
                fourteen_digits.add(Rational::new(1, 1).unwrap()).unwrap()
            )]),
            None
        );
        // No bound is longer than an `i64` of seconds with six decimals, which is 27 characters,
        // so the budget is also measured at that width, whatever the rational.
        let widest_bound = format!("-{}.000000", i64::MAX);
        let bound = |_| format!("{widest_bound}%{widest_bound}");
        let upper: Vec<String> = (0..MAX_EXPORT_PIECES).map(bound).collect();
        let upper = upper.join(",");
        assert!(intervals.len() < upper.len());

        let source = longest_windows_path(".mkv");
        let written = gap_read_length(&intervals, &source);
        let length = gap_read_length(&upper, &source);
        // `cargo test -- --nocapture` prints the lengths.
        println!(
            "gap read at {MAX_EXPORT_PIECES} pieces: {written} bytes as written, {length} bytes \
             at the bound of an i64"
        );
        assert!(
            length <= WINDOWS_COMMAND_LINE_BUDGET,
            "the gap read at {MAX_EXPORT_PIECES} pieces needs {length} bytes"
        );

        // The read of an FLV source runs one command for each group of pieces, with one interval
        // and the slice of the group: the widest head in a work directory of 259 characters, the
        // widest offsets and the widest source.
        let flv = FlvInput {
            head_name: head_name(99),
            source_size: u64::MAX,
            segment_offsets: vec![u64::MAX - 1],
            first_frame_offset: 13,
        };
        let head = longest_windows_path(&format!("\\{}", head_name(99)));
        let url = flv.url(&head, u64::MAX - 1, Path::new(&source));
        let length = gap_read_length(&format!("%{widest_bound}"), &url);
        println!("FLV gap read: {length} bytes");
        assert!(length <= WINDOWS_COMMAND_LINE_BUDGET, "{length} bytes");
    }

    #[test]
    fn the_slices_of_an_flv_gap_read_join_the_ranges_that_overlap_or_touch() {
        // In concat order, as the segments are. Each group reads from the earliest slice of its
        // ranges to its end.
        let ranges = [
            (seconds("60"), seconds("62.5")),
            (seconds("0"), seconds("2")),
            (seconds("1"), seconds("3")),
            (seconds("3"), seconds("4")),
        ];
        assert_eq!(
            slice_groups(&ranges, &[9_000, 500, 100, 800]),
            vec![(seconds("4"), 100), (seconds("62.5"), 9_000)]
        );
        assert_eq!(slice_groups(&[], &[]), vec![]);
    }

    #[test]
    fn the_start_of_a_slice_answers_its_picture_and_its_audio_frames() {
        let csv = b"audio,1,2.008000,1024,2\n\
                    audio,1,N/A,1024,2\n\
                    video,0,2.067000,1280,720\n\
                    video,0,2.100000,640,360\n\
                    audio,1,2.051000,1024,\n\
                    audio,2,2.051000,1024,2\n\
                    data,3,2.0,,\n";
        let start = parse_slice_start(csv, 0, Some(1), true).unwrap();
        assert!(start.clean);
        // The first frame of the video stream counts.
        assert_eq!(start.picture, Some((1280, 720)));
        assert_eq!(
            start.audio,
            vec![
                DecodedAudioFrame {
                    pts: Some(seconds("2.008")),
                    nb_samples: 1024,
                    channels: Some(2),
                },
                DecodedAudioFrame {
                    pts: None,
                    nb_samples: 1024,
                    channels: Some(2),
                },
                DecodedAudioFrame {
                    pts: Some(seconds("2.051")),
                    nb_samples: 1024,
                    channels: None,
                },
            ]
        );
        let video_only = parse_slice_start(csv, 0, None, false).unwrap();
        assert!(video_only.audio.is_empty());
        assert!(!video_only.clean);
        assert_eq!(
            parse_slice_start(b"", 0, Some(1), true).unwrap(),
            SliceStart {
                picture: None,
                audio: vec![],
                clean: true,
            }
        );
        assert!(parse_slice_start(b"video,0,2.0,N/A,N/A\n", 0, None, true).is_err());
        assert!(parse_slice_start(b"audio,1,2.0,many,1\n", 0, Some(1), true).is_err());
        assert!(parse_slice_start(b"audio,x,2.0,1024,1\n", 0, Some(1), true).is_err());
    }

    #[test]
    fn a_frames_probe_run_reports_the_failures_of_every_probe() {
        let run = |end| ProbeRun {
            end,
            stdout: b"1,1000\n3,1000\n".to_vec(),
            stderr: Vec::new(),
        };
        let parse = |csv: &[u8]| parse_audio_frames_csv(csv, 1000, seconds("0.1"));
        assert_eq!(
            finish_probe_run_with(
                run(ProbeEnd::Exited(ProbeExit {
                    code: Some(0),
                    success: true,
                })),
                PROBE_TIMEOUT,
                parse
            )
            .unwrap(),
            AudioFrames {
                gaps: vec![gap(None, "1"), gap(Some("2"), "3")],
                fine_gaps: vec![gap(None, "1"), gap(Some("2"), "3")],
                end: Some(seconds("4")),
                longest_frame: Some(seconds("1")),
            }
        );
        assert!(matches!(
            finish_probe_run_with(run(ProbeEnd::TimedOut), PROBE_TIMEOUT, parse),
            Err(ProbeError::TimedOut { .. })
        ));
        assert!(matches!(
            finish_probe_run_with(run(ProbeEnd::Canceled), PROBE_TIMEOUT, parse),
            Err(ProbeError::Canceled)
        ));
    }

    #[test]
    fn a_first_packet_probe_run_reports_the_failures_of_every_probe() {
        let run = |end, stdout: &[u8]| ProbeRun {
            end,
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        };
        let answer = br#"{"packets":[{"pts":12000}],"streams":[{"time_base":"1/1000"}]}"#;
        let exited = |success| {
            ProbeEnd::Exited(ProbeExit {
                code: Some(if success { 0 } else { 1 }),
                success,
            })
        };
        assert_eq!(
            finish_probe_run_with(
                run(exited(true), answer),
                PROBE_TIMEOUT,
                parse_first_packet_json
            )
            .unwrap()
            .and_then(|packet| packet.time),
            Some(seconds("12"))
        );
        assert!(matches!(
            finish_probe_run_with(
                run(exited(false), b""),
                PROBE_TIMEOUT,
                parse_first_packet_json
            ),
            Err(ProbeError::ProcessFailed { code: Some(1), .. })
        ));
        assert!(matches!(
            finish_probe_run_with(
                run(ProbeEnd::TimedOut, answer),
                PROBE_TIMEOUT,
                parse_first_packet_json
            ),
            Err(ProbeError::TimedOut { .. })
        ));
        assert!(matches!(
            finish_probe_run_with(
                run(ProbeEnd::Canceled, answer),
                PROBE_TIMEOUT,
                parse_first_packet_json
            ),
            Err(ProbeError::Canceled)
        ));
    }

    #[test]
    fn a_later_first_packet_moves_a_missed_matroska_start_and_keeps_the_reported_end() {
        // The shape ffprobe 9.0.2 reported for a Matroska source whose audio starts 60 s after
        // its video: the start of the container, the duration of the container as `duration_ts`,
        // and the tag of the track. A length kept as a length would end the audio at 180.01 s.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "start_time": "0.000000",
            "duration_ts": 120010,
            "duration": "120.010000",
            "tags": { "DURATION": "00:02:00.010000000" }
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, Some(seconds("0")));
        assert_eq!(audio.duration, Some(seconds("120.01")));
        assert_eq!(audio.tagged_end, Some(seconds("120.01")));

        assert!(audio.take_first_packet(seconds("59.979")));
        assert_eq!(audio.start_time, Some(seconds("59.979")));
        assert_eq!(audio.duration, Some(seconds("60.031")));

        // A tag that another muxer wrote as the length of the track, 108 s of audio from 12 s in
        // a file of 120 s. Read as an end, it would end the audio at 108 s, before the end the
        // export used without the correction. The reported end, the end of the container, stays.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 120000,
            "tags": { "DURATION": "00:01:48.000000000" }
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.start_time, Some(seconds("12")));
        assert_eq!(audio.duration, Some(seconds("108")));

        // The same end wins over a tag of FFmpeg's muxer that ends the audio before the
        // container. That keeps the end the export used before, and gives up the earlier end.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 120010,
            "tags": { "DURATION": "00:01:40.000000000" }
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.duration, Some(seconds("108.01")));
    }

    #[test]
    fn a_later_first_packet_moves_a_missed_transport_stream_start_and_keeps_its_end() {
        // The shape ffprobe 9.0.2 reported for an MPEG-TS source whose audio starts 60 s after
        // its video: the start and the duration of the container, and no tag. The end of the
        // container stays the end of the audio.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/90000",
            "start_pts": 126000,
            "start_time": "1.400000",
            "duration_ts": 10800000,
            "duration": "120.000000"
        }))
        .audio
        .unwrap();
        let first_packet = Rational::new(5_524_080, 90_000).unwrap();
        assert!(audio.take_first_packet(first_packet));
        assert_eq!(audio.start_time, Some(first_packet));
        assert_eq!(
            audio.duration,
            seconds("121.4").sub(first_packet),
            "the end stays at 1.4 s + 120 s"
        );
    }

    #[test]
    fn a_first_packet_at_or_before_the_reported_start_changes_nothing() {
        // A source that ffprobe reads correctly. In Matroska, the reported start already skips the
        // priming of the encoder, so the first packet lies 21 ms before it. In MPEG-TS the two are
        // equal.
        let matroska = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "tags": { "DURATION": "00:02:00.021000000" }
        }))
        .audio
        .unwrap();
        let mut corrected = matroska.clone();
        assert!(!corrected.take_first_packet(seconds("-0.021")));
        assert_eq!(corrected, matroska);
        assert!(!corrected.take_first_packet(seconds("0")));
        assert_eq!(corrected, matroska);
    }

    #[test]
    fn a_first_packet_gives_a_start_that_was_not_reported_and_a_length_only_from_an_end() {
        // No start was reported, so a reported length places no end; the tag still does.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "duration_ts": 50000,
            "tags": { "DURATION": "00:01:00.000000000" }
        }))
        .audio
        .unwrap();
        assert_eq!(audio.start_time, None);
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.start_time, Some(seconds("12")));
        assert_eq!(audio.duration, Some(seconds("48")));

        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "duration_ts": 50000
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.start_time, Some(seconds("12")));
        assert_eq!(audio.duration, None);
    }

    #[test]
    fn an_end_at_or_before_the_first_packet_is_not_an_end() {
        // A reported end before the first packet gives way to a tag after it.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 10000,
            "tags": { "DURATION": "00:00:30.000000000" }
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.duration, Some(seconds("18")));

        // A tag at the first packet is no end either.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "tags": { "DURATION": "00:01:00.000000000" }
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("60")));
        assert_eq!(audio.start_time, Some(seconds("60")));
        assert_eq!(audio.duration, None);

        // Neither end lies after the first packet.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 10000,
            "tags": { "DURATION": "00:00:12.000000000" }
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("12")));
        assert_eq!(audio.duration, None);

        // No end after the first packet at all: the length is unknown, not zero or negative.
        let mut audio = probe_with_audio_stream(serde_json::json!({
            "time_base": "1/1000",
            "start_pts": 0,
            "duration_ts": 10000
        }))
        .audio
        .unwrap();
        assert!(audio.take_first_packet(seconds("10")));
        assert_eq!(audio.start_time, Some(seconds("10")));
        assert_eq!(audio.duration, None);
    }

    // -- the probe of an export output without video ------------------------------------------

    fn parse_output(value: Value) -> OutputAudioProbe {
        parse_output_audio_json(&serde_json::to_vec(&value).unwrap()).unwrap()
    }

    fn seconds(text: &str) -> Rational {
        Rational::from_decimal_str(text).unwrap()
    }

    #[test]
    fn an_m4a_output_reports_one_audio_stream_and_the_format_duration() {
        // The shape ffprobe 9.0.2 writes for an `.m4a` of the `mp4` muxer: the stream and the
        // format report the same duration.
        let probe = parse_output(serde_json::json!({
            "streams": [{
                "index": 0,
                "codec_type": "audio",
                "codec_name": "aac",
                "start_time": "0.016000",
                "duration": "5.000000"
            }],
            "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "5.000000" }
        }));
        assert_eq!(
            probe,
            OutputAudioProbe {
                audio_streams: 1,
                video_streams: 0,
                duration: Some(seconds("5")),
                audio_start: Some(seconds("0.016")),
            }
        );
        // Two audio streams have no one start.
        let two = parse_output(serde_json::json!({
            "streams": [
                { "codec_type": "audio", "start_time": "0.016000" },
                { "codec_type": "audio", "start_time": "0.016000" }
            ],
            "format": { "duration": "5.000000" }
        }));
        assert_eq!(two.audio_start, None);
    }

    #[test]
    fn an_mka_output_reports_the_format_duration_where_the_stream_reports_none() {
        // The `matroska` demuxer reports no stream duration, only a `DURATION` tag; the length
        // is the segment's, which ffprobe shows as `format.duration`.
        let probe = parse_output(serde_json::json!({
            "streams": [{
                "index": 0,
                "codec_type": "audio",
                "codec_name": "opus",
                "duration": "N/A",
                "tags": { "DURATION": "00:00:05.008000000" }
            }],
            "format": { "format_name": "matroska,webm", "duration": "5.008000" }
        }));
        assert_eq!(probe.duration, Some(seconds("5.008")));
        assert_eq!(probe.audio_streams, 1);
    }

    #[test]
    fn the_stream_duration_stands_in_only_for_a_missing_format_duration_and_one_audio_stream() {
        let one = parse_output(serde_json::json!({
            "streams": [{ "codec_type": "audio", "duration": "4.250000" }],
            "format": { "duration": "N/A" }
        }));
        assert_eq!(one.duration, Some(seconds("4.25")));

        // Two audio streams fail the check anyway; neither one's duration speaks for the file.
        let two = parse_output(serde_json::json!({
            "streams": [
                { "codec_type": "audio", "duration": "4.250000" },
                { "codec_type": "audio", "duration": "4.250000" }
            ],
            "format": {}
        }));
        assert_eq!(two.duration, None);
        assert_eq!(two.audio_streams, 2);
    }

    #[test]
    fn video_streams_are_counted_whatever_their_disposition_and_other_types_are_not() {
        let probe = parse_output(serde_json::json!({
            "streams": [
                { "codec_type": "audio" },
                { "codec_type": "video", "disposition": { "attached_pic": 1 } },
                { "codec_type": "video" },
                { "codec_type": "data" },
                { "codec_type": "subtitle" },
                {}
            ],
            "format": { "duration": "1.000000" }
        }));
        assert_eq!(probe.audio_streams, 1);
        assert_eq!(probe.video_streams, 2);
    }

    #[test]
    fn an_answer_without_streams_or_a_usable_duration_parses_and_only_bad_json_fails() {
        // An empty or unusable answer is a finding for the success check, not a parse failure:
        // the check reports it with the code that names what is wrong with the file.
        let empty = parse_output(serde_json::json!({}));
        assert_eq!(
            empty,
            OutputAudioProbe {
                audio_streams: 0,
                video_streams: 0,
                duration: None,
                audio_start: None,
            }
        );
        let scientific = parse_output(serde_json::json!({
            "streams": [{ "codec_type": "audio" }],
            "format": { "duration": "1e+01" }
        }));
        assert_eq!(scientific.duration, None);

        assert!(matches!(
            parse_output_audio_json(b"{"),
            Err(ProbeParseError::Json(_))
        ));
    }

    #[test]
    fn a_successful_output_probe_run_parses_its_captured_stdout_and_a_failed_one_reports_it() {
        let run = ProbeRun {
            end: ProbeEnd::Exited(ProbeExit {
                code: Some(0),
                success: true,
            }),
            stdout: br#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"2.500000"}}"#
                .to_vec(),
            stderr: Vec::new(),
        };
        let probe = finish_probe_run_with(run, PROBE_TIMEOUT, parse_output_audio_json).unwrap();
        assert_eq!(probe.duration, Some(seconds("2.5")));

        // An empty reservation is not a media file. ffprobe exits unsuccessfully on it, and the
        // output probe reports that exit as the probe of a source does.
        let run = ProbeRun {
            end: ProbeEnd::Exited(ProbeExit {
                code: Some(1),
                success: false,
            }),
            stdout: Vec::new(),
            stderr: b"Invalid data found when processing input".to_vec(),
        };
        assert!(matches!(
            finish_probe_run_with(run, PROBE_TIMEOUT, parse_output_audio_json),
            Err(ProbeError::ProcessFailed { code: Some(1), .. })
        ));
    }

    // -- the shape of the picture and the end of the video -------------------------------------

    fn sample_aspect_ratio_of(value: Option<&str>) -> Option<Rational> {
        let mut raw = base_probe();
        if let Some(value) = value {
            raw["streams"][0]["sample_aspect_ratio"] = serde_json::json!(value);
        }
        parse_value(raw).unwrap().sample_aspect_ratio
    }

    #[test]
    fn the_sample_aspect_ratio_is_a_positive_ratio_or_none() {
        assert_eq!(sample_aspect_ratio_of(Some("1:1")), Rational::new(1, 1));
        assert_eq!(sample_aspect_ratio_of(Some("64:45")), Rational::new(64, 45));
        assert_eq!(sample_aspect_ratio_of(Some("32:30")), Rational::new(16, 15));
        assert_eq!(sample_aspect_ratio_of(Some("0:1")), None);
        assert_eq!(sample_aspect_ratio_of(Some("1:0")), None);
        assert_eq!(sample_aspect_ratio_of(Some("-4:3")), None);
        assert_eq!(sample_aspect_ratio_of(Some("N/A")), None);
        assert_eq!(sample_aspect_ratio_of(Some("4/3")), None);
        assert_eq!(sample_aspect_ratio_of(Some("")), None);
        assert_eq!(sample_aspect_ratio_of(None), None);
        let value = serde_json::to_value(parse_value(base_probe()).unwrap()).unwrap();
        assert_eq!(value["sampleAspectRatio"], Value::Null);
    }

    fn rotation_of(side_data: Option<Value>, rotate_tag: Option<&str>) -> u16 {
        let mut raw = base_probe();
        if let Some(side_data) = side_data {
            raw["streams"][0]["side_data_list"] = side_data;
        }
        if let Some(rotate) = rotate_tag {
            raw["streams"][0]["tags"] = serde_json::json!({ "rotate": rotate });
        }
        parse_value(raw).unwrap().rotation
    }

    fn display_matrix(rotation: Value) -> Value {
        serde_json::json!([{
            "side_data_type": "Display Matrix",
            "displaymatrix": "\n00000000:            0       65536           0\n",
            "rotation": rotation
        }])
    }

    #[test]
    fn the_rotation_is_the_clockwise_quarter_turn_of_the_display_matrix_or_the_rotate_tag() {
        // ffprobe prints the counter-clockwise angle of the matrix.
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-90))), None),
            90
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(90))), None),
            270
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(180))), None),
            180
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-180))), None),
            180
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(0))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-90.0))), None),
            90
        );
        // Only an exact quarter turn counts; any other angle reads as 0, as FFmpeg transposes
        // only a quarter turn and otherwise keeps the size of the frame.
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-89.5))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-91))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(179.2))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(0.5))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-88.5))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-30))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-50))), None),
            0
        );
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-135.5))), None),
            0
        );
        assert_eq!(rotation_of(None, Some("45")), 0);
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-450))), None),
            90
        );
        // The legacy tag is clockwise already, and the matrix comes first.
        assert_eq!(rotation_of(None, Some("90")), 90);
        assert_eq!(rotation_of(None, Some("270")), 270);
        assert_eq!(rotation_of(None, Some("-90")), 270);
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!(-180))), Some("90")),
            180
        );
        // A matrix without a usable angle leaves the tag, and nothing reads as 0.
        assert_eq!(
            rotation_of(Some(display_matrix(serde_json::json!("x"))), Some("90")),
            90
        );
        assert_eq!(rotation_of(None, None), 0);
        assert_eq!(rotation_of(None, Some("N/A")), 0);
        // Other side data and a list of an unknown form never fail the probe.
        assert_eq!(
            rotation_of(
                Some(serde_json::json!([{"side_data_type": "CPB properties"}])),
                None
            ),
            0
        );
        assert_eq!(rotation_of(Some(serde_json::json!("odd")), None), 0);
        let value = serde_json::to_value(parse_value(base_probe()).unwrap()).unwrap();
        assert_eq!(value["rotation"], 0);
    }

    fn tail_probe() -> MediaProbe {
        let mut raw = base_probe();
        raw["streams"][0]["time_base"] = serde_json::json!("1/15360");
        raw["streams"][0]["start_pts"] = serde_json::json!(0);
        raw["streams"][0]["avg_frame_rate"] = serde_json::json!("30/1");
        parse_value(raw).unwrap()
    }

    fn tail_answer(probe: &MediaProbe, packets: Value) -> VideoTail {
        let json = serde_json::to_vec(&serde_json::json!({ "packets": packets })).unwrap();
        parse_video_tail_json(&json, probe).unwrap()
    }

    /// The end that `packets` give, as the answer of a read that starts at a keyframe: the first
    /// packet takes the flags `K__` when it has no flags of its own.
    fn tail_end(probe: &MediaProbe, mut packets: Value) -> Option<Pts> {
        if let Some(first) = packets.get_mut(0).and_then(Value::as_object_mut) {
            first
                .entry("flags")
                .or_insert_with(|| serde_json::json!("K__"));
        }
        match tail_answer(probe, packets) {
            VideoTail::Read(end) => end,
            VideoTail::WithoutKeyframe => panic!("the answer has a keyframe"),
        }
    }

    #[test]
    fn the_end_of_the_video_is_the_largest_pts_plus_duration_of_the_presented_packets() {
        let probe = tail_probe();
        // The last packets of a 2 s H.264 file at 30 fps, in decode order: the packet with the
        // largest pts is not the last one.
        let packets = serde_json::json!([
            {"pts": 26624, "duration": 512, "flags": "K__"},
            {"pts": 28160, "duration": 512, "flags": "___"},
            {"pts": 28672, "duration": 512, "flags": "___"},
            {"pts": 30208, "duration": 512, "flags": "___"},
            {"pts": 29184, "duration": 512, "flags": "___"},
            {"pts": 29696, "duration": 512, "flags": "___"}
        ]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(30720)));
        // A packet flagged as discarded is not presented, whatever its time.
        let packets = serde_json::json!([
            {"pts": 22016, "duration": 512, "flags": "K__"},
            {"pts": 23552, "duration": 512, "flags": "_D_"},
            {"pts": 22528, "duration": 512, "flags": "___"},
            {"pts": 23040, "duration": 512, "flags": "KD_"}
        ]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(23040)));
        // A pts and a duration as text count.
        let packets = serde_json::json!([{"pts": "1024", "duration": "512"}]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(1536)));
    }

    #[test]
    fn a_presented_packet_without_a_pts_makes_the_end_unknown() {
        let probe = tail_probe();
        // An MPEG-2 program stream with B-frames lists its last packets in decode order with
        // `pts` `N/A`; the largest pts of the others ends early, so there is no end.
        let packets = serde_json::json!([
            {"pts": 1024, "duration": 512, "flags": "K__"},
            {"pts": 2048, "duration": 512, "flags": "___"},
            {"pts": "N/A", "duration": 512, "flags": "___"},
            {"duration": 512, "flags": "___"}
        ]);
        assert_eq!(tail_end(&probe, packets), None);
        let packets = serde_json::json!([
            {"pts": 1024, "duration": 512, "flags": "K__"},
            {"pts": "x", "duration": 512}
        ]);
        assert_eq!(tail_end(&probe, packets), None);
        // A discarded packet without a pts is not presented, so it does not count.
        let packets = serde_json::json!([
            {"pts": 1024, "duration": 512, "flags": "K__"},
            {"pts": "N/A", "duration": 512, "flags": "_D_"}
        ]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(1536)));
    }

    #[test]
    fn an_answer_without_a_keyframe_is_not_a_tail() {
        let probe = tail_probe();
        // A TS asked for a start past its end lists one packet, not the one with the largest
        // pts.
        let packets = serde_json::json!([{"pts": 2_817_000, "duration": 3000, "flags": "___"}]);
        assert_eq!(tail_answer(&probe, packets), VideoTail::WithoutKeyframe);
        let packets = serde_json::json!([{"pts": 512, "duration": 512}]);
        assert_eq!(tail_answer(&probe, packets), VideoTail::WithoutKeyframe);
        assert_eq!(
            tail_answer(&probe, serde_json::json!([])),
            VideoTail::WithoutKeyframe
        );
        assert_eq!(
            parse_video_tail_json(b"{}", &probe).unwrap(),
            VideoTail::WithoutKeyframe
        );
        // A discarded keyframe still shows that the read started at a keyframe.
        let packets = serde_json::json!([
            {"pts": 0, "duration": 512, "flags": "KD_"},
            {"pts": 512, "duration": 512, "flags": "___"}
        ]);
        assert_eq!(
            tail_answer(&probe, packets),
            VideoTail::Read(Some(Pts::new(1024)))
        );
    }

    #[test]
    fn a_packet_without_a_duration_lasts_the_nominal_interval_rounded_up() {
        let mut probe = tail_probe();
        // 30 fps in 1/15360 is 512 ticks exactly.
        let packets = serde_json::json!([
            {"pts": 1024, "duration": 512},
            {"pts": 1536}
        ]);
        assert_eq!(tail_end(&probe, packets.clone()), Some(Pts::new(2048)));
        let zero =
            serde_json::json!([{"pts": 1024, "duration": 512}, {"pts": 1536, "duration": 0}]);
        assert_eq!(tail_end(&probe, zero), Some(Pts::new(2048)));
        // Every packet without a duration takes the interval, not only the last one.
        let packets_in_front = serde_json::json!([
            {"pts": 0, "duration": 100},
            {"pts": 1536},
            {"pts": 1600, "duration": 100}
        ]);
        assert_eq!(
            tail_end(&probe, packets_in_front.clone()),
            Some(Pts::new(2048))
        );
        // 30000/1001 in 1/90000 is 3003 ticks; 29.97 in 1/1000 is 33.36 ticks, so 34.
        probe.video_time_base = Rational::new(1, 1000).unwrap();
        probe.avg_frame_rate = Rational::new(30000, 1001);
        assert_eq!(tail_end(&probe, packets.clone()), Some(Pts::new(1570)));
        probe.video_time_base = Rational::new(1, 90000).unwrap();
        assert_eq!(tail_end(&probe, packets.clone()), Some(Pts::new(4539)));
        // `r_frame_rate` stands in for a missing average rate.
        probe.avg_frame_rate = None;
        probe.r_frame_rate = Rational::new(25, 1);
        assert_eq!(
            tail_end(&probe, packets.clone()),
            Some(Pts::new(1536 + 3600))
        );
        // An interval below one tick is one tick.
        probe.r_frame_rate = Rational::new(1_000_000, 1);
        assert_eq!(tail_end(&probe, packets.clone()), Some(Pts::new(1537)));
        // Without a rate, any packet that needs the interval makes the end unknown, the last
        // one or one in front of it.
        probe.r_frame_rate = None;
        assert_eq!(tail_end(&probe, packets), None);
        assert_eq!(tail_end(&probe, packets_in_front), None);
        // Packets that all have a duration need no rate, and a packet in front of the one with
        // the largest pts that ends later still decides the end.
        let packets =
            serde_json::json!([{"pts": 0, "duration": 9000}, {"pts": 1536, "duration": 512}]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(9000)));
    }

    #[test]
    fn a_tail_without_a_presented_packet_or_with_an_end_not_after_the_start_has_no_end() {
        let mut probe = tail_probe();
        let discarded = serde_json::json!([{"pts": 512, "duration": 512, "flags": "KD_"}]);
        assert_eq!(tail_end(&probe, discarded), None);
        assert!(parse_video_tail_json(b"{", &probe).is_err());

        probe.video_start_pts = Some(Pts::new(1024));
        let packets =
            serde_json::json!([{"pts": 0, "duration": 512}, {"pts": 512, "duration": 512}]);
        assert_eq!(tail_end(&probe, packets), None);
        let packets = serde_json::json!([{"pts": 512, "duration": 513}]);
        assert_eq!(tail_end(&probe, packets), Some(Pts::new(1025)));
        // A sum past the range of a PTS is no end.
        let packets = serde_json::json!([{"pts": i64::MAX, "duration": 1}]);
        assert_eq!(tail_end(&probe, packets), None);
        // The end is a PTS string on the wire.
        probe.video_end_pts = Some(Pts::new(30720));
        let value = serde_json::to_value(&probe).unwrap();
        assert_eq!(value["videoEndPts"], "30720");
        probe.video_end_pts = None;
        let value = serde_json::to_value(&probe).unwrap();
        assert_eq!(value["videoEndPts"], Value::Null);
    }

    #[test]
    fn the_tail_read_starts_ten_seconds_before_the_approximate_end_and_not_before_zero() {
        let decimal = |text: Option<&str>| text.and_then(Rational::from_decimal_str);
        let start = |format: Option<&str>, video: Option<&str>, duration: Option<f64>| {
            video_tail_start(decimal(format), decimal(video), duration)
        };
        assert_eq!(
            start(Some("1.5"), None, Some(60.9)),
            Rational::from_decimal_str("51.5")
        );
        assert_eq!(start(None, None, Some(60.9)), Rational::new(50, 1));
        // Without a container start, the exact start of the video stands in.
        assert_eq!(
            start(None, Some("1000.04"), Some(60.9)),
            Rational::from_decimal_str("1050.04")
        );
        assert_eq!(
            start(Some("1.5"), Some("1000"), Some(60.9)),
            Rational::from_decimal_str("51.5")
        );
        assert_eq!(start(Some("1.5"), None, Some(2.0)), Rational::new(0, 1));
        assert_eq!(start(Some("-5"), None, Some(12.0)), Rational::new(0, 1));
        assert_eq!(start(Some("1.5"), None, None), None);
        assert_eq!(start(Some("1.5"), None, Some(f64::NAN)), None);
        assert_eq!(start(Some("1.5"), None, Some(-1.0)), None);

        let restart = |format: Option<&str>, video: Option<&str>| {
            video_tail_restart(decimal(format), decimal(video))
        };
        assert_eq!(
            restart(Some("1001.4"), Some("1002")),
            Rational::from_decimal_str("1001.4")
        );
        assert_eq!(restart(None, Some("1002")), Rational::new(1002, 1));
        assert_eq!(restart(None, None), Rational::new(0, 1));
        assert_eq!(restart(Some("-1.4"), None), Rational::new(0, 1));

        let mut probe = tail_probe();
        probe.video_start_pts = Some(Pts::new(15360 * 3));
        assert_eq!(video_start_seconds(&probe), Rational::new(3, 1));
        probe.video_start_pts = None;
        assert_eq!(video_start_seconds(&probe), None);
    }

    #[test]
    fn the_end_of_an_flv_is_its_last_frame_plus_the_nominal_interval_rounded_up() {
        // 30 fps in 1/1000 is 33.33 ticks, so 34.
        let probe = flv_probe();
        assert_eq!(flv_video_end(&probe, 1_354_555), Some(Pts::new(1_354_589)));
        // A rate of 25 fps lasts 40 ticks exactly.
        let mut probe = flv_probe();
        probe.avg_frame_rate = Rational::new(25, 1);
        assert_eq!(flv_video_end(&probe, 1_354_555), Some(Pts::new(1_354_595)));
        // Another time base takes the exact time of the tag.
        let mut probe = flv_probe();
        probe.video_time_base = Rational::new(1, 90000).unwrap();
        probe.video_start_pts = Some(Pts::new(0));
        probe.avg_frame_rate = Rational::new(30, 1);
        assert_eq!(flv_video_end(&probe, 1000), Some(Pts::new(93_000)));
        // Without a rate, and with an end not after the start: no end.
        let mut probe = flv_probe();
        probe.avg_frame_rate = None;
        probe.r_frame_rate = None;
        assert_eq!(flv_video_end(&probe, 1_354_555), None);
        assert_eq!(flv_video_end(&flv_probe(), 1_234_500), None);
        // The correction of the length and the probe of the stream read no end of their own.
        let mut probe = flv_probe();
        correct_flv_probe(
            &mut probe,
            Some(crate::flv::locate::Extent {
                first_video_pts: Some(1_234_588),
                last_video_pts: Some(1_354_555),
            }),
        );
        assert_eq!(probe.video_end_pts, None);
        assert_eq!(flv_probe().video_end_pts, None);
    }

    /// Write `script` as an executable fake ffprobe in a new directory, and return the directory
    /// and the program.
    #[cfg(unix)]
    fn fake_ffprobe(script: &str) -> (crate::flv::test_support::TestDirectory, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let directory = crate::flv::test_support::TestDirectory::new();
        let program = directory.path.join("fake-ffprobe");
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        (directory, program)
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_tail_read_leaves_the_import_probe_without_an_end() {
        let answer = serde_json::to_string(&base_probe()).unwrap();
        let (directory, program) = fake_ffprobe(&format!(
            "#!/bin/sh\nfor argument in \"$@\"; do\n  if [ \"$argument\" = -read_intervals ]; then\n    echo 'read failed' >&2\n    exit 1\n  fi\ndone\ncat <<'JSON'\n{answer}\nJSON\n"
        ));
        let media = directory.path.join("source.mp4");
        let probe = probe_media(&program, &media).unwrap();
        assert_eq!(probe.video_end_pts, None);
        assert_eq!(probe.video_codec, "h264");
        assert_eq!(probe, parse_value(base_probe()).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn an_answer_without_a_keyframe_reads_the_tail_again_from_the_start_once() {
        // The first read, from 40 s, answers one packet without a keyframe, as a TS asked for a
        // start past its end does. The read from 0 s answers the whole tail.
        let mut probe = tail_probe();
        probe.format_start_time = Rational::new(0, 1);
        probe.approximate_duration_seconds = Some(50.0);
        let script = "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = -read_intervals ]; then\n    shift\n    if [ \"$1\" = 0.000000% ]; then\n      echo '{\"packets\":[{\"pts\":0,\"duration\":512,\"flags\":\"K__\"},{\"pts\":1024,\"duration\":512,\"flags\":\"___\"},{\"pts\":512,\"duration\":512,\"flags\":\"___\"}]}'\n    else\n      echo '{\"packets\":[{\"pts\":512,\"duration\":512,\"flags\":\"___\"}]}'\n    fi\n    exit 0\n  fi\n  shift\ndone\nexit 1\n";
        let (directory, program) = fake_ffprobe(script);
        let media = directory.path.join("source.ts");
        assert_eq!(
            probe_video_end(&program, &media, &probe),
            Some(Pts::new(1536))
        );
        // A read that starts at the start already is not repeated, and gives no end.
        probe.approximate_duration_seconds = Some(5.0);
        let (directory, program) = fake_ffprobe(
            "#!/bin/sh\necho '{\"packets\":[{\"pts\":512,\"duration\":512,\"flags\":\"___\"}]}'\n",
        );
        let media = directory.path.join("source.ts");
        assert_eq!(probe_video_end(&program, &media, &probe), None);
        // A second answer without a keyframe gives no end.
        probe.approximate_duration_seconds = Some(50.0);
        assert_eq!(probe_video_end(&program, &media, &probe), None);
    }

    /// The `ffmpeg` and the `ffprobe` that this machine has, as `real_tools` in
    /// `commands::export` finds them, or `None`, and the test that needs them passes without a
    /// check.
    fn real_tools() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
        let mut directories: Vec<std::path::PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        directories.push(std::path::PathBuf::from("/opt/homebrew/bin"));
        directories.push(std::path::PathBuf::from("/usr/local/bin"));
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        directories.into_iter().find_map(|directory| {
            let ffmpeg = directory.join(format!("ffmpeg{suffix}"));
            let ffprobe = directory.join(format!("ffprobe{suffix}"));
            (ffmpeg.is_file() && ffprobe.is_file()).then_some((ffmpeg, ffprobe))
        })
    }

    /// Run the real `ffmpeg` with `arguments` and then the output `path`.
    fn run_real_ffmpeg(ffmpeg: &Path, arguments: &[&str], path: &Path) {
        let status = crate::procutil::command_without_console(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(arguments)
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn the_import_probe_reads_the_exact_end_of_a_real_constant_rate_mp4() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let dir = crate::flv::test_support::TestDirectory::new();
        let path = dir.path.join("cfr.mp4");
        run_real_ffmpeg(
            &ffmpeg,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x240:r=30:d=2",
                "-c:v",
                "libx264",
                "-g",
                "30",
                "-video_track_timescale",
                "15360",
            ],
            &path,
        );
        let probe = probe_media(&ffprobe, &path).unwrap();
        assert_eq!(probe.video_time_base, Rational::new(1, 15360).unwrap());
        assert_eq!(probe.rotation, 0);
        assert_eq!(probe.sample_aspect_ratio, Rational::new(1, 1));
        let start = probe.video_start_pts.unwrap().value();
        let end = probe.video_end_pts.unwrap().value();
        assert_eq!(end - start, 2 * 15360);
        // The re-probe of an export reads no end.
        let cancel = AtomicBool::new(false);
        let reprobe = probe_media_until_canceled(&ffprobe, &path, &cancel).unwrap();
        assert_eq!(reprobe.video_end_pts, None);
    }

    #[test]
    fn the_import_probe_seeks_to_the_tail_of_a_real_transport_stream_with_an_offset() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        // 32 s at 25 fps with B-frames, from 1000 s: 800 frames of 3600 ticks of 1/90000. The
        // read starts at about 1023 s, so it runs the seek, the container start and the margin.
        let dir = crate::flv::test_support::TestDirectory::new();
        let path = dir.path.join("offset.ts");
        run_real_ffmpeg(
            &ffmpeg,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=160x120:r=25:d=32",
                "-c:v",
                "libx264",
                "-bf",
                "3",
                "-g",
                "50",
                "-output_ts_offset",
                "1000",
                "-f",
                "mpegts",
            ],
            &path,
        );
        let probe = probe_media(&ffprobe, &path).unwrap();
        assert_eq!(probe.video_time_base, Rational::new(1, 90000).unwrap());
        let start = probe.video_start_pts.unwrap().value();
        assert!(start > 1000 * 90000, "{start}");
        let end = probe.video_end_pts.unwrap().value();
        assert_eq!(end - start, 800 * 3600);

        // An approximate duration 40 s too long starts the read past the end, where the TS
        // answers a part of the tail without a keyframe. The read from the start gives the
        // same end.
        let mut long = probe.clone();
        long.approximate_duration_seconds = probe.approximate_duration_seconds.map(|d| d + 40.0);
        assert_eq!(probe_video_end(&ffprobe, &path, &long), Some(Pts::new(end)));
        // Without a container start, the exact start of the video places the read.
        let mut without_start = probe.clone();
        without_start.format_start_time = None;
        assert_eq!(
            probe_video_end(&ffprobe, &path, &without_start),
            Some(Pts::new(end))
        );
    }

    fn parse_value(value: Value) -> Result<MediaProbe, ProbeParseError> {
        parse_probe_json(&serde_json::to_vec(&value).unwrap())
    }

    fn base_probe() -> Value {
        serde_json::json!({
            "streams": [{
                "index": 2,
                "codec_type": "video",
                "codec_name": "h264",
                "profile": "High",
                "pix_fmt": "yuv420p",
                "bits_per_raw_sample": "8",
                "width": 1920,
                "height": 1080,
                "time_base": "1/90000",
                "start_pts": "-1800",
                "duration_ts": "900000",
                "duration": "10.01",
                "avg_frame_rate": "30000/1001",
                "r_frame_rate": "30/1",
                "nb_frames": "N/A",
                "disposition": {"default": 1, "attached_pic": 0}
            }],
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "format_long_name": "QuickTime / MOV",
                "duration": "10.02"
            }
        })
    }

    #[test]
    fn runs_in_order_answer_in_the_order_of_the_jobs_and_run_as_many_as_the_workers() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Barrier;
        let jobs: Vec<usize> = (0..64).collect();
        let working = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        // The first eight jobs wait for each other, so they can only finish when eight run at
        // the same time. The bound below then shows that no more than eight ever do.
        let first_eight = Barrier::new(8);
        let answers = run_in_order(&jobs, 8, &AtomicBool::new(false), |job| {
            let now = working.fetch_add(1, Ordering::SeqCst) + 1;
            most.fetch_max(now, Ordering::SeqCst);
            if *job < 8 {
                first_eight.wait();
            }
            working.fetch_sub(1, Ordering::SeqCst);
            Ok::<usize, ()>(job * 10)
        });
        let answers: Vec<usize> = answers.into_iter().map(|a| a.unwrap().unwrap()).collect();
        assert_eq!(answers, (0..64).map(|job| job * 10).collect::<Vec<_>>());
        assert_eq!(most.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn runs_in_order_start_nothing_new_after_a_failure_or_a_cancel() {
        use std::sync::atomic::AtomicUsize;
        let jobs: Vec<usize> = (0..200).collect();
        let started = AtomicUsize::new(0);
        let answers = run_in_order(&jobs, 1, &AtomicBool::new(false), |job| {
            started.fetch_add(1, Ordering::SeqCst);
            if *job == 3 {
                Err("failed")
            } else {
                Ok(*job)
            }
        });
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(answers[3], Some(Err("failed")));
        assert!(answers[4..].iter().all(Option::is_none));

        let canceled = AtomicBool::new(true);
        let answers = run_in_order(&jobs, 8, &canceled, |job| Ok::<usize, ()>(*job));
        assert!(answers.iter().all(Option::is_none));

        let none: Vec<usize> = Vec::new();
        assert!(
            run_in_order(&none, 8, &AtomicBool::new(false), |job| Ok::<usize, ()>(
                *job
            ))
            .is_empty()
        );
    }

    #[test]
    fn a_run_that_panics_stops_the_others_and_reaches_the_caller() {
        use std::sync::atomic::AtomicUsize;
        let jobs: Vec<usize> = (0..200).collect();
        let started = AtomicUsize::new(0);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_in_order(&jobs, 1, &AtomicBool::new(false), |job| {
                started.fetch_add(1, Ordering::SeqCst);
                assert!(*job != 2, "the operating system refused a thread");
                Ok::<usize, ()>(*job)
            })
        }));
        assert!(outcome.is_err());
        assert_eq!(started.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn the_answers_of_the_slices_join_in_order_and_the_first_failure_wins() {
        let ok = |text: &str| Some(Ok(text.as_bytes().to_vec()));
        let failed = || {
            Some(Err(ProbeError::ProcessFailed {
                code: Some(1),
                stderr: Vec::new(),
            }))
        };
        // An answer that ends its line, or holds nothing, adds no empty line.
        assert_eq!(
            join_slice_answers(vec![ok("1,2"), ok("3,4\n"), ok("")]).unwrap(),
            b"1,2\n3,4\n"
        );
        // A run skipped before the failure does not hide it.
        assert!(matches!(
            join_slice_answers(vec![ok("1,2"), None, failed(), None]),
            Err(ProbeError::ProcessFailed { .. })
        ));
        assert!(matches!(
            join_slice_answers(vec![failed(), ok("1,2")]),
            Err(ProbeError::ProcessFailed { .. })
        ));
        // Skipped runs and no failure: only a cancel skips a run then.
        assert!(matches!(
            join_slice_answers(vec![ok("1,2"), None]),
            Err(ProbeError::Canceled)
        ));
        assert_eq!(join_slice_answers(Vec::new()).unwrap(), b"");
    }
}
