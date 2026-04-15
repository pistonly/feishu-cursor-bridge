import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import type {
  AcpNewSessionOptions,
  AcpNewSessionResult,
  AcpSessionUsageState,
  SessionRecovery,
} from "./runtime-contract.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

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

type SessionLoadParams = Parameters<
  import("@agentclientprotocol/sdk").ClientSideConnection["loadSession"]
>[0] & {
  _meta?: Parameters<
    import("@agentclientprotocol/sdk").ClientSideConnection["loadSession"]
  >[0]["_meta"] & {
    claudeCode?: {
      emitRawSDKMessages?: Array<{ type: string; subtype?: string }>;
    };
  };
};

const CLAUDE_RAW_SDK_MESSAGE_FILTERS = [
  { type: "result" },
  { type: "system", subtype: "compact_boundary" },
] as const;

function buildClaudeRawSdkMeta() {
  return {
    claudeCode: {
      emitRawSDKMessages: [...CLAUDE_RAW_SDK_MESSAGE_FILTERS],
    },
  };
}

function getClaudeRecovery(
  options?: AcpNewSessionOptions,
): Extract<SessionRecovery, { kind: "claude-session" }> | undefined {
  const recovery = options?.recovery;
  return recovery?.kind === "claude-session" ? recovery : undefined;
}

export class ClaudeAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "claude" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const { claudeSpawnCommand, claudeSpawnArgs, workspaceRoot } = this.config.acp;
    return {
      command: claudeSpawnCommand,
      args: [...claudeSpawnArgs],
      cwd: workspaceRoot,
      env: {
        ...process.env,
        FEISHU_BRIDGE_EXT_TOOL: "1",
      },
      label: "claude-agent-acp",
    };
  }

  protected override shouldUsePromptUsageFallback(
    _sessionId: string,
    _state: AcpSessionUsageState,
    _fallbackUsedTokens: number,
  ): boolean {
    return false;
  }

  protected override shouldHideReportedZeroUsage(
    _sessionId: string,
    state: AcpSessionUsageState,
    _fallbackUsedTokens: number | undefined,
  ): boolean {
    return state.usedTokens <= 0 && state.maxTokens > 0;
  }

  protected override shouldStorePromptUsageFallback(): boolean {
    return false;
  }

  protected override mergeSessionUsageState(
    _sessionId: string,
    current: AcpSessionUsageState | undefined,
    next: AcpSessionUsageState,
  ): AcpSessionUsageState {
    if (
      next.usedTokens <= 0 &&
      current != null &&
      current.usedTokens > 0 &&
      current.maxTokens === next.maxTokens
    ) {
      return { ...current };
    }
    return { ...next };
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
    const recovery = getClaudeRecovery(options);
    const base = {
      cwd,
      mcpServers: [],
      _meta: buildClaudeRawSdkMeta(),
    };
    if (!recovery?.resumeSessionId.trim()) {
      return base;
    }
    return {
      ...base,
      _meta: {
        ...buildClaudeRawSdkMeta(),
        claudeCode: {
          ...buildClaudeRawSdkMeta().claudeCode,
          options: {
            resume: recovery.resumeSessionId.trim(),
          },
        },
      },
    };
  }

  protected override buildLoadSessionParams(
    sessionId: string,
    cwd: string,
  ): SessionLoadParams {
    return {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: buildClaudeRawSdkMeta(),
    };
  }

  protected override extractNewSessionResult(
    res: { sessionId: string },
    options?: AcpNewSessionOptions,
  ): AcpNewSessionResult {
    const recovery = getClaudeRecovery(options);
    return recovery?.resumeSessionId.trim()
      ? {
          sessionId: res.sessionId,
          recovery: {
            kind: "claude-session",
            resumeSessionId: recovery.resumeSessionId.trim(),
          },
        }
      : { sessionId: res.sessionId };
  }

  protected override async authenticate(
    _conn: import("@agentclientprotocol/sdk").ClientSideConnection,
  ): Promise<void> {
    // Claude runtime relies on local Claude/Anthropic authentication.
  }
}
