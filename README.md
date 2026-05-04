# Kei PhotoSync

A native desktop GUI for [kei](https://github.com/rhoopr/kei), the iCloud photo sync CLI tool written in Rust.

This app does **not** modify kei's source. It wraps the existing binary: spawning it as a child process, streaming its output, reading and writing its TOML config, and querying its SQLite state database.

The kei binary is bundled inside the app — end users do not need to install it separately.

## Supported platforms

| Platform | Status |
|---|---|
| macOS 13+ | Primary target; native overlay title bar |
| Windows 10+ | Supported; native window decorations |
| Linux | Supported; native window decorations |


## 🖥️ Installing the macOS App

The macOS build is not notarized, so Gatekeeper will block it on first launch. To open it anyway:

**Option 1 — System Settings**
1. Try to open the app normally — it will be blocked
2. Go to **System Settings → Privacy & Security**
3. Scroll down and click **Open Anyway** next to the blocked app

**Option 2 — Terminal (removes the quarantine flag permanently)**
```bash
xattr -cr "/Applications/Kei PhotoSync.app"
```

## Requirements (for building from source)

- Rust + Cargo (via [rustup](https://rustup.rs))
- Node.js 18+
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- On Linux: `libwebkit2gtk`, `libgtk-3`, `libayatana-appindicator3` (see [Tauri Linux dependencies](https://tauri.app/start/prerequisites/#linux))

kei itself is downloaded automatically by `pnpm run prepare-sidecar` — no separate installation needed.

## Quick start

```bash
# Install JS dependencies
pnpm install

# Download the latest kei release from GitHub into src-tauri/binaries/
pnpm run prepare-sidecar

# Launch in development mode
pnpm run dev
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
pnpm run prepare-sidecar   # ensure sidecar is up to date
pnpm run build
```

Output locations:
- macOS: `src-tauri/target/release/bundle/macos/Kei PhotoSync.app`
- Windows: `src-tauri/target/release/bundle/msi/` or `nsis/`
- Linux: `src-tauri/target/release/bundle/deb/` or `appimage/`

## Project structure

```
Kei PhotoSync/
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
| **Dashboard** | Asset counts (downloaded / pending / failed / total) and last sync run summary, read from kei's SQLite DB |
| **Sync** | Start/Stop button, live streaming log with structured formatting, indeterminate progress bar, automatic 2FA prompt dialog |
| **History** | Table of the last 100 sync runs with duration and status |
| **Settings** | Form that reads and writes the kei config file |

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

**kei not found** — Run `pnpm run prepare-sidecar`. If kei itself is missing, install it with `cargo install kei` first.

**No data in Dashboard** — kei creates its SQLite database only after the first successful sync. Run `kei sync` once from the terminal to initialise it, or use the Sync view.

**Advanced Data Protection (ADP)** — kei cannot sync if ADP is enabled on your iCloud account. Disable it in System Settings → Apple ID → iCloud → Advanced Data Protection.

**2FA loop** — If the 2FA dialog keeps appearing, your kei session may have expired. Run `kei verify` in the terminal to re-authenticate.

--
Icon from IO Images:
https://pixabay.com/de/vectors/wolke-cloud-herunterladen-speichern-2044822/
