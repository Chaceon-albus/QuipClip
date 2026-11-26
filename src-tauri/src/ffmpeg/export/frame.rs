//! The pure parts of the Export Frame command (ADR 069): one frame of a source, written as a
//! PNG file.
//!
//! The frame is the first frame, of the video stream that an export reads, whose PTS is not before
//! the PTS of the request. That is the first frame of the segment that a Mark In at that PTS would
//! start, because an export starts a segment with the same `trim` (ADR 014). The command reads the
//! source as an export reads it: the FLV input of ADR 046 for an FLV, and otherwise the file under
//! `-copyts` with the input seek of ADR 014.
//!
//! This module holds the plan of the one frame ([`plan_frame`]), its filter graph
//! ([`frame_graph`]), the check of the file that FFmpeg wrote ([`verify_png`]), and the
//! slot that lets one command run at a time ([`FrameExports`]). `commands::frame_export` composes
//! them with the probe, the process, the temporary file and the rename of the export.

use super::flv_input::FlvInput;
use super::plan::{display_size, input_seek_seconds};
use crate::ffmpeg::probe::MediaProbe;
use crate::time::{pts_seconds, Pts, Rational};
use std::fs::File;
use std::io::{BufReader, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// How long the FFmpeg process of one Export Frame command may run (ADR 069). A process that runs
/// longer is killed, and the command fails.
pub const FRAME_FFMPEG_LIMIT: Duration = Duration::from_secs(60);

/// How long the rename of the image onto the destination waits, on Windows, for another process
/// that holds the destination (ADR 069). The 30 seconds of an export would outlast the exit wait
/// of ADR 017, which cannot end a rename. Two seconds leave room in that wait for the end of the
/// process and the removal of the work directory. A test in `lib.rs` holds that rule.
pub const FRAME_PUBLISH_BUDGET: Duration = Duration::from_secs(2);

/// True when the file name of `path` ends in `.png`.
///
/// The comparison ignores the case of the extension, because the file systems of both platforms
/// usually ignore it too, and a save dialog keeps the case that the user typed.
#[must_use]
pub fn has_png_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
}

/// How the one FFmpeg process opens the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameInput {
    /// The file itself, under `-copyts`, with the input seek of ADR 014, or with no seek when
    /// that value is not above zero.
    File { seek_seconds: Option<Rational> },
    /// The FLV input of ADR 046: the head in the work directory and the slice of the source from
    /// `offset`, with no seek.
    Flv { input: FlvInput, offset: u64 },
}

/// The plan of one Export Frame command: what the FFmpeg process reads, and the size of the
/// picture that it writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramePlan {
    /// The source file.
    pub source: PathBuf,
    /// The absolute index of the video stream that an export reads.
    pub video_stream_index: u32,
    /// The PTS of the request, in the time base of that stream.
    pub pts: Pts,
    /// The display width of the source (ADR 053).
    pub width: u32,
    /// The display height of the source (ADR 053).
    pub height: u32,
    pub input: FrameInput,
}

/// Why [`plan_frame`] cannot plan the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePlanError {
    /// The probe gives no display size.
    NoPictureSize,
    /// The PTS cannot be written in seconds, or the seek overflows.
    PositionInvalid,
    /// The FLV input has no slice.
    NoSlice,
}

