import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexAppServerRuntime } from "./acp/codex-app-server-runtime.js";
import type { Config } from "./config/index.js";

function createBridgeClient(): EventEmitter & {
  setSessionWorkspace: (_sessionId: string, _workspaceRoot: string) => void;
  removeSessionWorkspace: (_sessionId: string) => void;
} {
  const bridgeClient = new EventEmitter() as EventEmitter & {
    setSessionWorkspace: (_sessionId: string, _workspaceRoot: string) => void;
    removeSessionWorkspace: (_sessionId: string) => void;
  };
  bridgeClient.setSessionWorkspace = () => {};
  bridgeClient.removeSessionWorkspace = () => {};
  return bridgeClient;
}

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
    createBridgeClient() as any,
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

test("CodexAppServerRuntime keeps current model when thread/started omits model", async () => {
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    createBridgeClient() as any,
  );

  (runtime as any).rpc = {
    async request(method: string): Promise<unknown> {
      if (method === "initialize") {
        return {};
      }
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.4",
              model: "gpt-5.4",
              displayName: "GPT-5.4",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
              ],
              defaultReasoningEffort: "medium",
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return {
          thread: { id: "thread-1" },
          model: "gpt-5.4",
          reasoningEffort: "medium",
        };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };

  await runtime.initializeAndAuth();
  const created = await runtime.newSession("/tmp");
  assert.equal(created.sessionId, "thread-1");
  assert.equal(
    runtime.getSessionModelState("thread-1")?.currentModelId,
    "gpt-5.4/medium",
  );

  await (runtime as any).handleServerNotification("thread/started", {
    thread: { id: "thread-1" },
  });

  assert.equal(
    runtime.getSessionModelState("thread-1")?.currentModelId,
    "gpt-5.4/medium",
  );
});

test("CodexAppServerRuntime uses default model selector when thread response omits model", async () => {
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    createBridgeClient() as any,
  );

  (runtime as any).rpc = {
    async request(method: string): Promise<unknown> {
      if (method === "initialize") {
        return {};
      }
      if (method === "model/list") {
        return {
          data: [
            {
              id: "gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              isDefault: false,
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              defaultReasoningEffort: "medium",
            },
            {
              id: "gpt-5.4",
              model: "gpt-5.4",
              displayName: "GPT-5.4",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        return {
          thread: { id: "thread-1" },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };

  await runtime.initializeAndAuth();
  await runtime.newSession("/tmp");

  assert.equal(
    runtime.getSessionModelState("thread-1")?.currentModelId,
    "gpt-5.4/high",
  );
});

test("CodexAppServerRuntime compactSession calls thread/compact/start", async () => {
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    createBridgeClient() as any,
  );
  const calls: Array<{ method: string; params: unknown }> = [];

  (runtime as any).initialized = true;
  (runtime as any).rpc = {
    async request(method: string, params: unknown): Promise<unknown> {
      calls.push({ method, params });
      return {};
    },
  };

  await runtime.compactSession("thread-1");

  assert.deepEqual(calls, [
    { method: "thread/compact/start", params: { threadId: "thread-1" } },
  ]);
});

test("CodexAppServerRuntime maps contextCompaction item to tool progress events", async () => {
  const bridgeClient = createBridgeClient();
  const events: unknown[] = [];
  bridgeClient.on("acp", (event) => {
    events.push(event);
  });
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    bridgeClient as any,
  );

  await (runtime as any).handleServerNotification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "contextCompaction", id: "item-1" },
  });
  await (runtime as any).handleServerNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "contextCompaction", id: "item-1" },
  });

  assert.deepEqual(events, [
    {
      type: "tool_call",
      sessionId: "thread-1",
      toolCallId: "context-compaction:thread-1",
      title: "Codex app-server compact",
      status: "in_progress",
    },
    {
      type: "tool_call_update",
      sessionId: "thread-1",
      toolCallId: "context-compaction:thread-1",
      title: "Codex app-server compact",
      status: "completed",
    },
  ]);
});

test("CodexAppServerRuntime uses last input tokens for approximate context usage", async () => {
  const bridgeClient = createBridgeClient();
  const events: unknown[] = [];
  bridgeClient.on("acp", (event) => {
    events.push(event);
  });
  const runtime = new CodexAppServerRuntime(
    createTestConfig(),
    bridgeClient as any,
  );

  await (runtime as any).handleServerNotification("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: 1_250_000,
        inputTokens: 900_000,
        cachedInputTokens: 0,
        outputTokens: 300_000,
        reasoningOutputTokens: 50_000,
      },
      last: {
        totalTokens: 260_000,
        inputTokens: 250_000,
        cachedInputTokens: 0,
        outputTokens: 8_000,
        reasoningOutputTokens: 2_000,
      },
      modelContextWindow: 1_000_000,
    },
  });

  assert.deepEqual(runtime.getSessionUsageState("thread-1"), {
    usedTokens: 250_000,
    maxTokens: 1_000_000,
    percent: 25,
  });
  assert.deepEqual(events.at(-1), {
    type: "usage_update",
    sessionId: "thread-1",
    summary: "用量统计已更新（25%）",
    usage: {
      usedTokens: 250_000,
      maxTokens: 1_000_000,
      percent: 25,
    },
  });
});
