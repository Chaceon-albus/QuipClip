pub mod commands;
pub mod ffmpeg;
pub mod fsutil;
#[cfg(target_os = "macos")]
mod menu;
pub mod procutil;
pub mod project;
pub mod settings;
pub mod time;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// How long an application exit waits for a running export to stop.
///
/// The wait covers one poll of the cancel flag by the export supervisor
/// (`commands::export::PROGRESS_POLL_INTERVAL`, a tenth of a second), the kill and reap of the
/// `ffmpeg` child, the join of its two pipe reader threads, and the deletion of the reserved
/// temporary file. Five seconds is far above that sum and short enough that a quit still feels
/// like a quit.
///
/// It is a bound and not a wait for the slot: an exit that could be delayed indefinitely is
/// worse than an orphaned process, because only the user can end it. Whatever has not
/// finished by then is left to the operating system, exactly as it was before this handler
/// existed.
const EXIT_CANCEL_BUDGET: Duration = Duration::from_secs(5);

/// How often the exit handler looks at the export slot while it waits.
const EXIT_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The one exit wait of the process (ADR 017, ADR 027).
///
/// An exit can pass through two handlers: a confirmed `ExitRequested`, and then `Exit`. Each
/// one stops the export and waits. Without a shared deadline, an export that never stops
/// would hold the exit for the budget twice.
static EXIT_WAIT: ExitWait = ExitWait::new();

/// One deadline for every exit wait, and one log line for a wait that ran out.
struct ExitWait {
    deadline: OnceLock<Instant>,
    reported: AtomicBool,
}

impl ExitWait {
    const fn new() -> Self {
        Self {
            deadline: OnceLock::new(),
            reported: AtomicBool::new(false),
        }
    }

    /// The deadline of the exit. The first call sets it to `now + budget`, and every later
    /// call returns that same deadline, so a later wait gets only what remains of the budget.
    fn deadline(&self, now: Instant, budget: Duration) -> Instant {
        *self.deadline.get_or_init(|| now + budget)
    }

    /// True for the first caller only, so a wait that ran out is logged once.
    fn take_report(&self) -> bool {
        !self.reported.swap(true, Ordering::SeqCst)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The one export slot for the whole application (ADR 016). `ExportRegistry::begin`
        // takes `self: &Arc<Self>`, because the `ExportSlot` it hands out owns a reference to
        // the registry and outlives the command that claimed it, so the managed value is the
        // `Arc` itself rather than the registry.
        .manage(Arc::new(ffmpeg::export::ExportRegistry::default()))
        // Whether the user confirmed the quit (ADR 027). The exit handler below reads it.
        .manage(commands::quit::QuitGate::default());

    // The default macOS menu with a Quit item that raises `ExitRequested` (ADR 027). The
    // default Quit item raises only `Exit`, which cannot be prevented. See `menu`.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(menu::build_app_menu)
        .on_menu_event(menu::handle_menu_event);

    let application = builder
        .invoke_handler(tauri::generate_handler![
            commands::capabilities::start_capability_probe,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::export::cancel_active_export,
            commands::media::import_media,
            commands::media::read_source_revision,
            commands::project::load_project,
            commands::project::save_project,
            commands::quit::confirm_quit,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::restore_default_presets,
            commands::settings::reset_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Built rather than run, for the exit events alone. The export worker is a detached
    // thread, so when `main` returns nothing unwinds it: neither the guard that kills and
    // reaps `ffmpeg` nor the guard that deletes the reserved temporary file runs. The child
    // is then reparented and keeps encoding gigabytes into a file that is never renamed and
    // never removed.
    //
    // `ExitRequested` is the event to act on: it comes while the windows are still open, and
    // it can be prevented. `Exit` is the fallback for the exits that raise nothing else: the
    // Dock Quit and a logout on macOS, which send `terminate:`, and the end of a Windows
    // session. No dialog can run there, so it only stops the export.
    application.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            // ADR 027: a quit that the user has not confirmed goes to the frontend first,
            // because only the frontend knows whether the quit loses work. The export keeps
            // running while the frontend asks. A missing gate counts as confirmed, because
            // `confirm_quit` could then never set it and every quit would be refused. A
            // restart counts as confirmed too: Tauri ignores `prevent_exit` for it, so a
            // prevented restart would skip the export cancel below and still exit.
            let confirmed = code == Some(tauri::RESTART_EXIT_CODE)
                || handle
                    .try_state::<commands::quit::QuitGate>()
                    .is_none_or(|gate| gate.is_confirmed());
            if commands::quit::should_prevent_exit(confirmed, handle.webview_windows().len()) {
                match handle.emit(commands::quit::QUIT_REQUESTED_EVENT, ()) {
                    Ok(()) => {
                        api.prevent_exit();
                        return;
                    }
                    // An exit that nobody was asked about would never continue, so an event
                    // that cannot be sent lets the exit continue as ADR 017 describes.
                    Err(error) => eprintln!("quit: the quit request was not sent: {error}"),
                }
            }
            stop_export_before_exit(handle);
        }
        // After an `ExitRequested` that was not prevented, the export was already asked to
        // stop and the deadline is already set, so this call waits only for what remains of
        // the budget. An exit that passes through both handlers waits at most
        // `EXIT_CANCEL_BUDGET` in total.
        tauri::RunEvent::Exit => stop_export_before_exit(handle),
        _ => {}
    });
}

