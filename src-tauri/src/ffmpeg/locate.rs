//! Discovery of a user-owned ffmpeg and ffprobe executable pair.

use std::collections::HashSet;
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const FFMPEG_NAME: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_NAME: &str = "ffmpeg";
#[cfg(windows)]
const FFPROBE_NAME: &str = "ffprobe.exe";
#[cfg(not(windows))]
const FFPROBE_NAME: &str = "ffprobe";

/// The location class that supplied a complete executable pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Discover executables using the current process `PATH` and platform search directories.
pub fn discover(
    configured: Option<&Path>,
    app_data_directory: &Path,
) -> Result<FfmpegPaths, LocateError> {
    let path_directories = search_directories(env::var_os("PATH"));
    discover_with_path(configured, &path_directories, app_data_directory)
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

    let mut seen = HashSet::new();
    directories.retain(|directory| seen.insert(directory.clone()));
    directories
}

/// Discover executables using a deterministic list of `PATH` directories.
pub fn discover_with_path(
    configured: Option<&Path>,
    path_directories: &[PathBuf],
    app_data_directory: &Path,
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
        &app_data_directory.join("bin"),
        ExecutableOrigin::AppData,
    ));
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

        let found = discover_with_path(Some(&configured), &[path], &app_data).unwrap();

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

        let found = discover_with_path(None, &[path], &app_data).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::AppData);
    }

    #[test]
    fn accepts_a_configured_executable_file() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let app_data = root.directory("app-data");
        create_pair(&configured);

        let found =
            discover_with_path(Some(&configured.join(FFMPEG_NAME)), &[], &app_data).unwrap();

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

        let found = discover_with_path(Some(&configured), &[], &app_data).unwrap();

        assert_eq!(found.origin, ExecutableOrigin::Configured);
    }

    #[test]
    fn falls_back_to_the_app_data_bin_directory() {
        let root = TestDirectory::new();
        let missing_path = root.directory("path");
        let app_data = root.directory("app-data");
        create_pair(&app_data.join("bin"));

        let found = discover_with_path(None, &[missing_path], &app_data).unwrap();

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
    fn canonicalizes_accepted_paths() {
        let root = TestDirectory::new();
        let configured = root.directory("configured");
        let app_data = root.directory("app-data");
        create_pair(&configured);
        let noncanonical = configured.join("child").join("..");
        fs::create_dir(configured.join("child")).unwrap();

        let found = discover_with_path(Some(&noncanonical), &[], &app_data).unwrap();

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
            discover_with_path(None, &[path], &app_data),
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
