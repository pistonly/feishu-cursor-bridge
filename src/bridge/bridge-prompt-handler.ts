import type { FeishuMessage } from "../feishu/bot.js";
import type { SessionSlot } from "../session/manager.js";
import { NO_SESSION_HINT } from "./bridge-context.js";
import type {
  BridgeMessageHandlerDeps,
  QueuedPrompt,
} from "./bridge-message-handler-types.js";
import { resolvePromptContentFromResource } from "./bridge-resource-prompt.js";
import {
  appendSlotAcpChunkLog,
  appendSlotErrorLog,
  appendSlotPromptLog,
  appendSlotReplyLog,
} from "./bridge-slot-logging.js";

type PromptDispatch = {
  msg: FeishuMessage;
  content: string;
  hasPostEmbeddedImages: boolean;
  slotIndex: number;
};

function getPromptKey(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
): { sessionKey: string; promptKey: string; slotIndex: number } {
  const sessionKey = ctx.feishuSessionKey(msg);
  const snap = ctx.sessionManager.getSessionSnapshot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  const slotIndex = snap?.activeSlot.slotIndex ?? 1;
  const promptKey = snap ? `${sessionKey}:${slotIndex}` : sessionKey;
  return { sessionKey, promptKey, slotIndex };
}

async function executePrompt(
  ctx: BridgeMessageHandlerDeps,
  dispatch: PromptDispatch,
  sessionKey: string,
): Promise<void> {
  const { msg, content, hasPostEmbeddedImages, slotIndex } = dispatch;

  let activeSlot: SessionSlot;
  try {
    activeSlot = await ctx.sessionManager.getSlot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      slotIndex,
      ctx.threadScope(msg),
    );
  } catch {
    await ctx.feishuBot.sendText(
      msg.chatId,
      NO_SESSION_HINT,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const session = activeSlot.session;
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
      slotIndex,
      promptContent,
      lastReply,
      ctx.threadScope(msg),
    );
  }
}

async function processPromptQueue(
  ctx: BridgeMessageHandlerDeps,
  promptKey: string,
  sessionKey: string,
  initialDispatch: PromptDispatch,
): Promise<void> {
  let nextDispatch: PromptDispatch | undefined = initialDispatch;

  while (nextDispatch) {
    try {
      ctx.activePrompts.add(promptKey);
      await executePrompt(ctx, nextDispatch, sessionKey);
    } catch (err) {
      console.error(
        `[bridge] Error processing message from ${nextDispatch.msg.senderId}:`,
        err,
      );
      try {
        const slot = await ctx.sessionManager.getSlot(
          nextDispatch.msg.chatId,
          nextDispatch.msg.senderId,
          nextDispatch.msg.chatType,
          null,
          ctx.threadScope(nextDispatch.msg),
        );
        const session = slot.session;
        await appendSlotErrorLog(
          {
            slotMessageLog: ctx.slotMessageLog,
            sessionKey,
            slot,
            session,
            msg: nextDispatch.msg,
          },
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // ignore logging failures while already handling an error
      }
      await ctx.feishuBot
        .sendText(
          nextDispatch.msg.chatId,
          `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
          nextDispatch.msg.messageId,
          ctx.threadReplyOpts(nextDispatch.msg),
        )
        .catch(() => {});
    } finally {
      ctx.activePrompts.delete(promptKey);
    }

    const queued = ctx.queuedPrompts.get(promptKey);
    if (!queued) {
      nextDispatch = undefined;
      continue;
    }
    ctx.queuedPrompts.delete(promptKey);
    nextDispatch = {
      msg: queued.msg,
      content: queued.content,
      hasPostEmbeddedImages: queued.hasPostEmbeddedImages,
      slotIndex: queued.slotIndex,
    };
    await ctx.feishuBot.sendText(
      nextDispatch.msg.chatId,
      "▶️ 已开始处理刚才排队的消息。",
      nextDispatch.msg.messageId,
      ctx.threadReplyOpts(nextDispatch.msg),
    );
  }
}

export async function handlePromptMessage(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
  hasPostEmbeddedImages: boolean,
): Promise<void> {
  const { sessionKey, promptKey, slotIndex } = getPromptKey(ctx, msg);

  if (ctx.activePrompts.has(promptKey)) {
    const hadQueuedPrompt = ctx.queuedPrompts.has(promptKey);
    const queuedPrompt: QueuedPrompt = {
      msg,
      content,
      hasPostEmbeddedImages,
      slotIndex,
    };
    ctx.queuedPrompts.set(promptKey, queuedPrompt);
    await ctx.feishuBot.sendText(
      msg.chatId,
      hadQueuedPrompt
        ? "⏳ 当前 session 仍在回复中，已用你的最新消息替换之前的排队消息。可发送 `/cancel` 或 `/stop` 撤销。"
        : "⏳ 当前 session 仍在回复中，你的新消息已加入排队。可发送 `/cancel` 或 `/stop` 撤销这条排队消息。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  await processPromptQueue(ctx, promptKey, sessionKey, {
    msg,
    content,
    hasPostEmbeddedImages,
    slotIndex,
  });
}
