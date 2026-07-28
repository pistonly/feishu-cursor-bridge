import type { GroupSessionScope } from "../config/index.js";

/**
 * 构造飞书会话的 session key。
 *
 * - p2p 消息：`dm:{userId}`
 * - 群聊 shared 模式：`{chatId}` 或 `{chatId}:t:{threadId}`
 * - 群聊 per-user 模式：`{chatId}:{userId}` 或 `{chatId}:t:{threadId}:{userId}`
 *
 * Bridge.feishuSessionKey 和 SessionManager.makeKey 共享此实现，
 * 避免两处独立维护导致不一致。
 */
export function buildSessionKey(
  chatId: string,
  userId: string,
  chatType: "p2p" | "group",
  groupSessionScope: GroupSessionScope,
  threadId?: string,
): string {
  if (chatType === "p2p") return `dm:${userId}`;
  const t = threadId?.trim();
  if (groupSessionScope === "shared") {
    if (t) return `${chatId}:t:${t}`;
    return chatId;
  }
  if (t) return `${chatId}:t:${t}:${userId}`;
  return `${chatId}:${userId}`;
}
