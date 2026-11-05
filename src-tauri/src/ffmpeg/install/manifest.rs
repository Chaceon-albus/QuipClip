//! The manifest of the `ffmpeg` download (ADR 058).
//!
//! `scripts/ffmpeg-manifest.mjs` writes `src-tauri/resources/ffmpeg-manifest.json` at each
//! release, and the application embeds it when it compiles. It pins each file of the download:
//! the URLs of each archive, its SHA-256 and its size, and the exact entry of each program in the
//! zip, with its method and its size after extraction. The application never asks a source for
//! a version or a SHA-256 at run time.

use crate::ffmpeg::locate::{FFMPEG_NAME, FFPROBE_NAME};
use crate::ffmpeg::LicenseFlags;
use serde::{Deserialize, Deserializer};
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::OnceLock;

/// The text of the manifest, embedded when the application compiles.
const EMBEDDED: &str = include_str!("../../../resources/ffmpeg-manifest.json");

/// The schema version of the manifest that this build reads.
pub const SCHEMA_VERSION: u32 = 1;

/// The largest size of an archive or of a program. A zip with no Zip64 records holds no larger
/// file, and the script refuses Zip64. The cap also keeps the sum of the sizes in a `u64`.
pub const MAX_FILE_SIZE: u64 = u32::MAX as u64;

/// The key of the compile target in the manifest, or `None` for a target with no download. The
/// key names the compile target of QuipClip, not the processor of the computer: Windows on Arm
/// runs the `x86_64` build, so it gets the `x86_64` download (ADR 058).
pub const CURRENT_TARGET: Option<&str> = if cfg!(all(target_os = "windows", target_arch = "x86_64"))
{
    Some("windows-x86_64")
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    Some("macos-aarch64")
} else {
    None
};

/// The whole manifest.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub targets: BTreeMap<String, Target>,
}

/// The download of one target.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    /// The FFmpeg version, such as `9.0.2`.
    pub version: String,
    /// The host that the consent dialog names, such as `github.com/GyanD/codexffmpeg`.
    pub source: String,
    /// The licence flags of the build, which the install checks against `-version`.
    #[serde(deserialize_with = "strict_license")]
    pub license: LicenseFlags,
    pub archives: Vec<Archive>,
}

/// One zip of a download.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    /// Each URL serves the same bytes. The download tries them in order.
    pub urls: Vec<String>,
    /// The SHA-256 of the zip, in lowercase hexadecimal.
    pub sha256: String,
    /// The size of the zip in bytes.
    pub size: u64,
    pub entries: Entries,
}

/// The programs that one zip holds. A missing key is a program that this zip does not hold.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entries {
    pub ffmpeg: Option<Entry>,
    pub ffprobe: Option<Entry>,
}

/// One program in a zip.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// The exact path of the entry in the zip. The install never uses it as a path on disk.
    pub path: String,
    pub method: Method,
    /// The size of the program after extraction, in bytes.
    pub size: u64,
}

/// The compression method of an entry. The install extracts only these two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Stored,
    Deflate,
}

/// The licence flags as the manifest writes them. Unlike [`LicenseFlags`], which the capability
/// cache also reads, this form refuses an unknown flag.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestLicense {
    gpl: bool,
    version3: bool,
    nonfree: bool,
}

fn strict_license<'de, D: Deserializer<'de>>(deserializer: D) -> Result<LicenseFlags, D::Error> {
    let license = ManifestLicense::deserialize(deserializer)?;
    Ok(LicenseFlags {
        gpl: license.gpl,
        nonfree: license.nonfree,
        version3: license.version3,
    })
}

/// The program that an entry holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Program {
    Ffmpeg,
    Ffprobe,
}

impl Program {
    /// Both programs, in the order of the install: `ffprobe` first and `ffmpeg` last (ADR 058).
    pub const INSTALL_ORDER: [Self; 2] = [Self::Ffprobe, Self::Ffmpeg];

    /// The name of the program, as `-version` prints it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }

    /// The file name of the program on this platform, the name that discovery searches for.
    #[must_use]
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => FFMPEG_NAME,
            Self::Ffprobe => FFPROBE_NAME,
        }
    }

    /// The file name of the program in the archives of the target `key` of the manifest.
    fn file_name_in(self, key: &str) -> String {
        if key.starts_with("windows-") {
            format!("{}.exe", self.name())
        } else {
            self.name().to_owned()
        }
    }
}

