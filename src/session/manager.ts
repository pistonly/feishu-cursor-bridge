import * as path from "node:path";
import {
  isCodexBackend,
  type AcpBackend,
  type AcpRuntimeResolver,
  type BridgeAcpRuntime,
  type SessionRecovery,
} from "../acp/runtime-contract.js";
import type {
  SessionStore,
  PersistedSessionGroup,
  PersistedSlotRecord,
} from "./store.js";

export interface UserSession {
  backend: AcpBackend;
  sessionId: string;
  preferredModelId?: string;
  recovery?: SessionRecovery;
  workspaceRoot: string;
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionSlot {
  slotIndex: number;
  name?: string;
  session: UserSession;
  lastPrompt?: string;
  lastReply?: string;
}

export interface UserSessionGroup {
  slots: SessionSlot[];
  activeSlotIndex: number;
  nextSlotIndex: number;
}

export interface SessionSnapshot {
  sessionKey: string;
  group: UserSessionGroup;
  activeSlot: SessionSlot;
  idleExpiresInMs: number | null;
}

export interface SlotListItem {
  slotIndex: number;
  sessionId: string;
  backend: AcpBackend;
  name?: string;
  workspaceRoot: string;
  lastActiveAt: number;
  isActive: boolean;
}

export interface SessionManagerOptions {
  debug?: boolean;
  defaultWorkspaceRoot: string;
  defaultBackend?: AcpBackend;
  maxSlotsPerKey?: number;
  maxSessionsPerUser?: number;
}

export class SessionManager {
  private groups = new Map<string, UserSessionGroup>();
  private pendingNotices = new Map<string, string[]>();
  private resolver: AcpRuntimeResolver;
  private store: SessionStore;
  private idleMs: number;
  private debug: boolean;
  private readonly defaultWorkspaceRoot: string;
  private readonly defaultBackend: AcpBackend;
  private readonly maxSlots: number;
  private readonly maxSessionsPerUser: number;

  constructor(
    resolver: AcpRuntimeResolver | BridgeAcpRuntime,
    store: SessionStore,
    idleMs: number,
    options: SessionManagerOptions,
  ) {
    this.resolver = this.normalizeResolver(resolver);
    this.store = store;
    this.idleMs = idleMs;
    this.debug = options.debug ?? false;
    this.defaultWorkspaceRoot = path.resolve(
      options.defaultWorkspaceRoot ?? process.cwd(),
    );
    this.defaultBackend = options.defaultBackend ?? "cursor-official";
    this.maxSlots = options.maxSlotsPerKey ?? 5;
    this.maxSessionsPerUser = options.maxSessionsPerUser ?? 10;
  }

  async init(): Promise<void> {
    await this.store.load();
    const now = Date.now();
    for (const key of this.store.allKeys()) {
      const group = this.store.get(key);
      if (!group) continue;
      const hasLive = group.slots.some((s) => !this.isExpiredAt(s.lastActiveAt, now));
      if (!hasLive) {
        this.store.delete(key);
      }
    }
    await this.store.flush();
  }

  async getActiveSession(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): Promise<UserSession | null> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    let restoredFromStore = false;
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
      restoredFromStore = group != null;
    }

    if (!group) return null;
    const slot = this.findSlot(group, group.activeSlotIndex);
    if (!slot) return null;

    if (!this.isExpiredAt(slot.session.lastActiveAt, now)) {
      if (!restoredFromStore) {
        await this.ensureSlotSessionAvailable(slot, now, key);
      }
      slot.session.lastActiveAt = now;
      this.persistGroup(key, group);
      return slot.session;
    }

