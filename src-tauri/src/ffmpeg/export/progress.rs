//! The pure progress accumulator for the ADR 014 export renderer.
//!
//! ADR 014's "The command" section runs ffmpeg with `-progress pipe:1 -nostats`. In that
//! mode ffmpeg writes repeating blocks of `key=value` lines, one key per line, and it ends
//! every block with a `progress=` line whose value is `continue` or `end`. This module turns
//! that line stream into one [`ProgressSnapshot`] per completed block.
//!
//! Everything here is a pure accumulator, like `capabilities::listing`: it takes `&str` and
//! returns owned data. It spawns no process, reads no pipe, and reads no clock, so the whole
//! wire format is testable in CI on a machine that has no ffmpeg installed. The process
//! stage owns the pipe and feeds this type one line at a time.
//!
//! The parser never fails. It sits on a pipe from another process, and a line ffmpeg writes
//! that this parser does not recognise must never be able to kill an export in progress, so
//! a malformed line is dropped and an unknown key is ignored. Measurement 13 of ADR 014
//! already shows that ffmpeg's surface changes between versions; the captured block in the
//! tests below carries `stream_0_0_q`, whose name depends on the output stream, which is
//! proof enough that the key set is not fixed.
//!
//! # How the process stage must read the pipe
//!
//! That promise only reaches the export if the caller reads the pipe the same way, and the
//! obvious reader does not. `BufReader::lines()` yields `Err(InvalidData)` for a line that
//! is not valid UTF-8, so a `?` on that error would abort an export that is running
//! perfectly well -- the failure this module exists to make impossible, reintroduced one
//! layer up. The process stage must read with `read_until(b'\n')` and
//! `String::from_utf8_lossy`, or drop the erroring line and keep reading, so that a byte
//! sequence ffmpeg never intended to write still cannot stop the export.
//!
//! ADR 002 keeps floating point out of this crate's numeric paths, so `fps` and `speed`
//! parse through [`Rational::from_decimal_str`], which reads a fixed-point decimal exactly.
//! There is no `f64` anywhere in this file.

use crate::time::Rational;

/// One completed `-progress` block.
///
/// Every *reported* field is `Option`, because ffmpeg writes the literal `N/A` for a value
/// it does not have yet -- `bitrate` and `total_size` both do this early in a run. `N/A`
/// means absent, never zero, so it parses to `None`, and a genuine reported zero (`frame=0`
/// and `fps=0.00` both appear in the first block of a real run) stays `Some` and remains
/// distinguishable from it. `done` is not one of those fields: ffmpeg does not report it as
/// a value, it is which of the two terminators ended the block.
///
/// # There is deliberately no output-time field
///
/// ADR 014 measurement 12: `out_time_us`, `out_time_ms`, and `out_time` are **wrong** under
/// `-copyts`, and ADR 014 requires `-copyts` on every input. One real run reported
/// `out_time_us=0` at frame 979, and it reported 20.84 s at the end of a 60-second output.
/// The `frame` field was correct in that same run, so ADR 014's "Progress" section reads
/// progress from `frame` and compares the final value with `ExportPlan::expected_frames`.
/// Those three keys are therefore parsed by nothing and stored nowhere. Do not add them
/// back: a progress bar driven by `out_time_us` would drop to zero in the middle of an
/// export and then stop short of the true duration, and a completion check driven by it
/// would call a correct export a failure.
///
/// # There is deliberately no `Default`
///
/// Leaving `Default` off does not make a misleading value unconstructible. Every field here
/// is public and the type is not `#[non_exhaustive]`, so a caller can still write the same
/// placeholder longhand. What it does is force every construction site to name all five
/// fields, and that is what keeps the compile-break guard in
/// `ignores_out_time_us_and_out_time_ms_because_copyts_makes_them_wrong` working: a field
/// added to this struct cannot slip into a test unnoticed, because the exhaustive literals
/// there stop compiling until a person fills it in.
///
/// The value a `Default` would have produced is also the wrong thing to want. It reads
/// `frame: None, done: false`, which is exactly how a real block reads when ffmpeg reported
/// nothing in it, so a caller that seeded its state with one could not tell its own
/// placeholder from a snapshot the encoder really produced, and a stalled export would look
/// like an export that has not started. The absence of progress is the absence of a
/// *snapshot*: [`ProgressReader::push_line`] answers `None` for every line before a block
/// completes, and for every line of a block that never completes. A caller holds
/// `Option<ProgressSnapshot>` and starts at `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressSnapshot {
    /// The number of frames written so far. This is the one field ADR 014 trusts.
    pub frame: Option<u64>,
    /// The instantaneous encoding rate in frames per second, exact.
    pub fps: Option<Rational>,
    /// The encoding rate as a multiple of real time, exact. ffmpeg writes it with a trailing
    /// `x`, which this parser strips before it reads the number. Two forms that ffmpeg
    /// really writes read as absent here: `N/A`, and the exponent notation such as
    /// `1.23e+03x` that its `%4.3g` format produces for a very fast encode.
    pub speed: Option<Rational>,
    /// The bytes written to the output so far.
    pub total_size: Option<u64>,
    /// `true` when the block that produced this snapshot ended with `progress=end`, which is
    /// the last block ffmpeg writes.
    pub done: bool,
}

