import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PersistedTmuxAcpSessionRecord {
  sessionId: string;
  paneId: string;
  tmuxSessionName: string;
  cursorCliChatId?: string;
  workspaceRoot: string;
  startCommand: string;
  createdAt: number;
  lastActiveAt: number;
  title?: string;
  currentModeId?: string;
  currentModelId?: string;
}

interface StoreFileV1 {
  version: 1;
  sessions: Record<string, PersistedTmuxAcpSessionRecord>;
}

export class TmuxAcpSessionStore {
  private readonly filePath: string;
  private data: StoreFileV1;
  private flushSeq = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = {
      version: 1,
      sessions: {},
    };
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

  get(sessionId: string): PersistedTmuxAcpSessionRecord | undefined {
    return this.data.sessions[sessionId];
  }

  set(record: PersistedTmuxAcpSessionRecord): void {
    this.data.sessions[record.sessionId] = record;
  }

  delete(sessionId: string): void {
    delete this.data.sessions[sessionId];
  }

  list(): PersistedTmuxAcpSessionRecord[] {
    return Object.values(this.data.sessions);
  }

  async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.flushSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
