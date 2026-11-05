//! The install of the downloaded programs (ADR 058, section "The install").
//!
//! [`run`] takes one target of the manifest through every step. It downloads each archive into
//! the install work directory, extracts the two programs and deletes each zip, prepares the
//! programs to run, checks their versions and licence against the manifest, and then moves
//! `ffprobe` and `ffmpeg`, in that order, into `<local_data>/bin`. A program that fails a check
//! never reaches `bin`.
//!
//! The version check of a pair ([`check_pair`]) also decides whether the offer of a download may
//! replace a pair that discovery found in `<local_data>/bin` (ADR 058, "When QuipClip offers the
//! download").

use super::download::{download_archive, Cancel, DownloadError, Fetch};
use super::extract::{extract_entry, ExtractError};
use super::manifest::{Program, Target};
use super::InstallErrorCode;
use crate::app_cache::work::WorkDirectory;
use crate::ffmpeg::capabilities::smoke::{
    run_with_timeout_in, stderr_tail, CommandOutcome, CommandStatus, RunPlace, StdoutCapture,
    PROBE_DETAIL_LIMIT,
};
use crate::ffmpeg::{license_flags, parse_program_version, LicenseFlags};
use crate::fsutil::{replace_file_within, reserve_temporary_path, TemporaryFileCleanup};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The longest run of `-version`.
pub const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the version check looks at its process and at the cancel.
const VERSION_CHECK_POLL: Duration = Duration::from_millis(50);

/// The budget of each move into `bin`. Antivirus software can hold a new program for a while
/// after it closes, so this is the budget of the publication of an export (ADR 016), not the
/// default of ADR 015.
pub const MOVE_BUDGET: Duration = Duration::from_secs(30);

/// How old a temporary file of another process in `bin` must be before [`sweep_bin`] removes it.
pub const STALE_TEMPORARY_FILE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The longest run of `xattr` on macOS.
#[cfg(target_os = "macos")]
const XATTR_TIMEOUT: Duration = Duration::from_secs(5);

/// The failure of an install: a stable code for the interface and a diagnostic text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallFailure {
    pub code: InstallErrorCode,
    pub detail: Option<String>,
}

impl InstallFailure {
    #[must_use]
    pub fn new(code: InstallErrorCode, detail: impl Into<Option<String>>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl From<DownloadError> for InstallFailure {
    fn from(error: DownloadError) -> Self {
        let code = match &error {
            DownloadError::Network(_) => InstallErrorCode::NetworkFailed,
            DownloadError::HttpStatus(_) => InstallErrorCode::HttpStatus,
            DownloadError::Size { .. } | DownloadError::TooLong { .. } => {
                InstallErrorCode::SizeMismatch
            }
            DownloadError::Hash { .. } => InstallErrorCode::HashMismatch,
            DownloadError::Write(_) => InstallErrorCode::WriteFailed,
            DownloadError::Canceled => return Self::new(InstallErrorCode::Canceled, None),
        };
        Self::new(code, error.to_string())
    }
}

impl From<ExtractError> for InstallFailure {
    fn from(error: ExtractError) -> Self {
        let code = match &error {
            ExtractError::Archive(_) => InstallErrorCode::ArchiveInvalid,
            ExtractError::EntryMissing(_) => InstallErrorCode::EntryMissing,
            ExtractError::Write(_) => InstallErrorCode::WriteFailed,
            ExtractError::Canceled => return Self::new(InstallErrorCode::Canceled, None),
        };
        Self::new(code, error.to_string())
    }
}

/// The step of an install that runs now, for the progress of the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// `received` of `total` bytes of all the archives. When an archive goes on to its next URL,
    /// `received` goes back to the start of that archive.
    Download {
        received: u64,
        total: u64,
    },
    Extract,
    Check,
    Install,
}

/// Runs `<program> -version` with a time limit and a stop flag. Tests give a fake.
pub type VersionRunner<'a> =
    dyn Fn(&Path, Option<&std::sync::atomic::AtomicBool>) -> io::Result<CommandOutcome> + 'a;

/// The runner of the application: the program itself, with no console window (ADR 018).
pub fn run_version(
    program: &Path,
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> io::Result<CommandOutcome> {
    run_with_timeout_in(
        program,
        &["-version".to_owned()],
        VERSION_CHECK_TIMEOUT,
        VERSION_CHECK_POLL,
        StdoutCapture::Capture,
        RunPlace {
            current_directory: None,
            stop,
        },
    )
}

/// The version and the licence flags that one program prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrintedVersion {
    pub version: String,
    pub license: LicenseFlags,
}

/// Read the version line and the licence flags of `<program> -version`. The text of an error is
/// the diagnostic: it names the program and what went wrong.
///
/// A cancel stops the process as the time limit does, and the error then names the time limit.
/// A caller that passes `cancel` reads [`Cancel::is_canceled`] to tell the two apart.
pub fn read_version(
    runner: &VersionRunner<'_>,
    path: &Path,
    program: Program,
    cancel: Option<&Cancel>,
) -> Result<PrintedVersion, String> {
    let name = program.name();
    let outcome = runner(path, cancel.map(Cancel::flag))
        .map_err(|error| format!("{name} did not start: {error}"))?;
    match outcome.status {
        CommandStatus::TimedOut => {
            return Err(format!(
                "{name} did not answer within {} s",
                VERSION_CHECK_TIMEOUT.as_secs()
            ));
        }
        CommandStatus::Exited {
            success: false,
            code,
        } => {
            let code = code.map_or_else(|| "a signal".to_owned(), |code| format!("code {code}"));
            let tail = stderr_tail(&outcome.stderr, PROBE_DETAIL_LIMIT)
                .map(|tail| tail.trim_end().to_owned())
                .filter(|tail| !tail.is_empty());
            return Err(match tail {
                Some(tail) => format!("{name} exited with {code}: {tail}"),
                None => format!("{name} exited with {code}"),
            });
        }
        CommandStatus::Exited { success: true, .. } => {}
    }
    let info = parse_program_version(&String::from_utf8_lossy(&outcome.stdout), name)
        .ok_or_else(|| format!("{name} printed no version line"))?;
    Ok(PrintedVersion {
        license: license_flags(&info.configuration_flags),
        version: info.version,
    })
}

/// What each program of a pair prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrintedPair {
    pub ffmpeg: PrintedVersion,
    pub ffprobe: PrintedVersion,
}

