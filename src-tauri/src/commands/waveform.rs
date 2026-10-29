//! The commands of the audio envelope (ADR 056).
//!
//! The page asks for the envelope of one source. The command checks that the page may read the
//! file and that the file did not change, then answers from the cache or starts the one job of
//! the application, and returns at once. The buckets and the end go to the page through the
//! channel of the request. The Settings window reads the size of the cache and clears it.

use crate::commands::media::validate_media;
use crate::ffmpeg;
use crate::ffmpeg::waveform::cache::{self, EnvelopeKey, LIMIT_BYTES};
use crate::ffmpeg::waveform::job::WaveformSink;
use crate::ffmpeg::waveform::job::{self, encode_buckets, EndMessage, JobRequest, Progress};
use crate::ffmpeg::waveform::registry::{Refusal, WaveformJobs};
use crate::ffmpeg::waveform::{origin_samples, BUCKET_RATE};
use crate::flv::cache::Revision;
use crate::flv::has_signature;
use crate::settings;
use crate::time::{Pts, Rational};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWaveformRequest {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    /// Microseconds since the Unix epoch, rising with each request of the page. A page load sets
    /// a floor at its own time (see `WaveformJobs::cancel_all`).
    pub sequence: u64,
    /// The absolute index of the audio stream that the probe chose.
    pub audio_stream_index: u32,
    /// The time of bucket 0.
    pub video_start_pts: Pts,
    pub video_time_base: Rational,
    /// `approximateDurationSeconds` of the probe, which bounds the envelope.
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWaveformResult {
    /// The id of the job, or 0 for a cache hit, which needs no cancel.
    pub job_id: u64,
    pub cached: bool,
    pub bucket_rate: u32,
}

/// Stable error names translated by the frontend (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WaveformErrorCode {
    InvalidRequest,
    SourceUnreadable,
    SourceNotAllowed,
    SourceChanged,
    Busy,
    Superseded,
    Closed,
    CacheUnavailable,
    FfmpegNotFound,
    CommandExecutionFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformError {
    pub code: WaveformErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn error(code: WaveformErrorCode) -> WaveformError {
    WaveformError { code, detail: None }
}

fn error_with(code: WaveformErrorCode, detail: impl ToString) -> WaveformError {
    WaveformError {
        code,
        detail: Some(detail.to_string()),
    }
}

fn refused(refusal: Refusal) -> WaveformError {
    error(match refusal {
        Refusal::Busy => WaveformErrorCode::Busy,
        Refusal::Superseded => WaveformErrorCode::Superseded,
        Refusal::Closed => WaveformErrorCode::Closed,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformCacheUsage {
    pub bytes: u64,
    pub entries: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedWaveformCache {
    pub removed_bytes: u64,
}

/// The page side of a job: a Tauri channel. The buckets go as raw bytes, and the progress and
/// the end as JSON, so the page tells them apart by type.
struct ChannelSink(Channel<InvokeResponseBody>);

impl WaveformSink for ChannelSink {
    fn buckets(&self, start: u64, codes: &[u8]) -> bool {
        self.0
            .send(InvokeResponseBody::Raw(encode_buckets(start, codes)))
            .is_ok()
    }

    fn progress(&self, progress: &Progress) -> bool {
        serde_json::to_string(progress)
            .is_ok_and(|json| self.0.send(InvokeResponseBody::Json(json)).is_ok())
    }

    fn end(&self, message: &EndMessage) {
        if let Ok(json) = serde_json::to_string(message) {
            let _ = self.0.send(InvokeResponseBody::Json(json));
        }
    }
}

/// Start the envelope of one source.
#[tauri::command]
pub async fn start_waveform(
    app: AppHandle,
    jobs: State<'_, Arc<WaveformJobs>>,
    request: StartWaveformRequest,
    channel: Channel<InvokeResponseBody>,
) -> Result<StartWaveformResult, WaveformError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| error(WaveformErrorCode::CacheUnavailable))?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|_| error(WaveformErrorCode::CacheUnavailable))?;
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let allowed = |path: &Path| app.asset_protocol_scope().is_allowed(path);
        let discover = |app_data: &Path| {
            let configured = settings::configured_ffmpeg_path(app_data);
            ffmpeg::discover(configured.as_deref(), app_data)
                .ok()
                .map(|paths| paths.ffmpeg)
        };
        start(
            &jobs,
            &Places {
                app_data,
                cache_root,
            },
            &request,
            &allowed,
            &discover,
            Arc::new(ChannelSink(channel)),
        )
    })
    .await
    .map_err(|failure| error_with(WaveformErrorCode::CommandExecutionFailed, failure))?
}

/// Cancel job `job_id`. The cancel sends the kill and does not wait. It runs off the main thread
/// all the same, because it locks the processes of the job.
#[tauri::command(async)]
pub fn cancel_waveform(jobs: State<'_, Arc<WaveformJobs>>, job_id: u64) {
    jobs.cancel(job_id);
}

/// The size of the cache, for the Settings window.
#[tauri::command(async)]
pub fn waveform_cache_usage(app: AppHandle) -> Result<WaveformCacheUsage, WaveformError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| error(WaveformErrorCode::CacheUnavailable))?;
    let usage = cache::usage(&root)
        .map_err(|failure| error_with(WaveformErrorCode::CacheUnavailable, failure))?;
    Ok(WaveformCacheUsage {
        bytes: usage.bytes,
        entries: usage.entries,
        limit_bytes: LIMIT_BYTES,
    })
}

