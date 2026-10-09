use std::collections::BTreeMap;
use std::sync::Arc;

use clap::Parser;
use pinpull::board;
use pinpull::board::{Eligibility, PinSource};
use pinpull::cli::Args;
use pinpull::download::{Downloader, Fetched, Outcome};
use pinpull::error::{PinpullError, Result};
use pinpull::input::BoardRef;
use pinpull::media::{MediaItem, output_stems, select_media};
use pinpull::pinterest::PinterestClient;
use pinpull::state::{Checkpoint, Record, Store};

/// Where the media for one board lands, and `.state` lives beside it.
struct Layout {
    media: std::path::PathBuf,
    store: Store,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let board_ref: BoardRef = args.board.parse()?;

    // A public board Pinterest opens to everyone is read with whatever session
    // the stored profile has, signed in or not; a board that refuses is what
    // makes a sign-in necessary.
    let session = pinpull::auth::authenticate(args.headless).await?;
    if session.csrf_token().is_none() {
        eprintln!("pinpull: the session carries no csrftoken cookie; API calls may be rejected");
    }

    let client = PinterestClient::new()?;
    client.set_cookies(session.cookie_header());
    if !client.has_session_cookies() {
        return Err(PinpullError::NotAuthenticated {
            message: "the browser never reached Pinterest".into(),
        }
        .into());
    }

    let layout = Layout {
        media: media_dir(&args.out, &board_ref),
        store: Store::new(&args.out.join(".state")),
    };
    std::fs::create_dir_all(&layout.media)?;

    println!("\npinpull {}/{}", board_ref.username, board_ref.board_slug);
    println!("  discovering pins...");
    let enumerated = match board::enumerate(&client, &board_ref, usize::from(args.jobs)).await {
        Ok(result) => result,
        // Pinterest answers a board the session may not see with 403, and it is
        // the same answer for a board that needs a sign-in. Whether the user is
        // signed in is what tells the two apart, and the wording has to reflect
        // which one it is rather than guessing at a bypass.
        Err(PinpullError::HttpStatus { status: 403, .. }) if !session.is_authenticated() => {
            return Err(PinpullError::NotAuthenticated {
                message: format!(
                    "Pinterest requires a signed-in session to read {}/{}",
                    board_ref.username, board_ref.board_slug
                ),
            }
            .into());
        }
        Err(PinpullError::HttpStatus { status: 403, .. }) => {
            return Err(PinpullError::Pinterest {
                resource: "Board",
                message: format!(
                    "the current Pinterest account cannot access {}/{}",
                    board_ref.username, board_ref.board_slug
                ),
            }
            .into());
        }
        Err(err) => return Err(err.into()),
    };
    let discovered = enumerated.pins.len();
    if !enumerated.board.name.is_empty() {
        println!(
            "  board: {}  ({})",
            enumerated.board.name, enumerated.board.id
        );
    }
    // Pinterest's own count is the reference an independent count is checked
    // against, and a shortfall is a discovery problem rather than a display one.
    match enumerated.board.pin_count {
        Some(count) if count != discovered as u64 => {
            println!("  pinterest reports {count} pins; pinpull discovered {discovered}")
        }
        Some(count) => println!("  pinterest reports {count} pins"),
        None => println!("  pinterest reported no pin count"),
    }
    if enumerated.duplicate_encounters > 0 {
        println!(
            "  {} duplicate pin ids ignored",
            enumerated.duplicate_encounters
        );
    }
    println!("  discovered {discovered} pins\n");

    let mut checkpoint = layout.store.load()?;
    if checkpoint.board != format!("{}/{}", board_ref.username, board_ref.board_slug) {
        // A different board's records must not decide this board's work.
        checkpoint = Checkpoint::new(&format!("{}/{}", board_ref.username, board_ref.board_slug));
        checkpoint.board_url = enumerated.board.url.clone().into();
    }

    let downloader = Arc::new(Downloader::new()?);
    let mut by_source: BTreeMap<PinSource, u64> = BTreeMap::new();
    let mut unknown_ids: Vec<&str> = Vec::new();
    let mut tasks: Vec<(String, Vec<MediaItem>)> = Vec::new();

    for pin in &enumerated.pins {
        *by_source.entry(pin.source.clone()).or_insert(0) += 1;
        match pin.eligibility {
            Eligibility::Eligible => {}
            Eligibility::Ineligible => {
                checkpoint.set(
                    &pin.id,
                    Record::skipped("Pinterest does not permit downloading this pin"),
                );
                continue;
            }
            Eligibility::Unknown => {
                // Unknown eligibility is counted and reported, never dropped.
                // The reason is whatever actually happened: a pin whose detail
                // could not be read is not the same as one whose record simply
                // has no flag, and the difference decides whether a retry helps.
                unknown_ids.push(&pin.id);
                let reason = pin.failure.clone().unwrap_or_else(|| {
                    "download eligibility is absent from the pin record".to_owned()
                });
                checkpoint.set(&pin.id, Record::failed(reason));
                continue;
            }
        }
        if !checkpoint.needs_download(&pin.id) {
            continue;
        }
        let Some(data) = &pin.data else {
            // A pin whose detail could not be read still ends as a failure with
            // the reason attached, so nothing discovered goes unaccounted for.
            let reason = pin
                .failure
                .clone()
                .unwrap_or_else(|| "the pin detail record was unavailable".into());
            checkpoint.set(&pin.id, Record::failed(reason));
            continue;
        };
        let items = select_media(data);
        if items.is_empty() {
            // A discovered pin must never disappear from the accounting.
            checkpoint.set(
                &pin.id,
                Record::skipped("Pinterest offers no downloadable media for this pin"),
            );
            continue;
        }
        tasks.push((pin.id.clone(), items));
    }
    layout.store.save(&checkpoint)?;

