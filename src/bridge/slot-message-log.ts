import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { FeishuMessage } from "../feishu/bot.js";
import type { SessionSlot, UserSession } from "../session/manager.js";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeBlock(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized || "（空）";
}

function formatLabel(slot: SessionSlot): string {
  return `#${slot.slotIndex}${slot.name ? ` (${slot.name})` : ""}`;
}

function buildFileName(sessionKey: string, slot: SessionSlot): string {
  const hash = createHash("sha1").update(sessionKey).digest("hex").slice(0, 12);
  const backendSlug = slugify(slot.session.backend) || "backend";
  const slotNameSlug = slugify(slot.name ?? "") || "unnamed";
  const sessionKeySlug = slugify(sessionKey) || "session";
  const sessionIdSlug = slugify(slot.session.sessionId) || "acp-session";
  return `${backendSlug}--slot-${slot.slotIndex}--${slotNameSlug}--${sessionKeySlug}--session-${sessionIdSlug}--${hash}.log`;
}

type SlotLogContext = {
  sessionKey: string;
  slot: SessionSlot;
  session: UserSession;
  msg: FeishuMessage;
};

export class SlotMessageLogStore {
  constructor(private readonly baseDir: string) {}

  async appendPrompt(
    ctx: SlotLogContext,
    rawFeishuContent: string,
    agentPrompt: string,
  ): Promise<void> {
    const extra =
      rawFeishuContent.trim() === agentPrompt.trim()
        ? ""
        : `agent_prompt:\n${normalizeBlock(agentPrompt)}\n\n`;
    await this.appendEntry(
      ctx,
      "feishu_prompt",
      `feishu_content:\n${normalizeBlock(rawFeishuContent)}\n\n${extra}`,
    );
  }

  async appendReply(ctx: SlotLogContext, reply: string): Promise<void> {
    await this.appendEntry(ctx, "bridge_reply", `reply:\n${normalizeBlock(reply)}\n\n`);
  }

  async appendAcpAgentMessageChunk(
    ctx: SlotLogContext,
    chunkText: string,
  ): Promise<void> {
    await this.appendEntry(
      ctx,
      "acp_agent_message_chunk",
      `chunk_text:\n${normalizeBlock(chunkText)}\n\n`,
    );
  }

  async appendError(ctx: SlotLogContext, errorText: string): Promise<void> {
    await this.appendEntry(ctx, "bridge_error", `error:\n${normalizeBlock(errorText)}\n\n`);
  }

  private async appendEntry(
    ctx: SlotLogContext,
    kind:
      | "feishu_prompt"
      | "bridge_reply"
      | "acp_agent_message_chunk"
      | "bridge_error",
    body: string,
  ): Promise<void> {
    const filePath = path.join(
      this.baseDir,
      buildFileName(ctx.sessionKey, ctx.slot),
    );
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const header = [
      `=== ${new Date().toISOString()} ${kind} ===`,
      `slot: ${formatLabel(ctx.slot)}`,
      `backend: ${ctx.session.backend}`,
      `session_id: ${ctx.session.sessionId}`,
      `workspace: ${ctx.session.workspaceRoot}`,
      `feishu_chat_id: ${ctx.msg.chatId}`,
      `feishu_message_id: ${ctx.msg.messageId}`,
      `sender_id: ${ctx.msg.senderId}`,
      `chat_type: ${ctx.msg.chatType}`,
      `thread_id: ${ctx.msg.threadId ?? "—"}`,
      `reply_in_thread: ${ctx.msg.replyInThread === true ? "true" : "false"}`,
      `session_key: ${ctx.sessionKey}`,
      "",
    ].join("\n");
    await fsp.appendFile(filePath, `${header}${body}`, "utf8");
  }
}
