//! Interruption and resume.
//!
//! A run that stops part way through must pick up where it left off, must not
//! redo finished work, and must keep the accounting exact. These tests use a
//! fixture server so the checkpoint's contents can be inspected directly.

mod common;

use common::{Fixture, Reply, pin_page, resource_page, resource_response, scratch};

use pinpull::board::enumerate;
use pinpull::input::BoardRef;
use pinpull::pinterest::PinterestClient;
use pinpull::state::{Checkpoint, PinState, Record, Store};

fn client(fixture: &Fixture) -> PinterestClient {
    let client = PinterestClient::with_base(fixture.base()).unwrap();
    client.set_cookies("_pinterest_sess=secret");
    client
}

/// A board of three pins. The fixture serves the board, the feed, then every
/// pin detail record, and only then the media bodies, because that is the order
/// a run actually asks in.
fn three_pin_board() -> Fixture {
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 3, "section_count": 0
    })));
    let base = fixture.base().to_owned();
    let pins: Vec<_> = (1..=3)
        .map(|index| {
            serde_json::json!({
                "id": index.to_string(),
                "is_eligible_for_image_download": true,
                "images": {"orig": {"url": format!("{base}/originals/{index}.png")}}
            })
        })
        .collect();
    fixture.then(resource_page(serde_json::Value::Array(pins), "-end-"));
    for index in 1..=3 {
        fixture.then(pin_page(serde_json::json!({
            "id": index.to_string(),
            "isEligibleForImageDownload": true,
            "images_orig": {"url": format!("{base}/originals/{index}.png")}
        })));
    }
    for index in 1..=3 {
        fixture.then(Reply::body(format!("PIN-{index}-BYTES")));
    }
    fixture
}

