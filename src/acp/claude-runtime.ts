import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import type {
  AcpNewSessionOptions,
  AcpNewSessionResult,
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
    };
    if (!recovery?.resumeSessionId.trim()) {
      return base;
    }
    return {
      ...base,
      _meta: {
        claudeCode: {
          options: {
            resume: recovery.resumeSessionId.trim(),
          },
        },
      },
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
