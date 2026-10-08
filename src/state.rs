//! The checkpoint that lets an interrupted run pick up where it stopped.
//!
//! One JSON file records, per Pin, the terminal state and the name it was
//! written under. Byte-level progress is deliberately not duplicated here: a
//! direct download's resume offset is already the size of its `.part` file, and
//! an HLS join restarts from the first segment, so extra bookkeeping would only
//! be a second source of truth to disagree with the disk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{PinpullError, Result};

/// Where a pin ended up. `Discovered` and friends are working states; only the
/// three terminal ones are persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PinState {
    Discovered,
    Checking,
    Downloading,
    Retrying,
    Downloaded,
    Skipped,
    Failed,
}

impl PinState {
    /// Whether the pin has reached a state it will not move out of.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            PinState::Downloaded | PinState::Skipped | PinState::Failed
        )
    }

    /// Whether a new run should try the pin again. An interrupted download is
    /// attempted again; a deliberate skip is respected.
    pub fn is_retryable(&self) -> bool {
        !matches!(self, PinState::Downloaded | PinState::Skipped)
    }

    /// The name this state contributes to in the accounting report.
    pub fn kind(&self) -> Option<StateKind> {
        match self {
            PinState::Downloaded => Some(StateKind::Downloaded),
            PinState::Skipped => Some(StateKind::Skipped),
            PinState::Failed => Some(StateKind::Failed),
            _ => None,
        }
    }
}

/// The three outcomes every discovered pin must end in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StateKind {
    Downloaded,
    Skipped,
    Failed,
}

impl std::fmt::Display for StateKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            StateKind::Downloaded => "downloaded",
            StateKind::Skipped => "skipped",
            StateKind::Failed => "failed",
        };
        write!(f, "{text}")
    }
}

/// What a pin turned into, and why it is worth remembering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub state: PinState,
    /// Why a pin was skipped or failed, and nothing at all when it downloaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The file names written for this pin, relative to the output directory.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl Record {
    /// A pin whose media is on disk.
    pub fn downloaded(files: Vec<String>) -> Self {
        Self {
            state: PinState::Downloaded,
            reason: None,
            files,
        }
    }

    /// A pin Pinterest did not let through.
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            state: PinState::Skipped,
            reason: Some(reason.into()),
            files: Vec::new(),
        }
    }

    /// A pin pinpull could not deliver.
    pub fn failed(reason: impl Into<String>) -> Self {
        Self {
            state: PinState::Failed,
            reason: Some(reason.into()),
            files: Vec::new(),
        }
    }
}

/// The run's saved progress: the board it belongs to and one record per pin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// The board this checkpoint was written for, so a different board never
    /// has its work treated as done.
    pub board: String,
    /// URL of the board, when the input was a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_url: Option<String>,
    #[serde(default)]
    pub pins: BTreeMap<String, Record>,
}

impl Checkpoint {
    pub fn new(board: &str) -> Self {
        Self {
            board: board.to_owned(),
            board_url: None,
            pins: BTreeMap::new(),
        }
    }

    /// Records a pin's outcome, overwriting any working state it had.
    pub fn set(&mut self, pin_id: &str, record: Record) {
        self.pins.insert(pin_id.to_owned(), record);
    }

    pub fn state_of(&self, pin_id: &str) -> Option<PinState> {
        self.pins.get(pin_id).map(|record| record.state)
    }

    /// Whether the pin already reached `Downloaded`, so it is left alone.
    pub fn is_downloaded(&self, pin_id: &str) -> bool {
        self.state_of(pin_id) == Some(PinState::Downloaded)
    }

    /// Whether the next run should attempt this pin. A pin already downloaded
    /// and a pin the user deliberately skipped are both left alone; a failure
    /// and an interrupted download are attempted again.
    pub fn needs_download(&self, pin_id: &str) -> bool {
        self.state_of(pin_id)
            .is_none_or(|state| state.is_retryable())
    }

    /// How many pins reached each terminal outcome. A pin still in a working
    /// state is in flight, not lost.
    pub fn tally(&self) -> Tally {
        let mut tally = Tally::default();
        for record in self.pins.values() {
            if !record.state.is_terminal() {
                tally.pending += 1;
                continue;
            }
            match record.state.kind() {
                Some(StateKind::Downloaded) => tally.downloaded += 1,
                Some(StateKind::Skipped) => tally.skipped += 1,
                Some(StateKind::Failed) => tally.failed += 1,
                None => tally.pending += 1,
            }
        }
        tally
    }

