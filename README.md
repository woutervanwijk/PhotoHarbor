# PhotoHarbor

Cloud Photo Downloader for macOS, Windows, and Linux.

Download your iCloud Photos to your own computer. PhotoHarbor copies photos and videos from iCloud Photos to a local folder, with support for albums, Apple smart folders, Live Photos, browsing downloaded files, and sync history. Based on the [kei](https://github.com/rhoopr/kei) sync engine.

## Supported platforms

| Platform | Status |
|---|---|
| macOS 13+ | Primary target; native overlay title bar |
| Windows 10+ | Supported; native window decorations |
| Linux | Supported; native window decorations |

## Installing the macOS App

Tagged GitHub releases build a signed and notarized universal macOS app. The release workflow signs and notarizes the `.app`, creates a plain DMG with `hdiutil`, then signs, notarizes, and staples that DMG. The DMG intentionally does not use Tauri's fancy Finder layout script because that step is fragile in CI.

If you build locally without Apple signing credentials, Gatekeeper may still block the app on first launch. To open a local unsigned build anyway:

**Option 1 — System Settings**
1. Try to open the app normally — it will be blocked
2. Go to **System Settings → Privacy & Security**
3. Scroll down and click **Open Anyway** next to the blocked app

**Option 2 — Terminal (removes the quarantine flag permanently)**
```bash
xattr -cr "/Applications/PhotoHarbor.app"
```

## Requirements (for building from source)

- Rust + Cargo (via [rustup](https://rustup.rs))
- Node.js 18+
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- On Linux: `libwebkit2gtk`, `libgtk-3`, `libayatana-appindicator3` (see [Tauri Linux dependencies](https://tauri.app/start/prerequisites/#linux))

kei itself is downloaded automatically by `npm run prepare-sidecar` — no separate installation needed.

## Quick start

```bash
# Install JS dependencies
npm install

# Download the latest kei release from GitHub into src-tauri/binaries/
npm run prepare-sidecar

# Launch in development mode
npm run dev
```

The first build takes a few minutes (Tauri compiles the WebView bindings). Subsequent runs are fast.

`prepare-sidecar` is a no-op if the binary is already present. The downloaded version is pinned in `src-tauri/binaries/.kei-version` so cross-platform builds always use the same release.

To update the bundled kei to the latest release:

```bash
node scripts/prepare-sidecar.js --force
git add src-tauri/binaries/.kei-version
git commit -m "update kei sidecar to vX.Y.Z"
```

## Building for distribution

```bash
npm run prepare-sidecar   # ensure sidecar is up to date
npm run build
```

Output locations:
- macOS: `src-tauri/target/release/bundle/macos/PhotoHarbor.app`
- Windows: `src-tauri/target/release/bundle/msi/` or `nsis/`
- Linux: `src-tauri/target/release/bundle/deb/` or `appimage/`

## Release CI

`.github/workflows/build.yml` builds macOS, Windows, and Linux on `v*` tags and creates a draft GitHub Release.

macOS release signing expects these GitHub secrets:

| Secret | Meaning |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` certificate with private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` file |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | Apple app-specific password, not the normal Apple ID password |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

If the `.p12` was exported with legacy encryption and OpenSSL reports `Algorithm (RC2-40-CBC) unsupported`, convert it locally to a modern `.p12` before updating `APPLE_CERTIFICATE`.

Tauri's Rust crate and npm packages must stay on the same major/minor version. For example, Rust `tauri 2.11.x` must be paired with `@tauri-apps/api 2.11.x`. The Tauri npm packages are pinned exactly in `package.json` to make Dependabot version drift obvious.

When release, signing, dependency, or workflow behavior changes, update both `README.md` and `agents/AGENTS.md` in the same change.

## Project structure

```
PhotoHarbor/
├── index.html              # App shell — sidebar + 4 views + modals
├── scripts/
│   ├── prepare-sidecar.js  # Downloads kei binary into src-tauri/binaries/
│   └── build-windows.sh    # Cross-compiles Windows .exe on macOS (cargo-xwin)
├── src/
│   ├── app.js              # Frontend: Tauri invoke/listen calls, view logic
│   ├── log-parsers.js      # Extensible log parser registry
│   └── styles.css          # Native-style theming with full dark-mode support
└── src-tauri/
    ├── binaries/
    │   └── .kei-version    # Pinned kei release tag (committed)
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json    # Tauri v2 permission grants
    ├── icons/
    │   └── icon.png        # Replace with your own 512×512 RGBA PNG
    └── src/
        └── main.rs         # All backend commands
```

## Views

| View | What it shows |
|---|---|
| **Sync** | Start/Stop button, kei friendly progress UI, expandable compact/full logs, recent thumbnail strip, and automatic password/2FA prompts |
| **Browse** | Folder browser rooted at the configured download directory, with cached thumbnails, video previews, Live Photo pairing, breadcrumbs, and Finder/File Explorer open actions |
| **History** | Table of the last 100 sync runs with duration and status, plus clear-history/statistics action |
| **Settings** | Form that reads and writes the kei config file, including selectable albums and Apple smart folders |

## Backend commands

All backend logic lives in [src-tauri/src/main.rs](src-tauri/src/main.rs).

| Command | Description |
|---|---|
| `check_kei` | Returns the resolved kei binary path, or an error if not found |
| `get_config` | Reads kei's config file; returns defaults if absent |
| `save_config` | Serialises the config struct back to TOML |
| `get_app_settings` | Reads UI-only settings (folder structure, system kei toggle, etc.) |
| `save_app_settings` | Writes UI-only settings |
| `get_kei_versions` | Returns paths and version strings for bundled and system kei |
| `get_status` | Queries the kei SQLite DB for asset counts and last sync_run |
| `get_history` | Returns the last 100 rows from the `sync_runs` table |
| `start_sync` | Spawns `kei sync`, streams output as batched Tauri events |
| `stop_sync` | Sends SIGKILL to the running kei process |
| `submit_password` | Writes a password to kei's stdin |
| `request_2fa_code` | Runs `kei login get-code` to push a 2FA prompt to trusted devices |
| `submit_2fa` | Runs `kei login submit-code <CODE>` as a separate process |
| `clear_kei_session` | Deletes kei session/cookie files to force re-authentication |
| `list_kei_albums` | Runs `kei list albums` and returns the album names |
| `list_kei_smart_folders` | Runs kei and returns available Apple smart folders |
| `browse_photos` | Lists one folder level from the configured download root, returning child folders and direct media assets |
| `get_recent_downloads` | Returns up to 100 recently downloaded media assets with cached thumbnails and Live Photo pairing |
| `open_folder` | Opens a folder in the system file manager |
| `open_containing_folder` | Opens the containing folder for a media file |

## kei data locations

| Platform | Config file | Database |
|---|---|---|
| macOS / Linux | `~/.config/kei/config.toml` | `~/.config/kei/cookies/<user>.db` |
| Windows | `%USERPROFILE%\.config\kei\config.toml` | `%USERPROFILE%\.config\kei\cookies\<user>.db` |

## Config file reference

```toml
[auth]
username = "you@icloud.com"
domain   = "com"          # or "cn" for China

[download]
directory                      = "~/Photos/iCloud"
threads_num                    = 10
folder_structure               = "%Y/%m/%d"       # unfiled photos
folder_structure_albums        = "{album}/%Y/%m"  # user albums
folder_structure_smart_folders = "{smart-folder}" # Apple smart folders
set_exif_datetime = false

[download.retry]
max_download_attempts = 10

[filters]
skip_videos    = false
libraries      = ["primary"]
albums         = ["Vacation", "!Screenshots"]
smart_folders  = ["Favorites"]
unfiled        = true
recent         = 0              # 0 = all

[watch]
interval = 3600   # seconds; omit to disable watch mode

log_level = "info"
```

Passwords are **never** stored in the config file. kei stores credentials in the system keychain. Set up credentials once with `kei config setup` or `kei password set`.

## Replacing the placeholder icon

```bash
# Generates all required sizes from a single source image
npx tauri icon path/to/your-icon.png
```

## Troubleshooting

**kei not found** — Run `npm run prepare-sidecar`. If kei itself is missing, install it with `cargo install kei` first.

**No data in Sync statistics** — kei creates its SQLite database only after the first successful sync. Run `kei sync` once from the terminal to initialise it, or use the Sync view.

**Advanced Data Protection (ADP)** — kei cannot sync if ADP is enabled on your iCloud account. Disable it in System Settings → Apple ID → iCloud → Advanced Data Protection.

**2FA loop** — If the 2FA dialog keeps appearing, your kei session may have expired. Run `kei verify` in the terminal to re-authenticate.

--
Icon from IO Images:
https://pixabay.com/de/vectors/wolke-cloud-herunterladen-speichern-2044822/
