//! Pure text parsers for the ffmpeg capability listings.
//!
//! ADR 006 lists four commands the probe reads before it runs a single smoke test:
//! `-encoders`, `-decoders`, `-hwaccels`, and `-filters`. It also reads the
//! `configuration:` line of `-version` for the licence flags. The four listings do not
//! share one output format, so this module holds one parser per format plus the licence
//! flag lookup.
//!
//! Every function here takes a `&str` and returns owned data. None of them spawn a
//! process, read a file, or touch the environment, so every one of them runs in CI on a
//! machine that has no ffmpeg installed.

use super::{CodecKind, LicenseFlags, ListedCodec, VersionInfo};

/// Parse an `-encoders` or `-decoders` listing.
///
/// Both listings share one row format: a six-character flag column, the codec name, and a
/// description. Rows appear only after the separator line `------`; a listing with no
/// separator is treated as unparseable and yields an empty vector rather than a guess.
pub fn parse_codec_list(stdout: &str) -> Vec<ListedCodec> {
    let mut lines = stdout.lines().map(strip_cr);
    let found_separator = lines.by_ref().any(|line| line.trim() == "------");
    if !found_separator {
        return Vec::new();
    }
    lines.filter_map(parse_codec_row).collect()
}

/// Parse one codec row into a [`ListedCodec`], or `None` when the row is blank or its
/// kind flag is not `V`, `A`, or `S`.
fn parse_codec_row(line: &str) -> Option<ListedCodec> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return None;
    }

    // Split off the six-character flag column by character, not by byte offset, so a
    // stray multi-byte character in a future ffmpeg build never panics a slice.
    let mut chars = trimmed.char_indices();
    let flag_end = chars
        .by_ref()
        .nth(5)
        .map(|(index, ch)| index + ch.len_utf8())?;
    let flags = &trimmed[..flag_end];
    let rest = trimmed[flag_end..].trim_start();
    if rest.is_empty() {
        return None;
    }

    let kind = match flags.chars().next()? {
        'V' => CodecKind::Video,
        'A' => CodecKind::Audio,
        'S' => CodecKind::Subtitle,
        _ => return None,
    };
    let experimental = flags.chars().nth(3) == Some('X');

    // A row with a name but no description keeps the row: absence from the listing is the
    // authoritative "not built" signal per ADR 006, so a merely terse row must not be
    // dropped and mistaken for that signal.
    let (name, description) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let description = strip_codec_suffix(description.trim());

    Some(ListedCodec {
        name: name.to_owned(),
        kind,
        experimental,
        description,
    })
}

/// Strip a trailing `(codec <something>)` annotation from a description.
///
/// ffmpeg appends this parenthetical when several encoders or decoders implement the same
/// codec. It never appears in the name, only in the description, and only the innermost
/// trailing parenthetical counts: a description that itself contains a parenthesis, such
/// as `libsvtav1`'s, keeps that parenthesis and loses only the final `(codec ...)`.
fn strip_codec_suffix(description: &str) -> String {
    if description.ends_with(')') {
        if let Some(open) = description.rfind('(') {
            let inner = &description[open + 1..description.len() - 1];
            if let Some(rest) = inner.strip_prefix("codec ") {
                if !rest.trim().is_empty() {
                    return description[..open].trim_end().to_owned();
                }
            }
        }
    }
    description.to_owned()
}

/// Parse an `-hwaccels` listing.
///
/// The listing is one header line, `Hardware acceleration methods:`, followed by bare
/// method names, one per line. A listing whose header never appears is treated as
/// unparseable and yields an empty vector rather than guessing that its first line is the
/// header.
pub fn parse_hwaccel_list(stdout: &str) -> Vec<String> {
    let mut lines = stdout.lines().map(strip_cr);
    let found_header = lines
        .by_ref()
        .any(|line| line.trim() == "Hardware acceleration methods:");
    if !found_header {
        return Vec::new();
    }
    lines
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Parse a `-filters` listing.
///
/// This listing has a different row shape than the codec listings: a flag column, an
/// input/output signature such as `A->A`, and then the description. The flag column's
/// width varies — real ffmpeg 9.0.1 prints two characters even though the legend above the
/// listing describes three positions — so the parser does not depend on that width at all.
/// It takes the filter name as the second whitespace-separated token on each row after the
/// `------` separator.
pub fn parse_filter_list(stdout: &str) -> Vec<String> {
    let mut lines = stdout.lines().map(strip_cr);
    let found_separator = lines.by_ref().any(|line| line.trim() == "------");
    if !found_separator {
        return Vec::new();
    }
    lines
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.split_whitespace().nth(1).map(str::to_owned)
        })
        .collect()
}

