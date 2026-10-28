//! The journal of the export runs, and the sequence number of each export event.
//!
//! A reload of the page, or a crash of the web view, loses the list of runs in the interface,
//! and the queue of the backend goes on (ADR 049). A new page must read the state of the runs
//! from the backend, and then apply the live events that come after that read. This module
//! keeps the state that such a read needs.
//!
//! Every export event goes through [`ExportJournal::emit`]. Under one lock, that method gives
//! the event the next sequence number, applies the event to the record of its run, and sends
//! the event. So the journal and the events can never disagree, and the sequence numbers come
//! in the order in which the events go out. A reader that gets the journal with its last
//! sequence number can drop each later event whose number is not larger.
//!
//! The registry slot alone cannot give this state. A run sends its last event before it
//! releases the slot (ADR 016), so between the two the slot names a run that already ended.

use super::export::{ExportCommandError, ExportEvent};
use super::export_output::PUBLISHED_EXPORT_LIMIT;
use crate::ffmpeg::export::{ExportErrorCode, ExportStreams};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

/// One export event as it goes on the wire: the event with its sequence number.
///
/// The event is flattened, so the payload is `{ "seq": 7, "event": "preparing", "runId": … }`.
/// A frontend that does not read `seq` sees the event as before.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SequencedEvent<'a> {
    pub seq: u64,
    #[serde(flatten)]
    pub event: &'a ExportEvent,
}

/// The phase of one run in the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunPhase {
    /// The run waits in the queue, or the registry starts it now.
    Waiting,
    /// The run sent `preparing`.
    Preparing,
    /// The run sent `started`. ffmpeg runs.
    Running,
    /// The run sent `publishing`.
    Publishing,
    /// The run sent `finished`.
    Finished,
    /// The run sent `failed` with a code that is not `canceled`.
    Failed,
    /// The run sent `failed` with `canceled` after it left the phase `waiting`.
    Canceled,
}

impl RunPhase {
    /// Whether the run ended. An ended run sends no more events.
    #[must_use]
    pub fn has_ended(self) -> bool {
        matches!(self, Self::Finished | Self::Failed | Self::Canceled)
    }
}

/// The facts of a run that the submission fixes. They do not change during the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFacts {
    pub output_path: String,
    pub preset_name: String,
    pub segment_count: u32,
    pub streams: ExportStreams,
}

/// The record of one run in the journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRun {
    pub run_id: String,
    pub facts: RunFacts,
    pub phase: RunPhase,
    /// The last frame that a `progress` event reported, or the frame count of `finished`.
    pub frame: Option<u64>,
    /// The frame goal from `started`, or from a later `progress` event that carries one.
    pub expected_frames: Option<u64>,
    /// The error of a run that failed or that was canceled.
    pub error: Option<ExportCommandError>,
    /// When the run sent `preparing`. A reader can show the time since then.
    pub prepared_at: Option<Instant>,
    /// The position of the run among the ended runs: 1 for the first run that ended, and so on.
    /// `None` while the run has not ended.
    pub end_order: Option<u64>,
    /// The sequence number of the last event that changed this run, or 0 when no event did.
    pub last_seq: u64,
}

/// A copy of the journal that one lock took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalSnapshot {
    /// The sequence number of the last event that went out before the copy, or 0 when no event
    /// went out. Each event after the copy has a larger number.
    pub seq: u64,
    /// The runs, in the order of their submission.
    pub runs: Vec<JournalRun>,
}

#[derive(Debug, Default)]
struct JournalState {
    /// The sequence number of the last event. The first event gets 1.
    seq: u64,
    /// The number of runs that ended. The next run that ends gets this number plus 1.
    ends: u64,
    /// The runs in the order of their submission.
    runs: Vec<JournalRun>,
}

