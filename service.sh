#!/bin/bash
# feishu-cursor-bridge 服务管理
# macOS: launchd（~/Library/LaunchAgents/）
# Linux: systemd --user（~/.config/systemd/user/）
# 用法: bash service.sh [install|update|uninstall|start|stop|restart|status|logs]
set -e

UNAME_S="$(uname -s)"
LABEL_LAUNCHD="com.feishu-cursor-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL_LAUNCHD.plist"
UNIT_NAME="feishu-cursor-bridge.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOTENV_FILE="$BOT_DIR/.env"
LOG_FILE_MACOS="/tmp/feishu-cursor-bridge.log"
ENTRY_JS="$BOT_DIR/dist/index.js"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "❌ 未找到 node，请先安装 Node.js 并确保在 PATH 中，再运行本脚本。"
    exit 1
fi

NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
    NPM_CAND="$(dirname "$NODE_BIN")/npm"
    if [[ -x "$NPM_CAND" ]]; then
        NPM_BIN="$NPM_CAND"
    fi
fi
if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
    echo "❌ 未找到 npm（与 node 同目录或 PATH 中），请先安装 Node.js/npm。"
    exit 1
fi

service_path_linux() {
    # Linux：供子进程找到 cursor agent 等
    echo "$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
}

service_path_macos() {
    echo "$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s\n' "$value"
}

