import type { CursorACPClient, ACPSessionInfo } from "./cursor-acp.js";

export interface UserSession {
  sessionId: string;
  chatId: string;
  userId: string;
  createdAt: number;
  lastActiveAt: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface SessionSnapshot {
  sessionKey: string;
  session: UserSession;
  /** 距离会话因空闲被判定过期的大致剩余时间（毫秒） */
  idleExpiresInMs: number;
}

export interface SessionManagerOptions {
  sessionTimeoutMs?: number;
  debug?: boolean;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private acpClient: CursorACPClient;
  private sessionTimeoutMs: number;
  private debug: boolean;

  constructor(acpClient: CursorACPClient, options?: SessionManagerOptions) {
    this.acpClient = acpClient;
    this.sessionTimeoutMs = options?.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.debug = options?.debug ?? false;
  }

  private makeKey(chatId: string, userId: string, chatType: string): string {
    return chatType === "p2p" ? `dm:${userId}` : `${chatId}:${userId}`;
  }

  async getOrCreateSession(
    chatId: string,
    userId: string,
    chatType: string,
  ): Promise<UserSession> {
    const key = this.makeKey(chatId, userId, chatType);
    const existing = this.sessions.get(key);

    if (existing && Date.now() - existing.lastActiveAt < this.sessionTimeoutMs) {
      existing.lastActiveAt = Date.now();
      if (this.debug) {
        console.log(
          `[bridge:debug] session reuse key=${key} acpSessionId=${existing.sessionId}`,
        );
      }
      return existing;
    }

    const acpSession: ACPSessionInfo = await this.acpClient.createSession();
    const session: UserSession = {
      sessionId: acpSession.sessionId,
      chatId,
      userId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(key, session);
    if (this.debug) {
      console.log(
        `[bridge:debug] session/new key=${key} acpSessionId=${session.sessionId}`,
      );
    }
    return session;
  }

  /** 当前用户在当前聊天下是否有未过期的 ACP 会话（不触发新建） */
  getSessionSnapshot(
    chatId: string,
    userId: string,
    chatType: string,
  ): SessionSnapshot | null {
    const key = this.makeKey(chatId, userId, chatType);
    const existing = this.sessions.get(key);
    if (!existing) return null;
    const idleFor = Date.now() - existing.lastActiveAt;
    if (idleFor >= this.sessionTimeoutMs) return null;
    return {
      sessionKey: key,
      session: existing,
      idleExpiresInMs: this.sessionTimeoutMs - idleFor,
    };
  }

  resetSession(chatId: string, userId: string, chatType: string): boolean {
    const key = this.makeKey(chatId, userId, chatType);
    const removed = this.sessions.delete(key);
    if (removed && this.debug) {
      console.log(`[bridge:debug] session reset key=${key}`);
    }
    return removed;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt >= this.sessionTimeoutMs) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  getStats(): { total: number; active: number } {
    const now = Date.now();
    let active = 0;
    for (const session of this.sessions.values()) {
      if (now - session.lastActiveAt < this.sessionTimeoutMs) {
        active++;
      }
    }
    return { total: this.sessions.size, active };
  }
}
