import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

test("/upgrade 会拒绝未启用命令", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).isManagedByService = async () => true;
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(createMessage("/upgrade"));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /未启用聊天升级命令/);
});

test("/upgrade 会写入 queued 状态并启动后台 runner", async () => {
  const config = createTestConfig();
  config.bridge.enableUpgradeCommand = true;
  config.bridge.upgradeAdmins.openIds.add("ou_admin_123");
  const bridge = new Bridge(config);
  const sentTexts: string[] = [];
  const attempts: unknown[] = [];
  let flushCalls = 0;
  let launchedAttemptId: string | undefined;

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).isManagedByService = async () => true;
  (bridge as any).launchBackgroundUpgrade = (attemptId: string) => {
    launchedAttemptId = attemptId;
  };
  (bridge as any).upgradeResultStore = {
    getAttempt() {
      return undefined;
    },
    setAttempt(attempt: unknown) {
      attempts.push(attempt);
    },
    async flush(): Promise<void> {
      flushCalls += 1;
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

  await (bridge as any).handleFeishuMessage(
    createMessage("/upgrade", {
      senderId: "ou_admin_123",
      senderIds: { openId: "ou_admin_123" },
    }),
  );

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /已接受升级请求/);
  assert.equal(flushCalls, 1);
  assert.equal(attempts.length, 1);
  assert.equal(typeof launchedAttemptId, "string");
  assert.equal((attempts[0] as { state?: string }).state, "queued");
  assert.equal((attempts[0] as { requestedBy?: { senderId?: string } }).requestedBy?.senderId, "ou_admin_123");
  assert.equal((attempts[0] as { id?: string }).id, launchedAttemptId);
});

test("/upgrade 在 active prompt 存在时仅允许 --force", async () => {
  const config = createTestConfig();
  config.bridge.enableUpgradeCommand = true;
  config.bridge.upgradeAdmins.openIds.add("ou_admin_123");
  const bridge = new Bridge(config);
  const sentTexts: string[] = [];
  let launchCalls = 0;

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).isManagedByService = async () => true;
  (bridge as any).activePrompts = new Set(["dm:user-1:1"]);
  (bridge as any).launchBackgroundUpgrade = () => {
    launchCalls += 1;
  };
  (bridge as any).upgradeResultStore = {
    getAttempt() {
      return undefined;
    },
    setAttempt(): void {},
    async flush(): Promise<void> {},
  };
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(
    createMessage("/upgrade", {
      senderId: "ou_admin_123",
      senderIds: { openId: "ou_admin_123" },
    }),
  );
  await (bridge as any).handleFeishuMessage(
    createMessage("/upgrade --force", {
      senderId: "ou_admin_123",
      senderIds: { openId: "ou_admin_123" },
    }),
  );

  assert.equal(launchCalls, 1);
  assert.match(sentTexts[0] ?? "", /当前仍有 1 个请求在处理中/);
  assert.match(sentTexts[1] ?? "", /已接受升级请求（--force）/);
});


test("/model 在 codex backend 切换成功后会持久化首选模型", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  const preferredModels: string[] = [];
  const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
  let currentModelId = "gpt-5.4/medium";

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).runtimeRegistry = {
    getRuntime() {
      return {
        getSessionModelState() {
          return {
            currentModelId,
            availableModels: [
              { modelId: "gpt-5.4/medium", name: "GPT-5.4 (medium)" },
              { modelId: "gpt-5.3-codex/low", name: "GPT-5.3 Codex (low)" },
            ],
          };
        },
        async setSessionModel(sessionId: string, modelId: string): Promise<void> {
          setModelCalls.push({ sessionId, modelId });
          currentModelId = modelId;
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

test("/model 成功后提示会回显运行时确认的当前模型", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  let currentModelId = "claude-opus-4-6";

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).runtimeRegistry = {
    getRuntime() {
      return {
        getSessionModelState() {
          return {
            currentModelId,
            availableModels: [{ modelId: "claude-opus-4-6", name: "Claude Opus 4.6" }],
          };
        },
        async setSessionModel(_sessionId: string, _modelId: string): Promise<void> {
          currentModelId = "claude-opus-4-6";
        },
      };
    },
  };
  (bridge as any).sessionManager = {
    async getActiveSession() {
      return {
        backend: "cursor-official",
        sessionId: "session-1",
        workspaceRoot: "/tmp/project",
        chatId: "chat-1",
        userId: "user-1",
        chatType: "p2p",
        createdAt: 0,
        lastActiveAt: 0,
      };
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

  await (bridge as any).handleFeishuMessage(createMessage("/model asbc"));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /已切换模型为 `claude-opus-4-6`/);
});

test("普通对话会为当前 slot 追加用户问题与回复日志", async () => {
  const tmpRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "bridge-slot-log-"),
  );
  const config = createTestConfig();
  config.bridge.sessionStorePath = path.join(tmpRoot, "sessions.json");

  const bridge = new Bridge(config);
  const slot = {
    slotIndex: 1,
    name: "legacy-debug",
    session: {
      backend: "cursor-legacy" as const,
      sessionId: "session-1",
      workspaceRoot: "/tmp/project",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "p2p" as const,
      createdAt: 0,
      lastActiveAt: 0,
    },
  };

  (bridge as any).ensureMaintenanceStateLoaded = async () => {};
  (bridge as any).flushPendingSessionNotices = async () => {};
  (bridge as any).sessionManager = {
    getSessionSnapshot() {
      return {
        sessionKey: "dm:user-1",
        group: {
          slots: [slot],
          activeSlotIndex: 1,
          nextSlotIndex: 2,
        },
        activeSlot: slot,
        idleExpiresInMs: 60_000,
      };
    },
    async getActiveSession() {
      return slot.session;
    },
    async getSlot() {
      return slot;
    },
    setSlotLastTurn() {},
  };
  (bridge as any).conversations = new Map([
    [
      "cursor-legacy",
      {
        async handleUserPrompt(
          _msg: FeishuMessage,
          _session: unknown,
          opts?: { onAcpEvent?: (ev: unknown) => Promise<void> | void },
        ) {
          await opts?.onAcpEvent?.({
            type: "agent_message_chunk",
            sessionId: "session-1",
            text: "原始 chunk 片段",
          });
          return "当前仓库状态如下：有改动。";
        },
      },
    ],
  ]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(): Promise<void> {},
  };

  await (bridge as any).handleFeishuMessage(createMessage("检查项目当前的git状态"));

  const logDir = path.join(tmpRoot, "slot-logs");
  const files = await fsp.readdir(logDir);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? "", /^cursor-legacy--slot-1--legacy-debug--dm-user-1--session-session-1--[a-f0-9]{12}\.log$/);
  const content = await fsp.readFile(path.join(logDir, files[0]!), "utf8");
  assert.match(content, /feishu_prompt/);
  assert.match(content, /检查项目当前的git状态/);
  assert.match(content, /acp_agent_message_chunk/);
  assert.match(content, /原始 chunk 片段/);
  assert.match(content, /bridge_reply/);
  assert.match(content, /当前仓库状态如下：有改动。/);
});
