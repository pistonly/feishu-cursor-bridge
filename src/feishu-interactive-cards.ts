import type { AcpBackend } from "./acp/runtime-contract.js";

/**
 * 交互式卡片数据结构
 */
export interface WorkspaceSelectCardOptions {
  presets: readonly string[];
  showBackendSelector?: boolean;
  enabledBackends?: readonly AcpBackend[];
}

/**
 * 构建工作区选择卡片
 * 注意：飞书的按钮卡片在某些版本可能需要配置交互回调
 * 这里我们先构建一个可视化的选择界面
 */
export function buildWorkspaceSelectCardMarkdown(opts: WorkspaceSelectCardOptions): string {
  const lines: string[] = [];

  lines.push("📋 **选择工作区**");
  lines.push("");

  const { presets } = opts;

  if (presets.length === 0) {
    lines.push("❌ 暂无工作区预设。");
    lines.push("");
    lines.push("请使用以下方式添加工作区:");
    lines.push("• `/new add-list <路径>` - 添加工作区到快捷列表");
    lines.push("• `/new <完整路径>` - 直接指定工作区路径");
  } else {
    lines.push("请选择一个工作区（点击序号或输入命令）:");
    lines.push("");

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i]!;
      const num = i + 1;
      lines.push(`**${num}.** \`${preset}\``);
      lines.push(`   → 发送 \`/new ${num}\` 使用此工作区`);
      lines.push("");
    }

    lines.push("---");
    lines.push("**其他操作:**");
    lines.push("• `/new <路径> --name <名称>` - 使用自定义路径并命名");
    lines.push("• `/new <序号> --name <名称>` - 使用预设并命名");
    lines.push("• `/new add-list <路径>` - 添加新工作区到列表");
    lines.push("• `/new remove-list <序号>` - 从列表中删除工作区");
    lines.push("• `/help` - 查看完整帮助");
  }

  return lines.join("\n");
}

/**
 * 构建带后端选择的工作区选择卡片
 */
export function buildWorkspaceWithBackendSelectCardMarkdown(
  opts: WorkspaceSelectCardOptions & { defaultBackend: AcpBackend },
): string {
  const base = buildWorkspaceSelectCardMarkdown(opts);
  const lines: string[] = [base];

  if (opts.showBackendSelector && opts.enabledBackends && opts.enabledBackends.length > 1) {
    lines.push("");
    lines.push("---");
    lines.push("**后端选择 (可选):**");
    lines.push("");

    for (const backend of opts.enabledBackends) {
      const isDefault = backend === opts.defaultBackend;
      const defaultMarker = isDefault ? " (默认)" : "";
      lines.push(`• \`--backend ${backend}\`${defaultMarker}`);
    }

    lines.push("");
    lines.push("示例: `/new 1 --backend claude --name my-project`");
  }

  return lines.join("\n");
}

/**
 * 构建快速操作提示卡片
 */
/**
 * 构建欢迎卡片（首次使用时显示）
 */
export function buildWelcomeCardMarkdown(): string {
  return [
    "🎉 **欢迎使用 Cursor AI Agent 桥接服务！**",
    "",
    "这是一个飞书与多个 AI 后端的桥接工具，让你在飞书中直接与 Cursor AI 进行对话。",
    "",
    "---",
    "",
    "🚀 **快速开始**",
    "",
    "**1. 创建第一个会话:**",
    "   • 发送 `/new` 查看工作区列表",
    "   • 发送 `/new <序号>` 使用预设工作区",
    "   • 发送 `/new <路径>` 使用自定义路径",
    "",
    "**2. 支持的后端:**",
    "   • `cursor-official` - Cursor 官方 ACP 后端",
    "   • `cursor-legacy` - 内嵌适配器后端",
    "   • `cursor-tmux` - tmux 集成后端",
    "   • `claude` - Claude AI 后端",
    "",
    "**3. 命令示例:**",
    "   • `/new 1 --backend claude` - 使用第 1 个工作区和 Claude 后端",
    "   • `/new /path/to/project --name my-project` - 自定义路径并命名",
    "   • `/new /path/to/project --backend cursor-tmux` - 使用 tmux 后端",
    "",
    "---",
    "",
    "💡 **提示:**",
    "",
    "• 发送 `/commands` 查看完整命令列表",
    "• 发送 `/help` 查看详细使用说明",
    "• 在群聊中需要 @ 机器人",
    "",
    "现在就开始吧！发送 `/new` 查看你的工作区列表。",
  ].join("\n");
}

/**
 * 构建快速操作提示卡片
 */
export function buildQuickActionsHelp(): string {
  return [
    "⚡ **快速操作指南**",
    "",
    "**会话管理:**",
    "• `/new` - 选择工作区创建会话",
    "• `/sessions` - 列出所有会话",
    "• `/switch <编号>` - 切换会话",
    "• `/close <编号>` - 关闭会话",
    "",
    "**对话控制:**",
    "• `/stop` - 中断当前生成",
    "• `/reply` - 重发上一轮",
    "• `/model` - 查看/切换模型",
    "• `/mode` - 查看/切换模式",
    "",
    "**发送 `/help` 查看完整命令列表**",
  ].join("\n");
}
