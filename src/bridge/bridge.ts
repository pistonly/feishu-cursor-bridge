import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  AcpRuntimeRegistry,
  formatAcpBackendLabel,
  resolveAdapterSessionTimeoutMs,
} from "../acp/runtime.js";
import type {
  AcpBackend,
  AcpSessionModelState,
  AcpSessionUsageState,
  BridgeAcpRuntime,
} from "../acp/runtime-contract.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";
import {
  FeishuBot,
  FEISHU_INCOMING_DIR_NAME,
  type FeishuIncomingResource,
  type FeishuMessage,
} from "../feishu/bot.js";
import {
  matchesBridgeHelpCommand,
  matchesBridgeStartCommand,
  matchesInterruptUserCommand,
  parseNewConversationCommand,
} from "../commands/parse-new-conversation.js";
import { SessionManager, type SessionSlot } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
import { ConversationService } from "./conversation-service.js";
import { resolveAllowedWorkspaceDir } from "../session/workspace-policy.js";
import { WorkspacePresetsStore } from "../session/workspace-presets-store.js";
import { captureAcpReplayDuring } from "../acp/replay-capture.js";
import {
  formatModelSwitchFailure,
  formatModelUsage,
  resolveModelSelectorInput,
} from "../commands/model-switch.js";
import {
  formatModeSwitchFailure,
  formatModeUsage,
  resolveSessionModeInput,
} from "../commands/mode-switch.js";
import {
  parseFilebackUserMessage,
  FILEBACK_USAGE_TEXT,
  wrapFilebackPromptForAgent,
} from "../commands/fileback-command.js";
import { formatBridgeCommandsHelp } from "./bridge-commands-help.js";
import { buildWorkspaceWithBackendSelectCardMarkdown, buildWelcomeCardMarkdown } from "../feishu/interactive-cards.js";
import {
  BridgeMaintenanceStateStore,
  type BridgeMaintenanceCommandKind,
  type CompletedBridgeMaintenanceTask,
} from "./maintenance-state.js";
import { UpgradeResultStore, type UpgradeAttemptRecord } from "./upgrade-result-store.js";
import { SlotMessageLogStore } from "./slot-message-log.js";

/** 无活跃 session 时，普通对话与部分命令的统一提示 */
const NO_SESSION_HINT =
  "当前没有可用的 session。请先发送 `/new list` 查看工作区列表，再用 `/new <序号>` 或 `/new <目录绝对路径>` 创建 session。\n\n发送 `/commands`、`/help` 或只发 `/`（全角 `／` 亦可）可查看本桥接支持的全部命令，**无需先建 session**。";
const MAINTENANCE_OUTPUT_LIMIT = 12_000;

type RunningMaintenanceTask = {
  kind: BridgeMaintenanceCommandKind;
  requestedBy: string;
  requestedAt: number;
  forced: boolean;
};

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    return true;
  }
}

function formatWhoAmIMessage(senderId: string): string {
  if (!senderId.trim()) {
    return "❌ 当前消息未解析到发送者 ID，请检查飞书事件负载中的 `sender.sender_id`。";
  }
  return [
    `👤 当前消息识别到的飞书用户 ID：\`${senderId}\``,
    "",
    "桥接管理员校验会直接比对这个值；如需配置 `BRIDGE_ADMIN_USER_IDS`，请原样填入。",
    "说明：桥接优先使用 `open_id`，缺失时才回退到 `user_id` / `union_id`。",
  ].join("\n");
}

function formatIncomingAttachmentPrompt(
  relativePath: string,
  res: FeishuIncomingResource,
): string {
  const kindLabel =
    res.messageKind === "image"
      ? "图片"
      : res.messageKind === "audio"
        ? "音频"
        : res.messageKind === "video"
          ? "视频"
          : "文件";
  const lines: string[] = [
    `用户通过飞书发送了${kindLabel}，已保存到工作区子目录 \`${FEISHU_INCOMING_DIR_NAME}/\`。`,
    "",
    `相对路径（相对工作区根目录）：\`${relativePath}\``,
  ];
  if (res.displayName) {
    lines.push(`原始文件名：\`${res.displayName}\``);
  }
  lines.push(`（飞书消息类型：${res.messageKind}；资源接口 type=\`${res.apiType}\`）`);
  return lines.join("\n");
}

function formatPostEmbeddedImagesPrompt(
  textBody: string,
  relativePaths: string[],
): string {
  const lines: string[] = [
    `用户发送了飞书富文本（post）消息，其中包含 ${relativePaths.length} 张内嵌图片，已保存到工作区子目录 \`${FEISHU_INCOMING_DIR_NAME}/\`。`,
    "",
  ];
  for (let i = 0; i < relativePaths.length; i++) {
    lines.push(`${i + 1}. 相对路径（相对工作区根目录）：\`${relativePaths[i]}\``);
  }
  lines.push("", "（飞书消息类型：post；资源接口 type=\`image\`）");
  const trimmed = textBody.trim();
  if (trimmed) {
    lines.push("", "富文本中的文字内容如下：", "", trimmed);
  }
  return lines.join("\n");
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "永不过期";
  }
  if (ms % (24 * 60 * 60_000) === 0) {
    return `${ms / (24 * 60 * 60_000)} 天`;
  }
  if (ms % (60 * 60_000) === 0) {
    return `${ms / (60 * 60_000)} 小时`;
  }
  return `${Math.round(ms / 60_000)} 分钟`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatSessionUsage(
  usage: AcpSessionUsageState | undefined,
): string | undefined {
  if (!usage) return undefined;
  return `${formatPercent(usage.percent)} (${formatNumber(usage.usedTokens)} / ${formatNumber(usage.maxTokens)})`;
}

function formatSessionModel(
  modelState: AcpSessionModelState | undefined,
): string | undefined {
  if (!modelState?.currentModelId) return undefined;
  const current = modelState.availableModels.find(
    (model) => model.modelId === modelState.currentModelId,
  );
  if (current?.name && current.name !== current.modelId) {
    return current.name;
  }
  return `\`${modelState.currentModelId}\``;
}

function appendWithLimit(buffer: string, chunk: string, limit: number): string {
  if (!chunk) return buffer;
  const merged = buffer + chunk;
  return merged.length > limit ? merged.slice(-limit) : merged;
}

async function runCapturedCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendWithLimit(stdout, chunk, MAINTENANCE_OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendWithLimit(stderr, chunk, MAINTENANCE_OUTPUT_LIMIT);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const lines = [`命令失败：\`${command} ${args.join(" ")}\``];
      if (code != null) lines.push(`退出码：${code}`);
      if (signal) lines.push(`信号：${signal}`);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (output) {
        lines.push("", "最近输出：", output.slice(-MAINTENANCE_OUTPUT_LIMIT));
      }
      reject(new Error(lines.join("\n")));
    });
  });
}

export class Bridge {
  private config: Config;
  private runtimeRegistry: AcpRuntimeRegistry;
  private feishuBot: FeishuBot;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private presetsStore: WorkspacePresetsStore;
  private conversations: Map<AcpBackend, ConversationService>;
  private upgradeResultStore: UpgradeResultStore;
  private slotMessageLog: SlotMessageLogStore;
  /** key: `<sessionKey>:<slotIndex>` — 同一 slot 同一时刻只能有一个 prompt 在跑 */
  private activePrompts = new Set<string>();
  private maintenanceStateStore: BridgeMaintenanceStateStore;
  private maintenanceStateReady: Promise<void> | null = null;
  private activeMaintenance: RunningMaintenanceTask | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  /** 记录已发送过欢迎消息的用户 */
  private welcomedUsers = new Set<string>();

