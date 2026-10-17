//! Finding the keyframe at or before a presentation time, and the extent of the file.
//!
//! The locator tries four ways in order (ADR 046): the `onMetaData` keyframe index, the keyframe
//! table, a bisection on byte offsets, and a sequential scan of the tag headers. The bisection
//! needs timestamps that do not decrease. Audio and video tags interleave by decode time with
//! some jitter, so the comparisons allow [`INTERLEAVE_TOLERANCE_MS`]. A timestamp more than
//! [`DECREASE_LIMIT_MS`] below one at a lower offset means that the timestamps decrease, as after
//! a reconnect that restarts them, and the locator then scans from the start.

use super::amf::KeyframeIndex;
use super::head::FlvHead;
use super::reader::{ByteSource, BLOCK_LEN};
use super::scan::{self, configs_between, previous_tag, read_config, read_tag, resync, Tag};
use super::table::{KeyframeEntry, KeyframeTable};
use super::tag::{TagKind, TagRole, PREVIOUS_TAG_SIZE_LEN};
use super::FlvError;

/// How far the decode times of interleaved audio and video tags may stray from file order.
pub const INTERLEAVE_TOLERANCE_MS: i64 = 1000;
/// A timestamp this far below an earlier one means that the timestamps decrease.
pub const DECREASE_LIMIT_MS: i64 = 10_000;
/// The bisection stops when the bracket is this small and walks the rest.
const BISECTION_STOP: u64 = 256 * 1024;
/// The number of evenly spaced points that the first bisection of a source samples, to find
/// timestamps that restart in the middle of the file. A local comparison cannot see a restart
/// when the bisection lands after it, because the timestamps there rise again.
const DECREASE_SAMPLES: u64 = 16;
/// The largest gap between two entries of the `onMetaData` index that the index answers across.
/// A sparse index that leaves out keyframes then still gives a keyframe close enough for a
/// window of 60 s to reach the target.
const INDEX_MAX_GAP_MS: i64 = 20_000;
/// The most tags that a probe walks from its boundary to the first frame. Script and
/// configuration tags can carry any timestamp, so only frames take part in the comparisons.
const PROBE_FRAME_SEARCH: usize = 64;
/// How far back from the end the extent searches for the last tag of a truncated file.
const TAIL_SEARCH: u64 = 4 * 1024 * 1024;

/// How the locator found a keyframe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocateMethod {
    /// The target lies at or before the first keyframe.
    Start,
    Index,
    Table,
    Bisection,
    Sequential,
}

/// A located keyframe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Located {
    pub keyframe: KeyframeEntry,
    pub method: LocateMethod,
    /// True when the locator knows that the timestamps of the file decrease.
    pub non_monotonic: bool,
}

/// What the locator keeps between two locates of one source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocateState {
    /// False once an entry of the `onMetaData` index pointed at the wrong tag. The locator then
    /// never reads the index again.
    pub index_valid: bool,
    /// True once the locator found timestamps that decrease. Every later locate then scans.
    pub non_monotonic: bool,
    /// True once the samples of [`DECREASE_SAMPLES`] were taken.
    pub sampled: bool,
    /// The first keyframe, when the walk of the head did not reach it. A recording that starts in
    /// the middle of a long GOP has its first keyframe beyond that bounded walk.
    pub first_keyframe: Option<KeyframeEntry>,
    /// True once a walk for the first keyframe reached the end of the readable tags without one,
    /// so no later locate repeats it.
    pub no_keyframe: bool,
}

impl Default for LocateState {
    fn default() -> Self {
        Self {
            index_valid: true,
            non_monotonic: false,
            sampled: false,
            first_keyframe: None,
            no_keyframe: false,
        }
    }
}

fn entry(tag: &Tag) -> KeyframeEntry {
    KeyframeEntry {
        offset: tag.offset,
        dts: tag.dts(),
        pts: tag.pts(),
    }
}

fn is_video_keyframe(tag: &Tag) -> bool {
    tag.header.kind == TagKind::Video && tag.is_keyframe()
}

/// The result of a walk that found decreasing timestamps.
struct Decreasing;

