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
 * 上游 @blowmage/cursor-agent-acp 在 `session/prompt` 链路里识别 `stream` 开关，走
 * cursor-agent `stream-json` + `--stream-partial-output`。但官方 SDK 的 PromptRequest
 * schema 不包含顶层 `stream`，Agent 侧校验会把未知键剥掉；因此桥接把该标记放进 `_meta.stream`
 *（并保留顶层 `stream` 以兼容未做 schema 剥离的实现）。
 */
type SessionPromptParams = Parameters<ClientSideConnection["prompt"]>[0] & {
  stream?: boolean;
  _meta?: Parameters<ClientSideConnection["prompt"]>[0]["_meta"] & {
    stream?: boolean;
  };
};

const MIN_ADAPTER_SESSION_TIMEOUT_MS = 60_000;
export const MAX_ADAPTER_SESSION_TIMEOUT_MS = 24 * 60 * 60_000;

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

/**
 * 同步适配器自己的 session 清理窗口，避免桥侧仍认为 session 存活时，
 * 上游 cursor-agent-acp 先按其默认 1 小时超时把底层 session 删掉。
 *
 * 注意：适配器自身把 `sessionTimeout` 限制在 1 分钟到 24 小时之间，
 * 所以桥侧即便配置了更长空闲期，这里也只能截断到 24 小时，再依赖上层探活+重建兜底。
 */
export function resolveAdapterSessionTimeoutMs(config: Config): string {
  const idleMs = config.bridge.sessionIdleTimeoutMs;
  if (Number.isFinite(idleMs)) {
    return String(
      Math.min(
        MAX_ADAPTER_SESSION_TIMEOUT_MS,
        Math.max(MIN_ADAPTER_SESSION_TIMEOUT_MS, Math.floor(idleMs)),
      ),
    );
  }
  return String(MAX_ADAPTER_SESSION_TIMEOUT_MS);
}

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

  /** Agent 在 initialize 中宣告 `session/list` 时，可调用 `session/list` 对照 sessionId 是否仍在 Agent 侧 */
  get supportsListSessions(): boolean {
    const list = this.initResult?.agentCapabilities?.sessionCapabilities?.list;
    return list != null && typeof list === "object";
  }

  /**
   * `prompt` 返回 null 时协议未给出 stopReason；记录连接/子进程/（若支持）session/list 等可观测状态。
   * 说明：这仍不是 Agent 内部完整状态，但能区分「连接已断」「目标 session 不在 list」等情况。
   */
  private async logPromptNullDiagnostics(
    sessionId: string,
    conn: ClientSideConnection,
  ): Promise<void> {
    const snap: Record<string, unknown> = {
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
      throw new Error("ACP adapter already running");
    }

    const { nodePath, adapterEntry, extraArgs, workspaceRoot, adapterSessionDir } =
      this.config.acp;

    const args = [adapterEntry, ...extraArgs];
    if (this.config.logLevel === "debug") {
      args.push("--log-level", "debug");
    }

    args.push("--session-dir", adapterSessionDir);
    args.push("--session-timeout", resolveAdapterSessionTimeoutMs(this.config));

    const acpEnv = { ...process.env };
    if (this.config.bridgeDebug || this.config.logLevel === "debug") {
      console.log(
        `[acp] spawn cwd=${workspaceRoot} node=${nodePath} args=${JSON.stringify(args)}`,
      );
      console.log(
        "[acp] spawn env (敏感键名已脱敏，需完整明文可临时改 redactEnvForLog):",
        JSON.stringify(redactEnvForLog(acpEnv), null, 2),
      );
    }

    const child = spawn(nodePath, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: acpEnv,
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

  /**
   * @param cwd 会话工作目录（ACP cwd）；缺省为 `CURSOR_WORK_DIR`
   * @param options.cursorCliChatId 若提供，则请求适配器把新 ACP 会话绑定到该 CLI chat
   * @returns `cursorCliChatId` 为 `cursor-agent create-chat` 返回的 id，可与终端 `cursor-agent ... --resume` 对齐（由适配器放在 session/new 的 _meta.cursorChatId）
   */
  async newSession(
    cwd?: string,
    options?: {
      cursorCliChatId?: string;
    },
  ): Promise<{
    sessionId: string;
    cursorCliChatId?: string;
  }> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const dir = path.resolve(cwd ?? this.config.acp.workspaceRoot);
    const preferredCursorCliChatId = options?.cursorCliChatId?.trim() || undefined;
    if (preferredCursorCliChatId && this.config.bridgeDebug) {
      console.log(
        `[acp] session/new prefer cursorChatId=${preferredCursorCliChatId} cwd=${dir}`,
      );
    }
    const res = await conn.newSession({
      cwd: dir,
      mcpServers: [],
      ...(preferredCursorCliChatId
        ? {
            _meta: {
              cursorChatId: preferredCursorCliChatId,
            },
          }
        : {}),
    } as Parameters<ClientSideConnection["newSession"]>[0]);
    const meta = res._meta as { cursorChatId?: unknown } | null | undefined;
    const c = meta?.cursorChatId;
    const cursorCliChatId =
      typeof c === "string" && c.length > 0
        ? c
        : preferredCursorCliChatId;
    return { sessionId: res.sessionId, cursorCliChatId };
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
        `[acp reload-trace] session/load begin sessionId=${sessionId} cwd=${dir}`,
      );
    }
    const t0 = this.config.acpReloadTraceLog ? Date.now() : 0;
    try {
      await conn.loadSession({
        sessionId,
        cwd: dir,
        mcpServers: [],
      });
      if (this.config.acpReloadTraceLog) {
        console.log(
          `[acp reload-trace] session/load ok sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
        );
      }
    } catch (e) {
      if (this.config.acpReloadTraceLog) {
        console.warn(
          `[acp reload-trace] session/load FAILED sessionId=${sessionId} elapsedMs=${Date.now() - t0}`,
          e instanceof Error ? e.message : e,
        );
      }
      throw e;
    }
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const conn = this.connection;
    if (!conn) throw new Error("ACP not started");
    const params: SessionPromptParams = {
      sessionId,
      prompt: [{ type: "text", text }],
      stream: true,
      _meta: {
        stream: true,
      },
    };
    const res = await conn.prompt(
      params as Parameters<ClientSideConnection["prompt"]>[0],
    );
    if (res == null) {
      await this.logPromptNullDiagnostics(sessionId, conn);
      return { stopReason: "unknown" };
    }
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
