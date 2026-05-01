# Official Backend Notes

记录时间：2026-04-11，补充更新：2026-04-15、2026-04-16

## 已验证现状

- 本机官方入口：`/home/liuyang/.local/bin/agent`
- ACP 启动命令：`agent acp`
- `initialize` 宣告能力：
  - `loadSession: true`
  - `mcpCapabilities.http: true`
  - `mcpCapabilities.sse: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.audio: false`
  - `promptCapabilities.embeddedContext: false`
- `authMethods`：
  - `cursor_login`

## 真实行为探针结论

- `newSession`：成功
- `session/set_mode`：成功
- `session/set_model`：成功，但必须使用 session 返回的精确 model selector
- `session/list`：失败，`Method not found`
- `session/close`：失败，`Method not found`
- `loadSession`：对刚新建的临时 session 失败，错误为 `Session "..." not found`

## 真实返回的 mode / model

- modes:
  - `agent`
  - `plan`
  - `ask`
- models:
  - 不是简单 alias，而是完整 selector
  - 示例：`gpt-5.4[reasoning=medium,context=272k,fast=false]`
  - 示例：`default[]`

## 2026-04-15 真实 `/compact` / `/clear` Probe

- bridge 层没有内置 `/compact` / `/clear`
- 对 `cursor-official` 来说，这两个 slash 文本会被透传给 `agent acp` 当前 session，当作普通 prompt 处理
- 真实 `available_commands_update` 没有宣告 `compact` / `clear`
- 当前本机 `agent acp` 返回的可用命令包括：
  - `copy-request-id`
  - `simplify`
  - `worktree`
  - `best-of-n`
  - `babysit`
  - `create-hook`
  - `create-rule`
  - `create-skill`
  - `create-subagent`
  - `migrate-to-skills`
  - `shell`
  - `statusline`
  - `update-cli-config`
  - `memory-checkpoint`

### `/compact`

- 发送 `/compact` 后，agent 没有返回“上下文已压缩”之类的固定协议响应
- 相反，它把 `/compact` 当普通用户输入理解，还触发工具调用去查项目中的 `/compact` 定义
- 最终明确回复“没有发生真正的上下文压缩；我仍保留你之前要求记住的内容”
- 之后追问 marker，仍返回 `MARKER_OFFICIAL_COMPACT_20260415_P8L2`
- 这轮 official probe 没有观察到 `usage_update`

结论：

- `/compact` 不是当前 `cursor-official` backend 的真实后端 slash command
- 若从飞书/bridge 透传 `/compact` 到 official backend，当前只能期待“Agent 按字面理解后回复”，不能把它当作稳定的上下文压缩能力依赖

### `/clear`

- 发送 `/clear` 后，agent 会给出“已按你的意图当作新会话起点处理”一类文案
- 但随后再次追问之前保存的 marker，仍返回 `MARKER_OFFICIAL_CLEAR_20260415_K4M7`
- 没有观察到 dedicated clear 事件，也没有可证明上下文真的被清空的信号

结论：

- `/clear` 在 official backend 下也不是已宣告的真实命令
- 它更像是 Agent 对“请忽略前文/从头开始”这类意图的自然语言响应，而不是真实清空 session 上下文

## 2026-04-16 真实 `/summary` / `/summarize` Probe

- `available_commands_update` 里同样没有 `summary` / `summarize`
- 当前环境下与“summary”最接近的仅有：
  - `simplify`：内置命令，含义是代码清理/复用检查，不是会话摘要
  - `memory-checkpoint`：`user skill`

### `/summary`

- 发送 `/summary` 后，agent 会先把它当普通输入理解，并尝试检查本地 skill / 仓库中是否有对应定义
- 最终给出的是“当前对话摘要”
- 之后追问 marker，仍返回 `MARKER_OFFICIAL_SUMMARY_20260416_A9R3`

### `/summarize`

- 发送 `/summarize` 后，agent 会进一步读取本地文档，确认仓库里并没有名为 `/summarize` 的 bridge 内置命令
- 最终给出的是“本轮对话摘要”，而不是某个后端固定命令的标准回执
- 之后追问 marker，仍返回 `MARKER_OFFICIAL_SUMMARIZE_20260416_H2T6`

结论：

- `/summary` / `/summarize` 在 `cursor-official` 下都不是后端原生命令
- 当前看到的“summary 类能力”要么是 Agent 对普通 prompt 的解释执行，要么是环境里挂载的 user skill；都不应和 official ACP 的稳定协议能力混为一谈

## 注意点

- `set_model` 不能依赖 `gpt-5` 这类简写；应优先使用当前 ACP session 返回的精确 selector
- 当前 bridge 对官方 backend 使用“按当前 session 返回的可用模型列表解析 `/model <序号>`”是正确方向；其它 bridge 接管的 backend 也应沿用同一套按 session 列表解析的方式
- 官方 backend 没有宣告 `session/list` / `session/close`，实测也确实不可用
- 官方 backend 宣告了 `loadSession: true`，但对刚创建 session 的恢复行为与预期不完全一致，需要额外验证历史真实 session 的恢复路径
- 官方 backend 没有明确宣告 `supportsSetMode` / `supportsSetModel`，但实测两者可用
- 官方 backend 当前宣告的 slash/skills 列表里没有 `compact`、`clear`、`summary`、`summarize`
- `memory-checkpoint` 是环境里的 user skill，不是 official ACP 原生命令

## 当前判断

- 官方 backend 的 `/model` 必须坚持 selector-by-session 的实现方式，不能退回 alias 模式
- 官方 backend 的 `loadSession` 不能只靠 `initialize.loadSession === true` 推断“恢复一定可用”
- 官方 backend 与 codex 一样，都存在“部分能力未宣告但实际可用”的情况
- 但与 codex 不同，official backend 当前没有观察到真实的上下文管理 slash command；`/compact`、`/clear`、`/summary`、`/summarize` 都不应被当作稳定后端能力

## 后续改进方向

- 增加官方 backend 的真实集成测试：
  - `newSession`
  - `set_mode`
  - `set_model`
  - `loadSession` 对真实历史 session 的行为
- 若未来升级 `agent` / Cursor CLI，优先复测以下兼容点：
  - `available_commands_update` 是否新增 `compact` / `clear` / `summary` / `summarize`
  - `/compact` 后是否出现真实上下文压缩信号，而不只是自然语言回复
  - `/clear` 后是否真的丢失先前 marker
  - `/summary` / `/summarize` 是否升级为正式命令，还是仍然只是 skill / 普通 prompt 入口
- 研究是否应对官方 backend 放宽 `set_mode` / `set_model` 的 capability 判断，避免因 capability 宣告不全而误禁功能
- 在 README 中补充官方 backend 的模型 selector 说明，明确 `/model` 依赖 ACP session 返回值而非 CLI alias
