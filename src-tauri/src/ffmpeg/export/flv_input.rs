//! The FLV input of an export (ADR 046).
//!
//! FFmpeg cannot seek in an FLV that has no keyframe index: an input seek reads the file from its
//! start up to the seek position, which for a recording on a network share can be gigabytes. The
//! export therefore opens each input as the head of the source and a slice of the source from a
//! keyframe, joined with the concat protocol:
//!
//! ```text
//! concat:h<k>.flv|subfile,,start,<offset>,end,<size>,,:<source>
//! ```
//!
//! The head is the FLV header and the decoder configurations, which the FLV reader of the preview
//! reads. The export writes it into its work directory as `h<k>.flv`, where `<k>` is the index of
//! the source in the plan (ADR 055). The slice starts at the keyframe at or before the
//! seek position that the input seek would use, the In point less `SEEK_MARGIN_SECONDS`, which
//! the same reader locates. Under `-copyts` the tags keep their timestamps, so the `trim`
//! boundaries of the plan apply unchanged. A late segment of a 213 MB file read 30.9 MB this way
//! and 212.7 MB with the input seek, and the frames were identical (ADR 046).
//!
//! FFmpeg runs with the work directory as its working directory, and the command names the head
//! by its file name, so a long cache path does not lengthen each input. The reads of preparation
//! with ffprobe keep their working directory and name the head by its full path.
//!
//! A source keeps the input seek when this form is not safe: the path holds the `|` that
//! separates the parts of the concat protocol, the reader cannot read the file, the timestamps of
//! the file decrease, the reader knows of a change of the decoder configuration, or the streams of
//! a slice would take other indices than the probe gave them, which the filter graph addresses.

use crate::app_cache::work::WorkDirectory;
use crate::ffmpeg::preview::PreviewWindows;
use crate::ffmpeg::probe::MediaProbe;
use crate::flv::cache::Revision;
use crate::flv::growth::{self, Verdict};
use crate::flv::tag::TagKind;
use crate::flv::FlvError;
use crate::time::Rational;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// The name of the head of the source at `index` of the plan in the work directory: `h<k>.flv`.
#[must_use]
pub fn head_name(index: usize) -> String {
    format!("h{index}.flv")
}

/// The FLV input of an export: one slice for each segment, all with the same head. Each input of
/// the source opens the slice of its earliest piece (`arguments::flv_offset`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlvInput {
    /// The file name of the head in the work directory of the export, where FFmpeg runs:
    /// [`head_name`] of the index of the source in the plan (ADR 055).
    pub head_name: String,
    /// Where every slice ends: the end of the last complete tag within the size of the revision.
    /// For a file whose last tag is whole, the size of the file.
    pub source_size: u64,
    /// For each piece of this source, in concat order, the byte offset of the tag that its slice
    /// starts at. The pieces of other sources have no offset here (ADR 053).
    pub segment_offsets: Vec<u64>,
    /// The offset of the first frame of the file. A slice from there is the start of the file,
    /// whose decoder configurations the head holds.
    pub first_frame_offset: u64,
}

impl FlvInput {
    /// The input of a slice from `offset` of `source`, with the head named `head`: its file name,
    /// [`Self::head_name`], for FFmpeg, which runs in the work directory, or [`Self::head_path`]
    /// for a read of preparation.
    #[must_use]
    pub fn url(&self, head: &str, offset: u64, source: &Path) -> String {
        format!(
            "concat:{head}|subfile,,start,{offset},end,{},,:{}",
            self.source_size,
            source.to_string_lossy()
        )
    }

    /// The full path of the head in `work_directory`, the work directory of the export.
    #[must_use]
    pub fn head_path(&self, work_directory: &Path) -> PathBuf {
        work_directory.join(&self.head_name)
    }
}

/// Why a source keeps the input seek.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlvInputFallback {
    /// The probe does not name the FLV demuxer.
    NotFlv,
    /// The path holds `|`, which separates the parts of the concat protocol.
    PathHasSeparator,
    /// The FLV reader could not read the file.
    Unreadable(String),
    /// The timestamps of the file decrease.
    NonMonotonic,
    /// The reader knows of a change of the decoder configuration, which one head cannot hold.
    ConfigChange,
    /// A slice would number its streams in another order than the probe.
    StreamOrder,
    /// The head could not be written.
    HeadNotWritten(String),
    /// The export was canceled.
    Canceled,
}

