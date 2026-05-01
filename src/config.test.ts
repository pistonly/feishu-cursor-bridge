import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "./config/index.js";

test("loadConfig 默认开启 bridge bang command", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const originalAppId = process.env["FEISHU_APP_ID"];
  const originalAppSecret = process.env["FEISHU_APP_SECRET"];
  const originalAllowlist = process.env["BRIDGE_WORK_ALLOWLIST"];
  const originalBang = process.env["BRIDGE_ENABLE_BANG_COMMAND"];
  const originalHistory = process.env["BRIDGE_SESSION_HISTORY_ENABLED"];

  process.env["FEISHU_APP_ID"] = "app-id";
  process.env["FEISHU_APP_SECRET"] = "app-secret";
  process.env["BRIDGE_WORK_ALLOWLIST"] = tmpRoot;
  delete process.env["BRIDGE_ENABLE_BANG_COMMAND"];
  delete process.env["BRIDGE_SESSION_HISTORY_ENABLED"];

  try {
    const config = loadConfig();
    assert.equal(config.bridge.enableBangCommand, true);
    assert.equal(config.bridge.sessionHistoryEnabled, true);
    assert.equal(config.acp.geminiSpawnCommand, "gemini");
    assert.equal(config.acp.geminiSpawnArgs?.[0], "--acp");
    assert.equal(config.acp.geminiSpawnArgs?.includes("--acp"), true);
    assert.equal(
      config.acp.geminiSpawnArgs?.includes("--debug"),
      config.logLevel === "debug",
    );
  } finally {
    if (originalAppId === undefined) delete process.env["FEISHU_APP_ID"];
    else process.env["FEISHU_APP_ID"] = originalAppId;
    if (originalAppSecret === undefined) delete process.env["FEISHU_APP_SECRET"];
    else process.env["FEISHU_APP_SECRET"] = originalAppSecret;
    if (originalAllowlist === undefined) delete process.env["BRIDGE_WORK_ALLOWLIST"];
    else process.env["BRIDGE_WORK_ALLOWLIST"] = originalAllowlist;
    if (originalBang === undefined) delete process.env["BRIDGE_ENABLE_BANG_COMMAND"];
    else process.env["BRIDGE_ENABLE_BANG_COMMAND"] = originalBang;
    if (originalHistory === undefined) delete process.env["BRIDGE_SESSION_HISTORY_ENABLED"];
    else process.env["BRIDGE_SESSION_HISTORY_ENABLED"] = originalHistory;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("loadConfig 使用 BRIDGE_INSTANCE_NAME 隔离默认状态路径", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
  const keys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "BRIDGE_WORK_ALLOWLIST",
    "BRIDGE_INSTANCE_NAME",
    "BRIDGE_SESSION_STORE",
    "BRIDGE_MAINTENANCE_STATE_FILE",
    "BRIDGE_SINGLE_INSTANCE_LOCK",
    "BRIDGE_WORK_PRESETS_FILE",
    "BRIDGE_UPGRADE_RESULT_FILE",
    "EXPERIMENT_LOG_FILE",
    "CURSOR_LEGACY_SESSION_DIR",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));

  process.env["FEISHU_APP_ID"] = "app-id";
  process.env["FEISHU_APP_SECRET"] = "app-secret";
  process.env["BRIDGE_WORK_ALLOWLIST"] = tmpRoot;
  process.env["BRIDGE_INSTANCE_NAME"] = "bot-a";
  for (const key of keys.slice(4)) {
    delete process.env[key];
  }

  try {
    const config = loadConfig();
    const stateDir = path.join(os.homedir(), ".feishu-cursor-bridge", "bot-a");
    assert.equal(
      config.bridge.sessionStorePath,
      path.join(stateDir, ".feishu-bridge-sessions.json"),
    );
    assert.equal(
      config.bridge.maintenanceStatePath,
      path.join(stateDir, "maintenance-state.json"),
    );
    assert.equal(config.bridge.singleInstanceLockPath, path.join(stateDir, "bridge.lock"));
    assert.equal(
      config.bridge.workspacePresetsPath,
      path.join(stateDir, "workspace-presets.json"),
    );
    assert.equal(
      config.bridge.upgradeResultPath,
      path.join(stateDir, "upgrade-result.json"),
    );
    assert.equal(
      config.bridge.experimentalLogFilePath,
      path.join(stateDir, "logs", "bridge.log"),
    );
    assert.equal(config.acp.adapterSessionDir, path.join(stateDir, "cursor-acp-sessions"));
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
