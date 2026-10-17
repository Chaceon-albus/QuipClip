//! The keyframe index of `onMetaData`, read from the AMF0 data of a script tag.
//!
//! Some muxers write `keyframes.times` (decode times in seconds) and `keyframes.filepositions`
//! (byte offsets of the keyframe tags) into `onMetaData`. FFmpeg writes them only with
//! `-flvflags add_keyframe_index`, and live recorders do not write them, so the index is the
//! first source of the locator but never the only one (ADR 046). The parser reads the AMF0
//! types that `onMetaData` uses and stops at anything else.

/// A keyframe index as (decode time in milliseconds, tag offset) pairs, sorted by offset.
pub type KeyframeIndex = Vec<(i64, u64)>;

/// The deepest nesting that the parser follows. `onMetaData` uses two levels.
const MAX_DEPTH: usize = 8;

enum Value {
    Number(f64),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
    Other,
}

struct Parser<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Parser<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let end = self.position.checked_add(count)?;
        let bytes = self.data.get(self.position..end)?;
        self.position = end;
        Some(bytes)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn short_string(&mut self) -> Option<String> {
        let len = usize::from(self.u16()?);
        Some(String::from_utf8_lossy(self.take(len)?).into_owned())
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.u8()? {
            0x00 => {
                let bytes = self.take(8)?;
                Some(Value::Number(f64::from_be_bytes(bytes.try_into().ok()?)))
            }
            0x01 => self.take(1).map(|_| Value::Other),
            0x02 => self.short_string().map(|_| Value::Other),
            0x03 => self.properties(depth).map(Value::Object),
            0x05 | 0x06 => Some(Value::Other),
            0x07 => self.u16().map(|_| Value::Other),
            0x08 => {
                // An ECMA array gives an approximate count and then ends like an object.
                self.u32()?;
                self.properties(depth).map(Value::Object)
            }
            0x0A => {
                let count = self.u32()? as usize;
                // Each element takes at least one byte, which bounds a damaged count.
                if count > self.data.len() - self.position {
                    return None;
                }
                // A damaged count must not reserve much memory before the elements prove it.
                let mut items = Vec::with_capacity(count.min(4096));
                for _ in 0..count {
                    items.push(self.value(depth + 1)?);
                }
                Some(Value::Array(items))
            }
            0x0B => self.take(10).map(|_| Value::Other),
            0x0C => {
                let len = self.u32()? as usize;
                self.take(len).map(|_| Value::Other)
            }
            _ => None,
        }
    }

    fn properties(&mut self, depth: usize) -> Option<Vec<(String, Value)>> {
        let mut properties = Vec::new();
        loop {
            let key = self.short_string()?;
            if key.is_empty() {
                // An empty key followed by the object end marker closes the object.
                return (self.u8()? == 0x09).then_some(properties);
            }
            let value = self.value(depth + 1)?;
            properties.push((key, value));
        }
    }
}

fn numbers(value: &Value) -> Option<Vec<f64>> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Number(number) => Some(*number),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// Read the keyframe index from the data of a script tag, or `None` when the tag is not
/// `onMetaData` or holds no usable index.
pub fn keyframe_index(data: &[u8]) -> Option<KeyframeIndex> {
    let mut parser = Parser { data, position: 0 };
    if parser.u8()? != 0x02 || parser.short_string()? != "onMetaData" {
        return None;
    }
    let Value::Object(properties) = parser.value(0)? else {
        return None;
    };
    let (_, keyframes) = properties.iter().find(|(key, _)| key == "keyframes")?;
    let Value::Object(fields) = keyframes else {
        return None;
    };
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, v)| numbers(v))
    };
    let times = field("times")?;
    let positions = field("filepositions")?;
    if times.len() != positions.len() || times.is_empty() {
        return None;
    }
    let mut index: KeyframeIndex = Vec::with_capacity(times.len());
    for (time, position) in times.iter().zip(&positions) {
        if !time.is_finite() || !position.is_finite() || *position < 0.0 || *time < 0.0 {
            return None;
        }
        index.push(((time * 1000.0).round() as i64, *position as u64));
    }
    // A muxer writes the entries in file order and in time order, and the locator relies on both.
    index
        .windows(2)
        .all(|pair| pair[0].1 < pair[1].1 && pair[0].0 <= pair[1].0)
        .then_some(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::FlvBuilder;

    /// The data of the first tag, which these tests make a script tag.
    fn script_data(builder: &FlvBuilder) -> Vec<u8> {
        let bytes = builder.bytes();
        let size = u32::from_be_bytes([0, bytes[14], bytes[15], bytes[16]]) as usize;
        bytes[24..24 + size].to_vec()
    }

    #[test]
    fn reads_the_keyframe_index_of_on_metadata() {
        let mut builder = FlvBuilder::new(true, true);
        let script = builder.metadata_with_index(3);
        builder.rewrite_index(script, &[0.0, 2.0, 4.002], &[400.0, 90_000.0, 180_000.0]);
        let index = keyframe_index(&script_data(&builder)).unwrap();
        assert_eq!(index, vec![(0, 400), (2000, 90_000), (4002, 180_000)]);
    }

    #[test]
    fn refuses_an_index_that_is_not_in_file_order() {
        let mut builder = FlvBuilder::new(true, true);
        let script = builder.metadata_with_index(2);
        builder.rewrite_index(script, &[0.0, 2.0], &[90_000.0, 400.0]);
        assert_eq!(keyframe_index(&script_data(&builder)), None);
    }

    #[test]
    fn ignores_other_script_tags_and_damaged_data() {
        let mut data = vec![2];
        data.extend_from_slice(&10u16.to_be_bytes());
        data.extend_from_slice(b"onCuePoint");
        data.push(5);
        assert_eq!(keyframe_index(&data), None);
        assert_eq!(keyframe_index(&[2, 0, 10, b'o']), None);
        assert_eq!(keyframe_index(&[]), None);

        let mut builder = FlvBuilder::new(true, true);
        let script = builder.metadata_with_index(2);
        builder.rewrite_index(script, &[0.0, 2.0], &[400.0, 9000.0]);
        let whole = script_data(&builder);
        for cut in [1, 10, whole.len() / 2, whole.len() - 1] {
            assert_eq!(keyframe_index(&whole[..cut]), None, "cut at {cut}");
        }
    }

    #[test]
    fn a_damaged_array_count_reserves_nothing_large() {
        let mut data = vec![2];
        data.extend_from_slice(&10u16.to_be_bytes());
        data.extend_from_slice(b"onMetaData");
        data.push(0x0A);
        data.extend_from_slice(&0xFFFF_FFF0u32.to_be_bytes());
        data.extend_from_slice(&[0; 32]);
        assert_eq!(keyframe_index(&data), None);
    }

    #[test]
    fn a_metadata_tag_without_keyframes_gives_no_index() {
        let mut data = vec![2];
        data.extend_from_slice(&10u16.to_be_bytes());
        data.extend_from_slice(b"onMetaData");
        data.push(8);
        data.extend_from_slice(&1u32.to_be_bytes());
        data.extend_from_slice(&8u16.to_be_bytes());
        data.extend_from_slice(b"duration");
        data.push(0);
        data.extend_from_slice(&20.0f64.to_be_bytes());
        data.extend_from_slice(&[0, 0, 9]);
        assert_eq!(keyframe_index(&data), None);
    }
}
