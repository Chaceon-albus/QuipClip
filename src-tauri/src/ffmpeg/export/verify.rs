//! The success check of an export that writes no video.
//!
//! ADR 016 lets the frame count, not the exit status, decide whether an export succeeded: ffmpeg
//! exits **zero** when it refuses the reserved file, having written nothing at all. An export
//! without video writes no frames, so that count cannot decide anything for it, and the progress
//! cannot either: an audio-only `-progress` block carries no `frame` key at all, and its
//! `out_time_us` is wrong under `-copyts` (ADR 014 measurement 12).
//!
//! This module holds the check that replaces the count for such an export. `commands::export`
//! runs ffprobe on the finished temporary file ([`crate::ffmpeg::probe::probe_output_audio`]) and
//! passes the answer to [`verify_audio_output`], which requires three facts:
//!
//! 1. exactly one audio stream,
//! 2. no video stream, and
//! 3. a duration within [`AUDIO_DURATION_SHORT_TOLERANCE_MS`] below and
//!    [`AUDIO_DURATION_LONG_TOLERANCE_MS`] above [`super::PlannedAudio::expected_duration`], the
//!    planned duration of the segments.
//!
//! The function is pure, like the rest of the renderer's checks: it runs no process and reads no
//! file, so every outcome is testable without ffmpeg installed.

use crate::ffmpeg::probe::OutputAudioProbe;
use crate::time::Rational;

