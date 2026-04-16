# Legacy Backend Notes

记录时间：2026-04-11，补充更新：2026-04-16

## 已验证现状

- 本机实验入口：`node vendor/cursor-agent-acp/dist/bin/cursor-agent-acp.js`
- 使用的构建产物：仓库内 `vendor/cursor-agent-acp/dist/`
- `initialize` 宣告能力：
  - `loadSession: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.audio: false`
  - `promptCapabilities.embeddedContext: true`
  - `mcpCapabilities.http: false`
  - `mcpCapabilities.sse: false`
  - `sessionCapabilities._meta.supportsSessionModes: true`
  - `sessionCapabilities._meta.supportsSetMode: true`
  - `sessionCapabilities._meta.supportsSetModel: true`
  - `_meta.streaming: true`
  - `_meta.toolCalling: true`
  - `_meta.fileSystem: true`
  - `_meta.terminal: true`
  - `_meta.cursorAvailable: true`
- `authMethods`：空数组（`[]`）

## 真实行为探针结论

- `newSession`：成功
- `loadSession`：成功
- `session/set_mode`：成功
- `session/set_model`：成功，但必须使用 legacy backend 自己的 alias 风格 model id
- `session/list`：失败，`Method not found`
- `session/close`：失败，`Method not found`

## 真实返回的 mode / model

- modes:
  - `agent`
  - `plan`
  - `ask`
- models:
  - alias 风格值
  - 示例：`auto`
  - 示例：`gpt-5.4-medium`

## 2026-04-16 真实 `/compact` / `/clear` / `/summary` / `/summarize` Probe

- bridge 层没有内置 `/compact`、`/clear`、`/summary`、`/summarize`
- 对 `cursor-legacy` 来说，这些 slash 文本会被透传给 `cursor-agent-acp` 当前 session，再由底层 `cursor-agent --resume ... agent --print` 当作普通 prompt 处理
- 当前真实 `available_commands_update` 只宣告了两个命令：
  - `plan`
  - `model`
- 没有宣告 `compact`、`clear`、`summary`、`summarize`

### `/compact`

- 发送 `/compact` 后，返回的是一段“紧凑摘要”，内容把 marker 和 filler 总结出来
- 没有出现类似“上下文已压缩”的固定协议回执
- 之后追问 marker，仍返回 `MARKER_LEGACY_COMPACT_20260416_C7P4`

结论：

- `/compact` 在 `cursor-legacy` 下不是后端真实命令
- 它只是被模型按“请给出一份紧凑摘要”理解，不是真实压缩 session 上下文

### `/clear`

- 发送 `/clear` 后，返回的是“当前对话里我不再依赖此前的上下文”一类自然语言文案
- 但随后追问 marker，仍返回 `MARKER_LEGACY_CLEAR_20260416_J5N8`

结论：

- `/clear` 也不是 `cursor-legacy` 的真实清空命令
- 它更像是模型对“忽略前文/重新开始”意图的口头响应，而不是真正清空上下文

### `/summary`

- 发送 `/summary` 后，模型输出了一段“对话摘要”
- 过程中还触发了工具去查仓库与文档，说明它把 `/summary` 当作普通任务理解，而不是固定后端命令
- 之后追问 marker，仍返回 `MARKER_LEGACY_SUMMARY_20260416_T3Q1`

### `/summarize`

- 发送 `/summarize` 后，模型同样输出了一段“会话摘要”
- 之后追问 marker，仍返回 `MARKER_LEGACY_SUMMARIZE_20260416_V9K2`

结论：

- `/summary` / `/summarize` 在 `cursor-legacy` 下都不是后端原生命令
- 当前只应把它们理解为普通 prompt；其中 `/summary` 还可能触发模型自行查项目文档后再回答

## 注意点

- legacy backend 的 model id 语义与 official backend 不同
- legacy 使用 alias 风格 model id，而不是 official backend 的完整 selector
- 不能把 official 返回的 selector（例如带 `[]` / `reasoning=` / `context=` 的值）直接传给 legacy `session/set_model`
- `newSession` 返回中 `_meta.cursorChatId` 仍是 bridge 侧恢复链路的重要字段
- legacy backend 当前宣告的命令只有 `plan`、`model`
- `compact`、`clear`、`summary`、`summarize` 当前都没有被观察到是真实后端能力

## 当前判断

- legacy backend 的 capability 宣告与真实行为整体一致
- 当前 bridge 对 legacy 的 `/mode`、`/model` 路由方式基本合理
- 当前 bridge 对 legacy 的恢复逻辑依赖 `cursorChatId` 是正确方向
- 但 legacy 当前没有观察到额外的上下文管理 slash command；`/compact`、`/clear`、`/summary`、`/summarize` 都不应被当作稳定能力

## 后续改进方向

- 增加 legacy backend 的真实集成测试：
  - `newSession`
  - `loadSession`
  - `set_mode`
  - `set_model`
- 若后续升级 `cursor-agent` / `cursor-agent-acp`，优先复测以下兼容点：
  - `available_commands_update` 是否新增 `compact` / `clear` / `summary` / `summarize`
  - `/compact` 后是否仍只是摘要，而非真实上下文压缩
  - `/clear` 后是否仍能回忆先前 marker
  - `/summary` / `/summarize` 是否仍只是普通 prompt 行为
- 在 README 中明确 legacy 与 official 的模型参数差异：
  - 两者都应优先以当前 ACP session 返回的值为准
  - bridge 可额外提供统一的 `/model <序号>` 入口，底层仍映射为 session 返回的精确值
- 若后续增加 `/model` 的跨 backend 提示，应明确提醒用户不要混用 official / legacy 的模型值
