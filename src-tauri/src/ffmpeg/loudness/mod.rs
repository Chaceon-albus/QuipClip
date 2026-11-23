//! The measurement of the loudness and the true peak of the audio that an export writes (ADR 061).
//!
//! The audio process of an export writes 32-bit float PCM in WAV to its stdout (ADR 043). The
//! measurement reads that stream: [`wav::read_header`] reads its header, and
//! [`meter::LoudnessMeter`] measures its samples with a meter of ITU-R BS.1770-4. The meter runs
//! in Rust, so it gives the same values with each build of FFmpeg that a user installs (ADR 005).
//!
//! [`job::run`] runs the process of one measurement and decides how it ended, and
//! [`registry::LoudnessJobs`] holds the one slot of the measurements. `commands::loudness`
//! prepares a measurement as an export prepares, and owns its two commands.

pub mod job;
pub mod meter;
pub mod registry;
pub mod wav;
