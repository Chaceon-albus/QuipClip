//! The commands of the measurement of the loudness of an export (ADR 061).
//!
//! The setup step asks for the integrated loudness and the true peak of the audio that an export
//! would write. [`start_loudness_measurement`] checks the request, takes the one slot of the
//! measurements ([`LoudnessJobs`]), and returns at once. The job then prepares the audio as an
//! export prepares it, on a helper thread with the time limits of ADR 050
//! ([`prepare_on_helper`]). It runs the process that writes that audio, and measures it
//! ([`job::run`]). The progress and the end go to the page through the channel of the request, as
//! the envelope of ADR 056 does.
//!
//! The measurement measures what the encoder of the export would receive, with a gain of 0:
//!
//! - With video, the audio process of ADR 043, with its graph and its command.
//! - Without video, the graph of the one process, with `[a]` mapped to the WAV output of the audio
//!   process ([`build_measurement_arguments`]).
//! - With video and no piece that reads an audio stream, no process. The encoder generates
//!   silence, which has no gain (ADR 054), and the measurement ends complete with no values.
//!
//! The preparation is the preparation of an export with no destination ([`prepare_plan_with`]): it
//! skips the checks of the output path and reserves no output file.

use super::export::{
    discover_for_export, prepare_on_helper, prepare_plan_with, validate_request_preset,
    write_graph, ExportCommandError, ExportPieceWire, ExportSourceWire, GraphFileProbe,
    PlanPreparation, PlanScope, PreparationLimits, PreparationStage, PreparationStageCell,
    PreparedPlan,
};
use crate::app_cache::work::WorkDirectory;
use crate::ffmpeg::export::graph_file::{probe_graph_file_option, GraphFile, AUDIO_GRAPH_FILE};
use crate::ffmpeg::export::{
    build_audio_arguments, build_audio_graph, build_measurement_arguments, check_command_line,
    encoder_graph, ExportAudioMode, ExportErrorCode, ExportStreams,
};
use crate::ffmpeg::loudness::job::{
    self, EndCode, EndMessage, LoudnessSink, Progress, RunOutcome, RunRequest,
};
use crate::ffmpeg::loudness::meter::Loudness;
use crate::ffmpeg::loudness::registry::LoudnessJobs;
use crate::ffmpeg::preview::PreviewWindows;
use crate::ffmpeg::waveform::registry::{JobHandle, Refusal};
use crate::ffmpeg::{
    self, AudioFrames, AudioGapRead, FfmpegPaths, FirstAudioPacket, LocateError, MediaProbe,
    ProbeError,
};
use crate::settings::Preset;
use crate::time::Rational;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// The request of [`start_loudness_measurement`]: the fields of an export request that decide its
/// audio (ADR 061), and the number of the request. It has no output path and no audio mode.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartLoudnessRequest {
    /// See `ExportRequestWire::sources`.
    pub sources: Vec<ExportSourceWire>,
    /// See `ExportRequestWire::pieces`.
    pub pieces: Vec<ExportPieceWire>,
    /// See `ExportRequestWire::segment_count`.
    pub segment_count: u32,
    /// The preset of the setup step, whole. The measurement reads its sample rate, its channels,
    /// and for an export with video its frame rate. It does not apply its gain.
    pub preset: Preset,
    /// The streams of the export. A choice of the video only writes no audio, so it is refused.
    pub streams: ExportStreams,
    /// Microseconds since the Unix epoch, rising with each request of the page. A page load sets
    /// a floor at its own time (ADR 056).
    pub sequence: u64,
}

impl StartLoudnessRequest {
    /// The fields of this request that decide the plan. The measurement encodes the audio, as an
    /// export with the Adjust switch on does, and measures it with a gain of 0.
    fn plan_scope(&self) -> PlanScope<'_> {
        PlanScope {
            sources: &self.sources,
            pieces: &self.pieces,
            segment_count: self.segment_count,
            preset: &self.preset,
            streams: self.streams,
            audio_mode: ExportAudioMode::Encode,
            adjusted_audio_gain_tenths_db: Some(0),
        }
    }
}

/// The answer of [`start_loudness_measurement`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLoudnessResult {
    /// The id of the job, which [`cancel_loudness_measurement`] names.
    pub job_id: u64,
}

/// Stable names of the refusals of [`start_loudness_measurement`] (ADR 011).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoudnessStartErrorCode {
    /// The preset fails the rules of the settings file, or the streams write no audio.
    InvalidRequest,
    /// Another measurement runs.
    Busy,
    /// The request comes from a page before the last page load.
    Superseded,
    /// The application exits.
    Closed,
}

/// A refusal of [`start_loudness_measurement`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessStartError {
    pub code: LoudnessStartErrorCode,
    /// The untranslated diagnostic of an invalid preset (ADR 011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn start_error(code: LoudnessStartErrorCode) -> LoudnessStartError {
    LoudnessStartError { code, detail: None }
}