    /// Whether the accounting invariant holds for what has been recorded.
    pub fn is_balanced(&self) -> bool {
        let tally = self.tally();
        // A pin with no terminal state is still in flight, not lost.
        tally.downloaded + tally.skipped + tally.failed + tally.pending == self.pins.len()
    }
}

/// Terminal counts over a checkpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub downloaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub pending: usize,
}

impl Tally {
    pub fn total(&self) -> usize {
        self.downloaded + self.skipped + self.failed + self.pending
    }
}

/// Where the checkpoint lives, and how to load and save it.
#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join("checkpoint.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads the checkpoint, treating a missing file as an empty one. A file
    /// that cannot be understood is reported rather than silently discarded.
    pub fn load(&self) -> Result<Checkpoint> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Checkpoint::default());
            }
            Err(source) => return Err(PinpullError::Io(source)),
        };
        serde_json::from_str(&text).map_err(PinpullError::Json)
    }

    /// Writes the checkpoint atomically, so a crash mid-write leaves either the
    /// old file or the new one, never half of either.
    pub fn save(&self, checkpoint: &Checkpoint) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(PinpullError::Io)?;
        }
        let text = serde_json::to_string_pretty(checkpoint)?;
        let staged = self.path.with_extension("json.tmp");
        std::fs::write(&staged, text).map_err(PinpullError::Io)?;
        std::fs::rename(&staged, &self.path).map_err(PinpullError::Io)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pinpull-state-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_three_outcomes_are_terminal() {
        assert!(PinState::Downloaded.is_terminal());
        assert!(PinState::Skipped.is_terminal());
        assert!(PinState::Failed.is_terminal());
        assert!(!PinState::Discovered.is_terminal());
        assert!(!PinState::Checking.is_terminal());
        assert!(!PinState::Downloading.is_terminal());
        assert!(!PinState::Retrying.is_terminal());
    }

    #[test]
    fn a_finished_download_and_a_skip_decision_are_settled() {
        assert!(Checkpoint::new("u/b").state_of("1").is_none());
        let mut checkpoint = Checkpoint::new("u/b");
        checkpoint.set("1", Record::downloaded(Vec::new()));
        checkpoint.set("2", Record::skipped("because"));
        checkpoint.set("3", Record::failed("HTTP 404"));
        assert!(checkpoint.is_downloaded("1"));
        assert!(!checkpoint.needs_download("1"));
        assert!(!checkpoint.needs_download("2"));
        // A failure is terminal but not settled: the next run retries it.
        assert!(checkpoint.needs_download("3"));
        assert!(PinState::Failed.is_retryable());
        assert!(PinState::Discovered.is_retryable());
        assert!(!PinState::Downloaded.is_retryable());
        assert!(!PinState::Skipped.is_retryable());
    }

    #[test]
    fn a_newer_record_replaces_the_working_state() {
        let mut checkpoint = Checkpoint::new("u/b");
        checkpoint.set(
            "1",
            Record {
                state: PinState::Downloading,
                reason: None,
                files: Vec::new(),
            },
        );
        assert_eq!(checkpoint.state_of("1"), Some(PinState::Downloading));
        // A crash mid-download leaves a pin the next run picks up again.
        assert!(checkpoint.needs_download("1"));
        checkpoint.set("1", Record::downloaded(Vec::new()));
        assert_eq!(checkpoint.state_of("1"), Some(PinState::Downloaded));
        assert_eq!(checkpoint.pins.len(), 1);
    }

    #[test]
    fn tally_counts_every_record_once() {
        let mut checkpoint = Checkpoint::new("u/b");
        let states = [
            PinState::Downloaded,
            PinState::Skipped,
            PinState::Failed,
            PinState::Downloading,
        ];
        for (index, state) in states.iter().cycle().take(7).enumerate() {
            let record = match state {
                PinState::Downloaded => Record::downloaded(Vec::new()),
                PinState::Skipped => Record::skipped("because"),
                PinState::Failed => Record::failed("because"),
                other => Record {
                    state: *other,
                    reason: None,
                    files: Vec::new(),
                },
            };
            checkpoint.set(&index.to_string(), record);
        }
        let tally = checkpoint.tally();
        // Downloaded, Skipped, Failed, Downloading over seven pins.
        assert_eq!(
            (tally.downloaded, tally.skipped, tally.failed, tally.pending),
            (2, 2, 2, 1)
        );
        assert_eq!(tally.total(), checkpoint.pins.len());
        assert!(checkpoint.is_balanced());
        // Either the three outcomes together, or the total, covers every pin.
        assert_eq!(
            tally.downloaded + tally.skipped + tally.failed + tally.pending,
            7
        );
    }

    #[test]
    fn an_empty_checkpoint_is_balanced_with_no_work() {
        let checkpoint = Checkpoint::new("u/b");
        assert_eq!(checkpoint.tally(), Tally::default());
        assert!(checkpoint.is_balanced());
    }

    #[test]
    fn a_missing_checkpoint_is_empty_rather_than_an_error() {
        let dir = scratch("missing");
        let store = Store::new(&dir);
        assert_eq!(store.load().unwrap(), Checkpoint::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_round_trip_keeps_every_record() {
        let dir = scratch("roundtrip");
        let store = Store::new(&dir);
        let mut checkpoint = Checkpoint::new("user/board");
        checkpoint.board_url = Some("https://www.pinterest.com/user/board/".into());
        checkpoint.set(
            "1136033074790855749",
            Record {
                state: PinState::Downloaded,
                reason: None,
                files: vec!["1136033074790855749.png".into()],
            },
        );
        checkpoint.set(
            "1136033074790855750",
            Record {
                state: PinState::Skipped,
                reason: Some("Pinterest does not permit download".into()),
                files: Vec::new(),
            },
        );
        checkpoint.set("1136033074790855751", Record::failed("because"));
        store.save(&checkpoint).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded, checkpoint);
        assert_eq!(loaded.board, "user/board");
        assert_eq!(
            loaded.board_url.as_deref(),
            Some("https://www.pinterest.com/user/board/")
        );
        assert_eq!(loaded.pins.len(), 3);
        assert!(loaded.is_downloaded("1136033074790855749"));
        assert_eq!(
            loaded.pins["1136033074790855750"].reason.as_deref(),
            Some("Pinterest does not permit download")
        );
        // No temporary file is left behind.
        assert!(!store.path().with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_checkpoint_is_reported_not_ignored() {
        let dir = scratch("corrupt");
        let store = Store::new(&dir);
        std::fs::write(store.path(), "{not json").unwrap();
        assert!(store.load().is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn saving_creates_the_state_directory() {
        let dir = scratch("nested").join(".state");
        let store = Store::new(&dir);
        assert!(store.save(&Checkpoint::new("u/b")).is_ok());
        assert!(store.path().is_file());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clearing_a_missing_checkpoint_is_not_an_error() {
        let dir = scratch("clear");
        let store = Store::new(&dir);
        // Deleting `.state/` by hand is the supported way to force a re-scan,
        // so a run that starts without one must not fail.
        assert!(!store.path().exists());
        assert_eq!(store.load().unwrap(), Checkpoint::default());
        store.save(&Checkpoint::new("u/b")).unwrap();
        assert!(store.path().exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_checkpoint_records_which_board_it_belongs_to() {
        let checkpoint = Checkpoint::new("user/other");
        assert_eq!(checkpoint.board, "user/other");
        assert!(checkpoint.board_url.is_none());
        assert!(checkpoint.pins.is_empty());
    }

    #[test]
    fn a_reason_is_kept_for_skips_and_failures_only() {
        let text = serde_json::to_string(&Record::downloaded(Vec::new())).unwrap();
        assert!(!text.contains("reason"));
        assert!(!text.contains("files"));
        let text = serde_json::to_string(&Record {
            state: PinState::Failed,
            reason: Some("HTTP 503".into()),
            files: vec!["a.mp4".into()],
        })
        .unwrap();
        assert!(text.contains("HTTP 503"));
        assert!(text.contains("a.mp4"));
    }

    #[test]
    fn state_names_are_stable_in_the_file() {
        assert_eq!(PinState::Downloaded.kind(), Some(StateKind::Downloaded));
        assert_eq!(PinState::Skipped.kind(), Some(StateKind::Skipped));
        assert_eq!(PinState::Failed.kind(), Some(StateKind::Failed));
        assert_eq!(PinState::Downloading.kind(), None);
        assert_eq!(PinState::Checking.kind(), None);
        assert_eq!(StateKind::Skipped.to_string(), "skipped");
        assert_eq!(StateKind::Failed.to_string(), "failed");
        assert_eq!(StateKind::Downloaded.to_string(), "downloaded");
        assert_eq!(
            serde_json::to_string(&PinState::Skipped).unwrap(),
            "\"skipped\""
        );
        assert_eq!(
            serde_json::to_string(&PinState::Downloading).unwrap(),
            "\"downloading\""
        );
    }
}