/// The keys collected since the last `progress=` line.
///
/// This is deliberately not a [`ProgressSnapshot`]. A block that is still being collected is
/// not a snapshot: it has no `done` answer yet, because only the terminator line supplies
/// one. Keeping the two types apart is also what lets `ProgressSnapshot` stay free of a
/// `Default` impl -- see the section on that in its own documentation -- while this private
/// type keeps the `Default` that clearing the collected state needs.
#[derive(Debug, Clone, Default)]
struct PendingBlock {
    frame: Option<u64>,
    fps: Option<Rational>,
    speed: Option<Rational>,
    total_size: Option<u64>,
}

impl PendingBlock {
    /// Seal this collected block into a snapshot, once the terminator line has said whether
    /// it was the last one.
    fn into_snapshot(self, done: bool) -> ProgressSnapshot {
        ProgressSnapshot {
            frame: self.frame,
            fps: self.fps,
            speed: self.speed,
            total_size: self.total_size,
            done,
        }
    }
}

/// The line-at-a-time accumulator that produces [`ProgressSnapshot`] values.
///
/// Feed it every line ffmpeg writes to the progress pipe, in order. It answers `Some` only
/// on the `progress=` line that terminates a block, and `None` for every line before it. A
/// partial trailing block -- the stream ends, or ffmpeg dies, before the next `progress=`
/// line -- therefore produces no snapshot at all, and the half-collected values are
/// discarded instead of being reported as if the block had completed.
///
/// Each snapshot stands alone. The keys repeat in every block, and the accumulator clears
/// its collected state on each `progress=` line, so a value that ffmpeg reported in one
/// block and omitted from the next reads as `None` in the next snapshot instead of silently
/// carrying the stale value forward.
#[derive(Debug, Clone, Default)]
pub struct ProgressReader {
    /// The block currently being collected.
    pending: PendingBlock,
}

impl ProgressReader {
    /// Build an accumulator with no collected state.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Consume one line of the progress stream.
    ///
    /// Returns `Some` only when this line is the `progress=` line that completes a block. A
    /// line with no `=`, an empty line, and a key this parser does not know -- which
    /// includes the empty key that a line such as `=5` produces -- are all dropped without
    /// effect; the module documentation says why none of them may be fatal.
    ///
    /// A key that repeats inside one block takes its last value, including when that last
    /// value is `N/A` and therefore clears an earlier one. ffmpeg writes each key once per
    /// block, so this rule only settles an ordering question that the real format never
    /// asks.
    ///
    /// # Pass one line, without its `\n`
    ///
    /// This function does not split. A string holding a whole block is read as one
    /// `key=value` pair, so `"frame=25\nprogress=end"` sets `frame` to `None` -- the value
    /// does not parse as a number -- and never reaches a terminator, after which the reader
    /// reports nothing for the rest of the export and says nothing about why. The process
    /// stage owns the splitting; the module documentation says how it should read the pipe.
    #[must_use]
    pub fn push_line(&mut self, line: &str) -> Option<ProgressSnapshot> {
        let (key, value) = split_field(line)?;
        match key {
            "frame" => self.pending.frame = parse_u64(value),
            "total_size" => self.pending.total_size = parse_u64(value),
            "fps" => self.pending.fps = Rational::from_decimal_str(value),
            "speed" => self.pending.speed = parse_speed(value),
            "progress" => {
                // The block terminator. Its *key* ends the block; its value only decides
                // `done`. Completing the block on the key, and not on a match against
                // `continue` or `end`, is deliberate: an ffmpeg that ever writes a third
                // value would otherwise strand this block and every block after it in
                // `pending`, and the export would report no progress at all from that line
                // onward while still running normally.
                return Some(std::mem::take(&mut self.pending).into_snapshot(value == "end"));
            }
            // Every other key, which includes `out_time_us`, `out_time_ms`, `out_time`,
            // `bitrate`, `dup_frames`, `drop_frames`, and the per-stream `stream_0_0_q`.
            // The `ProgressSnapshot` documentation says why the three output-time keys are
            // on this list on purpose and must stay on it.
            _ => {}
        }
        None
    }
}

