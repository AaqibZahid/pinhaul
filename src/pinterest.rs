use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use crate::error::{PinpullError, Result};

pub const BASE: &str = "https://www.pinterest.com";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_ATTEMPTS: u32 = 5;
const STOP_PREFIX: &str = "Y2JOb25lO";
const CSRF_COOKIE: &str = "csrftoken";
const SESSION_COOKIE: &str = "_pinterest_sess";

#[derive(Clone)]
pub struct PinterestClient {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    csrf: Mutex<String>,
    cookies: Mutex<String>,
}

impl PinterestClient {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|source| PinpullError::Http {
                resource: "ClientBuilder",
                source,
            })?;
        Ok(Self {
            inner: Arc::new(Inner {
                http,
                csrf: Mutex::new(csrf_token()),
                cookies: Mutex::new(String::new()),
            }),
        })
    }

    /// Installs a signed-in Pinterest session as a `Cookie` header value and
    /// aligns the CSRF token with the `csrftoken` cookie inside it.
    pub fn set_cookies(&self, cookie_header: &str) {
        let header = cookie_header.trim().to_owned();
        let csrf = cookie_value(&header, CSRF_COOKIE);
        *self.inner.cookies.lock().unwrap() = header;
        if let Some(csrf) = csrf {
            *self.inner.csrf.lock().unwrap() = csrf;
        }
    }

    /// Whether a signed-in session was installed.
    pub fn has_session_cookies(&self) -> bool {
        cookie_value(&self.cookie_header(), SESSION_COOKIE).is_some()
    }

    pub fn cookie_header(&self) -> String {
        self.inner.cookies.lock().unwrap().clone()
    }

    pub async fn board(&self, username: &str, slug: &str) -> Result<Value> {
        let path = format!("/{username}/{slug}/");
        let options = json!({"slug": slug, "username": username, "field_set_key": "detailed"});
        let referer = format!("{BASE}{path}");
        self.call_data("Board", &options, &path, &referer).await
    }

    pub async fn pin(&self, id: &str) -> Result<Value> {
        let path = format!("/pin/{id}/");
        let options = json!({"id": id, "field_set_key": "detailed"});
        let referer = format!("{BASE}{path}");
        self.call_data("Pin", &options, &path, &referer).await
    }

    pub async fn board_sections(&self, board_id: &str) -> Result<Vec<Value>> {
        let options = json!({"board_id": board_id});
        self.call_paged("BoardSections", &options, "", &format!("{BASE}/"))
            .await
    }

    pub async fn board_feed(&self, board_id: &str) -> Result<Vec<Value>> {
        let options = json!({
            "board_id": board_id,
            "field_set_key": "react_grid_pin",
            "prepend": false,
            "bookmarks": null
        });
        self.call_paged("BoardFeed", &options, "", &format!("{BASE}/"))
            .await
    }

    pub async fn board_section_pins(&self, section_id: &str) -> Result<Vec<Value>> {
        let options = json!({"section_id": section_id});
        self.call_paged("BoardSectionPins", &options, "", &format!("{BASE}/"))
            .await
    }

    fn build_request(&self, url: &str, referer: &str) -> reqwest::RequestBuilder {
        let cookie = {
            let cookies = self.inner.cookies.lock().unwrap().clone();
            if cookies.is_empty() {
                format!("csrftoken={}", self.inner.csrf.lock().unwrap())
            } else {
                cookies
            }
        };
        self.inner
            .http
            .get(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("X-Pinterest-PWS-Handler", "www/pinterest.js")
            .header("X-Pinterest-AppState", "active")
            .header("X-APP-VERSION", "a89153f")
            .header("Alt-Used", "www.pinterest.com")
            .header("Referer", referer)
            .header("Cookie", cookie)
    }

    async fn call_raw(
        &self,
        resource: &'static str,
        options: &Value,
        source_url: &str,
        referer: &str,
    ) -> Result<String> {
        let url = build_url(resource, options, source_url)?;
        let mut backoff = Duration::from_secs(1);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match self.try_once(&url, referer).await {
                Outcome::Body(body) => {
                    if success_check(&body) {
                        return Ok(body);
                    }
                    let message =
                        api_message(&body).unwrap_or_else(|| "unrecognized response body".into());
                    return Err(PinpullError::Pinterest { resource, message });
                }
                Outcome::RateLimited(retry_after) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(PinpullError::RateLimited { attempts: attempt });
                    }
                    let delay = retry_after
                        .map(|s| Duration::from_secs(s.min(30)))
                        .unwrap_or(backoff);
                    tokio::time::sleep(delay).await;
                }
                Outcome::ServerError(status) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(PinpullError::HttpStatus { resource, status });
                    }
                    tokio::time::sleep(backoff).await;
                }
                Outcome::FatalStatus(status) => {
                    return Err(PinpullError::HttpStatus { resource, status });
                }
                Outcome::Transport(err) => {
                    if attempt >= MAX_ATTEMPTS || !retryable_transport(&err) {
                        return Err(PinpullError::Http {
                            resource,
                            source: err,
                        });
                    }
                    tokio::time::sleep(backoff).await;
                }
                Outcome::ReadError(err) => {
                    if attempt >= MAX_ATTEMPTS {
                        return Err(PinpullError::Http {
                            resource,
                            source: err,
                        });
                    }
                    tokio::time::sleep(backoff).await;
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(8));
        }
    }

    async fn try_once(&self, url: &str, referer: &str) -> Outcome {
        let response = match self.build_request(url, referer).send().await {
            Ok(r) => r,
            Err(e) => return Outcome::Transport(e),
        };
        let status = response.status().as_u16();
        if status == 429 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            return Outcome::RateLimited(retry_after);
        }
        if (500..600).contains(&status) {
            return Outcome::ServerError(status);
        }
        if !response.status().is_success() {
            return Outcome::FatalStatus(status);
        }
        match response.text().await {
            Ok(body) => Outcome::Body(body),
            Err(e) => Outcome::ReadError(e),
        }
    }

    async fn call_data(
        &self,
        resource: &'static str,
        options: &Value,
        source_url: &str,
        referer: &str,
    ) -> Result<Value> {
        let body = self
            .call_raw(resource, options, source_url, referer)
            .await?;
        let doc: Value = serde_json::from_str(&body)?;
        match doc.pointer("/resource_response/data") {
            Some(Value::Null) | None => Err(PinpullError::Pinterest {
                resource,
                message: "response contained no data".into(),
            }),
            Some(data) => Ok(data.clone()),
        }
    }

    async fn call_paged(
        &self,
        resource: &'static str,
        options: &Value,
        source_url: &str,
        referer: &str,
    ) -> Result<Vec<Value>> {
        let mut out: Vec<Value> = Vec::new();
        let mut bookmark: Option<String> = None;
        loop {
            let page_options = match &bookmark {
                None => options.clone(),
                Some(cursor) => {
                    let mut page = options.clone();
                    page["bookmarks"] = json!([cursor]);
                    page
                }
            };
            let body = self
                .call_raw(resource, &page_options, source_url, referer)
                .await?;
            let doc: Value = serde_json::from_str(&body)?;
            let data = doc.pointer("/resource_response/data").cloned();
            let items = match data {
                None | Some(Value::Null) => break,
                Some(Value::Array(items)) => items,
                Some(_) => {
                    return Err(PinpullError::Pinterest {
                        resource,
                        message: "expected an array of items".into(),
                    });
                }
            };
            if items.is_empty() {
                break;
            }
            out.extend(items);
            match next_cursor(&doc, bookmark.as_deref()) {
                None => break,
                Some(cursor) => bookmark = Some(cursor),
            }
        }
        Ok(out)
    }
}

