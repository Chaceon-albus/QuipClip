//! What the reader learned about the keyframes and the decoder configurations of one source.
//!
//! A locate and a window stream see keyframes one after another. Two neighbours that one walk saw
//! with nothing between them are a *run*: no keyframe lies between them, so a target between
//! their presentation times needs no read at all. A keyframe that a bisection found alone starts
//! a run of one, which answers nothing until a walk extends it (ADR 046).
//!
//! The table also keeps each configuration tag that a walk or a probe block showed. A recorder
//! writes a new decoder configuration after a reconnect, and the head of a window must carry the
//! configuration in force at its start.

use super::tag::TagKind;
use std::collections::{BTreeMap, BTreeSet};

/// A keyframe video tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyframeEntry {
    /// The offset of the tag header.
    pub offset: u64,
    /// The decode time in milliseconds.
    pub dts: i64,
    /// The presentation time in milliseconds.
    pub pts: i64,
}

/// A configuration tag, copied whole: header, data and trailing `PreviousTagSize`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigTag {
    pub offset: u64,
    pub kind: TagKind,
    pub bytes: Vec<u8>,
}

impl ConfigTag {
    /// The tag data, which identifies the configuration whatever its timestamp.
    pub fn data(&self) -> &[u8] {
        &self.bytes[11..self.bytes.len() - 4]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    dts: i64,
    pts: i64,
    run: u64,
}

/// The keyframes and configurations that the reader knows for one source.
#[derive(Debug, Clone, Default)]
pub struct KeyframeTable {
    entries: BTreeMap<u64, Entry>,
    /// Runs whose last keyframe is the last keyframe of the file.
    runs_to_end: BTreeSet<u64>,
    configs: BTreeMap<u64, ConfigTag>,
    /// A u64 counter: one run for each walk and each window cannot wrap it.
    next_run: u64,
    changed: bool,
}

impl KeyframeTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// The number of keyframes in the table.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True when the table learned something since the last [`KeyframeTable::take_changed`].
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// Record keyframes that one walk saw in file order with no other keyframe between them.
    /// `reaches_end` says that the walk reached the end of the file after the last one.
    pub fn record_run(&mut self, keyframes: &[KeyframeEntry], reaches_end: bool) {
        if keyframes.is_empty() {
            return;
        }
        // The new run joins every run that it shares a keyframe with.
        let joined: BTreeSet<u64> = keyframes
            .iter()
            .filter_map(|k| self.entries.get(&k.offset).map(|e| e.run))
            .collect();
        let run = self.next_run;
        self.next_run += 1;
        for entry in self.entries.values_mut() {
            if joined.contains(&entry.run) {
                entry.run = run;
            }
        }
        let mut ended_before = false;
        for old in &joined {
            ended_before |= self.runs_to_end.remove(old);
        }
        let ends = reaches_end || ended_before;
        if ends {
            self.runs_to_end.insert(run);
        }
        for keyframe in keyframes {
            let entry = Entry {
                dts: keyframe.dts,
                pts: keyframe.pts,
                run,
            };
            if self.entries.insert(keyframe.offset, entry) != Some(entry) {
                self.changed = true;
            }
        }
        // Two runs that became one, or a run that now reaches the end, is new knowledge. A run
        // that repeats one known run is not.
        if joined.len() > 1 || (ends && !ended_before) {
            self.changed = true;
        }
    }

    /// The keyframe with the latest presentation time at or before `target_pts`, when the table
    /// can prove that no other keyframe lies between it and the target.
    pub fn lookup(&self, target_pts: i64) -> Option<KeyframeEntry> {
        // Offsets and presentation times of keyframes rise together in a file whose timestamps
        // do not decrease, which is the only file that the table answers for (see `locate`).
        let (offset, entry) = self
            .entries
            .iter()
            .filter(|(_, e)| e.pts <= target_pts)
            .max_by_key(|(offset, e)| (e.pts, **offset))?;
        let next = self.entries.range(offset + 1..).next();
        let proven = match next {
            Some((_, after)) => after.run == entry.run && after.pts > target_pts,
            None => self.runs_to_end.contains(&entry.run),
        };
        proven.then_some(KeyframeEntry {
            offset: *offset,
            dts: entry.dts,
            pts: entry.pts,
        })
    }

