//! Document types, validation, and file operations for the application settings file.
//!
//! ADR 013 defines the on-disk shape: `<app_data>/settings.json`, holding an optional ffmpeg
//! path, a list of export presets, and an optional active preset id. This build writes schema
//! version 2 and still reads version 1, the version of the first release; see
//! [`CURRENT_SCHEMA_VERSION`]. The top of this module holds the pure parts of that decision --
//! the serde types and [`validate_settings`] -- with no file I/O. The bottom half holds
//! loading, saving, seeding, restore, reset, the permissive ffmpeg-path accessor, and the
//! read/write lock that coordinates them.

pub mod defaults;

use crate::project::Resolution;
use crate::time::Rational;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

/// The settings schema this build writes; see ADR 013.
///
/// Version 2 adds three preset fields: [`Preset::pixel_format`], [`Preset::video_options`],
/// and [`Preset::audio_options`]. The first release, v0.1.0, fixed the preset shape at
/// version 1 (ADR 023), and its `Preset` refuses an unknown key. A document with the new keys
/// therefore needs a new version, so that v0.1.0 reports a newer file, writes nothing, and the
/// document survives a downgrade (ADR 013).
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// The settings schema of the first release, which [`load`] still reads.
///
/// A version-1 preset holds none of the three version-2 keys. Each one reads as the value that
/// keeps the export of version 1: no encoder options, and the `yuv420p` that the graph wrote
/// as a constant before [`Preset::pixel_format`] existed. The command line of such a preset
/// gains `-pix_fmt yuv420p` only, which names the format the graph already ends in. [`load`]
/// then holds the document as version 2, and the next save writes version 2.
pub const FIRST_RELEASE_SCHEMA_VERSION: u32 = 1;

/// The largest number of presets [`validate_settings`] accepts.
pub const MAX_PRESETS: usize = 100;

/// The largest preset name length, counted in `chars()`, [`validate_settings`] accepts.
pub const MAX_PRESET_NAME_CHARS: usize = 120;

/// The largest resolution dimension, in pixels, [`validate_settings`] accepts on either axis
/// of a [`ResolutionSetting::Custom`] value.
pub const MAX_RESOLUTION_DIMENSION: u32 = 16_384;

/// The largest encoder name length, counted in `chars()`, [`validate_settings`] accepts.
pub const MAX_ENCODER_NAME_CHARS: usize = 64;

/// The smallest [`Preset::audio_bitrate`], in kilobits per second, [`validate_settings`]
/// accepts; see ADR 023.
pub const MIN_AUDIO_BITRATE_KBPS: u32 = 8;

/// The largest [`Preset::audio_bitrate`], in kilobits per second, [`validate_settings`]
/// accepts; see ADR 023.
pub const MAX_AUDIO_BITRATE_KBPS: u32 = 1536;

/// The smallest [`AudioSampleRateSetting::Fixed`] rate, in hertz, [`validate_settings`]
/// accepts; see ADR 023.
pub const MIN_AUDIO_SAMPLE_RATE: u32 = 8_000;

/// The largest [`AudioSampleRateSetting::Fixed`] rate, in hertz, [`validate_settings`]
/// accepts; see ADR 023.
pub const MAX_AUDIO_SAMPLE_RATE: u32 = 192_000;

/// The output sample rate a preset takes when its document holds no `audioSampleRate` key.
///
/// This is the rate ADR 014 wrote into every audio chain as a constant before ADR 023 made it a
/// preset field. A document from before that change must render the same command line as it did
/// then, byte for byte, so the absent key reads as this value and not as `source`.
const LEGACY_AUDIO_SAMPLE_RATE: u32 = 48_000;

/// The smallest [`QualityKind::Cq`] value [`validate_settings`] accepts.
///
/// NVENC reads `-cq 0` as "choose automatically", not as a quality, so the range starts at 1.
pub const MIN_CONSTANT_QUALITY: u32 = 1;

/// The largest [`QualityKind::Cq`] value [`validate_settings`] accepts.
///
/// This is the top of the widest `-cq` range, the one of `av1_nvenc`. `h264_nvenc` and
/// `hevc_nvenc` stop at 51, and ffmpeg refuses a larger value for them with an error. The
/// range is not narrowed for each encoder, for the reason ADR 013 gives about the `crf` range.
pub const MAX_CONSTANT_QUALITY: u32 = 63;

/// The pixel format a preset takes when its document holds no `pixelFormat` key.
///
/// This is the format ADR 014 wrote into the graph as a constant before the preset named one.
pub const DEFAULT_PIXEL_FORMAT: &str = "yuv420p";

/// The largest [`Preset::pixel_format`] length [`validate_settings`] accepts.
pub const MAX_PIXEL_FORMAT_CHARS: usize = 32;

/// The largest number of entries [`validate_settings`] accepts in one of
/// [`Preset::video_options`] and [`Preset::audio_options`].
pub const MAX_PRESET_OPTIONS: usize = 32;

/// The largest [`PresetOption::name`] length [`validate_settings`] accepts.
pub const MAX_OPTION_NAME_CHARS: usize = 64;

/// The largest [`PresetOption::value`] length, counted in `chars()`, [`validate_settings`]
/// accepts.
pub const MAX_OPTION_VALUE_CHARS: usize = 512;

/// The most bytes the encoder options of one preset may add to the command line, for the video
/// list and the audio list together; see [`PresetOption::rendered_bytes`].
///
/// ADR 014 holds the whole command line inside the Windows limit at the segment cap, and the
/// options of a preset are written once, not once for each segment. The test
/// `the_widest_plan_the_settings_permit_still_fits_at_the_segment_cap` in
/// `ffmpeg::export::arguments` measures the widest plan with this many bytes of options.
pub const MAX_PRESET_OPTION_BYTES: usize = 1024;

/// The option names [`validate_settings`] refuses in [`Preset::video_options`] and
/// [`Preset::audio_options`]. The comparison is exact and case-sensitive, as ffmpeg's is.
///
/// `src/features/settings/limits.ts` holds a copy, and `limits.test.ts` reads this list to
/// compare the two.
///
/// The renderer writes each option as two arguments, `-<name>:v <value>` or
/// `-<name>:a <value>`. Two kinds of name break that shape.
///
/// **Options that take no argument.** fftools looks an option up by the part of the name in
/// front of the `:`. An option that takes no argument then leaves the value behind, and ffmpeg
/// reads the value as a second output file: `-shortest:v x` sets `-shortest` and writes a file
/// named `x`. The first four groups are every such option in the fftools tables of the FFmpeg
/// tags n7.1, n7.1.2, n8.0, n8.0.2, n8.1, n9.0, and n9.0.2 (`fftools/opt_common.h` and the
/// `options[]` table of `fftools/ffmpeg_opt.c`): each `OPT_TYPE_BOOL` option, the `no` form that fftools reads for
/// each of them, each `OPT_TYPE_FUNC` option without `OPT_FUNC_ARG`, and each `OPT_EXIT`
/// option, which ends the process. Two names of those tables are not here, `?` and `-help`,
/// because the name rule already refuses them. On FFmpeg 9.0.2, the command-line split of
/// `-<name>:v x`, for every name of those tables, made `x` an output file for exactly each
/// boolean option, each `no` form, `report`, and `vstats`. `qphist` is gone from 9.0, and an
/// `OPT_EXIT` option takes the next argument and then ends the process.
///
/// **Options that QuipClip sets, or that break the export.** The other groups take an argument.
/// Each one sets something that a preset field or the renderer owns, changes the inputs or the
/// timestamps that the cut relies on (ADR 014), changes the frames or the streams that the
/// success checks count (ADR 016, ADR 036), controls the process, or writes a file beside the
/// output. The two group separators `i` and `dec` are here too. A file of options, such as
/// `-fpre`, is refused, because this list cannot check what such a file holds.
///
/// A name outside the fftools tables reaches ffmpeg as an encoder option. With the `:v` or
/// `:a` specifier, ffmpeg looks it up among the encoder options only, and refuses an unknown
/// name with an error. A muxer option, such as `movflags`, can therefore never take effect
/// here; it is listed because QuipClip sets it.
///
/// Two risks remain, and this list does not remove them. A parameter string of an encoder can
/// still write a file, for example `x264-params` with `stats=` and `pass=1`, `x265-params` with
/// `csv=`, or `-flags:v +pass1`, which writes a log in the working directory of ffmpeg. That is
/// the trust that a user already has through the path of ffmpeg. And the list covers FFmpeg up
/// to 9.0.2: a later release can add an option with no argument, whose value then becomes an
/// output file that `-y` overwrites. The check above must run again for each new release of
/// FFmpeg that QuipClip supports.
pub const DENIED_OPTION_NAMES: &[&str] = &[
    // fftools options that print something and end the process (`OPT_EXIT`).
    "L",
    "license",
    "h",
    "help",
    "version",
    "buildconf",
    "formats",
    "muxers",
    "demuxers",
    "devices",
    "codecs",
    "decoders",
    "encoders",
    "bsfs",
    "protocols",
    "filters",
    "pix_fmts",
    "layouts",
    "sample_fmts",
    "dispositions",
    "colors",
    "sources",
    "sinks",
    "hwaccels",
    // fftools functions that take no argument.
    "report",
    "vstats",
    "qphist",
    // fftools boolean options.
    "accurate_seek",
    "an",
    "auto_conversion_filters",
    "autorotate",
    "autoscale",
    "benchmark",
    "benchmark_all",
    "bitexact",
    "copy_unknown",
    "copyinkf",
    "copyts",
    "debug_ts",
    "display_hflip",
    "display_vflip",
    "dn",
    "dump",
    "find_stream_info",
    "fix_sub_duration",
    "fix_sub_duration_heartbeat",
    "force_fps",
    "hex",
    "hide_banner",
    "ignore_unknown",
    "n",
    "print_graphs",
    "re",
    "recast_media",
    "shortest",
    "sn",
    "start_at_zero",
    "stats",
    "stdin",
    "vn",
    "xerror",
    "y",
    // The `no` form of each boolean option, which sets it to false.
    "noaccurate_seek",
    "noan",
    "noauto_conversion_filters",
    "noautorotate",
    "noautoscale",
    "nobenchmark",
    "nobenchmark_all",
    "nobitexact",
    "nocopy_unknown",
    "nocopyinkf",
    "nocopyts",
    "nodebug_ts",
    "nodisplay_hflip",
    "nodisplay_vflip",
    "nodn",
    "nodump",
    "nofind_stream_info",
    "nofix_sub_duration",
    "nofix_sub_duration_heartbeat",
    "noforce_fps",
    "nohex",
    "nohide_banner",
    "noignore_unknown",
    "non",
    "noprint_graphs",
    "nore",
    "norecast_media",
    "noshortest",
    "nosn",
    "nostart_at_zero",
    "nostats",
    "nostdin",
    "novn",
    "noxerror",
    "noy",
    // The group separators of the command line: an input file, and a loopback decoder.
    "i",
    "dec",
    // The streams, the encoders, and the muxer, which the renderer selects.
    "map",
    "map_metadata",
    "map_chapters",
    "c",
    "codec",
    "vcodec",
    "acodec",
    "scodec",
    "dcodec",
    "f",
    "target",
    "attach",
    // Filters. The renderer writes the one filter graph of the export.
    "filter",
    "filter_complex",
    "filter_complex_script",
    "filter_script",
    "filter_threads",
    "filter_complex_threads",
    "filter_hw_device",
    "filter_buffered_frames",
    "lavfi",
    "vf",
    "af",
    // The picture and the sound that preset fields set: size, rate, pixel format, sample
    // rate, channels, aspect, time base, and rotation.
    "s",
    "r",
    "fpsmax",
    "fps_mode",
    "vsync",
    "pix_fmt",
    "ar",
    "ac",
    "ch_layout",
    "channel_layout",
    "apad",
    "aspect",
    "sar",
    "enc_time_base",
    "time_base",
    "display_rotation",
    // The quality control and the bitrates, which the quality kind and the audio bitrate set.
    "b",
    "ab",
    "crf",
    "cq",
    "q",
    "qscale",
    "aq",
    "global_quality",
    // The length of the output and the number of frames, which the success checks count.
    "t",
    "to",
    "ss",
    "sseof",
    "fs",
    "frames",
    "vframes",
    "aframes",
    "dframes",
    "shortest_buf_duration",
    "frame_drop_threshold",
    // The inputs and their timestamps, which the cut relies on.
    "itsoffset",
    "itsscale",
    "stream_loop",
    "readrate",
    "readrate_initial_burst",
    "readrate_catchup",
    "seek_timestamp",
    "isync",
    "dts_delta_threshold",
    "dts_error_threshold",
    "copytb",
    "reinit_filter",
    "drop_changed",
    // The process: its log, its progress report, its time limit, and its exit status.
    "loglevel",
    "v",
    "progress",
    "stats_period",
    "timelimit",
    "max_error_rate",
    // Files beside the output, and files of options.
    "pass",
    "passlogfile",
    "vstats_file",
    "vstats_version",
    "stats_enc_pre",
    "stats_enc_post",
    "stats_mux_pre",
    "stats_enc_pre_fmt",
    "stats_enc_post_fmt",
    "stats_mux_pre_fmt",
    "print_graphs_file",
    "print_graphs_format",
    "sdp_file",
    "dump_attachment",
    "pre",
    "apre",
    "vpre",
    "spre",
    "fpre",
    // The muxer and the packets: muxer flags, metadata, and bitstream filters, which can
    // rewrite timestamps or drop packets after the encoder.
    "movflags",
    "metadata",
    "bsf",
];

// A fourth private copy of the JavaScript `Number.MAX_SAFE_INTEGER` bound. `project/mod.rs`,
// `commands/project.rs`, and `commands/media.rs` each already hold their own; ADR 009 caps a
// commit to one refactor, and hoisting this constant to a shared location is not this
// milestone's refactor.
const JAVASCRIPT_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The application settings document, `<app_data>/settings.json` at
/// [`CURRENT_SCHEMA_VERSION`].
///
/// `ffmpeg_path` and `active_preset_id` are absent from the JSON, never `null`, when they
/// hold no value; see ADR 013. A read still accepts an explicit `null` for either, because
/// `#[serde(default)]` on an `Option` field also accepts a `null` on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// The schema version this document claims. Must equal [`CURRENT_SCHEMA_VERSION`] to
    /// pass [`validate_settings`]. [`load`] reads a document at
    /// [`FIRST_RELEASE_SCHEMA_VERSION`] and returns it at the current version.
    pub schema_version: u32,
    /// The compare-and-swap token [`save`] uses to refuse a save built on a document another
    /// process has already replaced; see ADR 013.
    ///
    /// This is a counter, not a format version. [`validate_settings`] accepts every value:
    /// no revision is invalid. [`SETTINGS_LOCK`] is per-process and therefore cannot order
    /// two processes' writes, so [`save`] compares the revision the caller's document carried
    /// on disk against the revision the file holds now, and writes that value plus one.
    ///
    /// `#[serde(default)]` reads a document written before this field existed as revision 0,
    /// which is also what [`defaults::seeded_settings`] carries, so the first save over such a
    /// file compares 0 against 0 and succeeds. The key is always serialized -- no
    /// `skip_serializing_if` -- so every save from the second onward compares a value that was
    /// really written.
    ///
    /// [`reset`] renames the file aside and writes fresh seeds, but it carries the revision the
    /// moved-aside document held forward, so the count continues across a reset rather than
    /// restarting at 1. It has to: a value the file can hold twice is a value a stale holder
    /// can meet again, and the comparison would accept it.
    ///
    /// One case a counter cannot close: a file deleted outside the application. The next
    /// process creates a file at revision 1, and a copy of QuipClip still holding a document
    /// from revision 1 of the deleted file would be accepted. Closing that needs a per-file
    /// instance nonce, which this field is not; see ADR 013.
    ///
    /// `u32`, not `u64`: the whole range sits inside the JavaScript safe-integer bound, so
    /// this crosses the command boundary as a plain JSON number and needs no canonical-string
    /// encoding of the kind `Pts` requires.
    #[serde(default)]
    pub revision: u32,
    /// An explicit ffmpeg location the user configured, ahead of every other entry in the
    /// ADR 005 resolution order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    /// The user's export presets, in display order.
    pub presets: Vec<Preset>,
    /// The id of the preset the interface currently has selected, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_preset_id: Option<String>,
}

