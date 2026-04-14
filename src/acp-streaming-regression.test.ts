import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveBundledTsxCliEntry,
  resolveLegacyAdapterDistEntry,
  resolveLegacyAdapterSourceEntry,
} from "./acp/paths.js";
import { loadConfig, type Config } from "./config/index.js";
import type { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";
import { ClaudeAcpRuntime } from "./acp/claude-runtime.js";
import { CodexAcpRuntime } from "./acp/codex-runtime.js";
import { OfficialAcpRuntime } from "./acp/official-runtime.js";
import {
  AcpRuntime,
  MAX_ADAPTER_SESSION_TIMEOUT_MS,
  createAcpRuntime,
  resolveAdapterSessionTimeoutMs,
} from "./acp/runtime.js";
import { TmuxAcpRuntime } from "./acp/tmux-runtime.js";

const require = createRequire(import.meta.url);

type TestCursorCliBridge = {
  executeStreamingCommand(command: string[], options?: unknown): Promise<unknown>;
  sendStreamingPrompt(options: unknown): Promise<unknown>;
};

type CursorCliBridgeConstructor = new (
  config: unknown,
  logger: unknown,
) => TestCursorCliBridge;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoPackageVersion = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
)["version"] as string;
const { CursorCliBridge } = require(
  path.join(repoRoot, "vendor", "cursor-agent-acp", "dist", "cursor", "cli-bridge.js"),
) as {
  CursorCliBridge: CursorCliBridgeConstructor;
};

function createTestConfig(): Config {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-tests");
  return {
    feishu: {
      appId: "app-id",
      appSecret: "app-secret",
      domain: "feishu",
    },
    acp: {
      backend: "cursor-legacy",
      enabledBackends: ["cursor-legacy"],
      nodePath: process.execPath,
      adapterEntry: "/tmp/cursor-agent-acp.js",
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
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: path.join(tmpRoot, "sessions.json"),
      cardUpdateThrottleMs: 200,
      cardSplitMarkdownThreshold: 3_500,
      cardSplitToolThreshold: 8,
      workspacePresetsPath: path.join(tmpRoot, "workspace-presets.json"),
      workspacePresetsSeed: [],
      singleInstanceLockPath: path.join(tmpRoot, "bridge.lock"),
      allowMultipleInstances: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: path.join(tmpRoot, "bridge.log"),
      showAcpAvailableCommands: false,
    },
    autoApprovePermissions: true,
    bridgeDebug: false,
    acpReloadTraceLog: false,
    logLevel: "info",
  };
}

function createMockLogger(): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  const noop = (..._args: unknown[]): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("AcpRuntime.prompt 会同时透传顶层 stream 与 _meta.stream", async () => {
  const runtime = new AcpRuntime(
    createTestConfig(),
    {} as FeishuBridgeClient,
  );

  let capturedParams: unknown;
  const fakeConnection = {
    prompt: async (params: unknown) => {
      capturedParams = params;
      return { stopReason: "end_turn" };
    },
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
  });

  const result = await runtime.prompt("session-1", "hello");

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(capturedParams, {
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hello" }],
    stream: true,
    _meta: {
      stream: true,
    },
  });
});

test("OfficialAcpRuntime.prompt 使用标准 prompt 参数，不透传 legacy stream 标记", async () => {
  const config = createTestConfig();
  config.acp.backend = "cursor-official";
  const runtime = new OfficialAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  let capturedParams: unknown;
  const fakeConnection = {
    prompt: async (params: unknown) => {
      capturedParams = params;
      return { stopReason: "end_turn" };
    },
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
  });

  const result = await runtime.prompt("session-1", "hello");

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(capturedParams, {
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hello" }],
  });
});

