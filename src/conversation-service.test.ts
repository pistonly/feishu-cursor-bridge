import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BridgeAcpEvent } from "./acp/types.js";
import { ConversationService } from "./bridge/conversation-service.js";
import type { Config } from "./config/index.js";
import type {
  AcpSessionModelState,
  AcpSessionUsageState,
  BridgeAcpRuntime,
} from "./acp/runtime-contract.js";
import type { FeishuMessage } from "./feishu/bot.js";
import type { UserSession } from "./session/manager.js";

function createTestConfig(): Config {
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "cursor-official",
      enabledBackends: ["cursor-official"],
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
      tmuxTsxCliEntry: "/tmp/tsx-cli.mjs",
      tmuxServerEntry: "/tmp/tmux-acp-server.ts",
      tmuxSessionStorePath: "/tmp/tmux-acp-sessions.json",
      tmuxStartCommand: undefined,
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

function createMessage(): FeishuMessage {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    content: "hello",
    contentType: "text",
    mentions: [],
    inlineMentionIds: [],
    senderId: "user-1",
    senderType: "user",
    chatType: "p2p",
    replyInThread: false,
  } as unknown as FeishuMessage;
}

function createSession(backend: UserSession["backend"] = "cursor-official"): UserSession {
  return {
    backend,
    sessionId: "session-1",
    workspaceRoot: "/tmp",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "p2p",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
}

function createHarness(
  events: BridgeAcpEvent[],
  configOverrides?: Partial<Config["bridge"]>,
) {
  const bridgeClient = new EventEmitter() as EventEmitter & {
    setFeishuPromptContext: (_sessionId: string, _ctx: unknown) => void;
  };
  bridgeClient.setFeishuPromptContext = () => {};
  const sendCardCalls: Array<{ id: string; content: string }> = [];
  const updateCardCalls: Array<{ id: string; content: string }> = [];

  const feishu = {
    async sendCard(_chatId: string, content: string): Promise<string> {
      const id = `card-${sendCardCalls.length + 1}`;
      sendCardCalls.push({ id, content });
      return id;
    },
    async updateCard(id: string, content: string): Promise<void> {
      updateCardCalls.push({ id, content });
    },
  };

  let modelState: AcpSessionModelState | undefined = {
    currentModelId: "auto",
    availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "gpt-5", name: "GPT-5" },
    ],
  };
  let usageState: AcpSessionUsageState | undefined;

  bridgeClient.on("acp", (ev: BridgeAcpEvent) => {
    if (ev.sessionId !== "session-1") return;
    if (ev.type === "config_option_update" && ev.configOptions?.length) {
      const currentModelId = ev.configOptions.find(
        (option) => option.id === "model" || option.category === "model",
      )?.currentValue;
      if (currentModelId) {
        modelState = {
          currentModelId,
          availableModels:
            modelState?.availableModels.map((model) => ({ ...model })) ?? [],
        };
      }
    }
    if (ev.type === "usage_update" && ev.usage) {
      usageState = { ...ev.usage };
    }
  });

  const runtime: BridgeAcpRuntime = {
    backend: "cursor-official",
    bridgeClient: bridgeClient as any,
    initializeResult: null,
    supportsLoadSession: true,
    supportsSetSessionMode: true,
    supportsSetSessionModel: true,
    async start(): Promise<void> {},
    async initializeAndAuth(): Promise<void> {},
    async newSession() {
      return { sessionId: "session-1" };
    },
    async loadSession(): Promise<void> {},
    async prompt(): Promise<{ stopReason: string }> {
      for (const ev of events) {
        bridgeClient.emit("acp", ev);
      }
      return { stopReason: "end_turn" };
    },
    async setSessionMode(): Promise<void> {},
    getSessionModeState() {
      return undefined;
    },
    async setSessionModel(): Promise<void> {},
    getSessionModelState() {
      return modelState;
    },
    getSessionUsageState() {
      return usageState;
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
    supportsCloseSession() {
      return false;
    },
    async stop(): Promise<void> {},
  } satisfies BridgeAcpRuntime;

  const config = createTestConfig();
  if (configOverrides) {
    Object.assign(config.bridge, configOverrides);
  }

  const service = new ConversationService(config, runtime, feishu as any);

  return { service, sendCardCalls, updateCardCalls, config, runtime, feishu };
}

