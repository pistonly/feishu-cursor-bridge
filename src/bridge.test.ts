import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Config } from "./config/index.js";
import { Bridge } from "./bridge/bridge.js";
import { preprocessBridgeMessage } from "./bridge/bridge-message-preprocess.js";
import { resolvePromptContentFromResource } from "./bridge/bridge-resource-prompt.js";
import {
  appendSlotErrorLog,
  appendSlotPromptLog,
} from "./bridge/bridge-slot-logging.js";
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
      slotMessageLogEnabled: false,
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
  ((bridge as any).promptCoordinator as any).activePrompts = new Set(["dm:user-1:1"]);
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
  ((bridge as any).promptCoordinator as any).activePrompts = new Set(["dm:user-1:1"]);
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
  config.bridge.slotMessageLogEnabled = true;

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

test("默认不会写 slot 调试日志", async () => {
  const tmpRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "bridge-slot-log-disabled-"),
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
        async handleUserPrompt() {
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
  await assert.rejects(fsp.access(logDir));
});

test("preprocessBridgeMessage 会在群消息中分别使用单行与多行内容", async () => {
  const msg = createMessage("@bot raw", {
    chatType: "group",
    mentions: [{ name: "bot" }] as never[],
  });
  const result = await preprocessBridgeMessage(
    {
      config: { bridgeDebug: false },
      feishuBot: {
        getGroupMentionIgnoredDebug(msg: FeishuMessage) {
          return {
            messageId: msg.messageId,
            chatId: msg.chatId,
            contentType: msg.contentType,
            mentionCount: msg.mentions?.length ?? 0,
            messageMentionIds: [],
            inlineMentionIds: msg.inlineMentionIds,
            bot: { resolved: false },
            hint: "ignored",
          };
        },
        isBotMentioned() {
          return false;
        },
        async isPairUserBotGroup() {
          return true;
        },
        stripBotMention() {
          return "单行命令";
        },
        stripBotMentionKeepLines() {
          return "多行\n命令";
        },
      },
    },
    msg,
  );

  assert.equal(result?.content, "单行命令");
  assert.equal(result?.contentMultiline, "多行\n命令");
  assert.equal(result?.hasIncomingResource, false);
  assert.equal(result?.hasPostEmbeddedImages, false);
});

test("preprocessBridgeMessage 会忽略 markdown 包裹的 /topic", async () => {
  const result = await preprocessBridgeMessage(
    {
      config: { bridgeDebug: false },
      feishuBot: {
        getGroupMentionIgnoredDebug(msg: FeishuMessage) {
          return {
            messageId: msg.messageId,
            chatId: msg.chatId,
            contentType: msg.contentType,
            mentionCount: msg.mentions?.length ?? 0,
            messageMentionIds: [],
            inlineMentionIds: msg.inlineMentionIds,
            bot: { resolved: false },
            hint: "ignored",
          };
        },
        isBotMentioned() {
          return false;
        },
        async isPairUserBotGroup() {
          return false;
        },
        stripBotMention(content: string) {
          return content;
        },
        stripBotMentionKeepLines(content: string) {
          return content;
        },
      },
    },
    createMessage("**/topic 发布说明**"),
  );

  assert.equal(result, null);
});

test("resolvePromptContentFromResource 会格式化飞书附件提示", async () => {
  const downloads: Array<{ messageId: string; workspaceRoot: string }> = [];
  const msg = createMessage("请查看附件", {
    incomingResource: {
      apiType: "file",
      fileKey: "file-1",
      messageKind: "file",
      displayName: "spec.pdf",
    } as never,
  });
  const session = {
    backend: "cursor-official" as const,
    sessionId: "session-1",
    workspaceRoot: "/tmp/project",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "p2p" as const,
    createdAt: 0,
    lastActiveAt: 0,
  };

  const result = await resolvePromptContentFromResource(
    {
      feishuBot: {
        async downloadIncomingResourceToWorkspace(messageId, _resource, workspaceRoot) {
          downloads.push({ messageId, workspaceRoot });
          return {
            relativePath: ".feishu-incoming/spec.pdf",
            absPath: "/tmp/project/.feishu-incoming/spec.pdf",
          };
        },
      },
    },
    msg,
    session,
    "请查看附件",
    false,
  );

  assert.deepEqual(downloads, [{ messageId: "msg-1", workspaceRoot: "/tmp/project" }]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.promptContent, /用户通过飞书发送了文件/);
    assert.match(result.promptContent, /\.feishu-incoming\/spec\.pdf/);
    assert.match(result.promptContent, /spec\.pdf/);
  }
});

