import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexAppServerRuntime } from "./acp/codex-app-server-runtime.js";
import type { Config } from "./config/index.js";

function createTestConfig(): Config {
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "codex-app-server",
      enabledBackends: ["codex-app-server"],
      nodePath: process.execPath,
      adapterEntry: "",
      extraArgs: [],
      officialAgentPath: "agent",
      officialApiKey: undefined,
      officialAuthToken: undefined,
      claudeSpawnCommand: "npx",
      claudeSpawnArgs: ["-y", "@agentclientprotocol/claude-agent-acp"],
      codexSpawnCommand: "npx",
      codexSpawnArgs: ["-y", "@zed-industries/codex-acp"],
      codexAppServerSpawnCommand: "codex",
      codexAppServerSpawnArgs: ["app-server"],
      workspaceRoot: "/tmp",
      allowedWorkspaceRoots: ["/tmp"],
      adapterSessionDir: "/tmp/acp-sessions",
    },
    bridge: {
      adminUserIds: [],
      groupSessionScope: "per-user",
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: "/tmp/sessions.json",
      cardUpdateThrottleMs: 0,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: "/tmp/workspace-presets.json",
      workspacePresetsSeed: [],
      maintenanceStatePath: "/tmp/maintenance-state.json",
      singleInstanceLockPath: "/tmp/bridge.lock",
      allowMultipleInstances: false,
      managedByService: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: "/tmp/bridge.log",
      slotMessageLogEnabled: false,
      sessionHistoryEnabled: false,
      showAcpAvailableCommands: false,
      enableBangCommand: false,
      enableUpgradeCommand: false,
      upgradeAdmins: {
        openIds: new Set<string>(),
        userIds: new Set<string>(),
        unionIds: new Set<string>(),
      },
      serviceScriptPath: "/tmp/service.sh",
      upgradeResultPath: "/tmp/upgrade-result.json",
    },
    autoApprovePermissions: false,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}

test("CodexAppServerRuntime initializeAndAuth can initialize before runtime is marked initialized", async () => {
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    new EventEmitter() as any,
  );
  const calls: string[] = [];

  (runtime as any).rpc = {
    async request(method: string): Promise<unknown> {
      calls.push(method);
      if (method === "initialize") {
        return {
          userAgent: "codex-cli-test",
          codexHome: "/tmp/codex-home",
          platformOs: "linux",
        };
      }
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              model: "gpt-5.4",
              displayName: "GPT-5.4",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              defaultReasoningEffort: "medium",
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };

  await runtime.initializeAndAuth();

  assert.deepEqual(calls, ["initialize", "model/list"]);
  assert.equal(runtime.initializeResult?.protocolVersion, "codex-app-server/v2");
  assert.deepEqual(runtime.getSessionModelState("missing"), undefined);
});
