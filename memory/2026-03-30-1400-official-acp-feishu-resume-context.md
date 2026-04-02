# 官方 ACP 下飞书同 slot 跨 bridge 重启仍能保持 Agent 上下文

- status: active
- related_modules: `src/session-store.ts`, `src/session-manager.ts`, `src/acp/official-runtime.ts`, `src/bridge.ts`, `src/conversation-service.ts`
- related_memory: [2026-03-29-2356-cursor-official-acp-landed.md](./2026-03-29-2356-cursor-official-acp-landed.md)
- supersedes: （无）

## 背景

使用者容易把三件事混在一起：

1. **飞书界面里**始终能看到历史消息（IM 自己的聊天记录）。
2. **桥接进程重启**后，飞书侧仍选「同一个 session slot」发消息，期望 Cursor Agent 仍记得此前多轮对话。
3. **终端里** `cursor-agent --resume <id>` 所需的 **CLI resume ID**，与 ACP JSON-RPC 里的 **`sessionId` / `session/load`** 不是同一套对外接口。

因此会出现「听说官方 ACP 不暴露 Resume ID，就以为不能 resume」的误解。

## 关键结论

1. **在本项目中，使用官方 ACP（`OfficialAcpRuntime`）时，多次重启 bridge 服务，只要在飞书中仍对应同一逻辑会话（同一 `sessionKey` + 同一未过期的 slot，且磁盘映射仍在），通常仍能恢复 Cursor 侧对话上下文。**
2. **机制不是「进程常驻内存」**，而是：
   - `SessionStore` 把每个 slot 的 **`sessionId`**、工作区路径等写入映射文件（默认由 `sessionStorePath` 配置，见 `src/session-store.ts` 注释：便于进程重启后 `session/load`）。
   - 启动时 `SessionManager.init()` 读盘；用户再次发消息时 `restoreGroupFromStore` 等对**已持久化的 `sessionId` 调用 ACP `session/load`**，失败时再走 `createSessionPreservingCliBinding` 等兜底（见 `src/session-manager.ts`）。
3. **官方 ACP 在此意义上是「可 resume」的**：延续的是 **ACP 会话**（由 `sessionId` + `session/load` 接回），与是否提供 **CLI `--resume` 用的 chat id** 无关。
4. **当前官方后端**在 `extractNewSessionResult` 中只返回 `sessionId`，**不填充**与 legacy 适配器对等的 `cursorCliChatId`，因此 `/status` 会说明官方下未暴露 CLI resume ID（见 `src/acp/official-runtime.ts`、`src/bridge.ts` 中相关文案）。**这不代表**飞书侧同 slot 无法跨重启续上下文。
5. **仍会丢的**是桥接进程内存里的缓存（例如 `SessionSlot` 上的 `lastPrompt` / `lastReply`，仅用于 `/reply` 等，**重启 bridge 后清空**），与 **Cursor Agent 多轮上下文** 是两层概念。

## 影响范围（或：涉及的主要变动）

- 无代码变更需求；本条为**产品与排障说明**，避免将「无 CLI resume ID」误读为「官方 ACP 不能恢复会话」。
- 若用户删除或损坏 session 映射文件、会话空闲超时被淘汰、或上游 `session/load` 持续失败，则可能出现「飞书里还能看到旧消息，但新消息像新开一局」——需结合 `BRIDGE_DEBUG`、`ACP_RELOAD_TRACE_LOG` 等与 `session-manager` 日志排查。

## 关联版本

- top-level: `a123ce6d80eabdb16f389b1b8d31fb3801d8685e`
- working tree: `memory/` 等目录在仓库中仍为未跟踪（untracked），本条文件随 `memory/` 一并存在；结论与上述 commit 中的 `session-manager` / `official-runtime` 行为一致。

## 当前状态

- 已在真实使用中观察到：**bridge 多次重启后，飞书同 slot 下 Agent 仍能延续上下文**（与 `session/load` + 持久化 `sessionId` 设计一致）。
- 用户教育要点：**区分「飞书聊天记录可见」「ACP 会话可 load 续接」「CLI resume ID 是否暴露」三件事。**

## 后续建议

1. 若需在 README 或 `docs/feishu-commands.md` 中面向最终用户写一段「官方 ACP 与重启」的 FAQ，可从本条摘取「三层区分」与「不暴露 CLI ID ≠ 不能续会话」两句话。
2. 若官方 ACP 将来在 `session/new` 元数据中暴露与 `--resume` 对齐的 id，再更新 `/status` 与 `official-runtime` 的 `extractNewSessionResult`，并在此 memory 追加关联版本说明。
