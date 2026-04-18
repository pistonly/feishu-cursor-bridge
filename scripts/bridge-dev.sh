#!/usr/bin/env bash
# 本地调试：默认「先结束已有桥接进程再起 dev」，避免多实例；依赖 ~/.feishu-cursor-bridge/bridge.lock（与程序一致）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [[ -z "$NPM_BIN" ]]; then
  echo "❌ 未找到 npm，请先安装 Node.js/npm。"
  exit 1
fi

SCRIPT_CONFIG_CMD=("$NPM_BIN" exec -- tsx src/script-config-cli.ts get)
get_script_config() {
  local key="$1"
  (cd "$ROOT" && "${SCRIPT_CONFIG_CMD[@]}" "$key")
}

LOCK_FILE_DEFAULT="$HOME/.feishu-cursor-bridge/bridge.lock"
LOG_FILE_DEFAULT="$HOME/.feishu-cursor-bridge/logs/bridge-dev.log"
LOCK_FILE="${BRIDGE_SINGLE_INSTANCE_LOCK:-$(get_script_config singleInstanceLockPath 2>/dev/null || printf '%s' "$LOCK_FILE_DEFAULT")}"
LOG_FILE="${BRIDGE_DEV_LOG_FILE:-$(get_script_config bridgeDevLogPath 2>/dev/null || printf '%s' "$LOG_FILE_DEFAULT")}"
SERVICE_SCRIPT="$ROOT/service.sh"
UNAME_S="$(uname -s)"
LAUNCHD_LABEL="com.feishu-cursor-bridge"
SYSTEMD_UNIT="feishu-cursor-bridge.service"

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

managed_service_loaded() {
  case "$UNAME_S" in
    Darwin)
      launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1
      ;;
    Linux)
      command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$SYSTEMD_UNIT"
      ;;
    *)
      return 1
      ;;
  esac
}

stop_managed_service_if_needed() {
  [[ -f "$SERVICE_SCRIPT" ]] || return 0
  if ! managed_service_loaded; then
    return 0
  fi

  echo "[bridge-dev] Managed service is running; stopping it before starting dev ..."
  bash "$SERVICE_SCRIPT" stop
  sleep 1
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
    stop_managed_service_if_needed
    stop_bridge
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "[bridge-dev] Starting in background: npm run dev"
    echo "[bridge-dev] Log file: $LOG_FILE"
    nohup "$NPM_BIN" run dev >>"$LOG_FILE" 2>&1 &
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

  (默认) restart|dev|run   先停止正式服务与已有实例，再执行 npm run dev
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
