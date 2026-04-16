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
| `scripts/prepare-sidecar.js` | Copies the local kei binary into `src-tauri/binaries/` for bundling |

## Backend commands (src-tauri/src/main.rs)

```
check_kei()                -> String (resolved binary path)
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

## kei binary (sidecar)

The kei binary is bundled using Tauri's `externalBin` mechanism. Before building or running in dev mode, run:

```bash
npm run prepare-sidecar
```

This copies the locally-installed kei binary to `src-tauri/binaries/kei-<target-triple>[.exe]`. The binaries directory is gitignored.

`which_kei()` in `main.rs` resolves the binary in this order:
1. Sidecar alongside the current executable (`current_exe().parent()/kei[.exe]`)
2. `$KEI_BIN` env override
3. Common install locations (`~/.cargo/bin`, Homebrew, `/usr/local/bin`, etc.)
4. `which`/`where` PATH lookup

## kei data locations

| Platform | Config dir | Database |
|---|---|---|
| macOS / Linux | `~/.config/kei/` | `~/.config/kei/cookies/<sanitised_username>.db` |
| Windows | `%APPDATA%\kei\` | `%APPDATA%\kei\cookies\<sanitised_username>.db` |

`kei_config_dir()` in `main.rs` returns the correct platform path. The username is sanitised by keeping only alphanumeric chars and `-` (stripping `@`, `.`, etc.).

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
- `kei_config_dir()` uses `%APPDATA%` on Windows, `~/.config/kei` elsewhere.
- The binary name is `kei` on Unix and `kei.exe` on Windows; `which_kei()` handles this with `#[cfg(target_os = "windows")]`.

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
