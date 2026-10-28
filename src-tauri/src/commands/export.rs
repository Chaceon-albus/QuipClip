//! Tauri command surface for the ADR 016 export orchestrator.
//!
//! Every stage of the render pipeline lives in `ffmpeg::export` and is tested there. This
//! module is the one place that composes them in order, and it owns the two commands the
//! frontend calls -- `start_export` and `cancel_export` -- plus the single event,
//! `export:progress`, that every report of a running export crosses on. The wire shapes are
//! pinned by `src/features/export/types.ts` and parsed strictly by
//! `src/features/export/validation.ts`, so each one is held by a test here rather than left
//! to match by convention.
//!
//! # What is rejected, and what is reported by event
//!
//! The command decides only what it can decide at once, and rejects the promise for it: an
//! invalid preset, a missing application data directory, and an exit that began. Then it
//! answers with the run id ([`ExportSubmission`]): the run starts at once, or waits in the queue
//! of [`ExportRegistry`] until the runs before it end (ADR 049). A run reports `preparing` when it
//! takes the slot. Preparation runs after that: the discovery of ffmpeg, the revision check, the
//! re-probe, every preflight check in [`build_plan`], the option probe of ADR 055, and the output
//! reservation. A failure there
//! is a `failed` event on the run, as every later failure is. The frontend therefore holds the
//! run id for the whole run, and it names the run in every cancel.
//!
//! Preparation runs on a helper thread, and the export thread watches it
//! ([`run_export_job_with`]). Some of its steps wait in the file system, and a call that a share
//! holds cannot be interrupted. The watch bounds them: a cancel ends the run within
//! [`PREPARATION_CANCEL_GRACE`], and a preparation that lasts longer than
//! [`PREPARATION_TIMEOUT`] ends as `preparationTimedOut`. In both cases the run releases the
//! slot, and the runs in the queue go on.
//!
//! # The five obligations no type enforces
//!
//! The compose order in [`prepare_export_with`] and [`run_export_with`] is not free. Five of
//! its steps are load-bearing and nothing in the type system holds them:
//!
//! 1. [`build_plan`] runs **before** [`PendingOutput::reserve`]. A destination that is a
//!    directory reserves successfully and fails only at the rename, after a whole encode;
//!    `build_plan` rejects it in preflight as `outputPathInvalid`. The test that holds the
//!    order is the one with a destination whose parent directory is missing, because that is
//!    the destination the two orders answer differently: `build_plan` reports
//!    `outputDirectoryMissing`, and a reservation attempted first fails as
//!    `outputNotWritable`. A destination the user protected against writing is the same
//!    obligation from the other side: the reservation succeeds on it too, because it only
//!    touches the parent directory, and `build_plan` rejects it as `outputReadOnly` rather than
//!    letting the rename discard a finished encode.
//! 2. [`choose_graph_shape`] and [`build_arguments`] both receive [`PendingOutput::path`],
//!    never `plan.destination`, and so does [`build_copy_arguments`] for an export without video
//!    that copies its audio (ADR 048). ffmpeg writes the reservation, and the rename that
//!    publishes the destination happens after the process has exited.
//! 3. [`choose_graph_shape`] is called once and its result is passed to **both**
//!    [`encoder_graph`] and [`build_arguments`]. The shapes disagree about how many
//!    inputs the graph's labels refer to, so a mismatch produces a command ffmpeg rejects. The
//!    command of an audio process (ADR 043) follows the same rule with its own shape:
//!    [`choose_audio_graph_shape`], [`build_audio_graph`] and [`build_audio_arguments`]. A command
//!    that copies the audio (ADR 048) has no graph and no shape: it opens the one input of its one
//!    segment.
//! 4. A zero exit status is not a successful export. `reserve` creates the reserved file
//!    before ffmpeg starts, so ADR 014 requires `-y`; without it ffmpeg refuses the existing
//!    file, writes nothing, and still exits zero. [`verified_frame_count`] is what separates
//!    that outcome from a real one for an export with video. An export without video writes
//!    no frames to count, and [`verified_audio_output`] separates the two outcomes for it: it
//!    reads the finished file back through ffprobe. An export with video that copies its audio
//!    also reads its file back, for its streams ([`verified_copy_streams`], ADR 048).
//! 5. The cancel flag is read once more after the process exits, after the success check, and
//!    **before** the rename. ADR 016 requires it: without that read, a cancel arriving in the
//!    last seconds of an encode still renames the output over the file the user chose while
//!    the interface says the export was cancelled.
//!
//! The `encoderUnavailable` pre-check ADR 016 describes is deliberately not implemented here.
//! It needs its own `ffmpeg -version` spawn and a capability-cache read, and it is a separate
//! unit; the error code stays reserved, as it is in `ffmpeg::export`.

use crate::ffmpeg::export::flv_input::{
    locate_flv_input, FlvInput, FlvInputFallback, FlvInputRequest,
};
use crate::ffmpeg::export::graph_file::{
    probe_graph_file_option, GraphFile, GraphFileOption, GraphFileProbeError, AUDIO_GRAPH_FILE,
    ENCODER_GRAPH_FILE,
};
use crate::ffmpeg::export::work_directory::{remove_stale_work_directories, ExportWorkDirectory};
use crate::ffmpeg::export::{
    build_arguments, build_audio_arguments, build_audio_graph, build_copy_arguments, build_plan,
    choose_audio_graph_shape, choose_graph_shape, encoder_graph, inspect_path, max_export_pieces,
    run_export_process, verify_audio_output, verify_copied_audio_output, verify_copy_streams,
    AudioOutputMismatch, CopyOutput, ExportAudioMode, ExportErrorCode, ExportPlan,
    ExportProcessOutcome, ExportProcessRequest, ExportProcessStatus, ExportRegistry, ExportSlot,
    ExportStreams, PendingOutput, PlanRequest, PlanSource, ProgressSnapshot, SegmentBoundary,
    Submission, WaitingRun, AUDIO_FILL_MIN_GAP_MILLISECONDS, MAX_EXPORT_SEGMENTS,
    SEEK_MARGIN_SECONDS,
};
use crate::ffmpeg::preview::PreviewWindows;
use crate::ffmpeg::{
    self, AudioFrames, AudioGapRead, AudioProbe, FfmpegPaths, FirstAudioPacket, LocateError,
    MediaProbe, OutputAudioProbe, ProbeError,
};
use crate::settings::{self, Preset};
use crate::time::{pts_seconds, Pts, Rational};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use super::export_journal::{ExportJournal, RunFacts, SequencedEvent};
use super::export_output::PublishedExports;
use super::media::{map_probe_error, ImportMediaErrorCode};
use super::next_run_id;

/// The Tauri event every export run reports through.
const EVENT_NAME: &str = "export:progress";

/// How long the process supervisor sleeps between two looks at the child and the cancel flag.
///
/// This is the whole latency budget of a cancel request and of a progress snapshot reaching
/// the frontend, so it is the caller's choice rather than a constant inside
/// `ffmpeg::export::process`. A tenth of a second is faster than a person perceives a button
/// as unresponsive, and far slower than the rate at which the supervision loop costs anything.
const PROGRESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// `Number.MAX_SAFE_INTEGER`. `totalDurationUs` crosses as a JavaScript number, and the
/// frontend validator rejects a value above this bound outright.
const JAVASCRIPT_MAX_SAFE_INTEGER: i128 = 9_007_199_254_740_991;

/// Microseconds in one second, as the exact factor [`duration_microseconds`] multiplies by.
const MICROSECONDS_PER_SECOND: i128 = 1_000_000;

/// One source of an export request, as the frontend spells it (ADR 053).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSourceWire {
    /// The id the pieces name the source by. Not empty, and unique in the request.
    pub id: String,
    /// The path of the media file.
    pub path: String,
    /// The revision of the source that the segments were marked against, or `None` when the
    /// user chose to export a changed file anyway (ADR 024). Preparation compares it with the
    /// file at `path` when it starts, and refuses a file whose size or whole-second
    /// modification time differs with `sourceRevisionMismatch`, whose detail names this id.
    /// [`check_source_revision`] states what the comparison cannot see. `None` checks nothing.
    #[serde(default)]
    pub expected_revision: Option<ExpectedSourceRevisionWire>,
}

/// One piece of an export request: one interval of one source, as the frontend spells it (ADR
/// 052, ADR 053).
///
/// `ffmpeg::export::SegmentBoundary` carries no serde derives on purpose -- it is a planning
/// type, not a wire type -- so this is the wire form and [`resolve_request`] converts it.
/// Both PTS fields are [`Pts`], which crosses as a canonical decimal **string**: ADR 002 keeps a
/// timestamp exact, and a JavaScript number cannot hold every `i64` a container can report.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPieceWire {
    /// The id of the source in [`ExportRequestWire::sources`].
    pub source_id: String,
    pub in_pts: Pts,
    pub out_pts: Pts,
}

/// The request payload `start_export` accepts, matching `ExportRequest` on the frontend.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequestWire {
    /// The sources that the pieces name. Each one has at least one piece.
    pub sources: Vec<ExportSourceWire>,
    /// The pieces, in export order: each segment in array order, and the pieces of one segment
    /// in sequence order (ADR 052). The backend does not know about clips or segments.
    pub pieces: Vec<ExportPieceWire>,
    /// The number of the user's segments that the pieces come from, from 1 to the number of
    /// pieces. The run reports it as its segment count ([`ExportStart::segment_count`] and the
    /// journal); nothing else reads it.
    pub segment_count: u32,
    pub output_path: String,
    /// The preset to render with, whole, as the setup step showed it when the user confirmed
    /// the export (ADR 049). **Required**, with no default. The command checks it with
    /// [`settings::validate_preset`] before it accepts the run, and the run never reads the
    /// presets of the settings file. A later edit of the preset in the settings therefore does
    /// not change an export that the command accepted.
    pub preset: Preset,
    /// Which streams of the source the export writes. **Required**, with no default: an
    /// absent value would have to stand for one of the three choices, and a frontend that
    /// forgot to send the user's choice would then export a file the user did not ask for and
    /// report a success.
    pub streams: ExportStreams,
    /// Whether the export copies the audio of the source or encodes it (ADR 048). **Required**,
    /// with no default, for the reason of [`Self::streams`]. The plan copies only where
    /// [`crate::ffmpeg::export::copy::decide`] agrees, and otherwise writes the audio as for an
    /// encode, or writes none for a choice of the video only. The value is therefore a request,
    /// and no report of the run repeats it.
    pub audio_mode: ExportAudioMode,
    /// Whether the interface starts a new batch with this run. The export journal then removes
    /// the runs of the earlier batch that ended (`commands::export_journal`). Absent means
    /// `false`: the run joins the batch that the interface shows.
    #[serde(default)]
    pub new_batch: bool,
}

/// A request whose sources and pieces [`resolve_request`] checked.
#[derive(Debug)]
struct ResolvedRequest<'a> {
    /// The sources of the request, in the order of their first piece.
    sources: Vec<&'a ExportSourceWire>,
    /// The pieces, in export order, each naming its source by its index in [`Self::sources`].
    pieces: Vec<SegmentBoundary>,
}

impl ResolvedRequest<'_> {
    /// The pieces of the source `source`, in export order.
    fn pieces_of(&self, source: usize) -> Vec<SegmentBoundary> {
        self.pieces
            .iter()
            .filter(|piece| piece.source == source)
            .copied()
            .collect()
    }
}

/// Check the sources and the pieces of `request`, and order the sources by their first piece.
///
/// The checks run in this order, and the first failure wins:
///
/// 1. No piece -- `noSegments`.
/// 2. More pieces than [`max_export_pieces`] allows for the count of sources -- `tooManySegments`
///    (ADR 053: the limit counts pieces, and each source lowers it by one).
/// 3. No source, an empty id, an id that appears twice, a piece that names an id the list does
///    not hold, or a source that no piece names -- `invalidSources`, with the fault and the id in
///    the detail (ADR 011: a diagnostic, not a sentence for the user).
/// 4. A `segmentCount` of 0, or larger than the number of pieces -- `invalidSegmentCount`.
/// 5. A piece whose In point is not before its Out point -- `invalidSegment`.
///
/// [`build_plan`] checks 1, 2 and 5 again for any other caller. The order of the sources is the
/// order of their first piece, so preparation runs once for each source in that order, and the
/// plan breaks a tie of the canvas in favour of the earlier piece (ADR 053).
fn resolve_request(request: &ExportRequestWire) -> Result<ResolvedRequest<'_>, ExportCommandError> {
    let invalid = |detail: String| {
        Err(ExportCommandError::with_detail(
            ExportErrorCode::InvalidSources,
            detail,
        ))
    };
    if request.pieces.is_empty() {
        return Err(ExportCommandError::new(ExportErrorCode::NoSegments));
    }
    if request.pieces.len() > max_export_pieces(request.sources.len()) {
        return Err(ExportCommandError::new(ExportErrorCode::TooManySegments));
    }
    if request.sources.is_empty() {
        return invalid("no source".to_owned());
    }
    for (index, source) in request.sources.iter().enumerate() {
        if source.id.is_empty() {
            return invalid("empty source id".to_owned());
        }
        if request.sources[..index]
            .iter()
            .any(|earlier| earlier.id == source.id)
        {
            return invalid(format!("duplicate source id: {}", source.id));
        }
    }
    let mut sources: Vec<&ExportSourceWire> = Vec::with_capacity(request.sources.len());
    let mut pieces = Vec::with_capacity(request.pieces.len());
    for piece in &request.pieces {
        let Some(wire) = request
            .sources
            .iter()
            .find(|source| source.id == piece.source_id)
        else {
            return invalid(format!("unknown source id: {}", piece.source_id));
        };
        let index = match sources.iter().position(|known| known.id == wire.id) {
            Some(index) => index,
            None => {
                sources.push(wire);
                sources.len() - 1
            }
        };
        pieces.push(SegmentBoundary {
            source: index,
            in_pts: piece.in_pts,
            out_pts: piece.out_pts,
        });
    }
    if let Some(unused) = request
        .sources
        .iter()
        .find(|source| !sources.iter().any(|used| used.id == source.id))
    {
        return invalid(format!("unused source id: {}", unused.id));
    }
    let segment_count = usize::try_from(request.segment_count).unwrap_or(usize::MAX);
    if segment_count == 0 || segment_count > pieces.len() {
        return Err(ExportCommandError::new(
            ExportErrorCode::InvalidSegmentCount,
        ));
    }
    if pieces.iter().any(|piece| piece.in_pts >= piece.out_pts) {
        return Err(ExportCommandError::new(ExportErrorCode::InvalidSegment));
    }
    Ok(ResolvedRequest { sources, pieces })
}

/// The size and the modification time of a source file, in the form of the revision that
/// `import_media` and `read_source_revision` report (ADR 010).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedSourceRevisionWire {
    pub size: u64,
    /// Seconds since the Unix epoch, as `commands::media` rounds them.
    pub mtime: i64,
}

/// The answer of `start_export`: the id of the run that the command accepted, and whether it
/// waits for the runs before it.
///
/// The command answers before the run prepares. Every later report of the run, a failure of
/// preparation included, is an event on [`EVENT_NAME`] that carries this id. A run that waits
/// reports `preparing` when it takes the slot, and `failed` with `canceled` when a cancel
/// withdraws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSubmission {
    pub run_id: String,
    pub queued: bool,
}

/// The facts of a prepared run.
///
/// The run builds it after preparation and keeps it for its later events. The `started` event
/// reports each fact but the preset id and the stream choice. It is not on the wire as a whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportStart {
    pub run_id: String,
    pub preset_id: String,
    /// The stream choice of the request, as the run uses it.
    pub streams: ExportStreams,
    pub output_path: String,
    pub segment_count: u32,
    pub total_duration_us: u64,
    /// Absent for an export without video, which writes no frames: its progress has no total,
    /// and the interface shows it as indeterminate (ADR 025).
    pub expected_frames: Option<u64>,
}

/// The command's rejection payload, and the body of every `failed` event.
///
/// One type serves both because the frontend normalizes both through the same
/// `normalizeExportError`, and because a failure that happens a millisecond before the
/// command returns and one that happens a millisecond after should not describe themselves
/// differently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCommandError {
    pub code: ExportErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// The encoder a failure is about. Reserved for the `encoderUnavailable` pre-check ADR
    /// 016 describes, which is a separate unit; nothing in this module sets it today. The
    /// field is carried anyway because the wire contract declares it and the frontend already
    /// reads it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    /// The duration ffprobe measured on the finished file, in whole microseconds, for
    /// `audioDurationMismatch`. Absent when ffprobe reported no duration, and on every other
    /// code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured_duration_us: Option<u64>,
    /// The duration the plan expected, in whole microseconds, for `audioDurationMismatch`: the
    /// planned duration of the segments, which equals `totalDurationUs` in [`ExportStart`]. The
    /// graph writes the audio of every segment at its whole length, whatever part of it the
    /// source audio covers (`graph::audio_end_pad`). Absent on every other code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_duration_us: Option<u64>,
}

impl ExportCommandError {
    /// A failure with a stable code and no diagnostic text.
    fn new(code: ExportErrorCode) -> Self {
        Self {
            code,
            detail: None,
            exit_code: None,
            encoder: None,
            measured_duration_us: None,
            expected_duration_us: None,
        }
    }

    /// A failure carrying an untranslated diagnostic, such as an operating system message or
    /// an ffmpeg stderr tail. ADR 011 keeps the English out of `code` and puts it here.
    fn with_detail(code: ExportErrorCode, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(code)
        }
    }
}

/// One `export:progress` event payload.
///
/// Every variant carries `runId`, so the frontend can discard an event that does not belong
/// to the run it started.
///
/// Both serde attributes below are required together, exactly as in
/// `commands::capabilities`. `rename_all` renames the six variants into the `event` tag
/// value. `rename_all_fields` renames each variant's *fields*, and dropping it would ship
/// `run_id` verbatim: the frontend's strict `validateExportProgressEvent` would then reject
/// every event, and the interface would sit on "exporting" forever with no completion and no
/// failure ever arriving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportEvent {
    /// The run took the export slot, and its export thread prepares it. A run that started at
    /// once and a run that waited both send it first. A run that a cancel withdrew from the
    /// queue, or whose thread the system refused, sends only `failed`.
    Preparing {
        run_id: String,
    },
    Started {
        run_id: String,
        output_path: String,
        segment_count: u32,
        total_duration_us: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_frames: Option<u64>,
    },
    Progress {
        run_id: String,
        frame: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_frames: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fps: Option<Rational>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<Rational>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_size: Option<u64>,
    },
    Publishing {
        run_id: String,
    },
    Finished {
        run_id: String,
        output_path: String,
        frames: u64,
    },
    Failed {
        run_id: String,
        code: ExportErrorCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        encoder: Option<String>,
        /// See [`ExportCommandError::measured_duration_us`].
        #[serde(skip_serializing_if = "Option::is_none")]
        measured_duration_us: Option<u64>,
        /// See [`ExportCommandError::expected_duration_us`].
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_duration_us: Option<u64>,
    },
}

/// Everything the export needs after preparation, which resolves all of it.
#[derive(Debug)]
struct PreparedExport {
    /// The id of the preset of the request, kept in [`ExportStart`].
    preset_id: String,
    /// The stream choice of the request, kept in [`ExportStart`].
    streams: ExportStreams,
    /// The segment count of the request, kept in [`ExportStart`].
    segment_count: u32,
    plan: ExportPlan,
    /// The located `ffmpeg`.
    ffmpeg: PathBuf,
    /// The located `ffprobe`, which reads the finished file of an export without video back
    /// for its success check ([`verified_audio_output`]).
    ffprobe: PathBuf,
    /// The complete argument list, already built against [`PreparedExport::pending`]'s
    /// reserved path.
    arguments: Vec<String>,
    /// The argument list of the audio process, when the plan has one
    /// ([`ExportPlan::separate_audio_process`], ADR 043). Its stdout is the stdin of the process
    /// that [`Self::arguments`] runs.
    audio_arguments: Option<Vec<String>>,
    /// The reserved temporary output. Holding it here keeps the reservation alive for the
    /// whole run: dropping it deletes the file ffmpeg is writing.
    pending: PendingOutput,
    /// The work directory of the export, where both processes run (ADR 055).
    /// [`run_export_with`] removes it when the processes have ended, and on every other path it
    /// removes itself when it drops.
    work: ExportWorkDirectory,
}

/// Start one export, or put it in the queue, and report it through [`EVENT_NAME`].
///
/// The command hands the run to the registry ([`ExportRegistry::submit`]). The registry starts
/// it at once when the slot is free, and otherwise when the runs before it have released the
/// slot. Either way the run gets its slot through [`QueuedExport`], which moves it to the export
/// thread, because a run outlives the command that started it and Tauri lends managed state
/// only for the length of the command.
///
/// The command answers with the run id at once, and the run prepares on its thread
/// ([`run_export_job`]). The frontend can therefore name the run in a cancel from the moment it
/// waits, through preparation, which can last tens of seconds, to its end. Preparation is bounded
/// by [`PREPARATION_TIMEOUT`], and a cancel ends it within [`PREPARATION_CANCEL_GRACE`], also
/// while a step waits in the file system.
#[tauri::command]
pub async fn start_export(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<ExportRegistry>>,
    preview_windows: tauri::State<'_, Arc<PreviewWindows>>,
    journal: tauri::State<'_, ExportJournal>,
    request: ExportRequestWire,
) -> Result<ExportSubmission, ExportCommandError> {
    // First, before any check that can refuse the request: the interface starts its new batch
    // also when this start is refused, so the journal must drop the ended runs too.
    if request.new_batch {
        journal.begin_batch();
    }
    // Checked before the slot is claimed, so a request with an invalid preset is refused at
    // once and holds no slot.
    validate_request_preset(&request.preset)?;

    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| ExportCommandError::new(ExportErrorCode::AppDataUnavailable))?;
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| ExportCommandError::new(ExportErrorCode::WorkDirectoryUnavailable))?;

    let run_id = next_run_id();
    let facts = run_facts(&request);
    let waiting = Box::new(QueuedExport {
        app,
        run_id: run_id.clone(),
        job: ExportJob {
            request,
            app_data_directory,
            cache_directory,
            preview_windows: preview_windows.inner().clone(),
        },
    });
    // Recorded before the submit. A run that starts at once sends `preparing` during the
    // submit, and the journal must know the run then.
    journal.record_submission(&run_id, facts);
    // One run holds the slot at a time (ADR 016). A run that comes while another holds it
    // waits, and the registry starts it when the runs before it have released the slot.
    match registry.submit(&run_id, waiting) {
        Submission::Started => Ok(ExportSubmission {
            run_id,
            queued: false,
        }),
        Submission::Queued => Ok(ExportSubmission {
            run_id,
            queued: true,
        }),
        Submission::Closed => {
            journal.forget(&run_id);
            Err(ExportCommandError::new(ExportErrorCode::ExportQueueClosed))
        }
    }
}

/// The facts of a request that the export journal keeps for the run.
fn run_facts(request: &ExportRequestWire) -> RunFacts {
    RunFacts {
        output_path: request.output_path.clone(),
        preset_name: request.preset.name.clone(),
        segment_count: request.segment_count,
        streams: request.streams,
    }
}

/// Ask the run named by `runId` to stop, and report whether the request reached it: the run
/// that holds the export slot, or a run that waits in the queue. A run that waits leaves the
/// queue and reports `failed` with `canceled`.
///
/// `false` means the named run neither runs nor waits. It does not mean no export is running,
/// and the frontend must not render it that way.
///
/// This sets a flag and returns. The worker notices on its next poll, kills its child, and
/// discards the temporary file. A cancel that lands after the worker's last read of the flag
/// still publishes the output; ADR 016 accepts that window, because a rename cannot be undone.
#[tauri::command]
pub async fn cancel_export(
    registry: tauri::State<'_, Arc<ExportRegistry>>,
    run_id: String,
) -> Result<bool, ExportCommandError> {
    Ok(registry.cancel(&run_id))
}

/// Resolve the ffmpeg executable pair for an export: the configured path from settings, if
/// any, ahead of `PATH` and the application data directory, per ADR 005's resolution order.
///
/// This mirrors `commands::capabilities::discover_for_probe`. It is the one read of the
/// settings file in an export: the request carries its preset (ADR 049), and the configured
/// path of ffmpeg is part of the machine, so the run reads it when it starts.
fn discover_for_export(app_data_directory: &Path) -> Result<FfmpegPaths, LocateError> {
    let configured = settings::configured_ffmpeg_path(app_data_directory);
    ffmpeg::discover(configured.as_deref(), app_data_directory)
}

/// The option probe of ADR 055 as [`prepare_export_with`] runs it: the path of `ffmpeg`, the work
/// directory, and the stop flag of preparation. Production passes
/// [`probe_graph_file_option`].
type GraphFileProbe<'a> = dyn Fn(&Path, &ExportWorkDirectory, &AtomicBool) -> Result<GraphFileOption, GraphFileProbeError>
    + 'a;

/// The plain data [`prepare_export_with`] needs, grouped apart from the five functions it also
/// takes, and the option probe of ADR 055.
///
/// `clippy`'s `too-many-arguments` lint (see `clippy.toml`) counts each injected function as one
/// argument. `ffmpeg::capabilities::ProbeRequest` gives the reason to group the data rather than
/// to raise the threshold. The option probe is a sixth function, so it rides here as a reference,
/// [`Self::graph_file`], rather than as a sixth argument that would trip the lint.
#[derive(Clone, Copy)]
struct PrepareRequest<'a> {
    /// The export the interface asked for.
    request: &'a ExportRequestWire,
    /// The directory of the settings file and of the discovery of the executables.
    app_data_directory: &'a Path,
    /// The cache directory of the application, which holds the work directories (ADR 055).
    cache_directory: &'a Path,
    /// The stop flag of preparation, read between the steps. In a run this is the flag of the
    /// helper thread of [`run_export_job_with`]. It starts as the cancel flag of the run, and the
    /// watchdog sets it on a later cancel of the run and at [`PREPARATION_TIMEOUT`].
    cancel: &'a AtomicBool,
    /// The open FLV sources, which the FLV input shares with the preview (ADR 046).
    preview_windows: &'a PreviewWindows,
    /// The stage that runs now. Preparation sets it at the start of each step, and the watchdog
    /// names it in the report of a timeout.
    stage: &'a PreparationStageCell,
    /// The option probe of ADR 055, which finds how `ffmpeg` reads a graph file. Injected so the
    /// tests of preparation need no `ffmpeg`.
    graph_file: &'a GraphFileProbe<'a>,
}

/// Do every fallible step an export needs before ffmpeg starts, in ADR 016's order.
///
/// The five injected functions are the ones that reach outside the process: executable
/// discovery, the ffprobe re-probe, the two reads of [`correct_audio_probe`], and the read of
/// [`read_audio_gaps`]. ADR 014's "Other rules" requires that re-probe -- the
/// renderer reads the container start time and the selected stream indices from a fresh probe,
/// never from stale project metadata. The option probe of ADR 055, which asks `ffmpeg` how it
/// reads a graph file, rides in [`PrepareRequest::graph_file`]. It runs after the reservation,
/// only for an export whose commands carry a graph, and each graph is then written into its file
/// in the work directory.
///
/// See this module's documentation for the five ordering obligations the body below carries.
///
/// `cancel` is the stop flag of preparation, read between the steps. Preparation runs while the
/// run already holds the export slot, and its steps reach outside the process. The re-probe and
/// the reads of the audio stop on the flag. Reading the flag between the steps does not shorten
/// an in-process step that has already started, such as a stat on a share that stopped
/// answering, but it stops the run from working through every remaining step after the answer
/// is no longer wanted.
///
/// A step in the file system has no time bound here. [`run_export_job_with`] runs this function
/// on a helper thread and bounds it from the export thread: a cancel of the run, or
/// [`PREPARATION_TIMEOUT`], ends the run even while a step is blocked. `stage` tells that watchdog
/// which step runs ([`PreparationStage`]).
fn prepare_export_with<Discover, Probe, FirstPacket, RateAt, Gaps>(
    prepare: PrepareRequest<'_>,
    discover: Discover,
    mut probe: Probe,
    mut first_audio_packet: FirstPacket,
    mut audio_sample_rate_at: RateAt,
    mut audio_gaps: Gaps,
) -> Result<PreparedExport, ExportCommandError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    Probe: FnMut(&Path, &Path, &AtomicBool) -> Result<MediaProbe, ProbeError>,
    FirstPacket:
        FnMut(&Path, &Path, u32, &AtomicBool) -> Result<Option<FirstAudioPacket>, ProbeError>,
    RateAt: FnMut(&Path, &Path, u64, u32, &AtomicBool) -> Result<Option<u32>, ProbeError>,
    Gaps: FnMut(&Path, &Path, &AudioGapRead<'_>, &AtomicBool) -> Result<AudioFrames, ProbeError>,
{
    let PrepareRequest {
        request,
        app_data_directory,
        cache_directory,
        cancel,
        preview_windows,
        stage,
        graph_file,
    } = prepare;
    // Read the same way `ExportSlot::is_canceled` reads it, so the ordering pairs with
    // `ExportRegistry::cancel`'s store.
    let canceled = || cancel.load(std::sync::atomic::Ordering::SeqCst);

    // Before the first step, which already reaches outside the process: `discover` walks `PATH`
    // and inspects each candidate, and an entry on a share that has stopped answering holds
    // that inspection for as long as the operating system lets it. `run_export_job_with` does
    // not start preparation for a run that was canceled already, and copies the cancel flag of
    // the run into the stop flag. This read covers a direct caller and a stop that came between
    // the spawn of the helper and its first step.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    // The sources and the pieces, checked before any step reaches outside the process: a request
    // that does not hold together is a fault of the frontend, and no read can change that.
    let resolved = resolve_request(request)?;

    stage.enter(PreparationStage::Discovery);
    let executables = discover(app_data_directory)
        .map_err(|_| ExportCommandError::new(ExportErrorCode::FfmpegPairMissing))?;

    // The preset of the request, which `start_export` checked. The settings file is not read
    // here, so an edit of the preset after the command accepted the run changes nothing.
    let preset = &request.preset;
    let destination = PathBuf::from(&request.output_path);

    // ADR 055: the work directory, before the first source, whose FLV head it receives. The
    // sweep first removes what earlier exports left. The guard removes the directory when it
    // drops, so a `?` below, a panic, and an abandoned preparation all remove it.
    //
    // Discovery can block on a share for many seconds (ADR 050). An abandoned helper must stop at
    // its next check, so it neither sweeps nor creates a directory after a Stop.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }
    stage.enter(PreparationStage::WorkDirectory);
    remove_stale_work_directories(cache_directory);
    let work = ExportWorkDirectory::create(cache_directory).map_err(|error| {
        ExportCommandError::with_detail(
            ExportErrorCode::WorkDirectoryUnavailable,
            error.to_string(),
        )
    })?;

    // The bounded steps run once for each source, in the order of its first piece (ADR 053):
    // the revision check, the re-probe, the correction of the audio, the FLV input and the read
    // of the gaps. `run_export_job_with` multiplies the time limit of preparation by the number of
    // sources (ADR 050).
    let mut paths: Vec<PathBuf> = Vec::with_capacity(resolved.sources.len());
    let mut probes: Vec<MediaProbe> = Vec::with_capacity(resolved.sources.len());
    let mut frames: Vec<AudioFrames> = Vec::with_capacity(resolved.sources.len());
    let mut flv_inputs: Vec<Option<FlvInput>> = Vec::with_capacity(resolved.sources.len());
    for (index, wire) in resolved.sources.iter().enumerate() {
        let source = PathBuf::from(&wire.path);
        let pieces = resolved.pieces_of(index);

        // Before the re-probe, the first of the steps here that can spend tens of seconds.
        if canceled() {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled));
        }
        stage.enter_for(PreparationStage::RevisionCheck, Some(index));
        // A cancel that arrives during the read of the revision wins over a mismatch.
        check_source_revision(wire).map_err(|error| {
            if canceled() {
                ExportCommandError::new(ExportErrorCode::Canceled)
            } else {
                error
            }
        })?;
        // After the read of the revision, which can block on a share. A helper that the watchdog
        // abandoned during that read must not start ffprobe when the read returns.
        if canceled() {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled));
        }
        // The re-probe stops on the flag, so a cancel does not wait for `PROBE_TIMEOUT` on a
        // share that stopped answering.
        stage.enter(PreparationStage::ReProbe);
        let mut source_probe =
            probe(&executables.ffprobe, &source, cancel).map_err(|error| match error {
                ProbeError::Canceled => ExportCommandError::new(ExportErrorCode::Canceled),
                other => map_reprobe_error(other),
            })?;
        let rate_readable = rate_readable_from_packets(&source_probe.format_names);
        if let Some(audio) = source_probe.audio.as_mut().filter(|audio| {
            request.streams.writes_audio() && (audio.sample_rate.is_some() || rate_readable)
        }) {
            stage.enter(PreparationStage::AudioReads);
            correct_audio_probe(
                &executables.ffprobe,
                &source,
                audio,
                cancel,
                &mut first_audio_packet,
                &mut audio_sample_rate_at,
            )?;
        }
        // ADR 046: an FLV source opens each input as its head and a slice from a keyframe, so
        // the reads of the export, the read of the audio gaps included, do not read it from its
        // start. The head goes into the work directory as `h<index>.flv`, where `index` is the
        // index of the source in the order of its first piece, which is its index in the plan.
        // One source of an export at most opens its inputs so (ADR 053); a later FLV source keeps
        // the input seek, which reads more and is correct.
        stage.enter(PreparationStage::FlvInput);
        let flv_input = if flv_inputs.iter().any(Option::is_some) {
            if source_probe.format_names.iter().any(|name| name == "flv") {
                eprintln!("export: a second FLV source keeps the input seek");
            }
            None
        } else {
            flv_input_for(
                &executables.ffprobe,
                &source,
                &source_probe,
                &pieces,
                request.streams,
                FlvPlace {
                    app_data_directory,
                    work_directory: &work,
                    source_index: index,
                },
                preview_windows,
                cancel,
            )?
        };
        stage.enter(PreparationStage::AudioReads);
        let audio_frames = read_audio_gaps(
            &executables.ffprobe,
            &source,
            &source_probe,
            &pieces,
            request.streams,
            flv_input.as_ref().map(|flv| (flv, work.path())),
            cancel,
            &mut audio_gaps,
        )?;
        paths.push(source);
        probes.push(source_probe);
        frames.push(audio_frames);
        flv_inputs.push(flv_input);
    }
    // After the reads of the audio, which can each spend tens of seconds. A cancel that arrives as
    // the last one ends must not reach the plan, which can refuse what these reads found with a
    // code of its own, such as `sourceHasNoAudio`.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    let plan_sources: Vec<PlanSource<'_>> = paths
        .iter()
        .zip(&probes)
        .zip(&frames)
        .map(|((path, probe), audio_frames)| PlanSource {
            path,
            probe,
            audio_frames,
        })
        .collect();

    // Obligation 1: planning runs before the reservation. A destination that is a directory
    // reserves successfully and fails only at the rename, after the whole encode.
    stage.enter_for(PreparationStage::Plan, None);
    let mut plan = build_plan(
        &PlanRequest {
            sources: &plan_sources,
            destination: &destination,
            segments: &resolved.pieces,
            preset,
            streams: request.streams,
            audio_mode: request.audio_mode,
        },
        inspect_path,
    )
    .map_err(ExportCommandError::new)?;
    for (index, flv_input) in flv_inputs.into_iter().enumerate() {
        let pieces = resolved.pieces_of(index).len();
        plan.sources[index].flv_input = flv_input.filter(|flv| flv.segment_offsets.len() == pieces);
    }
    // A copy that the plan refused is no error: the export encodes the audio, or writes none
    // (ADR 048).
    if let Some(refusal) = plan.audio_copy_refusal {
        eprintln!("export: the audio is not copied: {refusal:?}");
    }

    // An export without video that copies its audio has no graph: one command copies the packets
    // into the reservation (ADR 048). Every other export carries a graph, which it reads from a
    // file, so it first asks `ffmpeg` which option reads one (ADR 055). The probe runs before the
    // reservation, so a slow probe leaves no empty file in the folder of the user.
    let copies_audio_only = plan.video.is_none() && plan.copied_audio.is_some();
    let graph_option = if copies_audio_only {
        None
    } else {
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
        Some(option)
    };

    // Before the reservation, which is the first step here that writes to the user's disk. A
    // cancel read after it would have to delete the file it created; read here, there is
    // nothing to undo.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    // This mapping keeps its diagnostic, and that is deliberate. Do not extend the raw
    // operating-system-code guard from the `commit` mapping in `run_export_with` to here. ADR 011
    // decides the question by the condition, not by the origin of the string: `reserve` creates a
    // temporary file next to the destination, and that can fail in ways not worth a code each and
    // not predictable in advance -- no space, a quota, a name the filesystem refuses, 100
    // consecutive name collisions, a generated name past the platform's limit. `outputNotWritable`
    // alone cannot tell two of those apart in a bug report. `commit`'s guard is the other case in
    // the same record: a refusal QuipClip decides for itself about an enumerable condition, where
    // the code is the whole account and a Rust-authored sentence adds nothing.
    stage.enter(PreparationStage::Reservation);
    let pending = PendingOutput::reserve(&plan.destination).map_err(|error| {
        ExportCommandError::with_detail(ExportErrorCode::OutputNotWritable, error.to_string())
    })?;

    stage.enter(PreparationStage::Arguments);

    // Obligations 2 and 3: ffmpeg writes the reservation, not the destination, and one shape
    // decision serves both the graph and the arguments of each process. Each graph goes into its
    // file in the work directory, and the command names the file (ADR 055).
    let arguments = match graph_option {
        None => build_copy_arguments(&plan, CopyOutput::File(pending.path()))
            .expect("a plan without video that copies its audio has a copy command"),
        Some(option) => {
            let shape = choose_graph_shape(&plan, pending.path());
            write_graph(&work, ENCODER_GRAPH_FILE, &encoder_graph(&plan, shape))?;
            let file = GraphFile {
                option,
                name: ENCODER_GRAPH_FILE,
            };
            build_arguments(&plan, shape, file, pending.path())
        }
    };
    // A plan with an audio process has video, so the probe ran for it.
    let audio_arguments = match graph_option {
        Some(option) if plan.separate_audio_process() => {
            let shape = choose_audio_graph_shape(&plan);
            write_graph(&work, AUDIO_GRAPH_FILE, &build_audio_graph(&plan, shape))?;
            let file = GraphFile {
                option,
                name: AUDIO_GRAPH_FILE,
            };
            Some(build_audio_arguments(&plan, shape, file))
        }
        _ if plan.separate_copy_process() => build_copy_arguments(&plan, CopyOutput::Pipe),
        _ => None,
    };

    Ok(PreparedExport {
        preset_id: preset.id.clone(),
        streams: request.streams,
        segment_count: request.segment_count,
        plan,
        ffmpeg: executables.ffmpeg,
        ffprobe: executables.ffprobe,
        arguments,
        audio_arguments,
        pending,
        work,
    })
}

