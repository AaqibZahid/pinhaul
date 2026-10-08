//! Choosing what to write for a pin.
//!
//! Pinterest reports a pin's media in a handful of shapes: a plain image pin, a
//! classic video pin, a carousel, and tall story pins built from pages of
//! blocks. The REST resource speaks snake_case while the relay payload embedded
//! in pin pages speaks camelCase, and both show up depending on where the
//! record came from, so everything here is matched by field name on raw JSON
//! rather than by a single Rust struct.

use serde_json::Value;

use crate::board::{json_string, json_u64};
use crate::pinterest::absolutize;

/// What the chosen candidate is, and therefore how its bytes have to be turned
/// into a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    /// A still image the server already holds in full.
    Image,
    /// A video file the server already holds in full.
    VideoFile,
    /// A video playlist whose segments must be fetched, decrypted and joined.
    VideoHls,
}

impl MediaKind {
    /// Whether the candidate has to go through HLS assembly.
    pub fn is_playlist(&self) -> bool {
        matches!(self, MediaKind::VideoHls)
    }

    /// Whether the candidate carries motion rather than a still image.
    pub fn is_video(&self) -> bool {
        matches!(self, MediaKind::VideoFile | MediaKind::VideoHls)
    }
}

/// One file a pin contributes to the output directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaItem {
    /// Tells apart several files from the same pin (carousel slot, story page).
    pub label: String,
    pub url: String,
    pub kind: MediaKind,
}

/// What a single source promised, before competing against the alternatives.
#[derive(Debug, Clone)]
struct Candidate {
    label: String,
    url: String,
    kind: MediaKind,
    width: u64,
    height: u64,
    duration_ms: u64,
}

impl Candidate {
    /// An image candidate. The URL is made absolute because a relay payload can
    /// report one relative to Pinterest's own origin.
    fn image(label: &str, url: &str, value: &Value) -> Self {
        Self {
            label: label.to_owned(),
            url: absolutize(url),
            kind: MediaKind::Image,
            width: json_u64(value.get("width")).unwrap_or(0),
            height: json_u64(value.get("height")).unwrap_or(0),
            duration_ms: 0,
        }
    }

    /// A video candidate, classified from how Pinterest names the URL.
    fn video(label: &str, url: &str, value: &Value) -> Self {
        Self {
            label: label.to_owned(),
            url: absolutize(url),
            kind: classify(url),
            width: json_u64(value.get("width")).unwrap_or(0),
            height: json_u64(value.get("height")).unwrap_or(0),
            duration_ms: json_u64(value.get("duration")).unwrap_or(0),
        }
    }

    fn pixels(&self) -> u64 {
        self.width.saturating_mul(self.height)
    }

    /// A larger frame wins; at equal size a ready-made file beats an HLS
    /// playlist, which is what the README asks for.
    fn beats(&self, other: &Self) -> bool {
        (
            self.pixels(),
            self.kind == MediaKind::VideoFile,
            self.duration_ms,
        ) > (
            other.pixels(),
            other.kind == MediaKind::VideoFile,
            other.duration_ms,
        )
    }
}

/// Decides how a URL has to be fetched from how Pinterest names it.
fn classify(url: &str) -> MediaKind {
    let path = url.split('#').next().unwrap_or(url);
    let path = path.split('?').next().unwrap_or(path);
    if path.ends_with(".m3u8") || path.contains("/hls/") {
        MediaKind::VideoHls
    } else {
        MediaKind::VideoFile
    }
}

/// The media files an eligible pin should produce, in the order they are
/// written. Ineligible pins never reach this function; the caller gates them.
pub fn select_media(pin: &Value) -> Vec<MediaItem> {
    let videos = select_videos(pin);
    if !videos.is_empty() {
        return videos;
    }
    select_images(pin)
}

/// The output stems a pin's items write to: several files are qualified by
/// their label, a single file keeps the bare pin id.
pub fn output_stems(pin_id: &str, items: &[MediaItem]) -> Vec<String> {
    match items.len() {
        0 => Vec::new(),
        1 => vec![pin_id.to_owned()],
        _ => items
            .iter()
            .map(|item| format!("{pin_id}_{}", item.label))
            .collect(),
    }
}

