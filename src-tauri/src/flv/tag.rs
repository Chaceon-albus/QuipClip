//! The byte layout of an FLV file: the file header, the tag header, and what a tag holds.
//!
//! An FLV file is a 9-byte header, a 4-byte `PreviousTagSize0` of zero, and then tags. Each tag
//! is an 11-byte header, `data_size` bytes of data, and a 4-byte `PreviousTagSize` that repeats
//! the length of the tag (11 + `data_size`). That trailing length is what lets a reader find tag
//! boundaries from an arbitrary byte offset and walk backward (see `scan`).
//!
//! The timestamp of a tag is its decode time in milliseconds. A video tag of H.264 or HEVC also
//! carries a composition time offset, so its presentation time is the timestamp plus that offset
//! (ADR 046). Its frame data is a chain of NAL units, each after its length, and its decoder
//! configuration gives the size of that length.

/// The signature at the start of every FLV file.
pub const SIGNATURE: &[u8; 3] = b"FLV";
/// The length of the fixed part of the file header.
pub const FILE_HEADER_LEN: usize = 9;
/// The length of a tag header.
pub const TAG_HEADER_LEN: usize = 11;
/// The length of the `PreviousTagSize` field after each tag, and of `PreviousTagSize0`.
pub const PREVIOUS_TAG_SIZE_LEN: usize = 4;
/// The bytes of tag data that [`classify`] reads. An enhanced H.264 frame needs eight: the
/// header byte, the FourCC, and the 24-bit composition time.
pub const ROLE_PREFIX_LEN: usize = 8;

const TAG_TYPE_AUDIO: u8 = 8;
const TAG_TYPE_VIDEO: u8 = 9;
const TAG_TYPE_SCRIPT: u8 = 18;

/// The fields of the file header that the reader uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHeader {
    pub has_audio: bool,
    pub has_video: bool,
    /// The offset of the first byte after the header, where `PreviousTagSize0` starts.
    pub data_offset: u32,
}

impl FileHeader {
    /// The offset of the first tag.
    pub fn first_tag_offset(&self) -> u64 {
        u64::from(self.data_offset) + PREVIOUS_TAG_SIZE_LEN as u64
    }
}

/// Parse the file header, or return `None` when the bytes are not an FLV header.
pub fn parse_file_header(bytes: &[u8]) -> Option<FileHeader> {
    if bytes.len() < FILE_HEADER_LEN || &bytes[..3] != SIGNATURE {
        return None;
    }
    let data_offset = u32::from_be_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]);
    if (data_offset as usize) < FILE_HEADER_LEN {
        return None;
    }
    Some(FileHeader {
        has_audio: bytes[4] & 0x04 != 0,
        has_video: bytes[4] & 0x01 != 0,
        data_offset,
    })
}

/// The three kinds of FLV tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TagKind {
    Audio,
    Video,
    Script,
}

/// The fields of a tag header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TagHeader {
    pub kind: TagKind,
    pub data_size: u32,
    /// The decode time in milliseconds: 24 bits and an 8-bit extension above them.
    pub timestamp: u32,
}

impl TagHeader {
    /// The length of the whole tag on disk, with its trailing `PreviousTagSize`.
    pub fn total_len(&self) -> u64 {
        TAG_HEADER_LEN as u64 + u64::from(self.data_size) + PREVIOUS_TAG_SIZE_LEN as u64
    }

    /// The value that the trailing `PreviousTagSize` of this tag must hold.
    pub fn previous_tag_size(&self) -> u32 {
        TAG_HEADER_LEN as u32 + self.data_size
    }
}

