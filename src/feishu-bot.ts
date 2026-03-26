import { EventEmitter } from "node:events";
import * as Lark from "@larksuiteoapi/node-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderType: string;
  content: string;
  contentType: string;
  mentions?: Array<{
    key: string;
    id: { open_id?: string; user_id?: string; union_id?: string };
    name: string;
  }>;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  /**
   * 国内版话题群为 `topic_group`；回复此类或话题线程内消息时，im.message.reply 需 `reply_in_thread: true`。
   */
  replyInThread?: boolean;
  /** 富文本 post 里 @ 的用户 id（部分场景下 message.mentions 不完整） */
  inlineMentionIds?: string[];
}

export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  domain?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEXT_CHUNK_LIMIT = 4000;

/** 飞书群聊、话题群等均需按「群」处理 @ 与会话维度 */
function isGroupLikeChatType(raw: string | undefined): boolean {
  return raw === "group" || raw === "topic_group";
}

export type FeishuSendReplyOptions = {
  replyInThread?: boolean;
};

function resolveDomain(
  domain: string | undefined,
): typeof Lark.Domain.Feishu | typeof Lark.Domain.Lark | string {
  if (domain === "lark") return Lark.Domain.Lark;
  if (domain === "feishu" || !domain) return Lark.Domain.Feishu;
  return domain.replace(/\/+$/, "");
}

