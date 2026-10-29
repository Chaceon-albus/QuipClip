//! The fold of PCM into the buckets of the envelope (ADR 056).
//!
//! Each bucket of [`SAMPLES_PER_BUCKET`] samples keeps two codes of one byte: the peak level and
//! the RMS level. A code is a level in steps of 0.25 dB: code 0 is silence, and code `c` is
//! `c / 4 − 63.75` dBFS, so code 255 is 0 dBFS and code 1 is −63.5 dBFS. The page
//! chooses the scale of the display from these codes, so a change of the display never changes a
//! cached envelope.

use super::SAMPLES_PER_BUCKET;

/// The level of code 0, in dBFS. A code counts quarter decibels above it.
const FLOOR_DB: f64 = -63.75;
/// The count of codes in one decibel.
const CODES_PER_DB: f64 = 4.0;
/// The amplitude of full scale for 16-bit samples.
const FULL_SCALE: f64 = 32_768.0;
/// The amplitude below which a level is silence: half of the smallest step of a 16-bit sample.
const SILENCE: f64 = 0.5;

/// The code of an amplitude between 0 and [`FULL_SCALE`]: 0 for silence, otherwise the level in
/// quarter decibels above −63.75 dBFS, from 1 to 255.
#[must_use]
pub fn level_code(amplitude: f64) -> u8 {
    if amplitude.is_nan() || amplitude < SILENCE {
        return 0;
    }
    let db = 20.0 * (amplitude / FULL_SCALE).log10();
    let code = ((db - FLOOR_DB) * CODES_PER_DB).round();
    // The clamp keeps the cast in range, so it neither truncates nor wraps.
    code.clamp(1.0, 255.0) as u8
}

/// Folds a stream of 16-bit little-endian mono samples into buckets. The stream can arrive in
/// pieces of any length: the folder keeps an odd byte and a partial bucket for the next piece.
#[derive(Debug, Default)]
pub struct EnvelopeFolder {
    odd_byte: Option<u8>,
    count: u32,
    peak: u32,
    sum_of_squares: u64,
}

