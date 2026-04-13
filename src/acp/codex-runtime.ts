import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

function findCodexConfigOverride(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    if (!current) continue;
    if (current === "-c" || current === "--config") {
      const next = args[i + 1];
      if (typeof next === "string" && next.startsWith(`${key}=`)) {
        return next.slice(key.length + 1);
      }
      continue;
    }
    if (current.startsWith("--config=")) {
      const value = current.slice("--config=".length);
      if (value.startsWith(`${key}=`)) {
        return value.slice(key.length + 1);
      }
    }
  }
  return undefined;
}

export class CodexAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "codex" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const { codexSpawnCommand, codexSpawnArgs, workspaceRoot } = this.config.acp;
    const sandboxMode = findCodexConfigOverride(
      codexSpawnArgs,
      "sandbox_mode",
    );
    const approvalPolicy = findCodexConfigOverride(
      codexSpawnArgs,
      "approval_policy",
    );
    console.log(
      `[acp] codex launch config sandbox_mode=${sandboxMode ?? "<default>"} approval_policy=${approvalPolicy ?? "<default>"} autoApprovePermissions=${this.config.autoApprovePermissions}`,
    );
    return {
      command: codexSpawnCommand,
      args: [...codexSpawnArgs],
      cwd: workspaceRoot,
      env: { ...process.env },
      label: "codex-acp",
    };
  }

  protected override async authenticate(
    _conn: import("@agentclientprotocol/sdk").ClientSideConnection,
  ): Promise<void> {
    // Codex ACP relies on the local launch environment for auth.
  }
}
