import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Config } from "./config/index.js";
import { ClaudeAcpRuntime } from "./acp/claude-runtime.js";
import { CodexAcpRuntime } from "./acp/codex-runtime.js";

function createTestConfig(
  backend: Config["acp"]["backend"],
): Config {
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend,
      enabledBackends: [backend],
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
      workspaceRoot: "/tmp",
      allowedWorkspaceRoots: ["/tmp"],
      adapterSessionDir: "/tmp/acp-sessions",
    },
    bridge: {
      adminUserIds: [],
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
      showAcpAvailableCommands: false,
    },
    autoApprovePermissions: false,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}

test("Claude runtime does not fall back to prompt totalTokens when usage_update reports zero", () => {
  const handler = new EventEmitter() as any;
  const runtime = new ClaudeAcpRuntime(createTestConfig("claude"), handler);

  handler.emit("acp", {
    type: "usage_update",
    sessionId: "session-1",
    summary: "usage updated",
    usage: {
      usedTokens: 0,
      maxTokens: 1_000_000,
      percent: 0,
    },
  });

  (runtime as any).sessionPromptUsageFallbacks.set("session-1", 20_325);

  assert.deepEqual(runtime.getSessionUsageState("session-1"), {
    usedTokens: 0,
    maxTokens: 1_000_000,
    percent: 0,
  });
});

test("Non-Claude runtimes still use prompt totalTokens as a fallback when usage_update reports zero", () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  handler.emit("acp", {
    type: "usage_update",
    sessionId: "session-1",
    summary: "usage updated",
    usage: {
      usedTokens: 0,
      maxTokens: 216_000,
      percent: 0,
    },
  });

  (runtime as any).sessionPromptUsageFallbacks.set("session-1", 83_000);

  assert.deepEqual(runtime.getSessionUsageState("session-1"), {
    usedTokens: 83_000,
    maxTokens: 216_000,
    percent: (83_000 / 216_000) * 100,
  });
});

test("Claude runtime accepts later zero usage_update values for Claude sessions", () => {
  const handler = new EventEmitter() as any;
  const runtime = new ClaudeAcpRuntime(createTestConfig("claude"), handler);

  handler.emit("acp", {
    type: "usage_update",
    sessionId: "session-1",
    summary: "raw sdk usage",
    usage: {
      usedTokens: 20_965,
      maxTokens: 1_000_000,
      percent: (20_965 / 1_000_000) * 100,
    },
  });

  handler.emit("acp", {
    type: "usage_update",
    sessionId: "session-1",
    summary: "standard acp zero usage",
    usage: {
      usedTokens: 0,
      maxTokens: 1_000_000,
      percent: 0,
    },
  });

  assert.deepEqual(runtime.getSessionUsageState("session-1"), {
    usedTokens: 0,
    maxTokens: 1_000_000,
    percent: 0,
  });
});
