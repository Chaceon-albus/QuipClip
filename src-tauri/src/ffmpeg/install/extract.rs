//! The extraction of the programs from a downloaded zip (ADR 059).
//!
//! The extraction reads only the entries that the manifest names, at their exact paths. It
//! writes each one to a file whose name QuipClip chooses, never to the path of the entry, so a
//! name in the zip cannot reach a place outside the install work directory. It checks the method
//! and the size of each entry against the manifest, and the zip reader checks the CRC at the end
//! of each entry.

use super::download::Cancel;
use super::manifest::{Entry, Method};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use zip::result::ZipError;
use zip::{CompressionMethod, ZipArchive};

/// The size of one read of an entry. The cancel is checked between two reads.
const CHUNK_BYTES: usize = 1 << 16;

/// The failure of an extraction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractError {
    /// The zip, or an entry in it, cannot be read: a damaged zip, an entry that is not a file or
    /// that has a password, another method or size than the manifest, or a wrong CRC. A local
    /// failure to open or read the zip also gives it, because ADR 059 has no code of its own for
    /// that. The download checked the SHA-256 first, so this is then the likelier cause. The
    /// text is the diagnostic.
    Archive(String),
    /// The zip has no entry at the path of the manifest.
    EntryMissing(String),
    /// The program could not be written. The text is the diagnostic.
    Write(String),
    Canceled,
}

impl fmt::Display for ExtractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Archive(detail) => write!(formatter, "the zip cannot be read: {detail}"),
            Self::EntryMissing(path) => write!(formatter, "the zip has no entry {path:?}"),
            Self::Write(detail) => write!(formatter, "the program could not be written: {detail}"),
            Self::Canceled => formatter.write_str("the extraction was canceled"),
        }
    }
}

impl std::error::Error for ExtractError {}

/// Extract `entry` of the zip at `zip` into the new file `destination`, which must not exist.
///
/// The call blocks, so run it on the OS thread of the install. On an error, `destination` can
/// hold a part of the program. It lies in the install work directory, which its guard removes.
pub fn extract_entry(
    zip: &Path,
    entry: &Entry,
    destination: &Path,
    cancel: &Cancel,
) -> Result<(), ExtractError> {
    if cancel.is_canceled() {
        return Err(ExtractError::Canceled);
    }
    let file = File::open(zip).map_err(|error| ExtractError::Archive(error.to_string()))?;
    let mut archive = ZipArchive::new(file).map_err(archive_error)?;
    // The exact bytes of the name, as the manifest script read them. `by_name` would also try
    // the decoded name.
    let index = archive
        .index_for_name_raw(entry.path.as_bytes())
        .ok_or_else(|| ExtractError::EntryMissing(entry.path.clone()))?;
    let mut source = archive.by_index(index).map_err(archive_error)?;
    let expected_method = match entry.method {
        Method::Stored => CompressionMethod::Stored,
        Method::Deflate => CompressionMethod::Deflated,
    };
    if !source.is_file() || source.compression() != expected_method {
        return Err(ExtractError::Archive(format!(
            "the entry {:?} is not a file with the method {:?}",
            entry.path, expected_method
        )));
    }
    if source.size() != entry.size {
        return Err(ExtractError::Archive(format!(
            "the entry {:?} has {} bytes, not {}",
            entry.path,
            source.size(),
            entry.size
        )));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| ExtractError::Write(error.to_string()))?;
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut written: u64 = 0;
    loop {
        if cancel.is_canceled() {
            return Err(ExtractError::Canceled);
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(ExtractError::Archive(error.to_string())),
        };
        written += read as u64;
        // The zip reader already refuses to read past the size that this function checked.
        // This check stays as a second guard.
        if written > entry.size {
            return Err(ExtractError::Archive(format!(
                "the entry {:?} holds more than {} bytes",
                entry.path, entry.size
            )));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| ExtractError::Write(error.to_string()))?;
    }
    if written != entry.size {
        return Err(ExtractError::Archive(format!(
            "the entry {:?} gave {written} bytes, not {}",
            entry.path, entry.size
        )));
    }
    output
        .sync_all()
        .map_err(|error| ExtractError::Write(error.to_string()))
}

