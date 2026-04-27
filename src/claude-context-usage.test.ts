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


test("Non-Claude runtimes do not overwrite model state with an unknown selector after setSessionModel", async () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  (runtime as any).connection = {
    async unstable_setSessionModel(): Promise<void> {},
  };
  (runtime as any).initResult = {};
  (runtime as any).sessionModelStates.set("session-1", {
    currentModelId: "claude-opus-4-6",
    availableModels: [{ modelId: "claude-opus-4-6", name: "Claude Opus 4.6" }],
  });

  await runtime.setSessionModel("session-1", "asbc");

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "claude-opus-4-6",
    availableModels: [{ modelId: "claude-opus-4-6", name: "Claude Opus 4.6" }],
  });
});

test("Non-Claude runtimes keep updating model state when setSessionModel uses a known model", async () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  (runtime as any).connection = {
    async unstable_setSessionModel(): Promise<void> {},
  };
  (runtime as any).initResult = {};
  (runtime as any).sessionModelStates.set("session-1", {
    currentModelId: "claude-opus-4-6",
    availableModels: [
      { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ],
  });

  await runtime.setSessionModel("session-1", "claude-sonnet-4-6");

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "claude-sonnet-4-6",
    availableModels: [
      { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ],
  });
});

test("Codex runtime enriches gpt-5.5 with effort selectors when ACP omits them", () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  (runtime as any).updateSessionModelState("session-1", {
    currentModelId: "gpt-5.5",
    availableModels: [
      { modelId: "gpt-5.5", name: "gpt-5.5" },
      { modelId: "gpt-5.4/low", name: "gpt-5.4 (low)" },
    ],
  });

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "gpt-5.5/medium",
    availableModels: [
      { modelId: "gpt-5.5/low", name: "gpt-5.5 (low)" },
      { modelId: "gpt-5.5/medium", name: "gpt-5.5 (medium)" },
      { modelId: "gpt-5.5/high", name: "gpt-5.5 (high)" },
      { modelId: "gpt-5.5/xhigh", name: "gpt-5.5 (xhigh)" },
      { modelId: "gpt-5.4/low", name: "gpt-5.4 (low)" },
    ],
  });
});