/// Plan the frame at `pts` of `source`.
///
/// With `flv`, the process opens the slice of the one piece of that input, whose seek position
/// is the PTS less the seek margin of ADR 014, as `commands::export` locates it. Without it, the
/// process opens the file with the input seek of ADR 014 ([`input_seek_seconds`]).
///
/// The size of the picture is the display size of the source ([`display_size`]): the picture
/// size with the sample aspect ratio and the rotation applied, as the plan of an export reads it
/// before it fits a picture into a canvas (ADR 053).
pub fn plan_frame(
    source: &Path,
    probe: &MediaProbe,
    pts: Pts,
    flv: Option<FlvInput>,
) -> Result<FramePlan, FramePlanError> {
    let (width, height) = display_size(probe).ok_or(FramePlanError::NoPictureSize)?;
    let input = match flv {
        Some(input) => {
            let offset = *input
                .segment_offsets
                .first()
                .ok_or(FramePlanError::NoSlice)?;
            FrameInput::Flv { input, offset }
        }
        None => {
            let seconds =
                pts_seconds(pts, probe.video_time_base).ok_or(FramePlanError::PositionInvalid)?;
            let start = probe
                .format_start_time
                .unwrap_or_else(|| Rational::new(0, 1).expect("0/1 is a valid Rational"));
            let seek_seconds =
                input_seek_seconds(seconds, start).ok_or(FramePlanError::PositionInvalid)?;
            FrameInput::File { seek_seconds }
        }
    };
    Ok(FramePlan {
        source: source.to_path_buf(),
        video_stream_index: probe.video_stream_index,
        pts,
        width,
        height,
        input,
    })
}

/// The filter graph of the frame (ADR 069): the first frame whose PTS is not before the PTS of
/// the plan, at the display size, with square pixels, as 8-bit RGB with no alpha.
///
/// `trim=start_pts` cuts on the PTS of the stream, as the chain of a segment of an export does
/// (ADR 014), so the frame is the first frame of the segment that a Mark In at that PTS would
/// start. FFmpeg rotates the picture by its default rule before the graph, as in an export.
#[must_use]
pub fn frame_graph(plan: &FramePlan) -> String {
    format!(
        "[0:{}]trim=start_pts={},setpts=PTS-STARTPTS,scale={}:{},setsar=1,format=rgb24[v]",
        plan.video_stream_index,
        plan.pts.value(),
        plan.width,
        plan.height
    )
}

/// The eight bytes that start every PNG file.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The largest length of a PNG chunk: 2^31 - 1 bytes.
const MAX_PNG_CHUNK_LENGTH: u32 = 0x7FFF_FFFF;

/// The length of the data of an `IHDR` chunk.
const IHDR_LENGTH: u32 = 13;

/// The colour type of a PNG picture of red, green and blue samples, with no alpha and no palette.
const PNG_COLOUR_TYPE_RGB: u8 = 2;

/// How many bytes of a chunk the check reads at one time. A large picture is never read whole.
const PNG_READ_BLOCK: usize = 64 * 1024;

/// The table of the CRC-32 of PNG (ISO 3309, polynomial 0xEDB88320, reflected).
const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0_u32; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 == 1 {
                0xEDB8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

/// A CRC-32 as PNG computes it for a chunk, fed in parts.
#[derive(Debug, Clone, Copy)]
pub struct Crc32(u32);

impl Default for Crc32 {
    fn default() -> Self {
        Self(0xFFFF_FFFF)
    }
}

impl Crc32 {
    /// Adds `bytes` to the sum.
    pub fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = CRC_TABLE[((self.0 ^ u32::from(*byte)) & 0xFF) as usize] ^ (self.0 >> 8);
        }
    }

    /// The CRC-32 of every byte added.
    #[must_use]
    pub fn finish(self) -> u32 {
        self.0 ^ 0xFFFF_FFFF
    }
}

/// Reads exactly `buffer.len()` bytes, and names `what` when the file ends first.
fn read_part(reader: &mut impl Read, buffer: &mut [u8], what: &str) -> Result<(), String> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            format!("the file ends inside {what}")
        } else {
            format!("the file could not be read: {error}")
        }
    })
}