test("ConversationService 会把交错的工具事件持续合并到同一张卡片", async () => {
  const { service, sendCardCalls, updateCardCalls } = createHarness([
    {
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "读取文件",
      status: "pending",
      kind: "read",
    },
    {
      type: "tool_call_update",
      sessionId: "session-1",
      toolCallId: "tool-1",
      status: "running",
    },
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "第一段回答。",
    },
    {
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: "tool-2",
      title: "写入文件",
      status: "pending",
      kind: "edit",
    },
    {
      type: "tool_call_update",
      sessionId: "session-1",
      toolCallId: "tool-2",
      status: "completed",
    },
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "第二段回答。",
    },
  ]);

  const reply = await service.handleUserPrompt(createMessage(), createSession());

  assert.equal(sendCardCalls.length, 1);
  assert.equal(updateCardCalls.every((call) => call.id === "card-1"), true);
  assert.match(reply ?? "", /📖 读取文件 — running/);
  assert.match(reply ?? "", /✏️ 写入文件 — completed/);
  assert.match(reply ?? "", /第一段回答。/);
  assert.match(reply ?? "", /第二段回答。/);
  const r = reply ?? "";
  assert.ok(
    r.indexOf("第一段回答。") < r.indexOf("第二段回答。"),
    "按时间线：第一工具段后的回答应出现在第二工具段后的回答之前",
  );
});

test("ConversationService 飞书 markdown 按 ACP 到达顺序排列思考与回答", async () => {
  const replyEarlyThought = await createHarness([
    {
      type: "agent_thought_chunk",
      sessionId: "session-1",
      text: "先思考\n",
    },
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "后回答",
    },
  ]).service.handleUserPrompt(createMessage(), createSession());

  const a1 = replyEarlyThought?.indexOf("🤔") ?? -1;
  const b1 = replyEarlyThought?.indexOf("后回答") ?? -1;
  assert.ok(a1 >= 0 && b1 >= 0);
  assert.ok(a1 < b1, "先到的思考应排在回答前");

  const replyEarlyAnswer = await createHarness([
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "先回答",
    },
    {
      type: "agent_thought_chunk",
      sessionId: "session-1",
      text: "\n后思考",
    },
  ]).service.handleUserPrompt(createMessage(), createSession());

  const a2 = replyEarlyAnswer?.indexOf("先回答") ?? -1;
  const b2 = replyEarlyAnswer?.indexOf("🤔") ?? -1;
  assert.ok(a2 >= 0 && b2 >= 0);
  assert.ok(a2 < b2, "先到的回答应排在思考前");
});

test("ConversationService 工具数超过 maxTools 时分段渲染但仍可合并为单张卡片", async () => {
  const events: BridgeAcpEvent[] = [];
  for (let i = 1; i <= 9; i += 1) {
    events.push({
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: `tool-${i}`,
      title: `工具 ${i}`,
      status: "pending",
    });
  }

  const { service, sendCardCalls, updateCardCalls } = createHarness(events);
  const reply = await service.handleUserPrompt(createMessage(), createSession());

  assert.equal(sendCardCalls.length, 1);
  assert.equal(updateCardCalls.every((call) => call.id === "card-1"), true);
  assert.match(reply ?? "", /🔧 工具 1 — pending/);
  assert.match(reply ?? "", /🔧 工具 8 — pending/);
  assert.match(reply ?? "", /🔧 工具 9 — pending/);
});

test("ConversationService 连续工具块合并后若超长仍会拆成多张卡片", async () => {
  const longTitle = "x".repeat(80);
  const events: BridgeAcpEvent[] = [];
  for (let i = 1; i <= 12; i += 1) {
    events.push({
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: `tool-${i}`,
      title: `${longTitle}-${i}`,
      status: "pending",
    });
  }

  const { service, sendCardCalls } = createHarness(events, {
    cardSplitMarkdownThreshold: 400,
    cardSplitToolThreshold: 8,
  });
  const reply = await service.handleUserPrompt(createMessage(), createSession());

  assert.ok(
    sendCardCalls.length >= 2,
    "合并后总 markdown 超过阈值时应拆成多条飞书消息",
  );
  assert.match(reply ?? "", new RegExp(`${longTitle}-1`));
  assert.match(reply ?? "", new RegExp(`${longTitle}-12`));
});

