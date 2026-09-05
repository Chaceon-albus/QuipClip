//! ffprobe execution and normalization for imported media.

use crate::time::{FrameCount, Pts, Rational, TickCount};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

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
    pub approximate_duration_seconds: Option<f64>,
    pub avg_frame_rate: Option<Rational>,
    pub r_frame_rate: Option<Rational>,
    pub reported_frame_count: Option<FrameCount>,
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
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
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
    MissingField { field: &'static str },
    InvalidInteger { field: &'static str, value: String },
    InvalidTimeBase { value: String },
    InvalidDimensions { width: i128, height: i128 },
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
        }
    }
}

impl Error for ProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn { source } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::ProcessFailed { .. } => None,
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

/// Run the resolved ffprobe executable and normalize its JSON output.
pub fn probe_media(ffprobe_path: &Path, media_path: &Path) -> Result<MediaProbe, ProbeError> {
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-of",
            "json",
            "-show_format",
            "-show_streams",
            "-i",
        ])
        .arg(media_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|source| ProbeError::Spawn { source })?;
    if !output.status.success() {
        return Err(ProbeError::ProcessFailed {
            code: output.status.code(),
            stderr: output.stderr,
        });
    }
    parse_probe_json(&output.stdout).map_err(|source| ProbeError::Parse {
        source,
        stderr: output.stderr,
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
    #[serde(default)]
    disposition: RawDisposition,
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

    Ok(MediaProbe {
        format_names: format_name
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
        format_long_name: format.and_then(|value| value.format_long_name.clone()),
        format_start_time: parse_format_start_time(
            format.and_then(|value| value.start_time.as_deref()),
        ),
        video_codec,
        video_profile: video.profile.clone(),
        pixel_format: video.pix_fmt.clone(),
        bit_depth: parse_bit_depth(video)?,
        width: width as u32,
        height: height as u32,
        video_stream_index,
        video_time_base,
        video_start_pts: parse_optional_i64_value(
            video.start_pts.as_ref(),
            "streams.video.start_pts",
        )?
        .map(Pts::new),
        video_duration_ticks: parse_optional_i64_value(
            video.duration_ts.as_ref(),
            "streams.video.duration_ts",
        )?
        .and_then(TickCount::new),
        approximate_duration_seconds: approximate_duration(
            video.duration.as_deref(),
            format.and_then(|value| value.duration.as_deref()),
        ),
        avg_frame_rate: optional_positive_rational(video.avg_frame_rate.as_deref()),
        r_frame_rate: optional_positive_rational(video.r_frame_rate.as_deref()),
        reported_frame_count: parse_optional_text_i64(
            video.nb_frames.as_deref(),
            "streams.video.nb_frames",
        )?
        .and_then(FrameCount::new),
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
    })
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

fn approximate_duration(stream: Option<&str>, format: Option<&str>) -> Option<f64> {
    stream
        .into_iter()
        .chain(format)
        .filter_map(|text| text.trim().parse::<f64>().ok())
        .find(|value| value.is_finite() && *value >= 0.0)
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
        assert_eq!(
            parse_value(value).unwrap().approximate_duration_seconds,
            Some(10.02)
        );
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
}
