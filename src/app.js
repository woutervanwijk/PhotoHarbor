import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { parseLine, renderEntry, stripAnsi, dedupKey } from "./log-parsers.js";

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
const toolbarTitle = document.getElementById("toolbar-title");

const VIEW_TITLES = { dashboard: "Dashboard", sync: "Sync", history: "History", settings: "Settings" };

function showView(name) {
  views.forEach((v) => v.classList.remove("active"));
  navItems.forEach((n) => n.classList.remove("active"));
  const target = document.getElementById(`view-${name}`);
  if (target) target.classList.add("active");
  const navItem = document.querySelector(`[data-view="${name}"]`);
  if (navItem) navItem.classList.add("active");
  toolbarTitle.textContent = VIEW_TITLES[name] ?? "";

  if (name === "dashboard") loadDashboard();
  if (name === "history") loadHistory();
  if (name === "settings") loadSettings();
}

navItems.forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
});

document.getElementById("dashboard-sync-btn").addEventListener("click", () => {
  showView("sync");
  // Kick off the sync after navigation so the log is visible immediately.
  doStartSync();
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatTs(unixSecs) {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startSecs, endSecs) {
  if (!startSecs || !endSecs) return "—";
  const secs = endSecs - startSecs;
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function fmtNum(n) {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboard() {
  try {
    const [status, cfg] = await Promise.all([invoke("get_status"), invoke("get_config")]);

    document.getElementById("stat-downloaded").textContent = fmtNum(status.downloaded);
    document.getElementById("stat-pending").textContent = fmtNum(status.pending);
    document.getElementById("stat-failed").textContent = fmtNum(status.failed);
    document.getElementById("stat-total").textContent = fmtNum(status.total_assets);
    document.getElementById("last-started").textContent = formatTs(status.last_run_started);
    document.getElementById("last-completed").textContent = formatTs(status.last_run_completed);
    document.getElementById("last-dl").textContent = fmtNum(status.last_run_downloaded);
    document.getElementById("last-dl-failed").textContent = fmtNum(status.last_run_failed);

    const noConfig = document.getElementById("dashboard-no-config");
    const isConfigured = !!(cfg.auth?.username && cfg.download?.directory);
    noConfig.classList.toggle("hidden", isConfigured);
  } catch (err) {
    console.error("get_status error:", err);
  }
}

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

const syncLog = document.getElementById("sync-log");
const syncLogCompact = document.getElementById("sync-log-compact");
const logExpandBtn = document.getElementById("log-expand-btn");
const startBtn = document.getElementById("sync-start-btn");
const stopBtn = document.getElementById("sync-stop-btn");
const badge = document.getElementById("sync-status-badge");
const progressWrap = document.getElementById("progress-bar-wrap");

let logExpanded = false;

function setLogExpanded(expanded) {
  logExpanded = expanded;
  syncLog.classList.toggle("hidden", !expanded);
  logExpandBtn.classList.toggle("expanded", expanded);
  if (expanded) syncLog.scrollTop = syncLog.scrollHeight;
}

logExpandBtn.addEventListener("click", () => setLogExpanded(!logExpanded));

// ---------------------------------------------------------------------------
// Global log panel
// ---------------------------------------------------------------------------

const logPanel = document.getElementById("log-panel");
const globalLog = document.getElementById("global-log");
const logToggleBtn = document.getElementById("log-toggle-btn");
const logBadge = document.getElementById("log-badge");
let logPanelOpen = false;
let logUnread = false;

function setLogPanelOpen(open) {
  logPanelOpen = open;
  logPanel.classList.toggle("open", open);
  logToggleBtn.classList.toggle("active", open);
  if (open) {
    logUnread = false;
    logBadge.classList.remove("visible");
    globalLog.scrollTop = globalLog.scrollHeight;
  }
}

logToggleBtn.addEventListener("click", () => setLogPanelOpen(!logPanelOpen));
document.getElementById("log-panel-close-btn").addEventListener("click", () => setLogPanelOpen(false));
document.getElementById("global-log-clear-btn").addEventListener("click", () => {
  globalLog.textContent = "";
});

// Drag-to-resize handle
const resizeHandle = document.getElementById("log-panel-resize");
resizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = logPanel.getBoundingClientRect().height;

  function onMove(ev) {
    const newH = Math.max(80, Math.min(600, startH - (ev.clientY - startY)));
    logPanel.style.setProperty("--log-panel-height", `${newH}px`);
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

const MAX_GLOBAL_LOG_LINES = 2000;

function appendGlobalLog(raw) {
  const clean = stripAnsi(raw)
    .replace(/^\[err\]\s*/, "")
    .replace(/^\[out\]\s*/, "");
  const line = document.createElement("div");
  line.className = "raw-log-line";
  line.textContent = clean;
  globalLog.appendChild(line);
  // Trim old lines to keep the DOM small.
  while (globalLog.childElementCount > MAX_GLOBAL_LOG_LINES) {
    globalLog.firstElementChild.remove();
  }
  if (logPanelOpen) {
    globalLog.scrollTop = globalLog.scrollHeight;
  } else {
    logUnread = true;
    logBadge.classList.add("visible");
  }
}

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

let syncRunning = false;

// ---------------------------------------------------------------------------
// Batched log rendering — incoming lines are queued and flushed at most once
// per animation frame so rapid kei output cannot block the UI thread.
// ---------------------------------------------------------------------------

const MAX_SYNC_LOG_ENTRIES = 2000;

// Dedup state for the sync log — reset each time a new sync starts.
let _lastSyncEl = null;
let _lastSyncKey = null;
let _lastSyncCount = 1;
let _lastParsed = null;

// Queue of raw strings waiting to be rendered.
const _logQueue = [];
let _logFlushPending = false;

function resetSyncDedup() {
  _lastSyncEl = null;
  _lastSyncKey = null;
  _lastSyncCount = 1;
  _lastParsed = null;
}

function _flushLogQueue() {
  _logFlushPending = false;
  if (_logQueue.length === 0) return;

  const fragment = document.createDocumentFragment();
  let didAppend = false;

  for (const raw of _logQueue) {
    const parsed = parseLine(raw);
    const key = dedupKey(parsed);
    _lastParsed = parsed;

    if (key && key === _lastSyncKey && _lastSyncEl) {
      _lastSyncCount++;
      const countEl = _lastSyncEl.querySelector(".log-count");
      if (countEl) {
        countEl.textContent = `×${_lastSyncCount}`;
        countEl.classList.remove("hidden");
      }
      const timeEl = _lastSyncEl.querySelector("[data-role='time']");
      if (timeEl && parsed.time) timeEl.textContent = parsed.time;
    } else {
      const entryEl = renderEntry(parsed);
      fragment.appendChild(entryEl);
      _lastSyncEl = entryEl;
      _lastSyncKey = key;
      _lastSyncCount = 1;
      didAppend = true;
    }
  }
  _logQueue.length = 0;

  if (didAppend) {
    syncLog.appendChild(fragment);
    // Trim old entries to keep the DOM small.
    while (syncLog.childElementCount > MAX_SYNC_LOG_ENTRIES) {
      syncLog.firstElementChild.remove();
    }
    syncLog.scrollTop = syncLog.scrollHeight;
  }

  // Update compact view to the latest line.
  if (_lastParsed) {
    syncLogCompact.replaceChildren(renderEntry(_lastParsed));
  }
}

function appendLog(raw) {
  _logQueue.push(raw);
  if (!_logFlushPending) {
    _logFlushPending = true;
    requestAnimationFrame(_flushLogQueue);
  }
}

function setSyncRunning(running) {
  syncRunning = running;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  badge.textContent = running ? "Running" : "Idle";
  badge.className = `badge ${running ? "running" : ""}`;
  progressWrap.classList.toggle("hidden", !running);
}

// Register Tauri event listeners once.
// Lines arrive as batches (Vec<String>) to reduce IPC overhead.
listen("sync-output-batch", (event) => {
  for (const line of event.payload) {
    console.log("[kei]", line);
    _logQueue.push(line);
    appendGlobalLog(line);
  }
  if (!_logFlushPending) {
    _logFlushPending = true;
    requestAnimationFrame(_flushLogQueue);
  }
});
listen("sync-2fa-required", () => show2FAModal());
listen("sync-completed", () => {
  setSyncRunning(false);
  appendLog("── Sync completed ──", "success");
  appendGlobalLog("── Sync completed ──");
});
listen("sync-failed", (event) => {
  setSyncRunning(false);
  appendLog(`── Sync failed: ${event.payload} ──`, "err");
  appendGlobalLog(`── Sync failed: ${event.payload} ──`);
  badge.classList.add("error");
  if (_retryAfterLockClear) {
    _retryAfterLockClear = false;
    setTimeout(() => doStartSync(), 500);
  }
});

async function doStartSync() {
  if (syncRunning) return;

  // Pre-flight: ensure required settings are configured.
  try {
    const cfg = await invoke("get_config");
    const missing = [];
    if (!cfg.auth?.username)       missing.push("iCloud Username");
    if (!cfg.download?.directory)  missing.push("Download Directory");
    if (missing.length > 0) {
      const detail = `Please set: ${missing.join(", ")}.`;
      document.getElementById("settings-required-detail").textContent = " " + detail;
      document.getElementById("settings-required-notice").classList.remove("hidden");
      showView("settings");
      return;
    }
  } catch {
    // If we can't read config, let kei surface the error itself.
  }

  document.getElementById("adp-warning").classList.add("hidden");
  hide2FAModal();
  setSyncRunning(true);
  syncLog.textContent = "";
  syncLogCompact.innerHTML = '<span class="log-compact-placeholder">—</span>';
  resetSyncDedup();
  try {
    await invoke("start_sync");
  } catch (err) {
    setSyncRunning(false);
    appendLog(`Failed to start sync: ${err}`);
  }
}

startBtn.addEventListener("click", () => doStartSync());

stopBtn.addEventListener("click", async () => {
  try {
    await invoke("stop_sync");
    appendLog("── Sync stopped by user ──", "warn");
    setSyncRunning(false);
  } catch (err) {
    appendLog(`Stop error: ${err}`, "err");
  }
});

document.getElementById("adp-dismiss-btn").addEventListener("click", () => {
  document.getElementById("adp-warning").classList.add("hidden");
});

listen("sync-adp-detected", () => {
  document.getElementById("adp-warning").classList.remove("hidden");
});

listen("sync-session-reset", () => {
  appendLog("── Session error detected — login state cleared, next sync will re-authenticate ──");
  appendGlobalLog("── Session error detected — login state cleared ──");
});

let _retryAfterLockClear = false;
listen("sync-lock-cleared", () => {
  _retryAfterLockClear = true;
  appendLog("── Stale lock detected — cleared, retrying sync… ──");
  appendGlobalLog("── Stale lock cleared, retrying sync… ──");
});

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------

async function loadHistory() {
  const tbody = document.getElementById("history-tbody");
  tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Loading…</td></tr>';

  try {
    const runs = await invoke("get_history");
    if (!runs || runs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No sync history yet.</td></tr>';
      return;
    }

    tbody.innerHTML = runs
      .map((r) => {
        let statusCell;
        if (r.interrupted) {
          statusCell = `<span class="run-interrupted">Interrupted</span>`;
        } else if (!r.completed_at) {
          statusCell = `<span class="run-interrupted">Running?</span>`;
        } else if (r.assets_failed > 0) {
          statusCell = `<span class="run-error">Partial</span>`;
        } else {
          statusCell = `<span class="run-ok">Complete</span>`;
        }

        return `<tr>
          <td>${r.id}</td>
          <td>${formatTs(r.started_at)}</td>
          <td>${formatDuration(r.started_at, r.completed_at)}</td>
          <td>${fmtNum(r.assets_seen)}</td>
          <td>${fmtNum(r.assets_downloaded)}</td>
          <td>${r.assets_failed > 0 ? `<span style="color:var(--destructive)">${fmtNum(r.assets_failed)}</span>` : fmtNum(r.assets_failed)}</td>
          <td>${statusCell}</td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Error loading history: ${err}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const cfg = await invoke("get_config");

    document.getElementById("cfg-username").value = cfg.auth?.username ?? "";
    document.getElementById("cfg-domain").value = cfg.auth?.domain ?? "com";
    document.getElementById("cfg-directory").value = cfg.download?.directory ?? "";
    document.getElementById("cfg-threads").value = cfg.download?.threads_num ?? "";
    document.getElementById("cfg-folder-structure").value = cfg.download?.folder_structure ?? "";
    document.getElementById("cfg-exif").checked = cfg.download?.set_exif_datetime ?? false;
    document.getElementById("cfg-skip-videos").checked = cfg.filters?.skip_videos ?? false;
    document.getElementById("cfg-skip-photos").checked = cfg.filters?.skip_photos ?? false;
    const albums = cfg.filters?.albums ?? [];
    const albumsAll = albums.length === 1 && albums[0].toLowerCase() === "all";
    document.getElementById("cfg-albums-all").checked = albumsAll;
    document.getElementById("cfg-albums").value = albumsAll ? "" : albums.join(", ");
    document.getElementById("cfg-albums-row").classList.toggle("hidden", albumsAll);
    document.getElementById("cfg-exclude-albums").value = (cfg.filters?.exclude_albums ?? []).join(", ");
    document.getElementById("cfg-recent").value = cfg.filters?.recent ?? "";
    document.getElementById("cfg-watch-interval").value = cfg.watch?.interval ?? "";
    document.getElementById("cfg-log-level").value = cfg.log_level ?? "";
  } catch (err) {
    console.error("get_config error:", err);
  }
}

function parseAlbums(val) {
  const list = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

document.getElementById("cfg-albums-all").addEventListener("change", (e) => {
  document.getElementById("cfg-albums-row").classList.toggle("hidden", e.target.checked);
});

document.getElementById("cfg-directory-pick").addEventListener("click", async () => {
  const dir = await openDialog({ directory: true, multiple: false, title: "Select Download Directory" });
  if (dir) document.getElementById("cfg-directory").value = dir;
});

document.getElementById("auth-wiki-btn").addEventListener("click", () => {
  invoke("open_url", { url: "https://github.com/rhoopr/kei/wiki/Authentication" });
});

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("cfg-username").value.trim();
  const domain = document.getElementById("cfg-domain").value;
  const directory = document.getElementById("cfg-directory").value.trim();
  const threads = parseInt(document.getElementById("cfg-threads").value, 10);
  const folderStructure = document.getElementById("cfg-folder-structure").value.trim();
  const setExif = document.getElementById("cfg-exif").checked;
  const skipVideos = document.getElementById("cfg-skip-videos").checked;
  const skipPhotos = document.getElementById("cfg-skip-photos").checked;
  const albumsAll = document.getElementById("cfg-albums-all").checked;
  const albums = albumsAll ? ["all"] : parseAlbums(document.getElementById("cfg-albums").value);
  const excludeAlbums = parseAlbums(document.getElementById("cfg-exclude-albums").value);
  const recent = parseInt(document.getElementById("cfg-recent").value, 10);
  const watchInterval = parseInt(document.getElementById("cfg-watch-interval").value, 10);
  const logLevel = document.getElementById("cfg-log-level").value || null;

  const config = {
    log_level: logLevel,
    auth: {
      username: username || null,
      domain: domain !== "com" ? domain : null,
    },
    download: {
      directory: directory || null,
      threads_num: isNaN(threads) ? null : threads,
      folder_structure: folderStructure || null,
      set_exif_datetime: setExif || null,
    },
    filters: {
      skip_videos: skipVideos || null,
      skip_photos: skipPhotos || null,
      albums: albums,
      exclude_albums: excludeAlbums,
      recent: isNaN(recent) || recent <= 0 ? null : recent,
    },
    watch: {
      interval: isNaN(watchInterval) ? null : watchInterval,
    },
  };

  try {
    await invoke("save_config", { config });
    document.getElementById("settings-required-notice").classList.add("hidden");
    const msg = document.getElementById("settings-saved-msg");
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2500);
  } catch (err) {
    alert(`Failed to save settings:\n${err}`);
  }
});

// ---------------------------------------------------------------------------
// Password Modal
// ---------------------------------------------------------------------------

const passwordOverlay = document.getElementById("modal-password-overlay");
const passwordInput = document.getElementById("password-input");

function showPasswordModal() {
  passwordInput.value = "";
  passwordOverlay.classList.remove("hidden");
  setTimeout(() => passwordInput.focus(), 100);
}

function hidePasswordModal() {
  passwordOverlay.classList.add("hidden");
}

document.getElementById("password-cancel-btn").addEventListener("click", () => {
  hidePasswordModal();
  appendLog("── Password entry cancelled ──");
  setSyncRunning(false);
});

document.getElementById("password-submit-btn").addEventListener("click", async () => {
  const password = passwordInput.value;
  if (!password) return;
  hidePasswordModal();
  try {
    await invoke("submit_password", { password });
  } catch (err) {
    appendLog(`Failed to submit password: ${err}`, "err");
    appendGlobalLog(`Failed to submit password: ${err}`);
  }
});

passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("password-submit-btn").click();
});

listen("sync-password-required", () => showPasswordModal());

// ---------------------------------------------------------------------------
// 2FA Modal
// ---------------------------------------------------------------------------

const modalOverlay = document.getElementById("modal-overlay");
const twofaInput = document.getElementById("twofa-input");

function hide2FAModal() {
  modalOverlay.classList.add("hidden");
}

async function cancelAndStopSync() {
  hide2FAModal();
  appendLog("── 2FA entry cancelled, stopping sync ──");
  setSyncRunning(false);
  try { await invoke("stop_sync"); } catch {}
  try { await invoke("clear_kei_session"); } catch {}
}

function show2FAModal() {
  twofaInput.value = "";
  modalOverlay.classList.remove("hidden");
  setTimeout(() => twofaInput.focus(), 100);
}

document.getElementById("twofa-dismiss-btn").addEventListener("click", cancelAndStopSync);

document.getElementById("twofa-submit-btn").addEventListener("click", async () => {
  const code = twofaInput.value.trim();
  if (!code) return;
  hide2FAModal();
  try {
    await invoke("submit_2fa", { code });
    appendLog("2FA code submitted successfully.", "success");
    appendGlobalLog("2FA code submitted successfully.");
  } catch (err) {
    appendLog(`2FA submission failed: ${err}`, "err");
    appendGlobalLog(`2FA submission failed: ${err}`);
  }
});

// Submit on Enter in the 2FA input.
twofaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("twofa-submit-btn").click();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Check that the kei binary is available before showing the normal UI.
(async () => {
  try {
    await invoke("check_kei");
  } catch {
    document.getElementById("kei-missing-overlay").classList.remove("hidden");
  }
})();

document.getElementById("copy-install-cmd").addEventListener("click", () => {
  const text = document.getElementById("install-cmd-text").textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copy-install-cmd");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

toolbarTitle.textContent = VIEW_TITLES["dashboard"];
loadDashboard();
