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

/** 按 ACP 通知到达顺序记录；同类型连续块合并为一条（流式追加）。 */
type TimelineEntry =
  | { k: "thought"; text: string }
  | { k: "main"; text: string }
  | { k: "tool"; toolCallId: string; title: string; status: string }
  | { k: "mode"; markdown: string }
  | { k: "plan"; text: string }
  | { k: "commands"; text: string };

export class FeishuCardState {
  private timeline: TimelineEntry[] = [];

  constructor(private readonly showAcpAvailableCommands = false) {}

  apply(ev: BridgeAcpEvent): void {
    switch (ev.type) {
      case "user_message_chunk":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        break;
      case "agent_message_chunk":
        this.appendMain(ev.text);
        break;
      case "agent_thought_chunk":
        this.appendThought(ev.text);
        break;
      case "current_mode_update":
        this.timeline.push({
          k: "mode",
          markdown: `**当前模式**\n\n\`${ev.modeId}\``,
        });
        break;
      case "plan":
        this.timeline.push({ k: "plan", text: ev.summary });
        break;
      case "available_commands_update":
        if (this.showAcpAvailableCommands) {
          this.timeline.push({ k: "commands", text: ev.summary });
        }
        break;
      case "tool_call":
        this.timeline.push({
          k: "tool",
          toolCallId: ev.toolCallId,
          title: ev.title,
          status: ev.status,
        });
        break;
      case "tool_call_update": {
        const prev = this.lastToolState(ev.toolCallId);
        const title = ev.title ?? prev?.title ?? ev.toolCallId;
        this.timeline.push({
          k: "tool",
          toolCallId: ev.toolCallId,
          title,
          status: ev.status,
        });
        break;
      }
      default:
        break;
    }
  }