/// Delete every entry of the cache, for the Settings window.
#[tauri::command(async)]
pub fn clear_waveform_cache(app: AppHandle) -> Result<ClearedWaveformCache, WaveformError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| error(WaveformErrorCode::CacheUnavailable))?;
    let removed_bytes = cache::clear(&root)
        .map_err(|failure| error_with(WaveformErrorCode::CacheUnavailable, failure))?;
    Ok(ClearedWaveformCache { removed_bytes })
}

/// Frees the slot of a job that never started its thread, also after a panic.
struct Claim<'a> {
    jobs: &'a WaveformJobs,
    id: u64,
    armed: bool,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.jobs.finish(self.id);
        }
    }
}

/// The directories of the application that a start needs.
struct Places {
    app_data: PathBuf,
    cache_root: PathBuf,
}

fn check_request(request: &StartWaveformRequest) -> Result<i64, WaveformError> {
    let duration_valid = request
        .duration_seconds
        .is_none_or(|seconds| seconds.is_finite() && seconds >= 0.0);
    if !duration_valid {
        return Err(error(WaveformErrorCode::InvalidRequest));
    }
    origin_samples(request.video_start_pts, request.video_time_base)
        .ok_or_else(|| error(WaveformErrorCode::InvalidRequest))
}

/// The body of [`start_waveform`], with the asset scope check and the FFmpeg discovery passed in.
fn start(
    jobs: &Arc<WaveformJobs>,
    places: &Places,
    request: &StartWaveformRequest,
    allowed: &dyn Fn(&Path) -> bool,
    discover: &dyn Fn(&Path) -> Option<PathBuf>,
    sink: Arc<dyn WaveformSink>,
) -> Result<StartWaveformResult, WaveformError> {
    let origin = check_request(request)?;
    let media = validate_media(&request.path).map_err(|failure| {
        let code = serde_json::to_value(failure.code)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        error_with(WaveformErrorCode::SourceUnreadable, code)
    })?;
    // The same grant as the asset protocol: the page may read only a file that the user opened.
    if !allowed(&media.path) {
        return Err(error(WaveformErrorCode::SourceNotAllowed));
    }
    if media.size != request.size || media.mtime != request.mtime {
        return Err(error(WaveformErrorCode::SourceChanged));
    }
    let key = EnvelopeKey {
        revision: Revision {
            path: media.path_text.clone(),
            size: media.size,
            mtime: media.mtime,
        },
        audio_stream_index: request.audio_stream_index,
        origin_pts: request.video_start_pts,
        time_base: request.video_time_base,
    };

    // A request of an old page, or one during the exit, touches no cache entry.
    jobs.admit(request.sequence).map_err(refused)?;
    if let Some(envelope) = cache::read(&places.cache_root, &key) {
        std::thread::Builder::new()
            .name("waveform-cached".to_owned())
            .spawn(move || job::send_cached(&envelope, sink.as_ref()))
            .map_err(|failure| error_with(WaveformErrorCode::CommandExecutionFailed, failure))?;
        return Ok(StartWaveformResult {
            job_id: 0,
            cached: true,
            bucket_rate: BUCKET_RATE,
        });
    }

    let handle = jobs.begin(request.sequence).map_err(refused)?;
    let mut claim = Claim {
        jobs,
        id: handle.id,
        armed: true,
    };
    let Some(ffmpeg) = discover(&places.app_data) else {
        return Err(error(WaveformErrorCode::FfmpegNotFound));
    };
    // A direct read of an FLV gives a wrong envelope (ADR 056), so a file whose signature cannot
    // be read is refused rather than read as another container.
    let flv = has_signature(&media.path)
        .map_err(|failure| error_with(WaveformErrorCode::SourceUnreadable, failure))?;
    let path_text = media.path_text.clone();
    let (size, mtime) = (media.size, media.mtime);
    let job_request = JobRequest {
        ffmpeg,
        flv,
        path: media.path,
        audio_stream_index: request.audio_stream_index,
        origin,
        duration_seconds: request.duration_seconds,
        total_bytes: size,
        cache_root: Some(places.cache_root.clone()),
        cache_key: key,
        still_same: Box::new(move || {
            validate_media(&path_text).is_ok_and(|now| now.size == size && now.mtime == mtime)
        }),
    };
    let job_id = handle.id;
    let spawned = {
        let jobs = jobs.clone();
        std::thread::Builder::new()
            .name("waveform-job".to_owned())
            .spawn(move || job::run(&jobs, handle, job_request, sink))
    };
    if let Err(failure) = spawned {
        return Err(error_with(
            WaveformErrorCode::CommandExecutionFailed,
            failure,
        ));
    }
    // The job thread owns the slot now, and frees it when the job ends.
    claim.armed = false;
    Ok(StartWaveformResult {
        job_id,
        cached: false,
        bucket_rate: BUCKET_RATE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::waveform::cache::{CachedEnvelope, EnvelopeFlags};
    use crate::ffmpeg::waveform::job::EndStatus;
    use crate::flv::test_support::TestDirectory;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Recorder {
        buckets: Mutex<usize>,
        end: Mutex<Option<EndMessage>>,
    }

    impl WaveformSink for Recorder {
        fn buckets(&self, _start: u64, codes: &[u8]) -> bool {
            *self.buckets.lock().unwrap() += codes.len() / 2;
            true
        }

        fn progress(&self, _progress: &Progress) -> bool {
            true
        }

        fn end(&self, message: &EndMessage) {
            *self.end.lock().unwrap() = Some(message.clone());
        }
    }

    impl Recorder {
        fn wait_for_end(&self) -> EndMessage {
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if let Some(end) = self.end.lock().unwrap().clone() {
                    return end;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no end message");
        }
    }

    struct Fixture {
        dir: TestDirectory,
        request: StartWaveformRequest,
    }

    fn fixture() -> Fixture {
        let dir = TestDirectory::new();
        let source = dir.path.join("source.mka");
        std::fs::write(&source, b"not media").unwrap();
        let media = validate_media(source.to_str().unwrap()).unwrap();
        let request = StartWaveformRequest {
            path: media.path_text.clone(),
            size: media.size,
            mtime: media.mtime,
            sequence: 10,
            audio_stream_index: 1,
            video_start_pts: Pts::new(0),
            video_time_base: Rational::new(1, 1000).unwrap(),
            duration_seconds: Some(1.0),
        };
        Fixture { dir, request }
    }

    fn places(dir: &TestDirectory) -> Places {
        Places {
            app_data: dir.path.join("data"),
            cache_root: dir.path.join("cache"),
        }
    }

    fn key_of(fixture: &Fixture) -> EnvelopeKey {
        let media = validate_media(&fixture.request.path).unwrap();
        EnvelopeKey {
            revision: Revision {
                path: media.path_text,
                size: media.size,
                mtime: media.mtime,
            },
            audio_stream_index: fixture.request.audio_stream_index,
            origin_pts: fixture.request.video_start_pts,
            time_base: fixture.request.video_time_base,
        }
    }

    fn no_ffmpeg(_: &Path) -> Option<PathBuf> {
        None
    }

    #[test]
    fn a_file_outside_the_grant_is_refused() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &fixture.request,
            &|_| false,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::SourceNotAllowed);
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn a_changed_file_and_a_bad_request_are_refused() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let mut changed = fixture.request.clone();
        changed.size += 1;
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &changed,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::SourceChanged);
        let mut bad = fixture.request.clone();
        bad.duration_seconds = Some(f64::NAN);
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &bad,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::InvalidRequest);
        let mut missing = fixture.request.clone();
        missing.path = fixture
            .dir
            .path
            .join("missing.mka")
            .to_string_lossy()
            .into();
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &missing,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::SourceUnreadable);
    }

    #[test]
    fn no_ffmpeg_frees_the_slot() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &fixture.request,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::FfmpegNotFound);
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn a_running_job_makes_a_second_request_busy() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let _held = jobs.begin(1).unwrap();
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &fixture.request,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::Busy);
    }

    #[test]
    fn a_cache_hit_answers_at_once_without_the_slot() {
        let fixture = fixture();
        let places = places(&fixture.dir);
        let envelope = CachedEnvelope {
            buckets: vec![200, 150, 100, 50],
            flags: EnvelopeFlags::default(),
        };
        cache::write(&places.cache_root, &key_of(&fixture), &envelope).unwrap();
        let jobs = Arc::new(WaveformJobs::default());
        let _held = jobs.begin(1).unwrap();
        let recorder = Arc::new(Recorder::default());
        let result = start(
            &jobs,
            &places,
            &fixture.request,
            &|_| true,
            &no_ffmpeg,
            recorder.clone(),
        )
        .unwrap();
        assert_eq!(
            result,
            StartWaveformResult {
                job_id: 0,
                cached: true,
                bucket_rate: 100
            }
        );
        let end = recorder.wait_for_end();
        assert_eq!(end.status, EndStatus::Complete);
        assert!(end.cached);
        assert_eq!(end.bucket_count, 2);
        assert_eq!(*recorder.buckets.lock().unwrap(), 2);
        // A page from before the last page load gets no answer from the cache either.
        jobs.cancel_all(100);
        let refused = start(
            &jobs,
            &places,
            &fixture.request,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::Superseded);
    }

    #[test]
    fn a_request_of_an_old_page_or_during_the_exit_starts_nothing() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        jobs.cancel_all(100);
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &fixture.request,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::Superseded);
        let mut later = fixture.request.clone();
        later.sequence = 200;
        jobs.close_for_exit();
        let refused = start(
            &jobs,
            &places(&fixture.dir),
            &later,
            &|_| true,
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, WaveformErrorCode::Closed);
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn the_grant_check_sees_the_canonical_path() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let canonical = PathBuf::from(&fixture.request.path);
        let mut indirect = fixture.request.clone();
        // The same file through a `..` step.
        indirect.path = fixture
            .dir
            .path
            .join("sub")
            .join("..")
            .join("source.mka")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir(fixture.dir.path.join("sub")).unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let _ = start(
            &jobs,
            &places(&fixture.dir),
            &indirect,
            &|path| {
                seen.lock().unwrap().push(path.to_owned());
                false
            },
            &no_ffmpeg,
            Arc::new(Recorder::default()),
        );
        assert_eq!(*seen.lock().unwrap(), vec![canonical]);
    }

    #[test]
    fn the_wire_names_are_camel_case() {
        let result = serde_json::to_value(StartWaveformResult {
            job_id: 3,
            cached: false,
            bucket_rate: 100,
        })
        .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"jobId": 3, "cached": false, "bucketRate": 100})
        );
        let refused = serde_json::to_value(error(WaveformErrorCode::SourceNotAllowed)).unwrap();
        assert_eq!(refused, serde_json::json!({"code": "sourceNotAllowed"}));
        let usage = serde_json::to_value(WaveformCacheUsage {
            bytes: 1,
            entries: 2,
            limit_bytes: 3,
        })
        .unwrap();
        assert_eq!(
            usage,
            serde_json::json!({"bytes": 1, "entries": 2, "limitBytes": 3})
        );
        let request: StartWaveformRequest = serde_json::from_value(serde_json::json!({
            "path": "/a.flv",
            "size": 1,
            "mtime": 2,
            "sequence": 3,
            "audioStreamIndex": 1,
            "videoStartPts": "-1800",
            "videoTimeBase": {"n": 1, "d": 90000},
            "durationSeconds": null
        }))
        .unwrap();
        assert_eq!(request.video_start_pts, Pts::new(-1800));
        assert_eq!(request.duration_seconds, None);
    }

    #[test]
    fn a_started_job_ends_and_frees_the_slot() {
        let fixture = fixture();
        let jobs = Arc::new(WaveformJobs::default());
        let recorder = Arc::new(Recorder::default());
        // A program that is not FFmpeg: the job fails, and the slot is free again.
        let fake = fixture.dir.path.join("not-ffmpeg");
        let result = start(
            &jobs,
            &places(&fixture.dir),
            &fixture.request,
            &|_| true,
            &|_| Some(fake.clone()),
            recorder.clone(),
        )
        .unwrap();
        assert!(!result.cached && result.job_id > 0);
        let end = recorder.wait_for_end();
        assert_eq!(end.status, EndStatus::Failed);
        let deadline = Instant::now() + Duration::from_secs(5);
        while jobs.running().is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(jobs.running(), None);
    }
}
