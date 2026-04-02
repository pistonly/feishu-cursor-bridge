import * as path from "node:path";
import {
  TmuxSlotStore,
  type PersistedTmuxSessionGroup,
  type PersistedTmuxSlotRecord,
} from "./tmux-slot-store.js";

export interface TmuxBindingDescriptor {
  paneId: string;
  tmuxSessionName: string;
  cursorCliChatId?: string;
  workspaceRoot: string;
  startCommand: string;
}

export interface TmuxSlotIdentity {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  threadId?: string;
}

export interface CreateTmuxSlotInput extends TmuxSlotIdentity {
  binding: TmuxBindingDescriptor;
  name?: string;
}

export interface SlotListItem {
  slotIndex: number;
  name?: string;
  paneId: string;
  tmuxSessionName: string;
  workspaceRoot: string;
  lastActiveAt: number;
  isActive: boolean;
}

export interface ProbeTmuxBindingResult {
  exists: boolean;
  hasCursorAgentUi: boolean;
  reason?: string;
}

export interface RestoreActiveSlotOptions {
  probeBinding: (binding: TmuxBindingDescriptor) => Promise<ProbeTmuxBindingResult>;
  rebuildBinding: (stale: PersistedTmuxSlotRecord) => Promise<TmuxBindingDescriptor>;
}

export interface RestoreActiveSlotResult {
  slot: PersistedTmuxSlotRecord;
  rebuilt: boolean;
  previousPaneId?: string;
  reason?: string;
}

export class TmuxSlotRegistry {
  private readonly store: TmuxSlotStore;

