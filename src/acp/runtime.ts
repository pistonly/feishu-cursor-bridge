import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { OfficialAcpRuntime } from "./official-runtime.js";
import { TmuxAcpRuntime } from "./tmux-runtime.js";
import type {
  AcpBackend,
  AcpNewSessionOptions,
  AcpNewSessionResult,
  BridgeAcpRuntime,
} from "./runtime-contract.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

/**
 * 上游 legacy 适配器在 `session/prompt` 链路里识别 `stream` 开关，走
 * cursor-agent `stream-json` + `--stream-partial-output`。但官方 SDK 的 PromptRequest
 * schema 不包含顶层 `stream`，Agent 侧校验会把未知键剥掉；因此桥接把该标记放进 `_meta.stream`
 *（并保留顶层 `stream` 以兼容未做 schema 剥离的实现）。
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
 * 子进程运行本仓库 cursor-agent-acp 适配器，通过官方 SDK ClientSideConnection 对接标准 ACP stdio。
 */
export class AcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "legacy" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const { nodePath, adapterEntry, extraArgs, workspaceRoot, adapterSessionDir } =
      this.config.acp;
    const args = [adapterEntry, ...extraArgs];
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
    const preferredCursorCliChatId = options?.cursorCliChatId?.trim() || undefined;
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
    const preferredCursorCliChatId = options?.cursorCliChatId?.trim() || undefined;
    const c = res._meta?.cursorChatId;
    const cursorCliChatId =
      typeof c === "string" && c.length > 0
        ? c
        : preferredCursorCliChatId;
    return { sessionId: res.sessionId, cursorCliChatId };
  }
}

export function createAcpRuntime(
  config: Config,
  handler: FeishuBridgeClient,
): BridgeAcpRuntime {
  if (config.acp.backend === "official") {
    return new OfficialAcpRuntime(config, handler);
  }
  if (config.acp.backend === "tmux") {
    return new TmuxAcpRuntime(config, handler);
  }
  return new AcpRuntime(config, handler);
}

export function formatAcpBackendLabel(backend: AcpBackend): string {
  if (backend === "official") return "Cursor 官方 ACP";
  if (backend === "tmux") return "tmux ACP server 原型";
  return "第三方 ACP 适配器";
}
