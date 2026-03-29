import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Config } from "./config.js";
import type { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";
import {
  AcpRuntime,
  MAX_ADAPTER_SESSION_TIMEOUT_MS,
  resolveAdapterSessionTimeoutMs,
} from "./acp/runtime.js";

const require = createRequire(import.meta.url);

type TestCursorCliBridge = {
  executeStreamingCommand(command: string[], options?: unknown): Promise<unknown>;
  sendStreamingPrompt(options: unknown): Promise<unknown>;
};

type CursorCliBridgeConstructor = new (
  config: unknown,
  logger: unknown,
) => TestCursorCliBridge;

const { CursorCliBridge } = require(
  "@blowmage/cursor-agent-acp/dist/cursor/cli-bridge.js",
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
      nodePath: process.execPath,
      adapterEntry: "/tmp/cursor-agent-acp.js",
      extraArgs: [],
      workspaceRoot: tmpRoot,
      allowedWorkspaceRoots: [tmpRoot],
      adapterSessionDir: path.join(tmpRoot, "acp-sessions"),
    },
    bridge: {
      maxSessionsPerUser: 10,
      sessionIdleTimeoutMs: 60_000,
      sessionStorePath: path.join(tmpRoot, "sessions.json"),
      cardUpdateThrottleMs: 200,
      workspacePresetsPath: path.join(tmpRoot, "workspace-presets.json"),
      workspacePresetsSeed: [],
      singleInstanceLockPath: path.join(tmpRoot, "bridge.lock"),
      allowMultipleInstances: false,
      experimentalLogToFile: false,
      experimentalLogFilePath: path.join(tmpRoot, "bridge.log"),
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
