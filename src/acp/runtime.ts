import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { ClaudeAcpRuntime } from "./claude-runtime.js";
import { CodexAcpRuntime } from "./codex-runtime.js";
import { OfficialAcpRuntime } from "./official-runtime.js";
import type {
  AcpBackend,
  AcpNewSessionOptions,
  AcpNewSessionResult,
  BridgeAcpRuntime,
  SessionRecovery,
} from "./runtime-contract.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

/**
 * `cursor-agent-acp` 在 `session/prompt` 链路里识别 `stream` 开关，走
 * cursor-agent `stream-json` + `--stream-partial-output`。官方 SDK 的 PromptRequest
 * schema 不包含顶层 `stream`，Agent 可能剥掉未知键；因此桥接把该标记放进 `_meta.stream`
 *（并保留顶层 `stream` 以防对端未剥该字段）。
 */
type SessionPromptParams = Parameters<
  import("@agentclientprotocol/sdk").ClientSideConnection["prompt"]
>[0] & {
  stream?: boolean;
  _meta?: Parameters<
    import("@agentclientprotocol/sdk").ClientSideConnection["prompt"]
  >[0]["_meta"] & {
    stream?: boolean;
  };
};

const MIN_ADAPTER_SESSION_TIMEOUT_MS = 60_000;
export const MAX_ADAPTER_SESSION_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * 同步适配器自己的 session 清理窗口，避免桥侧仍认为 session 存活时，
 * `cursor-agent-acp` 先按其内部超时把底层 session 删掉。
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
 * 子进程运行本仓库 cursor-agent-acp 适配器，通过官方 SDK ClientSideConnection 对接标准 ACP stdio。
 */
function getCursorCliRecovery(
  options?: AcpNewSessionOptions,
): Extract<SessionRecovery, { kind: "cursor-cli" }> | undefined {
  const recovery = options?.recovery;
  return recovery?.kind === "cursor-cli" ? recovery : undefined;
}

export class AcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "cursor-legacy" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const {
      nodePath,
      adapterEntry,
      adapterTsxCli,
      extraArgs,
      workspaceRoot,
      adapterSessionDir,
    } = this.config.acp;
    const args = adapterTsxCli
      ? [adapterTsxCli, adapterEntry, ...extraArgs]
      : [adapterEntry, ...extraArgs];
    if (this.config.logLevel === "debug") {
      args.push("--log-level", "debug");
    }
    args.push("--session-dir", adapterSessionDir);
    args.push("--session-timeout", resolveAdapterSessionTimeoutMs(this.config));
    return {
      command: nodePath,
      args,
      cwd: workspaceRoot,
      env: { ...process.env },
      label: "cursor-agent-acp adapter",
    };
  }

  protected override buildPromptParams(
    sessionId: string,
    text: string,
  ): SessionPromptParams {
    return {
      sessionId,
      prompt: [{ type: "text", text }],
      stream: true,
      _meta: {
        stream: true,
      },
    };
  }

  protected override buildNewSessionParams(
    cwd: string,
    options?: AcpNewSessionOptions,
  ) {
    const preferredCursorCliChatId = getCursorCliRecovery(options)?.cursorCliChatId?.trim() || undefined;
    if (preferredCursorCliChatId && this.config.bridgeDebug) {
      console.log(
        `[acp] session/new prefer cursorChatId=${preferredCursorCliChatId} cwd=${cwd}`,
      );
    }
    return {
      cwd,
      mcpServers: [],
      ...(preferredCursorCliChatId
        ? {
            _meta: {
              cursorChatId: preferredCursorCliChatId,
            },
          }
        : {}),
    };
  }

  protected override extractNewSessionResult(
    res: {
      sessionId: string;
      _meta?: {
        cursorChatId?: unknown;
      } | null;
    },
    options?: AcpNewSessionOptions,
  ): AcpNewSessionResult {
    const preferredCursorCliChatId = getCursorCliRecovery(options)?.cursorCliChatId?.trim() || undefined;
    const c = res._meta?.cursorChatId;
    const cursorCliChatId =
      typeof c === "string" && c.length > 0
        ? c
        : preferredCursorCliChatId;
    return cursorCliChatId
      ? {
          sessionId: res.sessionId,
          recovery: { kind: "cursor-cli", cursorCliChatId },
        }
      : { sessionId: res.sessionId };
  }
}

function cloneConfigForBackend(config: Config, backend: AcpBackend): Config {
  return {
    ...config,
    acp: {
      ...config.acp,
      backend,
    },
  };
}

