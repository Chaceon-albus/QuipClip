//! The inputs of the processes of an export (ADR 055).
//!
//! Each `-i` of an export command opens one source, seeked once, and the chains of one or more
//! pieces read it. [`assign_inputs`] chooses those inputs from the pieces alone. It is a pure
//! function: it reads no file, measures no command, and its answer depends only on the sources, the
//! In and Out points of the pieces, and the video time base of each source. The tests of
//! `arguments.rs` prove that every answer fits the Windows command-line budget, so production never
//! measures a command to choose its inputs.
//!
//! The first rule that applies gives the inputs:
//!
//! 1. An export of at most [`MAX_EXPORT_INPUTS`] pieces gives each piece its own input, in piece
//!    order: input `i` reads piece `i`. This is the shape of ADR 014 that every export used before
//!    ADR 055 on macOS, and it decodes no frame that no piece uses.
//! 2. Otherwise the pieces of each source are divided into the fewest *runs* ([`source_runs`]). A
//!    run is a sequence of pieces of one source, in export order, in which each piece starts at or
//!    after the Out point of the piece before it, in the time of that source. A run reads one
//!    input, seeked for its first piece, and `split`/`asplit` give each piece its frames. No piece
//!    of a run waits for a frame that a later piece of the same input takes first, so `concat`
//!    holds no frames (ADR 055 measurements 3 to 5, and the bullet of ADR 014 on `split` under
//!    one input). While there are fewer inputs than [`MAX_EXPORT_INPUTS`], a run is divided at its
//!    largest gap of
//!    at least [`RUN_GAP_SECONDS`] seconds ([`cut_runs`]).
//! 3. Pieces that need more runs than [`MAX_EXPORT_INPUTS`] are refused with
//!    [`ExportErrorCode::PiecesOutOfOrder`]. `commands::export` and [`super::plan::build_plan`]
//!    refuse such a request before anything else reads it ([`check_runs`]).
//!
//! One assignment serves every process of an export. The encoder reads every input. The audio
//! process of ADR 043, and the one process of an export without video, read the inputs whose pieces
//! read an audio stream ([`super::ExportPlan::piece_reads_audio`]), which is decided for each
//! source, so an input is read whole or not at all. Both processes therefore open their shared
//! inputs with the same seeks and the same FLV slices.
//!
//! `commands::export` computes the assignment once, after the re-probe of each source gives its
//! time base and before the FLV input of each source, whose slice check decodes only the slices
//! that start an input. It passes that one value to the graph builder and to the argument builder
//! of each process.

use super::plan::SegmentBoundary;
use super::ExportErrorCode;
use crate::time::{pts_seconds, Pts, Rational};
use std::cmp::Reverse;

/// The most inputs that one export process opens.
///
/// This is the largest count of inputs at which the widest command still fits the Windows
/// command-line budget (`arguments::WINDOWS_COMMAND_LINE_BUDGET`): every input an FLV input of
/// ADR 046 with the widest numbers that the
/// code can write, every path of 259 characters, and every setting at its widest. The tests
/// `max_export_inputs_fit_the_windows_budget_at_the_widest_settings` and
/// `one_more_input_does_not_fit_the_windows_budget` in `arguments.rs` measure it and hold it
/// maximal: a change that makes a command longer or shorter fails one of the two. The audio process
/// of ADR 043 opens a subset of the inputs of the encoder with shorter fixed arguments, so the
/// encoder sets the limit, and the first test also holds the audio process within it.
///
/// The pipe of the encoder is not counted: it is not an input of a source, and the measure
/// includes it.
///
/// It is also the limit of sources of an export, because each source needs one input.
/// `MAX_EXPORT_INPUTS` in `src/features/export/sequenceRequest.ts` mirrors this value, and
/// `src/features/export/types.test.ts` reads it from this file.
pub const MAX_EXPORT_INPUTS: usize = 85;

/// The shortest gap inside a run, in seconds, at which [`cut_runs`] divides the run (ADR 055).
///
/// A gap is a part of the source that the input decodes and no piece uses. Decoding 30 s of a
/// 30 fps source takes 900 frames, and one more input costs about 15 to 35 MiB (ADR 055
/// measurement 2). The value is a judgement, not a measured threshold.
pub const RUN_GAP_SECONDS: i64 = 30;

