# Claude agent guide — Kei PhotoSync

This document gives an AI agent the context needed to work in this repo confidently.

## What this project is

A Tauri v2 cross-platform desktop GUI that wraps the [kei](https://github.com/rhoopr/kei) iCloud photo sync CLI. The GUI does not contain any sync logic — it spawns the kei binary, streams its output, and reads/writes its config and SQLite database.

**Supported platforms:** macOS (primary), Windows 10+, Linux.

**Rule:** never modify kei's source or vendor it. All behaviour changes go through the GUI layer or by passing CLI flags to the kei binary.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust backend + WebView frontend) |
| Frontend | Vanilla HTML/CSS/JS, bundled by Vite |
| Backend | Rust, async via Tokio |
| Config I/O | `toml` crate + `serde` |
| Database | `rusqlite` (bundled SQLite, sync queries run via `spawn_blocking`) |
| Process mgmt | `tokio::process::Command` |
| JS ↔ Rust | `@tauri-apps/api` v2 (`invoke` for commands, `listen` for events) |
| Bundled binary | kei is shipped as a Tauri sidecar (`externalBin`) |

## Key files

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | All Tauri commands and application state |
| `src/app.js` | Frontend logic: routing, invoke calls, event listeners |
| `src/log-parsers.js` | Extensible log parser/renderer registry |
| `src/styles.css` | Native-style theming (CSS variables, dark mode via `prefers-color-scheme`) |
| `index.html` | App shell with sidebar navigation and view containers |
| `src-tauri/tauri.conf.json` | Window config, bundle settings, sidecar declaration |
| `src-tauri/capabilities/default.json` | Tauri v2 permission grants |
| `src-tauri/binaries/.kei-version` | Pinned kei release tag (committed); used by prepare-sidecar to reproduce the same version |
| `scripts/prepare-sidecar.js` | Downloads the kei binary from GitHub into `src-tauri/binaries/` for bundling |
| `scripts/build-windows.sh` | Cross-compiles a Windows `.exe` on macOS using `cargo-xwin` + LLVM |

## Backend commands (src-tauri/src/main.rs)

```
check_kei()                    -> String           // resolved binary path
get_config()                   -> KeiConfig
save_config(config)            -> ()
get_app_settings()             -> AppSettings      // UI-only settings (folder structure, etc.)
save_app_settings(settings)    -> ()
get_kei_versions()             -> KeiVersions      // bundled + system kei paths and versions
get_status()                   -> SyncStatus       // reads SQLite
get_history()                  -> Vec<SyncRun>     // reads SQLite
start_sync(app)                -> ()               // spawns kei sync
stop_sync()                    -> ()               // kills child process
submit_password(password)      -> ()               // writes password to kei's stdin
request_2fa_code(app)          -> ()               // runs kei login get-code
submit_2fa(app, code)          -> ()               // runs kei login submit-code <CODE>
clear_kei_session()            -> ()               // deletes session/cookie files
list_kei_albums()              -> Vec<String>      // runs kei list albums
open_url(url)                  -> ()               // opens URL in system browser
```

### App state

```rust
struct AppState {
    sync_child: Arc<Mutex<Option<tokio::process::Child>>>,
    sync_stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}
```

There is exactly one `AppState` instance, registered with `.manage()` at startup. Commands that need it take `state: State<'_, AppState>`. `sync_stdin` is kept open so password responses can be written without re-spawning the process.

### AppSettings vs KeiConfig

`KeiConfig` maps directly to kei's `config.toml` and is read/written by the kei binary itself. `AppSettings` is a separate file (`~/.config/kei-photosync/settings.toml`) that holds UI-only preferences kei doesn't know about: `use_system_kei`, `all_albums`, `folder_structure`, `album_folder_structure`. The `folder_structure` computed from `AppSettings` is passed to kei as `--folder-structure` at sync time — it is **not** written to kei's `config.toml` (doing so causes kei to report "Config changed — verifying all files" on every sync due to TOML serialisation differences).

### Tauri events emitted from Rust → JS

| Event | Payload | Meaning |
|---|---|---|
| `sync-output-batch` | `Vec<String>` | Batch of stdout/stderr lines (flushed every 50 ms or when 200 lines accumulate) |
| `sync-2fa-required` | `String` | kei printed a 2FA prompt; show the input dialog |
| `sync-password-required` | `String` | kei printed an interactive password prompt |
| `sync-adp-detected` | `String` | Advanced Data Protection error detected in output |
| `sync-session-reset` | `()` | HTTP 421 detected; session files cleared automatically |
| `sync-lock-cleared` | `()` | Stale `.lock` file detected and removed |
| `sync-completed` | `()` | kei exited 0 |
| `sync-failed` | `String` | kei exited non-zero; payload is the error message |

### 2FA flow

kei does **not** accept the 2FA code on stdin. The correct flow is:

1. Detect `"2FA code requested"` / `"submit-code"` in stdout.
2. Emit `sync-2fa-required` to the frontend.
3. User enters the 6-digit code in the modal.
4. Frontend calls `submit_2fa(code)`.
5. Backend runs `kei login submit-code <CODE>` as a separate process.
6. kei sync continues automatically once the code is accepted.

## kei binary (sidecar)

The kei binary is bundled using Tauri's `externalBin` mechanism. Before building or running in dev mode, run:

```bash
npm run prepare-sidecar
```

This downloads the pinned kei release (from `src-tauri/binaries/.kei-version`) to `src-tauri/binaries/kei-<target-triple>[.exe]`. The binaries themselves are gitignored; the version file is committed. Pass `--force` to fetch latest and update the pin.

To update kei: `node scripts/prepare-sidecar.js --force`, then commit `.kei-version`.

`resolve_kei_bin()` in `main.rs` resolves the binary in this order:
1. Sidecar alongside the current executable (`current_exe().parent()/kei[.exe]`)
2. `$KEI_BIN` env override
3. `which`/`where` PATH lookup (via login shell on macOS/Linux)

## kei data locations

| Platform | Config dir | Database |
|---|---|---|
| macOS / Linux | `~/.config/kei/` | `~/.config/kei/cookies/<sanitised_username>.db` |
| Windows | `%USERPROFILE%\.config\kei\` | `%USERPROFILE%\.config\kei\cookies\<sanitised_username>.db` |

`kei_config_dir()` in `main.rs` returns the correct platform path. On Windows it uses `USERPROFILE` (not `APPDATA`) because kei uses the same `~/.config/kei` path on all platforms. The username is sanitised by keeping only alphanumeric chars and `-` (stripping `@`, `.`, etc.).

## SQLite schema (read-only)

```sql
-- Asset download state
assets (
    id TEXT, version_size TEXT,
    filename TEXT, media_type TEXT,
    status TEXT,          -- 'pending' | 'downloaded' | 'failed'
    size_bytes INTEGER, created_at INTEGER,
    download_attempts INTEGER, last_error TEXT,
    PRIMARY KEY (id, version_size)
)

-- One row per sync session
sync_runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER, completed_at INTEGER,
    assets_seen INTEGER, assets_downloaded INTEGER,
    assets_failed INTEGER, interrupted INTEGER
)
```

The GUI never writes to the database.

## Config struct (Rust ↔ TOML ↔ JS)

```rust
KeiConfig {
    log_level: Option<String>,
    auth:     Option<AuthConfig>,      // username, domain
    download: Option<DownloadConfig>,  // directory, threads_num, folder_structure, set_exif_datetime
    filters:  Option<FiltersConfig>,   // skip_videos, skip_photos, albums, exclude_albums, recent
    watch:    Option<WatchConfig>,     // interval
}
```

All fields are `Option` so that unset fields are omitted from the TOML output (kei uses its own defaults for absent keys).

## Frontend conventions

- Bundled by Vite (dev server on port 1420). `index.html` loads `src/app.js` as `type="module"`.
- Navigation is done by toggling `class="view active"` on `<section>` elements.
- Each view has a load function (`loadDashboard`, `loadHistory`, `loadSettings`) called when the view is shown.
- The sync log uses the parser registry in `src/log-parsers.js` — add new parsers there, not in `app.js`.
- CSS variables are defined on `:root` for light mode and overridden in `@media (prefers-color-scheme: dark)`.
- Visibility is controlled with `.hidden` class (never inline `style="display:none"`).

## Log parser registry (src/log-parsers.js)

Each parser is `{ name, match(line), parse(line), render(entry) }`. Register with `registerParser()`.

```js
// Exports
stripAnsi(s)           // strips ANSI escape codes
dedupKey(parsed)       // returns "level:module:message" for kei-tracing, else null
parseLine(raw)         // normalises + dispatches to first matching parser
renderEntry(parsed)    // dispatches to matching parser's render()
registerParser(parser) // appends to registry
```

Built-in parsers: `kei-tracing` (timestamp + level + module + fields), `kei-summary` (── separator lines).

Message labels live in `MESSAGE_LABELS` (exact match) and `MESSAGE_PREFIX_LABELS` (prefix match) — add new ones there to humanise kei output without touching render logic.

## Platform notes

- `titleBarStyle: "Overlay"` and `hiddenTitle: true` in `tauri.conf.json` are macOS-only; Tauri ignores them on Windows/Linux (native window decorations are used instead).
- `-webkit-app-region: drag` in CSS works in WKWebView (macOS), WebView2 (Windows), and WebKitGTK (Linux) within Tauri.
- `kei_config_dir()` uses `%USERPROFILE%\.config\kei` on Windows (matching kei's own path), `~/.config/kei` elsewhere.
- The binary name is `kei` on Unix and `kei.exe` on Windows; `resolve_kei_bin()` handles this with `#[cfg(target_os = "windows")]`.
- All child process spawns on Windows use `creation_flags(0x08000000)` (`CREATE_NO_WINDOW`) to suppress the console flash that would otherwise appear briefly when kei or helper commands are launched.

