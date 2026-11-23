//! The meter of ITU-R BS.1770-4 that measures the audio of an export (ADR 061).
//!
//! The meter is the crate `ebur128`, a port of libebur128. It computes the integrated loudness
//! with its two gates, and the true peak of each channel with oversampling. [`LoudnessMeter`]
//! takes the bytes of the samples that follow a WAV header ([`super::wav::read_header`]) in any
//! split, and gives the integrated loudness and the highest true peak of the channels.
//!
//! The meter forms its blocks of 400 ms from a step of 100 ms that it rounds to whole frames, as
//! libebur128 does. At a rate that is not a multiple of 10 Hz, such as 11025 Hz, a block can then
//! differ from 400 ms by up to 2 frames. That changes the integrated loudness by much less than
//! the 0.1 LU that the setup step shows, so QuipClip keeps the blocks of the meter.

use super::wav::{WavFormat, SAMPLE_BYTES};
use ebur128::{Channel, EbuR128, Mode};

/// The frames of silence that [`LoudnessMeter::finish`] gives the interpolator of the true peak.
/// The interpolator of the crate has 48 taps in all, so its output comes at most 24 frames late.
const DRAIN_FRAMES: usize = 64;

/// The positions of the bits of a WAV channel mask (`SPEAKER_*` of `WAVE_FORMAT_EXTENSIBLE`).
mod speaker {
    pub const FRONT_LEFT: u32 = 0;
    pub const FRONT_RIGHT: u32 = 1;
    pub const FRONT_CENTER: u32 = 2;
    pub const LOW_FREQUENCY: u32 = 3;
    pub const BACK_LEFT: u32 = 4;
    pub const BACK_RIGHT: u32 = 5;
    pub const FRONT_LEFT_OF_CENTER: u32 = 6;
    pub const FRONT_RIGHT_OF_CENTER: u32 = 7;
    pub const BACK_CENTER: u32 = 8;
    pub const SIDE_LEFT: u32 = 9;
    pub const SIDE_RIGHT: u32 = 10;
    pub const TOP_CENTER: u32 = 11;
    pub const TOP_FRONT_LEFT: u32 = 12;
    pub const TOP_FRONT_CENTER: u32 = 13;
    pub const TOP_FRONT_RIGHT: u32 = 14;
    pub const TOP_BACK_LEFT: u32 = 15;
    pub const TOP_BACK_CENTER: u32 = 16;
    pub const TOP_BACK_RIGHT: u32 = 17;
}

/// The values of one measurement. A value is `None` where the meter gives no finite number.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// The integrated loudness in LUFS. `None` when no block of 400 ms passes the absolute gate
    /// of -70 LUFS: silence, or audio shorter than one block.
    pub integrated_lufs: Option<f64>,
    /// The highest true peak of the channels in dBTP. `None` for digital silence.
    pub true_peak_dbtp: Option<f64>,
}

/// Why a [`LoudnessMeter`] could not be made or could not take samples. The text is a diagnostic
/// in English (ADR 011).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterError(pub String);

impl std::fmt::Display for MeterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "the loudness meter failed: {}", self.0)
    }
}

/// A meter of the integrated loudness and the true peak of one WAV stream of 32-bit float PCM.
pub struct LoudnessMeter {
    meter: EbuR128,
    /// The bytes of one frame.
    frame_bytes: usize,
    /// The bytes of a frame that the last call to [`Self::add_bytes`] did not complete.
    pending: Vec<u8>,
    /// The samples of the whole frames of one call, reused from call to call.
    samples: Vec<f32>,
    /// The number of whole frames that the meter took.
    frames: u64,
}

