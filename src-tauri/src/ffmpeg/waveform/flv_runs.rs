//! The audio of an FLV in runs (ADR 056).
//!
//! FFmpeg puts the audio after a changed AAC configuration at the wrong time when it reads an FLV
//! itself, and its `async` drops a recording whose timestamps start again (ADR 056 measurements 5
//! and 7). Rust therefore reads the tags in order and sends the audio tags only, in runs, each to
//! its own process. A run ends at a timestamp that jumps more than [`DECREASE_LIMIT_MS`] forward
//! or backward, at a configuration that differs from the current one, and at a frame of another
//! codec, which FFmpeg would read as a second stream.
//!
//! A frame with no payload after its codec header carries no audio and is skipped. Multitrack
//! audio of enhanced FLV is classified as `Other` (see `tag`), so it takes part in no run. A
//! timestamp is read as unsigned 32 bits, as the preview reads it, so a negative timestamp of a
//! recorder reads as a time about 49.7 days on and starts a run of its own.
//!
//! [`AudioRuns`] decides what each tag does. It does no reading and starts no process, so the
//! job that owns the processes stays the one place of their lifetime.

use super::{SAMPLES_PER_BUCKET, SAMPLE_RATE};
use crate::flv::locate::DECREASE_LIMIT_MS;
use crate::flv::scan::Tag;
use crate::flv::tag::{
    audio_codec, AudioCodec, TagKind, TagRole, FILE_HEADER_LEN, PREVIOUS_TAG_SIZE_LEN,
    TAG_HEADER_LEN,
};

/// The file header of an FLV that holds audio only, with its `PreviousTagSize0`.
const AUDIO_ONLY_HEADER: [u8; FILE_HEADER_LEN + PREVIOUS_TAG_SIZE_LEN] =
    [b'F', b'L', b'V', 1, 0x04, 0, 0, 0, 9, 0, 0, 0, 0];

/// The samples of one millisecond at [`SAMPLE_RATE`].
const SAMPLES_PER_MS: i64 = SAMPLE_RATE as i64 / 1000;

/// The start of a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStart {
    /// The time of the first sample of the run, in samples of [`SAMPLE_RATE`]: the `first_pts`
    /// of its process.
    pub first_pts: i64,
    /// The bucket of that first sample.
    pub start_bucket: u64,
    /// The bytes that start the stdin of the process: the header of an audio-only FLV, then the
    /// configuration tag of the run, when the audio has one.
    pub head: Vec<u8>,
}

/// What the job does with one tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagAction {
    /// The tag is no part of a run: a video or script tag, a copy of the current configuration,
    /// a frame with no payload, or a frame before the configuration that its codec needs.
    Skip,
    /// End the current run. The tag, a new configuration, starts no run itself: the next audio
    /// frame does.
    EndRun,
    /// Write the tag to the process of the current run.
    Feed,
    /// End the current run when one is open, start a run, and write the tag to it.
    StartRun(RunStart),
}

/// The open run.
#[derive(Debug, Clone, Copy)]
struct OpenRun {
    codec: AudioCodec,
    /// The decode time of the last frame of the run, in milliseconds.
    last_dts: i64,
}

/// The state of the runs of one file.
#[derive(Debug)]
pub struct AudioRuns {
    /// `videoStartPts` in samples, the time of bucket 0.
    origin: i64,
    /// The whole tag of the current configuration.
    config: Option<Vec<u8>>,
    run: Option<OpenRun>,
    /// The highest decode time of every frame so far, across runs.
    highest_dts: Option<i64>,
    timestamps_decrease: bool,
}

impl AudioRuns {
    /// The runs of a file whose bucket 0 starts at `origin`, in samples of [`SAMPLE_RATE`].
    #[must_use]
    pub fn new(origin: i64) -> Self {
        Self {
            origin,
            config: None,
            run: None,
            highest_dts: None,
            timestamps_decrease: false,
        }
    }

    /// True when a run started more than [`DECREASE_LIMIT_MS`] below the highest decode time
    /// before it, so its buckets replace the buckets of an earlier run.
    #[must_use]
    pub fn timestamps_decrease(&self) -> bool {
        self.timestamps_decrease
    }

    /// True while a run is open.
    #[must_use]
    pub fn in_run(&self) -> bool {
        self.run.is_some()
    }