## Adding a new backend command

1. Write the `async fn` in `main.rs` with `#[tauri::command]`.
2. Register it in the `tauri::generate_handler![]` macro at the bottom of `main.rs`.
3. Call it from JS with `invoke("command_name", { param: value })`.
4. No codegen step needed — Tauri's macros handle the glue.

## Adding a new view

1. Add a `<section id="view-<name>" class="view">` in `index.html`.
2. Add a `<li class="nav-item" data-view="<name>">` in the sidebar.
3. Add an entry to `VIEW_TITLES` and a load-function call in `showView()` in `app.js`.

## Common pitfalls

- **`use tauri::Emitter`** must be in scope to call `.emit()` on an `AppHandle`. Already imported; don't remove it.
- **`rusqlite` is synchronous.** Always wrap DB calls in `tokio::task::spawn_blocking(|| { ... }).await`.
- **`Option` fields in config structs should stay `None` when not set** — they are serialised as absent TOML keys, which kei treats as "use default".
- **The `frontendDist` path is `"../dist"`.** Do not set `devUrl` to a file path — Tauri's validator requires it to be a proper URL.
- **Icons must be RGBA PNG.** The placeholder at `src-tauri/icons/icon.png` is a solid blue 512×512 RGBA PNG. Replace before shipping.
- **`TRACING_RE` uses `(\S+)` for the module group**, not `[^:]+` — Rust module paths contain `::` and the old pattern would fail to match them.
