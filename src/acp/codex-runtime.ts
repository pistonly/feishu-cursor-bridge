import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

export class CodexAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "codex" as const;

  get supportsSetSessionMode(): boolean {
    // codex-acp 0.11.1 exposes session modes on session/new and accepts
    // session/set_mode, but does not currently advertise supportsSetMode.
    return true;
  }

  get supportsSetSessionModel(): boolean {
    // codex-acp 0.11.1 accepts session/set_model for live sessions even
    // though initialize() omits supportsSetModel.
    return true;
  }

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
