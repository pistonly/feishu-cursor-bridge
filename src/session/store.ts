import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AcpBackend, SessionRecovery } from "../acp/runtime-contract.js";

export interface PersistedSessionTurnRecord {
  startedAt: number;
  finishedAt: number;
  prompt: string;
  status: "succeeded" | "error";
  reply?: string;
  error?: string;
}

export interface PersistedSlotRecord {
  slotIndex: number;
  name?: string;
  backend: AcpBackend;
  sessionId: string;
  preferredModelId?: string;
  recovery?: SessionRecovery;
  history?: PersistedSessionTurnRecord[];
  /** 兼容旧版 legacy store */
  cursorCliChatId?: string;
  workspaceRoot?: string;
  lastActiveAt: number;
}

export interface PersistedSessionGroup {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  activeSlotIndex: number;
  nextSlotIndex: number;
  slots: PersistedSlotRecord[];
}

export interface PersistedResumeHistoryEntry {
  backend: AcpBackend;
  sessionId: string;
  preferredModelId?: string;
  recovery?: SessionRecovery;
  workspaceRoot: string;
  lastActiveAt: number;
  label?: string;
}

interface PersistedSessionRecordV1 {
  sessionId: string;
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  lastActiveAt: number;
  workspaceRoot?: string;
}

interface StoreFileV1 {
  version: 1;
  sessions: Record<string, PersistedSessionRecordV1>;
}

interface PersistedSlotRecordV2 {
  slotIndex: number;
  name?: string;
  sessionId: string;
  cursorCliChatId?: string;
  workspaceRoot?: string;
  lastActiveAt: number;
}

interface PersistedSessionGroupV2 {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  activeSlotIndex: number;
  nextSlotIndex: number;
  slots: PersistedSlotRecordV2[];
}

interface StoreFileV2 {
  version: 2;
  sessions: Record<string, PersistedSessionGroupV2>;
}

interface StoreFileV3 {
  version: 3;
  sessions: Record<string, PersistedSessionGroup>;
}

interface StoreFileV4 {
  version: 4;
  sessions: Record<string, PersistedSessionGroup>;
  resumeHistory: Record<string, PersistedResumeHistoryEntry[]>;
}

const BACKEND_ALIASES: Record<string, AcpBackend> = {
  official: "cursor-official",
  legacy: "cursor-legacy",
  "cursor-official": "cursor-official",
  "cursor-legacy": "cursor-legacy",
  claude: "claude",
  codex: "codex",
};

function normalizeBackend(
  backend: string | undefined,
  defaultBackend: AcpBackend,
): AcpBackend {
  if (!backend) return defaultBackend;
  const normalized = backend.trim().toLowerCase();
  if (normalized === "tmux" || normalized === "cursor-tmux") {
    return defaultBackend;
  }
  return BACKEND_ALIASES[normalized] ?? defaultBackend;
}

function normalizeRecovery(
  backend: AcpBackend,
  recovery: SessionRecovery | undefined,
  cursorCliChatId: string | undefined,
  sessionId: string,
): SessionRecovery | undefined {
  if (recovery) return recovery;
  if (cursorCliChatId?.trim()) {
    return {
      kind: "cursor-cli",
      cursorCliChatId: cursorCliChatId.trim(),
    };
  }
  if (backend === "claude" && sessionId.trim()) {
    return {
      kind: "claude-session",
      resumeSessionId: sessionId.trim(),
    };
  }
  return undefined;
}

