import * as path from "node:path";
import type { AcpRuntime } from "./acp/runtime.js";
import type { SessionStore } from "./session-store.js";

export interface UserSession {
  sessionId: string;
  /** ACP session/new 与读文件沙箱使用的绝对路径 */
  workspaceRoot: string;
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionSnapshot {
  sessionKey: string;
  session: UserSession;
  idleExpiresInMs: number;
}

export interface SessionManagerOptions {
  debug?: boolean;
  /** 未指定会话目录时的默认 cwd（通常即 CURSOR_WORK_DIR） */
  defaultWorkspaceRoot: string;
  onSessionWorkspace?: (sessionId: string, workspaceRoot: string) => void;
  onSessionWorkspaceRemove?: (sessionId: string) => void;
}

/**
 * 飞书维度会话：内存态 + 磁盘映射；在支持时通过 session/load 恢复 ACP 会话。
 */
export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private acp: AcpRuntime;
  private store: SessionStore;
  private idleMs: number;
  private debug: boolean;
  private readonly defaultWorkspaceRoot: string;
  private readonly onSessionWorkspace?: (
    sessionId: string,
    workspaceRoot: string,
  ) => void;
  private readonly onSessionWorkspaceRemove?: (sessionId: string) => void;

  constructor(
    acp: AcpRuntime,
    store: SessionStore,
    idleMs: number,
    options?: SessionManagerOptions,
  ) {
    this.acp = acp;
    this.store = store;
    this.idleMs = idleMs;
    this.debug = options?.debug ?? false;
    this.defaultWorkspaceRoot = path.resolve(
      options?.defaultWorkspaceRoot ?? process.cwd(),
    );
    this.onSessionWorkspace = options?.onSessionWorkspace;
    this.onSessionWorkspaceRemove = options?.onSessionWorkspaceRemove;
  }

  async init(): Promise<void> {
    await this.store.load();
    for (const key of this.store.allKeys()) {
      const rec = this.store.get(key);
      if (!rec) continue;
      if (Date.now() - rec.lastActiveAt >= this.idleMs) {
        this.store.delete(key);
      }
    }
    await this.store.flush();
  }

  private makeKey(chatId: string, userId: string, chatType: string): string {
    return chatType === "p2p" ? `dm:${userId}` : `${chatId}:${userId}`;
  }

  private chatType(t: string): "p2p" | "group" {
    return t === "group" ? "group" : "p2p";
  }

  async getOrCreateSession(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): Promise<UserSession> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let mem = this.sessions.get(key);
    if (mem && now - mem.lastActiveAt < this.idleMs) {
      mem.lastActiveAt = now;
      this.persist(key, mem);
      if (this.debug) {
        console.log(
          `[session] reuse key=${key} sessionId=${mem.sessionId} cwd=${mem.workspaceRoot}`,
        );
      }
      return mem;
    }

    const persisted = this.store.get(key);
    if (persisted && now - persisted.lastActiveAt >= this.idleMs) {
      this.store.delete(key);
      void this.store.flush().catch(() => {});
    } else if (
      persisted &&
      now - persisted.lastActiveAt < this.idleMs &&
      persisted.chatId === chatId &&
      persisted.userId === userId
    ) {
      const cwd =
        persisted.workspaceRoot != null && persisted.workspaceRoot.length > 0
          ? path.resolve(persisted.workspaceRoot)
          : this.defaultWorkspaceRoot;

      if (this.acp.supportsLoadSession) {
        try {
          await this.acp.loadSession(persisted.sessionId, cwd);
          const session: UserSession = {
            sessionId: persisted.sessionId,
            workspaceRoot: cwd,
            chatId,
            userId,
            chatType,
            createdAt: persisted.lastActiveAt,
            lastActiveAt: now,
          };
          this.sessions.set(key, session);
          this.onSessionWorkspace?.(session.sessionId, session.workspaceRoot);
          this.persist(key, session);
          if (this.debug) {
            console.log(
              `[session] load key=${key} sessionId=${session.sessionId} cwd=${cwd}`,
            );
          }
          return session;
        } catch (e) {
          console.warn(
            `[session] load failed, creating new:`,
            e instanceof Error ? e.message : e,
          );
          this.store.delete(key);
          await this.store.flush();
        }
      }
      console.warn(
        "[session] Agent 未声明 loadSession，忽略磁盘上的 sessionId，将创建新会话",
      );
      this.store.delete(key);
      await this.store.flush();
    }

