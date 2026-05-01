import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function readRootPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

test("root script entrypoints stay centralized", () => {
  const scripts = readRootPackageScripts();
  assert.equal(scripts["test"], "node scripts/run-tests.mjs");
  assert.equal(scripts["dev:restart"], "bash scripts/bridge-dev.sh");
});

test("shell scripts continue consuming script-config-cli instead of re-parsing dotenv", () => {
  const bridgeDev = readRepoFile("scripts/bridge-dev.sh");
  const service = readRepoFile("service.sh");

  assert.match(bridgeDev, /src\/script-config-cli\.ts get/);
  assert.match(service, /src\/script-config-cli\.ts get/);

  assert.doesNotMatch(
    bridgeDev,
    /grep -E .*BRIDGE_SINGLE_INSTANCE_LOCK=/,
  );
  assert.doesNotMatch(service, /function\s+dotenv_get_value\(|dotenv_get_value\(/);
  assert.doesNotMatch(service, /function\s+resolve_path_like_app\(|resolve_path_like_app\(/);
});

test("session display formatting stays centralized behind shared formatter helpers", () => {
  const conversationService = readRepoFile("src/bridge/conversation-service.ts");
  const acpEvents = readRepoFile("src/acp/events.ts");
  const modelSwitch = readRepoFile("src/commands/model-switch.ts");
  const modeSwitch = readRepoFile("src/commands/mode-switch.ts");

  assert.match(conversationService, /session-display-format\.js/);
  assert.match(acpEvents, /session-display-format\.js/);
  assert.match(modelSwitch, /session-display-format\.js/);
  assert.match(modeSwitch, /session-display-format\.js/);
});
