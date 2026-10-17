//! The head of an FLV file: what a remux window needs before its first tag.
//!
//! FFmpeg can demux a window that starts at a keyframe in the middle of the file when the window
//! starts with the FLV header and the configuration tags (ADR 046 measurement 2). The head that
//! QuipClip writes holds those and no script tag: the `keyframes` file positions of `onMetaData`
//! are wrong inside a window, and an ffprobe `-read_intervals` would seek by them.
//!
//! The walk also records the order in which the media kinds first appear. FFmpeg numbers the
//! streams of an FLV in that order, and the export binds absolute stream indices (ADR 014), so
//! the export compares the order of a window with the order of the file.

use super::amf::{keyframe_index, KeyframeIndex};
use super::reader::{read_exact_at, ByteSource};
use super::scan::{is_media, read_config, read_tag, Tag};
use super::table::ConfigTag;
use super::tag::{parse_file_header, FileHeader, TagKind, TagRole, FILE_HEADER_LEN};
use super::FlvError;
use std::collections::BTreeMap;

/// The farthest that the walk reads before it gives up on a configuration that has not come. A
/// configuration follows the first frames within a few tags in every file that the tests made.
const HEAD_WALK_BYTES: u64 = 4 * 1024 * 1024;
/// The most tags that the walk reads.
const HEAD_WALK_TAGS: usize = 4096;
/// The largest header that the reader accepts. The specification gives 9 bytes; a larger value
/// in a damaged file must not decide an allocation.
const MAX_DATA_OFFSET: u32 = 1024;

/// The head of a source, and what its walk learned.
#[derive(Debug, Clone)]
pub struct FlvHead {
    pub file_header: FileHeader,
    /// The bytes before the first tag: the file header as the file has it.
    header_bytes: Vec<u8>,
    /// The configuration tags of the start of the file, in file order.
    pub configs: Vec<ConfigTag>,
    /// The offset of the first audio or video frame.
    pub first_frame_offset: u64,
    /// The first video frame, and the first keyframe.
    pub first_video: Option<Tag>,
    pub first_keyframe: Option<Tag>,
    /// The media kinds in the order of their first tag, which is the stream order of FFmpeg.
    pub stream_order: Vec<TagKind>,
    /// The keyframe index of `onMetaData`, when the file has one.
    pub index: Option<KeyframeIndex>,
}

