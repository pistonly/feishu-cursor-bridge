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
  /** 与 Bridge 一致，用于群「免 @」判定失败时的调试日志 */
  bridgeDebug?: boolean;
}

/** 机器人身份（来自 bot/v3/info），供调试日志对照；勿用于业务分支逻辑 */
export interface BotIdSnapshot {
  openId?: string;
  userId?: string;
  unionId?: string;
  /** 是否至少解析到任一非空 id；未解析时群聊 @ 机器人恒为无法识别 */
  resolved: boolean;
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

/** 飞书事件里 id 可能为字符串或数字，需与 clawdbot 一样做强类型归一 */
function feishuIdString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normalizeIncomingMentionId(raw: unknown): {
  open_id?: string;
  user_id?: string;
  union_id?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? { open_id: s } : {};
  }
  if (typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const open_id = feishuIdString(o["open_id"]);
  const user_id = feishuIdString(o["user_id"]);
  const union_id = feishuIdString(o["union_id"]);
  const out: { open_id?: string; user_id?: string; union_id?: string } = {};
  if (open_id) out.open_id = open_id;
  if (user_id) out.user_id = user_id;
  if (union_id) out.union_id = union_id;
  return out;
}

function mentionEntryIdStrings(m: {
  id: { open_id?: string; user_id?: string; union_id?: string };
}): string[] {
  return [
    feishuIdString(m.id.open_id),
    feishuIdString(m.id.user_id),
    feishuIdString(m.id.union_id),
  ].filter(Boolean);
}

/** 飞书 chat.get 的 user_count / bot_count 常为字符串 */
function parseFeishuNumericField(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n =
    typeof v === "string"
      ? parseInt(v.trim(), 10)
      : typeof v === "number"
        ? v
        : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function isFeishuBizSuccess(code: unknown): boolean {
  return code === undefined || code === 0 || code === "0";
}

function pickNumericField(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = parseFeishuNumericField(obj[k]);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/** 解析 im/v1/chats/:id 返回体（data 可能扁平或包在 chat 下） */
function resolveChatGetPayload(res: unknown): Record<string, unknown> | undefined {
  if (!res || typeof res !== "object") return undefined;
  const r = res as Record<string, unknown>;
  const d = r["data"];
  if (d && typeof d === "object") {
    const data = d as Record<string, unknown>;
    if (data["chat"] && typeof data["chat"] === "object") {
      return data["chat"] as Record<string, unknown>;
    }
    return data;
  }
  if (
    "user_count" in r ||
    "bot_count" in r ||
    "member_count" in r ||
    "name" in r
  ) {
    return r;
  }
  return undefined;
}

function collectAtIdsFromPostElements(elements: unknown, ids: string[]): void {
  if (!Array.isArray(elements)) return;
  for (const paragraph of elements) {
    if (!Array.isArray(paragraph)) continue;
    for (const el of paragraph) {
      if (!el || typeof el !== "object") continue;
      const tag = (el as { tag?: string }).tag;
      if (tag !== "at") continue;
      const id = feishuIdString(
        (el as { open_id?: unknown }).open_id ??
          (el as { user_id?: unknown }).user_id ??
          (el as { union_id?: unknown }).union_id ??
          (el as { id?: unknown }).id,
      );
      if (id) ids.push(id);
    }
  }
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
  private botUnionId?: string;
  private config: FeishuBotConfig;
  private readonly bridgeDebug: boolean;
  /** 群「1 用户 + 1 机器人」免 @ 判定缓存（chatId -> 结果） */
  private pairGroupCache = new Map<string, { v: boolean; exp: number }>();
  private readonly pairGroupCacheTtlMs = 60_000;

  constructor(config: FeishuBotConfig) {
    super();
    this.config = config;
    this.bridgeDebug = config.bridgeDebug === true;

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
    // SDK 的 domain 仅为 https://open.feishu.cn，路径必须含 open-apis/（与 clawdbot probe 一致），勿写 /bot/v3/info
    try {
      const resp = (await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
      })) as {
        code?: number;
        msg?: string;
        data?: { bot?: { open_id?: string; user_id?: string; union_id?: string } };
        bot?: { open_id?: string; user_id?: string; union_id?: string };
      };
      if (resp?.code !== undefined && resp.code !== 0) {
        console.warn(
          `[feishu-bot] open-apis/bot/v3/info 业务错误 code=${resp.code} msg=${resp.msg ?? ""} — 群聊 @ 将不可用`,
        );
      } else {
        const bot = resp?.data?.bot ?? resp?.bot;
        this.botOpenId = bot?.open_id;
        this.botUserId = bot?.user_id;
        this.botUnionId = bot?.union_id;
        if (!this.botOpenId && !this.botUserId && !this.botUnionId) {
          console.warn(
            "[feishu-bot] bot/v3/info 成功但未解析到 open_id/user_id/union_id，原始响应可能非预期结构",
          );
        }
      }
    } catch (err) {
      console.warn(
        "[feishu-bot] GET open-apis/bot/v3/info failed — 群聊 @ 检测将不可用:",
        err instanceof Error ? err.message : err,
      );
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
    const botUnion = this.botUnionId?.trim();
    if (!botOpen && !botUser && !botUnion) return false;

    const matchesBotId = (id: string): boolean =>
      id === botOpen || id === botUser || (!!botUnion && id === botUnion);

    const mentionHit =
      msg.mentions?.some((m) => {
        const ids = mentionEntryIdStrings(m);
        return ids.some(matchesBotId);
      }) ?? false;

    if (mentionHit) return true;

    const inline = msg.inlineMentionIds ?? [];
    return inline.some((id) => matchesBotId(id.trim()));
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
    // 文本消息里的 <at user_id="ou_xxx">…</at>（user_id 实为 open_id）
    result = result.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "");
    result = result.replace(/<at\b[^>]*\/>/gi, "");
    return result.replace(/\s+/g, " ").trim();
  }

  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  /** 与 isBotMentioned 使用同一套 id 提取逻辑，用于调试对照 */
  private collectMentionIdStrings(msg: FeishuMessage): string[] {
    const set = new Set<string>();
    for (const m of msg.mentions ?? []) {
      for (const id of mentionEntryIdStrings(m)) {
        if (id) set.add(id);
      }
    }
    for (const raw of msg.inlineMentionIds ?? []) {
      const id = raw.trim();
      if (id) set.add(id);
    }
    return [...set];
  }

  getBotIdSnapshot(): BotIdSnapshot {
    const openId = this.botOpenId?.trim() || undefined;
    const userId = this.botUserId?.trim() || undefined;
    const unionId = this.botUnionId?.trim() || undefined;
    return {
      openId,
      userId,
      unionId,
      resolved: !!(openId || userId || unionId),
    };
  }

  /**
   * 群消息因「未 @ 且非 1 用户+1 机器人」被忽略时，打一条结构化调试信息（需 BRIDGE_DEBUG）。
   */
  getGroupMentionIgnoredDebug(msg: FeishuMessage): {
    messageId: string;
    chatId: string;
    threadId?: string;
    contentType: string;
    mentionCount: number;
    messageMentionIds: string[];
    inlineMentionIds?: string[];
    bot: BotIdSnapshot;
    hint: string;
  } {
    const bot = this.getBotIdSnapshot();
    const messageMentionIds = this.collectMentionIdStrings(msg);
    const hint = this.hintForIgnoredGroupMention(bot, messageMentionIds);
    return {
      messageId: msg.messageId,
      chatId: msg.chatId,
      threadId: msg.threadId,
      contentType: msg.contentType,
      mentionCount: msg.mentions?.length ?? 0,
      messageMentionIds,
      inlineMentionIds: msg.inlineMentionIds,
      bot,
      hint,
    };
  }

  private hintForIgnoredGroupMention(
    bot: BotIdSnapshot,
    messageMentionIds: string[],
  ): string {
    if (!bot.resolved) {
      return "bot/v3/info 未解析到机器人 open_id/user_id/union_id，群 @ 判定恒为无效";
    }
    if (messageMentionIds.length === 0) {
      return "消息中无结构化 @ id（未 @ 机器人、或仅客户端展示/非标准 mentions）";
    }
    const botSet = new Set(
      [bot.openId, bot.userId, bot.unionId].filter(
        (x): x is string => !!x,
      ),
    );
    const anyMatch = messageMentionIds.some((id) => botSet.has(id));
    if (anyMatch) {
      return "消息中的 id 与机器人一致但 isBotMentioned 为 false，请检查事件/mentions 解析是否异常";
    }
    return "消息中的 @ id 与当前机器人 open/user/union 均不一致";
  }

  /**
   * 群聊中仅有一名「用户」且仅有一名「机器人」时，与私聊类似可不 @。
   * 优先用 chat.get 的 user_count/bot_count；若缺失则用 member_count 与成员列表（不含机器人）交叉判断。
   */
  async isPairUserBotGroup(chatId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.pairGroupCache.get(chatId);
    if (cached && cached.exp > now) return cached.v;
    if (!chatId.trim()) {
      this.pairGroupCache.set(chatId, { v: false, exp: now + 30_000 });
      return false;
    }

    const cacheSet = (v: boolean, ttl: number) => {
      this.pairGroupCache.set(chatId, { v, exp: now + ttl });
    };

    try {
      const resUnknown: unknown = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const res = resUnknown as Record<string, unknown>;
      if (!isFeishuBizSuccess(res["code"])) {
        if (this.bridgeDebug) {
          console.log("[feishu-bot:debug] pair 群: chat.get 失败", {
            chatId,
            code: res["code"],
            msg: res["msg"],
          });
        }
        cacheSet(false, 30_000);
        return false;
      }

      const inner = resolveChatGetPayload(resUnknown);
      if (!inner) {
        if (this.bridgeDebug) {
          console.log("[feishu-bot:debug] pair 群: 无法解析 chat.get 结构", {
            chatId,
            keys: res && typeof res === "object" ? Object.keys(res) : [],
          });
        }
        cacheSet(false, 30_000);
        return false;
      }

      const u = pickNumericField(inner, ["user_count", "userCount"]);
      const b = pickNumericField(inner, ["bot_count", "botCount"]);
      const memberCap = pickNumericField(inner, [
        "member_count",
        "member_total",
        "memberCount",
      ]);

      if (u === 1 && b === 1) {
        cacheSet(true, this.pairGroupCacheTtlMs);
        return true;
      }

      const humans = await this.countGroupHumanMembers(chatId);
      if (humans < 0) {
        if (this.bridgeDebug) {
          console.log(
            "[feishu-bot:debug] pair 群: chatMembers.get 失败（需 im 群成员权限）",
            { chatId },
          );
        }
        cacheSet(false, 30_000);
        return false;
      }

      const sumUb =
        u !== undefined && b !== undefined ? u + b : undefined;
      const totalHint =
        memberCap ?? (sumUb !== undefined && sumUb >= 0 ? sumUb : undefined);

      const pairFallback = humans === 1 && totalHint === 2;

      if (this.bridgeDebug) {
        console.log("[feishu-bot:debug] pair 群判定", {
          chatId,
          user_count: u,
          bot_count: b,
          member_count_or_total: memberCap,
          humans_ex_bots: humans,
          totalHint,
          pairFallback,
        });
      }

      const v = pairFallback;
      cacheSet(v, this.pairGroupCacheTtlMs);
      return v;
    } catch (e) {
      if (this.bridgeDebug) {
        console.log("[feishu-bot:debug] pair 群异常", chatId, e);
      }
      cacheSet(false, 30_000);
      return false;
    }
  }

  /** chatMembers 列表不含机器人，分页累加为「真人」数量 */
  private async countGroupHumanMembers(chatId: string): Promise<number> {
    let total = 0;
    let pageToken: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const resUnknown: unknown = await this.client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const res = resUnknown as {
        code?: unknown;
        data?: {
          items?: unknown[];
          has_more?: boolean;
          page_token?: string;
        };
      };
      if (!isFeishuBizSuccess(res.code)) return -1;
      const items = res.data?.items ?? [];
      total += items.length;
      if (total > 1) return total;
      if (!res.data?.has_more) break;
      pageToken = res.data?.page_token;
      if (!pageToken) break;
    }
    return total;
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

    const fromPost =
      messageType === "post" ? this.extractPostAtIds(rawContent) : [];
    const fromText =
      messageType === "text" ? this.extractTextAtIds(rawContent) : [];
    const inlineMentionIds = this.mergeAtIdLists(fromPost, fromText);

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
      mentions: message.mentions?.map((m: any) => {
        const idNorm = normalizeIncomingMentionId(m?.id);
        return {
          key: m.key,
          id: idNorm,
          name: m.name,
        };
      }),
      rootId: message.root_id || undefined,
      parentId: message.parent_id || undefined,
      threadId,
      replyInThread: replyInThread ? true : undefined,
      inlineMentionIds: inlineMentionIds.length ? inlineMentionIds : undefined,
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
        collectAtIdsFromPostElements(content, ids);
      }
      // clawdbot 测试中扁平结构：{ title, content: [[{ tag: "at", ... }]] }
      if (ids.length === 0 && Array.isArray(parsed.content)) {
        collectAtIdsFromPostElements(parsed.content, ids);
      }
      return ids;
    } catch {
      return [];
    }
  }

  /** 文本消息里 @ 常写在 JSON.text 的 `<at user_id="ou_xxx">`（属性名虽为 user_id，值为 open_id） */
  private extractTextAtIds(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as { text?: string };
      const text = typeof parsed.text === "string" ? parsed.text : "";
      const ids = new Set<string>();
      const reNamed =
        /<at[^>]+?(?:user_id|open_id|union_id)\s*=\s*["']([^"']+)["'][^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = reNamed.exec(text)) !== null) {
        const id = m[1]?.trim();
        if (id && id !== "all") ids.add(id);
      }
      // clawdbot mention.ts: formatMentionForCard 使用 <at id=openId></at>（可无引号）
      const reBareId = /<at\b[^>]*?\bid\s*=\s*["']?([^"'>\s/]+)["']?[^>]*>/gi;
      while ((m = reBareId.exec(text)) !== null) {
        const id = m[1]?.trim();
        if (id && id !== "all") ids.add(id);
      }
      return [...ids];
    } catch {
      return [];
    }
  }

  private mergeAtIdLists(a: string[], b: string[]): string[] {
    const s = new Set<string>();
    for (const x of a) {
      const t = x.trim();
      if (t) s.add(t);
    }
    for (const x of b) {
      const t = x.trim();
      if (t) s.add(t);
    }
    return [...s];
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