test("resolvePromptContentFromResource 会返回结构化的飞书附件下载错误", async () => {
  const result = await resolvePromptContentFromResource(
    {
      feishuBot: {
        async downloadIncomingResourceToWorkspace() {
          throw {
            message: "Internal error",
            code: -32603,
            data: {
              details: "download failed",
              fileKey: "file-1",
            },
          };
        },
      },
    },
    createMessage("请查看附件", {
      incomingResource: {
        apiType: "file",
        fileKey: "file-1",
        messageKind: "file",
        displayName: "spec.pdf",
      } as never,
    }),
    {
      backend: "cursor-official",
      sessionId: "session-1",
      workspaceRoot: "/tmp/project",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "p2p",
      createdAt: 0,
      lastActiveAt: 0,
    },
    "请查看附件",
    false,
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errorText, /❌ 无法下载飞书附件:/);
    assert.match(result.errorText, /Internal error/);
    assert.match(result.errorText, /JSON-RPC code: -32603/);
    assert.match(result.errorText, /"details": "download failed"/);
    assert.doesNotMatch(result.errorText, /\[object Object\]/);
  }
});

test("resolvePromptContentFromResource 会返回结构化的富文本图片下载错误", async () => {
  const result = await resolvePromptContentFromResource(
    {
      feishuBot: {
        async downloadIncomingResourceToWorkspace() {
          throw {
            message: "Internal error",
            code: -32603,
            data: {
              details: "download failed",
              imageKey: "img-1",
            },
          };
        },
      },
    },
    createMessage("正文", {
      contentType: "post",
      postEmbeddedImageKeys: ["img-1", "img-2"],
    }),
    {
      backend: "cursor-official",
      sessionId: "session-1",
      workspaceRoot: "/tmp/project",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "p2p",
      createdAt: 0,
      lastActiveAt: 0,
    },
    "正文",
    true,
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errorText, /❌ 无法下载飞书富文本内嵌图片:/);
    assert.match(result.errorText, /Internal error/);
    assert.match(result.errorText, /JSON-RPC code: -32603/);
    assert.match(result.errorText, /"details": "download failed"/);
    assert.doesNotMatch(result.errorText, /\[object Object\]/);
  }
});

test("appendSlotPromptLog 会把上下文透传给 store", async () => {
  const slot = {
    slotIndex: 2,
    name: "debug",
    session: {
      backend: "cursor-official" as const,
      sessionId: "session-2",
      workspaceRoot: "/tmp/project",
      chatId: "chat-1",
      userId: "user-1",
      chatType: "p2p" as const,
      createdAt: 0,
      lastActiveAt: 0,
    },
  };
  const calls: Array<{ entry: unknown; raw: string; prompt: string }> = [];

  await appendSlotPromptLog(
    {
      slotMessageLog: {
        async appendPrompt(entry: unknown, raw: string, prompt: string) {
          calls.push({ entry, raw, prompt });
        },
      } as never,
      sessionKey: "dm:user-1",
      slot,
      session: slot.session,
      msg: createMessage("原始消息"),
    },
    "飞书原文",
    "Agent Prompt",
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    entry: {
      sessionKey: "dm:user-1",
      slot,
      session: slot.session,
      msg: createMessage("原始消息"),
    },
    raw: "飞书原文",
    prompt: "Agent Prompt",
  });
});



test("忙时新消息会进入排队并提示可撤销", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  let releaseFirstPrompt: (() => void) | undefined;
  const handledPrompts: string[] = [];

  const slot = {
    slotIndex: 1,
    session: {
      backend: "cursor-official" as const,
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
        group: { slots: [slot], activeSlotIndex: 1, nextSlotIndex: 2 },
        activeSlot: slot,
        idleExpiresInMs: 60_000,
      };
    },
    async getSlot(_chatId: string, _userId: string, _chatType: string, target: number | null) {
      assert.equal(target, 1);
      return slot;
    },
    setSlotLastTurn() {},
  };
  (bridge as any).conversations = new Map([
    [
      "cursor-official",
      {
        async handleUserPrompt(msg: FeishuMessage) {
          handledPrompts.push(msg.content);
          if (handledPrompts.length === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstPrompt = resolve;
            });
          }
          return `reply:${msg.content}`;
        },
      },
    ],
  ]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
    async sendCard(): Promise<string> {
      return "card-1";
    },
    async updateCard(): Promise<void> {},
  };

  const first = (bridge as any).handleFeishuMessage(createMessage("first"));
  await Promise.resolve();
  await (bridge as any).handleFeishuMessage(createMessage("second", { messageId: "msg-2" }));

  assert.match(sentTexts[sentTexts.length - 1] ?? "", /已加入排队/);
  assert.match(sentTexts[sentTexts.length - 1] ?? "", /\/cancel/);

  releaseFirstPrompt?.();
  await first;

  assert.deepEqual(handledPrompts, ["first", "second"]);
  assert.ok(sentTexts.some((text) => /已开始处理刚才排队的消息/.test(text)));
});

