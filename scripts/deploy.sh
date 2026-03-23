#!/usr/bin/env bash
set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$NANOCLAW_DIR"

echo "[deploy] Pulling latest from GitHub..."
git pull --ff-only
git add -A
git commit -m "auto: Nani deploy $(date +%Y-%m-%dT%H:%M)" || true
git push

echo "[deploy] Building container..."
./container/build.sh

echo "[deploy] Restarting NanoClaw service..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"

echo "[deploy] Done."

