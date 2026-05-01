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

function codexConfigOptions(
  currentModel = "gpt-5.5",
  currentEffort = "medium",
) {
  return [
    {
      id: "model",
      category: "model",
      currentValue: currentModel,
      options: [
        { value: "gpt-5.5", name: "gpt-5.5" },
        { value: "gpt-5.4", name: "gpt-5.4" },
      ],
    },
    {
      id: "reasoning_effort",
      category: "thought_level",
      currentValue: currentEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra high" },
      ],
    },
  ];
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

test("Runtime preserves selector-rich model list when config options only contain base models", () => {
  const handler = new EventEmitter() as any;
  const runtime = new ClaudeAcpRuntime(createTestConfig("claude"), handler);

  (runtime as any).sessionModelStates.set("session-1", {
    currentModelId: "claude-opus-4-6/medium",
    availableModels: [
      { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { modelId: "claude-opus-4-6/high", name: "Claude Opus 4.6 / high" },
    ],
  });

  handler.emit("acp", {
    type: "config_option_update",
    sessionId: "session-1",
    summary: "配置项已更新",
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "claude-opus-4-6",
        options: [
          { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
        ],
      },
      {
        id: "reasoning_effort",
        category: "thought_level",
        currentValue: "high",
        options: [{ value: "high", name: "High" }],
      },
    ],
  });

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "claude-opus-4-6/high",
    availableModels: [
      { modelId: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { modelId: "claude-opus-4-6/high", name: "Claude Opus 4.6 / high" },
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

test("Codex runtime derives gpt-5.5 effort selectors from config option updates", () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  handler.emit("acp", {
    type: "config_option_update",
    sessionId: "session-1",
    summary: "配置项已更新",
    configOptions: codexConfigOptions("gpt-5.5", "high"),
  });

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "gpt-5.5/high",
    availableModels: [
      { modelId: "gpt-5.5/low", name: "gpt-5.5 (low)" },
      { modelId: "gpt-5.5/medium", name: "gpt-5.5 (medium)" },
      { modelId: "gpt-5.5/high", name: "gpt-5.5 (high)" },
      { modelId: "gpt-5.5/xhigh", name: "gpt-5.5 (xhigh)" },
      { modelId: "gpt-5.4/low", name: "gpt-5.4 (low)" },
      { modelId: "gpt-5.4/medium", name: "gpt-5.4 (medium)" },
      { modelId: "gpt-5.4/high", name: "gpt-5.4 (high)" },
      { modelId: "gpt-5.4/xhigh", name: "gpt-5.4 (xhigh)" },
    ],
  });
});

test("Codex runtime consumes config options from session/new responses", async () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);

  (runtime as any).connection = {
    async newSession(): Promise<unknown> {
      return {
        sessionId: "session-1",
        configOptions: codexConfigOptions("gpt-5.5", "medium"),
      };
    },
  };
  (runtime as any).initResult = {};

  await runtime.newSession("/tmp");

  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "gpt-5.5/medium",
    availableModels: [
      { modelId: "gpt-5.5/low", name: "gpt-5.5 (low)" },
      { modelId: "gpt-5.5/medium", name: "gpt-5.5 (medium)" },
      { modelId: "gpt-5.5/high", name: "gpt-5.5 (high)" },
      { modelId: "gpt-5.5/xhigh", name: "gpt-5.5 (xhigh)" },
      { modelId: "gpt-5.4/low", name: "gpt-5.4 (low)" },
      { modelId: "gpt-5.4/medium", name: "gpt-5.4 (medium)" },
      { modelId: "gpt-5.4/high", name: "gpt-5.4 (high)" },
      { modelId: "gpt-5.4/xhigh", name: "gpt-5.4 (xhigh)" },
    ],
  });
});

test("Codex runtime sets non-default model effort through config options when available", async () => {
  const handler = new EventEmitter() as any;
  const runtime = new CodexAcpRuntime(createTestConfig("codex"), handler);
  const calls: Array<{ configId: string; value: string }> = [];
  let currentModel = "gpt-5.5";
  let currentEffort = "medium";

  handler.emit("acp", {
    type: "config_option_update",
    sessionId: "session-1",
    summary: "配置项已更新",
    configOptions: codexConfigOptions(currentModel, currentEffort),
  });

  (runtime as any).connection = {
    async setSessionConfigOption(params: {
      configId: string;
      value: string;
    }): Promise<unknown> {
      calls.push({ configId: params.configId, value: params.value });
      if (params.configId === "model") {
        currentModel = params.value;
      }
      if (params.configId === "reasoning_effort") {
        currentEffort = params.value;
      }
      return {
        configOptions: codexConfigOptions(currentModel, currentEffort),
      };
    },
    async unstable_setSessionModel(): Promise<void> {
      throw new Error("unstable_setSessionModel should not be called");
    },
  };
  (runtime as any).initResult = {};

  await runtime.setSessionModel("session-1", "gpt-5.4/high");

  assert.deepEqual(calls, [
    { configId: "model", value: "gpt-5.4" },
    { configId: "reasoning_effort", value: "high" },
  ]);
  assert.equal(
    runtime.getSessionModelState("session-1")?.currentModelId,
    "gpt-5.4/high",
  );
});
