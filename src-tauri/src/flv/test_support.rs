//! Synthetic FLV files and a temporary directory for the tests of this module.

use super::table::KeyframeEntry;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TestDirectory {
    pub path: PathBuf,
}

impl TestDirectory {
    pub fn new() -> Self {
        for _ in 0..1000 {
            let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-flv-test-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self { path },
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("could not create test directory: {error}"),
            }
        }
        panic!("could not create a unique test directory")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Writes an FLV file tag by tag.
pub struct FlvBuilder {
    bytes: Vec<u8>,
    seed: u64,
}

impl FlvBuilder {
    pub fn new(has_audio: bool, has_video: bool) -> Self {
        let flags = (if has_audio { 0x04 } else { 0 }) | (if has_video { 0x01 } else { 0 });
        let mut bytes = vec![b'F', b'L', b'V', 1, flags, 0, 0, 0, 9];
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        Self {
            bytes,
            seed: 0x9E37_79B9_7F4A_7C15,
        }
    }

    pub fn len(&self) -> u64 {
        self.bytes.len() as u64
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }

    /// Append one tag and return its offset.
    pub fn tag(&mut self, tag_type: u8, timestamp: u32, data: &[u8]) -> u64 {
        let offset = self.len();
        let size = data.len() as u32;
        let ts = timestamp.to_be_bytes();
        self.bytes.push(tag_type);
        self.bytes.extend_from_slice(&size.to_be_bytes()[1..]);
        self.bytes.extend_from_slice(&[ts[1], ts[2], ts[3], ts[0]]);
        self.bytes.extend_from_slice(&[0, 0, 0]);
        self.bytes.extend_from_slice(data);
        self.bytes.extend_from_slice(&(11 + size).to_be_bytes());
        offset
    }

    /// An AVC sequence header. `marker` makes two configurations differ.
    pub fn avc_config(&mut self, timestamp: u32, marker: u8) -> u64 {
        self.tag(9, timestamp, &[0x17, 0, 0, 0, 0, 1, 0x64, 0, marker])
    }

    pub fn aac_config(&mut self, timestamp: u32) -> u64 {
        self.tag(8, timestamp, &[0xAF, 0, 0x11, 0x90])
    }

    /// An AVC frame of `len` data bytes with noise for the picture.
    pub fn video(&mut self, dts: u32, key: bool, composition_ms: i32, len: usize) -> u64 {
        let mut data = vec![if key { 0x17 } else { 0x27 }, 1];
        data.extend_from_slice(&composition_ms.to_be_bytes()[1..]);
        data.extend(self.noise(len.saturating_sub(5)));
        self.tag(9, dts, &data)
    }

    pub fn audio(&mut self, timestamp: u32, len: usize) -> u64 {
        let mut data = vec![0xAF, 1];
        data.extend(self.noise(len.saturating_sub(2)));
        self.tag(8, timestamp, &data)
    }

    /// An `onMetaData` script tag with a keyframe index of `count` entries, all zero. Rewrite it
    /// with [`FlvBuilder::rewrite_index`] once the offsets are known: the size does not change.
    pub fn metadata_with_index(&mut self, count: usize) -> u64 {
        let data = metadata_body(&vec![0.0; count], &vec![0.0; count]);
        self.tag(18, 0, &data)
    }

    pub fn rewrite_index(&mut self, tag_offset: u64, times: &[f64], positions: &[f64]) {
        let data = metadata_body(times, positions);
        let start = tag_offset as usize + 11;
        self.bytes[start..start + data.len()].copy_from_slice(&data);
    }

    /// Pseudo-random bytes. Every 4 KiB they hold one complete fake video tag, so that a resync
    /// that trusts one tag would stop inside the data.
    fn noise(&mut self, len: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            self.seed = self
                .seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            out.push((self.seed >> 33) as u8);
            if out.len() % 4096 == 100 && len - out.len() > 64 {
                let fake_size: u32 = 20;
                out.extend_from_slice(&[9, 0, 0, fake_size as u8, 0, 0, 1, 0, 0, 0, 0]);
                out.extend_from_slice(&[0x17, 1, 0, 0, 0]);
                out.extend(std::iter::repeat_n(0xEE, fake_size as usize - 5));
                out.extend_from_slice(&(11 + fake_size).to_be_bytes());
            }
        }
        out.truncate(len);
        out
    }
}

fn amf_string(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u16).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
}

fn amf_number(out: &mut Vec<u8>, value: f64) {
    out.push(0);
    out.extend_from_slice(&value.to_be_bytes());
}

fn amf_strict_array(out: &mut Vec<u8>, values: &[f64]) {
    out.push(0x0A);
    out.extend_from_slice(&(values.len() as u32).to_be_bytes());
    for value in values {
        amf_number(out, *value);
    }
}

