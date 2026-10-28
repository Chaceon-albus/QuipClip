//! A reader for FLV files that finds keyframes without reading the file from its start.
//!
//! FFmpeg cannot seek in an FLV that has no keyframe index, and live recordings have none, so a
//! seek with `-ss` reads the file from its start (ADR 046 measurement 1). This module finds the
//! keyframe at or before a time with a few reads, writes the head that a remux window needs, and
//! remembers what it learned about each source. The preview window command and the export use it.
//!
//! - `tag`: the byte layout of the header and of a tag.
//! - `reader`: block reads with a cache, a byte count and a cancel flag.
//! - `scan`: tag boundaries, resync, backward walks, and a stream reader.
//! - `head`: the head of the file and of a window.
//! - `locate`: the keyframe at or before a time, and the extent of the file.
//! - `table`: the keyframes and configurations that walks found.
//! - `cache`: the keyframe sidecar under the application data directory.

pub mod amf;
pub mod cache;
pub mod head;
pub mod locate;
pub mod reader;
pub mod scan;
pub mod table;
pub mod tag;

#[cfg(test)]
pub(crate) mod test_support;

use head::FlvHead;
use locate::{Extent, LocateState, Located};
use reader::{is_canceled, ByteSource, FileSource};
use scan::walk_configs;
use std::fmt;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use table::{ConfigTag, KeyframeEntry, KeyframeTable};
use tag::TagKind;

/// How far [`FlvSource::next_keyframe_from`] walks: more than one GOP of a recording at a high
/// bit rate.
pub const NEXT_KEYFRAME_REACH: u64 = 64 * 1024 * 1024;

/// The tags after its keyframe that [`FlvSource::window_head`] reads at most.
pub const WINDOW_HEAD_TAGS: usize = 64;

/// Why the reader could not do what it was asked.
#[derive(Debug)]
pub enum FlvError {
    Io(io::Error),
    /// The cancel flag of the read was set.
    Canceled,
    /// The file does not start with an FLV header.
    NotFlv,
    /// The start of the file holds no audio or video frame.
    NoMediaTags,
    /// The file holds no video keyframe at or before the target.
    NoKeyframe,
}

impl fmt::Display for FlvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FlvError::Io(error) => write!(f, "the FLV file could not be read: {error}"),
            FlvError::Canceled => f.write_str("the FLV read was canceled"),
            FlvError::NotFlv => f.write_str("the file is not an FLV file"),
            FlvError::NoMediaTags => f.write_str("the FLV file holds no audio or video frame"),
            FlvError::NoKeyframe => f.write_str("the FLV file holds no video keyframe"),
        }
    }
}

impl std::error::Error for FlvError {}

impl From<io::Error> for FlvError {
    fn from(error: io::Error) -> Self {
        if is_canceled(&error) {
            FlvError::Canceled
        } else {
            FlvError::Io(error)
        }
    }
}

/// True when the file at `path` starts with the FLV signature.
pub fn has_signature(path: &Path) -> io::Result<bool> {
    let mut bytes = [0u8; 3];
    let mut file = File::open(path)?;
    match file.read_exact(&mut bytes) {
        Ok(()) => Ok(&bytes == tag::SIGNATURE),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error),
    }
}

/// What the reader learned about one source while the application runs.
struct Knowledge {
    table: KeyframeTable,
    state: LocateState,
    /// True when `state.non_monotonic` changed since the sidecar was last taken.
    state_changed: bool,
    /// The byte ranges `[start, end)` whose tags a window or a scan read one after another, with
    /// every configuration among them in the table. Sorted and disjoint. Both ends of a range lie
    /// on tag boundaries. The sidecar does not keep them.
    walked: Vec<(u64, u64)>,
}

/// Add `[start, end)` to the sorted, disjoint `ranges`, and join the ranges that overlap or touch.
fn add_range(ranges: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if start >= end {
        return;
    }
    ranges.push((start, end));
    ranges.sort_unstable();
    let mut joined: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for &(range_start, range_end) in ranges.iter() {
        match joined.last_mut() {
            Some(last) if range_start <= last.1 => last.1 = last.1.max(range_end),
            _ => joined.push((range_start, range_end)),
        }
    }
    *ranges = joined;
}

/// The parts of `[from, until)` that no range of the sorted, disjoint `ranges` covers.
fn uncovered(ranges: &[(u64, u64)], from: u64, until: u64) -> Vec<(u64, u64)> {
    let mut gaps = Vec::new();
    let mut position = from;
    for &(start, end) in ranges {
        if position >= until || start >= until {
            break;
        }
        if end <= position {
            continue;
        }
        if start > position {
            gaps.push((position, start));
        }
        position = end;
    }
    if position < until {
        gaps.push((position, until));
    }
    gaps
}