/// Write `graph` as the file `name` of the work directory: the exact bytes of the builder, ASCII,
/// with no byte order mark and no line end (ADR 055). A failed write gives
/// `workDirectoryUnavailable`, with the error as its detail.
fn write_graph(
    work: &ExportWorkDirectory,
    name: &str,
    graph: &str,
) -> Result<(), ExportCommandError> {
    work.write(name, graph.as_bytes()).map_err(|error| {
        ExportCommandError::with_detail(
            ExportErrorCode::WorkDirectoryUnavailable,
            error.to_string(),
        )
    })
}

/// Whether the demuxer of `format_names` gives a stream an id that [`correct_audio_probe`] can read
/// a sample rate the re-probe missed by: `mpegts` and `mpeg`, the two that ADR 014 measurement 25
/// measured.
///
/// The plan refuses audio without a sample rate whatever its start. In any other container, the
/// reads of [`correct_audio_probe`] cannot give that rate, so a stream without one is not read: the
/// first read alone can spend up to [`crate::ffmpeg::probe::PROBE_TIMEOUT`] before the same
/// refusal.
fn rate_readable_from_packets(format_names: &[String]) -> bool {
    format_names
        .iter()
        .any(|name| name == "mpegts" || name == "mpeg")
}

/// Correct what the re-probe reports about the audio stream of an export that writes audio, from
/// the first packet of the stream.
///
/// The re-probe analyzes about the first 5 s of the file. In a Matroska, MPEG-TS or MPEG-PS
/// source whose audio starts later, it reports the start of the container as the start of the
/// audio, and in MPEG-TS and MPEG-PS a sample rate of 0 (ADR 014 measurements 22, 24 and 25). The
/// plan reads the start for the bound on the silence in front of the audio. It refuses audio
/// without a sample rate with `sourceAudioRateUnknown`.
///
/// 1. `first_audio_packet` reads the first packet of the stream. When it finds none and reports no
///    error, [`crate::ffmpeg::AudioProbe::take_no_packet`] marks the stream as one that holds no
///    audio, unless the container counts packets or records a duration for it. The plan then
///    generates silence instead of reading the stream (ADR 014 measurement 26). The other steps do
///    not run.
/// 2. Only when the re-probe reported no sample rate, and the packet has a position and the stream
///    an id, `audio_sample_rate_at` reads the rate again from the position of that packet.
/// 3. [`crate::ffmpeg::AudioProbe::take_first_packet`] corrects the start, and the length with
///    it, from the time of the packet.
///
/// These reads only add accuracy, so they never fail the export. A read that cannot start, exits
/// unsuccessfully, writes an answer that does not parse, or times out leaves the values of the
/// re-probe, as they were before these reads existed. So does a read that finds no packet but
/// reports an error, which [`crate::ffmpeg::probe_first_audio_packet`] returns as a failure. A
/// cancel that stops a read ends the run as canceled. The flag is also read before each one, so
/// a cancel that came during the re-probe starts no read, and each read can spend up to
/// [`crate::ffmpeg::probe::PROBE_TIMEOUT`]. The caller reads it once more after the last one.
fn correct_audio_probe<FirstPacket, RateAt>(
    ffprobe: &Path,
    source: &Path,
    audio: &mut AudioProbe,
    cancel: &AtomicBool,
    first_audio_packet: FirstPacket,
    audio_sample_rate_at: RateAt,
) -> Result<(), ExportCommandError>
where
    FirstPacket:
        FnOnce(&Path, &Path, u32, &AtomicBool) -> Result<Option<FirstAudioPacket>, ProbeError>,
    RateAt: FnOnce(&Path, &Path, u64, u32, &AtomicBool) -> Result<Option<u32>, ProbeError>,
{
    let canceled = || {
        cancel
            .load(std::sync::atomic::Ordering::SeqCst)
            .then(|| ExportCommandError::new(ExportErrorCode::Canceled))
    };
    if let Some(error) = canceled() {
        return Err(error);
    }
    let packet = match first_audio_packet(ffprobe, source, audio.index, cancel) {
        Ok(Some(packet)) => packet,
        Err(ProbeError::Canceled) => {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled))
        }
        // The read found no packet of the stream and reported no error. The container can still
        // show that the stream holds audio, and then the values of the re-probe stand.
        Ok(None) => {
            audio.take_no_packet();
            return Ok(());
        }
        // A read that failed: the values of the re-probe stand.
        Err(_) => return Ok(()),
    };
    if audio.sample_rate.is_none() {
        if let Some((position, stream_id)) = packet.position.zip(packet.stream_id) {
            if let Some(error) = canceled() {
                return Err(error);
            }
            match audio_sample_rate_at(ffprobe, source, position, stream_id, cancel) {
                Ok(rate) => audio.sample_rate = rate,
                Err(ProbeError::Canceled) => {
                    return Err(ExportCommandError::new(ExportErrorCode::Canceled));
                }
                // The rate stays unknown, and the plan refuses the audio as before.
                Err(_) => {}
            }
        }
    }
    if let Some(time) = packet.time {
        audio.take_first_packet(time);
    }
    Ok(())
}

/// Read the gaps inside the audio stream of one source of an export inside its pieces, for the
/// bound of the plan on the silence that the fills of the chains hold in memory (ADR 014
/// measurement 28). `pieces` are the pieces of that source, in the units of its probe.
///
/// The read runs when the export writes audio from a stream that holds packets and has a sample
/// rate. Otherwise no chain reads the stream, or the plan refuses the audio, and the answer is
/// empty. The answer is empty as well when the plan refuses the segments: none, more than
/// [`MAX_EXPORT_SEGMENTS`], a boundary that is not a time, or an In point that is not before its
/// Out point. The ranges of the read are the segments, in seconds on the timeline of the
/// container, which is the timeline of `-copyts`.
///
/// The read only adds a bound, so it never fails the export. A read that cannot start, exits
/// unsuccessfully, writes an answer that does not parse, or times out gives no gaps. The plan then
/// bounds only the silence in front of the first sample, as before this read existed. A cancel
/// that stops the read ends the run as canceled. The flag is also read before the read starts.
///
/// The answer also tells where the frames start and end, and the shorter gaps between them, which
/// the decision on a copy of the audio reads (ADR 048). A read that failed tells nothing, and the
/// plan then encodes the audio.
fn read_audio_gaps<Gaps>(
    ffprobe: &Path,
    source: &Path,
    probe: &MediaProbe,
    pieces: &[SegmentBoundary],
    streams: ExportStreams,
    flv: Option<(&FlvInput, &Path)>,
    cancel: &AtomicBool,
    audio_gaps: Gaps,
) -> Result<AudioFrames, ExportCommandError>
where
    Gaps: FnOnce(&Path, &Path, &AudioGapRead<'_>, &AtomicBool) -> Result<AudioFrames, ProbeError>,
{
    let Some((audio, sample_rate)) = probe
        .audio
        .as_ref()
        .filter(|audio| streams.writes_audio() && !audio.holds_no_packets)
        .and_then(|audio| Some((audio, audio.sample_rate?)))
    else {
        return Ok(AudioFrames::default());
    };
    if pieces.is_empty() || pieces.len() > MAX_EXPORT_SEGMENTS {
        return Ok(AudioFrames::default());
    }
    let ranges: Option<Vec<(Rational, Rational)>> = pieces
        .iter()
        .map(|segment| {
            let start = pts_seconds(segment.in_pts, probe.video_time_base)?;
            let end = pts_seconds(segment.out_pts, probe.video_time_base)?;
            (start < end).then_some((start, end))
        })
        .collect();
    let Some(ranges) = ranges else {
        return Ok(AudioFrames::default());
    };
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }
    let read = AudioGapRead {
        stream_index: audio.index,
        sample_rate,
        ranges: &ranges,
        min_gap: Rational::new(AUDIO_FILL_MIN_GAP_MILLISECONDS, 1000)
            .expect("AUDIO_FILL_MIN_GAP_MILLISECONDS/1000 always reduces to a valid Rational"),
        flv,
    };
    match audio_gaps(ffprobe, source, &read, cancel) {
        Ok(frames) => Ok(frames),
        Err(ProbeError::Canceled) => Err(ExportCommandError::new(ExportErrorCode::Canceled)),
        // A read that failed: the plan bounds no gap inside the stream.
        Err(_) => Ok(AudioFrames::default()),
    }
}

/// The FLV input of `source` in an export (ADR 046), or `None` when the source keeps the input
/// seek of ADR 014. `pieces` are the pieces of that source. The seek position of each is its In
/// point less [`SEEK_MARGIN_SECONDS`], as the input seek would use it.
///
/// The locate reads the file, which on a share that stopped answering can hold a read, so a
/// watcher copies the cancel flag of the run into the flag of the reader, which stops between two
/// reads. A cancel ends the run as canceled. Every other reason to keep the input seek is not an
/// error: the export runs as before, and the reason goes to the log.
///
/// A slice that starts after a change of the decoder configuration that the reader has not seen
/// would decode with the configuration of the head. So ffprobe decodes the first frame of each
/// slice first ([`check_slices`]), and a slice that does not decode as the probe keeps the input
/// seek for the whole export.
fn flv_input_for(
    ffprobe: &Path,
    source: &Path,
    probe: &MediaProbe,
    pieces: &[SegmentBoundary],
    streams: ExportStreams,
    place: FlvPlace<'_>,
    preview_windows: &PreviewWindows,
    cancel: &AtomicBool,
) -> Result<Option<FlvInput>, ExportCommandError> {
    // The plan refuses a request with too many pieces, so the locates of such a request would
    // be wasted.
    if !probe.format_names.iter().any(|name| name == "flv")
        || pieces.is_empty()
        || pieces.len() > MAX_EXPORT_SEGMENTS
    {
        return Ok(None);
    }
    let margin = Rational::new(SEEK_MARGIN_SECONDS, 1)
        .expect("SEEK_MARGIN_SECONDS/1 always reduces to a valid Rational");
    let positions: Option<Vec<Rational>> = pieces
        .iter()
        .map(|segment| pts_seconds(segment.in_pts, probe.video_time_base)?.sub(margin))
        .collect();
    let Some(positions) = positions else {
        return Ok(None);
    };
    // A cancel that came first stops the first read, before the watcher looks.
    let reader_cancel = Arc::new(AtomicBool::new(cancel.load(Ordering::SeqCst)));
    let done = AtomicBool::new(false);
    let located = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) {
                    reader_cancel.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(FLV_CANCEL_POLL);
            }
        });
        // The watcher stops also when the locate panics.
        let _done = SetOnDrop(&done);
        locate_flv_input(&FlvInputRequest {
            source,
            probe,
            seek_positions: &positions,
            app_data: place.app_data_directory,
            work_directory: place.work_directory,
            source_index: place.source_index,
            windows: preview_windows,
            cancel: Some(reader_cancel.clone()),
        })
    });
    let input = match located {
        // A locate that the table answers reads nothing, so it does not see a cancel.
        Ok(_) if cancel.load(Ordering::SeqCst) => {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled))
        }
        Ok(input) => input,
        Err(FlvInputFallback::Canceled) => {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled))
        }
        Err(reason) => {
            eprintln!("export: the FLV source keeps the input seek: {reason:?}");
            return Ok(None);
        }
    };
    // The same condition as the read of the audio gaps: an export that writes no audio, or an
    // audio stream with no packets, needs no check of the audio.
    let check_audio = streams.writes_audio()
        && probe
            .audio
            .as_ref()
            .is_some_and(|audio| !audio.holds_no_packets);
    match check_slices(
        ffprobe,
        &input,
        place.work_directory.path(),
        source,
        probe,
        check_audio,
        cancel,
    ) {
        Ok(()) => Ok(Some(input)),
        Err(SliceCheck::Canceled) => Err(ExportCommandError::new(ExportErrorCode::Canceled)),
        Err(SliceCheck::Refused(reason)) => {
            eprintln!("export: the FLV source keeps the input seek: {reason}");
            Ok(None)
        }
    }
}

/// Where the FLV input of a source keeps its files: the reader keeps its keyframe table in the
/// application data directory (ADR 046), and the export writes the head into its work directory
/// (ADR 055).
#[derive(Clone, Copy)]
struct FlvPlace<'a> {
    /// The application data directory, which holds the cache of the FLV reader.
    app_data_directory: &'a Path,
    /// The work directory of the export, which receives the head.
    work_directory: &'a ExportWorkDirectory,
    /// The index of the source in the plan, which names its head.
    source_index: usize,
}

/// Sets its flag when it drops, also during the unwind of a panic.
struct SetOnDrop<'a>(&'a AtomicBool);

impl Drop for SetOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Why [`check_slices`] refused the slices.
enum SliceCheck {
    Canceled,
    Refused(String),
}

/// The packets of all streams that [`check_slices`] decodes from the start of each slice when it
/// checks the audio: enough for the first video frame and for about 15 to 40 audio frames of a
/// recording.
const CHECKED_PACKETS: u32 = 64;

/// The video packets that [`check_slices`] decodes from the start of each slice when it does not
/// check the audio.
const CHECKED_VIDEO_PACKETS: u32 = 8;

/// The fewest steps between two audio frames that [`audio_matches`] needs to compare.
const CHECKED_AUDIO_STEPS: usize = 4;

/// A step between two audio frames longer than this many times the time of the samples of the
/// first frame is a gap in the audio, which the export fills, and [`audio_matches`] skips it.
const AUDIO_GAP_FACTOR: f64 = 1.5;

/// The difference that [`audio_matches`] accepts between the time that the compared steps span
/// and the time of their samples at the rate of the probe: this share of that time, and at least
/// [`AUDIO_TIMING_TOLERANCE_SECONDS`]. FLV timestamps are whole milliseconds, and some encoders
/// give the audio a few milliseconds of jitter. A change from 44100 Hz to 48000 Hz moves the
/// timestamps by 8 %.
const AUDIO_TIMING_TOLERANCE_SHARE: f64 = 0.02;

/// See [`AUDIO_TIMING_TOLERANCE_SHARE`].
const AUDIO_TIMING_TOLERANCE_SECONDS: f64 = 0.003;

/// Decode the start of each slice of `input` once, within one [`ffmpeg::PROBE_TIMEOUT`] for all
/// of them, with one ffprobe run for each slice. The first video frame must decode with no error
/// at the size of the probe. When `check_audio` is set, the audio frames must also match the
/// probe ([`audio_matches`]): a raw AAC frame does not carry its rate, so the audio of a slice
/// after a change of the rate that no read has seen decodes with no error at the rate of the
/// head.
///
/// This is a heuristic. A frame can decode at the right size with no error and still use a
/// wrong parameter of the head, and a harmless error line refuses the slices. A refusal keeps the
/// input seek, which reads more and is correct. The slice from the first frame of the file needs
/// no check: the head holds the configurations of the start of the file, and the first frame of
/// a recording that starts in the middle of a GOP does not decode on its own.
///
/// ffprobe keeps the working directory of this process, so the inputs name the head by its full
/// path in `work_directory`, the work directory of the export.
fn check_slices(
    ffprobe: &Path,
    input: &FlvInput,
    work_directory: &Path,
    source: &Path,
    probe: &MediaProbe,
    check_audio: bool,
    cancel: &AtomicBool,
) -> Result<(), SliceCheck> {
    let head = input.head_path(work_directory);
    let head = head.to_string_lossy();
    if head.contains('|') {
        return Err(SliceCheck::Refused(
            "the path of the head holds the concat separator".to_owned(),
        ));
    }
    let audio = probe.audio.as_ref().filter(|_| check_audio);
    let mut offsets = input.segment_offsets.clone();
    offsets.sort_unstable();
    offsets.dedup();
    offsets.retain(|offset| *offset != input.first_frame_offset);
    let deadline = std::time::Instant::now() + ffmpeg::PROBE_TIMEOUT;
    for offset in offsets {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(SliceCheck::Refused(
                "the check of the slices timed out".to_owned(),
            ));
        }
        let url = input.url(&head, offset, source);
        let start = match ffmpeg::probe_slice_start(
            ffprobe,
            std::ffi::OsStr::new(&url),
            probe.video_stream_index,
            audio.map(|audio| audio.index),
            if audio.is_some() {
                CHECKED_PACKETS
            } else {
                CHECKED_VIDEO_PACKETS
            },
            remaining,
            cancel,
        ) {
            Ok(start) => start,
            Err(ProbeError::Canceled) => return Err(SliceCheck::Canceled),
            Err(error) => {
                return Err(SliceCheck::Refused(format!(
                    "the slice at byte {offset} was not read: {error:?}"
                )))
            }
        };
        let picture = start.clean && start.picture == Some((probe.width, probe.height));
        let sound = audio.is_none_or(|audio| audio_matches(&start.audio, audio));
        if !picture || !sound {
            return Err(SliceCheck::Refused(format!(
                "the slice at byte {offset} does not decode as the probe (picture {picture}, \
                 audio {sound}): {start:?}"
            )));
        }
    }
    Ok(())
}

/// True when the audio frames at the start of a slice decode as the probe found the audio: each
/// with a time and the channels of the probe, and with steps between them that their samples
/// fill at the rate of the probe. The rule skips the steps of gaps ([`AUDIO_GAP_FACTOR`]), and it
/// needs [`CHECKED_AUDIO_STEPS`] others.
fn audio_matches(frames: &[ffmpeg::DecodedAudioFrame], audio: &ffmpeg::AudioProbe) -> bool {
    let mut times = Vec::with_capacity(frames.len());
    for frame in frames {
        let Some(pts) = frame.pts else {
            return false;
        };
        if audio
            .channels
            .is_some_and(|channels| frame.channels.is_some_and(|found| found != channels))
        {
            return false;
        }
        times.push(pts.num() as f64 / pts.den() as f64);
    }
    if times.len() < 2 {
        return false;
    }
    let Some(rate) = audio.sample_rate.filter(|rate| *rate > 0) else {
        return true;
    };
    let mut spanned = 0.0;
    let mut expected = 0.0;
    let mut steps = 0;
    for (index, pair) in times.windows(2).enumerate() {
        let step = pair[1] - pair[0];
        let samples = f64::from(frames[index].nb_samples) / f64::from(rate);
        if step <= 0.0 {
            return false;
        }
        if step > samples * AUDIO_GAP_FACTOR {
            continue;
        }
        spanned += step;
        expected += samples;
        steps += 1;
    }
    let tolerance = (expected * AUDIO_TIMING_TOLERANCE_SHARE).max(AUDIO_TIMING_TOLERANCE_SECONDS);
    steps >= CHECKED_AUDIO_STEPS && (spanned - expected).abs() <= tolerance
}

/// How often the watcher of [`flv_input_for`] reads the cancel flag of the run.
const FLV_CANCEL_POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// Refuse a source file whose revision differs from the one the request expects.
///
/// The segments name frames of the revision that the user marked them against. An export that
/// waited in the queue can find another file at the path, and its cut would then name other
/// frames. The file is read the way `import_media` read it, so the two revisions compare as
/// equals when the file did not change. Preparation checks each source of the pieces, and the
/// detail of a mismatch is the id of the source (ADR 053).
///
/// The comparison has the limits of the revision of ADR 010. It does not see a replacement of
/// the same size inside the same second of modification time, a copy that keeps the
/// modification time, or a change after this one read. The read has no time bound of its own,
/// as the read of discovery has none. The watchdog of [`run_export_job_with`] bounds both.
///
/// A read that fails is not a mismatch. The re-probe and [`build_plan`] report a file that is
/// gone, or that is no longer a regular file, with codes of their own. The frontend check of
/// ADR 024 follows the same rule.
fn check_source_revision(source: &ExportSourceWire) -> Result<(), ExportCommandError> {
    let Some(expected) = source.expected_revision else {
        return Ok(());
    };
    match crate::commands::media::validate_media(&source.path) {
        Ok(actual) if actual.size != expected.size || actual.mtime != expected.mtime => {
            Err(ExportCommandError::with_detail(
                ExportErrorCode::SourceRevisionMismatch,
                source.id.clone(),
            ))
        }
        _ => Ok(()),
    }
}

/// Check the preset of a request by the rules of the settings document
/// ([`settings::validate_preset`]), and report `invalidPreset` with the reason when it fails.
///
/// The frontend sends a preset of the settings that this backend loaded or saved, and both
/// validate, so this fails only for a fault in the frontend. The reason is a diagnostic for a
/// bug report, so it goes in the detail (ADR 011).
fn validate_request_preset(preset: &Preset) -> Result<(), ExportCommandError> {
    settings::validate_preset(preset).map_err(|error| {
        ExportCommandError::with_detail(ExportErrorCode::InvalidPreset, error.to_string())
    })
}

/// Build the facts of a prepared run, which the `started` event reports.
fn start_payload(run_id: &str, prepared: &PreparedExport) -> ExportStart {
    ExportStart {
        run_id: run_id.to_owned(),
        preset_id: prepared.preset_id.clone(),
        streams: prepared.streams,
        output_path: path_to_string(&prepared.plan.destination),
        // The segments of the user, which `resolve_request` held between 1 and the number of
        // pieces. The pieces are not what the user counts (ADR 053).
        segment_count: prepared.segment_count,
        total_duration_us: duration_microseconds(prepared.plan.total_duration),
        expected_frames: prepared.plan.expected_frames(),
    }
}

/// Convert an exact duration in seconds into whole microseconds, rounding half away from zero.
///
/// The multiplication is exact, in `i128`, and the division rounds once at the end. Going
/// through `f64` instead would lose the exactness ADR 002 protects, and it would do so
/// silently: a `Rational` of `1/3` seconds is representable here to the microsecond, and is
/// not representable in binary floating point at all.
///
/// The result is clamped into the non-negative JavaScript safe-integer range the wire
/// contract requires. A negative total duration is not reachable -- `build_plan` rejects a
/// segment whose `in_pts` is not strictly before its `out_pts` -- and the upper clamp stands
/// at roughly 285 years of output.
fn duration_microseconds(seconds: Rational) -> u64 {
    let numerator = i128::from(seconds.num()) * MICROSECONDS_PER_SECOND;
    let denominator = i128::from(seconds.den());
    // `Rational::new` guarantees a positive denominator, so the sign of the rounding offset
    // follows the numerator alone.
    let offset = if numerator < 0 {
        -denominator / 2
    } else {
        denominator / 2
    };
    let microseconds = (numerator + offset) / denominator;
    u64::try_from(microseconds.clamp(0, JAVASCRIPT_MAX_SAFE_INTEGER)).unwrap_or(0)
}

/// What the export thread needs to prepare and run one export.
struct ExportJob {
    /// The export the interface asked for.
    request: ExportRequestWire,
    /// The directory of the settings file and of the discovery of the executables.
    app_data_directory: PathBuf,
    /// The cache directory of the application, which holds the work directories (ADR 055).
    cache_directory: PathBuf,
    /// The open FLV sources, which the FLV input shares with the preview (ADR 046).
    preview_windows: Arc<PreviewWindows>,
}

/// An export that waits for the slot, as the registry holds it (ADR 049).
struct QueuedExport {
    app: tauri::AppHandle,
    run_id: String,
    job: ExportJob,
}

impl WaitingRun for QueuedExport {
    /// Move the run and its slot to an export thread of its own.
    ///
    /// A thread that the operating system refuses is reported as a `failed` event, before the
    /// slot is released. The release then hands the slot to the next waiting run, and the
    /// order of the events stays the order of the runs.
    fn start(self: Box<Self>, slot: ExportSlot) {
        let QueuedExport { app, run_id, job } = *self;
        if let Err(refused) = spawn_export_job(app.clone(), slot, job) {
            let (slot, error) = *refused;
            emit_failed(&app, &run_id, error);
            drop(slot);
        }
    }

    /// Report the run that left the queue without starting as `canceled`.
    fn withdraw(self: Box<Self>) {
        emit_failed(
            &self.app,
            &self.run_id,
            ExportCommandError::new(ExportErrorCode::Canceled),
        );
    }
}

/// Start the dedicated thread that prepares and runs one export to completion.
///
/// This is an OS thread of its own, not the tokio blocking pool: an export runs for minutes,
/// and that pool is sized and scheduled for short work. Preparation runs short child
/// processes one after the other and waits on the file system, which the thread can afford.
///
/// The slot reaches the thread through a channel after the thread runs. A thread that the
/// operating system refuses therefore gives the slot back with the error, and the caller
/// reports the failure before it releases the slot.
fn spawn_export_job(
    app: tauri::AppHandle,
    slot: ExportSlot,
    job: ExportJob,
) -> Result<(), Box<(ExportSlot, ExportCommandError)>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel::<(ExportSlot, ExportJob)>(1);
    let spawned = std::thread::Builder::new()
        .name("export".to_owned())
        .spawn(move || {
            // The sender gives the run at once. A closed channel means the caller kept it.
            if let Ok((slot, job)) = receiver.recv() {
                run_export_job(&app, slot, job);
            }
        });
    match spawned {
        Ok(_) => sender
            .send((slot, job))
            .map_err(|std::sync::mpsc::SendError((slot, _))| {
                Box::new((
                    slot,
                    ExportCommandError::new(ExportErrorCode::CommandExecutionFailed),
                ))
            }),
        Err(error) => Err(Box::new((
            slot,
            ExportCommandError::with_detail(
                ExportErrorCode::CommandExecutionFailed,
                error.to_string(),
            ),
        ))),
    }
}

/// How long preparation can last for each source before the export thread stops waiting for it.
///
/// Preparation runs its bounded steps once for each source of the pieces, so the limit of a run
/// is this value multiplied by the number of its sources ([`PreparationLimits::for_sources`], ADR
/// 050, ADR 053).
///
/// Preparation runs up to three reads of FFprobe that each have
/// [`crate::ffmpeg::probe::PROBE_TIMEOUT`] (the re-probe and the two reads of the audio, ADR 016),
/// and the FLV input and the read of the audio gaps add reads of their own. Once for each export,
/// the option probe of ADR 055 runs `ffmpeg` up to twice for at most
/// [`crate::ffmpeg::export::graph_file::PROBE_TIMEOUT`] each. Six times that bound covers all of
/// them with a margin. The bound is for the steps that have none: a stat, a
/// canonicalization or a read in the file system that waits on a share that stopped answering.
/// Such a call cannot be interrupted, so at this deadline the export thread abandons the helper
/// thread and reports `preparationTimedOut`.
pub(crate) const PREPARATION_TIMEOUT: Duration =
    Duration::from_secs(6 * crate::ffmpeg::probe::PROBE_TIMEOUT.as_secs());

/// How long the export thread waits for the answer of the helper thread after it set the stop
/// flag of preparation.
///
/// A step that stops on the flag, such as the re-probe, answers within a poll of its own. A step
/// that is blocked in the file system does not answer, and the export thread reports without it.
/// The sum of this grace and [`PREPARATION_POLL`] must stay well below `EXIT_CANCEL_BUDGET` in
/// `lib.rs`, so that a quit during a blocked preparation still finds the slot free. A test in
/// `lib.rs` holds that rule.
pub(crate) const PREPARATION_CANCEL_GRACE: Duration = Duration::from_secs(2);

/// How often the export thread reads the cancel flag of the run and the clock while preparation
/// runs. An answer of the helper thread ends the wait at once, so this adds no delay to a
/// preparation that ends.
pub(crate) const PREPARATION_POLL: Duration = Duration::from_millis(50);

/// The time limits of the watchdog of [`run_export_job_with`]. Production uses
/// [`PreparationLimits::PRODUCTION`]. The tests use limits of milliseconds.
#[derive(Debug, Clone, Copy)]
struct PreparationLimits {
    /// See [`PREPARATION_TIMEOUT`].
    timeout: Duration,
    /// See [`PREPARATION_CANCEL_GRACE`].
    grace: Duration,
    /// See [`PREPARATION_POLL`].
    poll: Duration,
}

impl PreparationLimits {
    const PRODUCTION: Self = Self {
        timeout: PREPARATION_TIMEOUT,
        grace: PREPARATION_CANCEL_GRACE,
        poll: PREPARATION_POLL,
    };

    /// These limits for a preparation of `sources` sources: the timeout multiplied by their
    /// number, at least one. Preparation runs its bounded steps once for each source (ADR 050,
    /// ADR 053), so one limit covers the whole preparation.
    fn for_sources(self, sources: usize) -> Self {
        let factor = u32::try_from(sources.max(1)).unwrap_or(u32::MAX);
        Self {
            timeout: self.timeout.saturating_mul(factor),
            ..self
        }
    }
}

/// The steps of [`prepare_export_with`], as the report of a timeout names them.
///
/// The list is short on purpose. It names the step that waits, not each call inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum PreparationStage {
    /// The discovery of ffmpeg and ffprobe, with the read of the settings file.
    Discovery = 0,
    /// The read of the revision of the source ([`check_source_revision`]).
    RevisionCheck = 1,
    /// The re-probe of the source, with the correction of an FLV file that follows it.
    ReProbe = 2,
    /// The reads of the audio: the first packet and the sample rate before the FLV input
    /// ([`correct_audio_probe`]), and the audio gaps after it ([`read_audio_gaps`]).
    AudioReads = 3,
    /// The FLV input: the locate of the slices, the write of the head, and the check of the
    /// slices ([`flv_input_for`]).
    FlvInput = 4,
    /// The plan and its preflight checks of the paths ([`build_plan`]).
    Plan = 5,
    /// The reservation of the temporary output ([`PendingOutput::reserve`]).
    Reservation = 6,
    /// The graphs and the argument lists.
    Arguments = 7,
    /// The sweep of the work directories that earlier exports left, and the creation of the
    /// work directory of this export (ADR 055).
    WorkDirectory = 8,
    /// The option probe of ADR 055, which finds how `ffmpeg` reads a graph file
    /// ([`probe_graph_file_option`]).
    GraphFile = 9,
}

impl PreparationStage {
    /// Every stage, in the order of its number.
    const ALL: [Self; 10] = [
        Self::Discovery,
        Self::RevisionCheck,
        Self::ReProbe,
        Self::AudioReads,
        Self::FlvInput,
        Self::Plan,
        Self::Reservation,
        Self::Arguments,
        Self::WorkDirectory,
        Self::GraphFile,
    ];

    /// The name of the stage in the detail of `preparationTimedOut`. It is a diagnostic for a
    /// bug report (ADR 011), and the interface does not translate it.
    fn name(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::RevisionCheck => "revisionCheck",
            Self::ReProbe => "reProbe",
            Self::AudioReads => "audioReads",
            Self::FlvInput => "flvInput",
            Self::Plan => "plan",
            Self::Reservation => "reservation",
            Self::Arguments => "arguments",
            Self::WorkDirectory => "workDirectory",
            Self::GraphFile => "graphFile",
        }
    }
}

/// The stage of preparation that runs now, and the source it runs for, shared by the helper
/// thread that sets them and the export thread that reads them.
///
/// Both live in one atomic word, so a read never pairs the stage of one source with the number
/// of another: the low 8 bits hold the stage, and the bits above them one more than the index of
/// the source whose steps run, in the order of the first piece of each source, or 0 outside the
/// steps of a source.
#[derive(Debug, Default)]
struct PreparationStageCell(AtomicUsize);

/// The bits of [`PreparationStageCell`] that hold the stage.
const STAGE_BITS: u32 = 8;

