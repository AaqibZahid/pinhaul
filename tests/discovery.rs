//! Discovery: pagination, sections, duplicate pins, and failure handling.
//!
//! Every test here talks to a fixture server, so the enumeration code is
//! exercised the same way it runs against Pinterest without needing a session.

mod common;

use common::{Fixture, Reply, image_pin, resource_page, resource_response, scratch};

use pinpull::board::{Eligibility, enumerate};
use pinpull::input::BoardRef;
use pinpull::pinterest::PinterestClient;

fn client_with(base: &str, cookie: &str) -> PinterestClient {
    let client = PinterestClient::with_base(base).unwrap();
    client.set_cookies(cookie);
    client
}

/// The fixture's URL, and a client pointed at it with a session installed.
fn fixture_client(fixture: &Fixture) -> PinterestClient {
    client_with(fixture.base(), "_pinterest_sess=secret")
}

#[tokio::test]
async fn a_board_with_no_sections_reads_its_feed_across_pages() {
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1136033143445898365",
        "name": "The Wilderkind Collection",
        "url": "/chamberlaincoffeepins/the-wilderkind-collection/",
        "pin_count": 3,
        "section_count": 0
    })));
    // Three feed pages: two pins, then one, then the end.
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("111", "https://i.pinimg.com/originals/1.png"),
            image_pin("222", "https://i.pinimg.com/originals/2.png")
        ]),
        "cursor1",
    ));
    fixture.then(resource_page(
        serde_json::json!([image_pin("333", "https://i.pinimg.com/originals/3.png")]),
        "-end-",
    ));

    let client = fixture_client(&fixture);
    let board: BoardRef = "user/board".parse().unwrap();
    let result = enumerate(&client, &board, 2).await.unwrap();

    assert_eq!(result.board.id, "1136033143445898365");
    assert_eq!(result.board.name, "The Wilderkind Collection");
    assert_eq!(result.pins.len(), 3, "pagination must not stop at page one");
    assert_eq!(result.duplicate_encounters, 0);
    assert!(
        result
            .pins
            .iter()
            .all(|pin| pin.eligibility == Eligibility::Eligible)
    );
}

#[tokio::test]
async fn a_repeated_pin_id_is_counted_once_as_a_duplicate() {
    let board: BoardRef = "user/board".parse().unwrap();
    // The pin appears twice in one feed page and once more across pages, which
    // is what a page reload during pagination produces.
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 3, "section_count": 0
    })));
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("111", "https://i.pinimg.com/originals/1.png"),
            image_pin("111", "https://i.pinimg.com/originals/1.png"),
            image_pin("222", "https://i.pinimg.com/originals/2.png")
        ]),
        "cursor1",
    ));
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("222", "https://i.pinimg.com/originals/2.png"),
            image_pin("333", "https://i.pinimg.com/originals/3.png")
        ]),
        "-end-",
    ));

    let client = fixture_client(&fixture);
    let result = enumerate(&client, &board, 4).await.unwrap();

    let ids: Vec<&str> = result.pins.iter().map(|pin| pin.id.as_str()).collect();
    assert_eq!(ids, vec!["111", "222", "333"]);
    assert_eq!(result.pins.len(), 3, "duplicates are not recorded as pins");
    // Two of the three pages repeat a pin already seen.
    assert_eq!(result.duplicate_encounters, 2);
}

#[tokio::test]
async fn section_pins_are_included_in_the_board() {
    let board: BoardRef = "user/board".parse().unwrap();
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 4, "section_count": 1
    })));
    fixture.then(resource_response(serde_json::json!([
        {"id": "s1", "name": "Mardi Gras"}
    ])));
    fixture.then(resource_page(
        serde_json::json!([image_pin("111", "https://i.pinimg.com/originals/1.png")]),
        "-end-",
    ));
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("222", "https://i.pinimg.com/originals/2.png"),
            image_pin("333", "https://i.pinimg.com/originals/3.png"),
            image_pin("444", "https://i.pinimg.com/originals/4.png")
        ]),
        "-end-",
    ));

    let client = fixture_client(&fixture);
    let result = enumerate(&client, &board, 4).await.unwrap();

    assert_eq!(result.pins.len(), 4, "section pins must not be lost");
    let mut ids: Vec<&str> = result.pins.iter().map(|pin| pin.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec!["111", "222", "333", "444"]);
    assert!(
        result
            .pins
            .iter()
            .any(|pin| pin.source.to_string() == "section Mardi Gras"),
        "a section pin should say which section it came from"
    );
}

#[tokio::test]
async fn a_stop_prefix_bookmark_ends_pagination() {
    let board: BoardRef = "user/board".parse().unwrap();
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 1, "section_count": 0
    })));
    // A bookmark that Pinterest sends when there is nothing left to page.
    fixture.then(resource_page(
        serde_json::json!([image_pin("111", "https://i.pinimg.com/originals/1.png")]),
        "Y2JOb25lO3Nlcg==",
    ));

    let client = fixture_client(&fixture);
    let result = enumerate(&client, &board, 4).await;
    let result = result.unwrap();
    assert_eq!(result.pins.len(), 1);
    // The board, one feed page, and the pin's detail record.
    assert_eq!(fixture.request_count(), 3);
}

