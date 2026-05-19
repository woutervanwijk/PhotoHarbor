// Prevents a console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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
    pub folder_structure_albums: Option<String>,
    pub folder_structure_smart_folders: Option<String>,
    pub set_exif_datetime: Option<bool>,
    pub retry: Option<DownloadRetryConfig>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct DownloadRetryConfig {
    pub max_download_attempts: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct FiltersConfig {
    pub skip_videos: Option<bool>,
    pub skip_photos: Option<bool>,
    pub libraries: Option<Vec<String>>,
    pub albums: Option<Vec<String>>,
    pub exclude_albums: Option<Vec<String>>,
    pub smart_folders: Option<Vec<String>>,
    pub unfiled: Option<bool>,
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
    pub last_run_seen: Option<i64>,
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

#[derive(Debug, Default, Clone)]
struct FriendlySyncStats {
    started_at: i64,
    downloaded: Option<i64>,
    failed: Option<i64>,
    skipped: Option<i64>,
    library_items: Option<i64>,
    duration_secs: Option<i64>,
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

fn write_text_if_changed(path: &std::path::Path, content: &str) -> Result<(), String> {
    if path.exists() {
        if let Ok(existing) = std::fs::read_to_string(path) {
            if existing == content {
                return Ok(());
            }
        }
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
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

fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn parse_count(raw: &str) -> Option<i64> {
    raw.replace(',', "").parse::<i64>().ok()
}

fn parse_duration_secs(raw: &str) -> Option<i64> {
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }

    let mut total = 0i64;
    let mut saw_unit = false;
    let parts = lower.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        let number: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if number.is_empty() {
            continue;
        }
        let value = number.parse::<i64>().ok()?;
        let inline_unit = part[number.len()..].trim();
        let unit = if inline_unit.is_empty() {
            parts.get(index + 1).copied().unwrap_or_default()
        } else {
            inline_unit
        };
        if unit.starts_with('h') || part.contains("hour") {
            total += value * 3600;
            saw_unit = true;
        } else if unit.starts_with('m') || part.contains("minute") {
            total += value * 60;
            saw_unit = true;
        } else if unit.starts_with('s') || part.contains("second") {
            total += value;
            saw_unit = true;
        }
    }

    if saw_unit {
        Some(total)
    } else {
        lower.parse::<i64>().ok()
    }
}

fn strip_ansi_codes(raw: &str) -> String {
    let mut clean = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for ch in chars.by_ref() {
                if ch.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            clean.push(c);
        }
    }
    clean
}

fn first_count_after<'a>(line: &'a str, label: &str) -> Option<i64> {
    let idx = line.find(label)?;
    let rest = line[idx + label.len()..].trim_start();
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ',')
        .collect();
    parse_count(&digits)
}

impl FriendlySyncStats {
    fn new(started_at: i64) -> Self {
        Self {
            started_at,
            ..Default::default()
        }
    }

    fn observe_line(&mut self, raw: &str) {
        let clean = strip_ansi_codes(raw);
        let line = clean.replace('✓', " ");
        let lower = line.to_lowercase();

        if let Some(count) = first_count_after(&lower, "downloaded ") {
            if lower.contains("new file") {
                self.downloaded = Some(count);
            }
        }

        if let Some(done_idx) = lower.find("done.") {
            let rest = &lower[done_idx + "done.".len()..];
            if let Some(count) = first_count_after(rest, "") {
                if rest.contains("new file") {
                    self.downloaded = Some(count);
                }
            }
            if let Some(in_idx) = rest.find(" in ") {
                let duration = rest[in_idx + 4..].trim_end_matches('.').trim();
                if let Some(seconds) = parse_duration_secs(duration) {
                    self.duration_secs = Some(seconds);
                }
            }
        }

        if self.downloaded.is_none() {
            if let Some(count) = first_count_after(&lower, "new ") {
                if lower.contains(" new") {
                    self.downloaded = Some(count);
                }
            }
        }

        if let Some(count) = first_count_after(&lower, "skipped ") {
            self.skipped = Some(count);
        }
        if let Some(count) = first_count_after(&lower, "failed ") {
            self.failed = Some(count);
        }
        if let Some(count) = first_count_after(&lower, "library ") {
            if lower.contains("items") {
                self.library_items = Some(count);
            }
        }
        if let Some(seconds) = lower
            .find("time ")
            .and_then(|idx| parse_duration_secs(&lower[idx + 5..]))
        {
            self.duration_secs = Some(seconds);
        }
    }

