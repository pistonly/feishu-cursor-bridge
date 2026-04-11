import type { AcpBackend } from "./acp/runtime-contract.js";

export function formatBridgeCommandsHelp(backend: AcpBackend): string {
  const acpNote =
    backend === "cursor-tmux"
      ? "在当前 session 的 tmux backend 下，`/model` 与 `/mode` 会原样发给 Cursor CLI；其它 backend 下一般由桥接调用 ACP。"
      : "在当前 session 的 backend 下，`/model` 与 `/mode` 由桥接调用 ACP；不带参数时列出当前活跃 session 的可用模型 / 模式。";

  return [
    "📖 **本桥接识别的命令一览**",
    "",
    "私聊直接发送即可；群聊须 @ 机器人。不以本表命令开头的文字在已有 session 时作为普通对话发给 Agent。",
    "",
    acpNote,
    "",
    "**Session 与工作区**",
    "• `/new` — 同 `/new list`（工作区快捷列表）",
    "• `/new <序号> --backend <cursor-official|cursor-legacy|cursor-tmux|claude|codex>` — 用列表第 N 项创建并切换到新 session",
    "• `/new <目录绝对路径> --backend <cursor-official|cursor-legacy|cursor-tmux|claude|codex>` — 指定工作区；可附 `--name <名称>`",
    "• `/new add-list <路径>` / `/new remove-list <序号>` — 维护快捷列表",
    "• `/sessions` — 列出当前聊天/话题下所有 session（含 backend）",
    "• `/switch` — 切到上一槽位；`/switch <编号或名称>` — 指定槽位",
    "• `/close <编号或名称>` / `/close all` — 关闭 session",
    "• `/rename <新名>` / `/rename <编号或名称> <新名>`",
    "",
    "**对话与控制**",
    "• `/reply` — 重发当前槽位缓存的上一轮；`/reply <编号或名称>` — 指定槽位",
    "• `/stop` / `/cancel` — 中断当前活跃槽位正在生成的回复",
    "• `/fileback <说明>` — 向 Agent 附带「用 `FEISHU_SEND_FILE` 发文件」说明后再发你的任务",
    "",
    "**模型与模式**",
    "• `/model` — 查看或切换模型（行为取决于当前 session backend）",
    "• `/mode` — 查看或切换模式（行为取决于当前 session backend）",
    "",
    "**其它**",
    "• `/resume` — 对当前活跃 session 执行 ACP `session/load`（需当前 backend 支持）",
    "• `/status` / `/状态` — 桥接与当前 session 统计",
    "• `/commands` / `/help` / `/帮助` / 单独 `/`（或全角 `／`）— 显示本列表（无需 session）",
    "• `/topic …` — 仅用于飞书话题标题等，整段不交给 Agent",
    "",
    "完整说明见仓库 `docs/feishu-commands.md`。",
  ].join("\n");
}