/// Split one line into a trimmed key and a trimmed value, or `None` when the line carries no
/// `key=value` pair at all.
///
/// Both sides are trimmed because ffmpeg pads its values: it formats `speed` with `%4.3g`,
/// so a slow encode really does write `speed= 0.5x`, and builds pad `frame` the same way.
/// Without the trim on the value, every padded number would fail to parse and read as
/// absent. The trim on the key is defensive symmetry -- no ffmpeg pads a key -- and the
/// tests pin it as such.
///
/// The `strip_suffix('\r')` makes explicit that a `\r\n` line ending is expected and
/// harmless, which it is on Windows. It carries no behaviour of its own: `\r` is whitespace
/// to `str::trim`, so the trims below already remove it, and deleting this line changes no
/// result. It is here only to name the assumption where a reader looks for it, exactly as
/// `capabilities::listing`'s `strip_cr` does for the listing parsers, and for the same
/// reason that function documents.
fn split_field(line: &str) -> Option<(&str, &str)> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}

/// Parse an unsigned count. `N/A`, and any other text that is not a plain number, fails to
/// parse and therefore reads as absent, which is the distinction ffmpeg's `N/A` makes. A
/// reported `0` is a number and stays `Some(0)`: `frame=0` is in the first block of every
/// real run, and reading it as absent would report a starting export as having no frame
/// count at all.
fn parse_u64(value: &str) -> Option<u64> {
    value.parse().ok()
}

