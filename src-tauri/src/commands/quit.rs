//! The quit confirmation of ADR 027.
//!
//! The frontend owns the decision whether a quit loses work, because only the frontend holds
//! the segments, the export status and the preset draft. Rust owns one bit: whether the user
//! confirmed the quit. The exit handler in `lib.rs` reads that bit through
//! [`should_prevent_exit`], and [`confirm_quit`] is the one place that sets it.
//!
//! The sequence is:
//!
//! 1. An application exit arrives as `RunEvent::ExitRequested` while a window is open and the
//!    quit is not confirmed. On macOS, `Cmd+Q` and the menu Quit raise it through the Quit
//!    item of `menu`. The handler calls `prevent_exit` and emits [`QUIT_REQUESTED_EVENT`].
//! 2. The frontend decides. When nothing would be lost, or when the user confirms its dialog,
//!    it calls [`confirm_quit`].
//! 3. [`confirm_quit`] sets the bit and calls `exit(0)`. That raises `ExitRequested` again. The
//!    quit is now confirmed, so the handler does not prevent it and runs the ADR 017 export
//!    cancel.
//!
//! A second exit request that arrives while the frontend shows its dialog emits the event
//! again. The frontend ignores a quit request while its quit dialog is open, so the event does
//! not stack a second dialog. Rust does not suppress the second event, because it cannot know
//! when the user cancels the dialog: a suppression would need a second command to clear it,
//! and a missed clear would refuse every later quit with no dialog at all.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};

/// The event that asks the frontend to run the quit decision. Its payload is empty.
///
/// `src/lib/ipc.ts` holds the same name in `BACKEND_EVENTS.QUIT_REQUESTED`, and
/// `src/lib/ipc.test.ts` reads this line to compare the two.
pub const QUIT_REQUESTED_EVENT: &str = "app:quit-requested";

/// Managed state: whether the user confirmed the quit, or the frontend found nothing to lose.
///
/// The bit only goes from false to true. Once it is set the application is exiting, and no
/// path clears it.
#[derive(Debug, Default)]
pub struct QuitGate {
    confirmed: AtomicBool,
}

impl QuitGate {
    /// Marks the quit as confirmed.
    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }

    /// True after [`QuitGate::confirm`].
    #[must_use]
    pub fn is_confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }
}

/// Whether the exit handler must prevent an exit and ask the frontend first.
///
/// It prevents the exit only when the quit is not confirmed and at least one web view window
/// is open. With no window open, nothing can answer the question, so a prevented exit would
/// never continue. That is the case when the last window closed without the frontend
/// listening, for example because its page never loaded.
#[must_use]
pub fn should_prevent_exit(confirmed: bool, window_count: usize) -> bool {
    !confirmed && window_count > 0
}

/// Confirms the quit and ends the application.
///
/// The frontend calls this when its quit decision allows the quit. `exit` only queues the
/// exit request for the event loop and returns, so the promise of the caller can resolve
/// before the application ends. The exit then raises `RunEvent::ExitRequested`, and the
/// handler in `lib.rs` cancels a running export and waits its bounded time (ADR 017).
#[tauri::command]
pub fn confirm_quit(app: AppHandle, gate: State<'_, QuitGate>) {
    // The bit is set before the exit request, so the `ExitRequested` that the request raises
    // on the event loop thread always reads it as set.
    gate.confirm();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unconfirmed_exit_with_a_window_open_is_prevented() {
        assert!(should_prevent_exit(false, 1));
        assert!(should_prevent_exit(false, 2));
    }

    #[test]
    fn a_confirmed_exit_is_never_prevented() {
        assert!(!should_prevent_exit(true, 1));
        assert!(!should_prevent_exit(true, 0));
    }

    #[test]
    fn an_exit_with_no_window_open_is_never_prevented() {
        // Nothing could answer the question, so a prevented exit would never continue.
        assert!(!should_prevent_exit(false, 0));
    }

    #[test]
    fn the_gate_starts_unconfirmed_and_stays_confirmed() {
        let gate = QuitGate::default();
        assert!(!gate.is_confirmed());

        gate.confirm();
        assert!(gate.is_confirmed());

        // A second confirmation, for example from a second dialog answer, changes nothing.
        gate.confirm();
        assert!(gate.is_confirmed());
    }
}
