# Legacy Backend Notes

记录时间：2026-04-11

## 已验证现状

- 本机实验入口：`node cursor-agent-acp/dist/bin/cursor-agent-acp.js`
- 使用的构建产物：仓库内 `cursor-agent-acp/dist/`
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

## 注意点

- legacy backend 的 model id 语义与 official backend 不同
- legacy 使用 alias 风格 model id，而不是 official backend 的完整 selector
- 不能把 official 返回的 selector（例如带 `[]` / `reasoning=` / `context=` 的值）直接传给 legacy `session/set_model`
- `newSession` 返回中 `_meta.cursorChatId` 仍是 bridge 侧恢复链路的重要字段

## 当前判断

- legacy backend 的 capability 宣告与真实行为整体一致
- 当前 bridge 对 legacy 的 `/mode`、`/model` 路由方式基本合理
- 当前 bridge 对 legacy 的恢复逻辑依赖 `cursorChatId` 是正确方向

## 后续改进方向

- 增加 legacy backend 的真实集成测试：
  - `newSession`
  - `loadSession`
  - `set_mode`
  - `set_model`
- 在 README 中明确 legacy 与 official 的模型参数差异：
  - legacy 用 alias
  - official 用 ACP session 返回的精确 selector
- 若后续增加 `/model` 的跨 backend 提示，应明确提醒用户不要混用 official / legacy 的模型值
