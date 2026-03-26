import * as path from "node:path";
import type { AcpRuntime } from "./acp/runtime.js";
import type { SessionStore, PersistedSessionGroup, PersistedSlotRecord } from "./session-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

export interface SessionSlot {
  slotIndex: number;
  name?: string;
  session: UserSession;
  /** 上一轮对话的最终 markdown 输出，仅内存缓存，重启后丢失 */
  lastReply?: string;
}

export interface UserSessionGroup {
  slots: SessionSlot[];
  activeSlotIndex: number;
  /** monotonically increasing counter for next slot number */
  nextSlotIndex: number;
}

export interface SessionSnapshot {
  sessionKey: string;
  group: UserSessionGroup;
  activeSlot: SessionSlot;
  idleExpiresInMs: number;
}

export interface SlotListItem {
  slotIndex: number;
  name?: string;
  workspaceRoot: string;
  lastActiveAt: number;
  isActive: boolean;
}

export interface SessionManagerOptions {
  debug?: boolean;
  /** 未指定会话目录时的默认 cwd（通常即 CURSOR_WORK_DIR） */
  defaultWorkspaceRoot: string;
  /** 每个 key 最多保留的 slot 数量 */
  maxSlotsPerKey?: number;
  onSessionWorkspace?: (sessionId: string, workspaceRoot: string) => void;
  onSessionWorkspaceRemove?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * 飞书维度会话：每个 sessionKey 持有多个 slot（最多 maxSlotsPerKey 个），
 * 每个 slot 对应一个 ACP session；slot 可独立切换而不关闭其他 slot 的 ACP 连接。
 */
export class SessionManager {
  private groups = new Map<string, UserSessionGroup>();
  private acp: AcpRuntime;
  private store: SessionStore;
  private idleMs: number;
  private debug: boolean;
  private readonly defaultWorkspaceRoot: string;
  private readonly maxSlots: number;
  private readonly onSessionWorkspace?: (sessionId: string, workspaceRoot: string) => void;
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
    this.maxSlots = options?.maxSlotsPerKey ?? 5;
    this.onSessionWorkspace = options?.onSessionWorkspace;
    this.onSessionWorkspaceRemove = options?.onSessionWorkspaceRemove;
  }

  async init(): Promise<void> {
    await this.store.load();
    const now = Date.now();
    for (const key of this.store.allKeys()) {
      const group = this.store.get(key);
      if (!group) continue;
      // Drop groups where all slots have expired
      const hasLive = group.slots.some((s) => now - s.lastActiveAt < this.idleMs);
      if (!hasLive) {
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

  // -------------------------------------------------------------------------
  // Core: get or create active session
  // -------------------------------------------------------------------------

  async getOrCreateSession(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): Promise<UserSession> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);

    // Try to restore from store if not in memory
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }

    if (group) {
      const slot = this.findSlot(group, group.activeSlotIndex);
      if (slot && now - slot.session.lastActiveAt < this.idleMs) {
        slot.session.lastActiveAt = now;
        this.persistGroup(key, group);
        if (this.debug) {
          console.log(
            `[session] reuse key=${key} slot=#${slot.slotIndex} sessionId=${slot.session.sessionId}`,
          );
        }
        return slot.session;
      }
      // Active slot expired — create a new ACP session in its place
      if (slot) {
        await this.renewSlotSession(slot, slot.session.workspaceRoot, now);
        this.persistGroup(key, group);
        return slot.session;
      }
    }

    // No group or no valid slot — create fresh group with slot #1
    const { sessionId } = await this.acp.newSession(this.defaultWorkspaceRoot);
    const session = this.makeSession(sessionId, this.defaultWorkspaceRoot, chatId, userId, chatType, now);
    const newGroup: UserSessionGroup = {
      slots: [{ slotIndex: 1, session }],
      activeSlotIndex: 1,
      nextSlotIndex: 2,
    };
    this.onSessionWorkspace?.(sessionId, session.workspaceRoot);
    this.groups.set(key, newGroup);
    this.persistGroup(key, newGroup);
    if (this.debug) {
      console.log(`[session] new key=${key} slot=#1 sessionId=${sessionId}`);
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Create new slot
  // -------------------------------------------------------------------------

  async createNewSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    workspaceRoot?: string,
    name?: string,
  ): Promise<{ slotIndex: number; name?: string; sessionId: string; workspaceRoot: string }> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }
    if (group && group.slots.length >= this.maxSlots) {
      throw new Error(
        `已达到最多 ${this.maxSlots} 个 session 的上限，请先用 /close <编号> 关闭一个。`,
      );
    }