    const { sessionId } = await this.acp.newSession(this.defaultWorkspaceRoot);
    const session: UserSession = {
      sessionId,
      workspaceRoot: this.defaultWorkspaceRoot,
      chatId,
      userId,
      chatType,
      createdAt: now,
      lastActiveAt: now,
    };
    this.onSessionWorkspace?.(sessionId, session.workspaceRoot);
    this.sessions.set(key, session);
    this.persist(key, session);
    if (this.debug) {
      console.log(
        `[session] new key=${key} sessionId=${session.sessionId} cwd=${session.workspaceRoot}`,
      );
    }
    return session;
  }

  private persist(key: string, s: UserSession): void {
    this.store.set({
      key,
      sessionId: s.sessionId,
      workspaceRoot: s.workspaceRoot,
      chatId: s.chatId,
      userId: s.userId,
      chatType: s.chatType,
      lastActiveAt: s.lastActiveAt,
    });
    void this.store.flush().catch((e) => {
      console.error("[session] flush failed:", e);
    });
  }

  getSessionSnapshot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): SessionSnapshot | null {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const existing = this.sessions.get(key);
    if (!existing) return null;
    const idleFor = Date.now() - existing.lastActiveAt;
    if (idleFor >= this.idleMs) return null;
    return {
      sessionKey: key,
      session: existing,
      idleExpiresInMs: this.idleMs - idleFor,
    };
  }

  /**
   * 结束当前 ACP 会话并清空映射；可选 `workspaceRoot` 为本次新会话的绝对路径。
   */
  async resetSession(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    workspaceRoot?: string,
  ): Promise<void> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const mem = this.sessions.get(key);
    const sid = mem?.sessionId ?? this.store.get(key)?.sessionId;

    if (sid) {
      this.onSessionWorkspaceRemove?.(sid);
      await this.acp.cancelSession(sid);
      await this.acp.closeSession(sid);
    }

    this.sessions.delete(key);
    this.store.delete(key);
    await this.store.flush();
    if (this.debug) {
      console.log(`[session] reset key=${key}`);
    }

    const resolved = workspaceRoot
      ? path.resolve(workspaceRoot)
      : this.defaultWorkspaceRoot;

    const { sessionId } = await this.acp.newSession(resolved);
    const now = Date.now();
    const session: UserSession = {
      sessionId,
      workspaceRoot: resolved,
      chatId,
      userId,
      chatType,
      createdAt: now,
      lastActiveAt: now,
    };
    this.onSessionWorkspace?.(sessionId, resolved);
    this.sessions.set(key, session);
    this.persist(key, session);
    if (this.debug) {
      console.log(
        `[session] reset→new key=${key} sessionId=${sessionId} cwd=${resolved}`,
      );
    }
  }

  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt >= this.idleMs) {
        this.onSessionWorkspaceRemove?.(session.sessionId);
        this.sessions.delete(key);
        this.store.delete(key);
        cleaned++;
      }
    }
    if (cleaned) {
      void this.store.flush().catch(() => {});
    }
    return cleaned;
  }

  getStats(): { total: number; active: number } {
    const now = Date.now();
    let active = 0;
    for (const session of this.sessions.values()) {
      if (now - session.lastActiveAt < this.idleMs) {
        active++;
      }
    }
    return { total: this.sessions.size, active };
  }
}
