//! The single-flight guard, the queue, and the cancellation handle for the export renderer.
//!
//! This module answers three questions for the whole application, and nothing else: is an
//! export already running, which exports wait for it, and has the user asked a run to stop.
//!
//! **One export at a time.** Two exports that run at the same time compete for the same
//! encoder. That is the same false-negative problem ADR 006 already records for capability
//! probing, where two hardware smoke tests running at once report a working encoder as
//! broken; `capabilities::smoke::SMOKE_LOCK` exists for exactly that reason.
//!
//! **A second export waits in a queue (ADR 049).** [`ExportRegistry::submit`] starts a run
//! when the slot is free, and otherwise puts it at the end of the queue. When a run releases
//! the slot, the registry hands the slot to the first waiting run and starts it, in the same
//! critical section that frees it. The next run therefore starts in the backend, whatever the
//! web view does: a web view that the system suspends while the window is minimized does not
//! stop the queue. A waiting run is a [`WaitingRun`], which the command layer implements, so
//! this module still holds no path, no plan and no process.
//!
//! **The claim is an owned guard, not a promise to call a function.** A slot that is claimed
//! and never released refuses every later export until the application restarts, so the
//! release cannot depend on a worker remembering it on every exit path -- and a panic in the
//! worker is an exit path that no `?` and no `match` covers. [`ExportRegistry::begin`]
//! therefore returns an [`ExportSlot`] whose [`Drop`] releases the slot, so an unwinding
//! worker frees the slot on its way out. Note what does *not* rescue that case: this registry
//! never holds its own lock across worker code, so a worker panic does not poison anything,
//! and the lock's poison recovery has no part in this. The guard is the only defense.
//!
//! **Cancellation is a flag, not a kill.** The process stage owns the `ffmpeg` child and
//! polls the [`AtomicBool`] this registry hands out; it decides when to stop reading
//! progress, kill the child, and remove the temporary output. This module never touches a
//! process, so the whole single-flight and cancellation policy is testable with no `ffmpeg`
//! binary, no Tauri application handle, and no temporary files. Two obligations fall on the
//! process stage in return, and both are stated on the methods below: check the flag before
//! spawning `ffmpeg` at all, and check it once more before publishing a finished output.
//!
//! **Every method that names a run takes its `run_id`.** ADR 006 applies the same staleness
//! discipline to probe events: every event carries a `runId`, and the receiver discards an
//! event whose run is no longer the active one. A cancel or a release that arrives late --
//! from a worker thread that is already unwinding, or from a frontend that has not yet
//! learned the previous export ended -- must never disturb the export that replaced it. The
//! `run_id` comparison in [`ExportRegistry::cancel`] and [`ExportRegistry::finish`] is what
//! makes a late call a no-op instead of a cancellation of the wrong export. That comparison
//! is string equality, so the whole guarantee rests on run ids never repeating within one
//! process; see [`ExportRegistry::begin`] for that requirement and for how to satisfy it.

use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// A run that waits in the queue for the export slot.
///
/// The registry calls at most one of the two methods, once, with no lock of the registry held.
/// At the application exit it calls neither, and drops the run quietly
/// ([`ExportRegistry::close_for_exit`]). The command layer implements it for an export, and a
/// test implements it with plain data.
pub trait WaitingRun: Send {
    /// The run takes the slot. The run owns `slot` from here, as a run that took a free slot
    /// owns the slot of [`ExportRegistry::begin`], and dropping it releases the slot to the
    /// next waiting run.
    fn start(self: Box<Self>, slot: ExportSlot);
    /// The run leaves the queue without starting, because a cancel named it.
    fn withdraw(self: Box<Self>);
}

/// A run in the queue, with the identifier that a cancel names it by.
struct QueuedRun {
    run_id: String,
    run: Box<dyn WaitingRun>,
}

impl fmt::Debug for QueuedRun {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("QueuedRun")
            .field("run_id", &self.run_id)
            .finish_non_exhaustive()
    }
}

/// What the lock of [`ExportRegistry`] protects.
#[derive(Debug, Default)]
struct RegistryState {
    /// `None` when the slot is free, `Some` when an export holds it.
    active: Option<ActiveExport>,
    /// The runs that wait for the slot, first in first out. It is empty whenever `active` is
    /// `None`: a release hands the slot to the first waiting run in the same critical section.
    queue: VecDeque<QueuedRun>,
    /// True once the application exit began ([`ExportRegistry::close_for_exit`]). No run
    /// starts or waits after that.
    closed: bool,
}

/// The answer of [`ExportRegistry::submit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submission {
    /// The slot was free, and the run started.
    Started,
    /// Another run holds the slot, and this run waits at the end of the queue.
    Queued,
    /// The application exit began. The run neither started nor waits.
    Closed,
}

/// The export that currently owns the single slot, and the flag that asks it to stop.
#[derive(Debug)]
struct ActiveExport {
    /// The identifier the caller passed to [`ExportRegistry::begin`].
    ///
    /// The registry compares against this value rather than trusting a caller to be current,
    /// so a stale [`ExportRegistry::cancel`] or [`ExportRegistry::finish`] cannot reach the
    /// run that replaced the one it names.
    run_id: String,
    /// The cancellation flag the process stage polls.
    ///
    /// The registry keeps one `Arc` and hands a clone to the caller of
    /// [`ExportRegistry::begin`], so [`ExportRegistry::cancel`] can set the same flag the
    /// worker is reading without holding any reference to the worker itself.
    cancel: Arc<AtomicBool>,
}

