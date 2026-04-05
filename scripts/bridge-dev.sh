#!/usr/bin/env bash
# 本地调试：默认「先结束已有桥接进程再起 dev」，避免多实例；依赖 ~/.feishu-cursor-bridge/bridge.lock（与程序一致）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCK_FILE="${BRIDGE_SINGLE_INSTANCE_LOCK:-$HOME/.feishu-cursor-bridge/bridge.lock}"
LOG_FILE="${BRIDGE_DEV_LOG_FILE:-$HOME/.feishu-cursor-bridge/logs/bridge-dev.log}"

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
LOG_FILE="$(expand_lock_path "$LOG_FILE")"

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

can_signal_pid() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

pid_exists() {
  local pid="$1"
  [[ -n "$pid" ]] && ps -p "$pid" -o pid= >/dev/null 2>&1
}

is_permission_denied_pid() {
  local pid="$1"
  pid_exists "$pid" && ! can_signal_pid "$pid"
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  # kill -0 在 EPERM 时也会返回失败；再用 ps 判断，避免误删他人进程锁。
  if can_signal_pid "$pid"; then
    return 0
  fi
  pid_exists "$pid"
}

wait_for_lock_ready() {
  local max_tries=50 # 5s
  local i=0
  local pid
  while [[ $i -lt $max_tries ]]; do
    pid="$(read_lock_pid)"
    if [[ -n "$pid" ]] && is_running "$pid"; then
      echo "$pid"
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
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
  if is_permission_denied_pid "$pid"; then
    echo "[bridge-dev] PID $pid exists but current user cannot signal it; keeping lock: $LOCK_FILE" >&2
    return 1
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
  if is_running "$pid"; then
    echo "[bridge-dev] Failed to stop PID $pid; keeping lock: $LOCK_FILE" >&2
    return 1
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
    if can_signal_pid "$pid"; then
      echo "[bridge-dev] Running PID $pid (lock: $LOCK_FILE)"
      exit 0
    fi
    if is_permission_denied_pid "$pid"; then
      echo "[bridge-dev] Running PID $pid but permission denied for signal check (lock: $LOCK_FILE)"
      exit 0
    fi
    echo "[bridge-dev] Stale lock (PID $pid dead): $LOCK_FILE"
    exit 1
    ;;
  restart | dev | run | "")
    stop_bridge
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "[bridge-dev] Starting in background: npm run dev"
    echo "[bridge-dev] Log file: $LOG_FILE"
    nohup npm run dev >>"$LOG_FILE" 2>&1 &
    if pid="$(wait_for_lock_ready)"; then
      echo "[bridge-dev] Started PID $pid"
      exit 0
    fi
    echo "[bridge-dev] Warning: lock file not ready yet, please check logs: $LOG_FILE"
    exit 1
    ;;
  -h | --help | help)
    cat <<'EOF'
用法: scripts/bridge-dev.sh [命令]

  (默认) restart|dev|run   先尝试停止已有实例，再执行 npm run dev
  stop                    仅停止（按锁文件 PID 发 SIGTERM）
  status                  是否运行（读锁文件）；未运行则 exit 1
  -h, --help              帮助

环境变量 BRIDGE_SINGLE_INSTANCE_LOCK 可覆盖锁文件路径（与桥接程序一致）。
环境变量 BRIDGE_DEV_LOG_FILE 可覆盖后台日志路径。
EOF
    ;;
  *)
    echo "未知命令: $cmd （见 scripts/bridge-dev.sh --help）" >&2
    exit 1
    ;;
esac