    let already_on_disk = enumerated
        .pins
        .iter()
        .filter(|pin| checkpoint.is_downloaded(&pin.id))
        .count();
    println!(
        "  {} pins to download ({} already downloaded in a previous run)",
        tasks.len(),
        already_on_disk
    );

    // What this run will write, so the output says what medium to expect.
    let (mut images, mut video_files, mut playlists) = (0u64, 0u64, 0u64);
    for (_, items) in &tasks {
        for item in items {
            if item.kind.is_playlist() {
                playlists += 1;
            } else if item.kind.is_video() {
                video_files += 1;
            } else {
                images += 1;
            }
        }
    }

    let jobs = usize::from(args.jobs).max(1);
    let mut set = tokio::task::JoinSet::new();
    let mut queue: std::collections::VecDeque<(String, Vec<MediaItem>)> =
        tasks.into_iter().collect();
    for _ in 0..jobs.min(queue.len()) {
        let downloader = Arc::clone(&downloader);
        let media = layout.media.clone();
        let (pin_id, items) = queue.pop_front().expect("queue was not empty");
        set.spawn(download_pin(downloader, pin_id, items, media));
    }
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((pin_id, outcome)) => match outcome {
                Ok(fetched) => checkpoint.set(&pin_id, record_for(fetched)),
                Err(err) => checkpoint.set(&pin_id, Record::failed(err.to_string())),
            },
            Err(err) => {
                eprintln!("pinpull: a download task failed: {err}");
            }
        }
        layout.store.save(&checkpoint)?;
        if let Some((pin_id, items)) = queue.pop_front() {
            let downloader = Arc::clone(&downloader);
            let media = layout.media.clone();
            set.spawn(download_pin(downloader, pin_id, items, media));
        }
    }
    layout.store.save(&checkpoint)?;

    // The invariant is over the pins this run discovered, not over the whole
    // checkpoint: a checkpoint also holds pins from earlier runs, which a later
    // feed or section page may legitimately not repeat.
    let mut downloaded = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    for pin in &enumerated.pins {
        match checkpoint.state_of(&pin.id).and_then(|state| state.kind()) {
            Some(pinpull::state::StateKind::Downloaded) => downloaded += 1,
            Some(pinpull::state::StateKind::Skipped) => skipped += 1,
            Some(pinpull::state::StateKind::Failed) => failed += 1,
            None => {}
        }
    }
    println!("\n  by source:");
    for (source, count) in &by_source {
        println!("    {source}: {count}");
    }
    println!("\n  discovered: {}", discovered);
    println!("    downloaded: {downloaded}");
    println!("    skipped:    {skipped}");
    println!("    failed:     {failed}");
    println!("    total:      {}", downloaded + skipped + failed);
    println!("  this run wrote: {images} images, {video_files} videos, {playlists} playlists");
    println!("  media in:     {}", layout.media.display());
    println!("  checkpoint:   {}", layout.store.path().display());

    if !unknown_ids.is_empty() {
        let total = unknown_ids.len();
        let shown: Vec<&str> = unknown_ids.into_iter().take(20).collect();
        print!("\n  unknown eligibility pin ids: {}", shown.join(", "));
        if total > shown.len() {
            print!(", and {} more", total - shown.len());
        }
        println!();
    }

    // The accounting invariant: every pin this run discovered reached one of the
    // three outcomes, so nothing dropped out silently.
    if downloaded + skipped + failed != u64::try_from(discovered).unwrap_or(u64::MAX) {
        return Err(PinpullError::Pinterest {
            resource: "accounting",
            message: format!(
                "discovered {discovered} pins but accounted for {}",
                downloaded + skipped + failed
            ),
        }
        .into());
    }
    Ok(())
}

/// Downloads one pin's media and reports the files it produced.
async fn download_pin(
    downloader: Arc<Downloader>,
    pin_id: String,
    items: Vec<MediaItem>,
    dir: std::path::PathBuf,
) -> (String, Result<Fetched>) {
    let stems = output_stems(&pin_id, &items);
    let mut files = Vec::with_capacity(items.len());
    let mut bytes = 0u64;
    let mut segments = 0usize;
    for (item, stem) in items.iter().zip(stems.iter()) {
        match downloader.fetch(item, stem, &dir).await {
            Ok(fetched) => match fetched {
                Fetched::Written(outcome) => {
                    bytes += outcome.bytes;
                    segments += outcome.segments;
                    files.extend(outcome.files);
                }
                Fetched::AlreadyPresent(path) => files.push(name_of(&path)),
            },
            Err(err) => return (pin_id, Err(err)),
        }
    }
    (
        pin_id,
        Ok(Fetched::Written(Outcome {
            path: std::path::PathBuf::new(),
            bytes,
            segments,
            files,
        })),
    )
}

fn name_of(path: &std::path::Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn record_for(fetched: Fetched) -> Record {
    match fetched {
        Fetched::Written(outcome) => Record::downloaded(outcome.files),
        Fetched::AlreadyPresent(path) => Record::downloaded(vec![name_of(&path)]),
    }
}

/// Media lands in `<out>/[<board>/]`; a default output nests each board so
/// several boards can be downloaded into the same directory.
fn media_dir(out: &std::path::Path, board: &BoardRef) -> std::path::PathBuf {
    let is_default = out == std::path::Path::new("downloads");
    if is_default {
        out.join(format!("{}/{}", board.username, board.board_slug))
    } else {
        out.to_path_buf()
    }
}