/// The one export slot for the whole application, the queue of the runs that wait for it, and
/// the cancellation flag of whichever export holds it.
///
/// This type is the shared state behind the export commands: `lib.rs` stores one
/// `Arc<ExportRegistry>` as Tauri managed state, so a single value is reachable from every
/// command invocation, from every worker thread, and from the application's own exit
/// handler. It holds no path, no plan, and no process handle on purpose -- the stages that
/// own those can then be written, and tested, without knowing how the application decides
/// which export is allowed to run.
///
/// [`Default`] gives the empty registry, which is the correct starting state: no export is
/// running before one begins, and none waits.
#[derive(Debug, Default)]
pub struct ExportRegistry {
    /// The slot, the queue, and whether the exit began.
    ///
    /// A poisoned lock here is always recovered, never propagated; see
    /// [`ExportRegistry::lock`].
    state: Mutex<RegistryState>,
    /// How many runs have taken the slot since the registry was made: through
    /// [`ExportRegistry::begin`], [`ExportRegistry::submit`], or a hand-over from the queue.
    ///
    /// See [`ExportRegistry::begun_count`].
    begun: AtomicU64,
}

/// A claim on the single export slot: the run's identifier, its cancellation flag, and the
/// obligation to release the slot, all in one value that releases on [`Drop`].
///
/// The worker that renders the export owns this value for the whole run. Dropping it -- by
/// returning, by `?`, or by unwinding out of a panic -- calls [`ExportRegistry::finish`] for
/// this run and no other, so the slot cannot be stranded by an exit path the author of the
/// worker did not think of. An explicit [`ExportRegistry::finish`] before the drop is
/// harmless: that method is idempotent and compares the run id, so the guard's own call then
/// does nothing.
///
/// The slot owns an `Arc<ExportRegistry>` rather than borrowing the registry, because it has
/// to outlive the command invocation that claimed it: the command claims the slot (so it can
/// reject a second export immediately, while it can still answer the frontend) and then moves
/// the slot to the worker thread that renders. A borrowed guard could not make that move,
/// because Tauri hands a command its managed state as a borrow that ends with the command.
#[must_use = "an ExportSlot releases the export slot when it is dropped, so a slot that is \
              not bound for the lifetime of the run frees the slot immediately and lets a \
              second export start"]
#[derive(Debug)]
pub struct ExportSlot {
    /// The registry to release this claim into on drop.
    registry: Arc<ExportRegistry>,
    /// This run's identifier, as passed to [`ExportRegistry::begin`].
    run_id: String,
    /// This run's cancellation flag, the same `AtomicBool` the registry holds.
    cancel: Arc<AtomicBool>,
}

// The registry is Tauri managed state, and the slot travels from the command thread to the
// worker thread, so both need `Send + Sync + 'static`. Those obligations
// are pinned here as compile-time assertions rather than left to the distant call sites: a
// future field that is not thread-safe -- an `Rc`, a `Cell`, a raw pointer -- would otherwise
// compile cleanly in this module and fail only in the unit that spawns the worker.
const _: () = {
    const fn assert_send_and_sync<T: Send + Sync + 'static>() {}
    assert_send_and_sync::<ExportRegistry>();
    assert_send_and_sync::<ExportSlot>();
};

impl ExportRegistry {
    /// Claim the single export slot for `run_id`, and return the guard that owns the claim.
    /// `None` when an export is already running.
    ///
    /// # `run_id` must be unique within the process
    ///
    /// Every staleness guarantee in this module is string equality on `run_id`, so a repeated
    /// id defeats all of them. A run id derived from something that recurs -- the output path,
    /// the preset id, the source file name -- produces exactly the failure the comparison
    /// exists to prevent: cancel the first export of `out.mp4`, start a second export of
    /// `out.mp4`, and the first cancel request, still in flight, matches the second run by
    /// string equality and kills it. Derive the id from a generator that cannot repeat within
    /// one process. `commands::next_run_id` is that generator (epoch milliseconds plus a
    /// monotonic counter to break ties inside one millisecond), and
    /// `commands::export::start_export` calls it rather than inventing a second scheme.
    ///
    /// # What the caller must do with the result
    ///
    /// Hold the returned [`ExportSlot`] for the whole run and move it to the worker, so the
    /// worker's own unwind releases the slot. Then, before spawning `ffmpeg` at all, check
    /// [`ExportSlot::is_canceled`]: a cancel can arrive between this call and the worker's
    /// first poll, and a worker that only starts polling after the spawn would launch a
    /// process and write a temporary file for an export the user already stopped. A flag that
    /// is already set at that point means abort without starting.
    ///
    /// The process stage polls the flag with [`ExportSlot::is_canceled`], which loads with
    /// [`Ordering::SeqCst`] to match [`ExportRegistry::cancel`]'s store. A reader thread that
    /// needs its own handle takes one from [`ExportSlot::cancel_flag`].
    ///
    /// # Why `None` is a refusal
    ///
    /// An export runs for minutes, so a caller that blocked here would leave the user with an
    /// interface that appears to have accepted a second export and then does nothing for a
    /// long time. A caller that wants a second export to wait uses
    /// [`ExportRegistry::submit`] instead.
    ///
    /// The flag and the identifier are allocated before the lock is taken, so the critical
    /// section holds nothing but a check and a move.
    ///
    /// `None` also comes after [`ExportRegistry::close_for_exit`]. The command layer starts an
    /// export through [`ExportRegistry::submit`], which queues where this refuses.
    pub fn begin(self: &Arc<Self>, run_id: &str) -> Option<ExportSlot> {
        let cancel = Arc::new(AtomicBool::new(false));
        let run_id = run_id.to_owned();

        {
            let mut state = self.lock();
            if state.closed || state.active.is_some() {
                return None;
            }
            self.claim(&mut state, &run_id, &cancel);
        }

        Some(ExportSlot {
            registry: Arc::clone(self),
            run_id,
            cancel,
        })
    }

