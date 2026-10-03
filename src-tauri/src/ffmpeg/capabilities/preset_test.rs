//! The test of one preset on this machine: a short encode with the preset's own encoder
//! settings, through the real muxer.
//!
//! The smoke test of ADR 006 ([`super::smoke`]) encodes 0.2 s with the **default** settings of
//! each encoder, so a preset whose options this machine cannot take still passes it and then
//! fails at export time. These are real cases: an x86_64 ffmpeg refuses `-q:v` for VideoToolbox,
//! ffmpeg 7.1 has no `spatial_aq`, a Pascal NVIDIA GPU has no HEVC B-frames and no `b_ref_mode`,
//! a `hvc1` tag on H.264 fails only when the muxer writes its header, and a pixel format the
//! encoder cannot take only warns.
//!
//! [`build_test_arguments`] renders the command of the test. It shares the encoder and muxer
//! argument builders of the export ([`push_encoder_arguments`], [`push_muxer_arguments`]) and
//! the `aformat` that ends each audio chain of the export graph ([`audio_output_format`]), so the
//! test writes the same encoder flags, the same output pixel and sample formats, and the same
//! muxer as an export of the preset. The inputs are ADR 006's generated sources: 0.2 s of black
//! video at 256x256 and 25 fps, and 0.2 s of silence at the rate and the layout the preset asks
//! for.
//!
//! The test runs at `-loglevel level+warning`, one level more verbose than the export, because
//! some faults only warn: ffmpeg converts to a pixel format of the encoder's own when the encoder
//! cannot take the one the preset names, and `libsvtav1` ignores a key of `svtav1-params` it does
//! not know. The `level` flag prefixes each line of ffmpeg's own log with its level, which is
//! what [`classify_test`] reads.
//!
//! [`run_test_command`] runs the command under the smoke-test lock of ADR 006, with the child
//! process rules of ADR 018 and a kill and reap at [`PRESET_TEST_TIMEOUT`], and deletes the output
//! file on every path. No test in this module needs ffmpeg.

use super::smoke::SMOKE_LOCK;
use super::{run_with_timeout, CommandOutcome, CommandStatus, StdoutCapture};
use crate::ffmpeg::export::arguments::{push_encoder_arguments, push_muxer_arguments};
use crate::ffmpeg::export::graph::audio_output_format;
use crate::ffmpeg::export::{OutputTiming, PlannedAudio, PlannedVideo};
use crate::settings::{AudioChannels, AudioSampleRateSetting, Preset};
use crate::time::Rational;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::MutexGuard;
use std::time::{Duration, SystemTime};

/// The timeout for one preset test.
///
/// Measured on an Apple silicon Mac with ffmpeg 9.0.2, one test of a macOS seed took 0.10 s to
/// 0.19 s for `libx264` and `libsvtav1`, and 0.17 s to 0.25 s for `hevc_videotoolbox`, the first
/// run of a session included. Three times the worst of those is under a second, which leaves no
/// room for a start from a cold disk cache, a hardware encoder that initializes slowly, or a seed
/// with heavy options such as the two passes of NVENC `multipass fullres`. Ten seconds is twice
/// the smoke test's [`super::SMOKE_TIMEOUT`], for an encode that does more work than the encoder
/// defaults. It exists for the same reason: a broken hardware encoder can hang instead of fail.
pub const PRESET_TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How often [`run_test_command`] polls the child process for completion.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The video input of the test: ADR 006's black source of 0.2 s, tagged as limited range.
///
/// The `color` source sets no colour range, and a real video file usually carries one. Without
/// the tag, `h264_videotoolbox` warns `Color range not set for yuv420p. Using MPEG range.` for
/// every 8-bit format, `nv12` included, and every such test would read as passed with a warning
/// for a fault of the test input. `setparams=range=tv` sets the limited range that it assumes;
/// the filter and the value exist in every ffmpeg from 4.3. Measured with ffmpeg 9.0.2: the tag
/// removes that warning for `yuv420p` and `nv12`, and a real warning such as an incompatible
/// pixel format still shows.
const VIDEO_SOURCE: &str = "color=c=black:s=256x256:r=25:d=0.2,setparams=range=tv";

/// The length of the audio input, which `-t` bounds because `anullsrc` never ends.
const AUDIO_DURATION_SECONDS: &str = "0.2";

/// The sample rate of the audio input when the preset keeps the source rate.
///
/// The test has no source, so it uses the rate every export used before ADR 023.
const SOURCE_SAMPLE_RATE: u32 = 48_000;

/// The text that stands for the output path in the cache key of a test.
///
/// The output is a fresh temporary file for each run, so the key of a result uses this
/// placeholder in its place, and the same preset on the same binary finds the same entry.
pub const OUTPUT_PLACEHOLDER: &str = "<output>";

/// The largest number of bytes [`classify_test`] keeps of the line it reports.
///
/// The line crosses to the interface and goes into the cache file, so it is bounded. One log
/// line of ffmpeg is far shorter.
pub const MAX_LINE_BYTES: usize = 512;

/// How a preset test ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PresetTestStatus {
    /// ffmpeg exited with status 0 and wrote no warning and no error.
    Passed,
    /// ffmpeg exited with status 0 and wrote at least one warning or error line.
    PassedWithWarnings,
    /// ffmpeg exited with a status other than 0, or a signal ended it.
    Failed,
    /// ffmpeg was still running at [`PRESET_TEST_TIMEOUT`] and was killed.
    TimedOut,
}

/// The result of one preset test, as the interface and the cache file hold it.
///
/// `line` and `exitCode` are absent from the JSON, never `null`, when they hold no value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetTestResult {
    pub status: PresetTestStatus,
    /// The line of ffmpeg's log that explains the status, with the pointer of each log prefix
    /// removed; see [`classify_test`]. Absent for [`PresetTestStatus::Passed`], and absent for a
    /// run that wrote nothing to stderr.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    /// The exit code of a [`PresetTestStatus::Failed`] run, when the process reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// When the test ran, in whole seconds since the Unix epoch, as for the `probedAt` of a
    /// capability report.
    pub tested_at: i64,
}

