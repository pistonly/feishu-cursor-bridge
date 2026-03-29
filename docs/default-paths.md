# 默认文件与目录路径

本文说明桥接服务在未设置相关环境变量时，会使用哪些**默认路径**。所有路径在运行时都会解析为**绝对路径**；配置里若写成以 `~/` 开头，会展开为当前用户主目录（见 `src/config.ts` 中的 `expandHome`）。

## 概览

| 用途 | 环境变量 | 默认位置 |
|------|----------|----------|
| Cursor / ACP 工作区根（新会话默认 `cwd`、读文件沙箱根） | `CURSOR_WORK_DIR` | 启动进程的**当前工作目录**（`process.cwd()`，再 `path.resolve`） |
| 允许 `/reset`、`/new` 指定的工作区根列表 | `CURSOR_WORK_ALLOWLIST` | 仅包含上述工作区根一项 |
| ACP 后端选择 | `ACP_BACKEND` | `official` |
| 官方 ACP 命令 | `CURSOR_AGENT_PATH` | `agent` |
| `cursor-agent-acp` 适配器会话目录（仅 `legacy`） | `CURSOR_ACP_SESSION_DIR` | `~/.feishu-cursor-bridge/cursor-acp-sessions` |
| 飞书 ↔ ACP 会话映射持久化 JSON | `BRIDGE_SESSION_STORE` | `~/.feishu-cursor-bridge/.feishu-bridge-sessions.json` |
| `/new list`、`/new <序号>` 使用的快捷工作区列表 JSON | `CURSOR_WORK_PRESETS_FILE` | `~/.feishu-cursor-bridge/workspace-presets.json` |
| 快捷列表为空时的种子路径（仅首次初始化） | `CURSOR_WORK_PRESETS` | 无默认；不设置则不从环境变量注入种子 |
| `cursor-agent-acp` 入口脚本（仅 `legacy`） | `CURSOR_ACP_ADAPTER_ENTRY` | 包内解析：`node_modules/@blowmage/cursor-agent-acp/dist/bin/cursor-agent-acp.js`（通过 `require.resolve` 定位包目录） |
| 启动 legacy 适配器用的 Node 可执行文件 | `ACP_NODE_PATH` | 当前进程的 Node（`process.execPath`） |

## 分条说明

### 工作区根 `CURSOR_WORK_DIR`

- **默认**：未设置或为空时，取**启动桥接服务时的当前工作目录**，并解析为绝对路径。
- **含义**：ACP 新会话的默认工作目录、客户端文件沙箱的默认根目录；`/status`（调试）里也会显示为「默认工作区」。
- **注意**：若用 `npm start` 在项目根启动，默认通常是**项目仓库根目录**；若在其它目录执行，默认即为那个目录。

### 工作区白名单 `CURSOR_WORK_ALLOWLIST`

- **默认**：未设置时，列表里**只有** `CURSOR_WORK_DIR` 解析后的那一个根路径。
- **含义**：`/reset`、`/new` 里填写的工作区路径必须落在某个允许根之下（见 `src/workspace-policy.ts`）。

### ACP 后端 `ACP_BACKEND` / `CURSOR_AGENT_PATH`

- **`ACP_BACKEND` 默认**：`official`
- **`CURSOR_AGENT_PATH` 默认**：`agent`
- **含义**：默认拉起 Cursor 官方 `agent acp`；仅在需要回滚时再切到 `legacy`

### 适配器会话目录 `CURSOR_ACP_SESSION_DIR`

- **默认**：`~/.feishu-cursor-bridge/cursor-acp-sessions`
- **含义**：仅在 `ACP_BACKEND=legacy` 时传给上游 `cursor-agent-acp` 的 `--session-dir`，用于适配器侧会话相关文件，与飞书映射文件是分开的。

### 飞书会话映射 `BRIDGE_SESSION_STORE`

- **默认**：`~/.feishu-cursor-bridge/.feishu-bridge-sessions.json`（与用户级配置同目录，不随 `CURSOR_WORK_DIR` 变化）。
- **含义**：持久化「飞书会话 → ACP `sessionId`」等映射，便于进程重启后在支持 `loadSession` 时恢复。

### 快捷工作区列表 `CURSOR_WORK_PRESETS_FILE` 与 `CURSOR_WORK_PRESETS`

- **`CURSOR_WORK_PRESETS_FILE` 默认**：`~/.feishu-cursor-bridge/workspace-presets.json`
- **`CURSOR_WORK_PRESETS`**：逗号分隔的绝对路径；**仅在列表文件为空时**用于首次种子初始化，不设则没有来自该变量的默认列表。

### 适配器入口与 Node `CURSOR_ACP_ADAPTER_ENTRY` / `ACP_NODE_PATH`

- **适配器脚本默认路径**：仅在 `ACP_BACKEND=legacy` 时，从已安装的 `@blowmage/cursor-agent-acp` 包目录解析出 `dist/bin/cursor-agent-acp.js`（实现见 `src/acp/paths.ts`）。
- **Node 默认**：当前运行桥接进程的 Node 可执行文件路径，仅用于启动 legacy 适配器。

## 与 README 的关系

环境变量一览仍以根目录 `README.md` 中的表格为准；本文侧重**默认落盘位置**与路径之间的关系，便于排查「文件写到了哪里」。
