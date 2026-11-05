//! Discovery of a user-owned ffmpeg and ffprobe executable pair.
//!
//! The order is the configured path, `PATH` (on macOS, then the Homebrew directories of
//! ADR 012), `<app_data>/bin`, then `<local_data>/bin`, where the download of ADR 058 installs
//! the pair. Both `bin` directories have the origin `appData`.

use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The directory of the programs in a data directory of the application.
const BIN_DIR_NAME: &str = "bin";

/// `app_local_data_dir()` of Tauri (ADR 058). The application sets it once at its start, and it
/// does not change while the process runs. It stays unset when Tauri gives no path, and
/// discovery then skips `<local_data>/bin`.
static LOCAL_DATA_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

#[cfg(windows)]
const FFMPEG_NAME: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_NAME: &str = "ffmpeg";
#[cfg(windows)]
const FFPROBE_NAME: &str = "ffprobe.exe";
#[cfg(not(windows))]
const FFPROBE_NAME: &str = "ffprobe";

/// The location class that supplied a complete executable pair.
///
/// This crosses the IPC boundary as part of the ADR 006 capability-probe wire contract
/// (`CapabilityProbeStart`, the `located` event, and each `InspectedLocation`), so it derives
/// `Serialize` with the same camelCase convention as every other wire enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutableOrigin {
    Configured,
    Path,
    AppData,
}

/// Canonical paths to a matching ffmpeg and ffprobe pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub origin: ExecutableOrigin,
}

/// One candidate pair inspected during discovery.
///
/// This deliberately does NOT derive `Serialize`. `PathBuf` serializes as a plain string
/// only when it is valid UTF-8; a single non-UTF-8 `PATH` entry (an unpaired surrogate from
/// Windows, for example) would make `serde_json` fail the *entire* `inspected` vector, not
/// just that one candidate, turning a clean `ffmpegPairMissing` rejection into an opaque
/// Tauri serialization error. `commands::capabilities::InspectedCandidate` is the wire type
/// instead: it down-converts each path with `to_string_lossy` before it ever reaches serde,
/// so one bad candidate can never take down the others.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedLocation {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub origin: ExecutableOrigin,
}

/// A structured executable discovery failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateError {
    NotFound { inspected: Vec<InspectedLocation> },
}

impl fmt::Display for LocateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { inspected } => {
                write!(
                    formatter,
                    "no complete ffmpeg pair in {} locations",
                    inspected.len()
                )
            }
        }
    }
}

impl Error for LocateError {}

/// Record the local data directory of the application, `app_local_data_dir()` of Tauri. Only the
/// first call counts.
pub fn set_local_data_directory(directory: PathBuf) {
    // A second call keeps the first value, because discovery must search one place for the
    // whole run.
    let _ = LOCAL_DATA_DIRECTORY.set(directory);
}

/// The directory that the download of ADR 058 installs the programs into, `<local_data>/bin`.
///
/// `None` before [`set_local_data_directory`] runs, when Tauri gave no path, and always in tests.
/// The install uses this function and no second call of `app_local_data_dir()`, so discovery and
/// the install always name one directory. Tests must not call [`set_local_data_directory`],
/// because the value cannot be reset.
#[must_use]
pub fn download_directory() -> Option<PathBuf> {
    LOCAL_DATA_DIRECTORY
        .get()
        .map(|directory| directory.join(BIN_DIR_NAME))
}

/// Discover executables using the current process `PATH`, the platform search directories, and
/// the download directory that [`set_local_data_directory`] recorded ([`download_directory`]).
pub fn discover(
    configured: Option<&Path>,
    app_data_directory: &Path,
) -> Result<FfmpegPaths, LocateError> {
    let path_directories = search_directories(env::var_os("PATH"));
    discover_with_path(
        configured,
        &path_directories,
        app_data_directory,
        download_directory().as_deref(),
    )
}

fn search_directories(path: Option<OsString>) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = path
        .as_deref()
        .map(|path| env::split_paths(path).collect())
        .unwrap_or_default();

    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);

    // An empty `PATH` element yields one empty `PathBuf`, on Unix and on Windows. `candidate_in`
    // would join the program name onto nothing, and `accept_candidate` would then canonicalize
    // that relative name against the working directory of the process. A `PATH` that ends in a
    // separator is common, and the working directory is not one of the locations ADR 005 and
    // ADR 012 name.
    directories.retain(|directory| !directory.as_os_str().is_empty());

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

