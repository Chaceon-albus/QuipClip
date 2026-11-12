//! The one slot of the install of `ffmpeg` (ADR 059).
//!
//! One install runs at a time in the application. A request carries the time of the request in
//! microseconds since the Unix epoch, which rises with each request of a page, as the requests of
//! the envelope jobs do (ADR 056). A page load of the Settings window sets a floor at its own
//! time and cancels the running install, so a late request of the old page can neither start an
//! install nor keep the slot. A close of that window cancels the install too. The exit closes the
//! registry and does not wait (ADR 059, "Cancel and exit").

use super::download::Cancel;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// One running install: its id and its cancel.
#[derive(Debug)]
pub struct InstallHandle {
    pub id: u64,
    cancel: Arc<Cancel>,
}

impl InstallHandle {
    /// The cancel of the install, which the job passes to each step.
    #[must_use]
    pub fn cancel(&self) -> &Cancel {
        &self.cancel
    }
}

/// Why a request cannot start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another install runs.
    Busy,
    /// The request comes from a page before the last page load.
    Superseded,
    /// The application exits.
    Closed,
}

#[derive(Default)]
struct Inner {
    closed: bool,
    floor: u64,
    running: Option<Arc<InstallHandle>>,
}

/// The registry of the install, managed by Tauri.
#[derive(Default)]
pub struct InstallJobs {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

impl InstallJobs {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Take the slot for a new install.
    pub fn begin(&self, sequence: u64) -> Result<Arc<InstallHandle>, Refusal> {
        let mut inner = self.lock();
        if inner.closed {
            return Err(Refusal::Closed);
        }
        if sequence < inner.floor {
            return Err(Refusal::Superseded);
        }
        if inner.running.is_some() {
            return Err(Refusal::Busy);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = Arc::new(InstallHandle {
            id,
            cancel: Arc::new(Cancel::new()),
        });
        inner.running = Some(handle.clone());
        Ok(handle)
    }

    /// Free the slot of install `id`, when it still holds it.
    pub fn finish(&self, id: u64) {
        let mut inner = self.lock();
        if inner.running.as_ref().is_some_and(|handle| handle.id == id) {
            inner.running = None;
        }
    }

    /// Cancel install `id`, when it runs. The install frees the slot when it ends.
    pub fn cancel(&self, id: u64) {
        let running = self.lock().running.clone();
        if let Some(handle) = running.filter(|handle| handle.id == id) {
            handle.cancel.cancel();
        }
    }

    /// A page load or a close of the Settings window: refuse every request below `floor` and
    /// cancel the running install.
    pub fn cancel_all(&self, floor: u64) {
        let running = {
            let mut inner = self.lock();
            inner.floor = inner.floor.max(floor);
            inner.running.clone()
        };
        if let Some(handle) = running {
            handle.cancel.cancel();
        }
    }

    /// The exit: refuse every later request and cancel the running install, with no wait.
    pub fn close_for_exit(&self) {
        let running = {
            let mut inner = self.lock();
            inner.closed = true;
            inner.running.clone()
        };
        if let Some(handle) = running {
            handle.cancel.cancel();
        }
    }

    /// The id of the running install.
    #[must_use]
    pub fn running(&self) -> Option<u64> {
        self.lock().running.as_ref().map(|handle| handle.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_install_runs_at_a_time() {
        let jobs = InstallJobs::default();
        let first = jobs.begin(1).unwrap();
        assert_eq!(jobs.begin(2).unwrap_err(), Refusal::Busy);
        assert_eq!(jobs.running(), Some(first.id));
        jobs.finish(first.id);
        assert_eq!(jobs.running(), None);
        let second = jobs.begin(2).unwrap();
        assert_ne!(second.id, first.id);
    }

    #[test]
    fn a_cancel_names_the_install_that_it_cancels() {
        let jobs = InstallJobs::default();
        let handle = jobs.begin(1).unwrap();
        jobs.cancel(handle.id + 1);
        assert!(!handle.cancel().is_canceled());
        jobs.cancel(handle.id);
        assert!(handle.cancel().is_canceled());
        // The slot stays taken until the install ends.
        assert_eq!(jobs.begin(2).unwrap_err(), Refusal::Busy);
    }

    #[test]
    fn a_finish_of_an_older_install_keeps_the_slot_of_the_new_one() {
        let jobs = InstallJobs::default();
        let first = jobs.begin(1).unwrap();
        jobs.finish(first.id);
        let second = jobs.begin(1).unwrap();
        jobs.finish(first.id);
        assert_eq!(jobs.running(), Some(second.id));
    }

    #[test]
    fn a_page_load_cancels_the_install_and_refuses_the_old_page() {
        let jobs = InstallJobs::default();
        let handle = jobs.begin(10).unwrap();
        jobs.cancel_all(20);
        assert!(handle.cancel().is_canceled());
        jobs.finish(handle.id);
        assert_eq!(jobs.begin(15).unwrap_err(), Refusal::Superseded);
        assert!(jobs.begin(20).is_ok());
        // A later floor below the first one does not lower it.
        jobs.cancel_all(5);
        jobs.finish(jobs.running().unwrap());
        assert_eq!(jobs.begin(15).unwrap_err(), Refusal::Superseded);
    }

    #[test]
    fn the_exit_cancels_the_install_and_refuses_every_request() {
        let jobs = InstallJobs::default();
        let handle = jobs.begin(1).unwrap();
        jobs.close_for_exit();
        assert!(handle.cancel().is_canceled());
        jobs.finish(handle.id);
        assert_eq!(jobs.begin(u64::MAX).unwrap_err(), Refusal::Closed);
    }
}
