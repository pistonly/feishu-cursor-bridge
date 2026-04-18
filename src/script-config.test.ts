import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { loadScriptConfig } from "./script-config.js";

test("loadScriptConfig 解析 quoted dotenv 值与默认路径", () => {
  const repoRoot = "/repo";
  const homeDir = "/home/tester";
  const config = loadScriptConfig({
    repoRoot,
    homeDir,
    dotenvPath: "/missing/.env",
    env: {},
  });

  assert.equal(config.singleInstanceLockPath, "/home/tester/.feishu-cursor-bridge/bridge.lock");
  assert.equal(config.bridgeDevLogPath, "/home/tester/.feishu-cursor-bridge/logs/bridge-dev.log");
  assert.equal(config.experimentalLogToFile, false);
  assert.equal(config.experimentalLogFilePath, "/home/tester/.feishu-cursor-bridge/logs/bridge.log");
  assert.equal(config.condaEnvName, "base");
  assert.equal(config.upgradeRemote, "origin");
});

test("loadScriptConfig 优先使用环境变量并按 app 语义 resolve 路径", () => {
  const config = loadScriptConfig({
    repoRoot: "/repo",
    homeDir: "/Users/me",
    dotenvPath: "/missing/.env",
    env: {
      BRIDGE_SINGLE_INSTANCE_LOCK: "~/locks/bridge.lock",
      BRIDGE_DEV_LOG_FILE: "logs/dev.log",
      EXPERIMENT_LOG_TO_FILE: "true",
      EXPERIMENT_LOG_FILE: "./logs/app.log",
      CONDA_ENV_NAME: "py311",
      BRIDGE_UPGRADE_REMOTE: "upstream",
      BRIDGE_UPGRADE_BRANCH: "develop",
    },
  });

  assert.equal(config.singleInstanceLockPath, "/Users/me/locks/bridge.lock");
  assert.equal(config.bridgeDevLogPath, "/repo/logs/dev.log");
  assert.equal(config.experimentalLogToFile, true);
  assert.equal(config.experimentalLogFilePath, "/repo/logs/app.log");
  assert.equal(config.condaEnvName, "py311");
  assert.equal(config.upgradeRemote, "upstream");
  assert.equal(config.upgradeBranch, "develop");
});

test("loadScriptConfig 会从 dotenv 读取值并支持引号", async () => {
  const tmp = await import("node:fs/promises");
  const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "script-config-"));
  const dotenvPath = path.join(dir, ".env");
  await tmp.writeFile(
    dotenvPath,
    [
      'BRIDGE_SINGLE_INSTANCE_LOCK="~/bridge/lock.pid"',
      "EXPERIMENT_LOG_TO_FILE=true",
      "EXPERIMENT_LOG_FILE='relative/bridge.log'",
      "CONDA_ENV_NAME=ml",
      "BRIDGE_UPGRADE_REMOTE=origin2",
    ].join("\n"),
    "utf8",
  );

  const config = loadScriptConfig({
    repoRoot: "/repo",
    homeDir: "/Users/demo",
    dotenvPath,
    env: {},
  });

  assert.equal(config.singleInstanceLockPath, "/Users/demo/bridge/lock.pid");
  assert.equal(config.experimentalLogToFile, true);
  assert.equal(config.experimentalLogFilePath, "/repo/relative/bridge.log");
  assert.equal(config.condaEnvName, "ml");
  assert.equal(config.upgradeRemote, "origin2");
});
