//! Finding and walking tags: at a known boundary, from an arbitrary byte, backward, and in a
//! stream.
//!
//! A tag boundary is proven by the tag itself: a valid header, and a trailing `PreviousTagSize`
//! equal to 11 + `data_size`. Video data can hold bytes that look like one complete tag, so a
//! resync from an arbitrary offset accepts a position only when three tags in a row hold, or
//! when the tags that follow it end exactly at the end of the file (ADR 046).

use super::reader::{read_exact_at, ByteSource, BLOCK_LEN};
use super::table::ConfigTag;
use super::tag::{
    classify, parse_tag_header, TagHeader, TagKind, TagRole, PREVIOUS_TAG_SIZE_LEN,
    ROLE_PREFIX_LEN, TAG_HEADER_LEN,
};
use std::io::{self, Read};

/// The number of consecutive valid tags that prove a boundary found by a resync.
pub const RESYNC_CHAIN: usize = 3;
/// The farthest that a resync searches. One tag holds at most 16 MiB of data, so a boundary lies
/// within this distance of any offset inside a valid file.
pub const RESYNC_REACH: u64 = 17 * 1024 * 1024;

/// A tag at a proven boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tag {
    pub offset: u64,
    pub header: TagHeader,
    pub role: TagRole,
}

impl Tag {
    /// The offset of the next tag.
    pub fn end(&self) -> u64 {
        self.offset + self.header.total_len()
    }

    /// The decode time in milliseconds.
    pub fn dts(&self) -> i64 {
        i64::from(self.header.timestamp)
    }

    /// The presentation time in milliseconds: the decode time plus the composition offset.
    pub fn pts(&self) -> i64 {
        self.dts() + i64::from(self.role.composition_ms())
    }

    pub fn is_keyframe(&self) -> bool {
        matches!(self.role, TagRole::Keyframe { .. })
    }
}

/// Read the tag at `offset`, or `None` when no complete, valid tag starts there.
pub fn read_tag(source: &mut dyn ByteSource, offset: u64) -> io::Result<Option<Tag>> {
    let len = source.len();
    if offset.saturating_add(TAG_HEADER_LEN as u64) > len {
        return Ok(None);
    }
    // One read takes the header and the bytes that classify the tag, and a second read takes the
    // trailing `PreviousTagSize`: two reads per tag, which matters over a network share.
    let mut first = [0u8; TAG_HEADER_LEN + ROLE_PREFIX_LEN];
    let available = source.read_at(offset, &mut first)?;
    if available < TAG_HEADER_LEN {
        return Ok(None);
    }
    let Some(header) = parse_tag_header(&first) else {
        return Ok(None);
    };
    let end = offset + header.total_len();
    if end > len {
        return Ok(None);
    }
    let mut size_bytes = [0u8; PREVIOUS_TAG_SIZE_LEN];
    read_exact_at(source, end - PREVIOUS_TAG_SIZE_LEN as u64, &mut size_bytes)?;
    if u32::from_be_bytes(size_bytes) != header.previous_tag_size() {
        return Ok(None);
    }
    let prefix_len = (header.data_size as usize)
        .min(ROLE_PREFIX_LEN)
        .min(available - TAG_HEADER_LEN);
    let prefix = &first[TAG_HEADER_LEN..TAG_HEADER_LEN + prefix_len];
    Ok(Some(Tag {
        offset,
        header,
        role: classify(header.kind, prefix),
    }))
}

/// True when `count` valid tags follow one another from `offset`, or when the valid tags from
/// `offset` reach the end of the source. The end counts when it falls exactly on a boundary, and
/// also inside the last tag, as in a recording that was killed or that still grows: then a
/// header must parse there, or fewer bytes than a header remain.
pub fn chain_holds(source: &mut dyn ByteSource, offset: u64, count: usize) -> io::Result<bool> {
    let mut position = offset;
    for _ in 0..count {
        if position != offset && reaches_end(source, position)? {
            return Ok(true);
        }
        match read_tag(source, position)? {
            Some(tag) => position = tag.end(),
            None => return Ok(false),
        }
    }
    Ok(true)
}