/// One input of an export: the source it opens, and the pieces whose chains read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportInput {
    /// The index of the source of the input in the plan, and of each of its pieces.
    pub source: usize,
    /// The pieces that read this input, in export order. In an assignment of [`assign_inputs`]
    /// they are also in source order and do not overlap: each starts at or after the Out point of
    /// the one before it. The first piece is therefore the earliest one, and the input is seeked
    /// for it.
    pub pieces: Vec<usize>,
}

/// The inputs of an export, and the input that each piece reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputAssignment {
    /// The inputs, in the order of their first piece in export order.
    inputs: Vec<ExportInput>,
    /// For each piece, the number of the input in [`Self::inputs`] that it reads.
    piece_input: Vec<usize>,
}

impl InputAssignment {
    /// The assignment of rule 1: one input for each piece, in piece order. `sources` holds the
    /// source of each piece.
    #[must_use]
    pub fn one_per_piece(sources: &[usize]) -> Self {
        Self::from_inputs(
            sources
                .iter()
                .enumerate()
                .map(|(piece, source)| ExportInput {
                    source: *source,
                    pieces: vec![piece],
                })
                .collect(),
        )
    }

    /// One input for each source, which every piece of the source reads, in export order: the
    /// single-input shape of ADR 014. `sources` holds the source of each piece.
    ///
    /// The tests of the graph and of the command pin the text of an input of several pieces with
    /// it, as ADR 014 pinned that shape. [`assign_inputs`] gives it only to pieces of each source in
    /// source order, but the builders render it for any pieces.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn one_per_source(sources: &[usize]) -> Self {
        let mut inputs: Vec<ExportInput> = Vec::new();
        for (piece, source) in sources.iter().enumerate() {
            match inputs.iter_mut().find(|input| input.source == *source) {
                Some(input) => input.pieces.push(piece),
                None => inputs.push(ExportInput {
                    source: *source,
                    pieces: vec![piece],
                }),
            }
        }
        Self::from_inputs(inputs)
    }

    /// The assignment of the inputs `inputs`, ordered by their first piece.
    ///
    /// # Panics
    ///
    /// When the inputs do not hold each piece from 0 to the count of pieces exactly once, or an
    /// input holds no piece. [`assign_inputs`] never makes such inputs, and the tests that build an
    /// assignment by hand must not either.
    #[must_use]
    pub fn from_inputs(mut inputs: Vec<ExportInput>) -> Self {
        assert!(
            inputs.iter().all(|input| !input.pieces.is_empty()),
            "every input has a piece"
        );
        inputs.sort_by_key(|input| input.pieces[0]);
        let count: usize = inputs.iter().map(|input| input.pieces.len()).sum();
        let mut piece_input = vec![usize::MAX; count];
        for (number, input) in inputs.iter().enumerate() {
            for piece in &input.pieces {
                assert!(
                    piece_input.get(*piece) == Some(&usize::MAX),
                    "each piece reads exactly one input"
                );
                piece_input[*piece] = number;
            }
        }
        Self {
            inputs,
            piece_input,
        }
    }

    /// The inputs, in the order of their first piece. A command opens them in this order, so the
    /// number of an input in its process is its position here, less the inputs before it that the
    /// process does not read.
    #[must_use]
    pub fn inputs(&self) -> &[ExportInput] {
        &self.inputs
    }

    /// The number of the input that the piece `piece` reads.
    ///
    /// # Panics
    ///
    /// When `piece` is not a piece of the assignment.
    #[must_use]
    pub fn input_of(&self, piece: usize) -> usize {
        self.piece_input[piece]
    }

    /// The count of pieces of the assignment.
    #[must_use]
    pub fn piece_count(&self) -> usize {
        self.piece_input.len()
    }
}