test("ConversationService 在长回答拆卡时仍保留完整 reply 内容", async () => {
  const longAnswer = "这是一段很长的回答。".repeat(40);
  const { service, sendCardCalls, updateCardCalls } = createHarness(
    [
      {
        type: "tool_call",
        sessionId: "session-1",
        toolCallId: "tool-1",
        title: "读取文件",
        status: "completed",
        kind: "read",
      },
      {
        type: "agent_message_chunk",
        sessionId: "session-1",
        text: longAnswer,
      },
    ],
    {
      cardSplitMarkdownThreshold: 180,
    },
  );

  const reply = await service.handleUserPrompt(createMessage(), createSession());
  const finalCard1 =
    updateCardCalls.filter((call) => call.id === "card-1").at(-1)?.content ?? "";

  assert.equal(sendCardCalls.length >= 3, true);
  assert.equal(
    updateCardCalls.some((call) => call.id === sendCardCalls.at(-1)?.id),
    true,
  );
  assert.match(finalCard1, /📖 读取文件 — completed/);
  assert.equal(
    sendCardCalls
      .slice(1)
      .some((call) => call.content.includes(longAnswer.slice(0, 30))),
    true,
  );
  assert.equal(reply?.includes(longAnswer), true);
  assert.equal(reply?.includes("📖 读取文件 — completed"), true);

  const lastCardId = sendCardCalls.at(-1)?.id ?? "";
  const firstCardFinal =
    updateCardCalls.filter((call) => call.id === "card-1").at(-1)?.content ?? "";
  const lastCardFinal =
    updateCardCalls.filter((call) => call.id === lastCardId).at(-1)?.content ?? "";
  assert.doesNotMatch(firstCardFinal, /`cursor-official` \|/);
  assert.match(lastCardFinal, /`cursor-official` \| Auto \| —/);
});

test("ConversationService 仅在 legacy backend 下把鉴权样式超时改写为 Cursor CLI 超时提示", async () => {
  const authLike =
    "Unable to process your request because cursor-agent CLI is not authenticated.\n\nPlease run cursor-agent login.";
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const legacy = createHarness([
      {
        type: "agent_message_chunk",
        sessionId: "session-1",
        text: authLike,
      },
    ]);
    const codex = createHarness([
      {
        type: "agent_message_chunk",
        sessionId: "session-1",
        text: authLike,
      },
    ]);

    now = 0;
    const legacyPromise = legacy.service.handleUserPrompt(
      createMessage(),
      createSession("cursor-legacy"),
    );
    now = 120_000;
    const legacyReply = await legacyPromise;

    now = 0;
    const codexPromise = codex.service.handleUserPrompt(
      createMessage(),
      createSession("codex"),
    );
    now = 120_000;
    const codexReply = await codexPromise;

    assert.match(legacyReply ?? "", /Cursor CLI 超时/);
    assert.match(legacyReply ?? "", /约 120 秒/);
    assert.doesNotMatch(codexReply ?? "", /Cursor CLI 超时/);
    assert.match(codexReply ?? "", /cursor-agent CLI is not authenticated/i);
  } finally {
    Date.now = originalNow;
  }
});

test("ConversationService 会按 legacy adapter timeout 动态改写超时提示", async () => {
  const authLike =
    "Unable to process your request because cursor-agent CLI is not authenticated.\n\nPlease run cursor-agent login.";
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const harness = createHarness([
      {
        type: "agent_message_chunk",
        sessionId: "session-1",
        text: authLike,
      },
    ]);
    harness.config.acp.extraArgs = ["--timeout", "45000"];
    const service = new ConversationService(
      harness.config,
      harness.runtime,
      harness.feishu as any,
    );

    now = 0;
    const replyPromise = service.handleUserPrompt(
      createMessage(),
      createSession("cursor-legacy"),
    );
    now = 45_000;
    const reply = await replyPromise;

    assert.match(reply ?? "", /Cursor CLI 超时/);
    assert.match(reply ?? "", /约 45 秒/);
  } finally {
    Date.now = originalNow;
  }
});

