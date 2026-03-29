import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import type {
  AcpBackend,
  AcpNewSessionOptions,
  AcpNewSessionResult,
  AcpPromptResult,
  BridgeAcpRuntime,
} from "./runtime-contract.js";

type PromptParams = Parameters<ClientSideConnection["prompt"]>[0];
type NewSessionParams = Parameters<ClientSideConnection["newSession"]>[0];
type LoadSessionParams = Parameters<ClientSideConnection["loadSession"]>[0];
type PromptResponse = Awaited<ReturnType<ClientSideConnection["prompt"]>>;
type NewSessionResponse = Awaited<ReturnType<ClientSideConnection["newSession"]>>;

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}

/** 调试打印 env 时对疑似敏感变量名脱敏 */
function redactEnvForLog(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const sensitive = /secret|password|token|credential|authorization|api_?key|private/i;
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(env).sort()) {
    const v = env[key];
    out[key] = sensitive.test(key) && v ? "***" : v;
  }
  return out;
}

export abstract class SdkAcpRuntimeBase implements BridgeAcpRuntime {
  readonly bridgeClient: FeishuBridgeClient;
  protected readonly config: Config;
  protected child: ChildProcess | null = null;
  protected connection: ClientSideConnection | null = null;
  protected initResult: InitializeResponse | null = null;

  protected constructor(
    config: Config,
    handler: FeishuBridgeClient,
  ) {
    this.config = config;
    this.bridgeClient = handler;
  }

  abstract readonly backend: AcpBackend;

  get initializeResult(): InitializeResponse | null {
    return this.initResult;
  }

  get supportsLoadSession(): boolean {
    return this.initResult?.agentCapabilities?.loadSession === true;
  }

  protected get supportsListSessions(): boolean {
    const list = this.initResult?.agentCapabilities?.sessionCapabilities?.list;
    return list != null && typeof list === "object";
  }

  supportsCloseSession(): boolean {
    const c = this.initResult?.agentCapabilities?.sessionCapabilities?.close;
    return c != null && typeof c === "object";
  }

  protected abstract createSpawnSpec(): SpawnSpec;

  protected buildPromptParams(sessionId: string, text: string): PromptParams {
    return {
      sessionId,
      prompt: [{ type: "text", text }],
    } as PromptParams;
  }

  protected buildNewSessionParams(
    cwd: string,
    _options?: AcpNewSessionOptions,
  ): NewSessionParams {
    return {
      cwd,
      mcpServers: [],
    } as NewSessionParams;
  }

  protected extractNewSessionResult(
    res: NewSessionResponse,
    _options?: AcpNewSessionOptions,
  ): AcpNewSessionResult {
    return { sessionId: res.sessionId };
  }

  protected buildLoadSessionParams(
    sessionId: string,
    cwd: string,
  ): LoadSessionParams {
    return {
      sessionId,
      cwd,
      mcpServers: [],
    };
  }

  protected async logPromptNullDiagnostics(
    sessionId: string,
    conn: ClientSideConnection,
  ): Promise<void> {
    const snap: Record<string, unknown> = {
      backend: this.backend,
      sessionId,
      connectionAborted: conn.signal.aborted,
      adapterChildMissing: this.child == null,
      adapterPid: this.child?.pid,
      adapterKilled: this.child?.killed === true,
      agentAdvertisesListSessions: this.supportsListSessions,
      agentAdvertisesLoadSession: this.supportsLoadSession,
    };
    if (this.child) {
      snap.adapterExitCode = this.child.exitCode;
      snap.adapterSignal = this.child.signalCode;
    }
    if (this.supportsListSessions) {
      try {
        const listed = await conn.listSessions({});
        const ids = listed.sessions.map((s: { sessionId: string }) => s.sessionId);
        snap.listSessionsCount = listed.sessions.length;
        snap.promptSessionIdInAgentList = ids.includes(sessionId);
        snap.agentSessionIdsSample = ids.slice(0, 12);
      } catch (e) {
        snap.listSessionsError = e instanceof Error ? e.message : String(e);
      }
    } else {
      snap.listSessions = "agent_did_not_advertise_session_list";
    }
    console.warn(
      "[acp] session/prompt 返回 null（无 stopReason，可观测快照）:",
      JSON.stringify(snap),
    );
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("ACP runtime already running");
    }

    const spec = this.createSpawnSpec();
    const runtimeEnv = spec.env ?? { ...process.env };
    if (this.config.bridgeDebug || this.config.logLevel === "debug") {
      console.log(
        `[acp] spawn backend=${this.backend} cwd=${spec.cwd} command=${spec.command} args=${JSON.stringify(spec.args)}`,
      );
      console.log(
        "[acp] spawn env (敏感键名已脱敏，需完整明文可临时改 redactEnvForLog):",
        JSON.stringify(redactEnvForLog(runtimeEnv), null, 2),
      );
    }

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnv,
    });

    this.child = child;

    child.on("error", (err) => {
      console.error(`[acp] ${spec.label} process error:`, err);
    });

    child.on("close", (code, signal) => {
      console.log(
        `[acp] ${spec.label} exited code=${code} signal=${signal}`,
      );
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
      throw new Error(`${spec.label} missing stdio pipes`);
    }

    const toAgent = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(toAgent, fromAgent);
    this.connection = new ClientSideConnection(
      () => this.bridgeClient,
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
      clientInfo: {
        name: "feishu-cursor-bridge",
        version: "1.0.0",
      },
    });

    try {
      await conn.authenticate({ methodId: "cursor_login" });
    } catch (e) {
      console.warn(
        "[acp] authenticate(cursor_login) 失败（若已通过 Cursor CLI 登录可忽略）:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  async newSession(
    cwd?: string,
    options?: AcpNewSessionOptions,
  ): Promise<AcpNewSessionResult> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const dir = path.resolve(cwd ?? this.config.acp.workspaceRoot);
    const res = await conn.newSession(this.buildNewSessionParams(dir, options));
    return this.extractNewSessionResult(res, options);
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    if (!this.supportsLoadSession) {
      throw new Error("Agent does not advertise loadSession");
    }
    const dir = path.resolve(cwd);
    if (this.config.acpReloadTraceLog) {
      console.log(
        `[acp reload-trace] session/load begin backend=${this.backend} sessionId=${sessionId} cwd=${dir}`,
      );
    }
    const t0 = this.config.acpReloadTraceLog ? Date.now() : 0;
    try {
      await conn.loadSession(this.buildLoadSessionParams(sessionId, dir));
      if (this.config.acpReloadTraceLog) {
        console.log(
          `[acp reload-trace] session/load ok backend=${this.backend} sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
        );
      }
    } catch (e) {
      if (this.config.acpReloadTraceLog) {
        console.warn(
          `[acp reload-trace] session/load FAILED backend=${this.backend} sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
          e instanceof Error ? e.message : e,
        );
      }
      throw e;
    }
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const res = await conn.prompt(this.buildPromptParams(sessionId, text));
    if (res == null) {
      await this.logPromptNullDiagnostics(sessionId, conn);
      return { stopReason: "unknown" };
    }
    return { stopReason: String((res as PromptResponse).stopReason) };
  }

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