/// Stops a running export before the process ends, and waits until the exit deadline
/// (ADR 017).
///
/// This runs on the event loop thread and blocks it. The export never needs that thread to
/// stop: the worker is a thread of its own, it kills and reaps `ffmpeg` and deletes the
/// reserved file with plain system calls, and its progress events only queue a message for
/// the event loop, which does not wait for an answer. A start that is still preparing runs on
/// the async runtime and drops its slot there.
///
/// Every call shares the deadline of [`EXIT_WAIT`], which the first call sets to
/// `EXIT_CANCEL_BUDGET` from then. A second call therefore returns at once when the slot is
/// free, and otherwise waits only for what remains.
fn stop_export_before_exit(handle: &tauri::AppHandle) {
    let Some(registry) = handle.try_state::<Arc<ffmpeg::export::ExportRegistry>>() else {
        return;
    };
    if registry.active_run_id().is_some() {
        // The blocked event loop cannot draw, so a window left on screen would sit frozen for
        // up to the whole budget (ADR 027). The call runs on this thread, so the window hides
        // before the wait starts. A window that fails to hide changes nothing else.
        for window in handle.webview_windows().values() {
            let _ = window.hide();
        }
    }
    // The answer is not discarded. A wait that ran out leaves an `ffmpeg` child and a
    // reserved temporary file behind. That is the one outcome of this handler worth a line in
    // the log a user can send back with a report of an orphaned process or a stray file.
    if stop_export_within_deadline(&registry, &EXIT_WAIT, Instant::now(), EXIT_CANCEL_BUDGET) {
        eprintln!("quit: the export slot was still held after {EXIT_CANCEL_BUDGET:?}");
    }
}

/// Asks a running export to stop, and waits until the shared deadline of `wait`.
///
/// The first call sets the deadline to `now + budget`. A later call waits only for what
/// remains of it. Returns true when the wait ran out with the slot still held and no earlier
/// call has reported that, so the caller writes the log line once. It takes the registry and
/// the wait rather than a [`tauri::AppHandle`], so a test can call the same steps that
/// [`stop_export_before_exit`] runs.
#[must_use]
fn stop_export_within_deadline(
    registry: &ffmpeg::export::ExportRegistry,
    wait: &ExitWait,
    now: Instant,
    budget: Duration,
) -> bool {
    let deadline = wait.deadline(now, budget);
    !cancel_active_export(registry, deadline) && wait.take_report()
}

