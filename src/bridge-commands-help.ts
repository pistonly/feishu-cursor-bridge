import type { AcpBackend } from "./acp/runtime-contract.js";

/**
 * 飞书侧「可用命令」回复正文（与 `docs/feishu-commands.md` 一致，此处为精简列表）。
 */
export function formatBridgeCommandsHelp(backend: AcpBackend): string {
  const acpNote =
    backend === "tmux"
      ? "在本 ACP 后端下，`/model` 与 `/mode` 会**原样发给 Cursor CLI**，由 CLI 处理；其它后端下一般由桥接调用 ACP（不带参数时列出当前 session 可用项）。"
      : "在本 ACP 后端下，`/model` 与 `/mode` 由桥接调用 ACP；不带参数时列出当前活跃 session 的可用模型 / 模式。";

  return [
    "📖 **本桥接识别的命令一览**",
    "",
    "私聊直接发送即可；**群聊须 @ 机器人**。不以本表命令开头的文字在**已有 session** 时作为普通对话发给 Agent。",
    "",
    acpNote,
    "",
    "**Session 与工作区**",
    "• `/new` — 同 `/new list`（工作区快捷列表）",
    "• `/new <序号>` — 用列表第 N 项创建并切换到新 session",
    "• `/new <目录绝对路径>` — 指定工作区（须在允许根下）；可附 `--name <名称>`",
    "• `/new add-list <路径>` / `/new remove-list <序号>` — 维护快捷列表",
    "• `/sessions` — 列出当前聊天/话题下所有 session",
    "• `/switch` — 切到上一槽位；`/switch <编号或名称>` — 指定槽位",
    "• `/close <编号或名称>` / `/close all` — 关闭 session",
    "• `/rename <新名>` / `/rename <编号或名称> <新名>`",
    "",
    "**对话与控制**",
    "• `/reply` — 重发当前槽位缓存的上一轮；`/reply <编号或名称>` — 指定槽位",
    "• `/stop` / `/cancel` — 中断**当前活跃**槽位正在生成的回复",
    "• `/fileback <说明>` — 向 Agent 附带「用 `FEISHU_SEND_FILE` 发文件」说明后再发你的任务",
    "",
    "**模型与模式**",
    "• `/model` — 查看或切换模型（行为见上文后端说明）",
    "• `/mode` — 查看或切换模式（行为见上文后端说明）",
    "",
    "**其它**",
    "• `/resume` — 对当前活跃 session 执行 ACP `session/load`（需适配器支持）",
    "• `/status` / `/状态` — 桥接与会话统计",
    "• `/commands` / `/help` / `/帮助` / 单独 `/`（或全角 `／`）— 显示本列表（**无需 session**）",
    "• `/topic …` — 仅用于飞书话题标题等，整段**不**交给 Agent",
    "",
    "完整说明见仓库 `docs/feishu-commands.md`。",
  ].join("\n");
}