    /// Start `run` at once when the slot is free, or put it at the end of the queue.
    ///
    /// `run_id` must be unique within the process, for the reason [`ExportRegistry::begin`]
    /// gives. A run that starts here receives its slot through [`WaitingRun::start`] before
    /// this returns. A run that waits receives it when every run before it has released the
    /// slot. After [`ExportRegistry::close_for_exit`], the run is dropped, and neither method
    /// is called.
    pub fn submit(self: &Arc<Self>, run_id: &str, run: Box<dyn WaitingRun>) -> Submission {
        let cancel = Arc::new(AtomicBool::new(false));
        let run_id = run_id.to_owned();

        let to_start = {
            let mut state = self.lock();
            if state.closed {
                None
            } else if state.active.is_none() {
                self.claim(&mut state, &run_id, &cancel);
                Some(run)
            } else {
                state.queue.push_back(QueuedRun {
                    run_id: run_id.clone(),
                    run,
                });
                return Submission::Queued;
            }
        };

        // The run is started, or dropped, with no lock held: its code is not this module's.
        match to_start {
            Some(run) => {
                run.start(ExportSlot {
                    registry: Arc::clone(self),
                    run_id,
                    cancel,
                });
                Submission::Started
            }
            None => Submission::Closed,
        }
    }

    /// Refuse every later run, and drop the runs that wait.
    ///
    /// The application-exit handler calls this before it cancels the run that holds the slot
    /// (ADR 017). Without it, the release of that run would hand the slot to the next waiting
    /// run, and the exit would wait for a run that had just started. A run that holds the slot
    /// keeps it, and releases it as before. A second call does nothing more.
    ///
    /// The runs that wait are dropped without [`WaitingRun::withdraw`]. The window is closing,
    /// so no page reads a report of them, and the exit sends no event that nobody reads.
    pub fn close_for_exit(&self) {
        let dropped: Vec<QueuedRun> = {
            let mut state = self.lock();
            state.closed = true;
            state.queue.drain(..).collect()
        };
        // Dropped after the lock is released: their code is not this module's.
        drop(dropped);
    }

    /// The identifiers of the runs that wait, first to last.
    #[must_use]
    pub fn queued_run_ids(&self) -> Vec<String> {
        self.lock()
            .queue
            .iter()
            .map(|queued| queued.run_id.clone())
            .collect()
    }

    /// Make `run_id` the run that holds the slot. The caller holds the lock, and found the
    /// slot free.
    fn claim(&self, state: &mut RegistryState, run_id: &str, cancel: &Arc<AtomicBool>) {
        state.active = Some(ActiveExport {
            run_id: run_id.to_owned(),
            cancel: Arc::clone(cancel),
        });
        // Inside the critical section, so a reader that finds the slot free and then reads the
        // same count again knows that no run began in between.
        self.begun.fetch_add(1, Ordering::SeqCst);
    }

    /// Ask the run named by `run_id` to stop, and report whether the request reached the run
    /// that currently holds the slot or a run that waits.
    ///
    /// A run that waits leaves the queue at once, and the registry calls its
    /// [`WaitingRun::withdraw`] after it releases the lock. The rest of this section is about
    /// the run that holds the slot.
    ///
    /// This sets the flag [`ExportRegistry::begin`] handed out and returns immediately. It
    /// does not kill a process, does not wait for the run to notice, and does not release the
    /// slot: the worker sees the flag on its next poll, unwinds its own work, and drops its
    /// [`ExportSlot`]. A registry that released the slot here instead would let a second
    /// export start while the first `ffmpeg` process is still alive and still writing its
    /// temporary file.
    ///
    /// # What `true` means, and what it does not
    ///
    /// `true` means the flag of the run currently holding the slot was set. It does not mean
    /// the export will end as cancelled. A request can land in the window between `ffmpeg`
    /// exiting successfully and the worker dropping its slot: the entry still matches, so this
    /// returns `true`, and nobody ever reads the flag again. The process stage must therefore
    /// check [`ExportSlot::is_canceled`] once more, after the child exits and *before* it
    /// renames the temporary file over the destination, and treat a set flag as a cancellation
    /// that discards the output. That single re-check makes the window decisive in one
    /// direction or the other -- either the cancel wins and no file is published, or the
    /// export completes and the command layer reports a completion -- instead of leaving the
    /// user with a finished file and a message that says the export was cancelled.
    ///
    /// # What `false` means, and what it does not
    ///
    /// `false` means the request named a run that neither holds the slot nor waits -- one that
    /// already ended, or one that never existed -- and in that case nothing is set at all. This
    /// is the ADR 006 staleness rule applied to a request rather than to an event. Do not render
    /// `false` to the user as "there is nothing to cancel": a different export may well be
    /// running, and this result says only that it is not the one the caller named.
    pub fn cancel(&self, run_id: &str) -> bool {
        let withdrawn = {
            let mut state = self.lock();
            match state.active.as_ref() {
                Some(export) if export.run_id == run_id => {
                    Self::flag(export);
                    return true;
                }
                _ => {}
            }
            let Some(index) = state
                .queue
                .iter()
                .position(|queued| queued.run_id == run_id)
            else {
                return false;
            };
            state.queue.remove(index)
        };
        if let Some(queued) = withdrawn {
            queued.run.withdraw();
        }
        true
    }

