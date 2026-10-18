//! The commands of the preview remux windows (ADR 046).
//!
//! The page asks for a window at the start of a source, at a time, or at the keyframe where the
//! previous window stopped. The command checks that the page may read the file and that the file
//! did not change, finds the keyframe, starts the processes, and returns at once. The output
//! goes to the page through the channels of the request, and the page acknowledges it piece by
//! piece (`ack_preview_window`).

use crate::commands::media::validate_media;
use crate::ffmpeg::preview::arguments::{
    flv_pcm_arguments, flv_remux_arguments, seek_pcm_arguments, seek_remux_arguments, AudioMode,
    SeekContainer,
};
use crate::ffmpeg::preview::registry::{Lane, PreviewWindows, Ticket, WindowHandle};
use crate::ffmpeg::preview::stream::{
    start_flv_window, start_seek_window, EndMessage, FlvSlice, WindowSink,
};
use crate::ffmpeg::{self, SEEK_MARGIN_SECONDS};
use crate::flv::cache::Revision;
use crate::flv::locate::LocateMethod;
use crate::flv::{self as flv_reader, FlvError};
use crate::settings;
use crate::time::Rational;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// The media time that a video window covers.
pub const WINDOW_MS: i64 = 60_000;
/// The source bytes after which an FLV window stops at the next keyframe.
pub const WINDOW_BYTES: u64 = 64 * 1024 * 1024;
/// The media time of a PCM window of the audio lane.
pub const PCM_WINDOW_SECONDS: f64 = 20.0;

/// Where a window starts.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowStart {
    /// The first frame of the file.
    FileStart,
    /// The keyframe at or before an absolute source time in seconds.
    #[serde(rename_all = "camelCase")]
    Time { seconds: f64 },
    /// The keyframe tag where the previous FLV window stopped.
    #[serde(rename_all = "camelCase")]
    Resume { offset: u64, pts_ms: i64 },
}

