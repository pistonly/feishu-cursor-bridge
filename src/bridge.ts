import type { Config } from "./config.js";
import {
  CursorACPClient,
  type TextChunkEvent,
} from "./cursor-acp.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { SessionManager } from "./session-manager.js";

export class Bridge {
  private config: Config;
  private acpClient: CursorACPClient;
  private feishuBot: FeishuBot;
  private sessionManager: SessionManager;
  private activePrompts = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config) {
    this.config = config;

    this.acpClient = new CursorACPClient(config);
    this.feishuBot = new FeishuBot({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain,
    });
    this.sessionManager = new SessionManager(this.acpClient, {
      debug: config.bridgeDebug,
    });
  }

  async start(): Promise<void> {
    if (this.config.bridgeDebug) {
      console.log(
        "[bridge] BRIDGE_DEBUG=true — 控制台会输出 ACP sessionId / tool_call；飞书 /status 含详细信息",
      );
    }

    await this.acpClient.start();
    await this.acpClient.initialize();
    await this.acpClient.authenticate();
    console.log("[bridge] Cursor ACP connected and authenticated");

    if (this.config.bridgeDebug) {
      this.acpClient.on("tool_call", (ev) => {
        console.log(
          `[bridge:debug] tool_call sessionId=${ev.sessionId} name=${ev.name}`,
          ev.params,
        );
      });
    }

    this.feishuBot.on("ready", () => {
      console.log("[bridge] Feishu bot connected and ready");
    });

    this.feishuBot.on("message", (msg: FeishuMessage) => {
      this.handleFeishuMessage(msg).catch((err) => {
        console.error("[bridge] Error handling message:", err);
      });
    });

    await this.feishuBot.start();

    this.cleanupInterval = setInterval(() => {
      const cleaned = this.sessionManager.cleanupExpired();
      if (cleaned > 0) {
        console.log(`[bridge] Cleaned up ${cleaned} expired sessions`);
      }
    }, 5 * 60 * 1000);

    console.log("[bridge] Service started successfully");
  }

  private async handleFeishuMessage(msg: FeishuMessage): Promise<void> {
    if (msg.contentType !== "text" && msg.contentType !== "post") {
      return;
    }

    let content = msg.content.trim();

    if (msg.chatType === "group") {
      if (!this.feishuBot.isBotMentioned(msg)) {
        return;
      }
      content = this.feishuBot.stripBotMention(content).trim();
    }

    if (!content) return;

    if (content === "/reset" || content === "/新对话") {
      this.sessionManager.resetSession(msg.chatId, msg.senderId, msg.chatType);
      await this.feishuBot.sendText(
        msg.chatId,
        "✅ 会话已重置，开始新对话。",
        msg.messageId,
      );
      return;
    }

    if (content === "/status" || content === "/状态") {
      const stats = this.sessionManager.getStats();
      let body = `📊 活跃/总会话: ${stats.active}/${stats.total}`;
      if (this.config.bridgeDebug) {
        const snap = this.sessionManager.getSessionSnapshot(
          msg.chatId,
          msg.senderId,
          msg.chatType,
        );
        const idleMin = snap
          ? Math.round(snap.idleExpiresInMs / 60_000)
          : null;
        body += `\n\n[调试 BRIDGE_DEBUG]\n• sessionKey: ${snap?.sessionKey ?? "(尚无，先发一条消息)"}\n• ACP sessionId: ${snap?.session.sessionId ?? "—"}\n• 空闲过期约: ${idleMin !== null ? `${idleMin} 分钟内无消息会建新会话` : "—"}\n• CURSOR_WORK_DIR: ${this.config.cursor.workDir}\n• LOG_LEVEL: ${this.config.logLevel}`;
      }
      await this.feishuBot.sendText(msg.chatId, body, msg.messageId);
      return;
    }

    const sessionKey =
      msg.chatType === "p2p"
        ? `dm:${msg.senderId}`
        : `${msg.chatId}:${msg.senderId}`;

    if (this.activePrompts.has(sessionKey)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "⏳ 上一个请求还在处理中，请稍候...",
        msg.messageId,
      );
      return;
    }

    try {
      this.activePrompts.add(sessionKey);

      const session = await this.sessionManager.getOrCreateSession(
        msg.chatId,
        msg.senderId,
        msg.chatType,
      );

      const cardMessageId = await this.feishuBot.sendCard(
        msg.chatId,
        "🤔 思考中...",
        msg.messageId,
      );

      let fullText = "";
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL_MS = 800;

      const textHandler = (data: TextChunkEvent) => {
        if (data.sessionId !== session.sessionId) return;
        fullText += data.text;

        const now = Date.now();
        if (now - lastUpdateTime > UPDATE_INTERVAL_MS && cardMessageId) {
          lastUpdateTime = now;
          this.feishuBot.updateCard(cardMessageId, fullText).catch(() => {});
        }
      };

      this.acpClient.on("text_chunk", textHandler);

      try {
        if (this.config.bridgeDebug) {
          console.log(
            `[bridge:debug] prompt start sessionId=${session.sessionId} chars=${content.length}`,
          );
        }

        const promptResult = await this.acpClient.prompt(
          session.sessionId,
          content,
        );

        if (this.config.bridgeDebug) {
          console.log(
            `[bridge:debug] prompt done sessionId=${session.sessionId} stopReason=${promptResult.stopReason}`,
          );
        }

        if (cardMessageId && fullText) {
          await this.feishuBot.updateCard(cardMessageId, fullText);
        } else if (cardMessageId && !fullText) {
          await this.feishuBot.updateCard(cardMessageId, "（无响应内容）");
        }
      } finally {
        this.acpClient.off("text_chunk", textHandler);
      }
    } catch (err) {
      console.error(
        `[bridge] Error processing message from ${msg.senderId}:`,
        err,
      );
      await this.feishuBot
        .sendText(
          msg.chatId,
          `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
          msg.messageId,
        )
        .catch(() => {});
    } finally {
      this.activePrompts.delete(sessionKey);
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.feishuBot.stop();
    await this.acpClient.stop();
    console.log("[bridge] Service stopped");
  }
}
