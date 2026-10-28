//! The graph files of an export, and the option probe that finds how `ffmpeg` reads them
//! (ADR 055).
//!
//! The encoder and the audio process of ADR 043 read their filter graphs from files in the work
//! directory of the export: [`ENCODER_GRAPH_FILE`] and [`AUDIO_GRAPH_FILE`]. Two spellings of the
//! option cover every build that can run an export:
//!
//! - FFmpeg 7.0 and later read `-/filter_complex <file>` ([`GraphFileOption::Slash`]).
//! - FFmpeg 2.0 and later read `-filter_complex_script <file>` ([`GraphFileOption::Script`]).
//!   FFmpeg 7.0 deprecated it, and FFmpeg 9.0.2 does not have it.
//!
//! No single spelling works on every build, so [`probe_graph_file_option`] asks the installed
//! `ffmpeg`: it writes [`PROBE_GRAPH_FILE`] into the work directory and runs a null encode of it
//! with the first spelling, then with the second when the first is an unrecognized option. A build
//! that reads neither fails the export with [`ExportErrorCode::GraphFileUnsupported`]. No inline
//! form stays as a fallback.
//!
//! The process keeps each successful answer for each `ffmpeg` binary, by its path, size and
//! modification time. It keeps no failure, so the next export asks again.

use super::work_directory::ExportWorkDirectory;
use super::ExportErrorCode;
use crate::ffmpeg::capabilities::{
    run_with_timeout_in, stderr_tail, CommandOutcome, CommandStatus, RunPlace, StdoutCapture,
    PROBE_DETAIL_LIMIT,
};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

/// The file of the graph of the encoder, in the work directory.
pub const ENCODER_GRAPH_FILE: &str = "encoder.graph";

/// The file of the graph of the audio process of ADR 043, in the work directory.
pub const AUDIO_GRAPH_FILE: &str = "audio.graph";

/// The file of the graph of the option probe, in the work directory.
pub const PROBE_GRAPH_FILE: &str = "probe.graph";

/// The graph of the option probe: one frame of `color`. The stand-in video of the audio process
/// of ADR 043 uses the same source, the `rawvideo` encoder and the `null` muxer, so the probe needs
/// no part of `ffmpeg` that an export does not.
pub const PROBE_GRAPH: &str = "color=s=16x16:d=0.04[v]";

/// The longest time that one run of the option probe can take.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How often a run of the option probe is polled.
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The start of the message of `ffmpeg` for an option that it does not have. The name of the
/// option follows in quotes, without its leading `-`.
const UNRECOGNIZED_OPTION: &str = "Unrecognized option";

/// The option that names the file of a filter graph on the command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphFileOption {
    /// `-/filter_complex <file>`, FFmpeg 7.0 and later.
    Slash,
    /// `-filter_complex_script <file>`, FFmpeg 2.0 and later, removed after the deprecation of 7.0.
    Script,
}

impl GraphFileOption {
    /// The flag of the option, as it goes on the command line.
    #[must_use]
    pub const fn flag(self) -> &'static str {
        match self {
            Self::Slash => "-/filter_complex",
            Self::Script => "-filter_complex_script",
        }
    }
}

/// A graph file as a command names it: the option, then the name of the file in the work
/// directory. The name has no path, because the process runs in the work directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphFile<'a> {
    /// The option that the probe found.
    pub option: GraphFileOption,
    /// The name of the file in the work directory.
    pub name: &'a str,
}

/// A failure of the option probe: an [`ExportErrorCode`] and an optional diagnostic for a bug
/// report (ADR 011).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphFileProbeError {
    /// The code of the failure.
    pub code: ExportErrorCode,
    /// The diagnostic, such as the stderr tail of `ffmpeg`.
    pub detail: Option<String>,
}

impl GraphFileProbeError {
    fn new(code: ExportErrorCode, detail: Option<String>) -> Self {
        Self { code, detail }
    }
}

