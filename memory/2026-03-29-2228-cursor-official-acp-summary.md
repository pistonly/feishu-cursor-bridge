# Cursor 官方 ACP 迁移评估

- status: active
- related_modules: src/acp/runtime.ts, src/session-manager.ts, src/bridge.ts, src/conversation-service.ts, src/feishu-renderer.ts, .worktree/feishu-cursor-bridge-wt-acp/src/cursor-acp.ts, .worktree/feishu-cursor-bridge-wt-acp/src/bridge.ts, .worktree/feishu-cursor-bridge-wt-acp/src/session-manager.ts
- related_memory: [2026-03-29-acp-prompt-stream-true.md](./2026-03-29-acp-prompt-stream-true.md)
- supersedes:

## 背景

当前主线通过 `@blowmage/cursor-agent-acp` 对接 ACP，并在本地通过 `patch-package` 修复了流式输出、session timeout 与 session 丢失重建等兼容问题。由于这条链路维护成本偏高，开始评估是否改为直接接入 Cursor 官方 `agent acp`。

本次调研同时覆盖两部分：

- Cursor 官方对 ACP 的公开支持情况。
- 本仓库 `.worktree/feishu-cursor-bridge-wt-acp` 中 `office-acp` 分支，相对当前主线是否具备可直接切换的条件。

## 关键结论

1. Cursor 已公开提供官方 ACP 支持，不是隐藏接口。官方文档入口为 `https://cursor.com/docs/cli/acp`，启动方式是 `agent acp`，通信模型为 `stdio + JSON-RPC 2.0 + NDJSON`。
2. 官方文档明确把 ACP 定位为 `advanced integrations`，并给出了自定义客户端、JetBrains、Neovim、Zed 等集成场景，说明它适合作为长期集成方向。
3. 官方 ACP 当前存在公开限制：ACP 模式支持项目级/用户级 `.cursor/mcp.json`，但不支持 Cursor dashboard 中配置的 team-level MCP。
4. `office-acp` 分支的核心方向是正确的：它已经不依赖 `@blowmage/cursor-agent-acp`，而是自己直接拉起 `agent acp`，手写 JSON-RPC 客户端消费 `session/update`。
5. 但 `office-acp` 目前只适合作为迁移原型，不适合直接替换主线。它相较当前主线存在明显功能回退：
   - 没有持久化会话存储。
   - 没有多 slot / `/switch` / `/close` / `/sessions` / 工作区预设。
   - 没有群话题 `threadId` 级隔离。
   - `initialize` 时声明 `fs.readTextFile=false`、`fs.writeTextFile=false`、`terminal=false`，无法提供当前主线已有的文件系统桥接能力。
   - 飞书侧主要只消费 `agent_message_chunk` 文本，没有接入主线里已有的 `tool_call`、`tool_call_update`、`plan`、`current_mode_update`、`available_commands_update` 等 richer events。
   - 没有测试覆盖。
6. 因此，结论不是“不要迁移到官方 ACP”，而是“不要直接切到当前的 `office-acp` 分支”；更合理的路线是保留主线现有的会话管理/飞书渲染/命令体系，只替换底层 ACP transport。

## 影响范围

- 官方支持确认：
  - Cursor Docs: `https://cursor.com/docs/cli/acp`
  - ACP 协议概览: `https://agentclientprotocol.com/protocol/overview`
- 当前主线（third-party adapter 路线）：
  - `src/acp/runtime.ts`
  - `src/session-manager.ts`
  - `src/conversation-service.ts`
  - `src/feishu-renderer.ts`
  - `patches/@blowmage+cursor-agent-acp+0.7.1.patch`
- `office-acp` 原型分支（官方 ACP 路线）：
  - `.worktree/feishu-cursor-bridge-wt-acp/src/cursor-acp.ts`
  - `.worktree/feishu-cursor-bridge-wt-acp/src/bridge.ts`
  - `.worktree/feishu-cursor-bridge-wt-acp/src/session-manager.ts`
  - `.worktree/feishu-cursor-bridge-wt-acp/src/config.ts`

## 关联版本

- top-level: `f3f42cc5d74b36499cb8674ff0d86fb3dae3d70d`
- office-acp worktree: `03694388cfed9edb408cfd4b252b83c8ec159380`
- working tree:
  - 顶层主线存在未提交改动：`.gitignore`、`package-lock.json`、`memory/`、`reference/`
  - `.worktree/` 是本地 worktree，不应纳入 Git 提交范围

## 当前状态

- 已完成：
  - 确认 Cursor 官方已公开支持 ACP，且文档入口、调用流程、认证方式都已清晰。
  - 确认 `office-acp` 分支是“直连官方 ACP”的轻量原型，而不是继续包装第三方适配器。
  - 对比出 `office-acp` 与当前主线在会话管理、文件系统、命令体系、飞书渲染、测试覆盖等方面的差距。
- 未完成：
  - 尚未给 `office-acp` 做 feature parity 补齐。
  - 尚未制定正式迁移计划、灰度路径或回滚方案。

## 后续建议

1. 把“迁移到官方 ACP”定义为中期目标，而不是立即切换分支。
2. 优先整理一份 feature parity 清单，按“必须先做 / 可后做”拆分，至少先补齐：
   - 持久化会话与恢复
   - 多 slot / `/switch` / `/close` / `/sessions`
   - `threadId` 级隔离
   - 文件系统能力
   - 权限请求闭环
   - `session/update` richer event 到飞书卡片的映射
   - 基本回归测试
3. 实施上优先保留当前主线的 `SessionManager`、`ConversationService`、`FeishuCardState` 和命令层，只替换 ACP transport，避免一次性丢掉太多已验证功能。
4. 若后续继续调研官方 ACP，重点关注两点：
   - 官方 ACP 是否提供足够稳定的 `session/load` / streaming / permission 行为，能覆盖当前主线需求。
   - 官方 ACP 在 fs / terminal / Cursor extension methods 上，是否足以替代第三方适配器现有能力。
