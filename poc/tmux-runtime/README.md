# tmux Runtime PoC

这个目录用于验证一个基于 `tmux` 的交互式 Cursor CLI 运行时是否可行。

当前阶段只做两件事：

1. 证明我们可以稳定拿到 `tmux pane` 的输出。
2. 为“如何判断一轮回复结束”建立实验基线。

## 当前文件

- `cursor-agent-detector.ts`
  - 共享 `Cursor Agent` 的 UI 识别、busy/idle 判断、control mode 语义信号提取、完成判定状态机
  - 作为后续真正 `tmux runtime` 的核心候选模块
- `tmux-cursor-session.ts`
  - 最小 `TmuxCursorSession` 原型
  - 封装 `attach()`、`startAgent()`、`runPrompt()`、`cancelCurrentTurn()`、`captureCurrentSnapshot()`、`stop()`、`close()`、`destroy()`
  - 内部组合 `capture-pane`、`control mode` 和共享 detector
  - 默认启动路径已改成 `cursor agent create-chat` + `cursor agent --resume <chatId>`
  - `runPrompt()` 会返回最终快照、提取到的语义信号和最佳努力 `replyText`
- `tmux-slot-store.ts`
  - `tmux pane <-> bridge slot` 的 JSON 持久化存储
  - 数据结构刻意对齐主项目的 `session-store.ts` 风格：`session group -> slots`
- `tmux-slot-registry.ts`
  - 以飞书会话维度管理 active slot / slot 列表 / slot 切换
  - 可以把 `TmuxCursorSession.describeBinding()` 产出的 pane 绑定信息持久化下来
  - 现在已支持 `restoreActiveSlot()`：先 probe 现有 pane，再在失效时自动 rebuild 并回写 store
- `run-session.ts`
  - 一个直接调用 `TmuxCursorSession` 的最小 CLI demo
- `cancel-session.ts`
  - 一个直接调用 `TmuxCursorSession.cancelCurrentTurn()` 的最小 CLI demo
- `persisted-slot-demo.ts`
  - 演示“先把 active pane 落盘，再从 store 读出来重新 attach”的闭环
- `recover-slot-demo.ts`
  - 演示“原 pane 已失效时，registry 自动 rebuild active slot，再继续对话”的闭环
- `resume-chatid-demo.ts`
  - 演示“pane 被销毁并重建后，仍然复用同一个 `cursorCliChatId`，继续同一段对话上下文”的闭环
- `tmux-acp-session-store.ts`
  - 一个面向 ACP `sessionId` 的最小 JSON 持久化 store
  - 负责持久化 `paneId` / `tmuxSessionName` / `cursorCliChatId` / `workspaceRoot`
- `tmux-acp-server.ts`
  - 一个最小可运行的 stdio ACP server 原型
  - 基于 SDK 的 `AgentSideConnection`
  - 当前已打通 `initialize` / `newSession` / `loadSession` / `session/list` / `prompt` / `cancel` / `close` / `unstable_resumeSession`
  - 底层通过 `TmuxCursorSession` 驱动交互式 `cursor agent --resume <chatId>`
- `tmux-acp-smoke.ts`
  - 端到端验证最小 ACP server：`newSession -> prompt -> server 重启 -> loadSession -> prompt -> closeSession`
- `tmux-acp-cancel-smoke.ts`
  - 端到端验证 `session/cancel -> stopReason: cancelled`
- `observe-pane.ts`
  - 创建或复用一个 `tmux pane`
  - 可选启动交互式命令，例如 `cursor agent`
  - 轮询 `capture-pane`，在内容变化时打印完整快照
  - 优先抓 alternate screen；如果 pane 当前没有 alternate screen，则自动回退到普通屏幕
  - 若命令是 `cursor agent`，会先等待 UI ready，再发送 prompt，避免 prompt 在 UI 完成启动前被误输入
  - 对 `cursor agent` 的界面输出做粗略 busy/idle 判定，目前主要依赖 `Generating`、`Reading`、`ctrl+c to stop`、`Add a follow-up` 等文本特征
  - 通过“连续若干次处于 idle”给出一个启发式完成判定