function normalizeWorkspaceRoot(workspaceRoot: string | undefined): string | undefined {
  const trimmed = workspaceRoot?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function normalizeTurnText(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : undefined;
}

function normalizeSessionTurnRecord(
  entry: PersistedSessionTurnRecord,
): PersistedSessionTurnRecord | undefined {
  const prompt = normalizeTurnText(entry.prompt) ?? "（空）";
  const status = entry.status === "error" ? "error" : "succeeded";
  const reply = normalizeTurnText(entry.reply);
  const error = normalizeTurnText(entry.error);
  const startedAt =
    Number.isFinite(entry.startedAt) && entry.startedAt > 0
      ? entry.startedAt
      : Date.now();
  const finishedAt =
    Number.isFinite(entry.finishedAt) && entry.finishedAt >= startedAt
      ? entry.finishedAt
      : startedAt;
  return {
    startedAt,
    finishedAt,
    prompt,
    status,
    ...(reply ? { reply } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeSessionTurnHistory(
  entries: PersistedSessionTurnRecord[] | undefined,
  maxEntries = 20,
): PersistedSessionTurnRecord[] | undefined {
  const normalized = (entries ?? [])
    .map((entry) => normalizeSessionTurnRecord(entry))
    .filter((entry): entry is PersistedSessionTurnRecord => entry != null)
    .slice(-maxEntries);
  return normalized.length > 0 ? normalized : undefined;
}

function mergeResumeHistoryEntry(
  current: PersistedResumeHistoryEntry,
  next: PersistedResumeHistoryEntry,
): PersistedResumeHistoryEntry {
  return {
    backend: next.backend,
    sessionId: next.sessionId,
    workspaceRoot: next.workspaceRoot,
    lastActiveAt: Math.max(current.lastActiveAt, next.lastActiveAt),
    ...(current.preferredModelId || next.preferredModelId
      ? { preferredModelId: next.preferredModelId ?? current.preferredModelId }
      : {}),
    ...(current.recovery || next.recovery
      ? { recovery: next.recovery ?? current.recovery }
      : {}),
    ...(current.label || next.label
      ? { label: next.label ?? current.label }
      : {}),
  };
}

function normalizeResumeHistoryEntry(
  entry: PersistedResumeHistoryEntry,
  defaultBackend: AcpBackend,
): PersistedResumeHistoryEntry | undefined {
  const workspaceRoot = normalizeWorkspaceRoot(entry.workspaceRoot);
  if (!workspaceRoot) return undefined;
  const backend = normalizeBackend(entry.backend, defaultBackend);
  const sessionId = entry.sessionId?.trim();
  if (!sessionId) return undefined;
  const preferredModelId = entry.preferredModelId?.trim();
  const label = entry.label?.trim();
  return {
    backend,
    sessionId,
    ...(preferredModelId ? { preferredModelId } : {}),
    ...(normalizeRecovery(backend, entry.recovery, undefined, sessionId)
      ? { recovery: normalizeRecovery(backend, entry.recovery, undefined, sessionId) }
      : {}),
    workspaceRoot,
    lastActiveAt:
      Number.isFinite(entry.lastActiveAt) && entry.lastActiveAt > 0
        ? entry.lastActiveAt
        : Date.now(),
    ...(label ? { label } : {}),
  };
}

function normalizeResumeHistoryEntries(
  entries: PersistedResumeHistoryEntry[],
  defaultBackend: AcpBackend,
  maxEntries = 10,
): PersistedResumeHistoryEntry[] {
  const merged = new Map<string, PersistedResumeHistoryEntry>();
  for (const entry of entries) {
    const normalized = normalizeResumeHistoryEntry(entry, defaultBackend);
    if (!normalized) continue;
    const key = `${normalized.backend}\u0000${normalized.sessionId}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing ? mergeResumeHistoryEntry(existing, normalized) : normalized,
    );
  }
  return [...merged.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, maxEntries);
}

function seedResumeHistoryFromSessions(
  sessions: Record<string, PersistedSessionGroup>,
  defaultBackend: AcpBackend,
): Record<string, PersistedResumeHistoryEntry[]> {
  const seeded = new Map<string, PersistedResumeHistoryEntry[]>();
  for (const group of Object.values(sessions)) {
    for (const slot of group.slots) {
      const workspaceRoot = normalizeWorkspaceRoot(slot.workspaceRoot);
      if (!workspaceRoot) continue;
      const entries = seeded.get(workspaceRoot) ?? [];
      entries.push({
        backend: normalizeBackend(slot.backend, defaultBackend),
        sessionId: slot.sessionId,
        ...(slot.preferredModelId?.trim()
          ? { preferredModelId: slot.preferredModelId.trim() }
          : {}),
        ...(normalizeRecovery(
          normalizeBackend(slot.backend, defaultBackend),
          slot.recovery,
          slot.cursorCliChatId,
          slot.sessionId,
        )
          ? {
              recovery: normalizeRecovery(
                normalizeBackend(slot.backend, defaultBackend),
                slot.recovery,
                slot.cursorCliChatId,
                slot.sessionId,
              ),
            }
          : {}),
        workspaceRoot,
        lastActiveAt: slot.lastActiveAt,
      });
      seeded.set(workspaceRoot, entries);
    }
  }

  const resumeHistory: Record<string, PersistedResumeHistoryEntry[]> = {};
  for (const [workspaceRoot, entries] of seeded.entries()) {
    resumeHistory[workspaceRoot] = normalizeResumeHistoryEntries(
      entries,
      defaultBackend,
    );
  }
  return resumeHistory;
}

function normalizeResumeHistoryMap(
  resumeHistory: Record<string, PersistedResumeHistoryEntry[]> | undefined,
  defaultBackend: AcpBackend,
): Record<string, PersistedResumeHistoryEntry[]> {
  const merged = new Map<string, PersistedResumeHistoryEntry[]>();
  for (const [rawWorkspaceRoot, rawEntries] of Object.entries(resumeHistory ?? {})) {
    const workspaceRoot = normalizeWorkspaceRoot(rawWorkspaceRoot);
    if (!workspaceRoot) continue;
    const entries = merged.get(workspaceRoot) ?? [];
    entries.push(
      ...rawEntries.map((entry) => ({
        ...entry,
        workspaceRoot,
      })),
    );
    merged.set(workspaceRoot, entries);
  }

  const normalized: Record<string, PersistedResumeHistoryEntry[]> = {};
  for (const [workspaceRoot, entries] of merged.entries()) {
    normalized[workspaceRoot] = normalizeResumeHistoryEntries(
      entries,
      defaultBackend,
    );
  }
  return normalized;
}

export class SessionStore {
  private readonly filePath: string;
  private readonly defaultBackend: AcpBackend;
  private data: StoreFileV4;
  private flushSeq = 0;

  constructor(filePath: string, defaultBackend: AcpBackend = "cursor-official") {
    this.filePath = path.resolve(filePath);
    this.defaultBackend = defaultBackend;
    this.data = { version: 4, sessions: {}, resumeHistory: {} };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFileV1 | StoreFileV2 | StoreFileV3 | StoreFileV4;

      if (parsed?.version === 4) {
        const v4 = parsed as StoreFileV4;
        if (v4.sessions && typeof v4.sessions === "object") {
          this.data = migrateV4ToLatest(v4, this.defaultBackend);
        }
      } else if (parsed?.version === 3) {
        const v3 = parsed as StoreFileV3;
        if (v3.sessions && typeof v3.sessions === "object") {
          this.data = migrateV3ToV4(v3, this.defaultBackend);
        }
      } else if (parsed?.version === 2) {
        this.data = migrateV2ToV4(parsed as StoreFileV2, this.defaultBackend);
      } else if (parsed?.version === 1) {
        this.data = migrateV1ToV4(parsed as StoreFileV1, this.defaultBackend);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 4, sessions: {}, resumeHistory: {} };
        return;
      }
      throw e;
    }
  }

  get(key: string): PersistedSessionGroup | undefined {
    return this.data.sessions[key];
  }

  set(key: string, group: PersistedSessionGroup): void {
    this.data.sessions[key] = group;
  }

  delete(key: string): void {
    delete this.data.sessions[key];
  }

  getResumeHistory(workspaceRoot: string): PersistedResumeHistoryEntry[] {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    if (!key) return [];
    return [...(this.data.resumeHistory[key] ?? [])];
  }

  setResumeHistory(
    workspaceRoot: string,
    entries: PersistedResumeHistoryEntry[],
  ): void {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    if (!key) return;
    this.data.resumeHistory[key] = normalizeResumeHistoryEntries(
      entries,
      this.defaultBackend,
    );
  }

  deleteResumeHistory(workspaceRoot: string): void {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    if (!key) return;
    delete this.data.resumeHistory[key];
  }

  async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.flushSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  allKeys(): string[] {
    return Object.keys(this.data.sessions);
  }
}

function migrateV1ToV4(v1: StoreFileV1, defaultBackend: AcpBackend): StoreFileV4 {
  return migrateV3ToV4(migrateV1ToV3(v1, defaultBackend), defaultBackend);
}

function migrateV2ToV4(v2: StoreFileV2, defaultBackend: AcpBackend): StoreFileV4 {
  return migrateV3ToV4(migrateV2ToV3(v2, defaultBackend), defaultBackend);
}

function migrateV3ToV4(v3: StoreFileV3, defaultBackend: AcpBackend): StoreFileV4 {
  const latestV3 = migrateV3ToLatest(v3, defaultBackend);
  return {
    version: 4,
    sessions: latestV3.sessions,
    resumeHistory: seedResumeHistoryFromSessions(latestV3.sessions, defaultBackend),
  };
}

function migrateV4ToLatest(v4: StoreFileV4, defaultBackend: AcpBackend): StoreFileV4 {
  const latestV3 = migrateV3ToLatest(
    { version: 3, sessions: v4.sessions },
    defaultBackend,
  );
  const seeded = seedResumeHistoryFromSessions(latestV3.sessions, defaultBackend);
  const explicit = normalizeResumeHistoryMap(v4.resumeHistory, defaultBackend);
  const merged = new Map<string, PersistedResumeHistoryEntry[]>();

  for (const [workspaceRoot, entries] of Object.entries(seeded)) {
    merged.set(workspaceRoot, [...entries]);
  }
  for (const [workspaceRoot, entries] of Object.entries(explicit)) {
    const current = merged.get(workspaceRoot) ?? [];
    merged.set(
      workspaceRoot,
      normalizeResumeHistoryEntries([...current, ...entries], defaultBackend),
    );
  }

  const resumeHistory: Record<string, PersistedResumeHistoryEntry[]> = {};
  for (const [workspaceRoot, entries] of merged.entries()) {
    resumeHistory[workspaceRoot] = normalizeResumeHistoryEntries(
      entries,
      defaultBackend,
    );
  }

  return {
    version: 4,
    sessions: latestV3.sessions,
    resumeHistory,
  };
}

function migrateV1ToV3(v1: StoreFileV1, defaultBackend: AcpBackend): StoreFileV3 {
  const v3Sessions: Record<string, PersistedSessionGroup> = {};
  for (const [key, rec] of Object.entries(v1.sessions)) {
    v3Sessions[key] = {
      chatId: rec.chatId,
      userId: rec.userId,
      chatType: rec.chatType,
      activeSlotIndex: 1,
      nextSlotIndex: 2,
      slots: [
        {
          slotIndex: 1,
          backend: defaultBackend,
          sessionId: rec.sessionId,
          recovery: normalizeRecovery(defaultBackend, undefined, undefined, rec.sessionId),
          workspaceRoot: rec.workspaceRoot,
          lastActiveAt: rec.lastActiveAt,
        },
      ],
    };
  }
  return { version: 3, sessions: v3Sessions };
}

function migrateV2ToV3(v2: StoreFileV2, defaultBackend: AcpBackend): StoreFileV3 {
  const sessions: Record<string, PersistedSessionGroup> = {};
  for (const [key, group] of Object.entries(v2.sessions)) {
    sessions[key] = {
      ...group,
      slots: group.slots.map((slot) => ({
        ...slot,
        backend: normalizeBackend(undefined, defaultBackend),
        recovery: normalizeRecovery(defaultBackend, undefined, slot.cursorCliChatId, slot.sessionId),
      })),
    };
  }
  return { version: 3, sessions };
}

function migrateV3ToLatest(v3: StoreFileV3, defaultBackend: AcpBackend): StoreFileV3 {
  const sessions: Record<string, PersistedSessionGroup> = {};
  for (const [key, group] of Object.entries(v3.sessions)) {
    sessions[key] = {
      ...group,
      slots: group.slots.map((slot) => {
        const backend = normalizeBackend(slot.backend, defaultBackend);
        return {
          ...slot,
          backend,
          preferredModelId:
            typeof slot.preferredModelId === "string" && slot.preferredModelId.trim()
              ? slot.preferredModelId.trim()
              : undefined,
          recovery: normalizeRecovery(backend, slot.recovery, slot.cursorCliChatId, slot.sessionId),
          history: normalizeSessionTurnHistory(slot.history),
          workspaceRoot: normalizeWorkspaceRoot(slot.workspaceRoot),
        };
      }),
    };
  }
  return { version: 3, sessions };
}