/// Find the keyframe whose presentation time is the latest at or before `target_pts`.
pub fn locate_keyframe(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    table: &mut KeyframeTable,
    target_pts: i64,
    state: &mut LocateState,
) -> Result<Located, FlvError> {
    let first = first_keyframe(source, head, state)?;
    if target_pts <= first.pts {
        return Ok(Located {
            keyframe: first,
            method: LocateMethod::Start,
            non_monotonic: state.non_monotonic,
        });
    }
    let (keyframe, method) = find(source, head, table, target_pts, state, first)?;
    Ok(Located {
        keyframe,
        method,
        non_monotonic: state.non_monotonic,
    })
}

/// The first video keyframe of the file: from the head, from an earlier locate, or from a walk of
/// the tags after the first video frame. The walk runs only when the head saw a video frame, so
/// it reads the rest of the first GOP, which the first window reads anyway. It runs once for
/// each source, and a walk that finds no keyframe is not repeated.
fn first_keyframe(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    state: &mut LocateState,
) -> Result<KeyframeEntry, FlvError> {
    if let Some(tag) = head.first_keyframe {
        return Ok(entry(&tag));
    }
    if let Some(keyframe) = state.first_keyframe {
        return Ok(keyframe);
    }
    let Some(first_video) = head.first_video else {
        return Err(FlvError::NoKeyframe);
    };
    if state.no_keyframe {
        return Err(FlvError::NoKeyframe);
    }
    let mut position = first_video.offset;
    while let Some(tag) = read_tag(source, position)? {
        if is_video_keyframe(&tag) {
            state.first_keyframe = Some(entry(&tag));
            return Ok(entry(&tag));
        }
        position = tag.end();
    }
    state.no_keyframe = true;
    Err(FlvError::NoKeyframe)
}

fn find(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    table: &mut KeyframeTable,
    target_pts: i64,
    state: &mut LocateState,
    first: KeyframeEntry,
) -> Result<(KeyframeEntry, LocateMethod), FlvError> {
    if !state.non_monotonic {
        if state.index_valid {
            if let Some(index) = &head.index {
                match from_index(source, index, target_pts)? {
                    IndexAnswer::Found(keyframe) => return Ok((keyframe, LocateMethod::Index)),
                    IndexAnswer::NotCovered => {}
                    IndexAnswer::Wrong => state.index_valid = false,
                }
            }
        }
        if let Some(keyframe) = table.lookup(target_pts) {
            return Ok((keyframe, LocateMethod::Table));
        }
        if !state.sampled {
            // The flag is set only after the samples ran, so a canceled first locate leaves them
            // for the next one.
            let decrease = samples_decrease(source, head)?;
            state.sampled = true;
            state.non_monotonic = decrease;
        }
    }
    if !state.non_monotonic {
        match bisect(source, head, table, target_pts, first)? {
            Ok(keyframe) => return Ok((keyframe, LocateMethod::Bisection)),
            Err(Decreasing) => state.non_monotonic = true,
        }
    }
    Ok((
        sequential(source, head, table, target_pts, first)?,
        LocateMethod::Sequential,
    ))
}

/// True when the decode times at evenly spaced points of the file decrease.
fn samples_decrease(source: &mut dyn ByteSource, head: &FlvHead) -> Result<bool, FlvError> {
    let start = head.first_frame_offset;
    let len = source.len();
    let mut latest: Option<i64> = None;
    for sample in 0..DECREASE_SAMPLES {
        let at = start + (len - start) * sample / DECREASE_SAMPLES;
        let until = at.saturating_add(scan::RESYNC_REACH).min(len);
        let Some(boundary) = resync(source, at, until)? else {
            continue;
        };
        let Some(tag) = frame_at_or_after(source, boundary)? else {
            continue;
        };
        if latest.is_some_and(|latest| tag.dts() < latest - DECREASE_LIMIT_MS) {
            return Ok(true);
        }
        latest = latest.max(Some(tag.dts()));
    }
    Ok(false)
}

