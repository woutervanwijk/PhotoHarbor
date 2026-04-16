# Claude agent guide — Kei PhotoSync

This document gives an AI agent the context needed to work in this repo confidently.

## What this project is

A Tauri v2 macOS GUI that wraps the [kei](https://github.com/rhoopr/kei) iCloud photo sync CLI. The GUI does not contain any sync logic — it spawns the kei binary, streams its output, and reads/writes its config and SQLite database.

**Rule:** never modify kei's source or vendor it. All behaviour changes go through the GUI layer or by passing CLI flags to the kei binary.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) (Rust backend + WKWebView frontend) |
| Frontend | Vanilla HTML/CSS/JS — no bundler, no framework |
| Backend | Rust, async via Tokio |
| Config I/O | `toml` crate + `serde` |
| Database | `rusqlite` (bundled SQLite, sync queries run via `spawn_blocking`) |
| Process mgmt | `tokio::process::Command` |
| JS ↔ Rust | `@tauri-apps/api` v2 (`invoke` for commands, `listen` for events) |

## Key files

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | All Tauri commands and application state |
| `src/app.js` | Frontend logic: routing, invoke calls, event listeners |
| `src/styles.css` | macOS-native styling (CSS variables, dark mode via `prefers-color-scheme`) |
| `index.html` | App shell with sidebar navigation and view containers |
| `src-tauri/tauri.conf.json` | Window config, bundle settings, `frontendDist` |
| `src-tauri/capabilities/default.json` | Tauri v2 permission grants |

## Backend commands (src-tauri/src/main.rs)

```
get_config()               -> KeiConfig
save_config(config)        -> ()
get_status()               -> SyncStatus    // reads SQLite
get_history()              -> Vec<SyncRun>  // reads SQLite
start_sync(app)            -> ()            // spawns kei sync
stop_sync()                -> ()            // kills child process
submit_2fa(code)           -> ()            // runs kei login submit-code <CODE>
```

### App state

```rust
struct AppState {
    sync_child: Arc<Mutex<Option<tokio::process::Child>>>,
}
```

There is exactly one `AppState` instance, registered with `.manage()` at startup. Commands that need it take `state: State<'_, AppState>`.

### Tauri events emitted from Rust → JS

| Event | Payload | Meaning |
|---|---|---|
| `sync-output` | `String` | One line of stdout or stderr from kei |
| `sync-2fa-required` | `String` | kei printed a 2FA prompt; show the input dialog |
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

## kei data locations

| Path | Contents |
|---|---|
| `~/.config/kei/config.toml` | Main configuration |
| `~/.config/kei/<username>.db` | SQLite state database |
| `~/.config/kei/health.json` | Last-sync health status (not currently used by the GUI) |

The database username is sanitised: non-alphanumeric chars (including `@` and `.`) become `_`. The `db_path()` helper in `main.rs` tries the sanitised name first, then falls back to any `.db` file in the config dir.

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

- No build step. `index.html` loads `src/app.js` as `type="module"` and `src/styles.css` directly.
- Navigation is done by toggling `class="view active"` on `<section>` elements.
- Each view has a load function (`loadDashboard`, `loadHistory`, `loadSettings`) called when the view is shown.
- The sync log uses `span.log-line` elements with optional `err` / `warn` / `success` classes for colouring.
- CSS variables are defined on `:root` for light mode and overridden in `@media (prefers-color-scheme: dark)`.

## Adding a new backend command

1. Write the `async fn` in `main.rs` with `#[tauri::command]`.
2. Register it in the `tauri::generate_handler![]` macro at the bottom of `main.rs`.
3. Call it from JS with `invoke("command_name", { param: value })`.
4. No codegen step needed — Tauri's macros handle the glue.

## Adding a new view

1. Add a `<section id="view-<name>" class="view">` in `index.html`.
2. Add a `<li class="nav-item" data-view="<name>">` in the sidebar.
3. Add a `case "<name>":` branch in the `showView` function in `app.js`.

## Common pitfalls

- **`use tauri::Emitter`** must be in scope to call `.emit()` on an `AppHandle`. It is already imported in `main.rs`; don't remove it.
- **`rusqlite` is synchronous.** Always wrap DB calls in `tokio::task::spawn_blocking(|| { ... }).await`.
- **`Option` fields in config structs should stay `None` when not set** — serialising `None` with `#[serde(skip_serializing_if = "Option::is_none")]` would keep the TOML clean, but that attribute is not currently applied. If you add it, add it to all `Option` fields consistently.
- **The `frontendDist` path is `"../"` (relative to `src-tauri/`).** Do not set `devUrl` to a file path — Tauri's build validator requires it to be a valid URL or absent.
- **Icons must be RGBA PNG.** The placeholder at `src-tauri/icons/icon.png` is a solid blue 512×512 RGBA PNG. Replace it before shipping.