// Measurement M5, on ffmpeg and ffprobe 9.0.2 on macOS. ADR 014 records the measurement.
//
// The commands were the ones this crate builds: `build_plan` with `ExportStreams::AudioOnly`, then
// `build_filter_graph` and `build_arguments` in both graph shapes, run by a real ffmpeg, read back
// by `probe_output_audio`. The sources were 130 s of 30 fps H.264 with stereo AAC at 44100 Hz and
// at 48000 Hz. Each export cut 1 segment (5.5 s), 3 segments out of source order (9.7 s), or 100
// segments in reversed source order (66.5 s). The encoders were `aac`, `aac_at`, `libopus`,
// `libmp3lame`, `flac` and `alac` (this build has no `libfdk_aac`), each into an `.m4a` (the `mp4`
// muxer, for an MP4 and for a MOV preset) and an `.mka` (the `matroska` muxer). The output rate
// was the source rate, and then 8000, 11025, 16000, 22050, 96000 and 192000 Hz, in stereo and in
// mono. 1044 runs.
//
// - No progress block of an audio-only run carries a `frame` key.
// - The deviation is measured minus planned. The graph shape, the channels, and an MP4 against a
//   MOV preset made no difference at all, and the source rate made at most 3 ms.
//
//   | Output                | At the source rate | Across the whole rate range |
//   | --------------------- | ------------------ | --------------------------- |
//   | `.m4a`, any encoder   | 0 to +0.017 s      | -0.000125 to +0.095 s       |
//   | `.mka`, `flac`/`alac` | 0                  | 0 to +0.004 s               |
//   | `.mka`, `libopus`     | +0.008 s           | +0.007 to +0.011 s          |
//   | `.mka`, `aac`         | +0.021 to +0.023 s | +0.011 to +0.132 s          |
//   | `.mka`, `libmp3lame`  | +0.023 to +0.025 s | +0.023 to +0.142 s          |
//   | `.mka`, `aac_at`      | +0.048 to +0.061 s | +0.048 to +0.324 s          |
//
//   An `.mka` runs long by the encoder's priming and its last, padded frame, which is a number of
//   samples, so the overhang grows as the output rate falls. The worst case was `aac_at` into an
//   `.mka` at 8000 Hz: +0.268 to +0.324 s, about 2100 to 2600 samples. The worst shortfall was
//   0.000125 s, two samples at 16000 Hz.
// - ffmpeg itself refused three cases, and exited non-zero, so the check never ran for them: the
//   `mp4` muxer refuses `libmp3lame` at 8000 and 11025 Hz ("muxing mp3 at 8000hz is not
//   standard"), and `aac_at` refuses 96000 and 192000 Hz. The `mp4` muxer accepts `libmp3lame`
//   from 16000 Hz up.
// - The audio-only cut uses the same `atrim` ticks as an export with video. An export with video
//   can still write different audio: `concat` pads a segment other than the last with silence when
//   its video is longer. Where the source audio covered every segment, in 24 pairs (`flac` into an
//   `.mka` and `alac` into an `.m4a`, both source rates, 1, 3 and 100 segments, both graph
//   shapes), the two decoded to the same samples by MD5.
// - The check fails a truncated output. The command of the first two of the three segments,
//   checked against the plan of all three, measured 7.667 s against 9.700 s. An `.mka` whose
//   ffmpeg was killed reports no duration, and an `.m4a` whose ffmpeg was killed, like an empty
//   reservation, makes ffprobe exit 1, which the check reports as `outputStreamsMismatch`.
// - A source whose audio does not cover a segment gives a correct, shorter output, so the check
//   compares with `PlannedAudio::expected_duration`, and not with the planned duration. In M5
//   that value was the overlap of each segment with the probed extent of the audio stream; M7
//   below changed it for audio that starts late. Four sources, muxed with
//   `-c copy` from 130 s of video: audio that starts 0.3 s late and audio that ends 1 s early, each
//   in an MP4 and an MKV. Segments [0, 2), [60, 62) and [128, 130) s, also with a segment that the
//   audio does not cover at all ([0, 0.2) or [129.3, 129.9)), into `aac` and `flac` `.m4a` and
//   `.mka`, `aac_at` `.m4a` and `libopus` `.mka`: 48 runs. Against the planned duration every run
//   failed, at -0.258 to -1.600 s. Against the overlap every run passed, at -0.021 to +0.021 s.
//   The first two of the three segments, checked against all three, still failed, at -0.979 to
//   -2.000 s. A segment with no audio at all made ffmpeg write nothing for it and exit zero.
//
//   In an MKV, the `DURATION` tag of a stream holds the end of the track and not its length:
//   audio muxed to start at 0.3 s carried `00:02:10.021000000` for 129.721 s of audio. An MP4 of
//   AAC reports the start of the priming samples, 0.278667 s for audio that sounds from 0.3 s,
//   and the output then also holds those 0.021 s.
//
// Measurement M7, on ffmpeg and ffprobe 9.0.2 on macOS, changed the expected duration. The graph
// now starts the audio of each segment at its In point and fills a late start with silence
// (`graph::audio_chain`), so an audio-only export of a source whose audio starts late runs for the
// whole segment. `PlannedAudio::expected_duration` therefore counts each segment that the probed
// extent reaches from its In point to the earlier of its Out point and the end of the stream. A
// segment that the extent does not reach still writes nothing. The sources were 40 s of 30 fps
// H.264 with AAC that starts 0.3 s late or ends 1 s early, in an MP4 and an MKV, at 44100 and
// 48000 Hz. The segments were [0, 2), [20, 22) and [38, 40) s for both; [0, 0.2), [20, 22) and
// [0.1, 2) s, and [10, 12) and [0.25, 2) s, for the late sources; and [36, 40), [39.3, 39.9) and
// [5, 7) s for the early ones, in both graph shapes, into `aac` and `flac` `.m4a` and `.mka`: 160
// runs. Against this value every run measured 0 to
// +0.023 s for the late sources and -0.014 to +0.023 s for the early ones. Against the overlap,
// the late sources measured +0.043 to +0.323 s, which the tolerance below still passes, but
// only by its margin.
//
// ADR 014 measurement 23, on ffmpeg and ffprobe 9.0.2 on macOS, changed the expected duration
// again. Every audio chain of an export without video now ends at the length of its segment
// (`graph::audio_end_pad`), so a segment that the audio ends inside, or does not reach at all,
// writes silence for the rest, and `PlannedAudio::expected_duration` is the planned duration.
// The sources were 40 s of 30 fps H.264 with AAC that starts 3 s or 30 s late, ends at 20 s, or
// has no packets for 0.5 s, in MP4, MKV and MPEG-TS. The plans held a segment wholly before the
// first sample or wholly after the last one, alone and beside a covered segment in both orders,
// a segment that the audio ends inside, and three segments of each kind, in both graph shapes, at
// the source rate and at 48000 Hz, into `aac` `.m4a`, and `aac`, `libopus` and `flac` `.mka`: 592
// runs. Against the planned duration, every run measured -0.0007 to +0.0233 s.
//
// The tolerance below keeps a margin over the worst case on each side. Long: +0.50 s against
// +0.324 s. It also covers an estimate of the worst case for `aac_at` at 8000 Hz that this
// measurement did not reach: the usual AAC priming of 2112 samples and one fully padded frame of
// 1024 samples, 0.392 s. Short: -0.10 s against -0.000125 s. The cut rounds each boundary to the
// nearest sample and each segment resamples on its own, so by estimate 100 segments lose at most
// 25 ms even with a source and an output at 8000 Hz. The rest of the margin is for an encoder that
// drops its last partial frame, which none of the measured encoders did.
//
// The check therefore cannot see every loss. A lost part of the audio passes when it is no longer
// than 0.10 s plus the overhang of the output: about 0.10 s in an `.m4a`, and up to about 0.42 s
// in an `.mka` of `aac_at` at 8000 Hz. The frame count of an export with video has no such gap.

/// How far a finished audio file may fall short of the expected duration, in milliseconds. See
/// measurement M5 above.
pub const AUDIO_DURATION_SHORT_TOLERANCE_MS: i64 = 100;

/// How far a finished audio file may run past the expected duration, in milliseconds. See
/// measurement M5 above.
pub const AUDIO_DURATION_LONG_TOLERANCE_MS: i64 = 500;

/// Why a finished audio file failed [`verify_audio_output`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioOutputMismatch {
    /// The file does not hold exactly one audio stream and no video stream.
    Streams {
        audio_streams: u32,
        video_streams: u32,
    },
    /// The file holds the right streams, and its duration is outside the tolerance, or ffprobe
    /// reported no duration at all (`measured` is `None`).
    Duration {
        measured: Option<Rational>,
        expected: Rational,
    },
}

