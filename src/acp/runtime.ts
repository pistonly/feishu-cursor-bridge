import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";

/**
 * 子进程运行 @blowmage/cursor-agent-acp，通过官方 SDK ClientSideConnection 对接标准 ACP stdio。
 */
export class AcpRuntime {
  private readonly config: Config;
  private readonly handler: FeishuBridgeClient;
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private initResult: InitializeResponse | null = null;

  constructor(config: Config, handler: FeishuBridgeClient) {
    this.config = config;
    this.handler = handler;
  }

  get bridgeClient(): FeishuBridgeClient {
    return this.handler;
  }

  get initializeResult(): InitializeResponse | null {
    return this.initResult;
  }

  get supportsLoadSession(): boolean {
    return this.initResult?.agentCapabilities?.loadSession === true;
  }

  supportsCloseSession(): boolean {
    const c = this.initResult?.agentCapabilities?.sessionCapabilities?.close;
    return c != null && typeof c === "object";
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("ACP adapter already running");
    }

    const { nodePath, adapterEntry, extraArgs, workspaceRoot, adapterSessionDir } =
      this.config.acp;

    const args = [adapterEntry, ...extraArgs];
    if (this.config.logLevel === "debug") {
      args.push("--log-level", "debug");
    }

    args.push("--session-dir", adapterSessionDir);

    const child = spawn(nodePath, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.child = child;

    child.on("error", (err) => {
      console.error("[acp] process error:", err);
    });

    child.on("close", (code, signal) => {
      console.log(`[acp] adapter exited code=${code} signal=${signal}`);
      this.child = null;
      this.connection = null;
    });

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        if (this.config.logLevel === "debug") {
          console.warn("[acp stderr]", line);
        } else if (line.toLowerCase().includes("error")) {
          console.warn("[acp stderr]", line);
        }
      });
    }

    if (!child.stdin || !child.stdout) {
      throw new Error("ACP adapter missing stdio pipes");
    }

    const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(toAgent, fromAgent);
    this.connection = new ClientSideConnection(
      () => this.handler,
      stream,
    );
  }

  async initializeAndAuth(): Promise<void> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");

    this.initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: false,
      },
    });

    try {
      await conn.authenticate({ methodId: "cursor_login" });
    } catch (e) {
      console.warn(
        "[acp] authenticate(cursor_login) 失败（若已通过 cursor-agent 登录可忽略）:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  /** @param cwd 会话工作目录（ACP cwd）；缺省为 `CURSOR_WORK_DIR` */
  async newSession(cwd?: string): Promise<{ sessionId: string }> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const dir = path.resolve(cwd ?? this.config.acp.workspaceRoot);
    const res = await conn.newSession({
      cwd: dir,
      mcpServers: [],
    });
    return { sessionId: res.sessionId };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    if (!this.supportsLoadSession) {
      throw new Error("Agent does not advertise loadSession");
    }
    const dir = path.resolve(cwd);
    await conn.loadSession({
      sessionId,
      cwd: dir,
      mcpServers: [],
    });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const res = await conn.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { stopReason: String(res.stopReason) };
  }

  /** 对应 ACP `session/set_model`；避免依赖适配器在 prompt 内处理 /model（其仍会转发整句给 CLI）。 */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    await conn.unstable_setSessionModel({ sessionId, modelId });
  }

  async cancelSession(sessionId: string): Promise<void> {
    const conn = this.connection;
    if (!conn) return;
    try {
      await conn.cancel({ sessionId });
    } catch {
      /* ignore */
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const conn = this.connection;
    if (!conn || !this.supportsCloseSession()) return;
    try {
      await conn.unstable_closeSession({ sessionId });
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill();
      this.child = null;
    }
    this.connection = null;
    this.initResult = null;
  }
}
