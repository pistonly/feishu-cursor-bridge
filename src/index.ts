import "dotenv/config";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";

async function main() {
  console.log("=== Feishu-Cursor Bridge Service ===");

  const config = loadConfig();
  console.log(`[main] Feishu domain: ${config.feishu.domain}`);
  console.log(`[main] Cursor agent: ${config.cursor.agentPath}`);
  console.log(`[main] Work directory: ${config.cursor.workDir}`);
  console.log(`[main] Auto-approve permissions: ${config.autoApprovePermissions}`);

  const bridge = new Bridge(config);

  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    await bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await bridge.start();
    console.log("[main] Service is running. Press Ctrl+C to stop.");
  } catch (err) {
    console.error("[main] Failed to start:", err);
    process.exit(1);
  }
}

main();
