<p align="center">
  <img src="public/icon/128.png" width="96" height="96" alt="TabBlackBox logo">
</p>

<h1 align="center">TabBlackBox</h1>

<p align="center">
  Automatic backups, versioning, and restoration for Chromium browser tabs and sessions.<br>
  Everything stays in your browser. No accounts. No cloud.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
  <img src="https://img.shields.io/badge/Chromium-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white" alt="Chromium Manifest V3">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

## Features

### Popup

The browser extension popup shows when the next automatic backup runs and when the last one was saved. Create a manual backup of your currently open tabs, list the last 20 closed tabs, or enter the backups page.

![TabBlackBox popup with backup status and actions](assets/screenshots/popup.png)

### Backups page

The Backups page marks each day on a calendar by how many backups it holds. Manual and automatic backups each have their own table, with a backup count, total storage size, and the option to sort by ID or creation date. Every entry can be expanded, renamed, tagged, exported, deleted, or the backed up tabs can be restored.

![Backups page with calendar and backup lists](assets/screenshots/backups-page.png)

### Expanded backup

Expanding a backup shows its windows, tab groups, and every individual tab. The restore button reopens the whole session in new windows and leaves the tabs you already have open.

![Expanded backup listing the tabs in a session](assets/screenshots/expanded-backup.png)

### Tab diff

Each backup is compared with the one before it. Added tabs have green markers, removed tabs have red markers and are crossed out, and unchanged tabs are collapsed into a single line.

![Expanded backup showing added, removed, and unchanged tabs against the previous backup](assets/screenshots/tab-diff.png)

### Statistics page

The Statistics page displays tab counts across automatic and manual backups, along with other info. It also tracks your active tab count over time and the websites that appear most often across your backups.

![Statistics page with tab count chart and top websites](assets/screenshots/statistics-page.png)

### Settings page

Set how often automatic backups run, how long they are kept, and how much space they can use. Lightweight tab restores and the color theme are also configured here.

![TabBlackBox settings for automatic backups, storage limits, and restore options](assets/screenshots/settings-page.png)

## Install

Building it yourself requires Node.js 24 and npm:

```sh
npm install
```

```sh
npm run build
```

In a Chromium browser, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `.output/chrome-mv3` to add the extension.

## Testing

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Strict TypeScript checks |
| `npm test` | Unit and integration tests |
| `npm run test:install-browser` | Install an isolated Chromium for browser tests |
| `npm run test:e2e` | End-to-end tests in dedicated browser profiles |

## Privacy

Backups stay in your browser profile. TabBlackBox sends nothing anywhere, and there are no accounts or cloud. Saved URLs and titles can contain sensitive data such as access tokens or local file paths, and TabBlackBox does not encrypt its records or exports. The [bundled privacy policy](public/privacy.html) also opens offline from the popup.

## Documentation

TODO