/// The version check of a pair (ADR 058): both programs start, end with success within
/// [`VERSION_CHECK_TIMEOUT`], print a version line, and print the same version. The offer of a
/// download uses this check alone, so it does not compare the licences.
///
/// A cancel gives the error of the time limit, as for [`read_version`].
pub fn check_pair(
    runner: &VersionRunner<'_>,
    ffmpeg: &Path,
    ffprobe: &Path,
    cancel: Option<&Cancel>,
) -> Result<PrintedPair, String> {
    let ffmpeg = read_version(runner, ffmpeg, Program::Ffmpeg, cancel)?;
    let ffprobe = read_version(runner, ffprobe, Program::Ffprobe, cancel)?;
    if ffmpeg.version != ffprobe.version {
        return Err(format!(
            "ffmpeg prints the version {} and ffprobe {}",
            ffmpeg.version, ffprobe.version
        ));
    }
    Ok(PrintedPair { ffmpeg, ffprobe })
}

/// The check of a staged pair against `target`: [`check_pair`], then the version of the
/// manifest, and the licence of the manifest for each program. So QuipClip never installs a
/// build whose licence is not the licence of the dialog. A canceled install starts no program.
pub fn check_staged(
    runner: &VersionRunner<'_>,
    ffmpeg: &Path,
    ffprobe: &Path,
    target: &Target,
    cancel: &Cancel,
) -> Result<(), String> {
    if cancel.is_canceled() {
        return Err("the install was canceled".to_owned());
    }
    let printed = check_pair(runner, ffmpeg, ffprobe, Some(cancel))?;
    if !target.is_version_of(&printed.ffmpeg.version) {
        return Err(format!(
            "the programs print the version {}, not {}",
            printed.ffmpeg.version, target.version
        ));
    }
    for (program, version) in [
        (Program::Ffmpeg, &printed.ffmpeg),
        (Program::Ffprobe, &printed.ffprobe),
    ] {
        if version.license != target.license {
            return Err(format!(
                "{} has the licence flags {:?}, not {:?}",
                program.name(),
                version.license,
                target.license
            ));
        }
    }
    Ok(())
}

/// Prepare a staged program to run. On Unix it gets the mode `0755`. On macOS the attribute
/// `com.apple.quarantine` is also removed, and a failure of that step is ignored, because a file
/// that this process writes has no such attribute in the first place (ADR 058).
pub fn prepare_program(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = crate::ffmpeg::capabilities::smoke::run_with_timeout(
            Path::new("/usr/bin/xattr"),
            &[
                "-d".to_owned(),
                "com.apple.quarantine".to_owned(),
                path.to_string_lossy().into_owned(),
            ],
            XATTR_TIMEOUT,
            VERSION_CHECK_POLL,
            StdoutCapture::Discard,
        );
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Moves one staged file over a destination. Tests give a fake.
pub type Replace<'a> = dyn Fn(&Path, &Path) -> io::Result<()> + 'a;

/// The move of the application: [`replace_file_within`] with [`MOVE_BUDGET`].
pub fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    replace_file_within(source, destination, MOVE_BUDGET)
}

/// Move the staged programs into `bin`: `ffprobe` first and `ffmpeg` last. `staged` gives the
/// staged file of each program. A move between two volumes copies the program into a temporary
/// file in `bin` first, and then replaces the destination with it.
pub fn move_into_bin(
    replace: &Replace<'_>,
    bin: &Path,
    staged: &dyn Fn(Program) -> PathBuf,
) -> Result<(), String> {
    fs::create_dir_all(bin)
        .map_err(|error| format!("the directory {} cannot be made: {error}", bin.display()))?;
    for program in Program::INSTALL_ORDER {
        let source = staged(program);
        let destination = bin.join(program.file_name());
        match replace(&source, &destination) {
            Ok(()) => {}
            // `ERROR_NOT_SAME_DEVICE` on Windows and `EXDEV` on Unix.
            Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
                copy_then_replace(replace, &source, &destination)
                    .map_err(|error| move_error(program, &error))?;
            }
            Err(error) => return Err(move_error(program, &error)),
        }
        // On Unix the rename of `fsutil` gives the new file the mode of the file that it
        // replaced, which an old broken program may not have had.
        prepare_program(&destination).map_err(|error| move_error(program, &error))?;
    }
    Ok(())
}