/// The journal of the export runs of this process.
///
/// `lib.rs` stores one value as Tauri managed state. `start_export` records each run before it
/// submits the run, and every export event goes through [`Self::emit`].
///
/// # The lock
///
/// [`Self::emit`] calls `send` while it holds the lock, so the order of the sequence numbers is
/// the order of the sends. `send` is `AppHandle::emit`. That call serializes the event, takes the
/// internal locks of Tauri for the web views and their listeners, and runs any Rust listener of
/// the event on the calling thread. No Rust listener of the export event exists. To reach a web
/// view from a thread that is not the main thread, it then only puts a message in the queue of
/// the event loop (`tauri-runtime-wry` `send_user_message`, then `proxy.send_event`), and it does
/// not wait for the event loop. So the lock is held only for a short time, and it cannot wait for
/// the main thread.
///
/// That last point needs the `tracing` feature of `tauri-runtime-wry` to stay off. With it on,
/// a script runs through a call that waits until the main thread has run it, so an export thread
/// would wait for the main thread while it holds this lock, and the exit wait of ADR 017, which
/// runs on the main thread, could run out.
///
/// On the main thread, `AppHandle::emit` runs the delivery at once, and that delivery can run
/// Rust listeners. So never take this lock on the main thread, in a Tauri callback, or in a Rust
/// listener of an event. The export events come from the export threads, from the command
/// threads of `start_export` and `cancel_export`, and from the thread that releases the slot.
/// None of them is the main thread. A debug build checks this in [`Self::emit`].
///
/// # Memory
///
/// The journal keeps at most [`PUBLISHED_EXPORT_LIMIT`] ended runs. When a run ends and more
/// runs ended, the journal removes the run that ended first. It never removes a run that did
/// not end. The queue of the registry bounds those runs.
///
/// `ExportRegistry::close_for_exit` drops the waiting runs and sends no event for them, so the
/// journal keeps them as `waiting`. That is harmless, because the application exits and the
/// exit cannot be undone.
#[derive(Debug, Default)]
pub struct ExportJournal {
    state: Mutex<JournalState>,
}

impl ExportJournal {
    /// Record a run that `start_export` submits now, as `waiting`.
    ///
    /// Call this before `ExportRegistry::submit`. A run that starts at once sends its first event
    /// during the submit, and that event must find the record.
    pub fn record_submission(&self, run_id: &str, facts: RunFacts) {
        let mut state = self.lock();
        state.runs.push(JournalRun {
            run_id: run_id.to_owned(),
            facts,
            phase: RunPhase::Waiting,
            frame: None,
            expected_frames: None,
            error: None,
            prepared_at: None,
            end_order: None,
            last_seq: 0,
        });
    }

    /// Remove the record of a run that the registry refused, because the queue closed. Such a run
    /// sends no event.
    pub fn forget(&self, run_id: &str) {
        let removed = {
            let mut state = self.lock();
            remove_run(&mut state.runs, run_id)
        };
        drop(removed);
    }

    /// Give `event` the next sequence number, apply it to the record of its run, and call `send`
    /// with the number and the event, all under the lock.
    ///
    /// The numbers start at 1 and go up by 1 for each event. An event for a run that the journal
    /// does not know still gets a number and goes out.
    ///
    /// These rules apply the event:
    ///
    /// - `preparing` sets the phase and the time of preparation.
    /// - `started` sets `running` and the frame goal.
    /// - `progress` sets the frame, and the frame goal when the event carries one.
    /// - `publishing` sets the phase.
    /// - `finished` sets `finished` and the frame count.
    /// - `failed` with `canceled` for a run that is still `waiting` removes the run. A cancel
    ///   withdrew it from the queue, and the interface forgets such a run too.
    /// - Any other `failed` sets `canceled` or `failed`, with the error. A run whose export
    ///   thread the system refused is `failed`, though it never sent `preparing`.
    /// - An event for a run that ended changes nothing.
    pub fn emit<F>(&self, event: ExportEvent, send: F)
    where
        F: FnOnce(u64, &ExportEvent),
    {
        debug_assert_ne!(
            std::thread::current().name(),
            Some("main"),
            "the export journal must not send an event from the main thread"
        );
        let mut state = self.lock();
        state.seq += 1;
        let seq = state.seq;
        let removed = apply(&mut state, seq, &event);
        send(seq, &event);
        drop(state);
        drop(removed);
    }

    /// A copy of the runs and of the last sequence number, from one lock.
    #[must_use]
    pub fn snapshot(&self) -> JournalSnapshot {
        let state = self.lock();
        JournalSnapshot {
            seq: state.seq,
            runs: state.runs.clone(),
        }
    }

