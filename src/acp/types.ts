import type { ToolKind } from "@agentclientprotocol/sdk";

/**
 * 桥接内部统一事件：由 ACP SessionNotification / SessionUpdate 归一化而来，供飞书渲染与调试。
 */
export type BridgeAcpEvent =
  | {
      type: "user_message_chunk";
      sessionId: string;
      text: string;
    }
  | {
      type: "agent_message_chunk";
      sessionId: string;
      text: string;
    }
  | {
      type: "agent_thought_chunk";
      sessionId: string;
      text: string;
    }
  | {
      type: "tool_call";
      sessionId: string;
      toolCallId: string;
      title: string;
      status: string;
      kind?: ToolKind;
    }
  | {
      type: "tool_call_update";
      sessionId: string;
      toolCallId: string;
      status: string;
      title?: string;
      kind?: ToolKind;
    }
  | {
      type: "plan";
      sessionId: string;
      summary: string;
    }
  | {
      type: "available_commands_update";
      sessionId: string;
      summary: string;
    }
  | {
      type: "current_mode_update";
      sessionId: string;
      modeId: string;
    }
  | {
      type: "config_option_update";
      sessionId: string;
      summary: string;
    }
  | {
      type: "session_info_update";
      sessionId: string;
      summary: string;
    }
  | {
      type: "usage_update";
      sessionId: string;
      summary: string;
    };