    fn has_values(&self) -> bool {
        self.downloaded.is_some()
            || self.failed.is_some()
            || self.skipped.is_some()
            || self.library_items.is_some()
            || self.duration_secs.is_some()
    }
}

async fn persist_friendly_sync_stats(stats: FriendlySyncStats, success: bool) {
    if !stats.has_values() {
        return;
    }

    let config = get_config().await.unwrap_or_default();
    let username = config
        .auth
        .as_ref()
        .and_then(|auth| auth.username.clone())
        .unwrap_or_default();
    if username.is_empty() {
        return;
    }
    let Ok(db) = db_path(&username) else {
        return;
    };

    let _ = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db).ok()?;
        let completed_at = unix_now_secs();
        let started_at = stats
            .duration_secs
            .map(|duration| completed_at.saturating_sub(duration))
            .unwrap_or(stats.started_at);
        let downloaded = stats.downloaded.unwrap_or_default();
        let failed = stats.failed.unwrap_or_default();
        let seen = stats
            .library_items
            .or_else(|| stats.skipped.map(|skipped| skipped + downloaded + failed))
            .unwrap_or(downloaded + failed);
        let interrupted = if success { 0i64 } else { 1i64 };

        let latest: Option<(i64, i64, Option<i64>)> = conn
            .query_row(
                "SELECT id, started_at, completed_at FROM sync_runs ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        if let Some((id, latest_started, latest_completed)) = latest {
            if latest_completed.is_none() || latest_started >= stats.started_at.saturating_sub(30) {
                let _ = conn.execute(
                    "UPDATE sync_runs
                     SET completed_at = ?1,
                         assets_seen = ?2,
                         assets_downloaded = ?3,
                         assets_failed = ?4,
                         interrupted = ?5
                     WHERE id = ?6",
                    rusqlite::params![completed_at, seen, downloaded, failed, interrupted, id],
                );
                return Some(());
            }
        }

        let _ = conn.execute(
            "INSERT INTO sync_runs
             (started_at, completed_at, assets_seen, assets_downloaded, assets_failed, interrupted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                started_at,
                completed_at,
                seen,
                downloaded,
                failed,
                interrupted
            ],
        );
        Some(())
    })
    .await;
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
    normalize_v013_filters(&mut config);
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(&config).map_err(|e| e.to_string())?;
    write_text_if_changed(&path, &content)
}

