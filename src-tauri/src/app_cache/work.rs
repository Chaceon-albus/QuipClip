//! The work directory of a job, such as an export (ADR 055).
//!
//! Each job creates the directory `<prefix><pid>-<n>` in the directory `work` of the cache
//! directory of the application (ADR 057): `<prefix>` names the kind of the job
//! ([`WorkDirectoryKind`]), `<pid>` is the process ID of QuipClip, and `<n>` a counter of the
//! process. Every kind is declared here, so this file lists each name that a job puts in `work`.
//! A sweep removes only the stale directories of its own kind, but it tries the failed removals
//! of every kind again.
//!
//! An export creates `export-<pid>-<n>`. The `ffmpeg` processes of the export run in it, and
//! their commands name its files by their names alone. It holds the graph files of
//! [`crate::ffmpeg::export::graph_file`] and the head of each FLV source of the export,
//! `h<k>.flv` (ADR 046).
//!
//! An install of `ffmpeg` creates `ffmpeg-install-<pid>-<n>` (ADR 058). It holds the downloaded
//! zips and the extracted programs until they move into `<local_data>/bin`.
//!
//! A write never creates the directory. So a write that an abandoned preparation (ADR 050) makes
//! after the removal fails, and it leaves nothing.
//!
//! The export removes the directory after both processes end, and before the rename of the
//! output. Every other path removes it when the guard drops: a failure, a Stop, a panic, and an
//! abandoned preparation. On Windows, the removal waits at most [`WORK_DIRECTORY_REMOVAL_BUDGET`]
//! in total for a file that another program holds, which fits in the exit budget of ADR 017. A
//! removal that fails writes a log line and keeps the path in a list of the process.
//!
//! At the start of each preparation, the export runs [`remove_stale_work_directories`] for its
//! kind. The sweep tries the paths of that list again, and removes each export work directory
//! that this process does not use and whose modification time is at least
//! [`STALE_WORK_DIRECTORY_AGE`] old.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

/// The longest total wait of one removal of a work directory for a file that another program
/// holds. Windows only: elsewhere, the removal makes one attempt.
pub const WORK_DIRECTORY_REMOVAL_BUDGET: Duration = Duration::from_millis(511);

/// How old a work directory that this process does not use must be before
/// [`remove_stale_work_directories`] removes it. This is far above the time limit of the
/// preparation of an export (ADR 050), and above the time of a download of `ffmpeg` on a slow
/// line, so the sweep does not remove the directory of a job of another QuipClip process that
/// runs now.
pub const STALE_WORK_DIRECTORY_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// One kind of work directory: the prefix of its names, and the word that starts its log lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkDirectoryKind {
    prefix: &'static str,
    log_label: &'static str,
}

/// The work directory of an export, `export-<pid>-<n>` (ADR 055).
pub const EXPORT_WORK_DIRECTORY: WorkDirectoryKind = WorkDirectoryKind {
    prefix: "export-",
    log_label: "export",
};

/// The work directory of an install of `ffmpeg`, `ffmpeg-install-<pid>-<n>` (ADR 058). It holds
/// the downloaded zips and the extracted programs until they move into `<local_data>/bin`.
pub const FFMPEG_INSTALL_WORK_DIRECTORY: WorkDirectoryKind = WorkDirectoryKind {
    prefix: "ffmpeg-install-",
    log_label: "install",
};

/// The most names that [`WorkDirectory::create`] tries.
const CREATE_ATTEMPTS: u32 = 100;

/// `ERROR_DIR_NOT_EMPTY`: a file of the directory is still delete-pending, because another
/// program holds it open.
#[cfg(windows)]
const ERROR_DIR_NOT_EMPTY: i32 = 145;

/// The counter `<n>` of the names of this process.
static NEXT_NUMBER: AtomicU64 = AtomicU64::new(0);