fn refused(refusal: Refusal) -> LoudnessStartError {
    start_error(match refusal {
        Refusal::Busy => LoudnessStartErrorCode::Busy,
        Refusal::Superseded => LoudnessStartErrorCode::Superseded,
        Refusal::Closed => LoudnessStartErrorCode::Closed,
    })
}

/// The page side of a measurement: a Tauri channel. Every message is JSON.
struct ChannelSink(Channel<InvokeResponseBody>);

impl LoudnessSink for ChannelSink {
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

/// The directories of the application that the preparation needs. A directory that the
/// application cannot resolve ends the measurement with the code of the export preparation.
struct Places {
    app_data: Result<PathBuf, ExportErrorCode>,
    cache: Result<PathBuf, ExportErrorCode>,
}

/// Everything that the job of one measurement owns.
struct MeasurementJob {
    request: StartLoudnessRequest,
    places: Places,
    preview_windows: Arc<PreviewWindows>,
}

/// Start the measurement of the audio of an export, and return its id at once.
///
/// The command takes the request as JSON and decodes it itself ([`parse_request`]), so a request
/// of the wrong shape is refused with the stable code `invalidRequest` (ADR 061) and not with the
/// text of the decoder of Tauri.
#[tauri::command]
pub async fn start_loudness_measurement(
    app: AppHandle,
    jobs: State<'_, Arc<LoudnessJobs>>,
    preview_windows: State<'_, Arc<PreviewWindows>>,
    request: Option<serde_json::Value>,
    channel: Channel<InvokeResponseBody>,
) -> Result<StartLoudnessResult, LoudnessStartError> {
    let request = parse_request(request)?;
    check_request(&request)?;
    let places = Places {
        app_data: app
            .path()
            .app_data_dir()
            .map_err(|_| ExportErrorCode::AppDataUnavailable),
        cache: app
            .path()
            .app_cache_dir()
            .map_err(|_| ExportErrorCode::WorkDirectoryUnavailable),
    };
    let handle = jobs.begin(request.sequence).map_err(refused)?;
    let job_id = handle.id;
    let job = MeasurementJob {
        request,
        places,
        preview_windows: preview_windows.inner().clone(),
    };
    spawn_measurement(
        jobs.inner().clone(),
        handle,
        Arc::new(ChannelSink(channel)),
        move |handle, sink| run_measurement(handle, job, sink),
    );
    Ok(StartLoudnessResult { job_id })
}

/// Run `measure` on a thread of its own, and send its end message exactly once.
///
/// - A panic in `measure` ends the measurement as failed with `commandExecutionFailed`.
/// - A cancel that came before the end message wins: the measurement ends as canceled, whatever
///   `measure` gave. A cancel after the last read of the flag cannot change the message, as a
///   cancel at the end of an export cannot (ADR 016).
/// - The slot is free before the end message goes. The page starts its next measurement when the
///   end arrives, and that start must find the slot free.
/// - A thread that the system refuses frees the slot and ends the measurement as failed with
///   `commandExecutionFailed`, before the command answers.
fn spawn_measurement<Measure>(
    jobs: Arc<LoudnessJobs>,
    handle: Arc<JobHandle>,
    sink: Arc<dyn LoudnessSink>,
    measure: Measure,
) where
    Measure: FnOnce(&JobHandle, &dyn LoudnessSink) -> EndMessage + Send + 'static,
{
    let spawned = {
        let jobs = jobs.clone();
        let handle = handle.clone();
        let sink = sink.clone();
        std::thread::Builder::new()
            .name("loudness-measure".to_owned())
            .spawn(move || {
                let message = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    measure(&handle, sink.as_ref())
                }))
                .unwrap_or_else(|payload| {
                    let detail = payload
                        .downcast_ref::<&str>()
                        .map(|text| (*text).to_owned())
                        .or_else(|| payload.downcast_ref::<String>().cloned());
                    EndMessage::failed(
                        EndCode::Preparation(ExportErrorCode::CommandExecutionFailed),
                        detail,
                    )
                });
                let message = if handle.is_canceled() {
                    EndMessage::canceled()
                } else {
                    message
                };
                jobs.finish(handle.id);
                sink.end(&message);
            })
    };
    if let Err(error) = spawned {
        jobs.finish(handle.id);
        sink.end(&EndMessage::failed(
            EndCode::Preparation(ExportErrorCode::CommandExecutionFailed),
            Some(error.to_string()),
        ));
    }
}

/// Cancel the measurement `job_id`. The cancel sends the kill and does not wait. The job still
/// sends its end message, as `canceled`.
#[tauri::command(async)]
pub fn cancel_loudness_measurement(jobs: State<'_, Arc<LoudnessJobs>>, job_id: u64) {
    jobs.cancel(job_id);
}