fn normalize_v013_filters(config: &mut KeiConfig) {
    let Some(filters) = config.filters.as_mut() else {
        return;
    };

    let mut albums = filters.albums.take().unwrap_or_default();
    albums.retain(|album| !album.eq_ignore_ascii_case("all"));

    if let Some(exclude_albums) = filters.exclude_albums.take() {
        albums.extend(
            exclude_albums
                .into_iter()
                .filter(|album| !album.is_empty())
                .map(|album| {
                    if album.starts_with('!') {
                        album
                    } else {
                        format!("!{album}")
                    }
                }),
        );
    }

    filters.albums = if albums.is_empty() {
        None
    } else {
        Some(albums)
    };
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
            last_run_seen: None,
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
                last_run_seen: None,
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
        let last_run: Option<(i64, Option<i64>, i64, i64, i64)> = conn
            .query_row(
                "SELECT started_at, completed_at, assets_seen, assets_downloaded, assets_failed
                 FROM sync_runs ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();

        Ok(SyncStatus {
            total_assets,
            downloaded,
            pending,
            failed,
            last_run_seen: last_run.as_ref().map(|r| r.2),
            last_run_started: last_run.as_ref().map(|r| r.0),
            last_run_completed: last_run.as_ref().and_then(|r| r.1),
            last_run_downloaded: last_run.as_ref().map(|r| r.3),
            last_run_failed: last_run.as_ref().map(|r| r.4),
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

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clear_history_and_stats(state: State<'_, AppState>) -> Result<(), String> {
    if state.sync_child.lock().await.is_some() {
        return Err("Cannot clear history while a sync is running".to_string());
    }

    let config = get_config().await.unwrap_or_default();
    let username = config
        .auth
        .as_ref()
        .and_then(|a| a.username.clone())
        .unwrap_or_default();

    if username.is_empty() {
        return Ok(());
    }

    let db = match db_path(&username) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };

    let mut paths = vec![db.clone()];
    paths.push(db.with_extension("db-wal"));
    paths.push(db.with_extension("db-shm"));

    for path in paths {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
        }
    }

    Ok(())
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

const FALLBACK_SMART_FOLDERS: [&str; 10] = [
    "Bursts",
    "Favorites",
    "Hidden",
    "Live",
    "Panoramas",
    "Recently Deleted",
    "Screenshots",
    "Slo-mo",
    "Time-lapse",
    "Videos",
];

fn fallback_smart_folders() -> Vec<String> {
    FALLBACK_SMART_FOLDERS
        .iter()
        .map(|folder| folder.to_string())
        .collect()
}

fn smart_folders_from_kei_output(output: &str) -> Option<Vec<String>> {
    let available = output.split("Available:").nth(1)?.trim();
    let start = available.find('[')?;
    let end = available[start..].find(']')? + start + 1;
    let json = &available[start..end];
    let folders: Vec<String> = serde_json::from_str(json).ok()?;
    if folders.is_empty() {
        None
    } else {
        Some(folders)
    }
}

/// Return Apple's smart folder names as understood by kei.
///
/// kei does not currently expose `kei list smart-folders`, so we try to read
/// the list from kei's own validation error and fall back to the same known
/// Apple smart folders if the installed kei version cannot produce it.
#[tauri::command]
async fn list_kei_smart_folders() -> Result<Vec<String>, String> {
    let Ok(kei_bin) = resolve_kei_bin().await else {
        return Ok(fallback_smart_folders());
    };

    let config_path = std::env::temp_dir().join(format!(
        "photoharbor-smart-folders-{}-{}.toml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    let config = r#"[auth]
username = "probe@example.com"

[download]
directory = "/tmp"

[filters]
smart_folders = ["__photoharbor_probe__"]
"#;

    if std::fs::write(&config_path, config).is_err() {
        return Ok(fallback_smart_folders());
    }

    let mut cmd = Command::new(&kei_bin);
    cmd.args(["config", "--config"]);
    cmd.arg(&config_path);
    cmd.arg("show");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let output = cmd.output().await;
    let _ = std::fs::remove_file(&config_path);

    if let Ok(output) = output {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if let Some(folders) = smart_folders_from_kei_output(&combined) {
            return Ok(folders);
        }
    }

    Ok(fallback_smart_folders())
}

/// Delete any .lock files in the kei cookies directory.
/// Returns true if at least one lock file was removed.
async fn delete_kei_lock() -> bool {
    let Ok(base) = kei_config_dir() else {
        return false;
    };
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
        || (lower.contains("421")
            && lower.contains("misdirected")
            && lower.contains("service error"))
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
                    if ch.is_ascii_alphabetic() {
                        break;
                    }
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
            let retained = f
                .albums
                .take()
                .unwrap_or_default()
                .into_iter()
                .filter(|a| !a.eq_ignore_ascii_case("all"))
                .collect::<Vec<_>>();
            f.albums = if retained.is_empty() {
                None
            } else {
                Some(retained)
            };
        }
        if let (Ok(path), Ok(content)) = (config_path(), toml::to_string_pretty(&clean)) {
            let _ = write_text_if_changed(&path, &content);
        }
    }

    // Compute folder templates from AppSettings / config; passed as CLI
    // arg so we never touch kei's config.toml (which would trigger "Config changed
    // — verifying all files" on every sync due to TOML serialization differences).
    let config_download = kei_cfg.download.as_ref();
    let kei_folder_structure = app_settings.folder_structure.as_deref();
    let kei_folder_structure = config_download
        .and_then(|d| d.folder_structure.as_deref())
        .or(kei_folder_structure)
        .unwrap_or("%Y/%m");
    let kei_album_folder_structure_fallback = app_settings.album_folder_structure.as_deref();
    let kei_album_folder_structure = config_download
        .and_then(|d| d.folder_structure_albums.as_deref())
        .or(kei_album_folder_structure_fallback)
        .unwrap_or("{album}");
    let kei_smart_folder_structure_fallback = app_settings.smart_folder_structure.as_deref();
    let kei_smart_folder_structure = config_download
        .and_then(|d| d.folder_structure_smart_folders.as_deref())
        .or(kei_smart_folder_structure_fallback)
        .unwrap_or("{smart-folder}");

    // Clear any stale lock file left by a previous hard-quit before launching kei.
    // This avoids the "Session lock held by another instance" error on restart.
    if delete_kei_lock().await {
        emit_log(&app, vec!["── Cleared stale kei lock file ──".to_string()]);
    }

    emit_log(&app, vec![format!("$ {} sync", kei_bin)]);

    let mut cmd = Command::new(&kei_bin);
    cmd.arg("sync");
    if !kei_folder_structure.is_empty() {
        cmd.args(["--folder-structure", &kei_folder_structure]);
    }
    if !kei_album_folder_structure.is_empty() {
        cmd.args(["--folder-structure-albums", &kei_album_folder_structure]);
    }
    if !kei_smart_folder_structure.is_empty() {
        cmd.args([
            "--folder-structure-smart-folders",
            &kei_smart_folder_structure,
        ]);
    }
    if let Some(extra) = &app_settings.extra_args {
        cmd.args(extra.split_whitespace());
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .stdin(Stdio::piped()) // kept open so we can write password/2FA responses
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch kei: {e}"))?;

    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let sync_started_at = unix_now_secs();

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
        let mut friendly_stats = FriendlySyncStats::new(sync_started_at);
        let mut flush_ticker = tokio::time::interval(tokio::time::Duration::from_millis(50));
        flush_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Helper: run per-line side-effect checks and buffer the display string.
        macro_rules! handle_line {
            ($l:expr, $prefix:expr) => {{
                let l: String = $l;
                friendly_stats.observe_line(&l);
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
            friendly_stats.observe_line(&l);
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
            persist_friendly_sync_stats(friendly_stats, !msg.starts_with("sync-failed")).await;
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
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
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
    emit_log(
        &app,
        vec![format!("$ {} login submit-code ******", kei_bin)],
    );

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
        None, // bare cookies file (no extension)
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
// Recent downloads — walks the download dir and returns the 100 newest media files
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RecentAsset {
    pub path: String,
    pub is_video: bool,
    pub is_live_photo: bool,
    pub live_video_path: Option<String>,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BrowseFolderEntry {
    pub name: String,
    pub path: String,
    pub folder_count: usize,
    pub media_count: usize,
}

#[derive(Debug, Serialize)]
pub struct BrowsePhotosResult {
    pub root_path: String,
    pub current_path: String,
    pub parent_path: Option<String>,
    pub folders: Vec<BrowseFolderEntry>,
    pub assets: Vec<RecentAsset>,
}

#[derive(Debug, Clone)]
struct MediaFile {
    ts: std::time::SystemTime,
    path: std::path::PathBuf,
    is_video: bool,
    len: u64,
}

fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        format!("{}{}", home, &path[1..])
    } else {
        path.to_string()
    }
}

fn media_file_from_path(path: std::path::PathBuf, meta: std::fs::Metadata) -> Option<MediaFile> {
    if !meta.is_file() {
        return None;
    }

    // ctime (inode-change time) is the right key: the OS refreshes it
    // whenever utimes() is called, so it reflects the actual download
    // time even when kei backdates mtime/birthtime to the EXIF date.
    // Windows has no meaningful ctime, so fall back to created()/modified().
    #[cfg(unix)]
    let ts_opt: Option<std::time::SystemTime> = {
        use std::os::unix::fs::MetadataExt;
        let secs = meta.ctime();
        if secs >= 0 {
            Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64))
        } else {
            None
        }
    };
    #[cfg(not(unix))]
    let ts_opt: Option<std::time::SystemTime> = meta.created().or_else(|_| meta.modified()).ok();

    let ts = ts_opt?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_video = matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "avi" | "mkv" | "wmv");
    let is_image = matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "gif" | "webp" | "tiff" | "tif" | "bmp"
    );
    if is_video || is_image {
        Some(MediaFile {
            ts,
            path,
            is_video,
            len: meta.len(),
        })
    } else {
        None
    }
}

fn collect_media_files(root: &std::path::Path) -> Vec<MediaFile> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                dirs.push(path);
            } else if let Some(file) = media_file_from_path(path, meta) {
                files.push(file);
            }
        }
    }
    files
}

