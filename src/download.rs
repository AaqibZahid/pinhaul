//! Writing a pin's media to disk.
//!
//! Direct media is streamed straight into a `.part` file and renamed once the
//! response ended cleanly. HLS playlists are read in `hls`, then their segments
//! are fetched, decrypted in memory and appended in order. A media segment is a
//! few seconds of video, so buffering one segment is bounded and worthwhile;
//! whole downloads are never held in memory.

use std::io;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt as _;

use crate::error::{PinpullError, Result};
use crate::hls;
use crate::media::{MediaItem, MediaKind};

const MAX_ATTEMPTS: u32 = 4;
const FIRST_BACKOFF: Duration = Duration::from_millis(500);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a finished download landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub path: PathBuf,
    pub bytes: u64,
    pub segments: usize,
    /// The file names written for the item, relative to the output directory.
    pub files: Vec<String>,
}

/// What one media item's download left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    /// The bytes were fetched and the file renamed into place.
    Written(Outcome),
    /// The finished file was already on disk, so nothing was fetched.
    AlreadyPresent(PathBuf),
}

/// Fetches media for pins into a directory.
#[derive(Debug, Clone)]
pub struct Downloader {
    client: reqwest::Client,
}

impl Downloader {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .map_err(|source| PinpullError::Download {
                    url: String::new(),
                    message: source.to_string(),
                })?,
        })
    }

    /// Downloads one media item into `dir`, writing `<stem>.<ext>`.
    ///
    /// The final file is only ever created by renaming a fully written `.part`,
    /// so an interrupted run never leaves something that looks finished. A
    /// finished file that is already there is left untouched, which is what
    /// lets a repeated run skip its work.
    pub async fn fetch(&self, item: &MediaItem, stem: &str, dir: &Path) -> Result<Fetched> {
        std::fs::create_dir_all(dir).map_err(PinpullError::Io)?;
        match item.kind {
            MediaKind::Image | MediaKind::VideoFile => {
                let extension = url_extension(&item.url).unwrap_or("bin");
                if is_complete(&dir.join(format!("{stem}.{extension}"))) {
                    return Ok(Fetched::AlreadyPresent(
                        dir.join(format!("{stem}.{extension}")),
                    ));
                }
                let outcome = fetch_direct(&self.client, &item.url, stem, extension, dir).await?;
                Ok(Fetched::Written(outcome))
            }
            MediaKind::VideoHls => {
                // The container is only known once the playlist is read, so the
                // finished name sits inside fetch_hls.
                let outcome = fetch_hls(&self.client, &item.url, stem, dir).await?;
                Ok(Fetched::Written(outcome))
            }
        }
    }
}

/// Whether the finished file is already on disk, so a repeated run does not
/// download it again.
pub fn is_complete(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

/// Fetches one URL into `<stem>.<ext>`, resuming by byte range when the server
/// says it will honour one.
async fn fetch_direct(
    client: &reqwest::Client,
    url: &str,
    stem: &str,
    extension: &str,
    dir: &Path,
) -> Result<Outcome> {
    let part = part_path(dir, stem, extension);
    let mut offset = existing_part_size(&part);
    let mut restart = false;
    let mut restarts = 0u32;
    let mut attempt = 0u32;
    let response = loop {
        attempt += 1;
        let mut request = client.get(url);
        if offset > 0 && !restart {
            request = request.header("Range", format!("bytes={offset}-"));
        }
        match apply_user_agent(request).send().await {
            Err(source) => {
                let message = source.to_string();
                if attempt >= MAX_ATTEMPTS || !retryable(&message) {
                    return Err(PinpullError::Download {
                        url: url.to_owned(),
                        message,
                    });
                }
                tokio::time::sleep(backoff(attempt, None)).await;
            }
            Ok(response) => match response.status().as_u16() {
                // The server refuses the range, so the partial bytes cannot be
                // continued: the file has to start over. That is not a failed
                // attempt, and it happens at most once per download.
                416 if !restart && restarts == 0 && offset > 0 => {
                    offset = 0;
                    restart = true;
                    restarts += 1;
                    attempt -= 1;
                }
                416 => {
                    return Err(PinpullError::Download {
                        url: url.to_owned(),
                        message: "HTTP 416".to_owned(),
                    });
                }
                200 | 206 => break response,
                status => {
                    let message = format!("HTTP {status}");
                    let retry_after = retry_after_of(&response);
                    if attempt >= MAX_ATTEMPTS || !retryable(&message) {
                        return Err(PinpullError::Download {
                            url: url.to_owned(),
                            message,
                        });
                    }
                    tokio::time::sleep(backoff(attempt, retry_after)).await;
                }
            },
        }
    };

    let status = response.status().as_u16();
    // A 200 in answer to a Range request means ranges are ignored, so the
    // response carries the whole file from byte zero.
    let offset = if status == 206 && !restart { offset } else { 0 };
    let file = open_part(&part, offset, url)?;
    let mut written = offset;
    let mut stream = response.bytes_stream();
    let mut writer = file;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|source| PinpullError::Download {
            url: url.to_owned(),
            message: source.to_string(),
        })?;
        std::io::Write::write_all(&mut writer, &chunk).map_err(|source| {
            PinpullError::Download {
                url: url.to_owned(),
                message: source.to_string(),
            }
        })?;
        written += u64::try_from(chunk.len()).unwrap_or(u64::MAX);
    }
    writer.flush().map_err(|source| PinpullError::Download {
        url: url.to_owned(),
        message: source.to_string(),
    })?;
    drop(writer);
    let path = finish(&part, dir, stem, extension, url)?;
    let files = vec![file_name_of(&path)];
    Ok(Outcome {
        path,
        bytes: written,
        segments: 0,
        files,
    })
}