/// The work directories that this process uses now. The sweep never removes one of them.
static LIVE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// The work directories whose removal failed, each with its kind. The next sweep of any kind
/// tries them again.
static PENDING: Mutex<Vec<(PathBuf, WorkDirectoryKind)>> = Mutex::new(Vec::new());

/// The work directory of one job. It removes itself once, at [`Self::remove`] or when it drops.
#[derive(Debug)]
pub struct WorkDirectory {
    path: PathBuf,
    kind: WorkDirectoryKind,
    removed: bool,
}

impl WorkDirectory {
    /// Create a new work directory of `kind` in `parent`, and create `parent` when it is
    /// missing.
    ///
    /// A name that exists, for example from a crash of a process with the same ID, is skipped,
    /// and the next number is tried.
    pub fn create(parent: &Path, kind: WorkDirectoryKind) -> io::Result<Self> {
        Self::create_with(parent, kind, std::process::id(), &NEXT_NUMBER)
    }

    /// [`Self::create`] with the process ID and the counter supplied, so a test can make a name
    /// collide.
    fn create_with(
        parent: &Path,
        kind: WorkDirectoryKind,
        process: u32,
        counter: &AtomicU64,
    ) -> io::Result<Self> {
        fs::create_dir_all(parent)?;
        for _ in 0..CREATE_ATTEMPTS {
            let number = counter.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!("{}{process}-{number}", kind.prefix));
            // Registered under the lock, so a sweep that reads the set sees a directory that
            // exists as live.
            let mut live = LIVE.lock().unwrap_or_else(PoisonError::into_inner);
            match fs::create_dir(&path) {
                Ok(()) => {
                    live.get_or_insert_with(HashSet::new).insert(path.clone());
                    return Ok(Self {
                        path,
                        kind,
                        removed: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create a unique work directory",
        ))
    }

    /// The path of the directory.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The full path of the file `name` in the directory.
    #[must_use]
    pub fn file_path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// Write `bytes` as the file `name` in the directory. The write never creates the directory.
    pub fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        fs::write(self.file_path(name), bytes)
    }

    /// Remove the directory now. A failure is logged, and the next sweep tries again.
    pub fn remove(mut self) {
        self.remove_once();
    }

    fn remove_once(&mut self) {
        if std::mem::replace(&mut self.removed, true) {
            return;
        }
        let result = remove_directory(&self.path);
        if let Some(live) = LIVE.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            live.remove(&self.path);
        }
        if let Err(error) = result {
            eprintln!(
                "{}: the work directory {} was not removed: {error}",
                self.kind.log_label,
                self.path.display()
            );
            PENDING
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((self.path.clone(), self.kind));
        }
    }
}

impl Drop for WorkDirectory {
    fn drop(&mut self) {
        self.remove_once();
    }
}

/// Remove `path` and everything in it. A directory that does not exist counts as removed.
///
/// On Windows, a file that another program holds open stays delete-pending, and the removal of
/// its directory fails until that program closes it. The removal then tries again with the waits
/// of `fsutil::retry_waits`, within [`WORK_DIRECTORY_REMOVAL_BUDGET`] in total.
fn remove_directory(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let started = std::time::Instant::now();
        let mut waits = crate::fsutil::retry_waits(WORK_DIRECTORY_REMOVAL_BUDGET);
        loop {
            match remove_directory_once(path) {
                Err(error) if is_transient_removal_error(&error) => match waits.next() {
                    Some(wait) if started.elapsed() + wait <= WORK_DIRECTORY_REMOVAL_BUDGET => {
                        std::thread::sleep(wait);
                    }
                    _ => return Err(error),
                },
                result => return result,
            }
        }
    }
    #[cfg(not(windows))]
    remove_directory_once(path)
}

