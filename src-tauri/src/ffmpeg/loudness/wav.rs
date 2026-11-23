//! The reader of the WAV header that the audio process of an export writes (ADR 043, ADR 061).
//!
//! The audio process writes 32-bit float PCM in a WAV container to its stdout. FFmpeg cannot seek
//! back on a pipe, so it writes `0xFFFFFFFF` as the size of the RIFF chunk and as the size of the
//! `data` chunk. The reader uses neither size. It reads the chunks in front of `data`, and the
//! samples follow the header of `data` to the end of the stream ([`super::meter`]).
//!
//! FFmpeg writes a plain header (format 3) for one channel and for two channels at 48000 Hz or
//! below. It writes a `WAVE_FORMAT_EXTENSIBLE` header with a channel mask for more channels, and
//! for any channel count above 48000 Hz: mono then has the mask of the centre (`0x4`), and stereo
//! the masks of left and right (`0x3`). A layout that no mask names, such as `downmix`, gets an
//! extensible header with the mask 0. A `LIST` chunk with the name of the encoder comes between
//! `fmt ` and `data`.
//!
//! The `LIST` chunk also holds the metadata of the output. FFmpeg writes its size only when the
//! whole chunk fits in its output buffer, so a long title gives the size `0xFFFFFFFF` on a pipe.
//! Neither this reader nor the WAV demuxer of FFmpeg can read past such a chunk, so the command
//! of the audio process must write no metadata (`-map_metadata -1`).

use std::io::{self, Read};

/// The format tag of 32-bit float PCM, `WAVE_FORMAT_IEEE_FLOAT`.
const FORMAT_IEEE_FLOAT: u16 = 0x0003;

/// The format tag of a header that names its format in a sub-format GUID,
/// `WAVE_FORMAT_EXTENSIBLE`.
const FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// The sub-format GUID of 32-bit float PCM, `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT`, in the byte order of
/// a WAV header.
const SUBFORMAT_IEEE_FLOAT: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/// The length of the `fmt ` chunk of a plain header, without the size of its extension.
const PLAIN_FORMAT_BYTES: usize = 16;

/// The length of the `fmt ` chunk of a `WAVE_FORMAT_EXTENSIBLE` header.
const EXTENSIBLE_FORMAT_BYTES: usize = 40;

/// The largest `fmt ` chunk the reader accepts. A valid header has at most
/// [`EXTENSIBLE_FORMAT_BYTES`]. The bound keeps a damaged size from making the reader allocate.
const MAX_FORMAT_BYTES: u32 = 1024;

/// The most bytes that the reader skips in the chunks other than `fmt ` before `data`. FFmpeg
/// writes one `LIST` chunk of some tens of bytes there. The bound ends the read of a stream that
/// is not the stream of the audio process.
const MAX_SKIPPED_BYTES: u64 = 1024 * 1024;

/// The most channels the reader accepts: the limit of the meter.
pub const MAX_CHANNELS: u16 = 64;

/// The bytes of one sample: 32-bit float.
pub const SAMPLE_BYTES: usize = 4;

/// The format of a WAV stream of 32-bit float PCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    /// The sample rate in hertz.
    pub sample_rate: u32,
    /// The number of channels, from 1 to [`MAX_CHANNELS`].
    pub channels: u16,
    /// The channel mask of a `WAVE_FORMAT_EXTENSIBLE` header, or `None` for a plain header and for
    /// the mask 0. The samples of a frame come in the order of the bits of the mask, from the
    /// lowest bit.
    pub channel_mask: Option<u32>,
}

impl WavFormat {
    /// The bytes of one frame: one sample of each channel.
    #[must_use]
    pub fn frame_bytes(&self) -> usize {
        usize::from(self.channels) * SAMPLE_BYTES
    }
}

/// Why [`read_header`] read no format.
#[derive(Debug)]
pub enum WavError {
    /// The stream failed. The end of the stream before the `data` chunk is not this error: it is
    /// [`WavError::Invalid`].
    Read(io::Error),
    /// The stream is not a WAV stream of 32-bit float PCM that the meter can read. The text names
    /// the fault, in English, for a diagnostic (ADR 011).
    Invalid(String),
}

impl std::fmt::Display for WavError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "the WAV stream could not be read: {error}"),
            Self::Invalid(fault) => write!(formatter, "the WAV header is not valid: {fault}"),
        }
    }
}

fn invalid(fault: impl Into<String>) -> WavError {
    WavError::Invalid(fault.into())
}