/// Decode the request of [`start_loudness_measurement`]. No request, a value that is not a JSON
/// object, and an object of the wrong shape are `invalidRequest`, with the fault as its
/// diagnostic (ADR 011). The check of the object comes first, because serde also reads a struct
/// from an array of its fields in their order.
fn parse_request(
    value: Option<serde_json::Value>,
) -> Result<StartLoudnessRequest, LoudnessStartError> {
    let invalid = |detail: String| LoudnessStartError {
        code: LoudnessStartErrorCode::InvalidRequest,
        detail: Some(detail),
    };
    let Some(value) = value else {
        return Err(invalid("the command has no request".to_owned()));
    };
    if !value.is_object() {
        return Err(invalid("the request is not a JSON object".to_owned()));
    }
    serde_json::from_value(value).map_err(|error| invalid(error.to_string()))
}

/// The checks of a request that need no read outside the process. A request that fails one holds
/// no slot.
fn check_request(request: &StartLoudnessRequest) -> Result<(), LoudnessStartError> {
    validate_request_preset(&request.preset).map_err(|error| LoudnessStartError {
        code: LoudnessStartErrorCode::InvalidRequest,
        detail: error.detail,
    })?;
    if !request.streams.writes_audio() {
        return Err(start_error(LoudnessStartErrorCode::InvalidRequest));
    }
    Ok(())
}

/// Prepare and run one measurement, and give its end message.
fn run_measurement(handle: &JobHandle, job: MeasurementJob, sink: &dyn LoudnessSink) -> EndMessage {
    let limits = PreparationLimits::PRODUCTION.for_sources(job.request.sources.len());
    let cancel = handle.cancel_flag();
    let prepared = prepare_on_helper("loudness-prepare", &cancel, limits, move |stop, stage| {
        let app_data = job
            .places
            .app_data
            .clone()
            .map_err(ExportCommandError::new)?;
        let cache = job.places.cache.clone().map_err(ExportCommandError::new)?;
        prepare_measurement_with(
            MeasurementPreparation {
                scope: job.request.plan_scope(),
                app_data_directory: &app_data,
                cache_directory: &cache,
                cancel: stop,
                preview_windows: &job.preview_windows,
                stage,
                graph_file: &probe_graph_file_option,
            },
            discover_for_export,
            ffmpeg::probe_media_until_canceled,
            ffmpeg::probe_first_audio_packet,
            ffmpeg::probe_audio_sample_rate_at,
            ffmpeg::probe_audio_gaps,
        )
    });
    finish_measurement(handle, prepared, sink, job::run)
}

/// The plain data [`prepare_measurement_with`] needs. The fields mean what the fields of
/// `PrepareRequest` with the same names mean.
#[derive(Clone, Copy)]
struct MeasurementPreparation<'a> {
    scope: PlanScope<'a>,
    app_data_directory: &'a Path,
    cache_directory: &'a Path,
    cancel: &'a AtomicBool,
    preview_windows: &'a PreviewWindows,
    stage: &'a PreparationStageCell,
    graph_file: &'a GraphFileProbe<'a>,
}

/// What a measurement runs after its preparation.
#[derive(Debug)]
struct PreparedMeasurement {
    /// The located `ffmpeg`.
    ffmpeg: PathBuf,
    /// The command of the process that writes the audio, or `None` when no process filters audio.
    arguments: Option<Vec<String>>,
    /// The duration of the audio of the export.
    expected_duration: Rational,
    /// The work directory, which holds the graph file and the FLV heads. It removes itself when it
    /// drops, after the run.
    work: WorkDirectory,
}