strip_matching_quotes() {
    local value="$1"
    if [[ ${#value} -ge 2 ]]; then
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
            value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
            value="${value:1:${#value}-2}"
        fi
    fi
    printf '%s\n' "$value"
}

dotenv_get_value_fallback() {
    local key="$1"
    [[ -f "$DOTENV_FILE" ]] || return 1

    local value
    value="$(awk -v key="$key" '
        BEGIN {
            pattern = "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*="
        }
        $0 ~ pattern {
            raw = $0
            sub(pattern, "", raw)
            value = raw
            found = 1
        }
        END {
            if (!found) exit 1
            print value
        }
    ' "$DOTENV_FILE")" || return 1

    value="$(trim_whitespace "$value")"
    value="$(strip_matching_quotes "$value")"
    printf '%s\n' "$value"
}

dotenv_get_value() {
    local key="$1"
    [[ -f "$DOTENV_FILE" ]] || return 1

    local value
    if value="$("$NODE_BIN" --input-type=module -e '
        import fs from "node:fs";

        const [key, envFile] = process.argv.slice(1);

        try {
          const dotenv = await import("dotenv");
          const parsed = dotenv.parse(fs.readFileSync(envFile));
          if (!(key in parsed)) process.exit(1);
          process.stdout.write(parsed[key]);
        } catch (error) {
          process.exit(2);
        }
    ' "$key" "$DOTENV_FILE" 2>/dev/null)"; then
        printf '%s\n' "$value"
        return 0
    fi

    dotenv_get_value_fallback "$key"
}

expand_home_path() {
    local p="$1"
    if [[ "$p" == "~/"* ]]; then
        printf '%s\n' "$HOME/${p#\~/}"
    else
        printf '%s\n' "$p"
    fi
}

resolve_path_like_app() {
    local raw_path="$1"
    local expanded
    expanded="$(expand_home_path "$raw_path")"

    "$NODE_BIN" --input-type=module -e '
        import path from "node:path";

        const [baseDir, targetPath] = process.argv.slice(1);
        process.stdout.write(path.resolve(baseDir, targetPath));
    ' "$BOT_DIR" "$expanded"
}

print_app_log_config() {
    local default_app_log="$HOME/.feishu-cursor-bridge/logs/bridge.log"
    local enabled_raw enabled_lower app_log_raw app_log_path

    enabled_raw="$(dotenv_get_value "EXPERIMENT_LOG_TO_FILE" 2>/dev/null || true)"
    app_log_raw="$(dotenv_get_value "EXPERIMENT_LOG_FILE" 2>/dev/null || true)"
    if [[ -n "$app_log_raw" ]]; then
        app_log_path="$(resolve_path_like_app "$app_log_raw")"
    else
        app_log_path="$default_app_log"
    fi

    if [[ ! -f "$DOTENV_FILE" ]]; then
        echo "  🧪 应用日志(.env): 未检测到 $DOTENV_FILE（默认关闭；启用后路径: $app_log_path）"
        return
    fi

    enabled_lower="$(printf '%s' "${enabled_raw:-false}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$enabled_lower" == "true" ]]; then
        echo "  🧪 应用日志(.env): 已启用 -> $app_log_path"
    else
        echo "  🧪 应用日志(.env): 未启用（EXPERIMENT_LOG_TO_FILE=${enabled_raw:-false}；启用后路径: $app_log_path）"
    fi
}

plist_extract_raw() {
    local key="$1"
    [[ -f "$PLIST" ]] || return 1
    plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null
}

plist_needs_refresh() {
    [[ -f "$PLIST" ]] || return 0

    local plist_node plist_entry plist_workdir
    plist_node="$(plist_extract_raw "ProgramArguments.0" || true)"
    plist_entry="$(plist_extract_raw "ProgramArguments.1" || true)"
    plist_workdir="$(plist_extract_raw "WorkingDirectory" || true)"

    [[ "$plist_node" != "$NODE_BIN" || "$plist_entry" != "$ENTRY_JS" || "$plist_workdir" != "$BOT_DIR" ]]
}

print_plist_drift() {
    local plist_node plist_entry plist_workdir
    plist_node="$(plist_extract_raw "ProgramArguments.0" || true)"
    plist_entry="$(plist_extract_raw "ProgramArguments.1" || true)"
    plist_workdir="$(plist_extract_raw "WorkingDirectory" || true)"

    [[ "$plist_node" != "$NODE_BIN" ]] && echo "  ⚠️  plist 中的 Node 路径已过期: $plist_node"
    [[ "$plist_entry" != "$ENTRY_JS" ]] && echo "  ⚠️  plist 中的入口路径已过期: $plist_entry"
    [[ "$plist_workdir" != "$BOT_DIR" ]] && echo "  ⚠️  plist 中的工作目录已过期: $plist_workdir"
}

refresh_plist_if_needed() {
    if plist_needs_refresh; then
        echo "  ℹ️  检测到 plist 配置与当前仓库路径或 Node 路径不一致，正在刷新..."
        generate_plist
        return 0
    fi
    return 1
}

launchd_target() {
    echo "gui/$(id -u)/$LABEL_LAUNCHD"
}

launchd_is_loaded() {
    launchctl print "$(launchd_target)" &>/dev/null
}

launchd_print() {
    launchctl print "$(launchd_target)" 2>/dev/null
}

verify_darwin_service_running() {
    local status pid state last_exit
    status="$(launchd_print || true)"
    pid="$(printf '%s\n' "$status" | awk '/pid =/ {print $3; exit}')"

    if [[ -n "$pid" && "$pid" != "0" ]]; then
        echo "  ✅ 服务已启动 (PID: $pid)"
        return 0
    fi

    state="$(printf '%s\n' "$status" | awk -F'= ' '/state =/ {print $2; exit}')"
    last_exit="$(printf '%s\n' "$status" | awk -F'= ' '/last exit code =/ {print $2; exit}')"
    echo "  ❌ 服务未正常运行"
    [[ -n "$state" ]] && echo "  ℹ️  launchd state: $state"
    [[ -n "$last_exit" ]] && echo "  ℹ️  last exit code: $last_exit"
    echo "  📝 查看服务日志: tail -n 100 $LOG_FILE_MACOS"
    return 1
}

generate_plist() {
    cat > "$PLIST" <<PEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL_LAUNCHD</string>

	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$ENTRY_JS</string>
	</array>

	<key>WorkingDirectory</key>
	<string>$BOT_DIR</string>

	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$HOME</string>
		<key>PATH</key>
		<string>$(service_path_macos)</string>
	</dict>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<true/>

	<key>StandardOutPath</key>
	<string>$LOG_FILE_MACOS</string>
	<key>StandardErrorPath</key>
	<string>$LOG_FILE_MACOS</string>

	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
PEOF
    echo "  ✅ plist 已生成: $PLIST"
}

generate_systemd_unit() {
    mkdir -p "$UNIT_DIR"
    local path_env
    path_env="$(service_path_linux)"
    cat > "$UNIT_FILE" <<EOFUNIT
[Unit]
Description=Feishu-Cursor Bridge (ACP)
After=network.target
Wants=network.target

[Service]
Type=simple
WorkingDirectory=$BOT_DIR
ExecStart=$NODE_BIN $BOT_DIR/dist/index.js
Restart=always
RestartSec=3
Environment=HOME=$HOME
Environment=PATH=$path_env

[Install]
WantedBy=default.target
EOFUNIT
    echo "  ✅ systemd 用户单元已生成: $UNIT_FILE"
}

require_systemctl() {
    if ! command -v systemctl &>/dev/null; then
        echo "❌ 未找到 systemctl，请使用已启用 systemd 的 Linux（如 Ubuntu 22.04+）。"
        exit 1
    fi
}

cmd_install_darwin() {
    echo "📦 安装 launchd 自启动（macOS）..."
    generate_plist
    launchctl enable "$(launchd_target)" 2>/dev/null || true
    if launchd_is_loaded; then
        launchctl bootout "$(launchd_target)" 2>/dev/null || true
    fi
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    sleep 1
    verify_darwin_service_running
    echo "  📝 服务日志: tail -f $LOG_FILE_MACOS"
    print_app_log_config
    echo "  💡 Node 路径: $NODE_BIN（切换版本后请重新 install）"
}

cmd_install_linux() {
    require_systemctl
    echo "📦 安装 systemd --user 自启动（Linux）..."
    generate_systemd_unit
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT_NAME"
    systemctl --user restart "$UNIT_NAME" 2>/dev/null || systemctl --user start "$UNIT_NAME"
    echo "  ✅ 服务已启用并启动（systemctl --user）"
    echo "  📝 服务日志: bash service.sh logs   （journalctl --user -u $UNIT_NAME -f）"
    print_app_log_config
    echo "  💡 Node 路径: $NODE_BIN（切换版本后请重新 install）"
    echo "  💡 开机无登录也要启动本用户服务时，需执行一次: sudo loginctl enable-linger \"\$USER\""
}

cmd_uninstall_darwin() {
    echo "🗑  卸载 launchd..."
    launchctl bootout "$(launchd_target)" 2>/dev/null || true
    launchctl disable "$(launchd_target)" 2>/dev/null || true
    rm -f "$PLIST"
    echo "  ✅ 已卸载"
}

cmd_uninstall_linux() {
    require_systemctl
    echo "🗑  卸载 systemd 用户服务..."
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    echo "  ✅ 已卸载"
}

cmd_start_darwin() {
    if [[ ! -f "$PLIST" ]]; then
        echo "  ⚠️  尚未 install（无 plist），先运行: bash service.sh install"
        return
    fi

    if [[ ! -f "$ENTRY_JS" ]]; then
        echo "  ⚠️  未找到 $ENTRY_JS，先运行: bash service.sh update"
        return 1
    fi

    local refreshed=0
    if refresh_plist_if_needed; then
        refreshed=1
    fi

    launchctl enable "$(launchd_target)" 2>/dev/null || true
    if launchd_is_loaded; then
        if [[ "$refreshed" -eq 1 ]]; then
            launchctl bootout "$(launchd_target)" 2>/dev/null || true
            launchctl bootstrap "gui/$(id -u)" "$PLIST"
        else
            launchctl kickstart -k "$(launchd_target)"
        fi
    else
        launchctl bootstrap "gui/$(id -u)" "$PLIST"
    fi
    sleep 1
    verify_darwin_service_running
}

cmd_start_linux() {
    require_systemctl
    if [[ ! -f "$UNIT_FILE" ]]; then
        echo "  ⚠️  服务未安装，先运行: bash service.sh install"
        return
    fi
    systemctl --user start "$UNIT_NAME"
    echo "  ✅ 服务已启动"
}

cmd_stop_darwin() {
    # 勿用 launchctl kill：plist 里 KeepAlive=true 时进程一结束就会被 launchd 立刻拉起。
    # bootout 会卸载该 Job（plist 仍保留），等价于「真正停掉」直到再次 start/bootstrap。
    if ! launchd_is_loaded; then
        echo "  ⚠️  Launch Agent 未载入（可能已 stop，或从未 install）"
        return
    fi
    if launchctl bootout "$(launchd_target)" 2>/dev/null; then
        echo "  ✅ 已停止（已从 launchd 卸载；plist 仍在，可 bash service.sh start 再载入）"
    else
        echo "  ⚠️  bootout 失败（可尝试 bash service.sh status）"
    fi
}

cmd_stop_linux() {
    require_systemctl
    systemctl --user stop "$UNIT_NAME" 2>/dev/null && echo "  ✅ 服务已停止" || echo "  ⚠️  服务未在运行或未安装"
}

cmd_status_darwin() {
    echo "📊 Launch Agent 状态（macOS）:"
    if [[ ! -f "$PLIST" ]]; then
        echo "  ⚪ 未 install（无 plist）"
        echo "  💡 运行 'bash service.sh install' 安装"
        return
    fi
    echo "  📋 标签: $LABEL_LAUNCHD"
    echo "  📁 工作目录: $BOT_DIR"
    echo "  📝 服务日志: $LOG_FILE_MACOS"
    print_app_log_config
    if plist_needs_refresh; then
        print_plist_drift
        echo "  💡 运行 'bash service.sh start' 或 'bash service.sh install' 可自动刷新 plist"
    fi
    if launchd_is_loaded; then
        PID=$(launchd_print | grep 'pid =' | awk '{print $3}')
        if [[ -n "$PID" && "$PID" != "0" ]]; then
            echo "  🟢 运行中 (PID: $PID)"
        else
            echo "  🔴 已载入 launchd，当前进程未运行（异常）"
            local last_exit
            last_exit="$(launchd_print | awk -F'= ' '/last exit code =/ {print $2; exit}')"
            [[ -n "$last_exit" ]] && echo "  ℹ️  last exit code: $last_exit"
        fi
    else
        echo "  🟡 已停止：plist 在，但未载入 launchd（stop 后属正常）"
        echo "  💡 运行 'bash service.sh start' 重新载入并启动"
    fi
}

cmd_status_linux() {
    require_systemctl
    echo "📊 systemd --user 状态（Linux）:"
    if [[ ! -f "$UNIT_FILE" ]]; then
        echo "  ⚪ 未安装"
        echo "  💡 运行 'bash service.sh install' 安装"
        return
    fi
    systemctl --user --no-pager -l status "$UNIT_NAME" || true
    echo "  📁 工作目录: $BOT_DIR"
    echo "  📝 服务日志: journalctl --user -u $UNIT_NAME -n 50 --no-pager"
    print_app_log_config
}

cmd_logs_darwin() {
    if [[ -f "$LOG_FILE_MACOS" ]]; then
        tail -f "$LOG_FILE_MACOS"
    else
        echo "  ⚠️  服务日志文件不存在: $LOG_FILE_MACOS"
    fi
}

cmd_logs_linux() {
    require_systemctl
    journalctl --user -u "$UNIT_NAME" -f --no-pager
}

run_npm_install_and_build() {
    echo "📦 依赖与构建..."
    (cd "$BOT_DIR" && "$NPM_BIN" install && "$NPM_BIN" run build)
    if [[ ! -f "$BOT_DIR/dist/index.js" ]]; then
        echo "❌ 构建失败：未生成 dist/index.js"
        exit 1
    fi
}

cmd_install() {
    run_npm_install_and_build
    case "$UNAME_S" in
        Darwin) cmd_install_darwin ;;
        Linux)  cmd_install_linux ;;
        *)
            echo "❌ 不支持的操作系统: $UNAME_S（仅 macOS / Linux）"
            exit 1
            ;;
    esac
}

