# Claude Agent SDK Context Notes

记录时间：2026-04-15

## 实测结论

- TypeScript SDK 可以直接拿最终 token 使用量：`result.usage`
- TypeScript SDK 可以直接拿按模型拆分的使用量：`result.modelUsage`
- TypeScript SDK 可以直接拿当前 session 的 context 占用：`await query.getContextUsage()`

## 推荐依赖的字段

### 1. 最终总 usage

来自 `result.usage`：

- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`

### 2. 按模型拆分 usage

来自 `result.modelUsage`：

- 每个模型的 `inputTokens`
- `outputTokens`
- `cacheReadInputTokens`
- `cacheCreationInputTokens`
- `costUSD`
- `contextWindow`
- `maxOutputTokens`

注意：`contextWindow` 是模型窗口上限，不是当前已占用量。

### 3. 当前 context 占用

来自 `await query.getContextUsage()`：

- `totalTokens`
- `maxTokens`
- `rawMaxTokens`
- `percentage`
- `model`
- `categories[]`
- `memoryFiles[]`

其中 `percentage` 就是当前 context 占用百分比。

## 不建议依赖的字段

- 流式 `assistant.message.usage`

在本次实验里，流式 assistant 消息上的 `usage` 一直是 0。统计应优先使用：

- `result.usage`
- `result.modelUsage`
- `query.getContextUsage()`

## 调用时机

- `query.getContextUsage()` 适合在 query 活跃期间调用
- query 结束后再调 control request，可能报 `Query closed before response received`
- 如果你想看“这一轮结束后的 context”，更稳妥的方式是下一次 `resume` 该 session 后立刻再调一次 `getContextUsage()`

## 仓库内可复用探针

已整理为：

- [poc/probes/claude-agent-sdk-context-probe.ts](/home/liuyang/Documents/feishu-bridge/feishu-cursor-bridge/poc/probes/claude-agent-sdk-context-probe.ts)

它导出了两个可直接复用的函数：

- `getClaudeContextSnapshot(query)`
- `runClaudeContextProbe(options)`

## 最小示例

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Reply with exactly OK.",
  options: {
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});

const context = await q.getContextUsage();
console.log(context.totalTokens, context.maxTokens, context.percentage);

for await (const message of q) {
  if (message.type === "result") {
    console.log(message.usage);
    console.log(message.modelUsage);
  }
}
```

## 运行探针

本仓库没有把 `@anthropic-ai/claude-agent-sdk` 加进正式依赖，避免影响主项目。

要运行该探针，先在任意目录安装：

```bash
npm install @anthropic-ai/claude-agent-sdk tsx
```

然后执行：

```bash
npx tsx poc/probes/claude-agent-sdk-context-probe.ts "Reply with exactly OK."
```

运行前提：

- 本机 `claude` / Claude Code 认证已可用
- 若使用 `permissionMode: "bypassPermissions"`，需同时设置 `allowDangerouslySkipPermissions: true`
