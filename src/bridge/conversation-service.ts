import * as path from "node:path";
import {
  formatSessionModelLabel,
  formatSessionUsage,
} from "../acp/session-display-format.js";
import { assertPathInWorkspace } from "../acp/fs-sandbox.js";
import type { BridgeAcpRuntime } from "../acp/runtime-contract.js";
import type { BridgeAcpEvent } from "../acp/types.js";
import type { Config } from "../config/index.js";
import { FeishuBot, type FeishuMessage } from "../feishu/bot.js";
import { FeishuCardState, isRenderableEvent } from "../feishu/renderer.js";
import type { UserSession } from "../session/manager.js";
import { formatJsonRpcLikeError } from "../utils/format-json-rpc-error.js";

const AUTH_HINT_PATTERNS = [
  "unable to process your request because cursor-agent cli is not authenticated",
  "cursor-agent cli is not authenticated",
  "not authenticated",
  "cursor-agent login",
];
const AUTH_LIKE_REPLY_PREFIXES = [
  "unable to process your request because cursor-agent cli is not authenticated.",
  "unable to process your request because cursor-agent cli is not authenticated.\n\n",
];
const DEFAULT_LEGACY_CURSOR_TIMEOUT_MS = 120_000;
const MISLEADING_AUTH_TIMEOUT_TOLERANCE_MS = 5_000;

function formatLegacyTimeoutSeconds(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `约 ${seconds} 秒`;
}