/// Build the command of the test of `preset`, writing to `output`.
///
/// The arguments are, in order: the process flags, the two generated inputs, a graph that sets
/// the pixel format of the video and ends the audio in the `aformat` of an export, the two maps,
/// the encoder arguments of an export, the muxer arguments of an export, and `output`. The
/// command excludes the executable.
///
/// The graph is `[0:v]format=<pixelFormat>[v];[1:a]<aformat>[a]`: the export puts the pixel
/// format chain first in its graph (ADR 014 measurement 19), and it ends every audio chain in the
/// same `aformat`. The cut, the timing and the scaling of the export chains have nothing to cut
/// here, so the test leaves them out.
///
/// The cache key of a result is this command with [`OUTPUT_PLACEHOLDER`] for `output`.
#[must_use]
pub fn build_test_arguments(preset: &Preset, output: &str) -> Vec<String> {
    let (sample_rate, layout) = audio_input_format(preset);
    let video = planned_video(preset);
    let audio = planned_audio(preset, sample_rate);

    let mut arguments: Vec<String> = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "level+warning",
        "-y",
        "-f",
        "lavfi",
        "-i",
        VIDEO_SOURCE,
        "-f",
        "lavfi",
        "-t",
        AUDIO_DURATION_SECONDS,
        "-i",
    ]
    .iter()
    .map(|argument| (*argument).to_owned())
    .collect();
    arguments.push(format!("anullsrc=r={sample_rate}:cl={layout}"));
    arguments.push("-filter_complex".to_owned());
    arguments.push(format!(
        "[0:v]format={}[v];[1:a]{}[a]",
        video.pixel_format,
        audio_output_format(&audio)
    ));
    for label in ["[v]", "[a]"] {
        arguments.push("-map".to_owned());
        arguments.push(label.to_owned());
    }
    push_encoder_arguments(&mut arguments, Some(&video), Some(&audio));
    push_muxer_arguments(&mut arguments, preset.container, true);
    arguments.push(output.to_owned());
    arguments
}

/// The sample rate and the channel layout of the generated audio input.
///
/// A fixed rate and a fixed layout are the preset's own. The source rate becomes
/// [`SOURCE_SAMPLE_RATE`], and the source layout becomes stereo, the layout every export used
/// before ADR 023.
fn audio_input_format(preset: &Preset) -> (u32, &'static str) {
    let sample_rate = match preset.audio_sample_rate {
        AudioSampleRateSetting::Source => SOURCE_SAMPLE_RATE,
        AudioSampleRateSetting::Fixed(rate) => rate,
    };
    let layout = match preset.audio_channels {
        AudioChannels::Source | AudioChannels::Stereo => "stereo",
        AudioChannels::Mono => "mono",
    };
    (sample_rate, layout)
}

/// The video part of an export of `preset`, as the export plan holds it, for the generated
/// input: stream 0 of input 0 at its own 25 fps and size.
///
/// The encoder fields are the preset's, verbatim, as [`crate::ffmpeg::export::build_plan`] copies
/// them. The other fields describe the 0.2 s input, and the argument builders do not read them.
fn planned_video(preset: &Preset) -> PlannedVideo {
    PlannedVideo {
        stream_index: 0,
        timing: OutputTiming::ConstantFrameRate(
            Rational::new(25, 1).expect("25/1 always reduces to a valid Rational"),
        ),
        resolution: None,
        encoder: preset.video_encoder.clone(),
        quality: preset.quality,
        pixel_format: preset.pixel_format.clone(),
        options: preset.video_options.clone(),
        expected_frames: Some(5),
    }
}

/// The audio part of an export of `preset`, for the generated input at `sample_rate`.
///
/// The output rate is the input rate, as `build_plan` resolves a preset that keeps the source
/// rate, and the channel setting is the preset's, so [`audio_output_format`] renders the same
/// filter it renders for an export from a source of this rate.
fn planned_audio(preset: &Preset, sample_rate: u32) -> PlannedAudio {
    PlannedAudio {
        stream_index: 0,
        sample_rate,
        output_sample_rate: sample_rate,
        output_channels: preset.audio_channels,
        encoder: preset.audio_encoder.clone(),
        bitrate: preset.audio_bitrate,
        options: preset.audio_options.clone(),
        expected_duration: Rational::new(1, 5).expect("1/5 always reduces to a valid Rational"),
        silence_layout: None,
    }
}

/// The right to run one encode on the encoders of this machine: the smoke-test lock of ADR 006.
///
/// [`run_test_command`] takes it by reference, so a caller cannot run a test without holding the
/// lock, and the caller decides what else happens while it holds it, such as the check that no
/// export started while it waited.
pub struct EncoderTurn {
    _guard: MutexGuard<'static, ()>,
}

/// Wait for the smoke-test lock, and return it as an [`EncoderTurn`].
///
/// A poisoned lock is recovered, for the reason `smoke::run_smoke_report` gives.
#[must_use]
pub fn wait_for_encoder_turn() -> EncoderTurn {
    EncoderTurn {
        _guard: SMOKE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    }
}

/// Deletes the output file of a test when it drops.
///
/// The guard exists before the process starts, so it deletes the file on every path: a run that
/// passed, a run that failed after the muxer opened the file, a run killed at the timeout, a
/// spawn that failed, and a panic. [`run_with_timeout`] reaps the process before it returns, so
/// no process holds the file open when the guard runs.
struct OutputCleanup<'a> {
    path: &'a Path,
}

impl Drop for OutputCleanup<'_> {
    fn drop(&mut self) {
        // A file that ffmpeg never created is the usual case of a failed test, not an error.
        // Any other failure, such as a virus scanner that holds the file on Windows, leaves a
        // file of a few kilobytes in the cache directory. A drop can only log it, and the sweep
        // of a later process (`remove_stale_outputs`) deletes it.
        if let Err(error) = fs::remove_file(self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "preset test: the output {} was not deleted: {error}",
                    self.path.display()
                );
            }
        }
    }
}

/// Run `program` with `arguments` as one preset test, and delete `output` afterwards.
///
/// `arguments` must name `output` as the output file; [`build_test_arguments`] does. The caller
/// holds `turn`, so the test never runs beside a smoke test or another preset test. stdout goes
/// to the null device, and stderr keeps its first bytes, where the reason of a failure is.
///
/// An `Err` means the process did not run, such as a binary that cannot start. It is not a
/// result for the preset.
///
/// A test that runs when the application quits is not awaited, as a smoke test is not: the exit
/// handler of `lib.rs` waits for an export only (ADR 017). The ffmpeg child can then outlive the
/// application for up to [`PRESET_TEST_TIMEOUT`], and its output stays in the cache directory.
/// The next test of a later process deletes it (`remove_stale_outputs`).
pub fn run_test_command(
    _turn: &EncoderTurn,
    program: &Path,
    arguments: &[String],
    output: &Path,
    timeout: Duration,
) -> io::Result<CommandOutcome> {
    let _cleanup = OutputCleanup { path: output };
    run_with_timeout(
        program,
        arguments,
        timeout,
        POLL_INTERVAL,
        StdoutCapture::Discard,
    )
}

