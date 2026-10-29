//! The file that the FLV reader keeps for a source: the keyframe sidecar.
//!
//! Each source revision (path, size and modification time) has one directory under
//! `<app_data>/flv-cache/`. The export writes the head of a source into its own work directory
//! (ADR 055), not here. A directory of an older build can still hold a `head.flv`, which the
//! eviction removes with the directory. The sidecar lets a second session of the same file start
//! with the keyframes and configurations that the first session found. A sidecar of another
//! revision is ignored, so a file changed in place starts again from nothing. The cache keeps
//! [`KEEP_SOURCES`] directories and removes the oldest, but never one that a caller names as in
//! use.

use super::table::{ConfigTag, KeyframeEntry, KeyframeTable};
use super::tag::{classify, parse_tag_header, TagKind, TagRole, ROLE_PREFIX_LEN};
use crate::fsutil::write_bytes_atomically;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The directory under the application data directory.
pub const CACHE_DIR_NAME: &str = "flv-cache";
/// The number of source directories that the cache keeps.
pub const KEEP_SOURCES: usize = 16;
const SIDECAR_FILE_NAME: &str = "keyframes.json";
const SIDECAR_VERSION: u32 = 1;

/// One lock for every write and every eviction, so two windows and an export never interleave
/// their writes into one directory.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

/// One save of a table at a time, from its copy to its write, so a copy that a window or an
/// export took earlier never lands after a newer one.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// The revision of a source, as the frontend and `read_source_revision` give it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
}

impl Revision {
    /// The name of the directory of this revision: an FNV-1a hash of its fields. The hash is
    /// stable across builds, unlike the hasher of the standard library, and the sidecar stores
    /// the full revision, so a collision is detected.
    pub fn key(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        feed(self.path.as_bytes());
        feed(&[0]);
        feed(&self.size.to_le_bytes());
        feed(&self.mtime.to_le_bytes());
        format!("{hash:016x}")
    }
}

