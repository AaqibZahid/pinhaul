//! Pinterest session bootstrap.
//!
//! Pinterest refuses the board and pin resources from anonymous clients: the
//! `PinResource` endpoint answers `403` without a live session. Instead of
//! asking for credentials, pinpull drives the Chrome/Chromium that is already
//! installed on the machine through the DevTools protocol and reads the
//! cookies the site set for itself.
//!
//! The browser profile lives in the operating system's application data
//! directory, never inside the repository, so a single `--login` run is
//! enough for every later headless download.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::network::Cookie;
use futures::StreamExt as _;

use crate::error::{PinpullError, Result};

/// Marks a signed-in Pinterest visit; Pinterest resets it on every request
/// that still carries a valid session.
const SESSION_COOKIE: &str = "_pinterest_sess";
/// Sent back to the API and has to match the cookie Pinterest issued.
const CSRF_COOKIE: &str = "csrftoken";
const LOGIN_URL: &str = "https://www.pinterest.com/login/";
const HOME_URL: &str = "https://www.pinterest.com/";
/// The hosts Pinterest owns; everything else keeps its own cookies.
const PININTEREST_HOST_MARKER: &str = "pinterest.com";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// A headless run only has to wait for the page to finish loading.
const BROWSER_SETTLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Whatever a person needs to type an e-mail, a password and a 2FA code.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

/// The Pinterest session a browser handed over, reduced to the one thing the
/// API client needs: a `Cookie` header value.
#[derive(Debug, Clone)]
pub struct Session {
    header: String,
}

impl Session {
    pub fn cookie_header(&self) -> &str {
        &self.header
    }

    /// The `csrftoken` value Pinterest paired with these cookies, when present.
    pub fn csrf_token(&self) -> Option<String> {
        cookie_value(&self.header, CSRF_COOKIE)
    }

    pub fn is_authenticated(&self) -> bool {
        cookie_value(&self.header, SESSION_COOKIE).is_some()
    }
}

/// Establishes a Pinterest session using the installed browser.
///
/// `headless` runs silently against the stored profile; otherwise a visible
/// window is opened on the login page so the user can sign in by hand.
pub async fn authenticate(headless: bool) -> Result<Session> {
    let config = browser_config(headless)?;
    let (mut browser, mut handler) =
        Browser::launch(config)
            .await
            .map_err(|source| PinpullError::Browser {
                message: source.to_string(),
            })?;
    let driver = tokio::spawn(async move {
        // The handler owns the websocket; without it being polled every CDP
        // request would stall forever.
        while let Some(event) = handler.next().await {
            if event.is_err() {
                break;
            }
        }
    });

    let outcome = if headless {
        eprintln!("pinpull: reusing the stored browser profile");
        restore_session(&browser).await
    } else {
        eprintln!(
            "pinpull: opened Chrome on the Pinterest login page - sign in and pinpull will continue on its own"
        );
        wait_for_login(&browser).await
    };

    let _ = browser.close().await;
    let _ = browser.wait().await;
    let _ = driver.await;

    outcome.map(|cookies| Session::from_cookies(&cookies))
}

fn browser_config(headless: bool) -> Result<BrowserConfig> {
    let mut builder = BrowserConfig::builder()
        .user_data_dir(profile_dir()?)
        // The profile is ours alone, so nothing else is waiting on it; skip
        // Chrome's own first-run and default-browser prompts.
        .arg("no-first-run")
        .arg("no-default-browser-check");
    if !headless {
        builder = builder.with_head();
    }
    builder.build().map_err(|message| PinpullError::Browser {
        message: format!("could not configure Chrome: {message}"),
    })
}

/// Reads the session out of the stored profile.
async fn restore_session(browser: &Browser) -> Result<Vec<Cookie>> {
    open_page(browser, HOME_URL).await?;
    match poll_for_session(browser, BROWSER_SETTLE_TIMEOUT).await? {
        PollOutcome::Found(cookies) => Ok(cookies),
        PollOutcome::TimedOut => Err(PinpullError::NotAuthenticated {
            message: "the stored browser profile has no signed-in Pinterest session".into(),
        }),
        PollOutcome::Failed(err) => Err(err),
    }
}

/// Waits until the visitor has finished signing in.
async fn wait_for_login(browser: &Browser) -> Result<Vec<Cookie>> {
    open_page(browser, LOGIN_URL).await?;
    match poll_for_session(browser, LOGIN_TIMEOUT).await? {
        PollOutcome::Found(cookies) => Ok(cookies),
        PollOutcome::TimedOut => Err(PinpullError::NotAuthenticated {
            message: "nobody signed in before the 10 minute wait ran out".into(),
        }),
        PollOutcome::Failed(err) => Err(err),
    }
}

