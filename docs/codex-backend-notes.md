# Codex Backend Notes

记录时间：2026-04-13

## 已验证现状

- 本机实际探测版本：`@zed-industries/codex-acp@0.11.1`
- `initialize` 宣告能力：
  - `loadSession: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.audio: false`
  - `promptCapabilities.embeddedContext: true`
  - `mcpCapabilities.http: true`
  - `mcpCapabilities.sse: false`
  - `sessionCapabilities.list`
  - `sessionCapabilities.close`
  - `auth.logout`
- `authMethods`：`chatgpt`、`CODEX_API_KEY`、`OPENAI_API_KEY`

## 真实行为与宣告不一致点

- `codex-acp` 没有在 `initialize` 中宣告 `supportsSetMode` / `supportsSetModel`
- 但对真实 session，`session/set_mode` 和 `session/set_model` 都可成功调用
- 对真实进行中的 prompt，`session/cancel` 可成功中断，并返回 `stopReason=cancelled`
- `newSession` 返回里已经包含完整 `modes` / `models` / `configOptions`
- `loadSession` 对刚新建的临时 session 探针曾返回 `Resource not found`
- `loadSession` 对 `listSessions` 中已有的真实 session 可成功

## 2026-04-13 真实 `/stop` Probe

- 探测方式：直接启动 `@zed-industries/codex-acp`，创建真实 session，发送一个刻意拉长的 prompt，再调用 ACP `session/cancel`
- 启动配置：`sandbox_mode="danger-full-access"`、`approval_policy="never"`
- 结果：
  - `cancel` RPC 成功返回
  - 对应 prompt 最终返回 `stopReason: "cancelled"`
- 结论：
  - 当前本机环境下，Codex backend 真实支持桥接 `/stop` 对应的 ACP `session/cancel`
  - 这不是 bridge 侧假成功，而是后端真实生效

## 额外注意事项

- 先前 bridge 的通用 `cancelSession()` 会吞掉后端异常，导致 `/stop` 可能误报成功
- 该问题现已修正；现在若 Codex 后端未来回归为不支持 `session/cancel`，飞书侧会显式报错

## 已做兼容处理

- bridge 的通用 capability guard 仍保留
- `codex` runtime 单独覆盖为允许 `/mode` 与 `/model`
- 仅 `cursor-legacy` 保留“认证失败疑似 Cursor CLI 超时”的文案改写

## 后续改进方向

- 给 `codex` 增加更完整的集成测试：`newSession`、`loadSession`、`set_mode`、`set_model`
- 给 `codex` 增加真实集成测试：`session/cancel -> stopReason=cancelled`
- 对 `loadSession` 增加更细的兼容判断，不要只依赖 `initialize.loadSession === true`
- 研究是否应优先基于 `newSession/loadSession` 返回的 `modes/models/configOptions` 判断能力，而不是只看 capability 宣告
- 在 README 中补充 codex 的真实行为说明：`mode/model` 可用，但当前版本 capability 宣告不完整
- 若后续升级 `codex-acp`，优先复测以下兼容点：
  - `session/set_mode` 是否仍可用
  - `session/set_model` 是否仍可用
  - `session/cancel` 是否仍返回 `stopReason=cancelled`
  - `loadSession` 对新建 session 与历史 session 的行为是否一致
  - `initialize.agentCapabilities` 是否补齐 `supportsSetMode` / `supportsSetModel`
