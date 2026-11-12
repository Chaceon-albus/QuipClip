//! The commands of the download of `ffmpeg` (ADR 059). Only the Settings window calls them.
//!
//! [`ffmpeg_download_offer`] says whether the FFmpeg tab may offer the download, and with what
//! version, host, licence, size and directory. [`start_ffmpeg_install`] checks the same rule
//! again, takes the one slot, and runs the install on an OS thread of its own. The job sends its
//! progress and its end through a channel. [`cancel_ffmpeg_install`] cancels it.

use crate::app_cache;
use crate::app_cache::work::{
    remove_stale_work_directories, WorkDirectory, FFMPEG_INSTALL_WORK_DIRECTORY,
};
use crate::ffmpeg::capabilities::smoke::CommandOutcome;
use crate::ffmpeg::install::download::{Cancel, Fetch, HttpFetch};
use crate::ffmpeg::install::manifest::{self, Target};
use crate::ffmpeg::install::registry::{InstallHandle, InstallJobs, Refusal};
use crate::ffmpeg::install::steps::{
    self, check_pair, pair_is_in, run_version, sweep_bin, Install, InstallFailure, Phase,
    STALE_TEMPORARY_FILE_AGE,
};
use crate::ffmpeg::install::InstallErrorCode;
use crate::ffmpeg::{self, locate, FfmpegPaths, LicenseFlags, LocateError};
use crate::settings;
use serde::Serialize;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// The shortest time between two progress messages of the download.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// The offer of the download for the consent dialog (ADR 059, "The consent").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegDownloadOffer {
    pub version: String,
    /// The host that the dialog names.
    pub source: String,
    pub license: LicenseFlags,
    /// The total size of the archives in bytes.
    pub download_size: u64,
    /// The directory that the install writes, `<local_data>/bin`.
    pub directory: String,
    /// True when the install replaces a pair in that directory that fails the version check.
    pub replaces: bool,
}

/// The refusal of a command, and the failure of an install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInstallError {
    pub code: InstallErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<InstallFailure> for FfmpegInstallError {
    fn from(failure: InstallFailure) -> Self {
        Self {
            code: failure.code,
            detail: failure.detail,
        }
    }
}

fn error(code: InstallErrorCode) -> FfmpegInstallError {
    FfmpegInstallError { code, detail: None }
}

fn error_with(code: InstallErrorCode, detail: impl ToString) -> FfmpegInstallError {
    FfmpegInstallError {
        code,
        detail: Some(detail.to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartFfmpegInstallResult {
    pub job_id: u64,
}

/// The step of a progress message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PhaseName {
    Download,
    Extract,
    Check,
    Install,
}

/// How an install ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Installed,
    Failed,
    Canceled,
}

/// One message of the channel of an install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallMessage {
    Progress {
        phase: PhaseName,
        /// The bytes of all the archives so far, for the download.
        #[serde(skip_serializing_if = "Option::is_none")]
        received: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    End {
        outcome: Outcome,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<FfmpegInstallError>,
    },
}

/// The page side of an install: a Tauri channel in the application, a list in the tests.
pub trait InstallSink: Send + Sync {
    fn send(&self, message: &InstallMessage);
}

struct ChannelSink(Channel<InvokeResponseBody>);

impl InstallSink for ChannelSink {
    fn send(&self, message: &InstallMessage) {
        if let Ok(json) = serde_json::to_string(message) {
            // A page that went away cannot read the message, and the job goes on to its end.
            let _ = self.0.send(InvokeResponseBody::Json(json));
        }
    }
}

/// What the rule of ADR 059 decides for the download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OfferState {
    /// This build of QuipClip has no download.
    Unsupported,
    /// Tauri gives no data directory or no local data directory.
    NoDataDirectory,
    /// Tauri gives no cache directory.
    NoCache,
    /// Discovery finds a pair that the download must not replace.
    Found,
    /// The download may run. `replaces` is true for a damaged pair in `<local_data>/bin`.
    Offer { replaces: bool },
}