impl PreparationStageCell {
    /// Record that `stage` starts now, for the source whose steps run already, if any.
    fn enter(&self, stage: PreparationStage) {
        let stage = stage as usize;
        // Keep the source bits, and replace the stage bits, in one exchange.
        let mut word = self.0.load(Ordering::SeqCst);
        loop {
            let next = (word >> STAGE_BITS << STAGE_BITS) | stage;
            match self
                .0
                .compare_exchange(word, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return,
                Err(current) => word = current,
            }
        }
    }

    /// Record, in one store, that `stage` starts now for the source `index`, or, with `None`,
    /// outside the steps of a source.
    fn enter_for(&self, stage: PreparationStage, index: Option<usize>) {
        let source = index.map_or(0, |index| index.saturating_add(1));
        self.0
            .store((source << STAGE_BITS) | stage as usize, Ordering::SeqCst);
    }

    /// The stage that runs now, and the source it runs for, read together.
    fn read(&self) -> (PreparationStage, Option<usize>) {
        let word = self.0.load(Ordering::SeqCst);
        let stage = PreparationStage::ALL
            .get(word & ((1 << STAGE_BITS) - 1))
            .copied()
            .unwrap_or(PreparationStage::Discovery);
        (stage, (word >> STAGE_BITS).checked_sub(1))
    }

    /// The detail of `preparationTimedOut`: the stage, and the source when a step of a source runs,
    /// counted from 1 in the order of the first piece of each source (ADR 053). It is a diagnostic
    /// for a bug report (ADR 011).
    fn detail(&self) -> String {
        let (stage, source) = self.read();
        let stage = stage.name();
        match source {
            Some(index) => format!("preparation stage: {stage}, source {}", index + 1),
            None => format!("preparation stage: {stage}"),
        }
    }

    /// The stage that runs now. A cell that no step set yet reads as [`PreparationStage::Discovery`].
    #[cfg(test)]
    fn current(&self) -> PreparationStage {
        self.read().0
    }
}

/// The answer of preparation, as the helper thread sends it to the export thread.
type PreparationAnswer = Result<PreparedExport, ExportCommandError>;

// The helper thread of preparation sends the prepared export to the export thread, so it must be
// `Send`. A future field that is not thread-safe then fails here, next to the type, and not in
// the spawn of the helper.
const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<PreparedExport>();
};

/// Prepare one export on a helper thread that the export thread watches, then run it on the
/// export thread.
///
/// The thin shell of [`run_export_job_with`], which holds the order and is what the tests call.
fn run_export_job(app: &tauri::AppHandle, slot: ExportSlot, job: ExportJob) {
    let run_id = slot.run_id().to_owned();
    // The first event of every run whose thread runs, so the interface learns that a run that
    // waited now holds the slot.
    emit_event(
        app,
        ExportEvent::Preparing {
            run_id: run_id.clone(),
        },
    );
    run_export_job_with(
        slot,
        PreparationLimits::PRODUCTION.for_sources(job.request.sources.len()),
        move |cancel, stage| {
            // This runs on the helper thread, which owns the job. `cancel` is the stop flag of
            // the helper, which the watchdog sets on a cancel of the run and at the deadline. The
            // flag is read between the steps, and the re-probe, the reads of the audio and the
            // FLV locate also stop on it while they run. A step that is blocked in the file
            // system does not see it, and the watchdog ends the run without that step.
            prepare_export_with(
                PrepareRequest {
                    request: &job.request,
                    app_data_directory: &job.app_data_directory,
                    cache_directory: &job.cache_directory,
                    cancel,
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
        },
        |slot, prepared| {
            // `start_payload` only copies and converts, and cannot panic. `run_export_worker`
            // turns a panic of the run itself into a report, so the run still sends exactly
            // one terminal event.
            let start = start_payload(&run_id, &prepared);
            run_export_worker(app, slot, prepared, &start);
        },
        |error| emit_failed(app, &run_id, error),
    );
}

/// Prepare one export with `prepare` on a helper thread, and hand the result to `run`, or report
/// the failure through `fail`.
///
/// A step of preparation can block in the file system, and such a call cannot be interrupted.
/// So `prepare` runs on a helper thread that owns everything it needs, with a stop flag of its
/// own, and this thread watches it (`limits`):
///
/// - A run that was canceled before this call reports `canceled` at once, and no helper thread
///   starts. The stop flag of the helper starts as the cancel flag of the run, so a cancel that
///   came before the spawn also reaches the first step.
/// - An answer ends the wait at once. A failure is reported, and the run ends. A failure that
///   comes while the run is canceled is reported as `canceled`, because the stop caused it or
///   raced it. A panic in
///   preparation is reported as `commandExecutionFailed` with its message, because the command
///   answered already and no other report would come.
/// - A cancel of the run sets the stop flag of the helper and waits up to the grace for its
///   answer. The run reports `canceled`, whatever the helper answers: a cancel wins over the
///   error it caused, and a prepared export that comes in the grace is dropped here.
/// - At the timeout, the run sets the stop flag of the helper, waits the grace in the same way,
///   and reports `preparationTimedOut` with the name of the stage that was running. A cancel
///   that came during that grace wins, and the run reports `canceled`.
/// - A helper that does not answer in the grace is abandoned. When its blocked call returns, it
///   reads its stop flag at the next step, and its send fails because this thread dropped the
///   receiver. Its answer then drops on the helper thread, and the guards of a late prepared
///   export delete the temporary file and remove the work directory there (ADR 055).
/// - A helper thread that the operating system refuses is reported as `commandExecutionFailed`
///   with the error of the system.
/// - The cancel flag is read once more after preparation passed its own checks. A cancel there
///   drops the prepared export, whose guards delete the temporary file and remove the work
///   directory, and then reports `canceled`.
/// - Every report comes before the slot is released, because the slot is dropped when this
///   function returns. A free slot therefore means that the guards of the run have finished,
///   which the wait at an application quit relies on (ADR 017). An abandoned helper is the
///   exception: its late answer drops on its own thread, after the release.
fn run_export_job_with<Prepare, Run, Fail>(
    slot: ExportSlot,
    limits: PreparationLimits,
    prepare: Prepare,
    run: Run,
    fail: Fail,
) where
    Prepare: FnOnce(&AtomicBool, &PreparationStageCell) -> PreparationAnswer + Send + 'static,
    Run: FnOnce(ExportSlot, PreparedExport),
    Fail: FnOnce(ExportCommandError),
{
    // Before the spawn: a run that a Stop reached before it started does not touch the file
    // system at all.
    if slot.is_canceled() {
        fail(ExportCommandError::new(ExportErrorCode::Canceled));
        return;
    }
    let stop = Arc::new(AtomicBool::new(slot.is_canceled()));
    let stage = Arc::new(PreparationStageCell::default());
    // A rendezvous channel. A send completes only when this thread receives the answer, so no
    // answer waits in a buffer after this thread stopped waiting. The send of an abandoned
    // helper fails, and the answer drops on the helper thread.
    let (sender, receiver) = std::sync::mpsc::sync_channel::<PreparationAnswer>(0);
    let spawned = {
        let stop = Arc::clone(&stop);
        let stage = Arc::clone(&stage);
        std::thread::Builder::new()
            .name("export-prepare".to_owned())
            .spawn(move || {
                let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    prepare(&stop, &stage)
                }))
                .unwrap_or_else(|payload| Err(panic_error(payload.as_ref())));
                // A failed send means that the export thread stopped waiting. The answer then
                // drops here, on this thread.
                let _ = sender.send(answer);
            })
    };
    if let Err(error) = spawned {
        fail(ExportCommandError::with_detail(
            ExportErrorCode::CommandExecutionFailed,
            error.to_string(),
        ));
        return;
    }
    let cancel = slot.cancel_flag();
    let answer = watch_preparation(&receiver, &cancel, &stop, &stage, limits);
    // Before the report, so the send of an abandoned helper fails from now on.
    drop(receiver);
    let prepared = match answer {
        Ok(prepared) => prepared,
        Err(error) => {
            fail(error);
            return;
        }
    };
    if slot.is_canceled() {
        drop(prepared);
        fail(ExportCommandError::new(ExportErrorCode::Canceled));
        return;
    }
    run(slot, prepared);
}

/// Wait for the answer of the helper thread of preparation, within `limits`. See
/// [`run_export_job_with`] for the rules.
fn watch_preparation(
    receiver: &std::sync::mpsc::Receiver<PreparationAnswer>,
    cancel: &AtomicBool,
    stop: &AtomicBool,
    stage: &PreparationStageCell,
    limits: PreparationLimits,
) -> PreparationAnswer {
    use std::sync::mpsc::RecvTimeoutError;

    let started = Instant::now();
    loop {
        match receiver.recv_timeout(limits.poll) {
            // A cancel wins over the failure that it caused or raced. A prepared export goes on
            // to the cancel check of `run_export_job_with`, which drops it.
            Ok(Err(_)) if cancel.load(Ordering::SeqCst) => {
                return Err(ExportCommandError::new(ExportErrorCode::Canceled))
            }
            Ok(answer) => return answer,
            // The helper always sends before it ends, so this means that it ended without an
            // answer. It is reported, as a panic is.
            Err(RecvTimeoutError::Disconnected) => {
                return Err(ExportCommandError::new(
                    ExportErrorCode::CommandExecutionFailed,
                ))
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if cancel.load(Ordering::SeqCst) {
            stop_preparation(receiver, stop, limits.grace);
            return Err(ExportCommandError::new(ExportErrorCode::Canceled));
        }
        if started.elapsed() >= limits.timeout {
            // Read before the stop, which can move the helper to its next step.
            let running = stage.detail();
            stop_preparation(receiver, stop, limits.grace);
            if cancel.load(Ordering::SeqCst) {
                return Err(ExportCommandError::new(ExportErrorCode::Canceled));
            }
            return Err(ExportCommandError::with_detail(
                ExportErrorCode::PreparationTimedOut,
                running,
            ));
        }
    }
}

/// Set the stop flag of the helper thread, and wait up to `grace` for its answer.
///
/// The caller reports the end of the run itself, so the answer only matters for its cleanup. A
/// prepared export that comes in the grace drops here, and its reservation guard deletes the
/// temporary file before the report.
fn stop_preparation(
    receiver: &std::sync::mpsc::Receiver<PreparationAnswer>,
    stop: &AtomicBool,
    grace: Duration,
) {
    stop.store(true, Ordering::SeqCst);
    if let Ok(Ok(prepared)) = receiver.recv_timeout(grace) {
        drop(prepared);
    }
}

/// The report of a panic in preparation. A panic is not an enumerable condition, so ADR 011 keeps
/// its message as the detail, when the payload is text.
fn panic_error(payload: &(dyn std::any::Any + Send)) -> ExportCommandError {
    let message = payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned());
    match message {
        Some(message) => {
            ExportCommandError::with_detail(ExportErrorCode::CommandExecutionFailed, message)
        }
        None => ExportCommandError::new(ExportErrorCode::CommandExecutionFailed),
    }
}

/// Report one export from its first event to its last.
///
/// `slot` is owned here and dropped when this returns, which releases the export slot on
/// every exit path, an unwind included.
fn run_export_worker(
    app: &tauri::AppHandle,
    slot: ExportSlot,
    prepared: PreparedExport,
    start: &ExportStart,
) {
    let run_id = start.run_id.clone();
    emit_event(
        app,
        ExportEvent::Started {
            run_id: run_id.clone(),
            output_path: start.output_path.clone(),
            segment_count: start.segment_count,
            total_duration_us: start.total_duration_us,
            expected_frames: start.expected_frames,
        },
    );

    let output_path = start.output_path.clone();
    // The published path, as a path. `output_path` is its lossy string form for the event, and
    // the show command must name the file that the rename wrote.
    let destination = prepared.plan.destination.clone();
    // A panic inside the run has to be turned back into a report. A lost report cannot be
    // tolerated -- the interface sits on "exporting" forever, with no timeout, and
    // `cancel_export` answers `false` because the slot is already free -- so the run needs the
    // protection that [`run_export_job_with`] gives preparation. It is reachable by
    // the mechanism this module already names: `run_export_process` calls
    // `std::thread::spawn` twice, and that panics rather than returning an error when the
    // operating system refuses a thread.
    //
    // Every guard has already run by the time the panic arm below is reached. The unwind
    // passes `ChildGuard`, which kills and reaps ffmpeg, `PendingOutput`, which deletes the
    // reservation, and `ExportWorkDirectory`, which removes the work directory of ADR 055. `slot`
    // is released by the drop at the end of this function. So this
    // arm cleans nothing up. It only supplies the report that would otherwise never come.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_export(app, &slot, prepared, &run_id)
    }));
    match outcome {
        Ok(Ok(frames)) => {
            // Recorded before the event, so a show request that follows the event finds the
            // file. The command takes the path from this record and never from the web view
            // (`commands::export_output`).
            if let Some(published) = app.try_state::<PublishedExports>() {
                published.record(&run_id, destination);
            }
            emit_event(
                app,
                ExportEvent::Finished {
                    run_id,
                    output_path,
                    frames,
                },
            );
        }
        Ok(Err(error)) => emit_failed(app, &run_id, error),
        Err(_) => emit_failed(
            app,
            &run_id,
            ExportCommandError::new(ExportErrorCode::CommandExecutionFailed),
        ),
    }
}

/// Run the process stage, verify what it produced, and publish the output.
///
/// This is the thin shell `commands::capabilities::run_probe_worker` is: it closes over the
/// [`tauri::AppHandle`] and hands [`run_export_with`] a plain event sink. Everything worth a
/// test is in that function, because this crate does not enable tauri's `test` feature and
/// nothing that takes an `AppHandle` can be called from a test at all.
fn run_export(
    app: &tauri::AppHandle,
    slot: &ExportSlot,
    prepared: PreparedExport,
    run_id: &str,
) -> Result<u64, ExportCommandError> {
    run_export_with(
        slot,
        prepared,
        run_id,
        |event| emit_event(app, event),
        |request, on_progress| run_export_process(request, on_progress),
        ffmpeg::probe_output_audio,
    )
}

/// Run the process stage, verify what it produced, and publish the output, reporting through
/// `emit`, running the child through `process`, and reading a finished file back through
/// `probe_output`: the file of an export without video, and the file of an export with video that
/// copies its audio.
///
/// The three checks between the process exiting and the rename are obligations 4 and 5 of
/// this module's documentation, in the order ADR 016 requires them: the success check, then
/// the cancel flag, then the publication. The success check is the frame count for a plan
/// with video, followed by [`verified_copy_streams`] when that plan copies its audio (ADR 048),
/// and [`verified_audio_output`] for a plan without video. A failed check returns
/// before the cancel flag is read and before `publishing` is emitted, and the early return
/// drops the reservation, whose guard deletes the temporary file as on every other failure.
///
/// `emit`, `process`, and `probe_output` are parameters for the same reason: this order is the
/// whole point of the function, and a test has to be able to observe it. `process` lets a test
/// return a chosen outcome, and set the cancel flag from inside the call, without an ffmpeg;
/// `probe_output` lets it choose what ffprobe reports about the finished file, without an
/// ffprobe, and receives the run's cancel flag, so a test can stop a slow probe; `emit` lets it
/// assert which events the order did and did not produce.
fn run_export_with<Emit, Process, ProbeOutput>(
    slot: &ExportSlot,
    prepared: PreparedExport,
    run_id: &str,
    emit: Emit,
    process: Process,
    probe_output: ProbeOutput,
) -> Result<u64, ExportCommandError>
where
    Emit: Fn(ExportEvent),
    Process: FnOnce(
        ExportProcessRequest<'_>,
        &mut dyn FnMut(&ProgressSnapshot),
    ) -> std::io::Result<ExportProcessOutcome>,
    ProbeOutput: FnOnce(&Path, &Path, &AtomicBool) -> Result<OutputAudioProbe, ProbeError>,
{
    let PreparedExport {
        plan,
        ffmpeg,
        ffprobe,
        arguments,
        audio_arguments,
        pending,
        work,
        ..
    } = prepared;
    let expected_frames = plan.expected_frames();
    let cancel = slot.cancel_flag();

    let outcome = process(
        ExportProcessRequest {
            ffmpeg: &ffmpeg,
            arguments: &arguments,
            audio_arguments: audio_arguments.as_deref(),
            // Every export runs in its work directory, whose files its commands name by their
            // names alone (ADR 055).
            working_directory: Some(work.path()),
            cancel: cancel.as_ref(),
            poll: PROGRESS_POLL_INTERVAL,
        },
        &mut |snapshot| {
            if let Some(event) = progress_event(run_id, snapshot, expected_frames) {
                emit(event);
            }
        },
    );
    // Both processes have ended and are reaped, so nothing holds the directory any more. It is
    // removed before the checks and the rename (ADR 055). A process that did not start leaves
    // it too.
    work.remove();
    let outcome = outcome.map_err(|error| {
        ExportCommandError::with_detail(ExportErrorCode::FfmpegSpawnFailed, error.to_string())
    })?;

    match outcome.status {
        ExportProcessStatus::Canceled => {
            return Err(ExportCommandError::new(ExportErrorCode::Canceled));
        }
        ExportProcessStatus::Exited {
            success: false,
            code,
        } => {
            return Err(ExportCommandError {
                detail: outcome.stderr_detail(),
                exit_code: code,
                ..ExportCommandError::new(ExportErrorCode::FfmpegProcessFailed)
            });
        }
        ExportProcessStatus::Exited { success: true, .. } => {}
    }

    // The success check. A plan with video counts its frames. A plan without video writes no
    // frames, and its progress cannot stand in for them: an audio-only block carries no `frame`
    // key, and `out_time_us` is wrong under `-copyts` (ADR 014 measurement 12). So the check
    // reads the finished file back instead, and an export without video reports no frames.
    let frames = if plan.video.is_some() {
        let frames = verified_frame_count(
            expected_frames,
            outcome.last_progress.as_ref(),
            outcome.stderr_detail(),
        )?;
        // The frame count says nothing about audio that the export copies, so the file is read
        // back for its streams too (ADR 048).
        if plan.copied_audio.is_some() {
            verified_copy_streams(outcome.stderr_detail(), || {
                probe_output(&ffprobe, pending.path(), cancel.as_ref())
            })?;
        }
        frames
    } else {
        // A plan without video encodes its audio or copies it (ADR 048). The copy has no
        // `PlannedAudio`, and its expected duration is the total duration, as for the encode. Its
        // check adds the start of the audio, which a copy keeps.
        let expected = plan
            .audio
            .as_ref()
            .map_or(plan.total_duration, |audio| audio.expected_duration);
        verified_audio_output(
            expected,
            plan.copied_audio.is_some(),
            outcome.last_progress.as_ref(),
            outcome.stderr_detail(),
            || probe_output(&ffprobe, pending.path(), cancel.as_ref()),
        )?;
        0
    };

    // ADR 016's second cancel test. Without it a cancel that arrives during the last seconds
    // of the encode still renames the output over the file the user chose. It runs after the
    // success check, so it also covers a cancel that arrives just after ffprobe read the output;
    // one that arrives while ffprobe runs stops the probe itself (`ProbeError::Canceled`).
    if slot.is_canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    emit(ExportEvent::Publishing {
        run_id: run_id.to_owned(),
    });
    // `commit` is `commit_within(EXPORT_PUBLISH_BUDGET)`. Naming the budget here as well would
    // put one policy in two places, and `output.rs` states that `commit` is its only caller.
    // Keep the diagnostic only when a raw operating-system code proves the operating system
    // wrote it. `fsutil` manufactures more than one error on this path: the Unix refusal to
    // overwrite a read-only destination, where no system call ran, and on Windows an
    // `InvalidInput` from the path resolution above the retry loop. Every one of them carries a
    // Rust-authored English message, which ADR 011 keeps out of the interface, and none carries a
    // raw code, so this one guard covers them all. `outputRenameFailed` is the whole account of
    // those cases on its own. `commands/settings.rs`'s `map_io_error` and `commands/project.rs`
    // apply the same guard.
    pending
        .commit()
        .map_err(|error| match error.raw_os_error() {
            Some(_) => ExportCommandError::with_detail(
                ExportErrorCode::OutputRenameFailed,
                error.to_string(),
            ),
            None => ExportCommandError::new(ExportErrorCode::OutputRenameFailed),
        })?;

    Ok(frames)
}

/// Decide whether an ffmpeg that exited zero actually wrote the video that was planned.
///
/// ADR 014 requires this comparison and ADR 016 records why it cannot be skipped: ffmpeg
/// exits **zero** when it refuses to overwrite the reserved file, having written no frames at
/// all, so the exit status alone cannot tell a finished export from an empty one.
///
/// An absent snapshot is rejected on its own, before `expected_frames` is consulted at all.
/// `process.rs` states the rule: `last_progress` of `None` after an `Exited` "is itself a
/// finding, not an absence of information". Folding it into a count of zero and then comparing
/// would leave the gate vacuous for two reachable plans -- an `expected_frames` of `Some(0)`,
/// which a preset frame rate low enough to round a short mark below half an output frame
/// produces, and the `None` of ADR 014's variable-frame-rate mode -- and each of those would
/// publish an empty reservation over the file the user chose.
///
/// A snapshot that exists but carries no `frame` key still counts as zero frames written, and
/// is compared: it says the child was reporting, which the absent snapshot does not.
///
/// `expected_frames` is absent in two different cases, and only the first one reaches this
/// function. A future variable-frame-rate mode cannot predict a count: there is then nothing to
/// compare a real count against, and the export proceeds. A plan without video writes no frames
/// at all, so this comparison would accept any snapshot for it and could not catch the
/// missing-`-y` failure above. [`run_export_with`] therefore never calls this function for such
/// a plan; [`verified_audio_output`] is its check.
///
/// `detail` is the process's own stderr tail, which on the missing-`-y` path holds ffmpeg's
/// refusal message and is the most useful thing a user can be shown.
fn verified_frame_count(
    expected_frames: Option<u64>,
    last_progress: Option<&ProgressSnapshot>,
    detail: Option<String>,
) -> Result<u64, ExportCommandError> {
    fn mismatch(detail: Option<String>) -> ExportCommandError {
        ExportCommandError {
            detail,
            ..ExportCommandError::new(ExportErrorCode::FrameCountMismatch)
        }
    }

    // No progress block at all, whatever was expected. See the paragraph above.
    let Some(snapshot) = last_progress else {
        return Err(mismatch(detail));
    };
    let frames = snapshot.frame.unwrap_or(0);
    if expected_frames.is_some_and(|expected| frames < expected) {
        return Err(mismatch(detail));
    }
    Ok(frames)
}

/// Decide whether an ffmpeg that exited zero actually wrote the audio that was planned, for an
/// export without video.
///
/// This is [`verified_frame_count`] for a plan that has no frames to count, and it answers the
/// same question for the same reason: the exit status alone cannot tell a finished export from
/// the empty reservation that the missing-`-y` path leaves behind.
///
/// 1. No progress block at all is a failure on its own, as it is for the frame count, and the
///    probe does not run: the child never reported, so there is nothing written to read back.
///    It reports `outputStreamsMismatch`, because the file holds none of the planned streams.
/// 2. `probe` runs ffprobe on the finished temporary file, within
///    [`crate::ffmpeg::probe::PROBE_TIMEOUT`] and under the run's cancel flag. How a probe that
///    fails is reported depends on where the fault is:
///    - ffprobe exited unsuccessfully, or wrote an answer that does not parse: the fault is in
///      the file ffmpeg wrote, such as an `.m4a` with no index or an empty reservation. This
///      reports `outputStreamsMismatch`, with ffmpeg's stderr tail as the detail, because that
///      tail says why the file is wrong and ffprobe's says only that it is.
///    - ffprobe could not start, or did not answer in time: the fault is in ffprobe or in the
///      disk, not in the file. These keep `ffprobeSpawnFailed` and `ffprobeTimedOut`, with
///      ffprobe's own diagnostic ([`map_reprobe_error`]).
///    - The run was canceled while ffprobe ran: `canceled`.
/// 3. [`verify_audio_output`] compares the answer with the plan: one audio stream, no video
///    stream, and `expected` within its tolerance. `expected` is
///    [`crate::ffmpeg::export::PlannedAudio::expected_duration`], the planned duration of the
///    segments. A wrong stream set reports `outputStreamsMismatch`. A duration outside the
///    tolerance, or none, reports `audioDurationMismatch`, with the measured and the expected
///    duration as named values. When `copied` is true, the plan copied the audio, and
///    [`verify_copied_audio_output`] compares instead: it adds the start of the audio stream to
///    the duration, because a copy keeps the place of its first packet (ADR 048).
///
/// `detail` is the process's own stderr tail, as for the frame count.
fn verified_audio_output(
    expected: Rational,
    copied: bool,
    last_progress: Option<&ProgressSnapshot>,
    detail: Option<String>,
    probe: impl FnOnce() -> Result<OutputAudioProbe, ProbeError>,
) -> Result<(), ExportCommandError> {
    if last_progress.is_none() {
        return Err(streams_mismatch(detail));
    }
    let answer = read_finished_output(probe, &detail)?;
    let verify = if copied {
        verify_copied_audio_output
    } else {
        verify_audio_output
    };
    verify(&answer, expected).map_err(|mismatch| match mismatch {
        AudioOutputMismatch::Streams { .. } => streams_mismatch(detail),
        AudioOutputMismatch::Duration { measured, expected } => ExportCommandError {
            detail,
            measured_duration_us: measured.map(duration_microseconds),
            expected_duration_us: Some(duration_microseconds(expected)),
            ..ExportCommandError::new(ExportErrorCode::AudioDurationMismatch)
        },
    })
}

/// Decide whether the finished file of an export with video that copies its audio holds the copied
/// audio, after [`verified_frame_count`] passed (ADR 048).
///
/// `probe` reads the file as it does for [`verified_audio_output`], and a probe that fails is
/// reported as there. [`verify_copy_streams`] then requires one video stream and one audio stream,
/// and any other set reports `outputStreamsMismatch`. Unlike the conditions that make the plan
/// encode the audio instead of copying it, this check fails the export: the file is wrong, and
/// publishing it would replace the file of the user with a video that lost its sound.
///
/// `detail` is the process's own stderr tail, as for the frame count.
fn verified_copy_streams(
    detail: Option<String>,
    probe: impl FnOnce() -> Result<OutputAudioProbe, ProbeError>,
) -> Result<(), ExportCommandError> {
    let answer = read_finished_output(probe, &detail)?;
    verify_copy_streams(&answer).map_err(|mismatch| match mismatch {
        AudioOutputMismatch::Streams { .. } => streams_mismatch(detail),
        // `verify_copy_streams` reads no duration today. A check that does would report it as
        // the check of an export without video does.
        AudioOutputMismatch::Duration { measured, expected } => ExportCommandError {
            detail,
            measured_duration_us: measured.map(duration_microseconds),
            expected_duration_us: Some(duration_microseconds(expected)),
            ..ExportCommandError::new(ExportErrorCode::AudioDurationMismatch)
        },
    })
}

/// Read the finished file of an export back through `probe`, and report a probe that fails as
/// [`verified_audio_output`] documents: a fault in the file is `outputStreamsMismatch` with
/// `detail`, a cancel is `canceled`, and a fault of ffprobe keeps its own code.
fn read_finished_output(
    probe: impl FnOnce() -> Result<OutputAudioProbe, ProbeError>,
    detail: &Option<String>,
) -> Result<OutputAudioProbe, ExportCommandError> {
    probe().map_err(|error| match error {
        ProbeError::ProcessFailed { .. } | ProbeError::Parse { .. } => {
            streams_mismatch(detail.clone())
        }
        ProbeError::Canceled => ExportCommandError::new(ExportErrorCode::Canceled),
        ProbeError::Spawn { .. } | ProbeError::TimedOut { .. } => map_reprobe_error(error),
    })
}

/// `outputStreamsMismatch` with `detail`: the finished file does not hold the planned streams.
fn streams_mismatch(detail: Option<String>) -> ExportCommandError {
    ExportCommandError {
        detail,
        ..ExportCommandError::new(ExportErrorCode::OutputStreamsMismatch)
    }
}

/// Turn one progress snapshot into the event the frontend accepts, or into nothing.
///
/// A snapshot with no `frame` produces no event at all. `frame` is required on the wire, and
/// the frontend's strict validator drops a whole event that is missing it, so emitting one
/// would cost a progress update and gain nothing. Every snapshot of an export without video is
/// such a snapshot (see [`ProgressSnapshot::frame`]), so that export sends no progress event,
/// and the interface shows its `running` phase as indeterminate.
///
/// `fps` and `speed` are filtered the same way and for the same reason. The validator accepts
/// only a strictly positive `fps` and a non-negative `speed`, and ffmpeg really does write
/// `fps=0.00` in the first blocks of a run, before it has a rate to report. Passing that
/// value on would make the frontend reject the entire event, and the progress bar would stall
/// exactly at the start, where a user is most likely to be watching it.
fn progress_event(
    run_id: &str,
    snapshot: &ProgressSnapshot,
    expected_frames: Option<u64>,
) -> Option<ExportEvent> {
    let frame = snapshot.frame?;
    Some(ExportEvent::Progress {
        run_id: run_id.to_owned(),
        frame,
        expected_frames,
        fps: snapshot.fps.filter(|rate| rate.num() > 0),
        speed: snapshot.speed.filter(|rate| rate.num() >= 0),
        total_size: snapshot.total_size,
    })
}

/// Translate the shared ffprobe mapping of `commands::media` into the export vocabulary.
///
/// The re-probe runs the same ffprobe the import ran, so it fails in the same four ways.
/// Reusing `map_probe_error` keeps one mapping from a `ProbeError` to a code, a diagnostic,
/// and an exit code, rather than letting a second copy drift away from it. The probe of a
/// finished file ([`read_finished_output`], for [`verified_audio_output`] and
/// [`verified_copy_streams`]) runs the same ffprobe through the same runner. It uses this mapping
/// only for a probe that cannot start or that
/// times out: an exit failure or a parse failure there is a wrong output, not a fault of the
/// source, and a cancel ends the run as canceled.
///
/// The timeout matters more here than it does on the import path. The run holds the single
/// export slot while the re-probe runs, so an unbounded probe would hold it for the rest of the
/// process's life, and every later export would wait behind it in the queue.
fn map_reprobe_error(error: ProbeError) -> ExportCommandError {
    let mapped = map_probe_error(error);
    let code = match mapped.code {
        ImportMediaErrorCode::FfprobeSpawnFailed => ExportErrorCode::FfprobeSpawnFailed,
        ImportMediaErrorCode::FfprobeProcessFailed => ExportErrorCode::FfprobeProcessFailed,
        ImportMediaErrorCode::FfprobeParseFailed => ExportErrorCode::FfprobeParseFailed,
        ImportMediaErrorCode::FfprobeTimedOut => ExportErrorCode::FfprobeTimedOut,
        // `map_probe_error` produces exactly the four codes above for the four ways a probe
        // fails. Its fifth variant, `Canceled`, comes only from a probe that holds a cancel
        // flag, and the re-probe and the output probe handle it before this mapping. This arm
        // is therefore unreachable. It reports rather than panics: a new probe failure mode
        // must not take an export worker down with it.
        _ => {
            debug_assert!(false, "map_probe_error produced an unexpected code");
            ExportErrorCode::FfprobeProcessFailed
        }
    };
    ExportCommandError {
        detail: mapped.detail,
        exit_code: mapped.exit_code,
        ..ExportCommandError::new(code)
    }
}

fn emit_failed(app: &tauri::AppHandle, run_id: &str, error: ExportCommandError) {
    emit_event(app, failed_event(run_id, error));
}

/// The `failed` event that reports `error`, field for field.
fn failed_event(run_id: &str, error: ExportCommandError) -> ExportEvent {
    ExportEvent::Failed {
        run_id: run_id.to_owned(),
        code: error.code,
        detail: error.detail,
        exit_code: error.exit_code,
        encoder: error.encoder,
        measured_duration_us: error.measured_duration_us,
        expected_duration_us: error.expected_duration_us,
    }
}

