import { EventEmitter } from "node:events";
import {
  RequestError,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolKind,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as path from "node:path";
import type { Config } from "../config/index.js";
import {
  mapClaudeSdkMessageToBridgeEvents,
  mapSessionNotificationToBridgeEvents,
} from "./events.js";
import {
  assertPathInWorkspace,
  readTextFileSafe,
  writeTextFileSafe,
} from "./fs-sandbox.js";
import type { BridgeAcpEvent } from "./types.js";


export type FeishuSendPromptContext = {
  chatId: string;
  messageId: string;
  replyInThread?: boolean;
};

export type FeishuBridgeClientDeps = {
  uploadSessionFileToFeishu?: (
    ctx: FeishuSendPromptContext,
    absPath: string,
  ) => Promise<string>;
};

export const FEISHU_BRIDGE_EXT_SEND_FILE_METHOD = "io.feishu-bridge/send_file";

export interface FeishuBridgeClientEvents {
  acp: [BridgeAcpEvent];
}

/** 仅用于 ACP_RELOAD_TRACE_LOG，避免把整段模型输出打进日志 */
function summarizeSessionUpdateForTrace(update: SessionUpdate): string {
  const k = update.sessionUpdate;
  switch (k) {
    case "user_message_chunk":
      return "user_message_chunk";
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const len =
        update.content?.type === "text" && typeof update.content.text === "string"
          ? update.content.text.length
          : 0;
      return `${k} textLen=${len}`;
    }
    case "tool_call":
      return `tool_call toolCallId=${String(update.toolCallId ?? "")} status=${String(update.status ?? "")}`;
    case "tool_call_update":
      return `tool_call_update toolCallId=${String(update.toolCallId ?? "")} status=${String(update.status ?? "")}`;
    case "plan":
      return `plan entries=${update.entries?.length ?? 0}`;
    case "available_commands_update":
      return `available_commands_update n=${update.availableCommands?.length ?? 0}`;
    case "current_mode_update":
      return `current_mode_update modeId=${String(update.currentModeId ?? "")}`;
    case "config_option_update":
      return "config_option_update";
    case "session_info_update":
      return "session_info_update";
    case "usage_update":
      return "usage_update";
    default:
      return k;
  }
}

function summarizeExtNotificationForTrace(
  method: string,
  params: Record<string, unknown>,
): string {
  if (method !== "_claude/sdkMessage") {
    return method;
  }
  const sessionId =
    typeof params.sessionId === "string" ? params.sessionId : "<unknown>";
  const message =
    params.message && typeof params.message === "object"
      ? (params.message as { type?: unknown; subtype?: unknown })
      : undefined;
  const type = typeof message?.type === "string" ? message.type : "<unknown>";
  const subtype =
    typeof message?.subtype === "string" ? ` subtype=${message.subtype}` : "";
  return `${method} sessionId=${sessionId} type=${type}${subtype}`;
}

function pickAllowOption(
  options: RequestPermissionRequest["options"],
): string | undefined {
  const allow =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.kind === "allow_always");
  return allow?.optionId;
}

/**
 * 实现 ACP Client 接口：把 Agent 的 session/update 转为内部事件；在「工作区沙箱」内响应读/写文件；处理权限问询。
 */