test("OfficialAcpRuntime 会缓存 new/load 返回的模式与模型状态，并在切换后更新当前值", async () => {
  const config = createTestConfig();
  config.acp.backend = "cursor-official";
  const runtime = new OfficialAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  const fakeConnection = {
    newSession: async () => ({
      sessionId: "session-1",
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
          { id: "ask", name: "Ask" },
        ],
      },
      models: {
        currentModelId: "auto",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "gpt-5", name: "GPT-5" },
        ],
      },
    }),
    loadSession: async () => ({
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
          { id: "ask", name: "Ask" },
        ],
      },
      models: {
        currentModelId: "gpt-5",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "gpt-5", name: "GPT-5" },
          { modelId: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
        ],
      },
    }),
    setSessionMode: async () => ({}),
    unstable_setSessionModel: async () => ({}),
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
    initResult: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          _meta: {
            supportsSetMode: true,
            supportsSetModel: true,
          },
        },
      },
    },
  });

  await runtime.newSession("/tmp/workspace");
  assert.deepEqual(runtime.getSessionModeState("session-1"), {
    currentModeId: "agent",
    availableModes: [
      { modeId: "agent", name: "Agent" },
      { modeId: "plan", name: "Plan" },
      { modeId: "ask", name: "Ask" },
    ],
  });
  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "auto",
    availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "gpt-5", name: "GPT-5" },
    ],
  });

  await runtime.loadSession("session-1", "/tmp/workspace");
  assert.deepEqual(runtime.getSessionModeState("session-1"), {
    currentModeId: "plan",
    availableModes: [
      { modeId: "agent", name: "Agent" },
      { modeId: "plan", name: "Plan" },
      { modeId: "ask", name: "Ask" },
    ],
  });
  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "gpt-5",
    availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "gpt-5", name: "GPT-5" },
      { modelId: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
    ],
  });

  await runtime.setSessionMode("session-1", "ask");
  assert.deepEqual(runtime.getSessionModeState("session-1"), {
    currentModeId: "ask",
    availableModes: [
      { modeId: "agent", name: "Agent" },
      { modeId: "plan", name: "Plan" },
      { modeId: "ask", name: "Ask" },
    ],
  });

  await runtime.setSessionModel("session-1", "claude-3.7-sonnet");
  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "claude-3.7-sonnet",
    availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "gpt-5", name: "GPT-5" },
      { modelId: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
    ],
  });
});

test("SdkAcpRuntimeBase.cancelSession 会把后端取消失败向上抛出", async () => {
  const config = createTestConfig();
  config.acp.backend = "codex";
  const runtime = new CodexAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  const fakeConnection = {
    cancel: async () => {
      throw new Error("cancel not supported");
    },
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
  });

  await assert.rejects(
    runtime.cancelSession("session-1"),
    /cancel not supported/,
  );
});

test("SdkAcpRuntimeBase.cancelSession 在 ACP 未启动时直接返回", async () => {
  const config = createTestConfig();
  config.acp.backend = "codex";
  const runtime = new CodexAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  await assert.doesNotReject(runtime.cancelSession("session-1"));
});

test("OfficialAcpRuntime.closeSession 与 stop 会清理缓存的模式与模型状态", async () => {
  const config = createTestConfig();
  config.acp.backend = "cursor-official";
  const runtime = new OfficialAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  let closeCalls = 0;
  const fakeConnection = {
    newSession: async () => ({
      sessionId: "session-1",
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent" }],
      },
      models: {
        currentModelId: "auto",
        availableModels: [{ modelId: "auto", name: "Auto" }],
      },
    }),
    unstable_closeSession: async () => {
      closeCalls++;
      return {};
    },
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
    initResult: {
      agentCapabilities: {
        sessionCapabilities: {
          close: {},
        },
      },
    },
  });

  await runtime.newSession("/tmp/workspace");
  assert.deepEqual(runtime.getSessionModeState("session-1"), {
    currentModeId: "agent",
    availableModes: [{ modeId: "agent", name: "Agent" }],
  });
  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "auto",
    availableModels: [{ modelId: "auto", name: "Auto" }],
  });

  await runtime.closeSession("session-1");
  assert.equal(closeCalls, 1);
  assert.equal(runtime.getSessionModeState("session-1"), undefined);
  assert.equal(runtime.getSessionModelState("session-1"), undefined);

  await runtime.newSession("/tmp/workspace");
  await runtime.stop();
  assert.equal(runtime.getSessionModeState("session-1"), undefined);
  assert.equal(runtime.getSessionModelState("session-1"), undefined);
});