/// True when `position` is the end of the source, or the start of a last tag that the source
/// cuts off.
fn reaches_end(source: &mut dyn ByteSource, position: u64) -> io::Result<bool> {
    let len = source.len();
    if position >= len {
        return Ok(position == len);
    }
    if len - position < TAG_HEADER_LEN as u64 {
        return Ok(true);
    }
    let mut header = [0u8; TAG_HEADER_LEN];
    read_exact_at(source, position, &mut header)?;
    // The cut-off tag must be an audio or video tag whose size runs past the end. This is weaker
    // than the three tags of a resync, and it applies only to the last tags of the file.
    Ok(parse_tag_header(&header)
        .is_some_and(|h| is_media(h.kind) && position + h.total_len() > len))
}

/// The first proven tag at or after `from` and before `until`, or `None`.
///
/// The search reads up to the end of the block that holds its position, so a probe costs one
/// block of [`ByteSource`] reads when a boundary lies in that block. A header that crosses into
/// the next block is checked in the next round, which starts at the last position whose header
/// did not fit.
pub fn resync(source: &mut dyn ByteSource, from: u64, until: u64) -> io::Result<Option<Tag>> {
    let until = until.min(source.len());
    let block = BLOCK_LEN as u64;
    let mut window = vec![0u8; 2 * BLOCK_LEN];
    let mut base = from;
    while base < until {
        let mut end = (base / block + 1) * block;
        if end - base < 2 * TAG_HEADER_LEN as u64 {
            end += block;
        }
        let want = (end - base) as usize;
        let count = source.read_at(base, &mut window[..want])?;
        if count < TAG_HEADER_LEN {
            return Ok(None);
        }
        // Positions whose header fits in what was read; the rest start the next round.
        let last = (count - TAG_HEADER_LEN + 1).min((until - base) as usize);
        for i in 0..last {
            let candidate = &window[i..i + TAG_HEADER_LEN];
            if !matches!(candidate[0], 8 | 9 | 18) || candidate[8..11] != [0, 0, 0] {
                continue;
            }
            let offset = base + i as u64;
            if chain_holds(source, offset, RESYNC_CHAIN)? {
                return read_tag(source, offset);
            }
        }
        if count < want {
            return Ok(None);
        }
        base += last as u64;
    }
    Ok(None)
}

/// The tag before the tag at `offset`, found through the `PreviousTagSize` in front of it, or
/// `None` at the first tag or when that field is not valid. `first_tag` is the offset of the
/// first tag of the file.
pub fn previous_tag(
    source: &mut dyn ByteSource,
    offset: u64,
    first_tag: u64,
) -> io::Result<Option<Tag>> {
    if offset < first_tag + TAG_HEADER_LEN as u64 + PREVIOUS_TAG_SIZE_LEN as u64 {
        return Ok(None);
    }
    let mut size_bytes = [0u8; PREVIOUS_TAG_SIZE_LEN];
    read_exact_at(
        source,
        offset - PREVIOUS_TAG_SIZE_LEN as u64,
        &mut size_bytes,
    )?;
    let size = u64::from(u32::from_be_bytes(size_bytes));
    let Some(start) = offset.checked_sub(PREVIOUS_TAG_SIZE_LEN as u64 + size) else {
        return Ok(None);
    };
    if start < first_tag {
        return Ok(None);
    }
    Ok(read_tag(source, start)?.filter(|tag| tag.end() == offset))
}

/// Copy the configuration tag `tag` whole.
pub fn read_config(source: &mut dyn ByteSource, tag: &Tag) -> io::Result<ConfigTag> {
    let mut bytes = vec![0u8; tag.header.total_len() as usize];
    read_exact_at(source, tag.offset, &mut bytes)?;
    Ok(ConfigTag {
        offset: tag.offset,
        kind: tag.header.kind,
        bytes,
    })
}

/// Walk the tags from the proven boundary `from` up to `until`, and copy each configuration tag
/// among them. A probe of a bisection calls this on the block that it already read, so the
/// configurations of a reconnect enter the table at no extra cost (ADR 046).
pub fn configs_between(
    source: &mut dyn ByteSource,
    from: u64,
    until: u64,
) -> io::Result<Vec<ConfigTag>> {
    walk_configs(source, from, until).map(|(configs, _)| configs)
}

