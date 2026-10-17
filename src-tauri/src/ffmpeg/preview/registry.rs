//! The running remux windows: one for each lane, replaced by each newer request (ADR 046).
//!
//! A request takes a ticket for its lane. The ticket kills the window that runs on that lane,
//! because the page asked for another part of the file and the old data is of no use. A request
//! starts its processes only while its ticket is still the latest, so a slow locate never
//! replaces the window of a newer request. The page names a window by its id to acknowledge its
//! bytes and to close it, so a close that races with the next open never kills the newer one.

use crate::ffmpeg::capabilities::smoke::kill_and_reap;
use crate::flv::cache::{evict, Revision, SourceCache, KEEP_SOURCES};
use crate::flv::FlvSource;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// The two lanes of a preview. The video lane carries the remux windows, and on FLV also the PCM
/// of their audio. The audio lane carries the PCM windows of a container that FFmpeg seeks in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Lane {
    Video,
    Audio,
}

/// The most bytes of one window that the page may hold without an acknowledgement.
pub const CREDIT_LIMIT: u64 = 8 * 1024 * 1024;
/// The FLV sources that the registry keeps open.
const KEPT_SOURCES: usize = 4;

/// The bytes that a window sent and the page did not acknowledge yet. The reader of the stdout of
/// FFmpeg waits while there are more than [`CREDIT_LIMIT`], so FFmpeg stops, the stdin writer
/// stops, and the reads of the source stop. The Tauri channel has no limit of its own.
#[derive(Default)]
pub struct Credit {
    state: Mutex<CreditState>,
    changed: Condvar,
}

#[derive(Default)]
struct CreditState {
    in_flight: u64,
    closed: bool,
}

impl Credit {
    fn lock(&self) -> MutexGuard<'_, CreditState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Wait until fewer than `limit` bytes are in flight, then count `bytes` more. Return false
    /// when the window closed meanwhile.
    pub fn reserve(&self, bytes: u64, limit: u64) -> bool {
        let mut state = self.lock();
        while state.in_flight >= limit && !state.closed {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        if state.closed {
            return false;
        }
        state.in_flight += bytes;
        true
    }

    /// Count `bytes` as acknowledged.
    pub fn release(&self, bytes: u64) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_sub(bytes);
        self.changed.notify_all();
    }

    /// Wake every waiter for good.
    pub fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }
}

/// One running window: its processes, its cancel flag and its credit.
pub struct WindowHandle {
    pub id: u64,
    pub lane: Lane,
    pub cancel: Arc<AtomicBool>,
    pub credit: Credit,
    children: Mutex<Vec<Arc<Mutex<Child>>>>,
}

impl WindowHandle {
    pub fn new(id: u64, lane: Lane, cancel: Arc<AtomicBool>) -> Self {
        Self {
            id,
            lane,
            cancel,
            credit: Credit::default(),
            children: Mutex::new(Vec::new()),
        }
    }

    /// Keep `child`, so that [`WindowHandle::kill`] ends it. A window that a newer request
    /// already killed kills the child at once, so a process that starts after the kill never
    /// runs on.
    pub fn adopt(&self, child: Arc<Mutex<Child>>) {
        self.children
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(child.clone());
        if self.is_canceled() {
            let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
            if let Err(error) = kill_and_reap(&mut child) {
                eprintln!("preview: a window process did not end: {error}");
            }
        }
    }

    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Cancel the window and kill and reap its processes. The threads of the window end on
    /// their own: a reader at the end of a closed pipe, and a writer at its next write or its
    /// next check of the flag. Nothing here joins a writer that waits for a read of a share.
    pub fn kill(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.credit.close();
        for child in self.children() {
            let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
            if let Err(error) = kill_and_reap(&mut child) {
                eprintln!("preview: a window process did not end: {error}");
            }
        }
    }

    /// Cancel the window and send the kill to its processes without waiting for them. The
    /// readers of the window reap them. An exit and a reload of the page use this, so a process
    /// that waits for a share delays neither.
    pub fn signal(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.credit.close();
        for child in self.children() {
            let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
            let _ = child.kill();
        }
    }