fn collect_direct_media_files(root: &std::path::Path) -> Vec<MediaFile> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    rd.flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            media_file_from_path(path, meta)
        })
        .collect()
}

fn count_direct_children(root: &std::path::Path) -> (usize, usize) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    let mut folders = 0usize;
    let mut media = 0usize;
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            folders += 1;
        } else if media_file_from_path(path, meta).is_some() {
            media += 1;
        }
    }
    (folders, media)
}

fn live_photo_pair_key(path: &std::path::Path, is_video: bool) -> Option<String> {
    let parent = path.parent()?.to_string_lossy();
    let stem = path.file_stem()?.to_string_lossy();
    let stem_lower = stem.to_lowercase();
    let base = if is_video {
        stem_lower.strip_suffix("_hevc")?.to_string()
    } else {
        stem_lower
    };
    Some(format!("{parent}\0{base}"))
}

fn collapse_live_photos(files: Vec<MediaFile>) -> Vec<(MediaFile, Option<MediaFile>)> {
    let mut live_videos = std::collections::HashMap::<String, MediaFile>::new();
    let mut image_keys = std::collections::HashSet::<String>::new();
    for file in files.iter().filter(|file| !file.is_video) {
        if let Some(key) = live_photo_pair_key(&file.path, false) {
            image_keys.insert(key);
        }
    }

    for file in files.iter().filter(|file| file.is_video) {
        if let Some(key) = live_photo_pair_key(&file.path, true) {
            live_videos
                .entry(key)
                .and_modify(|existing| {
                    if file.ts > existing.ts {
                        *existing = file.clone();
                    }
                })
                .or_insert_with(|| file.clone());
        }
    }

    let mut consumed_live_videos = std::collections::HashSet::<String>::new();
    let mut collapsed = Vec::new();
    for file in files {
        if file.is_video {
            if let Some(key) = live_photo_pair_key(&file.path, true) {
                if consumed_live_videos.contains(&key) || image_keys.contains(&key) {
                    continue;
                }
            }
            collapsed.push((file, None));
            continue;
        }

        if let Some(key) = live_photo_pair_key(&file.path, false) {
            if let Some(video) = live_videos.get(&key).cloned() {
                consumed_live_videos.insert(key);
                collapsed.push((file, Some(video)));
                continue;
            }
        }

        collapsed.push((file, None));
    }
    collapsed
}