- `observe-control-mode.ts`
  - 在上面同样的 pane/session 基础上，再额外启动一个 `tmux -C` control mode client
  - 监听 `%output` 事件，验证 pane 的实时输出流是否可消费
  - 对 `%output` 做基础解码，并尽量去掉 ANSI 控制序列与明显的 spinner 噪音
  - 将“control mode 输出静默窗口”与 `capture-pane` 的 UI idle 判定组合起来
  - 现在已经复用 `cursor-agent-detector.ts`，不再维护一套单独的检测规则

## 为什么先用 capture-pane

`tmux` 至少有三种拿输出的办法：

- `capture-pane`
- `pipe-pane`
- `control mode`

第一版 PoC 先用 `capture-pane`，因为它最容易快速验证下面两个问题：

- Cursor CLI 的交互界面能否被 `tmux` 稳定抓到
- 回答中和回答完成后，屏幕是否存在可识别的稳定差异

目前已经同时验证了两条观察链路：

- `capture-pane`：更接近“当前屏幕最终长什么样”
- `control mode %output`：更接近“pane 正在不断吐出什么字节流”

如果继续推进，下一步重点就不再是“能不能拿到输出”，而是“怎么把两路信号融合成稳定的完成判定”。

## control mode 的当前结论

已经完成的真实验证：

- `tmux -C attach-session` 能稳定收到目标 session 的 `%output`
- `%output` 确实包含 pane 的实时重绘内容，而不是只包含最终屏幕快照
- `%output` 内容会带大量 ANSI 控制序列、窗口标题更新、光标移动和 spinner 帧，因此不能直接当自然语言文本消费
- 对这些事件做解码和基础去噪后，已经能看到命令启动、输入进入 UI、部分状态变化等信息

当前暴露出的限制：

- `cursor agent` 的交互 UI 在 control mode 下会产生非常高频的重绘事件，噪声显著高于 `capture-pane`
- 单纯依赖 `%output quiet` 还不足以稳定判断“回答完成”，因为生成阶段会持续刷 spinner，且部分运行中日志并不一定出现明显的最终文本增量
- 第一版更稳的方向仍然是：`capture-pane` 负责看最终 UI 态，`control mode` 负责提供“最近仍有输出”的辅助信号

## 当前完成判定规则

现在 PoC 里已经有一个能跑通的启发式检测器，规则大致是：

1. `capture-pane` 看到 `Cursor Agent` 界面已经回到 idle：
   - 仍然有 `Add a follow-up`
   - 已经没有 `ctrl+c to stop`
   - 已经没有 `Generating` / `Reading` / `Globbing` 等 busy 标记
2. 上面的 idle 状态需要连续出现若干次轮询
3. 同时 `control mode` 需要满足一段静默窗口：
   - 最近没有新的 `%output`
   - 最近没有新的 busy 语义事件

这套规则已经在真实的 `cursor agent` 会话上跑通，能够在回答出现在 pane 中后收敛到“本轮完成”。

## 当前工程化进展

为了进入下一阶段，PoC 里已经把检测逻辑从脚本内联代码抽出来了：

- `observe-pane.ts` 复用共享的 UI ready / busy / idle 识别
- `observe-control-mode.ts` 复用共享的语义信号提取和完成判定状态机
- 后续真正实现 `tmux runtime` 时，可以直接把 `cursor-agent-detector.ts` 作为第一版 turn completion 核心
- 现在又往前一步，已经有一个可直接调用的 `TmuxCursorSession` 原型，能跑通：
  - 创建或绑定 tmux session/pane
  - 启动 `cursor agent`
  - 发送 prompt
  - 等待 detector 判定完成
  - 返回最佳努力提取的回复文本
  - 在回答进行中发送 `Ctrl+C`，并等待会话回到 idle
- 再往前一步，已经有一套对齐主项目 slot 思路的持久化原型：
  - `TmuxSlotStore`：负责 JSON 落盘
  - `TmuxSlotRegistry`：负责按 chat/user/thread 维度组织 active slot
  - `TmuxCursorSession.describeBinding()`：负责把运行时 pane 绑定导出成可持久化结构
  - `TmuxSlotRegistry.restoreActiveSlot()`：负责 probe 旧 pane，失效时自动 rebuild 并更新 active slot 绑定