/// The inputs of the export of `pieces`, by the rules of this module.
///
/// `time_bases` holds the video time base of each source, by its index. The rules read it only
/// to compare the gaps of [`cut_runs`] in seconds.
///
/// # Errors
///
/// [`ExportErrorCode::PiecesOutOfOrder`] when the pieces need more than [`MAX_EXPORT_INPUTS`]
/// runs ([`check_runs`]).
pub fn assign_inputs(
    pieces: &[SegmentBoundary],
    time_bases: &[Rational],
) -> Result<InputAssignment, ExportErrorCode> {
    if pieces.len() <= MAX_EXPORT_INPUTS {
        let sources: Vec<usize> = pieces.iter().map(|piece| piece.source).collect();
        return Ok(InputAssignment::one_per_piece(&sources));
    }
    let runs = source_runs(pieces);
    if runs.len() > MAX_EXPORT_INPUTS {
        return Err(ExportErrorCode::PiecesOutOfOrder);
    }
    let runs = cut_runs(pieces, time_bases, runs, MAX_EXPORT_INPUTS);
    Ok(InputAssignment::from_inputs(runs))
}

/// Refuse `pieces` with [`ExportErrorCode::PiecesOutOfOrder`] when they need more than
/// [`MAX_EXPORT_INPUTS`] runs ([`source_runs`]).
///
/// The count reads only the source and the In and Out points of each piece, so it needs valid
/// source indices and pieces whose In point is before the Out point, and no time base. Pieces of
/// at most [`MAX_EXPORT_INPUTS`] never need more runs than that.
///
/// # Errors
///
/// [`ExportErrorCode::PiecesOutOfOrder`], as above.
pub fn check_runs(pieces: &[SegmentBoundary]) -> Result<(), ExportErrorCode> {
    if pieces.len() > MAX_EXPORT_INPUTS && source_runs(pieces).len() > MAX_EXPORT_INPUTS {
        return Err(ExportErrorCode::PiecesOutOfOrder);
    }
    Ok(())
}

/// Divide `pieces` into the fewest runs, in the order of their first piece.
///
/// The pieces are taken in export order. Each piece joins the run of its own source whose last
/// piece has the latest Out point at or before the In point of the piece. When two such runs end
/// at the same Out point, the piece joins the one that opened first. When no run of its source
/// ends at or before its In point, the piece opens a new run. A piece whose In point equals the
/// Out point of the piece before it joins that run: the Out point is exclusive (ADR 002), so the
/// two pieces share no frame.
///
/// The rule gives the fewest runs. Among the runs that the piece can join, the one that ends latest
/// leaves the runs that end earlier free for later pieces, and any piece that a later run could
/// take after the latest one, it could also take after an earlier one. The test
/// `the_runs_are_as_few_as_a_search_of_every_division_finds` checks this against a search of every
/// division of small cases.
///
/// Only the PTS of one source are compared, never the PTS of two (ADR 002).
#[must_use]
pub fn source_runs(pieces: &[SegmentBoundary]) -> Vec<ExportInput> {
    // The runs in the order they opened, with the Out point of the last piece of each.
    let mut runs: Vec<(ExportInput, Pts)> = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        let best = runs
            .iter()
            .enumerate()
            .filter(|(_, (run, last_out))| run.source == piece.source && *last_out <= piece.in_pts)
            // The latest Out point, and of equal ones the run that opened first.
            .max_by_key(|(number, (_, last_out))| (*last_out, Reverse(*number)))
            .map(|(number, _)| number);
        match best {
            Some(number) => {
                let (run, last_out) = &mut runs[number];
                run.pieces.push(index);
                *last_out = piece.out_pts;
            }
            None => runs.push((
                ExportInput {
                    source: piece.source,
                    pieces: vec![index],
                },
                piece.out_pts,
            )),
        }
    }
    // Runs open in the order of their first piece, so this order needs no sort.
    runs.into_iter().map(|(run, _)| run).collect()
}