    /// Lock the state, and recover a poisoned lock instead of propagating it.
    ///
    /// Each change to the state completes or does nothing, so a panic cannot leave a run half
    /// written. `PublishedExports::lock` recovers its poison for the same reason. A panic in
    /// `send` leaves an event with a number that maybe did not go out. A reader then sees a gap
    /// in the numbers, which is harmless.
    fn lock(&self) -> MutexGuard<'_, JournalState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Apply `event`, which has the sequence number `seq`, to its run. Returns the runs that the
/// change removed, so that the caller frees them.
fn apply(state: &mut JournalState, seq: u64, event: &ExportEvent) -> Vec<JournalRun> {
    let run_id = match event {
        ExportEvent::Preparing { run_id }
        | ExportEvent::Started { run_id, .. }
        | ExportEvent::Progress { run_id, .. }
        | ExportEvent::Publishing { run_id }
        | ExportEvent::Finished { run_id, .. }
        | ExportEvent::Failed { run_id, .. } => run_id,
    };
    let Some(index) = state.runs.iter().position(|run| &run.run_id == run_id) else {
        return Vec::new();
    };
    if state.runs[index].phase.has_ended() {
        return Vec::new();
    }

    let ended = match event {
        ExportEvent::Failed {
            code: ExportErrorCode::Canceled,
            ..
        } if state.runs[index].phase == RunPhase::Waiting => {
            return vec![state.runs.remove(index)];
        }
        ExportEvent::Preparing { .. } => {
            let run = &mut state.runs[index];
            run.phase = RunPhase::Preparing;
            run.prepared_at = Some(Instant::now());
            false
        }
        ExportEvent::Started {
            expected_frames, ..
        } => {
            let run = &mut state.runs[index];
            run.phase = RunPhase::Running;
            run.expected_frames = *expected_frames;
            false
        }
        ExportEvent::Progress {
            frame,
            expected_frames,
            ..
        } => {
            let run = &mut state.runs[index];
            run.frame = Some(*frame);
            if expected_frames.is_some() {
                run.expected_frames = *expected_frames;
            }
            false
        }
        ExportEvent::Publishing { .. } => {
            state.runs[index].phase = RunPhase::Publishing;
            false
        }
        ExportEvent::Finished { frames, .. } => {
            let run = &mut state.runs[index];
            run.phase = RunPhase::Finished;
            run.frame = Some(*frames);
            true
        }
        ExportEvent::Failed {
            code,
            detail,
            exit_code,
            encoder,
            measured_duration_us,
            expected_duration_us,
            ..
        } => {
            let run = &mut state.runs[index];
            run.phase = if *code == ExportErrorCode::Canceled {
                RunPhase::Canceled
            } else {
                RunPhase::Failed
            };
            run.error = Some(ExportCommandError {
                code: *code,
                detail: detail.clone(),
                exit_code: *exit_code,
                encoder: encoder.clone(),
                measured_duration_us: *measured_duration_us,
                expected_duration_us: *expected_duration_us,
            });
            true
        }
    };
    state.runs[index].last_seq = seq;
    if !ended {
        return Vec::new();
    }
    state.ends += 1;
    state.runs[index].end_order = Some(state.ends);
    evict_ended_runs(&mut state.runs)
}

/// Remove the runs that ended first, until at most [`PUBLISHED_EXPORT_LIMIT`] ended runs stay.
fn evict_ended_runs(runs: &mut Vec<JournalRun>) -> Vec<JournalRun> {
    let mut removed = Vec::new();
    while runs.iter().filter(|run| run.end_order.is_some()).count() > PUBLISHED_EXPORT_LIMIT {
        let Some(oldest) = runs
            .iter()
            .enumerate()
            .filter_map(|(index, run)| run.end_order.map(|order| (order, index)))
            .min()
            .map(|(_, index)| index)
        else {
            break;
        };
        removed.push(runs.remove(oldest));
    }
    removed
}

fn remove_run(runs: &mut Vec<JournalRun>, run_id: &str) -> Option<JournalRun> {
    let index = runs.iter().position(|run| run.run_id == run_id)?;
    Some(runs.remove(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Rational;
    use std::sync::Arc;

    fn facts(output_path: &str) -> RunFacts {
        RunFacts {
            output_path: output_path.to_owned(),
            preset_name: "H.264".to_owned(),
            segment_count: 2,
            streams: ExportStreams::VideoAndAudio,
        }
    }

    fn preparing(run_id: &str) -> ExportEvent {
        ExportEvent::Preparing {
            run_id: run_id.to_owned(),
        }
    }

    fn failed(run_id: &str, code: ExportErrorCode) -> ExportEvent {
        ExportEvent::Failed {
            run_id: run_id.to_owned(),
            code,
            detail: None,
            exit_code: None,
            encoder: None,
            measured_duration_us: None,
            expected_duration_us: None,
        }
    }

    fn finished(run_id: &str) -> ExportEvent {
        ExportEvent::Finished {
            run_id: run_id.to_owned(),
            output_path: "/out.mp4".to_owned(),
            frames: 10,
        }
    }

    /// Send `event` through the journal, and return its sequence number.
    fn emit(journal: &ExportJournal, event: ExportEvent) -> u64 {
        let mut sent = None;
        journal.emit(event, |seq, _| sent = Some(seq));
        sent.expect("the journal calls send once")
    }

    fn run<'a>(snapshot: &'a JournalSnapshot, run_id: &str) -> Option<&'a JournalRun> {
        snapshot.runs.iter().find(|run| run.run_id == run_id)
    }

    fn phase(journal: &ExportJournal, run_id: &str) -> Option<RunPhase> {
        run(&journal.snapshot(), run_id).map(|run| run.phase)
    }

    #[test]
    fn the_sequence_numbers_go_up_in_the_order_of_the_sends_across_threads() {
        let journal = Arc::new(ExportJournal::default());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = (0..16)
            .map(|thread| {
                let journal = Arc::clone(&journal);
                let sent = Arc::clone(&sent);
                std::thread::spawn(move || {
                    for _ in 0..200 {
                        let sent = Arc::clone(&sent);
                        journal.emit(preparing(&format!("run-{thread}")), move |seq, _| {
                            sent.lock().unwrap().push(seq);
                        });
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let sent = sent.lock().unwrap();
        let expected: Vec<u64> = (1..=16 * 200).collect();
        assert_eq!(*sent, expected);
        assert_eq!(journal.snapshot().seq, 16 * 200);
    }

    #[test]
    fn each_event_moves_its_run_to_its_phase() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        journal.record_submission("run-2", facts("/b.mp4"));
        assert_eq!(phase(&journal, "run-1"), Some(RunPhase::Waiting));

        emit(&journal, preparing("run-1"));
        let snapshot = journal.snapshot();
        let first = run(&snapshot, "run-1").unwrap();
        assert_eq!(first.phase, RunPhase::Preparing);
        assert!(first.prepared_at.is_some());
        assert_eq!(first.last_seq, 1);
        assert_eq!(run(&snapshot, "run-2").unwrap().last_seq, 0);

        emit(
            &journal,
            ExportEvent::Started {
                run_id: "run-1".to_owned(),
                output_path: "/a.mp4".to_owned(),
                segment_count: 2,
                total_duration_us: 1_000_000,
                expected_frames: Some(30),
            },
        );
        let snapshot = journal.snapshot();
        let first = run(&snapshot, "run-1").unwrap();
        assert_eq!(first.phase, RunPhase::Running);
        assert_eq!(first.expected_frames, Some(30));

        emit(
            &journal,
            ExportEvent::Publishing {
                run_id: "run-1".to_owned(),
            },
        );
        assert_eq!(phase(&journal, "run-1"), Some(RunPhase::Publishing));

        let seq = emit(&journal, finished("run-1"));
        let snapshot = journal.snapshot();
        let first = run(&snapshot, "run-1").unwrap();
        assert_eq!(first.phase, RunPhase::Finished);
        assert_eq!(first.frame, Some(10));
        assert_eq!(first.end_order, Some(1));
        assert_eq!(first.last_seq, seq);
        assert_eq!(snapshot.seq, seq);

        emit(&journal, preparing("run-2"));
        emit(
            &journal,
            failed("run-2", ExportErrorCode::FfmpegProcessFailed),
        );
        let snapshot = journal.snapshot();
        let second = run(&snapshot, "run-2").unwrap();
        assert_eq!(second.phase, RunPhase::Failed);
        assert_eq!(
            second.error.as_ref().map(|error| error.code),
            Some(ExportErrorCode::FfmpegProcessFailed)
        );
        assert_eq!(second.end_order, Some(2));
        assert_eq!(
            snapshot
                .runs
                .iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            ["run-1", "run-2"]
        );
    }

    #[test]
    fn an_event_after_the_end_of_a_run_changes_nothing() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        emit(&journal, preparing("run-1"));
        emit(&journal, finished("run-1"));
        let before = run(&journal.snapshot(), "run-1").cloned();
        emit(&journal, failed("run-1", ExportErrorCode::Canceled));
        assert_eq!(run(&journal.snapshot(), "run-1").cloned(), before);
    }

    #[test]
    fn progress_sets_the_frame_and_keeps_the_goal_when_it_carries_none() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        let progress = |frame, expected_frames| ExportEvent::Progress {
            run_id: "run-1".to_owned(),
            frame,
            expected_frames,
            fps: Some(Rational::new(30, 1).unwrap()),
            speed: None,
            total_size: None,
        };
        emit(&journal, preparing("run-1"));
        emit(&journal, progress(5, Some(40)));
        let snapshot = journal.snapshot();
        assert_eq!(run(&snapshot, "run-1").unwrap().frame, Some(5));
        assert_eq!(run(&snapshot, "run-1").unwrap().expected_frames, Some(40));

        emit(&journal, progress(9, None));
        let snapshot = journal.snapshot();
        assert_eq!(run(&snapshot, "run-1").unwrap().frame, Some(9));
        assert_eq!(run(&snapshot, "run-1").unwrap().expected_frames, Some(40));
    }

    #[test]
    fn a_withdrawn_waiting_run_is_removed_and_a_canceled_preparation_is_kept() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        journal.record_submission("run-2", facts("/b.mp4"));
        emit(&journal, preparing("run-1"));

        emit(&journal, failed("run-2", ExportErrorCode::Canceled));
        assert_eq!(phase(&journal, "run-2"), None);

        emit(&journal, failed("run-1", ExportErrorCode::Canceled));
        let snapshot = journal.snapshot();
        let first = run(&snapshot, "run-1").unwrap();
        assert_eq!(first.phase, RunPhase::Canceled);
        assert_eq!(
            first.error.as_ref().map(|error| error.code),
            Some(ExportErrorCode::Canceled)
        );
        assert_eq!(first.end_order, Some(1));
    }

    #[test]
    fn a_run_whose_thread_was_refused_is_kept_as_failed() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        emit(
            &journal,
            ExportEvent::Failed {
                run_id: "run-1".to_owned(),
                code: ExportErrorCode::CommandExecutionFailed,
                detail: Some("no thread".to_owned()),
                exit_code: None,
                encoder: None,
                measured_duration_us: None,
                expected_duration_us: None,
            },
        );
        let snapshot = journal.snapshot();
        let first = run(&snapshot, "run-1").unwrap();
        assert_eq!(first.phase, RunPhase::Failed);
        assert_eq!(first.prepared_at, None);
        assert_eq!(
            first
                .error
                .as_ref()
                .and_then(|error| error.detail.as_deref()),
            Some("no thread")
        );
    }

    #[test]
    fn forget_removes_a_run_that_the_closed_queue_refused() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        journal.record_submission("run-2", facts("/b.mp4"));
        journal.forget("run-2");
        journal.forget("run-unknown");
        let snapshot = journal.snapshot();
        assert_eq!(snapshot.runs.len(), 1);
        assert_eq!(snapshot.runs[0].run_id, "run-1");
        assert_eq!(snapshot.seq, 0);
    }

