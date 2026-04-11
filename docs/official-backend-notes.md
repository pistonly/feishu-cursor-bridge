# Official Backend Notes

记录时间：2026-04-11

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

## 注意点

- `set_model` 不能依赖 `gpt-5` 这类简写；应优先使用当前 ACP session 返回的精确 selector
- 当前 bridge 对官方 backend 使用“按当前 session 返回的可用模型列表解析 `/model <序号>`”是正确方向
- 官方 backend 没有宣告 `session/list` / `session/close`，实测也确实不可用
- 官方 backend 宣告了 `loadSession: true`，但对刚创建 session 的恢复行为与预期不完全一致，需要额外验证历史真实 session 的恢复路径
- 官方 backend 没有明确宣告 `supportsSetMode` / `supportsSetModel`，但实测两者可用

## 当前判断

- 官方 backend 的 `/model` 必须坚持 selector-by-session 的实现方式，不能退回 alias 模式
- 官方 backend 的 `loadSession` 不能只靠 `initialize.loadSession === true` 推断“恢复一定可用”
- 官方 backend 与 codex 一样，都存在“部分能力未宣告但实际可用”的情况

## 后续改进方向

- 增加官方 backend 的真实集成测试：
  - `newSession`
  - `set_mode`
  - `set_model`
  - `loadSession` 对真实历史 session 的行为
- 研究是否应对官方 backend 放宽 `set_mode` / `set_model` 的 capability 判断，避免因 capability 宣告不全而误禁功能
- 在 README 中补充官方 backend 的模型 selector 说明，明确 `/model` 依赖 ACP session 返回值而非 CLI alias
