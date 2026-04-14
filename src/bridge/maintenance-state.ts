import * as fs from "node:fs/promises";
import * as path from "node:path";

export type BridgeMaintenanceCommandKind = "restart" | "update";
export type BridgeMaintenanceTaskStatus = "succeeded" | "failed";

export interface CompletedBridgeMaintenanceTask {
  kind: BridgeMaintenanceCommandKind;
  status: BridgeMaintenanceTaskStatus;
  requestedBy: string;
  requestedAt: number;
  finishedAt: number;
  forced: boolean;
  detail?: string;
}

export interface PendingBridgeMaintenanceRestart {
  kind: BridgeMaintenanceCommandKind;
  requestedBy: string;
  requestedAt: number;
  forced: boolean;
}

interface BridgeMaintenanceStateFile {
  version: 1;
  lastTask?: CompletedBridgeMaintenanceTask;
  pendingRestart?: PendingBridgeMaintenanceRestart;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCompletedTask(value: unknown): CompletedBridgeMaintenanceTask | undefined {
  if (!isObjectRecord(value)) return undefined;
  const kind = value["kind"];
  const status = value["status"];
  const requestedBy = value["requestedBy"];
  const requestedAt = value["requestedAt"];
  const finishedAt = value["finishedAt"];
  const forced = value["forced"];
  const detail = value["detail"];
  if ((kind !== "restart" && kind !== "update") || (status !== "succeeded" && status !== "failed")) {
    return undefined;
  }
  if (typeof requestedBy !== "string") return undefined;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return undefined;
  if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt)) return undefined;
  if (typeof forced !== "boolean") return undefined;
  if (detail != null && typeof detail !== "string") return undefined;
  return {
    kind,
    status,
    requestedBy,
    requestedAt,
    finishedAt,
    forced,
    ...(detail ? { detail } : {}),
  };
}

function parsePendingRestart(value: unknown): PendingBridgeMaintenanceRestart | undefined {
  if (!isObjectRecord(value)) return undefined;
  const kind = value["kind"];
  const requestedBy = value["requestedBy"];
  const requestedAt = value["requestedAt"];
  const forced = value["forced"];
  if (kind !== "restart" && kind !== "update") return undefined;
  if (typeof requestedBy !== "string") return undefined;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return undefined;
  if (typeof forced !== "boolean") return undefined;
  return {
    kind,
    requestedBy,
    requestedAt,
    forced,
  };
}

export class BridgeMaintenanceStateStore {
  private readonly filePath: string;
  private data: BridgeMaintenanceStateFile = { version: 1 };
  private flushSeq = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const lastTask = parseCompletedTask(parsed["lastTask"]);
      const pendingRestart = parsePendingRestart(parsed["pendingRestart"]);
      this.data = {
        version: 1,
        ...(lastTask ? { lastTask } : {}),
        ...(pendingRestart ? { pendingRestart } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: 1 };
        return;
      }
      throw error;
    }
  }

  getLastTask(): CompletedBridgeMaintenanceTask | undefined {
    return this.data.lastTask ? { ...this.data.lastTask } : undefined;
  }

  getPendingRestart(): PendingBridgeMaintenanceRestart | undefined {
    return this.data.pendingRestart ? { ...this.data.pendingRestart } : undefined;
  }

  async setLastTask(task: CompletedBridgeMaintenanceTask): Promise<void> {
    this.data.lastTask = { ...task };
    delete this.data.pendingRestart;
    await this.flush();
  }

  async setPendingRestart(task: PendingBridgeMaintenanceRestart): Promise<void> {
    this.data.pendingRestart = { ...task };
    await this.flush();
  }

  async finalizePendingRestart(detail?: string): Promise<CompletedBridgeMaintenanceTask | undefined> {
    const pending = this.data.pendingRestart;
    if (!pending) return undefined;
    const completed: CompletedBridgeMaintenanceTask = {
      kind: pending.kind,
      status: "succeeded",
      requestedBy: pending.requestedBy,
      requestedAt: pending.requestedAt,
      finishedAt: Date.now(),
      forced: pending.forced,
      ...(detail ? { detail } : {}),
    };
    this.data.lastTask = completed;
    delete this.data.pendingRestart;
    await this.flush();
    return completed;
  }

  private async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.flushSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}
