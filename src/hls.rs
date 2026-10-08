//! Reading an HLS playlist and decrypting its segments.
//!
//! Pinterest serves some videos only as an HLS playlist. Everything here is
//! pure string and bytes work: the playlist is parsed, the segment order is
//! fixed, and AES-128-CBC decryption happens in place on the bytes that were
//! fetched. Fetching lives in `download`, so this module can be tested with
//! recorded playlists and no network.

use aes::Aes128;
use cbc::Decryptor;
use cbc::cipher::generic_array::GenericArray;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};

use crate::error::{PinpullError, Result};

const BLOCK: usize = 16;

/// The kind of segment payload a media playlist declared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    /// MPEG-TS segments, the default HLS payload.
    Ts,
    /// Fragmented MP4, announced by `EXT-X-MAP`.
    Fmp4,
}

impl Container {
    /// The extension the joined file should carry. A playable MPEG-TS stream
    /// is written as `.ts`; only a fragmented-MP4 playlist may claim `.mp4`.
    pub fn extension(&self) -> &'static str {
        match self {
            Container::Fmp4 => "mp4",
            Container::Ts => "ts",
        }
    }
}

/// One encrypted or plain segment, resolved against the playlist's own URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub url: String,
    pub key: Option<Key>,
}

/// The AES-128 parameters that apply to a segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    /// Absolute URL of the 16-byte key.
    pub uri: String,
    /// The 16-byte IV for this segment.
    pub iv: [u8; 16],
    /// The `EXT-X-KEY` method; only AES-128 is understood.
    pub method: String,
}

/// A media playlist: the segments to join, in playback order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Playlist {
    pub segments: Vec<Segment>,
    /// The `EXT-X-MAP` initialization section, when the playlist has one.
    pub init: Option<Segment>,
    pub container: Container,
}

impl Playlist {
    /// The extension the joined bytes should be written with.
    pub fn extension(&self) -> &'static str {
        self.container.extension()
    }

    /// How many segment fetches the playlist needs, excluding the init section.
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }
}

/// A rendition listed by a master playlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    /// Absolute URL of the rendition's media playlist.
    pub url: String,
    pub bandwidth: u64,
    pub width: u64,
    pub height: u64,
}

impl Variant {
    /// A larger frame wins; at equal size a higher bitrate does.
    pub fn beats(&self, other: &Self) -> bool {
        (self.width.saturating_mul(self.height), self.bandwidth)
            > (other.width.saturating_mul(other.height), other.bandwidth)
    }
}

/// What a `.m3u8` URL turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Document {
    /// A master playlist: the caller has to pick a rendition and re-parse it.
    Master(Vec<Variant>),
    /// A media playlist: ready to fetch.
    Media(Playlist),
}

