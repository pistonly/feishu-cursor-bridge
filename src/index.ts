import "dotenv/config";
import { loadConfig } from "./config/index.js";
import { formatAcpBackendLabel } from "./acp/runtime.js";
import { Bridge } from "./bridge/bridge.js";
import { installFileLogger } from "./utils/file-logger.js";
import { acquireSingleInstanceLock } from "./utils/single-instance.js";

function enableNodeEnvProxyForChildren(): void {
  if (process.env["NODE_USE_ENV_PROXY"]?.trim()) return;
  const hasProxy = [
    "wss_proxy",
    "WSS_PROXY",
    "ws_proxy",
    "WS_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
  ].some((name) => !!process.env[name]?.trim());
  if (!hasProxy) return;
  // cursor-agent-acp / cursor-agent 在受限网络下依赖 Node 的环境代理开关。
  process.env["NODE_USE_ENV_PROXY"] = "1";
  console.log("[main] Detected proxy environment; enabled NODE_USE_ENV_PROXY=1");
}

async function main() {
  enableNodeEnvProxyForChildren();
  const config = loadConfig();
  const fileLogger = config.bridge.experimentalLogToFile
    ? installFileLogger(config.bridge.experimentalLogFilePath)
    : undefined;

  console.log("=== Feishu-Cursor Bridge Service ===");
  let releaseSingleInstanceLock: (() => void) | undefined;
  try {
    releaseSingleInstanceLock = acquireSingleInstanceLock(config);
  } catch (e) {
    console.error("[main]", e instanceof Error ? e.message : e);
    fileLogger?.close();
    process.exit(1);
  }
  if (config.bridge.allowMultipleInstances) {
    console.warn(
      "[main] BRIDGE_ALLOW_MULTIPLE_INSTANCES=true — 未启用单实例锁，可能重复连接飞书",
    );
  }

  console.log(`[main] Feishu domain: ${config.feishu.domain}`);
  console.log(
    `[main] Default ACP backend: ${config.acp.backend} (${formatAcpBackendLabel(config.acp.backend)})`,
  );
  console.log(`[main] Enabled ACP backends: ${config.acp.enabledBackends.join(", ")}`);
  if (config.acp.enabledBackends.includes("cursor-legacy")) {
    const tsx = config.acp.adapterTsxCli;
    console.log(
      `[main] ACP adapter: ${config.acp.nodePath} ${tsx ? `${tsx} ` : ""}${config.acp.adapterEntry}`,
    );
    console.log(`[main] Adapter session dir: ${config.acp.adapterSessionDir}`);
  }
  if (config.acp.enabledBackends.includes("cursor-official")) {
    const authHints = [
      config.acp.officialApiKey ? "api-key" : null,
      config.acp.officialAuthToken ? "auth-token" : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `[main] Official ACP command: ${config.acp.officialAgentPath} acp${authHints ? ` (${authHints})` : ""}`,
    );
  }
  if (config.acp.enabledBackends.includes("codex")) {
    console.log(
      `[main] Codex ACP command: ${config.acp.codexSpawnCommand} ${config.acp.codexSpawnArgs.join(" ")}`.trim(),
    );
  }
  if (config.acp.enabledBackends.includes("codex-app-server")) {
    console.log(
      `[main] Codex app-server command: ${config.acp.codexAppServerSpawnCommand ?? "codex"} ${(config.acp.codexAppServerSpawnArgs ?? []).join(" ")}`.trim(),
    );
  }
  if (config.acp.enabledBackends.includes("gemini")) {
    const geminiArgs = config.acp.geminiSpawnArgs ?? ["--acp"];
    console.log(
      `[main] Gemini CLI ACP command: ${config.acp.geminiSpawnCommand ?? "gemini"} ${geminiArgs.join(" ")}`.trim(),
    );
  }
  console.log(
    `[main] BRIDGE_WORK_ALLOWLIST (${config.acp.allowedWorkspaceRoots.length}): ${config.acp.allowedWorkspaceRoots.join(", ")} — ACP spawn cwd: ${config.acp.workspaceRoot}`,
  );
  console.log(`[main] Bridge session store: ${config.bridge.sessionStorePath}`);
  console.log(`[main] Workspace presets file: ${config.bridge.workspacePresetsPath}`);
  console.log(`[main] Auto-approve permissions: ${config.autoApprovePermissions}`);
  console.log(`[main] Bridge debug: ${config.bridgeDebug}`);
  if (config.bridge.experimentalLogToFile) {
    console.log(
      `[main] Experimental file logging: ${config.bridge.experimentalLogFilePath}`,
    );
  }
  if (config.acpReloadTraceLog) {
    console.log(
      "[main] ACP reload trace: enabled (ACP_RELOAD_TRACE_LOG) — 将打印 [acp reload-trace] session/load 与 session/update 入站摘要",
    );
  }

  const bridge = new Bridge(config);

  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    await bridge.stop();
    releaseSingleInstanceLock?.();
    fileLogger?.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await bridge.start();
    console.log("[main] Service is running. Press Ctrl+C to stop.");
  } catch (err) {
    console.error("[main] Failed to start:", err);
    releaseSingleInstanceLock?.();
    fileLogger?.close();
    process.exit(1);
  }
}

main();