/// Do every step that a measurement needs before its process starts.
///
/// The steps up to the plan are the steps of an export, with no destination
/// ([`prepare_plan_with`]). Then the option probe of ADR 055, the graph file, and the command,
/// which [`check_command_line`] checks as the export checks its commands.
fn prepare_measurement_with<Discover, Probe, FirstPacket, RateAt, Gaps>(
    preparation: MeasurementPreparation<'_>,
    discover: Discover,
    probe: Probe,
    first_audio_packet: FirstPacket,
    audio_sample_rate_at: RateAt,
    audio_gaps: Gaps,
) -> Result<PreparedMeasurement, ExportCommandError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    Probe: FnMut(&Path, &Path, &AtomicBool) -> Result<MediaProbe, ProbeError>,
    FirstPacket:
        FnMut(&Path, &Path, u32, &AtomicBool) -> Result<Option<FirstAudioPacket>, ProbeError>,
    RateAt: FnMut(&Path, &Path, u64, u32, &AtomicBool) -> Result<Option<u32>, ProbeError>,
    Gaps: FnMut(&Path, &Path, &AudioGapRead<'_>, &AtomicBool) -> Result<AudioFrames, ProbeError>,
{
    let MeasurementPreparation {
        scope,
        app_data_directory,
        cache_directory,
        cancel,
        preview_windows,
        stage,
        graph_file,
    } = preparation;
    let canceled = || cancel.load(Ordering::SeqCst);
    let PreparedPlan {
        plan,
        inputs,
        executables,
        work,
    } = prepare_plan_with(
        PlanPreparation {
            scope,
            destination: None,
            app_data_directory,
            cache_directory,
            cancel,
            preview_windows,
            stage,
        },
        discover,
        probe,
        first_audio_packet,
        audio_sample_rate_at,
        audio_gaps,
    )?;
    let expected_duration = plan.total_duration;
    let with_video = plan.video.is_some();
    // A plan with video in which no piece reads an audio stream has no audio process: the
    // encoder generates the silence. A plan without video always has audio, because check 13 of
    // the plan refuses one without an audio stream that holds packets.
    if (with_video && !plan.separate_audio_process()) || plan.audio.is_none() {
        return Ok(PreparedMeasurement {
            ffmpeg: executables.ffmpeg,
            arguments: None,
            expected_duration,
            work,
        });
    }

    // Before the probe, which starts a process and can take up to 10 s.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }
    stage.enter(PreparationStage::GraphFile);
    let option =
        graph_file(&executables.ffmpeg, &work, cancel).map_err(|error| match error.detail {
            Some(detail) => ExportCommandError::with_detail(error.code, detail),
            None => ExportCommandError::new(error.code),
        })?;
    stage.enter(PreparationStage::Arguments);
    let file = GraphFile {
        option,
        name: AUDIO_GRAPH_FILE,
    };
    let (graph, arguments) = if with_video {
        (
            build_audio_graph(&plan, &inputs),
            build_audio_arguments(&plan, &inputs, file),
        )
    } else {
        (
            encoder_graph(&plan, &inputs),
            build_measurement_arguments(&plan, &inputs, file),
        )
    };
    write_graph(&work, AUDIO_GRAPH_FILE, &graph)?;
    check_command_line(&arguments).map_err(|detail| {
        ExportCommandError::with_detail(ExportErrorCode::FfmpegSpawnFailed, detail)
    })?;
    Ok(PreparedMeasurement {
        ffmpeg: executables.ffmpeg,
        arguments: Some(arguments),
        expected_duration,
        work,
    })
}

/// Run a prepared measurement with `run`, and give its end message.
fn finish_measurement(
    handle: &JobHandle,
    prepared: Result<PreparedMeasurement, ExportCommandError>,
    sink: &dyn LoudnessSink,
    run: impl FnOnce(&JobHandle, &RunRequest<'_>, &dyn LoudnessSink) -> RunOutcome,
) -> EndMessage {
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) if error.code == ExportErrorCode::Canceled => return EndMessage::canceled(),
        Err(error) => return EndMessage::failed(EndCode::Preparation(error.code), error.detail),
    };
    let Some(arguments) = prepared.arguments.as_deref() else {
        return EndMessage::complete(Loudness {
            integrated_lufs: None,
            true_peak_dbtp: None,
        });
    };
    let outcome = run(
        handle,
        &RunRequest {
            ffmpeg: &prepared.ffmpeg,
            arguments,
            working_directory: prepared.work.path(),
            expected_duration: prepared.expected_duration,
        },
        sink,
    );
    match outcome {
        RunOutcome::Complete(loudness) => EndMessage::complete(loudness),
        RunOutcome::Canceled => EndMessage::canceled(),
        RunOutcome::Failed(code, detail) => EndMessage::failed(EndCode::Run(code), detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_cache::work::EXPORT_WORK_DIRECTORY;
    use crate::commands::export::tests::{
        first_packet_unread, no_audio_gaps, real_tools, sample_preset, sample_probe,
        sample_probe_with_a_missed_audio_start, sample_rate_not_read, slash_graph_file,
        TestDirectory,
    };
    use crate::ffmpeg::loudness::job::{EndStatus, RunCode};
    use crate::ffmpeg::waveform::registry::WaveformJobs;
    use crate::ffmpeg::ExecutableOrigin;
    use crate::settings::Container;
    use crate::time::Pts;
    use std::fs;
    use std::sync::Mutex;

    /// A request for one second of the source `path`, with a preset whose gain is -1.0 dB.
    fn request_of(path: &Path, streams: ExportStreams) -> StartLoudnessRequest {
        let mut preset = sample_preset("active");
        preset.audio_gain_tenths_db = -10;
        StartLoudnessRequest {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: path.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            preset,
            streams,
            sequence: 1,
        }
    }

    /// Prepare `request` against the probe `probe`, with injected reads and no `ffmpeg`.
    fn prepare(
        directory: &TestDirectory,
        request: &StartLoudnessRequest,
        probe: MediaProbe,
    ) -> Result<PreparedMeasurement, ExportCommandError> {
        prepare_measurement_with(
            MeasurementPreparation {
                scope: request.plan_scope(),
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &slash_graph_file,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            move |_, _, _| Ok(probe.clone()),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
    }

    /// A source file in its own folder of `directory`.
    fn source_in(directory: &TestDirectory) -> PathBuf {
        let media = directory.path.join("media");
        fs::create_dir_all(&media).unwrap();
        let source = media.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        source
    }

    fn names_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The fields of `request` as JSON values, in the order of the struct.
    fn parsed_fields(request: &StartLoudnessRequest) -> Vec<serde_json::Value> {
        vec![
            serde_json::json!([{ "id": "source", "path": request.sources[0].path }]),
            serde_json::json!([{ "sourceId": "source", "inPts": "0", "outPts": "90000" }]),
            serde_json::json!(request.segment_count),
            serde_json::to_value(&request.preset).unwrap(),
            serde_json::json!("videoAndAudio"),
            serde_json::json!(request.sequence),
        ]
    }

    #[test]
    fn the_request_has_no_output_path_and_needs_its_number() {
        let directory = TestDirectory::new();
        let request = request_of(&directory.path.join("a.mp4"), ExportStreams::VideoAndAudio);
        let value = serde_json::json!({
            "sources": [{ "id": "source", "path": "/media/a.mp4" }],
            "pieces": [{ "sourceId": "source", "inPts": "0", "outPts": "90000" }],
            "segmentCount": 1,
            "preset": serde_json::to_value(&request.preset).unwrap(),
            "streams": "videoAndAudio",
            "sequence": 7,
        });
        let parsed = parse_request(Some(value.clone())).unwrap();
        assert_eq!(parsed.sequence, 7);
        // Each request of the wrong shape is `invalidRequest`, with the text of the decoder.
        let refused = |value: serde_json::Value| {
            let error = parse_request(Some(value)).unwrap_err();
            assert_eq!(error.code, LoudnessStartErrorCode::InvalidRequest);
            assert!(error.detail.is_some());
        };
        for (key, extra) in [
            ("outputPath", serde_json::json!("/out.mp4")),
            ("audioMode", serde_json::json!("encode")),
            ("adjustedAudioGainTenthsDb", serde_json::json!(-10)),
            ("streams", serde_json::json!("everything")),
            ("sequence", serde_json::json!(-1)),
        ] {
            let mut wrong = value.clone();
            wrong[key] = extra;
            refused(wrong);
        }
        let mut without = value;
        without.as_object_mut().unwrap().remove("sequence");
        refused(without);
        refused(serde_json::json!("a request"));
        // An array of the fields in their order, which serde would read as the struct.
        let array = serde_json::Value::Array(parsed_fields(&parsed));
        assert!(serde_json::from_value::<StartLoudnessRequest>(array.clone()).is_ok());
        refused(array);
        // No request at all.
        let error = parse_request(None).unwrap_err();
        assert_eq!(error.code, LoudnessStartErrorCode::InvalidRequest);
    }

    #[test]
    fn an_invalid_preset_and_a_choice_of_the_video_only_are_refused_at_once() {
        let path = PathBuf::from("/media/a.mp4");
        assert!(check_request(&request_of(&path, ExportStreams::VideoAndAudio)).is_ok());
        assert!(check_request(&request_of(&path, ExportStreams::AudioOnly)).is_ok());
        let error = check_request(&request_of(&path, ExportStreams::VideoOnly)).unwrap_err();
        assert_eq!(error, start_error(LoudnessStartErrorCode::InvalidRequest));
        let mut invalid = request_of(&path, ExportStreams::VideoAndAudio);
        invalid.preset.audio_gain_tenths_db = 1_000;
        let error = check_request(&invalid).unwrap_err();
        assert_eq!(error.code, LoudnessStartErrorCode::InvalidRequest);
        assert!(error.detail.is_some());
    }

    #[test]
    fn the_measurement_encodes_with_a_gain_of_0() {
        let request = request_of(Path::new("/media/a.mp4"), ExportStreams::VideoAndAudio);
        let scope = request.plan_scope();
        assert_eq!(scope.audio_mode, ExportAudioMode::Encode);
        assert_eq!(scope.adjusted_audio_gain_tenths_db, Some(0));
    }

    #[test]
    fn with_video_the_measurement_runs_the_audio_process_with_no_gain_and_writes_no_file() {
        let directory = TestDirectory::new();
        let source = source_in(&directory);
        let request = request_of(&source, ExportStreams::VideoAndAudio);
        let prepared = prepare(
            &directory,
            &request,
            sample_probe_with_a_missed_audio_start(),
        )
        .unwrap();
        let arguments = prepared.arguments.as_ref().unwrap();
        // The command of the audio process of ADR 043: the WAV stream on stdout, and the stand-in
        // video to the `null` muxer.
        assert!(arguments.windows(2).any(|pair| pair == ["-map", "[pv]"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-map_metadata", "-1"]));
        assert!(arguments.windows(2).any(|pair| pair == ["-f", "wav"]));
        assert!(arguments.contains(&"pipe:1".to_owned()));
        let graph = fs::read_to_string(prepared.work.file_path(AUDIO_GRAPH_FILE)).unwrap();
        assert!(graph.contains("[pv]"), "{graph}");
        // The preset has a gain of -1.0 dB, and the measurement applies none.
        assert!(!graph.contains("volume="), "{graph}");
        assert_eq!(prepared.expected_duration, Rational::new(1, 1).unwrap());
        // No reservation and no other file beside the source.
        assert_eq!(names_in(source.parent().unwrap()), ["source.mp4"]);
        assert!(prepared
            .work
            .path()
            .starts_with(directory.path.join("cache")));
    }

    #[test]
    fn without_video_the_measurement_writes_the_audio_of_the_one_process_to_stdout() {
        let directory = TestDirectory::new();
        let source = source_in(&directory);
        let request = request_of(&source, ExportStreams::AudioOnly);
        let prepared = prepare(
            &directory,
            &request,
            sample_probe_with_a_missed_audio_start(),
        )
        .unwrap();
        let arguments = prepared.arguments.as_ref().unwrap();
        assert!(arguments.windows(2).any(|pair| pair == ["-map", "[a]"]));
        assert!(!arguments.iter().any(|argument| argument == "[pv]"));
        // The WAV output is the last output of the command.
        assert_eq!(
            arguments[arguments.len() - 5..],
            ["-c:a", "pcm_f32le", "-f", "wav", "pipe:1"]
        );
        let graph = fs::read_to_string(prepared.work.file_path(AUDIO_GRAPH_FILE)).unwrap();
        assert!(graph.ends_with("[a]"), "{graph}");
        assert!(!graph.contains("volume="), "{graph}");
        assert_eq!(names_in(source.parent().unwrap()), ["source.mp4"]);
    }

    #[test]
    fn with_video_and_no_audio_to_read_the_measurement_runs_no_process() {
        // ADR 061: the encoder generates the silence, and silence has no gain (ADR 054).
        let directory = TestDirectory::new();
        let source = source_in(&directory);
        let mut probe = sample_probe_with_a_missed_audio_start();
        probe.audio.as_mut().unwrap().holds_no_packets = true;
        let request = request_of(&source, ExportStreams::VideoAndAudio);
        let prepared = prepare(&directory, &request, probe).unwrap();
        assert_eq!(prepared.arguments, None);
        // A source with no audio stream at all.
        let prepared = prepare(&directory, &request, sample_probe()).unwrap();
        assert_eq!(prepared.arguments, None);
    }

    #[test]
    fn only_the_audio_of_a_source_without_audio_is_refused_as_the_export_is() {
        let directory = TestDirectory::new();
        let source = source_in(&directory);
        let request = request_of(&source, ExportStreams::AudioOnly);
        let error = prepare(&directory, &request, sample_probe()).unwrap_err();
        assert_eq!(error.code, ExportErrorCode::SourceHasNoAudio);
    }

    /// A sink that keeps what it gets.
    #[derive(Default)]
    struct Recorder {
        progress: Mutex<Vec<Progress>>,
        end: Mutex<Option<EndMessage>>,
    }

    impl LoudnessSink for Recorder {
        fn progress(&self, progress: &Progress) -> bool {
            self.progress.lock().unwrap().push(*progress);
            true
        }

        fn end(&self, message: &EndMessage) {
            *self.end.lock().unwrap() = Some(message.clone());
        }
    }

    fn prepared_with(
        directory: &TestDirectory,
        arguments: Option<Vec<String>>,
    ) -> PreparedMeasurement {
        PreparedMeasurement {
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            arguments,
            expected_duration: Rational::new(3, 2).unwrap(),
            work: WorkDirectory::create(&directory.path.join("cache"), EXPORT_WORK_DIRECTORY)
                .unwrap(),
        }
    }

    #[test]
    fn the_end_message_follows_the_preparation_and_the_run() {
        let directory = TestDirectory::new();
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let sink = Recorder::default();
        let never = |_: &JobHandle, _: &RunRequest<'_>, _: &dyn LoudnessSink| -> RunOutcome {
            panic!("the run must not start")
        };
        // A canceled preparation, and a failed one.
        let canceled = finish_measurement(
            &handle,
            Err(ExportCommandError::new(ExportErrorCode::Canceled)),
            &sink,
            never,
        );
        assert_eq!(canceled.status, EndStatus::Canceled);
        let failed = finish_measurement(
            &handle,
            Err(ExportCommandError::with_detail(
                ExportErrorCode::SourceHasNoAudio,
                "x",
            )),
            &sink,
            never,
        );
        assert_eq!(
            failed,
            EndMessage::failed(
                EndCode::Preparation(ExportErrorCode::SourceHasNoAudio),
                Some("x".to_owned())
            )
        );
        // No process: complete, with no values.
        let silent = finish_measurement(&handle, Ok(prepared_with(&directory, None)), &sink, never);
        assert_eq!(silent.status, EndStatus::Complete);
        assert_eq!(silent.integrated_lufs, None);
        assert_eq!(silent.true_peak_dbtp, None);
        // A run: its request, and its outcome.
        let prepared = prepared_with(&directory, Some(vec!["-x".to_owned()]));
        let work = prepared.work.path().to_path_buf();
        let complete = finish_measurement(&handle, Ok(prepared), &sink, |_, run, _| {
            assert_eq!(run.arguments, ["-x".to_owned()]);
            assert_eq!(run.working_directory, work);
            assert_eq!(run.expected_duration, Rational::new(3, 2).unwrap());
            RunOutcome::Complete(Loudness {
                integrated_lufs: Some(-14.0),
                true_peak_dbtp: Some(0.4),
            })
        });
        assert_eq!(complete.integrated_lufs, Some(-14.0));
        assert_eq!(complete.true_peak_dbtp, Some(0.4));
        // The work directory goes with the measurement.
        assert!(!work.exists());
        let short = finish_measurement(
            &handle,
            Ok(prepared_with(&directory, Some(vec![]))),
            &sink,
            |_, _, _| RunOutcome::Failed(RunCode::AudioShort, None),
        );
        assert_eq!(short.code, Some(EndCode::Run(RunCode::AudioShort)));
    }

    /// Write an MKV of 4 s with video and a stereo sine of 1 kHz whose peak is 0.1, or -20 dBFS,
    /// in FLAC, so the audio keeps its level.
    fn write_sine_mkv(ffmpeg: &Path, path: &Path) {
        let status = crate::procutil::command_without_console(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("testsrc2=size=160x90:rate=30")
            .args(["-f", "lavfi", "-i"])
            .arg("aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000")
            .args([
                "-t",
                "4",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "30",
                "-c:a",
                "flac",
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// Measure 2 s of `source` from 1.0 s with real `ffmpeg`, `handle` and `sink`.
    fn measure_real(
        ffmpeg: &Path,
        ffprobe: &Path,
        directory: &TestDirectory,
        source: &Path,
        streams: ExportStreams,
        (from_ms, to_ms): (i64, i64),
        handle: &JobHandle,
        sink: &dyn LoudnessSink,
    ) -> EndMessage {
        let probe = ffmpeg::probe_media(ffprobe, source).unwrap();
        let tb = probe.video_time_base;
        let at = |millis: i64| Pts::new(millis * tb.den() / (1_000 * tb.num()));
        let mut request = request_of(source, streams);
        request.preset.container = Container::Mkv;
        request.pieces[0].in_pts = at(from_ms);
        request.pieces[0].out_pts = at(to_ms);
        let prepared = prepare_measurement_with(
            MeasurementPreparation {
                scope: request.plan_scope(),
                app_data_directory: &directory.path.join("app"),
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &probe_graph_file_option,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: ffmpeg.to_path_buf(),
                    ffprobe: ffprobe.to_path_buf(),
                    origin: ExecutableOrigin::Path,
                })
            },
            ffmpeg::probe_media_until_canceled,
            ffmpeg::probe_first_audio_packet,
            ffmpeg::probe_audio_sample_rate_at,
            ffmpeg::probe_audio_gaps,
        );
        finish_measurement(handle, prepared, sink, job::run)
    }

    #[test]
    fn a_real_measurement_reads_a_sine_of_minus_20_dbfs_with_and_without_video() {
        // ADR 061: the measurement reads the audio that the export writes, with a gain of 0. The
        // preset has a gain of -1.0 dB, which the measurement must not apply. A stereo sine of
        // 1 kHz with the peak -20 dBFS reads -20.0 LUFS, and its true peak is -20.0 dBTP.
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("sine.mkv");
        write_sine_mkv(&ffmpeg, &source);
        let jobs = WaveformJobs::default();
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let handle = jobs.begin(1).unwrap();
            let sink = Recorder::default();
            let end = measure_real(
                &ffmpeg,
                &ffprobe,
                &directory,
                &source,
                streams,
                (1_000, 3_000),
                &handle,
                &sink,
            );
            jobs.finish(handle.id);
            assert_eq!(end.status, EndStatus::Complete, "{streams:?}: {end:?}");
            let lufs = end.integrated_lufs.unwrap();
            let dbtp = end.true_peak_dbtp.unwrap();
            assert!((lufs + 20.0).abs() < 0.1, "{streams:?}: {lufs} LUFS");
            assert!((dbtp + 20.0).abs() < 0.1, "{streams:?}: {dbtp} dBTP");
            for progress in sink.progress.lock().unwrap().iter() {
                assert_eq!(progress.total_us, 2_000_000);
                assert!(progress.read_us <= 2_000_000);
            }
        }
        // The work directories went with the measurements.
        let work = directory.path.join("cache").join("work");
        assert!(!work.exists() || names_in(&work).is_empty(), "{work:?}");
    }

    #[test]
    fn a_real_measurement_that_is_canceled_ends_as_canceled() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("sine.mkv");
        write_sine_mkv(&ffmpeg, &source);
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        // A cancel before the run: the process is killed as it starts.
        handle.signal();
        let end = measure_real(
            &ffmpeg,
            &ffprobe,
            &directory,
            &source,
            ExportStreams::VideoAndAudio,
            (1_000, 3_000),
            &handle,
            &Recorder::default(),
        );
        assert_eq!(end.status, EndStatus::Canceled, "{end:?}");
    }

    /// A sink that gives each end message to the test, with the job that held the slot then.
    struct Ends {
        jobs: Arc<LoudnessJobs>,
        sender: Mutex<std::sync::mpsc::Sender<(EndMessage, Option<u64>)>>,
    }

    impl LoudnessSink for Ends {
        fn progress(&self, _: &Progress) -> bool {
            true
        }

        fn end(&self, message: &EndMessage) {
            let _ = self
                .sender
                .lock()
                .unwrap()
                .send((message.clone(), self.jobs.running()));
        }
    }

    /// Spawn `measure` as the command does, and give the one end message that the sink got, with
    /// the job that held the slot when it came.
    fn end_of(
        measure: impl FnOnce(&JobHandle, &dyn LoudnessSink) -> EndMessage + Send + 'static,
    ) -> (EndMessage, Option<u64>) {
        let jobs = Arc::new(LoudnessJobs::default());
        let handle = jobs.begin(1).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        spawn_measurement(
            jobs.clone(),
            handle,
            Arc::new(Ends {
                jobs: jobs.clone(),
                sender: Mutex::new(sender),
            }),
            measure,
        );
        let end = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        // The sink is gone with the thread, and it sent nothing more.
        assert!(matches!(
            receiver.recv_timeout(std::time::Duration::from_secs(10)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
        assert_eq!(jobs.running(), None);
        end
    }

    #[test]
    fn the_worker_sends_one_end_message_after_it_frees_the_slot() {
        let values = Loudness {
            integrated_lufs: Some(-20.0),
            true_peak_dbtp: Some(-19.0),
        };
        let (end, running) = end_of(move |_, _| EndMessage::complete(values));
        assert_eq!(end, EndMessage::complete(values));
        assert_eq!(running, None);
    }

    #[test]
    fn a_panic_of_the_worker_ends_the_measurement_as_failed() {
        let (end, running) = end_of(|_, _| panic!("the meter broke"));
        assert_eq!(
            end,
            EndMessage::failed(
                EndCode::Preparation(ExportErrorCode::CommandExecutionFailed),
                Some("the meter broke".to_owned())
            )
        );
        assert_eq!(running, None);
    }

    #[test]
    fn a_cancel_before_the_end_message_wins() {
        let (end, _) = end_of(|handle, _| {
            handle.signal();
            EndMessage::complete(Loudness {
                integrated_lufs: Some(-20.0),
                true_peak_dbtp: None,
            })
        });
        assert_eq!(end, EndMessage::canceled());
    }

    /// A sink that cancels its job at the first progress message, as a page does that turns the
    /// switch off while FFmpeg writes.
    struct CancelAtProgress {
        handle: Arc<JobHandle>,
        messages: std::sync::atomic::AtomicUsize,
    }

    impl LoudnessSink for CancelAtProgress {
        fn progress(&self, _: &Progress) -> bool {
            self.messages.fetch_add(1, Ordering::SeqCst);
            self.handle.signal();
            true
        }

        fn end(&self, _: &EndMessage) {}
    }

    #[test]
    fn a_real_measurement_canceled_while_ffmpeg_writes_ends_as_canceled() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("long.mkv");
        let status = crate::procutil::command_without_console(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("testsrc2=size=64x36:rate=10")
            .args(["-f", "lavfi", "-i"])
            .arg("sine=frequency=1000:sample_rate=48000,pan=stereo|c0=c0|c1=c0")
            .args([
                "-t",
                "300",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "flac",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success());
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(1).unwrap();
        let sink = CancelAtProgress {
            handle: handle.clone(),
            messages: std::sync::atomic::AtomicUsize::new(0),
        };
        let end = measure_real(
            &ffmpeg,
            &ffprobe,
            &directory,
            &source,
            ExportStreams::AudioOnly,
            (0, 290_000),
            &handle,
            &sink,
        );
        assert_eq!(end.status, EndStatus::Canceled, "{end:?}");
        assert!(sink.messages.load(Ordering::SeqCst) >= 1);
        // The process was reaped and released from the job.
        let work = directory.path.join("cache").join("work");
        assert!(!work.exists() || names_in(&work).is_empty(), "{work:?}");
    }
}
