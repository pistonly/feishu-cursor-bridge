import { EventEmitter } from "node:events";
import type {
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as path from "node:path";
import type { Config } from "../config.js";
import { mapSessionNotificationToBridgeEvents } from "./events.js";
import { readTextFileSafe, writeTextFileSafe } from "./fs-sandbox.js";
import type { BridgeAcpEvent } from "./types.js";

export interface FeishuBridgeClientEvents {
  acp: [BridgeAcpEvent];
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

  constructor(config: Config) {
    super();
    this.config = config;
    this.defaultWorkspaceRoot = path.resolve(config.acp.workspaceRoot);
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
    const events = mapSessionNotificationToBridgeEvents(params);
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
    this.emit("acp", {
      type: "tool_call",
      sessionId: params.sessionId,
      toolCallId: tcId,
      title: `等待批准: ${toolTitle}`,
      status: "permission_required",
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
}
