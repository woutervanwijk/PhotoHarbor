#!/usr/bin/env node
/**
 * Downloads a kei release from GitHub and places it in
 * src-tauri/binaries/ with the target-triple suffix Tauri requires.
 *
 * The downloaded version is pinned in src-tauri/binaries/.kei-version so that
 * cross-platform builds (e.g. building Windows on macOS) always use the same
 * version as the native binary — not whatever happens to be latest.
 *
 *   node scripts/prepare-sidecar.js          # use pinned version (or latest on first run)
 *   node scripts/prepare-sidecar.js --force  # fetch latest and update the pin
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const REPO = "rhoopr/kei";
const BIN_DIR = path.join(__dirname, "..", "src-tauri", "binaries");
const VERSION_FILE = path.join(BIN_DIR, ".kei-version");
const isWindows = process.platform === "win32";
const force = process.argv.includes("--force");

function getPinnedVersion() {
  try {
    const v = fs.readFileSync(VERSION_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

// ── Map Rust target triple → GitHub asset name ───────────────────────────────

function assetForTriple(triple) {
  // triple examples: aarch64-apple-darwin, x86_64-unknown-linux-gnu,
  //                  x86_64-pc-windows-msvc
  if (triple.includes("apple-darwin")) {
    const arch = triple.startsWith("aarch64") ? "aarch64" : "x86_64";
    return { name: `kei-macos-${arch}.tar.gz`, ext: "tar.gz" };
  }
  if (triple.includes("windows")) {
    return { name: "kei-windows-x86_64.zip", ext: "zip" };
  }
  // Linux
  const arch = triple.startsWith("aarch64") ? "aarch64" : "x86_64";
  return { name: `kei-linux-${arch}.tar.gz`, ext: "tar.gz" };
}

// ── Target triple from rustc ──────────────────────────────────────────────────

function getTargetTriple() {
  // Allow CI to override (needed for macOS universal builds where both
  // aarch64-apple-darwin and x86_64-apple-darwin sidecars must be present).
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  try {
    const out = execSync("rustc -vV", { encoding: "utf8" });
    const m = out.match(/^host:\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // fall through
  }
  throw new Error("rustc not found — install Rust from https://rustup.rs");
}

// ── GitHub API ────────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    opts.headers = { "User-Agent": "kei-photosync-prepare-script" };
    if (process.env.GITHUB_TOKEN) {
      opts.headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    https.get(opts, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

// ── Download file (follows redirects) ────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function get(u) {
      https.get(u, { headers: { "User-Agent": "kei-photosync-prepare-script" } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(`\r  Downloading… ${pct}%`);
          }
        });
        res.pipe(file);
        file.on("finish", () => { process.stdout.write("\n"); file.close(resolve); });
      }).on("error", reject);
    }
    get(url);
  });
}

// ── Extract archive → single `kei[.exe]` binary ───────────────────────────────

function extract(archivePath, ext, outDir) {
  if (ext === "tar.gz") {
    execSync(`tar -xzf "${archivePath}" -C "${outDir}"`, { stdio: "inherit" });
  } else {
    // .zip
    if (isWindows) {
      // tar ≥ Windows 10 build 17063 supports zip
      execSync(`tar -xf "${archivePath}" -C "${outDir}"`, { stdio: "inherit" });
    } else {
      execSync(`unzip -o "${archivePath}" -d "${outDir}"`, { stdio: "inherit" });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const triple = getTargetTriple();
  const { name: assetName, ext } = assetForTriple(triple);
  const targetIsWindows = triple.includes("windows") || isWindows;
  const destBin = targetIsWindows ? `kei-${triple}.exe` : `kei-${triple}`;
  const destPath = path.join(BIN_DIR, destBin);

  // Check if already up-to-date (unless --force)
  if (!force && fs.existsSync(destPath)) {
    console.log(`Sidecar already present: ${destPath}`);
    console.log("Run with --force to re-download.");
    return;
  }

  console.log(`Target triple: ${triple}`);

  const pinnedVersion = force ? null : getPinnedVersion();
  if (pinnedVersion) {
    console.log(`Using pinned kei version: ${pinnedVersion} (run with --force to update)`);
  } else {
    console.log(`Fetching latest release from github.com/${REPO}…`);
  }
  const releaseUrl = pinnedVersion
    ? `https://api.github.com/repos/${REPO}/releases/tags/${pinnedVersion}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;

  const release = await fetchJson(releaseUrl);
  const tag = release.tag_name;
  const asset = (release.assets || []).find((a) => a.name === assetName);

  if (!asset) {
    console.error(`No asset named "${assetName}" found in release ${tag}.`);
    console.error("Available assets:", (release.assets || []).map((a) => a.name).join(", "));
    process.exit(1);
  }

  console.log(`Release: ${tag}  |  Asset: ${assetName}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kei-sidecar-"));
  const archivePath = path.join(tmpDir, assetName);

  try {
    await download(asset.browser_download_url, archivePath);

    console.log("  Extracting…");
    extract(archivePath, ext, tmpDir);

    // Find the extracted binary (kei or kei.exe) — use the target triple, not
    // the host platform, so macOS cross-builds for Windows find kei.exe.
    const targetIsWindows = triple.includes("windows") || isWindows;
    const extractedBin = path.join(tmpDir, targetIsWindows ? "kei.exe" : "kei");
    if (!fs.existsSync(extractedBin)) {
      throw new Error(`Expected binary not found after extraction: ${extractedBin}`);
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.copyFileSync(extractedBin, destPath);
    if (!isWindows) fs.chmodSync(destPath, 0o755);

    // Pin the version so cross-platform builds use the same release.
    fs.writeFileSync(VERSION_FILE, tag + "\n");

    console.log(`Installed: ${destPath} (${tag})`);
    console.log(`Done — you can now run 'npm run dev' or 'npm run build'.`);
  } finally {
    // Clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