/// Discover executables using a deterministic list of `PATH` directories and a given download
/// directory, `<local_data>/bin`. A download directory that is the same as `<app_data>/bin`, as
/// on macOS, adds no second candidate.
pub fn discover_with_path(
    configured: Option<&Path>,
    path_directories: &[PathBuf],
    app_data_directory: &Path,
    download_directory: Option<&Path>,
) -> Result<FfmpegPaths, LocateError> {
    let mut candidates = Vec::new();
    if let Some(configured) = configured {
        candidates.push(configured_candidate(configured));
    }
    candidates.extend(
        path_directories
            .iter()
            .map(|directory| candidate_in(directory, ExecutableOrigin::Path)),
    );
    candidates.push(candidate_in(
        &app_data_directory.join(BIN_DIR_NAME),
        ExecutableOrigin::AppData,
    ));
    if let Some(download_directory) = download_directory {
        candidates.push(candidate_in(download_directory, ExecutableOrigin::AppData));
    }
    let mut seen = HashSet::new();
    candidates
        .retain(|candidate| seen.insert((candidate.ffmpeg.clone(), candidate.ffprobe.clone())));

    for candidate in &candidates {
        if let Some(paths) = accept_candidate(candidate) {
            return Ok(paths);
        }
    }

    Err(LocateError::NotFound {
        inspected: candidates,
    })
}

