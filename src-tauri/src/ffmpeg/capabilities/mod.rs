//! Shared vocabulary for ffmpeg capability probing.
//!
//! ADR 006 splits the probe into a listing step and a smoke-test step, then a cache. This
//! module holds the types both steps share: the kind of a codec, the outcome of a smoke
//! test, the licence flags read from `-version`, and the fixed set of encoders the smoke
//! test exercises. It also holds the shape of a finished probe, [`CapabilityReport`], which
//! both the frontend and the on-disk cache read. The listing parsers live in [`listing`].
//! The smoke test itself, its timed process runner, and the application-wide smoke-test
//! lock live in [`smoke`]. The cache file that stores a [`CapabilityReport`] per probed
//! binary lives in [`cache`].

pub mod cache;
pub mod listing;
pub mod smoke;

pub use listing::{
    license_flags, parse_codec_list, parse_filter_list, parse_hwaccel_list, parse_version,
};
pub use smoke::{
    classify, run_smoke_report, run_smoke_test, run_with_timeout, smoke_arguments, stderr_tail,
    CommandOutcome, CommandStatus, SmokeReport, StdoutCapture, PROBE_DETAIL_LIMIT, SMOKE_TIMEOUT,
};

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

/// The media kind ffmpeg reports for one codec row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodecKind {
    Video,
    Audio,
    Subtitle,
}

/// The outcome of a smoke test for one candidate encoder.
///
/// The listing step alone can only ever produce [`EncoderStatus::NotListed`]; the other
/// variants belong to the smoke-test step that ADR 006 describes but this unit does not
/// implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncoderStatus {
    Works,
    NotListed,
    Failed,
    TimedOut,
}

/// The licence flags read from the `configuration:` line of `ffmpeg -version`.
///
/// ADR 005 needs these for the consent dialog. This is the only capability that the
/// `-version` output carries and no other listing does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFlags {
    pub gpl: bool,
    pub nonfree: bool,
    pub version3: bool,
}

/// One row of `ffmpeg -encoders` or `ffmpeg -decoders`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCodec {
    pub name: String,
    pub kind: CodecKind,
    pub experimental: bool,
    pub description: String,
}

/// The version string and the configuration flags parsed from `ffmpeg -version`.
///
/// ADR 006's `located` event carries the version, and the cache key includes the version
/// string, so this type crosses both the cache file and the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub configuration_flags: Vec<String>,
}

/// The outcome of probing one candidate encoder, combining the listing step and the
/// smoke-test step.
///
/// `listed` is `false` exactly when `status` is [`EncoderStatus::NotListed`]: the listing
/// step never runs a smoke test for an encoder the build does not have. `exit_code` and
/// `detail` are absent, not `null`, on the wire: the frontend expects the key to be missing
/// entirely for a candidate that has neither, such as one the listing step already rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderResult {
    pub name: String,
    pub kind: CodecKind,
    pub listed: bool,
    pub status: EncoderStatus,
    /// The smoke-test process's exit code, when the process ran to completion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// A short diagnostic for a failed or timed-out smoke test, such as a stderr tail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The full result of one ADR 006 capability probe: the licence flags, the hardware
/// accelerators, and every tested encoder's outcome.
///
/// The `finished` event carries this to the frontend, and [`cache`] stores it on disk keyed
/// by [`cache::CacheKey`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub version: String,
    pub license: LicenseFlags,
    pub hwaccels: Vec<String>,
    pub encoders: Vec<EncoderResult>,
    /// When the probe started, in whole seconds since the Unix epoch (Unix seconds, not
    /// milliseconds). This is pinned on the TypeScript side; do not switch units here. The
    /// type is a plain `i64`, but the frontend only accepts a value strictly greater than `0`
    /// and at most [`cache::MAX_PROBED_AT_SECONDS`]; [`cache::read`] enforces that range on
    /// this field on the way out of the cache, so it can never widen it without also widening
    /// the constant. A cache entry keeps no second copy of the probe time, so there is no other
    /// value the check could land on by mistake.
    pub probed_at: i64,
}

/// One encoder the smoke test exercises.
///
/// The name matches the ffmpeg encoder name exactly, so a listing lookup and a smoke-test
/// invocation both use it verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub name: &'static str,
    pub kind: CodecKind,
}