/// What [`locate_flv_input`] reads.
pub struct FlvInputRequest<'a> {
    pub source: &'a Path,
    pub probe: &'a MediaProbe,
    /// The seek position of each piece of this source, in concat order: the In point less the
    /// seek margin, in seconds on the timeline of the source.
    pub seek_positions: &'a [Rational],
    /// The application cache directory, which holds the keyframe cache of the reader (ADR 057).
    pub cache_root: &'a Path,
    /// The work directory of the export, which receives the head.
    pub work_directory: &'a WorkDirectory,
    /// The index of the source in the plan, which names its head ([`head_name`]).
    pub source_index: usize,
    /// The open FLV sources, which the export shares with the preview: each knows what the
    /// windows of the preview found, and the cache keeps the directory of an open source.
    pub windows: &'a PreviewWindows,
    pub cancel: Option<Arc<AtomicBool>>,
    /// The size and the modification time of the revision that the pieces were marked against,
    /// when the request names one. Preparation checked that the file still holds it.
    pub expected: Option<(u64, i64)>,
}

/// The target of a locate in milliseconds: the time rounded down to the millisecond.
fn target_ms(seconds: Rational) -> Option<i64> {
    // A whole millisecond stays itself. The extra microsecond of the preview matters only for
    // a float, which a Rational is not.
    let millis = seconds.mul(Rational::new(1000, 1)?)?;
    Some(millis.num().div_euclid(millis.den()))
}

/// Find the slices of an export of an FLV source and write its head.
///
/// The head is the head of the earliest slice of all the pieces of the source. That slice starts an
/// input in every assignment of `inputs::assign_inputs`: each piece reads one input, and an input
/// opens the earliest slice of its pieces, so the earliest slice of all is the earliest slice that
/// starts an input (ADR 055).
pub fn locate_flv_input(request: &FlvInputRequest<'_>) -> Result<FlvInput, FlvInputFallback> {
    if !request.probe.format_names.iter().any(|name| name == "flv") {
        return Err(FlvInputFallback::NotFlv);
    }
    let path_text = request.source.to_string_lossy();
    let media = crate::commands::media::validate_media(&path_text)
        .map_err(|error| FlvInputFallback::Unreadable(format!("{:?}", error.code)))?;
    // The input names the path of the plan, and the reader opens the canonical path.
    if path_text.contains('|') || media.path_text.contains('|') {
        return Err(FlvInputFallback::PathHasSeparator);
    }
    let unreadable = |error: FlvError| match error {
        FlvError::Canceled => FlvInputFallback::Canceled,
        other => FlvInputFallback::Unreadable(other.to_string()),
    };
    // The revision that the pieces were marked against, while the file still holds it. A
    // recorder that still writes the file adds bytes after its size, and the reads and the
    // slices stop at that size (ADR 058). The check here comes again because the preparation can
    // take tens of seconds after its own check: a file that changed must not record its
    // keyframes in the sidecar of the old revision. Without a revision, as after "Export anyway",
    // and after such a change, the file is taken as it is now.
    let now = Revision {
        path: media.path_text.clone(),
        size: media.size,
        mtime: media.mtime,
    };
    let revision = request
        .expected
        .map(|(size, mtime)| Revision {
            path: media.path_text.clone(),
            size,
            mtime,
        })
        .filter(|expected| {
            growth::verdict(expected, &media.path, media.size, media.mtime) != Verdict::Changed
        })
        .unwrap_or(now);
    let (source, cache) = request
        .windows
        .flv_source(
            request.cache_root,
            revision,
            &media.path,
            request.cancel.clone(),
        )
        .map_err(unreadable)?;

    let first_frame = source.head().first_frame_offset;
    let mut segment_offsets = Vec::with_capacity(request.seek_positions.len());
    for &position in request.seek_positions {
        let target = target_ms(position).ok_or(FlvInputFallback::Unreadable(
            "a seek position cannot be written in milliseconds".to_owned(),
        ))?;
        let (located, _) = source
            .locate(target, request.cancel.clone())
            .map_err(unreadable)?;
        // Before the first keyframe, the slice starts at the first frame of the file, so the
        // audio in front of that keyframe stays, as the input seek keeps it.
        let offset = if located.method == crate::flv::locate::LocateMethod::Start {
            first_frame
        } else {
            located.keyframe.offset
        };
        segment_offsets.push(offset);
    }
    // The table learned from the locates. The preview reads it too.
    if let Err(error) = cache.save_changed(&source) {
        eprintln!("export: the keyframe sidecar was not saved: {error}");
    }
    if source.non_monotonic() {
        return Err(FlvInputFallback::NonMonotonic);
    }
    if source.has_config_change() {
        return Err(FlvInputFallback::ConfigChange);
    }
    let Some(earliest) = segment_offsets.iter().copied().min() else {
        return Err(FlvInputFallback::NotFlv);
    };
    if !stream_order_matches(&source.window_stream_order(earliest), request.probe) {
        return Err(FlvInputFallback::StreamOrder);
    }
    // The slices end at the last complete tag, as the windows of the preview do. A recording that
    // still grows ends inside a tag at the size of its revision, and FFmpeg would decode the part
    // of that tag as a damaged frame (ADR 058).
    let end = source
        .complete_end(request.cancel.clone())
        .map_err(unreadable)?;
    // Damage near the end can stop the walk to the last tag in front of a slice start, and
    // FFmpeg cannot open a slice that starts at or after its end.
    if segment_offsets.iter().any(|offset| *offset >= end) {
        return Err(FlvInputFallback::Unreadable(
            "a slice starts after the last whole tag that the reader found".to_owned(),
        ));
    }
    // The last read of the flag before the write of the head. An export whose preparation was
    // abandoned while a read above was blocked (`commands::export::run_export_job_with`) sets the
    // flag, and must not write the head late, when nothing will use it. A write after the
    // removal of the work directory fails, because a write never creates it (ADR 055).
    if request
        .cancel
        .as_ref()
        .is_some_and(|cancel| cancel.load(std::sync::atomic::Ordering::SeqCst))
    {
        return Err(FlvInputFallback::Canceled);
    }
    let head_name = head_name(request.source_index);
    request
        .work_directory
        .write(&head_name, &source.head_bytes_at(earliest))
        .map_err(|error| FlvInputFallback::HeadNotWritten(error.to_string()))?;
    Ok(FlvInput {
        head_name,
        source_size: end,
        segment_offsets,
        first_frame_offset: first_frame,
    })
}