/// One export preset: an identity, a container, two encoder names, three audio output
/// settings, a quality control, three video output settings, and two lists of encoder
/// options.
///
/// The three audio fields arrived with ADR 023, after documents without them already existed.
/// Each one therefore reads an absent key as the behaviour from before ADR 023 -- no `-b:a`,
/// 48000 Hz, stereo -- so an older document renders the same command line as before, byte for
/// byte, and the schema version stayed 1.
///
/// The pixel format and the two option lists arrived with schema version 2, after the first
/// release; see [`CURRENT_SCHEMA_VERSION`]. A version-1 document holds none of them, and each
/// one reads an absent key as the value that keeps the export of version 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    /// A stable identifier that [`Settings::active_preset_id`] references.
    pub id: String,
    /// The display name. Duplicates across presets are legal; the id disambiguates.
    pub name: String,
    /// The output container. The render layer of ADR 004 selects a muxer from this value.
    pub container: Container,
    /// The ffmpeg video encoder name, validated to reach `-c:v` as a codec name only.
    pub video_encoder: String,
    /// The ffmpeg audio encoder name, validated to reach `-c:a` as a codec name only.
    pub audio_encoder: String,
    /// The audio bitrate, in **kilobits per second**, or `None` to leave the audio encoder at
    /// its own default. Valid range [`MIN_AUDIO_BITRATE_KBPS`]`..=`[`MAX_AUDIO_BITRATE_KBPS`].
    ///
    /// The key is absent from the JSON, never `null`, when this holds no value, as for
    /// [`Settings::ffmpeg_path`]. Rust does not know which encoders are lossless (ADR 023): the
    /// renderer writes `-b:a` whenever this holds a value, and the editor clears it for `flac`
    /// and `alac`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_bitrate: Option<u32>,
    /// The output sample rate: the source audio stream's own rate, or an explicit rate.
    ///
    /// Always serialized. An absent key reads as 48000 Hz, the rate ADR 014 fixed before this
    /// field existed; see [`AudioSampleRateSetting`]'s `Default`.
    #[serde(default)]
    pub audio_sample_rate: AudioSampleRateSetting,
    /// The output channel layout: the source audio stream's own layout, stereo, or mono.
    ///
    /// Always serialized. An absent key reads as stereo, the layout ADR 014 fixed before this
    /// field existed; see [`AudioChannels`]'s `Default`.
    #[serde(default)]
    pub audio_channels: AudioChannels,
    /// The quality control and its value.
    pub quality: Quality,
    /// The output resolution: the source resolution, or an explicit width and height.
    pub resolution: ResolutionSetting,
    /// The output frame rate: the source frame rate, or an explicit rational rate.
    pub frame_rate: FrameRateSetting,
    /// The pixel format of the output video, as ffmpeg names it: 1 to
    /// [`MAX_PIXEL_FORMAT_CHARS`] characters from `[a-z0-9_]`.
    ///
    /// The graph converts the joined video to this format in its first chain (ADR 014
    /// measurement 19), and the renderer also writes `-pix_fmt <format>` after `-c:v`, so that
    /// ffmpeg warns when the encoder cannot take the format. That warning shows only in a run
    /// at warning level, such as the test of a preset; the export runs at error level. The
    /// settings module does not know which formats an encoder takes, for the reason ADR 013
    /// gives about quality ranges.
    ///
    /// An absent key reads as [`DEFAULT_PIXEL_FORMAT`]. A save always writes the key.
    #[serde(default = "default_pixel_format")]
    pub pixel_format: String,
    /// Encoder options for the video stream, in the order the renderer writes them.
    ///
    /// The renderer writes each one as `-<name>:v <value>`, after the flags it writes for the
    /// video stream itself; see [`PresetOption`] for the rules each entry follows. An absent
    /// key reads as no options. A save always writes the key.
    #[serde(default)]
    pub video_options: Vec<PresetOption>,
    /// Encoder options for the audio stream, written as `-<name>:a <value>` after the flags
    /// the renderer writes for the audio stream. The rules of [`Self::video_options`] apply.
    #[serde(default)]
    pub audio_options: Vec<PresetOption>,
}

/// The value an absent `pixelFormat` key reads as. A function, because `#[serde(default)]`
/// needs one to build a `String`.
fn default_pixel_format() -> String {
    DEFAULT_PIXEL_FORMAT.to_owned()
}

/// One encoder option of a preset: a name, without its leading `-`, and its value.
///
/// The renderer writes it as two arguments, the flag `-<name>:v` or `-<name>:a` and the
/// value; see [`PresetOption::flag`]. [`validate_settings`] enforces the rules that keep that
/// shape safe:
///
/// - The name holds 1 to [`MAX_OPTION_NAME_CHARS`] characters. It starts with an ASCII letter,
///   and then holds only ASCII letters, digits, `_`, `.`, and `-`. The rule refuses a `:`,
///   which would change the stream specifier, and a `/`, because FFmpeg 7.1 and later read the
///   value of `-/<name>` from a file.
/// - The name is not in [`DENIED_OPTION_NAMES`].
/// - The value holds 1 to [`MAX_OPTION_VALUE_CHARS`] characters, and no NUL, CR, LF or `"`,
///   and it does not end in `\`.
///
/// No shell is involved, so the value reaches ffmpeg as one argument whatever it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetOption {
    /// The option name, without its leading `-` and without a stream specifier.
    pub name: String,
    /// The option value, verbatim.
    pub value: String,
}

impl PresetOption {
    /// The flag argument the renderer writes for this option on `stream`: `-<name>:v` or
    /// `-<name>:a`.
    ///
    /// The specifier keeps a video option off the audio encoder, and an audio option off the
    /// video encoder, because ffmpeg applies a scoped encoder option to the matching streams
    /// only.
    #[must_use]
    pub fn flag(&self, stream: OptionStream) -> String {
        format!("-{}:{}", self.name, stream.specifier())
    }

    /// The bytes this option adds to the command line on `stream`: the flag and the value,
    /// without the separators and quotes the operating system adds around each argument.
    ///
    /// [`MAX_PRESET_OPTION_BYTES`] bounds the sum of this value over both lists of a preset.
    #[must_use]
    pub fn rendered_bytes(&self, stream: OptionStream) -> usize {
        self.flag(stream).len() + self.value.len()
    }
}

/// The stream that one list of [`PresetOption`] values applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionStream {
    Video,
    Audio,
}

impl OptionStream {
    /// The stream specifier the renderer appends to each option name.
    #[must_use]
    pub const fn specifier(self) -> &'static str {
        match self {
            Self::Video => "v",
            Self::Audio => "a",
        }
    }

    /// The wire name of the preset field that holds the list for this stream.
    const fn field(self) -> &'static str {
        match self {
            Self::Video => "videoOptions",
            Self::Audio => "audioOptions",
        }
    }
}

impl fmt::Display for OptionStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.field())
    }
}

/// The output container. The set is closed: the render layer of ADR 004 selects a muxer
/// from this value, and an open set would let an unmuxable value reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Container {
    Mp4,
    Mov,
    Mkv,
}

/// A preset's quality control: a kind and the value that kind interprets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quality {
    pub kind: QualityKind,
    /// The value `kind` interprets. Always non-negative on the wire: a negative value is a
    /// JSON type error, not a [`SettingsValidationError`], and `u32` already fits inside the
    /// JavaScript safe-integer range, so it needs no extra range check of its own.
    pub value: u32,
}

/// The strategy a preset's [`Quality`] uses to control output size or fidelity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityKind {
    /// Constant Rate Factor: lower is higher quality. Valid range `0..=63`.
    Crf,
    /// The constant quality of NVENC, written as `-cq <value> -b:v 0`. Valid range
    /// [`MIN_CONSTANT_QUALITY`]`..=`[`MAX_CONSTANT_QUALITY`].
    ///
    /// `-b:v 0` belongs to the kind: the NVENC encoders set a default bitrate of 2 Mbit/s, and
    /// that bitrate would cap the constant quality.
    Cq,
    /// A fixed bitrate, in **kilobits per second**. Valid range `1..=200_000`.
    Bitrate,
    /// An encoder-defined quality scale. Valid range `1..=100`.
    QualityScale,
}

/// The output resolution: the source video's own resolution, or an explicit width and
/// height.
///
/// The wire shape is the string `"source"` or an object of `w` and `h`. `Serialize` and
/// `Deserialize` are hand-written below with a `Visitor`, not `#[serde(untagged)]`: an
/// untagged enum buffers the value and, on a mismatch, reports "data did not match any
/// variant of untagged enum ...", naming neither the offending field nor the expected shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionSetting {
    /// Keep the source video's resolution; the string `"source"` on the wire.
    Source,
    /// Render at this explicit resolution.
    Custom(Resolution),
}

impl Serialize for ResolutionSetting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Source => serializer.serialize_str("source"),
            Self::Custom(resolution) => resolution.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ResolutionSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ResolutionVisitor;

        impl<'de> de::Visitor<'de> for ResolutionVisitor {
            type Value = ResolutionSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the string \"source\" or an object with `w` and `h`")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "source" {
                    Ok(ResolutionSetting::Source)
                } else {
                    Err(de::Error::invalid_value(de::Unexpected::Str(value), &self))
                }
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                Resolution::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(ResolutionSetting::Custom)
            }
        }

        deserializer.deserialize_any(ResolutionVisitor)
    }
}

/// The output frame rate: the source video's own frame rate, or an explicit rational rate.
///
/// The wire shape is the string `"source"` or an object of `n` and `d`, matching
/// [`ResolutionSetting`]'s hand-written `Visitor` approach and for the same reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameRateSetting {
    /// Keep the source video's frame rate; the string `"source"` on the wire.
    Source,
    /// Render at this explicit rational rate.
    Rate(Rational),
}

impl Serialize for FrameRateSetting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Source => serializer.serialize_str("source"),
            Self::Rate(rate) => rate.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for FrameRateSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FrameRateVisitor;

        impl<'de> de::Visitor<'de> for FrameRateVisitor {
            type Value = FrameRateSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the string \"source\" or an object with `n` and `d`")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "source" {
                    Ok(FrameRateSetting::Source)
                } else {
                    Err(de::Error::invalid_value(de::Unexpected::Str(value), &self))
                }
            }

            fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                Rational::deserialize(de::value::MapAccessDeserializer::new(map))
                    .map(FrameRateSetting::Rate)
            }
        }

        deserializer.deserialize_any(FrameRateVisitor)
    }
}

/// The output sample rate: the source audio stream's own rate, or an explicit rate in hertz.
///
/// The wire shape is the string `"source"` or a JSON integer, matching
/// [`ResolutionSetting`]'s hand-written `Visitor` approach and for the same reason. The range
/// of [`Self::Fixed`] is not checked here: [`validate_settings`] reports it with the preset
/// index, as it does for every other range in this module.
///
/// `Default` is `Fixed(48000)`, not `Source`. It is what an absent `audioSampleRate` key reads
/// as, and 48000 is the rate every export used before ADR 023 made it a setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSampleRateSetting {
    /// Keep the source audio stream's sample rate; the string `"source"` on the wire.
    Source,
    /// Resample to this explicit rate, in hertz. Valid range
    /// [`MIN_AUDIO_SAMPLE_RATE`]`..=`[`MAX_AUDIO_SAMPLE_RATE`].
    Fixed(u32),
}

impl Default for AudioSampleRateSetting {
    fn default() -> Self {
        Self::Fixed(LEGACY_AUDIO_SAMPLE_RATE)
    }
}

impl Serialize for AudioSampleRateSetting {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Source => serializer.serialize_str("source"),
            Self::Fixed(rate) => serializer.serialize_u32(*rate),
        }
    }
}

impl<'de> Deserialize<'de> for AudioSampleRateSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct AudioSampleRateVisitor;

        impl<'de> de::Visitor<'de> for AudioSampleRateVisitor {
            type Value = AudioSampleRateSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("the string \"source\" or an integer sample rate in hertz")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value == "source" {
                    Ok(AudioSampleRateSetting::Source)
                } else {
                    Err(de::Error::invalid_value(de::Unexpected::Str(value), &self))
                }
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                u32::try_from(value)
                    .map(AudioSampleRateSetting::Fixed)
                    .map_err(|_| de::Error::invalid_value(de::Unexpected::Unsigned(value), &self))
            }

            // serde_json reports a negative integer here and a non-negative one through
            // `visit_u64`, but another deserializer may report either sign here.
            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                u32::try_from(value)
                    .map(AudioSampleRateSetting::Fixed)
                    .map_err(|_| de::Error::invalid_value(de::Unexpected::Signed(value), &self))
            }
        }

        deserializer.deserialize_any(AudioSampleRateVisitor)
    }
}

/// The output channel layout: the source audio stream's own layout, stereo, or mono.
///
/// `Source` keeps the source layout, so a 5.1 source stays 5.1 through an encoder that accepts
/// it; ADR 023 measurement 3 found that ffmpeg itself mixes down in front of an encoder that
/// does not. `Default` is `Stereo`, not `Source`, for the reason [`AudioSampleRateSetting`]
/// gives: it is what an absent `audioChannels` key reads as.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioChannels {
    /// Keep the source audio stream's channel layout.
    Source,
    /// Mix to two channels.
    #[default]
    Stereo,
    /// Mix to one channel.
    Mono,
}

/// Which of a [`Preset`]'s two encoder-name fields failed validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetField {
    VideoEncoder,
    AudioEncoder,
}

impl fmt::Display for PresetField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::VideoEncoder => "videoEncoder",
            Self::AudioEncoder => "audioEncoder",
        };
        formatter.write_str(name)
    }
}

impl fmt::Display for QualityKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Crf => "crf",
            Self::Cq => "cq",
            Self::Bitrate => "bitrate",
            Self::QualityScale => "qualityScale",
        };
        formatter.write_str(name)
    }
}

/// A structurally valid settings document whose values violate an ADR 013 invariant.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsValidationError {
    SchemaVersion {
        found: u32,
        expected: u32,
    },
    TooManyPresets {
        count: usize,
    },
    EmptyPresetId {
        index: usize,
    },
    DuplicatePresetId {
        index: usize,
    },
    EmptyPresetName {
        index: usize,
    },
    PresetNameTooLong {
        index: usize,
        chars: usize,
    },
    /// The render layer of ADR 004 builds `-c:v <name>` (or `-c:a <name>`) with no shell in
    /// between, so a name outside `[0-9A-Za-z_.-]`, or one that does not start with an
    /// alphanumeric character, could reach ffmpeg as an extra argument rather than as a
    /// codec name. This is why the frontend cannot be trusted with an encoder name: Rust
    /// validates it here instead.
    InvalidEncoderName {
        index: usize,
        field: PresetField,
    },
    AudioBitrateOutOfRange {
        index: usize,
        value: u32,
    },
    AudioSampleRateOutOfRange {
        index: usize,
        value: u32,
    },
    QualityOutOfRange {
        index: usize,
        kind: QualityKind,
        value: u32,
    },
    InvalidResolution {
        index: usize,
    },
    InvalidFrameRate {
        index: usize,
    },
    /// [`Preset::pixel_format`] is empty, longer than [`MAX_PIXEL_FORMAT_CHARS`], or holds a
    /// character outside `[a-z0-9_]`. The graph writes the name into a filter, so a `:`, `,`,
    /// `;`, or `[` would change the graph.
    InvalidPixelFormat {
        index: usize,
    },
    /// One option list of the preset at `index` holds more than [`MAX_PRESET_OPTIONS`]
    /// entries.
    TooManyOptions {
        index: usize,
        stream: OptionStream,
        count: usize,
    },
    /// The name of option `option` breaks the character rule of [`PresetOption`].
    InvalidOptionName {
        index: usize,
        stream: OptionStream,
        option: usize,
    },
    /// The name of option `option` is in [`DENIED_OPTION_NAMES`].
    DeniedOptionName {
        index: usize,
        stream: OptionStream,
        option: usize,
    },
    /// The name of option `option` repeats the name of an earlier option of the same list.
    DuplicateOptionName {
        index: usize,
        stream: OptionStream,
        option: usize,
    },
    /// The value of option `option` is empty, longer than [`MAX_OPTION_VALUE_CHARS`], holds a
    /// NUL, a CR, an LF or a `"`, or ends in `\`.
    InvalidOptionValue {
        index: usize,
        stream: OptionStream,
        option: usize,
    },
    /// The two option lists of the preset at `index` render more than
    /// [`MAX_PRESET_OPTION_BYTES`]. `stream` names the list whose option passed the limit.
    OptionsTooLong {
        index: usize,
        stream: OptionStream,
        bytes: usize,
    },
    UnsafeInteger {
        field: String,
        value: i128,
    },
    UnknownActivePreset {
        preset_id: String,
    },
    InvalidFfmpegPath,
}

impl fmt::Display for SettingsValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SchemaVersion { found, expected } => write!(
                formatter,
                "schemaVersion must be {expected} when saving, but was {found}"
            ),
            Self::TooManyPresets { count } => write!(
                formatter,
                "presets holds {count} entries, more than the {MAX_PRESETS} allowed"
            ),
            Self::EmptyPresetId { index } => write!(formatter, "presets[{index}].id is empty"),
            Self::DuplicatePresetId { index } => {
                write!(formatter, "presets[{index}].id is duplicated")
            }
            Self::EmptyPresetName { index } => {
                write!(formatter, "presets[{index}].name is blank")
            }
            Self::PresetNameTooLong { index, chars } => write!(
                formatter,
                "presets[{index}].name holds {chars} characters, more than the {MAX_PRESET_NAME_CHARS} allowed"
            ),
            Self::InvalidEncoderName { index, field } => write!(
                formatter,
                "presets[{index}].{field} is not a valid encoder name"
            ),
            Self::AudioBitrateOutOfRange { index, value } => write!(
                formatter,
                "presets[{index}].audioBitrate {value} is out of range {MIN_AUDIO_BITRATE_KBPS}..={MAX_AUDIO_BITRATE_KBPS}"
            ),
            Self::AudioSampleRateOutOfRange { index, value } => write!(
                formatter,
                "presets[{index}].audioSampleRate {value} is out of range {MIN_AUDIO_SAMPLE_RATE}..={MAX_AUDIO_SAMPLE_RATE}"
            ),
            Self::QualityOutOfRange { index, kind, value } => write!(
                formatter,
                "presets[{index}].quality.value {value} is out of range for {kind}"
            ),
            Self::InvalidResolution { index } => {
                write!(formatter, "presets[{index}].resolution is invalid")
            }
            Self::InvalidFrameRate { index } => {
                write!(formatter, "presets[{index}].frameRate is invalid")
            }
            Self::InvalidPixelFormat { index } => {
                write!(formatter, "presets[{index}].pixelFormat is not a valid pixel format name")
            }
            Self::TooManyOptions {
                index,
                stream,
                count,
            } => write!(
                formatter,
                "presets[{index}].{stream} holds {count} entries, more than the {MAX_PRESET_OPTIONS} allowed"
            ),
            Self::InvalidOptionName {
                index,
                stream,
                option,
            } => write!(
                formatter,
                "presets[{index}].{stream}[{option}].name is not a valid option name"
            ),
            Self::DeniedOptionName {
                index,
                stream,
                option,
            } => write!(
                formatter,
                "presets[{index}].{stream}[{option}].name names an option QuipClip does not accept"
            ),
            Self::DuplicateOptionName {
                index,
                stream,
                option,
            } => write!(
                formatter,
                "presets[{index}].{stream}[{option}].name repeats an earlier option"
            ),
            Self::InvalidOptionValue {
                index,
                stream,
                option,
            } => write!(
                formatter,
                "presets[{index}].{stream}[{option}].value is empty, too long, or holds a line break or a NUL"
            ),
            Self::OptionsTooLong {
                index,
                stream,
                bytes,
            } => write!(
                formatter,
                "presets[{index}].{stream} takes the options of the preset to {bytes} bytes, more than the {MAX_PRESET_OPTION_BYTES} allowed"
            ),
            Self::UnsafeInteger { field, value } => write!(
                formatter,
                "{field} value {value} is outside the JavaScript safe integer range"
            ),
            Self::UnknownActivePreset { preset_id } => write!(
                formatter,
                "activePresetId {preset_id:?} does not name a preset"
            ),
            Self::InvalidFfmpegPath => write!(formatter, "ffmpegPath is invalid"),
        }
    }
}