/// [`parse_program_version`] for `ffmpeg`.
pub fn parse_version(stdout: &str) -> Option<VersionInfo> {
    parse_program_version(stdout, "ffmpeg")
}

/// Parse the version string and configuration flags out of `<program> -version` output, where
/// `program` is a literal name such as `ffmpeg` or `ffprobe`.
///
/// `version` is the token that follows `<program> version `. The version line of another
/// program, or of a longer name such as `ffmpegx`, does not count. `configuration_flags` is the
/// whitespace-split remainder of the line whose trimmed form starts with `configuration:`,
/// without the `configuration:` token itself. Each program of one build prints the same
/// `configuration:` line. Returns `None` when no version line is present, since that is the only
/// field this parser cannot leave empty. An empty `program` therefore always gives `None`.
pub fn parse_program_version(stdout: &str, program: &str) -> Option<VersionInfo> {
    let version = stdout.lines().map(strip_cr).find_map(|line| {
        line.trim_start()
            .strip_prefix(program)
            .and_then(|rest| rest.strip_prefix(" version "))
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned)
    })?;

    let configuration_flags = stdout
        .lines()
        .map(strip_cr)
        .find(|line| line.trim().starts_with("configuration:"))
        .map(|line| {
            line.split_whitespace()
                .skip(1) // drop the leading "configuration:" token
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Some(VersionInfo {
        version,
        configuration_flags,
    })
}

/// Read the licence flags ADR 005 needs for the consent dialog out of the configuration
/// flags [`parse_program_version`] returns.
pub fn license_flags(configuration_flags: &[String]) -> LicenseFlags {
    let has = |flag: &str| {
        configuration_flags
            .iter()
            .any(|candidate| candidate == flag)
    };
    LicenseFlags {
        gpl: has("--enable-gpl"),
        nonfree: has("--enable-nonfree"),
        version3: has("--enable-version3"),
    }
}

/// Make explicit that a trailing `\r` from a CRLF listing is expected and harmless.
///
/// The callers below already tolerate a trailing `\r` on their own: every row reaches a
/// `.trim()`, a `split_whitespace()`, or a `split_once(char::is_whitespace)` before use,
/// and `\r` counts as whitespace to all three. This function carries none of that
/// behaviour by itself; it only names the assumption so a reader does not have to
/// rediscover it from the call sites.
fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `ffmpeg -hide_banner -encoders` output from ffmpeg 9.0.1, trimmed to a
    /// representative subset. `libsvtav1`'s description carries an embedded parenthesis
    /// that is not a `(codec ...)` suffix, and `aac`'s description ends in a parenthetical
    /// that is not a `(codec ...)` suffix either; both must survive parsing intact.
    const ENCODERS_FIXTURE: &str = "Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libaom-av1           libaom AV1 (codec av1)
 V..... libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)
 A....D libopus              libopus Opus (codec opus)
 S..... ssa                  ASS (Advanced SubStation Alpha) subtitle (codec ass)
";

    const HWACCELS_FIXTURE: &str = "Hardware acceleration methods:
videotoolbox
vulkan
";

    const FILTERS_FIXTURE: &str = "Filters:
  T.. = Timeline support
  .S. = Slice threading
  ...
  ------
 TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.
 .. abench            A->A       Benchmark part of a filtergraph.
 .. acompressor       A->A       Audio compressor.
";

    const VERSION_FIXTURE: &str = "ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers
