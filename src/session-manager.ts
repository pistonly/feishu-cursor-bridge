import type { CursorACPClient, ACPSessionInfo } from "./cursor-acp.js";

export interface UserSession {
  sessionId: string;
  chatId: string;
  userId: string;
  createdAt: number;
  lastActiveAt: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private acpClient: CursorACPClient;
  private sessionTimeoutMs: number;

  constructor(acpClient: CursorACPClient, sessionTimeoutMs?: number) {
    this.acpClient = acpClient;
    this.sessionTimeoutMs = sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
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
    return session;
  }

  resetSession(chatId: string, userId: string, chatType: string): boolean {
    const key = this.makeKey(chatId, userId, chatType);
    return this.sessions.delete(key);
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