impl Entries {
    /// The entry of `program`, when this zip holds it.
    #[must_use]
    pub fn get(&self, program: Program) -> Option<&Entry> {
        match program {
            Program::Ffmpeg => self.ffmpeg.as_ref(),
            Program::Ffprobe => self.ffprobe.as_ref(),
        }
    }
}

impl Target {
    /// The total size of the archives, which the consent dialog shows. The size cap of the
    /// validation keeps the sum in a `u64`.
    #[must_use]
    pub fn download_size(&self) -> u64 {
        self.archives.iter().map(|archive| archive.size).sum()
    }

    /// The archive that holds `program`, and its entry. Validation gives each program exactly
    /// one archive.
    #[must_use]
    pub fn entry(&self, program: Program) -> Option<(&Archive, &Entry)> {
        self.archives
            .iter()
            .find_map(|archive| archive.entries.get(program).map(|entry| (archive, entry)))
    }

    /// True when `printed`, the version token of `-version`, is the version of this target: the
    /// same text, or that text and then a character that is neither a digit nor a dot. So
    /// `9.0.2-full_build-www.gyan.dev` is `9.0.2`, and `9.0.20` and `9.0.2.1` are not.
    #[must_use]
    pub fn is_version_of(&self, printed: &str) -> bool {
        printed
            .strip_prefix(self.version.as_str())
            .is_some_and(|rest| {
                rest.chars()
                    .next()
                    .is_none_or(|next| !next.is_ascii_digit() && next != '.')
            })
    }
}

/// A fault of the manifest. A test checks the embedded manifest, so a release never ships one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    Parse(String),
    SchemaVersion(u32),
    Invalid { target: String, reason: String },
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => write!(formatter, "the manifest does not parse: {error}"),
            Self::SchemaVersion(version) => write!(
                formatter,
                "the manifest has schema version {version}, not {SCHEMA_VERSION}"
            ),
            Self::Invalid { target, reason } => {
                write!(
                    formatter,
                    "the target {target} of the manifest is invalid: {reason}"
                )
            }
        }
    }
}

impl std::error::Error for ManifestError {}

/// The schema version alone, read before the strict parse, so a later schema gives its own
/// error and not a parse error.
#[derive(Deserialize)]
struct SchemaOnly {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
}

/// Parse and validate the text of a manifest.
pub fn parse(text: &str) -> Result<Manifest, ManifestError> {
    let schema: SchemaOnly =
        serde_json::from_str(text).map_err(|error| ManifestError::Parse(error.to_string()))?;
    if schema.schema_version != SCHEMA_VERSION {
        return Err(ManifestError::SchemaVersion(schema.schema_version));
    }
    let manifest: Manifest =
        serde_json::from_str(text).map_err(|error| ManifestError::Parse(error.to_string()))?;
    for (key, target) in &manifest.targets {
        validate_target(key, target).map_err(|reason| ManifestError::Invalid {
            target: key.clone(),
            reason,
        })?;
    }
    Ok(manifest)
}

/// The embedded manifest, parsed once. A fault gives `None` and a log line, and the application
/// then offers no download.
#[must_use]
pub fn embedded() -> Option<&'static Manifest> {
    static PARSED: OnceLock<Option<Manifest>> = OnceLock::new();
    PARSED
        .get_or_init(|| match parse(EMBEDDED) {
            Ok(manifest) => Some(manifest),
            Err(error) => {
                eprintln!("install: {error}");
                None
            }
        })
        .as_ref()
}

/// The download of the compile target, or `None` when this target has none.
#[must_use]
pub fn current_target() -> Option<&'static Target> {
    let key = CURRENT_TARGET?;
    embedded()?.targets.get(key)
}

/// Check one target: a version, a source, at least one archive, no URL or SHA-256 twice, and
/// each program in exactly one archive.
fn validate_target(key: &str, target: &Target) -> Result<(), String> {
    if !is_version(&target.version) {
        return Err(format!(
            "the version {:?} is not a release version",
            target.version
        ));
    }
    if target.source.trim().is_empty() {
        return Err("the source is empty".to_owned());
    }
    if target.archives.is_empty() {
        return Err("it has no archive".to_owned());
    }
    let mut urls = HashSet::new();
    let mut hashes = HashSet::new();
    for (index, archive) in target.archives.iter().enumerate() {
        validate_archive(key, archive).map_err(|reason| format!("archive {index}: {reason}"))?;
        if !hashes.insert(archive.sha256.as_str()) {
            return Err(format!(
                "archive {index}: its SHA-256 is also in another archive"
            ));
        }
        for url in &archive.urls {
            if !urls.insert(url.as_str()) {
                return Err(format!("archive {index}: the URL {url} is there twice"));
            }
        }
    }
    for program in Program::INSTALL_ORDER {
        let count = target
            .archives
            .iter()
            .filter(|archive| archive.entries.get(program).is_some())
            .count();
        if count != 1 {
            return Err(format!(
                "{} is in {count} archives, not one",
                program.name()
            ));
        }
    }
    Ok(())
}

