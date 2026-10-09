use std::fmt;
use std::str::FromStr;

use url::Url;

use crate::error::{PinpullError, Result};

const RESERVED_PATHS: &[&str] = &[
    "pin", "idea", "ideas", "search", "explore", "today", "business", "settings", "hub",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRef {
    pub username: String,
    pub board_slug: String,
}

impl BoardRef {
    pub fn path(&self) -> String {
        format!("/{}/{}/", self.username, self.board_slug)
    }

    pub fn canonical_url(&self) -> String {
        format!("https://www.pinterest.com{}", self.path())
    }
}

impl fmt::Display for BoardRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.username, self.board_slug)
    }
}

impl FromStr for BoardRef {
    type Err = PinpullError;

    fn from_str(s: &str) -> Result<Self> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err(PinpullError::InvalidBoard(
                "the board argument is empty".to_string(),
            ));
        }
        if trimmed.contains("://") || trimmed.starts_with("//") {
            from_url(trimmed)
        } else {
            from_relative(trimmed)
        }
    }
}

fn from_relative(s: &str) -> Result<BoardRef> {
    let segments: Vec<&str> = s.split('/').filter(|seg| !seg.is_empty()).collect();
    match segments.as_slice() {
        [] => Err(PinpullError::InvalidBoard(format!(
            "no board name in {s:?}"
        ))),
        [_] => Err(PinpullError::NotABoard(s.to_string())),
        [first, rest @ ..] => {
            let _ = rest;
            build(first, segments[1], s)
        }
    }
}

fn from_url(s: &str) -> Result<BoardRef> {
    let url = Url::parse(s)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(PinpullError::InvalidBoard(format!(
            "unsupported URL scheme in {s:?}"
        )));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !host.contains("pinterest.") {
        return Err(PinpullError::InvalidBoard(format!(
            "{s:?} is not a Pinterest URL"
        )));
    }
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segs| segs.filter(|seg| !seg.is_empty()).collect())
        .unwrap_or_default();
    match segments.as_slice() {
        [] | [_] => Err(PinpullError::NotABoard(s.to_string())),
        [first, rest @ ..] => {
            let _ = rest;
            build(first, segments[1], s)
        }
    }
}

fn build(username: &str, board: &str, original: &str) -> Result<BoardRef> {
    let username = username.strip_prefix('@').unwrap_or(username);
    validate_segment(username, "username", original)?;
    validate_segment(board, "board name", original)?;
    if RESERVED_PATHS.contains(&username) {
        return Err(PinpullError::NotABoard(original.to_string()));
    }
    Ok(BoardRef {
        username: username.to_string(),
        board_slug: board.to_string(),
    })
}

fn validate_segment(seg: &str, what: &str, original: &str) -> Result<()> {
    if seg.is_empty() {
        return Err(PinpullError::InvalidBoard(format!(
            "empty {what} in {original:?}"
        )));
    }
    if seg == "." || seg == ".." {
        return Err(PinpullError::InvalidBoard(format!(
            "invalid {what} {seg:?} in {original:?}"
        )));
    }
    // Either separator would let the name climb out of the output directory,
    // where the media for one board must stay.
    if seg.chars().any(|c| matches!(c, '/' | '\\')) {
        return Err(PinpullError::InvalidBoard(format!(
            "{what} contains a path separator in {original:?}"
        )));
    }
    if seg.chars().any(|c| c.is_whitespace()) {
        return Err(PinpullError::InvalidBoard(format!(
            "{what} contains whitespace in {original:?}"
        )));
    }
    if seg.chars().any(|c| matches!(c, '#' | '?' | '%')) {
        return Err(PinpullError::InvalidBoard(format!(
            "{what} contains an illegal character in {original:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_board() {
        let board: BoardRef = "chamberlaincoffeepins/the-wilderkind-collection"
            .parse()
            .unwrap();
        assert_eq!(board.username, "chamberlaincoffeepins");
        assert_eq!(board.board_slug, "the-wilderkind-collection");
        assert_eq!(
            board.canonical_url(),
            "https://www.pinterest.com/chamberlaincoffeepins/the-wilderkind-collection/"
        );
    }

    #[test]
    fn parses_relative_with_trailing_slash() {
        let board: BoardRef = "user/board-name/".parse().unwrap();
        assert_eq!(board.to_string(), "user/board-name");
    }

    #[test]
    fn parses_full_url_with_query() {
        let board: BoardRef = "https://www.pinterest.com/user/board-name/?utm_source=x&se=xy"
            .parse()
            .unwrap();
        assert_eq!(board.username, "user");
        assert_eq!(board.board_slug, "board-name");
    }

    #[test]
    fn parses_board_url_with_section_path() {
        let board: BoardRef = "https://pinterest.com/user/board-name/mardi-gras/"
            .parse()
            .unwrap();
        assert_eq!(board.username, "user");
        assert_eq!(board.board_slug, "board-name");
    }

    #[test]
    fn parses_regional_domain() {
        let board: BoardRef = "https://www.pinterest.co.uk/user/board-name/"
            .parse()
            .unwrap();
        assert_eq!(board.username, "user");
    }

    #[test]
    fn strips_at_prefix() {
        let board: BoardRef = "@someone/some-board".parse().unwrap();
        assert_eq!(board.username, "someone");
    }

    #[test]
    fn rejects_profile_url() {
        let err = "https://www.pinterest.com/someone/"
            .parse::<BoardRef>()
            .unwrap_err();
        assert!(matches!(err, PinpullError::NotABoard(_)));
    }

    #[test]
    fn rejects_relative_single_segment() {
        let err = "someone".parse::<BoardRef>().unwrap_err();
        assert!(matches!(err, PinpullError::NotABoard(_)));
    }

    #[test]
    fn rejects_empty() {
        let err = "   ".parse::<BoardRef>().unwrap_err();
        assert!(matches!(err, PinpullError::InvalidBoard(_)));
    }

    #[test]
    fn rejects_non_pinterest_host() {
        let err = "https://example.com/user/board/"
            .parse::<BoardRef>()
            .unwrap_err();
        assert!(matches!(err, PinpullError::InvalidBoard(_)));
    }

    #[test]
    fn rejects_short_link() {
        let err = "https://pin.it/abc".parse::<BoardRef>().unwrap_err();
        assert!(matches!(err, PinpullError::InvalidBoard(_)));
    }

    #[test]
    fn rejects_reserved_path() {
        let err = "https://www.pinterest.com/pin/12345/"
            .parse::<BoardRef>()
            .unwrap_err();
        assert!(matches!(err, PinpullError::NotABoard(_)));
    }

    #[test]
    fn rejects_a_separator_inside_a_segment() {
        // `..` on its own is already refused, but a separator carries the
        // climb out of the output directory on its own.
        for argument in ["user/..\\..\\elsewhere", "user/board\\..\\..\\x"] {
            let err = argument.parse::<BoardRef>().unwrap_err();
            assert!(
                matches!(err, PinpullError::InvalidBoard(_)),
                "{argument} was accepted"
            );
        }
    }
}
