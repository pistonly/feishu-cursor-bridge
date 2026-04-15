# Claude Backend Notes

记录时间：2026-04-11

## 已验证现状

- 本机实际探测版本：`@agentclientprotocol/claude-agent-acp@0.26.0`
- `initialize` 宣告能力：
  - `loadSession: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.embeddedContext: true`
  - `mcpCapabilities.http: true`
  - `mcpCapabilities.sse: true`
  - `sessionCapabilities.fork`
  - `sessionCapabilities.list`
  - `sessionCapabilities.resume`
  - `sessionCapabilities.close`
  - `_meta.claudeCode.promptQueueing: true`
- `authMethods`：空数组（`[]`）

## 真实行为探针结论

- `newSession`：成功
- `listSessions`：成功
- `loadSession`：成功
- `closeSession`：成功
- `session/set_mode`：成功，但必须使用 Claude backend 返回的真实 mode id
- `session/set_model`：成功，但必须使用 Claude backend 返回的真实 model id

## 真实返回的 mode / model

- modes:
  - `auto`
  - `default`
  - `acceptEdits`
  - `plan`
  - `dontAsk`
  - `bypassPermissions`
- models:
  - `default`
  - `sonnet[1m]`
  - `opus[1m]`
  - `haiku`

## 注意点

- 用 `agent` 这类 Cursor 风格 mode id 调用 `session/set_mode` 会失败，错误为 `Invalid Mode`
- `newSession` / `loadSession` 会返回 `modes`、`models`、`configOptions`，bridge 应优先使用这些真实返回值
- 上游返回的 `modes.availableModes` 中至少有一项字段拼写为 `decription`，不是 `description`

## 当前判断

- Claude backend 的 capability 宣告与真实行为整体一致
- 当前 bridge 对 Claude 的 `/mode`、`/model` 路由方式基本合理
- 主要风险不是 capability 缺失，而是误用其它 backend 的 mode id / model id

## 后续改进方向

- 给 `claude` 增加真实集成测试：`newSession`、`loadSession`、`set_mode`、`set_model`
- 在 README 中补充 Claude backend 的真实 mode/model 示例值，避免用户误用 Cursor 风格参数
- 对上游返回中的 `decription` / `description` 差异做兼容兜底，避免展示信息丢失

## 另见

- 直接使用 `@anthropic-ai/claude-agent-sdk` 获取 `usage` / `modelUsage` / `getContextUsage()` 的实测记录见 [docs/claude-agent-sdk-context-notes.md](/home/liuyang/Documents/feishu-bridge/feishu-cursor-bridge/docs/claude-agent-sdk-context-notes.md)
