import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PersistedTmuxSlotRecord {
  slotIndex: number;
  name?: string;
  paneId: string;
  tmuxSessionName: string;
  cursorCliChatId?: string;
  workspaceRoot: string;
  startCommand: string;
  lastActiveAt: number;
  lastKnownWindowTitle?: string;
}

export interface PersistedTmuxSessionGroup {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  activeSlotIndex: number;
  nextSlotIndex: number;
  slots: PersistedTmuxSlotRecord[];
}

interface StoreFileV1 {
  version: 1;
  sessions: Record<string, PersistedTmuxSessionGroup>;
}

export class TmuxSlotStore {
  private readonly filePath: string;
  private data: StoreFileV1;
  private flushSeq = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = { version: 1, sessions: {} };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFileV1;
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        this.data = parsed;
        return;
      }
      this.data = { version: 1, sessions: {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 1, sessions: {} };
        return;
      }
      throw error;
    }
  }

  get(key: string): PersistedTmuxSessionGroup | undefined {
    return this.data.sessions[key];
  }

  set(key: string, group: PersistedTmuxSessionGroup): void {
    this.data.sessions[key] = group;
  }

  delete(key: string): void {
    delete this.data.sessions[key];
  }

  allKeys(): string[] {
    return Object.keys(this.data.sessions);
  }

  async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.flushSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
