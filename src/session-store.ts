import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// v2 Persisted types
// ---------------------------------------------------------------------------

export interface PersistedSlotRecord {
  slotIndex: number;
  name?: string;
  sessionId: string;
  /** 与 cursor-agent CLI `--resume` 对齐的 chat id */
  cursorCliChatId?: string;
  workspaceRoot?: string;
  lastActiveAt: number;
}

export interface PersistedSessionGroup {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  /** 话题群 thread_id，与内存 sessionKey 的话题维度一致 */
  threadId?: string;
  activeSlotIndex: number;
  /** monotonically increasing counter for next slot number */
  nextSlotIndex: number;
  slots: PersistedSlotRecord[];
}

// ---------------------------------------------------------------------------
// Legacy v1 (kept for migration only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// v2 store file
// ---------------------------------------------------------------------------

interface StoreFileV2 {
  version: 2;
  sessions: Record<string, PersistedSessionGroup>;
}

/**
 * 将飞书 sessionKey → ACP session 组（多 slot）持久化到磁盘，便于进程重启后 session/load。
 * 支持从 v1（单 session）自动迁移到 v2（多 slot）。
 */
export class SessionStore {
  private readonly filePath: string;
  private data: StoreFileV2;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = { version: 2, sessions: {} };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFileV1 | StoreFileV2;

      if (parsed?.version === 2) {
        const v2 = parsed as StoreFileV2;
        if (v2.sessions && typeof v2.sessions === "object") {
          this.data = v2;
        }
      } else if (parsed?.version === 1) {
        this.data = migrateV1ToV2(parsed as StoreFileV1);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 2, sessions: {} };
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
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  allKeys(): string[] {
    return Object.keys(this.data.sessions);
  }
}

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

function migrateV1ToV2(v1: StoreFileV1): StoreFileV2 {
  const v2Sessions: Record<string, PersistedSessionGroup> = {};
  for (const [key, rec] of Object.entries(v1.sessions)) {
    v2Sessions[key] = {
      chatId: rec.chatId,
      userId: rec.userId,
      chatType: rec.chatType,
      activeSlotIndex: 1,
      nextSlotIndex: 2,
      slots: [
        {
          slotIndex: 1,
          sessionId: rec.sessionId,
          workspaceRoot: rec.workspaceRoot,
          lastActiveAt: rec.lastActiveAt,
        },
      ],
    };
  }
  return { version: 2, sessions: v2Sessions };
}
