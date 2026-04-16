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

type ClaudeSdkResultMessage = {
  type?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  } | null;
  modelUsage?: Record<
    string,
    {
      contextWindow?: unknown;
    }
  > | null;
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
  extNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void>;
};

type ClaudeUsageUpdateLogger = {
  error: (...args: unknown[]) => void;
};

type ClaudeUsageUpdateAgentLike = {
  client: ClaudeUsageUpdateClient;
  logger: ClaudeUsageUpdateLogger;
};

const PROMPT_PATCH_MARKER = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-patch",
);

function extractUsedTokensFromResultMessage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as ClaudeSdkResultMessage;
  if (message.type !== "result") return undefined;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return undefined;
  }
  return Math.floor(inputTokens + outputTokens);
}

function extractMaxTokensFromResultMessage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as ClaudeSdkResultMessage;
  if (message.type !== "result") return undefined;
  const rawModelUsage = message.modelUsage;
  if (!rawModelUsage || typeof rawModelUsage !== "object") return undefined;

  let maxTokens = 0;
  for (const usageEntry of Object.values(rawModelUsage)) {
    if (!usageEntry || typeof usageEntry !== "object") continue;
    const contextWindow = usageEntry.contextWindow;
    if (
      typeof contextWindow === "number" &&
      Number.isFinite(contextWindow) &&
      contextWindow > maxTokens
    ) {
      maxTokens = contextWindow;
    }
  }
  return maxTokens > 0 ? Math.floor(maxTokens) : undefined;
}

export async function emitAccurateClaudeContextUsageUpdate(
  agent: ClaudeUsageUpdateAgentLike,
  sessionId: string,
  usedTokens: number,
  maxTokens: number,
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
): Promise<boolean> {
  if (
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0 ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0
  ) {
    return false;
  }

  try {
    const update = {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: Math.floor(usedTokens),
        size: Math.floor(maxTokens),
      },
    } as const;
    await (sendSessionUpdate ?? agent.client.sessionUpdate.bind(agent.client))(update);
    return true;
  } catch (error) {
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
    const originalExtNotification = this.client.extNotification.bind(this.client);
    let correctedUsageSent = false;
    let latestUsedTokens: number | undefined;
    let latestMaxTokens: number | undefined;

    this.client.extNotification = async (method, notificationParams) => {
      if (
        method === "_claude/sdkMessage" &&
        notificationParams.sessionId === params.sessionId
      ) {
        const usedTokens = extractUsedTokensFromResultMessage(
          notificationParams.message,
        );
        if (usedTokens != null) {
          latestUsedTokens = usedTokens;
        }
        const maxTokens = extractMaxTokensFromResultMessage(
          notificationParams.message,
        );
        if (maxTokens != null) {
          latestMaxTokens = maxTokens;
        }
      }
      await originalExtNotification(method, notificationParams);
    };

    this.client.sessionUpdate = async (notification) => {
      await originalSessionUpdate(notification);
      const update = notification.update;
      if (correctedUsageSent) return;
      if (notification.sessionId !== params.sessionId) return;
      if (update?.sessionUpdate !== "usage_update") return;
      if (update.cost == null) return;
      if (latestUsedTokens == null) return;
      correctedUsageSent = await emitAccurateClaudeContextUsageUpdate(
        this as unknown as ClaudeUsageUpdateAgentLike,
        params.sessionId,
        latestUsedTokens,
        latestMaxTokens ?? notification.update.size,
        originalSessionUpdate,
      );
    };

    try {
      return await originalPrompt.call(this, params);
    } finally {
      this.client.sessionUpdate = originalSessionUpdate;
      this.client.extNotification = originalExtNotification;
    }
  };
  proto[PROMPT_PATCH_MARKER] = true;
}

patchClaudeAcpAgentContextUsage();

function isEntrypoint(): boolean {
  return process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;
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
