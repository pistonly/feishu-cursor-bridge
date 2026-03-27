#!/usr/bin/env bash
# 本地调试：默认「先结束已有桥接进程再起 dev」，避免多实例；依赖 ~/.feishu-cursor-bridge/bridge.lock（与程序一致）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCK_FILE="${BRIDGE_SINGLE_INSTANCE_LOCK:-$HOME/.feishu-cursor-bridge/bridge.lock}"

# 从 .env 读取 BRIDGE_SINGLE_INSTANCE_LOCK（仅当环境中未设置该变量时）
if [[ -z "${BRIDGE_SINGLE_INSTANCE_LOCK+x}" ]] && [[ -f "$ROOT/.env" ]]; then
  line="$(grep -E '^[[:space:]]*(export[[:space:]]+)?BRIDGE_SINGLE_INSTANCE_LOCK=' "$ROOT/.env" 2>/dev/null | tail -1 || true)"
  if [[ -n "$line" ]]; then
    value="${line#*=}"
    value="${value%%#*}"
    value="$(echo "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
    if [[ "$value" =~ ^~(/|$) ]]; then
      value="${value/\~/$HOME}"
    fi
    LOCK_FILE="$value"
  fi
fi

expand_lock_path() {
  local p="$1"
  if [[ "$p" =~ ^~(/|$) ]]; then
    echo "${p/\~/$HOME}"
  else
    echo "$p"
  fi
}
LOCK_FILE="$(expand_lock_path "$LOCK_FILE")"

read_lock_pid() {
  if [[ ! -f "$LOCK_FILE" ]]; then
    echo ""
    return 0
  fi
  local raw
  raw="$(head -1 "$LOCK_FILE" 2>/dev/null | tr -d '\r\n' || true)"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    echo "$raw"
  else
    echo ""
  fi
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

stop_bridge() {
  local pid
  pid="$(read_lock_pid)"
  if [[ -z "$pid" ]]; then
    if [[ -f "$LOCK_FILE" ]]; then
      echo "[bridge-dev] Removing stale lock (no valid PID): $LOCK_FILE"
      rm -f "$LOCK_FILE"
    fi
    return 0
  fi
  if ! is_running "$pid"; then
    echo "[bridge-dev] Removing stale lock (PID $pid not running): $LOCK_FILE"
    rm -f "$LOCK_FILE"
    return 0
  fi
  echo "[bridge-dev] Stopping bridge PID $pid ..."
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while is_running "$pid" && [[ $i -lt 80 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  if is_running "$pid"; then
    echo "[bridge-dev] Force killing PID $pid ..."
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
  fi
  rm -f "$LOCK_FILE" 2>/dev/null || true
  echo "[bridge-dev] Stopped."
}

cmd="${1:-restart}"

case "$cmd" in
  stop)
    stop_bridge
    ;;
  status)
    pid="$(read_lock_pid)"
    if [[ -z "$pid" ]]; then
      echo "[bridge-dev] Not running (no lock or empty: $LOCK_FILE)"
      exit 1
    fi
    if is_running "$pid"; then
      echo "[bridge-dev] Running PID $pid (lock: $LOCK_FILE)"
      exit 0
    fi
    echo "[bridge-dev] Stale lock (PID $pid dead): $LOCK_FILE"
    exit 1
    ;;
  restart | dev | run | "")
    stop_bridge
    echo "[bridge-dev] Starting: npm run dev"
    exec npm run dev
    ;;
  -h | --help | help)
    cat <<'EOF'
用法: scripts/bridge-dev.sh [命令]

  (默认) restart|dev|run   先尝试停止已有实例，再执行 npm run dev
  stop                    仅停止（按锁文件 PID 发 SIGTERM）
  status                  是否运行（读锁文件）；未运行则 exit 1
  -h, --help              帮助

环境变量 BRIDGE_SINGLE_INSTANCE_LOCK 可覆盖锁文件路径（与桥接程序一致）。
EOF
    ;;
  *)
    echo "未知命令: $cmd （见 scripts/bridge-dev.sh --help）" >&2
    exit 1
    ;;
esac
