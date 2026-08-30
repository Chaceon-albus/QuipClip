//! ffprobe execution and normalization for imported media.

use crate::time::Rational;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Normalized media facts needed by the editor and later capability checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub format_names: Vec<String>,
    pub format_long_name: Option<String>,
    pub video_codec: String,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    pub bit_depth: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub avg_frame_rate: Rational,
    pub r_frame_rate: Rational,
    pub start_time: Rational,
    pub duration: Option<Rational>,
    pub frame_count: i64,
    pub audio: Option<AudioProbe>,
    pub is_vfr: bool,
}

/// Basic facts about the first audio stream, when one exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
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

/// Invalid or incomplete ffprobe data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeDataError {
    MissingVideo,
    MissingField { field: &'static str },
    InvalidFrameRate { field: &'static str, value: String },
    InvalidDecimal { field: &'static str, value: String },
    InvalidInteger { field: &'static str, value: String },
    UnsafeInteger { field: &'static str, value: i128 },
    InvalidDimensions { width: i128, height: i128 },
    MissingDuration,
    FrameCountOverflow,
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
            Self::InvalidFrameRate { field, value } => {
                write!(formatter, "{field} is not a positive frame rate: {value}")
            }
            Self::InvalidDecimal { field, value } => {
                write!(formatter, "{field} is not a valid decimal: {value}")
            }
            Self::InvalidInteger { field, value } => {
                write!(formatter, "{field} is not a valid integer: {value}")
            }
            Self::UnsafeInteger { field, value } => {
                write!(
                    formatter,
                    "{field} is outside the safe integer range: {value}"
                )
            }
            Self::InvalidDimensions { width, height } => {
                write!(formatter, "video dimensions are invalid: {width}x{height}")
            }
            Self::MissingDuration => {
                write!(
                    formatter,
                    "duration is required when frame count is unavailable"
                )
            }
            Self::FrameCountOverflow => write!(formatter, "derived frame count overflowed"),
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
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    pix_fmt: Option<String>,
    bits_per_raw_sample: Option<String>,
    bits_per_sample: Option<Value>,
    width: Option<Value>,
    height: Option<Value>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
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
    start_time: Option<String>,
    duration: Option<String>,
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
    let format_names = format_name
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    let video_codec =
        required_text(video.codec_name.as_deref(), "streams.video.codec_name")?.to_owned();
    let width_value = required_json_integer(video.width.as_ref(), "streams.video.width")?;
    let height_value = required_json_integer(video.height.as_ref(), "streams.video.height")?;
    if width_value <= 0
        || height_value <= 0
        || width_value > i128::from(u32::MAX)
        || height_value > i128::from(u32::MAX)
    {
        return Err(ProbeDataError::InvalidDimensions {
            width: width_value,
            height: height_value,
        });
    }

    let avg_frame_rate = parse_frame_rate(
        required_text(
            video.avg_frame_rate.as_deref(),
            "streams.video.avg_frame_rate",
        )?,
        "streams.video.avg_frame_rate",
    )?;
    let r_frame_rate = parse_frame_rate(
        required_text(video.r_frame_rate.as_deref(), "streams.video.r_frame_rate")?,
        "streams.video.r_frame_rate",
    )?;
    let start_time_text = available_text(video.start_time.as_deref())
        .or_else(|| available_text(format.and_then(|value| value.start_time.as_deref())));
    let start_time = parse_optional_decimal(start_time_text, "start_time")?
        .unwrap_or_else(|| Rational::new(0, 1).expect("zero is a valid rational"));
    let duration_text = available_text(video.duration.as_deref())
        .or_else(|| available_text(format.and_then(|value| value.duration.as_deref())));
    let duration = parse_optional_decimal(duration_text, "duration")?;
    if duration.is_some_and(|value| value.num() < 0) {
        return Err(ProbeDataError::InvalidDecimal {
            field: "duration",
            value: duration_text.unwrap_or_default().to_owned(),
        });
    }

    let frame_count =
        match parse_optional_text_integer(video.nb_frames.as_deref(), "streams.video.nb_frames")? {
            Some(value) if value >= 0 => value,
            Some(value) => {
                return Err(ProbeDataError::InvalidInteger {
                    field: "streams.video.nb_frames",
                    value: value.to_string(),
                })
            }
            None => avg_frame_rate
                .frame_count_for_duration(duration.ok_or(ProbeDataError::MissingDuration)?)
                .ok_or(ProbeDataError::FrameCountOverflow)?,
        };
    ensure_safe_integer("frame_count", i128::from(frame_count))?;

    Ok(MediaProbe {
        format_names,
        format_long_name: format.and_then(|value| value.format_long_name.clone()),
        video_codec,
        video_profile: video.profile.clone(),
        pixel_format: video.pix_fmt.clone(),
        bit_depth: parse_bit_depth(video)?,
        width: width_value as u32,
        height: height_value as u32,
        avg_frame_rate,
        r_frame_rate,
        start_time,
        duration,
        frame_count,
        audio: audio.map(normalize_audio).transpose()?,
        is_vfr: avg_frame_rate != r_frame_rate,
    })
}

fn normalize_audio(raw: &RawStream) -> Result<AudioProbe, ProbeDataError> {
    let sample_rate =
        parse_optional_text_integer(raw.sample_rate.as_deref(), "streams.audio.sample_rate")?
            .map(|value| optional_positive_u32("streams.audio.sample_rate", i128::from(value)))
            .transpose()?
            .flatten();
    let channels = raw
        .channels
        .as_ref()
        .map(|value| json_integer(value, "streams.audio.channels"))
        .transpose()?;
    let channels = channels
        .map(|value| optional_positive_u32("streams.audio.channels", value))
        .transpose()?
        .flatten();
    Ok(AudioProbe {
        codec: raw.codec_name.clone(),
        sample_rate,
        channels,
    })
}

fn parse_bit_depth(video: &RawStream) -> Result<Option<u32>, ProbeDataError> {
    if let Some(value) = parse_optional_text_integer(
        video.bits_per_raw_sample.as_deref(),
        "streams.video.bits_per_raw_sample",
    )? {
        if value != 0 {
            return positive_u32("streams.video.bits_per_raw_sample", i128::from(value)).map(Some);
        }
    }
    if let Some(value) = video.bits_per_sample.as_ref() {
        let value = json_integer(value, "streams.video.bits_per_sample")?;
        if value != 0 {
            return positive_u32("streams.video.bits_per_sample", value).map(Some);
        }
    }
    Ok(video.pix_fmt.as_deref().and_then(infer_pixel_bit_depth))
}

fn preferred_stream<'a>(
    streams: &'a [RawStream],
    codec_type: &str,
    eligible: impl Fn(&RawStream) -> bool,
) -> Option<&'a RawStream> {
    streams
        .iter()
        .find(|stream| {
            stream.codec_type.as_deref() == Some(codec_type)
                && eligible(stream)
                && stream.disposition.default != 0
        })
        .or_else(|| {
            streams
                .iter()
                .find(|stream| stream.codec_type.as_deref() == Some(codec_type) && eligible(stream))
        })
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

fn parse_frame_rate(value: &str, field: &'static str) -> Result<Rational, ProbeDataError> {
    let rate = Rational::from_ffprobe(value).ok_or_else(|| ProbeDataError::InvalidFrameRate {
        field,
        value: value.to_owned(),
    })?;
    if rate.num() <= 0 || !rational_is_javascript_safe(rate) {
        return Err(ProbeDataError::InvalidFrameRate {
            field,
            value: value.to_owned(),
        });
    }
    Ok(rate)
}

fn parse_optional_decimal(
    value: Option<&str>,
    field: &'static str,
) -> Result<Option<Rational>, ProbeDataError> {
    let Some(value) = value.filter(|value| !is_unavailable(value)) else {
        return Ok(None);
    };
    let rational =
        Rational::from_decimal_str(value).ok_or_else(|| ProbeDataError::InvalidDecimal {
            field,
            value: value.to_owned(),
        })?;
    if !rational_is_javascript_safe(rational) {
        return Err(ProbeDataError::InvalidDecimal {
            field,
            value: value.to_owned(),
        });
    }
    Ok(Some(rational))
}

fn parse_optional_text_integer(
    value: Option<&str>,
    field: &'static str,
) -> Result<Option<i64>, ProbeDataError> {
    let Some(value) = value.filter(|value| !is_unavailable(value)) else {
        return Ok(None);
    };
    let parsed = value
        .parse::<i128>()
        .map_err(|_| ProbeDataError::InvalidInteger {
            field,
            value: value.to_owned(),
        })?;
    ensure_safe_integer(field, parsed)?;
    i64::try_from(parsed)
        .map(Some)
        .map_err(|_| ProbeDataError::UnsafeInteger {
            field,
            value: parsed,
        })
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
    let text = value.as_number().map(ToString::to_string).ok_or_else(|| {
        ProbeDataError::InvalidInteger {
            field,
            value: value.to_string(),
        }
    })?;
    let parsed = text
        .parse::<i128>()
        .map_err(|_| ProbeDataError::InvalidInteger { field, value: text })?;
    ensure_safe_integer(field, parsed)?;
    Ok(parsed)
}

fn ensure_safe_integer(field: &'static str, value: i128) -> Result<(), ProbeDataError> {
    if !(-i128::from(JAVASCRIPT_MAX_SAFE_INTEGER)..=i128::from(JAVASCRIPT_MAX_SAFE_INTEGER))
        .contains(&value)
    {
        return Err(ProbeDataError::UnsafeInteger { field, value });
    }
    Ok(())
}

fn positive_u32(field: &'static str, value: i128) -> Result<u32, ProbeDataError> {
    if value <= 0 || value > i128::from(u32::MAX) {
        return Err(ProbeDataError::InvalidInteger {
            field,
            value: value.to_string(),
        });
    }
    Ok(value as u32)
}

fn optional_positive_u32(field: &'static str, value: i128) -> Result<Option<u32>, ProbeDataError> {
    if value == 0 {
        Ok(None)
    } else {
        positive_u32(field, value).map(Some)
    }
}

fn required_text<'a>(
    value: Option<&'a str>,
    field: &'static str,
) -> Result<&'a str, ProbeDataError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or(ProbeDataError::MissingField { field })
}

fn rational_is_javascript_safe(value: Rational) -> bool {
    value.num().unsigned_abs() <= JAVASCRIPT_MAX_SAFE_INTEGER as u64
        && value.den() <= JAVASCRIPT_MAX_SAFE_INTEGER
}

fn available_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !is_unavailable(value))
}

