//! Tauri command surface for the ADR 006 capability probe.
//!
//! `start_capability_probe` resolves the ffmpeg executable pair, then starts a background
//! worker that runs [`capabilities::probe_capabilities_with`] and reports progress through
//! one Tauri event, `ffmpeg:capability-probe`. This module also holds every wire type that
//! event and that command carry: `src/features/ffmpeg/types.ts` and `validation.ts` are
//! already committed on the frontend and parse these strictly, so every shape here is
//! pinned by a test rather than left to match by convention.
//!
//! Discovery failure and a worker failure are deliberately two different paths. Discovery
//! runs before the command resolves and, on failure, is a plain promise rejection: the
//! frontend can render "ffmpeg missing" without subscribing to anything. Everything after
//! discovery succeeds -- the version read, the listings, each smoke test, the cache -- is
//! reported as an event on the run the command already started, because by then the command
//! has already returned its `CapabilityProbeStart` payload and has no rejection path left.

use crate::ffmpeg::capabilities::{
    self, CapabilityProbeErrorCode, CapabilityReport, CodecKind, EncoderResult, EncoderStatus,
    LicenseFlags, ProbeRequest, SmokeReport, VersionInfo,
};
// Re-exported so a caller can name the wire type through this command module, even though
// [`CapabilityProbeSource`] is now defined in `capabilities::mod` alongside the orchestrator
// that returns it. The wire shape (`"probe"` / `"cache"`) is unchanged either way.
pub use crate::ffmpeg::capabilities::CapabilityProbeSource;
use crate::ffmpeg::{self, ExecutableOrigin, FfmpegPaths, InspectedLocation, LocateError};
use crate::settings;
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

// The run id generator will be shared with the export command, so it sits in `commands::mod`.
use super::next_run_id;

/// The Tauri event every capability-probe run reports through.
const EVENT_NAME: &str = "ffmpeg:capability-probe";

/// The immediate payload `start_capability_probe` resolves with when it accepts a run.
///
/// This is not an event: it is the command's own return value, resolved before the worker
/// thread starts. The frontend correlates every later `ffmpeg:capability-probe` event to
/// this run by `runId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProbeStart {
    pub run_id: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub origin: ExecutableOrigin,
}

/// The command's rejection payload. `start_capability_probe` returns this only for a
/// discovery failure; every failure after that point is a `failed` event on the run instead,
/// carried by [`CapabilityProbeEvent::Failed`] with the same field shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProbeError {
    pub code: CapabilityProbeErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inspected: Option<Vec<InspectedCandidate>>,
}

impl CapabilityProbeError {
    fn new(code: CapabilityProbeErrorCode) -> Self {
        Self {
            code,
            detail: None,
            exit_code: None,
            inspected: None,
        }
    }
}

/// The wire-safe form of [`InspectedLocation`].
///
/// `InspectedLocation` holds a raw `PathBuf` and, on purpose, does not derive `Serialize`:
/// a `PathBuf` only serializes when it is valid UTF-8, and one non-UTF-8 candidate (an
/// unpaired surrogate from a Windows `PATH` entry, for example) would fail the whole
/// `inspected` vector rather than just that one entry. This type down-converts each path
/// with `to_string_lossy` up front -- the same lossy conversion [`path_to_string`] already
/// uses for every other path field in this module -- so a single bad candidate can never
/// take the rest of the search list down with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedCandidate {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub origin: ExecutableOrigin,
}

impl From<InspectedLocation> for InspectedCandidate {
    fn from(location: InspectedLocation) -> Self {
        Self {
            ffmpeg: path_to_string(&location.ffmpeg),
            ffprobe: path_to_string(&location.ffprobe),
            origin: location.origin,
        }
    }
}