impl LoudnessMeter {
    /// Make a meter for the stream of `format`.
    ///
    /// The meter weights each channel by its position in the channel mask of the stream
    /// ([`channel_map`]). A stream with no mask gets the default order of the meter.
    ///
    /// # Errors
    ///
    /// The meter refuses a sample rate below 16 Hz or above 2,822,400 Hz, and more than 64
    /// channels.
    pub fn new(format: &WavFormat) -> Result<Self, MeterError> {
        let mut meter = EbuR128::new(
            u32::from(format.channels),
            format.sample_rate,
            Mode::I | Mode::TRUE_PEAK,
        )
        .map_err(|error| {
            MeterError(format!(
                "no meter for {} channels at {} Hz: {error}",
                format.channels, format.sample_rate
            ))
        })?;
        if let Some(map) = channel_map(format) {
            meter
                .set_channel_map(&map)
                .map_err(|error| MeterError(format!("the channel map was refused: {error}")))?;
        }
        Ok(Self {
            meter,
            frame_bytes: format.frame_bytes(),
            pending: Vec::with_capacity(format.frame_bytes()),
            samples: Vec::new(),
            frames: 0,
        })
    }

    /// Give the meter the next bytes of the samples, little-endian 32-bit float, interleaved. A
    /// frame can end in a later call: the meter keeps its first bytes until then.
    ///
    /// # Errors
    ///
    /// A sample that is NaN or infinite. The meter is then of no further use. The crate also
    /// refuses a buffer that does not hold whole frames, and this function gives it whole frames
    /// only.
    pub fn add_bytes(&mut self, mut bytes: &[u8]) -> Result<(), MeterError> {
        if !self.pending.is_empty() {
            let wanted = self.frame_bytes - self.pending.len();
            let taken = wanted.min(bytes.len());
            self.pending.extend_from_slice(&bytes[..taken]);
            bytes = &bytes[taken..];
            if self.pending.len() < self.frame_bytes {
                return Ok(());
            }
            let frame = std::mem::take(&mut self.pending);
            self.add_frames(&frame)?;
            self.pending = frame;
            self.pending.clear();
        }
        let whole = bytes.len() / self.frame_bytes * self.frame_bytes;
        self.add_frames(&bytes[..whole])?;
        self.pending.extend_from_slice(&bytes[whole..]);
        Ok(())
    }

    /// Give the meter whole frames.
    fn add_frames(&mut self, bytes: &[u8]) -> Result<(), MeterError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.samples.clear();
        // `bytes` holds whole frames, so `as_chunks` leaves no remainder.
        let (samples, _) = bytes.as_chunks::<SAMPLE_BYTES>();
        self.samples
            .extend(samples.iter().map(|sample| f32::from_le_bytes(*sample)));
        // FFmpeg passes NaN and infinity through float PCM. A NaN would stay in the filters of the
        // loudness for the rest of the stream, and an infinity would hide every other peak, so
        // the measurement refuses such a stream rather than give a value that means nothing.
        if let Some(sample) = self.samples.iter().find(|sample| !sample.is_finite()) {
            return Err(MeterError(format!(
                "the audio holds the sample {sample}, which is not a finite number"
            )));
        }
        self.meter
            .add_frames_f32(&self.samples)
            .map_err(|error| MeterError(format!("the samples were refused: {error}")))?;
        self.frames += (bytes.len() / self.frame_bytes) as u64;
        Ok(())
    }

    /// The number of whole frames that the meter took. The bytes of a frame that is not complete
    /// do not count.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// End the measurement, and give the values of the frames that the meter took. The bytes of a
    /// frame that is not complete have no part in them.
    ///
    /// The interpolator of the true peak gives its output some frames late, so the peaks between
    /// the last samples are not measured when the stream ends. The meter reads the integrated
    /// loudness first, and then gives the interpolator [`DRAIN_FRAMES`] frames of silence, as if
    /// the audio stopped there. A player that reaches the end of the file meets the same step to
    /// silence.
    #[must_use]
    pub fn finish(mut self) -> Loudness {
        let integrated_lufs = self
            .meter
            .loudness_global()
            .ok()
            .filter(|lufs| lufs.is_finite());
        let silence = vec![0.0_f32; DRAIN_FRAMES * self.meter.channels() as usize];
        // The meter refuses only a buffer that does not hold whole frames, and this one does.
        let _ = self.meter.add_frames_f32(&silence);
        let peak = (0..self.meter.channels())
            .filter_map(|channel| self.meter.true_peak(channel).ok())
            .fold(0.0_f64, f64::max);
        let true_peak_dbtp = Some(20.0 * peak.log10()).filter(|dbtp| dbtp.is_finite());
        Loudness {
            integrated_lufs,
            true_peak_dbtp,
        }
    }
}

