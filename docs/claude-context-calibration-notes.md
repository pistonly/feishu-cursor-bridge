# Claude Context Calibration Notes

记录时间：2026-04-16

## 背景

当前 bridge 在 `claude` backend 下展示给用户的 context 状态，主要来自 ACP `usage_update`：

- `usedTokens = result.usage.input_tokens + result.usage.output_tokens`
- `maxTokens = usage_update.size`
- `percent = usedTokens / maxTokens`

其中，`usedTokens` 不是直接来自 Claude `/context` 命令，而是通过项目内的 `patched-claude-agent-acp` 从原始 `_claude/sdkMessage` 的 `result.usage` 中提取并回填。

## 当前实现摘要

- 原始来源：`_claude/sdkMessage` 里的 `result.usage`
- bridge patch：`src/acp/patched-claude-agent-acp.ts`
- 归一化：`src/acp/events.ts`
- 运行时状态缓存：`src/acp/sdk-runtime-base.ts`

当前 patch 的核心口径是：

- `usedTokens = input_tokens + output_tokens`
- 不把 `cache_read_input_tokens` 算进分子
- 不把 `cache_creation_input_tokens` 算进分子

这套口径在普通回合下通常可用，优点是快，而且不需要额外发一条 `/context`。

## `result.usage` 实际字段

本次真实实验里，在 Claude SDK / ACP 原始 `result.usage` 上观察到这些字段：

