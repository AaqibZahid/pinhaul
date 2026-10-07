use thiserror::Error;

pub type Result<T> = std::result::Result<T, PinpullError>;

#[derive(Debug, Error)]
pub enum PinpullError {
    #[error("{0}")]
    InvalidBoard(String),

    #[error("not a board: {0} (only boards are supported, e.g. username/boardname)")]
    NotABoard(String),

    #[error("could not parse URL: {0}")]
    Url(#[from] url::ParseError),

    #[error("could not parse JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