/// What the `onMetaData` index says about a target.
enum IndexAnswer {
    Found(KeyframeEntry),
    /// The index does not cover the target: it lies after the last entry, or between two entries
    /// that lie too far apart. A recorder can stop filling its index, or write it sparse.
    NotCovered,
    /// An entry does not point at the keyframe that it names.
    Wrong,
}

/// The keyframe that the index names for `target_pts`.
fn from_index(
    source: &mut dyn ByteSource,
    index: &KeyframeIndex,
    target_pts: i64,
) -> Result<IndexAnswer, FlvError> {
    // The index gives decode times. A presentation time is never earlier than its decode time,
    // so the answer is the last entry at or before the target, or one of the entries before it.
    let after = index.partition_point(|(dts, _)| *dts <= target_pts);
    let Some(&(next_dts, _)) = index.get(after) else {
        return Ok(IndexAnswer::NotCovered);
    };
    let mut position = after;
    while position > 0 {
        position -= 1;
        let (dts, offset) = index[position];
        if next_dts - dts > INDEX_MAX_GAP_MS {
            return Ok(IndexAnswer::NotCovered);
        }
        let Some(tag) = read_tag(source, offset)? else {
            return Ok(IndexAnswer::Wrong);
        };
        if !is_video_keyframe(&tag) || (tag.dts() - dts).abs() > 1 {
            return Ok(IndexAnswer::Wrong);
        }
        if tag.pts() <= target_pts {
            return Ok(IndexAnswer::Found(entry(&tag)));
        }
    }
    Ok(IndexAnswer::NotCovered)
}

/// The first audio or video frame at or after the proven boundary `tag`.
fn frame_at_or_after(source: &mut dyn ByteSource, tag: Tag) -> Result<Option<Tag>, FlvError> {
    let mut current = tag;
    for _ in 0..PROBE_FRAME_SEARCH {
        if current.role.is_frame() {
            return Ok(Some(current));
        }
        match read_tag(source, current.end())? {
            Some(next) => current = next,
            None => return Ok(None),
        }
    }
    Ok(None)
}

/// A bisection on byte offsets, then a walk. `Err(Decreasing)` when the timestamps decrease.
fn bisect(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    table: &mut KeyframeTable,
    target_pts: i64,
    first: KeyframeEntry,
) -> Result<Result<KeyframeEntry, Decreasing>, FlvError> {
    let Some(mut low) = read_tag(source, head.first_frame_offset)? else {
        return Err(FlvError::NoMediaTags);
    };
    let mut high = source.len();
    while high - low.offset > BISECTION_STOP {
        let middle = low.offset + (high - low.offset) / 2;
        let Some(boundary) = resync(source, middle, high)? else {
            high = middle;
            continue;
        };
        // The probe read this block already. Its configuration tags cost nothing more.
        let block_end = (boundary.offset / BLOCK_LEN as u64 + 1) * BLOCK_LEN as u64;
        for config in configs_between(source, boundary.offset, block_end)? {
            table.record_config(config);
        }
        let Some(probe) = frame_at_or_after(source, boundary)? else {
            high = middle;
            continue;
        };
        if probe.offset >= high {
            high = middle;
            continue;
        }
        if probe.dts() < low.dts() - DECREASE_LIMIT_MS {
            return Ok(Err(Decreasing));
        }
        if probe.dts().saturating_add(INTERLEAVE_TOLERANCE_MS) <= target_pts {
            low = probe;
        } else {
            high = probe.offset;
        }
    }
    walk_from(source, head, table, low, target_pts, first)
}

