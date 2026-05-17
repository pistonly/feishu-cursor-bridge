import { inspect } from "node:util";

/**
 * ClientSideConnection 对失败请求 reject 的是 JSON-RPC error 对象，而非 Error 实例。
 * message 常为泛化的 "Internal error"，具体原因在 data（如 data.details）。
 */
export function formatJsonRpcLikeError(err: unknown): string {
  if (err instanceof Error) {
    const withRpc = err as Error & { code?: number; data?: unknown };
    let s = err.message || String(err);
    if (withRpc.data !== undefined) {
      s += "\n" + stringifyData(withRpc.data);
    }
    return s;
  }

  if (err && typeof err === "object") {
    const e = err as { message?: string; code?: number; data?: unknown };
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message.length > 0) {
      parts.push(e.message);
    }
    if (typeof e.code === "number") {
      parts.push(`JSON-RPC code: ${e.code}`);
    }
    if (e.data !== undefined) {
      parts.push(stringifyData(e.data));
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  try {
    const json = JSON.stringify(err, null, 2);
    if (typeof json === "string" && json.length > 0) {
      return json;
    }
  } catch {
    // fall through to util.inspect below
  }
  return inspect(err, {
    depth: 8,
    breakLength: 120,
    maxArrayLength: 100,
    compact: false,
  });
}

function stringifyData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    const json = JSON.stringify(data, null, 2);
    if (typeof json === "string" && json.length > 0) {
      return json;
    }
  } catch {
    // fall through to util.inspect below
  }
  return inspect(data, {
    depth: 8,
    breakLength: 120,
    maxArrayLength: 100,
    compact: false,
  });
}
