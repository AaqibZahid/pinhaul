use std::collections::{HashMap, HashSet};
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use crate::error::{PinpullError, Result};
use crate::input::BoardRef;
use crate::pinterest::{PinterestClient, absolutize};

#[derive(Debug, Clone)]
pub struct BoardInfo {
    pub id: String,
    pub name: String,
    pub url: String,
    pub pin_count: Option<u64>,
    pub section_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Ineligible,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PinSource {
    BoardFeed,
    Section(String),
}

impl fmt::Display for PinSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PinSource::BoardFeed => write!(f, "board feed"),
            PinSource::Section(name) => write!(f, "section {name}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredPin {
    pub id: String,
    pub eligibility: Eligibility,
    pub data: Option<Value>,
    pub source: PinSource,
    /// Why the pin could not be read, when it could not be read at all.
    pub failure: Option<String>,
}

#[derive(Debug)]
pub struct EnumerationResult {
    pub board: BoardInfo,
    pub pins: Vec<DiscoveredPin>,
    pub duplicate_encounters: u64,
}

struct Candidate {
    id: String,
    source: PinSource,
    feed_eligibility: Eligibility,
}

pub fn json_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub fn json_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub fn pin_id_of(item: &Value) -> Option<String> {
    let from_node = item
        .get("node_id")
        .and_then(Value::as_str)
        .and_then(|node| {
            STANDARD
                .decode(node)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|decoded| decoded.strip_prefix("Pin:").map(str::to_owned))
        });
    from_node
        .filter(|id| !id.is_empty())
        .or_else(|| json_string(item.get("id")))
}

/// Whether a feed item is a pin rather than a module the feed ends with.
///
/// Pinterest closes a board feed with modules such as "Related Interests",
/// whose items carry a fresh random id on every request and hold no pin data.
/// Counting one as a pin would invent a pin the board does not have, and make
/// the discovered count drift on every run.
pub fn is_pin(item: &Value) -> bool {
    if let Some(node) = item.get("node_id").and_then(Value::as_str) {
        // A pin is a node, and its node_id says which kind it is.
        let decoded = STANDARD
            .decode(node)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        return decoded.is_some_and(|decoded| decoded.starts_with("Pin:"));
    }
    // Without a node_id a pin still names itself in `type` and carries pin data,
    // and still has none of the fields a module has.
    item.get("story_type").is_none()
        && item.get("id").is_some_and(|id| !id.is_null())
        && (item.get("type").and_then(Value::as_str) == Some("pin")
            || ["images", "aggregated_pin_data", "pinner", "videos"]
                .iter()
                .any(|key| item.get(*key).is_some_and(|value| !value.is_null())))
}

pub fn eligibility_from(item: &Value) -> Eligibility {
    // The REST resource reports snake_case, the record embedded in a pin page
    // reports camelCase, and a pin must be classified the same either way.
    for key in [
        "is_eligible_for_image_download",
        "isEligibleForImageDownload",
    ] {
        match item.get(key) {
            Some(Value::Bool(true)) => return Eligibility::Eligible,
            Some(Value::Bool(false)) => return Eligibility::Ineligible,
            _ => {}
        }
    }
    Eligibility::Unknown
}

fn board_info(data: Value, board: &BoardRef) -> Result<BoardInfo> {
    let id = json_string(data.get("id")).ok_or_else(|| PinpullError::Pinterest {
        resource: "Board",
        message: "board response was missing an id".into(),
    })?;
    let name = json_string(data.get("name")).unwrap_or_default();
    let url = json_string(data.get("url"))
        .map(|url| absolutize(&url))
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| board.canonical_url());
    Ok(BoardInfo {
        id,
        name,
        url,
        pin_count: json_u64(data.get("pin_count")),
        section_count: json_u64(data.get("section_count")),
    })
}

fn section_name_of(section: &Value, section_id: &str) -> String {
    ["name", "title", "slug"]
        .iter()
        .filter_map(|key| json_string(section.get(key)))
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| section_id.to_string())
}

