import {
  formatSupportedBackendValuePattern,
  getBackendShortcut,
} from "../acp/backend-metadata.js";
import type { AcpBackend } from "../acp/runtime-contract.js";

export function formatBridgeCommandsHelp(_backend: AcpBackend): string {
  const acpNote =
    "在当前 session 的 backend 下，`/model` 与 `/mode` 由桥接调用 ACP；不带参数时列出当前活跃 session 的可用模型 / 模式。";
  const backendPattern = formatSupportedBackendValuePattern();
  const officialShortcut = getBackendShortcut("cursor-official");
  const claudeShortcut = getBackendShortcut("claude");
  const codexAppServerShortcut = getBackendShortcut("codex-app-server");
  const geminiShortcut = getBackendShortcut("gemini");

  return [
    "📖 **本桥接识别的命令一览**",
    "",
    "私聊直接发送即可；群聊须 @ 机器人。不以本表命令开头的文字在已有 session 时作为普通对话发给 Agent。",
    "若设 `BRIDGE_GROUP_SESSION_SCOPE=shared`，群内共享同一组 session；此时 `/new`、`/switch`、`/close`、`/resume`、`/mode`、`/model`、`/stop` 等管理命令仅管理员可用。",
    "",
    acpNote,
    "",
    "**Session 与工作区**",
    "• `/new` — 同 `/new list`（工作区快捷列表）",
    `• \`/new <序号> --backend <${backendPattern}>\` — 用列表第 N 项创建并切换到新 session；也支持 \`-b <backend>\`，如 \`-b ${officialShortcut}\` / \`-b ${claudeShortcut}\` / \`-b ${codexAppServerShortcut}\` / \`-b ${geminiShortcut}\``,
    `• \`/new <目录绝对路径> --backend <${backendPattern}>\` — 指定工作区；可附 \`--name <名称>\`，\`-b ${officialShortcut}\` 等同 \`--backend cursor-official\``,
    "• `/new add-list <路径>` / `/new remove-list <序号>` — 维护快捷列表",
    "• `/sessions` — 列出当前聊天/话题下所有 session（含 backend）",
    "• `/switch` — 切到上一槽位；`/switch <编号或名称>` — 指定槽位",
    "• `/close <编号或名称>` / `/close all` — 关闭 session",
    "• `/rename <新名>` / `/rename <编号或名称> <新名>`",
    "",
    "**对话与控制**",
    "• `/reply` — 重发当前槽位缓存的上一轮；`/reply <编号或名称>` — 指定槽位",
    "• `/history` — 查看当前槽位最近几条 prompt；`/history <条数>` — 指定显示条数（最多 20）",
    "• `/resume` — 列出当前 project 可恢复的历史 session",
    "• `/resume 0` — 对当前 session 执行 ACP `session/load`",
    "• `/resume <序号或sessionId>` — 恢复到指定历史 session",
    "• `/resume -b <backend> <id>` — 直接按 backend 指定的恢复 ID 绑定当前槽位",
    "• `/stop` / `/cancel` — 中断当前活跃槽位正在生成的回复；若该槽位有排队消息，也会一并撤销",
    "• `/fileback <说明>` — 向 Agent 附带「用 `FEISHU_SEND_FILE` 发文件」说明后再发你的任务",
    "• `!<shell 命令>` — bridge 直接在当前 session 工作区执行本地终端命令（默认开启；仅管理员可用；可设 `BRIDGE_ENABLE_BANG_COMMAND=false` 关闭）",
    "",
    "**模型与模式**",
    "• `/model` — 查看或切换模型（行为取决于当前 session backend）",
    "• `/mode` — 查看或切换模式（行为取决于当前 session backend）",
    "",
    "**其它**",
    "• `/restart` / `/restart --force` — 重启 bridge 服务（仅管理员私聊）",
    "• `/update` / `/update --force` — `npm install` + `npm run build` 后重启（仅管理员私聊）",
    "• `/upgrade` / `/upgrade --force` — 从 Git 远端 fast-forward 拉取并执行 update + restart（默认继承维护管理员；若配置 `BRIDGE_UPGRADE_ADMIN_*` 则仅专用管理员）",
    "• `/whoami` — 返回当前消息识别到的飞书用户 ID（可用于 `BRIDGE_ADMIN_USER_IDS`）",
    "• `/status` / `/状态` — 桥接与当前 session 统计",
    "• `/commands` / `/help` / `/帮助` / 单独 `/`（或全角 `／`）— 显示本列表（无需 session）",
    "• `/topic …` — 仅用于飞书话题标题等，整段不交给 Agent",
    "",
    "完整说明见仓库 `docs/feishu-commands.md`。",
  ].join("\n");
}
