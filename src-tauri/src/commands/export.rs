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
//! The split mirrors `commands::capabilities`. Everything the command can find out cheaply
//! and before the encode starts -- a second export already running, a missing ffmpeg pair,
//! unreadable settings, an unresolvable preset, a failed re-probe, every preflight check in
//! [`build_plan`], and the output reservation -- is a plain rejection of the promise, because
//! the command has not answered yet and the frontend can render the failure without
//! subscribing to anything. Everything after the command returns its [`ExportStart`] payload
//! is an event on that run, because by then there is no rejection path left.
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
//!    never `plan.destination`. ffmpeg writes the reservation, and the rename that publishes
//!    the destination happens after the process has exited.
//! 3. [`choose_graph_shape`] is called once and its result is passed to **both**
//!    [`build_filter_graph`] and [`build_arguments`]. The two shapes disagree about how many
//!    inputs the graph's labels refer to, so a mismatch produces a command ffmpeg rejects.
//! 4. A zero exit status is not a successful export. `reserve` creates the reserved file
//!    before ffmpeg starts, so ADR 014 requires `-y`; without it ffmpeg refuses the existing
//!    file, writes nothing, and still exits zero. [`verified_frame_count`] is what separates
//!    that outcome from a real one for an export with video. An export without video writes
//!    no frames to count, and [`verified_audio_output`] separates the two outcomes for it: it
//!    reads the finished file back through ffprobe.
//! 5. The cancel flag is read once more after the process exits, after the success check, and
//!    **before** the rename. ADR 016 requires it: without that read, a cancel arriving in the
//!    last seconds of an encode still renames the output over the file the user chose while
//!    the interface says the export was cancelled.
//!
//! The `encoderUnavailable` pre-check ADR 016 describes is deliberately not implemented here.
//! It needs its own `ffmpeg -version` spawn and a capability-cache read, and it is a separate
//! unit; the error code stays reserved, as it is in `ffmpeg::export`.

use crate::ffmpeg::export::{
    build_arguments, build_filter_graph, build_plan, choose_graph_shape, inspect_path,
    run_export_process, verify_audio_output, AudioOutputMismatch, ExportErrorCode, ExportPlan,
    ExportProcessOutcome, ExportProcessRequest, ExportProcessStatus, ExportRegistry, ExportSlot,
    ExportStreams, PendingOutput, PlanRequest, ProgressSnapshot, SegmentBoundary,
};
use crate::ffmpeg::{self, FfmpegPaths, LocateError, MediaProbe, OutputAudioProbe, ProbeError};
use crate::settings::{self, LoadedSettings, Preset, Settings, SettingsFileError};
use crate::time::{Pts, Rational};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};

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

/// One requested segment boundary, as the frontend spells it.
///
/// `ffmpeg::export::SegmentBoundary` carries no serde derives on purpose -- it is a planning
/// type, not a wire type -- so this is the wire form and [`prepare_export_with`] converts.
/// Both fields are [`Pts`], which crosses as a canonical decimal **string**: ADR 002 keeps a
/// timestamp exact, and a JavaScript number cannot hold every `i64` a container can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSegmentBoundaryWire {
    pub in_pts: Pts,
    pub out_pts: Pts,
}

/// The request payload `start_export` accepts, matching `ExportRequest` on the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequestWire {
    pub source_path: String,
    pub output_path: String,
    pub segments: Vec<ExportSegmentBoundaryWire>,
    /// The preset to render with. Optional here and **required** in [`ExportStart`]: the
    /// command resolves an absent id against the settings document's `activePresetId` and
    /// echoes back whichever id it resolved, so the frontend never has to guess which preset
    /// a run actually used.
    #[serde(default)]
    pub preset_id: Option<String>,
    /// Which streams of the source the export writes. **Required**, with no default: an
    /// absent value would have to stand for one of the three choices, and a frontend that
    /// forgot to send the user's choice would then export a file the user did not ask for and
    /// report a success.
    pub streams: ExportStreams,
}

/// The immediate payload `start_export` resolves with when it accepts a run.
///
/// This is not an event: it is the command's own return value, resolved before the worker
/// thread starts. The frontend correlates every later `export:progress` event to this run by
/// `runId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStart {
    pub run_id: String,
    pub preset_id: String,
    /// The stream choice of the request, echoed as the run uses it.
    pub streams: ExportStreams,
    pub output_path: String,
    pub segment_count: u32,
    pub total_duration_us: u64,
    /// Absent for an export without video, which writes no frames: its progress has no total,
    /// and the interface shows it as indeterminate (ADR 025).
    #[serde(skip_serializing_if = "Option::is_none")]
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
    /// audio the segments can take from the source stream. It equals `totalDurationUs` in
    /// [`ExportStart`] when the source audio covers every segment, and is shorter when it does
    /// not. Absent on every other code.
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
/// `commands::capabilities`. `rename_all` renames the five variants into the `event` tag
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

/// Everything the worker thread needs, all of it resolved before the command answers.
#[derive(Debug)]
struct PreparedExport {
    /// The preset id that was actually resolved, echoed back in [`ExportStart`].
    preset_id: String,
    /// The stream choice of the request, echoed back in [`ExportStart`].
    streams: ExportStreams,
    plan: ExportPlan,
    /// The located `ffmpeg`.
    ffmpeg: PathBuf,
    /// The located `ffprobe`, which reads the finished file of an export without video back
    /// for its success check ([`verified_audio_output`]).
    ffprobe: PathBuf,
    /// The complete argument list, already built against [`PreparedExport::pending`]'s
    /// reserved path.
    arguments: Vec<String>,
    /// The reserved temporary output. Holding it here keeps the reservation alive for the
    /// whole run: dropping it deletes the file ffmpeg is writing.
    pending: PendingOutput,
}

