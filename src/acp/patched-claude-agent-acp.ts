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

type ClaudeSdkMessage = {
  type?: unknown;
  subtype?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  } | null;
};

type ClaudeUsageUpdateNotification = {
  sessionId: string;
  update: {
    sessionUpdate: string;
    used?: number;
    size?: number;
    cost?: unknown;
  };
};

type ClaudeUsageUpdateClient = {
  sessionUpdate(params: ClaudeUsageUpdateNotification): Promise<void>;
  extNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void>;
};

type ClaudeUsageUpdateLogger = {
  error: (...args: unknown[]) => void;
};

type ClaudeUsagePatchedClient = ClaudeUsageUpdateClient & {
  [CLIENT_PATCH_MARKER]?: boolean;
  [SESSION_USAGE_PROXY_STATE]?: Map<string, SessionUsageProxyState>;
};

type SessionUsageProxyState = {
  latestUsedTokens?: number;
  compactedSinceLatestUsage?: boolean;
  lastKnownMaxTokens?: number;
  suppressCostUsageAfterCompact?: boolean;
};

const CLIENT_PATCH_MARKER = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-patch",
);
const SESSION_USAGE_PROXY_STATE = Symbol.for(
  "feishu-cursor-bridge/claude-agent-acp-context-proxy-state",
);

function extractUsedTokensFromResultMessage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as ClaudeSdkMessage;
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

function isCompactBoundaryMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as ClaudeSdkMessage;
  return message.type === "system" && message.subtype === "compact_boundary";
}

export function buildAccurateClaudeContextUsageUpdate(
  sessionId: string,
  usedTokens: number,
  maxTokens: number,
): ClaudeUsageUpdateNotification | undefined {
  if (
    !Number.isFinite(usedTokens) ||
    usedTokens <= 0 ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0
  ) {
    return undefined;
  }
  return {
    sessionId,
    update: {
      sessionUpdate: "usage_update",
      used: Math.floor(usedTokens),
      size: Math.floor(maxTokens),
    },
  };
}

export function patchClaudeAcpAgentContextUsage(
  agent: {
    client: ClaudeUsagePatchedClient;
    logger: ClaudeUsageUpdateLogger;
  },
): void {
  const client = agent.client;
  if (client[CLIENT_PATCH_MARKER]) {
    return;
  }

  const originalSessionUpdate = client.sessionUpdate.bind(client);
  const originalExtNotification = client.extNotification.bind(client);
  const stateBySession = new Map<string, SessionUsageProxyState>();
  client[SESSION_USAGE_PROXY_STATE] = stateBySession;

  client.extNotification = async (method, notificationParams) => {
    if (method === "_claude/sdkMessage") {
      const sessionId =
        typeof notificationParams.sessionId === "string"
          ? notificationParams.sessionId
          : undefined;
      if (sessionId) {
        const current = stateBySession.get(sessionId) ?? {};
        const usedTokens = extractUsedTokensFromResultMessage(
          notificationParams.message,
        );
        if (usedTokens != null) {
          if (!current.suppressCostUsageAfterCompact) {
            current.latestUsedTokens = usedTokens;
            current.compactedSinceLatestUsage = false;
          }
        } else if (isCompactBoundaryMessage(notificationParams.message)) {
          current.latestUsedTokens = undefined;
          current.compactedSinceLatestUsage = true;
          current.suppressCostUsageAfterCompact = true;
        }
        stateBySession.set(sessionId, current);
      }
    }

    await originalExtNotification(method, notificationParams);
  };

  client.sessionUpdate = async (notification) => {
    const update = notification.update;
    if (
      update?.sessionUpdate === "usage_update" &&
      update.cost == null &&
      typeof notification.sessionId === "string"
    ) {
      const current = stateBySession.get(notification.sessionId);
      if (
        current?.compactedSinceLatestUsage &&
        typeof current.lastKnownMaxTokens === "number" &&
        Number.isFinite(current.lastKnownMaxTokens) &&
        current.lastKnownMaxTokens > 0
      ) {
        current.compactedSinceLatestUsage = false;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate({
          ...notification,
          update: {
            ...update,
            size: current.lastKnownMaxTokens,
          },
        });
        return;
      }
    }
    if (
      update?.sessionUpdate === "usage_update" &&
      update.cost != null &&
      typeof notification.sessionId === "string"
    ) {
      const current = stateBySession.get(notification.sessionId);
      if (current?.compactedSinceLatestUsage) {
        current.compactedSinceLatestUsage = false;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate(notification);
        return;
      }
      if (
        current?.suppressCostUsageAfterCompact &&
        typeof current.lastKnownMaxTokens === "number" &&
        Number.isFinite(current.lastKnownMaxTokens) &&
        current.lastKnownMaxTokens > 0
      ) {
        current.suppressCostUsageAfterCompact = false;
        current.latestUsedTokens = undefined;
        stateBySession.set(notification.sessionId, current);
        await originalSessionUpdate({
          ...notification,
          update: {
            ...update,
            used: 0,
            size: current.lastKnownMaxTokens,
          },
        });
        return;
      }
      if (
        current?.latestUsedTokens != null &&
        typeof update.size === "number" &&
        Number.isFinite(update.size) &&
        update.size > 0
      ) {
        const corrected = buildAccurateClaudeContextUsageUpdate(
          notification.sessionId,
          current.latestUsedTokens,
          update.size,
        );
        if (corrected) {
          current.lastKnownMaxTokens = corrected.update.size;
          current.latestUsedTokens = undefined;
          stateBySession.set(notification.sessionId, current);
          await originalSessionUpdate(corrected);
          return;
        }
      }
      if (
        current &&
        typeof update.size === "number" &&
        Number.isFinite(update.size) &&
        update.size > 0
      ) {
        current.lastKnownMaxTokens = update.size;
        stateBySession.set(notification.sessionId, current);
      }
    }

    await originalSessionUpdate(notification);
  };

  client[CLIENT_PATCH_MARKER] = true;
}

function isEntrypoint(): boolean {
  return (
    process.argv[1] != null &&
    pathToFileURL(process.argv[1]).href === import.meta.url
  );
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

    // stdout is used by ACP transport; route incidental logging to stderr.
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
    console.debug = console.error;

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    const { connection, agent } = runAcp();
    patchClaudeAcpAgentContextUsage(agent);

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