    /// The action of `tag`, whose whole bytes, with the trailing `PreviousTagSize`, are `bytes`.
    pub fn push(&mut self, tag: &Tag, bytes: &[u8]) -> TagAction {
        if tag.header.kind != TagKind::Audio {
            return TagAction::Skip;
        }
        match tag.role {
            TagRole::Config => self.push_config(bytes),
            TagRole::AudioFrame => self.push_frame(tag, bytes),
            TagRole::Keyframe { .. } | TagRole::VideoFrame { .. } | TagRole::Other => {
                TagAction::Skip
            }
        }
    }

    fn push_config(&mut self, bytes: &[u8]) -> TagAction {
        // A copy compares by its data: its timestamp can differ.
        if self.config.as_deref().map(tag_data) == Some(tag_data(bytes)) {
            return TagAction::Skip;
        }
        self.config = Some(bytes.to_vec());
        if self.run.take().is_some() {
            TagAction::EndRun
        } else {
            TagAction::Skip
        }
    }

    fn push_frame(&mut self, tag: &Tag, bytes: &[u8]) -> TagAction {
        let data = tag_data(bytes);
        let Some((codec, header_len)) = audio_codec(data) else {
            return TagAction::Skip;
        };
        if data.len() <= header_len {
            return TagAction::Skip;
        }
        if !codec.needs_config() {
            // A configuration of another codec must not go in front of these frames.
            self.config = None;
        } else if self.config.is_none() {
            return TagAction::Skip;
        }
        let dts = tag.dts();
        let continues = self.run.is_some_and(|run| {
            run.codec == codec && (dts - run.last_dts).abs() <= DECREASE_LIMIT_MS
        });
        let highest = self.highest_dts.map_or(dts, |highest| highest.max(dts));
        let starts_below = self
            .highest_dts
            .is_some_and(|highest| dts < highest - DECREASE_LIMIT_MS);
        self.highest_dts = Some(highest);
        self.run = Some(OpenRun {
            codec,
            last_dts: dts,
        });
        if continues {
            return TagAction::Feed;
        }
        if starts_below {
            self.timestamps_decrease = true;
        }
        TagAction::StartRun(self.start(dts))
    }

    fn start(&self, dts: i64) -> RunStart {
        let first_sample = dts.saturating_mul(SAMPLES_PER_MS);
        let bucket_len = i64::from(SAMPLES_PER_BUCKET);
        // The later of `videoStartPts` and the first tag, on a bucket boundary that counts from
        // `videoStartPts`, so the run never starts below bucket 0.
        let start_bucket = (first_sample.saturating_sub(self.origin)).max(0) / bucket_len;
        let mut head = AUDIO_ONLY_HEADER.to_vec();
        if let Some(config) = &self.config {
            head.extend_from_slice(config);
        }
        RunStart {
            first_pts: self.origin + start_bucket * bucket_len,
            start_bucket: start_bucket as u64,
            head,
        }
    }
}