test("忙时后来的排队消息会覆盖之前的排队消息", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];
  let releaseFirstPrompt: (() => void) | undefined;
  const handledPrompts: string[] = [];

  const slot = {
    slotIndex: 1,
    session: {
      backend: "cursor-official" as const,
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
        group: { slots: [slot], activeSlotIndex: 1, nextSlotIndex: 2 },
        activeSlot: slot,
        idleExpiresInMs: 60_000,
      };
    },
    async getSlot() {
      return slot;
    },
    setSlotLastTurn() {},
  };
  (bridge as any).conversations = new Map([
    [
      "cursor-official",
      {
        async handleUserPrompt(msg: FeishuMessage) {
          handledPrompts.push(msg.content);
          if (handledPrompts.length === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstPrompt = resolve;
            });
          }
          return `reply:${msg.content}`;
        },
      },
    ],
  ]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
    async sendCard(): Promise<string> {
      return "card-1";
    },
    async updateCard(): Promise<void> {},
  };

  const first = (bridge as any).handleFeishuMessage(createMessage("first"));
  await Promise.resolve();
  await (bridge as any).handleFeishuMessage(createMessage("second", { messageId: "msg-2" }));
  await (bridge as any).handleFeishuMessage(createMessage("third", { messageId: "msg-3" }));

  assert.ok(sentTexts.some((text) => /替换之前的排队消息/.test(text)));

  releaseFirstPrompt?.();
  await first;

  assert.deepEqual(handledPrompts, ["first", "third"]);
});

test("结构化 prompt 错误会在飞书里展示具体细节而不是 [object Object]", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];

  const slot = {
    slotIndex: 1,
    session: {
      backend: "cursor-official" as const,
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
        group: { slots: [slot], activeSlotIndex: 1, nextSlotIndex: 2 },
        activeSlot: slot,
        idleExpiresInMs: 60_000,
      };
    },
    async getSlot() {
      return slot;
    },
    setSlotLastTurn() {},
  };
  (bridge as any).conversations = new Map([
    [
      "cursor-official",
      {
        async handleUserPrompt() {
          throw {
            message: "Internal error",
            code: -32603,
            data: {
              details: "spawn ENOENT",
              command: "missing-binary",
            },
          };
        },
      },
    ],
  ]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
    async sendCard(): Promise<string> {
      return "card-1";
    },
    async updateCard(): Promise<void> {},
  };

  await (bridge as any).handleFeishuMessage(createMessage("first"));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /❌ 处理出错: Internal error/);
  assert.match(sentTexts[0] ?? "", /JSON-RPC code: -32603/);
  assert.match(sentTexts[0] ?? "", /"details": "spawn ENOENT"/);
  assert.doesNotMatch(sentTexts[0] ?? "", /\[object Object\]/);
});

test("appendSlotErrorLog 会吞掉 store 写入失败并告警", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await appendSlotErrorLog(
      {
        slotMessageLog: {
          async appendError() {
            throw new Error("write failed");
          },
        } as never,
        sessionKey: "dm:user-1",
        slot: {
          slotIndex: 3,
          session: {
            backend: "cursor-official",
            sessionId: "session-3",
            workspaceRoot: "/tmp/project",
            chatId: "chat-1",
            userId: "user-1",
            chatType: "p2p",
            createdAt: 0,
            lastActiveAt: 0,
          },
        } as never,
        session: {
          backend: "cursor-official",
          sessionId: "session-3",
          workspaceRoot: "/tmp/project",
          chatId: "chat-1",
          userId: "user-1",
          chatType: "p2p",
          createdAt: 0,
          lastActiveAt: 0,
        },
        msg: createMessage("原始消息"),
      },
      "错误文本",
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /failed to append slot error log/);
  assert.equal(warnings[0]?.[1], "write failed");
});

test("/cancel 在仅有排队消息时会撤销排队", async () => {
  const bridge = new Bridge(createTestConfig());
  const sentTexts: string[] = [];

  const slot = {
    slotIndex: 1,
    name: "main",
    session: {
      backend: "cursor-official" as const,
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
  (bridge as any).sessionManager = {
    getSessionSnapshot() {
      return {
        sessionKey: "dm:user-1",
        group: { slots: [slot], activeSlotIndex: 1, nextSlotIndex: 2 },
        activeSlot: slot,
        idleExpiresInMs: 60_000,
      };
    },
  };
  ((bridge as any).promptCoordinator as any).queuedPrompts = new Map([
    [
      "dm:user-1:1",
      {
        msg: createMessage("queued", { messageId: "msg-q" }),
        content: "queued",
        hasPostEmbeddedImages: false,
        slotIndex: 1,
      },
    ],
  ]);
  (bridge as any).feishuBot = {
    stripBotMentionKeepLines(content: string) {
      return content;
    },
    async sendText(_chatId: string, body: string): Promise<void> {
      sentTexts.push(body);
    },
  };

  await (bridge as any).handleFeishuMessage(createMessage("/cancel"));

  assert.equal(
    ((bridge as any).promptCoordinator as any).queuedPrompts.size,
    0,
  );
  assert.match(sentTexts[0] ?? "", /已撤销当前槽位中的排队消息/);
});