    await this.renewSlotSession(slot, slot.session.workspaceRoot, now, key);
    this.persistGroup(key, group);
    return slot.session;
  }

  async createNewSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    workspaceRoot: string,
    backend: AcpBackend,
    name?: string,
    threadId?: string,
  ): Promise<{
    slotIndex: number;
    name?: string;
    backend: AcpBackend;
    sessionId: string;
    workspaceRoot: string;
  }> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
    }
    this.assertCanAddUserSession(userId, now);
    if (group && group.slots.length >= this.maxSlots) {
      throw new Error(
        `已达到最多 ${this.maxSlots} 个 session 的上限，请先用 /close <编号> 关闭一个。`,
      );
    }

    const normalizedName = this.normalizeSlotName(name);
    if (group && normalizedName) {
      this.ensureSlotNameAvailable(group, normalizedName);
    }

    const trimmedRoot = workspaceRoot.trim();
    if (!trimmedRoot) {
      throw new Error(
        "创建 session 必须指定工作区。请发送 `/new list` 查看列表后使用 `/new <序号>`，或使用 `/new <目录绝对路径>`。",
      );
    }
    const cwd = path.resolve(trimmedRoot);
    const runtime = this.runtimeForBackend(backend);
    const { sessionId, recovery } = await runtime.newSession(cwd);
    const session = this.makeSession(
      backend,
      sessionId,
      cwd,
      chatId,
      userId,
      chatType,
      now,
      recovery,
      threadId,
    );

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

    this.groups.set(key, group);
    this.persistGroup(key, group);
    return { slotIndex, name: normalizedName, backend, sessionId, workspaceRoot: cwd };
  }

  async switchSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string,
    threadId?: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    let restoredFromStore = false;
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
      restoredFromStore = group != null;
    }
    if (!group || group.slots.length === 0) {
      throw new Error(
        "当前没有任何 session。请先使用 `/new list` 查看工作区列表，再用 `/new <序号>` 或 `/new <路径>` 创建。",
      );
    }

    const slot = this.resolveSlot(group, target);
    if (!slot) {
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }

    return this.activateSlot(key, group, slot, {
      probeAvailability: !restoredFromStore,
    });
  }

  async switchToPreviousSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    let restoredFromStore = false;
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
      restoredFromStore = group != null;
    }
    if (!group || group.slots.length === 0) {
      throw new Error(
        "当前没有任何 session。请先使用 `/new list` 查看工作区列表，再用 `/new <序号>` 或 `/new <路径>` 创建。",
      );
    }

    const slot = this.findPreviousSlot(group);
    if (!slot) {
      throw new Error("当前没有上一个可切换的 session。发送 /sessions 查看所有 session。");
    }

    return this.activateSlot(key, group, slot, {
      probeAvailability: !restoredFromStore,
    });
  }

  async renameSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string | null,
    newName: string,
    threadId?: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
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
    return slot;
  }

  async closeSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string,
    threadId?: string,
  ): Promise<{ closed: SessionSlot; removedEntireGroup: boolean }> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session。");
    }

    const slot = this.resolveSlot(group, target);
    if (!slot) {
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }

    const runtime = this.runtimeForSlot(slot);
    await runtime.cancelSession(slot.session.sessionId);
    await runtime.closeSession(slot.session.sessionId);

    group.slots = group.slots.filter((s) => s.slotIndex !== slot.slotIndex);

    if (group.slots.length === 0) {
      this.groups.delete(key);
      this.store.delete(key);
      void this.store.flush().catch(() => {});
      return { closed: slot, removedEntireGroup: true };
    }

    if (group.activeSlotIndex === slot.slotIndex) {
      const best = group.slots.reduce((a, b) =>
        b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
      );
      group.activeSlotIndex = best.slotIndex;
    }

    this.groups.set(key, group);
    this.persistGroup(key, group);
    return { closed: slot, removedEntireGroup: false };
  }

  async closeAllSlots(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): Promise<{ closed: SessionSlot[] }> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const now = Date.now();

    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        now,
        threadId,
      );
    }
    if (!group || group.slots.length === 0) {
      throw new Error("当前没有任何 session。");
    }

    const toClose = [...group.slots];
    for (const slot of toClose) {
      const runtime = this.runtimeForSlot(slot);
      await runtime.cancelSession(slot.session.sessionId);
      await runtime.closeSession(slot.session.sessionId);
    }

    this.groups.delete(key);
    this.store.delete(key);
    void this.store.flush().catch(() => {});
    return { closed: toClose };
  }

  async listSlots(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): Promise<SlotListItem[]> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        Date.now(),
        threadId,
      );
    }
    if (!group) return [];
    return [...group.slots]
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((slot) => ({
        slotIndex: slot.slotIndex,
        sessionId: slot.session.sessionId,
        backend: slot.session.backend,
        name: slot.name,
        workspaceRoot: slot.session.workspaceRoot,
        lastActiveAt: slot.session.lastActiveAt,
        isActive: slot.slotIndex === group!.activeSlotIndex,
      }));
  }

  async getSlot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    target: number | string | null,
    threadId?: string,
  ): Promise<SessionSlot> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        Date.now(),
        threadId,
      );
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
        throw new Error("当前没有可用的活跃 session。");
      }
      throw new Error(
        typeof target === "number"
          ? `找不到编号 #${target} 的 session。`
          : `找不到名称为 "${target}" 的 session。`,
      );
    }
    return slot;
  }

  getSessionSnapshot(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): SessionSnapshot | null {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const group = this.groups.get(key);
    if (!group) return null;
    const activeSlot = this.findSlot(group, group.activeSlotIndex);
    if (!activeSlot) return null;
    return {
      sessionKey: key,
      group,
      activeSlot,
      idleExpiresInMs: this.getIdleExpiresInMs(activeSlot.session.lastActiveAt, Date.now()),
    };
  }

  async getSessionSnapshotLoaded(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): Promise<SessionSnapshot | null> {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    let group = this.groups.get(key);
    if (!group) {
      group = await this.restoreGroupFromStore(
        key,
        chatId,
        userId,
        chatType,
        Date.now(),
        threadId,
      );
    }
    if (!group) return null;
    const activeSlot = this.findSlot(group, group.activeSlotIndex);
    if (!activeSlot) return null;
    return {
      sessionKey: key,
      group,
      activeSlot,
      idleExpiresInMs: this.getIdleExpiresInMs(
        activeSlot.session.lastActiveAt,
        Date.now(),
      ),
    };
  }

  getStats(): { active: number; total: number } {
    let total = 0;
    const now = Date.now();
    for (const group of this.groups.values()) {
      total += group.slots.filter((slot) => !this.isExpiredAt(slot.session.lastActiveAt, now)).length;
    }
    return { active: this.groups.size, total };
  }

  setSlotLastTurn(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    slotIndex: number,
    prompt: string,
    reply: string,
    threadId?: string,
  ): void {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const group = this.groups.get(key);
    if (!group) return;
    const slot = this.findSlot(group, slotIndex);
    if (!slot) return;
    slot.lastPrompt = prompt;
    slot.lastReply = reply;
  }

  setActiveSessionPreferredModel(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    modelId: string | undefined,
    threadId?: string,
  ): void {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const group = this.groups.get(key);
    if (!group) return;
    const activeSlot = this.findSlot(group, group.activeSlotIndex);
    if (!activeSlot) return;
    const normalized = modelId?.trim();
    if (normalized) {
      activeSlot.session.preferredModelId = normalized;
    } else {
      delete activeSlot.session.preferredModelId;
    }
    this.persistGroup(key, group);
  }

  consumePendingNotices(
    chatId: string,
    userId: string,
    chatTypeRaw: string,
    threadId?: string,
  ): string[] {
    const chatType = this.chatType(chatTypeRaw);
    const key = this.makeKey(chatId, userId, chatType, threadId);
    const list = this.pendingNotices.get(key) ?? [];
    this.pendingNotices.delete(key);
    return list;
  }

  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, group] of this.groups) {
      const before = group.slots.length;
      const expired = group.slots.filter((s) =>
        this.isExpiredAt(s.session.lastActiveAt, now),
      );
      for (const slot of expired) {
        const runtime = this.runtimeForSlot(slot);
        await runtime.cancelSession(slot.session.sessionId);
        await runtime.closeSession(slot.session.sessionId);
      }
      group.slots = group.slots.filter(
        (s) => !this.isExpiredAt(s.session.lastActiveAt, now),
      );
      cleaned += before - group.slots.length;

      if (group.slots.length === 0) {
        this.groups.delete(key);
        this.store.delete(key);
      } else {
        if (!group.slots.find((s) => s.slotIndex === group.activeSlotIndex)) {
          const best = group.slots.reduce((a, b) =>
            b.session.lastActiveAt > a.session.lastActiveAt ? b : a,
          );
          group.activeSlotIndex = best.slotIndex;
        }
        this.persistGroup(key, group);
      }
    }
    if (cleaned) {
      await this.store.flush();
    }
    return cleaned;
  }

  private makeSession(
    backend: AcpBackend,
    sessionId: string,
    workspaceRoot: string,
    chatId: string,
    userId: string,
    chatType: "p2p" | "group",
    now: number,
    recovery?: SessionRecovery,
    threadId?: string,
  ): UserSession {
    const s: UserSession = {
      backend,
      sessionId,
      workspaceRoot,
      chatId,
      userId,
      chatType,
      createdAt: now,
      lastActiveAt: now,
    };
    if (recovery) {
      s.recovery = recovery;
    }
    if (threadId) {
      s.threadId = threadId;
    }
    return s;
  }

  private normalizeResolver(
    resolver: AcpRuntimeResolver | BridgeAcpRuntime,
  ): AcpRuntimeResolver {
    if ("getRuntime" in resolver) {
      return resolver;
    }
    return {
      getRuntime: () => resolver,
    };
  }

  private runtimeForBackend(backend: AcpBackend): BridgeAcpRuntime {
    return this.resolver.getRuntime(backend);
  }

  private runtimeForSlot(slot: SessionSlot): BridgeAcpRuntime {
    return this.runtimeForBackend(slot.session.backend);
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
    options?: {
      probeAvailability?: boolean;
    },
  ): Promise<SessionSlot> {
    const now = Date.now();
    const current = this.findSlot(group, group.activeSlotIndex);

    if (current && current.slotIndex !== slot.slotIndex) {
      current.session.lastActiveAt = now - 1;
    }

    if (this.isExpiredAt(slot.session.lastActiveAt, now)) {
      await this.renewSlotSession(slot, slot.session.workspaceRoot, now, key);
    } else if (options?.probeAvailability !== false) {
      await this.ensureSlotSessionAvailable(slot, now, key);
    }

    slot.session.lastActiveAt = now;
    group.activeSlotIndex = slot.slotIndex;
    this.persistGroup(key, group);
    return slot;
  }

  private pushPendingNotice(key: string, message: string): void {
    const list = this.pendingNotices.get(key) ?? [];
    list.push(message);
    this.pendingNotices.set(key, list);
  }

  private formatRecoveryChangedNotice(
    slotIndex: number,
    workspaceRoot: string,
    previousRecovery: SessionRecovery,
    nextRecovery?: SessionRecovery,
  ): string {
    if (previousRecovery.kind === "cursor-cli") {
      const nextCursorCliChatId =
        nextRecovery?.kind === "cursor-cli" ? nextRecovery.cursorCliChatId : undefined;
      return [
        "⚠️ 检测到后台 ACP 会话已失效，虽然已自动重建连接，但当前飞书会话绑定的 CLI 会话发生了变化。",
        `• Session：#${slotIndex}`,
        `• 工作区：\`${workspaceRoot}\``,
        `• 旧 CLI resume ID：\`${previousRecovery.cursorCliChatId}\``,
        `• 新 CLI resume ID：${nextCursorCliChatId ? `\`${nextCursorCliChatId}\`` : "（无）"}`,
        "",
        "后续消息将继续写入上面显示的新绑定；如需继续原本的 CLI 对话，请在本机确认 Cursor 会话目录与适配器恢复状态。",
      ].join("\n");
    }
    const nextResume =
      nextRecovery?.kind === "claude-session" ? nextRecovery.resumeSessionId : undefined;
    return [
      "⚠️ 检测到后台 ACP 会话已失效，桥接已自动切换到新的 Claude 会话恢复绑定。",
      `• Session：#${slotIndex}`,
      `• 工作区：\`${workspaceRoot}\``,
      `• 旧 Claude session：\`${previousRecovery.resumeSessionId}\``,
      `• 新 Claude session：${nextResume ? `\`${nextResume}\`` : "（无）"}`,
    ].join("\n");
  }

  private async createSessionWithRecovery(
    backend: AcpBackend,
    cwd: string,
    previousRecovery: SessionRecovery | undefined,
    slotIndex: number,
    noticeKey?: string,
  ): Promise<{ sessionId: string; recovery?: SessionRecovery }> {
    const fresh = await this.runtimeForBackend(backend).newSession(
      cwd,
      previousRecovery ? { recovery: previousRecovery } : undefined,
    );
    if (
      noticeKey &&
      previousRecovery &&
      JSON.stringify(fresh.recovery) !== JSON.stringify(previousRecovery)
    ) {
      this.pushPendingNotice(
        noticeKey,
        this.formatRecoveryChangedNotice(
          slotIndex,
          cwd,
          previousRecovery,
          fresh.recovery,
        ),
      );
    }
    return {
      sessionId: fresh.sessionId,
      recovery: fresh.recovery,
    };
  }

  private async restorePreferredModelIfNeeded(
    slot: SessionSlot,
    noticeKey?: string,
  ): Promise<void> {
    const preferredModelId = slot.session.preferredModelId?.trim();
    if (!preferredModelId || !isCodexBackend(slot.session.backend)) {
      return;
    }
    const runtime = this.runtimeForSlot(slot);
    if (!runtime.supportsSetSessionModel) {
      return;
    }
    const currentModelId =
      runtime.getSessionModelState(slot.session.sessionId)?.currentModelId;
    if (currentModelId === preferredModelId) {
      return;
    }
    try {
      await runtime.setSessionModel(slot.session.sessionId, preferredModelId);
    } catch (error) {
      console.warn(
        `[session] failed to restore preferred model backend=${slot.session.backend} sessionId=${slot.session.sessionId} preferred=${preferredModelId}:`,
        error instanceof Error ? error.message : error,
      );
      if (noticeKey) {
        this.pushPendingNotice(
          noticeKey,
          `⚠️ 已恢复 session #${slot.slotIndex}，但自动恢复模型 \`${preferredModelId}\` 失败。请手动发送 \`/model ${preferredModelId}\` 重试。`,
        );
      }
    }
  }

  private async renewSlotSession(
    slot: SessionSlot,
    cwd: string,
    now: number,
    noticeKey?: string,
    options?: {
      skipLoadSessionProbe?: boolean;
    },
  ): Promise<void> {
    const runtime = this.runtimeForSlot(slot);
    const oldId = slot.session.sessionId;
    if (runtime.supportsLoadSession && !options?.skipLoadSessionProbe) {
      try {
        await runtime.loadSession(oldId, cwd);
        await this.restorePreferredModelIfNeeded(slot, noticeKey);
        slot.session.lastActiveAt = now;
        return;
      } catch {
        // fall through
      }
    }
    const { sessionId, recovery } =
      await this.createSessionWithRecovery(
        slot.session.backend,
        cwd,
        slot.session.recovery,
        slot.slotIndex,
        noticeKey,
      );
    slot.session = {
      ...slot.session,
      sessionId,
      workspaceRoot: cwd,
      lastActiveAt: now,
      ...(recovery ? { recovery } : {}),
    };
    if (!recovery) {
      delete slot.session.recovery;
    }
    await this.restorePreferredModelIfNeeded(slot, noticeKey);
  }

  private async ensureSlotSessionAvailable(
    slot: SessionSlot,
    now: number,
    noticeKey?: string,
  ): Promise<void> {
    const runtime = this.runtimeForSlot(slot);
    if (
      !runtime.supportsLoadSession ||
      runtime.shouldProbeSessionAvailability === false
    ) {
      return;
    }
    const { sessionId, workspaceRoot } = slot.session;
    try {
      await runtime.loadSession(sessionId, workspaceRoot);
    } catch {
      await this.renewSlotSession(slot, workspaceRoot, now, noticeKey, {
        skipLoadSessionProbe: true,
      });
    }
  }

  private async restoreGroupFromStore(
    key: string,
    chatId: string,
    userId: string,
    chatType: "p2p" | "group",
    now: number,
    threadId?: string,
  ): Promise<UserSessionGroup | undefined> {
    const persisted = this.store.get(key);
    if (!persisted) return undefined;

    const tid = persisted.threadId ?? threadId;
    const liveSlots = persisted.slots.filter(
      (s) => !this.isExpiredAt(s.lastActiveAt, now),
    );
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
      const backend = ps.backend ?? this.defaultBackend;
      const runtime = this.runtimeForBackend(backend);

      let sessionId: string;
      let recovery: SessionRecovery | undefined;
      if (runtime.supportsLoadSession) {
        sessionId = ps.sessionId;
        recovery = ps.recovery;
        try {
          await runtime.loadSession(ps.sessionId, cwd);
        } catch {
          const fresh = await this.createSessionWithRecovery(
            backend,
            cwd,
            ps.recovery,
            ps.slotIndex,
            key,
          );
          sessionId = fresh.sessionId;
          recovery = fresh.recovery;
        }
      } else {
        const fresh = await this.createSessionWithRecovery(
          backend,
          cwd,
          ps.recovery,
          ps.slotIndex,
          key,
        );
        sessionId = fresh.sessionId;
        recovery = fresh.recovery;
      }

      const session = this.makeSession(
        backend,
        sessionId,
        cwd,
        chatId,
        userId,
        chatType,
        now,
        recovery,
        tid,
      );
      if (ps.preferredModelId?.trim()) {
        session.preferredModelId = ps.preferredModelId.trim();
      }
      const restoredSlot: SessionSlot = {
        slotIndex: ps.slotIndex,
        name: ps.name,
        session,
      };
      await this.restorePreferredModelIfNeeded(restoredSlot, key);
      restoredSlots.push(restoredSlot);
    }

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
    const sample = group.slots[0]?.session;
    if (!sample) return;

    const slots: PersistedSlotRecord[] = group.slots.map((s) => ({
      slotIndex: s.slotIndex,
      name: s.name,
      backend: s.session.backend,
      sessionId: s.session.sessionId,
      ...(s.session.preferredModelId
        ? { preferredModelId: s.session.preferredModelId }
        : {}),
      ...(s.session.recovery ? { recovery: s.session.recovery } : {}),
      workspaceRoot: s.session.workspaceRoot,
      lastActiveAt: s.session.lastActiveAt,
    }));

    const persistedGroup: PersistedSessionGroup = {
      chatId: sample.chatId,
      userId: sample.userId,
      chatType: sample.chatType,
      ...(sample.threadId ? { threadId: sample.threadId } : {}),
      activeSlotIndex: group.activeSlotIndex,
      nextSlotIndex: group.nextSlotIndex,
      slots,
    };
    this.store.set(key, persistedGroup);
    void this.store.flush().catch((e) => {
      console.error("[session] flush failed:", e);
    });
  }

  private countAliveSlotsForUser(userId: string, now: number): number {
    let n = 0;
    for (const key of this.store.allKeys()) {
      const g = this.store.get(key);
      if (!g || g.userId !== userId) continue;
      for (const ps of g.slots) {
        if (!this.isExpiredAt(ps.lastActiveAt, now)) n++;
      }
    }
    return n;
  }

  private assertCanAddUserSession(userId: string, now: number): void {
    if (this.maxSessionsPerUser <= 0) return;
    const n = this.countAliveSlotsForUser(userId, now);
    if (n >= this.maxSessionsPerUser) {
      throw new Error(
        `已达到同一用户最多 ${this.maxSessionsPerUser} 个存活 session 的上限，请先在其它会话中执行 /close 或等待空闲过期后再试。`,
      );
    }
  }

  private makeKey(
    chatId: string,
    userId: string,
    chatType: string,
    threadId?: string,
  ): string {
    if (this.chatType(chatType) === "p2p") return `dm:${userId}`;
    const t = threadId?.trim();
    if (t) return `${chatId}:t:${t}:${userId}`;
    return `${chatId}:${userId}`;
  }

  private chatType(t: string): "p2p" | "group" {
    return t === "group" ? "group" : "p2p";
  }

  private isExpiredAt(lastActiveAt: number, now: number): boolean {
    if (!Number.isFinite(this.idleMs)) {
      return false;
    }
    return now - lastActiveAt >= this.idleMs;
  }

  private getIdleExpiresInMs(lastActiveAt: number, now: number): number | null {
    if (!Number.isFinite(this.idleMs)) {
      return null;
    }
    return Math.max(0, this.idleMs - (now - lastActiveAt));
  }
}