    const normalizedName = this.normalizeSlotName(name);
    if (group && normalizedName) {
      this.ensureSlotNameAvailable(group, normalizedName);
    }

    const cwd = workspaceRoot ? path.resolve(workspaceRoot) : this.defaultWorkspaceRoot;
    const { sessionId } = await this.acp.newSession(cwd);
    const session = this.makeSession(sessionId, cwd, chatId, userId, chatType, now);

    let slotIndex: number;
    if (!group) {
      slotIndex = 1;
      group = {
        slots: [{ slotIndex, name: normalizedName, session }],
        activeSlotIndex: slotIndex,
        nextSlotIndex: 2,
      };
    } else {
      slotIndex = group.nextSlotIndex++;
      group.slots.push({ slotIndex, name: normalizedName, session });
      group.activeSlotIndex = slotIndex;
    }

    this.onSessionWorkspace?.(sessionId, cwd);
    this.groups.set(key, group);
    this.persistGroup(key, group);
    if (this.debug) {
      console.log(`[session] new slot key=${key} slot=#${slotIndex} sessionId=${sessionId} cwd=${cwd}`);
    }
    return { slotIndex, name: normalizedName, sessionId, workspaceRoot: cwd };
  }

  // -------------------------------------------------------------------------
  // Switch active slot
  // -------------------------------------------------------------------------

  async switchSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session，请先发送消息创建一个。");
    }

    const slot = this.resolveSlot(group, target);
    if (!slot) {
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }

    return this.activateSlot(key, group, slot);
  }

  async switchToPreviousSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session，请先发送消息创建一个。");
    }

    const slot = this.findPreviousSlot(group);
    if (!slot) {
      throw new Error("当前没有上一个可切换的 session。发送 /sessions 查看所有 session。");
    }

    return this.activateSlot(key, group, slot);
  }

  async renameSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string | null,
    newName: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session。");
    }

    const slot =
      target === null
        ? this.findSlot(group, group.activeSlotIndex)
        : this.resolveSlot(group, target);
    if (!slot) {
      if (target === null) {
        throw new Error("当前没有可重命名的活跃 session。");
      }
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }

    const normalizedName = this.normalizeSlotName(newName);
    if (!normalizedName) {
      throw new Error("新名字不能为空。");
    }

    this.ensureSlotNameAvailable(group, normalizedName, slot.slotIndex);
    slot.name = normalizedName;
    this.persistGroup(key, group);
    if (this.debug) {
      console.log(
        `[session] rename key=${key} slot=#${slot.slotIndex} name=${normalizedName}`,
      );
    }
    return slot;
  }

  // -------------------------------------------------------------------------
  // Close a specific slot
  // -------------------------------------------------------------------------

  async closeSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session。");
    }
    if (group.slots.length === 1) {
      throw new Error("不能关闭唯一的 session。如需重置，请使用 /reset。");
    }

    const slot = this.resolveSlot(group, target);
    if (!slot) {
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }

    this.onSessionWorkspaceRemove?.(slot.session.sessionId);
    await this.acp.cancelSession(slot.session.sessionId);
    await this.acp.closeSession(slot.session.sessionId);

    group.slots = group.slots.filter((s) => s.slotIndex !== slot.slotIndex);

    // If we closed the active slot, switch to the most recently active remaining slot
    if (group.activeSlotIndex === slot.slotIndex) {
      const best = group.slots.reduce((a, b) =>
        b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
      );
      group.activeSlotIndex = best.slotIndex;
      this.onSessionWorkspace?.(best.session.sessionId, best.session.workspaceRoot);
    }

    this.groups.set(key, group);
    this.persistGroup(key, group);
    if (this.debug) {
      console.log(`[session] close slot key=${key} slot=#${slot.slotIndex}`);
    }
    return slot;
  }

  // -------------------------------------------------------------------------
  // List slots
  // -------------------------------------------------------------------------

  async listSlots(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): Promise<SlotListItem[]> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        Date.now(),
      );
    }
    if (!group) return [];
    return group.slots.map((s) => ({
      slotIndex: s.slotIndex,
      name: s.name,
      workspaceRoot: s.session.workspaceRoot,
      lastActiveAt: s.session.lastActiveAt,
      isActive: s.slotIndex === group.activeSlotIndex,
    }));
  }

  // -------------------------------------------------------------------------
  // Cache last reply for active slot
  // -------------------------------------------------------------------------

  setSlotLastReply(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    sessionId: string,
    markdown: string,
  ): void {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const group = this.groups.get(key);
    if (!group) return;
    const slot = group.slots.find((s) => s.session.sessionId === sessionId);
    if (slot) {
      slot.lastReply = markdown;
    }
  }

  // -------------------------------------------------------------------------
  // Reset active slot (replaces old resetSession behaviour)
  // -------------------------------------------------------------------------

  async resetSession(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    workspaceRoot?: string,
  ): Promise<void> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(key, chatId, userId, chatType, now);
    }

    const cwd = workspaceRoot
      ? path.resolve(workspaceRoot)
      : this.defaultWorkspaceRoot;

    if (!group) {
      // Bootstrap fresh
      const { sessionId } = await this.acp.newSession(cwd);
      const session = this.makeSession(sessionId, cwd, chatId, userId, chatType, now);
      const newGroup: UserSessionGroup = {
        slots: [{ slotIndex: 1, session }],
        activeSlotIndex: 1,
        nextSlotIndex: 2,
      };
      this.onSessionWorkspace?.(sessionId, cwd);
      this.groups.set(key, newGroup);
      this.persistGroup(key, newGroup);
      if (this.debug) {
        console.log(`[session] reset→new(bootstrap) key=${key} slot=#1 sessionId=${sessionId}`);
      }
      return;
    }

    const slot = this.findSlot(group, group.activeSlotIndex);
    if (slot) {
      this.onSessionWorkspaceRemove?.(slot.session.sessionId);
      await this.acp.cancelSession(slot.session.sessionId);
      await this.acp.closeSession(slot.session.sessionId);
    }

    const { sessionId } = await this.acp.newSession(cwd);
    const session = this.makeSession(sessionId, cwd, chatId, userId, chatType, now);

    if (slot) {
      slot.session = session;
    } else {
      // Shouldn't normally happen, but be safe
      const slotIndex = group.nextSlotIndex++;
      group.slots.push({ slotIndex, session });
      group.activeSlotIndex = slotIndex;
    }

    this.onSessionWorkspace?.(sessionId, cwd);
    this.groups.set(key, group);
    this.persistGroup(key, group);
    if (this.debug) {
      const slotIdx = slot?.slotIndex ?? group.activeSlotIndex;
      console.log(`[session] reset key=${key} slot=#${slotIdx} sessionId=${sessionId} cwd=${cwd}`);
    }
  }

  // -------------------------------------------------------------------------
  // Stats / snapshot (for /status)
  // -------------------------------------------------------------------------

  getStats(): { total: number; active: number } {
    const now = Date.now();
    let active = 0;
    let total = 0;
    for (const group of this.groups.values()) {
      for (const slot of group.slots) {
        total++;
        if (now - slot.session.lastActiveAt < this.idleMs) {
          active++;
        }
      }
    }
    return { total, active };
  }

  getSessionSnapshot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
  ): SessionSnapshot | null {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType);
    const group = this.groups.get(key);
    if (!group) return null;
    const slot = this.findSlot(group, group.activeSlotIndex);
    if (!slot) return null;
    const idleFor = Date.now() - slot.session.lastActiveAt;
    if (idleFor >= this.idleMs) return null;
    return {
      sessionKey: key,
      group,
      activeSlot: slot,
      idleExpiresInMs: this.idleMs - idleFor,
    };
  }

  // -------------------------------------------------------------------------
  // Periodic cleanup
  // -------------------------------------------------------------------------

  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, group] of this.groups) {
      const before = group.slots.length;
      const expired = group.slots.filter((s) => now - s.session.lastActiveAt >= this.idleMs);
      for (const slot of expired) {
        this.onSessionWorkspaceRemove?.(slot.session.sessionId);
      }
      group.slots = group.slots.filter((s) => now - s.session.lastActiveAt < this.idleMs);
      cleaned += before - group.slots.length;

      if (group.slots.length === 0) {
        this.groups.delete(key);
        this.store.delete(key);
      } else {
        // If the active slot was removed, point to the most recently active remaining slot
        if (!this.findSlot(group, group.activeSlotIndex)) {
          const best = group.slots.reduce((a, b) =>
            b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
          );
          group.activeSlotIndex = best.slotIndex;
        }
        this.persistGroup(key, group);
      }
    }
    if (cleaned) {
      void this.store.flush().catch(() => {});
    }
    return cleaned;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private makeSession(
    sessionId: string,
    workspaceRoot: string,
    chatId: string,
    userId: string,
    chatType: "p2p" | "group",
    now: number,
  ): UserSession {
    return { sessionId, workspaceRoot, chatId, userId, chatType, createdAt: now, lastActiveAt: now };
  }

  private findSlot(group: UserSessionGroup, slotIndex: number): SessionSlot | undefined {
    return group.slots.find((s) => s.slotIndex === slotIndex);
  }

  private findPreviousSlot(group: UserSessionGroup): SessionSlot | undefined {
    const candidates = group.slots.filter(
      (s) => s.slotIndex !== group.activeSlotIndex,
    );
    if (candidates.length === 0) return undefined;
    return candidates.reduce((a, b) =>
      b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
    );
  }

  private resolveSlot(group: UserSessionGroup, target: number | string): SessionSlot | undefined {
    if (typeof target === "number") {
      return this.findSlot(group, target);
    }
    return group.slots.find((s) => s.name === target);
  }

  private normalizeSlotName(name?: string): string | undefined {
    const normalized = name?.trim();
    return normalized ? normalized : undefined;
  }

  private ensureSlotNameAvailable(
    group: UserSessionGroup,
    name: string,
    excludeSlotIndex?: number,
  ): void {
    const conflict = group.slots.find(
      (s) => s.slotIndex !== excludeSlotIndex && s.name === name,
    );
    if (conflict) {
      throw new Error(`名称 "${name}" 已被 session #${conflict.slotIndex} 使用。`);
    }
  }

  private async activateSlot(
    key: string,
    group: UserSessionGroup,
    slot: SessionSlot,
  ): Promise<SessionSlot> {
    const now = Date.now();
    const current = this.findSlot(group, group.activeSlotIndex);

    if (current && current.slotIndex !== slot.slotIndex) {
      current.session.lastActiveAt = now - 1;
    }

    if (now - slot.session.lastActiveAt >= this.idleMs) {
      await this.renewSlotSession(slot, slot.session.workspaceRoot, now);
    }

    slot.session.lastActiveAt = now;
    group.activeSlotIndex = slot.slotIndex;
    this.onSessionWorkspace?.(slot.session.sessionId, slot.session.workspaceRoot);
    this.persistGroup(key, group);
    if (this.debug) {
      console.log(
        `[session] switch key=${key} -> slot=#${slot.slotIndex} sessionId=${slot.session.sessionId}`,
      );
    }
    return slot;
  }

  private async renewSlotSession(slot: SessionSlot, cwd: string, now: number): Promise<void> {
    const oldId = slot.session.sessionId;
    // Try loadSession first (if supported)
    if (this.acp.supportsLoadSession) {
      try {
        await this.acp.loadSession(oldId, cwd);
        slot.session.lastActiveAt = now;
        if (this.debug) {
          console.log(`[session] loadSession slot=#${slot.slotIndex} sessionId=${oldId}`);
        }
        return;
      } catch {
        // Fall through to new session
      }
    }
    const { sessionId } = await this.acp.newSession(cwd);
    slot.session = { ...slot.session, sessionId, workspaceRoot: cwd, lastActiveAt: now };
    this.onSessionWorkspace?.(sessionId, cwd);
    if (this.debug) {
      console.log(`[session] renew slot=#${slot.slotIndex} old=${oldId} new=${sessionId}`);
    }
  }

  private async restoreGroupFromStore(
    key: string,
    chatId: string,
    userId: string,
    chatType: "p2p" | "group",
    now: number,
  ): Promise<UserSessionGroup | undefined> {
    const persisted = this.store.get(key);
    if (!persisted) return undefined;

    const liveSlots = persisted.slots.filter((s) => now - s.lastActiveAt < this.idleMs);
    if (liveSlots.length === 0) {
      this.store.delete(key);
      void this.store.flush().catch(() => {});
      return undefined;
    }

    const restoredSlots: SessionSlot[] = [];
    for (const ps of liveSlots) {
      const cwd = ps.workspaceRoot
        ? path.resolve(ps.workspaceRoot)
        : this.defaultWorkspaceRoot;

      let sessionId: string;
      if (this.acp.supportsLoadSession) {
        sessionId = ps.sessionId;
        try {
          await this.acp.loadSession(ps.sessionId, cwd);
          if (this.debug) {
            console.log(`[session] restore load slot=#${ps.slotIndex} sessionId=${ps.sessionId}`);
          }
        } catch {
          const fresh = await this.acp.newSession(cwd);
          sessionId = fresh.sessionId;
          if (this.debug) {
            console.log(`[session] restore new slot=#${ps.slotIndex} (load failed) sessionId=${sessionId}`);
          }
        }
      } else {
        const fresh = await this.acp.newSession(cwd);
        sessionId = fresh.sessionId;
        if (this.debug) {
          console.log(`[session] restore new slot=#${ps.slotIndex} (load unsupported) sessionId=${sessionId}`);
        }
      }

      const session = this.makeSession(sessionId, cwd, chatId, userId, chatType, now);
      restoredSlots.push({ slotIndex: ps.slotIndex, name: ps.name, session });
      this.onSessionWorkspace?.(sessionId, cwd);
    }

    // Determine active slot: prefer persisted active, else most recent
    let activeSlotIndex = persisted.activeSlotIndex;
    if (!restoredSlots.find((s) => s.slotIndex === activeSlotIndex)) {
      activeSlotIndex = restoredSlots.reduce((a, b) =>
        b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
      ).slotIndex;
    }

    const group: UserSessionGroup = {
      slots: restoredSlots,
      activeSlotIndex,
      nextSlotIndex: persisted.nextSlotIndex,
    };
    this.groups.set(key, group);
    this.persistGroup(key, group);
    return group;
  }

  private persistGroup(key: string, group: UserSessionGroup): void {
    // Infer chatId/userId/chatType from one of the slots
    const sample = group.slots[0]?.session;
    if (!sample) return;

    const slots: PersistedSlotRecord[] = group.slots.map((s) => ({
      slotIndex: s.slotIndex,
      name: s.name,
      sessionId: s.session.sessionId,
      workspaceRoot: s.session.workspaceRoot,
      lastActiveAt: s.session.lastActiveAt,
    }));

    const persistedGroup: PersistedSessionGroup = {
      chatId: sample.chatId,
      userId: sample.userId,
      chatType: sample.chatType,
      activeSlotIndex: group.activeSlotIndex,
      nextSlotIndex: group.nextSlotIndex,
      slots,
    };
    this.store.set(key, persistedGroup);
    void this.store.flush().catch((e) => {
      console.error("[session] flush failed:", e);
    });
  }
}
