import * as path from "node:path";
import { atomicWriteJson, readJsonFileWithDefault } from "../utils/json-store.js";

export type BridgeMaintenanceCommandKind = "restart" | "update" | "upgrade";
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
  if ((kind !== "restart" && kind !== "update" && kind !== "upgrade") || (status !== "succeeded" && status !== "failed")) {
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
  if (kind !== "restart" && kind !== "update" && kind !== "upgrade") return undefined;
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
    const parsed = await readJsonFileWithDefault<Record<string, unknown> | null>(
      this.filePath,
      null,
    );
    if (parsed) {
      const lastTask = parseCompletedTask(parsed["lastTask"]);
      const pendingRestart = parsePendingRestart(parsed["pendingRestart"]);
      this.data = {
        version: 1,
        ...(lastTask ? { lastTask } : {}),
        ...(pendingRestart ? { pendingRestart } : {}),
      };
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
    await atomicWriteJson(this.filePath, this.data, ++this.flushSeq);
  }
}
