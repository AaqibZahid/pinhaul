use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
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
    base: String,
    csrf: Mutex<String>,
    cookies: Mutex<String>,
}

impl PinterestClient {
    pub fn new() -> Result<Self> {
        Self::with_base(BASE)
    }

    /// A client pointed at `base` instead of Pinterest. Production passes
    /// `BASE`; tests point this at a fixture server so the same request and
    /// parsing code runs without touching the live site.
    pub fn with_base(base: &str) -> Result<Self> {
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
                base: base.trim_end_matches('/').to_owned(),
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

    fn base(&self) -> &str {
        &self.inner.base
    }

    pub async fn board(&self, username: &str, slug: &str) -> Result<Value> {
        let path = format!("/{username}/{slug}/");
        let options = json!({"slug": slug, "username": username, "field_set_key": "detailed"});
        let referer = format!("{}{path}", self.base());
        self.call_data("Board", &options, &path, &referer).await
    }

    pub async fn pin(&self, id: &str) -> Result<Value> {
        let path = format!("/pin/{id}/");
        let options = json!({"id": id, "field_set_key": "detailed"});
        let referer = format!("{}{path}", self.base());
        self.call_data("Pin", &options, &path, &referer).await
    }

    /// The pin's own record.
    ///
    /// The `PinResource` endpoint refuses anonymous and even many signed-in
    /// sessions, so the pin is read from the record Pinterest embeds in its own
    /// pin page instead. That record is the same one the site renders from, so
    /// nothing is reconstructed or guessed.
    pub async fn pin_detail(&self, id: &str) -> Result<Value> {
        let html = self.pin_page(id).await?;
        match relay_pin_data(&html) {
            PinRecord::Found(data) => {
                // The record has to be the pin that was asked for. A page can
                // carry another pin's record, and answering with that would
                // classify one pin as another without anything noticing.
                match record_pin_id(&data).as_deref() {
                    Some(found) if found == id => Ok(data),
                    Some(found) => Err(PinpullError::Pinterest {
                        resource: "Pin",
                        message: format!("the page carried pin {found} instead of {id}"),
                    }),
                    None => Err(PinpullError::Pinterest {
                        resource: "Pin",
                        message: "the pin record did not name which pin it was".into(),
                    }),
                }
            }
            PinRecord::Error(kind) => Err(PinpullError::Pinterest {
                resource: "Pin",
                message: format!("Pinterest answered this pin as {kind}"),
            }),
            PinRecord::Missing => Err(PinpullError::Pinterest {
                resource: "Pin",
                message: "the pin page carried no pin record".into(),
            }),
        }
    }

    /// The pin's own page, fetched with the session's retry policy.
    pub async fn pin_page(&self, id: &str) -> Result<String> {
        let url = format!("{}/pin/{id}/", self.base());
        let referer = url.clone();
        self.fetch_with_retries(&url, &referer, "Pin").await
    }

    pub async fn board_sections(&self, board_id: &str) -> Result<Vec<Value>> {
        let options = json!({"board_id": board_id});
        let referer = format!("{}/", self.base());
        self.call_paged("BoardSections", &options, "", &referer)
            .await
    }

    pub async fn board_feed(&self, board_id: &str) -> Result<Vec<Value>> {
        let options = json!({
            "board_id": board_id,
            "field_set_key": "react_grid_pin",
            "prepend": false,
            "bookmarks": null
        });
        let referer = format!("{}/", self.base());
        self.call_paged("BoardFeed", &options, "", &referer).await
    }

    pub async fn board_section_pins(&self, section_id: &str) -> Result<Vec<Value>> {
        let options = json!({"section_id": section_id});
        let referer = format!("{}/", self.base());
        self.call_paged("BoardSectionPins", &options, "", &referer)
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

    /// Fetches a URL with the session's own retry policy. HTML pages and JSON
    /// resources share it, so a throttled pin page backs off exactly like a
    /// throttled resource call does.
    async fn fetch_with_retries(
        &self,
        url: &str,
        referer: &str,
        resource: &'static str,
    ) -> Result<String> {
        let mut backoff = Duration::from_secs(1);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match self.try_once(url, referer).await {
                Outcome::Body(body) => return Ok(body),
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

    async fn call_raw(
        &self,
        resource: &'static str,
        options: &Value,
        source_url: &str,
        referer: &str,
    ) -> Result<String> {
        let url = build_url(self.base(), resource, options, source_url)?;
        let body = self.fetch_with_retries(&url, referer, resource).await?;
        if success_check(&body) {
            return Ok(body);
        }
        let message = api_message(&body).unwrap_or_else(|| "unrecognized response body".into());
        Err(PinpullError::Pinterest { resource, message })
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

pub fn build_url(base: &str, resource: &str, options: &Value, source_url: &str) -> Result<String> {
    let data = json!({ "options": options });
    let data = percent_encode(&data.to_string());
    let source = percent_encode(source_url);
    let base = base.trim_end_matches('/');
    Ok(format!(
        "{base}/resource/{resource}Resource/get/?data={data}&source_url={source}"
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

/// The global Pinterest's pin pages register their fetched payloads behind.
const RELAY_MARKER: &str = "window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__";

/// Which pin a record is about, whichever way the record names it.
///
/// `entityId` is the plain numeric pin id; `id` is the base64 node id that
/// decodes to the same one, so either names the pin.
pub fn record_pin_id(data: &Value) -> Option<String> {
    if let Some(entity) = data.get("entityId").and_then(Value::as_str) {
        return (!entity.is_empty()).then(|| entity.to_owned());
    }
    let id = data.get("id").and_then(Value::as_str)?;
    if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
        // A plain numeric id already names the pin.
        return Some(id.to_owned());
    }
    let node = STANDARD
        .decode(id)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())?;
    node.strip_prefix("Pin:").map(str::to_owned)
}

/// Reads a pin's own record out of its pin page.
///
/// The `PinResource` endpoint refuses anonymous and many signed-in sessions, so
/// the pin is read from the record Pinterest embeds in the page it already
/// serves. That registration is `("<%encoded request>", <response>)`, with the
/// pin at `data.v3GetPinQueryv2.data`.
///
/// The same global is also used to install a fetch shim on the page, so every
/// occurrence is tried and the one that carries the pin wins.
/// What a pin page's relay payload said about the pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinRecord {
    /// The pin's own record.
    Found(Value),
    /// Pinterest answered with a typed error, such as `PinNotFound`.
    Error(String),
    /// The page carried no pin query at all.
    Missing,
}

pub fn relay_pin_data(html: &str) -> PinRecord {
    let mut search = 0usize;
    while let Some(found) = html[search..].find(RELAY_MARKER) {
        let marker = search + found + RELAY_MARKER.len();
        if let Some(record) = parse_relay_invocation(html, marker) {
            return record;
        }
        search = marker;
    }
    PinRecord::Missing
}

/// Parses one `("<%encoded request>", <response>)` and reads the pin out of it.
fn parse_relay_invocation(html: &str, from: usize) -> Option<PinRecord> {
    let open = html[from..].find('(')? + from;
    // Skip the first argument, which is always a quoted string.
    let after_request = skip_json_string(html, open + 1)?;
    let comma = html[after_request..].find(',')? + after_request;
    let json = extract_json_object(html, comma + 1)?;
    let doc: Value = serde_json::from_str(json).ok()?;
    let query = doc.pointer("/data/v3GetPinQueryv2")?;
    if let Some(data) = query.get("data").filter(|data| !data.is_null()) {
        return Some(PinRecord::Found(data.clone()));
    }
    // A missing `data` is a typed refusal rather than a parse failure, and it is
    // worth naming: Pinterest answers PinNotFound for a pin its query cannot
    // reach, which is an honest result rather than a bug to paper over.
    query
        .get("__isError")
        .and_then(Value::as_str)
        .map(|kind| PinRecord::Error(kind.to_owned()))
}

/// Returns the index just past the JSON string that starts at or after `from`.
fn skip_json_string(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = text[from..].find('"')? + from;
    index += 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

/// Returns the balanced JSON object that starts at or after `from`.
fn extract_json_object(text: &str, from: usize) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = text[from..].find('{')? + from;
    let mut depth = 0u32;
    let mut index = start;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            match byte {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
        } else {
            match byte {
                b'"' => in_string = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&text[start..=index]);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    None
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
        let url = build_url(BASE, "Board", &options, "/u/b/").unwrap();
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
        let url = build_url(BASE, "BoardFeed", &json!({"board_id": "1"}), "").unwrap();
        assert!(url.ends_with("&source_url="));
    }

    #[test]
    fn absolutize_prefixes_relative_paths() {
        assert_eq!(absolutize("/u/b/"), "https://www.pinterest.com/u/b/");
        assert_eq!(absolutize("https://x.test/a"), "https://x.test/a");
    }

    #[test]
    fn relay_pin_data_skips_the_pages_own_shim() {
        // A pin page installs a fetch shim under the same global before the
        // payload is registered, so the shim must not be mistaken for it.
        let shim = r#"window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__=function(t,n){var o=decodeURIComponent(t),r=e[o];if(!r||"pending"===r.status){var c=Date.now(),a=r||{startTime:c+1,resolve:function(){},reject:function(){},promise:Promise.resolve(n),status:"pending"};a.resolve(n)}}"#;
        let pin = serde_json::json!({"id": "1136033074790855749"});
        let html = format!(
            r#"<script>{shim}</script><script>window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%22queryID%22%3A%221%22%7D", {{"data":{{"v3GetPinQueryv2":{{"__typename":"PinResponse","data":{}}}}}}})</script>"#,
            pin
        );

        assert_eq!(
            found_id(&relay_pin_data(&html)),
            Some("1136033074790855749".to_owned())
        );
    }

    /// The pin id a record holds, for the tests that assert on it.
    fn found_id(record: &PinRecord) -> Option<String> {
        match record {
            PinRecord::Found(data) => data.get("id").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        }
    }

    #[test]
    fn relay_pin_data_reads_the_pin_from_a_pin_page() {
        // The shape Pinterest serves: an encoded request, then the response.
        let html = format!(
            r#"<script nonce="abc" type="text/javascript">window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%22queryID%22%3A%221%22%7D", {{"data":{{"v3GetPinQueryv2":{{"__typename":"PinResponse","data":{}}}}}}}</script>"#,
            serde_json::json!({
                "id": "1136033074790855749",
                "isEligibleForImageDownload": true,
                "images": {"orig": {"url": "https://i.pinimg.com/originals/a.png"}}
            })
        );

        assert_eq!(
            found_id(&relay_pin_data(&html)),
            Some("1136033074790855749".to_owned())
        );
        assert_eq!(
            relay_pin_data(&html),
            PinRecord::Found(serde_json::json!({
                "id": "1136033074790855749",
                "isEligibleForImageDownload": true,
                "images": {"orig": {"url": "https://i.pinimg.com/originals/a.png"}}
            }))
        );
    }

    #[test]
    fn relay_pin_data_needs_the_pin_query_in_the_payload() {
        let html = r#"window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("x", {"data":{"otherQuery":{"data":{"id":"1"}}}})"#;
        assert_eq!(relay_pin_data(html), PinRecord::Missing);
    }

    #[test]
    fn relay_pin_data_survives_escaped_quotes_and_braces() {
        // A value containing quotes and braces must not fool the parser.
        let pin = serde_json::json!({
            "id": "1",
            "description": "a \"quoted\" {brace} and a \\ backslash"
        });
        let html = format!(
            "window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(\"%7B%7D\", {{\"data\":{{\"v3GetPinQueryv2\":{{\"data\":{}}}}}}})",
            pin
        );

        let record = relay_pin_data(&html);
        match &record {
            PinRecord::Found(data) => assert_eq!(
                data["description"],
                "a \"quoted\" {brace} and a \\ backslash"
            ),
            other => panic!("the pin record was expected, got {other:?}"),
        }
    }

    #[test]
    fn relay_pin_data_reports_a_typed_refusal() {
        // Pinterest answers a pin its query cannot reach with a typed error
        // rather than a record, and that is an honest result to report.
        let html = r#"window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%7D", {"data":{"v3GetPinQueryv2":{"__typename":"PinNotFound","__isError":"PinNotFound"}},"extensions":{"is_final":true}})"#;
        assert_eq!(
            relay_pin_data(html),
            PinRecord::Error("PinNotFound".to_owned())
        );
    }

    #[test]
    fn relay_pin_data_is_absent_from_an_unrelated_page() {
        assert_eq!(
            relay_pin_data("<html>nothing here</html>"),
            PinRecord::Missing
        );
        assert_eq!(relay_pin_data(""), PinRecord::Missing);
        // The marker without a payload is not a pin.
        assert_eq!(
            relay_pin_data("window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__"),
            PinRecord::Missing
        );
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