  private lastToolState(
    toolCallId: string,
  ): { title: string; status: string } | undefined {
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const e = this.timeline[i]!;
      if (e.k === "tool" && e.toolCallId === toolCallId) {
        return { title: e.title, status: e.status };
      }
    }
    return undefined;
  }

  private appendMain(text: string): void {
    const last = this.timeline[this.timeline.length - 1];
    if (last?.k === "main") {
      last.text += text;
    } else {
      this.timeline.push({ k: "main", text });
    }
  }

  private appendThought(text: string): void {
    const last = this.timeline[this.timeline.length - 1];
    if (last?.k === "thought") {
      last.text += text;
    } else {
      this.timeline.push({ k: "thought", text });
    }
  }

  reset(): void {
    this.timeline = [];
  }

  clone(): FeishuCardState {
    const next = new FeishuCardState(this.showAcpAvailableCommands);
    next.timeline = this.timeline.map((e) => ({ ...e }));
    return next;
  }

  hasContent(): boolean {
    return this.timeline.length > 0;
  }

  getMainText(): string {
    return this.timeline
      .filter((e): e is Extract<TimelineEntry, { k: "main" }> => e.k === "main")
      .map((e) => e.text)
      .join("");
  }

  setMainText(text: string): void {
    this.timeline = [{ k: "main", text }];
  }

  hasMainText(): boolean {
    return this.getMainText().trim().length > 0;
  }

  toolCount(): number {
    return new Set(
      this.timeline
        .filter((e): e is Extract<TimelineEntry, { k: "tool" }> => e.k === "tool")
        .map((e) => e.toolCallId),
    ).size;
  }

  markdownLength(): number {
    return this.toMarkdown().length;
  }

  toCardMarkdownChunks(opts: CardChunkOptions): string[] {
    if (!this.hasContent()) return ["_（暂无输出）_"];

    const sections = this.buildSections(opts);
    const chunks: string[] = [];
    let current = "";
    /** 仅禁止「紧挨着的两个工具区块」合并；时间线里可出现 工具→回答→工具，中间有回答时仍应能落在同一张卡片。 */
    let lastMergedKind: RenderSection["kind"] | undefined;

    for (const section of sections) {
      if (!section.markdown) continue;
      if (!current) {
        current = section.markdown;
        lastMergedKind = section.kind;
        continue;
      }
      const next = `${current}\n\n${section.markdown}`;
      const consecutiveToolBlocks =
        section.kind === "tool" && lastMergedKind === "tool";
      if (!consecutiveToolBlocks && next.length <= opts.maxMarkdownLength) {
        current = next;
        lastMergedKind = section.kind;
        continue;
      }
      chunks.push(current);
      current = section.markdown;
      lastMergedKind = section.kind;
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

  /** 按时间线顺序展开为带类型标题的区块（同类型连续条目会先合并再切分长度）。 */
  private buildSections(opts: CardChunkOptions): RenderSection[] {
    const parts: RenderSection[] = [];
    let i = 0;
    const tl = this.timeline;

    while (i < tl.length) {
      const e = tl[i]!;

      if (e.k === "mode") {
        parts.push({ kind: "mode", markdown: e.markdown });
        i++;
        continue;
      }

      if (e.k === "plan") {
        parts.push(
          ...this.splitFencedSection(
            "plan",
            "**计划**",
            e.text.trim(),
            opts.maxMarkdownLength,
          ),
        );
        i++;
        continue;
      }

      if (e.k === "commands") {
        parts.push(
          ...this.splitFencedSection(
            "commands",
            "**可用命令**",
            e.text.trim(),
            opts.maxMarkdownLength,
          ),
        );
        i++;
        continue;
      }

      if (e.k === "thought") {
        let body = e.text;
        while (i + 1 < tl.length && tl[i + 1]!.k === "thought") {
          i++;
          body += (tl[i] as Extract<TimelineEntry, { k: "thought" }>).text;
        }
        parts.push(
          ...this.splitFencedSection(
            "thought",
            "**思考**",
            body.trim(),
            opts.maxMarkdownLength,
          ),
        );
        i++;
        continue;
      }

      if (e.k === "main") {
        let body = e.text;
        while (i + 1 < tl.length && tl[i + 1]!.k === "main") {
          i++;
          body += (tl[i] as Extract<TimelineEntry, { k: "main" }>).text;
        }
        parts.push(
          ...this.splitPlainSection(
            "main",
            "**回答**",
            body.trim(),
            opts.maxMarkdownLength,
          ),
        );
        i++;
        continue;
      }

      if (e.k === "tool") {
        const lines: string[] = [];
        while (i < tl.length && tl[i]!.k === "tool") {
          const t = tl[i] as Extract<TimelineEntry, { k: "tool" }>;
          lines.push(`${t.title} — ${t.status}`);
          i++;
        }
        parts.push(
          ...this.splitToolLinesIntoSections(
            lines,
            opts.maxMarkdownLength,
            opts.maxTools,
          ),
        );
        continue;
      }

      i++;
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
    for (let j = 0; j < body.length; j += maxBodyLength) {
      chunks.push({
        kind,
        markdown: `${prefix}${body.slice(j, j + maxBodyLength)}`,
      });
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
    const maxBodyLength = Math.max(
      1,
      maxMarkdownLength - prefix.length - suffix.length,
    );
    if (prefix.length + body.length + suffix.length <= maxMarkdownLength) {
      return [{ kind, markdown: `${prefix}${body}${suffix}` }];
    }

    const chunks: RenderSection[] = [];
    for (let j = 0; j < body.length; j += maxBodyLength) {
      chunks.push({
        kind,
        markdown: `${prefix}${body.slice(j, j + maxBodyLength)}${suffix}`,
      });
    }
    return chunks;
  }

  /** 按时间顺序传入的工具行（每条对应一次 tool_call / tool_call_update）。 */
  private splitToolLinesIntoSections(
    lines: string[],
    maxMarkdownLength: number,
    maxTools: number,
  ): RenderSection[] {
    const prefix = "**工具**\n\n```\n";
    const suffix = "\n```";
    const maxBodyLength = Math.max(
      1,
      maxMarkdownLength - prefix.length - suffix.length,
    );
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

    for (const line of lines) {
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