    #[test]
    fn an_event_of_an_unknown_run_gets_a_number_and_changes_no_run() {
        let journal = ExportJournal::default();
        journal.record_submission("run-1", facts("/a.mp4"));
        assert_eq!(emit(&journal, preparing("run-x")), 1);
        let snapshot = journal.snapshot();
        assert_eq!(snapshot.seq, 1);
        assert_eq!(snapshot.runs[0].phase, RunPhase::Waiting);
    }

    #[test]
    fn the_cap_removes_the_run_that_ended_first_and_never_a_live_run() {
        let journal = ExportJournal::default();
        // A run that waits from the start, and a run that runs.
        journal.record_submission("waiting", facts("/w.mp4"));
        journal.record_submission("running", facts("/r.mp4"));
        emit(&journal, preparing("running"));

        let count = PUBLISHED_EXPORT_LIMIT + 3;
        for index in 0..count {
            journal.record_submission(&format!("run-{index}"), facts("/x.mp4"));
        }
        // End the runs out of their order of submission: the last one ends first.
        emit(&journal, preparing(&format!("run-{}", count - 1)));
        emit(&journal, finished(&format!("run-{}", count - 1)));
        for index in 0..count - 1 {
            emit(&journal, preparing(&format!("run-{index}")));
            emit(
                &journal,
                failed(
                    &format!("run-{index}"),
                    ExportErrorCode::FfmpegProcessFailed,
                ),
            );
        }

        let snapshot = journal.snapshot();
        let ended: Vec<&str> = snapshot
            .runs
            .iter()
            .filter(|run| run.phase.has_ended())
            .map(|run| run.run_id.as_str())
            .collect();
        assert_eq!(ended.len(), PUBLISHED_EXPORT_LIMIT);
        // The first three ends were the last run, run-0 and run-1.
        assert!(!ended.contains(&format!("run-{}", count - 1).as_str()));
        assert!(!ended.contains(&"run-0"));
        assert!(!ended.contains(&"run-1"));
        assert!(ended.contains(&"run-2"));
        assert_eq!(phase(&journal, "waiting"), Some(RunPhase::Waiting));
        assert_eq!(phase(&journal, "running"), Some(RunPhase::Preparing));
        assert_eq!(snapshot.runs[0].run_id, "waiting");
        assert_eq!(snapshot.runs[1].run_id, "running");
    }