/// Divide `runs` at their largest gaps, until there are `limit` runs or no gap of at least
/// [`RUN_GAP_SECONDS`] seconds is left, and return them in the order of their first piece.
///
/// A gap is the time from the Out point of a piece of a run to the In point of the next piece of
/// that run, in seconds of its source: the difference of the two PTS times the video time base of
/// the source in `time_bases`. The gaps of all sources are compared as exact durations, never as
/// raw PTS (ADR 002). The largest gaps are cut first. Gaps of equal length are cut in the order of
/// their run, and in the order of their place in the run. A gap whose duration cannot be computed,
/// such as one of a source without a positive time base, is not cut.
///
/// A cut divides one run into two and changes no other gap, so cutting the largest gaps one at a
/// time cuts the same gaps as cutting the `limit - runs` largest at once, which is what this does.
#[must_use]
pub fn cut_runs(
    pieces: &[SegmentBoundary],
    time_bases: &[Rational],
    runs: Vec<ExportInput>,
    limit: usize,
) -> Vec<ExportInput> {
    let minimum = Rational::new(RUN_GAP_SECONDS, 1).expect("a whole number of seconds");
    // (duration, run, position of the piece after the gap)
    let mut gaps: Vec<(Rational, usize, usize)> = Vec::new();
    for (number, run) in runs.iter().enumerate() {
        let Some(time_base) = time_bases.get(run.source).copied() else {
            continue;
        };
        for position in 1..run.pieces.len() {
            let previous = &pieces[run.pieces[position - 1]];
            let next = &pieces[run.pieces[position]];
            let Some(duration) = next
                .in_pts
                .value()
                .checked_sub(previous.out_pts.value())
                .and_then(|ticks| pts_seconds(Pts::new(ticks), time_base))
            else {
                continue;
            };
            if duration >= minimum {
                gaps.push((duration, number, position));
            }
        }
    }
    gaps.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    gaps.truncate(limit.saturating_sub(runs.len()));

    let mut divided = Vec::with_capacity(runs.len() + gaps.len());
    for (number, run) in runs.into_iter().enumerate() {
        let mut cuts: Vec<usize> = gaps
            .iter()
            .filter(|(_, gap_run, _)| *gap_run == number)
            .map(|(_, _, position)| *position)
            .collect();
        cuts.sort_unstable();
        let mut start = 0;
        for cut in cuts.into_iter().chain([run.pieces.len()]) {
            divided.push(ExportInput {
                source: run.source,
                pieces: run.pieces[start..cut].to_vec(),
            });
            start = cut;
        }
    }
    divided.sort_by_key(|input| input.pieces[0]);
    divided
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A piece of `source` from `in_pts` to `out_pts`.
    fn piece(source: usize, in_pts: i64, out_pts: i64) -> SegmentBoundary {
        SegmentBoundary {
            source,
            in_pts: Pts::new(in_pts),
            out_pts: Pts::new(out_pts),
        }
    }

    /// The pieces of each input.
    fn pieces_of(inputs: &[ExportInput]) -> Vec<Vec<usize>> {
        inputs.iter().map(|input| input.pieces.clone()).collect()
    }

    /// A time base of one millisecond.
    fn ms() -> Rational {
        Rational::new(1, 1000).unwrap()
    }

    /// `count` pieces of one source in source order, each 1 s long, with 1 s between them.
    fn in_order(count: usize) -> Vec<SegmentBoundary> {
        (0..count)
            .map(|index| {
                let start = i64::try_from(index).unwrap() * 2_000;
                piece(0, start, start + 1_000)
            })
            .collect()
    }

    /// Every input of `assignment` holds pieces of its own source, in source order, that do not
    /// overlap, and each piece reads exactly one input.
    fn assert_valid(pieces: &[SegmentBoundary], assignment: &InputAssignment) {
        assert_eq!(assignment.piece_count(), pieces.len());
        for (number, input) in assignment.inputs().iter().enumerate() {
            for pair in input.pieces.windows(2) {
                assert!(pair[0] < pair[1], "export order");
                assert!(
                    pieces[pair[0]].out_pts <= pieces[pair[1]].in_pts,
                    "no piece of an input waits"
                );
            }
            for piece in &input.pieces {
                assert_eq!(pieces[*piece].source, input.source);
                assert_eq!(assignment.input_of(*piece), number);
            }
        }
        let firsts: Vec<usize> = assignment
            .inputs()
            .iter()
            .map(|input| input.pieces[0])
            .collect();
        assert!(firsts.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(assignment.inputs().len() <= MAX_EXPORT_INPUTS);
    }

    #[test]
    fn at_most_the_limit_of_pieces_gives_each_piece_its_own_input() {
        // Rule 1, also for pieces far out of order and of several sources.
        let mut pieces: Vec<SegmentBoundary> = in_order(MAX_EXPORT_INPUTS);
        pieces.reverse();
        pieces[3].source = 1;
        let assignment = assign_inputs(&pieces, &[ms(), ms()]).unwrap();
        assert_eq!(assignment.inputs().len(), MAX_EXPORT_INPUTS);
        for (number, input) in assignment.inputs().iter().enumerate() {
            assert_eq!(input.pieces, vec![number]);
            assert_eq!(input.source, pieces[number].source);
        }
        assert_eq!(
            assignment,
            InputAssignment::one_per_piece(
                &pieces.iter().map(|piece| piece.source).collect::<Vec<_>>()
            )
        );
    }

    #[test]
    fn pieces_of_one_source_in_order_read_one_input_past_the_limit() {
        let pieces = in_order(MAX_EXPORT_INPUTS + 1);
        let assignment = assign_inputs(&pieces, &[ms()]).unwrap();
        assert_eq!(
            pieces_of(assignment.inputs()),
            vec![(0..=MAX_EXPORT_INPUTS).collect::<Vec<_>>()]
        );
        assert_valid(&pieces, &assignment);
    }

    #[test]
    fn two_sources_in_turn_each_in_order_read_two_inputs() {
        let pieces: Vec<SegmentBoundary> = (0..MAX_EXPORT_INPUTS + 7)
            .map(|index| {
                let start = i64::try_from(index / 2).unwrap() * 2_000;
                piece(index % 2, start, start + 1_000)
            })
            .collect();
        let assignment = assign_inputs(&pieces, &[ms(), ms()]).unwrap();
        assert_eq!(assignment.inputs().len(), 2);
        assert_eq!(assignment.inputs()[0].source, 0);
        assert_eq!(assignment.inputs()[1].source, 1);
        assert_valid(&pieces, &assignment);
    }

    #[test]
    fn one_piece_past_the_limit_that_repeats_one_range_is_refused() {
        // A stutter edit: the same range again and again. Before ADR 055, up to 91 such pieces
        // exported with one input each. Each repeat now needs a run of its own, so one more than
        // the limit is refused, and the limit itself still exports with one input each.
        let repeated = |count: usize| vec![piece(0, 1_000, 2_000); count];
        assert_eq!(check_runs(&repeated(MAX_EXPORT_INPUTS)), Ok(()));
        assert_eq!(
            check_runs(&repeated(MAX_EXPORT_INPUTS + 1)),
            Err(ExportErrorCode::PiecesOutOfOrder)
        );
    }

    #[test]
    fn reversed_pieces_give_one_run_for_each_piece() {
        let mut pieces = in_order(10);
        pieces.reverse();
        assert_eq!(
            pieces_of(&source_runs(&pieces)),
            (0..10).map(|piece| vec![piece]).collect::<Vec<_>>()
        );
    }

    #[test]
    fn overlapping_pieces_never_share_a_run_and_abutting_pieces_do() {
        // Piece 1 overlaps piece 0 by one tick, piece 2 starts at the Out point of piece 0.
        let pieces = [
            piece(0, 0, 1_000),
            piece(0, 999, 2_000),
            piece(0, 1_000, 3_000),
        ];
        assert_eq!(pieces_of(&source_runs(&pieces)), vec![vec![0, 2], vec![1]]);
        // The same piece twice never shares a run.
        let pieces = [piece(0, 0, 1_000), piece(0, 0, 1_000)];
        assert_eq!(pieces_of(&source_runs(&pieces)), vec![vec![0], vec![1]]);
    }

    #[test]
    fn a_piece_joins_the_run_that_ends_latest_before_it() {
        // Runs end at 3000 (piece 0) and at 1000 (piece 1). Piece 2 at 5000 joins the run of piece
        // 0, which leaves the earlier end for piece 3 at 2000. Had piece 2 joined the run of piece
        // 1, piece 3 would need a third run.
        let pieces = [
            piece(0, 2_500, 3_000),
            piece(0, 500, 1_000),
            piece(0, 5_000, 6_000),
            piece(0, 2_000, 2_400),
        ];
        assert_eq!(
            pieces_of(&source_runs(&pieces)),
            vec![vec![0, 2], vec![1, 3]]
        );
    }

    #[test]
    fn of_two_runs_that_end_together_a_piece_joins_the_one_that_opened_first() {
        let pieces = [
            piece(0, 0, 1_000),
            piece(0, 0, 1_000),
            piece(0, 2_000, 3_000),
        ];
        assert_eq!(pieces_of(&source_runs(&pieces)), vec![vec![0, 2], vec![1]]);
    }

    #[test]
    fn the_runs_of_two_sources_never_mix() {
        let pieces = [
            piece(0, 0, 1_000),
            piece(1, 5_000, 6_000),
            piece(0, 7_000, 8_000),
        ];
        let runs = source_runs(&pieces);
        assert_eq!(pieces_of(&runs), vec![vec![0, 2], vec![1]]);
        assert_eq!(runs[1].source, 1);
    }

    /// The fewest runs of `pieces`, by a search of every division: each piece in turn joins any
    /// run that it may follow, or opens a new one.
    fn fewest_runs_by_search(pieces: &[SegmentBoundary]) -> usize {
        fn search(pieces: &[SegmentBoundary], ends: &mut Vec<(usize, Pts)>, best: &mut usize) {
            if ends.len() >= *best {
                return;
            }
            let Some((piece, rest)) = pieces.split_first() else {
                *best = ends.len();
                return;
            };
            for index in 0..ends.len() {
                let (source, end) = ends[index];
                if source == piece.source && end <= piece.in_pts {
                    ends[index].1 = piece.out_pts;
                    search(rest, ends, best);
                    ends[index].1 = end;
                }
            }
            ends.push((piece.source, piece.out_pts));
            search(rest, ends, best);
            ends.pop();
        }
        let mut best = usize::MAX;
        search(pieces, &mut Vec::new(), &mut best);
        best
    }

    #[test]
    fn the_runs_are_as_few_as_a_search_of_every_division_finds() {
        // Every request of up to seven pieces of two sources, with In points from a small grid and
        // lengths of one or two steps, so that pieces overlap, abut, and repeat. A fixed linear
        // congruential sequence chooses the cases; the search is exact.
        let mut state: u64 = 0x5eed;
        let mut next = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) % bound
        };
        for _ in 0..4_000 {
            let count = 1 + usize::try_from(next(7)).unwrap();
            let pieces: Vec<SegmentBoundary> = (0..count)
                .map(|_| {
                    let source = usize::try_from(next(2)).unwrap();
                    let start = i64::try_from(next(6)).unwrap();
                    let length = 1 + i64::try_from(next(2)).unwrap();
                    piece(source, start, start + length)
                })
                .collect();
            let runs = source_runs(&pieces);
            assert_eq!(runs.len(), fewest_runs_by_search(&pieces), "{pieces:?}");
            for run in &runs {
                for pair in run.pieces.windows(2) {
                    assert!(pieces[pair[0]].out_pts <= pieces[pair[1]].in_pts);
                    assert_eq!(pieces[pair[0]].source, pieces[pair[1]].source);
                }
            }
        }
    }

    #[test]
    fn more_runs_than_the_limit_are_refused() {
        let mut pieces = in_order(MAX_EXPORT_INPUTS + 1);
        pieces.reverse();
        assert_eq!(
            assign_inputs(&pieces, &[ms()]),
            Err(ExportErrorCode::PiecesOutOfOrder)
        );
        assert_eq!(check_runs(&pieces), Err(ExportErrorCode::PiecesOutOfOrder));
        // One piece back in order makes the runs fit.
        pieces.swap(0, 1);
        assert_eq!(source_runs(&pieces).len(), MAX_EXPORT_INPUTS);
        assert!(check_runs(&pieces).is_ok());
        let assignment = assign_inputs(&pieces, &[ms()]).unwrap();
        assert_eq!(assignment.inputs().len(), MAX_EXPORT_INPUTS);
        assert_valid(&pieces, &assignment);
    }

    #[test]
    fn the_limit_of_pieces_is_never_refused_however_far_out_of_order() {
        let mut pieces = in_order(MAX_EXPORT_INPUTS);
        pieces.reverse();
        assert!(check_runs(&pieces).is_ok());
        assert!(assign_inputs(&pieces, &[ms()]).is_ok());
    }

    /// `count` pieces of one source in order, 1 s each, after the gaps `gaps` in seconds: piece
    /// `i + 1` starts `gaps[i]` seconds after the Out point of piece `i`, and the other pieces
    /// follow at once.
    fn with_gaps(source: usize, count: usize, gaps: &[(usize, i64)]) -> Vec<SegmentBoundary> {
        let mut start = 0;
        (0..count)
            .map(|index| {
                if let Some((_, gap)) = gaps.iter().find(|(after, _)| *after + 1 == index) {
                    start += gap * 1_000;
                }
                let piece = piece(source, start, start + 1_000);
                start += 1_000;
                piece
            })
            .collect()
    }

    #[test]
    fn a_run_is_cut_at_its_largest_gaps_of_at_least_30_seconds() {
        // A gap of 29 s is not cut, the gaps of 30 s and 40 s are, the largest first.
        let pieces = with_gaps(0, 10, &[(1, 29), (4, 40), (7, 30)]);
        let runs = source_runs(&pieces);
        assert_eq!(runs.len(), 1);
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &[ms()], runs.clone(), 10)),
            vec![vec![0, 1, 2, 3, 4], vec![5, 6, 7], vec![8, 9]]
        );
        // With room for one more input, only the gap of 40 s is cut.
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &[ms()], runs.clone(), 2)),
            vec![vec![0, 1, 2, 3, 4], vec![5, 6, 7, 8, 9]]
        );
        // With no room, nothing is cut.
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &[ms()], runs, 1)),
            vec![(0..10).collect::<Vec<_>>()]
        );
    }

    #[test]
    fn the_gaps_of_two_sources_are_compared_in_seconds_not_in_ticks() {
        // Source 0 counts milliseconds, and its gap of 40 s is 40000 ticks. Source 1 counts
        // 1/90000 s, and its gap of 35 s is 3150000 ticks. The gap of source 0 is cut first,
        // although its count of ticks is smaller.
        let first = with_gaps(0, 2, &[(0, 40)]);
        let second: Vec<SegmentBoundary> = [(0, 90_000), (90_000 * 36, 90_000 * 37)]
            .iter()
            .map(|(start, end)| piece(1, *start, *end))
            .collect();
        let pieces = [first[0], second[0], first[1], second[1]];
        let time_bases = [ms(), Rational::new(1, 90_000).unwrap()];
        let runs = source_runs(&pieces);
        assert_eq!(pieces_of(&runs), vec![vec![0, 2], vec![1, 3]]);
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &time_bases, runs.clone(), 3)),
            vec![vec![0], vec![1, 3], vec![2]]
        );
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &time_bases, runs, 4)),
            vec![vec![0], vec![1], vec![2], vec![3]]
        );
    }

    #[test]
    fn gaps_of_equal_length_are_cut_in_the_order_of_their_run_and_place() {
        let pieces = with_gaps(0, 4, &[(0, 30), (1, 30), (2, 30)]);
        let runs = source_runs(&pieces);
        assert_eq!(
            pieces_of(&cut_runs(&pieces, &[ms()], runs, 3)),
            vec![vec![0], vec![1], vec![2, 3]]
        );
    }

    #[test]
    fn the_assignment_cuts_the_gaps_up_to_the_limit_and_stops_there() {
        // More pieces than the limit, every one after a gap of 31 s: one run, cut into exactly the
        // limit of inputs, the earliest gaps first because all are equal.
        let count = MAX_EXPORT_INPUTS + 5;
        let gaps: Vec<(usize, i64)> = (0..count - 1).map(|after| (after, 31)).collect();
        let pieces = with_gaps(0, count, &gaps);
        let assignment = assign_inputs(&pieces, &[ms()]).unwrap();
        assert_eq!(assignment.inputs().len(), MAX_EXPORT_INPUTS);
        assert_valid(&pieces, &assignment);
        let last = assignment.inputs().last().unwrap();
        assert_eq!(
            last.pieces,
            (MAX_EXPORT_INPUTS - 1..count).collect::<Vec<_>>()
        );
        // With no gap of 30 s, the run stays one input.
        let pieces = in_order(count);
        assert_eq!(assign_inputs(&pieces, &[ms()]).unwrap().inputs().len(), 1);
    }

    #[test]
    fn a_gap_of_a_source_without_a_usable_time_base_is_not_cut() {
        let pieces = with_gaps(0, 3, &[(0, 100)]);
        let runs = source_runs(&pieces);
        let zero = Rational::new(0, 1).unwrap();
        assert_eq!(cut_runs(&pieces, &[zero], runs.clone(), 5), runs);
        assert_eq!(cut_runs(&pieces, &[], runs.clone(), 5), runs);
    }

    #[test]
    fn no_assignment_has_more_inputs_than_the_limit() {
        // Requests of up to 256 pieces of up to four sources, from in order to far out of order,
        // with gaps of up to a few minutes: each assignment is valid and holds at most the limit of
        // inputs, and a request is refused exactly when its runs exceed the limit.
        let mut state: u64 = 0x1234_5678;
        let mut next = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) % bound
        };
        let time_bases = [ms(), Rational::new(1, 90_000).unwrap(), ms(), ms()];
        for _ in 0..300 {
            let count = 1 + usize::try_from(next(256)).unwrap();
            let sources = 1 + next(4);
            let disorder = next(4);
            let mut ends = [0_i64; 4];
            let pieces: Vec<SegmentBoundary> = (0..count)
                .map(|_| {
                    let source = usize::try_from(next(sources)).unwrap();
                    let scale = if source == 1 { 90 } else { 1 };
                    let start = if next(4) < disorder {
                        i64::try_from(next(1_000_000)).unwrap() * scale
                    } else {
                        ends[source] + i64::try_from(next(200_000)).unwrap() * scale
                    };
                    let end = start + (1 + i64::try_from(next(5_000)).unwrap()) * scale;
                    ends[source] = end;
                    piece(source, start, end)
                })
                .collect();
            match assign_inputs(&pieces, &time_bases) {
                Ok(assignment) => assert_valid(&pieces, &assignment),
                Err(code) => {
                    assert_eq!(code, ExportErrorCode::PiecesOutOfOrder);
                    assert!(source_runs(&pieces).len() > MAX_EXPORT_INPUTS);
                }
            }
            assert_eq!(
                check_runs(&pieces).is_err(),
                assign_inputs(&pieces, &time_bases).is_err()
            );
        }
    }

    #[test]
    #[should_panic(expected = "each piece reads exactly one input")]
    fn an_assignment_that_reads_a_piece_twice_is_refused() {
        let _ = InputAssignment::from_inputs(vec![
            ExportInput {
                source: 0,
                pieces: vec![0, 1],
            },
            ExportInput {
                source: 0,
                pieces: vec![1],
            },
        ]);
    }

    /// The cases of `src/features/export/inputRunCases.json`, which the vitest of
    /// `countInputRuns` in `src/features/export/sequenceRequest.test.ts` runs too: the two counts of
    /// runs must agree, because the OPEN step refuses with that count before the backend does
    /// (ADR 055).
    #[test]
    fn the_runs_agree_with_the_shared_cases_of_the_frontend() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../src/features/export/inputRunCases.json"
        ))
        .expect("the shared cases are JSON");
        let cases = table["cases"].as_array().expect("the cases are a list");
        assert!(cases.len() >= 10, "the shared cases were read");
        for case in cases {
            let name = case["name"].as_str().expect("each case has a name");
            let mut sources: Vec<&str> = Vec::new();
            let pieces: Vec<SegmentBoundary> = case["pieces"]
                .as_array()
                .expect("each case has pieces")
                .iter()
                .map(|piece| {
                    let id = piece["sourceId"].as_str().expect("a source id");
                    let source = sources
                        .iter()
                        .position(|known| *known == id)
                        .unwrap_or_else(|| {
                            sources.push(id);
                            sources.len() - 1
                        });
                    let pts = |field: &str| {
                        Pts::new(
                            piece[field]
                                .as_str()
                                .and_then(|text| text.parse::<i64>().ok())
                                .expect("a PTS is an i64 in a string"),
                        )
                    };
                    SegmentBoundary {
                        source,
                        in_pts: pts("inPts"),
                        out_pts: pts("outPts"),
                    }
                })
                .collect();
            let runs = case["runs"]
                .as_u64()
                .expect("each case has a count of runs");
            assert_eq!(
                u64::try_from(source_runs(&pieces).len()).unwrap(),
                runs,
                "{name}"
            );
        }
    }
}
