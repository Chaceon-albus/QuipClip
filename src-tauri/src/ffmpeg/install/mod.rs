//! The download and install of `ffmpeg` and `ffprobe` after the consent of the user (ADR 058).
//!
//! [`manifest`] holds the pinned files of each target. [`download`] writes one archive to disk
//! and checks its size and its SHA-256.

pub mod download;
pub mod manifest;