test("SdkAcpRuntimeBase 不依赖 initialize 宣告即可切换模式与模型", async () => {
  const config = createTestConfig();
  config.acp.backend = "cursor-official";
  const runtime = new OfficialAcpRuntime(
    config,
    {} as FeishuBridgeClient,
  );

  let modeCalls = 0;
  let modelCalls = 0;
  const fakeConnection = {
    setSessionMode: async () => {
      modeCalls++;
      return {};
    },
    unstable_setSessionModel: async () => {
      modelCalls++;
      return {};
    },
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
    initResult: {
      agentCapabilities: {
        sessionCapabilities: {
          _meta: {},
        },
      },
    },
  });

  assert.equal(runtime.supportsSetSessionMode, true);
  assert.equal(runtime.supportsSetSessionModel, true);
  await runtime.setSessionMode("session-1", "agent");
  await runtime.setSessionModel("session-1", "gpt-5");
  assert.equal(modeCalls, 1);
  assert.equal(modelCalls, 1);
});

test("CodexAcpRuntime 会根据 config_option_update 更新当前模式与模型", async () => {
  const config = createTestConfig();
  config.acp.backend = "codex";
  const handler = new EventEmitter() as FeishuBridgeClient;
  const runtime = new CodexAcpRuntime(
    config,
    handler,
  );

  const fakeConnection = {
    newSession: async () => ({
      sessionId: "session-1",
      modes: {
        currentModeId: "auto",
        availableModes: [
          { id: "read-only", name: "Read Only" },
          { id: "auto", name: "Default" },
          { id: "full-access", name: "Full Access" },
        ],
      },
      models: {
        currentModelId: "gpt-5.3-codex/medium",
        availableModels: [
          { modelId: "gpt-5.3-codex/medium", name: "gpt-5.3-codex (medium)" },
          { modelId: "gpt-5.4/high", name: "gpt-5.4 (high)" },
        ],
      },
    }),
  };

  Object.assign(runtime as object, {
    connection: fakeConnection,
  });

  await runtime.newSession("/tmp/workspace");
  handler.emit("acp", {
    type: "config_option_update",
    sessionId: "session-1",
    summary: "配置项已更新",
    configOptions: [
      { id: "mode", currentValue: "read-only", category: "mode" },
      { id: "model", currentValue: "gpt-5.4", category: "model" },
      {
        id: "reasoning_effort",
        currentValue: "high",
        category: "thought_level",
      },
    ],
  });

  assert.deepEqual(runtime.getSessionModeState("session-1"), {
    currentModeId: "read-only",
    availableModes: [
      { modeId: "read-only", name: "Read Only" },
      { modeId: "auto", name: "Default" },
      { modeId: "full-access", name: "Full Access" },
    ],
  });
  assert.deepEqual(runtime.getSessionModelState("session-1"), {
    currentModelId: "gpt-5.4/high",
    availableModels: [
      { modelId: "gpt-5.3-codex/medium", name: "gpt-5.3-codex (medium)" },
      { modelId: "gpt-5.4/high", name: "gpt-5.4 (high)" },
    ],
  });
});

test("SdkAcpRuntimeBase 会缓存 usage_update 上下文占用状态", async () => {
  const config = createTestConfig();
  config.acp.backend = "codex";
  const handler = new EventEmitter() as FeishuBridgeClient;
  const runtime = new CodexAcpRuntime(
    config,
    handler,
  );

  handler.emit("acp", {
    type: "usage_update",
    sessionId: "session-1",
    summary: "用量统计已更新",
    usage: {
      usedTokens: 50000,
      maxTokens: 200000,
      percent: 25,
    },
  });

  assert.deepEqual(runtime.getSessionUsageState("session-1"), {
    usedTokens: 50000,
    maxTokens: 200000,
    percent: 25,
  });
});

