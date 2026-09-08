//! The single-flight guard and the cancellation handle for the export renderer.
//!
//! This module answers two questions for the whole application, and nothing else: is an
//! export already running, and has the user asked the running one to stop.
//!
//! **One export at a time.** Two exports that run at the same time compete for the same
//! encoder. That is the same false-negative problem ADR 006 already records for capability
//! probing, where two hardware smoke tests running at once report a working encoder as
//! broken; `capabilities::smoke::SMOKE_LOCK` exists for exactly that reason. An export runs
//! for minutes rather than seconds, so it cannot simply wait its turn behind a mutex the way
//! a smoke test does: the command layer must be able to reject the second request outright
//! and tell the user why. [`ExportRegistry::begin`] therefore returns `Option`, and the
//! command layer turns `None` into a rejection rather than into a queue.
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
//!
//! [`ExportRegistry::cancel_active`] is the one exception, and it names the run by the slot it
//! occupies instead. It exists because a caller cannot pass an id it has not been given yet,
//! and it carries no staleness protection at all; its own documentation states what a caller
//! must know before it uses it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

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

/// The one export slot for the whole application, plus the cancellation flag of whichever
/// export holds it.
///
/// This type is the shared state behind the export commands: `lib.rs` stores one
/// `Arc<ExportRegistry>` as Tauri managed state, so a single value is reachable from every
/// command invocation, from every worker thread, and from the application's own exit
/// handler. It holds no path, no plan, and no process handle on purpose -- the stages that
/// own those can then be written, and tested, without knowing how the application decides
/// which export is allowed to run.
///
/// [`Default`] gives the empty registry, which is the correct starting state: no export is
/// running before one begins.
#[derive(Debug, Default)]
pub struct ExportRegistry {
    /// `None` when the slot is free, `Some` when an export holds it.
    ///
    /// A poisoned lock here is always recovered, never propagated; see
    /// [`ExportRegistry::lock`].
    active: Mutex<Option<ActiveExport>>,
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
    /// long time. The command layer turns `None` into an immediate, explicit rejection.
    ///
    /// The flag and the identifier are allocated before the lock is taken, so the critical
    /// section holds nothing but a check and a move.
    pub fn begin(self: &Arc<Self>, run_id: &str) -> Option<ExportSlot> {
        let cancel = Arc::new(AtomicBool::new(false));
        let run_id = run_id.to_owned();

        {
            let mut active = self.lock();
            if active.is_some() {
                return None;
            }
            *active = Some(ActiveExport {
                run_id: run_id.clone(),
                cancel: Arc::clone(&cancel),
            });
        }

        Some(ExportSlot {
            registry: Arc::clone(self),
            run_id,
            cancel,
        })
    }

    /// Ask the run named by `run_id` to stop, and report whether the request reached the run
    /// that currently holds the slot.
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
    /// `false` means the request named a run that is not holding the slot -- one that already
    /// ended, or one that never existed -- and in that case nothing is set at all. This is the
    /// ADR 006 staleness rule applied to a request rather than to an event. Do not render
    /// `false` to the user as "there is nothing to cancel": a different export may well be
    /// running, and this result says only that it is not the one the caller named.
    pub fn cancel(&self, run_id: &str) -> bool {
        let active = self.lock();
        let Some(export) = active.as_ref() else {
            return false;
        };
        if export.run_id != run_id {
            return false;
        }
        // `Relaxed` would be sound here: the flag carries no payload, so there is nothing for
        // a `Release` store to publish and nothing for an `Acquire` load to acquire, and
        // atomicity alone guarantees the poller observes the value. `SeqCst` is used because
        // it is strictly stronger than this site needs and costs nothing measurable at
        // process-supervision poll rates, so no later reader has to reconstruct an ordering
        // argument to convince themselves the flag is delivered.
        export.cancel.store(true, Ordering::SeqCst);
        true
    }