# 拉代码或改源码后：重装依赖、编译 dist、再重启，使新代码生效（无需改 plist / systemd 单元时可代替全量 install）
cmd_update() {
    echo "🔄 更新服务（npm install + build + restart）..."
    run_npm_install_and_build
    cmd_restart
}

cmd_uninstall() {
    case "$UNAME_S" in
        Darwin) cmd_uninstall_darwin ;;
        Linux)  cmd_uninstall_linux ;;
        *)
            echo "❌ 不支持的操作系统: $UNAME_S"
            exit 1
            ;;
    esac
}

cmd_start() {
    case "$UNAME_S" in
        Darwin) cmd_start_darwin ;;
        Linux)  cmd_start_linux ;;
        *) echo "❌ 不支持的操作系统: $UNAME_S"; exit 1 ;;
    esac
}

cmd_stop() {
    case "$UNAME_S" in
        Darwin) cmd_stop_darwin ;;
        Linux)  cmd_stop_linux ;;
        *) echo "❌ 不支持的操作系统: $UNAME_S"; exit 1 ;;
    esac
}

cmd_restart() {
    echo "🔄 重启服务..."
    case "$UNAME_S" in
        Darwin)
            cmd_stop_darwin
            sleep 2
            cmd_start_darwin
            ;;
        Linux)
            require_systemctl
            if [[ ! -f "$UNIT_FILE" ]]; then
                echo "  ⚠️  服务未安装，先运行: bash service.sh install"
                return
            fi
            systemctl --user restart "$UNIT_NAME"
            echo "  ✅ 服务已重启"
            ;;
        *)
            echo "❌ 不支持的操作系统: $UNAME_S"
            exit 1
            ;;
    esac
}