/// The container of the source, from the probe of the page. An FLV is checked by its signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerHint {
    Flv,
    MpegTs,
    Matroska,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPreviewWindowRequest {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub lane: Lane,
    /// A number that the page raises with each request of the lane: microseconds since the Unix
    /// epoch, or one more than its last number when that is higher. A request that arrives after
    /// one with a higher number is refused, whatever the order of their threads, and a reload of
    /// the page sets a floor at its own time (see `PreviewWindows::cancel_all`).
    pub sequence: u64,
    pub container: ContainerHint,
    pub start: WindowStart,
    /// The container start time of the probe, for the `-ss` of the seek form (ADR 014
    /// measurement 8).
    #[serde(default)]
    pub format_start_time: Option<Rational>,
    /// The seek margin of the seek form. The page doubles it when a seek landed after its
    /// target. Without it, the window uses `SEEK_MARGIN_SECONDS` of ADR 014.
    #[serde(default)]
    pub margin_seconds: Option<f64>,
    pub audio: AudioMode,
    /// The codec name of the audio stream from the probe, so a copied MPEG-TS stream takes the
    /// ADTS filter only when it is AAC.
    #[serde(default)]
    pub audio_codec: Option<String>,
    /// On FLV, also decode the audio of the window to PCM for the scrub cue, into the second
    /// channel.
    #[serde(default)]
    pub pcm: bool,
    /// Scan for decoder configurations before the window, after a window failed to decode.
    #[serde(default)]
    pub rescan_config: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPreviewWindowResult {
    pub window_id: u64,
    /// How the FLV locator found the keyframe.
    pub method: Option<&'static str>,
    /// True when the FLV reader knows that the timestamps of the file decrease.
    pub non_monotonic: bool,
    /// The presentation time of the first keyframe of an FLV window, for the self-check of
    /// the calibration.
    pub first_keyframe_pts_ms: Option<i64>,
    /// The absolute source time of sample 0 of the PCM of the window, when it has PCM.
    pub pcm_start_seconds: Option<f64>,
    /// The input seek of a seek-form window.
    pub seek_seconds: Option<f64>,
}

/// Stable error names translated by the frontend (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewWindowErrorCode {
    InvalidRequest,
    SourceUnreadable,
    SourceChanged,
    SourceNotAllowed,
    AppDataUnavailable,
    FfmpegNotFound,
    NotFlv,
    NoKeyframe,
    ReadFailed,
    SpawnFailed,
    /// A newer request took the lane before this one started its processes.
    Superseded,
    CommandExecutionFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWindowError {
    pub code: PreviewWindowErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn error(code: PreviewWindowErrorCode) -> PreviewWindowError {
    PreviewWindowError { code, detail: None }
}

fn error_with(code: PreviewWindowErrorCode, detail: impl ToString) -> PreviewWindowError {
    PreviewWindowError {
        code,
        detail: Some(detail.to_string()),
    }
}

fn map_flv(failure: FlvError) -> PreviewWindowError {
    match failure {
        FlvError::Canceled => error(PreviewWindowErrorCode::Superseded),
        FlvError::NotFlv | FlvError::NoMediaTags => error(PreviewWindowErrorCode::NotFlv),
        FlvError::NoKeyframe => error(PreviewWindowErrorCode::NoKeyframe),
        FlvError::Io(io) => error_with(PreviewWindowErrorCode::ReadFailed, io),
    }
}

fn method_name(method: LocateMethod) -> &'static str {
    match method {
        LocateMethod::Start => "start",
        LocateMethod::Index => "index",
        LocateMethod::Table => "table",
        LocateMethod::Bisection => "bisection",
        LocateMethod::Sequential => "sequential",
    }
}

/// The target of a locate in milliseconds: the time rounded down after 1 µs more, so a time that
/// a float holds a little below a whole millisecond still names that millisecond (ADR 046).
fn target_ms(seconds: f64) -> i64 {
    (seconds * 1000.0 + 0.001).floor() as i64
}

/// The input seek of the seek form: the target less the container start and the margin, or
/// `None` at or before the start of the file.
fn seek_of(target_seconds: f64, format_start: f64, margin: f64) -> Option<f64> {
    Some(target_seconds - format_start - margin).filter(|seek| *seek > 0.0)
}

/// The page side of a window: a Tauri channel. A piece of output goes as raw bytes, and the end
/// message as JSON, so the page tells them apart by type.
struct ChannelSink(Channel<InvokeResponseBody>);

impl WindowSink for ChannelSink {
    fn chunk(&self, bytes: Vec<u8>) -> bool {
        self.0.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }

    fn end(&self, message: &EndMessage) {
        if let Ok(json) = serde_json::to_string(message) {
            let _ = self.0.send(InvokeResponseBody::Json(json));
        }
    }
}

/// Start a remux window for a source that the page plays through a MediaSource. The PCM of an FLV
/// window goes into `audio_channel`. A Tauri command cannot take an optional channel, so the page
/// passes one in every request, and a request without PCM leaves it unused.
#[tauri::command]
pub async fn open_preview_window(
    app: AppHandle,
    windows: State<'_, Arc<PreviewWindows>>,
    request: OpenPreviewWindowRequest,
    channel: Channel<InvokeResponseBody>,
    audio_channel: Channel<InvokeResponseBody>,
) -> Result<OpenPreviewWindowResult, PreviewWindowError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| error(PreviewWindowErrorCode::AppDataUnavailable))?;
    let windows = windows.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let allowed = |path: &Path| app.asset_protocol_scope().is_allowed(path);
        open_window(
            &windows,
            &app_data,
            &request,
            &allowed,
            Arc::new(ChannelSink(channel)),
            Some(Arc::new(ChannelSink(audio_channel)) as Arc<dyn WindowSink>),
        )
    })
    .await
    .map_err(|failure| error_with(PreviewWindowErrorCode::CommandExecutionFailed, failure))?
}

