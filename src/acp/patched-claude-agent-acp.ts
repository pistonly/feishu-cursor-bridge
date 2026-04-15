#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  ClaudeAcpAgent,
  claudeCliPath,
  runAcp,
} from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import {
  applyEnvironmentSettings,
  loadManagedSettings,
} from "@agentclientprotocol/claude-agent-acp/dist/utils.js";

type ClaudeContextUsage = {
  totalTokens: number;
  maxTokens: number;
};

type ClaudePromptContextQuery = {
  getContextUsage(): Promise<ClaudeContextUsage>;
};

type ClaudePatchedSession = {
  query: ClaudePromptContextQuery;
};

type ClaudeUsageUpdateClient = {
  sessionUpdate(params: {
    sessionId: string;
    update: {
      sessionUpdate: "usage_update";
      used: number;
      size: number;
    };
  }): Promise<void>;
};

type ClaudeUsageUpdateLogger = {
  error: (...args: unknown[]) => void;
};

type ClaudeUsageUpdateAgentLike = {
  sessions: Record<string, ClaudePatchedSession | undefined>;
  client: ClaudeUsageUpdateClient;
  logger: ClaudeUsageUpdateLogger;
};

const PROMPT_PATCH_MARKER = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-patch",
);
const CONTEXT_QUERY_TIMEOUT_MS = 500;

export async function emitAccurateClaudeContextUsageUpdate(
  agent: ClaudeUsageUpdateAgentLike,
  sessionId: string,
  sendSessionUpdate:
    | ((params: {
        sessionId: string;
        update: {
          sessionUpdate: "usage_update";
          used: number;
          size: number;
        };
      }) => Promise<void>)
    | undefined = undefined,
  timeoutMs = CONTEXT_QUERY_TIMEOUT_MS,
): Promise<boolean> {
  const session = agent.sessions[sessionId];
  if (!session) return false;

  try {
    const contextUsage = (await withTimeout(
      session.query.getContextUsage(),
      timeoutMs,
      "getContextUsage timeout",
    )) as ClaudeContextUsage;

    if (
      !Number.isFinite(contextUsage.totalTokens) ||
      !Number.isFinite(contextUsage.maxTokens) ||
      contextUsage.totalTokens <= 0 ||
      contextUsage.maxTokens <= 0
    ) {
      return false;
    }

    const update = {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: Math.floor(contextUsage.totalTokens),
        size: Math.floor(contextUsage.maxTokens),
      },
    } as const;
    await (sendSessionUpdate ?? agent.client.sessionUpdate.bind(agent.client))(update);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      /timeout|Query closed before response received/i.test(error.message)
    ) {
      return false;
    }
    agent.logger.error(
      `[patched-claude-agent-acp] failed to refresh context usage sessionId=${sessionId}`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export function patchClaudeAcpAgentContextUsage(): void {
  const proto = ClaudeAcpAgent.prototype as ClaudeAcpAgent & {
    [PROMPT_PATCH_MARKER]?: boolean;
    prompt: (
      params: Parameters<ClaudeAcpAgent["prompt"]>[0],
    ) => ReturnType<ClaudeAcpAgent["prompt"]>;
  };
  if (proto[PROMPT_PATCH_MARKER]) {
    return;
  }

  const originalPrompt = proto.prompt;
  proto.prompt = async function patchedPrompt(
    this: ClaudeAcpAgent,
    params: Parameters<ClaudeAcpAgent["prompt"]>[0],
  ): ReturnType<ClaudeAcpAgent["prompt"]> {
    const originalSessionUpdate = this.client.sessionUpdate.bind(this.client);
    let correctedUsageSent = false;
    this.client.sessionUpdate = async (notification) => {
      await originalSessionUpdate(notification);
      const update = notification.update;
      if (correctedUsageSent) return;
      if (notification.sessionId !== params.sessionId) return;
      if (update?.sessionUpdate !== "usage_update") return;
      if (update.cost == null) return;
      correctedUsageSent = await emitAccurateClaudeContextUsageUpdate(
        this as unknown as ClaudeUsageUpdateAgentLike,
        params.sessionId,
        originalSessionUpdate,
      );
    };

    try {
      return await originalPrompt.call(this, params);
    } finally {
      this.client.sessionUpdate = originalSessionUpdate;
    }
  };
  proto[PROMPT_PATCH_MARKER] = true;
}

patchClaudeAcpAgentContextUsage();

function isEntrypoint(): boolean {
  return process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (isEntrypoint()) {
  if (process.argv.includes("--cli")) {
    process.argv = process.argv.filter((arg) => arg !== "--cli");
    await import(await claudeCliPath());
  } else {
  const managedSettings = loadManagedSettings();
  if (managedSettings) {
    applyEnvironmentSettings(managedSettings);
  }

  // stdout is used by ACP transport; route any incidental logging to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  const { connection, agent } = runAcp();

  async function shutdown() {
    await agent.dispose().catch((err) => {
      console.error("Error during cleanup:", err);
    });
    process.exit(0);
  }

  connection.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.resume();
  }
}