fn metadata_body(times: &[f64], positions: &[f64]) -> Vec<u8> {
    let mut out = vec![2];
    amf_string(&mut out, "onMetaData");
    out.push(8);
    out.extend_from_slice(&3u32.to_be_bytes());
    amf_string(&mut out, "duration");
    amf_number(&mut out, 0.0);
    amf_string(&mut out, "encoder");
    out.push(2);
    amf_string(&mut out, "test");
    amf_string(&mut out, "keyframes");
    out.push(3);
    amf_string(&mut out, "filepositions");
    amf_strict_array(&mut out, positions);
    amf_string(&mut out, "times");
    amf_strict_array(&mut out, times);
    out.extend_from_slice(&[0, 0, 9]);
    out.extend_from_slice(&[0, 0, 9]);
    out
}

/// A synthetic recording and what the tests know about it.
pub struct Recording {
    pub bytes: Vec<u8>,
    /// Every keyframe, in file order.
    pub keyframes: Vec<KeyframeEntry>,
    /// Every video frame as (offset, dts, pts).
    pub frames: Vec<(u64, i64, i64)>,
    pub first_frame_offset: u64,
}

/// Options of [`recording`].
pub struct RecordingOptions {
    pub seconds: u32,
    pub gop_frames: u32,
    pub start_ms: u32,
    pub index: bool,
    pub audio: bool,
    pub keyframe_len: usize,
    pub frame_len: usize,
    /// Video frames before the first keyframe, as in a recording that starts in a GOP.
    pub leading_frames: u32,
    pub audio_len: usize,
}

impl Default for RecordingOptions {
    fn default() -> Self {
        Self {
            seconds: 20,
            gop_frames: 60,
            start_ms: 0,
            index: false,
            audio: true,
            keyframe_len: 3000,
            frame_len: 600,
            leading_frames: 0,
            audio_len: 80,
        }
    }
}

/// A 30 fps recording with B-frame composition times and AAC audio, interleaved by decode time.
pub fn recording(options: &RecordingOptions) -> Recording {
    let mut builder = FlvBuilder::new(options.audio, true);
    let frame_count = options.seconds * 30;
    let gop_count = (frame_count - options.leading_frames).div_ceil(options.gop_frames) as usize;
    let script = options
        .index
        .then(|| builder.metadata_with_index(gop_count));
    builder.avc_config(0, 0);
    if options.audio {
        builder.aac_config(0);
    }

    let mut keyframes = Vec::new();
    let mut frames = Vec::new();
    let mut first_frame_offset = None;
    let mut audio_index = 0u32;
    for frame in 0..frame_count {
        let dts = options.start_ms + (frame * 1000).div_ceil(30);
        // Audio frames of 1024 samples at 48 kHz up to this decode time.
        let audio_ts =
            |index: u32| options.start_ms + (u64::from(index) * 1024 * 1000 / 48_000) as u32;
        while options.audio && audio_ts(audio_index) <= dts {
            let ts = audio_ts(audio_index);
            let offset = builder.audio(ts, options.audio_len);
            first_frame_offset.get_or_insert(offset);
            audio_index += 1;
        }
        let key = frame >= options.leading_frames
            && (frame - options.leading_frames) % options.gop_frames == 0;
        // A closed GOP with two B-frames: the keyframe shows two frames late.
        let composition = if key {
            67
        } else if frame % 3 == 0 {
            100
        } else {
            0
        };
        let len = if key {
            options.keyframe_len
        } else {
            options.frame_len
        };
        let offset = builder.video(dts, key, composition, len);
        first_frame_offset.get_or_insert(offset);
        let pts = i64::from(dts) + i64::from(composition);
        frames.push((offset, i64::from(dts), pts));
        if key {
            keyframes.push(KeyframeEntry {
                offset,
                dts: i64::from(dts),
                pts,
            });
        }
    }
    if let Some(script) = script {
        let times: Vec<f64> = keyframes.iter().map(|k| k.dts as f64 / 1000.0).collect();
        let positions: Vec<f64> = keyframes.iter().map(|k| k.offset as f64).collect();
        builder.rewrite_index(script, &times, &positions);
    }
    Recording {
        bytes: builder.finish(),
        keyframes,
        frames,
        first_frame_offset: first_frame_offset.expect("a recording has frames"),
    }
}

/// Two recordings in one file, the second restarting its timestamps at 0 as after a reconnect.
/// Returns the bytes and every keyframe as (part, offset, pts).
pub fn restart_recording() -> (Vec<u8>, Vec<(u32, u64, i64)>) {
    let mut builder = FlvBuilder::new(false, true);
    builder.avc_config(0, 1);
    let mut keys = Vec::new();
    for part in 0..2 {
        for frame in 0..1800u32 {
            let dts = frame * 33;
            let key = frame % 60 == 0;
            let offset = builder.video(dts, key, 0, if key { 3000 } else { 500 });
            if key {
                keys.push((part, offset, i64::from(dts)));
            }
        }
    }
    (builder.finish(), keys)
}