    /// Ask whichever run holds the slot to stop, and report whether there was one. `false` when
    /// the slot is free, and in that case nothing is set at all.
    ///
    /// This reports a `bool` rather than the run's identifier because no caller needs the name.
    /// `commands::export::cancel_active_export` is the only one, and it answers the frontend with
    /// whether a flag was set; returning the id meant cloning a `String` inside the critical
    /// section for a value that was then discarded. The clone could not simply move below the
    /// guard, since the id is borrowed from the data the guard protects, so the work is removed
    /// instead of relocated. A caller that needs the name of the run holding the slot has
    /// [`ExportRegistry::active_run_id`], which exists for exactly that and states what a snapshot
    /// of it is worth.
    ///
    /// This is [`ExportRegistry::cancel`] without the id comparison, and it exists for the one
    /// window in which a caller cannot name the run: `commands::export::start_export` claims
    /// the slot, prepares, and answers with the run id only afterward, so for the whole of
    /// preparation -- a re-probe alone is bounded at [`crate::ffmpeg::probe::PROBE_TIMEOUT`],
    /// which is 30 seconds -- the frontend holds no id to pass to [`ExportRegistry::cancel`].
    ///
    /// # Why dropping the comparison is safe here, and only here
    ///
    /// This module's staleness discipline rests on the `run_id` comparison, so removing it
    /// removes that protection: a request that arrives late cancels whatever run holds the slot
    /// rather than nothing. The slot is only an unambiguous name for a run because the registry
    /// holds exactly one at a time; it is not a *stable* name, because the run behind it
    /// changes. A caller must therefore have its own reason to believe the run it means is the
    /// one holding the slot right now. `commands::export::cancel_active_export` states that
    /// reason, and it is the only caller.
    ///
    /// Everything [`ExportRegistry::cancel`] says about its `true` applies to a `true` here,
    /// including the obligation on the process stage to read the flag once more before it
    /// publishes an output.
    pub fn cancel_active(&self) -> bool {
        let active = self.lock();
        let Some(export) = active.as_ref() else {
            return false;
        };
        // The same store as `ExportRegistry::cancel`, for the reason given there.
        export.cancel.store(true, Ordering::SeqCst);
        true
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
        self.lock().as_ref().map(|export| export.run_id.clone())
    }

    /// Release the slot held by `run_id`, so the next export can begin.
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
    pub fn finish(&self, run_id: &str) {
        // The block is load-bearing, not decoration. It ends the guard's scope before
        // `finished` is dropped, so freeing the `String` and the last `Arc` reference happens
        // outside the critical section. Writing this as one statement would work only by way
        // of the temporary-lifetime rule (the `self.lock()` temporary would be dropped at the
        // end of the statement, before the binding), which is exactly the kind of implicit
        // detail an innocuous-looking refactor -- hoisting the guard into its own binding --
        // silently reverses, moving deallocation back under the lock with no test to catch it.
        let finished = {
            let mut active = self.lock();
            active.take_if(|export| export.run_id == run_id)
        };
        drop(finished);
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
    fn lock(&self) -> MutexGuard<'_, Option<ActiveExport>> {
        self.active.lock().unwrap_or_else(PoisonError::into_inner)
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
            !registry.active.is_poisoned(),
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
    fn cancel_active_cancels_the_run_holding_the_slot_and_sets_its_flag() {
        // The window this method exists for: `start_export` has claimed the slot and has not
        // yet answered with the run id, so the caller has no id to compare against. The flag
        // assertion is what identifies the run that was canceled, now that the method reports
        // only whether one was.
        let registry = registry();
        let slot = registry.begin("run-1").expect("the slot starts free");

        assert!(registry.cancel_active());
        assert!(
            slot.is_canceled(),
            "cancel_active must set the very flag the matching begin returned"
        );
    }

    #[test]
    fn cancel_active_reports_nothing_when_the_slot_is_free() {
        let registry = registry();

        assert!(!registry.cancel_active());
    }

    #[test]
    fn cancel_active_after_a_release_cancels_whichever_run_holds_the_slot_now() {
        // A second call must read the slot again rather than remember what the first one
        // found. Between the two the first run releases the slot and a second run claims it,
        // so a stale answer here would cancel a run that is no longer there or report one that
        // is. Which run each call reached is asserted through the two runs' own flags: the
        // second run must end canceled, and the first run's release must leave the middle call
        // with nothing to set.
        let registry = registry();
        let first = registry.begin("run-1").expect("the slot starts free");

        assert!(registry.cancel_active());
        assert!(first.is_canceled(), "the first call reached the first run");

        drop(first);
        assert!(
            !registry.cancel_active(),
            "a released slot holds no run to cancel"
        );

        let second = registry
            .begin("run-2")
            .expect("the slot is free after the first run released it");
        assert!(
            !second.is_canceled(),
            "the call made while the slot was free must not have set the next run's flag"
        );
        assert!(registry.cancel_active());
        assert!(second.is_canceled());
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
            let _guard = poisoner.active.lock().unwrap();
            panic!("poison the export registry lock on purpose for the recovery test");
        })
        .join();
        assert!(
            poison_result.is_err(),
            "the spawned thread should have panicked"
        );
        assert!(registry.active.is_poisoned());

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
}