  constructor(config: Config) {
    this.config = config;
    this.feishuBot = new FeishuBot({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain,
      bridgeDebug: config.bridgeDebug,
    });
    this.runtimeRegistry = new AcpRuntimeRegistry(config);
    this.sessionStore = new SessionStore(
      config.bridge.sessionStorePath,
      config.acp.backend,
    );
    this.maintenanceStateStore = new BridgeMaintenanceStateStore(
      config.bridge.maintenanceStatePath,
    );
    this.upgradeResultStore = new UpgradeResultStore(
      config.bridge.upgradeResultPath,
    );
    this.presetsStore = new WorkspacePresetsStore(
      config.bridge.workspacePresetsPath,
    );
    this.slotMessageLog = new SlotMessageLogStore(
      path.join(path.dirname(config.bridge.sessionStorePath), "slot-logs"),
    );
    this.sessionManager = new SessionManager(
      this.runtimeRegistry,
      this.sessionStore,
      config.bridge.sessionIdleTimeoutMs,
      {
        debug: config.bridgeDebug,
        defaultWorkspaceRoot: config.acp.workspaceRoot,
        defaultBackend: config.acp.backend,
        maxSessionsPerUser: config.bridge.maxSessionsPerUser,
      },
    );
    this.conversations = new Map();
  }

  async start(): Promise<void> {
    if (this.config.bridgeDebug) {
      console.log(
        "[bridge] BRIDGE_DEBUG=true — 控制台输出 ACP/会话信息；/status 含 session 与路径",
      );
    }

    await this.ensureMaintenanceStateLoaded();
    await this.upgradeResultStore.load();
    await this.reconcileUpgradeAttempt();
    await this.sessionManager.init();
    await this.presetsStore.load(this.config.bridge.workspacePresetsSeed);

    const startedRuntimes = await this.runtimeRegistry.startEnabledRuntimes();
    for (const runtime of startedRuntimes) {
      console.log(
        `[bridge] ${formatAcpBackendLabel(runtime.backend)} 已连接 protocolVersion=${runtime.initializeResult?.protocolVersion} loadSession=${runtime.supportsLoadSession}`,
      );
      this.conversations.set(
        runtime.backend,
        new ConversationService(this.config, runtime, this.feishuBot),
      );
      if (this.config.bridgeDebug) {
        runtime.bridgeClient.on("acp", (ev) => {
          console.log(`[bridge:debug] [${runtime.backend}] acp ${ev.type}`, ev);
        });
      }
    }

    this.feishuBot.on("ready", () => {
      console.log("[bridge] Feishu bot connected and ready");
    });

    this.feishuBot.on("message", (msg: FeishuMessage) => {
      this.handleFeishuMessage(msg).catch((err) => {
        console.error("[bridge] Error handling message:", err);
      });
    });

    await this.feishuBot.start();

    this.cleanupInterval = setInterval(() => {
      void this.sessionManager
        .cleanupExpired()
        .then((cleaned) => {
          if (cleaned > 0) {
            console.log(`[bridge] Cleaned up ${cleaned} expired sessions`);
          }
        })
        .catch((err) => {
          console.error("[bridge] cleanupExpired failed:", err);
        });
    }, 5 * 60 * 1000);

    console.log("[bridge] Service started successfully");
  }

  /** 话题群 / 话题线程内回复需传 `reply_in_thread` */
  private threadReplyOpts(
    msg: FeishuMessage,
  ): { replyInThread: true } | undefined {
    return msg.replyInThread ? { replyInThread: true } : undefined;
  }

  /** 与 SessionManager.makeKey 一致：群聊有 threadId 时按话题隔离会话 */
  private threadScope(msg: FeishuMessage): string | undefined {
    if (msg.chatType !== "group") return undefined;
    const t = msg.threadId?.trim();
    return t || undefined;
  }

  private runtimeForBackend(backend: AcpBackend): BridgeAcpRuntime {
    return this.runtimeRegistry.getRuntime(backend);
  }

  private runtimeForSession(session: { backend: AcpBackend }): BridgeAcpRuntime {
    return this.runtimeForBackend(session.backend);
  }

  private conversationForBackend(backend: AcpBackend): ConversationService {
    const existing = this.conversations.get(backend);
    if (existing) return existing;
    const created = new ConversationService(
      this.config,
      this.runtimeForBackend(backend),
      this.feishuBot,
    );
    this.conversations.set(backend, created);
    return created;
  }

  private async reconcileUpgradeAttempt(): Promise<void> {
    const attempt = this.upgradeResultStore.getAttempt();
    if (!attempt) return;
    if (attempt.state === "queued") {
      this.upgradeResultStore.setAttempt({
        ...attempt,
        state: "failed",
        finishedAt: Date.now(),
        errorMessage: "Upgrade launcher did not start",
      });
      await this.upgradeResultStore.flush();
      return;
    }
    if (attempt.state === "running") {
      if (attempt.runnerPid && isPidRunning(attempt.runnerPid)) {
        return;
      }
      this.upgradeResultStore.setAttempt({
        ...attempt,
        state: "failed",
        finishedAt: Date.now(),
        errorMessage: "Upgrade runner exited before persisting completion",
      });
      await this.upgradeResultStore.flush();
    }
  }

  private isUpgradeAdmin(msg: FeishuMessage): boolean {
    const admins = this.config.bridge.upgradeAdmins;
    const senderIds = msg.senderIds;
    return (
      (!!senderIds?.openId && admins.openIds.has(senderIds.openId)) ||
      (!!senderIds?.userId && admins.userIds.has(senderIds.userId)) ||
      (!!senderIds?.unionId && admins.unionIds.has(senderIds.unionId))
    );
  }