/// Check that `reader` holds one complete PNG picture of `width` by `height` pixels, with 8 bits
/// for each of red, green and blue (ADR 069).
///
/// The check reads the file once, from its start to its end, a block at a time:
///
/// 1. The PNG signature.
/// 2. Each chunk: its length, at most 2^31 - 1, its type, its data and its CRC-32, which must be
///    the CRC-32 of the type and the data. A file that ends inside a chunk fails.
/// 3. The first chunk is `IHDR`, of length 13, with the planned width and height, the bit depth
///    8 and the colour type 2 (RGB). No later chunk is an `IHDR`.
/// 4. One or more `IDAT` chunks.
/// 5. An `IEND` chunk of length 0, and the end of the file right after it.
///
/// The check does not decompress the picture.
///
/// # Errors
///
/// A text that says what is wrong, as a diagnostic for the notice (ADR 011).
pub fn verify_png(mut reader: impl Read, width: u32, height: u32) -> Result<(), String> {
    let mut signature = [0_u8; 8];
    read_part(&mut reader, &mut signature, "the PNG signature")?;
    if signature != PNG_SIGNATURE {
        return Err("the file does not start with the PNG signature".to_owned());
    }
    let mut block = vec![0_u8; PNG_READ_BLOCK];
    let mut first = true;
    let mut data_chunks: u32 = 0;
    // True after a chunk that is not IDAT follows the IDAT chunks: PNG keeps them consecutive.
    let mut data_ended = false;
    loop {
        let mut header = [0_u8; 8];
        read_part(&mut reader, &mut header, "a chunk header, before IEND")?;
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        let kind = [header[4], header[5], header[6], header[7]];
        let name = String::from_utf8_lossy(&kind).into_owned();
        if length > MAX_PNG_CHUNK_LENGTH {
            return Err(format!("the chunk {name} has the length {length}"));
        }
        let mut crc = Crc32::default();
        crc.update(&kind);
        if first {
            if &kind != b"IHDR" || length != IHDR_LENGTH {
                return Err(format!(
                    "the first chunk is {name} of length {length}, not IHDR of length 13"
                ));
            }
            let mut fields = [0_u8; IHDR_LENGTH as usize];
            read_part(&mut reader, &mut fields, "the IHDR chunk")?;
            crc.update(&fields);
            let found_width = u32::from_be_bytes([fields[0], fields[1], fields[2], fields[3]]);
            let found_height = u32::from_be_bytes([fields[4], fields[5], fields[6], fields[7]]);
            let (depth, colour) = (fields[8], fields[9]);
            if (found_width, found_height) != (width, height) {
                return Err(format!(
                    "the picture is {found_width}x{found_height}, not {width}x{height}"
                ));
            }
            if depth != 8 || colour != PNG_COLOUR_TYPE_RGB {
                return Err(format!(
                    "the picture has the bit depth {depth} and the colour type {colour}, not 8 and 2"
                ));
            }
            // PNG defines compression method 0, filter method 0, and interlace method 0 (none)
            // or 1 (Adam7). Any other value is not a PNG that a viewer can read.
            let (compression, filter, interlace) = (fields[10], fields[11], fields[12]);
            if compression != 0 || filter != 0 || interlace > 1 {
                return Err(format!(
                    "the IHDR chunk has the compression method {compression}, the filter method \
                     {filter} and the interlace method {interlace}, not 0, 0 and 0 or 1"
                ));
            }
        } else {
            if &kind == b"IHDR" {
                return Err("a second IHDR chunk follows the first".to_owned());
            }
            let mut remaining = length as usize;
            while remaining > 0 {
                let part = remaining.min(block.len());
                read_part(
                    &mut reader,
                    &mut block[..part],
                    &format!("the chunk {name}"),
                )?;
                crc.update(&block[..part]);
                remaining -= part;
            }
        }
        let mut stored = [0_u8; 4];
        read_part(
            &mut reader,
            &mut stored,
            &format!("the CRC of the chunk {name}"),
        )?;
        if u32::from_be_bytes(stored) != crc.finish() {
            return Err(format!("the CRC of the chunk {name} is wrong"));
        }
        match &kind {
            b"IDAT" => {
                if data_ended {
                    return Err(
                        "an IDAT chunk follows another chunk after the IDAT chunks".to_owned()
                    );
                }
                data_chunks = data_chunks.saturating_add(1);
            }
            b"IEND" => {
                if length != 0 {
                    return Err(format!("the IEND chunk has the length {length}"));
                }
                if data_chunks == 0 {
                    return Err("the file has no IDAT chunk".to_owned());
                }
                let mut after = [0_u8; 1];
                return match reader.read(&mut after) {
                    Ok(0) => Ok(()),
                    Ok(_) => Err("the file goes on after the IEND chunk".to_owned()),
                    Err(error) => Err(format!("the file could not be read: {error}")),
                };
            }
            _ => data_ended = data_chunks > 0,
        }
        first = false;
    }
}