/// Parse a `speed` value such as `55.6x`.
///
/// The trailing `x` is ffmpeg's unit marker, not part of the number. It is stripped when it
/// is present and tolerated when it is absent, so this keeps working if a later ffmpeg drops
/// it.
///
/// Two forms that ffmpeg really writes read as absent. `N/A` is the first. The second is
/// exponent notation: this field is formatted with `%4.3g`, which switches to a form such as
/// `1.23e+03x` once the exponent reaches 3, and [`Rational::from_decimal_str`] accepts only
/// a fixed-point decimal. A very fast encode therefore reports no speed rather than a
/// rounded one. That is the right trade here -- ADR 014 drives progress from `frame`, and
/// `speed` is a display value -- and ADR 002 rules out the floating-point parse that would
/// be the alternative.
fn parse_speed(value: &str) -> Option<Rational> {
    Rational::from_decimal_str(value.strip_suffix('x').unwrap_or(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One real block, captured verbatim from `ffmpeg 9.0.1 -progress pipe:1 -nostats`.
    const CAPTURED_END_BLOCK: &str = "frame=25
fps=0.00
stream_0_0_q=-1.0
bitrate=N/A
total_size=N/A
out_time_us=920000
out_time_ms=920000
out_time=00:00:00.920000
dup_frames=0
drop_frames=0
speed=55.6x
progress=end
";

    /// Feed every line of `input` to one reader and collect the snapshots it produced.
    ///
    /// This splits with `str::lines()`, which strips a `\r\n` line ending down to the text.
    /// A test about carriage returns therefore cannot use this helper; see
    /// [`snapshots_with_line_endings_intact`].
    fn snapshots(input: &str) -> Vec<ProgressSnapshot> {
        let mut reader = ProgressReader::new();
        input
            .lines()
            .filter_map(|line| reader.push_line(line))
            .collect()
    }

    /// The same, but splitting only on `\n`, so a `\r` from a CRLF line ending survives into
    /// the `push_line` argument instead of being removed by the splitter.
    fn snapshots_with_line_endings_intact(input: &str) -> Vec<ProgressSnapshot> {
        let mut reader = ProgressReader::new();
        input
            .split_inclusive('\n')
            .filter_map(|line| reader.push_line(line.trim_end_matches('\n')))
            .collect()
    }

    /// Build an expected value as an exact fraction, so no expectation in this file contains
    /// a decimal literal that a reader has to trust.
    fn rational(num: i64, den: i64) -> Rational {
        Rational::new(num, den).unwrap()
    }

    #[test]
    fn parses_the_captured_end_block_into_one_snapshot() {
        let snapshots = snapshots(CAPTURED_END_BLOCK);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].frame, Some(25));
        assert_eq!(snapshots[0].total_size, None);
        assert_eq!(snapshots[0].speed, Some(rational(278, 5)));
        assert!(snapshots[0].done);
    }

    #[test]
    fn reports_a_continue_block_as_not_done() {
        let snapshots = snapshots("frame=10\nprogress=continue\n");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].frame, Some(10));
        assert!(!snapshots[0].done);
    }

    #[test]
    fn does_not_carry_a_value_from_one_block_into_the_next() {
        let stream = "frame=10\ntotal_size=1024\nspeed=2.0x\nprogress=continue\n\
                      frame=20\nprogress=end\n";
        let snapshots = snapshots(stream);
        assert_eq!(snapshots.len(), 2);

        assert_eq!(snapshots[0].frame, Some(10));
        assert_eq!(snapshots[0].total_size, Some(1024));
        assert_eq!(snapshots[0].speed, Some(rational(2, 1)));
        assert!(!snapshots[0].done);

        assert_eq!(snapshots[1].frame, Some(20));
        assert_eq!(snapshots[1].total_size, None);
        assert_eq!(snapshots[1].speed, None);
        assert!(snapshots[1].done);
    }

    #[test]
    fn yields_no_snapshot_for_a_partial_trailing_block() {
        // ffmpeg was killed, or the pipe closed, between two `progress=` lines.
        assert_eq!(
            snapshots("frame=25\nfps=30.0\ntotal_size=4096\n"),
            Vec::new()
        );
    }

    #[test]
    fn yields_no_snapshot_for_an_empty_stream() {
        assert_eq!(snapshots(""), Vec::new());
    }

    #[test]
    fn treats_not_available_as_absent_rather_than_zero() {
        let stream = "frame=N/A\nfps=N/A\nspeed=N/A\ntotal_size=N/A\nprogress=continue\n";
        let snapshots = snapshots(stream);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].frame, None);
        assert_eq!(snapshots[0].fps, None);
        assert_eq!(snapshots[0].speed, None);
        assert_eq!(snapshots[0].total_size, None);
    }

    #[test]
    fn keeps_a_reported_zero_distinct_from_not_available() {
        // Every reported field, not only the rational ones. `frame=0` and `fps=0.00` are
        // both in the first block of a real run, and `total_size=0` is what a run reports
        // before the muxer has written anything, so a parser that read a literal zero as
        // absent would report a starting export as having no progress at all.
        let stream = "frame=0\nfps=0.00\nspeed=0.0x\ntotal_size=0\nprogress=continue\n";
        let reported_zeros = snapshots(stream);
        assert_eq!(
            reported_zeros,
            vec![ProgressSnapshot {
                frame: Some(0),
                fps: Some(rational(0, 1)),
                speed: Some(rational(0, 1)),
                total_size: Some(0),
                done: false,
            }]
        );

        // And the same distinction inside the real captured block: a reported zero `fps`
        // beside an `N/A` `total_size`.
        let captured = snapshots(CAPTURED_END_BLOCK);
        assert_eq!(captured[0].fps, Some(rational(0, 1)));
        assert_eq!(captured[0].total_size, None);
    }

    #[test]
    fn tolerates_the_padding_ffmpeg_prints_around_a_value() {
        // ffmpeg formats `speed` with `%4.3g`, so a slow encode writes `speed= 0.5x` with a
        // leading space, and builds pad the other numbers the same way. Without the value
        // trim in `split_field` every padded number here would read as absent.
        let stream = "frame=  123\nfps= 24.0\nspeed= 0.5x\ntotal_size=   4096\n\
                      progress=continue\n";
        let padded = snapshots(stream);
        assert_eq!(
            padded,
            vec![ProgressSnapshot {
                frame: Some(123),
                fps: Some(rational(24, 1)),
                speed: Some(rational(1, 2)),
                total_size: Some(4096),
                done: false,
            }]
        );

        // The key side is defensive symmetry rather than observed output: no ffmpeg pads a
        // key. This pins the behaviour so the trim is not mistaken for dead code.
        let padded_key = snapshots(" frame = 7 \nprogress=end\n");
        assert_eq!(padded_key.len(), 1);
        assert_eq!(padded_key[0].frame, Some(7));
    }

    #[test]
    fn ignores_blank_lines_garbage_and_a_line_without_an_equals_sign() {
        let stream = "\nnot a key value line\n   \nframe=7\n=novalue\n\
                      Press [q] to stop, [?] for help\nprogress=continue\n";
        let snapshots = snapshots(stream);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].frame, Some(7));
        assert!(!snapshots[0].done);
    }

    #[test]
    fn ignores_an_unknown_key() {
        // `stream_0_0_q` is real, and its name depends on the output stream, so the key set
        // is open. A key this parser has never seen must change nothing.
        let stream = "stream_0_0_q=-1.0\na_key_from_a_later_ffmpeg=17\nframe=3\nprogress=end\n";
        assert_eq!(
            snapshots(stream),
            vec![ProgressSnapshot {
                frame: Some(3),
                fps: None,
                speed: None,
                total_size: None,
                done: true,
            }]
        );
    }

    #[test]
    fn ignores_out_time_us_and_out_time_ms_because_copyts_makes_them_wrong() {
        // ADR 014 measurement 12: one real `-copyts` run reported `out_time_us=0` at frame
        // 979, and 20.84 s at the end of a 60-second output.
        //
        // The comparison below uses the second, non-zero measurement on purpose. Zero is
        // also what an absent plain-integer field reads as, so a snapshot that did carry an
        // `out_time_us: u64` would still compare equal to one built from a block without the
        // line, and this test would pass over exactly the regression it exists to catch. No
        // absent-value representation equals 20840000.
        let with_out_time = "frame=979\nout_time_us=20840000\nout_time_ms=20840000\n\
                             out_time=00:00:20.840000\nprogress=continue\n";
        let without_out_time = "frame=979\nprogress=continue\n";
        // Both sides being empty would satisfy the equality vacuously, which any mutation
        // that stops the terminator emitting would achieve.
        assert_eq!(snapshots(with_out_time).len(), 1);
        assert_eq!(snapshots(with_out_time), snapshots(without_out_time));

        // The exhaustive struct literal below is the guard that actually stops one of these
        // fields being added back. `ProgressSnapshot` has no `Default` and is not
        // `#[non_exhaustive]`, so a new field stops this literal compiling and a person has
        // to decide what belongs there. Writing `..Default::default()` here, or marking the
        // struct `#[non_exhaustive]`, would remove that guard without failing anything.
        let end_of_run = "out_time_us=20840000\nout_time_ms=20840000\nprogress=end\n";
        assert_eq!(
            snapshots(end_of_run),
            vec![ProgressSnapshot {
                frame: None,
                fps: None,
                speed: None,
                total_size: None,
                done: true,
            }]
        );
    }

    #[test]
    fn parses_a_speed_with_its_trailing_x_and_reads_the_absent_forms_as_none() {
        assert_eq!(parse_speed("55.6x"), Some(rational(278, 5)));
        assert_eq!(parse_speed("1.0x"), Some(rational(1, 1)));
        assert_eq!(parse_speed("N/A"), None);

        // `%4.3g` switches to exponent notation once the exponent reaches 3, so a very fast
        // encode writes this. Reading it as absent is the documented trade: ADR 002 rules
        // out a floating-point parse, and ADR 014 drives progress from `frame`, not `speed`.
        assert_eq!(parse_speed("1.23e+03x"), None);
    }

    #[test]
    fn parses_a_crlf_stream_identically_once_the_carriage_return_reaches_the_parser() {
        // This pins behaviour, not implementation. `split_field`'s `strip_suffix('\r')` is
        // redundant with its trims, as that function's documentation says, so this test
        // passes with or without it. What it does prove is that a Windows pipe carrying
        // `progress=end\r` still finishes the export.
        let crlf = CAPTURED_END_BLOCK.replace('\n', "\r\n");
        assert_eq!(
            snapshots_with_line_endings_intact(&crlf),
            snapshots(CAPTURED_END_BLOCK)
        );

        // Directly, so that the `\r` is unmistakably present in the argument rather than
        // dependent on how the test helper splits.
        let mut reader = ProgressReader::new();
        assert_eq!(reader.push_line("frame=25\r"), None);
        let snapshot = reader.push_line("progress=end\r").unwrap();
        assert_eq!(snapshot.frame, Some(25));
        assert!(snapshot.done);
    }

    #[test]
    fn completes_a_block_whose_progress_value_is_unrecognized() {
        // The key ends the block; the value only decides `done`. An ffmpeg that invents a
        // third value must not strand this block and every block after it.
        let snapshots = snapshots("frame=5\nprogress=paused\nframe=6\nprogress=end\n");
        assert_eq!(snapshots.len(), 2);
        assert!(!snapshots[0].done);
        assert!(snapshots[1].done);
    }
}
