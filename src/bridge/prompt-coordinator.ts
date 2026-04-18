import type { AcpBackend } from "../acp/runtime-contract.js";
import type { FeishuBot, FeishuMessage } from "../feishu/bot.js";
import type { SessionManager, SessionSlot } from "../session/manager.js";
import type { SlotMessageLogStore } from "./slot-message-log.js";
import type { ConversationService } from "./conversation-service.js";
import { NO_SESSION_HINT } from "./bridge-context.js";
import { resolvePromptContentFromResource } from "./bridge-resource-prompt.js";
import {
  appendSlotAcpChunkLog,
  appendSlotErrorLog,
  appendSlotPromptLog,
  appendSlotReplyLog,
} from "./bridge-slot-logging.js";

export type QueuedPrompt = {
  msg: FeishuMessage;
  content: string;
  hasPostEmbeddedImages: boolean;
  slotIndex: number;
};

type PromptDispatch = {
  msg: FeishuMessage;
  content: string;
  hasPostEmbeddedImages: boolean;
  slotIndex: number;
};

export interface PromptCoordinatorDeps {
  getFeishuBot(): FeishuBot;
  getSessionManager(): SessionManager;
  getSlotMessageLog(): SlotMessageLogStore | null;
  flushPendingSessionNotices(msg: FeishuMessage): Promise<void>;
  threadReplyOpts(msg: FeishuMessage): { replyInThread: true } | undefined;
  threadScope(msg: FeishuMessage): string | undefined;
  conversationForBackend(backend: AcpBackend): ConversationService;
  feishuSessionKey(msg: FeishuMessage): string;
}

export class PromptCoordinator {
  private activePrompts = new Set<string>();
  private queuedPrompts = new Map<string, QueuedPrompt>();

  constructor(private readonly deps: PromptCoordinatorDeps) {}

  getActivePromptCount(): number {
    return this.activePrompts.size;
  }

  getSlotPromptState(
    sessionKey: string,
    slotIndex: number,
  ): { hasActivePrompt: boolean; hasQueuedPrompt: boolean } {
    const promptKey = this.promptKeyForSlot(sessionKey, slotIndex);
    return {
      hasActivePrompt: this.activePrompts.has(promptKey),
      hasQueuedPrompt: this.queuedPrompts.has(promptKey),
    };
  }

  clearQueuedPromptForSlot(sessionKey: string, slotIndex: number): boolean {
    return this.queuedPrompts.delete(this.promptKeyForSlot(sessionKey, slotIndex));
  }

  async handlePromptMessage(
    msg: FeishuMessage,
    content: string,
    hasPostEmbeddedImages: boolean,
  ): Promise<void> {
    const { sessionKey, promptKey, slotIndex } = this.getPromptKey(msg);

    if (this.activePrompts.has(promptKey)) {
      const hadQueuedPrompt = this.queuedPrompts.has(promptKey);
      const queuedPrompt: QueuedPrompt = {
        msg,
        content,
        hasPostEmbeddedImages,
        slotIndex,
      };
      this.queuedPrompts.set(promptKey, queuedPrompt);
      await this.deps.getFeishuBot().sendText(
        msg.chatId,
        hadQueuedPrompt
          ? "⏳ 当前 session 仍在回复中，已用你的最新消息替换之前的排队消息。可发送 `/cancel` 或 `/stop` 撤销。"
          : "⏳ 当前 session 仍在回复中，你的新消息已加入排队。可发送 `/cancel` 或 `/stop` 撤销这条排队消息。",
        msg.messageId,
        this.deps.threadReplyOpts(msg),
      );
      return;
    }

    await this.processPromptQueue(promptKey, sessionKey, {
      msg,
      content,
      hasPostEmbeddedImages,
      slotIndex,
    });
  }

  private promptKeyForSlot(sessionKey: string, slotIndex: number): string {
    return `${sessionKey}:${slotIndex}`;
  }

