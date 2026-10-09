use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "pinpull",
    version,
    about = "Download every image and video Pinterest permits on a board"
)]
pub struct Args {
    /// Board to download: username/boardname or a full Pinterest board URL
    pub board: String,

    /// Directory to write media into
    #[arg(long, short = 'o', default_value = "downloads")]
    pub out: PathBuf,

    /// Run the browser without a visible window (the default; --login opens one)
    #[arg(long, conflicts_with = "login")]
    pub headless: bool,

    /// Open a visible browser to sign in to Pinterest before downloading
    #[arg(long)]
    pub login: bool,

    /// Number of concurrent downloads
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u8).range(1..=64))]
    pub jobs: u8,
}

impl Args {
    /// Whether the browser should run without a visible window.
    ///
    /// A board is read with whatever session the stored profile already has, so
    /// a plain run stays silent and a window only appears when one is asked
    /// for. `--headless` states that silence out loud; it is what happens
    /// anyway.
    pub fn wants_headless(&self) -> bool {
        !self.login
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_invocation() {
        let args = Args::parse_from([
            "pinpull",
            "user/board-name",
            "--out",
            "D:/pins",
            "--jobs",
            "6",
            "--headless",
        ]);
        assert_eq!(args.board, "user/board-name");
        assert_eq!(args.out, PathBuf::from("D:/pins"));
        assert_eq!(args.jobs, 6);
        assert!(args.headless);
        assert!(!args.login);
    }

    #[test]
    fn defaults_are_sane() {
        let args = Args::parse_from(["pinpull", "user/board"]);
        assert_eq!(args.out, PathBuf::from("downloads"));
        assert_eq!(args.jobs, 4);
        // A board is read with whatever session the stored profile has, so a
        // plain run stays silent: the browser only appears for --login.
        assert!(args.wants_headless());
        assert!(!args.login);
    }

    #[test]
    fn headless_conflicts_with_login() {
        let result = Args::try_parse_from(["pinpull", "user/board", "--headless", "--login"]);
        assert!(result.is_err());
    }

    #[test]
    fn only_login_asks_for_a_window() {
        let args = Args::try_parse_from(["pinpull", "user/board", "--login"]).unwrap();
        assert!(!args.wants_headless());
        assert!(args.login);

        let args = Args::try_parse_from(["pinpull", "user/board"]).unwrap();
        assert!(args.wants_headless());

        let args = Args::try_parse_from(["pinpull", "user/board", "--headless"]).unwrap();
        assert!(args.wants_headless());
    }

    #[test]
    fn rejects_zero_jobs() {
        let result = Args::try_parse_from(["pinpull", "user/board", "--jobs", "0"]);
        assert!(result.is_err());
    }
}