fn cached_thumbnail_path(
    source: &std::path::Path,
    is_video: bool,
    ts: std::time::SystemTime,
    len: u64,
) -> Option<std::path::PathBuf> {
    let cache_dir = thumbnail_cache_dir()?;
    let key = stable_thumb_key(source, ts, len);
    let target = cache_dir.join(if is_video {
        format!("{key}.png")
    } else {
        format!("{key}.jpg")
    });
    target.exists().then_some(target)
}

fn recent_asset_from_pair(
    file: MediaFile,
    live_video: Option<MediaFile>,
    create_thumbnail: bool,
) -> RecentAsset {
    let thumbnail_path = if create_thumbnail {
        cached_thumbnail_for(&file.path, file.is_video, file.ts, file.len)
    } else {
        cached_thumbnail_path(&file.path, file.is_video, file.ts, file.len)
    }
    .map(|path| path.to_string_lossy().to_string());
    RecentAsset {
        path: file.path.to_string_lossy().to_string(),
        is_video: file.is_video,
        is_live_photo: live_video.is_some(),
        live_video_path: live_video.map(|video| video.path.to_string_lossy().to_string()),
        thumbnail_path,
    }
}

fn stable_thumb_key(path: &std::path::Path, ts: std::time::SystemTime, len: u64) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let secs = ts
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    for byte in secs.to_le_bytes().iter().chain(len.to_le_bytes().iter()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn thumbnail_cache_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    #[cfg(target_os = "macos")]
    {
        Some(
            std::path::PathBuf::from(home)
                .join("Library")
                .join("Caches")
                .join("PhotoHarbor")
                .join("thumbnails"),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(
            std::path::PathBuf::from(home)
                .join(".cache")
                .join("photoharbor")
                .join("thumbnails"),
        )
    }
}

#[cfg(target_os = "macos")]
fn create_image_thumbnail(source: &std::path::Path, target: &std::path::Path) -> bool {
    std::process::Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("jpeg")
        .arg("-Z")
        .arg("240")
        .arg(source)
        .arg("--out")
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success() && target.exists())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn create_video_thumbnail(source: &std::path::Path, target: &std::path::Path) -> bool {
    let Some(parent) = target.parent() else {
        return false;
    };
    let Some(stem) = target.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    let temp_dir = parent.join(format!("{stem}.tmp"));
    let _ = std::fs::remove_dir_all(&temp_dir);
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return false;
    }
    let status_ok = std::process::Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg("240")
        .arg("-o")
        .arg(&temp_dir)
        .arg(source)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !status_ok {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return false;
    }

    let generated = std::fs::read_dir(&temp_dir).ok().and_then(|entries| {
        entries
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.is_file())
    });
    let success = generated
        .as_deref()
        .map(|path| {
            std::fs::rename(path, target)
                .or_else(|_| std::fs::copy(path, target).map(|_| ()))
                .is_ok()
                && target.exists()
        })
        .unwrap_or(false);
    let _ = std::fs::remove_dir_all(&temp_dir);
    success
}

