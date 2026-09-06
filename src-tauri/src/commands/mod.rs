//! Tauri command surface.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod capabilities;
pub mod export;
pub mod media;
pub mod project;
pub mod settings;

/// A per-process counter that, combined with the current time, makes each run id unique
/// without a uuid dependency.
static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Build a run id unique within this process: epoch milliseconds, then a monotonic counter
/// to break ties between two runs started within the same millisecond. No uuid dependency
/// is available, and none is needed for an id that only has to be unique within one running
/// application.
///
/// This lives here, and not in one command module, because the export command that comes
/// next must derive its `run_id` from the same generator: `ffmpeg::export::registry` keys
/// every staleness check on string equality of `run_id`, so a second scheme that can repeat
/// would defeat those checks. One counter for the whole process is what makes two runs
/// started in the same millisecond differ.
pub(crate) fn next_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sequence = RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read the counter field back out of an id, so the test observes the published format
    /// rather than `RUN_ID_COUNTER` itself: a change that stopped putting the counter in the
    /// id would still keep the static advancing, and reading the static directly would not
    /// notice.
    fn sequence_of(id: &str) -> u64 {
        let (_, sequence) = id.split_once('-').expect("the id must carry a separator");
        sequence
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("id was {id}"))
    }

    #[test]
    fn next_run_id_is_unique_across_calls() {
        let first = next_run_id();
        let second = next_run_id();

        assert_ne!(first, second);
        // The property `ffmpeg::export::registry` depends on is narrower than `assert_ne!`
        // above: two runs started inside ONE millisecond must still differ, which only the
        // counter can deliver. Without this, replacing `fetch_add` with `load` would leave
        // the test passing on the millisecond field alone.
        //
        // Compare with `>`, never with `+ 1`. `RUN_ID_COUNTER` is process-global and the
        // tests in this binary run concurrently, so a neighbouring test can consume a
        // sequence value between these two calls; an exact-successor assertion would fail
        // intermittently.
        assert!(
            sequence_of(&second) > sequence_of(&first),
            "the counter must advance: {first} then {second}"
        );
    }

    #[test]
    fn next_run_id_carries_a_hyphen_separated_counter() {
        let id = next_run_id();
        let (millis, sequence) = id.split_once('-').expect("the id must carry a separator");

        assert!(millis.parse::<u128>().is_ok(), "id was {id}");
        assert!(sequence.parse::<u64>().is_ok(), "id was {id}");
    }
}
