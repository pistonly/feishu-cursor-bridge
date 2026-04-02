# ACP `session/prompt` 流式链路修复

- status: resolved（`src/acp/runtime.ts`、`patches/@blowmage+cursor-agent-acp+0.7.1.patch`）
- related_modules: acp/runtime, conversation-service（经 `acp.prompt` 间接使用）, feishu-bridge-client（`session/update` 消费）, @blowmage/cursor-agent-acp/dist/protocol/prompt.js, @blowmage/cursor-agent-acp/dist/cursor/cli-bridge.js
- related_memory: [2026-03-28-2100-feishu-card-patch-fix.md](./2026-03-28-2100-feishu-card-patch-fix.md)

## 背景

最初的判断是：上游 `@blowmage/cursor-agent-acp` 在 `session/prompt` 处理链路中额外识别可选字段 `stream`，因此桥接只要固定传 `stream: true`，就应走流式分支。

但实际验证发现：

- 命令行直接运行 `cursor-agent --print --output-format stream-json --stream-partial-output` 时，确实会持续输出增量事件。
- 飞书侧最初仍表现为非流式，且适配器日志显示实际执行的仍是 `cursor-agent --print --output-format json`。
- 继续排查后确认，不是飞书渲染链路问题，而是 ACP 请求参数和适配器流式解析两侧各有一个兼容性缺口。

## 关键结论

1. 仅在桥接里传顶层 `stream: true` 不足以打通当前链路。`@agentclientprotocol/sdk` 的 `zPromptRequest` 会在 Agent 侧校验时剥掉顶层未知字段，因此 `stream` 到达适配器时会变成 `undefined`，适配器退回非流式 `sendPrompt()`，日志表现为 `--output-format json`。
2. 当前 `cursor-agent` 的 `stream-json` 输出格式也与 `@blowmage/cursor-agent-acp@0.7.1` 的假设不一致。CLI 实际输出的是 NDJSON 事件流，事件形态类似 `assistant` / `thinking` / `result`，而不是“每个 stdout data chunk 都是一个完整 `ContentBlock`”。
3. 要让飞书端真正看到增量，需要同时修两处：
   - 在桥接请求里把流式开关放进 `_meta.stream`，绕过 SDK 对顶层未知字段的剥离。
   - 在适配器里按行解析 NDJSON，提取 `assistant.message.content` 中的文本块，并去掉流尾那条最终完整快照造成的重复。
4. 飞书端现有 `bridgeClient` `acp` 事件和卡片串行 `patch` 逻辑无需改协议；修完上游适配器兼容层后，现有展示链路即可工作。

## 影响范围

- `src/acp/runtime.ts`
  - `prompt()` 现在同时传顶层 `stream: true` 和 `_meta.stream: true`。
- `node_modules/@blowmage/cursor-agent-acp/dist/protocol/prompt.js`
  - 读取 `stream ?? _meta.stream`，避免顶层 `stream` 被 SDK schema 剥掉后退回非流式。
- `node_modules/@blowmage/cursor-agent-acp/dist/cursor/cli-bridge.js`
  - 改为按行拆 NDJSON。
  - 识别 `assistant` 事件里的 `message.content`。
  - 对最终完整 assistant 快照做去重，避免增量后再整段重复一遍。
- `patches/@blowmage+cursor-agent-acp+0.7.1.patch`
  - 已更新为当前补丁的持久化来源；`postinstall` 会通过 `patch-package` 重放该修复。

## 关联版本

- top-level: `61b576a3221f6dadf3a2326cd6da673ea8a0028a`（`feat(acp): 为 session/prompt 启用 stream 以使用 cursor-agent 流式输出`）
- working tree:
  - 相关未提交改动：`src/acp/runtime.ts`、`patches/@blowmage+cursor-agent-acp+0.7.1.patch`
  - 相关运行时本地补丁：`node_modules/@blowmage/cursor-agent-acp/dist/protocol/prompt.js`、`node_modules/@blowmage/cursor-agent-acp/dist/cursor/cli-bridge.js`（由 `patch-package` 补丁固化）
  - 其他无关未提交改动：`.gitignore`、`package-lock.json`，以及本地 `memory/`、`reference/` 目录

## 当前状态

- 已完成：
  - 定位到“顶层 `stream` 被 SDK schema 剥掉”这一真实根因。
  - 定位到 `@blowmage/cursor-agent-acp@0.7.1` 对当前 `cursor-agent stream-json` 事件格式的解析不兼容。
  - 本地已修复桥接和适配器两侧兼容层，并更新 `patch-package` 补丁。
  - 用户复测后确认：飞书端已成功表现为流式。
- 未完成：
  - 这些修复目前仍处于未提交 working tree。
  - 上游 `@blowmage/cursor-agent-acp` 仍未吸收该兼容性修复。

## 后续建议

1. 若后续升级 `@agentclientprotocol/sdk`、`@blowmage/cursor-agent-acp` 或 `cursor-agent`，优先回归验证两点：`_meta.stream` 是否仍可透传，以及 `stream-json` 事件格式是否变化。
2. 有时间的话可向上游 `@blowmage/cursor-agent-acp` 提 issue 或 PR，说明两个兼容问题：
   - 顶层 `stream` 会被 SDK `PromptRequest` schema 剥掉。
   - `stream-json` 实际是 NDJSON 事件流，不应按单个 stdout chunk 直接 `JSON.parse()`。
3. 在未来相关 memory 或提交说明里，优先把这次问题表述为“SDK schema 剥离 + 适配器流式事件解析不兼容”，不要再简化成“只要固定传 `stream: true` 即可”。
