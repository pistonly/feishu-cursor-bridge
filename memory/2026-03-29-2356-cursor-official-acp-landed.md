# Cursor 官方 ACP 默认后端落地

- status: resolved
- related_modules: src/config.ts, src/acp/runtime-contract.ts, src/acp/sdk-runtime-base.ts, src/acp/runtime.ts, src/acp/official-runtime.ts, src/bridge.ts, src/session-manager.ts, src/conversation-service.ts, src/index.ts, src/feishu-bridge-client.test.ts, src/acp-streaming-regression.test.ts, README.md, docs/default-paths.md, .env.example
- related_memory: [2026-03-29-2228-cursor-official-acp-summary.md](./2026-03-29-2228-cursor-official-acp-summary.md), [2026-03-29-acp-prompt-stream-true.md](./2026-03-29-acp-prompt-stream-true.md)
- supersedes: [2026-03-29-2228-cursor-official-acp-summary.md](./2026-03-29-2228-cursor-official-acp-summary.md)

## 背景

在前一条评估记录里，已经确认 Cursor 官方 `agent acp` 适合作为中长期集成方向，但当时主线仍默认依赖 `@blowmage/cursor-agent-acp`，而且本地通过 `patch-package` 持续维护 streaming、session timeout 和 session 恢复兼容补丁，维护成本偏高。

本轮目标是把“评估 + 原型”推进到“主线可运行的默认实现”：保留当前桥接的会话管理、飞书渲染和命令体系，只替换底层 ACP runtime，并将默认后端切换到官方 ACP。

## 关键结论

1. 主线已完成 ACP runtime 抽象，上层模块不再直接依赖第三方适配器实现细节。
2. 新增了基于官方 `agent acp` 的 `OfficialAcpRuntime`，与 legacy 后端共享 `@agentclientprotocol/sdk` + `FeishuBridgeClient` 客户端链路。
3. 默认后端已从 `legacy` 切换为 `official`；若线上需要紧急回滚，仍可显式设置 `ACP_BACKEND=legacy`。
4. 官方后端下，当前主线已有的多 slot、持久化恢复、`session/load` 探活、线程隔离、飞书卡片事件渲染都继续沿用，没有退回到 `office-acp` 原型的简化实现。
5. 官方后端的真实 smoke test 已通过：
   - `start -> initialize -> newSession -> prompt` 链路可跑通；
   - `session/update` 会持续推送 `agent_thought_chunk` / `agent_message_chunk`，不是整段结束后一次性回包；
   - 重启运行时后，`session/load` 能恢复前一轮上下文。
6. 官方 ACP 当前仍未暴露与 legacy `cursorCliChatId` 对等的 CLI resume 字段，因此 `/status` 仅在 legacy 下展示该值；这是目前保留 legacy 回滚路径的主要功能差异之一。

## 影响范围

- 运行时抽象与双后端工厂：
  - `src/acp/runtime-contract.ts`
  - `src/acp/sdk-runtime-base.ts`
  - `src/acp/runtime.ts`
  - `src/acp/official-runtime.ts`
- 保持行为一致的上层接入：
  - `src/bridge.ts`
  - `src/session-manager.ts`
  - `src/conversation-service.ts`
  - `src/index.ts`
- 默认配置与文档：
  - `src/config.ts`
  - `.env.example`
  - `README.md`
  - `docs/default-paths.md`
- 回归测试：
  - `src/acp-streaming-regression.test.ts`
  - `src/session-manager.test.ts`
  - `src/feishu-bridge-client.test.ts`

## 关联版本

- top-level: `b6b38befaea81ae481325eb5693b20395a4ae2a6`
- working tree:
  - 本条 memory 对应代码已提交到上面的 commit
  - 当前工作区仍为 dirty，仅包含本地约定不入库目录：`.cursor/`、`.worktree/`、`memory/`、`reference/`

## 当前状态

- 已完成：
  - 默认后端切换为官方 ACP。
  - legacy 回滚开关保留。
  - 类型检查与本地测试通过。
  - 普通启动方式已验证默认走 `official`，无需再手动注入 `ACP_BACKEND=official`。
- 未完成：
  - 尚未移除 `@blowmage/cursor-agent-acp` 依赖、`patch-package` 和 legacy 代码路径。
  - 仍需观察一段真实使用期，确认官方后端在长期会话、权限请求与文件系统回调上没有隐性回退。

## 后续建议

1. 在真实使用中继续重点观察三类场景：长输出流式回复、`session/load` 恢复、需要读写文件或权限确认的任务。
2. 若官方后端稳定一段时间后无回退，再考虑移除 `@blowmage/cursor-agent-acp`、补丁文件和 legacy runtime。
3. 若后续必须恢复 CLI resume continuity，可再评估官方 ACP 是否新增等价字段，或是否需要单独保留 legacy 模式供该能力使用。