/// Read the header of a WAV stream, up to and including the header of its `data` chunk.
///
/// After a success, the next byte of `reader` is the first byte of the first sample. The function
/// reads the chunks in their order. It reads one `fmt ` chunk, skips each other chunk before
/// `data`, and stops at the header of `data`. It does not read the size of the RIFF chunk or the
/// size of the `data` chunk.
///
/// # Errors
///
/// [`WavError::Read`] when `reader` fails. [`WavError::Invalid`] when the stream ends before the
/// `data` chunk, when it is not RIFF WAVE, when `fmt ` is missing, repeated, too long, or names a
/// format other than 32-bit float PCM, or when the chunks before `data` hold more than
/// [`MAX_SKIPPED_BYTES`].
pub fn read_header(reader: &mut impl Read) -> Result<WavFormat, WavError> {
    let riff: [u8; 12] = read_array(reader, "the RIFF header")?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(invalid("the stream does not start with RIFF WAVE"));
    }
    let mut format = None;
    let mut skipped: u64 = 0;
    loop {
        let header: [u8; 8] = read_array(reader, "a chunk header")?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        match &header[0..4] {
            b"data" => {
                return format.ok_or_else(|| invalid("the data chunk comes before the fmt chunk"));
            }
            b"fmt " => {
                if format.is_some() {
                    return Err(invalid("the stream has two fmt chunks"));
                }
                if size > MAX_FORMAT_BYTES {
                    return Err(invalid(format!("the fmt chunk has {size} bytes")));
                }
                let mut body = vec![0; size as usize];
                read_exact(reader, &mut body, "the fmt chunk")?;
                skip(reader, u64::from(size & 1), "the pad byte of the fmt chunk")?;
                format = Some(parse_format(&body)?);
            }
            id => {
                // A chunk with an odd size has a pad byte after it.
                let padded = u64::from(size) + u64::from(size & 1);
                skipped += 8 + padded;
                if skipped > MAX_SKIPPED_BYTES {
                    return Err(invalid(format!(
                        "the chunks before the data chunk hold more than {MAX_SKIPPED_BYTES} bytes"
                    )));
                }
                let name = String::from_utf8_lossy(id).into_owned();
                skip(reader, padded, &format!("the chunk {name:?}"))?;
            }
        }
    }
}

/// Read the format of a `fmt ` chunk.
fn parse_format(body: &[u8]) -> Result<WavFormat, WavError> {
    if body.len() < PLAIN_FORMAT_BYTES {
        return Err(invalid(format!("the fmt chunk has {} bytes", body.len())));
    }
    let u16_at = |at: usize| u16::from_le_bytes([body[at], body[at + 1]]);
    let u32_at =
        |at: usize| u32::from_le_bytes([body[at], body[at + 1], body[at + 2], body[at + 3]]);
    let tag = u16_at(0);
    let channels = u16_at(2);
    let sample_rate = u32_at(4);
    let block_align = u16_at(12);
    let bits = u16_at(14);
    if bits != 32 {
        return Err(invalid(format!("the samples have {bits} bits, not 32")));
    }
    if channels == 0 || channels > MAX_CHANNELS {
        return Err(invalid(format!("the stream has {channels} channels")));
    }
    if sample_rate == 0 {
        return Err(invalid("the sample rate is 0"));
    }
    if usize::from(block_align) != usize::from(channels) * SAMPLE_BYTES {
        return Err(invalid(format!(
            "a frame of {channels} channels has {block_align} bytes"
        )));
    }
    let channel_mask = match tag {
        FORMAT_IEEE_FLOAT => None,
        FORMAT_EXTENSIBLE => {
            if body.len() < EXTENSIBLE_FORMAT_BYTES {
                return Err(invalid(format!(
                    "the extensible fmt chunk has {} bytes",
                    body.len()
                )));
            }
            // `cbSize` counts the bytes of the extension after the first 18 bytes. The extension
            // of `WAVE_FORMAT_EXTENSIBLE` has at least 22, and it must fit in the chunk.
            let extension = usize::from(u16_at(16));
            if extension < EXTENSIBLE_FORMAT_BYTES - PLAIN_FORMAT_BYTES - 2
                || PLAIN_FORMAT_BYTES + 2 + extension > body.len()
            {
                return Err(invalid(format!(
                    "the extension of {extension} bytes does not fit an extensible fmt chunk of {} bytes",
                    body.len()
                )));
            }
            if body[24..40] != SUBFORMAT_IEEE_FLOAT {
                return Err(invalid("the sub-format is not 32-bit float"));
            }
            Some(u32_at(20)).filter(|mask| *mask != 0)
        }
        other => {
            return Err(invalid(format!(
                "the format tag {other:#06x} is not 32-bit float"
            )))
        }
    };
    Ok(WavFormat {
        sample_rate,
        channels,
        channel_mask,
    })
}

/// Read `N` bytes. The end of the stream is [`WavError::Invalid`], with `what` in its text.
fn read_array<const N: usize>(reader: &mut impl Read, what: &str) -> Result<[u8; N], WavError> {
    let mut bytes = [0; N];
    read_exact(reader, &mut bytes, what)?;
    Ok(bytes)
}