/// The identity of one `ffmpeg` binary: its path, size and modification time.
type BinaryKey = (PathBuf, u64, SystemTime);

/// The successful answers of the probe in this process, one for each binary.
static PROBE_MEMO: Mutex<Vec<(BinaryKey, GraphFileOption)>> = Mutex::new(Vec::new());

/// Find the [`GraphFileOption`] that `ffmpeg` reads, with `work` as the current directory of the
/// probe. `stop` is the stop flag of preparation: a set flag ends a run of the probe and gives
/// [`ExportErrorCode::Canceled`].
///
/// - A remembered answer for the same binary returns at once, and runs no process.
/// - Exit 0 with `-/filter_complex` gives [`GraphFileOption::Slash`].
/// - A failure with `Unrecognized option` runs the same command with `-filter_complex_script`.
///   Exit 0 gives [`GraphFileOption::Script`], and the same message again gives
///   [`ExportErrorCode::GraphFileUnsupported`].
/// - A process that does not start gives [`ExportErrorCode::FfmpegSpawnFailed`]. Another failure,
///   or no exit after [`PROBE_TIMEOUT`], gives [`ExportErrorCode::FfmpegProcessFailed`].
/// - A write of [`PROBE_GRAPH_FILE`] that fails gives
///   [`ExportErrorCode::WorkDirectoryUnavailable`].
pub fn probe_graph_file_option(
    ffmpeg: &Path,
    work: &ExportWorkDirectory,
    stop: &AtomicBool,
) -> Result<GraphFileOption, GraphFileProbeError> {
    probe_with(ffmpeg, work, stop, &PROBE_MEMO, run_probe)
}

/// One run of the probe command: `ffmpeg` with `arguments`, in `directory`, bounded by
/// [`PROBE_TIMEOUT`] and by `stop`.
fn run_probe(
    ffmpeg: &Path,
    arguments: &[String],
    directory: &Path,
    stop: &AtomicBool,
) -> io::Result<CommandOutcome> {
    run_with_timeout_in(
        ffmpeg,
        arguments,
        PROBE_TIMEOUT,
        PROBE_POLL_INTERVAL,
        StdoutCapture::Discard,
        RunPlace {
            current_directory: Some(directory),
            stop: Some(stop),
        },
    )
}

/// The arguments of the probe with `option`.
fn probe_arguments(option: GraphFileOption) -> Vec<String> {
    [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        option.flag(),
        PROBE_GRAPH_FILE,
        "-map",
        "[v]",
        "-c:v",
        "rawvideo",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|argument| (*argument).to_owned())
    .collect()
}

/// The identity of the binary at `ffmpeg`, or `None` when it has no metadata. A binary without
/// one is probed at each export.
fn binary_key(ffmpeg: &Path) -> Option<BinaryKey> {
    let metadata = std::fs::metadata(ffmpeg).ok()?;
    Some((
        ffmpeg.to_path_buf(),
        metadata.len(),
        metadata.modified().ok()?,
    ))
}

/// What one run of the probe found.
enum Attempt {
    /// The option works.
    Read,
    /// `ffmpeg` does not have the option. The stderr tail is the detail.
    Unrecognized(Option<String>),
}

