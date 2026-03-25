import type { Config } from "./config.js";
import { AcpRuntime } from "./acp/runtime.js";
import { FeishuBridgeClient } from "./acp/feishu-bridge-client.js";
import { formatJsonRpcLikeError } from "./format-json-rpc-error.js";
import { FeishuBot, type FeishuMessage } from "./feishu-bot.js";
import { parseNewConversationCommand } from "./parse-new-conversation.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { ConversationService } from "./conversation-service.js";
import { resolveAllowedWorkspaceDir } from "./workspace-policy.js";
import { WorkspacePresetsStore } from "./workspace-presets-store.js";

export class Bridge {
  private config: Config;
  private bridgeClient: FeishuBridgeClient;
  private acpRuntime: AcpRuntime;
  private feishuBot: FeishuBot;
  private sessionStore: SessionStore;
  private sessionManager: SessionManager;
  private presetsStore: WorkspacePresetsStore;
  private conversation: ConversationService;
  private activePrompts = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config) {
    this.config = config;
    this.bridgeClient = new FeishuBridgeClient(config);
    this.acpRuntime = new AcpRuntime(config, this.bridgeClient);
    this.sessionStore = new SessionStore(config.bridge.sessionStorePath);
    this.presetsStore = new WorkspacePresetsStore(
      config.bridge.workspacePresetsPath,
    );
    this.sessionManager = new SessionManager(
      this.acpRuntime,
      this.sessionStore,
      config.bridge.sessionIdleTimeoutMs,
      {
        debug: config.bridgeDebug,
        defaultWorkspaceRoot: config.acp.workspaceRoot,
        onSessionWorkspace: (sessionId, root) => {
          this.bridgeClient.setSessionWorkspace(sessionId, root);
        },
        onSessionWorkspaceRemove: (sessionId) => {
          this.bridgeClient.removeSessionWorkspace(sessionId);
        },
      },
    );
    this.feishuBot = new FeishuBot({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain,
    });
    this.conversation = new ConversationService(
      config,
      this.acpRuntime,
      this.feishuBot,
    );
  }

  async start(): Promise<void> {
    if (this.config.bridgeDebug) {
      console.log(
        "[bridge] BRIDGE_DEBUG=true — 控制台输出 ACP/会话信息；/status 含 session 与路径",
      );
    }

    await this.sessionManager.init();
    await this.presetsStore.load(this.config.bridge.workspacePresetsSeed);

    await this.acpRuntime.start();
    await this.acpRuntime.initializeAndAuth();
    console.log(
      `[bridge] cursor-agent-acp 已连接 protocolVersion=${this.acpRuntime.initializeResult?.protocolVersion} loadSession=${this.acpRuntime.supportsLoadSession}`,
    );

    if (this.config.bridgeDebug) {
      this.bridgeClient.on("acp", (ev) => {
        console.log(`[bridge:debug] acp ${ev.type}`, ev);
      });
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
      const cleaned = this.sessionManager.cleanupExpired();
      if (cleaned > 0) {
        console.log(`[bridge] Cleaned up ${cleaned} expired sessions`);
      }
    }, 5 * 60 * 1000);

    console.log("[bridge] Service started successfully");
  }

  private async handleFeishuMessage(msg: FeishuMessage): Promise<void> {
    if (msg.contentType !== "text" && msg.contentType !== "post") {
      return;
    }

    let content = msg.content.trim();

    if (msg.chatType === "group") {
      if (!this.feishuBot.isBotMentioned(msg)) {
        return;
      }
      content = this.feishuBot.stripBotMention(content).trim();
    }

    if (!content) return;

    const newConv = parseNewConversationCommand(content);
    if (newConv) {
      try {
        if (newConv.kind === "new") {
          if (newConv.variant === "list") {
            const presets = this.presetsStore.getPresets();
            const lines =
              presets.length > 0
                ? presets.map((p, i) => `${i + 1}. \`${p}\``).join("\n")
                : "（尚为空）";
            await this.feishuBot.sendText(
              msg.chatId,
              `📋 工作区快捷列表（使用 \`/new <序号>\` 切换）。\n\n${lines}\n\n添加：\`/new add-list <路径>\`\n删除：\`/new remove-list <序号>\``,
              msg.messageId,
            );
            return;
          }
          if (newConv.variant === "remove-list") {
            if (newConv.index < 1) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new remove-list <序号>`（序号见 `/new list`）",
                msg.messageId,
              );
              return;
            }
            const removed = await this.presetsStore.removePresetAt(
              newConv.index,
            );
            const list = this.presetsStore.getPresets();
            const lines = list.map((p, i) => `${i + 1}. \`${p}\``).join("\n");
            await this.feishuBot.sendText(
              msg.chatId,
              removed
                ? `✅ 已删除序号 ${newConv.index}。\n\n${list.length ? lines : "（列表已空）"}`
                : `❌ 无序号 ${newConv.index}。请先 \`/new list\` 查看当前列表。`,
              msg.messageId,
            );
            return;
          }
          if (newConv.variant === "add-list") {
            if (!newConv.path.trim()) {
              await this.feishuBot.sendText(
                msg.chatId,
                "用法：`/new add-list <目录路径>`",
                msg.messageId,
              );
              return;
            }
            const abs = await resolveAllowedWorkspaceDir(
              newConv.path,
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
            );
            return;
          }
        }

        let workspaceAbs: string | undefined;
        if (newConv.kind === "reset") {
          if (newConv.path) {
            workspaceAbs = await resolveAllowedWorkspaceDir(
              newConv.path,
              this.config,
            );
          }
        } else {
          switch (newConv.variant) {
            case "default":
              break;
            case "workspace":
              workspaceAbs = await resolveAllowedWorkspaceDir(
                newConv.path,
                this.config,
              );
              break;
            case "preset": {
              const idx = newConv.index;
              if (idx < 1) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  "❌ 序号须为 ≥1 的整数。",
                  msg.messageId,
                );
                return;
              }
              const p = this.presetsStore.getByIndex(idx);
              if (!p) {
                await this.feishuBot.sendText(
                  msg.chatId,
                  `❌ 列表中无序号 ${idx}。请先发送 \`/new list\` 查看。`,
                  msg.messageId,
                );
                return;
              }
              workspaceAbs = await resolveAllowedWorkspaceDir(p, this.config);
              break;
            }
            default:
              return;
          }
        }

        await this.sessionManager.resetSession(
          msg.chatId,
          msg.senderId,
          msg.chatType,
          workspaceAbs,
        );
        const cwdLine = workspaceAbs
          ? workspaceAbs
          : this.config.acp.workspaceRoot;
        await this.feishuBot.sendText(
          msg.chatId,
          `✅ 会话已重置，当前工作区：\n\`${cwdLine}\``,
          msg.messageId,
        );
      } catch (e) {
        await this.feishuBot.sendText(
          msg.chatId,
          `❌ ${e instanceof Error ? e.message : String(e)}`,
          msg.messageId,
        );
      }
      return;
    }

    if (content === "/status" || content === "/状态") {
      const stats = this.sessionManager.getStats();
      let body = `📊 活跃/内存会话: ${stats.active}/${stats.total}`;
      if (this.config.bridgeDebug) {
        const snap = this.sessionManager.getSessionSnapshot(
          msg.chatId,
          msg.senderId,
          msg.chatType,
        );
        const idleMin = snap
          ? Math.round(snap.idleExpiresInMs / 60_000)
          : null;
        body += `\n\n[调试 BRIDGE_DEBUG]\n• sessionKey: ${snap?.sessionKey ?? "(尚无)"}\n• ACP sessionId: ${snap?.session.sessionId ?? "—"}\n• 会话 cwd: ${snap?.session.workspaceRoot ?? "—"}\n• 空闲过期约: ${idleMin !== null ? `${idleMin} 分钟` : "—"}\n• 默认工作区 (CURSOR_WORK_DIR): ${this.config.acp.workspaceRoot}\n• 允许根 (CURSOR_WORK_ALLOWLIST): ${this.config.acp.allowedWorkspaceRoots.join(", ")}\n• 适配器会话目录: ${this.config.acp.adapterSessionDir}\n• 映射文件: ${this.config.bridge.sessionStorePath}\n• loadSession: ${this.acpRuntime.supportsLoadSession}\n• LOG_LEVEL: ${this.config.logLevel}`;
      }
      await this.feishuBot.sendText(msg.chatId, body, msg.messageId);
      return;
    }

    // cursor-agent-acp 在 prompt 里识别 /model 后仍会把整句发给 CLI，导致大模型「解释命令」。
    // 这里直接走 session/set_model，不触发 prompt。
    const modelMatch = content.match(/^\/model(?:\s+(\S+))?$/);
    if (modelMatch) {
      const modelId = modelMatch[1]?.trim();
      if (!modelId) {
        await this.feishuBot.sendText(
          msg.chatId,
          "用法：`/model <模型ID>`\n\n可在本机终端执行 `cursor-agent models` 查看可用 ID。",
          msg.messageId,
        );
        return;
      }
      try {
        const session = await this.sessionManager.getOrCreateSession(
          msg.chatId,
          msg.senderId,
          msg.chatType,
        );
        await this.acpRuntime.setSessionModel(session.sessionId, modelId);
        await this.feishuBot.sendText(
          msg.chatId,
          `✅ 已切换模型为 \`${modelId}\`（后续对话将使用该模型）。`,
          msg.messageId,
        );
      } catch (err) {
        await this.feishuBot.sendText(
          msg.chatId,
          `❌ 切换模型失败:\n${formatJsonRpcLikeError(err)}`,
          msg.messageId,
        );
      }
      return;
    }

    const sessionKey =
      msg.chatType === "p2p"
        ? `dm:${msg.senderId}`
        : `${msg.chatId}:${msg.senderId}`;

    if (this.activePrompts.has(sessionKey)) {
      await this.feishuBot.sendText(
        msg.chatId,
        "⏳ 上一个请求还在处理中，请稍候...",
        msg.messageId,
      );
      return;
    }

    try {
      this.activePrompts.add(sessionKey);

      const session = await this.sessionManager.getOrCreateSession(
        msg.chatId,
        msg.senderId,
        msg.chatType,
      );

      const msgForPrompt: FeishuMessage = {
        ...msg,
        content,
      };

      await this.conversation.handleUserPrompt(msgForPrompt, session);
    } catch (err) {
      console.error(
        `[bridge] Error processing message from ${msg.senderId}:`,
        err,
      );
      await this.feishuBot
        .sendText(
          msg.chatId,
          `❌ 处理出错: ${err instanceof Error ? err.message : String(err)}`,
          msg.messageId,
        )
        .catch(() => {});
    } finally {
      this.activePrompts.delete(sessionKey);
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    await this.feishuBot.stop();
    await this.acpRuntime.stop();
    console.log("[bridge] Service stopped");
  }
}
