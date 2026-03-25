import type { Config } from "./config.js";
import type { BridgeAcpEvent } from "./acp/types.js";
import type { AcpRuntime } from "./acp/runtime.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { FeishuCardState } from "./feishu-renderer.js";
import type { UserSession } from "./session-manager.js";

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

      await flush(true);

      if (cardMessageId && !state.hasContent()) {
        await this.feishu.updateCard(cardMessageId, "（无响应内容）");
      }
    } finally {
      this.acp.bridgeClient.off("acp", onAcp);
    }
  }
}