/// An FLV source: its head, and the keyframes and configurations found so far.
///
/// The preview and the export share one value per source revision. Each read opens its own
/// [`FileSource`], so the two lanes of a preview can read at the same time; the table is shared
/// under a lock.
pub struct FlvSource {
    path: PathBuf,
    head: FlvHead,
    knowledge: Mutex<Knowledge>,
}

impl FlvSource {
    /// Read the head of the file at `path`.
    pub fn open(path: &Path, cancel: Option<Arc<AtomicBool>>) -> Result<Self, FlvError> {
        let mut source = FileSource::open(path, cancel)?;
        let head = FlvHead::read(&mut source)?;
        let mut table = KeyframeTable::new();
        for config in &head.configs {
            table.record_config(config.clone());
        }
        table.take_changed();
        // The walk of the head read every tag in front of the first frame.
        let mut walked = Vec::new();
        add_range(
            &mut walked,
            head.first_tag_offset(),
            head.first_frame_offset,
        );
        Ok(Self {
            path: path.to_path_buf(),
            head,
            knowledge: Mutex::new(Knowledge {
                table,
                state: LocateState::default(),
                state_changed: false,
                walked,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn head(&self) -> &FlvHead {
        &self.head
    }

    fn knowledge(&self) -> MutexGuard<'_, Knowledge> {
        self.knowledge
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Add what a saved sidecar holds: its table, and whether an earlier session found
    /// timestamps that decrease.
    pub fn restore(&self, saved: &KeyframeTable, non_monotonic: bool) {
        let mut knowledge = self.knowledge();
        knowledge.table.merge(saved);
        knowledge.table.take_changed();
        if non_monotonic {
            knowledge.state.non_monotonic = true;
            knowledge.state.sampled = true;
        }
    }

    /// Find the keyframe whose presentation time is the latest at or before `target_pts`
    /// (milliseconds). The reads stop at the next block when `cancel` is set.
    pub fn locate(
        &self,
        target_pts: i64,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<(Located, u64), FlvError> {
        // The table answers under the lock. Every read runs without it, against a scratch table
        // that is merged afterward, so a window that records what it streams never waits for a
        // slow locate, and two locates do not wait for each other.
        let mut state = {
            let knowledge = self.knowledge();
            if !knowledge.state.non_monotonic {
                if let Some(keyframe) = knowledge.table.lookup(target_pts) {
                    let located = Located {
                        keyframe,
                        method: locate::LocateMethod::Table,
                        non_monotonic: false,
                    };
                    return Ok((located, 0));
                }
            }
            knowledge.state
        };
        let mut source = FileSource::open(&self.path, cancel)?;
        let mut scratch = KeyframeTable::new();
        let result = locate::locate_keyframe(
            &mut source,
            &self.head,
            &mut scratch,
            target_pts,
            &mut state,
        );
        // What a canceled or failed locate learned still holds: its runs come only from complete
        // walks, and its state from complete steps.
        let mut knowledge = self.knowledge();
        knowledge.table.merge(&scratch);
        let shared = &mut knowledge.state;
        shared.index_valid &= state.index_valid;
        shared.sampled |= state.sampled;
        shared.no_keyframe |= state.no_keyframe;
        shared.first_keyframe = shared.first_keyframe.or(state.first_keyframe);
        if state.non_monotonic && !shared.non_monotonic {
            shared.non_monotonic = true;
            knowledge.state_changed = true;
        }
        let non_monotonic = knowledge.state.non_monotonic;
        let mut located = result?;
        located.non_monotonic = non_monotonic;
        Ok((located, source.bytes_read()))
    }

    /// True when a keyframe video tag starts at `offset`. A resume offset from the frontend
    /// passes this test before a window starts there.
    pub fn is_keyframe_at(&self, offset: u64) -> Result<bool, FlvError> {
        if offset < self.head.first_tag_offset() {
            return Ok(false);
        }
        let mut source = FileSource::open(&self.path, None)?;
        let Some(tag) = scan::read_tag(&mut source, offset)? else {
            return Ok(false);
        };
        Ok(tag.header.kind == TagKind::Video
            && tag.is_keyframe()
            && scan::chain_holds(&mut source, offset, scan::RESYNC_CHAIN)?)
    }

    /// The tag at `offset`, when a valid tag starts there.
    pub fn tag_at(&self, offset: u64) -> Result<Option<scan::Tag>, FlvError> {
        let mut source = FileSource::open(&self.path, None)?;
        Ok(scan::read_tag(&mut source, offset)?)
    }

    /// The first video keyframe at or after `offset`, which need not be a tag boundary: a
    /// resync finds the next boundary first. The walk stops after [`NEXT_KEYFRAME_REACH`] bytes.
    /// A window that stopped at a restart of the timestamps or at a damaged tag resumes there.
    pub fn next_keyframe_from(
        &self,
        offset: u64,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Option<KeyframeEntry>, FlvError> {
        let mut source = FileSource::open(&self.path, cancel)?;
        let len = source.len();
        let start = match scan::read_tag(&mut source, offset)? {
            Some(tag) => Some(tag),
            None => scan::resync(
                &mut source,
                offset,
                offset.saturating_add(scan::RESYNC_REACH),
            )?,
        };
        let Some(mut tag) = start else {
            return Ok(None);
        };
        let limit = tag.offset.saturating_add(NEXT_KEYFRAME_REACH).min(len);
        loop {
            if tag.header.kind == TagKind::Video && tag.is_keyframe() {
                return Ok(Some(KeyframeEntry {
                    offset: tag.offset,
                    dts: tag.dts(),
                    pts: tag.pts(),
                }));
            }
            if tag.end() >= limit {
                return Ok(None);
            }
            match scan::read_tag(&mut source, tag.end())? {
                Some(next) => tag = next,
                None => return Ok(None),
            }
        }
    }

    /// The first and last video presentation times.
    pub fn extent(&self) -> Result<Extent, FlvError> {
        let mut source = FileSource::open(&self.path, None)?;
        locate::extent(&mut source, &self.head)
    }

    /// The configurations in force at `offset`: the latest known configuration of each kind.
    pub fn configs_at(&self, offset: u64) -> Vec<ConfigTag> {
        let knowledge = self.knowledge();
        knowledge
            .table
            .configs_at(offset)
            .into_values()
            .cloned()
            .collect()
    }

    /// The head of a window that starts at the keyframe at `offset`: the configurations in force
    /// there, and each configuration that follows the keyframe before the first frame of its
    /// kind. A reconnect can write the new configuration of the audio after the keyframe of the
    /// video, and the mp4 muxer takes the configuration of each stream from the head. The walk
    /// records what it finds, and it stops when a frame of each kind of the head came, or after
    /// [`WINDOW_HEAD_TAGS`] tags.
    pub fn window_head(
        &self,
        offset: u64,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Vec<u8>, FlvError> {
        let mut configs: std::collections::BTreeMap<TagKind, ConfigTag> = self
            .configs_at(offset)
            .into_iter()
            .map(|config| (config.kind, config))
            .collect();
        let mut source = FileSource::open(&self.path, cancel)?;
        let mut framed: Vec<TagKind> = Vec::new();
        let mut position = offset;
        for _ in 0..WINDOW_HEAD_TAGS {
            if configs.keys().all(|kind| framed.contains(kind)) {
                break;
            }
            let Some(tag) = scan::read_tag(&mut source, position)? else {
                break;
            };
            let kind = tag.header.kind;
            if tag.role == tag::TagRole::Config && !framed.contains(&kind) {
                let config = scan::read_config(&mut source, &tag)?;
                self.record_config(config.clone());
                configs.insert(kind, config);
            } else if tag.role.is_frame() && !framed.contains(&kind) {
                framed.push(kind);
            }
            position = tag.end();
        }
        let map = configs
            .iter()
            .map(|(kind, config)| (*kind, config))
            .collect();
        Ok(self.head.bytes_with(&map))
    }

    /// The head bytes of a window that starts at `offset`.
    pub fn head_bytes_at(&self, offset: u64) -> Vec<u8> {
        let configs = self.configs_at(offset);
        let map = configs.iter().map(|c| (c.kind, c)).collect();
        self.head.bytes_with(&map)
    }

    /// The stream order that FFmpeg gives a window at `offset`, for the export check (ADR 046).
    pub fn window_stream_order(&self, offset: u64) -> Vec<TagKind> {
        let configs = self.configs_at(offset);
        let map = configs.iter().map(|c| (c.kind, c)).collect();
        self.head.window_stream_order(&map)
    }

    /// Record keyframes that a window stream saw one after another.
    pub fn record_run(&self, keyframes: &[KeyframeEntry], reaches_end: bool) {
        self.knowledge().table.record_run(keyframes, reaches_end);
    }

    /// Record a configuration tag that a window stream saw.
    pub fn record_config(&self, config: ConfigTag) {
        self.knowledge().table.record_config(config);
    }

    /// Record that a window stream read the tags of `[start, end)` one after another and recorded
    /// every configuration among them. Both offsets must lie on tag boundaries.
    pub fn record_walked(&self, start: u64, end: u64) {
        add_range(&mut self.knowledge().walked, start, end);
    }

    /// Record that a window stream found timestamps that decrease.
    pub fn record_non_monotonic(&self) {
        let mut knowledge = self.knowledge();
        if !knowledge.state.non_monotonic {
            knowledge.state.non_monotonic = true;
            knowledge.state_changed = true;
        }
    }

    pub fn non_monotonic(&self) -> bool {
        self.knowledge().state.non_monotonic
    }

    pub fn has_config_change(&self) -> bool {
        self.knowledge().table.has_config_change()
    }

    /// A copy of the table and of the decrease flag for the sidecar, when either changed since
    /// the last copy.
    pub fn take_changed(&self) -> Option<(KeyframeTable, bool)> {
        let mut knowledge = self.knowledge();
        let table_changed = knowledge.table.take_changed();
        let state_changed = std::mem::take(&mut knowledge.state_changed);
        (table_changed || state_changed)
            .then(|| (knowledge.table.clone(), knowledge.state.non_monotonic))
    }

    /// Scan the tag headers from the last known configuration at or before `offset` up to
    /// `offset`, and record the configurations found. A window whose decode failed runs this
    /// once before its retry (ADR 046). The scan skips the ranges that a window or an earlier
    /// scan walked, because those walks recorded every configuration in them. Returns the number
    /// of configurations found and the bytes read.
    pub fn rescan_configs(
        &self,
        offset: u64,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<(usize, u64), FlvError> {
        // The scan starts at the oldest of the latest configurations of each kind that has one.
        // Starting at the newest one of any kind could miss a configuration of another kind just
        // before it. A kind with no configuration at all, as MP3 audio, takes no part, or the scan
        // would start at the first frame of every such file.
        let from = self
            .configs_at(offset)
            .iter()
            .map(|c| c.offset)
            .min()
            .unwrap_or(self.head.first_frame_offset);
        // Each gap starts and ends at a tag boundary: at `from`, at `offset`, or at an end of a
        // walked range.
        let gaps = uncovered(&self.knowledge().walked, from, offset);
        let mut configs = Vec::new();
        // The part of each gap that the walk read. A damaged tag stops the walk of its gap, and
        // the rest of that gap stays for a later scan.
        let mut read = Vec::new();
        let mut bytes_read = 0;
        if !gaps.is_empty() {
            let mut source = FileSource::open(&self.path, cancel)?;
            for (start, end) in gaps {
                let (found, stopped) = walk_configs(&mut source, start, end)?;
                configs.extend(found);
                read.push((start, stopped));
            }
            bytes_read = source.bytes_read();
        }
        let count = configs.len();
        let mut knowledge = self.knowledge();
        for config in configs {
            knowledge.table.record_config(config);
        }
        for (start, end) in read {
            add_range(&mut knowledge.walked, start, end);
        }
        Ok((count, bytes_read))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::{recording, FlvBuilder, RecordingOptions, TestDirectory};

    fn write(dir: &TestDirectory, bytes: &[u8]) -> PathBuf {
        let path = dir.path.join("source.flv");
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn locates_on_a_file_and_counts_the_bytes() {
        let recording = recording(&RecordingOptions {
            seconds: 600,
            ..RecordingOptions::default()
        });
        let dir = TestDirectory::new();
        let path = write(&dir, &recording.bytes);
        assert!(has_signature(&path).unwrap());
        let source = FlvSource::open(&path, None).unwrap();
        let (located, bytes_read) = source.locate(450_000, None).unwrap();
        let expected = recording
            .keyframes
            .iter()
            .rev()
            .find(|k| k.pts <= 450_000)
            .unwrap();
        assert_eq!(located.keyframe, *expected);
        assert!(bytes_read < recording.bytes.len() as u64 / 4);
        assert!(source.is_keyframe_at(expected.offset).unwrap());
        assert!(!source.is_keyframe_at(expected.offset + 1).unwrap());
    }

    #[test]
    fn a_cold_locate_on_realistic_tags_stays_bounded_and_a_table_hit_reads_nothing() {
        // Tag sizes of a 1080p recording at about 14 Mbit/s: 50 KB keyframes, 20 KB frames,
        // 400-byte audio, with a GOP of 2 s.
        let recording = recording(&RecordingOptions {
            seconds: 40,
            keyframe_len: 50_000,
            frame_len: 20_000,
            audio_len: 400,
            ..RecordingOptions::default()
        });
        let dir = TestDirectory::new();
        let path = write(&dir, &recording.bytes);
        let source = FlvSource::open(&path, None).unwrap();
        let (cold, cold_bytes) = source.locate(25_000, None).unwrap();
        assert_eq!(cold.method, locate::LocateMethod::Bisection);
        assert!(
            cold_bytes < 16 * 1024 * 1024,
            "a cold locate read {cold_bytes} bytes"
        );
        let (hit, hit_bytes) = source.locate(24_500, None).unwrap();
        assert_eq!(hit.method, locate::LocateMethod::Table);
        assert_eq!(hit_bytes, 0);
    }

    #[test]
    fn a_canceled_locate_reports_canceled() {
        let recording = recording(&RecordingOptions {
            seconds: 120,
            ..RecordingOptions::default()
        });
        let dir = TestDirectory::new();
        let path = write(&dir, &recording.bytes);
        let source = FlvSource::open(&path, None).unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        assert!(matches!(
            source.locate(90_000, Some(flag)),
            Err(FlvError::Canceled)
        ));
    }

    #[test]
    fn the_head_of_a_window_after_a_reconnect_carries_the_new_configuration() {
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 1);
        for frame in 0..300u32 {
            builder.video(frame * 33, frame % 60 == 0, 0, 800);
        }
        let reconnect = builder.avc_config(10_000, 2);
        let mut late_key = 0;
        for frame in 0..300u32 {
            let offset = builder.video(10_000 + frame * 33, frame % 60 == 0, 0, 800);
            if frame == 120 {
                late_key = offset;
            }
        }
        let dir = TestDirectory::new();
        let path = write(&dir, &builder.finish());
        let source = FlvSource::open(&path, None).unwrap();
        // Before anything has read the middle, the head carries the first configuration.
        assert_eq!(source.configs_at(late_key)[0].offset, 13);
        source.rescan_configs(late_key, None).unwrap();
        assert_eq!(source.configs_at(late_key)[0].offset, reconnect);
        assert!(source.has_config_change());
        let head = source.head_bytes_at(late_key);
        let config = &source.configs_at(late_key)[0];
        assert!(head.ends_with(&config.bytes));
    }

    #[test]
    fn a_rescan_reads_only_what_no_walk_read() {
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 1);
        for frame in 0..300u32 {
            builder.video(frame * 33, frame % 60 == 0, 0, 800);
        }
        let reconnect = builder.avc_config(10_000, 2);
        let mut late_key = 0;
        for frame in 0..300u32 {
            let offset = builder.video(10_000 + frame * 33, frame % 60 == 0, 0, 800);
            if frame == 120 {
                late_key = offset;
            }
        }
        let dir = TestDirectory::new();
        let path = write(&dir, &builder.finish());
        let (_, full) = FlvSource::open(&path, None)
            .unwrap()
            .rescan_configs(late_key, None)
            .unwrap();

        let source = FlvSource::open(&path, None).unwrap();
        // A window read the first part up to the reconnect, so the scan reads the rest only.
        source.record_walked(source.head().first_frame_offset, reconnect);
        let (_, partial) = source.rescan_configs(late_key, None).unwrap();
        assert!(partial > 0 && partial < full, "{partial} of {full} bytes");
        assert_eq!(source.configs_at(late_key)[0].offset, reconnect);
        // The scan walked the range itself, so a second scan reads nothing.
        assert_eq!(source.rescan_configs(late_key, None).unwrap(), (0, 0));
    }

    #[test]
    fn a_rescan_records_only_what_it_read() {
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 1);
        let mut damaged_at = 0;
        for frame in 0..300u32 {
            let offset = builder.video(frame * 33, frame % 60 == 0, 0, 800);
            if frame == 100 {
                damaged_at = offset;
            }
        }
        let late_key = builder.video(10_000, true, 0, 800);
        let mut bytes = builder.finish();
        // A wrong stream id makes the tag header invalid, so the walk stops there.
        bytes[damaged_at as usize + 9] = 7;
        let dir = TestDirectory::new();
        let path = write(&dir, &bytes);

        let source = FlvSource::open(&path, None).unwrap();
        let first_tag = source.head().first_tag_offset();
        source.rescan_configs(late_key, None).unwrap();
        assert_eq!(source.knowledge().walked, vec![(first_tag, damaged_at)]);

        // A canceled scan records nothing, so the next scan reads again.
        let other = FlvSource::open(&path, None).unwrap();
        let canceled = Arc::new(AtomicBool::new(true));
        assert!(matches!(
            other.rescan_configs(late_key, Some(canceled)),
            Err(FlvError::Canceled)
        ));
        let (_, read) = other.rescan_configs(late_key, None).unwrap();
        assert!(read > 0);
    }

    #[test]
    fn the_walked_ranges_join_and_leave_gaps() {
        let mut ranges = Vec::new();
        add_range(&mut ranges, 100, 200);
        add_range(&mut ranges, 300, 400);
        add_range(&mut ranges, 50, 60);
        add_range(&mut ranges, 70, 70);
        assert_eq!(ranges, vec![(50, 60), (100, 200), (300, 400)]);
        add_range(&mut ranges, 200, 300);
        add_range(&mut ranges, 55, 120);
        assert_eq!(ranges, vec![(50, 400)]);

        let ranges = vec![(100, 200), (300, 400)];
        assert_eq!(
            uncovered(&ranges, 0, 500),
            vec![(0, 100), (200, 300), (400, 500)]
        );
        assert_eq!(uncovered(&ranges, 150, 350), vec![(200, 300)]);
        assert_eq!(uncovered(&ranges, 100, 200), Vec::<(u64, u64)>::new());
        assert_eq!(uncovered(&ranges, 210, 290), vec![(210, 290)]);
        assert_eq!(uncovered(&[], 10, 20), vec![(10, 20)]);
        assert_eq!(uncovered(&ranges, 20, 20), Vec::<(u64, u64)>::new());
    }

    #[test]
    fn a_restored_table_answers_without_reads() {
        let recording = recording(&RecordingOptions {
            seconds: 60,
            ..RecordingOptions::default()
        });
        let dir = TestDirectory::new();
        let path = write(&dir, &recording.bytes);
        let first = FlvSource::open(&path, None).unwrap();
        first.locate(31_000, None).unwrap();
        let (saved, non_monotonic) = first.take_changed().unwrap();
        assert!(!non_monotonic);

        let second = FlvSource::open(&path, None).unwrap();
        second.restore(&saved, non_monotonic);
        let (located, bytes_read) = second.locate(30_200, None).unwrap();
        assert_eq!(located.method, locate::LocateMethod::Table);
        assert_eq!(bytes_read, 0);
    }

    #[test]
    fn a_canceled_first_locate_leaves_the_samples_for_the_next_one() {
        let (bytes, keys) = crate::flv::test_support::restart_recording();
        let dir = TestDirectory::new();
        let path = write(&dir, &bytes);
        let source = FlvSource::open(&path, None).unwrap();
        let flag = Arc::new(AtomicBool::new(true));
        assert!(matches!(
            source.locate(40_000, Some(flag)),
            Err(FlvError::Canceled)
        ));
        let (located, _) = source.locate(40_000, None).unwrap();
        assert!(located.non_monotonic);
        let expected = keys
            .iter()
            .rev()
            .find(|(part, _, pts)| *part == 0 && *pts <= 40_000)
            .unwrap();
        assert_eq!(located.keyframe.offset, expected.1);
        let (_, non_monotonic) = source.take_changed().unwrap();
        assert!(non_monotonic);
    }

    #[test]
    fn a_keyframe_before_a_truncated_last_tag_is_a_resume_point() {
        let recording = recording(&RecordingOptions::default());
        let mut bytes = recording.bytes.clone();
        bytes.truncate(bytes.len() - 50);
        let dir = TestDirectory::new();
        let path = write(&dir, &bytes);
        let source = FlvSource::open(&path, None).unwrap();
        let last = recording.keyframes.last().unwrap();
        assert!(source.is_keyframe_at(last.offset).unwrap());
    }

    #[test]
    fn a_file_without_the_signature_is_not_flv() {
        let dir = TestDirectory::new();
        let path = write(&dir, b"\x00\x00\x00\x18ftypisom");
        assert!(!has_signature(&path).unwrap());
        assert!(matches!(
            FlvSource::open(&path, None),
            Err(FlvError::NotFlv)
        ));
        let short = write(&dir, b"FL");
        assert!(!has_signature(&short).unwrap());
    }
}
