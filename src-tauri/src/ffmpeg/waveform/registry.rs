//! The one slot of the envelope jobs (ADR 056).
//!
//! One job runs at a time in the application. A request carries the time of its page in
//! microseconds since the Unix epoch, as the preview windows do (ADR 046). A page load sets a
//! floor at its own time and cancels the running job, so a late request of the old page can
//! neither start a job nor keep the slot. The exit closes the registry.

use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// One running job: its cancel flag and its processes.
#[derive(Debug)]
pub struct JobHandle {
    pub id: u64,
    cancel: Arc<AtomicBool>,
    children: Mutex<Vec<Arc<Mutex<Child>>>>,
}

impl JobHandle {
    fn new(id: u64) -> Self {
        Self {
            id,
            cancel: Arc::new(AtomicBool::new(false)),
            children: Mutex::new(Vec::new()),
        }
    }

    /// The cancel flag, for a reader that checks it between its reads.
    #[must_use]
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Keep `child`, so that [`JobHandle::signal`] ends it. A process that starts after a cancel
    /// gets the kill at once.
    pub fn adopt(&self, child: Arc<Mutex<Child>>) {
        self.children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(child.clone());
        if self.is_canceled() {
            let _ = child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .kill();
        }
    }

    /// Forget `child` after the job reaped it, so a job of many runs keeps no handle of an
    /// ended process.
    pub fn release(&self, child: &Arc<Mutex<Child>>) {
        self.children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|kept| !Arc::ptr_eq(kept, child));
    }

    /// Cancel the job and send the kill to its processes without waiting for them. The job reaps
    /// them, so a process that waits for a share delays neither a cancel nor an exit.
    pub fn signal(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let children = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for child in children {
            let _ = child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .kill();
        }
    }
}

/// Why a request cannot start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another job runs.
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
    running: Option<Arc<JobHandle>>,
}

/// The registry of the envelope jobs, managed by Tauri.
#[derive(Default)]
pub struct WaveformJobs {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

impl WaveformJobs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn check(inner: &Inner, sequence: u64) -> Result<(), Refusal> {
        if inner.closed {
            Err(Refusal::Closed)
        } else if sequence < inner.floor {
            Err(Refusal::Superseded)
        } else {
            Ok(())
        }
    }

    /// Accept a request that takes no slot, as a cache hit does.
    pub fn admit(&self, sequence: u64) -> Result<(), Refusal> {
        Self::check(&self.lock(), sequence)
    }

    /// Take the slot for a new job.
    pub fn begin(&self, sequence: u64) -> Result<Arc<JobHandle>, Refusal> {
        let mut inner = self.lock();
        Self::check(&inner, sequence)?;
        if inner.running.is_some() {
            return Err(Refusal::Busy);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let handle = Arc::new(JobHandle::new(id));
        inner.running = Some(handle.clone());
        Ok(handle)
    }

    /// Free the slot of job `id`, when it still holds it.
    pub fn finish(&self, id: u64) {
        let mut inner = self.lock();
        if inner.running.as_ref().is_some_and(|handle| handle.id == id) {
            inner.running = None;
        }
    }

    /// Cancel job `id`, when it runs. The job frees the slot when it ends.
    pub fn cancel(&self, id: u64) {
        let running = self.lock().running.clone();
        if let Some(handle) = running.filter(|handle| handle.id == id) {
            handle.signal();
        }
    }

    /// A page load: refuse every request below `floor` and cancel the running job.
    pub fn cancel_all(&self, floor: u64) {
        let running = {
            let mut inner = self.lock();
            inner.floor = inner.floor.max(floor);
            inner.running.clone()
        };
        if let Some(handle) = running {
            handle.signal();
        }
    }

    /// The exit: refuse every later request and cancel the running job, with no wait.
    pub fn close_for_exit(&self) {
        let running = {
            let mut inner = self.lock();
            inner.closed = true;
            inner.running.clone()
        };
        if let Some(handle) = running {
            handle.signal();
        }
    }

    /// The id of the running job.
    #[must_use]
    pub fn running(&self) -> Option<u64> {
        self.lock().running.as_ref().map(|handle| handle.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_job_runs_at_a_time() {
        let jobs = WaveformJobs::default();
        let first = jobs.begin(10).unwrap();
        assert_eq!(jobs.begin(11).unwrap_err(), Refusal::Busy);
        assert_eq!(jobs.running(), Some(first.id));
        jobs.finish(first.id);
        assert_eq!(jobs.running(), None);
        let second = jobs.begin(12).unwrap();
        assert_ne!(second.id, first.id);
    }

    #[test]
    fn a_stale_finish_does_not_free_the_slot_of_another_job() {
        let jobs = WaveformJobs::default();
        let first = jobs.begin(10).unwrap();
        jobs.finish(first.id);
        let second = jobs.begin(11).unwrap();
        jobs.finish(first.id);
        assert_eq!(jobs.running(), Some(second.id));
    }

    #[test]
    fn a_cancel_signals_only_the_named_job() {
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(10).unwrap();
        jobs.cancel(handle.id + 1);
        assert!(!handle.is_canceled());
        jobs.cancel(handle.id);
        assert!(handle.is_canceled());
        // The slot stays taken until the job ends.
        assert_eq!(jobs.running(), Some(handle.id));
    }

    #[test]
    fn a_page_load_sets_a_floor_and_cancels_the_running_job() {
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(10).unwrap();
        jobs.cancel_all(100);
        assert!(handle.is_canceled());
        jobs.finish(handle.id);
        assert_eq!(jobs.begin(99).unwrap_err(), Refusal::Superseded);
        assert_eq!(jobs.admit(99), Err(Refusal::Superseded));
        assert_eq!(jobs.admit(100), Ok(()));
        // An older floor does not lower the floor.
        jobs.cancel_all(50);
        assert_eq!(jobs.begin(99).unwrap_err(), Refusal::Superseded);
        assert!(jobs.begin(100).is_ok());
    }

    #[test]
    fn the_exit_refuses_every_later_request() {
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(10).unwrap();
        jobs.close_for_exit();
        assert!(handle.is_canceled());
        jobs.finish(handle.id);
        assert_eq!(jobs.begin(u64::MAX).unwrap_err(), Refusal::Closed);
        assert_eq!(jobs.admit(u64::MAX), Err(Refusal::Closed));
    }

    #[test]
    fn a_process_adopted_after_a_cancel_gets_the_kill() {
        let jobs = WaveformJobs::default();
        let handle = jobs.begin(10).unwrap();
        handle.signal();
        let program = if cfg!(windows) { "cmd" } else { "sh" };
        let arguments: &[&str] = if cfg!(windows) {
            &["/c", "ping -n 30 127.0.0.1 >NUL"]
        } else {
            &["-c", "sleep 30"]
        };
        let child = crate::procutil::command_without_console(program)
            .args(arguments)
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        handle.adopt(child.clone());
        let status = child.lock().unwrap().wait().unwrap();
        assert!(!status.success());
    }
}
