import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

document.getElementById("dashboard-sync-btn").addEventListener("click", () =>
  showView("sync")
);

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
    const status = await invoke("get_status");
    document.getElementById("stat-downloaded").textContent = fmtNum(status.downloaded);
    document.getElementById("stat-pending").textContent = fmtNum(status.pending);
    document.getElementById("stat-failed").textContent = fmtNum(status.failed);
    document.getElementById("stat-total").textContent = fmtNum(status.total_assets);
    document.getElementById("last-started").textContent = formatTs(status.last_run_started);
    document.getElementById("last-completed").textContent = formatTs(status.last_run_completed);
    document.getElementById("last-dl").textContent = fmtNum(status.last_run_downloaded);
    document.getElementById("last-dl-failed").textContent = fmtNum(status.last_run_failed);

    const noConfig = document.getElementById("dashboard-no-config");
    const hasData = status.total_assets > 0 || status.last_run_started;
    noConfig.classList.toggle("hidden", hasData);
  } catch (err) {
    console.error("get_status error:", err);
  }
}

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

const syncLog = document.getElementById("sync-log");
const startBtn = document.getElementById("sync-start-btn");
const stopBtn = document.getElementById("sync-stop-btn");
const badge = document.getElementById("sync-status-badge");
const progressWrap = document.getElementById("progress-bar-wrap");

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

function appendGlobalLog(text, cls = "") {
  const line = document.createElement("span");
  const lower = text.toLowerCase();
  if (!cls) {
    if (lower.includes("error") || lower.includes("[err]")) cls = "err";
    else if (lower.includes("warn")) cls = "warn";
    else if (lower.includes("downloaded") || lower.includes("complete")) cls = "success";
  }
  line.className = `log-line ${cls}`;
  line.textContent = text;
  globalLog.appendChild(line);
  globalLog.appendChild(document.createTextNode("\n"));
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

function appendLog(text, cls = "") {
  const line = document.createElement("span");
  line.className = `log-line ${cls}`;
  // Colour-code by content
  if (!cls) {
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("[err]")) cls = "err";
    else if (lower.includes("warn")) cls = "warn";
    else if (lower.includes("downloaded") || lower.includes("complete")) cls = "success";
    line.className = `log-line ${cls}`;
  }
  line.textContent = text;
  syncLog.appendChild(line);
  syncLog.appendChild(document.createTextNode("\n"));
  syncLog.scrollTop = syncLog.scrollHeight;
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
listen("sync-output", (event) => {
  appendLog(event.payload);
  appendGlobalLog(event.payload);
});
listen("sync-2fa-required", () => show2FAModal());
listen("sync-completed", () => {
  setSyncRunning(false);
  appendLog("── Sync completed ──", "success");
  appendGlobalLog("── Sync completed ──", "success");
});
listen("sync-failed", (event) => {
  setSyncRunning(false);
  appendLog(`── Sync failed: ${event.payload} ──`, "err");
  appendGlobalLog(`── Sync failed: ${event.payload} ──`, "err");
  badge.classList.add("error");
});

startBtn.addEventListener("click", async () => {
  setSyncRunning(true);
  syncLog.textContent = "";
  try {
    await invoke("start_sync");
  } catch (err) {
    setSyncRunning(false);
    appendLog(`Failed to start sync: ${err}`, "err");
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await invoke("stop_sync");
    appendLog("── Sync stopped by user ──", "warn");
    setSyncRunning(false);
  } catch (err) {
    appendLog(`Stop error: ${err}`, "err");
  }
});

document.getElementById("clear-log-btn").addEventListener("click", () => {
  syncLog.textContent = "";
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
    document.getElementById("cfg-albums").value = (cfg.filters?.albums ?? []).join(", ");
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
  const albums = parseAlbums(document.getElementById("cfg-albums").value);
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
    const msg = document.getElementById("settings-saved-msg");
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2500);
  } catch (err) {
    alert(`Failed to save settings:\n${err}`);
  }
});

// ---------------------------------------------------------------------------
// 2FA Modal
// ---------------------------------------------------------------------------

const modalOverlay = document.getElementById("modal-overlay");
const twofaInput = document.getElementById("twofa-input");

function show2FAModal() {
  twofaInput.value = "";
  modalOverlay.classList.remove("hidden");
  setTimeout(() => twofaInput.focus(), 100);
}

function hide2FAModal() {
  modalOverlay.classList.add("hidden");
}

document.getElementById("twofa-cancel-btn").addEventListener("click", hide2FAModal);

document.getElementById("twofa-submit-btn").addEventListener("click", async () => {
  const code = twofaInput.value.trim();
  if (!code) return;
  hide2FAModal();
  try {
    await invoke("submit_2fa", { code });
    appendLog(`2FA code submitted.`, "success");
  } catch (err) {
    appendLog(`2FA submission failed: ${err}`, "err");
  }
});

// Submit on Enter in the 2FA input.
twofaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("twofa-submit-btn").click();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

toolbarTitle.textContent = VIEW_TITLES["dashboard"];
loadDashboard();