/// One `ffmpeg:capability-probe` event payload.
///
/// Every variant carries `runId`, so the frontend can discard an event whose run has been
/// superseded (ADR 006: "the backend does not cancel a probe").
///
/// Both serde attributes below are required together. `rename_all` renames the four
/// variants themselves (`located`, `result`, `finished`, `failed`) into the `event` tag
/// value. `rename_all_fields` renames each variant's *fields* (`run_id` to `runId`, and so
/// on); dropping it would ship `run_id` verbatim and the frontend's strict
/// `validateCapabilityProbeEvent` would drop every event, hanging the UI on "probing"
/// forever. The tag field is named `event`, not `kind`, on purpose: the `result` variant's
/// nested [`EncoderResult`] already has its own `kind` field one level down, and naming the
/// outer tag the same word invites exactly that confusion even though the two never
/// literally collide, since `result` is a nested field rather than flattened.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CapabilityProbeEvent {
    Located {
        run_id: String,
        ffmpeg: String,
        ffprobe: String,
        origin: ExecutableOrigin,
        version: String,
        license: LicenseFlags,
    },
    Result {
        run_id: String,
        result: EncoderResult,
        done: u32,
        total: u32,
    },
    Finished {
        run_id: String,
        report: CapabilityReport,
        source: CapabilityProbeSource,
    },
    Failed {
        run_id: String,
        code: CapabilityProbeErrorCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inspected: Option<Vec<InspectedCandidate>>,
    },
}

/// Resolve the ffmpeg executable pair and start one ADR 006 capability probe in the
/// background.
///
/// Discovery runs on the tokio blocking pool: it only stats a short, fixed list of
/// candidate paths, so it is fast enough for that pool despite running off the async
/// executor. A discovery failure is returned as a plain rejection, carrying the inspected
/// candidate list, before any event is ever emitted for this run.
///
/// On success, this returns immediately and starts the probe worker on a dedicated OS
/// thread, not the tokio blocking pool: a full probe can run a dozen five-second smoke
/// tests, and that pool is sized and scheduled for short tasks.
#[tauri::command]
pub async fn start_capability_probe(
    app: tauri::AppHandle,
    force: bool,
) -> Result<CapabilityProbeStart, CapabilityProbeError> {
    let app_data_directory = app
        .path()
        .app_data_dir()
        .map_err(|_| CapabilityProbeError::new(CapabilityProbeErrorCode::AppDataUnavailable))?;

    let discovery_app_data_directory = app_data_directory.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        discover_for_probe(&discovery_app_data_directory)
    })
    .await
    .map_err(|_| CapabilityProbeError::new(CapabilityProbeErrorCode::CommandExecutionFailed))?
    .map_err(map_locate_error)?;

    let run_id = next_run_id();
    let start = CapabilityProbeStart {
        run_id: run_id.clone(),
        ffmpeg: path_to_string(&paths.ffmpeg),
        ffprobe: path_to_string(&paths.ffprobe),
        origin: paths.origin,
    };

    spawn_probe_worker(app, run_id, paths, app_data_directory, force);

    Ok(start)
}

/// Resolve the ffmpeg executable pair `start_capability_probe` reports to the frontend: the
/// configured path from settings, if any, ahead of `PATH` and the application data directory
/// per ADR 005's resolution order.
///
/// This is a named function, not two lines inlined into the `spawn_blocking` closure, so the
/// composition it performs -- reading `settings::configured_ffmpeg_path` and feeding it into
/// `ffmpeg::discover` -- has a call site a test can exercise directly, rather than only through
/// `settings::mod`'s own composition test of the two functions in isolation.
fn discover_for_probe(app_data_directory: &Path) -> Result<FfmpegPaths, LocateError> {
    let configured = settings::configured_ffmpeg_path(app_data_directory);
    ffmpeg::discover(configured.as_deref(), app_data_directory)
}

/// Start the background worker that runs one capability probe and reports it through
/// [`EVENT_NAME`].
fn spawn_probe_worker(
    app: tauri::AppHandle,
    run_id: String,
    paths: FfmpegPaths,
    app_data_directory: PathBuf,
    force: bool,
) {
    // Cloned before the `move` closure below takes the originals: a spawn failure drops
    // that closure, and with it every value it captured, so these clones are the only copies
    // still available to report the failure through `emit_failed`.
    let failure_app = app.clone();
    let failure_run_id = run_id.clone();
    let spawn_result = std::thread::Builder::new()
        .name("capability-probe".to_owned())
        .spawn(move || {
            run_probe_worker(&app, &run_id, &paths, &app_data_directory, force);
        });
    // The command already returned its success payload by the time this runs, so a failure
    // to start the thread itself has no rejection path left to use. This is reachable only
    // under extreme resource exhaustion. It still has an event path, though: without this,
    // the status bar would sit on "probing" forever with no error ever emitted.
    if spawn_result.is_err() {
        emit_failed(
            &failure_app,
            &failure_run_id,
            CapabilityProbeErrorCode::CommandExecutionFailed,
            None,
            None,
            None,
        );
    }
}

