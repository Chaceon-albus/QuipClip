//! The Export Frame command (ADR 069): save one frame of a source as a PNG file.
//!
//! The interface records the facts of the action when the user starts it: the source and its
//! revision, the inferred PTS of the confirmed frame in the time base of that source, and the
//! paths of every source of the session. After the save dialog, it sends them with the output
//! path. [`export_frame`] then writes the first frame, of the video stream that an export reads,
//! whose PTS is not before that PTS, at the display size of the source.
//!
//! The command reuses the parts of the export: the destination check of the plan
//! ([`check_destination`]), the revision check ([`check_source_revision`]), the re-probe, the FLV
//! input with its work directory ([`flv_input_for`]), the input seek of the plan, the process
//! guard of [`run_export_process`], the temporary file of [`PendingOutput`] and its rename.
//!
//! # Order
//!
//! 1. The refusals at once, before anything starts a process: the output path does not end in
//!    `.png`, it fails the destination check of an export, it is a source of the session by path
//!    or by the identity of its file, the source is gone, or its revision changed.
//! 2. The discovery of ffmpeg, and the probe of the source.
//! 3. The FLV input, for an FLV. When the export would fall back to the input seek, this command
//!    fails instead, so it never reads the whole file.
//! 4. The reservation of the temporary file beside the destination, and the one FFmpeg process,
//!    killed after [`FRAME_FFMPEG_LIMIT`].
//! 5. The check of the file: not empty, and one PNG picture of the planned size (ffprobe).
//! 6. The cancel flag, which only the exit sets (ADR 017), and then the rename.
//!
//! One command runs at a time ([`FrameExports`]), apart from the export queue. The exit cancels
//! it and waits for its slot, in the budget of ADR 017 (`lib.rs`).

use super::export::{
    check_source_revision, discover_for_export, flv_input_for, prepare_on_helper,
    ExpectedSourceRevisionWire, ExportCommandError, ExportSourceWire, FlvPlace, PreparationLimits,
    PreparationStage, PreparationStageCell, SetOnDrop, SourcePieces,
};
use super::media::map_probe_error;
use crate::app_cache;
use crate::app_cache::work::{WorkDirectory, EXPORT_WORK_DIRECTORY};
use crate::ffmpeg::export::frame::{
    has_png_extension, plan_frame, verify_png_file, FrameExportRefusal, FrameExports, FramePlan,
    FramePlanError, FRAME_FFMPEG_LIMIT, FRAME_PUBLISH_BUDGET,
};
use crate::ffmpeg::export::plan::check_destination;
use crate::ffmpeg::export::{
    build_frame_arguments, check_command_line, inspect_path, run_export_process, ExportErrorCode,
    ExportProcessOutcome, ExportProcessRequest, ExportProcessStatus, ExportStreams, PathFacts,
    PathIdentity, PendingOutput, ProgressSnapshot, SegmentBoundary,
};
use crate::ffmpeg::preview::PreviewWindows;
use crate::ffmpeg::{self, FfmpegPaths, LocateError, MediaProbe, ProbeError};
use crate::time::Pts;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

/// How often the watch of the process reads the cancel flag and the time limit, and how often
/// the process guard looks at the child. A tenth of a second is far inside the exit budget of
/// ADR 017.
const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The request of `export_frame`, matching `FrameExportRequest` on the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameExportRequestWire {
    /// The path of the source of the clip that the preview showed.
    pub source_path: String,
    /// The revision of that source that the interface recorded (ADR 024, ADR 058).
    pub source_revision: ExpectedSourceRevisionWire,
    /// The inferred PTS of the confirmed frame, in the time base of the video stream of the
    /// source, as a decimal string (ADR 002).
    pub pts: Pts,
    /// The paths of every source of the session. The output must not be one of them.
    pub session_source_paths: Vec<String>,
    /// The path of the image, which must end in `.png`.
    pub output_path: String,
}

/// The answer of `export_frame`: the path of the image that it wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameExportDone {
    pub output_path: String,
}

/// The stable codes of a failed Export Frame command (ADR 011). `src/features/frameExport/
/// types.ts` lists the same names in the same order, and its test reads this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FrameExportErrorCode {
    /// Another Export Frame command runs.
    FrameExportRunning,
    /// The application data directory, which holds the settings file, is not known.
    AppDataUnavailable,
    /// The work directory of an FLV source could not be created (ADR 055).
    WorkDirectoryUnavailable,
    /// The output path does not end in `.png`.
    OutputNotPng,
    /// The output path is not absolute, has no file name, or is a folder (ADR 016).
    OutputPathInvalid,
    /// The folder of the output path does not exist.
    OutputDirectoryMissing,
    /// The output exists as a file that the user protected against writing.
    OutputReadOnly,
    /// The output path is a source of the session, by its path or by its file.
    OutputEqualsSource,
    /// The source file is gone, or is not a file.
    SourceNotFound,
    /// The source file is not the revision that the interface recorded.
    SourceRevisionMismatch,
    /// `ffmpeg` and `ffprobe` could not both be found.
    FfmpegPairMissing,
    /// ffprobe could not read the source.
    SourceProbeFailed,
    /// The PTS cannot be read on the timeline of the source.
    PositionInvalid,
    /// The FLV input of ADR 046 is not available for the source.
    FlvInputUnavailable,
    /// The temporary file beside the destination could not be created.
    OutputNotWritable,
    /// FFmpeg did not start.
    FfmpegSpawnFailed,
    /// FFmpeg exited with an error.
    FfmpegProcessFailed,
    /// FFmpeg ran for more than [`FRAME_FFMPEG_LIMIT`].
    FfmpegTimedOut,
    /// FFmpeg wrote nothing: no frame has a PTS that is not before the PTS of the request.
    NoFrame,
    /// The file is not one PNG picture of the planned size.
    ImageCheckFailed,
    /// The rename onto the destination failed.
    OutputRenameFailed,
    /// A step before FFmpeg did not end within the time limit of the preparation of an export
    /// (ADR 050), such as a read on a share that stopped answering. The detail names the step.
    PreparationTimedOut,
    /// The exit of the application stopped the command.
    Canceled,
    /// The command failed in a way that has no code, such as a panic.
    CommandFailed,
}

/// The rejection of `export_frame`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameExportError {
    pub code: FrameExportErrorCode,
    /// An untranslated diagnostic, such as the end of the stderr of FFmpeg (ADR 011).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The exit code of the process that failed, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

impl FrameExportError {
    fn new(code: FrameExportErrorCode) -> Self {
        Self {
            code,
            detail: None,
            exit_code: None,
        }
    }

    fn with_detail(code: FrameExportErrorCode, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(code)
        }
    }

    fn with_optional_detail(code: FrameExportErrorCode, detail: Option<String>) -> Self {
        Self {
            detail,
            ..Self::new(code)
        }
    }
}

/// The error of a refused start: another command runs, or the exit began. After the exit began
/// the window is hidden, and nothing will show the notice, so `canceled` says enough.
fn refusal_error(refusal: FrameExportRefusal) -> FrameExportError {
    FrameExportError::new(match refusal {
        FrameExportRefusal::Running => FrameExportErrorCode::FrameExportRunning,
        FrameExportRefusal::Closed => FrameExportErrorCode::Canceled,
    })
}

