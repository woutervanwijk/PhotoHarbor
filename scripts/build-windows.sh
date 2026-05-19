#!/bin/bash
# Cross-compile a Windows .exe on macOS using cargo-xwin + LLVM.
# Produces: src-tauri/target/x86_64-pc-windows-msvc/release/photoharbor.exe
#
# First-time setup (run once):
#   brew install llvm
#   cargo install cargo-xwin
#   rustup target add x86_64-pc-windows-msvc

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
TARGET=x86_64-pc-windows-msvc

cd "$ROOT"

# ── LLVM (provides llvm-rc, llvm-lib, lld-link needed for Windows cross-build) ──
LLVM_PREFIX="$(brew --prefix llvm 2>/dev/null)" || true
if [ -z "$LLVM_PREFIX" ] || [ ! -d "$LLVM_PREFIX/bin" ]; then
  echo "LLVM not found. Install it with:"
  echo "  brew install llvm"
  exit 1
fi
export PATH="$LLVM_PREFIX/bin:$PATH"

# ── cargo-xwin ────────────────────────────────────────────────────────────────
if ! cargo xwin --version &>/dev/null 2>&1; then
  echo "cargo-xwin not found. Install it with:"
  echo "  cargo install cargo-xwin"
  exit 1
fi

# ── Rust Windows target ───────────────────────────────────────────────────────
if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "Adding Rust target $TARGET..."
  rustup target add "$TARGET"
fi

# ── Build ─────────────────────────────────────────────────────────────────────
echo "── Building frontend..."
npm run vite:build

echo "── Downloading Windows kei sidecar..."
TAURI_TARGET_TRIPLE=$TARGET node scripts/prepare-sidecar.js

echo "── Cross-compiling for Windows..."
cd src-tauri
cargo xwin build --target "$TARGET" --release

EXE="$ROOT/src-tauri/target/$TARGET/release/photoharbor.exe"
echo ""
echo "Done: $EXE"