/// Start one export and report it through [`EVENT_NAME`].
///
/// The single export slot is claimed here, in the command, and not on the worker thread: a
/// second export has to be refused while there is still a rejection path to answer it with.
/// The claim then moves to the worker, because a run outlives the command that started it and
/// Tauri lends managed state only for the length of the command.
#[tauri::command]
pub async fn start_export(
    app: tauri::AppHandle,
    registry: tauri::State<'_, Arc<ExportRegistry>>,
    published: tauri::State<'_, PublishedExports>,
    request: ExportRequestWire,
) -> Result<ExportStart, ExportCommandError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| ExportCommandError::new(ExportErrorCode::AppDataUnavailable))?;

    let run_id = next_run_id();
    // Claimed before any of the preparation below, so a second export is refused rather than
    // allowed to spawn a second ffprobe and reserve a second temporary file. Every `?` from
    // here on drops the slot, which releases it.
    let slot = registry
        .begin(&run_id)
        .ok_or_else(|| ExportCommandError::new(ExportErrorCode::ExportAlreadyRunning))?;
    // The earlier run is over, and the interface stops showing its result when this run
    // starts. Forget its output, so Show cannot act on a file that this run can replace.
    published.clear();

    // Preparation spawns ffprobe and touches the filesystem, so it does not belong on the
    // async executor. It is bounded work -- one short-lived child process -- which is what
    // the blocking pool is for; the export itself runs for minutes and gets its own thread.
    //
    // The flag goes with it: preparation is the one stretch of a run that can last tens of
    // seconds -- `ffmpeg::probe::PROBE_TIMEOUT` alone is 30 -- and a cancel that arrives
    // inside it must not have to wait for every remaining step to finish.
    let cancel = slot.cancel_flag();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_export_with(
            &request,
            &app_data_directory,
            cancel.as_ref(),
            discover_for_export,
            settings::load,
            ffmpeg::probe_media,
        )
    })
    .await
    .map_err(|error| join_failure(&error))??;

    // The last read before the worker takes over, for a cancel that landed after preparation
    // passed its own checks. Returning here drops `prepared`, which deletes the reserved
    // temporary file, and then drops `slot`, which releases the export slot -- the release
    // `lib::cancel_active_export` waits for on an application quit.
    if slot.is_canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    let start = start_payload(&run_id, &prepared);

    spawn_export_worker(app, slot, prepared, start.clone());

    Ok(start)
}

/// Ask the run named by `runId` to stop, and report whether the request reached the run that
/// currently holds the export slot.
///
/// `false` means the named run is not the one running. It does not mean no export is running,
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

/// Ask whichever run holds the export slot to stop, and report whether there was one.
///
/// This serves the one window [`cancel_export`] cannot. [`start_export`] claims the slot,
/// prepares, and answers with the run id only afterward, and preparation includes a re-probe
/// bounded at [`crate::ffmpeg::probe::PROBE_TIMEOUT`], which is 30 seconds. For that whole
/// window the frontend holds no id, so it has nothing to name to [`cancel_export`] and the user
/// cannot stop a run that is already holding the single export slot.
///
/// # Why cancelling without naming a run is correct here
///
/// The registry holds one run at a time (ADR 016), so the slot identifies a run as
/// unambiguously as the id does. The frontend reaches this path only while its own
/// `startExport` is in flight and has produced no id, so by construction the run holding the
/// slot in that window is the one it just started: no other export could have claimed the slot,
/// because this one has not released it.
///
/// A request that lands after preparation finished is harmless rather than wrong. It names the
/// same run -- the worker holds the slot for the rest of the run -- and the worker reads the
/// flag again before `ffmpeg` spawns and once more before the rename, which is ADR 016's
/// cancel-tested-twice rule. So the late request stops the run the user meant, at the next
/// point the run tests the flag.
///
/// `false` means the slot was free and nothing was set. As with [`cancel_export`], the
/// frontend must not render that as "there was nothing to cancel": it means only that no
/// export holds the slot at this instant.
#[tauri::command]
pub async fn cancel_active_export(
    registry: tauri::State<'_, Arc<ExportRegistry>>,
) -> Result<bool, ExportCommandError> {
    Ok(registry.cancel_active())
}

/// Report a blocking-task join failure as `commandExecutionFailed`, carrying what went wrong.
///
/// A join failure is not an enumerable condition, so ADR 011 keeps its diagnostic. The value the
/// one caller passes is a `JoinError`, and its `Display` says whether the task **panicked** or was
/// **cancelled** -- two different faults with two different investigations, and the bare code
/// tells them apart not at all.
///
/// The parameter is `&impl Display` rather than the concrete error type because a `JoinError`
/// cannot be constructed outside tokio, so a test can only reach this mapping with a stand-in. The
/// test that does so proves the text is carried, not that tokio produced it.
fn join_failure(error: &impl std::fmt::Display) -> ExportCommandError {
    ExportCommandError::with_detail(ExportErrorCode::CommandExecutionFailed, error.to_string())
}