/// Reads an HLS playlist, follows a master playlist to its best rendition and
/// joins the segments into `<stem>.<ext>`.
///
/// The `.part` file is rewritten from the first segment rather than resumed
/// mid-way: a media segment's length is only known once it has been fetched, so
/// a partial join cannot be placed on a segment boundary without extra state.
async fn fetch_hls(client: &reqwest::Client, url: &str, stem: &str, dir: &Path) -> Result<Outcome> {
    let (playlist, _) = load_media_playlist(client, url).await?;
    let extension = playlist.extension();
    let part = part_path(dir, stem, extension);
    let mut written = 0u64;
    {
        let mut file = open_part(&part, 0, url)?;
        if let Some(init) = &playlist.init {
            let bytes = fetch_segments(client, std::slice::from_ref(init), &mut file).await?;
            written += bytes;
        }
        let bytes = fetch_segments(client, &playlist.segments, &mut file).await?;
        written += bytes;
        file.flush()
            .map_err(|source| download_error(url, &source))?;
    }
    let path = finish(&part, dir, stem, extension, url)?;
    let files = vec![file_name_of(&path)];
    Ok(Outcome {
        path,
        bytes: written,
        segments: playlist.segment_count(),
        files,
    })
}

/// Fetches the media playlist behind `url`, following at most a few master
/// playlists before giving up.
async fn load_media_playlist(
    client: &reqwest::Client,
    url: &str,
) -> Result<(hls::Playlist, usize)> {
    let mut current = url.to_owned();
    for hop in 0..4 {
        let body = text_with_retries(client, &current).await?;
        match hls::parse(&body, &current)? {
            hls::Document::Media(playlist) => return Ok((playlist, hop)),
            hls::Document::Master(variants) => {
                let best = variants
                    .into_iter()
                    .reduce(
                        |best, variant| {
                            if variant.beats(&best) { variant } else { best }
                        },
                    )
                    .ok_or_else(|| PinpullError::Hls {
                        message: "the master playlist offered no renditions".into(),
                    })?;
                current = best.url;
            }
        }
    }
    Err(PinpullError::Hls {
        message: "the playlist kept pointing at more master playlists".into(),
    })
}

/// Fetches every segment in order, decrypting the ones the playlist marked,
/// and writes them into `file`.
async fn fetch_segments(
    client: &reqwest::Client,
    segments: &[hls::Segment],
    file: &mut std::fs::File,
) -> Result<u64> {
    // Playlist-adjacent bytes: which segment holds the body, so the first
    // failure can name it.
    let mut total = 0u64;
    for (index, segment) in segments.iter().enumerate() {
        let mut body = bytes_with_retries(client, &segment.url).await?;
        if let Some(key) = &segment.key {
            let secret = key_bytes(client, &key.uri).await?;
            hls::decrypt_aes128_cbc(&secret, &key.iv, &mut body).map_err(|err| {
                PinpullError::Download {
                    url: segment.url.clone(),
                    message: format!("segment {index}: {err}"),
                }
            })?;
        }
        std::io::Write::write_all(file, &body).map_err(|source| PinpullError::Download {
            url: segment.url.clone(),
            message: source.to_string(),
        })?;
        total += u64::try_from(body.len()).unwrap_or(u64::MAX);
    }
    Ok(total)
}

