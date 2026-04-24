// Prevents a console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// Config structs — mirrors ~/.config/kei/config.toml
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct KeiConfig {
    pub log_level: Option<String>,
    pub auth: Option<AuthConfig>,
    pub download: Option<DownloadConfig>,
    pub filters: Option<FiltersConfig>,
    pub watch: Option<WatchConfig>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AuthConfig {
    pub username: Option<String>,
    pub domain: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct DownloadConfig {
    pub directory: Option<String>,
    pub threads_num: Option<u32>,
    pub folder_structure: Option<String>,
    pub set_exif_datetime: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct FiltersConfig {
    pub skip_videos: Option<bool>,
    pub skip_photos: Option<bool>,
    pub albums: Option<Vec<String>>,
    pub exclude_albums: Option<Vec<String>>,
    pub recent: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct WatchConfig {
    pub interval: Option<u64>,
}

// ---------------------------------------------------------------------------
// Status / history structs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncStatus {
    pub total_assets: i64,
    pub downloaded: i64,
    pub pending: i64,
    pub failed: i64,
    pub last_run_started: Option<i64>,
    pub last_run_completed: Option<i64>,
    pub last_run_downloaded: Option<i64>,
    pub last_run_failed: Option<i64>,
    pub is_syncing: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncRun {
    pub id: i64,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub assets_seen: i64,
    pub assets_downloaded: i64,
    pub assets_failed: i64,
    pub interrupted: bool,
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub sync_child: Arc<Mutex<Option<Child>>>,
    /// Stdin pipe to the running kei process — used to respond to password
    /// prompts without re-spawning the process.
    pub sync_stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Returns the kei config directory (~/.config/kei on Linux/macOS,
/// %APPDATA%\kei on Windows).
fn kei_config_dir() -> Result<std::path::PathBuf, String> {
    // kei uses $HOME/.config/kei on all platforms, including Windows where
    // $HOME / USERPROFILE maps to C:\Users\<name>.
    #[cfg(target_os = "windows")]
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    Ok(std::path::PathBuf::from(home).join(".config").join("kei"))
}

fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(kei_config_dir()?.join("config.toml"))
}

/// Locate the SQLite database for a given username.
/// kei stores databases in ~/.config/kei/cookies/<sanitised_username>.db
/// where sanitisation strips all non-alphanumeric characters (except '-').
fn db_path(username: &str) -> Result<std::path::PathBuf, String> {
    let base = kei_config_dir()?;
    let cookies_dir = base.join("cookies");

    // kei strips non-alphanumeric chars (except '-') from the username.
    let sanitised: String = username
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();

    // Primary: ~/.config/kei/cookies/<sanitised>.db
    let candidate = cookies_dir.join(format!("{}.db", sanitised));
    if candidate.exists() {
        return Ok(candidate);
    }

    // Fallback: any .db file in cookies/ or the config dir itself.
    for dir in [&cookies_dir, &base] {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("db") {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!("No kei database found in {:?}", cookies_dir))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_config() -> Result<KeiConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(KeiConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    toml::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_config(mut config: KeiConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let is_syncing = state.sync_child.lock().await.is_some();

    let config = get_config().await.unwrap_or_default();
    let username = config
        .auth
        .as_ref()
        .and_then(|a| a.username.clone())
        .unwrap_or_default();

    if username.is_empty() {
        return Ok(SyncStatus {
            total_assets: 0,
            downloaded: 0,
            pending: 0,
            failed: 0,
            last_run_started: None,
            last_run_completed: None,
            last_run_downloaded: None,
            last_run_failed: None,
            is_syncing,
        });
    }

    let db = match db_path(&username) {
        Ok(p) => p,
        Err(_) => {
            return Ok(SyncStatus {
                total_assets: 0,
                downloaded: 0,
                pending: 0,
                failed: 0,
                last_run_started: None,
                last_run_completed: None,
                last_run_downloaded: None,
                last_run_failed: None,
                is_syncing,
            })
        }
    };

    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db).map_err(|e| e.to_string())?;

        let total_assets: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE is_deleted = 0", [], |r| r.get(0))
            .unwrap_or(0);
        let downloaded: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'downloaded' AND is_deleted = 0", [], |r| r.get(0))
            .unwrap_or(0);
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'pending' AND is_deleted = 0 AND (last_error IS NULL OR last_error = '')", [], |r| r.get(0))
            .unwrap_or(0);
        // kei has no 'failed' status — assets that repeatedly error stay 'pending'
        // with last_error set.
        let failed: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'pending' AND is_deleted = 0 AND last_error IS NOT NULL AND last_error != ''", [], |r| r.get(0))
            .unwrap_or(0);

        // Last sync_run row
        let last_run: Option<(i64, Option<i64>, i64, i64)> = conn
            .query_row(
                "SELECT started_at, completed_at, assets_downloaded, assets_failed
                 FROM sync_runs ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();

        Ok(SyncStatus {
            total_assets,
            downloaded,
            pending,
            failed,
            last_run_started: last_run.as_ref().map(|r| r.0),
            last_run_completed: last_run.as_ref().and_then(|r| r.1),
            last_run_downloaded: last_run.as_ref().map(|r| r.2),
            last_run_failed: last_run.as_ref().map(|r| r.3),
            is_syncing,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_history() -> Result<Vec<SyncRun>, String> {
    let config = get_config().await.unwrap_or_default();
    let username = config
        .auth
        .as_ref()
        .and_then(|a| a.username.clone())
        .unwrap_or_default();

    if username.is_empty() {
        return Ok(vec![]);
    }

    let db = match db_path(&username) {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };

    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, started_at, completed_at, assets_seen,
                        assets_downloaded, assets_failed, interrupted
                 FROM sync_runs ORDER BY id DESC LIMIT 100",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |r| {
                Ok(SyncRun {
                    id: r.get(0)?,
                    started_at: r.get(1)?,
                    completed_at: r.get(2)?,
                    assets_seen: r.get(3)?,
                    assets_downloaded: r.get(4)?,
                    assets_failed: r.get(5)?,
                    interrupted: r.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detect whether a line indicates kei is blocked by Advanced Data Protection.
/// Matches the patterns documented on the kei Authentication wiki page:
///   https://github.com/rhoopr/kei/wiki/Authentication#how-it-looks-when-adp-blocks-kei
///
/// Intentionally does NOT include bare ZONE_NOT_FOUND or ACCESS_DENIED — those
/// can appear transiently during the normal 2FA auth flow and cause false positives.
fn is_adp_error(line: &str) -> bool {
    let lower = line.to_lowercase();
    // These strings are specific to ADP blocking kei.
    // 421 Misdirected Request is intentionally excluded — it can appear as a
    // transient routing error during normal authentication and causes false positives.
    lower.contains("private db access disabled")
        || lower.contains("advanced data protection")
        || lower.contains("icdpenabled")
}

/// Detect a stale session lock left behind by a previous hard-quit.
fn is_lock_error(line: &str) -> bool {
    line.contains("Session lock held by another instance")
        || line.contains("Another kei instance is running")
}

/// Run `kei list albums` and return the album names.
/// Returns an error if kei is not authenticated or the command fails.
#[tauri::command]
async fn list_kei_albums() -> Result<Vec<String>, String> {
    let kei_bin = resolve_kei_bin().await?;
    let mut cmd = Command::new(&kei_bin);
    cmd.args(["list", "albums"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run kei list albums: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kei list albums failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let albums: Vec<String> = stdout
        .lines()
        .filter(|l| l.starts_with("  ") && !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .collect();

    if albums.is_empty() {
        Err("No albums found".to_string())
    } else {
        Ok(albums)
    }
}

/// Delete any .lock files in the kei cookies directory.
/// Returns true if at least one lock file was removed.
async fn delete_kei_lock() -> bool {
    let Ok(base) = kei_config_dir() else { return false };
    let cookies_dir = base.join("cookies");
    let mut deleted = false;
    if let Ok(rd) = std::fs::read_dir(&cookies_dir) {
        for entry in rd.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("lock") {
                if std::fs::remove_file(entry.path()).is_ok() {
                    deleted = true;
                }
            }
        }
    }
    deleted
}

/// Detect a 421 Misdirected Request that indicates a corrupt/stale session.
/// kei 0.9.x surfaces this as "service error (http_421)" — distinct from the
/// transient retry message ("retrying with fresh connection pool") which kei
/// recovers from on its own.
fn is_session_error(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("http_421")
        || (lower.contains("421") && lower.contains("misdirected") && lower.contains("service error"))
}

/// Emit a batch of log lines to the frontend via the shared `sync-output-batch` event.
/// All kei command output (sync, list-albums, submit-2fa, etc.) goes through this so
/// the global log panel receives everything.
fn emit_log(app: &AppHandle, lines: Vec<String>) {
    if !lines.is_empty() {
        let _ = app.emit("sync-output-batch", &lines);
    }
}

/// Detect whether a raw output line looks like an interactive password prompt.
/// Matches lines that are short, end with ":", and mention "password" —
/// while excluding structured tracing log lines (which have ISO timestamps).
fn is_password_prompt(line: &str) -> bool {
    // Strip common ANSI escape sequences for matching.
    let clean: String = {
        let mut s = String::with_capacity(line.len());
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\x1b' {
                // Skip until the final byte of the escape sequence (a letter).
                for ch in chars.by_ref() {
                    if ch.is_ascii_alphabetic() { break; }
                }
            } else {
                s.push(c);
            }
        }
        s
    };
    let lower = clean.to_lowercase();
    let trimmed = clean.trim_end();
    // Must mention "password", end with ":", be short, and NOT be a tracing line.
    lower.contains("password")
        && trimmed.ends_with(':')
        && trimmed.len() < 160
        && !lower.contains("  info ")
        && !lower.contains("  warn ")
        && !lower.contains("  error ")
        && !lower.contains("  debug ")
}

#[tauri::command]
async fn start_sync(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Guard: don't double-start.
    {
        let guard = state.sync_child.lock().await;
        if guard.is_some() {
            return Err("Sync is already running".to_string());
        }
    }

    // Resolve the kei binary (prefer PATH, fall back to common install locations).
    let kei_bin = resolve_kei_bin().await?;
    let app_settings = get_app_settings().await.unwrap_or_default();

    // If kei's TOML still has albums=["all"] from a previous save, strip it out
    // so kei doesn't try to find a literal album named "all".
    let kei_cfg = get_config().await.unwrap_or_default();
    let toml_had_all = kei_cfg
        .filters
        .as_ref()
        .and_then(|f| f.albums.as_ref())
        .is_some_and(|albums| albums.iter().any(|a| a.eq_ignore_ascii_case("all")));

    if toml_had_all {
        let mut clean = kei_cfg.clone();
        if let Some(ref mut f) = clean.filters {
            f.albums = None;
        }
        if let (Ok(path), Ok(content)) = (config_path(), toml::to_string_pretty(&clean)) {
            let _ = std::fs::write(path, content);
        }
    }

    // Compute folder_structure from AppSettings; passed as --folder-structure CLI
    // arg so we never touch kei's config.toml (which would trigger "Config changed
    // — verifying all files" on every sync due to TOML serialization differences).
    let base = app_settings.folder_structure.as_deref().unwrap_or("%Y/%m");
    let kei_folder_structure = match app_settings.album_folder_structure.as_deref() {
        None | Some("") => {
            if base.is_empty() {
                "{album}".to_string()
            } else {
                format!("{{album}}/{}", base)
            }
        }
        Some(album_pattern) => album_pattern.to_string(),
    };

    // Clear any stale lock file left by a previous hard-quit before launching kei.
    // This avoids the "Session lock held by another instance" error on restart.
    if delete_kei_lock().await {
        emit_log(&app, vec!["── Cleared stale kei lock file ──".to_string()]);
    }

    let all_albums = app_settings.all_albums.unwrap_or(false);

    let cmdline = if all_albums {
        format!("$ {} sync -a all", kei_bin)
    } else {
        format!("$ {} sync", kei_bin)
    };
    emit_log(&app, vec![cmdline]);

    let mut cmd = Command::new(&kei_bin);
    cmd.arg("sync");
    if !kei_folder_structure.is_empty() {
        cmd.args(["--folder-structure", &kei_folder_structure]);
    }
    if all_albums {
        cmd.args(["-a", "all"]);
    }
    if let Some(extra) = &app_settings.extra_args {
        cmd.args(extra.split_whitespace());
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .stdin(Stdio::piped())   // kept open so we can write password/2FA responses
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch kei: {e}"))?;

    let stdin  = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Store child and stdin so stop_sync / submit_password can reach them.
    let child_arc = state.sync_child.clone();
    let stdin_arc = state.sync_stdin.clone();
    *child_arc.lock().await = Some(child);
    *stdin_arc.lock().await = Some(stdin);

    // Spawn task that streams stdout + stderr to the frontend.
    let app_handle = app.clone();
    let child_arc2 = child_arc.clone();
    let stdin_arc2 = stdin_arc.clone();
    tokio::spawn(async move {
        let stdout_reader = BufReader::new(stdout);
        let stderr_reader = BufReader::new(stderr);
        let mut stdout_lines = stdout_reader.lines();
        let mut stderr_lines = stderr_reader.lines();

        // Batch log lines and flush at most every 50 ms to avoid flooding the
        // WebView IPC channel with hundreds of individual events per second.
        let mut log_batch: Vec<String> = Vec::new();
        let mut flush_ticker = tokio::time::interval(
            tokio::time::Duration::from_millis(50)
        );
        flush_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Helper: run per-line side-effect checks and buffer the display string.
        macro_rules! handle_line {
            ($l:expr, $prefix:expr) => {{
                let l: String = $l;
                let ll = l.to_lowercase();
                let is_2fa = ll.contains("waiting for 2fa")
                    || ll.contains("2fa code requested")
                    || ll.contains("2fa_required")
                    || ll.contains("get-code");
                if is_2fa {
                    let _ = app_handle.emit("sync-2fa-required", &l);
                } else if is_password_prompt(&l) {
                    let _ = app_handle.emit("sync-password-required", &l);
                }
                if is_adp_error(&l) {
                    let _ = app_handle.emit("sync-adp-detected", &l);
                }
                if is_session_error(&l) {
                    let _ = clear_kei_session().await;
                    let _ = app_handle.emit("sync-session-reset", ());
                }
                if is_lock_error(&l) {
                    let _ = delete_kei_lock().await;
                    let _ = app_handle.emit("sync-lock-cleared", ());
                }
                // DEBUG / TRACE tracing lines are too noisy to display in the
                // UI — drop them from the batch.  Detection checks above still
                // run on the full original line, so nothing important is lost.
                if l.contains("  DEBUG ") || l.contains("  TRACE ") {
                    // skip
                } else {
                    let raw_display = if $prefix { format!("[err] {l}") } else { l };
                    // Truncate very long lines (e.g. JSON blobs) before sending
                    // over IPC — avoids slow regex and large DOM nodes in the UI.
                    const MAX_LINE_CHARS: usize = 600;
                    let display = if raw_display.chars().count() > MAX_LINE_CHARS {
                        let head: String = raw_display.chars().take(MAX_LINE_CHARS).collect();
                        format!("{head}… [truncated]")
                    } else {
                        raw_display
                    };
                    log_batch.push(display);
                }
                // Flush immediately if the batch is getting large.
                if log_batch.len() >= 200 {
                    let _ = app_handle.emit("sync-output-batch", &log_batch);
                    log_batch.clear();
                }
            }};
        }

        loop {
            tokio::select! {
                line = stdout_lines.next_line() => {
                    match line {
                        Ok(Some(l)) => handle_line!(l, false),
                        Ok(None) => break,
                        Err(e) => {
                            log_batch.push(format!("[stdout error] {e}"));
                            break;
                        }
                    }
                }
                line = stderr_lines.next_line() => {
                    match line {
                        Ok(Some(l)) => handle_line!(l, true),
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
                _ = flush_ticker.tick() => {
                    if !log_batch.is_empty() {
                        let _ = app_handle.emit("sync-output-batch", &log_batch);
                        log_batch.clear();
                    }
                }
            }
        }

        // Flush remaining batch before draining stderr.
        if !log_batch.is_empty() {
            let _ = app_handle.emit("sync-output-batch", &log_batch);
            log_batch.clear();
        }

        // Drain stderr after stdout closes.
        while let Ok(Some(l)) = stderr_lines.next_line().await {
            let ll = l.to_lowercase();
            let is_2fa = ll.contains("waiting for 2fa")
                || ll.contains("2fa code requested")
                || ll.contains("2fa_required")
                || ll.contains("get-code");
            if is_2fa {
                let _ = app_handle.emit("sync-2fa-required", &l);
            }
            if is_adp_error(&l) {
                let _ = app_handle.emit("sync-adp-detected", &l);
            }
            if is_session_error(&l) {
                let _ = clear_kei_session().await;
                let _ = app_handle.emit("sync-session-reset", ());
            }
            if is_lock_error(&l) {
                delete_kei_lock().await;
                let _ = app_handle.emit("sync-lock-cleared", ());
            }
            if !l.contains("  DEBUG ") && !l.contains("  TRACE ") {
                let raw = format!("[err] {l}");
                let display = if raw.chars().count() > 600 {
                    format!("{}… [truncated]", raw.chars().take(600).collect::<String>())
                } else {
                    raw
                };
                log_batch.push(display);
            }
        }
        if !log_batch.is_empty() {
            let _ = app_handle.emit("sync-output-batch", &log_batch);
        }

        // Drop stdin so kei sees EOF if it's still waiting.
        *stdin_arc2.lock().await = None;

        // Wait for the process and clear state.
        let mut guard = child_arc2.lock().await;
        if let Some(mut child) = guard.take() {
            let status = child.wait().await;
            let msg = match status {
                Ok(s) if s.success() => "sync-completed".to_string(),
                Ok(s) => format!("sync-failed:exit code {}", s.code().unwrap_or(-1)),
                Err(e) => format!("sync-failed:{e}"),
            };
            if msg.starts_with("sync-failed") {
                let _ = app_handle.emit("sync-failed", &msg[12..]);
            } else {
                let _ = app_handle.emit("sync-completed", ());
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn stop_sync(state: State<'_, AppState>) -> Result<(), String> {
    // Drop stdin first so kei gets EOF before being killed.
    *state.sync_stdin.lock().await = None;
    let mut guard = state.sync_child.lock().await;
    if let Some(child) = guard.as_mut() {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    *guard = None;
    Ok(())
}

/// Write the user's password to kei's stdin so it can complete authentication.
#[tauri::command]
async fn submit_password(password: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.sync_stdin.lock().await;
    if let Some(stdin) = guard.as_mut() {
        let line = format!("{}\n", password);
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No sync in progress".to_string())
    }
}

/// Trigger kei to push a 2FA code to the user's trusted Apple devices.
/// This runs `kei login get-code` as a separate process and waits for it.
#[tauri::command]
async fn request_2fa_code(app: AppHandle) -> Result<(), String> {
    let kei_bin = resolve_kei_bin().await?;
    emit_log(&app, vec![format!("$ {} login get-code", kei_bin)]);

    let mut cmd = Command::new(&kei_bin);
    cmd.args(["login", "get-code"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run kei login get-code: {e}"))?;

    let mut log_lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    log_lines.extend(
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| format!("[err] {l}")),
    );
    emit_log(&app, log_lines);

    if output.status.success() {
        Ok(())
    } else {
        // Extract only the last non-empty line from stderr/stdout as a short message.
        let combined = [output.stderr.as_slice(), output.stdout.as_slice()].concat();
        let raw = String::from_utf8_lossy(&combined);
        let last_line = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .unwrap_or("unknown error")
            .trim()
            .to_string();
        Err(format!("kei login get-code failed: {last_line}"))
    }
}

/// The 2FA flow in kei is handled by running `kei login submit-code <CODE>`
/// as a separate command — not by writing to the running process's stdin.
#[tauri::command]
async fn submit_2fa(app: AppHandle, code: String) -> Result<(), String> {
    let kei_bin = resolve_kei_bin().await?;
    let trimmed = code.trim().to_string();
    if trimmed.is_empty() {
        return Err("Code is empty".to_string());
    }

    // Log with masked code so credentials don't appear in the output panel.
    emit_log(&app, vec![format!("$ {} login submit-code ******", kei_bin)]);

    let mut cmd = Command::new(&kei_bin);
    cmd.args(["login", "submit-code", &trimmed]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run kei login submit-code: {e}"))?;

    let mut log_lines: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    log_lines.extend(
        String::from_utf8_lossy(&output.stderr)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| format!("[err] {l}")),
    );
    emit_log(&app, log_lines);

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("kei login submit-code failed: {stderr}"))
    }
}

/// Delete kei session/cookie files for the configured user so the next sync
/// starts a fresh login. The .db (download history) is intentionally kept.
#[tauri::command]
async fn clear_kei_session() -> Result<(), String> {
    let config = get_config().await.unwrap_or_default();
    let username = config
        .auth
        .as_ref()
        .and_then(|a| a.username.clone())
        .unwrap_or_default();

    let cookies_dir = kei_config_dir()?.join("cookies");

    // Build the sanitised stem kei uses for its files.
    let stem: String = if username.is_empty() {
        // No username — delete all session/cookie files in the cookies dir.
        String::new()
    } else {
        username
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-')
            .collect()
    };

    // Extensions (and no-extension base file) that hold auth state.
    // The .db file is intentionally excluded — it holds download history.
    let auth_extensions: &[Option<&str>] = &[
        None,              // bare cookies file (no extension)
        Some("session"),
    ];

    if let Ok(rd) = std::fs::read_dir(&cookies_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            let file_stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let ext = p.extension().and_then(|s| s.to_str());

            let stem_matches = stem.is_empty() || file_stem == stem;
            let ext_matches = auth_extensions.contains(&ext);

            if stem_matches && ext_matches {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// App settings (UI-only, separate from kei's config.toml)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AppSettings {
    pub use_system_kei: Option<bool>,
    /// When true, passes `-a all` to `kei sync` rather than storing ["all"] in
    /// kei's TOML (which kei interprets as a literal album name and errors).
    pub all_albums: Option<bool>,
    /// Base folder structure pattern for non-album photos (e.g. "%Y/%m").
    pub folder_structure: Option<String>,
    /// Folder structure pattern for album photos (e.g. "{album}/%Y/%m").
    /// When None, defaults to "{album}" (flat).
    pub album_folder_structure: Option<String>,
    /// Extra flags appended verbatim to `kei sync` (space-separated).
    pub extra_args: Option<String>,
}

fn app_settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".config")
        .join("kei-photosync")
        .join("settings.toml"))
}

#[tauri::command]
async fn get_app_settings() -> Result<AppSettings, String> {
    let path = app_settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    toml::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_app_settings(settings: AppSettings) -> Result<(), String> {
    let path = app_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// kei binary resolution
// ---------------------------------------------------------------------------

/// Returns the bundled kei sidecar path if it exists next to the app executable.
fn find_bundled_kei() -> Option<String> {
    #[cfg(target_os = "windows")]
    let bin_name = "kei.exe";
    #[cfg(not(target_os = "windows"))]
    let bin_name = "kei";

    let exe = std::env::current_exe().ok()?;
    let sidecar = exe.parent()?.join(bin_name);
    if sidecar.exists() {
        Some(sidecar.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Returns a system-installed kei binary using the same PATH resolution as
/// the user's terminal. On macOS/Linux we invoke a login shell so that
/// profile-based PATH additions (Homebrew, Cargo, etc.) are honoured.
fn find_system_kei() -> Option<String> {
    // $KEI_BIN env override — highest priority.
    if let Ok(v) = std::env::var("KEI_BIN") {
        if std::path::Path::new(&v).exists() {
            return Some(v);
        }
    }

    // Resolve via the user's login shell so we get the same PATH as the terminal.
    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("where");
        cmd.arg("kei").creation_flags(0x08000000);
        cmd.output()
    };

    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("/bin/zsh")
        .args(["-l", "-c", "which kei"])
        .output();

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let output = std::process::Command::new("/bin/bash")
        .args(["-l", "-c", "which kei"])
        .output();

    output
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            // `where` on Windows / `which` may return multiple lines; take the first.
            s.lines().next().map(|l| l.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .filter(|s| std::path::Path::new(s.as_str()).exists())
}

/// Resolve which kei binary to use, respecting the use_system_kei setting.
async fn resolve_kei_bin() -> Result<String, String> {
    let settings = get_app_settings().await.unwrap_or_default();
    if settings.use_system_kei.unwrap_or(false) {
        find_system_kei().ok_or_else(|| "System kei not found in PATH or common locations".to_string())
    } else {
        find_bundled_kei()
            .or_else(find_system_kei)
            .ok_or_else(|| "kei binary not found".to_string())
    }
}

// ---------------------------------------------------------------------------
// kei version info
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct KeiVersions {
    pub bundled_path: Option<String>,
    pub bundled_version: Option<String>,
    pub system_path: Option<String>,
    pub system_version: Option<String>,
}

async fn kei_version(path: &str) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let v = s.trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

#[tauri::command]
async fn get_kei_versions() -> KeiVersions {
    let bundled_path = find_bundled_kei();
    let system_path = find_system_kei();

    let bundled_version = if let Some(ref p) = bundled_path {
        kei_version(p).await
    } else {
        None
    };
    let system_version = if let Some(ref p) = system_path {
        kei_version(p).await
    } else {
        None
    };

    KeiVersions { bundled_path, bundled_version, system_path, system_version }
}

#[tauri::command]
async fn check_kei() -> Result<String, String> {
    resolve_kei_bin().await
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sync_child: Arc::new(Mutex::new(None)),
            sync_stdin: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            check_kei,
            open_url,
            get_config,
            save_config,
            get_app_settings,
            save_app_settings,
            get_kei_versions,
            get_status,
            get_history,
            start_sync,
            stop_sync,
            submit_password,
            request_2fa_code,
            submit_2fa,
            clear_kei_session,
            list_kei_albums,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kei PhotoSync");
}