/// Resolve the ffmpeg executable pair for an export: the configured path from settings, if
/// any, ahead of `PATH` and the application data directory, per ADR 005's resolution order.
///
/// This mirrors `commands::capabilities::discover_for_probe`, and it reads the settings
/// document once for the configured path even though [`prepare_export_with`] loads the
/// document again a moment later for the preset. The two reads are kept apart on purpose:
/// discovery must be able to fail as `ffmpegPairMissing` before an unreadable settings file
/// has any say, which is the order ADR 016's compose list gives.
fn discover_for_export(app_data_directory: &Path) -> Result<FfmpegPaths, LocateError> {
    let configured = settings::configured_ffmpeg_path(app_data_directory);
    ffmpeg::discover(configured.as_deref(), app_data_directory)
}

/// Do every fallible step an export needs before ffmpeg starts, in ADR 016's order.
///
/// The three injected functions are the ones that reach outside the process: executable
/// discovery, the settings read, and the ffprobe re-probe. ADR 014's "Other rules" requires
/// that re-probe -- the renderer reads the container start time and the selected stream
/// indices from a fresh probe, never from stale project metadata.
///
/// See this module's documentation for the five ordering obligations the body below carries.
///
/// `cancel` is this run's flag, read between the steps. Preparation runs while the run already
/// holds the export slot, and its steps reach outside the process, so it is the longest stretch
/// of a run that nothing could stop: a re-probe of a source on a share that stopped answering
/// takes [`crate::ffmpeg::probe::PROBE_TIMEOUT`], which is 30 seconds, six times the budget
/// `lib::EXIT_CANCEL_BUDGET` gives an application quit. Reading the flag between the steps does
/// not shorten a step that has already started -- the timeout bounds that one -- but it stops
/// the run from working through every remaining step after the answer is no longer wanted, and
/// it means a cancel during preparation ends with the slot released and no reserved file left
/// on disk.
fn prepare_export_with<Discover, Load, Probe>(
    request: &ExportRequestWire,
    app_data_directory: &Path,
    cancel: &AtomicBool,
    discover: Discover,
    load: Load,
    probe: Probe,
) -> Result<PreparedExport, ExportCommandError>
where
    Discover: FnOnce(&Path) -> Result<FfmpegPaths, LocateError>,
    Load: FnOnce(&Path) -> Result<LoadedSettings, SettingsFileError>,
    Probe: FnOnce(&Path, &Path) -> Result<MediaProbe, ProbeError>,
{
    // Read the same way `ExportSlot::is_canceled` reads it, so the ordering pairs with
    // `ExportRegistry::cancel`'s store.
    let canceled = || cancel.load(std::sync::atomic::Ordering::SeqCst);

    // Before the first step, which already reaches outside the process: `discover` walks `PATH`
    // and inspects each candidate, and an entry on a share that has stopped answering holds
    // that inspection for as long as the operating system lets it. A cancel that arrives before
    // the command even reached the blocking pool then ends the run at the first step rather
    // than the third.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }

    let executables = discover(app_data_directory)
        .map_err(|_| ExportCommandError::new(ExportErrorCode::FfmpegPairMissing))?;

    // The settings failure carries its diagnostic. ADR 011 decides that by the condition, not by
    // the origin of the string: what the interface renders is always the localized code, and a
    // detail is supplementary text a user copies into a bug report. `SettingsFileError` has seven
    // variants -- an I/O failure, a serde parse error that names a line and a column, a validation
    // refusal, a schema version from the future, an unreadable existing file, a revision conflict,
    // and a failed backup -- and every one of them arrives here as `settingsUnreadable`, because
    // the export has no separate recovery for any of them. Without the text, a permission denial
    // and a parse error at line 12 are indistinguishable in a report. `commands/settings.rs` has
    // its own codes for these on its own surface; this surface has one, and the detail is the only
    // thing that tells the seven apart.
    let loaded = load(app_data_directory).map_err(|error| {
        ExportCommandError::with_detail(ExportErrorCode::SettingsUnreadable, error.to_string())
    })?;
    let preset = resolve_preset(&loaded.settings, request.preset_id.as_deref())?;

    let source = PathBuf::from(&request.source_path);
    let destination = PathBuf::from(&request.output_path);

    // Before the re-probe, which is the one step here that can spend tens of seconds.
    if canceled() {
        return Err(ExportCommandError::new(ExportErrorCode::Canceled));
    }
    let probe = probe(&executables.ffprobe, &source).map_err(map_reprobe_error)?;

    let segments: Vec<SegmentBoundary> = request
        .segments
        .iter()
        .map(|segment| SegmentBoundary {
            in_pts: segment.in_pts,
            out_pts: segment.out_pts,
        })
        .collect();

    // Obligation 1: planning runs before the reservation. A destination that is a directory
    // reserves successfully and fails only at the rename, after the whole encode.
    let plan = build_plan(
        &PlanRequest {
            source: &source,
            destination: &destination,
            segments: &segments,
            probe: &probe,
            preset,
            streams: request.streams,
        },
        inspect_path,
    )
    .map_err(ExportCommandError::new)?;

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
    let pending = PendingOutput::reserve(&plan.destination).map_err(|error| {
        ExportCommandError::with_detail(ExportErrorCode::OutputNotWritable, error.to_string())
    })?;

    // Obligations 2 and 3: ffmpeg writes the reservation, not the destination, and one shape
    // decision serves both the graph and the arguments.
    let shape = choose_graph_shape(&plan, pending.path());
    let graph = build_filter_graph(&plan, shape);
    let arguments = build_arguments(&plan, shape, &graph, pending.path());

    Ok(PreparedExport {
        preset_id: preset.id.clone(),
        streams: request.streams,
        plan,
        ffmpeg: executables.ffmpeg,
        ffprobe: executables.ffprobe,
        arguments,
        pending,
    })
}

