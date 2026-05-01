import {
  formatCompatibleBackendAliases,
  formatPreferredBackendShortcuts,
  formatSupportedBackendValues,
} from "../acp/backend-metadata.js";
import { captureAcpReplayDuring } from "../acp/replay-capture.js";
import type { AcpBackend, SessionRecovery } from "../acp/runtime-contract.js";
import {
  matchesBridgeHelpCommand,
  matchesBridgeStartCommand,
  matchesInterruptUserCommand,
  parseNewConversationCommand,
} from "../commands/parse-new-conversation.js";
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
import { resolveAllowedWorkspaceDir } from "../session/workspace-policy.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";
import type { FeishuMessage } from "../feishu/bot.js";
import {
  buildWorkspaceWithBackendSelectCardMarkdown,
  buildWelcomeCardMarkdown,
} from "../feishu/interactive-cards.js";
import { formatBridgeCommandsHelp } from "./bridge-commands-help.js";
import { NO_SESSION_HINT } from "./bridge-context.js";
import type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";
import type { SessionSlot } from "../session/manager.js";

function buildSlotLastTurnCardContent(slot: SessionSlot): string | null {
  const hasPrompt = !!slot.lastPrompt?.trim();
  const hasReply = !!slot.lastReply?.trim();
  if (!hasPrompt && !hasReply) return null;

  const nameLabel = slot.name ? ` (${slot.name})` : "";
  const maxCardLength = 28_000;
  const title = `**↩️ Session #${slot.slotIndex}${nameLabel} 上一轮对话：**\n\n`;
  const chunks: string[] = [];
  if (hasPrompt) chunks.push(`**提问：**\n\n${slot.lastPrompt!.trim()}`);
  if (hasReply) chunks.push(`**回复：**\n\n${slot.lastReply!.trim()}`);
  let body = title + chunks.join("\n\n");
  let truncated = false;
  if (body.length > maxCardLength) {
    body = body.slice(0, maxCardLength);
    truncated = true;
  }
  return body + (truncated ? "\n\n_（内容过长，已截断）_" : "");
}

const DEFAULT_HISTORY_COUNT = 5;
const MAX_HISTORY_COUNT = 20;
const MAX_HISTORY_PROMPT_CHARS = 240;

function formatHistoryPromptLine(text: string | undefined): string {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return "（空）";
  if (normalized.length <= MAX_HISTORY_PROMPT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_HISTORY_PROMPT_CHARS).trimEnd()}…`;
}

function buildSlotHistoryText(
  slot: SessionSlot,
  count: number,
): string | null {
  const history = [...(slot.history ?? [])];
  if (history.length === 0) return null;

  const visible = history.slice(-count);
  const startIndex = history.length - visible.length + 1;
  const lineNumberWidth = String(history.length).length;
  const label = slot.name ? ` (${slot.name})` : "";
  return [
    `📜 session #${slot.slotIndex}${label} 最近 ${visible.length} 条 prompt 历史（旧到新；最多显示 ${count} 条）`,
    "",
    ...visible.map((turn, index) =>
      `${String(startIndex + index).padStart(lineNumberWidth, " ")}  ${formatHistoryPromptLine(turn.prompt)}`),
  ].join("\n\n");
}

function formatSessionLabel(slot: SessionSlot): string {
  return `#${slot.slotIndex}${slot.name ? ` (${slot.name})` : ""}`;
}

function usesSharedGroupSessions(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
): boolean {
  return (
    msg.chatType === "group" && ctx.config.bridge.groupSessionScope === "shared"
  );
}

async function requireSharedGroupSessionAdmin(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  commandLabel: string,
): Promise<boolean> {
  if (!usesSharedGroupSessions(ctx, msg)) {
    return true;
  }
  if (ctx.config.bridge.adminUserIds.length === 0) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "❌ 当前群聊启用了共享 session，但未配置 `BRIDGE_ADMIN_USER_IDS`，群内 session 管理命令暂不可用。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return false;
  }
  if (ctx.config.bridge.adminUserIds.includes(msg.senderId)) {
    return true;
  }
  await ctx.feishuBot.sendText(
    msg.chatId,
    `❌ 当前群聊启用了共享 session；仅管理员可执行 ${commandLabel} 等 session 管理命令。`,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
  return false;
}

