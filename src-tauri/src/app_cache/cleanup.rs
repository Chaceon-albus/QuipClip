//! The cleanup of the cache directory after each start of the application (ADR 057).
//!
//! One background thread runs [`run_at_start`] once in each run of the application. It runs these
//! steps in this order:
//!
//! 1. The cleanup of the envelope cache (ADR 056).
//! 2. The sweep of the work directories (ADR 055) and the cleanup of the preset test outputs
//!    (ADR 041), in the directory `work`.
//! 3. The same two, at the top of the cache directory, where the builds before ADR 057 put those
//!    files.
//! 4. The removal of `flv-cache`, the FLV cache of the builds before ADR 057, from the application
//!    data directory.
//!
//! A failure in one step writes a log line and does not stop the next step. Steps 2 and 3 remove
//! only their own names, and only entries that this process does not use and that are old enough
//! that no other QuipClip process of any build still uses them. So the cleanup never touches the
//! other names at the top of the cache directory, such as the folder of WebView2.

use crate::ffmpeg::capabilities::preset_test::remove_stale_outputs;
use crate::ffmpeg::export::work_directory::remove_stale_work_directories;
use crate::ffmpeg::waveform;
use std::fs;
use std::io;
use std::path::Path;

/// The FLV cache of the builds before ADR 057, in the application data directory.
const LEGACY_FLV_CACHE_DIR_NAME: &str = "flv-cache";

/// Run the cleanup once. `app_data` is the application data directory, and `cache_root` the
/// application cache directory. `None` stands for a directory that Tauri gives no path for, and
/// the steps that need it do not run.
pub fn run_at_start(app_data: Option<&Path>, cache_root: Option<&Path>) {
    run_at_start_with(app_data, cache_root, waveform::cache::sweep_once);
}

/// [`run_at_start`] with the cleanup of the envelope cache supplied, so a test does not set the
/// flag of the process that lets that cleanup run only once.
fn run_at_start_with<SweepEnvelopes>(
    app_data: Option<&Path>,
    cache_root: Option<&Path>,
    sweep_envelopes: SweepEnvelopes,
) where
    SweepEnvelopes: FnOnce(&Path) -> io::Result<()>,
{
    if let Some(cache_root) = cache_root {
        if let Err(error) = sweep_envelopes(cache_root) {
            eprintln!("cache: the cleanup of the envelope cache failed: {error}");
        }
        let work = super::work_directory(cache_root);
        remove_stale_work_directories(&work);
        remove_stale_outputs(&work);
        // Each sweep also tries the failed removals of the process again, so a removal that
        // failed in the sweep of `work` fails once more here, with one more log line.
        remove_stale_work_directories(cache_root);
        remove_stale_outputs(cache_root);
    }
    if let Some(app_data) = app_data {
        let legacy = app_data.join(LEGACY_FLV_CACHE_DIR_NAME);
        if let Err(error) = remove_legacy_flv_cache(&legacy) {
            eprintln!(
                "cache: the old FLV cache {} was not removed: {error}",
                legacy.display()
            );
        }
    }
}