function parseLegacyCursorTimeoutMs(extraArgs: string[]): number {
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    if (!arg) continue;

    if (arg === "--timeout" || arg === "-t") {
      const raw = extraArgs[i + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      const parsed = Number.parseInt(arg.slice("--timeout=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }

  return DEFAULT_LEGACY_CURSOR_TIMEOUT_MS;
}

function buildAuthTimeoutHintBody(timeoutMs: number): string {
  return `⏱️ 本次请求在长时间执行后被中断，更可能是 Cursor CLI 超时（${formatLegacyTimeoutSeconds(timeoutMs)}），而不是登录失效。\n\n请先尝试把任务拆小后重试；若短请求也出现同样报错，再执行 \`cursor-agent login\`。`;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\r/g, "").trim();
}

function isStandaloneAuthLikeReply(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return AUTH_LIKE_REPLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isLikelyTimeoutMisclassifiedAsAuth(
  text: string,
  elapsedMs: number,
  timeoutMs: number,
): boolean {
  const normalized = normalizeText(text);
  const hasAuthHint = AUTH_HINT_PATTERNS.some((p) => normalized.includes(p));
  if (!hasAuthHint) return false;
  if (!isStandaloneAuthLikeReply(normalized)) return false;
  return elapsedMs >= Math.max(1_000, timeoutMs - MISLEADING_AUTH_TIMEOUT_TOLERANCE_MS);
}

export class ConversationService {
  constructor(
    private readonly config: Config,
    private readonly acp: BridgeAcpRuntime,
    private readonly feishu: FeishuBot,
  ) {}

  async handleUserPrompt(
    msg: FeishuMessage,
    session: UserSession,
    opts?: {
      onAcpEvent?: (ev: BridgeAcpEvent) => Promise<void> | void;
    },
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    const legacyCursorTimeoutMs = parseLegacyCursorTimeoutMs(this.config.acp.extraArgs);
    const authTimeoutHintBody = buildAuthTimeoutHintBody(legacyCursorTimeoutMs);
    const throttleMs = this.config.bridge.cardUpdateThrottleMs;
    const cardSplitMarkdownThreshold =
      this.config.bridge.cardSplitMarkdownThreshold;
    const cardSplitToolThreshold = this.config.bridge.cardSplitToolThreshold;
    const replyOpts = msg.replyInThread ? { replyInThread: true } : undefined;
    const showCommands = this.config.bridge.showAcpAvailableCommands;

    const loadingCardId = await this.feishu.sendCard(
      msg.chatId,
      "🤔 处理中...",
      msg.messageId,
      replyOpts,
    );

    const state = new FeishuCardState(showCommands);
    const syncStatusSummary = (): void => {
      state.setStatusSummary(
        `\`${session.backend}\` | ${formatSessionModelLabel(
          this.acp.getSessionModelState(session.sessionId),
        ) ?? "—"} | ${formatSessionUsage(
          this.acp.getSessionUsageState(session.sessionId),
        ) ?? "—"}`,
      );
    };
    syncStatusSummary();
    const cardMessageIds: string[] = [loadingCardId];
    let lastRenderedChunks: string[] = [];
    let sawRenderableEvent = false;

    let lastFlush = 0;
    let cardPatchChain: Promise<void> = Promise.resolve();
    let toolRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    const awaitPatchChain = async (): Promise<void> => {
      await cardPatchChain;
    };

    const clearToolRefreshTimer = (): void => {
      if (toolRefreshTimer) {
        clearTimeout(toolRefreshTimer);
        toolRefreshTimer = undefined;
      }
    };

    const syncRenderedCards = (force: boolean, label: string): void => {
      const now = Date.now();
      if (!force && now - lastFlush < throttleMs) return;
      if (!state.hasContent()) return;

      const previousChunks = lastRenderedChunks;
      const chunks = state.toCardMarkdownChunks(
        {
          maxMarkdownLength: cardSplitMarkdownThreshold,
          maxTools: cardSplitToolThreshold,
        },
        now,
      );
      if (
        chunks.length === previousChunks.length &&
        chunks.every((chunk, index) => chunk === previousChunks[index])
      ) {
        return;
      }
      lastFlush = now;
      lastRenderedChunks = [...chunks];

      cardPatchChain = cardPatchChain.then(async () => {
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
          const messageId = cardMessageIds[i];
          if (messageId) {
            if (previousChunks[i] === chunk) continue;
            try {
              await this.feishu.updateCard(messageId, chunk);
            } catch (err) {
              console.warn(
                `${label} sessionId=${session.sessionId}`,
                err instanceof Error ? err.message : err,
              );
            }
            continue;
          }

          try {
            const newId = await this.feishu.sendCard(
              msg.chatId,
              chunk,
              msg.messageId,
              replyOpts,
            );
            cardMessageIds.push(newId);
          } catch (err) {
            console.warn(
              `${label} sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        for (let i = chunks.length; i < cardMessageIds.length; i += 1) {
          const messageId = cardMessageIds[i];
          if (!messageId) continue;
          try {
            await this.feishu.updateCard(
              messageId,
              "_（后续内容已合并到前一张卡片）_",
            );
          } catch (err) {
            console.warn(
              `${label} sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      });
    };

    const scheduleToolRefresh = (): void => {
      clearToolRefreshTimer();
      const delayMs = state.nextToolRefreshDelayMs();
      if (delayMs == null) return;
      toolRefreshTimer = setTimeout(() => {
        toolRefreshTimer = undefined;
        syncStatusSummary();
        syncRenderedCards(false, "[conversation] tool elapsed syncRenderedCards failed");
        scheduleToolRefresh();
      }, delayMs);
    };

    const processAcpEvent = async (ev: BridgeAcpEvent): Promise<void> => {
      await opts?.onAcpEvent?.(ev);

      syncStatusSummary();

      if (!isRenderableEvent(ev, showCommands)) return;

      sawRenderableEvent = true;
      state.apply(ev);
      scheduleToolRefresh();
      syncRenderedCards(false, "[conversation] syncRenderedCards failed");
    };

    let acpQueue: Promise<void> = Promise.resolve();

    const onAcp = (ev: BridgeAcpEvent): void => {
      if (ev.sessionId !== session.sessionId) return;
      acpQueue = acpQueue
        .then(() => processAcpEvent(ev))
        .catch((err) => {
          console.error(
            `[conversation] processAcpEvent failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        });
    };

    this.acp.bridgeClient.on("acp", onAcp);
    this.acp.bridgeClient.setFeishuPromptContext(session.sessionId, {
      chatId: msg.chatId,
      messageId: msg.messageId,
      ...(replyOpts ? { replyInThread: true } : {}),
    });

    try {
      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] prompt sessionId=${session.sessionId} len=${msg.content.length}`,
        );
      }

      const result = await this.acp.prompt(session.sessionId, msg.content);

      await acpQueue;
      syncStatusSummary();

      if (this.config.bridgeDebug) {
        console.log(
          `[conversation] done sessionId=${session.sessionId} stopReason=${result.stopReason}`,
        );
      }

      syncRenderedCards(true, "[conversation] syncRenderedCards failed");
      await awaitPatchChain();

      const filePathsRaw = state.extractAndStripFeishuSendFileDirectives();
      if (filePathsRaw.length > 0) {
        syncRenderedCards(true, "[conversation] sync after strip FEISHU_SEND_FILE");
        await awaitPatchChain();
        const root = session.workspaceRoot;
        for (const raw of filePathsRaw) {
          try {
            const candidate = path.isAbsolute(raw)
              ? raw
              : path.resolve(root, raw);
            const abs = assertPathInWorkspace(root, candidate);
            await this.feishu.uploadAndSendLocalFile(
              abs,
              msg.chatId,
              msg.messageId,
              replyOpts,
            );
          } catch (err) {
            const errorText = formatJsonRpcLikeError(err);
            console.warn(
              `[conversation] FEISHU_SEND_FILE failed path=${raw} sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
            try {
              await this.feishu.sendText(
                msg.chatId,
                `⚠️ 未能发送文件 \`${raw}\`:\n${errorText}`,
                msg.messageId,
                replyOpts,
              );
            } catch {
              /* ignore */
            }
          }
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (
        session.backend === "cursor-legacy" &&
        isLikelyTimeoutMisclassifiedAsAuth(
          state.getMainText(),
          elapsedMs,
          legacyCursorTimeoutMs,
        )
      ) {
        state.setMainText(authTimeoutHintBody);
        if (state.hasMainText()) {
          syncRenderedCards(true, "[conversation] auth-remap syncRenderedCards failed");
          await awaitPatchChain();
        } else {
          try {
            await this.feishu.updateCard(loadingCardId, authTimeoutHintBody);
          } catch (err) {
            console.warn(
              `[conversation] auth-remap updateCard (loading) failed sessionId=${session.sessionId}`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        if (this.config.bridgeDebug) {
          console.warn(
            `[conversation] remap auth-like reply to timeout hint sessionId=${session.sessionId} elapsedMs=${elapsedMs}`,
          );
        }
      }

      if (!sawRenderableEvent) {
        try {
          await this.feishu.updateCard(loadingCardId, "（无响应内容）");
        } catch (err) {
          console.warn(
            `[conversation] updateCard empty-state failed sessionId=${session.sessionId}`,
            err instanceof Error ? err.message : err,
          );
        }
        return undefined;
      }

      return state.toMarkdown();
    } finally {
      clearToolRefreshTimer();
      this.acp.bridgeClient.setFeishuPromptContext(session.sessionId, undefined);
      this.acp.bridgeClient.off("acp", onAcp);
    }
  }
}