/// Fetches the 16-byte AES key a playlist points at.
async fn key_bytes(client: &reqwest::Client, uri: &str) -> Result<Vec<u8>> {
    let bytes = bytes_with_retries(client, uri).await?;
    if bytes.len() != 16 {
        return Err(PinpullError::Hls {
            message: format!("the AES-128 key at {uri} was {} bytes", bytes.len()),
        });
    }
    Ok(bytes)
}

fn apply_user_agent(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request.header("User-Agent", USER_AGENT)
}

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn download_error(url: &str, error: &io::Error) -> PinpullError {
    PinpullError::Download {
        url: url.to_owned(),
        message: error.to_string(),
    }
}

/// The bare file name of a finished path, as it is stored in the checkpoint.
fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn part_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    dir.join(format!("{stem}.{extension}.part"))
}

/// How many bytes of a partial download are already on disk.
fn existing_part_size(part: &Path) -> u64 {
    std::fs::metadata(part).map(|meta| meta.len()).unwrap_or(0)
}

/// Opens the `.part` file for appending or for a clean restart.
fn open_part(part: &Path, offset: u64, url: &str) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true);
    if offset > 0 {
        options.append(true);
    } else {
        options.truncate(true);
    }
    options
        .open(part)
        .map_err(|source| download_error(url, &source))
}

/// Renames a fully written `.part` file into its final name.
fn finish(part: &Path, dir: &Path, stem: &str, extension: &str, url: &str) -> Result<PathBuf> {
    let path = dir.join(format!("{stem}.{extension}"));
    std::fs::rename(part, &path).map_err(|source| download_error(url, &source))?;
    Ok(path)
}

/// The extension a URL promises, ignoring query strings and fragments.
fn url_extension(url: &str) -> Option<&str> {
    let path = url.split('#').next().unwrap_or(url);
    let path = path.split('?').next().unwrap_or(path);
    let name = path.rsplit('/').next()?;
    let (_, extension) = name.rsplit_once('.')?;
    Some(extension)
}

/// Whether a failure is worth another attempt: connection trouble, timeouts,
/// throttling and server-side hiccups. Permission and missing-file answers are
/// not.
fn retryable(message: &str) -> bool {
    message.contains("HTTP 429")
        || message.contains("HTTP 500")
        || message.contains("HTTP 502")
        || message.contains("HTTP 503")
        || message.contains("HTTP 504")
        || message.contains("timed out")
        || message.contains("connection closed")
        || message.contains("connection reset")
        || message.contains("connection aborted")
        || message.contains("broken pipe")
        || message.contains("error trying to connect")
        || message.contains("request or response body error")
}

/// How long to wait before the next attempt, honouring `Retry-After` when the
/// server sent one.
fn backoff(attempt: u32, retry_after: Option<u64>) -> Duration {
    if let Some(seconds) = retry_after {
        return Duration::from_secs(seconds.min(30));
    }
    // The exponent is capped, because shifting a counter that keeps counting
    // would overflow long before the retries stop.
    let step = attempt.clamp(1, MAX_BACKOFF_STEP) - 1;
    FIRST_BACKOFF
        .checked_mul(1u32 << step)
        .unwrap_or(FIRST_BACKOFF.saturating_mul(1u32 << (MAX_BACKOFF_STEP - 1)))
}

/// The last doubling step, so the ceiling is reached and held.
const MAX_BACKOFF_STEP: u32 = 5;

fn retry_after_of(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.trim().parse::<u64>().ok())
}

async fn bytes_with_retries(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let response = match apply_user_agent(client.get(url)).send().await {
            Ok(response) => response,
            Err(source) => {
                let message = source.to_string();
                if attempt >= MAX_ATTEMPTS || !retryable(&message) {
                    return Err(PinpullError::Download {
                        url: url.to_owned(),
                        message,
                    });
                }
                tokio::time::sleep(backoff(attempt, None)).await;
                continue;
            }
        };
        if !response.status().is_success() {
            let message = format!("HTTP {}", response.status().as_u16());
            let retry_after = retry_after_of(&response);
            if attempt >= MAX_ATTEMPTS || !retryable(&message) {
                return Err(PinpullError::Download {
                    url: url.to_owned(),
                    message,
                });
            }
            tokio::time::sleep(backoff(attempt, retry_after)).await;
            continue;
        }
        let body = response
            .bytes()
            .await
            .map_err(|source| PinpullError::Download {
                url: url.to_owned(),
                message: source.to_string(),
            })?;
        return Ok(body.to_vec());
    }
}

