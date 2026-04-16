# Kei PhotoSync

A native macOS GUI for [kei](https://github.com/rhoopr/kei), the iCloud photo sync CLI tool written in Rust.

This app does **not** modify kei's source. It wraps the existing binary: spawning it as a child process, streaming its output, reading and writing its TOML config, and querying its SQLite state database.

## Requirements

- macOS 13+
- [kei](https://github.com/rhoopr/kei) installed and working (`kei --version`)
- Rust + Cargo (via [rustup](https://rustup.rs))
- Node.js 18+
- Xcode Command Line Tools (`xcode-select --install`)

## Quick start

```bash
# Install JS dependencies (first time only)
npm install

# Launch in development mode
npm run dev
```

The first build takes a few minutes (Tauri compiles WKWebView bindings). Subsequent runs are fast.

## Building for distribution

```bash
npm run build
# Output: src-tauri/target/release/bundle/macos/Kei PhotoSync.app
```

## Project structure

```
Kei PhotoSync/
├── index.html              # App shell — sidebar + 4 views + 2FA modal
├── src/
│   ├── styles.css          # macOS-native styling with full dark-mode support
│   └── app.js              # Frontend: Tauri invoke/listen calls, view logic
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json    # Tauri v2 permission grants
    ├── icons/
    │   └── icon.png        # Replace with your own 512×512 RGBA PNG
    └── src/
        └── main.rs         # All backend commands (see below)
```

## Views

| View | What it shows |
|---|---|
| **Dashboard** | Asset counts (downloaded / pending / failed / total) and last sync run summary, read from kei's SQLite DB |
| **Sync** | Start/Stop button, live streaming log, indeterminate progress bar, automatic 2FA prompt dialog |
| **History** | Table of the last 100 sync runs with duration and status |
| **Settings** | Form that reads and writes `~/.config/kei/config.toml` |

## Backend commands

All backend logic lives in [src-tauri/src/main.rs](src-tauri/src/main.rs).

| Command | Description |
|---|---|
| `get_config` | Reads `~/.config/kei/config.toml`; returns defaults if absent |
| `save_config` | Serialises the config struct back to TOML |
| `get_status` | Queries the kei SQLite DB for asset counts and last sync_run |
| `get_history` | Returns the last 100 rows from the `sync_runs` table |
| `start_sync` | Spawns `kei sync`, streams stdout/stderr as `sync-output` Tauri events |
| `stop_sync` | Sends SIGKILL to the running kei process |
| `submit_2fa` | Runs `kei login submit-code <CODE>` as a separate process |

## kei binary resolution

The backend looks for the `kei` binary in this order:

1. `$KEI_BIN` environment variable
2. `~/.cargo/bin/kei`
3. `/usr/local/bin/kei`
4. `/opt/homebrew/bin/kei`
5. `which kei` (PATH fallback)

If kei is installed somewhere else, set `KEI_BIN=/path/to/kei` before running.

## Config file reference

Settings are persisted to `~/.config/kei/config.toml`. The GUI exposes the most commonly used fields:

```toml
[auth]
username = "you@icloud.com"
domain   = "com"          # or "cn" for China

[download]
directory        = "~/Photos/iCloud"
threads_num      = 10
folder_structure = "%Y/%m/%d"   # strftime; {album} token supported
set_exif_datetime = false

[filters]
skip_videos    = false
albums         = ["Vacation"]
exclude_albums = ["Screenshots"]
recent         = 0              # 0 = all

[watch]
interval = 3600   # seconds; omit to disable watch mode

log_level = "info"
```

Passwords are **never** stored in the TOML file. kei stores credentials in the macOS Keychain. Set up credentials once with `kei config setup` or `kei password set`.

## Replacing the placeholder icon

```bash
# Generates all required sizes from a single source image
npx tauri icon path/to/your-icon.png
```

## Troubleshooting

**kei not found** — Run `which kei` and set `KEI_BIN` if it's in an unusual location.

**No data in Dashboard** — kei creates its SQLite database only after the first successful sync. Run `kei sync` once from the terminal to initialise it.

**Advanced Data Protection (ADP)** — kei cannot sync if ADP is enabled on your iCloud account. Disable it in System Settings → Apple ID → iCloud → Advanced Data Protection.

**2FA loop** — If the 2FA dialog keeps appearing, your kei session may have expired. Run `kei verify` in the terminal to re-authenticate.
