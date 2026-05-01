import { spawn } from "node:child_process";
import type { FeishuMessage } from "../feishu/bot.js";
import { NO_SESSION_HINT } from "./bridge-context.js";
import type { BridgeMessageHandlerDeps } from "./bridge-message-handler-types.js";
import {
  appendSlotErrorLog,
  appendSlotPromptLog,
  appendSlotReplyLog,
} from "./bridge-slot-logging.js";

const BANG_OUTPUT_LIMIT = 6_000;
const BANG_TIMEOUT_MS = 60_000;
const BANG_KILL_GRACE_MS = 2_000;
const BANG_COMMAND_PREVIEW_LIMIT = 4_000;

type BangCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

function appendTail(
  current: string,
  chunk: string,
  limit: number,
): { text: string; truncated: boolean } {
  const next = current + chunk;
  if (next.length <= limit) {
    return { text: next, truncated: false };
  }
  return { text: next.slice(-limit), truncated: true };
}

function escapeCodeFence(text: string): string {
  return text.replace(/```/g, "``\u200b`");
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

function renderCodeBlock(language: string, body: string): string {
  return `\`\`\`${language}\n${escapeCodeFence(body || "（无输出）")}\n\`\`\``;
}

function renderCommandSummary(command: string): {
  rendered: string;
  truncated: boolean;
} {
  const preview = truncateText(command, BANG_COMMAND_PREVIEW_LIMIT);
  return {
    rendered: renderCodeBlock("sh", preview.text || " "),
    truncated: preview.truncated,
  };
}

function shellPathForExecution(): string {
  const shell = process.env["SHELL"]?.trim();
  return shell || "/bin/sh";
}

export function parseBangCommand(
  content: string,
): { command: string } | { error: "usage" } | null {
  const normalized = content.replace(/^\uFEFF/, "").trim();
  if (!normalized) return null;
  const first = normalized[0];
  if (first !== "!" && first !== "！") {
    return null;
  }
  const command = normalized.slice(1).trim();
  if (!command) {
    return { error: "usage" };
  }
  return { command };
}

async function executeBangCommand(
  command: string,
  cwd: string,
): Promise<BangCommandResult> {
  const shell = shellPathForExecution();
  return await new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      const next = appendTail(stdout, chunk, BANG_OUTPUT_LIMIT);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: string) => {
      const next = appendTail(stderr, chunk, BANG_OUTPUT_LIMIT);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, BANG_KILL_GRACE_MS);
    }, BANG_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function formatBangCommandReply(
  command: string,
  result: BangCommandResult,
  slot: {
    slotIndex: number;
    name?: string;
    session: { backend: string; workspaceRoot: string };
  },
): string {
  const slotLabel = `#${slot.slotIndex}${slot.name ? ` (${slot.name})` : ""}`;
  const commandBlock = renderCommandSummary(command);
  const statusLine = result.timedOut
    ? "⏱️ 终端命令执行超时，bridge 已终止该进程。"
    : result.exitCode === 0
      ? "✅ 终端命令执行完成。"
      : "❌ 终端命令执行失败。";
  const lines = [
    statusLine,
    `• Session：${slotLabel}`,
    `• Backend：\`${slot.session.backend}\``,
    `• 工作区：\`${slot.session.workspaceRoot}\``,
    `• Shell：\`${shellPathForExecution()}\``,
    result.exitCode != null ? `• 退出码：${result.exitCode}` : "• 退出码：无",
    ...(result.signal ? [`• 信号：\`${result.signal}\``] : []),
    ...(result.timedOut ? [`• 超时：${BANG_TIMEOUT_MS} ms`] : []),
    "",
    "**命令**",
    commandBlock.rendered,
    ...(commandBlock.truncated ? ["_（命令预览过长，已截断）_"] : []),
    "",
    "**stdout**",
    renderCodeBlock("text", result.stdout || "（无输出）"),
    "",
    "**stderr**",
    renderCodeBlock("text", result.stderr || "（无输出）"),
  ];
  if (result.stdoutTruncated || result.stderrTruncated) {
    lines.push("", "_（输出过长，仅保留末尾部分）_");
  }
  return lines.join("\n");
}

export async function handleBangCommand(
  ctx: BridgeMessageHandlerDeps,
  msg: FeishuMessage,
  content: string,
): Promise<boolean> {
  const parsed = parseBangCommand(content);
  if (!parsed) {
    return false;
  }

  if (!ctx.config.bridge.enableBangCommand) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "❌ 当前未启用 bridge 内置终端命令。管理员可设置 `BRIDGE_ENABLE_BANG_COMMAND=true` 后重启 bridge。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  if (ctx.config.bridge.adminUserIds.length === 0) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "❌ 已启用 bridge 内置终端命令，但未配置 `BRIDGE_ADMIN_USER_IDS`。为避免直接暴露宿主机 shell，命令已拒绝。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  if (!ctx.config.bridge.adminUserIds.includes(msg.senderId)) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "❌ `!命令` 仅管理员可用。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  if ("error" in parsed) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "用法：`!<shell 命令>`\n\n示例：`!pwd`、`!git status`、`!npm test`。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  let slot;
  try {
    slot = await ctx.sessionManager.getSlot(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      null,
      ctx.threadScope(msg),
    );
  } catch {
    await ctx.feishuBot.sendText(
      msg.chatId,
      NO_SESSION_HINT,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  const sessionKey = ctx.feishuSessionKey(msg);
  const promptState = ctx.promptCoordinator.getSlotPromptState(
    sessionKey,
    slot.slotIndex,
  );
  if (promptState.hasActivePrompt || promptState.hasQueuedPrompt) {
    await ctx.feishuBot.sendText(
      msg.chatId,
      "⏳ 当前活跃 session 仍有 ACP 回复在进行或排队。请等待完成，或先发送 `/stop` / `/cancel` 后再执行 `!命令`。",
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
    return true;
  }

  await ctx.flushPendingSessionNotices(msg);

  const logArgs = {
    slotMessageLog: ctx.slotMessageLog,
    sessionKey,
    slot,
    session: slot.session,
    msg,
  };
  await appendSlotPromptLog(logArgs, parsed.command, parsed.command);

  try {
    const result = await executeBangCommand(parsed.command, slot.session.workspaceRoot);
    const reply = formatBangCommandReply(parsed.command, result, slot);
    await appendSlotReplyLog(logArgs, reply);
    ctx.sessionManager.setSlotLastTurn(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      slot.slotIndex,
      parsed.command,
      reply,
      ctx.threadScope(msg),
    );
    ctx.sessionManager.touchActiveSession(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    await ctx.feishuBot.sendText(
      msg.chatId,
      reply,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendSlotErrorLog(logArgs, detail);
    ctx.sessionManager.touchActiveSession(
      msg.chatId,
      msg.senderId,
      msg.chatType,
      ctx.threadScope(msg),
    );
    await ctx.feishuBot.sendText(
      msg.chatId,
      `❌ 执行终端命令失败：${detail}`,
      msg.messageId,
      ctx.threadReplyOpts(msg),
    );
  }

  return true;
}
