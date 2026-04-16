# 默认文件与目录路径

本文说明桥接服务在未设置相关环境变量时，会使用哪些**默认路径**。所有路径在运行时都会解析为**绝对路径**；配置里若写成以 `~/` 开头，会展开为当前用户主目录（见 `src/config/index.ts` 中的 `expandHome`）。

## 概览

| 用途 | 环境变量 | 默认 / 说明 |
|------|----------|-------------|
| 允许作为会话工作区的根路径列表（**必填**） | `BRIDGE_WORK_ALLOWLIST`（兼容 `CURSOR_WORK_ALLOWLIST`） | 无默认值；须显式配置逗号分隔绝对路径，至少一项；不存在则尝试 `mkdir -p` |
| ACP 子进程 `spawn` 的 `cwd` | （派生） | 取 **`BRIDGE_WORK_ALLOWLIST`（兼容 `CURSOR_WORK_ALLOWLIST`） 中第一项**；与各 session 的 `cwd` 独立 |
| ACP 后端选择 | `ACP_BACKEND` | `cursor-official` |
| 启动时启用的 backend 列表 | `ACP_ENABLED_BACKENDS` | 默认仅包含 `ACP_BACKEND` 当前值 |
| 官方 ACP 命令 | `CURSOR_AGENT_PATH` | `agent` |
| service PATH 注入的 Conda 根目录 | `CONDA_ROOT` | 自动探测 `~/miniconda3`，否则 `~/anaconda3` |
| service PATH 注入的 Conda 环境名 | `CONDA_ENV_NAME` | `base`；若 Conda 或对应 env 不存在则跳过 |
| `cursor-agent-acp` 适配器会话目录（仅 `legacy`） | `CURSOR_LEGACY_SESSION_DIR`（兼容 `CURSOR_ACP_SESSION_DIR`） | `~/.feishu-cursor-bridge/cursor-acp-sessions` |
| 飞书 ↔ ACP 会话映射持久化 JSON | `BRIDGE_SESSION_STORE` | `~/.feishu-cursor-bridge/.feishu-bridge-sessions.json` |
| `/new list`、`/new <序号>` 使用的快捷工作区列表 JSON | `BRIDGE_WORK_PRESETS_FILE`（兼容 `CURSOR_WORK_PRESETS_FILE`） | `~/.feishu-cursor-bridge/workspace-presets.json` |
| 快捷列表为空时的种子路径（仅首次初始化） | `BRIDGE_WORK_PRESETS`（兼容 `CURSOR_WORK_PRESETS`） | 无默认；不设置则不从环境变量注入种子 |
| `cursor-agent-acp` 入口脚本（仅 `legacy`） | — | 与桥接启动方式一致，**无单独环境变量**：**`node dist/index.js`** → **`vendor/cursor-agent-acp/dist/bin/cursor-agent-acp.js`**（`npm install` 的 `postinstall` 会 `build:adapter`）；**`tsx src/index.ts`**（`npm run dev`）→ **`vendor/cursor-agent-acp/src/bin/cursor-agent-acp.ts`** + **tsx** |
| 启动 legacy 适配器用的 Node 可执行文件 | `CURSOR_LEGACY_NODE_PATH`（兼容 `ACP_NODE_PATH`） | 当前进程的 Node（`process.execPath`） |

## 分条说明

### 工作区白名单 `BRIDGE_WORK_ALLOWLIST`（兼容 `CURSOR_WORK_ALLOWLIST`）

- **必填**：未设置或解析后为空时，桥接**拒绝启动**。
- **含义**：`/new <路径>`、快捷列表中的目录、读文件沙箱校验等，均要求路径落在**某一个**允许根之下（见 `src/session/workspace-policy.ts`）。用户须先用 `/new list` / `/new <序号>` 或 `/new <路径>` **显式创建 session**，普通消息不会在无 session 时自动建会话。
- **目录**：列表中每一项若尚不存在，启动时会尝试 `mkdir -p`（与旧版单一路径行为一致）；若创建失败则启动报错。
- **顺序**：列表**第一项**同时用作拉起官方/legacy ACP 子进程时的 `cwd`（与具体 Agent 会话的工作区是两套概念）。

### ACP 后端 `ACP_BACKEND` / `ACP_ENABLED_BACKENDS` / `CURSOR_AGENT_PATH`

