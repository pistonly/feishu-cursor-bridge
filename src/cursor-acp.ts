import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { EventEmitter } from "node:events";
import type { Config } from "./config.js";

// ── Public types ──────────────────────────────────────────────────────

export interface ACPSessionInfo {
  sessionId: string;
}

export interface ACPPromptResult {
  stopReason: string;
}

export interface TextChunkEvent {
  text: string;
  sessionId: string;
}

export interface ToolCallEvent {
  name: string;
  params: Record<string, unknown>;
  sessionId: string;
}

export interface PermissionRequestEvent {
  id: number;
  description: string;
}

export interface CursorACPClientEvents {
  text_chunk: [TextChunkEvent];
  tool_call: [ToolCallEvent];
  permission_request: [PermissionRequestEvent];
  error: [Error];
  close: [number | null, NodeJS.Signals | null];
}

// ── JSON-RPC types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// Server-initiated request (e.g. session/request_permission)
interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type IncomingMessage =
  | JsonRpcResponse
  | JsonRpcNotification
  | JsonRpcServerRequest;

// ── Helpers ───────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 5 * 60_000; // prompts can take several minutes

const LOG_PRIORITY: Record<Config["logLevel"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function createLogger(level: Config["logLevel"]) {
  const threshold = LOG_PRIORITY[level];
  return {
    debug: (...args: unknown[]) =>
      threshold <= 0 && console.debug("[ACP debug]", ...args),
    info: (...args: unknown[]) =>
      threshold <= 1 && console.info("[ACP info]", ...args),
    warn: (...args: unknown[]) =>
      threshold <= 2 && console.warn("[ACP warn]", ...args),
    error: (...args: unknown[]) =>
      threshold <= 3 && console.error("[ACP error]", ...args),
  };
}

function isJsonRpcResponse(msg: IncomingMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isJsonRpcServerRequest(
  msg: IncomingMessage,
): msg is JsonRpcServerRequest {
  return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg);
}

// ── Client ────────────────────────────────────────────────────────────

export class CursorACPClient extends EventEmitter<CursorACPClientEvents> {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private rl: readline.Interface | null = null;
  private config: Config;
  private log: ReturnType<typeof createLogger>;

  constructor(config: Config) {
    super();
    this.config = config;
    this.log = createLogger(config.logLevel);
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Agent process already running");
    }

    const args = ["acp"];
    if (this.config.cursor.apiKey) {
      args.push("--api-key", this.config.cursor.apiKey);
    }
    if (this.config.cursor.authToken) {
      args.push("--auth-token", this.config.cursor.authToken);
    }

    this.log.info(
      `Spawning: ${this.config.cursor.agentPath} ${args.join(" ")}`,
    );

    const child = spawn(this.config.cursor.agentPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cursor.workDir,
    });
    this.process = child;

    child.on("error", (err) => {
      this.log.error("Process error:", err.message);
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    child.on("close", (code, signal) => {
      this.log.info(`Process exited (code=${code}, signal=${signal})`);
      this.rejectAllPending(
        new Error(`Agent process exited unexpectedly (code=${code})`),
      );
      this.process = null;
      this.rl?.close();
      this.rl = null;
      this.emit("close", code, signal);
    });

    if (child.stderr) {
      const stderrRl = readline.createInterface({ input: child.stderr });
      stderrRl.on("line", (line) => this.log.warn("[agent stderr]", line));
    }

    if (!child.stdout) {
      throw new Error("Failed to get stdout from agent process");
    }

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      this.log.debug("← recv:", line);
      try {
        const msg: unknown = JSON.parse(line);
        if (typeof msg === "object" && msg !== null) {
          this.handleMessage(msg as IncomingMessage);
        }
      } catch {
        this.log.warn("Failed to parse line from agent:", line);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "feishu-cursor-bridge", version: "1.0.0" },
    });
  }

  async authenticate(): Promise<void> {
    await this.send("authenticate", { methodId: "cursor_login" });
  }

  async createSession(cwd?: string): Promise<ACPSessionInfo> {
    const result = (await this.send("session/new", {
      cwd: cwd ?? this.config.cursor.workDir,
      mcpServers: [],
    })) as { sessionId: string };
    return { sessionId: result.sessionId };
  }

  async loadSession(sessionId: string): Promise<ACPSessionInfo> {
    const result = (await this.send("session/load", {
      sessionId,
    })) as { sessionId: string };
    return { sessionId: result.sessionId };
  }

  async prompt(sessionId: string, text: string): Promise<ACPPromptResult> {
    const result = (await this.send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, PROMPT_TIMEOUT_MS)) as { stopReason: string };
    return { stopReason: result.stopReason };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.send("session/cancel", { sessionId });
  }

  async stop(): Promise<void> {
    this.rejectAllPending(new Error("Client stopped"));
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  respondToPermission(id: number, allow: boolean): void {
    this.respond(id, {
      outcome: {
        outcome: "selected",
        optionId: allow ? "allow-once" : "reject-once",
      },
    });
  }

  // ── Private ───────────────────────────────────────────────────────

  private send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error("Agent process not running"));
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined && { params }),
    };

    const line = JSON.stringify(request);
    this.log.debug("→ send:", line);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin!.write(line + "\n");
    });
  }

  private respond(id: number, result: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      this.log.warn("Cannot respond: agent process not running");
      return;
    }
    const response = { jsonrpc: "2.0" as const, id, result };
    const line = JSON.stringify(response);
    this.log.debug("→ respond:", line);
    this.process.stdin.write(line + "\n");
  }

  private handleMessage(msg: IncomingMessage): void {
    if (isJsonRpcResponse(msg)) {
      this.handleResponse(msg);
    } else if (isJsonRpcServerRequest(msg)) {
      this.handleServerRequest(msg);
    } else {
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this.log.warn(`Received response for unknown id=${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.error) {
      entry.reject(
        new Error(`RPC error ${msg.error.code}: ${msg.error.message}`),
      );
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleServerRequest(msg: JsonRpcServerRequest): void {
    if (msg.method === "session/request_permission") {
      const params = msg.params ?? {};
      const description =
        typeof params["description"] === "string"
          ? params["description"]
          : JSON.stringify(params);

      if (this.config.autoApprovePermissions) {
        this.log.info(`Auto-approving permission: ${description}`);
        this.respond(msg.id, {
          outcome: { outcome: "selected", optionId: "allow-once" },
        });
      } else {
        this.emit("permission_request", {
          id: msg.id,
          description,
        });
      }
    } else {
      this.log.warn(`Unhandled server request: ${msg.method}`);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method !== "session/update") return;

    const params = msg.params ?? {};
    // ACP spec: update data is nested under params.update
    const update = (params["update"] ?? params) as Record<string, unknown>;
    const sessionUpdate = update["sessionUpdate"] ?? update["kind"];
    const sessionId = String(
      params["sessionId"] ?? update["sessionId"] ?? "",
    );

    if (sessionUpdate === "agent_message_chunk") {
      const content = update["content"] as
        | Record<string, unknown>
        | undefined;
      if (content && typeof content["text"] === "string") {
        this.emit("text_chunk", {
          text: content["text"],
          sessionId,
        });
      }
    } else if (sessionUpdate === "tool_call") {
      const toolCall = update["toolCall"] as
        | Record<string, unknown>
        | undefined;
      this.emit("tool_call", {
        name: String(toolCall?.["name"] ?? "unknown"),
        params: (toolCall?.["params"] as Record<string, unknown>) ?? {},
        sessionId,
      });
    }
  }

  private rejectAllPending(err: Error): void {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}