async fn open_page(browser: &Browser, url: &str) -> Result<()> {
    browser
        .new_page(url.to_owned())
        .await
        .map_err(|source| PinpullError::Browser {
            message: source.to_string(),
        })?;
    Ok(())
}

enum PollOutcome {
    Found(Vec<Cookie>),
    TimedOut,
    Failed(PinpullError),
}

async fn poll_for_session(browser: &Browser, timeout: Duration) -> Result<PollOutcome> {
    let deadline = Instant::now() + timeout;
    let mut failure: Option<PinpullError> = None;
    loop {
        match browser.get_cookies().await {
            Ok(cookies) => {
                failure = None;
                if has_session_cookie(&cookies) {
                    return Ok(PollOutcome::Found(cookies));
                }
            }
            Err(source) => {
                // Cookies are briefly unreadable while the tab is navigating.
                if failure.is_none() {
                    failure = Some(PinpullError::Browser {
                        message: source.to_string(),
                    });
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(match failure {
                Some(err) => PollOutcome::Failed(err),
                None => PollOutcome::TimedOut,
            });
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Whether one of the browser's cookies is a usable Pinterest session: the
/// session marker has to be there, hold a value, and belong to Pinterest.
fn is_session_cookie(name: &str, value: &str, domain: &str) -> bool {
    name == SESSION_COOKIE && !value.is_empty() && cookie_matches_pinterest(domain)
}

fn has_session_cookie(cookies: &[Cookie]) -> bool {
    cookies
        .iter()
        .any(|cookie| is_session_cookie(&cookie.name, &cookie.value, &cookie.domain))
}

impl Session {
    fn from_cookies(cookies: &[Cookie]) -> Self {
        Self::from_header(&cookie_header_for(cookies))
    }

    fn from_header(header: &str) -> Self {
        Self {
            header: header.to_owned(),
        }
    }
}

/// Renders the Pinterest-scoped browser cookies as a `Cookie` header value.
pub fn cookie_header_for(cookies: &[Cookie]) -> String {
    let pairs = cookies
        .iter()
        .filter(|cookie| cookie_matches_pinterest(&cookie.domain))
        .map(|cookie| (cookie.name.as_str(), cookie.value.as_str()));
    cookie_header_from(pairs)
}

/// Joins `name=value` pairs the way a browser does, sorted by name and with
/// repeated names collapsed to one pair. Chrome keeps one cookie per
/// name-and-domain, so the same name can show up for several Pinterest
/// subdomains at once; the lexicographically first value wins so the header is
/// reproducible no matter what order the browser reported them in.
fn cookie_header_from<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut pairs: Vec<(&str, &str)> = pairs.into_iter().collect();
    pairs.sort_unstable();
    pairs.dedup_by(|left, right| left.0 == right.0);
    let mut header = String::new();
    for (name, value) in pairs {
        if !header.is_empty() {
            header.push_str("; ");
        }
        header.push_str(name);
        header.push('=');
        header.push_str(value);
    }
    header
}

fn cookie_matches_pinterest(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    domain == PININTEREST_HOST_MARKER || domain.ends_with(&format!(".{PININTEREST_HOST_MARKER}"))
}

fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').map(str::trim).find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (!key.is_empty() && key == name && !value.is_empty()).then(|| value.to_owned())
    })
}

/// Platform application-data directory shared by the browser profile.
pub fn profile_dir() -> Result<PathBuf> {
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"));
    let dir = profile_dir_from(
        env::var_os("APPDATA")
            .as_deref()
            .and_then(|value| value.to_str()),
        env::var_os("XDG_CONFIG_HOME")
            .as_deref()
            .and_then(|value| value.to_str()),
        home.as_deref().and_then(|value| value.to_str()),
    )
    .ok_or_else(|| PinpullError::Browser {
        message: "no application data directory found; set APPDATA, XDG_CONFIG_HOME or HOME".into(),
    })?;
    fs::create_dir_all(&dir).map_err(PinpullError::Io)?;
    Ok(dir)
}

/// Picks the application-data root the way the running platform expects it.
fn profile_dir_from(
    appdata: Option<&str>,
    xdg: Option<&str>,
    home: Option<&str>,
) -> Option<PathBuf> {
    let root = appdata
        .map(PathBuf::from)
        .or_else(|| xdg.map(PathBuf::from))
        .or_else(|| home.map(|home| Path::new(home).join(".config")))?;
    Some(root.join("pinpull").join("browser-profile"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_prefers_appdata_then_xdg_then_home() {
        assert_eq!(
            profile_dir_from(Some("C:/Users/u/AppData/Roaming"), None, None),
            Some(PathBuf::from(
                "C:/Users/u/AppData/Roaming/pinpull/browser-profile"
            ))
        );
        assert_eq!(
            profile_dir_from(None, Some("D:/xdg"), Some("C:/home")),
            Some(PathBuf::from("D:/xdg/pinpull/browser-profile"))
        );
        assert_eq!(
            profile_dir_from(None, None, Some("C:/home")),
            Some(PathBuf::from("C:/home/.config/pinpull/browser-profile"))
        );
        assert_eq!(profile_dir_from(None, None, None), None);
    }

    #[test]
    fn profile_dir_is_nested_under_pinpull() {
        let dir = profile_dir_from(Some("C:/AppData/Roaming"), None, None).unwrap();
        assert_eq!(dir.file_name().unwrap(), "browser-profile");
        assert_eq!(
            dir.parent().unwrap().file_name().unwrap(),
            std::ffi::OsStr::new("pinpull")
        );
    }

    #[test]
    fn header_sorts_pairs_by_name() {
        let header = cookie_header_from([("csrftoken", "abc123"), ("_pinterest_sess", "s_ecret")]);
        assert_eq!(header, "_pinterest_sess=s_ecret; csrftoken=abc123");
    }

    #[test]
    fn header_keeps_a_value_with_separators_verbatim() {
        // A Pinterest session value legitimately contains "=", ";" and spaces.
        let header = cookie_header_from([("_pinterest_sess", "a=b; c d")]);
        assert_eq!(header, "_pinterest_sess=a=b; c d");
    }

    #[test]
    fn duplicate_names_collapse_to_one_pair() {
        // The same cookie name on two Pinterest subdomains must not be sent twice.
        let header = cookie_header_from([("a", "1"), ("a", "2"), ("b", "3")]);
        assert_eq!(header, "a=1; b=3");
        // Order of arrival does not matter, the winner is deterministic.
        let other = cookie_header_from([("a", "2"), ("a", "1"), ("b", "3")]);
        assert_eq!(other, header);
    }

    #[test]
    fn an_empty_pair_set_is_an_empty_header() {
        assert_eq!(cookie_header_from([]), "");
    }

    #[test]
    fn session_cookie_detection_needs_a_value_on_pinterest() {
        assert!(is_session_cookie(SESSION_COOKIE, "x", ".pinterest.com"));
        assert!(!is_session_cookie(SESSION_COOKIE, "", ".pinterest.com"));
        assert!(!is_session_cookie(
            "some_other_cookie",
            "x",
            ".pinterest.com"
        ));
        assert!(!is_session_cookie(SESSION_COOKIE, "x", "example.com"));
        assert!(!is_session_cookie(SESSION_COOKIE, "x", ""));
    }

    #[test]
    fn session_reports_csrf_and_login_state() {
        let signed_in = Session::from_header("_pinterest_sess=s; csrftoken=c");
        assert!(signed_in.is_authenticated());
        assert_eq!(signed_in.cookie_header(), "_pinterest_sess=s; csrftoken=c");
        assert_eq!(signed_in.csrf_token().as_deref(), Some("c"));

        // A csrftoken alone is what an anonymous visitor carries.
        let anonymous = Session::from_header("csrftoken=c");
        assert!(!anonymous.is_authenticated());
        assert_eq!(anonymous.csrf_token().as_deref(), Some("c"));

        let empty = Session::from_header("");
        assert!(!empty.is_authenticated());
        assert_eq!(empty.cookie_header(), "");
        assert_eq!(empty.csrf_token(), None);
    }

    #[test]
    fn cookie_value_requires_an_exact_name() {
        // Spaces around "=" are not part of a cookie-pair (RFC 6265), so a
        // padded key is a different name rather than the same one.
        assert_eq!(
            cookie_value("a=1;  csrftoken=abc", "csrftoken"),
            Some("abc".to_owned())
        );
        assert_eq!(cookie_value("a=1; csrftoken =abc", "csrftoken"), None);
        assert_eq!(cookie_value("a=1; csrftoken=", "csrftoken"), None);
        assert_eq!(cookie_value("a=1", "csrftoken"), None);
        assert_eq!(cookie_value("", "csrftoken"), None);
        assert_eq!(cookie_value("=1", "csrftoken"), None);
        // Only the first match is honored, the way a browser sends it.
        assert_eq!(
            cookie_value("_auth=1; _auth=2", "_auth").as_deref(),
            Some("1")
        );
    }

    #[test]
    fn domain_matching_accepts_parent_and_subdomains() {
        assert!(cookie_matches_pinterest("pinterest.com"));
        assert!(cookie_matches_pinterest(".pinterest.com"));
        assert!(cookie_matches_pinterest("www.pinterest.com"));
        assert!(cookie_matches_pinterest("blog.pinterest.com"));
        assert!(!cookie_matches_pinterest("v1.pinimg.com"));
        assert!(!cookie_matches_pinterest("notpinterest.com"));
        assert!(!cookie_matches_pinterest("example.com"));
        assert!(!cookie_matches_pinterest(""));
    }
}