/// True when a slice numbers its streams as the probe did: the video at the probe's index of
/// the video, and the audio, when the probe found one, at its index.
fn stream_order_matches(order: &[TagKind], probe: &MediaProbe) -> bool {
    let index_of = |kind: TagKind| {
        order
            .iter()
            .position(|item| *item == kind)
            .and_then(|position| u32::try_from(position).ok())
    };
    if index_of(TagKind::Video) != Some(probe.video_stream_index) {
        return false;
    }
    match &probe.audio {
        Some(audio) => index_of(TagKind::Audio) == Some(audio.index),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_cache::work::EXPORT_WORK_DIRECTORY;
    use crate::ffmpeg::probe::AudioProbe;
    use crate::flv::test_support::{
        recording, restart_recording, FlvBuilder, RecordingOptions, TestDirectory,
    };
    use std::fs;

    fn seconds(millis: i64) -> Rational {
        Rational::new(millis, 1000).unwrap()
    }

    fn flv_probe(audio: Option<u32>) -> MediaProbe {
        MediaProbe {
            format_names: vec!["flv".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: None,
            bit_depth: None,
            width: 1280,
            height: 720,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 1000).unwrap(),
            video_start_pts: None,
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: None,
            r_frame_rate: None,
            reported_frame_count: None,
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: audio.map(|index| AudioProbe {
                index,
                codec: Some("aac".to_owned()),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: None,
                reported_packets: None,
                holds_no_packets: false,
                start_time: None,
                duration: None,
                tagged_end: None,
            }),
        }
    }

    /// Writes `bytes` as `name` in a new directory, which also holds the application cache.
    fn write_source(name: &str, bytes: &[u8]) -> (TestDirectory, PathBuf) {
        let directory = TestDirectory::new();
        let path = directory.path.join(name);
        fs::write(&path, bytes).unwrap();
        (directory, path)
    }

    fn locate(
        path: &Path,
        cache_root: &Path,
        probe: &MediaProbe,
        positions: &[Rational],
    ) -> Result<FlvInput, FlvInputFallback> {
        let work = WorkDirectory::create(
            &crate::app_cache::work_directory(cache_root),
            EXPORT_WORK_DIRECTORY,
        )
        .unwrap();
        locate_in(path, cache_root, &work, 0, probe, positions)
    }

    fn locate_in(
        path: &Path,
        cache_root: &Path,
        work_directory: &WorkDirectory,
        source_index: usize,
        probe: &MediaProbe,
        positions: &[Rational],
    ) -> Result<FlvInput, FlvInputFallback> {
        locate_flv_input(&FlvInputRequest {
            source: path,
            probe,
            seek_positions: positions,
            cache_root,
            work_directory,
            source_index,
            windows: &PreviewWindows::default(),
            cancel: None,
            expected: None,
        })
    }

    #[test]
    fn each_slice_starts_at_the_keyframe_at_or_before_its_seek_position() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let cache_root = directory.path.join("cache");
        let work = WorkDirectory::create(
            &crate::app_cache::work_directory(&cache_root),
            EXPORT_WORK_DIRECTORY,
        )
        .unwrap();
        let probe = flv_probe(Some(1));
        let input = locate_in(
            &path,
            &cache_root,
            &work,
            3,
            &probe,
            &[seconds(10_200), seconds(3_500), seconds(2_067)],
        )
        .unwrap();
        let key = |pts: i64| {
            recording
                .keyframes
                .iter()
                .find(|keyframe| keyframe.pts == pts)
                .unwrap()
                .offset
        };
        assert_eq!(
            input.segment_offsets,
            vec![key(10_067), key(2_067), key(2_067)]
        );
        assert_eq!(input.source_size, recording.bytes.len() as u64);
        assert_eq!(input.head_name, "h3.flv");
        assert_eq!(input.head_path(work.path()), work.file_path("h3.flv"));
        let head = fs::read(work.file_path("h3.flv")).unwrap();
        assert_eq!(&head[..3], b"FLV");
        // The cache of the reader keeps the keyframe table only (ADR 055).
        let cached: Vec<PathBuf> = fs::read_dir(cache_root.join(crate::flv::cache::CACHE_DIR_NAME))
            .unwrap()
            .flatten()
            .flat_map(|entry| fs::read_dir(entry.path()).unwrap().flatten())
            .map(|entry| entry.path())
            .collect();
        assert!(
            cached
                .iter()
                .all(|path| path.extension() != Some("flv".as_ref())),
            "{cached:?}"
        );
    }

    /// The FLV input of `path` for one piece at 2.067 s, for pieces marked against the revision
    /// `expected`.
    fn locate_expecting(path: &Path, cache_root: &Path, expected: Option<(u64, i64)>) -> FlvInput {
        let work = WorkDirectory::create(
            &crate::app_cache::work_directory(cache_root),
            EXPORT_WORK_DIRECTORY,
        )
        .unwrap();
        locate_flv_input(&FlvInputRequest {
            source: path,
            probe: &flv_probe(Some(1)),
            seek_positions: &[seconds(2_067)],
            cache_root,
            work_directory: &work,
            source_index: 0,
            windows: &PreviewWindows::default(),
            cancel: None,
            expected,
        })
        .unwrap()
    }

    /// True when the keyframe cache holds a directory for `revision`.
    fn cached(cache_root: &Path, revision: &Revision) -> bool {
        cache_root
            .join(crate::flv::cache::CACHE_DIR_NAME)
            .join(revision.key())
            .is_dir()
    }

    #[test]
    fn the_slices_of_a_grown_file_end_at_the_last_whole_tag_of_its_revision() {
        let recording = recording(&RecordingOptions::default());
        // The pieces were marked against the file at about half its size, inside a tag.
        let size = recording.bytes.len() / 2;
        let (directory, path) = write_source("live.flv", &recording.bytes[..size]);
        let media = crate::commands::media::validate_media(&path.to_string_lossy()).unwrap();
        let revision = Revision {
            path: media.path_text.clone(),
            size: size as u64,
            mtime: media.mtime,
        };
        growth::remember(&revision, &media.path);
        // The recorder writes the rest.
        fs::write(&path, &recording.bytes).unwrap();
        let cache_root = directory.path.join("cache");

        let input = locate_expecting(&path, &cache_root, Some((size as u64, media.mtime)));

        // The slices end at the end of the last whole tag in front of the size.
        let end = input.source_size;
        assert!(end <= size as u64);
        let whole = crate::flv::FlvSource::open(&path, None).unwrap();
        let previous = u32::from_be_bytes(
            recording.bytes[end as usize - 4..end as usize]
                .try_into()
                .unwrap(),
        );
        let last = whole
            .tag_at(end - 4 - u64::from(previous))
            .unwrap()
            .unwrap();
        assert_eq!(last.end(), end);
        assert!(whole.tag_at(end).unwrap().unwrap().end() > size as u64);
        assert!(input
            .url("h0.flv", 0, &path)
            .contains(&format!(",end,{end},")));
        // The keyframe table goes to the directory of that revision.
        assert!(cached(&cache_root, &revision));
    }

    #[test]
    fn a_file_that_changed_after_the_check_takes_its_own_revision() {
        let recording = recording(&RecordingOptions::default());
        let size = recording.bytes.len() / 2;
        let (directory, path) = write_source("live.flv", &recording.bytes[..size]);
        let media = crate::commands::media::validate_media(&path.to_string_lossy()).unwrap();
        let revision = Revision {
            path: media.path_text.clone(),
            size: size as u64,
            mtime: media.mtime,
        };
        growth::remember(&revision, &media.path);
        // The recorder starts the file again: other bytes in front of the old size.
        let mut restarted = recording.bytes.clone();
        restarted[size - 10] ^= 0xFF;
        fs::write(&path, &restarted).unwrap();
        let cache_root = directory.path.join("cache");

        let input = locate_expecting(&path, &cache_root, Some((size as u64, media.mtime)));

        assert_eq!(input.source_size, restarted.len() as u64);
        assert!(!cached(&cache_root, &revision));
    }

    #[test]
    fn a_head_that_cannot_be_written_keeps_the_input_seek() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let cache_root = directory.path.join("cache");
        let work = WorkDirectory::create(
            &crate::app_cache::work_directory(&cache_root),
            EXPORT_WORK_DIRECTORY,
        )
        .unwrap();
        // Stands for a work directory that is gone, as after an abandoned preparation.
        fs::remove_dir_all(work.path()).unwrap();
        let result = locate_in(
            &path,
            &cache_root,
            &work,
            0,
            &flv_probe(Some(1)),
            &[seconds(3_500)],
        );
        assert!(
            matches!(result, Err(FlvInputFallback::HeadNotWritten(_))),
            "{result:?}"
        );
        assert!(!work.path().exists(), "a write never creates the directory");
    }

    #[test]
    fn a_seek_position_before_the_first_keyframe_starts_at_the_first_frame() {
        let recording = recording(&RecordingOptions {
            leading_frames: 10,
            ..RecordingOptions::default()
        });
        let (directory, path) = write_source("cut.flv", &recording.bytes);
        let input = locate(
            &path,
            &directory.path.join("app"),
            &flv_probe(Some(1)),
            &[seconds(-5_000)],
        )
        .unwrap();
        assert_eq!(input.segment_offsets, vec![recording.first_frame_offset]);
        assert_eq!(input.first_frame_offset, recording.first_frame_offset);
    }

    #[test]
    fn the_input_joins_the_head_and_a_slice_with_the_concat_protocol() {
        let input = FlvInput {
            head_name: head_name(0),
            source_size: 212_906_689,
            segment_offsets: vec![159_993_740],
            first_frame_offset: 13,
        };
        assert_eq!(
            input.url(
                &input.head_name,
                159_993_740,
                Path::new("/media/live 1.flv")
            ),
            "concat:h0.flv|subfile,,start,159993740,end,212906689,,:/media/live 1.flv"
        );
        for windows in [
            r"C:\Recordings\live.flv",
            r"\\nas\share\live.flv",
            r"\\?\C:\Recordings\live.flv",
        ] {
            assert_eq!(
                input.url(&input.head_name, 7, Path::new(windows)),
                format!("concat:h0.flv|subfile,,start,7,end,212906689,,:{windows}")
            );
        }
        assert_eq!(
            input.head_path(Path::new("/cache/export-1-0")),
            Path::new("/cache/export-1-0/h0.flv")
        );
        assert_eq!(head_name(12), "h12.flv");
    }

    #[test]
    fn a_source_that_is_not_an_flv_keeps_the_input_seek() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let mut probe = flv_probe(Some(1));
        probe.format_names = vec!["mov,mp4,m4a,3gp,3g2,mj2".to_owned()];
        assert_eq!(
            locate(&path, &directory.path, &probe, &[seconds(1_000)]),
            Err(FlvInputFallback::NotFlv)
        );
    }

    // Windows file names cannot contain '|'.
    #[cfg(unix)]
    #[test]
    fn a_path_with_the_concat_separator_keeps_the_input_seek() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("a|b.flv", &recording.bytes);
        assert_eq!(
            locate(
                &path,
                &directory.path,
                &flv_probe(Some(1)),
                &[seconds(1_000)]
            ),
            Err(FlvInputFallback::PathHasSeparator)
        );
    }

    #[test]
    fn timestamps_that_decrease_keep_the_input_seek() {
        let (bytes, _) = restart_recording();
        let (directory, path) = write_source("restart.flv", &bytes);
        assert_eq!(
            locate(&path, &directory.path, &flv_probe(None), &[seconds(30_000)]),
            Err(FlvInputFallback::NonMonotonic)
        );
    }

    #[test]
    fn streams_in_another_order_than_the_probe_keep_the_input_seek() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let mut probe = flv_probe(Some(0));
        probe.video_stream_index = 1;
        assert_eq!(
            locate(&path, &directory.path, &probe, &[seconds(1_000)]),
            Err(FlvInputFallback::StreamOrder)
        );
    }

    /// A video-only recording of 600 frames with a new decoder configuration at frame 300.
    fn reconnect_recording() -> Vec<u8> {
        let mut builder = FlvBuilder::new(false, true);
        builder.avc_config(0, 0);
        for frame in 0..600u32 {
            if frame == 300 {
                builder.avc_config(frame * 33, 1);
            }
            builder.video(
                frame * 33,
                frame % 60 == 0,
                0,
                if frame % 60 == 0 { 3000 } else { 500 },
            );
        }
        builder.finish()
    }

    #[test]
    fn a_known_change_of_the_decoder_configuration_keeps_the_input_seek() {
        let (directory, path) = write_source("reconnect.flv", &reconnect_recording());
        // The second position locates the keyframe right behind the new configuration, so the
        // walk reads the block that holds it.
        let result = locate(
            &path,
            &directory.path,
            &flv_probe(None),
            &[seconds(5_000), seconds(10_000)],
        );
        assert_eq!(result, Err(FlvInputFallback::ConfigChange));
        // A locate that reads no block with the change keeps the slices. The check of the
        // slices with ffprobe covers that case.
        let (directory, path) = write_source("reconnect.flv", &reconnect_recording());
        assert!(locate(&path, &directory.path, &flv_probe(None), &[seconds(1_000)]).is_ok());
    }

    #[test]
    fn a_change_that_the_preview_found_keeps_the_input_seek() {
        let (directory, path) = write_source("reconnect.flv", &reconnect_recording());
        let windows = PreviewWindows::default();
        let media = crate::commands::media::validate_media(&path.to_string_lossy()).unwrap();
        let revision = Revision {
            path: media.path_text.clone(),
            size: media.size,
            mtime: media.mtime,
        };
        let (source, _) = windows
            .flv_source(&directory.path, revision, &media.path, None)
            .unwrap();
        // A window of the preview read the change and saved no sidecar yet. The export shares
        // the source, so it knows of the change, though its own locate reads no block with it.
        source.locate(10_000, None).unwrap();
        assert!(source.has_config_change());
        let work = WorkDirectory::create(
            &crate::app_cache::work_directory(&directory.path),
            EXPORT_WORK_DIRECTORY,
        )
        .unwrap();
        let result = locate_flv_input(&FlvInputRequest {
            source: &path,
            probe: &flv_probe(None),
            seek_positions: &[seconds(1_000)],
            cache_root: &directory.path,
            work_directory: &work,
            source_index: 0,
            windows: &windows,
            cancel: None,
            expected: None,
        });
        assert_eq!(result, Err(FlvInputFallback::ConfigChange));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_whose_name_holds_the_concat_separator_keeps_the_input_seek() {
        // The input names the path of the plan, not the canonical path that the reader opens.
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let link = directory.path.join("a|b.flv");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(
            locate(
                &link,
                &directory.path,
                &flv_probe(Some(1)),
                &[seconds(1_000)]
            ),
            Err(FlvInputFallback::PathHasSeparator)
        );
    }

    #[test]
    fn the_target_of_a_locate_is_the_millisecond_at_or_before_the_position() {
        assert_eq!(target_ms(seconds(3_500)), Some(3_500));
        assert_eq!(
            target_ms(Rational::new(10_001, 3_000).unwrap()),
            Some(3_333)
        );
        assert_eq!(target_ms(Rational::new(-1, 2_000).unwrap()), Some(-1));
    }
}
