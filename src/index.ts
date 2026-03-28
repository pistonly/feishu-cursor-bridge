import "dotenv/config";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { installFileLogger } from "./file-logger.js";
import { acquireSingleInstanceLock } from "./single-instance.js";

async function main() {
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
  } else {
    console.log(
      `[main] Single-instance lock: ${config.bridge.singleInstanceLockPath} (pid ${process.pid})`,
    );
  }

  console.log(`[main] Feishu domain: ${config.feishu.domain}`);
  console.log(`[main] ACP adapter: ${config.acp.nodePath} ${config.acp.adapterEntry}`);
  console.log(`[main] Default workspace (CURSOR_WORK_DIR): ${config.acp.workspaceRoot}`);
  console.log(
    `[main] Allowed workspace roots: ${config.acp.allowedWorkspaceRoots.join(", ")}`,
  );
  console.log(`[main] Adapter session dir: ${config.acp.adapterSessionDir}`);
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