fn is_unavailable(value: &str) -> bool {
    value.trim().is_empty() || value.trim().eq_ignore_ascii_case("N/A")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn parses_ntsc_cfr_with_audio() {
        let probe = parse_value(base_probe()).unwrap();

        assert_eq!(probe.format_names, ["mov", "mp4"]);
        assert_eq!(probe.video_codec, "h264");
        assert_eq!(probe.bit_depth, Some(10));
        assert_eq!(probe.avg_frame_rate, Rational::new(30000, 1001).unwrap());
        assert_eq!(probe.r_frame_rate, Rational::new(30000, 1001).unwrap());
        assert_eq!(probe.frame_count, 300);
        assert!(!probe.is_vfr);
        assert_eq!(
            probe.audio,
            Some(AudioProbe {
                codec: Some("aac".to_owned()),
                sample_rate: Some(48000),
                channels: Some(2),
            })
        );
    }

    #[test]
    fn serializes_the_normalized_result_with_camel_case_and_rational_wires() {
        let serialized = serde_json::to_value(parse_value(base_probe()).unwrap()).unwrap();

        assert_eq!(
            serialized["avgFrameRate"],
            serde_json::json!({ "n": 30000, "d": 1001 })
        );
        assert_eq!(serialized["isVfr"], false);
        assert!(serialized.get("avg_frame_rate").is_none());
    }

    #[test]
    fn detects_vfr_from_different_average_and_real_rates() {
        let mut value = base_probe();
        value["streams"][0]["r_frame_rate"] = serde_json::json!("30/1");

        assert!(parse_value(value).unwrap().is_vfr);
    }

    #[test]
    fn parses_nonzero_and_negative_start_times_exactly() {
        for (text, expected) in [
            ("1.250", Rational::new(5, 4).unwrap()),
            ("-0.125", Rational::new(-1, 8).unwrap()),
        ] {
            let mut value = base_probe();
            value["streams"][0]["start_time"] = serde_json::json!(text);
            assert_eq!(parse_value(value).unwrap().start_time, expected);
        }
    }

    #[test]
    fn unavailable_stream_times_fall_back_to_format_times() {
        let mut value = base_probe();
        value["streams"][0]["start_time"] = serde_json::json!("N/A");
        value["streams"][0]["duration"] = serde_json::json!("");
        value["format"]["start_time"] = serde_json::json!("-0.500");
        value["format"]["duration"] = serde_json::json!("2.500");

        let probe = parse_value(value).unwrap();

        assert_eq!(probe.start_time, Rational::new(-1, 2).unwrap());
        assert_eq!(probe.duration, Rational::new(5, 2));
    }

    #[test]
    fn excludes_attached_pictures_and_prefers_default_streams() {
        let mut value = base_probe();
        let mut cover = value["streams"][0].clone();
        cover["codec_name"] = serde_json::json!("mjpeg");
        cover["disposition"] = serde_json::json!({ "default": 1, "attached_pic": 1 });
        value["streams"][0]["disposition"] = serde_json::json!({ "default": 0, "attached_pic": 0 });
        let mut default_video = value["streams"][0].clone();
        default_video["codec_name"] = serde_json::json!("hevc");
        default_video["disposition"] = serde_json::json!({ "default": 1, "attached_pic": 0 });
        value["streams"][1]["disposition"] = serde_json::json!({ "default": 0 });
        let mut default_audio = value["streams"][1].clone();
        default_audio["codec_name"] = serde_json::json!("opus");
        default_audio["disposition"] = serde_json::json!({ "default": 1 });
        let streams = value["streams"].as_array_mut().unwrap();
        streams.insert(0, cover);
        streams.push(default_video);
        streams.push(default_audio);

        let probe = parse_value(value).unwrap();

        assert_eq!(probe.video_codec, "hevc");
        assert_eq!(probe.audio.unwrap().codec.as_deref(), Some("opus"));
    }

    #[test]
    fn uses_the_first_eligible_stream_when_none_is_default() {
        let mut value = base_probe();
        value["streams"][0]["disposition"] = serde_json::json!({ "default": 0 });
        value["streams"][1]["disposition"] = serde_json::json!({ "default": 0 });
        let mut second_video = value["streams"][0].clone();
        second_video["codec_name"] = serde_json::json!("hevc");
        let mut second_audio = value["streams"][1].clone();
        second_audio["codec_name"] = serde_json::json!("opus");
        let streams = value["streams"].as_array_mut().unwrap();
        streams.push(second_video);
        streams.push(second_audio);

        let probe = parse_value(value).unwrap();

        assert_eq!(probe.video_codec, "h264");
        assert_eq!(probe.audio.unwrap().codec.as_deref(), Some("aac"));
    }

    #[test]
    fn infers_component_bit_depth_from_real_pixel_formats() {
        for (pixel_format, expected) in [
            ("yuv420p10le", 10),
            ("yuv444p12be", 12),
            ("gbrp16le", 16),
            ("gray10le", 10),
            ("p010le", 10),
            ("p012be", 12),
            ("p016le", 16),
            ("yuv420p", 8),
            ("rgb24", 8),
            ("rgb48le", 16),
        ] {
            assert_eq!(infer_pixel_bit_depth(pixel_format), Some(expected));
        }
    }

    #[test]
    fn infers_ten_bit_vp9_when_numeric_depth_is_unavailable() {
        let mut value = base_probe();
        value["streams"][0]["codec_name"] = serde_json::json!("vp9");
        value["streams"][0]["profile"] = serde_json::json!("Profile 2");
        value["streams"][0]["bits_per_raw_sample"] = serde_json::json!("N/A");
        value["streams"][0]["bits_per_sample"] = serde_json::json!(0);

        assert_eq!(parse_value(value).unwrap().bit_depth, Some(10));
    }

    #[test]
    fn zero_numeric_bit_depth_falls_back_to_pixel_format() {
        let mut value = base_probe();
        value["streams"][0]["bits_per_raw_sample"] = serde_json::json!("0");
        value["streams"][0]["bits_per_sample"] = serde_json::json!(0);
        value["streams"][0]["pix_fmt"] = serde_json::json!("yuv422p12le");

        assert_eq!(parse_value(value).unwrap().bit_depth, Some(12));
    }

    #[test]
    fn zero_audio_numbers_are_unknown() {
        let mut value = base_probe();
        value["streams"][1]["sample_rate"] = serde_json::json!("0");
        value["streams"][1]["channels"] = serde_json::json!(0);

        let audio = parse_value(value).unwrap().audio.unwrap();
        assert_eq!(audio.sample_rate, None);
        assert_eq!(audio.channels, None);
    }

    #[test]
    fn explicit_frame_count_takes_precedence_over_duration() {
        let mut value = base_probe();
        value["streams"][0]["nb_frames"] = serde_json::json!("42");
        value["streams"][0]["duration"] = serde_json::json!("1000.0");

        assert_eq!(parse_value(value).unwrap().frame_count, 42);
    }

    #[test]
    fn derives_frame_count_by_ceiling_duration() {
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("nb_frames");
        value["streams"][0]["avg_frame_rate"] = serde_json::json!("25/1");
        value["streams"][0]["r_frame_rate"] = serde_json::json!("25/1");
        value["streams"][0]["duration"] = serde_json::json!("4.001");

        assert_eq!(parse_value(value).unwrap().frame_count, 101);
    }

    #[test]
    fn audio_is_optional() {
        let mut value = base_probe();
        value["streams"].as_array_mut().unwrap().truncate(1);

        assert_eq!(parse_value(value).unwrap().audio, None);
    }

    #[test]
    fn rejects_unknown_or_nonpositive_frame_rates() {
        for rate in ["0/0", "0/1", "-25/1"] {
            let mut value = base_probe();
            value["streams"][0]["avg_frame_rate"] = serde_json::json!(rate);
            assert!(matches!(
                parse_value(value),
                Err(ProbeParseError::Invalid(
                    ProbeDataError::InvalidFrameRate { .. }
                ))
            ));
        }
    }

    #[test]
    fn rejects_missing_video() {
        let mut value = base_probe();
        value["streams"].as_array_mut().unwrap().remove(0);

        assert!(matches!(
            parse_value(value),
            Err(ProbeParseError::Invalid(ProbeDataError::MissingVideo))
        ));
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(matches!(
            parse_probe_json(b"{not json"),
            Err(ProbeParseError::Json(_))
        ));
    }

    #[test]
    fn rejects_missing_duration_when_frame_count_is_unavailable() {
        let mut value = base_probe();
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("nb_frames");
        value["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("duration");
        value["format"].as_object_mut().unwrap().remove("duration");

        assert!(matches!(
            parse_value(value),
            Err(ProbeParseError::Invalid(ProbeDataError::MissingDuration))
        ));
    }

    #[test]
    fn rejects_unsafe_or_invalid_integers() {
        let mut unsafe_frames = base_probe();
        unsafe_frames["streams"][0]["nb_frames"] = serde_json::json!("9007199254740992");
        assert!(matches!(
            parse_value(unsafe_frames),
            Err(ProbeParseError::Invalid(
                ProbeDataError::UnsafeInteger { .. }
            ))
        ));

        let mut invalid_dimensions = base_probe();
        invalid_dimensions["streams"][0]["width"] = serde_json::json!(0);
        assert!(matches!(
            parse_value(invalid_dimensions),
            Err(ProbeParseError::Invalid(
                ProbeDataError::InvalidDimensions { .. }
            ))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reports_process_failure_with_unchanged_stderr() {
        let directory = TestDirectory::new();
        let executable = create_fake_ffprobe(
            &directory.path,
            "failure-ffprobe",
            "",
            "exact diagnostic",
            23,
            false,
        );
        let error = probe_media(&executable, Path::new("unused-media-path")).unwrap_err();

        assert!(matches!(
            error,
            ProbeError::ProcessFailed {
                code: Some(23),
                stderr
            } if stderr == b"exact diagnostic"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn successful_process_uses_exact_arguments_one_input_and_closed_stdin() {
        let directory = TestDirectory::new();
        let stdout = serde_json::to_string(&base_probe()).unwrap();
        let executable =
            create_fake_ffprobe(&directory.path, "success-ffprobe", &stdout, "", 0, true);

        let probe = probe_media(&executable, Path::new("-leading-input.mp4")).unwrap();

        assert_eq!(probe.video_codec, "h264");
        assert_eq!(probe.frame_count, 300);
    }

    #[cfg(unix)]
    #[test]
    fn successful_process_with_bad_json_preserves_raw_stderr() {
        let directory = TestDirectory::new();
        let executable = create_fake_ffprobe(
            &directory.path,
            "bad-json-ffprobe",
            "not json",
            "parser diagnostic",
            0,
            true,
        );

        let error = probe_media(&executable, Path::new("-leading-input.mp4")).unwrap_err();

        assert!(matches!(
            error,
            ProbeError::Parse {
                source: ProbeParseError::Json(_),
                stderr
            } if stderr == b"parser diagnostic"
        ));
    }

    #[cfg(not(unix))]
    #[test]
    fn reports_process_failure() {
        let executable = std::env::current_exe().unwrap();
        let error = probe_media(&executable, Path::new("unused-media-path")).unwrap_err();

        match error {
            ProbeError::ProcessFailed { stderr, .. } => assert!(!stderr.is_empty()),
            other => panic!("expected process failure, got {other:?}"),
        }
    }

    fn parse_value(value: Value) -> Result<MediaProbe, ProbeParseError> {
        parse_probe_json(&serde_json::to_vec(&value).unwrap())
    }

    fn base_probe() -> Value {
        serde_json::json!({
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "profile": "High 10",
                    "pix_fmt": "yuv420p10le",
                    "bits_per_raw_sample": "10",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30000/1001",
                    "r_frame_rate": "30000/1001",
                    "start_time": "0.000000",
                    "duration": "10.010000",
                    "nb_frames": "300",
                    "disposition": { "default": 1, "attached_pic": 0 }
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 2,
                    "disposition": { "default": 1, "attached_pic": 0 }
                }
            ],
            "format": {
                "format_name": "mov,mp4",
                "format_long_name": "QuickTime / MOV",
                "start_time": "0.000000",
                "duration": "10.010000"
            }
        })
    }

    #[cfg(unix)]
    fn create_fake_ffprobe(
        directory: &Path,
        name: &str,
        stdout: &str,
        stderr: &str,
        exit_code: i32,
        verify_invocation: bool,
    ) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        assert!(!stdout.contains('\''));
        assert!(!stderr.contains('\''));
        let executable = directory.join(name);
        let mut script = String::from("#!/bin/sh\n");
        if verify_invocation {
            script.push_str(
                r#"[ "$#" -eq 8 ] || { printf 'wrong argc' >&2; exit 90; }
[ "$1" = '-v' ] || { printf 'wrong arg 1' >&2; exit 91; }
[ "$2" = 'error' ] || { printf 'wrong arg 2' >&2; exit 92; }
[ "$3" = '-of' ] || { printf 'wrong arg 3' >&2; exit 93; }
[ "$4" = 'json' ] || { printf 'wrong arg 4' >&2; exit 94; }
[ "$5" = '-show_format' ] || { printf 'wrong arg 5' >&2; exit 95; }
[ "$6" = '-show_streams' ] || { printf 'wrong arg 6' >&2; exit 96; }
[ "$7" = '-i' ] || { printf 'wrong arg 7' >&2; exit 97; }
[ "$8" = '-leading-input.mp4' ] || { printf 'wrong input' >&2; exit 98; }
if IFS= read -r line; then printf 'stdin was open' >&2; exit 99; fi
"#,
            );
        }
        script.push_str(&format!("printf '%s' '{stdout}'\n"));
        script.push_str(&format!("printf '%s' '{stderr}' >&2\n"));
        script.push_str(&format!("exit {exit_code}\n"));
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        executable
    }

    #[cfg(unix)]
    struct TestDirectory {
        path: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-ffprobe-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("could not create test directory: {error}"),
                }
            }
            panic!("could not create a unique test directory")
        }
    }

    #[cfg(unix)]
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