cmd_status() {
    case "$UNAME_S" in
        Darwin) cmd_status_darwin ;;
        Linux)  cmd_status_linux ;;
        *) echo "❌ 不支持的操作系统: $UNAME_S"; exit 1 ;;
    esac
}

cmd_logs() {
    case "$UNAME_S" in
        Darwin) cmd_logs_darwin ;;
        Linux)  cmd_logs_linux ;;
        *) echo "❌ 不支持的操作系统: $UNAME_S"; exit 1 ;;
    esac
}

case "${1:-}" in
    install)   cmd_install ;;
    update)    cmd_update ;;
    uninstall) cmd_uninstall ;;
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    *)
        echo "feishu-cursor-bridge 服务管理"
        echo "  macOS → launchd    Linux（Ubuntu 等 / systemd）→ systemctl --user"
        echo ""
        echo "用法: bash service.sh <命令>"
        echo ""
        echo "命令:"
        echo "  install     npm install + build + 安装自启动并启动"
        echo "  update      npm install + build + 重启（已 install 后改代码用此使新版本生效）"
        echo "  uninstall   卸载自启动并停止服务"
        echo "  start       启动服务"
        echo "  stop        停止服务"
        echo "  restart     仅重启进程（不编译；改代码后请用 update 或先 npm run build）"
        echo "  status      查看服务状态"
        echo "  logs        实时日志（macOS: 文件；Linux: journalctl -f）"
        ;;
esac
