# 飞书-Cursor 桥接服务

独立服务，通过飞书机器人控制 Cursor AI Agent。桥接进程作为 **ACP Client**，默认子进程运行 Cursor 官方 **`agent acp`**；同时保留 `ACP_BACKEND=legacy` 回滚到 **`@blowmage/cursor-agent-acp`** 的能力，便于紧急兜底。

## 功能特性

- 飞书消息转发至 Cursor（默认经官方 `agent acp`）
- 回复流式推送到飞书（interactive 卡片，含回答、思考、工具、计划等区块）
- 多用户会话隔离（私聊 / 群聊按用户维度映射 ACP `sessionId`）
- **多 session**：同一用户在同一聊天中可同时持有多个 session（最多 5 个），各自独立上下文与工作区；可用 `/switch` 在它们之间切换，未活跃的 session 仍保持 ACP 连接
- **每用户存活 session 上限**：同一飞书用户跨所有私聊/群/话题的存活 session 总数默认最多 **10**（可用 `BRIDGE_MAX_SESSIONS_PER_USER` 调整；`0` 表示不限制），避免将空闲过期设为无限时进程堆积过多 ACP 连接
- 群聊 @ 机器人触发（或满足「仅 1 用户 + 1 机器人」时可免 @）；私聊直接对话
- 内置命令：`/new`、`/sessions`、`/switch`、`/close`（含 `/close all`）、`/rename`、`/reset`（含快捷列表 `/new list`、`/new <序号>` 等）、`/status`、`/mode`、`/model`；另有 **`/topic` + 话题内容** 的纯展示命令（不发给 Agent，见 `docs/feishu-commands.md`）
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
                    stdio NDJSON ──> agent acp 子进程（默认） / cursor-agent-acp（legacy） ──> Cursor
```

- **飞书层**：`src/feishu-bot.ts`（仅 SDK 与消息收发）
- **ACP 运行时**：`src/acp/runtime.ts` + `src/acp/feishu-bridge-client.ts`（实现 Client：权限、沙箱读写、`session/update` 归一化）
- **编排**：`src/bridge.ts`、`src/conversation-service.ts`
- **会话**：`src/session-manager.ts` + `src/session-store.ts`

## 前置条件

1. **Node.js 18+**
2. 已安装 **Cursor CLI / Agent CLI**（`agent` 在 PATH 中，并已完成登录；若使用 legacy 回滚链路，还需本机 `cursor-agent` 可用）
3. 飞书企业自建应用：机器人、`im:message`、**`im:message.group_msg`**（群聊收消息必需）、`im:message:send_as_bot`、`im:chat`；若使用「仅 1 用户 + 1 机器人」免 @ 等需拉群信息的逻辑，还需按需开通 `im:chat` 相关只读权限（如查看群成员）

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env

npm run dev
# 或
npm run build && npm start

# 调试：先结束已有实例再起 dev（与单实例锁配合，避免多进程）
# ./scripts/bridge-dev.sh
# npm run dev:restart
```

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
| `CURSOR_ACP_ADAPTER_ENTRY` | `cursor-agent-acp` 入口 JS 路径（仅 `legacy`） | 包内 `dist/bin/cursor-agent-acp.js` |
| `ACP_NODE_PATH` | 用于启动 legacy 适配器的 Node | `process.execPath` |
| `CURSOR_ACP_SESSION_DIR` | legacy 适配器 `--session-dir` | `~/.feishu-cursor-bridge/cursor-acp-sessions` |
| `CURSOR_ACP_EXTRA_ARGS` | 透传 legacy 适配器 CLI（空格分隔） | 空 |
| `BRIDGE_SESSION_STORE` | 飞书↔ACP 映射 JSON 路径 | `~/.feishu-cursor-bridge/.feishu-bridge-sessions.json` |
| `SESSION_IDLE_TIMEOUT_MS` | 空闲多久新建会话；`0` / `infinity` 表示永不过期 | `604800000`（7 天） |
| `BRIDGE_MAX_SESSIONS_PER_USER` | 同一用户存活 session 总数上限（跨聊天）；`0` 不限制 | `10` |
| `BRIDGE_SINGLE_INSTANCE_LOCK` | 单实例锁文件路径（已存在且 PID 存活则拒绝启动） | `~/.feishu-cursor-bridge/bridge.lock` |
| `BRIDGE_ALLOW_MULTIPLE_INSTANCES` | `true` 时禁用单实例锁（仅调试） | `false` |
| `FEISHU_CARD_THROTTLE_MS` | 卡片更新节流 | `800` |
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
- `/reset` 仅重置**当前活跃** session（同槽位换新 ACP 会话），不关闭其它 session
- `/status` 或 `/状态`：会话统计，始终展示当前 ACP 后端与当前活跃 session 已知 mode；若是 `legacy`，会额外显示当前活跃 slot 的 CLI resume ID；`BRIDGE_DEBUG=true` 时额外含 ACP `sessionId`、路径、可用模式等调试信息
- `/mode <模式ID>`：通过 ACP `session/set_mode` 切换当前活跃 session 的 mode；无参数时返回当前 session 已知的可用模式与当前模式
- `/model <模型ID>`：通过 ACP `session/set_model` 切换当前活跃 session 的模型；默认 `official` 后端以下**当前 ACP session 返回的可用 selector**为准，无参数时返回当前 session 已知的可用模型与当前模型；在 `official` 下可直接用 `/model <序号>`

## 最小验证清单（手工）

1. `npm run build` 通过
2. 私聊发送一条消息，卡片出现「回答」区块
3. 连续多轮对话，确认复用同一会话（`BRIDGE_DEBUG` 下 sessionId 不变）
4. `/reset` 后再次提问，当前活跃 slot 的 ACP sessionId 变化；若已用 `/new` 建多个 session，可用 `/switch` 在编号间切换且各 session 独立
5. 触发工具调用时，卡片「工具」列表有更新（视 Agent 输出而定）
6. 发送 `/status`，确认显示当前 ACP 后端与当前 mode；若 `BRIDGE_DEBUG=true`，再确认返回里包含 `sessionId`、工作区路径等调试信息；只有切到 `ACP_BACKEND=legacy` 时，才会额外出现 **CLI resume ID**

## 技术栈

- **Cursor `agent acp`** — 默认 ACP 服务端
- **[@blowmage/cursor-agent-acp](https://www.npmjs.com/package/@blowmage/cursor-agent-acp)** — legacy 回滚后端
- **[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)** — 官方 ACP Client 连接与类型
- **@larksuiteoapi/node-sdk** — 飞书长连接与消息 API
- **TypeScript + Node.js**

## 当前后端策略

- 默认使用 **`agent acp` 官方后端**。
- 如需紧急回滚，可设 `ACP_BACKEND=legacy`。
- 协议实现以 SDK 为准，事件面覆盖思考、工具、计划、模式等，并由 `FeishuCardState` 折叠展示。