    /// Every keyframe, in file order, as (keyframe, run, whether the run reaches the end).
    pub fn entries(&self) -> impl Iterator<Item = (KeyframeEntry, u64, bool)> + '_ {
        self.entries.iter().map(|(offset, e)| {
            (
                KeyframeEntry {
                    offset: *offset,
                    dts: e.dts,
                    pts: e.pts,
                },
                e.run,
                self.runs_to_end.contains(&e.run),
            )
        })
    }

    /// Record a configuration tag.
    pub fn record_config(&mut self, config: ConfigTag) {
        if self.configs.get(&config.offset) != Some(&config) {
            self.configs.insert(config.offset, config);
            self.changed = true;
        }
    }

    /// Every configuration tag, in file order.
    pub fn configs(&self) -> impl Iterator<Item = &ConfigTag> {
        self.configs.values()
    }

    /// For each kind, the last configuration tag at or before `offset`.
    pub fn configs_at(&self, offset: u64) -> BTreeMap<TagKind, &ConfigTag> {
        let mut latest = BTreeMap::new();
        for config in self.configs.range(..=offset).map(|(_, c)| c) {
            latest.insert(config.kind, config);
        }
        latest
    }

    /// True when the table knows two different configurations of one kind, as a recorder writes
    /// after a reconnect. The export then keeps `-ss` (ADR 046).
    pub fn has_config_change(&self) -> bool {
        let mut first: BTreeMap<TagKind, &[u8]> = BTreeMap::new();
        self.configs.values().any(|config| {
            let data = config.data();
            *first.entry(config.kind).or_insert(data) != data
        })
    }

    /// Add everything that `other` knows: each of its runs as a run, and its configurations.
    pub fn merge(&mut self, other: &KeyframeTable) {
        let mut runs: BTreeMap<u64, (Vec<KeyframeEntry>, bool)> = BTreeMap::new();
        for (keyframe, run, to_end) in other.entries() {
            let slot = runs.entry(run).or_default();
            slot.0.push(keyframe);
            slot.1 |= to_end;
        }
        for (keyframes, to_end) in runs.into_values() {
            self.record_run(&keyframes, to_end);
        }
        for config in other.configs() {
            self.record_config(config.clone());
        }
    }

    /// Rebuild a table from saved runs, for the sidecar (see `cache`).
    pub(super) fn from_saved(
        keyframes: impl IntoIterator<Item = (KeyframeEntry, u64, bool)>,
        configs: impl IntoIterator<Item = ConfigTag>,
    ) -> Self {
        let mut table = Self::new();
        let mut renumber = BTreeMap::new();
        for (keyframe, run, to_end) in keyframes {
            let next = renumber.len() as u64;
            let run = *renumber.entry(run).or_insert(next);
            if to_end {
                table.runs_to_end.insert(run);
            }
            table.entries.insert(
                keyframe.offset,
                Entry {
                    dts: keyframe.dts,
                    pts: keyframe.pts,
                    run,
                },
            );
        }
        table.next_run = renumber.len() as u64;
        for config in configs {
            table.configs.insert(config.offset, config);
        }
        table
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(offset: u64, pts: i64) -> KeyframeEntry {
        KeyframeEntry {
            offset,
            dts: pts - 67,
            pts,
        }
    }

    #[test]
    fn a_run_answers_a_target_between_two_of_its_keyframes() {
        let mut table = KeyframeTable::new();
        table.record_run(&[key(100, 67), key(5000, 2067), key(9000, 4067)], false);
        assert_eq!(table.lookup(67), Some(key(100, 67)));
        assert_eq!(table.lookup(3000), Some(key(5000, 2067)));
        // After the last keyframe of a run that does not reach the end, a later keyframe may
        // exist, so the table does not answer.
        assert_eq!(table.lookup(5000), None);
        // Before the first keyframe of the file the table knows nothing.
        assert_eq!(table.lookup(10), None);
    }

    #[test]
    fn a_lone_keyframe_answers_nothing_until_a_run_joins_it() {
        let mut table = KeyframeTable::new();
        table.record_run(&[key(5000, 2067)], false);
        assert_eq!(table.lookup(3000), None);
        table.record_run(&[key(5000, 2067), key(9000, 4067)], false);
        assert_eq!(table.lookup(3000), Some(key(5000, 2067)));
    }

    #[test]
    fn two_runs_that_share_a_keyframe_become_one() {
        let mut table = KeyframeTable::new();
        table.record_run(&[key(100, 67), key(5000, 2067)], false);
        table.record_run(&[key(5000, 2067), key(9000, 4067)], true);
        assert_eq!(table.lookup(1000), Some(key(100, 67)));
        assert_eq!(table.lookup(3000), Some(key(5000, 2067)));
        // The joined run reaches the end, so the last keyframe answers any later target.
        assert_eq!(table.lookup(60_000), Some(key(9000, 4067)));
    }

    #[test]
    fn neighbours_of_two_separate_runs_answer_nothing() {
        let mut table = KeyframeTable::new();
        table.record_run(&[key(100, 67)], false);
        table.record_run(&[key(9000, 4067)], false);
        assert_eq!(table.lookup(2000), None);
    }

    #[test]
    fn reports_changes_once() {
        let mut table = KeyframeTable::new();
        assert!(!table.take_changed());
        table.record_run(&[key(100, 67)], false);
        assert!(table.take_changed());
        table.record_run(&[key(100, 67)], false);
        assert!(!table.take_changed());
    }

    fn config(offset: u64, kind: TagKind, marker: u8) -> ConfigTag {
        let mut bytes = vec![9, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x17, marker];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        ConfigTag {
            offset,
            kind,
            bytes,
        }
    }

    #[test]
    fn gives_the_latest_configuration_of_each_kind_at_an_offset() {
        let mut table = KeyframeTable::new();
        table.record_config(config(13, TagKind::Video, 1));
        table.record_config(config(40, TagKind::Audio, 1));
        table.record_config(config(9000, TagKind::Video, 2));
        let at = table.configs_at(5000);
        assert_eq!(at[&TagKind::Video].offset, 13);
        assert_eq!(at[&TagKind::Audio].offset, 40);
        assert_eq!(table.configs_at(9000)[&TagKind::Video].offset, 9000);
        assert!(table.has_config_change());
    }

    #[test]
    fn the_same_configuration_twice_is_no_change() {
        let mut table = KeyframeTable::new();
        table.record_config(config(13, TagKind::Video, 1));
        table.record_config(config(9000, TagKind::Video, 1));
        assert!(!table.has_config_change());
    }

    #[test]
    fn a_merged_run_that_bridges_two_runs_joins_them_and_keeps_the_end() {
        let mut shared = KeyframeTable::new();
        shared.record_run(&[key(100, 67), key(5000, 2067)], false);
        shared.record_run(&[key(9000, 4067), key(13_000, 6067)], true);
        assert_eq!(shared.lookup(3000), None);
        let mut scratch = KeyframeTable::new();
        scratch.record_run(&[key(5000, 2067), key(9000, 4067)], false);
        shared.merge(&scratch);
        assert_eq!(shared.lookup(3000), Some(key(5000, 2067)));
        assert_eq!(shared.lookup(1000), Some(key(100, 67)));
        assert_eq!(shared.lookup(60_000), Some(key(13_000, 6067)));
    }

    #[test]
    fn a_saved_table_answers_as_the_original() {
        let mut table = KeyframeTable::new();
        table.record_run(&[key(100, 67), key(5000, 2067)], false);
        table.record_run(&[key(20_000, 9067), key(25_000, 11_067)], true);
        let copy = KeyframeTable::from_saved(table.entries().collect::<Vec<_>>(), Vec::new());
        for target in [100, 3000, 9067, 10_000, 20_000] {
            assert_eq!(copy.lookup(target), table.lookup(target), "target {target}");
        }
    }
}