impl FlvHead {
    /// Read the head of `source`.
    pub fn read(source: &mut dyn ByteSource) -> Result<Self, FlvError> {
        let mut header = [0u8; FILE_HEADER_LEN];
        read_exact_at(source, 0, &mut header).map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                FlvError::NotFlv
            } else {
                FlvError::from(error)
            }
        })?;
        let file_header = parse_file_header(&header)
            .filter(|h| h.data_offset <= MAX_DATA_OFFSET && h.first_tag_offset() <= source.len())
            .ok_or(FlvError::NotFlv)?;
        let first_tag = file_header.first_tag_offset();
        let mut header_bytes = vec![0u8; file_header.data_offset as usize];
        read_exact_at(source, 0, &mut header_bytes)?;

        let mut configs = Vec::new();
        let mut stream_order = Vec::new();
        let mut index = None;
        let mut first_frame_offset = None;
        let mut first_video = None;
        let mut first_keyframe = None;
        let mut position = first_tag;
        // A header that announces neither kind is wrong in some files, so the walk then waits
        // for both kinds as far as its bounds allow.
        let neither = !file_header.has_video && !file_header.has_audio;
        let announced = [
            (TagKind::Video, file_header.has_video || neither),
            (TagKind::Audio, file_header.has_audio || neither),
        ];

        for _ in 0..HEAD_WALK_TAGS {
            if position >= first_tag + HEAD_WALK_BYTES {
                break;
            }
            let Some(tag) = read_tag(source, position)? else {
                break;
            };
            position = tag.end();
            let kind = tag.header.kind;
            if is_media(kind) && !stream_order.contains(&kind) {
                stream_order.push(kind);
            }
            match tag.role {
                TagRole::Config => configs.push(read_config(source, &tag)?),
                TagRole::Other if kind == TagKind::Script && index.is_none() => {
                    let mut data = vec![0u8; tag.header.data_size as usize];
                    read_exact_at(source, tag.offset + 11, &mut data)?;
                    index = keyframe_index(&data);
                }
                role if role.is_frame() => {
                    first_frame_offset.get_or_insert(tag.offset);
                    if kind == TagKind::Video {
                        first_video.get_or_insert(tag);
                        if tag.is_keyframe() {
                            first_keyframe.get_or_insert(tag);
                        }
                    }
                }
                _ => {}
            }
            // The walk passes the first frame to collect a configuration that comes after it,
            // and it stops when each announced kind has shown a tag and the first keyframe came.
            let kinds_seen = announced
                .iter()
                .all(|(kind, announced)| !announced || stream_order.contains(kind));
            let key_seen = !announced[0].1 || first_keyframe.is_some();
            if first_frame_offset.is_some() && kinds_seen && key_seen {
                break;
            }
        }

        let first_frame_offset = first_frame_offset.ok_or(FlvError::NoMediaTags)?;
        Ok(Self {
            file_header,
            header_bytes,
            configs,
            first_frame_offset,
            first_video,
            first_keyframe,
            stream_order,
            index,
        })
    }

    /// The offset of the first tag of the file.
    pub fn first_tag_offset(&self) -> u64 {
        self.file_header.first_tag_offset()
    }

    /// The head bytes of a window: the file header, `PreviousTagSize0`, and one configuration
    /// tag of each kind, in the stream order of the file. `configs` maps each kind to the
    /// configuration in force at the start of the window (see `KeyframeTable::configs_at`).
    pub fn bytes_with(&self, configs: &BTreeMap<TagKind, &ConfigTag>) -> Vec<u8> {
        let mut bytes = self.header_bytes.clone();
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        let mut kinds: Vec<TagKind> = self.stream_order.clone();
        for kind in configs.keys() {
            if !kinds.contains(kind) {
                kinds.push(*kind);
            }
        }
        for kind in kinds {
            if let Some(config) = configs.get(&kind) {
                bytes.extend_from_slice(&config.bytes);
            }
        }
        bytes
    }

    /// The head bytes with the last configuration of each kind that the walk of the head found,
    /// as `KeyframeTable::configs_at` chooses them.
    pub fn bytes(&self) -> Vec<u8> {
        let mut latest = BTreeMap::new();
        for config in &self.configs {
            latest.insert(config.kind, config);
        }
        self.bytes_with(&latest)
    }

    /// The stream order that FFmpeg gives a window that starts at the keyframe tag `offset`
    /// with these head configurations: the kinds of the head first, then video, which the
    /// window starts with, then audio.
    pub fn window_stream_order(&self, configs: &BTreeMap<TagKind, &ConfigTag>) -> Vec<TagKind> {
        let mut order: Vec<TagKind> = self
            .stream_order
            .iter()
            .copied()
            .filter(|kind| configs.contains_key(kind))
            .collect();
        for kind in [TagKind::Video, TagKind::Audio] {
            if !order.contains(&kind) && self.stream_order.contains(&kind) {
                order.push(kind);
            }
        }
        order
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::reader::SliceSource;
    use crate::flv::scan::TagStream;
    use crate::flv::test_support::{recording, FlvBuilder, RecordingOptions};

    #[test]
    fn the_head_holds_the_header_and_the_configurations_and_no_script() {
        let recording = recording(&RecordingOptions {
            seconds: 2,
            index: true,
            ..RecordingOptions::default()
        });
        let mut source = SliceSource::new(recording.bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        assert_eq!(head.first_frame_offset, recording.first_frame_offset);
        assert_eq!(head.stream_order, vec![TagKind::Video, TagKind::Audio]);
        assert_eq!(head.configs.len(), 2);
        assert_eq!(
            head.first_keyframe.unwrap().offset,
            recording.keyframes[0].offset
        );
        assert_eq!(
            head.index.as_ref().unwrap().len(),
            recording.keyframes.len()
        );

        let bytes = head.bytes();
        assert_eq!(&bytes[..3], b"FLV");
        let mut stream = TagStream::new(&bytes[13..], 13);
        let mut buf = Vec::new();
        let mut roles = Vec::new();
        while let Some(tag) = stream.next_tag(&mut buf).unwrap() {
            roles.push((tag.header.kind, tag.role));
        }
        assert_eq!(
            roles,
            vec![
                (TagKind::Video, TagRole::Config),
                (TagKind::Audio, TagRole::Config)
            ]
        );
    }

    #[test]
    fn a_configuration_after_the_first_frame_still_enters_the_head() {
        // MP3 audio has no configuration, so its first tag is a frame before the video config.
        let mut builder = FlvBuilder::new(true, true);
        let audio = builder.tag(8, 0, &[0x2F, 1, 2, 3]);
        let config = builder.avc_config(0, 1);
        let key = builder.video(0, true, 0, 300);
        let mut source = SliceSource::new(builder.finish());
        let head = FlvHead::read(&mut source).unwrap();
        assert_eq!(head.first_frame_offset, audio);
        assert_eq!(head.configs[0].offset, config);
        assert_eq!(head.first_keyframe.unwrap().offset, key);
        assert_eq!(head.stream_order, vec![TagKind::Audio, TagKind::Video]);
        // A window at the keyframe has only the video configuration in its head, so FFmpeg
        // numbers video first there, unlike the file.
        let latest: BTreeMap<_, _> = head.configs.iter().map(|c| (c.kind, c)).collect();
        assert_eq!(
            head.window_stream_order(&latest),
            vec![TagKind::Video, TagKind::Audio]
        );
    }

    #[test]
    fn the_head_of_a_later_window_takes_the_configuration_in_force() {
        let mut builder = FlvBuilder::new(true, true);
        builder.avc_config(0, 1);
        builder.aac_config(0);
        builder.video(0, true, 0, 300);
        let reconnect = builder.avc_config(9000, 2);
        let bytes = builder.finish();
        let mut source = SliceSource::new(bytes.clone());
        let head = FlvHead::read(&mut source).unwrap();
        let tag = read_tag(&mut source, reconnect).unwrap().unwrap();
        let later = crate::flv::scan::read_config(&mut source, &tag).unwrap();
        let mut configs: BTreeMap<_, _> = head.configs.iter().map(|c| (c.kind, c)).collect();
        configs.insert(TagKind::Video, &later);
        let window_head = head.bytes_with(&configs);
        assert!(window_head
            .windows(later.bytes.len())
            .any(|w| w == later.bytes.as_slice()));
    }

    #[test]
    fn a_damaged_header_size_is_not_an_allocation() {
        let mut bytes = vec![b'F', b'L', b'V', 1, 5, 0xFF, 0xFF, 0xFF, 0xFF];
        bytes.extend_from_slice(&[0; 64]);
        let mut source = SliceSource::new(bytes);
        assert!(matches!(FlvHead::read(&mut source), Err(FlvError::NotFlv)));
    }

    #[test]
    fn refuses_a_file_that_is_not_flv_or_has_no_frames() {
        let mut source = SliceSource::new(b"not an flv file at all".to_vec());
        assert!(matches!(FlvHead::read(&mut source), Err(FlvError::NotFlv)));
        let mut builder = FlvBuilder::new(true, true);
        builder.avc_config(0, 1);
        let mut source = SliceSource::new(builder.finish());
        assert!(matches!(
            FlvHead::read(&mut source),
            Err(FlvError::NoMediaTags)
        ));
    }
}
