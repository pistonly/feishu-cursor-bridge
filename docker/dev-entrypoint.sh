#!/usr/bin/env bash
set -euo pipefail

cd /home/liuyang/Documents/feishu-cursor-bridge

export HOME=/home/liuyang
export PATH="/home/liuyang/.local/bin:${PATH}"

echo "[docker-dev] repo: $(pwd)"
echo "[docker-dev] agent: $(command -v agent || echo 'NOT FOUND')"

required_paths=(
  "/home/liuyang/.local/bin/agent"
  "/home/liuyang/.local/share/cursor-agent"
  "/home/liuyang/.cursor"
  "/home/liuyang/.config/Cursor"
  "/home/liuyang/.feishu-cursor-bridge"
  "/home/liuyang/Documents"
)

for path in "${required_paths[@]}"; do
  if [ ! -e "$path" ]; then
    echo "[docker-dev] warning: expected mount not found: $path" >&2
  fi
done

if ! command -v agent >/dev/null 2>&1; then
  echo "[docker-dev] error: agent command not found. Check compose bind mounts for ~/.local/bin and ~/.local/share/cursor-agent." >&2
  exit 1
fi

lockfile="package-lock.json"
stamp="node_modules/.package-lock.sha256"

mkdir -p node_modules

if [ -f "$lockfile" ]; then
  current_hash="$(sha256sum "$lockfile" | awk '{print $1}')"
  installed_hash=""
  if [ -f "$stamp" ]; then
    installed_hash="$(tr -d '[:space:]' < "$stamp")"
  fi

  if [ ! -x node_modules/.bin/tsx ] || [ "$current_hash" != "$installed_hash" ]; then
    echo "[docker-dev] installing npm dependencies..."
    npm install
    printf '%s\n' "$current_hash" > "$stamp"
  fi
fi

exec "$@"