    /// Set the cancel flag of the run that holds the slot.
    fn flag(export: &ActiveExport) {
        // `Relaxed` would be sound here: the flag carries no payload, so there is nothing for
        // a `Release` store to publish and nothing for an `Acquire` load to acquire, and
        // atomicity alone guarantees the poller observes the value. `SeqCst` is used because
        // it is strictly stronger than this site needs and costs nothing measurable at
        // process-supervision poll rates, so no later reader has to reconstruct an ordering
        // argument to convince themselves the flag is delivered.
        export.cancel.store(true, Ordering::SeqCst);
    }

    /// The identifier of the export that currently holds the slot, or `None` when the slot
    /// is free.
    ///
    /// This exists for one caller: the application-exit handler in `lib.rs`. A quit during an
    /// export has to name the running run to [`ExportRegistry::cancel`], and it has to be
    /// able to see when the slot has been released, so it can let the exit proceed instead of
    /// leaving `ffmpeg` orphaned and its temporary file on disk. Nothing else needs it, and
    /// no decision can be made on it that is not also correct one instant later: the value is
    /// a snapshot, and the run it names can end between this call and the next statement.
    /// Cancelling a run this returned is safe for exactly that reason -- [`ExportRegistry::cancel`]
    /// compares the id again under the lock, so a run that ended in the window is a no-op
    /// rather than a cancellation of its successor.
    ///
    /// The id is cloned rather than borrowed because the lock cannot outlive this call.
    #[must_use]
    pub fn active_run_id(&self) -> Option<String> {
        self.lock()
            .active
            .as_ref()
            .map(|export| export.run_id.clone())
    }

    /// How many runs have taken the slot since the registry was made, a run that started from
    /// the queue included.
    ///
    /// The test of a preset (`commands::preset_test`) reads it before and after its encode. A
    /// different value means that an export began while the test ran, even one that also
    /// ended in that time, which [`ExportRegistry::active_run_id`] alone cannot show. The two
    /// encodes then competed for the encoder, so the test does not store its result.
    #[must_use]
    pub fn begun_count(&self) -> u64 {
        self.begun.load(Ordering::SeqCst)
    }

    /// Release the slot held by `run_id`, and hand it to the first run that waits.
    ///
    /// Callers do not normally need this: dropping the [`ExportSlot`] calls it. It stays
    /// public, and stays total, so the guard and an explicit release coexist harmlessly.
    /// Calling it twice, or calling it when the slot is already free, does nothing and reports
    /// nothing.
    ///
    /// A `run_id` that does not match the active run leaves the slot untouched. Without that
    /// comparison, a late release from a finished run -- including the drop of a slot whose
    /// run already released the slot explicitly -- would hand the slot away while its
    /// successor is still running, and the application would then permit two concurrent
    /// exports, the exact failure this whole module exists to prevent.
    ///
    /// The hand-over happens in the critical section that frees the slot, so no submission can
    /// take the slot between the two: a run that comes in that moment waits behind the queue.
    /// Nothing is handed over after [`ExportRegistry::close_for_exit`]. The next run is started
    /// after the lock is released. A run whose start drops its slot at once, as an export
    /// thread that the system refuses does, releases the slot to the run after it from inside
    /// this call. The depth of that is at most the length of the queue.
    pub fn finish(self: &Arc<Self>, run_id: &str) {
        // The block is load-bearing, not decoration. It ends the guard's scope before
        // `finished` is dropped and before the next run starts, so freeing the `String` and the
        // last `Arc` reference, and the code of the next run, happen outside the critical
        // section. Writing this as one statement would work only by way of the
        // temporary-lifetime rule, which is exactly the kind of implicit detail an
        // innocuous-looking refactor silently reverses, with no test to catch it.
        let (finished, next) = {
            let mut state = self.lock();
            let finished = state.active.take_if(|export| export.run_id == run_id);
            let next = if finished.is_some() && !state.closed {
                state.queue.pop_front().map(|queued| {
                    let cancel = Arc::new(AtomicBool::new(false));
                    self.claim(&mut state, &queued.run_id, &cancel);
                    (queued, cancel)
                })
            } else {
                None
            };
            (finished, next)
        };
        drop(finished);
        if let Some((queued, cancel)) = next {
            let QueuedRun { run_id, run } = queued;
            run.start(ExportSlot {
                registry: Arc::clone(self),
                run_id,
                cancel,
            });
        }
    }

