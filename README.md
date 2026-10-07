# Pinpull

Download every image and video Pinterest permits on a board.

```
pinpull <board|url> [--out DIR] [--headless] [--login] [--jobs N]
```

```bash
pinpull chamberlaincoffeepins/the-wilderkind-collection
pinpull https://www.pinterest.com/username/boardname/
pinpull username/boardname --out D:\pins --jobs 6
pinpull username/boardname --login   # first run: sign in once in a Chrome window
```

## What it does

- Resolves `username/boardname` or a full board URL to a board.
- Enumerates every pin on the board, including pins inside board sections.
- Fetches each pin's detail record and checks the download-eligibility flag.
- Picks the highest-quality image and the highest-quality video representation Pinterest offers.
- Downloads with resumable `.part` files, deduplicating by pin ID.
- Checkpoints progress so an interrupted run continues where it stopped.

Accounting is exact: unique pins discovered = downloaded + skipped + failed.

## Authentication

Pinterest only serves some boards and some pin detail fields to a logged-in
session. Pinpull drives a real Chrome/Chromium window through the DevTools
protocol and keeps a persistent browser profile in your OS app-data directory,
so you sign in once with `--login` and later runs reuse that session.

Pinpull never exports, logs, or stores Pinterest cookies in its own state or
config files. The browser profile is a normal Chrome profile; Pinterest's own
session lives there as it would in any browser you use.

The profile directory is ignored by git and lives outside the repository.

## Download eligibility

Pinterest exposes `is_eligible_for_image_download` on pin detail records. Pinpull
treats it as the single download gate:

| Value | Result |
|---|---|
| `true` | download |
| `false` | skipped (not eligible) |
| absent / unrecognized | recorded as **unknown** — counted and reported, never silently dropped |

Board feed records do not carry the flag at all, so every pin is re-fetched in
detail form. Duplicates seen during pagination or section enumeration are
ignored and reported separately; they are not recorded as skipped pins.

## Media selection

- **Images**: `images.orig` when present, otherwise the largest available
  variant. Carousel pins use the largest image of each slot.
- **Video**: the highest-quality permitted representation is chosen across all
  candidates — direct MP4 when it is equal to or better than the HLS rendition,
  HLS when the HLS rendition is higher quality. HLS segments are fetched and
  decrypted in-process (AES-128-CBC via `EXT-X-KEY`); no external tools are used.

Pin IDs are the only deduplication key. Files are never compared by content hash.

## Resumability

Each download writes to `<name>.part` and is renamed on completion. Resume uses
HTTP Range only when the server actually honors byte ranges for that URL;
otherwise the file restarts cleanly rather than appending incompatible data.

`.state/` holds the checkpoint. Delete it to force a full re-scan.

## Known limitations

- Eligibility sampling covered 60/60 pins reporting `true`; no `false` case has
  been observed in the wild, so the skipped path exists but is unexercised in
  normal use.
- Tall 9:16 story pins expose a creator-facing "Video downloads" toggle that has
  no separate field in Pinterest's API. Pinpull assumes the same
  `is_eligible_for_image_download` flag governs video as well; if Pinterest ever
  gates video separately, that gate is not currently detectable from the API.
- Boards that Pinterest blocks outright (policy-restricted, deleted, or fully
  private without a valid session) fail with an explicit error. Nothing is
  bypassed: no media-restriction evasion, no synthesized `/originals/` URLs.
- Only boards are in scope. Profile-wide, search-wide, and single-pin-only
  downloads are out of scope.

## Development

```
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
```