async function sendWelcomeCard(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
): Promise<void> {
  try {
    await ctx.feishuBot.sendCard(
      msg.chatId,
      buildWelcomeCardMarkdown(),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  } catch (err) {
    console.warn(
      `[bridge] Failed to send welcome card to user ${msg.senderId} in chat ${msg.chatId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleSessionsList(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
): Promise<void> {
  const slots = await ctx.sessionManager.listSlots(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  if (slots.length === 0) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      NO_SESSION_HINT,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  const lines = slots.map((slot) => {
    const active = slot.isActive ? " ◀ 当前" : "";
    const name = slot.name ? ` (${slot.name})` : "";
    const runtime = ctx.runtimeForBackend(slot.backend);
    const modeId =
      runtime.getSessionModeState(slot.sessionId)?.currentModeId ?? "";
    const modeLine = modeId ? `\n  模式：\`${modeId}\`` : "";
    return `#${slot.slotIndex}${name}${active}
  Backend：\`${slot.backend}\`
  工作区：\`${slot.workspaceRoot}\`${modeLine}`;
  });
  await ctx.feishuBot.sendText(
    msg.chatId,
    `📋 当前所有 session（共 ${slots.length} 个；# 为槽位编号，关闭后不会复用，故可能与数量连续不一致）：

${lines.join("\n\n")}

• \`/new list\` / \`/new <序号>\` / \`/new <路径>\` — 新建 session
• \`/switch <编号或名称>\` — 切换
• \`/reply [编号或名称]\` — 重发上一轮缓存回复
• \`/history [条数]\` — 查看当前槽位最近几条 prompt
• \`/fileback <说明>\` — 向 Agent 附带「用 FEISHU_SEND_FILE 发文件」说明后再发你的任务
• \`/stop\` / \`/cancel\` — 中断**当前活跃**槽位正在生成的回复，并撤销该槽位排队消息（不关 session）
• \`/resume\` — 列出当前 project 可恢复的历史 session
• \`/resume 0\` — 对当前 session 执行 ACP \`session/load\`
• \`/resume <序号或sessionId>\` — 恢复到指定历史 session
• \`/resume -b <backend> <id>\` — 直接按 backend 指定的恢复 ID 绑定当前槽位
• \`/mode <模式ID>\` — 切换当前 session 模式
• \`/rename <新名字>\` — 重命名当前 session
• \`/rename <编号或名称> <新名字>\` — 重命名指定 session
• \`/close <编号或名称>\` — 关闭
• \`/close all\` — 关闭本组全部
• \`/topic …\` — 仅发飞书、不发给 Agent（便于话题内写标题）`,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

function formatResumeHistoryLine(
  index: number,
  entry: {
    backend: AcpBackend;
    sessionId: string;
    label?: string;
    lastActiveAt: number;
  },
  formatIsoTimestamp: (ms: number) => string,
  title = "历史 session",
): string {
  return [
    `【${index}】${title}`,
    `  Backend：\`${entry.backend}\``,
    `  sessionId：\`${entry.sessionId}\``,
    ...(entry.label ? [`  标签：${entry.label}`] : []),
    `  最近活跃：${formatIsoTimestamp(entry.lastActiveAt)}`,
  ].join("\n");
}

function buildResumeUsageLines(): string[] {
  return [
    "用法：",
    "• `/resume 0` — 对当前 session 执行 ACP `session/load`",
    "• `/resume <序号>` — 恢复到对应历史 session",
    "• `/resume <sessionId>` — 按历史列表中的 sessionId 恢复",
    "• `/resume -b <backend> <id>` — 直接按 backend 指定的恢复 ID 绑定当前槽位",
    "• `<id>` 含义：`cursor-legacy` = CLI resume ID，`claude` = Claude resume session，`codex` / `cursor-official` / `gemini` = ACP sessionId",
  ];
}

function buildResumeReplayMessage(headerLines: string[], replayMd: string): string {
  const header = `${headerLines.join("\n")}\n\n---\n\n**会话历史回放（适配器推送）**\n\n`;
  const emptyHint =
    "_（未收到可展示的文本回放：可能历史为空、或仅有非 text 内容块；可设 `ACP_RELOAD_TRACE_LOG=true` 查看入站 `session/update`）_";

  let body = replayMd.trim() ? replayMd.trim() : emptyHint;
  const maxTotal = 28_000;
  if (header.length + body.length > maxTotal) {
    body =
      body.slice(0, Math.max(0, maxTotal - header.length - 120)) +
      "\n\n_（回放过长，已截断）_";
  }
  return header + body;
}

function formatDirectResumeInputLabel(backend: AcpBackend): string {
  if (backend === "cursor-legacy") return "CLI resume ID";
  if (backend === "claude") return "Claude resume session";
  if (backend === "gemini") return "Gemini sessionId";
  return "sessionId";
}

function buildDirectResumeRecoveryLines(recovery: SessionRecovery | undefined): string[] {
  if (recovery?.kind === "cursor-cli") {
    return [`• 实际 CLI resume ID：\`${recovery.cursorCliChatId}\``];
  }
  if (recovery?.kind === "claude-session") {
    return [`• 实际 Claude 恢复会话：\`${recovery.resumeSessionId}\``];
  }
  return [];
}

async function handleDirectResumeCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  backend: AcpBackend,
  rawId: string,
): Promise<void> {
  if (!ctx.config.acp.enabledBackends.includes(backend)) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ backend \`${backend}\` 当前未启用。已启用：${ctx.config.acp.enabledBackends.map((item) => `\`${item}\``).join(" / ")}。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const requestedId = rawId.trim();
  if (!requestedId) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ \`/resume\` 参数不正确。\n\n${buildResumeUsageLines().join("\n")}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const snap = await ctx.sessionManager.getSessionSnapshotLoaded(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  if (!snap) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ ${NO_SESSION_HINT}\n\n直接恢复外部 ID 需要先有一个活跃 session 来确定工作区。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const promptState = ctx.promptCoordinator.getSlotPromptState(
    snap.sessionKey,
    snap.activeSlot.slotIndex,
  );
  if (promptState.hasActivePrompt || promptState.hasQueuedPrompt) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "⏳ 当前活跃 session 仍有 ACP 回复在进行或排队。请等待完成，或先发送 `/stop` / `/cancel` 后再执行 `/resume -b ...`。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const runtime = ctx.runtimeForBackend(backend);
  const workspaceRoot = snap.activeSlot.session.workspaceRoot;
  await ctx.flushPendingSessionNotices(msg);

  try {
    if (backend === "cursor-legacy" || backend === "claude") {
      const requestedRecovery =
        backend === "cursor-legacy"
          ? { kind: "cursor-cli" as const, cursorCliChatId: requestedId }
          : { kind: "claude-session" as const, resumeSessionId: requestedId };
      const created = await runtime.newSession(workspaceRoot, {
        recovery: requestedRecovery,
      });
      const rebound = await ctx.sessionManager.rebindActiveSlotToResumeHistory(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        {
          backend,
          sessionId: created.sessionId,
          recovery: created.recovery ?? requestedRecovery,
          workspaceRoot,
          lastActiveAt: Date.now(),
        },
        ctx.threadScope(msg),
      );
      await ctx.feishuBot.sendText(
        msg.chatId,
        [
          `✅ 已将当前活跃槽位直接绑定到外部恢复会话 ${formatSessionLabel(rebound)}。`,
          `• Backend：\`${backend}\``,
          `• 工作区：\`${workspaceRoot}\``,
          `• 输入的 ${formatDirectResumeInputLabel(backend)}：\`${requestedId}\``,
          `• 新 ACP sessionId：\`${created.sessionId}\``,
          ...buildDirectResumeRecoveryLines(created.recovery ?? requestedRecovery),
          "",
          "说明：该 backend 通过 `session/new` + recovery 继续旧会话，通常不会立即回放历史文本；后续消息会继续写入该会话。",
        ].join("\n"),
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }

    if (!runtime.supportsLoadSession) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        `❌ backend \`${backend}\` 未宣告 \`loadSession\`，无法直接按 sessionId 恢复。`,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }

    const replayMd = await captureAcpReplayDuring(
      runtime.bridgeClient,
      requestedId,
      () => runtime.loadSession(requestedId, workspaceRoot),
      {
        showAvailableCommands: ctx.config.bridge.showAcpAvailableCommands,
      },
    );
    const rebound = await ctx.sessionManager.rebindActiveSlotToResumeHistory(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      {
        backend,
        sessionId: requestedId,
        workspaceRoot,
        lastActiveAt: Date.now(),
      },
      ctx.threadScope(msg),
    );
    await ctx.feishuBot.sendText(
      msg.chatId,
      buildResumeReplayMessage(
        [
          `✅ 已将当前活跃槽位直接恢复到外部 session ${formatSessionLabel(rebound)}。`,
          `• Backend：\`${backend}\``,
          `• sessionId：\`${requestedId}\``,
          `• 工作区：\`${workspaceRoot}\``,
        ],
        replayMd,
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  } catch (err) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ /resume -b ${backend} 失败:\n${formatJsonRpcLikeError(err)}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
}