    /// Lock the slot, recovering a poisoned lock instead of propagating it.
    ///
    /// Only the methods in this module ever hold this lock, and none of them holds it across
    /// caller code, so an export worker that panics does not poison it. What poison this can
    /// still see comes from a panic inside a critical section here -- an allocation failure, a
    /// panic in a future addition to one of these methods -- and propagating it would turn one
    /// such panic into a `begin` that panics for the rest of the process's life. The data
    /// behind the lock is a single `Option`, and every method replaces it wholesale rather than
    /// mutating it in steps, so a panic cannot leave it half updated in a way that recovery
    /// would then read. `capabilities::smoke::SMOKE_LOCK` and `capabilities::cache::CACHE_LOCK`
    /// recover their poison the same way, for the same reason.
    ///
    /// This recovery is not what protects the slot from a panicking worker. Nothing is poisoned
    /// in that case; [`ExportSlot`]'s drop guard is what releases the slot.
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ExportSlot {
    /// This run's identifier, the one [`ExportRegistry::begin`] claimed the slot with.
    ///
    /// The worker reports this in its progress events, so the frontend can address the run it
    /// wants to cancel; it is also the value [`ExportRegistry::cancel`] and
    /// [`ExportRegistry::finish`] compare against.
    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Whether this run has been asked to stop.
    ///
    /// This is the poll the process stage runs while it supervises `ffmpeg`. It exists so the
    /// load ordering is decided once, here, rather than at every call site: it pairs with
    /// [`ExportRegistry::cancel`]'s [`Ordering::SeqCst`] store.
    ///
    /// Two checks are obligations, not options. Check before spawning `ffmpeg`, so a cancel
    /// that arrives during setup aborts the run without starting a process. Check again after
    /// the child exits and before publishing the output, so a cancel that arrives in that
    /// window cannot leave the user with a renamed output file and a message that says the
    /// export was cancelled.
    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// A handle to this run's cancellation flag, for a thread that outlives this slot's
    /// borrow -- a progress reader, for instance -- and cannot poll through
    /// [`ExportSlot::is_canceled`].
    ///
    /// The handle is a plain `Arc<AtomicBool>`: whoever holds one can set it. The registry
    /// sets it only through [`ExportRegistry::cancel`], for a matching `run_id`, but this
    /// method hands out the ability to set it directly, so give it only to code that is part
    /// of the same run.
    #[must_use]
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }
}