/// The fixed set of encoders ADR 006 tests, video first and then audio.
///
/// The set is fixed by decision, not discovered from a listing: a probe of every listed
/// encoder would run for a long time and would test encoders that no export preset offers.
pub const TESTED_ENCODERS: [Candidate; 12] = [
    Candidate {
        name: "h264_nvenc",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "hevc_nvenc",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_qsv",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_amf",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "h264_videotoolbox",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "hevc_videotoolbox",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libx264",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libx265",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libsvtav1",
        kind: CodecKind::Video,
    },
    Candidate {
        name: "libfdk_aac",
        kind: CodecKind::Audio,
    },
    Candidate {
        name: "aac",
        kind: CodecKind::Audio,
    },
    Candidate {
        name: "libopus",
        kind: CodecKind::Audio,
    },
];

/// Where a finished [`CapabilityReport`] came from: a fresh probe, or the on-disk cache.
///
/// [`probe_capabilities_with`] reports this directly instead of leaving the caller to infer
/// it: every early-return path is enumerated in exactly one place, so a future change to the
/// sequencing below cannot silently mislabel a report's source the way an outside observer
/// counting emitted events could.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityProbeSource {
    Probe,
    Cache,
}

/// The result of one [`probe_capabilities_with`] call: the report and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutcome {
    pub report: CapabilityReport,
    pub source: CapabilityProbeSource,
}

/// Stable, localizable error codes for the ADR 006 capability probe.
///
/// [`probe_capabilities_with`] returns this directly, and the caller's injected `run_list`
/// closure returns it too for a process-launch failure, so this one type crosses the boundary
/// between the orchestrator and the process-spawning code around it. The Tauri command layer
/// widens each variant into the `failed` event's `code` field and the command's rejection
/// verbatim. ADR 011 forbids a user-facing English sentence in any of these variants; a
/// diagnostic belongs in a separate `detail` field the command layer attaches, never here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityProbeErrorCode {
    AppDataUnavailable,
    FfmpegPairMissing,
    FfmpegSpawnFailed,
    FfmpegProcessFailed,
    VersionParseFailed,
    EncoderListParseFailed,
    CacheUnavailable,
    CommandExecutionFailed,
}

/// The plain data [`probe_capabilities_with`] needs, grouped apart from the closures it also
/// takes.
///
/// `clippy`'s `too-many-arguments` lint (see `clippy.toml`) counts each injected closure as
/// one argument in its own right, so a function that injects four closures has no headroom
/// left for its plain data before it trips the lint. Grouping that data into one struct is
/// the correct fix for a signature this wide; raising the lint's threshold instead would
/// accept a wider signature everywhere else in the crate too, just to excuse this one
/// function.
pub struct ProbeRequest<'a> {
    /// The ffmpeg binary this probe runs against.
    pub ffmpeg: &'a Path,
    /// The directory the on-disk capability cache reads from and writes to.
    pub app_data_directory: &'a Path,
    /// Skip the cache lookup and run the full probe regardless of a cache hit.
    pub force: bool,
    /// When the probe started, in whole seconds since the Unix epoch. Injected rather than
    /// read from the system clock, so a test can pin [`CapabilityReport::probed_at`] to an
    /// exact, reproducible value.
    pub now_unix_seconds: i64,
}