/// Walk forward from `start` to the first tag past the target, then backward when no keyframe
/// came at or before it. The keyframes of the walk enter the table as one run.
fn walk_from(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    table: &mut KeyframeTable,
    start: Tag,
    target_pts: i64,
    first: KeyframeEntry,
) -> Result<Result<KeyframeEntry, Decreasing>, FlvError> {
    let mut run = Vec::new();
    let mut best = None;
    let mut latest_dts = start.dts();
    let mut position = start.offset;
    let mut reaches_end = false;
    loop {
        let Some(tag) = read_tag(source, position)? else {
            reaches_end = position == source.len();
            break;
        };
        // Script and configuration tags can carry any timestamp, so only frames decide.
        let frame = tag.role.is_frame();
        if frame && tag.dts() < latest_dts - DECREASE_LIMIT_MS {
            return Ok(Err(Decreasing));
        }
        if frame {
            latest_dts = latest_dts.max(tag.dts());
        }
        if tag.role == TagRole::Config {
            table.record_config(read_config(source, &tag)?);
        }
        if is_video_keyframe(&tag) {
            run.push(entry(&tag));
            if tag.pts() <= target_pts {
                best = Some(entry(&tag));
            }
        }
        // Past this decode time no later tag holds a frame at or before the target. Walking on
        // to the next keyframe would read up to one more GOP, which the window that follows
        // reads anyway and records in the table (ADR 046).
        if frame && tag.dts() > target_pts.saturating_add(INTERLEAVE_TOLERANCE_MS) {
            break;
        }
        position = tag.end();
    }
    table.record_run(&run, reaches_end);

    if best.is_none() {
        // The GOP that holds the target started before the walk. The first keyframe that the
        // backward walk meets has no keyframe between it and the walk, so it joins the run.
        let mut position = start.offset;
        let mut adjacent = true;
        while let Some(tag) = previous_tag(source, position, head.first_tag_offset())? {
            if is_video_keyframe(&tag) {
                if adjacent {
                    let mut joined = vec![entry(&tag)];
                    joined.extend(run.first().copied());
                    table.record_run(&joined, reaches_end && run.len() <= 1);
                    adjacent = false;
                }
                if tag.pts() <= target_pts {
                    best = Some(entry(&tag));
                    break;
                }
            }
            position = tag.offset;
        }
    }
    Ok(Ok(best.unwrap_or(first)))
}

/// Scan the tags from the first frame to the first tag past the target. With timestamps that
/// decrease, the target can occur more than once, and this takes its first occurrence.
fn sequential(
    source: &mut dyn ByteSource,
    head: &FlvHead,
    table: &mut KeyframeTable,
    target_pts: i64,
    first: KeyframeEntry,
) -> Result<KeyframeEntry, FlvError> {
    // A table answers only for timestamps that do not decrease, so these keyframes do not enter
    // it as a run. The configurations still help the head of a window.
    let mut best = None;
    let mut position = head.first_frame_offset;
    while let Some(tag) = read_tag(source, position)? {
        if tag.role == TagRole::Config {
            table.record_config(read_config(source, &tag)?);
        }
        if is_video_keyframe(&tag) && tag.pts() <= target_pts {
            best = Some(entry(&tag));
        }
        if tag.role.is_frame() && tag.dts() > target_pts.saturating_add(INTERLEAVE_TOLERANCE_MS) {
            break;
        }
        position = tag.end();
    }
    Ok(best.unwrap_or(first))
}

/// The presentation times of the first and the last video frame of the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extent {
    pub first_video_pts: Option<i64>,
    pub last_video_pts: Option<i64>,
}

/// The extent stops its backward walk at the first tag more than this far before the decode time
/// of the last video frame. A frame shows at most a few frames after its decode.
const TAIL_SPAN_MS: i64 = 1000;
/// The extent stops after this many tags after the last video frame, so a file opens with a few
/// block reads at its end.
const TAIL_TAGS: usize = 32;
/// The most tags that the extent walks when the end of the file holds no video frame.
const TAIL_TAGS_WITHOUT_VIDEO: usize = 1024;

/// Read the extent of the file from its head and its last tags.
pub fn extent(source: &mut dyn ByteSource, head: &FlvHead) -> Result<Extent, FlvError> {
    let first_video_pts = head.first_video.map(|tag| tag.pts());
    let Some(last) = last_tag(source, head)? else {
        return Ok(Extent {
            first_video_pts,
            last_video_pts: None,
        });
    };
    let mut latest = None;
    // The last video frame in decode order, and the tags walked since it. A file can end with
    // audio, so the bounds count from that frame and not from the last tag.
    let mut last_video: Option<(i64, usize)> = None;
    let mut tag = Some(last);
    for _ in 0..TAIL_TAGS_WITHOUT_VIDEO {
        let Some(current) = tag else {
            break;
        };
        if let Some((last_video_dts, walked)) = last_video {
            if walked >= TAIL_TAGS || current.dts() < last_video_dts - TAIL_SPAN_MS {
                break;
            }
            last_video = Some((last_video_dts, walked + 1));
        }
        if current.header.kind == TagKind::Video && current.role.is_frame() {
            latest = latest.max(Some(current.pts()));
            last_video.get_or_insert((current.dts(), 0));
        }
        tag = previous_tag(source, current.offset, head.first_tag_offset())?;
    }
    Ok(Extent {
        first_video_pts,
        last_video_pts: latest,
    })
}