/// Parse a tag header, or return `None` when the bytes cannot be one.
///
/// The checks are strict on purpose, because a resync tries this at arbitrary offsets inside tag
/// data: the type must be audio, video or script with the reserved bits and the filter
/// (encryption) bit clear, and the stream id must be 0, as the specification requires. An
/// encrypted FLV is therefore not readable, which no recorder that QuipClip targets writes.
pub fn parse_tag_header(bytes: &[u8]) -> Option<TagHeader> {
    if bytes.len() < TAG_HEADER_LEN || bytes[8..11] != [0, 0, 0] {
        return None;
    }
    let kind = match bytes[0] {
        TAG_TYPE_AUDIO => TagKind::Audio,
        TAG_TYPE_VIDEO => TagKind::Video,
        TAG_TYPE_SCRIPT => TagKind::Script,
        _ => return None,
    };
    let data_size = u32::from_be_bytes([0, bytes[1], bytes[2], bytes[3]]);
    let timestamp = u32::from_be_bytes([bytes[7], bytes[4], bytes[5], bytes[6]]);
    Some(TagHeader {
        kind,
        data_size,
        timestamp,
    })
}

/// What a tag holds, read from the first bytes of its data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagRole {
    /// A decoder configuration: an AVC or HEVC sequence header, an AAC AudioSpecificConfig, or
    /// an enhanced sequence start. A window head carries these (ADR 046).
    Config,
    /// A video frame that starts a GOP, with its composition time offset in milliseconds.
    Keyframe { composition_ms: i32 },
    /// Any other video frame.
    VideoFrame { composition_ms: i32 },
    /// An audio frame.
    AudioFrame,
    /// A script tag, or a media tag that carries no frame: a sequence end, a command frame, or
    /// enhanced metadata and multitrack packets, which this reader does not follow.
    Other,
}

impl TagRole {
    /// True for a frame of either kind, which ends the head of a file (see `head`).
    pub fn is_frame(&self) -> bool {
        matches!(
            self,
            TagRole::Keyframe { .. } | TagRole::VideoFrame { .. } | TagRole::AudioFrame
        )
    }

    /// The composition time offset of a video frame, and 0 for everything else.
    pub fn composition_ms(&self) -> i32 {
        match self {
            TagRole::Keyframe { composition_ms } | TagRole::VideoFrame { composition_ms } => {
                *composition_ms
            }
            _ => 0,
        }
    }
}

/// Classify a tag from up to [`ROLE_PREFIX_LEN`] bytes at the start of its data.
pub fn classify(kind: TagKind, data: &[u8]) -> TagRole {
    match kind {
        TagKind::Video => classify_video(data),
        TagKind::Audio => classify_audio(data),
        TagKind::Script => TagRole::Other,
    }
}

const VIDEO_FRAME_TYPE_KEY: u8 = 1;
const VIDEO_FRAME_TYPE_COMMAND: u8 = 5;
const VIDEO_CODEC_AVC: u8 = 7;
/// The codec id that some content delivery networks use for HEVC in a legacy FLV tag.
const VIDEO_CODEC_HEVC_EXTENSION: u8 = 12;
const VIDEO_EX_HEADER: u8 = 0x80;
const VIDEO_PACKET_SEQUENCE_START: u8 = 0;
const VIDEO_PACKET_CODED_FRAMES: u8 = 1;
const VIDEO_PACKET_CODED_FRAMES_X: u8 = 3;
const VIDEO_PACKET_MPEG2TS_SEQUENCE_START: u8 = 5;

