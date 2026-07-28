import * as path from "node:path";
import { atomicWriteJson, readJsonFileWithDefault } from "../utils/json-store.js";

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
  /** Whether the result has been notified to the requesting user via Feishu. */
  notified?: boolean;
}

interface UpgradeResultFileV1 {
  version: 1;
  attempt?: UpgradeAttemptRecord;
}

interface UpgradeResultFileV2 {
  version: 2;
  attempts: UpgradeAttemptRecord[];
}

const MAX_OUTPUT_TAIL_CHARS = 4_000;
const MAX_HISTORY_ENTRIES = 20;

export function appendOutputTail(
  current: string | undefined,
  chunk: string | undefined,
): string | undefined {
  if (!chunk) return current;
  const merged = `${current ?? ""}${chunk}`;
  if (merged.length <= MAX_OUTPUT_TAIL_CHARS) return merged;
  return merged.slice(-MAX_OUTPUT_TAIL_CHARS);
}

export function truncateOutputTail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_OUTPUT_TAIL_CHARS) return trimmed;
  return trimmed.slice(-MAX_OUTPUT_TAIL_CHARS);
}

export class UpgradeResultStore {
  private readonly filePath: string;
  private data: UpgradeResultFileV2;
  private flushSeq = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = { version: 2, attempts: [] };
  }

  async load(): Promise<void> {
    const parsed = await readJsonFileWithDefault<{ version?: number; attempt?: UpgradeAttemptRecord; attempts?: UpgradeAttemptRecord[] } | null>(
      this.filePath,
      null,
    );
    if (parsed?.version === 2) {
      this.data = {
        version: 2,
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      };
    } else if (parsed?.version === 1) {
      // Migrate V1 (single attempt) to V2 (array)
      const attempts: UpgradeAttemptRecord[] = [];
      if (parsed.attempt) {
        attempts.push(parsed.attempt);
      }
      this.data = { version: 2, attempts };
    }
  }

  /** Returns the most recent attempt, or undefined if none exists. */
  getAttempt(): UpgradeAttemptRecord | undefined {
    return this.data.attempts[0];
  }

  /**
   * Insert or update an attempt by ID.
   * If the ID already exists, the record is updated in place.
   * If it is a new ID, it is prepended to the history list
   * (keeping at most MAX_HISTORY_ENTRIES entries).
   */
  setAttempt(attempt: UpgradeAttemptRecord): void {
    const idx = this.data.attempts.findIndex((a) => a.id === attempt.id);
    if (idx >= 0) {
      this.data.attempts[idx] = attempt;
    } else {
      this.data.attempts.unshift(attempt);
      if (this.data.attempts.length > MAX_HISTORY_ENTRIES) {
        this.data.attempts = this.data.attempts.slice(0, MAX_HISTORY_ENTRIES);
      }
    }
  }

  /** Returns all historical attempts (most recent first). */
  getHistory(): UpgradeAttemptRecord[] {
    return [...this.data.attempts];
  }

  async flush(): Promise<void> {
    await atomicWriteJson(this.filePath, this.data, ++this.flushSeq);
  }
}
