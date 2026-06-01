import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseLine, renderEntry, stripAnsi, dedupKey } from "./log-parsers.js";

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
const toolbarTitle = document.getElementById("toolbar-title");
let _activeView = "sync";

// Window dragging — use startDragging() on mousedown in drag zones.
// CSS -webkit-app-region and data-tauri-drag-region are unreliable in Tauri v2.
const appWindow = getCurrentWindow();
const DRAG_TARGETS = ["toolbar", "toolbar-title", "sidebar-drag-region"];
document.addEventListener("mousedown", (e) => {
  if (DRAG_TARGETS.includes(e.target.id)) {
    appWindow.startDragging();
  }
});

const VIEW_TITLES = { sync: "Sync", browse: "Browse", history: "History", settings: "Settings" };

function showView(name) {
  _activeView = name;
  views.forEach((v) => v.classList.remove("active"));
  navItems.forEach((n) => n.classList.remove("active"));
  const target = document.getElementById(`view-${name}`);
  if (target) target.classList.add("active");
  const navItem = document.querySelector(`[data-view="${name}"]`);
  if (navItem) navItem.classList.add("active");
  toolbarTitle.textContent = VIEW_TITLES[name] ?? "";

  if (name === "sync") { loadDashboard(); loadRecentThumbnails(); }
  if (name === "browse") loadBrowse();
  if (name === "history") loadHistory();
  if (name === "settings") loadSettings();
}

navItems.forEach((item) => {
  item.addEventListener("click", () => showView(item.dataset.view));
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
    hour12: false,
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function formatMediaDate(unixSecs) {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function containingFolder(path) {
  if (!path) return "";
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function cleanKeiLine(raw) {
  return stripAnsi(String(raw))
    .replace(/^\[err\]\s*/, "")
    .replace(/^\[out\]\s*/, "")
    .trim();
}

function getKeiErrorWarning(raw) {
  const clean = cleanKeiLine(raw);
  const match = clean.match(/^Error:\s*(.+)$/is);
  if (!match) return null;
  return {
    title: "kei Error",
    body: match[1].trim() || clean,
    key: clean,
  };
}

function getUnknownSmartFolderWarning(raw) {
  const clean = stripAnsi(String(raw))
    .replace(/^\[err\]\s*/, "")
    .replace(/^\[out\]\s*/, "")
    .trim();
  const match = clean.match(/(?:Error:\s*)?(?:"([^"]+)"|'([^']+)'|(.+?))\s+is not an Apple smart folder\b/i);
  if (!match) return null;
  const folder = (match[1] ?? match[2] ?? match[3]).trim();
  const availableMatch = clean.match(/\bAvailable:\s*(.+)$/i);
  const available = availableMatch?.[1]?.trim();
  return {
    title: "Unknown Apple Smart Folder",
    body: available
      ? `'${folder}' is not an Apple smart folder.\n\nAvailable smart folders: ${available}`
      : `'${folder}' is not an Apple smart folder.`,
    key: clean,
  };
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
// Recent thumbnails + lightbox
// ---------------------------------------------------------------------------

const _thumbsEl = document.getElementById("recent-thumbnails");
const _thumbsListEl = document.getElementById("thumbnails-list");
let _thumbPollInterval = null;
let _shownThumbPaths = new Set();
let _shownThumbSignature = "";
let _thumbDirectory = null;
let _thumbLoadGeneration = 0;
let _videoThumbObserver = null;

function recentClearStorageKey(directory) {
  return `photoharbor:recent-cleared-before:${directory}`;
}

function getRecentClearCutoff(directory) {
  const value = localStorage.getItem(recentClearStorageKey(directory));
  const cutoff = value ? Number.parseInt(value, 10) : null;
  return Number.isFinite(cutoff) ? cutoff : null;
}

function disconnectVideoThumbObserver() {
  if (!_videoThumbObserver) return;
  _videoThumbObserver.disconnect();
  _videoThumbObserver = null;
}

function getVideoThumbObserver() {
  if (!("IntersectionObserver" in window) || !_thumbsListEl) return null;
  if (!_videoThumbObserver) {
    _videoThumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target._loadVideoThumb?.();
        _videoThumbObserver?.unobserve(entry.target);
      }
    }, {
      root: _thumbsListEl,
      rootMargin: "160px",
    });
  }
  return _videoThumbObserver;
}

document.getElementById("open-folder-btn").addEventListener("click", () => {
  if (_thumbDirectory) invoke("open_folder", { path: _thumbDirectory }).catch(() => {});
});

// Lightbox
const _lightboxOverlay = document.getElementById("lightbox-overlay");
const _lightboxImg = document.getElementById("lightbox-img");
const _lightboxVideo = document.getElementById("lightbox-video");
const _lightboxLiveBadge = document.getElementById("lightbox-live-badge");
const _lightboxMetadata = document.getElementById("lightbox-metadata");
const _lightboxMedia = document.querySelector(".lightbox-media");
let _lightboxAssets = [];
let _lightboxIndex = -1;

function renderLightboxMetadata(asset) {
  if (!_lightboxMetadata || !asset) return;
  const dimensions = asset.dimensions || "—";
  const sizeBytes = (asset.sizeBytes || 0) + (asset.liveVideoSizeBytes || 0);
  const rows = [
    ["Date", formatMediaDate(asset.capturedAt || asset.downloadedAt)],
    ["Type", asset.kind],
    ["Dimensions", dimensions],
    ["Size", formatBytes(sizeBytes)],
    ["Downloaded", formatMediaDate(asset.downloadedAt)],
    ["Folder", containingFolder(asset.path)],
  ].filter(([, value]) => value && value !== "—");

  _lightboxMetadata.replaceChildren();
  const title = document.createElement("div");
  title.className = "lightbox-metadata-title";
  title.textContent = asset.fileName || "Untitled";
  _lightboxMetadata.appendChild(title);

  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "lightbox-metadata-row";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    _lightboxMetadata.appendChild(row);
  }
}

function setLightboxDimensions(asset, width, height) {
  if (!asset || !width || !height) return;
  const next = `${Math.round(width)} × ${Math.round(height)}`;
  if (asset.dimensions === next) return;
  asset.dimensions = next;
  if (_lightboxAssets[_lightboxIndex] === asset) renderLightboxMetadata(asset);
}

function showLightboxAsset(asset) {
  _lightboxMedia.classList.remove("lightbox-media--live", "lightbox-media--previewing");
  _lightboxVideo.pause();
  _lightboxVideo.removeAttribute("src");
  _lightboxVideo.controls = true;
  _lightboxVideo.muted = false;
  _lightboxVideo.loop = false;
  _lightboxLiveBadge.classList.add("hidden");
  renderLightboxMetadata(asset);

  if (asset.isVideo) {
    _lightboxImg.classList.add("hidden");
    _lightboxImg.removeAttribute("src");
    _lightboxVideo.src = asset.src;
    _lightboxVideo.classList.remove("hidden");
    _lightboxVideo.play().catch(() => {});
  } else if (asset.isLivePhoto && asset.liveVideoSrc) {
    _lightboxMedia.classList.add("lightbox-media--live");
    _lightboxLiveBadge.classList.remove("hidden");
    _lightboxImg.src = asset.src;
    _lightboxImg.classList.remove("hidden");
    _lightboxVideo.src = asset.liveVideoSrc;
    _lightboxVideo.controls = false;
    _lightboxVideo.muted = true;
    _lightboxVideo.loop = false;
    _lightboxVideo.classList.remove("hidden");
  } else {
    _lightboxVideo.classList.add("hidden");
    _lightboxImg.src = asset.src;
    _lightboxImg.classList.remove("hidden");
  }
}

function openLightbox(index) {
  if (index < 0 || index >= _lightboxAssets.length) return;
  _lightboxIndex = index;
  showLightboxAsset(_lightboxAssets[_lightboxIndex]);
  _lightboxOverlay.classList.remove("hidden");
}

function closeLightbox() {
  _lightboxOverlay.classList.add("hidden");
  _lightboxIndex = -1;
  _lightboxVideo.pause();
  _lightboxVideo.removeAttribute("src");
  _lightboxImg.removeAttribute("src");
  _lightboxMedia.classList.remove("lightbox-media--live", "lightbox-media--previewing");
  _lightboxLiveBadge.classList.add("hidden");
  _lightboxMetadata?.replaceChildren();
}

function playLightboxLivePhoto() {
  const asset = _lightboxAssets[_lightboxIndex];
  if (!asset?.isLivePhoto || !asset.liveVideoSrc) return;
  _lightboxVideo.play().catch(() => {});
}

function pauseLightboxLivePhoto() {
  const asset = _lightboxAssets[_lightboxIndex];
  if (!asset?.isLivePhoto) return;
  _lightboxVideo.pause();
  _lightboxMedia.classList.remove("lightbox-media--previewing");
  if (_lightboxVideo.readyState > 0) {
    try { _lightboxVideo.currentTime = 0; } catch {}
  }
}

function clearRecentThumbnails(persistCutoff = false, directoryOverride = null) {
  _thumbLoadGeneration++;
  const directory = directoryOverride || _thumbDirectory;
  if (persistCutoff && directory) {
    localStorage.setItem(
      recentClearStorageKey(directory),
      String(Math.floor(Date.now() / 1000)),
    );
  }
  closeLightbox();
  disconnectVideoThumbObserver();
  _thumbsListEl.innerHTML = "";
  _thumbsEl.classList.add("hidden");
  _shownThumbPaths = new Set();
  _shownThumbSignature = "";
  _lightboxAssets = [];
}

function navigateLightbox(delta) {
  if (_lightboxOverlay.classList.contains("hidden") || _lightboxAssets.length < 2) return;
  _lightboxIndex = (_lightboxIndex + delta + _lightboxAssets.length) % _lightboxAssets.length;
  showLightboxAsset(_lightboxAssets[_lightboxIndex]);
}

document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
document.getElementById("lightbox-open-folder").addEventListener("click", (e) => {
  e.stopPropagation();
  const asset = _lightboxAssets[_lightboxIndex];
  if (asset?.path) invoke("open_containing_folder", { path: asset.path }).catch(() => {});
});
_lightboxOverlay.addEventListener("click", (e) => { if (e.target === _lightboxOverlay) closeLightbox(); });
_lightboxMedia.addEventListener("pointerenter", playLightboxLivePhoto);
_lightboxMedia.addEventListener("pointermove", playLightboxLivePhoto);
_lightboxMedia.addEventListener("pointerleave", pauseLightboxLivePhoto);
_lightboxImg.addEventListener("load", () => {
  setLightboxDimensions(_lightboxAssets[_lightboxIndex], _lightboxImg.naturalWidth, _lightboxImg.naturalHeight);
});
_lightboxVideo.addEventListener("loadedmetadata", () => {
  const asset = _lightboxAssets[_lightboxIndex];
  if (asset?.isVideo || !asset?.dimensions) {
    setLightboxDimensions(asset, _lightboxVideo.videoWidth, _lightboxVideo.videoHeight);
  }
});
_lightboxVideo.addEventListener("playing", () => {
  const asset = _lightboxAssets[_lightboxIndex];
  if (asset?.isLivePhoto) _lightboxMedia.classList.add("lightbox-media--previewing");
});
document.addEventListener("keydown", (e) => {
  if (_lightboxOverlay.classList.contains("hidden")) return;
  if (e.key === "Escape") {
    closeLightbox();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    navigateLightbox(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    navigateLightbox(1);
  }
});

function toLightboxAssets(assets) {
  return assets.map((asset) => ({
    path: asset.path,
    fileName: asset.file_name || asset.path?.split(/[\\/]/).pop() || "",
    src: convertFileSrc(asset.path),
    isVideo: asset.is_video,
    isLivePhoto: asset.is_live_photo,
    liveVideoSrc: asset.live_video_path ? convertFileSrc(asset.live_video_path) : null,
    sizeBytes: asset.size_bytes ?? 0,
    liveVideoSizeBytes: asset.live_video_size_bytes ?? 0,
    capturedAt: asset.captured_at ?? null,
    downloadedAt: asset.downloaded_at ?? null,
    dimensions: null,
    kind: asset.is_live_photo ? "Live Photo" : (asset.is_video ? "Video" : "Photo"),
  }));
}

function mediaAssetSignature(assets) {
  return assets.map((asset) => `${asset.path}\0${asset.live_video_path ?? ""}\0${asset.thumbnail_path ?? ""}`).join("\n");
}

function renderMediaThumbnails(container, assets, options = {}) {
  const {
    previousPaths = new Set(),
    animateNew = false,
    videoObserver = null,
    primeVisible = false,
  } = options;
  container.innerHTML = "";
  _lightboxAssets = toLightboxAssets(assets);

  for (const [index, asset] of assets.entries()) {
    const isNew = animateNew && !previousPaths.has(asset.path);
    const item = document.createElement("div");
    item.className = "thumb-item" + (isNew ? " thumb-item--new" : "");
    item.tabIndex = 0;
    item.role = "button";
    const lightboxAsset = _lightboxAssets[index];
    const src = lightboxAsset.src;
    const thumbSrc = asset.thumbnail_path ? convertFileSrc(asset.thumbnail_path) : src;

    if (asset.is_video) {
      item.classList.add("thumb-item--video");
      item.setAttribute("aria-label", "Open video preview");
      if (asset.thumbnail_path) {
        const posterImg = document.createElement("img");
        posterImg.className = "thumb-video-poster";
        posterImg.src = thumbSrc;
        posterImg.alt = "";
        posterImg.decoding = "async";
        posterImg.onerror = () => posterImg.remove();
        item.appendChild(posterImg);
      }
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      if (asset.thumbnail_path) video.poster = thumbSrc;
      video.onerror = () => item.remove();
      let videoLoaded = false;
      let previewTime = 0;
      let previewActive = false;
      const loadVideoThumb = () => {
        if (videoLoaded) return;
        videoLoaded = true;
        video.src = src;
        video.load();
      };
      if (!asset.thumbnail_path) item._loadVideoThumb = loadVideoThumb;
      video.addEventListener("loadedmetadata", () => {
        previewTime = Math.min(1, (video.duration || 10) * 0.1);
        try {
          video.currentTime = previewTime;
        } catch {
          // Some codecs do not allow early seeking before enough data is available.
        }
      }, { once: true });
      video.addEventListener("seeked", () => {
        if (!previewActive) {
          video.play().then(() => {
            if (!previewActive) video.pause();
          }).catch(() => {});
        }
      }, { once: true });
      video.addEventListener("playing", () => {
        item.classList.add("thumb-item--previewing");
      });
      const playPreview = () => {
        previewActive = true;
        loadVideoThumb();
        video.play().catch(() => {});
      };
      const pausePreview = () => {
        previewActive = false;
        video.pause();
        item.classList.remove("thumb-item--previewing");
        if (Number.isFinite(video.duration) && video.readyState > 0) {
          video.currentTime = previewTime;
        }
      };
      item.addEventListener("pointerenter", playPreview);
      item.addEventListener("pointermove", playPreview);
      item.addEventListener("pointerleave", pausePreview);
      item.addEventListener("focus", playPreview);
      item.addEventListener("blur", pausePreview);
      item.appendChild(video);
      const badge = document.createElement("div");
      badge.className = "thumb-video-badge";
      item.appendChild(badge);
      if (videoObserver && !asset.thumbnail_path) videoObserver.observe(item);
    } else if (asset.is_live_photo) {
      item.classList.add("thumb-item--live");
      item.setAttribute("aria-label", "Open Live Photo preview");
      const img = document.createElement("img");
      img.src = thumbSrc;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => item.remove();
      item.appendChild(img);

      if (asset.live_video_path) {
        const liveVideoSrc = convertFileSrc(asset.live_video_path);
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.onerror = () => video.remove();
        let videoLoaded = false;
        const loadLiveVideo = () => {
          if (videoLoaded) return;
          videoLoaded = true;
          video.src = liveVideoSrc;
          video.load();
        };
        const playPreview = () => {
          loadLiveVideo();
          video.play().catch(() => {});
        };
        const pausePreview = () => {
          video.pause();
          item.classList.remove("thumb-item--previewing");
          if (video.readyState > 0) {
            try { video.currentTime = 0; } catch {}
          }
        };
        video.addEventListener("playing", () => {
          item.classList.add("thumb-item--previewing");
        });
        item.addEventListener("pointerenter", playPreview);
        item.addEventListener("pointermove", playPreview);
        item.addEventListener("pointerleave", pausePreview);
        item.addEventListener("focus", playPreview);
        item.addEventListener("blur", pausePreview);
        item.appendChild(video);
      }

      const badge = document.createElement("div");
      badge.className = "thumb-live-badge";
      item.appendChild(badge);
    } else {
      const img = document.createElement("img");
      img.src = thumbSrc;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => item.remove();
      item.appendChild(img);
    }

    item.addEventListener("click", () => openLightbox(index));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLightbox(index);
      }
    });
    container.appendChild(item);
  }

  if (primeVisible) {
    requestAnimationFrame(() => {
      const visibleColumns = Math.ceil((container.clientWidth || 560) / 120);
      const visibleItems = Math.max(8, visibleColumns * 2);
      for (const item of Array.from(container.children).slice(0, visibleItems)) {
        item._loadVideoThumb?.();
      }
    });
  }
}