fn classify_video(data: &[u8]) -> TagRole {
    let Some(&first) = data.first() else {
        return TagRole::Other;
    };
    let frame_type = (first >> 4) & 0x07;
    if frame_type == VIDEO_FRAME_TYPE_COMMAND {
        return TagRole::Other;
    }
    let frame = |composition_ms: i32| {
        if frame_type == VIDEO_FRAME_TYPE_KEY {
            TagRole::Keyframe { composition_ms }
        } else {
            TagRole::VideoFrame { composition_ms }
        }
    };

    if first & VIDEO_EX_HEADER != 0 {
        // Enhanced FLV: the low nibble is the packet type and a FourCC follows. Only `avc1` and
        // `hvc1` coded frames carry a composition time.
        let packet_type = first & 0x0F;
        let Some(four_cc) = data.get(1..5) else {
            return TagRole::Other;
        };
        return match packet_type {
            VIDEO_PACKET_SEQUENCE_START | VIDEO_PACKET_MPEG2TS_SEQUENCE_START => TagRole::Config,
            VIDEO_PACKET_CODED_FRAMES if four_cc == b"avc1" || four_cc == b"hvc1" => {
                match data.get(5..8) {
                    Some(bytes) => frame(signed_24(bytes)),
                    None => TagRole::Other,
                }
            }
            VIDEO_PACKET_CODED_FRAMES | VIDEO_PACKET_CODED_FRAMES_X => frame(0),
            _ => TagRole::Other,
        };
    }

    match first & 0x0F {
        VIDEO_CODEC_AVC | VIDEO_CODEC_HEVC_EXTENSION => match (data.get(1), data.get(2..5)) {
            (Some(0), Some(_)) => TagRole::Config,
            (Some(1), Some(bytes)) => frame(signed_24(bytes)),
            _ => TagRole::Other,
        },
        // A legacy codec such as VP6 or Sorenson H.263 has no configuration and no B-frames.
        _ => frame(0),
    }
}

/// The size in bytes of the NAL unit lengths in the frames of the video configuration tag
/// `data`, from its AVC or HEVC decoder configuration record (ISO/IEC 14496-15). `None` for
/// another codec, a record too short to hold the size, or a size of 3, which Chromium refuses.
pub fn nal_length_size(data: &[u8]) -> Option<usize> {
    let first = *data.first()?;
    let hevc = if first & VIDEO_EX_HEADER != 0 {
        if first & 0x0F != VIDEO_PACKET_SEQUENCE_START {
            return None;
        }
        match data.get(1..5)? {
            b"avc1" => false,
            b"hvc1" => true,
            _ => return None,
        }
    } else {
        // Packet type 0 is the sequence header of the legacy tag.
        if data.get(1) != Some(&0) {
            return None;
        }
        match first & 0x0F {
            VIDEO_CODEC_AVC => false,
            VIDEO_CODEC_HEVC_EXTENSION => true,
            _ => return None,
        }
    };
    // Both forms put the record after five bytes: the legacy header and the composition time, or
    // the enhanced header and the FourCC.
    let record = data.get(5..)?;
    let size_byte = *record.get(if hevc { 21 } else { 4 })?;
    match (size_byte & 0x03) + 1 {
        3 => None,
        size => Some(usize::from(size)),
    }
}

/// The NAL units of the H.264 or HEVC video frame tag `data`, or `None` for any other tag.
pub fn frame_nal_units(data: &[u8]) -> Option<&[u8]> {
    let first = *data.first()?;
    if (first >> 4) & 0x07 == VIDEO_FRAME_TYPE_COMMAND {
        return None;
    }
    if first & VIDEO_EX_HEADER != 0 {
        let four_cc = data.get(1..5)?;
        if four_cc != b"avc1" && four_cc != b"hvc1" {
            return None;
        }
        return match first & 0x0F {
            // The composition time comes after the FourCC.
            VIDEO_PACKET_CODED_FRAMES => data.get(8..),
            VIDEO_PACKET_CODED_FRAMES_X => data.get(5..),
            _ => None,
        };
    }
    match (first & 0x0F, data.get(1)) {
        // Packet type 1 is a frame, after the packet type and the composition time.
        (VIDEO_CODEC_AVC | VIDEO_CODEC_HEVC_EXTENSION, Some(1)) => data.get(5..),
        _ => None,
    }
}

/// True when `units` is a chain of NAL units, each after a length of `length_size` bytes, that
/// ends exactly at its end, with no unit of length 0. This is the test of Chromium's MP4 parser
/// (`AVC::ConvertFrameToAnnexB`), which fails the append of the whole segment when a sample does
/// not pass it. An empty frame passes this test. FFmpeg's FLV demuxer gives no packet for it.
pub fn nal_units_fill(units: &[u8], length_size: usize) -> bool {
    let mut position = 0usize;
    while position.saturating_add(length_size) < units.len() {
        let size = units[position..position + length_size]
            .iter()
            .fold(0usize, |size, byte| (size << 8) | usize::from(*byte));
        if size == 0 {
            return false;
        }
        position = position.saturating_add(length_size).saturating_add(size);
    }
    position == units.len()
}

