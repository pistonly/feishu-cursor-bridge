import type { FeishuMessage } from "../feishu/bot.js";
import type { SessionSlot } from "../session/manager.js";
import { NO_SESSION_HINT } from "./bridge-context.js";
import type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";
import { resolvePromptContentFromResource } from "./bridge-resource-prompt.js";
import {
  appendSlotAcpChunkLog,
  appendSlotErrorLog,
  appendSlotPromptLog,
  appendSlotReplyLog,
} from "./bridge-slot-logging.js";

export async function handlePromptMessage(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
  hasPostEmbeddedImages: boolean,
): Promise<void> {
  const sessionKey = ctx.feishuSessionKey(msg);
  const snap = ctx.sessionManager.getSessionSnapshot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  const promptKey = snap
    ? `${sessionKey}:${snap.activeSlot.slotIndex}`
    : sessionKey;

  if (ctx.activePrompts.has(promptKey)) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "⏳ 上一个请求还在处理中，请稍候...",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  try {
    ctx.activePrompts.add(promptKey);
    let activeSlot: SessionSlot | undefined;

    const session = await ctx.sessionManager.getActiveSession(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    if (!session) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        NO_SESSION_HINT,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    await ctx.flushPendingSessionNotices(msg);

    const resourcePrompt = await resolvePromptContentFromResource(
      { feishuBot: ctx.feishuBot },
      msg,
      session,
      content,
      hasPostEmbeddedImages,
    );
    if (!resourcePrompt.ok) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        resourcePrompt.errorText,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    const promptContent = resourcePrompt.promptContent;

    const msgForPrompt: FeishuMessage = {
      ...msg,
      content: promptContent,
    };
    activeSlot = await ctx.sessionManager.getSlot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      null,
      ctx.threadScope(msg),
    );
    await appendSlotPromptLog(
      {
        slotMessageLog: ctx.slotMessageLog,
        sessionKey,
        slot: activeSlot,
        session,
        msg: msgForPrompt,
      },
      content,
      promptContent,
    );

    const lastReply = await ctx
      .conversationForBackend(session.backend)
      .handleUserPrompt(msgForPrompt, session, {
        onAcpEvent: async (ev) => {
          if (ev.type !== "agent_message_chunk") return;
          await appendSlotAcpChunkLog(
            {
              slotMessageLog: ctx.slotMessageLog,
              sessionKey,
              slot: activeSlot,
              session,
              msg: msgForPrompt,
            },
            ev.text,
          );
        },
      });
    await appendSlotReplyLog(
      {
        slotMessageLog: ctx.slotMessageLog,
        sessionKey,
        slot: activeSlot,
        session,
        msg: msgForPrompt,
      },
      lastReply ?? "（无响应内容）",
    );
    if (lastReply) {
      ctx.sessionManager.setSlotLastTurn(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        snap?.activeSlot.slotIndex ?? 1,
        promptContent,
        lastReply,
        ctx.threadScope(msg),
      );
    }
  } catch (err) {
    console.error(
      `[bridge] Error processing message from ${msg.senderId}:`,
      err,
    );
    try {
      const slot = await ctx.sessionManager.getSlot(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        null,
        ctx.threadScope(msg),
      );
      const session = slot.session;
      await appendSlotErrorLog(
        {
          slotMessageLog: ctx.slotMessageLog,
          sessionKey,
          slot,
          session,
          msg,
        },
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      // ignore logging failures while already handling an error
    }
    await ctx.feishuBot
      .sendText(
        msg.chatId,
        `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      )
      .catch(() => {});
  } finally {
    ctx.activePrompts.delete(promptKey);
  }
}