/// Run one full ADR 006 capability probe: list, then smoke-test, then cache.
///
/// This is the pure sequencing logic behind the `start_capability_probe` command. Every side
/// effect -- spawning `ffmpeg` for a listing, running a smoke test, and reporting progress --
/// is injected, so this function runs under a unit test with no real `ffmpeg` binary and no
/// filesystem access beyond the on-disk cache under `app_data_directory`.
///
/// The sequence follows ADR 006 exactly:
///
/// 1. Run `-version` and parse it for the version string and the licence flags, then call
///    `on_located` exactly once with both. This is the only place `-version` ever runs: the
///    caller no longer needs a redundant call of its own to learn the version and licence
///    flags before the rest of the probe proceeds.
/// 2. Fingerprint `ffmpeg` and, unless `force` is set, look the fingerprint up in the cache.
///    A hit returns that report immediately: `run_smoke` is never called, and `-encoders` and
///    `-hwaccels` never run. A fingerprint failure (the binary vanished between discovery and
///    this call, or a filesystem with no mtime support) is not fatal: it just disables the
///    cache lookup and the cache write for this run, since the cache is an optimization, not
///    a prerequisite for a probe.
/// 3. Run `-encoders` and `-hwaccels` and parse both. ADR 006 narrows the first
///    implementation to these two listings; `-decoders` and `-filters` are a recorded
///    non-goal, and this function does not run them.
/// 4. Smoke-test each of [`TESTED_ENCODERS`], in table order. A candidate absent from the
///    parsed encoder list is reported as [`EncoderStatus::NotListed`] without ever calling
///    `run_smoke`; only a listed candidate is actually smoke-tested.
/// 5. Report each result through `emit` as it lands, with a running `done` count and the
///    fixed `total` of [`TESTED_ENCODERS`]'s length.
/// 6. Cache the finished report, unless the fingerprint failed in step 2. A cache write
///    failure is not fatal: the report still reaches the caller, per ADR 006's "a write
///    failure must never keep a probe result from reaching the frontend".
///
/// The return value names the report's source explicitly: [`CapabilityProbeSource::Cache`]
/// for the step-2 early return, [`CapabilityProbeSource::Probe`] for every other `Ok` path.
/// Naming it here, rather than leaving a caller to infer it by watching for a side effect
/// such as an emitted event, keeps every early-return path enumerated in one place.
///
/// `now_unix_seconds` is injected rather than read from the system clock, so a test can pin
/// [`CapabilityReport::probed_at`] to an exact, reproducible value.
///
/// `RunSmoke` returns an `io::Result`, and an `Err` ends the whole run with
/// [`CapabilityProbeErrorCode::FfmpegSpawnFailed`]. An I/O error (file-descriptor exhaustion,
/// the binary removed mid-probe) means the test never ran, so it is not an answer about the
/// encoder: [`EncoderStatus::Failed`] states that the encoder ran and did not work, and a
/// probe that reported it for every remaining candidate would leave the export dialog with no
/// encoder and no reason. The run stops at the first one, nothing is emitted for the
/// candidates after it, and no report is built or cached.
pub fn probe_capabilities_with<RunList, OnLocated, RunSmoke, Emit>(
    request: ProbeRequest<'_>,
    run_list: RunList,
    on_located: OnLocated,
    run_smoke: RunSmoke,
    emit: Emit,
) -> Result<ProbeOutcome, CapabilityProbeErrorCode>
where
    RunList: Fn(&[&str]) -> Result<String, CapabilityProbeErrorCode>,
    OnLocated: Fn(&VersionInfo, LicenseFlags),
    RunSmoke: Fn(&str, CodecKind) -> io::Result<SmokeReport>,
    Emit: Fn(&EncoderResult, u32, u32),
{
    let ProbeRequest {
        ffmpeg,
        app_data_directory,
        force,
        now_unix_seconds,
    } = request;

    let version_stdout = run_list(&["-version"])?;
    let version_info =
        parse_version(&version_stdout).ok_or(CapabilityProbeErrorCode::VersionParseFailed)?;
    let license = license_flags(&version_info.configuration_flags);
    on_located(&version_info, license);

    // A fingerprint failure disables the cache for this run rather than aborting the probe:
    // the cache is a pure optimization, and `cache::read` already treats every cache problem
    // as a miss by design, so this is the same policy applied one step earlier.
    let cache_key = cache::fingerprint(ffmpeg, &version_info.version).ok();
    if !force {
        if let Some(key) = cache_key.as_ref() {
            if let Some(cached_report) = cache::read(app_data_directory, key) {
                return Ok(ProbeOutcome {
                    report: cached_report,
                    source: CapabilityProbeSource::Cache,
                });
            }
        }
    }

    let encoders_stdout = run_list(&["-hide_banner", "-encoders"])?;
    let listed_encoders = parse_codec_list(&encoders_stdout);
    if listed_encoders.is_empty() {
        // A real ffmpeg build always lists at least a handful of encoders; an empty result
        // means the separator line `parse_codec_list` requires never appeared, the same
        // signal `listing`'s own tests use for unparseable output.
        return Err(CapabilityProbeErrorCode::EncoderListParseFailed);
    }

    let hwaccels_stdout = run_list(&["-hide_banner", "-hwaccels"])?;
    let hwaccels = parse_hwaccel_list(&hwaccels_stdout);

    let total = TESTED_ENCODERS.len() as u32;
    let mut encoders = Vec::with_capacity(TESTED_ENCODERS.len());
    for (index, candidate) in TESTED_ENCODERS.iter().enumerate() {
        let listed = listed_encoders
            .iter()
            .any(|encoder| encoder.name == candidate.name);
        // A candidate the listing step never spawned has no exit code and needs no
        // diagnostic, so `NotListed` always carries neither. A candidate that ran and
        // worked needs no diagnostic either, even though the process itself did have an
        // exit code: only `Failed` and `TimedOut` carry `exit_code` and `detail` onward.
        let (status, exit_code, detail) = if listed {
            // An I/O error means the smoke test never ran. Reporting it as a verdict on this
            // candidate, and then on every candidate after it, is what this early return
            // exists to prevent.
            let report = run_smoke(candidate.name, candidate.kind)
                .map_err(|_| CapabilityProbeErrorCode::FfmpegSpawnFailed)?;
            match report.status {
                EncoderStatus::Failed | EncoderStatus::TimedOut => {
                    (report.status, report.exit_code, report.detail)
                }
                EncoderStatus::Works | EncoderStatus::NotListed => (report.status, None, None),
            }
        } else {
            (EncoderStatus::NotListed, None, None)
        };
        let result = EncoderResult {
            name: candidate.name.to_owned(),
            kind: candidate.kind,
            listed,
            status,
            exit_code,
            detail,
        };
        let done = (index + 1) as u32;
        emit(&result, done, total);
        encoders.push(result);
    }

    let report = CapabilityReport {
        version: version_info.version,
        license,
        hwaccels,
        encoders,
        probed_at: now_unix_seconds,
    };

    // A cache write failure must never keep this report from reaching the caller: ADR 006
    // treats the cache as a pure optimization, so its error is discarded here on purpose. A
    // missing `cache_key` (the step-2 fingerprint failed) is the one reason to skip the write
    // entirely: there is no key to write under. A report a smoke-test I/O error may have
    // poisoned cannot reach this point at all, because that error already ended the run.
    if let Some(key) = cache_key.as_ref() {
        let _ = cache::write(app_data_directory, key, &report);
    }

    Ok(ProbeOutcome {
        report,
        source: CapabilityProbeSource::Probe,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the full name list, in order, and each entry's [`CodecKind`].
    ///
    /// A wrong kind is silent and harmful: the smoke-test unit would feed an audio encoder
    /// the `color=` video source per ADR 006 and report a working encoder as broken. Since
    /// the name list is asserted in full, a rename cannot pass silently either.
    #[test]
    fn tested_encoders_have_the_expected_names_and_kinds() {
        const AUDIO: [&str; 3] = ["libfdk_aac", "aac", "libopus"];
        const VIDEO: [&str; 9] = [
            "h264_nvenc",
            "hevc_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_videotoolbox",
            "hevc_videotoolbox",
            "libx264",
            "libx265",
            "libsvtav1",
        ];

        let names: Vec<&str> = TESTED_ENCODERS
            .iter()
            .map(|candidate| candidate.name)
            .collect();
        let expected: Vec<&str> = VIDEO.into_iter().chain(AUDIO).collect();
        assert_eq!(names, expected);

        for candidate in TESTED_ENCODERS {
            let expected_kind = if AUDIO.contains(&candidate.name) {
                CodecKind::Audio
            } else {
                CodecKind::Video
            };
            assert_eq!(candidate.kind, expected_kind);
        }
    }

    // -- probe_capabilities_with -------------------------------------------------------

    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static ORCHESTRATOR_TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A real `ffmpeg -version` fixture. The version token, `9.0.1`, is reused by
    /// [`write_dummy_ffmpeg`]'s caller to build a matching [`cache::CacheKey`].
    const VERSION_STDOUT: &str = "ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with Apple clang\nconfiguration: --enable-gpl --enable-version3\n";

    /// An `-encoders` fixture that lists exactly four of the twelve [`TESTED_ENCODERS`]:
    /// two video (`libx264`, `libx265`) and two audio (`aac`, `libopus`). The other eight
    /// must come back [`EncoderStatus::NotListed`] without ever reaching `run_smoke`.
    const ENCODERS_STDOUT: &str = " ------\n V....D libx264              libx264 H.264\n V....D libx265              libx265 H.265\n A....D aac                  AAC\n A....D libopus              libopus Opus\n";

    const HWACCELS_STDOUT: &str = "Hardware acceleration methods:\nvideotoolbox\n";

    const LISTED_NAMES: [&str; 4] = ["libx264", "libx265", "aac", "libopus"];

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let counter = ORCHESTRATOR_TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-capabilities-orchestrator-test-{}-{counter}",
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

    /// Write a stand-in `ffmpeg` binary so [`cache::fingerprint`] has a real file to read
    /// metadata from, and return its path.
    fn write_dummy_ffmpeg(directory: &Path) -> PathBuf {
        let path = directory.join("ffmpeg");
        fs::write(&path, b"stand-in ffmpeg binary").unwrap();
        path
    }

    /// The full-probe `run_list` closure: answers `-version`, `-encoders`, and `-hwaccels`
    /// with the fixtures above, and panics on anything else so an unexpected call is loud.
    fn full_probe_run_list(args: &[&str]) -> Result<String, CapabilityProbeErrorCode> {
        match args {
            ["-version"] => Ok(VERSION_STDOUT.to_owned()),
            ["-hide_banner", "-encoders"] => Ok(ENCODERS_STDOUT.to_owned()),
            ["-hide_banner", "-hwaccels"] => Ok(HWACCELS_STDOUT.to_owned()),
            other => panic!("unexpected run_list arguments: {other:?}"),
        }
    }

    /// An `on_located` that ignores the call, for a test that does not care about it.
    fn no_op_on_located(_: &VersionInfo, _: LicenseFlags) {}

    /// An `on_located` for a test where `-version` itself never succeeds, so this must never
    /// run.
    fn unreachable_on_located(_: &VersionInfo, _: LicenseFlags) {
        panic!("must not be reached")
    }

    /// A [`SmokeReport`] for a candidate that simply worked: no exit code, no diagnostic.
    ///
    /// Wrapped in `Ok` because `RunSmoke` returns an `io::Result`: an `Err` means the test
    /// never ran, which is a different statement from any [`EncoderStatus`].
    fn works_report() -> io::Result<SmokeReport> {
        Ok(SmokeReport {
            status: EncoderStatus::Works,
            exit_code: None,
            detail: None,
        })
    }

    #[test]
    fn cache_hit_runs_no_smoke_tests_and_returns_the_cached_report() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);
        let key = cache::fingerprint(&ffmpeg, "9.0.1").unwrap();
        let cached_report = CapabilityReport {
            version: "9.0.1".to_owned(),
            license: LicenseFlags {
                gpl: true,
                nonfree: false,
                version3: false,
            },
            hwaccels: vec!["videotoolbox".to_owned()],
            encoders: vec![EncoderResult {
                name: "libx264".to_owned(),
                kind: CodecKind::Video,
                listed: true,
                status: EncoderStatus::Works,
                exit_code: None,
                detail: None,
            }],
            probed_at: 1_700_000_000,
        };
        cache::write(&directory.path, &key, &cached_report).unwrap();

        let run_list_calls = RefCell::new(Vec::new());
        let run_list = |args: &[&str]| -> Result<String, CapabilityProbeErrorCode> {
            run_list_calls
                .borrow_mut()
                .push(args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
            match args {
                ["-version"] => Ok(VERSION_STDOUT.to_owned()),
                other => panic!("cache hit must not fetch beyond -version, got {other:?}"),
            }
        };
        let run_smoke = |_: &str, _: CodecKind| -> io::Result<SmokeReport> {
            panic!("a cache hit must never run a smoke test")
        };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted.borrow_mut().push((result.clone(), done, total));
        };
        let located_calls = RefCell::new(Vec::new());
        let on_located = |version_info: &VersionInfo, license: LicenseFlags| {
            located_calls
                .borrow_mut()
                .push((version_info.clone(), license));
        };

        let outcome = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_999,
            },
            run_list,
            on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        assert_eq!(outcome.report, cached_report);
        assert_eq!(outcome.source, CapabilityProbeSource::Cache);
        assert!(emitted.borrow().is_empty());
        assert_eq!(run_list_calls.borrow().len(), 1);
        // `on_located` must still fire exactly once on a cache hit, with the version that
        // -version reported, even though the rest of the probe never runs.
        assert_eq!(located_calls.borrow().len(), 1);
        assert_eq!(located_calls.borrow()[0].0.version, "9.0.1");
    }

    #[test]
    fn force_bypasses_the_cache_and_runs_the_full_probe() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);
        let key = cache::fingerprint(&ffmpeg, "9.0.1").unwrap();
        let stale_report = CapabilityReport {
            version: "9.0.1".to_owned(),
            license: LicenseFlags::default(),
            hwaccels: vec![],
            encoders: vec![],
            probed_at: 1_700_000_000,
        };
        cache::write(&directory.path, &key, &stale_report).unwrap();

        let smoke_calls = RefCell::new(Vec::new());
        let run_smoke = |name: &str, kind: CodecKind| -> io::Result<SmokeReport> {
            smoke_calls.borrow_mut().push((name.to_owned(), kind));
            works_report()
        };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted.borrow_mut().push((result.clone(), done, total));
        };
        let located_calls = RefCell::new(Vec::new());
        let on_located = |version_info: &VersionInfo, license: LicenseFlags| {
            located_calls
                .borrow_mut()
                .push((version_info.clone(), license));
        };

        let outcome = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: true,
                now_unix_seconds: 1_700_000_100,
            },
            full_probe_run_list,
            on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        assert_eq!(outcome.source, CapabilityProbeSource::Probe);
        let report = outcome.report;
        assert_ne!(report.probed_at, stale_report.probed_at);
        assert_eq!(report.probed_at, 1_700_000_100);
        assert_eq!(smoke_calls.borrow().len(), LISTED_NAMES.len());
        for (name, _) in smoke_calls.borrow().iter() {
            assert!(LISTED_NAMES.contains(&name.as_str()));
        }
        assert_eq!(emitted.borrow().len(), TESTED_ENCODERS.len());
        // `on_located` must fire exactly once on the full-probe path too, with the version
        // -version reported, not once per subsequent listing call.
        assert_eq!(located_calls.borrow().len(), 1);
        assert_eq!(located_calls.borrow()[0].0.version, "9.0.1");
    }

    #[test]
    fn a_candidate_absent_from_the_listing_is_never_smoke_tested() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let smoke_calls = RefCell::new(Vec::new());
        let run_smoke = |name: &str, kind: CodecKind| -> io::Result<SmokeReport> {
            smoke_calls.borrow_mut().push((name.to_owned(), kind));
            works_report()
        };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted.borrow_mut().push((result.clone(), done, total));
        };

        probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_200,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        let smoke_names: Vec<String> = smoke_calls
            .borrow()
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        assert_eq!(smoke_names.len(), LISTED_NAMES.len());
        for name in &smoke_names {
            assert!(LISTED_NAMES.contains(&name.as_str()));
        }

        for (result, _, _) in emitted.borrow().iter() {
            if LISTED_NAMES.contains(&result.name.as_str()) {
                assert!(result.listed);
                assert_eq!(result.status, EncoderStatus::Works);
            } else {
                assert!(!result.listed);
                assert_eq!(result.status, EncoderStatus::NotListed);
                assert!(!smoke_names.contains(&result.name));
            }
        }
    }

    #[test]
    fn results_emit_in_table_order_with_done_incrementing_to_total() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_smoke = |_: &str, _: CodecKind| -> io::Result<SmokeReport> { works_report() };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted
                .borrow_mut()
                .push((result.name.clone(), done, total));
        };

        probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_300,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        let expected_total = TESTED_ENCODERS.len() as u32;
        let expected_names: Vec<&str> = TESTED_ENCODERS
            .iter()
            .map(|candidate| candidate.name)
            .collect();
        let emitted = emitted.borrow();
        assert_eq!(emitted.len(), TESTED_ENCODERS.len());
        for (index, (name, done, total)) in emitted.iter().enumerate() {
            assert_eq!(name, expected_names[index]);
            assert_eq!(*done, (index + 1) as u32);
            assert_eq!(*total, expected_total);
        }
    }

    #[test]
    fn a_version_parse_failure_yields_version_parse_failed() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_list = |_: &[&str]| -> Result<String, CapabilityProbeErrorCode> {
            Ok("not a version line".to_owned())
        };
        let run_smoke =
            |_: &str, _: CodecKind| -> io::Result<SmokeReport> { panic!("must not be reached") };
        let emit = |_: &EncoderResult, _: u32, _: u32| panic!("must not be reached");

        let error = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_400,
            },
            run_list,
            unreachable_on_located,
            run_smoke,
            emit,
        )
        .unwrap_err();

        assert_eq!(error, CapabilityProbeErrorCode::VersionParseFailed);
    }

    #[test]
    fn an_encoder_list_parse_failure_yields_encoder_list_parse_failed() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_list = |args: &[&str]| -> Result<String, CapabilityProbeErrorCode> {
            match args {
                ["-version"] => Ok(VERSION_STDOUT.to_owned()),
                ["-hide_banner", "-encoders"] => Ok("no separator line here".to_owned()),
                other => panic!("must not fetch hwaccels first, got {other:?}"),
            }
        };
        let run_smoke =
            |_: &str, _: CodecKind| -> io::Result<SmokeReport> { panic!("must not be reached") };
        let emit = |_: &EncoderResult, _: u32, _: u32| panic!("must not be reached");

        let error = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_500,
            },
            run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap_err();

        assert_eq!(error, CapabilityProbeErrorCode::EncoderListParseFailed);
    }

    #[test]
    fn a_cache_write_failure_still_returns_the_report() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);
        // A file where the cache expects a directory makes both the read and the write
        // fail with a plain I/O error, which is exactly the "damaged cache" case ADR 006
        // requires the probe to survive.
        let app_data_directory = directory.path.join("app-data-is-a-file");
        fs::write(&app_data_directory, b"not a directory").unwrap();

        let run_smoke = |_: &str, _: CodecKind| -> io::Result<SmokeReport> { works_report() };
        let emit = |_: &EncoderResult, _: u32, _: u32| {};

        let outcome = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &app_data_directory,
                force: false,
                now_unix_seconds: 1_700_000_600,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        assert_eq!(outcome.source, CapabilityProbeSource::Probe);
        assert_eq!(outcome.report.version, "9.0.1");
        assert_eq!(outcome.report.probed_at, 1_700_000_600);
        assert_eq!(outcome.report.encoders.len(), TESTED_ENCODERS.len());
    }

    #[test]
    fn an_io_error_during_smoke_testing_ends_the_run_and_never_answers_for_an_encoder() {
        // An I/O error means the smoke test never ran, so it is not a verdict. The run must
        // stop at the first one: it must not emit a result for the candidate that raised it,
        // must not emit a result for any candidate after it, must not build a report, and
        // must not reach the cache.
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);
        let key = cache::fingerprint(&ffmpeg, "9.0.1").unwrap();
        let cache_file = directory.path.join(cache::CACHE_FILE_NAME);

        let smoke_calls = Cell::new(0u32);
        let run_smoke = |_: &str, _: CodecKind| -> io::Result<SmokeReport> {
            smoke_calls.set(smoke_calls.get() + 1);
            Err(io::Error::other(
                "too many open files, so the test never ran",
            ))
        };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted.borrow_mut().push((result.clone(), done, total));
        };

        let error = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_700,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .expect_err("an I/O error from a smoke test must end the run");

        assert_eq!(error, CapabilityProbeErrorCode::FfmpegSpawnFailed);
        assert_eq!(
            smoke_calls.get(),
            1,
            "the run must stop at the first I/O error rather than test every candidate after it"
        );
        let statuses: Vec<EncoderStatus> = emitted
            .borrow()
            .iter()
            .map(|(result, _, _)| result.status)
            .collect();
        assert!(
            !statuses.contains(&EncoderStatus::Failed),
            "`failed` means the encoder ran and did not work, which this run never measured"
        );
        assert!(cache::read(&directory.path, &key).is_none());
        assert!(
            !cache_file.exists(),
            "a run that ended on an I/O error must not reach the cache"
        );
    }

    #[test]
    fn a_spawn_failure_from_run_list_propagates_through_the_orchestrator() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_list = |_: &[&str]| -> Result<String, CapabilityProbeErrorCode> {
            Err(CapabilityProbeErrorCode::FfmpegSpawnFailed)
        };
        let run_smoke =
            |_: &str, _: CodecKind| -> io::Result<SmokeReport> { panic!("must not be reached") };
        let emit = |_: &EncoderResult, _: u32, _: u32| panic!("must not be reached");

        let error = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_800,
            },
            run_list,
            unreachable_on_located,
            run_smoke,
            emit,
        )
        .unwrap_err();

        assert_eq!(error, CapabilityProbeErrorCode::FfmpegSpawnFailed);
    }

    #[test]
    fn a_process_failure_from_run_list_propagates_through_the_orchestrator() {
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_list = |_: &[&str]| -> Result<String, CapabilityProbeErrorCode> {
            Err(CapabilityProbeErrorCode::FfmpegProcessFailed)
        };
        let run_smoke =
            |_: &str, _: CodecKind| -> io::Result<SmokeReport> { panic!("must not be reached") };
        let emit = |_: &EncoderResult, _: u32, _: u32| panic!("must not be reached");

        let error = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_000_900,
            },
            run_list,
            unreachable_on_located,
            run_smoke,
            emit,
        )
        .unwrap_err();

        assert_eq!(error, CapabilityProbeErrorCode::FfmpegProcessFailed);
    }

    #[test]
    fn a_fingerprint_failure_still_produces_a_full_report_with_source_probe() {
        // `ffmpeg` here is never written to disk, so `cache::fingerprint`'s `fs::metadata`
        // call fails immediately -- the same failure a binary deleted between discovery and
        // this call, or a filesystem with no mtime support, would produce. Finding 3: this
        // must disable the cache, not abort the probe. `run_list` and `run_smoke` are plain
        // injected closures that never touch the filesystem, so the probe itself still runs
        // to completion.
        let directory = TestDirectory::new();
        let ffmpeg = directory.path.join("ffmpeg-that-does-not-exist");
        assert!(cache::fingerprint(&ffmpeg, "9.0.1").is_err());

        let run_smoke = |_: &str, _: CodecKind| -> io::Result<SmokeReport> { works_report() };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, done: u32, total: u32| {
            emitted.borrow_mut().push((result.clone(), done, total));
        };

        let outcome = probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_001_000,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        assert_eq!(outcome.source, CapabilityProbeSource::Probe);
        assert_eq!(outcome.report.version, "9.0.1");
        assert_eq!(outcome.report.encoders.len(), TESTED_ENCODERS.len());
        assert_eq!(emitted.borrow().len(), TESTED_ENCODERS.len());
        // There is no cache file at all: a missing fingerprint must skip the write entirely,
        // not merely fail it.
        assert!(!directory.path.join(cache::CACHE_FILE_NAME).exists());
    }

    #[test]
    fn a_failed_candidate_carries_diagnostics_while_works_and_not_listed_do_not() {
        // Of the four listed candidates in ENCODERS_STDOUT, report libx264 as a failure
        // with a real exit code and stderr tail; every other listed candidate simply works.
        // h264_nvenc is absent from ENCODERS_STDOUT entirely, so it must come back
        // NotListed without ever reaching this closure.
        let directory = TestDirectory::new();
        let ffmpeg = write_dummy_ffmpeg(&directory.path);

        let run_smoke = |name: &str, _: CodecKind| -> io::Result<SmokeReport> {
            if name == "libx264" {
                Ok(SmokeReport {
                    status: EncoderStatus::Failed,
                    exit_code: Some(1),
                    detail: Some("libx264 exploded".to_owned()),
                })
            } else {
                works_report()
            }
        };
        let emitted = RefCell::new(Vec::new());
        let emit = |result: &EncoderResult, _: u32, _: u32| {
            emitted.borrow_mut().push(result.clone());
        };

        probe_capabilities_with(
            ProbeRequest {
                ffmpeg: &ffmpeg,
                app_data_directory: &directory.path,
                force: false,
                now_unix_seconds: 1_700_001_100,
            },
            full_probe_run_list,
            no_op_on_located,
            run_smoke,
            emit,
        )
        .unwrap();

        let emitted = emitted.borrow();

        let failed = emitted
            .iter()
            .find(|result| result.name == "libx264")
            .expect("libx264 is listed in the fixture");
        assert_eq!(failed.status, EncoderStatus::Failed);
        assert_eq!(failed.exit_code, Some(1));
        assert_eq!(failed.detail.as_deref(), Some("libx264 exploded"));

        let working = emitted
            .iter()
            .find(|result| result.name == "libx265")
            .expect("libx265 is listed in the fixture");
        assert_eq!(working.status, EncoderStatus::Works);
        assert!(working.exit_code.is_none());
        assert!(working.detail.is_none());

        let not_listed = emitted
            .iter()
            .find(|result| result.name == "h264_nvenc")
            .expect("h264_nvenc is absent from the fixture");
        assert_eq!(not_listed.status, EncoderStatus::NotListed);
        assert!(not_listed.exit_code.is_none());
        assert!(not_listed.detail.is_none());
    }
}