async fn text_with_retries(client: &reqwest::Client, url: &str) -> Result<String> {
    let bytes = bytes_with_retries(client, url).await?;
    String::from_utf8(bytes).map_err(|source| PinpullError::Download {
        url: url.to_owned(),
        message: format!("the response was not UTF-8 text: {source}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pinpull-{}-{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn url_extension_ignores_query_and_fragment() {
        assert_eq!(
            url_extension("https://i.pinimg.com/originals/a/b.png"),
            Some("png")
        );
        assert_eq!(
            url_extension("https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4?token=1"),
            Some("mp4")
        );
        assert_eq!(
            url_extension("https://v1.pinimg.com/videos/ht/hls/a.m3u8#frag"),
            Some("m3u8")
        );
        assert_eq!(
            url_extension("https://v1.pinimg.com/videos/ht/mp4/a_720w.mp4?token=1#x"),
            Some("mp4")
        );
        assert_eq!(url_extension("https://v1.pinimg.com/landing"), None);
        assert_eq!(url_extension("https://v1.pinimg.com/landing/"), None);
        assert_eq!(url_extension(""), None);
    }

    #[test]
    fn a_part_file_is_never_mistaken_for_the_finished_file() {
        let dir = scratch("part-not-complete");
        let part = part_path(&dir, "1136033074790855749", "png");
        std::fs::write(&part, b"half an image").unwrap();
        // The finished name must not exist yet, so a crash cannot look complete.
        assert!(!is_complete(&dir.join("1136033074790855749.png")));
        assert_eq!(existing_part_size(&part), 13);
        assert_eq!(existing_part_size(&part_path(&dir, "nope", "png")), 0);

        let path = finish(&part, &dir, "1136033074790855749", "png", "https://x").unwrap();
        assert_eq!(path, dir.join("1136033074790855749.png"));
        assert!(is_complete(&path));
        assert!(!part.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_empty_finished_file_is_not_complete() {
        let dir = scratch("empty");
        let path = dir.join("1136033074790855749.png");
        std::fs::write(&path, b"").unwrap();
        assert!(!is_complete(&path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opening_appends_only_when_there_is_an_offset() {
        let dir = scratch("append");
        let part = part_path(&dir, "pin", "mp4");
        std::fs::write(&part, b"abcd").unwrap();

        {
            let mut file = open_part(&part, 4, "https://x").unwrap();
            file.write_all(b"efgh").unwrap();
        }
        assert_eq!(std::fs::read(&part).unwrap(), b"abcdefgh");

        {
            let mut file = open_part(&part, 0, "https://x").unwrap();
            file.write_all(b"xy").unwrap();
        }
        // A zero offset means the server ignored ranges: start over cleanly
        // rather than append two responses end to end.
        assert_eq!(std::fs::read(&part).unwrap(), b"xy");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn transport_failures_retry_and_permanent_answers_do_not() {
        for message in [
            "HTTP 429",
            "HTTP 500",
            "HTTP 502",
            "HTTP 503",
            "HTTP 504",
            "error sending request: operation timed out",
            "connection closed before message completed",
            "connection reset by peer",
            "connection aborted",
            "broken pipe",
            "error trying to connect",
            "request or response body error",
        ] {
            assert!(retryable(message), "{message} should retry");
        }
        for message in [
            "HTTP 400",
            "HTTP 403",
            "HTTP 404",
            "HTTP 416",
            "HTTP 410",
            "invalid DNS name",
        ] {
            assert!(!retryable(message), "{message} must not retry");
        }
    }

    #[test]
    fn backoff_doubles_and_respects_retry_after() {
        assert_eq!(backoff(1, None), Duration::from_millis(500));
        assert_eq!(backoff(2, None), Duration::from_millis(1000));
        assert_eq!(backoff(3, None), Duration::from_millis(2000));
        assert_eq!(backoff(4, None), Duration::from_millis(4000));
        // Retry-After wins, but is capped so one reply cannot stall the run.
        assert_eq!(backoff(1, Some(7)), Duration::from_secs(7));
        assert_eq!(backoff(1, Some(600)), Duration::from_secs(30));
        assert_eq!(backoff(1, Some(0)), Duration::from_millis(0));
        // The exponent is capped, so an absurd attempt count holds the ceiling
        // instead of overflowing the shift.
        assert_eq!(backoff(5, None), Duration::from_secs(8));
        assert_eq!(backoff(40, None), Duration::from_secs(8));
        assert_eq!(backoff(u32::MAX, None), Duration::from_secs(8));
        assert_eq!(backoff(0, None), Duration::from_millis(500));
    }

    #[test]
    fn a_downloader_builds_a_client() {
        assert!(Downloader::new().is_ok());
    }
}
