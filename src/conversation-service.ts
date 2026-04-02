import type { Config } from "./config.js";
import type { BridgeAcpEvent } from "./acp/types.js";
import type { BridgeAcpRuntime } from "./acp/runtime-contract.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { FeishuCardState } from "./feishu-renderer.js";
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

function formatPromptTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    `⏱️ 本次请求等待官方 ACP 超过 ${seconds} 秒，已主动中止，避免当前 session 一直停留在“上一个请求还在处理中”。\n\n` +
    "请先重试一次；若仍稳定复现，通常说明上游 prompt/工具调用链路卡住了。"
  );
}

function applyPromptTimeoutNotice(
  state: FeishuCardState,
  timeoutMs: number,
): void {
  const notice = formatPromptTimeoutMessage(timeoutMs);
  const main = state.getMainText().trim();
  state.setMainText(main ? `${main}\n\n---\n\n${notice}` : notice);
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
    const promptTimeoutMs = this.config.bridge.promptTimeoutMs;
    const cardMessageId = await this.feishu.sendCard(
      msg.chatId,
      "🤔 思考中...",
      msg.messageId,
      msg.replyInThread ? { replyInThread: true } : undefined,
    );

    const state = new FeishuCardState(
      this.config.bridge.showAcpAvailableCommands,
    );
    let lastFlush = 0;
    /** 串行化 im.message.patch，避免多次 updateCard 并发完成顺序颠倒导致飞书端长期显示旧（较短）内容 */
    let cardPatchChain: Promise<void> = Promise.resolve();

    const flush = async (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastFlush < throttleMs) return;
      lastFlush = now;
      if (!cardMessageId) return;

      cardPatchChain = cardPatchChain.then(async () => {
        try {
          await this.feishu.updateCard(cardMessageId, state.toMarkdown());
        } catch (err) {
          console.warn(
            `[conversation] updateCard failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        }
      });

      if (force) {
        await cardPatchChain;
      }
    };

    const onAcp = (ev: BridgeAcpEvent) => {
      if (ev.sessionId !== session.sessionId) return;
      state.apply(ev);
      void flush(false);
    };

    this.acp.bridgeClient.on("acp", onAcp);

    try {
      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] prompt sessionId=${session.sessionId} len=${msg.content.length}`,
        );
      }

      const promptOutcome = this.acp
        .prompt(session.sessionId, msg.content)
        .then(
          (result) => ({ kind: "result" as const, result }),
          (error) => ({ kind: "error" as const, error }),
        );
      let timeoutHandle: NodeJS.Timeout | undefined;
      const outcome = Number.isFinite(promptTimeoutMs)
        ? await Promise.race([
            promptOutcome,
            new Promise<{ kind: "timeout" }>((resolve) => {
              timeoutHandle = setTimeout(() => {
                resolve({ kind: "timeout" });
              }, promptTimeoutMs);
            }),
          ]).finally(() => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          })
        : await promptOutcome;

      if (outcome.kind === "timeout") {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
          `[conversation] prompt watchdog timeout sessionId=${session.sessionId} elapsedMs=${elapsedMs} timeoutMs=${promptTimeoutMs}`,
        );
        try {
          await this.acp.cancelSession(session.sessionId);
        } catch (err) {
          console.warn(
            `[conversation] cancelSession after prompt timeout failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        }
        applyPromptTimeoutNotice(state, promptTimeoutMs);
        await flush(true);
        return state.toMarkdown();
      }

      if (outcome.kind === "error") {
        throw outcome.error;
      }

      const result = outcome.result;

      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] done sessionId=${session.sessionId} stopReason=${result.stopReason}`,
        );
      }

      const elapsedMs = Date.now() - startedAt;
      if (
        isLikelyTimeoutMisclassifiedAsAuth(
          state.getMainText(),
          elapsedMs,
        )
      ) {
        state.setMainText(
          "⏱️ 本次请求在长时间执行后被中断，更可能是 Cursor CLI 超时（约 120 秒），而不是登录失效。\n\n请先尝试把任务拆小后重试；若短请求也出现同样报错，再执行 `cursor-agent login`。",
        );
        if (this.config.bridgeDebug) {
          console.warn(
            `[conversation] remap auth-like reply to timeout hint sessionId=${session.sessionId} elapsedMs=${elapsedMs}`,
          );
        }
      }

      await flush(true);

      if (cardMessageId && !state.hasContent()) {
        try {
          await this.feishu.updateCard(cardMessageId, "（无响应内容）");
        } catch (err) {
          console.warn(
            `[conversation] updateCard empty-state failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return state.hasContent() ? state.toMarkdown() : undefined;
    } finally {
      this.acp.bridgeClient.off("acp", onAcp);
    }
  }
}
