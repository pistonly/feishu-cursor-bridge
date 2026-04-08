# 飞书端支持的命令

本文说明由 **飞书-Cursor 桥接服务**（`src/bridge.ts`）直接识别并处理的命令。其它以 `/` 开头的文本若未命中下表，会作为普通对话交给 Cursor Agent（`cursor-agent-acp`），行为与 Cursor 客户端内类似。**例外**：首条非空行以 `/topic` 开头的消息会被桥接直接忽略，不交给 Agent（见下文）。

## 私聊与群聊

| 场景 | 要求 |
|------|------|
| **私聊** | 直接发送命令或消息即可。 |
| **群聊** | 必须先 **@机器人**，再输入命令或 `@机器人 + 内容`；命令必须紧跟在 @ 之后，且整条消息以 `/` 开头才会被识别为命令（与实现一致）。 |
| **「双人」群** | 群内仅一名普通用户且仅一名机器人时，可不 @，直接发消息（与私聊类似）。 |
| **话题群** | 不同话题（`thread_id`）下 **session 槽位相互隔离**，与主楼消息不共享；`/sessions`、`/switch` 等仅在当前话题内生效。 |

## 多 Session 管理

同一用户在同一聊天中可以同时持有**多个** session（最多 5 个），每个 session 对应一个独立的 Cursor Agent 上下文与工作区。可以在多个 session 之间自由切换，切走的 session 保持 ACP 连接，不会被关闭。

此外，同一飞书用户**跨所有私聊、群、话题**的存活 session 总数有默认上限（**10**，可用环境变量 `BRIDGE_MAX_SESSIONS_PER_USER` 调整；设为 `0` 表示不限制），与「单聊天最多 5 个」是两层独立限制。

### Session 标识

每个 session 有一个从 1 开始的**编号**（全局递增，已关闭的编号不复用），以及一个可选的**名称**。

---

## 桥接内置命令

### 命令列表（`/commands`、`/help`、单独 `/`）

**等价命令**：`/commands`、`/help`、`/帮助`。

仅发送一个字符 **`/`**（ASCII U+002F）或全角 **`／`**（U+FF0F），且整段消息去掉首尾空白后**仅有该字符**时，与 `/help` 等价（便于快速唤起帮助）。

**作用**：机器人回复本桥接内置命令的分类列表（精简版）；正文会说明当前 ACP 后端下 **`/model` / `/mode`** 是由桥接调 ACP，还是原样交给 Cursor CLI（`tmux` 后端）。回复内容由 `src/bridge-commands-help.ts` 中的 `formatBridgeCommandsHelp` 生成。

**无需 session**：与 `/status` 类似，**没有活跃 session 也可使用**；无 session 时的统一提示里也会引导使用本组命令。

---

### 话题标题（`/topic`）

这是**普通文本命令**（与 `/sessions`、`/new` 一样由用户手打），格式为：

```text
/topic
/topic <话题内容>
```

示例：`/topic 后端 API 重构`、`/topic`。`/topic` 后须为**词边界**（空格、行尾等），避免与 `/topics` 等混淆。

桥接行为：对 **msg 原文按行拆分**（保留换行），每行单独去掉 @ / `<at>` 后，若**任意一行**以 `/topic` 开头（命令），则**整条消息**不发给 Cursor Agent、不回复；消息仍显示在飞书里。命中时进程日志会出现 `[bridge] /topic ignored — no session, no ACP prompt`。

---

### 1. 新建 session（`/new`）

**等价命令**：`/new`（同 `/new list`）、`/new list`、`/new <路径>`、`/new <快捷序号>`

**作用**：在当前聊天下**新建一个 session** 并自动切换到它，旧 session 保持 ACP 连接。工作区须落在环境变量 **`CURSOR_WORK_ALLOWLIST`** 配置的允许根之下。

**用法**：

```text
/new
```

与 **`/new list`** 相同，列出快捷工作区列表（不创建 session）：

```text
/new
/new list
```

指定本地目录为该 session 的工作区：

```text
/new /home/you/project
/new ~/projects/my-app
/new "/path/with spaces/in name"
```

使用快捷列表中第 N 项作为工作区：

```text
/new 1
/new 2
```

新建时附加一个名称（便于后续用名称切换）：