export function createAcpRuntime(
  config: Config,
  handler: FeishuBridgeClient,
): BridgeAcpRuntime {
  if (config.acp.backend === "cursor-official") {
    return new OfficialAcpRuntime(config, handler);
  }
  if (config.acp.backend === "claude") {
    return new ClaudeAcpRuntime(config, handler);
  }
  if (config.acp.backend === "codex") {
    return new CodexAcpRuntime(config, handler);
  }
  return new AcpRuntime(config, handler);
}

export type AcpRuntimeStatusState = "idle" | "starting" | "ready" | "error";

export interface AcpRuntimeStatus {
  backend: AcpBackend;
  state: AcpRuntimeStatusState;
  startedAt?: number;
  readyAt?: number;
  errorAt?: number;
  errorMessage?: string;
}

type RuntimeEntry = {
  runtime: BridgeAcpRuntime;
  state: AcpRuntimeStatusState;
  startedAt?: number;
  readyAt?: number;
  errorAt?: number;
  errorMessage?: string;
  startPromise?: Promise<BridgeAcpRuntime>;
};

export class AcpRuntimeRegistry {
  private readonly runtimes = new Map<AcpBackend, RuntimeEntry>();

  constructor(private readonly config: Config) {}

  private getEntry(backend: AcpBackend): RuntimeEntry {
    const existing = this.runtimes.get(backend);
    if (existing) return existing;
    const runtimeConfig = cloneConfigForBackend(this.config, backend);
    const bridgeClient = new FeishuBridgeClient(runtimeConfig);
    const runtime = createAcpRuntime(runtimeConfig, bridgeClient);
    const entry: RuntimeEntry = {
      runtime,
      state: "idle",
    };
    this.runtimes.set(backend, entry);
    return entry;
  }

  getRuntime(backend: AcpBackend): BridgeAcpRuntime {
    return this.getEntry(backend).runtime;
  }

  getEnabledBackends(): AcpBackend[] {
    return [...this.config.acp.enabledBackends];
  }

  getRuntimeStatus(backend: AcpBackend): AcpRuntimeStatus {
    const entry = this.getEntry(backend);
    return {
      backend,
      state: entry.state,
      startedAt: entry.startedAt,
      readyAt: entry.readyAt,
      errorAt: entry.errorAt,
      errorMessage: entry.errorMessage,
    };
  }

  getEnabledRuntimeStatuses(): AcpRuntimeStatus[] {
    return this.getEnabledBackends().map((backend) => this.getRuntimeStatus(backend));
  }

  async startEnabledRuntimes(): Promise<BridgeAcpRuntime[]> {
    const started: BridgeAcpRuntime[] = [];
    for (const backend of this.config.acp.enabledBackends) {
      const runtime = await this.startRuntime(backend);
      started.push(runtime);
    }
    return started;
  }

  startEnabledRuntimesInBackground(): void {
    for (const backend of this.config.acp.enabledBackends) {
      void this.startRuntime(backend).catch(() => {});
    }
  }

  private async startRuntime(backend: AcpBackend): Promise<BridgeAcpRuntime> {
    const entry = this.getEntry(backend);
    if (entry.state === "ready") {
      return entry.runtime;
    }
    if (entry.startPromise) {
      return entry.startPromise;
    }

    entry.state = "starting";
    entry.startedAt = Date.now();
    delete entry.errorAt;
    delete entry.errorMessage;

    entry.startPromise = (async () => {
      try {
        await entry.runtime.start();
        await entry.runtime.initializeAndAuth();
        entry.state = "ready";
        entry.readyAt = Date.now();
        console.log(
          `[bridge] ${formatAcpBackendLabel(backend)} 已连接 protocolVersion=${entry.runtime.initializeResult?.protocolVersion} loadSession=${entry.runtime.supportsLoadSession}`,
        );
        return entry.runtime;
      } catch (error) {
        entry.state = "error";
        entry.errorAt = Date.now();
        entry.errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          `[bridge] ${formatAcpBackendLabel(backend)} 启动失败:`,
          error,
        );
        try {
          await entry.runtime.stop();
        } catch {
          // ignore secondary stop errors while already recording startup failure
        }
        throw error;
      } finally {
        entry.startPromise = undefined;
      }
    })();

    return entry.startPromise;
  }

  async stopAll(): Promise<void> {
    for (const entry of this.runtimes.values()) {
      await entry.runtime.stop();
      entry.state = "idle";
      delete entry.startedAt;
      delete entry.readyAt;
      delete entry.errorAt;
      delete entry.errorMessage;
      entry.startPromise = undefined;
    }
  }
}

export function formatAcpBackendLabel(backend: AcpBackend): string {
  if (backend === "cursor-official") return "Cursor 官方 ACP";
  if (backend === "claude") return "Claude Code（claude-agent-acp）";
  if (backend === "codex") return "Codex（@zed-industries/codex-acp）";
  return "第三方 Cursor ACP 适配器";
}
