import type { BridgeAcpEvent } from "./acp/types.js";

/**
 * 将多条 ACP 归一化事件折叠为一张飞书 interactive 卡片可用的 lark_md 文本。
 */
export class FeishuCardState {
  private main = "";
  private thought = "";
  private modeLine = "";
  private plan = "";
  private commands = "";
  private readonly tools = new Map<
    string,
    { title: string; status: string }
  >();

  apply(ev: BridgeAcpEvent): void {
    switch (ev.type) {
      case "user_message_chunk":
        break;
      case "agent_message_chunk":
        this.main += ev.text;
        break;
      case "agent_thought_chunk":
        this.thought += ev.text;
        break;
      case "current_mode_update": {
        this.modeLine = `**当前模式:** \`${ev.modeId}\``;
        break;
      }
      case "plan":
        this.plan = ev.summary;
        break;
      case "available_commands_update":
        this.commands = ev.summary;
        break;
      case "tool_call":
        this.tools.set(ev.toolCallId, { title: ev.title, status: ev.status });
        break;
      case "tool_call_update": {
        const prev = this.tools.get(ev.toolCallId);
        const title = ev.title ?? prev?.title ?? ev.toolCallId;
        this.tools.set(ev.toolCallId, {
          title,
          status: ev.status,
        });
        break;
      }
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;
      default:
        break;
    }
  }

  /** 除占位外是否有任意实质内容 */
  hasContent(): boolean {
    return (
      this.main.trim().length > 0 ||
      this.thought.trim().length > 0 ||
      this.tools.size > 0 ||
      this.plan.length > 0 ||
      this.commands.length > 0 ||
      this.modeLine.length > 0
    );
  }

  getMainText(): string {
    return this.main;
  }

  setMainText(text: string): void {
    this.main = text;
  }

  hasThoughtText(): boolean {
    return this.thought.trim().length > 0;
  }

  toMarkdown(): string {
    const parts: string[] = [];

    if (this.modeLine) parts.push(this.modeLine);

    if (this.plan) {
      parts.push("**计划**");
      parts.push("```");
      parts.push(this.plan);
      parts.push("```");
    }

    if (this.tools.size > 0) {
      parts.push("**工具**");
      for (const [, t] of this.tools) {
        parts.push(`- ${t.title} — \`${t.status}\``);
      }
    }

    if (this.thought.trim()) {
      parts.push("**思考过程**");
      parts.push(this.thought.trim());
    }

    if (this.main.trim()) {
      parts.push("**回答**");
      parts.push(this.main.trim());
    }

    if (this.commands) {
      parts.push("**可用命令**");
      parts.push("```");
      parts.push(this.commands);
      parts.push("```");
    }

    const body = parts.join("\n\n").trim();
    return body || "_（暂无输出）_";
  }
}
