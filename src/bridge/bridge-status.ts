import * as path from "node:path";
import type { FeishuMessage } from "../feishu/bot.js";
import type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";
import type { AcpRuntimeStatus } from "../acp/runtime.js";

function formatBackendRuntimeStatus(
  status: AcpRuntimeStatus,
  formatIsoTimestamp: (ms: number) => string,
): string {
  if (status.state === "ready") {
    const readyAt = status.readyAt ? `，就绪于 ${formatIsoTimestamp(status.readyAt)}` : "";
    return `${status.backend}: 已连接${readyAt}`;
  }
  if (status.state === "starting") {
    const startedAt = status.startedAt
      ? `（开始于 ${formatIsoTimestamp(status.startedAt)}）`
      : "";
    return `${status.backend}: 启动中${startedAt}`;
  }
  if (status.state === "error") {
    const failedAt = status.errorAt ? `（失败于 ${formatIsoTimestamp(status.errorAt)}）` : "";
    const reason = status.errorMessage?.trim() ? `：${status.errorMessage.trim()}` : "";
    return `${status.backend}: 启动失败${failedAt}${reason}`;
  }
  return `${status.backend}: 未启动`;
}

export async function handleStatusCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
): Promise<boolean> {
  const statusTrim = content.trim();
  const statusLower = statusTrim.toLowerCase();
  if (statusTrim !== "/状态" && statusLower !== "/status") {
    return false;
  }

  const snap = await ctx.sessionManager.getSessionSnapshotLoaded(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  const stats = ctx.sessionManager.getStats();
  const activeSession = snap?.activeSlot.session;
  const runtime = activeSession
    ? ctx.runtimeForSession(activeSession)
    : undefined;
  const recovery = activeSession?.recovery;
  const currentModeId = activeSession
    ? runtime?.getSessionModeState(activeSession.sessionId)?.currentModeId
    : undefined;
  const currentModelLabel = activeSession
    ? ctx.formatSessionModel(
        runtime?.getSessionModelState(activeSession.sessionId),
      )
    : undefined;
  const usageState = activeSession
    ? runtime?.getSessionUsageState(activeSession.sessionId)
    : undefined;
  const usageLabel = ctx.formatSessionUsage(usageState);
  const maintenanceEnabled =
    ctx.config.bridge.adminUserIds.length > 0 &&
    (await ctx.isManagedByService());
  const backendStatuses = ctx.getBackendRuntimeStatuses?.() ?? [];
  const lastMaintenanceTask = ctx.maintenanceStateStore.getLastTask();
  const lastUpgradeAttempt = ctx.upgradeResultStore.getAttempt();
  let body = `📊 活跃/内存 slot: ${stats.active}/${stats.total}`;
  body += `
• 默认 backend：${ctx.config.acp.backend}`;
  body += `
• 已启用 backend：${ctx.config.acp.enabledBackends.join(", ")}`;
  body += `
• 当前 session backend：${activeSession?.backend ?? "（尚无）"}`;
  if (backendStatuses.length > 0) {
    body += `
• Backend 连接：${backendStatuses
      .map((status) => formatBackendRuntimeStatus(status, ctx.formatIsoTimestamp))
      .join("；")}`;
  }
  body += `
• 维护命令：${
    ctx.config.bridge.adminUserIds.length === 0
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
  } else if (
    activeSession?.backend === "claude" &&
    activeSession.sessionId
  ) {
    body += `\n• Claude 恢复会话：\`${activeSession.sessionId}\``;
  } else if (
    activeSession?.backend === "cursor-official" &&
    activeSession.sessionId
  ) {
    body += `\n• Official ACP sessionId：\`${activeSession.sessionId}\``;
  } else if (
    activeSession?.backend === "gemini" &&
    activeSession.sessionId
  ) {
    body += `\n• Gemini sessionId：\`${activeSession.sessionId}\``;
  } else if (
    activeSession?.backend === "codex" &&
    activeSession.sessionId
  ) {
    body += `\n• Codex sessionId：\`${activeSession.sessionId}\``;
  } else {
    body += "\n• 恢复绑定：暂无（尚无活跃会话或后端未返回恢复元信息）";
  }
  const activeMaintenance = ctx.getActiveMaintenance();
  if (activeMaintenance) {
    body += `\n• 维护任务：进行中（\`/${activeMaintenance.kind}\`，开始于 ${ctx.formatIsoTimestamp(activeMaintenance.requestedAt)}）`;
  } else if (lastMaintenanceTask) {
    body += `\n• 上次维护：${ctx.formatMaintenanceTaskSummary(lastMaintenanceTask)}`;
  }
  if (lastUpgradeAttempt) {
    body += `\n• 最近升级：${ctx.formatUpgradeAttemptSummary(lastUpgradeAttempt)}`;
  }
  if (ctx.config.bridgeDebug) {
    const idleLabel = snap
      ? snap.idleExpiresInMs === null
        ? "永不过期"
        : `${Math.round(snap.idleExpiresInMs / 60_000)} 分钟`
      : "—";
    const bridgeIdlePolicy = ctx.formatDurationMs(
      ctx.config.bridge.sessionIdleTimeoutMs,
    );
    const slot = snap?.activeSlot;
    const availableModeIds = slot
      ? (
          runtime?.getSessionModeState(slot.session.sessionId)
            ?.availableModes ?? []
        )
          .map((mode) => mode.modeId)
          .join(", ")
      : "";
    const legacySessionFile =
      slot?.session.backend === "cursor-legacy" &&
      slot.session.sessionId
        ? path.join(
            ctx.config.acp.adapterSessionDir,
            `${slot.session.sessionId}.json`,
          )
        : undefined;
    body += `

[调试 BRIDGE_DEBUG]
• 当前 session backend: ${activeSession?.backend ?? "—"}
• sessionKey: ${snap?.sessionKey ?? "(尚无)"}
• threadId: ${ctx.threadScope(msg) ?? "（主会话区）"}
• 活跃 slot: #${slot?.slotIndex ?? "—"}${slot?.name ? ` (${slot.name})` : ""}
• ACP sessionId: ${slot?.session.sessionId ?? "—"}
• 当前模式: ${currentModeId ?? "—"}
• 当前模型: ${currentModelLabel ?? "—"}
• Context 用量: ${usageLabel ?? "—"}
• 可用模式: ${availableModeIds || "—"}
• 会话 cwd: ${slot?.session.workspaceRoot ?? "—"}
• 空闲过期约: ${idleLabel}
• 会话策略: bridge=${bridgeIdlePolicy}
• ACP 子进程 cwd（allowlist 首项）: ${ctx.config.acp.workspaceRoot}
• 允许根 BRIDGE_WORK_ALLOWLIST: ${ctx.config.acp.allowedWorkspaceRoots.join(", ")}
• 映射文件: ${ctx.config.bridge.sessionStorePath}
• legacy 会话目录: ${ctx.config.acp.adapterSessionDir}
• legacy 会话文件: ${legacySessionFile ?? "—"}
• loadSession: ${runtime?.supportsLoadSession ?? false}
• LOG_LEVEL: ${ctx.config.logLevel}`;
  }
  await ctx.feishuBot.sendText(
    msg.chatId,
    body,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
  return true;
}