/// The rule of ADR 059, "When QuipClip offers the download". `discovered` is `None` when Tauri
/// gives no data directory, so discovery could not run. `works` runs the version check of a pair
/// that discovery found, and runs only for a pair in `bin`.
fn offer_state(
    target: Option<&Target>,
    bin: Option<&Path>,
    cache_available: bool,
    discovered: Option<&Result<FfmpegPaths, LocateError>>,
    works: &dyn Fn(&FfmpegPaths) -> bool,
) -> OfferState {
    if target.is_none() {
        return OfferState::Unsupported;
    }
    // Without the data directory, discovery cannot search `PATH` and the configured path the way
    // the probe does, and the probe then refuses to run (`appDataUnavailable`). So no download.
    let (Some(bin), Some(discovered)) = (bin, discovered) else {
        return OfferState::NoDataDirectory;
    };
    if !cache_available {
        return OfferState::NoCache;
    }
    match discovered {
        Err(LocateError::NotFound { .. }) => OfferState::Offer { replaces: false },
        Ok(paths) if pair_is_in(&paths.ffmpeg, &paths.ffprobe, bin) && !works(paths) => {
            OfferState::Offer { replaces: true }
        }
        Ok(_) => OfferState::Found,
    }
}

/// The directories and the discovery that the rule needs, read from the application.
struct Situation {
    bin: Option<PathBuf>,
    cache_root: Option<PathBuf>,
    /// `None` when Tauri gives no data directory.
    discovered: Option<Result<FfmpegPaths, LocateError>>,
}

fn situation(app: &AppHandle) -> Situation {
    let discovered = app.path().app_data_dir().ok().map(|app_data| {
        let configured = settings::configured_ffmpeg_path(&app_data);
        ffmpeg::discover(configured.as_deref(), &app_data)
    });
    Situation {
        bin: locate::download_directory(),
        cache_root: app.path().app_cache_dir().ok(),
        discovered,
    }
}

/// The rule for `situation`. `cancel` stops the version check of a pair in `bin`. A stopped check
/// reads as a failed one, so the caller must test `cancel` after the rule.
fn state_of(situation: &Situation, target: Option<&Target>, cancel: Option<&Cancel>) -> OfferState {
    offer_state(
        target,
        situation.bin.as_deref(),
        situation.cache_root.is_some(),
        situation.discovered.as_ref(),
        &|paths| check_pair(&run_version, &paths.ffmpeg, &paths.ffprobe, cancel).is_ok(),
    )
}

/// The offer of the download, or `None` when the FFmpeg tab may not offer it.
#[tauri::command]
pub async fn ffmpeg_download_offer(
    app: AppHandle,
) -> Result<Option<FfmpegDownloadOffer>, FfmpegInstallError> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = manifest::current_target()?;
        let situation = situation(&app);
        let OfferState::Offer { replaces } = state_of(&situation, Some(target), None) else {
            return None;
        };
        Some(FfmpegDownloadOffer {
            version: target.version.clone(),
            source: target.source.clone(),
            license: target.license,
            download_size: target.download_size(),
            directory: situation.bin?.display().to_string(),
            replaces,
        })
    })
    .await
    .map_err(|failure| error_with(InstallErrorCode::CommandExecutionFailed, failure))
}

/// Start the install. `sequence` is the time of the request in microseconds since the Unix
/// epoch, and it rises with each request of the page, as the requests of the envelope jobs do
/// (ADR 056). The start can take some seconds, for the version check of a damaged pair and the
/// sweeps, before it gives the id of the job.
#[tauri::command]
pub async fn start_ffmpeg_install(
    app: AppHandle,
    jobs: State<'_, Arc<InstallJobs>>,
    sequence: u64,
    channel: Channel<InvokeResponseBody>,
) -> Result<StartFfmpegInstallResult, FfmpegInstallError> {
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = manifest::current_target();
        start(
            &jobs,
            sequence,
            target.cloned(),
            |cancel| {
                let situation = situation(&app);
                let state = state_of(&situation, target, Some(cancel));
                (situation, state)
            },
            || {
                HttpFetch::new()
                    .map_err(|failure| error_with(InstallErrorCode::NetworkFailed, failure))
            },
            Tools::APPLICATION,
            Arc::new(ChannelSink(channel)),
        )
    })
    .await
    .map_err(|failure| error_with(InstallErrorCode::CommandExecutionFailed, failure))?
}