#[tokio::test]
async fn an_interrupted_run_resumes_from_the_checkpoint() {
    let fixture = three_pin_board();
    let board: BoardRef = "user/board".parse().unwrap();
    let dir = scratch("resume");
    let store = Store::new(&dir);

    // First run: only the first pin is recorded, as if the process died there.
    let full = enumerate(&client(&fixture), &board, 3).await.unwrap();
    assert_eq!(full.pins.len(), 3);
    let mut checkpoint = Checkpoint::new("user/board");
    checkpoint.set("1", Record::downloaded(vec!["1.png".to_owned()]));
    store.save(&checkpoint).unwrap();

    // The second run loads the checkpoint and only attempts what is left.
    let mut reloaded = store.load().unwrap();
    assert!(reloaded.needs_download("2"));
    assert!(
        !reloaded.needs_download("1"),
        "a finished pin is left alone"
    );
    let remaining: Vec<&str> = full
        .pins
        .iter()
        .filter(|pin| reloaded.needs_download(&pin.id))
        .map(|pin| pin.id.as_str())
        .collect();
    assert_eq!(remaining, vec!["2", "3"]);

    // Finishing them keeps the accounting exact and the saved state intact.
    for pin in &full.pins {
        if reloaded.needs_download(&pin.id) {
            reloaded.set(&pin.id, Record::downloaded(vec![format!("{}.png", pin.id)]));
        }
    }
    store.save(&reloaded).unwrap();
    let final_state = store.load().unwrap();
    let tally = final_state.tally();
    assert_eq!(
        (tally.downloaded, tally.skipped, tally.failed, tally.pending),
        (3, 0, 0, 0)
    );
    assert_eq!(tally.total(), full.pins.len());
    assert!(final_state.is_balanced());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_partial_file_does_not_count_as_a_finished_pin() {
    let fixture = three_pin_board();
    let dir = scratch("partial-not-done");
    let downloader = pinpull::download::Downloader::new().unwrap();
    // A `.part` exists but the finished file does not.
    std::fs::write(dir.join("1.png.part"), b"only half of pin 1").unwrap();
    assert!(!pinpull::download::is_complete(&dir.join("1.png")));

    // So the pin is still attempted, and the restart produces the full body.
    // One chunk of every pin keeps the detail fetches in board order, so the
    // fixture's replies land on the pins they were written for.
    let board: BoardRef = "user/board".parse().unwrap();
    let pins = enumerate(&client(&fixture), &board, 3).await.unwrap();
    let failures: Vec<String> = pins
        .pins
        .iter()
        .filter_map(|pin| pin.failure.clone())
        .collect();
    assert!(
        failures.is_empty(),
        "every pin's record should be read: {failures:?}"
    );
    let media = pinpull::media::select_media(pins.pins[0].data.as_ref().unwrap());
    let outcome = match downloader.fetch(&media[0], "1", &dir).await.unwrap() {
        pinpull::download::Fetched::Written(outcome) => outcome,
        pinpull::download::Fetched::AlreadyPresent(_) => unreachable!(),
    };
    assert!(pinpull::download::is_complete(&outcome.path));
    assert!(!dir.join("1.png.part").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_second_run_of_a_finished_board_does_nothing() {
    let fixture = three_pin_board();
    let board: BoardRef = "user/board".parse().unwrap();
    let dir = scratch("repeat-run");
    let store = Store::new(&dir);
    let pins = enumerate(&client(&fixture), &board, 3).await.unwrap();

    // A completed run's checkpoint says every pin is downloaded.
    let mut checkpoint = Checkpoint::new("user/board");
    for pin in &pins.pins {
        checkpoint.set(&pin.id, Record::downloaded(vec![format!("{}.png", pin.id)]));
    }
    store.save(&checkpoint).unwrap();
    let requests_after_first = fixture.request_count();

    let reloaded = store.load().unwrap();
    let work: Vec<&str> = pins
        .pins
        .iter()
        .filter(|pin| reloaded.needs_download(&pin.id))
        .map(|pin| pin.id.as_str())
        .collect();
    assert!(
        work.is_empty(),
        "a completed board must not be worked on again: {work:?}"
    );
    assert_eq!(fixture.request_count(), requests_after_first);
    assert_eq!(reloaded.tally().downloaded, 3);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_checkpoint_for_another_board_is_not_reused() {
    let dir = scratch("other-board");
    let store = Store::new(&dir);
    // Someone else's board was completed in this directory.
    let mut other = Checkpoint::new("someone/else");
    other.set("1", Record::downloaded(vec!["1.png".to_owned()]));
    store.save(&other).unwrap();

    let loaded = store.load().unwrap();
    assert_eq!(loaded.board, "someone/else");
    // The caller discards a checkpoint whose board differs, so this run starts
    // from nothing rather than trusting another board's records.
    assert_ne!(loaded.board, "user/board");
    assert!(!loaded.needs_download("1"));
    // What the run must not do is treat the other board's pins as its own work.
    let mut own = Checkpoint::new("user/board");
    own.set("1", Record::downloaded(vec!["1.png".to_owned()]));
    assert!(
        own.needs_download("9"),
        "this board has no such pin recorded yet"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_failed_pin_is_retried_on_the_next_run() {
    let dir = scratch("retry-failed");
    let store = Store::new(&dir);
    let mut checkpoint = Checkpoint::new("user/board");
    checkpoint.set("1", Record::failed("HTTP 500"));
    checkpoint.set("2", Record::skipped("Pinterest does not permit this pin"));
    store.save(&checkpoint).unwrap();

    let loaded = store.load().unwrap();
    // A failure is retried; a deliberate skip is not.
    assert!(loaded.needs_download("1"));
    assert!(!loaded.needs_download("2"));
    assert_eq!(loaded.pins["1"].reason.as_deref(), Some("HTTP 500"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn deleting_the_state_directory_forces_a_rescan() {
    let dir = scratch("no-state");
    let store = Store::new(&dir);
    // With nothing saved, every pin is new work again.
    assert_eq!(store.load().unwrap(), Checkpoint::default());
    assert_eq!(store.load().unwrap().tally(), Default::default());
    let mut checkpoint = Checkpoint::new("user/board");
    checkpoint.set("1", Record::downloaded(Vec::new()));
    store.save(&checkpoint).unwrap();

    // Removing `.state/` is the documented way to start over.
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(store.load().unwrap(), Checkpoint::default());
    assert!(store.load().unwrap().needs_download("1"));
}

#[tokio::test]
async fn a_checkpoint_survives_a_write_that_was_interrupted() {
    let dir = scratch("atomic-save");
    let store = Store::new(&dir);
    let mut checkpoint = Checkpoint::new("user/board");
    checkpoint.set("1", Record::downloaded(vec!["1.png".to_owned()]));
    store.save(&checkpoint).unwrap();
    // The staged temporary file never outlives a successful save.
    assert!(!store.path().with_extension("json.tmp").exists());
    assert!(store.path().exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_in_progress_pin_is_picked_up_again() {
    // A pin recorded mid-download when the process was killed is retried.
    let mut checkpoint = Checkpoint::new("user/board");
    checkpoint.set(
        "1",
        Record {
            state: PinState::Downloading,
            reason: None,
            files: Vec::new(),
        },
    );
    assert!(checkpoint.needs_download("1"));
    // A pin the checkpoint has never seen is new work too, which is what makes
    // a deleted `.state/` behave like a fresh run.
    assert!(checkpoint.needs_download("2"));
    let tally = checkpoint.tally();
    assert_eq!(tally.pending, 1, "a mid-download pin is not yet terminal");
    assert_eq!(tally.total(), 1);
    assert!(checkpoint.is_balanced());
}