/// Remove `path` and everything in it. A directory that does not exist counts as removed.
fn remove_legacy_flv_cache(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_cache::work_directory;
    use crate::flv::test_support::TestDirectory;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime};

    /// The name of a test output of another process.
    fn other_output_name(sequence: u32) -> String {
        format!(
            "preset-test-{}-{sequence}.tmp",
            std::process::id().wrapping_add(1)
        )
    }

    /// Writes `path` with a modification time two minutes back, old enough for the cleanup of
    /// the test outputs.
    fn write_old_file(path: &Path) {
        fs::write(path, b"left by a quit").unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(120))
            .unwrap();
    }

    /// Sets the modification time of the directory `path` 25 hours back, old enough for the sweep
    /// of the work directories.
    fn age_directory(path: &Path) {
        let mut options = fs::File::options();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_WRITE_ATTRIBUTES, and FILE_FLAG_BACKUP_SEMANTICS, which opening a directory
            // needs.
            options.access_mode(0x0100).custom_flags(0x0200_0000);
        }
        #[cfg(not(windows))]
        options.read(true);
        options
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(25 * 60 * 60))
            .unwrap();
    }

    fn no_envelope_sweep(_: &Path) -> io::Result<()> {
        Ok(())
    }

    #[test]
    fn old_work_directories_go_from_work_and_from_the_top_of_the_cache_directory() {
        let cache = TestDirectory::new();
        let in_work = work_directory(&cache.path).join("export-1-0");
        let at_top = cache.path.join("export-1-1");
        for path in [&in_work, &at_top] {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("encoder.graph"), b"null").unwrap();
            age_directory(path);
        }

        run_at_start_with(None, Some(&cache.path), no_envelope_sweep);

        assert!(!in_work.exists());
        assert!(!at_top.exists());
        assert!(work_directory(&cache.path).is_dir());
    }

    #[test]
    fn the_old_flv_cache_goes_with_all_its_content() {
        let app_data = TestDirectory::new();
        let source = app_data
            .path
            .join(LEGACY_FLV_CACHE_DIR_NAME)
            .join("b204be642dd9f970");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("keyframes.json"), b"{}").unwrap();
        fs::write(source.join("head.flv"), b"FLV").unwrap();
        let kept = ["settings.json", "capabilities.json", "preset-tests.json"];
        for name in kept {
            fs::write(app_data.path.join(name), b"{}").unwrap();
        }
        fs::create_dir(app_data.path.join("bin")).unwrap();

        run_at_start_with(Some(&app_data.path), None, no_envelope_sweep);

        assert!(!app_data.path.join(LEGACY_FLV_CACHE_DIR_NAME).exists());
        for name in kept {
            assert!(app_data.path.join(name).is_file(), "{name}");
        }
        assert!(app_data.path.join("bin").is_dir());
    }

    #[test]
    fn old_test_outputs_go_from_work_and_from_the_top_of_the_cache_directory() {
        let cache = TestDirectory::new();
        let work = work_directory(&cache.path);
        fs::create_dir(&work).unwrap();
        let in_work = work.join(other_output_name(0));
        let at_top = cache.path.join(other_output_name(1));
        write_old_file(&in_work);
        write_old_file(&at_top);

        run_at_start_with(None, Some(&cache.path), no_envelope_sweep);

        assert!(!in_work.exists());
        assert!(!at_top.exists());
    }

    #[test]
    fn the_other_names_of_the_cache_directory_stay() {
        let cache = TestDirectory::new();
        let web_view = cache.path.join("EBWebView").join("Default");
        fs::create_dir_all(&web_view).unwrap();
        fs::write(web_view.join("Preferences"), b"{}").unwrap();
        let envelope = cache.path.join("waveform").join("1621bb8bcc014199.qcwf");
        fs::create_dir(cache.path.join("waveform")).unwrap();
        fs::write(&envelope, b"QCWF").unwrap();
        let keyframes = cache.path.join("flv").join("2d4ee298045b6b90");
        fs::create_dir_all(&keyframes).unwrap();
        fs::write(keyframes.join("keyframes.json"), b"{}").unwrap();
        // Old, but not a name of the cleanup.
        let unknown = cache.path.join("notes.tmp");
        write_old_file(&unknown);
        // Names of the cleanup, but too young.
        let young: Vec<PathBuf> = [
            cache.path.join("export-1-0"),
            work_directory(&cache.path).join("export-1-0"),
        ]
        .into();
        for path in &young {
            fs::create_dir_all(path).unwrap();
        }
        let young_output = cache.path.join(other_output_name(2));
        fs::write(&young_output, b"a test of another process").unwrap();

        run_at_start_with(None, Some(&cache.path), no_envelope_sweep);

        assert!(web_view.join("Preferences").is_file());
        assert!(envelope.is_file());
        assert!(keyframes.join("keyframes.json").is_file());
        assert!(unknown.is_file());
        assert!(young.iter().all(|path| path.is_dir()));
        assert!(young_output.is_file());
    }

    #[test]
    fn the_envelope_cleanup_gets_the_cache_directory() {
        let cache = TestDirectory::new();
        let swept = RefCell::new(Vec::new());
        run_at_start_with(None, Some(&cache.path), |root| {
            swept.borrow_mut().push(root.to_path_buf());
            Ok(())
        });
        assert_eq!(*swept.borrow(), vec![cache.path.clone()]);
    }

    #[test]
    fn a_failed_envelope_cleanup_does_not_stop_the_next_steps() {
        let app_data = TestDirectory::new();
        let cache = TestDirectory::new();
        fs::create_dir(app_data.path.join(LEGACY_FLV_CACHE_DIR_NAME)).unwrap();
        let at_top = cache.path.join(other_output_name(3));
        write_old_file(&at_top);

        run_at_start_with(Some(&app_data.path), Some(&cache.path), |_| {
            Err(io::Error::other("the listing failed"))
        });

        assert!(!at_top.exists());
        assert!(!app_data.path.join(LEGACY_FLV_CACHE_DIR_NAME).exists());
    }

    #[test]
    fn missing_directories_and_no_paths_do_nothing() {
        let root = TestDirectory::new();
        let app_data = root.path.join("app-data");
        let cache = root.path.join("cache");
        let swept = RefCell::new(0);
        run_at_start_with(Some(&app_data), Some(&cache), |_| {
            *swept.borrow_mut() += 1;
            Ok(())
        });
        run_at_start_with(None, None, |_| unreachable!("no cache directory"));
        assert_eq!(*swept.borrow(), 1);
        assert!(!app_data.exists());
        assert!(!cache.exists());
    }
}
