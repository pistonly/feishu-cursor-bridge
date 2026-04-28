# feishu-cursor-bridge

> Standalone service that controls multiple ACP backends from a Feishu bot. The bridge runs as an **ACP Client** and can route each session slot to **`cursor-official`**, **`cursor-legacy`**, **`claude`**, or **`codex`**.

**[中文文档](#中文文档)**

---

## Features

- Forward Feishu messages to Cursor (default path: official `agent acp`)
- Stream replies to Feishu (interactive cards: answer, thinking, tools, plan, etc.)
- Session isolation is configurable: DMs always map by user; group chats default to per-user, and can switch to shared group/thread sessions with `BRIDGE_GROUP_SESSION_SCOPE=shared`
- **Multiple sessions**: up to **5** concurrent sessions per chat scope, each with its own context and workspace; by default the scope is "same user in same chat", and with `BRIDGE_GROUP_SESSION_SCOPE=shared` it becomes "same group/thread"; `/switch` between them; inactive sessions keep their ACP connection
- **Max live sessions per user**: default **10** across all DMs / per-user group / per-user thread sessions (tune with `BRIDGE_MAX_SESSIONS_PER_USER`; `0` means unlimited), reducing idle ACP connection buildup when idle timeout is infinite; shared group sessions are managed separately and do not consume the creator's per-user quota
- Group chats: @ the bot (or no @ when “only one human + the bot”); DMs: talk directly
- **Explicit sessions**: set **`BRIDGE_WORK_ALLOWLIST`** (compatible with `CURSOR_WORK_ALLOWLIST`); create a session with `/new list` then `/new <index or path>` before normal chat; bare `/new` lists presets
- Built-in commands: `/new`, `/sessions`, `/switch`, `/close` (incl. `/close all`), `/rename` (incl. `/new list`, `/new <index>`, `/new <path>`), `/status`, `/mode`, `/model`; bridge-native `!<shell command>` is enabled by default, executes in the active session workspace, and is still restricted to admins unless `BRIDGE_ENABLE_BANG_COMMAND=false`; **`/topic` + text** is display-only (not sent to the Agent — see `docs/feishu-commands.md`)
- Persistent Feishu ↔ ACP mapping: after restart, if the Agent reports `loadSession`, `session/load` can recover
- **Recovery metadata**: `/status` shows Cursor legacy CLI resume ID or Claude resume session id when the backend exposes one

## Architecture

```
Feishu user ──(WebSocket)──> FeishuBot ──> Bridge
                                              │
                   ConversationService / FeishuCardState
                                              │
                   @agentclientprotocol/sdk ClientSideConnection
                                              │
                   stdio NDJSON ──> agent acp / cursor-agent-acp / claude-agent-acp / codex-acp
```

- **Feishu layer**: `src/feishu/bot.ts` (SDK + message I/O only)
- **ACP runtime**: `src/acp/runtime.ts` + `src/acp/feishu-bridge-client.ts` (Client: permissions, sandbox read/write, normalized `session/update`)
- **Orchestration**: `src/bridge/bridge.ts`, `src/bridge/conversation-service.ts`
- **Sessions**: `src/session/manager.ts` + `src/session/store.ts`

## Prerequisites

1. **Node.js 18+**
2. Install the runtime(s) you plan to use: Cursor official uses `agent`; `cursor-legacy` still shells out to `cursor-agent`; `claude` uses `claude-agent-acp` / Claude Code authentication; `codex` uses `@zed-industries/codex-acp`. On Linux, confirm `npx -y @zed-industries/codex-acp --help` works on the host first before enabling `codex`; the current tested Linux x64 package requires OpenSSL 3 and `glibc >= 2.34`
3. Feishu enterprise app: bot, `im:message`, **`im:message.group_msg`** (required for group messages), `im:message:send_as_bot`, `im:chat`; for “one user + bot” no-@ logic, grant read chat / member APIs as needed (`im:chat` related)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env

npm run dev
# (`tsx src/index.ts`: `cursor-legacy` still defaults to cursor-agent-acp sources via tsx; other backends use their configured spawn command)
# or
npm run build && npm start

<!-- readme-dev-helper-en:start -->
# Debug: stop other instances before dev (single-instance lock)
# ./scripts/bridge-dev.sh
# npm run dev:restart
# scripts/bridge-dev.sh and service.sh now share the same TS-side env/path resolution rules for lock/log defaults.
<!-- readme-dev-helper-en:end -->
```

### Backend deployment matrix

`bash service.sh install` / `update` always starts the same bridge process; which backend actually runs is decided by `ACP_BACKEND` / `/new --backend ...` and the commands available on the host.

| Backend | Required local command | Extra prerequisite | Key env vars | Recommended smoke / check |
|---------|------------------------|--------------------|--------------|---------------------------|
| `cursor-official` | `agent` | Run `agent login` on the host if needed | `ACP_BACKEND=cursor-official`, optional `CURSOR_AGENT_PATH`, `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` | Confirm `agent acp` works locally, then use `/new --backend cursor-official ...` or normal `/new` |
| `cursor-legacy` | Node.js + in-repo `vendor/cursor-agent-acp/` | Local `cursor-agent` / Cursor CLI must still be usable | `ACP_BACKEND=cursor-legacy`, optional `CURSOR_LEGACY_NODE_PATH`, `CURSOR_LEGACY_SESSION_DIR`, `CURSOR_LEGACY_EXTRA_ARGS` | Confirm `npm run dev` / `npm run build` succeeds, then use `/new --backend cursor-legacy ...` |
| `claude` | `claude-agent-acp` or bundled dist / `npx` fallback | Claude Code auth must already be valid on the host; file send-back needs the bridge extension path to remain available | `ACP_BACKEND=claude`, optional `CLAUDE_AGENT_ACP_COMMAND`, `CLAUDE_AGENT_ACP_EXTRA_ARGS` | `docker-compose -f docker/compose.yaml run --rm claude-acp-smoke`, then a real `/new --backend claude ...` check |
| `codex` | `npx` or local `codex-acp` command | Codex auth must already be valid on the host; usually `OPENAI_API_KEY` or `CODEX_API_KEY`. On Linux x64, the current tested `@zed-industries/codex-acp@0.11.1` also needs OpenSSL 3 (`libssl.so.3` / `libcrypto.so.3`) and `glibc >= 2.34` | `ACP_BACKEND=codex`, optional `CODEX_AGENT_ACP_COMMAND`, `CODEX_AGENT_ACP_EXTRA_ARGS` | Confirm `npx @zed-industries/codex-acp` works locally, then use `/new --backend codex ...` |

Notes:

- `service.sh` does not pick a backend for you; it only installs and runs `node dist/index.js`.
- `BRIDGE_WORK_ALLOWLIST` is still mandatory for all backends.
- Docker dev setup mirrors host tools/auth by bind-mounting local directories; if a backend works on the host but not in Docker, check mounted binaries, auth state, and path assumptions first.

### Codex host requirements

- By default the bridge launches Codex via `npx -y @zed-industries/codex-acp`; `/new --backend codex` can only work if that command already starts successfully on the host.
- Current tested Linux x64 package: `@zed-industries/codex-acp@0.11.1`. In our probe it requires OpenSSL 3 (`libssl.so.3`, `libcrypto.so.3`) and `glibc >= 2.34`.
- Ubuntu 20.04 (`glibc 2.31`, `libssl.so.1.1`) is therefore not enough for the default binary. Typical startup failures are `libssl.so.3: cannot open shared object file` and/or `GLIBC_2.34 not found`.
- If the default `npx` binary is ABI-incompatible with the host, either run the bridge on a newer Linux host/container (for example Ubuntu 22.04+) or override `CODEX_AGENT_ACP_COMMAND` to a compatible local wrapper or binary.
- Installing OpenSSL or glibc inside Conda does not usually fix the default `npx` path by itself, because the downloaded ELF still uses the system dynamic loader unless you wrap it explicitly.
- Detailed behavior notes live in `docs/codex-backend-notes.md`.

### Auto-start (`service.sh`)

The same **`bash service.sh`** script supports **macOS** (`launchd`) and **Linux with systemd** (e.g. **Ubuntu**): **`npm install` + `npm run build`**, then install a user service and start it. The process runs **`node dist/index.js`** with **`WorkingDirectory`** = repo root (`.env` is loaded by `dotenv`).

#### macOS (launchd)

Same idea as **feishu-cursor-claw**: plist at **`~/Library/LaunchAgents/com.feishu-cursor-bridge.plist`**, **`RunAtLoad`**, **`KeepAlive`**. Logs: **`/tmp/feishu-cursor-bridge.log`**. **`stop`** uses **`launchctl bootout`** (unloads the job but keeps the plist); killing only the process would respawn it immediately because of **`KeepAlive`**.

#### Linux / Ubuntu (`systemd --user`)

User unit: **`~/.config/systemd/user/feishu-cursor-bridge.service`**, **`Restart=always`**. Logs: **`journalctl --user -u feishu-cursor-bridge.service`** (also **`bash service.sh logs`**).

To start the user service **at boot without an interactive login**, run once: **`sudo loginctl enable-linger "$USER"`** (optional).

```bash
<!-- readme-service-commands-en:start -->
bash service.sh install    # npm install + build + install + start
bash service.sh update     # after git pull / code edits: rebuild dist + restart
bash service.sh status
bash service.sh logs       # macOS: follow log file; Linux: journalctl -f
<!-- readme-service-commands-en:end -->
```

| Command | Description |
|---------|-------------|
| `bash service.sh install` | `npm install` + `npm run build`, then install auto-start and launch |
| `bash service.sh update` | `npm install` + `npm run build`, then **restart** (use after `git pull` or local edits so **`dist/`** matches new code) |
| `bash service.sh uninstall` | Remove auto-start and stop |
| `bash service.sh start` | Start |
| `bash service.sh stop` | Stop |
| `bash service.sh restart` | Restart the process only (**no build** — stale `dist/` will keep running old code) |
| `bash service.sh status` | Status |
| `bash service.sh logs` | Live logs |

After code changes: prefer **`bash service.sh update`** so dependency + compile + restart happen in one step. It now also refreshes the plist / systemd unit first, so PATH-related changes in `.env` (for example `CONDA_ENV_NAME` / `CONDA_ROOT`) take effect immediately. Alternatively run `npm run build` then **`bash service.sh restart`**. Re-run **`bash service.sh install`** if you need to refresh the plist / systemd unit or your **Node binary path** changed.

<!-- readme-test-discovery-note-en:start -->
`npm test` now runs through the repo-local Node entry `scripts/run-tests.mjs` instead of shell `find | xargs`, so test discovery stays in-repo and cross-shell behavior is more stable.
<!-- readme-test-discovery-note-en:end -->

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

### Claude backend smoke test (Docker)

One **one-off** smoke service validates the `claude` backend inside the container without touching a live Feishu bridge:

```bash
# Minimal: newSession -> prompt -> closeSession
# Requires CLAUDE_AGENT_ACP_COMMAND to be runnable in-container and valid Claude Code auth
docker-compose -f docker/compose.yaml run --rm claude-acp-smoke
```

Notes:

- This compose targets **local Linux dev**; host paths are hard-coded as `/home/liuyang/...` — edit `docker/compose.yaml` bind mounts if your machine differs.
- Workspace path in the container matches the host: `/home/liuyang/Documents/feishu-cursor-bridge`, so absolute paths in `.env` often need no change.
- Dependencies live in Docker volume `bridge_node_modules`; `package-lock.json` changes trigger `npm install` on container start.
- `docker/Dockerfile.dev` includes the toolchain needed for local bridge development; Claude smoke additionally requires its ACP command / auth to be available in the container. Smokes do not hold a Feishu long connection — backend regression only.

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
| `BRIDGE_INSTANCE_NAME` | Optional local instance name. When set, default state paths and `service.sh` launchd/systemd names are isolated so multiple bots can run on one machine. Use letters, numbers, `.`, `_`, `-`. | empty |
| `ACP_BACKEND` | Default backend: `cursor-official` / `cursor-legacy` / `claude` / `codex` | `cursor-official` |
| `CURSOR_AGENT_PATH` | Official ACP command path | `agent` |
| `CURSOR_API_KEY` | Official ACP API key (optional) | empty |
| `CURSOR_AUTH_TOKEN` | Official ACP auth token (optional) | empty |
| `CONDA_ROOT` | Conda root path used by `service.sh` PATH injection (`~/miniconda3` / `~/anaconda3` auto-detected when unset) | auto-detect |
| `CONDA_ENV_NAME` | Conda env name whose `bin` is prepended to service PATH during `bash service.sh install` / `update`; skipped if Conda/env is missing | `base` |
| `CLAUDE_AGENT_ACP_COMMAND` | Claude ACP child command | in-repo patched wrapper or `npx -y @agentclientprotocol/claude-agent-acp` |
| `CLAUDE_AGENT_ACP_EXTRA_ARGS` | Extra args appended to Claude ACP child command | empty |
| `CODEX_AGENT_ACP_COMMAND` | Codex ACP child command; override this when the default `npx` binary is not ABI-compatible with the host | `npx -y @zed-industries/codex-acp` |
| `CODEX_AGENT_ACP_EXTRA_ARGS` | Extra args appended to Codex ACP child command | empty |
| `BRIDGE_WORK_ALLOWLIST` | **Required.** Comma-separated absolute workspace roots; compatible with `CURSOR_WORK_ALLOWLIST`; ACP child `cwd` = first entry | — |
| `CURSOR_LEGACY_NODE_PATH` | Node binary used to spawn **in-repo** `cursor-agent-acp` (`cursor-legacy` only; compatible with `ACP_NODE_PATH`) | `process.execPath` |
| `CURSOR_LEGACY_SESSION_DIR` | Passed to `cursor-agent-acp` as `--session-dir` (`cursor-legacy` only; compatible with `CURSOR_ACP_SESSION_DIR`) | `~/.feishu-cursor-bridge[/<instance>]/cursor-acp-sessions` |
| `CURSOR_LEGACY_EXTRA_ARGS` | Extra args for `cursor-agent-acp` CLI (`cursor-legacy` only; compatible with `CURSOR_ACP_EXTRA_ARGS`) | empty |
| `BRIDGE_SESSION_STORE` | Feishu ↔ ACP mapping JSON path | `~/.feishu-cursor-bridge[/<instance>]/.feishu-bridge-sessions.json` |
| `SESSION_IDLE_TIMEOUT_MS` | Idle before new session; `0` / `infinity` = never | `604800000` (7 days) |
| `BRIDGE_MAX_SESSIONS_PER_USER` | Max live sessions per user (all chats); `0` = unlimited | `10` |
| `BRIDGE_GROUP_SESSION_SCOPE` | Group session isolation: `per-user` or `shared`; `shared` keeps group members on one shared session set per group/thread and makes session-management commands admin-only | `per-user` |
| `BRIDGE_SINGLE_INSTANCE_LOCK` | Single-instance lock file (refuse start if PID alive) | `~/.feishu-cursor-bridge[/<instance>]/bridge.lock` |
| `BRIDGE_ALLOW_MULTIPLE_INSTANCES` | `true` disables single-instance lock (debug only) | `false` |
| `FEISHU_CARD_THROTTLE_MS` | Card update throttle | `800` |
| `FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD` | Roll over to a new card when a card gets this long | `3500` |
| `FEISHU_CARD_SPLIT_TOOL_THRESHOLD` | Roll over to a new card when tool rows exceed this count | `8` |
| `AUTO_APPROVE_PERMISSIONS` | Auto-pick allow-style permission options; for `codex`, also injects `sandbox_mode="danger-full-access"` + `approval_policy="never"` at backend startup unless `CODEX_AGENT_ACP_*` already overrides them | `true` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `BRIDGE_DEBUG` | Verbose logs + `/status` details | `false` |
| `EXPERIMENT_LOG_TO_FILE` | Experimental: append `console.*` to file | `false` |
| `EXPERIMENT_LOG_FILE` | Experimental log path | `~/.feishu-cursor-bridge[/<instance>]/logs/bridge.log` |

`BRIDGE_INSTANCE_NAME` is the recommended way to run two configured copies on the same machine. For example, set `BRIDGE_INSTANCE_NAME=bot-a` in one checkout and `BRIDGE_INSTANCE_NAME=bot-b` in another; `bash service.sh install` will then create `com.feishu-cursor-bridge.bot-a` / `com.feishu-cursor-bridge.bot-b` on macOS, or `feishu-cursor-bridge.bot-a.service` / `feishu-cursor-bridge.bot-b.service` on Linux. Explicit path variables still override these instance-scoped defaults.

Proxy precedence: `wss_proxy` / `ws_proxy` > `https_proxy` / `http_proxy` / `all_proxy`. Proxy is used only when env vars are set; otherwise direct.

## Usage

- **DM / group**: after you **create a session** with `/new list` then `/new <index or path>` (paths must fall under `BRIDGE_WORK_ALLOWLIST`), normal messages go to Cursor; without a session the bot asks you to `/new` first
- **Incoming attachments**: when a session is active, files/images/audio/video sent from Feishu are downloaded into `.feishu-incoming/` under the current workspace and then described to the Agent as local paths; `/fileback` is the opposite direction, for asking the Agent to send workspace files back to Feishu
<!-- backend-readme-switch-en:start -->
- **Switch backend**: use `/new <index or path> --backend <cursor-official|cursor-legacy|claude|codex>` to select the backend for a new session; `-b <official|cur|legacy|claude|codex|cc|cx>` is also supported. The backend must be included in `ACP_ENABLED_BACKENDS`, or it will not be available.
<!-- backend-readme-switch-en:end -->
- **Group**: @ the bot + content ( **`im:message.group_msg`** must be enabled or group events won’t arrive); in **topic** groups, each `thread_id` always stays isolated from the main group chat. With `BRIDGE_GROUP_SESSION_SCOPE=shared`, members in the same group/thread share the same session set and only admins may run session-management commands.
- **Multi-session**: `/new <index or path>` creates and switches (old session stays connected); bare `/new` lists presets; `/sessions` lists; `/switch <index or name>` switches active (no arg → last used); `/close` closes one; `/rename` helps name-based switching. Full syntax: `docs/feishu-commands.md`
- `/status` or `/状态`: session stats, always shows ACP backend; `cursor-official` / `cursor-legacy` / `claude` / `codex` show known mode for the active session; recovery metadata is shown when available; `cursor-official` now shows the active ACP `sessionId`, `claude` stably shows the current Claude resume session id, and `codex` shows the active ACP `sessionId` by default; with `BRIDGE_DEBUG=true`, adds more paths, modes, and session details. For the `claude` backend, the Feishu context usage shown here is a fast approximate value from ACP `usage_update`; if you need a closer current-context snapshot, run `/context` in the Claude session. See [docs/claude-context-calibration-notes.md](docs/claude-context-calibration-notes.md).
- `/mode <id>`: `cursor-official` / `cursor-legacy` / `claude` / `codex` use ACP `session/set_mode`
- `/model <id>`: `cursor-legacy` / `cursor-official` / `claude` / `codex` use ACP `session/set_model` and support selecting from the current session's model list by 1-based index

## Manual smoke checklist

1. `npm run build` succeeds
2. `npm test` succeeds
3. DM: `/new list` then `/new <index or allowed path>` — then send a message; card shows an “answer” block
4. Multi-turn — same session reused (`BRIDGE_DEBUG`: stable `sessionId`)
5. With multiple `/new` sessions, `/switch` keeps contexts independent
6. When tools run, card “tools” updates (depends on Agent output)
7. `/status` shows backend + mode; with `BRIDGE_DEBUG=true`, `sessionId` / workspace, etc.; **CLI resume ID** appears only with `ACP_BACKEND=cursor-legacy`

## Tech stack

- **Cursor `agent acp`** — default ACP server
- **`vendor/cursor-agent-acp/`** — embedded stdio adapter when using `cursor-legacy` ([provenance](docs/third-party.md))
- **[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)** — ACP client types + connection
- **@larksuiteoapi/node-sdk** — Feishu long connection + message API
- **TypeScript + Node.js**

## Backend strategy

- Default: **`cursor-official`** (`agent acp`).
- Optional: **`cursor-legacy`** uses the embedded **`vendor/cursor-agent-acp/`** adapter; **`claude`** uses `claude-agent-acp`; **`codex`** uses `@zed-industries/codex-acp`.
- Protocol follows the SDK; events cover thinking, tools, plan, mode, etc., folded by `FeishuCardState`.

---

# 中文文档

## 这是什么

独立服务，通过飞书机器人统一控制多个 ACP backend。桥接进程作为 **ACP Client**，可将每个 session 槽位分别路由到 **`cursor-official`**、**`cursor-legacy`**、**`claude`** 或 **`codex`**。

## 功能特性

- 飞书消息转发至 Cursor（默认经官方 `agent acp`）
- 回复流式推送到飞书（interactive 卡片，含回答、思考、工具、计划等区块）
- 会话隔离可配置：私聊始终按用户映射；群聊默认按用户隔离，也可用 `BRIDGE_GROUP_SESSION_SCOPE=shared` 改为整群/整话题共享同一组 session
- **多 session**：每个聊天作用域最多同时持有 5 个 session，各自独立上下文与工作区；默认作用域是“同一用户在同一聊天”，若启用 `BRIDGE_GROUP_SESSION_SCOPE=shared` 则改为“同一群/同一话题”；可用 `/switch` 在它们之间切换，未活跃的 session 仍保持 ACP 连接
- **每用户存活 session 上限**：同一飞书用户跨所有私聊、按用户隔离的群/话题会话的存活 session 总数默认最多 **10**（可用 `BRIDGE_MAX_SESSIONS_PER_USER` 调整；`0` 表示不限制），避免将空闲过期设为无限时进程堆积过多 ACP 连接；共享群 session 不占用创建者的个人配额
- 群聊 @ 机器人触发（或满足「仅 1 用户 + 1 机器人」时可免 @）；私聊直接对话
- **须显式建 session**：配置必填 **`BRIDGE_WORK_ALLOWLIST`**（兼容 `CURSOR_WORK_ALLOWLIST`）；先用 `/new list` 再 `/new <序号或路径>` 才能对话；裸 `/new` 等同列表
- 内置命令：`/new`、`/sessions`、`/switch`、`/close`（含 `/close all`）、`/rename`（含 `/new list`、`/new <序号>`、`/new <路径>` 等）、`/status`、`/mode`、`/model`；bridge-native `!<shell 命令>` 默认开启，在发送者命中管理员时会直接在当前活跃 session 工作区执行，也可通过 `BRIDGE_ENABLE_BANG_COMMAND=false` 关闭；另有 **`/topic` + 话题内容** 的纯展示命令（不发给 Agent，见 `docs/feishu-commands.md`）
- 会话映射持久化：进程重启后若 Agent 声明 `loadSession`，可 `session/load` 恢复
- **恢复元信息**：`/status` 会在 `cursor-legacy` 显示 CLI resume ID，在 `claude` 显示 Claude 恢复会话 id；官方 ACP 当前未暴露等价字段

## 架构

```
飞书用户 ──(WebSocket)──> FeishuBot ──> Bridge
                                           │
                    ConversationService / FeishuCardState
                                           │
                    @agentclientprotocol/sdk ClientSideConnection
                                           │
                    stdio NDJSON ──> agent acp 子进程（默认） / 本仓 vendor/cursor-agent-acp（`cursor-legacy`） / claude-agent-acp / codex-acp
```

- **飞书层**：`src/feishu/bot.ts`（仅 SDK 与消息收发）
- **ACP 运行时**：`src/acp/runtime.ts` + `src/acp/feishu-bridge-client.ts`（实现 Client：权限、沙箱读写、`session/update` 归一化）
- **编排**：`src/bridge/bridge.ts`、`src/bridge/conversation-service.ts`
- **会话**：`src/session/manager.ts` + `src/session/store.ts`

## 前置条件

1. **Node.js 18+**
2. 已安装 **Cursor CLI / Agent CLI**（`agent` 在 PATH 中，并已完成登录；若使用 **`ACP_BACKEND=cursor-legacy`**，内嵌适配器会调用 **`cursor-agent`**，需本机可用）
3. 飞书企业自建应用：机器人、`im:message`、**`im:message.group_msg`**（群聊收消息必需）、`im:message:send_as_bot`、`im:chat`；若使用「仅 1 用户 + 1 机器人」免 @ 等需拉群信息的逻辑，还需按需开通 `im:chat` 相关只读权限（如查看群成员）

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env

npm run dev
# （`tsx src/index.ts`：若 .env 中 ACP_BACKEND=cursor-legacy，本仓 vendor/cursor-agent-acp 默认以 tsx 跑源码，改适配器无需先 npm run build:adapter）
# 或
npm run build && npm start

<!-- readme-dev-helper-zh:start -->
# 调试：先结束已有实例再起 dev（与单实例锁配合，避免多进程）
# ./scripts/bridge-dev.sh
# npm run dev:restart
# scripts/bridge-dev.sh 和 service.sh 现在共用同一套 TS 侧 env/path 解析语义来确定 lock/log 默认值。
<!-- readme-dev-helper-zh:end -->
```

### backend 部署对照

`bash service.sh install` / `update` 启动的始终是同一个 bridge 进程；真正跑哪个 backend，取决于 `ACP_BACKEND`、`/new --backend ...` 以及宿主机上实际可用的命令与认证状态。

| Backend | 本机必需命令 | 额外前置条件 | 关键环境变量 | 推荐验证方式 |
|---------|--------------|--------------|--------------|--------------|
| `cursor-official` | `agent` | 必要时先在宿主机执行 `agent login` | `ACP_BACKEND=cursor-official`，可选 `CURSOR_AGENT_PATH`、`CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN` | 先确认本地 `agent acp` 可用，再用 `/new --backend cursor-official ...` 或默认 `/new` |
| `cursor-legacy` | Node.js + 仓库内 `vendor/cursor-agent-acp/` | 宿主机上的 `cursor-agent` / Cursor CLI 仍需可用 | `ACP_BACKEND=cursor-legacy`，可选 `CURSOR_LEGACY_NODE_PATH`、`CURSOR_LEGACY_SESSION_DIR`、`CURSOR_LEGACY_EXTRA_ARGS` | 先确认 `npm run dev` / `npm run build` 正常，再用 `/new --backend cursor-legacy ...` |
| `claude` | `claude-agent-acp`，或 bundled dist / `npx` 回退 | 宿主机需已有有效 Claude Code 认证；文件回传依赖 bridge 扩展链路可用 | `ACP_BACKEND=claude`，可选 `CLAUDE_AGENT_ACP_COMMAND`、`CLAUDE_AGENT_ACP_EXTRA_ARGS` | `docker-compose -f docker/compose.yaml run --rm claude-acp-smoke`，再补一次真实 `/new --backend claude ...` |
| `codex` | `npx` 或本地 `codex-acp` 命令 | 宿主机需已有有效 Codex/OpenAI 认证；通常依赖 `OPENAI_API_KEY` 或 `CODEX_API_KEY`。当前实测的 Linux x64 包 `@zed-industries/codex-acp@0.11.1` 还要求 OpenSSL 3（`libssl.so.3` / `libcrypto.so.3`）以及 `glibc >= 2.34` | `ACP_BACKEND=codex`，可选 `CODEX_AGENT_ACP_COMMAND`、`CODEX_AGENT_ACP_EXTRA_ARGS` | 先确认 `npx @zed-industries/codex-acp` 可用，再补一次真实 `/new --backend codex ...` |

说明：

- `service.sh` 不负责替你选择 backend，它只负责安装并运行 `node dist/index.js`。
- 所有 backend 都仍然要求配置 `BRIDGE_WORK_ALLOWLIST`。
- Docker dev setup 通过 bind mount 复用宿主机工具与认证；如果宿主机可用、容器里不可用，优先检查挂载的二进制、认证状态和绝对路径假设。

### Codex 宿主机要求

- bridge 默认通过 `npx -y @zed-industries/codex-acp` 启动 Codex；只有这条命令在宿主机上本身能正常启动，`/new --backend codex` 才可能工作。
- 当前实测的 Linux x64 包版本是 `@zed-industries/codex-acp@0.11.1`；探测结果显示它依赖 OpenSSL 3（`libssl.so.3`、`libcrypto.so.3`）以及 `glibc >= 2.34`。
- 因此 Ubuntu 20.04（`glibc 2.31`、`libssl.so.1.1`）不足以直接运行默认二进制。常见报错是 `libssl.so.3: cannot open shared object file` 和/或 `GLIBC_2.34 not found`。
- 若默认 `npx` 拉起的二进制与宿主机 ABI 不兼容，建议把 bridge 跑在更新的 Linux 宿主机或容器中（例如 Ubuntu 22.04+），或者通过 `CODEX_AGENT_ACP_COMMAND` 改为兼容的本地 wrapper / 二进制。
- 仅在 Conda 环境里安装 OpenSSL 或 glibc，通常并不能直接修复默认 `npx` 路径，因为下载到的 ELF 仍会优先使用系统动态加载器；除非你显式做一层 wrapper。
- 更细的行为记录见 `docs/codex-backend-notes.md`。

### 开机自启（`service.sh`：macOS launchd / Linux systemd）

同一脚本在 **macOS** 使用 **launchd**，在 **systemd** 的 Linux（如 **Ubuntu**）使用 **`systemctl --user`**：先 **`npm install`**、**`npm run build`**，再注册用户级服务并启动。进程在仓库根目录运行 **`node dist/index.js`**（**`.env`** 由 `dotenv` 加载）。

#### macOS（launchd）

与 feishu-cursor-claw 同类：**`~/Library/LaunchAgents/com.feishu-cursor-bridge.plist`**，**`RunAtLoad`** + **`KeepAlive`**。日志：**`/tmp/feishu-cursor-bridge.log`**。**`stop`** 使用 **`launchctl bootout`**（卸载任务、保留 plist）；若只杀进程，**`KeepAlive`** 会让 launchd 立刻再拉起进程。

#### Linux / Ubuntu（`systemd --user`）

用户单元：**`~/.config/systemd/user/feishu-cursor-bridge.service`**，**`Restart=always`**。日志：**`journalctl --user -u feishu-cursor-bridge.service`**（或 **`bash service.sh logs`**）。

若要在**未登录图形会话时**仍随开机启动当前用户的单元，可执行一次：**`sudo loginctl enable-linger "$USER"`**（可选）。

```bash
<!-- readme-service-commands-zh:start -->
bash service.sh install    # npm install + build + 安装并启动
bash service.sh update     # pull / 改代码后：install + build + 重启，使 dist 生效
bash service.sh status
bash service.sh logs       # macOS：跟日志文件；Linux：journalctl -f
<!-- readme-service-commands-zh:end -->
```

| 命令 | 说明 |
|------|------|
| `bash service.sh install` | `npm install` + `npm run build` + 安装自启动并启动 |
| `bash service.sh update` | `npm install` + `npm run build` + **重启**（已 install 后更新代码用，保证 **`dist/`** 为新版本） |
| `bash service.sh uninstall` | 卸载自启动并停止 |
| `bash service.sh start` | 启动 |
| `bash service.sh stop` | 停止 |
| `bash service.sh restart` | 仅重启进程（**不编译**；`dist/` 未更新则仍跑旧代码） |
| `bash service.sh status` | 状态 |
| `bash service.sh logs` | 实时日志 |

代码更新后优先 **`bash service.sh update`**（依赖 + 编译 + 重启一步完成）。它现在也会先刷新 plist / systemd unit，因此 `.env` 里的 PATH 相关变更（例如 `CONDA_ENV_NAME` / `CONDA_ROOT`）会立即生效。也可手动 `npm run build` 再 **`bash service.sh restart`**。需要**重写 plist / systemd unit** 或更换 **Node 路径**时再执行 **`bash service.sh install`**。

<!-- readme-test-discovery-note-zh:start -->
`npm test` 现在通过仓库内的 Node 入口 `scripts/run-tests.mjs` 做测试发现，不再依赖 shell 的 `find | xargs`，便于后续维护并减少跨 shell 差异。
<!-- readme-test-discovery-note-zh:end -->

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

### Docker 中验证 Claude backend

当前仓库提供了一个**一次性 smoke 服务**，用于在不影响宿主机正在运行的飞书 bridge 的情况下，单独验证容器内的 `claude` backend：

```bash
# claude 最小链路：newSession -> prompt -> closeSession
# 需容器内可执行 CLAUDE_AGENT_ACP_COMMAND，且已具备 Claude Code / Anthropic 认证
docker-compose -f docker/compose.yaml run --rm claude-acp-smoke
```

说明：

- 该 compose 面向**本机 Linux 开发联调**，当前宿主机路径按 `/home/liuyang/...` 写死；若换机器，请同步修改 `docker/compose.yaml` 中的 bind mount。
- 容器内工作目录与宿主机保持一致：`/home/liuyang/Documents/feishu-cursor-bridge`，因此现有 `.env` 里的工作区绝对路径通常无需额外改写。
- 依赖安装在 Docker volume `bridge_node_modules` 中；`package-lock.json` 变化后，容器启动时会自动重新执行 `npm install`。
- `docker/Dockerfile.dev` 提供本地 bridge 开发所需基础工具；Claude smoke 仍要求容器内可用的 ACP 命令与认证状态。这些 smoke 服务不会占用飞书 bot 长连接，只用于容器内的 backend 回归。

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
| `FEISHU_APP_ID` | 飞书 App ID（必填） | — |
| `FEISHU_APP_SECRET` | 飞书 App Secret（必填） | — |
| `FEISHU_DOMAIN` | `feishu` / `lark` / 自定义 URL | `feishu` |
| `BRIDGE_INSTANCE_NAME` | 本机实例名；设置后默认状态路径与 `service.sh` 的 launchd/systemd 服务名会自动隔离，便于同机多 bot 并存。可用字母、数字、`.`、`_`、`-`。 | 空 |
| `ACP_BACKEND` | ACP 后端：`cursor-official` / `cursor-legacy` / `claude` / `codex` | `cursor-official` |
| `CURSOR_AGENT_PATH` | 官方 ACP 命令路径 | `agent` |
| `CURSOR_API_KEY` | 官方 ACP API key（可选） | 空 |
| `CURSOR_AUTH_TOKEN` | 官方 ACP auth token（可选） | 空 |
| `CLAUDE_AGENT_ACP_COMMAND` | Claude ACP 子进程命令 | 仓库内置 patched wrapper 或 `npx -y @agentclientprotocol/claude-agent-acp` |
| `CLAUDE_AGENT_ACP_EXTRA_ARGS` | 追加到 Claude ACP 子进程命令后的额外参数 | 空 |
| `CODEX_AGENT_ACP_COMMAND` | Codex ACP 子进程命令；若默认 `npx` 二进制与宿主机 ABI 不兼容，可在这里覆盖 | `npx -y @zed-industries/codex-acp` |
| `CODEX_AGENT_ACP_EXTRA_ARGS` | 追加到 Codex ACP 子进程命令后的额外参数 | 空 |
| `BRIDGE_WORK_ALLOWLIST` | **必填**，逗号分隔的绝对路径根；兼容 `CURSOR_WORK_ALLOWLIST`；ACP 子进程 `cwd` 取列表首项 | — |
| `CURSOR_LEGACY_NODE_PATH` | 用于启动本仓 `vendor/cursor-agent-acp` 子进程的 Node（仅 `cursor-legacy`，兼容 `ACP_NODE_PATH`） | `process.execPath` |
| `CURSOR_LEGACY_SESSION_DIR` | 传给 `vendor/cursor-agent-acp` 的 `--session-dir`（仅 `cursor-legacy`，兼容 `CURSOR_ACP_SESSION_DIR`） | `~/.feishu-cursor-bridge[/<实例名>]/cursor-acp-sessions` |
| `CURSOR_LEGACY_EXTRA_ARGS` | 透传 `vendor/cursor-agent-acp` CLI 的额外参数（仅 `cursor-legacy`，兼容 `CURSOR_ACP_EXTRA_ARGS`，空格分隔） | 空 |
| `BRIDGE_SESSION_STORE` | 飞书↔ACP 映射 JSON 路径 | `~/.feishu-cursor-bridge[/<实例名>]/.feishu-bridge-sessions.json` |
| `SESSION_IDLE_TIMEOUT_MS` | 空闲多久新建会话；`0` / `infinity` 表示永不过期 | `604800000`（7 天） |
| `BRIDGE_MAX_SESSIONS_PER_USER` | 同一用户存活 session 总数上限（跨聊天）；`0` 不限制 | `10` |
| `BRIDGE_GROUP_SESSION_SCOPE` | 群聊 session 隔离方式：`per-user` 或 `shared`；设为 `shared` 后，同一群/同一话题成员共享一组 session，且 session 管理命令仅管理员可用 | `per-user` |
| `BRIDGE_SINGLE_INSTANCE_LOCK` | 单实例锁文件路径（已存在且 PID 存活则拒绝启动） | `~/.feishu-cursor-bridge[/<实例名>]/bridge.lock` |
| `BRIDGE_ALLOW_MULTIPLE_INSTANCES` | `true` 时禁用单实例锁（仅调试） | `false` |
| `FEISHU_CARD_THROTTLE_MS` | 卡片更新节流 | `800` |
| `FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD` | 单张卡片内容达到该长度后滚动到下一张 | `3500` |
| `FEISHU_CARD_SPLIT_TOOL_THRESHOLD` | 单张卡片工具条目超过该数量后滚动到下一张 | `8` |
| `AUTO_APPROVE_PERMISSIONS` | 自动选择允许类权限选项 | `true` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `BRIDGE_DEBUG` | 调试日志与 `/status` 详情 | `false` |
| `EXPERIMENT_LOG_TO_FILE` | 实验参数：是否把 `console.*` 追加写入日志文件 | `false` |
| `EXPERIMENT_LOG_FILE` | 实验参数：日志文件路径 | `~/.feishu-cursor-bridge[/<实例名>]/logs/bridge.log` |

`BRIDGE_INSTANCE_NAME` 是同一台机器上运行多套 bot 的推荐方式。例如两份 checkout 分别设置 `BRIDGE_INSTANCE_NAME=bot-a` 与 `BRIDGE_INSTANCE_NAME=bot-b` 后，`bash service.sh install` 在 macOS 会生成 `com.feishu-cursor-bridge.bot-a` / `com.feishu-cursor-bridge.bot-b`，在 Linux 会生成 `feishu-cursor-bridge.bot-a.service` / `feishu-cursor-bridge.bot-b.service`。显式配置的路径变量仍会覆盖这些按实例隔离的默认路径。

代理相关说明：
`wss_proxy` / `ws_proxy` > `https_proxy` / `http_proxy` / `all_proxy`。仅在环境变量存在时才启用代理，否则默认直连。

## 使用方式

- **私聊 / 群聊**：须先用 **`/new list`** 再 **`/new <序号或路径>`** 创建 session（路径须在 `BRIDGE_WORK_ALLOWLIST` 下），之后普通消息才会进 Agent；无 session 时机器人会提示先 `/new`
<!-- backend-readme-switch-zh:start -->
- **切换 backend**：可用 `/new <序号或路径> --backend <cursor-official|cursor-legacy|claude|codex>` 为新 session 指定 backend；也支持 `-b <official|cur|legacy|claude|codex|cc|cx>`；但该 backend 必须已包含在 `ACP_ENABLED_BACKENDS` 中，否则不会被启动
<!-- backend-readme-switch-zh:end -->
- **飞书附件入站**：有活跃 session 时，用户直接发送的文件 / 图片 / 音频 / 视频会先下载到当前工作区的 `.feishu-incoming/`，再把相对路径说明交给 Agent；`/fileback` 则是反方向，用于让 Agent 把工作区文件回传到飞书
- **群聊**：@机器人 + 内容（开发平台须为应用开通 **`im:message.group_msg`**，否则群消息事件不会投递到机器人）；**话题群**内不同话题（`thread_id`）始终与群主页会话互不共享。若设 `BRIDGE_GROUP_SESSION_SCOPE=shared`，同一群/同一话题内所有成员共享同一组 session，且仅管理员可执行 session 管理命令
- **多 session 切换**：`/new <序号或路径>` 新建并切到该 session（裸 `/new` 等同列表）；`/sessions` 列表；`/switch <编号或名称>` 切换活跃 session（无参数时切到上一次用过的）；`/close` 关闭指定；`/rename` 便于用名称切换。完整语法与快捷列表见 `docs/feishu-commands.md`
- `/status` 或 `/状态`：会话统计，始终展示当前 ACP 后端；`cursor-official` / `cursor-legacy` / `claude` / `codex` 下会展示当前活跃 session 已知 mode；若是 `cursor-legacy`，会额外显示当前活跃 slot 的 CLI resume ID，若是 `cursor-official` 则默认显示当前 Official ACP `sessionId`，若是 `claude` 则稳定显示当前 Claude 恢复会话 id（新建 session 时回退为当前 ACP `sessionId`），若是 `codex` 则默认显示当前 ACP `sessionId`；`BRIDGE_DEBUG=true` 时额外含更多 ACP `sessionId`、路径、可用模式等调试信息。对于 `claude` backend，这里的飞书 context 使用量是基于 ACP `usage_update` 的快速近似值；如果你需要更接近当前上下文快照的数值，请在 Claude 会话里执行 `/context`。详见 [docs/claude-context-calibration-notes.md](docs/claude-context-calibration-notes.md)
- `/mode <模式ID>`：`cursor-official` / `cursor-legacy` / `claude` / `codex` 下通过 ACP `session/set_mode` 切换当前活跃 session 的 mode
- `/model <模型ID>`：`cursor-legacy` / `cursor-official` / `claude` / `codex` 后端下通过 ACP `session/set_model` 切换当前活跃 session 的模型；桥接会以当前 ACP session 返回的可用模型列表为准，并统一支持桥接侧 `/model <序号>`（1-based）

## 最小验证清单（手工）

1. `npm run build` 通过
2. `npm test` 通过
3. 私聊：先 `/new list` 再 `/new <序号或允许路径>`，然后发一条普通消息，卡片出现「回答」区块
4. 连续多轮对话，确认复用同一会话（`BRIDGE_DEBUG` 下 sessionId 不变）
5. 若已用 `/new` 建多个 session，可用 `/switch` 在编号间切换且各 session 独立
6. 触发工具调用时，卡片「工具」列表有更新（视 Agent 输出而定）
7. 发送 `/status`，确认显示当前 ACP 后端与当前 mode；若 `BRIDGE_DEBUG=true`，再确认返回里包含 `sessionId`、工作区路径等调试信息；只有切到 `ACP_BACKEND=cursor-legacy` 时，才会额外出现 **CLI resume ID**

## 技术栈

- **Cursor `agent acp`** — 默认 ACP 服务端
- **`vendor/cursor-agent-acp/`** — 内嵌 stdio 适配器源码与构建产物（`ACP_BACKEND=cursor-legacy`）；溯源见 [docs/third-party.md](docs/third-party.md)。目录内 `package.json` 仅含 `"type":"commonjs"`，避免根目录 `"type":"module"` 将 `dist/*.js` 误判为 ESM
- **[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)** — 官方 ACP Client 连接与类型
- **@larksuiteoapi/node-sdk** — 飞书长连接与消息 API
- **TypeScript + Node.js**

## 当前后端策略

- 默认 backend 为 **`cursor-official`**，对应官方 `agent acp`。
- `ACP_ENABLED_BACKENDS` 控制启动时实际启用哪些 backend；若未设置，默认只启用 `ACP_BACKEND` 当前值。
- 可选 backend 包括 **`cursor-legacy`**（本仓 `vendor/cursor-agent-acp/`）、**`claude`**（`claude-agent-acp`）和 **`codex`**（`@zed-industries/codex-acp`）。
- 协议实现以 SDK 为准，事件面覆盖思考、工具、计划、模式等，并由 `FeishuCardState` 折叠展示。