    fn children(&self) -> Vec<Arc<Mutex<Child>>> {
        self.children
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

/// A claim on a lane, taken when a request arrives.
#[derive(Debug, Clone)]
pub struct Ticket {
    pub lane: Lane,
    pub generation: u64,
    /// Set when a newer request takes the lane, so the locate of this one stops.
    pub cancel: Arc<AtomicBool>,
}

/// Why a request cannot start its window.
#[derive(Debug, PartialEq, Eq)]
pub struct Superseded;

#[derive(Default)]
struct LaneState {
    generation: u64,
    /// The highest request sequence of the page that took the lane. A request with a lower one
    /// comes from before a newer request, however late it arrives.
    sequence: u64,
    ticket_cancel: Option<Arc<AtomicBool>>,
    active: Option<u64>,
}

struct OpenSource {
    key: String,
    source: Arc<FlvSource>,
    cache: Arc<SourceCache>,
}

#[derive(Default)]
struct Inner {
    /// True after the exit stopped every window: no request starts one again.
    closed: bool,
    lanes: HashMap<Lane, LaneState>,
    windows: HashMap<u64, Arc<WindowHandle>>,
    sources: Vec<OpenSource>,
    ffmpeg: Option<(Option<PathBuf>, PathBuf)>,
}

/// The registry of the preview windows, managed by Tauri.
#[derive(Default)]
pub struct PreviewWindows {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

impl PreviewWindows {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Take the lane for the request with the page sequence `sequence`: cancel the locate of the
    /// older request and kill the window that runs on the lane. Return `None`, and change
    /// nothing, when the page already sent a newer request for the lane. Each request runs on its
    /// own thread, so a request that waited for a slow share can arrive after a newer one.
    pub fn begin(&self, lane: Lane, sequence: u64) -> Option<Ticket> {
        let (ticket, old) = {
            let mut inner = self.lock();
            if inner.closed {
                return None;
            }
            let state = inner.lanes.entry(lane).or_default();
            if sequence < state.sequence {
                return None;
            }
            state.sequence = sequence;
            state.generation += 1;
            if let Some(cancel) = state.ticket_cancel.take() {
                cancel.store(true, Ordering::SeqCst);
            }
            let cancel = Arc::new(AtomicBool::new(false));
            state.ticket_cancel = Some(cancel.clone());
            let ticket = Ticket {
                lane,
                generation: state.generation,
                cancel,
            };
            let old = state.active.take();
            let old = old.and_then(|id| inner.windows.remove(&id));
            (ticket, old)
        };
        // The readers of the old window reap its processes, so this request does not wait for a
        // process that hangs in a read of a share.
        if let Some(old) = old {
            old.signal();
        }
        Some(ticket)
    }

    /// True while `ticket` is the latest request of its lane.
    pub fn is_current(&self, ticket: &Ticket) -> bool {
        self.lock()
            .lanes
            .get(&ticket.lane)
            .is_some_and(|state| state.generation == ticket.generation)
    }

    /// A new window id.
    pub fn next_window_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Make `window` the window of its lane, or refuse it when a newer request took the lane
    /// meanwhile. The caller kills a refused window.
    pub fn activate(&self, ticket: &Ticket, window: Arc<WindowHandle>) -> Result<(), Superseded> {
        let mut inner = self.lock();
        let state = inner.lanes.entry(ticket.lane).or_default();
        if state.generation != ticket.generation {
            return Err(Superseded);
        }
        state.active = Some(window.id);
        inner.windows.insert(window.id, window);
        Ok(())
    }

    /// Count `bytes` of window `id` as acknowledged by the page.
    pub fn acknowledge(&self, id: u64, bytes: u64) {
        let window = self.lock().windows.get(&id).cloned();
        if let Some(window) = window {
            window.credit.release(bytes);
        }
    }

    /// Kill window `id`, when it still runs. A newer window of the same lane stays.
    pub fn close(&self, id: u64) {
        let window = {
            let mut inner = self.lock();
            let window = inner.windows.remove(&id);
            if let Some(window) = &window {
                if let Some(state) = inner.lanes.get_mut(&window.lane) {
                    if state.active == Some(id) {
                        state.active = None;
                    }
                }
            }
            window
        };
        if let Some(window) = window {
            window.signal();
        }
    }

    /// Free the lane of window `id` when its remux output ended, so the next request does not
    /// kill the PCM process that may still decode the last part of the window. The window stays
    /// known, so a close or an exit still reaches that process.
    pub fn release(&self, id: u64) {
        let mut inner = self.lock();
        let lane = inner.windows.get(&id).map(|window| window.lane);
        if let Some(state) = lane.and_then(|lane| inner.lanes.get_mut(&lane)) {
            if state.active == Some(id) {
                state.active = None;
            }
        }
    }

    /// Forget window `id`, which ended on its own.
    pub fn finish(&self, id: u64) {
        let mut inner = self.lock();
        if let Some(window) = inner.windows.remove(&id) {
            if let Some(state) = inner.lanes.get_mut(&window.lane) {
                if state.active == Some(id) {
                    state.active = None;
                }
            }
        }
    }

    /// Stop every window for a new page in the main window. A window writes no file, so nothing
    /// waits for its processes here: the kill is sent, and the readers reap. `sequence_floor`
    /// becomes the lowest sequence that each lane takes: the page numbers its requests from the
    /// clock (microseconds since the Unix epoch), so a late request of the old page falls below
    /// the floor and starts nothing, and every request of the new page lies above it.
    pub fn cancel_all(&self, sequence_floor: u64) {
        self.stop_all(Some(sequence_floor), false);
    }

    /// Stop every window for an application exit (ADR 017 amendment), and refuse every later
    /// request.
    pub fn close_for_exit(&self) {
        self.stop_all(None, true);
    }

    fn stop_all(&self, sequence_floor: Option<u64>, close: bool) {
        let windows: Vec<Arc<WindowHandle>> = {
            let mut inner = self.lock();
            inner.closed |= close;
            for lane in [Lane::Video, Lane::Audio] {
                inner.lanes.entry(lane).or_default();
            }
            for state in inner.lanes.values_mut() {
                state.generation += 1;
                if let Some(floor) = sequence_floor {
                    state.sequence = state.sequence.max(floor);
                }
                state.active = None;
                if let Some(cancel) = state.ticket_cancel.take() {
                    cancel.store(true, Ordering::SeqCst);
                }
            }
            inner.windows.drain().map(|(_, window)| window).collect()
        };
        for window in windows {
            window.signal();
        }
    }

    /// The ffmpeg executable for the configured path, found once for each configured path.
    pub fn ffmpeg<F>(&self, configured: Option<PathBuf>, discover: F) -> Option<PathBuf>
    where
        F: FnOnce(Option<&Path>) -> Option<PathBuf>,
    {
        if let Some((cached_for, path)) = &self.lock().ffmpeg {
            if *cached_for == configured && path.is_file() {
                return Some(path.clone());
            }
        }
        let found = discover(configured.as_deref())?;
        self.lock().ffmpeg = Some((configured, found.clone()));
        Some(found)
    }

    /// The open FLV source of `revision`, with its cache directory. A source that is not open
    /// yet opens, and takes what its sidecar holds.
    pub fn flv_source(
        &self,
        app_data: &Path,
        revision: Revision,
        path: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<(Arc<FlvSource>, Arc<SourceCache>), crate::flv::FlvError> {
        let key = revision.key();
        {
            let mut inner = self.lock();
            if let Some(position) = inner.sources.iter().position(|open| open.key == key) {
                let open = inner.sources.remove(position);
                let found = (open.source.clone(), open.cache.clone());
                inner.sources.push(open);
                return Ok(found);
            }
        }
        let source = Arc::new(FlvSource::open(path, cancel)?);
        let cache = Arc::new(SourceCache::new(app_data, revision));
        if let Some((table, non_monotonic)) = cache.load_table() {
            source.restore(&table, non_monotonic);
        }
        let in_use: Vec<String> = {
            let mut inner = self.lock();
            // Two requests can open the same source at once. The first one in the list wins,
            // so both windows record into one table.
            if let Some(open) = inner.sources.iter().find(|open| open.key == key) {
                return Ok((open.source.clone(), open.cache.clone()));
            }
            inner.sources.push(OpenSource {
                key: key.clone(),
                source: source.clone(),
                cache: cache.clone(),
            });
            if inner.sources.len() > KEPT_SOURCES {
                inner.sources.remove(0);
            }
            inner.sources.iter().map(|open| open.key.clone()).collect()
        };
        if let Err(error) = evict(app_data, KEEP_SOURCES, &in_use) {
            eprintln!("preview: the FLV cache was not trimmed: {error}");
        }
        Ok((source, cache))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_new_ticket_supersedes_the_older_one_and_cancels_its_locate() {
        let windows = PreviewWindows::default();
        let first = windows.begin(Lane::Video, 0).unwrap();
        let second = windows.begin(Lane::Video, 0).unwrap();
        assert!(first.cancel.load(Ordering::SeqCst));
        assert!(!windows.is_current(&first));
        assert!(windows.is_current(&second));
        let handle = Arc::new(WindowHandle::new(1, Lane::Video, first.cancel.clone()));
        assert_eq!(windows.activate(&first, handle), Err(Superseded));
        let handle = Arc::new(WindowHandle::new(2, Lane::Video, second.cancel.clone()));
        assert_eq!(windows.activate(&second, handle), Ok(()));
        // The other lane is separate.
        let audio = windows.begin(Lane::Audio, 0).unwrap();
        assert!(windows.is_current(&second));
        assert!(windows.is_current(&audio));
    }

    #[test]
    fn a_request_with_a_lower_sequence_changes_nothing() {
        let windows = PreviewWindows::default();
        let newer = windows.begin(Lane::Video, 5).unwrap();
        let handle = Arc::new(WindowHandle::new(1, Lane::Video, newer.cancel.clone()));
        windows.activate(&newer, handle.clone()).unwrap();
        assert!(windows.begin(Lane::Video, 4).is_none());
        assert!(!handle.is_canceled());
        assert!(windows.is_current(&newer));
        // A reload sets the floor: a late request of the old page starts nothing, on either lane.
        windows.cancel_all(1_000);
        assert!(handle.is_canceled());
        assert!(windows.begin(Lane::Video, 6).is_none());
        assert!(windows.begin(Lane::Audio, 999).is_none());
        assert!(windows.begin(Lane::Video, 1_001).is_some());
        // After the exit nothing starts.
        windows.close_for_exit();
        assert!(windows.begin(Lane::Video, u64::MAX).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_process_adopted_after_the_kill_is_killed_at_once() {
        let handle = WindowHandle::new(1, Lane::Video, Arc::new(AtomicBool::new(false)));
        handle.kill();
        let child = crate::procutil::command_without_console("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        handle.adopt(child.clone());
        let status = child.lock().unwrap().try_wait().unwrap();
        assert!(status.is_some(), "the late process still runs");
    }

    #[test]
    fn a_new_ticket_kills_the_window_of_its_lane() {
        let windows = PreviewWindows::default();
        let ticket = windows.begin(Lane::Video, 0).unwrap();
        let handle = Arc::new(WindowHandle::new(7, Lane::Video, ticket.cancel.clone()));
        windows.activate(&ticket, handle.clone()).unwrap();
        windows.begin(Lane::Video, 0).unwrap();
        assert!(handle.is_canceled());
    }

    #[test]
    fn a_released_lane_lets_the_next_request_in_without_killing_the_window() {
        let windows = PreviewWindows::default();
        let first = windows.begin(Lane::Video, 1).unwrap();
        let handle = Arc::new(WindowHandle::new(
            1,
            Lane::Video,
            Arc::new(AtomicBool::new(false)),
        ));
        windows.activate(&first, handle.clone()).unwrap();
        windows.release(1);
        windows.begin(Lane::Video, 2).unwrap();
        assert!(!handle.is_canceled());
        // A close still reaches it.
        windows.close(1);
        assert!(handle.is_canceled());
    }

    #[test]
    fn a_close_by_id_kills_only_that_window() {
        let windows = PreviewWindows::default();
        let first = windows.begin(Lane::Video, 0).unwrap();
        let old = Arc::new(WindowHandle::new(1, Lane::Video, first.cancel.clone()));
        windows.activate(&first, old.clone()).unwrap();
        let second = windows.begin(Lane::Video, 0).unwrap();
        let new = Arc::new(WindowHandle::new(2, Lane::Video, second.cancel.clone()));
        windows.activate(&second, new.clone()).unwrap();
        // The page closes the old window after the new one started: the new one stays.
        windows.close(1);
        assert!(!new.is_canceled());
        windows.close(2);
        assert!(new.is_canceled());
    }

    #[test]
    fn the_exit_kills_every_window_and_every_pending_request() {
        let windows = PreviewWindows::default();
        let video = windows.begin(Lane::Video, 0).unwrap();
        let handle = Arc::new(WindowHandle::new(1, Lane::Video, video.cancel.clone()));
        windows.activate(&video, handle.clone()).unwrap();
        let audio = windows.begin(Lane::Audio, 0).unwrap();
        windows.close_for_exit();
        assert!(handle.is_canceled());
        assert!(audio.cancel.load(Ordering::SeqCst));
        assert!(!windows.is_current(&audio));
    }

    #[test]
    fn the_credit_blocks_above_its_limit_until_an_acknowledgement_or_a_close() {
        let credit = Arc::new(Credit::default());
        assert!(credit.reserve(100, 150));
        assert!(credit.reserve(100, 150));
        let waiter = {
            let credit = credit.clone();
            std::thread::spawn(move || credit.reserve(10, 150))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!waiter.is_finished());
        credit.release(100);
        assert!(waiter.join().unwrap());

        assert!(credit.reserve(1000, 150));
        let blocked = {
            let credit = credit.clone();
            std::thread::spawn(move || credit.reserve(10, 150))
        };
        std::thread::sleep(Duration::from_millis(50));
        credit.close();
        assert!(!blocked.join().unwrap());
    }

    #[test]
    fn the_ffmpeg_path_is_found_once_for_each_configured_path() {
        let windows = PreviewWindows::default();
        let dir = crate::flv::test_support::TestDirectory::new();
        let binary = dir.path.join("ffmpeg");
        std::fs::write(&binary, b"").unwrap();
        let calls = std::cell::Cell::new(0);
        let find = |_: Option<&Path>| {
            calls.set(calls.get() + 1);
            Some(binary.clone())
        };
        assert_eq!(windows.ffmpeg(None, find), Some(binary.clone()));
        assert_eq!(windows.ffmpeg(None, find), Some(binary.clone()));
        assert_eq!(calls.get(), 1);
        let other = Some(PathBuf::from("/other/ffmpeg"));
        windows.ffmpeg(other, find);
        assert_eq!(calls.get(), 2);
    }
}
