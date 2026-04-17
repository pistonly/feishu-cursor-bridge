# Codex Backend Notes

记录时间：2026-04-13，补充更新：2026-04-15、2026-04-17

## 已验证现状

- 本机实际探测版本：`@zed-industries/codex-acp@0.11.1`
- `initialize` 宣告能力：
  - `loadSession: true`
  - `promptCapabilities.image: true`
  - `promptCapabilities.audio: false`
  - `promptCapabilities.embeddedContext: true`
  - `mcpCapabilities.http: true`
  - `mcpCapabilities.sse: false`
  - `sessionCapabilities.list`
  - `sessionCapabilities.close`
  - `auth.logout`
- `authMethods`：`chatgpt`、`CODEX_API_KEY`、`OPENAI_API_KEY`

## 宿主机环境要求（2026-04-17 补充）

- bridge 默认通过 `npx -y @zed-industries/codex-acp` 启动 Codex backend，因此宿主机必须先能直接启动这条命令
- 当前实测的 Linux x64 包版本仍是 `@zed-industries/codex-acp@0.11.1`
- 对下载到的 `codex-acp` 二进制执行 `ldd`，观察到它依赖：
  - `libssl.so.3`
  - `libcrypto.so.3`
  - `GLIBC_2.32`
  - `GLIBC_2.33`
  - `GLIBC_2.34`
- 因此，Ubuntu 20.04 这类仅提供 `glibc 2.31` 和 `libssl.so.1.1` 的宿主机，不能直接运行默认 `npx` 路径
- 在该类旧环境上的典型报错：
  - `libssl.so.3: cannot open shared object file`
  - `libcrypto.so.3: cannot open shared object file`
  - `GLIBC_2.34 not found`
- 推荐处理方式：
  - 使用更新的 Linux 宿主机 / 容器 / VM / WSL（例如 Ubuntu 22.04+）
  - 或通过 `CODEX_AGENT_ACP_COMMAND` 覆盖为兼容当前宿主机 ABI 的本地 wrapper / 二进制
- 不建议把“在 Conda 里额外安装 glibc / openssl”当作文档中的常规修复方案；默认 `npx` 下载到的 ELF 仍会优先使用系统动态加载器，除非调用方式也一起被 wrapper 接管
- 维护侧 smoke 建议：
  - 先在宿主机直接验证 `npx -y @zed-industries/codex-acp --help`
  - 只有该命令本身可启动后，再验证 bridge 的 `/new --backend codex ...`

## 真实行为与宣告不一致点

- `codex-acp` 没有在 `initialize` 中宣告 `supportsSetMode` / `supportsSetModel`
- 但对真实 session，`session/set_mode` 和 `session/set_model` 都可成功调用
- 对真实进行中的 prompt，`session/cancel` 可成功中断，并返回 `stopReason=cancelled`
- `newSession` 返回里已经包含完整 `modes` / `models` / `configOptions`
- `loadSession` 对刚新建的临时 session 探针曾返回 `Resource not found`
- `loadSession` 对 `listSessions` 中已有的真实 session 可成功

## 2026-04-13 真实 `/stop` Probe

- 探测方式：直接启动 `@zed-industries/codex-acp`，创建真实 session，发送一个刻意拉长的 prompt，再调用 ACP `session/cancel`
- 启动配置：`sandbox_mode="danger-full-access"`、`approval_policy="never"`
- 结果：
  - `cancel` RPC 成功返回
  - 对应 prompt 最终返回 `stopReason: "cancelled"`
- 结论：
  - 当前本机环境下，Codex backend 真实支持桥接 `/stop` 对应的 ACP `session/cancel`
  - 这不是 bridge 侧假成功，而是后端真实生效

## 2026-04-15 真实 `/compact` / `/clear` Probe

- bridge 层没有内置 `/compact` / `/clear`
- 当前实现只直接接管 `/model`、`/stop` 等少量命令；其它未命中的 slash 文本会按普通 prompt 透传给当前 backend session
- 直接探测 `codex-acp` session 的 `available_commands_update`，返回命令为：
  - `review`
  - `review-branch`
  - `review-commit`
  - `init`
  - `compact`
  - `undo`
  - `logout`
- 本机 `@zed-industries/codex-acp@0.11.1` 自带 README 也只明确列出 `/compact`，没有 `/clear`

### `/compact`

- 输入 `/compact` 后，agent 返回 `Context compacted`
- `usage_update.used` 从 `13158` 降到 `7535`
- 压缩后继续追问，仍可正确回忆压缩前要求记住的 marker

结论：

- `/compact` 可以视为当前 `codex-acp@0.11.1` 的明确支持能力
- bridge 侧若收到 `/compact`，当前可以安全理解为“透传给 Codex backend 的正式 slash command”

### `/clear`

- 输入 `/clear` 后，agent 会返回“已清空上下文，接下来做什么”一类回复
- 清空后再次追问之前保存的 marker，返回 `UNKNOWN`
- 但 `available_commands_update` 没有宣告 `clear`
- README 没有记录 `/clear`
- 原始 ACP `sessionUpdate` 中也没有观察到专门的 clear 事件；只看到了普通 `agent_message_chunk` / `usage_update`

结论：

- `/clear` 在当前环境下“会产生清空上下文效果”
- 但它不是当前 `codex-acp` 明确宣告的 slash command，不应当在 bridge 文档、兼容判断或自动化能力矩阵中当作稳定 ACP 能力依赖
- 若未来要在桥接层正式支持 `/clear`，更稳妥的做法是实现 bridge 自己的 clear 语义，而不是假设 Codex backend 一定支持

## 额外注意事项

- 先前 bridge 的通用 `cancelSession()` 会吞掉后端异常，导致 `/stop` 可能误报成功
- 该问题现已修正；现在若 Codex 后端未来回归为不支持 `session/cancel`，飞书侧会显式报错

## 已做兼容处理

- bridge 的通用 capability guard 仍保留
- `codex` runtime 单独覆盖为允许 `/mode` 与 `/model`
- 仅 `cursor-legacy` 保留“认证失败疑似 Cursor CLI 超时”的文案改写

## 后续改进方向

- 给 `codex` 增加更完整的集成测试：`newSession`、`loadSession`、`set_mode`、`set_model`
- 给 `codex` 增加真实集成测试：`session/cancel -> stopReason=cancelled`
- 对 `loadSession` 增加更细的兼容判断，不要只依赖 `initialize.loadSession === true`
- 研究是否应优先基于 `newSession/loadSession` 返回的 `modes/models/configOptions` 判断能力，而不是只看 capability 宣告
- 在 README 中补充 codex 的真实行为说明：`mode/model` 可用，但当前版本 capability 宣告不完整
- 若后续升级 `codex-acp`，优先复测以下兼容点：
  - `session/set_mode` 是否仍可用
  - `session/set_model` 是否仍可用
  - `session/cancel` 是否仍返回 `stopReason=cancelled`
  - `loadSession` 对新建 session 与历史 session 的行为是否一致
  - `initialize.agentCapabilities` 是否补齐 `supportsSetMode` / `supportsSetModel`
  - `available_commands_update` 是否仍显式包含 `compact`
  - `/compact` 后 usage 是否明显下降且历史信息仍可回忆
  - `/clear` 是否仍只是未宣告行为，还是已升级为正式宣告命令