  private getPromptKey(
    msg: FeishuMessage,
  ): { sessionKey: string; promptKey: string; slotIndex: number } {
    const sessionKey = this.deps.feishuSessionKey(msg);
    const snap = this.deps.getSessionManager().getSessionSnapshot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.deps.threadScope(msg),
    );
    const slotIndex = snap?.activeSlot.slotIndex ?? 1;
    const promptKey = snap ? this.promptKeyForSlot(sessionKey, slotIndex) : sessionKey;
    return { sessionKey, promptKey, slotIndex };
  }

  private async executePrompt(
    dispatch: PromptDispatch,
    sessionKey: string,
  ): Promise<void> {
    const { msg, content, hasPostEmbeddedImages, slotIndex } = dispatch;
    const sessionManager = this.deps.getSessionManager();
    const feishuBot = this.deps.getFeishuBot();
    const slotMessageLog = this.deps.getSlotMessageLog();

    let activeSlot: SessionSlot;
    try {
      activeSlot = await sessionManager.getSlot(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        slotIndex,
        this.deps.threadScope(msg),
      );
    } catch {
      await feishuBot.sendText(
        msg.chatId,
        NO_SESSION_HINT,
        msg.messageId,
        this.deps.threadReplyOpts(msg),
      );
      return;
    }

    const session = activeSlot.session;
    await this.deps.flushPendingSessionNotices(msg);

    const resourcePrompt = await resolvePromptContentFromResource(
      { feishuBot },
      msg,
      session,
      content,
      hasPostEmbeddedImages,
    );
    if (!resourcePrompt.ok) {
      await feishuBot.sendText(
        msg.chatId,
        resourcePrompt.errorText,
        msg.messageId,
        this.deps.threadReplyOpts(msg),
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
        slotMessageLog,
        sessionKey,
        slot: activeSlot,
        session,
        msg: msgForPrompt,
      },
      content,
      promptContent,
    );

    const lastReply = await this.deps
      .conversationForBackend(session.backend)
      .handleUserPrompt(msgForPrompt, session, {
        onAcpEvent: async (ev) => {
          if (ev.type !== "agent_message_chunk") return;
          await appendSlotAcpChunkLog(
            {
              slotMessageLog,
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
        slotMessageLog,
        sessionKey,
        slot: activeSlot,
        session,
        msg: msgForPrompt,
      },
      lastReply ?? "（无响应内容）",
    );
    if (lastReply) {
      sessionManager.setSlotLastTurn(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        slotIndex,
        promptContent,
        lastReply,
        this.deps.threadScope(msg),
      );
    }
  }

  private async processPromptQueue(
    promptKey: string,
    sessionKey: string,
    initialDispatch: PromptDispatch,
  ): Promise<void> {
    let nextDispatch: PromptDispatch | undefined = initialDispatch;

    while (nextDispatch) {
      try {
        this.activePrompts.add(promptKey);
        await this.executePrompt(nextDispatch, sessionKey);
      } catch (err) {
        console.error(
          `[bridge] Error processing message from ${nextDispatch.msg.senderId}:`,
          err,
        );
        try {
          const sessionManager = this.deps.getSessionManager();
          const slotMessageLog = this.deps.getSlotMessageLog();
          const slot = await sessionManager.getSlot(
            nextDispatch.msg.chatId,
            nextDispatch.msg.senderId,
            nextDispatch.msg.chatType,
            null,
            this.deps.threadScope(nextDispatch.msg),
          );
          const session = slot.session;
          await appendSlotErrorLog(
            {
              slotMessageLog,
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
        await this.deps.getFeishuBot()
          .sendText(
            nextDispatch.msg.chatId,
            `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
            nextDispatch.msg.messageId,
            this.deps.threadReplyOpts(nextDispatch.msg),
          )
          .catch(() => {});
      } finally {
        this.activePrompts.delete(promptKey);
      }

      const queued = this.queuedPrompts.get(promptKey);
      if (!queued) {
        nextDispatch = undefined;
        continue;
      }
      this.queuedPrompts.delete(promptKey);
      nextDispatch = {
        msg: queued.msg,
        content: queued.content,
        hasPostEmbeddedImages: queued.hasPostEmbeddedImages,
        slotIndex: queued.slotIndex,
      };
      await this.deps.getFeishuBot().sendText(
        nextDispatch.msg.chatId,
        "▶️ 已开始处理刚才排队的消息。",
        nextDispatch.msg.messageId,
        this.deps.threadReplyOpts(nextDispatch.msg),
      );
    }
  }
}