/// Count `bytes` of the fMP4 of window `window_id` as appended by the page. The PCM of an FLV
/// window has no credit, so the page does not acknowledge it. The PCM window of the audio lane
/// has its own id and credit, and the page acknowledges it on receipt. The command runs off the
/// main thread, as `close_preview_window` does.
#[tauri::command(async)]
pub fn ack_preview_window(windows: State<'_, Arc<PreviewWindows>>, window_id: u64, bytes: u64) {
    windows.acknowledge(window_id, bytes);
}

/// Stop window `window_id`. A newer window of the same lane keeps running. The kill waits for
/// the process, so the command runs off the main thread.
#[tauri::command(async)]
pub fn close_preview_window(windows: State<'_, Arc<PreviewWindows>>, window_id: u64) {
    windows.close(window_id);
}

/// The body of [`open_preview_window`], with the asset scope check passed in.
fn open_window(
    windows: &Arc<PreviewWindows>,
    app_data: &Path,
    request: &OpenPreviewWindowRequest,
    allowed: &dyn Fn(&Path) -> bool,
    sink: Arc<dyn WindowSink>,
    pcm_sink: Option<Arc<dyn WindowSink>>,
) -> Result<OpenPreviewWindowResult, PreviewWindowError> {
    check_request(request)?;
    let media = validate_media(&request.path).map_err(|failure| {
        let code = serde_json::to_value(failure.code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        error_with(PreviewWindowErrorCode::SourceUnreadable, code)
    })?;
    // The same grant as the asset protocol: the page may read only a file that the user opened.
    // The check comes first, so the answer says nothing about a file that the page may not read.
    if !allowed(&media.path) {
        return Err(error(PreviewWindowErrorCode::SourceNotAllowed));
    }
    if media.size != request.size || media.mtime != request.mtime {
        return Err(error(PreviewWindowErrorCode::SourceChanged));
    }

    let ticket = windows
        .begin(request.lane, request.sequence)
        .ok_or_else(|| error(PreviewWindowErrorCode::Superseded))?;
    let ffmpeg = windows
        .ffmpeg(settings::configured_ffmpeg_path(app_data), |configured| {
            ffmpeg::discover(configured, app_data)
                .ok()
                .map(|paths| paths.ffmpeg)
        })
        .ok_or_else(|| error(PreviewWindowErrorCode::FfmpegNotFound))?;
    // The window has its own cancel flag. The flag of the ticket stops the locate of this request
    // when a newer one arrives, and it must not stop a window that its lane already released.
    let handle = Arc::new(WindowHandle::new(
        windows.next_window_id(),
        request.lane,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    ));

    match request.container {
        ContainerHint::Flv => {
            let revision = Revision {
                path: media.path_text.clone(),
                size: media.size,
                mtime: media.mtime,
            };
            open_flv(
                windows,
                app_data,
                request,
                &media.path,
                revision,
                &ffmpeg,
                ticket,
                handle,
                sink,
                pcm_sink,
            )
        }
        ContainerHint::MpegTs | ContainerHint::Matroska => {
            open_seek(windows, request, &media.path, &ffmpeg, ticket, handle, sink)
        }
    }
}

fn check_request(request: &OpenPreviewWindowRequest) -> Result<(), PreviewWindowError> {
    let finite = match request.start {
        WindowStart::Time { seconds } => seconds.is_finite(),
        _ => true,
    };
    let margin = request
        .margin_seconds
        .is_none_or(|margin| margin.is_finite() && (0.0..=600.0).contains(&margin));
    let resume_on_flv = !matches!(request.start, WindowStart::Resume { .. })
        || request.container == ContainerHint::Flv;
    let pcm_lane = request.lane == Lane::Video || request.container != ContainerHint::Flv;
    if finite && margin && resume_on_flv && pcm_lane {
        Ok(())
    } else {
        Err(error(PreviewWindowErrorCode::InvalidRequest))
    }
}

/// The keyframe where an FLV window starts, as (offset, decode time, first keyframe
/// presentation time, method, timestamps decrease).
fn flv_start(
    source: &flv_reader::FlvSource,
    start: WindowStart,
    ticket: &Ticket,
) -> Result<(u64, i64, i64, &'static str, bool), FlvError> {
    let cancel = Some(ticket.cancel.clone());
    match start {
        WindowStart::FileStart => {
            // The window starts at the first frame, a keyframe or not: FFmpeg drops the frames
            // before the first keyframe, and the page reads that keyframe for its self-check.
            let offset = source.head().first_frame_offset;
            let first = source.tag_at(offset)?.ok_or(FlvError::NoMediaTags)?;
            let (located, _) = source.locate(i64::MIN, cancel)?;
            Ok((
                offset,
                first.dts(),
                located.keyframe.pts,
                "fileStart",
                located.non_monotonic,
            ))
        }
        WindowStart::Time { seconds } => {
            let (located, _) = source.locate(target_ms(seconds), cancel)?;
            let keyframe = located.keyframe;
            Ok((
                keyframe.offset,
                keyframe.dts,
                keyframe.pts,
                method_name(located.method),
                located.non_monotonic,
            ))
        }
        WindowStart::Resume { offset, pts_ms } => {
            if source.is_keyframe_at(offset)? {
                if let Some(tag) = source.tag_at(offset)? {
                    return Ok((
                        offset,
                        tag.dts(),
                        tag.pts(),
                        "resume",
                        source.non_monotonic(),
                    ));
                }
            }
            // A window that stopped at a restart of the timestamps or at damage names where it
            // stopped, and the walk to the next keyframe runs here, where a newer request can
            // cancel it.
            if let Some(keyframe) = source.next_keyframe_from(offset, cancel.clone())? {
                return Ok((
                    keyframe.offset,
                    keyframe.dts,
                    keyframe.pts,
                    "resume",
                    source.non_monotonic(),
                ));
            }
            // A token that leads to no keyframe is located again by its time.
            let (located, _) = source.locate(pts_ms, cancel)?;
            let keyframe = located.keyframe;
            Ok((
                keyframe.offset,
                keyframe.dts,
                keyframe.pts,
                method_name(located.method),
                located.non_monotonic,
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn open_flv(
    windows: &Arc<PreviewWindows>,
    app_data: &Path,
    request: &OpenPreviewWindowRequest,
    path: &Path,
    revision: Revision,
    ffmpeg: &Path,
    ticket: Ticket,
    handle: Arc<WindowHandle>,
    sink: Arc<dyn WindowSink>,
    pcm_sink: Option<Arc<dyn WindowSink>>,
) -> Result<OpenPreviewWindowResult, PreviewWindowError> {
    if !flv_reader::has_signature(path)
        .map_err(|failure| error_with(PreviewWindowErrorCode::ReadFailed, failure))?
    {
        return Err(error(PreviewWindowErrorCode::NotFlv));
    }
    let (source, cache) = windows
        .flv_source(app_data, revision, path, Some(ticket.cancel.clone()))
        .map_err(map_flv)?;
    let (offset, dts, first_keyframe_pts, method, non_monotonic) =
        flv_start(&source, request.start, &ticket).map_err(map_flv)?;
    if request.rescan_config {
        source
            .rescan_configs(offset, Some(ticket.cancel.clone()))
            .map_err(map_flv)?;
    }
    if !windows.is_current(&ticket) {
        return Err(error(PreviewWindowErrorCode::Superseded));
    }

    let head = source
        .window_head(offset, Some(ticket.cancel.clone()))
        .map_err(map_flv)?;
    let slice = FlvSlice {
        source: source.clone(),
        head,
        start_offset: offset,
        start_dts: dts,
        limit_ms: WINDOW_MS,
        limit_bytes: WINDOW_BYTES,
    };
    let pcm = (request.pcm && request.audio != AudioMode::Omit)
        .then_some(pcm_sink)
        .flatten()
        .map(|pcm_sink| (flv_pcm_arguments(dts), pcm_sink));
    let pcm_start_seconds = pcm.as_ref().map(|_| dts as f64 / 1000.0);
    let id = handle.id;
    let release = {
        let windows = windows.clone();
        Box::new(move || windows.release(id))
    };
    let on_finish = {
        let windows = windows.clone();
        Box::new(move || {
            windows.finish(id);
            if let Err(failure) = cache.save_changed(&source) {
                eprintln!("preview: the keyframe sidecar was not saved: {failure}");
            }
        })
    };
    windows
        .activate(&ticket, handle.clone())
        .map_err(|_| error(PreviewWindowErrorCode::Superseded))?;
    if let Err(failure) = start_flv_window(
        ffmpeg,
        slice,
        &flv_remux_arguments(request.audio),
        pcm,
        handle.clone(),
        sink,
        release,
        on_finish,
    ) {
        windows.close(id);
        return Err(error_with(PreviewWindowErrorCode::SpawnFailed, failure));
    }
    Ok(OpenPreviewWindowResult {
        window_id: id,
        method: Some(method),
        non_monotonic,
        first_keyframe_pts_ms: Some(first_keyframe_pts),
        pcm_start_seconds,
        seek_seconds: None,
    })
}

fn open_seek(
    windows: &Arc<PreviewWindows>,
    request: &OpenPreviewWindowRequest,
    path: &Path,
    ffmpeg: &Path,
    ticket: Ticket,
    handle: Arc<WindowHandle>,
    sink: Arc<dyn WindowSink>,
) -> Result<OpenPreviewWindowResult, PreviewWindowError> {
    let format_start = request
        .format_start_time
        .map(Rational::to_f64)
        .unwrap_or(0.0);
    let margin = request.margin_seconds.unwrap_or(SEEK_MARGIN_SECONDS as f64);
    let seek = match request.start {
        WindowStart::FileStart => None,
        WindowStart::Time { seconds } => seek_of(seconds, format_start, margin),
        WindowStart::Resume { .. } => return Err(error(PreviewWindowErrorCode::InvalidRequest)),
    };
    let container = match request.container {
        ContainerHint::MpegTs => SeekContainer::MpegTs,
        _ => SeekContainer::Matroska,
    };
    let start_seconds = format_start + seek.unwrap_or(0.0);
    let (arguments, pcm_start_seconds) = match request.lane {
        Lane::Video => (
            seek_remux_arguments(
                path,
                container,
                seek,
                WINDOW_MS as f64 / 1000.0 + margin,
                request.audio,
                request.audio_codec.as_deref() == Some("aac"),
            ),
            None,
        ),
        Lane::Audio => (
            seek_pcm_arguments(path, seek, PCM_WINDOW_SECONDS + margin, start_seconds),
            Some(start_seconds),
        ),
    };
    if !windows.is_current(&ticket) {
        return Err(error(PreviewWindowErrorCode::Superseded));
    }
    let id = handle.id;
    let on_finish = {
        let windows = windows.clone();
        Box::new(move || windows.finish(id))
    };
    windows
        .activate(&ticket, handle.clone())
        .map_err(|_| error(PreviewWindowErrorCode::Superseded))?;
    if let Err(failure) = start_seek_window(ffmpeg, &arguments, handle, sink, on_finish) {
        windows.close(id);
        return Err(error_with(PreviewWindowErrorCode::SpawnFailed, failure));
    }
    Ok(OpenPreviewWindowResult {
        window_id: id,
        method: None,
        non_monotonic: false,
        first_keyframe_pts_ms: None,
        pcm_start_seconds,
        seek_seconds: seek,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(json: serde_json::Value) -> Result<OpenPreviewWindowRequest, serde_json::Error> {
        serde_json::from_value(json)
    }

    #[test]
    fn reads_each_kind_of_start() {
        let base = serde_json::json!({
            "path": "/media/a.flv", "size": 10, "mtime": 1, "lane": "video", "sequence": 1,
            "container": "flv", "audio": "copy", "start": {"kind": "fileStart"}
        });
        assert_eq!(request(base.clone()).unwrap().start, WindowStart::FileStart);
        let mut time = base.clone();
        time["start"] = serde_json::json!({"kind": "time", "seconds": 12.5});
        assert_eq!(
            request(time).unwrap().start,
            WindowStart::Time { seconds: 12.5 }
        );
        let mut resume = base.clone();
        resume["start"] = serde_json::json!({"kind": "resume", "offset": 900, "ptsMs": 60_067});
        assert_eq!(
            request(resume).unwrap().start,
            WindowStart::Resume {
                offset: 900,
                pts_ms: 60_067
            }
        );
        let mut seek = base;
        seek["container"] = serde_json::json!("mpegTs");
        seek["formatStartTime"] = serde_json::json!({"n": 1234567, "d": 1000});
        seek["marginSeconds"] = serde_json::json!(5);
        let parsed = request(seek).unwrap();
        assert_eq!(parsed.container, ContainerHint::MpegTs);
        assert_eq!(parsed.format_start_time, Rational::new(1_234_567, 1000));
    }

    #[test]
    fn refuses_a_request_that_cannot_be_served() {
        let base = request(serde_json::json!({
            "path": "/media/a.ts", "size": 10, "mtime": 1, "lane": "video", "sequence": 1,
            "container": "mpegTs", "audio": "copy", "start": {"kind": "fileStart"}
        }))
        .unwrap();
        assert!(check_request(&base).is_ok());
        let resume_on_ts = OpenPreviewWindowRequest {
            start: WindowStart::Resume {
                offset: 1,
                pts_ms: 1,
            },
            ..base.clone()
        };
        assert!(check_request(&resume_on_ts).is_err());
        let infinite = OpenPreviewWindowRequest {
            start: WindowStart::Time {
                seconds: f64::INFINITY,
            },
            ..base.clone()
        };
        assert!(check_request(&infinite).is_err());
        let margin = OpenPreviewWindowRequest {
            margin_seconds: Some(-1.0),
            ..base.clone()
        };
        assert!(check_request(&margin).is_err());
        let flv_audio_lane = OpenPreviewWindowRequest {
            lane: Lane::Audio,
            container: ContainerHint::Flv,
            ..base
        };
        assert!(check_request(&flv_audio_lane).is_err());
    }

    #[test]
    fn the_target_rounds_down_after_one_microsecond() {
        assert_eq!(target_ms(60.067), 60_067);
        assert_eq!(target_ms(60.066_999_9), 60_067);
        assert_eq!(target_ms(60.066_99), 60_066);
        assert_eq!(target_ms(-0.5), -500);
    }

    #[test]
    fn the_seek_takes_the_container_start_and_the_margin_off() {
        assert_eq!(seek_of(1264.567, 1234.567, 5.0), Some(25.0));
        assert_eq!(seek_of(1236.0, 1234.567, 5.0), None);
    }

    #[test]
    fn every_error_code_serializes_in_camel_case() {
        let json = serde_json::to_string(&error(PreviewWindowErrorCode::SourceNotAllowed)).unwrap();
        assert_eq!(json, r#"{"code":"sourceNotAllowed"}"#);
        let json =
            serde_json::to_string(&error_with(PreviewWindowErrorCode::ReadFailed, "x")).unwrap();
        assert_eq!(json, r#"{"code":"readFailed","detail":"x"}"#);
    }
}
