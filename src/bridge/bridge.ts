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
import {
  formatSessionModelLabel,
  formatSessionUsage as formatDisplaySessionUsage,
} from "../acp/session-display-format.js";
import { FeishuBot, type FeishuMessage } from "../feishu/bot.js";
import { SessionManager } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
import { ConversationService } from "./conversation-service.js";
import { WorkspacePresetsStore } from "../session/workspace-presets-store.js";
import {
  BridgeMaintenanceStateStore,
  type BridgeMaintenanceCommandKind,
  type CompletedBridgeMaintenanceTask,
} from "./maintenance-state.js";
import { UpgradeResultStore, type UpgradeAttemptRecord } from "./upgrade-result-store.js";
import { SlotMessageLogStore } from "./slot-message-log.js";
import { PromptCoordinator } from "./prompt-coordinator.js";
import {
  handleBridgeMessage,
  type BridgeMessageHandlerDeps,
} from "./bridge-message-handler.js";
import { preprocessBridgeMessage } from "./bridge-message-preprocess.js";

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

function formatSessionUsage(
  usage: AcpSessionUsageState | undefined,
): string | undefined {
  return formatDisplaySessionUsage(usage);
}

function formatSessionModel(
  modelState: AcpSessionModelState | undefined,
): string | undefined {
  return formatSessionModelLabel(modelState);
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
  private slotMessageLog: SlotMessageLogStore | null;
  private upgradeResultStore: UpgradeResultStore;
  private promptCoordinator: PromptCoordinator;
  private maintenanceStateStore: BridgeMaintenanceStateStore;
  private maintenanceStateReady: Promise<void> | null = null;
  private activeMaintenance: RunningMaintenanceTask | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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
    this.slotMessageLog = config.bridge.slotMessageLogEnabled
      ? new SlotMessageLogStore(
          path.join(path.dirname(config.bridge.sessionStorePath), "slot-logs"),
        )
      : null;
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
    this.promptCoordinator = new PromptCoordinator({
      getFeishuBot: () => this.feishuBot,
      getSessionManager: () => this.sessionManager,
      getSlotMessageLog: () => this.slotMessageLog,
      flushPendingSessionNotices: (msg) => this.flushPendingSessionNotices(msg),
      threadReplyOpts: (msg) => this.threadReplyOpts(msg),
      threadScope: (msg) => this.threadScope(msg),
      conversationForBackend: (backend) => this.conversationForBackend(backend),
      feishuSessionKey: (msg) => this.feishuSessionKey(msg),
    });
  }

  async start(): Promise<void> {
    if (this.config.bridgeDebug) {
      console.log(
        "[bridge] BRIDGE_DEBUG=true — 控制台输出 ACP/会话信息；/status 含 session 与路径",
      );
    }
    if (this.config.bridge.slotMessageLogEnabled) {
      console.log(
        `[bridge] BRIDGE_SLOT_LOG_ENABLED=true — slot 调试日志将写入 ${path.join(path.dirname(this.config.bridge.sessionStorePath), "slot-logs")}`,
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

  private hasExplicitUpgradeAdmins(): boolean {
    const admins = this.config.bridge.upgradeAdmins;
    return (
      admins.openIds.size > 0 ||
      admins.userIds.size > 0 ||
      admins.unionIds.size > 0
    );
  }

  private isUpgradeAdmin(msg: FeishuMessage): boolean {
    if (!this.hasExplicitUpgradeAdmins()) {
      return this.isBridgeAdmin(msg.senderId);
    }
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
    const activePromptCount = this.promptCoordinator.getActivePromptCount();
    if (activePromptCount > 0 && !command.force) {
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ 当前仍有 ${activePromptCount} 个请求在处理中。请等待完成或先中断，再执行 \`/upgrade\`；若确认要直接升级，可改用 \`/upgrade --force\`。`,
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
    if (
      !this.hasExplicitUpgradeAdmins() &&
      this.config.bridge.adminUserIds.length === 0
    ) {
      await this.feishuBot.sendText(
        msg.chatId,
        "❌ 当前未配置升级管理员：请设置 `BRIDGE_ADMIN_USER_IDS`，或显式配置 `BRIDGE_UPGRADE_ADMIN_OPEN_IDS` / `BRIDGE_UPGRADE_ADMIN_USER_IDS` / `BRIDGE_UPGRADE_ADMIN_UNION_IDS`。",
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

  private feishuSessionKey(msg: FeishuMessage): string {
    if (msg.chatType === "p2p") return `dm:${msg.senderId}`;
    const t = this.threadScope(msg);
    if (t) return `${msg.chatId}:t:${t}:${msg.senderId}`;
    return `${msg.chatId}:${msg.senderId}`;
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
    const activePromptCount = this.promptCoordinator.getActivePromptCount();
    if (activePromptCount > 0 && !command.force) {
      await this.feishuBot.sendText(
        msg.chatId,
        `❌ 当前仍有 ${activePromptCount} 个请求在处理中。请等待完成或先中断，再执行 \`/${command.kind}\`；若确认要直接维护，可改用 \`/${command.kind} --force\`。`,
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

  private messageHandlerDeps(): BridgeMessageHandlerDeps {
    return {
      config: this.config,
      feishuBot: this.feishuBot,
      sessionManager: this.sessionManager,
      presetsStore: this.presetsStore,
      slotMessageLog: this.slotMessageLog,
      maintenanceStateStore: this.maintenanceStateStore,
      upgradeResultStore: this.upgradeResultStore,
      promptCoordinator: this.promptCoordinator,
      ensureMaintenanceStateLoaded: () => this.ensureMaintenanceStateLoaded(),
      handleUpgradeCommand: (msg, command) =>
        this.handleUpgradeCommand(msg, command),
      handleMaintenanceCommand: (msg, command) =>
        this.handleMaintenanceCommand(msg, command),
      flushPendingSessionNotices: (msg) =>
        this.flushPendingSessionNotices(msg),
      threadReplyOpts: (msg) => this.threadReplyOpts(msg),
      threadScope: (msg) => this.threadScope(msg),
      runtimeForBackend: (backend) => this.runtimeForBackend(backend),
      runtimeForSession: (session) => this.runtimeForSession(session),
      conversationForBackend: (backend) =>
        this.conversationForBackend(backend),
      feishuSessionKey: (msg) => this.feishuSessionKey(msg),
      isManagedByService: () => this.isManagedByService(),
      getActiveMaintenance: () =>
        this.activeMaintenance
          ? {
              kind: this.activeMaintenance.kind,
              requestedAt: this.activeMaintenance.requestedAt,
            }
          : null,
      formatWhoAmIMessage: (senderId) => formatWhoAmIMessage(senderId),
      formatDurationMs: (ms) => formatDurationMs(ms),
      formatSessionUsage: (usage) => formatSessionUsage(usage),
      formatSessionModel: (modelState) => formatSessionModel(modelState),
      formatIsoTimestamp: (ms) => this.formatIsoTimestamp(ms),
      formatMaintenanceTaskSummary: (task) =>
        this.formatMaintenanceTaskSummary(task),
      formatUpgradeAttemptSummary: (attempt) =>
        this.formatUpgradeAttemptSummary(attempt),
    };
  }

  private async handleFeishuMessage(msg: FeishuMessage): Promise<void> {
    const preprocessed = await preprocessBridgeMessage(
      {
        config: this.config,
        feishuBot: this.feishuBot,
      },
      msg,
    );
    if (!preprocessed) return;
    await handleBridgeMessage(this.messageHandlerDeps(), msg, preprocessed);
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