/// [`configs_between`], and the offset where the walk stopped: `until`, or the start of the first
/// tag that it did not read, as a tag that is damaged or that does not end at or before `until`.
/// The walk read every tag in front of that offset.
pub fn walk_configs(
    source: &mut dyn ByteSource,
    from: u64,
    until: u64,
) -> io::Result<(Vec<ConfigTag>, u64)> {
    let mut configs = Vec::new();
    let mut position = from;
    let smallest = (TAG_HEADER_LEN + PREVIOUS_TAG_SIZE_LEN) as u64;
    while position + smallest <= until {
        // A tag that ends past `until` lies partly outside the block that the caller read, and
        // its validation would read another block. The walk stops in front of it.
        let mut header = [0u8; TAG_HEADER_LEN];
        if source.read_at(position, &mut header)? < TAG_HEADER_LEN {
            break;
        }
        match parse_tag_header(&header) {
            Some(header) if position + header.total_len() <= until => {}
            _ => break,
        }
        let Some(tag) = read_tag(source, position)? else {
            break;
        };
        if tag.role == TagRole::Config {
            configs.push(read_config(source, &tag)?);
        }
        position = tag.end();
    }
    Ok((configs, position))
}

/// Reads whole tags from a stream that starts at a tag boundary.
///
/// The stdin writer of a remux window reads the source sequentially, so it has no use for random
/// access. This reader takes each tag whole, checks it, and gives its bytes and its role.
pub struct TagStream<R: Read> {
    reader: R,
    offset: u64,
}

impl<R: Read> TagStream<R> {
    /// Read from `reader`, whose first byte is at `offset` of the file.
    pub fn new(reader: R, offset: u64) -> Self {
        Self { reader, offset }
    }

    /// The offset of the next tag.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// The reader that the stream reads from.
    pub fn reader(&self) -> &R {
        &self.reader
    }

    /// Read the next tag into `buf`, replacing its contents. Return `None` at the end of the
    /// stream, an `UnexpectedEof` error when the stream ends inside a tag, as at the end of a
    /// recording that was killed, and an `InvalidData` error for a damaged tag.
    pub fn next_tag(&mut self, buf: &mut Vec<u8>) -> io::Result<Option<Tag>> {
        buf.clear();
        buf.resize(TAG_HEADER_LEN, 0);
        let mut filled = 0;
        while filled < TAG_HEADER_LEN {
            match self.reader.read(&mut buf[filled..]) {
                Ok(0) if filled == 0 => return Ok(None),
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "the FLV stream ends inside a tag header",
                    ))
                }
                Ok(count) => filled += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        let header =
            parse_tag_header(buf).ok_or_else(|| damaged("an FLV tag header is damaged"))?;
        let total = header.total_len() as usize;
        buf.resize(total, 0);
        self.reader.read_exact(&mut buf[TAG_HEADER_LEN..])?;
        let trailing = u32::from_be_bytes(buf[total - 4..].try_into().expect("four bytes"));
        if trailing != header.previous_tag_size() {
            return Err(damaged("an FLV tag has a wrong PreviousTagSize"));
        }
        let data = &buf[TAG_HEADER_LEN..total - PREVIOUS_TAG_SIZE_LEN];
        let role = classify(header.kind, &data[..data.len().min(ROLE_PREFIX_LEN)]);
        let tag = Tag {
            offset: self.offset,
            header,
            role,
        };
        self.offset += total as u64;
        Ok(Some(tag))
    }
}