test("createAcpRuntime 会按 ACP_BACKEND 返回对应实现", () => {
  const legacyRuntime = createAcpRuntime(
    createTestConfig(),
    {} as FeishuBridgeClient,
  );
  const officialConfig = createTestConfig();
  officialConfig.acp.backend = "cursor-official";
  const officialRuntime = createAcpRuntime(
    officialConfig,
    {} as FeishuBridgeClient,
  );
  const tmuxConfig = createTestConfig();
  tmuxConfig.acp.backend = "cursor-tmux";
  const tmuxRuntime = createAcpRuntime(
    tmuxConfig,
    {} as FeishuBridgeClient,
  );
  const codexConfig = createTestConfig();
  codexConfig.acp.backend = "codex";
  const codexRuntime = createAcpRuntime(
    codexConfig,
    {} as FeishuBridgeClient,
  );

  assert.equal(legacyRuntime.backend, "cursor-legacy");
  assert.ok(legacyRuntime instanceof AcpRuntime);
  assert.equal(officialRuntime.backend, "cursor-official");
  assert.ok(officialRuntime instanceof OfficialAcpRuntime);
  assert.equal(tmuxRuntime.backend, "cursor-tmux");
  assert.ok(tmuxRuntime instanceof TmuxAcpRuntime);
  assert.equal(codexRuntime.backend, "codex");
  assert.ok(codexRuntime instanceof CodexAcpRuntime);
});

test("TmuxAcpRuntime 会透传自定义 start command", () => {
  const config = createTestConfig();
  config.acp.backend = "cursor-tmux";
  config.acp.tmuxStartCommand = "cursor agent --yolo --approve-mcps";
  const runtime = new TmuxAcpRuntime(config, {} as FeishuBridgeClient);

  const spec = (runtime as unknown as { createSpawnSpec: () => { args: string[] } }).createSpawnSpec();

  assert.deepEqual(spec.args, [
    "/tmp/tsx-cli.mjs",
    "/tmp/tmux-acp-server.ts",
    "--store-path",
    config.acp.tmuxSessionStorePath,
    "--start-command",
    "cursor agent --yolo --approve-mcps",
  ]);
});

test("loadConfig 会解析官方 ACP 后端开关与命令参数", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "cursor-official",
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_AGENT_PATH: "/usr/local/bin/agent",
      CURSOR_API_KEY: "api-key-1",
      CURSOR_AUTH_TOKEN: "auth-token-1",
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "cursor-official");
      assert.equal(config.acp.officialAgentPath, "/usr/local/bin/agent");
      assert.equal(config.acp.officialApiKey, "api-key-1");
      assert.equal(config.acp.officialAuthToken, "auth-token-1");
      assert.equal(config.acp.workspaceRoot, tmpRoot);
    },
  );
});

test("loadConfig 未设置 ACP_BACKEND 时默认走官方 ACP", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-default-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: undefined,
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "cursor-official");
    },
  );
});

test("loadConfig 仍允许显式切回 legacy", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-legacy-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "cursor-legacy",
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "cursor-legacy");
    },
  );
});

test("loadConfig 在默认 official 且启用 legacy 时也会准备 legacy adapter 入口", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-enabled-legacy-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "cursor-official",
      ACP_ENABLED_BACKENDS: "official,legacy,tmux,codex",
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "cursor-official");
      assert.deepEqual(config.acp.enabledBackends, [
        "cursor-official",
        "cursor-legacy",
        "cursor-tmux",
        "codex",
      ]);
      assert.ok(config.acp.adapterEntry.length > 0);
      assert.equal(config.acp.adapterTsxCli, undefined);
    },
  );
});

test("loadConfig 会解析 Codex ACP 后端与默认命令", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-codex-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "codex",
      ACP_ENABLED_BACKENDS: "codex",
      BRIDGE_WORK_ALLOWLIST: undefined,
      CODEX_AGENT_ACP_COMMAND: "node /tmp/codex-acp.js --stdio",
      CODEX_AGENT_ACP_EXTRA_ARGS: "--log-level debug",
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "codex");
      assert.equal(config.acp.codexSpawnCommand, "node");
      assert.deepEqual(config.acp.codexSpawnArgs, [
        "/tmp/codex-acp.js",
        "--stdio",
        "--log-level",
        "debug",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
      ]);
    },
  );
});