impl Drop for ExportSlot {
    /// Release the slot for this run, whatever ended it.
    ///
    /// This is the whole reason [`ExportRegistry::begin`] returns a guard rather than a bare
    /// flag. A worker that returns early, propagates an error with `?`, or unwinds out of a
    /// panic in progress parsing frees the slot on the way out. Without this, that panicking
    /// worker would leave the slot claimed by a run that no longer exists, holding the only
    /// handle that could ever cancel it, and every later export would be refused until the
    /// application restarts.
    ///
    /// The release goes through [`ExportRegistry::finish`], so it compares the run id: a slot
    /// whose run already released the slot explicitly drops without disturbing the export that
    /// replaced it.
    fn drop(&mut self) {
        self.registry.finish(&self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Barrier;
    use std::thread;

    fn registry() -> Arc<ExportRegistry> {
        Arc::new(ExportRegistry::default())
    }

    #[test]
    fn begin_claims_the_slot_and_hands_out_a_flag_that_starts_unset() {
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");

        assert_eq!(slot.run_id(), "run-1");
        assert!(
            !slot.is_canceled(),
            "a fresh export must not start out canceled"
        );
    }

    #[test]
    fn active_run_id_names_the_holder_of_the_slot_and_nothing_once_it_is_free() {
        // The application-exit handler reads this to find the run it must cancel before the
        // process ends, so a free slot has to be distinguishable from a held one.
        let registry = registry();
        assert_eq!(registry.active_run_id(), None);

        let slot = registry.begin("run-1").expect("the slot starts free");
        assert_eq!(registry.active_run_id().as_deref(), Some("run-1"));

        drop(slot);
        assert_eq!(registry.active_run_id(), None);
    }

    #[test]
    fn a_second_begin_is_refused_while_the_first_export_is_active() {
        let registry = registry();
        let _first = registry.begin("run-1").expect("the slot starts free");

        assert!(
            registry.begin("run-2").is_none(),
            "the second begin must be refused, not queued"
        );
    }

    #[test]
    fn begin_succeeds_again_after_finish_releases_the_slot() {
        let registry = registry();
        let _first = registry.begin("run-1").expect("the slot starts free");
        registry.finish("run-1");

        assert!(
            registry.begin("run-2").is_some(),
            "the slot must be reusable once the run that held it finished"
        );
    }

    #[test]
    fn dropping_the_slot_releases_it_without_an_explicit_finish() {
        let registry = registry();
        {
            let _slot = registry.begin("run-1").expect("the slot starts free");
        }

        assert!(
            registry.begin("run-2").is_some(),
            "the guard's drop must release the slot on the ordinary path too"
        );
    }

    #[test]
    fn a_panicking_worker_releases_the_slot_through_the_guard_and_poisons_nothing() {
        // The failure this guard exists for. A worker that panics -- a slice index on a
        // malformed progress line, a `PoisonError` from some other lock -- never reaches any
        // release it was supposed to call. Nothing else rescues the slot here: the registry
        // never holds its own lock across worker code, so the panic does not poison the lock
        // and the poison recovery has no part in this. Without the drop guard the slot stays
        // claimed by a run that no longer exists, and every later export is refused until the
        // application restarts.
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");

        let outcome = thread::spawn(move || {
            let _slot = slot;
            panic!("the export worker panics before it can release the slot");
        })
        .join();

        assert!(outcome.is_err(), "the worker thread should have panicked");
        assert!(
            !registry.state.is_poisoned(),
            "a worker panic must not poison the registry lock; if it does, this test is no \
             longer exercising the drop guard"
        );
        assert!(
            registry.begin("run-2").is_some(),
            "a panicking worker must not strand the export slot"
        );
    }

    #[test]
    fn cancel_on_the_active_run_returns_true_and_sets_the_flag_begin_handed_out() {
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");

        assert!(registry.cancel("run-1"));
        assert!(
            slot.is_canceled(),
            "cancel must set the very flag the matching begin returned"
        );
    }

    #[test]
    fn a_cancel_flag_handed_to_another_thread_sees_the_same_cancellation() {
        // The progress reader polls its own `Arc` handle rather than the slot itself.
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");
        let flag = slot.cancel_flag();

        assert!(registry.cancel("run-1"));

        let observed = thread::spawn(move || flag.load(Ordering::SeqCst))
            .join()
            .expect("the reader thread should not panic");
        assert!(observed);
    }

    #[test]
    fn cancel_does_not_release_the_slot_because_the_worker_is_still_running() {
        // The ffmpeg child is still alive and still writing its temporary file when cancel
        // returns. Only the worker's own slot, dropped or released, may free the slot.
        let registry = registry();
        let _slot = registry.begin("run-1").expect("the slot starts free");

        assert!(registry.cancel("run-1"));
        assert!(
            registry.begin("run-2").is_none(),
            "cancel must not free the slot for a second export"
        );
    }

    #[test]
    fn cancel_with_an_unknown_run_id_returns_false_and_leaves_the_active_flag_unset() {
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");

        assert!(!registry.cancel("run-never-existed"));
        assert!(
            !slot.is_canceled(),
            "a cancel for an unknown run must not cancel the run that is actually active"
        );
    }

    #[test]
    fn a_stale_cancel_does_not_stop_the_run_that_replaced_the_one_it_names() {
        // The failure this guards against: an export ends, a second one starts, and a cancel
        // request for the first one arrives late from a frontend that has not caught up.
        // Returning false is only half the requirement; the second export must still be
        // running, and uncanceled, afterward. (The first run's own flag is not asserted on: the
        // registry dropped its reference at `finish`, so nothing could set it either way.)
        let registry = registry();
        let first = registry.begin("run-1").expect("the slot starts free");
        registry.finish("run-1");
        let second = registry
            .begin("run-2")
            .expect("the slot is free after the first run finished");

        assert!(!registry.cancel("run-1"));
        assert!(
            !second.is_canceled(),
            "a stale cancel must never cancel the export that replaced its run"
        );
        drop(first);
    }

    #[test]
    fn cancel_returns_false_when_no_export_is_active() {
        let registry = registry();
        assert!(!registry.cancel("run-1"));
    }

    #[test]
    fn finish_with_a_stale_run_id_does_not_release_another_runs_slot() {
        let registry = registry();
        let first = registry.begin("run-1").expect("the slot starts free");
        registry.finish("run-1");
        let _second = registry
            .begin("run-2")
            .expect("the slot is free after the first run finished");

        // Both shapes of a late release from the finished first run: an explicit call, and the
        // drop of its now-stale guard. Neither may hand the slot away while the second run is
        // still using it.
        registry.finish("run-1");
        drop(first);

        assert!(
            registry.begin("run-3").is_none(),
            "a stale finish must leave the active run holding the slot"
        );
    }

    #[test]
    fn finish_is_idempotent_and_harmless_on_an_already_free_slot() {
        let registry = registry();
        let first = registry.begin("run-1").expect("the slot starts free");

        registry.finish("run-1");
        registry.finish("run-1");
        registry.finish("run-never-existed");
        drop(first);

        assert!(
            registry.begin("run-2").is_some(),
            "repeated and unknown finishes must leave a free slot free, not corrupt it"
        );
    }

    #[test]
    fn the_registry_recovers_from_a_poisoned_lock() {
        // Poison the slot lock from a thread that panics while holding it. Only a panic inside
        // one of this module's own critical sections can do that in production, which is why
        // the test reaches for the field directly; a panicking worker poisons nothing (see
        // `a_panicking_worker_releases_the_slot_through_the_guard_and_poisons_nothing`).
        // `ExportRegistry::lock`'s `PoisonError::into_inner` recovery must still hand back a
        // usable guard afterward, or that one panic would make every later `begin` panic too.
        // This copies the shape of `capabilities::smoke`'s
        // `run_smoke_test_recovers_from_a_poisoned_lock`.
        let registry = registry();

        let poisoner = Arc::clone(&registry);
        let poison_result = thread::spawn(move || {
            let _guard = poisoner.state.lock().unwrap();
            panic!("poison the export registry lock on purpose for the recovery test");
        })
        .join();
        assert!(
            poison_result.is_err(),
            "the spawned thread should have panicked"
        );
        assert!(registry.state.is_poisoned());

        // Reaching these assertions at all is half the point: a propagated poison would have
        // panicked inside `lock` on the way here.
        let slot = registry
            .begin("run-after-poison")
            .expect("begin must still claim the slot through a poisoned lock");
        assert!(registry.cancel("run-after-poison"));
        assert!(slot.is_canceled());
        drop(slot);
        assert!(
            registry.begin("run-later").is_some(),
            "the slot must still be releasable and reusable after the poison"
        );
    }

    #[test]
    fn exactly_one_of_many_racing_threads_wins_the_export_slot() {
        // The check and the claim in `begin` are one critical section, so a real race between
        // threads must still produce a single winner. A barrier makes every thread attempt the
        // claim at as close to the same instant as the platform allows. Each thread returns its
        // slot rather than dropping it, so the winner still holds the claim when the assertions
        // run.
        const THREADS: usize = 16;

        let registry = registry();
        let barrier = Arc::new(Barrier::new(THREADS));
        let refusals = Arc::new(AtomicUsize::new(0));

        let workers: Vec<_> = (0..THREADS)
            .map(|index| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                let refusals = Arc::clone(&refusals);
                thread::spawn(move || {
                    let run_id = format!("run-{index}");
                    barrier.wait();
                    let slot = registry.begin(&run_id);
                    if slot.is_none() {
                        refusals.fetch_add(1, Ordering::SeqCst);
                    }
                    slot
                })
            })
            .collect();

        let winners: Vec<ExportSlot> = workers
            .into_iter()
            .filter_map(|worker| worker.join().expect("no worker thread should panic"))
            .collect();

        assert_eq!(winners.len(), 1, "exactly one thread may claim the slot");
        assert_eq!(refusals.load(Ordering::SeqCst), THREADS - 1);
        assert!(
            registry.cancel(winners[0].run_id()),
            "the run the registry considers active must be the thread that won"
        );
        assert!(winners[0].is_canceled());
    }

    #[test]
    fn the_begun_count_moves_once_for_each_admitted_run_and_never_for_a_refusal() {
        let registry = registry();
        assert_eq!(registry.begun_count(), 0);

        let first = registry.begin("run-1").expect("the slot starts free");
        assert_eq!(registry.begun_count(), 1);
        assert!(registry.begin("run-2").is_none());
        assert_eq!(
            registry.begun_count(),
            1,
            "a refused run did not begin, so it must not count"
        );

        // A run that began and ended leaves the slot as it found it, and only the count shows
        // that it ran.
        drop(first);
        assert!(registry.active_run_id().is_none());
        let _second = registry.begin("run-3").expect("the slot is free again");
        assert_eq!(registry.begun_count(), 2);
    }

    /// A waiting run that records what the registry did with it, and keeps its slot until the
    /// test releases it.
    struct RecordingRun {
        run_id: String,
        harness: Arc<Recorded>,
    }

    #[derive(Default)]
    struct Recorded {
        log: Mutex<Vec<String>>,
        slots: Mutex<Vec<ExportSlot>>,
    }

    impl WaitingRun for RecordingRun {
        fn start(self: Box<Self>, slot: ExportSlot) {
            let mut slots = self.harness.slots.lock().unwrap();
            assert!(
                slots.is_empty(),
                "two runs must never hold the slot at once"
            );
            slots.push(slot);
            drop(slots);
            self.harness
                .log
                .lock()
                .unwrap()
                .push(format!("start {}", self.run_id));
        }

        fn withdraw(self: Box<Self>) {
            self.harness
                .log
                .lock()
                .unwrap()
                .push(format!("withdraw {}", self.run_id));
        }
    }

    /// A registry with a log of the starts and withdrawals of its runs.
    struct Harness {
        registry: Arc<ExportRegistry>,
        recorded: Arc<Recorded>,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                registry: registry(),
                recorded: Arc::default(),
            }
        }