/// The data of a whole tag, between its header and its `PreviousTagSize`.
fn tag_data(bytes: &[u8]) -> &[u8] {
    let end = bytes.len().saturating_sub(PREVIOUS_TAG_SIZE_LEN);
    bytes.get(TAG_HEADER_LEN..end).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::scan::TagStream;
    use crate::flv::tag::parse_file_header;
    use crate::flv::test_support::FlvBuilder;

    /// The action of each tag of `file`, with the decode time of the tag.
    fn actions(file: &[u8], origin: i64) -> (Vec<(i64, TagAction)>, bool) {
        let header = parse_file_header(file).unwrap();
        let first = header.first_tag_offset() as usize;
        let mut stream = TagStream::new(&file[first..], first as u64);
        let mut runs = AudioRuns::new(origin);
        let mut buf = Vec::new();
        let mut out = Vec::new();
        while let Some(tag) = stream.next_tag(&mut buf).unwrap() {
            out.push((tag.dts(), runs.push(&tag, &buf)));
        }
        (out, runs.timestamps_decrease())
    }

    fn starts(actions: &[(i64, TagAction)]) -> Vec<(i64, i64, u64)> {
        actions
            .iter()
            .filter_map(|(dts, action)| match action {
                TagAction::StartRun(start) => Some((*dts, start.first_pts, start.start_bucket)),
                _ => None,
            })
            .collect()
    }

    fn count(actions: &[(i64, TagAction)], wanted: &TagAction) -> usize {
        actions
            .iter()
            .filter(|(_, action)| action == wanted)
            .count()
    }

    fn kinds(actions: &[(i64, TagAction)]) -> Vec<&'static str> {
        actions
            .iter()
            .map(|(_, action)| match action {
                TagAction::Skip => "skip",
                TagAction::EndRun => "end",
                TagAction::Feed => "feed",
                TagAction::StartRun(_) => "start",
            })
            .collect()
    }

    #[test]
    fn one_recording_is_one_run_of_its_audio_frames() {
        let mut builder = FlvBuilder::new(true, true);
        builder.avc_config(0, 1);
        builder.aac_config(0);
        for frame in 0..30 {
            builder.video(frame * 33, frame == 0, 67, 200);
            builder.audio(46 + frame * 21, 100);
        }
        let (actions, decrease) = actions(&builder.finish(), 67 * 8);
        // The first audio frame at 46 ms lies before the video start at 67 ms: the run starts at
        // bucket 0, and its first_pts is the video start.
        assert_eq!(starts(&actions), vec![(46, 536, 0)]);
        assert_eq!(count(&actions, &TagAction::Feed), 29);
        assert_eq!(count(&actions, &TagAction::EndRun), 0);
        assert!(!decrease);
    }

    #[test]
    fn a_run_starts_on_a_bucket_boundary_that_counts_from_the_video_start() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.audio(325, 100);
        let (actions, _) = actions(&builder.finish(), 67 * 8);
        // 325 − 67 = 258 ms: bucket 25, which starts at 67 + 250 = 317 ms.
        assert_eq!(starts(&actions), vec![(325, 317 * 8, 25)]);
    }

    #[test]
    fn the_head_holds_an_audio_only_header_and_the_configuration() {
        let mut builder = FlvBuilder::new(true, true);
        let config_offset = builder.aac_config(0) as usize;
        builder.audio(0, 50);
        let file = builder.finish();
        let config = file[config_offset..config_offset + 11 + 4 + 4].to_vec();
        let (actions, _) = actions(&file, 0);
        let TagAction::StartRun(start) = &actions[1].1 else {
            panic!("the audio frame starts a run");
        };
        let mut expected = AUDIO_ONLY_HEADER.to_vec();
        expected.extend_from_slice(&config);
        assert_eq!(start.head, expected);
        let header = parse_file_header(&start.head).unwrap();
        assert!(header.has_audio && !header.has_video);
    }

    #[test]
    fn a_changed_configuration_ends_the_run_and_the_next_frame_starts_one() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.audio(0, 50);
        builder.audio(21, 50);
        // A copy of the same configuration passes.
        builder.aac_config(30);
        builder.audio(42, 50);
        // A new configuration, as after a reconnect at another sample rate.
        builder.tag(8, 50, &[0xAF, 0, 0x12, 0x10]);
        builder.audio(63, 50);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(
            kinds(&actions),
            ["skip", "start", "feed", "skip", "feed", "end", "start"]
        );
        assert_eq!(starts(&actions), vec![(0, 0, 0), (63, 6 * 80, 6)]);
        let TagAction::StartRun(second) = &actions[6].1 else {
            panic!("the frame after the new configuration starts a run");
        };
        assert!(second.head.ends_with(&[0xAF, 0, 0x12, 0x10, 0, 0, 0, 15]));
        assert!(!decrease);
    }

    #[test]
    fn a_restart_of_the_timestamps_starts_a_run_and_sets_the_flag() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        for frame in 0..10 {
            builder.audio(19_000 + frame * 200, 50);
        }
        // The recorder reconnects and starts again at 46 ms.
        builder.aac_config(0);
        builder.audio(46, 50);
        builder.audio(67, 50);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(
            starts(&actions),
            vec![(19_000, 152_000, 1900), (46, 320, 4)]
        );
        assert!(decrease);
    }

    #[test]
    fn a_small_jump_stays_in_its_run_and_a_large_forward_jump_starts_one() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.audio(0, 50);
        builder.audio(10_000, 50);
        builder.audio(5_000, 50);
        builder.audio(15_001, 50);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(
            starts(&actions),
            vec![(0, 0, 0), (15_001, 15_000 * 8, 1500)]
        );
        assert_eq!(count(&actions, &TagAction::Feed), 2);
        assert!(!decrease);
    }

    #[test]
    fn audio_without_aac_needs_no_configuration() {
        let mut builder = FlvBuilder::new(true, false);
        // MP3 at 44.1 kHz stereo: sound format 2.
        builder.tag(8, 0, &[0x2F, 0xFF, 0xFB, 0x90]);
        builder.tag(8, 26, &[0x2F, 0xFF, 0xFB, 0x90]);
        let (actions, _) = actions(&builder.finish(), 0);
        let TagAction::StartRun(start) = &actions[0].1 else {
            panic!("the first MP3 frame starts a run");
        };
        assert_eq!(start.head, AUDIO_ONLY_HEADER.to_vec());
        assert_eq!(actions[1].1, TagAction::Feed);
    }

    #[test]
    fn aac_frames_before_the_first_configuration_are_skipped() {
        let mut builder = FlvBuilder::new(true, false);
        builder.audio(0, 50);
        builder.aac_config(10);
        builder.audio(21, 50);
        let (actions, _) = actions(&builder.finish(), 0);
        assert_eq!(actions[0].1, TagAction::Skip);
        assert_eq!(actions[1].1, TagAction::Skip);
        assert_eq!(starts(&actions), vec![(21, 160, 2)]);
    }

    #[test]
    fn a_restart_with_a_new_configuration_still_sets_the_flag() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        for frame in 0..10 {
            builder.audio(19_000 + frame * 200, 50);
        }
        // The reconnect starts again at 46 ms with another sample rate.
        builder.tag(8, 0, &[0xAF, 0, 0x12, 0x10]);
        builder.audio(46, 50);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(
            starts(&actions),
            vec![(19_000, 152_000, 1900), (46, 320, 4)]
        );
        assert_eq!(count(&actions, &TagAction::EndRun), 1);
        assert!(decrease);
    }

    #[test]
    fn a_change_of_codec_starts_a_run_without_the_old_configuration() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.audio(0, 50);
        builder.audio(21, 50);
        builder.tag(8, 42, &[0x2F, 0xFF, 0xFB, 0x90]);
        builder.tag(8, 68, &[0x2F, 0xFF, 0xFB, 0x90]);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(kinds(&actions), ["skip", "start", "feed", "start", "feed"]);
        let TagAction::StartRun(mp3) = &actions[3].1 else {
            panic!("the first MP3 frame starts a run");
        };
        assert_eq!(mp3.head, AUDIO_ONLY_HEADER.to_vec());
        assert!(!decrease);
    }

    #[test]
    fn an_enhanced_frame_waits_for_its_sequence_start() {
        let mut builder = FlvBuilder::new(true, false);
        // Opus coded frames, then its sequence start, then a frame.
        builder.tag(8, 0, &[0x91, b'O', b'p', b'u', b's', 1, 2]);
        builder.tag(8, 0, &[0x90, b'O', b'p', b'u', b's', 9, 9]);
        builder.tag(8, 20, &[0x91, b'O', b'p', b'u', b's', 1, 2]);
        let (actions, _) = actions(&builder.finish(), 0);
        assert_eq!(kinds(&actions), ["skip", "skip", "start"]);
    }

    #[test]
    fn a_frame_with_no_payload_is_skipped() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.tag(8, 0, &[0xAF, 1]);
        builder.audio(21, 50);
        // An empty frame far away starts no run.
        builder.tag(8, 60_000, &[0xAF, 1]);
        builder.audio(42, 50);
        let (actions, _) = actions(&builder.finish(), 0);
        assert_eq!(kinds(&actions), ["skip", "skip", "start", "skip", "feed"]);
    }

    #[test]
    fn a_negative_timestamp_reads_as_a_time_far_on() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        // −21 ms as a recorder writes it: 0xFFFFFFEB.
        builder.tag(8, 0xFFFF_FFEB, &[0xAF, 1, 7, 7]);
        builder.audio(0, 50);
        let (actions, decrease) = actions(&builder.finish(), 0);
        assert_eq!(kinds(&actions), ["skip", "start", "start"]);
        assert!(decrease);
    }

    #[test]
    fn a_negative_origin_keeps_buckets_from_it() {
        let mut builder = FlvBuilder::new(true, false);
        builder.aac_config(0);
        builder.audio(0, 50);
        let (actions, _) = actions(&builder.finish(), -160);
        // 0 ms is 20 ms after an origin of −20 ms: bucket 2.
        assert_eq!(starts(&actions), vec![(0, 0, 2)]);
    }
}
