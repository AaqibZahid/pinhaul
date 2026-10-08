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

    #[error("network error while fetching {resource}: {source}")]
    Http {
        resource: &'static str,
        #[source]
        source: reqwest::Error,
    },

    #[error("unexpected HTTP status {status} while fetching {resource}")]
    HttpStatus { resource: &'static str, status: u16 },

    #[error("rate limited by Pinterest after {attempts} attempts")]
    RateLimited { attempts: u32 },

    #[error("Pinterest API error while fetching {resource}: {message}")]
    Pinterest {
        resource: &'static str,
        message: String,
    },

    #[error("browser automation failed: {message}")]
    Browser { message: String },

    #[error("could not read the HLS playlist: {message}")]
    Hls { message: String },

    #[error("download from {url} failed: {message}")]
    Download { url: String, message: String },

    #[error("not signed in: {message}. Run `pinpull <board> --login` once, then retry.")]
    NotAuthenticated { message: String },

    #[error("background task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}
