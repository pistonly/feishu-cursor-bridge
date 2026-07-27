import type { Config } from "../config/index.js";
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
    // Pass sensitive credentials via environment variables instead of
    // command-line arguments, which would be visible to all users via `ps`.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.acp.officialApiKey) {
      env["CURSOR_API_KEY"] = this.config.acp.officialApiKey;
    }
    if (this.config.acp.officialAuthToken) {
      env["CURSOR_AUTH_TOKEN"] = this.config.acp.officialAuthToken;
    }
    args.push("acp");

    return {
      command: this.config.acp.officialAgentPath,
      args,
      cwd: this.config.acp.workspaceRoot,
      env,
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