/// Check one archive of the target `key`: HTTPS URLs with no user name, a SHA-256 of 64
/// lowercase hexadecimal digits, a size, and at least one program, each in an entry whose file
/// name is the name of that program.
fn validate_archive(key: &str, archive: &Archive) -> Result<(), String> {
    if archive.urls.is_empty() {
        return Err("it has no URL".to_owned());
    }
    for url in &archive.urls {
        let parsed = reqwest::Url::parse(url)
            .map_err(|error| format!("the URL {url} is invalid: {error}"))?;
        if parsed.scheme() != "https" || parsed.host_str().is_none_or(str::is_empty) {
            return Err(format!("the URL {url} is not an HTTPS address"));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(format!("the URL {url} holds a user name"));
        }
    }
    let is_hex = archive.sha256.len() == 64
        && archive
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !is_hex {
        return Err(format!(
            "the SHA-256 {:?} is not 64 lowercase hexadecimal digits",
            archive.sha256
        ));
    }
    if archive.size == 0 || archive.size > MAX_FILE_SIZE {
        return Err(format!("the size {} is out of range", archive.size));
    }
    // The file name check below also keeps the two entries of one archive apart, because the
    // two programs have two names.
    let mut programs = 0;
    for program in Program::INSTALL_ORDER {
        let Some(entry) = archive.entries.get(program) else {
            continue;
        };
        if entry.size == 0 || entry.size > MAX_FILE_SIZE {
            return Err(format!(
                "the size {} of {} is out of range",
                entry.size,
                program.name()
            ));
        }
        let file_name = program.file_name_in(key);
        if entry.path.rsplit('/').next() != Some(file_name.as_str()) {
            return Err(format!(
                "the entry {:?} of {} is not a file named {file_name}",
                entry.path,
                program.name()
            ));
        }
        programs += 1;
    }
    if programs == 0 {
        return Err("it holds no program".to_owned());
    }
    Ok(())
}