- **`ACP_BACKEND` 默认**：`cursor-official`
- **`ACP_ENABLED_BACKENDS` 默认**：未设置时，仅启用 `ACP_BACKEND` 当前值
- **`CURSOR_AGENT_PATH` 默认**：`agent`
- **含义**：`ACP_BACKEND` 决定默认 backend；`ACP_ENABLED_BACKENDS` 决定启动时实际拉起哪些 backend，以及 `/new --backend <...>` 允许选择哪些值
- **常见场景**：若默认仍想用 `cursor-official`，但又希望在飞书里临时切到 `cursor-legacy` / `cursor-tmux` / `claude`，应显式配置 `ACP_ENABLED_BACKENDS=cursor-official,cursor-legacy,cursor-tmux,claude`

### service PATH 的 Conda 注入 `CONDA_ROOT` / `CONDA_ENV_NAME`

- **作用范围**：仅影响 `bash service.sh install` / `bash service.sh update` 生成的 launchd / systemd 服务 PATH；不会改写你当前交互式 shell 的环境。
- **`CONDA_ENV_NAME` 默认**：`base`
- **`CONDA_ROOT` 默认**：未设置时按顺序探测 `~/miniconda3`、`~/anaconda3`
- **注入规则**：若检测到 Conda 且目标环境存在，则将对应 `bin` 目录追加到服务 PATH 最前面；`base` 使用 `<conda-root>/bin`，其他环境使用 `<conda-root>/envs/<env-name>/bin`。
- **缺失处理**：若未安装 Conda、根目录不存在、或目标环境不存在，则自动跳过，不会阻止服务安装 / 更新。

### 适配器会话目录 `CURSOR_LEGACY_SESSION_DIR`（兼容 `CURSOR_ACP_SESSION_DIR`）

- **默认**：`~/.feishu-cursor-bridge/cursor-acp-sessions`
- **含义**：仅在 `ACP_BACKEND=cursor-legacy` 时传给上游 `cursor-agent-acp` 的 `--session-dir`，用于适配器侧会话相关文件，与飞书映射文件是分开的。

### 飞书会话映射 `BRIDGE_SESSION_STORE`

- **默认**：`~/.feishu-cursor-bridge/.feishu-bridge-sessions.json`
- **含义**：持久化「飞书会话 → ACP `sessionId`」等映射，便于进程重启后在支持 `loadSession` 时恢复。

### 快捷工作区列表 `BRIDGE_WORK_PRESETS_FILE`（兼容 `CURSOR_WORK_PRESETS_FILE`） 与 `BRIDGE_WORK_PRESETS`（兼容 `CURSOR_WORK_PRESETS`）

- **`BRIDGE_WORK_PRESETS_FILE`（兼容 `CURSOR_WORK_PRESETS_FILE`） 默认**：`~/.feishu-cursor-bridge/workspace-presets.json`
- **`BRIDGE_WORK_PRESETS`（兼容 `CURSOR_WORK_PRESETS`）**：逗号分隔的绝对路径；**仅在列表文件为空时**用于首次种子初始化，不设则没有来自该变量的默认列表。

### 适配器入口与 Node `CURSOR_LEGACY_NODE_PATH`（兼容 `ACP_NODE_PATH`）

- **适配器脚本路径**（仅 `ACP_BACKEND=cursor-legacy`）：固定相对**桥接仓库根目录**解析（`src/config/index.ts` / `src/acp/paths.ts`），规则与桥接自身一致——主进程为 **`dist/index.js`** → 适配器 **`vendor/cursor-agent-acp/dist/bin/cursor-agent-acp.js`**；主进程为 **`tsx …/src/index.ts`**（`npm run dev`）→ **`vendor/cursor-agent-acp/src/bin/cursor-agent-acp.ts`** + **tsx**。克隆后需 `npm install` 以生成生产用 `dist/`。
- **Node 默认**：当前运行桥接进程的 Node 可执行文件路径，仅用于在 `cursor-legacy` 下启动本仓 `cursor-agent-acp`。

## 与 README 的关系

环境变量一览仍以根目录 `README.md` 中的表格为准；本文侧重**默认落盘位置**与路径之间的关系，便于排查「文件写到了哪里」。`vendor/cursor-agent-acp/` 的历史参考见 [third-party.md](third-party.md)。