/// Parses an `.m3u8` document fetched from `playlist_url`.
pub fn parse(text: &str, playlist_url: &str) -> Result<Document> {
    // An HLS document always opens with #EXTM3U; without it the response is not
    // a playlist at all and must not be mined for segment URLs.
    let first = text
        .trim_start_matches('\u{feff}')
        .lines()
        .next()
        .unwrap_or("");
    if first.trim() != "#EXTM3U" {
        return Err(PinpullError::Hls {
            message: "the response is not an HLS playlist: it does not start with #EXTM3U".into(),
        });
    }

    let mut master: Vec<Variant> = Vec::new();
    let mut segments: Vec<Segment> = Vec::new();
    let mut init: Option<Segment> = None;

    // The key in force, reset by each EXT-X-KEY as RFC 8216 requires.
    let mut key: Option<Key> = None;
    let mut media_sequence: u64 = 0;
    let mut sequence = media_sequence;
    let mut pending_variant: Option<Variant> = None;
    let mut saw_stream_inf = false;
    let mut saw_segment = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(attrs) = tag_payload(line, "#EXT-X-STREAM-INF") {
            saw_stream_inf = true;
            let (width, height) = parse_resolution(attrs);
            pending_variant = Some(Variant {
                url: String::new(),
                bandwidth: attr_number(attrs, "BANDWIDTH").unwrap_or(0),
                width,
                height,
            });
            continue;
        }
        if let Some(attrs) = tag_payload(line, "#EXT-X-MEDIA-SEQUENCE") {
            media_sequence = attrs.trim().parse().unwrap_or(0);
            sequence = media_sequence;
            continue;
        }
        if let Some(attrs) = tag_payload(line, "#EXT-X-KEY") {
            key = parse_key(attrs, playlist_url, sequence)?;
            continue;
        }
        if let Some(attrs) = tag_payload(line, "#EXT-X-MAP") {
            init = Some(Segment {
                url: resolve(playlist_url, &attr_uri(attrs))?,
                key: key.clone(),
            });

            continue;
        }
        if line.starts_with('#') {
            // EXTINF, TARGETDURATION, ENDLIST and friends carry no URI.
            continue;
        }
        // A bare line is a URI: a variant when EXT-X-STREAM-INF preceded it,
        // a segment otherwise.
        let url = resolve(playlist_url, line)?;
        match pending_variant.take() {
            Some(mut variant) => {
                variant.url = url;
                master.push(variant);
            }
            None => {
                saw_segment = true;
                segments.push(Segment {
                    url,
                    key: key.clone(),
                });
                sequence += 1;
            }
        }
    }

    if saw_stream_inf && !saw_segment {
        return Ok(Document::Master(
            master
                .into_iter()
                .filter(|variant| !variant.url.is_empty())
                .collect(),
        ));
    }
    if segments.is_empty() {
        return Err(PinpullError::Hls {
            message: "the playlist held no segments".into(),
        });
    }
    // RFC 8216: without EXT-X-MAP the segments are MPEG-TS.
    let container = match init.as_ref() {
        Some(_) => Container::Fmp4,
        None => Container::Ts,
    };
    Ok(Document::Media(Playlist {
        segments,
        init,
        container,
    }))
}

/// Resolves a possibly relative reference against the playlist's own URL.
pub fn resolve(base: &str, reference: &str) -> Result<String> {
    url::Url::parse(base)
        .and_then(|base| base.join(reference))
        .map(|url| url.to_string())
        .map_err(|source| PinpullError::Hls {
            message: format!("could not resolve {reference} against {base}: {source}"),
        })
}

/// The IV for an encrypted segment when `EXT-X-KEY` did not carry one: the
/// media sequence number, rendered as a 128-bit big-endian integer.
pub fn derive_iv(media_sequence: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&media_sequence.to_be_bytes());
    iv
}

fn parse_key(attrs: &str, playlist_url: &str, sequence: u64) -> Result<Option<Key>> {
    let method = attr_value(attrs, "METHOD");
    if method.as_deref() == Some("NONE") {
        return Ok(None);
    }
    let uri = attr_uri(attrs);
    if uri.is_empty() {
        return Err(PinpullError::Hls {
            message: "an EXT-X-KEY tagged had no URI".into(),
        });
    }
    let iv = match attr_value(attrs, "IV") {
        Some(hex) => parse_iv(&hex).ok_or_else(|| PinpullError::Hls {
            message: format!("the EXT-X-KEY IV {hex} was not 32 hex digits"),
        })?,
        None => derive_iv(sequence),
    };
    Ok(Some(Key {
        uri: resolve(playlist_url, &uri)?,
        iv,
        method: method.unwrap_or_else(|| "AES-128".to_owned()),
    }))
}

/// Reads a 128-bit hexadecimal IV. RFC 8216 says the `0x` prefix is mandatory;
/// it is accepted without one too, because a server that omits it still means
/// exactly the same bytes and rejecting the playlist would only lose the video.
fn parse_iv(hex: &str) -> Option<[u8; 16]> {
    let hex = hex
        .strip_prefix("0x")
        .or_else(|| hex.strip_prefix("0X"))
        .unwrap_or(hex);
    if hex.len() != 32 {
        return None;
    }
    let mut iv = [0u8; 16];
    for (index, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk).ok()?;
        iv[index] = u8::from_str_radix(text, 16).ok()?;
    }
    Some(iv)
}