/// Cancel install `job_id`. The job ends soon and sends its end through its channel. A cancel
/// during the last move is not seen, and the install then ends as installed (ADR 059).
#[tauri::command]
pub fn cancel_ffmpeg_install(jobs: State<'_, Arc<InstallJobs>>, job_id: u64) {
    jobs.cancel(job_id);
}

/// The programs that an install runs and the move that it makes. Tests give fakes.
#[derive(Clone, Copy)]
struct Tools {
    run_version: fn(&Path, Option<&AtomicBool>) -> io::Result<CommandOutcome>,
    replace: fn(&Path, &Path) -> io::Result<()>,
}

impl Tools {
    const APPLICATION: Self = Self {
        run_version,
        replace: steps::replace,
    };
}

/// Frees the slot of an install when it drops, also after a panic.
struct Slot<'a> {
    jobs: &'a InstallJobs,
    id: u64,
    armed: bool,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.jobs.finish(self.id);
        }
    }
}

fn refused(refusal: Refusal) -> FfmpegInstallError {
    error(match refusal {
        Refusal::Busy => InstallErrorCode::Busy,
        Refusal::Superseded | Refusal::Closed => InstallErrorCode::Canceled,
    })
}

/// The body of [`start_ffmpeg_install`], with the target, the rule, the fetch, the tools and the
/// sink passed in.
///
/// The request takes the slot first and holds it while `assess` applies the rule. So a request
/// gets `busy` before the version check of a damaged pair, and the rule cannot pass for a pair
/// that a running install replaces in the meantime. A refusal frees the slot. `make_fetch` runs
/// last, so its failure hides no refusal.
///
/// `assess` gets the cancel of the request, so a reload or a close of the Settings window stops
/// its version check. The request then ends as canceled, not with the result of the stopped
/// check.
fn start<F: Fetch + Send + 'static>(
    jobs: &Arc<InstallJobs>,
    sequence: u64,
    target: Option<Target>,
    assess: impl FnOnce(&Cancel) -> (Situation, OfferState),
    make_fetch: impl FnOnce() -> Result<F, FfmpegInstallError>,
    tools: Tools,
    sink: Arc<dyn InstallSink>,
) -> Result<StartFfmpegInstallResult, FfmpegInstallError> {
    let handle = jobs.begin(sequence).map_err(refused)?;
    let mut slot = Slot {
        jobs,
        id: handle.id,
        armed: true,
    };

    let (situation, state) = assess(handle.cancel());
    if handle.cancel().is_canceled() {
        return Err(error(InstallErrorCode::Canceled));
    }
    match state {
        OfferState::Unsupported => return Err(error(InstallErrorCode::UnsupportedTarget)),
        OfferState::NoDataDirectory => return Err(error(InstallErrorCode::AppDataUnavailable)),
        OfferState::NoCache => return Err(error(InstallErrorCode::WorkDirectoryUnavailable)),
        OfferState::Found => return Err(error(InstallErrorCode::AlreadyFound)),
        OfferState::Offer { .. } => {}
    }
    let target = target.ok_or_else(|| error(InstallErrorCode::UnsupportedTarget))?;
    let bin = situation
        .bin
        .ok_or_else(|| error(InstallErrorCode::AppDataUnavailable))?;
    let cache_root = situation
        .cache_root
        .ok_or_else(|| error(InstallErrorCode::WorkDirectoryUnavailable))?;
    let fetch = make_fetch()?;

    // Steps 5 and 6 of the cleanup at start of ADR 057, which ADR 059 also runs before each
    // install.
    let work_parent = app_cache::work_directory(&cache_root);
    remove_stale_work_directories(&work_parent, FFMPEG_INSTALL_WORK_DIRECTORY);
    sweep_bin(&bin, SystemTime::now(), STALE_TEMPORARY_FILE_AGE);
    let work = WorkDirectory::create(&work_parent, FFMPEG_INSTALL_WORK_DIRECTORY)
        .map_err(|failure| error_with(InstallErrorCode::WorkDirectoryUnavailable, failure))?;

    let job_id = handle.id;
    let spawned = {
        let jobs = jobs.clone();
        std::thread::Builder::new()
            .name("ffmpeg-install".to_owned())
            .spawn(move || {
                run_job(
                    &jobs,
                    &handle,
                    &target,
                    work,
                    &bin,
                    &fetch,
                    tools,
                    sink.as_ref(),
                );
            })
    };
    if let Err(failure) = spawned {
        return Err(error_with(
            InstallErrorCode::CommandExecutionFailed,
            failure,
        ));
    }
    // The job thread owns the slot now, and frees it when the install ends.
    slot.armed = false;
    Ok(StartFfmpegInstallResult { job_id })
}

