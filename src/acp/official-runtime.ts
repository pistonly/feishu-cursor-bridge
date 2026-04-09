import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";
import type {
  AcpNewSessionOptions,
  AcpNewSessionResult,
} from "./runtime-contract.js";

export class OfficialAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "cursor-official" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const args: string[] = [];
    if (this.config.acp.officialApiKey) {
      args.push("--api-key", this.config.acp.officialApiKey);
    }
    if (this.config.acp.officialAuthToken) {
      args.push("--auth-token", this.config.acp.officialAuthToken);
    }
    args.push("acp");

    return {
      command: this.config.acp.officialAgentPath,
      args,
      cwd: this.config.acp.workspaceRoot,
      env: { ...process.env },
      label: "official Cursor ACP",
    };
  }

  protected extractNewSessionResult(
    res: { sessionId: string },
    _options?: AcpNewSessionOptions,
  ): AcpNewSessionResult {
    return { sessionId: res.sessionId };
  }
}
