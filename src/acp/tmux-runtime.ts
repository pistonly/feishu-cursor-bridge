import type { Config } from "../config.js";
import { FeishuBridgeClient } from "./feishu-bridge-client.js";
import { SdkAcpRuntimeBase } from "./sdk-runtime-base.js";

/**
 * 子进程运行仓库内置的 tmux ACP server 原型，通过标准 ACP stdio 与 bridge 对接。
 */
export class TmuxAcpRuntime extends SdkAcpRuntimeBase {
  readonly backend = "tmux" as const;

  constructor(config: Config, handler: FeishuBridgeClient) {
    super(config, handler);
  }

  protected createSpawnSpec() {
    const {
      nodePath,
      tmuxTsxCliEntry,
      tmuxServerEntry,
      tmuxSessionStorePath,
      workspaceRoot,
    } = this.config.acp;
    const args = [tmuxTsxCliEntry, tmuxServerEntry, "--store-path", tmuxSessionStorePath];
    return {
      command: nodePath,
      args,
      cwd: workspaceRoot,
      env: { ...process.env },
      label: "tmux ACP server",
    };
  }
}
