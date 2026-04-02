# tmux 交互式 Cursor Runtime PoC 总结

- status: active
- related_modules: `poc/tmux-runtime`, `src/session-manager.ts`, `src/session-store.ts`, `src/acp/runtime-contract.ts`
- related_memory:
- supersedes:

## 背景

本轮工作的目标是评估并验证一个基于 `tmux` 的交互式 Cursor CLI 运行时，作为当前 legacy 后端的潜在替代方向。

现有 legacy 链路基于 `cursor agent --print` 做适配，能力面受限；目标方案是改为驱动交互式 `cursor agent`，以获得更完整、更接近真实 CLI 的能力，同时保留 `resume`、多轮上下文和更好的本地可观测性。

核心难点不是“如何启动 `cursor agent`”，而是：

- 如何从 `tmux` 稳定拿到交互式输出
- 如何判断一轮回复已经结束
- 如何在 bridge 语义下持久化和恢复 `tmux pane <-> session slot`

## 关键结论

- `tmux` 下运行交互式 `cursor agent` 是可行的，`capture-pane` 和 `tmux -C` control mode `%output` 两条链路都已验证可用。
- 单靠 `%output` 不适合直接当自然语言输出消费，因为里面包含大量 ANSI 控制序列、重绘帧、spinner 和标题变化。
- 第一版稳定完成判定应采用“双信号组合”：
  - `capture-pane` 负责判断 UI 是否回到 idle
  - `control mode` 负责判断最近是否还有输出/忙碌事件
- `Cursor Agent` 的 idle 态目前可用如下启发式识别：
  - 界面仍然显示 `Add a follow-up`
  - 不再出现 `ctrl+c to stop`
  - 不再出现 `Generating` / `Reading` / `Globbing` / `Searching` 等 busy 标记
- 已经抽出共享检测模块 `poc/tmux-runtime/cursor-agent-detector.ts`，集中实现：
  - UI ready / busy / idle 识别
  - `%output` 语义信号提取
  - turn completion 状态机
- 已经做出最小会话原型 `poc/tmux-runtime/tmux-cursor-session.ts`，支持：
  - `attach()`
  - `startAgent()`
  - `runPrompt()`
  - `cancelCurrentTurn()`
  - `captureCurrentSnapshot()`
  - `stop()`
  - `close()/destroy()`
- 已经做出 `tmux slot` 持久化原型，结构刻意对齐主项目的 `session-store.ts` / `session-manager.ts`：
  - `poc/tmux-runtime/tmux-slot-store.ts`
  - `poc/tmux-runtime/tmux-slot-registry.ts`
- `TmuxSlotRegistry.restoreActiveSlot()` 已实现并验证：
  - 先 probe 旧 pane
  - 如果 pane 失效，则自动 rebuild 新 pane
  - 然后回写 active slot 绑定

## 影响范围

- 新增 PoC 目录：`poc/tmux-runtime`
- 关键文件：
  - `poc/tmux-runtime/cursor-agent-detector.ts`
  - `poc/tmux-runtime/observe-pane.ts`
  - `poc/tmux-runtime/observe-control-mode.ts`
  - `poc/tmux-runtime/tmux-cursor-session.ts`
  - `poc/tmux-runtime/tmux-slot-store.ts`
  - `poc/tmux-runtime/tmux-slot-registry.ts`
  - `poc/tmux-runtime/run-session.ts`
  - `poc/tmux-runtime/cancel-session.ts`
  - `poc/tmux-runtime/persisted-slot-demo.ts`
  - `poc/tmux-runtime/recover-slot-demo.ts`
- 与主项目未来最相关的对接点：
  - `src/acp/runtime-contract.ts`
  - `src/session-manager.ts`
  - `src/session-store.ts`

## 关联版本

- top-level: `5677df960e8a7f3d3f9094f94a63ed1fe2c72c7a` + working tree
- working tree 摘要：
  - 当前未提交目录至少包含 `poc/`、`memory/`、`.worktree/`、`reference/`、`.cursor/.gitignore`
- 本条 memory 主要对应未提交工作区中的 `poc/tmux-runtime` 原型，不对应单独提交

## 当前状态

- 已完成：
  - 验证 `tmux` 可承载交互式 `cursor agent`
  - 验证 `capture-pane` 与 `control mode` 两条输出链路
  - 实现并验证 turn completion 检测器
  - 实现并验证最小 `TmuxCursorSession`
  - 实现并验证绑定已有 pane
  - 实现并验证取消当前回复
  - 实现并验证 slot 持久化后重新 attach
  - 实现并验证 stale pane 自动重建并继续对话
- 未完成：
  - 还没有真正接入现有 `BridgeAcpRuntime`
  - 还没有给 `TmuxCursorSession` 做“CLI resume 语义”，目前更接近“绑定已有 pane”
  - 还没有把 `TmuxSlotRegistry` 直接接进主项目的 `SessionManager`
  - 还没有统一处理 model/mode switch、close 语义与 bridge 层命令集

## 后续建议

- 第一优先级：设计一个更正式的 runtime contract，明确 `tmux` 后端是否继续复用现有 `BridgeAcpRuntime`，还是提升成更一般的 runtime abstraction。
- 第二优先级：把 `TmuxSlotRegistry` 的接口继续收敛，尽量贴近 `src/session-manager.ts` 的恢复语义，特别是：
  - `getOrCreate`
  - `restore`
  - `switch active slot`
  - `close/reset`
- 第三优先级：为 `TmuxCursorSession` 增加真正的 `resume` 语义，而不是仅靠 `paneId` 复用已有 pane。
- 第四优先级：评估如何把 `replyText` 提取逻辑从“最佳努力”提升为更稳定的最终回复抽取器，避免复杂回答中混入 UI 噪音。