- `input_tokens`
- `output_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `server_tool_use.web_search_requests`
- `server_tool_use.web_fetch_requests`
- `service_tier`
- `cache_creation.ephemeral_1h_input_tokens`
- `cache_creation.ephemeral_5m_input_tokens`
- `inference_geo`
- `iterations`
- `speed`

另外，`result` 顶层还会带：

- `modelUsage`

其中 `modelUsage` 会给出按模型拆分的：

- `inputTokens`
- `outputTokens`
- `cacheReadInputTokens`
- `cacheCreationInputTokens`
- `webSearchRequests`
- `costUSD`
- `contextWindow`
- `maxOutputTokens`

## 核心结论

### 1. `input_tokens + output_tokens` 不是“当前 context 快照真值”

在工具调用、web search、长回合、多次内部推理等场景下，`input_tokens + output_tokens` 更像是：

- 该回合中 Claude 实际处理过的 token 使用量

而 Claude `/context` 返回的更像是：

- 该回合结束后，当前 session 中实际保留的 context 快照

因此两者在工具-heavy 场景下会明显偏离。

### 2. 分子偏大，未必是因为把 cache 算进去了

本次实验已经确认：

- 即使分子只取 `input_tokens + output_tokens`
- 完全不把 `cache_read_input_tokens` / `cache_creation_input_tokens` 叠加进去

仍然可能明显大于 Claude `/context` 的当前快照。

也就是说，分子偏大不一定是“误把 cache 算进去了”，更可能是：

- `input_tokens` 本身就包含了工具返回、搜索结果、内部多轮处理之后的回合累计消耗
- 这个累计消耗不等于最终保留在 session 中的当前上下文占用

### 3. 当前链路里不能依赖 `server_tool_use` 来扣除工具影响

虽然 `result.usage` 里存在：

- `server_tool_use.web_search_requests`
- `server_tool_use.web_fetch_requests`

但本次实验中已经发生了真实 `Web search` 工具调用，字段仍然是：

- `web_search_requests = 0`
- `web_fetch_requests = 0`

因此当前链路下，不能依赖这些字段来推断“这轮具体有多少 token 是工具或 web search 造成的”，也就无法精确从分子里扣除。

## 已完成实验

### 实验 A：本地工具调用

让 Claude 在同一回合里：

- 创建文件
- 然后只回复固定文本

观察到：

- `usage_update.usedTokens` 与原始 `result.usage.input_tokens + output_tokens` 一致
- `prompt().usage.totalTokens` 明显更大，因为会把 `cache_read_input_tokens` 算进去

结论：

- bridge 当前 `usage_update` 分子确实来自 `input_tokens + output_tokens`
- 不是来自 `totalTokens`

### 实验 B：本地工具 + `/context`

同一 session 中，先跑一轮工具调用，再执行 `/context`。

观察到：

- 工具调用那一轮，bridge 显示的分子较大
- `/context` 文本返回的“Tokens: X / 200k (Y%)”通常更小
- `/context` 本身这一轮的结构化 `usage_update` 常常是 0，不适合作为 bridge 直接消费的状态源

结论：

- `/context` 更像“给人看的快照命令”
- 不是稳定的结构化 usage 数据源

### 实验 C：本地工具 + web search + `/context`

让 Claude 在同一回合里：

- 读取本地文件
- 执行 2 次 `Web search`
- 写文件
- 再在下一轮执行 `/context`

观察到一个清晰例子：

- 工具回合：`usage_update.usedTokens = 110,636`
- 同 session 紧接着 `/context`：`64.9k / 200k (32%)`

这说明：

- 分母 `200k` 没问题
- 分子 `110,636` 明显大于当前快照 `64.9k`
- 偏差大约 45.7k tokens

同时该轮原始 `result.usage` 为：

- `input_tokens = 108,606`
- `output_tokens = 2,030`
- `cache_read_input_tokens = 75,392`

而 `server_tool_use.web_search_requests = 0`。

结论：

- 分子偏大不是因为误加了 `cache_read_input_tokens`
- 工具 / web search 场景下，`input_tokens + output_tokens` 本身就可能大于最终 context 快照
- 当前拿不到足够细的信息来把“工具导致的额外处理 token”精准扣掉

## 为什么会出现 `>100%`

虽然本轮实验没有强行稳定复现 `>100%`，但原因已经比较清楚：

- `usedTokens` 取的是回合累计处理量近似值
- `maxTokens` 取的是 session context window 大小
- 当回合里工具调用、web search、内部多轮处理很多时，`usedTokens` 可能高于当前实际保留上下文
- 如果这种累计处理量继续增大，就可能跨过 `maxTokens`，表现成 `>100%`

因此，`>100%` 更像是：

- “分子失真”

而不是：

- “分母算错了”

## 为什么执行 `/context` 后下一条看起来会恢复正常

bridge 当前状态栏读取的是缓存的 `usage_update` 状态，而不是每次现查 Claude 当前 context。

典型过程是：

1. 某个工具-heavy 回合写入了偏大的 `usedTokens`
2. 状态栏持续显示这个值
3. 用户执行 `/context`
4. Claude 在内部重新整理当前上下文，并给出接近真值的文本快照
5. 下一条正常 prompt 又产生新的 `usage_update`
6. 这个新值覆盖掉旧缓存，于是状态栏“恢复正常”

注意：

- 恢复正常不是因为 bridge 解析了 `/context` 文本
- 而是下一轮新的 `usage_update` 覆盖了原来的缓存值

## 除了 `/context` 之外的替代思路

### 1. Claude SDK `getContextUsage()` 旁路校准

这是最接近 `/context` 真值、也最值得考虑的替代方案：

- 正常回合继续使用当前 `usage_update`
- 遇到异常条件时，在后台通过 Claude SDK 用同一 session 做一次 `getContextUsage()`
- 用返回的 `totalTokens / maxTokens / percentage` 覆盖状态栏

优点：

- 语义更接近当前 context 快照
- 不需要向用户会话里显式发送 `/context`

缺点：

- 仍然有耗时
- 需要验证 SDK sidecar 与现有 ACP session 的恢复/串行行为是否稳定

### 2. 异常值冻结

当命中异常条件时，不立刻采用新的 `usedTokens`，而是保留上一次可信值。

适用场景：

- `used > max`
- 工具调用过多
- 出现 web search
- 多模型参与
- 分子突增明显

### 3. 标记为“估算值”

在高风险回合中，把状态栏标记为：

- `~55%`
- `估算 55%`
- `55%*`

这样用户可以知道当前显示的是“快速近似值”，不是当前快照真值。

### 4. 空闲时懒校准

不是每轮都校准，而是：

- 当前回合结束后
- 如果短时间内没有下一条 prompt
- 再后台做一次 `getContextUsage()` 或 `/context` 风格校准

## 当前建议

在不改代码的前提下，可以先把当前策略理解为：

- `usage_update`：快速近似值
- `/context`：更接近真值的慢速快照

如果后续需要改造，优先级建议为：

1. 保留当前 `usage_update` 作为实时展示值
2. 对异常值增加保护（冻结、标注估算、限制 >100%）
3. 长期方案考虑引入 Claude SDK `getContextUsage()` 作为旁路校准

## 相关文件

- `src/acp/patched-claude-agent-acp.ts`
- `src/acp/events.ts`
- `src/acp/sdk-runtime-base.ts`
- `src/acp/claude-runtime.ts`
- `poc/probes/claude-agent-sdk-context-probe.ts`
- `docs/claude-agent-sdk-context-notes.md`
