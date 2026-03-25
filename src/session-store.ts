import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PersistedSessionRecord {
  sessionId: string;
  chatId: string;
  userId: string;
  chatType: "p2p" | "group";
  lastActiveAt: number;
  /** ACP session/new 与读文件沙箱使用的绝对路径；旧数据缺省则按 CURSOR_WORK_DIR */
  workspaceRoot?: string;
}

interface StoreFileV1 {
  version: 1;
  sessions: Record<string, PersistedSessionRecord>;
}

/**
 * 将飞书 sessionKey → ACP sessionId 持久化到磁盘，便于进程重启后 session/load。
 */
export class SessionStore {
  private readonly filePath: string;
  private data: StoreFileV1;

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
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 1, sessions: {} };
        return;
      }
      throw e;
    }
  }

  get(key: string): PersistedSessionRecord | undefined {
    return this.data.sessions[key];
  }

  set(record: PersistedSessionRecord & { key: string }): void {
    const { key, ...rest } = record;
    this.data.sessions[key] = rest;
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