fn move_error(program: Program, error: &io::Error) -> String {
    format!("{} could not be moved into place: {error}", program.name())
}

/// Copy `source` into a temporary file beside `destination`, then replace `destination` with it.
fn copy_then_replace(replace: &Replace<'_>, source: &Path, destination: &Path) -> io::Result<()> {
    let mut temporary = TemporaryFileCleanup::new(reserve_temporary_path(destination)?);
    fs::copy(source, temporary.path())?;
    // On disk before the rename, as the extraction did for the file in the work directory.
    fs::OpenOptions::new()
        .write(true)
        .open(temporary.path())?
        .sync_all()?;
    prepare_program(temporary.path())?;
    replace(temporary.path(), destination)?;
    temporary.disarm();
    Ok(())
}

/// Remove each temporary file of `fsutil` in `bin` whose modification time is at least
/// `min_age` before `now`: a name of the form `.<program file name>.tmp-<pid>-<n>`. Such a file
/// comes from a process that ended during its move, or from a move whose guard could not remove
/// it, for example while antivirus software held it. Gives the number of files that it removed.
pub fn sweep_bin(bin: &Path, now: SystemTime, min_age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(bin) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_temporary_name(&name) {
            continue;
        }
        let old_enough = entry
            .metadata()
            .ok()
            .filter(fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= min_age);
        if !old_enough {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) => eprintln!(
                "install: the temporary file {} was not removed: {error}",
                entry.path().display()
            ),
        }
    }
    removed
}

/// True for `.<program file name>.tmp-<digits>-<digits>`.
fn is_temporary_name(name: &str) -> bool {
    Program::INSTALL_ORDER.iter().any(|program| {
        name.strip_prefix('.')
            .and_then(|rest| rest.strip_prefix(program.file_name()))
            .and_then(|rest| rest.strip_prefix(".tmp-"))
            .and_then(|rest| rest.split_once('-'))
            .is_some_and(|(process, number)| is_digits(process) && is_digits(number))
    })
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// True when both programs of a pair that discovery found are files directly in `bin`, by their
/// canonical paths. A `bin` that does not exist holds nothing.
#[must_use]
pub fn pair_is_in(ffmpeg: &Path, ffprobe: &Path, bin: &Path) -> bool {
    let Ok(bin) = bin.canonicalize() else {
        return false;
    };
    [ffmpeg, ffprobe].iter().all(|path| {
        path.canonicalize()
            .ok()
            .is_some_and(|path| path.is_file() && path.parent() == Some(bin.as_path()))
    })
}

/// What [`run`] needs besides the target.
pub struct Install<'a, F: Fetch> {
    pub fetch: &'a F,
    pub target: &'a Target,
    pub work: &'a WorkDirectory,
    pub bin: &'a Path,
    pub cancel: &'a Cancel,
    pub run_version: &'a VersionRunner<'a>,
    pub replace: &'a Replace<'a>,
}