built with Apple clang version 21.0.0 (clang-2100.1.1.101)
configuration: --prefix=/opt/homebrew/Cellar/ffmpeg-full/9.0.1_1 --enable-shared --enable-gpl --enable-version3 --enable-libx264 --enable-videotoolbox
";

    #[test]
    fn parses_the_encoder_fixture_into_the_expected_rows() {
        let codecs = parse_codec_list(ENCODERS_FIXTURE);
        assert_eq!(codecs.len(), 9);

        assert_eq!(codecs[0].name, "libaom-av1");
        assert_eq!(codecs[0].kind, CodecKind::Video);
        assert!(!codecs[0].experimental);
        assert_eq!(codecs[0].description, "libaom AV1");

        assert_eq!(codecs[8].name, "ssa");
        assert_eq!(codecs[8].kind, CodecKind::Subtitle);
        assert_eq!(
            codecs[8].description,
            "ASS (Advanced SubStation Alpha) subtitle"
        );
    }

    #[test]
    fn keeps_an_embedded_parenthesis_that_is_not_a_codec_suffix() {
        let codecs = parse_codec_list(ENCODERS_FIXTURE);
        let libsvtav1 = codecs
            .iter()
            .find(|codec| codec.name == "libsvtav1")
            .unwrap();
        assert_eq!(
            libsvtav1.description,
            "SVT-AV1(Scalable Video Technology for AV1) encoder"
        );
    }

    #[test]
    fn keeps_a_trailing_parenthetical_that_is_not_a_codec_suffix() {
        let codecs = parse_codec_list(ENCODERS_FIXTURE);
        let aac = codecs.iter().find(|codec| codec.name == "aac").unwrap();
        assert_eq!(aac.description, "AAC (Advanced Audio Coding)");
    }

    #[test]
    fn marks_a_row_experimental_from_the_fourth_flag_character() {
        // The fourth flag character (index 3) is the experimental marker; compare against
        // the header comment in ENCODERS_FIXTURE, `...X.. = Codec is experimental`.
        let stdout = " ------\n V..X.. testenc              An experimental encoder (codec test)\n";
        let codecs = parse_codec_list(stdout);
        assert_eq!(codecs.len(), 1);
        assert!(codecs[0].experimental);
        assert_eq!(codecs[0].description, "An experimental encoder");
    }

    #[test]
    fn skips_a_row_with_an_unrecognized_kind_flag_instead_of_panicking() {
        let stdout = " ------\n D..... weirdcodec           Not a video, audio, or subtitle row\n V....D libx264              libx264 H.264\n";
        let codecs = parse_codec_list(stdout);
        assert_eq!(codecs.len(), 1);
        assert_eq!(codecs[0].name, "libx264");
    }

    #[test]
    fn keeps_a_row_with_a_name_and_no_description() {
        let stdout = " ------\n V....D onlyname\n";
        let codecs = parse_codec_list(stdout);
        assert_eq!(codecs.len(), 1);
        assert_eq!(codecs[0].name, "onlyname");
        assert_eq!(codecs[0].description, "");
    }

    #[test]
    fn returns_empty_when_the_separator_line_is_absent() {
        let stdout = " V..... = Video\n V....D libx264              libx264 H.264\n";
        assert_eq!(parse_codec_list(stdout), Vec::new());
        assert_eq!(parse_filter_list(stdout), Vec::<String>::new());
    }

    #[test]
    fn returns_empty_or_none_for_empty_input_without_panicking() {
        assert_eq!(parse_codec_list(""), Vec::new());
        assert_eq!(parse_hwaccel_list(""), Vec::<String>::new());
        assert_eq!(parse_filter_list(""), Vec::<String>::new());
        assert_eq!(parse_version(""), None);
        assert_eq!(license_flags(&[]), LicenseFlags::default());
    }

    #[test]
    fn parses_a_crlf_encoder_fixture_identically_to_the_lf_version() {
        let crlf_fixture = ENCODERS_FIXTURE.replace('\n', "\r\n");
        assert_eq!(
            parse_codec_list(&crlf_fixture),
            parse_codec_list(ENCODERS_FIXTURE)
        );
    }

    #[test]
    fn parses_the_hwaccel_fixture_and_drops_the_header_line() {
        let methods = parse_hwaccel_list(HWACCELS_FIXTURE);
        assert_eq!(
            methods,
            vec!["videotoolbox".to_owned(), "vulkan".to_owned()]
        );
    }

    #[test]
    fn returns_empty_when_the_hwaccel_header_never_appears() {
        let stdout = "Unrecognized option\nline2\n";
        assert_eq!(parse_hwaccel_list(stdout), Vec::<String>::new());
    }

    #[test]
    fn parses_the_filter_fixture_by_taking_the_second_token_per_row() {
        let filters = parse_filter_list(FILTERS_FIXTURE);
        assert_eq!(
            filters,
            vec![
                "aap".to_owned(),
                "abench".to_owned(),
                "acompressor".to_owned()
            ]
        );
    }

    #[test]
    fn parses_the_version_fixture_into_version_and_configuration_flags() {
        let info = parse_version(VERSION_FIXTURE).unwrap();
        assert_eq!(info.version, "9.0.1");
        assert!(info
            .configuration_flags
            .contains(&"--enable-gpl".to_owned()));
        assert!(info
            .configuration_flags
            .contains(&"--enable-version3".to_owned()));
        assert!(info
            .configuration_flags
            .contains(&"--enable-videotoolbox".to_owned()));
        assert!(!info
            .configuration_flags
            .contains(&"configuration:".to_owned()));
    }

    /// Synthetic `ffprobe -version` output in the shape of a Windows build, not verbatim: CRLF
    /// line ends, a version token with the suffix of its builder, and shortened lines.
    const FFPROBE_VERSION_FIXTURE: &str = "ffprobe version 9.0.2-full_build-www.gyan.dev Copyright (c) 2007-2026 the FFmpeg developers\r
