# 官方 ACP 模型切换与 CLI 模型列表差异

- status: active
- related_modules: `src/bridge.ts`, `src/acp/runtime-contract.ts`, `src/acp/sdk-runtime-base.ts`, `src/acp/official-runtime.ts`, `docs/feishu-commands.md`
- related_memory: [2026-03-29-2356-cursor-official-acp-landed.md](./2026-03-29-2356-cursor-official-acp-landed.md)
- supersedes: （无）

## 背景

本轮围绕飞书 `/model` 命令排查官方 ACP 后端的模型切换体验。最初现象是：在 `ACP_BACKEND=official` 下，输错模型 id 时不会给出与第三方适配器等价的可选模型列表；补上列表后，又发现按用户从 `cursor-agent models` 看到的 id 输入，仍然会被官方 ACP 的 `session/set_model` 判为 `Invalid model value`。

这说明当前系统里存在两套不同的模型标识来源：

1. **CLI 层**：`cursor-agent models` 输出的用户友好 alias。
2. **ACP 层**：`session/new` / `session/load` 返回的 `models.availableModels[].modelId`，用于 `session/set_model`。

## 关键结论

1. **官方 ACP 的 `session/set_model` 只接受 ACP 自己返回的精确 selector，不接受 `cursor-agent models` 里的 alias。**
2. **`cursor-agent models` 的列表明显多于官方 ACP `availableModels`。** 因此，CLI 的“可切换模型集合”和 ACP 的“可提交 selector 集合”不是一一相同的接口。
3. **当前 bridge 直接调用官方 ACP `session/set_model`，做法本身合理，但用户输入层不能再直接复用 CLI alias。**
4. **为了避免误导，bridge 现已把官方 ACP 返回的 `modelId` 作为“精确值”展示，并明确提示用户完整复制反引号里的值（包括 `[]` 或参数后缀）。**
5. **第三方适配器仍有保留价值。** 其模型切换体验更接近 Cursor CLI：对用户暴露的是短 id / alias，而不是 ACP 底层 selector。

## 影响范围

- 用户交互：
  - `/model` 无参数时，若当前 session 已拿到模型状态，会返回当前 ACP session 的可用 selector 与当前模型。
  - `/model <id>` 失败时，会展示“显示名 -> 精确值”的列表，而不是只回 JSON-RPC 错误。
- 运行时抽象：
  - `SdkAcpRuntimeBase` 新增会话级模型状态缓存，记录 `session/new` / `session/load` 的 `models`，并在 `set_model` 成功后更新 `currentModelId`。
- 产品认知：
  - 文档和提示语不应再暗示“`cursor-agent models` 里的 id 可直接用于 official ACP 的 `/model`”。

## 关联版本

- top-level: `96ac0a97939945113e137704129622b52e313f15`
- working tree:
  - 代码改动已提交到上述 commit。
  - 本条 memory 以及 `.cursor/`、`.worktree/`、`memory/`、`reference/` 仍为本地未提交内容。

## 当前状态

- 已完成：
  - bridge 已能缓存 official ACP 的 session model state。
  - `/model` 失败提示已能列出官方 ACP 认可的精确 selector。
  - `/model` 空参数时，会优先返回当前 session 的可用 selector。
  - 已通过真实探测确认：官方 ACP 与 CLI 的模型 id 体系不同。
- 未完成：
  - official backend 下，bridge 还没有把 CLI alias 自动映射到 ACP selector。
  - 还没有建立“CLI alias 集合”和“ACP selector 集合”的稳定映射规则。

## 验证记录

基于本机直接连接官方 `agent acp` 的探测结果：

- `cursor-agent models` 中存在：
  - `composer-2-fast`
  - `composer-2`
- 同一环境下，官方 ACP `session/new` 返回的 Composer 相关模型只有：
  - `composer-2[fast=true]`（显示名 `Composer 2`）
  - `composer-1.5[]`
- 对官方 ACP `session/set_model` 的实测：
  - `composer-2` -> 失败（`Invalid model value`）
  - `composer-2-fast` -> 失败
  - `composer-2[]` -> 失败
  - `composer-2[fast=false]` -> 失败
  - `composer-2[fast=true]` -> 成功

这说明至少在当前账号/环境下，**官方 ACP 支持的 Composer 2 selector 只有 `composer-2[fast=true]`，并不存在与 CLI `composer-2` / `composer-2-fast` 一一对应的可直接提交值。**

## 后续建议

1. 若继续以 official backend 为默认路径，建议把 `/model` 的产品语义收窄为“切换官方 ACP 当前 session 暴露出来的 selector”，不要再默认承诺与 `cursor-agent models` 完全一致。
2. 若目标是恢复第三方适配器那种短 id 体验，需要单独做一层 alias 映射，并承认该映射属于“bridge/CLI 友好层”，不是 ACP 原生能力。
3. 在做 alias 映射前，先针对用户常用模型（如 `gpt-5.4-medium`、`claude-4.6-opus-high-thinking`）补一轮实测，确认哪些 CLI alias 在 ACP 中有稳定对应，哪些根本没有。