/// The position of each channel of `format` for the meter, from its channel mask, or `None` for
/// the default order of the meter.
///
/// BS.1770-4 gives the weight 1.41 to a channel at an azimuth from 60° to 120° and an elevation
/// below 30°, and 1.0 to the others, the channels above the listener included. The low-frequency channel has no part in the loudness. The meter knows these weights by
/// position. A back pair is at 110° when the layout has no side pair, as in `5.1(back)`, and at
/// 135° when it has one, as in `7.1`. A side pair is at 90° when the layout has a back pair, and at
/// 110° when it has none, as in `5.1(side)`. A position that BS.1770-4 does not name counts with the
/// weight 1.0.
///
/// The default order is for a stream with no mask, and for a mask whose number of bits is not the
/// number of channels. It is left and right for 2 channels, the one channel for 1 channel, and L,
/// R, C, LFE, Ls, Rs for 6 channels. For a layout that no mask names, such as `downmix` with 2
/// channels or `22.2`, the weights can then be wrong (ADR 061). The true peak does not depend on the
/// position: the meter measures it on every channel, the low-frequency channel too.
#[must_use]
pub fn channel_map(format: &WavFormat) -> Option<Vec<Channel>> {
    let mask = format.channel_mask?;
    if mask.count_ones() != u32::from(format.channels) {
        return None;
    }
    let has = |bit: u32| mask & (1 << bit) != 0;
    let has_back = has(speaker::BACK_LEFT) || has(speaker::BACK_RIGHT);
    let has_side = has(speaker::SIDE_LEFT) || has(speaker::SIDE_RIGHT);
    let position = |bit: u32| match bit {
        speaker::FRONT_LEFT => Channel::Left,
        speaker::FRONT_RIGHT => Channel::Right,
        speaker::FRONT_CENTER => Channel::Center,
        speaker::LOW_FREQUENCY => Channel::Unused,
        speaker::BACK_LEFT if has_side => Channel::Mp135,
        speaker::BACK_RIGHT if has_side => Channel::Mm135,
        speaker::BACK_LEFT => Channel::LeftSurround,
        speaker::BACK_RIGHT => Channel::RightSurround,
        speaker::FRONT_LEFT_OF_CENTER => Channel::MpSC,
        speaker::FRONT_RIGHT_OF_CENTER => Channel::MmSC,
        speaker::BACK_CENTER => Channel::Mp180,
        speaker::SIDE_LEFT if has_back => Channel::Mp090,
        speaker::SIDE_RIGHT if has_back => Channel::Mm090,
        speaker::SIDE_LEFT => Channel::LeftSurround,
        speaker::SIDE_RIGHT => Channel::RightSurround,
        speaker::TOP_CENTER => Channel::Tp000,
        speaker::TOP_FRONT_LEFT => Channel::Up030,
        speaker::TOP_FRONT_CENTER => Channel::Up000,
        speaker::TOP_FRONT_RIGHT => Channel::Um030,
        speaker::TOP_BACK_LEFT => Channel::Up135,
        speaker::TOP_BACK_CENTER => Channel::Up180,
        speaker::TOP_BACK_RIGHT => Channel::Um135,
        // A position that BS.1770-4 does not name counts with the weight 1.0, as a front channel.
        _ => Channel::Center,
    };
    Some((0..32).filter(|bit| has(*bit)).map(position).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::loudness::wav::{read_header, tests::ffmpeg_header};
    use std::f64::consts::PI;

    const RATE: u32 = 48_000;

    fn format(channels: u16, channel_mask: Option<u32>) -> WavFormat {
        WavFormat {
            sample_rate: RATE,
            channels,
            channel_mask,
        }
    }

    /// The level of a sine whose peak is `dbfs`.
    fn amplitude(dbfs: f64) -> f64 {
        10f64.powf(dbfs / 20.0)
    }

    /// `seconds` of interleaved frames of `channels` channels, as WAV bytes. Each channel in
    /// `tone` holds a sine of `hz` with the peak `dbfs`. The other channels hold silence.
    fn sine_bytes(channels: u16, tone: &[u16], hz: f64, dbfs: f64, seconds: f64) -> Vec<u8> {
        let frames = (f64::from(RATE) * seconds) as usize;
        let level = amplitude(dbfs);
        let mut bytes = Vec::with_capacity(frames * usize::from(channels) * SAMPLE_BYTES);
        for frame in 0..frames {
            let value = (level * (2.0 * PI * hz * frame as f64 / f64::from(RATE)).sin()) as f32;
            for channel in 0..channels {
                let sample = if tone.contains(&channel) { value } else { 0.0 };
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
        }
        bytes
    }

    fn measure(format: &WavFormat, bytes: &[u8]) -> Loudness {
        let mut meter = LoudnessMeter::new(format).unwrap();
        meter.add_bytes(bytes).unwrap();
        meter.finish()
    }

    fn close(actual: Option<f64>, expected: f64, tolerance: f64) -> bool {
        actual.is_some_and(|actual| (actual - expected).abs() <= tolerance)
    }

    #[test]
    fn a_stereo_sine_of_1_khz_at_minus_23_dbfs_reads_minus_23_lufs() {
        // EBU Tech 3341, test case 1: a stereo sine of 1 kHz with the peak -23.0 dBFS in each
        // channel reads -23.0 LUFS, within 0.1 LU. Its true peak is its peak. The test case
        // lasts 20 s. A sine holds one level, so 5 s reads the same value in less test time.
        let loudness = measure(
            &format(2, None),
            &sine_bytes(2, &[0, 1], 1000.0, -23.0, 5.0),
        );
        assert!(close(loudness.integrated_lufs, -23.0, 0.1), "{loudness:?}");
        assert!(close(loudness.true_peak_dbtp, -23.0, 0.1), "{loudness:?}");
    }

    #[test]
    fn one_channel_reads_3_db_below_the_same_sine_in_two_channels() {
        let loudness = measure(&format(1, None), &sine_bytes(1, &[0], 1000.0, -23.0, 5.0));
        assert!(close(loudness.integrated_lufs, -26.0, 0.1), "{loudness:?}");
        assert!(close(loudness.true_peak_dbtp, -23.0, 0.1), "{loudness:?}");
    }

    #[test]
    fn the_true_peak_finds_a_peak_between_two_samples() {
        // A sine at a quarter of the rate, with a phase of 45°: every sample is at 0.707 of the
        // peak, so the sample peak is 3 dB below the true peak of -6 dBFS.
        let level = amplitude(-6.0);
        let frames = RATE as usize;
        let mut bytes = Vec::with_capacity(frames * 2 * SAMPLE_BYTES);
        for frame in 0..frames {
            let value = (level * (PI / 2.0 * frame as f64 + PI / 4.0).sin()) as f32;
            bytes.extend_from_slice(&value.to_le_bytes());
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let loudness = measure(&format(2, None), &bytes);
        assert!(close(loudness.true_peak_dbtp, -6.0, 0.3), "{loudness:?}");
    }

    #[test]
    fn a_peak_above_full_scale_reads_above_0_dbtp() {
        // Float samples are not clipped. The measurement must see the overshoot it exists for.
        let loudness = measure(&format(2, None), &sine_bytes(2, &[0, 1], 1000.0, 1.5, 2.0));
        assert!(close(loudness.true_peak_dbtp, 1.5, 0.1), "{loudness:?}");
    }

    #[test]
    fn silence_and_audio_shorter_than_one_block_give_no_loudness() {
        let silence = measure(&format(2, None), &vec![0; RATE as usize * 8]);
        assert_eq!(
            silence,
            Loudness {
                integrated_lufs: None,
                true_peak_dbtp: None,
            }
        );
        // 0.3 s is shorter than the block of 400 ms: no loudness, but a true peak.
        let short = measure(
            &format(2, None),
            &sine_bytes(2, &[0, 1], 1000.0, -10.0, 0.3),
        );
        assert_eq!(short.integrated_lufs, None);
        assert!(close(short.true_peak_dbtp, -10.0, 0.1), "{short:?}");
        // A level below the absolute gate of -70 LUFS reads as silence for the loudness.
        let quiet = measure(
            &format(2, None),
            &sine_bytes(2, &[0, 1], 1000.0, -80.0, 2.0),
        );
        assert_eq!(quiet.integrated_lufs, None);
        assert!(close(quiet.true_peak_dbtp, -80.0, 0.1), "{quiet:?}");
    }

    #[test]
    fn the_mask_of_5_1_drops_the_lfe_from_the_loudness_but_not_from_the_true_peak() {
        let five_one = read_header(&mut &ffmpeg_header("5.1")[..]).unwrap();
        assert_eq!(
            channel_map(&five_one).unwrap(),
            vec![
                Channel::Left,
                Channel::Right,
                Channel::Center,
                Channel::Unused,
                Channel::LeftSurround,
                Channel::RightSurround,
            ]
        );
        let lfe = measure(&five_one, &sine_bytes(6, &[3], 60.0, -6.0, 4.0));
        assert_eq!(lfe.integrated_lufs, None, "{lfe:?}");
        assert!(close(lfe.true_peak_dbtp, -6.0, 0.1), "{lfe:?}");
    }

    #[test]
    fn a_surround_channel_weighs_1_5_db_more_than_a_front_channel() {
        // 10 × log10(1.41) = 1.49 dB. The back pair of 5.1 and the side pair of 5.1(side) are at
        // 110°. The side pair of 7.1 is at 90°, and its back pair at 135° weighs as a front channel.
        let front = measure(&format(1, None), &sine_bytes(1, &[0], 1000.0, -20.0, 4.0))
            .integrated_lufs
            .unwrap();
        for (layout, channel, weighted) in [
            ("5.1", 4, true),
            ("5.1(side)", 4, true),
            ("7.1", 6, true),
            ("7.1", 4, false),
            ("5.1", 2, false),
        ] {
            let header = read_header(&mut &ffmpeg_header(layout)[..]).unwrap();
            let bytes = sine_bytes(header.channels, &[channel], 1000.0, -20.0, 4.0);
            let expected = if weighted { front + 1.49 } else { front };
            let loudness = measure(&header, &bytes);
            assert!(
                close(loudness.integrated_lufs, expected, 0.05),
                "{layout} channel {channel}: {loudness:?}, front {front}"
            );
        }
    }

    #[test]
    fn a_mask_that_does_not_name_every_channel_gives_the_default_order() {
        assert_eq!(channel_map(&format(2, None)), None);
        assert_eq!(channel_map(&format(6, Some(0x3))), None);
        assert_eq!(channel_map(&format(2, Some(0x3f))), None);
        // A bit that BS.1770-4 does not name counts as a front channel.
        assert_eq!(
            channel_map(&format(3, Some(0x8000_0003))),
            Some(vec![Channel::Left, Channel::Right, Channel::Center])
        );
    }

    #[test]
    fn bytes_in_any_split_give_the_same_frames_and_the_same_values() {
        let bytes = sine_bytes(2, &[0, 1], 440.0, -12.0, 3.0);
        let whole = measure(&format(2, None), &bytes);
        let mut meter = LoudnessMeter::new(&format(2, None)).unwrap();
        // Splits that cut samples and frames at every offset of a frame of 8 bytes.
        let mut rest = &bytes[..];
        let mut step = 1;
        while !rest.is_empty() {
            let taken = step.min(rest.len());
            meter.add_bytes(&rest[..taken]).unwrap();
            rest = &rest[taken..];
            step = step % 13 + 1;
        }
        assert_eq!(meter.frames(), (bytes.len() / 8) as u64);
        assert_eq!(meter.finish(), whole);
    }

    #[test]
    fn the_bytes_of_a_frame_that_is_not_complete_do_not_count() {
        let mut meter = LoudnessMeter::new(&format(2, None)).unwrap();
        let bytes = sine_bytes(2, &[0, 1], 440.0, -12.0, 1.0);
        meter.add_bytes(&bytes).unwrap();
        meter.add_bytes(&[0, 0, 0, 0, 0]).unwrap();
        assert_eq!(meter.frames(), u64::from(RATE));
    }

    #[test]
    fn a_rate_or_a_channel_count_that_the_meter_cannot_take_is_refused() {
        assert!(LoudnessMeter::new(&WavFormat {
            sample_rate: 8,
            channels: 2,
            channel_mask: None,
        })
        .is_err());
        for channels in [0, 65] {
            assert!(
                LoudnessMeter::new(&format(channels, None)).is_err(),
                "{channels}"
            );
        }
        assert!(LoudnessMeter::new(&format(2, None)).is_ok());
        assert!(LoudnessMeter::new(&format(64, None)).is_ok());
    }

    #[test]
    fn the_true_peak_between_the_last_samples_is_measured() {
        // Silence, then two samples of 0.9 at the very end. The interpolator gives the peak
        // between them only after more frames, which `finish` supplies as silence. The value
        // must equal the value of the same audio followed by real silence.
        let mut bytes = vec![0u8; RATE as usize * 2 * SAMPLE_BYTES];
        for _ in 0..2 {
            for _ in 0..2 {
                bytes.extend_from_slice(&0.9_f32.to_le_bytes());
            }
        }
        let at_the_end = measure(&format(2, None), &bytes);
        let mut followed = bytes.clone();
        followed.extend(vec![0u8; 4800 * 2 * SAMPLE_BYTES]);
        let with_silence = measure(&format(2, None), &followed);
        assert_eq!(at_the_end.true_peak_dbtp, with_silence.true_peak_dbtp);
        // The peak between the two samples is above full scale, as a player would show it.
        assert!(
            at_the_end.true_peak_dbtp.is_some_and(|dbtp| dbtp > 0.5),
            "{at_the_end:?}"
        );
    }

    #[test]
    fn the_silence_of_the_drain_does_not_change_the_loudness() {
        let bytes = sine_bytes(2, &[0, 1], 1000.0, -23.0, 1.0);
        let mut meter = LoudnessMeter::new(&format(2, None)).unwrap();
        meter.add_bytes(&bytes).unwrap();
        let before = meter.meter.loudness_global().unwrap();
        assert_eq!(meter.finish().integrated_lufs, Some(before));
    }

    #[test]
    fn a_sample_that_is_not_finite_is_refused() {
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut bytes = sine_bytes(2, &[0, 1], 1000.0, -10.0, 0.5);
            let at = bytes.len() / 2 / 8 * 8;
            bytes[at..at + 4].copy_from_slice(&bad.to_le_bytes());
            let mut meter = LoudnessMeter::new(&format(2, None)).unwrap();
            let error = meter.add_bytes(&bytes).unwrap_err();
            assert!(error.0.contains("not a finite number"), "{bad}: {error}");
        }
    }

    #[test]
    fn mono_and_stereo_above_48_khz_get_a_mask_and_the_same_weights() {
        // Above 48000 Hz, FFmpeg writes mono with the mask of the centre and stereo with the
        // masks of left and right. The weights are those of the default order.
        let mono = read_header(&mut &ffmpeg_header("mono@96k")[..]).unwrap();
        let stereo = read_header(&mut &ffmpeg_header("stereo@96k")[..]).unwrap();
        assert_eq!(channel_map(&mono), Some(vec![Channel::Center]));
        assert_eq!(
            channel_map(&stereo),
            Some(vec![Channel::Left, Channel::Right])
        );
        let tone = |channels: u16, tone: &[u16]| {
            let frames = 96_000;
            let mut bytes = Vec::new();
            for frame in 0..frames {
                let value =
                    (amplitude(-20.0) * (2.0 * PI * 1000.0 * frame as f64 / 96_000.0).sin()) as f32;
                for channel in 0..channels {
                    let sample = if tone.contains(&channel) { value } else { 0.0 };
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
            }
            bytes
        };
        let masked = measure(&mono, &tone(1, &[0]));
        let plain = measure(
            &WavFormat {
                channel_mask: None,
                ..mono
            },
            &tone(1, &[0]),
        );
        assert_eq!(masked, plain);
        let masked = measure(&stereo, &tone(2, &[0, 1]));
        let plain = measure(
            &WavFormat {
                channel_mask: None,
                ..stereo
            },
            &tone(2, &[0, 1]),
        );
        assert_eq!(masked, plain);
    }
}