async function loadRecentThumbnails() {
  if (_activeView !== "sync") return;
  const generation = _thumbLoadGeneration;
  try {
    const cfg = await invoke("get_config");
    const directory = cfg.download?.directory;
    if (!directory) { _thumbsEl.classList.add("hidden"); return; }

    _thumbDirectory = directory;
    const assets = await invoke("get_recent_downloads", {
      directory,
      newerThan: getRecentClearCutoff(directory),
    });
    if (generation !== _thumbLoadGeneration) return;
    if (!assets || assets.length === 0) { _thumbsEl.classList.add("hidden"); return; }

    const newPaths = new Set(assets.map((a) => a.path));
    const newSignature = mediaAssetSignature(assets);
    if (newSignature === _shownThumbSignature && !_thumbsEl.classList.contains("hidden")) {
      _lightboxAssets = toLightboxAssets(assets);
      return;
    }

    disconnectVideoThumbObserver();
    const currentLightboxPath = _lightboxIndex >= 0 ? _lightboxAssets[_lightboxIndex]?.path : null;
    renderMediaThumbnails(_thumbsListEl, assets, {
      previousPaths: _shownThumbPaths,
      animateNew: true,
      videoObserver: getVideoThumbObserver(),
      primeVisible: true,
    });
    if (currentLightboxPath) {
      _lightboxIndex = _lightboxAssets.findIndex((asset) => asset.path === currentLightboxPath);
      if (_lightboxIndex === -1) closeLightbox();
    }

    _shownThumbPaths = newPaths;
    _shownThumbSignature = newSignature;
    _thumbsEl.classList.remove("hidden");
  } catch {
    _thumbsEl.classList.add("hidden");
  }
}

function _startThumbPolling() {
  if (_thumbPollInterval) return;
  _thumbPollInterval = setInterval(loadRecentThumbnails, 10000);
}

function _stopThumbPolling() {
  if (_thumbPollInterval) { clearInterval(_thumbPollInterval); _thumbPollInterval = null; }
}

// ---------------------------------------------------------------------------
// Browse view
// ---------------------------------------------------------------------------

const browseNoConfig = document.getElementById("browse-no-config");
const browseLayout = document.getElementById("browse-layout");
const browseCurrentPathEl = document.getElementById("browse-current-path");
const browseFolderListEl = document.getElementById("browse-folder-list");
const browseThumbsEl = document.getElementById("browse-thumbnails-list");
const browseMediaLabel = document.getElementById("browse-media-label");
const browseOpenFolderBtn = document.getElementById("browse-open-folder-btn");
let _browseCurrentPath = null;
let _browseLoadGeneration = 0;

