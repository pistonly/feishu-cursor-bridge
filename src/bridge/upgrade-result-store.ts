import * as fs from "node:fs/promises";
import * as path from "node:path";

export type UpgradeAttemptState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface UpgradeRequestedBy {
  chatId: string;
  messageId: string;
  senderId: string;
  chatType: "p2p" | "group";
  threadId?: string;
}

export interface UpgradeAttemptRecord {
  id: string;
  state: UpgradeAttemptState;
  requestedAt: number;
  startedAt?: number;
  finishedAt?: number;
  requestedBy?: UpgradeRequestedBy;
  runnerPid?: number;
  exitCode?: number;
  signal?: string;
  errorMessage?: string;
  outputTail?: string;
}

interface UpgradeResultFileV1 {
  version: 1;
  attempt?: UpgradeAttemptRecord;
}

const MAX_OUTPUT_TAIL_CHARS = 4_000;

export function truncateOutputTail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_OUTPUT_TAIL_CHARS) return trimmed;
  return trimmed.slice(-MAX_OUTPUT_TAIL_CHARS);
}

export class UpgradeResultStore {
  private readonly filePath: string;
  private data: UpgradeResultFileV1;
  private flushSeq = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = { version: 1 };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as UpgradeResultFileV1;
      if (parsed?.version === 1) {
        this.data = parsed;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 1 };
        return;
      }
      throw e;
    }
  }

  getAttempt(): UpgradeAttemptRecord | undefined {
    return this.data.attempt;
  }

  setAttempt(attempt: UpgradeAttemptRecord): void {
    this.data.attempt = attempt;
  }

  async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.flushSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
