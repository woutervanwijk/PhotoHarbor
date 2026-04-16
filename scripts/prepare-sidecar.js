#!/usr/bin/env node
/**
 * Copies the locally-installed kei binary into src-tauri/binaries/ with the
 * target-triple suffix that Tauri requires for sidecar bundling.
 *
 * Works on macOS, Linux, and Windows.
 *
 * Run once before `npm run build` (or `npm run dev`):
 *   node scripts/prepare-sidecar.js
 *
 * The resulting file is gitignored — re-run whenever you update kei.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const isWindows = process.platform === "win32";
const binName = isWindows ? "kei.exe" : "kei";

// ── Locate the kei binary ────────────────────────────────────────────────────

function findKei() {
  if (process.env.KEI_BIN && fs.existsSync(process.env.KEI_BIN)) {
    return process.env.KEI_BIN;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = isWindows
    ? [path.join(home, ".cargo", "bin", "kei.exe")]
    : [
        path.join(home, ".cargo", "bin", "kei"),
        "/usr/local/bin/kei",
        "/opt/homebrew/bin/kei",
        "/usr/bin/kei",
      ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Try PATH
  try {
    const cmd = isWindows ? "where kei" : "which kei";
    const result = execSync(cmd, { encoding: "utf8" }).trim().split("\n")[0].trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // not on PATH
  }

  return null;
}

// ── Determine Rust target triple ─────────────────────────────────────────────

function getTargetTriple() {
  try {
    const output = execSync("rustc -vV", { encoding: "utf8" });
    const match = output.match(/^host:\s+(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // rustc not found
  }
  throw new Error("rustc not found — install Rust from https://rustup.rs");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const keiPath = findKei();
if (!keiPath) {
  console.error("Error: kei not found. Install it with: cargo install kei");
  process.exit(1);
}
console.log(`Found kei at: ${keiPath}`);

const triple = getTargetTriple();
console.log(`Target triple: ${triple}`);

const destDir = path.join(__dirname, "..", "src-tauri", "binaries");
fs.mkdirSync(destDir, { recursive: true });

const destName = isWindows ? `kei-${triple}.exe` : `kei-${triple}`;
const destPath = path.join(destDir, destName);

fs.copyFileSync(keiPath, destPath);
if (!isWindows) fs.chmodSync(destPath, 0o755);

console.log(`Copied to: ${destPath}`);
console.log("Done — you can now run 'npm run dev' or 'npm run build'.");