/// Write the frame of the request as a PNG file, and answer with its path (ADR 069).
///
/// The command takes the one slot of [`FrameExports`] before it answers anything else, so a
/// second command is refused at once with `frameExportRunning`. The work runs on a blocking
/// thread, and the slot moves there: it drops after every guard of the run, so the exit handler
/// sees a free slot only when the process ended and the temporary file is gone (ADR 017).
#[tauri::command]
pub async fn export_frame(
    app: tauri::AppHandle,
    frames: tauri::State<'_, Arc<FrameExports>>,
    preview_windows: tauri::State<'_, Arc<PreviewWindows>>,
    request: FrameExportRequestWire,
) -> Result<FrameExportDone, FrameExportError> {
    let slot = frames.begin().map_err(refusal_error)?;
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| FrameExportError::new(FrameExportErrorCode::AppDataUnavailable))?;
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| FrameExportError::new(FrameExportErrorCode::WorkDirectoryUnavailable))?;
    let preview_windows = preview_windows.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let written = export_frame_with(
            FramePreparation {
                request: &request,
                app_data_directory: &app_data_directory,
                cache_directory: &cache_directory,
                cancel: slot.cancel_flag(),
                preview_windows: &preview_windows,
                // The limit of the preparation of an export of one source (ADR 050).
                limits: PreparationLimits::PRODUCTION,
                ffmpeg_limit: FRAME_FFMPEG_LIMIT,
            },
            discover_for_export,
            ffmpeg::probe_media_until_canceled,
            |process| run_export_process(process, |_: &ProgressSnapshot| {}),
        );
        // Every guard of the run dropped inside the call, so the slot goes free last. A helper
        // of preparation that a share still holds is the exception, as for an export (ADR 050):
        // it can no longer start FFmpeg or write beside the destination.
        drop(slot);
        written.map(|output_path| FrameExportDone { output_path })
    })
    .await
    .map_err(|error| {
        FrameExportError::with_detail(FrameExportErrorCode::CommandFailed, error.to_string())
    })?
}

/// The plain data of [`export_frame_with`], apart from the three functions that it takes.
#[derive(Clone, Copy)]
struct FramePreparation<'a> {
    request: &'a FrameExportRequestWire,
    /// The directory of the settings file and of the discovery of the executables.
    app_data_directory: &'a Path,
    /// The cache directory of the application, which holds the work directories (ADR 055) and
    /// the keyframe cache of the FLV reader (ADR 057).
    cache_directory: &'a Path,
    /// The cancel flag of the slot, which only the exit sets.
    cancel: &'a AtomicBool,
    /// The open FLV sources, which the FLV input shares with the preview (ADR 046).
    preview_windows: &'a Arc<PreviewWindows>,
    /// The time limits of the steps before FFmpeg: [`PreparationLimits::PRODUCTION`], shorter in
    /// a test.
    limits: PreparationLimits,
    /// How long the FFmpeg process may run: [`FRAME_FFMPEG_LIMIT`], shorter in a test.
    ffmpeg_limit: Duration,
}

/// What the helper thread of preparation owns: a copy of the data of [`FramePreparation`], so
/// the helper can outlive the command when a step blocks (ADR 050).
struct OwnedFramePreparation {
    request: FrameExportRequestWire,
    app_data_directory: PathBuf,
    cache_directory: PathBuf,
    preview_windows: Arc<PreviewWindows>,
}

/// What preparation gives to the run: the executables, the plan, the work directory of an FLV
/// source, the reservation beside the destination, and the command.
struct FramePrepared {
    executables: FfmpegPaths,
    plan: FramePlan,
    /// The work directory of an FLV source (ADR 055). It removes itself when it drops.
    work: Option<WorkDirectory>,
    /// The temporary file beside the destination. It removes itself when it drops.
    pending: PendingOutput,
    arguments: Vec<String>,
}