fn cached_thumbnail_for(
    source: &std::path::Path,
    is_video: bool,
    ts: std::time::SystemTime,
    len: u64,
) -> Option<std::path::PathBuf> {
    let cache_dir = thumbnail_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).ok()?;
    let key = stable_thumb_key(source, ts, len);
    let target = cache_dir.join(if is_video {
        format!("{key}.png")
    } else {
        format!("{key}.jpg")
    });
    if target.exists() {
        return Some(target);
    }

    #[cfg(target_os = "macos")]
    let created = if is_video {
        create_video_thumbnail(source, &target)
    } else {
        create_image_thumbnail(source, &target)
    };
    #[cfg(not(target_os = "macos"))]
    let created = false;

    if created {
        Some(target)
    } else {
        None
    }
}

#[tauri::command]
async fn get_recent_downloads(directory: String, newer_than: Option<u64>) -> Vec<RecentAsset> {
    let dir = std::path::PathBuf::from(expand_tilde(&directory));

    tokio::task::spawn_blocking(move || {
        if !dir.exists() {
            return vec![];
        }
        let mut files = collect_media_files(&dir);
        if let Some(cutoff) = newer_than {
            files.retain(|file| {
                file.ts
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_secs() > cutoff)
                    .unwrap_or(false)
            });
        }
        let mut collapsed = collapse_live_photos(files);
        collapsed.sort_by(|a, b| {
            let a_ts =
                a.1.as_ref()
                    .map(|video| video.ts)
                    .unwrap_or(a.0.ts)
                    .max(a.0.ts);
            let b_ts =
                b.1.as_ref()
                    .map(|video| video.ts)
                    .unwrap_or(b.0.ts)
                    .max(b.0.ts);
            b_ts.cmp(&a_ts)
        });
        collapsed.truncate(100);
        collapsed
            .into_iter()
            .map(|(file, live_video)| recent_asset_from_pair(file, live_video, true))
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn browse_photos(
    directory: String,
    folder: Option<String>,
) -> Result<BrowsePhotosResult, String> {
    let root = std::path::PathBuf::from(expand_tilde(&directory));
    let current = folder
        .as_deref()
        .map(expand_tilde)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.clone());

    tokio::task::spawn_blocking(move || {
        let root = root
            .canonicalize()
            .map_err(|e| format!("Could not open download directory: {e}"))?;
        let current = current
            .canonicalize()
            .map_err(|e| format!("Could not open folder: {e}"))?;
        if !current.starts_with(&root) {
            return Err("Folder is outside the download directory".to_string());
        }
        if !current.is_dir() {
            return Err("Selected path is not a folder".to_string());
        }

        let mut folders = Vec::new();
        let rd = std::fs::read_dir(&current).map_err(|e| e.to_string())?;
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let (folder_count, media_count) = count_direct_children(&path);
            folders.push(BrowseFolderEntry {
                name,
                path: path.to_string_lossy().to_string(),
                folder_count,
                media_count,
            });
        }
        folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        let mut collapsed = collapse_live_photos(collect_direct_media_files(&current));
        collapsed.sort_by(|a, b| {
            let a_name =
                a.0.path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase();
            let b_name =
                b.0.path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase();
            a_name.cmp(&b_name)
        });
        let assets = collapsed
            .into_iter()
            .map(|(file, live_video)| recent_asset_from_pair(file, live_video, false))
            .collect();
        let parent_path = current.parent().and_then(|parent| {
            if current == root || !parent.starts_with(&root) {
                None
            } else {
                Some(parent.to_string_lossy().to_string())
            }
        });

        Ok(BrowsePhotosResult {
            root_path: root.to_string_lossy().to_string(),
            current_path: current.to_string_lossy().to_string(),
            parent_path,
            folders,
            assets,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    /// Folder structure pattern for smart-folder photos (e.g. "{smart-folder}/%Y/%m").
    /// When None, defaults to "{smart-folder}" (flat).
    pub smart_folder_structure: Option<String>,
    /// Extra flags appended verbatim to `kei sync` (space-separated).
    pub extra_args: Option<String>,
}

fn app_settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".config")
        .join("photoharbor")
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
    write_text_if_changed(&path, &content)
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
        find_system_kei()
            .ok_or_else(|| "System kei not found in PATH or common locations".to_string())
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
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
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

    KeiVersions {
        bundled_path,
        bundled_version,
        system_path,
        system_version,
    }
}

#[tauri::command]
async fn check_kei() -> Result<String, String> {
    resolve_kei_bin().await
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&expanded)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&expanded)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&expanded)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_containing_folder(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    let path = std::path::PathBuf::from(expanded);
    let folder = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(|parent| parent.to_path_buf())
            .ok_or_else(|| "No containing folder found".to_string())?
    };
    open_folder(folder.to_string_lossy().to_string()).await
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
            clear_history_and_stats,
            start_sync,
            stop_sync,
            submit_password,
            request_2fa_code,
            submit_2fa,
            clear_kei_session,
            list_kei_albums,
            list_kei_smart_folders,
            get_recent_downloads,
            browse_photos,
            open_folder,
            open_containing_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PhotoHarbor");
}