  private launchBackgroundUpgrade(attemptId: string): void {
    const runnerEntry = path.resolve(process.cwd(), "dist", "upgrade-runner.js");
    const child = spawn(process.execPath, [runnerEntry, attemptId], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }

  private async handleUpgradeCommand(
    msg: FeishuMessage,
    command: { force: boolean; invalidUsage?: boolean },
  ): Promise<void> {
    if (command.invalidUsage) {
      await this.feishuBot.sendText(
        msg.chatId,
        this.maintenanceUsage("upgrade"),
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (this.activePrompts.size > 0 && !command.force) {
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ 当前仍有 ${this.activePrompts.size} 个请求在处理中。请等待完成或先中断，再执行 \`/upgrade\`；若确认要直接升级，可改用 \`/upgrade --force\`。`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (!(await this.isManagedByService())) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 当前进程未检测到 launchd/systemd 托管，无法保证升级后自动恢复。请先使用 `bash service.sh install` 或确保由服务管理器拉起。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (!this.config.bridge.enableUpgradeCommand) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 当前未启用聊天升级命令。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (!this.isUpgradeAdmin(msg)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ /upgrade 仅管理员可用。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    const existingAttempt = this.upgradeResultStore.getAttempt();
    if (
      existingAttempt &&
      (existingAttempt.state === "queued" || existingAttempt.state === "running")
    ) {
      await this.feishuBot.sendText(
        msg.chatId,
        "ℹ️ 已有升级任务在执行，请勿重复触发。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    const threadId = this.threadScope(msg);
    const attemptId = randomUUID();
    this.upgradeResultStore.setAttempt({
      id: attemptId,
      state: "queued",
      requestedAt: Date.now(),
      requestedBy: {
        chatId: msg.chatId,
        messageId: msg.messageId,
        senderId: msg.senderId,
        chatType: msg.chatType,
        ...(threadId ? { threadId } : {}),
      },
    });
    await this.upgradeResultStore.flush();

    try {
      await this.feishuBot.sendText(
        msg.chatId,
        `✅ 已接受升级请求${command.force ? "（--force）" : ""}，正在后台执行 \`bash service.sh upgrade\`。桥接可能会短暂重启并恢复，稍后可发送 \`/status\` 验证。`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      this.launchBackgroundUpgrade(attemptId);
    } catch (err) {
      this.upgradeResultStore.setAttempt({
        ...(this.upgradeResultStore.getAttempt() ?? {
          id: attemptId,
          state: "queued",
          requestedAt: Date.now(),
        }),
        state: "failed",
        finishedAt: Date.now(),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await this.upgradeResultStore.flush();
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ 启动升级任务失败：${err instanceof Error ? err.message : String(err)}`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
    }
  }

  private activeSnapshot(msg: FeishuMessage) {
    return this.sessionManager.getSessionSnapshot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
  }

  private async flushPendingSessionNotices(msg: FeishuMessage): Promise<void> {
    const notices = this.sessionManager.consumePendingNotices(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    for (const notice of notices) {
      await this.feishuBot.sendText(
        msg.chatId,
        notice,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
    }
  }

  /** 展示某个 slot 的「上一轮」卡片：提问 + 回复（旧数据可能仅有回复） */
  private buildSlotLastTurnCardContent(slot: SessionSlot): string | null {
    const hasPrompt = !!slot.lastPrompt?.trim();
    const hasReply = !!slot.lastReply?.trim();
    if (!hasPrompt && !hasReply) return null;

    const nameLabel = slot.name ? ` (${slot.name})` : "";
    const MAX_CARD_LEN = 28_000;
    const title = `**↩️ Session #${slot.slotIndex}${nameLabel} 上一轮对话：**\n\n`;
    const chunks: string[] = [];
    if (hasPrompt) chunks.push(`**提问：**\n\n${slot.lastPrompt!.trim()}`);
    if (hasReply) chunks.push(`**回复：**\n\n${slot.lastReply!.trim()}`);
    let body = title + chunks.join("\n\n");
    let truncated = false;
    if (body.length > MAX_CARD_LEN) {
      body = body.slice(0, MAX_CARD_LEN);
      truncated = true;
    }
    return body + (truncated ? "\n\n_（内容过长，已截断）_" : "");
  }

  private feishuSessionKey(msg: FeishuMessage): string {
    if (msg.chatType === "p2p") return `dm:${msg.senderId}`;
    const t = this.threadScope(msg);
    if (t) return `${msg.chatId}:t:${t}:${msg.senderId}`;
    return `${msg.chatId}:${msg.senderId}`;
  }

  private async appendSlotPromptLog(
    sessionKey: string,
    slot: SessionSlot,
    session: {
      backend: AcpBackend;
      sessionId: string;
      workspaceRoot: string;
      chatId: string;
      userId: string;
      chatType: "p2p" | "group";
      threadId?: string;
      createdAt: number;
      lastActiveAt: number;
    },
    msg: FeishuMessage,
    rawFeishuContent: string,
    agentPrompt: string,
  ): Promise<void> {
    try {
      await this.slotMessageLog.appendPrompt(
        {
          sessionKey,
          slot,
          session,
          msg,
        },
        rawFeishuContent,
        agentPrompt,
      );
    } catch (error) {
      console.warn(
        `[bridge] failed to append slot prompt log slot=#${slot.slotIndex} sessionKey=${sessionKey}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async appendSlotReplyLog(
    sessionKey: string,
    slot: SessionSlot,
    session: {
      backend: AcpBackend;
      sessionId: string;
      workspaceRoot: string;
      chatId: string;
      userId: string;
      chatType: "p2p" | "group";
      threadId?: string;
      createdAt: number;
      lastActiveAt: number;
    },
    msg: FeishuMessage,
    reply: string,
  ): Promise<void> {
    try {
      await this.slotMessageLog.appendReply({
        sessionKey,
        slot,
        session,
        msg,
      }, reply);
    } catch (error) {
      console.warn(
        `[bridge] failed to append slot reply log slot=#${slot.slotIndex} sessionKey=${sessionKey}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async appendSlotAcpChunkLog(
    sessionKey: string,
    slot: SessionSlot,
    session: {
      backend: AcpBackend;
      sessionId: string;
      workspaceRoot: string;
      chatId: string;
      userId: string;
      chatType: "p2p" | "group";
      threadId?: string;
      createdAt: number;
      lastActiveAt: number;
    },
    msg: FeishuMessage,
    chunkText: string,
  ): Promise<void> {
    try {
      await this.slotMessageLog.appendAcpAgentMessageChunk(
        {
          sessionKey,
          slot,
          session,
          msg,
        },
        chunkText,
      );
    } catch (error) {
      console.warn(
        `[bridge] failed to append slot ACP chunk log slot=#${slot.slotIndex} sessionKey=${sessionKey}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async appendSlotErrorLog(
    sessionKey: string,
    slot: SessionSlot,
    session: {
      backend: AcpBackend;
      sessionId: string;
      workspaceRoot: string;
      chatId: string;
      userId: string;
      chatType: "p2p" | "group";
      threadId?: string;
      createdAt: number;
      lastActiveAt: number;
    },
    msg: FeishuMessage,
    errorText: string,
  ): Promise<void> {
    try {
      await this.slotMessageLog.appendError({
        sessionKey,
        slot,
        session,
        msg,
      }, errorText);
    } catch (error) {
      console.warn(
        `[bridge] failed to append slot error log slot=#${slot.slotIndex} sessionKey=${sessionKey}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async ensureMaintenanceStateLoaded(): Promise<void> {
    if (!this.maintenanceStateReady) {
      this.maintenanceStateReady = (async () => {
        await this.maintenanceStateStore.load();
        const completed = await this.maintenanceStateStore.finalizePendingRestart(
          "服务已重新拉起。",
        );
        if (completed) {
          console.log(
            `[bridge] 完成维护任务 /${completed.kind} at ${new Date(completed.finishedAt).toISOString()}`,
          );
        }
      })();
    }
    await this.maintenanceStateReady;
  }

  private isBridgeAdmin(senderId: string): boolean {
    return this.config.bridge.adminUserIds.includes(senderId);
  }

  private async isManagedByService(): Promise<boolean> {
    if (this.config.bridge.managedByService) return true;
    if (process.ppid <= 1) return true;
    try {
      const { stdout } = await runCapturedCommand(
        "ps",
        ["-o", "comm=", "-p", String(process.ppid)],
        process.cwd(),
      );
      return /(?:^|\/)(launchd|systemd)\s*$/i.test(stdout.trim());
    } catch {
      return false;
    }
  }

  private formatIsoTimestamp(ms: number): string {
    return new Date(ms).toISOString().replace(".000Z", "Z");
  }

  private formatMaintenanceTaskSummary(
    task: CompletedBridgeMaintenanceTask,
  ): string {
    const statusLabel = task.status === "succeeded" ? "成功" : "失败";
    const detail = task.detail?.trim() ? `；详情：${task.detail.trim()}` : "";
    return `/${task.kind} ${statusLabel}（完成于 ${this.formatIsoTimestamp(task.finishedAt)}）${detail}`;
  }

  private formatUpgradeAttemptSummary(attempt: UpgradeAttemptRecord): string {
    const stateLabel =
      attempt.state === "queued"
        ? "排队中"
        : attempt.state === "running"
          ? "执行中"
          : attempt.state === "succeeded"
            ? "成功"
            : "失败";
    const timeLabel =
      attempt.state === "queued"
        ? `请求于 ${this.formatIsoTimestamp(attempt.requestedAt)}`
        : attempt.state === "running"
          ? `开始于 ${this.formatIsoTimestamp(attempt.startedAt ?? attempt.requestedAt)}`
          : `完成于 ${this.formatIsoTimestamp(attempt.finishedAt ?? attempt.startedAt ?? attempt.requestedAt)}`;
    const detail = attempt.errorMessage?.trim()
      ? `；原因：${attempt.errorMessage.trim()}`
      : attempt.exitCode != null
        ? `；退出码：${attempt.exitCode}`
        : "";
    return `${stateLabel}（${timeLabel}）${detail}`;
  }

  private maintenanceUsage(kind: BridgeMaintenanceCommandKind): string {
    return `用法：\`/${kind}\` 或 \`/${kind} --force\``;
  }

  private async runBridgeUpdateBuild(): Promise<string> {
    const cwd = process.cwd();
    const install = await runCapturedCommand("npm", ["install"], cwd);
    const build = await runCapturedCommand("npm", ["run", "build"], cwd);
    const output = [install.stdout, install.stderr, build.stdout, build.stderr]
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join("\n");
    return output ? output.slice(-MAINTENANCE_OUTPUT_LIMIT) : "npm install 与 npm run build 已完成。";
  }

  private scheduleSelfRestart(kind: BridgeMaintenanceCommandKind): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      console.log(`[bridge] 维护命令 /${kind} 完成，准备自退等待服务管理器拉起`);
      process.kill(process.pid, "SIGTERM");
    }, 800);
  }

  private async handleMaintenanceCommand(
    msg: FeishuMessage,
    command: { kind: "restart" | "update" | "upgrade"; force: boolean; invalidUsage?: boolean },
  ): Promise<void> {
    await this.ensureMaintenanceStateLoaded();
    if (command.invalidUsage) {
      await this.feishuBot.sendText(
        msg.chatId,
        this.maintenanceUsage(command.kind),
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (msg.chatType !== "p2p") {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ `/restart`、`/update` 仅允许管理员在私聊中执行。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (this.config.bridge.adminUserIds.length === 0) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 当前未配置 `BRIDGE_ADMIN_USER_IDS`，维护命令未启用。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (!this.isBridgeAdmin(msg.senderId)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 该命令仅允许管理员执行。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (!(await this.isManagedByService())) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 当前进程未检测到 launchd/systemd 托管，无法保证自重启。请先使用 `bash service.sh install` 或确保由服务管理器拉起。",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (this.activeMaintenance) {
      await this.feishuBot.sendText(
        msg.chatId,
        `⏳ 已有维护任务进行中：\`/${this.activeMaintenance.kind}\`（开始于 ${this.formatIsoTimestamp(this.activeMaintenance.requestedAt)}）。`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (this.activePrompts.size > 0 && !command.force) {
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ 当前仍有 ${this.activePrompts.size} 个请求在处理中。请等待完成或先中断，再执行 \`/${command.kind}\`；若确认要直接维护，可改用 \`/${command.kind} --force\`。`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    const requestedAt = Date.now();
    this.activeMaintenance = {
      kind: command.kind,
      requestedBy: msg.senderId,
      requestedAt,
      forced: command.force,
    };

    try {
      const startText =
        command.kind === "update"
          ? `🛠️ 已开始执行 \`/update\`${command.force ? "（--force）" : ""}：将运行 \`npm install\`、\`npm run build\`，成功后自动重启服务。`
          : `🛠️ 已接受 \`/restart\`${command.force ? "（--force）" : ""}：bridge 进程即将退出，并由服务管理器自动拉起。`;
      await this.feishuBot.sendText(
        msg.chatId,
        startText,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
    } catch (error) {
      console.warn(
        `[bridge] 维护命令 /${command.kind} 起始通知发送失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      let detail: string | undefined;
      if (command.kind === "update") {
        detail = await this.runBridgeUpdateBuild();
      }
      await this.maintenanceStateStore.setPendingRestart({
        kind: command.kind,
        requestedBy: msg.senderId,
        requestedAt,
        forced: command.force,
      });
      const finishText =
        command.kind === "update"
          ? "✅ `npm install` 与 `npm run build` 已完成，bridge 即将重启。稍后发送 `/status` 可查看结果。"
          : "✅ bridge 即将重启。稍后发送 `/status` 可查看结果。";
      try {
        await this.feishuBot.sendText(
          msg.chatId,
          finishText,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      } catch (error) {
        console.warn(
          `[bridge] 维护命令 /${command.kind} 完成通知发送失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (detail) {
        console.log(`[bridge] /update build output (tail):\n${detail}`);
      }
      this.scheduleSelfRestart(command.kind);
    } catch (error) {
      this.activeMaintenance = null;
      const detail =
        error instanceof Error ? error.message : String(error);
      await this.maintenanceStateStore.setLastTask({
        kind: command.kind,
        status: "failed",
        requestedBy: msg.senderId,
        requestedAt,
        finishedAt: Date.now(),
        forced: command.force,
        detail,
      });
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ \`/${command.kind}\` 失败：\n${detail}`,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
    }
  }

  /**
   * `/topic …` 普通命令：整条消息直接丢弃，不调 SessionManager、不连 ACP、不建 session。
   * 飞书富文本常把 `/topic` 包在 **、`` ` `` 里，行首不是 `/`，需额外判断。
   */
  private shouldIgnoreTopicMessage(msg: FeishuMessage): boolean {
    const raw = msg.content.replace(/\r\n/g, "\n").trim();
    const mentions = msg.mentions;
    for (const lineRaw of raw.split("\n")) {
      const line = this.feishuBot
        .stripBotMentionKeepLines(lineRaw.trim(), mentions)
        .trim();
      if (!line) continue;

      let head = line
        .replace(/^[\uFEFF\u200b-\u200d\u3000\s]+/, "")
        .replace(/^／/, "/")
        .trimStart();
      for (let i = 0; i < 24; i++) {
        const n = head.replace(/^(\*{1,2}|`{1,3}|_{1,2}|~{1,2}|>+|\s)+/, "");
        if (n === head) break;
        head = n.trimStart();
      }
      head = head.replace(/^／/, "/").trimStart();
      if (/^\/topic\b/i.test(head)) {
        console.log("[bridge] /topic ignored — no session, no ACP prompt");
        return true;
      }

      const m = line.match(/\/topic\b/i);
      if (m && m.index !== undefined) {
        const before = line.slice(0, m.index);
        if (
          !/[\u4e00-\u9fff]/.test(before) &&
          /^[\s`*_~>"'（）【】\[\]\\\-+/=|.,:;!?]*$/.test(before)
        ) {
          console.log(
            "[bridge] /topic ignored (wrapped in markdown, no text before /topic) — no session, no ACP prompt",
          );
          return true;
        }
      }
    }
    // 极短消息：飞书可能把整段包成一句说明 + `` `/topic` ``，上面规则仍够不着
    if (raw.length <= 120 && /\/topic\b/i.test(raw)) {
      console.log(
        "[bridge] /topic ignored (short message, contains /topic) — no session, no ACP prompt",
      );
      return true;
    }
    return false;
  }

  private async handleFeishuMessage(msg: FeishuMessage): Promise<void> {
    const hasIncomingResource = msg.incomingResource != null;
    const hasPostEmbeddedImages = (msg.postEmbeddedImageKeys?.length ?? 0) > 0;
    if (
      msg.contentType !== "text" &&
      msg.contentType !== "post" &&
      !hasIncomingResource
    ) {
      return;
    }

    // 在任何 await、群成员校验、SessionManager、ACP 之前丢弃（整条消息当没看见）
    if (this.shouldIgnoreTopicMessage(msg)) {
      return;
    }

    let content = msg.content.trim();
    /** 去掉 @ 后**保留换行**，用于 `/help`、`/stop` 等与 post「标题+换行+命令」一致的判定；`content` 仍为压成单行后的文本（解析斜杠命令、发往 Agent）。 */
    let contentMultiline = content;

    if (msg.chatType === "group") {
      const mentioned = this.feishuBot.isBotMentioned(msg);
      const pairUserBot =
        !mentioned && (await this.feishuBot.isPairUserBotGroup(msg.chatId));
      if (!mentioned && !pairUserBot) {
        if (this.config.bridgeDebug) {
          console.log(
            "[bridge:debug] 群消息已收到但未判定为 @ 机器人，已忽略",
            this.feishuBot.getGroupMentionIgnoredDebug(msg),
          );
        }
        return;
      }
      if (this.config.bridgeDebug && pairUserBot) {
        console.log(
          "[bridge:debug] 群为 1 用户 + 1 机器人，免 @ 处理",
          msg.messageId,
        );
      }
      contentMultiline = this.feishuBot
        .stripBotMentionKeepLines(content, msg.mentions)
        .trim();
      content = this.feishuBot.stripBotMention(content, msg.mentions).trim();
    }

    if (!content) return;
    await this.ensureMaintenanceStateLoaded();

    if (matchesBridgeStartCommand(contentMultiline)) {
      await this.sendWelcomeCard(msg);
      return;
    }

    const filebackParsed = parseFilebackUserMessage(content);
    if (filebackParsed.kind === "usage") {
      await this.feishuBot.sendText(
        msg.chatId,
        FILEBACK_USAGE_TEXT,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    if (filebackParsed.kind === "prompt") {
      content = wrapFilebackPromptForAgent(filebackParsed.inner);
      contentMultiline = content;
    }

    const newConv = parseNewConversationCommand(content);
    const bridgeManagedCommand = newConv;
    if (bridgeManagedCommand) {
      try {
        if (
          bridgeManagedCommand.kind === "restart" ||
          bridgeManagedCommand.kind === "update" ||
          bridgeManagedCommand.kind === "upgrade"
        ) {
          if (bridgeManagedCommand.kind === "upgrade") {
            await this.handleUpgradeCommand(msg, bridgeManagedCommand);
          } else {
            await this.handleMaintenanceCommand(msg, bridgeManagedCommand);
          }
          return;
        }

        // ----------------------------------------------------------------
        // /sessions — list all slots
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "sessions") {
          await this.handleSessionsList(msg);
          return;
        }

        // ----------------------------------------------------------------
        // /whoami — show current sender ID for BRIDGE_ADMIN_USER_IDS
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "whoami") {
          await this.feishuBot.sendText(
            msg.chatId,
            formatWhoAmIMessage(msg.senderId),
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /resume — ACP session/load
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "resume") {
          const session = await this.sessionManager.getActiveSession(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            this.threadScope(msg),
          );
          if (!session) {
            await this.feishuBot.sendText(
              msg.chatId,
              `❌ ${NO_SESSION_HINT}`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          const runtime = this.runtimeForSession(session);
          await this.flushPendingSessionNotices(msg);
          if (!runtime.supportsLoadSession) {
            await this.feishuBot.sendText(
              msg.chatId,
              "❌ 当前 Agent 未宣告 `loadSession`，无法执行 `/resume`。",
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          try {
            const replayMd = await captureAcpReplayDuring(
              runtime.bridgeClient,
              session.sessionId,
              () => runtime.loadSession(session.sessionId, session.workspaceRoot),
              {
                showAvailableCommands:
                  this.config.bridge.showAcpAvailableCommands,
              },
            );

            const header =
              `✅ 已对当前 session 执行 ACP \`session/load\`。\n` +
              `• sessionId：\`${session.sessionId}\`\n` +
              `• 工作区：\`${session.workspaceRoot}\`\n\n` +
              `---\n\n` +
              `**会话历史回放（适配器推送）**\n\n`;

            const emptyHint =
              "_（未收到可展示的文本回放：可能历史为空、或仅有非 text 内容块；可设 `ACP_RELOAD_TRACE_LOG=true` 查看入站 `session/update`）_";

            let body = replayMd.trim() ? replayMd.trim() : emptyHint;

            const MAX_TOTAL = 28_000;
            if (header.length + body.length > MAX_TOTAL) {
              body =
                body.slice(0, Math.max(0, MAX_TOTAL - header.length - 120)) +
                "\n\n_（回放过长，已截断）_";
            }

            await this.feishuBot.sendText(
              msg.chatId,
              header + body,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
          } catch (err) {
            await this.feishuBot.sendText(
              msg.chatId,
              `❌ /resume 失败:\n${formatJsonRpcLikeError(err)}`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
          }
          return;
        }

        // ----------------------------------------------------------------
        // /mode [modeId]
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "mode") {
          const session = await this.sessionManager.getActiveSession(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            this.threadScope(msg),
          );
          const runtime = session ? this.runtimeForSession(session) : undefined;
          if (!bridgeManagedCommand.modeId) {
            await this.feishuBot.sendText(
              msg.chatId,
              formatModeUsage(
                session
                  ? runtime?.getSessionModeState(session.sessionId)
                  : undefined,
              ),
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          let sessionId: string | undefined;
          let activeSession: Awaited<ReturnType<SessionManager["getActiveSession"]>> | undefined;
          try {
            if (!session) {
              await this.feishuBot.sendText(
                msg.chatId,
                `❌ ${NO_SESSION_HINT}`,
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            }
            activeSession = session;
            sessionId = session.sessionId;
            const modeRuntime = this.runtimeForSession(session);
            await this.flushPendingSessionNotices(msg);
            const modeState = modeRuntime.getSessionModeState(session.sessionId);
            const resolved = resolveSessionModeInput(
              bridgeManagedCommand.modeId,
              modeState,
            );
            await modeRuntime.setSessionMode(session.sessionId, resolved.modeId);
            await this.feishuBot.sendText(
              msg.chatId,
              `✅ 已切换模式为 \`${resolved.modeId}\`（后续对话将按该模式处理）。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
          } catch (err) {
            await this.feishuBot.sendText(
              msg.chatId,
              formatModeSwitchFailure(
                err,
                sessionId && activeSession
                  ? this.runtimeForSession(activeSession).getSessionModeState(sessionId)
                  : undefined,
              ),
              msg.messageId,
              this.threadReplyOpts(msg),
            );
          }
          return;
        }

        // ----------------------------------------------------------------
        // /switch [target]
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "switch") {
          if (bridgeManagedCommand.target === null) {
            const slot = await this.sessionManager.switchToPreviousSlot(
              msg.chatId,
              msg.senderId,
              msg.chatType,
              this.threadScope(msg),
            );
            await this.flushPendingSessionNotices(msg);
            const label = slot.name ? ` (${slot.name})` : "";
            await this.feishuBot.sendText(
              msg.chatId,
              `✅ 已切换到上一个 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            const lastTurnCard = this.buildSlotLastTurnCardContent(slot);
            if (lastTurnCard) {
              await this.feishuBot.sendCard(
                msg.chatId,
                lastTurnCard,
                msg.messageId,
                this.threadReplyOpts(msg),
              );
            }
            return;
          }
          const slot = await this.sessionManager.switchSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            bridgeManagedCommand.target,
            this.threadScope(msg),
          );
          await this.flushPendingSessionNotices(msg);
          const label = slot.name ? ` (${slot.name})` : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已切换到 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          const lastTurnCard = this.buildSlotLastTurnCardContent(slot);
          if (lastTurnCard) {
            await this.feishuBot.sendCard(
              msg.chatId,
              lastTurnCard,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
          }
          return;
        }

        // ----------------------------------------------------------------
        // /reply [target]
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "reply") {
          const slot = await this.sessionManager.getSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            bridgeManagedCommand.target,
            this.threadScope(msg),
          );
          await this.flushPendingSessionNotices(msg);
          const lastTurnCard = this.buildSlotLastTurnCardContent(slot);
          if (!lastTurnCard) {
            const label = slot.name ? ` (${slot.name})` : "";
            await this.feishuBot.sendText(
              msg.chatId,
              `ℹ️ session #${slot.slotIndex}${label} 暂无缓存的上一轮对话。\n\n只有在当前桥接进程里成功完成过一次回复后，才能通过 \`/reply\` 重新发送。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          await this.feishuBot.sendCard(
            msg.chatId,
            lastTurnCard,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /rename <name>
        // /rename <target> <name>
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "rename") {
          if (
            (typeof bridgeManagedCommand.target === "number" &&
              isNaN(bridgeManagedCommand.target as number)) ||
            !bridgeManagedCommand.name.trim()
          ) {
            await this.feishuBot.sendText(
              msg.chatId,
              "用法：`/rename <新名字>` 或 `/rename <编号或名称> <新名字>`\n\n示例：`/rename backend`、`/rename 2 backend`",
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          const renamed = await this.sessionManager.renameSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            bridgeManagedCommand.target,
            bridgeManagedCommand.name,
            this.threadScope(msg),
          );
          await this.flushPendingSessionNotices(msg);
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已将 session #${renamed.slotIndex} 重命名为 \`${renamed.name}\``,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /close <target>
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "close") {
          if (
            typeof bridgeManagedCommand.target === "number" &&
            isNaN(bridgeManagedCommand.target as number)
          ) {
            await this.feishuBot.sendText(
              msg.chatId,
              "用法：`/close <编号或名称>` 或 `/close all`\n\n发送 `/sessions` 查看当前所有 session。",
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (bridgeManagedCommand.target === "all") {
            const { closed } = await this.sessionManager.closeAllSlots(
              msg.chatId,
              msg.senderId,
              msg.chatType,
              this.threadScope(msg),
            );
            await this.flushPendingSessionNotices(msg);
            const summary = closed
              .map((s) => {
                const lab = s.name ? ` (${s.name})` : "";
                return `#${s.slotIndex}${lab}`;
              })
              .join("、");
            await this.feishuBot.sendText(
              msg.chatId,
              `✅ 已关闭本组全部 ${closed.length} 个 session：${summary}\n\n已释放全局配额。请使用 \`/new list\` 与 \`/new <序号或路径>\` 重新创建 session。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          const { closed, removedEntireGroup } = await this.sessionManager.closeSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            bridgeManagedCommand.target,
            this.threadScope(msg),
          );
          await this.flushPendingSessionNotices(msg);
          const label = closed.name ? ` (${closed.name})` : "";
          const tail = removedEntireGroup
            ? "\n\n该聊天/话题下已无 session，已释放全局配额。请使用 `/new list` 与 `/new <序号或路径>` 重新创建。"
            : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已关闭 session #${closed.slotIndex}${label}${tail}`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }

        // ----------------------------------------------------------------
        // /new — workspace presets list management (no session creation)
        // ----------------------------------------------------------------
        if (bridgeManagedCommand.kind === "new") {
          if (bridgeManagedCommand.variant === "list") {
            const presets = this.presetsStore.getPresets();

            // 使用交互式卡片替代纯文本列表
            const interactiveCard = buildWorkspaceWithBackendSelectCardMarkdown({
              presets,
              showBackendSelector: this.config.acp.enabledBackends.length > 1,
              enabledBackends: this.config.acp.enabledBackends,
              defaultBackend: this.config.acp.backend,
            });

            await this.feishuBot.sendCard(
              msg.chatId,
              interactiveCard,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (bridgeManagedCommand.variant === "remove-list") {
            if (bridgeManagedCommand.index < 1) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new remove-list <序号>`（序号见 `/new list`）",
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            }
            const removed = await this.presetsStore.removePresetAt(
              bridgeManagedCommand.index,
            );
            const list = this.presetsStore.getPresets();
            const lines = list.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
            await this.feishuBot.sendText(
              msg.chatId,
              removed
                ? `✅ 已删除序号 ${bridgeManagedCommand.index}。\n\n${list.length ? lines : "（列表已空）"}`
                : `❌ 无序号 ${bridgeManagedCommand.index}。请先 \`/new list\` 查看当前列表。`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }
          if (bridgeManagedCommand.variant === "add-list") {
            if (!bridgeManagedCommand.path.trim()) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new add-list <目录路径>`",
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            }
            const abs = await resolveAllowedWorkspaceDir(
              bridgeManagedCommand.path,
              this.config,
            );
            const added = await this.presetsStore.addPreset(abs);
            const list = this.presetsStore.getPresets();
            const lines = list.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
            await this.feishuBot.sendText(
              msg.chatId,
              added
                ? `✅ 已加入列表。\n\n${lines}`
                : `ℹ️ 该路径已在列表中，未重复添加。\n\n${lines}`,
              msg.messageId,
              this.threadReplyOpts(msg),
            );
            return;
          }

          // /new — default（仅 --name 无路径）/ workspace / preset：新建 slot 并切换
          let workspaceAbs: string;
          const slotName = bridgeManagedCommand.name;
          switch (bridgeManagedCommand.variant) {
            case "default":
              await this.feishuBot.sendText(
                msg.chatId,
                "❌ 创建 session 须指定工作区。请 `/new list` 查看列表后用 `/new <序号>`，或使用 `/new <目录绝对路径>`（可与 `--name` 组合，例如 `/new 1 --name backend`）。",
                msg.messageId,
                this.threadReplyOpts(msg),
              );
              return;
            case "workspace":
              workspaceAbs = await resolveAllowedWorkspaceDir(
                bridgeManagedCommand.path,
                this.config,
              );
              break;
            case "preset": {
              const idx = bridgeManagedCommand.index;
              if (idx < 1) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  "❌ 序号须为 ≥1 的整数。",
                  msg.messageId,
                  this.threadReplyOpts(msg),
                );
                return;
              }
              const p = this.presetsStore.getByIndex(idx);
              if (!p) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  `❌ 列表中无序号 ${idx}。请先发送 \`/new list\` 查看。`,
                  msg.messageId,
                  this.threadReplyOpts(msg),
                );
                return;
              }
              workspaceAbs = await resolveAllowedWorkspaceDir(p, this.config);
              break;
            }
            default:
              return;
          }

          const requestedBackend: AcpBackend =
            bridgeManagedCommand.backend ?? this.config.acp.backend;
          const result = await this.sessionManager.createNewSlot(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            workspaceAbs,
            requestedBackend,
            slotName,
            this.threadScope(msg),
          );
          await this.flushPendingSessionNotices(msg);
          const nameLabel = result.name ? ` (${result.name})` : "";
          await this.feishuBot.sendText(
            msg.chatId,
            `✅ 已新建并切换到 session #${result.slotIndex}${nameLabel}\nBackend：\`${result.backend}\`\n工作区：\`${result.workspaceRoot}\`\n\n发送 \`/sessions\` 查看所有 session。`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
        }
      } catch (e) {
        await this.feishuBot.sendText(
          msg.chatId,
          `❌ ${e instanceof Error ? e.message : String(e)}`,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      }
      return;
    }

    if (matchesBridgeHelpCommand(contentMultiline)) {
      await this.feishuBot.sendText(
        msg.chatId,
        formatBridgeCommandsHelp(this.activeSnapshot(msg)?.activeSlot.session.backend ?? this.config.acp.backend),
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    const statusTrim = content.trim();
    const statusLower = statusTrim.toLowerCase();
    if (statusTrim === "/状态" || statusLower === "/status") {
      const snap = await this.sessionManager.getSessionSnapshotLoaded(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        this.threadScope(msg),
      );
      const stats = this.sessionManager.getStats();
      const activeSession = snap?.activeSlot.session;
      const runtime = activeSession ? this.runtimeForSession(activeSession) : undefined;
      const recovery = activeSession?.recovery;
      const currentModeId =
        activeSession
          ? runtime?.getSessionModeState(activeSession.sessionId)?.currentModeId
          : undefined;
      const currentModelLabel =
        activeSession
          ? formatSessionModel(runtime?.getSessionModelState(activeSession.sessionId))
          : undefined;
      const usageState =
        activeSession
          ? runtime?.getSessionUsageState(activeSession.sessionId)
          : undefined;
      const usageLabel = formatSessionUsage(usageState);
      const maintenanceEnabled =
        this.config.bridge.adminUserIds.length > 0 && (await this.isManagedByService());
      const lastMaintenanceTask = this.maintenanceStateStore.getLastTask();
      const lastUpgradeAttempt = this.upgradeResultStore.getAttempt();
      let body = `📊 活跃/内存 slot: ${stats.active}/${stats.total}`;
      body += `
• 默认 backend：${this.config.acp.backend}`;
      body += `
• 已启用 backend：${this.config.acp.enabledBackends.join(", ")}`;
      body += `
• 当前 session backend：${activeSession?.backend ?? "（尚无）"}`;
      body += `
• 维护命令：${
        this.config.bridge.adminUserIds.length === 0
          ? "未启用（未配置 BRIDGE_ADMIN_USER_IDS）"
          : maintenanceEnabled
            ? "已启用（仅管理员私聊）"
            : "受限（当前进程未检测到服务托管）"
      }`;
      if (currentModeId) {
        body += `
• 当前模式：\`${currentModeId}\``;
      }
      if (currentModelLabel) {
        body += `
• 当前模型：${currentModelLabel}`;
      }
      if (usageLabel) {
        body += `
• Context 用量：${usageLabel}`;
      }
      if (recovery?.kind === "cursor-cli") {
        body += `\n• CLI resume ID：\`${recovery.cursorCliChatId}\``;
      } else if (recovery?.kind === "claude-session") {
        body += `\n• Claude 恢复会话：\`${recovery.resumeSessionId}\``;
      } else if (activeSession?.backend === "claude" && activeSession.sessionId) {
        body += `\n• Claude 恢复会话：\`${activeSession.sessionId}\``;
      } else if (activeSession?.backend === "cursor-official" && activeSession.sessionId) {
        body += `\n• Official ACP sessionId：\`${activeSession.sessionId}\``;
      } else if (activeSession?.backend === "codex" && activeSession.sessionId) {
        body += `\n• Codex sessionId：\`${activeSession.sessionId}\``;
      } else {
        body += "\n• 恢复绑定：暂无（尚无活跃会话或后端未返回恢复元信息）";
      }
      if (this.activeMaintenance) {
        body += `\n• 维护任务：进行中（\`/${this.activeMaintenance.kind}\`，开始于 ${this.formatIsoTimestamp(this.activeMaintenance.requestedAt)}）`;
      } else if (lastMaintenanceTask) {
        body += `\n• 上次维护：${this.formatMaintenanceTaskSummary(lastMaintenanceTask)}`;
      }
      if (lastUpgradeAttempt) {
        body += `\n• 最近升级：${this.formatUpgradeAttemptSummary(lastUpgradeAttempt)}`;
      }
      if (this.config.bridgeDebug) {
        const idleLabel = snap
          ? snap.idleExpiresInMs === null
            ? "永不过期"
            : `${Math.round(snap.idleExpiresInMs / 60_000)} 分钟`
          : "—";
        const bridgeIdlePolicy = formatDurationMs(
          this.config.bridge.sessionIdleTimeoutMs,
        );
        const slot = snap?.activeSlot;
        const availableModeIds =
          slot
            ? (runtime?.getSessionModeState(slot.session.sessionId)?.availableModes ?? [])
                .map((mode) => mode.modeId)
                .join(", ")
            : "";
        const legacySessionFile =
          slot?.session.backend === "cursor-legacy" && slot.session.sessionId
            ? path.join(
                this.config.acp.adapterSessionDir,
                `${slot.session.sessionId}.json`,
              )
            : undefined;
        body += `

[调试 BRIDGE_DEBUG]
• 当前 session backend: ${activeSession?.backend ?? "—"}
• sessionKey: ${snap?.sessionKey ?? "(尚无)"}
• threadId: ${this.threadScope(msg) ?? "（主会话区）"}
• 活跃 slot: #${slot?.slotIndex ?? "—"}${slot?.name ? ` (${slot.name})` : ""}
• ACP sessionId: ${slot?.session.sessionId ?? "—"}
• 当前模式: ${currentModeId ?? "—"}
• 当前模型: ${currentModelLabel ?? "—"}
• Context 用量: ${usageLabel ?? "—"}
• 可用模式: ${availableModeIds || "—"}
• 会话 cwd: ${slot?.session.workspaceRoot ?? "—"}
• 空闲过期约: ${idleLabel}
• 会话策略: bridge=${bridgeIdlePolicy}
• ACP 子进程 cwd（allowlist 首项）: ${this.config.acp.workspaceRoot}
• 允许根 BRIDGE_WORK_ALLOWLIST: ${this.config.acp.allowedWorkspaceRoots.join(", ")}
• 映射文件: ${this.config.bridge.sessionStorePath}
• legacy 会话目录: ${this.config.acp.adapterSessionDir}
• legacy 会话文件: ${legacySessionFile ?? "—"}
• loadSession: ${runtime?.supportsLoadSession ?? false}
• LOG_LEVEL: ${this.config.logLevel}`;
      }
      await this.feishuBot.sendText(msg.chatId, body, msg.messageId, this.threadReplyOpts(msg));
      return;
    }

    // bridge 接管 /model 命令处理
    const modelMatch = content.trim().match(/^\/model(?:\s+(\S+))?$/i);
    const activeSessionForModel = await this.sessionManager.getActiveSession(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    if (modelMatch && activeSessionForModel) {
      const runtime = this.runtimeForSession(activeSessionForModel);
      const modelId = modelMatch[1]?.trim();
      if (!modelId) {
        await this.feishuBot.sendText(
          msg.chatId,
          formatModelUsage(
            runtime.getSessionModelState(activeSessionForModel.sessionId),
            { numbered: true },
          ),
          msg.messageId,
          this.threadReplyOpts(msg),
        );
        return;
      }
      let sessionId: string | undefined;
      try {
        sessionId = activeSessionForModel.sessionId;
        await this.flushPendingSessionNotices(msg);
        const modelState = runtime.getSessionModelState(activeSessionForModel.sessionId);
        const resolved = resolveModelSelectorInput(modelId, modelState);
        await runtime.setSessionModel(activeSessionForModel.sessionId, resolved.modelId);
        const confirmedModelId =
          runtime.getSessionModelState(activeSessionForModel.sessionId)?.currentModelId ??
          resolved.modelId;
        if (activeSessionForModel.backend === "codex") {
          this.sessionManager.setActiveSessionPreferredModel(
            msg.chatId,
            msg.senderId,
            msg.chatType,
            resolved.modelId,
            this.threadScope(msg),
          );
        }
        const okText =
          resolved.pickedByIndex != null
            ? `✅ 已按序号 ${resolved.pickedByIndex} 切换为 \`${confirmedModelId}\`（后续对话将使用该模型）。`
            : `✅ 已切换模型为 \`${confirmedModelId}\`（后续对话将使用该模型）。`;
        await this.feishuBot.sendText(
          msg.chatId,
          okText,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      } catch (err) {
        await this.feishuBot.sendText(
          msg.chatId,
          formatModelSwitchFailure(
            err,
            sessionId ? runtime.getSessionModelState(sessionId) : undefined,
            { numbered: true },
          ),
          msg.messageId,
          this.threadReplyOpts(msg),
        );
      }
      return;
    }

    if (matchesInterruptUserCommand(contentMultiline)) {
      const snap = this.sessionManager.getSessionSnapshot(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        this.threadScope(msg),
      );
      if (!snap) {
        await this.feishuBot.sendText(
          msg.chatId,
          NO_SESSION_HINT,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
        return;
      }
      const sessionKey = snap.sessionKey;
      const activeSlot = snap.activeSlot;
      const active = snap.activeSlot;
      const promptKey = `${sessionKey}:${active.slotIndex}`;
      if (!this.activePrompts.has(promptKey)) {
        await this.feishuBot.sendText(
          msg.chatId,
          "ℹ️ 当前活跃 session 没有正在生成的回复。其它槽位若在生成，请先 `/switch` 到该槽位再发 `/stop`。",
          msg.messageId,
          this.threadReplyOpts(msg),
        );
        return;
      }
      await this.flushPendingSessionNotices(msg);
      const errors: string[] = [];
      try {
        await this.runtimeForSession(active.session).cancelSession(active.session.sessionId);
      } catch (e) {
        errors.push(
          `#${active.slotIndex}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const label = `#${active.slotIndex}${active.name ? ` (${active.name})` : ""}`;
      let body = `✅ 已向进行中的任务发送中断请求（${label}），效果与在 Cursor / Cursor Agent 侧中断本轮生成类似；session 仍保留，可继续对话。`;
      if (errors.length > 0) {
        body += `\n\n⚠️ 中断失败：\n${errors.join("\n")}`;
      }
      await this.feishuBot.sendText(
        msg.chatId,
        body,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    // Prompt key is scoped to the active slot so different slots can run in parallel,
    // but the same slot is still serialized.
    const sessionKey = this.feishuSessionKey(msg);

    // Peek at current active slot index for the prompt key
    const snap = this.sessionManager.getSessionSnapshot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    const promptKey = snap
      ? `${sessionKey}:${snap.activeSlot.slotIndex}`
      : sessionKey;

    if (this.activePrompts.has(promptKey)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "⏳ 上一个请求还在处理中，请稍候...",
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }

    try {
      this.activePrompts.add(promptKey);
      let activeSlot: SessionSlot | undefined;

      const session = await this.sessionManager.getActiveSession(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        this.threadScope(msg),
      );
      if (!session) {
        await this.feishuBot.sendText(
          msg.chatId,
          NO_SESSION_HINT,
          msg.messageId,
          this.threadReplyOpts(msg),
        );
        return;
      }
      await this.flushPendingSessionNotices(msg);

      let promptContent = content;
      if (msg.incomingResource) {
        try {
          const { relativePath } = await this.feishuBot.downloadIncomingResourceToWorkspace(
            msg.messageId,
            msg.incomingResource,
            session.workspaceRoot,
          );
          promptContent = formatIncomingAttachmentPrompt(
            relativePath,
            msg.incomingResource,
          );
        } catch (err) {
          await this.feishuBot.sendText(
            msg.chatId,
            `❌ 无法下载飞书附件：${err instanceof Error ? err.message : String(err)}`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }
      } else if (hasPostEmbeddedImages && msg.postEmbeddedImageKeys) {
        try {
          const relativePaths: string[] = [];
          for (const imageKey of msg.postEmbeddedImageKeys) {
            const { relativePath } = await this.feishuBot.downloadIncomingResourceToWorkspace(
              msg.messageId,
              { apiType: "image", fileKey: imageKey, messageKind: "image" },
              session.workspaceRoot,
            );
            relativePaths.push(relativePath);
          }
          promptContent = formatPostEmbeddedImagesPrompt(content, relativePaths);
        } catch (err) {
          await this.feishuBot.sendText(
            msg.chatId,
            `❌ 无法下载飞书富文本内嵌图片：${err instanceof Error ? err.message : String(err)}`,
            msg.messageId,
            this.threadReplyOpts(msg),
          );
          return;
        }
      }

      const msgForPrompt: FeishuMessage = {
        ...msg,
        content: promptContent,
      };
      activeSlot = await this.sessionManager.getSlot(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        null,
        this.threadScope(msg),
      );
      await this.appendSlotPromptLog(
        sessionKey,
        activeSlot,
        session,
        msgForPrompt,
        content,
        promptContent,
      );

      const lastReply = await this.conversationForBackend(session.backend).handleUserPrompt(
        msgForPrompt,
        session,
        {
          onAcpEvent: async (ev) => {
            if (ev.type !== "agent_message_chunk") return;
            await this.appendSlotAcpChunkLog(
              sessionKey,
              activeSlot,
              session,
              msgForPrompt,
              ev.text,
            );
          },
        },
      );
      await this.appendSlotReplyLog(
        sessionKey,
        activeSlot,
        session,
        msgForPrompt,
        lastReply ?? "（无响应内容）",
      );
      if (lastReply) {
        this.sessionManager.setSlotLastTurn(
          msg.chatId,
          msg.senderId,
          msg.chatType,
          snap?.activeSlot.slotIndex ?? 1,
          promptContent,
          lastReply,
          this.threadScope(msg),
        );
      }
    } catch (err) {
      console.error(
        `[bridge] Error processing message from ${msg.senderId}:`,
        err,
      );
      try {
        const slot = await this.sessionManager.getSlot(
          msg.chatId,
          msg.senderId,
          msg.chatType,
          null,
          this.threadScope(msg),
        );
        const session = slot.session;
        await this.appendSlotErrorLog(
          sessionKey,
          slot,
          session,
          msg,
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // ignore logging failures while already handling an error
      }
      await this.feishuBot
        .sendText(
          msg.chatId,
          `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
          msg.messageId,
          this.threadReplyOpts(msg),
        )
        .catch(() => {});
    } finally {
      this.activePrompts.delete(promptKey);
    }
  }

  /**
   * 仅在用户显式发送 /start 时发送欢迎卡片。
   */
  private async sendWelcomeCard(msg: FeishuMessage): Promise<void> {
    try {
      await this.feishuBot.sendCard(
        msg.chatId,
        buildWelcomeCardMarkdown(),
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      this.welcomedUsers.add(msg.senderId);
    } catch (err) {
      console.warn(
        `[bridge] Failed to send welcome card to user ${msg.senderId} in chat ${msg.chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleSessionsList(msg: FeishuMessage): Promise<void> {
    const slots = await this.sessionManager.listSlots(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      this.threadScope(msg),
    );
    await this.flushPendingSessionNotices(msg);
    if (slots.length === 0) {
      await this.feishuBot.sendText(
        msg.chatId,
        NO_SESSION_HINT,
        msg.messageId,
        this.threadReplyOpts(msg),
      );
      return;
    }
    const lines = slots.map((s) => {
      const active = s.isActive ? " ◀ 当前" : "";
      const name = s.name ? ` (${s.name})` : "";
      const runtime = this.runtimeForBackend(s.backend);
      const modeId =
        runtime.getSessionModeState(s.sessionId)?.currentModeId ?? "";
      const modeLine = modeId ? `
  模式：\`${modeId}\`` : "";
      return `#${s.slotIndex}${name}${active}
  Backend：\`${s.backend}\`
  工作区：\`${s.workspaceRoot}\`${modeLine}`;
    });
    await this.feishuBot.sendText(
      msg.chatId,
      `📋 当前所有 session（共 ${slots.length} 个；# 为槽位编号，关闭后不会复用，故可能与数量连续不一致）：

${lines.join("\n\n")}

• \`/new list\` / \`/new <序号>\` / \`/new <路径>\` — 新建 session
• \`/switch <编号或名称>\` — 切换
• \`/reply [编号或名称]\` — 重发上一轮缓存回复
• \`/fileback <说明>\` — 向 Agent 附带「用 FEISHU_SEND_FILE 发文件」说明后再发你的任务
• \`/stop\` / \`/cancel\` — 中断**当前活跃**槽位正在生成的回复（不关 session）
• \`/resume\` — 对当前 session 执行 ACP \`session/load\`（测试/恢复）
• \`/mode <模式ID>\` — 切换当前 session 模式
• \`/rename <新名字>\` — 重命名当前 session
• \`/rename <编号或名称> <新名字>\` — 重命名指定 session
• \`/close <编号或名称>\` — 关闭
• \`/close all\` — 关闭本组全部
• \`/topic …\` — 仅发飞书、不发给 Agent（便于话题内写标题）`,
      msg.messageId,
      this.threadReplyOpts(msg),
    );
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.feishuBot.stop();
    await this.runtimeRegistry.stopAll();
    console.log("[bridge] Service stopped");
  }
}