    fn sequenced(event: &ExportEvent) -> serde_json::Value {
        serde_json::to_value(SequencedEvent { seq: 7, event }).unwrap()
    }

    #[test]
    fn each_event_goes_on_the_wire_flat_with_its_sequence_number() {
        assert_eq!(
            sequenced(&preparing("run-1")),
            serde_json::json!({ "seq": 7, "event": "preparing", "runId": "run-1" })
        );
        assert_eq!(
            sequenced(&ExportEvent::Started {
                run_id: "run-1".to_owned(),
                output_path: "/a.mp4".to_owned(),
                segment_count: 2,
                total_duration_us: 1_500_000,
                expected_frames: Some(45),
            }),
            serde_json::json!({
                "seq": 7,
                "event": "started",
                "runId": "run-1",
                "outputPath": "/a.mp4",
                "segmentCount": 2,
                "totalDurationUs": 1_500_000,
                "expectedFrames": 45,
            })
        );
        assert_eq!(
            sequenced(&ExportEvent::Started {
                run_id: "run-1".to_owned(),
                output_path: "/a.m4a".to_owned(),
                segment_count: 1,
                total_duration_us: 0,
                expected_frames: None,
            }),
            serde_json::json!({
                "seq": 7,
                "event": "started",
                "runId": "run-1",
                "outputPath": "/a.m4a",
                "segmentCount": 1,
                "totalDurationUs": 0,
            })
        );
        assert_eq!(
            sequenced(&ExportEvent::Progress {
                run_id: "run-1".to_owned(),
                frame: 12,
                expected_frames: Some(45),
                fps: Some(Rational::new(30000, 1001).unwrap()),
                speed: Some(Rational::new(3, 2).unwrap()),
                total_size: Some(4096),
            }),
            serde_json::json!({
                "seq": 7,
                "event": "progress",
                "runId": "run-1",
                "frame": 12,
                "expectedFrames": 45,
                "fps": { "n": 30000, "d": 1001 },
                "speed": { "n": 3, "d": 2 },
                "totalSize": 4096,
            })
        );
        assert_eq!(
            sequenced(&ExportEvent::Progress {
                run_id: "run-1".to_owned(),
                frame: 0,
                expected_frames: None,
                fps: None,
                speed: None,
                total_size: None,
            }),
            serde_json::json!({ "seq": 7, "event": "progress", "runId": "run-1", "frame": 0 })
        );
        assert_eq!(
            sequenced(&ExportEvent::Publishing {
                run_id: "run-1".to_owned(),
            }),
            serde_json::json!({ "seq": 7, "event": "publishing", "runId": "run-1" })
        );
        assert_eq!(
            sequenced(&finished("run-1")),
            serde_json::json!({
                "seq": 7,
                "event": "finished",
                "runId": "run-1",
                "outputPath": "/out.mp4",
                "frames": 10,
            })
        );
        assert_eq!(
            sequenced(&failed("run-1", ExportErrorCode::Canceled)),
            serde_json::json!({ "seq": 7, "event": "failed", "runId": "run-1", "code": "canceled" })
        );
        assert_eq!(
            sequenced(&ExportEvent::Failed {
                run_id: "run-1".to_owned(),
                code: ExportErrorCode::AudioDurationMismatch,
                detail: Some("short".to_owned()),
                exit_code: Some(-1),
                encoder: Some("libx264".to_owned()),
                measured_duration_us: Some(900),
                expected_duration_us: Some(1000),
            }),
            serde_json::json!({
                "seq": 7,
                "event": "failed",
                "runId": "run-1",
                "code": "audioDurationMismatch",
                "detail": "short",
                "exitCode": -1,
                "encoder": "libx264",
                "measuredDurationUs": 900,
                "expectedDurationUs": 1000,
            })
        );
    }
}
