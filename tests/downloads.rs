//! Downloads, media selection, and the accounting invariant.
//!
//! Everything here answers from a fixture server, so direct fetches, HLS
//! joining, decryption, resume and failure handling are all exercised without
//! touching Pinterest and without any credentials in the repository.

mod common;

use common::{Fixture, Reply, scratch};

use pinpull::board::enumerate;
use pinpull::download::{Downloader, Fetched, is_complete};
use pinpull::input::BoardRef;
use pinpull::media::{MediaItem, MediaKind, output_stems, select_media};
use pinpull::pinterest::PinterestClient;

fn item(url: &str, kind: MediaKind) -> MediaItem {
    MediaItem {
        label: "x".to_owned(),
        url: url.to_owned(),
        kind,
    }
}

fn read_dir(path: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort_unstable();
    names
}

/// A board whose every pin is eligible, served from a fixture.
fn eligible_board_fixture() -> Fixture {
    let fixture = Fixture::start(common::resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 2, "section_count": 0
    })));
    let one = format!("{}/originals/1.png", fixture.base());
    let two = format!("{}/originals/2.jpg", fixture.base());
    fixture.then(common::resource_page(
        serde_json::json!([
            {
                "id": "111",
                "is_eligible_for_image_download": true,
                "images": {"orig": {"url": one, "width": 1989, "height": 3000}}
            },
            {
                "id": "222",
                "is_eligible_for_image_download": true,
                "images": {"orig": {"url": two, "width": 100, "height": 100}}
            }
        ]),
        "-end-",
    ));
    // Pin detail records, then the media files themselves.
    fixture.then(common::resource_response(serde_json::json!({
        "id": "111",
        "is_eligible_for_image_download": true,
        "images": {"orig": {"url": one, "width": 1989, "height": 3000}}
    })));
    fixture.then(common::resource_response(serde_json::json!({
        "id": "222",
        "is_eligible_for_image_download": true,
        "images": {"orig": {"url": two, "width": 100, "height": 100}}
    })));
    fixture.then(Reply::body("PNG-BYTES-FOR-PIN-ONE"));
    fixture.then(Reply::body("JPG-BYTES-FOR-PIN-TWO"));
    fixture
}

