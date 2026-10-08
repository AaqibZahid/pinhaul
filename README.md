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

A public board that Pinterest opens to everyone is read without any sign-in.
A board that needs a session fails with "Pinterest authentication required" and
tells you to run `--login`; a board your signed-in account still cannot reach
fails as "the current Pinterest account cannot access this board". Neither is
worked around.

## Authentication

Pinterest only serves some boards and some pin detail fields to a logged-in
session. Pinpull drives a real Chrome/Chromium window through the DevTools
protocol and keeps a persistent browser profile in your OS app-data directory,
so you sign in once with `--login` and later runs reuse that session.

Pinpull never exports, logs, or stores Pinterest cookies in its own state or
config files. The browser profile is a normal Chrome profile; Pinterest's own
session lives there as it would in any browser you use.

The profile directory is ignored by git and lives outside the repository.

## Where a pin's record comes from

`PinResource` refuses these sessions, so a pin's detail is read from the record
Pinterest already embeds in the pin's own page rather than from a separate API
call. That is the same record the site renders from, so nothing is reconstructed,
inferred, or assembled from thumbnails. A pin whose page answers with a typed
`PinNotFound` is reported by that name instead of being guessed at.

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

A board feed does not only contain pins: Pinterest closes it with modules such
as "Related Interests". Those carry no pin data and are not counted as pins.

## Media selection

- **Images**: the untouched original when Pinterest published one, otherwise the
  largest variant available. A story pin's single image sits on its block, named
  for its size, and is picked from there. Carousel pins use the largest image of
  each slot.
- **Video**: the highest-quality permitted representation is chosen across all
  candidates — direct MP4 when it is equal to or better than the HLS rendition,
  HLS when the HLS rendition is higher quality. HLS segments are fetched and
  decrypted in-process (AES-128-CBC via `EXT-X-KEY`); no external tools are used.

Nothing is transcoded, remuxed, recompressed or resized. A segment stream is
written with the extension it actually has: MPEG-TS as `.ts`, fragmented MP4 as
`.mp4`. MPEG-TS bytes are never written behind an `.mp4` name.

Pin IDs are the only deduplication key. Files are never compared by content hash.

## Output

By default media lands in `./downloads/<username>/<boardname>/`, so several
boards can be downloaded into one directory. `--out DIR` uses `DIR` itself.
Each download writes to `<name>.part` and is renamed on completion. A finished
file that is already on disk is left alone, so a repeated run is cheap.

## Resumability

Resume uses HTTP Range only when the server actually honors byte ranges for that
URL; otherwise the file restarts cleanly rather than appending incompatible data.
A direct download's resume offset is the size of its own `.part` file, and an
HLS join restarts from its first segment, so the checkpoint holds no byte
progress that the disk would have to agree with.

`.state/` holds the checkpoint — one JSON file recording the board it was
written for and, per pin, the terminal state, the reason it was skipped or
failed, and the file names it produced. Delete it to force a full re-scan.

## Known limitations

- **Not yet validated against**: sections, boards large enough to need several
  feed pages, videos (direct MP4 or HLS), AES-128 encrypted HLS, private
  accessible boards, and private inaccessible boards. Those paths are covered by
  tests against a fixture server but not yet against live Pinterest.
- Tall 9:16 story pins expose a creator-facing "Video downloads" toggle that has
  no separate field in Pinterest's API. Pinpull assumes the same
  `is_eligible_for_image_download` flag governs video as well; if Pinterest ever
  gates video separately, that gate is not currently detectable from the API.
- Boards that Pinterest blocks outright (policy-restricted, deleted, or fully
  private without a valid session) fail with an explicit error. Nothing is
  bypassed: no media-restriction evasion, no synthesized `/originals/` URLs.
- Only boards are in scope. Profile-wide, search-wide, and single-pin-only
  downloads are out of scope.

## Testing status

145 automated tests pass: unit tests for the pure logic, and integration tests
that drive discovery, pagination, sections, duplicate pins, downloads, HLS
joining and decryption, range resume, retry behaviour and checkpoint recovery
against a fixture server that answers canned responses. No credentials and no
network are needed for them.

Validated against live Pinterest on one public board:

- 45 pins discovered against Pinterest's own reported count of 45.
- 45 downloaded, 0 skipped, 0 failed.
- A second run downloaded nothing and preserved the accounting.

Not yet validated against live Pinterest: the media types and board shapes
listed under known limitations above.


## Development

```
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
```