/// Decide whether the finished file of an export without video holds the audio that was planned.
///
/// `expected` is [`super::PlannedAudio::expected_duration`]: the exact length of audio the
/// segments write, which is their planned duration. The stream set is checked first, because a
/// duration says nothing about a file that holds the wrong streams.
///
/// The comparison is exact. The measured duration is the decimal ffprobe writes, read as a
/// [`Rational`], and the bounds are whole milliseconds, so no step here rounds (ADR 002).
///
/// # Errors
///
/// [`AudioOutputMismatch::Streams`] for a wrong stream set, and
/// [`AudioOutputMismatch::Duration`] for a duration that is absent or outside the tolerance.
pub fn verify_audio_output(
    probe: &OutputAudioProbe,
    expected: Rational,
) -> Result<(), AudioOutputMismatch> {
    if probe.audio_streams != 1 || probe.video_streams != 0 {
        return Err(AudioOutputMismatch::Streams {
            audio_streams: probe.audio_streams,
            video_streams: probe.video_streams,
        });
    }
    let mismatch = AudioOutputMismatch::Duration {
        measured: probe.duration,
        expected,
    };
    let Some(measured) = probe.duration else {
        return Err(mismatch);
    };
    // An overflow cannot happen for a real duration; it reads as a mismatch, never as a pass.
    let within = measured.sub(expected).is_some_and(|deviation| {
        let short = milliseconds(-AUDIO_DURATION_SHORT_TOLERANCE_MS);
        let long = milliseconds(AUDIO_DURATION_LONG_TOLERANCE_MS);
        deviation.sub(short).is_some_and(|value| value.num() >= 0)
            && long.sub(deviation).is_some_and(|value| value.num() >= 0)
    });
    if within {
        Ok(())
    } else {
        Err(mismatch)
    }
}

/// A whole number of milliseconds as an exact number of seconds.
fn milliseconds(value: i64) -> Rational {
    Rational::new(value, 1_000).expect("a whole number of milliseconds is a valid Rational")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seconds(text: &str) -> Rational {
        Rational::from_decimal_str(text).expect("the fixture is a decimal")
    }

    fn probe(audio_streams: u32, video_streams: u32, duration: Option<&str>) -> OutputAudioProbe {
        OutputAudioProbe {
            audio_streams,
            video_streams,
            duration: duration.map(seconds),
        }
    }

    #[test]
    fn one_audio_stream_of_the_planned_duration_passes() {
        assert_eq!(
            verify_audio_output(&probe(1, 0, Some("10.000000")), seconds("10")),
            Ok(())
        );
    }

    #[test]
    fn the_tolerance_is_inclusive_at_both_ends_and_exact_beyond_them() {
        let expected = seconds("10");
        let short = AUDIO_DURATION_SHORT_TOLERANCE_MS;
        let long = AUDIO_DURATION_LONG_TOLERANCE_MS;
        // At each bound, the file passes. One microsecond past it, the file fails: the bounds are
        // compared as exact rationals, so no rounding moves them.
        for (deviation_us, passes) in [
            (-short * 1_000, true),
            (-short * 1_000 - 1, false),
            (long * 1_000, true),
            (long * 1_000 + 1, false),
            (0, true),
        ] {
            let measured = expected
                .add(Rational::new(deviation_us, 1_000_000).unwrap())
                .unwrap();
            let result = verify_audio_output(
                &OutputAudioProbe {
                    audio_streams: 1,
                    video_streams: 0,
                    duration: Some(measured),
                },
                expected,
            );
            assert_eq!(result.is_ok(), passes, "{deviation_us} us");
            if !passes {
                assert_eq!(
                    result,
                    Err(AudioOutputMismatch::Duration {
                        measured: Some(measured),
                        expected,
                    })
                );
            }
        }
    }

    #[test]
    fn a_truncated_file_fails_with_both_durations() {
        // The case the check exists for, beside the empty reservation: ffmpeg exited zero, and
        // the file holds one second of the ten that were planned.
        assert_eq!(
            verify_audio_output(&probe(1, 0, Some("1.000000")), seconds("10")),
            Err(AudioOutputMismatch::Duration {
                measured: Some(seconds("1")),
                expected: seconds("10"),
            })
        );
    }

    #[test]
    fn a_file_with_no_reported_duration_fails() {
        assert_eq!(
            verify_audio_output(&probe(1, 0, None), seconds("10")),
            Err(AudioOutputMismatch::Duration {
                measured: None,
                expected: seconds("10"),
            })
        );
    }

    #[test]
    fn a_wrong_stream_set_fails_before_the_duration_is_read() {
        for (audio, video) in [(0, 0), (2, 0), (1, 1), (0, 1)] {
            assert_eq!(
                verify_audio_output(&probe(audio, video, Some("10.000000")), seconds("10")),
                Err(AudioOutputMismatch::Streams {
                    audio_streams: audio,
                    video_streams: video,
                }),
                "{audio} audio, {video} video"
            );
        }
    }
}
