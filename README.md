# feishu-cursor-bridge

> Standalone service that controls the Cursor AI Agent via a Feishu bot. The bridge runs as an **ACP Client**, spawning Cursor’s official **`agent acp`** by default; optional **`ACP_BACKEND=legacy`** runs the in-repo **`cursor-agent-acp/`** stdio adapter (see [docs/third-party.md](docs/third-party.md) for provenance only).

**[中文文档](#中文文档)**

---

## Features

- Forward Feishu messages to Cursor (default path: official `agent acp`)
- Stream replies to Feishu (interactive cards: answer, thinking, tools, plan, etc.)
- Per-user session isolation (DM / group chat maps to ACP `sessionId` per user)
- **Multiple sessions**: up to **5** concurrent sessions per user per chat, each with its own context and workspace; `/switch` between them; inactive sessions keep their ACP connection
- **Max live sessions per user**: default **10** across all DMs / groups / threads (tune with `BRIDGE_MAX_SESSIONS_PER_USER`; `0` means unlimited), reducing idle ACP connection buildup when idle timeout is infinite
- Group chats: @ the bot (or no @ when “only one human + the bot”); DMs: talk directly
- Built-in commands: `/new`, `/sessions`, `/switch`, `/close` (incl. `/close all`), `/rename` (incl. shortcuts like `/new list`, `/new <index>`), `/status`, `/mode`, `/model`; **`/topic` + text** is display-only (not sent to the Agent — see `docs/feishu-commands.md`)
- Persistent Feishu ↔ ACP mapping: after restart, if the Agent reports `loadSession`, `session/load` can recover
- **CLI resume ID (`legacy` / in-repo adapter only)**: with `ACP_BACKEND=legacy`, `/status` shows the CLI chat id for the active session; official ACP does not expose an equivalent field today

## Architecture

```
Feishu user ──(WebSocket)──> FeishuBot ──> Bridge
                                              │
                   ConversationService / FeishuCardState
                                              │
                   @agentclientprotocol/sdk ClientSideConnection
                                              │
                   stdio NDJSON ──> agent acp child (default) / in-repo cursor-agent-acp (`legacy`) ──> Cursor
```

- **Feishu layer**: `src/feishu-bot.ts` (SDK + message I/O only)
- **ACP runtime**: `src/acp/runtime.ts` + `src/acp/feishu-bridge-client.ts` (Client: permissions, sandbox read/write, normalized `session/update`)
- **Orchestration**: `src/bridge.ts`, `src/conversation-service.ts`
- **Sessions**: `src/session-manager.ts` + `src/session-store.ts`

## Prerequisites

1. **Node.js 18+**
2. **Cursor CLI / Agent CLI** installed (`agent` on PATH, logged in); if you use **`ACP_BACKEND=legacy`**, the in-repo adapter still shells out to **`cursor-agent`** — keep it on PATH
3. Feishu enterprise app: bot, `im:message`, **`im:message.group_msg`** (required for group messages), `im:message:send_as_bot`, `im:chat`; for “one user + bot” no-@ logic, grant read chat / member APIs as needed (`im:chat` related)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env

npm run dev
# (`tsx src/index.ts`: with ACP_BACKEND=legacy, the adapter defaults to cursor-agent-acp sources via tsx—no build:adapter loop)
# or
npm run build && npm start

# Debug: stop other instances before dev (single-instance lock)
# ./scripts/bridge-dev.sh
# npm run dev:restart
```

### Auto-start (`service.sh`)

The same **`bash service.sh`** script supports **macOS** (`launchd`) and **Linux with systemd** (e.g. **Ubuntu**): **`npm install` + `npm run build`**, then install a user service and start it. The process runs **`node dist/index.js`** with **`WorkingDirectory`** = repo root (`.env` is loaded by `dotenv`).

#### macOS (launchd)

Same idea as **feishu-cursor-claw**: plist at **`~/Library/LaunchAgents/com.feishu-cursor-bridge.plist`**, **`RunAtLoad`**, **`KeepAlive`**. Logs: **`/tmp/feishu-cursor-bridge.log`**. **`stop`** uses **`launchctl bootout`** (unloads the job but keeps the plist); killing only the process would respawn it immediately because of **`KeepAlive`**.

#### Linux / Ubuntu (`systemd --user`)

User unit: **`~/.config/systemd/user/feishu-cursor-bridge.service`**, **`Restart=always`**. Logs: **`journalctl --user -u feishu-cursor-bridge.service`** (also **`bash service.sh logs`**).

To start the user service **at boot without an interactive login**, run once: **`sudo loginctl enable-linger "$USER"`** (optional).

```bash
bash service.sh install    # npm install + build + install + start
bash service.sh status
bash service.sh logs       # macOS: follow log file; Linux: journalctl -f
```

| Command | Description |
|---------|-------------|
| `bash service.sh install` | `npm install` + `npm run build`, then install auto-start and launch |
| `bash service.sh uninstall` | Remove auto-start and stop |
| `bash service.sh start` | Start |
| `bash service.sh stop` | Stop |
| `bash service.sh restart` | Restart |
| `bash service.sh status` | Status |
| `bash service.sh logs` | Live logs |

After code changes, run `npm run build` then **`bash service.sh restart`**; or **`bash service.sh install`** again to refresh deps, rebuild, and rewrite the plist / unit. If you change the Node binary path, re-run **`bash service.sh install`**.

### Docker dev setup

The repo ships a **development** Docker stack under `docker/`: `docker/Dockerfile.dev`, `docker/compose.yaml`, `docker/dev-entrypoint.sh`. It does **not** reinstall Cursor Agent in the image; it **bind-mounts** these host paths:

- `/home/liuyang/.local/bin`
- `/home/liuyang/.local/share/cursor-agent`
- `/home/liuyang/.cursor`
- `/home/liuyang/.config/Cursor`
- `/home/liuyang/.feishu-cursor-bridge`
- `/home/liuyang/Documents`

So the container can call the host’s logged-in `agent acp` / `cursor agent` and use your workspaces and local session store.

First run:

```bash
cp .env.example .env
# Edit .env
docker-compose -f docker/compose.yaml up --build
```

Common commands:

```bash
docker-compose -f docker/compose.yaml up -d
docker-compose -f docker/compose.yaml restart
docker-compose -f docker/compose.yaml logs -f bridge-dev
docker-compose -f docker/compose.yaml down
```

### tmux backend smoke tests (Docker)

Two **one-off** smoke services validate the `tmux` backend inside the container without touching a live Feishu bridge:

```bash
# Basic: newSession -> prompt -> server restart -> loadSession -> prompt -> closeSession
docker-compose -f docker/compose.yaml run --rm tmux-acp-smoke

# Cancel: session/cancel -> stopReason: cancelled
docker-compose -f docker/compose.yaml run --rm tmux-acp-cancel-smoke
```

Notes:

- This compose targets **local Linux dev**; host paths are hard-coded as `/home/liuyang/...` — edit `docker/compose.yaml` bind mounts if your machine differs.
- Workspace path in the container matches the host: `/home/liuyang/Documents/feishu-cursor-bridge`, so absolute paths in `.env` often need no change.
- Dependencies live in Docker volume `bridge_node_modules`; `package-lock.json` changes trigger `npm install` on container start.
- `docker/Dockerfile.dev` includes `tmux`, so smoke can exercise `ACP_BACKEND=tmux`; smokes do not hold a Feishu long connection — backend regression only.

## Network & proxy

- By default the service talks to Feishu APIs and the long-connection gateway **directly**; no proxy is required.
- If the host must use a proxy, set `https_proxy` / `http_proxy` / `all_proxy`; the Feishu long connection reuses them.
- For WebSocket-specific proxy, set `wss_proxy` / `ws_proxy` (they override `https_proxy` / `http_proxy`).
- When any of these is set, the service sets `NODE_USE_ENV_PROXY=1` for child processes so `agent` / `cursor-agent` use the same proxy (manual runs and `systemd` both apply).
- With no proxy env vars, traffic stays direct.
- If you use `systemd --user`, put proxy vars in the `.env` the unit loads (or `Environment=` / `EnvironmentFile=`), not only in an interactive shell; the service does not inherit login shells.
- For **launchd** / **systemd --user** (`service.sh`), proxy settings in the project **`.env`** are loaded by the app; the service manager still does not inherit your interactive shell.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FEISHU_APP_ID` | Feishu App ID (required) | — |
| `FEISHU_APP_SECRET` | Feishu App Secret (required) | — |
| `FEISHU_DOMAIN` | `feishu` / `lark` / custom URL | `feishu` |
| `ACP_BACKEND` | ACP backend: `official` / `legacy` / `tmux` | `official` |
| `CURSOR_AGENT_PATH` | Official ACP command path | `agent` |
| `CURSOR_API_KEY` | Official ACP API key (optional) | empty |
| `CURSOR_AUTH_TOKEN` | Official ACP auth token (optional) | empty |
| `CURSOR_WORK_DIR` | Workspace absolute path (ACP `cwd`, sandbox root) | cwd |
| `ACP_NODE_PATH` | Node binary used to spawn **in-repo** `cursor-agent-acp` (`legacy` only) | `process.execPath` |
| `CURSOR_ACP_SESSION_DIR` | Passed to `cursor-agent-acp` as `--session-dir` (`legacy` only) | `~/.feishu-cursor-bridge/cursor-acp-sessions` |
| `CURSOR_ACP_EXTRA_ARGS` | Extra args for `cursor-agent-acp` CLI (`legacy` only, space-separated) | empty |
| `BRIDGE_SESSION_STORE` | Feishu ↔ ACP mapping JSON path | `~/.feishu-cursor-bridge/.feishu-bridge-sessions.json` |
| `SESSION_IDLE_TIMEOUT_MS` | Idle before new session; `0` / `infinity` = never | `604800000` (7 days) |
| `BRIDGE_MAX_SESSIONS_PER_USER` | Max live sessions per user (all chats); `0` = unlimited | `10` |
| `BRIDGE_SINGLE_INSTANCE_LOCK` | Single-instance lock file (refuse start if PID alive) | `~/.feishu-cursor-bridge/bridge.lock` |
| `BRIDGE_ALLOW_MULTIPLE_INSTANCES` | `true` disables single-instance lock (debug only) | `false` |
| `FEISHU_CARD_THROTTLE_MS` | Card update throttle | `800` |
| `FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD` | Roll over to a new card when a card gets this long | `3500` |
| `FEISHU_CARD_SPLIT_TOOL_THRESHOLD` | Roll over to a new card when tool rows exceed this count | `8` |
| `AUTO_APPROVE_PERMISSIONS` | Auto-pick allow-style permission options | `true` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `BRIDGE_DEBUG` | Verbose logs + `/status` details | `false` |
| `EXPERIMENT_LOG_TO_FILE` | Experimental: append `console.*` to file | `false` |
| `EXPERIMENT_LOG_FILE` | Experimental log path | `~/.feishu-cursor-bridge/logs/bridge.log` |

Proxy precedence: `wss_proxy` / `ws_proxy` > `https_proxy` / `http_proxy` / `all_proxy`. Proxy is used only when env vars are set; otherwise direct.

## Usage

- **DM**: send a message directly
- **Group**: @ the bot + content ( **`im:message.group_msg`** must be enabled or group events won’t arrive); in **topic** groups, each `thread_id` maps to its own ACP session (not shared with the main group chat)
- **Multi-session**: `/new` creates and switches (old session stays connected); `/sessions` lists; `/switch <index or name>` switches active (no arg → last used); `/close` closes one; `/rename` helps name-based switching. Full syntax: `docs/feishu-commands.md`
- `/status` or `/状态`: session stats, always shows ACP backend; `official` / `legacy` also show known mode for the active session; `tmux` does not show a bridge-faked mode; **legacy** adds CLI resume ID for the active slot; with `BRIDGE_DEBUG=true`, adds ACP `sessionId`, paths, modes, etc.
- `/mode <id>`: `official` / `legacy` use ACP `session/set_mode`; `tmux` forwards `/mode ...` verbatim to the real Cursor CLI pane
- `/model <id>`: `legacy` / `official` use ACP `session/set_model` (`official` follows selector from ACP); `tmux` forwards to CLI pane; only `official` supports bridge-side `/model <index>`

## Manual smoke checklist

1. `npm run build` succeeds
2. DM once — card shows an “answer” block
3. Multi-turn — same session reused (`BRIDGE_DEBUG`: stable `sessionId`)
4. With multiple `/new` sessions, `/switch` keeps contexts independent
5. When tools run, card “tools” updates (depends on Agent output)
6. `/status` shows backend + mode; with `BRIDGE_DEBUG=true`, `sessionId` / workspace, etc.; **CLI resume ID** appears only with `ACP_BACKEND=legacy`

## Tech stack

- **Cursor `agent acp`** — default ACP server
- **`cursor-agent-acp/`** — in-repo stdio adapter when `ACP_BACKEND=legacy` ([provenance](docs/third-party.md))
- **[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)** — ACP client types + connection
- **@larksuiteoapi/node-sdk** — Feishu long connection + message API
- **TypeScript + Node.js**

## Backend strategy

- Default: **`agent acp`** (official).
- Optional: **`ACP_BACKEND=legacy`** uses the embedded **`cursor-agent-acp/`** adapter (stdio + `cursor-agent`).
- Protocol follows the SDK; events cover thinking, tools, plan, mode, etc., folded by `FeishuCardState`.

---

# 中文文档

## 这是什么

独立服务，通过飞书机器人控制 Cursor AI Agent。桥接进程作为 **ACP Client**，默认子进程运行 Cursor 官方 **`agent acp`**；也可设 **`ACP_BACKEND=legacy`** 使用本仓库内 **`cursor-agent-acp/`**（stdio 适配器）。历史参考说明见 [docs/third-party.md](docs/third-party.md)，**不维护与外部 npm 包一致**。

## 功能特性

- 飞书消息转发至 Cursor（默认经官方 `agent acp`）
- 回复流式推送到飞书（interactive 卡片，含回答、思考、工具、计划等区块）
- 多用户会话隔离（私聊 / 群聊按用户维度映射 ACP `sessionId`）
- **多 session**：同一用户在同一聊天中可同时持有多个 session（最多 5 个），各自独立上下文与工作区；可用 `/switch` 在它们之间切换，未活跃的 session 仍保持 ACP 连接
- **每用户存活 session 上限**：同一飞书用户跨所有私聊/群/话题的存活 session 总数默认最多 **10**（可用 `BRIDGE_MAX_SESSIONS_PER_USER` 调整；`0` 表示不限制），避免将空闲过期设为无限时进程堆积过多 ACP 连接
- 群聊 @ 机器人触发（或满足「仅 1 用户 + 1 机器人」时可免 @）；私聊直接对话
- 内置命令：`/new`、`/sessions`、`/switch`、`/close`（含 `/close all`）、`/rename`（含快捷列表 `/new list`、`/new <序号>` 等）、`/status`、`/mode`、`/model`；另有 **`/topic` + 话题内容** 的纯展示命令（不发给 Agent，见 `docs/feishu-commands.md`）
- 会话映射持久化：进程重启后若 Agent 声明 `loadSession`，可 `session/load` 恢复
- **CLI resume ID（legacy only）**：若切到 `ACP_BACKEND=legacy`，`/status` 会展示当前活跃 session 对应的 CLI chat id；官方 ACP 当前未暴露等价字段

## 架构

```
飞书用户 ──(WebSocket)──> FeishuBot ──> Bridge
                                           │
                    ConversationService / FeishuCardState
                                           │
                    @agentclientprotocol/sdk ClientSideConnection
                                           │
                    stdio NDJSON ──> agent acp 子进程（默认） / 本仓 cursor-agent-acp（`legacy`） ──> Cursor
```

- **飞书层**：`src/feishu-bot.ts`（仅 SDK 与消息收发）
- **ACP 运行时**：`src/acp/runtime.ts` + `src/acp/feishu-bridge-client.ts`（实现 Client：权限、沙箱读写、`session/update` 归一化）
- **编排**：`src/bridge.ts`、`src/conversation-service.ts`
- **会话**：`src/session-manager.ts` + `src/session-store.ts`

## 前置条件

1. **Node.js 18+**
2. 已安装 **Cursor CLI / Agent CLI**（`agent` 在 PATH 中，并已完成登录；若使用 **`ACP_BACKEND=legacy`**，内嵌适配器会调用 **`cursor-agent`**，需本机可用）
3. 飞书企业自建应用：机器人、`im:message`、**`im:message.group_msg`**（群聊收消息必需）、`im:message:send_as_bot`、`im:chat`；若使用「仅 1 用户 + 1 机器人」免 @ 等需拉群信息的逻辑，还需按需开通 `im:chat` 相关只读权限（如查看群成员）

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env

npm run dev
# （`tsx src/index.ts`：若 .env 中 ACP_BACKEND=legacy，本仓 cursor-agent-acp 默认以 tsx 跑源码，改适配器无需先 npm run build:adapter）
# 或
npm run build && npm start

# 调试：先结束已有实例再起 dev（与单实例锁配合，避免多进程）
# ./scripts/bridge-dev.sh
# npm run dev:restart
```

### 开机自启（`service.sh`：macOS launchd / Linux systemd）

同一脚本在 **macOS** 使用 **launchd**，在 **systemd** 的 Linux（如 **Ubuntu**）使用 **`systemctl --user`**：先 **`npm install`**、**`npm run build`**，再注册用户级服务并启动。进程在仓库根目录运行 **`node dist/index.js`**（**`.env`** 由 `dotenv` 加载）。

#### macOS（launchd）

与 feishu-cursor-claw 同类：**`~/Library/LaunchAgents/com.feishu-cursor-bridge.plist`**，**`RunAtLoad`** + **`KeepAlive`**。日志：**`/tmp/feishu-cursor-bridge.log`**。**`stop`** 使用 **`launchctl bootout`**（卸载任务、保留 plist）；若只杀进程，**`KeepAlive`** 会让 launchd 立刻再拉起进程。

#### Linux / Ubuntu（`systemd --user`）

用户单元：**`~/.config/systemd/user/feishu-cursor-bridge.service`**，**`Restart=always`**。日志：**`journalctl --user -u feishu-cursor-bridge.service`**（或 **`bash service.sh logs`**）。

若要在**未登录图形会话时**仍随开机启动当前用户的单元，可执行一次：**`sudo loginctl enable-linger "$USER"`**（可选）。

```bash
bash service.sh install    # npm install + build + 安装并启动
bash service.sh status
bash service.sh logs       # macOS：跟日志文件；Linux：journalctl -f
```

| 命令 | 说明 |
|------|------|
| `bash service.sh install` | `npm install` + `npm run build` + 安装自启动并启动 |
| `bash service.sh uninstall` | 卸载自启动并停止 |
| `bash service.sh start` | 启动 |
| `bash service.sh stop` | 停止 |
| `bash service.sh restart` | 重启 |
| `bash service.sh status` | 状态 |
| `bash service.sh logs` | 实时日志 |

代码更新后可 `npm run build` 再 **`bash service.sh restart`**；也可再次 **`bash service.sh install`** 以更新依赖、重建并**重写 plist / systemd unit**。更换 Node 路径后请重新 **`bash service.sh install`**。

### Docker 开发联调

仓库内提供了一套**开发联调**用的 Docker 配置，集中放在 `docker/` 目录：`docker/Dockerfile.dev`、`docker/compose.yaml`、`docker/dev-entrypoint.sh`。它不会在镜像里重新安装 Cursor Agent，而是**直接复用宿主机**上的以下目录：

- `/home/liuyang/.local/bin`
- `/home/liuyang/.local/share/cursor-agent`
- `/home/liuyang/.cursor`
- `/home/liuyang/.config/Cursor`
- `/home/liuyang/.feishu-cursor-bridge`
- `/home/liuyang/Documents`

这样容器里的 bridge 可以直接调用宿主机已登录的 `agent acp` / `cursor agent`，也能继续访问你的工作区与本地 session store。

首次使用：

```bash
cp .env.example .env
# 编辑 .env
docker-compose -f docker/compose.yaml up --build
```

常用命令：

```bash
docker-compose -f docker/compose.yaml up -d
docker-compose -f docker/compose.yaml restart
docker-compose -f docker/compose.yaml logs -f bridge-dev
docker-compose -f docker/compose.yaml down
```

### Docker 中验证 tmux backend

当前仓库还提供了两个**一次性 smoke 服务**，用于在不影响宿主机正在运行的飞书 bridge 的情况下，单独验证容器内的 `tmux` backend：

```bash
# 基本链路：newSession -> prompt -> server 重启 -> loadSession -> prompt -> closeSession
docker-compose -f docker/compose.yaml run --rm tmux-acp-smoke

# 取消链路：session/cancel -> stopReason: cancelled
docker-compose -f docker/compose.yaml run --rm tmux-acp-cancel-smoke
```

说明：

- 该 compose 面向**本机 Linux 开发联调**，当前宿主机路径按 `/home/liuyang/...` 写死；若换机器，请同步修改 `docker/compose.yaml` 中的 bind mount。
- 容器内工作目录与宿主机保持一致：`/home/liuyang/Documents/feishu-cursor-bridge`，因此现有 `.env` 里的工作区绝对路径通常无需额外改写。
- 依赖安装在 Docker volume `bridge_node_modules` 中；`package-lock.json` 变化后，容器启动时会自动重新执行 `npm install`。
- `docker/Dockerfile.dev` 现已安装 `tmux`，因此 smoke 服务可直接验证 `ACP_BACKEND=tmux` 路径；这两个 smoke 服务不会占用飞书 bot 长连接，只用于容器内的 backend 回归。

## 网络与代理

- 默认情况下服务会**直接连接**飞书接口与长连接网关，不要求必须配置代理。
- 若机器无法直接访问外网、只能通过代理访问飞书，可设置环境变量 `https_proxy` / `http_proxy` / `all_proxy`；飞书长连接也会自动复用这些代理配置。
- 若需为 WebSocket 单独指定代理，也可设置 `wss_proxy` / `ws_proxy`；其优先级高于 `https_proxy` / `http_proxy`。
- 检测到上述任一代理变量时，服务会自动为子进程补上 `NODE_USE_ENV_PROXY=1`，使 `agent` / `cursor-agent` 等子进程也走环境代理；手动启动与 `systemd` 服务均适用。
- 若未设置任何代理变量，则保持直连模式。
- 若使用 `systemd --user` 运行服务，请把代理变量写进该服务读取的 `.env`（或 unit 的 `Environment=` / `EnvironmentFile=`），不要只写在交互式 shell 配置里；服务不会自动继承登录 shell 的环境。
- 使用 **launchd** / **systemd --user**（`service.sh`）时，项目 **`.env`** 会被进程加载；服务管理环境同样不会继承交互式 shell。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书 App ID（必填） | - |
| `FEISHU_APP_SECRET` | 飞书 App Secret（必填） | - |
| `FEISHU_DOMAIN` | `feishu` / `lark` / 自定义 URL | `feishu` |
| `ACP_BACKEND` | ACP 后端：`official` / `legacy` / `tmux` | `official` |
| `CURSOR_AGENT_PATH` | 官方 ACP 命令路径 | `agent` |
| `CURSOR_API_KEY` | 官方 ACP API key（可选） | 空 |
| `CURSOR_AUTH_TOKEN` | 官方 ACP auth token（可选） | 空 |
| `CURSOR_WORK_DIR` | 工作区绝对路径（ACP `cwd`、读文件沙箱根） | 当前目录 |
| `ACP_NODE_PATH` | 用于启动本仓 `cursor-agent-acp` 子进程的 Node（仅 `legacy`） | `process.execPath` |
| `CURSOR_ACP_SESSION_DIR` | 传给 `cursor-agent-acp` 的 `--session-dir`（仅 `legacy`） | `~/.feishu-cursor-bridge/cursor-acp-sessions` |
| `CURSOR_ACP_EXTRA_ARGS` | 透传 `cursor-agent-acp` CLI 的额外参数（仅 `legacy`，空格分隔） | 空 |
| `BRIDGE_SESSION_STORE` | 飞书↔ACP 映射 JSON 路径 | `~/.feishu-cursor-bridge/.feishu-bridge-sessions.json` |
| `SESSION_IDLE_TIMEOUT_MS` | 空闲多久新建会话；`0` / `infinity` 表示永不过期 | `604800000`（7 天） |
| `BRIDGE_MAX_SESSIONS_PER_USER` | 同一用户存活 session 总数上限（跨聊天）；`0` 不限制 | `10` |
| `BRIDGE_SINGLE_INSTANCE_LOCK` | 单实例锁文件路径（已存在且 PID 存活则拒绝启动） | `~/.feishu-cursor-bridge/bridge.lock` |
| `BRIDGE_ALLOW_MULTIPLE_INSTANCES` | `true` 时禁用单实例锁（仅调试） | `false` |
| `FEISHU_CARD_THROTTLE_MS` | 卡片更新节流 | `800` |
| `FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD` | 单张卡片内容达到该长度后滚动到下一张 | `3500` |
| `FEISHU_CARD_SPLIT_TOOL_THRESHOLD` | 单张卡片工具条目超过该数量后滚动到下一张 | `8` |
| `AUTO_APPROVE_PERMISSIONS` | 自动选择允许类权限选项 | `true` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `BRIDGE_DEBUG` | 调试日志与 `/status` 详情 | `false` |
| `EXPERIMENT_LOG_TO_FILE` | 实验参数：是否把 `console.*` 追加写入日志文件 | `false` |
| `EXPERIMENT_LOG_FILE` | 实验参数：日志文件路径 | `~/.feishu-cursor-bridge/logs/bridge.log` |

代理相关说明：
`wss_proxy` / `ws_proxy` > `https_proxy` / `http_proxy` / `all_proxy`。仅在环境变量存在时才启用代理，否则默认直连。

## 使用方式

- **私聊**：直接发消息
- **群聊**：@机器人 + 内容（开发平台须为应用开通 **`im:message.group_msg`**，否则群消息事件不会投递到机器人）；**话题群**内不同话题（`thread_id`）会**分别**映射 ACP 会话，与群主页会话互不共享
- **多 session 切换**：`/new` 新建并切到该 session（旧 session 保持连接）；`/sessions` 列表；`/switch <编号或名称>` 切换活跃 session（无参数时切到上一次用过的）；`/close` 关闭指定；`/rename` 便于用名称切换。完整语法与快捷列表见 `docs/feishu-commands.md`
- `/status` 或 `/状态`：会话统计，始终展示当前 ACP 后端；`official` / `legacy` 下还会展示当前活跃 session 已知 mode，`tmux` 下不再显示 bridge 侧伪造的 mode；若是 `legacy`，会额外显示当前活跃 slot 的 CLI resume ID；`BRIDGE_DEBUG=true` 时额外含 ACP `sessionId`、路径、可用模式等调试信息
- `/mode <模式ID>`：`official` / `legacy` 下通过 ACP `session/set_mode` 切换当前活跃 session 的 mode；`tmux` 下则把 `/mode ...` 原样发给真实 Cursor CLI pane，由 CLI 自己处理
- `/model <模型ID>`：`legacy` / `official` 后端下通过 ACP `session/set_model` 切换当前活跃 session 的模型；其中 `official` 以当前 ACP session 返回的 selector 为准；`tmux` 后端下则把 `/model ...` 原样发给真实 Cursor CLI pane，由 CLI 自己处理；仅 `official` 支持桥接侧 `/model <序号>`

## 最小验证清单（手工）

1. `npm run build` 通过
2. 私聊发送一条消息，卡片出现「回答」区块
3. 连续多轮对话，确认复用同一会话（`BRIDGE_DEBUG` 下 sessionId 不变）
4. 若已用 `/new` 建多个 session，可用 `/switch` 在编号间切换且各 session 独立
5. 触发工具调用时，卡片「工具」列表有更新（视 Agent 输出而定）
6. 发送 `/status`，确认显示当前 ACP 后端与当前 mode；若 `BRIDGE_DEBUG=true`，再确认返回里包含 `sessionId`、工作区路径等调试信息；只有切到 `ACP_BACKEND=legacy` 时，才会额外出现 **CLI resume ID**

## 技术栈

- **Cursor `agent acp`** — 默认 ACP 服务端
- **`cursor-agent-acp/`** — 内嵌 stdio 适配器源码与构建产物（`ACP_BACKEND=legacy`）；溯源见 [docs/third-party.md](docs/third-party.md)。目录内 `package.json` 仅含 `"type":"commonjs"`，避免根目录 `"type":"module"` 将 `dist/*.js` 误判为 ESM
- **[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)** — 官方 ACP Client 连接与类型
- **@larksuiteoapi/node-sdk** — 飞书长连接与消息 API
- **TypeScript + Node.js**

## 当前后端策略

- 默认使用 **`agent acp` 官方后端**。
- 可选 **`ACP_BACKEND=legacy`**：使用本仓库内 **`cursor-agent-acp/`**（不依赖外部 npm 包）。
- 协议实现以 SDK 为准，事件面覆盖思考、工具、计划、模式等，并由 `FeishuCardState` 折叠展示。