const SOUND_FORMAT_AAC: u8 = 10;
const SOUND_FORMAT_EX_HEADER: u8 = 9;
const AUDIO_PACKET_SEQUENCE_START: u8 = 0;
const AUDIO_PACKET_CODED_FRAMES: u8 = 1;

fn classify_audio(data: &[u8]) -> TagRole {
    let Some(&first) = data.first() else {
        return TagRole::Other;
    };
    match first >> 4 {
        SOUND_FORMAT_AAC => match data.get(1) {
            Some(0) => TagRole::Config,
            Some(_) => TagRole::AudioFrame,
            None => TagRole::Other,
        },
        SOUND_FORMAT_EX_HEADER => match first & 0x0F {
            AUDIO_PACKET_SEQUENCE_START => TagRole::Config,
            AUDIO_PACKET_CODED_FRAMES => TagRole::AudioFrame,
            _ => TagRole::Other,
        },
        _ => TagRole::AudioFrame,
    }
}

/// Read a big-endian signed 24-bit integer.
fn signed_24(bytes: &[u8]) -> i32 {
    let value = (i32::from(bytes[0]) << 16) | (i32::from(bytes[1]) << 8) | i32::from(bytes[2]);
    (value << 8) >> 8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_file_header_and_refuses_other_bytes() {
        let header = [b'F', b'L', b'V', 1, 0x05, 0, 0, 0, 9];
        assert_eq!(
            parse_file_header(&header),
            Some(FileHeader {
                has_audio: true,
                has_video: true,
                data_offset: 9
            })
        );
        assert_eq!(parse_file_header(&header).unwrap().first_tag_offset(), 13);
        assert_eq!(parse_file_header(b"FLX\x01\x05\0\0\0\x09"), None);
        assert_eq!(parse_file_header(b"FLV\x01\x05\0\0\0\x08"), None);
        assert_eq!(parse_file_header(b"FLV"), None);
    }

    #[test]
    fn reads_the_timestamp_extension_as_the_high_byte() {
        let bytes = [9, 0, 0, 10, 0x12, 0x34, 0x56, 0x78, 0, 0, 0];
        let header = parse_tag_header(&bytes).unwrap();
        assert_eq!(header.kind, TagKind::Video);
        assert_eq!(header.data_size, 10);
        assert_eq!(header.timestamp, 0x7812_3456);
        assert_eq!(header.total_len(), 25);
        assert_eq!(header.previous_tag_size(), 21);
    }

    #[test]
    fn refuses_a_tag_header_with_a_stream_id_a_filter_bit_or_an_unknown_type() {
        assert!(parse_tag_header(&[9, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]).is_none());
        assert!(parse_tag_header(&[9 | 0x20, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(parse_tag_header(&[7, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(parse_tag_header(&[18, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).is_some());
        assert!(parse_tag_header(&[8, 0, 0, 1, 0, 0, 0, 0, 0, 0]).is_none());
    }

    #[test]
    fn classifies_legacy_avc_tags() {
        assert_eq!(
            classify(TagKind::Video, &[0x17, 0, 0, 0, 0]),
            TagRole::Config
        );
        assert_eq!(
            classify(TagKind::Video, &[0x17, 1, 0, 0, 67]),
            TagRole::Keyframe { composition_ms: 67 }
        );
        assert_eq!(
            classify(TagKind::Video, &[0x27, 1, 0xFF, 0xFF, 0xDF]),
            TagRole::VideoFrame {
                composition_ms: -33
            }
        );
        assert_eq!(
            classify(TagKind::Video, &[0x17, 2, 0, 0, 0]),
            TagRole::Other
        );
        assert_eq!(classify(TagKind::Video, &[0x17, 1]), TagRole::Other);
        assert_eq!(classify(TagKind::Video, &[0x57, 0]), TagRole::Other);
    }

    #[test]
    fn classifies_the_hevc_extension_and_legacy_codecs() {
        assert_eq!(
            classify(TagKind::Video, &[0x1C, 1, 0, 0, 33]),
            TagRole::Keyframe { composition_ms: 33 }
        );
        assert_eq!(
            classify(TagKind::Video, &[0x14]),
            TagRole::Keyframe { composition_ms: 0 }
        );
        assert_eq!(
            classify(TagKind::Video, &[0x24]),
            TagRole::VideoFrame { composition_ms: 0 }
        );
        assert_eq!(classify(TagKind::Video, &[]), TagRole::Other);
    }

    #[test]
    fn classifies_enhanced_video_tags() {
        // Key frame, sequence start, hvc1.
        assert_eq!(
            classify(TagKind::Video, &[0x90, b'h', b'v', b'c', b'1']),
            TagRole::Config
        );
        // Key frame, coded frames with a composition time.
        assert_eq!(
            classify(TagKind::Video, &[0x91, b'h', b'v', b'c', b'1', 0, 0, 40]),
            TagRole::Keyframe { composition_ms: 40 }
        );
        // Inter frame, coded frames X: no composition time.
        assert_eq!(
            classify(TagKind::Video, &[0xA3, b'h', b'v', b'c', b'1']),
            TagRole::VideoFrame { composition_ms: 0 }
        );
        // AV1 coded frames carry no composition time.
        assert_eq!(
            classify(TagKind::Video, &[0x91, b'a', b'v', b'0', b'1']),
            TagRole::Keyframe { composition_ms: 0 }
        );
        // Sequence end and multitrack packets carry no frame for this reader.
        assert_eq!(
            classify(TagKind::Video, &[0x92, b'h', b'v', b'c', b'1']),
            TagRole::Other
        );
        assert_eq!(
            classify(TagKind::Video, &[0x96, b'h', b'v', b'c', b'1']),
            TagRole::Other
        );
        assert_eq!(classify(TagKind::Video, &[0x91, b'h']), TagRole::Other);
    }

    #[test]
    fn a_chain_of_nal_units_must_end_exactly_at_the_end_of_the_frame() {
        assert!(nal_units_fill(&[], 4));
        assert!(nal_units_fill(&[0, 0, 0, 2, 0x65, 0x88], 4));
        assert!(nal_units_fill(
            &[0, 0, 0, 1, 0x09, 0, 0, 0, 2, 0x65, 0x88],
            4
        ));
        assert!(nal_units_fill(&[2, 0x65, 0x88, 1, 0x41], 1));
        assert!(nal_units_fill(&[0, 2, 0x65, 0x88], 2));
        // The last frame of a recording that was cut: a length of 202 with no unit after it.
        assert!(!nal_units_fill(&[0, 0, 0, 0xCA], 4));
        assert!(!nal_units_fill(&[0, 0, 0, 0, 0, 0, 0, 1, 0x41], 4));
        for trailing in 1..=3 {
            let mut units = vec![0, 0, 0, 1, 0x41];
            units.extend(std::iter::repeat_n(0, trailing));
            assert!(!nal_units_fill(&units, 4), "{trailing} trailing bytes");
        }
        assert!(!nal_units_fill(&[0, 0, 0, 9, 0x65, 0x88], 4));
        assert!(!nal_units_fill(&[0xFF, 0xFF, 0xFF, 0xFF, 0x65], 4));
    }

    #[test]
    fn reads_the_nal_length_size_of_an_avc_or_hevc_configuration() {
        let avc = |size_byte: u8| vec![0x17, 0, 0, 0, 0, 1, 0x64, 0, 0x28, size_byte, 0xE1];
        assert_eq!(nal_length_size(&avc(0xFF)), Some(4));
        assert_eq!(nal_length_size(&avc(0xFD)), Some(2));
        assert_eq!(nal_length_size(&avc(0xFC)), Some(1));
        assert_eq!(nal_length_size(&avc(0xFE)), None);
        // A record too short to hold the size, as the configuration of the test recordings.
        assert_eq!(nal_length_size(&[0x17, 0, 0, 0, 0, 1, 0x64, 0, 1]), None);
        // A frame is no configuration.
        assert_eq!(
            nal_length_size(&[0x17, 1, 0, 0, 0, 1, 0x64, 0, 0x28, 0xFF]),
            None
        );

        let mut hevc = vec![0x1C, 0, 0, 0, 0];
        hevc.extend(std::iter::repeat_n(0, 21));
        hevc.push(0xF3);
        assert_eq!(nal_length_size(&hevc), Some(4));
        assert_eq!(nal_length_size(&hevc[..hevc.len() - 1]), None);

        let mut enhanced = vec![0x90, b'h', b'v', b'c', b'1'];
        enhanced.extend(std::iter::repeat_n(0, 21));
        enhanced.push(0xF1);
        assert_eq!(nal_length_size(&enhanced), Some(2));
        let enhanced_avc = [0x90, b'a', b'v', b'c', b'1', 1, 0x64, 0, 0x28, 0xFF];
        assert_eq!(nal_length_size(&enhanced_avc), Some(4));
        assert_eq!(
            nal_length_size(&[0x90, b'a', b'v', b'0', b'1', 0x81, 0, 0, 0, 0]),
            None
        );
        assert_eq!(nal_length_size(&[0x12, 0, 0, 0, 0, 1, 0, 0, 0, 0xFF]), None);
        assert_eq!(nal_length_size(&[]), None);
    }

    #[test]
    fn finds_the_nal_units_of_each_form_of_video_frame() {
        let units: &[u8] = &[0, 0, 0, 1, 0x41];
        let legacy = [&[0x27, 1, 0, 0, 33][..], units].concat();
        assert_eq!(frame_nal_units(&legacy), Some(units));
        let hevc = [&[0x1C, 1, 0, 0, 0][..], units].concat();
        assert_eq!(frame_nal_units(&hevc), Some(units));
        let coded = [&[0x91, b'h', b'v', b'c', b'1', 0, 0, 40][..], units].concat();
        assert_eq!(frame_nal_units(&coded), Some(units));
        let coded_x = [&[0xA3, b'a', b'v', b'c', b'1'][..], units].concat();
        assert_eq!(frame_nal_units(&coded_x), Some(units));
        // A configuration, a sequence end, a legacy codec, AV1 and a command frame hold none.
        assert_eq!(frame_nal_units(&[0x17, 0, 0, 0, 0, 1, 0x64]), None);
        assert_eq!(frame_nal_units(&[0x17, 2, 0, 0, 0]), None);
        assert_eq!(frame_nal_units(&[0x24, 1, 2, 3]), None);
        assert_eq!(frame_nal_units(&[0x91, b'a', b'v', b'0', b'1', 1, 2]), None);
        assert_eq!(frame_nal_units(&[0x57, 1, 0, 0, 0]), None);
        assert_eq!(frame_nal_units(&[]), None);
    }

    #[test]
    fn classifies_audio_tags() {
        assert_eq!(classify(TagKind::Audio, &[0xAF, 0]), TagRole::Config);
        assert_eq!(classify(TagKind::Audio, &[0xAF, 1]), TagRole::AudioFrame);
        assert_eq!(classify(TagKind::Audio, &[0x2F]), TagRole::AudioFrame);
        assert_eq!(classify(TagKind::Audio, &[0x90, b'O']), TagRole::Config);
        assert_eq!(classify(TagKind::Audio, &[0x91, b'O']), TagRole::AudioFrame);
        assert_eq!(classify(TagKind::Audio, &[0x94, b'O']), TagRole::Other);
        assert_eq!(classify(TagKind::Audio, &[0xAF]), TagRole::Other);
        assert_eq!(classify(TagKind::Script, &[2, 0, 10]), TagRole::Other);
    }
}