impl Error for SettingsValidationError {}

/// Validate a settings document against every ADR 013 invariant serde's types do not already
/// enforce.
///
/// Structural correctness -- field presence, camelCase keys, the `"source"` keyword shapes,
/// and a positive rational denominator -- is already guaranteed by the time a `Settings`
/// value exists, because deserialization rejects a structurally invalid document before this
/// function ever runs. This function checks what remains: the schema version, preset id and
/// name shape, the encoder-name security rule, the audio bitrate and sample rate ranges, the
/// quality and resolution ranges, the safe-integer bounds on a custom frame rate, the pixel
/// format name, the rules of each encoder option and the limits of the two option lists, and
/// the two cross-references
/// (`active_preset_id` naming a preset, and every preset id being unique).
///
/// [`Settings::revision`] is deliberately not checked. It is a compare-and-swap counter, not a
/// format version, so no value of it is invalid; [`save`] is what compares it.
pub fn validate_settings(settings: &Settings) -> Result<(), SettingsValidationError> {
    if settings.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(SettingsValidationError::SchemaVersion {
            found: settings.schema_version,
            expected: CURRENT_SCHEMA_VERSION,
        });
    }
    if settings.presets.len() > MAX_PRESETS {
        return Err(SettingsValidationError::TooManyPresets {
            count: settings.presets.len(),
        });
    }

    let mut preset_ids = HashSet::new();
    for (index, preset) in settings.presets.iter().enumerate() {
        if preset.id.trim().is_empty() {
            return Err(SettingsValidationError::EmptyPresetId { index });
        }
        if !preset_ids.insert(preset.id.as_str()) {
            return Err(SettingsValidationError::DuplicatePresetId { index });
        }

        let trimmed_name = preset.name.trim();
        if trimmed_name.is_empty() {
            return Err(SettingsValidationError::EmptyPresetName { index });
        }
        let name_chars = trimmed_name.chars().count();
        if name_chars > MAX_PRESET_NAME_CHARS {
            return Err(SettingsValidationError::PresetNameTooLong {
                index,
                chars: name_chars,
            });
        }

        if !is_valid_encoder_name(&preset.video_encoder) {
            return Err(SettingsValidationError::InvalidEncoderName {
                index,
                field: PresetField::VideoEncoder,
            });
        }
        if !is_valid_encoder_name(&preset.audio_encoder) {
            return Err(SettingsValidationError::InvalidEncoderName {
                index,
                field: PresetField::AudioEncoder,
            });
        }

        // ADR 023 bounds both audio values for the reason ADR 013 gives about quality ranges:
        // the bounds stop a fault in the interface from storing a value no encoder can use.
        // They are not narrowed for each encoder, because a preset can name an encoder this
        // machine does not have.
        if let Some(bitrate) = preset.audio_bitrate {
            if !(MIN_AUDIO_BITRATE_KBPS..=MAX_AUDIO_BITRATE_KBPS).contains(&bitrate) {
                return Err(SettingsValidationError::AudioBitrateOutOfRange {
                    index,
                    value: bitrate,
                });
            }
        }
        if let AudioSampleRateSetting::Fixed(rate) = preset.audio_sample_rate {
            if !(MIN_AUDIO_SAMPLE_RATE..=MAX_AUDIO_SAMPLE_RATE).contains(&rate) {
                return Err(SettingsValidationError::AudioSampleRateOutOfRange {
                    index,
                    value: rate,
                });
            }
        }

        if !is_valid_quality(preset.quality) {
            return Err(SettingsValidationError::QualityOutOfRange {
                index,
                kind: preset.quality.kind,
                value: preset.quality.value,
            });
        }

        if let ResolutionSetting::Custom(resolution) = preset.resolution {
            if !(1..=MAX_RESOLUTION_DIMENSION).contains(&resolution.w)
                || !(1..=MAX_RESOLUTION_DIMENSION).contains(&resolution.h)
            {
                return Err(SettingsValidationError::InvalidResolution { index });
            }
        }

        if let FrameRateSetting::Rate(rate) = preset.frame_rate {
            validate_safe_integer(
                &format!("presets[{index}].frameRate.n"),
                i128::from(rate.num()),
            )?;
            validate_safe_integer(
                &format!("presets[{index}].frameRate.d"),
                i128::from(rate.den()),
            )?;
            if rate.num() <= 0 {
                return Err(SettingsValidationError::InvalidFrameRate { index });
            }
        }

        if !is_valid_pixel_format(&preset.pixel_format) {
            return Err(SettingsValidationError::InvalidPixelFormat { index });
        }

        validate_options(index, OptionStream::Video, &preset.video_options)?;
        validate_options(index, OptionStream::Audio, &preset.audio_options)?;
        let video_bytes = option_list_bytes(OptionStream::Video, &preset.video_options);
        let bytes = video_bytes + option_list_bytes(OptionStream::Audio, &preset.audio_options);
        if bytes > MAX_PRESET_OPTION_BYTES {
            // The renderer writes the video options first, so the audio list passes the limit
            // unless the video list already does on its own.
            let stream = if video_bytes > MAX_PRESET_OPTION_BYTES {
                OptionStream::Video
            } else {
                OptionStream::Audio
            };
            return Err(SettingsValidationError::OptionsTooLong {
                index,
                stream,
                bytes,
            });
        }
    }

    if let Some(active_preset_id) = &settings.active_preset_id {
        if !preset_ids.contains(active_preset_id.as_str()) {
            return Err(SettingsValidationError::UnknownActivePreset {
                preset_id: active_preset_id.clone(),
            });
        }
    }

    if let Some(ffmpeg_path) = &settings.ffmpeg_path {
        if ffmpeg_path.trim().is_empty() || ffmpeg_path.contains('\0') {
            return Err(SettingsValidationError::InvalidFfmpegPath);
        }
    }

    Ok(())
}

/// Check an encoder name against the ADR 013 character rule: 1 to
/// [`MAX_ENCODER_NAME_CHARS`] characters from `[0-9A-Za-z_.-]`, starting with an
/// alphanumeric character.
fn is_valid_encoder_name(name: &str) -> bool {
    let char_count = name.chars().count();
    if !(1..=MAX_ENCODER_NAME_CHARS).contains(&char_count) {
        return false;
    }
    let starts_alphanumeric = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric());
    starts_alphanumeric
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Check a quality value against the range its kind defines.
fn is_valid_quality(quality: Quality) -> bool {
    match quality.kind {
        QualityKind::Crf => quality.value <= 63,
        QualityKind::Cq => (MIN_CONSTANT_QUALITY..=MAX_CONSTANT_QUALITY).contains(&quality.value),
        QualityKind::Bitrate => (1..=200_000).contains(&quality.value),
        QualityKind::QualityScale => (1..=100).contains(&quality.value),
    }
}

/// Check a pixel format name: 1 to [`MAX_PIXEL_FORMAT_CHARS`] characters from `[a-z0-9_]`,
/// the characters of every name `ffmpeg -pix_fmts` lists.
fn is_valid_pixel_format(name: &str) -> bool {
    (1..=MAX_PIXEL_FORMAT_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Check an option name against the character rule of [`PresetOption`]: an ASCII letter, then
/// up to [`MAX_OPTION_NAME_CHARS`]` - 1` ASCII letters, digits, `_`, `.`, or `-`.
///
/// Every character of a valid name is ASCII, so the byte length is the character count.
fn is_valid_option_name(name: &str) -> bool {
    (1..=MAX_OPTION_NAME_CHARS).contains(&name.len())
        && name
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Check an option value: 1 to [`MAX_OPTION_VALUE_CHARS`] characters, with no NUL, CR, LF or
/// `"`, and no `\` at its end.
///
/// A NUL cannot cross into a process argument at all. A line break is refused so that the
/// option lists, shown as text, keep each option on one line. The last two rules keep the
/// command line budget exact on Windows: there the argument quoting writes each `"` as `\"`
/// and doubles the backslashes in front of it, and it doubles the backslashes at the end of an
/// argument that it puts in quotes. Without a `"` and a final `\`, an argument costs its
/// bytes plus at most three, which is what `command_line_length` counts. No encoder setting
/// needs either character, and a parameter string takes its own separators.
fn is_valid_option_value(value: &str) -> bool {
    (1..=MAX_OPTION_VALUE_CHARS).contains(&value.chars().count())
        && !value.contains(['\0', '\r', '\n', '"'])
        && !value.ends_with('\\')
}

/// Check one option list of the preset at `index`: its length, then each entry in order.
fn validate_options(
    index: usize,
    stream: OptionStream,
    options: &[PresetOption],
) -> Result<(), SettingsValidationError> {
    if options.len() > MAX_PRESET_OPTIONS {
        return Err(SettingsValidationError::TooManyOptions {
            index,
            stream,
            count: options.len(),
        });
    }
    let mut names = HashSet::new();
    for (option_index, option) in options.iter().enumerate() {
        if !is_valid_option_name(&option.name) {
            return Err(SettingsValidationError::InvalidOptionName {
                index,
                stream,
                option: option_index,
            });
        }
        if DENIED_OPTION_NAMES.contains(&option.name.as_str()) {
            return Err(SettingsValidationError::DeniedOptionName {
                index,
                stream,
                option: option_index,
            });
        }
        if !names.insert(option.name.as_str()) {
            return Err(SettingsValidationError::DuplicateOptionName {
                index,
                stream,
                option: option_index,
            });
        }
        if !is_valid_option_value(&option.value) {
            return Err(SettingsValidationError::InvalidOptionValue {
                index,
                stream,
                option: option_index,
            });
        }
    }
    Ok(())
}

/// The bytes one option list adds to the command line on `stream`; see
/// [`PresetOption::rendered_bytes`].
fn option_list_bytes(stream: OptionStream, options: &[PresetOption]) -> usize {
    options
        .iter()
        .map(|option| option.rendered_bytes(stream))
        .sum()
}

/// Reject a value outside the JavaScript safe-integer range, mirroring `project`'s
/// `UnsafeInteger` treatment.
fn validate_safe_integer(field: &str, value: i128) -> Result<(), SettingsValidationError> {
    let bound = i128::from(JAVASCRIPT_MAX_SAFE_INTEGER);
    if !(-bound..=bound).contains(&value) {
        return Err(SettingsValidationError::UnsafeInteger {
            field: field.to_owned(),
            value,
        });
    }
    Ok(())
}

/// The settings file's name inside the application data directory; see ADR 013.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// The fixed backup name [`reset`] moves a damaged settings file to.
///
/// ADR 013 uses one fixed name rather than a timestamped one, so a machine that gets reset
/// repeatedly does not accumulate an unbounded number of backup files in the application data
/// directory; each reset simply overwrites the previous backup.
pub const INVALID_SETTINGS_FILE_NAME: &str = "settings.invalid.json";

/// A failure to read, validate, or save the settings document.
///
/// This mirrors [`crate::project::ProjectFileError`] with one addition, [`Self::Unreadable`]:
/// ADR 013 requires [`save`] to refuse to overwrite a settings file it cannot read back, so
/// that a transient or partial read failure never masks the loss of an entire preset library.
#[derive(Debug)]
pub enum SettingsFileError {
    Io(io::Error),
    Json(serde_json::Error),
    Validation(SettingsValidationError),
    FutureSchemaVersion {
        found: u64,
        supported: u32,
    },
    /// [`save`] refused to write because the file that already exists at the destination
    /// could not be read back. The bytes on disk are left exactly as they were.
    Unreadable,
    /// [`save`] refused to write because the document the caller edited is no longer the
    /// document on disk: another window or another QuipClip process saved in between. The
    /// bytes on disk are left exactly as they were, so the other change is not lost.
    ///
    /// `expected` is the revision the caller's document carried, and `found` is the revision
    /// the file holds now. Both are a Rust-side diagnostic: the command layer drops them, the
    /// way serde's message is dropped for [`Self::Json`], because the only recovery is to
    /// reload and re-apply the edit and no number changes that.
    Conflict {
        expected: u32,
        found: u32,
    },
    /// [`reset`] failed to rename the existing settings file to [`INVALID_SETTINGS_FILE_NAME`]
    /// before writing fresh seeds, for a reason other than the file being absent.
    ///
    /// This is kept separate from [`Self::Io`] so that `commands::settings::map_reset_error`
    /// can report a rename failure as `backupFailed` while every other I/O failure `reset` can
    /// raise -- inside the `save_locked` call that follows a successful rename -- goes through
    /// the same `permissionDenied`/`readFailed`/`writeFailed` mapping every other command uses.
    Backup(io::Error),
}

impl fmt::Display for SettingsFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "settings file I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "settings JSON is invalid: {error}"),
            Self::Validation(error) => write!(formatter, "settings values are invalid: {error}"),
            Self::FutureSchemaVersion { found, supported } => write!(
                formatter,
                "settings schema version {found} is newer than supported version {supported}"
            ),
            Self::Unreadable => write!(
                formatter,
                "the existing settings file could not be read; refusing to overwrite it"
            ),
            Self::Conflict { expected, found } => write!(
                formatter,
                "the settings file moved from revision {expected} to revision {found} after this copy loaded it; refusing to overwrite it"
            ),
            Self::Backup(error) => write!(formatter, "settings backup failed: {error}"),
        }
    }
}

impl Error for SettingsFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Validation(error) => Some(error),
            Self::FutureSchemaVersion { .. } | Self::Unreadable | Self::Conflict { .. } => None,
            Self::Backup(error) => Some(error),
        }
    }
}

impl From<io::Error> for SettingsFileError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for SettingsFileError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<SettingsValidationError> for SettingsFileError {
    fn from(error: SettingsValidationError) -> Self {
        Self::Validation(error)
    }
}

/// A probe of just the `schemaVersion` field, read before full deserialization so a future
/// document is reported by its version rather than as an opaque JSON error. This mirrors
/// `project::SchemaEnvelope` exactly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaEnvelope {
    schema_version: u64,
}

/// A narrow, permissive probe of the settings file used by [`configured_ffmpeg_path`]: the
/// schema version and the ffmpeg path, with every other key ignored.
///
/// This deliberately does NOT derive `deny_unknown_fields`, unlike [`Settings`]. [`Settings`]
/// must stay strict, because a permissive load could silently accept a document the rest of
/// the application cannot trust. This probe exists for the opposite reason: it must survive
/// damage anywhere else in the document, so it looks at nothing but these two fields.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegPathProbe {
    schema_version: u64,
    #[serde(default)]
    ffmpeg_path: Option<String>,
}

/// A narrow, permissive probe of just the `revision` field, used by [`reset`] to carry the
/// count across the rename that moves the old document aside.
///
/// Permissive for the same reason [`FfmpegPathProbe`] is, and more urgently: the document
/// [`reset`] moves aside is usually the one the strict [`load`] refused, so a reader that
/// insisted on a whole valid [`Settings`] would find no revision to continue from in exactly
/// the case [`reset`] exists for. It ignores `schemaVersion` too: a document from a later
/// build still counts its saves with this same field, and a revision is not less true for
/// sitting beside keys this build does not know.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionProbe {
    #[serde(default)]
    revision: u32,
}

/// One process-wide lock over the settings file's write path.
///
/// Process-wide is all it is. Two QuipClip processes take two separate `Mutex` values, so this
/// lock cannot order their writes at all; [`Settings::revision`] and the compare-and-swap in
/// [`save_locked`] are what stop process B's save from silently discarding process A's presets.
///
/// [`save`], [`restore_default_presets`], and [`reset`] each take this lock exactly once and
/// then do their work through a private `*_locked` helper or by calling [`load`] (which takes
/// no lock of its own). `std::sync::Mutex` is not reentrant, so a function that took this lock
/// and then called the public [`save`] would deadlock against itself; none of them do.
///
/// A poisoned lock is recovered with `PoisonError::into_inner`, the same recovery
/// `ffmpeg::capabilities::cache::CACHE_LOCK` and `ffmpeg::capabilities::smoke::SMOKE_LOCK`
/// use: a writer that panics while holding this lock must not permanently disable settings
/// persistence for the rest of the process's life.
///
/// [`load`] and [`configured_ffmpeg_path`] take no lock at all. [`save`] finishes with an
/// atomic rename (see [`crate::fsutil::write_bytes_atomically`]), so a reader always observes
/// either the whole previous file or the whole new one, never a torn write. Taking the lock
/// for a read would serialize every read behind a slow write and would add a second path to a
/// deadlock, with no correctness benefit to show for it.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// The result of [`load`]: the document, and whether it came from the seed table because no
/// file existed yet.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSettings {
    pub settings: Settings,
    pub seeded: bool,
}

