//! The audio envelope of a source (ADR 056).
//!
//! FFmpeg decodes the audio of the whole file to 8 kHz mono PCM. Rust folds the PCM into buckets
//! of 10 ms, and each bucket keeps a peak level and an RMS level of one byte each. Bucket 0 starts
//! at `videoStartPts`, which is media time 0 of the preview (ADR 046), so bucket `k` holds the
//! time from `k / 100` to `(k + 1) / 100` seconds after the first video frame.

pub mod arguments;
pub mod cache;
pub mod fold;

pub use arguments::{file_arguments, flv_run_arguments, origin_samples};
pub use fold::{level_code, EnvelopeFolder};

/// The sample rate of the PCM that FFmpeg writes.
pub const SAMPLE_RATE: u32 = 8_000;
/// The count of buckets in one second.
pub const BUCKET_RATE: u32 = 100;
/// The count of PCM samples in one bucket.
pub const SAMPLES_PER_BUCKET: u32 = SAMPLE_RATE / BUCKET_RATE;
/// The bytes of one bucket: the peak code, then the RMS code.
pub const BYTES_PER_BUCKET: usize = 2;