/// [`probe_graph_file_option`] with the memo and the process runner supplied, so a test needs no
/// `ffmpeg`.
fn probe_with<Run>(
    ffmpeg: &Path,
    work: &ExportWorkDirectory,
    stop: &AtomicBool,
    memo: &Mutex<Vec<(BinaryKey, GraphFileOption)>>,
    mut run: Run,
) -> Result<GraphFileOption, GraphFileProbeError>
where
    Run: FnMut(&Path, &[String], &Path, &AtomicBool) -> io::Result<CommandOutcome>,
{
    let key = binary_key(ffmpeg);
    if let Some(key) = key.as_ref() {
        let known = memo.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, option)) = known.iter().find(|(known, _)| known == key) {
            return Ok(*option);
        }
    }
    let canceled = || stop.load(Ordering::SeqCst);
    if canceled() {
        return Err(GraphFileProbeError::new(ExportErrorCode::Canceled, None));
    }
    work.write(PROBE_GRAPH_FILE, PROBE_GRAPH.as_bytes())
        .map_err(|error| {
            GraphFileProbeError::new(
                ExportErrorCode::WorkDirectoryUnavailable,
                Some(error.to_string()),
            )
        })?;

    let mut attempt = |option: GraphFileOption| -> Result<Attempt, GraphFileProbeError> {
        let outcome = run(ffmpeg, &probe_arguments(option), work.path(), stop);
        // A Stop wins over every other answer: the run that it ended reports a timeout, or a
        // failure of the killed process.
        if canceled() {
            return Err(GraphFileProbeError::new(ExportErrorCode::Canceled, None));
        }
        let outcome = outcome.map_err(|error| {
            GraphFileProbeError::new(ExportErrorCode::FfmpegSpawnFailed, Some(error.to_string()))
        })?;
        let detail = || stderr_tail(&outcome.stderr, PROBE_DETAIL_LIMIT);
        // Only the message for this option counts. An unknown option elsewhere in the command
        // is a fault of the command, not a build without the option.
        let unrecognized = format!(
            "{UNRECOGNIZED_OPTION} '{}'",
            option.flag().trim_start_matches('-')
        );
        match outcome.status {
            CommandStatus::Exited { success: true, .. } => Ok(Attempt::Read),
            CommandStatus::Exited { .. }
                if String::from_utf8_lossy(&outcome.stderr).contains(&unrecognized) =>
            {
                Ok(Attempt::Unrecognized(detail()))
            }
            // A process that dies without a word, for example by a signal, still gets a detail.
            CommandStatus::Exited { code, .. } => Err(GraphFileProbeError::new(
                ExportErrorCode::FfmpegProcessFailed,
                detail().or_else(|| {
                    Some(match code {
                        Some(code) => format!("the graph file probe exited with code {code}"),
                        None => "the graph file probe ended without an exit code".to_owned(),
                    })
                }),
            )),
            CommandStatus::TimedOut => Err(GraphFileProbeError::new(
                ExportErrorCode::FfmpegProcessFailed,
                Some(format!(
                    "the graph file probe timed out after {} s",
                    PROBE_TIMEOUT.as_secs()
                )),
            )),
        }
    };

    let option = match attempt(GraphFileOption::Slash)? {
        Attempt::Read => GraphFileOption::Slash,
        Attempt::Unrecognized(_) => match attempt(GraphFileOption::Script)? {
            Attempt::Read => GraphFileOption::Script,
            Attempt::Unrecognized(detail) => {
                return Err(GraphFileProbeError::new(
                    ExportErrorCode::GraphFileUnsupported,
                    detail,
                ))
            }
        },
    };
    // Only a success is kept. The key was read before the runs, so a binary replaced during them
    // keeps the answer under its old identity, which no later export matches.
    if let Some(key) = key {
        let mut known = memo.lock().unwrap_or_else(PoisonError::into_inner);
        known.retain(|(known, _)| known.0 != key.0);
        known.push((key, option));
    }
    Ok(option)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A temporary directory with a stand-in `ffmpeg` file and a cache for work directories.
    struct Fixture {
        root: PathBuf,
        ffmpeg: PathBuf,
        work: ExportWorkDirectory,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("quipclip-graph-file-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            let ffmpeg = root.join("ffmpeg");
            std::fs::write(&ffmpeg, b"stand-in").unwrap();
            let work = ExportWorkDirectory::create(&root.join("cache")).unwrap();
            Self { root, ffmpeg, work }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn exited(success: bool, stderr: &str) -> io::Result<CommandOutcome> {
        Ok(CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(if success { 0 } else { 8 }),
                success,
            },
            stderr: stderr.as_bytes().to_vec(),
            stdout: Vec::new(),
        })
    }

    fn unrecognized(option: &str) -> io::Result<CommandOutcome> {
        exited(
            false,
            &format!("Unrecognized option '{option}'.\nError splitting the argument list: Option not found\n"),
        )
    }

    /// Run the probe of `fixture` against a fresh memo, with `answers` given in order. Returns
    /// the result and the flags that the runs used.
    fn probe(
        fixture: &Fixture,
        memo: &Mutex<Vec<(BinaryKey, GraphFileOption)>>,
        stop: &AtomicBool,
        answers: Vec<io::Result<CommandOutcome>>,
    ) -> (Result<GraphFileOption, GraphFileProbeError>, Vec<String>) {
        let answers = RefCell::new(answers.into_iter());
        let flags = RefCell::new(Vec::new());
        let result = probe_with(
            &fixture.ffmpeg,
            &fixture.work,
            stop,
            memo,
            |ffmpeg, arguments, directory, _| {
                assert_eq!(ffmpeg, fixture.ffmpeg);
                assert_eq!(directory, fixture.work.path());
                // The probe file exists, with the exact bytes, while the process runs.
                assert_eq!(
                    std::fs::read(directory.join(PROBE_GRAPH_FILE)).unwrap(),
                    b"color=s=16x16:d=0.04[v]"
                );
                flags.borrow_mut().push(arguments[4].clone());
                answers
                    .borrow_mut()
                    .next()
                    .expect("no more runs than answers")
            },
        );
        (result, flags.into_inner())
    }

    fn memo() -> Mutex<Vec<(BinaryKey, GraphFileOption)>> {
        Mutex::new(Vec::new())
    }

    #[test]
    fn the_flags_are_the_two_spellings() {
        assert_eq!(GraphFileOption::Slash.flag(), "-/filter_complex");
        assert_eq!(GraphFileOption::Script.flag(), "-filter_complex_script");
    }

    #[test]
    fn the_probe_command_is_the_command_of_adr_055() {
        assert_eq!(
            probe_arguments(GraphFileOption::Slash),
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-/filter_complex",
                "probe.graph",
                "-map",
                "[v]",
                "-c:v",
                "rawvideo",
                "-f",
                "null",
                "-",
            ]
        );
        assert_eq!(
            probe_arguments(GraphFileOption::Script)[4],
            "-filter_complex_script"
        );
    }

    #[test]
    fn an_exit_of_zero_gives_the_slash_option() {
        let fixture = Fixture::new("slash");
        let (result, flags) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![exited(true, "")],
        );
        assert_eq!(result, Ok(GraphFileOption::Slash));
        assert_eq!(flags, ["-/filter_complex"]);
    }

    #[test]
    fn an_unrecognized_slash_option_falls_back_to_the_script_option() {
        let fixture = Fixture::new("script");
        let (result, flags) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![unrecognized("/filter_complex"), exited(true, "")],
        );
        assert_eq!(result, Ok(GraphFileOption::Script));
        assert_eq!(flags, ["-/filter_complex", "-filter_complex_script"]);
    }

    #[test]
    fn two_unrecognized_options_give_graph_file_unsupported() {
        let fixture = Fixture::new("unsupported");
        let (result, flags) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![
                unrecognized("/filter_complex"),
                unrecognized("filter_complex_script"),
            ],
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::GraphFileUnsupported);
        assert!(error
            .detail
            .unwrap()
            .contains("Unrecognized option 'filter_complex_script'"));
        assert_eq!(flags.len(), 2);
    }

    #[test]
    fn another_failure_gives_ffmpeg_process_failed_and_no_second_run() {
        let fixture = Fixture::new("failed");
        let (result, flags) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![exited(false, "Error initializing filters\n")],
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::FfmpegProcessFailed);
        assert_eq!(
            error.detail.as_deref(),
            Some("Error initializing filters\n")
        );
        assert_eq!(flags, ["-/filter_complex"]);
    }

    #[test]
    fn a_process_that_does_not_start_gives_ffmpeg_spawn_failed() {
        let fixture = Fixture::new("spawn");
        let (result, _) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![Err(io::Error::new(io::ErrorKind::NotFound, "no such file"))],
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::FfmpegSpawnFailed);
        assert!(error.detail.unwrap().contains("no such file"));
    }

    #[test]
    fn a_timeout_gives_ffmpeg_process_failed_with_a_detail() {
        let fixture = Fixture::new("timeout");
        let (result, flags) = probe(
            &fixture,
            &memo(),
            &AtomicBool::new(false),
            vec![Ok(CommandOutcome {
                status: CommandStatus::TimedOut,
                stderr: Vec::new(),
                stdout: Vec::new(),
            })],
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, ExportErrorCode::FfmpegProcessFailed);
        assert_eq!(
            error.detail.as_deref(),
            Some("the graph file probe timed out after 10 s")
        );
        assert_eq!(flags.len(), 1);
    }

    #[test]
    fn a_stop_during_the_run_gives_canceled() {
        let fixture = Fixture::new("cancel");
        let stop = AtomicBool::new(false);
        let memo = memo();
        let result = probe_with(
            &fixture.ffmpeg,
            &fixture.work,
            &stop,
            &memo,
            |_, _, _, _| {
                stop.store(true, Ordering::SeqCst);
                Ok(CommandOutcome {
                    status: CommandStatus::TimedOut,
                    stderr: Vec::new(),
                    stdout: Vec::new(),
                })
            },
        );
        assert_eq!(result.unwrap_err().code, ExportErrorCode::Canceled);
        assert!(memo.lock().unwrap().is_empty());
    }

    #[test]
    fn a_stop_before_the_probe_runs_no_process() {
        let fixture = Fixture::new("stopped");
        let (result, flags) = probe(&fixture, &memo(), &AtomicBool::new(true), vec![]);
        assert_eq!(result.unwrap_err().code, ExportErrorCode::Canceled);
        assert!(flags.is_empty());
    }

    #[test]
    fn only_a_success_is_kept_for_the_same_binary() {
        let fixture = Fixture::new("memo");
        let memo = memo();
        let stop = AtomicBool::new(false);

        // A failure is not kept: the next probe runs again.
        let (result, _) = probe(&fixture, &memo, &stop, vec![exited(false, "broken\n")]);
        assert!(result.is_err());
        assert!(memo.lock().unwrap().is_empty());

        // A success is kept, and the next probe of the same binary runs no process.
        let (result, flags) = probe(
            &fixture,
            &memo,
            &stop,
            vec![unrecognized("/filter_complex"), exited(true, "")],
        );
        assert_eq!(result, Ok(GraphFileOption::Script));
        assert_eq!(flags.len(), 2);
        let (result, flags) = probe(&fixture, &memo, &stop, vec![]);
        assert_eq!(result, Ok(GraphFileOption::Script));
        assert!(flags.is_empty());

        // Another size is another binary, and it is probed again.
        std::fs::write(&fixture.ffmpeg, b"another stand-in").unwrap();
        let (result, flags) = probe(&fixture, &memo, &stop, vec![exited(true, "")]);
        assert_eq!(result, Ok(GraphFileOption::Slash));
        assert_eq!(flags.len(), 1);
        assert_eq!(memo.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_failed_write_of_the_probe_file_gives_work_directory_unavailable() {
        let fixture = Fixture::new("write");
        std::fs::remove_dir_all(fixture.work.path()).unwrap();
        let (result, flags) = probe(&fixture, &memo(), &AtomicBool::new(false), vec![]);
        assert_eq!(
            result.unwrap_err().code,
            ExportErrorCode::WorkDirectoryUnavailable
        );
        assert!(flags.is_empty());
    }
}