/// Load and validate the settings document from `app_data_directory`.
///
/// Three outcomes, per ADR 013:
/// - the file is absent (`io::ErrorKind::NotFound`): this returns
///   [`defaults::seeded_settings`] with `seeded: true`, and creates neither the file nor
///   `app_data_directory` itself. A read with a write side effect would make tests
///   order-dependent, and it would turn a first-run permission problem into a confusing
///   startup error that has nothing to do with settings.
/// - the file exists and validates: this returns it with `seeded: false`.
/// - the file is corrupt, fails validation, or is otherwise unreadable: this returns `Err`.
///
/// A `schemaVersion` above [`CURRENT_SCHEMA_VERSION`] is caught by a [`SchemaEnvelope`] probe
/// read before the full document deserializes, exactly as `project::load` does, so a document
/// from a later build is reported by its version rather than as an opaque JSON error.
///
/// A document at [`FIRST_RELEASE_SCHEMA_VERSION`] is returned at [`CURRENT_SCHEMA_VERSION`],
/// with the defaults of the keys version 2 added. The file stays as it is until a save.
///
/// This takes no lock; see [`SETTINGS_LOCK`] for why.
pub fn load(app_data_directory: &Path) -> Result<LoadedSettings, SettingsFileError> {
    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LoadedSettings {
                settings: defaults::seeded_settings(),
                seeded: true,
            });
        }
        Err(error) => return Err(SettingsFileError::Io(error)),
    };

    let envelope: SchemaEnvelope = serde_json::from_slice(&bytes)?;
    if envelope.schema_version > u64::from(CURRENT_SCHEMA_VERSION) {
        return Err(SettingsFileError::FutureSchemaVersion {
            found: envelope.schema_version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    let mut settings: Settings = serde_json::from_slice(&bytes)?;
    // A document of the first release reads as the current version. Its presets have none of
    // the keys that version 2 added, and the defaults of those keys keep the export of version
    // 1 (see `FIRST_RELEASE_SCHEMA_VERSION`). Nothing is written here: the next save writes
    // version 2.
    if settings.schema_version == FIRST_RELEASE_SCHEMA_VERSION {
        settings.schema_version = CURRENT_SCHEMA_VERSION;
    }
    validate_settings(&settings)?;
    Ok(LoadedSettings {
        settings,
        seeded: false,
    })
}

/// Validate and save `settings` to `app_data_directory`, refusing to overwrite a file this
/// build cannot read back, or one another process has replaced since the caller loaded it, and
/// return the document that reached disk.
///
/// This is the data-loss guard and the single most important behaviour in this module. A
/// capability cache miss (see `ffmpeg::capabilities::cache`) costs one extra probe on the
/// next launch; a lost preset library costs the user work that nothing can rebuild. So, after
/// validating the new document, this re-reads whatever currently exists at the destination
/// through the strict [`load`] -- the same reader a later launch would use -- before writing
/// anything:
/// - nothing exists yet ([`load`]'s "no file" outcome): proceed.
/// - [`load`] succeeds: proceed when the revision it read equals the revision `settings`
///   carries, and return [`SettingsFileError::Conflict`] otherwise.
/// - [`load`] fails for any reason -- corrupt JSON, a failed [`validate_settings`], or a
///   schema version above [`CURRENT_SCHEMA_VERSION`] -- return [`SettingsFileError::Unreadable`]
///   and leave the bytes on disk exactly as they were. ADR 013 requires this: a document a
///   later build wrote, or one with a damaged preset a hand edit could still recover, must
///   survive an older build's save instead of being silently overwritten with seeds. Checking
///   only "is this JSON" would miss both cases, so the guard reuses the strict reader rather
///   than re-implementing a weaker check of its own.
///
/// **`settings.revision` is the basis of the caller's edit, not the value that gets written.**
/// A caller hands this the document it loaded and edited, carrying the revision that document
/// had on disk. This writes that revision plus one, and the return value is the only place the
/// new revision appears: a caller that needs it must read it from there, never from the value
/// it sent.
///
/// `app_data_directory` is created first when it does not exist yet.
pub fn save(app_data_directory: &Path, settings: &Settings) -> Result<Settings, SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    save_locked(app_data_directory, settings, None)
}

/// The body of [`save`], factored out so [`restore_default_presets`] and [`reset`] can reuse
/// it while already holding [`SETTINGS_LOCK`], without calling the public [`save`] and
/// deadlocking on the non-reentrant `Mutex`.
///
/// This calls [`load`] directly rather than the public [`save`] to run its overwrite guard:
/// [`load`] takes no lock of its own (see [`SETTINGS_LOCK`]), so calling it here is safe even
/// though [`save_locked`] already holds the lock.
///
/// That one read answers both questions this function has to ask: whether the existing file is
/// readable at all, and whether it is still the document the caller based its edit on. The
/// compare-and-swap therefore costs no extra syscall. It also uses no filesystem fact:
/// HFS+ records mtime at one-second granularity and SMB/FAT at two, so two saves inside one
/// tick would be indistinguishable -- which is exactly the race being defended against -- an
/// NTP step moves mtime backwards, and the file size is blind to a rename of equal length.
///
/// `previous_life_revision` is for [`reset`] alone, which removes the file and then writes into
/// the missing path: it names the revision the removed document held, so the count continues
/// instead of restarting at a value the file has held before. Every other caller passes `None`,
/// which means "a first save here starts the count at 1".
fn save_locked(
    app_data_directory: &Path,
    settings: &Settings,
    previous_life_revision: Option<u32>,
) -> Result<Settings, SettingsFileError> {
    validate_settings(settings)?;

    let found_revision = match load(app_data_directory) {
        // No file exists yet, so there is nothing a comparison could protect. A first save
        // ignores the caller's revision entirely.
        Ok(loaded) if loaded.seeded => None,
        Ok(loaded) => Some(loaded.settings.revision),
        Err(SettingsFileError::Io(error)) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return Err(SettingsFileError::Unreadable),
    };

    let next_revision = match found_revision {
        // A genuine first save starts at 1. When the caller names the revision this file's
        // previous life ended at, the count continues from there instead, so no revision is
        // reused across the rename that ended that life.
        None => previous_life_revision.map_or(1, |previous| previous.wrapping_add(1)),
        // `wrapping_add`, not `saturating_add`. Neither is reachable at 4.29 billion saves,
        // but a saturated counter would stop changing at the top, and a revision that never
        // changes silently disables this comparison for the rest of the file's life. Wrapping
        // keeps every save a change.
        Some(found) if found == settings.revision => found.wrapping_add(1),
        Some(found) => {
            return Err(SettingsFileError::Conflict {
                expected: settings.revision,
                found,
            });
        }
    };

    // The written document differs from the validated one only in `revision`, and
    // `validate_settings` accepts every revision, so validating the input above covers this.
    let written = Settings {
        revision: next_revision,
        ..settings.clone()
    };

    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    fs::create_dir_all(app_data_directory)?;
    let json = crate::fsutil::to_pretty_json_line(&written)?;
    crate::fsutil::write_bytes_atomically(&path, &json)?;
    Ok(written)
}

/// Restore every seeded default preset, keeping every other preset, `ffmpegPath`, and
/// `activePresetId` intact, then save.
///
/// For each seed in [`defaults::default_presets`], this replaces the preset with that id in
/// place when one exists, or appends the seed when it is absent. It never rebuilds the
/// document from the seed table: doing so would silently discard every user-added preset and
/// would clear the `ffmpegPath` the user just configured, which is exactly the mistake ADR
/// 013 calls out by name. When `activePresetId` is absent afterwards and the preset list is
/// non-empty, this sets it to the first seed so restoring presets from an empty library still
/// leaves one selected.
///
/// This needs no compare-and-swap handling of its own. It carries the whole document it loaded
/// forward into [`save_locked`], so [`Settings::revision`] rides along inside that document and
/// the comparison compares the value this function really read -- which is precisely why the
/// token lives in the document rather than beside it as a second argument. The return value is
/// [`save_locked`]'s, so it carries the bumped revision rather than the one that was read.
pub fn restore_default_presets(app_data_directory: &Path) -> Result<Settings, SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);

    let mut settings = load(app_data_directory)?.settings;
    for seed in defaults::default_presets() {
        match settings
            .presets
            .iter_mut()
            .find(|preset| preset.id == seed.id)
        {
            Some(existing) => *existing = seed,
            None => settings.presets.push(seed),
        }
    }
    if settings.active_preset_id.is_none() {
        if let Some(first) = settings.presets.first() {
            settings.active_preset_id = Some(first.id.clone());
        }
    }

    save_locked(app_data_directory, &settings, None)
}

/// Move a damaged settings file aside and write fresh seeds.
///
/// This renames the existing file to [`INVALID_SETTINGS_FILE_NAME`] in the same directory --
/// one fixed backup name, so app data does not grow without bound across repeated resets --
/// then writes [`defaults::seeded_settings`]. When the rename itself fails for a reason other
/// than the source file being absent, this returns that error and writes nothing, leaving the
/// original file in place. A missing settings file is not an error: it is treated the same as
/// [`load`]'s "no file yet" outcome, and this simply writes the seeds.
///
/// The revision the moved-aside document held is read BEFORE the rename and carried into the
/// save, so the count continues across the reset. Restarting at 1 would make 1 a value the
/// file holds twice, and a copy of QuipClip still holding a document from before the reset
/// would then pass the comparison and undo it; see [`Settings::revision`]. The read is
/// permissive ([`RevisionProbe`]), because the document being reset is usually one the strict
/// [`load`] refused.
pub fn reset(app_data_directory: &Path) -> Result<Settings, SettingsFileError> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);

    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let previous_life_revision = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RevisionProbe>(&bytes).ok())
        .map(|probe| probe.revision);

    let backup_path = app_data_directory.join(INVALID_SETTINGS_FILE_NAME);
    // A plain `fs::rename`, and therefore exempt from the read-only refusal ADR 015 puts in
    // `fsutil::replace_file_within`: a rename needs permission on the directory, not on the file,
    // so a settings file the user protected is still moved aside here. ADR 013's "A reset is
    // exempt from the read-only refusal" records that this is deliberate. `reset` is the only
    // escape from a settings file this build cannot read, and it is reachable only after a load
    // has already failed, so a refusal here would leave the user with no route back except
    // deleting the file from a terminal -- the dead end this recovery action exists to prevent.
    // Do not route this through the guarded helper. The `save_locked` below, which writes the
    // fresh document, does go through it.
    match fs::rename(&path, &backup_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(SettingsFileError::Backup(error)),
    }

    // The `save_locked` below reaches its "no file" arm on purpose: the rename above has just
    // moved the old document aside, so nothing is left for a compare-and-swap to protect, and
    // `previous_life_revision` rather than the file is what continues the count.
    //
    // One race remains. If another process creates a file between the rename and that read,
    // the seeds carry revision 0 while a first save writes 1, so `save_locked` almost always
    // reports a `Conflict` -- which is honest, and a second reset succeeds. "Almost": a save
    // that wraps at `u32::MAX` writes 0, and against that one file this reset would compare
    // 0 against 0 and write the seeds instead of refusing. That costs the other process's
    // write, not the user's library, and it needs 4.29 billion saves to reach.
    let settings = defaults::seeded_settings();
    save_locked(app_data_directory, &settings, previous_life_revision)
}

/// The configured ffmpeg path, or `None` for any problem reading it.
///
/// This is the permissive counterpart to the strict [`load`]/[`save`] surface described in
/// [`FfmpegPathProbe`]. It reads the same settings file, but through that narrow probe, which
/// ignores every key except `schemaVersion` and `ffmpegPath`. A missing file, an unreadable
/// file, corrupt JSON, an absent `ffmpegPath` key, a blank or NUL-bearing path, or a
/// `schemaVersion` above [`CURRENT_SCHEMA_VERSION`] are all `None`, never an error. The NUL
/// check mirrors [`validate_settings`]'s own [`SettingsValidationError::InvalidFfmpegPath`]
/// rule, so this permissive probe never reports a path the strict [`load`] would reject.
///
/// Every version up to the current one is read, so a version-1 file that no save has upgraded
/// yet still gives its path. The key has the same meaning in both versions.
///
/// This exists so that ffmpeg discovery survives a damaged preset. Without it, one malformed
/// preset entry anywhere in `presets` would fail strict deserialization of the whole
/// [`Settings`] document, costing the user their configured ffmpeg path along with it, and the
/// application would report "ffmpeg missing" for a reason that has nothing to do with ffmpeg.
/// The strict surface ([`load`], [`save`]) stays exactly as strict as it is for everything
/// that writes the file; when this probe falls back to `None`, discovery simply degrades to
/// `PATH` and the application data directory, which is exactly the behaviour from before
/// settings existed at all.
///
/// This takes no lock, for the same reason [`load`] does not: [`save`] replaces the file with
/// an atomic rename, so a reader here always observes a whole file, never a torn one.
pub fn configured_ffmpeg_path(app_data_directory: &Path) -> Option<PathBuf> {
    let path = app_data_directory.join(SETTINGS_FILE_NAME);
    let bytes = fs::read(path).ok()?;
    let probe: FfmpegPathProbe = serde_json::from_slice(&bytes).ok()?;
    if probe.schema_version > u64::from(CURRENT_SCHEMA_VERSION) {
        return None;
    }
    let ffmpeg_path = probe.ffmpeg_path?;
    if ffmpeg_path.trim().is_empty() || ffmpeg_path.contains('\0') {
        return None;
    }
    Some(PathBuf::from(ffmpeg_path))
}