enum Outcome {
    Body(String),
    RateLimited(Option<u64>),
    ServerError(u16),
    FatalStatus(u16),
    Transport(reqwest::Error),
    ReadError(reqwest::Error),
}

fn retryable_transport(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout() || err.is_body()
}

/// Looks up a single cookie inside a `Cookie` header value.
pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').map(str::trim).find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_owned())
    })
}

fn success_check(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|doc| {
            doc.pointer("/resource_response/status")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|status| status == "success")
}

fn api_message(body: &str) -> Option<String> {
    let doc: Value = serde_json::from_str(body).ok()?;
    let msg = doc
        .pointer("/resource_response/error_message")
        .or_else(|| doc.pointer("/message"))
        .or_else(|| doc.pointer("/resource_response/message"))?;
    let s = match msg {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.is_empty() { None } else { Some(s) }
}

pub fn build_url(resource: &str, options: &Value, source_url: &str) -> Result<String> {
    let data = json!({ "options": options });
    let data = percent_encode(&data.to_string());
    let source = percent_encode(source_url);
    Ok(format!(
        "{BASE}/resource/{resource}Resource/get/?data={data}&source_url={source}"
    ))
}

pub fn next_cursor(doc: &Value, prev: Option<&str>) -> Option<String> {
    let raw = doc
        .pointer("/resource_response/bookmark")
        .or_else(|| doc.pointer("/resource/options/bookmarks/0"))
        .or_else(|| doc.pointer("/resource_response/data/resource/options/bookmarks/0"))?;
    let cursor = raw.as_str()?;
    if cursor.is_empty() || cursor == "-end-" || cursor.starts_with(STOP_PREFIX) {
        return None;
    }
    if Some(cursor) == prev {
        return None;
    }
    Some(cursor.to_owned())
}

pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn absolutize(path: &str) -> String {
    if path.starts_with('/') {
        format!("{BASE}{path}")
    } else {
        path.to_owned()
    }
}

fn csrf_token() -> String {
    let mut state = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        ^ u64::from(std::process::id());
    if state == 0 {
        state = 0x9E3779B97F4A7C15;
    }
    let mut next = || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545F4914F6CDD1D)
    };
    let a = next();
    let b = next();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16,
        (b >> 48) as u16,
        b & 0x0000_FFFF_FFFF_FFFF
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_keeps_unreserved_and_uppercases_hex() {
        assert_eq!(percent_encode("a Z-._~"), "a%20Z-._~");
        assert_eq!(percent_encode("/board name/"), "%2Fboard%20name%2F");
        assert_eq!(percent_encode("+&="), "%2B%26%3D");
        assert_eq!(percent_encode("\u{e9}"), "%C3%A9");
    }

    #[test]
    fn csrf_has_expected_shape() {
        let token = csrf_token();
        let parts: Vec<&str> = token.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(token.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert!(token.chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn next_cursor_stops_on_empty_end_and_prefix() {
        assert_eq!(next_cursor(&json!({}), None), None);
        assert_eq!(
            next_cursor(&json!({"resource_response": {"bookmark": ""}}), None),
            None
        );
        assert_eq!(
            next_cursor(&json!({"resource_response": {"bookmark": "-end-"}}), None),
            None
        );
        let repeated = format!("{STOP_PREFIX}rest");
        assert_eq!(
            next_cursor(&json!({"resource_response": {"bookmark": repeated}}), None),
            None
        );
        assert_eq!(
            next_cursor(
                &json!({"resource_response": {"bookmark": "abc"}}),
                Some("abc")
            ),
            None
        );
    }

    #[test]
    fn next_cursor_accepts_echoed_options_path() {
        let doc = json!({
            "resource_response": {"bookmark": "c1"},
            "resource": {"options": {"bookmarks": ["c1"]}}
        });
        assert_eq!(next_cursor(&doc, None).as_deref(), Some("c1"));
        assert_eq!(next_cursor(&doc, Some("c1")), None);
    }

    #[test]
    fn build_url_encodes_data_wrapper() {
        let options = json!({"slug": "b", "username": "u"});
        let url = build_url("Board", &options, "/u/b/").unwrap();
        assert!(url.starts_with("https://www.pinterest.com/resource/BoardResource/get/?data="));
        let data = url
            .split("data=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap();
        let decoded = percent_decode(data);
        let value: Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(value["options"]["slug"], "b");
        assert!(url.ends_with("&source_url=%2Fu%2Fb%2F"));
    }

    #[test]
    fn build_url_source_url_empty_is_valid() {
        let url = build_url("BoardFeed", &json!({"board_id": "1"}), "").unwrap();
        assert!(url.ends_with("&source_url="));
    }

    #[test]
    fn absolutize_prefixes_relative_paths() {
        assert_eq!(absolutize("/u/b/"), "https://www.pinterest.com/u/b/");
        assert_eq!(absolutize("https://x.test/a"), "https://x.test/a");
    }

    #[test]
    fn cookie_value_reads_one_named_pair() {
        let header = "a=1; csrftoken=tok en; _pinterest_sess=secret";
        assert_eq!(cookie_value(header, "csrftoken").as_deref(), Some("tok en"));
        assert_eq!(
            cookie_value(header, SESSION_COOKIE).as_deref(),
            Some("secret")
        );
        assert_eq!(cookie_value(header, "missing"), None);
        assert_eq!(cookie_value(header, ""), None);
        assert_eq!(cookie_value("a=1; csrftoken=", "csrftoken"), None);
        assert_eq!(cookie_value("", "csrftoken"), None);
        // Only the first match is honored, like a browser would send it.
        assert_eq!(
            cookie_value("_auth=1; _auth=2", "_auth").as_deref(),
            Some("1")
        );
    }

    fn percent_decode(input: &str) -> String {
        let mut out = Vec::new();
        let bytes = input.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }
}