        fn submit(&self, run_id: &str) -> Submission {
            self.registry.submit(
                run_id,
                Box::new(RecordingRun {
                    run_id: run_id.to_owned(),
                    harness: Arc::clone(&self.recorded),
                }),
            )
        }

        /// Release the slot of the run that holds it, as the end of an export does. The slot
        /// is dropped after the lock of the record is released, because the drop starts the
        /// next run, which records itself.
        fn release(&self) {
            let slot = self.recorded.slots.lock().unwrap().pop();
            drop(slot);
        }

        fn take_log(&self) -> Vec<String> {
            std::mem::take(&mut *self.recorded.log.lock().unwrap())
        }
    }

    #[test]
    fn a_run_submitted_to_a_free_slot_starts_at_once() {
        let harness = Harness::new();

        assert_eq!(harness.submit("run-1"), Submission::Started);

        assert_eq!(harness.take_log(), ["start run-1"]);
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-1"));
        assert!(harness.registry.queued_run_ids().is_empty());
    }

    #[test]
    fn waiting_runs_start_in_order_as_each_run_releases_the_slot() {
        let harness = Harness::new();
        harness.submit("run-1");

        assert_eq!(harness.submit("run-2"), Submission::Queued);
        assert_eq!(harness.submit("run-3"), Submission::Queued);
        assert_eq!(harness.registry.queued_run_ids(), ["run-2", "run-3"]);
        assert_eq!(harness.take_log(), ["start run-1"]);

        harness.release();
        assert_eq!(harness.take_log(), ["start run-2"]);
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-2"));
        assert_eq!(harness.registry.queued_run_ids(), ["run-3"]);

        harness.release();
        assert_eq!(harness.take_log(), ["start run-3"]);

        harness.release();
        assert!(harness.take_log().is_empty());
        assert_eq!(harness.registry.active_run_id(), None);
    }

    #[test]
    fn a_run_that_panics_hands_the_slot_to_the_next_run() {
        let harness = Harness::new();
        let slot = harness.registry.begin("run-1").unwrap();
        harness.submit("run-2");

        let worker = thread::spawn(move || {
            let _slot = slot;
            panic!("the worker panicked");
        });
        assert!(worker.join().is_err());

        assert_eq!(harness.take_log(), ["start run-2"]);
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-2"));
    }

    #[test]
    fn a_cancel_withdraws_a_waiting_run_and_keeps_the_order_of_the_others() {
        let harness = Harness::new();
        harness.submit("run-1");
        harness.submit("run-2");
        harness.submit("run-3");
        harness.take_log();

        assert!(harness.registry.cancel("run-2"));
        assert_eq!(harness.take_log(), ["withdraw run-2"]);
        assert_eq!(harness.registry.queued_run_ids(), ["run-3"]);
        // A second cancel names a run that is gone.
        assert!(!harness.registry.cancel("run-2"));

        harness.release();
        assert_eq!(harness.take_log(), ["start run-3"]);
    }

    #[test]
    fn a_cancel_of_the_running_run_sets_its_flag_and_hands_over_only_at_the_release() {
        let harness = Harness::new();
        harness.submit("run-1");
        harness.submit("run-2");
        harness.take_log();

        assert!(harness.registry.cancel("run-1"));
        assert!(harness.recorded.slots.lock().unwrap()[0].is_canceled());
        // The run still holds the slot until its guards have finished.
        assert!(harness.take_log().is_empty());
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-1"));

        harness.release();
        assert_eq!(harness.take_log(), ["start run-2"]);
        assert!(
            !harness.recorded.slots.lock().unwrap()[0].is_canceled(),
            "the next run has a flag of its own"
        );
    }

    #[test]
    fn close_for_exit_drops_the_waiting_runs_quietly_and_refuses_new_ones() {
        let harness = Harness::new();
        harness.submit("run-1");
        harness.submit("run-2");
        harness.submit("run-3");
        harness.take_log();

        harness.registry.close_for_exit();
        // Neither started nor withdrawn: the exit reports nothing about them.
        assert!(harness.take_log().is_empty());
        assert!(harness.registry.queued_run_ids().is_empty());

        assert_eq!(harness.submit("run-4"), Submission::Closed);
        assert!(harness.registry.begin("run-5").is_none());
        assert!(harness.take_log().is_empty());

        // The running run keeps its slot, and its release starts nothing.
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-1"));
        harness.release();
        assert!(harness.take_log().is_empty());
        assert_eq!(harness.registry.active_run_id(), None);

        // A second call does nothing more.
        harness.registry.close_for_exit();
        assert!(harness.take_log().is_empty());
    }

    /// A waiting run whose start drops its slot at once, as an export whose thread the
    /// system refuses does.
    struct RefusedRun {
        run_id: String,
        harness: Arc<Recorded>,
    }

    impl WaitingRun for RefusedRun {
        fn start(self: Box<Self>, slot: ExportSlot) {
            self.harness
                .log
                .lock()
                .unwrap()
                .push(format!("refuse {}", self.run_id));
            drop(slot);
        }

        fn withdraw(self: Box<Self>) {
            unreachable!("a refused run is started, not withdrawn");
        }
    }

    #[test]
    fn a_run_that_drops_its_slot_at_once_hands_the_slot_to_the_next_run() {
        let harness = Harness::new();
        harness.submit("run-1");
        for run_id in ["run-2", "run-3"] {
            harness.registry.submit(
                run_id,
                Box::new(RefusedRun {
                    run_id: run_id.to_owned(),
                    harness: Arc::clone(&harness.recorded),
                }),
            );
        }
        harness.submit("run-4");
        harness.take_log();

        harness.release();

        assert_eq!(
            harness.take_log(),
            ["refuse run-2", "refuse run-3", "start run-4"]
        );
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-4"));
    }

    #[test]
    fn a_hand_over_counts_as_a_run_that_began() {
        // The preset test of ADR 041 compares this count, so a run that started from the queue
        // must count as one that began.
        let harness = Harness::new();
        harness.submit("run-1");
        harness.submit("run-2");
        assert_eq!(harness.registry.begun_count(), 1);

        harness.release();

        assert_eq!(harness.registry.begun_count(), 2);
    }

    #[test]
    fn a_late_release_of_an_ended_run_hands_nothing_over() {
        let harness = Harness::new();
        harness.submit("run-1");
        harness.submit("run-2");
        harness.take_log();

        harness.registry.finish("run-0");

        assert!(harness.take_log().is_empty());
        assert_eq!(harness.registry.active_run_id().as_deref(), Some("run-1"));
        assert_eq!(harness.registry.queued_run_ids(), ["run-2"]);
    }

    #[test]
    fn concurrent_submissions_each_start_exactly_once_and_one_at_a_time() {
        const RUNS: usize = 16;
        let harness = Arc::new(Harness::new());
        let barrier = Arc::new(Barrier::new(RUNS));
        let submitters: Vec<_> = (0..RUNS)
            .map(|index| {
                let harness = Arc::clone(&harness);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    harness.submit(&format!("run-{index}"))
                })
            })
            .collect();
        let started = submitters
            .into_iter()
            .map(|submitter| submitter.join().unwrap())
            .filter(|submission| *submission == Submission::Started)
            .count();
        assert_eq!(started, 1, "exactly one submission finds the slot free");

        // Each release starts the next run. `RecordingRun::start` asserts that no other run
        // holds the slot.
        for _ in 0..RUNS {
            harness.release();
        }

        let mut log = harness.take_log();
        assert_eq!(log.len(), RUNS);
        log.sort_unstable();
        log.dedup();
        assert_eq!(log.len(), RUNS, "no run starts twice");
        assert_eq!(harness.registry.active_run_id(), None);
        assert_eq!(harness.registry.begun_count(), RUNS as u64);
    }
}
