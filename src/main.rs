mod cli;
mod error;
mod input;

use clap::Parser;

use crate::cli::Args;
use crate::input::BoardRef;

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let board: BoardRef = args.board.parse()?;
    println!("pinpull {}", board);
    println!("  url:  {}", board.canonical_url());
    println!("  out:  {}", args.out.display());
    println!("  jobs: {}", args.jobs);
    Ok(())
}