test("ConversationService 会在卡片底部显示 backend、model 和 context 百分比，并随事件刷新", async () => {
  const { service, updateCardCalls } = createHarness([
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "先来一段回答。",
    },
    {
      type: "usage_update",
      sessionId: "session-1",
      summary: "用量统计已更新",
      usage: {
        usedTokens: 83000,
        maxTokens: 216000,
        percent: (83000 / 216000) * 100,
      },
    },
    {
      type: "config_option_update",
      sessionId: "session-1",
      summary: "配置项已更新",
      configOptions: [{ id: "model", currentValue: "gpt-5", category: "model" }],
    },
  ]);

  const reply = await service.handleUserPrompt(createMessage(), createSession("codex"));
  const finalCard = updateCardCalls.at(-1)?.content ?? "";

  assert.match(finalCard, /先来一段回答。/);
  assert.match(finalCard, /`codex` \| GPT-5 \| 38\.4% \(83,000 \/ 216,000\)/);
  assert.match(reply ?? "", /先来一段回答。/);
  assert.match(reply ?? "", /`codex` \| GPT-5 \| 38\.4% \(83,000 \/ 216,000\)/);
  assert.ok(
    finalCard.lastIndexOf("先来一段回答。") <
      finalCard.lastIndexOf("`codex` | GPT-5 | 38.4% (83,000 / 216,000)"),
  );
});

test("ConversationService 会在 prompt 返回后重新同步状态条，补上无后续事件的 context 用量", async () => {
  const bridgeClient = new EventEmitter() as EventEmitter & {
    setFeishuPromptContext: (_sessionId: string, _ctx: unknown) => void;
  };
  bridgeClient.setFeishuPromptContext = () => {};
  const updateCardCalls: Array<{ id: string; content: string }> = [];
  let usageState: AcpSessionUsageState | undefined;

  const feishu = {
    async sendCard(): Promise<string> {
      return "card-1";
    },
    async updateCard(id: string, content: string): Promise<void> {
      updateCardCalls.push({ id, content });
    },
  };

  const runtime: BridgeAcpRuntime = {
    backend: "claude",
    bridgeClient: bridgeClient as any,
    initializeResult: null,
    supportsLoadSession: true,
    supportsSetSessionMode: true,
    supportsSetSessionModel: true,
    async start(): Promise<void> {},
    async initializeAndAuth(): Promise<void> {},
    async newSession() {
      return { sessionId: "session-1" };
    },
    async loadSession(): Promise<void> {},
    async prompt(): Promise<{ stopReason: string }> {
      bridgeClient.emit("acp", {
        type: "agent_message_chunk",
        sessionId: "session-1",
        text: "CLAUDE_OK",
      } satisfies BridgeAcpEvent);
      usageState = {
        usedTokens: 19_783,
        maxTokens: 200_000,
        percent: (19_783 / 200_000) * 100,
      };
      return { stopReason: "end_turn" };
    },
    async setSessionMode(): Promise<void> {},
    getSessionModeState() {
      return undefined;
    },
    async setSessionModel(): Promise<void> {},
    getSessionModelState() {
      return undefined;
    },
    getSessionUsageState() {
      return usageState;
    },
    async cancelSession(): Promise<void> {},
    async closeSession(): Promise<void> {},
    supportsCloseSession() {
      return false;
    },
    async stop(): Promise<void> {},
  };

  const service = new ConversationService(
    createTestConfig(),
    runtime,
    feishu as any,
  );

  await service.handleUserPrompt(createMessage(), createSession("claude"));

  const finalCard = updateCardCalls.at(-1)?.content ?? "";
  assert.match(finalCard, /CLAUDE_OK/);
  assert.match(finalCard, /`claude` \| — \| 9\.9% \(19,783 \/ 200,000\)/);
  assert.ok(
    finalCard.lastIndexOf("CLAUDE_OK") <
      finalCard.lastIndexOf("`claude` | — | 9.9% (19,783 / 200,000)"),
  );
});

test("ConversationService 只有 metadata 更新时也会渲染状态条而不是空响应", async () => {
  const { service, updateCardCalls } = createHarness([
    {
      type: "usage_update",
      sessionId: "session-1",
      summary: "用量统计已更新",
      usage: {
        usedTokens: 10633,
        maxTokens: 950000,
        percent: 1.119263157894737,
      },
    },
  ]);

  const reply = await service.handleUserPrompt(createMessage(), createSession("codex"));
  const finalCard = updateCardCalls.at(-1)?.content ?? "";

  assert.match(finalCard, /`codex` \| Auto \| 1\.1% \(10,633 \/ 950,000\)/);
  assert.doesNotMatch(finalCard, /无响应内容/);
  assert.match(reply ?? "", /`codex` \| Auto \| 1\.1% \(10,633 \/ 950,000\)/);
});