/// The thread of one install: run it, remove its work directory, free the slot, and send the end
/// last, so a page that starts again at the end finds the slot free and the disk clean (ADR 059,
/// step 6). A panic of the install ends it as failed, and the slot is free in every case.
#[allow(clippy::too_many_arguments)]
fn run_job<F: Fetch>(
    jobs: &InstallJobs,
    handle: &InstallHandle,
    target: &Target,
    work: WorkDirectory,
    bin: &Path,
    fetch: &F,
    tools: Tools,
    sink: &dyn InstallSink,
) {
    let slot = Slot {
        jobs,
        id: handle.id,
        armed: true,
    };
    let mut throttle = Throttle::default();
    let result = catch_unwind(AssertUnwindSafe(|| {
        steps::run(
            &Install {
                fetch,
                target,
                work: &work,
                bin,
                cancel: handle.cancel(),
                run_version: &tools.run_version,
                replace: &tools.replace,
            },
            &mut |phase| {
                if let Some(message) = throttle.message(phase, Instant::now()) {
                    sink.send(&message);
                }
            },
        )
    }));
    // The result of the install, not the cancel flag: a cancel during the last move is not seen,
    // and the programs are then in place (ADR 059).
    let end = match result {
        Ok(Ok(())) => InstallMessage::End {
            outcome: Outcome::Installed,
            error: None,
        },
        Ok(Err(failure)) if failure.code == InstallErrorCode::Canceled => InstallMessage::End {
            outcome: Outcome::Canceled,
            error: None,
        },
        Ok(Err(failure)) => {
            eprintln!(
                "install: the install failed: {:?} {}",
                failure.code,
                failure.detail.as_deref().unwrap_or_default()
            );
            InstallMessage::End {
                outcome: Outcome::Failed,
                error: Some(failure.into()),
            }
        }
        Err(_) => {
            eprintln!("install: the install stopped on a panic");
            InstallMessage::End {
                outcome: Outcome::Failed,
                error: Some(error_with(
                    InstallErrorCode::CommandExecutionFailed,
                    "the install stopped on an internal error",
                )),
            }
        }
    };
    work.remove();
    drop(slot);
    sink.send(&end);
}

/// Sends a progress message of the download at most once in [`PROGRESS_INTERVAL`], and each
/// other step at once. The first and the last message of the download always go.
#[derive(Default)]
struct Throttle {
    last: Option<Instant>,
}