/// A settings file as the first release, v0.1.0, writes it on macOS: schema version 1, its
/// three seeds, one preset of the user's own, and a configured ffmpeg path. Tests here and in
/// `commands::export` read it as the file a user upgrades from.
#[cfg(test)]
pub(crate) const VERSION_1_FIXTURE: &str = r#"{
  "schemaVersion": 1,
  "revision": 7,
  "ffmpegPath": "/opt/homebrew/bin",
  "presets": [
    {
      "id": "default-h264-mp4",
      "name": "H.264 MP4",
      "container": "mp4",
      "videoEncoder": "libx264",
      "audioEncoder": "aac",
      "audioBitrate": 320,
      "audioSampleRate": "source",
      "audioChannels": "source",
      "quality": { "kind": "crf", "value": 20 },
      "resolution": "source",
      "frameRate": "source"
    },
    {
      "id": "default-hevc-mp4",
      "name": "HEVC MP4",
      "container": "mp4",
      "videoEncoder": "libx265",
      "audioEncoder": "aac",
      "audioBitrate": 320,
      "audioSampleRate": "source",
      "audioChannels": "source",
      "quality": { "kind": "crf", "value": 24 },
      "resolution": "source",
      "frameRate": "source"
    },
    {
      "id": "default-videotoolbox-mp4",
      "name": "H.264 MP4 (hardware)",
      "container": "mp4",
      "videoEncoder": "h264_videotoolbox",
      "audioEncoder": "aac",
      "audioBitrate": 320,
      "audioSampleRate": "source",
      "audioChannels": "source",
      "quality": { "kind": "bitrate", "value": 12000 },
      "resolution": "source",
      "frameRate": "source"
    },
    {
      "id": "user-prores",
      "name": "ProRes for the editor",
      "container": "mov",
      "videoEncoder": "prores_ks",
      "audioEncoder": "alac",
      "audioSampleRate": 48000,
      "audioChannels": "stereo",
      "quality": { "kind": "qualityScale", "value": 9 },
      "resolution": { "w": 1920, "h": 1080 },
      "frameRate": { "n": 30000, "d": 1001 }
    }
  ],
  "activePresetId": "user-prores"
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_preset(id: &str) -> Preset {
        Preset {
            id: id.to_owned(),
            name: "H.264 MP4".to_owned(),
            container: Container::Mp4,
            video_encoder: "libx264".to_owned(),
            audio_encoder: "aac".to_owned(),
            audio_bitrate: None,
            audio_sample_rate: AudioSampleRateSetting::Fixed(48_000),
            audio_channels: AudioChannels::Stereo,
            quality: Quality {
                kind: QualityKind::Crf,
                value: 20,
            },
            resolution: ResolutionSetting::Source,
            frame_rate: FrameRateSetting::Source,
            pixel_format: DEFAULT_PIXEL_FORMAT.to_owned(),
            video_options: vec![],
            audio_options: vec![],
        }
    }

    fn option(name: &str, value: &str) -> PresetOption {
        PresetOption {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }

    /// A preset as a document written before ADR 023 holds it: none of the three audio keys.
    fn pre_adr_023_preset_json() -> serde_json::Value {
        serde_json::json!({
            "id": "preset-1",
            "name": "Sample",
            "container": "mp4",
            "videoEncoder": "libx264",
            "audioEncoder": "aac",
            "quality": {"kind": "crf", "value": 20},
            "resolution": "source",
            "frameRate": "source",
        })
    }

    /// A document at revision 0, the value a first save compares against and the value
    /// `defaults::seeded_settings` carries. A test that needs a saved revision reads it from
    /// what `save` returned, never from a literal it built.
    fn sample_settings(presets: Vec<Preset>) -> Settings {
        Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            revision: 0,
            ffmpeg_path: None,
            presets,
            active_preset_id: None,
        }
    }

    #[test]
    fn settings_json_uses_camel_case_and_the_decided_keyword_shapes() {
        let source_preset = sample_preset("source-preset");
        let mut custom_preset = sample_preset("custom-preset");
        custom_preset.resolution = ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 });
        custom_preset.frame_rate = FrameRateSetting::Rate(Rational::new(30000, 1001).unwrap());

        let settings = Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            revision: 7,
            ffmpeg_path: Some("/opt/homebrew/bin/ffmpeg".to_owned()),
            presets: vec![source_preset, custom_preset],
            active_preset_id: Some("source-preset".to_owned()),
        };

        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["schemaVersion"], serde_json::json!(2));
        assert_eq!(value["revision"], serde_json::json!(7));
        assert_eq!(
            value["presets"][0]["videoEncoder"],
            serde_json::json!("libx264")
        );
        assert_eq!(value["presets"][0]["container"], serde_json::json!("mp4"));
        assert_eq!(
            value["presets"][0]["quality"],
            serde_json::json!({"kind": "crf", "value": 20})
        );
        assert_eq!(
            value["presets"][0]["resolution"],
            serde_json::json!("source")
        );
        assert_eq!(
            value["presets"][0]["frameRate"],
            serde_json::json!("source")
        );
        assert_eq!(
            value["presets"][1]["resolution"],
            serde_json::json!({"w": 1920, "h": 1080})
        );
        assert_eq!(
            value["presets"][1]["frameRate"],
            serde_json::json!({"n": 30000, "d": 1001})
        );
        assert_eq!(value["activePresetId"], serde_json::json!("source-preset"));
    }

    #[test]
    fn an_unset_ffmpeg_path_and_active_preset_are_absent_not_null() {
        let settings = sample_settings(vec![]);
        let value = serde_json::to_value(&settings).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("ffmpegPath"));
        assert!(!object.contains_key("activePresetId"));
    }

    #[test]
    fn a_null_ffmpeg_path_still_deserializes_as_unset() {
        let json = r#"{"schemaVersion":1,"ffmpegPath":null,"presets":[],"activePresetId":null}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.ffmpeg_path, None);
        assert_eq!(settings.active_preset_id, None);
    }

    #[test]
    fn absent_optional_keys_deserialize_as_unset() {
        // `ffmpegPath` and `activePresetId` are absent entirely here, not `null`. Only
        // `#[serde(default)]` lets this document -- the module's own serialized output for
        // an unset value, per `an_unset_ffmpeg_path_and_active_preset_are_absent_not_null`
        // -- load at all.
        let json = r#"{"schemaVersion":1,"presets":[]}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.ffmpeg_path, None);
        assert_eq!(settings.active_preset_id, None);
    }

    #[test]
    fn a_settings_value_with_unset_optionals_round_trips_through_json() {
        let settings = sample_settings(vec![]);
        let json = serde_json::to_string(&settings).unwrap();
        let round_tripped: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped, settings);
    }

    #[test]
    fn an_unknown_resolution_keyword_names_the_expected_value() {
        let error = serde_json::from_str::<ResolutionSetting>(r#""src""#).unwrap_err();
        assert!(error.to_string().contains("source"), "message was: {error}");
    }

    #[test]
    fn rejects_an_unknown_field_on_settings() {
        let json = r#"{"schemaVersion":1,"presets":[],"bogus":true}"#;
        let error = serde_json::from_str::<Settings>(json).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_unknown_field_on_preset() {
        let value = serde_json::json!({
            "id": "preset-1",
            "name": "Sample",
            "container": "mp4",
            "videoEncoder": "libx264",
            "audioEncoder": "aac",
            "quality": {"kind": "crf", "value": 20},
            "resolution": "source",
            "frameRate": "source",
            "bogus": true,
        });
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_unknown_field_on_quality() {
        let value = serde_json::json!({"kind": "crf", "value": 20, "bogus": true});
        let error = serde_json::from_value::<Quality>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_misspelled_resolution_field_is_reported_as_an_unknown_field() {
        let error = serde_json::from_str::<ResolutionSetting>(r#"{"width":1920,"height":1080}"#)
            .unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_misspelled_frame_rate_field_is_reported_as_an_unknown_field() {
        let error = serde_json::from_str::<FrameRateSetting>(r#"{"num":30,"den":1}"#).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );
    }

    #[test]
    fn a_zero_denominator_frame_rate_is_rejected_by_the_inner_rational() {
        let error = serde_json::from_str::<FrameRateSetting>(r#"{"n":30,"d":0}"#).unwrap_err();
        assert!(
            error.to_string().contains("invalid rational"),
            "message was: {error}"
        );
    }

    #[test]
    fn rejects_an_encoder_name_that_could_be_read_as_an_ffmpeg_flag() {
        let names: Vec<String> = vec![
            "-f".to_owned(),
            "libx264 -y".to_owned(),
            "lib;rm".to_owned(),
            String::new(),
            ".hidden".to_owned(),
            "_lead".to_owned(),
            "a".repeat(MAX_ENCODER_NAME_CHARS + 1),
        ];
        for field in [PresetField::VideoEncoder, PresetField::AudioEncoder] {
            for name in &names {
                let mut preset = sample_preset("preset-1");
                match field {
                    PresetField::VideoEncoder => preset.video_encoder = name.clone(),
                    PresetField::AudioEncoder => preset.audio_encoder = name.clone(),
                }
                let error = validate_settings(&sample_settings(vec![preset])).unwrap_err();
                assert!(
                    matches!(
                        error,
                        SettingsValidationError::InvalidEncoderName { field: error_field, .. }
                            if error_field == field
                    ),
                    "field {field:?}, name {name:?}: got {error:?}"
                );
            }
        }
    }

    #[test]
    fn accepts_the_encoder_names_the_capability_probe_reports() {
        for name in [
            "libx264",
            "h264_videotoolbox",
            "libsvtav1",
            "aac",
            "aac_at",
            "libopus",
            "libmp3lame",
            "flac",
            "alac",
        ] {
            let mut preset = sample_preset("preset-1");
            preset.video_encoder = name.to_owned();
            preset.audio_encoder = name.to_owned();
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected {name}"
            );
        }
    }

    #[test]
    fn resolution_and_frame_rate_source_and_custom_round_trip() {
        let resolution_source = ResolutionSetting::Source;
        let json = serde_json::to_string(&resolution_source).unwrap();
        assert_eq!(
            serde_json::from_str::<ResolutionSetting>(&json).unwrap(),
            resolution_source
        );

        let resolution_custom = ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 });
        let json = serde_json::to_string(&resolution_custom).unwrap();
        assert_eq!(
            serde_json::from_str::<ResolutionSetting>(&json).unwrap(),
            resolution_custom
        );

        let frame_rate_source = FrameRateSetting::Source;
        let json = serde_json::to_string(&frame_rate_source).unwrap();
        assert_eq!(
            serde_json::from_str::<FrameRateSetting>(&json).unwrap(),
            frame_rate_source
        );

        let frame_rate_custom = FrameRateSetting::Rate(Rational::new(30, 1).unwrap());
        let json = serde_json::to_string(&frame_rate_custom).unwrap();
        assert_eq!(
            serde_json::from_str::<FrameRateSetting>(&json).unwrap(),
            frame_rate_custom
        );
    }

    // -- The three ADR 023 audio fields. --

    #[test]
    fn a_preset_without_the_audio_keys_reads_as_the_behaviour_from_before_adr_023() {
        // ADR 023: an older document must render the same command line as before, byte for
        // byte, so each absent key reads as the value the renderer used to hard-code -- no
        // `-b:a`, 48000 Hz, stereo -- and never as `source`.
        let preset: Preset = serde_json::from_value(pre_adr_023_preset_json()).unwrap();
        assert_eq!(preset.audio_bitrate, None);
        assert_eq!(
            preset.audio_sample_rate,
            AudioSampleRateSetting::Fixed(48_000)
        );
        assert_eq!(preset.audio_channels, AudioChannels::Stereo);
        assert_eq!(
            AudioSampleRateSetting::default(),
            AudioSampleRateSetting::Fixed(48_000)
        );
        assert_eq!(AudioChannels::default(), AudioChannels::Stereo);
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn a_saved_preset_always_writes_the_rate_and_channels_and_omits_an_unset_bitrate() {
        let mut preset = sample_preset("preset-1");
        let value = serde_json::to_value(&preset).unwrap();
        let object = value.as_object().unwrap();
        assert!(!object.contains_key("audioBitrate"), "{value}");
        assert_eq!(value["audioSampleRate"], serde_json::json!(48_000));
        assert_eq!(value["audioChannels"], serde_json::json!("stereo"));

        preset.audio_bitrate = Some(320);
        preset.audio_sample_rate = AudioSampleRateSetting::Source;
        preset.audio_channels = AudioChannels::Source;
        let value = serde_json::to_value(&preset).unwrap();
        assert_eq!(value["audioBitrate"], serde_json::json!(320));
        assert_eq!(value["audioSampleRate"], serde_json::json!("source"));
        assert_eq!(value["audioChannels"], serde_json::json!("source"));
    }

    #[test]
    fn a_null_audio_bitrate_still_deserializes_as_unset() {
        // The same tolerance `ffmpegPath` has: `#[serde(default)]` on an `Option` also accepts
        // an explicit `null`, so the interface can clear the value either way.
        let mut value = pre_adr_023_preset_json();
        value["audioBitrate"] = serde_json::Value::Null;
        let preset: Preset = serde_json::from_value(value).unwrap();
        assert_eq!(preset.audio_bitrate, None);
    }

    #[test]
    fn every_audio_value_round_trips_through_a_preset() {
        for bitrate in [None, Some(MIN_AUDIO_BITRATE_KBPS), Some(320), Some(1536)] {
            for sample_rate in [
                AudioSampleRateSetting::Source,
                AudioSampleRateSetting::Fixed(44_100),
                AudioSampleRateSetting::Fixed(MAX_AUDIO_SAMPLE_RATE),
            ] {
                for channels in [
                    AudioChannels::Source,
                    AudioChannels::Stereo,
                    AudioChannels::Mono,
                ] {
                    let mut preset = sample_preset("preset-1");
                    preset.audio_bitrate = bitrate;
                    preset.audio_sample_rate = sample_rate;
                    preset.audio_channels = channels;
                    let json = serde_json::to_string(&preset).unwrap();
                    assert_eq!(
                        serde_json::from_str::<Preset>(&json).unwrap(),
                        preset,
                        "{json}"
                    );
                }
            }
        }
    }

    #[test]
    fn audio_sample_rate_reads_the_word_source_or_an_integer() {
        assert_eq!(
            serde_json::from_str::<AudioSampleRateSetting>(r#""source""#).unwrap(),
            AudioSampleRateSetting::Source
        );
        assert_eq!(
            serde_json::from_str::<AudioSampleRateSetting>("44100").unwrap(),
            AudioSampleRateSetting::Fixed(44_100)
        );
        assert_eq!(
            serde_json::to_string(&AudioSampleRateSetting::Source).unwrap(),
            r#""source""#
        );
        assert_eq!(
            serde_json::to_string(&AudioSampleRateSetting::Fixed(96_000)).unwrap(),
            "96000"
        );
    }

    #[test]
    fn a_wrong_audio_sample_rate_shape_names_the_expectation() {
        // The reason for the hand-written `Visitor`: an untagged enum would report "data did not
        // match any variant" and name neither the field nor the expected shape.
        for json in [
            r#""src""#,
            r#""48000""#,
            "48000.5",
            "-1",
            "4294967296",
            r#"{"hz": 48000}"#,
            "[48000]",
            "true",
        ] {
            let error = serde_json::from_str::<AudioSampleRateSetting>(json).unwrap_err();
            let message = error.to_string();
            assert!(
                message.contains("\"source\"") && message.contains("integer sample rate"),
                "{json}: {message}"
            );
        }
    }

    #[test]
    fn a_null_audio_sample_rate_is_rejected_with_the_expected_shape() {
        // `audioBitrate` accepts an explicit `null` as unset, but `audioSampleRate` has no unset
        // value: only an absent key reads as the default. A `null` is a wrong shape.
        let error = serde_json::from_str::<AudioSampleRateSetting>("null").unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("\"source\"") && message.contains("integer sample rate"),
            "message was: {message}"
        );

        let mut value = pre_adr_023_preset_json();
        value["audioSampleRate"] = serde_json::Value::Null;
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("\"source\"") && message.contains("integer sample rate"),
            "message was: {message}"
        );
    }

    #[test]
    fn a_capitalized_source_sample_rate_is_rejected_with_the_expected_shape() {
        // The word is matched exactly, as `audioChannels` matches its words.
        let error = serde_json::from_str::<AudioSampleRateSetting>(r#""Source""#).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("\"source\"") && message.contains("integer sample rate"),
            "message was: {message}"
        );

        let mut value = pre_adr_023_preset_json();
        value["audioSampleRate"] = serde_json::json!("Source");
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("\"source\"") && message.contains("integer sample rate"),
            "message was: {message}"
        );
    }

    #[test]
    fn audio_channels_round_trip_and_an_unknown_word_is_rejected() {
        for (channels, wire) in [
            (AudioChannels::Source, "source"),
            (AudioChannels::Stereo, "stereo"),
            (AudioChannels::Mono, "mono"),
        ] {
            let json = serde_json::to_string(&channels).unwrap();
            assert_eq!(json, format!("\"{wire}\""), "channels were: {channels:?}");
            assert_eq!(
                serde_json::from_str::<AudioChannels>(&json).unwrap(),
                channels
            );
        }

        for json in [r#""surround""#, r#""Stereo""#, r#""5.1""#, "2"] {
            assert!(
                serde_json::from_str::<AudioChannels>(json).is_err(),
                "accepted {json}"
            );
        }
        let mut value = pre_adr_023_preset_json();
        value["audioChannels"] = serde_json::json!("surround");
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown variant"),
            "message was: {error}"
        );
    }

    #[test]
    fn enforces_the_audio_bitrate_bounds() {
        for bitrate in [
            None,
            Some(MIN_AUDIO_BITRATE_KBPS),
            Some(MAX_AUDIO_BITRATE_KBPS),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.audio_bitrate = bitrate;
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected {bitrate:?}"
            );
        }

        for bitrate in [0, MIN_AUDIO_BITRATE_KBPS - 1, MAX_AUDIO_BITRATE_KBPS + 1] {
            let mut preset = sample_preset("preset-1");
            preset.audio_bitrate = Some(bitrate);
            let other = sample_preset("preset-0");
            assert_eq!(
                validate_settings(&sample_settings(vec![other, preset])),
                Err(SettingsValidationError::AudioBitrateOutOfRange {
                    index: 1,
                    value: bitrate
                })
            );
        }
    }

    #[test]
    fn enforces_the_audio_sample_rate_bounds_and_accepts_source() {
        for sample_rate in [
            AudioSampleRateSetting::Source,
            AudioSampleRateSetting::Fixed(MIN_AUDIO_SAMPLE_RATE),
            AudioSampleRateSetting::Fixed(MAX_AUDIO_SAMPLE_RATE),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.audio_sample_rate = sample_rate;
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected {sample_rate:?}"
            );
        }

        for rate in [0, MIN_AUDIO_SAMPLE_RATE - 1, MAX_AUDIO_SAMPLE_RATE + 1] {
            let mut preset = sample_preset("preset-1");
            preset.audio_sample_rate = AudioSampleRateSetting::Fixed(rate);
            let other = sample_preset("preset-0");
            assert_eq!(
                validate_settings(&sample_settings(vec![other, preset])),
                Err(SettingsValidationError::AudioSampleRateOutOfRange {
                    index: 1,
                    value: rate
                })
            );
        }
    }

    #[test]
    fn the_audio_ranges_are_the_ones_adr_023_states() {
        // The frontend holds its own copy of these bounds (ADR 023), so both sides pin them.
        assert_eq!(MIN_AUDIO_BITRATE_KBPS, 8);
        assert_eq!(MAX_AUDIO_BITRATE_KBPS, 1536);
        assert_eq!(MIN_AUDIO_SAMPLE_RATE, 8_000);
        assert_eq!(MAX_AUDIO_SAMPLE_RATE, 192_000);
    }

    #[test]
    fn the_audio_range_errors_name_the_field_and_the_value() {
        let bitrate = SettingsValidationError::AudioBitrateOutOfRange {
            index: 3,
            value: 2000,
        }
        .to_string();
        assert!(
            bitrate.contains("presets[3].audioBitrate") && bitrate.contains("2000"),
            "message was: {bitrate}"
        );
        let sample_rate = SettingsValidationError::AudioSampleRateOutOfRange {
            index: 4,
            value: 7_999,
        }
        .to_string();
        assert!(
            sample_rate.contains("presets[4].audioSampleRate") && sample_rate.contains("7999"),
            "message was: {sample_rate}"
        );
    }

    #[test]
    fn rejects_a_quality_value_outside_its_kinds_range() {
        for (kind, value) in [(QualityKind::Crf, 0), (QualityKind::Crf, 63)] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality { kind, value };
            assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
        }

        for (kind, value) in [
            (QualityKind::Crf, 64),
            (QualityKind::Bitrate, 0),
            (QualityKind::QualityScale, 101),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality { kind, value };
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::QualityOutOfRange { .. })
            ));
        }
    }

    #[test]
    fn enforces_the_bitrate_and_quality_scale_bounds() {
        let mut at_bitrate_cap = sample_preset("preset-1");
        at_bitrate_cap.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 200_000,
        };
        assert!(validate_settings(&sample_settings(vec![at_bitrate_cap])).is_ok());

        let mut over_bitrate_cap = sample_preset("preset-1");
        over_bitrate_cap.quality = Quality {
            kind: QualityKind::Bitrate,
            value: 200_001,
        };
        assert!(matches!(
            validate_settings(&sample_settings(vec![over_bitrate_cap])),
            Err(SettingsValidationError::QualityOutOfRange { .. })
        ));

        let mut min_quality_scale = sample_preset("preset-1");
        min_quality_scale.quality = Quality {
            kind: QualityKind::QualityScale,
            value: 1,
        };
        assert!(validate_settings(&sample_settings(vec![min_quality_scale])).is_ok());

        let mut max_quality_scale = sample_preset("preset-1");
        max_quality_scale.quality = Quality {
            kind: QualityKind::QualityScale,
            value: 100,
        };
        assert!(validate_settings(&sample_settings(vec![max_quality_scale])).is_ok());
    }

    #[test]
    fn rejects_a_zero_or_oversized_resolution() {
        for resolution in [
            Resolution { w: 0, h: 1080 },
            Resolution { w: 1920, h: 0 },
            Resolution {
                w: MAX_RESOLUTION_DIMENSION + 1,
                h: 1080,
            },
            Resolution {
                w: 1920,
                h: MAX_RESOLUTION_DIMENSION + 1,
            },
        ] {
            let mut preset = sample_preset("preset-1");
            preset.resolution = ResolutionSetting::Custom(resolution);
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::InvalidResolution { .. })
            ));
        }

        // The cap itself is inclusive on both axes.
        let mut preset = sample_preset("preset-1");
        preset.resolution = ResolutionSetting::Custom(Resolution {
            w: MAX_RESOLUTION_DIMENSION,
            h: MAX_RESOLUTION_DIMENSION,
        });
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn rejects_a_non_positive_or_unsafe_frame_rate() {
        for rate in [Rational::new(0, 1).unwrap(), Rational::new(-30, 1).unwrap()] {
            let mut preset = sample_preset("preset-1");
            preset.frame_rate = FrameRateSetting::Rate(rate);
            assert!(matches!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::InvalidFrameRate { .. })
            ));
        }

        // A safe positive numerator paired with a denominator outside the JavaScript safe
        // integer range must be rejected as unsafe, not silently accepted.
        let mut preset = sample_preset("preset-1");
        preset.frame_rate = FrameRateSetting::Rate(Rational::new(1, i64::MAX).unwrap());
        assert!(matches!(
            validate_settings(&sample_settings(vec![preset])),
            Err(SettingsValidationError::UnsafeInteger { .. })
        ));
    }

    #[test]
    fn rejects_empty_and_duplicate_preset_ids() {
        let empty_id_preset = sample_preset("");
        assert!(matches!(
            validate_settings(&sample_settings(vec![empty_id_preset])),
            Err(SettingsValidationError::EmptyPresetId { index: 0 })
        ));

        // A whitespace-only id must be rejected the same way, matching the trimmed check
        // already applied to the preset name.
        let whitespace_id_preset = sample_preset("   ");
        assert!(matches!(
            validate_settings(&sample_settings(vec![whitespace_id_preset])),
            Err(SettingsValidationError::EmptyPresetId { index: 0 })
        ));

        let first = sample_preset("dup");
        let second = sample_preset("dup");
        assert!(matches!(
            validate_settings(&sample_settings(vec![first, second])),
            Err(SettingsValidationError::DuplicatePresetId { index: 1 })
        ));
    }

    #[test]
    fn allows_duplicate_preset_names() {
        let mut first = sample_preset("preset-1");
        first.name = "Web 1080p".to_owned();
        let mut second = sample_preset("preset-2");
        second.name = "Web 1080p".to_owned();
        assert!(validate_settings(&sample_settings(vec![first, second])).is_ok());
    }

    #[test]
    fn rejects_a_blank_or_over_long_preset_name() {
        let mut blank = sample_preset("preset-1");
        blank.name = "   ".to_owned();
        assert!(matches!(
            validate_settings(&sample_settings(vec![blank])),
            Err(SettingsValidationError::EmptyPresetName { .. })
        ));

        // A multi-byte character proves the count uses `chars()`, not the byte length:
        // "\u{e9}" is two bytes in UTF-8 but one char.
        let mut too_long = sample_preset("preset-2");
        too_long.name = "\u{e9}".repeat(MAX_PRESET_NAME_CHARS + 1);
        assert!(matches!(
            validate_settings(&sample_settings(vec![too_long])),
            Err(SettingsValidationError::PresetNameTooLong { chars, .. })
                if chars == MAX_PRESET_NAME_CHARS + 1
        ));
    }

    #[test]
    fn rejects_more_presets_than_the_cap() {
        let over_cap: Vec<Preset> = (0..=MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        assert!(matches!(
            validate_settings(&sample_settings(over_cap)),
            Err(SettingsValidationError::TooManyPresets { count })
                if count == MAX_PRESETS + 1
        ));

        let at_cap: Vec<Preset> = (0..MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        assert!(validate_settings(&sample_settings(at_cap)).is_ok());
    }

    #[test]
    fn rejects_an_active_preset_id_that_names_nothing() {
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.active_preset_id = Some("missing".to_owned());
        assert!(matches!(
            validate_settings(&settings),
            Err(SettingsValidationError::UnknownActivePreset { preset_id })
                if preset_id == "missing"
        ));
    }

    #[test]
    fn accepts_no_active_preset_alongside_a_non_empty_preset_list() {
        let settings = sample_settings(vec![sample_preset("preset-1"), sample_preset("preset-2")]);
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn rejects_a_blank_or_nul_bearing_ffmpeg_path() {
        for path in ["", "   ", "/opt/homebrew/bin/ffmpeg\0"] {
            let mut settings = sample_settings(vec![]);
            settings.ffmpeg_path = Some(path.to_owned());
            assert!(
                matches!(
                    validate_settings(&settings),
                    Err(SettingsValidationError::InvalidFfmpegPath)
                ),
                "accepted {path:?}"
            );
        }
    }

    #[test]
    fn accepts_a_path_that_does_not_exist() {
        let mut settings = sample_settings(vec![]);
        settings.ffmpeg_path = Some("/this/path/does/not/exist/ffmpeg".to_owned());
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn round_trips_every_container_and_quality_kind() {
        for (container, wire) in [
            (Container::Mp4, "mp4"),
            (Container::Mov, "mov"),
            (Container::Mkv, "mkv"),
        ] {
            let json = serde_json::to_string(&container).unwrap();
            assert_eq!(json, format!("\"{wire}\""), "container was: {container:?}");
            assert_eq!(serde_json::from_str::<Container>(&json).unwrap(), container);
        }
        for (kind, wire) in [
            (QualityKind::Crf, "crf"),
            (QualityKind::Cq, "cq"),
            (QualityKind::Bitrate, "bitrate"),
            (QualityKind::QualityScale, "qualityScale"),
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{wire}\""), "kind was: {kind:?}");
            assert_eq!(serde_json::from_str::<QualityKind>(&json).unwrap(), kind);
        }
    }

    #[test]
    fn rejects_a_schema_version_other_than_the_current_one() {
        // Version 1 too: `load` upgrades a version-1 document before it validates, so only a
        // caller that sends version 1 reaches this check with it, and a save never writes it.
        for found in [0, 1, 3] {
            let mut settings = sample_settings(vec![]);
            settings.schema_version = found;
            assert_eq!(
                validate_settings(&settings),
                Err(SettingsValidationError::SchemaVersion { found, expected: 2 })
            );
        }
        assert_eq!(CURRENT_SCHEMA_VERSION, 2);
        assert_eq!(FIRST_RELEASE_SCHEMA_VERSION, 1);
    }

    #[test]
    fn validate_settings_accepts_a_well_formed_document() {
        let mut custom_preset = sample_preset("custom");
        custom_preset.resolution = ResolutionSetting::Custom(Resolution { w: 1280, h: 720 });
        custom_preset.frame_rate = FrameRateSetting::Rate(Rational::new(24, 1).unwrap());
        let mut settings = sample_settings(vec![sample_preset("default"), custom_preset]);
        settings.active_preset_id = Some("default".to_owned());
        settings.ffmpeg_path = Some("/opt/homebrew/bin/ffmpeg".to_owned());
        assert!(validate_settings(&settings).is_ok());
    }

    // -- The schema-2 preset fields: the pixel format, the encoder options, and `cq`. --

    #[test]
    fn a_saved_preset_always_writes_the_pixel_format_and_both_option_lists() {
        let mut preset = sample_preset("preset-1");
        let value = serde_json::to_value(&preset).unwrap();
        assert_eq!(value["pixelFormat"], serde_json::json!("yuv420p"));
        assert_eq!(value["videoOptions"], serde_json::json!([]));
        assert_eq!(value["audioOptions"], serde_json::json!([]));

        preset.pixel_format = "p010le".to_owned();
        preset.video_options = vec![option("preset", "slow"), option("tag", "hvc1")];
        preset.audio_options = vec![option("aac_coder", "twoloop")];
        let value = serde_json::to_value(&preset).unwrap();
        assert_eq!(value["pixelFormat"], serde_json::json!("p010le"));
        assert_eq!(
            value["videoOptions"],
            serde_json::json!([
                {"name": "preset", "value": "slow"},
                {"name": "tag", "value": "hvc1"},
            ])
        );
        assert_eq!(
            value["audioOptions"],
            serde_json::json!([{"name": "aac_coder", "value": "twoloop"}])
        );
        assert_eq!(serde_json::from_value::<Preset>(value).unwrap(), preset);
    }

    #[test]
    fn a_preset_without_the_schema_2_keys_reads_as_the_export_of_version_1() {
        let preset: Preset = serde_json::from_value(pre_adr_023_preset_json()).unwrap();
        assert_eq!(preset.pixel_format, DEFAULT_PIXEL_FORMAT);
        assert_eq!(DEFAULT_PIXEL_FORMAT, "yuv420p");
        assert!(preset.video_options.is_empty());
        assert!(preset.audio_options.is_empty());
    }

    #[test]
    fn an_option_entry_refuses_an_unknown_or_missing_key() {
        let mut value = pre_adr_023_preset_json();
        value["videoOptions"] = serde_json::json!([{"name": "g", "value": "1", "scope": "v"}]);
        let error = serde_json::from_value::<Preset>(value).unwrap_err();
        assert!(
            error.to_string().contains("unknown field"),
            "message was: {error}"
        );

        let mut value = pre_adr_023_preset_json();
        value["videoOptions"] = serde_json::json!([{"name": "g"}]);
        assert!(serde_json::from_value::<Preset>(value).is_err());
    }

    #[test]
    fn enforces_the_constant_quality_range() {
        for value in [MIN_CONSTANT_QUALITY, 25, MAX_CONSTANT_QUALITY] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality {
                kind: QualityKind::Cq,
                value,
            };
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected cq {value}"
            );
        }
        // NVENC reads 0 as "choose automatically", so 0 is not a quality.
        for value in [0, MAX_CONSTANT_QUALITY + 1] {
            let mut preset = sample_preset("preset-1");
            preset.quality = Quality {
                kind: QualityKind::Cq,
                value,
            };
            assert_eq!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::QualityOutOfRange {
                    index: 0,
                    kind: QualityKind::Cq,
                    value
                })
            );
        }
        assert_eq!((MIN_CONSTANT_QUALITY, MAX_CONSTANT_QUALITY), (1, 63));
    }

    #[test]
    fn enforces_the_pixel_format_rule() {
        for name in ["yuv420p", "yuv420p10le", "p010le", "nv12", "gbrap16le"] {
            let mut preset = sample_preset("preset-1");
            preset.pixel_format = name.to_owned();
            assert!(
                validate_settings(&sample_settings(vec![preset])).is_ok(),
                "rejected {name}"
            );
        }
        let mut longest = sample_preset("preset-1");
        longest.pixel_format = "a".repeat(MAX_PIXEL_FORMAT_CHARS);
        assert!(validate_settings(&sample_settings(vec![longest])).is_ok());

        // A `:`, `,`, `;`, `[`, or `]` would change the filter graph the name is written into.
        for name in [
            String::new(),
            "YUV420P".to_owned(),
            "yuv420p:x".to_owned(),
            "yuv420p,scale=2:2".to_owned(),
            "yuv420p[v];".to_owned(),
            "yuv 420p".to_owned(),
            "-yuv420p".to_owned(),
            "a".repeat(MAX_PIXEL_FORMAT_CHARS + 1),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.pixel_format = name.clone();
            let other = sample_preset("preset-0");
            assert_eq!(
                validate_settings(&sample_settings(vec![other, preset])),
                Err(SettingsValidationError::InvalidPixelFormat { index: 1 }),
                "accepted {name:?}"
            );
        }
    }

    #[test]
    fn accepts_the_encoder_options_of_the_seeds_and_of_common_command_lines() {
        let mut preset = sample_preset("preset-1");
        preset.video_options = vec![
            option("preset", "slow"),
            option(
                "x264-params",
                "aq-mode=3:aq-strength=0.9:psy-rd=0.8,0.0:deblock=0,0",
            ),
            option("profile", "main10"),
            option("tag", "hvc1"),
            option("b_ref_mode", "middle"),
            option("rc-lookahead", "32"),
            option("g", "-1"),
            option("maxrate", "24M"),
            option("a.b", "x y z"),
        ];
        preset.audio_options = vec![option("profile", "aac_low"), option("cutoff", "20000")];
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn refuses_an_option_name_outside_the_character_rule() {
        for (stream, list) in [
            (OptionStream::Video, "video"),
            (OptionStream::Audio, "audio"),
        ] {
            for name in [
                String::new(),
                "-g".to_owned(),
                "/filter_complex".to_owned(),
                "profile:v".to_owned(),
                "1pass".to_owned(),
                "_x".to_owned(),
                "a b".to_owned(),
                "é".to_owned(),
                "a".repeat(MAX_OPTION_NAME_CHARS + 1),
            ] {
                let mut preset = sample_preset("preset-1");
                let options = vec![option("preset", "slow"), option(&name, "1")];
                match stream {
                    OptionStream::Video => preset.video_options = options,
                    OptionStream::Audio => preset.audio_options = options,
                }
                assert_eq!(
                    validate_settings(&sample_settings(vec![preset])),
                    Err(SettingsValidationError::InvalidOptionName {
                        index: 0,
                        stream,
                        option: 1
                    }),
                    "{list}: accepted {name:?}"
                );
            }
        }
        let mut longest = sample_preset("preset-1");
        longest.video_options = vec![option(&"a".repeat(MAX_OPTION_NAME_CHARS), "1")];
        assert!(validate_settings(&sample_settings(vec![longest])).is_ok());
    }

    #[test]
    fn refuses_every_denied_option_name_in_both_lists() {
        // `noshortest` is named on its own: fftools reads `-noshortest` as `-shortest` set to
        // false, and the option takes no argument either way.
        assert!(DENIED_OPTION_NAMES.contains(&"shortest"));
        assert!(DENIED_OPTION_NAMES.contains(&"noshortest"));
        for name in DENIED_OPTION_NAMES {
            for stream in [OptionStream::Video, OptionStream::Audio] {
                let mut preset = sample_preset("preset-1");
                let options = vec![option(name, "1")];
                match stream {
                    OptionStream::Video => preset.video_options = options,
                    OptionStream::Audio => preset.audio_options = options,
                }
                assert_eq!(
                    validate_settings(&sample_settings(vec![preset])),
                    Err(SettingsValidationError::DeniedOptionName {
                        index: 0,
                        stream,
                        option: 0
                    }),
                    "accepted {name} for {stream}"
                );
            }
        }
        // The comparison is exact: a name that only starts like a denied one is an encoder
        // option, such as the `mapping_family` of libopus.
        let mut preset = sample_preset("preset-1");
        preset.audio_options = vec![option("mapping_family", "1"), option("Y", "1")];
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn the_denied_option_names_are_unique_and_each_one_passes_the_name_rule() {
        // A name the character rule refuses could never reach the list check, so it would be
        // dead weight here, and a repeated name would hide a missing one.
        let unique: HashSet<&str> = DENIED_OPTION_NAMES.iter().copied().collect();
        assert_eq!(unique.len(), DENIED_OPTION_NAMES.len());
        for name in DENIED_OPTION_NAMES {
            assert!(is_valid_option_name(name), "{name}");
        }
        // The managed flags of the renderer, each one by name.
        for name in [
            "c",
            "codec",
            "f",
            "i",
            "y",
            "map",
            "filter_complex",
            "pix_fmt",
            "crf",
            "cq",
            "q",
            "b",
            "ar",
            "ac",
            "progress",
            "nostats",
            "loglevel",
            "copyts",
            "movflags",
            "ss",
            "t",
        ] {
            assert!(unique.contains(name), "{name}");
        }
    }

    #[test]
    fn refuses_a_repeated_option_name_in_one_list_but_not_across_the_two() {
        let mut preset = sample_preset("preset-1");
        preset.video_options = vec![
            option("preset", "slow"),
            option("g", "250"),
            option("preset", "fast"),
        ];
        assert_eq!(
            validate_settings(&sample_settings(vec![preset])),
            Err(SettingsValidationError::DuplicateOptionName {
                index: 0,
                stream: OptionStream::Video,
                option: 2
            })
        );

        let mut preset = sample_preset("preset-1");
        preset.video_options = vec![option("profile", "main10")];
        preset.audio_options = vec![option("profile", "aac_low")];
        assert!(validate_settings(&sample_settings(vec![preset])).is_ok());
    }

    #[test]
    fn enforces_the_option_value_rule() {
        let mut longest = sample_preset("preset-1");
        longest.video_options = vec![option("x", &"a".repeat(MAX_OPTION_VALUE_CHARS))];
        assert!(validate_settings(&sample_settings(vec![longest])).is_ok());
        // A multi-byte character proves the count uses `chars()`: "é" is two bytes. A preset
        // could not carry this value, because it renders past the byte limit of the lists.
        assert!(is_valid_option_value(&"é".repeat(MAX_OPTION_VALUE_CHARS)));
        assert!(!is_valid_option_value(
            &"é".repeat(MAX_OPTION_VALUE_CHARS + 1)
        ));

        for value in [
            String::new(),
            "a".repeat(MAX_OPTION_VALUE_CHARS + 1),
            "a\nb".to_owned(),
            "a\rb".to_owned(),
            "a\0b".to_owned(),
            // The Windows quoting would lengthen these past the counted budget.
            "a\"b".to_owned(),
            "C:\\x265\\".to_owned(),
        ] {
            let mut preset = sample_preset("preset-1");
            preset.audio_options = vec![option("x", &value)];
            assert_eq!(
                validate_settings(&sample_settings(vec![preset])),
                Err(SettingsValidationError::InvalidOptionValue {
                    index: 0,
                    stream: OptionStream::Audio,
                    option: 0
                }),
                "accepted {value:?}"
            );
        }
    }

    #[test]
    fn enforces_the_option_count_of_each_list() {
        let options = |count: usize| -> Vec<PresetOption> {
            (0..count)
                .map(|index| option(&format!("o{index}"), "1"))
                .collect()
        };
        let mut full = sample_preset("preset-1");
        full.video_options = options(MAX_PRESET_OPTIONS);
        full.audio_options = options(MAX_PRESET_OPTIONS);
        assert!(validate_settings(&sample_settings(vec![full])).is_ok());

        let mut over = sample_preset("preset-1");
        over.audio_options = options(MAX_PRESET_OPTIONS + 1);
        assert_eq!(
            validate_settings(&sample_settings(vec![over])),
            Err(SettingsValidationError::TooManyOptions {
                index: 0,
                stream: OptionStream::Audio,
                count: MAX_PRESET_OPTIONS + 1
            })
        );
        assert_eq!(MAX_PRESET_OPTIONS, 32);
    }

    #[test]
    fn enforces_the_byte_limit_of_both_option_lists_together() {
        // `-x:v` is the flag, four bytes, and the value adds its own bytes.
        let flag_bytes = option("x", "").flag(OptionStream::Video).len();
        assert_eq!(flag_bytes, 4);
        assert_eq!(
            option("x", "abc").rendered_bytes(OptionStream::Audio),
            "-x:a".len() + "abc".len()
        );

        // Exactly the limit, split over both lists, passes: 2 × 505 bytes of video options and
        // 14 bytes of audio options.
        let mut at_limit = sample_preset("preset-1");
        at_limit.video_options = vec![
            option("xa", &"v".repeat(500)),
            option("xb", &"v".repeat(500)),
        ];
        at_limit.audio_options = vec![option("xc", &"a".repeat(9))];
        assert_eq!(
            option_list_bytes(OptionStream::Video, &at_limit.video_options)
                + option_list_bytes(OptionStream::Audio, &at_limit.audio_options),
            MAX_PRESET_OPTION_BYTES
        );
        assert!(validate_settings(&sample_settings(vec![at_limit.clone()])).is_ok());

        // One byte more is refused, and the audio list is the one that passed the limit.
        let mut over = at_limit.clone();
        over.audio_options[0].value.push('a');
        assert_eq!(
            validate_settings(&sample_settings(vec![over])),
            Err(SettingsValidationError::OptionsTooLong {
                index: 0,
                stream: OptionStream::Audio,
                bytes: MAX_PRESET_OPTION_BYTES + 1
            })
        );

        // The video list alone over the limit names the video list.
        let mut video_over = sample_preset("preset-1");
        video_over.video_options = (0..3)
            .map(|index| option(&format!("o{index}"), &"v".repeat(400)))
            .collect();
        assert!(matches!(
            validate_settings(&sample_settings(vec![video_over])),
            Err(SettingsValidationError::OptionsTooLong {
                stream: OptionStream::Video,
                ..
            })
        ));
        assert_eq!(MAX_PRESET_OPTION_BYTES, 1024);
    }

    #[test]
    fn the_schema_2_errors_name_the_field_path() {
        for (error, path) in [
            (
                SettingsValidationError::InvalidPixelFormat { index: 2 },
                "presets[2].pixelFormat",
            ),
            (
                SettingsValidationError::DeniedOptionName {
                    index: 1,
                    stream: OptionStream::Video,
                    option: 3,
                },
                "presets[1].videoOptions[3].name",
            ),
            (
                SettingsValidationError::InvalidOptionValue {
                    index: 0,
                    stream: OptionStream::Audio,
                    option: 4,
                },
                "presets[0].audioOptions[4].value",
            ),
            (
                SettingsValidationError::TooManyOptions {
                    index: 5,
                    stream: OptionStream::Audio,
                    count: 33,
                },
                "presets[5].audioOptions",
            ),
        ] {
            let message = error.to_string();
            assert!(message.contains(path), "{message}");
        }
    }

    // -- File operations: load, save, restore, reset, and the permissive accessor. --

    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-settings-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self { path },
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("could not create test directory: {error}"),
                }
            }
            panic!("could not create a unique test directory")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// Run `f` on a background thread and wait up to `timeout` for it to finish.
    /// [`restore_and_reset_do_not_deadlock`] uses this so that a real regression -- a
    /// `*_locked` helper calling the public [`save`] and deadlocking on the non-reentrant
    /// `Mutex` -- is reported instead of hanging forever.
    ///
    /// A timeout here means the worker is stuck holding [`SETTINGS_LOCK`], and it will never
    /// release it: the thread is detached and keeps running after this function returns, so
    /// every other settings test in the same process would then block behind that same lock
    /// forever. Returning `None` and letting the test merely fail would not prevent that; a
    /// plain `cargo test` run would still hang past this one failing test. So a timeout here
    /// ends the whole process instead, which fails fast rather than hanging CI to its job
    /// timeout.
    fn call_with_timeout<T: Send + 'static>(
        timeout: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(f());
        });
        match receiver.recv_timeout(timeout) {
            Ok(value) => Some(value),
            Err(_) => {
                // The worker still holds SETTINGS_LOCK and never will release it, so every
                // other settings test would block behind it. End the process instead of
                // hanging CI.
                eprintln!(
                    "settings deadlock probe timed out; the worker still holds SETTINGS_LOCK"
                );
                std::process::exit(101);
            }
        }
    }

    #[test]
    fn a_missing_file_loads_seeded_defaults_without_creating_it() {
        let directory = TestDirectory::new();
        let loaded = load(&directory.path).unwrap();
        assert!(loaded.seeded);
        assert_eq!(loaded.settings, defaults::seeded_settings());
        assert!(
            fs::read_dir(&directory.path).unwrap().next().is_none(),
            "load must not create the settings file, or anything else, in the directory"
        );
    }

    #[test]
    fn a_missing_app_data_directory_also_loads_seeded_defaults_without_creating_it() {
        let directory = TestDirectory::new();
        let missing = directory.path.join("does-not-exist");
        let loaded = load(&missing).unwrap();
        assert!(loaded.seeded);
        assert_eq!(loaded.settings, defaults::seeded_settings());
        assert!(
            !missing.exists(),
            "load must not create the application data directory either"
        );
    }

    #[test]
    fn save_then_load_round_trips_with_a_trailing_newline_and_no_leftover_temporary() {
        let directory = TestDirectory::new();
        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let saved = save(&directory.path, &settings).unwrap();

        // The comparison is against what `save` RETURNED, not against what it was given: the
        // document that reached disk carries the bumped revision, and the caller's copy still
        // carries the revision its edit was based on.
        assert_eq!(settings.revision, 0);
        assert_eq!(saved.revision, 1);

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings, saved);

        let path = directory.path.join(SETTINGS_FILE_NAME);
        assert_eq!(fs::read(&path).unwrap().last(), Some(&b'\n'));

        let leftover = fs::read_dir(&directory.path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover, "a temporary settings file was left behind");
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_it_cannot_read_and_leaves_the_bytes_intact() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_from_a_future_schema_version() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        // Syntactically valid JSON, and even a schema-envelope-valid future document, but
        // this build must still refuse it: ADR 013 requires a later build's document to
        // survive an older build's save rather than being overwritten.
        let original_bytes = br#"{"schemaVersion":3,"presets":[],"somethingNew":true}"#.to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_refuses_to_overwrite_a_file_that_fails_validation() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        // Well-formed JSON that deserializes cleanly but fails validate_settings: an unknown
        // activePresetId. The old "does this parse as JSON" guard would have accepted this
        // and overwritten it.
        let original_bytes =
            br#"{"schemaVersion":1,"presets":[],"activePresetId":"gone"}"#.to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let error = save(&directory.path, &settings).unwrap_err();
        assert!(matches!(error, SettingsFileError::Unreadable));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_into_a_missing_directory_creates_it_and_succeeds() {
        let directory = TestDirectory::new();
        let nested = directory.path.join("nested").join("app-data");
        assert!(!nested.exists());

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let saved = save(&nested, &settings).unwrap();

        assert!(nested.join(SETTINGS_FILE_NAME).is_file());
        assert_eq!(load(&nested).unwrap().settings, saved);
    }

    // -- The compare-and-swap on `Settings::revision`. --

    #[test]
    fn a_save_built_on_a_stale_document_is_refused_and_the_other_copys_presets_survive() {
        // This is the test that would have caught the fault. `SETTINGS_LOCK` is per-process,
        // so two QuipClip processes take two separate locks and the lock cannot order their
        // writes; before the revision comparison existed, the second save below silently
        // discarded every preset the first one had added.
        let directory = TestDirectory::new();

        // Copy A saves document A, landing it at revision 1.
        let first = sample_settings(vec![sample_preset("preset-a")]);
        let saved_first = save(&directory.path, &first).unwrap();
        assert_eq!(saved_first.revision, 1);

        // Copy B loads that document. This is the copy that goes stale.
        let stale = load(&directory.path).unwrap().settings;
        assert_eq!(stale.revision, 1);

        // Copy A loads, edits, and saves, landing the file at revision 2.
        let mut edited = load(&directory.path).unwrap().settings;
        edited.presets.push(sample_preset("preset-added-by-a"));
        let saved_second = save(&directory.path, &edited).unwrap();
        assert_eq!(saved_second.revision, 2);

        // Copy B now saves the document it loaded before that. It still carries revision 1
        // and a different preset list, so it must be refused.
        let mut stale_edit = stale;
        stale_edit.presets.push(sample_preset("preset-added-by-b"));
        let error = save(&directory.path, &stale_edit).unwrap_err();
        assert!(
            matches!(
                error,
                SettingsFileError::Conflict {
                    expected: 1,
                    found: 2
                }
            ),
            "got {error:?}"
        );

        // The bytes on disk still hold copy A's revision-2 preset list.
        let on_disk = load(&directory.path).unwrap().settings;
        assert_eq!(on_disk, saved_second);
        let ids: Vec<&str> = on_disk
            .presets
            .iter()
            .map(|preset| preset.id.as_str())
            .collect();
        assert_eq!(ids, vec!["preset-a", "preset-added-by-a"]);
    }

    #[test]
    fn each_save_bumps_the_revision_and_returns_the_document_it_wrote() {
        let directory = TestDirectory::new();
        let mut document = sample_settings(vec![sample_preset("preset-1")]);

        // Each round feeds back the document the previous save RETURNED, which is the only
        // place the new revision appears. Feeding back the value that was sent would be
        // refused as a conflict from the second round onward.
        for expected_revision in 1..=3 {
            document = save(&directory.path, &document).unwrap();
            assert_eq!(document.revision, expected_revision);
            assert_eq!(load(&directory.path).unwrap().settings, document);
        }
    }

    #[test]
    fn a_first_save_into_a_missing_file_ignores_the_callers_revision() {
        let directory = TestDirectory::new();
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.revision = 4_000;

        // Nothing exists yet, so there is nothing a comparison could protect: the caller's
        // revision is ignored rather than reported as a conflict, and the count starts at 1.
        let saved = save(&directory.path, &settings).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(load(&directory.path).unwrap().settings, saved);
    }

    #[test]
    fn a_document_written_without_the_revision_key_loads_as_zero_and_saves_once() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        // A document from a build before this field existed. `#[serde(default)]` reads it as
        // revision 0, which is also what `sample_settings` and `defaults::seeded_settings`
        // carry, so the first save over it compares 0 against 0 and succeeds.
        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let mut value = serde_json::to_value(&settings).unwrap();
        value.as_object_mut().unwrap().remove("revision");
        assert!(!value.as_object().unwrap().contains_key("revision"));
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings.revision, 0);

        let saved = save(&directory.path, &loaded.settings).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(load(&directory.path).unwrap().settings, saved);
    }

    #[test]
    fn restore_carries_the_revision_it_read_and_returns_the_bumped_one() {
        // `restore_default_presets` needs no token handling of its own: it carries the whole
        // loaded document forward into `save_locked`, so the revision rides along inside it.
        let directory = TestDirectory::new();
        let settings = sample_settings(vec![sample_preset("user-preset")]);
        let saved = save(&directory.path, &settings).unwrap();
        assert_eq!(saved.revision, 1);

        let restored = restore_default_presets(&directory.path).unwrap();
        assert_eq!(restored.revision, 2);
        assert_eq!(load(&directory.path).unwrap().settings, restored);
    }

    #[test]
    fn reset_continues_the_count_from_the_document_it_moved_aside() {
        // A reset must not hand back a revision the file has held before: a copy of QuipClip
        // still holding a document from before the reset would pass the comparison and undo
        // it. `u32::MAX` wraps to 0, which is a value no stale holder can be carrying either,
        // because a save writes 0 only by wrapping.
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        for (revision, expected) in [(1_u32, 2_u32), (12_345, 12_346), (u32::MAX, 0)] {
            let existing = Settings {
                revision,
                ..sample_settings(vec![sample_preset("preset-1")])
            };
            fs::write(&path, serde_json::to_vec(&existing).unwrap()).unwrap();

            let after_reset = reset(&directory.path).unwrap();
            assert_eq!(
                after_reset.revision, expected,
                "reset over revision {revision}"
            );
            assert_eq!(load(&directory.path).unwrap().settings, after_reset);
        }
    }

    #[test]
    fn a_document_held_from_before_a_reset_cannot_be_saved_over_the_reset() {
        // The ABA sequence the continued count closes. Process B loads the file, process A
        // resets it, and B then saves the document it was holding. B's revision was current
        // before the reset, so a reset that restarted the count at 1 would accept it and
        // silently undo A's reset.
        let directory = TestDirectory::new();
        let held_by_b = save(
            &directory.path,
            &sample_settings(vec![sample_preset("preset-b")]),
        )
        .unwrap();
        assert_eq!(held_by_b.revision, 1);

        let after_reset = reset(&directory.path).unwrap();
        assert_eq!(after_reset.revision, 2);

        let error = save(&directory.path, &held_by_b).unwrap_err();
        assert!(matches!(
            error,
            SettingsFileError::Conflict {
                expected: 1,
                found: 2
            }
        ));
        // The seeds A's reset wrote are still on disk, untouched.
        assert_eq!(load(&directory.path).unwrap().settings, after_reset);
    }

    #[test]
    fn validate_settings_accepts_every_revision() {
        // No revision is invalid: this is a compare-and-swap counter, not a format version.
        for revision in [0, 1, u32::MAX] {
            let settings = Settings {
                revision,
                ..sample_settings(vec![sample_preset("preset-1")])
            };
            assert!(
                validate_settings(&settings).is_ok(),
                "rejected revision {revision}"
            );
        }
    }

    #[test]
    fn the_revision_key_is_always_serialized() {
        // No `skip_serializing_if`: every save from the second onward has to compare a value
        // that was really written, so revision 0 must reach the file as an explicit key too.
        for revision in [0, 1, u32::MAX] {
            let settings = Settings {
                revision,
                ..sample_settings(vec![])
            };
            let value = serde_json::to_value(&settings).unwrap();
            assert_eq!(
                value["revision"],
                serde_json::json!(revision),
                "revision {revision} was not serialized"
            );
        }
    }

    #[test]
    fn corrupt_json_is_an_error_not_a_silent_default() {
        let directory = TestDirectory::new();
        fs::write(directory.path.join(SETTINGS_FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::Json(_))
        ));
    }

    #[test]
    fn a_future_schema_version_is_typed_and_a_lower_one_is_a_validation_error() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let settings = sample_settings(vec![]);
        let mut value = serde_json::to_value(&settings).unwrap();

        value["schemaVersion"] = serde_json::json!(3);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::FutureSchemaVersion {
                found: 3,
                supported: 2
            })
        ));

        value["schemaVersion"] = serde_json::json!(0);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            load(&directory.path),
            Err(SettingsFileError::Validation(
                SettingsValidationError::SchemaVersion {
                    found: 0,
                    expected: 2
                }
            ))
        ));
    }

    // -- The read of a version-1 file. --

    #[test]
    fn a_version_1_file_loads_as_version_2_with_the_defaults_and_writes_nothing() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, VERSION_1_FIXTURE).unwrap();

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        let settings = loaded.settings;
        assert_eq!(settings.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(settings.revision, 7);
        assert_eq!(settings.ffmpeg_path.as_deref(), Some("/opt/homebrew/bin"));
        assert_eq!(settings.active_preset_id.as_deref(), Some("user-prores"));
        assert_eq!(settings.presets.len(), 4);
        for preset in &settings.presets {
            assert_eq!(preset.pixel_format, "yuv420p", "{}", preset.id);
            assert!(preset.video_options.is_empty(), "{}", preset.id);
            assert!(preset.audio_options.is_empty(), "{}", preset.id);
        }
        // Every version-1 value survives the read as it was.
        let prores = &settings.presets[3];
        assert_eq!(prores.video_encoder, "prores_ks");
        assert_eq!(prores.audio_bitrate, None);
        assert_eq!(
            prores.quality,
            Quality {
                kind: QualityKind::QualityScale,
                value: 9
            }
        );
        assert_eq!(
            prores.resolution,
            ResolutionSetting::Custom(Resolution { w: 1920, h: 1080 })
        );

        // The read wrote nothing: the file still holds the version-1 bytes, and no other file
        // appeared beside it.
        assert_eq!(fs::read_to_string(&path).unwrap(), VERSION_1_FIXTURE);
        assert_eq!(fs::read_dir(&directory.path).unwrap().count(), 1);
    }

    #[test]
    fn a_save_over_a_version_1_file_writes_version_2_at_the_next_revision() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, VERSION_1_FIXTURE).unwrap();

        let loaded = load(&directory.path).unwrap().settings;
        let saved = save(&directory.path, &loaded).unwrap();
        assert_eq!(saved.schema_version, 2);
        assert_eq!(saved.revision, 8);

        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["schemaVersion"], serde_json::json!(2));
        assert_eq!(on_disk["revision"], serde_json::json!(8));
        for preset in on_disk["presets"].as_array().unwrap() {
            assert_eq!(preset["pixelFormat"], serde_json::json!("yuv420p"));
            assert_eq!(preset["videoOptions"], serde_json::json!([]));
            assert_eq!(preset["audioOptions"], serde_json::json!([]));
        }
        assert_eq!(load(&directory.path).unwrap().settings, saved);

        // A copy that still holds the version-1 revision is refused like any stale copy.
        let error = save(&directory.path, &loaded).unwrap_err();
        assert!(matches!(
            error,
            SettingsFileError::Conflict {
                expected: 7,
                found: 8
            }
        ));
    }

    #[test]
    fn a_save_refuses_a_document_that_claims_version_1() {
        // The interface sends the document it loaded, which is at version 2. A document that
        // still claims version 1 did not come from this build, and the file stays as it was.
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, VERSION_1_FIXTURE).unwrap();
        let mut stale = load(&directory.path).unwrap().settings;
        stale.schema_version = FIRST_RELEASE_SCHEMA_VERSION;

        let error = save(&directory.path, &stale).unwrap_err();
        assert!(matches!(
            error,
            SettingsFileError::Validation(SettingsValidationError::SchemaVersion {
                found: 1,
                expected: 2
            })
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), VERSION_1_FIXTURE);
    }

    #[test]
    fn configured_ffmpeg_path_reads_a_version_1_and_a_version_2_file() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, VERSION_1_FIXTURE).unwrap();
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/opt/homebrew/bin"))
        );

        let saved = save(&directory.path, &load(&directory.path).unwrap().settings).unwrap();
        assert_eq!(saved.schema_version, 2);
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/opt/homebrew/bin"))
        );
    }

    #[test]
    fn configured_ffmpeg_path_survives_a_damaged_preset() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let json = serde_json::json!({
            "schemaVersion": 1,
            "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
            "presets": [{"id": "broken", "container": "not-a-real-container"}],
            "activePresetId": "broken",
        });
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        // The strict surface really does reject this document; the probe below must still
        // find the path despite that failure, not because the document happens to be fine.
        assert!(load(&directory.path).is_err());
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/opt/homebrew/bin/ffmpeg"))
        );
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_missing_corrupt_or_future_file() {
        let directory = TestDirectory::new();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        let future = serde_json::json!({
            "schemaVersion": 3,
            "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
            "presets": [],
        });
        fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_blank_or_absent_path() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);

        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"schemaVersion": 1, "presets": []})).unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);

        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "ffmpegPath": "   ",
                "presets": [],
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_returns_none_for_a_path_the_strict_surface_would_reject() {
        // validate_settings rejects a NUL-bearing ffmpegPath (InvalidFfmpegPath); the
        // permissive probe must reject it too, not report a path load/save would refuse.
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "ffmpegPath": "/a\0b",
                "presets": [],
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(configured_ffmpeg_path(&directory.path), None);
    }

    #[test]
    fn configured_ffmpeg_path_reads_a_document_saved_through_the_strict_surface() {
        let directory = TestDirectory::new();
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.ffmpeg_path = Some("/usr/local/bin/ffmpeg".to_owned());
        save(&directory.path, &settings).unwrap();
        assert_eq!(
            configured_ffmpeg_path(&directory.path),
            Some(PathBuf::from("/usr/local/bin/ffmpeg"))
        );
    }

    #[test]
    fn restore_default_presets_replaces_an_edited_default_by_id_and_keeps_user_presets() {
        let directory = TestDirectory::new();
        let mut edited_default = defaults::default_presets().remove(0);
        edited_default.name = "Edited name".to_owned();
        edited_default.quality.value = 63;
        let user_preset = sample_preset("user-preset");

        let mut settings = sample_settings(vec![edited_default.clone(), user_preset.clone()]);
        settings.active_preset_id = Some(user_preset.id.clone());
        save(&directory.path, &settings).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();

        let restored_default = restored
            .presets
            .iter()
            .find(|preset| preset.id == edited_default.id)
            .unwrap();
        assert_eq!(restored_default, &defaults::default_presets()[0]);
        assert_ne!(restored_default.name, "Edited name");
        assert_eq!(
            restored.presets[0].id, edited_default.id,
            "the seed must replace the edited default in place, keeping display order"
        );

        assert!(restored
            .presets
            .iter()
            .any(|preset| preset.id == user_preset.id));
        assert_eq!(restored.active_preset_id, Some(user_preset.id));
        assert_eq!(load(&directory.path).unwrap().settings, restored);
    }

    #[test]
    fn restore_default_presets_keeps_the_configured_ffmpeg_path() {
        let directory = TestDirectory::new();
        let mut settings = sample_settings(vec![sample_preset("preset-1")]);
        settings.ffmpeg_path = Some("/opt/homebrew/bin/ffmpeg".to_owned());
        save(&directory.path, &settings).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();
        assert_eq!(
            restored.ffmpeg_path.as_deref(),
            Some("/opt/homebrew/bin/ffmpeg")
        );
        assert_eq!(
            load(&directory.path)
                .unwrap()
                .settings
                .ffmpeg_path
                .as_deref(),
            Some("/opt/homebrew/bin/ffmpeg")
        );
    }

    #[test]
    fn restore_default_presets_appends_missing_seeds_and_seeds_an_absent_active_preset() {
        let directory = TestDirectory::new();
        let empty = Settings {
            schema_version: CURRENT_SCHEMA_VERSION,
            revision: 0,
            ffmpeg_path: None,
            presets: vec![],
            active_preset_id: None,
        };
        save(&directory.path, &empty).unwrap();

        let restored = restore_default_presets(&directory.path).unwrap();
        let seed_ids: Vec<String> = defaults::default_presets()
            .into_iter()
            .map(|preset| preset.id)
            .collect();
        for id in &seed_ids {
            assert!(restored.presets.iter().any(|preset| &preset.id == id));
        }
        assert_eq!(restored.active_preset_id.as_ref(), Some(&seed_ids[0]));
    }

    #[test]
    fn restore_default_presets_on_a_missing_file_creates_it_with_the_seeds() {
        let directory = TestDirectory::new();
        let restored = restore_default_presets(&directory.path).unwrap();
        // The seeds, at the revision a first save writes: `restore_default_presets` loaded a
        // missing file, so `save_locked` took its "no file" arm and started the count at 1.
        assert_eq!(
            restored,
            Settings {
                revision: 1,
                ..defaults::seeded_settings()
            }
        );
        assert!(directory.path.join(SETTINGS_FILE_NAME).is_file());
        assert_eq!(load(&directory.path).unwrap().settings, restored);
    }

    #[test]
    fn restore_default_presets_on_a_corrupt_existing_file_is_an_error() {
        let directory = TestDirectory::new();
        fs::write(directory.path.join(SETTINGS_FILE_NAME), b"{ not json").unwrap();
        assert!(matches!(
            restore_default_presets(&directory.path),
            Err(SettingsFileError::Json(_))
        ));
    }

    #[test]
    fn restore_default_presets_refuses_rather_than_exceeding_the_preset_cap() {
        // With a full preset library, appending the seeds would push the count past
        // MAX_PRESETS. Refusing beats silently truncating the user's library, so this pins
        // that refusal -- and that nothing is written -- as documented behaviour rather than
        // a surprise.
        let directory = TestDirectory::new();
        let full_presets: Vec<Preset> = (0..MAX_PRESETS)
            .map(|index| sample_preset(&format!("preset-{index}")))
            .collect();
        let settings = sample_settings(full_presets);
        let saved = save(&directory.path, &settings).unwrap();

        let seed_count = defaults::default_presets().len();
        let error = restore_default_presets(&directory.path).unwrap_err();
        assert!(matches!(
            error,
            SettingsFileError::Validation(SettingsValidationError::TooManyPresets { count })
                if count == MAX_PRESETS + seed_count
        ));

        // Nothing was written: the file on disk still holds the un-restored settings, at the
        // revision the save that put them there returned.
        assert_eq!(load(&directory.path).unwrap().settings, saved);
    }

    #[test]
    fn deleting_every_default_and_saving_does_not_reseed_on_the_next_load() {
        let directory = TestDirectory::new();
        let user_preset = sample_preset("only-user-preset");
        let mut settings = sample_settings(vec![user_preset.clone()]);
        settings.active_preset_id = Some(user_preset.id.clone());
        save(&directory.path, &settings).unwrap();

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings.presets.len(), 1);
        assert_eq!(loaded.settings.presets[0].id, user_preset.id);
    }

    #[test]
    fn reset_moves_the_damaged_file_aside_and_writes_defaults() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let original_bytes = b"{ this is not valid settings json".to_vec();
        fs::write(&path, &original_bytes).unwrap();

        let settings = reset(&directory.path).unwrap();
        // The seeds at revision 1: these bytes are not JSON, so the probe finds no revision
        // to continue from and the save that follows starts the count at 1.
        assert_eq!(
            settings,
            Settings {
                revision: 1,
                ..defaults::seeded_settings()
            }
        );

        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        assert_eq!(fs::read(&backup_path).unwrap(), original_bytes);

        let loaded = load(&directory.path).unwrap();
        assert!(!loaded.seeded);
        assert_eq!(loaded.settings, settings);
    }

    #[test]
    fn reset_with_no_existing_file_just_writes_seeds() {
        let directory = TestDirectory::new();
        let settings = reset(&directory.path).unwrap();
        assert_eq!(
            settings,
            Settings {
                revision: 1,
                ..defaults::seeded_settings()
            }
        );
        assert!(!directory.path.join(INVALID_SETTINGS_FILE_NAME).exists());
        assert_eq!(load(&directory.path).unwrap().settings, settings);
    }

    #[test]
    fn reset_overwrites_a_previous_backup_rather_than_accumulating_files() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);

        fs::write(&path, b"first damaged file").unwrap();
        reset(&directory.path).unwrap();

        fs::write(&path, b"{ not json, second damage").unwrap();
        reset(&directory.path).unwrap();

        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        assert_eq!(
            fs::read(&backup_path).unwrap(),
            b"{ not json, second damage"
        );

        let entries: Vec<_> = fs::read_dir(&directory.path).unwrap().collect();
        assert_eq!(
            entries.len(),
            2,
            "only the live settings file and one fixed backup should exist"
        );
    }

    #[test]
    fn reset_writes_nothing_when_the_rename_fails() {
        let directory = TestDirectory::new();
        let path = directory.path.join(SETTINGS_FILE_NAME);
        let original_bytes = b"{ this is not valid settings json".to_vec();
        fs::write(&path, &original_bytes).unwrap();
        // A non-empty directory at the backup name makes fs::rename fail with something
        // other than NotFound.
        let backup_path = directory.path.join(INVALID_SETTINGS_FILE_NAME);
        fs::create_dir(&backup_path).unwrap();
        fs::write(backup_path.join("occupied"), b"x").unwrap();

        let error = reset(&directory.path).unwrap_err();
        assert!(matches!(error, SettingsFileError::Backup(_)));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn save_recovers_from_a_poisoned_lock() {
        let directory = TestDirectory::new();
        // Poison SETTINGS_LOCK from a thread that panics while holding it, the same way a
        // panicking save would. save's `PoisonError::into_inner` recovery must still hand
        // back a usable guard afterward instead of propagating the poison as a panic.
        let poison_result = thread::spawn(|| {
            let _guard = SETTINGS_LOCK.lock().unwrap();
            panic!("poison SETTINGS_LOCK on purpose for the recovery test");
        })
        .join();
        assert!(poison_result.is_err());
        assert!(SETTINGS_LOCK.is_poisoned());

        let settings = sample_settings(vec![sample_preset("preset-1")]);
        let saved = save(&directory.path, &settings).unwrap();
        assert_eq!(load(&directory.path).unwrap().settings, saved);
    }

    #[test]
    fn restore_and_reset_do_not_deadlock() {
        let directory = TestDirectory::new();

        let restore_path = directory.path.clone();
        let restore_result = call_with_timeout(Duration::from_secs(5), move || {
            restore_default_presets(&restore_path)
        });
        assert!(
            restore_result.is_some(),
            "restore_default_presets did not return; it likely deadlocked on its own lock"
        );
        assert!(restore_result.unwrap().is_ok());

        let reset_path = directory.path.clone();
        let reset_result = call_with_timeout(Duration::from_secs(5), move || reset(&reset_path));
        assert!(
            reset_result.is_some(),
            "reset did not return; it likely deadlocked on its own lock"
        );
        assert!(reset_result.unwrap().is_ok());
    }

    #[test]
    fn file_name_constants_match_adr_013() {
        assert_eq!(SETTINGS_FILE_NAME, "settings.json");
        assert_eq!(INVALID_SETTINGS_FILE_NAME, "settings.invalid.json");
    }

    #[test]
    fn settings_file_error_display_messages_name_the_kind_of_failure() {
        let io_error = SettingsFileError::from(io::Error::other("boom"));
        assert!(io_error.to_string().contains("I/O"));

        let json_error =
            SettingsFileError::from(serde_json::from_str::<Settings>("{").unwrap_err());
        assert!(json_error.to_string().contains("JSON"));

        let validation_error = SettingsFileError::from(SettingsValidationError::InvalidFfmpegPath);
        assert!(validation_error.to_string().contains("values are invalid"));

        let future = SettingsFileError::FutureSchemaVersion {
            found: 9,
            supported: 1,
        };
        assert!(future.to_string().contains("newer than supported"));

        assert!(SettingsFileError::Unreadable
            .to_string()
            .contains("could not be read"));

        let conflict = SettingsFileError::Conflict {
            expected: 4,
            found: 5,
        };
        let conflict_message = conflict.to_string();
        assert!(
            conflict_message.contains("revision 4") && conflict_message.contains("revision 5"),
            "message was: {conflict_message}"
        );
        assert!(conflict.source().is_none());

        let backup_error = SettingsFileError::Backup(io::Error::other("boom"));
        assert!(backup_error.to_string().contains("backup failed"));
    }

    // -- Composition with real ffmpeg discovery. --
    //
    // `commands::capabilities::start_capability_probe` wires `configured_ffmpeg_path` into
    // `ffmpeg::discover`, through the named `commands::capabilities::discover_for_probe`,
    // which that module tests directly against a real settings file. This test instead covers
    // the composition itself, from this side: a real settings file on disk, read by the real
    // `configured_ffmpeg_path`, feeding the real `ffmpeg::discover_with_path` with an empty
    // `PATH` slice, so nothing but the configured entry can satisfy the lookup.
    // `discover_with_path`, not `discover`, is what this test calls: `discover` unconditionally
    // appends `/opt/homebrew/bin` and `/usr/local/bin` on macOS, which would let a real
    // Homebrew ffmpeg on this machine satisfy the lookup instead of the configured entry
    // actually being exercised.

    // Fake executable names, following the same platform `cfg` split as the private
    // `FFMPEG_NAME`/`FFPROBE_NAME` constants in `ffmpeg::locate`, which this module cannot
    // reach directly because they are private to that module.
    #[cfg(windows)]
    const FAKE_FFMPEG_NAME: &str = "ffmpeg.exe";
    #[cfg(not(windows))]
    const FAKE_FFMPEG_NAME: &str = "ffmpeg";
    #[cfg(windows)]
    const FAKE_FFPROBE_NAME: &str = "ffprobe.exe";
    #[cfg(not(windows))]
    const FAKE_FFPROBE_NAME: &str = "ffprobe";

    /// Create a fake executable file: a plain file on Windows, a file with the execute
    /// permission bit set on Unix, mirroring `ffmpeg::locate`'s own test helpers. The file
    /// never runs; discovery only checks that it exists and, on Unix, that it is executable.
    fn create_fake_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::File::create(path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn a_configured_path_written_to_settings_is_what_discovery_receives() {
        let directory = TestDirectory::new();

        // A fake ffmpeg/ffprobe pair the configured path will point at. Discovery must find
        // this pair through `configured_ffmpeg_path`, with an empty PATH slice so nothing but
        // the configured entry can satisfy the lookup.
        let configured = directory.path.join("configured");
        fs::create_dir_all(&configured).unwrap();
        create_fake_executable(&configured.join(FAKE_FFMPEG_NAME));
        create_fake_executable(&configured.join(FAKE_FFPROBE_NAME));

        let app_data = directory.path.join("app-data");
        let mut settings = sample_settings(vec![]);
        settings.ffmpeg_path = Some(configured.to_string_lossy().into_owned());
        save(&app_data, &settings).unwrap();

        let resolved = configured_ffmpeg_path(&app_data);
        assert_eq!(resolved.as_deref(), Some(configured.as_path()));

        let found = crate::ffmpeg::discover_with_path(resolved.as_deref(), &[], &app_data).unwrap();
        assert_eq!(found.origin, crate::ffmpeg::ExecutableOrigin::Configured);
        assert_eq!(
            found.ffmpeg,
            configured.join(FAKE_FFMPEG_NAME).canonicalize().unwrap()
        );
        assert_eq!(
            found.ffprobe,
            configured.join(FAKE_FFPROBE_NAME).canonicalize().unwrap()
        );

        // Negative half: a configured directory holding no pair, still with an empty PATH
        // slice, must genuinely fail to resolve. This rules out the app-data fallback, or an
        // empty PATH being treated as "no restriction", quietly satisfying the lookup instead
        // of the configured entry actually being consulted.
        let empty_configured = directory.path.join("configured-empty");
        fs::create_dir_all(&empty_configured).unwrap();
        let mut empty_settings = sample_settings(vec![]);
        empty_settings.ffmpeg_path = Some(empty_configured.to_string_lossy().into_owned());
        let empty_app_data = directory.path.join("app-data-empty");
        save(&empty_app_data, &empty_settings).unwrap();

        let empty_resolved = configured_ffmpeg_path(&empty_app_data);
        assert_eq!(empty_resolved.as_deref(), Some(empty_configured.as_path()));

        let error =
            crate::ffmpeg::discover_with_path(empty_resolved.as_deref(), &[], &empty_app_data)
                .unwrap_err();
        assert!(matches!(error, crate::ffmpeg::LocateError::NotFound { .. }));
    }
}
