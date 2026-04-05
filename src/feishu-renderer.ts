import type { BridgeAcpEvent } from "./acp/types.js";

export function isRenderableEvent(
  ev: BridgeAcpEvent,
  showAcpAvailableCommands: boolean,
): boolean {
  switch (ev.type) {
    case "agent_thought_chunk":
    case "agent_message_chunk":
    case "plan":
    case "current_mode_update":
    case "tool_call":
    case "tool_call_update":
      return true;
    case "available_commands_update":
      return showAcpAvailableCommands;
    default:
      return false;
  }
}

type CardChunkOptions = {
  maxMarkdownLength: number;
  maxTools: number;
};

type RenderSection = {
  kind: "mode" | "plan" | "tool" | "thought" | "main" | "commands";
  markdown: string;
};

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

  constructor(private readonly showAcpAvailableCommands = false) {}

  apply(ev: BridgeAcpEvent): void {
    switch (ev.type) {
      case "user_message_chunk":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;
      case "agent_message_chunk":
        this.main += ev.text;
        break;
      case "agent_thought_chunk":
        this.thought += ev.text;
        break;
      case "current_mode_update":
        this.modeLine = `**当前模式**\n\n\`${ev.modeId}\``;
        break;
      case "plan":
        this.plan = ev.summary;
        break;
      case "available_commands_update":
        if (this.showAcpAvailableCommands) {
          this.commands = ev.summary;
        }
        break;
      case "tool_call":
        this.tools.set(ev.toolCallId, { title: ev.title, status: ev.status });
        break;
      case "tool_call_update": {
        const prev = this.tools.get(ev.toolCallId);
        const title = ev.title ?? prev?.title ?? ev.toolCallId;
        this.tools.set(ev.toolCallId, { title, status: ev.status });
        break;
      }
      default:
        break;
    }
  }

  reset(): void {
    this.main = "";
    this.thought = "";
    this.modeLine = "";
    this.plan = "";
    this.commands = "";
    this.tools.clear();
  }

  clone(): FeishuCardState {
    const next = new FeishuCardState(this.showAcpAvailableCommands);
    next.main = this.main;
    next.thought = this.thought;
    next.modeLine = this.modeLine;
    next.plan = this.plan;
    next.commands = this.commands;
    for (const [id, tool] of this.tools) {
      next.tools.set(id, { ...tool });
    }
    return next;
  }

  hasContent(): boolean {
    return (
      this.main.trim().length > 0 ||
      this.thought.trim().length > 0 ||
      this.tools.size > 0 ||
      this.plan.trim().length > 0 ||
      this.commands.trim().length > 0 ||
      this.modeLine.trim().length > 0
    );
  }

  getMainText(): string {
    return this.main;
  }

  setMainText(text: string): void {
    this.main = text;
  }

  hasMainText(): boolean {
    return this.main.trim().length > 0;
  }

  toolCount(): number {
    return this.tools.size;
  }

  markdownLength(): number {
    return this.toMarkdown().length;
  }

  toCardMarkdownChunks(opts: CardChunkOptions): string[] {
    if (!this.hasContent()) return ["_（暂无输出）_"];

    const sections = this.buildSections(opts);
    const chunks: string[] = [];
    let current = "";
    let currentKinds = new Set<RenderSection["kind"]>();

    for (const section of sections) {
      if (!section.markdown) continue;
      if (!current) {
        current = section.markdown;
        currentKinds = new Set([section.kind]);
        continue;
      }
      const next = `${current}\n\n${section.markdown}`;
      const wouldDuplicateToolSection =
        section.kind === "tool" && currentKinds.has("tool");
      if (!wouldDuplicateToolSection && next.length <= opts.maxMarkdownLength) {
        current = next;
        currentKinds.add(section.kind);
        continue;
      }
      chunks.push(current);
      current = section.markdown;
      currentKinds = new Set([section.kind]);
    }

    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ["_（暂无输出）_"];
  }

  toMarkdown(): string {
    return this.toCardMarkdownChunks({
      maxMarkdownLength: Number.MAX_SAFE_INTEGER,
      maxTools: Number.MAX_SAFE_INTEGER,
    })[0]!;
  }

  private buildSections(opts: CardChunkOptions): RenderSection[] {
    const parts: RenderSection[] = [];

    if (this.modeLine) parts.push({ kind: "mode", markdown: this.modeLine });
    if (this.plan.trim()) {
      parts.push(
        ...this.splitFencedSection(
          "plan",
          "**计划**",
          this.plan.trim(),
          opts.maxMarkdownLength,
        ),
      );
    }
    if (this.tools.size > 0) {
      parts.push(
        ...this.splitToolSections(opts.maxMarkdownLength, opts.maxTools),
      );
    }
    if (this.thought.trim()) {
      parts.push(
        ...this.splitFencedSection(
          "thought",
          "**思考**",
          this.thought.trim(),
          opts.maxMarkdownLength,
        ),
      );
    }
    if (this.main.trim()) {
      parts.push(
        ...this.splitPlainSection(
          "main",
          "**回答**",
          this.main.trim(),
          opts.maxMarkdownLength,
        ),
      );
    }
    if (this.commands.trim()) {
      parts.push(
        ...this.splitFencedSection(
          "commands",
          "**可用命令**",
          this.commands.trim(),
          opts.maxMarkdownLength,
        ),
      );
    }
    return parts;
  }

  private splitPlainSection(
    kind: RenderSection["kind"],
    title: string,
    body: string,
    maxMarkdownLength: number,
  ): RenderSection[] {
    const prefix = `${title}\n\n`;
    const maxBodyLength = Math.max(1, maxMarkdownLength - prefix.length);
    if (prefix.length + body.length <= maxMarkdownLength) {
      return [{ kind, markdown: `${prefix}${body}` }];
    }

    const chunks: RenderSection[] = [];
    for (let i = 0; i < body.length; i += maxBodyLength) {
      chunks.push({ kind, markdown: `${prefix}${body.slice(i, i + maxBodyLength)}` });
    }
    return chunks;
  }

  private splitFencedSection(
    kind: RenderSection["kind"],
    title: string,
    body: string,
    maxMarkdownLength: number,
  ): RenderSection[] {
    const prefix = `${title}\n\n\`\`\`\n`;
    const suffix = "\n```";
    const maxBodyLength = Math.max(1, maxMarkdownLength - prefix.length - suffix.length);
    if (prefix.length + body.length + suffix.length <= maxMarkdownLength) {
      return [{ kind, markdown: `${prefix}${body}${suffix}` }];
    }

    const chunks: RenderSection[] = [];
    for (let i = 0; i < body.length; i += maxBodyLength) {
      chunks.push({
        kind,
        markdown: `${prefix}${body.slice(i, i + maxBodyLength)}${suffix}`,
      });
    }
    return chunks;
  }

  private splitToolSections(
    maxMarkdownLength: number,
    maxTools: number,
  ): RenderSection[] {
    const prefix = "**工具**\n\n```\n";
    const suffix = "\n```";
    const maxBodyLength = Math.max(1, maxMarkdownLength - prefix.length - suffix.length);
    const sections: RenderSection[] = [];
    let currentLines: string[] = [];

    const pushCurrent = (): void => {
      if (currentLines.length === 0) return;
      sections.push({
        kind: "tool",
        markdown: `${prefix}${currentLines.join("\n")}${suffix}`,
      });
      currentLines = [];
    };

    for (const [, tool] of this.tools) {
      const line = `${tool.title} — ${tool.status}`;
      if (line.length > maxBodyLength) {
        pushCurrent();
        sections.push(
          ...this.splitFencedSection("tool", "**工具**", line, maxMarkdownLength),
        );
        continue;
      }

      const nextLines = [...currentLines, line];
      const nextBody = nextLines.join("\n");
      if (
        currentLines.length > 0 &&
        (nextLines.length > maxTools || nextBody.length > maxBodyLength)
      ) {
        pushCurrent();
        currentLines = [line];
        continue;
      }

      currentLines = nextLines;
    }

    pushCurrent();
    return sections;
  }
}
