//! ffmpeg lifecycle support.

pub mod capabilities;
pub mod export;
pub mod locate;
pub mod probe;

pub use capabilities::{
    license_flags, parse_codec_list, parse_filter_list, parse_hwaccel_list, parse_version,
    Candidate, CodecKind, EncoderStatus, LicenseFlags, ListedCodec, VersionInfo, TESTED_ENCODERS,
};
pub use export::{
    build_plan, ExportErrorCode, ExportPlan, OutputTiming, PathFacts, PathIdentity, PlanRequest,
    PlannedSegment, SegmentBoundary, MAX_EXPORT_SEGMENTS, SEEK_MARGIN_SECONDS,
};
pub use locate::{
    discover, discover_with_path, ExecutableOrigin, FfmpegPaths, InspectedLocation, LocateError,
};
pub use probe::{
    parse_probe_json, probe_media, AudioProbe, MediaProbe, ProbeDataError, ProbeError,
    ProbeParseError,
};
