import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Config } from "../config/index.js";
import {
  AcpRuntimeRegistry,
  createAcpRuntime,
  formatAcpBackendLabel,
} from "./runtime.js";

function createTestConfig(): Config {
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "gemini",
      enabledBackends: ["gemini"],
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
      geminiSpawnCommand: "gemini",
      geminiSpawnArgs: ["--acp"],
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
      cardUpdateThrottleMs: 200,
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
      sessionHistoryEnabled: true,
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

test("Gemini backend is exposed by the runtime factory", () => {
  const runtime = createAcpRuntime(createTestConfig(), new EventEmitter() as any);
  assert.equal(runtime.backend, "gemini");
  assert.equal(formatAcpBackendLabel("gemini"), "Gemini CLI（gemini --acp）");
});

test("runtime status reflects successful on-demand recovery", () => {
  const registry = new AcpRuntimeRegistry(createTestConfig());
  (registry as any).runtimes.set("gemini", {
    runtime: {
      backend: "gemini",
      initializeResult: { protocolVersion: "test" },
    },
    state: "error",
    errorAt: 1,
    errorMessage: "previous startup failure",
  });

  const status = registry.getRuntimeStatus("gemini");
  assert.equal(status.state, "ready");
  assert.equal(status.errorAt, undefined);
  assert.equal(status.errorMessage, undefined);
});