/// Send `event` through the export journal, which gives it its sequence number and applies it to
/// its run (`commands::export_journal`). Every export event goes out here.
///
/// The journal calls `app.emit` while it holds its lock. This is safe because no export event
/// comes from the main thread: see [`ExportJournal`].
fn emit_event(app: &tauri::AppHandle, event: ExportEvent) {
    // A failed emit means nobody is listening, for example because the window closed during
    // the encode. It must never propagate: this is called from the progress callback, which
    // runs inside `run_export_process`'s supervision loop, and a panic there unwinds straight
    // out of that function and loses the whole outcome -- no status, no stderr, no frame
    // count -- leaving the caller with nothing to report but the panic.
    match app.try_state::<ExportJournal>() {
        Some(journal) => journal.emit(event, |seq, event| {
            let _ = app.emit(EVENT_NAME, SequencedEvent { seq, event });
        }),
        None => {
            // `lib.rs` manages the journal, so this is a fault of the program. The event still
            // goes out, without a number, so that the interface does not wait for it forever.
            debug_assert!(false, "the export journal is not managed state");
            let _ = app.emit(EVENT_NAME, event);
        }
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::{OutputTiming, PlannedSegment, PlannedVideo};
    use crate::ffmpeg::ExecutableOrigin;
    use crate::settings::{
        AudioChannels, AudioSampleRateSetting, Container, FrameRateSetting, Quality, QualityKind,
        ResolutionSetting,
    };
    use crate::time::{FrameCount, TickCount};
    use std::cell::{Cell, RefCell};
    use std::fs;

    fn sample_snapshot(frame: Option<u64>) -> ProgressSnapshot {
        ProgressSnapshot {
            frame,
            fps: Rational::new(30, 1),
            speed: Rational::new(2, 1),
            total_size: Some(4096),
            done: false,
        }
    }

    fn sample_preset(id: &str) -> Preset {
        Preset {
            id: id.to_owned(),
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

    fn sample_probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: Some("QuickTime / MOV".to_owned()),
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: Some("High".to_owned()),
            pixel_format: Some("yuv420p".to_owned()),
            bit_depth: Some(8),
            width: 1920,
            height: 1080,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: Some(Pts::new(0)),
            video_duration_ticks: Some(TickCount::new(900_000).unwrap()),
            approximate_duration_seconds: Some(10.0),
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: Some(FrameCount::new(300).unwrap()),
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: None,
        }
    }

    /// A read of the first audio packet that fails, so the values of the re-probe stand.
    fn first_packet_unread(
        _: &Path,
        _: &Path,
        _: u32,
        _: &AtomicBool,
    ) -> Result<Option<FirstAudioPacket>, ProbeError> {
        Err(ProbeError::ProcessFailed {
            code: Some(1),
            stderr: Vec::new(),
        })
    }

    /// A read of the first audio packet that reaches the end of the file without a packet of
    /// the stream: the stream holds no audio.
    fn no_first_packet(
        _: &Path,
        _: &Path,
        _: u32,
        _: &AtomicBool,
    ) -> Result<Option<FirstAudioPacket>, ProbeError> {
        Ok(None)
    }

    /// A read of the gaps inside the audio stream that finds none.
    fn no_audio_gaps(
        _: &Path,
        _: &Path,
        _: &AudioGapRead<'_>,
        _: &AtomicBool,
    ) -> Result<AudioFrames, ProbeError> {
        Ok(AudioFrames::default())
    }

    /// The option probe of ADR 055 on FFmpeg 7.0 and later: `-/filter_complex`.
    fn slash_graph_file(
        _: &Path,
        _: &ExportWorkDirectory,
        _: &AtomicBool,
    ) -> Result<GraphFileOption, GraphFileProbeError> {
        Ok(GraphFileOption::Slash)
    }

    /// A read of the sample rate that a test expects never to run.
    fn sample_rate_not_read(
        _: &Path,
        _: &Path,
        _: u64,
        _: u32,
        _: &AtomicBool,
    ) -> Result<Option<u32>, ProbeError> {
        unreachable!("the re-probe reported a sample rate, or no packet gave a position")
    }

    fn sample_plan(destination: &Path) -> ExportPlan {
        ExportPlan {
            sources: vec![crate::ffmpeg::export::PlannedSource {
                path: PathBuf::from("/media/source.mp4"),
                video_stream_index: 0,
                fit: None,
                audio: None,
                flv_input: None,
            }],
            destination: destination.to_path_buf(),
            video: Some(PlannedVideo {
                timing: OutputTiming::ConstantFrameRate(Rational::new(30, 1).unwrap()),
                canvas: None,
                encoder: "libx264".to_owned(),
                quality: Quality {
                    kind: QualityKind::Crf,
                    value: 20,
                },
                pixel_format: "yuv420p".to_owned(),
                options: vec![],
                expected_frames: Some(30),
            }),
            audio: None,
            segments: vec![PlannedSegment {
                source: 0,
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
                seek_seconds: None,
                audio_in_tick: None,
                audio_out_tick: None,
                frames: Some(30),
                audio_prefix: None,
            }],
            container: Container::Mp4,
            total_duration: Rational::new(1, 1).unwrap(),
            copied_audio: None,
            audio_copy_refusal: None,
        }
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "quipclip-export-command-{}-{}",
                std::process::id(),
                next_run_id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// The ffmpeg and the ffprobe of this machine, or `None`, in which case the test does
    /// nothing.
    fn real_tools() -> Option<(PathBuf, PathBuf)> {
        let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        directories.push(PathBuf::from("/opt/homebrew/bin"));
        directories.push(PathBuf::from("/usr/local/bin"));
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        directories.into_iter().find_map(|directory| {
            let ffmpeg = directory.join(format!("ffmpeg{suffix}"));
            let ffprobe = directory.join(format!("ffprobe{suffix}"));
            (ffmpeg.is_file() && ffprobe.is_file()).then_some((ffmpeg, ffprobe))
        })
    }

    /// Write an FLV of 4 s of H.264 at `size`, with a keyframe each second, and AAC at `rate`,
    /// made by ffmpeg.
    fn write_real_flv(ffmpeg: &Path, path: &Path, size: &str, rate: u32) {
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
            .arg(format!("testsrc2=size={size}:rate=30"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:sample_rate={rate}"))
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
                "aac",
                "-f",
                "flv",
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// The input of the slice of `source` from its keyframe at 2 s, with the head of `head_of`
    /// written to the directory `name` of `directory`, which stands for the work directory, and
    /// the path of that directory.
    fn real_input(
        directory: &TestDirectory,
        name: &str,
        source: &Path,
        head_of: &Path,
    ) -> (FlvInput, PathBuf) {
        let reader = crate::flv::FlvSource::open(source, None).unwrap();
        let offset = reader.locate(2_000, None).unwrap().0.keyframe.offset;
        let head = crate::flv::FlvSource::open(head_of, None).unwrap();
        let head_offset = if head_of == source {
            offset
        } else {
            head.head().first_frame_offset
        };
        let work_directory = directory.path.join(name);
        fs::create_dir_all(&work_directory).unwrap();
        let input = FlvInput {
            head_name: crate::ffmpeg::export::flv_input::head_name(0),
            source_size: fs::metadata(source).unwrap().len(),
            segment_offsets: vec![offset, offset],
            first_frame_offset: reader.head().first_frame_offset,
        };
        fs::write(
            input.head_path(&work_directory),
            head.head_bytes_at(head_offset),
        )
        .unwrap();
        (input, work_directory)
    }

    #[test]
    fn the_slice_check_refuses_a_slice_that_decodes_with_the_configuration_of_another_part() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let wide = directory.path.join("wide.flv");
        let small = directory.path.join("small.flv");
        write_real_flv(&ffmpeg, &wide, "320x180", 48_000);
        write_real_flv(&ffmpeg, &small, "160x90", 48_000);
        let probe = ffmpeg::probe_media(&ffprobe, &small).unwrap();
        assert!(probe.audio.is_some());
        let cancel = AtomicBool::new(false);

        let (own, own_work) = real_input(&directory, "own", &small, &small);
        assert!(check_slices(&ffprobe, &own, &own_work, &small, &probe, true, &cancel).is_ok());

        // The head of another recording holds the decoder configuration of another picture
        // size, as the head of a file holds before a reconnect that no read has seen.
        let (foreign, foreign_work) = real_input(&directory, "foreign", &small, &wide);
        assert!(matches!(
            check_slices(
                &ffprobe,
                &foreign,
                &foreign_work,
                &small,
                &probe,
                true,
                &cancel
            ),
            Err(SliceCheck::Refused(_))
        ));

        cancel.store(true, Ordering::SeqCst);
        assert!(matches!(
            check_slices(&ffprobe, &own, &own_work, &small, &probe, true, &cancel),
            Err(SliceCheck::Canceled)
        ));
    }

    #[test]
    fn the_slice_check_refuses_audio_that_decodes_with_the_rate_of_another_part() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        // The same picture, so the video decodes cleanly with either head. A raw AAC frame does
        // not carry its rate, so the audio decodes with no error at the rate of the head. A file
        // that starts at 44100 Hz has that rate in its probe and in the head of its start. After
        // a change to 48000 Hz that no read has seen, the tags of a slice advance by 1024
        // samples at 48000 Hz.
        let directory = TestDirectory::new();
        let low = directory.path.join("low.flv");
        let high = directory.path.join("high.flv");
        write_real_flv(&ffmpeg, &low, "160x90", 44_100);
        write_real_flv(&ffmpeg, &high, "160x90", 48_000);
        let cancel = AtomicBool::new(false);
        let high_probe = ffmpeg::probe_media(&ffprobe, &high).unwrap();
        let (own, own_work) = real_input(&directory, "own", &high, &high);
        assert!(check_slices(&ffprobe, &own, &own_work, &high, &high_probe, true, &cancel).is_ok());
        let low_probe = ffmpeg::probe_media(&ffprobe, &low).unwrap();
        let (foreign, foreign_work) = real_input(&directory, "foreign", &high, &low);
        let Err(SliceCheck::Refused(reason)) = check_slices(
            &ffprobe,
            &foreign,
            &foreign_work,
            &high,
            &low_probe,
            true,
            &cancel,
        ) else {
            panic!("the slice with the head of another rate was not refused");
        };
        // The picture decodes cleanly, so the timing of the audio refused the slice.
        assert!(reason.contains("picture true, audio false"), "{reason}");
        // An export without audio does not check it.
        assert!(check_slices(
            &ffprobe,
            &foreign,
            &foreign_work,
            &high,
            &low_probe,
            false,
            &cancel
        )
        .is_ok());
    }

    #[test]
    fn the_audio_gaps_read_through_the_slices_agree_with_the_read_by_seek() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("source.flv");
        write_real_flv(&ffmpeg, &source, "160x90", 48_000);
        let (input, work_directory) = real_input(&directory, "own", &source, &source);
        let ranges = [
            (Rational::new(5, 2).unwrap(), Rational::new(3, 1).unwrap()),
            (Rational::new(2, 1).unwrap(), Rational::new(5, 2).unwrap()),
        ];
        let read = |flv: Option<(&FlvInput, &Path)>| {
            ffmpeg::probe_audio_gaps(
                &ffprobe,
                &source,
                &AudioGapRead {
                    stream_index: 1,
                    sample_rate: 48_000,
                    ranges: &ranges,
                    min_gap: Rational::new(1, 100).unwrap(),
                    flv,
                },
                &AtomicBool::new(false),
            )
            .unwrap()
        };
        // The plan counts a gap whose end lies inside a segment. A continuous tone has none
        // either way. The read of a slice starts at its keyframe, before the seek of the other
        // read lands, so the first frame that each read finds can differ.
        let inside = |gaps: Vec<ffmpeg::AudioGap>| -> Vec<ffmpeg::AudioGap> {
            gaps.into_iter()
                .filter(|gap| {
                    ranges
                        .iter()
                        .any(|(start, end)| gap.to > *start && gap.to < *end)
                })
                .collect()
        };
        let by_slices = read(Some((&input, &work_directory)));
        assert!(!by_slices.gaps.is_empty(), "the read found the first frame");
        // The read stops at the first packet at or after the end of the last range, 3 s.
        assert!(by_slices
            .end
            .is_some_and(|end| end >= Rational::new(3, 1).unwrap()));
        assert_eq!(inside(by_slices.gaps), vec![]);
        assert_eq!(inside(read(None).gaps), vec![]);
    }

    #[test]
    fn an_flv_source_gets_its_slices_and_a_cancel_ends_the_run() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("source.flv");
        write_real_flv(&ffmpeg, &source, "160x90", 48_000);
        let probe = ffmpeg::probe_media(&ffprobe, &source).unwrap();
        let tb = probe.video_time_base;
        // In points at 3.5 s and 1 s, in that concat order, in the time base of the probe.
        let at = |millis: i64| Pts::new(millis * tb.den() / (1_000 * tb.num()));
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![
                ExportPieceWire {
                    source_id: "source".to_owned(),
                    in_pts: at(3_500),
                    out_pts: at(3_900),
                },
                ExportPieceWire {
                    source_id: "source".to_owned(),
                    in_pts: at(1_000),
                    out_pts: at(1_500),
                },
            ],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let app_data = directory.path.join("app");
        let work = ExportWorkDirectory::create(&directory.path.join("cache")).unwrap();
        let windows = PreviewWindows::default();
        let pieces = resolve_request(&request).unwrap().pieces;
        let run = |probe: &MediaProbe, cancel: &AtomicBool| {
            flv_input_for(
                &ffprobe,
                &source,
                probe,
                &pieces,
                request.streams,
                FlvPlace {
                    app_data_directory: &app_data,
                    work_directory: &work,
                    source_index: 2,
                },
                &windows,
                cancel,
            )
        };
        // Both seek positions lie before the first keyframe, so both slices start at the first
        // frame of the file, which needs no check.
        let input = run(&probe, &AtomicBool::new(false)).unwrap().unwrap();
        assert_eq!(input.segment_offsets.len(), 2);
        assert!(input
            .segment_offsets
            .iter()
            .all(|offset| *offset == input.first_frame_offset));
        assert_eq!(input.head_name, "h2.flv");
        assert!(work.file_path("h2.flv").is_file());

        let mut not_flv = probe.clone();
        not_flv.format_names = vec!["mov".to_owned()];
        assert_eq!(run(&not_flv, &AtomicBool::new(false)).unwrap(), None);

        let canceled = run(&probe, &AtomicBool::new(true));
        assert!(matches!(
            canceled,
            Err(ExportCommandError {
                code: ExportErrorCode::Canceled,
                ..
            })
        ));
    }

    #[test]
    fn the_slice_check_skips_the_slice_from_the_first_frame_of_the_file() {
        // A recording that starts in the middle of a GOP has no picture in its first frame,
        // and the head holds the configurations of the start of the file. The check runs no
        // process for that slice, so even a missing ffprobe passes.
        let directory = TestDirectory::new();
        let input = FlvInput {
            head_name: crate::ffmpeg::export::flv_input::head_name(0),
            source_size: 1_000,
            segment_offsets: vec![13, 13],
            first_frame_offset: 13,
        };
        let probe = sample_probe_with_audio();
        assert!(check_slices(
            &directory.path.join("no-ffprobe"),
            &input,
            &directory.path,
            Path::new("/media/live.flv"),
            &probe,
            true,
            &AtomicBool::new(false),
        )
        .is_ok());
        let later = FlvInput {
            segment_offsets: vec![13, 500],
            ..input
        };
        assert!(matches!(
            check_slices(
                &directory.path.join("no-ffprobe"),
                &later,
                &directory.path,
                Path::new("/media/live.flv"),
                &probe,
                true,
                &AtomicBool::new(false),
            ),
            Err(SliceCheck::Refused(_))
        ));
    }

    #[test]
    fn the_audio_of_a_slice_matches_when_its_samples_fill_its_timestamps() {
        let audio = sample_probe_with_audio()
            .audio
            .expect("the fixture probe has audio");
        let frames = |times: &[&str], channels: u32| -> Vec<ffmpeg::DecodedAudioFrame> {
            times
                .iter()
                .map(|time| ffmpeg::DecodedAudioFrame {
                    pts: Rational::from_decimal_str(time),
                    nb_samples: 1024,
                    channels: Some(channels),
                })
                .collect()
        };
        // AAC at 48000 Hz: 1024 samples, 21.333 ms, written as whole milliseconds.
        let at_48k = [
            "2.008", "2.029", "2.051", "2.072", "2.093", "2.115", "2.136", "2.157",
        ];
        assert!(audio_matches(&frames(&at_48k, 2), &audio));
        assert!(!audio_matches(&frames(&at_48k, 1), &audio));
        assert!(!audio_matches(&frames(&at_48k[..1], 2), &audio));
        assert!(!audio_matches(&frames(&at_48k[..4], 2), &audio));
        // A gap of 100 ms, which the export fills, and 2 ms of jitter still match.
        let with_gap = [
            "2.008", "2.029", "2.051", "2.072", "2.193", "2.214", "2.238", "2.257",
        ];
        assert!(audio_matches(&frames(&with_gap, 2), &audio));
        // The timestamps of 44100 Hz audio, decoded with the rate of a 48000 Hz head.
        let at_44k = [
            "2.008", "2.031", "2.054", "2.078", "2.101", "2.124", "2.147", "2.171",
        ];
        assert!(!audio_matches(&frames(&at_44k, 2), &audio));
        // Timestamps that go back, and a frame with no time.
        let back = [
            "2.008", "2.029", "2.051", "2.040", "2.093", "2.115", "2.136", "2.157",
        ];
        assert!(!audio_matches(&frames(&back, 2), &audio));
        let mut untimed = frames(&at_48k, 2);
        untimed[3].pts = None;
        assert!(!audio_matches(&untimed, &audio));
    }

    #[test]
    fn the_watcher_of_the_locate_stops_also_when_the_locate_panics() {
        let done = AtomicBool::new(false);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _done = SetOnDrop(&done);
            panic!("the locate failed");
        }));
        assert!(result.is_err());
        assert!(done.load(Ordering::SeqCst));
    }

    #[test]
    fn export_command_error_omits_absent_optional_fields_entirely_not_as_null() {
        let error = ExportCommandError::new(ExportErrorCode::ExportQueueClosed);

        let value = serde_json::to_value(&error).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(value["code"], "exportQueueClosed");
        assert!(!object.contains_key("detail"));
        assert!(!object.contains_key("exitCode"));
        assert!(!object.contains_key("encoder"));

        // `exitCode` is the field that pins `rename_all` on this struct. `code`, `detail` and
        // `encoder` spell the same in both conventions, so none of them can notice the
        // attribute being dropped; a rejection that sets an exit code, which the
        // `ffprobeProcessFailed` path really does, would then ship `exit_code` and the
        // frontend's `normalizeExportError` would read `exitCode` and drop it.
        let full = serde_json::to_value(ExportCommandError {
            code: ExportErrorCode::FfprobeProcessFailed,
            detail: Some("decoder rejected input".to_owned()),
            exit_code: Some(7),
            encoder: Some("libx264".to_owned()),
            measured_duration_us: None,
            expected_duration_us: None,
        })
        .unwrap();

        assert_eq!(full["code"], "ffprobeProcessFailed");
        assert_eq!(full["detail"], "decoder rejected input");
        assert_eq!(full["exitCode"], 7);
        assert_eq!(full["encoder"], "libx264");
        assert!(full.get("exit_code").is_none());
    }

    #[test]
    fn started_event_serializes_with_the_event_tag_and_camel_case_fields() {
        let event = ExportEvent::Started {
            run_id: "1-0".to_owned(),
            output_path: "/movies/out.mp4".to_owned(),
            segment_count: 2,
            total_duration_us: 3_000_000,
            expected_frames: Some(90),
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["event"], "started");
        assert_eq!(value["runId"], "1-0");
        assert_eq!(value["outputPath"], "/movies/out.mp4");
        assert_eq!(value["segmentCount"], 2);
        assert_eq!(value["totalDurationUs"], 3_000_000);
        assert_eq!(value["expectedFrames"], 90);
        assert!(value.get("run_id").is_none());
        assert!(value.get("total_duration_us").is_none());
    }

    #[test]
    fn progress_event_serializes_the_two_rationals_as_numerator_and_denominator() {
        let event = progress_event("1-0", &sample_snapshot(Some(120)), Some(300)).unwrap();

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["event"], "progress");
        assert_eq!(value["runId"], "1-0");
        assert_eq!(value["frame"], 120);
        assert_eq!(value["expectedFrames"], 300);
        assert_eq!(value["fps"], serde_json::json!({ "n": 30, "d": 1 }));
        assert_eq!(value["speed"], serde_json::json!({ "n": 2, "d": 1 }));
        assert_eq!(value["totalSize"], 4096);
        // ADR 014 measurement 12: there is deliberately no out-time field of any spelling.
        assert!(value.get("outTimeUs").is_none());
        assert!(value.get("total_size").is_none());
    }

    #[test]
    fn publishing_and_finished_events_carry_the_run_id() {
        let publishing = serde_json::to_value(ExportEvent::Publishing {
            run_id: "1-0".to_owned(),
        })
        .unwrap();
        let finished = serde_json::to_value(ExportEvent::Finished {
            run_id: "1-0".to_owned(),
            output_path: "/movies/out.mp4".to_owned(),
            frames: 300,
        })
        .unwrap();

        assert_eq!(publishing["event"], "publishing");
        assert_eq!(publishing["runId"], "1-0");
        assert_eq!(finished["event"], "finished");
        assert_eq!(finished["runId"], "1-0");
        assert_eq!(finished["outputPath"], "/movies/out.mp4");
        assert_eq!(finished["frames"], 300);
    }

    #[test]
    fn failed_event_carries_the_code_and_its_optional_diagnostics() {
        let bare = serde_json::to_value(ExportEvent::Failed {
            run_id: "1-0".to_owned(),
            code: ExportErrorCode::Canceled,
            detail: None,
            exit_code: None,
            encoder: None,
            measured_duration_us: None,
            expected_duration_us: None,
        })
        .unwrap();
        let detailed = serde_json::to_value(ExportEvent::Failed {
            run_id: "1-0".to_owned(),
            code: ExportErrorCode::FfmpegProcessFailed,
            detail: Some("stderr tail".to_owned()),
            exit_code: Some(1),
            encoder: None,
            measured_duration_us: None,
            expected_duration_us: None,
        })
        .unwrap();

        assert_eq!(bare["event"], "failed");
        assert_eq!(bare["code"], "canceled");
        assert!(!bare.as_object().unwrap().contains_key("detail"));
        assert!(!bare.as_object().unwrap().contains_key("exitCode"));
        assert_eq!(detailed["detail"], "stderr tail");
        assert_eq!(detailed["exitCode"], 1);
        assert!(!detailed.as_object().unwrap().contains_key("encoder"));
    }

    #[test]
    fn a_segment_boundary_crosses_as_a_decimal_string_not_a_number() {
        let request: ExportRequestWire = serde_json::from_value(serde_json::json!({
            "sources": [{ "id": "a", "path": "/media/source.mp4" }],
            "pieces": [
                { "sourceId": "a", "inPts": "9007199254740993", "outPts": "9007199254740994" },
            ],
            "segmentCount": 1,
            "outputPath": "/movies/out.mp4",
            "preset": sample_preset("active"),
            "streams": "videoAndAudio",
            "audioMode": "encode",
        }))
        .unwrap();

        assert_eq!(request.preset, sample_preset("active"));
        assert_eq!(request.streams, ExportStreams::VideoAndAudio);
        // The value below is above `Number.MAX_SAFE_INTEGER`, which is exactly why ADR 002
        // puts a `Pts` on the wire as a string: as a JSON number it would already have been
        // rounded before it reached this parser.
        assert_eq!(request.pieces[0].in_pts, Pts::new(9_007_199_254_740_993));
        assert_eq!(request.pieces[0].out_pts, Pts::new(9_007_199_254_740_994));
        assert_eq!(request.pieces[0].source_id, "a");
        assert_eq!(request.segment_count, 1);
    }

    /// A request payload in its wire form, with `streams` set to `streams` or left out, and the
    /// audio encoded.
    fn request_json(streams: Option<serde_json::Value>) -> serde_json::Value {
        let mut value = serde_json::json!({
            "sources": [{ "id": "a", "path": "/media/source.mp4" }],
            "pieces": [{ "sourceId": "a", "inPts": "0", "outPts": "90000" }],
            "segmentCount": 1,
            "outputPath": "/movies/out.mp4",
            "preset": sample_preset("active"),
            "audioMode": "encode",
        });
        if let Some(streams) = streams {
            value["streams"] = streams;
        }
        value
    }

    /// A request payload in its wire form that writes video and audio, with `audioMode` set to
    /// `audio_mode` or left out.
    fn request_json_with_audio_mode(audio_mode: Option<serde_json::Value>) -> serde_json::Value {
        let mut value = request_json(Some(serde_json::json!("videoAndAudio")));
        let object = value.as_object_mut().unwrap();
        object.remove("audioMode");
        if let Some(audio_mode) = audio_mode {
            object.insert("audioMode".to_owned(), audio_mode);
        }
        value
    }

    #[test]
    fn the_request_carries_each_audio_mode_by_its_wire_string() {
        for (wire, audio_mode) in [
            ("encode", ExportAudioMode::Encode),
            ("copy", ExportAudioMode::Copy),
        ] {
            let request: ExportRequestWire =
                serde_json::from_value(request_json_with_audio_mode(Some(serde_json::json!(wire))))
                    .unwrap();
            assert_eq!(request.audio_mode, audio_mode, "{wire}");
        }
    }

    #[test]
    fn a_request_without_an_audio_mode_or_with_an_unknown_one_is_refused() {
        // As for `streams`, no value stands in for the choice of the user (ADR 048).
        let error = serde_json::from_value::<ExportRequestWire>(request_json_with_audio_mode(None))
            .unwrap_err();
        assert!(error.to_string().contains("audioMode"), "{error}");
        for refused in [
            serde_json::json!("Copy"),
            serde_json::json!("passthrough"),
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(true),
        ] {
            assert!(
                serde_json::from_value::<ExportRequestWire>(request_json_with_audio_mode(Some(
                    refused.clone()
                )))
                .is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn the_request_carries_each_stream_choice_by_its_wire_string() {
        for (wire, streams) in [
            ("videoAndAudio", ExportStreams::VideoAndAudio),
            ("videoOnly", ExportStreams::VideoOnly),
            ("audioOnly", ExportStreams::AudioOnly),
        ] {
            let request: ExportRequestWire =
                serde_json::from_value(request_json(Some(serde_json::json!(wire)))).unwrap();
            assert_eq!(request.streams, streams, "{wire}");
        }
    }

    #[test]
    fn a_request_carries_its_whole_preset() {
        let mut preset = sample_preset("custom");
        preset.video_encoder = "libx265".to_owned();
        let mut value = request_json(Some(serde_json::json!("videoAndAudio")));
        value["preset"] = serde_json::to_value(&preset).unwrap();

        let request: ExportRequestWire = serde_json::from_value(value).unwrap();

        assert_eq!(request.preset, preset);
    }

    #[test]
    fn a_request_without_a_preset_or_with_a_preset_id_is_refused() {
        // The run renders with the preset of the request and with nothing else (ADR 049). A
        // frontend that sent no preset, or only the id of the earlier contract, is refused at
        // the boundary rather than given some other preset.
        let mut without = request_json(Some(serde_json::json!("videoAndAudio")));
        without.as_object_mut().unwrap().remove("preset");
        let error = serde_json::from_value::<ExportRequestWire>(without).unwrap_err();
        assert!(error.to_string().contains("preset"), "{error}");

        let mut by_id = request_json(Some(serde_json::json!("videoAndAudio")));
        by_id["presetId"] = serde_json::json!("active");
        let error = serde_json::from_value::<ExportRequestWire>(by_id).unwrap_err();
        assert!(error.to_string().contains("presetId"), "{error}");
    }

    #[test]
    fn a_valid_preset_passes_the_check_of_the_request() {
        assert_eq!(validate_request_preset(&sample_preset("active")), Ok(()));
    }

    #[test]
    fn an_invalid_preset_reports_invalid_preset_with_the_reason() {
        let mut unnamed = sample_preset("active");
        unnamed.name = "   ".to_owned();
        // An encoder name that would reach ffmpeg as a flag. The command line is built from
        // the preset of the request, so this check is what keeps a flag out of it.
        let mut flag = sample_preset("active");
        flag.video_encoder = "-f".to_owned();

        for preset in [unnamed, flag] {
            let error = validate_request_preset(&preset).unwrap_err();

            assert_eq!(error.code, ExportErrorCode::InvalidPreset);
            let expected = settings::validate_preset(&preset).unwrap_err().to_string();
            assert_eq!(error.detail.as_deref(), Some(expected.as_str()));
        }
    }

    #[test]
    fn a_request_carries_an_optional_expected_source_revision() {
        let without: ExportRequestWire =
            serde_json::from_value(request_json(Some(serde_json::json!("videoAndAudio")))).unwrap();
        assert_eq!(without.sources[0].expected_revision, None);

        let mut value = request_json(Some(serde_json::json!("videoAndAudio")));
        value["sources"][0]["expectedRevision"] = serde_json::json!(null);
        let null: ExportRequestWire = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(null.sources[0].expected_revision, None);

        value["sources"][0]["expectedRevision"] =
            serde_json::json!({ "size": 4096, "mtime": 1_700_000_000 });
        let with: ExportRequestWire = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            with.sources[0].expected_revision,
            Some(ExpectedSourceRevisionWire {
                size: 4096,
                mtime: 1_700_000_000
            })
        );

        // The path is the path of the source, so a revision that names one is refused.
        value["sources"][0]["expectedRevision"]["path"] = serde_json::json!("/media/other.mp4");
        assert!(serde_json::from_value::<ExportRequestWire>(value).is_err());
    }

    #[test]
    fn a_request_of_the_old_wire_is_refused() {
        // The wire of one source is gone (ADR 053). A frontend that still sent it is refused at
        // the boundary, not read as a request of no pieces.
        let old = serde_json::json!({
            "sourcePath": "/media/source.mp4",
            "outputPath": "/movies/out.mp4",
            "segments": [{ "inPts": "0", "outPts": "90000" }],
            "preset": sample_preset("active"),
            "streams": "videoAndAudio",
            "audioMode": "encode",
        });
        assert!(serde_json::from_value::<ExportRequestWire>(old).is_err());
        let mut missing_count = request_json(Some(serde_json::json!("videoAndAudio")));
        missing_count
            .as_object_mut()
            .unwrap()
            .remove("segmentCount");
        let error = serde_json::from_value::<ExportRequestWire>(missing_count).unwrap_err();
        assert!(error.to_string().contains("segmentCount"), "{error}");
    }

    #[test]
    fn a_request_carries_an_optional_new_batch_flag() {
        let without: ExportRequestWire =
            serde_json::from_value(request_json(Some(serde_json::json!("videoAndAudio")))).unwrap();
        assert!(!without.new_batch);

        let mut value = request_json(Some(serde_json::json!("videoAndAudio")));
        value["newBatch"] = serde_json::json!(true);
        let with: ExportRequestWire = serde_json::from_value(value.clone()).unwrap();
        assert!(with.new_batch);

        value["newBatch"] = serde_json::json!("yes");
        assert!(serde_json::from_value::<ExportRequestWire>(value).is_err());
    }

    /// A request for `source` that expects `expected` as the revision of the source.
    fn request_expecting(
        source: &Path,
        expected: Option<ExpectedSourceRevisionWire>,
    ) -> ExportRequestWire {
        ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: expected,
            }],
            pieces: vec![piece("source", 0, 90_000)],
            segment_count: 1,
            output_path: source
                .with_file_name("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        }
    }

    /// A piece of the source `source_id` from `in_pts` to `out_pts`.
    fn piece(source_id: &str, in_pts: i64, out_pts: i64) -> ExportPieceWire {
        ExportPieceWire {
            source_id: source_id.to_owned(),
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
        }
    }

    /// The revision of `path` as the import reports it.
    fn revision_of(path: &Path) -> ExpectedSourceRevisionWire {
        let media = crate::commands::media::validate_media(&path.to_string_lossy()).unwrap();
        ExpectedSourceRevisionWire {
            size: media.size,
            mtime: media.mtime,
        }
    }

    #[test]
    fn the_source_revision_check_accepts_the_same_file_and_refuses_a_changed_one() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let marked = revision_of(&source);

        assert_eq!(
            check_source_revision(&request_expecting(&source, None).sources[0]),
            Ok(())
        );
        assert_eq!(
            check_source_revision(&request_expecting(&source, Some(marked)).sources[0]),
            Ok(())
        );

        // Another file of another size at the same path.
        fs::write(&source, b"replaced media").unwrap();
        let error = check_source_revision(&request_expecting(&source, Some(marked)).sources[0])
            .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::SourceRevisionMismatch);
        // The detail names the source of the request (ADR 053).
        assert_eq!(error.detail.as_deref(), Some("source"));

        // The same size, written at another time.
        fs::write(&source, b"MEDIA").unwrap();
        let earlier = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000);
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let error = check_source_revision(&request_expecting(&source, Some(marked)).sources[0])
            .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::SourceRevisionMismatch);
    }

    #[test]
    fn a_source_that_cannot_be_read_is_not_a_revision_mismatch() {
        // The re-probe and the plan report a file that is gone with codes of their own.
        let directory = TestDirectory::new();
        let gone = directory.path.join("gone.mp4");
        let expected = ExpectedSourceRevisionWire {
            size: 5,
            mtime: 1_700_000_000,
        };

        assert_eq!(
            check_source_revision(&request_expecting(&gone, Some(expected)).sources[0]),
            Ok(())
        );
    }

    #[test]
    fn preparation_with_a_matching_revision_reaches_the_re_probe() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = request_expecting(&source, Some(revision_of(&source)));
        let probed = RefCell::new(false);

        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| {
                *probed.borrow_mut() = true;
                Ok(sample_probe())
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        );

        assert!(*probed.borrow());
        assert!(prepared.is_ok(), "{:?}", prepared.err());
    }

    #[test]
    fn preparation_stops_at_a_changed_source_before_the_re_probe() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let marked = revision_of(&source);
        fs::write(&source, b"replaced media").unwrap();
        let request = request_expecting(&source, Some(marked));
        let probed = RefCell::new(false);

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| {
                *probed.borrow_mut() = true;
                unreachable!()
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::SourceRevisionMismatch);
        assert!(!*probed.borrow());
        // Nothing was reserved in the folder of the output.
        let leftovers = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_request_without_streams_is_refused_rather_than_defaulted() {
        // No value may stand in for the user's choice. A frontend that forgot to send it is
        // refused at the boundary, before any preparation starts.
        let error = serde_json::from_value::<ExportRequestWire>(request_json(None)).unwrap_err();
        assert!(error.to_string().contains("streams"), "{error}");
    }

    #[test]
    fn a_request_with_an_unknown_or_malformed_stream_choice_is_refused() {
        for refused in [
            serde_json::json!("audio"),
            serde_json::json!("VideoOnly"),
            serde_json::json!("video_only"),
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(1),
            serde_json::json!({ "video": true }),
        ] {
            assert!(
                serde_json::from_value::<ExportRequestWire>(request_json(Some(refused.clone())))
                    .is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn a_duration_mismatch_carries_both_durations_as_named_values_and_nothing_else_does() {
        let mismatch = ExportCommandError {
            measured_duration_us: Some(9_500_000),
            expected_duration_us: Some(10_000_000),
            ..ExportCommandError::new(ExportErrorCode::AudioDurationMismatch)
        };

        let rejection = serde_json::to_value(&mismatch).unwrap();
        assert_eq!(rejection["code"], "audioDurationMismatch");
        assert_eq!(rejection["measuredDurationUs"], 9_500_000);
        assert_eq!(rejection["expectedDurationUs"], 10_000_000);

        let event = serde_json::to_value(failed_event("1-0", mismatch)).unwrap();
        assert_eq!(event["event"], "failed");
        assert_eq!(event["code"], "audioDurationMismatch");
        assert_eq!(event["measuredDurationUs"], 9_500_000);
        assert_eq!(event["expectedDurationUs"], 10_000_000);
        assert!(event.get("measured_duration_us").is_none());

        // Every other failure omits both keys, rather than sending them as `null`.
        let bare = serde_json::to_value(failed_event(
            "1-0",
            ExportCommandError::new(ExportErrorCode::FrameCountMismatch),
        ))
        .unwrap();
        let object = bare.as_object().unwrap();
        assert!(!object.contains_key("measuredDurationUs"));
        assert!(!object.contains_key("expectedDurationUs"));
    }

    #[test]
    fn duration_microseconds_converts_exactly_and_rounds_a_partial_microsecond() {
        // A whole number of microseconds is carried across unchanged.
        assert_eq!(
            duration_microseconds(Rational::new(3, 2).unwrap()),
            1_500_000
        );
        assert_eq!(duration_microseconds(Rational::new(0, 1).unwrap()), 0);
        // 1/3 of a second is 333333.33... microseconds: not a whole microsecond, and not
        // representable in binary floating point either. It rounds down.
        assert_eq!(duration_microseconds(Rational::new(1, 3).unwrap()), 333_333);
        // 2/3 of a second rounds up, which is the half-away-from-zero rule and not truncation.
        assert_eq!(duration_microseconds(Rational::new(2, 3).unwrap()), 666_667);
        // Exactly half a microsecond rounds away from zero rather than to even.
        assert_eq!(
            duration_microseconds(Rational::new(1, 2_000_000).unwrap()),
            1
        );
    }

    #[test]
    fn a_snapshot_with_no_frame_produces_no_event_at_all() {
        // `frame` is required on the wire, so an event without it is rejected wholesale by
        // the frontend validator. Dropping the snapshot costs one progress update; emitting
        // it costs the same update and adds a validation failure.
        assert!(progress_event("1-0", &sample_snapshot(None), Some(300)).is_none());
    }

    #[test]
    fn a_zero_encoding_rate_is_dropped_rather_than_shipped_as_a_rejected_event() {
        let snapshot = ProgressSnapshot {
            frame: Some(0),
            fps: Rational::new(0, 1),
            speed: Rational::new(0, 1),
            total_size: None,
            done: false,
        };

        let event = progress_event("1-0", &snapshot, Some(300)).unwrap();
        let value = serde_json::to_value(&event).unwrap();
        let object = value.as_object().unwrap();

        // The frontend accepts only a strictly positive `fps`, and ffmpeg writes `fps=0.00`
        // in the first blocks of a run, so the field is omitted rather than allowed to make
        // the whole event invalid. A zero `speed` is valid, so it stays.
        assert_eq!(value["frame"], 0);
        assert!(!object.contains_key("fps"));
        assert_eq!(value["speed"], serde_json::json!({ "n": 0, "d": 1 }));
        assert!(!object.contains_key("totalSize"));
    }

    #[test]
    fn a_short_final_frame_count_reports_a_mismatch_with_the_ffmpeg_diagnostic() {
        let error = verified_frame_count(
            Some(300),
            Some(&sample_snapshot(Some(299))),
            Some("File exists".to_owned()),
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::FrameCountMismatch);
        assert_eq!(error.detail.as_deref(), Some("File exists"));
        assert_eq!(error.exit_code, None);
    }

    #[test]
    fn an_equal_or_larger_final_frame_count_succeeds() {
        assert_eq!(
            verified_frame_count(Some(300), Some(&sample_snapshot(Some(300))), None).unwrap(),
            300
        );
        assert_eq!(
            verified_frame_count(Some(300), Some(&sample_snapshot(Some(301))), None).unwrap(),
            301
        );
    }

    #[test]
    fn an_absent_expectation_has_nothing_to_compare_and_the_export_proceeds() {
        assert_eq!(
            verified_frame_count(None, Some(&sample_snapshot(Some(7))), None).unwrap(),
            7
        );
    }

    #[test]
    fn an_exit_with_no_progress_at_all_is_a_mismatch_whatever_was_expected() {
        // This is the measured missing-`-y` case: ffmpeg refuses the reserved file, writes no
        // progress block, and exits zero. The exit status alone would call it a success.
        //
        // No expectation does not excuse no progress. `expected_frames` of `None` means the
        // count could not be predicted -- ADR 014's variable-frame-rate mode -- and
        // `Some(0)` is reachable from a preset frame rate low enough to round a short mark
        // below half an output frame. Comparing a count of zero against either one passes, so
        // the absent snapshot has to be caught before the comparison, or ffmpeg's zero-exit
        // refusal publishes an empty reservation over the user's file.
        for expected in [None, Some(0), Some(1)] {
            let error =
                verified_frame_count(expected, None, Some("File exists".to_owned())).unwrap_err();

            assert_eq!(error.code, ExportErrorCode::FrameCountMismatch);
            assert_eq!(error.detail.as_deref(), Some("File exists"));
        }

        // A snapshot that exists is compared instead of rejected: the child was reporting.
        assert_eq!(
            verified_frame_count(Some(0), Some(&sample_snapshot(Some(0))), None).unwrap(),
            0
        );
    }

    #[test]
    fn preparation_builds_the_command_against_the_reservation_and_not_the_destination() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: destination.to_string_lossy().into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, path, _| {
                assert_eq!(path, source);
                Ok(sample_probe())
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap();

        assert_eq!(prepared.preset_id, "active");
        assert_eq!(prepared.plan.destination, destination);
        assert_eq!(prepared.ffmpeg, directory.path.join("ffmpeg"));
        // ffmpeg writes the reservation. The destination must appear nowhere in the argument
        // list: the rename that publishes it happens after this process has exited.
        let reserved = path_to_string(prepared.pending.path());
        assert!(prepared.arguments.contains(&reserved));
        assert!(!prepared
            .arguments
            .iter()
            .any(|argument| *argument == path_to_string(&destination)));
        // ADR 014 makes both of these mandatory: without `-y` ffmpeg refuses the reserved
        // file and exits zero, and without `-f` it cannot select a muxer for a name with no
        // usable extension.
        assert!(prepared.arguments.iter().any(|argument| argument == "-y"));
        assert!(prepared.arguments.iter().any(|argument| argument == "-f"));
    }

    #[test]
    fn a_preset_gain_reaches_the_audio_process_and_leaves_the_encoder_as_it_was() {
        // ADR 054 through the preparation. A preset of v0.1.1 has no gain key and prepares no
        // `volume` anywhere. The same preset with -1.0 dB changes only the graph of the audio
        // process (ADR 043): one `volume` behind its `concat`.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        fs::write(
            directory.path.join(settings::SETTINGS_FILE_NAME),
            settings::VERSION_2_FIXTURE,
        )
        .unwrap();
        let loaded = settings::load(&directory.path)
            .unwrap()
            .settings
            .presets
            .into_iter()
            .find(|preset| preset.id == "default-h264-mp4")
            .unwrap();
        assert_eq!(loaded.audio_gain_tenths_db, 0);
        let prepare = |preset: settings::Preset| {
            let request = ExportRequestWire {
                sources: vec![ExportSourceWire {
                    id: "source".to_owned(),
                    path: source.to_string_lossy().into_owned(),
                    expected_revision: None,
                }],
                pieces: vec![ExportPieceWire {
                    source_id: "source".to_owned(),
                    in_pts: Pts::new(0),
                    out_pts: Pts::new(90_000),
                }],
                segment_count: 1,
                output_path: destination.to_string_lossy().into_owned(),
                preset,
                streams: ExportStreams::VideoAndAudio,
                audio_mode: ExportAudioMode::Encode,
                new_batch: false,
            };
            let prepared = prepare_export_with(
                PrepareRequest {
                    request: &request,
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
                |_, _, _| Ok(sample_probe_with_audio()),
                first_packet_unread,
                sample_rate_not_read,
                no_audio_gaps,
            )
            .unwrap();
            // The encoder command without the reservation, whose name counts up, and the graph of
            // the audio process.
            let mut arguments = prepared.arguments.clone();
            arguments.pop();
            (arguments, audio_graph_of(&prepared))
        };

        let (plain_encoder, plain_audio) = prepare(loaded.clone());
        assert!(!plain_encoder
            .iter()
            .any(|argument| argument.contains("volume")));
        assert!(
            plain_audio.ends_with("concat=n=1:v=1:a=1[pv][a]"),
            "{plain_audio}"
        );

        let (gained_encoder, gained_audio) = prepare(settings::Preset {
            audio_gain_tenths_db: -10,
            ..loaded
        });
        assert_eq!(gained_encoder, plain_encoder);
        assert_eq!(
            gained_audio,
            plain_audio.replace(
                "concat=n=1:v=1:a=1[pv][a]",
                "concat=n=1:v=1:a=1[pv][ac];[ac]volume=-1.0dB[a]"
            )
        );
    }

    #[test]
    fn a_version_1_settings_file_prepares_the_command_of_version_1_and_saving_it_keeps_the_command()
    {
        // A user upgrades from the first release, and the settings file is still at schema
        // version 1. Each preset reads with the defaults of the keys versions 2 and 3 added: the
        // graph is the graph of version 1, byte for byte, and the arguments add `-pix_fmt yuv420p`
        // only, which names the format the graph already ends in. After a save writes the current
        // version, the same export prepares the same command.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        let settings_path = directory.path.join(settings::SETTINGS_FILE_NAME);
        fs::write(&settings_path, settings::VERSION_1_FIXTURE).unwrap();
        // The frontend sends the preset as it loaded it from this file, so each preparation
        // below takes the preset from the file as it is at that time.
        let request = || ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: destination.to_string_lossy().into_owned(),
            preset: settings::load(&directory.path)
                .unwrap()
                .settings
                .presets
                .into_iter()
                .find(|preset| preset.id == "default-h264-mp4")
                .unwrap(),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let prepare = || {
            let request = request();
            prepare_export_with(
                PrepareRequest {
                    request: &request,
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
                |_, _, _| Ok(sample_probe_with_audio()),
                first_packet_unread,
                sample_rate_not_read,
                no_audio_gaps,
            )
            .unwrap()
        };
        // The command without its last argument, the reservation, whose name counts up, and the
        // graph that preparation wrote into the work directory (ADR 055).
        let command = |prepared: &PreparedExport| -> (Vec<String>, String) {
            let mut arguments = prepared.arguments.clone();
            assert_eq!(
                arguments.pop().as_deref(),
                Some(path_to_string(prepared.pending.path()).as_str())
            );
            (arguments, graph_of(prepared))
        };

        let (from_version_1, graph_of_version_1) = command(&prepare());
        assert_eq!(
            graph_of_version_1,
            concat!(
                "sws_flags=lanczos+accurate_rnd+full_chroma_int;[vc]format=yuv420p[v];",
                "[0:0]trim=start_pts=0:end_pts=90000,setpts=PTS-STARTPTS,fps=30/1[v0];",
                "anullsrc=r=48000:cl=mono,atrim=end_sample=48000,aformat=f=fltp:r=48000[pa0];",
                "[v0][pa0]concat=n=1:v=1:a=1[vc][pa];[pa]anullsink",
            )
        );
        let source_argument = path_to_string(&source);
        assert_eq!(
            from_version_1,
            vec![
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
                "-y",
                "-copyts",
                "-i",
                source_argument.as_str(),
                "-f",
                "wav",
                "-i",
                "pipe:0",
                "-/filter_complex",
                "encoder.graph",
                "-map",
                "[v]",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "20",
                "-c:a",
                "aac",
                "-b:a",
                "320k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
            ]
        );
        // Loading the file to read its preset wrote nothing to it.
        assert_eq!(
            fs::read_to_string(&settings_path).unwrap(),
            settings::VERSION_1_FIXTURE
        );

        let upgraded = settings::save(
            &directory.path,
            &settings::load(&directory.path).unwrap().settings,
        )
        .unwrap();
        assert_eq!(upgraded.schema_version, 3);
        assert_eq!(command(&prepare()), (from_version_1, graph_of_version_1));
    }

    #[test]
    fn preparation_plans_before_it_reserves_anything() {
        // This is obligation 1, and the destination below is the one that can hold it: its
        // parent directory does not exist, and the two orders answer that differently.
        // `build_plan` reports `outputDirectoryMissing`; a reservation attempted first would
        // fail in the parent it cannot create and be reported as `outputNotWritable`.
        //
        // The directory destination of the test below cannot make this distinction, which is
        // why it is not the guard here: reserving against a directory *succeeds*, creating a
        // temporary file in the parent, `build_plan` then rejects it, the `?` drops the
        // `PendingOutput`, and its guard removes the file. Swap the two steps and the code
        // still reports `outputPathInvalid` and still leaves nothing behind.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("missing").join("out.mp4");
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: destination.to_string_lossy().into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| Ok(sample_probe()),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::OutputDirectoryMissing);
    }

    #[test]
    fn preparation_rejects_a_destination_that_is_a_directory_in_preflight() {
        // A directory reserves successfully and fails only at the rename, after a whole
        // encode, so `build_plan` rejecting it before ffmpeg starts is worth a test of its
        // own. It is not the test that holds the order -- see the one above for why.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("folder");
        fs::create_dir_all(&destination).unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: destination.to_string_lossy().into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| Ok(sample_probe()),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::OutputPathInvalid);
        // Nothing was reserved beside the folder, so no temporary file was left behind.
        let leftovers = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn preparation_rejects_a_read_only_destination_in_preflight() {
        // The whole path this check exists for, through the real `inspect_path` rather than a
        // fixed table: a destination the user protected must be refused before anything is
        // reserved and before ffmpeg is spawned. Without it, `fsutil::replace_file_within`
        // refuses the same file at the rename, and the user pays for the whole encode first --
        // see `a_rename_failure_with_no_operating_system_code_carries_no_detail`, which drives
        // that late refusal with this same destination.
        //
        // `set_readonly(true)` is what makes this run on both platforms: it clears every write bit
        // on Unix and sets the read-only attribute on Windows, and `Permissions::readonly` is what
        // both arms of `replace_file_within` read. Protecting the file takes one call on both
        // platforms; releasing it again does not, so the restore below is split by platform.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        fs::write(&destination, b"a previous export the user protected").unwrap();
        let mut permissions = fs::metadata(&destination).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&destination, permissions).unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: destination.to_string_lossy().into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let result = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| Ok(sample_probe()),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        );

        // Release the file before the assertions, so a failing assertion cannot leave a file that
        // defeats `TestDirectory`'s own cleanup on Windows, where `remove_dir_all` refuses a
        // read-only file. `set_readonly(false)` is the right call for that on Windows, where the
        // attribute is the whole of it, but not on Unix, where it would set every write bit and
        // leave the file world-writable; an explicit 0o644 restores an ordinary mode instead and
        // is all `remove_dir_all` needs. `fsutil::replace_file_within` splits its own permission
        // work the same way, and for the same reason.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&destination, fs::Permissions::from_mode(0o644)).unwrap();
        }
        #[cfg(windows)]
        {
            let mut permissions = fs::metadata(&destination).unwrap().permissions();
            // The lint warns that this makes a file world writable on Unix. This arm is
            // Windows-only, where clearing the attribute is the whole of it.
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(&destination, permissions).unwrap();
        }

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("a protected destination must be refused before the encode"),
        };
        assert_eq!(error.code, ExportErrorCode::OutputReadOnly);
        // The refusal happens before the reservation, so nothing was created beside the
        // destination and there is no temporary file for a guard to clean up.
        let leftovers = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"a previous export the user protected",
            "the protected destination must keep its contents"
        );
    }

    #[test]
    fn a_cancel_before_preparation_starts_ends_it_without_discovering_ffmpeg() {
        // The twin of the pre-re-probe test below, at the other end. `start_export` claims the
        // slot before it hands preparation to the export thread, so a cancel can already be set
        // when the first step runs. That step is `discover`, which walks `PATH` and inspects
        // each candidate; an entry on a share that stopped answering holds it. Reading the flag
        // only later would spend that time for an answer nobody wants.
        let directory = TestDirectory::new();
        let discovered = RefCell::new(false);
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: "/media/source.mp4".to_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(true),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &slash_graph_file,
            },
            |_| {
                *discovered.borrow_mut() = true;
                unreachable!()
            },
            |_, _, _| unreachable!(),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert!(!*discovered.borrow());
    }

    #[test]
    fn a_cancel_before_the_re_probe_ends_preparation_without_spawning_ffprobe() {
        // The run holds the export slot for the whole of preparation, and the re-probe alone
        // can spend `PROBE_TIMEOUT`. A cancel read only after preparation returned would spend
        // that time for an answer nobody wants, which is what holds an application quit past
        // its budget.
        //
        // The flag is set from inside `discover`, after the check at the top of preparation has
        // passed, so this test reaches the pre-re-probe check rather than that first one. A flag
        // that started out set would stop the run at that first check and leave this one
        // untested.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let cancel = AtomicBool::new(false);
        let probed = RefCell::new(false);
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &cancel,
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &slash_graph_file,
            },
            |_| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| {
                *probed.borrow_mut() = true;
                unreachable!()
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert!(!*probed.borrow());
    }

    #[test]
    fn a_cancel_during_the_re_probe_ends_preparation_with_nothing_reserved() {
        // The realistic timing: the flag is set while the re-probe runs, which is the step a
        // cancel is most likely to land in. Preparation must then stop before the reservation
        // rather than leave a temporary file on the user's disk for a run that never starts.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let cancel = AtomicBool::new(false);
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &cancel,
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
            |_, _, _| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(sample_probe())
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        let leftovers = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_re_probe_that_a_cancel_stopped_ends_preparation_as_canceled() {
        // The re-probe runs under the flag of the run, and stops when the flag is set. Its
        // `Canceled` is the cancel of the user, not a failure of ffprobe.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let cancel = AtomicBool::new(false);
        let request = request_expecting(&source, None);

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &cancel,
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
            |_, _, flag| {
                // The probe gets the flag of the run itself.
                assert!(std::ptr::eq(flag, &cancel));
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Err(ProbeError::Canceled)
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(error.detail, None);
    }

    #[test]
    fn a_missing_ffmpeg_pair_is_reported_before_the_source_is_probed() {
        let directory = TestDirectory::new();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: "/media/source.mp4".to_owned(),
                expected_revision: None,
            }],
            pieces: vec![piece("source", 0, 90_000)],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &slash_graph_file,
            },
            |_| Err(LocateError::NotFound { inspected: vec![] }),
            |_, _, _| unreachable!(),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::FfmpegPairMissing);
        assert_eq!(error.detail, None);
    }

    #[test]
    fn a_re_probe_failure_keeps_the_stable_code_and_the_raw_diagnostic() {
        let error = map_reprobe_error(ProbeError::ProcessFailed {
            code: Some(7),
            stderr: b"decoder rejected input".to_vec(),
        });
        let spawn = map_reprobe_error(ProbeError::Spawn {
            source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"),
        });

        assert_eq!(error.code, ExportErrorCode::FfprobeProcessFailed);
        assert_eq!(error.exit_code, Some(7));
        assert_eq!(error.detail.as_deref(), Some("decoder rejected input"));
        assert_eq!(spawn.code, ExportErrorCode::FfprobeSpawnFailed);
        assert_eq!(spawn.detail.as_deref(), Some("denied"));
    }

    #[test]
    fn a_re_probe_that_times_out_reports_its_own_code_and_not_a_spawn_failure() {
        // The re-probe runs with the export slot already claimed, so a stall that was
        // reported as any other code -- or not reported at all -- would leave the slot held
        // for the life of the process and refuse every later export.
        let error = map_reprobe_error(ProbeError::TimedOut {
            timeout: Duration::from_secs(30),
            stderr: b"could not read the source".to_vec(),
        });

        assert_eq!(error.code, ExportErrorCode::FfprobeTimedOut);
        assert_eq!(error.detail.as_deref(), Some("could not read the source"));
        assert_eq!(error.exit_code, None);
    }

    #[test]
    fn the_start_payload_reports_the_plan_and_not_the_request() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.mp4");
        let plan = sample_plan(&destination);
        let pending = PendingOutput::reserve(&destination).unwrap();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::VideoAndAudio,
            segment_count: 1,
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: None,
            pending,
            work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                .unwrap(),
        };

        let start = start_payload("42-7", &prepared);

        assert_eq!(start.run_id, "42-7");
        assert_eq!(start.preset_id, "active");
        assert_eq!(start.output_path, path_to_string(&destination));
        assert_eq!(start.segment_count, 1);
        assert_eq!(start.total_duration_us, 1_000_000);
        assert_eq!(start.expected_frames, Some(30));
    }

    #[test]
    fn a_cancel_that_lands_after_a_successful_exit_publishes_nothing() {
        // ADR 016's second cancel test, and obligation 5. The process stage below reports a
        // complete encode -- zero exit, the full expected frame count -- and cancels the run
        // from inside the call, which is the window the re-check exists for: the flag is set
        // after the last poll of the supervision loop and before the rename. Delete the
        // `slot.is_canceled()` re-check and this test fails on all three assertions.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.mp4");
        let plan = sample_plan(&destination);
        let pending = PendingOutput::reserve(&destination).unwrap();
        let reserved = pending.path().to_path_buf();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::VideoAndAudio,
            segment_count: 1,
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: None,
            pending,
            work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                .unwrap(),
        };
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, _on_progress| {
                assert!(registry.cancel("42-7"));
                Ok(ExportProcessOutcome {
                    status: ExportProcessStatus::Exited {
                        code: Some(0),
                        success: true,
                    },
                    stderr: Vec::new(),
                    last_progress: Some(sample_snapshot(Some(30))),
                })
            },
            |_, _, _| unreachable!("a plan with video is verified by its frame count"),
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        // The rename never ran, so the file the user chose was never written, and the
        // reservation was deleted by the guard the early return dropped.
        assert!(!destination.exists());
        assert!(!reserved.exists());
        // A `publishing` event would have told the frontend the rename was under way.
        assert!(!events
            .borrow()
            .iter()
            .any(|event| matches!(event, ExportEvent::Publishing { .. })));
    }

    // -- the stream choice: preparation ---------------------------------------------------

    /// The sample probe with a 48000 Hz stereo audio stream at index 1.
    fn sample_probe_with_audio() -> MediaProbe {
        MediaProbe {
            audio: Some(crate::ffmpeg::AudioProbe {
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
            }),
            ..sample_probe()
        }
    }

    /// Prepare an export of a real source file with the given stream choice and probe, against
    /// injected discovery and settings.
    fn prepare_streams(
        directory: &TestDirectory,
        streams: ExportStreams,
        probe: MediaProbe,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_reading_first_packet(
            directory,
            streams,
            probe,
            &[(0, 1)],
            &AtomicBool::new(false),
            first_packet_unread,
        )
    }

    /// [`prepare_streams`] over `segments`, in whole seconds of the sample probe's video, under
    /// `cancel`, with the read of the first audio packet injected and no read of the sample rate.
    fn prepare_reading_first_packet(
        directory: &TestDirectory,
        streams: ExportStreams,
        probe: MediaProbe,
        segments: &[(i64, i64)],
        cancel: &AtomicBool,
        first_audio_packet: impl FnMut(
            &Path,
            &Path,
            u32,
            &AtomicBool,
        ) -> Result<Option<FirstAudioPacket>, ProbeError>,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_reading_audio(
            directory,
            streams,
            probe,
            segments,
            cancel,
            first_audio_packet,
            sample_rate_not_read,
        )
    }

    /// [`prepare_reading_first_packet`] with the read of the sample rate injected too.
    fn prepare_reading_audio(
        directory: &TestDirectory,
        streams: ExportStreams,
        probe: MediaProbe,
        segments: &[(i64, i64)],
        cancel: &AtomicBool,
        first_audio_packet: impl FnMut(
            &Path,
            &Path,
            u32,
            &AtomicBool,
        ) -> Result<Option<FirstAudioPacket>, ProbeError>,
        audio_sample_rate_at: impl FnMut(
            &Path,
            &Path,
            u64,
            u32,
            &AtomicBool,
        ) -> Result<Option<u32>, ProbeError>,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_reading_audio_and_gaps(
            directory,
            streams,
            probe,
            segments,
            cancel,
            first_audio_packet,
            audio_sample_rate_at,
            no_audio_gaps,
        )
    }

    /// [`prepare_reading_first_packet`] with the read of the gaps inside the audio stream
    /// injected too.
    fn prepare_reading_gaps(
        directory: &TestDirectory,
        streams: ExportStreams,
        probe: MediaProbe,
        segments: &[(i64, i64)],
        cancel: &AtomicBool,
        first_audio_packet: impl FnMut(
            &Path,
            &Path,
            u32,
            &AtomicBool,
        ) -> Result<Option<FirstAudioPacket>, ProbeError>,
        audio_gaps: impl FnMut(
            &Path,
            &Path,
            &AudioGapRead<'_>,
            &AtomicBool,
        ) -> Result<AudioFrames, ProbeError>,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_reading_audio_and_gaps(
            directory,
            streams,
            probe,
            segments,
            cancel,
            first_audio_packet,
            sample_rate_not_read,
            audio_gaps,
        )
    }

    /// [`prepare_reading_audio`] with the read of the gaps injected too.
    fn prepare_reading_audio_and_gaps(
        directory: &TestDirectory,
        streams: ExportStreams,
        probe: MediaProbe,
        segments: &[(i64, i64)],
        cancel: &AtomicBool,
        first_audio_packet: impl FnMut(
            &Path,
            &Path,
            u32,
            &AtomicBool,
        ) -> Result<Option<FirstAudioPacket>, ProbeError>,
        audio_sample_rate_at: impl FnMut(
            &Path,
            &Path,
            u64,
            u32,
            &AtomicBool,
        ) -> Result<Option<u32>, ProbeError>,
        audio_gaps: impl FnMut(
            &Path,
            &Path,
            &AudioGapRead<'_>,
            &AtomicBool,
        ) -> Result<AudioFrames, ProbeError>,
    ) -> Result<PreparedExport, ExportCommandError> {
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: segments
                .iter()
                .map(|(in_seconds, out_seconds)| ExportPieceWire {
                    source_id: "source".to_owned(),
                    in_pts: Pts::new(in_seconds * 90_000),
                    out_pts: Pts::new(out_seconds * 90_000),
                })
                .collect(),
            segment_count: 1,
            output_path: directory
                .path
                .join("out.m4a")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel,
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
            {
                let mut probe = Some(probe);
                move |_, _, _| Ok(probe.take().expect("one source is probed once"))
            },
            first_audio_packet,
            audio_sample_rate_at,
            audio_gaps,
        )
    }

    /// The temporary files left in `directory`.
    fn leftover_reservations(directory: &TestDirectory) -> usize {
        fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count()
    }

    #[test]
    fn preparation_refuses_an_audio_only_export_of_a_source_without_audio() {
        let directory = TestDirectory::new();
        let error = match prepare_streams(&directory, ExportStreams::AudioOnly, sample_probe()) {
            Err(error) => error,
            Ok(_) => panic!("a source without audio has no audio to export"),
        };
        assert_eq!(error.code, ExportErrorCode::SourceHasNoAudio);
        // The planner refuses before the reservation, so nothing was written.
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn preparation_builds_an_audio_only_command_and_a_start_payload_without_a_frame_goal() {
        let directory = TestDirectory::new();
        let prepared = prepare_streams(
            &directory,
            ExportStreams::AudioOnly,
            sample_probe_with_audio(),
        )
        .unwrap();

        assert_eq!(prepared.streams, ExportStreams::AudioOnly);
        assert_eq!(prepared.plan.video, None);
        assert_eq!(prepared.ffprobe, directory.path.join("ffprobe"));
        for flag in ["-c:v", "[v]", "-crf"] {
            assert!(
                !prepared.arguments.iter().any(|argument| argument == flag),
                "{flag}: {:?}",
                prepared.arguments
            );
        }
        let muxer = prepared
            .arguments
            .iter()
            .position(|argument| argument == "-f")
            .unwrap();
        assert_eq!(prepared.arguments[muxer + 1], "mp4");

        // The facts of the run keep the choice and carry no frame goal, so the `started` event
        // has none either and the interface shows the progress as indeterminate (ADR 025).
        let start = start_payload("42-7", &prepared);
        assert_eq!(start.streams, ExportStreams::AudioOnly);
        assert_eq!(start.expected_frames, None);
        assert_eq!(start.total_duration_us, 1_000_000);
    }

    #[test]
    fn preparation_builds_a_video_only_command_with_no_audio_flag() {
        let directory = TestDirectory::new();
        let prepared = prepare_streams(
            &directory,
            ExportStreams::VideoOnly,
            sample_probe_with_audio(),
        )
        .unwrap();

        assert_eq!(prepared.plan.audio, None);
        for flag in ["-c:a", "[a]"] {
            assert!(
                !prepared.arguments.iter().any(|argument| argument == flag),
                "{flag}: {:?}",
                prepared.arguments
            );
        }
        let start = start_payload("42-7", &prepared);
        assert_eq!(start.streams, ExportStreams::VideoOnly);
        assert_eq!(start.expected_frames, Some(30));
    }

    // -- the first audio packet --------------------------------------------------------------

    /// The sample probe as the re-probe reads a Matroska source of 120 s whose audio starts
    /// after its first 5 s: the start and the length of the container, and the tag of the track
    /// (ADR 014 measurement 24).
    fn sample_probe_with_a_missed_audio_start() -> MediaProbe {
        let mut probe = MediaProbe {
            video_duration_ticks: Some(TickCount::new(120 * 90_000).unwrap()),
            approximate_duration_seconds: Some(120.0),
            ..sample_probe_with_audio()
        };
        let audio = probe.audio.as_mut().unwrap();
        audio.start_time = Some(Rational::new(0, 1).unwrap());
        audio.duration = Some(Rational::new(120, 1).unwrap());
        audio.tagged_end = Some(Rational::new(120, 1).unwrap());
        probe
    }

    /// The first packet of an MPEG-TS audio stream with the PID 0x101, at `seconds`.
    fn packet_at(seconds: i64) -> FirstAudioPacket {
        FirstAudioPacket {
            time: Rational::new(seconds, 1),
            position: Some(141_608_932),
            stream_id: Some(0x101),
        }
    }

    /// A read of the first audio packet that finds it at `seconds`.
    fn first_packet_at(
        seconds: i64,
    ) -> impl FnMut(&Path, &Path, u32, &AtomicBool) -> Result<Option<FirstAudioPacket>, ProbeError>
    {
        move |_, _, _, _| Ok(Some(packet_at(seconds)))
    }

    #[test]
    fn a_later_first_audio_packet_gives_the_plan_the_audio_start_the_re_probe_missed() {
        // The re-probe puts the audio at 0 s, so the plan does not see the late start and cannot
        // bound the silence in front of it. The first packet at 12 s corrects the start.
        let directory = TestDirectory::new();
        let cancel = AtomicBool::new(false);
        let read = RefCell::new(None);
        let prepared = prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_start(),
            &[(0, 1)],
            &cancel,
            |ffprobe, source, stream, flag| {
                *read.borrow_mut() = Some((
                    ffprobe.to_path_buf(),
                    source.to_path_buf(),
                    stream,
                    std::ptr::eq(flag, &cancel),
                ));
                Ok(Some(packet_at(12)))
            },
        )
        .unwrap();

        // The read names the located ffprobe, the source, the absolute index of the audio
        // stream, and the cancel flag of this run.
        assert_eq!(
            read.into_inner(),
            Some((
                directory.path.join("ffprobe"),
                directory.path.join("source.mp4"),
                1,
                true
            ))
        );
        // The audio has its own process whatever its start (ADR 043). The start the packet gives
        // bounds the silence in front of it; see the next test.
        assert!(prepared.audio_arguments.is_some());
    }

    #[test]
    fn the_corrected_audio_start_gives_the_segment_its_silence_prefix() {
        // A segment from 0 s to 75 s needs 70 s of silence in front of audio that starts at 70 s.
        // The audio chain streams all of it but the margin of 0.25 s (ADR 014 measurement 27),
        // with and without video. The re-probe alone puts the audio at 0 s, and gives no prefix.
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let directory = TestDirectory::new();
            let prepared = prepare_reading_first_packet(
                &directory,
                streams,
                sample_probe_with_a_missed_audio_start(),
                &[(0, 75)],
                &AtomicBool::new(false),
                first_packet_at(70),
            )
            .unwrap();
            assert_eq!(prepared.plan.segments[0].audio_prefix, Some(3_348_000));
            let graph = if streams == ExportStreams::VideoAndAudio {
                audio_graph_of(&prepared)
            } else {
                graph_of(&prepared)
            };
            assert!(
                graph.contains("anullsrc=r=48000:cl=mono,aresample,atrim=end_sample=3348000[q0]"),
                "{graph}"
            );

            let directory = TestDirectory::new();
            let uncorrected = prepare_reading_first_packet(
                &directory,
                streams,
                sample_probe_with_a_missed_audio_start(),
                &[(0, 75)],
                &AtomicBool::new(false),
                first_packet_unread,
            )
            .unwrap();
            assert_eq!(uncorrected.plan.segments[0].audio_prefix, None);
        }
    }

    #[test]
    fn a_segment_that_ends_before_the_corrected_start_writes_its_silence_frame_by_frame() {
        // A segment from 0 s to 65 s ends before audio that starts at 70 s. It does not reach the
        // first sample, so it needs no prefix and counts nothing toward the bound: its chain writes
        // 65 s of silence frame by frame (ADR 014 measurement 23).
        let directory = TestDirectory::new();
        let prepared = prepare_reading_first_packet(
            &directory,
            ExportStreams::AudioOnly,
            sample_probe_with_a_missed_audio_start(),
            &[(0, 65)],
            &AtomicBool::new(false),
            first_packet_at(70),
        )
        .unwrap();
        assert_eq!(
            prepared.plan.audio.unwrap().expected_duration,
            Rational::new(65, 1).unwrap()
        );
        // With video the same: the audio process pads every chain the same way (ADR 043).
        let directory = TestDirectory::new();
        prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_start(),
            &[(0, 65)],
            &AtomicBool::new(false),
            first_packet_at(70),
        )
        .unwrap();
    }

    /// The graph of the audio process of a prepared export, as preparation wrote it into the work
    /// directory (ADR 055). The command names the file.
    fn audio_graph_of(prepared: &PreparedExport) -> String {
        let audio = prepared
            .audio_arguments
            .as_ref()
            .expect("the export has an audio process");
        assert!(audio
            .windows(2)
            .any(|pair| pair == ["-/filter_complex", AUDIO_GRAPH_FILE]));
        fs::read_to_string(prepared.work.file_path(AUDIO_GRAPH_FILE)).unwrap()
    }

    /// The graph of the encoder of a prepared export, as preparation wrote it into the work
    /// directory (ADR 055). The command names the file.
    fn graph_of(prepared: &PreparedExport) -> String {
        assert!(prepared
            .arguments
            .windows(2)
            .any(|pair| pair == ["-/filter_complex", ENCODER_GRAPH_FILE]));
        fs::read_to_string(prepared.work.file_path(ENCODER_GRAPH_FILE)).unwrap()
    }

    /// The re-probe of a Matroska source of 120 s whose audio track holds no packets, as FFmpeg
    /// 9.0.2 wrote it: the start and the length of the container, and a `DURATION` tag of
    /// `00:00:00.000000000` (ADR 014 measurement 26).
    fn sample_probe_with_an_empty_audio_track() -> MediaProbe {
        let mut probe = sample_probe_with_a_missed_audio_start();
        probe.audio.as_mut().unwrap().tagged_end = Some(Rational::new(0, 1).unwrap());
        probe
    }

    // -- the read of the gaps inside the audio stream ------------------------------------------

    /// A read of the gaps inside the audio stream that a test expects never to run: no chain reads
    /// the stream, the plan refuses the segments, or a cancel ends the run first.
    fn gaps_not_read(
        _: &Path,
        _: &Path,
        _: &AudioGapRead<'_>,
        _: &AtomicBool,
    ) -> Result<AudioFrames, ProbeError> {
        unreachable!("the test expects no read of the gaps inside the audio stream")
    }

    /// The gaps that ffprobe reads in an audio stream that stops at 10 s and resumes at 100 s.
    fn gap_from_10_to_100(
        _: &Path,
        _: &Path,
        _: &AudioGapRead<'_>,
        _: &AtomicBool,
    ) -> Result<AudioFrames, ProbeError> {
        let gaps = vec![
            ffmpeg::AudioGap {
                from: None,
                to: Rational::new(0, 1).unwrap(),
            },
            ffmpeg::AudioGap {
                from: Some(Rational::new(10, 1).unwrap()),
                to: Rational::new(100, 1).unwrap(),
            },
        ];
        Ok(AudioFrames {
            fine_gaps: gaps.clone(),
            gaps,
            end: Some(Rational::new(120, 1).unwrap()),
            longest_frame: Rational::new(1024, 48_000),
        })
    }

    #[test]
    fn the_read_of_the_gaps_gets_the_stream_its_rate_and_the_segments_in_seconds() {
        let directory = TestDirectory::new();
        let read = RefCell::new(None);
        prepare_reading_gaps(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_start(),
            &[(60, 62), (10, 20)],
            &AtomicBool::new(false),
            first_packet_unread,
            |_, _, gap_read: &AudioGapRead<'_>, _| {
                *read.borrow_mut() = Some((
                    gap_read.stream_index,
                    gap_read.sample_rate,
                    gap_read.ranges.to_vec(),
                    gap_read.min_gap,
                ));
                Ok(AudioFrames::default())
            },
        )
        .unwrap();
        let whole = |seconds| Rational::new(seconds, 1).unwrap();
        assert_eq!(
            read.into_inner(),
            Some((
                1,
                48_000,
                vec![(whole(60), whole(62)), (whole(10), whole(20))],
                Rational::new(1, 10).unwrap(),
            ))
        );
    }

    #[test]
    fn a_long_gap_inside_the_audio_refuses_the_export_before_the_reservation() {
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let directory = TestDirectory::new();
            let prepare = |segments: &[(i64, i64)]| {
                prepare_reading_gaps(
                    &directory,
                    streams,
                    sample_probe_with_a_missed_audio_start(),
                    segments,
                    &AtomicBool::new(false),
                    first_packet_unread,
                    gap_from_10_to_100,
                )
            };
            match prepare(&[(5, 110)]) {
                Err(error) => assert_eq!(error.code, ExportErrorCode::AudioGapTooLong),
                Ok(_) => panic!("the fill of [5, 110) holds 90 s of silence"),
            }
            assert_eq!(leftover_reservations(&directory), 0);
            // A segment that ends in the gap holds no audio behind it.
            prepare(&[(5, 90)]).unwrap();
        }
    }

    #[test]
    fn a_failed_read_of_the_gaps_bounds_no_gap_and_a_cancel_ends_the_run() {
        let directory = TestDirectory::new();
        let prepare = |cancel: &AtomicBool, gaps: Result<AudioFrames, ProbeError>| {
            prepare_reading_gaps(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_start(),
                &[(5, 110)],
                cancel,
                first_packet_unread,
                {
                    let mut gaps = Some(gaps);
                    move |_, _, _, _| gaps.take().expect("one source is read once")
                },
            )
        };
        let failed = ProbeError::ProcessFailed {
            code: Some(1),
            stderr: Vec::new(),
        };
        prepare(&AtomicBool::new(false), Err(failed)).unwrap();
        let canceled = prepare(&AtomicBool::new(false), Err(ProbeError::Canceled));
        assert!(
            matches!(&canceled, Err(error) if error.code == ExportErrorCode::Canceled),
            "a cancel that stops the read ends the run"
        );
        // A cancel that arrives as the first read of the audio ends stops the run before the read
        // of the gaps starts.
        let cancel = AtomicBool::new(false);
        let error = prepare_reading_gaps(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_start(),
            &[(5, 110)],
            &cancel,
            |_, _, _, _| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(Some(packet_at(0)))
            },
            gaps_not_read,
        );
        assert!(matches!(&error, Err(error) if error.code == ExportErrorCode::Canceled));
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn the_gaps_are_not_read_when_no_chain_reads_the_audio_stream() {
        let directory = TestDirectory::new();
        // A video-only export reads no audio.
        prepare_reading_gaps(
            &directory,
            ExportStreams::VideoOnly,
            sample_probe_with_a_missed_audio_start(),
            &[(5, 110)],
            &AtomicBool::new(false),
            first_packet_unread,
            gaps_not_read,
        )
        .unwrap();
        // A stream without packets is read by no chain: its chains generate their silence.
        prepare_reading_gaps(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_an_empty_audio_track(),
            &[(5, 110)],
            &AtomicBool::new(false),
            no_first_packet,
            gaps_not_read,
        )
        .unwrap();
        // The plan refuses no segments, more segments than it takes, an In point that is not before
        // its Out point, and a stream without a sample rate.
        for (segments, code) in [
            (Vec::new(), ExportErrorCode::NoSegments),
            (
                vec![(0, 1); MAX_EXPORT_SEGMENTS + 1],
                ExportErrorCode::TooManySegments,
            ),
        ] {
            let refused = prepare_reading_gaps(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_start(),
                &segments,
                &AtomicBool::new(false),
                first_packet_unread,
                gaps_not_read,
            );
            assert!(
                matches!(&refused, Err(error) if error.code == code),
                "{code:?}"
            );
        }
        let refused = prepare_reading_gaps(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_start(),
            &[(5, 5)],
            &AtomicBool::new(false),
            first_packet_unread,
            gaps_not_read,
        );
        assert!(matches!(&refused, Err(error) if error.code == ExportErrorCode::InvalidSegment));
        let mut probe = sample_probe_with_a_missed_audio_start();
        probe.audio.as_mut().unwrap().sample_rate = None;
        let refused = prepare_reading_gaps(
            &directory,
            ExportStreams::VideoAndAudio,
            probe,
            &[(5, 110)],
            &AtomicBool::new(false),
            first_packet_unread,
            gaps_not_read,
        );
        assert!(
            matches!(&refused, Err(error) if error.code == ExportErrorCode::SourceAudioRateUnknown)
        );
    }

    #[test]
    fn a_stream_without_packets_generates_silence_and_opens_no_input_for_the_audio() {
        // Read as audio, the track gives no frame before the end of the file, and FFmpeg keeps the
        // decoded video until then. The read of the first packet finds none and reports no error.
        let directory = TestDirectory::new();
        let prepared = prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_an_empty_audio_track(),
            &[(0, 1), (30, 32)],
            &AtomicBool::new(false),
            no_first_packet,
        )
        .unwrap();
        let audio = prepared.plan.audio.as_ref().unwrap();
        assert_eq!(
            prepared.plan.sources[0]
                .audio
                .as_ref()
                .unwrap()
                .silence_layout
                .as_deref(),
            Some("stereo")
        );
        assert_eq!(audio.expected_duration, Rational::new(3, 1).unwrap());
        // One process: no chain reads the stream, so nothing waits for it.
        assert!(prepared.audio_arguments.is_none());
        // One input for each segment, and none for the audio; no chain reads stream 1.
        let inputs = prepared
            .arguments
            .iter()
            .filter(|argument| *argument == "-i")
            .count();
        assert_eq!(inputs, 2);
        let graph = graph_of(&prepared);
        assert!(!graph.contains(":1]"), "{graph}");
        assert!(
            graph.contains(
                "anullsrc=r=48000:cl=stereo,atrim=end_sample=96000,\
                 aformat=f=fltp:r=48000:cl=stereo[a1]"
            ),
            "{graph}"
        );

        // A read that fails says nothing about the stream, so the chains read it, as before.
        let directory = TestDirectory::new();
        let prepared = prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_an_empty_audio_track(),
            &[(0, 1), (30, 32)],
            &AtomicBool::new(false),
            first_packet_unread,
        )
        .unwrap();
        assert_eq!(
            prepared.plan.sources[0]
                .audio
                .as_ref()
                .unwrap()
                .silence_layout,
            None
        );
        assert!(audio_graph_of(&prepared).contains("[0:1]aformat=r=48000,atrim="));
    }

    #[test]
    fn a_container_that_records_audio_overrules_a_read_that_found_no_packet() {
        // A read error that no demuxer reports ends the read as the end of the file does. A
        // positive `DURATION` tag, or a count of packets in the index of an MP4 file, shows that
        // the track holds audio, so the chains read it.
        let mut counted = sample_probe_with_an_empty_audio_track();
        counted.audio.as_mut().unwrap().reported_packets = Some(5626);
        for probe in [sample_probe_with_a_missed_audio_start(), counted] {
            let directory = TestDirectory::new();
            let prepared = prepare_reading_first_packet(
                &directory,
                ExportStreams::VideoAndAudio,
                probe,
                &[(0, 1)],
                &AtomicBool::new(false),
                no_first_packet,
            )
            .unwrap();
            assert_eq!(
                prepared.plan.sources[0]
                    .audio
                    .as_ref()
                    .unwrap()
                    .silence_layout,
                None
            );
            assert!(audio_graph_of(&prepared).contains("[0:1]aformat=r=48000,atrim="));
        }
        // A count of zero contradicts nothing.
        let mut empty = sample_probe_with_an_empty_audio_track();
        empty.audio.as_mut().unwrap().reported_packets = Some(0);
        let directory = TestDirectory::new();
        let prepared = prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            empty,
            &[(0, 1)],
            &AtomicBool::new(false),
            no_first_packet,
        )
        .unwrap();
        assert!(prepared.plan.sources[0]
            .audio
            .as_ref()
            .unwrap()
            .silence_layout
            .is_some());
    }

    #[test]
    fn an_audio_only_export_of_a_stream_without_packets_is_refused_as_a_source_without_audio() {
        let directory = TestDirectory::new();
        let error = match prepare_reading_first_packet(
            &directory,
            ExportStreams::AudioOnly,
            sample_probe_with_an_empty_audio_track(),
            &[(0, 1)],
            &AtomicBool::new(false),
            no_first_packet,
        ) {
            Err(error) => error,
            Ok(_) => panic!("an empty stream gives no audio to export"),
        };
        assert_eq!(error.code, ExportErrorCode::SourceHasNoAudio);
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn a_cancel_that_arrives_as_the_read_finds_no_packet_ends_the_run_as_canceled() {
        // Without the check after the reads, the plan would refuse this audio-only export with
        // `sourceHasNoAudio` and report that instead of the cancel.
        let directory = TestDirectory::new();
        let cancel = AtomicBool::new(false);
        let error = match prepare_reading_first_packet(
            &directory,
            ExportStreams::AudioOnly,
            sample_probe_with_an_empty_audio_track(),
            &[(0, 1)],
            &cancel,
            |_, _, _, flag| {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("the run was canceled"),
        };
        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn a_first_audio_packet_at_or_before_the_reported_start_leaves_the_command_as_it_was() {
        // A source that the re-probe reads correctly: its first packet lies at the reported start,
        // or before it by the priming of the encoder. The plan and the commands do not change, byte
        // for byte.
        //
        // The plan, the encoder's command without the reservation, and the audio process's
        // command (ADR 043).
        type PlanAndCommands = (ExportPlan, Vec<String>, Option<Vec<String>>);
        let plan_and_commands = |prepared: PreparedExport| -> PlanAndCommands {
            let mut arguments = prepared.arguments.clone();
            arguments.pop();
            (
                prepared.plan.clone(),
                arguments,
                prepared.audio_arguments.clone(),
            )
        };
        let directory = TestDirectory::new();
        let mut probe = sample_probe_with_a_missed_audio_start();
        probe.audio.as_mut().unwrap().start_time = Rational::new(3, 5);
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::AudioOnly] {
            let expected = plan_and_commands(
                prepare_reading_first_packet(
                    &directory,
                    streams,
                    probe.clone(),
                    &[(0, 1), (30, 40)],
                    &AtomicBool::new(false),
                    first_packet_unread,
                )
                .unwrap(),
            );
            assert_eq!(
                expected.0.separate_audio_process(),
                streams == ExportStreams::VideoAndAudio
            );
            for time in [Rational::new(3, 5), Rational::new(2, 5)] {
                let first_packet = FirstAudioPacket {
                    time,
                    ..packet_at(0)
                };
                let prepared = prepare_reading_first_packet(
                    &directory,
                    streams,
                    probe.clone(),
                    &[(0, 1), (30, 40)],
                    &AtomicBool::new(false),
                    move |_, _, _, _| Ok(Some(first_packet)),
                )
                .unwrap();
                assert_eq!(plan_and_commands(prepared), expected, "{first_packet:?}");
            }
        }
    }

    #[test]
    fn the_first_audio_packet_is_read_only_for_an_export_that_writes_the_audio_of_a_source() {
        let directory = TestDirectory::new();
        let never = |_: &Path,
                     _: &Path,
                     _: u32,
                     _: &AtomicBool|
         -> Result<Option<FirstAudioPacket>, ProbeError> {
            unreachable!("nothing reads the audio")
        };
        prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoOnly,
            sample_probe_with_a_missed_audio_start(),
            &[(0, 1)],
            &AtomicBool::new(false),
            never,
        )
        .unwrap();
        prepare_reading_first_packet(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe(),
            &[(0, 1)],
            &AtomicBool::new(false),
            never,
        )
        .unwrap();
    }

    /// The sample probe as the re-probe reads an MPEG-TS source of 120 s whose audio starts after
    /// its first 5 s: the start and the length of the container, and no sample rate (ADR 014
    /// measurement 25).
    fn sample_probe_with_a_missed_audio_rate() -> MediaProbe {
        let mut probe = MediaProbe {
            format_names: vec!["mpegts".to_owned()],
            format_long_name: Some("MPEG-TS (MPEG-2 Transport Stream)".to_owned()),
            ..sample_probe_with_a_missed_audio_start()
        };
        let audio = probe.audio.as_mut().unwrap();
        audio.sample_rate = None;
        audio.tagged_end = None;
        probe
    }

    #[test]
    fn a_sample_rate_the_re_probe_missed_is_read_from_the_position_of_the_first_audio_packet() {
        let directory = TestDirectory::new();
        let cancel = AtomicBool::new(false);
        let read = RefCell::new(None);
        let prepared = prepare_reading_audio(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_rate(),
            &[(0, 1)],
            &cancel,
            first_packet_at(12),
            |ffprobe, source, position, stream_id, flag| {
                *read.borrow_mut() = Some((
                    ffprobe.to_path_buf(),
                    source.to_path_buf(),
                    position,
                    stream_id,
                    std::ptr::eq(flag, &cancel),
                ));
                Ok(Some(44_100))
            },
        )
        .unwrap();

        // The read names the located ffprobe, the source, the position of the first packet, the id
        // of its stream, and the cancel flag of this run.
        assert_eq!(
            read.into_inner(),
            Some((
                directory.path.join("ffprobe"),
                directory.path.join("source.mp4"),
                141_608_932,
                0x101,
                true
            ))
        );
        let audio = prepared.plan.sources[0].audio.as_ref().unwrap();
        assert_eq!(audio.sample_rate, 44_100);
        // The ticks of the cut count that rate: one second is 44100 of them.
        assert_eq!(prepared.plan.segments[0].audio_out_tick, Some(44_100));
        // The audio process converts from that rate.
        let graph = audio_graph_of(&prepared);
        assert!(graph.contains("aformat=r=44100,atrim="), "{graph}");
    }

    #[test]
    fn a_read_of_the_sample_rate_that_fails_leaves_the_audio_refused_as_before() {
        let failures = [
            Ok(None),
            Err(ProbeError::Spawn {
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "gone"),
            }),
            Err(ProbeError::ProcessFailed {
                code: Some(1),
                stderr: Vec::new(),
            }),
            Err(ProbeError::Parse {
                source: crate::ffmpeg::ProbeParseError::Json(
                    serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err(),
                ),
                stderr: Vec::new(),
            }),
            Err(ProbeError::TimedOut {
                timeout: Duration::from_secs(30),
                stderr: Vec::new(),
            }),
        ];
        for failure in failures {
            let directory = TestDirectory::new();
            let shown = format!("{failure:?}");
            let error = match prepare_reading_audio(
                &directory,
                ExportStreams::AudioOnly,
                sample_probe_with_a_missed_audio_rate(),
                &[(20, 30)],
                &AtomicBool::new(false),
                first_packet_at(12),
                {
                    let mut failure = Some(failure);
                    move |_, _, _, _, _| failure.take().expect("one source is read once")
                },
            ) {
                Err(error) => error,
                Ok(_) => panic!("{shown}: the rate stays unknown"),
            };
            assert_eq!(
                error.code,
                ExportErrorCode::SourceAudioRateUnknown,
                "{shown}"
            );
            assert_eq!(leftover_reservations(&directory), 0);
        }
    }

    #[test]
    fn the_sample_rate_is_read_only_from_a_packet_with_a_position_and_a_stream_id() {
        for packet in [
            None,
            Some(FirstAudioPacket {
                position: None,
                ..packet_at(12)
            }),
            Some(FirstAudioPacket {
                stream_id: None,
                ..packet_at(12)
            }),
        ] {
            let directory = TestDirectory::new();
            let error = match prepare_reading_audio(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_rate(),
                &[(0, 1)],
                &AtomicBool::new(false),
                move |_, _, _, _| Ok(packet),
                sample_rate_not_read,
            ) {
                Err(error) => error,
                Ok(_) => panic!("{packet:?}: the rate stays unknown"),
            };
            assert_eq!(error.code, ExportErrorCode::SourceAudioRateUnknown);
        }
    }

    #[test]
    fn a_sample_rate_is_not_read_in_a_container_whose_streams_have_no_id_to_read_it_by() {
        // The plan refuses the audio whatever its start, so neither read runs: the first could
        // spend the whole deadline before the same refusal.
        let never_first = |_: &Path,
                           _: &Path,
                           _: u32,
                           _: &AtomicBool|
         -> Result<Option<FirstAudioPacket>, ProbeError> {
            unreachable!("the rate cannot be read in this container")
        };
        for format_names in [vec!["mov", "mp4"], vec!["matroska", "webm"]] {
            let directory = TestDirectory::new();
            let probe = MediaProbe {
                format_names: format_names.iter().map(|name| (*name).to_owned()).collect(),
                ..sample_probe_with_a_missed_audio_rate()
            };
            let error = match prepare_reading_audio(
                &directory,
                ExportStreams::VideoAndAudio,
                probe,
                &[(0, 1)],
                &AtomicBool::new(false),
                never_first,
                sample_rate_not_read,
            ) {
                Err(error) => error,
                Ok(_) => panic!("{format_names:?}: the rate stays unknown"),
            };
            assert_eq!(error.code, ExportErrorCode::SourceAudioRateUnknown);
        }
        // MPEG-PS is the other container whose rate the reads find.
        assert!(rate_readable_from_packets(&["mpeg".to_owned()]));
        assert!(rate_readable_from_packets(&["mpegts".to_owned()]));
        assert!(!rate_readable_from_packets(&["mpegtsraw".to_owned()]));
    }

    #[test]
    fn a_cancel_before_or_during_the_read_of_the_sample_rate_ends_the_run_with_nothing_reserved() {
        // Before: the first read finished in the same poll as the cancel, so the second must not
        // start. During: the second read reports the cancel. The flag stays unset there, so only
        // the mapping of that report can end the run as canceled.
        let directory = TestDirectory::new();
        let error = match prepare_reading_audio(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_rate(),
            &[(0, 1)],
            &AtomicBool::new(false),
            |_, _, _, cancel| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(Some(packet_at(12)))
            },
            sample_rate_not_read,
        ) {
            Err(error) => error,
            Ok(_) => panic!("the run was canceled"),
        };
        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(leftover_reservations(&directory), 0);

        let directory = TestDirectory::new();
        let error = match prepare_reading_audio(
            &directory,
            ExportStreams::VideoAndAudio,
            sample_probe_with_a_missed_audio_rate(),
            &[(0, 1)],
            &AtomicBool::new(false),
            first_packet_at(12),
            |_, _, _, _, _| Err(ProbeError::Canceled),
        ) {
            Err(error) => error,
            Ok(_) => panic!("the run was canceled"),
        };
        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn a_cancel_during_the_re_probe_ends_preparation_before_the_first_audio_packet_is_read() {
        // The re-probe takes no cancel flag, so a cancel that lands while it runs is read only
        // after it. The read of the first packet is the next step that can spend tens of seconds.
        let directory = TestDirectory::new();
        let cancel = AtomicBool::new(false);
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &cancel,
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
            |_, _, _| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(sample_probe_with_a_missed_audio_start())
            },
            |_, _, _, _| unreachable!("the run was canceled before the read"),
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn a_failed_read_of_the_first_audio_packet_keeps_the_re_probe_and_the_export() {
        // The read only adds accuracy. A failure leaves the plan the re-probe gives, and the
        // command is the command of an export without the read. Every run uses one directory, so
        // the commands name one source; the last argument, the reservation, is left out.
        let command = |prepared: PreparedExport| -> Vec<String> {
            let mut arguments = prepared.arguments.clone();
            arguments.pop();
            arguments
        };
        let directory = TestDirectory::new();
        let expected = command(
            prepare_streams(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_start(),
            )
            .unwrap(),
        );
        let failures = [
            ProbeError::Spawn {
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "gone"),
            },
            ProbeError::ProcessFailed {
                code: Some(1),
                stderr: b"Invalid data found when processing input".to_vec(),
            },
            ProbeError::Parse {
                source: crate::ffmpeg::ProbeParseError::Json(
                    serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err(),
                ),
                stderr: Vec::new(),
            },
            ProbeError::TimedOut {
                timeout: Duration::from_secs(30),
                stderr: Vec::new(),
            },
        ];
        for failure in failures {
            let shown = failure.to_string();
            let prepared = prepare_reading_first_packet(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_start(),
                &[(0, 1)],
                &AtomicBool::new(false),
                {
                    let mut failure = Some(failure);
                    move |_, _, _, _| Err(failure.take().expect("one source is read once"))
                },
            )
            .unwrap_or_else(|error| panic!("{shown}: {:?}", error.code));
            assert_eq!(command(prepared), expected, "{shown}");
        }
    }

    #[test]
    fn a_cancel_during_the_read_of_the_first_audio_packet_ends_the_run_with_nothing_reserved() {
        // The read stops on the flag of the run and reports the cancel. A read that finished in the
        // same poll as the cancel still ends the run before the reservation.
        for answer in [Err(ProbeError::Canceled), Ok(Some(packet_at(12)))] {
            let directory = TestDirectory::new();
            let error = match prepare_reading_first_packet(
                &directory,
                ExportStreams::VideoAndAudio,
                sample_probe_with_a_missed_audio_start(),
                &[(0, 1)],
                &AtomicBool::new(false),
                {
                    let mut answer = Some(answer);
                    move |_, _, _, cancel| {
                        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                        answer.take().expect("one source is read once")
                    }
                },
            ) {
                Err(error) => error,
                Ok(_) => panic!("the run was canceled"),
            };
            assert_eq!(error.code, ExportErrorCode::Canceled);
            assert_eq!(leftover_reservations(&directory), 0);
        }
    }

    // -- the stream choice: the success check of an export without video -------------------

    /// A one-second plan that writes 48000 Hz audio and no video.
    fn sample_audio_plan(destination: &Path) -> ExportPlan {
        let mut plan = sample_plan(destination);
        plan.video = None;
        plan.audio = Some(crate::ffmpeg::export::PlannedAudio {
            output_sample_rate: 48_000,
            output_channels: AudioChannels::Stereo,
            output_layout: Some("stereo".to_owned()),
            absent_layout: "stereo".to_owned(),
            encoder: "aac".to_owned(),
            bitrate: None,
            options: vec![],
            gain_tenths_db: 0,
            // The source audio covers the whole segment.
            expected_duration: Rational::new(1, 1).unwrap(),
        });
        plan.sources[0].audio = Some(crate::ffmpeg::export::SourceAudio {
            stream_index: 1,
            sample_rate: 48_000,
            silence_layout: None,
        });
        plan.segments[0].audio_in_tick = Some(0);
        plan.segments[0].audio_out_tick = Some(48_000);
        plan
    }

    /// Limits for the tests of [`run_export_job_with`] that do not reach a limit: a deadline far
    /// away, and a poll long enough that a wait for it would show in the time of a test.
    const NO_LIMIT_REACHED: PreparationLimits = PreparationLimits {
        timeout: Duration::from_secs(600),
        grace: Duration::from_secs(30),
        poll: Duration::from_secs(10),
    };

    /// Wait until `path` is gone, for at most five seconds, and tell whether it went.
    fn eventually_gone(path: &Path) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while path.exists() {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }

    #[test]
    fn a_failure_of_preparation_is_reported_before_the_slot_is_released() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let ran = Cell::new(false);

        run_export_job_with(
            slot,
            NO_LIMIT_REACHED,
            |_, _| Err(ExportCommandError::new(ExportErrorCode::SourceNotFound)),
            |_, _| ran.set(true),
            |error| {
                // The wait at an application quit takes a free slot to mean that the run has
                // reported and cleaned up (ADR 017).
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::SourceNotFound));
        assert!(!ran.get());
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn the_answer_of_start_export_is_the_run_id_in_camel_case() {
        let value = serde_json::to_value(ExportSubmission {
            run_id: "42-7".to_owned(),
            queued: true,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({ "runId": "42-7", "queued": true })
        );
    }

    #[test]
    fn the_preparing_event_names_its_run_in_camel_case() {
        let value = serde_json::to_value(ExportEvent::Preparing {
            run_id: "42-7".to_owned(),
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({ "event": "preparing", "runId": "42-7" })
        );
    }

    #[test]
    fn a_panic_in_preparation_is_reported_as_command_execution_failed() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);

        run_export_job_with(
            slot,
            NO_LIMIT_REACHED,
            |_, _| panic!("preparation panicked"),
            |_, _| unreachable!(),
            |error| {
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error);
            },
        );

        let error = reported.into_inner().unwrap();
        assert_eq!(error.code, ExportErrorCode::CommandExecutionFailed);
        assert_eq!(error.detail.as_deref(), Some("preparation panicked"));
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_cancel_after_preparation_deletes_the_reservation_and_reports_canceled() {
        let directory = TestDirectory::new();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let reserved = Arc::new(std::sync::Mutex::new(None));
        let destination = directory.path.join("out.m4a");
        let helper_registry = Arc::clone(&registry);
        let helper_reserved = Arc::clone(&reserved);

        run_export_job_with(
            slot,
            NO_LIMIT_REACHED,
            move |_, _| {
                let (prepared, path) = prepared_audio_run(&destination);
                *helper_reserved.lock().unwrap() = Some(path);
                // The cancel lands after preparation passed its own checks.
                helper_registry.cancel("1-0");
                Ok(prepared)
            },
            |_, _| unreachable!(),
            |error| {
                let path = reserved.lock().unwrap().clone().unwrap();
                assert!(!path.exists(), "the reservation goes before the report");
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_prepared_export_runs_with_its_slot_and_without_a_wait_for_the_poll() {
        let directory = TestDirectory::new();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let ran = Cell::new(false);
        let destination = directory.path.join("out.m4a");
        let started = Instant::now();

        run_export_job_with(
            slot,
            NO_LIMIT_REACHED,
            move |_, _| Ok(prepared_audio_run(&destination).0),
            |slot, prepared| {
                // The answer ends the wait at once. A wait for the poll of ten seconds would show.
                assert!(started.elapsed() < Duration::from_secs(5));
                assert_eq!(slot.run_id(), "1-0");
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                assert_eq!(prepared.streams, ExportStreams::AudioOnly);
                ran.set(true);
            },
            |_| unreachable!(),
        );

        assert!(ran.get());
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_cancel_during_a_blocked_preparation_reports_after_the_grace_and_frees_the_slot() {
        let directory = TestDirectory::new();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let ran = Cell::new(false);
        let destination = directory.path.join("out.m4a");
        let helper_registry = Arc::clone(&registry);
        let (reserved_sender, reserved) = std::sync::mpsc::channel::<PathBuf>();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let saw_stop = Arc::new(AtomicBool::new(false));
        let helper_saw_stop = Arc::clone(&saw_stop);
        let grace = Duration::from_millis(200);
        let started = Instant::now();

        run_export_job_with(
            slot,
            PreparationLimits {
                timeout: Duration::from_secs(60),
                grace,
                poll: Duration::from_millis(5),
            },
            move |stop, _| {
                let (prepared, path) = prepared_audio_run(&destination);
                reserved_sender.send(path).unwrap();
                helper_registry.cancel("1-0");
                // Stands for a call that a share holds: it does not read the stop flag.
                let _ = released.recv();
                helper_saw_stop.store(stop.load(Ordering::SeqCst), Ordering::SeqCst);
                Ok(prepared)
            },
            |_, _| ran.set(true),
            |error| {
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert!(started.elapsed() >= grace);
        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
        // The slot is free while the helper is still blocked, so the next run can start.
        assert_eq!(registry.active_run_id(), None);
        let path = reserved.recv().unwrap();
        assert!(
            path.exists(),
            "the blocked helper still holds its reservation"
        );

        // The blocked call returns with a prepared export. Its send fails, and the export drops
        // on the helper thread, which deletes the temporary file.
        release.send(()).unwrap();
        assert!(eventually_gone(&path), "the late reservation is deleted");
        assert!(saw_stop.load(Ordering::SeqCst));
        assert!(!ran.get());
    }

    #[test]
    fn a_blocked_preparation_times_out_and_names_its_stage() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let (release, released) = std::sync::mpsc::channel::<()>();

        run_export_job_with(
            slot,
            PreparationLimits {
                // Long enough that the helper surely set its stage on a loaded machine.
                timeout: Duration::from_secs(1),
                grace: Duration::from_millis(50),
                poll: Duration::from_millis(5),
            },
            move |_, stage| {
                stage.enter(PreparationStage::ReProbe);
                // Stands for a call that a share holds.
                let _ = released.recv();
                Err(ExportCommandError::new(ExportErrorCode::FfprobeTimedOut))
            },
            |_, _| unreachable!(),
            |error| {
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error);
            },
        );

        let error = reported.into_inner().unwrap();
        assert_eq!(error.code, ExportErrorCode::PreparationTimedOut);
        assert_eq!(error.detail.as_deref(), Some("preparation stage: reProbe"));
        assert_eq!(registry.active_run_id(), None);
        // A step of a source names the source too, counted from 1.
        let cell = PreparationStageCell::default();
        cell.enter_for(PreparationStage::RevisionCheck, Some(1));
        assert_eq!(cell.detail(), "preparation stage: revisionCheck, source 2");
        // A later stage of the same source keeps its number.
        cell.enter(PreparationStage::AudioReads);
        assert_eq!(cell.detail(), "preparation stage: audioReads, source 2");
        assert_eq!(cell.current(), PreparationStage::AudioReads);
        cell.enter_for(PreparationStage::Plan, None);
        assert_eq!(cell.detail(), "preparation stage: plan");
        drop(release);
    }

    #[test]
    fn a_cancel_wins_over_the_error_that_the_stop_of_preparation_caused() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let helper_registry = Arc::clone(&registry);
        let answered = Arc::new(AtomicBool::new(false));
        let helper_answered = Arc::clone(&answered);
        let started = Instant::now();

        run_export_job_with(
            slot,
            PreparationLimits {
                timeout: Duration::from_secs(600),
                grace: Duration::from_secs(30),
                poll: Duration::from_millis(5),
            },
            move |stop, _| {
                helper_registry.cancel("1-0");
                // Stands for a step that stops on the flag, takes a moment, and reports its own
                // failure.
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                std::thread::sleep(Duration::from_millis(100));
                helper_answered.store(true, Ordering::SeqCst);
                Err(ExportCommandError::new(
                    ExportErrorCode::FfprobeProcessFailed,
                ))
            },
            |_, _| unreachable!(),
            |error| {
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
        // The run waited for the answer of the helper, and not for the whole grace.
        assert!(answered.load(Ordering::SeqCst));
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_canceled_answer_within_the_grace_reports_canceled() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let helper_registry = Arc::clone(&registry);

        run_export_job_with(
            slot,
            PreparationLimits {
                timeout: Duration::from_secs(600),
                grace: Duration::from_secs(30),
                poll: Duration::from_millis(5),
            },
            move |stop, _| {
                helper_registry.cancel("1-0");
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(ExportCommandError::new(ExportErrorCode::Canceled))
            },
            |_, _| unreachable!(),
            |error| *reported.borrow_mut() = Some(error.code),
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_run_canceled_before_it_starts_reports_canceled_at_once_and_prepares_nothing() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        registry.cancel("1-0");
        let reported = RefCell::new(None);
        let prepared = Arc::new(AtomicBool::new(false));
        let helper_prepared = Arc::clone(&prepared);
        let started = Instant::now();

        run_export_job_with(
            slot,
            NO_LIMIT_REACHED,
            move |_, _| {
                helper_prepared.store(true, Ordering::SeqCst);
                Err(ExportCommandError::new(ExportErrorCode::FfmpegPairMissing))
            },
            |_, _| unreachable!(),
            |error| {
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
        // At once: no wait for the poll of ten seconds or for the grace.
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!prepared.load(Ordering::SeqCst));
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_failure_that_comes_with_a_cancel_of_the_run_is_reported_as_canceled() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let helper_registry = Arc::clone(&registry);

        run_export_job_with(
            slot,
            // The poll is long, so the answer comes before the watchdog reads the cancel flag.
            NO_LIMIT_REACHED,
            move |_, _| {
                helper_registry.cancel("1-0");
                Err(ExportCommandError::new(
                    ExportErrorCode::FfprobeProcessFailed,
                ))
            },
            |_, _| unreachable!(),
            |error| *reported.borrow_mut() = Some(error.code),
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
    }

    #[test]
    fn a_cancel_during_the_grace_of_the_timeout_reports_canceled() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let helper_registry = Arc::clone(&registry);

        run_export_job_with(
            slot,
            PreparationLimits {
                timeout: Duration::from_millis(100),
                grace: Duration::from_secs(30),
                poll: Duration::from_millis(5),
            },
            move |stop, _| {
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                // The user presses Stop while the watchdog waits the grace of the timeout.
                helper_registry.cancel("1-0");
                Err(ExportCommandError::new(ExportErrorCode::Canceled))
            },
            |_, _| unreachable!(),
            |error| *reported.borrow_mut() = Some(error.code),
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
    }

    #[test]
    fn a_prepared_export_that_comes_in_the_cancel_grace_is_dropped_before_the_report() {
        let directory = TestDirectory::new();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("1-0").unwrap();
        let reported = RefCell::new(None);
        let destination = directory.path.join("out.m4a");
        let helper_registry = Arc::clone(&registry);
        let (reserved_sender, reserved) = std::sync::mpsc::channel::<PathBuf>();

        run_export_job_with(
            slot,
            PreparationLimits {
                timeout: Duration::from_secs(600),
                grace: Duration::from_secs(30),
                poll: Duration::from_millis(5),
            },
            move |stop, _| {
                let (prepared, path) = prepared_audio_run(&destination);
                reserved_sender.send(path).unwrap();
                helper_registry.cancel("1-0");
                // The answer comes only after the watchdog set the stop flag, in the grace.
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Ok(prepared)
            },
            |_, _| unreachable!(),
            |error| {
                let path = reserved.recv().unwrap();
                assert!(!path.exists(), "the reservation goes before the report");
                assert_eq!(registry.active_run_id().as_deref(), Some("1-0"));
                *reported.borrow_mut() = Some(error.code);
            },
        );

        assert_eq!(*reported.borrow(), Some(ExportErrorCode::Canceled));
    }

    #[test]
    fn preparation_records_the_stage_of_each_step_it_runs() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let mut request = request_expecting(&source, None);
        request.pieces = vec![piece("source", 10 * 90_000, 20 * 90_000)];
        let stage = PreparationStageCell::default();
        let seen = RefCell::new(Vec::new());

        prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &stage,
                graph_file: &slash_graph_file,
            },
            |_| {
                seen.borrow_mut().push(stage.current());
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| {
                seen.borrow_mut().push(stage.current());
                Ok(sample_probe_with_a_missed_audio_start())
            },
            |ffprobe, source, index, cancel| {
                seen.borrow_mut().push(stage.current());
                first_packet_unread(ffprobe, source, index, cancel)
            },
            sample_rate_not_read,
            |_, _, _, _| {
                seen.borrow_mut().push(stage.current());
                Ok(AudioFrames::default())
            },
        )
        .unwrap();

        assert_eq!(
            seen.into_inner(),
            vec![
                PreparationStage::Discovery,
                PreparationStage::ReProbe,
                PreparationStage::AudioReads,
                PreparationStage::AudioReads,
            ]
        );
        // The last step of a preparation that passed the plan and the reservation.
        assert_eq!(stage.current(), PreparationStage::Arguments);
    }

    #[test]
    fn a_plan_that_refuses_the_request_leaves_the_stage_at_the_plan() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let mut request = request_expecting(&source, None);
        // A destination whose directory is missing: a refusal that only the plan makes.
        request.output_path = directory
            .path
            .join("missing")
            .join("out.mp4")
            .to_string_lossy()
            .into_owned();
        let stage = PreparationStageCell::default();

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &stage,
                graph_file: &slash_graph_file,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| Ok(sample_probe()),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::OutputDirectoryMissing);
        assert_eq!(stage.current(), PreparationStage::Plan);
    }

    #[test]
    fn the_stage_cell_reads_back_every_stage_and_names_each_one_differently() {
        let cell = PreparationStageCell::default();
        assert_eq!(cell.current(), PreparationStage::Discovery);
        let mut names = Vec::new();
        for stage in PreparationStage::ALL {
            cell.enter(stage);
            assert_eq!(cell.current(), stage);
            names.push(stage.name());
        }
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), PreparationStage::ALL.len());
    }

    #[test]
    fn the_preparation_timeout_is_six_times_the_probe_timeout() {
        assert_eq!(PREPARATION_TIMEOUT, crate::ffmpeg::probe::PROBE_TIMEOUT * 6);
    }
    /// An audio-only run, ready for [`run_export_with`], and the reserved path it writes.
    fn prepared_audio_run(destination: &Path) -> (PreparedExport, PathBuf) {
        let pending = PendingOutput::reserve(destination).unwrap();
        let reserved = pending.path().to_path_buf();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::AudioOnly,
            segment_count: 1,
            plan: sample_audio_plan(destination),
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: None,
            pending,
            work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                .unwrap(),
        };
        (prepared, reserved)
    }

    /// The last progress block of a real audio-only run: no `frame` key at all (M5).
    fn audio_snapshot() -> ProgressSnapshot {
        ProgressSnapshot {
            frame: None,
            fps: None,
            speed: Rational::new(40, 1),
            total_size: Some(16_384),
            done: true,
        }
    }

    /// A zero exit with the given last progress block and a stderr tail.
    fn exited_zero(last_progress: Option<ProgressSnapshot>) -> ExportProcessOutcome {
        ExportProcessOutcome {
            status: ExportProcessStatus::Exited {
                code: Some(0),
                success: true,
            },
            stderr: b"stderr tail".to_vec(),
            last_progress,
        }
    }

    fn output_probe(audio: u32, video: u32, duration: Option<&str>) -> OutputAudioProbe {
        OutputAudioProbe {
            audio_streams: audio,
            video_streams: video,
            duration: duration.map(|text| Rational::from_decimal_str(text).unwrap()),
            audio_start: None,
        }
    }

    fn published(events: &RefCell<Vec<ExportEvent>>) -> usize {
        events
            .borrow()
            .iter()
            .filter(|event| matches!(event, ExportEvent::Publishing { .. }))
            .count()
    }

    #[test]
    fn an_audio_only_export_that_passes_the_check_is_published_after_the_check() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        let (prepared, reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());
        let probed: RefCell<Option<(PathBuf, PathBuf, usize)>> = RefCell::new(None);

        let frames = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, on_progress| {
                fs::write(&reserved, b"the finished audio").unwrap();
                on_progress(&audio_snapshot());
                Ok(exited_zero(Some(audio_snapshot())))
            },
            |ffprobe, file, _cancel| {
                *probed.borrow_mut() = Some((
                    ffprobe.to_path_buf(),
                    file.to_path_buf(),
                    published(&events),
                ));
                Ok(output_probe(1, 0, Some("1.000000")))
            },
        )
        .unwrap();

        // An export without video reports no frames.
        assert_eq!(frames, 0);
        // The check read the reservation, through the located ffprobe, and it ran before the
        // publication: no `publishing` event had been sent when it ran.
        let (ffprobe, file, publishing_before) = probed.borrow().clone().unwrap();
        assert_eq!(ffprobe, PathBuf::from("/usr/bin/ffprobe"));
        assert_eq!(file, reserved);
        assert_eq!(publishing_before, 0);
        assert_eq!(published(&events), 1);
        assert_eq!(fs::read(&destination).unwrap(), b"the finished audio");
        assert!(!reserved.exists());
        // A block without `frame` produces no progress event: the interface stays
        // indeterminate rather than receiving an event its validator refuses.
        assert!(!events
            .borrow()
            .iter()
            .any(|event| matches!(event, ExportEvent::Progress { .. })));
    }

    /// Run an audio-only export whose process exits zero with `last_progress`, and whose output
    /// probe answers `answer`, over a destination that already holds a previous export.
    fn failed_audio_run(
        last_progress: Option<ProgressSnapshot>,
        answer: Result<OutputAudioProbe, ProbeError>,
    ) -> ExportCommandError {
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        fs::write(&destination, b"a previous export").unwrap();
        let (prepared, reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, _on_progress| {
                fs::write(&reserved, b"a wrong file").unwrap();
                Ok(exited_zero(last_progress))
            },
            |_, _, _| answer,
        )
        .unwrap_err();

        // A failed check never publishes: no `publishing` event, the file the user chose keeps
        // its contents, and the reservation is gone, as after every other failure.
        assert_eq!(published(&events), 0);
        assert_eq!(fs::read(&destination).unwrap(), b"a previous export");
        assert!(!reserved.exists());
        assert_eq!(leftover_reservations(&directory), 0);
        error
    }

    #[test]
    fn an_audio_only_export_of_the_wrong_duration_fails_with_both_durations() {
        let error = failed_audio_run(
            Some(audio_snapshot()),
            Ok(output_probe(1, 0, Some("0.500000"))),
        );

        assert_eq!(error.code, ExportErrorCode::AudioDurationMismatch);
        assert_eq!(error.measured_duration_us, Some(500_000));
        assert_eq!(error.expected_duration_us, Some(1_000_000));
        assert_eq!(error.detail.as_deref(), Some("stderr tail"));
    }

    #[test]
    fn an_audio_only_export_with_no_reported_duration_fails_with_the_expected_duration_only() {
        let error = failed_audio_run(Some(audio_snapshot()), Ok(output_probe(1, 0, None)));

        assert_eq!(error.code, ExportErrorCode::AudioDurationMismatch);
        assert_eq!(error.measured_duration_us, None);
        assert_eq!(error.expected_duration_us, Some(1_000_000));
    }

    #[test]
    fn an_audio_only_export_with_the_wrong_streams_fails_whatever_its_duration() {
        for (audio, video) in [(1, 1), (0, 0), (2, 0), (0, 1)] {
            let error = failed_audio_run(
                Some(audio_snapshot()),
                Ok(output_probe(audio, video, Some("1.000000"))),
            );

            assert_eq!(
                error.code,
                ExportErrorCode::OutputStreamsMismatch,
                "{audio} audio, {video} video"
            );
            assert_eq!(error.measured_duration_us, None);
            assert_eq!(error.expected_duration_us, None);
        }
    }

    #[test]
    fn an_audio_only_exit_with_no_progress_at_all_fails_without_probing() {
        // The missing-`-y` case of ADR 016, for an export without video: ffmpeg refused the
        // reservation, reported nothing, and exited zero. There is nothing written to read back.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        let (prepared, reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |_request, _on_progress| Ok(exited_zero(None)),
            |_, _, _| unreachable!("an exit with no progress block has nothing to read back"),
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::OutputStreamsMismatch);
        assert_eq!(error.detail.as_deref(), Some("stderr tail"));
        assert!(!destination.exists());
        assert!(!reserved.exists());
    }

    #[test]
    fn the_audio_check_expects_the_audio_the_source_covers_and_still_catches_a_loss() {
        // The one-second segment of a source whose audio starts 0.3 s late: the planner expects
        // 0.7 s of audio. A correct export of that source writes 0.7 s and is published; one that
        // lost more fails, and names the 0.7 s it expected.
        let run = |measured: &str| {
            let directory = TestDirectory::new();
            let destination = directory.path.join("out.m4a");
            let (mut prepared, reserved) = prepared_audio_run(&destination);
            prepared
                .plan
                .audio
                .as_mut()
                .expect("the audio plan has audio")
                .expected_duration = Rational::new(7, 10).unwrap();
            let registry = Arc::new(ExportRegistry::default());
            let slot = registry.begin("42-7").unwrap();
            let answer = output_probe(1, 0, Some(measured));
            let result = run_export_with(
                &slot,
                prepared,
                "42-7",
                |_event| {},
                |_request, _on_progress| {
                    fs::write(&reserved, b"the finished audio").unwrap();
                    Ok(exited_zero(Some(audio_snapshot())))
                },
                |_, _, _| Ok(answer),
            );
            (result, destination.exists())
        };

        let (passed, published) = run("0.700000");
        assert_eq!(passed.unwrap(), 0);
        assert!(published);

        let (lost, published) = run("0.500000");
        let error = lost.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::AudioDurationMismatch);
        assert_eq!(error.measured_duration_us, Some(500_000));
        assert_eq!(error.expected_duration_us, Some(700_000));
        assert!(!published);
    }

    #[test]
    fn an_output_that_ffprobe_cannot_read_is_a_wrong_output_with_the_ffmpeg_diagnostic() {
        // An `.m4a` with no index, or an empty reservation, makes ffprobe exit 1 (M5). The fault
        // is in the file ffmpeg wrote, not in the source, so the codes that blame the source --
        // and offer no way back -- are wrong here. ffmpeg's stderr tail says why the file is
        // wrong, and ffprobe's only that it is, so the tail stays the detail.
        let process_failed = failed_audio_run(
            Some(audio_snapshot()),
            Err(ProbeError::ProcessFailed {
                code: Some(1),
                stderr: b"Invalid data found when processing input".to_vec(),
            }),
        );
        let parse_failed = failed_audio_run(
            Some(audio_snapshot()),
            Err(ProbeError::Parse {
                source: crate::ffmpeg::ProbeParseError::Json(
                    serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err(),
                ),
                stderr: b"ffprobe's own text".to_vec(),
            }),
        );

        for error in [process_failed, parse_failed] {
            assert_eq!(error.code, ExportErrorCode::OutputStreamsMismatch);
            assert_eq!(error.detail.as_deref(), Some("stderr tail"));
            assert_eq!(error.exit_code, None);
            assert_eq!(error.measured_duration_us, None);
            assert_eq!(error.expected_duration_us, None);
        }
    }

    #[test]
    fn an_output_probe_that_cannot_start_or_answer_keeps_its_ffprobe_code() {
        // These faults are in ffprobe or in the disk, not in the file, so they keep the codes and
        // the diagnostics of the re-probe of the source.
        let timed_out = failed_audio_run(
            Some(audio_snapshot()),
            Err(ProbeError::TimedOut {
                timeout: Duration::from_secs(30),
                stderr: b"the share stopped answering".to_vec(),
            }),
        );
        assert_eq!(timed_out.code, ExportErrorCode::FfprobeTimedOut);
        assert_eq!(
            timed_out.detail.as_deref(),
            Some("the share stopped answering")
        );

        let spawn = failed_audio_run(
            Some(audio_snapshot()),
            Err(ProbeError::Spawn {
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "ffprobe went missing"),
            }),
        );
        assert_eq!(spawn.code, ExportErrorCode::FfprobeSpawnFailed);
        assert_eq!(spawn.detail.as_deref(), Some("ffprobe went missing"));
    }

    #[test]
    fn a_cancel_during_a_slow_output_probe_ends_the_run_as_canceled_at_once() {
        // A share that stopped answering holds ffprobe for up to `PROBE_TIMEOUT`, and an
        // application quit waits five seconds (ADR 017). The run passes its own cancel flag to the
        // probe, and a probe that the flag stopped ends the run as canceled, with nothing
        // published and the reservation deleted. The probe below stands in for that ffprobe: it
        // answers only when the flag it receives is set, as `probe_output_audio` does.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        let (prepared, reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());
        let started = std::time::Instant::now();

        let error = std::thread::scope(|scope| {
            let canceler = Arc::clone(&registry);
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                assert!(canceler.cancel("42-7"));
            });
            run_export_with(
                &slot,
                prepared,
                "42-7",
                |event| events.borrow_mut().push(event),
                |_request, _on_progress| {
                    fs::write(&reserved, b"the finished audio").unwrap();
                    Ok(exited_zero(Some(audio_snapshot())))
                },
                |_, _, cancel| {
                    let deadline = std::time::Instant::now() + Duration::from_secs(10);
                    while !cancel.load(std::sync::atomic::Ordering::SeqCst) {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "the probe never saw the run's cancel flag"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(ProbeError::Canceled)
                },
            )
            .unwrap_err()
        });

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(error.detail, None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(published(&events), 0);
        assert!(!destination.exists());
        assert!(!reserved.exists());
        assert_eq!(leftover_reservations(&directory), 0);
    }

    #[test]
    fn the_audio_check_runs_before_the_second_cancel_test() {
        // ADR 016's order, for an export without video: the success check, then the cancel
        // flag, then the publication. A cancel that arrives while ffprobe reads the output is
        // seen by the cancel test that follows the check, and nothing is published.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        let (prepared, reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());
        let probed = RefCell::new(false);

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, _on_progress| {
                fs::write(&reserved, b"the finished audio").unwrap();
                Ok(exited_zero(Some(audio_snapshot())))
            },
            |_, _, _| {
                *probed.borrow_mut() = true;
                assert!(registry.cancel("42-7"));
                Ok(output_probe(1, 0, Some("1.000000")))
            },
        )
        .unwrap_err();

        assert!(*probed.borrow(), "the check runs before the cancel test");
        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(published(&events), 0);
        assert!(!destination.exists());
        assert!(!reserved.exists());

        // A check that fails reports its own failure, even when a cancel arrived during it: the
        // check returns before the cancel test is reached.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.m4a");
        let (prepared, _reserved) = prepared_audio_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-8").unwrap();
        let error = run_export_with(
            &slot,
            prepared,
            "42-8",
            |_event| {},
            |_request, _on_progress| Ok(exited_zero(Some(audio_snapshot()))),
            |_, _, _| {
                assert!(registry.cancel("42-8"));
                Ok(output_probe(1, 0, Some("0.100000")))
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::AudioDurationMismatch);
    }

    #[test]
    fn a_plan_with_video_that_copies_no_audio_is_verified_by_its_frame_count_and_never_probed() {
        // Video and audio, and video only, keep the frame count as their success check. The
        // output probe below must never run for either. Only a plan that copies its audio reads
        // its file back (ADR 048).
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::VideoOnly] {
            let directory = TestDirectory::new();
            let destination = directory.path.join("out.mp4");
            let pending = PendingOutput::reserve(&destination).unwrap();
            let reserved = pending.path().to_path_buf();
            let prepared = PreparedExport {
                preset_id: "active".to_owned(),
                streams,
                segment_count: 1,
                plan: sample_plan(&destination),
                ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
                ffprobe: PathBuf::from("/usr/bin/ffprobe"),
                arguments: vec![],
                audio_arguments: None,
                pending,
                work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                    .unwrap(),
            };
            let registry = Arc::new(ExportRegistry::default());
            let slot = registry.begin("42-7").unwrap();

            let frames = run_export_with(
                &slot,
                prepared,
                "42-7",
                |_event| {},
                |_request, _on_progress| {
                    fs::write(&reserved, b"the finished video").unwrap();
                    Ok(exited_zero(Some(sample_snapshot(Some(30)))))
                },
                |_, _, _| {
                    unreachable!("a plan that copies no audio is verified by its frame count")
                },
            )
            .unwrap();

            assert_eq!(frames, 30, "{streams:?}");
            assert_eq!(fs::read(&destination).unwrap(), b"the finished video");
        }
    }

    /// A run that the plan of [`sample_plan`] prepares, with its work directory in `directory`.
    fn prepared_video_run(directory: &TestDirectory) -> (PreparedExport, PathBuf, PathBuf) {
        let destination = directory.path.join("out.mp4");
        let pending = PendingOutput::reserve(&destination).unwrap();
        let reserved = pending.path().to_path_buf();
        let work = ExportWorkDirectory::create(&directory.path.join("cache")).unwrap();
        let work_path = work.path().to_path_buf();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::VideoAndAudio,
            segment_count: 1,
            plan: sample_plan(&destination),
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: None,
            pending,
            work,
        };
        (prepared, reserved, work_path)
    }

    #[test]
    fn the_processes_run_in_the_work_directory_which_goes_before_the_rename() {
        // ADR 055: every export runs in its work directory, and the directory is removed when
        // the processes have ended, before the publication and the rename.
        let directory = TestDirectory::new();
        let (prepared, reserved, work_path) = prepared_video_run(&directory);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let removed_at_publishing = RefCell::new(None);

        let frames = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| {
                if matches!(event, ExportEvent::Publishing { .. }) {
                    *removed_at_publishing.borrow_mut() = Some(!work_path.exists());
                }
            },
            |request, _on_progress| {
                assert_eq!(request.working_directory, Some(work_path.as_path()));
                assert!(work_path.is_dir());
                fs::write(&reserved, b"the finished video").unwrap();
                Ok(exited_zero(Some(sample_snapshot(Some(30)))))
            },
            |_, _, _| unreachable!("a plan that copies no audio is verified by its frame count"),
        )
        .unwrap();

        assert_eq!(frames, 30);
        assert_eq!(*removed_at_publishing.borrow(), Some(true));
        assert!(!work_path.exists());
    }

    #[test]
    fn a_failed_run_and_a_dropped_run_remove_the_work_directory() {
        let directory = TestDirectory::new();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();

        // A process that does not start.
        let (prepared, _, work_path) = prepared_video_run(&directory);
        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |_request, _on_progress| Err(std::io::Error::other("no ffmpeg")),
            |_, _, _| unreachable!("the run fails before its check"),
        )
        .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::FfmpegSpawnFailed);
        assert!(!work_path.exists());

        // A process that fails.
        let (prepared, _, work_path) = prepared_video_run(&directory);
        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |_request, _on_progress| {
                Ok(ExportProcessOutcome {
                    status: ExportProcessStatus::Exited {
                        code: Some(1),
                        success: false,
                    },
                    ..exited_zero(None)
                })
            },
            |_, _, _| unreachable!("the run fails before its check"),
        )
        .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::FfmpegProcessFailed);
        assert!(!work_path.exists());

        // A cancel after preparation drops the prepared export.
        let (prepared, _, work_path) = prepared_video_run(&directory);
        drop(prepared);
        assert!(!work_path.exists());
    }

    #[test]
    fn a_preparation_that_fails_removes_its_work_directory() {
        // The work directory exists before the first source, and the revision check of the
        // source refuses it after that. The guard drops with the error.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let marked = revision_of(&source);
        fs::write(&source, b"replaced media").unwrap();
        let request = request_expecting(&source, Some(marked));
        let cache = directory.path.join("cache");
        let stage = PreparationStageCell::default();

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &cache,
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &stage,
                graph_file: &slash_graph_file,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| unreachable!(),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::SourceRevisionMismatch);
        assert!(cache.is_dir(), "preparation created the cache directory");
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    }

    #[test]
    fn a_cache_directory_that_cannot_hold_a_work_directory_fails_the_preparation() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = request_expecting(&source, None);
        // A file where the cache directory should be.
        let cache = directory.path.join("cache");
        fs::write(&cache, b"not a directory").unwrap();
        let stage = PreparationStageCell::default();

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &cache,
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &stage,
                graph_file: &slash_graph_file,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| unreachable!("no source is read without a work directory"),
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::WorkDirectoryUnavailable);
        assert!(error.detail.is_some());
        assert_eq!(stage.read(), (PreparationStage::WorkDirectory, None));
    }

    // -- the copy of the audio: the commands of a request that asks for it (ADR 048) -------

    /// What the read of the frames finds when the audio covers the segment from 10 s to 15 s.
    fn frames_covering_10_to_15() -> AudioFrames {
        let front = vec![ffmpeg::AudioGap {
            from: None,
            to: Rational::from_decimal_str("9.99").unwrap(),
        }];
        AudioFrames {
            gaps: front.clone(),
            fine_gaps: front,
            end: Rational::from_decimal_str("15.01"),
            longest_frame: Rational::new(1024, 48_000),
        }
    }

    /// Prepare a request that asks to copy the audio of the segment from 10 s to 15 s of a
    /// source with 48000 Hz AAC from 0 s to 120 s, after the read `frames`, against injected
    /// discovery, settings and probe.
    fn prepare_copy(
        directory: &TestDirectory,
        streams: ExportStreams,
        frames: AudioFrames,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_audio_mode(directory, streams, ExportAudioMode::Copy, frames)
    }

    /// [`prepare_copy`] with the audio mode `audio_mode`.
    fn prepare_audio_mode(
        directory: &TestDirectory,
        streams: ExportStreams,
        audio_mode: ExportAudioMode,
        frames: AudioFrames,
    ) -> Result<PreparedExport, ExportCommandError> {
        prepare_audio_mode_with(
            directory,
            streams,
            audio_mode,
            frames,
            &PreparationStageCell::default(),
            &slash_graph_file,
        )
    }

    /// [`prepare_audio_mode`] with the stage cell and the option probe of ADR 055 supplied.
    fn prepare_audio_mode_with(
        directory: &TestDirectory,
        streams: ExportStreams,
        audio_mode: ExportAudioMode,
        frames: AudioFrames,
        stage: &PreparationStageCell,
        graph_file: &GraphFileProbe<'_>,
    ) -> Result<PreparedExport, ExportCommandError> {
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: Pts::new(10 * 90_000),
                out_pts: Pts::new(15 * 90_000),
            }],
            segment_count: 1,
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams,
            audio_mode,
            new_batch: false,
        };
        prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path,
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage,
                graph_file,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_, _, _| Ok(sample_probe_with_a_missed_audio_start()),
            first_packet_unread,
            sample_rate_not_read,
            move |_, _, _, _| Ok(frames.clone()),
        )
    }

    /// The value that follows `flag` in `arguments`.
    fn value_of<'a>(arguments: &'a [String], flag: &str) -> &'a str {
        let index = arguments
            .iter()
            .position(|argument| argument == flag)
            .unwrap();
        &arguments[index + 1]
    }

    /// The bytes of the graph file `name` of a prepared export, after a check that a graph file
    /// holds ASCII with no byte order mark and no line end (ADR 055).
    fn graph_file_bytes(prepared: &PreparedExport, name: &str) -> Vec<u8> {
        let bytes = fs::read(prepared.work.file_path(name)).unwrap();
        assert!(bytes.is_ascii(), "{name}");
        assert!(!bytes.starts_with(b"\xEF\xBB\xBF"), "{name}");
        assert!(!bytes.ends_with(b"\n") && !bytes.ends_with(b"\r"), "{name}");
        bytes
    }

    #[test]
    fn the_encoder_and_the_audio_process_name_their_graph_files_in_the_work_directory() {
        // ADR 055: each command that carries a graph names its file with the option of the probe,
        // and the file in the work directory holds the exact output of the builder when
        // preparation ends. The prepared export holds the directory until its processes end.
        let directory = TestDirectory::new();
        let prepared = prepare_audio_mode(
            &directory,
            ExportStreams::VideoAndAudio,
            ExportAudioMode::Encode,
            frames_covering_10_to_15(),
        )
        .unwrap();
        let plan = &prepared.plan;
        assert!(plan.separate_audio_process());

        let encoder = &prepared.arguments;
        assert_eq!(value_of(encoder, "-/filter_complex"), "encoder.graph");
        assert!(!encoder.iter().any(|argument| argument == "-filter_complex"));
        let shape = choose_graph_shape(plan, prepared.pending.path());
        assert_eq!(
            graph_file_bytes(&prepared, "encoder.graph"),
            encoder_graph(plan, shape).into_bytes()
        );

        let audio = prepared.audio_arguments.as_deref().unwrap();
        assert_eq!(value_of(audio, "-/filter_complex"), "audio.graph");
        let shape = choose_audio_graph_shape(plan);
        assert_eq!(
            graph_file_bytes(&prepared, "audio.graph"),
            build_audio_graph(plan, shape).into_bytes()
        );
    }

    #[test]
    fn the_option_of_the_probe_names_the_graph_files() {
        // A build older than 7.0 reads `-filter_complex_script`, and both commands use it.
        let directory = TestDirectory::new();
        let prepared = prepare_audio_mode_with(
            &directory,
            ExportStreams::VideoAndAudio,
            ExportAudioMode::Encode,
            frames_covering_10_to_15(),
            &PreparationStageCell::default(),
            &|_, _, _| Ok(GraphFileOption::Script),
        )
        .unwrap();
        assert_eq!(
            value_of(&prepared.arguments, "-filter_complex_script"),
            "encoder.graph"
        );
        assert_eq!(
            value_of(
                prepared.audio_arguments.as_deref().unwrap(),
                "-filter_complex_script"
            ),
            "audio.graph"
        );
        assert!(!prepared
            .arguments
            .iter()
            .any(|argument| argument == "-/filter_complex"));
    }

    #[test]
    fn the_probe_runs_in_its_own_stage_on_the_ffmpeg_of_the_export() {
        let directory = TestDirectory::new();
        let stage = PreparationStageCell::default();
        let runs = Cell::new(0);
        prepare_audio_mode_with(
            &directory,
            ExportStreams::VideoOnly,
            ExportAudioMode::Encode,
            frames_covering_10_to_15(),
            &stage,
            &|ffmpeg, work, cancel| {
                runs.set(runs.get() + 1);
                assert_eq!(stage.current(), PreparationStage::GraphFile);
                assert_eq!(ffmpeg, directory.path.join("ffmpeg"));
                assert!(work.path().is_dir());
                assert!(!cancel.load(Ordering::SeqCst));
                Ok(GraphFileOption::Slash)
            },
        )
        .unwrap();
        assert_eq!(runs.get(), 1);
        assert_eq!(stage.current(), PreparationStage::Arguments);
    }

    #[test]
    fn an_audio_only_copy_runs_no_probe_and_writes_no_graph_file() {
        // ADR 048: the copy of the audio alone has no graph, so it never asks `ffmpeg` how to read
        // one (ADR 055).
        let directory = TestDirectory::new();
        let prepared = prepare_audio_mode_with(
            &directory,
            ExportStreams::AudioOnly,
            ExportAudioMode::Copy,
            frames_covering_10_to_15(),
            &PreparationStageCell::default(),
            &|_, _, _| unreachable!("a copy without a graph runs no probe"),
        )
        .unwrap();
        assert!(prepared.plan.copied_audio.is_some());
        let names: Vec<String> = fs::read_dir(prepared.work.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            !names.iter().any(|name| name.ends_with(".graph")),
            "{names:?}"
        );
    }

    #[test]
    fn a_failed_probe_gives_its_code_at_the_graph_file_stage_and_keeps_no_reservation() {
        for (code, detail) in [
            (
                ExportErrorCode::GraphFileUnsupported,
                Some("Unrecognized option 'filter_complex_script'."),
            ),
            (ExportErrorCode::FfmpegSpawnFailed, Some("no such file")),
            (
                ExportErrorCode::FfmpegProcessFailed,
                Some("the graph file probe timed out after 10 s"),
            ),
            (ExportErrorCode::Canceled, None),
        ] {
            let directory = TestDirectory::new();
            let stage = PreparationStageCell::default();
            let error = prepare_audio_mode_with(
                &directory,
                ExportStreams::VideoAndAudio,
                ExportAudioMode::Encode,
                frames_covering_10_to_15(),
                &stage,
                &|_, _, _| {
                    Err(GraphFileProbeError {
                        code,
                        detail: detail.map(str::to_owned),
                    })
                },
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.detail.as_deref(), detail);
            assert_eq!(stage.current(), PreparationStage::GraphFile);
            // The reservation and the work directory went with the failure.
            let left: Vec<String> = fs::read_dir(&directory.path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.contains(".tmp-"))
                .collect();
            assert!(left.is_empty(), "{left:?}");
            let cache: Vec<_> = fs::read_dir(directory.path.join("cache"))
                .unwrap()
                .collect();
            assert!(cache.is_empty());
        }
    }

    #[test]
    fn a_failed_write_of_a_graph_file_gives_work_directory_unavailable() {
        // A write never creates the work directory (ADR 055). The probe removes it here, so the
        // write of the graph of the encoder fails.
        let directory = TestDirectory::new();
        let error = prepare_audio_mode_with(
            &directory,
            ExportStreams::VideoOnly,
            ExportAudioMode::Encode,
            frames_covering_10_to_15(),
            &PreparationStageCell::default(),
            &|_, work, _| {
                fs::remove_dir_all(work.path()).unwrap();
                Ok(GraphFileOption::Slash)
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ExportErrorCode::WorkDirectoryUnavailable);
        assert!(error.detail.is_some());
    }

    #[test]
    fn a_copy_with_video_runs_the_copy_process_beside_the_encoder() {
        let directory = TestDirectory::new();
        let prepared = prepare_copy(
            &directory,
            ExportStreams::VideoAndAudio,
            frames_covering_10_to_15(),
        )
        .unwrap();

        assert!(prepared.plan.copied_audio.is_some());
        assert_eq!(prepared.plan.audio, None);
        // The encoder reads NUT from its stdin and copies the audio of it.
        let encoder = &prepared.arguments;
        assert!(encoder
            .windows(4)
            .any(|four| four == ["-f", "nut", "-i", "pipe:0"]));
        assert_eq!(value_of(encoder, "-c:a"), "copy");
        assert_eq!(value_of(encoder, "-/filter_complex"), ENCODER_GRAPH_FILE);
        // The copy process cuts at the In and Out points and writes NUT to its stdout.
        let copy = prepared.audio_arguments.as_deref().unwrap();
        assert_eq!(value_of(copy, "-c:a"), "copy");
        assert_eq!(value_of(copy, "-to"), "15");
        assert_eq!(copy[copy.len() - 3..], ["-f", "nut", "pipe:1"]);
        assert!(!copy
            .iter()
            .any(|argument| argument.contains("filter_complex")));
    }

    #[test]
    fn an_audio_only_copy_runs_one_command_without_a_graph_into_the_reservation() {
        let directory = TestDirectory::new();
        let prepared = prepare_copy(
            &directory,
            ExportStreams::AudioOnly,
            frames_covering_10_to_15(),
        )
        .unwrap();

        assert!(prepared.plan.copied_audio.is_some());
        assert_eq!(prepared.audio_arguments, None);
        let command = &prepared.arguments;
        assert!(!command
            .iter()
            .any(|argument| argument.contains("filter_complex")));
        assert_eq!(value_of(command, "-c:a"), "copy");
        assert_eq!(value_of(command, "-to"), "15");
        assert_eq!(value_of(command, "-f"), "mp4");
        assert_eq!(
            command.last().map(PathBuf::from),
            Some(prepared.pending.path().to_path_buf())
        );
    }

    #[test]
    fn a_request_to_encode_encodes_where_a_copy_would_be_possible() {
        let directory = TestDirectory::new();
        let prepared = prepare_audio_mode(
            &directory,
            ExportStreams::VideoAndAudio,
            ExportAudioMode::Encode,
            frames_covering_10_to_15(),
        )
        .unwrap();

        assert_eq!(prepared.plan.copied_audio, None);
        assert_eq!(prepared.plan.audio_copy_refusal, None);
        assert!(prepared
            .arguments
            .windows(4)
            .any(|four| four == ["-f", "wav", "-i", "pipe:0"]));
        assert_eq!(value_of(&prepared.arguments, "-c:a"), "aac");
    }

    #[test]
    fn a_copy_that_the_plan_refuses_prepares_the_encode() {
        // The read found no frame inside the segment, so the export encodes the audio in the
        // audio process of ADR 043, as without the request.
        let directory = TestDirectory::new();
        let prepared = prepare_copy(
            &directory,
            ExportStreams::VideoAndAudio,
            AudioFrames::default(),
        )
        .unwrap();

        assert_eq!(prepared.plan.copied_audio, None);
        assert_eq!(
            prepared.plan.audio_copy_refusal,
            Some(crate::ffmpeg::export::copy::CopyRefusal::NoFrames)
        );
        assert!(prepared.plan.audio.is_some());
        assert!(prepared
            .arguments
            .windows(4)
            .any(|four| four == ["-f", "wav", "-i", "pipe:0"]));
        let audio = prepared.audio_arguments.as_deref().unwrap();
        assert_eq!(value_of(audio, "-c:a"), "pcm_f32le");
    }

    /// Run a real export of the segment from 1 s to 2.5 s of `source` that asks to copy the audio,
    /// with `streams`, into `output`, and return the codec of its audio and its number of audio
    /// packets.
    fn real_copy(
        ffmpeg: &Path,
        ffprobe: &Path,
        directory: &TestDirectory,
        source: &Path,
        streams: ExportStreams,
        output: &Path,
    ) -> (String, usize) {
        let probe = ffmpeg::probe_media(ffprobe, source).unwrap();
        let tb = probe.video_time_base;
        let at = |millis: i64| Pts::new(millis * tb.den() / (1_000 * tb.num()));
        // An encode would write AC-3, so AAC in the output can only be the copy.
        let mut preset = sample_preset("active");
        preset.audio_encoder = "ac3".to_owned();
        preset.quality = Quality {
            kind: QualityKind::Crf,
            value: 30,
        };
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: at(1_000),
                out_pts: at(2_500),
            }],
            segment_count: 1,
            output_path: output.to_string_lossy().into_owned(),
            preset,
            streams,
            audio_mode: ExportAudioMode::Copy,
            new_batch: false,
        };
        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path.join("app"),
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &slash_graph_file,
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
        )
        .unwrap();
        assert_eq!(prepared.plan.audio_copy_refusal, None, "{streams:?}");
        assert!(prepared.plan.copied_audio.is_some());

        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |request, on_progress| run_export_process(request, on_progress),
            ffmpeg::probe_output_audio,
        )
        .unwrap();

        let answer = crate::procutil::command_without_console(ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=codec_name:packet=size",
                "-of",
                "csv=p=0",
            ])
            .arg(output)
            .output()
            .unwrap();
        // One line for the stream, its codec, and one line for each packet, its size. A packet
        // with side data ends its line with an empty field.
        let text = String::from_utf8(answer.stdout).unwrap();
        let fields: Vec<&str> = text
            .lines()
            .map(|line| line.trim().trim_end_matches(','))
            .filter(|line| !line.is_empty())
            .collect();
        let packets = fields
            .iter()
            .filter(|field| field.parse::<u64>().is_ok())
            .count();
        let codec = fields
            .iter()
            .find(|field| field.parse::<u64>().is_err())
            .copied()
            .unwrap_or_default()
            .to_owned();
        (codec, packets)
    }

    #[test]
    fn a_real_copy_of_one_segment_writes_the_aac_of_the_source() {
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let flv = directory.path.join("source.flv");
        write_real_flv(&ffmpeg, &flv, "160x90", 48_000);
        let mp4 = directory.path.join("source.mp4");
        let status = crate::procutil::command_without_console(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&flv)
            .args(["-c", "copy", "-f", "mp4"])
            .arg(&mp4)
            .status()
            .unwrap();
        assert!(status.success());

        for source in [&mp4, &flv] {
            for (streams, name) in [
                (ExportStreams::VideoAndAudio, "out.mp4"),
                (ExportStreams::AudioOnly, "out.m4a"),
            ] {
                let output = directory.path.join(name);
                let (codec, packets) =
                    real_copy(&ffmpeg, &ffprobe, &directory, source, streams, &output);
                // 1.5 s of 1024-sample AAC at 48000 Hz is 70.3 packets; each end can add or lose
                // one.
                assert_eq!(codec, "aac", "{source:?} {streams:?} {packets}");
                assert!(
                    (69..=72).contains(&packets),
                    "{source:?} {streams:?}: {packets} packets"
                );
            }
        }
    }

    /// Export `source` from 1.0 s to 2.5 s to `output` with the gain `tenths_db`, encoding FLAC
    /// in Matroska so that the levels compare without a lossy step, and return the RMS level and
    /// the peak level in dB and the number of samples of the output, as `astats` measures them.
    fn real_gained_export(
        ffmpeg: &Path,
        ffprobe: &Path,
        directory: &TestDirectory,
        source: &Path,
        streams: ExportStreams,
        output: &Path,
        tenths_db: i32,
    ) -> (f64, f64, u64) {
        let probe = ffmpeg::probe_media(ffprobe, source).unwrap();
        let tb = probe.video_time_base;
        let at = |millis: i64| Pts::new(millis * tb.den() / (1_000 * tb.num()));
        let mut preset = sample_preset("active");
        preset.container = Container::Mkv;
        preset.audio_encoder = "flac".to_owned();
        preset.audio_bitrate = None;
        preset.audio_gain_tenths_db = tenths_db;
        preset.quality = Quality {
            kind: QualityKind::Crf,
            value: 30,
        };
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![ExportPieceWire {
                source_id: "source".to_owned(),
                in_pts: at(1_000),
                out_pts: at(2_500),
            }],
            segment_count: 1,
            output_path: output.to_string_lossy().into_owned(),
            preset,
            streams,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
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
        )
        .unwrap();
        assert_eq!(
            prepared.audio_arguments.is_some(),
            streams == ExportStreams::VideoAndAudio,
            "an export with video writes its audio in a second process (ADR 043)"
        );

        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |request, on_progress| run_export_process(request, on_progress),
            ffmpeg::probe_output_audio,
        )
        .unwrap();

        let answer = crate::procutil::command_without_console(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-i"])
            .arg(output)
            .args([
                "-map",
                "0:a",
                "-af",
                "astats=measure_perchannel=none:measure_overall=RMS_level+Peak_level+Number_of_samples",
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        assert!(answer.status.success());
        let log = String::from_utf8_lossy(&answer.stderr).into_owned();
        let value = |name: &str| -> String {
            log.lines()
                .find_map(|line| line.split_once(&format!("{name}: ")).map(|(_, v)| v.trim()))
                .unwrap_or_else(|| panic!("astats wrote no {name}: {log}"))
                .to_owned()
        };
        (
            value("RMS level dB").parse().unwrap(),
            value("Peak level dB").parse().unwrap(),
            value("Number of samples").parse().unwrap(),
        )
    }

    #[test]
    fn a_real_export_lowers_the_audio_by_the_gain_of_the_preset() {
        // ADR 054: one `volume` behind `concat`, in the audio process of an export with video and
        // in the one process of an export without video. FLAC keeps the samples, so the levels
        // fall by the gain within rounding, and the length does not change.
        let Some((ffmpeg, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("source.flv");
        write_real_flv(&ffmpeg, &source, "160x90", 48_000);

        for (streams, name) in [
            (ExportStreams::VideoAndAudio, "mkv"),
            (ExportStreams::AudioOnly, "mka"),
        ] {
            let measure = |tenths_db: i32| {
                let output = directory.path.join(format!("out{tenths_db}.{name}"));
                real_gained_export(
                    &ffmpeg, &ffprobe, &directory, &source, streams, &output, tenths_db,
                )
            };
            let (rms, peak, samples) = measure(0);
            let (gained_rms, gained_peak, gained_samples) = measure(-10);
            assert_eq!(gained_samples, samples, "{streams:?}");
            assert!(
                (rms - gained_rms - 1.0).abs() < 0.05,
                "{streams:?}: RMS {rms} dB, then {gained_rms} dB"
            );
            assert!(
                (peak - gained_peak - 1.0).abs() < 0.05,
                "{streams:?}: peak {peak} dB, then {gained_peak} dB"
            );
        }
    }

    // -- the copy of the audio: the stream check of an export with video (ADR 048) ---------

    /// A run of the one-second sample plan with video that copies its audio, ready for
    /// [`run_export_with`], and the reserved path it writes.
    fn prepared_copy_run(destination: &Path) -> (PreparedExport, PathBuf) {
        let pending = PendingOutput::reserve(destination).unwrap();
        let reserved = pending.path().to_path_buf();
        let mut plan = sample_plan(destination);
        plan.copied_audio = Some(crate::ffmpeg::export::CopiedAudio {
            stream_index: 1,
            start: Rational::new(0, 1).unwrap(),
            end: Rational::new(1, 1).unwrap(),
            adts_to_asc: false,
        });
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::VideoAndAudio,
            segment_count: 1,
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: Some(vec![]),
            pending,
            work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                .unwrap(),
        };
        (prepared, reserved)
    }

    /// Run the copy plan with video over a destination that already holds a previous export: the
    /// process exits zero after `frames` frames, and the output probe answers `answer`. Returns
    /// the result, the number of `publishing` events, whether the probe ran, and the contents of
    /// the destination afterwards.
    fn copy_run(
        frames: u64,
        answer: Result<OutputAudioProbe, ProbeError>,
    ) -> (Result<u64, ExportCommandError>, usize, bool, Vec<u8>) {
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.mp4");
        fs::write(&destination, b"a previous export").unwrap();
        let (prepared, reserved) = prepared_copy_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());
        let probed = Cell::new(false);

        let result = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, _on_progress| {
                fs::write(&reserved, b"the finished video").unwrap();
                Ok(exited_zero(Some(sample_snapshot(Some(frames)))))
            },
            |_, file, _| {
                // The check reads the reservation, before the publication.
                assert_eq!(file, reserved);
                assert_eq!(published(&events), 0);
                probed.set(true);
                answer
            },
        );
        assert!(!reserved.exists());
        assert_eq!(leftover_reservations(&directory), 0);
        let contents = fs::read(&destination).unwrap();
        (result, published(&events), probed.get(), contents)
    }

    #[test]
    fn a_copy_with_both_streams_is_published_after_the_frame_count_and_the_stream_check() {
        let (result, publishing, probed, contents) =
            copy_run(30, Ok(output_probe(1, 1, Some("1.010000"))));

        assert_eq!(result.unwrap(), 30);
        assert!(probed);
        assert_eq!(publishing, 1);
        assert_eq!(contents, b"the finished video");
    }

    #[test]
    fn a_copy_whose_file_lost_a_stream_is_not_published() {
        for (audio, video) in [(0, 1), (1, 0), (2, 1), (0, 0)] {
            let (result, publishing, probed, contents) =
                copy_run(30, Ok(output_probe(audio, video, Some("1.000000"))));

            let error = result.unwrap_err();
            assert_eq!(
                error.code,
                ExportErrorCode::OutputStreamsMismatch,
                "{audio} audio, {video} video"
            );
            assert_eq!(error.detail.as_deref(), Some("stderr tail"));
            assert!(probed);
            assert_eq!(publishing, 0);
            assert_eq!(contents, b"a previous export");
        }
    }

    #[test]
    fn a_copy_that_lost_frames_fails_on_its_frame_count_without_probing() {
        let (result, publishing, probed, contents) =
            copy_run(29, Ok(output_probe(1, 1, Some("1.000000"))));

        assert_eq!(
            result.unwrap_err().code,
            ExportErrorCode::FrameCountMismatch
        );
        assert!(!probed);
        assert_eq!(publishing, 0);
        assert_eq!(contents, b"a previous export");
    }

    #[test]
    fn a_failed_read_of_a_copy_is_reported_by_where_the_fault_is() {
        // A fault in the file is a wrong output, with the stderr of ffmpeg. A cancel is a cancel.
        // A fault of ffprobe keeps its own code.
        let (result, ..) = copy_run(
            30,
            Err(ProbeError::ProcessFailed {
                code: Some(1),
                stderr: b"moov atom not found".to_vec(),
            }),
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::OutputStreamsMismatch);
        assert_eq!(error.detail.as_deref(), Some("stderr tail"));

        let (result, publishing, _, contents) = copy_run(30, Err(ProbeError::Canceled));
        assert_eq!(result.unwrap_err().code, ExportErrorCode::Canceled);
        assert_eq!(publishing, 0);
        assert_eq!(contents, b"a previous export");

        let (result, publishing, _, contents) = copy_run(
            30,
            Err(ProbeError::TimedOut {
                timeout: std::time::Duration::from_secs(30),
                stderr: Vec::new(),
            }),
        );
        assert_eq!(result.unwrap_err().code, ExportErrorCode::FfprobeTimedOut);
        assert_eq!(publishing, 0);
        assert_eq!(contents, b"a previous export");
    }

    #[test]
    fn a_cancel_during_the_stream_check_of_a_copy_publishes_nothing() {
        // The cancel arrives while ffprobe reads a correct file. The second cancel test of ADR 016
        // runs after the check, so the run ends as canceled.
        let directory = TestDirectory::new();
        let destination = directory.path.join("out.mp4");
        let (prepared, reserved) = prepared_copy_run(&destination);
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        let events: RefCell<Vec<ExportEvent>> = RefCell::new(Vec::new());

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |event| events.borrow_mut().push(event),
            |_request, _on_progress| {
                fs::write(&reserved, b"the finished video").unwrap();
                Ok(exited_zero(Some(sample_snapshot(Some(30)))))
            },
            |_, _, _| {
                registry.cancel("42-7");
                Ok(output_probe(1, 1, Some("1.000000")))
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::Canceled);
        assert_eq!(published(&events), 0);
        assert!(!destination.exists());
        assert!(!reserved.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_rename_failure_with_no_operating_system_code_carries_no_detail() {
        // `fsutil::replace_file_within` manufactures exactly one error: the Unix refusal to
        // overwrite a read-only destination (ADR 015). No system call ran, so it carries no raw
        // operating-system code, and its message is Rust-authored English that ADR 011 keeps out
        // of the interface. Without the guard on this mapping that sentence reaches the frontend
        // as `detail` and is shown to the user untranslated.
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let destination = directory.path.join("out.mp4");
        fs::write(&destination, b"protected contents").unwrap();
        let plan = sample_plan(&destination);
        let pending = PendingOutput::reserve(&destination).unwrap();
        let reserved = pending.path().to_path_buf();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o444)).unwrap();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::VideoAndAudio,
            segment_count: 1,
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            audio_arguments: None,
            pending,
            work: ExportWorkDirectory::create(&destination.parent().unwrap().join("cache"))
                .unwrap(),
        };
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();

        let error = run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |_request, _on_progress| {
                Ok(ExportProcessOutcome {
                    status: ExportProcessStatus::Exited {
                        code: Some(0),
                        success: true,
                    },
                    stderr: Vec::new(),
                    last_progress: Some(sample_snapshot(Some(30))),
                })
            },
            |_, _, _| unreachable!("a plan with video is verified by its frame count"),
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::OutputRenameFailed);
        assert_eq!(
            error.detail, None,
            "a synthetic error's Rust-authored message must not reach the interface"
        );
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"protected contents",
            "the protected destination must keep its contents"
        );
        assert!(
            !reserved.exists(),
            "a failed commit must still remove the reservation"
        );
    }

    // -- several sources with real ffmpeg (ADR 053) ------------------------------------------

    /// Write the media file `path` with ffmpeg from `arguments`, which name the inputs, the
    /// encoders and the muxer.
    fn write_fixture(ffmpeg: &Path, path: &Path, arguments: &[&str]) {
        let status = crate::procutil::command_without_console(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(arguments)
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "{path:?}");
    }

    /// The four sources of ADR 053's test, 2 s each, in `directory`:
    ///
    /// - `a`: 1920x1080 at 30 fps with 48 kHz stereo audio.
    /// - `b`: 1280x720 at 60 fps without audio.
    /// - `c`: 1080x1920, stored as 1920x1080 with a display rotation of 90 degrees.
    /// - `d`: anamorphic 720x480 at a SAR of 32:27 and 30000/1001 fps, with 44.1 kHz mono audio.
    fn write_mixed_sources(ffmpeg: &Path, directory: &Path) -> [PathBuf; 4] {
        let video = [
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ];
        let a = directory.join("a.mp4");
        let mut arguments = vec![
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "2",
            "-ac",
            "2",
            "-c:a",
            "aac",
        ];
        arguments.extend(video);
        write_fixture(ffmpeg, &a, &arguments);

        let b = directory.join("b.mp4");
        let mut arguments = vec![
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=60",
            "-t",
            "2",
        ];
        arguments.extend(video);
        write_fixture(ffmpeg, &b, &arguments);

        let upright = directory.join("c-upright.mp4");
        let mut arguments = vec![
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30",
            "-t",
            "2",
        ];
        arguments.extend(video);
        write_fixture(ffmpeg, &upright, &arguments);
        let c = directory.join("c.mp4");
        write_fixture(
            ffmpeg,
            &c,
            &[
                "-display_rotation",
                "90",
                "-i",
                &upright.to_string_lossy(),
                "-c",
                "copy",
            ],
        );

        let d = directory.join("d.mp4");
        let mut arguments = vec![
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=720x480:rate=30000/1001",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:sample_rate=44100",
            "-t",
            "2",
            "-vf",
            "setsar=32/27",
            "-ac",
            "1",
            "-c:a",
            "aac",
        ];
        arguments.extend(video);
        write_fixture(ffmpeg, &d, &arguments);
        [a, b, c, d]
    }

    /// Export `pieces`, each a source, an In point and an Out point in milliseconds, of the
    /// sources `sources`, with real ffmpeg, to `output`, and return the prepared plan's expected
    /// frames and the frames the run wrote.
    fn real_export_of_pieces(
        tools: &(PathBuf, PathBuf),
        directory: &TestDirectory,
        sources: &[&Path],
        pieces: &[(usize, i64, i64)],
        preset: Preset,
        streams: ExportStreams,
        output: &Path,
    ) -> (Option<u64>, u64) {
        let (ffmpeg, ffprobe) = tools;
        let at = |source: usize, millis: i64| {
            let probe = ffmpeg::probe_media(ffprobe, sources[source]).unwrap();
            let tb = probe.video_time_base;
            let ticks = Rational::new(millis, 1000)
                .and_then(|seconds| seconds.div(tb))
                .unwrap();
            assert_eq!(ticks.den(), 1, "{millis} ms is a whole number of ticks");
            Pts::new(ticks.num())
        };
        let request = ExportRequestWire {
            sources: sources
                .iter()
                .enumerate()
                .map(|(index, path)| ExportSourceWire {
                    id: format!("source-{index}"),
                    path: path.to_string_lossy().into_owned(),
                    expected_revision: None,
                })
                .collect(),
            pieces: pieces
                .iter()
                .map(|(source, from, to)| ExportPieceWire {
                    source_id: format!("source-{source}"),
                    in_pts: at(*source, *from),
                    out_pts: at(*source, *to),
                })
                .collect(),
            segment_count: 1,
            output_path: output.to_string_lossy().into_owned(),
            preset,
            streams,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path.join("app"),
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                graph_file: &probe_graph_file_option,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: ffmpeg.clone(),
                    ffprobe: ffprobe.clone(),
                    origin: ExecutableOrigin::Path,
                })
            },
            ffmpeg::probe_media_until_canceled,
            ffmpeg::probe_first_audio_packet,
            ffmpeg::probe_audio_sample_rate_at,
            ffmpeg::probe_audio_gaps,
        )
        .unwrap();
        let expected = prepared.plan.expected_frames();
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("42-7").unwrap();
        // The run compares the frames that ffmpeg wrote with the expected count, and fails with
        // `frameCountMismatch` when they differ.
        let frames = run_export_with(
            &slot,
            prepared,
            "42-7",
            |_event| {},
            |request, on_progress| run_export_process(request, on_progress),
            ffmpeg::probe_output_audio,
        )
        .unwrap();
        (expected, frames)
    }

    /// What ffprobe reads of the streams of a finished export.
    #[derive(Debug, Default)]
    struct OutputStreams {
        width: u32,
        height: u32,
        frame_rate: String,
        frames: u64,
        video_seconds: f64,
        audio_seconds: Option<f64>,
        sample_rate: Option<u32>,
        channels: Option<u32>,
    }

    /// Read the streams of `output` with ffprobe, counting the decoded video frames.
    fn read_output_streams(ffprobe: &Path, output: &Path) -> OutputStreams {
        let answer = crate::procutil::command_without_console(ffprobe)
            .args([
                "-v",
                "error",
                "-count_frames",
                "-show_entries",
                "stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration,\
                 sample_rate,channels",
                "-of",
                "json",
            ])
            .arg(output)
            .output()
            .unwrap();
        assert!(answer.status.success());
        let value: serde_json::Value = serde_json::from_slice(&answer.stdout).unwrap();
        let text = |stream: &serde_json::Value, key: &str| {
            stream[key].as_str().map(str::to_owned).unwrap_or_default()
        };
        let mut streams = OutputStreams::default();
        for stream in value["streams"].as_array().unwrap() {
            match stream["codec_type"].as_str() {
                Some("video") => {
                    streams.width = u32::try_from(stream["width"].as_u64().unwrap()).unwrap();
                    streams.height = u32::try_from(stream["height"].as_u64().unwrap()).unwrap();
                    streams.frame_rate = text(stream, "r_frame_rate");
                    streams.frames = text(stream, "nb_read_frames").parse().unwrap();
                    streams.video_seconds = text(stream, "duration").parse().unwrap();
                }
                Some("audio") => {
                    streams.audio_seconds = text(stream, "duration").parse().ok();
                    streams.sample_rate = text(stream, "sample_rate").parse().ok();
                    streams.channels = stream["channels"]
                        .as_u64()
                        .and_then(|count| u32::try_from(count).ok());
                }
                _ => {}
            }
        }
        streams
    }

    #[test]
    fn a_real_export_of_four_sources_fits_one_canvas_one_rate_and_one_audio_format() {
        let Some(tools) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let sources = write_mixed_sources(&tools.0, &directory.path);
        let sources: Vec<&Path> = sources.iter().map(PathBuf::as_path).collect();
        let output = directory.path.join("mixed.mp4");
        let mut preset = sample_preset("active");
        preset.audio_sample_rate = AudioSampleRateSetting::Source;
        preset.audio_channels = AudioChannels::Source;
        // `a` and `c` have the same display area, and `a` comes first: a landscape canvas of
        // 1920x1080. The highest rate is the 60 fps of `b`. The audio takes the 48 kHz of `a` and
        // its two channels, the most of the sources; `b` and `c` write silence.
        let (expected, frames) = real_export_of_pieces(
            &tools,
            &directory,
            &sources,
            &[
                (0, 0, 1_000),
                (2, 500, 1_500),
                (3, 0, 1_001),
                (1, 250, 1_250),
            ],
            preset,
            ExportStreams::VideoAndAudio,
            &output,
        );
        // 60 frames for each piece of 1 s, and 1001 ms of `d` at 60 fps is 60.06, which rounds to 60.
        assert_eq!(expected, Some(240));
        assert_eq!(frames, 240);
        let streams = read_output_streams(&tools.1, &output);
        assert_eq!((streams.width, streams.height), (1920, 1080), "{streams:?}");
        assert_eq!(streams.frame_rate, "60/1", "{streams:?}");
        assert_eq!(streams.frames, 240, "{streams:?}");
        assert_eq!(streams.sample_rate, Some(48_000), "{streams:?}");
        assert_eq!(streams.channels, Some(2), "{streams:?}");
        let audio = streams.audio_seconds.expect("the export writes audio");
        assert!(
            (audio - streams.video_seconds).abs() <= 1.0 / 60.0,
            "{streams:?}"
        );
        // The rotated piece, from 1 s to 2 s of the output, is fitted, not stretched: 608 pixels
        // wide at x = 656, with black bars beside it. The column at x = 100 lies in the bar, so
        // its luma is black on every row; a stretched picture would put the test pattern there.
        let column = crate::procutil::command_without_console(&tools.0)
            .args(["-v", "error", "-ss", "1.5", "-i"])
            .arg(&output)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "crop=1:1080:100:0,format=gray",
                "-f",
                "rawvideo",
                "-",
            ])
            .output()
            .unwrap();
        assert!(column.status.success());
        assert_eq!(column.stdout.len(), 1080);
        assert!(
            column.stdout.iter().all(|luma| *luma <= 32),
            "the pillarbox is not black: {:?}",
            column.stdout.iter().max()
        );
    }

    #[test]
    fn a_real_export_rounds_a_half_frame_of_a_slower_source_as_the_plan_counts_it() {
        // Three frames of 24 fps last 1/8 s, which is 7.5 frames at 60 fps. The plan rounds each
        // piece on its own, half away from zero, to 8, and the end of `fps` must agree, or the
        // run fails with `frameCountMismatch`. Two such pieces expect 16, and a single source of
        // 24 fps in a preset of 60 fps does the same.
        let Some(tools) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let film = directory.path.join("film.mp4");
        write_fixture(
            &tools.0,
            &film,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ],
        );
        let fast = directory.path.join("fast.mp4");
        write_fixture(
            &tools.0,
            &fast,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=60",
                "-t",
                "2",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ],
        );
        let output = directory.path.join("rounded.mp4");
        let (expected, frames) = real_export_of_pieces(
            &tools,
            &directory,
            &[&film, &fast],
            &[(0, 125, 250), (1, 0, 500), (0, 1_000, 1_125)],
            sample_preset("active"),
            ExportStreams::VideoAndAudio,
            &output,
        );
        assert_eq!(expected, Some(46));
        assert_eq!(frames, 46);
        let streams = read_output_streams(&tools.1, &output);
        assert_eq!(streams.frame_rate, "60/1", "{streams:?}");
        assert_eq!(streams.frames, 46, "{streams:?}");
        let audio = streams.audio_seconds.expect("the export writes audio");
        assert!(
            (audio - streams.video_seconds).abs() <= 1.0 / 60.0,
            "{streams:?}"
        );

        let mut preset = sample_preset("active");
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(60, 1).unwrap());
        let single = directory.path.join("single.mp4");
        let (expected, frames) = real_export_of_pieces(
            &tools,
            &directory,
            &[&film],
            &[(0, 125, 250), (0, 1_000, 1_125)],
            preset,
            ExportStreams::VideoOnly,
            &single,
        );
        assert_eq!((expected, frames), (Some(16), 16));
    }

    #[test]
    fn a_real_export_converts_a_4_2_2_source_with_the_lanczos_scaler() {
        // The `format` of the graph converts 4:2:2 to 4:2:0 with a scaler that ffmpeg inserts by
        // itself. Without the scaler flags of the graph, that scaler is bicubic: ffmpeg 9.0.2 logs
        // `auto_scale_0` with `flags:0x00000004`. The command of the export runs here at the debug
        // log level, and every scaler that ffmpeg inserts must use the flags of the graph.
        let Some((ffmpeg_path, ffprobe)) = real_tools() else {
            return;
        };
        let directory = TestDirectory::new();
        let source = directory.path.join("422.mp4");
        write_fixture(
            &ffmpeg_path,
            &source,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=25",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv422p",
            ],
        );
        let probe = ffmpeg::probe_media(&ffprobe, &source).unwrap();
        let end = Rational::new(1, 2)
            .and_then(|seconds| seconds.div(probe.video_time_base))
            .unwrap();
        let request = ExportRequestWire {
            sources: vec![ExportSourceWire {
                id: "source".to_owned(),
                path: source.to_string_lossy().into_owned(),
                expected_revision: None,
            }],
            pieces: vec![piece("source", 0, end.num())],
            segment_count: 1,
            output_path: directory
                .path
                .join("420.mp4")
                .to_string_lossy()
                .into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoOnly,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        };
        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
                app_data_directory: &directory.path.join("app"),
                cache_directory: &directory.path.join("cache"),
                cancel: &AtomicBool::new(false),
                preview_windows: &PreviewWindows::default(),
                stage: &PreparationStageCell::default(),
                // The real option probe of ADR 055, on the real `ffmpeg`.
                graph_file: &probe_graph_file_option,
            },
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: ffmpeg_path.clone(),
                    ffprobe: ffprobe.clone(),
                    origin: ExecutableOrigin::Path,
                })
            },
            ffmpeg::probe_media_until_canceled,
            ffmpeg::probe_first_audio_packet,
            ffmpeg::probe_audio_sample_rate_at,
            ffmpeg::probe_audio_gaps,
        )
        .unwrap();
        let mut arguments = prepared.arguments.clone();
        let level = arguments.iter().position(|a| a == "-loglevel").unwrap() + 1;
        arguments[level] = "debug".to_owned();
        // The command names its graph file by its name alone, so it runs in the work directory.
        let answer = crate::procutil::command_without_console(&ffmpeg_path)
            .args(&arguments)
            .current_dir(prepared.work.path())
            .output()
            .unwrap();
        assert!(answer.status.success());
        let log = String::from_utf8_lossy(&answer.stderr);
        let scalers: Vec<&str> = log
            .lines()
            .filter(|line| line.contains("auto_scale") && line.contains("flags:"))
            .collect();
        assert!(!scalers.is_empty(), "the conversion inserts a scaler");
        // ffmpeg 9.0.2 writes the flags as a number here: 0x00042200 is `lanczos` (0x200),
        // `full_chroma_int` (0x2000) and `accurate_rnd` (0x40000). Another build can write their
        // names.
        for line in scalers {
            assert!(!line.contains("flags:0x00000004"), "{line}");
            assert!(
                line.contains("flags:0x00042200") || line.contains("lanczos"),
                "{line}"
            );
        }
    }

    // -- several sources: the request and the preparation (ADR 053) --------------------------

    /// A request of the sources `sources`, each an id and a path, and the pieces `pieces`, each
    /// a source id and an interval in ticks of 1/90000.
    fn request_of(sources: &[(&str, &Path)], pieces: &[(&str, i64, i64)]) -> ExportRequestWire {
        let output = sources
            .first()
            .map(|(_, path)| path.with_file_name("out.mp4"))
            .unwrap_or_else(|| PathBuf::from("/movies/out.mp4"));
        ExportRequestWire {
            sources: sources
                .iter()
                .map(|(id, path)| ExportSourceWire {
                    id: (*id).to_owned(),
                    path: path.to_string_lossy().into_owned(),
                    expected_revision: None,
                })
                .collect(),
            pieces: pieces
                .iter()
                .map(|(id, from, to)| piece(id, *from, *to))
                .collect(),
            segment_count: 1,
            output_path: output.to_string_lossy().into_owned(),
            preset: sample_preset("active"),
            streams: ExportStreams::VideoAndAudio,
            audio_mode: ExportAudioMode::Encode,
            new_batch: false,
        }
    }

    #[test]
    fn the_request_orders_its_sources_by_their_first_piece() {
        let a = Path::new("/media/a.mp4");
        let b = Path::new("/media/b.mp4");
        let request = request_of(
            &[("a", a), ("b", b)],
            &[("b", 0, 90_000), ("a", 0, 90_000), ("b", 90_000, 180_000)],
        );
        let resolved = resolve_request(&request).unwrap();
        let ids: Vec<&str> = resolved
            .sources
            .iter()
            .map(|source| source.id.as_str())
            .collect();
        assert_eq!(ids, vec!["b", "a"]);
        let sources: Vec<usize> = resolved.pieces.iter().map(|piece| piece.source).collect();
        assert_eq!(sources, vec![0, 1, 0]);
        assert_eq!(resolved.pieces_of(0).len(), 2);
        assert_eq!(resolved.pieces[2].in_pts, Pts::new(90_000));
    }

    #[test]
    fn a_request_whose_sources_do_not_match_its_pieces_is_refused_with_a_code() {
        let a = Path::new("/media/a.mp4");
        let b = Path::new("/media/b.mp4");
        let refused = |request: ExportRequestWire| resolve_request(&request).unwrap_err();
        let invalid = |detail: &str| {
            ExportCommandError::with_detail(ExportErrorCode::InvalidSources, detail.to_owned())
        };

        assert_eq!(
            refused(request_of(&[("a", a)], &[])).code,
            ExportErrorCode::NoSegments
        );
        let many: Vec<(&str, i64, i64)> = (0..=MAX_EXPORT_SEGMENTS)
            .map(|_| ("a", 0, 90_000))
            .collect();
        assert_eq!(
            refused(request_of(&[("a", a)], &many)).code,
            ExportErrorCode::TooManySegments
        );
        // Each further source lowers the limit by one (ADR 053): the pieces that one source may
        // hold are too many for two.
        let two: Vec<(&str, i64, i64)> = (0..max_export_pieces(1))
            .map(|index| (["a", "b"][index % 2], 0, 90_000))
            .collect();
        assert_eq!(
            refused(request_of(&[("a", a), ("b", b)], &two)).code,
            ExportErrorCode::TooManySegments
        );
        assert!(resolve_request(&request_of(
            &[("a", a), ("b", b)],
            &two[..max_export_pieces(2)]
        ))
        .is_ok());
        assert_eq!(
            refused(request_of(&[], &[("a", 0, 1)])),
            invalid("no source")
        );
        assert_eq!(
            refused(request_of(&[("", a)], &[("", 0, 1)])),
            invalid("empty source id")
        );
        assert_eq!(
            refused(request_of(&[("a", a), ("a", b)], &[("a", 0, 1)])),
            invalid("duplicate source id: a")
        );
        assert_eq!(
            refused(request_of(&[("a", a)], &[("a", 0, 1), ("c", 0, 1)])),
            invalid("unknown source id: c")
        );
        assert_eq!(
            refused(request_of(&[("a", a), ("b", b)], &[("a", 0, 1)])),
            invalid("unused source id: b")
        );

        // The segment count lies between 1 and the number of pieces.
        let mut request = request_of(&[("a", a)], &[("a", 0, 1), ("a", 1, 2)]);
        for count in [0, 3] {
            request.segment_count = count;
            assert_eq!(
                refused(request.clone()).code,
                ExportErrorCode::InvalidSegmentCount
            );
        }
        request.segment_count = 2;
        assert!(resolve_request(&request).is_ok());

        assert_eq!(
            refused(request_of(&[("a", a)], &[("a", 5, 5)])).code,
            ExportErrorCode::InvalidSegment
        );
    }

    #[test]
    fn the_run_reports_the_segment_count_of_the_request_and_not_its_pieces() {
        let a = Path::new("/media/a.mp4");
        let mut request = request_of(&[("a", a)], &[("a", 0, 1), ("a", 1, 2), ("a", 2, 3)]);
        request.segment_count = 2;
        assert_eq!(run_facts(&request).segment_count, 2);
    }

    #[test]
    fn preparation_runs_once_for_each_source_in_the_order_of_its_first_piece() {
        let directory = TestDirectory::new();
        let first = directory.path.join("first.mp4");
        let second = directory.path.join("second.mov");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second media").unwrap();
        let mut request = request_of(
            &[("first", &first), ("second", &second)],
            &[
                ("second", 0, 90_000),
                ("first", 0, 90_000),
                ("second", 90_000, 180_000),
            ],
        );
        request.segment_count = 2;
        let probed: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
        let reads: RefCell<Vec<(PathBuf, usize)>> = RefCell::new(Vec::new());
        let mut with_audio = sample_probe();
        with_audio.audio = Some(AudioProbe {
            index: 1,
            codec: Some("aac".to_owned()),
            sample_rate: Some(48_000),
            channels: Some(2),
            start_time: None,
            duration: None,
            tagged_end: None,
            channel_layout: Some("stereo".to_owned()),
            reported_packets: None,
            holds_no_packets: false,
        });

        let prepared = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, source, _| {
                probed.borrow_mut().push(source.to_path_buf());
                Ok(with_audio.clone())
            },
            first_packet_unread,
            sample_rate_not_read,
            |_, source, read, _| {
                reads
                    .borrow_mut()
                    .push((source.to_path_buf(), read.ranges.len()));
                Ok(AudioFrames::default())
            },
        )
        .unwrap();

        // Each source is probed once, and its gaps are read inside its own pieces only.
        assert_eq!(*probed.borrow(), vec![second.clone(), first.clone()]);
        assert_eq!(
            *reads.borrow(),
            vec![(second.clone(), 2), (first.clone(), 1)]
        );
        let paths: Vec<&Path> = prepared
            .plan
            .sources
            .iter()
            .map(|source| source.path.as_path())
            .collect();
        assert_eq!(paths, vec![second.as_path(), first.as_path()]);
        assert_eq!(prepared.segment_count, 2);
        assert_eq!(start_payload("1-0", &prepared).segment_count, 2);
        assert_eq!(prepared.plan.segments.len(), 3);
    }

    #[test]
    fn a_revision_mismatch_of_a_later_source_names_that_source() {
        let directory = TestDirectory::new();
        let first = directory.path.join("first.mp4");
        let second = directory.path.join("second.mov");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second media").unwrap();
        let mut request = request_of(
            &[("first", &first), ("second", &second)],
            &[("first", 0, 90_000), ("second", 0, 90_000)],
        );
        request.sources[0].expected_revision = Some(revision_of(&first));
        request.sources[1].expected_revision = Some(ExpectedSourceRevisionWire {
            size: 1,
            mtime: 1_700_000_000,
        });
        let probed = Cell::new(0);

        let error = prepare_export_with(
            PrepareRequest {
                request: &request,
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
            |_, _, _| {
                probed.set(probed.get() + 1);
                Ok(sample_probe())
            },
            first_packet_unread,
            sample_rate_not_read,
            no_audio_gaps,
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::SourceRevisionMismatch);
        assert_eq!(error.detail.as_deref(), Some("second"));
        // The first source passed its check and was probed; the second was not.
        assert_eq!(probed.get(), 1);
    }

    #[test]
    fn the_time_limit_of_preparation_grows_with_the_number_of_sources() {
        let limits = |sources: usize| PreparationLimits::PRODUCTION.for_sources(sources).timeout;
        assert_eq!(limits(1), PREPARATION_TIMEOUT);
        assert_eq!(limits(0), PREPARATION_TIMEOUT);
        assert_eq!(limits(3), PREPARATION_TIMEOUT * 3);
        assert_eq!(PREPARATION_TIMEOUT, Duration::from_secs(180));
        let limits = PreparationLimits::PRODUCTION.for_sources(4);
        assert_eq!(limits.grace, PREPARATION_CANCEL_GRACE);
        assert_eq!(limits.poll, PREPARATION_POLL);
    }
}