```text
/new --name backend
/new ~/projects/api --name api
/new 1 --name frontend
```

> 若已达到**当前聊天** 5 个 session 上限，会提示先用 `/close` 关闭一个。若已达到**同一用户全局**存活 session 上限，会提示在其它会话中 `/close` 或等待空闲过期。

#### 工作区快捷列表

顺序保存在服务端的 JSON 文件中（默认 `~/.feishu-cursor-bridge/workspace-presets.json`，可用 `CURSOR_WORK_PRESETS_FILE` 覆盖）。

| 命令 | 说明 |
|------|------|
| `/new list` | 列出当前快捷列表及序号（`1.`、`2.` …）；裸 `/new` 与此相同。 |
| `/new add-list <路径>` | 将**已存在且允许**的目录加入列表；重复路径不会重复添加。 |
| `/new remove-list <序号>` | 按序号从列表中删除一项（不影响当前 session）。 |

---

### 2. 查看所有 session（`/sessions`）

```text
/sessions
```

列出当前聊天下所有 session，标注活跃的那个，并显示各自的工作区路径。

---

### 3. 切换 session（`/switch`）

```text
/switch <编号或名称>
/switch          （不带参数：切换到上一次使用的 session）
```

切换到指定的 session，**不会关闭当前 session 的 ACP 连接**。

不带参数时，会直接切换到当前聊天里**上一次使用的 session**；如果没有其它可切换的 session，会提示使用 `/sessions` 查看列表。

**示例**：

```text
/switch 2
/switch backend
```

---

### 4. 重发上一轮回复（`/reply`）

```text
/reply
/reply <编号或名称>
```

重发某个 session **当前桥接进程内缓存的上一轮对话**，不切换 session，也不会重新向 ACP 发起请求。

- 不带参数时：重发**当前活跃 session** 的上一轮提问与回复。
- 带编号或名称时：重发指定 session 的上一轮提问与回复。
- 若当前进程里还没有缓存到该 slot 的上一轮结果，会提示“暂无缓存的上一轮对话”。

**示例**：

```text
/reply
/reply 2
/reply backend
```

---

### 5. 中断当前回复（`/stop` / `/cancel`）

```text
/stop
/cancel
```

**作用**：打断**当前活跃 session（当前槽位）**正在进行中的模型回复（桥接对该 ACP session 调用 SDK `cancel`，即 **`session/cancel` 通知**）。**不会**关闭 session，之后可照常发消息继续对话。

仅作用于**当前活跃槽位**：其它槽位若在并行生成，需先 `/switch` 到对应槽位再发 `/stop`。若当前活跃槽位没有进行中的生成，会提示并说明可先切换槽位。

与 `/close` 的区别：`/close` 会关闭并移除 session；本命令仅中断本轮输出。

---

### 6. 关闭 session（`/close`）

```text
/close <编号或名称>
/close all
```

关闭并移除指定的 session（发送 ACP cancel + close），释放资源。若关闭后该聊天/话题下已无任何 session，会从持久化中移除该 topic，**释放同一用户全局 session 配额**；之后在该处发消息会新建 session。多槽时仅移除指定槽；只剩一个槽时关闭即整 topic 清空（与闲置过期清理后效果类似）。

`/close all` 会一次性关闭**当前聊天/话题组内**的全部 slot，效果等同于对该组内每个 session 逐个执行 `/close`，便于快速腾出全局配额。关键字 `all` 为保留用法；若某 slot 的显示名称恰好为 `all`，请用编号关闭（如 `/close 2`）。

**示例**：

```text
/close 3
/close frontend
/close all
```

---

### 7. 重命名 session（`/rename`）

```text
/rename <新名字>
/rename <编号或名称> <新名字>
```

默认会重命名**当前活跃 session**；也可以显式指定编号或旧名称。重命名后可以继续用新名字执行 `/switch` 或 `/close`。

**示例**：

```text
/rename backend
/rename 2 backend
/rename frontend "frontend-v2"
```

说明：

- 同一聊天内，session 名称不能重复。
- 新名字支持空格；如有空格，请用引号包裹。

---

### 8. 切换模式（`/mode`）

```text
/mode
/mode <模式ID>
```

**作用**：