  constructor(store: TmuxSlotStore) {
    this.store = store;
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  makeKey(identity: TmuxSlotIdentity): string {
    if (identity.chatType === "p2p") {
      return `dm:${identity.userId}`;
    }
    const t = identity.threadId?.trim();
    if (t) {
      return `${identity.chatId}:t:${t}:${identity.userId}`;
    }
    return `${identity.chatId}:${identity.userId}`;
  }

  getGroup(identity: TmuxSlotIdentity): PersistedTmuxSessionGroup | undefined {
    return this.store.get(this.makeKey(identity));
  }

  async createSlot(input: CreateTmuxSlotInput): Promise<PersistedTmuxSlotRecord> {
    const key = this.makeKey(input);
    const now = Date.now();
    const group = this.store.get(key);
    const binding = this.toPersistedSlot(
      group?.nextSlotIndex ?? 1,
      input.binding,
      now,
      input.name,
    );

    let nextGroup: PersistedTmuxSessionGroup;
    if (!group) {
      nextGroup = {
        chatId: input.chatId,
        userId: input.userId,
        chatType: input.chatType,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        activeSlotIndex: binding.slotIndex,
        nextSlotIndex: binding.slotIndex + 1,
        slots: [binding],
      };
    } else {
      nextGroup = {
        ...group,
        activeSlotIndex: binding.slotIndex,
        nextSlotIndex: binding.slotIndex + 1,
        slots: [...group.slots, binding],
      };
    }

    this.store.set(key, nextGroup);
    await this.store.flush();
    return binding;
  }

  async bindActiveSlot(
    identity: TmuxSlotIdentity,
    binding: TmuxBindingDescriptor,
  ): Promise<PersistedTmuxSlotRecord> {
    const key = this.makeKey(identity);
    const now = Date.now();
    const group = this.store.get(key);
    if (!group) {
      const created = this.toPersistedSlot(1, binding, now);
      this.store.set(key, {
        chatId: identity.chatId,
        userId: identity.userId,
        chatType: identity.chatType,
        ...(identity.threadId ? { threadId: identity.threadId } : {}),
        activeSlotIndex: 1,
        nextSlotIndex: 2,
        slots: [created],
      });
      await this.store.flush();
      return created;
    }

    const active = group.slots.find((slot) => slot.slotIndex === group.activeSlotIndex);
    if (!active) {
      const created = this.toPersistedSlot(group.nextSlotIndex, binding, now);
      group.slots.push(created);
      group.activeSlotIndex = created.slotIndex;
      group.nextSlotIndex = created.slotIndex + 1;
      this.store.set(key, group);
      await this.store.flush();
      return created;
    }

    active.paneId = binding.paneId;
    active.tmuxSessionName = binding.tmuxSessionName;
    active.cursorCliChatId = binding.cursorCliChatId;
    active.workspaceRoot = path.resolve(binding.workspaceRoot);
    active.startCommand = binding.startCommand;
    active.lastActiveAt = now;
    this.store.set(key, group);
    await this.store.flush();
    return active;
  }

  async switchActiveSlot(
    identity: TmuxSlotIdentity,
    slotIndex: number,
  ): Promise<PersistedTmuxSlotRecord> {
    const key = this.makeKey(identity);
    const group = this.store.get(key);
    if (!group) {
      throw new Error("No persisted tmux slots for this identity.");
    }
    const slot = group.slots.find((item) => item.slotIndex === slotIndex);
    if (!slot) {
      throw new Error(`Cannot find tmux slot #${slotIndex}.`);
    }
    slot.lastActiveAt = Date.now();
    group.activeSlotIndex = slotIndex;
    this.store.set(key, group);
    await this.store.flush();
    return slot;
  }

  async touchActiveSlot(identity: TmuxSlotIdentity): Promise<void> {
    const group = this.getGroup(identity);
    if (!group) return;
    const active = group.slots.find((slot) => slot.slotIndex === group.activeSlotIndex);
    if (!active) return;
    active.lastActiveAt = Date.now();
    this.store.set(this.makeKey(identity), group);
    await this.store.flush();
  }

  listSlots(identity: TmuxSlotIdentity): SlotListItem[] {
    const group = this.getGroup(identity);
    if (!group) return [];
    return [...group.slots]
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((slot) => ({
        slotIndex: slot.slotIndex,
        name: slot.name,
        paneId: slot.paneId,
        tmuxSessionName: slot.tmuxSessionName,
        workspaceRoot: slot.workspaceRoot,
        lastActiveAt: slot.lastActiveAt,
        isActive: slot.slotIndex === group.activeSlotIndex,
      }));
  }

  getActiveSlot(identity: TmuxSlotIdentity): PersistedTmuxSlotRecord | undefined {
    const group = this.getGroup(identity);
    if (!group) return undefined;
    return group.slots.find((slot) => slot.slotIndex === group.activeSlotIndex);
  }

  async restoreActiveSlot(
    identity: TmuxSlotIdentity,
    options: RestoreActiveSlotOptions,
  ): Promise<RestoreActiveSlotResult> {
    const key = this.makeKey(identity);
    const group = this.store.get(key);
    if (!group) {
      throw new Error("No persisted tmux slots for this identity.");
    }
    const active = group.slots.find((slot) => slot.slotIndex === group.activeSlotIndex);
    if (!active) {
      throw new Error("Persisted tmux group has no active slot.");
    }

    const probe = await options.probeBinding(this.toBindingDescriptor(active));
    if (probe.exists) {
      active.lastActiveAt = Date.now();
      this.store.set(key, group);
      await this.store.flush();
      return { slot: active, rebuilt: false };
    }

    const previousPaneId = active.paneId;
    const rebuilt = await options.rebuildBinding(active);
    active.paneId = rebuilt.paneId;
    active.tmuxSessionName = rebuilt.tmuxSessionName;
    active.cursorCliChatId = rebuilt.cursorCliChatId;
    active.workspaceRoot = path.resolve(rebuilt.workspaceRoot);
    active.startCommand = rebuilt.startCommand;
    active.lastActiveAt = Date.now();
    this.store.set(key, group);
    await this.store.flush();
    return {
      slot: active,
      rebuilt: true,
      previousPaneId,
      reason: probe.reason,
    };
  }

  private toPersistedSlot(
    slotIndex: number,
    binding: TmuxBindingDescriptor,
    now: number,
    name?: string,
  ): PersistedTmuxSlotRecord {
    return {
      slotIndex,
      ...(name ? { name } : {}),
      paneId: binding.paneId,
      tmuxSessionName: binding.tmuxSessionName,
      ...(binding.cursorCliChatId ? { cursorCliChatId: binding.cursorCliChatId } : {}),
      workspaceRoot: path.resolve(binding.workspaceRoot),
      startCommand: binding.startCommand,
      lastActiveAt: now,
    };
  }

  private toBindingDescriptor(slot: PersistedTmuxSlotRecord): TmuxBindingDescriptor {
    return {
      paneId: slot.paneId,
      tmuxSessionName: slot.tmuxSessionName,
      ...(slot.cursorCliChatId ? { cursorCliChatId: slot.cursorCliChatId } : {}),
      workspaceRoot: slot.workspaceRoot,
      startCommand: slot.startCommand,
    };
  }
}