/// One attempt to remove `path` and everything in it, with no wait. A directory that does not
/// exist counts as removed.
fn remove_directory_once(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Whether a failed removal can clear when another program closes a file: a sharing error of
/// `fsutil`, or a directory that is not empty yet because a file in it is delete-pending.
#[cfg(windows)]
fn is_transient_removal_error(error: &io::Error) -> bool {
    crate::fsutil::is_transient_sharing_error(error)
        || error.raw_os_error() == Some(ERROR_DIR_NOT_EMPTY)
}

/// Remove the work directories of `kind` that are left in `parent`. Best effort: a failure is
/// logged, and the job goes on.
///
/// First, each path of the list of failed removals, of any kind, is tried again. Then each
/// directory named `<prefix><digits>-<digits>` of `kind`, of any process, is removed when this
/// process does not use it and its modification time is at least [`STALE_WORK_DIRECTORY_AGE`]
/// old.
///
/// The sweep makes one attempt for each path and never waits. A directory that stays held, such
/// as the current directory of an `ffmpeg` that outlived a crash, would otherwise cost the wait of
/// [`WORK_DIRECTORY_REMOVAL_BUDGET`] in each preparation.
pub fn remove_stale_work_directories(parent: &Path, kind: WorkDirectoryKind) {
    let live = LIVE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_default();
    remove_stale_work_directories_with(
        parent,
        kind,
        SystemTime::now(),
        STALE_WORK_DIRECTORY_AGE,
        &live,
        &PENDING,
    );
}

/// [`remove_stale_work_directories`] with the clock, the age, the live set and the list of
/// failed removals supplied, so a test controls each of them. Returns the number of directories
/// it removed.
fn remove_stale_work_directories_with(
    parent: &Path,
    kind: WorkDirectoryKind,
    now: SystemTime,
    min_age: Duration,
    live: &HashSet<PathBuf>,
    pending: &Mutex<Vec<(PathBuf, WorkDirectoryKind)>>,
) -> usize {
    let mut removed = 0;
    let retries = std::mem::take(&mut *pending.lock().unwrap_or_else(PoisonError::into_inner));
    let mut tried: HashSet<PathBuf> = HashSet::with_capacity(retries.len());
    for (path, retry_kind) in retries {
        tried.insert(path.clone());
        match remove_directory_once(&path) {
            Ok(()) => removed += 1,
            Err(error) => {
                eprintln!(
                    "{}: the work directory {} was not removed again: {error}",
                    retry_kind.log_label,
                    path.display()
                );
                pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((path, retry_kind));
            }
        }
    }

    let Ok(entries) = fs::read_dir(parent) else {
        return removed;
    };
    for entry in entries.filter_map(Result::ok) {
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| is_work_directory_name(name, kind))
        {
            continue;
        }
        let path = entry.path();
        if live.contains(&path) || tried.contains(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let old_enough = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= min_age);
        if !metadata.is_dir() || !old_enough {
            continue;
        }
        match remove_directory_once(&path) {
            Ok(()) => removed += 1,
            Err(error) => eprintln!(
                "{}: the stale work directory {} was not removed: {error}",
                kind.log_label,
                path.display()
            ),
        }
    }
    removed
}