async function handleResumeCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  command: Extract<ReturnType<typeof parseNewConversationCommand>, { kind: "resume" }>,
): Promise<void> {
  if (command.invalidUsage) {
    const backendValues = formatSupportedBackendValues();
    const shortcuts = formatPreferredBackendShortcuts();
    const compatibleAliases = formatCompatibleBackendAliases();
    await ctx.feishuBot.sendText(
      msg.chatId,
      command.invalidBackend
        ? `❌ 不支持的 backend：\`${command.invalidBackend}\`。可用值：${backendValues}（常用简写：${shortcuts}${compatibleAliases ? `；也兼容 ${compatibleAliases}` : ""}）。`
        : `❌ \`/resume\` 参数不正确。\n\n${buildResumeUsageLines().join("\n")}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  if (command.backend && typeof command.target === "string") {
    await handleDirectResumeCommand(
      ctx,
      msg,
      command.backend,
      command.target,
    );
    return;
  }

  const target = command.target;
  if (target === null) {
    const listed = await ctx.sessionManager.listResumeHistoryForProject(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    await ctx.flushPendingSessionNotices(msg);

    const currentEntry = listed.currentEntry ?? {
      backend: listed.activeSlot.session.backend,
      sessionId: listed.activeSlot.session.sessionId,
      workspaceRoot: listed.activeSlot.session.workspaceRoot,
      lastActiveAt: listed.activeSlot.session.lastActiveAt,
      preferredModelId: listed.activeSlot.session.preferredModelId,
      recovery: listed.activeSlot.session.recovery,
      label: undefined,
    };
    const lines = [
      `📚 当前 project 可恢复的历史 session（工作区：\`${listed.activeSlot.session.workspaceRoot}\`）`,
      "",
      formatResumeHistoryLine(0, currentEntry, ctx.formatIsoTimestamp, "当前 session"),
      ...(listed.entries.length > 0
        ? ["", ...listed.entries.map((entry, index) =>
            formatResumeHistoryLine(index + 1, entry, ctx.formatIsoTimestamp),
          )]
        : ["", "（当前 project 暂无其它可恢复的历史 session）"]),
      "",
      ...buildResumeUsageLines(),
    ];
    await ctx.feishuBot.sendText(
      msg.chatId,
      lines.join("\n"),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  if (target === 0) {
    const session = await ctx.sessionManager.getActiveSession(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
      { skipAvailabilityProbe: true },
    );
    if (!session) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        `❌ ${NO_SESSION_HINT}`,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    const runtime = ctx.runtimeForSession(session);
    await ctx.flushPendingSessionNotices(msg);
    if (!runtime.supportsLoadSession) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        "❌ 当前 Agent 未宣告 `loadSession`，无法执行 `/resume 0`。",
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    try {
      const replayMd = await captureAcpReplayDuring(
        runtime.bridgeClient,
        session.sessionId,
        () => runtime.loadSession(session.sessionId, session.workspaceRoot),
        {
          showAvailableCommands: ctx.config.bridge.showAcpAvailableCommands,
        },
      );
      await ctx.feishuBot.sendText(
        msg.chatId,
        buildResumeReplayMessage(
          [
            "✅ 已对当前 session 执行 ACP `session/load`。",
            `• Backend：\`${session.backend}\``,
            `• sessionId：\`${session.sessionId}\``,
            `• 工作区：\`${session.workspaceRoot}\``,
          ],
          replayMd,
        ),
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
    } catch (err) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        `❌ /resume 0 失败:\n${formatJsonRpcLikeError(err)}`,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
    }
    return;
  }

  const resolved = await ctx.sessionManager.resolveResumeHistoryForProject(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    target,
    ctx.threadScope(msg),
  );
  const runtime = ctx.runtimeForBackend(resolved.entry.backend);
  await ctx.flushPendingSessionNotices(msg);
  if (!runtime.supportsLoadSession) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ 目标历史 session 的 backend \`${resolved.entry.backend}\` 未宣告 \`loadSession\`，无法恢复。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  try {
    const replayMd = await captureAcpReplayDuring(
      runtime.bridgeClient,
      resolved.entry.sessionId,
      () => runtime.loadSession(resolved.entry.sessionId, resolved.entry.workspaceRoot),
      {
        showAvailableCommands: ctx.config.bridge.showAcpAvailableCommands,
      },
    );
    const rebound = await ctx.sessionManager.rebindActiveSlotToResumeHistory(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      resolved.entry,
      ctx.threadScope(msg),
    );
    await ctx.feishuBot.sendText(
      msg.chatId,
      buildResumeReplayMessage(
        [
          `✅ 已将当前活跃槽位恢复到历史 session ${formatSessionLabel(rebound)}。`,
          `• Backend：\`${resolved.entry.backend}\``,
          `• sessionId：\`${resolved.entry.sessionId}\``,
          `• 工作区：\`${resolved.entry.workspaceRoot}\``,
          ...(resolved.entry.label ? [`• 标签：${resolved.entry.label}`] : []),
        ],
        replayMd,
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  } catch (err) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ /resume 失败:\n${formatJsonRpcLikeError(err)}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
}

