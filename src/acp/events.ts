import type {
  SessionNotification,
  SessionUpdate,
  PlanEntry,
} from "@agentclientprotocol/sdk";
import type {
  BridgeAcpEvent,
  BridgeConfigOptionValue,
} from "./types.js";

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
      out.push({
        type: "usage_update",
        sessionId,
        summary: "用量统计已更新",
      });
      break;
    }
    default:
      break;
  }
  return out;
}
