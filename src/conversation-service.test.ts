import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Config } from "./config.js";
import { ConversationService } from "./conversation-service.js";
import type { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";
import type { BridgeAcpRuntime } from "./acp/runtime-contract.js";
import type { FeishuBot, FeishuMessage } from "./feishu-bot.js";
import type { UserSession } from "./session-manager.js";

function createTestConfig(promptTimeoutMs = 20): Config {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-conversation-tests");
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "official",
      nodePath: process.execPath,
      adapterEntry: "",
      extraArgs: [],
      officialAgentPath: "agent",
      officialApiKey: undefined,
      officialAuthToken: undefined,
      workspaceRoot: tmpRoot,
      allowedWorkspaceRoots: [tmpRoot],
      adapterSessionDir: path.join(tmpRoot, "acp-sessions"),
    },
    bridge: {
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      promptTimeoutMs,
      sessionStorePath: path.join(tmpRoot, "sessions.json"),
      cardUpdateThrottleMs: 0,
      workspacePresetsPath: path.join(tmpRoot, "workspace-presets.json"),
      workspacePresetsSeed: [],
      singleInstanceLockPath: path.join(tmpRoot, "bridge.lock"),
      allowMultipleInstances: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: path.join(tmpRoot, "bridge.log"),
      showAcpAvailableCommands: false,
    },
    autoApprovePermissions: false,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}

function createTestMessage(): FeishuMessage {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "user-1",
    senderType: "user",
    content: "hello",
    contentType: "text",
  };
}

function createTestSession(): UserSession {
  const now = Date.now();
  return {
    sessionId: "session-1",
    workspaceRoot: "/tmp/workspace",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "p2p",
    createdAt: now,
    lastActiveAt: now,
  };
}

function createMockRuntime(
  prompt: BridgeAcpRuntime["prompt"],
  cancelSession: BridgeAcpRuntime["cancelSession"],
): BridgeAcpRuntime {
  const bridgeClient = new EventEmitter() as FeishuBridgeClient;
  return {
    backend: "official",
    bridgeClient,
    initializeResult: null,
    supportsLoadSession: true,
    async start(): Promise<void> {},
    async initializeAndAuth(): Promise<void> {},
    async newSession() {
      return { sessionId: "session-1" };
    },
    async loadSession(): Promise<void> {},
    prompt,
    async setSessionMode(): Promise<void> {},
    getSessionModeState() {
      return undefined;
    },
    async setSessionModel(): Promise<void> {},
    getSessionModelState() {
      return undefined;
    },
    cancelSession,
    async closeSession(): Promise<void> {},
    supportsCloseSession() {
      return false;
    },
    async stop(): Promise<void> {},
  };
}

test("ConversationService 在 prompt watchdog 超时后会取消 session 并返回提示", async () => {
  let cancelCalls = 0;
  const cardUpdates: string[] = [];
  const runtime = createMockRuntime(
    async () => await new Promise(() => {}),
    async () => {
      cancelCalls += 1;
    },
  );
  const feishu = {
    async sendCard() {
      return "card-1";
    },
    async updateCard(_messageId: string, content: string) {
      cardUpdates.push(content);
    },
  } as unknown as FeishuBot;
  const service = new ConversationService(createTestConfig(), runtime, feishu);

  const result = await service.handleUserPrompt(
    createTestMessage(),
    createTestSession(),
  );

  assert.equal(cancelCalls, 1);
  assert.match(result ?? "", /已主动中止/);
  assert.ok(cardUpdates.some((content) => content.includes("已主动中止")));
});

test("ConversationService 在 watchdog 超时时会保留已收到的流式内容", async () => {
  const runtime = createMockRuntime(
    async () => await new Promise(() => {}),
    async () => {},
  );
  const cardUpdates: string[] = [];
  const feishu = {
    async sendCard() {
      return "card-1";
    },
    async updateCard(_messageId: string, content: string) {
      cardUpdates.push(content);
    },
  } as unknown as FeishuBot;
  const service = new ConversationService(createTestConfig(), runtime, feishu);

  setTimeout(() => {
    runtime.bridgeClient.emit("acp", {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "partial answer",
    });
  }, 5);

  const result = await service.handleUserPrompt(
    createTestMessage(),
    createTestSession(),
  );

  assert.match(result ?? "", /partial answer/);
  assert.match(result ?? "", /已主动中止/);
  assert.ok(cardUpdates.some((content) => content.includes("partial answer")));
});