/// True for the name of a work directory of `kind`, `<prefix><digits>-<digits>`.
fn is_work_directory_name(name: &str, kind: WorkDirectoryKind) -> bool {
    let Some((process, number)) = name
        .strip_prefix(kind.prefix)
        .and_then(|rest| rest.split_once('-'))
    else {
        return false;
    };
    let is_number = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    is_number(process) && is_number(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::TestDirectory;

    fn is_live(path: &Path) -> bool {
        LIVE.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|live| live.contains(path))
    }

    #[test]
    fn each_directory_gets_a_new_name_of_this_process() {
        let parent = TestDirectory::new();
        let first = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        let second = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        assert_ne!(first.path(), second.path());
        for directory in [&first, &second] {
            assert!(directory.path().is_dir());
            assert_eq!(directory.path().parent(), Some(parent.path.as_path()));
            let name = directory.path().file_name().unwrap().to_str().unwrap();
            assert!(
                is_work_directory_name(name, EXPORT_WORK_DIRECTORY),
                "{name}"
            );
            assert!(name.starts_with(&format!("export-{}-", std::process::id())));
            assert!(is_live(directory.path()));
        }
        let number = |directory: &WorkDirectory| -> u64 {
            let name = directory.path().file_name().unwrap().to_str().unwrap();
            name.rsplit('-').next().unwrap().parse().unwrap()
        };
        assert!(number(&second) > number(&first));
    }

    #[test]
    fn a_missing_parent_is_created() {
        let root = TestDirectory::new();
        let parent = root.path.join("cache").join("deeper");
        let directory = WorkDirectory::create(&parent, EXPORT_WORK_DIRECTORY).unwrap();
        assert!(directory.path().is_dir());
    }

    #[test]
    fn a_name_that_exists_is_skipped() {
        let parent = TestDirectory::new();
        // A counter of its own, so the tests that run beside this one take no number from it.
        let counter = AtomicU64::new(0);
        let process = 4242;
        let taken: Vec<PathBuf> = (0..3)
            .map(|number| parent.path.join(format!("export-{process}-{number}")))
            .collect();
        for path in &taken {
            fs::create_dir(path).unwrap();
            fs::write(path.join("marker"), b"crash").unwrap();
        }
        let directory =
            WorkDirectory::create_with(&parent.path, EXPORT_WORK_DIRECTORY, process, &counter)
                .unwrap();
        assert_eq!(directory.path(), parent.path.join("export-4242-3"));
        for path in &taken {
            assert_eq!(fs::read(path.join("marker")).unwrap(), b"crash");
        }
    }

    #[test]
    fn creation_gives_up_after_its_attempts() {
        let parent = TestDirectory::new();
        let counter = AtomicU64::new(0);
        for number in 0..u64::from(CREATE_ATTEMPTS) {
            fs::create_dir(parent.path.join(format!("export-7-{number}"))).unwrap();
        }
        let error = WorkDirectory::create_with(&parent.path, EXPORT_WORK_DIRECTORY, 7, &counter)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn a_write_lands_in_the_directory_with_the_exact_bytes() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        directory.write("h0.flv", b"FLV\x01head").unwrap();
        let path = directory.file_path("h0.flv");
        assert_eq!(path, directory.path().join("h0.flv"));
        assert_eq!(fs::read(&path).unwrap(), b"FLV\x01head");
    }

    #[test]
    fn a_write_after_the_removal_fails_and_does_not_create_the_directory() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        let path = directory.path().to_path_buf();
        // Stands for an abandoned preparation: the directory is gone when its write comes.
        fs::remove_dir_all(&path).unwrap();
        assert!(directory.write("h0.flv", b"FLV").is_err());
        assert!(!path.exists());
        drop(directory);
        assert!(!path.exists());
    }

    #[test]
    fn a_drop_removes_the_directory_and_its_files() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        directory.write("h0.flv", b"FLV").unwrap();
        let path = directory.path().to_path_buf();
        drop(directory);
        assert!(!path.exists());
        assert!(!is_live(&path));
    }

    #[test]
    fn an_explicit_removal_removes_the_directory_once() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        directory.write("h1.flv", b"FLV").unwrap();
        let path = directory.path().to_path_buf();
        directory.remove();
        assert!(!path.exists());
        assert!(!is_live(&path));
    }

    #[test]
    fn a_directory_that_is_already_gone_counts_as_removed() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        let path = directory.path().to_path_buf();
        fs::remove_dir_all(&path).unwrap();
        directory.remove();
        assert!(!PENDING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .any(|(pending, _)| pending == &path));
    }

    /// A second kind, for the tests that keep each kind to its own names.
    const OTHER: WorkDirectoryKind = WorkDirectoryKind {
        prefix: "other-",
        log_label: "other",
    };

    #[test]
    fn only_the_names_of_work_directories_match() {
        for name in ["export-1-0", "export-4242-17", "export-0-00"] {
            assert!(
                is_work_directory_name(name, EXPORT_WORK_DIRECTORY),
                "{name}"
            );
            assert!(!is_work_directory_name(name, OTHER), "{name}");
            assert!(
                !is_work_directory_name(name, FFMPEG_INSTALL_WORK_DIRECTORY),
                "{name}"
            );
        }
        assert!(is_work_directory_name("other-1-0", OTHER));
        // The two kinds of the application never take each other's names.
        assert!(is_work_directory_name(
            "ffmpeg-install-1-0",
            FFMPEG_INSTALL_WORK_DIRECTORY
        ));
        assert!(!is_work_directory_name(
            "ffmpeg-install-1-0",
            EXPORT_WORK_DIRECTORY
        ));
        for name in [
            "export-",
            "export-1",
            "export-1-",
            "export--1",
            "export-a-1",
            "export-1-2-3",
            "export-1-2.tmp",
            "Export-1-2",
            "flv-cache",
            "flv",
            "waveform",
            "work",
            "EBWebView",
            "preset-test-1-2.tmp",
            "other-1-0",
        ] {
            assert!(
                !is_work_directory_name(name, EXPORT_WORK_DIRECTORY),
                "{name}"
            );
        }
    }

    /// The sweep of the export kind.
    fn sweep(
        parent: &Path,
        now: SystemTime,
        min_age: Duration,
        live: &HashSet<PathBuf>,
        pending: &Mutex<Vec<(PathBuf, WorkDirectoryKind)>>,
    ) -> usize {
        remove_stale_work_directories_with(
            parent,
            EXPORT_WORK_DIRECTORY,
            now,
            min_age,
            live,
            pending,
        )
    }

    #[test]
    fn the_sweep_of_one_kind_keeps_the_directories_of_another_kind() {
        let parent = TestDirectory::new();
        let export = parent.path.join("export-1-0");
        let other = parent.path.join("other-1-0");
        for path in [&export, &other] {
            fs::create_dir(path).unwrap();
        }
        let later = SystemTime::now() + STALE_WORK_DIRECTORY_AGE + Duration::from_secs(60);
        let removed = remove_stale_work_directories_with(
            &parent.path,
            OTHER,
            later,
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::new(),
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 1);
        assert!(!other.exists());
        assert!(export.is_dir());
    }

    #[test]
    fn the_sweep_removes_old_work_directories_of_any_process() {
        let parent = TestDirectory::new();
        let stale = ["export-1-0", "export-99999-12"].map(|name| parent.path.join(name));
        for path in &stale {
            fs::create_dir(path).unwrap();
            fs::write(path.join("encoder.graph"), b"null").unwrap();
        }
        let later = SystemTime::now() + STALE_WORK_DIRECTORY_AGE + Duration::from_secs(60);
        let removed = sweep(
            &parent.path,
            later,
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::new(),
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 2);
        assert!(stale.iter().all(|path| !path.exists()));
    }

    #[test]
    fn the_sweep_keeps_young_directories_and_other_names() {
        let parent = TestDirectory::new();
        let young = parent.path.join("export-1-0");
        fs::create_dir(&young).unwrap();
        let removed = sweep(
            &parent.path,
            SystemTime::now(),
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::new(),
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 0);
        assert!(young.is_dir());

        // The other names at the top of the cache directory (ADR 057), and names that only look
        // like a work directory.
        let others = [
            "EBWebView",
            "flv",
            "waveform",
            "work",
            "export-1",
            "export-a-1",
            "export-1-2.tmp",
            // A work directory of another kind.
            "other-1-0",
        ]
        .map(|name| parent.path.join(name));
        for path in &others {
            fs::create_dir(path).unwrap();
        }
        let file = parent.path.join("export-2-3");
        fs::write(&file, b"not a directory").unwrap();
        let later = SystemTime::now() + STALE_WORK_DIRECTORY_AGE + Duration::from_secs(60);
        let removed = sweep(
            &parent.path,
            later,
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::from([young.clone()]),
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 0);
        assert!(others.iter().all(|path| path.is_dir()));
        assert!(file.is_file());
        assert!(young.is_dir(), "a live directory stays at any age");
    }

    #[test]
    fn the_sweep_never_removes_a_live_directory_of_this_process() {
        let parent = TestDirectory::new();
        let directory = WorkDirectory::create(&parent.path, EXPORT_WORK_DIRECTORY).unwrap();
        directory.write("h0.flv", b"FLV").unwrap();
        let later = SystemTime::now() + STALE_WORK_DIRECTORY_AGE + Duration::from_secs(60);
        let live = LIVE
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .unwrap_or_default();
        let removed = sweep(
            &parent.path,
            later,
            Duration::ZERO,
            &live,
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 0);
        assert!(directory.file_path("h0.flv").is_file());
    }

    #[test]
    fn the_sweep_tries_the_failed_removals_again_first() {
        let parent = TestDirectory::new();
        let other = TestDirectory::new();
        // A failed removal can be in any directory, and its name does not matter.
        let failed = other.path.join("export-7-7");
        fs::create_dir(&failed).unwrap();
        fs::write(failed.join("audio.graph"), b"anull").unwrap();
        let gone = other.path.join("export-7-8");
        // A failed removal of another kind, which the sweep of the export kind also tries.
        let other_kind = other.path.join("other-7-7");
        fs::create_dir(&other_kind).unwrap();
        // A failed removal in the swept directory that is also old: tried once, counted once.
        let both = parent.path.join("export-7-9");
        fs::create_dir(&both).unwrap();
        // The list holds failed removals of any kind, and the sweep of each kind tries them all.
        let pending = Mutex::new(vec![
            (failed.clone(), EXPORT_WORK_DIRECTORY),
            (gone, EXPORT_WORK_DIRECTORY),
            (other_kind.clone(), OTHER),
            (both.clone(), EXPORT_WORK_DIRECTORY),
        ]);
        let later = SystemTime::now() + STALE_WORK_DIRECTORY_AGE + Duration::from_secs(60);
        let removed = sweep(
            &parent.path,
            later,
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::new(),
            &pending,
        );
        assert_eq!(removed, 4);
        assert!(!failed.exists());
        assert!(!other_kind.exists());
        assert!(!both.exists());
        assert!(pending.lock().unwrap().is_empty());
    }

    // A removal that fails needs a directory that the owner cannot change, which Unix gives
    // through its permissions.
    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_again_stays_in_the_list() {
        use std::os::unix::fs::PermissionsExt;
        let parent = TestDirectory::new();
        let locked = parent.path.join("locked");
        let failed = locked.join("export-7-9");
        fs::create_dir_all(&failed).unwrap();
        fs::write(failed.join("h0.flv"), b"FLV").unwrap();
        fs::set_permissions(&failed, fs::Permissions::from_mode(0o500)).unwrap();
        let pending = Mutex::new(vec![(failed.clone(), EXPORT_WORK_DIRECTORY)]);
        let removed = sweep(
            &parent.path,
            SystemTime::now(),
            STALE_WORK_DIRECTORY_AGE,
            &HashSet::new(),
            &pending,
        );
        let still_there = failed.join("h0.flv").exists();
        fs::set_permissions(&failed, fs::Permissions::from_mode(0o700)).unwrap();
        // A process with the right to ignore permissions removes it anyway.
        if still_there {
            assert_eq!(removed, 0);
            assert_eq!(
                *pending.lock().unwrap(),
                vec![(failed, EXPORT_WORK_DIRECTORY)]
            );
        }
    }

    #[test]
    fn a_sweep_of_a_missing_parent_does_nothing() {
        let root = TestDirectory::new();
        let removed = sweep(
            &root.path.join("missing"),
            SystemTime::now(),
            Duration::ZERO,
            &HashSet::new(),
            &Mutex::new(Vec::new()),
        );
        assert_eq!(removed, 0);
    }
}