/// Decrypts `data` in place with AES-128-CBC and reports how many bytes were
/// decrypted. Only whole blocks are touched; a trailing partial block is left
/// exactly as it arrived.
pub fn decrypt_aes128_cbc(key: &[u8], iv: &[u8; 16], data: &mut [u8]) -> Result<usize> {
    let mut decryptor =
        Decryptor::<Aes128>::new_from_slices(key, &iv[..]).map_err(|_| PinpullError::Hls {
            message: "the AES-128 key was not 16 bytes long".into(),
        })?;
    let (blocks, _) = data.as_chunks_mut::<BLOCK>();
    for block in &mut *blocks {
        let mut buffer = GenericArray::clone_from_slice(block);
        decryptor.decrypt_blocks_mut(std::slice::from_mut(&mut buffer));
        block.copy_from_slice(&buffer);
    }
    Ok(blocks.len().saturating_mul(BLOCK))
}

/// Returns the payload after `tag:` when the line is that tag.
fn tag_payload<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(tag)?;
    if rest.is_empty() || rest.starts_with([',', ':', ' ']) {
        Some(rest.trim_start_matches(':'))
    } else {
        None
    }
}

/// Reads the quoted or bare value of an attribute.
fn attr_value(attrs: &str, name: &str) -> Option<String> {
    for part in attrs.split(',') {
        let (key, value) = part.split_once('=')?;
        if key.trim() != name {
            continue;
        }
        let value = value.trim().trim_matches('"');
        return (!value.is_empty()).then(|| value.to_owned());
    }
    None
}

/// Reads a numeric attribute, ignoring the `0x` prefix when present.
fn attr_number(attrs: &str, name: &str) -> Option<u64> {
    let raw = attr_value(attrs, name)?;
    let raw = raw.trim();
    let digits = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(raw);
    digits.parse().ok()
}

/// Splits a `RESOLUTION=<width>x<height>` attribute.
fn parse_resolution(attrs: &str) -> (u64, u64) {
    let Some(raw) = attr_value(attrs, "RESOLUTION") else {
        return (0, 0);
    };
    let lowered = raw.trim().to_lowercase();
    match lowered.split_once('x') {
        Some((width, height)) => (width.parse().unwrap_or(0), height.parse().unwrap_or(0)),
        None => (0, 0),
    }
}

