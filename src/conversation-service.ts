import type { Config } from "./config.js";
import type { BridgeAcpEvent } from "./acp/types.js";
import type { AcpRuntime } from "./acp/runtime.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { FeishuCardState } from "./feishu-renderer.js";
import type { UserSession } from "./session-manager.js";

const AUTH_HINT_PATTERNS = [
  "unable to process your request because cursor-agent cli is not authenticated",
  "cursor-agent cli is not authenticated",
  "not authenticated",
  "cursor-agent login",
];
const MISLEADING_AUTH_TIMEOUT_MS = 110_000;

function isLikelyTimeoutMisclassifiedAsAuth(
  text: string,
  elapsedMs: number,
  hadThoughtOutput: boolean,
): boolean {
  const normalized = text.toLowerCase();
  const hasAuthHint = AUTH_HINT_PATTERNS.some((p) => normalized.includes(p));
  if (!hasAuthHint) return false;
  return elapsedMs >= MISLEADING_AUTH_TIMEOUT_MS || hadThoughtOutput;
}

export class ConversationService {
  constructor(
    private readonly config: Config,
    private readonly acp: AcpRuntime,
    private readonly feishu: FeishuBot,
  ) {}

  async handleUserPrompt(
    msg: FeishuMessage,
    session: UserSession,
  ): Promise<void> {
    const startedAt = Date.now();
    const throttleMs = this.config.bridge.cardUpdateThrottleMs;
    const cardMessageId = await this.feishu.sendCard(
      msg.chatId,
      "🤔 思考中...",
      msg.messageId,
    );

    const state = new FeishuCardState();
    let lastFlush = 0;

    const flush = async (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastFlush < throttleMs) return;
      lastFlush = now;
      if (cardMessageId) {
        await this.feishu.updateCard(cardMessageId, state.toMarkdown());
      }
    };

    const onAcp = (ev: BridgeAcpEvent) => {
      if (ev.sessionId !== session.sessionId) return;
      state.apply(ev);
      flush(false).catch(() => {});
    };

    this.acp.bridgeClient.on("acp", onAcp);

    try {
      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] prompt sessionId=${session.sessionId} len=${msg.content.length}`,
        );
      }

      const result = await this.acp.prompt(session.sessionId, msg.content);

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
          state.hasThoughtText(),
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
        await this.feishu.updateCard(cardMessageId, "（无响应内容）");
      }
    } finally {
      this.acp.bridgeClient.off("acp", onAcp);
    }
  }
}