/// True for a release version of one to three numbers, such as `9.0` or `9.0.2`.
fn is_version(version: &str) -> bool {
    let mut parts = 0;
    for part in version.split('.') {
        parts += 1;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
    }
    parts <= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b";
    const OTHER_HASH: &str = "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924";

    fn manifest_text(target: &str) -> String {
        format!(r#"{{ "schemaVersion": 1, "targets": {{ "windows-x86_64": {target} }} }}"#)
    }

    fn target_text(archives: &str) -> String {
        format!(
            r#"{{ "version": "9.0.2", "source": "github.com/GyanD/codexffmpeg",
                 "license": {{ "gpl": true, "version3": true, "nonfree": false }},
                 "archives": [{archives}] }}"#
        )
    }

    fn archive_text(url: &str, sha256: &str, entries: &str) -> String {
        format!(
            r#"{{ "urls": ["{url}"], "sha256": "{sha256}", "size": 10, "entries": {{ {entries} }} }}"#
        )
    }

    const BOTH: &str = r#""ffmpeg": { "path": "a/bin/ffmpeg.exe", "method": "deflate", "size": 5 },
                          "ffprobe": { "path": "a/bin/ffprobe.exe", "method": "stored", "size": 4 }"#;

    fn valid() -> String {
        manifest_text(&target_text(&archive_text(
            "https://example.test/a.zip",
            HASH,
            BOTH,
        )))
    }

    /// The reason of a manifest that is refused as invalid.
    fn invalid(text: &str) -> String {
        match parse(text) {
            Err(ManifestError::Invalid { target, reason }) => {
                assert_eq!(target, "windows-x86_64");
                reason
            }
            other => panic!("not refused as invalid: {other:?}"),
        }
    }

    #[test]
    fn the_embedded_manifest_is_valid_and_covers_each_release_target() {
        let manifest = parse(EMBEDDED).unwrap();
        for key in ["windows-x86_64", "macos-aarch64"] {
            let target = &manifest.targets[key];
            assert!(target.download_size() > 0, "{key}");
            assert!(
                !target.license.nonfree,
                "{key}: a nonfree build cannot be distributed"
            );
            for program in Program::INSTALL_ORDER {
                assert!(target.entry(program).is_some(), "{key}");
            }
        }
        assert_eq!(
            embedded().map(|manifest| manifest.targets.len()),
            Some(manifest.targets.len())
        );
    }

    #[test]
    fn the_current_target_is_the_platform_of_the_test_run() {
        // Built from the platform of the run, not from the `cfg!` of `CURRENT_TARGET`, so a
        // fault in that `cfg!` fails here on the release platform that it affects.
        let key = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        let has_entry = parse(EMBEDDED).unwrap().targets.contains_key(&key);
        assert_eq!(CURRENT_TARGET.is_some(), has_entry, "{key}");
        if let Some(current) = CURRENT_TARGET {
            assert_eq!(current, key);
            assert!(current_target().is_some());
        }
    }

    #[test]
    fn a_valid_target_parses_with_its_fields() {
        let manifest = parse(&valid()).unwrap();
        let target = &manifest.targets["windows-x86_64"];
        assert_eq!(target.version, "9.0.2");
        assert_eq!(target.download_size(), 10);
        assert!(target.license.gpl && target.license.version3 && !target.license.nonfree);
        let (archive, entry) = target.entry(Program::Ffmpeg).unwrap();
        assert_eq!(archive.urls, ["https://example.test/a.zip"]);
        assert_eq!(entry.method, Method::Deflate);
        assert_eq!(
            target.entry(Program::Ffprobe).unwrap().1.method,
            Method::Stored
        );
        assert_eq!(target.entry(Program::Ffprobe).unwrap().1.size, 4);
    }

    #[test]
    fn programs_in_two_archives_parse() {
        let ffmpeg = archive_text(
            "https://example.test/ffmpeg.zip",
            HASH,
            r#""ffmpeg": { "path": "ffmpeg.exe", "method": "deflate", "size": 9 }"#,
        );
        let ffprobe = archive_text(
            "https://example.test/ffprobe.zip",
            OTHER_HASH,
            r#""ffprobe": { "path": "ffprobe.exe", "method": "deflate", "size": 8 }"#,
        );
        let text = manifest_text(&target_text(&format!("{ffmpeg}, {ffprobe}")));
        let manifest = parse(&text).unwrap();
        let target = &manifest.targets["windows-x86_64"];
        assert_eq!(target.download_size(), 20);
        assert_eq!(
            target.entry(Program::Ffprobe).unwrap().0.urls,
            ["https://example.test/ffprobe.zip"]
        );
    }

    #[test]
    fn an_unknown_field_at_any_level_is_refused() {
        let text = valid();
        for (from, to) in [
            ("\"schemaVersion\"", "\"extra\": 1, \"schemaVersion\""),
            ("\"version\"", "\"extra\": 1, \"version\""),
            ("\"urls\"", "\"extra\": 1, \"urls\""),
            ("\"ffmpeg\": {", "\"ffplay\": null, \"ffmpeg\": {"),
            (
                "\"method\": \"deflate\"",
                "\"method\": \"deflate\", \"extra\": 1",
            ),
            ("\"nonfree\": false", "\"nonfree\": false, \"lgpl\": true"),
            ("\"deflate\"", "\"lzma\""),
        ] {
            let changed = text.replacen(from, to, 1);
            assert_ne!(changed, text, "{from}");
            assert!(
                matches!(parse(&changed), Err(ManifestError::Parse(_))),
                "{to}"
            );
        }
    }

    #[test]
    fn another_schema_version_gives_its_own_error() {
        let later = valid()
            .replacen("\"schemaVersion\": 1", "\"schemaVersion\": 2", 1)
            .replacen("\"version\"", "\"newField\": 1, \"version\"", 1);
        assert_eq!(parse(&later), Err(ManifestError::SchemaVersion(2)));
    }

    #[test]
    fn each_invalid_value_is_refused_with_its_target() {
        let archive = |url: &str, sha: &str, entries: &str| {
            manifest_text(&target_text(&archive_text(url, sha, entries)))
        };
        let url = "https://example.test/a.zip";
        assert!(invalid(&archive("http://example.test/a.zip", HASH, BOTH)).contains("HTTPS"));
        assert!(invalid(&archive("not a url", HASH, BOTH)).contains("invalid"));
        assert!(
            invalid(&archive("https://user:pw@example.test/a.zip", HASH, BOTH))
                .contains("user name")
        );
        assert!(invalid(&archive(url, &HASH.to_uppercase(), BOTH)).contains("SHA-256"));
        assert!(invalid(&archive(url, &HASH[..63], BOTH)).contains("SHA-256"));
        let only_ffmpeg = r#""ffmpeg": { "path": "ffmpeg.exe", "method": "deflate", "size": 9 }"#;
        assert!(invalid(&archive(url, HASH, only_ffmpeg)).contains("ffprobe is in 0 archives"));
        assert!(invalid(&archive(url, HASH, "")).contains("holds no program"));
        let empty_size = BOTH.replacen("\"size\": 5", "\"size\": 0", 1);
        assert!(invalid(&archive(url, HASH, &empty_size)).contains("out of range"));
        let huge = BOTH.replacen("\"size\": 5", "\"size\": 4294967296", 1);
        assert!(invalid(&archive(url, HASH, &huge)).contains("out of range"));
        let swapped = BOTH.replacen("a/bin/ffmpeg.exe", "a/bin/ffprobe.exe", 1);
        assert!(invalid(&archive(url, HASH, &swapped)).contains("not a file named ffmpeg.exe"));
        let no_exe = BOTH.replacen("a/bin/ffmpeg.exe", "a/bin/ffmpeg", 1);
        assert!(invalid(&archive(url, HASH, &no_exe)).contains("not a file named"));

        let base = valid();
        assert!(invalid(&base.replacen("\"9.0.2\"", "\"latest\"", 1)).contains("release version"));
        assert!(invalid(&base.replacen("\"9.0.2\"", "\"9.0.2.1\"", 1)).contains("release version"));
        let blank = base.replacen("\"github.com/GyanD/codexffmpeg\"", "\" \"", 1);
        assert!(invalid(&blank).contains("source is empty"));
        assert!(invalid(&base.replacen("\"size\": 10", "\"size\": 0", 1)).contains("out of range"));
        assert!(invalid(&base.replacen(&format!("[\"{url}\"]"), "[]", 1)).contains("no URL"));
        let no_archive = manifest_text(&target_text(""));
        assert!(invalid(&no_archive).contains("no archive"));
        let twice = |second_url: &str, second_hash: &str| {
            manifest_text(&target_text(&format!(
                "{}, {}",
                archive_text(url, HASH, BOTH),
                archive_text(second_url, second_hash, BOTH)
            )))
        };
        assert!(invalid(&twice("https://example.test/b.zip", OTHER_HASH)).contains("in 2 archives"));
        assert!(invalid(&twice("https://example.test/b.zip", HASH)).contains("SHA-256 is also"));
        assert!(invalid(&twice(url, OTHER_HASH)).contains("there twice"));
    }

    #[test]
    fn a_macos_target_takes_the_names_with_no_suffix() {
        let text = valid()
            .replacen("windows-x86_64", "macos-aarch64", 1)
            .replacen("a/bin/ffmpeg.exe", "ffmpeg", 1)
            .replacen("a/bin/ffprobe.exe", "ffprobe", 1);
        assert!(parse(&text).is_ok());
    }

    #[test]
    fn a_printed_version_matches_only_up_to_the_end_of_its_number() {
        let manifest = parse(&valid()).unwrap();
        let target = &manifest.targets["windows-x86_64"];
        for printed in [
            "9.0.2",
            "9.0.2-full_build-www.gyan.dev",
            "9.0.2-https://www.martin-riedl.de",
        ] {
            assert!(target.is_version_of(printed), "{printed}");
        }
        for printed in ["9.0.20", "9.0.2.1", "9.0", "8.1.3", "N-128220-gbea9d176f7"] {
            assert!(!target.is_version_of(printed), "{printed}");
        }
    }

    #[test]
    fn the_install_order_puts_ffmpeg_last_and_uses_the_names_of_discovery() {
        assert_eq!(Program::INSTALL_ORDER, [Program::Ffprobe, Program::Ffmpeg]);
        assert_eq!(Program::Ffmpeg.name(), "ffmpeg");
        assert_eq!(Program::Ffprobe.name(), "ffprobe");
        assert_eq!(Program::Ffmpeg.file_name(), FFMPEG_NAME);
        assert_eq!(Program::Ffprobe.file_name(), FFPROBE_NAME);
        assert_eq!(Program::Ffmpeg.file_name_in("windows-x86_64"), "ffmpeg.exe");
        assert_eq!(Program::Ffprobe.file_name_in("macos-aarch64"), "ffprobe");
    }
}