fn attr_uri(attrs: &str) -> String {
    attr_value(attrs, "URI").unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAYLIST: &str = "\
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.00000,
videos/iht/seg0.ts
#EXTINF:6.00000,
videos/iht/seg1.ts
#EXT-X-ENDLIST
";

    const BASE: &str = "https://v1.pinimg.com/videos/iht/hls/6b3e1d3501afedb33a6f1368e1b89479.m3u8";

    #[test]
    fn plain_playlists_resolve_relative_segments_in_order() {
        let document = parse(PLAYLIST, BASE).unwrap();
        let Playlist {
            segments,
            init,
            container,
        } = match document {
            Document::Media(playlist) => playlist,
            Document::Master(_) => panic!("a media playlist was expected"),
        };
        assert_eq!(segments.len(), 2);
        // A relative segment replaces the playlist's own last path segment.
        assert_eq!(
            segments[0],
            Segment {
                url: "https://v1.pinimg.com/videos/iht/hls/videos/iht/seg0.ts".to_owned(),
                key: None,
            }
        );
        assert_eq!(
            segments[1].url,
            "https://v1.pinimg.com/videos/iht/hls/videos/iht/seg1.ts"
        );
        assert_eq!(init, None);
        assert_eq!(container, Container::Ts);
    }

    #[test]
    fn absolute_segment_urls_are_kept() {
        let text = PLAYLIST.replace("videos/iht/seg0.ts", "https://cdn.example/seg0.ts");
        let document = parse(&text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert_eq!(playlist.segments[0].url, "https://cdn.example/seg0.ts");
    }

    #[test]
    fn an_encrypted_playlist_carries_a_key_per_segment() {
        let text = "\
#EXTM3U
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.example/k.key\",IV=0x0123456789abcdeffedcba9876543210
#EXTINF:6.00000,
seg0.ts
#EXTINF:6.00000,
seg1.ts
#EXT-X-ENDLIST
";
        let document = parse(text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert_eq!(playlist.segments.len(), 2);
        assert!(playlist.segments.iter().all(|s| s.key.is_some()));
        for segment in &playlist.segments {
            let key = segment.key.as_ref().expect("a key");
            assert_eq!(key.uri, "https://keys.example/k.key");
            assert_eq!(key.method, "AES-128");
            assert_eq!(key.iv[0], 0x01);
            assert_eq!(key.iv[15], 0x10);
        }
    }

    #[test]
    fn a_key_without_an_iv_uses_the_media_sequence_number() {
        let text = "\
#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI=\"k.key\"
#EXTINF:1,
seg0.ts
#EXT-X-ENDLIST
";
        let document = parse(text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        let key = playlist.segments[0].key.clone().expect("a key");
        assert_eq!(key.iv, derive_iv(7));
        assert_eq!(key.uri, "https://v1.pinimg.com/videos/iht/hls/k.key");
    }

    #[test]
    fn method_none_means_plain_segments() {
        let text = "\
#EXTM3U
#EXT-X-KEY:METHOD=NONE
#EXTINF:1,
seg0.ts
#EXT-X-ENDLIST
";
        let document = parse(text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert_eq!(playlist.segments.len(), 1);
        assert!(
            playlist
                .segments
                .iter()
                .all(|segment| segment.key.is_none())
        );
    }

    #[test]
    fn fragmented_mp4_playlists_report_the_map_init_section() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI=\"init.mp4\"
#EXTINF:2,
seg0.m4s
#EXT-X-ENDLIST
";
        let document = parse(text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert_eq!(playlist.container, Container::Fmp4);
        assert_eq!(playlist.extension(), "mp4");
        let init = playlist.init.expect("an init section");
        assert_eq!(init.url, "https://v1.pinimg.com/videos/iht/hls/init.mp4");
        assert_eq!(playlist.segments.len(), 1);
        // MPEG-TS only gets a .ts extension.
        assert_eq!(Container::Ts.extension(), "ts");
    }

    #[test]
    fn a_master_playlist_reports_its_renditions() {
        let text = "\
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=576x1024
hls/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1080x1920
hls/high.m3u8
#EXT-X-ENDLIST
";
        let document = parse(text, BASE).unwrap();
        let Document::Master(variants) = document else {
            panic!("a master playlist was expected");
        };
        assert_eq!(variants.len(), 2);
        assert_eq!(
            variants[0].url,
            "https://v1.pinimg.com/videos/iht/hls/hls/low.m3u8"
        );
        assert_eq!(variants[0].bandwidth, 1280000);
        assert_eq!(variants[0].width, 576);
        assert_eq!(variants[0].height, 1024);
        assert!(variants[1].beats(&variants[0]));
    }

    #[test]
    fn a_playlist_without_segments_is_rejected() {
        assert!(parse("#EXTM3U\n#EXT-X-ENDLIST\n", BASE).is_err());
        assert!(parse("", BASE).is_err());
        // Not a playlist: no #EXTM3U opener.
        assert!(parse("not a playlist at all\n", BASE).is_err());
        assert!(parse("<html>challenge</html>\n", BASE).is_err());
    }

    #[test]
    fn a_utf8_bom_before_extm3u_is_tolerated() {
        let text = format!("\u{feff}{PLAYLIST}");
        assert!(parse(&text, BASE).is_ok());
    }

    #[test]
    fn comments_and_blank_lines_never_become_segments() {
        let text = "\
#EXTM3U\n\
\n\
# some comment\n\
#EXTINF:1,\n\
seg0.ts\n\
\n\
#EXT-X-ENDLIST\n\
";
        let document = parse(text, BASE).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert_eq!(playlist.segment_count(), 1);
        assert_eq!(
            playlist.segments[0].url,
            "https://v1.pinimg.com/videos/iht/hls/seg0.ts"
        );
    }

    #[test]
    fn a_query_string_on_the_playlist_url_does_not_leak_into_segments() {
        let base = format!("{BASE}?token=abc");
        let document = parse(PLAYLIST, &base).unwrap();
        let Document::Media(playlist) = document else {
            panic!("a media playlist was expected");
        };
        assert!(
            playlist
                .segments
                .iter()
                .all(|segment| !segment.url.contains("token"))
        );
    }

    #[test]
    fn iv_parsing_accepts_hex_and_rejects_junk() {
        let iv = parse_iv("0x0123456789abcdeffedcba9876543210").unwrap();
        assert_eq!(iv[0], 0x01);
        assert_eq!(iv[7], 0xef);
        assert_eq!(iv[8], 0xfe);
        assert_eq!(iv[15], 0x10);
        assert!(parse_iv("0123456789abcdeffedcba9876543210").is_some());
        assert!(parse_iv("0x123").is_none());
        assert!(parse_iv("0x123").is_none());
        assert!(parse_iv("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_none());
        assert!(parse_iv("0x").is_none());
        assert_eq!(derive_iv(0)[8..], [0u8; 8]);
        assert_eq!(derive_iv(256)[14], 1);
        assert_eq!(derive_iv(256)[15], 0);
    }

    #[test]
    fn aes128_cbc_matches_the_nist_vector() {
        // NIST SP 800-38A, F.2.1 CBC-AES128 Decrypt.
        let key = [
            0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf,
            0x4f, 0x3c,
        ];
        let iv = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f,
        ];
        let mut ciphertext = [
            0x76, 0x49, 0xab, 0xac, 0x81, 0x19, 0xb2, 0x46, 0xce, 0xe9, 0x8e, 0x9b, 0x12, 0xe9,
            0x19, 0x7d, 0x50, 0x86, 0xcb, 0x9b, 0x50, 0x72, 0x19, 0xee, 0x95, 0xdb, 0x11, 0x3a,
            0x91, 0x76, 0x78, 0xb2,
        ];
        let done = decrypt_aes128_cbc(&key, &iv, &mut ciphertext).unwrap();
        assert_eq!(done, 32);
        assert_eq!(
            &ciphertext[..16],
            &[
                0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93,
                0x17, 0x2a
            ]
        );
        assert_eq!(
            &ciphertext[16..],
            &[
                0xae, 0x2d, 0x8a, 0x57, 0x1e, 0x03, 0xac, 0x9c, 0x9e, 0xb7, 0x6f, 0xac, 0x45, 0xaf,
                0x8e, 0x51
            ]
        );
    }

    #[test]
    fn a_wrong_size_key_is_an_error_not_a_panic() {
        let mut data = [0u8; 16];
        assert!(decrypt_aes128_cbc(&[0u8; 8], &[0u8; 16], &mut data).is_err());
        assert!(decrypt_aes128_cbc(&[0u8; 24], &[0u8; 16], &mut data).is_err());
    }

    #[test]
    fn a_trailing_partial_block_is_left_alone() {
        let key = [0u8; 16];
        let iv = [0u8; 16];
        let mut data = vec![0u8; 17];
        let done = decrypt_aes128_cbc(&key, &iv, &mut data).unwrap();
        assert_eq!(done, 16);
    }

    #[test]
    fn resolve_rejects_an_unparsable_base() {
        assert!(resolve("not a url", "seg0.ts").is_err());
        assert_eq!(
            resolve("file:///a/b.m3u8", "seg0.ts").unwrap(),
            "file:///a/seg0.ts"
        );
    }
}