fn read_exact(reader: &mut impl Read, bytes: &mut [u8], what: &str) -> Result<(), WavError> {
    reader.read_exact(bytes).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            invalid(format!("the stream ended in {what}"))
        } else {
            WavError::Read(error)
        }
    })
}

/// Read and drop `count` bytes.
fn skip(reader: &mut impl Read, count: u64, what: &str) -> Result<(), WavError> {
    let copied = io::copy(&mut reader.take(count), &mut io::sink()).map_err(WavError::Read)?;
    if copied < count {
        return Err(invalid(format!("the stream ended in {what}")));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Decode a string of hexadecimal digits.
    pub(crate) fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }

    /// The headers that FFmpeg 9.0.2 writes to a pipe for `-c:a pcm_f32le -f wav pipe:1` at 48000
    /// Hz, or at 96000 Hz for a name with `@96k`, up to and including the header of `data`, for
    /// the layouts in their names. Each one has the `LIST` chunk with the name of the encoder.
    const LIST_AND_DATA: &str =
        "4c4953541a000000494e464f495346540d0000004c61766636332e312e313032000064617461ffffffff";
    pub(crate) fn ffmpeg_header(layout: &str) -> Vec<u8> {
        let format = match layout {
            "mono" => "666d7420120000000300010080bb000000ee0200040020000000",
            "stereo" => "666d7420120000000300020080bb000000dc0500080020000000",
            "5.1" => concat!(
                "666d742028000000feff060080bb000000941100180020001600200",
                "03f0000000300000000001000800000aa00389b71"
            ),
            "5.1(side)" => concat!(
                "666d742028000000feff060080bb000000941100180020001600200",
                "00f0600000300000000001000800000aa00389b71"
            ),
            "7.1" => concat!(
                "666d742028000000feff080080bb000000701700200020001600200",
                "03f0600000300000000001000800000aa00389b71"
            ),
            "downmix" => concat!(
                "666d742028000000feff020080bb000000dc050008002000160020",
                "00000000000300000000001000800000aa00389b71"
            ),
            "mono@96k" => concat!(
                "666d742028000000feff01000077010000dc050004002000160020",
                "00040000000300000000001000800000aa00389b71"
            ),
            "stereo@96k" => concat!(
                "666d742028000000feff02000077010000b80b0008002000160020",
                "00030000000300000000001000800000aa00389b71"
            ),
            other => panic!("no header for {other}"),
        };
        hex(&format!("52494646ffffffff57415645{format}{LIST_AND_DATA}"))
    }

    fn read(bytes: &[u8]) -> Result<WavFormat, WavError> {
        read_header(&mut &bytes[..])
    }

    fn fault(bytes: &[u8]) -> String {
        match read(bytes) {
            Err(WavError::Invalid(fault)) => fault,
            other => panic!("expected an invalid header, got {other:?}"),
        }
    }

    #[test]
    fn the_headers_of_ffmpeg_on_a_pipe_give_their_rate_their_channels_and_their_mask() {
        for (layout, sample_rate, channels, mask) in [
            ("mono", 48_000, 1, None),
            ("stereo", 48_000, 2, None),
            ("5.1", 48_000, 6, Some(0x3f)),
            ("5.1(side)", 48_000, 6, Some(0x60f)),
            ("7.1", 48_000, 8, Some(0x63f)),
            ("downmix", 48_000, 2, None),
            ("mono@96k", 96_000, 1, Some(0x4)),
            ("stereo@96k", 96_000, 2, Some(0x3)),
        ] {
            let format = read(&ffmpeg_header(layout)).unwrap();
            assert_eq!(
                format,
                WavFormat {
                    sample_rate,
                    channels,
                    channel_mask: mask,
                },
                "{layout}"
            );
            assert_eq!(format.frame_bytes(), usize::from(channels) * 4, "{layout}");
        }
    }

    #[test]
    fn the_extension_of_an_extensible_header_must_be_whole_and_fit_its_chunk() {
        // `cbSize` is at byte 36 of the stream: 12 bytes of RIFF, 8 of the chunk header, 16 of
        // the format.
        let mut none = ffmpeg_header("5.1");
        none[36..38].copy_from_slice(&0u16.to_le_bytes());
        assert!(fault(&none).contains("extension of 0 bytes"));
        let mut beyond = ffmpeg_header("5.1");
        beyond[36..38].copy_from_slice(&40u16.to_le_bytes());
        assert!(fault(&beyond).contains("extension of 40 bytes"));
        // A longer extension that its size declares is read.
        let standard = ffmpeg_header("5.1");
        let mut longer = standard[..16].to_vec();
        longer.extend_from_slice(&44u32.to_le_bytes());
        longer.extend_from_slice(&standard[20..36]);
        longer.extend_from_slice(&26u16.to_le_bytes());
        longer.extend_from_slice(&standard[38..60]);
        longer.extend_from_slice(&[0; 4]);
        longer.extend_from_slice(&standard[60..]);
        assert_eq!(read(&longer).unwrap(), read(&standard).unwrap());
    }

    #[test]
    fn the_reader_stops_at_the_first_sample() {
        let mut bytes = ffmpeg_header("stereo");
        bytes.extend_from_slice(&[1, 2, 3, 4]);
        let mut reader = &bytes[..];
        read_header(&mut reader).unwrap();
        assert_eq!(reader, &[1, 2, 3, 4]);
    }

    #[test]
    fn a_chunk_of_odd_size_before_data_is_skipped_with_its_pad_byte() {
        let mut bytes = hex("52494646ffffffff57415645");
        bytes.extend(hex("666d7420120000000300020080bb000000dc0500080020000000"));
        bytes.extend(b"junk\x03\x00\x00\x00abc\x00");
        bytes.extend(b"data\xff\xff\xff\xff\x09");
        let mut reader = &bytes[..];
        assert_eq!(read_header(&mut reader).unwrap().channels, 2);
        assert_eq!(reader, &[9]);
    }

    #[test]
    fn a_header_that_is_not_float_or_not_whole_is_refused() {
        let stereo = ffmpeg_header("stereo");
        // Not RIFF WAVE.
        assert!(fault(b"RIFX\xff\xff\xff\xffWAVE").contains("RIFF WAVE"));
        // 16-bit integer PCM: tag 1, 16 bits, 4 bytes for each frame.
        let mut pcm16 = stereo.clone();
        pcm16[20..22].copy_from_slice(&1u16.to_le_bytes());
        pcm16[32..34].copy_from_slice(&4u16.to_le_bytes());
        pcm16[34..36].copy_from_slice(&16u16.to_le_bytes());
        assert!(fault(&pcm16).contains("16 bits"));
        // 32-bit integer PCM: 32 bits, but tag 1.
        let mut pcm32 = stereo.clone();
        pcm32[20..22].copy_from_slice(&1u16.to_le_bytes());
        assert!(fault(&pcm32).contains("format tag"));
        // An extensible header whose sub-format is integer PCM.
        let mut integer = ffmpeg_header("5.1");
        integer[44] = 0x01;
        assert!(fault(&integer).contains("sub-format"));
        // No channel, and a frame size that does not fit the channels.
        let mut silent = stereo.clone();
        silent[22..24].copy_from_slice(&0u16.to_le_bytes());
        assert!(fault(&silent).contains("0 channels"));
        let mut misaligned = stereo.clone();
        misaligned[32..34].copy_from_slice(&6u16.to_le_bytes());
        assert!(fault(&misaligned).contains("6 bytes"));
        // No sample rate.
        let mut no_rate = stereo.clone();
        no_rate[24..28].copy_from_slice(&0u32.to_le_bytes());
        assert!(fault(&no_rate).contains("sample rate"));
    }

    #[test]
    fn a_stream_that_ends_or_breaks_its_order_before_data_is_refused() {
        let stereo = ffmpeg_header("stereo");
        // Every cut of the header before the end of the header of `data`.
        for length in 0..stereo.len() {
            let fault = fault(&stereo[..length]);
            assert!(fault.contains("ended"), "{length}: {fault}");
        }
        // `data` before `fmt `.
        let mut early = hex("52494646ffffffff57415645");
        early.extend(b"data\xff\xff\xff\xff");
        assert!(fault(&early).contains("before the fmt chunk"));
        // Two `fmt ` chunks.
        let mut twice = hex("52494646ffffffff57415645");
        let format = hex("666d7420120000000300020080bb000000dc0500080020000000");
        twice.extend(&format);
        twice.extend(&format);
        twice.extend(b"data\xff\xff\xff\xff");
        assert!(fault(&twice).contains("two fmt chunks"));
        // A `fmt ` chunk whose size is not a header.
        let mut huge = hex("52494646ffffffff57415645");
        huge.extend(b"fmt \xff\xff\xff\xff");
        assert!(fault(&huge).contains("fmt chunk has"));
        // Chunks before `data` that never end.
        let mut endless = hex("52494646ffffffff57415645");
        endless.extend(b"junk\x00\x00\x20\x00");
        assert!(fault(&endless).contains("more than"));
    }

    #[test]
    fn a_failed_read_is_a_read_error() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("the pipe broke"))
            }
        }
        assert!(matches!(read_header(&mut Broken), Err(WavError::Read(_))));
    }
}
