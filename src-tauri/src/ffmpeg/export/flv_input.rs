//! The FLV input of an export (ADR 046).
//!
//! FFmpeg cannot seek in an FLV that has no keyframe index: an input seek reads the file from its
//! start up to the seek position, which for a recording on a network share can be gigabytes. The
//! export therefore opens each input as the head of the source and a slice of the source from a
//! keyframe, joined with the concat protocol:
//!
//! ```text
//! concat:head.flv|subfile,,start,<offset>,end,<size>,,:<source>
//! ```
//!
//! The head is the FLV header and the decoder configurations, which the FLV reader of the preview
//! writes to the application data directory. The slice starts at the keyframe at or before the
//! seek position that the input seek would use, the In point less `SEEK_MARGIN_SECONDS`, which
//! the same reader locates. Under `-copyts` the tags keep their timestamps, so the `trim`
//! boundaries of the plan apply unchanged. A late segment of a 213 MB file read 30.9 MB this way
//! and 212.7 MB with the input seek, and the frames were identical (ADR 046).
//!
//! FFmpeg runs with the directory of the head as its working directory, and the command names the
//! head by its file name, so a long application data path does not lengthen each input.
//!
//! A source keeps the input seek when this form is not safe: the path holds the `|` that
//! separates the parts of the concat protocol, the reader cannot read the file, the timestamps of
//! the file decrease, the reader knows of a change of the decoder configuration, or the streams of
//! a slice would take other indices than the probe gave them, which the filter graph addresses.

use crate::ffmpeg::preview::PreviewWindows;
use crate::ffmpeg::probe::MediaProbe;
use crate::flv::cache::Revision;
use crate::flv::tag::TagKind;
use crate::flv::FlvError;
use crate::time::Rational;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// The name of the head in the command, relative to the working directory of FFmpeg.
pub const HEAD_NAME: &str = crate::flv::cache::HEAD_FILE_NAME;

/// The FLV input of an export: one slice for each segment, all with the same head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlvInput {
    /// The directory of the head, where FFmpeg runs.
    pub working_directory: PathBuf,
    /// The size of the source, where every slice ends.
    pub source_size: u64,
    /// For each segment, in concat order, the byte offset of the tag that its slice starts at.
    pub segment_offsets: Vec<u64>,
    /// The offset of the first frame of the file. A slice from there is the start of the file,
    /// whose decoder configurations the head holds.
    pub first_frame_offset: u64,
}

impl FlvInput {
    /// The offset of the single input of [`super::GraphShape::SingleInput`]: the earliest slice,
    /// which every segment can read from.
    #[must_use]
    pub fn single_offset(&self) -> Option<u64> {
        self.segment_offsets.iter().copied().min()
    }

    /// The input of a slice from `offset` of `source`, with the head named `head`: its file name
    /// for FFmpeg, which runs in [`Self::working_directory`], or [`Self::head_path`].
    #[must_use]
    pub fn url(&self, head: &str, offset: u64, source: &Path) -> String {
        format!(
            "concat:{head}|subfile,,start,{offset},end,{},,:{}",
            self.source_size,
            source.to_string_lossy()
        )
    }

    /// The full path of the head.
    #[must_use]
    pub fn head_path(&self) -> PathBuf {
        self.working_directory.join(HEAD_NAME)
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
    /// The seek position of each segment, in concat order: the In point less the seek margin,
    /// in seconds on the timeline of the source.
    pub seek_positions: &'a [Rational],
    pub app_data: &'a Path,
    /// The open FLV sources, which the export shares with the preview: each knows what the
    /// windows of the preview found, and the cache keeps the directory of an open source.
    pub windows: &'a PreviewWindows,
    pub cancel: Option<Arc<AtomicBool>>,
}

/// The target of a locate in milliseconds: the time rounded down to the millisecond.
fn target_ms(seconds: Rational) -> Option<i64> {
    // A whole millisecond stays itself. The extra microsecond of the preview matters only for
    // a float, which a Rational is not.
    let millis = seconds.mul(Rational::new(1000, 1)?)?;
    Some(millis.num().div_euclid(millis.den()))
}

/// Find the slices of an export of an FLV source and write its head.
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
    let (source, cache) = request
        .windows
        .flv_source(
            request.app_data,
            Revision {
                path: media.path_text.clone(),
                size: media.size,
                mtime: media.mtime,
            },
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
    // The last read of the flag before the write of the head. An export whose preparation was
    // abandoned while a read above was blocked (`commands::export::run_export_job_with`) sets the
    // flag, and must not write the head of the cache late, when nothing will use it.
    if request
        .cancel
        .as_ref()
        .is_some_and(|cancel| cancel.load(std::sync::atomic::Ordering::SeqCst))
    {
        return Err(FlvInputFallback::Canceled);
    }
    let head = cache
        .write_head(&source.head_bytes_at(earliest))
        .map_err(|error| FlvInputFallback::HeadNotWritten(error.to_string()))?;
    let working_directory = head
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| FlvInputFallback::HeadNotWritten("the head has no directory".to_owned()))?;
    Ok(FlvInput {
        working_directory,
        source_size: media.size,
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

    /// Writes `bytes` as `name` in a new directory, which also holds the application data.
    fn write_source(name: &str, bytes: &[u8]) -> (TestDirectory, PathBuf) {
        let directory = TestDirectory::new();
        let path = directory.path.join(name);
        fs::write(&path, bytes).unwrap();
        (directory, path)
    }

    fn locate(
        path: &Path,
        app_data: &Path,
        probe: &MediaProbe,
        positions: &[Rational],
    ) -> Result<FlvInput, FlvInputFallback> {
        locate_flv_input(&FlvInputRequest {
            source: path,
            probe,
            seek_positions: positions,
            app_data,
            windows: &PreviewWindows::default(),
            cancel: None,
        })
    }

    #[test]
    fn each_slice_starts_at_the_keyframe_at_or_before_its_seek_position() {
        let recording = recording(&RecordingOptions::default());
        let (directory, path) = write_source("live.flv", &recording.bytes);
        let app_data = directory.path.join("app");
        let probe = flv_probe(Some(1));
        let input = locate(
            &path,
            &app_data,
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
        assert_eq!(input.single_offset(), Some(key(2_067)));
        assert_eq!(input.source_size, recording.bytes.len() as u64);
        assert!(input.working_directory.starts_with(&app_data));
        let head = fs::read(input.head_path()).unwrap();
        assert_eq!(&head[..3], b"FLV");
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
            working_directory: PathBuf::from("/data/flv-cache/abc"),
            source_size: 212_906_689,
            segment_offsets: vec![159_993_740],
            first_frame_offset: 13,
        };
        assert_eq!(
            input.url(HEAD_NAME, 159_993_740, Path::new("/media/live 1.flv")),
            "concat:head.flv|subfile,,start,159993740,end,212906689,,:/media/live 1.flv"
        );
        for windows in [
            r"C:\Recordings\live.flv",
            r"\\nas\share\live.flv",
            r"\\?\C:\Recordings\live.flv",
        ] {
            assert_eq!(
                input.url(HEAD_NAME, 7, Path::new(windows)),
                format!("concat:head.flv|subfile,,start,7,end,212906689,,:{windows}")
            );
        }
        assert_eq!(input.head_path(), Path::new("/data/flv-cache/abc/head.flv"));
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
        let result = locate_flv_input(&FlvInputRequest {
            source: &path,
            probe: &flv_probe(None),
            seek_positions: &[seconds(1_000)],
            app_data: &directory.path,
            windows: &windows,
            cancel: None,
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
