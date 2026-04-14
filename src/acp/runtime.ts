import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { ClaudeAcpRuntime } from "./claude-runtime.js";
import { CodexAcpRuntime } from "./codex-runtime.js";
import { OfficialAcpRuntime } from "./official-runtime.js";
import { TmuxAcpRuntime } from "./tmux-runtime.js";
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
  if (config.acp.backend === "cursor-tmux") {
    return new TmuxAcpRuntime(config, handler);
  }
  if (config.acp.backend === "claude") {
    return new ClaudeAcpRuntime(config, handler);
  }
  if (config.acp.backend === "codex") {
    return new CodexAcpRuntime(config, handler);
  }
  return new AcpRuntime(config, handler);
}

export class AcpRuntimeRegistry {
  private readonly runtimes = new Map<AcpBackend, BridgeAcpRuntime>();

  constructor(private readonly config: Config) {}

  getRuntime(backend: AcpBackend): BridgeAcpRuntime {
    const existing = this.runtimes.get(backend);
    if (existing) return existing;
    const runtimeConfig = cloneConfigForBackend(this.config, backend);
    const bridgeClient = new FeishuBridgeClient(runtimeConfig);
    const runtime = createAcpRuntime(runtimeConfig, bridgeClient);
    this.runtimes.set(backend, runtime);
    return runtime;
  }

  getEnabledBackends(): AcpBackend[] {
    return [...this.config.acp.enabledBackends];
  }

  async startEnabledRuntimes(): Promise<BridgeAcpRuntime[]> {
    const started: BridgeAcpRuntime[] = [];
    for (const backend of this.config.acp.enabledBackends) {
      const runtime = this.getRuntime(backend);
      await runtime.start();
      await runtime.initializeAndAuth();
      started.push(runtime);
    }
    return started;
  }

  async stopAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
  }
}

export function formatAcpBackendLabel(backend: AcpBackend): string {
  if (backend === "cursor-official") return "Cursor 官方 ACP";
  if (backend === "cursor-tmux") return "tmux ACP server 原型";
  if (backend === "claude") return "Claude Code（claude-agent-acp）";
  if (backend === "codex") return "Codex（@zed-industries/codex-acp）";
  return "第三方 Cursor ACP 适配器";
}