/// The last complete tag: through the final `PreviousTagSize`, or, in a truncated file, through
/// a resync near the end and a walk to the last tag that ends inside the file.
fn last_tag(source: &mut dyn ByteSource, head: &FlvHead) -> Result<Option<Tag>, FlvError> {
    let len = source.len();
    let first_tag = head.first_tag_offset();
    if let Some(tag) = previous_tag(source, len, first_tag)? {
        return Ok(Some(tag));
    }
    let start = len.saturating_sub(TAIL_SEARCH).max(first_tag);
    let Some(mut tag) = resync(source, start, len)? else {
        return Ok(None);
    };
    while let Some(next) = read_tag(source, tag.end())? {
        tag = next;
    }
    debug_assert!(tag.end() + PREVIOUS_TAG_SIZE_LEN as u64 > first_tag);
    Ok(Some(tag))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::reader::SliceSource;
    use crate::flv::test_support::{recording, FlvBuilder, Recording, RecordingOptions};

    fn reference(recording: &Recording, target: i64) -> KeyframeEntry {
        recording
            .keyframes
            .iter()
            .copied()
            .rev()
            .find(|k| k.pts <= target)
            .unwrap_or(recording.keyframes[0])
    }

    fn locate(source: &mut SliceSource, table: &mut KeyframeTable, target: i64) -> Located {
        let head = FlvHead::read(source).unwrap();
        locate_keyframe(source, &head, table, target, &mut LocateState::default()).unwrap()
    }

    #[test]
    fn bisection_finds_the_keyframe_of_every_target() {
        let recording = recording(&RecordingOptions {
            seconds: 120,
            gop_frames: 60,
            ..RecordingOptions::default()
        });
        let last_pts = recording.frames.last().unwrap().2;
        for target in (0..last_pts + 2000).step_by(331) {
            let mut source = SliceSource::new(recording.bytes.clone());
            let mut table = KeyframeTable::new();
            let found = locate(&mut source, &mut table, target);
            assert_eq!(
                found.keyframe,
                reference(&recording, target),
                "target {target}"
            );
            assert!(!found.non_monotonic);
        }
    }

    #[test]
    fn a_target_on_a_keyframe_takes_that_keyframe_and_one_before_takes_the_previous() {
        let recording = recording(&RecordingOptions::default());
        let third = recording.keyframes[3];
        let mut source = SliceSource::new(recording.bytes.clone());
        let mut table = KeyframeTable::new();
        assert_eq!(locate(&mut source, &mut table, third.pts).keyframe, third);
        assert_eq!(
            locate(&mut source, &mut KeyframeTable::new(), third.pts - 1).keyframe,
            recording.keyframes[2]
        );
    }

    #[test]
    fn a_bisection_reads_far_less_than_the_file() {
        let recording = recording(&RecordingOptions {
            seconds: 600,
            gop_frames: 60,
            ..RecordingOptions::default()
        });
        let len = recording.bytes.len();
        let mut source = SliceSource::new(recording.bytes.clone());
        let mut table = KeyframeTable::new();
        let head = FlvHead::read(&mut source).unwrap();
        source.reads = 0;
        let mut state = LocateState::default();
        let target = 500_000;
        let found = locate_keyframe(&mut source, &head, &mut table, target, &mut state).unwrap();
        assert_eq!(found.method, LocateMethod::Bisection);
        assert_eq!(found.keyframe, reference(&recording, target));
        // A sequential scan reads two pieces of every tag of the first 500 s: about 75 000.
        assert!(
            source.reads < 10_000,
            "{} reads for {} bytes",
            source.reads,
            len
        );
    }

    #[test]
    fn the_walk_fills_the_table_so_a_near_target_needs_no_read() {
        let recording = recording(&RecordingOptions {
            seconds: 60,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        let mut table = KeyframeTable::new();
        let mut state = LocateState::default();
        // The walk of this locate passes the keyframe at 32 s, so the table brackets 30.5 s.
        locate_keyframe(&mut source, &head, &mut table, 31_000, &mut state).unwrap();
        source.reads = 0;
        let again = locate_keyframe(&mut source, &head, &mut table, 30_500, &mut state).unwrap();
        assert_eq!(again.method, LocateMethod::Table);
        assert_eq!(again.keyframe, reference(&recording, 30_500));
        assert_eq!(source.reads, 0);
    }

    #[test]
    fn a_long_gop_is_found_by_walking_backward() {
        let recording = recording(&RecordingOptions {
            seconds: 120,
            gop_frames: 600,
            keyframe_len: 30_000,
            frame_len: 2_000,
            ..RecordingOptions::default()
        });
        for target in [25_000, 44_000, 61_000, 119_000] {
            let mut source = SliceSource::new(recording.bytes.clone());
            let found = locate(&mut source, &mut KeyframeTable::new(), target);
            assert_eq!(
                found.keyframe,
                reference(&recording, target),
                "target {target}"
            );
        }
    }

    #[test]
    fn the_index_answers_when_it_is_right_and_is_dropped_when_it_is_wrong() {
        let recording = recording(&RecordingOptions {
            seconds: 30,
            index: true,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        let mut table = KeyframeTable::new();
        let mut state = LocateState::default();
        let found = locate_keyframe(&mut source, &head, &mut table, 9_000, &mut state).unwrap();
        assert_eq!(found.method, LocateMethod::Index);
        assert_eq!(found.keyframe, reference(&recording, 9_000));

        let mut wrong = head.clone();
        if let Some(index) = wrong.index.as_mut() {
            for entry in index.iter_mut() {
                entry.1 += 5;
            }
        }
        let mut state = LocateState::default();
        let found = locate_keyframe(&mut source, &wrong, &mut table, 9_000, &mut state).unwrap();
        assert!(!state.index_valid);
        assert_ne!(found.method, LocateMethod::Index);
        assert_eq!(found.keyframe, reference(&recording, 9_000));
    }

    #[test]
    fn a_target_before_the_first_keyframe_takes_the_first_keyframe() {
        let recording = recording(&RecordingOptions {
            start_ms: 1_234_567,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let found = locate(&mut source, &mut KeyframeTable::new(), 0);
        assert_eq!(found.method, LocateMethod::Start);
        assert_eq!(found.keyframe, recording.keyframes[0]);
        let found = locate(&mut source, &mut KeyframeTable::new(), 1_244_600);
        assert_eq!(found.keyframe, reference(&recording, 1_244_600));
    }

    #[test]
    fn timestamps_that_restart_send_the_locate_to_a_sequential_scan() {
        let (bytes, keys) = crate::flv::test_support::restart_recording();
        let mut source = SliceSource::new(bytes);
        let head = FlvHead::read(&mut source).unwrap();
        let mut table = KeyframeTable::new();
        let mut state = LocateState::default();
        let target = 40_000;
        let found = locate_keyframe(&mut source, &head, &mut table, target, &mut state).unwrap();
        assert!(found.non_monotonic);
        assert_eq!(found.method, LocateMethod::Sequential);
        // The first occurrence of the target lies in the first part.
        let expected = keys
            .iter()
            .rev()
            .find(|(part, _, pts)| *part == 0 && *pts <= target)
            .unwrap();
        assert_eq!(found.keyframe.offset, expected.1);
    }

    #[test]
    fn a_recording_that_starts_in_a_long_gop_locates_every_target() {
        // The first keyframe lies about 6 MB in, beyond the bounded walk of the head.
        let recording = recording(&RecordingOptions {
            seconds: 60,
            leading_frames: 300,
            frame_len: 20_000,
            keyframe_len: 50_000,
            ..RecordingOptions::default()
        });
        let first = recording.keyframes[0];
        assert!(first.offset > 4 * 1024 * 1024);
        let mut source = SliceSource::new(recording.bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        assert!(head.first_keyframe.is_none());
        let mut state = LocateState::default();
        let mut table = KeyframeTable::new();
        let at_start = locate_keyframe(&mut source, &head, &mut table, 0, &mut state).unwrap();
        assert_eq!(at_start.method, LocateMethod::Start);
        assert_eq!(at_start.keyframe, first);
        let last_pts = recording.frames.last().unwrap().2;
        for target in (0..last_pts + 1000).step_by(997) {
            let found =
                locate_keyframe(&mut source, &head, &mut table, target, &mut state).unwrap();
            assert_eq!(
                found.keyframe,
                reference(&recording, target),
                "target {target}"
            );
        }
        assert_eq!(
            extent(&mut source, &head).unwrap().first_video_pts,
            Some(recording.frames[0].2)
        );
    }

    #[test]
    fn an_index_that_stops_early_does_not_answer_after_its_last_entry() {
        let recording = recording(&RecordingOptions {
            seconds: 60,
            index: true,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let mut head = FlvHead::read(&mut source).unwrap();
        // Keep the entries of the first 20 s only, as a recorder that stopped filling its index.
        head.index
            .as_mut()
            .unwrap()
            .retain(|(dts, _)| *dts <= 20_000);
        let mut state = LocateState::default();
        let found = locate_keyframe(
            &mut source,
            &head,
            &mut KeyframeTable::new(),
            45_000,
            &mut state,
        )
        .unwrap();
        assert_ne!(found.method, LocateMethod::Index);
        assert_eq!(found.keyframe, reference(&recording, 45_000));
        assert!(state.index_valid);
        // A sparse index with a gap of more than 20 s does not answer inside the gap.
        let full = FlvHead::read(&mut source).unwrap();
        let mut sparse = full.clone();
        sparse
            .index
            .as_mut()
            .unwrap()
            .retain(|(dts, _)| *dts == 0 || *dts >= 24_000);
        let found = locate_keyframe(
            &mut source,
            &sparse,
            &mut KeyframeTable::new(),
            12_000,
            &mut state,
        )
        .unwrap();
        assert_ne!(found.method, LocateMethod::Index);
        assert_eq!(found.keyframe, reference(&recording, 12_000));
        // Across a gap of 20 s or less it answers with an entry that may be an earlier keyframe
        // than the latest one, still close enough for a window to reach the target.
        let mut every_other = full.clone();
        let mut keep = false;
        every_other.index.as_mut().unwrap().retain(|_| {
            keep = !keep;
            keep
        });
        let found = locate_keyframe(
            &mut source,
            &every_other,
            &mut KeyframeTable::new(),
            31_000,
            &mut state,
        )
        .unwrap();
        assert_eq!(found.method, LocateMethod::Index);
        assert!(found.keyframe.pts <= 31_000 && 31_000 - found.keyframe.pts <= 20_000);
        assert!(state.index_valid);
    }

    /// A source that fails each read after the first `allowed` ones, as a canceled read does.
    struct FailingSource {
        inner: SliceSource,
        allowed: usize,
    }

    impl ByteSource for FailingSource {
        fn len(&self) -> u64 {
            self.inner.len()
        }

        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.inner.reads >= self.allowed {
                return Err(std::io::Error::other(crate::flv::reader::Canceled));
            }
            self.inner.read_at(offset, buf)
        }
    }

    #[test]
    fn a_failed_first_locate_leaves_the_samples_for_the_next_one() {
        let (bytes, _) = crate::flv::test_support::restart_recording();
        let mut probe = SliceSource::new(bytes.clone());
        let head = FlvHead::read(&mut probe).unwrap();
        let mut state = LocateState::default();
        let mut failing = FailingSource {
            inner: SliceSource::new(bytes),
            allowed: 40,
        };
        let result = locate_keyframe(
            &mut failing,
            &head,
            &mut KeyframeTable::new(),
            40_000,
            &mut state,
        );
        assert!(matches!(result, Err(FlvError::Canceled)));
        assert!(!state.sampled);
        failing.allowed = usize::MAX;
        let found = locate_keyframe(
            &mut failing,
            &head,
            &mut KeyframeTable::new(),
            40_000,
            &mut state,
        )
        .unwrap();
        assert!(state.sampled);
        assert!(found.non_monotonic);
    }

    #[test]
    fn a_script_tag_at_timestamp_zero_in_the_middle_is_no_decrease() {
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 1);
        let mut keys = Vec::new();
        for frame in 0..3600u32 {
            let dts = frame * 33;
            if frame == 1800 {
                builder.tag(
                    18,
                    0,
                    &[
                        2, 0, 10, b'o', b'n', b'T', b'e', b'x', b't', b'D', b'a', b't', b'a',
                    ],
                );
                builder.avc_config(0, 1);
            }
            let key = frame % 60 == 0;
            let offset = builder.video(dts, key, 0, if key { 3000 } else { 500 });
            if key {
                keys.push(KeyframeEntry {
                    offset,
                    dts: i64::from(dts),
                    pts: i64::from(dts),
                });
            }
        }
        let mut source = SliceSource::new(builder.finish());
        let head = FlvHead::read(&mut source).unwrap();
        let mut state = LocateState::default();
        let mut table = KeyframeTable::new();
        for target in [10_000, 59_000, 61_000, 100_000] {
            let found =
                locate_keyframe(&mut source, &head, &mut table, target, &mut state).unwrap();
            let expected = keys.iter().rev().find(|k| k.pts <= target).unwrap();
            assert_eq!(found.keyframe, *expected, "target {target}");
            assert!(!found.non_monotonic, "target {target}");
        }
    }

    #[test]
    fn a_file_without_audio_or_without_video() {
        let recording = recording(&RecordingOptions {
            audio: false,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let found = locate(&mut source, &mut KeyframeTable::new(), 9_000);
        assert_eq!(found.keyframe, reference(&recording, 9_000));

        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        for frame in 0..500 {
            builder.audio(frame * 21, 80);
        }
        let mut source = SliceSource::new(builder.finish());
        let head = FlvHead::read(&mut source).unwrap();
        let result = locate_keyframe(
            &mut source,
            &head,
            &mut KeyframeTable::new(),
            5_000,
            &mut LocateState::default(),
        );
        assert!(matches!(result, Err(FlvError::NoKeyframe)));
    }

    #[test]
    fn an_extreme_target_does_not_overflow() {
        let recording = recording(&RecordingOptions::default());
        let mut source = SliceSource::new(recording.bytes.clone());
        let found = locate(&mut source, &mut KeyframeTable::new(), i64::MAX);
        assert_eq!(found.keyframe, *recording.keyframes.last().unwrap());
        let found = locate(&mut source, &mut KeyframeTable::new(), i64::MIN);
        assert_eq!(found.keyframe, recording.keyframes[0]);
    }

    #[test]
    fn the_extent_reads_the_last_frame_of_a_whole_and_of_a_truncated_file() {
        let recording = recording(&RecordingOptions {
            seconds: 20,
            start_ms: 1_234_567,
            ..RecordingOptions::default()
        });
        let last_pts = recording.frames.iter().map(|f| f.2).max().unwrap();
        let mut source = SliceSource::new(recording.bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        let found = extent(&mut source, &head).unwrap();
        assert_eq!(found.first_video_pts, Some(1_234_567 + 67));
        assert_eq!(found.last_video_pts, Some(last_pts));

        let mut truncated = recording.bytes.clone();
        truncated.truncate(truncated.len() - 200);
        let mut source = SliceSource::new(truncated);
        let found = extent(&mut source, &head).unwrap();
        let expected = recording
            .frames
            .iter()
            .filter(|f| f.0 < recording.bytes.len() as u64 - 700)
            .map(|f| f.2)
            .max();
        assert!(found.last_video_pts <= Some(last_pts));
        assert!(found.last_video_pts >= expected);
    }
}