- `official` / `legacy` 后端：查看或切换当前活跃 session 的 ACP mode，**不会**把整条消息再发给大模型。
- `tmux` 后端：bridge 会把 `/mode ...` 原样发给真实的交互式 Cursor CLI pane，由 CLI 自己处理；bridge 不再维护一个“权威 mode 列表”。

后端差异：

- `official` / `legacy` 不带参数时：返回当前 session 已知的可用模式列表与当前模式。
- `official` / `legacy` 带参数时：调用 ACP `session/set_mode` 切换当前 session 模式。
- `tmux` 后端下，无论是否带参数，都会把 `/mode` 原样发给 Cursor CLI，由 CLI 自己展示或切换。

**示例**：

```text
/mode
/mode plan
/mode ask
/mode agent
```

说明：

- 当前官方 ACP 实测会返回 `agent`、`plan`、`ask` 三个核心模式；实际仍以当前 session 返回的 `availableModes` 为准。
- 本桥接当前只提供显式 `/mode` 入口；`/plan ...`、`/ask ...` 等其它 slash 命令若未被桥接识别，仍按普通消息透传给 Agent。

---

### 9. 通过飞书发文件（`/sendfile`）

```text
/sendfile <任务说明>
```

**作用**：把 `<任务说明>` 发给当前活跃 session 的 Agent，并在其**前面自动附加**一段固定说明，告知模型：若要把工作区内的文件发给飞书用户，须在回复中用**单独一行** `FEISHU_SEND_FILE: <路径>`（可与现有 `src/feishu-send-file.ts` 行为一致，多条文件则多行）。飞书卡片展示前会去掉这些指令行并执行实际上传。

- **无需 session**：与普遍对话相同，若无活跃 session 会提示先 `/new`。
- **多行**：`/sendfile` 后可换行继续写需求，自第一行去掉 `/sendfile ` 后的全部内容均视为用户任务。
- **与裸发任务的区别**：仅发文字时模型可能不知道 `FEISHU_SEND_FILE` 约定；本命令减少重复说明。

仅发送 `/sendfile` 而无正文时，机器人会回复用法提示。

---

### 10. 状态（`/status`）

**等价命令**：`/status`、`/状态`

**作用**：返回当前桥接 session 统计（活跃与内存中的 slot 总数），以及当前 ACP 后端信息；在 `official` / `legacy` 后端下，还会附带当前活跃 session 已知的 mode。

**增强信息**：当服务环境 **`BRIDGE_DEBUG=true`** 时，同一条回复中会追加调试信息，包括：

- 当前 `sessionKey`、活跃 slot 编号与名称、ACP `sessionId`
- 当前 session **cwd**（工作区绝对路径）
- 空闲过期时间（若 `SESSION_IDLE_TIMEOUT_MS=0` 或 `infinity` 则显示为“永不过期”）、`CURSOR_WORK_ALLOWLIST` 根列表与 ACP 子进程 spawn cwd（列表首项）
- 适配器会话目录、映射文件路径、`loadSession` 能力、日志级别等

同一环境下，群聊因未 @ 被忽略时的**服务端日志**字段说明见下文「群聊 @ 与调试日志」。

---

### 11. 切换模型（`/model`）

**格式**：

```text
/model
/model <模型ID>
/model <序号>
```

**作用**：

- `legacy` / `official` 后端：bridge 直接调用 ACP `session/set_model` 切换**当前活跃 session** 的模型，**不会**把整条消息再发给大模型（避免仅出现「解释 /model」类回复）。
- `tmux` 后端：bridge 会把 `/model ...` 原样发给真实的交互式 Cursor CLI pane，由 CLI 自己处理；此时不走 ACP `session/set_model`，也不依赖 bridge 侧缓存的模型列表。

**示例**：

```text
/model
/model 2
/model composer-2[fast=true]
```

**可用模型 ID / selector**：

- 默认 `official` 后端下，以**当前 ACP session 返回的 `availableModels`** 为准，而不是 `cursor-agent models` 的 alias 列表。
- 机器人返回列表时，反引号中的值就是可直接提交给 ACP `session/set_model` 的**精确 selector**；若带 `[]` 或其它参数后缀，必须完整带上。
- `official` 后端下，列表会带 `【n】` 序号，可直接使用 `/model <序号>`；桥接会按当前 session 的可用模型列表做 1-based 解析。
- `legacy` / `official` 后端下，若当前 session 尚未拿到模型状态，机器人会回退到基础用法提示；此时请先让该 slot 建立/恢复 session 并完成一轮交互，再使用模型 id、selector 或序号（仅 `official`）。

