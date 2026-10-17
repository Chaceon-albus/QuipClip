//! Random access to the bytes of a source, with few reads over a network share.
//!
//! The locator reads small pieces at scattered offsets: a tag header here, a `PreviousTagSize`
//! there. Over SMB each read is a round trip, so [`FileSource`] reads whole blocks and keeps the
//! most recent ones. It also counts the bytes that it read, so a test and the window command can
//! report what a locate cost, and it stops at the next block when its cancel flag is set (ADR 046).

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A source of bytes that the FLV reader can read at any offset.
pub trait ByteSource {
    /// The length of the source in bytes.
    fn len(&self) -> u64;

    /// True when the source holds no bytes.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Copy bytes from `offset` into `buf`. Return the number of bytes copied, which is fewer
    /// than `buf.len()` only at the end of the source.
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize>;
}

/// Fill `buf` from `offset`, or fail with `UnexpectedEof` when the source ends first.
pub fn read_exact_at(source: &mut dyn ByteSource, offset: u64, buf: &mut [u8]) -> io::Result<()> {
    let copied = source.read_at(offset, buf)?;
    if copied < buf.len() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the FLV source ends inside a read",
        ));
    }
    Ok(())
}

/// The error that a read returns after its cancel flag was set.
#[derive(Debug)]
pub struct Canceled;

impl std::fmt::Display for Canceled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the read was canceled")
    }
}

impl std::error::Error for Canceled {}

/// True when `error` is the error of a canceled read.
pub fn is_canceled(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.downcast_ref::<Canceled>().is_some())
}

/// The size of one cached block.
pub const BLOCK_LEN: usize = 64 * 1024;
/// The number of blocks that a [`FileSource`] keeps. 32 blocks are 2 MiB, enough for the walk at
/// the end of a bisection and for a backward walk over a short GOP.
const CACHED_BLOCKS: usize = 32;

/// A file read in cached blocks.
pub struct FileSource {
    file: File,
    len: u64,
    /// The cached blocks, most recently used last, as (block index, bytes).
    blocks: VecDeque<(u64, Vec<u8>)>,
    bytes_read: u64,
    cancel: Option<Arc<AtomicBool>>,
}

impl FileSource {
    /// Open `path` for reading. `cancel`, when set, stops the next block read.
    pub fn open(path: &Path, cancel: Option<Arc<AtomicBool>>) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self {
            file,
            len,
            blocks: VecDeque::with_capacity(CACHED_BLOCKS),
            bytes_read: 0,
            cancel,
        })
    }

    /// The number of bytes that this source read from the file so far.
    pub fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    fn block(&mut self, index: u64) -> io::Result<&[u8]> {
        if let Some(position) = self.blocks.iter().position(|(i, _)| *i == index) {
            let entry = self.blocks.remove(position).expect("the position exists");
            self.blocks.push_back(entry);
        } else {
            if self
                .cancel
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                return Err(io::Error::other(Canceled));
            }
            let start = index * BLOCK_LEN as u64;
            let len = (self.len.saturating_sub(start)).min(BLOCK_LEN as u64) as usize;
            let mut bytes = vec![0; len];
            self.file.seek(SeekFrom::Start(start))?;
            self.file.read_exact(&mut bytes)?;
            self.bytes_read += len as u64;
            if self.blocks.len() == CACHED_BLOCKS {
                self.blocks.pop_front();
            }
            self.blocks.push_back((index, bytes));
        }
        Ok(&self.blocks.back().expect("a block was just pushed").1)
    }
}

impl ByteSource for FileSource {
    fn len(&self) -> u64 {
        self.len
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
        let mut copied = 0;
        while copied < buf.len() {
            let position = offset + copied as u64;
            if position >= self.len {
                break;
            }
            let index = position / BLOCK_LEN as u64;
            let within = (position % BLOCK_LEN as u64) as usize;
            let block = self.block(index)?;
            let count = (block.len() - within).min(buf.len() - copied);
            buf[copied..copied + count].copy_from_slice(&block[within..within + count]);
            copied += count;
        }
        Ok(copied)
    }
}

/// Bytes in memory, for tests. It counts the calls, so a test can bound the reads of a locate.
#[cfg(test)]
pub struct SliceSource {
    pub bytes: Vec<u8>,
    pub reads: usize,
}

#[cfg(test)]
impl SliceSource {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes, reads: 0 }
    }
}

#[cfg(test)]
impl ByteSource for SliceSource {
    fn len(&self) -> u64 {
        self.bytes.len() as u64
    }

    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
        self.reads += 1;
        let start = (offset as usize).min(self.bytes.len());
        let count = (self.bytes.len() - start).min(buf.len());
        buf[..count].copy_from_slice(&self.bytes[start..start + count]);
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flv::test_support::TestDirectory;
    use std::io::Write;

    fn temp_file(bytes: &[u8]) -> (TestDirectory, std::path::PathBuf) {
        let dir = TestDirectory::new();
        let path = dir.path.join("source.flv");
        File::create(&path).unwrap().write_all(bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn reads_across_blocks_and_stops_at_the_end() {
        let bytes: Vec<u8> = (0..(BLOCK_LEN * 3 + 100))
            .map(|i| (i % 251) as u8)
            .collect();
        let (_dir, path) = temp_file(&bytes);
        let mut source = FileSource::open(&path, None).unwrap();
        assert_eq!(source.len(), bytes.len() as u64);

        let mut buf = vec![0; 300];
        let offset = BLOCK_LEN as u64 - 150;
        assert_eq!(source.read_at(offset, &mut buf).unwrap(), 300);
        assert_eq!(buf, bytes[offset as usize..offset as usize + 300]);

        let mut tail = vec![0; 300];
        let offset = bytes.len() as u64 - 50;
        assert_eq!(source.read_at(offset, &mut tail).unwrap(), 50);
        assert_eq!(tail[..50], bytes[offset as usize..]);
        assert!(read_exact_at(&mut source, offset, &mut tail).is_err());
    }

    #[test]
    fn reads_each_block_once_while_it_stays_cached() {
        let bytes = vec![7u8; BLOCK_LEN * 2];
        let (_dir, path) = temp_file(&bytes);
        let mut source = FileSource::open(&path, None).unwrap();
        let mut buf = [0u8; 16];
        for offset in [0, 100, 1000, 5000, 60_000] {
            source.read_at(offset, &mut buf).unwrap();
        }
        assert_eq!(source.bytes_read(), BLOCK_LEN as u64);
        source.read_at(BLOCK_LEN as u64 + 1, &mut buf).unwrap();
        assert_eq!(source.bytes_read(), 2 * BLOCK_LEN as u64);
    }

    #[test]
    fn a_set_cancel_flag_stops_the_next_block_read() {
        let bytes = vec![1u8; BLOCK_LEN * 2];
        let (_dir, path) = temp_file(&bytes);
        let flag = Arc::new(AtomicBool::new(false));
        let mut source = FileSource::open(&path, Some(flag.clone())).unwrap();
        let mut buf = [0u8; 8];
        source.read_at(0, &mut buf).unwrap();
        flag.store(true, Ordering::SeqCst);
        // A cached block still answers, and a new block does not.
        source.read_at(8, &mut buf).unwrap();
        let error = source.read_at(BLOCK_LEN as u64, &mut buf).unwrap_err();
        assert!(is_canceled(&error));
    }
}
