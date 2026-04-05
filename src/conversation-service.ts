import type { Config } from "./config.js";
import type { BridgeAcpEvent } from "./acp/types.js";
import type { BridgeAcpRuntime } from "./acp/runtime-contract.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { FeishuCardState, isRenderableEvent } from "./feishu-renderer.js";
import type { UserSession } from "./session-manager.js";

const AUTH_HINT_PATTERNS = [
  "unable to process your request because cursor-agent cli is not authenticated",
  "cursor-agent cli is not authenticated",
  "not authenticated",
  "cursor-agent login",
];
const AUTH_LIKE_REPLY_PREFIXES = [
  "unable to process your request because cursor-agent cli is not authenticated.",
  "unable to process your request because cursor-agent cli is not authenticated.\n\n",
];
const MISLEADING_AUTH_TIMEOUT_MS = 110_000;

const AUTH_TIMEOUT_HINT_BODY =
  "⏱️ 本次请求在长时间执行后被中断，更可能是 Cursor CLI 超时（约 120 秒），而不是登录失效。\n\n请先尝试把任务拆小后重试；若短请求也出现同样报错，再执行 `cursor-agent login`。";

const AUTH_TIMEOUT_USER_MARKDOWN = AUTH_TIMEOUT_HINT_BODY;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\r/g, "").trim();
}

function isStandaloneAuthLikeReply(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return AUTH_LIKE_REPLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isLikelyTimeoutMisclassifiedAsAuth(
  text: string,
  elapsedMs: number,
): boolean {
  const normalized = normalizeText(text);
  const hasAuthHint = AUTH_HINT_PATTERNS.some((p) => normalized.includes(p));
  if (!hasAuthHint) return false;
  if (!isStandaloneAuthLikeReply(normalized)) return false;
  return elapsedMs >= MISLEADING_AUTH_TIMEOUT_MS;
}

export class ConversationService {
  constructor(
    private readonly config: Config,
    private readonly acp: BridgeAcpRuntime,
    private readonly feishu: FeishuBot,
  ) {}

  async handleUserPrompt(
    msg: FeishuMessage,
    session: UserSession,
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    const throttleMs = this.config.bridge.cardUpdateThrottleMs;
    const cardSplitMarkdownThreshold =
      this.config.bridge.cardSplitMarkdownThreshold;
    const cardSplitToolThreshold = this.config.bridge.cardSplitToolThreshold;
    const replyOpts = msg.replyInThread ? { replyInThread: true } : undefined;
    const showCommands = this.config.bridge.showAcpAvailableCommands;

    const loadingCardId = await this.feishu.sendCard(
      msg.chatId,
      "🤔 处理中...",
      msg.messageId,
      replyOpts,
    );

    const state = new FeishuCardState(showCommands);
    const cardMessageIds: string[] = [loadingCardId];
    let lastRenderedChunks: string[] = [];
    let aggregatedMain = "";

    let lastFlush = 0;
    let cardPatchChain: Promise<void> = Promise.resolve();

    const awaitPatchChain = async (): Promise<void> => {
      await cardPatchChain;
    };

    const syncRenderedCards = (force: boolean, label: string): void => {
      const now = Date.now();
      if (!force && now - lastFlush < throttleMs) return;
      if (!state.hasContent()) return;

      const chunks = state.toCardMarkdownChunks({
        maxMarkdownLength: cardSplitMarkdownThreshold,
        maxTools: cardSplitToolThreshold,
      });
      if (
        !force &&
        chunks.length === lastRenderedChunks.length &&
        chunks.every((chunk, index) => chunk === lastRenderedChunks[index])
      ) {
        return;
      }
      lastFlush = now;
      lastRenderedChunks = chunks;

      cardPatchChain = cardPatchChain.then(async () => {
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
          const messageId = cardMessageIds[i];
          if (messageId) {
            try {
              await this.feishu.updateCard(messageId, chunk);
            } catch (err) {
              console.warn(
                `${label} sessionId=${session.sessionId}`,
                err instanceof Error ? err.message : err,
              );
            }
            continue;
          }

          try {
            const newId = await this.feishu.sendCard(
              msg.chatId,
              chunk,
              msg.messageId,
              replyOpts,
            );
            cardMessageIds.push(newId);
          } catch (err) {
            console.warn(
              `${label} sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        for (let i = chunks.length; i < cardMessageIds.length; i += 1) {
          const messageId = cardMessageIds[i];
          if (!messageId) continue;
          try {
            await this.feishu.updateCard(
              messageId,
              "_（后续内容已合并到前一张卡片）_",
            );
          } catch (err) {
            console.warn(
              `${label} sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      });
    };

    const processAcpEvent = async (ev: BridgeAcpEvent): Promise<void> => {
      if (ev.type === "agent_message_chunk") {
        aggregatedMain += ev.text;
      }

      if (!isRenderableEvent(ev, showCommands)) return;

      state.apply(ev);
      syncRenderedCards(false, "[conversation] syncRenderedCards failed");
    };

    let acpQueue: Promise<void> = Promise.resolve();

    const onAcp = (ev: BridgeAcpEvent): void => {
      if (ev.sessionId !== session.sessionId) return;
      acpQueue = acpQueue
        .then(() => processAcpEvent(ev))
        .catch((err) => {
          console.error(
            `[conversation] processAcpEvent failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        });
    };

    this.acp.bridgeClient.on("acp", onAcp);

    try {
      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] prompt sessionId=${session.sessionId} len=${msg.content.length}`,
        );
      }

      const result = await this.acp.prompt(session.sessionId, msg.content);

      await acpQueue;

      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] done sessionId=${session.sessionId} stopReason=${result.stopReason}`,
        );
      }

      syncRenderedCards(true, "[conversation] syncRenderedCards failed");
      await awaitPatchChain();

      const elapsedMs = Date.now() - startedAt;
      if (
        isLikelyTimeoutMisclassifiedAsAuth(aggregatedMain, elapsedMs)
      ) {
        state.setMainText(AUTH_TIMEOUT_HINT_BODY);
        if (state.hasMainText()) {
          syncRenderedCards(true, "[conversation] auth-remap syncRenderedCards failed");
          await awaitPatchChain();
        } else {
          try {
            await this.feishu.updateCard(loadingCardId, AUTH_TIMEOUT_USER_MARKDOWN);
          } catch (err) {
            console.warn(
              `[conversation] auth-remap updateCard (loading) failed sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        if (this.config.bridgeDebug) {
          console.warn(
            `[conversation] remap auth-like reply to timeout hint sessionId=${session.sessionId} elapsedMs=${elapsedMs}`,
          );
        }
      }

      if (!state.hasContent()) {
        try {
          await this.feishu.updateCard(loadingCardId, "（无响应内容）");
        } catch (err) {
          console.warn(
            `[conversation] updateCard empty-state failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        }
        return undefined;
      }

      return state.toMarkdown();
    } finally {
      this.acp.bridgeClient.off("acp", onAcp);
    }
  }
}