test("loadConfig 在关闭 AUTO_APPROVE_PERMISSIONS 时不为 Codex 注入 danger-full-access", async () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    "feishu-cursor-bridge-config-codex-safe-tests",
  );
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "codex",
      ACP_ENABLED_BACKENDS: "codex",
      AUTO_APPROVE_PERMISSIONS: "false",
      BRIDGE_WORK_ALLOWLIST: undefined,
      CODEX_AGENT_ACP_COMMAND: "node /tmp/codex-acp.js --stdio",
      CODEX_AGENT_ACP_EXTRA_ARGS: "--log-level debug",
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.acp.codexSpawnArgs, [
        "/tmp/codex-acp.js",
        "--stdio",
        "--log-level",
        "debug",
      ]);
    },
  );
});

test("loadConfig 会保留用户显式传入的 Codex sandbox 与 approval 配置", async () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    "feishu-cursor-bridge-config-codex-explicit-override-tests",
  );
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "codex",
      ACP_ENABLED_BACKENDS: "codex",
      BRIDGE_WORK_ALLOWLIST: undefined,
      CODEX_AGENT_ACP_COMMAND: "node /tmp/codex-acp.js --stdio",
      CODEX_AGENT_ACP_EXTRA_ARGS:
        "--log-level debug -c 'sandbox_mode=\"workspace-write\"' -c 'approval_policy=\"on-request\"'",
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.acp.codexSpawnArgs, [
        "/tmp/codex-acp.js",
        "--stdio",
        "--log-level",
        "debug",
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        'approval_policy="on-request"',
      ]);
    },
  );
});

test("loadConfig legacy 在 tsx src/index.ts 入口下默认使用适配器源码与 tsx", async () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    "feishu-cursor-bridge-config-deventry-tests",
  );
  const savedArgv1 = process.argv[1];
  process.argv[1] = path.join(repoRoot, "src", "index.ts");
  try {
    await withEnv(
      {
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        ACP_BACKEND: "cursor-legacy",
        ACP_ENABLED_BACKENDS: undefined,
        BRIDGE_WORK_ALLOWLIST: undefined,
        CURSOR_WORK_ALLOWLIST: tmpRoot,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.acp.backend, "cursor-legacy");
        const norm = config.acp.adapterEntry.replace(/\\/g, "/");
        assert.ok(norm.endsWith("vendor/cursor-agent-acp/src/bin/cursor-agent-acp.ts"));
        assert.ok(config.acp.adapterTsxCli && config.acp.adapterTsxCli.length > 0);
      },
    );
  } finally {
    process.argv[1] = savedArgv1;
  }
});

test("legacy adapter CLI 在 source/dist 入口都能解析仓库根版本号", () => {
  const distVersion = spawnSync(
    process.execPath,
    [resolveLegacyAdapterDistEntry(), "--version"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(distVersion.status, 0, distVersion.stderr || distVersion.stdout);
  assert.equal(distVersion.stdout.trim(), repoPackageVersion);

  const sourceVersion = spawnSync(
    process.execPath,
    [
      resolveBundledTsxCliEntry(),
      resolveLegacyAdapterSourceEntry(),
      "--version",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    sourceVersion.status,
    0,
    sourceVersion.stderr || sourceVersion.stdout,
  );
  assert.equal(sourceVersion.stdout.trim(), repoPackageVersion);
});

test("loadConfig 会解析 tmux ACP 后端与内置 server 配置", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-tmux-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_BACKEND: "cursor-tmux",
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      TMUX_ACP_TSX_CLI: "/tmp/tsx-cli.mjs",
      TMUX_ACP_SERVER_ENTRY: "/tmp/tmux-acp-server.ts",
      TMUX_ACP_SESSION_STORE: "/tmp/tmux-acp-sessions.json",
      TMUX_ACP_START_COMMAND: "cursor agent --yolo --approve-mcps",
      CURSOR_WORK_ALLOWLIST: tmpRoot,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.acp.backend, "cursor-tmux");
      assert.equal(config.acp.tmuxTsxCliEntry, "/tmp/tsx-cli.mjs");
      assert.equal(config.acp.tmuxServerEntry, "/tmp/tmux-acp-server.ts");
      assert.equal(config.acp.tmuxSessionStorePath, "/tmp/tmux-acp-sessions.json");
      assert.equal(config.acp.tmuxStartCommand, "cursor agent --yolo --approve-mcps");
    },
  );
});

