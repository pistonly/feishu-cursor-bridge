# Codex Plan Mode Findings

记录时间：2026-04-12

## 结论摘要

- 不能再简单下结论说“Codex 没有 plan mode”。
- 更准确的说法是：
  - OpenAI 官方公开文档里，没有找到一页稳定、明确、权威地把 Codex 对外 mode 定义为 `plan / ...` 的说明。
  - 但 Codex 开源仓库、issue、discussion、release mirror 已经反复出现 `plan mode`、`planning/spec mode`、`collaboration modes` 等信号。
  - 因此，Codex 很可能确实存在某种 **plan-like / planning collaboration** 能力，但它未必等价于当前 `codex-acp` 对外暴露的 ACP `session mode`。

## 与本项目直接相关的判断

- 当前项目里对 `codex` backend 的实测结论仍成立：
  - `codex-acp` 返回的 mode 语义是 `read-only` / `auto` / `full-access`
  - 而不是 Cursor 风格的 `agent` / `plan` / `ask`
- 因此：
  - **“Codex 本体存在 plan 能力”**
  - 不等于
  - **“本项目接入的 codex-acp 支持 `/mode plan`”**

换句话说，后续若要支持 “Codex 的 plan 能力”，更合理的方向仍然是：

- 保留 `codex-acp` 原生 mode 语义
- 在 bridge 层实现 `plan -> confirm -> execute` workflow

而不是强行把 `codex` backend 伪装成 `mode=plan`。

## 查到的证据

### 1. 官方公开文档：未见稳定明确的 `plan mode` 产品定义

截至 2026-04-12，本次查到的 OpenAI 官方公开文档中：

- 能确认 Codex 相关公开说明存在 `Ask mode` / `Code mode` 语境
- 但未找到一页稳定、明确地将 Codex 公布为 `plan / ask / code` 或 `plan / chat / agent` 的权威文档

参考：

- OpenAI Codex use cases  
  https://developers.openai.com/codex/use-cases
- GPT-5.3-Codex model page  
  https://developers.openai.com/api/docs/models/gpt-5.3-codex

这说明：

- 若只看公开 docs，`plan mode` 至少不是一个当前“文档化得很清楚”的外显概念。

### 2. OpenAI 开源 Codex 仓库：`Plan Mode` 请求长期存在

Issue:

- `Plan Mode` feature request  
  https://github.com/openai/codex/issues/2101

含义：

- 至少在 2025-08-09，公开 CLI/产品面并没有一个足够成熟、足够清晰的 Plan Mode，用户仍在明确请求此功能。

### 3. OpenAI 团队公开讨论：内部确实在实验 planning/spec mode

Discussion:

- `Plan / Spec Mode?`  
  https://github.com/openai/codex/discussions/7355

其中可确认的信息：

- 团队收到很多关于 planning / spec’ing mode 的请求
- 团队表示内部在实验一些相关概念

含义：

- `plan/spec mode` 并不是用户臆想，而是 Codex 团队明确关注和讨论过的方向。
- 但至少在该讨论对应时间点，它更像一个演进中的能力，而不是完全稳定定型的公开功能。

### 4. 仓库 issue 中已出现多次 `chat/plan mode` 说法

示例：

- https://github.com/openai/codex/issues/3803
- https://github.com/openai/codex/issues/3869
- https://github.com/openai/codex/issues/5464

含义：

- 某些 Codex 使用表面中，用户已经在把相关能力称作 `plan mode`
- 这强烈暗示 Codex 生态中已经存在 plan-like 模式或协作态

注意：

- 这只能说明“生态中存在该说法和相关能力痕迹”
- 不能直接推出“当前 `codex-acp` 一定暴露 ACP `session mode = plan`”

### 5. CLI / harness 层真实存在 plan-tool 痕迹

Issue:

- `codex exec` 因默认禁用 `update_plan` 导致问题  
  https://github.com/openai/codex/issues/5359

含义：

- `update_plan` 是 Codex agent/harness 里真实存在的能力
- 因此，“plan”不只是文案层概念，也进入了工具/执行层

### 6. release mirror / 第三方发布跟踪出现 collaboration modes / Plan mode 信号

参考：

- https://newreleases.io/project/github/openai/codex/release/rust-v0.96.0
- https://sourceforge.net/projects/openai-codex.mirror/files/rust-v0.106.0/

谨慎结论：

- 这些来源不是首选主来源
- 但它们与 GitHub issue / discussion 的信号相互印证，说明 Codex 很可能在逐步引入或暴露更明确的 collaboration / planning modes

这里必须明确标注：

- 这是基于 mirror/release 线索的**推断**
- 不是直接来自官方 docs 正文的硬性结论

## 对本项目的设计启示

### 不建议做的事

- 不建议把 `codex` backend 强行映射成 Cursor 风格的 `/mode plan`
- 不建议假设 `codex-acp` 的 mode 和 Codex Web / CLI / collaboration UI 的 mode 一致

原因：

- 当前项目已有实测结论表明 `codex-acp` 的 mode 值是 backend-specific
- mode 语义不应跨 backend 复用

### 建议做的事

若后续要支持“Codex 的 plan 能力”，推荐走 bridge workflow：

1. `plan`
   - 先让 agent 生成计划
2. `confirm`
   - 用户在飞书确认/修改/取消
3. `execute`
   - 再继续同一 session 执行

这样可以同时满足：

- 不破坏 `codex-acp` 原生 mode 语义
- 又能提供用户感知上的 “Plan mode” 体验

## 当前暂定判断

截至 2026-04-12，可以采用以下表述：

- **Codex 很可能存在 plan-like / planning collaboration 能力**
- **但当前公开文档不足以支撑“Codex 的官方公开 mode 就是 plan”这一强结论**
- **本项目当前接入的 `codex-acp` 没有实测到 `mode=plan`，仍应按 `read-only / auto / full-access` 处理**

## 后续若继续推进，建议优先验证

1. 升级或复测 `@zed-industries/codex-acp`
   - 关注其 `newSession/loadSession` 返回的 `modes`
   - 观察是否开始暴露更接近 plan collaboration 的 mode/value

2. 跟踪 OpenAI 开源 Codex 仓库
   - 重点看：
     - `Plan Mode`
     - `Spec Mode`
     - `Collaboration Mode`
     - `request_user_input`
     - `update_plan`

3. 若产品目标是飞书侧体验，而非协议纯正性
   - 优先实现 bridge-level `plan -> confirm -> execute`
   - 不必等待 `codex-acp` 官方先暴露 `mode=plan`