async function handleModeCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  modeId: string | undefined,
): Promise<void> {
  if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/mode`"))) {
    return;
  }
  const session = await ctx.sessionManager.getActiveSession(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  const runtime = session ? ctx.runtimeForSession(session) : undefined;
  if (!modeId) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      formatModeUsage(
        session ? runtime?.getSessionModeState(session.sessionId) : undefined,
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  let sessionId: string | undefined;
  try {
    if (!session) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        `❌ ${NO_SESSION_HINT}`,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    const activeSession = session;
    sessionId = session.sessionId;
    const modeRuntime = ctx.runtimeForSession(session);
    await ctx.flushPendingSessionNotices(msg);
    const modeState = modeRuntime.getSessionModeState(session.sessionId);
    const resolved = resolveSessionModeInput(modeId, modeState);
    await modeRuntime.setSessionMode(session.sessionId, resolved.modeId);
    await ctx.feishuBot.sendText(
      msg.chatId,
      `✅ 已切换模式为 \`${resolved.modeId}\`（后续对话将按该模式处理）。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    void activeSession;
  } catch (err) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      formatModeSwitchFailure(
        err,
        sessionId && session
          ? ctx.runtimeForSession(session).getSessionModeState(sessionId)
          : undefined,
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
}

async function handleSwitchCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  target: number | string | null,
): Promise<void> {
  if (target === null) {
    const slot = await ctx.sessionManager.switchToPreviousSlot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    await ctx.flushPendingSessionNotices(msg);
    const label = slot.name ? ` (${slot.name})` : "";
    await ctx.feishuBot.sendText(
      msg.chatId,
      `✅ 已切换到上一个 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    const lastTurnCard = buildSlotLastTurnCardContent(slot);
    if (lastTurnCard) {
      await ctx.feishuBot.sendCard(
        msg.chatId,
        lastTurnCard,
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
    }
    return;
  }

  const slot = await ctx.sessionManager.switchSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    target,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  const label = slot.name ? ` (${slot.name})` : "";
  await ctx.feishuBot.sendText(
    msg.chatId,
    `✅ 已切换到 session #${slot.slotIndex}${label}\n工作区：\`${slot.session.workspaceRoot}\``,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
  const lastTurnCard = buildSlotLastTurnCardContent(slot);
  if (lastTurnCard) {
    await ctx.feishuBot.sendCard(
      msg.chatId,
      lastTurnCard,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
}

async function handleReplyCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  target: number | string | null,
): Promise<void> {
  const slot = await ctx.sessionManager.getSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    target,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  const lastTurnCard = buildSlotLastTurnCardContent(slot);
  if (!lastTurnCard) {
    const label = slot.name ? ` (${slot.name})` : "";
    await ctx.feishuBot.sendText(
      msg.chatId,
      `ℹ️ session #${slot.slotIndex}${label} 暂无缓存的上一轮对话。\n\n只有在当前桥接进程里成功完成过一次回复后，才能通过 \`/reply\` 重新发送。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  await ctx.feishuBot.sendCard(
    msg.chatId,
    lastTurnCard,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

async function handleHistoryCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  count: number | undefined,
  invalidUsage: boolean | undefined,
): Promise<void> {
  if (!ctx.config.bridge.sessionHistoryEnabled) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "ℹ️ 当前未启用 session 历史记录。可在环境变量中设置 `BRIDGE_SESSION_HISTORY_ENABLED=true` 后重启 bridge。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  if (invalidUsage) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "用法：`/history` 或 `/history <条数>`\n\n示例：`/history`、`/history 10`（最多 20 条）",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const slot = await ctx.sessionManager.getSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    null,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  const limit = Math.min(
    MAX_HISTORY_COUNT,
    Math.max(1, count ?? DEFAULT_HISTORY_COUNT),
  );
  const body = buildSlotHistoryText(slot, limit);
  if (!body) {
    const label = slot.name ? ` (${slot.name})` : "";
    await ctx.feishuBot.sendText(
      msg.chatId,
      `ℹ️ session #${slot.slotIndex}${label} 暂无可显示的历史。\n\n只有在该槽位真正向 Agent 发出过 prompt 后，\`/history\` 才会显示记录。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  await ctx.feishuBot.sendText(
    msg.chatId,
    body,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

async function handleRenameCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  target: number | string | null,
  name: string,
): Promise<void> {
  if ((typeof target === "number" && isNaN(target)) || !name.trim()) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "用法：`/rename <新名字>` 或 `/rename <编号或名称> <新名字>`\n\n示例：`/rename backend`、`/rename 2 backend`",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  const renamed = await ctx.sessionManager.renameSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    target,
    name,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  await ctx.feishuBot.sendText(
    msg.chatId,
    `✅ 已将 session #${renamed.slotIndex} 重命名为 \`${renamed.name}\``,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

async function handleCloseCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  target: number | string,
): Promise<void> {
  if (typeof target === "number" && isNaN(target)) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "用法：`/close <编号或名称>` 或 `/close all`\n\n发送 `/sessions` 查看当前所有 session。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  const snapshot = ctx.sessionManager.getSessionSnapshot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  const sessionKey = snapshot?.sessionKey;
  if (target === "all") {
    const activeSlot = findActivePromptSlot(
      ctx,
      snapshot?.sessionKey,
      snapshot?.group.slots ?? [],
    );
    if (activeSlot) {
      await sendCloseRejectedForActivePrompt(ctx, msg, activeSlot);
      return;
    }
    const { closed } = await ctx.sessionManager.closeAllSlots(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    if (sessionKey) {
      for (const slot of closed) {
        ctx.promptCoordinator.clearQueuedPromptForSlot(sessionKey, slot.slotIndex);
      }
    }
    await ctx.flushPendingSessionNotices(msg);
    const summary = closed
      .map((slot) => {
        const label = slot.name ? ` (${slot.name})` : "";
        return `#${slot.slotIndex}${label}`;
      })
      .join("、");
    await ctx.feishuBot.sendText(
      msg.chatId,
      `✅ 已关闭本组全部 ${closed.length} 个 session：${summary}\n\n已释放全局配额。请使用 \`/new list\` 与 \`/new <序号或路径>\` 重新创建 session。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }
  const snapshotSlot = snapshot
    ? resolveSnapshotSlot(snapshot.group.slots, target)
    : undefined;
  if (
    snapshotSlot &&
    snapshot &&
    ctx.promptCoordinator.getSlotPromptState(
      snapshot.sessionKey,
      snapshotSlot.slotIndex,
    ).hasActivePrompt
  ) {
    await sendCloseRejectedForActivePrompt(ctx, msg, snapshotSlot);
    return;
  }
  const { closed, removedEntireGroup } = await ctx.sessionManager.closeSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    target,
    ctx.threadScope(msg),
  );
  if (sessionKey) {
    ctx.promptCoordinator.clearQueuedPromptForSlot(sessionKey, closed.slotIndex);
  }
  await ctx.flushPendingSessionNotices(msg);
  const label = closed.name ? ` (${closed.name})` : "";
  const tail = removedEntireGroup
    ? "\n\n该聊天/话题下已无 session，已释放全局配额。请使用 `/new list` 与 `/new <序号或路径>` 重新创建。"
    : "";
  await ctx.feishuBot.sendText(
    msg.chatId,
    `✅ 已关闭 session #${closed.slotIndex}${label}${tail}`,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

function resolveSnapshotSlot(
  slots: SessionSlot[],
  target: number | string,
): SessionSlot | undefined {
  if (typeof target === "number") {
    return slots.find((slot) => slot.slotIndex === target);
  }
  return slots.find((slot) => slot.name === target);
}

function findActivePromptSlot(
  ctx: BridgeMessageHandlerDeps,
  sessionKey: string | undefined,
  slots: SessionSlot[],
): SessionSlot | undefined {
  if (!sessionKey) return undefined;
  return slots.find((slot) =>
    ctx.promptCoordinator.getSlotPromptState(
      sessionKey,
      slot.slotIndex,
    ).hasActivePrompt,
  );
}

async function sendCloseRejectedForActivePrompt(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  slot: SessionSlot,
): Promise<void> {
  await ctx.feishuBot.sendText(
    msg.chatId,
    `⏳ ${formatSessionLabel(slot)} 仍有 ACP 回复在进行。请先发送 \`/stop\` / \`/cancel\` 中断后再关闭 session。`,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

async function handleNewCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  command: Extract<ReturnType<typeof parseNewConversationCommand>, { kind: "new" }>,
): Promise<void> {
  if (command.invalidUsage) {
    const backendValues = formatSupportedBackendValues();
    const shortcuts = formatPreferredBackendShortcuts();
    const compatibleAliases = formatCompatibleBackendAliases();
    await ctx.feishuBot.sendText(
      msg.chatId,
      command.invalidBackend
        ? `❌ 不支持的 backend：\`${command.invalidBackend}\`。可用值：${backendValues}（常用简写：${shortcuts}${compatibleAliases ? `；也兼容 ${compatibleAliases}` : ""}）。`
        : "❌ `/new` 参数不正确。请先发送 `/commands` 或 `/help` 查看用法。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  if (command.variant === "list") {
    const presets = ctx.presetsStore.getPresets();
    const interactiveCard = buildWorkspaceWithBackendSelectCardMarkdown({
      presets,
      showBackendSelector: ctx.config.acp.enabledBackends.length > 1,
      enabledBackends: ctx.config.acp.enabledBackends,
      defaultBackend: ctx.config.acp.backend,
    });

    await ctx.feishuBot.sendCard(
      msg.chatId,
      interactiveCard,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  if (command.variant === "remove-list") {
    if (command.index < 1) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        "用法：`/new remove-list <序号>`（序号见 `/new list`）",
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    const removed = await ctx.presetsStore.removePresetAt(command.index);
    const list = ctx.presetsStore.getPresets();
    const lines = list.map((preset, index) => `${index + 1}. \`${preset}\``).join("\n");
    await ctx.feishuBot.sendText(
      msg.chatId,
      removed
        ? `✅ 已删除序号 ${command.index}。\n\n${list.length ? lines : "（列表已空）"}`
        : `❌ 无序号 ${command.index}。请先 \`/new list\` 查看当前列表。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  if (command.variant === "add-list") {
    if (!command.path.trim()) {
      await ctx.feishuBot.sendText(
        msg.chatId,
        "用法：`/new add-list <目录路径>`",
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    }
    const abs = await resolveAllowedWorkspaceDir(command.path, ctx.config);
    const added = await ctx.presetsStore.addPreset(abs);
    const list = ctx.presetsStore.getPresets();
    const lines = list.map((preset, index) => `${index + 1}. \`${preset}\``).join("\n");
    await ctx.feishuBot.sendText(
      msg.chatId,
      added
        ? `✅ 已加入列表。\n\n${lines}`
        : `ℹ️ 该路径已在列表中，未重复添加。\n\n${lines}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  let workspaceAbs: string;
  const slotName = command.name;
  switch (command.variant) {
    case "default":
      await ctx.feishuBot.sendText(
        msg.chatId,
        "❌ 创建 session 须指定工作区。请 `/new list` 查看列表后用 `/new <序号>`，或使用 `/new <目录绝对路径>`（可与 `--name` 组合，例如 `/new 1 --name backend`）。",
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return;
    case "workspace":
      workspaceAbs = await resolveAllowedWorkspaceDir(command.path, ctx.config);
      break;
    case "preset": {
      const index = command.index;
      if (index < 1) {
        await ctx.feishuBot.sendText(
          msg.chatId,
          "❌ 序号须为 ≥1 的整数。",
          msg.messageId,
          ctx.threadReplyOpts(msg),
        );
        return;
      }
      const preset = ctx.presetsStore.getByIndex(index);
      if (!preset) {
        await ctx.feishuBot.sendText(
          msg.chatId,
          `❌ 列表中无序号 ${index}。请先发送 \`/new list\` 查看。`,
          msg.messageId,
          ctx.threadReplyOpts(msg),
        );
        return;
      }
      workspaceAbs = await resolveAllowedWorkspaceDir(preset, ctx.config);
      break;
    }
    default:
      return;
  }

  const requestedBackend: AcpBackend = command.backend ?? ctx.config.acp.backend;
  if (!ctx.config.acp.enabledBackends.includes(requestedBackend)) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ backend \`${requestedBackend}\` 当前未启用。已启用：${ctx.config.acp.enabledBackends.map((item) => `\`${item}\``).join(" / ")}。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return;
  }

  const result = await ctx.sessionManager.createNewSlot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    workspaceAbs,
    requestedBackend,
    slotName,
    ctx.threadScope(msg),
  );
  await ctx.flushPendingSessionNotices(msg);
  const nameLabel = result.name ? ` (${result.name})` : "";
  await ctx.feishuBot.sendText(
    msg.chatId,
    `✅ 已新建并切换到 session #${result.slotIndex}${nameLabel}\nBackend：\`${result.backend}\`\n工作区：\`${result.workspaceRoot}\`\n\n发送 \`/sessions\` 查看所有 session。`,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
}

async function handleBridgeManagedCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
): Promise<boolean> {
  const command = parseNewConversationCommand(content);
  if (!command) return false;

  try {
    if (
      command.kind === "restart" ||
      command.kind === "update" ||
      command.kind === "upgrade"
    ) {
      if (command.kind === "upgrade") {
        await ctx.handleUpgradeCommand(msg, command);
      } else {
        await ctx.handleMaintenanceCommand(msg, command);
      }
      return true;
    }

    if (command.kind === "sessions") {
      await handleSessionsList(ctx, msg);
      return true;
    }

    if (command.kind === "whoami") {
      await ctx.feishuBot.sendText(
        msg.chatId,
        ctx.formatWhoAmIMessage(msg.senderId),
        msg.messageId,
        ctx.threadReplyOpts(msg),
      );
      return true;
    }

    if (command.kind === "resume") {
      if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/resume`"))) {
        return true;
      }
      await handleResumeCommand(ctx, msg, command);
      return true;
    }

    if (command.kind === "mode") {
      await handleModeCommand(ctx, msg, command.modeId);
      return true;
    }

    if (command.kind === "switch") {
      if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/switch`"))) {
        return true;
      }
      await handleSwitchCommand(ctx, msg, command.target);
      return true;
    }

    if (command.kind === "reply") {
      await handleReplyCommand(ctx, msg, command.target);
      return true;
    }

    if (command.kind === "history") {
      await handleHistoryCommand(ctx, msg, command.count, command.invalidUsage);
      return true;
    }

    if (command.kind === "rename") {
      if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/rename`"))) {
        return true;
      }
      await handleRenameCommand(ctx, msg, command.target, command.name);
      return true;
    }

    if (command.kind === "close") {
      if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/close`"))) {
        return true;
      }
      await handleCloseCommand(ctx, msg, command.target);
      return true;
    }

    if (command.kind === "new") {
      if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/new`"))) {
        return true;
      }
      await handleNewCommand(ctx, msg, command);
      return true;
    }
  } catch (err) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ ${err instanceof Error ? err.message : String(err)}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
  return true;
}

async function handleHelpCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  contentMultiline: string,
): Promise<boolean> {
  if (!matchesBridgeHelpCommand(contentMultiline)) return false;
  const snapshot = ctx.sessionManager.getSessionSnapshot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  await ctx.feishuBot.sendText(
    msg.chatId,
    formatBridgeCommandsHelp(
      snapshot?.activeSlot.session.backend ?? ctx.config.acp.backend,
    ),
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
  return true;
}

async function handleModelCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
): Promise<boolean> {
  const modelMatch = content.trim().match(/^\/model(?:\s+(\S+))?$/i);
  if (!modelMatch) return false;
  if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/model`"))) {
    return true;
  }

  const activeSessionForModel = await ctx.sessionManager.getActiveSession(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  if (!activeSessionForModel) return false;

  const runtime = ctx.runtimeForSession(activeSessionForModel);
  const modelId = modelMatch[1]?.trim();
  if (!modelId) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      formatModelUsage(
        runtime.getSessionModelState(activeSessionForModel.sessionId),
        { numbered: true },
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }
  let sessionId: string | undefined;
  try {
    sessionId = activeSessionForModel.sessionId;
    await ctx.flushPendingSessionNotices(msg);
    const modelState = runtime.getSessionModelState(activeSessionForModel.sessionId);
    const resolved = resolveModelSelectorInput(modelId, modelState);
    await runtime.setSessionModel(activeSessionForModel.sessionId, resolved.modelId);
    const confirmedModelId =
      runtime.getSessionModelState(activeSessionForModel.sessionId)
        ?.currentModelId ?? resolved.modelId;
    if (
      activeSessionForModel.backend === "codex" ||
      activeSessionForModel.backend === "gemini"
    ) {
      ctx.sessionManager.setActiveSessionPreferredModel(
        msg.chatId,
        msg.senderId,
        msg.chatType,
        resolved.modelId,
        ctx.threadScope(msg),
      );
    }
    const okText =
      resolved.pickedByIndex != null
        ? `✅ 已按序号 ${resolved.pickedByIndex} 切换为 \`${confirmedModelId}\`（后续对话将使用该模型）。`
        : `✅ 已切换模型为 \`${confirmedModelId}\`（后续对话将使用该模型）。`;
    await ctx.feishuBot.sendText(
      msg.chatId,
      okText,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  } catch (err) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      formatModelSwitchFailure(
        err,
        sessionId ? runtime.getSessionModelState(sessionId) : undefined,
        { numbered: true },
      ),
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }
  return true;
}

async function handleInterruptCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  contentMultiline: string,
): Promise<boolean> {
  if (!matchesInterruptUserCommand(contentMultiline)) return false;
  if (!(await requireSharedGroupSessionAdmin(ctx, msg, "`/stop`"))) {
    return true;
  }

  const snap = ctx.sessionManager.getSessionSnapshot(
    msg.chatId,
    msg.senderId,
    msg.chatType,
    ctx.threadScope(msg),
  );
  if (!snap) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      NO_SESSION_HINT,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }
  const sessionKey = snap.sessionKey;
  const active = snap.activeSlot;
  const promptState = ctx.promptCoordinator.getSlotPromptState(
    sessionKey,
    active.slotIndex,
  );
  const hasActivePrompt = promptState.hasActivePrompt;
  const hadQueuedPrompt = ctx.promptCoordinator.clearQueuedPromptForSlot(
    sessionKey,
    active.slotIndex,
  );
  if (!hasActivePrompt && !hadQueuedPrompt) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "ℹ️ 当前活跃 session 既没有正在生成的回复，也没有排队中的消息。其它槽位若在生成，请先 `/switch` 到该槽位再发 `/stop`。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }
  if (!hasActivePrompt && hadQueuedPrompt) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      `✅ 已撤销当前槽位中的排队消息（${formatSessionLabel(active)}）。`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }
  await ctx.flushPendingSessionNotices(msg);
  const errors: string[] = [];
  try {
    await ctx.runtimeForSession(active.session).cancelSession(active.session.sessionId);
  } catch (err) {
    errors.push(
      `#${active.slotIndex}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const label = formatSessionLabel(active);
  let body = hadQueuedPrompt
    ? `✅ 已向进行中的任务发送中断请求（${label}），并撤销该槽位中的排队消息；session 仍保留，可继续对话。`
    : `✅ 已向进行中的任务发送中断请求（${label}），效果与在 Cursor / Cursor Agent 侧中断本轮生成类似；session 仍保留，可继续对话。`;
  if (errors.length > 0) {
    body += `\n\n⚠️ 中断失败：\n${errors.join("\n")}`;
  }
  await ctx.feishuBot.sendText(
    msg.chatId,
    body,
    msg.messageId,
    ctx.threadReplyOpts(msg),
  );
  return true;
}

export async function handleBridgeCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
  contentMultiline: string,
): Promise<boolean> {
  if (matchesBridgeStartCommand(contentMultiline)) {
    await sendWelcomeCard(ctx, msg);
    return true;
  }

  if (await handleBridgeManagedCommand(ctx, msg, content)) {
    return true;
  }

  if (await handleHelpCommand(ctx, msg, contentMultiline)) {
    return true;
  }

  if (await handleModelCommand(ctx, msg, content)) {
    return true;
  }

  if (await handleInterruptCommand(ctx, msg, contentMultiline)) {
    return true;
  }

  return false;
}