/// Do every step of the command in the order of this module, and answer with the destination.
///
/// The steps before FFmpeg run on a helper thread under the supervisor of the preparation of an
/// export ([`prepare_on_helper`], ADR 050): a step that does not answer within the limit ends the
/// command with `preparationTimedOut`, and the exit ends it with `canceled` within the grace. A
/// helper that answers late finds its stop flag set at its next step, so it neither creates the
/// reservation nor starts FFmpeg: FFmpeg starts only on this thread, after the helper answered.
///
/// The three functions are the ones that reach outside the process: the discovery of ffmpeg, the
/// probe of the source, and the FFmpeg process. A test passes fakes.
fn export_frame_with<Discover, Probe, Process>(
    preparation: FramePreparation<'_>,
    discover: Discover,
    probe: Probe,
    process: Process,
) -> Result<String, FrameExportError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError> + Send + 'static,
    Probe: FnOnce(&Path, &Path, &AtomicBool) -> Result<MediaProbe, ProbeError> + Send + 'static,
    Process: FnOnce(ExportProcessRequest<'_>) -> io::Result<ExportProcessOutcome>,
{
    let FramePreparation {
        request,
        app_data_directory,
        cache_directory,
        cancel,
        preview_windows,
        limits,
        ffmpeg_limit,
    } = preparation;
    let canceled = || cancel.load(Ordering::SeqCst);
    let cancel_error = || FrameExportError::new(FrameExportErrorCode::Canceled);

    let owned = OwnedFramePreparation {
        request: request.clone(),
        app_data_directory: app_data_directory.to_path_buf(),
        cache_directory: cache_directory.to_path_buf(),
        preview_windows: Arc::clone(preview_windows),
    };
    let FramePrepared {
        executables,
        plan,
        work,
        pending,
        arguments,
    } = prepare_on_helper("frame-prepare", cancel, limits, move |stop, stage| {
        Ok(prepare_frame(&owned, discover, probe, stop, stage))
    })
    .map_err(supervisor_error)??;

    let (outcome, timed_out) = run_within_limit(
        process,
        &executables.ffmpeg,
        &arguments,
        work.as_ref().map(WorkDirectory::path),
        cancel,
        ffmpeg_limit,
    );
    // The process has ended and is reaped, so nothing holds the work directory any more.
    if let Some(work) = work {
        work.remove();
    }
    let outcome = outcome.map_err(|error| {
        FrameExportError::with_detail(FrameExportErrorCode::FfmpegSpawnFailed, error.to_string())
    })?;
    // ADR 069: a process that has not ended at the limit fails the command, whatever exit status
    // it gives later. `run_within_limit` decides it in one place.
    if timed_out {
        return Err(FrameExportError::with_optional_detail(
            FrameExportErrorCode::FfmpegTimedOut,
            outcome.stderr_detail(),
        ));
    }
    match outcome.status {
        ExportProcessStatus::Canceled => return Err(cancel_error()),
        ExportProcessStatus::Exited {
            success: false,
            code,
        } => {
            return Err(FrameExportError {
                detail: outcome.stderr_detail(),
                exit_code: code,
                ..FrameExportError::new(FrameExportErrorCode::FfmpegProcessFailed)
            });
        }
        ExportProcessStatus::Exited { success: true, .. } => {}
    }

    // The reservation is empty until FFmpeg writes a picture. A trim that passes no frame, past
    // the last frame of the stream, writes nothing and still exits zero.
    if matches!(
        std::fs::metadata(pending.path()).map(|metadata| metadata.len()),
        Ok(0)
    ) {
        return Err(FrameExportError::with_optional_detail(
            FrameExportErrorCode::NoFrame,
            outcome.stderr_detail(),
        ));
    }
    // The command reads the file itself: one complete PNG picture of the planned size (ADR 069).
    verify_png_file(pending.path(), plan.width, plan.height).map_err(|detail| {
        FrameExportError::with_detail(FrameExportErrorCode::ImageCheckFailed, detail)
    })?;

    // The second read of the cancel flag, as for an export (ADR 016).
    if canceled() {
        return Err(cancel_error());
    }
    // The rename waits at most `FRAME_PUBLISH_BUDGET` for another process that holds the
    // destination on Windows, so the exit wait of ADR 017 still covers it. The rule of
    // `commands::export`: keep the diagnostic only when a raw operating system code shows that
    // the operating system wrote it (ADR 011).
    let destination = pending.destination().to_string_lossy().into_owned();
    pending
        .commit_within(FRAME_PUBLISH_BUDGET)
        .map_err(|error| match error.raw_os_error() {
            Some(_) => FrameExportError::with_detail(
                FrameExportErrorCode::OutputRenameFailed,
                error.to_string(),
            ),
            None => FrameExportError::new(FrameExportErrorCode::OutputRenameFailed),
        })?;
    Ok(destination)
}

/// The error of the supervisor of preparation, in the codes of this command.
fn supervisor_error(error: ExportCommandError) -> FrameExportError {
    match error.code {
        ExportErrorCode::Canceled => FrameExportError::new(FrameExportErrorCode::Canceled),
        // The detail names the step that did not answer.
        ExportErrorCode::PreparationTimedOut => FrameExportError::with_optional_detail(
            FrameExportErrorCode::PreparationTimedOut,
            error.detail,
        ),
        // A helper that the system did not start, or that panicked.
        _ => FrameExportError::with_optional_detail(
            FrameExportErrorCode::CommandFailed,
            error.detail,
        ),
    }
}

/// The steps before FFmpeg, on the helper thread of preparation: the refusals, the discovery of
/// ffmpeg, the probe of the source, the FLV input, the plan, and the reservation.
///
/// `stop` is the stop flag of the helper. The supervisor sets it at a cancel of the exit and at
/// the time limit. It is read between the steps, and right before the reservation, the first
/// step that writes beside the destination, so a helper that a share held past the limit writes
/// nothing when it comes back. `stage` names the step that runs, for the report of a timeout.
fn prepare_frame<Discover, Probe>(
    owned: &OwnedFramePreparation,
    discover: Discover,
    probe: Probe,
    stop: &AtomicBool,
    stage: &PreparationStageCell,
) -> Result<FramePrepared, FrameExportError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    Probe: FnOnce(&Path, &Path, &AtomicBool) -> Result<MediaProbe, ProbeError>,
{
    let request = &owned.request;
    let stopped = || stop.load(Ordering::SeqCst);
    let cancel_error = || FrameExportError::new(FrameExportErrorCode::Canceled);

    stage.enter(PreparationStage::RevisionCheck);
    check_request(request, inspect_path)?;
    if stopped() {
        return Err(cancel_error());
    }

    stage.enter(PreparationStage::Discovery);
    let executables = discover(&owned.app_data_directory)
        .map_err(|_| FrameExportError::new(FrameExportErrorCode::FfmpegPairMissing))?;
    if stopped() {
        return Err(cancel_error());
    }

    // ADR 014's "Other rules": the command reads the stream indices and the start time of the
    // container from a fresh probe, never from what the import read.
    stage.enter(PreparationStage::ReProbe);
    let source = PathBuf::from(&request.source_path);
    let source_probe = probe(&executables.ffprobe, &source, stop).map_err(|error| match error {
        ProbeError::Canceled => cancel_error(),
        other => {
            let mapped = map_probe_error(other);
            FrameExportError {
                detail: mapped.detail,
                exit_code: mapped.exit_code,
                ..FrameExportError::new(FrameExportErrorCode::SourceProbeFailed)
            }
        }
    })?;
    if stopped() {
        return Err(cancel_error());
    }

    // ADR 046: an FLV opens as its head and a slice from a keyframe, in a work directory of its
    // own (ADR 055), bound to the recorded revision (ADR 058). The directory removes itself when
    // it drops, so every early return below removes it.
    let is_flv = source_probe.format_names.iter().any(|name| name == "flv");
    let work = if is_flv {
        stage.enter(PreparationStage::WorkDirectory);
        let parent = app_cache::work_directory(&owned.cache_directory);
        Some(
            WorkDirectory::create(&parent, EXPORT_WORK_DIRECTORY).map_err(|error| {
                FrameExportError::with_detail(
                    FrameExportErrorCode::WorkDirectoryUnavailable,
                    error.to_string(),
                )
            })?,
        )
    } else {
        None
    };
    let flv = match &work {
        Some(work) => {
            stage.enter(PreparationStage::FlvInput);
            Some(locate_frame_flv_input(
                request,
                &executables.ffprobe,
                &source,
                &source_probe,
                FlvPlace {
                    cache_directory: &owned.cache_directory,
                    work_directory: work,
                    source_index: 0,
                    expected: Some((request.source_revision.size, request.source_revision.mtime)),
                    // The image must come from the recorded revision (ADR 069).
                    strict_revision: true,
                },
                &owned.preview_windows,
                stop,
            )?)
        }
        None => None,
    };

    stage.enter(PreparationStage::Plan);
    let plan =
        plan_frame(&source, &source_probe, request.pts, flv).map_err(|error| match error {
            FramePlanError::NoSlice => {
                FrameExportError::new(FrameExportErrorCode::FlvInputUnavailable)
            }
            FramePlanError::NoPictureSize | FramePlanError::PositionInvalid => {
                FrameExportError::new(FrameExportErrorCode::PositionInvalid)
            }
        })?;

    // Before the reservation, the first step that writes beside the destination.
    if stopped() {
        return Err(cancel_error());
    }
    stage.enter(PreparationStage::Reservation);
    let destination = PathBuf::from(&request.output_path);
    let pending = PendingOutput::reserve(&destination).map_err(|error| {
        FrameExportError::with_detail(FrameExportErrorCode::OutputNotWritable, error.to_string())
    })?;
    // FFmpeg writes the reservation, never the destination (ADR 004).
    stage.enter(PreparationStage::Arguments);
    let arguments = build_frame_arguments(&plan, pending.path());
    check_command_line(&arguments).map_err(|detail| {
        FrameExportError::with_detail(FrameExportErrorCode::FfmpegSpawnFailed, detail)
    })?;
    Ok(FramePrepared {
        executables,
        plan,
        work,
        pending,
        arguments,
    })
}

/// The refusals that need no process, in the order of ADR 069: the extension, the destination
/// check of an export, the sources of the session, then the source and its revision.
///
/// `inspect` reads the file system for the destination check, as `build_plan` reads it through
/// [`inspect_path`]. A source of the session that is gone has no identity, and it can still not
/// be the destination by its path.
fn check_request(
    request: &FrameExportRequestWire,
    inspect: impl Fn(&Path) -> PathFacts,
) -> Result<(), FrameExportError> {
    let destination = Path::new(&request.output_path);
    if !has_png_extension(destination) {
        return Err(FrameExportError::new(FrameExportErrorCode::OutputNotPng));
    }
    let source = Path::new(&request.source_path);
    let source_paths: Vec<&Path> = request
        .session_source_paths
        .iter()
        .map(Path::new)
        .chain(std::iter::once(source))
        .collect();
    let identities: Vec<PathIdentity> = source_paths
        .iter()
        .filter_map(|path| match inspect(path) {
            PathFacts::File { identity, .. } => Some(identity),
            PathFacts::Absent | PathFacts::Directory | PathFacts::Other => None,
        })
        .collect();
    check_destination(destination, &source_paths, &identities, &inspect).map_err(|code| {
        FrameExportError::new(match code {
            ExportErrorCode::OutputDirectoryMissing => FrameExportErrorCode::OutputDirectoryMissing,
            ExportErrorCode::OutputEqualsSource => FrameExportErrorCode::OutputEqualsSource,
            ExportErrorCode::OutputReadOnly => FrameExportErrorCode::OutputReadOnly,
            // `check_destination` gives only the four codes of checks 7 to 11.
            _ => FrameExportErrorCode::OutputPathInvalid,
        })
    })?;
    if !matches!(inspect(source), PathFacts::File { .. }) {
        return Err(FrameExportError::new(FrameExportErrorCode::SourceNotFound));
    }
    check_source_revision(&ExportSourceWire {
        id: String::new(),
        path: request.source_path.clone(),
        expected_revision: Some(request.source_revision),
    })
    .map_err(|_| FrameExportError::new(FrameExportErrorCode::SourceRevisionMismatch))
}

/// The FLV input of the frame: the input of an export of one piece that starts at the PTS of the
/// request (`commands::export::flv_input_for`). A source for which an export would keep the input
/// seek fails here with `flvInputUnavailable`, so the command never reads the whole file
/// (ADR 069). The log of `flv_input_for` names the reason.
fn locate_frame_flv_input(
    request: &FrameExportRequestWire,
    ffprobe: &Path,
    source: &Path,
    source_probe: &MediaProbe,
    place: FlvPlace<'_>,
    preview_windows: &PreviewWindows,
    cancel: &AtomicBool,
) -> Result<crate::ffmpeg::export::flv_input::FlvInput, FrameExportError> {
    let end = request
        .pts
        .value()
        .checked_add(1)
        .map(Pts::new)
        .ok_or_else(|| FrameExportError::new(FrameExportErrorCode::PositionInvalid))?;
    let pieces = [SegmentBoundary {
        source: 0,
        in_pts: request.pts,
        out_pts: end,
    }];
    let inputs = [vec![0]];
    let located = flv_input_for(
        ffprobe,
        source,
        source_probe,
        SourcePieces {
            pieces: &pieces,
            inputs: &inputs,
        },
        // The frame reads no audio, so the slice check decodes no audio.
        ExportStreams::VideoOnly,
        place,
        preview_windows,
        cancel,
    )
    .map_err(|error| match error.code {
        ExportErrorCode::Canceled => FrameExportError::new(FrameExportErrorCode::Canceled),
        // The strict locate found that the file no longer holds the recorded revision.
        ExportErrorCode::SourceRevisionMismatch => {
            FrameExportError::new(FrameExportErrorCode::SourceRevisionMismatch)
        }
        _ => FrameExportError::with_optional_detail(
            FrameExportErrorCode::FlvInputUnavailable,
            error.detail,
        ),
    })?;
    located.ok_or_else(|| FrameExportError::new(FrameExportErrorCode::FlvInputUnavailable))
}

/// Run `process` with a watch that stops it when the exit sets `cancel`, or when it runs for
/// longer than `limit`. Answers the outcome of the process, and whether the process had not ended
/// at the limit: the watch stopped it, or it ended after the limit. The caller then fails the
/// command as timed out, whatever the exit status is.
///
/// The process guard of [`run_export_process`] reads one flag. The watch sets that flag for both
/// reasons, and records which one it was, so a limit is not reported as a cancel.
fn run_within_limit<Process>(
    process: Process,
    ffmpeg: &Path,
    arguments: &[String],
    working_directory: Option<&Path>,
    cancel: &AtomicBool,
    limit: Duration,
) -> (io::Result<ExportProcessOutcome>, bool)
where
    Process: FnOnce(ExportProcessRequest<'_>) -> io::Result<ExportProcessOutcome>,
{
    let started = Instant::now();
    let stop = AtomicBool::new(cancel.load(Ordering::SeqCst));
    let done = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);
    let outcome = std::thread::scope(|scope| {
        scope.spawn(|| {
            let deadline = Instant::now() + limit;
            while !done.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) {
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                if Instant::now() >= deadline {
                    timed_out.store(true, Ordering::SeqCst);
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(FRAME_POLL_INTERVAL);
            }
        });
        // The watch stops also when the process panics.
        let _done = SetOnDrop(&done);
        process(ExportProcessRequest {
            ffmpeg,
            arguments,
            audio_arguments: None,
            working_directory,
            cancel: &stop,
            poll: FRAME_POLL_INTERVAL,
        })
    });
    // The one decision of the limit (ADR 069): the watch stopped the process at the limit, or
    // the process ended only after the limit, before the watch woke up. Either way it had not
    // ended 60 seconds after it started, and its exit status does not count.
    let late = timed_out.load(Ordering::SeqCst) || started.elapsed() >= limit;
    (outcome, late)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::export::tests::{real_tools, TestDirectory};
    use crate::ffmpeg::export::frame::test_support::rgb_png;
    use crate::ffmpeg::locate::ExecutableOrigin;
    use crate::time::Rational;
    use std::fs;

    /// The revision of the file at `path`, as the import reads it.
    fn revision_of(path: &Path) -> ExpectedSourceRevisionWire {
        let media = crate::commands::media::validate_media(&path.to_string_lossy()).unwrap();
        ExpectedSourceRevisionWire {
            size: media.size,
            mtime: media.mtime,
        }
    }

    /// A directory with a source file `clip.mp4` of a few bytes, and the request of a frame of it
    /// as `out.png` in the same directory.
    struct Fixture {
        directory: TestDirectory,
        source: PathBuf,
        request: FrameExportRequestWire,
    }

    fn fixture() -> Fixture {
        let directory = TestDirectory::new();
        let source = directory.path.join("clip.mp4");
        fs::write(&source, b"not a real video").unwrap();
        let request = FrameExportRequestWire {
            source_path: source.to_string_lossy().into_owned(),
            source_revision: revision_of(&source),
            pts: Pts::new(90_000),
            session_source_paths: vec![source.to_string_lossy().into_owned()],
            output_path: directory
                .path
                .join("out.png")
                .to_string_lossy()
                .into_owned(),
        };
        Fixture {
            directory,
            source,
            request,
        }
    }

    fn mp4_probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: None,
            bit_depth: None,
            width: 64,
            height: 48,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: None,
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: None,
            r_frame_rate: None,
            reported_frame_count: None,
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: None,
            audio_streams: Vec::new(),
        }
    }

    fn fake_tools(_: &Path) -> Result<FfmpegPaths, LocateError> {
        Ok(FfmpegPaths {
            ffmpeg: PathBuf::from("/fake/ffmpeg"),
            ffprobe: PathBuf::from("/fake/ffprobe"),
            origin: ExecutableOrigin::Path,
        })
    }

    fn no_tools(_: &Path) -> Result<FfmpegPaths, LocateError> {
        panic!("a refusal must not look for ffmpeg");
    }

    fn fake_probe(_: &Path, _: &Path, _: &AtomicBool) -> Result<MediaProbe, ProbeError> {
        Ok(mp4_probe())
    }

    /// An outcome of a process that exited with `success`.
    fn exited(success: bool) -> ExportProcessOutcome {
        ExportProcessOutcome {
            status: ExportProcessStatus::Exited {
                code: Some(i32::from(!success)),
                success,
            },
            stderr: b"ffmpeg said this".to_vec(),
            last_progress: None,
        }
    }

    /// A process that writes `bytes` into its output, the last argument, and exits zero.
    fn writing(
        bytes: Vec<u8>,
    ) -> impl FnOnce(ExportProcessRequest<'_>) -> io::Result<ExportProcessOutcome> {
        move |request| {
            fs::write(request.arguments.last().unwrap(), bytes).unwrap();
            Ok(exited(true))
        }
    }

    /// The picture that the check accepts for the 64x48 source of `mp4_probe`.
    fn good_png() -> Vec<u8> {
        rgb_png(64, 48)
    }

    /// The limits of preparation in production. The fake steps answer at once.
    const LIMITS: PreparationLimits = PreparationLimits::PRODUCTION;

    /// Runs the command for `request` with `process`, the fake tools and the fake probe.
    fn run(
        directory: &TestDirectory,
        request: &FrameExportRequestWire,
        cancel: &AtomicBool,
        limit: Duration,
        process: impl FnOnce(ExportProcessRequest<'_>) -> io::Result<ExportProcessOutcome>,
    ) -> Result<String, FrameExportError> {
        export_frame_with(
            FramePreparation {
                request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel,
                preview_windows: &Arc::new(PreviewWindows::default()),
                limits: LIMITS,
                ffmpeg_limit: limit,
            },
            fake_tools,
            fake_probe,
            process,
        )
    }

    /// Runs only the refusals: the tools must not be looked for.
    fn refusal_of(
        directory: &TestDirectory,
        request: &FrameExportRequestWire,
    ) -> FrameExportErrorCode {
        export_frame_with(
            FramePreparation {
                request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &Arc::new(PreviewWindows::default()),
                limits: LIMITS,
                ffmpeg_limit: FRAME_FFMPEG_LIMIT,
            },
            no_tools,
            fake_probe,
            |_| panic!("a refusal must not start ffmpeg"),
        )
        .unwrap_err()
        .code
    }

    /// The names in `directory` other than the source, so a test sees a stray temporary file.
    fn other_files(fixture: &Fixture) -> Vec<String> {
        fs::read_dir(&fixture.directory.path)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "clip.mp4" && name != "cache")
            .collect()
    }

    #[test]
    fn the_request_crosses_in_camel_case_with_the_pts_as_a_string() {
        let request: FrameExportRequestWire = serde_json::from_value(serde_json::json!({
            "sourcePath": "/m/a.mp4",
            "sourceRevision": { "size": 10, "mtime": 20 },
            "pts": "9007199254740993",
            "sessionSourcePaths": ["/m/a.mp4", "/m/b.mov"],
            "outputPath": "/m/a_00-00-01-000.png",
        }))
        .unwrap();
        assert_eq!(request.pts, Pts::new(9_007_199_254_740_993));
        assert_eq!(request.session_source_paths.len(), 2);
        // An unknown field and a PTS as a number are faults of the frontend.
        assert!(
            serde_json::from_value::<FrameExportRequestWire>(serde_json::json!({
                "sourcePath": "/m/a.mp4",
                "sourceRevision": { "size": 10, "mtime": 20 },
                "pts": 5,
                "sessionSourcePaths": [],
                "outputPath": "/m/a.png",
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<FrameExportRequestWire>(serde_json::json!({
                "sourcePath": "/m/a.mp4",
                "sourceRevision": { "size": 10, "mtime": 20 },
                "pts": "5",
                "sessionSourcePaths": [],
                "outputPath": "/m/a.png",
                "extra": true,
            }))
            .is_err()
        );
    }

    #[test]
    fn the_answer_and_an_error_cross_in_camel_case() {
        assert_eq!(
            serde_json::to_value(FrameExportDone {
                output_path: "/m/a.png".to_owned()
            })
            .unwrap(),
            serde_json::json!({ "outputPath": "/m/a.png" })
        );
        assert_eq!(
            serde_json::to_value(FrameExportError {
                code: FrameExportErrorCode::FfmpegProcessFailed,
                detail: Some("tail".to_owned()),
                exit_code: Some(1),
            })
            .unwrap(),
            serde_json::json!({ "code": "ffmpegProcessFailed", "detail": "tail", "exitCode": 1 })
        );
        assert_eq!(
            serde_json::to_value(FrameExportError::new(FrameExportErrorCode::OutputNotPng))
                .unwrap(),
            serde_json::json!({ "code": "outputNotPng" })
        );
    }

    #[test]
    fn an_output_that_does_not_end_in_png_is_refused() {
        let mut fixture = fixture();
        fixture.request.output_path = fixture
            .directory
            .path
            .join("out.jpg")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputNotPng
        );
    }

    #[test]
    fn an_output_that_fails_the_destination_check_of_an_export_is_refused() {
        let mut fixture = fixture();
        // Not absolute.
        fixture.request.output_path = "out.png".to_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputPathInvalid
        );
        // A folder that does not exist.
        fixture.request.output_path = fixture
            .directory
            .path
            .join("missing")
            .join("out.png")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputDirectoryMissing
        );
        // A folder.
        let folder = fixture.directory.path.join("folder.png");
        fs::create_dir(&folder).unwrap();
        fixture.request.output_path = folder.to_string_lossy().into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputPathInvalid
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_output_that_the_user_protected_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let mut fixture = fixture();
        let protected = fixture.directory.path.join("protected.png");
        fs::write(&protected, b"old").unwrap();
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o444)).unwrap();
        fixture.request.output_path = protected.to_string_lossy().into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputReadOnly
        );
    }

    #[test]
    fn an_output_that_is_a_source_of_the_session_by_its_path_is_refused() {
        let mut fixture = fixture();
        // Another source of the session, which a PNG file can be.
        let other = fixture.directory.path.join("still.png");
        fs::write(&other, b"an image source").unwrap();
        fixture
            .request
            .session_source_paths
            .push(other.to_string_lossy().into_owned());
        fixture.request.output_path = other.to_string_lossy().into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputEqualsSource
        );
    }

    #[test]
    fn an_output_that_is_a_source_of_the_session_by_its_file_is_refused() {
        let mut fixture = fixture();
        let other = fixture.directory.path.join("still.png");
        fs::write(&other, b"an image source").unwrap();
        let link = fixture.directory.path.join("link.png");
        fs::hard_link(&other, &link).unwrap();
        fixture
            .request
            .session_source_paths
            .push(other.to_string_lossy().into_owned());
        fixture.request.output_path = link.to_string_lossy().into_owned();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::OutputEqualsSource
        );
    }

    #[test]
    fn a_source_whose_revision_changed_is_refused() {
        let mut fixture = fixture();
        fixture.request.source_revision.size += 1;
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::SourceRevisionMismatch
        );
    }

    #[test]
    fn a_source_that_is_gone_is_refused() {
        let fixture = fixture();
        fs::remove_file(&fixture.source).unwrap();
        assert_eq!(
            refusal_of(&fixture.directory, &fixture.request),
            FrameExportErrorCode::SourceNotFound
        );
    }

    #[test]
    fn a_second_start_while_one_runs_is_refused_and_the_exit_reads_as_canceled() {
        let frames = Arc::new(FrameExports::default());
        let running = frames.begin().unwrap();
        assert_eq!(
            frames.begin().map(|_| ()).map_err(refusal_error),
            Err(FrameExportError::new(
                FrameExportErrorCode::FrameExportRunning
            ))
        );
        drop(running);
        frames.close_for_exit();
        assert_eq!(
            frames.begin().map(|_| ()).map_err(refusal_error),
            Err(FrameExportError::new(FrameExportErrorCode::Canceled))
        );
    }

    #[test]
    fn a_picture_that_passes_the_check_is_renamed_onto_the_destination() {
        let fixture = fixture();
        let written = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            FRAME_FFMPEG_LIMIT,
            writing(good_png()),
        )
        .unwrap();
        assert_eq!(written, fixture.request.output_path);
        assert_eq!(fs::read(&fixture.request.output_path).unwrap(), good_png());
        assert_eq!(other_files(&fixture), ["out.png"]);
    }

    #[test]
    fn the_process_reads_the_source_and_writes_the_reservation_beside_the_destination() {
        let fixture = fixture();
        let mut seen: Vec<String> = Vec::new();
        let _ = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            FRAME_FFMPEG_LIMIT,
            |request| {
                seen = request.arguments.to_vec();
                assert!(
                    request.working_directory.is_none(),
                    "a file needs no work directory"
                );
                Ok(exited(false))
            },
        );
        let output = PathBuf::from(seen.last().unwrap());
        assert_ne!(output, PathBuf::from(&fixture.request.output_path));
        assert_eq!(output.parent(), Some(fixture.directory.path.as_path()));
        let source = fixture.source.to_string_lossy().into_owned();
        // 1 s less 5 s is not above zero, so the input has no seek.
        assert!(seen
            .windows(2)
            .any(|pair| pair[0] == "-i" && pair[1] == source));
        assert!(!seen.iter().any(|argument| argument == "-ss"));
    }

    #[test]
    fn a_picture_of_another_size_publishes_nothing_and_removes_the_temporary_file() {
        let fixture = fixture();
        let error = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            FRAME_FFMPEG_LIMIT,
            writing(rgb_png(64, 50)),
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::ImageCheckFailed);
        assert!(error.detail.unwrap().contains("64x48"));
        assert!(
            other_files(&fixture).is_empty(),
            "{:?}",
            other_files(&fixture)
        );
    }

    #[test]
    fn a_file_that_is_not_one_complete_png_fails_the_image_check() {
        // A file that is no PNG, two pictures, and a picture cut short.
        let mut two = good_png();
        two.extend(good_png());
        let mut short = good_png();
        short.truncate(short.len() - 3);
        for bytes in [b"picture".to_vec(), two, short] {
            let fixture = fixture();
            let error = run(
                &fixture.directory,
                &fixture.request,
                &AtomicBool::new(false),
                FRAME_FFMPEG_LIMIT,
                writing(bytes),
            )
            .unwrap_err();
            assert_eq!(error.code, FrameExportErrorCode::ImageCheckFailed);
            assert!(other_files(&fixture).is_empty());
        }
    }

    #[test]
    fn a_process_that_writes_no_picture_reports_no_frame() {
        let fixture = fixture();
        let error = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            FRAME_FFMPEG_LIMIT,
            |_| Ok(exited(true)),
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::NoFrame);
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn a_process_that_fails_reports_its_stderr_and_exit_code() {
        let fixture = fixture();
        let error = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            FRAME_FFMPEG_LIMIT,
            |_| Ok(exited(false)),
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::FfmpegProcessFailed);
        assert_eq!(error.detail.as_deref(), Some("ffmpeg said this"));
        assert_eq!(error.exit_code, Some(1));
        assert!(other_files(&fixture).is_empty());
    }

    /// A process that runs until its flag is set, as the process guard does, and then reports a
    /// cancel.
    fn until_stopped(request: ExportProcessRequest<'_>) -> io::Result<ExportProcessOutcome> {
        while !request.cancel.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(ExportProcessOutcome {
            status: ExportProcessStatus::Canceled,
            stderr: Vec::new(),
            last_progress: None,
        })
    }

    #[test]
    fn a_process_that_runs_past_the_limit_is_stopped_and_reported_as_timed_out() {
        let fixture = fixture();
        let started = Instant::now();
        let error = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            Duration::from_millis(150),
            until_stopped,
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::FfmpegTimedOut);
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn a_successful_exit_after_the_limit_publishes_nothing() {
        // The process ends with success just after the limit, before or after the watch wakes up:
        // it had not ended at the limit, so the command fails as timed out (ADR 069).
        let fixture = fixture();
        let limit = Duration::from_millis(150);
        let error = run(
            &fixture.directory,
            &fixture.request,
            &AtomicBool::new(false),
            limit,
            move |request| {
                std::thread::sleep(limit + Duration::from_millis(20));
                fs::write(request.arguments.last().unwrap(), good_png()).unwrap();
                Ok(exited(true))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::FfmpegTimedOut);
        assert!(!Path::new(&fixture.request.output_path).exists());
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn the_limit_of_the_process_is_decided_in_one_place() {
        // A process that ends before the limit is not late, one that ends after it is.
        let flag = AtomicBool::new(false);
        let quick = run_within_limit(
            |_| Ok(exited(true)),
            Path::new("ffmpeg"),
            &[],
            None,
            &flag,
            Duration::from_secs(5),
        );
        assert!(!quick.1);
        let late = run_within_limit(
            |_| {
                std::thread::sleep(Duration::from_millis(60));
                Ok(exited(true))
            },
            Path::new("ffmpeg"),
            &[],
            None,
            &flag,
            Duration::from_millis(30),
        );
        assert!(late.1);
    }

    #[test]
    fn the_exit_stops_the_process_and_reports_a_cancel() {
        let fixture = fixture();
        let cancel = AtomicBool::new(false);
        let error = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                cancel.store(true, Ordering::SeqCst);
            });
            run(
                &fixture.directory,
                &fixture.request,
                &cancel,
                FRAME_FFMPEG_LIMIT,
                until_stopped,
            )
        })
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::Canceled);
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn a_cancel_after_the_process_publishes_nothing() {
        let fixture = fixture();
        let cancel = AtomicBool::new(false);
        let error = run(
            &fixture.directory,
            &fixture.request,
            &cancel,
            FRAME_FFMPEG_LIMIT,
            |request| {
                fs::write(request.arguments.last().unwrap(), good_png()).unwrap();
                // The exit arrives as FFmpeg ends, after the last poll of the guard.
                cancel.store(true, Ordering::SeqCst);
                Ok(exited(true))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::Canceled);
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn the_rename_waits_at_most_two_seconds() {
        // ADR 069: the wait of the rename on Windows must fit in the exit wait of ADR 017.
        assert_eq!(FRAME_PUBLISH_BUDGET, Duration::from_secs(2));
    }

    /// Limits of preparation of a fraction of a second, for a step that never answers.
    const SHORT_LIMITS: PreparationLimits = PreparationLimits::for_test(
        Duration::from_millis(200),
        Duration::from_millis(100),
        Duration::from_millis(10),
    );

    /// Runs the command with a probe that blocks until `release` gets a value or closes, and
    /// ignores the stop flag, as a read on a share that stopped answering does.
    fn run_blocked(
        fixture: &Fixture,
        cancel: &AtomicBool,
        release: std::sync::mpsc::Receiver<()>,
    ) -> Result<String, FrameExportError> {
        export_frame_with(
            FramePreparation {
                request: &fixture.request,
                app_data_directory: &fixture.directory.path,
                cache_directory: &fixture.directory.path.join("cache"),
                cancel,
                preview_windows: &Arc::new(PreviewWindows::default()),
                limits: SHORT_LIMITS,
                ffmpeg_limit: FRAME_FFMPEG_LIMIT,
            },
            fake_tools,
            move |_: &Path, _: &Path, _: &AtomicBool| {
                let _ = release.recv();
                Ok(mp4_probe())
            },
            |_| panic!("FFmpeg must not start for a preparation that did not answer"),
        )
    }

    #[test]
    fn a_step_before_ffmpeg_that_never_answers_ends_the_command_at_the_limit() {
        let fixture = fixture();
        let (release, blocked) = std::sync::mpsc::channel();
        let started = Instant::now();
        let error = run_blocked(&fixture, &AtomicBool::new(false), blocked).unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::PreparationTimedOut);
        // The detail names the step that did not answer.
        assert!(error.detail.is_some());
        assert!(started.elapsed() < Duration::from_secs(2));
        // The step answers late. Its helper finds its stop flag set, so it reserves nothing
        // beside the destination.
        release.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(other_files(&fixture).is_empty());
    }

    #[test]
    fn the_exit_ends_a_preparation_that_never_answers_within_the_grace() {
        let fixture = fixture();
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let error = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(50));
                cancel.store(true, Ordering::SeqCst);
            });
            run_blocked(&fixture, &cancel, blocked)
        })
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::Canceled);
        assert!(started.elapsed() < Duration::from_millis(190));
        drop(release);
        std::thread::sleep(Duration::from_millis(100));
        assert!(other_files(&fixture).is_empty());
    }

    /// Runs `ffmpeg` with `arguments` and asserts that it succeeds.
    fn run_tool(tool: &Path, arguments: &[&str]) -> Vec<u8> {
        let output = crate::procutil::command_without_console(tool)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    /// The first pixel of the first picture that `ffmpeg` decodes from `input` with `filter`, as
    /// 8-bit RGB.
    fn first_pixel(ffmpeg: &Path, input: &Path, filter: Option<&str>) -> [u8; 3] {
        let input = input.to_string_lossy().into_owned();
        let mut arguments = vec!["-hide_banner", "-loglevel", "error", "-i", &input];
        if let Some(filter) = filter {
            arguments.extend(["-vf", filter]);
        }
        arguments.extend([
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]);
        let bytes = run_tool(ffmpeg, &arguments);
        [bytes[0], bytes[1], bytes[2]]
    }

    /// The first pixel of frame `index` of `source`.
    fn frame_pixel(ffmpeg: &Path, source: &Path, index: u32) -> [u8; 3] {
        first_pixel(ffmpeg, source, Some(&format!("select=eq(n\\,{index})")))
    }

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2)
    }

    /// With a real ffmpeg: the image is the first frame whose PTS is not before the request, read
    /// with and without an input seek, and a request past the last frame writes nothing.
    #[test]
    fn a_real_ffmpeg_writes_the_first_frame_that_is_not_before_the_pts() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        // 35 frames at 5 per second, each one 6 steps of luma lighter than the one before, in a
        // lossless codec, so the test can tell each frame by its colour. Matroska counts in
        // milliseconds, so frame n has the PTS 200 n.
        let source = directory.path.join("ramp.mkv");
        run_tool(
            &ffmpeg,
            &[
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=gray:s=64x48:r=5:d=7,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128",
                "-c:v",
                "ffv1",
                &source.to_string_lossy(),
            ],
        );
        let source_text = source.to_string_lossy().into_owned();
        let tools = FfmpegPaths {
            ffmpeg: ffmpeg.clone(),
            ffprobe,
            origin: ExecutableOrigin::Path,
        };
        let export = |pts: i64, name: &str| {
            let request = FrameExportRequestWire {
                source_path: source_text.clone(),
                source_revision: revision_of(&source),
                pts: Pts::new(pts),
                session_source_paths: vec![source_text.clone()],
                output_path: directory.path.join(name).to_string_lossy().into_owned(),
            };
            let tools = tools.clone();
            export_frame_with(
                FramePreparation {
                    request: &request,
                    app_data_directory: &directory.path,
                    cache_directory: &directory.path.join("cache"),
                    cancel: &AtomicBool::new(false),
                    preview_windows: &Arc::new(PreviewWindows::default()),
                    limits: LIMITS,
                    ffmpeg_limit: FRAME_FFMPEG_LIMIT,
                },
                move |_: &Path| Ok(tools),
                ffmpeg::probe_media_until_canceled,
                |process| run_export_process(process, |_: &ProgressSnapshot| {}),
            )
            .map(PathBuf::from)
        };

        // Between frame 2 (400) and frame 3 (600), with no seek: frame 3.
        let early = export(450, "early.png").unwrap();
        let pixel = first_pixel(&ffmpeg, &early, None);
        assert!(close(pixel, frame_pixel(&ffmpeg, &source, 3)), "{pixel:?}");
        assert!(!close(pixel, frame_pixel(&ffmpeg, &source, 2)), "{pixel:?}");

        // Between frame 30 (6000) and frame 31 (6200), with a seek of 1.1 s: frame 31.
        let late = export(6_100, "late.png").unwrap();
        let pixel = first_pixel(&ffmpeg, &late, None);
        assert!(close(pixel, frame_pixel(&ffmpeg, &source, 31)), "{pixel:?}");
        assert!(
            !close(pixel, frame_pixel(&ffmpeg, &source, 30)),
            "{pixel:?}"
        );
        assert!(
            !close(pixel, frame_pixel(&ffmpeg, &source, 32)),
            "{pixel:?}"
        );

        // On the PTS of frame 31 itself: that frame, which is not before the request.
        let exact = export(6_200, "exact.png").unwrap();
        let pixel = first_pixel(&ffmpeg, &exact, None);
        assert!(close(pixel, frame_pixel(&ffmpeg, &source, 31)), "{pixel:?}");

        // The file is one complete PNG picture of the display size, by the check of the command.
        assert_eq!(verify_png_file(&exact, 64, 48), Ok(()));

        // Past the last frame (6800): no frame, and no file.
        let error = export(10_000, "past.png").unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::NoFrame);
        assert!(!directory.path.join("past.png").exists());
    }

    /// Writes a lossless H.264 FLV of 35 frames at 5 per second with a keyframe each second, each
    /// frame 6 steps of luma lighter than the one before. FLV counts in milliseconds, so frame n
    /// has the PTS 200 n.
    fn write_ramp_flv(ffmpeg: &Path, path: &Path) {
        run_tool(
            ffmpeg,
            &[
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=gray:s=64x48:r=5:d=7,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128",
                "-c:v",
                "libx264",
                "-qp",
                "0",
                "-g",
                "5",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-f",
                "flv",
                &path.to_string_lossy(),
            ],
        );
    }

    /// The work directories that remain in the cache directory `cache`.
    fn work_directories(cache: &Path) -> Vec<PathBuf> {
        fs::read_dir(app_cache::work_directory(cache))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    /// The request of the frame at `pts` of `source`, written as `name` in `directory`.
    fn request_for(
        source: &Path,
        directory: &Path,
        pts: i64,
        name: &str,
    ) -> FrameExportRequestWire {
        let text = source.to_string_lossy().into_owned();
        FrameExportRequestWire {
            source_path: text.clone(),
            source_revision: revision_of(source),
            pts: Pts::new(pts),
            session_source_paths: vec![text],
            output_path: directory.join(name).to_string_lossy().into_owned(),
        }
    }

    /// With a real ffmpeg: an FLV goes through the production path of ADR 046 with a cold
    /// keyframe cache: the revision, the reader and its cache, the work directory, the head, the
    /// slice check, and the slice from the keyframe in front of the seek position.
    #[test]
    fn a_real_ffmpeg_writes_the_frame_of_an_flv_through_its_head_and_slice() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("ramp.flv");
        write_ramp_flv(&ffmpeg, &source);
        let cache = directory.path.join("cache");
        assert!(!cache.exists(), "the keyframe cache starts cold");
        let request = request_for(&source, &directory.path, 6_100, "flv.png");
        let tools = FfmpegPaths {
            ffmpeg: ffmpeg.clone(),
            ffprobe,
            origin: ExecutableOrigin::Path,
        };
        let mut arguments: Vec<String> = Vec::new();
        let written = export_frame_with(
            FramePreparation {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &cache,
                cancel: &AtomicBool::new(false),
                preview_windows: &Arc::new(PreviewWindows::default()),
                limits: LIMITS,
                ffmpeg_limit: FRAME_FFMPEG_LIMIT,
            },
            move |_: &Path| Ok(tools),
            ffmpeg::probe_media_until_canceled,
            |process| {
                arguments = process.arguments.to_vec();
                assert!(
                    process.working_directory.is_some(),
                    "an FLV runs in its work directory"
                );
                run_export_process(process, |_: &ProgressSnapshot| {})
            },
        )
        .map(PathBuf::from)
        .unwrap();

        // The input is the head and a slice, with no input seek.
        assert!(arguments
            .iter()
            .any(|argument| argument.starts_with("concat:h0.flv|subfile")));
        assert!(!arguments.iter().any(|argument| argument == "-ss"));
        // Between frame 30 (6000) and frame 31 (6200): frame 31.
        let pixel = first_pixel(&ffmpeg, &written, None);
        assert!(close(pixel, frame_pixel(&ffmpeg, &source, 31)), "{pixel:?}");
        assert!(
            !close(pixel, frame_pixel(&ffmpeg, &source, 30)),
            "{pixel:?}"
        );
        assert_eq!(verify_png_file(&written, 64, 48), Ok(()));
        // The reader filled its cache, and the work directory is gone.
        assert!(cache.join(crate::flv::cache::CACHE_DIR_NAME).is_dir());
        assert!(
            work_directories(&cache).is_empty(),
            "{:?}",
            work_directories(&cache)
        );
    }

    /// A child that prints nothing and never ends, run through the production process guard: it
    /// ends at the limit, and the command leaves no process, no temporary file and no work
    /// directory. The child stands for FFmpeg, and an FLV source gives the command a work
    /// directory.
    #[cfg(unix)]
    #[test]
    fn a_silent_child_that_never_ends_is_killed_at_the_limit_and_leaves_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("ramp.flv");
        write_ramp_flv(&ffmpeg, &source);
        let pid_file = directory.path.join("child.pid");
        let silent = directory.path.join("silent-ffmpeg");
        fs::write(
            &silent,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 600\n",
                pid_file.to_string_lossy()
            ),
        )
        .unwrap();
        fs::set_permissions(&silent, fs::Permissions::from_mode(0o755)).unwrap();
        let cache = directory.path.join("cache");
        let request = request_for(&source, &directory.path, 6_100, "silent.png");
        let tools = FfmpegPaths {
            ffmpeg: silent,
            ffprobe,
            origin: ExecutableOrigin::Path,
        };
        let limit = Duration::from_secs(1);
        let started = Instant::now();
        let error = export_frame_with(
            FramePreparation {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &cache,
                cancel: &AtomicBool::new(false),
                preview_windows: &Arc::new(PreviewWindows::default()),
                limits: LIMITS,
                ffmpeg_limit: limit,
            },
            move |_: &Path| Ok(tools),
            ffmpeg::probe_media_until_canceled,
            |process| run_export_process(process, |_: &ProgressSnapshot| {}),
        )
        .unwrap_err();
        assert_eq!(error.code, FrameExportErrorCode::FfmpegTimedOut);
        assert!(started.elapsed() < limit + Duration::from_secs(20));

        // The child was killed and reaped: no process has its id any more.
        let pid = fs::read_to_string(&pid_file).unwrap().trim().to_owned();
        let alive = crate::procutil::command_without_console("kill")
            .args(["-0", &pid])
            .status()
            .unwrap();
        assert!(!alive.success(), "the child {pid} still runs");
        // No temporary file beside the destination, and no work directory.
        let left: Vec<String> = fs::read_dir(&directory.path)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("silent.png"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        assert!(
            work_directories(&cache).is_empty(),
            "{:?}",
            work_directories(&cache)
        );
    }
}