export class FeishuBridgeClient
  extends EventEmitter<FeishuBridgeClientEvents>
  implements Client
{
  private readonly config: Config;
  private readonly defaultWorkspaceRoot: string;
  private readonly sessionWorkspaceRoots = new Map<string, string>();
  private readonly fileSendDeps?: FeishuBridgeClientDeps;
  private readonly feishuPromptContexts = new Map<string, FeishuSendPromptContext>();

  constructor(config: Config, deps?: FeishuBridgeClientDeps) {
    super();
    this.config = config;
    this.defaultWorkspaceRoot = path.resolve(config.acp.workspaceRoot);
    this.fileSendDeps = deps;
  }

  setFeishuPromptContext(
    sessionId: string,
    ctx: FeishuSendPromptContext | undefined,
  ): void {
    if (ctx === undefined) {
      this.feishuPromptContexts.delete(sessionId);
    } else {
      this.feishuPromptContexts.set(sessionId, ctx);
    }
  }

  /** 绑定 ACP sessionId 与读/写沙箱根（与 session/new 的 cwd 一致） */
  setSessionWorkspace(sessionId: string, workspaceRoot: string): void {
    this.sessionWorkspaceRoots.set(sessionId, path.resolve(workspaceRoot));
  }

  removeSessionWorkspace(sessionId: string): void {
    this.sessionWorkspaceRoots.delete(sessionId);
  }

  private fsRootForSession(sessionId: string): string {
    return this.sessionWorkspaceRoots.get(sessionId) ?? this.defaultWorkspaceRoot;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    if (this.config.acpReloadTraceLog) {
      const meta = params._meta;
      const metaKeys =
        meta && typeof meta === "object" && meta !== null
          ? Object.keys(meta).join(",")
          : "";
      const summary = summarizeSessionUpdateForTrace(params.update);
      console.log(
        `[acp reload-trace] sessionUpdate inbound sessionId=${params.sessionId} update=${summary}${metaKeys ? ` _metaKeys=${metaKeys}` : ""}`,
      );
    }

    const events = mapSessionNotificationToBridgeEvents(params);
    if (this.config.acpReloadTraceLog && events.length > 0) {
      console.log(
        `[acp reload-trace] sessionUpdate mapped bridgeEvents=${events.map((e) => e.type).join(",")}`,
      );
    }

    for (const ev of events) {
      this.emit("acp", ev);
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.config.autoApprovePermissions) {
      const optionId =
        pickAllowOption(params.options) ?? params.options[0]?.optionId;
      if (!optionId) {
        return {
          outcome: { outcome: "cancelled" },
        };
      }
      return {
        outcome: {
          outcome: "selected",
          optionId,
        },
      };
    }

    const tc = params.toolCall;
    const toolTitle =
      typeof tc?.title === "string" && tc.title.length > 0
        ? tc.title
        : "工具权限";
    const tcId =
      typeof tc?.toolCallId === "string" && tc.toolCallId.length > 0
        ? tc.toolCallId
        : "permission";
    const permissionKind: ToolKind | undefined =
      tc &&
      typeof tc === "object" &&
      "kind" in tc &&
      tc.kind != null &&
      typeof tc.kind === "string"
        ? (tc.kind as ToolKind)
        : undefined;
    this.emit("acp", {
      type: "tool_call",
      sessionId: params.sessionId,
      toolCallId: tcId,
      title: `等待批准: ${toolTitle}`,
      status: "permission_required",
      ...(permissionKind !== undefined ? { kind: permissionKind } : {}),
    });

    const optionId =
      pickAllowOption(params.options) ?? params.options[0]?.optionId;
    if (!optionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId },
    };
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    return readTextFileSafe(
      this.fsRootForSession(params.sessionId),
      params.path,
      params.line,
      params.limit,
    );
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await writeTextFileSafe(
      this.fsRootForSession(params.sessionId),
      params.path,
      params.content,
    );
    return {};
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method !== FEISHU_BRIDGE_EXT_SEND_FILE_METHOD) {
      throw RequestError.methodNotFound(method);
    }

    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    const rawPath = typeof params.path === "string" ? params.path.trim() : "";
    if (!sessionId || !rawPath) {
      return { ok: false, error: "缺少 sessionId 或 path" };
    }

    const upload = this.fileSendDeps?.uploadSessionFileToFeishu;
    if (!upload) {
      return { ok: false, error: "桥接未配置文件发送到飞书" };
    }

    const ctx = this.feishuPromptContexts.get(sessionId);
    if (!ctx) {
      return {
        ok: false,
        error: "没有当前飞书对话上下文（仅在与飞书联动的请求处理过程中可用）",
      };
    }

    const root = this.fsRootForSession(sessionId);
    let abs: string;
    try {
      const candidate = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(root, rawPath);
      abs = assertPathInWorkspace(root, candidate);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    try {
      const messageId = await upload(ctx, abs);
      return { ok: true, messageId };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.config.acpReloadTraceLog) {
      console.log(
        `[acp reload-trace] extNotification inbound ${summarizeExtNotificationForTrace(method, params)}`,
      );
    }
    if (method !== "_claude/sdkMessage") {
      return;
    }

    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    if (!sessionId) return;

    const events = mapClaudeSdkMessageToBridgeEvents(sessionId, params.message);
    if (this.config.acpReloadTraceLog && events.length > 0) {
      console.log(
        `[acp reload-trace] extNotification mapped bridgeEvents=${events.map((e) => e.type).join(",")}`,
      );
    }
    for (const ev of events) {
      this.emit("acp", ev);
    }
  }

}
