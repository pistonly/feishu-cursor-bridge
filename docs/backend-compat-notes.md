# Backend Compatibility Notes

记录时间：2026-04-13

本文件汇总以下 4 个 backend 的真实探针结果：

- `cursor-official`
- `cursor-legacy`
- `claude`
- `codex`

对应详细记录：

- `docs/official-backend-notes.md`
- `docs/legacy-backend-notes.md`
- `docs/claude-backend-notes.md`
- `docs/codex-backend-notes.md`

## 一览结论

| backend | `initialize` 宣告是否基本可信 | `loadSession` | `set_mode` | `set_model` | `session/cancel` | `session/list` | `session/close` | model 语义 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cursor-official` | 部分可信 | 宣告支持；对刚创建 session 的探针失败 | 实测可用，但未明确宣告 | 实测可用，但未明确宣告 | 未单独复测 | 不可用 | 不可用 | **精确 selector** |
| `cursor-legacy` | 基本可信 | 可用 | 可用 | 可用 | 未单独复测 | 不可用 | 不可用 | **alias 风格** |
| `claude` | 基本可信 | 可用 | 可用 | 可用 | 未单独复测 | 可用 | 可用 | Claude 自身返回值 |
| `codex` | 不完全可信 | 宣告支持；对真实历史 session 可用，但对刚新建 session 的临时探针不稳定 | 实测可用，但未明确宣告 | 实测可用，但未明确宣告 | 实测可用；真实 prompt 被中断并返回 `stopReason=cancelled` | 可用 | 可用 | Codex 自身返回值 |

## `initialize` 宣告对比

| backend | `loadSession` | `promptCapabilities` | `mcpCapabilities` | `sessionCapabilities` | 其它显著字段 |
| --- | --- | --- | --- | --- | --- |
| `cursor-official` | `true` | `image=true` `audio=false` `embeddedContext=false` | `http=true` `sse=true` | 未宣告 `list/close/setMode/setModel` | `authMethods=[cursor_login]` |
| `cursor-legacy` | `true` | `image=true` `audio=false` `embeddedContext=true` | `http=false` `sse=false` | `_meta.supportsSessionModes=true` `_meta.supportsSetMode=true` `_meta.supportsSetModel=true` | `_meta.streaming/toolCalling/fileSystem/terminal=true` |
| `claude` | `true` | `image=true` `embeddedContext=true` | `http=true` `sse=true` | `fork` `list` `resume` `close` | `_meta.claudeCode.promptQueueing=true` |
| `codex` | `true` | `image=true` `audio=false` `embeddedContext=true` | `http=true` `sse=false` | `list` `close`，未宣告 `setMode/setModel` | `auth.logout` + ChatGPT/OpenAI/Codex API key 登录方式 |

## 实测 RPC 对比

| backend | `newSession` | `loadSession` | `setSessionMode` | `setSessionModel` | `cancelSession` | `listSessions` | `closeSession` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cursor-official` | 成功 | 对刚创建 session 失败，报 `Session not found` | 成功 | 成功，但必须传精确 selector | 未单独复测 | `Method not found` | `Method not found` |
| `cursor-legacy` | 成功 | 成功 | 成功 | 成功，但必须传 legacy alias | 未单独复测 | `Method not found` | `Method not found` |
| `claude` | 成功 | 成功 | 成功，但必须传 Claude mode id | 成功 | 未单独复测 | 成功 | 成功 |
| `codex` | 成功 | 对真实历史 session 成功；对刚创建 session 的临时探针曾返回 `Resource not found` | 成功，但必须传 Codex mode id | 成功，但必须传 Codex model id | 成功；真实 prompt 被取消后返回 `cancelled` | 成功 | 成功 |

## mode 语义对比

| backend | 实测 mode 值 |
| --- | --- |
| `cursor-official` | `agent` `plan` `ask` |
| `cursor-legacy` | `agent` `plan` `ask` |
| `claude` | `auto` `default` `acceptEdits` `plan` `dontAsk` `bypassPermissions` |
| `codex` | `read-only` `auto` `full-access` |

结论：`/mode` 参数不能跨 backend 复用。尤其是：

- `agent` 对 Claude 不合法
- `agent` 对 Codex 不合法
- `read-only` / `full-access` 是 Codex 特有语义
- `acceptEdits` / `dontAsk` / `bypassPermissions` 是 Claude 特有语义

## model 语义对比

| backend | model 值类型 | 示例 |
| --- | --- | --- |
| `cursor-official` | **ACP session 返回的精确 selector** | `gpt-5.4[reasoning=medium,context=272k,fast=false]` `default[]` |
| `cursor-legacy` | **alias 风格** | `auto` `gpt-5.4-medium` |
| `claude` | Claude backend 自身返回值 | `default` `sonnet[1m]` `opus[1m]` `haiku` |
| `codex` | Codex backend 自身返回值 | `gpt-5.4/medium` `gpt-5.3-codex/high` |

结论：`/model` 参数绝不能跨 backend 复用。尤其是：

- official 不能用 legacy alias 替代精确 selector
- legacy 不能用 official selector
- Claude / Codex 也必须使用各自 session 返回的值

## 当前 bridge 设计的正确点

- bridge 侧 `/model` 采用“按当前 session 返回的可用模型列表做精确值 / 序号解析”是正确的
- legacy backend 的恢复链路依赖 `cursorChatId` 是正确的
- Claude backend 用 `resumeSessionId` 做恢复绑定是正确的
- Codex backend 需要少量特判，因为其 capability 宣告不完整

## 已知不一致 / 风险点

### 1. `initialize` 不能被绝对信任

- `cursor-official` 未宣告 `set_mode` / `set_model`，但实测可用
- `codex` 未宣告 `set_mode` / `set_model`，但实测可用
- `cursor-official` 宣告了 `loadSession: true`，但对刚创建 session 的探针失败
- `codex` 宣告了 `loadSession: true`，但对刚创建 session 的临时探针不稳定

### 2. `session/list` / `session/close` 支持矩阵差异很大

- `official` / `legacy`：不可用
- `claude` / `codex`：可用

### 2.5 `session/cancel` 必须看真实探针，不能只看 bridge UI

- bridge 层的 `/stop` 只是调用 ACP `session/cancel`
- 若 runtime 吞掉 `cancel` 异常，飞书侧可能误报“已发送中断请求”
- 当前项目已修正为不再吞掉 `cancel` 失败
- `codex` 已在真实 prompt 上验证 `session/cancel -> stopReason=cancelled`

### 3. mode/model 值完全是 backend-specific

- 不能做统一常量表然后全 backend 复用
- 必须优先使用当前 session 实际返回的 `modes/models/configOptions`

## 后续建议

### 协议兼容策略

- 保持“优先参考 `initialize`，但对已知 backend 允许兼容特判”的策略
- 对 `official` / `codex`，不要仅凭 capability 缺失就禁用 `/mode` 或 `/model`
- 对 `loadSession`，不要仅凭 `initialize.loadSession === true` 就假设恢复一定成功

### 测试补强

- 增加四个 backend 的真实集成测试矩阵：
  - `newSession`
  - `loadSession`
  - `set_mode`
  - `set_model`
  - `cancelSession`
  - `listSessions`
  - `closeSession`
- 单独补“宣告与真实行为不一致”的回归测试

### 文档补强

- README 增加 backend 差异表：
  - mode 值来源
  - model 值来源
  - 是否支持 `list/close/load`
- 明确告诉用户：
  - official 用精确 selector
  - legacy 用 alias
  - Claude / Codex 用各自 session 返回值