fn archive_error(error: ZipError) -> ExtractError {
    ExtractError::Archive(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::TestDirectory;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    const PROGRAM: &[u8] = b"MZ\x90\x00 the bytes of a program, long enough to compress well \
        the bytes of a program, long enough to compress well";

    /// Write a zip with `files` at `path`, each with its method.
    fn write_zip(path: &Path, files: &[(&str, &[u8], CompressionMethod)]) {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes, method) in files {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(*method),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        std::fs::write(path, bytes).unwrap();
    }

    fn entry(path: &str, method: Method, size: usize) -> Entry {
        Entry {
            path: path.to_owned(),
            method,
            size: size as u64,
        }
    }

    #[test]
    fn the_named_entry_is_extracted_with_its_exact_bytes() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(
            &zip,
            &[
                ("top/bin/ffmpeg.exe", PROGRAM, CompressionMethod::Deflated),
                (
                    "top/bin/ffprobe.exe",
                    &PROGRAM[..20],
                    CompressionMethod::Stored,
                ),
                (
                    "top/doc/ffmpeg.exe",
                    b"not this one",
                    CompressionMethod::Stored,
                ),
            ],
        );
        let destination = directory.path.join("ffmpeg.exe");
        extract_entry(
            &zip,
            &entry("top/bin/ffmpeg.exe", Method::Deflate, PROGRAM.len()),
            &destination,
            &Cancel::new(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), PROGRAM);

        let probe = directory.path.join("ffprobe.exe");
        extract_entry(
            &zip,
            &entry("top/bin/ffprobe.exe", Method::Stored, 20),
            &probe,
            &Cancel::new(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&probe).unwrap(), &PROGRAM[..20]);
    }

    #[test]
    fn a_missing_entry_another_method_or_another_size_is_refused() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Deflated)]);
        let destination = directory.path.join("out");
        let cancel = Cancel::new();
        assert_eq!(
            extract_entry(
                &zip,
                &entry("ffprobe", Method::Deflate, 5),
                &destination,
                &cancel
            ),
            Err(ExtractError::EntryMissing("ffprobe".to_owned()))
        );
        assert!(matches!(
            extract_entry(
                &zip,
                &entry("ffmpeg", Method::Stored, PROGRAM.len()),
                &destination,
                &cancel
            ),
            Err(ExtractError::Archive(_))
        ));
        assert!(matches!(
            extract_entry(
                &zip,
                &entry("ffmpeg", Method::Deflate, PROGRAM.len() + 1),
                &destination,
                &cancel
            ),
            Err(ExtractError::Archive(_))
        ));
    }

    #[test]
    fn a_damaged_zip_or_a_wrong_crc_is_refused() {
        let directory = TestDirectory::new();
        let destination = directory.path.join("out");
        let cancel = Cancel::new();

        let not_a_zip = directory.path.join("not.zip");
        std::fs::write(&not_a_zip, b"this is not a zip").unwrap();
        assert!(matches!(
            extract_entry(
                &not_a_zip,
                &entry("ffmpeg", Method::Stored, 5),
                &destination,
                &cancel
            ),
            Err(ExtractError::Archive(_))
        ));

        // A stored entry with one byte of its data changed keeps its size, so only the CRC
        // finds the change.
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Stored)]);
        let mut bytes = std::fs::read(&zip).unwrap();
        let at = bytes
            .windows(PROGRAM.len())
            .position(|window| window == PROGRAM)
            .unwrap();
        bytes[at + 4] ^= 0xff;
        std::fs::write(&zip, &bytes).unwrap();
        assert!(matches!(
            extract_entry(
                &zip,
                &entry("ffmpeg", Method::Stored, PROGRAM.len()),
                &destination,
                &cancel
            ),
            Err(ExtractError::Archive(_))
        ));
        // Every byte arrived before the failure, so the check at the end of the entry, the CRC,
        // refused it.
        assert_eq!(
            std::fs::metadata(&destination).unwrap().len(),
            PROGRAM.len() as u64
        );
    }

    #[test]
    fn a_deflated_entry_with_a_wrong_crc_is_refused() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Deflated)]);
        let crc = ZipArchive::new(File::open(&zip).unwrap())
            .unwrap()
            .by_index(0)
            .unwrap()
            .crc32();
        // The CRC is in the local header and in the central directory. Both get the wrong one.
        let mut bytes = std::fs::read(&zip).unwrap();
        let (old, new) = (crc.to_le_bytes(), (crc ^ 1).to_le_bytes());
        let mut changed = 0;
        for at in 0..=bytes.len() - 4 {
            if bytes[at..at + 4] == old {
                bytes[at..at + 4].copy_from_slice(&new);
                changed += 1;
            }
        }
        assert_eq!(changed, 2);
        std::fs::write(&zip, &bytes).unwrap();
        let destination = directory.path.join("out");
        let result = extract_entry(
            &zip,
            &entry("ffmpeg", Method::Deflate, PROGRAM.len()),
            &destination,
            &Cancel::new(),
        );
        assert!(
            matches!(&result, Err(ExtractError::Archive(text)) if text.contains("checksum")),
            "{result:?}"
        );
    }

    #[test]
    fn a_symlink_at_the_path_of_the_program_is_refused() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("ffmpeg", "target", SimpleFileOptions::default())
            .unwrap();
        std::fs::write(&zip, writer.finish().unwrap().into_inner()).unwrap();
        let result = extract_entry(
            &zip,
            &entry("ffmpeg", Method::Stored, "target".len()),
            &directory.path.join("out"),
            &Cancel::new(),
        );
        assert!(
            matches!(result, Err(ExtractError::Archive(_))),
            "{result:?}"
        );
    }

    #[test]
    fn an_existing_destination_is_not_written_over() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Deflated)]);
        let destination = directory.path.join("out");
        std::fs::write(&destination, b"keep").unwrap();
        let result = extract_entry(
            &zip,
            &entry("ffmpeg", Method::Deflate, PROGRAM.len()),
            &destination,
            &Cancel::new(),
        );
        assert!(matches!(result, Err(ExtractError::Write(_))), "{result:?}");
        assert_eq!(std::fs::read(&destination).unwrap(), b"keep");
    }

    #[test]
    fn a_cancel_stops_the_extraction() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Deflated)]);
        let cancel = Cancel::new();
        cancel.cancel();
        let destination = directory.path.join("out");
        assert_eq!(
            extract_entry(
                &zip,
                &entry("ffmpeg", Method::Deflate, PROGRAM.len()),
                &destination,
                &cancel
            ),
            Err(ExtractError::Canceled)
        );
        assert!(
            !destination.exists(),
            "a cancel before the start writes nothing"
        );
    }

    #[test]
    fn a_destination_that_cannot_be_created_is_a_write_failure() {
        let directory = TestDirectory::new();
        let zip = directory.path.join("a.zip");
        write_zip(&zip, &[("ffmpeg", PROGRAM, CompressionMethod::Deflated)]);
        assert!(matches!(
            extract_entry(
                &zip,
                &entry("ffmpeg", Method::Deflate, PROGRAM.len()),
                &directory.path.join("missing").join("out"),
                &Cancel::new()
            ),
            Err(ExtractError::Write(_))
        ));
    }
}
