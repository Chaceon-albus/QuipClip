//! The layout of the cache directory of the application (ADR 057).
//!
//! The cache directory is `app_cache_dir()` of Tauri. It holds the files that the application can
//! make again with no action of the user, each kind in its own subdirectory:
//!
//! - [`crate::ffmpeg::waveform::cache::CACHE_DIR_NAME`]: the audio envelopes (ADR 056).
//! - [`crate::flv::cache::CACHE_DIR_NAME`]: the keyframe table of each FLV source (ADR 046).
//! - [`WORK_DIR_NAME`]: the work directory of each export (ADR 055) and the output of each preset
//!   test (ADR 041), while it runs.
//!
//! Each cache module keeps the name of its own subdirectory. This module declares only the name of
//! the work directory, which belongs to no single module.
//!
//! On Windows, the user data folder of WebView2, `EBWebView`, is in the same directory, and the
//! page keeps its preferences there. So no code deletes the cache directory itself, or a name at
//! its top that this list does not hold.

use std::path::{Path, PathBuf};

/// The subdirectory that holds the files of an export or a preset test while it runs.
pub const WORK_DIR_NAME: &str = "work";

/// The directory in `cache_root` that holds the work directory of each export and the output of
/// each preset test. The export and the preset test create it when they need it.
#[must_use]
pub fn work_directory(cache_root: &Path) -> PathBuf {
    cache_root.join(WORK_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_work_directory_is_a_subdirectory_of_the_cache_directory() {
        let root = Path::new("cache-root");
        assert_eq!(work_directory(root), root.join("work"));
    }
}