/// [`verify_png`] of the file at `path`, read through a buffer.
///
/// # Errors
///
/// As [`verify_png`], and a text when the file cannot be opened.
pub fn verify_png_file(path: &Path, width: u32, height: u32) -> Result<(), String> {
    let file =
        File::open(path).map_err(|error| format!("the file could not be opened: {error}"))?;
    verify_png(BufReader::new(file), width, height)
}

/// Why [`FrameExports::begin`] refused a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameExportRefusal {
    /// Another Export Frame command runs.
    Running,
    /// The application exits.
    Closed,
}

#[derive(Default)]
struct FrameExportsInner {
    closed: bool,
    /// The cancel flag of the command that runs.
    running: Option<Arc<AtomicBool>>,
}

/// The one slot of the Export Frame command, managed by Tauri (ADR 069).
///
/// One command runs at a time, and a second one is refused, not queued. The slot is apart from
/// the export queue (ADR 049), so a command can run while an export runs.
#[derive(Default)]
pub struct FrameExports {
    inner: Mutex<FrameExportsInner>,
}

impl FrameExports {
    fn lock(&self) -> std::sync::MutexGuard<'_, FrameExportsInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Take the slot for a new command.
    ///
    /// # Errors
    ///
    /// [`FrameExportRefusal::Running`] while another command holds the slot, and
    /// [`FrameExportRefusal::Closed`] after the exit began.
    pub fn begin(self: &Arc<Self>) -> Result<FrameExportSlot, FrameExportRefusal> {
        let mut inner = self.lock();
        if inner.closed {
            return Err(FrameExportRefusal::Closed);
        }
        if inner.running.is_some() {
            return Err(FrameExportRefusal::Running);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.running = Some(Arc::clone(&cancel));
        Ok(FrameExportSlot {
            registry: Arc::clone(self),
            cancel,
        })
    }

    /// The exit (ADR 017): refuse every later command, and cancel the command that runs. This
    /// does not wait. The caller watches [`Self::is_running`].
    pub fn close_for_exit(&self) {
        let mut inner = self.lock();
        inner.closed = true;
        if let Some(cancel) = &inner.running {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    /// True while a command holds the slot. The slot goes free only when the command dropped its
    /// process, its temporary file and its work directory.
    #[must_use]
    pub fn is_running(&self) -> bool {
        self.lock().running.is_some()
    }
}

/// The slot of one Export Frame command. Dropping it frees the slot.
///
/// The command holds it for its whole run and drops it last, after the guard of its process,
/// the guard of its temporary file and its work directory, so a free slot means that those are
/// gone. The exit handler waits for that (ADR 017).
pub struct FrameExportSlot {
    registry: Arc<FrameExports>,
    cancel: Arc<AtomicBool>,
}

impl FrameExportSlot {
    /// The cancel flag of the command, which the exit sets.
    #[must_use]
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    /// True after the exit canceled the command.
    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Drop for FrameExportSlot {
    fn drop(&mut self) {
        let mut inner = self.registry.lock();
        if inner
            .running
            .as_ref()
            .is_some_and(|running| Arc::ptr_eq(running, &self.cancel))
        {
            inner.running = None;
        }
    }
}

/// PNG files for the tests of the check and of the command.
#[cfg(test)]
pub(crate) mod test_support {
    use super::{Crc32, PNG_SIGNATURE};

    /// One PNG chunk of `kind` with `data`, with its length and its CRC.
    pub(crate) fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(data);
        let mut crc = Crc32::default();
        crc.update(kind);
        crc.update(data);
        bytes.extend_from_slice(&crc.finish().to_be_bytes());
        bytes
    }

    /// The data of an `IHDR` chunk.
    pub(crate) fn ihdr(width: u32, height: u32, depth: u8, colour: u8) -> Vec<u8> {
        let mut data = width.to_be_bytes().to_vec();
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&[depth, colour, 0, 0, 0]);
        data
    }

    /// A PNG file of `width` by `height` with these `IHDR` fields, two `IDAT` chunks, a text
    /// chunk and `IEND`. The `IDAT` data is not a picture: the check does not decompress it.
    pub(crate) fn png(width: u32, height: u32, depth: u8, colour: u8) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend(chunk(b"IHDR", &ihdr(width, height, depth, colour)));
        bytes.extend(chunk(b"tEXt", b"Software\0QuipClip test"));
        bytes.extend(chunk(b"IDAT", &[0x78, 0x9C, 1, 2, 3]));
        bytes.extend(chunk(b"IDAT", &vec![7_u8; 200_000]));
        bytes.extend(chunk(b"IEND", &[]));
        bytes
    }

    /// A complete RGB PNG of `width` by `height` with 8 bits, as the check accepts it.
    pub(crate) fn rgb_png(width: u32, height: u32) -> Vec<u8> {
        png(width, height, 8, 2)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{chunk, ihdr, png};
    use super::*;
    use crate::ffmpeg::probe::AudioProbe;

    fn probe() -> MediaProbe {
        MediaProbe {
            format_names: vec!["mov".to_owned(), "mp4".to_owned()],
            format_long_name: None,
            format_start_time: None,
            video_codec: "h264".to_owned(),
            video_profile: None,
            pixel_format: None,
            bit_depth: None,
            width: 1920,
            height: 1080,
            video_stream_index: 1,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: None,
            video_duration_ticks: None,
            approximate_duration_seconds: None,
            avg_frame_rate: None,
            r_frame_rate: None,
            reported_frame_count: None,
            sample_aspect_ratio: None,
            rotation: 0,
            video_end_pts: None,
            audio: Some(AudioProbe {
                index: 0,
                codec: Some("aac".to_owned()),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: None,
                reported_packets: None,
                holds_no_packets: false,
                start_time: None,
                duration: None,
                tagged_end: None,
            }),
            audio_streams: Vec::new(),
        }
    }

    fn check(bytes: &[u8]) -> Result<(), String> {
        verify_png(bytes, 640, 360)
    }

    #[test]
    fn only_a_name_that_ends_in_png_is_a_png_name() {
        assert!(has_png_extension(Path::new("/a/cover.png")));
        assert!(has_png_extension(Path::new("/a/cover.PNG")));
        assert!(!has_png_extension(Path::new("/a/cover.jpg")));
        assert!(!has_png_extension(Path::new("/a/cover")));
        assert!(!has_png_extension(Path::new("/a/cover.png.tmp")));
        // A name that is only the extension has no stem, so it has no extension either.
        assert!(!has_png_extension(Path::new("/a/.png")));
    }

    #[test]
    fn a_file_source_seeks_five_seconds_before_the_frame_less_the_container_start() {
        let mut source = probe();
        source.format_start_time = Some(Rational::new(1, 1).unwrap());
        // 20 s - 1 s - 5 s = 14 s.
        let plan = plan_frame(Path::new("/m/a.mp4"), &source, Pts::new(1_800_000), None).unwrap();
        assert_eq!(
            plan.input,
            FrameInput::File {
                seek_seconds: Some(Rational::new(14, 1).unwrap())
            }
        );
        assert_eq!((plan.width, plan.height), (1920, 1080));
        assert_eq!(plan.video_stream_index, 1);
    }

    #[test]
    fn a_frame_near_the_start_has_no_seek() {
        // 5 s - 0 - 5 s = 0, which is not above zero.
        let plan = plan_frame(Path::new("/m/a.mp4"), &probe(), Pts::new(450_000), None).unwrap();
        assert_eq!(plan.input, FrameInput::File { seek_seconds: None });
    }

    #[test]
    fn an_flv_source_opens_the_slice_of_its_one_piece() {
        let input = FlvInput {
            head_name: "h0.flv".to_owned(),
            source_size: 9_000,
            segment_offsets: vec![4_096],
            first_frame_offset: 13,
        };
        let plan = plan_frame(
            Path::new("/m/a.flv"),
            &probe(),
            Pts::new(900_000),
            Some(input.clone()),
        )
        .unwrap();
        assert_eq!(
            plan.input,
            FrameInput::Flv {
                input,
                offset: 4_096
            }
        );
    }

    #[test]
    fn an_flv_input_without_a_slice_is_refused() {
        let input = FlvInput {
            head_name: "h0.flv".to_owned(),
            source_size: 9_000,
            segment_offsets: Vec::new(),
            first_frame_offset: 13,
        };
        assert_eq!(
            plan_frame(Path::new("/m/a.flv"), &probe(), Pts::new(0), Some(input)),
            Err(FramePlanError::NoSlice)
        );
    }

    #[test]
    fn the_picture_takes_the_display_size_of_the_source() {
        // Anamorphic 1440x1080 at 4:3 pixels is 1920x1080 on screen.
        let mut source = probe();
        source.width = 1440;
        source.sample_aspect_ratio = Some(Rational::new(4, 3).unwrap());
        let plan = plan_frame(Path::new("/m/a.mp4"), &source, Pts::new(0), None).unwrap();
        assert_eq!((plan.width, plan.height), (1920, 1080));
        // A quarter turn swaps the sides.
        let mut rotated = probe();
        rotated.rotation = 90;
        let plan = plan_frame(Path::new("/m/a.mp4"), &rotated, Pts::new(0), None).unwrap();
        assert_eq!((plan.width, plan.height), (1080, 1920));
    }

    #[test]
    fn the_graph_cuts_at_the_pts_and_writes_8_bit_rgb_at_the_display_size() {
        let plan = plan_frame(Path::new("/m/a.mp4"), &probe(), Pts::new(123_456), None).unwrap();
        assert_eq!(
            frame_graph(&plan),
            "[0:1]trim=start_pts=123456,setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,format=rgb24[v]"
        );
    }

    #[test]
    fn the_crc_is_the_crc_32_of_png() {
        // The check value of CRC-32 (ISO 3309), and the CRC of the IEND chunk of every PNG.
        let mut crc = Crc32::default();
        crc.update(b"123456789");
        assert_eq!(crc.finish(), 0xCBF4_3926);
        let mut crc = Crc32::default();
        crc.update(b"IEND");
        assert_eq!(crc.finish(), 0xAE42_6082);
    }

    #[test]
    fn the_check_accepts_one_complete_rgb_png_of_the_planned_size() {
        assert_eq!(check(&png(640, 360, 8, 2)), Ok(()));
    }

    #[test]
    fn the_check_refuses_two_pngs_one_after_the_other() {
        let mut bytes = png(640, 360, 8, 2);
        bytes.extend(png(640, 360, 8, 2));
        assert_eq!(
            check(&bytes),
            Err("the file goes on after the IEND chunk".to_owned())
        );
    }

    #[test]
    fn the_check_refuses_bytes_after_iend() {
        let mut bytes = png(640, 360, 8, 2);
        bytes.push(0);
        assert!(check(&bytes).is_err());
    }

    #[test]
    fn the_check_refuses_a_truncated_png() {
        let bytes = png(640, 360, 8, 2);
        // Inside the large IDAT chunk, and right in front of IEND.
        assert!(check(&bytes[..bytes.len() / 2])
            .unwrap_err()
            .contains("ends inside"));
        assert!(check(&bytes[..bytes.len() - 12])
            .unwrap_err()
            .contains("before IEND"));
        assert!(check(&bytes[..5]).is_err());
    }

    #[test]
    fn the_check_refuses_another_size() {
        let detail = check(&png(640, 362, 8, 2)).unwrap_err();
        assert!(detail.contains("640x362"), "{detail}");
        assert!(check(&png(360, 640, 8, 2)).is_err());
    }

    #[test]
    fn the_check_refuses_16_bits_alpha_and_a_palette() {
        // 16-bit RGB, 8-bit RGBA, an 8-bit palette, and 8-bit grey.
        for (depth, colour) in [(16, 2), (8, 6), (8, 3), (8, 0)] {
            assert!(
                check(&png(640, 360, depth, colour)).is_err(),
                "{depth} {colour}"
            );
        }
    }

    #[test]
    fn the_check_refuses_a_wrong_crc() {
        let mut bytes = png(640, 360, 8, 2);
        // The last byte of the data of the large IDAT chunk.
        let index = bytes.len() - 12 - 4 - 1;
        bytes[index] ^= 0xFF;
        assert_eq!(
            check(&bytes),
            Err("the CRC of the chunk IDAT is wrong".to_owned())
        );
    }

    /// A PNG of 640x360, 8-bit RGB, whose `IHDR` ends in these three methods, with a correct CRC.
    fn png_with_methods(compression: u8, filter: u8, interlace: u8) -> Vec<u8> {
        let mut fields = ihdr(640, 360, 8, 2);
        fields[10..].copy_from_slice(&[compression, filter, interlace]);
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend(chunk(b"IHDR", &fields));
        bytes.extend(chunk(b"IDAT", &[0x78, 0x9C, 1]));
        bytes.extend(chunk(b"IEND", &[]));
        bytes
    }

    #[test]
    fn the_check_accepts_an_interlaced_png() {
        assert_eq!(check(&png_with_methods(0, 0, 1)), Ok(()));
    }

    #[test]
    fn the_check_refuses_an_undefined_compression_method() {
        let detail = check(&png_with_methods(1, 0, 0)).unwrap_err();
        assert!(detail.contains("compression method 1"), "{detail}");
    }

    #[test]
    fn the_check_refuses_an_undefined_filter_method() {
        let detail = check(&png_with_methods(0, 1, 0)).unwrap_err();
        assert!(detail.contains("filter method 1"), "{detail}");
    }

    #[test]
    fn the_check_refuses_an_undefined_interlace_method() {
        let detail = check(&png_with_methods(0, 0, 2)).unwrap_err();
        assert!(detail.contains("interlace method 2"), "{detail}");
    }

    #[test]
    fn the_check_refuses_idat_chunks_that_are_not_consecutive() {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend(chunk(b"IHDR", &ihdr(640, 360, 8, 2)));
        bytes.extend(chunk(b"IDAT", &[0x78, 0x9C, 1]));
        bytes.extend(chunk(b"tEXt", b"a"));
        bytes.extend(chunk(b"IDAT", &[2]));
        bytes.extend(chunk(b"IEND", &[]));
        assert_eq!(
            check(&bytes),
            Err("an IDAT chunk follows another chunk after the IDAT chunks".to_owned())
        );
    }

    #[test]
    fn the_check_refuses_a_file_that_is_not_a_png() {
        assert!(check(b"GIF89a not a png at all").is_err());
        assert!(check(b"").is_err());
        // A PNG with no IDAT, and one that starts with another chunk.
        let mut empty = PNG_SIGNATURE.to_vec();
        empty.extend(chunk(b"IHDR", &ihdr(640, 360, 8, 2)));
        empty.extend(chunk(b"IEND", &[]));
        assert_eq!(check(&empty), Err("the file has no IDAT chunk".to_owned()));
        let mut late = PNG_SIGNATURE.to_vec();
        late.extend(chunk(b"tEXt", b"a"));
        late.extend(chunk(b"IHDR", &ihdr(640, 360, 8, 2)));
        assert!(check(&late).is_err());
    }

    #[test]
    fn one_command_runs_at_a_time_and_a_second_one_is_refused() {
        let frames = Arc::new(FrameExports::default());
        let first = frames.begin().expect("the slot starts free");
        assert!(frames.is_running());
        assert_eq!(frames.begin().err(), Some(FrameExportRefusal::Running));
        drop(first);
        assert!(!frames.is_running());
        assert!(frames.begin().is_ok());
    }

    #[test]
    fn the_exit_cancels_the_running_command_and_refuses_later_ones() {
        let frames = Arc::new(FrameExports::default());
        let slot = frames.begin().unwrap();
        frames.close_for_exit();
        assert!(slot.is_canceled());
        assert!(
            frames.is_running(),
            "the slot stays held until the command drops it"
        );
        drop(slot);
        assert!(!frames.is_running());
        assert_eq!(frames.begin().err(), Some(FrameExportRefusal::Closed));
    }
}