#[tokio::test]
async fn an_eligible_image_pin_downloads_with_its_own_extension() {
    let fixture = eligible_board_fixture();
    let client = PinterestClient::with_base(fixture.base()).unwrap();
    client.set_cookies("_pinterest_sess=secret");
    let board: BoardRef = "user/board".parse().unwrap();
    let result = enumerate(&client, &board, 2).await.unwrap();

    let dir = scratch("eligible");
    let downloader = Downloader::new().unwrap();
    for pin in &result.pins {
        let items = select_media(pin.data.as_ref().unwrap());
        let stems = output_stems(&pin.id, &items);
        for (media, stem) in items.iter().zip(stems.iter()) {
            downloader.fetch(media, stem, &dir).await.unwrap();
        }
    }
    assert_eq!(
        read_dir(&dir),
        vec!["111.png".to_owned(), "222.jpg".to_owned()],
        "each pin keeps the extension Pinterest gave it"
    );
    assert_eq!(
        std::fs::read(dir.join("111.png")).unwrap(),
        b"PNG-BYTES-FOR-PIN-ONE"
    );
    // A `.part` file never survives a successful download.
    assert!(!dir.join("111.png.part").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_repeated_run_leaves_finished_files_alone() {
    let fixture = eligible_board_fixture();
    let client = PinterestClient::with_base(fixture.base()).unwrap();
    client.set_cookies("_pinterest_sess=secret");
    let board: BoardRef = "user/board".parse().unwrap();
    let result = enumerate(&client, &board, 2).await.unwrap();

    let dir = scratch("repeat");
    let downloader = Downloader::new().unwrap();
    for pin in &result.pins {
        let items = select_media(pin.data.as_ref().unwrap());
        for (media, stem) in items.iter().zip(output_stems(&pin.id, &items).iter()) {
            downloader.fetch(media, stem, &dir).await.unwrap();
        }
    }
    let first_requests = fixture.request_count();
    assert_eq!(read_dir(&dir).len(), 2);

    // A second pass must not fetch anything again.
    for pin in &result.pins {
        let items = select_media(pin.data.as_ref().unwrap());
        for (media, stem) in items.iter().zip(output_stems(&pin.id, &items).iter()) {
            match downloader.fetch(media, stem, &dir).await.unwrap() {
                Fetched::Written(outcome) => {
                    assert_eq!(
                        std::fs::read(&outcome.path).unwrap(),
                        b"PNG-BYTES-FOR-PIN-ONE"
                    );
                }
                Fetched::AlreadyPresent(_) => {}
            }
        }
    }
    assert_eq!(
        fixture.request_count(),
        first_requests,
        "a repeated run must not refetch finished media"
    );
    assert_eq!(
        read_dir(&dir),
        vec!["111.png".to_owned(), "222.jpg".to_owned()]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_404_media_file_fails_only_its_own_pin() {
    // One pin's media is missing while another still downloads.
    let fixture = Fixture::start(Reply::body("PNG-BYTES"));
    fixture.then(Reply::body("gone").status(404));
    fixture.then(Reply::body("JPG-BYTES"));
    let dir = scratch("one-failure");
    let downloader = Downloader::new().unwrap();

    let good = item(
        &format!("{}/originals/1.png", fixture.base()),
        MediaKind::Image,
    );
    let bad = item(
        &format!("{}/originals/2.png", fixture.base()),
        MediaKind::Image,
    );
    let also_good = item(
        &format!("{}/originals/3.png", fixture.base()),
        MediaKind::Image,
    );

    let mut downloaded = 0u64;
    let mut failed = 0u64;
    for media in [&good, &bad, &also_good] {
        let stem = format!("pin-{}", downloaded + failed);
        match downloader.fetch(media, &stem, &dir).await {
            Ok(_) => downloaded += 1,
            Err(err) => {
                assert!(err.to_string().contains("404"));
                failed += 1;
            }
        }
    }
    // A permanent 404 fails only its own pin, and does not abort the rest.
    assert_eq!(downloaded, 2);
    assert_eq!(failed, 1);
    assert_eq!(read_dir(&dir).len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_429_media_file_retries_and_respects_retry_after() {
    // Two throttles, then the body.
    let first = Reply::body("slow").status(429).header("Retry-After", "1");
    let second = Reply::body("slow").status(429).header("Retry-After", "1");
    let fixture = Fixture::start(first);
    fixture.then(second);
    fixture.then(Reply::body("THE MEDIA"));
    let dir = scratch("retry");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/originals/1.png", fixture.base()),
        MediaKind::Image,
    );
    let outcome = match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::Written(outcome) => outcome,
        Fetched::AlreadyPresent(_) => panic!("a new download must be reported"),
    };
    assert_eq!(outcome.bytes, 9);
    assert_eq!(std::fs::read(dir.join("111.png")).unwrap(), b"THE MEDIA");
    assert!(fixture.request_count() >= 3, "the retry must have happened");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_500_media_file_retries_then_fails() {
    let fixture = Fixture::start(Reply::body("broken").status(500));
    let dir = scratch("persistent-failure");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/originals/1.png", fixture.base()),
        MediaKind::Image,
    );
    let error = downloader.fetch(&media, "111", &dir).await.unwrap_err();
    assert!(
        error.to_string().contains("500"),
        "the final failure must name the status: {error}"
    );
    // Retries happened, but they were bounded.
    assert!(fixture.request_count() > 1, "transient errors are retried");
    assert!(fixture.request_count() <= 5, "retries are bounded");
    // Nothing was left behind that could look like a finished download.
    assert_eq!(read_dir(&dir), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_partial_download_is_not_mistaken_for_a_finished_file() {
    let fixture = Fixture::start(Reply::body("THE MEDIA"));
    let dir = scratch("partial");
    std::fs::write(dir.join("111.png.part"), b"half the media").unwrap();

    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/originals/1.png", fixture.base()),
        MediaKind::Image,
    );
    // The fixture ignores ranges and answers 200, so the file restarts.
    let outcome = match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::Written(outcome) => outcome,
        Fetched::AlreadyPresent(_) => panic!("a finished file must not be reported"),
    };
    assert_eq!(std::fs::read(&outcome.path).unwrap(), b"THE MEDIA");
    assert!(is_complete(&dir.join("111.png")));
    assert!(!dir.join("111.png.part").exists());
    // A range was attempted and the server ignored it, so the file restarted
    // rather than having two responses appended end to end.
    assert!(fixture.ranged_request_count() >= 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_file_on_disk_is_not_downloaded_again() {
    let dir = scratch("present");
    std::fs::write(dir.join("111.png"), b"THE MEDIA").unwrap();
    let fixture = Fixture::start(Reply::body("THE MEDIA"));
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/originals/1.png", fixture.base()),
        MediaKind::Image,
    );
    match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::AlreadyPresent(path) => assert_eq!(path, dir.join("111.png")),
        Fetched::Written(_) => panic!("an existing file must not be rewritten"),
    }
    assert_eq!(fixture.request_count(), 0, "no request at all was made");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn hls_segments_are_joined_into_one_file() {
    // Two plain MPEG-TS segments: a playlist and the bytes.
    let playlist = "\
#EXTM3U
#EXT-X-TARGETDURATION:1
#EXTINF:1.0,
seg0.ts
#EXTINF:1.0,
seg1.ts
#EXT-X-ENDLIST
";
    let fixture = Fixture::start(Reply::body(playlist));
    fixture.then(Reply::body(vec![b'A'; 16]));
    fixture.then(Reply::body(vec![b'B'; 16]));
    fixture.then(Reply::body("IGNORED"));
    let dir = scratch("hls");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/videos/hls/1.m3u8", fixture.base()),
        MediaKind::VideoHls,
    );
    let outcome = match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::Written(outcome) => outcome,
        Fetched::AlreadyPresent(_) => panic!("a new download must be reported"),
    };
    // A TS playlist is written as .ts and never as .mp4.
    assert_eq!(outcome.segments, 2);
    assert_eq!(
        std::fs::read(&outcome.path).unwrap(),
        vec![b'A'; 16]
            .into_iter()
            .chain(vec![b'B'; 16])
            .collect::<Vec<u8>>()
    );
    assert_eq!(
        outcome.path.extension().and_then(|ext| ext.to_str()),
        Some("ts")
    );
    assert_eq!(read_dir(&dir), vec!["111.ts".to_owned()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn hls_segments_are_decrypted_before_being_joined() {
    // AES-128 encrypted segments: the key, then two segments.
    let playlist = "\
#EXTM3U
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI=\"k.key\",IV=0x00000000000000000000000000000000
#EXTINF:1.0,
seg0.ts
#EXT-X-ENDLIST
";
    let fixture = Fixture::start(Reply::body(playlist));
    fixture.then(Reply::body(vec![0u8; 16]));
    fixture.then(Reply::body(vec![1u8; 16]));
    fixture.then(Reply::body(vec![2u8; 16]));
    let dir = scratch("hls-aes");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/videos/hls/a.m3u8", fixture.base()),
        MediaKind::VideoHls,
    );
    let outcome = match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::Written(outcome) => outcome,
        Fetched::AlreadyPresent(_) => panic!("a new download must be reported"),
    };
    // The key and the segment were fetched separately, on top of the playlist.
    assert_eq!(fixture.request_count(), 3);
    assert_eq!(outcome.segments, 1);
    assert_eq!(outcome.bytes, 16, "the decrypted segment was written");
    assert!(is_complete(&outcome.path));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_playlist_that_is_not_a_playlist_is_reported() {
    let fixture = Fixture::start(Reply::body("<html>are you a robot</html>"));
    let dir = scratch("not-a-playlist");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/videos/hls/a.m3u8", fixture.base()),
        MediaKind::VideoHls,
    );
    let error = downloader.fetch(&media, "111", &dir).await.unwrap_err();
    assert!(
        error.to_string().contains("#EXTM3U") || error.to_string().contains("HLS"),
        "a non-playlist response must be reported: {error}"
    );
    assert_eq!(read_dir(&dir), Vec::<String>::new());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_master_playlist_is_followed_to_its_best_rendition() {
    let master = "\
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=576x1024
hls/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1080x1920
hls/high.m3u8
";
    let media_playlist = "\
#EXTM3U
#EXTINF:1.0,
seg0.ts
#EXT-X-ENDLIST
";
    let fixture = Fixture::start(Reply::body(master));
    fixture.then(Reply::body(media_playlist));
    fixture.then(Reply::body(vec![b'S'; 8]));
    let dir = scratch("master");
    let downloader = Downloader::new().unwrap();
    let media = item(
        &format!("{}/videos/hls/a.m3u8", fixture.base()),
        MediaKind::VideoHls,
    );
    let outcome = match downloader.fetch(&media, "111", &dir).await.unwrap() {
        Fetched::Written(outcome) => outcome,
        Fetched::AlreadyPresent(_) => panic!("a new download must be reported"),
    };
    assert_eq!(outcome.segments, 1);
    // The 1080x1920 rendition was followed rather than the 576x1024 one.
    let asked: Vec<String> = fixture
        .requests()
        .iter()
        .map(|request| request.target.clone())
        .collect();
    assert!(
        asked.iter().any(|target| target.contains("high.m3u8")),
        "the higher rendition should have been followed: {asked:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_accounting_invariant_holds_for_a_mixed_board() {
    let board: BoardRef = "user/board".parse().unwrap();
    let fixture = Fixture::start(common::resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 3, "section_count": 0
    })));
    let one = format!("{}/originals/1.png", fixture.base());
    fixture.then(common::resource_page(
        serde_json::json!([
            {"id": "111", "images": {"orig": {"url": one.clone()}}},
            {
                "id": "222",
                "is_eligible_for_image_download": false,
                "images": {"orig": {"url": one.clone()}}
            },
            {"id": "333", "is_eligible_for_image_download": true}
        ]),
        "-end-",
    ));
    // Pin detail records: the feed does not carry eligibility, so every pin is
    // re-fetched in detail form before it is classified.
    fixture.then(common::resource_response(serde_json::json!({
        "id": "111",
        "is_eligible_for_image_download": true,
        "images": {"orig": {"url": one.clone()}}
    })));
    fixture.then(common::resource_response(serde_json::json!({
        "id": "222",
        "is_eligible_for_image_download": false,
        "images": {"orig": {"url": one.clone()}}
    })));
    fixture.then(common::resource_response(serde_json::json!({
        "id": "333", "is_eligible_for_image_download": true
    })));
    // The one eligible pin's media.
    fixture.then(Reply::body("PNG-BYTES"));

    let client = PinterestClient::with_base(fixture.base()).unwrap();
    client.set_cookies("_pinterest_sess=secret");
    let result = enumerate(&client, &board, 3).await.unwrap();

    let mut downloaded = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    let dir = scratch("accounting");
    let downloader = Downloader::new().unwrap();
    for pin in &result.pins {
        // A pin Pinterest does not permit is skipped, never attempted through a
        // workaround, and the reason is recorded.
        if pin.eligibility == pinpull::board::Eligibility::Ineligible {
            skipped += 1;
            continue;
        }
        let items = pin.data.as_ref().map(select_media).unwrap_or_default();
        if items.is_empty() {
            skipped += 1;
            continue;
        }
        let mut ok = true;
        for (media, stem) in items.iter().zip(output_stems(&pin.id, &items).iter()) {
            if downloader.fetch(media, stem, &dir).await.is_err() {
                ok = false;
            }
        }
        if ok {
            downloaded += 1;
        } else {
            failed += 1;
        }
    }
    // Every discovered pin ends in exactly one of the three outcomes.
    assert_eq!(
        downloaded + skipped + failed,
        u64::try_from(result.pins.len()).unwrap()
    );
    assert_eq!(result.pins.len(), 3);
    assert_eq!(skipped, 2, "the ineligible pin and the media-less pin skip");
    assert_eq!(downloaded, 1);
    assert_eq!(failed, 0);
    assert_eq!(read_dir(&dir), vec!["111.png".to_owned()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_ineligible_pin_is_recognised_as_a_skip() {
    // Selection reports the media Pinterest published; the eligibility gate is
    // what stops it. The two are separate so a media list can never be the thing
    // that decides whether a pin is permitted.
    let ineligible = serde_json::json!({
        "id": "222",
        "is_eligible_for_image_download": false,
        "images": {"orig": {"url": "https://i.pinimg.com/originals/2.png"}}
    });
    let eligible = serde_json::json!({
        "id": "111",
        "is_eligible_for_image_download": true,
        "images": {"orig": {"url": "https://i.pinimg.com/originals/1.png"}}
    });
    use pinpull::board::Eligibility;
    assert_eq!(
        pinpull::board::eligibility_from(&ineligible),
        Eligibility::Ineligible
    );
    assert_eq!(
        pinpull::board::eligibility_from(&eligible),
        Eligibility::Eligible
    );
    // Selection is not the gate: it would name media either way.
    assert_eq!(
        select_media(&ineligible).len(),
        select_media(&eligible).len()
    );
    // What must never happen is a request for the ineligible pin's media, which
    // the caller prevents by checking eligibility before selecting.
}

#[tokio::test]
async fn an_unsupported_pin_type_is_accounted_for() {
    // A pin with no recognizable media at all reports nothing to download
    // rather than being dropped silently.
    for pin in [
        serde_json::json!({"id": "1"}),
        serde_json::json!({"id": "2", "images": null}),
        serde_json::json!({"id": "3", "images": {}}),
        serde_json::json!({"id": "4", "videos": {"video_list": {}}}),
        serde_json::json!({"id": "5", "story_pin_data": {"pages": []}}),
    ] {
        assert!(
            select_media(&pin).is_empty(),
            "no media should be produced for {pin}"
        );
    }
}
