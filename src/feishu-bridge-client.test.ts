import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Config } from "./config/index.js";
import { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";

function createTestConfig(): Config {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-client-tests");
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
      tmuxSessionStorePath: path.join(tmpRoot, "tmux-acp-sessions.json"),
      tmuxStartCommand: undefined,
      workspaceRoot: tmpRoot,
      allowedWorkspaceRoots: [tmpRoot],
      adapterSessionDir: path.join(tmpRoot, "acp-sessions"),
    },
    bridge: {
      adminUserIds: [],
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: path.join(tmpRoot, "sessions.json"),
      cardUpdateThrottleMs: 200,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: path.join(tmpRoot, "workspace-presets.json"),
      workspacePresetsSeed: [],
      maintenanceStatePath: path.join(tmpRoot, "maintenance-state.json"),
      singleInstanceLockPath: path.join(tmpRoot, "bridge.lock"),
      allowMultipleInstances: false,
      managedByService: false,
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

test("FeishuBridgeClient 会把 session/update 映射为桥接事件", async () => {
  const client = new FeishuBridgeClient(createTestConfig());
  const events: unknown[] = [];
  client.on("acp", (event) => {
    events.push(event);
  });

  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "hello",
      },
    },
  });

  await client.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "plan",
      entries: [
        {
          content: "first step",
          priority: "medium",
          status: "in_progress",
        },
      ],
    },
  });

  assert.deepEqual(events, [
    {
      type: "agent_message_chunk",
      sessionId: "session-1",
      text: "hello",
    },
    {
      type: "plan",
      sessionId: "session-1",
      summary: "1. [in_progress] first step",
    },
  ]);
});

test("FeishuBridgeClient 会发出 permission_required 并选择允许选项", async () => {
  const client = new FeishuBridgeClient(createTestConfig());
  const events: unknown[] = [];
  client.on("acp", (event) => {
    events.push(event);
  });

  const result = await client.requestPermission({
    sessionId: "session-1",
    options: [
      {
        optionId: "deny",
        kind: "reject_once",
        name: "拒绝",
      },
      {
        optionId: "allow-once",
        kind: "allow_once",
        name: "允许一次",
      },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "写入文件",
      kind: "edit",
      status: "pending",
    },
  });

  assert.deepEqual(events, [
    {
      type: "tool_call",
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "等待批准: 写入文件",
      status: "permission_required",
      kind: "edit",
    },
  ]);
  assert.deepEqual(result, {
    outcome: {
      outcome: "selected",
      optionId: "allow-once",
    },
  });
});

test("FeishuBridgeClient 会按 session 工作区处理读写文件", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "feishu-bridge-client-fs-"),
  );
  const config = createTestConfig();
  config.acp.workspaceRoot = tmpDir;
  config.acp.allowedWorkspaceRoots = [tmpDir];
  const client = new FeishuBridgeClient(config);

  const sessionRoot = path.join(tmpDir, "workspace-a");
  const filePath = path.join(sessionRoot, "notes.txt");
  client.setSessionWorkspace("session-1", sessionRoot);

  await client.writeTextFile({
    sessionId: "session-1",
    path: filePath,
    content: "line1\nline2\nline3",
  });

  const full = await client.readTextFile({
    sessionId: "session-1",
    path: filePath,
  });
  const sliced = await client.readTextFile({
    sessionId: "session-1",
    path: filePath,
    line: 2,
    limit: 1,
  });

  assert.equal(full.content, "line1\nline2\nline3");
  assert.equal(sliced.content, "line2");
});