test("loadConfig 会解析飞书卡片拆分阈值", async () => {
  const tmpRoot = path.join(os.tmpdir(), "feishu-cursor-bridge-config-card-split-tests");
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_WORK_ALLOWLIST: tmpRoot,
      FEISHU_CARD_SPLIT_MARKDOWN_THRESHOLD: "4200",
      FEISHU_CARD_SPLIT_TOOL_THRESHOLD: "12",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.bridge.cardSplitMarkdownThreshold, 4200);
      assert.equal(config.bridge.cardSplitToolThreshold, 12);
    },
  );
});

test("loadConfig 未设置 CURSOR_WORK_ALLOWLIST 时报错", async () => {
  await withEnv(
    {
      FEISHU_APP_ID: "app-id",
      FEISHU_APP_SECRET: "app-secret",
      ACP_ENABLED_BACKENDS: undefined,
      BRIDGE_WORK_ALLOWLIST: undefined,
      CURSOR_WORK_ALLOWLIST: undefined,
    },
    () => {
      assert.throws(() => loadConfig(), /CURSOR_WORK_ALLOWLIST/);
    },
  );
});

test("适配器 session timeout 会被截断到上游允许的 24 小时上限", () => {
  const config = createTestConfig();
  config.bridge.sessionIdleTimeoutMs = 7 * 24 * 60 * 60_000;

  assert.equal(
    resolveAdapterSessionTimeoutMs(config),
    String(MAX_ADAPTER_SESSION_TIMEOUT_MS),
  );
});

test("CursorCliBridge.sendStreamingPrompt 会忽略最终完整快照的重复输出", async () => {
  const bridge = new CursorCliBridge(
    {
      cursor: {
        timeout: 5_000,
        retries: 0,
      },
    },
    createMockLogger(),
  );

  Object.assign(bridge as object, {
    executeStreamingCommand: async (
      _command: string[],
      options?: {
        onData?: (chunk: string) => Promise<void>;
      },
    ) => {
      await options?.onData?.(
        [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"你"}]}}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
          "",
        ].join("\n"),
      );

      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const chunks: unknown[] = [];
  const response = (await bridge.sendStreamingPrompt({
    sessionId: "session-1",
    content: {
      type: "text",
      value: "hello",
    },
    metadata: {
      cwd: "/tmp",
    },
    onChunk: async (chunk: unknown) => {
      chunks.push(chunk);
    },
  })) as {
    metadata?: {
      chunks?: number;
      streaming?: boolean;
    };
  };

  assert.deepEqual(chunks, [
    {
      type: "content",
      data: {
        type: "text",
        text: "你",
      },
    },
    {
      type: "content",
      data: {
        type: "text",
        text: "好",
      },
    },
    {
      type: "done",
      data: {
        complete: true,
      },
    },
  ]);
  assert.equal(response.metadata?.chunks, 3);
  assert.equal(response.metadata?.streaming, true);
});

test("CursorCliBridge.sendStreamingPrompt 会忽略纯文本形式的最终整段回显", async () => {
  const bridge = new CursorCliBridge(
    {
      cursor: {
        timeout: 5_000,
        retries: 0,
      },
    },
    createMockLogger(),
  );

  Object.assign(bridge as object, {
    executeStreamingCommand: async (
      _command: string[],
      options?: {
        onData?: (chunk: string) => Promise<void>;
      },
    ) => {
      await options?.onData?.(
        [
          '{"type":"assistant","message":{"content":[{"type":"text","text":"你"}]}}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
          "你好",
          "",
        ].join("\n"),
      );

      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const chunks: unknown[] = [];
  await bridge.sendStreamingPrompt({
    sessionId: "session-1",
    content: {
      type: "text",
      value: "hello",
    },
    metadata: {
      cwd: "/tmp",
    },
    onChunk: async (chunk: unknown) => {
      chunks.push(chunk);
    },
  });

  assert.deepEqual(chunks, [
    {
      type: "content",
      data: {
        type: "text",
        text: "你",
      },
    },
    {
      type: "content",
      data: {
        type: "text",
        text: "好",
      },
    },
    {
      type: "done",
      data: {
        complete: true,
      },
    },
  ]);
});
