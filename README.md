# Pinpull

Pinpull is a Manifest V3 Chrome extension for bulk-downloading Pinterest board media as one ZIP archive. It downloads images and videos, preserves board sections as folders, supports signed-in private boards, and also accepts public board URLs or `username/boardname` values.

## What it does

- Shows the boards available to the Pinterest account already signed in to Chrome.
- Refreshes the board list when the popup opens, on demand, and while it remains open.
- Downloads the highest-quality image or video Pinterest makes available.
- Converts supported HLS video streams to MP4.
- Preserves sections inside the ZIP:

  ```text
  Board Name/
    Section Name/
      123456.jpg
    789012.mp4
  ```

- Saves to Chrome’s default Downloads folder or opens Chrome’s native Save As dialog.
- Stops safely: the final ZIP is not started until packaging finishes, and cancellation removes an in-progress ZIP download.

## Requirements

- Google Chrome 116 or newer.
- Node.js 20 or newer for building from source.
- A Pinterest account signed in in the same Chrome profile for private/account-board access.

Pinpull does not open a second Pinterest window, ask for your password, use OAuth, or send board data to a Pinpull server.

## Install from this repository

```sh
npm ci
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the repository’s `dist` folder.

Load `dist`, not `src` and not the repository root. Re-run `npm run build` after source changes, then press **Reload** for Pinpull on the extensions page.

## Build a distributable ZIP

```sh
npm run package:extension
```

This builds the extension and creates:

```text
artifacts/pinpull-v1.0.0.zip
```

The ZIP has `manifest.json` at its root and can be uploaded to the Chrome Web Store or shared as an unpacked-extension release artifact. `dist/` and `artifacts/` are generated and intentionally not committed to Git.

## Use Pinpull

1. Sign in to Pinterest in the Chrome profile where Pinpull is installed.
2. Open Pinpull from the extensions toolbar.
3. Refresh if the account board list is stale.
4. Choose **ZIP** beside an account board, or enter another board URL/name in the manual field.
5. Enable **Ask where to save the ZIP** when you want to choose a destination.
6. Use **Stop** to cancel an active download.

If Pinterest rejects the session, use **Open Pinterest**, sign in in the normal browser tab, and refresh Pinpull.

## Development

```sh
npm run typecheck
npm test
npm run test:watch
npm run build
npm run package:extension
```

The extension has no runtime server. Pinterest requests use the browser session through the host permissions in `src/manifest.json`; cached board metadata and the Save As preference stay in Chrome extension storage.

## Repository layout

```text
src/                 extension source and manifest
src/popup/           board picker and progress UI
src/background/      Pinterest access, discovery, ZIP download, HLS handling
src/shared/          media parsing, filenames, messages, and types
tests/               unit tests and media fixtures
scripts/             build and release helpers
dist/                generated unpacked extension, ignored by Git
artifacts/           generated release ZIPs, ignored by Git
```

## Known limits

- Pinterest’s private web resources can change without notice; a signed-in session is required for private boards.
- Pins that Pinterest marks ineligible or that expose no downloadable media are skipped or reported.
- ZIP creation currently uses a stored ZIP32 archive in memory. Very large boards may need more memory; ZIP64/streaming is the upgrade path if that becomes a practical limit.
- This tool is for content the user is allowed to save. Respect Pinterest’s terms, copyright, and the original creator’s rights.

## License

MIT. See [LICENSE](LICENSE).