fn push_item(
    item: Value,
    source: PinSource,
    candidates: &mut Vec<Candidate>,
    seen: &mut HashSet<String>,
    duplicate_encounters: &mut u64,
) {
    // A feed item that is not a pin is a module the board feed ends with, not a
    // pin of the board.
    if !is_pin(&item) {
        return;
    }
    let Some(id) = pin_id_of(&item) else {
        return;
    };
    if !seen.insert(id.clone()) {
        *duplicate_encounters += 1;
        return;
    }
    let feed_eligibility = eligibility_from(&item);
    candidates.push(Candidate {
        id,
        source,
        feed_eligibility,
    });
}

pub async fn enumerate(
    client: &PinterestClient,
    board: &BoardRef,
    jobs: usize,
) -> Result<EnumerationResult> {
    let data = client.board(&board.username, &board.board_slug).await?;
    let info = board_info(data, board)?;

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut duplicate_encounters = 0u64;

    if info.section_count.unwrap_or(0) > 0 {
        let sections = client.board_sections(&info.id).await?;
        for section in &sections {
            let section_id =
                json_string(section.get("id")).ok_or_else(|| PinpullError::Pinterest {
                    resource: "BoardSections",
                    message: "section response was missing an id".into(),
                })?;
            let source = PinSource::Section(section_name_of(section, &section_id));
            let pins = client.board_section_pins(&section_id).await?;
            for item in pins {
                push_item(
                    item,
                    source.clone(),
                    &mut candidates,
                    &mut seen,
                    &mut duplicate_encounters,
                );
            }
        }
    }

    let feed = client.board_feed(&info.id).await?;
    for item in feed {
        push_item(
            item,
            PinSource::BoardFeed,
            &mut candidates,
            &mut seen,
            &mut duplicate_encounters,
        );
    }

    type DetailBatch = Vec<(String, std::result::Result<Value, String>)>;
    let mut set: tokio::task::JoinSet<Result<DetailBatch>> = tokio::task::JoinSet::new();
    for chunk in candidates.chunks(jobs.max(1)) {
        let ids: Vec<String> = chunk.iter().map(|candidate| candidate.id.clone()).collect();
        let client = client.clone();
        set.spawn(async move {
            let mut batch: DetailBatch = DetailBatch::new();
            for id in ids {
                // One pin's detail failing must not stop the board: the reason is
                // carried so the pin ends as a failure with something to say,
                // rather than taking the whole run down with it.
                let outcome = client.pin_detail(&id).await.map_err(|err| err.to_string());
                batch.push((id, outcome));
            }
            Ok(batch)
        });
    }
    let mut details: HashMap<String, std::result::Result<Value, String>> = HashMap::new();
    while let Some(joined) = set.join_next().await {
        let batch = joined??;
        details.extend(batch);
    }

    let pins = candidates
        .into_iter()
        .map(|candidate| match details.remove(&candidate.id) {
            Some(Ok(data)) => {
                let detail = eligibility_from(&data);
                let eligibility = if detail == Eligibility::Unknown {
                    candidate.feed_eligibility
                } else {
                    detail
                };
                DiscoveredPin {
                    id: candidate.id,
                    eligibility,
                    data: Some(data),
                    source: candidate.source,
                    failure: None,
                }
            }
            Some(Err(reason)) => DiscoveredPin {
                id: candidate.id,
                eligibility: candidate.feed_eligibility,
                data: None,
                source: candidate.source,
                failure: Some(reason),
            },
            None => DiscoveredPin {
                id: candidate.id,
                eligibility: candidate.feed_eligibility,
                data: None,
                source: candidate.source,
                failure: Some("the pin detail was never fetched".into()),
            },
        })
        .collect();

    Ok(EnumerationResult {
        board: info,
        pins,
        duplicate_encounters,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_module_at_the_end_of_a_feed_is_not_a_pin() {
        // Pinterest closes a board feed with "Related Interests", whose items
        // hold a fresh random id and no pin data.
        let module = json!({
            "id": "GtSJzuRT",
            "story_type": "related_interests_module",
            "title": {"format": "Related Interests"},
            "content_ids": [],
            "type": "story"
        });
        assert!(!is_pin(&module));
        assert_eq!(pin_id_of(&module).as_deref(), Some("GtSJzuRT"));

        // ... and that module never reaches the candidate list.
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        let mut duplicates = 0u64;
        push_item(
            module,
            PinSource::BoardFeed,
            &mut candidates,
            &mut seen,
            &mut duplicates,
        );
        assert!(
            candidates.is_empty(),
            "a module must not be a discovered pin"
        );
    }

    #[test]
    fn a_real_pin_is_recognised() {
        let pin = image_pin_fixture();
        assert!(is_pin(&pin));
        assert_eq!(pin_id_of(&pin).as_deref(), Some("1136033074790855749"));
    }

    #[test]
    fn a_pin_without_a_node_id_is_still_a_pin() {
        // A pin that names itself in `type` and carries pin data counts.
        let pin = json!({
            "id": "1136033074790855749",
            "type": "pin",
            "images": {"orig": {"url": "https://x/a.png"}}
        });
        assert!(is_pin(&pin));
    }

    #[test]
    fn a_pin_missing_media_but_named_is_still_a_pin() {
        // Eligibility is decided later; a pin with no media anywhere is still a
        // pin, and is skipped as such rather than dropped from discovery.
        let pin = json!({
            "id": "1136033074790855749",
            "node_id": "UGluOjExMzYwMzMwNzQ3OTA4NTU3NDk="
        });
        assert!(is_pin(&pin));
    }

    fn image_pin_fixture() -> serde_json::Value {
        json!({
            "node_id": "UGluOjExMzYwMzMwNzQ3OTA4NTU3NDk=",
            "id": "1136033074790855749",
            "type": "pin",
            "images": {"orig": {"url": "https://i.pinimg.com/originals/a.png"}}
        })
    }

    #[test]
    fn pin_id_decodes_node_id() {
        assert_eq!(
            pin_id_of(&json!({"node_id": "UGluOjExMzYwMzMwNzQ3OTA4NTU3NDk="})),
            Some("1136033074790855749".to_string())
        );
    }

    #[test]
    fn pin_id_prefers_node_id_and_falls_back_to_id() {
        assert_eq!(
            pin_id_of(&json!({"node_id": "UGluOjEyMw==", "id": "999"})),
            Some("123".to_string())
        );
        assert_eq!(pin_id_of(&json!({"id": "42"})), Some("42".to_string()));
        assert_eq!(pin_id_of(&json!({"id": 42})), Some("42".to_string()));
    }

    #[test]
    fn pin_id_missing_or_unusable_is_none() {
        assert_eq!(pin_id_of(&json!({})), None);
        assert_eq!(pin_id_of(&json!({"id": ""})), None);
        assert_eq!(pin_id_of(&json!({"node_id": "not base64!!"})), None);
        assert_eq!(pin_id_of(&json!({"node_id": "dGVzdA=="})), None);
    }

    #[test]
    fn eligibility_has_three_states() {
        assert_eq!(
            eligibility_from(&json!({"is_eligible_for_image_download": true})),
            Eligibility::Eligible
        );
        assert_eq!(
            eligibility_from(&json!({"is_eligible_for_image_download": false})),
            Eligibility::Ineligible
        );
        assert_eq!(eligibility_from(&json!({})), Eligibility::Unknown);
        assert_eq!(
            eligibility_from(&json!({"is_eligible_for_image_download": "true"})),
            Eligibility::Unknown
        );
    }

    #[test]
    fn eligibility_reads_the_camelcase_the_pin_page_reports() {
        // The record embedded in a pin page spells it differently to the REST
        // resource, and a pin must be classified the same either way.
        assert_eq!(
            eligibility_from(&json!({"isEligibleForImageDownload": true})),
            Eligibility::Eligible
        );
        assert_eq!(
            eligibility_from(&json!({"isEligibleForImageDownload": false})),
            Eligibility::Ineligible
        );
        assert_eq!(
            eligibility_from(&json!({"isEligibleForImageDownload": "true"})),
            Eligibility::Unknown
        );
        assert_eq!(
            eligibility_from(&json!({"isEligibleForImageDownload": null})),
            Eligibility::Unknown
        );
        // An empty value is unknown, not eligible.
        assert_eq!(
            eligibility_from(&json!({"is_eligible_for_image_download": ""})),
            Eligibility::Unknown
        );
    }

    #[test]
    fn push_item_dedups_by_pin_id_and_skips_idless() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        let mut dupes = 0u64;
        push_item(
            json!({"node_id": "UGluOjEyMw==", "is_eligible_for_image_download": true}),
            PinSource::BoardFeed,
            &mut candidates,
            &mut seen,
            &mut dupes,
        );
        // The same pin again, this time reached through a section.
        push_item(
            json!({"node_id": "UGluOjEyMw=="}),
            PinSource::Section("Mardi Gras".into()),
            &mut candidates,
            &mut seen,
            &mut dupes,
        );
        push_item(
            json!({"no_id": true}),
            PinSource::BoardFeed,
            &mut candidates,
            &mut seen,
            &mut dupes,
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(dupes, 1);
        assert_eq!(candidates[0].id, "123");
        assert_eq!(candidates[0].feed_eligibility, Eligibility::Eligible);
        assert_eq!(candidates[0].source, PinSource::BoardFeed);
    }

    #[test]
    fn board_info_reads_probe_fields() {
        let board: BoardRef = "user/board-name".parse().unwrap();
        let info = board_info(
            json!({
                "id": 1136033143445898365u64,
                "name": "The Wilderkind Collection",
                "url": "/chamberlaincoffeepins/the-wilderkind-collection/",
                "pin_count": 45,
                "section_count": 0
            }),
            &board,
        )
        .unwrap();
        assert_eq!(info.id, "1136033143445898365");
        assert_eq!(info.name, "The Wilderkind Collection");
        assert_eq!(
            info.url,
            "https://www.pinterest.com/chamberlaincoffeepins/the-wilderkind-collection/"
        );
        assert_eq!(info.pin_count, Some(45));
        assert_eq!(info.section_count, Some(0));
    }

    #[test]
    fn board_info_requires_id_and_falls_back_url() {
        let board: BoardRef = "user/board-name".parse().unwrap();
        let err = board_info(json!({"name": "x"}), &board).unwrap_err();
        assert!(matches!(
            err,
            PinpullError::Pinterest {
                resource: "Board",
                ..
            }
        ));
        let info = board_info(json!({"id": "1", "url": ""}), &board).unwrap();
        assert_eq!(info.url, board.canonical_url());
        assert_eq!(info.pin_count, None);
        assert_eq!(info.section_count, None);
    }

    #[test]
    fn section_name_falls_back_to_id() {
        assert_eq!(
            section_name_of(&json!({"name": "Mardi Gras"}), "9"),
            "Mardi Gras"
        );
        assert_eq!(section_name_of(&json!({"title": "T"}), "9"), "T");
        assert_eq!(section_name_of(&json!({"slug": "s"}), "9"), "s");
        assert_eq!(section_name_of(&json!({}), "9"), "9");
        assert_eq!(section_name_of(&json!({"name": ""}), "9"), "9");
    }

    #[test]
    fn source_display_is_readable() {
        assert_eq!(PinSource::BoardFeed.to_string(), "board feed");
        assert_eq!(
            PinSource::Section("Mardi Gras".into()).to_string(),
            "section Mardi Gras"
        );
    }
}