impl EnvelopeFolder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Folds `bytes` and appends the two codes of each complete bucket to `out`.
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<u8>) {
        let mut rest = bytes;
        if let Some(low) = self.odd_byte.take() {
            let Some((&high, tail)) = rest.split_first() else {
                self.odd_byte = Some(low);
                return;
            };
            self.add(i16::from_le_bytes([low, high]), out);
            rest = tail;
        }
        let (pairs, remainder) = rest.as_chunks::<2>();
        for &pair in pairs {
            self.add(i16::from_le_bytes(pair), out);
        }
        self.odd_byte = remainder.first().copied();
    }

    /// Appends the codes of the last partial bucket, when the stream ended inside one. A last
    /// odd byte is not a sample and is dropped. Returns true when it dropped one, which means
    /// that the stream ended inside a sample.
    pub fn finish(&mut self, out: &mut Vec<u8>) -> bool {
        if self.count > 0 {
            self.emit(out);
        }
        self.odd_byte.take().is_some()
    }

    fn add(&mut self, sample: i16, out: &mut Vec<u8>) {
        // `unsigned_abs` maps `i16::MIN` to 32768, so no sample overflows.
        let magnitude = u32::from(sample.unsigned_abs());
        self.peak = self.peak.max(magnitude);
        self.sum_of_squares += u64::from(magnitude * magnitude);
        self.count += 1;
        if self.count == SAMPLES_PER_BUCKET {
            self.emit(out);
        }
    }

    fn emit(&mut self, out: &mut Vec<u8>) {
        let rms = (self.sum_of_squares as f64 / f64::from(self.count)).sqrt();
        out.push(level_code(f64::from(self.peak)));
        out.push(level_code(rms));
        self.count = 0;
        self.peak = 0;
        self.sum_of_squares = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    fn fold_all(samples: &[i16]) -> Vec<u8> {
        let mut folder = EnvelopeFolder::new();
        let mut out = Vec::new();
        folder.push(&bytes(samples), &mut out);
        assert!(!folder.finish(&mut out));
        out
    }

    #[test]
    fn the_codes_count_quarter_decibels_above_the_floor() {
        assert_eq!(level_code(0.0), 0);
        assert_eq!(level_code(0.49), 0);
        assert_eq!(level_code(f64::NAN), 0);
        // Full scale is 0 dB: (0 + 63.75) × 4 = 255.
        assert_eq!(level_code(32_768.0), 255);
        assert_eq!(level_code(32_767.0), 255);
        // Half scale is −6.02 dB: (−6.0206 + 63.75) × 4 = 230.92.
        assert_eq!(level_code(16_384.0), 231);
        // A level far below the floor keeps code 1, so it never reads as silence.
        assert_eq!(level_code(0.5), 1);
        assert_eq!(level_code(1.0), 1);
    }

    #[test]
    fn silence_folds_to_zero_codes() {
        let out = fold_all(&[0; 160]);
        assert_eq!(out, vec![0, 0, 0, 0]);
    }

    #[test]
    fn a_bucket_keeps_its_peak_and_its_rms() {
        // A square wave at half scale: the peak and the RMS are the same.
        let square: Vec<i16> = (0..80)
            .map(|i| if i % 2 == 0 { 16_384 } else { -16_384 })
            .collect();
        assert_eq!(fold_all(&square), vec![231, 231]);
        // One full-scale sample in silence: the peak is 0 dB, the RMS is 1/√80 of it, −19.03 dB.
        let mut click = vec![0_i16; 80];
        click[40] = i16::MIN;
        assert_eq!(fold_all(&click), vec![255, 179]);
    }

    #[test]
    fn a_sine_has_an_rms_three_decibels_below_its_peak() {
        let sine: Vec<i16> = (0..800)
            .map(|i| {
                let phase = f64::from(i) * 2.0 * std::f64::consts::PI * 1000.0 / 8000.0;
                (phase.sin() * 16_384.0).round() as i16
            })
            .collect();
        let out = fold_all(&sine);
        assert_eq!(out.len(), 20);
        for bucket in out.as_chunks::<2>().0 {
            assert_eq!(bucket[0], 231);
            // −3.01 dB is 12 codes.
            assert_eq!(bucket[0] - bucket[1], 12);
        }
    }

    #[test]
    fn pieces_of_any_length_fold_as_one_stream() {
        let samples: Vec<i16> = (0..1000)
            .map(|i| ((i * 37) % 20_000) as i16 - 10_000)
            .collect();
        let whole = fold_all(&samples);
        let data = bytes(&samples);
        for piece in [1, 3, 7, 160, 161] {
            let mut folder = EnvelopeFolder::new();
            let mut out = Vec::new();
            for chunk in data.chunks(piece) {
                folder.push(chunk, &mut out);
                // An empty piece between two pieces changes nothing, also inside a sample.
                folder.push(&[], &mut out);
            }
            assert!(!folder.finish(&mut out));
            assert_eq!(out, whole, "pieces of {piece} bytes");
        }
    }

    #[test]
    fn the_last_partial_bucket_comes_at_the_finish() {
        let mut folder = EnvelopeFolder::new();
        let mut out = Vec::new();
        folder.push(&bytes(&[16_384; 100]), &mut out);
        assert_eq!(out.len(), 2);
        assert!(!folder.finish(&mut out));
        assert_eq!(out, vec![231, 231, 231, 231]);
        // A finish with no partial bucket adds nothing.
        assert!(!folder.finish(&mut out));
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn a_last_odd_byte_is_dropped() {
        let mut folder = EnvelopeFolder::new();
        let mut out = Vec::new();
        let mut data = bytes(&[16_384; 80]);
        data.push(0x7f);
        folder.push(&data, &mut out);
        assert!(folder.finish(&mut out));
        assert_eq!(out, vec![231, 231]);
    }
}