/// The severity of one line of ffmpeg's log, as `-loglevel level+warning` prints it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogSeverity {
    /// `[warning]`.
    Warning,
    /// `[error]`, `[fatal]`, or `[panic]`.
    Error,
}

/// Classify a finished test, at `tested_at`.
///
/// - Exit status 0 is [`PresetTestStatus::Passed`], or [`PresetTestStatus::PassedWithWarnings`]
///   when ffmpeg wrote a warning or an error line. The line is the first of those.
/// - Any other exit is [`PresetTestStatus::Failed`], and the deadline is
///   [`PresetTestStatus::TimedOut`]. The line is the first error line, else the first warning
///   line, else the first line of stderr.
///
/// Only a line of ffmpeg's own log counts: its prefixes are `[<name> @ <pointer>] ` groups and
/// then the level, such as `[libsvtav1 @ 0x7957045180] [warning] Error parsing option ...`, or
/// the level alone, such as `[warning] Incompatible pixel format ...`. A library that writes to
/// stderr itself does not count, because its line has neither shape: `libsvtav1` writes
/// `Svt[info]: ...` lines at every log level, and `libx265` writes `x265 [warning]: Source height
/// < 720p; disabling lookahead-slices`, which every 256x256 test would trigger. The fallback for a
/// failed run skips the `Svt[info]` lines too, because they come first and explain nothing.
///
/// The reported line keeps the prefixes and the level, and it loses the pointer of each prefix,
/// which differs on each run. It is cut to [`MAX_LINE_BYTES`].
#[must_use]
pub fn classify_test(outcome: &CommandOutcome, tested_at: i64) -> PresetTestResult {
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty())
        .collect();
    let first_of = |wanted: &[LogSeverity]| {
        lines
            .iter()
            .copied()
            .find(|line| log_severity(line).is_some_and(|severity| wanted.contains(&severity)))
    };
    let first_error = || first_of(&[LogSeverity::Error]);
    let first_warning = || first_of(&[LogSeverity::Warning]);
    let first_noted = || first_of(&[LogSeverity::Warning, LogSeverity::Error]);
    let first_plain = || {
        lines
            .iter()
            .copied()
            .find(|line| !line.starts_with("Svt[info]"))
    };

    let (status, line, exit_code) = match outcome.status {
        CommandStatus::Exited { success: true, .. } => match first_noted() {
            Some(line) => (PresetTestStatus::PassedWithWarnings, Some(line), None),
            None => (PresetTestStatus::Passed, None, None),
        },
        CommandStatus::Exited { code, .. } => (
            PresetTestStatus::Failed,
            first_error().or_else(first_warning).or_else(first_plain),
            code,
        ),
        CommandStatus::TimedOut => (
            PresetTestStatus::TimedOut,
            first_error().or_else(first_warning).or_else(first_plain),
            None,
        ),
    };

    PresetTestResult {
        status,
        line: line.map(|line| truncate_to_bytes(&strip_pointers(line), MAX_LINE_BYTES)),
        exit_code,
        tested_at,
    }
}

/// The severity of `line` when it is a warning or an error line of ffmpeg's own log.
///
/// The line must start with zero or more context groups, `[<name> @ <pointer>] `, and then the
/// level group, `[<level>] `. Any other shape is not a log line of ffmpeg, and a level below
/// `warning` does not count.
fn log_severity(line: &str) -> Option<LogSeverity> {
    let mut rest = line;
    loop {
        let (group, after) = leading_group(rest)?;
        match group {
            "warning" => return Some(LogSeverity::Warning),
            "error" | "fatal" | "panic" => return Some(LogSeverity::Error),
            _ if group.contains(" @ ") => rest = after,
            _ => return None,
        }
    }
}

/// Split `text` into its leading `[...]` group, without the brackets, and the text after the
/// group and its one space, or `None` when `text` does not start with such a group.
fn leading_group(text: &str) -> Option<(&str, &str)> {
    let inner = text.strip_prefix('[')?;
    let close = inner.find("] ")?;
    Some((&inner[..close], &inner[close + 2..]))
}

/// Remove the pointer from each leading context group of `line`: `[libx264 @ 0x76d5031180] `
/// becomes `[libx264] `.
///
/// The pointer is the text after the last ` @ ` of the group. ffmpeg prints it with `%p`, which
/// is `0x...` on macOS and sixteen hexadecimal digits with no prefix on Windows.
fn strip_pointers(line: &str) -> String {
    let mut stripped = String::with_capacity(line.len());
    let mut rest = line;
    while let Some((group, after)) = leading_group(rest) {
        let Some(at) = group.rfind(" @ ") else {
            break;
        };
        stripped.push('[');
        stripped.push_str(&group[..at]);
        stripped.push_str("] ");
        rest = after;
    }
    stripped.push_str(rest);
    stripped
}

/// Cut `text` to at most `limit` bytes, at a character boundary.
fn truncate_to_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// How old the output of another process must be before [`remove_stale_outputs`] deletes it.
///
/// A test writes its output for at most [`PRESET_TEST_TIMEOUT`], so an output this much older has
/// no process that still writes it. A younger output can belong to a test of a second QuipClip
/// process, whose muxer reopens the file for `+faststart`, so it stays.
const STALE_OUTPUT_AGE: Duration = Duration::from_secs(60);

/// Delete the outputs that the tests of earlier QuipClip processes left in `directory`: a test
/// that ran at a quit, or an output that a cleanup could not delete. Best effort: a failure is
/// logged, and the test goes on.
///
/// Only a file named as [`test_output_path`] names it is a candidate, and only when the process id
/// in the name is not this process and the file is older than [`STALE_OUTPUT_AGE`]. A file of
/// this process belongs to its own test, which deletes it.
pub fn remove_stale_outputs(directory: &Path) {
    remove_stale_outputs_with(
        directory,
        std::process::id(),
        SystemTime::now(),
        STALE_OUTPUT_AGE,
    );
}

/// [`remove_stale_outputs`] with the process id, the clock and the age supplied, so a test can
/// leave a file of "another" process. Returns the number of files it deleted.
fn remove_stale_outputs_with(
    directory: &Path,
    own_process: u32,
    now: SystemTime,
    min_age: Duration,
) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(process) = name.to_str().and_then(output_process_id) else {
            continue;
        };
        if process == own_process {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= min_age);
        if !old_enough {
            continue;
        }
        let path = entry.path();
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "preset test: the stale output {} was not deleted: {error}",
                path.display()
            ),
        }
    }
    removed
}

