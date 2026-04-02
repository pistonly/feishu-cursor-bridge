# 飞书桥接：`/reply` 手动重发上一轮缓存回复

- status: resolved
- related_modules: src/bridge.ts, src/session-manager.ts, src/parse-new-conversation.ts, src/parse-new-conversation.test.ts, src/session-manager.test.ts, docs/feishu-commands.md
- related_memory: [2026-03-28-2100-feishu-card-patch-fix.md](./2026-03-28-2100-feishu-card-patch-fix.md), [2026-03-29-2356-cursor-official-acp-landed.md](./2026-03-29-2356-cursor-official-acp-landed.md)
- supersedes:

## 背景

在官方 ACP 后端下，用户曾遇到“Cursor CLI 多次工具调用时，飞书端未及时看到完整内容，但切换到别的 session 再切回来后又能看到”的现象。

这类现象未能稳定复现，因此本轮没有直接改成“每轮结束自动补发一张新卡片”，而是先补一个更保守的人工兜底：允许用户在怀疑飞书展示漏刷时，手动把某个 session 最近一轮的缓存结果重新发出来。

## 关键结论

1. 新增 `/reply [编号或名称]`，用于重发某个 slot 在当前桥接进程内缓存的“上一轮提问 + 回复”。
2. `/reply` 不切换 session，不重新请求 ACP，也不依赖 `session/load`；只是把 `lastPrompt` / `lastReply` 重新发到飞书。
3. 不带参数时默认读取当前活跃 slot；带编号或名称时可读取指定 slot。
4. 若目标 slot 尚无缓存结果，会明确提示“暂无缓存的上一轮对话”，避免用户误以为重新触发了 Agent。
5. 本轮刻意没有引入“结束后自动补发新卡片”策略，避免在正常场景下每轮都重复发内容。

## 影响范围

- 命令解析：
  - `src/parse-new-conversation.ts`
- 会话缓存读取：
  - `src/session-manager.ts` 新增 `getSlot()`
- 飞书命令处理与卡片复用：
  - `src/bridge.ts`
- 文档与回归：
  - `docs/feishu-commands.md`
  - `src/parse-new-conversation.test.ts`
  - `src/session-manager.test.ts`

## 关联版本

- top-level: `a123ce6d80eabdb16f389b1b8d31fb3801d8685e`
- working tree:
  - 本条 memory 对应代码已提交并推送到上面的 commit
  - 当前工作区仍为 dirty，仅包含本地约定不入库目录：`.cursor/`、`.worktree/`、`memory/`、`reference/`

## 当前状态

- 已完成：
  - `/reply` 已落地，支持当前活跃 slot 和指定 slot 两种用法。
  - 类型检查与相关测试通过。
  - 提交已推送到 `origin/main`。
- 未完成：
  - 仍未稳定复现最初“多工具调用后飞书漏显示”的问题。
  - 目前只提供手动兜底，尚未对飞书展示链路增加自动恢复策略。

## 后续建议

1. 若问题再次出现，优先复核文件日志和 `ACP_RELOAD_TRACE_LOG`，区分是 ACP 未推事件、bridge 丢字段，还是飞书卡片 patch 展示异常。
2. 若后续确认“最终结果已缓存但原卡片常漏刷”，再评估是否增加“仅在异常条件下触发”的自动补发，而不是默认每轮都补发。
3. 若要进一步改善多工具场景可见性，可继续把 `tool_call_update.rawOutput`、`locations` 等 richer tool 状态映射到飞书端，而不只显示工具标题与状态。