未带参数时：

- `legacy` / `official` 后端下，若当前 session 已拿到模型状态，机器人会直接返回可用模型列表与当前模型；否则回退到基础用法提示。
- `tmux` 后端下，会把 `/model` 原样发给 Cursor CLI，由 CLI 自己展示当前模型或可选项。

---

## 典型多 Session 工作流

```
你：/new list            → 查看快捷工作区列表
你：/new 1               → 用列表第 1 项创建 session #1（须已在 allowlist 内）
你：/sessions            → 查看当前 session 列表
你：/new ~/proj-b --name proj-b   → 新建 session #2，工作区为 ~/proj-b（须在 allowlist 下）
你：（对话，针对 proj-b）
你：/switch 1            → 切回 session #1（proj-b 保持 ACP 连接）
你：（继续对话，针对原来的工作区）
你：/switch proj-b       → 用名称切换回 session #2
你：/close 1             → 关闭 session #1
```

---

## 非命令消息

不以以上**桥接内置命令**（含单独 `/` / `／` 唤起命令列表）形式匹配的文本，在**当前聊天/话题下已有活跃 session** 时进入正常对话流程（流式卡片、Cursor Agent 等）。**若无 session**，机器人会提示先用 `/new list` 与 `/new <序号或路径>` 创建，并说明可用 `/commands`、`/help` 或只发 `/`（全角 `／` 亦可）查看全部桥接命令。若适配器在 Cursor 侧注册了 `/plan` 等斜杠命令，通常需**整段消息**以 `/命令` 开头发送；具体以 `cursor-agent-acp` 与 Cursor CLI 行为为准，本桥接不对其做单独解析。

## 群聊 @ 与调试日志（`BRIDGE_DEBUG`）

当 **`BRIDGE_DEBUG=true`** 时，若某条群消息**未被识别为 @ 机器人**（且不满足「双人」群免 @），桥接会在**服务端日志**中打印一条结构化信息（`getGroupMentionIgnoredDebug`），便于对照飞书事件与机器人身份：

| 字段 | 含义 |
|------|------|
| `messageMentionIds` | 从消息里解析出的 **结构化 @ id**（与 `isBotMentioned` 判定逻辑一致，含 `mentions` 与 `inlineMentionIds`）。 |
| `bot` | 当前进程从 **`open-apis/bot/v3/info`** 拉取的机器人 `open_id` / `user_id` / `union_id` 快照；`resolved` 为 `false` 表示未解析到任一 id，此时群聊 **@ 判定恒为无效**。 |
| `bot.openId` / `userId` / `unionId` | 已 trim；若与 `messageMentionIds` 中任一值一致，理论上应被识别为 @ 机器人。 |
| `hint` | 简短中文说明可能原因（未解析机器人 id、无结构化 @、id 与机器人不一致、或解析异常等）。 |
| `chatId` / `threadId` | 所在群与话题（话题群排查时关注 `threadId`）。 |

> 该日志仅用于排错，**不**出现在飞书用户可见的回复里；与 `/status` 的调试增强同属 `BRIDGE_DEBUG` 能力。

## 相关环境变量（节选）

| 变量 | 与命令的关系 |
|------|----------------|
| `CURSOR_WORK_ALLOWLIST` | **必填**；逗号分隔的绝对路径，会话工作区必须落在某一允许根下；ACP 子进程 spawn 的 cwd 为列表首项。 |
| `CURSOR_WORK_PRESETS_FILE` | 可选；`/new list` 使用的快捷列表 JSON 路径。 |
| `CURSOR_WORK_PRESETS` | 可选；列表文件为空时用于首次写入的初始路径（逗号分隔）。 |
| `SESSION_IDLE_TIMEOUT_MS` | 可选；控制 session 空闲多久后视为过期。设为 `0` 或 `infinity` 表示永不过期。 |
| `BRIDGE_DEBUG` | 为 `true` 时：`/status` 追加调试详情；群聊「未 @ 且未命中双人群」时在**服务端日志**输出结构化对照（见上文「群聊 @ 与调试日志」）。 |

更多变量见项目根目录 `.env.example`。
