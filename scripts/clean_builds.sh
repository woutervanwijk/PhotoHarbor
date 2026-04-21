#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Cleaning Vite cache..."
rm -rf "$ROOT/dist" "$ROOT/node_modules/.vite"

echo "Cleaning Rust/Tauri build artifacts..."
cargo clean --manifest-path "$ROOT/src-tauri/Cargo.toml"

echo "Done."