/// The cache directory of one source revision.
pub struct SourceCache {
    dir: PathBuf,
    revision: Revision,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    version: u32,
    revision: Revision,
    /// Each keyframe as [offset, dts, pts, run, 1 when the run reaches the end].
    keyframes: Vec<[i64; 5]>,
    configs: Vec<SavedConfig>,
    /// True when a session found timestamps that decrease (ADR 046).
    #[serde(default)]
    non_monotonic: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfig {
    offset: u64,
    kind: String,
    hex: String,
}

impl SourceCache {
    pub fn new(app_data: &Path, revision: Revision) -> Self {
        let dir = app_data.join(CACHE_DIR_NAME).join(revision.key());
        Self { dir, revision }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn key(&self) -> String {
        self.revision.key()
    }

    /// The table and the decrease flag that the sidecar holds, or `None` when it is missing,
    /// damaged or of another revision.
    pub fn load_table(&self) -> Option<(KeyframeTable, bool)> {
        let bytes = fs::read(self.dir.join(SIDECAR_FILE_NAME)).ok()?;
        let sidecar: Sidecar = serde_json::from_slice(&bytes).ok()?;
        if sidecar.version != SIDECAR_VERSION || sidecar.revision != self.revision {
            return None;
        }
        let keyframes = sidecar
            .keyframes
            .iter()
            .map(|[offset, dts, pts, run, to_end]| {
                Some((
                    KeyframeEntry {
                        offset: u64::try_from(*offset).ok()?,
                        dts: *dts,
                        pts: *pts,
                    },
                    u64::try_from(*run).ok()?,
                    *to_end == 1,
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        let configs = sidecar
            .configs
            .iter()
            .map(|saved| {
                let kind = match saved.kind.as_str() {
                    "video" => TagKind::Video,
                    "audio" => TagKind::Audio,
                    _ => return None,
                };
                let bytes = from_hex(&saved.hex)?;
                // The bytes go into a head as they are, so they must be one whole configuration
                // tag of their kind.
                valid_config(&bytes, kind).then_some(ConfigTag {
                    offset: saved.offset,
                    kind,
                    bytes,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some((
            KeyframeTable::from_saved(keyframes, configs),
            sidecar.non_monotonic,
        ))
    }

    /// Write the sidecar from what `source` learned since its last save, when it learned
    /// anything. The windows of the preview and the export both save this way.
    pub fn save_changed(&self, source: &super::FlvSource) -> io::Result<()> {
        let _guard = SAVE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        match source.take_changed() {
            Some((table, non_monotonic)) => self.save_table(&table, non_monotonic),
            None => Ok(()),
        }
    }

    /// Write the sidecar for `table` and the decrease flag.
    pub fn save_table(&self, table: &KeyframeTable, non_monotonic: bool) -> io::Result<()> {
        let sidecar = Sidecar {
            version: SIDECAR_VERSION,
            revision: self.revision.clone(),
            keyframes: table
                .entries()
                .map(|(k, run, to_end)| {
                    [
                        k.offset as i64,
                        k.dts,
                        k.pts,
                        i64::try_from(run).unwrap_or(i64::MAX),
                        i64::from(to_end),
                    ]
                })
                .collect(),
            configs: table
                .configs()
                .filter_map(|c| {
                    let kind = match c.kind {
                        TagKind::Video => "video",
                        TagKind::Audio => "audio",
                        TagKind::Script => return None,
                    };
                    Some(SavedConfig {
                        offset: c.offset,
                        kind: kind.to_owned(),
                        hex: to_hex(&c.bytes),
                    })
                })
                .collect(),
            non_monotonic,
        };
        let bytes = serde_json::to_vec(&sidecar).map_err(io::Error::other)?;
        let _guard = CACHE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        fs::create_dir_all(&self.dir)?;
        write_bytes_atomically(&self.dir.join(SIDECAR_FILE_NAME), &bytes)
    }
}

/// Remove the oldest source directories beyond `keep`, by their latest write, and never a
/// directory whose key is in `in_use`.
pub fn evict(app_data: &Path, keep: usize, in_use: &[String]) -> io::Result<()> {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let root = app_data.join(CACHE_DIR_NAME);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let latest = fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|file| file.metadata().ok()?.modified().ok())
            .chain(entry.metadata().ok().and_then(|m| m.modified().ok()))
            .max();
        dirs.push((latest, path));
    }
    dirs.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in dirs.into_iter().skip(keep) {
        let key = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if in_use.iter().any(|used| used == key) {
            continue;
        }
        let _ = fs::remove_dir_all(&path);
    }
    Ok(())
}

/// True when `bytes` are one whole configuration tag of `kind`.
fn valid_config(bytes: &[u8], kind: TagKind) -> bool {
    let Some(header) = parse_tag_header(bytes) else {
        return false;
    };
    let total = header.total_len() as usize;
    if header.kind != kind || bytes.len() != total {
        return false;
    }
    let trailing = u32::from_be_bytes([
        bytes[total - 4],
        bytes[total - 3],
        bytes[total - 2],
        bytes[total - 1],
    ]);
    let data = &bytes[11..total - 4];
    trailing == header.previous_tag_size()
        && classify(kind, &data[..data.len().min(ROLE_PREFIX_LEN)]) == TagRole::Config
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::TestDirectory;

    fn revision(path: &str) -> Revision {
        Revision {
            path: path.to_owned(),
            size: 1000,
            mtime: 1_700_000_000,
        }
    }

    fn sample_table() -> KeyframeTable {
        let mut table = KeyframeTable::new();
        let key = |offset, pts| KeyframeEntry {
            offset,
            dts: pts - 67,
            pts,
        };
        table.record_run(&[key(400, 67), key(9000, 2067)], false);
        table.record_run(&[key(50_000, 9067), key(60_000, 11_067)], true);
        let mut bytes = vec![9, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0x17, 0, 0, 0, 0];
        bytes.extend_from_slice(&16u32.to_be_bytes());
        table.record_config(ConfigTag {
            offset: 13,
            kind: TagKind::Video,
            bytes,
        });
        table
    }

    #[test]
    fn the_key_depends_on_each_field_of_the_revision() {
        let base = revision("/a.flv");
        assert_eq!(base.key(), revision("/a.flv").key());
        assert_ne!(base.key(), revision("/b.flv").key());
        assert_ne!(
            base.key(),
            Revision {
                size: 1001,
                ..base.clone()
            }
            .key()
        );
        assert_ne!(
            base.key(),
            Revision {
                mtime: 1,
                ..base.clone()
            }
            .key()
        );
        assert_eq!(base.key().len(), 16);
    }

    #[test]
    fn a_saved_table_loads_for_its_revision_only() {
        let dir = TestDirectory::new();
        let cache = SourceCache::new(&dir.path, revision("/a.flv"));
        let table = sample_table();
        cache.save_table(&table, true).unwrap();
        let (loaded, non_monotonic) = cache.load_table().unwrap();
        assert!(non_monotonic);
        for target in [67, 1000, 9067, 20_000] {
            assert_eq!(loaded.lookup(target), table.lookup(target));
        }
        assert_eq!(loaded.configs().count(), 1);

        // The same directory read for another revision, as after a hash collision.
        let other = SourceCache {
            dir: cache.dir().to_path_buf(),
            revision: revision("/b.flv"),
        };
        assert!(other.load_table().is_none());
    }

    #[test]
    fn a_sidecar_configuration_that_is_not_a_whole_tag_of_its_kind_loads_nothing() {
        let dir = TestDirectory::new();
        let cache = SourceCache::new(&dir.path, revision("/a.flv"));
        let table = sample_table();
        cache.save_table(&table, false).unwrap();
        let path = cache.dir().join(SIDECAR_FILE_NAME);
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.replace("\"video\"", "\"audio\"")).unwrap();
        assert!(cache.load_table().is_none());
    }

    #[test]
    fn a_damaged_sidecar_loads_nothing() {
        let dir = TestDirectory::new();
        let cache = SourceCache::new(&dir.path, revision("/a.flv"));
        fs::create_dir_all(cache.dir()).unwrap();
        fs::write(cache.dir().join(SIDECAR_FILE_NAME), b"{not json").unwrap();
        assert!(cache.load_table().is_none());
    }

    #[test]
    fn eviction_keeps_the_newest_directories_and_those_in_use() {
        let dir = TestDirectory::new();
        let mut keys = Vec::new();
        for index in 0..5 {
            let cache = SourceCache::new(&dir.path, revision(&format!("/{index}.flv")));
            fs::create_dir_all(cache.dir()).unwrap();
            fs::write(cache.dir().join(SIDECAR_FILE_NAME), b"{}").unwrap();
            keys.push(cache.key());
            // Directory times have a coarse resolution on some file systems.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        evict(&dir.path, 2, std::slice::from_ref(&keys[0])).unwrap();
        let left: Vec<String> = fs::read_dir(dir.path.join(CACHE_DIR_NAME))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(left.contains(&keys[0]), "a directory in use stays");
        assert!(left.contains(&keys[3]) && left.contains(&keys[4]));
        assert!(!left.contains(&keys[1]) && !left.contains(&keys[2]));
    }

    #[test]
    fn hex_round_trips_and_refuses_bad_text() {
        assert_eq!(
            from_hex(&to_hex(&[0, 1, 0xAB, 0xFF])),
            Some(vec![0, 1, 0xAB, 0xFF])
        );
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
