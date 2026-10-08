mod auth;
mod board;
mod cli;
mod error;
mod input;
mod pinterest;

use std::collections::BTreeMap;

use clap::Parser;

use crate::board::{Eligibility, PinSource};
use crate::cli::Args;
use crate::error::PinpullError;
use crate::input::BoardRef;
use crate::pinterest::PinterestClient;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let board_ref: BoardRef = args.board.parse()?;

    let session = auth::authenticate(args.headless).await?;
    if !session.is_authenticated() {
        return Err(PinpullError::NotAuthenticated {
            message: "the browser handed over no Pinterest session cookie".into(),
        }
        .into());
    }
    if session.csrf_token().is_none() {
        eprintln!("pinpull: the session carries no csrftoken cookie; API calls may be rejected");
    }

    let client = PinterestClient::new()?;
    client.set_cookies(session.cookie_header());
    if !client.has_session_cookies() {
        return Err(PinpullError::NotAuthenticated {
            message: "the session cookie did not reach the API client".into(),
        }
        .into());
    }
    let result = board::enumerate(&client, &board_ref, usize::from(args.jobs)).await?;

    let info = &result.board;
    println!("pinpull {}", info.name);
    println!("  id:      {}", info.id);
    println!("  url:     {}", info.url);
    match info.pin_count {
        Some(count) => println!("  pins:    {count}"),
        None => println!("  pins:    unknown"),
    }
    match info.section_count {
        Some(count) => println!("  sections: {count}"),
        None => println!("  sections: unknown"),
    }
    println!("  out:     {}", args.out.display());
    println!("  jobs:    {}", args.jobs);

    println!("\n  discovered unique pins: {}", result.pins.len());
    println!("  duplicate encounters:   {}", result.duplicate_encounters);

    let mut by_source: BTreeMap<PinSource, u64> = BTreeMap::new();
    let mut eligible = 0u64;
    let mut ineligible = 0u64;
    let mut unknown = 0u64;
    let mut with_media = 0u64;
    let mut unknown_ids: Vec<&str> = Vec::new();

    for pin in &result.pins {
        *by_source.entry(pin.source.clone()).or_insert(0) += 1;
        match pin.eligibility {
            Eligibility::Eligible => eligible += 1,
            Eligibility::Ineligible => ineligible += 1,
            Eligibility::Unknown => {
                unknown += 1;
                unknown_ids.push(&pin.id);
            }
        }
        if let Some(data) = &pin.data {
            let has_media = ["images", "videos", "carousel", "story_pin_data"]
                .iter()
                .any(|&key| data.get(key).is_some_and(|value| !value.is_null()));
            if has_media {
                with_media += 1;
            }
        }
    }

    println!("\n  by source:");
    for (source, count) in &by_source {
        println!("    {source}: {count}");
    }
    println!("\n  eligibility:");
    println!("    eligible:   {eligible}");
    println!("    ineligible: {ineligible}");
    println!("    unknown:    {unknown}");
    println!("  with media:     {with_media}");

    if !unknown_ids.is_empty() {
        let total = unknown_ids.len();
        let shown: Vec<&str> = unknown_ids.into_iter().take(20).collect();
        print!("\n  unknown eligibility pin ids: {}", shown.join(", "));
        if total > shown.len() {
            print!(", and {} more", total - shown.len());
        }
        println!();
    }

    Ok(())
}