/// Run one capability probe end to end and report it through [`EVENT_NAME`].
///
/// `-version` runs exactly once, inside [`capabilities::probe_capabilities_with`]. This
/// worker learns the version and licence flags through `on_located`, the callback the
/// orchestrator invokes immediately after parsing them, on both the cache-hit and
/// full-probe paths, before it ever looks the fingerprint up in the cache. That single call
/// site is what emits ADR 006's `located` event first: a second, independent `-version` call
/// here would cost an extra process spawn on every run, two on a cache hit, and could
/// observe a different binary than the one the cache key and the report end up describing if
/// it were replaced between the two spawns.
fn run_probe_worker(
    app: &tauri::AppHandle,
    run_id: &str,
    paths: &FfmpegPaths,
    app_data_directory: &Path,
    force: bool,
) {
    // Holds the exit code and stderr detail from a listing failure, if `run_list` ever hits
    // one, so the `Err(code)` arm below can still forward them to `emit_failed` even though
    // the orchestrator's `RunList` bound only carries the plain error code onward.
    let listing_failure: RefCell<Option<ListingFailure>> = RefCell::new(None);
    let run_list = run_list_capturing_failure(&paths.ffmpeg, &listing_failure);

    let on_located = |version_info: &VersionInfo, license: LicenseFlags| {
        emit_event(
            app,
            CapabilityProbeEvent::Located {
                run_id: run_id.to_owned(),
                ffmpeg: path_to_string(&paths.ffmpeg),
                ffprobe: path_to_string(&paths.ffprobe),
                origin: paths.origin,
                version: version_info.version.clone(),
                license,
            },
        );
    };

    let emit_result = |result: &EncoderResult, done: u32, total: u32| {
        emit_event(
            app,
            CapabilityProbeEvent::Result {
                run_id: run_id.to_owned(),
                result: result.clone(),
                done,
                total,
            },
        );
    };

    // Set to `false` the moment a smoke test raises an I/O error (file-descriptor
    // exhaustion, the binary removed mid-probe) rather than reporting a real encoder
    // outcome. `run_smoke` cannot change its return type to carry that distinction -- the
    // orchestrator's `RunSmoke` bound is a plain `Fn(&str, CodecKind) -> SmokeReport` --
    // so this `Cell` is the side channel: `run_smoke` sets it, and the orchestrator reads it
    // right before it would cache the report. A transient failure must never be pinned to
    // the cache key as if it were a permanent verdict.
    let allow_cache_write = Cell::new(true);
    let run_smoke = |encoder: &str, kind: CodecKind| -> SmokeReport {
        match capabilities::run_smoke_report(&paths.ffmpeg, encoder, kind) {
            Ok(report) => report,
            Err(_) => {
                allow_cache_write.set(false);
                SmokeReport {
                    status: EncoderStatus::Failed,
                    exit_code: None,
                    detail: None,
                }
            }
        }
    };

    match capabilities::probe_capabilities_with(
        ProbeRequest {
            ffmpeg: &paths.ffmpeg,
            app_data_directory,
            force,
            now_unix_seconds: current_unix_seconds(),
            allow_cache_write: &allow_cache_write,
        },
        run_list,
        on_located,
        run_smoke,
        emit_result,
    ) {
        Ok(capabilities::ProbeOutcome { report, source }) => {
            emit_event(
                app,
                CapabilityProbeEvent::Finished {
                    run_id: run_id.to_owned(),
                    report,
                    source,
                },
            );
        }
        Err(code) => {
            let (detail, exit_code) = match listing_failure.into_inner() {
                Some(failure) => (failure.detail, failure.exit_code),
                None => (None, None),
            };
            emit_failed(app, run_id, code, detail, exit_code, None);
        }
    }
}