/// Ask a running export to stop, and wait, bounded, for it to release the export slot.
///
/// The slot going free is the signal that the worker has run its guards to completion: the
/// `ffmpeg` child has been killed and reaped and the reserved temporary file has been
/// deleted, because `ExportSlot` is dropped after both. Waiting on it is therefore waiting
/// for the cleanup, not merely for an acknowledgement.
///
/// This does not prevent the exit. It delays it until `deadline` at most, and reports whether
/// the slot was free by then. A deadline that has passed still asks the run to stop, and
/// looks at the slot once. It takes the registry rather than a [`tauri::AppHandle`] so it can
/// be tested at all: this crate does not enable tauri's `test` feature, and nothing that
/// takes an application handle is reachable from a test.
#[must_use]
fn cancel_active_export(registry: &ffmpeg::export::ExportRegistry, deadline: Instant) -> bool {
    let Some(run_id) = registry.active_run_id() else {
        return true;
    };
    registry.cancel(&run_id);

    loop {
        // The slot, not this run id: a worker that is already unwinding releases the slot,
        // and no export can claim it after this point, because the window in which the
        // frontend could start one is closing with the application.
        if registry.active_run_id().is_none() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(EXIT_CANCEL_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::export::ExportRegistry;

    #[test]
    fn an_exit_with_no_export_running_waits_for_nothing() {
        let registry = Arc::new(ExportRegistry::default());
        let started = Instant::now();

        assert!(cancel_active_export(
            &registry,
            Instant::now() + Duration::from_secs(5)
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn an_exit_cancels_the_running_export_and_returns_when_the_slot_is_released() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("run-1").expect("the slot starts free");
        let flag = slot.cancel_flag();

        // Stands for the export worker: it notices the flag on a poll and then drops its
        // slot, which is what releases the slot for this wait to observe.
        let worker = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(slot);
        });

        assert!(cancel_active_export(
            &registry,
            Instant::now() + Duration::from_secs(5)
        ));
        assert!(registry.active_run_id().is_none());
        worker.join().expect("the worker thread must not panic");
    }

    #[test]
    fn an_export_that_never_stops_does_not_hold_the_exit_past_the_budget() {
        let registry = Arc::new(ExportRegistry::default());
        // Held for the whole test: this stands for a worker that is wedged and never notices
        // the cancel, which is the case the budget exists for.
        let _slot = registry.begin("run-1").expect("the slot starts free");
        let started = Instant::now();

        assert!(!cancel_active_export(
            &registry,
            started + Duration::from_millis(200)
        ));

        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(200),
            "the wait must spend its budget before it gives up, took {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "the wait must not exceed its budget by much, took {elapsed:?}"
        );
    }

    #[test]
    fn a_deadline_that_has_passed_still_asks_the_run_to_stop_and_does_not_wait() {
        let registry = Arc::new(ExportRegistry::default());
        let slot = registry.begin("run-1").expect("the slot starts free");
        let started = Instant::now();

        assert!(!cancel_active_export(&registry, started));

        assert!(slot.is_canceled(), "the run must still be asked to stop");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(200),
            "a passed deadline must not wait, took {elapsed:?}"
        );
    }

    #[test]
    fn the_exit_deadline_is_set_once_and_shared_by_every_later_wait() {
        let wait = ExitWait::new();
        let first = Instant::now();
        let budget = Duration::from_secs(5);

        let deadline = wait.deadline(first, budget);
        assert_eq!(deadline, first + budget);

        // A later handler, a whole budget later, gets the same deadline and not a new one.
        assert_eq!(wait.deadline(first + budget, budget), deadline);
    }

    #[test]
    fn a_wait_that_ran_out_is_reported_once() {
        let wait = ExitWait::new();

        assert!(wait.take_report());
        assert!(!wait.take_report());
        assert!(!wait.take_report());
    }

    #[test]
    fn two_waits_on_a_wedged_export_spend_the_budget_once_and_log_once() {
        let registry = Arc::new(ExportRegistry::default());
        // Stands for a worker that never notices the cancel.
        let _slot = registry.begin("run-1").expect("the slot starts free");
        let wait = ExitWait::new();
        let budget = Duration::from_millis(400);

        // The confirmed `ExitRequested`: it spends the budget and reports the stuck slot.
        let first_started = Instant::now();
        assert!(stop_export_within_deadline(
            &registry,
            &wait,
            Instant::now(),
            budget
        ));
        let first = first_started.elapsed();
        assert!(
            first >= budget,
            "the first wait must spend the budget, took {first:?}"
        );

        // Then `Exit`: the deadline has passed, so it returns at once and does not log again.
        // Timed by itself, so a slow first wait on a loaded machine cannot fail this bound.
        let second_started = Instant::now();
        assert!(!stop_export_within_deadline(
            &registry,
            &wait,
            Instant::now(),
            budget
        ));
        let second = second_started.elapsed();
        assert!(
            second < budget / 2,
            "the second wait must not start a new budget, took {second:?}"
        );
    }

    #[test]
    fn a_wait_with_no_export_running_returns_at_once_and_logs_nothing() {
        let registry = Arc::new(ExportRegistry::default());
        let wait = ExitWait::new();
        let started = Instant::now();

        assert!(!stop_export_within_deadline(
            &registry,
            &wait,
            Instant::now(),
            Duration::from_secs(5)
        ));
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