built with gcc\r
configuration: --enable-gpl --enable-version3 --enable-static --enable-libsvtav1\r
";

    #[test]
    fn parses_the_version_line_of_the_named_program_only() {
        let info = parse_program_version(FFPROBE_VERSION_FIXTURE, "ffprobe").unwrap();
        assert_eq!(info.version, "9.0.2-full_build-www.gyan.dev");
        assert_eq!(
            info.configuration_flags,
            [
                "--enable-gpl",
                "--enable-version3",
                "--enable-static",
                "--enable-libsvtav1"
            ]
        );
        assert_eq!(parse_version(FFPROBE_VERSION_FIXTURE), None);
        assert_eq!(parse_program_version(VERSION_FIXTURE, "ffprobe"), None);
        assert_eq!(
            parse_program_version(VERSION_FIXTURE, "ffmpeg"),
            parse_version(VERSION_FIXTURE)
        );
    }

    #[test]
    fn a_longer_name_that_starts_with_the_program_does_not_count() {
        let stdout = "ffmpegx version 1.0\nffprobe-real version 2.0\n";
        assert_eq!(parse_program_version(stdout, "ffmpeg"), None);
        assert_eq!(parse_program_version(stdout, "ffprobe"), None);
    }

    #[test]
    fn an_indented_version_line_after_the_configuration_line_still_parses() {
        let stdout = "configuration: --enable-gpl\n  ffprobe version 9.0.2 Copyright\n";
        let info = parse_program_version(stdout, "ffprobe").unwrap();
        assert_eq!(info.version, "9.0.2");
        assert_eq!(info.configuration_flags, ["--enable-gpl"]);
    }

    #[test]
    fn an_empty_program_name_never_matches() {
        assert_eq!(parse_program_version(VERSION_FIXTURE, ""), None);
        assert_eq!(parse_program_version(" version 1.0\n", ""), None);
    }

    #[test]
    fn computes_license_flags_from_the_real_configuration_line() {
        let info = parse_version(VERSION_FIXTURE).unwrap();
        let flags = license_flags(&info.configuration_flags);
        assert!(flags.gpl);
        assert!(flags.version3);
        assert!(!flags.nonfree);
    }
}