impl Throttle {
    fn message(&mut self, phase: Phase, now: Instant) -> Option<InstallMessage> {
        let (name, received, total) = match phase {
            Phase::Download { received, total } => {
                let due = self
                    .last
                    .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
                if !due && received != total {
                    return None;
                }
                (PhaseName::Download, Some(received), Some(total))
            }
            Phase::Extract => (PhaseName::Extract, None, None),
            Phase::Check => (PhaseName::Check, None, None),
            Phase::Install => (PhaseName::Install, None, None),
        };
        self.last = Some(now);
        Some(InstallMessage::Progress {
            phase: name,
            received,
            total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::capabilities::smoke::CommandStatus;
    use crate::ffmpeg::install::download::{Body, DownloadError};
    use crate::ffmpeg::install::manifest::{Archive, Entries, Entry, Method, Program};
    use crate::ffmpeg::ExecutableOrigin;
    use crate::flv::test_support::TestDirectory;
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, VecDeque};
    use std::io::{Cursor, Write as _};
    use std::sync::Mutex;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    const URL: &str = "https://example.test/a.zip";

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// One zip that holds both programs under the file names of this platform, and its target.
    fn one_zip() -> (Vec<u8>, Target) {
        let ffmpeg = b"the ffmpeg program".as_slice();
        let ffprobe = b"the ffprobe program".as_slice();
        let zip = zip_of(&[
            (Program::Ffmpeg.file_name(), ffmpeg),
            (Program::Ffprobe.file_name(), ffprobe),
        ]);
        let entry = |program: Program, bytes: &[u8]| Entry {
            path: program.file_name().to_owned(),
            method: Method::Deflate,
            size: bytes.len() as u64,
        };
        let target = Target {
            version: "9.0.2".to_owned(),
            source: "example.test".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: true,
            },
            archives: vec![Archive {
                urls: vec![URL.to_owned()],
                sha256: Sha256::digest(&zip)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                size: zip.len() as u64,
                entries: Entries {
                    ffmpeg: Some(entry(Program::Ffmpeg, ffmpeg)),
                    ffprobe: Some(entry(Program::Ffprobe, ffprobe)),
                },
            }],
        };
        (zip, target)
    }

    /// Serves fixed bytes for each URL. A URL with no bytes waits until the install is
    /// canceled, as a stalled request does.
    struct MemoryFetch(HashMap<String, Vec<u8>>);

    struct MemoryBody(VecDeque<Vec<u8>>);

    impl Body for MemoryBody {
        type Chunk = Vec<u8>;

        async fn chunk(&mut self) -> Result<Option<Vec<u8>>, DownloadError> {
            Ok(self.0.pop_front())
        }
    }

    impl Fetch for MemoryFetch {
        type Body = MemoryBody;

        async fn get(&self, url: &str) -> Result<MemoryBody, DownloadError> {
            match self.0.get(url) {
                Some(bytes) => Ok(MemoryBody(bytes.chunks(7).map(<[u8]>::to_vec).collect())),
                None => std::future::pending().await,
            }
        }
    }

    /// A fetch whose every request fails with an HTTP status.
    struct Refusing;

    impl Fetch for Refusing {
        type Body = MemoryBody;

        async fn get(&self, _: &str) -> Result<MemoryBody, DownloadError> {
            Err(DownloadError::HttpStatus(404))
        }
    }

    fn prints_9_0_2(path: &Path, _: Option<&AtomicBool>) -> io::Result<CommandOutcome> {
        let name = if path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ffprobe")
        {
            "ffprobe"
        } else {
            "ffmpeg"
        };
        Ok(CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(0),
                success: true,
            },
            stderr: Vec::new(),
            stdout: format!(
                "{name} version 9.0.2\nconfiguration: --enable-gpl --enable-version3\n"
            )
            .into_bytes(),
        })
    }

    fn panics(_: &Path, _: Option<&AtomicBool>) -> io::Result<CommandOutcome> {
        panic!("a fault in the version check");
    }

    const TOOLS: Tools = Tools {
        run_version: prints_9_0_2,
        replace: steps::replace,
    };

    #[derive(Default)]
    struct Recorder(Mutex<Vec<InstallMessage>>);

    impl Recorder {
        fn end(&self) -> Option<InstallMessage> {
            self.0
                .lock()
                .unwrap()
                .last()
                .filter(|message| matches!(message, InstallMessage::End { .. }))
                .cloned()
        }
    }

    impl InstallSink for Recorder {
        fn send(&self, message: &InstallMessage) {
            self.0.lock().unwrap().push(message.clone());
        }
    }

    fn situation_in(directory: &TestDirectory) -> Situation {
        Situation {
            bin: Some(directory.path.join("bin")),
            cache_root: Some(directory.path.join("cache")),
            discovered: Some(missing()),
        }
    }

    /// The rule of a situation in which no FFmpeg is found.
    fn offered(directory: &TestDirectory) -> impl FnOnce(&Cancel) -> (Situation, OfferState) + '_ {
        |_| {
            (
                situation_in(directory),
                OfferState::Offer { replaces: false },
            )
        }
    }

    fn missing() -> Result<FfmpegPaths, LocateError> {
        Err(LocateError::NotFound {
            inspected: Vec::new(),
        })
    }

    /// Start an install in `directory` and wait for its end message.
    fn install<F: Fetch + Send + 'static>(
        directory: &TestDirectory,
        jobs: &Arc<InstallJobs>,
        target: Target,
        fetch: F,
        tools: Tools,
    ) -> (StartFfmpegInstallResult, InstallMessage) {
        let recorder = Arc::new(Recorder::default());
        let started = start(
            jobs,
            1,
            Some(target),
            offered(directory),
            || Ok(fetch),
            tools,
            recorder.clone(),
        )
        .unwrap();
        (started, wait_for_end(&recorder))
    }

    fn wait_for_end(recorder: &Recorder) -> InstallMessage {
        let started = Instant::now();
        loop {
            if let Some(end) = recorder.end() {
                return end;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the job never ended"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn work_is_empty(directory: &TestDirectory) -> bool {
        let work = app_cache::work_directory(&directory.path.join("cache"));
        std::fs::read_dir(&work).map_or(true, |mut entries| entries.next().is_none())
    }

    fn pair_in(directory: &Path) -> FfmpegPaths {
        std::fs::create_dir_all(directory).unwrap();
        let ffmpeg = directory.join(locate::FFMPEG_NAME);
        let ffprobe = directory.join(locate::FFPROBE_NAME);
        std::fs::write(&ffmpeg, b"x").unwrap();
        std::fs::write(&ffprobe, b"x").unwrap();
        FfmpegPaths {
            ffmpeg,
            ffprobe,
            origin: ExecutableOrigin::AppData,
        }
    }

    #[test]
    fn the_rule_offers_the_download_only_where_adr_059_allows_it() {
        let directory = TestDirectory::new();
        let bin = directory.path.join("bin");
        let (_, target) = one_zip();
        let works = |_: &FfmpegPaths| true;
        let broken = |_: &FfmpegPaths| false;
        let missing = missing();

        assert_eq!(
            offer_state(None, Some(&bin), true, Some(&missing), &works),
            OfferState::Unsupported
        );
        assert_eq!(
            offer_state(Some(&target), None, true, Some(&missing), &works),
            OfferState::NoDataDirectory
        );
        // With no data directory, discovery could not run, so no download.
        assert_eq!(
            offer_state(Some(&target), Some(&bin), true, None, &works),
            OfferState::NoDataDirectory
        );
        assert_eq!(
            offer_state(Some(&target), Some(&bin), false, Some(&missing), &works),
            OfferState::NoCache
        );
        assert_eq!(
            offer_state(Some(&target), Some(&bin), true, Some(&missing), &works),
            OfferState::Offer { replaces: false }
        );

        // A pair in `bin`: replaced only when it fails the version check.
        let in_bin = Ok(pair_in(&bin));
        assert_eq!(
            offer_state(Some(&target), Some(&bin), true, Some(&in_bin), &works),
            OfferState::Found
        );
        assert_eq!(
            offer_state(Some(&target), Some(&bin), true, Some(&in_bin), &broken),
            OfferState::Offer { replaces: true }
        );

        // A pair elsewhere is never replaced, and its check never runs.
        let elsewhere = Ok(pair_in(&directory.path.join("path")));
        let not_called = |_: &FfmpegPaths| panic!("the check runs only for a pair in bin");
        assert_eq!(
            offer_state(
                Some(&target),
                Some(&bin),
                true,
                Some(&elsewhere),
                &not_called
            ),
            OfferState::Found
        );
    }

    #[test]
    fn a_refused_state_names_its_code_and_frees_the_slot_and_makes_no_client() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (_, target) = one_zip();
        for (state, code) in [
            (OfferState::Unsupported, InstallErrorCode::UnsupportedTarget),
            (
                OfferState::NoDataDirectory,
                InstallErrorCode::AppDataUnavailable,
            ),
            (
                OfferState::NoCache,
                InstallErrorCode::WorkDirectoryUnavailable,
            ),
            (OfferState::Found, InstallErrorCode::AlreadyFound),
        ] {
            let refused = start(
                &jobs,
                1,
                Some(target.clone()),
                |_| {
                    // The rule runs while the request holds the slot.
                    assert!(jobs.running().is_some());
                    (situation_in(&directory), state)
                },
                || -> Result<Refusing, FfmpegInstallError> {
                    panic!("the client is made only after the rule allows the install")
                },
                TOOLS,
                Arc::new(Recorder::default()),
            )
            .unwrap_err();
            assert_eq!(refused.code, code);
            assert_eq!(jobs.running(), None);
        }
    }

    #[test]
    fn a_cancel_during_the_rule_ends_the_request_as_canceled_and_frees_the_slot() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (_, target) = one_zip();
        let refused = start(
            &jobs,
            1,
            Some(target),
            |cancel| {
                // A reload of the Settings window during the version check of a pair in `bin`.
                // The stopped check reads as failed, so the rule offers to replace the pair.
                jobs.cancel_all(2);
                assert!(cancel.is_canceled());
                (
                    situation_in(&directory),
                    OfferState::Offer { replaces: true },
                )
            },
            || -> Result<Refusing, FfmpegInstallError> {
                panic!("the client is made only for a request that goes on")
            },
            TOOLS,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, InstallErrorCode::Canceled);
        assert_eq!(jobs.running(), None);
        assert!(work_is_empty(&directory));
    }

    #[test]
    fn a_work_directory_that_cannot_be_made_refuses_the_install_and_frees_the_slot() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (_, target) = one_zip();
        // A file where the cache directory belongs.
        std::fs::write(directory.path.join("cache"), b"x").unwrap();
        let refused = start(
            &jobs,
            1,
            Some(target),
            offered(&directory),
            || Ok(Refusing),
            TOOLS,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(refused.code, InstallErrorCode::WorkDirectoryUnavailable);
        assert_eq!(jobs.running(), None);
    }

    #[test]
    fn an_install_puts_the_pair_into_bin_and_ends_with_a_clean_disk() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (zip, target) = one_zip();
        let fetch = MemoryFetch(HashMap::from([(URL.to_owned(), zip)]));
        let (started, end) = install(&directory, &jobs, target, fetch, TOOLS);
        assert!(started.job_id > 0);
        assert_eq!(
            end,
            InstallMessage::End {
                outcome: Outcome::Installed,
                error: None
            }
        );
        let bin = directory.path.join("bin");
        assert_eq!(
            std::fs::read(bin.join(Program::Ffmpeg.file_name())).unwrap(),
            b"the ffmpeg program"
        );
        // The end comes after the slot is free and the work directory is gone.
        assert_eq!(jobs.running(), None);
        assert!(work_is_empty(&directory));
    }

    #[test]
    fn a_failed_install_sends_its_error_and_frees_the_slot() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (_, target) = one_zip();
        let (_, end) = install(&directory, &jobs, target, Refusing, TOOLS);
        assert_eq!(
            end,
            InstallMessage::End {
                outcome: Outcome::Failed,
                error: Some(FfmpegInstallError {
                    code: InstallErrorCode::HttpStatus,
                    detail: Some("the server answered 404".to_owned()),
                }),
            }
        );
        assert_eq!(jobs.running(), None);
        assert!(work_is_empty(&directory));
        assert!(!directory.path.join("bin").exists());
    }

    #[test]
    fn a_running_install_holds_the_slot_until_a_cancel_ends_it() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (_, target) = one_zip();
        let recorder = Arc::new(Recorder::default());
        // No bytes for the URL, so the request waits until the cancel.
        let started = start(
            &jobs,
            1,
            Some(target.clone()),
            offered(&directory),
            || Ok(MemoryFetch(HashMap::new())),
            TOOLS,
            recorder.clone(),
        )
        .unwrap();
        // A second request gets `busy` before the rule and its version check run.
        let busy = start(
            &jobs,
            2,
            Some(target),
            |_: &Cancel| -> (Situation, OfferState) { panic!("the rule runs only with the slot") },
            || Ok(MemoryFetch(HashMap::new())),
            TOOLS,
            Arc::new(Recorder::default()),
        )
        .unwrap_err();
        assert_eq!(busy.code, InstallErrorCode::Busy);
        jobs.cancel(started.job_id);
        assert_eq!(
            wait_for_end(&recorder),
            InstallMessage::End {
                outcome: Outcome::Canceled,
                error: None
            }
        );
        assert_eq!(jobs.running(), None);
        assert!(work_is_empty(&directory));
    }

    #[test]
    fn a_panic_of_the_install_ends_it_as_failed_and_frees_the_slot() {
        let directory = TestDirectory::new();
        let jobs = Arc::new(InstallJobs::default());
        let (zip, target) = one_zip();
        let fetch = MemoryFetch(HashMap::from([(URL.to_owned(), zip)]));
        let tools = Tools {
            run_version: panics,
            replace: steps::replace,
        };
        let (_, end) = install(&directory, &jobs, target, fetch, tools);
        assert!(matches!(
            end,
            InstallMessage::End {
                outcome: Outcome::Failed,
                error: Some(FfmpegInstallError {
                    code: InstallErrorCode::CommandExecutionFailed,
                    ..
                }),
            }
        ));
        assert_eq!(jobs.running(), None);
        assert!(work_is_empty(&directory));
        assert!(!directory.path.join("bin").exists());
    }

    #[test]
    fn the_throttle_sends_the_download_at_most_four_times_a_second_and_each_step_at_once() {
        let mut throttle = Throttle::default();
        let start = Instant::now();
        let download = |received| Phase::Download {
            received,
            total: 100,
        };
        assert!(throttle.message(download(0), start).is_some());
        assert!(throttle
            .message(download(10), start + Duration::from_millis(100))
            .is_none());
        assert!(throttle
            .message(download(20), start + Duration::from_millis(260))
            .is_some());
        // The last byte always goes, so the bar reaches its end.
        assert!(throttle
            .message(download(100), start + Duration::from_millis(261))
            .is_some());
        assert_eq!(
            throttle.message(Phase::Check, start + Duration::from_millis(262)),
            Some(InstallMessage::Progress {
                phase: PhaseName::Check,
                received: None,
                total: None,
            })
        );
    }

    #[test]
    fn the_messages_have_the_shape_that_the_page_reads() {
        let progress = InstallMessage::Progress {
            phase: PhaseName::Download,
            received: Some(5),
            total: Some(10),
        };
        assert_eq!(
            serde_json::to_value(&progress).unwrap(),
            serde_json::json!({ "type": "progress", "phase": "download", "received": 5, "total": 10 })
        );
        let step = InstallMessage::Progress {
            phase: PhaseName::Extract,
            received: None,
            total: None,
        };
        assert_eq!(
            serde_json::to_value(&step).unwrap(),
            serde_json::json!({ "type": "progress", "phase": "extract" })
        );
        let failed = InstallMessage::End {
            outcome: Outcome::Failed,
            error: Some(error_with(
                InstallErrorCode::HashMismatch,
                "the file has the SHA-256 x",
            )),
        };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({
                "type": "end",
                "outcome": "failed",
                "error": { "code": "hashMismatch", "detail": "the file has the SHA-256 x" }
            })
        );
        let installed = InstallMessage::End {
            outcome: Outcome::Installed,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&installed).unwrap(),
            serde_json::json!({ "type": "end", "outcome": "installed" })
        );
        assert_eq!(
            serde_json::to_value(error(InstallErrorCode::Busy)).unwrap(),
            serde_json::json!({ "code": "busy" })
        );
        assert_eq!(
            serde_json::to_value(StartFfmpegInstallResult { job_id: 3 }).unwrap(),
            serde_json::json!({ "jobId": 3 })
        );
        let offer = FfmpegDownloadOffer {
            version: "9.0.2".to_owned(),
            source: "github.com/GyanD/codexffmpeg".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: true,
            },
            download_size: 257_736_868,
            directory: "C:\\bin".to_owned(),
            replaces: false,
        };
        assert_eq!(
            serde_json::to_value(&offer).unwrap(),
            serde_json::json!({
                "version": "9.0.2",
                "source": "github.com/GyanD/codexffmpeg",
                "license": { "gpl": true, "nonfree": false, "version3": true },
                "downloadSize": 257_736_868,
                "directory": "C:\\bin",
                "replaces": false
            })
        );
    }
}
