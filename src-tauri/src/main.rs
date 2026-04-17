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
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(|p| std::path::PathBuf::from(p).join("kei"))
            .map_err(|_| "APPDATA not set".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .map(|p| std::path::PathBuf::from(p).join(".config/kei"))
            .map_err(|_| "HOME not set".to_string())
    }
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
async fn save_config(config: KeiConfig) -> Result<(), String> {
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
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
            .unwrap_or(0);
        let downloaded: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'downloaded'", [], |r| r.get(0))
            .unwrap_or(0);
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'pending'", [], |r| r.get(0))
            .unwrap_or(0);
        let failed: i64 = conn
            .query_row("SELECT COUNT(*) FROM assets WHERE status = 'failed'", [], |r| r.get(0))
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
    let kei_bin = which_kei()?;

    let mut child = Command::new(&kei_bin)
        .arg("sync")
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

        loop {
            tokio::select! {
                line = stdout_lines.next_line() => {
                    match line {
                        Ok(Some(l)) => {
                            let is_2fa = l.contains("2FA code requested")
                                || l.contains("2fa_required")
                                || l.contains("submit-code");
                            if is_2fa {
                                let _ = app_handle.emit("sync-2fa-required", &l);
                            } else if is_password_prompt(&l) {
                                let _ = app_handle.emit("sync-password-required", &l);
                            }
                            let _ = app_handle.emit("sync-output", &l);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = app_handle.emit("sync-output", format!("[stdout error] {e}"));
                            break;
                        }
                    }
                }
                line = stderr_lines.next_line() => {
                    match line {
                        Ok(Some(l)) => {
                            if is_password_prompt(&l) {
                                let _ = app_handle.emit("sync-password-required", &l);
                            }
                            let _ = app_handle.emit("sync-output", format!("[err] {l}"));
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
            }
        }

        // Drain stderr after stdout closes.
        while let Ok(Some(l)) = stderr_lines.next_line().await {
            let _ = app_handle.emit("sync-output", format!("[err] {l}"));
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

/// The 2FA flow in kei is handled by running `kei login submit-code <CODE>`
/// as a separate command — not by writing to the running process's stdin.
#[tauri::command]
async fn submit_2fa(code: String) -> Result<(), String> {
    let kei_bin = which_kei()?;
    let trimmed = code.trim().to_string();
    if trimmed.is_empty() {
        return Err("Code is empty".to_string());
    }

    let output = Command::new(&kei_bin)
        .args(["login", "submit-code", &trimmed])
        .output()
        .await
        .map_err(|e| format!("Failed to run kei login submit-code: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("kei login submit-code failed: {stderr}"))
    }
}

/// Resolve the kei binary path.
/// Resolution order:
///   1. Bundled sidecar (next to the app executable — always present in a
///      packaged build)
///   2. $KEI_BIN env override (useful during development)
///   3. Common cargo / Homebrew / system install locations
///   4. PATH via `which` (Unix) / `where` (Windows)
fn which_kei() -> Result<String, String> {
    // The binary is named "kei" on Unix and "kei.exe" on Windows.
    #[cfg(target_os = "windows")]
    let bin_name = "kei.exe";
    #[cfg(not(target_os = "windows"))]
    let bin_name = "kei";

    // 1. Bundled sidecar — Tauri places externalBin entries alongside the
    //    main executable in both packaged apps and `tauri dev` mode.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(bin_name);
            if sidecar.exists() {
                return Ok(sidecar.to_string_lossy().to_string());
            }
        }
    }

    // 2. $KEI_BIN env override
    if let Ok(v) = std::env::var("KEI_BIN") {
        if std::path::Path::new(&v).exists() {
            return Ok(v);
        }
    }

    // 3. Common install locations
    // HOME on Unix; USERPROFILE on Windows (cargo installs there)
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let candidates: &[String] = &[
        format!("{home}\\.cargo\\bin\\kei.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates: &[String] = &[
        format!("{home}/.cargo/bin/kei"),
        "/usr/local/bin/kei".to_string(),
        "/opt/homebrew/bin/kei".to_string(),
        "/usr/bin/kei".to_string(),
    ];
    for c in candidates {
        if std::path::Path::new(c.as_str()).exists() {
            return Ok(c.clone());
        }
    }

    // 4. PATH lookup: `which` on Unix, `where` on Windows
    #[cfg(target_os = "windows")]
    let lookup_cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let lookup_cmd = "which";

    let out = std::process::Command::new(lookup_cmd)
        .arg("kei")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            // `where` on Windows may return multiple lines; take the first.
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().map(|l| l.trim().to_string())
        });

    out.filter(|s| !s.is_empty())
        .ok_or_else(|| "kei binary not found".to_string())
}

#[tauri::command]
async fn check_kei() -> Result<String, String> {
    which_kei()
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
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            sync_child: Arc::new(Mutex::new(None)),
            sync_stdin: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            check_kei,
            open_url,
            get_config,
            save_config,
            get_status,
            get_history,
            start_sync,
            stop_sync,
            submit_password,
            submit_2fa,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kei PhotoSync");
}
