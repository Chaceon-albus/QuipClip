pub mod commands;
pub mod ffmpeg;
pub mod fsutil;
pub mod project;
pub mod settings;
pub mod time;

use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The one export slot for the whole application (ADR 016). `ExportRegistry::begin`
        // takes `self: &Arc<Self>`, because the `ExportSlot` it hands out owns a reference to
        // the registry and outlives the command that claimed it, so the managed value is the
        // `Arc` itself rather than the registry.
        .manage(Arc::new(ffmpeg::export::ExportRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            commands::capabilities::start_capability_probe,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::export::cancel_active_export,
            commands::media::import_media,
            commands::project::load_project,
            commands::project::save_project,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::restore_default_presets,
            commands::settings::reset_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Built rather than run, for the exit event alone. The export worker is a detached
    // thread, so when `main` returns nothing unwinds it: neither the guard that kills and
    // reaps `ffmpeg` nor the guard that deletes the reserved temporary file runs. The child
    // is then reparented and keeps encoding gigabytes into a file that is never renamed and
    // never removed. `ExitRequested` is the event to act on, and not `Exit`: on some
    // platforms `Exit` arrives too late to do anything with.
    application.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(registry) = handle.try_state::<Arc<ffmpeg::export::ExportRegistry>>() {
                // The answer is not discarded. `false` means the budget was spent and the run
                // still holds the slot, so the exit below leaves an `ffmpeg` child and a
                // reserved temporary file behind. That is the one outcome of this handler
                // worth a line in the log a user can send back with a report of an orphaned
                // process or a stray file.
                if !cancel_active_export(&registry, EXIT_CANCEL_BUDGET) {
                    eprintln!("quit: the export slot was still held after {EXIT_CANCEL_BUDGET:?}");
                }
            }
        }
    });
}

/// Ask a running export to stop, and wait, bounded, for it to release the export slot.
///
/// The slot going free is the signal that the worker has run its guards to completion: the
/// `ffmpeg` child has been killed and reaped and the reserved temporary file has been
/// deleted, because `ExportSlot` is dropped after both. Waiting on it is therefore waiting
/// for the cleanup, not merely for an acknowledgement.
///
/// This does not prevent the exit. It delays it by at most `budget`, and reports whether the
/// slot was free by then. It takes the registry rather than a [`tauri::AppHandle`] so it can
/// be tested at all: this crate does not enable tauri's `test` feature, and nothing that
/// takes an application handle is reachable from a test.
#[must_use]
fn cancel_active_export(registry: &ffmpeg::export::ExportRegistry, budget: Duration) -> bool {
    let Some(run_id) = registry.active_run_id() else {
        return true;
    };
    registry.cancel(&run_id);

    let deadline = Instant::now() + budget;
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

        assert!(cancel_active_export(&registry, Duration::from_secs(5)));
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

        assert!(cancel_active_export(&registry, Duration::from_secs(5)));
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

        assert!(!cancel_active_export(&registry, Duration::from_millis(200)));

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
}