/// The detail captured when [`run_ffmpeg_listing`] fails: the stable error code the wire
/// contract requires, plus whatever diagnostic the failed process left behind.
#[derive(Debug)]
struct ListingFailure {
    code: CapabilityProbeErrorCode,
    /// The process's exit code, when it ran to completion but reported failure. Absent for
    /// a process that never spawned at all.
    exit_code: Option<i32>,
    /// A short diagnostic for a failed listing, such as a stderr tail.
    detail: Option<String>,
}

/// Spawn `ffmpeg` with `args` and capture its stdout as UTF-8 text, lossily.
///
/// This is the only place in this module that spawns `ffmpeg` for a listing command, so
/// `-version`, `-encoders`, and `-hwaccels` all share one mapping from a process failure to
/// a stable error code, an exit code, and a stderr tail.
fn run_ffmpeg_listing(ffmpeg: &Path, args: &[&str]) -> Result<String, ListingFailure> {
    let output = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|_| ListingFailure {
            code: CapabilityProbeErrorCode::FfmpegSpawnFailed,
            exit_code: None,
            detail: None,
        })?;

    if !output.status.success() {
        return Err(ListingFailure {
            code: CapabilityProbeErrorCode::FfmpegProcessFailed,
            exit_code: output.status.code(),
            detail: capabilities::stderr_tail(&output.stderr, 512),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Adapt [`run_ffmpeg_listing`]'s richer failure into the plain error code
/// [`capabilities::probe_capabilities_with`]'s `RunList` bound expects, while stashing the
/// exit code and stderr detail a failure carries into `failure` so the caller's `Err(code)`
/// arm can still forward them to `emit_failed` once the orchestrator's own error reaches it.
fn run_list_capturing_failure<'a>(
    ffmpeg: &'a Path,
    failure: &'a RefCell<Option<ListingFailure>>,
) -> impl Fn(&[&str]) -> Result<String, CapabilityProbeErrorCode> + 'a {
    move |args: &[&str]| match run_ffmpeg_listing(ffmpeg, args) {
        Ok(stdout) => Ok(stdout),
        Err(listing_failure) => {
            let code = listing_failure.code;
            *failure.borrow_mut() = Some(listing_failure);
            Err(code)
        }
    }
}

fn emit_failed(
    app: &tauri::AppHandle,
    run_id: &str,
    code: CapabilityProbeErrorCode,
    detail: Option<String>,
    exit_code: Option<i32>,
    inspected: Option<Vec<InspectedCandidate>>,
) {
    emit_event(
        app,
        CapabilityProbeEvent::Failed {
            run_id: run_id.to_owned(),
            code,
            detail,
            exit_code,
            inspected,
        },
    );
}

fn emit_event(app: &tauri::AppHandle, event: CapabilityProbeEvent) {
    // A failed emit means no webview is listening, for example because the window closed
    // mid-probe. ADR 006 does not cancel a probe for that: the worker keeps running to
    // completion regardless, so this failure is discarded rather than propagated.
    let _ = app.emit(EVENT_NAME, event);
}

fn map_locate_error(error: LocateError) -> CapabilityProbeError {
    match error {
        LocateError::NotFound { inspected } => CapabilityProbeError {
            code: CapabilityProbeErrorCode::FfmpegPairMissing,
            detail: None,
            exit_code: None,
            inspected: Some(
                inspected
                    .into_iter()
                    .map(InspectedCandidate::from)
                    .collect(),
            ),
        },
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn current_unix_seconds() -> i64 {
    // The frontend's `isPositiveU32` check rejects `probedAt: 0` outright, which would
    // silently drop the `finished` event and hang the status bar on "probing" forever. `1`
    // is a floor for the same clock-error case a real clock is never actually going to hit,
    // not a value anyone reads as a real timestamp.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_encoder_result() -> EncoderResult {
        EncoderResult {
            name: "libx264".to_owned(),
            kind: CodecKind::Video,
            listed: true,
            status: EncoderStatus::Works,
            exit_code: None,
            detail: None,
        }
    }

    fn sample_report() -> CapabilityReport {
        CapabilityReport {
            version: "9.0.1".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: false,
            },
            hwaccels: vec!["videotoolbox".to_owned()],
            encoders: vec![sample_encoder_result()],
            probed_at: 1_700_000_000,
        }
    }

    #[test]
    fn located_event_serializes_with_the_event_tag_and_camel_case_run_id() {
        let event = CapabilityProbeEvent::Located {
            run_id: "1-0".to_owned(),
            ffmpeg: "/usr/bin/ffmpeg".to_owned(),
            ffprobe: "/usr/bin/ffprobe".to_owned(),
            origin: ExecutableOrigin::Path,
            version: "9.0.1".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: false,
            },
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["event"], "located");
        assert_eq!(value["runId"], "1-0");
        assert!(value.get("run_id").is_none());
        assert_eq!(value["origin"], "path");
    }

    #[test]
    fn result_event_keeps_the_nested_encoder_results_own_kind_field() {
        let event = CapabilityProbeEvent::Result {
            run_id: "1-0".to_owned(),
            result: sample_encoder_result(),
            done: 1,
            total: 12,
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["event"], "result");
        assert_eq!(value["runId"], "1-0");
        assert_eq!(value["result"]["kind"], "video");
        assert_eq!(value["done"], 1);
        assert_eq!(value["total"], 12);
        // The outer tag stays "event"; it is never lifted to "kind", which would collide
        // with EncoderResult's own "kind" field one level down. See the module doc comment.
        assert!(value.get("kind").is_none());
    }

    #[test]
    fn finished_event_serializes_the_source_and_the_full_report() {
        let event = CapabilityProbeEvent::Finished {
            run_id: "1-0".to_owned(),
            report: sample_report(),
            source: CapabilityProbeSource::Cache,
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["event"], "finished");
        assert_eq!(value["runId"], "1-0");
        assert_eq!(value["source"], "cache");
        assert_eq!(value["report"]["probedAt"], 1_700_000_000);
    }

    #[test]
    fn failed_event_omits_absent_optional_fields_entirely_not_as_null() {
        let event = CapabilityProbeEvent::Failed {
            run_id: "1-0".to_owned(),
            code: CapabilityProbeErrorCode::FfmpegPairMissing,
            detail: None,
            exit_code: None,
            inspected: None,
        };

        let value = serde_json::to_value(&event).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(value["event"], "failed");
        assert_eq!(value["code"], "ffmpegPairMissing");
        assert!(!object.contains_key("detail"));
        assert!(!object.contains_key("exitCode"));
        assert!(!object.contains_key("inspected"));
    }

    #[test]
    fn failed_event_includes_present_optional_fields_camel_cased() {
        let event = CapabilityProbeEvent::Failed {
            run_id: "1-0".to_owned(),
            code: CapabilityProbeErrorCode::FfmpegProcessFailed,
            detail: Some("stderr tail".to_owned()),
            exit_code: Some(1),
            inspected: Some(vec![InspectedCandidate {
                ffmpeg: "/opt/homebrew/bin/ffmpeg".to_owned(),
                ffprobe: "/opt/homebrew/bin/ffprobe".to_owned(),
                origin: ExecutableOrigin::Path,
            }]),
        };

        let value = serde_json::to_value(&event).unwrap();

        assert_eq!(value["detail"], "stderr tail");
        assert_eq!(value["exitCode"], 1);
        assert_eq!(value["inspected"][0]["ffmpeg"], "/opt/homebrew/bin/ffmpeg");
        assert_eq!(value["inspected"][0]["origin"], "path");
    }

    #[test]
    fn executable_origin_serializes_to_the_three_wire_strings() {
        assert_eq!(
            serde_json::to_value(ExecutableOrigin::Configured).unwrap(),
            "configured"
        );
        assert_eq!(
            serde_json::to_value(ExecutableOrigin::Path).unwrap(),
            "path"
        );
        assert_eq!(
            serde_json::to_value(ExecutableOrigin::AppData).unwrap(),
            "appData"
        );
    }

    #[test]
    fn capability_probe_error_omits_absent_fields_and_keeps_camel_case() {
        let error = CapabilityProbeError::new(CapabilityProbeErrorCode::AppDataUnavailable);

        let value = serde_json::to_value(&error).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(value["code"], "appDataUnavailable");
        assert!(!object.contains_key("detail"));
        assert!(!object.contains_key("exitCode"));
        assert!(!object.contains_key("inspected"));
    }

    #[test]
    fn capability_probe_start_serializes_camel_case_run_id() {
        let start = CapabilityProbeStart {
            run_id: "42-7".to_owned(),
            ffmpeg: "/usr/bin/ffmpeg".to_owned(),
            ffprobe: "/usr/bin/ffprobe".to_owned(),
            origin: ExecutableOrigin::AppData,
        };

        let value = serde_json::to_value(&start).unwrap();

        assert_eq!(value["runId"], "42-7");
        assert!(value.get("run_id").is_none());
        assert_eq!(value["origin"], "appData");
    }

    #[test]
    fn run_ffmpeg_listing_maps_a_spawn_failure_to_the_stable_code() {
        let missing = Path::new("/does/not/exist/ffmpeg-quipclip-test-binary");

        let error = run_ffmpeg_listing(missing, &["-version"]).unwrap_err();

        assert_eq!(error.code, CapabilityProbeErrorCode::FfmpegSpawnFailed);
        // A process that never spawned at all has no exit code and no stderr to tail.
        assert!(error.exit_code.is_none());
        assert!(error.detail.is_none());
    }

    #[test]
    fn run_ffmpeg_listing_maps_a_nonzero_exit_to_the_stable_code_with_detail() {
        // The current test binary stands in for a "found but broken" ffmpeg: it spawns
        // fine and exits non-zero on an argument it does not recognize, on every platform
        // this crate targets, with no dependency on a real ffmpeg being installed.
        let program = std::env::current_exe().unwrap();

        let error = run_ffmpeg_listing(&program, &["--this-flag-does-not-exist"]).unwrap_err();

        assert_eq!(error.code, CapabilityProbeErrorCode::FfmpegProcessFailed);
        assert!(error.exit_code.is_some());
        assert!(error.detail.is_some());
    }

    #[test]
    fn a_listing_failure_propagates_its_detail_for_emit_failed() {
        // Exercises the exact adaptor `run_probe_worker` wires into
        // `capabilities::probe_capabilities_with`'s `RunList` bound: the orchestrator only
        // ever sees the plain error code, but the exit code and stderr tail must still land
        // in `failure_slot` so the caller's `Err(code)` arm can forward them to
        // `emit_failed`.
        let program = std::env::current_exe().unwrap();
        let failure_slot: RefCell<Option<ListingFailure>> = RefCell::new(None);
        let run_list = run_list_capturing_failure(&program, &failure_slot);

        let code = run_list(&["--this-flag-does-not-exist"]).unwrap_err();

        assert_eq!(code, CapabilityProbeErrorCode::FfmpegProcessFailed);
        let captured = failure_slot.borrow();
        let captured = captured.as_ref().expect("a failure must be captured");
        assert_eq!(captured.code, CapabilityProbeErrorCode::FfmpegProcessFailed);
        assert!(captured.exit_code.is_some());
        assert!(captured.detail.is_some());
    }

    #[test]
    fn map_locate_error_carries_the_inspected_list() {
        let inspected = vec![InspectedLocation {
            ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe: PathBuf::from("/usr/bin/ffprobe"),
            origin: ExecutableOrigin::Path,
        }];

        let error = map_locate_error(LocateError::NotFound {
            inspected: inspected.clone(),
        });

        assert_eq!(error.code, CapabilityProbeErrorCode::FfmpegPairMissing);
        assert_eq!(
            error.inspected,
            Some(
                inspected
                    .into_iter()
                    .map(InspectedCandidate::from)
                    .collect::<Vec<_>>()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_candidate_path_does_not_fail_the_rest_of_the_inspected_list() {
        // A reviewer verified serde's actual behaviour on a raw `PathBuf` here: it neither
        // panics nor silently succeeds, it returns `Err("path contains invalid UTF-8
        // characters")` for the WHOLE vector. `map_locate_error` must down-convert every
        // path with `to_string_lossy` before that vector ever reaches serde, so one bad
        // candidate -- entirely plausible on Windows, from an unpaired surrogate in a
        // `PATH` entry -- can never take the rejection's whole search list down with it.
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let invalid_utf8 = OsStr::from_bytes(&[0x66, 0x66, 0xFF, 0x66, 0x65]); // "ff\xFFfe"
        let inspected = vec![
            InspectedLocation {
                ffmpeg: PathBuf::from("/usr/bin/ffmpeg"),
                ffprobe: PathBuf::from("/usr/bin/ffprobe"),
                origin: ExecutableOrigin::Path,
            },
            InspectedLocation {
                ffmpeg: PathBuf::from(invalid_utf8),
                ffprobe: PathBuf::from("/opt/broken/ffprobe"),
                origin: ExecutableOrigin::AppData,
            },
        ];

        let error = map_locate_error(LocateError::NotFound { inspected });

        let value = serde_json::to_value(&error).expect(
            "a non-UTF-8 candidate must still serialize: to_string_lossy never fails, \
             unlike PathBuf's own Serialize impl",
        );

        let inspected_json = value["inspected"].as_array().unwrap();
        assert_eq!(inspected_json.len(), 2);
        assert_eq!(inspected_json[0]["ffmpeg"], "/usr/bin/ffmpeg");
        assert_eq!(inspected_json[0]["origin"], "path");
        assert_eq!(inspected_json[1]["ffprobe"], "/opt/broken/ffprobe");
        assert_eq!(inspected_json[1]["origin"], "appData");
        // The lossy conversion replaces the invalid byte with U+FFFD; the point is that it
        // is present as *some* string at all, not panicked away or dropped.
        assert!(inspected_json[1]["ffmpeg"]
            .as_str()
            .unwrap()
            .contains('\u{FFFD}'));
    }

    // Fake executable names, following the same platform `cfg` split `ffmpeg::locate` and
    // `settings::mod`'s own composition test use for their private `FFMPEG_NAME`/
    // `FFPROBE_NAME` equivalents.
    #[cfg(windows)]
    const FAKE_FFMPEG_NAME: &str = "ffmpeg.exe";
    #[cfg(not(windows))]
    const FAKE_FFMPEG_NAME: &str = "ffmpeg";
    #[cfg(windows)]
    const FAKE_FFPROBE_NAME: &str = "ffprobe.exe";
    #[cfg(not(windows))]
    const FAKE_FFPROBE_NAME: &str = "ffprobe";

    /// Create a fake executable file: a plain file on Windows, a file with the execute
    /// permission bit set on Unix, mirroring `settings::mod`'s own
    /// `create_fake_executable` test helper. The file never runs; discovery only checks that
    /// it exists and, on Unix, that it is executable.
    fn create_fake_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::File::create(path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn discover_for_probe_resolves_the_configured_path_written_to_settings() {
        let base = std::env::temp_dir().join(format!(
            "quipclip-discover-for-probe-{}-{}",
            std::process::id(),
            next_run_id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // A fake ffmpeg/ffprobe pair the configured path will point at. This proves the real
        // call site `start_capability_probe` uses -- `discover_for_probe`, wired to the real
        // `ffmpeg::discover` -- actually reaches a configured entry, with no injected `PATH`
        // and no real ffmpeg required: `discover_with_path` pushes the configured candidate
        // first, and the first accepted candidate wins regardless of what else is on `PATH`.
        let configured = base.join("configured");
        std::fs::create_dir_all(&configured).unwrap();
        create_fake_executable(&configured.join(FAKE_FFMPEG_NAME));
        create_fake_executable(&configured.join(FAKE_FFPROBE_NAME));

        let app_data = base.join("app-data");
        let settings = crate::settings::Settings {
            schema_version: crate::settings::CURRENT_SCHEMA_VERSION,
            ffmpeg_path: Some(configured.to_string_lossy().into_owned()),
            presets: vec![],
            active_preset_id: None,
        };
        crate::settings::save(&app_data, &settings).unwrap();

        let found = discover_for_probe(&app_data).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Configured);
        assert_eq!(
            found.ffmpeg,
            configured.join(FAKE_FFMPEG_NAME).canonicalize().unwrap()
        );
        assert_eq!(
            found.ffprobe,
            configured.join(FAKE_FFPROBE_NAME).canonicalize().unwrap()
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
