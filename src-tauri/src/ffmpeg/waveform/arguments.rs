//! The command lines of an envelope job (ADR 056).
//!
//! Both forms keep the absolute timestamps with `-copyts` and align the PCM with `aresample`:
//! sample 0 is the sample at `first_pts`. `aresample` adds silence when the audio starts after
//! `first_pts`, and it cuts the audio before `first_pts`. `first_pts` counts samples of the input
//! rate of its filter, so the first `aresample` converts to [`SAMPLE_RATE`] and the second one
//! aligns, as in the PCM of the preview (ADR 046). `min_hard_comp` lowers the drift that `async`
//! accepts before it fills or cuts from the default 100 ms to one bucket, because a job reads
//! hours of audio.
//!
//! FFmpeg runs at `-loglevel info`, because the job reads the line that says that FFmpeg made
//! the filter graph again after a change of the audio format (ADR 056 measurement 4).
//! `-nostats` keeps the progress lines out of that output.

use super::SAMPLE_RATE;
use crate::time::{Pts, Rational};
use std::path::Path;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn pcm_filter(first_pts: i64) -> String {
    format!("aresample={SAMPLE_RATE},aresample=async=1:min_hard_comp=0.01:first_pts={first_pts}")
}

fn push_pcm_output(arguments: &mut Vec<String>, map: &str, first_pts: i64) {
    arguments.extend(["-map".to_owned(), map.to_owned(), "-af".to_owned()]);
    arguments.push(pcm_filter(first_pts));
    arguments.extend(strings(&["-f", "s16le", "-ac", "1", "pipe:1"]));
}

/// The time of `pts` in samples of [`SAMPLE_RATE`]: `pts × time_base × 8000`, rounded to the
/// nearest sample with a half away from zero (ADR 002). The value is negative for a source that
/// starts before 0, and a negative `first_pts` gives silence before the audio (ADR 056
/// measurement 3). `None` when the time base is not positive or the result does not fit.
#[must_use]
pub fn origin_samples(pts: Pts, time_base: Rational) -> Option<i64> {
    if time_base.num() <= 0 {
        return None;
    }
    let numerator = i128::from(pts.value())
        .checked_mul(i128::from(time_base.num()))?
        .checked_mul(i128::from(SAMPLE_RATE))?;
    let denominator = i128::from(time_base.den());
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    let rounded = if remainder.unsigned_abs() * 2 >= denominator.unsigned_abs() {
        quotient + numerator.signum()
    } else {
        quotient
    };
    i64::try_from(rounded).ok()
}

/// The envelope of a file that FFmpeg reads itself, for every container but FLV. `audio_index`
/// is the absolute index of the audio stream that the probe chose, and `first_pts` is the
/// [`origin_samples`] of `videoStartPts`.
#[must_use]
pub fn file_arguments(path: &Path, audio_index: u32, first_pts: i64) -> Vec<String> {
    let mut arguments = strings(&[
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostats",
        "-nostdin",
        "-copyts",
    ]);
    arguments.extend(["-i".to_owned(), path.to_string_lossy().into_owned()]);
    push_pcm_output(&mut arguments, &format!("0:{audio_index}"), first_pts);
    arguments
}

/// The envelope of one run of FLV audio tags, which Rust writes to stdin (ADR 056). The stream
/// on stdin holds audio only, so `0:a:0` is that audio. `first_pts` is the start of the run in
/// samples of [`SAMPLE_RATE`].
#[must_use]
pub fn flv_run_arguments(first_pts: i64) -> Vec<String> {
    let mut arguments = strings(&[
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostats",
        "-f",
        "flv",
        "-copyts",
        "-i",
        "pipe:0",
    ]);
    push_pcm_output(&mut arguments, "0:a:0", first_pts);
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rational(num: i64, den: i64) -> Rational {
        Rational::new(num, den).unwrap()
    }

    #[test]
    fn the_origin_is_the_video_start_in_samples() {
        assert_eq!(origin_samples(Pts::new(0), rational(1, 1000)), Some(0));
        // An FLV whose first frame has a composition offset of 67 ms.
        assert_eq!(origin_samples(Pts::new(67), rational(1, 1000)), Some(536));
        // MPEG-TS at its usual start of 1.4667 s: 11733.33 samples.
        assert_eq!(
            origin_samples(Pts::new(132_000), rational(1, 90_000)),
            Some(11_733)
        );
        // 601.4 s, as with `-output_ts_offset 600`.
        assert_eq!(
            origin_samples(Pts::new(54_126_000), rational(1, 90_000)),
            Some(4_811_200)
        );
    }

    #[test]
    fn a_negative_start_gives_a_negative_origin() {
        assert_eq!(
            origin_samples(Pts::new(-1800), rational(1, 90_000)),
            Some(-160)
        );
    }

    #[test]
    fn a_half_sample_rounds_away_from_zero() {
        // 1/16000 s is half a sample at 8 kHz.
        assert_eq!(origin_samples(Pts::new(1), rational(1, 16_000)), Some(1));
        assert_eq!(origin_samples(Pts::new(-1), rational(1, 16_000)), Some(-1));
        assert_eq!(origin_samples(Pts::new(3), rational(1, 16_000)), Some(2));
        assert_eq!(origin_samples(Pts::new(-3), rational(1, 16_000)), Some(-2));
        // Below a half rounds toward zero.
        assert_eq!(origin_samples(Pts::new(1), rational(1, 24_000)), Some(0));
        assert_eq!(origin_samples(Pts::new(-1), rational(1, 24_000)), Some(0));
    }

    #[test]
    fn an_origin_that_does_not_fit_is_none() {
        assert_eq!(origin_samples(Pts::new(i64::MAX), rational(1, 1)), None);
        assert_eq!(origin_samples(Pts::new(i64::MIN), rational(1, 1)), None);
        assert_eq!(origin_samples(Pts::new(1), rational(-1, 1000)), None);
        assert_eq!(origin_samples(Pts::new(1), rational(0, 1)), None);
        // An overflow of the i128 product itself.
        assert_eq!(
            origin_samples(Pts::new(i64::MAX), rational(i64::MAX, 1)),
            None
        );
    }

    #[test]
    fn a_file_maps_the_chosen_audio_stream_and_keeps_its_timestamps() {
        assert_eq!(
            file_arguments(Path::new("/media/a b.ts"), 2, 11_733).join(" "),
            "-hide_banner -loglevel info -nostats -nostdin -copyts -i /media/a b.ts -map 0:2 \
             -af aresample=8000,aresample=async=1:min_hard_comp=0.01:first_pts=11733 \
             -f s16le -ac 1 pipe:1"
        );
    }

    #[test]
    fn a_negative_origin_passes_as_it_is() {
        let arguments = file_arguments(Path::new("/media/a.mkv"), 1, -4000);
        assert!(arguments
            .iter()
            .any(|argument| argument.ends_with(":first_pts=-4000")));
    }

    #[test]
    fn an_flv_run_reads_audio_tags_from_stdin() {
        assert_eq!(
            flv_run_arguments(320).join(" "),
            "-hide_banner -loglevel info -nostats -f flv -copyts -i pipe:0 -map 0:a:0 \
             -af aresample=8000,aresample=async=1:min_hard_comp=0.01:first_pts=320 \
             -f s16le -ac 1 pipe:1"
        );
    }
}
