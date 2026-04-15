import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AcpBackend, SessionRecovery } from "../acp/runtime-contract.js";

export interface PersistedSlotRecord {
  slotIndex: number;
  name?: string;
  backend: AcpBackend;
  sessionId: string;
  preferredModelId?: string;
  recovery?: SessionRecovery;
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

const BACKEND_ALIASES: Record<string, AcpBackend> = {
  official: "cursor-official",
  legacy: "cursor-legacy",
  tmux: "cursor-tmux",
  "cursor-official": "cursor-official",
  "cursor-legacy": "cursor-legacy",
  "cursor-tmux": "cursor-tmux",
  claude: "claude",
  codex: "codex",
};

function normalizeBackend(
  backend: string | undefined,
  defaultBackend: AcpBackend,
): AcpBackend {
  if (!backend) return defaultBackend;
  return BACKEND_ALIASES[backend] ?? defaultBackend;
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

export class SessionStore {
  private readonly filePath: string;
  private readonly defaultBackend: AcpBackend;
  private data: StoreFileV3;
  private flushSeq = 0;

  constructor(filePath: string, defaultBackend: AcpBackend = "cursor-official") {
    this.filePath = path.resolve(filePath);
    this.defaultBackend = defaultBackend;
    this.data = { version: 3, sessions: {} };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFileV1 | StoreFileV2 | StoreFileV3;

      if (parsed?.version === 3) {
        const v3 = parsed as StoreFileV3;
        if (v3.sessions && typeof v3.sessions === "object") {
          this.data = migrateV3ToLatest(v3, this.defaultBackend);
        }
      } else if (parsed?.version === 2) {
        this.data = migrateV2ToV3(parsed as StoreFileV2, this.defaultBackend);
      } else if (parsed?.version === 1) {
        this.data = migrateV1ToV3(parsed as StoreFileV1, this.defaultBackend);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 3, sessions: {} };
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
        };
      }),
    };
  }
  return { version: 3, sessions };
}