fn configured_candidate(path: &Path) -> InspectedLocation {
    if path.is_dir() {
        return candidate_in(path, ExecutableOrigin::Configured);
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if path
        .file_name()
        .is_some_and(|name| executable_name_matches(name, FFPROBE_NAME, cfg!(windows)))
    {
        InspectedLocation {
            ffmpeg: parent.join(FFMPEG_NAME),
            ffprobe: path.to_owned(),
            origin: ExecutableOrigin::Configured,
        }
    } else {
        InspectedLocation {
            ffmpeg: path.to_owned(),
            ffprobe: parent.join(FFPROBE_NAME),
            origin: ExecutableOrigin::Configured,
        }
    }
}

fn candidate_in(directory: &Path, origin: ExecutableOrigin) -> InspectedLocation {
    InspectedLocation {
        ffmpeg: directory.join(FFMPEG_NAME),
        ffprobe: directory.join(FFPROBE_NAME),
        origin,
    }
}

fn accept_candidate(candidate: &InspectedLocation) -> Option<FfmpegPaths> {
    let ffmpeg = candidate.ffmpeg.canonicalize().ok()?;
    let ffprobe = candidate.ffprobe.canonicalize().ok()?;
    if ffmpeg == ffprobe || !is_executable_file(&ffmpeg) || !is_executable_file(&ffprobe) {
        return None;
    }

    Some(FfmpegPaths {
        ffmpeg,
        ffprobe,
        origin: candidate.origin,
    })
}

fn executable_name_matches(actual: &OsStr, expected: &str, ascii_case_insensitive: bool) -> bool {
    actual.to_str().is_some_and(|actual| {
        if ascii_case_insensitive {
            actual.eq_ignore_ascii_case(expected)
        } else {
            actual == expected
        }
    })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn configured_location_precedes_path_and_app_data() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let path = root.directory("path");
        let app_data = root.directory("app-data");
        create_pair(&configured);
        create_pair(&path);
        create_pair(&app_data.join("bin"));

        let found = discover_with_path(Some(&configured), &[path], &app_data, None).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Configured);
        assert_eq!(
            found.ffmpeg,
            configured.join(FFMPEG_NAME).canonicalize().unwrap()
        );
    }

    #[test]
    fn incomplete_pairs_fall_through_in_precedence_order() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let first_path = root.directory("first-path");
        let second_path = root.directory("second-path");
        let app_data = root.directory("app-data");
        create_executable(&configured.join(FFMPEG_NAME));
        create_executable(&first_path.join(FFPROBE_NAME));
        create_pair(&second_path);
        create_pair(&app_data.join("bin"));

        let found = discover_with_path(
            Some(&configured),
            &[first_path, second_path.clone()],
            &app_data,
            None,
        )
        .unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Path);
        assert_eq!(
            found.ffprobe,
            second_path.join(FFPROBE_NAME).canonicalize().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_candidates_must_have_an_executable_permission_bit() {
        let root = TestDirectory::new();
        let path = root.directory("path");
        let app_data = root.directory("app-data");
        create_file(&path.join(FFMPEG_NAME));
        create_executable(&path.join(FFPROBE_NAME));
        create_pair(&app_data.join("bin"));

        let found = discover_with_path(None, &[path], &app_data, None).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::AppData);
    }

    #[test]
    fn accepts_a_configured_executable_file() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let app_data = root.directory("app-data");
        create_pair(&configured);

        let found =
            discover_with_path(Some(&configured.join(FFMPEG_NAME)), &[], &app_data, None).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Configured);
        assert_eq!(
            found.ffprobe,
            configured.join(FFPROBE_NAME).canonicalize().unwrap()
        );
    }

    #[test]
    fn accepts_a_configured_directory() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let app_data = root.directory("app-data");
        create_pair(&configured);

        let found = discover_with_path(Some(&configured), &[], &app_data, None).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Configured);
    }

    #[test]
    fn falls_back_to_the_app_data_bin_directory() {
        let root = TestDirectory::new();
        let missing_path = root.directory("path");
        let app_data = root.directory("app-data");
        create_pair(&app_data.join("bin"));

        let found = discover_with_path(None, &[missing_path], &app_data, None).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::AppData);
        assert_eq!(
            found.ffmpeg,
            app_data
                .join("bin")
                .join(FFMPEG_NAME)
                .canonicalize()
                .unwrap()
        );
    }

    #[test]
    fn falls_back_to_the_download_directory_after_the_app_data_bin_directory() {
        let root = TestDirectory::new();
        let app_data = root.directory("app-data");
        let download = root.directory("local-data").join("bin");
        create_pair(&download);

        let found = discover_with_path(None, &[], &app_data, Some(&download)).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::AppData);
        assert_eq!(
            found.ffmpeg,
            download.join(FFMPEG_NAME).canonicalize().unwrap()
        );
    }

    #[test]
    fn the_app_data_bin_directory_precedes_the_download_directory() {
        let root = TestDirectory::new();
        let app_data = root.directory("app-data");
        let download = root.directory("local-data").join("bin");
        create_pair(&app_data.join("bin"));
        create_pair(&download);

        let found = discover_with_path(None, &[], &app_data, Some(&download)).unwrap();

        assert_eq!(
            found.ffmpeg,
            app_data
                .join("bin")
                .join(FFMPEG_NAME)
                .canonicalize()
                .unwrap()
        );
    }

    #[test]
    fn a_configured_or_path_pair_precedes_the_download_directory() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let path = root.directory("path");
        let app_data = root.directory("app-data");
        let download = root.directory("local-data").join("bin");
        create_pair(&configured);
        create_pair(&path);
        create_pair(&download);

        let found = discover_with_path(
            Some(&configured),
            std::slice::from_ref(&path),
            &app_data,
            Some(&download),
        )
        .unwrap();
        assert_eq!(found.origin, ExecutableOrigin::Configured);

        let found = discover_with_path(None, &[path], &app_data, Some(&download)).unwrap();
        assert_eq!(found.origin, ExecutableOrigin::Path);
    }

    #[test]
    fn a_download_directory_that_is_also_on_path_is_listed_once_as_path() {
        let root = TestDirectory::new();
        let app_data = root.directory("app-data");
        let download = root.directory("local-data").join("bin");

        let Err(LocateError::NotFound { inspected }) = discover_with_path(
            None,
            std::slice::from_ref(&download),
            &app_data,
            Some(&download),
        ) else {
            panic!("no pair exists");
        };
        assert_eq!(
            inspected,
            [
                candidate_in(&download, ExecutableOrigin::Path),
                candidate_in(&app_data.join("bin"), ExecutableOrigin::AppData),
            ]
        );
    }

    #[test]
    fn the_download_directory_is_inspected_last_and_only_once() {
        let root = TestDirectory::new();
        let path = root.directory("path");
        let app_data = root.directory("app-data");
        let download = root.directory("local-data").join("bin");

        let Err(LocateError::NotFound { inspected }) =
            discover_with_path(None, &[path], &app_data, Some(&download))
        else {
            panic!("no pair exists");
        };
        assert_eq!(inspected.len(), 3);
        assert_eq!(
            inspected[2],
            candidate_in(&download, ExecutableOrigin::AppData)
        );

        // On macOS, `<local_data>` is `<app_data>`, so both name one `bin` directory.
        let same = app_data.join("bin");
        let Err(LocateError::NotFound { inspected }) =
            discover_with_path(None, &[], &app_data, Some(&same))
        else {
            panic!("no pair exists");
        };
        assert_eq!(inspected, [candidate_in(&same, ExecutableOrigin::AppData)]);
    }

    #[test]
    fn canonicalizes_accepted_paths() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let app_data = root.directory("app-data");
        create_pair(&configured);
        let noncanonical = configured.join("child").join("..");
        fs::create_dir(configured.join("child")).unwrap();

        let found = discover_with_path(Some(&noncanonical), &[], &app_data, None).unwrap();

        assert_eq!(
            found.ffmpeg,
            configured.join(FFMPEG_NAME).canonicalize().unwrap()
        );
        assert_eq!(
            found.ffprobe,
            configured.join(FFPROBE_NAME).canonicalize().unwrap()
        );
    }

    #[test]
    fn not_found_reports_every_inspected_location() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let first_path = root.directory("first-path");
        let second_path = root.directory("second-path");
        let app_data = root.directory("app-data");

        let error = discover_with_path(
            Some(&configured),
            &[first_path.clone(), second_path.clone()],
            &app_data,
            None,
        )
        .unwrap_err();

        let LocateError::NotFound { inspected } = error;
        assert_eq!(inspected.len(), 4);
        assert_eq!(inspected[0].origin, ExecutableOrigin::Configured);
        assert_eq!(
            inspected[1],
            candidate_in(&first_path, ExecutableOrigin::Path)
        );
        assert_eq!(
            inspected[2],
            candidate_in(&second_path, ExecutableOrigin::Path)
        );
        assert_eq!(
            inspected[3],
            candidate_in(&app_data.join("bin"), ExecutableOrigin::AppData)
        );
    }

    #[test]
    fn executable_name_classification_can_use_windows_ascii_case_rules() {
        assert!(executable_name_matches(
            OsStr::new("FFPROBE.EXE"),
            "ffprobe.exe",
            true
        ));
        assert!(!executable_name_matches(
            OsStr::new("FFPROBE.EXE"),
            "ffprobe.exe",
            false
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_configured_ffprobe_name_is_ascii_case_insensitive() {
        let configured = Path::new(r"C:\tools\FFPROBE.EXE");

        let candidate = configured_candidate(configured);

        assert_eq!(candidate.ffmpeg, Path::new(r"C:\tools").join(FFMPEG_NAME));
        assert_eq!(candidate.ffprobe, configured);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_pair_that_canonicalizes_to_one_executable() {
        use std::os::unix::fs::symlink;

        let root = TestDirectory::new();
        let path = root.directory("path");
        let app_data = root.directory("app-data");
        let ffmpeg = path.join(FFMPEG_NAME);
        create_executable(&ffmpeg);
        symlink(&ffmpeg, path.join(FFPROBE_NAME)).unwrap();

        assert!(matches!(
            discover_with_path(None, &[path], &app_data, None),
            Err(LocateError::NotFound { .. })
        ));
    }

    #[test]
    fn not_found_stably_deduplicates_candidate_pairs() {
        let root = TestDirectory::new();
        let app_data = root.directory("app-data");
        let repeated = app_data.join("bin");
        fs::create_dir(&repeated).unwrap();

        let error = discover_with_path(
            Some(&repeated),
            &[repeated.clone(), repeated.clone()],
            &app_data,
            None,
        )
        .unwrap_err();

        let LocateError::NotFound { inspected } = error;
        assert_eq!(inspected.len(), 1);
        assert_eq!(inspected[0].origin, ExecutableOrigin::Configured);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_search_directories_follow_path_and_are_stably_deduplicated() {
        let inherited = env::join_paths([
            Path::new("/custom/bin"),
            Path::new("/opt/homebrew/bin"),
            Path::new("/custom/bin"),
        ])
        .unwrap();

        let directories = search_directories(Some(inherited));

        assert_eq!(
            directories,
            [
                PathBuf::from("/custom/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ]
        );
    }

    #[test]
    fn an_empty_path_element_never_becomes_a_search_directory() {
        // A `PATH` that ends in a separator is common. `env::split_paths` yields one empty
        // `PathBuf` for that element, and an empty directory would make discovery run an `ffmpeg`
        // that sits in the working directory of the process, which no ADR names.
        let inherited =
            env::join_paths([Path::new("/custom/bin"), Path::new(""), Path::new("")]).unwrap();
        assert!(
            env::split_paths(&inherited).any(|directory| directory.as_os_str().is_empty()),
            "this test is only meaningful while split_paths still yields the empty element"
        );

        let directories = search_directories(Some(inherited));

        assert!(
            !directories
                .iter()
                .any(|directory| directory.as_os_str().is_empty()),
            "no search directory may be empty, got {directories:?}"
        );
        assert_eq!(
            directories.first(),
            Some(&PathBuf::from("/custom/bin")),
            "the non-empty elements keep their order"
        );
    }

    fn create_pair(directory: &Path) {
        fs::create_dir_all(directory).unwrap();
        create_executable(&directory.join(FFMPEG_NAME));
        create_executable(&directory.join(FFPROBE_NAME));
    }

    fn create_executable(path: &Path) {
        create_file(path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn create_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        File::create(path).unwrap();
    }

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = env::temp_dir().join(format!(
                    "quipclip-ffmpeg-locate-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("could not create test directory: {error}"),
                }
            }
            panic!("could not create a unique test directory")
        }

        fn directory(&self, name: &str) -> PathBuf {
            let path = self.path.join(name);
            fs::create_dir(&path).unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
