import type { Config } from "../config/index.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

export class GeminiAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "gemini" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const {
      geminiSpawnCommand = "gemini",
      geminiSpawnArgs = ["--acp"],
      workspaceRoot,
    } = this.config.acp;
    const args = [...geminiSpawnArgs];
    if (!args.includes("--acp")) {
      args.push("--acp");
    }
    if (this.config.logLevel === "debug" && !args.includes("--debug")) {
      args.push("--debug");
    }
    return {
      command: geminiSpawnCommand,
      args,
      cwd: workspaceRoot,
      env: { ...process.env },
      label: "gemini-cli-acp",
    };
  }
}