/// Install `target` into `bin`, in the steps of ADR 058. `report` gets each step, and the
/// progress of the download after each chunk, which the caller must throttle.
///
/// The download runs with `block_on` on this thread, so call this on an OS thread of its own,
/// never on a worker of the async runtime. The caller removes the work directory, through the
/// drop of its guard. A cancel during the last move is not seen, so the caller reports the
/// result of this function and not the cancel flag.
pub fn run<F: Fetch>(
    install: &Install<'_, F>,
    report: &mut dyn FnMut(Phase),
) -> Result<(), InstallFailure> {
    let total = install.target.download_size();
    let mut done: u64 = 0;
    let mut zips = Vec::with_capacity(install.target.archives.len());
    for (index, archive) in install.target.archives.iter().enumerate() {
        let zip = install.work.file_path(&format!("archive-{index}.zip"));
        let offset = done;
        tauri::async_runtime::block_on(download_archive(
            install.fetch,
            archive,
            &zip,
            install.cancel,
            &mut |received| {
                report(Phase::Download {
                    received: offset + received,
                    total,
                });
            },
        ))?;
        done += archive.size;
        zips.push((archive, zip));
    }

    report(Phase::Extract);
    let staged = |program: Program| install.work.file_path(program.file_name());
    for (archive, zip) in &zips {
        for program in Program::INSTALL_ORDER {
            if let Some(entry) = archive.entries.get(program) {
                extract_entry(zip, entry, &staged(program), install.cancel)?;
            }
        }
        if let Err(error) = fs::remove_file(zip) {
            eprintln!(
                "install: the zip {} was not removed: {error}",
                zip.display()
            );
        }
    }
    for program in Program::INSTALL_ORDER {
        prepare_program(&staged(program)).map_err(|error| {
            InstallFailure::new(InstallErrorCode::WriteFailed, error.to_string())
        })?;
    }

    report(Phase::Check);
    check_staged(
        install.run_version,
        &staged(Program::Ffmpeg),
        &staged(Program::Ffprobe),
        install.target,
        install.cancel,
    )
    .map_err(|detail| {
        if install.cancel.is_canceled() {
            InstallFailure::new(InstallErrorCode::Canceled, None)
        } else {
            InstallFailure::new(InstallErrorCode::VersionCheckFailed, detail)
        }
    })?;
    if install.cancel.is_canceled() {
        return Err(InstallFailure::new(InstallErrorCode::Canceled, None));
    }

    report(Phase::Install);
    move_into_bin(install.replace, install.bin, &staged)
        .map_err(|detail| InstallFailure::new(InstallErrorCode::WriteFailed, detail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_cache::work::FFMPEG_INSTALL_WORK_DIRECTORY;
    use crate::ffmpeg::install::download::Body;
    use crate::ffmpeg::install::manifest::{Archive, Entries, Entry, Method};
    use crate::flv::test_support::TestDirectory;
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::io::{Cursor, Write as _};
    use std::sync::atomic::AtomicBool;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    const GPL3: LicenseFlags = LicenseFlags {
        gpl: true,
        nonfree: false,
        version3: true,
    };

    fn version_output(program: &str, version: &str) -> Vec<u8> {
        format!(
            "{program} version {version} Copyright (c) the FFmpeg developers\r\n\
             configuration: --enable-gpl --enable-version3\r\n"
        )
        .into_bytes()
    }

    fn exited(stdout: Vec<u8>) -> io::Result<CommandOutcome> {
        Ok(CommandOutcome {
            status: CommandStatus::Exited {
                code: Some(0),
                success: true,
            },
            stderr: Vec::new(),
            stdout,
        })
    }

    /// A runner that prints `ffmpeg_version` for a program named `ffmpeg[.exe]`, and
    /// `ffprobe_version` for `ffprobe[.exe]`.
    fn printing<'a>(
        ffmpeg_version: &'a str,
        ffprobe_version: &'a str,
    ) -> impl Fn(&Path, Option<&AtomicBool>) -> io::Result<CommandOutcome> + 'a {
        move |path, _| {
            let name = path.file_name().unwrap().to_string_lossy();
            if name.starts_with("ffprobe") {
                exited(version_output("ffprobe", ffprobe_version))
            } else {
                exited(version_output("ffmpeg", ffmpeg_version))
            }
        }
    }

    fn target(version: &str, archives: Vec<Archive>) -> Target {
        Target {
            version: version.to_owned(),
            source: "example.test".to_owned(),
            license: GPL3,
            archives,
        }
    }

    #[test]
    fn a_version_is_read_with_its_licence_flags() {
        let runner = printing("9.0.2-full_build-www.gyan.dev", "9.0.2");
        let printed = read_version(&runner, Path::new("ffmpeg"), Program::Ffmpeg, None).unwrap();
        assert_eq!(printed.version, "9.0.2-full_build-www.gyan.dev");
        assert_eq!(printed.license, GPL3);
    }

    #[test]
    fn each_failure_of_a_version_run_names_the_program() {
        let cases: [(io::Result<CommandOutcome>, &str); 5] = [
            (
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "blocked by policy",
                )),
                "ffprobe did not start: blocked by policy",
            ),
            (
                Ok(CommandOutcome {
                    status: CommandStatus::TimedOut,
                    stderr: Vec::new(),
                    stdout: Vec::new(),
                }),
                "ffprobe did not answer within 10 s",
            ),
            (
                Ok(CommandOutcome {
                    status: CommandStatus::Exited {
                        code: Some(3),
                        success: false,
                    },
                    stderr: b"missing library".to_vec(),
                    stdout: Vec::new(),
                }),
                "ffprobe exited with code 3: missing library",
            ),
            (
                Ok(CommandOutcome {
                    status: CommandStatus::Exited {
                        code: None,
                        success: false,
                    },
                    stderr: b" \n".to_vec(),
                    stdout: Vec::new(),
                }),
                "ffprobe exited with a signal",
            ),
            (
                exited(b"ffmpeg version 9.0.2\n".to_vec()),
                "ffprobe printed no version line",
            ),
        ];
        for (outcome, message) in cases {
            let outcome = RefCell::new(Some(outcome));
            let runner = |_: &Path, _: Option<&AtomicBool>| outcome.borrow_mut().take().unwrap();
            let error =
                read_version(&runner, Path::new("ffprobe"), Program::Ffprobe, None).unwrap_err();
            assert_eq!(error, message);
        }
    }

    /// A runner where ffprobe prints only `--enable-gpl`, so its licence differs from ffmpeg's.
    fn other_licence(path: &Path, _: Option<&AtomicBool>) -> io::Result<CommandOutcome> {
        if path.ends_with("ffprobe") {
            exited(b"ffprobe version 9.0.2\nconfiguration: --enable-gpl\n".to_vec())
        } else {
            exited(version_output("ffmpeg", "9.0.2"))
        }
    }

    #[test]
    fn a_pair_must_print_one_version_and_its_licence_does_not_count() {
        let same = printing("9.0.2", "9.0.2");
        let pair = check_pair(&same, Path::new("ffmpeg"), Path::new("ffprobe"), None).unwrap();
        assert_eq!(pair.ffmpeg.version, "9.0.2");
        assert_eq!(pair.ffprobe.version, "9.0.2");
        let mixed = printing("9.0.2", "8.1.3");
        let error =
            check_pair(&mixed, Path::new("ffmpeg"), Path::new("ffprobe"), None).unwrap_err();
        assert!(error.contains("9.0.2 and ffprobe 8.1.3"), "{error}");
        // The check of the offer (ADR 058) has no licence rule, so two licences pass it.
        assert!(check_pair(
            &other_licence,
            Path::new("ffmpeg"),
            Path::new("ffprobe"),
            None
        )
        .is_ok());
    }

    #[test]
    fn a_staged_pair_must_have_the_version_and_licence_of_the_manifest() {
        let cancel = Cancel::new();
        let (ffmpeg, ffprobe) = (Path::new("ffmpeg"), Path::new("ffprobe"));
        let target = target("9.0.2", Vec::new());
        assert!(check_staged(
            &printing("9.0.2-x", "9.0.2-x"),
            ffmpeg,
            ffprobe,
            &target,
            &cancel
        )
        .is_ok());
        let error = check_staged(
            &printing("9.0.20", "9.0.20"),
            ffmpeg,
            ffprobe,
            &target,
            &cancel,
        )
        .unwrap_err();
        assert!(error.contains("not 9.0.2"), "{error}");
        let mut nonfree = target.clone();
        nonfree.license.nonfree = true;
        let error = check_staged(
            &printing("9.0.2", "9.0.2"),
            ffmpeg,
            ffprobe,
            &nonfree,
            &cancel,
        )
        .unwrap_err();
        assert!(error.contains("licence flags"), "{error}");
        // Each program must have the licence of the manifest, ffprobe too.
        let error = check_staged(&other_licence, ffmpeg, ffprobe, &target, &cancel).unwrap_err();
        assert!(
            error.starts_with("ffprobe has the licence flags"),
            "{error}"
        );
        // A canceled install starts no program.
        cancel.cancel();
        let started = std::cell::Cell::new(false);
        let watching = |path: &Path, stop: Option<&AtomicBool>| {
            started.set(true);
            printing("9.0.2", "9.0.2")(path, stop)
        };
        assert!(check_staged(&watching, ffmpeg, ffprobe, &target, &cancel).is_err());
        assert!(!started.get());
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_programs_move_into_bin_ffprobe_first() {
        let directory = TestDirectory::new();
        let work = directory.path.join("work");
        fs::create_dir(&work).unwrap();
        let bin = directory.path.join("local").join("bin");
        for program in Program::INSTALL_ORDER {
            write_file(&work.join(program.file_name()), program.name().as_bytes());
        }
        let moved = RefCell::new(Vec::new());
        let recording = |source: &Path, destination: &Path| {
            moved
                .borrow_mut()
                .push(destination.file_name().unwrap().to_owned());
            replace(source, destination)
        };
        move_into_bin(&recording, &bin, &|program| work.join(program.file_name())).unwrap();
        assert_eq!(
            *moved.borrow(),
            [Program::Ffprobe.file_name(), Program::Ffmpeg.file_name()]
        );
        for program in Program::INSTALL_ORDER {
            assert_eq!(
                fs::read(bin.join(program.file_name())).unwrap(),
                program.name().as_bytes()
            );
        }
    }

    #[test]
    fn a_move_replaces_an_old_program_and_leaves_it_runnable() {
        let directory = TestDirectory::new();
        let work = directory.path.join("work");
        let bin = directory.path.join("bin");
        fs::create_dir(&work).unwrap();
        fs::create_dir(&bin).unwrap();
        for program in Program::INSTALL_ORDER {
            write_file(&work.join(program.file_name()), b"new");
            let old = bin.join(program.file_name());
            write_file(&old, b"old and broken");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&old, fs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        move_into_bin(&replace, &bin, &|program| work.join(program.file_name())).unwrap();
        for program in Program::INSTALL_ORDER {
            let path = bin.join(program.file_name());
            assert_eq!(fs::read(&path).unwrap(), b"new");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
        }
    }

    #[test]
    fn a_move_between_two_volumes_copies_into_bin_first() {
        let directory = TestDirectory::new();
        let work = directory.path.join("work");
        let bin = directory.path.join("bin");
        fs::create_dir(&work).unwrap();
        for program in Program::INSTALL_ORDER {
            write_file(&work.join(program.file_name()), program.name().as_bytes());
        }
        // A move out of `work` fails as a move between two volumes. A move inside `bin` works.
        let cross_device = |source: &Path, destination: &Path| {
            if source.starts_with(&work) {
                Err(io::Error::from(io::ErrorKind::CrossesDevices))
            } else {
                replace(source, destination)
            }
        };
        move_into_bin(&cross_device, &bin, &|program| {
            work.join(program.file_name())
        })
        .unwrap();
        assert_eq!(names_in(&bin), program_names(), "no temporary file stays");
        for program in Program::INSTALL_ORDER {
            let path = bin.join(program.file_name());
            assert_eq!(fs::read(&path).unwrap(), program.name().as_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
        }
    }

    #[test]
    fn the_system_reports_a_move_between_two_volumes_with_the_kind_that_the_move_reads() {
        #[cfg(windows)]
        let code = 17; // ERROR_NOT_SAME_DEVICE
        #[cfg(not(windows))]
        let code = 18; // EXDEV
        assert_eq!(
            io::Error::from_raw_os_error(code).kind(),
            io::ErrorKind::CrossesDevices
        );
    }

    #[test]
    fn a_failed_copy_between_two_volumes_leaves_no_temporary_file() {
        let directory = TestDirectory::new();
        let work = directory.path.join("work");
        let bin = directory.path.join("bin");
        fs::create_dir(&work).unwrap();
        for program in Program::INSTALL_ORDER {
            write_file(&work.join(program.file_name()), b"new");
        }
        // Every move fails: the first as a move between two volumes, and the one inside `bin`
        // as a refusal.
        let failing = |source: &Path, _: &Path| {
            if source.starts_with(&work) {
                Err(io::Error::from(io::ErrorKind::CrossesDevices))
            } else {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            }
        };
        let error =
            move_into_bin(&failing, &bin, &|program| work.join(program.file_name())).unwrap_err();
        assert!(error.starts_with("ffprobe could not be moved"), "{error}");
        assert!(names_in(&bin).is_empty(), "{:?}", names_in(&bin));
    }

    fn names_in(directory: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn program_names() -> Vec<String> {
        let mut names: Vec<_> = Program::INSTALL_ORDER
            .iter()
            .map(|program| program.file_name().to_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_failed_move_of_ffmpeg_leaves_the_new_ffprobe() {
        let directory = TestDirectory::new();
        let work = directory.path.join("work");
        let bin = directory.path.join("bin");
        fs::create_dir(&work).unwrap();
        write_file(&work.join(Program::Ffprobe.file_name()), b"new");
        // The staged ffmpeg is missing, so its move fails after the move of ffprobe.
        let error =
            move_into_bin(&replace, &bin, &|program| work.join(program.file_name())).unwrap_err();
        assert!(error.starts_with("ffmpeg could not be moved"), "{error}");
        assert_eq!(
            fs::read(bin.join(Program::Ffprobe.file_name())).unwrap(),
            b"new"
        );
    }

    #[test]
    fn the_sweep_removes_only_old_temporary_files_of_the_programs() {
        let directory = TestDirectory::new();
        let bin = &directory.path;
        let temporary = [
            format!(".{}.tmp-12-3", Program::Ffmpeg.file_name()),
            format!(".{}.tmp-4-0", Program::Ffprobe.file_name()),
        ];
        let kept = [
            Program::Ffmpeg.file_name().to_owned(),
            ".ffplay.tmp-1-2".to_owned(),
            format!(".{}.tmp-1", Program::Ffmpeg.file_name()),
            format!(".{}.tmp-a-1", Program::Ffmpeg.file_name()),
        ];
        for name in temporary.iter().chain(&kept) {
            write_file(&bin.join(name), b"x");
        }
        let now = SystemTime::now();
        assert_eq!(
            sweep_bin(bin, now, STALE_TEMPORARY_FILE_AGE),
            0,
            "young files stay"
        );
        let later = now + STALE_TEMPORARY_FILE_AGE + Duration::from_secs(60);
        assert_eq!(sweep_bin(bin, later, STALE_TEMPORARY_FILE_AGE), 2);
        assert!(temporary.iter().all(|name| !bin.join(name).exists()));
        assert!(kept.iter().all(|name| bin.join(name).exists()));
        assert_eq!(sweep_bin(&bin.join("missing"), later, Duration::ZERO), 0);
    }

    #[test]
    fn a_pair_is_in_bin_only_when_both_programs_are_files_there() {
        let directory = TestDirectory::new();
        let bin = directory.path.join("bin");
        let elsewhere = directory.path.join("elsewhere");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(&elsewhere).unwrap();
        for directory in [&bin, &elsewhere] {
            for program in Program::INSTALL_ORDER {
                write_file(&directory.join(program.file_name()), b"x");
            }
        }
        let ffmpeg = Program::Ffmpeg.file_name();
        let ffprobe = Program::Ffprobe.file_name();
        assert!(pair_is_in(&bin.join(ffmpeg), &bin.join(ffprobe), &bin));
        // A path that only looks different still names a file in `bin`.
        assert!(pair_is_in(
            &bin.join("..").join("bin").join(ffmpeg),
            &bin.join(ffprobe),
            &bin
        ));
        assert!(!pair_is_in(
            &elsewhere.join(ffmpeg),
            &bin.join(ffprobe),
            &bin
        ));
        assert!(!pair_is_in(
            &bin.join(ffmpeg),
            &bin.join(ffprobe),
            &directory.path.join("none")
        ));
    }

    /// A fetch that serves fixed bytes for each URL, in chunks.
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
            let bytes = self.0.get(url).ok_or(DownloadError::HttpStatus(404))?;
            Ok(MemoryBody(bytes.chunks(7).map(<[u8]>::to_vec).collect()))
        }
    }

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

    fn archive_of(url: &str, zip: &[u8], entries: Entries) -> Archive {
        let sha256 = Sha256::digest(zip)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Archive {
            urls: vec![url.to_owned()],
            sha256,
            size: zip.len() as u64,
            entries,
        }
    }

    fn entry(path: &str, bytes: &[u8]) -> Option<Entry> {
        Some(Entry {
            path: path.to_owned(),
            method: Method::Deflate,
            size: bytes.len() as u64,
        })
    }

    /// Two zips, one for each program, served from memory, as on macOS.
    fn two_zips() -> (MemoryFetch, Target) {
        let ffmpeg = b"the ffmpeg program".as_slice();
        let ffprobe = b"the ffprobe program".as_slice();
        let ffmpeg_zip = zip_of(&[("ffmpeg", ffmpeg)]);
        let ffprobe_zip = zip_of(&[("ffprobe", ffprobe)]);
        let target = target(
            "9.0.2",
            vec![
                archive_of(
                    "https://example.test/ffmpeg.zip",
                    &ffmpeg_zip,
                    Entries {
                        ffmpeg: entry("ffmpeg", ffmpeg),
                        ffprobe: None,
                    },
                ),
                archive_of(
                    "https://example.test/ffprobe.zip",
                    &ffprobe_zip,
                    Entries {
                        ffmpeg: None,
                        ffprobe: entry("ffprobe", ffprobe),
                    },
                ),
            ],
        );
        let fetch = MemoryFetch(HashMap::from([
            ("https://example.test/ffmpeg.zip".to_owned(), ffmpeg_zip),
            ("https://example.test/ffprobe.zip".to_owned(), ffprobe_zip),
        ]));
        (fetch, target)
    }

    #[test]
    fn an_install_puts_both_programs_into_bin_and_reports_each_step() {
        let directory = TestDirectory::new();
        let work =
            WorkDirectory::create(&directory.path.join("work"), FFMPEG_INSTALL_WORK_DIRECTORY)
                .unwrap();
        let bin = directory.path.join("bin");
        let (fetch, target) = two_zips();
        let runner = printing(
            "9.0.2-https://www.martin-riedl.de",
            "9.0.2-https://www.martin-riedl.de",
        );
        let cancel = Cancel::new();
        let mut phases = Vec::new();
        run(
            &Install {
                fetch: &fetch,
                target: &target,
                work: &work,
                bin: &bin,
                cancel: &cancel,
                run_version: &runner,
                replace: &replace,
            },
            &mut |phase| phases.push(phase),
        )
        .unwrap();
        assert_eq!(
            fs::read(bin.join(Program::Ffmpeg.file_name())).unwrap(),
            b"the ffmpeg program"
        );
        assert_eq!(
            fs::read(bin.join(Program::Ffprobe.file_name())).unwrap(),
            b"the ffprobe program"
        );
        let total = target.download_size();
        assert_eq!(
            phases.first(),
            Some(&Phase::Download { received: 0, total })
        );
        assert!(phases.contains(&Phase::Download {
            received: total,
            total
        }));
        assert_eq!(
            &phases[phases.len() - 3..],
            [Phase::Extract, Phase::Check, Phase::Install]
        );
        // The zips are gone, and only the work directory itself is left to remove.
        let left: Vec<_> = fs::read_dir(work.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            left.iter()
                .all(|name| !name.to_string_lossy().ends_with(".zip")),
            "{left:?}"
        );
    }

    #[test]
    fn a_failed_version_check_puts_nothing_into_bin() {
        let directory = TestDirectory::new();
        let work =
            WorkDirectory::create(&directory.path.join("work"), FFMPEG_INSTALL_WORK_DIRECTORY)
                .unwrap();
        let bin = directory.path.join("bin");
        let (fetch, target) = two_zips();
        let runner = printing("8.1.3", "8.1.3");
        let failure = run(
            &Install {
                fetch: &fetch,
                target: &target,
                work: &work,
                bin: &bin,
                cancel: &Cancel::new(),
                run_version: &runner,
                replace: &replace,
            },
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(failure.code, InstallErrorCode::VersionCheckFailed);
        assert!(failure.detail.unwrap().contains("not 9.0.2"));
        assert!(!bin.exists());
    }

    #[test]
    fn a_wrong_hash_and_a_cancel_each_stop_the_install() {
        let directory = TestDirectory::new();
        let bin = directory.path.join("bin");
        let runner = printing("9.0.2", "9.0.2");

        let (fetch, mut target) = two_zips();
        target.archives[1].sha256 = "0".repeat(64);
        let work =
            WorkDirectory::create(&directory.path.join("work"), FFMPEG_INSTALL_WORK_DIRECTORY)
                .unwrap();
        let failure = run(
            &Install {
                fetch: &fetch,
                target: &target,
                work: &work,
                bin: &bin,
                cancel: &Cancel::new(),
                run_version: &runner,
                replace: &replace,
            },
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(failure.code, InstallErrorCode::HashMismatch);

        let (fetch, target) = two_zips();
        let cancel = Cancel::new();
        cancel.cancel();
        let failure = run(
            &Install {
                fetch: &fetch,
                target: &target,
                work: &work,
                bin: &bin,
                cancel: &cancel,
                run_version: &runner,
                replace: &replace,
            },
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(
            failure,
            InstallFailure::new(InstallErrorCode::Canceled, None)
        );
        assert!(!bin.exists());
    }

    /// Run an install of [`two_zips`] with `runner`, which also gets `cancel`.
    fn run_with_runner(
        runner: &VersionRunner<'_>,
        cancel: &Cancel,
        bin: &Path,
        directory: &TestDirectory,
    ) -> Result<(), InstallFailure> {
        let work =
            WorkDirectory::create(&directory.path.join("work"), FFMPEG_INSTALL_WORK_DIRECTORY)
                .unwrap();
        let (fetch, target) = two_zips();
        run(
            &Install {
                fetch: &fetch,
                target: &target,
                work: &work,
                bin,
                cancel,
                run_version: runner,
                replace: &replace,
            },
            &mut |_| {},
        )
    }

    #[test]
    fn a_cancel_that_stops_the_version_check_is_a_cancel_and_not_a_failed_check() {
        let directory = TestDirectory::new();
        let bin = directory.path.join("bin");
        let cancel = Cancel::new();
        // The cancel comes while ffmpeg runs, and the stop flag ends it as a time limit would.
        let stopped = |_: &Path, _: Option<&AtomicBool>| {
            cancel.cancel();
            Ok(CommandOutcome {
                status: CommandStatus::TimedOut,
                stderr: Vec::new(),
                stdout: Vec::new(),
            })
        };
        let failure = run_with_runner(&stopped, &cancel, &bin, &directory).unwrap_err();
        assert_eq!(
            failure,
            InstallFailure::new(InstallErrorCode::Canceled, None)
        );
        assert!(!bin.exists());
    }

    #[test]
    fn a_cancel_after_a_passing_check_moves_nothing() {
        let directory = TestDirectory::new();
        let bin = directory.path.join("bin");
        let cancel = Cancel::new();
        // The check passes, and the cancel comes while ffprobe prints its version.
        let late = |path: &Path, stop: Option<&AtomicBool>| {
            if path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ffprobe")
            {
                cancel.cancel();
            }
            printing("9.0.2", "9.0.2")(path, stop)
        };
        let failure = run_with_runner(&late, &cancel, &bin, &directory).unwrap_err();
        assert_eq!(
            failure,
            InstallFailure::new(InstallErrorCode::Canceled, None)
        );
        assert!(!bin.exists());
    }

    #[test]
    fn the_error_codes_have_the_names_of_adr_058() {
        let names = [
            (InstallErrorCode::UnsupportedTarget, "unsupportedTarget"),
            (InstallErrorCode::Busy, "busy"),
            (InstallErrorCode::AlreadyFound, "alreadyFound"),
            (InstallErrorCode::AppDataUnavailable, "appDataUnavailable"),
            (
                InstallErrorCode::WorkDirectoryUnavailable,
                "workDirectoryUnavailable",
            ),
            (InstallErrorCode::NetworkFailed, "networkFailed"),
            (InstallErrorCode::HttpStatus, "httpStatus"),
            (InstallErrorCode::SizeMismatch, "sizeMismatch"),
            (InstallErrorCode::HashMismatch, "hashMismatch"),
            (InstallErrorCode::ArchiveInvalid, "archiveInvalid"),
            (InstallErrorCode::EntryMissing, "entryMissing"),
            (InstallErrorCode::WriteFailed, "writeFailed"),
            (InstallErrorCode::VersionCheckFailed, "versionCheckFailed"),
            (InstallErrorCode::Canceled, "canceled"),
            (
                InstallErrorCode::CommandExecutionFailed,
                "commandExecutionFailed",
            ),
        ];
        for (code, name) in names {
            assert_eq!(serde_json::to_value(code).unwrap(), name);
        }
    }

    /// A real process on Unix that waits: the stop flag ends it long before the time limit.
    #[cfg(unix)]
    #[test]
    fn the_runner_of_the_application_stops_at_a_cancel() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TestDirectory::new();
        let script = directory.path.join("ffmpeg");
        write_file(&script, b"#!/bin/sh\nsleep 30\n");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = Cancel::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        let outcome = run_version(&script, Some(cancel.flag())).unwrap();
        assert_eq!(outcome.status, CommandStatus::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn each_download_and_extraction_error_has_its_code() {
        let code = |error: DownloadError| InstallFailure::from(error).code;
        assert_eq!(
            code(DownloadError::Network(String::new())),
            InstallErrorCode::NetworkFailed
        );
        assert_eq!(
            code(DownloadError::HttpStatus(404)),
            InstallErrorCode::HttpStatus
        );
        assert_eq!(
            code(DownloadError::Size {
                expected: 2,
                actual: 1
            }),
            InstallErrorCode::SizeMismatch
        );
        assert_eq!(
            code(DownloadError::TooLong { expected: 1 }),
            InstallErrorCode::SizeMismatch
        );
        assert_eq!(
            code(DownloadError::Hash {
                actual: String::new()
            }),
            InstallErrorCode::HashMismatch
        );
        assert_eq!(
            code(DownloadError::Write(String::new())),
            InstallErrorCode::WriteFailed
        );
        assert_eq!(code(DownloadError::Canceled), InstallErrorCode::Canceled);
        let code = |error: ExtractError| InstallFailure::from(error).code;
        assert_eq!(
            code(ExtractError::Archive(String::new())),
            InstallErrorCode::ArchiveInvalid
        );
        assert_eq!(
            code(ExtractError::EntryMissing(String::new())),
            InstallErrorCode::EntryMissing
        );
        assert_eq!(
            code(ExtractError::Write(String::new())),
            InstallErrorCode::WriteFailed
        );
        assert_eq!(code(ExtractError::Canceled), InstallErrorCode::Canceled);
    }

    /// A real process on Unix: a shell script that prints a version line.
    #[cfg(unix)]
    #[test]
    fn the_runner_of_the_application_reads_a_real_program() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TestDirectory::new();
        let script = directory.path.join("ffmpeg");
        write_file(
            &script,
            b"#!/bin/sh\necho 'ffmpeg version 9.0.2 Copyright'\necho 'configuration: --enable-gpl --enable-version3'\n",
        );
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let printed = read_version(&run_version, &script, Program::Ffmpeg, None).unwrap();
        assert_eq!(
            printed,
            PrintedVersion {
                version: "9.0.2".to_owned(),
                license: GPL3
            }
        );
    }

    #[test]
    fn the_runner_of_the_application_reports_a_program_that_does_not_exist() {
        let directory = TestDirectory::new();
        let error = read_version(
            &run_version,
            &directory.path.join("missing"),
            Program::Ffmpeg,
            None,
        )
        .unwrap_err();
        assert!(error.starts_with("ffmpeg did not start: "), "{error}");
    }
}