function splitTextChunks(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitIdx = remaining.lastIndexOf("\n", limit);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", limit);
    if (splitIdx <= 0) splitIdx = limit;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// FeishuBot
// ---------------------------------------------------------------------------

export interface FeishuBotEvents {
  message: [msg: FeishuMessage];
  ready: [];
  error: [err: Error];
}

export class FeishuBot extends EventEmitter {
  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher;
  private botOpenId?: string;
  private botUserId?: string;
  private config: FeishuBotConfig;

  constructor(config: FeishuBotConfig) {
    super();
    this.config = config;

    const domain = resolveDomain(config.domain);

    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });

    this.eventDispatcher = new Lark.EventDispatcher({});

    this.eventDispatcher.register({
      "im.message.receive_v1": (data: any) => {
        try {
          this.handleMessageEvent(data);
        } catch (err) {
          this.emit(
            "error",
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      },
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const domain = resolveDomain(this.config.domain);

    // 必须先解析 bot open_id：否则 WS 抢先收到群消息时 isBotMentioned 会为 false（话题群 @ 也不响）
    try {
      const resp = (await (this.client as any).request({
        method: "GET",
        url: "/bot/v3/info",
      })) as { bot?: { open_id?: string; user_id?: string } };
      this.botOpenId = resp?.bot?.open_id;
      this.botUserId = resp?.bot?.user_id;
    } catch {
      // Non-critical — isBotMentioned will degrade gracefully
    }

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

    this.emit("ready");
  }

  async stop(): Promise<void> {
    // The SDK WSClient doesn't expose a close method in all versions —
    // null out the reference so GC can reclaim it.
    this.wsClient = null;
  }

  // -----------------------------------------------------------------------
  // Send helpers
  // -----------------------------------------------------------------------

  async sendText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    opts?: FeishuSendReplyOptions,
  ): Promise<string> {
    const chunks = splitTextChunks(text);
    let lastMessageId = "";
    const replyInThread = opts?.replyInThread === true;

    for (const chunk of chunks) {
      const content = JSON.stringify({ text: chunk });

      if (replyToMessageId && lastMessageId === "") {
        const res = await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: "text",
            content,
            ...(replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        lastMessageId = res.data?.message_id ?? "";
      } else {
        const res = await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content,
          },
        });
        lastMessageId = res.data?.message_id ?? "";
      }
    }

    return lastMessageId;
  }

  async sendPost(
    chatId: string,
    title: string,
    content: string,
    replyToMessageId?: string,
    opts?: FeishuSendReplyOptions,
  ): Promise<string> {
    const postContent = this.buildPostContent(title, content);
    const payload = JSON.stringify(postContent);
    const replyInThread = opts?.replyInThread === true;

    if (replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: "post",
          content: payload,
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id ?? "";
    }

    const res = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: payload,
      },
    });
    return res.data?.message_id ?? "";
  }

  async sendCard(
    chatId: string,
    content: string,
    replyToMessageId?: string,
    opts?: FeishuSendReplyOptions,
  ): Promise<string> {
    const card = {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content },
        },
      ],
    };
    const payload = JSON.stringify(card);
    const replyInThread = opts?.replyInThread === true;

    if (replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: "interactive",
          content: payload,
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id ?? "";
    }

    const res = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: payload,
      },
    });
    return res.data?.message_id ?? "";
  }

  async updateCard(messageId: string, content: string): Promise<void> {
    const card = {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content },
        },
      ],
    };

    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    } as any);
  }

  // -----------------------------------------------------------------------
  // Mention helpers
  // -----------------------------------------------------------------------

  isBotMentioned(msg: FeishuMessage): boolean {
    const botOpen = this.botOpenId?.trim();
    const botUser = this.botUserId?.trim();
    if (!botOpen && !botUser) return false;

    const mentionHit =
      msg.mentions?.some((m) => {
        const ids = [
          m.id.open_id,
          m.id.user_id,
          m.id.union_id,
        ]
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean);
        return ids.some((id) => id === botOpen || id === botUser);
      }) ?? false;

    if (mentionHit) return true;

    const inline = msg.inlineMentionIds ?? [];
    return inline.some((id) => {
      const t = id.trim();
      return t === botOpen || t === botUser;
    });
  }

  stripBotMention(
    content: string,
    mentions?: FeishuMessage["mentions"],
  ): string {
    let result = content;
    if (mentions && mentions.length > 0) {
      for (const m of mentions) {
        if (m.name) {
          result = result.replace(new RegExp(`@${escapeRegExp(m.name)}\\s*`, "g"), "");
        }
        if (m.key) {
          result = result.replace(
            new RegExp(escapeRegExp(m.key), "g"),
            "",
          );
        }
      }
    }
    // 文本里常见占位：@_user_1
    result = result.replace(/@_user_\d+/g, "");
    return result.replace(/\s+/g, " ").trim();
  }

  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleMessageEvent(data: any): void {
    const event = data?.event ?? data;
    const sender = event?.sender;
    const message = event?.message;
    if (!message || !sender) return;

    const rawContent: string = message.content ?? "";
    const messageType: string = message.message_type ?? "text";
    const rawChatType: string | undefined = message.chat_type;
    const threadId: string | undefined =
      typeof message.thread_id === "string" && message.thread_id.length > 0
        ? message.thread_id
        : undefined;

    const inlineMentionIds =
      messageType === "post" ? this.extractPostAtIds(rawContent) : undefined;

    const groupMessageType: string | undefined = message.group_message_type;
    const inTopicThread =
      threadId !== undefined || groupMessageType === "thread";

    const replyInThread = rawChatType === "topic_group" || inTopicThread;

    const feishuMsg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: isGroupLikeChatType(rawChatType) ? "group" : "p2p",
      senderId:
        sender.sender_id?.open_id ??
        sender.sender_id?.user_id ??
        sender.sender_id?.union_id ??
        "",
      senderType: sender.sender_type ?? "",
      content: this.parseContent(rawContent, messageType),
      contentType: messageType,
      mentions: message.mentions?.map((m: any) => ({
        key: m.key,
        id: {
          open_id: m.id?.open_id,
          user_id: m.id?.user_id,
          union_id: m.id?.union_id,
        },
        name: m.name,
      })),
      rootId: message.root_id || undefined,
      parentId: message.parent_id || undefined,
      threadId,
      replyInThread: replyInThread ? true : undefined,
      inlineMentionIds,
    };

    this.emit("message", feishuMsg);
  }

  private extractPostAtIds(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ids: string[] = [];
      for (const block of Object.values(parsed)) {
        if (!block || typeof block !== "object") continue;
        const content = (block as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const paragraph of content) {
          if (!Array.isArray(paragraph)) continue;
          for (const el of paragraph) {
            if (!el || typeof el !== "object") continue;
            const tag = (el as { tag?: string }).tag;
            if (tag !== "at") continue;
            const id = String(
              (el as { open_id?: string; user_id?: string; union_id?: string })
                .open_id ??
                (el as { user_id?: string }).user_id ??
                (el as { union_id?: string }).union_id ??
                "",
            ).trim();
            if (id) ids.push(id);
          }
        }
      }
      return ids;
    } catch {
      return [];
    }
  }

  private parseContent(rawContent: string, messageType: string): string {
    try {
      switch (messageType) {
        case "text": {
          const parsed = JSON.parse(rawContent);
          return typeof parsed.text === "string" ? parsed.text : rawContent;
        }
        case "post": {
          return this.extractPostText(rawContent);
        }
        case "image":
          return "[image]";
        case "file":
          return "[file]";
        case "audio":
          return "[audio]";
        case "video":
          return "[video]";
        case "sticker":
          return "[sticker]";
        case "share_chat":
          return "[shared chat]";
        case "share_user":
          return "[shared user]";
        case "merge_forward":
          return "[forwarded messages]";
        default:
          return rawContent;
      }
    } catch {
      return rawContent;
    }
  }

  private extractPostText(rawContent: string): string {
    try {
      const parsed = JSON.parse(rawContent);
      const lang = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp ?? Object.values(parsed)[0];
      if (!lang || !Array.isArray(lang.content)) return rawContent;

      const parts: string[] = [];
      if (lang.title) parts.push(lang.title);

      for (const paragraph of lang.content) {
        if (!Array.isArray(paragraph)) continue;
        const lineTexts: string[] = [];
        for (const element of paragraph) {
          if (element.tag === "text" && element.text) {
            lineTexts.push(element.text);
          } else if (element.tag === "a" && element.text) {
            lineTexts.push(element.text);
          } else if (element.tag === "at" && element.user_name) {
            lineTexts.push(`@${element.user_name}`);
          }
        }
        parts.push(lineTexts.join(""));
      }

      return parts.join("\n");
    } catch {
      return rawContent;
    }
  }

  private buildPostContent(
    title: string,
    content: string,
  ): Record<string, unknown> {
    const lines = content.split("\n");
    const paragraphs = lines.map((line) => [{ tag: "text" as const, text: line }]);
    return {
      zh_cn: {
        title,
        content: paragraphs,
      },
    };
  }
}