/// A pin carries at most one video worth downloading, so every video
/// candidate is compared and only the best is kept.
fn select_videos(pin: &Value) -> Vec<MediaItem> {
    let mut candidates: Vec<Candidate> = Vec::new();
    for source in video_sources(pin) {
        collect_video_urls(source, 3, &mut candidates);
    }
    let best = candidates.into_iter().reduce(|best, candidate| {
        if candidate.beats(&best) {
            candidate
        } else {
            best
        }
    });
    best.map(|candidate| {
        vec![MediaItem {
            label: candidate.label,
            url: candidate.url,
            kind: candidate.kind,
        }]
    })
    .unwrap_or_default()
}

/// Every place a pin can hide video variants in, REST and relay shaped alike.
fn video_sources(pin: &Value) -> Vec<&Value> {
    let mut sources = Vec::new();
    if let Some(videos) = non_null(pin.get("videos")) {
        sources.push(videos);
    }
    for page in story_pages(pin) {
        let Some(blocks) = page.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            for key in ["videoDataV2", "video"] {
                if let Some(video) = non_null(block.get(key)) {
                    sources.push(video);
                }
            }
        }
    }
    sources
}

/// Walks a variant map down to the leaves that actually carry a URL. Pinterest
/// reports partial variants (a duration or a `__typename` only) that must not
/// be mistaken for a downloadable rendition, so a leaf counts only when its
/// `url` field is a non-empty string.
fn collect_video_urls(value: &Value, depth: u8, out: &mut Vec<Candidate>) {
    if depth == 0 {
        return;
    }
    let url = json_string(value.get("url")).filter(|url| !url.is_empty());
    match url {
        Some(url) => out.push(Candidate::video(VIDEO_LABEL, &url, value)),
        None => {
            if let Some(map) = value.as_object() {
                for nested in map.values() {
                    collect_video_urls(nested, depth - 1, out);
                }
            }
        }
    }
}

const VIDEO_LABEL: &str = "video";

/// One image per carousel slot, one per story page, or the single best image
/// of a plain pin.
fn select_images(pin: &Value) -> Vec<MediaItem> {
    let slots = carousel_slots(pin);
    if !slots.is_empty() {
        return slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| best_image(slot, &(index + 1).to_string()))
            .map(|candidate: Candidate| MediaItem {
                label: candidate.label,
                url: candidate.url,
                kind: candidate.kind,
            })
            .collect();
    }

    let pages = story_pages(pin);
    if !pages.is_empty() {
        return pages
            .iter()
            .enumerate()
            .filter_map(|(index, page)| {
                // A page that plays a video contributes the video, already
                // handled by select_videos, not a poster frame.
                if page_has_video(page) {
                    return None;
                }
                best_image(page, &(index + 1).to_string())
            })
            .map(|candidate: Candidate| MediaItem {
                label: candidate.label,
                url: candidate.url,
                kind: candidate.kind,
            })
            .collect();
    }

    best_image(pin, IMAGE_LABEL)
        .map(|candidate| MediaItem {
            label: candidate.label,
            url: candidate.url,
            kind: candidate.kind,
        })
        .into_iter()
        .collect()
}

const IMAGE_LABEL: &str = "image";

/// The largest rendition a source offers, preferring the untouched original
/// whenever Pinterest published one.
fn best_image(container: &Value, label: &str) -> Option<Candidate> {
    let variants = image_source(container)?;
    for key in ["orig", "originals"] {
        if let Some(variant) = variants.get(key)
            && let Some(url) = json_string(variant.get("url")).filter(|url| !url.is_empty())
        {
            return Some(Candidate::image(label, &url, variant));
        }
    }
    image_candidates(variants, label)
        .into_iter()
        .max_by_key(|candidate| (candidate.pixels(), candidate.kind == MediaKind::VideoFile))
}

/// Where a container keeps its image variants.
fn image_source(container: &Value) -> Option<&Value> {
    [
        "images_originals",
        "imageAdjustedSpec_orig",
        "images_orig",
        "images",
    ]
    .iter()
    .filter_map(|key| container.get(*key))
    .find(|value| !value.is_null())
}

