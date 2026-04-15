import type {
  SessionNotification,
  SessionUpdate,
  PlanEntry,
} from "@agentclientprotocol/sdk";
import type {
  BridgeAcpEvent,
  BridgeConfigOptionValue,
} from "./types.js";
import type { AcpSessionUsageState } from "./runtime-contract.js";

type ClaudeSdkResultMessage = {
  type?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  } | null;
  modelUsage?: Record<
    string,
    {
      contextWindow?: unknown;
    }
  > | null;
};

function summarizePlan(entries: Array<PlanEntry>): string {
  return entries
    .map((e, i) => {
      const status = e.status ?? "?";
      const body = e.content ?? "";
      return `${i + 1}. [${status}] ${body}`.trim();
    })
    .join("\n");
}

function normalizeConfigOptionValues(
  raw: unknown,
): BridgeConfigOptionValue[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: BridgeConfigOptionValue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const option = item as {
      id?: unknown;
      currentValue?: unknown;
      category?: unknown;
    };
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const currentValue =
      typeof option.currentValue === "string" ? option.currentValue.trim() : "";
    if (!id || !currentValue) continue;
    out.push({
      id,
      currentValue,
      ...(typeof option.category === "string" && option.category.trim()
        ? { category: option.category.trim() }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeUsageUpdate(
  raw: unknown,
): AcpSessionUsageState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as { used?: unknown; size?: unknown };
  const used =
    typeof usage.used === "number" && Number.isFinite(usage.used) && usage.used >= 0
      ? usage.used
      : undefined;
  const size =
    typeof usage.size === "number" && Number.isFinite(usage.size) && usage.size > 0
      ? usage.size
      : undefined;
  if (used == null || size == null) {
    return undefined;
  }
  return {
    usedTokens: used,
    maxTokens: size,
    percent: (used / size) * 100,
  };
}

function normalizeClaudeSdkUsageProxy(
  raw: unknown,
): AcpSessionUsageState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as ClaudeSdkResultMessage;
  if (message.type !== "result") return undefined;

  const usage = message.usage;
  if (!usage || typeof usage !== "object") return undefined;

  const parts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ];
  let usedTokens = 0;
  for (const part of parts) {
    if (typeof part !== "number" || !Number.isFinite(part) || part < 0) {
      return undefined;
    }
    usedTokens += part;
  }
  if (usedTokens <= 0) return undefined;

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
  if (maxTokens <= 0) return undefined;

  return {
    usedTokens,
    maxTokens,
    percent: (usedTokens / maxTokens) * 100,
  };
}

/**
 * 将官方 SDK 的 session/update 通知转为桥接内部事件列表（0~n 条）。
 */
export function mapSessionNotificationToBridgeEvents(
  n: SessionNotification,
): BridgeAcpEvent[] {
  const { sessionId, update } = n;
  return mapSessionUpdateToBridgeEvents(sessionId, update);
}

export function mapSessionUpdateToBridgeEvents(
  sessionId: string,
  update: SessionUpdate,
): BridgeAcpEvent[] {
  const out: BridgeAcpEvent[] = [];
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const c = update.content;
      if (c?.type === "text" && typeof c.text === "string") {
        out.push({ type: "user_message_chunk", sessionId, text: c.text });
      }
      break;
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const c = update.content;
      if (c?.type === "text" && typeof c.text === "string") {
        out.push(
          update.sessionUpdate === "agent_message_chunk"
            ? { type: "agent_message_chunk", sessionId, text: c.text }
            : { type: "agent_thought_chunk", sessionId, text: c.text },
        );
      }
      break;
    }
    case "tool_call": {
      const title = update.title;
      const toolCallId = update.toolCallId;
      const status = String(update.status ?? "pending");
      const kind = update.kind ?? undefined;
      out.push({
        type: "tool_call",
        sessionId,
        toolCallId,
        title,
        status,
        ...(kind !== undefined ? { kind } : {}),
      });
      break;
    }
    case "tool_call_update": {
      const toolCallId = update.toolCallId;
      const status = String(update.status ?? "?");
      const title =
        typeof update.title === "string" ? update.title : undefined;
      const kind = update.kind ?? undefined;
      out.push({
        type: "tool_call_update",
        sessionId,
        toolCallId,
        status,
        title,
        ...(kind !== undefined ? { kind } : {}),
      });
      break;
    }
    case "plan": {
      const summary = summarizePlan(update.entries ?? []);
      if (summary) out.push({ type: "plan", sessionId, summary });
      break;
    }
    case "available_commands_update": {
      const cmds = update.availableCommands ?? [];
      const summary = cmds
        .map((c) => c.name + (c.description ? ` — ${c.description}` : ""))
        .join("\n");
      if (summary) out.push({ type: "available_commands_update", sessionId, summary });
      break;
    }
    case "current_mode_update": {
      const modeId = String(update.currentModeId ?? "");
      if (modeId) {
        out.push({
          type: "current_mode_update",
          sessionId,
          modeId,
        });
      }
      break;
    }
    case "config_option_update": {
      const configOptions = normalizeConfigOptionValues(
        (update as { configOptions?: unknown }).configOptions,
      );
      out.push({
        type: "config_option_update",
        sessionId,
        summary: "配置项已更新",
        ...(configOptions ? { configOptions } : {}),
      });
      break;
    }
    case "session_info_update": {
      out.push({
        type: "session_info_update",
        sessionId,
        summary: "会话信息已更新",
      });
      break;
    }
    case "usage_update": {
      const usage = normalizeUsageUpdate(update);
      out.push({
        type: "usage_update",
        sessionId,
        summary: usage
          ? `用量统计已更新（${usage.percent.toFixed(1).replace(/\.0$/, "")}%）`
          : "用量统计已更新",
        ...(usage ? { usage } : {}),
      });
      break;
    }
    default:
      break;
  }
  return out;
}

export function mapClaudeSdkMessageToBridgeEvents(
  sessionId: string,
  message: unknown,
): BridgeAcpEvent[] {
  const usage = normalizeClaudeSdkUsageProxy(message);
  if (!usage) return [];
  return [
    {
      type: "usage_update",
      sessionId,
      summary: `Claude raw SDK 用量已更新（${usage.percent.toFixed(1).replace(/\.0$/, "")}%）`,
      usage,
    },
  ];
}
