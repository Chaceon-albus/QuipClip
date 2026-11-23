//! The measurement of the loudness and the true peak of the audio that an export writes (ADR 061).
//!
//! The audio process of an export writes 32-bit float PCM in WAV to its stdout (ADR 043). The
//! measurement reads that stream: [`wav::read_header`] reads its header, and
//! [`meter::LoudnessMeter`] measures its samples with a meter of ITU-R BS.1770-4. The meter runs
//! in Rust, so it gives the same values with each build of FFmpeg that a user installs (ADR 005).

pub mod meter;
pub mod wav;