function browseFolderMeta(folder) {
  const parts = [];
  if (folder.folder_count) parts.push(`${folder.folder_count} folder${folder.folder_count === 1 ? "" : "s"}`);
  if (folder.media_count) parts.push(`${folder.media_count} item${folder.media_count === 1 ? "" : "s"}`);
  return parts.join(" · ") || "Empty";
}

function pathBaseName(path) {
  return String(path || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || path || "Photos";
}

function joinPath(base, segment) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${segment}`;
}

function createBrowseCrumb(label, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browse-crumb";
  button.title = path;

  const icon = document.createElement("span");
  icon.className = "folder-icon browse-crumb-icon";
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);

  const text = document.createElement("span");
  text.className = "browse-crumb-text";
  text.textContent = label;
  button.appendChild(text);

  button.addEventListener("click", () => loadBrowse(path));
  return button;
}

function renderBrowseBreadcrumb(rootPath, currentPath) {
  browseCurrentPathEl.innerHTML = "";
  browseCurrentPathEl.title = currentPath || "";
  if (!rootPath || !currentPath) {
    browseCurrentPathEl.textContent = "—";
    return;
  }

  browseCurrentPathEl.appendChild(createBrowseCrumb(pathBaseName(rootPath), rootPath));

  const relativePath = currentPath.startsWith(rootPath)
    ? currentPath.slice(rootPath.length).replace(/^[\\/]+/, "")
    : "";
  let cumulative = rootPath;
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    const separator = document.createElement("span");
    separator.className = "browse-crumb-separator";
    separator.textContent = "/";
    browseCurrentPathEl.appendChild(separator);

    cumulative = joinPath(cumulative, segment);
    const crumbPath = cumulative;
    browseCurrentPathEl.appendChild(createBrowseCrumb(segment, crumbPath));
  }
}

function renderBrowseFolders(folders) {
  browseFolderListEl.innerHTML = "";
  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "browse-empty";
    empty.textContent = "No subfolders";
    browseFolderListEl.appendChild(empty);
    return;
  }

  for (const folder of folders) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "browse-folder-row";
    row.innerHTML = `
      <span class="folder-icon" aria-hidden="true"></span>
      <span class="browse-folder-text">
        <span class="browse-folder-name"></span>
        <span class="browse-folder-meta"></span>
      </span>
    `;
    row.querySelector(".browse-folder-name").textContent = folder.name;
    row.querySelector(".browse-folder-meta").textContent = browseFolderMeta(folder);
    row.addEventListener("click", () => loadBrowse(folder.path));
    browseFolderListEl.appendChild(row);
  }
}

function renderBrowseAssets(assets) {
  browseMediaLabel.textContent = `${assets.length} media item${assets.length === 1 ? "" : "s"}`;
  if (!assets.length) {
    browseThumbsEl.innerHTML = '<div class="browse-empty browse-empty--media">No photos or videos in this folder</div>';
    _lightboxAssets = [];
    return;
  }
  renderMediaThumbnails(browseThumbsEl, assets);
}

async function loadBrowse(folder = _browseCurrentPath) {
  const generation = ++_browseLoadGeneration;
  const hadVisibleLayout = !browseLayout.classList.contains("hidden");
  browseNoConfig.classList.add("hidden");
  if (hadVisibleLayout) {
    browseMediaLabel.textContent = "Loading";
    browseThumbsEl.innerHTML = '<div class="browse-empty browse-empty--media">Loading folder...</div>';
  } else {
    browseLayout.classList.add("hidden");
  }
  try {
    const cfg = await invoke("get_config");
    const directory = cfg.download?.directory;
    if (!directory) {
      browseNoConfig.innerHTML = '<p>No download directory is configured. Set one in <strong>Settings</strong> before browsing photos.</p>';
      browseNoConfig.classList.remove("hidden");
      return;
    }

    const result = await invoke("browse_photos", { directory, folder });
    if (generation !== _browseLoadGeneration) return;
    _browseCurrentPath = result.current_path;
    renderBrowseBreadcrumb(result.root_path, result.current_path);
    renderBrowseFolders(result.folders || []);
    renderBrowseAssets(result.assets || []);
    browseLayout.classList.remove("hidden");
  } catch (err) {
    const messageText = String(err || "Could not browse photos");
    if (hadVisibleLayout) {
      browseThumbsEl.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "browse-empty browse-empty--media";
      empty.textContent = messageText;
      browseThumbsEl.appendChild(empty);
      browseLayout.classList.remove("hidden");
    } else {
      browseNoConfig.classList.remove("hidden");
      browseNoConfig.textContent = messageText;
    }
  }
}

browseOpenFolderBtn.addEventListener("click", () => {
  if (_browseCurrentPath) invoke("open_folder", { path: _browseCurrentPath }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

const syncLog = document.getElementById("sync-log");
const syncLogCompact = document.getElementById("sync-log-compact");
const logExpandBtn = document.getElementById("log-expand-btn");
const startBtn = document.getElementById("sync-start-btn");
const stopBtn = document.getElementById("sync-stop-btn");
const badge = document.getElementById("sync-status-badge");
const syncOutputCard = document.getElementById("sync-output-card");
const progressWrap = document.getElementById("progress-bar-wrap");
const progressExpandBtn = document.getElementById("progress-expand-btn");
const progressInner = document.getElementById("progress-bar-inner");
const progressPercent = document.getElementById("sync-progress-percent");
const progressDetail = document.getElementById("sync-progress-detail");
const progressSpeed = document.getElementById("sync-progress-speed");
const progressTotal = document.getElementById("sync-progress-total");
const progressLifecycle = document.getElementById("sync-progress-lifecycle");

let outputExpanded = 0;

function setOutputExpanded(level) {
  outputExpanded = Math.max(0, Math.min(2, level));
  const showCompact = outputExpanded === 1;
  const showFull = outputExpanded === 2;
  syncLogCompact.classList.toggle("hidden", !showCompact);
  syncLog.classList.toggle("hidden", !showFull);
  logExpandBtn.classList.toggle("hidden", outputExpanded === 0);
  progressExpandBtn.classList.toggle("expanded", outputExpanded > 0);
  logExpandBtn.classList.toggle("expanded", showFull);
  if (showFull) syncLog.scrollTop = syncLog.scrollHeight;
}

progressExpandBtn.addEventListener("click", () => setOutputExpanded(outputExpanded > 0 ? 0 : 1));
logExpandBtn.addEventListener("click", () => setOutputExpanded(outputExpanded === 2 ? 1 : 2));

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

function clearLogs() {
  _logQueue.length = 0;
  syncLog.textContent = "";
  syncLogCompact.innerHTML = '<span class="log-compact-placeholder">—</span>';
  globalLog.textContent = "";
  logUnread = false;
  logBadge.classList.remove("visible");
  resetSyncDedup();
  setOutputExpanded(0);
  if (!syncRunning) {
    syncProgress = null;
    syncOutputCard.classList.add("hidden");
  }
}

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
    // Only auto-scroll if the user is already at (or within 60px of) the bottom.
    const atBottom = globalLog.scrollHeight - globalLog.scrollTop - globalLog.clientHeight < 60;
    if (atBottom) globalLog.scrollTop = globalLog.scrollHeight;
  } else {
    logUnread = true;
    logBadge.classList.add("visible");
  }
}

// ---------------------------------------------------------------------------
// Sync view
// ---------------------------------------------------------------------------

let syncRunning = false;
const shownKeiErrorWarnings = new Set();
const pendingKeiErrorWarnings = [];
let keiErrorWarningOpen = false;

async function drainKeiErrorWarnings() {
  if (keiErrorWarningOpen) return;
  const warning = pendingKeiErrorWarnings.shift();
  if (!warning) return;
  keiErrorWarningOpen = true;
  try {
    await message(warning.body, { title: warning.title, kind: "warning" });
  } catch (err) {
    console.error("kei error warning dialog failed:", err);
  } finally {
    keiErrorWarningOpen = false;
    drainKeiErrorWarnings();
  }
}

function showKeiErrorWarning(warning) {
  const key = warning.key || `${warning.title}\0${warning.body}`;
  if (shownKeiErrorWarnings.has(key)) return;
  shownKeiErrorWarnings.add(key);
  pendingKeiErrorWarnings.push(warning);
  drainKeiErrorWarnings();
}

let syncProgress = null;
let syncProgressPollInterval = null;
let syncProgressAnimationInterval = null;
const PROGRESS_SPINNER_FRAMES = ["◓", "◑", "◒", "◐"];

function resetSyncProgress() {
  syncProgress = {
    title: "Preparing sync",
    detail: "Starting kei",
    downloaded: 0,
    failed: 0,
    skipped: 0,
    total: null,
    speed: "-- B/s",
    eta: "calculating...",
    spinner: "◓",
    spinnerIndex: 0,
    visualPercent: 0,
    lifecycle: [],
    friendlySeen: false,
    logProgressSeen: false,
  };
  renderSyncProgress();
}

function numericField(parsed, names = []) {
  if (!parsed.fields) return null;
  const preferred = parsed.fields.find(({ key }) => names.includes(key.toLowerCase()));
  const fallback = parsed.fields.find(({ value }) => /^\d+$/.test(value));
  const value = preferred?.value ?? fallback?.value;
  if (!value || !/^\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

function setProgressPatch(patch) {
  if (!syncProgress) resetSyncProgress();
  syncProgress = { ...syncProgress, ...patch };
  const realPercent = getRealProgressPercent();
  if (realPercent !== null) {
    syncProgress.visualPercent = Math.max(syncProgress.visualPercent ?? 0, realPercent);
  }
  renderSyncProgress();
}

function getRealProgressPercent() {
  if (!syncProgress?.total || syncProgress.total <= 0) return null;
  const complete = Math.min(syncProgress.total, syncProgress.downloaded + syncProgress.failed);
  return Math.round((complete / syncProgress.total) * 100);
}

function renderSyncProgress() {
  if (!syncProgress) return;
  progressDetail.textContent = syncProgress.detail;
  progressSpeed.textContent = syncProgress.speed;
  renderProgressLifecycle();

  const realPercent = getRealProgressPercent();
  const visualPercent = Math.min(100, Math.max(realPercent ?? 0, syncProgress.visualPercent ?? 0));

  if (syncProgress.total && syncProgress.total > 0) {
    const complete = Math.min(syncProgress.total, syncProgress.downloaded + syncProgress.failed);
    progressPercent.textContent = `${Math.round(visualPercent)}% ${syncProgress.spinner}`;
    progressTotal.textContent = `${fmtNum(complete)}/${fmtNum(syncProgress.total)} · ${syncProgress.eta}`;
    progressInner.style.width = `${visualPercent}%`;
    progressInner.style.transform = "none";
  } else {
    progressPercent.textContent = `${Math.round(visualPercent)}% ${syncProgress.spinner}`;
    progressTotal.textContent = syncProgress.skipped > 0
      ? `${fmtNum(syncProgress.skipped)} skipped · ${syncProgress.eta}`
      : `0/0 · ${syncProgress.eta}`;
    progressInner.style.width = `${visualPercent}%`;
    progressInner.style.transform = "";
  }
}

function renderProgressLifecycle() {
  progressLifecycle.innerHTML = "";
  for (const item of syncProgress.lifecycle.slice(-7)) {
    const row = document.createElement("div");
    row.className = "progress-life-row";
    row.innerHTML = `
      <span class="progress-life-check">✓</span>
      <span class="progress-life-name"></span>
      <span class="progress-life-count"></span>
      <span class="progress-life-time"></span>
    `;
    row.querySelector(".progress-life-name").textContent = item.name;
    row.querySelector(".progress-life-count").textContent = item.count ?? "";
    row.querySelector(".progress-life-time").textContent = item.time ?? "";
    progressLifecycle.appendChild(row);
  }
}

function upsertProgressLifecycle(item) {
  if (!syncProgress) resetSyncProgress();
  const key = item.key ?? item.name;
  const existing = syncProgress.lifecycle.findIndex((entry) => (entry.key ?? entry.name) === key);
  const next = { key, ...item };
  if (existing === -1) syncProgress.lifecycle.push(next);
  else syncProgress.lifecycle[existing] = { ...syncProgress.lifecycle[existing], ...next };
  renderSyncProgress();
}

async function pollSyncProgress() {
  if (!syncRunning || !syncProgress) return;
  if (syncProgress.friendlySeen || syncProgress.logProgressSeen) return;
  try {
    const status = await invoke("get_status");
    const downloaded = Math.max(0, status.last_run_downloaded ?? 0);
    const failed = Math.max(0, status.last_run_failed ?? 0);
    const pending = Math.max(0, status.pending ?? 0);
    const runSeen = Math.max(0, status.last_run_seen ?? 0);
    const total = Math.max(runSeen, downloaded + failed + pending);

    if (total > 0) {
      setProgressPatch({
        title: downloaded + failed > 0 ? "Downloading from iCloud" : "Scanning iCloud",
        detail: pending > 0
          ? `${fmtNum(pending)} files remaining`
          : "Finalizing sync state",
        downloaded,
        failed,
        total,
      });
    } else {
      setProgressPatch({
        title: "Scanning iCloud",
        detail: "Counting photos and albums",
      });
    }
  } catch (err) {
    console.error("progress poll failed:", err);
  }
}

function startSyncProgressPolling() {
  if (syncProgressPollInterval) return;
  pollSyncProgress();
  syncProgressPollInterval = setInterval(pollSyncProgress, 2000);
}

function stopSyncProgressPolling() {
  if (!syncProgressPollInterval) return;
  clearInterval(syncProgressPollInterval);
  syncProgressPollInterval = null;
}

function tickSyncProgressAnimation() {
  if (!syncRunning || !syncProgress) return;
  syncProgress.spinnerIndex = (syncProgress.spinnerIndex + 1) % PROGRESS_SPINNER_FRAMES.length;
  syncProgress.spinner = PROGRESS_SPINNER_FRAMES[syncProgress.spinnerIndex];

  const realPercent = getRealProgressPercent();
  const current = Math.max(syncProgress.visualPercent ?? 0, realPercent ?? 0);
  const hasTotal = syncProgress.total && syncProgress.total > 0;
  const cap = hasTotal
    ? (realPercent >= 100 ? 100 : 96)
    : (/scanning|preparing/i.test(syncProgress.title) ? 38 : 72);

  if (current < cap) {
    const step = Math.max(0.2, (cap - current) * 0.025);
    syncProgress.visualPercent = Math.min(cap, current + step);
  } else {
    syncProgress.visualPercent = current;
  }

  renderSyncProgress();
}

function startSyncProgressAnimation() {
  if (syncProgressAnimationInterval) return;
  tickSyncProgressAnimation();
  syncProgressAnimationInterval = setInterval(tickSyncProgressAnimation, 900);
}

function stopSyncProgressAnimation() {
  if (!syncProgressAnimationInterval) return;
  clearInterval(syncProgressAnimationInterval);
  syncProgressAnimationInterval = null;
}

function updateSyncProgressFromLine(raw) {
  if (!syncProgress) return;
  const clean = stripAnsi(String(raw))
    .replace(/^\[err\]\s*/, "")
    .replace(/^\[out\]\s*/, "")
    .trim();
  const cleanParts = clean.split(/\r+/).map((part) => part.trim()).filter(Boolean);
  const progressText = cleanParts.at(-1) ?? clean;

  const friendlyAuth = clean.match(/✓\s+Authenticated as\s+(.+)/i);
  if (friendlyAuth) {
    syncProgress.friendlySeen = true;
    upsertProgressLifecycle({ key: "auth", name: `Authenticated as ${friendlyAuth[1].trim()}` });
  }

  const friendlyLibraries = clean.match(/✓\s+Listed\s+(.+)/i);
  if (friendlyLibraries) {
    syncProgress.friendlySeen = true;
    upsertProgressLifecycle({ key: "libraries", name: `Listed ${friendlyLibraries[1].trim()}` });
  }

  for (const albumMatch of clean.matchAll(/✓\s+(.+?)\s+([\d,]+)\s*\/\s*([\d,]+)\s+(\d+[smh])/g)) {
    syncProgress.friendlySeen = true;
    const [, name, done, total, time] = albumMatch;
    upsertProgressLifecycle({
      key: `album:${name.trim()}`,
      name: name.trim(),
      count: `${done}/${total}`,
      time,
    });
  }

  const friendlyDetail = progressText.match(/│\s+(.+?)\s+·\s+(.+?)(?=\s*$)/);
  if (friendlyDetail && !/[\\/\d]+\s+·/.test(friendlyDetail[1])) {
    setProgressPatch({
      friendlySeen: true,
      logProgressSeen: true,
      detail: `${friendlyDetail[1].trim()} · ${friendlyDetail[2].trim()}`,
    });
  }

  const friendlyPercent = progressText.match(/(\d+)%\s+([◐◓◑◒○●◌])/);
  if (friendlyPercent) {
    const percent = Number(friendlyPercent[1]);
    const staleDbDetail = /\b[\d,]+\s+files remaining\b/i.test(syncProgress.detail ?? "");
    setProgressPatch({
      friendlySeen: true,
      logProgressSeen: true,
      spinner: friendlyPercent[2],
      detail: staleDbDetail ? "Syncing with kei" : syncProgress.detail,
      visualPercent: Math.max(syncProgress.visualPercent ?? 0, percent),
    });
  }

  const friendlyFooter = progressText.match(/((?:--|[\d,.]+)\s*(?:[KMGTPE]?i?B)?\/s)\s+([\d,]+)\s*\/\s*([\d,]+)\s+·\s+([^│\r\n]+)/i);
  if (friendlyFooter) {
    const [, speed, doneRaw, totalRaw, eta] = friendlyFooter;
    const done = Number(doneRaw.replace(/,/g, ""));
    const total = Number(totalRaw.replace(/,/g, ""));
    setProgressPatch({
      friendlySeen: true,
      logProgressSeen: true,
      title: "Downloading from iCloud",
      detail: total > 0
        ? `${fmtNum(Math.max(0, total - done))} files remaining`
        : "Calculating remaining files",
      speed: speed.trim().replace(/\s+/g, " "),
      downloaded: done,
      total,
      eta: eta.trim(),
    });
  }

  const progressMatches = [...progressText.matchAll(/\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]\s+([\d,]+)\/([\d,]+)\s+\(([^)]*)\)\s+([^\r\n]*?)(?=\s+\d{4}-\d{2}-\d{2}T|\s+\^C\d{4}-\d{2}-\d{2}T|$)/g)];
  const progressMatch = progressMatches.at(-1);
  if (progressMatch) {
    const [, elapsed, doneRaw, totalRaw, eta, filenameRaw] = progressMatch;
    const done = Number(doneRaw.replace(/,/g, ""));
    const total = Number(totalRaw.replace(/,/g, ""));
    const filename = filenameRaw.trim();
    setProgressPatch({
      title: "Verifying files",
      logProgressSeen: true,
      detail: filename ? `${filename} · ${eta} remaining` : `${elapsed} elapsed · ${eta} remaining`,
      downloaded: done,
      failed: syncProgress.failed,
      total,
    });
  }

  const parsed = parseLine(raw);
  const msg = parsed.message ?? parsed.text ?? clean;

  const summary = clean.match(/^sync results:\s+(\d+)\s+downloaded,\s+(\d+)\s+failed,\s+(\d+)\s+total/i);
  if (summary) {
    setProgressPatch({
      title: "Sync results",
      detail: `${fmtNum(Number(summary[1]))} downloaded, ${fmtNum(Number(summary[2]))} failed`,
      downloaded: Number(summary[1]),
      failed: Number(summary[2]),
      total: Number(summary[3]),
    });
    return;
  }

  const friendlyDownloaded = clean.match(/^✓\s+Downloaded\s+([\d,]+)\s+new files?/i);
  if (friendlyDownloaded) {
    setProgressPatch({
      title: "Downloaded files",
      detail: clean.replace(/^✓\s+/, ""),
      downloaded: Number(friendlyDownloaded[1].replace(/,/g, "")),
    });
    return;
  }

  if (/^✓\s+Authenticated as /i.test(clean) || msg === "Authentication completed successfully") {
    setProgressPatch({ title: "Authenticated", detail: clean.replace(/^✓\s+/, "") || "Signed in to iCloud" });
  } else if (/^✓\s+Listed /i.test(clean)) {
    setProgressPatch({ title: "Scanning libraries", detail: clean.replace(/^✓\s+/, "") });
  } else if (/No sync token|full enumeration|Incremental sync/i.test(msg)) {
    setProgressPatch({ title: "Scanning iCloud", detail: msg });
  } else if (/No new photos to download/i.test(msg)) {
    setProgressPatch({ title: "Up to date", detail: "No new photos to download" });
  } else if (/Assets to download/i.test(msg)) {
    const total = numericField(parsed, ["count", "total", "assets", "to_download", "assets_to_download"]);
    setProgressPatch({
      title: "Ready to download",
      detail: total ? `${fmtNum(total)} files queued` : msg,
      total: total ?? syncProgress.total,
    });
  } else if (/Downloading files/i.test(msg)) {
    setProgressPatch({ title: "Downloading from iCloud", detail: msg });
  } else if (/Skipping asset: file exists/i.test(msg)) {
    setProgressPatch({
      detail: "Already on disk, skipping",
      skipped: syncProgress.skipped + 1,
    });
  } else if (/download/i.test(msg) && /complete|saved|finished/i.test(msg)) {
    setProgressPatch({
      title: "Downloading from iCloud",
      detail: msg,
      downloaded: syncProgress.downloaded + 1,
    });
  } else if ((parsed.level === "ERROR" || /^Error:/i.test(clean)) && /download|asset|file/i.test(clean)) {
    setProgressPatch({
      title: "Download issue",
      detail: msg,
      failed: syncProgress.failed + 1,
    });
  } else if (/^✓\s+Verified /i.test(clean)) {
    setProgressPatch({ title: "Verified downloads", detail: clean.replace(/^✓\s+/, "") });
  }
}

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
  syncOutputCard.classList.toggle("hidden", !running && !syncProgress);
  if (running) {
    if (!syncProgress) resetSyncProgress();
    _startThumbPolling();
    startSyncProgressPolling();
    startSyncProgressAnimation();
  } else {
    _stopThumbPolling();
    stopSyncProgressPolling();
    stopSyncProgressAnimation();
    loadRecentThumbnails();
  }
}

// Register Tauri event listeners once.
// Lines arrive as batches (Vec<String>) to reduce IPC overhead.
listen("sync-output-batch", (event) => {
  for (const line of event.payload) {
    console.log("[kei]", line);
    const errorWarning = getKeiErrorWarning(line) || getUnknownSmartFolderWarning(line);
    if (errorWarning) showKeiErrorWarning(errorWarning);
    updateSyncProgressFromLine(line);
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
  setProgressPatch({ title: "Sync complete", detail: "Finished syncing", visualPercent: 100 });
  setSyncRunning(false);
  appendLog("── Sync completed ──", "success");
  appendGlobalLog("── Sync completed ──");
  loadDashboard();
});
listen("sync-failed", (event) => {
  setProgressPatch({ title: "Sync failed", detail: String(event.payload) });
  setSyncRunning(false);
  appendLog(`── Sync failed: ${event.payload} ──`, "err");
  appendGlobalLog(`── Sync failed: ${event.payload} ──`);
  badge.classList.add("error");
  loadDashboard();
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
  resetSyncProgress();
  setSyncRunning(true);
  shownKeiErrorWarnings.clear();
  pendingKeiErrorWarnings.length = 0;
  keiErrorWarningOpen = false;
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
        if (!r.completed_at || r.interrupted) {
          statusCell = `<span class="run-interrupted">Interrupted</span>`;
        } else if (r.assets_failed > 0) {
          statusCell = `<span class="run-error">Partial</span>`;
        } else {
          statusCell = `<span class="run-ok">Complete</span>`;
        }

        const completed = !!(r.completed_at && !r.interrupted);
        const failedCell = completed
          ? (r.assets_failed > 0 ? `<span style="color:var(--destructive)">${fmtNum(r.assets_failed)}</span>` : fmtNum(r.assets_failed))
          : "—";

        return `<tr>
          <td>${r.id}</td>
          <td>${formatTs(r.started_at)}</td>
          <td>${formatDuration(r.started_at, r.completed_at)}</td>
          <td>${completed ? fmtNum(r.assets_seen) : "—"}</td>
          <td>${completed ? fmtNum(r.assets_downloaded) : "—"}</td>
          <td>${failedCell}</td>
          <td>${statusCell}</td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Error loading history: ${err}</td></tr>`;
  }
}

document.getElementById("history-clear-btn").addEventListener("click", async () => {
  if (syncRunning) {
    await message("Stop the current sync before clearing history and statistics.", {
      title: "Sync Running",
      kind: "warning",
    });
    return;
  }

  const shouldClear = await confirm(
    "This clears the local kei history, dashboard statistics, and sync state for the configured account. Downloaded files and login/session data are kept.",
    { title: "Clear History and Statistics?", kind: "warning" },
  );
  if (!shouldClear) return;

  const btn = document.getElementById("history-clear-btn");
  btn.disabled = true;
  try {
    await invoke("clear_history_and_stats");
    await Promise.all([loadHistory(), loadDashboard()]);
    const cfg = await invoke("get_config").catch(() => null);
    clearRecentThumbnails(true, cfg?.download?.directory);
    clearLogs();
    await message("History and statistics were cleared.", {
      title: "History Cleared",
      kind: "info",
    });
  } catch (err) {
    await message(`Failed to clear history and statistics:\n${err}`, {
      title: "Clear Failed",
      kind: "error",
    });
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Album picker (shared logic for include and exclude lists)
// ---------------------------------------------------------------------------

const albumsList = document.getElementById("cfg-albums-list");
const albumsTextInput = document.getElementById("cfg-albums");
const sharedAlbumsRow = document.getElementById("cfg-shared-albums-row");
const sharedAlbumsList = document.getElementById("cfg-shared-albums-list");
const sharedAlbumsTextInput = document.getElementById("cfg-shared-albums");
const excludeAlbumsList = document.getElementById("cfg-exclude-albums-list");
const excludeAlbumsTextInput = document.getElementById("cfg-exclude-albums");
const smartFoldersList = document.getElementById("cfg-smart-folders-list");
const smartFoldersTextInput = document.getElementById("cfg-smart-folders");
const sharedLibraryPseudoInput = document.getElementById("cfg-shared-library-pseudo");
const sharedLibraryWarning = document.getElementById("cfg-shared-library-warning");
const SHARED_LIBRARY_PSEUDO_ALBUM = "__photoharbor_shared_libraries__";

function _readChecklist(listEl, textEl) {
  if (!listEl.classList.contains("hidden")) {
    return Array.from(listEl.querySelectorAll("input[type=checkbox]:checked"))
      .map((cb) => cb.value);
  }
  return parseAlbums(textEl.value) ?? [];
}

function getSelectedAlbums() {
  return _readChecklist(albumsList, albumsTextInput)
    .filter((album) => album !== SHARED_LIBRARY_PSEUDO_ALBUM);
}

function getSelectedSharedAlbums() {
  return _readChecklist(sharedAlbumsList, sharedAlbumsTextInput);
}

function getExcludeAlbums() {
  return _readChecklist(excludeAlbumsList, excludeAlbumsTextInput);
}

function getSelectedSmartFolders() {
  return _readChecklist(smartFoldersList, smartFoldersTextInput);
}

function librarySelectorsIncludeShared(libraries = []) {
  return libraries.some((selector) => {
    const value = String(selector || "").trim().toLowerCase();
    if (!value || value.startsWith("!")) return false;
    return value === "shared" || value === "all" || value.startsWith("sharedsync-");
  });
}

function librarySelectorsIncludePrimary(libraries = []) {
  const values = libraries.map((selector) => String(selector || "").trim().toLowerCase()).filter(Boolean);
  if (values.length === 0) return true;
  return values.some((value) => !value.startsWith("!") && (value === "primary" || value === "all"));
}

function librarySelectorsAreSharedOnly(libraries = []) {
  let hasSharedSelector = false;
  const hasOnlySharedSelectors = libraries.every((selector) => {
    const value = String(selector || "").trim().toLowerCase();
    if (!value || value.startsWith("!")) return true;
    const isShared = value === "shared" || value.startsWith("sharedsync-");
    if (isShared) hasSharedSelector = true;
    return isShared;
  });
  return hasSharedSelector && hasOnlySharedSelectors;
}

function customLibrarySelectorsForUi(libraries = []) {
  const values = libraries.map((selector) => String(selector || "").trim()).filter(Boolean);
  if (values.length === 0) return [];
  const lower = values.map((selector) => selector.toLowerCase()).sort();
  const managed =
    (lower.length === 1 && ["primary", "shared", "all"].includes(lower[0])) ||
    (lower.length === 2 && lower[0] === "primary" && lower[1] === "shared");
  return managed ? [] : values;
}

function folderTemplatesUseLibraryToken(...templates) {
  return templates.some((template) => String(template || "").includes("{library}"));
}

function currentFolderTemplateValues() {
  const folderSelectVal = document.getElementById("cfg-folder-structure-select").value;
  const folderStructureBase = folderSelectVal === "__custom__"
    ? document.getElementById("cfg-folder-structure").value.trim()
    : folderSelectVal;
  const albumFolderSelectVal = document.getElementById("cfg-album-folder-structure-select").value;
  const albumFolderStructure = albumFolderSelectVal === "__custom__"
    ? document.getElementById("cfg-album-folder-structure").value.trim()
    : albumFolderSelectVal;
  const smartFolderSelectVal = document.getElementById("cfg-smart-folder-structure-select").value;
  const smartFolderStructure = smartFolderSelectVal === "__custom__"
    ? document.getElementById("cfg-smart-folder-structure").value.trim()
    : smartFolderSelectVal;
  return [folderStructureBase, albumFolderStructure, smartFolderStructure];
}

function updateSharedLibraryWarning() {
  if (!sharedLibraryWarning) return;
  const customLibraries = parseAlbums(document.getElementById("cfg-libraries").value) ?? [];
  const sharedAlbumsSelected = !sharedAlbumsRow.classList.contains("hidden") && getSelectedSharedAlbums().length > 0;
  const sharedSelected =
    sharedLibraryPseudoInput.checked ||
    sharedAlbumsSelected ||
    librarySelectorsIncludeShared(customLibraries);
  const hasLibraryTemplate = folderTemplatesUseLibraryToken(...currentFolderTemplateValues());
  sharedLibraryWarning.classList.toggle("hidden", !sharedSelected || hasLibraryTemplate);
}

function updateAlbumSelectionRows(loadPickers = false) {
  const albumsAll = document.getElementById("cfg-albums-all").checked;
  const sharedLibraryPhotos = sharedLibraryPseudoInput.checked;
  document.getElementById("cfg-albums-row").classList.toggle("hidden", albumsAll);
  document.getElementById("cfg-exclude-albums-row").classList.toggle("hidden", !albumsAll);
  sharedAlbumsRow.classList.toggle("hidden", albumsAll || sharedLibraryPhotos);
  if (loadPickers && !albumsAll) loadAlbumPicker(getSelectedAlbums());
  if (loadPickers && !albumsAll && !sharedLibraryPhotos) loadSharedAlbumPicker(getSelectedSharedAlbums());
  updateSharedLibraryWarning();
}

function uniqueAlbumNames(...groups) {
  const seen = new Set();
  const names = [];
  for (const group of groups) {
    for (const album of group) {
      const key = album.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(album);
    }
  }
  return names;
}

function _renderChecklist(listEl, textEl, albums, selected) {
  listEl.innerHTML = "";
  const sel = new Set(selected.map((s) => s.toLowerCase()));
  for (const name of albums) {
    const label = document.createElement("label");
    label.className = "album-check-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = sel.has(name.toLowerCase());
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    listEl.appendChild(label);
  }
  listEl.classList.remove("hidden");
  textEl.classList.add("hidden");
}

// Cache: null = not yet fetched, [] = fetch failed, [...] = album names.
let _albumCache = null;
let _albumCachePromise = null;
let _sharedAlbumCache = null;
let _sharedAlbumCachePromise = null;
let _smartFolderCache = null;
let _smartFolderCachePromise = null;

async function _fetchAlbums(bust) {
  if (bust) { _albumCache = null; _albumCachePromise = null; }
  if (_albumCache !== null) return _albumCache;
  if (!_albumCachePromise) {
    _albumCachePromise = invoke("list_kei_albums")
      .then((list) => { _albumCache = list; return list; })
      .catch(() => { _albumCache = []; _albumCachePromise = null; return null; });
  }
  return _albumCachePromise;
}

async function _fetchSharedAlbums(bust) {
  if (bust) { _sharedAlbumCache = null; _sharedAlbumCachePromise = null; }
  if (_sharedAlbumCache !== null) return _sharedAlbumCache;
  if (!_sharedAlbumCachePromise) {
    _sharedAlbumCachePromise = invoke("list_kei_shared_albums")
      .then((list) => { _sharedAlbumCache = list; return list; })
      .catch(() => { _sharedAlbumCache = []; _sharedAlbumCachePromise = null; return null; });
  }
  return _sharedAlbumCachePromise;
}

async function _fetchSmartFolders(bust) {
  if (bust) { _smartFolderCache = null; _smartFolderCachePromise = null; }
  if (_smartFolderCache !== null) return _smartFolderCache;
  if (!_smartFolderCachePromise) {
    _smartFolderCachePromise = invoke("list_kei_smart_folders")
      .then((list) => { _smartFolderCache = list; return list; })
      .catch(() => { _smartFolderCache = []; _smartFolderCachePromise = null; return null; });
  }
  return _smartFolderCachePromise;
}

async function _loadPicker(listEl, textEl, selected, bust, fetchItems) {
  const items = await fetchItems(bust);
  if (items && items.length > 0) {
    _renderChecklist(listEl, textEl, items, selected);
  } else {
    // Not authenticated or kei unavailable — use text input.
    listEl.classList.add("hidden");
    textEl.classList.remove("hidden");
    textEl.value = selected.join(", ");
  }
}

function loadAlbumPicker(selected, bust) {
  return _loadPicker(albumsList, albumsTextInput, selected, bust, _fetchAlbums);
}

function loadSharedAlbumPicker(selected, bust) {
  return _loadPicker(sharedAlbumsList, sharedAlbumsTextInput, selected, bust, _fetchSharedAlbums);
}

function loadExcludeAlbumPicker(selected, bust) {
  return _loadPicker(excludeAlbumsList, excludeAlbumsTextInput, selected, bust, _fetchAlbums);
}

function loadSmartFolderPicker(selected, bust) {
  return _loadPicker(smartFoldersList, smartFoldersTextInput, selected, bust, _fetchSmartFolders);
}

document.getElementById("cfg-albums-refresh").addEventListener("click", () => {
  loadAlbumPicker(getSelectedAlbums(), true);
  loadExcludeAlbumPicker(getExcludeAlbums(), true);
});

document.getElementById("cfg-shared-albums-refresh").addEventListener("click", () => {
  loadSharedAlbumPicker(getSelectedSharedAlbums(), true);
});

document.getElementById("cfg-exclude-albums-refresh").addEventListener("click", () => {
  loadAlbumPicker(getSelectedAlbums(), true);
  loadExcludeAlbumPicker(getExcludeAlbums(), true);
});

document.getElementById("cfg-smart-folders-refresh").addEventListener("click", () => {
  loadSmartFolderPicker(getSelectedSmartFolders(), true);
});

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

function mediaSelectionFromConfig(cfg = {}) {
  const media = cfg.filters?.media;
  if (Array.isArray(media)) {
    return {
      photos: media.includes("photos") || media.includes("live-photos"),
      videos: media.includes("videos") || media.includes("live-photos"),
    };
  }
  return {
    photos: cfg.filters?.skip_photos !== true,
    videos: cfg.filters?.skip_videos !== true,
  };
}

function mediaFilterFromSelection({ photos, videos }) {
  if (photos && videos) return null;
  if (photos) return ["photos"];
  if (videos) return ["videos"];
  return [];
}

async function loadSettings() {
  try {
    const [cfg, appSettings] = await Promise.all([
      invoke("get_config"),
      invoke("get_app_settings"),
    ]);

    document.getElementById("cfg-username").value = cfg.auth?.username ?? "";
    document.getElementById("cfg-domain").value = cfg.auth?.domain ?? "com";
    const librarySelectors = cfg.filters?.libraries ?? [];
    document.getElementById("cfg-libraries").value = customLibrarySelectorsForUi(librarySelectors).join(", ");
    document.getElementById("cfg-directory").value = cfg.download?.directory ?? "";
    document.getElementById("cfg-threads").value = cfg.download?.threads ?? "";
    // Folder structure for the unfiled pass; AppSettings is a legacy fallback.
    const folderStructureVal = cfg.download?.folder_structure ?? appSettings.folder_structure ?? "%Y/%m";
    const folderSelect = document.getElementById("cfg-folder-structure-select");
    const knownFolderOptions = Array.from(folderSelect.options).map((o) => o.value).filter((v) => v !== "__custom__");
    if (knownFolderOptions.includes(folderStructureVal)) {
      folderSelect.value = folderStructureVal;
      document.getElementById("cfg-folder-structure-custom-row").classList.add("hidden");
    } else {
      folderSelect.value = "__custom__";
      document.getElementById("cfg-folder-structure").value = folderStructureVal;
      document.getElementById("cfg-folder-structure-custom-row").classList.remove("hidden");
    }

    // Album folder structure; AppSettings is a legacy fallback.
    const albumFolderVal = cfg.download?.folder_structure_albums ?? appSettings.album_folder_structure ?? "{album}";
    const albumFolderSelect = document.getElementById("cfg-album-folder-structure-select");
    const knownAlbumOptions = Array.from(albumFolderSelect.options).map((o) => o.value).filter((v) => v !== "__custom__");
    if (knownAlbumOptions.includes(albumFolderVal)) {
      albumFolderSelect.value = albumFolderVal;
      document.getElementById("cfg-album-folder-structure-custom-row").classList.add("hidden");
    } else {
      albumFolderSelect.value = "__custom__";
      document.getElementById("cfg-album-folder-structure").value = albumFolderVal;
      document.getElementById("cfg-album-folder-structure-custom-row").classList.remove("hidden");
    }

    const smartFolderVal = cfg.download?.folder_structure_smart_folders ?? appSettings.smart_folder_structure ?? "{smart-folder}";
    const smartFolderSelect = document.getElementById("cfg-smart-folder-structure-select");
    const knownSmartOptions = Array.from(smartFolderSelect.options).map((o) => o.value).filter((v) => v !== "__custom__");
    if (knownSmartOptions.includes(smartFolderVal)) {
      smartFolderSelect.value = smartFolderVal;
      document.getElementById("cfg-smart-folder-structure-custom-row").classList.add("hidden");
    } else {
      smartFolderSelect.value = "__custom__";
      document.getElementById("cfg-smart-folder-structure").value = smartFolderVal;
      document.getElementById("cfg-smart-folder-structure-custom-row").classList.remove("hidden");
    }
    document.getElementById("cfg-exif").checked = cfg.metadata?.set_exif_datetime ?? false;
    const mediaSelection = mediaSelectionFromConfig(cfg);
    document.getElementById("cfg-skip-videos").checked = !mediaSelection.videos;
    document.getElementById("cfg-skip-photos").checked = !mediaSelection.photos;

    // kei stores album exclusions inline as "!Name"; legacy configs may still
    // carry exclude_albums or albums=["all"].
    const albumFilters = cfg.filters?.albums ?? [];
    const includedAlbums = albumFilters.filter((a) => !a.startsWith("!") && a.toLowerCase() !== "all");
    const excludedAlbums = [
      ...albumFilters.filter((a) => a.startsWith("!")).map((a) => a.slice(1)),
      ...(cfg.filters?.exclude_albums ?? []),
    ];
    const tomlHasAll = albumFilters.some((a) => a.toLowerCase() === "all");
    const tomlHasExclusionOnlySelection = includedAlbums.length === 0 && excludedAlbums.length > 0;
    const albumsAll = (appSettings.all_albums ?? false) || tomlHasAll || tomlHasExclusionOnlySelection;
    const primaryAlbums = albumsAll || !librarySelectorsIncludePrimary(librarySelectors) ? [] : includedAlbums;
    const sharedAlbums = albumsAll || !librarySelectorsIncludeShared(librarySelectors) ? [] : includedAlbums;
    const unfiledSelected = librarySelectorsAreSharedOnly(librarySelectors)
      ? false
      : (cfg.filters?.unfiled ?? true);
    sharedLibraryPseudoInput.checked = librarySelectorsIncludeShared(librarySelectors) && (cfg.filters?.unfiled ?? true);
    document.getElementById("cfg-albums-all").checked = albumsAll;
    updateAlbumSelectionRows();
    if (!albumsAll) loadAlbumPicker(primaryAlbums);
    if (!albumsAll && !sharedLibraryPseudoInput.checked) loadSharedAlbumPicker(sharedAlbums);

    loadExcludeAlbumPicker(excludedAlbums);
    document.getElementById("cfg-unfiled").checked = unfiledSelected;
    loadSmartFolderPicker(cfg.filters?.smart_folders ?? []);
    document.getElementById("cfg-recent").value = cfg.filters?.recent ?? "";
    document.getElementById("cfg-watch-interval").value = cfg.watch?.interval ?? "";
    document.getElementById("cfg-log-level").value = cfg.log_level ?? "";
    document.getElementById("cfg-max-download-attempts").value = cfg.download?.retry?.per_asset ?? "";

    const useSystem = appSettings.use_system_kei ?? false;
    document.getElementById("cfg-use-system-kei").checked = useSystem;
    document.getElementById("cfg-extra-args").value = appSettings.extra_args ?? "";
    document.getElementById("system-kei-warning").classList.toggle("hidden", !useSystem);
    updateSharedLibraryWarning();
  } catch (err) {
    console.error("get_config error:", err);
  }

  // Load kei versions async — doesn't block the rest of settings rendering.
  loadKeiVersions();
}

async function loadKeiVersions() {
  try {
    const v = await invoke("get_kei_versions");
    document.getElementById("kei-version-bundled").textContent = v.bundled_version ?? "not found";
    document.getElementById("kei-path-bundled").textContent = v.bundled_path ?? "";
    document.getElementById("kei-version-system").textContent = v.system_version ?? "not found";
    document.getElementById("kei-path-system").textContent = v.system_path ?? "";
  } catch {
    document.getElementById("kei-version-bundled").textContent = "—";
    document.getElementById("kei-version-system").textContent = "—";
  }
}

function parseAlbums(val) {
  const list = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

document.getElementById("cfg-albums-all").addEventListener("change", () => updateAlbumSelectionRows(true));

sharedLibraryPseudoInput.addEventListener("change", () => updateAlbumSelectionRows(true));
sharedAlbumsList.addEventListener("change", updateSharedLibraryWarning);
sharedAlbumsTextInput.addEventListener("input", updateSharedLibraryWarning);
document.getElementById("cfg-libraries").addEventListener("input", updateSharedLibraryWarning);

document.getElementById("cfg-folder-structure-select").addEventListener("change", (e) => {
  document.getElementById("cfg-folder-structure-custom-row").classList.toggle("hidden", e.target.value !== "__custom__");
  updateSharedLibraryWarning();
});

document.getElementById("cfg-album-folder-structure-select").addEventListener("change", (e) => {
  document.getElementById("cfg-album-folder-structure-custom-row").classList.toggle("hidden", e.target.value !== "__custom__");
  updateSharedLibraryWarning();
});

document.getElementById("cfg-smart-folder-structure-select").addEventListener("change", (e) => {
  document.getElementById("cfg-smart-folder-structure-custom-row").classList.toggle("hidden", e.target.value !== "__custom__");
  updateSharedLibraryWarning();
});

document.getElementById("cfg-folder-structure").addEventListener("input", updateSharedLibraryWarning);
document.getElementById("cfg-album-folder-structure").addEventListener("input", updateSharedLibraryWarning);
document.getElementById("cfg-smart-folder-structure").addEventListener("input", updateSharedLibraryWarning);

document.getElementById("cfg-use-system-kei").addEventListener("change", (e) => {
  document.getElementById("system-kei-warning").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("cfg-directory-pick").addEventListener("click", async () => {
  const dir = await openDialog({ directory: true, multiple: false, title: "Select Download Directory" });
  if (dir) { document.getElementById("cfg-directory").value = dir; scheduleSave(); }
});

document.getElementById("auth-wiki-btn").addEventListener("click", () => {
  invoke("open_url", { url: "https://github.com/rhoopr/kei/wiki/Authentication" });
});

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

const setupWizardOverlay = document.getElementById("setup-wizard-overlay");
const wizardSteps = Array.from(document.querySelectorAll("[data-wizard-step]"));
const wizardDots = Array.from(document.querySelectorAll("[data-step-dot]"));
const wizardBackBtn = document.getElementById("wizard-back-btn");
const wizardNextBtn = document.getElementById("wizard-next-btn");
const wizardLaterBtn = document.getElementById("wizard-later-btn");
const wizardError = document.getElementById("wizard-error");
let wizardStepIndex = 0;
let wizardSaving = false;

function configNeedsSetup(cfg) {
  const hasUsername = !!cfg.auth?.username?.trim?.();
  const hasDirectory = !!cfg.download?.directory?.trim?.();
  const mediaSelection = mediaSelectionFromConfig(cfg);
  return !hasUsername || !hasDirectory || (!mediaSelection.photos && !mediaSelection.videos);
}

function setWizardError(message) {
  wizardError.textContent = message || "";
  wizardError.classList.toggle("hidden", !message);
}

function setWizardStep(index) {
  wizardStepIndex = Math.max(0, Math.min(wizardSteps.length - 1, index));
  wizardSteps.forEach((step, i) => step.classList.toggle("active", i === wizardStepIndex));
  wizardDots.forEach((dot, i) => dot.classList.toggle("active", i <= wizardStepIndex));
  wizardBackBtn.classList.toggle("hidden", wizardStepIndex === 0);
  wizardNextBtn.textContent = wizardStepIndex === wizardSteps.length - 1 ? "Save Setup" : "Continue";
  setWizardError("");
}

function validateWizardStep() {
  if (wizardStepIndex === 0) {
    const username = document.getElementById("wizard-username").value.trim();
    if (!username) return "Enter your iCloud username.";
  }
  if (wizardStepIndex === 1) {
    const directory = document.getElementById("wizard-directory").value.trim();
    if (!directory) return "Choose a download directory.";
  }
  if (wizardStepIndex === 2) {
    const photos = document.getElementById("wizard-photos").checked;
    const videos = document.getElementById("wizard-videos").checked;
    if (!photos && !videos) return "Enable photos, videos, or both.";
  }
  return "";
}

function updateWizardSharedLibraryWarning() {
  const warning = document.getElementById("wizard-shared-library-warning");
  const shared = document.getElementById("wizard-shared-libraries").checked;
  const folderStructure = document.getElementById("wizard-folder-structure").value;
  warning.classList.toggle("hidden", !shared || folderStructure.includes("{library}"));
}

function showSetupWizard(cfg = {}) {
  document.getElementById("wizard-username").value = cfg.auth?.username ?? "";
  document.getElementById("wizard-domain").value = cfg.auth?.domain ?? "com";
  document.getElementById("wizard-directory").value = cfg.download?.directory ?? "";
  document.getElementById("wizard-folder-structure").value = cfg.download?.folder_structure ?? "%Y/%m";
  document.getElementById("wizard-shared-libraries").checked = librarySelectorsIncludeShared(cfg.filters?.libraries ?? []);
  document.getElementById("wizard-unfiled").checked = librarySelectorsAreSharedOnly(cfg.filters?.libraries ?? [])
    ? false
    : (cfg.filters?.unfiled ?? true);
  const mediaSelection = mediaSelectionFromConfig(cfg);
  document.getElementById("wizard-photos").checked = mediaSelection.photos;
  document.getElementById("wizard-videos").checked = mediaSelection.videos;
  const albumFilters = cfg.filters?.albums ?? [];
  const hasSpecificAlbums = albumFilters.some((album) => !album.startsWith("!") && album.toLowerCase() !== "all");
  document.getElementById("wizard-all-albums").checked = !hasSpecificAlbums;
  updateWizardSharedLibraryWarning();
  setWizardStep(0);
  setupWizardOverlay.classList.remove("hidden");
  setTimeout(() => document.getElementById("wizard-username").focus(), 100);
}

function hideSetupWizard() {
  setupWizardOverlay.classList.add("hidden");
}

async function saveWizardSettings() {
  if (wizardSaving) return;
  const error = validateWizardStep();
  if (error) {
    setWizardError(error);
    return;
  }

  const username = document.getElementById("wizard-username").value.trim();
  const domain = document.getElementById("wizard-domain").value;
  const directory = document.getElementById("wizard-directory").value.trim();
  const folderStructure = document.getElementById("wizard-folder-structure").value;
  const allAlbums = document.getElementById("wizard-all-albums").checked;
  const sharedLibraries = document.getElementById("wizard-shared-libraries").checked;
  const unfiled = document.getElementById("wizard-unfiled").checked;
  const photos = document.getElementById("wizard-photos").checked;
  const videos = document.getElementById("wizard-videos").checked;
  const primaryContentSelected = allAlbums || unfiled;

  const config = {
    log_level: null,
    auth: {
      username,
      domain: domain !== "com" ? domain : null,
    },
    download: {
      directory,
      threads: null,
      folder_structure: folderStructure || null,
      folder_structure_albums: "{album}",
      folder_structure_smart_folders: "{smart-folder}",
      retry: null,
    },
    metadata: null,
    filters: {
      libraries: sharedLibraries
        ? (primaryContentSelected ? ["all"] : ["shared"])
        : ["primary"],
      albums: allAlbums ? ["all"] : null,
      exclude_albums: null,
      smart_folders: null,
      unfiled: (unfiled || sharedLibraries) ? null : false,
      media: mediaFilterFromSelection({ photos, videos }),
      recent: null,
    },
    watch: { interval: null },
  };

  wizardSaving = true;
  wizardNextBtn.disabled = true;
  wizardBackBtn.disabled = true;
  wizardLaterBtn.disabled = true;
  try {
    await Promise.all([
      invoke("save_config", { config }),
      invoke("save_app_settings", { settings: {
        use_system_kei: false,
        extra_args: "--friendly",
        all_albums: allAlbums,
        folder_structure: folderStructure || null,
        album_folder_structure: "{album}",
        smart_folder_structure: "{smart-folder}",
      } }),
    ]);
    hideSetupWizard();
    await loadSettings();
    await loadDashboard();
    showView("sync");
  } catch (err) {
    setWizardError(`Failed to save setup: ${err}`);
  } finally {
    wizardSaving = false;
    wizardNextBtn.disabled = false;
    wizardBackBtn.disabled = false;
    wizardLaterBtn.disabled = false;
  }
}

wizardBackBtn.addEventListener("click", () => setWizardStep(wizardStepIndex - 1));
wizardNextBtn.addEventListener("click", () => {
  const error = validateWizardStep();
  if (error) {
    setWizardError(error);
    return;
  }
  if (wizardStepIndex < wizardSteps.length - 1) setWizardStep(wizardStepIndex + 1);
  else saveWizardSettings();
});
wizardLaterBtn.addEventListener("click", () => hideSetupWizard());

document.getElementById("wizard-directory-pick").addEventListener("click", async () => {
  const dir = await openDialog({ directory: true, multiple: false, title: "Select Download Directory" });
  if (dir) document.getElementById("wizard-directory").value = dir;
});
document.getElementById("wizard-shared-libraries").addEventListener("change", updateWizardSharedLibraryWarning);
document.getElementById("wizard-folder-structure").addEventListener("change", updateWizardSharedLibraryWarning);

// ---------------------------------------------------------------------------
// About Modal
// ---------------------------------------------------------------------------

const aboutOverlay = document.getElementById("modal-about-overlay");

document.getElementById("sidebar-header").addEventListener("click", async () => {
  const version = await getVersion().catch(() => "—");
  document.getElementById("about-version").textContent = `Version ${version}`;
  aboutOverlay.classList.remove("hidden");
});

document.getElementById("about-close-btn").addEventListener("click", () => {
  aboutOverlay.classList.add("hidden");
});

aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) aboutOverlay.classList.add("hidden");
});

document.querySelectorAll("#modal-about [data-url]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_url", { url: a.dataset.url });
  });
});

async function saveSettings() {
  const username = document.getElementById("cfg-username").value.trim();
  const domain = document.getElementById("cfg-domain").value;
  const customLibraries = parseAlbums(document.getElementById("cfg-libraries").value);
  const directory = document.getElementById("cfg-directory").value.trim();
  const threads = parseInt(document.getElementById("cfg-threads").value, 10);
  const folderSelectVal = document.getElementById("cfg-folder-structure-select").value;
  const folderStructureBase = folderSelectVal === "__custom__"
    ? document.getElementById("cfg-folder-structure").value.trim()
    : folderSelectVal;

  const albumFolderSelectVal = document.getElementById("cfg-album-folder-structure-select").value;
  const albumFolderStructure = albumFolderSelectVal === "__custom__"
    ? document.getElementById("cfg-album-folder-structure").value.trim()
    : albumFolderSelectVal;
  const smartFolderSelectVal = document.getElementById("cfg-smart-folder-structure-select").value;
  const smartFolderStructure = smartFolderSelectVal === "__custom__"
    ? document.getElementById("cfg-smart-folder-structure").value.trim()
    : smartFolderSelectVal;
  const setExif = document.getElementById("cfg-exif").checked;
  const skipVideos = document.getElementById("cfg-skip-videos").checked;
  const skipPhotos = document.getElementById("cfg-skip-photos").checked;
  if (skipVideos && skipPhotos) {
    alert("Enable photos, videos, or both.");
    return;
  }
  const albumsAll = document.getElementById("cfg-albums-all").checked;
  const sharedLibraryPhotos = sharedLibraryPseudoInput.checked;
  const selectedPrimaryAlbums = getSelectedAlbums();
  const selectedSharedAlbums = albumsAll || sharedLibraryPhotos ? [] : getSelectedSharedAlbums();
  const selectedNamedAlbums = uniqueAlbumNames(selectedPrimaryAlbums, selectedSharedAlbums);
  // kei stores exclusions inline: albums = ["!Screenshots"] means all albums except Screenshots.
  const excludeAlbums = getExcludeAlbums().length > 0 ? getExcludeAlbums() : null;
  const albums = albumsAll
    ? (excludeAlbums ? excludeAlbums.map((album) => `!${album}`) : ["all"])
    : (selectedNamedAlbums.length > 0 ? selectedNamedAlbums : null);
  const selectedSmartFolders = getSelectedSmartFolders();
  const smartFolders = selectedSmartFolders.length > 0 ? selectedSmartFolders : null;
  const unfiled = document.getElementById("cfg-unfiled").checked;
  const sharedAlbumContentSelected = selectedSharedAlbums.length > 0;
  const sharedContentSelected = sharedLibraryPhotos || sharedAlbumContentSelected;
  const primaryContentSelected =
    albumsAll ||
    selectedPrimaryAlbums.length > 0 ||
    unfiled ||
    (smartFolders?.length ?? 0) > 0;
  const libraries = customLibraries ?? (
    sharedContentSelected
      ? (primaryContentSelected ? ["all"] : ["shared"])
      : ["primary"]
  );
  const recent = parseInt(document.getElementById("cfg-recent").value, 10);
  const maxDownloadAttempts = parseInt(document.getElementById("cfg-max-download-attempts").value, 10);
  const watchInterval = parseInt(document.getElementById("cfg-watch-interval").value, 10);
  const logLevel = document.getElementById("cfg-log-level").value || null;
  const useSystemKei = document.getElementById("cfg-use-system-kei").checked;
  const extraArgs = document.getElementById("cfg-extra-args").value.trim();

  const config = {
    log_level: logLevel,
    auth: {
      username: username || null,
      domain: domain !== "com" ? domain : null,
    },
    download: {
      directory: directory || null,
      threads: isNaN(threads) ? null : threads,
      folder_structure: folderStructureBase || null,
      folder_structure_albums: albumFolderStructure || null,
      folder_structure_smart_folders: smartFolderStructure || null,
      retry: isNaN(maxDownloadAttempts) || maxDownloadAttempts < 0 ? null : {
        per_asset: maxDownloadAttempts,
      },
    },
    metadata: {
      set_exif_datetime: setExif || null,
    },
    filters: {
      libraries: libraries,
      albums: albums,
      exclude_albums: null,
      smart_folders: smartFolders,
      unfiled: (unfiled || sharedLibraryPhotos) ? null : false,
      media: mediaFilterFromSelection({ photos: !skipPhotos, videos: !skipVideos }),
      recent: isNaN(recent) || recent <= 0 ? null : recent,
    },
    watch: {
      interval: isNaN(watchInterval) ? null : watchInterval,
    },
  };

  try {
    await Promise.all([
      invoke("save_config", { config }),
      invoke("save_app_settings", { settings: {
        use_system_kei: useSystemKei,
        extra_args: extraArgs || null,
        all_albums: albumsAll,
        folder_structure: folderStructureBase || null,
        album_folder_structure: albumFolderStructure || null,
        smart_folder_structure: smartFolderStructure || null,
      } }),
    ]);
    document.getElementById("settings-required-notice").classList.add("hidden");
    const msg = document.getElementById("settings-saved-msg");
    msg.classList.remove("hidden");
    clearTimeout(msg._hideTimer);
    msg._hideTimer = setTimeout(() => msg.classList.add("hidden"), 2000);
  } catch (err) {
    alert(`Failed to save settings:\n${err}`);
  }
}

let _saveTimer = null;
function scheduleSave() {
  if (!document.getElementById("view-settings").classList.contains("active")) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveSettings, 600);
}

document.getElementById("settings-form").addEventListener("input", scheduleSave);
document.getElementById("settings-form").addEventListener("change", scheduleSave);

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

  // Restore sync button state if a sync was already running (e.g. after a Vite reload).
  try {
    const status = await invoke("get_status");
    if (status.is_syncing) setSyncRunning(true);
  } catch {}

  try {
    const cfg = await invoke("get_config");
    const status = await invoke("get_status").catch(() => ({ is_syncing: false }));
    if (!status.is_syncing && configNeedsSetup(cfg)) showSetupWizard(cfg);
  } catch {}
})();

document.getElementById("copy-install-cmd").addEventListener("click", () => {
  const text = document.getElementById("install-cmd-text").textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copy-install-cmd");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

toolbarTitle.textContent = VIEW_TITLES["sync"];
loadDashboard();
loadRecentThumbnails();