/// Resolve the preset an export renders with: the requested id, or the settings document's
/// active id when the request named none.
///
/// `presetNotFound` covers both ways this can fail -- an id that names nothing, and no id to
/// resolve at all -- because from the frontend's side they are the same condition: the run
/// has no preset.
fn resolve_preset<'a>(
    settings: &'a Settings,
    requested: Option<&str>,
) -> Result<&'a Preset, ExportCommandError> {
    let id = requested
        .or(settings.active_preset_id.as_deref())
        .ok_or_else(|| ExportCommandError::new(ExportErrorCode::PresetNotFound))?;
    settings
        .presets
        .iter()
        .find(|preset| preset.id == id)
        .ok_or_else(|| ExportCommandError::new(ExportErrorCode::PresetNotFound))
}

/// Build the payload the command resolves with, and that the `started` event repeats.
fn start_payload(run_id: &str, prepared: &PreparedExport) -> ExportStart {
    ExportStart {
        run_id: run_id.to_owned(),
        preset_id: prepared.preset_id.clone(),
        streams: prepared.streams,
        output_path: path_to_string(&prepared.plan.destination),
        // `build_plan` rejects an empty request and caps the count at `MAX_EXPORT_SEGMENTS`,
        // so this conversion cannot saturate for any plan that reaches here.
        segment_count: u32::try_from(prepared.plan.segments.len()).unwrap_or(u32::MAX),
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

/// Start the dedicated thread that runs one export to completion.
///
/// This is an OS thread of its own, not the tokio blocking pool: an export runs for minutes,
/// and that pool is sized and scheduled for short work.
fn spawn_export_worker(
    app: tauri::AppHandle,
    slot: ExportSlot,
    prepared: PreparedExport,
    start: ExportStart,
) {
    // Cloned before the `move` closure below takes the originals: a spawn failure drops that
    // closure and every value it captured, so these clones are the only copies left with
    // which to report the failure.
    let failure_app = app.clone();
    let failure_run_id = start.run_id.clone();
    let spawn_result = std::thread::Builder::new()
        .name("export".to_owned())
        .spawn(move || {
            run_export_worker(&app, slot, prepared, &start);
        });
    // The command has already returned its success payload by the time this runs, so a
    // failure to start the thread has no rejection path left. It is reachable only under
    // extreme resource exhaustion, and without this event the interface would sit on
    // "exporting" forever. The slot was captured by the dropped closure, so it is released
    // by the same drop that lost it.
    if spawn_result.is_err() {
        emit_failed(
            &failure_app,
            &failure_run_id,
            ExportCommandError::new(ExportErrorCode::CommandExecutionFailed),
        );
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
    // A panic inside the run has to be turned back into a report. [`spawn_export_worker`]
    // gives the reason a lost report cannot be tolerated -- the interface sits on "exporting"
    // forever, with no timeout, and `cancel_export` answers `false` because the slot is
    // already free -- and the body needs the same protection as the spawn. It is reachable by
    // the mechanism this module already names: `run_export_process` calls
    // `std::thread::spawn` twice, and that panics rather than returning an error when the
    // operating system refuses a thread.
    //
    // Every guard has already run by the time the panic arm below is reached. The unwind
    // passes `ChildGuard`, which kills and reaps ffmpeg, and `PendingOutput`, which deletes
    // the reservation, and `slot` is released by the drop at the end of this function. So this
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
/// `emit`, running the child through `process`, and reading a finished file without video back
/// through `probe_output`.
///
/// The three checks between the process exiting and the rename are obligations 4 and 5 of
/// this module's documentation, in the order ADR 016 requires them: the success check, then
/// the cancel flag, then the publication. The success check is the frame count for a plan
/// with video, and [`verified_audio_output`] for a plan without it. A failed check returns
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
        pending,
        ..
    } = prepared;
    let expected_frames = plan.expected_frames();
    let cancel = slot.cancel_flag();

    let outcome = process(
        ExportProcessRequest {
            ffmpeg: &ffmpeg,
            arguments: &arguments,
            cancel: cancel.as_ref(),
            poll: PROGRESS_POLL_INTERVAL,
        },
        &mut |snapshot| {
            if let Some(event) = progress_event(run_id, snapshot, expected_frames) {
                emit(event);
            }
        },
    )
    .map_err(|error| {
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
        verified_frame_count(
            expected_frames,
            outcome.last_progress.as_ref(),
            outcome.stderr_detail(),
        )?
    } else {
        // `build_plan` plans audio for every plan without video; the total duration only
        // stands in for a hand-built plan that has neither part.
        let expected = plan
            .audio
            .as_ref()
            .map_or(plan.total_duration, |audio| audio.expected_duration);
        verified_audio_output(
            expected,
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
///    [`crate::ffmpeg::export::PlannedAudio::expected_duration`], the audio the segments can take
///    from the source. A wrong stream set reports `outputStreamsMismatch`. A duration outside the
///    tolerance, or none, reports `audioDurationMismatch`, with the measured and the expected
///    duration as named values.
///
/// `detail` is the process's own stderr tail, as for the frame count.
fn verified_audio_output(
    expected: Rational,
    last_progress: Option<&ProgressSnapshot>,
    detail: Option<String>,
    probe: impl FnOnce() -> Result<OutputAudioProbe, ProbeError>,
) -> Result<(), ExportCommandError> {
    let streams_mismatch = |detail: Option<String>| ExportCommandError {
        detail,
        ..ExportCommandError::new(ExportErrorCode::OutputStreamsMismatch)
    };
    if last_progress.is_none() {
        return Err(streams_mismatch(detail));
    }
    let answer = probe().map_err(|error| match error {
        ProbeError::ProcessFailed { .. } | ProbeError::Parse { .. } => {
            streams_mismatch(detail.clone())
        }
        ProbeError::Canceled => ExportCommandError::new(ExportErrorCode::Canceled),
        ProbeError::Spawn { .. } | ProbeError::TimedOut { .. } => map_reprobe_error(error),
    })?;
    verify_audio_output(&answer, expected).map_err(|mismatch| match mismatch {
        AudioOutputMismatch::Streams { .. } => streams_mismatch(detail),
        AudioOutputMismatch::Duration { measured, expected } => ExportCommandError {
            detail,
            measured_duration_us: measured.map(duration_microseconds),
            expected_duration_us: Some(duration_microseconds(expected)),
            ..ExportCommandError::new(ExportErrorCode::AudioDurationMismatch)
        },
    })
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
/// and an exit code, rather than letting a second copy drift away from it. The probe of the
/// finished file of an export without video ([`verified_audio_output`]) runs the same ffprobe
/// through the same runner. It uses this mapping only for a probe that cannot start or that
/// times out: an exit failure or a parse failure there is a wrong output, not a fault of the
/// source, and a cancel ends the run as canceled.
///
/// The timeout matters more here than it does on the import path. The single export slot is
/// claimed before the re-probe runs, so an unbounded probe would hold it for the rest of the
/// process's life and refuse every later export with `exportAlreadyRunning`.
fn map_reprobe_error(error: ProbeError) -> ExportCommandError {
    let mapped = map_probe_error(error);
    let code = match mapped.code {
        ImportMediaErrorCode::FfprobeSpawnFailed => ExportErrorCode::FfprobeSpawnFailed,
        ImportMediaErrorCode::FfprobeProcessFailed => ExportErrorCode::FfprobeProcessFailed,
        ImportMediaErrorCode::FfprobeParseFailed => ExportErrorCode::FfprobeParseFailed,
        ImportMediaErrorCode::FfprobeTimedOut => ExportErrorCode::FfprobeTimedOut,
        // `map_probe_error` produces exactly the four codes above for the four ways a probe
        // fails. Its fifth variant, `Canceled`, comes only from a probe that holds a cancel
        // flag, and the output probe handles it before this mapping. This arm is therefore
        // unreachable. It reports rather than panics: a new probe failure mode must not take an
        // export worker down with it.
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

fn emit_event(app: &tauri::AppHandle, event: ExportEvent) {
    // A failed emit means nobody is listening, for example because the window closed during
    // the encode. It must never propagate: this is called from the progress callback, which
    // runs inside `run_export_process`'s supervision loop, and a panic there unwinds straight
    // out of that function and loses the whole outcome -- no status, no stderr, no frame
    // count -- leaving the caller with nothing to report but the panic.
    let _ = app.emit(EVENT_NAME, event);
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
    use std::cell::RefCell;
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

    fn sample_settings(active: Option<&str>, presets: Vec<Preset>) -> Settings {
        Settings {
            schema_version: crate::settings::CURRENT_SCHEMA_VERSION,
            revision: 0,
            ffmpeg_path: None,
            presets,
            active_preset_id: active.map(str::to_owned),
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
            audio: None,
        }
    }

    fn sample_plan(destination: &Path) -> ExportPlan {
        ExportPlan {
            source: PathBuf::from("/media/source.mp4"),
            destination: destination.to_path_buf(),
            video: Some(PlannedVideo {
                stream_index: 0,
                timing: OutputTiming::ConstantFrameRate(Rational::new(30, 1).unwrap()),
                resolution: None,
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
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
                seek_seconds: None,
                audio_in_tick: None,
                audio_out_tick: None,
            }],
            container: Container::Mp4,
            total_duration: Rational::new(1, 1).unwrap(),
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

    #[test]
    fn export_start_serializes_camel_case_and_omits_an_absent_frame_count() {
        let start = ExportStart {
            run_id: "42-7".to_owned(),
            preset_id: "default-h264-mp4".to_owned(),
            streams: ExportStreams::AudioOnly,
            output_path: "/movies/out.mp4".to_owned(),
            segment_count: 3,
            total_duration_us: 12_500_000,
            expected_frames: None,
        };

        let value = serde_json::to_value(&start).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(value["runId"], "42-7");
        assert_eq!(value["presetId"], "default-h264-mp4");
        assert_eq!(value["outputPath"], "/movies/out.mp4");
        assert_eq!(value["segmentCount"], 3);
        assert_eq!(value["totalDurationUs"], 12_500_000);
        assert!(value.get("run_id").is_none());
        assert!(!object.contains_key("expectedFrames"));
    }

    #[test]
    fn export_command_error_omits_absent_optional_fields_entirely_not_as_null() {
        let error = ExportCommandError::new(ExportErrorCode::ExportAlreadyRunning);

        let value = serde_json::to_value(&error).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(value["code"], "exportAlreadyRunning");
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
            "sourcePath": "/media/source.mp4",
            "outputPath": "/movies/out.mp4",
            "segments": [{ "inPts": "9007199254740993", "outPts": "9007199254740994" }],
            "streams": "videoAndAudio",
        }))
        .unwrap();

        assert_eq!(request.preset_id, None);
        assert_eq!(request.streams, ExportStreams::VideoAndAudio);
        // The value below is above `Number.MAX_SAFE_INTEGER`, which is exactly why ADR 002
        // puts a `Pts` on the wire as a string: as a JSON number it would already have been
        // rounded before it reached this parser.
        assert_eq!(request.segments[0].in_pts, Pts::new(9_007_199_254_740_993));
        assert_eq!(request.segments[0].out_pts, Pts::new(9_007_199_254_740_994));
    }

    /// A request payload in its wire form, with `streams` set to `streams` or left out.
    fn request_json(streams: Option<serde_json::Value>) -> serde_json::Value {
        let mut value = serde_json::json!({
            "sourcePath": "/media/source.mp4",
            "outputPath": "/movies/out.mp4",
            "segments": [{ "inPts": "0", "outPts": "90000" }],
            "presetId": "active",
        });
        if let Some(streams) = streams {
            value["streams"] = streams;
        }
        value
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
    fn export_start_echoes_the_stream_choice() {
        let start = ExportStart {
            run_id: "42-7".to_owned(),
            preset_id: "default-h264-mp4".to_owned(),
            streams: ExportStreams::VideoOnly,
            output_path: "/movies/out.mp4".to_owned(),
            segment_count: 1,
            total_duration_us: 1_000_000,
            expected_frames: Some(30),
        };
        let value = serde_json::to_value(&start).unwrap();
        assert_eq!(value["streams"], "videoOnly");
        assert_eq!(value["expectedFrames"], 30);
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
    fn a_requested_preset_id_wins_over_the_active_one() {
        let settings = sample_settings(
            Some("active"),
            vec![sample_preset("active"), sample_preset("requested")],
        );

        let preset = resolve_preset(&settings, Some("requested")).unwrap();

        assert_eq!(preset.id, "requested");
    }

    #[test]
    fn an_absent_requested_preset_id_falls_back_to_the_active_one() {
        let settings = sample_settings(Some("active"), vec![sample_preset("active")]);

        let preset = resolve_preset(&settings, None).unwrap();

        assert_eq!(preset.id, "active");
    }

    #[test]
    fn an_unresolvable_preset_reports_preset_not_found() {
        let with_presets = sample_settings(Some("active"), vec![sample_preset("active")]);
        let without_active = sample_settings(None, vec![sample_preset("active")]);

        // An id that names nothing, and no id to resolve at all, are one condition from the
        // frontend's side: this run has no preset.
        for error in [
            resolve_preset(&with_presets, Some("missing")).unwrap_err(),
            resolve_preset(&without_active, None).unwrap_err(),
        ] {
            assert_eq!(error.code, ExportErrorCode::PresetNotFound);
            assert_eq!(error.detail, None);
        }
    }

    #[test]
    fn preparation_stops_at_an_unresolvable_preset_without_probing() {
        let directory = TestDirectory::new();
        let probed = RefCell::new(false);
        let request = ExportRequestWire {
            source_path: "/media/source.mp4".to_owned(),
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: Some("missing".to_owned()),
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| {
                *probed.borrow_mut() = true;
                unreachable!()
            },
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::PresetNotFound);
        assert!(!*probed.borrow());
    }

    #[test]
    fn preparation_builds_the_command_against_the_reservation_and_not_the_destination() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        let request = ExportRequestWire {
            source_path: source.to_string_lossy().into_owned(),
            output_path: destination.to_string_lossy().into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let prepared = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, path| {
                assert_eq!(path, source);
                Ok(sample_probe())
            },
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
    fn a_version_1_settings_file_prepares_the_command_of_version_1_and_saving_it_keeps_the_command()
    {
        // A user upgrades from the first release, and the settings file is still at schema
        // version 1. Each preset reads with the defaults of the keys version 2 added: the graph
        // is the graph of version 1, byte for byte, and the arguments add `-pix_fmt yuv420p`
        // only, which names the format the graph already ends in. After a save writes version
        // 2, the same export prepares the same command.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let destination = directory.path.join("out.mp4");
        let settings_path = directory.path.join(settings::SETTINGS_FILE_NAME);
        fs::write(&settings_path, settings::VERSION_1_FIXTURE).unwrap();
        let request = ExportRequestWire {
            source_path: source.to_string_lossy().into_owned(),
            output_path: destination.to_string_lossy().into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: Some("default-h264-mp4".to_owned()),
            streams: ExportStreams::VideoAndAudio,
        };
        let prepare = || {
            prepare_export_with(
                &request,
                &directory.path,
                &AtomicBool::new(false),
                |_| {
                    Ok(FfmpegPaths {
                        ffmpeg: directory.path.join("ffmpeg"),
                        ffprobe: directory.path.join("ffprobe"),
                        origin: ExecutableOrigin::Path,
                    })
                },
                settings::load,
                |_, _| Ok(sample_probe_with_audio()),
            )
            .unwrap()
        };
        // The command without its last argument, the reservation, whose name counts up.
        let command = |prepared: &PreparedExport| -> Vec<String> {
            let mut arguments = prepared.arguments.clone();
            assert_eq!(
                arguments.pop().as_deref(),
                Some(path_to_string(prepared.pending.path()).as_str())
            );
            arguments
        };

        let from_version_1 = command(&prepare());
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
                "-filter_complex",
                concat!(
                    "[vc]format=yuv420p[v];",
                    "[0:0]trim=start_pts=0:end_pts=90000,setpts=PTS-STARTPTS,fps=30/1[v0];",
                    "[0:1]aformat=r=48000,atrim=start_pts=0:end_pts=48000,asetpts=PTS-0,",
                    "aresample=48000:first_pts=0,aformat=f=fltp:r=48000[a0];",
                    "[v0][a0]concat=n=1:v=1:a=1[vc][a]",
                ),
                "-map",
                "[v]",
                "-map",
                "[a]",
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
        // The preparation read the file and wrote nothing to it.
        assert_eq!(
            fs::read_to_string(&settings_path).unwrap(),
            settings::VERSION_1_FIXTURE
        );

        let upgraded = settings::save(
            &directory.path,
            &settings::load(&directory.path).unwrap().settings,
        )
        .unwrap();
        assert_eq!(upgraded.schema_version, 2);
        assert_eq!(command(&prepare()), from_version_1);
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
            source_path: source.to_string_lossy().into_owned(),
            output_path: destination.to_string_lossy().into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| Ok(sample_probe()),
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
            source_path: source.to_string_lossy().into_owned(),
            output_path: destination.to_string_lossy().into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| Ok(sample_probe()),
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
            source_path: source.to_string_lossy().into_owned(),
            output_path: destination.to_string_lossy().into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let result = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| Ok(sample_probe()),
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
        // slot before it hands preparation to the blocking pool, so a cancel can already be set
        // when the first step runs. That step is `discover`, which walks `PATH` and inspects
        // each candidate; an entry on a share that stopped answering holds it. Reading the flag
        // only later would spend that time for an answer nobody wants.
        let directory = TestDirectory::new();
        let discovered = RefCell::new(false);
        let request = ExportRequestWire {
            source_path: "/media/source.mp4".to_owned(),
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(true),
            |_| {
                *discovered.borrow_mut() = true;
                unreachable!()
            },
            |_| unreachable!(),
            |_, _| unreachable!(),
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
        // The flag is set from inside `load`, after `discover` has already run, so this test
        // reaches the pre-re-probe check rather than the one at the top of preparation. A flag
        // that started out set would stop the run at that first check and leave this one
        // untested.
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let cancel = AtomicBool::new(false);
        let probed = RefCell::new(false);
        let request = ExportRequestWire {
            source_path: source.to_string_lossy().into_owned(),
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &cancel,
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| {
                *probed.borrow_mut() = true;
                unreachable!()
            },
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
            source_path: source.to_string_lossy().into_owned(),
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &cancel,
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| {
                cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(sample_probe())
            },
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
    fn a_missing_ffmpeg_pair_is_reported_before_the_settings_are_read() {
        let directory = TestDirectory::new();
        let request = ExportRequestWire {
            source_path: "/media/source.mp4".to_owned(),
            output_path: directory
                .path
                .join("out.mp4")
                .to_string_lossy()
                .into_owned(),
            segments: vec![],
            preset_id: None,
            streams: ExportStreams::VideoAndAudio,
        };

        let error = prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| Err(LocateError::NotFound { inspected: vec![] }),
            |_| unreachable!(),
            |_, _| unreachable!(),
        )
        .unwrap_err();

        assert_eq!(error.code, ExportErrorCode::FfmpegPairMissing);
        assert_eq!(error.detail, None);
    }

    #[test]
    fn an_unreadable_settings_file_reports_one_code_and_carries_which_fault_it_was() {
        // `SettingsFileError` has seven variants and this surface has one code for all of them,
        // because the export has no separate recovery for any. The detail is therefore the only
        // thing that tells them apart in a bug report, which is why the two below must not read
        // the same. `commands/settings.rs` gives these separate codes on its own surface; that is
        // not this surface, and the amended ADR 011 decides the question by the condition rather
        // than by which process authored the string.
        let directory = TestDirectory::new();
        let mut details = Vec::new();
        for failure in [
            SettingsFileError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "raw operating system diagnostic",
            )),
            SettingsFileError::Unreadable,
        ] {
            let expected = failure.to_string();
            let failure = RefCell::new(Some(failure));
            let probed = RefCell::new(false);
            let request = ExportRequestWire {
                source_path: "/media/source.mp4".to_owned(),
                output_path: directory
                    .path
                    .join("out.mp4")
                    .to_string_lossy()
                    .into_owned(),
                segments: vec![],
                preset_id: None,
                streams: ExportStreams::VideoAndAudio,
            };

            let error = prepare_export_with(
                &request,
                &directory.path,
                &AtomicBool::new(false),
                |_| {
                    Ok(FfmpegPaths {
                        ffmpeg: directory.path.join("ffmpeg"),
                        ffprobe: directory.path.join("ffprobe"),
                        origin: ExecutableOrigin::Path,
                    })
                },
                |_| Err(failure.borrow_mut().take().unwrap()),
                |_, _| {
                    *probed.borrow_mut() = true;
                    unreachable!()
                },
            )
            .unwrap_err();

            assert_eq!(error.code, ExportErrorCode::SettingsUnreadable);
            assert_eq!(error.detail.as_deref(), Some(expected.as_str()));
            assert!(!*probed.borrow());
            details.push(error.detail.unwrap());
        }

        // The two faults really are distinguishable, which is the whole point of carrying the
        // text. Asserting each detail against its own source message alone would still pass if
        // every variant rendered one indistinguishable sentence.
        assert_ne!(details[0], details[1]);
        assert!(details[0].contains("raw operating system diagnostic"));
    }

    // A `JoinError` cannot be constructed outside tokio, so the stand-in below is the closest a
    // test can get to the real value. It holds the mapping: a panic and a cancellation are two
    // faults, and `commandExecutionFailed` alone cannot tell a reader which one happened.
    #[test]
    fn a_join_failure_carries_the_reason_the_task_did_not_finish() {
        let error = join_failure(&"task 12 was cancelled");

        assert_eq!(error.code, ExportErrorCode::CommandExecutionFailed);
        assert_eq!(error.detail.as_deref(), Some("task 12 was cancelled"));
        assert_eq!(error.exit_code, None);
        assert_eq!(error.encoder, None);
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
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            pending,
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
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            pending,
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
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"media").unwrap();
        let request = ExportRequestWire {
            source_path: source.to_string_lossy().into_owned(),
            output_path: directory
                .path
                .join("out.m4a")
                .to_string_lossy()
                .into_owned(),
            segments: vec![ExportSegmentBoundaryWire {
                in_pts: Pts::new(0),
                out_pts: Pts::new(90_000),
            }],
            preset_id: None,
            streams,
        };
        prepare_export_with(
            &request,
            &directory.path,
            &AtomicBool::new(false),
            |_| {
                Ok(FfmpegPaths {
                    ffmpeg: directory.path.join("ffmpeg"),
                    ffprobe: directory.path.join("ffprobe"),
                    origin: ExecutableOrigin::Path,
                })
            },
            |_| {
                Ok(LoadedSettings {
                    settings: sample_settings(Some("active"), vec![sample_preset("active")]),
                    seeded: false,
                })
            },
            |_, _| Ok(probe),
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

        // The start payload echoes the choice and carries no frame goal, so the interface shows
        // the progress as indeterminate (ADR 025).
        let start = start_payload("42-7", &prepared);
        assert_eq!(start.streams, ExportStreams::AudioOnly);
        assert_eq!(start.expected_frames, None);
        assert_eq!(start.total_duration_us, 1_000_000);
        let value = serde_json::to_value(&start).unwrap();
        assert_eq!(value["streams"], "audioOnly");
        assert!(!value.as_object().unwrap().contains_key("expectedFrames"));
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

    // -- the stream choice: the success check of an export without video -------------------

    /// A one-second plan that writes 48000 Hz audio and no video.
    fn sample_audio_plan(destination: &Path) -> ExportPlan {
        let mut plan = sample_plan(destination);
        plan.video = None;
        plan.audio = Some(crate::ffmpeg::export::PlannedAudio {
            stream_index: 1,
            sample_rate: 48_000,
            output_sample_rate: 48_000,
            output_channels: AudioChannels::Stereo,
            encoder: "aac".to_owned(),
            bitrate: None,
            options: vec![],
            // The source audio covers the whole segment.
            expected_duration: Rational::new(1, 1).unwrap(),
        });
        plan.segments[0].audio_in_tick = Some(0);
        plan.segments[0].audio_out_tick = Some(48_000);
        plan
    }

    /// An audio-only run, ready for [`run_export_with`], and the reserved path it writes.
    fn prepared_audio_run(destination: &Path) -> (PreparedExport, PathBuf) {
        let pending = PendingOutput::reserve(destination).unwrap();
        let reserved = pending.path().to_path_buf();
        let prepared = PreparedExport {
            preset_id: "active".to_owned(),
            streams: ExportStreams::AudioOnly,
            plan: sample_audio_plan(destination),
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            pending,
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
    fn a_plan_with_video_is_verified_by_its_frame_count_and_never_probed() {
        // Video and audio, and video only, keep the frame count as their success check. The
        // output probe below must never run for either.
        for streams in [ExportStreams::VideoAndAudio, ExportStreams::VideoOnly] {
            let directory = TestDirectory::new();
            let destination = directory.path.join("out.mp4");
            let pending = PendingOutput::reserve(&destination).unwrap();
            let reserved = pending.path().to_path_buf();
            let prepared = PreparedExport {
                preset_id: "active".to_owned(),
                streams,
                plan: sample_plan(&destination),
                ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
                ffprobe: PathBuf::from("/usr/bin/ffprobe"),
                arguments: vec![],
                pending,
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
                |_, _, _| unreachable!("a plan with video is verified by its frame count"),
            )
            .unwrap();

            assert_eq!(frames, 30, "{streams:?}");
            assert_eq!(fs::read(&destination).unwrap(), b"the finished video");
        }
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
            plan,
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            arguments: vec![],
            pending,
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
}
