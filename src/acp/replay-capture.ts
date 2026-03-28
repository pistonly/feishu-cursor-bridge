import type { FeishuBridgeClient } from "./feishu-bridge-client.js";
import type { BridgeAcpEvent } from "./types.js";

type LabelBuf = { label: string; text: string } | null;

/**
 * 在 `session/load` 等会触发适配器「历史回放」的操作期间，订阅 `acp` 事件并折叠为可读 markdown。
 * 连续同角色（用户/助手/思考）的块会合并，避免重复小标题。
 */
export async function captureAcpReplayDuring(
  client: FeishuBridgeClient,
  sessionId: string,
  run: () => Promise<void>,
): Promise<string> {
  let cur: LabelBuf = null;
  const blocks: string[] = [];
  const extras: string[] = [];

  const flush = (): void => {
    if (!cur) return;
    blocks.push(`**${cur.label}**\n${cur.text}`);
    cur = null;
  };

  const pushText = (label: string, text: string): void => {
    if (cur && cur.label === label) {
      cur.text += text;
      return;
    }
    flush();
    cur = { label, text };
  };

  const handler = (ev: BridgeAcpEvent): void => {
    if (ev.sessionId !== sessionId) return;
    switch (ev.type) {
      case "user_message_chunk":
        pushText("用户", ev.text);
        break;
      case "agent_message_chunk":
        pushText("助手", ev.text);
        break;
      case "agent_thought_chunk":
        pushText("思考", ev.text);
        break;
      case "plan":
        flush();
        extras.push(`**计划**\n\`\`\`\n${ev.summary}\n\`\`\``);
        break;
      case "tool_call":
        flush();
        extras.push(`• 工具 \`${ev.title}\` — ${ev.status}`);
        break;
      case "tool_call_update":
        flush();
        extras.push(
          `• 工具更新 \`${ev.toolCallId}\`${ev.title ? ` (${ev.title})` : ""} — ${ev.status}`,
        );
        break;
      case "available_commands_update":
        flush();
        extras.push(`**可用命令**\n\`\`\`\n${ev.summary}\n\`\`\``);
        break;
      case "current_mode_update":
        flush();
        extras.push(`**当前模式** \`${ev.modeId}\``);
        break;
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        flush();
        extras.push(`• _${ev.type}_：${ev.summary}`);
        break;
      default:
        break;
    }
  };

  client.on("acp", handler);
  try {
    await run();
    // 给 stdio 上紧随其后的 notification 一个事件循环节拍，减少「先 resolve 后到达」的丢包
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    client.off("acp", handler);
    flush();
  }

  const main = blocks.join("\n\n").trim();
  const extra = extras.length > 0 ? extras.join("\n") : "";
  if (!main && !extra) {
    return "";
  }
  if (!main) return extra;
  if (!extra) return main;
  return `${main}\n\n${extra}`;
}