#[tokio::test]
async fn a_module_at_the_end_of_a_feed_is_not_a_pin() {
    let board: BoardRef = "user/board".parse().unwrap();
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 45, "section_count": 0
    })));
    // One real pin, then the "Related Interests" module Pinterest closes a board
    // feed with, whose id is fresh on every request.
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("111", "https://i.pinimg.com/originals/1.png"),
            {
                "id": "GtSJzuRT",
                "type": "story",
                "story_type": "related_interests_module",
                "title": {"format": "Related Interests"},
                "content_ids": []
            }
        ]),
        "-end-",
    ));

    let client = fixture_client(&fixture);
    let result = enumerate(&client, &board, 4).await.unwrap();
    assert_eq!(result.pins.len(), 1, "a module is not a pin of the board");
    assert_eq!(result.pins[0].id, "111");
}

#[tokio::test]
async fn a_private_board_refuses_with_an_explicit_error() {
    let board: BoardRef = "user/board".parse().unwrap();
    // Pinterest answers 403 for a board the session may not see.
    let fixture = Fixture::start(Reply::body("{}").status(403));
    let client = fixture_client(&fixture);
    let error = enumerate(&client, &board, 4).await.unwrap_err();
    assert!(
        matches!(
            error,
            pinpull::error::PinpullError::HttpStatus { status: 403, .. }
        ),
        "a 403 must fail the run, not be retried forever: {error}"
    );
}

#[tokio::test]
async fn a_deleted_board_is_reported_not_swallowed() {
    let board: BoardRef = "user/board".parse().unwrap();
    let fixture = Fixture::start(Reply::body("{}").status(404));
    let client = fixture_client(&fixture);
    let error = enumerate(&client, &board, 4).await.unwrap_err();
    assert!(
        matches!(
            error,
            pinpull::error::PinpullError::HttpStatus { status: 404, .. }
        ),
        "a 404 must fail the run: {error}"
    );
}

#[tokio::test]
async fn a_malformed_board_response_is_not_guessed_at() {
    let board: BoardRef = "user/board".parse().unwrap();
    // A success body with no data field, which is not a board.
    let fixture = Fixture::start(Reply::body(r#"{"resource_response":{"status":"success"}}"#));
    let client = fixture_client(&fixture);
    let error = enumerate(&client, &board, 4).await.unwrap_err();
    assert!(
        error.to_string().contains("no data") || error.to_string().contains("board"),
        "an empty response must name the problem: {error}"
    );
}

#[tokio::test]
async fn a_403_on_pin_detail_does_not_stop_the_board() {
    let board: BoardRef = "user/board".parse().unwrap();
    // The board reads fine, but every pin's detail refuses. Both pins still end
    // as failures carrying the reason, and the board is still reported whole.
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 2, "section_count": 0
    })));
    fixture.then(resource_page(
        serde_json::json!([
            image_pin("111", "https://i.pinimg.com/originals/1.png"),
            image_pin("222", "https://i.pinimg.com/originals/2.png")
        ]),
        "-end-",
    ));
    fixture.then(Reply::body("{}").status(403));
    fixture.then(Reply::body("{}").status(403));

    let client = fixture_client(&fixture);
    let result = enumerate(&client, &board, 1).await.unwrap();
    assert_eq!(result.pins.len(), 2, "both pins are still discovered");
    let failures: Vec<&str> = result
        .pins
        .iter()
        .filter_map(|pin| pin.failure.as_deref())
        .collect();
    assert_eq!(failures.len(), 2, "both pins carry a failure: {failures:?}");
    for failure in &failures {
        assert!(
            failure.contains("403"),
            "the reason names the status: {failure}"
        );
    }
    assert_eq!(
        result.pins.iter().filter(|pin| pin.data.is_some()).count(),
        0
    );
}

#[tokio::test]
async fn the_client_sends_the_session_cookie_it_was_given() {
    let fixture = Fixture::start(resource_response(serde_json::json!({
        "id": "1", "name": "b", "pin_count": 0, "section_count": 0
    })));
    fixture.then(resource_page(serde_json::json!([]), "-end-"));
    let client = client_with(fixture.base(), "_pinterest_sess=abc; csrftoken=tok");
    let board: BoardRef = "user/board".parse().unwrap();
    enumerate(&client, &board, 1).await.unwrap();

    let requests = fixture.requests();
    let cookies: Vec<&str> = requests
        .iter()
        .filter_map(|request| request.header("cookie"))
        .collect();
    assert!(!cookies.is_empty(), "the session cookie must be sent");
    assert!(
        cookies.iter().all(|cookie| {
            cookie.contains("_pinterest_sess=abc") && cookie.contains("csrftoken=tok")
        }),
        "the installed session cookie was sent: {cookies:?}"
    );
    // Without a session the request falls back to a csrf token alone.
    let anon = PinterestClient::new().unwrap();
    let _ = anon;
}

#[tokio::test]
async fn a_scratch_directory_ends_the_test_clean() {
    let dir = scratch("no-media-here");
    assert!(!dir.join("checkpoint.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
    assert!(!dir.exists());
}