/// Every rendition inside a variant map, read either as the REST shape
/// (`{"orig": {url, width, height}}`) or as the relay shape
/// (`{"url": ..., "width": ...}`).
fn image_candidates(variants: &Value, label: &str) -> Vec<Candidate> {
    if let Some(url) = json_string(variants.get("url")).filter(|url| !url.is_empty()) {
        return vec![Candidate::image(label, &url, variants)];
    }
    variants
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, value)| value.is_object())
        .filter_map(|(_, value)| {
            let url = json_string(value.get("url")).filter(|url| !url.is_empty())?;
            Some(Candidate::image(label, &url, value))
        })
        .collect()
}

/// Carousel pins list their slots directly or under a nested field, depending
/// on which API answered.
fn carousel_slots(pin: &Value) -> Vec<&Value> {
    for key in ["carousel_data", "carouselData"] {
        let Some(carousel) = non_null(pin.get(key)) else {
            continue;
        };
        for nested in ["carousel_slots", "carouselSlots"] {
            if let Some(slots) = carousel.get(nested).and_then(Value::as_array) {
                return slots.iter().collect();
            }
        }
        if let Some(slots) = carousel.as_array() {
            return slots.iter().collect();
        }
    }
    Vec::new()
}

/// Story pin pages, whichever spelling the record uses.
fn story_pages(pin: &Value) -> Vec<&Value> {
    ["story_pin_data", "storyPinData"]
        .iter()
        .filter_map(|key| non_null(pin.get(*key)))
        .filter_map(|story| story.get("pages").and_then(Value::as_array))
        .flat_map(|pages| pages.iter())
        .collect()
}

/// Whether a story page holds a playable block.
fn page_has_video(page: &Value) -> bool {
    let mut sources = Vec::new();
    if let Some(blocks) = page.get("blocks").and_then(Value::as_array) {
        for block in blocks {
            for key in ["videoDataV2", "video"] {
                if let Some(video) = non_null(block.get(key)) {
                    sources.push(video);
                }
            }
        }
    }
    sources
        .into_iter()
        .any(|source| !collect_video_urls_of(source).is_empty())
}

fn collect_video_urls_of(source: &Value) -> Vec<Candidate> {
    let mut out = Vec::new();
    collect_video_urls(source, 3, &mut out);
    out
}

fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn urls(pin: &Value) -> Vec<String> {
        select_media(pin).into_iter().map(|item| item.url).collect()
    }

    fn kinds(pin: &Value) -> Vec<MediaKind> {
        select_media(pin)
            .into_iter()
            .map(|item| item.kind)
            .collect()
    }

    fn labels(pin: &Value) -> Vec<String> {
        select_media(pin)
            .into_iter()
            .map(|item| item.label)
            .collect()
    }

    #[test]
    fn plain_image_uses_orig() {
        let pin = json!({
            "id": "1",
            "is_eligible_for_image_download": true,
            "images": {
                "orig": {"url": "https://i.pinimg.com/originals/a/orig.png", "width": 1989, "height": 3000},
                "474x": {"url": "https://i.pinimg.com/474x/a/small.jpg", "width": 474, "height": 719},
                "60x60": {"url": "https://i.pinimg.com/60x60/a/tiny.jpg", "width": 60, "height": 90}
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://i.pinimg.com/originals/a/orig.png".to_owned()]
        );
        assert_eq!(kinds(&pin), vec![MediaKind::Image]);
    }

    #[test]
    fn plain_image_without_orig_takes_the_largest_variant() {
        let pin = json!({
            "id": "1",
            "images": {
                "60x60": {"url": "https://i.pinimg.com/60x60/a/tiny.jpg", "width": 60, "height": 90},
                "474x": {"url": "https://i.pinimg.com/474x/a/small.jpg", "width": 474, "height": 719},
                "736x": {"url": "https://i.pinimg.com/736x/a/mid.jpg", "width": 576, "height": 842}
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://i.pinimg.com/736x/a/mid.jpg".to_owned()]
        );
    }

    #[test]
    fn orig_wins_even_when_a_variant_is_bigger_on_screen() {
        let pin = json!({
            "images": {
                "orig": {"url": "https://x/o.png", "width": 100, "height": 100},
                "736x": {"url": "https://x/big.png", "width": 4000, "height": 3000}
            }
        });
        assert_eq!(urls(&pin), vec!["https://x/o.png".to_owned()]);
    }

    #[test]
    fn relay_shaped_images_are_read() {
        // A story pin page reports its originals as flat objects.
        let pin = json!({
            "story_pin_data": {
                "pages": [{
                    "images_orig": {"url": "https://i.pinimg.com/originals/a.png", "height": 1024, "width": 576},
                    "imageAdjustedSpec_orig": null
                }]
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://i.pinimg.com/originals/a.png".to_owned()]
        );
    }

    #[test]
    fn carousel_yields_one_image_per_slot_in_order() {
        let pin = json!({
            "carousel_data": [
                {"images": {"orig": {"url": "https://x/1.png", "width": 10, "height": 10}}},
                {"images": {"orig": {"url": "https://x/2.png", "width": 10, "height": 10}}},
                {"images": {"orig": {"url": "https://x/3.png", "width": 10, "height": 10}}}
            ]
        });
        assert_eq!(
            urls(&pin),
            vec![
                "https://x/1.png".to_owned(),
                "https://x/2.png".to_owned(),
                "https://x/3.png".to_owned()
            ]
        );
        assert_eq!(labels(&pin), vec!["1", "2", "3"]);
    }

    #[test]
    fn nested_carousel_slots_are_unwrapped() {
        let pin = json!({
            "carouselData": {
                "carouselSlots": [
                    {"images": {"orig": {"url": "https://x/1.png"}}},
                    {"images": {"orig": {"url": "https://x/2.png"}}}
                ]
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://x/1.png".to_owned(), "https://x/2.png".to_owned()]
        );
    }

    #[test]
    fn a_slot_without_usable_media_drops_out() {
        let pin = json!({
            "carousel_data": [
                {"images": {"orig": {"url": "https://x/1.png"}}},
                {"images": null},
                {"images": {"orig": {"width": 5}}},
                {"images": {"orig": {"url": "https://x/4.png"}}}
            ]
        });
        assert_eq!(
            urls(&pin),
            vec!["https://x/1.png".to_owned(), "https://x/4.png".to_owned()]
        );
        // Labels follow the slot position, not the surviving count.
        assert_eq!(labels(&pin), vec!["1", "4"]);
    }

    #[test]
    fn classic_video_pin_picks_a_single_mp4() {
        let pin = json!({
            "is_video": true,
            "videos": {
                "video_list": {
                    "vHLSV4": {"url": "https://v1.pinimg.com/videos/ht/hls/a.m3u8", "width": 576, "height": 1024}
                },
                "video_list_720p": {
                    "v720p": {"url": "https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4", "width": 576, "height": 1024}
                }
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4".to_owned()]
        );
        assert_eq!(kinds(&pin), vec![MediaKind::VideoFile]);
        assert_eq!(labels(&pin), vec![video_label().to_owned()]);
    }

    #[test]
    fn hls_wins_when_it_is_the_higher_rendition() {
        let pin = json!({
            "videos": {
                "video_list": {
                    "vHLSV4": {"url": "https://v1.pinimg.com/videos/ht/hls/a.m3u8", "width": 1080, "height": 1920},
                    "v720P": {"url": "https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4", "width": 576, "height": 1024}
                }
            }
        });
        assert_eq!(
            urls(&pin),
            vec!["https://v1.pinimg.com/videos/ht/hls/a.m3u8".to_owned()]
        );
        assert_eq!(kinds(&pin), vec![MediaKind::VideoHls]);
    }

    #[test]
    fn story_pin_video_block_is_found_through_the_pages() {
        let pin = json!({
            "is_video": true,
            "story_pin_data": {
                "pages": [{
                    "blocks": [{
                        "__typename": "StoryPinVideoBlock",
                        "blockType": 3,
                        "videoDataV2": {
                            "videoListMobile": {
                                "vHLSV3MOBILE": {
                                    "url": "https://v1.pinimg.com/videos/iht/hls/6b/3e/a.m3u8",
                                    "width": 576, "height": 1024, "duration": 15000
                                }
                            },
                            "videoList": {"vHLSV3MOBILE": {"__typename": "VideoDetail"}},
                            "videoList720P": {
                                "v720P": {
                                    "url": "https://v1.pinimg.com/videos/iht/expMp4/6b/3e/a_720w.mp4",
                                    "width": 576, "height": 1024, "duration": 15000
                                }
                            }
                        }
                    }]
                }]
            }
        });
        // The two renditions tie, so the direct MP4 is preferred.
        assert_eq!(
            urls(&pin),
            vec!["https://v1.pinimg.com/videos/iht/expMp4/6b/3e/a_720w.mp4".to_owned()]
        );
    }

    #[test]
    fn a_story_video_page_contributes_no_poster_frame() {
        let pin = json!({
            "is_video": true,
            "story_pin_data": {
                "pages": [
                    {
                        "blocks": [{"videoDataV2": {"videoList": {"v720P": {"url": "https://x/a.mp4"}}}}],
                        "images_orig": {"url": "https://x/poster.png"}
                    },
                    {
                        "images_originals": {"url": "https://x/page2.png"}
                    }
                ]
            }
        });
        assert_eq!(urls(&pin), vec!["https://x/a.mp4".to_owned()]);
    }

    #[test]
    fn story_image_pages_each_yield_an_image() {
        let pin = json!({
            "story_pin_data": {
                "pages": [
                    {"images_orig": {"url": "https://x/p1.png", "width": 576, "height": 1024}},
                    {"images_orig": {"url": "https://x/p2.png", "width": 576, "height": 1024}},
                    {"images_orig": {"url": "https://x/p3.png", "width": 576, "height": 1024}}
                ]
            }
        });
        assert_eq!(
            urls(&pin),
            vec![
                "https://x/p1.png".to_owned(),
                "https://x/p2.png".to_owned(),
                "https://x/p3.png".to_owned()
            ]
        );
        assert_eq!(labels(&pin), vec!["1", "2", "3"]);
    }

    #[test]
    fn partial_video_variants_are_not_downloadable() {
        // A duration without a url, or a bare __typename, is not a rendition.
        let pin = json!({
            "videos": {
                "video_list": {
                    "vHLSV3MOBILE": {"duration": 15000, "captionsUrls": null},
                    "vHLSV4": {"__typename": "VideoDetail"}
                }
            }
        });
        // Nothing downloadable, so the pin's cover image is used instead.
        let pin = json!({
            "videos": pin["videos"].clone(),
            "images": {"orig": {"url": "https://x/cover.png"}}
        });
        assert_eq!(urls(&pin), vec!["https://x/cover.png".to_owned()]);
    }

    #[test]
    fn a_pin_with_no_media_yields_nothing() {
        assert!(select_media(&json!({"id": "1"})).is_empty());
        assert!(select_media(&json!({"id": "1", "images": null})).is_empty());
        assert!(select_media(&json!({"id": "1", "images": {}})).is_empty());
        assert!(select_media(&json!({"id": "1", "images": {"orig": {}}})).is_empty());
        assert!(select_media(&json!({"carousel_data": null, "story_pin_data": null})).is_empty());
    }

    #[test]
    fn classify_recognises_playlists_by_extension_and_path() {
        assert_eq!(
            classify("https://v1.pinimg.com/videos/iht/hls/6b/a.m3u8"),
            MediaKind::VideoHls
        );
        assert_eq!(
            classify("https://v1.pinimg.com/videos/iht/hls/6b/a.m3u8?token=1"),
            MediaKind::VideoHls
        );
        assert_eq!(
            classify("https://v1.pinimg.com/videos/iht/expMp4/6b/a_720w.mp4"),
            MediaKind::VideoFile
        );
        assert_eq!(
            classify("https://i.pinimg.com/originals/a/b.png"),
            MediaKind::VideoFile
        );
        assert_eq!(classify(""), MediaKind::VideoFile);
    }

    #[test]
    fn output_stems_qualify_only_when_there_are_several() {
        let one = vec![MediaItem {
            label: "1".into(),
            url: "https://x/a.png".into(),
            kind: MediaKind::VideoFile,
        }];
        assert_eq!(output_stems("123", &one), vec!["123".to_owned()]);

        let many = vec![
            MediaItem {
                label: "1".into(),
                url: "https://x/a.png".into(),
                kind: MediaKind::VideoFile,
            },
            MediaItem {
                label: "2".into(),
                url: "https://x/b.png".into(),
                kind: MediaKind::VideoFile,
            },
        ];
        assert_eq!(output_stems("123", &many), vec!["123_1", "123_2"]);
        assert!(output_stems("123", &[]).is_empty());
    }

    fn video_label() -> &'static str {
        VIDEO_LABEL
    }
}
