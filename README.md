<div align="center">

<img src="docs/pinpull-mark.svg" width="80" height="80" alt="Pinpull mark" />

# Pinpull

**Download complete Pinterest boards as organized ZIP archives.**

[![CI](https://github.com/AaqibZahid/pinpull/actions/workflows/ci.yml/badge.svg)](https://github.com/AaqibZahid/pinpull/actions/workflows/ci.yml)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1e9dc.svg)](LICENSE)

Account boards · Private boards · Sections · Images · MP4 · HLS · Multi-board queue

</div>

Pinpull is a private, local-first Chrome extension. It uses the Pinterest session already signed into Chrome, discovers the account's boards, and saves each chosen board as one ZIP. There is no Pinpull account, OAuth flow, backend, analytics service, or second login window.

## Highlights

- Browse and refresh boards from the signed-in Pinterest account.
- Select several boards and download up to two at once as separate ZIPs.
- Download public boards by URL or `username/boardname`.
- Preserve board sections as folders.
- Choose the best available image, direct video, or supported HLS stream.
- Save to the default Downloads folder or use Chrome's native Save As dialog.
- Stop safely before packaging or during Chrome's final file write.
- Continue an active download while the popup is closed.

```text
Board name/
├── Section name/
│   ├── 123456.jpg
│   └── 789012.mp4
└── 345678.jpg
```

## Install locally

Requirements: Chrome 116+ and Node.js 20+.

```sh
git clone https://github.com/AaqibZahid/pinpull.git
cd pinpull
npm ci
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` folder. Chrome's [unpacked-extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) shows the same steps.

If you have a packaged Pinpull ZIP instead of the source, **extract it first** and select the extracted folder containing `manifest.json`. Do not select the ZIP itself; this is a local unpacked extension, not a Chrome Web Store installation.

After pulling or rebuilding, press **Reload** on Pinpull's extension card before testing changes.

## Use

1. Sign in to Pinterest normally in the same Chrome profile. You can then close the Pinterest tab; it does not need to stay open, but your sign-in session must remain valid.
2. Open Pinpull from the extensions toolbar.
3. Select one or more account boards, then choose **Download selected**. Use **ZIP** for a single board.
4. For another public board, paste its Pinterest URL or `username/boardname`.
5. Enable **Ask where to save the ZIP** when a custom destination is needed.
6. Each board has its own progress card and **Stop** button. Stop cancels only that board and hides its card. Before save, no file is written; during Chrome's final write, Pinpull asks Chrome to cancel and remove the partial ZIP.

Board synchronization runs when the popup opens, when Refresh is pressed, and periodically while the popup remains open. Pinterest does not provide a push channel for immediate board updates.

If the board list is empty, confirm that Pinterest is signed in **in the same Chrome profile**, then press Refresh. If Pinterest changes its private web API, the extension may need an update; see [Known limits](#known-limits).

## Privacy and permissions

Pinpull processes board metadata and media locally. It does not ask for a Pinterest password or transmit board data to a Pinpull server.

| Permission | Why it is needed |
| --- | --- |
| `downloads` | Save the completed ZIP and remove it when a final-write cancellation occurs. |
| `storage` | Cache account-board metadata when Pinterest is temporarily unavailable. |
| `offscreen` | Create a temporary Blob URL because Manifest V3 service workers cannot do that directly. |
| Pinterest and `pinimg.com` hosts | Read boards and fetch media visible to the current Pinterest session. |

## Build and verify

```sh
npm run typecheck
npm test
npm run build
npm run smoke:extension
npm run package:extension
```

`npm run smoke:extension` starts Chrome with a disposable profile and verifies that the unpacked extension and service worker load. Set `PINPULL_CHROME` if Chrome is outside its standard Windows location.

`npm run package:extension` creates `artifacts/pinpull-v1.0.0.zip` with `manifest.json` at the archive root. Generated `dist/` and `artifacts/` directories are intentionally ignored by Git.

## Project structure

```text
src/background/   Pinterest access, board discovery, queue and download coordination
src/offscreen/    temporary Blob URL support for Chrome downloads
src/popup/        account picker, queue controls and progress UI
src/shared/       parsing, filenames, HLS and shared types
tests/            unit and integration fixtures
scripts/          packaging and Chrome smoke-test helpers
docs/             README artwork
```

## Known limits

- Pinterest's private web-resource responses can change without notice.
- ZIP creation uses ZIP32 in memory. Very large boards can require substantial memory.
- At most two boards run at once to limit memory and Pinterest request pressure; further selections wait their turn.
- Pins Pinterest marks ineligible, or which expose no downloadable media, are skipped.
- Users are responsible for respecting Pinterest's terms, copyright, and creators' rights.

## License

[MIT](LICENSE) © 2026 Pinpull contributors.
