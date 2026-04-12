import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

export class CodexAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "codex" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const { codexSpawnCommand, codexSpawnArgs, workspaceRoot } = this.config.acp;
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
