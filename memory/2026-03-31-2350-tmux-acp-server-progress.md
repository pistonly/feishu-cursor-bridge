# tmux ACP server 原型进展

- status: active
- related_modules: `poc/tmux-runtime`, `src/acp/runtime-contract.ts`, `src/acp/runtime.ts`, `src/session-manager.ts`
- related_memory:
  - `memory/2026-04-02-1120-tmux-runtime-summary.md`
- supersedes:

## 背景

本轮工作不再停留在“tmux 能不能驱动交互式 Cursor CLI”的 PoC 阶段，而是继续往“把它包装成 ACP 协议后端”推进。

目标已经明确：

- 不是做一个仅供当前飞书桥接内部调用的小型 runtime
- 而是做一个基于 `tmux` 的、可复用的 ACP server
- 该 server 需要保留交互式 `cursor agent` 的能力面，并且通过 `cursorCliChatId` 获得真正的 resume 语义

## 关键结论

- `cursor agent create-chat` 可以稳定拿到独立的 `cursorCliChatId`，不需要从交互 UI 中反向提取。
- `TmuxCursorSession` 已升级为真正的 resume 语义：
  - 首次启动先执行 `cursor agent create-chat`
  - 然后使用 `cursor agent --resume <cursorCliChatId>` 拉起交互式会话
- `cursorCliChatId` 已接入持久化链路：
  - `TmuxCursorSession.describeBinding()`
  - `tmux-slot-store.ts`
  - `tmux-slot-registry.ts`
- 已验证“pane 销毁后重建，仍复用同一个 `cursorCliChatId` 并继续原上下文”。
- 已实现最小 stdio ACP server 原型 `poc/tmux-runtime/tmux-acp-server.ts`，并基于 SDK `AgentSideConnection` 打通：
  - `initialize`
  - `newSession`
  - `loadSession`
  - `session/list`
  - `prompt`
  - `cancel`
  - `unstable_resumeSession`
  - `unstable_closeSession`
- ACP `sessionId` 与底层 `cursorCliChatId` 已解耦：
  - ACP 层使用自己的 `sessionId`
  - server 自己持久化 `sessionId -> tmux pane / cursorCliChatId`
  - server 重启后仍可通过 `loadSession(sessionId)` 找回同一个 Cursor chat
- 一个关键工程化修正已经完成：
  - `TmuxCursorSession` 原先把调试日志打到 `stdout`
  - 这会污染 ACP 的 NDJSON 通道
  - 现已增加 `verbose` 开关，并在 ACP server 中默认关闭，避免协议流被破坏

## 影响范围

- 主要新增文件：
  - `poc/tmux-runtime/tmux-acp-session-store.ts`
  - `poc/tmux-runtime/tmux-acp-server.ts`
  - `poc/tmux-runtime/tmux-acp-smoke.ts`
  - `poc/tmux-runtime/tmux-acp-cancel-smoke.ts`
  - `poc/tmux-runtime/resume-chatid-demo.ts`
- 主要更新文件：
  - `poc/tmux-runtime/tmux-cursor-session.ts`
  - `poc/tmux-runtime/tmux-slot-store.ts`
  - `poc/tmux-runtime/tmux-slot-registry.ts`
  - `poc/tmux-runtime/recover-slot-demo.ts`
  - `poc/tmux-runtime/persisted-slot-demo.ts`
  - `poc/tmux-runtime/run-session.ts`
  - `poc/tmux-runtime/README.md`

## 验证结果

- `run-session.ts` 已验证默认链路走的是 `create-chat + --resume`，能正常完成一轮回答。
- `resume-chatid-demo.ts` 已验证：
  - 第一轮让 agent 记住口令 `BANANA`
  - 销毁原 pane 后 rebuild 新 pane
  - 第二轮仍回答 `BANANA`
- `tmux-acp-smoke.ts` 已验证：
  - `newSession -> prompt -> server 重启 -> loadSession -> prompt -> closeSession`
  - 第一轮记住口令 `PAPAYA`
  - server 重启后再次 `loadSession(sessionId)`，第二轮仍回答 `PAPAYA`
- `tmux-acp-cancel-smoke.ts` 已验证：
  - 长 prompt 发出后通过 ACP `session/cancel`
  - 最终 `session/prompt` 返回 `stopReason: cancelled`
- `npm run typecheck -- --pretty false` 已通过

## 当前状态

- 已完成：
  - tmux 驱动交互式 Cursor CLI
  - turn completion 检测
  - pane 绑定/恢复/重建
  - 基于 `cursorCliChatId` 的真实 resume 语义
  - 最小 ACP server 原型
  - ACP 层 `loadSession` / `cancel` 端到端验证
- 未完成：
  - `session/prompt` 仍是“整轮完成后聚合文本”返回，不是 token 级流式 ACP 输出
  - mode/model 目前只有最小持久化与回显，还没有真正驱动底层 Cursor CLI
  - 还没有接入主项目的 `BridgeAcpRuntime` 三选一后端体系

## 后续建议

- 第一优先级：把 `TmuxCursorSession` 的语义信号进一步映射成 ACP `session/update` 增量流，减少当前“整轮后一次性输出”的粗粒度问题。
- 第二优先级：设计主项目如何接入这套 server。
  - 方案 A：让 bridge 把它当第三种 ACP 后端启动
  - 方案 B：让 bridge 通过单独的 runtime 适配层直连这个 server
- 第三优先级：明确 `cursorCliChatId` 在 bridge session / ACP session / slot 三层之间的归属与同步规则，避免后续恢复链路混乱。
