//! ffmpeg lifecycle support.

pub mod locate;

pub use locate::{
    discover, discover_with_path, ExecutableOrigin, FfmpegPaths, InspectedLocation, LocateError,
};