fn damaged(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// True when `kind` is audio or video.
pub fn is_media(kind: TagKind) -> bool {
    matches!(kind, TagKind::Audio | TagKind::Video)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::reader::SliceSource;
    use crate::flv::test_support::{recording, FlvBuilder, RecordingOptions};

    #[test]
    fn reads_tags_and_walks_backward() {
        let mut builder = FlvBuilder::new(true, true);
        let config = builder.avc_config(0, 1);
        let audio = builder.audio(0, 50);
        let key = builder.video(0, true, 67, 400);
        let mut source = SliceSource::new(builder.finish());

        let tag = read_tag(&mut source, key).unwrap().unwrap();
        assert!(tag.is_keyframe());
        assert_eq!(tag.pts(), 67);
        assert_eq!(tag.end(), source.len());
        assert_eq!(read_tag(&mut source, key + 1).unwrap(), None);

        let before = previous_tag(&mut source, key, config).unwrap().unwrap();
        assert_eq!(before.offset, audio);
        assert_eq!(before.role, TagRole::AudioFrame);
        let first = previous_tag(&mut source, audio, config).unwrap().unwrap();
        assert_eq!(first.offset, config);
        assert_eq!(first.role, TagRole::Config);
        assert_eq!(previous_tag(&mut source, config, config).unwrap(), None);
    }

    #[test]
    fn a_truncated_tag_is_no_tag() {
        let mut builder = FlvBuilder::new(true, true);
        let key = builder.video(0, true, 0, 400);
        let mut bytes = builder.finish();
        bytes.truncate(bytes.len() - 1);
        let mut source = SliceSource::new(bytes);
        assert_eq!(read_tag(&mut source, key).unwrap(), None);
    }

    #[test]
    fn resync_lands_on_the_next_real_tag_from_any_offset() {
        let recording = recording(&RecordingOptions {
            seconds: 4,
            ..RecordingOptions::default()
        });
        let boundaries: Vec<u64> = {
            let mut source = SliceSource::new(recording.bytes.clone());
            let mut all = Vec::new();
            let mut position = 13;
            while let Some(tag) = read_tag(&mut source, position).unwrap() {
                all.push(tag.offset);
                position = tag.end();
            }
            all
        };
        let mut source = SliceSource::new(recording.bytes.clone());
        let len = source.len();
        // Offsets inside headers, inside the fake tags of the noise, and inside payloads.
        for from in (13..len).step_by(97) {
            let found = resync(&mut source, from, len).unwrap();
            let expected = boundaries.iter().copied().find(|offset| *offset >= from);
            assert_eq!(found.map(|tag| tag.offset), expected, "from {from}");
        }
    }

    #[test]
    fn resync_does_not_trust_one_fake_tag_inside_data() {
        let mut builder = FlvBuilder::new(true, true);
        builder.avc_config(0, 1);
        let key = builder.video(0, true, 0, 9000);
        let next = builder.video(33, false, 0, 300);
        let mut source = SliceSource::new(builder.finish());
        // The noise of the keyframe holds one complete fake tag near its start.
        let len = source.len();
        let found = resync(&mut source, key + 20, len).unwrap().unwrap();
        assert_eq!(found.offset, next);
    }

    #[test]
    fn a_tag_before_a_truncated_last_tag_still_proves_a_boundary() {
        let mut builder = FlvBuilder::new(true, true);
        builder.avc_config(0, 1);
        let key = builder.video(0, true, 0, 300);
        let next = builder.video(33, false, 0, 300);
        builder.video(66, false, 0, 300);
        let mut bytes = builder.finish();
        // A recording that was killed, or that still grows, ends inside its last tag.
        bytes.truncate(bytes.len() - 100);
        let mut source = SliceSource::new(bytes);
        assert!(chain_holds(&mut source, key, RESYNC_CHAIN).unwrap());
        let len = source.len();
        assert_eq!(
            resync(&mut source, key + 1, len).unwrap().unwrap().offset,
            next
        );
    }

    #[test]
    fn collects_the_configurations_between_two_offsets() {
        let mut builder = FlvBuilder::new(true, true);
        let first = builder.avc_config(0, 1);
        builder.video(0, true, 0, 300);
        let second = builder.avc_config(5000, 2);
        let end = builder.video(5000, true, 0, 300);
        let mut source = SliceSource::new(builder.finish());
        let configs = configs_between(&mut source, first, end).unwrap();
        assert_eq!(
            configs.iter().map(|c| c.offset).collect::<Vec<_>>(),
            vec![first, second]
        );
        assert_ne!(configs[0].data(), configs[1].data());
    }

    #[test]
    fn a_stream_gives_each_tag_whole_and_stops_at_a_damaged_one() {
        let mut builder = FlvBuilder::new(true, true);
        let config = builder.avc_config(0, 1);
        builder.video(0, true, 67, 500);
        let audio = builder.audio(10, 60);
        let bytes = builder.finish();

        let mut stream = TagStream::new(&bytes[config as usize..], config);
        let mut buf = Vec::new();
        let first = stream.next_tag(&mut buf).unwrap().unwrap();
        assert_eq!(first.role, TagRole::Config);
        assert_eq!(buf.len() as u64, first.header.total_len());
        let second = stream.next_tag(&mut buf).unwrap().unwrap();
        assert_eq!(second.role, TagRole::Keyframe { composition_ms: 67 });
        let third = stream.next_tag(&mut buf).unwrap().unwrap();
        assert_eq!(third.offset, audio);
        assert_eq!(stream.next_tag(&mut buf).unwrap(), None);

        let mut broken = bytes.clone();
        let last = broken.len() - 1;
        broken[last] ^= 0xFF;
        let mut stream = TagStream::new(&broken[audio as usize..], audio);
        let error = stream.next_tag(&mut buf).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let mut stream = TagStream::new(&bytes[audio as usize..bytes.len() - 3], audio);
        assert_eq!(
            stream.next_tag(&mut buf).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