/// The process id in an output name of [`test_output_path`], `preset-test-<pid>-<n>.tmp`, or
/// `None` for any other name.
fn output_process_id(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("preset-test-")?.strip_suffix(".tmp")?;
    let (process, sequence) = rest.split_once('-')?;
    let is_number = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if !is_number(process) || !is_number(sequence) {
        return None;
    }
    process.parse().ok()
}

/// The counter that [`test_output_path`] draws from.
static OUTPUT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A unique path for the output of one test in `directory`.
///
/// The name holds the process id and a counter of this process, so two tests never share a
/// file, and two QuipClip processes never do either. The extension does not choose the muxer:
/// the command names it with `-f`.
#[must_use]
pub fn test_output_path(directory: &Path) -> PathBuf {
    let sequence = OUTPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    directory.join(format!("preset-test-{}-{sequence}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::defaults::every_platform_seed;
    use crate::settings::{
        Container, FrameRateSetting, PresetOption, Quality, QualityKind, ResolutionSetting,
    };
    use std::time::Instant;

    /// The seed with `id`, from the seeds of every platform.
    fn seed(id: &str) -> Preset {
        every_platform_seed()
            .into_iter()
            .find(|preset| preset.id == id)
            .unwrap_or_else(|| panic!("no seed {id}"))
    }

    /// Every argument in front of the encoder arguments, for a seed: AAC at the source rate and
    /// layout, so a 48000 Hz stereo input and an `aformat` with no layout.
    fn head(pixel_format: &str) -> Vec<String> {
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "level+warning",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:r=25:d=0.2,setparams=range=tv",
            "-f",
            "lavfi",
            "-t",
            "0.2",
            "-i",
            "anullsrc=r=48000:cl=stereo",
            "-filter_complex",
            &format!("[0:v]format={pixel_format}[v];[1:a]aformat=f=fltp:r=48000[a]"),
            "-map",
            "[v]",
            "-map",
            "[a]",
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect()
    }

    /// The arguments behind the video arguments, which every seed shares.
    fn tail() -> Vec<String> {
        [
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            OUTPUT_PLACEHOLDER,
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect()
    }

    fn golden(pixel_format: &str, video: &[&str]) -> Vec<String> {
        let mut command = head(pixel_format);
        command.extend(video.iter().map(|argument| (*argument).to_owned()));
        command.extend(tail());
        command
    }

    #[test]
    fn the_h264_seed_renders_its_golden_test_command() {
        assert_eq!(
            build_test_arguments(&seed("default-h264-mp4"), OUTPUT_PLACEHOLDER),
            golden(
                "yuv420p",
                &[
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-crf",
                    "20",
                    "-preset:v",
                    "slow",
                    "-x264-params:v",
                    "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0:qcomp=0.65:rc-lookahead=60:bframes=6:b-adapt=2",
                ]
            )
        );
    }

    #[test]
    fn the_av1_seed_renders_its_golden_test_command() {
        assert_eq!(
            build_test_arguments(&seed("default-av1-mp4"), OUTPUT_PLACEHOLDER),
            golden(
                "yuv420p10le",
                &[
                    "-c:v",
                    "libsvtav1",
                    "-pix_fmt",
                    "yuv420p10le",
                    "-crf",
                    "38",
                    "-preset:v",
                    "5",
                    "-g:v",
                    "250",
                    "-svtav1-params:v",
                    "tune=0:enable-variance-boost=1:variance-boost-strength=2:film-grain=0",
                ]
            )
        );
    }

    #[test]
    fn the_videotoolbox_seed_renders_its_golden_test_command() {
        assert_eq!(
            build_test_arguments(&seed("default-hevc-videotoolbox-mp4"), OUTPUT_PLACEHOLDER),
            golden(
                "p010le",
                &[
                    "-c:v",
                    "hevc_videotoolbox",
                    "-pix_fmt",
                    "p010le",
                    "-q:v",
                    "80",
                    "-profile:v",
                    "main10",
                    "-prio_speed:v",
                    "0",
                    "-spatial_aq:v",
                    "1",
                    "-bf:v",
                    "3",
                    "-g:v",
                    "300",
                    "-tag:v",
                    "hvc1",
                ]
            )
        );
    }

    #[test]
    fn the_nvenc_seeds_render_their_golden_test_commands() {
        let nvenc = [
            "-preset:v",
            "p7",
            "-rc:v",
            "vbr",
            "-multipass:v",
            "fullres",
            "-rc-lookahead:v",
            "32",
            "-spatial-aq:v",
            "1",
            "-temporal-aq:v",
            "1",
            "-bf:v",
            "3",
            "-b_ref_mode:v",
            "middle",
            "-g:v",
            "250",
        ];

        let mut h264 = vec![
            "-c:v",
            "h264_nvenc",
            "-pix_fmt",
            "yuv420p",
            "-cq",
            "25",
            "-b:v",
            "0",
        ];
        h264.extend(nvenc);
        assert_eq!(
            build_test_arguments(&seed("default-nvenc-mp4"), OUTPUT_PLACEHOLDER),
            golden("yuv420p", &h264)
        );

        let mut hevc = vec![
            "-c:v",
            "hevc_nvenc",
            "-pix_fmt",
            "p010le",
            "-cq",
            "25",
            "-b:v",
            "0",
        ];
        hevc.extend(nvenc);
        hevc.extend(["-tag:v", "hvc1"]);
        assert_eq!(
            build_test_arguments(&seed("default-hevc-nvenc-mp4"), OUTPUT_PLACEHOLDER),
            golden("p010le", &hevc)
        );
    }

    #[test]
    fn a_fixed_rate_and_layout_reach_the_input_and_the_aformat_and_the_muxer_follows_the_container()
    {
        // A bitrate preset in MKV, with Opus at 44100 Hz mono and an audio option: the input and
        // the `aformat` take the preset's rate and layout, the audio option follows `-b:a`, and
        // Matroska writes no `+faststart`. The resolution and the frame rate change nothing,
        // because the test has nothing to scale.
        let preset = Preset {
            id: "custom".to_owned(),
            name: "Custom".to_owned(),
            container: Container::Mkv,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "libopus".to_owned(),
            audio_bitrate: Some(96),
            audio_sample_rate: AudioSampleRateSetting::Fixed(44_100),
            audio_channels: AudioChannels::Mono,
            quality: Quality {
                kind: QualityKind::Bitrate,
                value: 8000,
            },
            resolution: ResolutionSetting::Custom(crate::project::Resolution { w: 1280, h: 720 }),
            frame_rate: FrameRateSetting::Rate(Rational::new(24, 1).unwrap()),
            pixel_format: "yuv420p".to_owned(),
            video_options: vec![],
            audio_options: vec![PresetOption {
                name: "application".to_owned(),
                value: "audio".to_owned(),
            }],
        };

        let arguments = build_test_arguments(&preset, "/cache/preset-test-1-0.tmp");

        let expected: Vec<String> = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "level+warning",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:r=25:d=0.2,setparams=range=tv",
            "-f",
            "lavfi",
            "-t",
            "0.2",
            "-i",
            "anullsrc=r=44100:cl=mono",
            "-filter_complex",
            "[0:v]format=yuv420p[v];\
             [1:a]aformat=f=fltp:r=44100:cl=mono[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            "8000k",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            "-application:a",
            "audio",
            "-f",
            "matroska",
            "/cache/preset-test-1-0.tmp",
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect();
        assert_eq!(arguments, expected);
    }

    #[test]
    fn the_source_layout_tests_stereo_and_a_stereo_preset_names_the_layout() {
        let mut preset = seed("default-h264-mp4");
        preset.audio_channels = AudioChannels::Stereo;
        let arguments = build_test_arguments(&preset, OUTPUT_PLACEHOLDER);
        assert!(arguments.contains(&"anullsrc=r=48000:cl=stereo".to_owned()));
        assert!(arguments.contains(
            &"[0:v]format=yuv420p[v];\
              [1:a]aformat=f=fltp:r=48000:cl=stereo[a]"
                .to_owned()
        ));
    }

    /// The source of the export that `export_command_of` plans, and the reservation it writes.
    #[cfg(windows)]
    const EXPORT_SOURCE: &str = r"C:\media\source.mov";
    #[cfg(windows)]
    const EXPORT_DESTINATION: &str = r"C:\export\out.mp4";
    #[cfg(windows)]
    const EXPORT_RESERVATION: &str = r"C:\export\.out.mp4.tmp-4242-0";
    #[cfg(not(windows))]
    const EXPORT_SOURCE: &str = "/media/source.mov";
    #[cfg(not(windows))]
    const EXPORT_DESTINATION: &str = "/export/out.mp4";
    #[cfg(not(windows))]
    const EXPORT_RESERVATION: &str = "/export/.out.mp4.tmp-4242-0";

    /// The command of a real export of `preset`: one segment of a 30 fps source with 48000 Hz
    /// stereo audio, planned by `build_plan` and rendered by `build_arguments`.
    fn export_command_of(preset: &Preset) -> Vec<String> {
        use crate::ffmpeg::export::{
            build_arguments, build_filter_graph, build_plan, ExportStreams, GraphShape, PathFacts,
            PathIdentity, PlanRequest, SegmentBoundary,
        };
        use crate::ffmpeg::{AudioProbe, MediaProbe};
        use crate::time::Pts;

        let probe = MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: Some("yuv420p".to_owned()),
            bit_depth: Some(8),
            width: 1920,
            height: 1080,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: Some(Pts::new(0)),
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: None,
            audio: Some(AudioProbe {
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
        };
        let segments = [SegmentBoundary {
            in_pts: Pts::new(900_000),
            out_pts: Pts::new(1_080_000),
        }];
        let source = PathBuf::from(EXPORT_SOURCE);
        let destination = PathBuf::from(EXPORT_DESTINATION);
        let parent = destination.parent().unwrap().to_path_buf();
        let plan = build_plan(
            &PlanRequest {
                source: &source,
                destination: &destination,
                segments: &segments,
                probe: &probe,
                preset,
                streams: ExportStreams::VideoAndAudio,
                audio_gaps: &[],
            },
            |path: &Path| {
                if path == source {
                    PathFacts::File {
                        identity: PathIdentity::new(1),
                        read_only: false,
                    }
                } else if path == parent {
                    PathFacts::Directory
                } else {
                    PathFacts::Absent
                }
            },
        )
        .expect("the preset plans");
        let graph = build_filter_graph(&plan, GraphShape::InputPerSegment);
        build_arguments(
            &plan,
            GraphShape::InputPerSegment,
            &graph,
            Path::new(EXPORT_RESERVATION),
        )
    }

    /// The arguments from `-c:v` to the last argument before the output: the encoder arguments,
    /// the pixel format, the options, and the muxer arguments.
    fn encoder_and_muxer_slice(arguments: &[String]) -> &[String] {
        let start = arguments
            .iter()
            .position(|argument| argument == "-c:v")
            .expect("the command writes video");
        &arguments[start..arguments.len() - 1]
    }

    #[test]
    fn the_test_writes_the_encoder_and_muxer_arguments_of_a_real_export() {
        // Every seed of every platform, and a preset that sets each audio field and holds options
        // of both streams in MKV. The two commands must not drift: the test exists to report
        // what an export of the preset would meet. The input rate of the test is the source rate
        // of the export here, 48000 Hz, so the `-b:a` and the options agree as well.
        let mut presets = every_platform_seed();
        presets.push(Preset {
            id: "custom".to_owned(),
            name: "Custom".to_owned(),
            container: Container::Mkv,
            video_encoder: "libx265".to_owned(),
            audio_encoder: "libopus".to_owned(),
            audio_bitrate: Some(128),
            audio_sample_rate: AudioSampleRateSetting::Fixed(48_000),
            audio_channels: AudioChannels::Stereo,
            quality: Quality {
                kind: QualityKind::QualityScale,
                value: 40,
            },
            resolution: ResolutionSetting::Custom(crate::project::Resolution { w: 1280, h: 720 }),
            frame_rate: FrameRateSetting::Rate(Rational::new(24, 1).unwrap()),
            pixel_format: "yuv420p10le".to_owned(),
            video_options: vec![PresetOption {
                name: "x265-params".to_owned(),
                value: "aq-mode=3".to_owned(),
            }],
            audio_options: vec![PresetOption {
                name: "application".to_owned(),
                value: "audio".to_owned(),
            }],
        });
        for preset in &presets {
            let export = export_command_of(preset);
            let test = build_test_arguments(preset, OUTPUT_PLACEHOLDER);
            assert_eq!(
                encoder_and_muxer_slice(&test),
                encoder_and_muxer_slice(&export),
                "{}",
                preset.id
            );
            assert_eq!(export.last().map(String::as_str), Some(EXPORT_RESERVATION));
        }
    }

    #[test]
    fn the_output_is_the_last_argument_and_appears_nowhere_else() {
        // The cache key replaces the output with the placeholder, so the output must be one
        // argument, at the end.
        let arguments = build_test_arguments(&seed("default-h264-mp4"), "/tmp/out.tmp");
        assert_eq!(arguments.last().map(String::as_str), Some("/tmp/out.tmp"));
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.contains("/tmp/out.tmp"))
                .count(),
            1
        );
    }

    // -- classify_test -------------------------------------------------------------------

    fn exited(code: i32, stderr: &str) -> CommandOutcome {
        CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(code),
                success: code == 0,
            },
            stderr: stderr.as_bytes().to_vec(),
            stdout: Vec::new(),
        }
    }

    const TESTED_AT: i64 = 1_790_000_000;

    /// The `Svt[info]` banner `libsvtav1` 4.2.0 wrote in a real test on this Mac, at
    /// `-loglevel level+warning`.
    const SVT_BANNER: &str = "Svt[info]: -------------------------------------------\n\
        Svt[info]: SVT [version]:\tSVT-AV1 Encoder Lib v4.2.0\n\
        Svt[info]: SVT [build]  :\tApple LLVM 21.0.0 (clang-2100.0.123.102)\t 64 bit\n\
        Svt[info]: -------------------------------------------\n\
        Svt[info]: SVT [config]: main profile\ttier (auto)\tlevel (auto)\n\
        Svt[info]: SVT [config]: BRC mode / rate factor \t\t\t\t\t: CRF / 38.00 \n\
        Svt[info]: -------------------------------------------\n";

    #[test]
    fn a_clean_exit_passes_with_no_line() {
        let result = classify_test(&exited(0, ""), TESTED_AT);
        assert_eq!(
            result,
            PresetTestResult {
                status: PresetTestStatus::Passed,
                line: None,
                exit_code: None,
                tested_at: TESTED_AT,
            }
        );
    }

    #[test]
    fn the_svt_banner_is_noise_and_not_a_warning() {
        let result = classify_test(&exited(0, SVT_BANNER), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Passed);
        assert_eq!(result.line, None);
    }

    #[test]
    fn an_unknown_svt_key_passes_with_its_warning() {
        // Captured from ffmpeg 9.0.2 with `-svtav1-params:v tune=0:no-such-key=2`.
        let stderr = format!(
            "Svt[info]: -------------------------------------------\n\
             [libsvtav1 @ 0x7957045180] [warning] Error parsing option no-such-key: 2.\n\
             {SVT_BANNER}"
        );
        let result = classify_test(&exited(0, &stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::PassedWithWarnings);
        assert_eq!(
            result.line.as_deref(),
            Some("[libsvtav1] [warning] Error parsing option no-such-key: 2.")
        );
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn a_pixel_format_the_encoder_cannot_take_passes_with_its_warning() {
        // Captured from ffmpeg 9.0.2: libx264 with `format=p010le` and `-pix_fmt p010le`.
        let stderr = "[warning] Incompatible pixel format 'p010le' for codec 'libx264', \
                      auto-selecting format 'yuv420p10le'\n";
        let result = classify_test(&exited(0, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::PassedWithWarnings);
        assert_eq!(
            result.line.as_deref(),
            Some(
                "[warning] Incompatible pixel format 'p010le' for codec 'libx264', \
                 auto-selecting format 'yuv420p10le'"
            )
        );
    }

    #[test]
    fn the_colour_range_warning_of_an_untagged_source_is_why_the_source_is_tagged() {
        // Captured from ffmpeg 9.0.2: h264_videotoolbox with `format=yuv420p` from the untagged
        // `color` source. The warning is real ffmpeg log, so the classifier counts it, and only
        // the tag on the source (`VIDEO_SOURCE`) keeps every VideoToolbox test from reporting it.
        let untagged = "[h264_videotoolbox @ 0x7bc9049180] [warning] Color range not set for \
                        yuv420p. Using MPEG range.\n";
        assert_eq!(
            classify_test(&exited(0, untagged), TESTED_AT).status,
            PresetTestStatus::PassedWithWarnings
        );
        assert!(VIDEO_SOURCE.ends_with(",setparams=range=tv"));
        let arguments = build_test_arguments(&seed("default-h264-mp4"), OUTPUT_PLACEHOLDER);
        assert_eq!(arguments[8], VIDEO_SOURCE);

        // Captured from ffmpeg 9.0.2 with the tagged source: `yuv420p` and `nv12` wrote nothing,
        // and `p010le` wrote only the warning of the pixel format, which still counts.
        assert_eq!(
            classify_test(&exited(0, ""), TESTED_AT).status,
            PresetTestStatus::Passed
        );
        let tagged_p010 = "[warning] Incompatible pixel format 'p010le' for codec \
                           'h264_videotoolbox', auto-selecting format 'nv12'\n";
        let result = classify_test(&exited(0, tagged_p010), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::PassedWithWarnings);
        assert_eq!(
            result.line.as_deref(),
            Some(
                "[warning] Incompatible pixel format 'p010le' for codec 'h264_videotoolbox', \
                 auto-selecting format 'nv12'"
            )
        );
    }

    #[test]
    fn a_library_warning_that_ffmpeg_did_not_log_does_not_count() {
        // Captured from ffmpeg 9.0.2 with libx265: x265 writes this itself for every input below
        // 720 lines, so every test of an x265 preset would warn if it counted.
        let stderr = "x265 [warning]: Source height < 720p; disabling lookahead-slices\n";
        let result = classify_test(&exited(0, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Passed);
        assert_eq!(result.line, None);
    }

    #[test]
    fn a_hvc1_tag_on_h264_fails_at_the_header_with_the_muxers_line() {
        // Captured from ffmpeg 9.0.2: libx264 with `-tag:v hvc1` into MP4. Every line before the
        // muxer's is absent, because the encoder opened; the header write is what fails.
        let stderr = "[mp4 @ 0x7ae3044500] [error] Tag hvc1 incompatible with output codec id '27' (avc1)\n\
            [out#0/mp4 @ 0x7ae302a100] [error] Could not write header (incorrect codec parameters ?): Invalid data found when processing input\n\
            [fc#0 @ 0x7ae2c45e00] [error] Error sending frames to consumers: Invalid data found when processing input\n\
            [fc#0 @ 0x7ae2c45e00] [error] Task finished with error code: -1094995529 (Invalid data found when processing input)\n\
            [out#0/mp4 @ 0x7ae302a100] [error] Nothing was written into output file, because at least one of its streams received no packets.\n";
        let result = classify_test(&exited(183, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Failed);
        assert_eq!(
            result.line.as_deref(),
            Some("[mp4] [error] Tag hvc1 incompatible with output codec id '27' (avc1)")
        );
        assert_eq!(result.exit_code, Some(183));
    }

    #[test]
    fn the_videotoolbox_quality_refusal_of_an_intel_ffmpeg_is_the_line_of_the_failure() {
        // The message of `libavcodec/videotoolboxenc.c` for `-q:v` on a build that is not for
        // Apple silicon, in the prefix shape ffmpeg 9.0.2 writes for an encoder that fails to
        // open, which a capture of `-preset:v notapreset` on libx264 gave. The first error line
        // is the encoder's own, ahead of the lines fftools adds.
        let stderr = "[hevc_videotoolbox @ 0x7f8e2c704c40] [error] Error: -q:v qscale not available for encoder. Use -b:v bitrate instead.\n\
            [vost#0:0/hevc_videotoolbox @ 0x7f8e2c70c000] [enc:hevc_videotoolbox @ 0x7f8e2c409490] [error] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\n\
            [fc#0 @ 0x7f8e2c46de00] [error] Error sending frames to consumers: External library error\n\
            [out#0/mp4 @ 0x7f8e2c704e40] [error] Nothing was written into output file, because at least one of its streams received no packets.\n";
        let result = classify_test(&exited(234, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Failed);
        assert_eq!(
            result.line.as_deref(),
            Some(
                "[hevc_videotoolbox] [error] Error: -q:v qscale not available for encoder. \
                 Use -b:v bitrate instead."
            )
        );
    }

    #[test]
    fn two_context_groups_both_lose_their_pointer() {
        let stderr = "[vost#0:0/libx264 @ 0x76d505c000] [enc:libx264 @ 0x76d4c09490] [error] Could not open encoder before EOF\n";
        let result = classify_test(&exited(234, stderr), TESTED_AT);
        assert_eq!(
            result.line.as_deref(),
            Some("[vost#0:0/libx264] [enc:libx264] [error] Could not open encoder before EOF")
        );
    }

    #[test]
    fn a_windows_pointer_with_no_prefix_is_removed_too() {
        let stderr = "[h264_nvenc @ 000001d2c3a4b5c0] [error] No capable devices found\n";
        let result = classify_test(&exited(1, stderr), TESTED_AT);
        assert_eq!(
            result.line.as_deref(),
            Some("[h264_nvenc] [error] No capable devices found")
        );
    }

    #[test]
    fn an_unknown_option_fails_with_the_error_ahead_of_the_fatal_line() {
        // Captured from ffmpeg 9.0.2 with an option no encoder of the build knows, which is what
        // ffmpeg 7.1 reports for `-spatial_aq:v 1`.
        let stderr = "[error] Unrecognized option 'spatial_aq:v'.\n\
                      [fatal] Error splitting the argument list: Option not found\n";
        let result = classify_test(&exited(8, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Failed);
        assert_eq!(
            result.line.as_deref(),
            Some("[error] Unrecognized option 'spatial_aq:v'.")
        );
        assert_eq!(result.exit_code, Some(8));
    }

    #[test]
    fn a_failure_prefers_the_first_error_over_an_earlier_warning() {
        let stderr = "[warning] Incompatible pixel format 'p010le' for codec 'libx264', auto-selecting format 'yuv420p10le'\n\
                      [libx264 @ 0x1] [error] Error setting preset/tune notapreset/(null).\n";
        let result = classify_test(&exited(234, stderr), TESTED_AT);
        assert_eq!(
            result.line.as_deref(),
            Some("[libx264] [error] Error setting preset/tune notapreset/(null).")
        );
    }

    #[test]
    fn a_fatal_line_counts_as_an_error() {
        let result = classify_test(&exited(1, "[fatal] Conversion failed!\n"), TESTED_AT);
        assert_eq!(result.line.as_deref(), Some("[fatal] Conversion failed!"));
    }

    #[test]
    fn a_failure_with_no_log_line_reports_its_first_line_that_is_not_svt_noise() {
        let stderr = format!("{SVT_BANNER}Segmentation fault\n");
        let result = classify_test(&exited(139, &stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Failed);
        assert_eq!(result.line.as_deref(), Some("Segmentation fault"));
    }

    #[test]
    fn a_failure_with_no_stderr_has_no_line_and_keeps_its_exit_code() {
        let result = classify_test(&exited(1, ""), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::Failed);
        assert_eq!(result.line, None);
        assert_eq!(result.exit_code, Some(1));
    }

    #[test]
    fn an_error_line_on_a_clean_exit_still_counts_as_a_warning() {
        let stderr = "[aac @ 0x1] [error] Too many bits per frame requested\n";
        let result = classify_test(&exited(0, stderr), TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::PassedWithWarnings);
        assert_eq!(
            result.line.as_deref(),
            Some("[aac] [error] Too many bits per frame requested")
        );
    }

    #[test]
    fn a_timeout_reports_its_first_error_line_and_no_exit_code() {
        let outcome = CommandOutcome {
            status: CommandStatus::TimedOut,
            stderr: b"[h264_nvenc @ 0x1] [warning] slow\r\n[h264_nvenc @ 0x1] [error] stuck\r\n"
                .to_vec(),
            stdout: Vec::new(),
        };
        let result = classify_test(&outcome, TESTED_AT);
        assert_eq!(result.status, PresetTestStatus::TimedOut);
        assert_eq!(result.line.as_deref(), Some("[h264_nvenc] [error] stuck"));
        assert_eq!(result.exit_code, None);
    }

    #[test]
    fn a_level_below_warning_does_not_count() {
        // The command never asks for these levels, but a line that carries one is still not a
        // warning.
        let stderr = "[libx264 @ 0x1] [info] using cpu capabilities\n[verbose] detail\n";
        assert_eq!(
            classify_test(&exited(0, stderr), TESTED_AT).status,
            PresetTestStatus::Passed
        );
    }

    #[test]
    fn a_long_line_is_cut_at_a_character_boundary() {
        let long = format!("[error] {}", "\u{e9}".repeat(400));
        let result = classify_test(&exited(1, &long), TESTED_AT);
        let line = result.line.expect("the error line is reported");
        assert!(line.len() <= MAX_LINE_BYTES, "{}", line.len());
        assert!(line.len() > MAX_LINE_BYTES - 2);
        assert!(long.starts_with(&line));
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_omits_absent_fields() {
        let passed = serde_json::to_value(PresetTestResult {
            status: PresetTestStatus::PassedWithWarnings,
            line: None,
            exit_code: None,
            tested_at: TESTED_AT,
        })
        .unwrap();
        assert_eq!(
            passed,
            serde_json::json!({ "status": "passedWithWarnings", "testedAt": TESTED_AT })
        );

        let failed = serde_json::to_value(PresetTestResult {
            status: PresetTestStatus::Failed,
            line: Some("[error] x".to_owned()),
            exit_code: Some(-22),
            tested_at: TESTED_AT,
        })
        .unwrap();
        assert_eq!(
            failed,
            serde_json::json!({
                "status": "failed",
                "line": "[error] x",
                "exitCode": -22,
                "testedAt": TESTED_AT,
            })
        );
        for (status, wire) in [
            (PresetTestStatus::Passed, "passed"),
            (PresetTestStatus::TimedOut, "timedOut"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), wire);
        }
    }

    // -- run_test_command -----------------------------------------------------------------

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-preset-test-run-{}-{sequence}",
                std::process::id()
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

    /// An output file as ffmpeg leaves it once the muxer opened it.
    fn written_output(directory: &TestDirectory) -> PathBuf {
        let output = test_output_path(&directory.path);
        fs::write(&output, b"a partly written mp4").unwrap();
        output
    }

    #[test]
    fn the_output_is_deleted_after_a_run_that_passed() {
        // The test binary stands in for ffmpeg: `--list` prints its test names and exits 0.
        let directory = TestDirectory::new();
        let output = written_output(&directory);
        let program = std::env::current_exe().unwrap();

        let outcome = run_test_command(
            &wait_for_encoder_turn(),
            &program,
            &["--list".to_owned()],
            &output,
            Duration::from_secs(30),
        )
        .unwrap();

        assert!(matches!(
            outcome.status,
            CommandStatus::Exited { success: true, .. }
        ));
        assert!(!output.exists());
    }

    #[test]
    fn the_output_is_deleted_after_a_run_that_failed() {
        let directory = TestDirectory::new();
        let output = written_output(&directory);
        let program = std::env::current_exe().unwrap();

        let outcome = run_test_command(
            &wait_for_encoder_turn(),
            &program,
            &["--this-flag-does-not-exist".to_owned()],
            &output,
            Duration::from_secs(30),
        )
        .unwrap();

        assert!(matches!(
            outcome.status,
            CommandStatus::Exited { success: false, .. }
        ));
        assert!(!output.exists());
    }

    #[test]
    fn the_output_is_deleted_after_a_spawn_that_failed() {
        let directory = TestDirectory::new();
        let output = written_output(&directory);

        let error = run_test_command(
            &wait_for_encoder_turn(),
            Path::new("/does/not/exist/ffmpeg-quipclip-test-binary"),
            &[],
            &output,
            Duration::from_secs(30),
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(!output.exists());
    }

    /// One process that runs for far longer than the timeout below, with no shell, for the
    /// reason `smoke.rs`'s own timeout tests give.
    #[cfg(unix)]
    fn hanging_command() -> (PathBuf, Vec<String>) {
        (PathBuf::from("/bin/sleep"), vec!["10".to_owned()])
    }

    #[cfg(windows)]
    fn hanging_command() -> (PathBuf, Vec<String>) {
        (
            PathBuf::from("ping.exe"),
            vec!["-n".to_owned(), "20".to_owned(), "127.0.0.1".to_owned()],
        )
    }

    #[test]
    fn the_output_is_deleted_after_a_run_killed_at_the_timeout() {
        let directory = TestDirectory::new();
        let output = written_output(&directory);
        let (program, arguments) = hanging_command();
        let started = Instant::now();

        let outcome = run_test_command(
            &wait_for_encoder_turn(),
            &program,
            &arguments,
            &output,
            Duration::from_millis(200),
        )
        .unwrap();

        assert_eq!(outcome.status, CommandStatus::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!output.exists());
        assert_eq!(
            classify_test(&outcome, TESTED_AT).status,
            PresetTestStatus::TimedOut
        );
    }

    #[test]
    fn the_sweep_deletes_old_outputs_of_other_processes_only() {
        let directory = TestDirectory::new();
        let own = std::process::id();
        let other = own.wrapping_add(1);
        let write = |name: &str| {
            let path = directory.path.join(name);
            fs::write(&path, b"output").unwrap();
            path
        };
        let stale = write(&format!("preset-test-{other}-3.tmp"));
        let mine = write(&format!("preset-test-{own}-4.tmp"));
        let unrelated = write("capabilities.json");
        let lookalike = write(&format!("preset-test-{other}-x.tmp"));

        // "Now" lies a minute and a second after the files were written, so they are old.
        let later = SystemTime::now() + Duration::from_secs(61);
        assert_eq!(
            remove_stale_outputs_with(&directory.path, own, later, STALE_OUTPUT_AGE),
            1
        );
        assert!(!stale.exists());
        assert!(
            mine.exists(),
            "a file of this process belongs to its own test"
        );
        assert!(unrelated.exists());
        assert!(lookalike.exists());
    }

    #[test]
    fn the_sweep_keeps_a_young_output_that_another_process_can_still_write() {
        let directory = TestDirectory::new();
        let other = std::process::id().wrapping_add(1);
        let young = directory.path.join(format!("preset-test-{other}-0.tmp"));
        fs::write(&young, b"output").unwrap();

        assert_eq!(
            remove_stale_outputs_with(
                &directory.path,
                std::process::id(),
                SystemTime::now(),
                STALE_OUTPUT_AGE
            ),
            0
        );
        assert!(young.exists());
        // A missing directory has nothing to sweep.
        assert_eq!(
            remove_stale_outputs_with(
                &directory.path.join("absent"),
                std::process::id(),
                SystemTime::now(),
                STALE_OUTPUT_AGE
            ),
            0
        );
    }

    #[test]
    fn an_output_name_gives_its_process_id() {
        assert_eq!(output_process_id("preset-test-4242-0.tmp"), Some(4242));
        for name in [
            "preset-test--0.tmp",
            "preset-test-4242-.tmp",
            "preset-test-4242.tmp",
            "preset-test-42a-0.tmp",
            "preset-test-4242-0.mp4",
            "other-4242-0.tmp",
        ] {
            assert_eq!(output_process_id(name), None, "{name}");
        }
        let output = test_output_path(Path::new("/cache"));
        let name = output.file_name().unwrap().to_str().unwrap();
        assert_eq!(output_process_id(name), Some(std::process::id()));
    }

    #[test]
    fn two_output_paths_never_repeat() {
        let directory = Path::new("/cache");
        assert_ne!(test_output_path(directory), test_output_path(directory));
    }
}
