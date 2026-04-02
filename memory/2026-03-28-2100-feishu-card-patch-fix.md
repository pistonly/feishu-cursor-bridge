# 飞书卡片流式更新：patch 串行化

- status: resolved（逻辑已落地；发版后需按清单回归）
- related_modules: conversation-service, feishu-bot, feishu-renderer, config
- related_memory: [2026-03-28-2115-acp-timeout-long-output.md](./2026-03-28-2115-acp-timeout-long-output.md)
- supersedes: feishu-card-patch-serialization.md（非命名规范旧稿，内容已迁入本文）

## 背景

飞书桌面端与手机端有时只看到机器人回复的一部分，像被截断；**切换会话再切回**后同一条消息又显示完整。需区分：是上游 chunk 未到齐，还是桥接到飞书时更新乱序。

## 关键结论

- 多个 `agent_message_chunk` 已到达桥接并进入 `FeishuCardState`（`main` 累加正常），问题在 **桥接 → 飞书** 路径，而非上游少发 chunk。
- 根因：**多次 `im.message.patch`（`FeishuBot.updateCard`）并发**时，网络完成顺序可能与发送顺序不一致，较旧、较短的 patch 若较晚生效，飞书端会长期停留在短内容；重进会话会重新拉消息，故表现为「切回来才完整」。
- 与 `feishu-bot.ts` 中 lark_md **超长截断**（带 `_（内容过长，已截断）_`）是不同问题：后者是长度限制，不是 patch 竞态。

## 影响范围

| 说明 | 路径 |
|------|------|
| 串行化逻辑 | `src/conversation-service.ts`（`handleUserPrompt` 内 `cardPatchChain`） |
| 卡片 patch API | `src/feishu-bot.ts` → `updateCard` |
| chunk 折叠 | `src/feishu-renderer.ts` → `FeishuCardState.apply` |
| 节流 | `src/config.ts` → `bridge.cardUpdateThrottleMs` |

实现要点：`updateCard` 经链式 `Promise` 排队，上一笔完成再发下一笔；`flush(true)` 时 `await cardPatchChain`。已去掉 `flush(false).catch(() => {})`；`updateCard` 失败仍在内部 `try/catch` 中 `console.warn`。

## 关联版本

- top-level: `a12a29b33a2e31d691a237fbc5a3cbb1a4bc4dee` / **dirty**（含未提交的 `src/conversation-service.ts` 等；以工作区为准核对串行化实现）

## 当前状态

- 已完成：串行化方案与代码落点已明确并实现（以当前工作区 `conversation-service.ts` 为准）。
- 未完成：发版后在飞书端的回归验证（见下）。

## 后续建议

1. **回归**（发版或怀疑回归时）：桌面与手机同账号同时在线；触发多段 `agent_message_chunk` 的长回复，生成过程中不切会话，观察卡片是否持续长到接近最终长度；可适当减小 `cardUpdateThrottleMs` 加压；对照「切会话前后内容是否仍一致」。
2. **可选日志**：`bridgeDebug` 或临时日志记录 patch 前 `state.toMarkdown().length` 等，确认结束长度与最终正文一致；API 错误应见 `[conversation] updateCard failed`。
3. **超长回复总被掐断**：若单次流程极长（如 10 分钟量级），可能与 **ACP 超时** 有关，见 [2026-03-28-2115-acp-timeout-long-output.md](./2026-03-28-2115-acp-timeout-long-output.md)，与 patch 串行化无关时需优先怀疑上游。
