//! ffmpeg lifecycle support.

pub mod locate;
pub mod probe;

pub use locate::{
    discover, discover_with_path, ExecutableOrigin, FfmpegPaths, InspectedLocation, LocateError,
};
pub use probe::{
    parse_probe_json, probe_media, AudioProbe, MediaProbe, ProbeDataError, ProbeError,
    ProbeParseError,
};
