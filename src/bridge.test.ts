import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config/index.js";
import { Bridge, formatNumber, formatPercent, formatSessionUsage } from "./bridge/bridge.js";
import type { BridgeAcpRuntime } from "./acp/runtime-contract.js";
import type { FeishuMessage } from "./feishu/bot.js";

function createTestConfig(): Config {
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "cursor-official",
      enabledBackends: ["cursor-official", "codex"],
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
      adminUserIds: ["user-1"],
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: "/tmp/sessions.json",
      cardUpdateThrottleMs: 0,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: "/tmp/workspace-presets.json",
      workspacePresetsSeed: [],
      maintenanceStatePath: "/tmp/bridge-maintenance-state.json",
      singleInstanceLockPath: "/tmp/bridge.lock",
      allowMultipleInstances: false,
      managedByService: true,
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

function createMessage(content: string, overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    content,
    contentType: "text",
    mentions: [],
    inlineMentionIds: [],
    senderId: "user-1",
    senderType: "user",
    chatType: "p2p",
    replyInThread: false,
    ...overrides,
  } as unknown as FeishuMessage;
}

test("formatPercent 与 formatNumber 按 status 展示需要格式化数值", () => {
  assert.equal(formatPercent(1.119263157894737), "1.1%");
  assert.equal(formatPercent(25), "25%");
  assert.equal(formatNumber(10633), "10,633");
});

test("formatSessionUsage 返回 context 百分比与 token 占用", () => {
  assert.equal(
    formatSessionUsage({
      usedTokens: 10633,
      maxTokens: 950000,
      percent: 1.119263157894737,
    }),
    "1.1% (10,633 / 950,000)",
  );
  assert.equal(formatSessionUsage(undefined), undefined);
});

test("/status 会显示当前模型与 context 用量", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];

  const runtime: Partial<BridgeAcpRuntime> = {
    getSessionModeState() {
      return {
        currentModeId: "auto",
        availableModes: [{ modeId: "auto", name: "Auto" }],
      };
    },
    getSessionModelState() {
      return {
        currentModelId: "gpt-5.4",
        availableModels: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
      };
    },
    getSessionUsageState() {
      return {
        usedTokens: 10633,
        maxTokens: 950000,
        percent: 1.119263157894737,
      };
    },
  };

  (bridge as any).runtimeRegistry = {
    getRuntime() {
      return runtime;
    },
  };
  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).isManagedByService = async () => true;
  (bridge as any).maintenanceStateStore = {
    getLastTask() {
      return {
        kind: "restart",
        status: "succeeded",
        requestedBy: "user-1",
        requestedAt: 1_710_000_000_000,
        finishedAt: 1_710_000_060_000,
        forced: false,
      };
    },
  };
  (bridge as any).sessionManager = {
    async getSessionSnapshotLoaded() {
      return {
        sessionKey: "dm:user-1",
        idleExpiresInMs: 60_000,
        group: {
          slots: [],
          activeSlotIndex: 1,
          nextSlotIndex: 2,
        },
        activeSlot: {
          slotIndex: 1,
          session: {
            backend: "codex",
            sessionId: "session-1",
            workspaceRoot: "/tmp/project",
            chatId: "chat-1",
            userId: "user-1",
            chatType: "p2p",
            createdAt: 0,
            lastActiveAt: 0,
          },
        },
      };
    },
    getStats() {
      return { active: 1, total: 1 };
    },
  };
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(createMessage("/status"));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /当前 session backend：codex/);
  assert.match(sentTexts[0] ?? "", /维护命令：已启用/);
  assert.match(sentTexts[0] ?? "", /上次维护：\/restart 成功/);
  assert.match(sentTexts[0] ?? "", /当前模式：`auto`/);
  assert.match(sentTexts[0] ?? "", /当前模型：GPT-5\.4/);
  assert.match(sentTexts[0] ?? "", /Context 用量：1\.1% \(10,633 \/ 950,000\)/);
});

test("/whoami 会返回当前消息识别到的飞书用户 ID", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(
    createMessage("/whoami", { senderId: "ou_admin_123" }),
  );

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /ou_admin_123/);
  assert.match(sentTexts[0] ?? "", /BRIDGE_ADMIN_USER_IDS/);
  assert.match(sentTexts[0] ?? "", /open_id/);
});

test("/update --force 会执行构建并登记待重启状态", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  const pendingRestarts: unknown[] = [];
  let scheduledKind: string | undefined;
  let updateBuildCalls = 0;

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).isManagedByService = async () => true;
  (bridge as any).runBridgeUpdateBuild = async () => {
    updateBuildCalls += 1;
    return "build ok";
  };
  (bridge as any).scheduleSelfRestart = (kind: string) => {
    scheduledKind = kind;
  };
  (bridge as any).maintenanceStateStore = {
    async setPendingRestart(task: unknown) {
      pendingRestarts.push(task);
    },
    async setLastTask(): Promise<void> {
      throw new Error("unexpected failure");
    },
    getLastTask() {
      return undefined;
    },
  };
  (bridge as any).activePrompts = new Set(["dm:user-1:1"]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(createMessage("/update --force"));

  assert.equal(updateBuildCalls, 1);
  assert.equal(pendingRestarts.length, 1);
  assert.equal(scheduledKind, "update");
  assert.match(sentTexts[0] ?? "", /已开始执行 `\/update`/);
  assert.match(sentTexts[1] ?? "", /npm install/);
});

test("/restart 会拒绝非管理员", async () => {
  const config = createTestConfig();
  config.bridge.adminUserIds = ["admin-user"];
  const bridge = new Bridge(config);
  const sentTexts: string[] = [];

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(createMessage("/restart"));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /仅允许管理员执行/);
});

test("/model 在 codex backend 切换成功后会持久化首选模型", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  const preferredModels: string[] = [];
  const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).runtimeRegistry = {
    getRuntime() {
      return {
        getSessionModelState() {
          return {
            currentModelId: "gpt-5.4/medium",
            availableModels: [
              { modelId: "gpt-5.4/medium", name: "GPT-5.4 (medium)" },
              { modelId: "gpt-5.3-codex/low", name: "GPT-5.3 Codex (low)" },
            ],
          };
        },
        async setSessionModel(sessionId: string, modelId: string): Promise<void> {
          setModelCalls.push({ sessionId, modelId });
        },
      };
    },
  };
  (bridge as any).sessionManager = {
    async getActiveSession() {
      return {
        backend: "codex",
        sessionId: "session-1",
        workspaceRoot: "/tmp/project",
        chatId: "chat-1",
        userId: "user-1",
        chatType: "p2p",
        createdAt: 0,
        lastActiveAt: 0,
      };
    },
    setActiveSessionPreferredModel(
      _chatId: string,
      _userId: string,
      _chatType: string,
      modelId: string,
    ) {
      preferredModels.push(modelId);
    },
  };
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };
  (bridge as any).flushPendingSessionNotices = async () => {};

  await (bridge as any).handleFeishuMessage(createMessage("/model 2"));

  assert.deepEqual(setModelCalls, [
    { sessionId: "session-1", modelId: "gpt-5.3-codex/low" },
  ]);
  assert.deepEqual(preferredModels, ["gpt-5.3-codex/low"]);
  assert.match(sentTexts[0] ?? "", /已按序号 2 切换为 `gpt-5\.3-codex\/low`/);
});