- 再往前一步，`TmuxCursorSession` 已经补上真正的 Cursor CLI resume 语义：
  - 首次启动默认先执行 `cursor agent create-chat`
  - 然后以 `cursor agent --resume <cursorCliChatId>` 拉起交互式 UI
  - `describeBinding()` / slot store / slot registry 都会持久化这个 `cursorCliChatId`
  - pane 重建后可以把同一个 `cursorCliChatId` 注入新会话，恢复到同一段 Cursor 对话
- 再往前一步，已经有最小的 `tmux ACP server` 原型：
  - ACP `sessionId` 与底层 `cursorCliChatId` 解耦
  - server 自己持久化 ACP session -> tmux pane / Cursor chat 的映射
  - server 重启后可通过 `loadSession()` 或 `unstable_resumeSession()` 恢复同一个 Cursor 对话
  - `session/prompt` 当前先返回整轮完成后的聚合文本，不是 token 级流式输出

## 当前可提炼的语义信号

`observe-control-mode.ts` 目前会把 `%output` 粗分为三类：

- `title`
  - 例如窗口标题从 `Cursor Agent` 变成 `Repository Intro`
- `status`
  - 例如 `Generating...`、`Reading 2 files`、`Globbed "**/README*" in .`
- `content`
  - 例如中间解释文本、最终回答正文

这说明 control mode 虽然很吵，但并不是完全不可用；只要把 ANSI 重绘和 spinner 帧压掉，还是能提取出对完成检测有帮助的状态流。

如果这一步确认可行，下一步再补：

- 更可靠的“完成态”检测器
- pane 与 bridge session 的映射持久化

## 手工使用

先确认本机有 `tmux`，并且你能正常运行交互式 Cursor CLI。

### 1. 创建一个新的 tmux session，并启动 `cursor agent`

```bash
npx tsx poc/tmux-runtime/observe-pane.ts \
  --session-name cursor-tmux-poc \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --command "cursor agent"
```

### 2. 复用已有 pane，只观察输出

```bash
npx tsx poc/tmux-runtime/observe-pane.ts --pane %1
```

### 3. 启动后等待 UI ready，再发一条 prompt

```bash
npx tsx poc/tmux-runtime/observe-pane.ts \
  --session-name cursor-tmux-poc \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --command "cursor agent" \
  --startup-wait-ms 1500 \
  --ready-timeout-ms 30000 \
  --prompt "请介绍一下这个仓库"
```

### 4. 用 control mode 同时观察实时 `%output`

```bash
npx tsx poc/tmux-runtime/observe-control-mode.ts \
  --session-name cursor-tmux-control-poc \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --command "cursor agent" \
  --startup-wait-ms 1500 \
  --ready-timeout-ms 30000 \
  --event-quiet-ms 2000 \
  --prompt "请介绍一下这个仓库"
```

### 5. 直接跑最小 session 原型

```bash
npx tsx poc/tmux-runtime/run-session.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --prompt "只回复OK"
```

### 6. 绑定已有 pane 再跑一轮

```bash
npx tsx poc/tmux-runtime/run-session.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --pane %19 \
  --prompt "只回复SECOND"
```

### 7. 演示取消当前回复

```bash
npx tsx poc/tmux-runtime/cancel-session.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --prompt "请详细分析这个仓库并给出20条观察，先查看多个文件再回答" \
  --cancel-after-ms 5000
```

### 8. 演示“持久化后重新 attach”

```bash
npx tsx poc/tmux-runtime/persisted-slot-demo.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge
```

### 9. 演示“pane 失效后自动重建”

```bash
npx tsx poc/tmux-runtime/recover-slot-demo.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge
```

### 10. 演示“同一个 chat id 跨 pane 重建继续上下文”

```bash
npx tsx poc/tmux-runtime/resume-chatid-demo.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge
```

### 11. 启动最小 tmux ACP server

```bash
npx tsx poc/tmux-runtime/tmux-acp-server.ts \
  --store-path /tmp/tmux-acp-session-store.json
```

### 12. 端到端验证 ACP server 的 new/load/resume

```bash
npx tsx poc/tmux-runtime/tmux-acp-smoke.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge
```

### 13. 端到端验证 ACP server 的 cancel

