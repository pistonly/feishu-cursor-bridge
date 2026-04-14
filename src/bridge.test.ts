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
      tmuxTsxCliEntry: "/tmp/tsx-cli.mjs",
      tmuxServerEntry: "/tmp/tmux-acp-server.ts",
      tmuxSessionStorePath: "/tmp/tmux-acp-sessions.json",
      tmuxStartCommand: undefined,
      workspaceRoot: "/tmp",
      allowedWorkspaceRoots: ["/tmp"],
      adapterSessionDir: "/tmp/acp-sessions",
    },
    bridge: {
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: "/tmp/sessions.json",
      cardUpdateThrottleMs: 0,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: "/tmp/workspace-presets.json",
      workspacePresetsSeed: [],
      singleInstanceLockPath: "/tmp/bridge.lock",
      allowMultipleInstances: false,
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

function createStatusMessage(): FeishuMessage {
  return {
    chatId: "chat-1",
    messageId: "msg-1",
    content: "/status",
    contentType: "text",
    mentions: [],
    inlineMentionIds: [],
    senderId: "user-1",
    senderType: "user",
    chatType: "p2p",
    replyInThread: false,
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

  await (bridge as any).handleFeishuMessage(createStatusMessage());

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0] ?? "", /当前 session backend：codex/);
  assert.match(sentTexts[0] ?? "", /当前模式：`auto`/);
  assert.match(sentTexts[0] ?? "", /当前模型：GPT-5\.4/);
  assert.match(sentTexts[0] ?? "", /Context 用量：1\.1% \(10,633 \/ 950,000\)/);
});
