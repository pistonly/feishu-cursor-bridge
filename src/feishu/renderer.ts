import type { ToolKind } from "@agentclientprotocol/sdk";
import type { BridgeAcpEvent } from "../acp/types.js";
import { stripFeishuSendFileDirectives } from "./send-file.js";
import { emojiForToolKind } from "../utils/tool-kind-emoji.js";

/**
 * 思考块：🤔 与段落首行开头同行，💡 与末行结尾同行（不单独占行）。
 * 供飞书卡片与 replay 折叠共用。
 */
export function formatThoughtBlockInline(body: string): string {
  const t = body.trim();
  if (!t) return "";
  const lines = t.split(/\r?\n/);
  if (lines.length === 1) {
    return `🤔 ${lines[0]} 💡`;
  }
  const first = `🤔 ${lines[0]}`;
  const lastLine = lines[lines.length - 1]!;
  const last = `${lastLine} 💡`;
  if (lines.length === 2) {
    return `${first}\n${last}`;
  }
  return `${first}\n${lines.slice(1, -1).join("\n")}\n${last}`;
}

export function isRenderableEvent(
  ev: BridgeAcpEvent,
  showAcpAvailableCommands: boolean,
): boolean {
  switch (ev.type) {
    case "agent_thought_chunk":
    case "agent_message_chunk":
    case "plan":
    case "current_mode_update":
    case "config_option_update":
    case "tool_call":
    case "tool_call_update":
    case "usage_update":
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

type ToolElapsedHintOptions = {
  activeToolElapsedHintDelayMs: number;
  activeToolElapsedHintIntervalMs: number;
};

const DEFAULT_TOOL_ELAPSED_HINT_OPTIONS: ToolElapsedHintOptions = {
  activeToolElapsedHintDelayMs: 10_000,
  activeToolElapsedHintIntervalMs: 10_000,
};

type RenderSection = {
  kind: "mode" | "plan" | "tool" | "thought" | "main" | "commands";
  markdown: string;
};

/** 按 ACP 通知到达顺序记录；同类型连续块合并为一条（流式追加）。 */
type TimelineEntry =
  | { k: "thought"; text: string }
  | { k: "main"; text: string }
  | {
      k: "tool";
      toolCallId: string;
      title: string;
      status: string;
      startedAtMs: number;
      toolKind?: ToolKind;
    }
  | { k: "mode"; markdown: string }
  | { k: "plan"; text: string }
  | { k: "commands"; text: string };

export class FeishuCardState {
  private timeline: TimelineEntry[] = [];
  private statusSummary = "";
  private toolTimelineIndexById = new Map<string, number>();

  constructor(
    private readonly showAcpAvailableCommands = false,
    private readonly toolElapsedHintOptions: ToolElapsedHintOptions =
      DEFAULT_TOOL_ELAPSED_HINT_OPTIONS,
  ) {}

  setStatusSummary(summary: string): void {
    this.statusSummary = summary.trim();
  }

  hasStatusSummary(): boolean {
    return this.statusSummary.length > 0;
  }

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
        this.upsertToolEntry({
          k: "tool",
          toolCallId: ev.toolCallId,
          title: ev.title,
          status: this.normalizeIncomingToolStatus(ev.status),
          startedAtMs: Date.now(),
          ...(ev.kind !== undefined ? { toolKind: ev.kind } : {}),
        });
        break;
      case "tool_call_update": {
        const prev = this.lastToolState(ev.toolCallId);
        const title = ev.title ?? prev?.title ?? ev.toolCallId;
        const toolKind = ev.kind ?? prev?.toolKind;
        const status = this.normalizeIncomingToolStatus(ev.status, prev?.status);
        if (
          prev &&
          prev.title === title &&
          prev.status === status &&
          prev.toolKind === toolKind
        ) {
          break;
        }
        this.upsertToolEntry({
          k: "tool",
          toolCallId: ev.toolCallId,
          title,
          status,
          startedAtMs: prev?.startedAtMs ?? Date.now(),
          ...(toolKind !== undefined ? { toolKind } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  private lastToolState(
    toolCallId: string,
  ): {
    title: string;
    status: string;
    startedAtMs: number;
    toolKind?: ToolKind;
  } | undefined {
    const index = this.toolTimelineIndexById.get(toolCallId);
    if (index == null) return undefined;
    const e = this.timeline[index];
    if (!e || e.k !== "tool") return undefined;
    return {
      title: e.title,
      status: e.status,
      startedAtMs: e.startedAtMs,
      ...(e.toolKind !== undefined ? { toolKind: e.toolKind } : {}),
    };
  }

  private upsertToolEntry(entry: Extract<TimelineEntry, { k: "tool" }>): void {
    const index = this.toolTimelineIndexById.get(entry.toolCallId);
    if (index == null) {
      this.timeline.push(entry);
      this.toolTimelineIndexById.set(entry.toolCallId, this.timeline.length - 1);
      return;
    }
    this.timeline[index] = entry;
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
    this.toolTimelineIndexById.clear();
  }

  clone(): FeishuCardState {
    const next = new FeishuCardState(
      this.showAcpAvailableCommands,
      this.toolElapsedHintOptions,
    );
    next.timeline = this.timeline.map((e) => ({ ...e }));
    next.statusSummary = this.statusSummary;
    next.toolTimelineIndexById = new Map(this.toolTimelineIndexById);
    return next;
  }

  hasContent(): boolean {
    return this.timeline.length > 0 || this.hasStatusSummary();
  }

  getMainText(): string {
    return this.timeline
      .filter((e): e is Extract<TimelineEntry, { k: "main" }> => e.k === "main")
      .map((e) => e.text)
      .join("");
  }

  /**
   * 从正文时间线里去掉 `FEISHU_SEND_FILE:` 指令行，返回待发送的原始路径列表（相对或绝对，由上层结合 workspace 解析）。
   */
  extractAndStripFeishuSendFileDirectives(): string[] {
    const paths: string[] = [];
    for (const e of this.timeline) {
      if (e.k !== "main") continue;
      const { cleaned, rawPaths } = stripFeishuSendFileDirectives(e.text);
      e.text = cleaned;
      paths.push(...rawPaths);
    }
    return paths;
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

  hasActiveTool(): boolean {
    return this.timeline.some(
      (entry) => entry.k === "tool" && this.isToolActiveStatus(entry.status),
    );
  }

  nextToolRefreshDelayMs(nowMs = Date.now()): number | undefined {
    let nextRefreshAtMs: number | undefined;
    for (const entry of this.timeline) {
      if (entry.k !== "tool" || !this.isToolActiveStatus(entry.status)) continue;
      const refreshAtMs = this.nextToolRefreshAtMs(entry.startedAtMs, nowMs);
      if (refreshAtMs == null) continue;
      nextRefreshAtMs =
        nextRefreshAtMs == null ? refreshAtMs : Math.min(nextRefreshAtMs, refreshAtMs);
    }
    if (nextRefreshAtMs == null) return undefined;
    return Math.max(0, nextRefreshAtMs - nowMs);
  }

  toCardMarkdownChunks(opts: CardChunkOptions, nowMs = Date.now()): string[] {
    if (!this.hasContent()) return ["_（暂无输出）_"];

    const sections = this.buildSections(opts, nowMs);
    const chunks: string[] = [];
    let current = "";

    for (const section of sections) {
      if (!section.markdown) continue;
      if (!current) {
        current = section.markdown;
        continue;
      }
      const next = `${current}\n\n${section.markdown}`;
      if (next.length <= opts.maxMarkdownLength) {
        current = next;
        continue;
      }
      chunks.push(current);
      current = section.markdown;
    }

    if (current) chunks.push(current);
    const withStatus = this.appendStatusSummaryToLastChunk(
      chunks.length > 0 ? chunks : ["_（暂无输出）_"],
      opts.maxMarkdownLength,
    );
    return withStatus.length > 0 ? withStatus : ["_（暂无输出）_"];
  }

  toMarkdown(nowMs = Date.now()): string {
    return this.toCardMarkdownChunks({
      maxMarkdownLength: Number.MAX_SAFE_INTEGER,
      maxTools: Number.MAX_SAFE_INTEGER,
    }, nowMs)[0]!;
  }

  /** 按时间线顺序展开为区块（思考为行内 🤔/💡；同类型连续条目先合并再切分长度）。 */
  private buildSections(opts: CardChunkOptions, nowMs: number): RenderSection[] {
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
          ...this.splitThoughtWrappedSection(
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
          ...this.splitMainBodySections(body, opts.maxMarkdownLength),
        );
        i++;
        continue;
      }

      if (e.k === "tool") {
        const lines: string[] = [];
        while (i < tl.length && tl[i]!.k === "tool") {
          const t = tl[i] as Extract<TimelineEntry, { k: "tool" }>;
          const emoji = emojiForToolKind(t.toolKind);
          lines.push(`${emoji} ${t.title} — ${this.formatToolStatus(t, nowMs)}`);
          i++;
        }
        parts.push(
          ...this.splitToolPlainSections(
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

  private appendStatusSummaryToLastChunk(
    chunks: string[],
    maxMarkdownLength: number,
  ): string[] {
    if (!this.statusSummary) return chunks;
    const last = chunks.at(-1);
    if (!last) return [this.statusSummary];

    const appended = `${last}\n\n${this.statusSummary}`;
    if (appended.length <= maxMarkdownLength) {
      return [...chunks.slice(0, -1), appended];
    }

    return [...chunks, this.statusSummary];
  }

  /**
   * 思考：行内 🤔…💡；过长时按字符切段，每段 `🤔 slice 💡` 便于拆卡。
   */
  private splitThoughtWrappedSection(
    body: string,
    maxMarkdownLength: number,
  ): RenderSection[] {
    const t = body.trim();
    if (!t) return [];
    const wrapped = formatThoughtBlockInline(t);
    if (wrapped.length <= maxMarkdownLength) {
      return [{ kind: "thought", markdown: wrapped }];
    }
    const overhead = "🤔 ".length + " 💡".length;
    const innerMax = Math.max(1, maxMarkdownLength - overhead);
    const chunks: RenderSection[] = [];
    for (let j = 0; j < t.length; j += innerMax) {
      chunks.push({
        kind: "thought",
        markdown: `🤔 ${t.slice(j, j + innerMax)} 💡`,
      });
    }
    return chunks;
  }

  /** 助手正文：无「回答」标题。 */
  private splitMainBodySections(
    body: string,
    maxMarkdownLength: number,
  ): RenderSection[] {
    if (!body) return [];
    if (body.length <= maxMarkdownLength) {
      return [{ kind: "main", markdown: body }];
    }
    const chunks: RenderSection[] = [];
    for (let j = 0; j < body.length; j += maxMarkdownLength) {
      chunks.push({
        kind: "main",
        markdown: body.slice(j, j + maxMarkdownLength),
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

  /**
   * 工具行：行首 ACP `kind` 对应 emoji + 标题与状态；无 **工具** 标题与代码块，便于省空间。
   * 每条对应一次 tool_call / tool_call_update。
   */
  private splitToolPlainSections(
    lines: string[],
    maxMarkdownLength: number,
    maxTools: number,
  ): RenderSection[] {
    const sections: RenderSection[] = [];
    let currentLines: string[] = [];

    const pushCurrent = (): void => {
      if (currentLines.length === 0) return;
      sections.push({
        kind: "tool",
        markdown: currentLines.join("\n"),
      });
      currentLines = [];
    };

    for (const line of lines) {
      if (line.length > maxMarkdownLength) {
        pushCurrent();
        for (let j = 0; j < line.length; j += maxMarkdownLength) {
          sections.push({
            kind: "tool",
            markdown: line.slice(j, j + maxMarkdownLength),
          });
        }
        continue;
      }

      const nextLines = [...currentLines, line];
      const nextBody = nextLines.join("\n");
      if (
        currentLines.length > 0 &&
        (nextLines.length > maxTools || nextBody.length > maxMarkdownLength)
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

  private normalizeIncomingToolStatus(status: string, fallback?: string): string {
    const trimmed = status.trim();
    if (trimmed === "?") {
      return fallback ?? "in_progress";
    }
    if (trimmed) {
      return trimmed;
    }
    return fallback ?? "in_progress";
  }

  private isToolActiveStatus(status: string): boolean {
    return (
      status === "pending" ||
      status === "in_progress" ||
      status === "running"
    );
  }

  private nextToolRefreshAtMs(
    startedAtMs: number,
    nowMs: number,
  ): number | undefined {
    const { activeToolElapsedHintDelayMs, activeToolElapsedHintIntervalMs } =
      this.toolElapsedHintOptions;
    if (activeToolElapsedHintDelayMs <= 0 || activeToolElapsedHintIntervalMs <= 0) {
      return undefined;
    }
    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    if (elapsedMs < activeToolElapsedHintDelayMs) {
      return startedAtMs + activeToolElapsedHintDelayMs;
    }
    const elapsedSinceHintMs = elapsedMs - activeToolElapsedHintDelayMs;
    const nextBucket =
      Math.floor(elapsedSinceHintMs / activeToolElapsedHintIntervalMs) + 1;
    return (
      startedAtMs +
      activeToolElapsedHintDelayMs +
      nextBucket * activeToolElapsedHintIntervalMs
    );
  }

  private formatToolStatus(
    entry: Extract<TimelineEntry, { k: "tool" }>,
    nowMs: number,
  ): string {
    const baseStatus = entry.status;
    if (!this.isToolActiveStatus(baseStatus)) {
      return baseStatus;
    }

    const { activeToolElapsedHintDelayMs, activeToolElapsedHintIntervalMs } =
      this.toolElapsedHintOptions;
    if (activeToolElapsedHintDelayMs <= 0 || activeToolElapsedHintIntervalMs <= 0) {
      return baseStatus;
    }

    const elapsedMs = Math.max(0, nowMs - entry.startedAtMs);
    if (elapsedMs < activeToolElapsedHintDelayMs) {
      return baseStatus;
    }

    const elapsedHintMs =
      activeToolElapsedHintDelayMs +
      Math.floor(
        (elapsedMs - activeToolElapsedHintDelayMs) / activeToolElapsedHintIntervalMs,
      ) *
        activeToolElapsedHintIntervalMs;

    return `${baseStatus} (${this.formatElapsed(elapsedHintMs)})`;
  }

  private formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) {
      return `${totalSeconds}s`;
    }
    if (seconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${seconds}s`;
  }
}