```bash
npx tsx poc/tmux-runtime/tmux-acp-cancel-smoke.ts \
  --cwd /home/liuyang/Documents/feishu-cursor-bridge \
  --cancel-after-ms 5000
```

## 当前结论

已经完成的真实验证：

- `tmux capture-pane` 能抓到 `cursor agent` 的交互式界面与流式变化
- 若在 UI 尚未 ready 时直接发 prompt，可能只会把文本塞进启动中的终端，导致没有真正提交
- 等待 `Cursor Agent` 界面稳定出现后，再发送 prompt，可以直接触发执行
- 在回答过程中，界面里可以观察到 `Generating`、`Reading`、工具摘要、最终回答等状态变化
- 回答完成后，界面会回到不含 `ctrl+c to stop` 的 `Add a follow-up` 状态，这可以作为第一版完成判定信号
- `TmuxCursorSession.runPrompt()` 已经在真实会话上跑通，`--prompt "只回复OK"` 能最终返回 `OK`
- `TmuxCursorSession` 绑定已有 pane 后也能继续复用同一个 `cursor agent` 会话，不会重复启动新实例
- `TmuxCursorSession.cancelCurrentTurn()` 已经在真实长回复上跑通，`Ctrl+C` 后会恢复到 idle，`runPrompt()` 会以“已取消”结束
- `cursor agent create-chat` 能稳定拿到 `cursorCliChatId`，`TmuxCursorSession` 已默认改成先拿 chat id 再用 `--resume` 启动交互式会话
- `TmuxSlotStore + TmuxSlotRegistry + TmuxCursorSession.describeBinding()` 已经在真实 demo 上跑通：
  - 第一次运行把 active pane 写入 store
  - 第二次从 store 读出 `paneId/sessionName`
  - 再 attach 回原来的 `cursor agent` 会话并继续对话
- `TmuxSlotRegistry.restoreActiveSlot()` 已经在真实 demo 上跑通：
  - 先故意销毁原 tmux session，制造失效 pane
  - registry 先 probe 旧 binding，确认原 pane 不再可用
  - 然后自动 rebuild 一个新的 `TmuxCursorSession`
  - 再把 active slot 从旧 pane 更新到新 pane，并继续成功对话
- `resume-chatid-demo.ts` 已经在真实会话上跑通：
  - 第一轮先让 agent 记住口令 `BANANA`
  - 然后销毁原 pane，模拟 tmux 会话丢失
  - registry 使用同一个 `cursorCliChatId` rebuild 新 pane
  - 第二轮仍能回答上一轮记住的口令，证明跨 pane 的 Cursor 对话续接成立
- `tmux-acp-smoke.ts` 已经在真实会话上跑通：
  - `newSession` 会创建新的 ACP session，并返回独立的 `sessionId`
  - `_meta.cursorChatId` 会带回底层 `cursorCliChatId`
  - server 重启后，`loadSession(sessionId)` 能重新绑定/重建底层 tmux pane
  - 随后再次 `prompt`，仍能回答上一轮记住的口令，证明 ACP session -> Cursor chat 的恢复链路成立
- `tmux-acp-cancel-smoke.ts` 已经在真实会话上跑通：
  - 发送长 prompt 后，client 通过 ACP `session/cancel` 通知取消
  - server 会转成 `TmuxCursorSession.cancelCurrentTurn()`
  - 最终 `session/prompt` 返回 `stopReason: cancelled`

## 观察重点

运行时请重点看下面几件事：

- `capture-pane -a` 是否能抓到你在 pane 中看到的交互界面
- 回答流式进行时，快照变化频率是否足够稳定
- 回答完成后，界面是否会回到某种可识别的空闲态
- 完成后若再次轮询，屏幕是否保持稳定

## 下一步建议

如果继续推进，下一步优先做：

1. 把 `tmux-acp-server.ts` 的 prompt 输出从“整轮结束后聚合文本”升级为更接近 ACP 的增量流式更新。
2. 明确 `cursorCliChatId` 在 bridge session / ACP session / slot 三层之间的归属和同步策略。
3. 评估是让主项目新增 `tmux` 后端直连这个 server，还是直接让 bridge 把它当第三种 `BridgeAcpRuntime` 来启动。
